"""Clinical notes: formats, drafting, validation, signing/locking, authorship and access."""

import secrets
from datetime import date, datetime
from pathlib import Path
from typing import Any, get_args
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import (
    Appointment,
    AuditEvent,
    Client,
    Note,
    Notification,
    Recording,
    StaffMember,
    StoredFile,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    ClinicianAccess,
    FilePurpose,
    RecordingStatus,
    Role,
    StaffRole,
    StaffStatus,
)
from synari.schemas.practice import NOTE_FORMATS
from synari.services import storage
from synari.services.note_formats import FORMATS, NoteFormatId, default_title
from synari.services.pdf import BaseDocument
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    register_practice,
)

NY = ZoneInfo("America/New_York")
UNLOCK = {"reason": "Correcting the plan section"}


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


def book_session(
    db: Session,
    clinician: StaffAccount,
    clients: list[Client],
    starts_at: datetime | None = None,
) -> Appointment:
    """A session with `clients` on `clinician`'s calendar (Oct 5, 2026 unless given)."""
    start = starts_at or datetime(2026, 10, 5, 10, tzinfo=NY)
    return create_appointment(db, clinician, clients, starts_at=start)


def create_recording(
    db: Session,
    appointment: Appointment,
    *,
    audio: bytes = b"RIFF fake audio",
    filename: str = "Alex Rivera session.webm",
    note_id: int | None = None,
    status: RecordingStatus = RecordingStatus.UPLOADED,
    transcript: str = "",
) -> Recording:
    """A stored audio file plus the Recording row the telehealth upload would create."""
    key = f"practices/{appointment.practice_id}/recording/{secrets.token_hex(8)}.webm"
    storage.get_storage().save(key, audio, "audio/webm")
    clients = appointment.participants
    stored = StoredFile(
        practice_id=appointment.practice_id,
        client_id=clients[0].client_id if len(clients) == 1 else None,
        purpose=FilePurpose.RECORDING,
        filename=filename,
        content_type="audio/webm",
        size_bytes=len(audio),
        storage_key=key,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=appointment.clinician_id,
    )
    db.add(stored)
    db.flush()
    recording = Recording(
        practice_id=appointment.practice_id,
        appointment_id=appointment.id,
        file_id=stored.id,
        status=status,
        transcript=transcript,
        note_id=note_id,
    )
    db.add(recording)
    db.commit()
    return recording


def stored_path(stored_key: str) -> Path:
    return Path(settings.storage_local_path) / stored_key


def set_preferences(api: TestClient, account: StaffAccount, **values: Any) -> None:
    response = api.patch("/api/me/preferences", json=values, headers=account.headers)
    assert response.status_code == 200, response.text


def _create(api: TestClient, account: StaffAccount, **fields: Any) -> dict[str, Any]:
    response = api.post("/api/notes", json=fields, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _colleague(db: Session, owner: StaffAccount, email: str = "riley@example.com") -> StaffAccount:
    """A basic clinician in the owner's practice."""
    return add_staff(
        db, owner.practice_id, email, StaffRole.CLINICIAN, first_name="Riley", last_name="Chen"
    )


SOAP = {"subjective": "Reports better sleep.", "plan": "Continue weekly CBT."}


def test_formats_are_listed_in_order_with_sections(
    api: TestClient, clinician: StaffAccount
) -> None:
    assert api.get("/api/notes/formats").status_code == 401
    formats = api.get("/api/notes/formats", headers=clinician.headers).json()
    ids = [f["id"] for f in formats]
    assert ids == list(get_args(NoteFormatId)) == list(NOTE_FORMATS) == list(FORMATS)
    soap = formats[0]
    assert [s["id"] for s in soap["sections"]] == ["subjective", "objective", "assessment", "plan"]
    assert all(s["label"] and s["guidance"] for f in formats for s in f["sections"])
    birp = next(f for f in formats if f["id"] == "BIRP")
    assert [s["id"] for s in birp["sections"]] == ["behavior", "intervention", "response", "plan"]
    assert formats[-1]["id"] == "FREEFORM"
    assert formats[-1]["sections"] == []


def test_create_note_for_appointment(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    # 10:30pm in New York is already Oct 6 in UTC; the title uses the author's date.
    appointment = book_session(db, clinician, [client], datetime(2026, 10, 5, 22, 30, tzinfo=NY))
    note = _create(
        api,
        clinician,
        client_id=client.id,
        appointment_id=appointment.id,
        sections={"plan": "Continue weekly CBT.", "subjective": "Reports better sleep."},
    )
    assert note["title"] == "Progress note \N{EN DASH} Oct 5, 2026"
    assert note["format"] == "SOAP"
    assert note["note_type"] == "progress"
    assert note["status"] == "draft"
    assert note["signed_at"] is None
    assert note["ai_generated"] is False
    assert note["risk_flags"] == []
    assert note["appointment_id"] == appointment.id
    assert note["appointment_participant_count"] == 1
    assert (note["supervisor"], note["cosigned_at"], note["supervisor_comment"]) == (None, None, "")
    assert note["client"] == {
        "id": client.id,
        "first_name": "Alex",
        "last_name": "Rivera",
        "preferred_name": "",
    }
    assert note["author"] == {"id": clinician.id, "name": "Jordan Lee"}
    # Every section is present, in format order.
    assert list(note["sections"].items()) == [
        ("subjective", "Reports better sleep."),
        ("objective", ""),
        ("assessment", ""),
        ("plan", "Continue weekly CBT."),
    ]
    assert note["content"] == ""
    stored = db.get(Note, note["id"])
    assert stored is not None
    assert (stored.practice_id, stored.author_id) == (clinician.practice_id, clinician.id)


def test_create_note_uses_the_authors_own_defaults(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    set_preferences(api, colleague, note_format_default="DAP")
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=colleague.headers)
    client = create_client_record(db, colleague)
    before = datetime.now(NY).date()
    note = _create(api, colleague, client_id=client.id, note_type="intake", title="  Intake  ")
    assert note["format"] == "DAP"
    assert list(note["sections"]) == ["data", "assessment", "plan"]
    assert note["title"] == "Intake"
    assert note["author"] == {"id": colleague.id, "name": "Riley Chen, LCSW"}
    untitled = _create(api, colleague, client_id=client.id, note_type="intake")
    assert untitled["title"] in {
        default_title("intake", before),
        default_title("intake", datetime.now(NY).date()),
    }
    assert untitled["appointment_id"] is None
    # The owner's own default is untouched by a colleague's preference.
    owners = _create(api, clinician, client_id=client.id)
    assert (owners["format"], owners["author"]["id"]) == ("SOAP", clinician.id)


def test_freeform_note_and_ai_fields(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    note = _create(
        api,
        clinician,
        client_id=client.id,
        format="FREEFORM",
        content="Collateral call with school counselor.",
        note_type="consultation",
        ai_generated=True,
        risk_level="low",
        risk_flags=["  Passive SI mentioned  "],
    )
    assert note["sections"] == {}
    assert note["content"] == "Collateral call with school counselor."
    assert note["ai_generated"] is True
    assert note["risk_level"] == "low"
    assert note["risk_flags"] == ["Passive SI mentioned"]


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"sections": {"feelings": "x"}}, "SOAP notes have no section named feelings"),
        ({"content": "Narrative"}, "SOAP notes use sections, not content"),
        ({"format": "FREEFORM", "sections": {"plan": "x"}}, "Freeform notes use content"),
        ({"format": "DAP", "sections": {"subjective": "x"}}, "no section named subjective"),
        ({"format": "XYZ"}, None),
        ({"note_type": "session"}, None),
        ({"sections": {"plan": "x" * 20_001}}, None),
        ({"content": "x" * 60_001, "format": "FREEFORM"}, None),
        ({"risk_flags": [""]}, None),
        ({"title": "x" * 201}, None),
    ],
)
def test_create_note_validation(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    fields: dict[str, Any],
    message: str | None,
) -> None:
    client = create_client_record(db, clinician)
    response = api.post(
        "/api/notes", json={"client_id": client.id, **fields}, headers=clinician.headers
    )
    assert response.status_code == 422
    if message is not None:
        assert message in response.json()["detail"]
    assert db.query(Note).count() == 0


