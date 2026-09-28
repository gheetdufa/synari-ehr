"""Secure messaging: the staff inbox and conversations, and the portal's Messages tab.

Each conversation is between one client and one clinician. Staff open their own conversation
with a client from the chart (POST /clients/{id}/conversations), and read and reply in any
conversation they can read (see services/messaging.can_read_conversation). Clients open one
with any clinician on their care team (POST /portal/conversations).

Attachments are uploaded first (one request per file) and then sent by id with the message.
They download through the regular /files/{id} and /portal/files/{id} endpoints.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, CurrentPortalActor, DbSession, PortalActor
from synari.models import (
    Client,
    Conversation,
    Message,
    MessageAttachment,
    StaffMember,
    StoredFile,
)
from synari.models.enums import FilePurpose, RiskLevel, Role
from synari.pagination import ListPage, paginate
from synari.permissions import Capability
from synari.schemas.messaging import (
    AttachmentOut,
    ConversationClient,
    ConversationClinician,
    ConversationOut,
    MessageCreate,
    MessageOut,
    PortalConversationOut,
    PortalConversationStart,
    PortalMessageOut,
    PortalSentMessageOut,
    UnreadCount,
)
from synari.services.client_search import client_matches
from synari.services.messaging import (
    active_away_message,
    can_read_conversation,
    care_team_clinician,
    client_conversations,
    contact_sender_name,
    conversation_is_open,
    latest_previews,
    list_messages,
    mark_read_by_client,
    mark_read_by_staff,
    messaging_blocker,
    open_conversation,
    readable_conversations,
    remove_message,
    send_message,
    unread_by_conversation,
    unread_counts,
    urgent_conversations,
)
from synari.services.storage import get_storage, store_upload

router = APIRouter(tags=["messages"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100


def _not_found(label: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")


@dataclass(frozen=True)
class SenderNames:
    """Display names for the people behind a page of messages, by staff id and contact id."""

    staff: dict[int, str]
    contacts: dict[int, str]


def _sender_names(
    db: Session, conversation: Conversation, client: Client, messages: Sequence[Message]
) -> SenderNames:
    """Who wrote these messages: staff (automatic replies are the clinician's) and the
    client's contacts writing on their behalf."""
    staff_ids = {conversation.clinician_id} | {
        message.sender_staff_id for message in messages if message.sender_staff_id is not None
    }
    staff = db.scalars(select(StaffMember).where(StaffMember.id.in_(staff_ids)))
    return SenderNames(
        staff={member.id: member.display_name for member in staff},
        contacts={contact.id: contact_sender_name(contact, client) for contact in client.contacts},
    )


def _message_fields(
    message: Message, conversation: Conversation, names: SenderNames
) -> dict[str, object]:
    removed = message.removed_at is not None
    if message.sender_role == Role.CLIENT:
        recipient_read_at = conversation.clinician_read_at
        sender_name = (
            names.contacts.get(message.sender_contact_id)
            if message.sender_contact_id is not None
            else None
        )
    else:
        sender_name = names.staff[message.sender_staff_id or conversation.clinician_id]
        recipient_read_at = conversation.client_read_at
    attachments = (
        []
        if removed
        else [
            AttachmentOut.model_validate(attachment.file)
            for attachment in sorted(message.attachments, key=lambda a: a.id)
        ]
    )
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_role": Role(message.sender_role),
        "sender_name": sender_name,
        "body": "" if removed else message.body,
        "removed": removed,
        "is_automatic": message.is_automatic,
        "attachments": attachments,
        "created_at": message.created_at,
        "read_by_recipient": recipient_read_at is not None
        and recipient_read_at >= message.created_at,
    }


def _portal_message_out(
    message: Message, conversation: Conversation, names: SenderNames, actor: PortalActor
) -> PortalMessageOut:
    viewer_contact_id = actor.contact.id if actor.contact is not None else None
    return PortalMessageOut(
        **_message_fields(message, conversation, names),
        sent_by_me=message.sender_role == Role.CLIENT
        and message.sender_contact_id == viewer_contact_id,
    )


