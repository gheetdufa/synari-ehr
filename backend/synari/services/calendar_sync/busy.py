"""Busy times from clinicians' own calendars (times only; titles are never read).

A worker job polls each connected account every CALENDAR_SYNC_INTERVAL_SECONDS for the booking
horizon and replaces the stored blocks. Online booking leaves those times out of the offered
slots and re-checks the provider right before taking a request; staff scheduling only warns.
Blocks stay after a connection needs reconnecting, so availability errs on the side of busy.
"""

import logging
from collections.abc import Collection, Sequence
from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import SessionLocal, utcnow
from synari.models import Appointment, CalendarConnection, ExternalBusyBlock, StaffMember
from synari.models.enums import (
    ACTIVE_APPOINTMENT_STATUSES,
    CalendarConnectionStatus,
    StaffStatus,
)
from synari.services.calendar_sync.connections import (
    WORKING_STATUSES,
    access_token_for,
    calendar_api,
    connection_failed,
    enabled_providers,
    is_due,
    mark_needs_reauth,
    record_success,
)
from synari.services.calendar_sync.providers import (
    PRIMARY_CALENDAR,
    ErrorKind,
    Interval,
    ProviderError,
)

logger = logging.getLogger(__name__)

# Busy times are fetched through the booking horizon, and at least this far ahead.
MIN_HORIZON_DAYS = 60
CONNECTIONS_PER_RUN = 50
LIVE_CHECK_TIMEOUT_SECONDS = 5.0


def _overlapping(start: datetime, end: datetime) -> ColumnElement[bool]:
    return (ExternalBusyBlock.starts_at < end) & (ExternalBusyBlock.ends_at > start)


def external_busy_intervals(
    db: Session, clinician_id: int, start: datetime, end: datetime
) -> list[Interval]:
    """Busy times in the clinician's connected calendars that overlap [start, end)."""
    rows = db.execute(
        select(ExternalBusyBlock.starts_at, ExternalBusyBlock.ends_at)
        .join(CalendarConnection, CalendarConnection.id == ExternalBusyBlock.connection_id)
        .where(CalendarConnection.staff_id == clinician_id, _overlapping(start, end))
        .order_by(ExternalBusyBlock.starts_at)
    )
    return [(block_start, block_end) for block_start, block_end in rows]


def busy_blocks(
    db: Session, clinician_ids: Collection[int], start: datetime, end: datetime
) -> list[tuple[ExternalBusyBlock, int]]:
    """Each busy block overlapping [start, end) with the clinician it belongs to."""
    rows = db.execute(
        select(ExternalBusyBlock, CalendarConnection.staff_id)
        .join(CalendarConnection, CalendarConnection.id == ExternalBusyBlock.connection_id)
        .where(CalendarConnection.staff_id.in_(clinician_ids), _overlapping(start, end))
        .order_by(ExternalBusyBlock.starts_at)
    )
    return [(block, staff_id) for block, staff_id in rows]


def external_conflicts(
    db: Session, appointments: Sequence[Appointment]
) -> dict[int, list[Interval]]:
    """For each active appointment, the busy times in its clinician's connected calendars
    that it overlaps (appointment id -> intervals; appointments without any are left out)."""
    found: dict[int, list[Interval]] = {}
    for appointment in appointments:
        if appointment.status not in ACTIVE_APPOINTMENT_STATUSES:
            continue
        overlaps = external_busy_intervals(
            db, appointment.clinician_id, appointment.starts_at, appointment.ends_at
        )
        if overlaps:
            found[appointment.id] = overlaps
    return found


def _calendars(connection: CalendarConnection) -> list[str]:
    return list(connection.busy_calendar_ids) or [PRIMARY_CALENDAR]


def _horizon(db: Session, connection: CalendarConnection) -> timedelta:
    practice_settings = db.get_one(StaffMember, connection.staff_id).practice.settings
    return timedelta(days=max(practice_settings.booking_max_days_ahead, MIN_HORIZON_DAYS) + 1)


def _poll_connection(db: Session, connection: CalendarConnection, now: datetime) -> None:
    end = now + _horizon(db, connection)
    with calendar_api(connection.provider) as api:
        try:
            token = access_token_for(connection, api, now)
            busy = api.busy_times(token, _calendars(connection), now, end)
        except ProviderError as exc:
            connection_failed(db, connection, exc, now)
            return
    db.execute(delete(ExternalBusyBlock).where(ExternalBusyBlock.connection_id == connection.id))
    db.add_all(
        ExternalBusyBlock(connection_id=connection.id, starts_at=start, ends_at=block_end)
        for start, block_end in busy
    )
    connection.last_busy_sync_at = now
    record_success(connection)


def poll_external_busy(db: Session, now: datetime) -> None:
    """Worker job: refresh the busy times of connections not polled for a sync interval."""
    stale_before = now - timedelta(seconds=settings.calendar_sync_interval_seconds)
    connection_ids = db.scalars(
        select(CalendarConnection.id)
        .join(StaffMember, StaffMember.id == CalendarConnection.staff_id)
        .where(
            CalendarConnection.status.in_(WORKING_STATUSES),
            CalendarConnection.provider.in_(enabled_providers()),
            StaffMember.status == StaffStatus.ACTIVE,
            (CalendarConnection.last_busy_sync_at.is_(None))
            | (CalendarConnection.last_busy_sync_at <= stale_before),
        )
        .order_by(CalendarConnection.last_busy_sync_at.asc().nulls_first())
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
            _poll_connection(db, connection, now)
        db.commit()


def live_busy_check(clinician_id: int, start: datetime, end: datetime) -> bool:
    """Ask the clinician's connected calendars, right now, whether they're busy in [start,
    end), before an online booking request is taken.

    Runs in its own session so refreshed tokens are saved whatever happens to the booking.
    Provider errors and timeouts count as free (the stored busy times still apply), so a slow
    provider never blocks booking.
    """
    now = utcnow()
    busy = False
    with SessionLocal() as db:
        connections = db.scalars(
            select(CalendarConnection).where(
                CalendarConnection.staff_id == clinician_id,
                CalendarConnection.status == CalendarConnectionStatus.ACTIVE,
                CalendarConnection.provider.in_(enabled_providers()),
            )
        ).all()
        for connection in connections:
            try:
                with calendar_api(connection.provider, LIVE_CHECK_TIMEOUT_SECONDS) as api:
                    token = access_token_for(connection, api, now)
                    intervals = api.busy_times(token, _calendars(connection), start, end)
            except ProviderError as exc:
                if exc.kind == ErrorKind.REAUTH:
                    mark_needs_reauth(db, connection, str(exc), now)
                logger.info("Live busy check skipped for calendar connection %s", connection.id)
                continue
            if any(block_start < end and block_end > start for block_start, block_end in intervals):
                busy = True
                break
        db.commit()
    return busy
