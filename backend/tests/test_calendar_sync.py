"""Calendar sync with Google and Microsoft: connecting, pushing PHI-free events, polling busy
times, availability, staff warnings, failures and who may do what."""

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import SessionLocal, utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AuditEvent,
    CalendarConnection,
    CalendarEventLink,
    Client,
    ExternalBusyBlock,
    Notification,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    BookingSource,
    CalendarConnectionStatus,
    StaffRole,
)
from synari.services.calendar_sync.busy import poll_external_busy
from synari.services.calendar_sync.hooks import appointment_changed
from synari.services.calendar_sync.providers import EventPayload, merge_intervals
from synari.services.calendar_sync.push import event_title, sync_calendar_events
from synari.worker import JOBS
from tests.calendar_fakes import FakeCalendars, iso, use_fake_calendars
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    create_client_record,
    outbound_to,
    register_practice,
)
from tests.test_booking import SLUG, _day, _open_booking, _request_body, _service, _slots

GOOGLE_APP_SCOPE = "https://www.googleapis.com/auth/calendar.app.created"
GOOGLE_FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy"


@pytest.fixture(autouse=True)
def no_calendar_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests start without Google or Microsoft, whatever the developer's .env says."""
    for name in (
        "google_oauth_client_id",
        "google_oauth_client_secret",
        "microsoft_oauth_client_id",
        "microsoft_oauth_client_secret",
    ):
        monkeypatch.setattr(settings, name, "")


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeCalendars:
    return use_fake_calendars(monkeypatch)


# --- helpers ---------------------------------------------------------------------------------


def _start_connect(api: TestClient, account: StaffAccount, provider: str) -> dict[str, str]:
    response = api.get(f"/api/calendar-sync/{provider}/connect", headers=account.headers)
    assert response.status_code == 200, response.text
    return {
        key: values[0] for key, values in parse_qs(urlparse(response.json()["url"]).query).items()
    }


def _callback(api: TestClient, provider: str, **params: str) -> dict[str, str]:
    """Hit the OAuth callback; return the query of the Settings page it redirects to."""
    response = api.get(
        f"/api/calendar-sync/{provider}/callback", params=params, follow_redirects=False
    )
    assert response.status_code == 303, response.text
    location = urlparse(response.headers["location"])
    assert (
        f"{location.scheme}://{location.netloc}{location.path}" == "http://app.test/portal/settings"
    )
    return {key: values[0] for key, values in parse_qs(location.query).items()}


def _connect(api: TestClient, account: StaffAccount, provider: str = "google") -> dict[str, str]:
    state = _start_connect(api, account, provider)["state"]
    return _callback(api, provider, state=state, code="good-code")


def _connection(db: Session, staff_id: int, provider: str = "google") -> CalendarConnection:
    db.expire_all()
    return db.scalars(
        select(CalendarConnection).where(
            CalendarConnection.staff_id == staff_id, CalendarConnection.provider == provider
        )
    ).one()


def _links(db: Session, appointment_id: int | None = None) -> list[CalendarEventLink]:
    db.expire_all()
    query = select(CalendarEventLink).order_by(CalendarEventLink.id)
    if appointment_id is not None:
        query = query.where(CalendarEventLink.appointment_id == appointment_id)
    return list(db.scalars(query))


def _push(now: datetime | None = None) -> None:
    with SessionLocal() as session:
        sync_calendar_events(session, now or utcnow())


def _poll(now: datetime | None = None) -> None:
    with SessionLocal() as session:
        poll_external_busy(session, now or utcnow())


def _at(days: int = 2, hour: int = 15) -> datetime:
    return (utcnow() + timedelta(days=days)).replace(hour=hour, minute=0, second=0, microsecond=0)


def _book(
    api: TestClient, account: StaffAccount, client_id: int, starts_at: datetime, **fields: Any
) -> dict[str, Any]:
    body = {
        "participants": [{"client_id": client_id}],
        "starts_at": starts_at.isoformat(),
        "duration_minutes": 50,
        **fields,
    }
    response = api.post("/api/appointments", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()[0]


def _google_id(connection_id: int, appointment_id: int) -> str:
    return f"s{connection_id:08x}{appointment_id:012x}"


def _body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


def _form(request: httpx.Request) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(request.content.decode()).items()}


