"""Two-way sync with Google Calendar and Microsoft Outlook/365.

Each clinician connects their own accounts: only they can see, change or disconnect a
connection. Synari writes their appointments into a "Synari" calendar in the account (PHI-free
titles) and reads busy times so online booking avoids them. Busy times (times only) are visible
to whoever manages that clinician's calendar. Owners and practice managers decide whether synced
events show client initials. The private ICS feed (calendar_feed.py) is separate and stays.
"""

import logging
from datetime import datetime, timedelta
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Path, Query, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.access import Access
from synari.audit import audit_staff
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import CalendarConnection, CalendarEventLink
from synari.models.enums import CalendarProvider
from synari.permissions import Capability
from synari.schemas.calendar_sync import (
    BusyBlockOut,
    CalendarOut,
    CalendarSyncSettingsOut,
    CalendarSyncSettingsUpdate,
    ConnectionOut,
    ConnectionUpdate,
    ConnectUrl,
    ProviderOut,
)
from synari.services.calendar_sync.busy import busy_blocks
from synari.services.calendar_sync.connections import (
    PROVIDER_LABELS,
    LinkState,
    access_token_for,
    calendar_api,
    connection_failed,
    provider_enabled,
)
from synari.services.calendar_sync.hooks import queue_upcoming, requeue_practice
from synari.services.calendar_sync.oauth import (
    ConnectFailed,
    authorization_url,
    complete_connection,
    disconnect,
    read_state,
)
from synari.services.calendar_sync.providers import ProviderError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/calendar-sync", tags=["calendar sync"])

MAX_BUSY_RANGE = timedelta(days=62)
ProviderPath = Annotated[CalendarProvider, Path(description="google or microsoft")]


def _settings_out(access: Access) -> CalendarSyncSettingsOut:
    return CalendarSyncSettingsOut(
        providers=[
            ProviderOut(provider=provider, label=label, enabled=provider_enabled(provider))
            for provider, label in PROVIDER_LABELS.items()
        ],
        include_initials=access.staff.practice.settings.calendar_include_initials,
    )


def _own_connection(access: Access, connection_id: int) -> CalendarConnection:
    """One of the signed-in person's own connections; anyone else's is a 404."""
    connection = access.db.get(CalendarConnection, connection_id)
    if connection is None or connection.staff_id != access.staff.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Calendar connection not found")
    return connection


def _connection_out(db: Session, connection: CalendarConnection) -> ConnectionOut:
    counts: dict[str, int] = {
        state: count
        for state, count in db.execute(
            select(CalendarEventLink.state, func.count())
            .where(CalendarEventLink.connection_id == connection.id)
            .group_by(CalendarEventLink.state)
        )
    }
    view = ConnectionOut.model_validate(connection)
    view.pending_events = counts.get(LinkState.PENDING, 0) + counts.get(LinkState.DELETING, 0)
    view.failed_events = counts.get(LinkState.FAILED, 0)
    return view


def _settings_redirect(outcome: str, provider: str, reason: str = "") -> RedirectResponse:
    """Back to Settings -> Availability, which explains the outcome."""
    query = {"tab": "availability", "calendar_sync": outcome, "provider": provider}
    if reason:
        query["reason"] = reason
    url = f"{settings.frontend_url.rstrip('/')}/portal/settings?{urlencode(query)}"
    return RedirectResponse(url, status_code=status.HTTP_303_SEE_OTHER)


@router.get("/settings", response_model=CalendarSyncSettingsOut)
def get_sync_settings(access: CurrentAccess) -> CalendarSyncSettingsOut:
    """Which providers this server can connect to, and how synced events are titled."""
    return _settings_out(access)


