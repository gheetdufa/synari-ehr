"""Regression tests for authorization findings from the group-practice security review."""

import io
import zipfile
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Claim, InsurancePolicy, Note, Payer, Recording, StoredFile
from synari.models.enums import (
    ClinicianAccess,
    FilePurpose,
    NoteStatus,
    RecordingStatus,
    StaffRole,
)
from synari.services.storage import get_storage
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    link_token,
    outbound_to,
    portal_headers,
)

NY = ZoneInfo("America/New_York")
SLUG = "lee-counseling"
EXPORT = {"purpose": "treatment"}


def _signed_note(db: Session, author: StaffAccount, client_id: int) -> int:
    note = Note(
        practice_id=author.practice_id,
        author_id=author.id,
        client_id=client_id,
        content="SECRET CLINICAL CONTENT",
        status=NoteStatus.SIGNED,
        signed_at=utcnow(),
        was_signed=True,
    )
    db.add(note)
    db.commit()
    return note.id


def _open_booking_for(api: TestClient, owner: StaffAccount, clinician_id: int) -> dict:
    api.patch("/api/practice", json={"booking_slug": SLUG}, headers=owner.headers)
    api.patch(
        "/api/practice/settings",
        json={"booking_enabled": True, "booking_min_notice_hours": 0},
        headers=owner.headers,
    )
    blocks = [
        {"weekday": day, "start_time": "08:00", "end_time": "20:00", "location_type": "video"}
        for day in range(7)
    ]
    availability = api.put(
        "/api/availability",
        params={"clinician_id": clinician_id},
        json={"blocks": blocks},
        headers=owner.headers,
    )
    assert availability.status_code == 200, availability.text
    service = api.post(
        "/api/practice/services",
        json={
            "code": "90834",
            "description": "Psychotherapy",
            "duration_minutes": 50,
            "rate_cents": 15000,
            "bookable_online": True,
            "bookable_by_new_clients": True,
        },
        headers=owner.headers,
    )
    assert service.status_code == 201, service.text
    return service.json()


def test_anonymous_booking_request_never_opens_an_existing_chart(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email="sam@example.com")
    note_id = _signed_note(db, clinician, client.id)
    riley = add_staff(db, clinician.practice_id, "riley@example.com", StaffRole.CLINICIAN)
    service = _open_booking_for(api, clinician, riley.id)
    day = datetime.now(NY).date() + timedelta(days=3)
    slot = api.get(
        f"/api/booking/{SLUG}/slots",
        params={
            "clinician_id": riley.id,
            "service_id": service["id"],
            "start_date": str(day),
            "end_date": str(day),
        },
    ).json()[0]
    requested = api.post(
        f"/api/booking/{SLUG}/requests",
        json={
            "clinician_id": riley.id,
            "service_id": service["id"],
            "starts_at": slot["starts_at"],
            "location_type": slot["location_type"],
            "first_name": "Anyone",
            "last_name": "Atall",
            "email": "sam@example.com",
            "date_of_birth": "1990-01-01",
            "phone": "555-000-1111",
            "message": "",
        },
    )
    assert requested.status_code == 202, requested.text
    assert api.get(f"/api/notes/{note_id}", headers=riley.headers).status_code == 404


def test_booking_a_client_does_not_open_their_chart(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email="sam@example.com")
    note_id = _signed_note(db, clinician, client.id)
    lister = add_staff(
        db,
        clinician.practice_id,
        "lister@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.CLIENT_LIST,
    )
    booked = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": (utcnow() + timedelta(days=5)).isoformat(),
            "duration_minutes": 50,
        },
        headers=lister.headers,
    )
    assert booked.status_code == 201, booked.text
    assert api.get(f"/api/notes/{note_id}", headers=lister.headers).status_code == 404

    # A scheduler booking deliberately puts the clinician on the care team.
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    by_scheduler = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "clinician_id": lister.id,
            "starts_at": (utcnow() + timedelta(days=6)).isoformat(),
            "duration_minutes": 50,
        },
        headers=scheduler.headers,
    )
    assert by_scheduler.status_code == 201, by_scheduler.text
    assert api.get(f"/api/notes/{note_id}", headers=lister.headers).status_code == 200


