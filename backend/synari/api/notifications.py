"""In-app notifications (the bell) for staff and, under /portal, for clients."""

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.deps import CurrentClient, CurrentStaff, DbSession
from synari.models import Notification
from synari.models.enums import Role
from synari.schemas.messaging import MarkedRead, NotificationOut, UnreadCount
from synari.services import notifications

router = APIRouter(tags=["notifications"])

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


def _mark_one_read(
    db: Session, recipient_role: Role, recipient_id: int, notification_id: int
) -> Notification:
    notification = notifications.get_notification(db, recipient_role, recipient_id, notification_id)
    if notification is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    if notification.read_at is None:
        notification.read_at = utcnow()
        db.commit()
    return notification


# Staff routes


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(
    staff: CurrentStaff,
    db: DbSession,
    unread_only: bool = Query(default=False),
    before_id: int | None = Query(default=None, description="Return notifications older than this"),
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> list[Notification]:
    """Your notifications, newest first."""
    return notifications.list_notifications(
        db, Role.STAFF, staff.id, unread_only=unread_only, before_id=before_id, limit=limit
    )


@router.post("/notifications/read-all", response_model=MarkedRead)
def mark_all_notifications_read(staff: CurrentStaff, db: DbSession) -> MarkedRead:
    """Mark every notification read."""
    count = notifications.mark_all_read(db, Role.STAFF, staff.id)
    db.commit()
    return MarkedRead(marked_read=count)


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
def mark_notification_read(
    notification_id: int, staff: CurrentStaff, db: DbSession
) -> Notification:
    """Mark one notification read."""
    return _mark_one_read(db, Role.STAFF, staff.id, notification_id)


@router.get("/notifications/unread-count", response_model=UnreadCount)
def notifications_unread_count(staff: CurrentStaff, db: DbSession) -> UnreadCount:
    """Unread notifications (for the bell badge)."""
    return UnreadCount(count=notifications.unread_count(db, Role.STAFF, staff.id))


# Client portal routes


@router.get("/portal/notifications", response_model=list[NotificationOut])
def portal_list_notifications(
    client: CurrentClient,
    db: DbSession,
    unread_only: bool = Query(default=False),
    before_id: int | None = Query(default=None, description="Return notifications older than this"),
    limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> list[Notification]:
    """The client's notifications, newest first."""
    return notifications.list_notifications(
        db, Role.CLIENT, client.id, unread_only=unread_only, before_id=before_id, limit=limit
    )


@router.post("/portal/notifications/read-all", response_model=MarkedRead)
def portal_mark_all_notifications_read(client: CurrentClient, db: DbSession) -> MarkedRead:
    """Mark every notification read."""
    count = notifications.mark_all_read(db, Role.CLIENT, client.id)
    db.commit()
    return MarkedRead(marked_read=count)


@router.post("/portal/notifications/{notification_id}/read", response_model=NotificationOut)
def portal_mark_notification_read(
    notification_id: int, client: CurrentClient, db: DbSession
) -> Notification:
    """Mark one notification read."""
    return _mark_one_read(db, Role.CLIENT, client.id, notification_id)


@router.get("/portal/notifications/unread-count", response_model=UnreadCount)
def portal_notifications_unread_count(client: CurrentClient, db: DbSession) -> UnreadCount:
    """Unread notifications (for the portal's bell badge)."""
    return UnreadCount(count=notifications.unread_count(db, Role.CLIENT, client.id))
