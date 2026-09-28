"""Secure messaging between a client and one of their clinicians.

There is one Conversation per (clinician, client). Staff open theirs from the client's chart
and clients open one with any clinician on their care team (`open_conversation`). The
conversation's clinician owns its read marker, away reply and email notices. Other staff who
can read it (`can_read_conversation`) may reply too, and every staff message records who
wrote it. A contact signed in to the client's portal (a minor's parent) writes on the client's
behalf; their messages record the contact, and they get the client's email notices too.

Sending locks the conversation row, so concurrent sends in one thread are serialized (away
replies and email de-duplication can't race), and locks the attachment rows so a file is
only ever sent once.

Emails and in-app notifications say only that a message arrived; message text never leaves
the app. Realtime events carry ids only and go to the client and to the staff who can read
the conversation.
"""

from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import (
    Client,
    ClientContact,
    Conversation,
    Message,
    MessageAttachment,
    StaffMember,
    StoredFile,
)
from synari.models.enums import FilePurpose, RiskLevel, Role
from synari.permissions import Capability
from synari.realtime import Recipient, publish
from synari.services.crisis import assess_risk
from synari.services.notifications import mark_all_read, notify, short_name
from synari.services.outbox import (
    CONDITION_CLIENT_UNREAD_MESSAGE,
    CONDITION_CLINICIAN_UNREAD_MESSAGE,
)
from synari.services.portal_links import queue_portal_email, queue_staff_email
from synari.services.recipients import active_staff, as_recipients

NOTICE_DELAY = timedelta(minutes=10)
AWAY_REPLY_INTERVAL = timedelta(hours=24)
PREVIEW_LENGTH = 120
KIND_MESSAGE = "message"
KIND_URGENT_MESSAGE = "message_urgent"


def staff_conversation_path(conversation_id: int) -> str:
    """Where the staff app shows a conversation."""
    return f"/portal/messaging?conversation={conversation_id}"


def client_conversation_path(conversation_id: int) -> str:
    """Where the client portal shows a conversation."""
    return f"/client/messages?conversation={conversation_id}"


def messaging_blocker(client: Client) -> str | None:
    """Why the client can't use secure messaging right now, or None if they can."""
    if not client.practice.settings.messaging_enabled:
        return "Secure messaging is turned off for this practice"
    if not client.can_use_portal:
        return "This client doesn't have client portal access"
    if not client.portal_messaging:
        return "Secure messaging is turned off for this client"
    return None


def contact_sender_name(contact: ClientContact, client: Client) -> str:
    """How a message a contact wrote on the client's behalf is signed, e.g. "Pat Rivera (for
    Alex)"."""
    return f"{contact.full_name} (for {client.display_first_name})"


def active_away_message(clinician: StaffMember) -> str | None:
    """The clinician's own away message while they have it switched on, else None."""
    message = clinician.away_message.strip()
    return message if clinician.away_message_enabled and message else None


# Who can read a conversation


def can_read_conversation(access: Access, conversation: Conversation, client: Client) -> bool:
    """Whether a staff member may read and reply in a conversation.

    Its clinician may, and so may their supervisors and anyone who can open every chart, as
    long as they can see the client's clinical record.
    """
    if conversation.practice_id != access.practice_id:
        return False
    if not access.can_access_client(client, ClientAccess.CLINICAL):
        return False
    return (
        access.can(Capability.CLINICAL_ALL)
        or conversation.clinician_id == access.staff.id
        or conversation.clinician_id in access.supervisee_ids
    )


def readable_conversations(access: Access) -> ColumnElement[bool]:
    """SQL condition on Conversation joined to Client: the conversations a person may read."""
    condition = (Conversation.practice_id == access.practice_id) & access.client_filter(
        ClientAccess.CLINICAL
    )
    if access.can(Capability.CLINICAL_ALL):
        return condition
    return condition & Conversation.clinician_id.in_([access.staff.id, *access.supervisee_ids])


def _can_message(db: Session, staff: StaffMember, client: Client) -> bool:
    """Whether a client can write to this staff member: active, and able to see their chart."""
    return staff.is_active and Access(db, staff).can_access_client(client, ClientAccess.CLINICAL)


def conversation_is_open(db: Session, conversation: Conversation, client: Client) -> bool:
    """Whether the client can use a conversation: theirs, with a clinician who can still read it."""
    return conversation.client_id == client.id and _can_message(
        db, db.get_one(StaffMember, conversation.clinician_id), client
    )


