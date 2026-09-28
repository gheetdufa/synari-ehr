"""Amendment requests: asking to correct the record, accepting (an addendum), denying, the
client's statement of disagreement and the practice's rebuttal, deadlines and access."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import AmendmentRequest, NoteAddendum
from synari.models.enums import AmendmentStatus, NoteStatus, NoteType
from synari.services.record_requests import run_record_request_deadlines
from synari.services.request_deadlines import practice_today
from tests.conftest import StaffAccount, create_client_record, portal_headers
from tests.records_helpers import (
    Practice,
    audit_events,
    client_notifications,
    group_practice,
    signed_note,
    staff_notifications,
)
from tests.test_portal_auth import contact_headers, guardian_of

REQUEST = {"request": "My date of birth in the intake note is wrong."}


@pytest.fixture
def practice(api: TestClient, db: Session) -> Practice:
    return group_practice(api, db)


def _portal_request(api: TestClient, practice: Practice) -> dict:
    response = api.post(
        "/api/portal/amendment-requests", json=REQUEST, headers=portal_headers(practice.client)
    )
    assert response.status_code == 201, response.text
    return response.json()


def _portal_row(api: TestClient, practice: Practice) -> dict:
    return api.get(
        "/api/portal/amendment-requests", headers=portal_headers(practice.client)
    ).json()[0]


def test_portal_request_is_due_in_60_days(api: TestClient, db: Session, practice: Practice) -> None:
    created = _portal_request(api, practice)
    today = practice_today(practice.client.practice, utcnow())
    assert created["due_on"] == (today + timedelta(days=60)).isoformat()
    assert created["status"] == "open"
    assert created["can_disagree"] is False

    listed = api.get("/api/amendment-requests", headers=practice.primary.headers).json()
    assert len(listed) == 1
    row = listed[0]
    assert row["requested_by"] == "client"
    assert row["days_left"] == 60
    assert row["request"] == REQUEST["request"]
    assert row["note_id"] is None
    assert row["addendum_id"] is None
    for handler in (practice.owner, practice.primary):
        assert [n.kind for n in staff_notifications(db, handler, "amendment")] == [
            "amendment_request"
        ]
    assert staff_notifications(db, practice.colleague, "amendment") == []
    create = audit_events(db, "amendment.create")[0]
    assert (create.actor_role, create.client_id) == ("client", practice.client.id)


def test_contact_request(api: TestClient, db: Session, practice: Practice) -> None:
    guardian = guardian_of(db, practice.client)
    response = api.post(
        "/api/portal/amendment-requests", json=REQUEST, headers=contact_headers(guardian)
    )
    assert response.status_code == 201
    assert db.query(AmendmentRequest).one().requested_by == "contact"


def test_accepting_adds_an_addendum_and_tells_the_client(
    api: TestClient, db: Session, practice: Practice
) -> None:
    note = signed_note(db, practice.primary, practice.client, title="Intake")
    created = _portal_request(api, practice)
    url = f"/api/amendment-requests/{created['id']}/accept"
    no_note = api.post(url, json={"content": "Corrected DOB."}, headers=practice.primary.headers)
    assert no_note.status_code == 422

    accepted = api.post(
        url,
        json={"content": "Date of birth corrected to 1990-04-02.", "note_id": note.id},
        headers=practice.primary.headers,
    )
    assert accepted.status_code == 200, accepted.text
    row = accepted.json()
    assert row["status"] == "accepted"
    assert row["note_id"] == note.id
    assert row["note_title"] == "Intake"
    assert row["decided_by"]["id"] == practice.primary.id
    addendum = db.get(NoteAddendum, row["addendum_id"])
    assert addendum.note_id == note.id
    assert addendum.amendment_request_id == created["id"]
    assert addendum.author_id == practice.primary.id
    assert addendum.content == "Date of birth corrected to 1990-04-02."
    assert addendum.integrity == "verified"
    assert [n.title for n in client_notifications(db, practice.client)] == [
        "Your request to amend your record was accepted"
    ]
    assert _portal_row(api, practice)["status"] == "accepted"
    again = api.post(
        url, json={"content": "Again", "note_id": note.id}, headers=practice.primary.headers
    )
    assert again.status_code == 409
    event = audit_events(db, "amendment.accept")[0]
    assert event.client_id == practice.client.id
    assert event.detail == {"note_id": note.id, "addendum_id": addendum.id}


def test_notes_an_amendment_can_apply_to(api: TestClient, db: Session, practice: Practice) -> None:
    created = _portal_request(api, practice)
    url = f"/api/amendment-requests/{created['id']}/accept"
    private = signed_note(db, practice.primary, practice.client, note_type=NoteType.PSYCHOTHERAPY)
    draft = signed_note(db, practice.primary, practice.client, status=NoteStatus.DRAFT)
    other_client = create_client_record(db, practice.primary, email="other@example.org")
    elsewhere = signed_note(db, practice.primary, other_client)
    cases = [(private.id, 422), (draft.id, 409), (elsewhere.id, 404), (999_999, 404)]
    for note_id, expected in cases:
        response = api.post(
            url, json={"content": "Fix", "note_id": note_id}, headers=practice.primary.headers
        )
        assert response.status_code == expected, (note_id, response.text)
    assert db.get(AmendmentRequest, created["id"]).status == AmendmentStatus.OPEN

    staff_created = api.post(
        f"/api/clients/{practice.client.id}/amendment-requests",
        json={**REQUEST, "note_id": private.id},
        headers=practice.primary.headers,
    )
    assert staff_created.status_code == 422


def test_staff_entered_request_about_a_note(
    api: TestClient, db: Session, practice: Practice
) -> None:
    note = signed_note(db, practice.primary, practice.client, title="Session 3")
    created = api.post(
        f"/api/clients/{practice.client.id}/amendment-requests",
        json={**REQUEST, "note_id": note.id},
        headers=practice.owner.headers,
    )
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["requested_by"] == "staff"
    assert row["note_id"] == note.id
    assert row["note_title"] == "Session 3"
    # Accepting uses the request's note when none is given.
    accepted = api.post(
        f"/api/amendment-requests/{row['id']}/accept",
        json={"content": "Clarified."},
        headers=practice.owner.headers,
    )
    assert accepted.status_code == 200, accepted.text
    assert db.query(NoteAddendum).one().note_id == note.id


def test_denial_disagreement_and_rebuttal(api: TestClient, db: Session, practice: Practice) -> None:
    created = _portal_request(api, practice)
    staff_url = f"/api/amendment-requests/{created['id']}"
    portal_url = f"/api/portal/amendment-requests/{created['id']}/disagreement"
    headers = portal_headers(practice.client)
    statement = {"statement": "I still think the record is wrong."}

    early = api.post(portal_url, json=statement, headers=headers)
    assert early.status_code == 409
    rebuttal_first = api.post(
        f"{staff_url}/rebuttal", json={"rebuttal": "No."}, headers=practice.owner.headers
    )
    assert rebuttal_first.status_code == 409

    denied = api.post(
        f"{staff_url}/deny",
        json={"reason": "The record is accurate and complete."},
        headers=practice.owner.headers,
    )
    assert denied.status_code == 200, denied.text
    assert denied.json()["status"] == "denied"
    assert _portal_row(api, practice)["can_disagree"] is True
    assert (
        api.post(
            f"{staff_url}/deny", json={"reason": "x"}, headers=practice.owner.headers
        ).status_code
        == 409
    )

    filed = api.post(portal_url, json=statement, headers=headers)
    assert filed.status_code == 200, filed.text
    assert filed.json()["disagreement"] == statement["statement"]
    assert filed.json()["can_disagree"] is False
    assert api.post(portal_url, json=statement, headers=headers).status_code == 409
    assert [
        n.kind for n in staff_notifications(db, practice.primary, "amendment_disagreement")
    ] == ["amendment_disagreement"]

    rebutted = api.post(
        f"{staff_url}/rebuttal",
        json={"rebuttal": "We reviewed the statement; the record stands."},
        headers=practice.owner.headers,
    )
    assert rebutted.status_code == 200, rebutted.text
    assert rebutted.json()["rebuttal"] == "We reviewed the statement; the record stands."
    assert (
        api.post(
            f"{staff_url}/rebuttal", json={"rebuttal": "More"}, headers=practice.owner.headers
        ).status_code
        == 409
    )
    assert _portal_row(api, practice)["rebuttal"] == "We reviewed the statement; the record stands."
    assert [n.title for n in client_notifications(db, practice.client)] == [
        "Your request to amend your record was reviewed",
        "Your practice responded to your statement",
    ]
    actions = [e.action for e in audit_events(db, "amendment.")]
    assert actions == [
        "amendment.create",
        "amendment.deny",
        "amendment.disagreement",
        "amendment.rebuttal",
    ]


def test_deadline_reminders(api: TestClient, db: Session, practice: Practice) -> None:
    _portal_request(api, practice)
    start = utcnow()
    for days in (40, 50, 51, 58, 61, 62):
        run_record_request_deadlines(db, start + timedelta(days=days))
    kinds = [n.kind for n in staff_notifications(db, practice.primary, "amendment_request_due")]
    assert kinds == [
        "amendment_request_due_10d",
        "amendment_request_due_2d",
        "amendment_request_due_overdue",
    ]


@pytest.mark.parametrize("member", ["outsider", "manager", "biller", "scheduler", "other_owner"])
def test_amendments_need_clinical_access(
    api: TestClient, db: Session, practice: Practice, member: str
) -> None:
    created = _portal_request(api, practice)
    staff: StaffAccount = getattr(practice, member)
    assert api.get("/api/amendment-requests", headers=staff.headers).json() == []
    base = f"/api/amendment-requests/{created['id']}"
    requests = [
        ("GET", base, None),
        ("POST", f"{base}/accept", {"content": "x", "note_id": 1}),
        ("POST", f"{base}/deny", {"reason": "x"}),
        ("POST", f"{base}/rebuttal", {"rebuttal": "x"}),
        ("POST", f"/api/clients/{practice.client.id}/amendment-requests", REQUEST),
    ]
    for method, url, body in requests:
        response = api.request(method, url, json=body, headers=staff.headers)
        assert response.status_code == 404, (member, url)
    assert db.get(AmendmentRequest, created["id"]).status == AmendmentStatus.OPEN


def test_portal_sees_only_its_own_requests(
    api: TestClient, db: Session, practice: Practice
) -> None:
    created = _portal_request(api, practice)
    api.post(
        f"/api/amendment-requests/{created['id']}/deny",
        json={"reason": "No"},
        headers=practice.owner.headers,
    )
    other = create_client_record(db, practice.primary, email="other@example.org")
    headers = portal_headers(other)
    assert api.get("/api/portal/amendment-requests", headers=headers).json() == []
    response = api.post(
        f"/api/portal/amendment-requests/{created['id']}/disagreement",
        json={"statement": "Not mine"},
        headers=headers,
    )
    assert response.status_code == 404
