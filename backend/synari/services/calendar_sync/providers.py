"""What the Google and Microsoft calendar clients share: result types, errors and HTTP handling.

Call `providers.http_client()` through the module (not a copied name) so tests can swap in a
client on an httpx.MockTransport.
"""

import hashlib
import json
from collections.abc import Callable, Collection
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from enum import StrEnum
from typing import Any

import httpx

from synari.db import utcnow

TIMEOUT_SECONDS = 20.0
# The Synari calendar created in each connected account.
CALENDAR_NAME = "Synari"
# How providers name the account's main calendar in busy-calendar lists.
PRIMARY_CALENDAR = "primary"
_MESSAGE_LIMIT = 300

Interval = tuple[datetime, datetime]


def http_client(timeout: float = TIMEOUT_SECONDS) -> httpx.Client:
    """An HTTP client for provider calls; close it after use (it's a context manager)."""
    return httpx.Client(timeout=timeout)


class ErrorKind(StrEnum):
    """How to react to a failed provider call."""

    TRANSIENT = "transient"  # throttling, outages, network errors: retry with backoff
    UNAUTHORIZED = "unauthorized"  # the access token was rejected: refresh and retry
    REAUTH = "reauth"  # the grant is gone (revoked, expired): the user must reconnect
    NOT_FOUND = "not_found"  # the event or calendar doesn't exist (404/410)
    CONFLICT = "conflict"  # an id is already taken (409)
    PERMANENT = "permanent"  # anything else: retrying won't help


class ProviderError(Exception):
    """A provider call failed. The message is the provider's (never contains our content)."""

    def __init__(
        self, message: str, kind: ErrorKind, *, retry_after: timedelta | None = None
    ) -> None:
        super().__init__(message[:_MESSAGE_LIMIT])
        self.kind = kind
        self.retry_after = retry_after


@dataclass(frozen=True)
class TokenGrant:
    """Tokens from an authorization-code exchange or a refresh."""

    access_token: str
    expires_at: datetime
    # Only when the provider issued one (always on connect; Microsoft rotates it on refresh).
    refresh_token: str | None
    scopes: frozenset[str]


@dataclass(frozen=True)
class Account:
    """Who signed in at the provider."""

    account_id: str
    email: str


@dataclass(frozen=True)
class CalendarInfo:
    """A calendar in the connected account that can block availability."""

    calendar_id: str
    name: str


@dataclass(frozen=True)
class EventPayload:
    """Everything Synari writes about one appointment: a PHI-free title and the times."""

    appointment_id: int
    title: str
    starts_at: datetime
    ends_at: datetime
    tentative: bool

    def digest(self) -> str:
        """Hash of the event's content, to skip pushing unchanged events."""
        values = asdict(self)
        values["starts_at"] = self.starts_at.isoformat()
        values["ends_at"] = self.ends_at.isoformat()
        return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def utc_iso(moment: datetime) -> str:
    """RFC 3339 in UTC with a Z suffix, e.g. 2026-09-27T14:00:00Z."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def expires_at(payload: dict[str, Any]) -> datetime:
    """When an access token from a token response expires (a minute early, to be safe)."""
    seconds = int(payload.get("expires_in") or 3600)
    return utcnow() + timedelta(seconds=max(seconds - 60, 0))


def merge_intervals(intervals: Collection[Interval]) -> list[Interval]:
    """Sorted intervals with overlapping and touching ones combined."""
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _retry_after(response: httpx.Response) -> timedelta | None:
    value = response.headers.get("retry-after")
    if not value:
        return None
    if value.strip().isdigit():
        return timedelta(seconds=int(value))
    try:
        return max(parsedate_to_datetime(value) - utcnow(), timedelta(0))
    except (TypeError, ValueError):
        return None


def _body(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def error_message(response: httpx.Response) -> str:
    """The provider's own explanation of a failed call."""
    body = _body(response)
    error = body.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("code")
        if message:
            return f"{response.status_code}: {message}"
    if isinstance(error, str):
        description = body.get("error_description", "")
        first_line = description.splitlines()[0] if description else ""
        return f"{response.status_code}: {error}" + (f" ({first_line})" if first_line else "")
    return f"{response.status_code}: {response.reason_phrase}"


def _is_rate_limited(response: httpx.Response) -> bool:
    """Google reports some quota errors as 403 with a rate-limit reason."""
    error = _body(response).get("error")
    if not isinstance(error, dict):
        return False
    reasons = {item.get("reason") for item in error.get("errors") or [] if isinstance(item, dict)}
    return bool(reasons & {"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"})


def classify(response: httpx.Response) -> ErrorKind:
    """What a failed API response means for retrying."""
    status_code = response.status_code
    if status_code in (404, 410):
        return ErrorKind.NOT_FOUND
    if status_code == 409:
        return ErrorKind.CONFLICT
    if status_code == 401:
        return ErrorKind.UNAUTHORIZED
    if status_code == 429 or status_code >= 500:
        return ErrorKind.TRANSIENT
    if status_code == 403 and _is_rate_limited(response):
        return ErrorKind.TRANSIENT
    return ErrorKind.PERMANENT


def send(http: httpx.Client, method: str, url: str, **kwargs: Any) -> httpx.Response:
    """Make an API call; raise ProviderError unless it succeeded."""
    try:
        response = http.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        raise ProviderError(
            f"Couldn't reach the calendar service: {exc}", ErrorKind.TRANSIENT
        ) from exc
    if response.is_success:
        return response
    raise ProviderError(
        error_message(response), classify(response), retry_after=_retry_after(response)
    )


# OAuth token-endpoint errors that mean the user has to sign in again.
_REAUTH_ERRORS = frozenset({"invalid_grant", "interaction_required", "consent_required"})


def token_request(http: httpx.Client, url: str, form: dict[str, str]) -> dict[str, Any]:
    """POST to an OAuth token endpoint; a revoked or expired grant raises a REAUTH error."""
    try:
        response = http.post(url, data=form, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise ProviderError(
            f"Couldn't reach the sign-in service: {exc}", ErrorKind.TRANSIENT
        ) from exc
    if response.is_success:
        return _body(response)
    if response.status_code >= 500 or response.status_code == 429:
        kind = ErrorKind.TRANSIENT
    elif _body(response).get("error") in _REAUTH_ERRORS:
        kind = ErrorKind.REAUTH
    else:
        kind = ErrorKind.PERMANENT
    raise ProviderError(error_message(response), kind, retry_after=_retry_after(response))


def json_of(response: httpx.Response) -> dict[str, Any]:
    """A successful response's JSON object (empty when there's no body)."""
    return _body(response)


def required_id(data: dict[str, Any]) -> str:
    """The `id` a provider must send back; a malformed answer is an error, not a crash."""
    value = data.get("id")
    if not value:
        raise ProviderError("The calendar service's answer had no id", ErrorKind.PERMANENT)
    return str(value)


def parse_busy[T](items: list[T], parse: Callable[[T], Interval | None]) -> list[Interval]:
    """Busy intervals from a provider's list, `parse` returning None for ones to skip. A
    malformed item is an error, not a crash."""
    intervals: list[Interval] = []
    for item in items:
        try:
            interval = parse(item)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ProviderError(
                "The calendar service sent busy times Synari couldn't read", ErrorKind.PERMANENT
            ) from exc
        if interval is not None:
            intervals.append(interval)
    return intervals