@router.patch("/settings", response_model=CalendarSyncSettingsOut)
def update_sync_settings(
    body: CalendarSyncSettingsUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> CalendarSyncSettingsOut:
    """Show client initials on synced events, or not (owners and practice managers). Only
    turn this on when every connected account is covered by a BAA."""
    access.require(Capability.MANAGE_PRACTICE)
    practice_settings = access.staff.practice.settings
    if practice_settings.calendar_include_initials != body.include_initials:
        practice_settings.calendar_include_initials = body.include_initials
        requeue_practice(db, access.practice_id)
        audit_staff(
            db,
            request,
            access.staff,
            "practice.settings_update",
            detail={"fields": ["calendar_include_initials"]},
        )
        db.commit()
    return _settings_out(access)


@router.get("/connections", response_model=list[ConnectionOut])
def list_connections(access: CurrentAccess, db: DbSession) -> list[ConnectionOut]:
    """Your connected calendar accounts."""
    connections = db.scalars(
        select(CalendarConnection)
        .where(CalendarConnection.staff_id == access.staff.id)
        .order_by(CalendarConnection.id)
    )
    return [_connection_out(db, connection) for connection in connections]


@router.patch("/connections/{connection_id}", response_model=ConnectionOut)
def update_connection(
    connection_id: int,
    body: ConnectionUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> ConnectionOut:
    """Choose which of the account's calendars block your availability."""
    connection = _own_connection(access, connection_id)
    calendar_ids = list(dict.fromkeys(item.strip() for item in body.busy_calendar_ids))
    if connection.write_calendar_id in calendar_ids or not all(calendar_ids):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Choose your own calendars; Synari's calendar can't block your availability",
        )
    connection.busy_calendar_ids = calendar_ids
    connection.last_busy_sync_at = None
    audit_staff(
        db,
        request,
        access.staff,
        "calendar_sync.update",
        "calendar_connection",
        connection.id,
        {"busy_calendars": len(calendar_ids)},
    )
    db.commit()
    return _connection_out(db, connection)


@router.delete("/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_connection(
    connection_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    delete_calendar: bool = Query(
        default=False, description="Also delete the Synari calendar (and its events)"
    ),
) -> None:
    """Disconnect: stop syncing, delete the tokens and revoke Google's grant."""
    connection = _own_connection(access, connection_id)
    detail = {"provider": connection.provider}
    calendar_deleted = disconnect(db, connection, delete_calendar=delete_calendar, now=utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "calendar_sync.disconnect",
        "calendar_connection",
        connection_id,
        {**detail, "calendar_deleted": calendar_deleted},
    )
    db.commit()


@router.get("/connections/{connection_id}/calendars", response_model=list[CalendarOut])
def list_calendars(connection_id: int, access: CurrentAccess, db: DbSession) -> list[CalendarOut]:
    """Calendars in the account that can block availability (Google offers the primary one;
    other Google calendar ids can be entered)."""
    connection = _own_connection(access, connection_id)
    if not provider_enabled(connection.provider):
        raise HTTPException(status.HTTP_409_CONFLICT, "This calendar service isn't set up")
    now = utcnow()
    try:
        with calendar_api(connection.provider) as api:
            token = access_token_for(connection, api, now)
            calendars = api.list_calendars(token)
    except ProviderError as exc:
        connection_failed(db, connection, exc, now)
        db.commit()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Couldn't load your calendars. Try again later."
        ) from exc
    db.commit()
    return [
        CalendarOut(id=calendar.calendar_id, name=calendar.name)
        for calendar in calendars
        if calendar.calendar_id != connection.write_calendar_id
    ]


@router.post("/connections/{connection_id}/sync", response_model=ConnectionOut)
def sync_now(
    connection_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ConnectionOut:
    """Queue your upcoming appointments again (retrying failed ones) and re-read busy times on
    the worker's next pass."""
    connection = _own_connection(access, connection_id)
    queue_upcoming(db, connection, utcnow())
    connection.last_busy_sync_at = None
    audit_staff(
        db, request, access.staff, "calendar_sync.sync", "calendar_connection", connection.id
    )
    db.commit()
    return _connection_out(db, connection)


@router.get("/busy", response_model=list[BusyBlockOut])
def list_busy_times(
    access: CurrentAccess,
    db: DbSession,
    start: datetime = Query(description="Range start (ISO 8601 with offset)"),
    end: datetime = Query(description="Range end, at most 62 days after start"),
    clinician_ids: list[int] | None = Query(
        default=None, description="Whose busy times (default: yours); calendars you manage"
    ),
) -> list[BusyBlockOut]:
    """Busy times from connected calendars (ids and times only)."""
    if start.tzinfo is None or end.tzinfo is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "start and end need a UTC offset"
        )
    if end <= start or end - start > MAX_BUSY_RANGE:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid date range")
    if clinician_ids:
        wanted = set(clinician_ids)
    else:
        wanted = {access.staff.id} if access.staff.is_clinician else set()
    for clinician_id in wanted:
        access.clinician(clinician_id)
        access.require_calendar(clinician_id)
    return [
        BusyBlockOut(
            id=block.id, clinician_id=staff_id, starts_at=block.starts_at, ends_at=block.ends_at
        )
        for block, staff_id in busy_blocks(db, wanted, start, end)
    ]


@router.get("/{provider}/connect", response_model=ConnectUrl)
def connect(provider: ProviderPath, access: CurrentAccess) -> ConnectUrl:
    """Start connecting an account: send the browser to the returned URL. The provider sends
    it back to /callback, which returns to Settings."""
    if not access.staff.is_clinician:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only clinicians have a calendar to sync")
    if not provider_enabled(provider):
        raise HTTPException(status.HTTP_409_CONFLICT, "This calendar service isn't set up")
    with calendar_api(provider) as api:
        return ConnectUrl(url=authorization_url(access.staff, provider, api))


@router.get("/{provider}/callback", response_class=RedirectResponse, include_in_schema=False)
def oauth_callback(
    provider: ProviderPath,
    db: DbSession,
    request: Request,
    state: str = "",
    code: str = "",
    error: str = "",
) -> RedirectResponse:
    """Where the provider returns the browser after consent; always redirects to Settings."""
    if not provider_enabled(provider):
        return _settings_redirect("error", provider, "unavailable")
    try:
        staff, code_verifier = read_state(db, state, provider)
        if error or not code:
            raise ConnectFailed("denied")
        connected = complete_connection(db, staff, provider, code, code_verifier, utcnow())
    except ConnectFailed as exc:
        db.rollback()
        return _settings_redirect("error", provider, exc.reason)
    except ProviderError as exc:
        db.rollback()
        logger.warning("Connecting a %s calendar failed: %s", provider, exc)
        return _settings_redirect("error", provider, "provider")
    audit_staff(
        db,
        request,
        staff,
        "calendar_sync.connect",
        "calendar_connection",
        connected.connection.id,
        {"provider": str(provider), "reconnected": connected.reconnected},
    )
    db.commit()
    return _settings_redirect("connected", provider)
