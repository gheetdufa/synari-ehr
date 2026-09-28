"""Telehealth: LiveKit tokens, join links, the waiting room and consent-gated recording."""

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from synari.api import telehealth as telehealth_api
from synari.config import settings
from synari.models import (
    Appointment,
    AuditEvent,
    Client,
    Notification,
    PracticeSettings,
    Recording,
    StoredFile,
    WaitingRoomEntry,
)
from synari.models.enums import AppointmentStatus, LocationType, Role, StaffRole
from synari.realtime import Recipient
from synari.services import storage
from synari.services.scheduling import new_video_room_name
from synari.services.video_links import create_join_token, decode_join_token, short_join_url
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)
from tests.test_notes import make_viewer

Event = tuple[list[Recipient], str, dict[str, Any]]


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[Event]:
    """Realtime events published by the telehealth router (still really published)."""
    recorded: list[Event] = []
    real_publish = telehealth_api.publish

    def spy(db: Session, recipients: Any, event_type: str, data: dict[str, Any]) -> None:
        recipients = list(recipients)
        recorded.append((recipients, event_type, data))
        real_publish(db, recipients, event_type, data)

    monkeypatch.setattr(telehealth_api, "publish", spy)
    return recorded


@pytest.fixture
def room_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, ...]]:
    """Record LiveKit server calls instead of making them."""
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        telehealth_api, "remove_participant", lambda room, who: calls.append(("remove", room, who))
    )
    monkeypatch.setattr(telehealth_api, "end_room", lambda room: calls.append(("end", room)))
    return calls


def _book(
    db: Session,
    clinician: StaffAccount,
    *clients: Client,
    starts_in: timedelta = timedelta(minutes=10),
    minutes: int = 50,
    video: bool = True,
) -> Appointment:
    """A session with `clients` on the clinician's calendar, set up directly in the database."""
    return create_appointment(
        db,
        clinician,
        list(clients),
        starts_at=datetime.now(UTC) + starts_in,
        minutes=minutes,
        location_type=LocationType.VIDEO if video else LocationType.IN_PERSON,
        video_room_name=new_video_room_name() if video else None,
    )


def _cancel(db: Session, appointment: Appointment) -> None:
    appointment.status = AppointmentStatus.CANCELED
    db.commit()


def _move(db: Session, appointment: Appointment, starts_at: datetime) -> None:
    duration = appointment.ends_at - appointment.starts_at
    appointment.starts_at = starts_at
    appointment.ends_at = starts_at + duration
    db.commit()


def _path(appointment: Appointment, action: str) -> str:
    return f"/api/telehealth/appointments/{appointment.id}/{action}"


