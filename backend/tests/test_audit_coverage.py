"""Audit coverage: access to a client's record names the client (AuditEvent.client_id), list
views record which clients they showed, sign-in plumbing is audited, and psychotherapy notes
stay out of session documentation, claims and the AI assistant's context."""

from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari import audit
from synari.config import settings
from synari.db import utcnow
from synari.models import AuditEvent, Client, ClientForm, Note
from synari.models.enums import (
    AppointmentStatus,
    ClientFormStatus,
    FormKind,
    LocationType,
    NoteStatus,
    NoteType,
)
from synari.services import ai, storage
from synari.services.scheduling import new_video_room_name
from synari.services.sessions import start_portal_session
from synari.services.video_links import create_join_token
from tests.conftest import (
    StaffAccount,
    create_appointment,
    create_client_record,
    portal_headers,
)
from tests.insurance_helpers import (
    add_payer,
    attended_session,
    configure_practice,
    insured_client,
)
from tests.test_ai import FakeProvider
from tests.test_remittances import _claim, _claim_payment, _era, _upload


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()
    yield
    storage.get_storage.cache_clear()


def _events(db: Session, action: str) -> list[AuditEvent]:
    db.expire_all()
    return list(
        db.scalars(select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id))
    )


def _only(db: Session, action: str) -> AuditEvent:
    [event] = _events(db, action)
    return event


def _psychotherapy_note(
    db: Session, author: StaffAccount, client_id: int, appointment_id: int | None = None
) -> Note:
    note = Note(
        practice_id=author.practice_id,
        author_id=author.id,
        client_id=client_id,
        appointment_id=appointment_id,
        note_type=NoteType.PSYCHOTHERAPY,
        format="FREEFORM",
        title="Process notes",
        content="Private process notes",
        status=NoteStatus.SIGNED,
        signed_at=utcnow(),
    )
    db.add(note)
    db.commit()
    return note


# Record access names the client --------------------------------------------------------------


