"""Right of access: record requests from the portal and staff, deadlines and extensions,
releases in the portal or to a third party, reminders and who may do what."""

import io
import zipfile
from datetime import date, datetime, time, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Disclosure, RecordRequest, StoredFile
from synari.models import Practice as PracticeRecord
from synari.models.enums import ClientStatus, FilePurpose, NoteType, RecordRequestStatus
from synari.services.record_requests import run_record_request_deadlines
from synari.services.request_deadlines import practice_today
from synari.services.scheduling import zone_of
from tests.conftest import StaffAccount, create_client_record, outbound_to, portal_headers
from tests.records_helpers import (
    Practice,
    audit_events,
    client_notifications,
    clinician_with_billing,
    group_practice,
    signed_note,
    staff_notifications,
    use_local_storage,
)
from tests.test_portal_auth import contact_headers, guardian_of

PORTAL_REQUEST = {"scope": "Everything from 2025", "delivery": "portal"}


@pytest.fixture
def practice(api: TestClient, db: Session) -> Practice:
    return group_practice(api, db)


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    use_local_storage(tmp_path, monkeypatch)


def _portal_request(api: TestClient, practice: Practice, body: dict | None = None) -> dict:
    response = api.post(
        "/api/portal/record-requests",
        json=body or PORTAL_REQUEST,
        headers=portal_headers(practice.client),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _staff_view(api: TestClient, staff: StaffAccount, request_id: int) -> dict:
    response = api.get(f"/api/record-requests/{request_id}", headers=staff.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _today(db: Session, practice: Practice) -> date:
    return practice_today(practice.client.practice, utcnow())


def test_portal_request_is_due_in_30_days_and_tells_the_handlers(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    today = _today(db, practice)
    assert created["status"] == "open"
    assert created["due_on"] == (today + timedelta(days=30)).isoformat()
    assert created["release_available"] is False

    listed = api.get("/api/record-requests", headers=practice.primary.headers).json()
    assert [r["id"] for r in listed] == [created["id"]]
    row = listed[0]
    assert row["requested_by"] == "client"
    assert row["days_left"] == 30
    assert row["overdue"] is False
    assert row["client"]["id"] == practice.client.id
    assert row["scope"] == "Everything from 2025"

    # The owner and the primary clinician handle it; other care-team members aren't pinged.
    for handler in (practice.owner, practice.primary):
        assert [n.kind for n in staff_notifications(db, handler, "record_request")] == [
            "record_request"
        ]
    assert staff_notifications(db, practice.colleague, "record_request") == []
    emails = outbound_to(db, "primary@example.com")
    assert len(emails) == 1
    assert "Everything from 2025" not in emails[0].body_text

    created_events = audit_events(db, "record_request.create")
    assert [(e.actor_role, e.client_id) for e in created_events] == [("client", practice.client.id)]
    listed_events = audit_events(db, "record_request.list")
    assert listed_events[0].client_id == practice.client.id


def test_contact_requests_are_attributed_to_the_contact(
    api: TestClient, db: Session, practice: Practice
) -> None:
    guardian = guardian_of(db, practice.client)
    response = api.post(
        "/api/portal/record-requests", json=PORTAL_REQUEST, headers=contact_headers(guardian)
    )
    assert response.status_code == 201, response.text
    row = _staff_view(api, practice.owner, response.json()["id"])
    assert row["requested_by"] == "contact"
    assert row["requested_by_contact_id"] == guardian.id


def test_third_party_delivery_needs_a_recipient(api: TestClient, practice: Practice) -> None:
    headers = portal_headers(practice.client)
    missing = api.post(
        "/api/portal/record-requests",
        json={"scope": "All of it", "delivery": "third_party"},
        headers=headers,
    )
    assert missing.status_code == 422
    empty_scope = api.post(
        "/api/portal/record-requests", json={"scope": "  ", "delivery": "portal"}, headers=headers
    )
    assert empty_scope.status_code == 422
    portal_with_recipient = _portal_request(
        api, practice, {"scope": "All", "delivery": "portal", "recipient": "Dr. Smith"}
    )
    assert portal_with_recipient["recipient"] == ""


def test_staff_entered_request_counts_from_the_day_it_arrived(
    api: TestClient, db: Session, practice: Practice
) -> None:
    today = _today(db, practice)
    arrived = today - timedelta(days=35)
    response = api.post(
        f"/api/clients/{practice.client.id}/record-requests",
        json={
            "scope": "Complete record",
            "delivery": "third_party",
            "recipient": "Dr. Smith, 1 Main St",
            "received_at": arrived.isoformat(),
        },
        headers=practice.primary.headers,
    )
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["requested_by"] == "staff"
    assert row["due_on"] == (arrived + timedelta(days=30)).isoformat()
    assert row["days_left"] == -5
    assert row["overdue"] is True

    future = api.post(
        f"/api/clients/{practice.client.id}/record-requests",
        json={**PORTAL_REQUEST, "received_at": (today + timedelta(days=1)).isoformat()},
        headers=practice.primary.headers,
    )
    assert future.status_code == 422


def test_one_extension_with_a_reason(api: TestClient, db: Session, practice: Practice) -> None:
    created = _portal_request(api, practice)
    url = f"/api/record-requests/{created['id']}/extend"
    assert api.post(url, json={"reason": ""}, headers=practice.owner.headers).status_code == 422
    extended = api.post(
        url, json={"reason": "Records are in off-site storage"}, headers=practice.owner.headers
    )
    assert extended.status_code == 200, extended.text
    row = extended.json()
    today = _today(db, practice)
    assert row["due_on"] == (today + timedelta(days=60)).isoformat()
    assert row["extended_on"] == today.isoformat()
    assert row["extension_reason"] == "Records are in off-site storage"
    again = api.post(url, json={"reason": "Still busy"}, headers=practice.owner.headers)
    assert again.status_code == 409

    portal_row = api.get(
        "/api/portal/record-requests", headers=portal_headers(practice.client)
    ).json()[0]
    assert portal_row["extension_reason"] == "Records are in off-site storage"
    assert [n.kind for n in client_notifications(db, practice.client)] == ["record_request_update"]
    email = outbound_to(db, "alex@example.com")[-1]
    assert "off-site" not in email.body_text


def test_portal_release_excludes_psychotherapy_notes_and_expires(
    api: TestClient, db: Session, practice: Practice
) -> None:
    progress = signed_note(db, practice.primary, practice.client, title="Session one")
    private = signed_note(
        db,
        practice.primary,
        practice.client,
        title="Private process notes",
        note_type=NoteType.PSYCHOTHERAPY,
    )
    created = _portal_request(api, practice)
    fulfilled = api.post(
        f"/api/record-requests/{created['id']}/fulfill", json={}, headers=practice.primary.headers
    )
    assert fulfilled.status_code == 200, fulfilled.text
    row = fulfilled.json()
    assert row["status"] == "fulfilled"
    assert row["fulfilled_by"]["id"] == practice.primary.id
    assert row["release_available"] is True

    record = db.get(RecordRequest, created["id"])
    stored = db.get(StoredFile, record.file_id)
    assert stored.purpose == FilePurpose.RECORD_RELEASE
    assert stored.client_id == practice.client.id
    assert stored.content_type == "application/zip"

    headers = portal_headers(practice.client)
    portal_row = api.get("/api/portal/record-requests", headers=headers).json()[0]
    assert portal_row["release_available"] is True
    download = api.get(f"/api/portal/record-requests/{created['id']}/download", headers=headers)
    assert download.status_code == 200
    bundle = zipfile.ZipFile(io.BytesIO(download.content))
    names = bundle.namelist()
    assert any(name.endswith(f"-{progress.id}.pdf") for name in names if name.startswith("notes/"))
    assert not any(name.endswith(f"-{private.id}.pdf") for name in names)
    # The primary clinician has no billing access, so billing records stay out.
    assert "billing/payments.csv" not in names
    assert [n.title for n in client_notifications(db, practice.client)] == [
        "A copy of your record is ready to download"
    ]
    assert audit_events(db, "record_request.release_download")[0].client_id == practice.client.id

    # After 30 days the worker removes the copy; the request keeps its history.
    run_record_request_deadlines(db, utcnow() + timedelta(days=31))
    db.expire_all()
    assert db.get(StoredFile, stored.id) is None
    assert db.get(RecordRequest, created["id"]).file_id is None
    gone = api.get(f"/api/portal/record-requests/{created['id']}/download", headers=headers)
    assert gone.status_code == 404
    assert _staff_view(api, practice.owner, created["id"])["release_available"] is False


def test_release_includes_billing_for_staff_with_billing_access(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    response = api.post(
        f"/api/record-requests/{created['id']}/fulfill",
        json={"include_billing": True},
        headers=practice.owner.headers,
    )
    assert response.status_code == 200, response.text
    download = api.get(
        f"/api/portal/record-requests/{created['id']}/download",
        headers=portal_headers(practice.client),
    )
    assert "billing/payments.csv" in zipfile.ZipFile(io.BytesIO(download.content)).namelist()


def test_portal_release_needs_portal_access(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    practice.client.status = ClientStatus.INACTIVE
    db.commit()
    response = api.post(
        f"/api/record-requests/{created['id']}/fulfill", json={}, headers=practice.owner.headers
    )
    assert response.status_code == 409


def test_third_party_fulfilment_records_a_disclosure(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(
        api,
        practice,
        {"scope": "Notes for my new therapist", "delivery": "third_party", "recipient": "Dr. Kim"},
    )
    package = api.post(
        f"/api/record-requests/{created['id']}/package", json={}, headers=practice.owner.headers
    )
    assert package.status_code == 200
    assert package.headers["content-type"] == "application/zip"
    assert "client.json" in zipfile.ZipFile(io.BytesIO(package.content)).namelist()

    response = api.post(
        f"/api/record-requests/{created['id']}/fulfill",
        json={"note": "Faxed to 555-0100"},
        headers=practice.owner.headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["release_available"] is False
    disclosure = db.query(Disclosure).one()
    assert disclosure.client_id == practice.client.id
    assert disclosure.record_request_id == created["id"]
    assert disclosure.source == "record_request"
    assert disclosure.recipient_name == "Dr. Kim"
    assert "Notes for my new therapist" in disclosure.description
    assert "Faxed to 555-0100" in disclosure.description
    assert disclosure.legal_basis == "client's request (right of access)"
    assert disclosure.recorded_by_id == practice.owner.id
    events = audit_events(db, "record_request.fulfill")
    assert events[0].detail["disclosure_id"] == disclosure.id
    assert events[0].client_id == practice.client.id

    # Disclosures a release created stay as recorded.
    edit = api.patch(
        f"/api/disclosures/{disclosure.id}", json={"purpose": "x"}, headers=practice.owner.headers
    )
    assert edit.status_code == 409
    delete = api.delete(f"/api/disclosures/{disclosure.id}", headers=practice.owner.headers)
    assert delete.status_code == 409


def test_deny_with_a_reason(api: TestClient, db: Session, practice: Practice) -> None:
    created = _portal_request(api, practice)
    url = f"/api/record-requests/{created['id']}"
    denied = api.post(
        f"{url}/deny",
        json={"reason": "We don't hold records from before 2020."},
        headers=practice.owner.headers,
    )
    assert denied.status_code == 200, denied.text
    assert denied.json()["status"] == "denied"
    portal_row = api.get(
        "/api/portal/record-requests", headers=portal_headers(practice.client)
    ).json()[0]
    assert portal_row["denial_reason"] == "We don't hold records from before 2020."
    assert [n.title for n in client_notifications(db, practice.client)] == [
        "Your records request was reviewed"
    ]
    for action in ("fulfill", "deny", "extend"):
        body = {"reason": "Again"} if action != "fulfill" else {}
        response = api.post(f"{url}/{action}", json=body, headers=practice.owner.headers)
        assert response.status_code == 409, action
    package = api.post(f"{url}/package", json={}, headers=practice.owner.headers)
    assert package.status_code == 409


def test_deadline_reminders_at_day_20_and_28_and_when_overdue(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    # Midday on the practice's calendar, N days after the request arrived: whole days of 24
    # hours from just after midnight would land on the day before across a DST change.
    record = db.get_one(PracticeRecord, practice.owner.practice_id)
    received = practice_today(record, utcnow())

    def day(n: int) -> datetime:
        return datetime.combine(received + timedelta(days=n), time(12), tzinfo=zone_of(record))

    def reminders(staff: StaffAccount) -> list[str]:
        return [n.kind for n in staff_notifications(db, staff, "record_request_due")]

    run_record_request_deadlines(db, day(5))
    assert reminders(practice.primary) == []
    run_record_request_deadlines(db, day(20))
    run_record_request_deadlines(db, day(21))
    assert reminders(practice.primary) == ["record_request_due_10d"]
    run_record_request_deadlines(db, day(28))
    run_record_request_deadlines(db, day(29))
    assert reminders(practice.primary) == ["record_request_due_10d", "record_request_due_2d"]
    run_record_request_deadlines(db, day(31))
    run_record_request_deadlines(db, day(32))
    assert reminders(practice.owner) == [
        "record_request_due_10d",
        "record_request_due_2d",
        "record_request_due_overdue",
    ]
    assert reminders(practice.colleague) == []

    # An extension moves the due date, so its reminders come again.
    api.post(
        f"/api/record-requests/{created['id']}/extend",
        json={"reason": "More time"},
        headers=practice.owner.headers,
    )
    run_record_request_deadlines(db, day(50))
    assert reminders(practice.primary)[-1] == "record_request_due_10d"
    assert len(reminders(practice.primary)) == 4

    # Closed requests aren't nudged.
    api.post(
        f"/api/record-requests/{created['id']}/deny",
        json={"reason": "No"},
        headers=practice.owner.headers,
    )
    run_record_request_deadlines(db, day(58))
    assert len(reminders(practice.primary)) == 4


def test_list_filters_and_ordering(api: TestClient, db: Session, practice: Practice) -> None:
    first = _portal_request(api, practice)
    second = api.post(
        f"/api/clients/{practice.client.id}/record-requests",
        json={
            **PORTAL_REQUEST,
            "received_at": (_today(db, practice) - timedelta(days=10)).isoformat(),
        },
        headers=practice.owner.headers,
    ).json()
    third = _portal_request(api, practice)
    api.post(
        f"/api/record-requests/{third['id']}/deny",
        json={"reason": "No"},
        headers=practice.owner.headers,
    )
    listed = api.get("/api/record-requests", headers=practice.owner.headers).json()
    # Open ones first, soonest due first, then closed ones.
    assert [r["id"] for r in listed] == [second["id"], first["id"], third["id"]]
    open_only = api.get(
        "/api/record-requests", params={"status": "open"}, headers=practice.owner.headers
    ).json()
    assert {r["id"] for r in open_only} == {first["id"], second["id"]}
    for_client = api.get(
        "/api/record-requests",
        params={"client_id": practice.client.id + 1000},
        headers=practice.owner.headers,
    ).json()
    assert for_client == []


STAFF_ACTIONS = [
    ("GET", "/api/record-requests/{id}", None),
    ("POST", "/api/record-requests/{id}/extend", {"reason": "Busy"}),
    ("POST", "/api/record-requests/{id}/package", {}),
    ("POST", "/api/record-requests/{id}/fulfill", {}),
    ("POST", "/api/record-requests/{id}/deny", {"reason": "No"}),
]


@pytest.mark.parametrize("member", ["outsider", "manager", "biller", "scheduler", "other_owner"])
def test_staff_without_clinical_access_cant_see_requests(
    api: TestClient, db: Session, practice: Practice, member: str
) -> None:
    created = _portal_request(api, practice)
    staff: StaffAccount = getattr(practice, member)
    assert api.get("/api/record-requests", headers=staff.headers).json() == []
    for method, path, body in STAFF_ACTIONS:
        response = api.request(
            method, path.format(id=created["id"]), json=body, headers=staff.headers
        )
        assert response.status_code == 404, (member, path)
    create = api.post(
        f"/api/clients/{practice.client.id}/record-requests",
        json=PORTAL_REQUEST,
        headers=staff.headers,
    )
    assert create.status_code == 404
    assert db.get(RecordRequest, created["id"]).status == RecordRequestStatus.OPEN


def test_care_team_colleague_can_handle_requests(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    assert _staff_view(api, practice.colleague, created["id"])["id"] == created["id"]
    billing_clinician = clinician_with_billing(db, practice.owner.practice_id, "cb@example.com")
    assert api.get("/api/record-requests", headers=billing_clinician.headers).json() == []


def test_portal_sees_only_its_own_requests(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    api.post(
        f"/api/record-requests/{created['id']}/fulfill", json={}, headers=practice.owner.headers
    )
    other = create_client_record(db, practice.primary, email="other-client@example.com")
    headers = portal_headers(other)
    assert api.get("/api/portal/record-requests", headers=headers).json() == []
    download = api.get(f"/api/portal/record-requests/{created['id']}/download", headers=headers)
    assert download.status_code == 404
    # Staff tokens can't use portal routes.
    staff_try = api.get("/api/portal/record-requests", headers=practice.owner.headers)
    assert staff_try.status_code == 401