def test_the_client_must_be_in_the_appointment(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    other_client = create_client_record(db, clinician, email="sam@example.com")
    appointment = book_session(db, clinician, [other_client])
    response = api.post(
        "/api/notes",
        json={"client_id": client.id, "appointment_id": appointment.id},
        headers=clinician.headers,
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "That client isn't part of this appointment"
    # In a couples session each client has their own note about the same appointment.
    couple = book_session(db, clinician, [client, other_client])
    notes = [
        _create(api, clinician, client_id=c.id, appointment_id=couple.id)
        for c in (client, other_client)
    ]
    assert [n["client"]["id"] for n in notes] == [client.id, other_client.id]
    assert {n["appointment_participant_count"] for n in notes} == {2}
    assert _create(api, clinician, client_id=client.id)["appointment_participant_count"] == 0
    missing = api.post(
        "/api/notes",
        json={"client_id": client.id, "appointment_id": appointment.id + 100},
        headers=clinician.headers,
    )
    assert missing.status_code == 404


def test_a_colleagues_appointment_with_the_client_can_be_linked(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, colleague)
    session = book_session(db, clinician, [client])
    note = _create(api, colleague, client_id=client.id, appointment_id=session.id)
    assert (note["appointment_id"], note["author"]["id"]) == (session.id, colleague.id)


def test_list_notes_filters_and_orders_newest_first(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    assign_clinician(db, sam, colleague)
    appointment = book_session(db, clinician, [alex])
    first = _create(api, clinician, client_id=alex.id, sections=SOAP)
    second = _create(
        api, clinician, client_id=alex.id, appointment_id=appointment.id, sections=SOAP
    )
    third = _create(api, colleague, client_id=sam.id, sections=SOAP)
    api.post(f"/api/notes/{first['id']}/sign", headers=clinician.headers)

    def ids(**params: Any) -> list[int]:
        response = api.get("/api/notes", params=params, headers=clinician.headers)
        assert response.status_code == 200, response.text
        return [n["id"] for n in response.json()]

    assert ids() == [third["id"], second["id"], first["id"]]
    assert ids(client_id=alex.id) == [second["id"], first["id"]]
    assert ids(appointment_id=appointment.id) == [second["id"]]
    assert ids(status="signed") == [first["id"]]
    assert ids(status="draft", client_id=alex.id) == [second["id"]]
    assert ids(author_id=colleague.id) == [third["id"]]
    assert ids(author_id=clinician.id, status="draft") == [second["id"]]
    assert ids(limit=1) == [third["id"]]
    assert ids(limit=1, offset=1) == [second["id"]]
    paged = api.get("/api/notes", params={"limit": 2, "offset": 2}, headers=clinician.headers)
    assert [n["id"] for n in paged.json()] == [first["id"]]
    assert paged.headers["x-total-count"] == "3"
    summary = api.get("/api/notes", headers=clinician.headers).json()[0]
    assert summary["client"]["first_name"] == "Sam"
    assert summary["author"] == {"id": colleague.id, "name": "Riley Chen"}
    assert "sections" not in summary
    assert "content" not in summary
    assert api.get("/api/notes", params={"limit": 0}, headers=clinician.headers).status_code == 422


def test_update_draft_note(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    note = _create(api, clinician, client_id=client.id, sections=SOAP)
    url = f"/api/notes/{note['id']}"

    updated = api.patch(
        url,
        json={
            "title": "Session 4",
            "note_type": "treatment_plan",
            "risk_level": "moderate",
            "sections": {"objective": "Calm, engaged."},
        },
        headers=clinician.headers,
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["title"] == "Session 4"
    assert body["note_type"] == "treatment_plan"
    assert body["risk_level"] == "moderate"
    # `sections` replaces all section text.
    assert body["sections"] == {
        "subjective": "",
        "objective": "Calm, engaged.",
        "assessment": "",
        "plan": "",
    }

    assert api.patch(url, json={"title": "   "}, headers=clinician.headers).status_code == 422
    bad_section = api.patch(url, json={"sections": {"data": "x"}}, headers=clinician.headers)
    assert bad_section.status_code == 422
    # Switching format needs text that fits the new format.
    switch = api.patch(url, json={"format": "FREEFORM"}, headers=clinician.headers)
    assert switch.status_code == 422
    freeform = api.patch(
        url,
        json={"format": "FREEFORM", "sections": {}, "content": "Narrative."},
        headers=clinician.headers,
    )
    assert freeform.status_code == 200
    assert (freeform.json()["format"], freeform.json()["sections"]) == ("FREEFORM", {})
    assert freeform.json()["content"] == "Narrative."
    content_only = api.patch(url, json={"content": "Edited."}, headers=clinician.headers)
    assert content_only.json()["content"] == "Edited."


def test_update_appointment_link(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    other_client = create_client_record(db, clinician, email="sam@example.com")
    mine = book_session(db, clinician, [client])
    theirs = book_session(db, clinician, [other_client])
    note = _create(api, clinician, client_id=client.id)
    url = f"/api/notes/{note['id']}"

    linked = api.patch(url, json={"appointment_id": mine.id}, headers=clinician.headers)
    assert linked.json()["appointment_id"] == mine.id
    wrong = api.patch(url, json={"appointment_id": theirs.id}, headers=clinician.headers)
    assert wrong.status_code == 422
    unlinked = api.patch(url, json={"appointment_id": None}, headers=clinician.headers)
    assert unlinked.json()["appointment_id"] is None


def test_sign_locks_until_unlocked(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    note = _create(api, clinician, client_id=client.id, sections=SOAP)
    url = f"/api/notes/{note['id']}"

    assert api.post(f"{url}/unlock", json=UNLOCK, headers=clinician.headers).status_code == 409
    signed = api.post(f"{url}/sign", headers=clinician.headers)
    assert signed.status_code == 200
    assert signed.json()["status"] == "signed"
    assert signed.json()["signed_at"] is not None

    locked = api.patch(url, json={"title": "Changed"}, headers=clinician.headers)
    assert locked.status_code == 409
    assert locked.json()["detail"] == "Unlock the note to edit it"
    assert api.post(f"{url}/sign", headers=clinician.headers).status_code == 409
    assert api.delete(url, headers=clinician.headers).status_code == 409

    unlocked = api.post(f"{url}/unlock", json=UNLOCK, headers=clinician.headers)
    assert unlocked.json()["status"] == "draft"
    assert unlocked.json()["signed_at"] is None
    assert api.patch(url, json={"title": "Amended"}, headers=clinician.headers).status_code == 200
    # Once signed, a note stays part of the record even after it's unlocked for an amendment.
    assert api.delete(url, headers=clinician.headers).status_code == 409
    assert api.get(url, headers=clinician.headers).status_code == 200


def test_empty_notes_cannot_be_signed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    note = _create(api, clinician, client_id=client.id, sections={"plan": "   "})
    response = api.post(f"/api/notes/{note['id']}/sign", headers=clinician.headers)
    assert response.status_code == 422
    assert response.json()["detail"] == "Add some content before signing the note"


def test_signing_deletes_recording_audio_and_transcript(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = book_session(db, clinician, [client])
    note = _create(
        api, clinician, client_id=client.id, appointment_id=appointment.id, sections=SOAP
    )
    linked = create_recording(
        db,
        appointment,
        note_id=note["id"],
        status=RecordingStatus.TRANSCRIBED,
        transcript="Clinician: How was your week?",
    )
    unrelated = create_recording(db, appointment, audio=b"other audio", transcript="Keep me")
    linked_file = db.get(StoredFile, linked.file_id)
    assert linked_file is not None
    linked_key = linked_file.storage_key
    assert stored_path(linked_key).exists()

    assert api.post(f"/api/notes/{note['id']}/sign", headers=clinician.headers).status_code == 200

    db.expire_all()
    assert not stored_path(linked_key).exists()
    assert db.query(StoredFile).filter_by(storage_key=linked_key).count() == 0
    kept = db.get(Recording, linked.id)
    assert kept is not None
    assert (kept.file_id, kept.transcript, kept.note_id) == (None, "", note["id"])
    other = db.get(Recording, unrelated.id)
    assert other is not None
    assert other.file_id is not None
    assert other.transcript == "Keep me"
    event = db.query(AuditEvent).filter_by(action="note.sign").one()
    assert event.detail == {"recordings_cleared": 1}

    # Unlocking and signing again is harmless once the audio is gone.
    api.post(f"/api/notes/{note['id']}/unlock", json=UNLOCK, headers=clinician.headers)
    assert api.post(f"/api/notes/{note['id']}/sign", headers=clinician.headers).status_code == 200


def test_note_access_is_audited(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    colleague = _colleague(db, clinician)
    client = create_client_record(db, colleague)
    note = _create(api, colleague, client_id=client.id, sections=SOAP)
    url = f"/api/notes/{note['id']}"
    api.get(url, headers=colleague.headers)
    api.patch(url, json={"title": "Edited"}, headers=colleague.headers)
    api.post(f"{url}/sign", headers=colleague.headers)
    api.post(f"{url}/unlock", json=UNLOCK, headers=colleague.headers)
    api.get(url, headers=clinician.headers)  # the owner reading a colleague's note
    draft = _create(api, colleague, client_id=client.id, sections=SOAP)
    api.delete(f"/api/notes/{draft['id']}", headers=colleague.headers)
    events = db.query(AuditEvent).filter_by(resource_type="note").order_by(AuditEvent.id).all()
    assert [(e.action, e.resource_id, e.actor_id) for e in events] == [
        ("note.create", note["id"], colleague.id),
        ("note.view", note["id"], colleague.id),
        ("note.update", note["id"], colleague.id),
        ("note.sign", note["id"], colleague.id),
        ("note.unlock", note["id"], colleague.id),
        ("note.view", note["id"], clinician.id),
        ("note.create", draft["id"], colleague.id),
        ("note.delete", draft["id"], colleague.id),
    ]
    assert all(e.practice_id == clinician.practice_id for e in events)
    assert events[2].detail == {"fields": ["title"]}


def make_viewer(
    api: TestClient,
    db: Session,
    owner: StaffAccount,
    author: StaffAccount,
    client: Client,
    kind: str,
) -> StaffAccount:
    """A staff member related to a clinician (`author`) and their client as `kind` describes."""
    email = f"{kind}@example.com"
    practice_id = owner.practice_id
    if kind == "owner":
        return owner
    if kind == "other_practice":
        return register_practice(api, email=email)
    if kind == "care_team_colleague":
        colleague = add_staff(db, practice_id, email, StaffRole.CLINICIAN)
        assign_clinician(db, client, colleague)
        return colleague
    if kind == "supervisor":
        supervisor = add_staff(db, practice_id, email, StaffRole.CLINICIAN)
        db.get_one(StaffMember, author.id).supervisor_id = supervisor.id
        db.commit()
        return supervisor
    roles: dict[str, tuple[StaffRole, ClinicianAccess, bool | None]] = {
        "non_clinician_owner": (StaffRole.OWNER, ClinicianAccess.BASIC, False),
        "practice_clinician": (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, None),
        "colleague": (StaffRole.CLINICIAN, ClinicianAccess.BASIC, None),
        "client_list_clinician": (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, None),
        "practice_manager": (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, None),
        "biller": (StaffRole.BILLER, ClinicianAccess.BASIC, None),
        "scheduler": (StaffRole.SCHEDULER, ClinicianAccess.BASIC, None),
    }
    role, clinician_access, is_clinician = roles[kind]
    return add_staff(
        db,
        practice_id,
        email,
        role,
        clinician_access=clinician_access,
        is_clinician=is_clinician,
    )


@pytest.mark.parametrize(
    ("kind", "read", "change", "create"),
    [
        # Clinical access to the client: may read the note, never change someone else's.
        ("owner", 200, 403, 201),
        ("non_clinician_owner", 200, 403, 403),
        ("practice_clinician", 200, 403, 201),
        ("supervisor", 200, 403, 201),
        ("care_team_colleague", 200, 403, 201),
        # No clinical access to this client.
        ("colleague", 404, 404, 404),
        ("client_list_clinician", 404, 404, 404),
        ("other_practice", 404, 404, 404),
        # Roles that never get clinical records (and can't write notes at all).
        ("practice_manager", 404, 404, 403),
        ("biller", 404, 404, 403),
        ("scheduler", 404, 404, 403),
    ],
)
def test_who_can_read_and_change_a_colleagues_note(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    kind: str,
    read: int,
    change: int,
    create: int,
) -> None:
    author = _colleague(db, clinician, email="author@example.com")
    client = create_client_record(db, author)
    viewer = make_viewer(api, db, clinician, author, client, kind)
    note = _create(api, author, client_id=client.id, sections=SOAP)
    signed = _create(api, author, client_id=client.id, sections=SOAP)
    api.post(f"/api/notes/{signed['id']}/sign", headers=author.headers)
    url = f"/api/notes/{note['id']}"
    headers = viewer.headers

    assert api.get(url, headers=headers).status_code == read
    assert api.get(f"{url}/pdf", headers=headers).status_code == read
    listed = [n["id"] for n in api.get("/api/notes", headers=headers).json()]
    assert listed == ([signed["id"], note["id"]] if read == 200 else [])
    by_client = api.get("/api/notes", params={"client_id": client.id}, headers=headers).json()
    assert len(by_client) == (2 if read == 200 else 0)

    assert api.patch(url, json={"title": "Changed"}, headers=headers).status_code == change
    assert api.post(f"{url}/sign", headers=headers).status_code == change
    assert api.delete(url, headers=headers).status_code == change
    assert (
        api.post(f"/api/notes/{signed['id']}/unlock", json=UNLOCK, headers=headers).status_code
        == change
    )
    db.expire_all()
    unchanged = db.get_one(Note, note["id"])
    assert (unchanged.title, unchanged.status) == (note["title"], "draft")
    # The author has a supervisor in that case, so their signed note waits for a co-signature.
    signed_status = "pending_cosign" if kind == "supervisor" else "signed"
    assert db.get_one(Note, signed["id"]).status == signed_status

    created = api.post("/api/notes", json={"client_id": client.id}, headers=headers)
    assert created.status_code == create, created.text
    if create == 201:
        assert created.json()["author"]["id"] == viewer.id


def test_notes_are_isolated_between_practices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = book_session(db, clinician, [client])
    note = _create(api, clinician, client_id=client.id, sections=SOAP)
    other = register_practice(api, email="other@example.com")
    other_client = create_client_record(db, other, email="theirs@example.com")

    borrowed = api.post(
        "/api/notes",
        json={"client_id": other_client.id, "appointment_id": appointment.id},
        headers=other.headers,
    )
    assert borrowed.status_code == 404
    own = _create(api, other, client_id=other_client.id)
    linked = api.patch(
        f"/api/notes/{own['id']}", json={"appointment_id": appointment.id}, headers=other.headers
    )
    assert linked.status_code == 404
    assert [n["id"] for n in api.get("/api/notes", headers=clinician.headers).json()] == [
        note["id"]
    ]
    assert api.get(f"/api/notes/{own['id']}", headers=clinician.headers).status_code == 404
    assert api.get("/api/notes").status_code == 401


def test_default_title_labels() -> None:
    on = date(2026, 1, 9)
    assert default_title("treatment_plan", on) == "Treatment plan \N{EN DASH} Jan 9, 2026"
    assert default_title("unknown", on) == "Note \N{EN DASH} Jan 9, 2026"


def test_deleting_a_draft_keeps_its_recording(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = book_session(db, clinician, [client])
    note = _create(api, clinician, client_id=client.id, appointment_id=appointment.id)
    recording = create_recording(db, appointment, note_id=note["id"], transcript="Keep")
    assert api.delete(f"/api/notes/{note['id']}", headers=clinician.headers).status_code == 204
    db.expire_all()
    kept = db.get(Recording, recording.id)
    assert kept is not None
    assert (kept.note_id, kept.transcript) == (None, "Keep")
    assert kept.file_id is not None


@pytest.fixture
def pdf_lines(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Text blocks written into rendered PDFs."""
    lines: list[str] = []
    write_block = BaseDocument.write_block

    def spy(document: BaseDocument, text: str, *args: Any, **kwargs: Any) -> None:
        lines.append(text)
        write_block(document, text, *args, **kwargs)

    monkeypatch.setattr(BaseDocument, "write_block", spy)
    return lines


def test_note_pdf_download(
    api: TestClient, clinician: StaffAccount, db: Session, pdf_lines: list[str]
) -> None:
    author = _colleague(db, clinician)
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=author.headers)
    client = create_client_record(db, author)
    note = _create(api, author, client_id=client.id, sections=SOAP)
    url = f"/api/notes/{note['id']}/pdf"
    draft = api.get(url, headers=author.headers)
    assert draft.status_code == 200
    assert draft.headers["content-type"] == "application/pdf"
    assert draft.content.startswith(b"%PDF")
    assert "attachment" in draft.headers["content-disposition"]
    assert "DRAFT - not signed" in pdf_lines

    api.post(f"/api/notes/{note['id']}/sign", headers=author.headers)
    pdf_lines.clear()
    # The owner downloads it; the PDF still names the author and the practice.
    assert api.get(url, headers=clinician.headers).status_code == 200
    assert pdf_lines[:2] == ["Lee Counseling", "Riley Chen, LCSW"]
    [signature] = [line for line in pdf_lines if line.startswith("Electronically signed")]
    assert signature.startswith("Electronically signed by Riley Chen, LCSW on ")
    assert "Jordan Lee" not in " ".join(pdf_lines)
    assert not any(line.startswith(("Co-signed", "Awaiting")) for line in pdf_lines)

    other = register_practice(api, email="other-pdf@example.com")
    assert api.get(url, headers=other.headers).status_code == 404
    events = db.query(AuditEvent).filter_by(action="note.download", resource_id=note["id"])
    assert [e.actor_id for e in events.order_by(AuditEvent.id)] == [author.id, clinician.id]


# Multi-client sessions -----------------------------------------------------------------------


def _group(db: Session, clinician: StaffAccount, size: int = 3) -> tuple[Appointment, list[Client]]:
    """A session on the clinician's calendar with `size` of their clients."""
    names = ["Alex", "Sam", "Jamie", "Morgan"][:size]
    clients = [
        create_client_record(db, clinician, first_name=name, email=f"{name.lower()}@example.com")
        for name in names
    ]
    return book_session(db, clinician, clients), clients


def _group_notes(
    api: TestClient, account: StaffAccount, appointment: Appointment, **body: Any
) -> httpx.Response:
    return api.post(
        f"/api/appointments/{appointment.id}/group-notes", json=body, headers=account.headers
    )


def _sign_all(api: TestClient, account: StaffAccount, appointment: Appointment) -> httpx.Response:
    return api.post(f"/api/appointments/{appointment.id}/notes/sign", headers=account.headers)


def test_group_notes_start_a_draft_per_participant_and_sign_together(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    session, (alex, sam, _jamie, morgan) = _group(db, clinician, 4)
    assign_clinician(db, alex, colleague)
    # Sam already has my note, and Jamie didn't come.
    sams = _create(api, clinician, client_id=sam.id, appointment_id=session.id, sections=SOAP)
    session.participants[2].attendance = AppointmentStatus.NO_SHOW
    db.commit()

    created = _group_notes(
        api,
        clinician,
        session,
        title="Coping skills group",
        sections={"objective": "Group practiced grounding."},
    )
    assert created.status_code == 201, created.text
    drafts = created.json()
    assert [n["client"]["id"] for n in drafts] == [alex.id, morgan.id]
    for draft in drafts:
        assert (draft["appointment_id"], draft["appointment_participant_count"]) == (session.id, 4)
        assert (draft["title"], draft["status"], draft["format"]) == (
            "Coping skills group",
            "draft",
            "SOAP",
        )
        assert draft["sections"]["objective"] == "Group practiced grounding."
        assert draft["author"]["id"] == clinician.id
    # Everyone who came has a note from me now.
    assert _group_notes(api, clinician, session).json() == []
    colleagues = _create(
        api, colleague, client_id=alex.id, appointment_id=session.id, sections=SOAP
    )

    # Nothing is signed while any of my drafts is empty.
    api.patch(f"/api/notes/{drafts[1]['id']}", json={"sections": {}}, headers=clinician.headers)
    refused = _sign_all(api, clinician, session)
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Add some content to every note before signing"
    db.expire_all()
    assert {n.status for n in db.query(Note)} == {"draft"}

    api.patch(f"/api/notes/{drafts[1]['id']}", json={"sections": SOAP}, headers=clinician.headers)
    signed = _sign_all(api, clinician, session)
    assert signed.status_code == 200, signed.text
    assert [n["id"] for n in signed.json()] == [sams["id"], drafts[0]["id"], drafts[1]["id"]]
    assert {n["status"] for n in signed.json()} == {"signed"}
    assert _sign_all(api, clinician, session).json() == []
    # A colleague's draft on the same session is theirs to sign.
    db.expire_all()
    assert db.get_one(Note, colleagues["id"]).status == "draft"
    events = db.query(AuditEvent).filter_by(action="note.sign").order_by(AuditEvent.id).all()
    assert [e.resource_id for e in events] == [sams["id"], drafts[0]["id"], drafts[1]["id"]]


def test_group_note_rules(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    colleague = _colleague(db, clinician)
    theirs = create_client_record(db, colleague, email="casey@example.com", first_name="Casey")
    session, (alex, sam) = _group(db, clinician, 2)
    scheduler = add_staff(db, clinician.practice_id, "front@example.com", StaffRole.SCHEDULER)
    other = register_practice(api, email="other@example.com")

    assert _group_notes(api, other, session).status_code == 404
    assert _sign_all(api, other, session).status_code == 404
    assert _group_notes(api, scheduler, session).status_code == 403
    assign_clinician(db, alex, colleague)
    assert _group_notes(api, colleague, session).status_code == 403  # not their appointment
    invalid = _group_notes(api, clinician, session, sections={"data": "x"})
    assert invalid.status_code == 422
    missing = api.post("/api/appointments/999999/group-notes", json={}, headers=clinician.headers)
    assert missing.status_code == 404

    # The clinician needs clinical access to everyone in the session.
    reachable = book_session(db, colleague, [alex, theirs])
    unreachable = book_session(db, colleague, [theirs, sam])
    assert _group_notes(api, colleague, reachable).status_code == 201
    assert _group_notes(api, colleague, unreachable).status_code == 404
    event = create_appointment(db, clinician, [], kind=AppointmentKind.EVENT)
    assert _group_notes(api, clinician, event).status_code == 409
    db.expire_all()
    assert db.query(Note).filter_by(appointment_id=unreachable.id).count() == 0


def test_group_recording_audio_is_kept_until_every_note_is_signed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    session, _clients = _group(db, clinician, 2)
    first, second = _group_notes(api, clinician, session, sections=SOAP).json()
    recording = create_recording(db, session, note_id=first["id"], transcript="Group talk")
    stored = db.get(StoredFile, recording.file_id)
    assert stored is not None
    assert stored.client_id is None  # the audio belongs to the session, not one client
    audio = stored_path(stored.storage_key)

    api.post(f"/api/notes/{first['id']}/sign", headers=clinician.headers)
    assert audio.exists()
    api.post(f"/api/notes/{second['id']}/sign", headers=clinician.headers)
    assert not audio.exists()
    db.expire_all()
    cleared = db.get_one(Recording, recording.id)
    assert (cleared.file_id, cleared.transcript) == (None, "")
    events = db.query(AuditEvent).filter_by(action="note.sign").order_by(AuditEvent.id).all()
    assert [e.detail for e in events] == [{"recordings_cleared": 0}, {"recordings_cleared": 1}]


# Supervision ---------------------------------------------------------------------------------


def _supervised(db: Session, owner: StaffAccount) -> tuple[StaffAccount, StaffAccount, Client]:
    """A supervisor (Morgan), their supervisee (Riley) and one of Riley's clients."""
    supervisor = add_staff(
        db,
        owner.practice_id,
        "morgan@example.com",
        StaffRole.CLINICIAN,
        first_name="Morgan",
        last_name="Diaz",
    )
    supervisee = add_staff(
        db,
        owner.practice_id,
        "riley@example.com",
        StaffRole.CLINICIAN,
        first_name="Riley",
        last_name="Chen",
        supervisor_id=supervisor.id,
    )
    return supervisor, supervisee, create_client_record(db, supervisee)


def _pending_note(api: TestClient, author: StaffAccount, client: Client) -> dict[str, Any]:
    note = _create(api, author, client_id=client.id, sections=SOAP)
    signed = api.post(f"/api/notes/{note['id']}/sign", headers=author.headers)
    assert signed.status_code == 200, signed.text
    assert signed.json()["status"] == "pending_cosign"
    return signed.json()


def _notifications(db: Session, account: StaffAccount, kind: str) -> list[Notification]:
    db.expire_all()
    return (
        db.query(Notification)
        .filter_by(recipient_role=Role.STAFF, recipient_id=account.id, kind=kind)
        .order_by(Notification.id)
        .all()
    )


def test_a_supervisees_signed_note_waits_for_the_supervisors_cosignature(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor, supervisee, client = _supervised(db, clinician)
    pending = _pending_note(api, supervisee, client)
    url = f"/api/notes/{pending['id']}"
    assert pending["signed_at"] is not None
    assert pending["supervisor"] == {"id": supervisor.id, "name": "Morgan Diaz"}
    assert pending["cosigned_at"] is None
    [asked] = _notifications(db, supervisor, "note_cosign_requested")
    assert asked.link == f"/portal/notes/{pending['id']}"
    assert "Riley Chen" in asked.title
    assert "Alex" not in asked.title

    # Locked for the author until the supervisor acts.
    for method, path, body in (
        ("PATCH", url, {"title": "Changed"}),
        ("POST", f"{url}/sign", None),
        ("POST", f"{url}/unlock", UNLOCK),
    ):
        response = api.request(method, path, json=body, headers=supervisee.headers)
        assert response.status_code == 409, (method, path)
        assert (
            response.json()["detail"] == "This note is waiting for your supervisor's co-signature"
        )
    assert api.delete(url, headers=supervisee.headers).status_code == 409

    queue = api.get("/api/notes/cosign-queue", headers=supervisor.headers).json()
    assert [n["id"] for n in queue] == [pending["id"]]
    assert queue[0]["author"]["id"] == supervisee.id
    assert api.get("/api/notes/cosign-queue", headers=supervisee.headers).json() == []
    listed = api.get("/api/notes", params={"status": "pending_cosign"}, headers=supervisee.headers)
    assert [n["id"] for n in listed.json()] == [pending["id"]]

    cosigned = api.post(f"{url}/cosign", headers=supervisor.headers)
    assert cosigned.status_code == 200, cosigned.text
    body = cosigned.json()
    assert body["status"] == "signed"
    assert body["cosigned_at"] is not None
    assert body["signed_at"] == pending["signed_at"]
    [done] = _notifications(db, supervisee, "note_cosigned")
    assert (done.title, done.link) == ("Morgan Diaz co-signed your note", asked.link)
    assert api.get("/api/notes/cosign-queue", headers=supervisor.headers).json() == []
    assert api.post(f"{url}/cosign", headers=supervisor.headers).status_code == 409
    again = api.post(f"{url}/request-changes", json={"comment": "x"}, headers=supervisor.headers)
    assert again.status_code == 409

    # Unlocking a co-signed note clears the co-signature; it must be co-signed again.
    unlocked = api.post(f"{url}/unlock", json=UNLOCK, headers=supervisee.headers).json()
    assert (unlocked["status"], unlocked["signed_at"], unlocked["cosigned_at"]) == (
        "draft",
        None,
        None,
    )
    assert api.post(f"{url}/sign", headers=supervisee.headers).json()["status"] == "pending_cosign"
    assert len(_notifications(db, supervisor, "note_cosign_requested")) == 2
    actions = db.query(AuditEvent).filter_by(resource_type="note").order_by(AuditEvent.id).all()
    assert [(e.action, e.actor_id) for e in actions if e.action != "note.create"] == [
        ("note.sign", supervisee.id),
        ("note.cosign", supervisor.id),
        ("note.unlock", supervisee.id),
        ("note.sign", supervisee.id),
    ]
    assert actions[1].detail == {"recordings_cleared": 0, "supervisor_id": supervisor.id}


def test_a_supervisor_sends_a_note_back_with_a_comment(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor, supervisee, client = _supervised(db, clinician)
    pending = _pending_note(api, supervisee, client)
    url = f"/api/notes/{pending['id']}"
    blank = api.post(f"{url}/request-changes", json={"comment": "  "}, headers=supervisor.headers)
    assert blank.status_code == 422

    sent_back = api.post(
        f"{url}/request-changes",
        json={"comment": "Add the safety plan."},
        headers=supervisor.headers,
    )
    assert sent_back.status_code == 200, sent_back.text
    body = sent_back.json()
    assert (body["status"], body["signed_at"], body["supervisor_comment"]) == (
        "draft",
        None,
        "Add the safety plan.",
    )
    assert body["supervisor"]["id"] == supervisor.id
    [changes] = _notifications(db, supervisee, "note_changes_requested")
    assert changes.title == "Morgan Diaz asked for changes to your note"
    event = db.query(AuditEvent).filter_by(action="note.request_changes").one()
    assert (event.actor_id, event.resource_id) == (supervisor.id, pending["id"])
    assert "safety" not in str(event.detail)
    assert api.post(f"{url}/cosign", headers=supervisor.headers).status_code == 409

    # The author edits and signs again; the comment stays until the note is co-signed.
    edited = api.patch(
        url, json={"sections": {"plan": "Safety plan reviewed."}}, headers=supervisee.headers
    )
    assert edited.status_code == 200
    resigned = api.post(f"{url}/sign", headers=supervisee.headers).json()
    assert (resigned["status"], resigned["supervisor_comment"]) == (
        "pending_cosign",
        "Add the safety plan.",
    )
    assert api.post(f"{url}/cosign", headers=supervisor.headers).json()["supervisor_comment"] == ""


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("supervisor", 200),
        # Clinical access to the note, but not the supervisor who was asked.
        ("author", 403),
        ("owner", 403),
        ("practice_clinician", 403),
        ("care_team_colleague", 403),
        # No clinical access to the client at all.
        ("colleague", 404),
        ("biller", 404),
        ("other_practice", 404),
    ],
)
def test_only_the_supervisor_asked_can_cosign_or_send_back(
    api: TestClient, clinician: StaffAccount, db: Session, kind: str, expected: int
) -> None:
    supervisor, supervisee, client = _supervised(db, clinician)
    named = {"supervisor": supervisor, "author": supervisee}
    actor = named.get(kind) or make_viewer(api, db, clinician, supervisee, client, kind)
    to_cosign = _pending_note(api, supervisee, client)
    to_return = _pending_note(api, supervisee, client)

    cosign = api.post(f"/api/notes/{to_cosign['id']}/cosign", headers=actor.headers)
    assert cosign.status_code == expected, cosign.text
    send_back = api.post(
        f"/api/notes/{to_return['id']}/request-changes",
        json={"comment": "Please expand."},
        headers=actor.headers,
    )
    assert send_back.status_code == expected
    assert api.get("/api/notes/cosign-queue", headers=actor.headers).json() == []
    db.expire_all()
    statuses = (db.get_one(Note, to_cosign["id"]).status, db.get_one(Note, to_return["id"]).status)
    expected_statuses = ("signed", "draft") if expected == 200 else ("pending_cosign",) * 2
    assert statuses == expected_statuses


def test_a_pending_note_is_released_when_the_supervisor_changes(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor, supervisee, client = _supervised(db, clinician)
    pending = _pending_note(api, supervisee, client)
    url = f"/api/notes/{pending['id']}"
    successor = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    db.get_one(StaffMember, supervisee.id).supervisor_id = successor.id
    db.commit()

    # Only the supervisor asked may co-sign, and Morgan no longer sees Riley's clients.
    assert api.post(f"{url}/cosign", headers=successor.headers).status_code == 403
    assert api.post(f"{url}/cosign", headers=supervisor.headers).status_code == 404
    # So Riley unlocks it and signs again, which asks the new supervisor.
    assert api.post(f"{url}/unlock", json=UNLOCK, headers=supervisee.headers).status_code == 200
    resigned = api.post(f"{url}/sign", headers=supervisee.headers).json()
    assert resigned["supervisor"]["id"] == successor.id
    assert api.post(f"{url}/cosign", headers=successor.headers).status_code == 200

    # Without an active supervisor, notes are signed straight away.
    db.get_one(StaffMember, successor.id).status = StaffStatus.DEACTIVATED
    db.commit()
    note = _create(api, supervisee, client_id=client.id, sections=SOAP)
    signed = api.post(f"/api/notes/{note['id']}/sign", headers=supervisee.headers).json()
    assert (signed["status"], signed["supervisor"]) == ("signed", None)


def test_signing_all_session_notes_follows_supervision(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor, supervisee, alex = _supervised(db, clinician)
    sam = create_client_record(db, supervisee, first_name="Sam", email="sam@example.com")
    session = book_session(db, supervisee, [alex, sam])
    drafts = _group_notes(api, supervisee, session, sections=SOAP).json()
    signed = _sign_all(api, supervisee, session).json()
    assert {n["status"] for n in signed} == {"pending_cosign"}
    queue = api.get("/api/notes/cosign-queue", headers=supervisor.headers).json()
    assert [n["id"] for n in queue] == [n["id"] for n in drafts]
    assert len(_notifications(db, supervisor, "note_cosign_requested")) == 2


def test_note_pdf_shows_the_signature_and_the_cosignature(
    api: TestClient, clinician: StaffAccount, db: Session, pdf_lines: list[str]
) -> None:
    supervisor, supervisee, client = _supervised(db, clinician)
    api.patch("/api/me", json={"credentials": "LPC"}, headers=supervisor.headers)
    pending = _pending_note(api, supervisee, client)
    url = f"/api/notes/{pending['id']}/pdf"

    def signature_lines() -> list[str]:
        pdf_lines.clear()
        assert api.get(url, headers=supervisee.headers).status_code == 200
        return [line for line in pdf_lines if line.startswith(("Electronically", "Co-", "Await"))]

    author_line, waiting_line = signature_lines()
    assert author_line.startswith("Electronically signed by Riley Chen on ")
    assert waiting_line == "Awaiting co-signature by Morgan Diaz, LPC"
    api.post(f"/api/notes/{pending['id']}/cosign", headers=supervisor.headers)
    author_line, cosign_line = signature_lines()
    assert author_line.startswith("Electronically signed by Riley Chen on ")
    assert cosign_line.startswith("Co-signed by Morgan Diaz, LPC on ")
