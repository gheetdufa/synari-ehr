"""Health/config endpoints, realtime delivery and the email/SMS outbox."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Conversation, Message, OutboundMessage
from synari.models.enums import OutboundStatus, Role
from synari.realtime import publish
from synari.services import outbox
from synari.services.delivery import DeliveryError, normalize_phone
from synari.services.email_templates import render_email
from tests.conftest import StaffAccount, create_client_record


def test_health_and_public_config(api: TestClient) -> None:
    assert api.get("/api/health").json() == {"status": "ok", "database": True}
    config = api.get("/api/config").json()
    assert config["telehealth_enabled"] is True
    assert config["payments_enabled"] is False
    assert "secret" not in str(config).lower()


def test_api_responses_are_not_cached(api: TestClient) -> None:
    response = api.get("/api/health")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_websocket_requires_auth(api: TestClient) -> None:
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": "garbage"})
        with pytest.raises(Exception):  # noqa: B017  (server closes the socket)
            websocket.receive_json()


def test_websocket_receives_published_events(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    token = clinician.data["access_token"]
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": token})
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_json({"type": "ping"})
        assert websocket.receive_json() == {"type": "pong"}

        publish(db, [(Role.STAFF, clinician.id + 999)], "noise", {})
        # A client with the same numeric id is a different recipient.
        publish(db, [(Role.CLIENT, clinician.id)], "noise", {})
        publish(db, [(Role.STAFF, clinician.id)], "message.created", {"conversation_id": 7})
        db.commit()
        assert websocket.receive_json() == {
            "type": "message.created",
            "data": {"conversation_id": 7},
        }


def test_uncommitted_events_are_not_delivered(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        websocket.receive_json()
        publish(db, [(Role.STAFF, clinician.id)], "rolled.back", {})
        db.rollback()
        publish(db, [(Role.STAFF, clinician.id)], "committed", {})
        db.commit()
        assert websocket.receive_json()["type"] == "committed"


def _email(subject: str = "Hello") -> outbox.EmailContent:
    return render_email(subject=subject, heading="Hi", paragraphs=["Body"], sender_name="Practice")


def test_outbox_dedupe_key_is_idempotent(db: Session) -> None:
    for _ in range(3):
        outbox.queue_email(db, to="a@example.com", content=_email(), dedupe_key="reminder:1")
    db.commit()
    assert db.query(OutboundMessage).count() == 1


def test_outbox_delivers_and_retries(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[str] = []
    attempts = {"count": 0}

    def flaky_send(to: str, subject: str, text: str, html: str | None) -> None:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise DeliveryError("temporary")
        sent.append(to)

    monkeypatch.setattr(outbox, "send_email", flaky_send)
    outbox.queue_email(db, to="a@example.com", content=_email())
    db.commit()

    now = utcnow()
    outbox.deliver_outbound(db, now)
    message = db.query(OutboundMessage).one()
    assert message.status == OutboundStatus.PENDING
    assert message.attempts == 1
    assert message.send_after > now

    outbox.deliver_outbound(db, now + timedelta(hours=1))
    db.refresh(message)
    assert message.status == OutboundStatus.SENT
    assert sent == ["a@example.com"]


def test_outbox_gives_up_after_max_attempts(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    def always_fail(*_: object) -> None:
        raise DeliveryError("down")

    monkeypatch.setattr(outbox, "send_email", always_fail)
    outbox.queue_email(db, to="a@example.com", content=_email())
    db.commit()
    moment = utcnow()
    for _ in range(outbox.MAX_ATTEMPTS):
        outbox.deliver_outbound(db, moment)
        moment += timedelta(days=1)
    assert db.query(OutboundMessage).one().status == OutboundStatus.FAILED


@pytest.mark.parametrize(
    ("read_marker", "canceled", "sent"),
    [
        (
            "clinician_read_at",
            outbox.CONDITION_CLINICIAN_UNREAD_MESSAGE,
            outbox.CONDITION_CLIENT_UNREAD_MESSAGE,
        ),
        (
            "client_read_at",
            outbox.CONDITION_CLIENT_UNREAD_MESSAGE,
            outbox.CONDITION_CLINICIAN_UNREAD_MESSAGE,
        ),
    ],
)
def test_outbox_skips_unread_notice_once_message_is_read(
    db: Session,
    clinician: StaffAccount,
    monkeypatch: pytest.MonkeyPatch,
    read_marker: str,
    canceled: str,
    sent: str,
) -> None:
    delivered: list[str] = []
    monkeypatch.setattr(outbox, "send_email", lambda to, *_: delivered.append(to))
    client = create_client_record(db, clinician)
    conversation = Conversation(
        practice_id=clinician.practice_id, clinician_id=clinician.id, client_id=client.id
    )
    db.add(conversation)
    db.flush()
    message = Message(conversation_id=conversation.id, sender_role=Role.CLIENT, body="hi")
    db.add(message)
    db.flush()
    for condition in (canceled, sent):
        outbox.queue_email(
            db,
            to=f"{condition}@example.com",
            content=_email(),
            practice_id=clinician.practice_id,
            condition_kind=condition,
            condition_ref=message.id,
        )
    db.commit()
    setattr(conversation, read_marker, utcnow() + timedelta(seconds=1))
    db.commit()

    outbox.deliver_outbound(db, utcnow() + timedelta(minutes=1))
    assert delivered == [f"{sent}@example.com"]
    statuses = {m.condition_kind: m.status for m in db.query(OutboundMessage)}
    assert statuses == {canceled: OutboundStatus.CANCELED, sent: OutboundStatus.SENT}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("(555) 201-3344", "+15552013344"),
        ("1-555-201-3344", "+15552013344"),
        ("+44 20 7946 0958", "+442079460958"),
        ("12345", None),
    ],
)
def test_normalize_phone(raw: str, expected: str | None) -> None:
    assert normalize_phone(raw) == expected


def test_production_requires_a_strong_secret_key() -> None:
    from pydantic import ValidationError

    from synari.config import Settings

    keys = "k1:" + "A" * 43 + "="
    with pytest.raises(ValidationError, match="SECRET_KEY"):
        Settings(environment="production", secret_key="short", data_encryption_keys=keys)
    strong = Settings(
        environment="production",
        secret_key="x" * 40,
        data_encryption_keys=keys,
        frontend_url="https://app.example.com",
    )
    assert strong.secret_key == "x" * 40
    generated = Settings(environment="development", secret_key="")
    assert len(generated.secret_key) >= 32


def test_production_requires_data_encryption_keys() -> None:
    from pydantic import ValidationError

    from synari.config import Settings

    with pytest.raises(ValidationError, match="DATA_ENCRYPTION_KEYS"):
        Settings(environment="production", secret_key="x" * 40)
    # Development derives a key from SECRET_KEY instead.
    assert Settings(environment="development", secret_key="x" * 40).data_encryption_keys == ""


def test_database_url_accepts_platform_style_urls() -> None:
    from synari.config import Settings

    heroku_style = Settings(database_url="postgres://u:p@host:5432/db", secret_key="x" * 40)
    assert heroku_style.sqlalchemy_url == "postgresql+psycopg://u:p@host:5432/db"
    assert heroku_style.libpq_url == "postgresql://u:p@host:5432/db"


def test_downloads_expose_their_filename_to_the_web_app(api: TestClient) -> None:
    response = api.get("/api/health", headers={"Origin": "http://app.test"})
    assert response.headers["access-control-allow-origin"] == "http://app.test"
    assert "content-disposition" in response.headers["access-control-expose-headers"].lower()
