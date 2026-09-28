"""In-app notifications for staff and clients.

Titles and bodies never contain clinical content (e.g. "New message from Alex R.", never the
message itself). Each new notification is pushed to the recipient as "notification.created".
"""

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Client, Notification
from synari.models.enums import Role
from synari.realtime import publish

TITLE_MAX_LENGTH = 200
LINK_MAX_LENGTH = 300


def short_name(client: Client) -> str:
    """'Alex R.' — enough to recognize a client without spelling out their full name."""
    initial = f" {client.last_name[:1]}." if client.last_name else ""
    return f"{client.display_first_name}{initial}"


def notify(
    db: Session,
    recipient_role: Role,
    recipient_id: int,
    *,
    kind: str,
    title: str,
    body: str = "",
    link: str = "",
    urgent: bool = False,
) -> Notification:
    """Add an in-app notification and publish it to the recipient (caller commits)."""
    notification = Notification(
        recipient_role=recipient_role,
        recipient_id=recipient_id,
        kind=kind,
        title=title[:TITLE_MAX_LENGTH],
        body=body,
        link=link[:LINK_MAX_LENGTH],
        urgent=urgent,
    )
    db.add(notification)
    db.flush()
    publish(
        db,
        [(recipient_role, recipient_id)],
        "notification.created",
        {"notification_id": notification.id},
    )
    return notification


def list_notifications(
    db: Session,
    recipient_role: Role,
    recipient_id: int,
    *,
    unread_only: bool,
    before_id: int | None,
    limit: int,
) -> list[Notification]:
    """The recipient's notifications, newest first."""
    query = select(Notification).where(
        Notification.recipient_role == recipient_role, Notification.recipient_id == recipient_id
    )
    if unread_only:
        query = query.where(Notification.read_at.is_(None))
    if before_id is not None:
        query = query.where(Notification.id < before_id)
    return list(db.scalars(query.order_by(Notification.id.desc()).limit(limit)))


def get_notification(
    db: Session, recipient_role: Role, recipient_id: int, notification_id: int
) -> Notification | None:
    """One notification, only if it belongs to the recipient."""
    notification = db.get(Notification, notification_id)
    if notification is None:
        return None
    if notification.recipient_role != recipient_role or notification.recipient_id != recipient_id:
        return None
    return notification


def mark_all_read(
    db: Session,
    recipient_role: Role,
    recipient_id: int,
    *,
    kind: str | None = None,
    link: str | None = None,
) -> int:
    """Mark the recipient's unread notifications read, optionally only one kind/link."""
    statement = update(Notification).where(
        Notification.recipient_role == recipient_role,
        Notification.recipient_id == recipient_id,
        Notification.read_at.is_(None),
    )
    if kind is not None:
        statement = statement.where(Notification.kind == kind)
    if link is not None:
        statement = statement.where(Notification.link == link)
    result = db.execute(statement.values(read_at=utcnow()))
    return result.rowcount


def unread_count(db: Session, recipient_role: Role, recipient_id: int) -> int:
    """How many of the recipient's notifications are unread."""
    return (
        db.scalar(
            select(func.count(Notification.id)).where(
                Notification.recipient_role == recipient_role,
                Notification.recipient_id == recipient_id,
                Notification.read_at.is_(None),
            )
        )
        or 0
    )
