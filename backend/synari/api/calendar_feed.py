"""Private calendar subscription (ICS) so each staff member can see their own appointments and
events in other calendar apps."""

from datetime import timedelta
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from synari.audit import audit_staff
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentStaff, DbSession
from synari.models import Appointment, StaffMember
from synari.models.enums import ACTIVE_APPOINTMENT_STATUSES, BookingSource, StaffStatus
from synari.ratelimit import rate_limit
from synari.schemas.common import Schema
from synari.security import hash_opaque_token, new_opaque_token
from synari.services.ics import render_calendar

router = APIRouter(tags=["calendar feed"])

FEED_PAST = timedelta(days=30)
FEED_FUTURE = timedelta(days=365)


class FeedStatus(Schema):
    enabled: bool


class FeedCreated(Schema):
    url: str


@router.get("/me/calendar-feed", response_model=FeedStatus)
def feed_status(staff: CurrentStaff) -> FeedStatus:
    return FeedStatus(enabled=staff.calendar_feed_token_hash is not None)


@router.post("/me/calendar-feed", response_model=FeedCreated)
def create_feed(staff: CurrentStaff, db: DbSession, request: Request) -> FeedCreated:
    """Create (or replace) your private feed URL. Shown once; any previous URL stops working."""
    raw, token_hash = new_opaque_token()
    staff.calendar_feed_token_hash = token_hash
    audit_staff(db, request, staff, "account.calendar_feed_created")
    db.commit()
    base = str(request.base_url).rstrip("/")
    return FeedCreated(url=f"{base}/api/calendar-feed/{raw}.ics")


@router.delete("/me/calendar-feed", status_code=status.HTTP_204_NO_CONTENT)
def delete_feed(staff: CurrentStaff, db: DbSession, request: Request) -> None:
    staff.calendar_feed_token_hash = None
    audit_staff(db, request, staff, "account.calendar_feed_deleted")
    db.commit()


@router.get(
    "/calendar-feed/{token}.ics",
    response_class=Response,
    dependencies=[Depends(rate_limit("calendar-feed", limit=30))],
)
def calendar_feed(token: str, db: DbSession) -> Response:
    """The subscription feed of one person's calendar. Contains times only: never client names
    or other details."""
    staff = db.scalar(
        select(StaffMember).where(
            StaffMember.calendar_feed_token_hash == hash_opaque_token(token),
            StaffMember.status == StaffStatus.ACTIVE,
        )
    )
    if staff is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Calendar not found")
    now = utcnow()
    appointments = db.scalars(
        select(Appointment)
        .where(
            Appointment.clinician_id == staff.id,
            Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
            # Imported history isn't synced to calendars.
            Appointment.source != BookingSource.IMPORT,
            Appointment.ends_at >= now - FEED_PAST,
            Appointment.starts_at <= now + FEED_FUTURE,
        )
        .order_by(Appointment.starts_at)
    )
    host = urlparse(settings.frontend_url).hostname or "synari"
    return Response(
        content=render_calendar(appointments, host=host, now=now),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'inline; filename="synari.ics"'},
    )
