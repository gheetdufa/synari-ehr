"""Connecting a Google or Microsoft account (OAuth 2.0 authorization code flow with PKCE).

The browser leaves with a signed, 10-minute `state` naming the staff member, the provider and a
random nonce. Nothing else from the callback is trusted: the state must verify, and the PKCE
code verifier is derived from the nonce with the server's secret, so it never passes through
the browser. The callback exchanges the code, checks the granted scopes, reads the account id
and email, creates (or finds) the Synari calendar and stores the connection. Reconnecting the
same account reuses its row, keeping the calendar and queued events.
"""

import base64
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import CalendarConnection, StaffMember
from synari.models.enums import CalendarProvider
from synari.services.calendar_sync.connections import (
    CalendarApi,
    access_token_for,
    calendar_api,
    clear_synced_data,
    provider_enabled,
    record_success,
    reset_events,
)
from synari.services.calendar_sync.hooks import queue_upcoming
from synari.services.calendar_sync.providers import PRIMARY_CALENDAR, ProviderError

logger = logging.getLogger(__name__)

STATE_TTL = timedelta(minutes=10)
STATE_TYPE = "calendar_connect"
_ALGORITHM = "HS256"


class ConnectFailed(Exception):
    """Connecting didn't work. `reason` is a short code the settings page explains:
    denied, expired, scopes, offline or provider."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Connected:
    connection: CalendarConnection
    reconnected: bool


def redirect_uri(provider: CalendarProvider) -> str:
    """The callback URL registered with the provider (it must match exactly)."""
    return f"{settings.public_api_origin}/api/calendar-sync/{provider}/callback"


def _code_verifier(nonce: str) -> str:
    """The PKCE verifier for a state's nonce: 43 characters only the server can compute."""
    digest = hmac.new(
        settings.secret_key.encode(), f"calendar-sync-pkce:{nonce}".encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def code_challenge(verifier: str) -> str:
    """S256 PKCE challenge for a verifier."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def authorization_url(staff: StaffMember, provider: CalendarProvider, api: CalendarApi) -> str:
    """Where to send the staff member to grant Synari access to their calendar."""
    now = utcnow()
    nonce = secrets.token_urlsafe(24)
    state = jwt.encode(
        {
            "type": STATE_TYPE,
            "sub": str(staff.id),
            "ver": staff.token_version,
            "provider": str(provider),
            "nonce": nonce,
            "iat": now,
            "exp": now + STATE_TTL,
        },
        settings.secret_key,
        algorithm=_ALGORITHM,
    )
    return api.authorize_url(
        state=state,
        code_challenge=code_challenge(_code_verifier(nonce)),
        redirect_uri=redirect_uri(provider),
    )


def read_state(db: Session, state: str, provider: CalendarProvider) -> tuple[StaffMember, str]:
    """The staff member a callback's state was issued to, and the PKCE verifier. Raises
    ConnectFailed("expired") for anything invalid, expired, for another provider, or issued
    before the person signed out everywhere."""
    try:
        claims = jwt.decode(
            state,
            settings.secret_key,
            algorithms=[_ALGORITHM],
            options={"require": ["exp", "sub", "type", "nonce", "provider"]},
        )
    except jwt.PyJWTError as exc:
        raise ConnectFailed("expired") from exc
    if claims["type"] != STATE_TYPE or claims["provider"] != provider:
        raise ConnectFailed("expired")
    staff = db.get(StaffMember, int(claims["sub"]))
    if (
        staff is None
        or not staff.is_active
        or not staff.is_clinician
        or claims.get("ver") != staff.token_version
    ):
        raise ConnectFailed("expired")
    return staff, _code_verifier(str(claims["nonce"]))


def complete_connection(
    db: Session,
    staff: StaffMember,
    provider: CalendarProvider,
    code: str,
    code_verifier: str,
    now: datetime,
) -> Connected:
    """Exchange the code and store the connection (the caller audits and commits). Provider
    failures raise ProviderError; missing permissions raise ConnectFailed."""
    with calendar_api(provider) as api:
        grant = api.exchange_code(code, code_verifier, redirect_uri(provider))
        if api.missing_scopes(grant):
            raise ConnectFailed("scopes")
        if not grant.refresh_token:
            raise ConnectFailed("offline")
        account = api.account(grant.access_token)
        connection = db.scalar(
            select(CalendarConnection).where(
                CalendarConnection.staff_id == staff.id, CalendarConnection.provider == provider
            )
        )
        reconnected = (
            connection is not None and connection.provider_account_id == account.account_id
        )
        if connection is None:
            connection = CalendarConnection(staff_id=staff.id, provider=provider)
            db.add(connection)
            db.flush()
        elif not reconnected:
            # Another account: its calendar and busy times have nothing to do with this one.
            clear_synced_data(db, connection)
            connection.write_calendar_id = ""
        if not reconnected:
            connection.busy_calendar_ids = [PRIMARY_CALENDAR]
        calendar_id = api.ensure_calendar(grant.access_token, connection.write_calendar_id)
    if connection.write_calendar_id and calendar_id != connection.write_calendar_id:
        reset_events(db, connection)
    connection.write_calendar_id = calendar_id
    connection.account_email = account.email[:320]
    connection.provider_account_id = account.account_id[:200]
    connection.granted_scopes = " ".join(sorted(grant.scopes))
    connection.access_token = grant.access_token
    connection.access_expires_at = grant.expires_at
    connection.refresh_token = grant.refresh_token
    connection.last_busy_sync_at = None
    record_success(connection)
    queue_upcoming(db, connection, now)
    return Connected(connection, reconnected)


def disconnect(
    db: Session, connection: CalendarConnection, *, delete_calendar: bool, now: datetime
) -> bool:
    """Stop syncing and delete the connection with its tokens, event links and busy times
    (the caller audits and commits). Best effort, it also deletes the Synari calendar (when
    asked) and revokes the grant at Google. Returns whether the calendar was deleted."""
    deleted_calendar = False
    if connection.refresh_token and provider_enabled(connection.provider):
        try:
            with calendar_api(connection.provider) as api:
                token = access_token_for(connection, api, now)
                if delete_calendar and connection.write_calendar_id:
                    api.delete_calendar(token, connection.write_calendar_id)
                    deleted_calendar = True
                api.revoke(connection.refresh_token)
        except ProviderError as exc:
            logger.info("Calendar connection %s cleanup incomplete: %s", connection.id, exc)
    clear_synced_data(db, connection)
    db.delete(connection)
    return deleted_calendar


def disconnect_staff(db: Session, staff_id: int, now: datetime) -> int:
    """Disconnect every calendar of someone leaving the practice, deleting the Synari calendar
    from their account (the caller audits and commits). Returns how many were connected."""
    connections = list(
        db.scalars(select(CalendarConnection).where(CalendarConnection.staff_id == staff_id))
    )
    for connection in connections:
        disconnect(db, connection, delete_calendar=True, now=now)
    return len(connections)
