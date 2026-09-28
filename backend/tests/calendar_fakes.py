"""In-memory stand-ins for Google's and Microsoft's OAuth and calendar APIs, served through
httpx.MockTransport so calendar sync runs end to end without the network."""

import itertools
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from synari.config import settings
from synari.services.calendar_sync import providers

GOOGLE_SCOPES = (
    "openid https://www.googleapis.com/auth/userinfo.email "
    "https://www.googleapis.com/auth/calendar.app.created "
    "https://www.googleapis.com/auth/calendar.freebusy"
)
MICROSOFT_SCOPES = (
    "openid profile email https://graph.microsoft.com/Calendars.ReadWrite "
    "https://graph.microsoft.com/User.Read"
)
GOOGLE_API = "/calendar/v3"
GRAPH = "/v1.0"


def _json(status_code: int, body: Any = None, **headers: str) -> httpx.Response:
    if body is None:
        return httpx.Response(status_code, headers=headers)
    return httpx.Response(status_code, json=body, headers=headers)


def _form(request: httpx.Request) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(request.content.decode()).items()}


@dataclass
class FakeCalendars:
    """Both providers' endpoints, backed by dictionaries tests can inspect and change."""

    requests: list[httpx.Request] = field(default_factory=list)
    # Queued answers for the next matching calls: (method, path substring) -> responses.
    failures: dict[tuple[str, str], list[httpx.Response]] = field(default_factory=dict)
    token_error: str = ""
    google_scope: str = GOOGLE_SCOPES
    google_account: tuple[str, str] = ("g-user-1", "jordan@gmail.test")
    microsoft_account: tuple[str, str] = ("m-user-1", "jordan@outlook.test")
    google_calendars: set[str] = field(default_factory=set)
    google_events: dict[str, dict[str, Any]] = field(default_factory=dict)
    google_deleted: set[str] = field(default_factory=set)
    google_busy: list[tuple[str, str]] = field(default_factory=list)
    microsoft_calendars: set[str] = field(default_factory=set)
    microsoft_events: dict[str, dict[str, Any]] = field(default_factory=dict)
    microsoft_transactions: dict[str, str] = field(default_factory=dict)
    microsoft_view: list[dict[str, Any]] = field(default_factory=list)
    refresh_tokens_used: list[str] = field(default_factory=list)
    _ids: Iterator[int] = field(default_factory=lambda: itertools.count(1))

    def fail_next(self, method: str, path: str, *responses: httpx.Response) -> None:
        """Answer the next calls whose path contains `path` with `responses`, in order."""
        self.failures.setdefault((method, path), []).extend(responses)

    def calls(self, method: str, path: str) -> list[httpx.Request]:
        """Requests made with this method whose path contains `path`."""
        return [r for r in self.requests if r.method == method and path in r.url.path]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for (method, path), queued in self.failures.items():
            if queued and request.method == method and path in request.url.path:
                return queued.pop(0)
        host = request.url.host
        if host == "oauth2.googleapis.com":
            return self._google_oauth(request)
        if host == "openidconnect.googleapis.com":
            account_id, email = self.google_account
            return _json(200, {"sub": account_id, "email": email})
        if host == "www.googleapis.com":
            return self._google_api(request)
        if host == "login.microsoftonline.com":
            return self._microsoft_token(request)
        if host == "graph.microsoft.com":
            return self._graph(request)
        return _json(404, {"error": "unknown host"})

    # --- Google ---------------------------------------------------------------------------

    def _google_oauth(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/revoke":
            return _json(200, {})
        form = _form(request)
        if form["grant_type"] == "authorization_code":
            if form.get("code") != "good-code" or not form.get("code_verifier"):
                return _json(400, {"error": "invalid_grant"})
            return _json(
                200,
                {
                    "access_token": "g-access-0",
                    "expires_in": 3599,
                    "refresh_token": "g-refresh",
                    "scope": self.google_scope,
                    "token_type": "Bearer",
                },
            )
        self.refresh_tokens_used.append(form["refresh_token"])
        if self.token_error:
            return _json(400, {"error": self.token_error, "error_description": "Bad Request"})
        return _json(
            200,
            {
                "access_token": f"g-access-{next(self._ids)}",
                "expires_in": 3599,
                "scope": self.google_scope,
            },
        )

    def _google_api(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix(GOOGLE_API)
        parts = path.strip("/").split("/")
        method = request.method
        if path == "/freeBusy":
            body = json.loads(request.content)
            busy = [
                {"start": start, "end": end}
                for start, end in self.google_busy
                if start < body["timeMax"] and end > body["timeMin"]
            ]
            return _json(200, {"calendars": {item["id"]: {"busy": busy} for item in body["items"]}})
        if path == "/calendars" and method == "POST":
            calendar_id = f"synari-{next(self._ids)}@group.calendar.google.com"
            self.google_calendars.add(calendar_id)
            return _json(
                200, {"id": calendar_id, "summary": json.loads(request.content)["summary"]}
            )
        calendar_id = parts[1]
        if len(parts) == 2:
            if calendar_id not in self.google_calendars:
                return _json(404, {"error": {"code": 404, "message": "Not Found"}})
            if method == "DELETE":
                self.google_calendars.discard(calendar_id)
                return _json(204)
            return _json(200, {"id": calendar_id})
        if calendar_id not in self.google_calendars:
            return _json(404, {"error": {"code": 404, "message": "Not Found"}})
        if len(parts) == 3 and method == "POST":
            body = json.loads(request.content)
            if body["id"] in self.google_events or body["id"] in self.google_deleted:
                return _json(
                    409,
                    {"error": {"code": 409, "message": "The requested identifier already exists."}},
                )
            self.google_events[body["id"]] = body
            return _json(200, body)
        event_id = parts[3]
        if method == "PATCH":
            if event_id not in self.google_events and event_id not in self.google_deleted:
                return _json(404, {"error": {"code": 404, "message": "Not Found"}})
            self.google_deleted.discard(event_id)
            self.google_events[event_id] = {
                **self.google_events.get(event_id, {}),
                **json.loads(request.content),
            }
            return _json(200, self.google_events[event_id])
        if method == "DELETE":
            if event_id in self.google_deleted:
                return _json(410, {"error": {"code": 410, "message": "Resource has been deleted"}})
            if event_id not in self.google_events:
                return _json(404, {"error": {"code": 404, "message": "Not Found"}})
            del self.google_events[event_id]
            self.google_deleted.add(event_id)
            return _json(204)
        return _json(405, {"error": {"code": 405, "message": "Unexpected call"}})

    # --- Microsoft ------------------------------------------------------------------------

    def _microsoft_token(self, request: httpx.Request) -> httpx.Response:
        form = _form(request)
        if form["grant_type"] == "authorization_code":
            if form.get("code") != "good-code" or not form.get("code_verifier"):
                return _json(400, {"error": "invalid_grant"})
            return _json(
                200,
                {
                    "access_token": "m-access-0",
                    "refresh_token": "m-refresh-0",
                    "expires_in": 3600,
                    "scope": MICROSOFT_SCOPES,
                },
            )
        self.refresh_tokens_used.append(form["refresh_token"])
        if self.token_error:
            return _json(400, {"error": self.token_error, "error_description": "AADSTS70000"})
        number = next(self._ids)
        return _json(
            200,
            {
                "access_token": f"m-access-{number}",
                "refresh_token": f"m-refresh-{number}",
                "expires_in": 3600,
                "scope": MICROSOFT_SCOPES,
            },
        )

    def _graph(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix(GRAPH)
        method = request.method
        missing = _json(404, {"error": {"code": "ErrorItemNotFound", "message": "Not found"}})
        if path == "/me":
            account_id, email = self.microsoft_account
            return _json(200, {"id": account_id, "mail": email, "userPrincipalName": email})
        if path == "/me/calendarView":
            return _json(200, {"value": self.microsoft_view})
        if path == "/me/calendars":
            if method == "POST":
                calendar_id = f"AAMk-synari-{next(self._ids)}"
                self.microsoft_calendars.add(calendar_id)
                return _json(201, {"id": calendar_id, "name": "Synari"})
            listed = [{"id": "AAMk-default", "name": "Calendar", "isDefaultCalendar": True}]
            listed += [
                {"id": calendar_id, "name": "Synari", "isDefaultCalendar": False}
                for calendar_id in sorted(self.microsoft_calendars)
            ]
            return _json(200, {"value": listed})
        parts = path.strip("/").split("/")
        if parts[1] == "calendars":
            calendar_id = parts[2]
            if calendar_id not in self.microsoft_calendars:
                return missing
            if len(parts) == 3:
                if method == "DELETE":
                    self.microsoft_calendars.discard(calendar_id)
                    return _json(204)
                return _json(200, {"id": calendar_id})
            if parts[3] == "calendarView":
                return _json(200, {"value": self.microsoft_view})
            body = json.loads(request.content)
            existing = self.microsoft_transactions.get(body["transactionId"])
            if existing in self.microsoft_events:
                return _json(201, {"id": existing, **self.microsoft_events[existing]})
            event_id = f"evt-{next(self._ids)}"
            self.microsoft_transactions[body["transactionId"]] = event_id
            self.microsoft_events[event_id] = body
            return _json(201, {"id": event_id, **body})
        event_id = parts[2]
        if event_id not in self.microsoft_events:
            return missing
        if method == "PATCH":
            self.microsoft_events[event_id] = {
                **self.microsoft_events[event_id],
                **json.loads(request.content),
            }
            return _json(200, {"id": event_id, **self.microsoft_events[event_id]})
        del self.microsoft_events[event_id]
        return _json(204)


def use_fake_calendars(monkeypatch: pytest.MonkeyPatch) -> FakeCalendars:
    """Configure both providers and route every provider call to a FakeCalendars."""
    fake = FakeCalendars()
    for name, value in {
        "google_oauth_client_id": "google-client",
        "google_oauth_client_secret": "google-secret",
        "microsoft_oauth_client_id": "microsoft-client",
        "microsoft_oauth_client_secret": "microsoft-secret",
        "microsoft_oauth_tenant": "common",
        "public_api_url": "https://api.test",
    }.items():
        monkeypatch.setattr(settings, name, value)

    def client(timeout: float = providers.TIMEOUT_SECONDS) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(fake), timeout=timeout)

    monkeypatch.setattr(providers, "http_client", client)
    return fake


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")