def _audits(db: Session, action: str) -> list[AuditEvent]:
    db.expire_all()
    return list(db.scalars(select(AuditEvent).where(AuditEvent.action == action)))


def _colleague(
    db: Session, account: StaffAccount, email: str = "riley@example.com"
) -> StaffAccount:
    return add_staff(
        db, account.practice_id, email, StaffRole.CLINICIAN, first_name="Riley", last_name="Chen"
    )


# --- connecting ------------------------------------------------------------------------------


def test_connecting_google_uses_pkce_and_creates_the_synari_calendar(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    query = _start_connect(api, clinician, "google")
    assert query["client_id"] == "google-client"
    assert query["redirect_uri"] == "https://api.test/api/calendar-sync/google/callback"
    assert set(query["scope"].split()) == {
        "openid",
        "email",
        GOOGLE_APP_SCOPE,
        GOOGLE_FREEBUSY_SCOPE,
    }
    assert (query["access_type"], query["prompt"]) == ("offline", "consent")
    assert query["code_challenge_method"] == "S256"

    outcome = _callback(api, "google", state=query["state"], code="good-code")

    assert outcome == {"tab": "availability", "calendar_sync": "connected", "provider": "google"}
    verifier = _form(fake.calls("POST", "/token")[0])["code_verifier"]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    assert challenge.decode() == query["code_challenge"]
    assert verifier not in query["state"]  # the verifier never goes through the browser
    connection = _connection(db, clinician.id)
    assert connection.account_email == "jordan@gmail.test"
    assert connection.provider_account_id == "g-user-1"
    assert connection.write_calendar_id in fake.google_calendars
    assert connection.busy_calendar_ids == ["primary"]
    assert connection.status == CalendarConnectionStatus.ACTIVE
    stored = db.execute(text("SELECT refresh_token, access_token FROM calendar_connections")).one()
    assert all(value.startswith("enc:v1:") for value in stored)
    assert "g-refresh" not in stored[0]
    assert len(_audits(db, "calendar_sync.connect")) == 1

    listed = api.get("/api/calendar-sync/connections", headers=clinician.headers).json()
    assert [(c["provider"], c["account_email"], c["status"]) for c in listed] == [
        ("google", "jordan@gmail.test", "active")
    ]


def _expired_state(staff_id: int) -> str:
    now = utcnow()
    claims = {
        "type": "calendar_connect",
        "sub": str(staff_id),
        "ver": 0,
        "provider": "google",
        "nonce": "n",
        "iat": now - timedelta(minutes=20),
        "exp": now - timedelta(minutes=10),
    }
    return jwt.encode(claims, settings.secret_key, algorithm="HS256")


@pytest.mark.parametrize("case", ["garbage", "expired", "other_provider", "signed_out"])
def test_callback_trusts_only_a_valid_state(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars, case: str
) -> None:
    provider = "google"
    state = _start_connect(api, clinician, "google")["state"]
    if case == "garbage":
        state = state[:-4] + "abcd"
    elif case == "expired":
        state = _expired_state(clinician.id)
    elif case == "other_provider":
        provider = "microsoft"
    else:
        db.get_one(StaffMember, clinician.id).token_version += 1
        db.commit()

    outcome = _callback(api, provider, state=state, code="good-code")

    assert (outcome["calendar_sync"], outcome["reason"]) == ("error", "expired")
    assert fake.calls("POST", "/token") == []
    assert db.scalars(select(CalendarConnection)).all() == []


def test_callback_reports_denied_consent_and_missing_scopes(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    state = _start_connect(api, clinician, "google")["state"]
    assert _callback(api, "google", state=state, error="access_denied")["reason"] == "denied"

    fake.google_scope = f"openid email {GOOGLE_FREEBUSY_SCOPE}"  # calendar access unticked
    state = _start_connect(api, clinician, "google")["state"]
    assert _callback(api, "google", state=state, code="good-code")["reason"] == "scopes"
    assert db.scalars(select(CalendarConnection)).all() == []


def test_reconnecting_reuses_the_connection_and_its_calendar(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    first = _connection(db, clinician.id)
    connection_id, calendar_id = first.id, first.write_calendar_id
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    _push()
    first.status = CalendarConnectionStatus.NEEDS_REAUTH
    db.commit()

    _connect(api, clinician)

    again = _connection(db, clinician.id)
    assert (again.id, again.write_calendar_id) == (connection_id, calendar_id)
    assert again.status == CalendarConnectionStatus.ACTIVE
    assert len(fake.google_calendars) == 1
    _push()
    assert len(fake.calls("POST", "/events")) == 1  # the event wasn't created twice
    assert _audits(db, "calendar_sync.connect")[-1].detail == {
        "provider": "google",
        "reconnected": True,
    }

    # Another Google account starts over with a new Synari calendar.
    fake.google_account = ("g-user-2", "jordan.work@gmail.test")
    _connect(api, clinician)
    other = _connection(db, clinician.id)
    assert other.id == connection_id
    assert other.write_calendar_id != calendar_id
    _push()
    assert _google_id(other.id, appointment["id"]) in fake.google_events
    assert len(fake.calls("POST", "/events")) == 2


def test_connect_is_for_clinicians_on_a_configured_provider(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    unconfigured = api.get("/api/calendar-sync/google/connect", headers=clinician.headers)
    assert unconfigured.status_code == 409
    settings_view = api.get("/api/calendar-sync/settings", headers=clinician.headers).json()
    assert [p["enabled"] for p in settings_view["providers"]] == [False, False]

    use_fake_calendars(monkeypatch)
    scheduler = add_staff(db, clinician.practice_id, "sky@example.com", StaffRole.SCHEDULER)
    denied = api.get("/api/calendar-sync/google/connect", headers=scheduler.headers)
    assert denied.status_code == 403
    assert api.get("/api/calendar-sync/nope/connect", headers=clinician.headers).status_code == 422


# --- pushing events --------------------------------------------------------------------------


def test_appointments_sync_as_phi_free_events_through_their_lifecycle(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    connection = _connection(db, clinician.id)
    client = create_client_record(db, clinician)
    starts_at = _at()
    appointment = _book(
        api,
        clinician,
        client.id,
        starts_at,
        memo="Discussed panic attacks",
        location_type="in_person",
        location_details="Room 4",
    )
    assert [link.state for link in _links(db, appointment["id"])] == ["pending"]

    _push()

    event_id = _google_id(connection.id, appointment["id"])
    event = fake.google_events[event_id]
    assert event["summary"] == "Appointment"
    assert event["start"] == {"dateTime": iso(starts_at)}
    assert event["end"] == {"dateTime": iso(starts_at + timedelta(minutes=50))}
    assert (event["visibility"], event["transparency"], event["status"]) == (
        "private",
        "opaque",
        "confirmed",
    )
    assert event["extendedProperties"] == {
        "private": {"synariAppointmentId": str(appointment["id"])}
    }
    assert not {"description", "location", "attendees", "conferenceData"} & set(event)
    insert = fake.calls("POST", "/events")[0]
    assert insert.url.params["sendUpdates"] == "none"
    for secret in ("Alex", "Rivera", "panic", "Room 4"):
        assert secret not in insert.content.decode()
    assert [link.state for link in _links(db, appointment["id"])] == ["synced"]

    # Nothing changed: no calls.
    calls = len(fake.requests)
    _push()
    assert len(fake.requests) == calls

    # A new time is patched in.
    moved = starts_at + timedelta(hours=2)
    response = api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"starts_at": moved.isoformat()},
        headers=clinician.headers,
    )
    assert response.status_code == 200, response.text
    _push()
    assert fake.google_events[event_id]["start"] == {"dateTime": iso(moved)}
    assert fake.calls("PATCH", f"/events/{event_id}")[0].url.params["sendUpdates"] == "none"

    # Canceling removes it; scheduling it again restores the same event id.
    canceled = api.post(
        f"/api/appointments/{appointment['id']}/cancel",
        json={"notify_client": False},
        headers=clinician.headers,
    )
    assert canceled.status_code == 200
    _push()
    assert event_id not in fake.google_events
    assert _links(db, appointment["id"]) == []

    restored = api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"status": "scheduled"},
        headers=clinician.headers,
    )
    assert restored.status_code == 200
    _push()
    assert fake.google_events[event_id]["status"] == "confirmed"

    # Deleting the appointment deletes the event.
    deleted = api.delete(f"/api/appointments/{appointment['id']}", headers=clinician.headers)
    assert deleted.status_code == 204
    assert [link.state for link in _links(db)] == ["deleting"]
    _push()
    assert event_id not in fake.google_events
    assert _links(db) == []


def test_events_show_busy_and_initials_only_when_the_practice_allows(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    connection = _connection(db, clinician.id)
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    event = api.post(
        "/api/appointments",
        json={
            "kind": "event",
            "title": "Consult about Alex",
            "starts_at": _at(hour=18).isoformat(),
            "duration_minutes": 30,
        },
        headers=clinician.headers,
    ).json()[0]
    _push()
    assert fake.google_events[_google_id(connection.id, event["id"])]["summary"] == "Busy"
    appointment_event = _google_id(connection.id, appointment["id"])
    assert fake.google_events[appointment_event]["summary"] == "Appointment"

    colleague = _colleague(db, clinician)
    forbidden = api.patch(
        "/api/calendar-sync/settings", json={"include_initials": True}, headers=colleague.headers
    )
    assert forbidden.status_code == 403
    allowed = api.patch(
        "/api/calendar-sync/settings", json={"include_initials": True}, headers=clinician.headers
    )
    assert allowed.status_code == 200
    assert allowed.json()["include_initials"] is True
    assert _audits(db, "practice.settings_update")[-1].detail == {
        "fields": ["calendar_include_initials"]
    }
    _push()
    assert fake.google_events[appointment_event]["summary"] == "Appointment (A.R.)"
    assert fake.google_events[_google_id(connection.id, event["id"])]["summary"] == "Busy"


@pytest.mark.parametrize(
    ("kind", "names", "include", "expected"),
    [
        (AppointmentKind.EVENT, [], True, "Busy"),
        (AppointmentKind.APPOINTMENT, [("Alex", "Rivera")], False, "Appointment"),
        (AppointmentKind.APPOINTMENT, [("Alex", "Rivera")], True, "Appointment (A.R.)"),
        (
            AppointmentKind.APPOINTMENT,
            [("Alex", "Rivera"), ("Sam", "Lee"), ("Kai", "Ono"), ("Bo", "Yu"), ("Ty", "")],
            True,
            "Appointment (A.R., S.L., K.O. +2)",
        ),
    ],
)
def test_event_titles(
    kind: str, names: list[tuple[str, str]], include: bool, expected: str
) -> None:
    entry = Appointment(
        kind=kind,
        participants=[
            AppointmentParticipant(client=Client(first_name=first, last_name=last))
            for first, last in names
        ],
    )
    assert event_title(entry, include) == expected


def test_moving_an_appointment_moves_its_event_between_calendars(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    colleague = _colleague(db, clinician)
    _connect(api, clinician, "google")
    fake.microsoft_account = ("m-riley", "riley@outlook.test")
    _connect(api, colleague, "microsoft")
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    _push()
    google = _connection(db, clinician.id)
    assert _google_id(google.id, appointment["id"]) in fake.google_events

    response = api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"clinician_id": colleague.id},
        headers=clinician.headers,
    )
    assert response.status_code == 200, response.text
    _push()

    assert fake.google_events == {}
    microsoft = _connection(db, colleague.id, "microsoft")
    (event,) = fake.microsoft_events.values()
    assert event["subject"] == "Appointment"
    assert (event["sensitivity"], event["showAs"]) == ("private", "busy")
    assert event["transactionId"] == f"synari-{microsoft.id}-{appointment['id']}-0"
    assert event["singleValueExtendedProperties"][0]["value"] == str(appointment["id"])
    assert not {"body", "location", "attendees", "onlineMeeting"} & set(event)
    assert [link.connection_id for link in _links(db, appointment["id"])] == [microsoft.id]


def test_microsoft_creates_are_idempotent_and_recreated_after_outside_deletion(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician, "microsoft")
    connection = _connection(db, clinician.id, "microsoft")
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    fake.fail_next("POST", "/events", httpx.Response(503, json={"error": {"code": "unavailable"}}))
    now = utcnow()

    _push(now)
    (link,) = _links(db, appointment["id"])
    assert (link.state, link.attempts) == ("pending", 1)
    assert link.next_attempt_at is not None and link.next_attempt_at > now
    _push(now + timedelta(minutes=5))

    creates = fake.calls("POST", "/events")
    assert {_body(request)["transactionId"] for request in creates} == {
        f"synari-{connection.id}-{appointment['id']}-0"
    }
    (event_id,) = fake.microsoft_events
    assert _links(db, appointment["id"])[0].external_event_id == event_id

    # Someone deletes it in Outlook; the next change creates a fresh event.
    del fake.microsoft_events[event_id]
    api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"duration_minutes": 80},
        headers=clinician.headers,
    )
    _push()
    (link,) = _links(db, appointment["id"])
    assert link.generation == 1
    assert _body(fake.calls("POST", "/events")[-1])["transactionId"].endswith("-1")
    assert link.external_event_id in fake.microsoft_events