def test_client_record_events_name_the_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    headers = clinician.headers
    created = api.post(
        "/api/clients",
        json={"first_name": "Alex", "last_name": "Rivera", "email": "alex@example.com"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    client_id = created.json()["id"]
    base = f"/api/clients/{client_id}"
    assert api.get(base, headers=headers).status_code == 200
    assert api.patch(base, json={"phone": "555-000-1111"}, headers=headers).status_code == 200
    assert api.get(f"{base}/contacts", headers=headers).status_code == 200
    assert api.get(f"{base}/insurance", headers=headers).status_code == 200
    assert api.get(f"{base}/files", headers=headers).status_code == 200
    assert api.get(f"{base}/forms", headers=headers).status_code == 200

    appointment = create_appointment(db, clinician, [db.get_one(Client, client_id)])
    assert api.get(f"/api/appointments/{appointment.id}", headers=headers).status_code == 200

    form = ClientForm(
        practice_id=clinician.practice_id,
        client_id=client_id,
        kind=FormKind.INTAKE,
        name="Intake",
        fields=[{"id": "q1", "type": "short_text", "label": "Why now?"}],
        status=ClientFormStatus.COMPLETED,
        answers={"q1": "Stress"},
        completed_at=utcnow(),
    )
    db.add(form)
    db.commit()
    assert api.get(f"/api/client-forms/{form.id}", headers=headers).status_code == 200

    invoice = api.post(
        "/api/billing/invoices",
        json={
            "client_id": client_id,
            "items": [
                {
                    "service_date": str(utcnow().date()),
                    "description": "Records",
                    "amount_cents": 500,
                }
            ],
            "notify": False,
        },
        headers=headers,
    )
    assert invoice.status_code == 201, invoice.text
    assert api.get(f"/api/billing/invoices/{invoice.json()['id']}", headers=headers).is_success

    conversation = api.post(f"{base}/conversations", headers=headers).json()
    sent = api.post(
        f"/api/conversations/{conversation['id']}/messages", json={"body": "Hi"}, headers=headers
    )
    assert sent.status_code == 201, sent.text

    for action in (
        "client.create",
        "client.view",
        "client.update",
        "client_contact.list",
        "insurance.list",
        "file.list",
        "client_form.list",
        "appointment.view",
        "client_form.view",
        "invoice.create",
        "invoice.view",
        "conversation.open",
        "message.send",
    ):
        assert _only(db, action).client_id == client_id, action
    # Moved out of the detail now that the event names the client.
    assert _only(db, "message.send").detail == {"attachments": 0}


def test_record_views_are_throttled_per_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    for client in (alex, alex, sam):
        response = api.get(f"/api/clients/{client.id}/contacts", headers=clinician.headers)
        assert response.status_code == 200
    events = _events(db, "client_contact.list")
    assert [e.client_id for e in events] == [alex.id, sam.id]


def test_insurance_claim_and_authorization_events_name_the_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    configure_practice(db, clinician)
    client = insured_client(db, clinician, add_payer(db, clinician.practice_id))
    policy_id = client.insurance_policies[0].id
    [participant] = attended_session(db, clinician, [client])
    created = api.post(
        "/api/claims", json={"participant_ids": [participant.id]}, headers=clinician.headers
    )
    assert created.status_code == 201, created.text
    claim_id = created.json()[0]["id"]
    assert api.get(f"/api/claims/{claim_id}", headers=clinician.headers).status_code == 200
    authorizations = f"/api/insurance/policies/{policy_id}/authorizations"
    added = api.post(
        authorizations,
        json={"number": "PA-1", "start_date": "2026-01-01", "end_date": "2026-12-31"},
        headers=clinician.headers,
    )
    assert added.status_code == 201, added.text
    assert api.get(authorizations, headers=clinician.headers).status_code == 200

    for action in ("claim.create", "claim.view", "authorization.create", "authorization.list"):
        assert _only(db, action).client_id == client.id, action
    listed = api.get("/api/claims", headers=clinician.headers)
    assert listed.status_code == 200
    assert _only(db, "claim.list").detail["client_ids"] == [client.id]


def test_telehealth_join_links_are_audited_per_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    appointment = create_appointment(
        db,
        clinician,
        [alex, sam],
        location_type=LocationType.VIDEO,
        video_room_name=new_video_room_name(),
    )
    url = f"/api/telehealth/appointments/{appointment.id}/join-links"
    assert api.get(url, headers=clinician.headers).status_code == 200
    assert api.get(url, headers=clinician.headers).status_code == 200
    events = _events(db, "telehealth.join_links_view")
    assert sorted(e.client_id for e in events) == sorted([alex.id, sam.id])

    token = create_join_token(appointment, sam.id)
    for _ in range(2):
        assert api.get(f"/api/telehealth/join/{token}").status_code == 200
    guest = _only(db, "telehealth.guest_info")
    assert (guest.actor_role, guest.practice_id, guest.client_id) == (
        "anonymous",
        clinician.practice_id,
        sam.id,
    )
    assert guest.detail == {"appointment_id": appointment.id}


# List views record the clients they show ------------------------------------------------------


def test_list_views_record_a_bounded_list_of_clients(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")

    assert api.get("/api/clients", headers=clinician.headers).status_code == 200
    assert api.get("/api/clients", headers=clinician.headers).status_code == 200
    [listed] = _events(db, "client.list")
    assert listed.client_id is None
    assert listed.resource_type == "client_list"
    assert (listed.detail["client_ids"], listed.detail["client_count"]) == (
        sorted([alex.id, sam.id]),
        2,
    )

    # A different list (one client) is a new event, and names its client.
    searched = api.get("/api/clients", params={"q": "Sam"}, headers=clinician.headers)
    assert [c["id"] for c in searched.json()] == [sam.id]
    events = _events(db, "client.list")
    assert len(events) == 2
    assert (events[1].client_id, events[1].detail["client_ids"]) == (sam.id, [sam.id])

    # Long lists name only the first MAX_LISTED_CLIENTS clients but count them all.
    monkeypatch.setattr(audit, "MAX_LISTED_CLIENTS", 1)
    appointments = [
        create_appointment(db, clinician, [client], starts_at=utcnow() + timedelta(hours=hours))
        for hours, client in ((2, alex), (3, sam))
    ]
    listed_calendar = api.get(
        "/api/appointments",
        params={
            "start": (utcnow() - timedelta(days=1)).isoformat(),
            "end": (utcnow() + timedelta(days=1)).isoformat(),
        },
        headers=clinician.headers,
    )
    assert [a["id"] for a in listed_calendar.json()] == [a.id for a in appointments]
    calendar = _only(db, "appointment.list")
    assert (calendar.detail["client_ids"], calendar.detail["client_count"]) == (
        [min(alex.id, sam.id)],
        2,
    )


def test_empty_lists_and_dashboards_record_nothing(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    assert api.get("/api/clients", headers=clinician.headers).json() == []
    assert api.get("/api/dashboard", headers=clinician.headers).status_code == 200
    assert _events(db, "client.list") == []
    assert _events(db, "dashboard.view") == []

    client = create_client_record(db, clinician)
    create_appointment(db, clinician, [client], starts_at=utcnow() + timedelta(minutes=5))
    assert api.get("/api/dashboard", headers=clinician.headers).status_code == 200
    assert _only(db, "dashboard.view").client_id == client.id


def test_remittance_file_download_is_audited(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    configure_practice(db, clinician)
    claim = _claim(api, db, clinician)
    uploaded = _upload(api, clinician, _era([_claim_payment(claim)]))
    assert uploaded.status_code == 201, uploaded.text
    remittance_id = uploaded.json()["remittances"][0]["id"]
    downloaded = api.get(f"/api/remittances/{remittance_id}/file", headers=clinician.headers)
    assert downloaded.status_code == 200
    event = _only(db, "remittance.download")
    assert (event.resource_id, event.client_id) == (remittance_id, claim["client_id"])
    assert event.detail == {"client_ids": [claim["client_id"]], "client_count": 1}


# Sign-in plumbing ------------------------------------------------------------------------------


def test_refresh_mfa_setup_and_failed_sign_ins_are_audited(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    refreshed = api.post(
        "/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]}
    )
    assert refreshed.status_code == 200, refreshed.text
    assert _only(db, "auth.refresh").actor_id == clinician.id

    assert api.post("/api/auth/mfa/setup", headers=clinician.headers).status_code == 200
    assert _only(db, "auth.mfa_setup_started").actor_id == clinician.id

    wrong = api.post("/api/auth/login", json={"email": clinician.email, "password": "nope-nope"})
    assert wrong.status_code == 401
    unknown = api.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "nope-nope"}
    )
    assert unknown.status_code == 401
    failures = _events(db, "auth.login_failed")
    assert [(e.practice_id, e.detail) for e in failures] == [
        (clinician.practice_id, {"target_staff_id": clinician.id}),
        (None, None),
    ]


def test_portal_link_requests_and_refreshes_are_audited(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    matched = api.post("/api/portal/auth/request-link", json={"email": "alex@example.com"})
    unmatched = api.post("/api/portal/auth/request-link", json={"email": "who@example.com"})
    # The answer never reveals whether the email belongs to anyone.
    assert matched.json() == unmatched.json()
    events = _events(db, "portal.request_link")
    assert [(e.practice_id, e.client_id, e.detail) for e in events] == [
        (clinician.practice_id, client.id, None),
        (None, None, {"matched": False}),
    ]

    tokens = start_portal_session(db, client, None, client.portal_token_version, None)
    db.commit()
    refreshed = api.post("/api/portal/auth/refresh", json={"refresh_token": tokens.refresh_token})
    assert refreshed.status_code == 200, refreshed.text
    event = _only(db, "portal.refresh")
    assert (event.actor_role, event.actor_id, event.client_id) == ("client", client.id, client.id)
    # Portal actions are about the signed-in client unless they say otherwise.
    assert api.get("/api/portal/files", headers=portal_headers(client)).status_code == 200


# Psychotherapy notes aren't part of the record -------------------------------------------------


def test_psychotherapy_notes_dont_document_a_session(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = create_appointment(
        db,
        clinician,
        [client],
        starts_at=utcnow() - timedelta(days=2),
        status=AppointmentStatus.ATTENDED,
    )
    _psychotherapy_note(db, clinician, client.id, appointment.id)

    def missing() -> int:
        dashboard = api.get("/api/dashboard", headers=clinician.headers)
        assert dashboard.status_code == 200, dashboard.text
        return int(dashboard.json()["appointments_missing_notes"])

    assert missing() == 1
    db.add(
        Note(
            practice_id=clinician.practice_id,
            author_id=clinician.id,
            client_id=client.id,
            appointment_id=appointment.id,
            format="FREEFORM",
            content="Progress",
        )
    )
    db.commit()
    assert missing() == 0


def test_psychotherapy_notes_dont_count_as_signed_for_claims(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    configure_practice(db, clinician)
    client = insured_client(db, clinician, add_payer(db, clinician.practice_id))
    [participant] = attended_session(db, clinician, [client])
    _psychotherapy_note(db, clinician, client.id, participant.appointment_id)

    def note_signed() -> bool:
        [row] = api.get("/api/claims/unbilled", headers=clinician.headers).json()
        return bool(row["note_signed"])

    assert note_signed() is False
    db.add(
        Note(
            practice_id=clinician.practice_id,
            author_id=clinician.id,
            client_id=client.id,
            appointment_id=participant.appointment_id,
            format="FREEFORM",
            content="Progress",
            status=NoteStatus.SIGNED,
            signed_at=utcnow(),
        )
    )
    db.commit()
    assert note_signed() is True


def test_psychotherapy_notes_never_reach_the_ai_assistant(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakeProvider()
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(ai, "_client", lambda: provider)
    provider.replies.append("Noted.")
    client = create_client_record(db, clinician)
    private = _psychotherapy_note(db, clinician, client.id)

    response = api.post(
        "/api/ai/assistant",
        json={"messages": [{"role": "user", "content": "Summarize"}], "client_id": client.id},
        headers=clinician.headers,
    )
    assert response.status_code == 200, response.text
    assert "Private process notes" not in provider.system_prompt()
    event = _only(db, "ai.assistant")
    assert (event.client_id, event.detail) == (client.id, {"note_ids": []})
    assert private.id not in event.detail["note_ids"]