def client_conversations(
    db: Session, client: Client
) -> list[tuple[StaffMember, Conversation | None]]:
    """The clinicians a client can message, each with their conversation if one was started.

    That's everyone on the care team (primary clinician first), then any other staff member
    who started a conversation with the client and can still see their chart.
    """
    conversations = {
        conversation.clinician_id: conversation
        for conversation in db.scalars(
            select(Conversation)
            .where(Conversation.client_id == client.id)
            .order_by(Conversation.id)
        )
    }
    care_team = sorted(
        client.care_team,
        key=lambda member: (not member.is_primary, member.staff.last_name, member.staff.first_name),
    )
    staff_ids = dict.fromkeys([member.staff_id for member in care_team] + list(conversations))
    partners: list[tuple[StaffMember, Conversation | None]] = []
    for staff_id in staff_ids:
        staff = db.get_one(StaffMember, staff_id)
        if _can_message(db, staff, client):
            partners.append((staff, conversations.get(staff_id)))
    return partners


def care_team_clinician(client: Client, clinician_id: int) -> StaffMember | None:
    """An active clinician on the client's care team, or None."""
    for member in client.care_team:
        staff = member.staff
        if staff.id == clinician_id and staff.is_active and staff.is_clinician:
            return staff
    return None


def open_conversation(db: Session, clinician_id: int, client: Client) -> Conversation:
    """The conversation between a clinician and a client, created if it doesn't exist yet."""
    db.execute(
        insert(Conversation)
        .values(practice_id=client.practice_id, clinician_id=clinician_id, client_id=client.id)
        .on_conflict_do_nothing(index_elements=["clinician_id", "client_id"])
    )
    return db.scalars(
        select(Conversation).where(
            Conversation.clinician_id == clinician_id, Conversation.client_id == client.id
        )
    ).one()


# Sending


def _locked(db: Session, conversation_id: int) -> Conversation:
    """Reload the conversation holding a row lock on it until the transaction ends."""
    return db.scalars(
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()


def _resolve_attachments(
    db: Session, conversation: Conversation, file_ids: list[int], sender: StaffMember | None
) -> list[StoredFile]:
    """Files the sender uploaded for this client that haven't been sent yet (rows locked)."""
    if not file_ids:
        return []
    query = select(StoredFile).where(
        StoredFile.id.in_(file_ids),
        StoredFile.practice_id == conversation.practice_id,
        StoredFile.client_id == conversation.client_id,
        StoredFile.purpose == FilePurpose.MESSAGE_ATTACHMENT,
    )
    if sender is None:
        query = query.where(StoredFile.uploaded_by == Role.CLIENT)
    else:
        query = query.where(StoredFile.uploaded_by_staff_id == sender.id)
    files = db.scalars(query.with_for_update()).all()
    if len(files) != len(file_ids):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "One or more attachments weren't found"
        )
    if db.scalar(select(exists().where(MessageAttachment.file_id.in_(file_ids)))):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "An attachment was already sent; upload it again"
        )
    by_id = {stored.id: stored for stored in files}
    return [by_id[file_id] for file_id in file_ids]


def _read_cycle(read_at: datetime | None) -> str:
    """Identifies the recipient's current unread period for one-notice-per-period dedupe."""
    return "never" if read_at is None else str(int(read_at.timestamp() * 1_000_000))


def _event_recipients(db: Session, conversation: Conversation, client: Client) -> list[Recipient]:
    """The client and every active staff member who can read the conversation."""
    readers = [
        member
        for member in active_staff(db, client.practice_id)
        if can_read_conversation(Access(db, member), conversation, client)
    ]
    return [(Role.CLIENT, client.id), *as_recipients(readers)]


def _publish_message(
    db: Session,
    recipients: list[Recipient],
    conversation: Conversation,
    message: Message,
    event: str,
) -> None:
    publish(
        db,
        recipients,
        event,
        {
            "conversation_id": conversation.id,
            "client_id": conversation.client_id,
            "message_id": message.id,
        },
    )


