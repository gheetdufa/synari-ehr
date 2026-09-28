"""Connected calendar accounts: the provider clients, access tokens and connection health."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from enum import StrEnum

from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import CalendarConnection, CalendarEventLink, ExternalBusyBlock, StaffMember
from synari.models.enums import CalendarConnectionStatus, CalendarProvider, Role
from synari.services.calendar_sync import providers
from synari.services.calendar_sync.google import GoogleCalendar
from synari.services.calendar_sync.microsoft import MicrosoftCalendar
from synari.services.calendar_sync.providers import ErrorKind, ProviderError
from synari.services.notifications import notify
from synari.services.portal_links import queue_staff_email

logger = logging.getLogger(__name__)


class LinkState(StrEnum):
    """Where an appointment's copy in a connected calendar stands."""

    PENDING = "pending"  # to be created or updated
    SYNCED = "synced"
    DELETING = "deleting"  # to be removed from the calendar
    FAILED = "failed"  # gave up; retried when the appointment changes or on "Sync now"


CalendarApi = GoogleCalendar | MicrosoftCalendar

API_CLASSES: dict[CalendarProvider, type[CalendarApi]] = {
    CalendarProvider.GOOGLE: GoogleCalendar,
    CalendarProvider.MICROSOFT: MicrosoftCalendar,
}
PROVIDER_LABELS = {provider: api.label for provider, api in API_CLASSES.items()}
SETTINGS_APP_PATH = "/portal/settings?tab=availability"
# Connections that sync (the rest wait for the user to reconnect).
WORKING_STATUSES = (CalendarConnectionStatus.ACTIVE, CalendarConnectionStatus.ERROR)
# Consecutive failures after which a connection shows as having a problem.
ERROR_AFTER_FAILURES = 5
MAX_FAILURE_BACKOFF = timedelta(hours=6)
_TOKEN_MARGIN = timedelta(minutes=1)


def provider_enabled(provider: str) -> bool:
    """Whether the server has OAuth credentials for the provider."""
    if provider == CalendarProvider.GOOGLE:
        return settings.google_calendar_enabled
    if provider == CalendarProvider.MICROSOFT:
        return settings.microsoft_calendar_enabled
    return False


def enabled_providers() -> list[CalendarProvider]:
    """Providers this server can connect to."""
    return [provider for provider in CalendarProvider if provider_enabled(provider)]


@contextmanager
def calendar_api(
    provider: str, timeout: float = providers.TIMEOUT_SECONDS
) -> Iterator[CalendarApi]:
    """A client for one provider's APIs, closed afterwards."""
    with providers.http_client(timeout) as http:
        yield API_CLASSES[CalendarProvider(provider)](http)


def access_token_for(connection: CalendarConnection, api: CalendarApi, now: datetime) -> str:
    """A current access token, refreshing it (and storing a rotated refresh token) when it's
    about to expire. The caller commits. Raises a REAUTH ProviderError without a grant."""
    if (
        connection.access_token
        and connection.access_expires_at is not None
        and connection.access_expires_at > now + _TOKEN_MARGIN
    ):
        return connection.access_token
    if not connection.refresh_token:
        raise ProviderError("The calendar connection has no sign-in grant", ErrorKind.REAUTH)
    grant = api.refresh(connection.refresh_token)
    connection.access_token = grant.access_token
    connection.access_expires_at = grant.expires_at
    if grant.refresh_token:
        connection.refresh_token = grant.refresh_token
    return grant.access_token


def forget_access_token(connection: CalendarConnection) -> None:
    """Drop an access token the provider rejected, so the next call refreshes it."""
    connection.access_token = None
    connection.access_expires_at = None


def record_success(connection: CalendarConnection) -> None:
    """A call went through: clear any earlier problem."""
    connection.status = CalendarConnectionStatus.ACTIVE
    connection.consecutive_failures = 0
    connection.last_error = ""
    connection.last_error_at = None


