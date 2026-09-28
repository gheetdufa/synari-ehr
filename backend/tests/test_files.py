"""Client documents: sharing, portal uploads and downloads, and who may open them."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import AuditEvent, Notification, StaffMember, StoredFile
from synari.models.enums import ClinicianAccess, Role, StaffRole
from synari.services import storage
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)
from tests.test_portal_auth import contact_headers, guardian_of

PDF = {"file": ("consent.pdf", b"%PDF-1.4 test", "application/pdf")}


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


def test_share_list_and_download(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    uploaded = api.post(
        f"/api/clients/{client.id}/files",
        files={"file": ("../../consent.pdf", b"%PDF-1.4 test", "text/html")},
        headers=clinician.headers,
    )
    assert uploaded.status_code == 201, uploaded.text
    file = uploaded.json()
    assert file["filename"] == "consent.pdf"
    assert file["content_type"] == "application/pdf"
    assert file["uploaded_by_staff_id"] == clinician.id
    stored = db.get(StoredFile, file["id"])
    assert stored.practice_id == clinician.practice_id
    assert stored.storage_key.startswith(f"practices/{clinician.practice_id}/shared_document/")
    emails = outbound_to(db, "alex@example.com")
    assert len(emails) == 1
    assert emails[0].subject == "New document from Lee Counseling"

    headers = portal_headers(client)
    listed = api.get("/api/portal/files", headers=headers).json()
    assert [f["id"] for f in listed] == [file["id"]]
    download = api.get(f"/api/portal/files/{file['id']}", headers=headers)
    assert download.content == b"%PDF-1.4 test"
    assert "attachment" in download.headers["content-disposition"]

    api.delete(f"/api/files/{file['id']}", headers=clinician.headers)
    assert api.get(f"/api/portal/files/{file['id']}", headers=headers).status_code == 404
    assert api.get(f"/api/files/{file['id']}", headers=clinician.headers).status_code == 200


def test_sharing_without_notifying_the_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    response = api.post(
        f"/api/clients/{client.id}/files",
        files=PDF,
        data={"notify": "false"},
        headers=clinician.headers,
    )
    assert response.status_code == 201
    assert outbound_to(db, "alex@example.com") == []


def test_client_upload_and_isolation(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    other = create_client_record(db, clinician, email="other@example.com")
    uploaded = api.post(
        "/api/portal/files",
        files={"file": ("card.png", b"\x89PNG", "image/png")},
        headers=portal_headers(client),
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    assert uploaded.json()["uploaded_by_staff_id"] is None
    assert api.get(f"/api/portal/files/{file_id}", headers=portal_headers(other)).status_code == 404
    other_listing = api.get("/api/portal/files", headers=portal_headers(other)).json()
    assert other_listing == []
    listed = api.get(f"/api/clients/{client.id}/files", headers=clinician.headers).json()
    assert [f["uploaded_by"] for f in listed] == ["client"]
    assert len(outbound_to(db, clinician.email)) == 1


def test_client_upload_notifies_staff_with_clinical_access(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    primary = add_staff(db, practice_id, "casey@example.com", StaffRole.CLINICIAN)
    colleague = add_staff(db, practice_id, "morgan@example.com", StaffRole.CLINICIAN)
    scheduler = add_staff(db, practice_id, "scheduler@example.com", StaffRole.SCHEDULER)
    db.get(StaffMember, primary.id).notify_email_forms = False
    db.commit()
    client = create_client_record(db, primary)

    api.post("/api/portal/files", files=PDF, headers=portal_headers(client))

    db.expire_all()
    notified = {
        n.recipient_id
        for n in db.query(Notification).filter_by(recipient_role=Role.STAFF, kind="client_upload")
    }
    # The primary clinician and the owner (who opens every chart) hear about it.
    assert notified == {primary.id, clinician.id}
    assert colleague.id not in notified and scheduler.id not in notified
    assert len(outbound_to(db, clinician.email)) == 1
    assert outbound_to(db, primary.email) == []  # turned off document emails
    assert outbound_to(db, colleague.email) == []


@pytest.mark.parametrize(
    ("role", "clinician_access", "expected"),
    [
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, 404),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, 404),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, 200),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, 404),
        (StaffRole.BILLER, ClinicianAccess.BASIC, 404),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, 404),
    ],
)
def test_documents_need_clinical_access(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    clinician_access: ClinicianAccess,
    expected: int,
) -> None:
    client = create_client_record(db, clinician)
    shared = api.post(f"/api/clients/{client.id}/files", files=PDF, headers=clinician.headers)
    file_id = shared.json()["id"]
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=clinician_access
    )
    headers = member.headers
    assert api.get(f"/api/clients/{client.id}/files", headers=headers).status_code == expected
    assert api.get(f"/api/files/{file_id}", headers=headers).status_code == expected
    share = api.post(f"/api/clients/{client.id}/files", files=PDF, headers=headers)
    assert share.status_code == (201 if expected == 200 else 404)
    unshare = api.delete(f"/api/files/{file_id}", headers=headers)
    assert unshare.status_code == (204 if expected == 200 else 404)


def test_supervisor_opens_a_supervisees_documents(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    supervisor = add_staff(db, practice_id, "riley@example.com", StaffRole.CLINICIAN)
    supervisee = add_staff(
        db, practice_id, "casey@example.com", StaffRole.CLINICIAN, supervisor_id=supervisor.id
    )
    client = create_client_record(db, supervisee)
    shared = api.post(f"/api/clients/{client.id}/files", files=PDF, headers=supervisee.headers)
    assert shared.status_code == 201
    listed = api.get(f"/api/clients/{client.id}/files", headers=supervisor.headers)
    assert [f["id"] for f in listed.json()] == [shared.json()["id"]]


def test_other_practices_cannot_reach_documents(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    file_id = api.post(
        f"/api/clients/{client.id}/files", files=PDF, headers=clinician.headers
    ).json()["id"]
    other = register_practice(api, email="other@example.com")
    assert api.get(f"/api/clients/{client.id}/files", headers=other.headers).status_code == 404
    assert api.get(f"/api/files/{file_id}", headers=other.headers).status_code == 404
    assert api.delete(f"/api/files/{file_id}", headers=other.headers).status_code == 404
    share = api.post(f"/api/clients/{client.id}/files", files=PDF, headers=other.headers)
    assert share.status_code == 404


def test_rejects_disallowed_and_empty_files(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    exe = api.post(
        "/api/portal/files", files={"file": ("x.exe", b"MZ", "application/pdf")}, headers=headers
    )
    assert exe.status_code == 415
    empty = api.post(
        "/api/portal/files", files={"file": ("x.pdf", b"", "application/pdf")}, headers=headers
    )
    assert empty.status_code == 422


def test_guardian_uses_the_minors_documents(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None, is_minor=True)
    guardian = guardian_of(db, minor)
    shared = api.post(f"/api/clients/{minor.id}/files", files=PDF, headers=clinician.headers)
    assert shared.status_code == 201
    [notice] = outbound_to(db, "pat@example.com")
    assert notice.subject == "New document from Lee Counseling"
    assert "/client/sign-in?token=" in notice.body_text

    headers = contact_headers(guardian)
    listed = api.get("/api/portal/files", headers=headers).json()
    assert [f["id"] for f in listed] == [shared.json()["id"]]
    uploaded = api.post(
        "/api/portal/files",
        files={"file": ("card.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        headers=headers,
    )
    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["client_id"] == minor.id
    audit = db.query(AuditEvent).filter_by(action="file.upload").one()
    assert (audit.actor_role, audit.actor_id, audit.detail) == (
        "client",
        minor.id,
        {"contact_id": guardian.id},
    )
    staff_view = api.get(f"/api/clients/{minor.id}/files", headers=clinician.headers).json()
    assert uploaded.json()["id"] in [f["id"] for f in staff_view]