def _add_message(
    db: Session,
    conversation: Conversation,
    recipients: list[Recipient],
    *,
    sender_role: Role,
    body: str,
    now: datetime,
    sender_staff_id: int | None = None,
    sender_contact_id: int | None = None,
    risk_level: RiskLevel = RiskLevel.NONE,
    files: list[StoredFile] | None = None,
    is_automatic: bool = False,
) -> Message:
    message = Message(
        conversation_id=conversation.id,
        sender_role=sender_role,
        sender_staff_id=sender_staff_id,
        sender_contact_id=sender_contact_id,
        body=body,
        risk_level=risk_level,
        is_automatic=is_automatic,
        created_at=now,
        attachments=[MessageAttachment(file=stored) for stored in files or []],
    )
    db.add(message)
    db.flush()
    conversation.last_message_at = now
    _publish_message(db, recipients, conversation, message, "message.created")
    return message


def _urgent_recipients(
    db: Session, conversation: Conversation, client: Client, clinician: StaffMember
) -> list[StaffMember]:
    """The conversation's clinician, plus their supervisor if the supervisor can read it."""
    if clinician.supervisor_id is None:
        return [clinician]
    supervisor = db.get_one(StaffMember, clinician.supervisor_id)
    if supervisor.is_active and can_read_conversation(Access(db, supervisor), conversation, client):
        return [clinician, supervisor]
    return [clinician]


def _alert_staff(
    db: Session,
    conversation: Conversation,
    client: Client,
    clinician: StaffMember,
    message: Message,
    now: datetime,
) -> None:
    """Tell the conversation's clinician about a new client message.

    A message with crisis language is flagged to the clinician and their supervisor in the
    app and emailed to the clinician right away. Otherwise the clinician gets an in-app
    notification, and an email later if it's still unread and they want message emails.
    """
    path = staff_conversation_path(conversation.id)
    name = short_name(client)
    if message.risk_level == RiskLevel.HIGH:
        for member in _urgent_recipients(db, conversation, client, clinician):
            notify(
                db,
                Role.STAFF,
                member.id,
                kind=KIND_URGENT_MESSAGE,
                title=f"A message from {name} may need urgent attention",
                body="Review this conversation as soon as you can.",
                link=path,
                urgent=True,
            )
        queue_staff_email(
            db,
            clinician,
            subject="A client message may need urgent attention",
            heading="A client message may need urgent attention",
            paragraphs=[
                "A new secure message from a client contains language that may indicate "
                "a crisis. Please review it as soon as you can.",
                "For privacy, the message isn't included in this email.",
            ],
            button_label="Open messages",
            app_path=path,
            dedupe_key=f"msg-urgent-{message.id}",
        )
        return
    notify(
        db,
        Role.STAFF,
        clinician.id,
        kind=KIND_MESSAGE,
        title=f"New message from {name}",
        link=path,
    )
    if not clinician.notify_email_messages:
        return
    queue_staff_email(
        db,
        clinician,
        subject="You have a new secure message",
        heading="You have a new secure message",
        paragraphs=[
            "A client sent you a secure message. Sign in to read and reply.",
            "For privacy, the message isn't included in this email.",
        ],
        button_label="Open messages",
        app_path=path,
        dedupe_key=(
            f"msg-notice-clinician-{conversation.id}-{_read_cycle(conversation.clinician_read_at)}"
        ),
        send_after=now + NOTICE_DELAY,
        condition_kind=CONDITION_CLINICIAN_UNREAD_MESSAGE,
        condition_ref=message.id,
    )


def _alert_client(
    db: Session,
    conversation: Conversation,
    client: Client,
    sender: StaffMember,
    message: Message,
    now: datetime,
) -> None:
    """In-app notification plus a delayed email notice for a new message from staff.

    The email goes to the client and to their contacts with portal access, once per unread
    period each.
    """
    path = client_conversation_path(conversation.id)
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind=KIND_MESSAGE,
        title=f"New message from {sender.display_name}",
        link=path,
    )
    dedupe_key = f"msg-notice-client-{conversation.id}-{_read_cycle(conversation.client_read_at)}"
    queue_portal_email(
        db,
        client,
        subject=f"New secure message from {client.practice.name}",
        heading="You have a new secure message",
        paragraphs=[
            f"{sender.display_name} sent you a secure message in your client portal.",
            "For privacy, the message isn't included in this email.",
        ],
        button_label="Read message",
        next_path=path,
        dedupe_key=dedupe_key,
        send_after=now + NOTICE_DELAY,
        condition_kind=CONDITION_CLIENT_UNREAD_MESSAGE,
        condition_ref=message.id,
    )


