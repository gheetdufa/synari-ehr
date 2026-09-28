"""Google Calendar: OAuth, the Synari calendar, its events and free/busy times.

Least-privileged scopes: `calendar.app.created` lets Synari create one secondary calendar and
manage events only in it; `calendar.freebusy` reads when the user is busy (never titles).

Endpoints (Google Calendar API v3 and Google OAuth 2.0, September 2026):
- Authorize: GET https://accounts.google.com/o/oauth2/v2/auth (access_type=offline and
  prompt=consent so a refresh token is always issued; PKCE S256)
- Tokens: POST https://oauth2.googleapis.com/token; revoke: POST .../revoke
- Account: GET https://openidconnect.googleapis.com/v1/userinfo (sub, email)
- Calendar: POST/GET/DELETE https://www.googleapis.com/calendar/v3/calendars[/{id}]
- Events: POST/PATCH/DELETE .../calendars/{id}/events[/{eventId}]?sendUpdates=none. Synari
  supplies the event id (5-1024 characters of a-v and 0-9); re-inserting a deleted event's id
  answers 409, so the event is patched back to confirmed instead.
- Busy times: POST .../freeBusy, in windows of at most 60 days (longer ranges are rejected).
"""

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from synari.config import settings
from synari.models.enums import CalendarProvider
from synari.services.calendar_sync.providers import (
    CALENDAR_NAME,
    PRIMARY_CALENDAR,
    Account,
    CalendarInfo,
    ErrorKind,
    EventPayload,
    Interval,
    ProviderError,
    TokenGrant,
    expires_at,
    json_of,
    merge_intervals,
    parse_busy,
    required_id,
    send,
    token_request,
    utc_iso,
)

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
API_URL = "https://www.googleapis.com/calendar/v3"

SCOPE_APP_CALENDAR = "https://www.googleapis.com/auth/calendar.app.created"
SCOPE_FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy"
SCOPES = ("openid", "email", SCOPE_APP_CALENDAR, SCOPE_FREEBUSY)
REQUIRED_SCOPES = (SCOPE_APP_CALENDAR, SCOPE_FREEBUSY)
FREEBUSY_WINDOW = timedelta(days=60)
_NO_UPDATES = {"sendUpdates": "none"}


def _grant(payload: dict[str, Any]) -> TokenGrant:
    access_token = payload.get("access_token")
    if not access_token:
        raise ProviderError("Google didn't return an access token", ErrorKind.PERMANENT)
    return TokenGrant(
        access_token=access_token,
        expires_at=expires_at(payload),
        refresh_token=payload.get("refresh_token"),
        scopes=frozenset(str(payload.get("scope", "")).split()),
    )


def _event_body(event: EventPayload) -> dict[str, Any]:
    """The event as Google stores it: title and times only, private, no guests or links."""
    return {
        "summary": event.title,
        "start": {"dateTime": utc_iso(event.starts_at)},
        "end": {"dateTime": utc_iso(event.ends_at)},
        "status": "tentative" if event.tentative else "confirmed",
        "transparency": "opaque",
        "visibility": "private",
        "extendedProperties": {"private": {"synariAppointmentId": str(event.appointment_id)}},
    }


def _busy_period(item: dict[str, str]) -> Interval:
    return datetime.fromisoformat(item["start"]), datetime.fromisoformat(item["end"])