def test_google_calendar_deleted_in_the_account_is_recreated(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    old_calendar = _connection(db, clinician.id).write_calendar_id
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    _push()
    fake.google_calendars.clear()
    fake.google_events.clear()
    api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"duration_minutes": 60},
        headers=clinician.headers,
    )

    _push()
    _push()

    connection = _connection(db, clinician.id)
    assert connection.write_calendar_id != old_calendar
    assert connection.write_calendar_id in fake.google_calendars
    assert _google_id(connection.id, appointment["id"]) in fake.google_events


def test_throttling_backs_off_and_permanent_failures_wait_for_sync_now(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    connection = _connection(db, clinician.id)
    client = create_client_record(db, clinician)
    first = _book(api, clinician, client.id, _at())
    second = _book(api, clinician, client.id, _at(days=3))
    fake.fail_next(
        "POST",
        "/events",
        httpx.Response(
            429, json={"error": {"message": "Rate Limit Exceeded"}}, headers={"Retry-After": "120"}
        ),
    )
    now = utcnow()

    _push(now)

    assert len(fake.calls("POST", "/events")) == 1  # stopped after being throttled
    throttled = _links(db, first["id"])[0]
    assert throttled.attempts == 1
    assert throttled.next_attempt_at is not None
    assert throttled.next_attempt_at >= now + timedelta(seconds=120)
    assert _links(db, second["id"])[0].attempts == 0

    _push(now + timedelta(minutes=3))
    assert [link.state for link in _links(db)] == ["synced", "synced"]

    third = _book(api, clinician, client.id, _at(days=4))
    fake.fail_next("POST", "/events", httpx.Response(400, json={"error": {"message": "Bad"}}))
    _push()
    assert _links(db, third["id"])[0].state == "failed"
    listed = api.get("/api/calendar-sync/connections", headers=clinician.headers).json()
    assert listed[0]["failed_events"] == 1

    resync = api.post(
        f"/api/calendar-sync/connections/{connection.id}/sync", headers=clinician.headers
    )
    assert resync.status_code == 200
    assert resync.json()["failed_events"] == 0
    _push()
    assert _google_id(connection.id, third["id"]) in fake.google_events


def test_imported_history_is_never_synced(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    client = create_client_record(db, clinician)
    imported = create_appointment(
        db, clinician, [client], starts_at=_at(), source=BookingSource.IMPORT
    )
    _connect(api, clinician)
    assert _links(db) == []

    appointment_changed(db, db.get_one(Appointment, imported.id))
    db.commit()
    assert _links(db) == []


# --- tokens ----------------------------------------------------------------------------------


def _expire_token(db: Session, staff_id: int, provider: str) -> None:
    connection = _connection(db, staff_id, provider)
    connection.access_expires_at = utcnow() - timedelta(minutes=1)
    db.commit()


def test_microsoft_refresh_tokens_rotate(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician, "microsoft")
    client = create_client_record(db, clinician)
    appointment = _book(api, clinician, client.id, _at())
    _expire_token(db, clinician.id, "microsoft")

    _push()

    assert fake.refresh_tokens_used == ["m-refresh-0"]
    rotated = _connection(db, clinician.id, "microsoft").refresh_token
    assert rotated not in (None, "m-refresh-0")
    assert len(fake.microsoft_events) == 1

    _expire_token(db, clinician.id, "microsoft")
    api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"duration_minutes": 30},
        headers=clinician.headers,
    )
    _push()
    assert fake.refresh_tokens_used == ["m-refresh-0", rotated]


