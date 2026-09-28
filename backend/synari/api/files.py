"""Client documents: files staff share, files the client uploads, and downloads.

Documents are part of the clinical record, so staff need clinical access to the client.
"""

from datetime import datetime

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff, audit_staff_throttled
from synari.deps import CurrentAccess, CurrentClient, DbSession
from synari.models import Client, Conversation, Message, MessageAttachment, StoredFile
from synari.models.enums import FilePurpose, Role
from synari.models.files import PSYCHOTHERAPY_NOTES_CATEGORY
from synari.schemas.common import Schema
from synari.services.messaging import can_read_conversation
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_portal_email, queue_staff_email
from synari.services.recipients import staff_with_client_access
from synari.services.storage import file_response, store_upload

router = APIRouter(tags=["files"])

CLIENT_VISIBLE_PURPOSES = (
    FilePurpose.SHARED_DOCUMENT,
    FilePurpose.CLIENT_UPLOAD,
    FilePurpose.MESSAGE_ATTACHMENT,
    FilePurpose.GOOD_FAITH_ESTIMATE,
)
# Documents the practice shares until it stops sharing them (issued good faith estimates too).
SHARED_PURPOSES = (FilePurpose.SHARED_DOCUMENT, FilePurpose.GOOD_FAITH_ESTIMATE)


class FileOut(Schema):
    id: int
    client_id: int | None
    purpose: FilePurpose
    filename: str
    content_type: str
    size_bytes: int
    uploaded_by: str
    uploaded_by_staff_id: int | None
    shared_with_client: bool
    # Where an imported document came from (e.g. "Medical Records"); empty otherwise.
    category: str
    created_at: datetime


def client_can_access(db: Session, client: Client, stored: StoredFile) -> bool:
    """Clients see their own documents and sent message attachments, never recordings.

    A message attachment is visible to the client only once it is on a message in their
    conversation that hasn't been removed (or if the client uploaded it themselves).
    """
    if stored.client_id != client.id or stored.purpose not in CLIENT_VISIBLE_PURPOSES:
        return False
    if stored.uploaded_by == Role.CLIENT:
        return True
    if stored.purpose in SHARED_PURPOSES:
        return stored.shared_with_client
    return bool(
        db.scalar(
            select(
                exists().where(
                    MessageAttachment.file_id == stored.id,
                    MessageAttachment.message_id == Message.id,
                    Message.removed_at.is_(None),
                    Message.conversation_id == Conversation.id,
                    Conversation.client_id == client.id,
                )
            )
        )
    )


def _can_open_psychotherapy_note(access: Access, stored: StoredFile, client: Client) -> bool:
    """Imported psychotherapy notes are for their author or the client's primary clinician."""
    if stored.category != PSYCHOTHERAPY_NOTES_CATEGORY:
        return True
    primary = client.primary_clinician
    return access.staff.id == stored.uploaded_by_staff_id or (
        primary is not None and primary.id == access.staff.id
    )


def _staff_file(access: Access, file_id: int) -> StoredFile:
    """A file this person may open; 404 otherwise.

    Documents need the client's clinical record. A message attachment also needs the
    conversation it was sent in (threads are private to their clinician), or it must be one
    they uploaded and haven't sent yet. Session recordings and import uploads are never served
    here, and imported psychotherapy notes only to their author or primary clinician.
    """
    stored = access.get(StoredFile, file_id, label="File")
    not_found = HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    if stored.purpose in (FilePurpose.RECORDING, FilePurpose.IMPORT_SOURCE):
        raise not_found
    if stored.client_id is None:
        if stored.uploaded_by_staff_id != access.staff.id:
            raise not_found
        return stored
    client = access.client(stored.client_id, ClientAccess.CLINICAL, label="File")
    if not _can_open_psychotherapy_note(access, stored, client):
        raise not_found
    if stored.purpose != FilePurpose.MESSAGE_ATTACHMENT:
        return stored
    conversations = access.db.scalars(
        select(Conversation)
        .join(Message, Message.conversation_id == Conversation.id)
        .join(MessageAttachment, MessageAttachment.message_id == Message.id)
        .where(MessageAttachment.file_id == stored.id)
    ).all()
    if not conversations:
        if stored.uploaded_by_staff_id != access.staff.id:
            raise not_found
        return stored
    if not any(can_read_conversation(access, c, client) for c in conversations):
        raise not_found
    return stored