def _message_out(message: Message, conversation: Conversation, names: SenderNames) -> MessageOut:
    return MessageOut(
        **_message_fields(message, conversation, names),
        sender_staff_id=message.sender_staff_id,
        sender_contact_id=message.sender_contact_id,
        risk_level=RiskLevel(message.risk_level),
    )


def _clinician_out(clinician: StaffMember) -> ConversationClinician:
    return ConversationClinician(id=clinician.id, name=clinician.display_name)


# Staff routes


def _require_messaging_role(access: Access) -> None:
    """Only clinicians, and staff who can open every chart, have a messages inbox."""
    if not (access.staff.is_clinician or access.can(Capability.CLINICAL_ALL)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't include secure messaging")


def _require_messageable(client: Client) -> None:
    blocker = messaging_blocker(client)
    if blocker is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, blocker)


def _readable_conversation(
    access: Access, conversation_id: int, *, label: str = "Conversation"
) -> tuple[Conversation, Client]:
    conversation = access.get(Conversation, conversation_id, label=label)
    client = access.db.get_one(Client, conversation.client_id)
    if not can_read_conversation(access, conversation, client):
        raise _not_found(label)
    return conversation, client


def _inbox_rows(
    db: Session, rows: Sequence[tuple[Conversation, Client, StaffMember]]
) -> list[ConversationOut]:
    conversation_ids = [conversation.id for conversation, _, _ in rows]
    unread = unread_counts(db, conversation_ids, Role.STAFF)
    previews = latest_previews(db, conversation_ids)
    urgent = urgent_conversations(db, conversation_ids)
    return [
        ConversationOut(
            id=conversation.id,
            client=ConversationClient.model_validate(client),
            clinician=_clinician_out(clinician),
            last_message_at=conversation.last_message_at,
            unread_count=unread.get(conversation.id, 0),
            last_message_preview=previews.get(conversation.id, ""),
            has_urgent=conversation.id in urgent,
        )
        for conversation, client, clinician in rows
    ]


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    clinician_id: int | None = Query(default=None, description="Only this clinician's"),
    client_id: int | None = Query(default=None, description="Only those with this client"),
    q: str = Query(default="", max_length=100, description="Client name, email or phone"),
) -> list[ConversationOut]:
    """A page of the conversations you can read, most recent first.

    Clinicians see their own and their supervisees'; staff who can open every chart see the
    whole practice's. Pass clinician_id for one clinician's inbox.
    """
    _require_messaging_role(access)
    query = (
        select(Conversation, Client, StaffMember)
        .join(Client, Client.id == Conversation.client_id)
        .join(StaffMember, StaffMember.id == Conversation.clinician_id)
        .where(readable_conversations(access))
    )
    if clinician_id is not None:
        query = query.where(Conversation.clinician_id == clinician_id)
    if client_id is not None:
        query = query.where(Conversation.client_id == client_id)
    term = q.strip()
    if term:
        query = query.where(client_matches(term))
    ordered = query.order_by(
        Conversation.last_message_at.desc().nulls_last(), Conversation.id.desc()
    )
    rows = db.execute(paginate(db, ordered, page, response)).all()
    inbox = _inbox_rows(db, rows)
    audit_staff_list(
        db, request, access.staff, "messages.list", (client.id for _, client, _ in rows)
    )
    db.commit()
    return inbox


