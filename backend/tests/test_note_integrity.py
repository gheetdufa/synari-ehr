"""Record integrity: signed revisions and hashes, unlock reasons, addenda, integrity checks on
read, psychotherapy notes kept apart from the record, e-signed form hashes, and record exports
that ask for a purpose (non-TPO exports are disclosures)."""

import io
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.integrity import note_content_sha256
from synari.models import (
    AuditEvent,
    ClientForm,
    Disclosure,
    Note,
    NoteRevision,
    SecurityEvent,
)
from synari.models.enums import SecuritySeverity, StaffRole
from synari.services import storage
from synari.services.pdf import BaseDocument
from synari.services.security_events import CLIENT_EXPORTED
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    portal_headers,
    register_practice,
)

SOAP = {"subjective": "Reports better sleep.", "plan": "Continue weekly CBT."}
UNLOCK = {"reason": "Correcting the plan"}


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


@pytest.fixture
def pdf_lines(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    lines: list[str] = []
    write_block = BaseDocument.write_block

    def spy(document: BaseDocument, text: str, *args: Any, **kwargs: Any) -> None:
        lines.append(text)
        write_block(document, text, *args, **kwargs)

    monkeypatch.setattr(BaseDocument, "write_block", spy)
    return lines


def _note(api: TestClient, author: StaffAccount, client_id: int, **fields: Any) -> dict[str, Any]:
    response = api.post(
        "/api/notes",
        json={"client_id": client_id, "sections": SOAP, **fields},
        headers=author.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _sign(api: TestClient, author: StaffAccount, note_id: int) -> dict[str, Any]:
    response = api.post(f"/api/notes/{note_id}/sign", headers=author.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _clinician(db: Session, owner: StaffAccount, email: str, **fields: Any) -> StaffAccount:
    return add_staff(db, owner.practice_id, email, StaffRole.CLINICIAN, **fields)


def test_signing_keeps_hashed_revisions_and_unlocking_needs_a_reason(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    note = _note(api, clinician, client.id, title="Session 1")
    assert note["integrity"] is None
    assert note["revision_count"] == 0

    signed = _sign(api, clinician, note["id"])
    assert signed["integrity"] == "verified"
    assert signed["revision_count"] == 1
    stored = db.get(Note, note["id"])
    assert stored is not None and stored.signed_at is not None
    assert stored.content_sha256 == note_content_sha256(
        note_id=stored.id,
        client_id=client.id,
        author_id=clinician.id,
        title="Session 1",
        sections=stored.sections,
        content="",
        signed_at=stored.signed_at,
    )

    url = f"/api/notes/{note['id']}"
    assert api.post(f"{url}/unlock", headers=clinician.headers).status_code == 422
    assert (
        api.post(f"{url}/unlock", json={"reason": "  "}, headers=clinician.headers).status_code
        == 422
    )
    unlocked = api.post(f"{url}/unlock", json=UNLOCK, headers=clinician.headers).json()
    assert unlocked["pending_revision_reason"] == "Correcting the plan"
    assert unlocked["integrity"] is None
    api.patch(
        url, json={"sections": {**SOAP, "plan": "Every other week."}}, headers=clinician.headers
    )
    resigned = _sign(api, clinician, note["id"])
    assert resigned["revision_count"] == 2
    assert resigned["pending_revision_reason"] == ""

    revisions = api.get(f"{url}/revisions", headers=clinician.headers).json()
    assert [r["version"] for r in revisions] == [1, 2]
    assert revisions[0]["sections"]["plan"] == "Continue weekly CBT."
    assert revisions[1]["sections"]["plan"] == "Every other week."
    assert [r["reason"] for r in revisions] == ["", "Correcting the plan"]
    assert all(r["integrity"] == "verified" for r in revisions)
    assert revisions[0]["content_sha256"] != revisions[1]["content_sha256"]
    assert revisions[1]["signed_by"]["id"] == clinician.id
    viewed = db.scalars(select(AuditEvent).where(AuditEvent.action == "note.revisions_view")).one()
    assert viewed.client_id == client.id


def test_cosignature_and_returned_notes_keep_revisions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor = _clinician(db, clinician, "morgan@example.com", first_name="Morgan")
    supervisee = _clinician(db, clinician, "riley@example.com", supervisor_id=supervisor.id)
    client = create_client_record(db, supervisee)
    note = _note(api, supervisee, client.id)
    url = f"/api/notes/{note['id']}"
    _sign(api, supervisee, note["id"])
    returned = api.post(
        f"{url}/request-changes", json={"comment": "Add the risk plan"}, headers=supervisor.headers
    ).json()
    assert returned["pending_revision_reason"].endswith("Add the risk plan")
    _sign(api, supervisee, note["id"])
    cosigned = api.post(f"{url}/cosign", headers=supervisor.headers).json()
    assert cosigned["integrity"] == "verified"

    revisions = api.get(f"{url}/revisions", headers=supervisor.headers).json()
    assert [(r["version"], r["cosigned_by"]) for r in revisions][:2] == [(1, None), (2, None)]
    assert revisions[1]["reason"].endswith("Add the risk plan")
    assert revisions[2]["cosigned_by"]["id"] == supervisor.id
    assert revisions[2]["content_sha256"] == revisions[1]["content_sha256"]


def test_changed_signed_text_is_reported_once_a_day(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    note = _note(api, clinician, client.id)
    _sign(api, clinician, note["id"])
    stored = db.get(Note, note["id"])
    assert stored is not None
    stored.content = "Rewritten behind the app's back"
    db.commit()

    first = api.get(f"/api/notes/{note['id']}", headers=clinician.headers).json()
    assert first["integrity"] == "mismatch"
    listed = api.get("/api/notes", headers=clinician.headers).json()
    assert listed[0]["integrity"] == "mismatch"
    events = db.scalars(
        select(SecurityEvent).where(SecurityEvent.kind == "note.integrity_mismatch")
    ).all()
    assert len(events) == 1
    assert events[0].severity == SecuritySeverity.CRITICAL
    assert events[0].detail == {"note_id": note["id"], "client_id": client.id}

    revision = db.scalars(select(NoteRevision)).one()
    revision.content = "Tampered revision"
    db.commit()
    revisions = api.get(f"/api/notes/{note['id']}/revisions", headers=clinician.headers).json()
    assert revisions[0]["integrity"] == "mismatch"


def test_addenda_are_append_only_additions_by_the_author_or_supervisor(
    api: TestClient, clinician: StaffAccount, db: Session, pdf_lines: list[str]
) -> None:
    supervisor = _clinician(db, clinician, "morgan@example.com", first_name="Morgan")
    author = _clinician(db, clinician, "riley@example.com", supervisor_id=supervisor.id)
    colleague = _clinician(db, clinician, "sam@example.com")
    client = create_client_record(db, author)
    assign_clinician(db, client, colleague)
    note = _note(api, author, client.id)
    url = f"/api/notes/{note['id']}/addenda"
    draft = api.post(url, json={"content": "Late entry"}, headers=author.headers)
    assert draft.status_code == 409
    _sign(api, author, note["id"])

    added = api.post(
        url, json={"content": " Called client after session. "}, headers=author.headers
    )
    assert added.status_code == 201, added.text
    assert added.json()["content"] == "Called client after session."
    assert added.json()["integrity"] == "verified"
    assert len(added.json()["content_sha256"]) == 64
    by_supervisor = api.post(url, json={"content": "Reviewed."}, headers=supervisor.headers)
    assert by_supervisor.status_code == 201
    assert api.post(url, json={"content": "x"}, headers=colleague.headers).status_code == 403
    assert api.post(url, json={"content": "x"}, headers=clinician.headers).status_code == 403
    assert api.post(url, json={"content": ""}, headers=author.headers).status_code == 422

    listed = api.get(url, headers=colleague.headers).json()
    assert [a["content"] for a in listed] == ["Called client after session.", "Reviewed."]
    detail = api.get(f"/api/notes/{note['id']}", headers=author.headers).json()
    assert detail["addendum_count"] == 2

    api.get(f"/api/notes/{note['id']}/pdf", headers=author.headers)
    assert "Addenda" in pdf_lines
    assert "Called client after session." in pdf_lines
    assert any(line.startswith("Signature hash (SHA-256): ") for line in pdf_lines)
    created = db.scalars(select(AuditEvent).where(AuditEvent.action == "note.addendum_create"))
    assert {event.client_id for event in created} == {client.id}


def test_psychotherapy_notes_are_only_for_their_author_and_cosigning_supervisor(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor = _clinician(db, clinician, "morgan@example.com", first_name="Morgan")
    author = _clinician(db, clinician, "riley@example.com", supervisor_id=supervisor.id)
    colleague = _clinician(db, clinician, "sam@example.com")
    client = create_client_record(db, author)
    assign_clinician(db, client, colleague)
    progress = _note(api, author, client.id, title="Progress")
    private = _note(api, author, client.id, title="Process notes", note_type="psychotherapy")
    url = f"/api/notes/{private['id']}"

    # The owner (implicit chart access) and a care-team colleague can't see it at all.
    for viewer in (clinician, colleague, supervisor):
        assert api.get(url, headers=viewer.headers).status_code == 404
        titles = [n["title"] for n in api.get("/api/notes", headers=viewer.headers).json()]
        assert "Process notes" not in titles
        assert "Progress" in titles
    assert api.get(f"{url}/revisions", headers=clinician.headers).status_code == 404
    assert api.get(f"{url}/pdf", headers=clinician.headers).status_code == 404

    viewed = api.get(url, headers=author.headers)
    assert viewed.status_code == 200
    event = db.scalars(
        select(AuditEvent).where(
            AuditEvent.action == "note.view", AuditEvent.resource_id == private["id"]
        )
    ).one()
    assert event.client_id == client.id
    assert event.detail == {"psychotherapy": True}

    # Once signed, the supervisor asked to co-sign can read and co-sign it.
    _sign(api, author, private["id"])
    assert api.get(url, headers=supervisor.headers).status_code == 200
    assert api.post(f"{url}/cosign", headers=supervisor.headers).status_code == 200
    assert "Process notes" in [
        n["title"] for n in api.get("/api/notes", headers=supervisor.headers).json()
    ]
    assert api.get(url, headers=clinician.headers).status_code == 404

    # It never leaves the author's hands in an export.
    _sign(api, author, progress["id"])
    export = api.post(
        f"/api/clients/{client.id}/export", json={"purpose": "treatment"}, headers=clinician.headers
    )
    bundle = zipfile.ZipFile(io.BytesIO(export.content))
    notes_csv = bundle.read("notes.csv").decode()
    assert "Progress" in notes_csv
    assert "Psychotherapy" not in notes_csv
    assert len([name for name in bundle.namelist() if name.startswith("notes/")]) == 1
    assert "note_history.csv" in bundle.namelist()


def test_note_views_and_lists_are_audited_with_the_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    first = create_client_record(db, clinician)
    second = create_client_record(db, clinician, email="blake@example.com", first_name="Blake")
    one = _note(api, clinician, first.id)
    _note(api, clinician, second.id)
    api.get(f"/api/notes/{one['id']}", headers=clinician.headers)
    api.get("/api/notes", headers=clinician.headers)
    api.get("/api/notes", headers=clinician.headers)
    api.get(f"/api/notes?client_id={first.id}", headers=clinician.headers)

    view = db.scalars(select(AuditEvent).where(AuditEvent.action == "note.view")).one()
    assert view.client_id == first.id
    lists = db.scalars(
        select(AuditEvent).where(AuditEvent.action == "note.list").order_by(AuditEvent.id)
    ).all()
    assert len(lists) == 2  # the repeated identical list isn't recorded twice
    assert lists[0].client_id is None
    assert lists[0].detail is not None
    assert lists[0].detail["client_ids"] == sorted([first.id, second.id])
    assert lists[0].detail["client_count"] == 2
    assert lists[1].client_id == first.id


def test_signed_forms_carry_a_verified_signature_hash(
    api: TestClient, clinician: StaffAccount, db: Session, pdf_lines: list[str]
) -> None:
    client = create_client_record(db, clinician)
    templates = {
        t["library_key"] or t["name"]: t
        for t in api.get("/api/forms/templates", headers=clinician.headers).json()
    }
    [consent] = api.post(
        f"/api/clients/{client.id}/forms",
        json={"template_ids": [templates["informed_consent"]["id"]]},
        headers=clinician.headers,
    ).json()
    signed = api.post(
        f"/api/portal/forms/{consent['id']}/submit",
        json={"answers": {}, "signature_name": "Alex Rivera", "signature_agreed": True},
        headers=portal_headers(client),
    )
    assert signed.status_code == 200, signed.text
    detail = api.get(f"/api/client-forms/{consent['id']}", headers=clinician.headers).json()
    assert len(detail["signature_sha256"]) == 64
    assert detail["signature_integrity"] == "verified"

    api.get(f"/api/client-forms/{consent['id']}/pdf", headers=clinician.headers)
    assert f"Signature hash (SHA-256): {detail['signature_sha256']}" in pdf_lines

    form = db.get(ClientForm, consent["id"])
    assert form is not None
    form.signature_name = "Someone Else"
    db.commit()
    changed = api.get(f"/api/client-forms/{consent['id']}", headers=clinician.headers).json()
    assert changed["signature_integrity"] == "mismatch"


def test_exports_ask_why_and_record_disclosures(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    url = f"/api/clients/{client.id}/export"
    assert api.post(url, json={}, headers=clinician.headers).status_code == 422
    missing = api.post(url, json={"purpose": "other"}, headers=clinician.headers)
    assert missing.status_code == 422

    for purpose in ("treatment", "payment", "operations", "client"):
        assert (
            api.post(url, json={"purpose": purpose}, headers=clinician.headers).status_code == 200
        )
    assert db.scalar(select(Disclosure.id)) is None

    court = api.post(
        url,
        json={
            "purpose": "other",
            "recipient_name": "County Family Court",
            "recipient_address": "1 Main St",
            "description": "Subpoena for custody hearing",
            "legal_basis": "court order",
        },
        headers=clinician.headers,
    )
    assert court.status_code == 200
    disclosure = db.scalars(select(Disclosure)).one()
    assert (disclosure.client_id, disclosure.recipient_name, disclosure.purpose) == (
        client.id,
        "County Family Court",
        "Subpoena for custody hearing",
    )
    assert disclosure.legal_basis == "court order"
    assert disclosure.recorded_by_id == clinician.id
    exports = db.scalars(
        select(AuditEvent).where(AuditEvent.action == "client.export").order_by(AuditEvent.id)
    ).all()
    assert all(event.client_id == client.id for event in exports)
    assert exports[-1].detail is not None
    assert exports[-1].detail["disclosure_id"] == disclosure.id
    security = db.scalars(select(SecurityEvent).where(SecurityEvent.kind == CLIENT_EXPORTED)).all()
    assert len(security) == 5

    other = register_practice(api, email="other@example.com")
    assert api.post(url, json={"purpose": "treatment"}, headers=other.headers).status_code == 404
    assert len(db.scalars(select(Disclosure)).all()) == 1
    assert disclosure.source == "export"
    locked = api.patch(
        f"/api/disclosures/{disclosure.id}", json={"purpose": "x"}, headers=clinician.headers
    )
    assert locked.status_code == 409
    assert (
        api.delete(f"/api/disclosures/{disclosure.id}", headers=clinician.headers).status_code
        == 409
    )