def record_failure(connection: CalendarConnection, message: str, now: datetime) -> None:
    """A connection-wide failure; after several in a row the connection shows an error."""
    connection.consecutive_failures += 1
    connection.last_error = message
    connection.last_error_at = now
    if connection.consecutive_failures >= ERROR_AFTER_FAILURES:
        connection.status = CalendarConnectionStatus.ERROR


def record_problem(connection: CalendarConnection, message: str, now: datetime) -> None:
    """A failure that needs the user's attention right away (e.g. the Synari calendar was
    deleted)."""
    record_failure(connection, message, now)
    connection.status = CalendarConnectionStatus.ERROR


def is_due(connection: CalendarConnection, now: datetime) -> bool:
    """Whether to call the provider for this connection now, backing off after failures."""
    if connection.consecutive_failures == 0 or connection.last_error_at is None:
        return True
    backoff = min(
        timedelta(minutes=2 ** min(connection.consecutive_failures, 10)), MAX_FAILURE_BACKOFF
    )
    return now >= connection.last_error_at + backoff


def mark_needs_reauth(
    db: Session, connection: CalendarConnection, message: str, now: datetime
) -> None:
    """The grant is gone: pause syncing and tell the clinician once, in the app and by a
    content-free email, to reconnect. Busy times already fetched keep blocking availability."""
    already = connection.status == CalendarConnectionStatus.NEEDS_REAUTH
    connection.status = CalendarConnectionStatus.NEEDS_REAUTH
    connection.last_error = message
    connection.last_error_at = now
    forget_access_token(connection)
    if already:
        return
    label = PROVIDER_LABELS[CalendarProvider(connection.provider)]
    logger.info("Calendar connection %s needs to be reconnected", connection.id)
    notify(
        db,
        Role.STAFF,
        connection.staff_id,
        kind="calendar_sync",
        title=f"Reconnect {label} to keep your calendar in sync",
        body="Appointments and busy times stopped syncing until you reconnect it.",
        link=SETTINGS_APP_PATH,
    )
    staff = db.get_one(StaffMember, connection.staff_id)
    queue_staff_email(
        db,
        staff,
        subject=f"Reconnect {label} to Synari",
        heading=f"{label} needs to be reconnected",
        paragraphs=[
            "Synari can no longer reach the calendar you connected, so your appointments and "
            "busy times have stopped syncing.",
            "Reconnect it in Settings to start syncing again.",
        ],
        button_label="Reconnect calendar",
        app_path=SETTINGS_APP_PATH,
    )


def reset_events(db: Session, connection: CalendarConnection) -> None:
    """The Synari calendar is new: every appointment must be created in it again."""
    db.execute(
        update(CalendarEventLink)
        .where(CalendarEventLink.connection_id == connection.id)
        .values(
            external_event_id="",
            payload_hash="",
            generation=CalendarEventLink.generation + 1,
            state=LinkState.PENDING,
            attempts=0,
            next_attempt_at=None,
            last_error="",
        )
    )


def clear_synced_data(db: Session, connection: CalendarConnection) -> None:
    """Forget every event link and busy time of the connection."""
    db.execute(delete(CalendarEventLink).where(CalendarEventLink.connection_id == connection.id))
    db.execute(delete(ExternalBusyBlock).where(ExternalBusyBlock.connection_id == connection.id))


def connection_failed(
    db: Session, connection: CalendarConnection, error: ProviderError, now: datetime
) -> None:
    """Record a connection-wide failure: a lost grant needs reconnecting, a rejected token is
    refreshed next time, outages back off, and anything else shows as an error."""
    if error.kind == ErrorKind.REAUTH:
        mark_needs_reauth(db, connection, str(error), now)
        return
    if error.kind == ErrorKind.UNAUTHORIZED:
        forget_access_token(connection)
    if error.kind in (ErrorKind.TRANSIENT, ErrorKind.UNAUTHORIZED):
        record_failure(connection, str(error), now)
    else:
        record_problem(connection, str(error), now)