class GoogleCalendar:
    """Calls to one Google account's calendars."""

    provider = CalendarProvider.GOOGLE
    label = "Google Calendar"
    # Synari chooses each event's id, so it's known before the first create attempt.
    client_assigned_ids = True

    def __init__(self, http: httpx.Client) -> None:
        self.http = http

    def authorize_url(self, *, state: str, code_challenge: str, redirect_uri: str) -> str:
        """Where to send the user to grant access."""
        query = urlencode(
            {
                "client_id": settings.google_oauth_client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": " ".join(SCOPES),
                "access_type": "offline",
                "prompt": "consent",
                "state": state,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{AUTHORIZE_URL}?{query}"

    def exchange_code(self, code: str, code_verifier: str, redirect_uri: str) -> TokenGrant:
        """Trade the authorization code for tokens."""
        return _grant(
            token_request(
                self.http,
                TOKEN_URL,
                {
                    "code": code,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                    "code_verifier": code_verifier,
                },
            )
        )

    def refresh(self, refresh_token: str) -> TokenGrant:
        """A new access token from the refresh token."""
        return _grant(
            token_request(
                self.http,
                TOKEN_URL,
                {
                    "refresh_token": refresh_token,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "grant_type": "refresh_token",
                },
            )
        )

    def missing_scopes(self, grant: TokenGrant) -> list[str]:
        """Required permissions the user didn't grant (Google lets them untick scopes)."""
        return [scope for scope in REQUIRED_SCOPES if scope not in grant.scopes]

    def revoke(self, refresh_token: str) -> None:
        """Revoke the grant, which also invalidates its access tokens."""
        send(self.http, "POST", REVOKE_URL, data={"token": refresh_token})

    def _auth(self, access_token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {access_token}"}

    def account(self, access_token: str) -> Account:
        """The signed-in Google account."""
        data = json_of(send(self.http, "GET", USERINFO_URL, headers=self._auth(access_token)))
        return Account(account_id=str(data.get("sub", "")), email=str(data.get("email", "")))

    def ensure_calendar(self, access_token: str, calendar_id: str) -> str:
        """The Synari calendar's id: the existing one if it's still there, else a new one."""
        headers = self._auth(access_token)
        if calendar_id:
            try:
                send(self.http, "GET", f"{API_URL}/calendars/{quote(calendar_id)}", headers=headers)
                return calendar_id
            except ProviderError as exc:
                if exc.kind != ErrorKind.NOT_FOUND:
                    raise
        created = send(
            self.http,
            "POST",
            f"{API_URL}/calendars",
            headers=headers,
            json={"summary": CALENDAR_NAME, "description": "Appointments from Synari"},
        )
        return required_id(json_of(created))

    def delete_calendar(self, access_token: str, calendar_id: str) -> None:
        """Delete the Synari calendar and every event in it."""
        try:
            send(
                self.http,
                "DELETE",
                f"{API_URL}/calendars/{quote(calendar_id)}",
                headers=self._auth(access_token),
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.NOT_FOUND:
                raise

    def create_key(self, connection_id: int, appointment_id: int, generation: int) -> str:
        """The event id: stable per connection and appointment, so retries never duplicate."""
        return f"s{connection_id:08x}{appointment_id:012x}"

    def _events_url(self, calendar_id: str) -> str:
        return f"{API_URL}/calendars/{quote(calendar_id)}/events"

    def create_event(
        self, access_token: str, calendar_id: str, event: EventPayload, key: str
    ) -> str:
        """Insert the event under id `key` (restoring it if it was deleted); returns the id."""
        try:
            send(
                self.http,
                "POST",
                self._events_url(calendar_id),
                headers=self._auth(access_token),
                params=_NO_UPDATES,
                json={"id": key, **_event_body(event)},
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.CONFLICT:
                raise
            self.update_event(access_token, calendar_id, key, event)
        return key

    def update_event(
        self, access_token: str, calendar_id: str, event_id: str, event: EventPayload
    ) -> None:
        """Overwrite the event's title, times and status."""
        send(
            self.http,
            "PATCH",
            f"{self._events_url(calendar_id)}/{quote(event_id)}",
            headers=self._auth(access_token),
            params=_NO_UPDATES,
            json=_event_body(event),
        )

    def delete_event(self, access_token: str, calendar_id: str, event_id: str) -> None:
        """Remove the event; one that's already gone counts as removed."""
        try:
            send(
                self.http,
                "DELETE",
                f"{self._events_url(calendar_id)}/{quote(event_id)}",
                headers=self._auth(access_token),
                params=_NO_UPDATES,
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.NOT_FOUND:
                raise

    def busy_times(
        self, access_token: str, calendar_ids: list[str], start: datetime, end: datetime
    ) -> list[Interval]:
        """When the user is busy in any of the calendars between start and end."""
        intervals: list[Interval] = []
        window_start = start
        while window_start < end:
            window_end = min(window_start + FREEBUSY_WINDOW, end)
            response = send(
                self.http,
                "POST",
                f"{API_URL}/freeBusy",
                headers=self._auth(access_token),
                json={
                    "timeMin": utc_iso(window_start),
                    "timeMax": utc_iso(window_end),
                    "items": [{"id": calendar_id} for calendar_id in calendar_ids],
                },
            )
            calendars = json_of(response).get("calendars") or {}
            for calendar_id in calendar_ids:
                info = calendars.get(calendar_id)
                if info is None and len(calendar_ids) == 1 and len(calendars) == 1:
                    info = next(iter(calendars.values()))
                info = info or {}
                errors = info.get("errors") or []
                if errors:
                    reason = errors[0].get("reason", "unknown error")
                    raise ProviderError(
                        f"Google couldn't share busy times for calendar {calendar_id}: {reason}",
                        ErrorKind.PERMANENT,
                    )
                intervals += parse_busy(info.get("busy") or [], _busy_period)
            window_start = window_end
        return merge_intervals(intervals)

    def list_calendars(self, access_token: str) -> list[CalendarInfo]:
        """Calendars that can block availability. Google's least-privileged scopes can't list
        calendars, so only the primary one is offered; other calendar ids can be added."""
        return [CalendarInfo(PRIMARY_CALENDAR, "Primary calendar")]