def _join_links(
    api: TestClient, account: StaffAccount, appointment: Appointment
) -> list[dict[str, Any]]:
    response = api.get(_path(appointment, "join-links"), headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _join_token(
    api: TestClient, account: StaffAccount, appointment: Appointment, client: Client | None = None
) -> str:
    """The token in a client's join link (the first client's by default)."""
    links = _join_links(api, account, appointment)
    link = links[0] if client is None else next(x for x in links if x["client"]["id"] == client.id)
    return link["url"].rsplit("/", 1)[1]


def _enter(api: TestClient, token: str, **fields: Any) -> dict[str, Any]:
    body = {"display_name": "Alex", "recording_consent": True, **fields}
    response = api.post(f"/api/telehealth/join/{token}/enter", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _poll(api: TestClient, entry: dict[str, Any]) -> httpx.Response:
    return api.get(
        f"/api/telehealth/entries/{entry['entry_id']}", params={"secret": entry["secret"]}
    )


def _leave(api: TestClient, entry: dict[str, Any]) -> httpx.Response:
    return api.post(
        f"/api/telehealth/entries/{entry['entry_id']}/leave", params={"secret": entry["secret"]}
    )


def _entry_action(
    api: TestClient, account: StaffAccount, entry: dict[str, Any], action: str
) -> httpx.Response:
    return api.post(
        f"/api/telehealth/entries/{entry['entry_id']}/{action}", headers=account.headers
    )


def _livekit_claims(token: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        settings.livekit_api_secret,
        algorithms=["HS256"],
        issuer=settings.livekit_api_key,
    )


def _room_name(appointment: Appointment) -> str:
    assert appointment.video_room_name is not None
    return appointment.video_room_name


def _audit_actions(db: Session) -> list[str]:
    db.expire_all()
    return list(db.scalars(select(AuditEvent.action).order_by(AuditEvent.id)))


def _set_practice(db: Session, account: StaffAccount, **values: Any) -> None:
    db.execute(
        update(PracticeSettings)
        .where(PracticeSettings.practice_id == account.practice_id)
        .values(**values)
    )
    db.commit()


def _upload(
    api: TestClient,
    account: StaffAccount,
    appointment: Appointment,
    filename: str = "session.webm",
) -> httpx.Response:
    return api.post(
        _path(appointment, "recordings"),
        files={"file": (filename, b"\x1aE\xdf\xa3 audio", "audio/webm")},
        headers=account.headers,
    )


def _colleague(db: Session, owner: StaffAccount, email: str = "riley@example.com") -> StaffAccount:
    return add_staff(
        db, owner.practice_id, email, StaffRole.CLINICIAN, first_name="Riley", last_name="Chen"
    )


def test_host_token_grants_admin_access_to_the_room(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    response = api.post(_path(appointment, "host-token"), headers=clinician.headers)
    assert response.status_code == 200, response.text
    body = response.json()
    room_name = _room_name(appointment)
    assert body["room_name"] == room_name
    assert body["identity"] == f"clinician-{clinician.id}"
    assert body["livekit_url"] == "ws://livekit.test"

    claims = _livekit_claims(body["token"])
    assert claims["sub"] == f"clinician-{clinician.id}"
    assert claims["name"] == "Jordan Lee"
    assert claims["video"] == {
        "roomJoin": True,
        "roomAdmin": True,
        "room": room_name,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishData": True,
    }
    assert abs(claims["exp"] - claims["nbf"] - 4 * 3600) <= 2
    assert "telehealth.host_join" in _audit_actions(db)


@pytest.mark.parametrize(
    ("starts_in", "expected_status"),
    [
        (timedelta(minutes=61), 409),  # more than an hour early
        (timedelta(minutes=59), 200),
        (-timedelta(minutes=50 + 59), 200),  # ended 59 minutes ago
        (-timedelta(minutes=50 + 61), 409),  # ended more than an hour ago
    ],
)
def test_host_token_is_limited_to_the_session_window(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    starts_in: timedelta,
    expected_status: int,
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client, starts_in=starts_in, minutes=50)
    response = api.post(_path(appointment, "host-token"), headers=clinician.headers)
    assert response.status_code == expected_status, response.text


def test_host_token_rejections(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = create_client_record(db, clinician)
    in_person = _book(db, clinician, client, video=False)
    assert api.post(_path(in_person, "host-token"), headers=clinician.headers).status_code == 409
    video = _book(db, clinician, client)
    assert api.post(_path(video, "host-token"), headers=portal_headers(client)).status_code == 401

    _cancel(db, video)
    canceled = api.post(_path(video, "host-token"), headers=clinician.headers)
    assert canceled.status_code == 409
    assert canceled.json()["detail"] == "This appointment was canceled."

    monkeypatch.setattr(settings, "livekit_url", "")
    disabled = api.post(_path(video, "host-token"), headers=clinician.headers)
    assert disabled.status_code == 503
    assert disabled.json()["detail"] == "Telehealth isn't configured"


def test_join_info_is_public_and_free_of_client_details(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=clinician.headers)
    client = create_client_record(db, clinician, first_name="Alexandra", last_name="Quintero")
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)

    response = api.get(f"/api/telehealth/join/{token}")
    assert response.status_code == 200, response.text
    info = response.json()
    assert datetime.fromisoformat(info.pop("starts_at")) == appointment.starts_at
    assert datetime.fromisoformat(info.pop("ends_at")) == appointment.ends_at
    assert info == {
        "status": "open",
        "clinician_name": "Jordan Lee, LCSW",
        "practice_name": "Lee Counseling",
        "time_zone": "America/New_York",
        "waiting_room_enabled": True,
        "recording_enabled": False,
    }
    for private in ("Alexandra", "Quintero", "alex@example.com", "client"):
        assert private not in response.text

    assert api.get("/api/telehealth/join/not-a-token").status_code == 404
    access_token = clinician.data["access_token"]
    assert api.get(f"/api/telehealth/join/{access_token}").status_code == 404


def test_join_info_names_the_appointment_clinician_in_the_clients_time_zone(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    api.patch(
        "/api/me",
        json={"credentials": "LMFT", "time_zone": "America/Chicago"},
        headers=colleague.headers,
    )
    traveling = create_client_record(db, colleague, time_zone="America/Los_Angeles")
    local = create_client_record(db, colleague, email="sam@example.com")

    def info(client: Client) -> dict[str, Any]:
        token = _join_token(api, clinician, _book(db, colleague, client))
        return api.get(f"/api/telehealth/join/{token}").json()

    away = info(traveling)
    assert (away["clinician_name"], away["practice_name"]) == ("Riley Chen, LMFT", "Lee Counseling")
    assert away["time_zone"] == "America/Los_Angeles"
    assert info(local)["time_zone"] == "America/Chicago"


def test_join_status_follows_the_appointment(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client, starts_in=timedelta(hours=3))
    token = _join_token(api, clinician, appointment)

    def join_status() -> str:
        return api.get(f"/api/telehealth/join/{token}").json()["status"]

    def enter() -> httpx.Response:
        return api.post(f"/api/telehealth/join/{token}/enter", json={"display_name": "Alex"})

    assert join_status() == "too_early"
    too_early = enter()
    assert too_early.status_code == 409
    assert "60 minutes before" in too_early.json()["detail"]

    # Moved into the past: the link was issued for the later time, so it still decodes.
    _move(db, appointment, datetime.now(UTC) - timedelta(hours=3))
    assert join_status() == "ended"
    assert enter().status_code == 409

    _cancel(db, appointment)
    assert join_status() == "canceled"
    assert enter().json()["detail"] == "This appointment was canceled."
    assert api.get(_path(appointment, "join-links"), headers=clinician.headers).status_code == 409
    assert api.post(_path(appointment, "send-link"), headers=clinician.headers).status_code == 409

    in_person = _book(db, clinician, client, video=False)
    assert api.get(_path(in_person, "join-links"), headers=clinician.headers).status_code == 409


def test_waiting_room_admit_poll_and_leave(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)

    entry = _enter(
        api,
        token,
        display_name="  Alex R  ",
        current_location="12 Main St, Springfield",
        recording_consent=True,
    )
    assert entry["status"] == "waiting"
    row = db.get(WaitingRoomEntry, entry["entry_id"])
    assert row is not None
    assert row.display_name == "Alex R"
    assert row.client_id == client.id
    assert row.secret_hash == hashlib.sha256(entry["secret"].encode()).hexdigest()

    assert _poll(api, entry).json() == {
        "status": "waiting",
        "livekit_url": None,
        "token": None,
        "room_name": None,
    }
    wrong_secret = api.get(
        f"/api/telehealth/entries/{entry['entry_id']}", params={"secret": "guess"}
    )
    assert wrong_secret.status_code == 404
    assert api.get(f"/api/telehealth/entries/{entry['entry_id']}").status_code == 422

    listed = api.get(_path(appointment, "waiting-room"), headers=clinician.headers).json()
    assert len(listed) == 1
    assert listed[0]["id"] == entry["entry_id"]
    assert listed[0]["display_name"] == "Alex R"
    assert listed[0]["status"] == "waiting"
    assert listed[0]["current_location"] == "12 Main St, Springfield"
    assert listed[0]["client_id"] == client.id
    assert listed[0]["recording_consent"] is True
    assert listed[0]["admitted_at"] is None

    admitted = _entry_action(api, clinician, entry, "admit")
    assert admitted.status_code == 200, admitted.text
    assert admitted.json()["status"] == "admitted"
    assert admitted.json()["admitted_at"] is not None

    polled = _poll(api, entry).json()
    room_name = _room_name(appointment)
    assert polled["status"] == "admitted"
    assert polled["room_name"] == room_name
    assert polled["livekit_url"] == "ws://livekit.test"
    claims = _livekit_claims(polled["token"])
    assert claims["sub"] == f"guest-{entry['entry_id']}"
    assert claims["name"] == "Alex R"
    assert claims["video"] == {
        "roomJoin": True,
        "roomAdmin": False,
        "room": room_name,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishData": True,
    }
    # Short-lived: LiveKit refreshes tokens for connected guests.
    assert claims["exp"] - claims["nbf"] <= 10 * 60

    left = _leave(api, entry)
    assert left.status_code == 200
    assert left.json()["status"] == "left"
    assert _poll(api, entry).json()["token"] is None

    expected_event = (
        [(Role.STAFF, clinician.id)],
        "waiting_room.updated",
        {"appointment_id": appointment.id},
    )
    assert events == [expected_event] * 3  # enter, admit, leave
    actions = _audit_actions(db)
    for action in (
        "telehealth.enter",
        "telehealth.waiting_room_view",
        "telehealth.admit",
        "telehealth.leave",
    ):
        assert action in actions
    anonymous = db.scalars(
        select(AuditEvent).where(AuditEvent.action.in_(("telehealth.enter", "telehealth.leave")))
    ).all()
    assert {event.practice_id for event in anonymous} == {clinician.practice_id}


def test_arrivals_reach_the_clinician_over_websocket(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        assert websocket.receive_json() == {"type": "ready"}
        _enter(api, token)
        assert websocket.receive_json() == {
            "type": "waiting_room.updated",
            "data": {"appointment_id": appointment.id},
        }


def test_a_colleagues_waiting_room_reaches_only_that_colleague(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    colleague = _colleague(db, clinician)
    scheduler = add_staff(db, clinician.practice_id, "front@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, colleague)
    appointment = _book(db, colleague, client)
    # The scheduler shares the link; arrivals still go to the session's clinician only.
    entry = _enter(api, _join_token(api, scheduler, appointment))
    _entry_action(api, colleague, entry, "admit")
    assert [recipients for recipients, _, _ in events] == [[(Role.STAFF, colleague.id)]] * 2
    arrivals = db.scalars(select(Notification).where(Notification.kind == "telehealth_arrival"))
    assert [(n.recipient_role, n.recipient_id) for n in arrivals] == [(Role.STAFF, colleague.id)]


def test_practice_without_waiting_room_admits_on_arrival(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _set_practice(db, clinician, waiting_room_enabled=False)
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    assert api.get(f"/api/telehealth/join/{token}").json()["waiting_room_enabled"] is False

    entry = _enter(api, token)
    assert entry["status"] == "admitted"
    polled = _poll(api, entry).json()
    assert polled["status"] == "admitted"
    assert _livekit_claims(polled["token"])["video"]["room"] == _room_name(appointment)


def test_decline_and_admit_all(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    first, second, third = (_enter(api, token, display_name=name) for name in ("A", "B", "C"))

    declined = _entry_action(api, clinician, second, "decline")
    assert declined.status_code == 200
    assert declined.json()["status"] == "declined"
    assert _entry_action(api, clinician, second, "decline").status_code == 409
    assert _entry_action(api, clinician, second, "admit").status_code == 409

    admitted = api.post(_path(appointment, "admit-all"), headers=clinician.headers)
    assert admitted.status_code == 200
    assert [e["id"] for e in admitted.json()] == [first["entry_id"], third["entry_id"]]
    assert {e["status"] for e in admitted.json()} == {"admitted"}
    assert api.post(_path(appointment, "admit-all"), headers=clinician.headers).json() == []
    assert _entry_action(api, clinician, first, "admit").status_code == 409
    assert _entry_action(api, clinician, first, "decline").status_code == 409

    assert _poll(api, second).json() == {
        "status": "declined",
        "livekit_url": None,
        "token": None,
        "room_name": None,
    }
    assert _leave(api, second).json()["status"] == "declined"
    assert _poll(api, third).json()["token"] is not None
    # 3 arrivals, 1 decline, 1 admit-all; the empty admit-all publishes nothing.
    assert len(events) == 5


def test_canceling_or_moving_the_appointment_revokes_guest_tokens(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    admitted = _enter(api, token)
    waiting = _enter(api, token, display_name="Late")
    _entry_action(api, clinician, admitted, "admit")

    _move(db, appointment, datetime.now(UTC) - timedelta(hours=3))
    assert _poll(api, admitted).json() == {
        "status": "ended",
        "livekit_url": None,
        "token": None,
        "room_name": None,
    }

    _cancel(db, appointment)
    assert _poll(api, admitted).json()["status"] == "canceled"
    assert _poll(api, admitted).json()["token"] is None
    assert _entry_action(api, clinician, waiting, "admit").status_code == 409
    assert api.post(_path(appointment, "admit-all"), headers=clinician.headers).status_code == 409


def test_entries_expire_after_four_hours(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    entry = _enter(api, token)
    db.execute(
        update(WaitingRoomEntry).values(
            created_at=datetime.now(UTC) - timedelta(hours=4, minutes=1)
        )
    )
    db.commit()

    assert _poll(api, entry).status_code == 404
    assert _leave(api, entry).status_code == 404
    assert api.get(_path(appointment, "waiting-room"), headers=clinician.headers).json() == []
    assert _entry_action(api, clinician, entry, "admit").status_code == 409
    assert _entry_action(api, clinician, entry, "decline").status_code == 409
    assert api.post(_path(appointment, "admit-all"), headers=clinician.headers).json() == []


def _session_requests(
    appointment: Appointment, entry: dict[str, Any], recording: Recording
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(link requests, host-only requests) against one session."""
    links = [("GET", _path(appointment, "join-links")), ("POST", _path(appointment, "send-link"))]
    entry_path = f"/api/telehealth/entries/{entry['entry_id']}"
    hosting = [
        ("POST", _path(appointment, "host-token")),
        ("GET", _path(appointment, "waiting-room")),
        ("GET", _path(appointment, "recording-consent")),
        ("GET", _path(appointment, "recordings")),
        ("GET", f"/api/telehealth/recordings/{recording.id}"),
        ("POST", f"{entry_path}/admit"),
        ("POST", f"{entry_path}/remove"),
        ("POST", f"{entry_path}/decline"),
        ("POST", _path(appointment, "admit-all")),
        ("POST", _path(appointment, "end")),
    ]
    return links, hosting


@pytest.mark.parametrize(
    ("kind", "links", "hosting"),
    [
        # Staff who manage every calendar share links but never host someone else's session.
        ("owner", 200, 403),
        ("practice_clinician", 200, 403),
        ("practice_manager", 200, 403),
        ("scheduler", 200, 403),
        # Everyone else can't reach the colleague's calendar at all.
        ("colleague", 404, 404),
        ("care_team_colleague", 404, 404),
        ("supervisor", 404, 404),
        ("client_list_clinician", 404, 404),
        ("biller", 404, 404),
        ("other_practice", 404, 404),
    ],
)
def test_only_the_appointment_clinician_hosts(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    room_calls: list[tuple[str, ...]],
    kind: str,
    links: int,
    hosting: int,
) -> None:
    host = _colleague(db, clinician, email="host@example.com")
    client = create_client_record(db, host)
    appointment = _book(db, host, client)
    entry = _enter(api, _join_token(api, host, appointment))
    recording = Recording(practice_id=host.practice_id, appointment_id=appointment.id)
    db.add(recording)
    db.commit()
    viewer = make_viewer(api, db, clinician, host, client, kind)
    _set_practice(db, clinician, recording_enabled=True)

    link_requests, host_requests = _session_requests(appointment, entry, recording)
    for method, path in link_requests:
        response = api.request(method, path, headers=viewer.headers)
        assert response.status_code == links, (method, path, response.text)
    for method, path in host_requests:
        response = api.request(method, path, headers=viewer.headers)
        assert response.status_code == hosting, (method, path, response.text)
    assert _upload(api, viewer, appointment).status_code == hosting

    assert room_calls == []
    assert _poll(api, entry).json()["status"] == "waiting"
    db.expire_all()
    assert db.scalar(select(Recording.id).where(Recording.id != recording.id)) is None
    host_actions = {"telehealth.host_join", "telehealth.admit", "telehealth.end"}
    assert host_actions.isdisjoint(_audit_actions(db))


def test_the_host_can_do_everything_on_their_own_session(
    api: TestClient, clinician: StaffAccount, db: Session, room_calls: list[tuple[str, ...]]
) -> None:
    host = _colleague(db, clinician)
    client = create_client_record(db, host)
    appointment = _book(db, host, client)
    entry = _enter(api, _join_token(api, host, appointment))
    recording = Recording(practice_id=host.practice_id, appointment_id=appointment.id)
    db.add(recording)
    db.commit()
    links, hosting = _session_requests(appointment, entry, recording)
    # Declining fails only because the guest was just removed from the session.
    declined = f"/api/telehealth/entries/{entry['entry_id']}/decline"
    for method, path in links + hosting:
        response = api.request(method, path, headers=host.headers)
        expected = 409 if path == declined else 200
        assert response.status_code == expected, (method, path, response.text)
    room = _room_name(appointment)
    assert room_calls == [("remove", room, f"guest-{entry['entry_id']}"), ("end", room)]


def test_a_scheduler_resends_the_link_in_the_clinicians_name(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician)
    scheduler = add_staff(db, clinician.practice_id, "front@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, colleague)
    appointment = _book(db, colleague, client, starts_in=timedelta(days=2))

    sent = api.post(_path(appointment, "send-link"), headers=scheduler.headers)
    assert sent.status_code == 200, sent.text
    [email] = outbound_to(db, "alex@example.com")
    assert email.subject == "Your video appointment with Riley Chen"
    assert email.practice_id == clinician.practice_id
    denied = api.post(_path(appointment, "host-token"), headers=scheduler.headers)
    assert denied.status_code == 403
    assert denied.json()["detail"] == "Only the appointment's clinician can run this session"
    event = db.scalars(select(AuditEvent).where(AuditEvent.action == "telehealth.link_send")).one()
    assert (event.actor_id, event.resource_id) == (scheduler.id, appointment.id)


def test_other_practices_cannot_touch_a_session(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    entry = _enter(api, _join_token(api, clinician, appointment))
    recording = Recording(practice_id=clinician.practice_id, appointment_id=appointment.id)
    db.add(recording)
    db.commit()

    other = register_practice(api, email="other@example.com")
    links, hosting = _session_requests(appointment, entry, recording)
    for method, path in links + hosting:
        response = api.request(method, path, headers=other.headers)
        assert response.status_code == 404, (method, path, response.status_code)
    _set_practice(db, other, recording_enabled=True)
    assert _upload(api, other, appointment).status_code == 404

    assert _poll(api, entry).json()["status"] == "waiting"
    assert db.scalar(select(Recording.id).where(Recording.practice_id == other.practice_id)) is None


def test_send_link_by_email_and_text(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = create_client_record(db, clinician, time_zone="America/Los_Angeles")
    appointment = _book(db, clinician, client, starts_in=timedelta(days=2))

    sent = api.post(_path(appointment, "send-link"), headers=clinician.headers)
    assert sent.status_code == 200, sent.text
    assert sent.json() == [{"client_id": client.id, "email_sent": True, "sms_sent": False}]
    [email] = outbound_to(db, "alex@example.com")
    assert email.subject == "Your video appointment with Jordan Lee"
    assert email.practice_id == clinician.practice_id
    local = appointment.starts_at.astimezone(ZoneInfo("America/Los_Angeles"))
    assert f"{local:%A, %B} {local.day} at" in email.body_text
    assert str(local.tzname()) in email.body_text
    join_url = next(word for word in email.body_text.split() if "/join/" in word)
    claims = decode_join_token(join_url.rsplit("/", 1)[1])
    assert claims is not None
    assert (claims.appointment_id, claims.client_id) == (appointment.id, client.id)
    assert "Psychotherapy" not in email.body_text
    assert "sign-in" not in email.body_text
    assert "telehealth.link_send" in _audit_actions(db)

    monkeypatch.setattr(settings, "twilio_account_sid", "AC123")
    monkeypatch.setattr(settings, "twilio_auth_token", "secret")
    monkeypatch.setattr(settings, "twilio_from_number", "+15550000000")
    client.sms_reminders = True
    db.commit()
    both = api.post(_path(appointment, "send-link"), headers=clinician.headers)
    assert both.json() == [{"client_id": client.id, "email_sent": True, "sms_sent": True}]
    [sms] = outbound_to(db, "+15552013344")
    assert sms.channel == "sms"
    assert sms.practice_id == clinician.practice_id
    assert "http://app.test/j/" in sms.body_text
    assert "Lee Counseling" in sms.body_text

    client.sms_opted_out = True
    db.commit()
    opted_out = api.post(_path(appointment, "send-link"), headers=clinician.headers)
    assert opted_out.json()[0] == {"client_id": client.id, "email_sent": True, "sms_sent": False}
    assert len(outbound_to(db, "+15552013344")) == 1


def test_send_link_needs_a_way_to_reach_the_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email=None, sms_reminders=True)
    appointment = _book(db, clinician, client)
    response = api.post(_path(appointment, "send-link"), headers=clinician.headers)
    assert response.status_code == 409  # SMS isn't configured on this server
    db.expire_all()
    assert db.query(AuditEvent).filter(AuditEvent.action == "telehealth.link_send").count() == 0
    no_client = _book(db, clinician)
    assert api.post(_path(no_client, "send-link"), headers=clinician.headers).status_code == 409


def test_portal_join_link_is_only_for_the_clients_own_video_appointments(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    other_client = create_client_record(db, clinician, email="other@example.com")
    video = _book(db, clinician, client)
    in_person = _book(db, clinician, client, video=False)
    path = f"/api/portal/appointments/{video.id}/join"

    own = api.get(path, headers=portal_headers(client))
    assert own.status_code == 200, own.text
    claims = decode_join_token(own.json()["url"].rsplit("/", 1)[1])
    assert claims is not None
    assert (claims.appointment_id, claims.client_id) == (video.id, client.id)

    assert api.get(path, headers=portal_headers(other_client)).status_code == 404
    assert api.get(path, headers=clinician.headers).status_code == 401
    in_person_path = f"/api/portal/appointments/{in_person.id}/join"
    assert api.get(in_person_path, headers=portal_headers(client)).status_code == 404
    assert (
        api.get("/api/portal/appointments/999999/join", headers=portal_headers(client)).status_code
        == 404
    )

    _cancel(db, video)
    assert api.get(path, headers=portal_headers(client)).status_code == 409


def test_recording_requires_the_setting_and_everyones_consent(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    consent_path = _path(appointment, "recording-consent")

    assert api.get(consent_path, headers=clinician.headers).json() == {
        "recording_enabled": False,
        "all_consented": False,
        "participants": [],
    }
    disabled = _upload(api, clinician, appointment)
    assert disabled.status_code == 403

    _set_practice(db, clinician, recording_enabled=True)
    assert _upload(api, clinician, appointment).status_code == 409  # nobody admitted yet

    alex = _enter(api, token, display_name="Alex", recording_consent=True)
    sam = _enter(api, token, display_name="Sam", recording_consent=False)
    api.post(_path(appointment, "admit-all"), headers=clinician.headers)
    consent = api.get(consent_path, headers=clinician.headers).json()
    assert consent["recording_enabled"] is True
    assert consent["all_consented"] is False
    # Sam joined on Alex's link (e.g. a family member at home): consent is still per person.
    assert consent["participants"] == [
        {
            "entry_id": alex["entry_id"],
            "client_id": client.id,
            "display_name": "Alex",
            "recording_consent": True,
        },
        {
            "entry_id": sam["entry_id"],
            "client_id": client.id,
            "display_name": "Sam",
            "recording_consent": False,
        },
    ]
    refused = _upload(api, clinician, appointment)
    assert refused.status_code == 409
    assert "agree to recording" in refused.json()["detail"]

    # Leaving doesn't erase that they were in the session.
    _leave(api, sam)
    assert api.get(consent_path, headers=clinician.headers).json()["all_consented"] is False
    assert _upload(api, clinician, appointment).status_code == 409
    db.expire_all()
    assert db.query(Recording).count() == 0
    assert db.query(StoredFile).count() == 0


def test_recording_upload_creates_a_practice_recording(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _set_practice(db, clinician, recording_enabled=True)
    host = _colleague(db, clinician)
    client = create_client_record(db, host)
    appointment = _book(db, host, client)
    token = _join_token(api, host, appointment)
    alex = _enter(api, token, recording_consent=True)
    _entry_action(api, host, alex, "admit")
    stranger = _enter(api, token, display_name="Stranger", recording_consent=False)
    _entry_action(api, host, stranger, "decline")

    consent = api.get(_path(appointment, "recording-consent"), headers=host.headers).json()
    assert consent["all_consented"] is True
    assert [p["entry_id"] for p in consent["participants"]] == [alex["entry_id"]]

    assert _upload(api, host, appointment, "notes.pdf").status_code == 415
    uploaded = _upload(api, host, appointment)
    assert uploaded.status_code == 201, uploaded.text
    created = uploaded.json()
    assert created["status"] == "uploaded"
    assert set(created) == {"id", "status", "created_at"}

    recording = db.get(Recording, created["id"])
    assert recording is not None
    assert (recording.practice_id, recording.appointment_id) == (
        clinician.practice_id,
        appointment.id,
    )
    stored = db.get(StoredFile, recording.file_id)
    assert stored is not None
    assert (stored.practice_id, stored.purpose, stored.client_id) == (
        clinician.practice_id,
        "recording",
        client.id,
    )
    assert (stored.uploaded_by, stored.uploaded_by_staff_id) == ("staff", host.id)
    assert stored.content_type == "audio/webm"

    fetched = api.get(f"/api/telehealth/recordings/{created['id']}", headers=host.headers)
    assert fetched.status_code == 200
    body = fetched.json()
    assert body.pop("created_at") == created["created_at"]
    assert body == {
        "id": created["id"],
        "appointment_id": appointment.id,
        "status": "uploaded",
        "transcript": "",
        "error": "",
        "note_id": None,
    }
    listed = api.get(_path(appointment, "recordings"), headers=host.headers).json()
    assert [r["id"] for r in listed] == [created["id"]]
    actions = _audit_actions(db)
    assert "recording.create" in actions
    assert "recording.view" in actions
    assert "recording.list" in actions


def test_telehealth_disabled_blocks_joining(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    entry = _enter(api, token)
    _entry_action(api, clinician, entry, "admit")

    monkeypatch.setattr(settings, "livekit_api_secret", "")
    assert api.get(f"/api/telehealth/join/{token}").status_code == 200
    blocked = api.post(f"/api/telehealth/join/{token}/enter", json={"display_name": "Alex"})
    assert blocked.status_code == 503
    assert _poll(api, entry).status_code == 503


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"display_name": "   "},
        {"display_name": "x" * 101},
        {"display_name": "Alex", "current_location": "x" * 301},
        {"display_name": "Alex", "recording_consent": "maybe"},
    ],
)
def test_enter_validates_input(
    api: TestClient, clinician: StaffAccount, db: Session, body: dict[str, Any]
) -> None:
    client = create_client_record(db, clinician)
    token = _join_token(api, clinician, _book(db, clinician, client))
    response = api.post(f"/api/telehealth/join/{token}/enter", json=body)
    assert response.status_code == 422
    db.expire_all()
    assert db.query(WaitingRoomEntry).count() == 0


@pytest.mark.usefixtures("steady_rate_limits")
def test_entering_is_rate_limited(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    token = _join_token(api, clinician, _book(db, clinician, client))
    for _ in range(20):
        _enter(api, token)
    limited = api.post(f"/api/telehealth/join/{token}/enter", json={"display_name": "Alex"})
    assert limited.status_code == 429


def test_each_participant_has_their_own_short_join_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    appointment = _book(db, clinician, alex, sam)
    alex_part, sam_part = appointment.participants
    urls = [short_join_url(alex_part), short_join_url(sam_part)]
    db.commit()
    codes = [url.rsplit("/", 1)[1] for url in urls]
    assert urls == [f"http://app.test/j/{code}" for code in codes]
    assert codes[0] != codes[1] and all(len(code) <= 16 for code in codes)
    assert (alex_part.video_join_code, sam_part.video_join_code) == tuple(codes)
    assert short_join_url(alex_part) == urls[0]  # stable once assigned

    for code, client in zip(codes, (alex, sam), strict=True):
        resolved = api.get(f"/api/telehealth/short/{code}")
        assert resolved.status_code == 200
        claims = decode_join_token(resolved.json()["token"])
        assert claims is not None
        assert (claims.appointment_id, claims.client_id) == (appointment.id, client.id)
    assert api.get("/api/telehealth/short/not-a-code").status_code == 404

    _move(db, appointment, datetime.now(UTC) - timedelta(hours=3))
    assert api.get(f"/api/telehealth/short/{codes[0]}").status_code == 404
    _move(db, appointment, datetime.now(UTC))
    _cancel(db, appointment)
    assert api.get(f"/api/telehealth/short/{codes[1]}").status_code == 404


def test_guest_tokens_are_short_lived(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    entry = _enter(api, _join_token(api, clinician, appointment))
    _entry_action(api, clinician, entry, "admit")
    claims = _livekit_claims(_poll(api, entry).json()["token"])
    assert claims["exp"] - claims["nbf"] <= 10 * 60


def test_leaving_and_removal_disconnect_the_guest(
    api: TestClient, clinician: StaffAccount, db: Session, room_calls: list[tuple[str, ...]]
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    room = _room_name(appointment)

    leaver = _enter(api, token)
    _entry_action(api, clinician, leaver, "admit")
    _leave(api, leaver)
    assert room_calls == [("remove", room, f"guest-{leaver['entry_id']}")]

    removed = _enter(api, token, display_name="Sam")
    assert _entry_action(api, clinician, removed, "remove").status_code == 409  # still waiting
    _entry_action(api, clinician, removed, "admit")
    response = _entry_action(api, clinician, removed, "remove")
    assert response.status_code == 200 and response.json()["status"] == "declined"
    assert room_calls[-1] == ("remove", room, f"guest-{removed['entry_id']}")
    assert _poll(api, removed).json()["status"] == "declined"


def test_ending_the_session_closes_everything(
    api: TestClient, clinician: StaffAccount, db: Session, room_calls: list[tuple[str, ...]]
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    token = _join_token(api, clinician, appointment)
    admitted = _enter(api, token)
    _entry_action(api, clinician, admitted, "admit")
    waiting = _enter(api, token, display_name="Sam")
    ended = api.post(_path(appointment, "end"), headers=clinician.headers)
    assert ended.status_code == 200
    assert room_calls == [("end", _room_name(appointment))]
    assert _poll(api, admitted).json()["status"] == "left"
    assert _poll(api, waiting).json()["status"] == "declined"
    assert "telehealth.end" in _audit_actions(db)


def test_waiting_room_views_are_audited_once_per_window(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _book(db, clinician, client)
    for _ in range(3):
        assert (
            api.get(_path(appointment, "waiting-room"), headers=clinician.headers).status_code
            == 200
        )
    assert _audit_actions(db).count("telehealth.waiting_room_view") == 1


# Multi-client sessions -----------------------------------------------------------------------


def _couple(db: Session, clinician: StaffAccount) -> tuple[Client, Client]:
    alex = create_client_record(db, clinician)
    sam = create_client_record(
        db,
        clinician,
        first_name="Sam",
        last_name="Okafor",
        email="sam@example.com",
        time_zone="America/Los_Angeles",
    )
    return alex, sam


def test_each_participant_joins_on_their_own_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam = _couple(db, clinician)
    appointment = _book(db, clinician, alex, sam)
    links = _join_links(api, clinician, appointment)
    assert [link["client"] for link in links] == [
        {"id": alex.id, "first_name": "Alex", "last_name": "Rivera", "preferred_name": ""},
        {"id": sam.id, "first_name": "Sam", "last_name": "Okafor", "preferred_name": ""},
    ]
    tokens = [link["url"].rsplit("/", 1)[1] for link in links]
    claims = [decode_join_token(token) for token in tokens]
    assert [(c.appointment_id, c.client_id) for c in claims if c] == [
        (appointment.id, alex.id),
        (appointment.id, sam.id),
    ]
    # Each join page shows times in that client's own zone.
    zones = [api.get(f"/api/telehealth/join/{token}").json()["time_zone"] for token in tokens]
    assert zones == ["America/New_York", "America/Los_Angeles"]

    alex_entry = _enter(api, tokens[0], display_name="Alex")
    sam_entry = _enter(api, tokens[1], display_name="Sam", recording_consent=False)
    guest = _enter(api, tokens[0], display_name="Alex's sister")
    listed = api.get(_path(appointment, "waiting-room"), headers=clinician.headers).json()
    assert [(e["display_name"], e["client_id"], e["status"]) for e in listed] == [
        ("Alex", alex.id, "waiting"),
        ("Sam", sam.id, "waiting"),
        ("Alex's sister", alex.id, "waiting"),
    ]
    # Each entry is admitted, declined or removed on its own.
    _entry_action(api, clinician, alex_entry, "admit")
    _entry_action(api, clinician, guest, "decline")
    polled = [_poll(api, entry).json()["status"] for entry in (alex_entry, sam_entry, guest)]
    assert polled == ["admitted", "waiting", "declined"]
    _entry_action(api, clinician, sam_entry, "admit")
    assert _entry_action(api, clinician, alex_entry, "remove").json()["status"] == "declined"
    assert _poll(api, sam_entry).json()["status"] == "admitted"

    # A link only works for a client who is (still) in the appointment.
    outsider = create_client_record(db, clinician, first_name="Pat", email="pat@example.com")
    forged = create_join_token(appointment, outsider.id)
    assert api.get(f"/api/telehealth/join/{forged}").status_code == 404
    appointment.participants.pop()
    db.commit()
    assert api.get(f"/api/telehealth/join/{tokens[1]}").status_code == 404
    left_out = api.post(f"/api/telehealth/join/{tokens[1]}/enter", json={"display_name": "Sam"})
    assert left_out.status_code == 404


def test_portal_join_needs_the_client_to_be_a_participant(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam = _couple(db, clinician)
    outsider = create_client_record(db, clinician, first_name="Pat", email="pat@example.com")
    appointment = _book(db, clinician, alex, sam)
    path = f"/api/portal/appointments/{appointment.id}/join"

    own = api.get(path, headers=portal_headers(sam))
    assert own.status_code == 200, own.text
    claims = decode_join_token(own.json()["url"].rsplit("/", 1)[1])
    assert claims is not None
    assert (claims.appointment_id, claims.client_id) == (appointment.id, sam.id)
    assert api.get(path, headers=portal_headers(outsider)).status_code == 404


def test_send_links_to_every_participant_or_just_one(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam = _couple(db, clinician)
    jamie = create_client_record(db, clinician, first_name="Jamie", email="jamie@example.com")
    outsider = create_client_record(db, clinician, first_name="Pat", email="pat@example.com")
    appointment = _book(db, clinician, alex, sam, jamie, starts_in=timedelta(days=2))
    appointment.participants[2].attendance = AppointmentStatus.CANCELED  # Jamie can't make it
    db.commit()

    sent = api.post(_path(appointment, "send-link"), headers=clinician.headers)
    assert sent.status_code == 200, sent.text
    assert sent.json() == [
        {"client_id": alex.id, "email_sent": True, "sms_sent": False},
        {"client_id": sam.id, "email_sent": True, "sms_sent": False},
    ]
    for client in (alex, sam):
        [email] = outbound_to(db, client.email or "")
        join_url = next(word for word in email.body_text.split() if "/join/" in word)
        claims = decode_join_token(join_url.rsplit("/", 1)[1])
        assert claims is not None and claims.client_id == client.id
    assert outbound_to(db, "jamie@example.com") == []
    events = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.action == "telehealth.link_send")
        .order_by(AuditEvent.id)
    ).all()
    assert [(e.client_id, e.detail) for e in events] == [
        (alex.id, {"email_sent": True, "sms_sent": False}),
        (sam.id, {"email_sent": True, "sms_sent": False}),
    ]

    only_sam = api.post(
        _path(appointment, "send-link"), params={"client_id": sam.id}, headers=clinician.headers
    )
    assert only_sam.json() == [{"client_id": sam.id, "email_sent": True, "sms_sent": False}]
    assert (len(outbound_to(db, "alex@example.com")), len(outbound_to(db, "sam@example.com"))) == (
        1,
        2,
    )
    stranger = api.post(
        _path(appointment, "send-link"),
        params={"client_id": outsider.id},
        headers=clinician.headers,
    )
    assert stranger.status_code == 404
    assert outbound_to(db, "pat@example.com") == []


def test_recording_needs_consent_from_everyone_admitted(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _set_practice(db, clinician, recording_enabled=True)
    alex, sam = _couple(db, clinician)
    appointment = _book(db, clinician, alex, sam)
    alex_entry = _enter(api, _join_token(api, clinician, appointment, alex), recording_consent=True)
    sam_entry = _enter(
        api,
        _join_token(api, clinician, appointment, sam),
        display_name="Sam",
        recording_consent=False,
    )
    consent_path = _path(appointment, "recording-consent")

    # Only Alex is in the session so far, and Alex agreed.
    _entry_action(api, clinician, alex_entry, "admit")
    consent = api.get(consent_path, headers=clinician.headers).json()
    assert consent["all_consented"] is True
    assert [(p["client_id"], p["recording_consent"]) for p in consent["participants"]] == [
        (alex.id, True)
    ]
    uploaded = _upload(api, clinician, appointment)
    assert uploaded.status_code == 201, uploaded.text
    recording = db.get_one(Recording, uploaded.json()["id"])
    stored = db.get_one(StoredFile, recording.file_id)
    assert stored.client_id is None  # a couples session's audio isn't one client's document

    # Once Sam, who didn't agree, is admitted, nothing more can be recorded.
    _entry_action(api, clinician, sam_entry, "admit")
    consent = api.get(consent_path, headers=clinician.headers).json()
    assert consent["all_consented"] is False
    assert [(p["client_id"], p["recording_consent"]) for p in consent["participants"]] == [
        (alex.id, True),
        (sam.id, False),
    ]
    assert _upload(api, clinician, appointment).status_code == 409
