"""Worker job: write each clinician's appointments into the Synari calendar of every account
they connected.

Events carry no clinical content: "Appointment" (or "Busy" for a non-client event), the times,
private visibility and nothing else. No description, location, attendees or video link, so the
provider never emails anyone. Client initials are added only when the practice turns
`calendar_include_initials` on (after confirming each connected account is covered by a BAA).
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    CalendarConnection,
    CalendarEventLink,
    StaffMember,
)
from synari.models.enums import AppointmentKind, AppointmentStatus, StaffStatus
from synari.services.calendar_sync.connections import (
    WORKING_STATUSES,
    CalendarApi,
    LinkState,
    access_token_for,
    calendar_api,
    connection_failed,
    enabled_providers,
    forget_access_token,
    is_due,
    record_failure,
    reset_events,
)
from synari.services.calendar_sync.hooks import requeue, should_sync
from synari.services.calendar_sync.providers import ErrorKind, EventPayload, ProviderError

logger = logging.getLogger(__name__)

APPOINTMENT_TITLE = "Appointment"
EVENT_TITLE = "Busy"
MAX_INITIALS = 3
CONNECTIONS_PER_RUN = 20
LINKS_PER_CONNECTION = 50
MAX_ATTEMPTS = 8
FIRST_RETRY = timedelta(minutes=1)
MAX_RETRY = timedelta(hours=6)
_LEFT_SESSION = (AppointmentStatus.CANCELED, AppointmentStatus.LATE_CANCELED)


def _initials(participant: AppointmentParticipant) -> str:
    client = participant.client
    return "".join(f"{name[:1].upper()}." for name in (client.first_name, client.last_name) if name)


def event_title(appointment: Appointment, include_initials: bool) -> str:
    """'Appointment', 'Appointment (A.R.)' with initials on, or 'Busy' for an event."""
    if appointment.kind == AppointmentKind.EVENT:
        return EVENT_TITLE
    attending = [p for p in appointment.participants if p.attendance not in _LEFT_SESSION]
    if not include_initials or not attending:
        return APPOINTMENT_TITLE
    initials = ", ".join(_initials(p) for p in attending[:MAX_INITIALS])
    more = len(attending) - MAX_INITIALS
    return f"{APPOINTMENT_TITLE} ({initials}{f' +{more}' if more > 0 else ''})"


def event_payload(appointment: Appointment, include_initials: bool) -> EventPayload:
    """What the connected calendar shows for the appointment."""
    return EventPayload(
        appointment_id=appointment.id,
        title=event_title(appointment, include_initials),
        starts_at=appointment.starts_at,
        ends_at=appointment.ends_at,
        tentative=appointment.status == AppointmentStatus.REQUESTED,
    )


def _retry_later(link: CalendarEventLink, error: ProviderError, now: datetime) -> None:
    """Back off exponentially (at least as long as the provider asked); give up eventually."""
    link.attempts += 1
    link.last_error = str(error)
    retryable = error.kind in (ErrorKind.TRANSIENT, ErrorKind.UNAUTHORIZED)
    if not retryable or link.attempts >= MAX_ATTEMPTS:
        link.state = LinkState.FAILED
        link.next_attempt_at = None
        return
    delay = min(FIRST_RETRY * 2 ** (link.attempts - 1), MAX_RETRY)
    link.next_attempt_at = now + max(delay, error.retry_after or timedelta(0))


def _create(
    api: CalendarApi,
    token: str,
    connection: CalendarConnection,
    link: CalendarEventLink,
    event: EventPayload,
) -> None:
    key = api.create_key(connection.id, event.appointment_id, link.generation)
    if api.client_assigned_ids:
        # Known before the call, so the event can be removed even if the answer is lost.
        link.external_event_id = key
    link.external_event_id = api.create_event(token, connection.write_calendar_id, event, key)


def _push_link(
    db: Session,
    api: CalendarApi,
    token: str,
    connection: CalendarConnection,
    link: CalendarEventLink,
    include_initials: bool,
) -> None:
    """Bring one event in line with its appointment: create, update or delete it."""
    appointment = db.get(Appointment, link.appointment_id) if link.appointment_id else None
    if (
        link.state == LinkState.DELETING
        or appointment is None
        or not should_sync(appointment)
        or appointment.clinician_id != connection.staff_id
    ):
        if link.external_event_id:
            api.delete_event(token, connection.write_calendar_id, link.external_event_id)
        db.delete(link)
        return
    event = event_payload(appointment, include_initials)
    digest = event.digest()
    if link.payload_hash != digest:
        if not link.payload_hash:
            _create(api, token, connection, link, event)
        else:
            try:
                api.update_event(token, connection.write_calendar_id, link.external_event_id, event)
            except ProviderError as exc:
                if exc.kind != ErrorKind.NOT_FOUND:
                    raise
                # Deleted in the calendar app: create it again (as a new event for Microsoft).
                link.generation += 1
                _create(api, token, connection, link, event)
        link.payload_hash = digest
    requeue(link, LinkState.SYNCED)


def _recreate_calendar(
    db: Session, api: CalendarApi, token: str, connection: CalendarConnection, now: datetime
) -> None:
    """The Synari calendar was deleted in the account: make a new one and push everything to
    it again on the next run."""
    db.flush()
    try:
        connection.write_calendar_id = api.ensure_calendar(token, "")
    except ProviderError as exc:
        connection_failed(db, connection, exc, now)
        return
    reset_events(db, connection)
    logger.info("Recreated the Synari calendar for calendar connection %s", connection.id)


def _push_connection(db: Session, connection: CalendarConnection, now: datetime) -> None:
    links = db.scalars(
        select(CalendarEventLink)
        .where(
            CalendarEventLink.connection_id == connection.id,
            CalendarEventLink.state.in_((LinkState.PENDING, LinkState.DELETING)),
            or_(
                CalendarEventLink.next_attempt_at.is_(None),
                CalendarEventLink.next_attempt_at <= now,
            ),
        )
        .order_by(CalendarEventLink.id)
        .limit(LINKS_PER_CONNECTION)
        .with_for_update(skip_locked=True)
    ).all()
    if not links:
        return
    staff = db.get_one(StaffMember, connection.staff_id)
    include_initials = staff.practice.settings.calendar_include_initials
    with calendar_api(connection.provider) as api:
        try:
            token = access_token_for(connection, api, now)
        except ProviderError as exc:
            connection_failed(db, connection, exc, now)
            return
        for link in links:
            try:
                _push_link(db, api, token, connection, link, include_initials)
            except ProviderError as exc:
                if exc.kind == ErrorKind.NOT_FOUND:
                    # Only creating into a calendar that no longer exists gets here.
                    _recreate_calendar(db, api, token, connection, now)
                    return
                _retry_later(link, exc, now)
                if exc.kind == ErrorKind.UNAUTHORIZED:
                    forget_access_token(connection)
                    record_failure(connection, str(exc), now)
                    return
                if exc.kind == ErrorKind.TRANSIENT:
                    return  # throttled or down: leave the rest for a later run


def sync_calendar_events(db: Session, now: datetime) -> None:
    """Worker job: create, update and delete events for queued appointment changes."""
    connection_ids = db.scalars(
        select(CalendarEventLink.connection_id)
        .join(CalendarConnection, CalendarConnection.id == CalendarEventLink.connection_id)
        .join(StaffMember, StaffMember.id == CalendarConnection.staff_id)
        .where(
            CalendarEventLink.state.in_((LinkState.PENDING, LinkState.DELETING)),
            or_(
                CalendarEventLink.next_attempt_at.is_(None),
                CalendarEventLink.next_attempt_at <= now,
            ),
            CalendarConnection.status.in_(WORKING_STATUSES),
            CalendarConnection.provider.in_(enabled_providers()),
            StaffMember.status == StaffStatus.ACTIVE,
        )
        .distinct()
        .limit(CONNECTIONS_PER_RUN)
    ).all()
    for connection_id in connection_ids:
        connection = db.scalar(
            select(CalendarConnection)
            .where(
                CalendarConnection.id == connection_id,
                CalendarConnection.status.in_(WORKING_STATUSES),
            )
            .with_for_update(skip_locked=True)
        )
        if connection is not None and is_due(connection, now):
            _push_connection(db, connection, now)
        db.commit()