def _notify_care_team_of_upload(db: Session, client: Client) -> None:
    """Tell everyone who can open the client's chart; email those who want document emails."""
    link = f"/portal/clients/{client.id}?tab=documents"
    for member in staff_with_client_access(db, client, ClientAccess.CLINICAL):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="client_upload",
            title=f"{short_name(client)} uploaded a document",
            link=link,
        )
        if member.notify_email_forms:
            queue_staff_email(
                db,
                member,
                subject="A client uploaded a document",
                heading="New client upload",
                paragraphs=["A client uploaded a document to their record. Sign in to view it."],
                button_label="Open Synari",
                app_path=link,
            )


@router.get("/clients/{client_id}/files", response_model=list[FileOut])
def list_client_files(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[StoredFile]:
    """Documents shared with, uploaded by or imported for a client (message attachments
    excluded; imported psychotherapy notes only for their author or primary clinician)."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    query = select(StoredFile).where(
        StoredFile.client_id == client.id,
        StoredFile.purpose.in_(
            (
                FilePurpose.SHARED_DOCUMENT,
                FilePurpose.CLIENT_UPLOAD,
                FilePurpose.IMPORTED_DOCUMENT,
            )
        ),
    )
    found = db.scalars(query.order_by(StoredFile.created_at.desc(), StoredFile.id.desc()))
    files = [f for f in found if _can_open_psychotherapy_note(access, f, client)]
    audit_staff_throttled(
        db, request, access.staff, "file.list", "client", client.id, client_id=client.id
    )
    db.commit()
    return files


@router.post(
    "/clients/{client_id}/files", response_model=FileOut, status_code=status.HTTP_201_CREATED
)
def share_file_with_client(
    client_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    file: UploadFile = File(...),
    notify_client: bool = Form(default=True, alias="notify"),
) -> StoredFile:
    """Upload a document to the client's record and share it in their portal."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    staff = access.staff
    stored = store_upload(
        db,
        file,
        practice_id=client.practice_id,
        client_id=client.id,
        purpose=FilePurpose.SHARED_DOCUMENT,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=staff.id,
        shared_with_client=True,
    )
    if notify_client:
        queue_portal_email(
            db,
            client,
            subject=f"New document from {client.practice.name}",
            heading="A document was shared with you",
            paragraphs=[f"{staff.display_name} shared a document in your client portal."],
            button_label="View document",
            next_path="/client/documents",
        )
    audit_staff(db, request, staff, "file.share", "file", stored.id, client_id=client.id)
    db.commit()
    return stored


@router.get("/files/{file_id}")
def download_file(file_id: int, access: CurrentAccess, db: DbSession, request: Request) -> Response:
    """Download a file from the chart of a client this person can open."""
    stored = _staff_file(access, file_id)
    audit_staff(
        db, request, access.staff, "file.download", "file", stored.id, client_id=stored.client_id
    )
    db.commit()
    return file_response(stored)


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def unshare_file(file_id: int, access: CurrentAccess, db: DbSession, request: Request) -> None:
    """Stop sharing a document with the client (the record is kept)."""
    stored = _staff_file(access, file_id)
    stored.shared_with_client = False
    audit_staff(
        db, request, access.staff, "file.unshare", "file", stored.id, client_id=stored.client_id
    )
    db.commit()


@router.get("/portal/files", response_model=list[FileOut])
def portal_list_files(client: CurrentClient, db: DbSession) -> list[StoredFile]:
    """Documents shared with the signed-in client and files they uploaded."""
    query = select(StoredFile).where(
        StoredFile.client_id == client.id,
        or_(
            StoredFile.purpose.in_(SHARED_PURPOSES) & StoredFile.shared_with_client,
            StoredFile.purpose == FilePurpose.CLIENT_UPLOAD,
        ),
    )
    return list(db.scalars(query.order_by(StoredFile.created_at.desc())))


@router.post("/portal/files", response_model=FileOut, status_code=status.HTTP_201_CREATED)
def portal_upload_file(
    client: CurrentClient, db: DbSession, request: Request, file: UploadFile = File(...)
) -> StoredFile:
    """Upload a document (e.g. an insurance card) to the client's record."""
    stored = store_upload(
        db,
        file,
        practice_id=client.practice_id,
        client_id=client.id,
        purpose=FilePurpose.CLIENT_UPLOAD,
        uploaded_by=Role.CLIENT,
    )
    _notify_care_team_of_upload(db, client)
    audit_client(db, request, client, "file.upload", "file", stored.id)
    db.commit()
    return stored


@router.get("/portal/files/{file_id}")
def portal_download_file(
    file_id: int, client: CurrentClient, db: DbSession, request: Request
) -> Response:
    """Download one of the signed-in client's own documents."""
    stored = db.get(StoredFile, file_id)
    if stored is None or not client_can_access(db, client, stored):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    audit_client(db, request, client, "file.download", "file", stored.id)
    db.commit()
    return file_response(stored)
