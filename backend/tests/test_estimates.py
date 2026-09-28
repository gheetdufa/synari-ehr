"""Good Faith Estimates: drafts, issuing, replacements, PDFs, access, the portal, scheduling
hooks, the work queue and reminders."""

import hashlib
import io
import zipfile
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from synari.db import engine, utcnow
from synari.models import (
    AuditEvent,
    Client,
    GoodFaithEstimate,
    GoodFaithEstimateItem,
    Practice,
    PracticeSettings,
)
from synari.models.enums import (
    AppointmentStatus,
    BillingProviderType,
    BillingType,
    BookingSource,
    ClinicianAccess,
    Role,
    StaffRole,
)
from synari.services.business_days import add_business_days
from synari.services.estimate_jobs import send_estimate_reminders
from synari.services.estimates import (
    estimate_covers,
    request_due_date,
    scheduling_due_date,
    update_due_date,
)
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)
from tests.estimate_helpers import (
    add_service,
    at,
    book,
    create_draft,
    draft_body,
    drafts_of,
    estimates_of,
    issue,
    issued,
    item,
    notifications,
    pdf_text,
    practice_fixture,  # noqa: F401
    ready_practice,
    self_pay_client,
    today,
)

# Drafts and issuing ------------------------------------------------------------------------


def test_issuing_freezes_the_estimate_and_shares_it_in_the_portal(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    draft = create_draft(api, practice, client.id)
    assert (draft["status"], draft["reason"], draft["total_cents"]) == ("draft", "manual", 150000)
    assert draft["items"][0]["total_cents"] == 150000
    assert draft["missing_provider_fields"] == []
    assert draft["provider"]["npi"] == "1234567893"

    body = draft_body(practice.id, items=[item(quantity=12)])
    edited = api.put(f"/api/estimates/{draft['id']}", json=body, headers=practice.headers)
    assert edited.status_code == 200, edited.text
    assert edited.json()["total_cents"] == 180000

    estimate = issue(api, practice, draft["id"])
    assert estimate["status"] == "issued"
    assert estimate["issued_by_name"] == "Jordan Lee, LCSW"
    provider = estimate["provider"]
    assert (provider["npi"], provider["npi_kind"], provider["tin"]) == (
        "1234567893",
        "individual",
        "12-3456789",
    )
    assert provider["address_lines"] == ["12 Oak Street", "Springfield, IL 62701"]
    assert provider["states"] == ["IL"]

    # The PDF is kept with the record, hashed, and shared in the client's portal documents.
    [shared] = [
        f
        for f in api.get("/api/portal/files", headers=portal_headers(client)).json()
        if f["purpose"] == "good_faith_estimate"
    ]
    download = api.get(f"/api/portal/files/{shared['id']}", headers=portal_headers(client))
    assert download.status_code == 200
    assert hashlib.sha256(download.content).hexdigest() == estimate["pdf_sha256"]
    staff_pdf = api.get(f"/api/estimates/{draft['id']}/pdf", headers=practice.headers)
    assert staff_pdf.content == download.content

    # Issued estimates are part of the record: never edited or deleted.
    assert (
        api.put(f"/api/estimates/{draft['id']}", json=body, headers=practice.headers).status_code
        == 409
    )
    assert api.delete(f"/api/estimates/{draft['id']}", headers=practice.headers).status_code == 409

    # The client hears that a document is ready, and nothing more.
    [note] = notifications(db, client.id, "estimate_issued", Role.CLIENT)
    assert note.title == "A new document is ready"
    [email] = outbound_to(db, "alex@example.com")
    assert email.subject == "New document from Lee Counseling"
    for secret in ("estimate", "F41.1", "90834", "1,800"):
        assert secret not in email.body_text.lower()
    event = db.scalar(select(AuditEvent).where(AuditEvent.action == "estimate.issue"))
    assert event is not None and event.client_id == client.id


def test_paper_delivery_doesnt_email_the_client(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    issued_estimate = issue(api, practice, create_draft(api, practice, client.id)["id"], "paper")
    assert issued_estimate["delivery_method"] == "paper"
    assert outbound_to(db, "alex@example.com") == []


def test_issuing_requires_what_the_estimate_must_show(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    draft = create_draft(api, clinician, client.id)
    assert draft["missing_provider_fields"] == [
        "the clinician's NPI to their profile (Settings → Team, or My profile)",
        "the practice's tax ID in Settings → Practice",
        "the practice's street address in Settings → Practice",
    ]
    response = api.post(f"/api/estimates/{draft['id']}/issue", json={}, headers=clinician.headers)
    assert response.status_code == 422
    message = response.json()["detail"]
    for needed in ("date of birth", "clinician's NPI", "tax ID", "street address"):
        assert needed in message

    ready_practice(db, clinician)
    stored = db.get_one(Client, client.id)
    stored.date_of_birth = date(1990, 4, 2)
    db.commit()
    empty = api.put(
        f"/api/estimates/{draft['id']}",
        json=draft_body(clinician.id, items=[]),
        headers=clinician.headers,
    )
    assert empty.status_code == 200
    response = api.post(f"/api/estimates/{draft['id']}/issue", json={}, headers=clinician.headers)
    assert "add at least one service" in response.json()["detail"]

    too_long = draft_body(clinician.id, period_end=today() + timedelta(days=400))
    response = api.put(f"/api/estimates/{draft['id']}", json=too_long, headers=clinician.headers)
    assert response.status_code == 422
    assert response.json()["detail"] == "An estimate can cover at most 12 months"

    bad_pointer = draft_body(clinician.id, items=[item(diagnosis_pointers=["B"])])
    response = api.put(f"/api/estimates/{draft['id']}", json=bad_pointer, headers=clinician.headers)
    assert response.status_code == 422


def test_group_billing_prints_the_practices_npi(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    stored = db.get_one(Practice, practice.practice_id)
    stored.billing_provider = BillingProviderType.ORGANIZATION
    db.commit()
    client = self_pay_client(db, practice)
    draft = create_draft(api, practice, client.id)
    assert draft["missing_provider_fields"] == ["the practice's group NPI in Settings → Practice"]
    stored.npi = "1987654321"
    db.commit()
    estimate = issue(api, practice, draft["id"])
    assert (estimate["provider"]["npi"], estimate["provider"]["npi_kind"]) == (
        "1987654321",
        "group",
    )


def test_one_draft_at_a_time_per_client_and_clinician(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    draft = create_draft(api, practice, client.id)
    again = api.post(
        f"/api/clients/{client.id}/estimates",
        json=draft_body(practice.id),
        headers=practice.headers,
    )
    assert again.status_code == 409
    assert api.delete(f"/api/estimates/{draft['id']}", headers=practice.headers).status_code == 204
    create_draft(api, practice, client.id)


def test_replacing_an_estimate(api: TestClient, practice: StaffAccount, db: Session) -> None:
    client = self_pay_client(db, practice)
    original = issued(api, practice, client.id)
    response = api.post(
        f"/api/estimates/{original['id']}/supersede", json={}, headers=practice.headers
    )
    assert response.status_code == 201, response.text
    replacement = response.json()
    assert (replacement["status"], replacement["reason"], replacement["supersedes_id"]) == (
        "draft",
        "update",
        original["id"],
    )
    assert replacement["items"][0]["unit_fee_cents"] == 15000
    # Asking again returns the replacement already in progress.
    again = api.post(
        f"/api/estimates/{original['id']}/supersede",
        json={"change_summary": "Fee changed"},
        headers=practice.headers,
    )
    assert again.json()["id"] == replacement["id"]
    assert again.json()["change_summary"] == "Fee changed"

    body = draft_body(practice.id, items=[item(unit_fee_cents=17500)], change_summary="")
    api.put(f"/api/estimates/{replacement['id']}", json=body, headers=practice.headers)
    response = api.post(
        f"/api/estimates/{replacement['id']}/issue", json={}, headers=practice.headers
    )
    assert response.status_code == 422
    assert "describe what changed" in response.json()["detail"]

    body["change_summary"] = "The session fee went up to $175."
    api.put(f"/api/estimates/{replacement['id']}", json=body, headers=practice.headers)
    newer = issue(api, practice, replacement["id"])
    assert newer["status"] == "issued"
    old = api.get(f"/api/estimates/{original['id']}", headers=practice.headers).json()
    assert (old["status"], old["superseded_by_id"]) == ("superseded", newer["id"])
    assert (
        api.post(
            f"/api/estimates/{original['id']}/supersede", json={}, headers=practice.headers
        ).status_code
        == 409
    )

    text = pdf_text(api.get(f"/api/estimates/{newer['id']}/pdf", headers=practice.headers).content)
    assert "What changed" in text
    assert "The session fee went up to $175." in text
    assert "This Good Faith Estimate replaces the one dated" in text

    portal = api.get("/api/portal/estimates", headers=portal_headers(client)).json()
    assert [(e["id"], e["status"]) for e in portal["estimates"]] == [
        (newer["id"], "issued"),
        (original["id"], "superseded"),
    ]


def test_voiding_estimates(api: TestClient, practice: StaffAccount, db: Session) -> None:
    client = self_pay_client(db, practice)
    draft = create_draft(api, practice, client.id)
    voided = api.post(
        f"/api/estimates/{draft['id']}/void",
        json={"reason": "Started by mistake"},
        headers=practice.headers,
    ).json()
    assert (voided["status"], voided["void_reason"]) == ("void", "Started by mistake")
    assert voided["voided_at"] is not None

    original = issued(api, practice, client.id)
    replacement = api.post(
        f"/api/estimates/{original['id']}/supersede",
        json={"change_summary": "New fee"},
        headers=practice.headers,
    ).json()
    newer = issue(api, practice, replacement["id"])
    response = api.post(
        f"/api/estimates/{newer['id']}/void",
        json={"reason": "Issued to the wrong client"},
        headers=practice.headers,
    )
    assert response.status_code == 200
    # Withdrawn from the portal; the estimate it replaced is current again.
    portal = api.get("/api/portal/estimates", headers=portal_headers(client)).json()
    assert [(e["id"], e["status"]) for e in portal["estimates"]] == [(original["id"], "issued")]
    files = api.get("/api/portal/files", headers=portal_headers(client)).json()
    assert len([f for f in files if f["purpose"] == "good_faith_estimate"]) == 1
    assert (
        api.get(
            f"/api/portal/estimates/{newer['id']}/pdf", headers=portal_headers(client)
        ).status_code
        == 404
    )
    for estimate_id in (newer["id"], draft["id"]):
        assert (
            api.post(
                f"/api/estimates/{estimate_id}/void", json={"reason": "x"}, headers=practice.headers
            ).status_code
            == 409
        )
        assert (
            api.delete(f"/api/estimates/{estimate_id}", headers=practice.headers).status_code == 409
        )


# PDFs --------------------------------------------------------------------------------------


def test_pdf_has_what_the_cms_model_requires(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice, address_line1="4 Elm Road", city="Peoria", state="IL")
    first_session = today() + timedelta(days=14)
    estimate = issued(
        api,
        practice,
        client.id,
        scheduled_dates=[first_session.isoformat()],
        separately_scheduled=[
            {"description": "Psychiatric medication evaluation", "provider": "Dr. Kim"}
        ],
        notes="Sessions are weekly.",
    )
    text = pdf_text(
        api.get(f"/api/estimates/{estimate['id']}/pdf", headers=practice.headers).content
    )
    for expected in (
        "Good Faith Estimate for Health Care Items and Services",
        "Alex Rivera",
        "Apr 2, 1990",
        "4 Elm Road",
        "Generalized anxiety disorder (F41.1)",
        "Individual psychotherapy (90834)",
        f"{first_session:%b} {first_session.day}, {first_session.year}",
        "Summary of expected charges",
        "Total estimated cost",
        "$1,500.00",
        "Jordan Lee, LCSW",
        "1234567893",
        "12-3456789",
        "12 Oak Street",
        "90834",
        "10 (Weekly)",
        "Psychiatric medication evaluation",
        "separate Good Faith Estimates",
        "Sessions are weekly.",
        "Disclaimer",
        "at least $400 more",
        "120 calendar days",
        "not a contract",
        "www.cms.gov/nosurprises",
        "1-800-985-3059",
        "Keep a copy of this Good Faith Estimate",
    ):
        assert expected in text, expected


def test_no_cost_estimates_use_the_abbreviated_form(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    estimate = issued(
        api,
        practice,
        client.id,
        items=[
            item(description="Free consultation", service_code="", unit_fee_cents=0, quantity=1)
        ],
    )
    assert estimate["total_cents"] == 0
    text = pdf_text(
        api.get(f"/api/estimates/{estimate['id']}/pdf", headers=practice.headers).content
    )
    assert "Good Faith Estimate for No-Cost Items and Services" in text
    assert "at no cost to you" in text
    assert "not a contract" in text
    assert "Summary of expected charges" not in text


def test_draft_pdfs_are_marked_as_drafts(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    draft = create_draft(api, practice, client.id)
    response = api.get(f"/api/estimates/{draft['id']}/pdf", headers=practice.headers)
    assert response.status_code == 200
    assert "DRAFT - not yet issued" in pdf_text(response.content)


# Access ------------------------------------------------------------------------------------


def test_estimate_access_by_role(api: TestClient, practice: StaffAccount, db: Session) -> None:
    client = self_pay_client(db, practice)
    estimate = create_draft(api, practice, client.id)
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    manager = add_staff(db, practice.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    scheduler = add_staff(db, practice.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    teammate = add_staff(
        db, practice.practice_id, "team@example.com", StaffRole.CLINICIAN, first_name="Riley"
    )
    outsider = add_staff(
        db, practice.practice_id, "out@example.com", StaffRole.CLINICIAN, first_name="Casey"
    )
    assign_clinician(db, client, teammate)
    other_practice = register_practice(api, email="else@example.com")

    list_url = f"/api/clients/{client.id}/estimates"
    one_url = f"/api/estimates/{estimate['id']}"
    for reader in (biller, manager, teammate):
        assert api.get(list_url, headers=reader.headers).status_code == 200
        assert api.get(one_url, headers=reader.headers).status_code == 200
    for stranger in (scheduler, outsider, other_practice):
        assert api.get(list_url, headers=stranger.headers).status_code == 404
        assert api.get(one_url, headers=stranger.headers).status_code == 404
        assert api.get(f"{one_url}/pdf", headers=stranger.headers).status_code == 404

    # Billing staff write any clinician's estimates; the teammate only their own.
    body = draft_body(practice.id)
    assert api.put(one_url, json=body, headers=biller.headers).status_code == 200
    assert api.put(one_url, json=body, headers=manager.headers).status_code == 200
    assert api.put(one_url, json=body, headers=teammate.headers).status_code == 403
    assert api.post(list_url, json=body, headers=teammate.headers).status_code == 403
    own = api.post(list_url, json=draft_body(teammate.id), headers=teammate.headers)
    assert own.status_code == 201
    options = api.get(f"{list_url}/options", headers=teammate.headers).json()
    assert [c["id"] for c in options["clinicians"]] == [teammate.id]
    billing_options = api.get(f"{list_url}/options", headers=biller.headers).json()
    assert {c["id"] for c in billing_options["clinicians"]} == {
        practice.id,
        teammate.id,
        outsider.id,
    }

    assert api.get("/api/estimates/needed", headers=scheduler.headers).status_code == 403
    assert api.get("/api/estimates/needed", headers=biller.headers).status_code == 200
    teammate_queue = api.get("/api/estimates/needed", headers=teammate.headers).json()
    assert [row["clinician_id"] for row in teammate_queue] == [teammate.id]
    assert api.post(f"{one_url}/issue", json={}, headers=biller.headers).status_code == 200


def test_clinicians_with_billing_access_manage_their_clients_estimates(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    billing_clinician = add_staff(
        db,
        practice.practice_id,
        "bc@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
    )
    client = self_pay_client(db, practice)
    assign_clinician(db, client, billing_clinician)
    draft = create_draft(api, practice, client.id)
    body = draft_body(practice.id)
    response = api.put(
        f"/api/estimates/{draft['id']}", json=body, headers=billing_clinician.headers
    )
    assert response.status_code == 200


# Client portal -----------------------------------------------------------------------------


def test_portal_lists_downloads_and_acknowledges_estimates(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    estimate = issued(api, practice, client.id)
    create_draft(api, practice, client.id)  # a draft stays out of the portal
    headers = portal_headers(client)
    listing = api.get("/api/portal/estimates", headers=headers).json()
    assert listing["enabled"] is True
    assert listing["clinicians"] == [{"id": practice.id, "name": "Jordan Lee, LCSW"}]
    [shown] = listing["estimates"]
    assert (shown["id"], shown["total_cents"], shown["clinician_name"]) == (
        estimate["id"],
        150000,
        "Jordan Lee, LCSW",
    )
    pdf = api.get(f"/api/portal/estimates/{estimate['id']}/pdf", headers=headers)
    assert hashlib.sha256(pdf.content).hexdigest() == estimate["pdf_sha256"]

    response = api.post(
        f"/api/portal/estimates/{estimate['id']}/acknowledge",
        json={"name": " Alex Rivera "},
        headers={**headers, "User-Agent": "Portal Browser/1.0"},
    )
    assert response.status_code == 200
    assert response.json()["acknowledged_name"] == "Alex Rivera"
    stored = estimates_of(db, client.id)[0]
    assert stored.acknowledged_at is not None
    assert (stored.acknowledged_ip, stored.acknowledged_user_agent) == (
        "testclient",
        "Portal Browser/1.0",
    )
    # The first acknowledgment stands.
    again = api.post(
        f"/api/portal/estimates/{estimate['id']}/acknowledge",
        json={"name": "Someone Else"},
        headers=headers,
    )
    assert again.json()["acknowledged_name"] == "Alex Rivera"
    event = db.scalar(select(AuditEvent).where(AuditEvent.action == "estimate.acknowledge"))
    assert event is not None and event.client_id == client.id
    staff_view = api.get(f"/api/estimates/{estimate['id']}", headers=practice.headers).json()
    assert staff_view["acknowledged_name"] == "Alex Rivera"

    other = create_client_record(db, practice, first_name="Sam", email="sam@example.com")
    other_headers = portal_headers(other)
    assert api.get("/api/portal/estimates", headers=other_headers).json()["estimates"] == []
    for url in (f"/api/portal/estimates/{estimate['id']}/pdf",):
        assert api.get(url, headers=other_headers).status_code == 404
    response = api.post(
        f"/api/portal/estimates/{estimate['id']}/acknowledge",
        json={"name": "Sam"},
        headers=other_headers,
    )
    assert response.status_code == 404
    assert api.get("/api/portal/estimates", headers=practice.headers).status_code == 401


def test_portal_request_creates_a_task_due_in_3_business_days(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    client = self_pay_client(db, practice)
    headers = portal_headers(client)
    response = api.post("/api/portal/estimates/request", json={}, headers=headers)
    assert response.status_code == 202, response.text
    [draft] = drafts_of(db, client.id)
    assert (draft.reason, draft.clinician_id, draft.due_on) == (
        "request",
        practice.id,
        request_due_date(today()),
    )
    for member in (practice, biller):
        [note] = notifications(db, member.id, "estimate_requested")
        assert note.link == f"/portal/clients/{client.id}?tab=estimates"
        assert note.title.startswith("Alex R. asked for a good faith estimate")
    assert api.get("/api/portal/estimates", headers=headers).json()["request_pending"] is True

    api.post("/api/portal/estimates/request", json={}, headers=headers)
    assert len(drafts_of(db, client.id)) == 1
    event = db.scalar(select(AuditEvent).where(AuditEvent.action == "estimate.request"))
    assert event is not None and event.client_id == client.id

    stranger = add_staff(db, practice.practice_id, "c2@example.com", StaffRole.CLINICIAN)
    response = api.post(
        "/api/portal/estimates/request", json={"clinician_id": stranger.id}, headers=headers
    )
    assert response.status_code == 404

    db.get_one(PracticeSettings, practice.practice_id).gfe_enabled = False
    db.commit()
    assert api.post("/api/portal/estimates/request", json={}, headers=headers).status_code == 404
    assert api.get("/api/portal/estimates", headers=headers).json()["enabled"] is False


def test_portal_request_needs_a_clinician(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    client = create_client_record(db, biller)  # nobody on the care team
    response = api.post("/api/portal/estimates/request", json={}, headers=portal_headers(client))
    assert response.status_code == 409
    assert "Contact Lee Counseling" in response.json()["detail"]


# Scheduling hooks --------------------------------------------------------------------------


def test_scheduling_a_self_pay_session_flags_an_estimate(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    client = self_pay_client(db, practice, diagnosis_codes=[{"code": "F41.1", "description": ""}])
    service = add_service(db, practice)
    first = today() + timedelta(days=30)
    book(api, practice, client, service, first, recurrence={"frequency": "weekly", "count": 4})

    [draft] = drafts_of(db, client.id)
    assert (draft.reason, draft.clinician_id) == ("scheduling", practice.id)
    assert draft.due_on == scheduling_due_date(today(), first) == add_business_days(today(), 3)
    [line] = draft.items
    assert (line.service_code, line.unit_fee_cents, line.quantity, line.frequency) == (
        "90834",
        15000,
        4,
        "Weekly",
    )
    assert line.location == "Telehealth (video)"
    assert line.diagnosis_pointers == ["A"]
    assert draft.diagnosis_codes == [{"code": "F41.1", "description": ""}]
    assert draft.primary_service == "Psychotherapy, 45 minutes (90834)"
    assert draft.scheduled_dates[0] == first.isoformat()
    for member in (practice, biller):
        [note] = notifications(db, member.id, "estimate_needed")
        assert "Alex R." in note.title

    # Another session doesn't add a second draft or notification.
    book(api, practice, client, service, first + timedelta(days=40))
    assert len(drafts_of(db, client.id)) == 1
    assert len(notifications(db, practice.id, "estimate_needed")) == 1


def test_no_estimate_is_flagged_when_none_is_required(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    service = add_service(db, practice)
    soon = self_pay_client(db, practice)
    book(api, practice, soon, service, today() + timedelta(days=1))
    assert drafts_of(db, soon.id) == []

    insured = self_pay_client(
        db, practice, first_name="Ins", email="ins@example.com", billing_type=BillingType.INSURANCE
    )
    book(api, practice, insured, service, today() + timedelta(days=30))
    assert drafts_of(db, insured.id) == []

    db.get_one(PracticeSettings, practice.practice_id).gfe_enabled = False
    db.commit()
    later = self_pay_client(db, practice, first_name="Lat", email="lat@example.com")
    book(api, practice, later, service, today() + timedelta(days=30))
    assert drafts_of(db, later.id) == []


def test_sessions_an_issued_estimate_covers_need_nothing(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    service = add_service(db, practice)
    issued(api, practice, client.id, items=[item(quantity=3)])
    book(api, practice, client, service, today() + timedelta(days=20))
    book(api, practice, client, service, today() + timedelta(days=27))
    assert drafts_of(db, client.id) == []


def _scope_change(
    api: TestClient, practice: StaffAccount, db: Session, change: str
) -> tuple[Client, dict[str, Any], date]:
    """Issue an estimate (3 visits of 90834 at $150 over ~10 weeks), then change the care in
    one way. Returns the client, the estimate and the date of the first uncovered session."""
    client = self_pay_client(db, practice)
    service = add_service(db, practice)
    estimate = issued(
        api, practice, client.id, items=[item(quantity=3)], period_end=today() + timedelta(days=70)
    )
    first = today() + timedelta(days=20)
    if change == "fee":
        booked = book(api, practice, client, service, first)
        response = api.patch(
            f"/api/appointments/{booked[0]['id']}",
            json={"fee_cents": 18000},
            headers=practice.headers,
        )
        assert response.status_code == 200, response.text
        return client, estimate, first
    if change == "service":
        other = add_service(db, practice, code="90837", rate_cents=15000)
        book(api, practice, client, other, first)
        return client, estimate, first
    if change == "visits":
        book(api, practice, client, service, first, recurrence={"frequency": "weekly", "count": 4})
        return client, estimate, first + timedelta(days=21)
    later = today() + timedelta(days=90)
    book(api, practice, client, service, later)
    return client, estimate, later


@pytest.mark.parametrize("change", ["fee", "service", "visits", "after_period"])
def test_scope_changes_need_an_updated_estimate_before_the_next_session(
    api: TestClient, practice: StaffAccount, db: Session, change: str
) -> None:
    client, estimate, uncovered_on = _scope_change(api, practice, db, change)
    [draft] = drafts_of(db, client.id)
    assert (draft.reason, draft.supersedes_id) == ("update", estimate["id"])
    assert draft.due_on == update_due_date(uncovered_on)
    [note] = notifications(db, practice.id, "estimate_needed")
    assert note.title.startswith("An updated good faith estimate for Alex R. is due")
    by_code = {line.service_code: line for line in draft.items}
    if change == "fee":
        assert by_code["90834"].unit_fee_cents == 18000
    elif change == "service":
        assert set(by_code) == {"90834", "90837"}
    elif change == "visits":
        assert by_code["90834"].quantity == 4
    else:
        assert draft.period_start == today()


def test_accepting_a_request_flags_an_estimate(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    requested = create_appointment(
        db,
        practice,
        [client],
        starts_at=at(today() + timedelta(days=30)),
        status=AppointmentStatus.REQUESTED,
        source=BookingSource.PORTAL,
        service_code="90834",
        service_description="Psychotherapy, 45 minutes",
    )
    assert drafts_of(db, client.id) == []
    response = api.post(
        f"/api/appointment-requests/{requested.id}/accept", headers=practice.headers
    )
    assert response.status_code == 200, response.text
    [draft] = drafts_of(db, client.id)
    assert draft.reason == "scheduling"


def test_coverage_counts_visits_in_order() -> None:
    estimate = GoodFaithEstimate(
        status="issued", period_start=date(2026, 10, 1), period_end=date(2027, 9, 30)
    )
    estimate.items = [
        GoodFaithEstimateItem(
            description="Psychotherapy",
            service_code="90834",
            unit_fee_cents=15000,
            quantity=2,
            total_cents=30000,
        )
    ]
    covers = {
        "second visit": dict(
            service_on=date(2026, 11, 1), service_code="90834", fee_cents=15000, visit_number=2
        ),
        "lower fee": dict(
            service_on=date(2026, 11, 1), service_code="90834", fee_cents=12000, visit_number=1
        ),
        "no code on the session": dict(
            service_on=date(2026, 11, 1), service_code="", fee_cents=15000, visit_number=1
        ),
    }
    misses = {
        "third visit": dict(
            service_on=date(2026, 11, 1), service_code="90834", fee_cents=15000, visit_number=3
        ),
        "higher fee": dict(
            service_on=date(2026, 11, 1), service_code="90834", fee_cents=15001, visit_number=1
        ),
        "other code": dict(
            service_on=date(2026, 11, 1), service_code="90837", fee_cents=15000, visit_number=1
        ),
        "before the period": dict(
            service_on=date(2026, 9, 30), service_code="90834", fee_cents=15000, visit_number=1
        ),
        "after the period": dict(
            service_on=date(2027, 10, 1), service_code="90834", fee_cents=15000, visit_number=1
        ),
    }
    for name, case in covers.items():
        assert estimate_covers(estimate, **case), name
    for name, case in misses.items():
        assert not estimate_covers(estimate, **case), name
    estimate.status = "superseded"
    assert not estimate_covers(estimate, **covers["second visit"])


# Work queue --------------------------------------------------------------------------------


def test_needs_queue(api: TestClient, practice: StaffAccount, db: Session) -> None:
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    service = add_service(db, practice)
    flagged = self_pay_client(db, practice)
    book(api, practice, flagged, service, today() + timedelta(days=30))
    # Booked without the hook (e.g. before the practice turned estimates on): still listed.
    missed = self_pay_client(db, practice, first_name="Morgan", email="morgan@example.com")
    create_appointment(
        db,
        practice,
        [missed],
        starts_at=at(today() + timedelta(days=30)),
        service_code="90834",
    )
    late = self_pay_client(db, practice, first_name="Quinn", email="quinn@example.com")
    overdue = create_draft(api, practice, late.id, due_on=(today() - timedelta(days=2)).isoformat())
    insured = self_pay_client(
        db, practice, first_name="Ins", email="ins@example.com", billing_type=BillingType.INSURANCE
    )
    create_appointment(db, practice, [insured], starts_at=at(today() + timedelta(days=30)))

    rows = api.get("/api/estimates/needed", headers=biller.headers).json()
    assert [row["client"]["id"] for row in rows] == [late.id, flagged.id, missed.id]
    first, second, third = rows
    assert (first["estimate_id"], first["overdue"], first["reason"]) == (
        overdue["id"],
        True,
        "manual",
    )
    assert (second["reason"], second["overdue"], second["uncovered_sessions"]) == (
        "scheduling",
        False,
        1,
    )
    assert second["estimate_id"] == drafts_of(db, flagged.id)[0].id
    assert (third["estimate_id"], third["reason"]) == (None, "scheduling")
    assert third["due_on"] == add_business_days(today(), 3).isoformat()
    assert third["next_session_at"] is not None


def _statements_for(api: TestClient, headers: dict[str, str], path: str) -> int:
    """How many SQL statements one request runs."""
    count = 0

    def tick(*_: object) -> None:
        nonlocal count
        count += 1

    event.listen(engine, "before_cursor_execute", tick)
    try:
        assert api.get(path, headers=headers).status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", tick)
    return count


def test_needs_queue_queries_dont_grow_with_clients(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    def add_clients(first: int, last: int) -> None:
        for number in range(first, last):
            client = self_pay_client(
                db, practice, first_name=f"Client{number}", email=f"c{number}@example.com"
            )
            create_appointment(db, practice, [client], starts_at=at(today() + timedelta(days=30)))

    add_clients(0, 2)
    # A client with an issued estimate, so earlier sessions are loaded too.
    covered = self_pay_client(db, practice, first_name="Has", email="has@example.com")
    issued(api, practice, covered.id)
    create_appointment(db, practice, [covered], starts_at=at(today() + timedelta(days=30)))
    few = _statements_for(api, practice.headers, "/api/estimates/needed")
    add_clients(2, 8)
    many = _statements_for(api, practice.headers, "/api/estimates/needed")
    assert many == few


# Reminders ---------------------------------------------------------------------------------


def test_expiry_reminders_and_overdue_alerts(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    ending = self_pay_client(db, practice)
    estimate = issued(api, practice, ending.id, period_end=today() + timedelta(days=20))
    lasting = self_pay_client(db, practice, first_name="Lee", email="lee@example.com")
    issued(api, practice, lasting.id, period_end=today() + timedelta(days=100))
    late = self_pay_client(db, practice, first_name="Quinn", email="quinn@example.com")
    create_draft(api, practice, late.id, due_on=(today() - timedelta(days=1)).isoformat())
    upcoming = self_pay_client(db, practice, first_name="Uma", email="uma@example.com")
    create_draft(api, practice, upcoming.id, due_on=(today() + timedelta(days=3)).isoformat())

    send_estimate_reminders(db, utcnow())
    send_estimate_reminders(db, utcnow())
    [expiring] = notifications(db, practice.id, "estimate_expiring")
    end = date.fromisoformat(estimate["period_end"])
    assert expiring.title == f"The good faith estimate for Alex R. ends {end:%b} {end.day}"
    assert expiring.link == f"/portal/clients/{ending.id}?tab=estimates"
    [overdue] = notifications(db, practice.id, "estimate_overdue")
    assert overdue.urgent
    assert overdue.title.startswith("The good faith estimate for Quinn R. is overdue")

    # Moving the due date re-arms the overdue alert.
    [draft] = drafts_of(db, late.id)
    body = draft_body(practice.id, due_on=(today() - timedelta(days=3)).isoformat())
    api.put(f"/api/estimates/{draft.id}", json=body, headers=practice.headers)
    send_estimate_reminders(db, utcnow())
    assert len(notifications(db, practice.id, "estimate_overdue")) == 2


def test_estimate_notifications_carry_no_clinical_content(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(
        db, practice, diagnosis_codes=[{"code": "F41.1", "description": "GAD"}]
    )
    service = add_service(db, practice)
    book(api, practice, client, service, today() + timedelta(days=30))
    [note] = notifications(db, practice.id, "estimate_needed")
    for clinical in ("F41.1", "GAD", "90834", "Psychotherapy"):
        assert clinical not in note.title


def test_issued_estimates_are_part_of_the_record_export(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    estimate = issued(api, practice, client.id)
    create_draft(api, practice, client.id)  # a new draft isn't given to anyone yet

    exported = api.post(
        f"/api/clients/{client.id}/export", json={"purpose": "client"}, headers=practice.headers
    )

    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as bundle:
        names = [name for name in bundle.namelist() if name.startswith("estimates/")]
        [pdf] = names
        stored = db.get_one(GoodFaithEstimate, estimate["id"])
        assert hashlib.sha256(bundle.read(pdf)).hexdigest() == stored.pdf_sha256
        assert "good faith estimates" in bundle.read("README.txt").decode()