def _maybe_send_away_reply(
    db: Session,
    conversation: Conversation,
    recipients: list[Recipient],
    clinician: StaffMember,
    now: datetime,
) -> None:
    away_message = active_away_message(clinician)
    if away_message is None:
        return
    last_reply = conversation.away_reply_sent_at
    if last_reply is not None and now - last_reply < AWAY_REPLY_INTERVAL:
        return
    _add_message(
        db,
        conversation,
        recipients,
        sender_role=Role.STAFF,
        body=away_message,
        now=now,
        is_automatic=True,
    )
    conversation.away_reply_sent_at = now


def send_message(
    db: Session,
    conversation: Conversation,
    client: Client,
    *,
    sender: StaffMember | None,
    body: str,
    attachment_ids: list[int],
    now: datetime,
    sender_contact: ClientContact | None = None,
) -> Message:
    """Post a message in a conversation and alert the other side (caller commits).

    `sender` is the staff member writing, or None when the client writes (`sender_contact`
    when one of their contacts writes for them). Client messages are screened for crisis
    language, alert the conversation's clinician and may trigger their away reply. Staff
    messages notify the client.
    """
    conversation = _locked(db, conversation.id)
    files = _resolve_attachments(db, conversation, attachment_ids, sender)
    recipients = _event_recipients(db, conversation, client)
    if sender is not None:
        message = _add_message(
            db,
            conversation,
            recipients,
            sender_role=Role.STAFF,
            sender_staff_id=sender.id,
            body=body,
            now=now,
            files=files,
        )
        _alert_client(db, conversation, client, sender, message, now)
        return message
    message = _add_message(
        db,
        conversation,
        recipients,
        sender_role=Role.CLIENT,
        sender_contact_id=sender_contact.id if sender_contact is not None else None,
        body=body,
        now=now,
        risk_level=assess_risk(body),
        files=files,
    )
    clinician = db.get_one(StaffMember, conversation.clinician_id)
    _alert_staff(db, conversation, client, clinician, message, now)
    _maybe_send_away_reply(db, conversation, recipients, clinician, now)
    return message


def list_messages(
    db: Session, conversation_id: int, *, before_id: int | None, limit: int
) -> list[Message]:
    """Up to `limit` messages older than `before_id` (or the newest), oldest first."""
    query = select(Message).where(Message.conversation_id == conversation_id)
    if before_id is not None:
        query = query.where(Message.id < before_id)
    newest_first = db.scalars(query.order_by(Message.id.desc()).limit(limit)).all()
    return list(reversed(newest_first))


# Read markers and removal


def _publish_read(
    db: Session, conversation: Conversation, client: Client, reader_role: Role, now: datetime
) -> None:
    # The other side gets a read receipt; the reader's other tabs and devices clear badges.
    publish(
        db,
        _event_recipients(db, conversation, client),
        "conversation.read",
        {
            "conversation_id": conversation.id,
            "client_id": conversation.client_id,
            "reader_role": reader_role,
            "read_at": now.isoformat(),
        },
    )


def mark_read_by_client(
    db: Session, conversation: Conversation, client: Client, now: datetime
) -> None:
    """Record that the client has seen the conversation and tell everyone following it."""
    conversation.client_read_at = now
    # Reading the thread clears its "new message" notifications.
    mark_all_read(
        db,
        Role.CLIENT,
        client.id,
        kind=KIND_MESSAGE,
        link=client_conversation_path(conversation.id),
    )
    _publish_read(db, conversation, client, Role.CLIENT, now)


def mark_read_by_staff(
    db: Session, conversation: Conversation, client: Client, staff: StaffMember, now: datetime
) -> None:
    """Record that the conversation's clinician has seen it; anyone else reading changes nothing."""
    if staff.id != conversation.clinician_id:
        return
    conversation.clinician_read_at = now
    # Reading the thread clears its "new message" notifications; urgent ones stay until opened.
    mark_all_read(
        db,
        Role.STAFF,
        staff.id,
        kind=KIND_MESSAGE,
        link=staff_conversation_path(conversation.id),
    )
    _publish_read(db, conversation, client, Role.STAFF, now)


