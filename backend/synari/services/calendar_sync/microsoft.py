"""Microsoft Outlook / Microsoft 365 calendars through Microsoft Graph.

Scopes: openid offline_access User.Read Calendars.ReadWrite (Graph has no app-created-calendar
scope). Refresh tokens rotate on every use, so each new one is stored. There is no per-token
revocation endpoint: disconnecting deletes the tokens and users can remove the app's consent
from their Microsoft account.

Endpoints (Microsoft identity platform v2.0 and Graph v1.0, September 2026):
- Authorize/tokens: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize|token
  (PKCE S256; tenant "common" allows work, school and personal accounts)
- Account: GET https://graph.microsoft.com/v1.0/me
- Calendar: POST/GET/DELETE /me/calendars[/{id}] (a second "Synari" calendar answers 409)
- Events: POST /me/calendars/{id}/events with a transactionId (Graph ignores a repeated create
  with the same one), PATCH/DELETE /me/events/{id}; the appointment id rides along in a
  single-value extended property.
- Busy times: GET /me/calendarView (default calendar) or /me/calendars/{id}/calendarView with
  $select=start,end,showAs,isCancelled and Prefer: outlook.timezone="UTC", following
  @odata.nextLink. showAs busy and oof count as busy.
"""

from datetime import UTC, datetime
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

LOGIN_URL = "https://login.microsoftonline.com"
GRAPH_URL = "https://graph.microsoft.com/v1.0"
SCOPES = ("openid", "offline_access", "User.Read", "Calendars.ReadWrite")
REQUIRED_SCOPES = ("User.Read", "Calendars.ReadWrite")
# Where the appointment id is kept on each event (a fixed GUID namespace for Synari).
APPOINTMENT_PROPERTY = "String {3c1f7c52-8b6e-4f0a-9d2e-5a7b1c4e8f63} Name SynariAppointmentId"
BUSY_STATES = frozenset({"busy", "oof"})
MAX_PAGES = 50
_UTC_HEADER = {"Prefer": 'outlook.timezone="UTC"'}


def _authority() -> str:
    return f"{LOGIN_URL}/{settings.microsoft_oauth_tenant}/oauth2/v2.0"


def _scope_name(scope: str) -> str:
    """'https://graph.microsoft.com/Calendars.ReadWrite' -> 'calendars.readwrite'."""
    return scope.rsplit("/", 1)[-1].lower()


def _grant(payload: dict[str, Any]) -> TokenGrant:
    access_token = payload.get("access_token")
    if not access_token:
        raise ProviderError("Microsoft didn't return an access token", ErrorKind.PERMANENT)
    return TokenGrant(
        access_token=access_token,
        expires_at=expires_at(payload),
        refresh_token=payload.get("refresh_token"),
        scopes=frozenset(_scope_name(scope) for scope in str(payload.get("scope", "")).split()),
    )