@router.get("/conversations/{conversation_id}", response_model=ConversationOut)
def get_conversation(
    conversation_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ConversationOut:
    """One conversation as the inbox lists it (for links to one that isn't on a loaded page)."""
    conversation, client = _readable_conversation(access, conversation_id)
    clinician = db.get_one(StaffMember, conversation.clinician_id)
    [row] = _inbox_rows(db, [(conversation, client, clinician)])
    audit_staff(
        db,
        request,
        access.staff,
        "conversation.view",
        "client",
        client.id,
        {"conversation_id": conversation.id},
    )
    db.commit()
    return row


@router.post("/clients/{client_id}/conversations", response_model=ConversationOut)
def start_conversation(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ConversationOut:
    """Open your own conversation with a client, creating it if needed.

    You must be a clinician on the client's care team, or able to open every chart.
    """
    client = access.client(client_id, ClientAccess.CLINICAL)
    on_care_team = any(member.staff_id == access.staff.id for member in client.care_team)
    if not (on_care_team or access.can(Capability.CLINICAL_ALL)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only a clinician on this client's care team can message them",
        )
    _require_messageable(client)
    conversation = open_conversation(db, access.staff.id, client)
    [row] = _inbox_rows(db, [(conversation, client, access.staff)])
    audit_staff(
        db,
        request,
        access.staff,
        "conversation.open",
        "client",
        client.id,
        {"conversation_id": conversation.id},
        client_id=client.id,
    )
    db.commit()
    return row


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
def list_conversation_messages(
    conversation_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    before_id: int | None = Query(default=None, description="Return messages older than this"),
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> list[MessageOut]:
    """A page of a conversation, oldest first; page back with before_id."""
    conversation, client = _readable_conversation(access, conversation_id)
    messages = list_messages(db, conversation.id, before_id=before_id, limit=limit)
    names = _sender_names(db, conversation, client, messages)
    audit_staff(
        db,
        request,
        access.staff,
        "messages.view",
        "client",
        client.id,
        {"conversation_id": conversation.id},
        client_id=client.id,
    )
    db.commit()
    return [_message_out(message, conversation, names) for message in messages]


@router.post(
    "/conversations/{conversation_id}/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
def upload_attachment(
    conversation_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    file: UploadFile = File(...),
) -> StoredFile:
    """Upload a file to attach to your next message in this conversation."""
    _, client = _readable_conversation(access, conversation_id)
    _require_messageable(client)
    stored = store_upload(
        db,
        file,
        practice_id=access.practice_id,
        client_id=client.id,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=access.staff.id,
    )
    audit_staff(
        db,
        request,
        access.staff,
        "message_attachment.upload",
        "file",
        stored.id,
        client_id=client.id,
    )
    db.commit()
    return stored


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
def send_to_client(
    conversation_id: int,
    body: MessageCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> MessageOut:
    """Send a secure message as yourself; the client gets an in-app and a delayed email notice."""
    conversation, client = _readable_conversation(access, conversation_id)
    _require_messageable(client)
    message = send_message(
        db,
        conversation,
        client,
        sender=access.staff,
        body=body.body,
        attachment_ids=body.attachment_ids,
        now=utcnow(),
    )
    names = _sender_names(db, conversation, client, [message])
    audit_staff(
        db,
        request,
        access.staff,
        "message.send",
        "message",
        message.id,
        {"attachments": len(body.attachment_ids)},
        client_id=client.id,
    )
    db.commit()
    return _message_out(message, conversation, names)


@router.post("/conversations/{conversation_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_conversation_read(conversation_id: int, access: CurrentAccess, db: DbSession) -> None:
    """Mark a conversation read. Only its clinician's reading counts; for others it's a no-op."""
    conversation, client = _readable_conversation(access, conversation_id)
    mark_read_by_staff(db, conversation, client, access.staff, utcnow())
    db.commit()


@router.delete("/messages/{message_id}", response_model=MessageOut)
def remove_staff_message(
    message_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> MessageOut:
    """Remove a message you sent; it stays in the thread marked as removed."""
    message = db.get(Message, message_id)
    if message is None:
        raise _not_found("Message")
    conversation, client = _readable_conversation(access, message.conversation_id, label="Message")
    remove_message(db, conversation, client, message, remover=access.staff, now=utcnow())
    names = _sender_names(db, conversation, client, [message])
    audit_staff(
        db,
        request,
        access.staff,
        "message.remove",
        "message",
        message.id,
        client_id=client.id,
    )
    db.commit()
    return _message_out(message, conversation, names)


@router.get("/messages/unread-count", response_model=UnreadCount)
def staff_unread_count(access: CurrentAccess, db: DbSession) -> UnreadCount:
    """Unread client messages in your own conversations (for the navigation badge)."""
    return UnreadCount(count=sum(unread_by_conversation(db, access.staff.id).values()))


def _discard_unsent(db: Session, stored: StoredFile) -> None:
    attached = db.scalar(select(exists().where(MessageAttachment.file_id == stored.id)))
    if stored.purpose != FilePurpose.MESSAGE_ATTACHMENT or attached:
        raise _not_found("Unsent attachment")
    get_storage().delete(stored.storage_key)
    db.delete(stored)


@router.delete("/messages/attachments/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard_attachment(file_id: int, access: CurrentAccess, db: DbSession) -> None:
    """Delete an attachment you uploaded but never sent."""
    stored = db.get(StoredFile, file_id)
    if stored is None or stored.uploaded_by_staff_id != access.staff.id:
        raise _not_found("Unsent attachment")
    _discard_unsent(db, stored)
    db.commit()


# Client portal routes


def _require_portal_messaging(client: CurrentClient) -> Client:
    if messaging_blocker(client) is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Secure messaging isn't available in your portal"
        )
    return client


MessagingClient = Annotated[Client, Depends(_require_portal_messaging)]


def _portal_conversation(
    db: Session, client: Client, conversation_id: int, *, label: str = "Conversation"
) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not conversation_is_open(db, conversation, client):
        raise _not_found(label)
    return conversation


def _portal_row(
    clinician: StaffMember, conversation: Conversation | None, unread: dict[int, int]
) -> PortalConversationOut:
    return PortalConversationOut(
        id=conversation.id if conversation else None,
        clinician=_clinician_out(clinician),
        last_message_at=conversation.last_message_at if conversation else None,
        unread_count=unread.get(conversation.id, 0) if conversation else 0,
        away_message=active_away_message(clinician),
    )


@router.get("/portal/conversations", response_model=list[PortalConversationOut])
def portal_list_conversations(
    client: MessagingClient, db: DbSession
) -> list[PortalConversationOut]:
    """The clinicians the client can message, each with their conversation once it's started."""
    partners = client_conversations(db, client)
    conversation_ids = [conversation.id for _, conversation in partners if conversation]
    unread = unread_counts(db, conversation_ids, Role.CLIENT)
    return [_portal_row(clinician, conversation, unread) for clinician, conversation in partners]


@router.post("/portal/conversations", response_model=PortalConversationOut)
def portal_start_conversation(
    body: PortalConversationStart, client: MessagingClient, db: DbSession
) -> PortalConversationOut:
    """Open the conversation with a clinician on the client's care team, creating it if needed."""
    clinician = care_team_clinician(client, body.clinician_id)
    if clinician is None:
        raise _not_found("Clinician")
    conversation = open_conversation(db, clinician.id, client)
    unread = unread_counts(db, [conversation.id], Role.CLIENT)
    db.commit()
    return _portal_row(clinician, conversation, unread)


@router.get(
    "/portal/conversations/{conversation_id}/messages", response_model=list[PortalMessageOut]
)
def portal_list_messages(
    conversation_id: int,
    client: MessagingClient,
    actor: CurrentPortalActor,
    db: DbSession,
    request: Request,
    before_id: int | None = Query(default=None, description="Return messages older than this"),
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> list[PortalMessageOut]:
    """A page of the conversation, oldest first; page back with before_id."""
    conversation = _portal_conversation(db, client, conversation_id)
    messages = list_messages(db, conversation.id, before_id=before_id, limit=limit)
    names = _sender_names(db, conversation, client, messages)
    audit_client(db, request, client, "messages.view", "conversation", conversation.id)
    db.commit()
    return [_portal_message_out(message, conversation, names, actor) for message in messages]


@router.post(
    "/portal/messages/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
def portal_upload_attachment(
    client: MessagingClient, db: DbSession, request: Request, file: UploadFile = File(...)
) -> StoredFile:
    """Upload a file to attach to the client's next message."""
    stored = store_upload(
        db,
        file,
        practice_id=client.practice_id,
        client_id=client.id,
        purpose=FilePurpose.MESSAGE_ATTACHMENT,
        uploaded_by=Role.CLIENT,
    )
    audit_client(db, request, client, "message_attachment.upload", "file", stored.id)
    db.commit()
    return stored


@router.post(
    "/portal/conversations/{conversation_id}/messages",
    response_model=PortalSentMessageOut,
    status_code=status.HTTP_201_CREATED,
)
def portal_send_message(
    conversation_id: int,
    body: MessageCreate,
    client: MessagingClient,
    actor: CurrentPortalActor,
    db: DbSession,
    request: Request,
) -> PortalSentMessageOut:
    """Send a secure message to the clinician (as the client's contact when one signed in).

    crisis_resources is true when the message contains crisis language, so the portal can
    show emergency resources (988, 911) right away.
    """
    conversation = _portal_conversation(db, client, conversation_id)
    message = send_message(
        db,
        conversation,
        client,
        sender=None,
        sender_contact=actor.contact,
        body=body.body,
        attachment_ids=body.attachment_ids,
        now=utcnow(),
    )
    names = _sender_names(db, conversation, client, [message])
    audit_client(
        db,
        request,
        client,
        "message.send",
        "message",
        message.id,
        {"conversation_id": conversation.id, "attachments": len(body.attachment_ids)},
    )
    db.commit()
    return PortalSentMessageOut(
        **dict(_portal_message_out(message, conversation, names, actor)),
        crisis_resources=message.risk_level == RiskLevel.HIGH,
    )


@router.post("/portal/conversations/{conversation_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def portal_mark_read(conversation_id: int, client: MessagingClient, db: DbSession) -> None:
    """Mark the conversation as read by the client."""
    conversation = _portal_conversation(db, client, conversation_id)
    mark_read_by_client(db, conversation, client, utcnow())
    db.commit()


@router.delete("/portal/messages/{message_id}", response_model=PortalMessageOut)
def portal_remove_message(
    message_id: int,
    client: MessagingClient,
    actor: CurrentPortalActor,
    db: DbSession,
    request: Request,
) -> PortalMessageOut:
    """Remove a message you sent (the client, or the contact signed in for them); it stays in
    the thread marked as removed."""
    message = db.get(Message, message_id)
    if message is None:
        raise _not_found("Message")
    conversation = _portal_conversation(db, client, message.conversation_id, label="Message")
    remove_message(
        db,
        conversation,
        client,
        message,
        remover=None,
        remover_contact=actor.contact,
        now=utcnow(),
    )
    names = _sender_names(db, conversation, client, [message])
    audit_client(db, request, client, "message.remove", "message", message.id)
    db.commit()
    return _portal_message_out(message, conversation, names, actor)


@router.get("/portal/messages/unread-count", response_model=UnreadCount)
def portal_unread_count(client: MessagingClient, db: DbSession) -> UnreadCount:
    """Unread messages from the client's clinicians (for the portal's navigation badge)."""
    conversation_ids = [
        conversation.id for _, conversation in client_conversations(db, client) if conversation
    ]
    return UnreadCount(count=sum(unread_counts(db, conversation_ids, Role.CLIENT).values()))


@router.delete("/portal/messages/attachments/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def portal_discard_attachment(file_id: int, client: CurrentClient, db: DbSession) -> None:
    """Delete a file the client uploaded but didn't send."""
    stored = db.get(StoredFile, file_id)
    if stored is None or stored.client_id != client.id or stored.uploaded_by != Role.CLIENT:
        raise _not_found("Unsent attachment")
    _discard_unsent(db, stored)
    db.commit()