def _wrote(
    message: Message,
    conversation: Conversation,
    staff: StaffMember | None,
    contact: ClientContact | None,
) -> bool:
    """Whether the staff member wrote the message or, for None, the client (or `contact`).

    Automatic away replies count as written by the conversation's clinician.
    """
    if staff is None:
        contact_id = contact.id if contact is not None else None
        return message.sender_role == Role.CLIENT and message.sender_contact_id == contact_id
    if message.is_automatic:
        return conversation.clinician_id == staff.id
    return message.sender_staff_id == staff.id


def remove_message(
    db: Session,
    conversation: Conversation,
    client: Client,
    message: Message,
    *,
    remover: StaffMember | None,
    now: datetime,
    remover_contact: ClientContact | None = None,
) -> None:
    """Hide a message for everyone; only whoever wrote it may remove it. The row is kept.

    `remover` is the staff member removing it, or None for the client (`remover_contact` when
    one of their contacts is signed in).
    """
    if not _wrote(message, conversation, remover, remover_contact):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only remove messages you sent")
    if message.removed_at is not None:
        return
    message.removed_at = now
    recipients = _event_recipients(db, conversation, client)
    _publish_message(db, recipients, conversation, message, "message.removed")


# Unread counts, previews and crisis flags


def _unread_condition(reader_role: Role) -> ColumnElement[bool]:
    """Messages the conversation's clinician (STAFF) or client (CLIENT) hasn't read yet."""
    if reader_role == Role.STAFF:
        sender, read_at = Role.CLIENT, Conversation.clinician_read_at
    else:
        sender, read_at = Role.STAFF, Conversation.client_read_at
    return and_(
        Message.sender_role == sender,
        Message.removed_at.is_(None),
        or_(read_at.is_(None), Message.created_at > read_at),
    )


def unread_counts(db: Session, conversation_ids: list[int], reader_role: Role) -> dict[int, int]:
    """Unread messages per conversation for its clinician (STAFF) or its client (CLIENT)."""
    if not conversation_ids:
        return {}
    rows = db.execute(
        select(Message.conversation_id, func.count(Message.id))
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Message.conversation_id.in_(conversation_ids), _unread_condition(reader_role))
        .group_by(Message.conversation_id)
    )
    return {conversation_id: count for conversation_id, count in rows}


def unread_by_conversation(db: Session, staff_id: int) -> dict[int, int]:
    """Unread client messages per conversation in a staff member's own conversations.

    Only clients whose chart they can still see count, so the badge matches their inbox.
    """
    access = Access(db, db.get_one(StaffMember, staff_id))
    rows = db.execute(
        select(Message.conversation_id, func.count(Message.id))
        .join(Conversation, Conversation.id == Message.conversation_id)
        .join(Client, Client.id == Conversation.client_id)
        .where(
            Conversation.clinician_id == staff_id,
            access.client_filter(ClientAccess.CLINICAL),
            _unread_condition(Role.STAFF),
        )
        .group_by(Message.conversation_id)
    )
    return {conversation_id: count for conversation_id, count in rows}


def latest_previews(db: Session, conversation_ids: list[int]) -> dict[int, str]:
    """Start of each conversation's newest message, or a label for removed/attachment-only ones."""
    if not conversation_ids:
        return {}
    newest_ids = (
        select(func.max(Message.id))
        .where(Message.conversation_id.in_(conversation_ids))
        .group_by(Message.conversation_id)
    )
    has_attachment = exists().where(MessageAttachment.message_id == Message.id)
    rows = db.execute(
        select(Message.conversation_id, Message.body, Message.removed_at, has_attachment).where(
            Message.id.in_(newest_ids)
        )
    )
    previews: dict[int, str] = {}
    for conversation_id, body, removed_at, attached in rows:
        if removed_at is not None:
            previews[conversation_id] = "Message removed"
        elif not body.strip() and attached:
            previews[conversation_id] = "Attachment"
        else:
            previews[conversation_id] = body[:PREVIEW_LENGTH]
    return previews


def urgent_conversations(db: Session, conversation_ids: list[int]) -> set[int]:
    """Which conversations have a client message flagged for crisis language that its
    clinician hasn't read."""
    if not conversation_ids:
        return set()
    rows = db.scalars(
        select(Message.conversation_id)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Message.conversation_id.in_(conversation_ids),
            _unread_condition(Role.STAFF),
            Message.risk_level.in_((RiskLevel.HIGH, RiskLevel.MODERATE)),
        )
        .distinct()
    )
    return set(rows)
