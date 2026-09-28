"""Transactional outbox for email and SMS.

Features queue messages inside their own database transaction; the worker delivers them
with retries. A queued message can carry a condition that is re-checked at send time.
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from synari.models import Conversation, Message, OutboundMessage
from synari.models.enums import OutboundChannel, OutboundStatus, Role
from synari.services.delivery import DeliveryError, send_email, send_sms
from synari.services.email_templates import EmailContent

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
BATCH_SIZE = 50
# Finished messages keep their envelope (recipient, status, times) for troubleshooting, but
# their content is cleared after this long: bodies hold sign-in links and subjects can name a
# client ("Sign in to view Alex's portal").
CONTENT_RETENTION = timedelta(days=7)

# Condition kinds re-checked when a queued message becomes due.
CONDITION_CLINICIAN_UNREAD_MESSAGE = "clinician_unread_message"
CONDITION_CLIENT_UNREAD_MESSAGE = "client_unread_message"


def _queue(db: Session, values: dict[str, object]) -> None:
    statement = insert(OutboundMessage).values(**values)
    if values.get("dedupe_key"):
        statement = statement.on_conflict_do_nothing(index_elements=["dedupe_key"])
    db.execute(statement)


def queue_email(
    db: Session,
    *,
    to: str,
    content: EmailContent,
    practice_id: int | None = None,
    dedupe_key: str | None = None,
    send_after: datetime | None = None,
    condition_kind: str | None = None,
    condition_ref: int | None = None,
) -> None:
    """Queue an email. A repeated dedupe_key is ignored, making reminders idempotent."""
    values: dict[str, object] = {
        "channel": OutboundChannel.EMAIL,
        "to_address": to,
        "subject": content.subject,
        "body_text": content.text,
        "body_html": content.html,
        "practice_id": practice_id,
        "dedupe_key": dedupe_key,
        "condition_kind": condition_kind,
        "condition_ref": condition_ref,
    }
    if send_after is not None:
        values["send_after"] = send_after
    _queue(db, values)


def queue_sms(
    db: Session,
    *,
    to: str,
    body: str,
    practice_id: int | None = None,
    dedupe_key: str | None = None,
) -> None:
    """Queue an SMS (callers must have checked the client's SMS consent)."""
    _queue(
        db,
        {
            "channel": OutboundChannel.SMS,
            "to_address": to,
            "body_text": body,
            "practice_id": practice_id,
            "dedupe_key": dedupe_key,
        },
    )


def _message_still_unread(db: Session, message_id: int, reader: Role) -> bool:
    message = db.get(Message, message_id)
    if message is None or message.removed_at is not None:
        return False
    conversation = db.get(Conversation, message.conversation_id)
    if conversation is None:
        return False
    read_at = (
        conversation.clinician_read_at if reader == Role.STAFF else conversation.client_read_at
    )
    return read_at is None or read_at < message.created_at


def _condition_holds(db: Session, message: OutboundMessage) -> bool:
    if message.condition_kind is None or message.condition_ref is None:
        return True
    if message.condition_kind == CONDITION_CLINICIAN_UNREAD_MESSAGE:
        return _message_still_unread(db, message.condition_ref, Role.STAFF)
    if message.condition_kind == CONDITION_CLIENT_UNREAD_MESSAGE:
        return _message_still_unread(db, message.condition_ref, Role.CLIENT)
    logger.error("Unknown outbox condition %s", message.condition_kind)
    return False


def _deliver(message: OutboundMessage) -> None:
    if message.channel == OutboundChannel.EMAIL:
        send_email(message.to_address, message.subject, message.body_text, message.body_html)
    else:
        send_sms(message.to_address, message.body_text)


def deliver_outbound(db: Session, now: datetime) -> None:
    """Worker job: send due messages, retrying failures with exponential backoff."""
    due = db.scalars(
        select(OutboundMessage)
        .where(OutboundMessage.status == OutboundStatus.PENDING, OutboundMessage.send_after <= now)
        .order_by(OutboundMessage.id)
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    ).all()
    for message in due:
        if not _condition_holds(db, message):
            message.status = OutboundStatus.CANCELED
            continue
        try:
            _deliver(message)
        except DeliveryError as exc:
            message.attempts += 1
            message.last_error = str(exc)[:1000]
            if message.attempts >= MAX_ATTEMPTS:
                message.status = OutboundStatus.FAILED
                logger.warning("Giving up on outbound %s %s: %s", message.channel, message.id, exc)
            else:
                message.send_after = now + timedelta(minutes=2**message.attempts)
            continue
        message.status = OutboundStatus.SENT
        message.sent_at = now
    db.commit()


def purge_outbound_content(db: Session, now: datetime) -> None:
    """Worker job: clear the subject and body of messages finished over CONTENT_RETENTION ago.

    Failed and canceled messages have no sent_at; their last scheduled attempt stands in.
    """
    db.execute(
        update(OutboundMessage)
        .where(
            OutboundMessage.status.in_(
                [OutboundStatus.SENT, OutboundStatus.FAILED, OutboundStatus.CANCELED]
            ),
            func.coalesce(OutboundMessage.sent_at, OutboundMessage.send_after)
            < now - CONTENT_RETENTION,
            or_(
                OutboundMessage.subject != "",
                OutboundMessage.body_text != "",
                OutboundMessage.body_html.is_not(None),
            ),
        )
        .values(subject="", body_text="", body_html=None)
    )
    db.commit()