def _graph_time(moment: datetime) -> dict[str, str]:
    return {"dateTime": moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"}


def _parse_graph_time(value: dict[str, str]) -> datetime:
    """Graph's {"dateTime": "2026-09-27T14:00:00.0000000", "timeZone": "UTC"} as UTC."""
    whole_seconds = value["dateTime"].partition(".")[0]
    return datetime.fromisoformat(whole_seconds).replace(tzinfo=UTC)


def _busy_event(item: dict[str, Any]) -> Interval | None:
    """An event's time when it makes the user busy or out of office, else None."""
    if item.get("isCancelled") or item.get("showAs") not in BUSY_STATES:
        return None
    return _parse_graph_time(item["start"]), _parse_graph_time(item["end"])


def _event_body(event: EventPayload) -> dict[str, Any]:
    """The event as Graph stores it: title and times only, private, no attendees or links."""
    return {
        "subject": event.title,
        "start": _graph_time(event.starts_at),
        "end": _graph_time(event.ends_at),
        "showAs": "tentative" if event.tentative else "busy",
        "sensitivity": "private",
        "singleValueExtendedProperties": [
            {"id": APPOINTMENT_PROPERTY, "value": str(event.appointment_id)}
        ],
    }


class MicrosoftCalendar:
    """Calls to one Microsoft account's calendars."""

    provider = CalendarProvider.MICROSOFT
    label = "Outlook"
    # Graph assigns event ids; a create is identified by its transactionId until then.
    client_assigned_ids = False

    def __init__(self, http: httpx.Client) -> None:
        self.http = http

    def authorize_url(self, *, state: str, code_challenge: str, redirect_uri: str) -> str:
        """Where to send the user to grant access."""
        query = urlencode(
            {
                "client_id": settings.microsoft_oauth_client_id,
                "response_type": "code",
                "redirect_uri": redirect_uri,
                "response_mode": "query",
                "scope": " ".join(SCOPES),
                "state": state,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "prompt": "select_account",
            }
        )
        return f"{_authority()}/authorize?{query}"

    def _token(self, form: dict[str, str]) -> TokenGrant:
        return _grant(
            token_request(
                self.http,
                f"{_authority()}/token",
                {
                    "client_id": settings.microsoft_oauth_client_id,
                    "client_secret": settings.microsoft_oauth_client_secret,
                    "scope": " ".join(SCOPES),
                    **form,
                },
            )
        )

    def exchange_code(self, code: str, code_verifier: str, redirect_uri: str) -> TokenGrant:
        """Trade the authorization code for tokens."""
        return self._token(
            {
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": code_verifier,
            }
        )

    def refresh(self, refresh_token: str) -> TokenGrant:
        """New tokens from the refresh token (Microsoft also returns a new refresh token)."""
        return self._token({"refresh_token": refresh_token, "grant_type": "refresh_token"})

    def missing_scopes(self, grant: TokenGrant) -> list[str]:
        """Required permissions missing from the grant."""
        return [scope for scope in REQUIRED_SCOPES if scope.lower() not in grant.scopes]

    def revoke(self, refresh_token: str) -> None:
        """Microsoft can't revoke a single token; deleting ours is all there is to do."""

    def _auth(self, access_token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {access_token}"}

    def account(self, access_token: str) -> Account:
        """The signed-in Microsoft account."""
        data = json_of(
            send(
                self.http,
                "GET",
                f"{GRAPH_URL}/me",
                headers=self._auth(access_token),
                params={"$select": "id,mail,userPrincipalName"},
            )
        )
        email = data.get("mail") or data.get("userPrincipalName") or ""
        return Account(account_id=str(data.get("id", "")), email=str(email))

    def _find_calendar(self, access_token: str) -> str:
        """The id of an existing calendar named Synari."""
        found = (
            json_of(
                send(
                    self.http,
                    "GET",
                    f"{GRAPH_URL}/me/calendars",
                    headers=self._auth(access_token),
                    params={"$filter": f"name eq '{CALENDAR_NAME}'", "$select": "id,name"},
                )
            ).get("value")
            or []
        )
        if not found:
            raise ProviderError("Couldn't find or create the Synari calendar", ErrorKind.PERMANENT)
        return required_id(found[0])

    def ensure_calendar(self, access_token: str, calendar_id: str) -> str:
        """The Synari calendar's id: the existing one if it's still there, else a new one."""
        headers = self._auth(access_token)
        if calendar_id:
            try:
                send(
                    self.http,
                    "GET",
                    f"{GRAPH_URL}/me/calendars/{quote(calendar_id)}",
                    headers=headers,
                )
                return calendar_id
            except ProviderError as exc:
                if exc.kind != ErrorKind.NOT_FOUND:
                    raise
        try:
            created = send(
                self.http,
                "POST",
                f"{GRAPH_URL}/me/calendars",
                headers=headers,
                json={"name": CALENDAR_NAME},
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.CONFLICT:
                raise
            return self._find_calendar(access_token)
        return required_id(json_of(created))

    def delete_calendar(self, access_token: str, calendar_id: str) -> None:
        """Delete the Synari calendar and every event in it."""
        try:
            send(
                self.http,
                "DELETE",
                f"{GRAPH_URL}/me/calendars/{quote(calendar_id)}",
                headers=self._auth(access_token),
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.NOT_FOUND:
                raise

    def create_key(self, connection_id: int, appointment_id: int, generation: int) -> str:
        """The transactionId: repeated creates with it make one event; a new generation makes a
        fresh event after the old one was deleted."""
        return f"synari-{connection_id}-{appointment_id}-{generation}"

    def create_event(
        self, access_token: str, calendar_id: str, event: EventPayload, key: str
    ) -> str:
        """Create the event (idempotent per `key`); returns Graph's event id."""
        created = send(
            self.http,
            "POST",
            f"{GRAPH_URL}/me/calendars/{quote(calendar_id)}/events",
            headers=self._auth(access_token),
            json={**_event_body(event), "transactionId": key},
        )
        return required_id(json_of(created))

    def update_event(
        self, access_token: str, calendar_id: str, event_id: str, event: EventPayload
    ) -> None:
        """Overwrite the event's title, times and availability."""
        send(
            self.http,
            "PATCH",
            f"{GRAPH_URL}/me/events/{quote(event_id)}",
            headers=self._auth(access_token),
            json=_event_body(event),
        )

    def delete_event(self, access_token: str, calendar_id: str, event_id: str) -> None:
        """Remove the event; one that's already gone counts as removed."""
        try:
            send(
                self.http,
                "DELETE",
                f"{GRAPH_URL}/me/events/{quote(event_id)}",
                headers=self._auth(access_token),
            )
        except ProviderError as exc:
            if exc.kind != ErrorKind.NOT_FOUND:
                raise

    def _calendar_view_url(self, calendar_id: str) -> str:
        if calendar_id == PRIMARY_CALENDAR:
            return f"{GRAPH_URL}/me/calendarView"
        return f"{GRAPH_URL}/me/calendars/{quote(calendar_id)}/calendarView"

    def busy_times(
        self, access_token: str, calendar_ids: list[str], start: datetime, end: datetime
    ) -> list[Interval]:
        """When the user is busy or out of office in any of the calendars."""
        intervals: list[Interval] = []
        headers = {**self._auth(access_token), **_UTC_HEADER}
        for calendar_id in calendar_ids:
            url: str | None = self._calendar_view_url(calendar_id)
            params: dict[str, str] | None = {
                "startDateTime": utc_iso(start),
                "endDateTime": utc_iso(end),
                "$select": "start,end,showAs,isCancelled",
                "$top": "250",
            }
            for _ in range(MAX_PAGES):
                if url is None:
                    break
                page = json_of(send(self.http, "GET", url, headers=headers, params=params))
                intervals += parse_busy(page.get("value") or [], _busy_event)
                url = page.get("@odata.nextLink")
                params = None
        return merge_intervals(intervals)

    def list_calendars(self, access_token: str) -> list[CalendarInfo]:
        """The account's calendars; the default one is listed as "primary"."""
        data = json_of(
            send(
                self.http,
                "GET",
                f"{GRAPH_URL}/me/calendars",
                headers=self._auth(access_token),
                params={"$select": "id,name,isDefaultCalendar", "$top": "100"},
            )
        )
        return [
            CalendarInfo(
                PRIMARY_CALENDAR if item.get("isDefaultCalendar") else required_id(item),
                str(item.get("name", "")),
            )
            for item in data.get("value") or []
        ]