def test_admin_staff_cannot_redirect_portal_access(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email="sam@example.com")
    desk = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    email = api.patch(
        f"/api/clients/{client.id}", json={"email": "desk.alt@example.com"}, headers=desk.headers
    )
    assert email.status_code == 403
    contact = api.post(
        f"/api/clients/{client.id}/contacts",
        json={"first_name": "Desk", "email": "desk.alt@example.com", "portal_access": True},
        headers=desk.headers,
    )
    assert contact.status_code == 403
    # They can still keep other details up to date, and add contacts without portal access.
    phone = api.patch(f"/api/clients/{client.id}", json={"phone": "555-0100"}, headers=desk.headers)
    assert phone.status_code == 200
    plain = api.post(
        f"/api/clients/{client.id}/contacts",
        json={"first_name": "Pat", "email": "pat@example.com", "relation": "Mother"},
        headers=desk.headers,
    )
    assert plain.status_code == 201
    later = api.patch(
        f"/api/clients/{client.id}/contacts/{plain.json()['id']}",
        json={"portal_access": True},
        headers=desk.headers,
    )
    assert later.status_code == 403
    # The client's clinicians can.
    assert (
        api.patch(
            f"/api/clients/{client.id}/contacts/{plain.json()['id']}",
            json={"portal_access": True},
            headers=clinician.headers,
        ).status_code
        == 200
    )
    assert outbound_to(db, "desk.alt@example.com") == []


def test_changing_a_clients_email_ends_their_portal_sessions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email="old@example.com")
    old_session = portal_headers(client)
    assert api.get("/api/portal/auth/me", headers=old_session).status_code == 200
    changed = api.patch(
        f"/api/clients/{client.id}", json={"email": "new@example.com"}, headers=clinician.headers
    )
    assert changed.status_code == 200
    assert api.get("/api/portal/auth/me", headers=old_session).status_code == 401
    api.post("/api/portal/auth/request-link", json={"email": "new@example.com"})
    token = link_token(outbound_to(db, "new@example.com")[-1].body_text)
    assert api.post("/api/portal/auth/verify", json={"token": token}).status_code == 200


def test_private_threads_and_recordings_stay_private(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email="sam@example.com")
    colleague = add_staff(db, clinician.practice_id, "col@example.com", StaffRole.CLINICIAN)
    assign_clinician(db, client, colleague)
    conversation = api.post(
        f"/api/clients/{client.id}/conversations", headers=clinician.headers
    ).json()
    attachment = api.post(
        f"/api/conversations/{conversation['id']}/attachments",
        files={"file": ("private.pdf", b"%PDF-1.4 private", "application/pdf")},
        headers=clinician.headers,
    )
    assert attachment.status_code == 201, attachment.text
    sent = api.post(
        f"/api/conversations/{conversation['id']}/messages",
        json={"body": "PRIVATE THREAD CONTENT", "attachment_ids": [attachment.json()["id"]]},
        headers=clinician.headers,
    )
    assert sent.status_code == 201, sent.text

    export = api.post(f"/api/clients/{client.id}/export", json=EXPORT, headers=colleague.headers)
    assert export.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(export.content))
    assert not any(b"PRIVATE THREAD CONTENT" in archive.read(name) for name in archive.namelist())
    assert not any("private.pdf" in name for name in archive.namelist())
    download = api.get(f"/api/files/{attachment.json()['id']}", headers=colleague.headers)
    assert download.status_code == 404
    # The conversation's clinician still gets both.
    mine = api.post(f"/api/clients/{client.id}/export", json=EXPORT, headers=clinician.headers)
    names = zipfile.ZipFile(io.BytesIO(mine.content)).namelist()
    assert any("private.pdf" in name for name in names)
    assert (
        api.get(f"/api/files/{attachment.json()['id']}", headers=clinician.headers).status_code
        == 200
    )

    appointment = create_appointment(db, clinician, [client])
    key = f"practices/{clinician.practice_id}/recording/security-test.webm"
    get_storage().save(key, b"audio-bytes", "audio/webm")
    stored = StoredFile(
        practice_id=clinician.practice_id,
        client_id=client.id,
        purpose=FilePurpose.RECORDING,
        filename="session.webm",
        content_type="audio/webm",
        size_bytes=11,
        storage_key=key,
        uploaded_by="staff",
        uploaded_by_staff_id=clinician.id,
    )
    db.add(stored)
    db.flush()
    db.add(
        Recording(
            practice_id=clinician.practice_id,
            appointment_id=appointment.id,
            file_id=stored.id,
            status=RecordingStatus.UPLOADED,
        )
    )
    db.commit()
    for account in (colleague, clinician):
        assert api.get(f"/api/files/{stored.id}", headers=account.headers).status_code == 404
    get_storage().delete(key)


def test_policies_with_claims_cannot_be_deleted(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    payer = Payer(practice_id=clinician.practice_id, name="Aetna", external_id="60054")
    db.add(payer)
    db.flush()
    policy = InsurancePolicy(client_id=client.id, payer_id=payer.id, member_id="W1")
    db.add(policy)
    db.flush()
    db.add(
        Claim(
            practice_id=clinician.practice_id,
            client_id=client.id,
            policy_id=policy.id,
            payer_id=payer.id,
            patient_control_number="SYNTEST1",
            rendering_clinician_id=clinician.id,
        )
    )
    db.commit()
    response = api.delete(
        f"/api/clients/{client.id}/insurance/{policy.id}", headers=clinician.headers
    )
    assert response.status_code == 409
