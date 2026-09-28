"""Queue appointments for calendar sync. Every code path that creates, changes, cancels or
deletes an appointment calls `appointment_changed` before committing (after `db.delete()` for a
deletion). Nothing here calls a provider: the worker (push.py) does, with retries.
"""

from datetime import datetime, timedelta

from sqlalchemy import inspect, select, update
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Appointment, CalendarConnection, CalendarEventLink, StaffMember
from synari.models.enums import AppointmentStatus, BookingSource, CalendarConnectionStatus
from synari.services.calendar_sync.connections import LinkState

# Appointments synced when a calendar is connected: from a week ago through the next year.
SYNC_PAST = timedelta(days=7)
SYNC_FUTURE = timedelta(days=365)
REMOVED_STATUSES = (
    AppointmentStatus.CANCELED,
    AppointmentStatus.LATE_CANCELED,
    AppointmentStatus.DECLINED,
)


def should_sync(appointment: Appointment) -> bool:
    """Whether the appointment belongs in its clinician's connected calendars: never imported
    history, and not once it's canceled or declined."""
    return appointment.source != BookingSource.IMPORT and appointment.status not in REMOVED_STATUSES


def requeue(link: CalendarEventLink, state: LinkState = LinkState.PENDING) -> None:
    """Hand the link back to the worker, retrying from scratch."""
    link.state = state
    link.attempts = 0
    link.next_attempt_at = None
    link.last_error = ""


def unlink(db: Session, link: CalendarEventLink) -> None:
    """Remove the event from its calendar, or just forget the link when no event exists."""
    if link.external_event_id:
        requeue(link, LinkState.DELETING)
    else:
        db.delete(link)


def _is_deleted(db: Session, appointment: Appointment) -> bool:
    return appointment in db.deleted or inspect(appointment).deleted


def appointment_changed(db: Session, appointment: Appointment) -> None:
    """Mark the appointment's events in connected calendars for creation, update or removal
    (the caller commits). Moving it to another clinician moves it between their calendars."""
    wanted = not _is_deleted(db, appointment) and should_sync(appointment)
    connections = (
        list(
            db.scalars(
                select(CalendarConnection).where(
                    CalendarConnection.staff_id == appointment.clinician_id,
                    CalendarConnection.status != CalendarConnectionStatus.DISCONNECTED,
                )
            )
        )
        if wanted
        else []
    )
    owned = {connection.id for connection in connections}
    linked: set[int] = set()
    for link in db.scalars(
        select(CalendarEventLink).where(CalendarEventLink.appointment_id == appointment.id)
    ):
        linked.add(link.connection_id)
        if link.connection_id in owned:
            requeue(link)
        else:
            unlink(db, link)
    if appointment.ends_at >= utcnow() - SYNC_PAST:
        db.add_all(
            CalendarEventLink(
                connection_id=connection.id,
                appointment_id=appointment.id,
                state=LinkState.PENDING,
            )
            for connection in connections
            if connection.id not in linked
        )
    db.flush()


def queue_upcoming(db: Session, connection: CalendarConnection, now: datetime) -> None:
    """Queue the clinician's appointments from a week ago through the next year for a newly
    (re)connected calendar or "Sync now", including ones that failed before."""
    links = {
        link.appointment_id: link
        for link in db.scalars(
            select(CalendarEventLink).where(CalendarEventLink.connection_id == connection.id)
        )
    }
    for link in links.values():
        if link.state == LinkState.FAILED:
            requeue(link, LinkState.DELETING if link.appointment_id is None else LinkState.PENDING)
    appointments = db.scalars(
        select(Appointment).where(
            Appointment.clinician_id == connection.staff_id,
            Appointment.ends_at >= now - SYNC_PAST,
            Appointment.starts_at <= now + SYNC_FUTURE,
            Appointment.source != BookingSource.IMPORT,
            Appointment.status.not_in(REMOVED_STATUSES),
        )
    )
    for appointment in appointments:
        link = links.get(appointment.id)
        if link is None:
            db.add(
                CalendarEventLink(
                    connection_id=connection.id,
                    appointment_id=appointment.id,
                    state=LinkState.PENDING,
                )
            )
        elif link.state == LinkState.SYNCED:
            requeue(link)
    db.flush()


def requeue_practice(db: Session, practice_id: int) -> None:
    """Re-check every synced event in the practice (e.g. after event titles changed)."""
    connection_ids = (
        select(CalendarConnection.id)
        .join(StaffMember, StaffMember.id == CalendarConnection.staff_id)
        .where(StaffMember.practice_id == practice_id)
    )
    db.execute(
        update(CalendarEventLink)
        .where(
            CalendarEventLink.connection_id.in_(connection_ids),
            CalendarEventLink.state.in_((LinkState.SYNCED, LinkState.FAILED)),
            CalendarEventLink.appointment_id.is_not(None),
        )
        .values(state=LinkState.PENDING, attempts=0, next_attempt_at=None, last_error="")
    )