def test_a_revoked_grant_pauses_sync_and_asks_once_to_reconnect(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    fake.google_busy = [(iso(_at()), iso(_at() + timedelta(hours=1)))]
    _poll()
    client = create_client_record(db, clinician)
    _book(api, clinician, client.id, _at(days=3))
    _expire_token(db, clinician.id, "google")
    fake.token_error = "invalid_grant"

    _push()

    connection = _connection(db, clinician.id)
    assert connection.status == CalendarConnectionStatus.NEEDS_REAUTH
    # (Only the calendar's notice: booking may also flag a good faith estimate, depending on
    # how many business days away the session is.)
    notifications = db.scalars(
        select(Notification).where(
            Notification.recipient_id == clinician.id, Notification.kind == "calendar_sync"
        )
    ).all()
    assert [n.link for n in notifications] == ["/portal/settings?tab=availability"]
    (email,) = outbound_to(db, clinician.email)
    assert email.subject == "Reconnect Google Calendar to Synari"
    assert "http://app.test/portal/settings?tab=availability" in email.body_text
    assert "Alex" not in email.body_text

    # Paused: no more provider calls, one notice, busy times kept.
    calls = len(fake.requests)
    _push()
    _poll(utcnow() + timedelta(hours=1))
    assert len(fake.requests) == calls
    assert len(outbound_to(db, clinician.email)) == 1
    assert len(db.scalars(select(ExternalBusyBlock)).all()) == 1
    assert [link.state for link in _links(db)] == ["pending"]

    fake.token_error = ""
    _connect(api, clinician)
    _push()
    assert [link.state for link in _links(db)] == ["synced"]


# --- busy times ------------------------------------------------------------------------------


def test_polling_replaces_busy_blocks_in_windows_google_accepts(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    start = _at()
    fake.google_busy = [
        (iso(start), iso(start + timedelta(hours=1))),
        (iso(start + timedelta(minutes=30)), iso(start + timedelta(hours=2))),
    ]
    now = utcnow()

    _poll(now)

    blocks = db.scalars(select(ExternalBusyBlock)).all()
    assert [(b.starts_at, b.ends_at) for b in blocks] == [(start, start + timedelta(hours=2))]
    windows = [_body(request) for request in fake.calls("POST", "/freeBusy")]
    assert len(windows) == 2  # 61 days, in windows of at most 60
    for window in windows:
        span = datetime.fromisoformat(window["timeMax"]) - datetime.fromisoformat(window["timeMin"])
        assert span <= timedelta(days=60)
        assert window["items"] == [{"id": "primary"}]
    assert _connection(db, clinician.id).last_busy_sync_at is not None

    fake.google_busy = [(iso(start + timedelta(days=1)), iso(start + timedelta(days=1, hours=1)))]
    _poll(now + timedelta(seconds=60))  # not due yet
    assert len(db.scalars(select(ExternalBusyBlock)).all()) == 1
    _poll(now + timedelta(seconds=settings.calendar_sync_interval_seconds + 1))
    db.expire_all()
    assert [b.starts_at for b in db.scalars(select(ExternalBusyBlock))] == [
        start + timedelta(days=1)
    ]


def test_microsoft_busy_times_count_busy_and_out_of_office_across_pages(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician, "microsoft")
    start = _at()

    def item(hours: int, show_as: str, canceled: bool = False) -> dict[str, Any]:
        begin = start + timedelta(hours=hours)
        return {
            "start": {"dateTime": begin.strftime("%Y-%m-%dT%H:%M:%S.0000000"), "timeZone": "UTC"},
            "end": {
                "dateTime": (begin + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.0000000"),
                "timeZone": "UTC",
            },
            "showAs": show_as,
            "isCancelled": canceled,
        }

    fake.fail_next(
        "GET",
        "/me/calendarView",
        httpx.Response(
            200,
            json={
                "value": [item(0, "busy"), item(2, "free")],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=2",
            },
        ),
    )
    fake.microsoft_view = [item(4, "oof"), item(6, "tentative"), item(8, "busy", canceled=True)]

    _poll()

    blocks = db.scalars(select(ExternalBusyBlock).order_by(ExternalBusyBlock.starts_at)).all()
    assert [b.starts_at for b in blocks] == [start, start + timedelta(hours=4)]
    first_page = fake.calls("GET", "/me/calendarView")[0]
    assert first_page.headers["Prefer"] == 'outlook.timezone="UTC"'
    assert first_page.url.params["$select"] == "start,end,showAs,isCancelled"


def test_online_booking_leaves_out_external_busy_times(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _open_booking(api, clinician)
    service = _service(api, clinician)
    day = _day()
    slots = _slots(api, clinician.id, service["id"], day)
    first = slots[0]
    _connect(api, clinician)
    begin = datetime.fromisoformat(first["starts_at"])
    fake.google_busy = [(iso(begin), iso(begin + timedelta(minutes=30)))]

    _poll()

    remaining = _slots(api, clinician.id, service["id"], day)
    assert first["starts_at"] not in [slot["starts_at"] for slot in remaining]
    assert len(remaining) == len(slots) - 1


def test_booking_rechecks_the_calendar_live_and_tolerates_outages(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _open_booking(api, clinician)
    service = _service(api, clinician)
    _connect(api, clinician)
    _poll()
    slot = _slots(api, clinician.id, service["id"], _day())[0]
    begin = datetime.fromisoformat(slot["starts_at"])
    fake.google_busy = [(iso(begin), iso(begin + timedelta(minutes=10)))]  # not polled yet

    taken = api.post(
        f"/api/booking/{SLUG}/requests", json=_request_body(clinician.id, service["id"], slot)
    )
    assert taken.status_code == 409

    fake.fail_next("POST", "/freeBusy", httpx.Response(503, json={}))
    accepted = api.post(
        f"/api/booking/{SLUG}/requests", json=_request_body(clinician.id, service["id"], slot)
    )
    assert accepted.status_code == 202, accepted.text
    _push()
    (event,) = fake.google_events.values()
    assert (event["summary"], event["status"]) == ("Appointment", "tentative")


def test_staff_scheduling_warns_about_external_busy_times_without_blocking(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    busy_start = _at()
    fake.google_busy = [(iso(busy_start), iso(busy_start + timedelta(hours=1)))]
    _poll()
    client = create_client_record(db, clinician)

    overlapping = _book(api, clinician, client.id, busy_start + timedelta(minutes=30))
    clear = _book(api, clinician, client.id, busy_start + timedelta(hours=3))

    assert overlapping["external_conflicts"] == [
        {
            "starts_at": iso(busy_start),
            "ends_at": iso(busy_start + timedelta(hours=1)),
        }
    ]
    assert clear["external_conflicts"] == []
    moved = api.patch(
        f"/api/appointments/{clear['id']}",
        json={"starts_at": (busy_start - timedelta(minutes=30)).isoformat()},
        headers=clinician.headers,
    )
    assert moved.status_code == 200, moved.text
    assert len(moved.json()[0]["external_conflicts"]) == 1


def test_busy_times_are_visible_to_whoever_manages_the_calendar(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    busy_start = _at()
    fake.google_busy = [(iso(busy_start), iso(busy_start + timedelta(hours=1)))]
    _poll()
    params = {
        "start": (busy_start - timedelta(days=1)).isoformat(),
        "end": (busy_start + timedelta(days=1)).isoformat(),
    }

    mine = api.get("/api/calendar-sync/busy", params=params, headers=clinician.headers)
    assert mine.status_code == 200
    assert [(b["clinician_id"], b["starts_at"]) for b in mine.json()] == [
        (clinician.id, iso(busy_start))
    ]
    assert set(mine.json()[0]) == {"id", "clinician_id", "starts_at", "ends_at"}

    colleague = _colleague(db, clinician)
    scheduler = add_staff(db, clinician.practice_id, "sky@example.com", StaffRole.SCHEDULER)
    theirs = {**params, "clinician_ids": clinician.id}
    assert (
        api.get("/api/calendar-sync/busy", params=theirs, headers=colleague.headers).status_code
        == 403
    )
    assert (
        len(api.get("/api/calendar-sync/busy", params=theirs, headers=scheduler.headers).json())
        == 1
    )
    assert api.get("/api/calendar-sync/busy", params=params, headers=scheduler.headers).json() == []

    other = register_practice(api, "casey@example.com")
    elsewhere = {**params, "clinician_ids": other.id}
    assert (
        api.get("/api/calendar-sync/busy", params=elsewhere, headers=clinician.headers).status_code
        == 404
    )
    too_long = {**params, "end": (busy_start + timedelta(days=90)).isoformat()}
    assert (
        api.get("/api/calendar-sync/busy", params=too_long, headers=clinician.headers).status_code
        == 422
    )


# --- managing connections --------------------------------------------------------------------


def test_only_the_clinician_manages_their_connection(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    connection = _connection(db, clinician.id)
    colleague = _colleague(db, clinician)
    manager = add_staff(db, clinician.practice_id, "pat@example.com", StaffRole.PRACTICE_MANAGER)
    base = f"/api/calendar-sync/connections/{connection.id}"

    for account in (colleague, manager):
        assert api.get("/api/calendar-sync/connections", headers=account.headers).json() == []
        assert (
            api.patch(
                base, json={"busy_calendar_ids": ["primary"]}, headers=account.headers
            ).status_code
            == 404
        )
        assert api.post(f"{base}/sync", headers=account.headers).status_code == 404
        assert api.get(f"{base}/calendars", headers=account.headers).status_code == 404
        assert api.delete(base, headers=account.headers).status_code == 404
    assert _connection(db, clinician.id).id == connection.id


def test_choosing_busy_calendars(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician, "microsoft")
    connection = _connection(db, clinician.id, "microsoft")
    _poll()
    base = f"/api/calendar-sync/connections/{connection.id}"

    calendars = api.get(f"{base}/calendars", headers=clinician.headers)
    assert calendars.json() == [{"id": "primary", "name": "Calendar"}]

    updated = api.patch(
        base,
        json={"busy_calendar_ids": ["primary", "AAMk-team", "primary"]},
        headers=clinician.headers,
    )
    assert updated.status_code == 200
    assert updated.json()["busy_calendar_ids"] == ["primary", "AAMk-team"]
    assert _connection(db, clinician.id, "microsoft").last_busy_sync_at is None

    own = api.patch(
        base, json={"busy_calendar_ids": [connection.write_calendar_id]}, headers=clinician.headers
    )
    assert own.status_code == 422
    assert (
        api.patch(base, json={"busy_calendar_ids": []}, headers=clinician.headers).status_code
        == 422
    )


def test_disconnecting_deletes_the_calendar_revokes_and_forgets_everything(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    _connect(api, clinician)
    connection = _connection(db, clinician.id)
    client = create_client_record(db, clinician)
    _book(api, clinician, client.id, _at())
    fake.google_busy = [(iso(_at(days=3)), iso(_at(days=3) + timedelta(hours=1)))]
    _push()
    _poll()

    response = api.delete(
        f"/api/calendar-sync/connections/{connection.id}",
        params={"delete_calendar": "true"},
        headers=clinician.headers,
    )

    assert response.status_code == 204
    assert fake.google_calendars == set()
    (revoke,) = fake.calls("POST", "/revoke")
    assert _form(revoke) == {"token": "g-refresh"}
    db.expire_all()
    assert db.scalars(select(CalendarConnection)).all() == []
    assert _links(db) == []
    assert db.scalars(select(ExternalBusyBlock)).all() == []
    (audit,) = _audits(db, "calendar_sync.disconnect")
    assert audit.detail == {"provider": "google", "calendar_deleted": True}


def test_deactivating_a_member_disconnects_their_calendars(
    api: TestClient, db: Session, clinician: StaffAccount, fake: FakeCalendars
) -> None:
    riley = _colleague(db, clinician)
    _connect(api, riley)
    client = create_client_record(db, clinician)
    _book(api, clinician, client.id, _at(), clinician_id=riley.id)
    _push()
    assert _links(db)

    response = api.post(f"/api/team/{riley.id}/deactivate", headers=clinician.headers)

    assert response.status_code == 200, response.text
    assert fake.google_calendars == set()  # the practice's appointments leave their account
    assert len(fake.calls("POST", "/revoke")) == 1
    db.expire_all()
    assert db.scalars(select(CalendarConnection)).all() == []
    assert _links(db) == []
    (audit,) = _audits(db, "team.deactivate")
    assert audit.detail == {"calendars_disconnected": 1}


def test_worker_runs_the_calendar_jobs() -> None:
    assert sync_calendar_events in JOBS
    assert poll_external_busy in JOBS


def test_event_payload_digest_changes_with_content() -> None:
    start = datetime(2026, 10, 1, 14, tzinfo=UTC)
    payload = EventPayload(1, "Appointment", start, start + timedelta(hours=1), tentative=False)
    same = EventPayload(1, "Appointment", start, start + timedelta(hours=1), tentative=False)
    later = EventPayload(1, "Appointment", start, start + timedelta(hours=2), tentative=False)
    assert payload.digest() == same.digest() != later.digest()
    assert merge_intervals([(start, start + timedelta(hours=1)), (start, start)]) == [
        (start, start + timedelta(hours=1))
    ]
