"""Health information stays out of logs, error messages and old outbound email."""

import json
import logging
import smtplib
import sys
from datetime import timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import engine, utcnow
from synari.logs import JsonFormatter, RedactionFilter, redact, request_id
from synari.models import OutboundMessage, StoredFile
from synari.models.enums import FilePurpose, OutboundChannel, OutboundStatus, Role
from synari.services import delivery
from synari.services.delivery import DeliveryError
from synari.services.outbox import purge_outbound_content
from tests.conftest import StaffAccount


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Emailing alex.rivera+1@example.co.uk", "Emailing [email]"),
        ("To +15552013344 failed", "To [phone] failed"),
        ("call (555) 201-3344 or 555.201.3344", "call [phone] or [phone]"),
        ("Authorization: Bearer abc.def-ghi", "Authorization: Bearer [redacted]"),
        ("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_1", "jwt [jwt]"),
        (
            "GET /api/telehealth/join/Xy3kP0qL9vR2mN8tB4wZ1aC6dE7fG5hJ",
            "GET /api/telehealth/join/[token]",
        ),
        (
            "https://app.test/portal?token=abc123&next=1",
            "https://app.test/portal?token=[redacted]&next=1",
        ),
        (
            "DETAIL:  Key (email)=(alex@example.com) already exists.",
            "DETAIL:  Key (email)=([redacted]) already exists.",
        ),
        (
            "DETAIL:  Failing row contains (7, 501, Alex, Rivera, null).",
            "DETAIL:  Failing row contains ([redacted]).",
        ),
        # Times, ids and versions survive.
        ("2026-09-26T03:57:00 job took 1234 ms for practice 501", None),
        ("uvicorn 0.54.0 on 10.0.0.12:8000", None),
    ],
)
def test_redact(raw: str, expected: str | None) -> None:
    assert redact(raw) == (raw if expected is None else expected)


def test_log_lines_are_json_redacted_and_tagged_with_the_request() -> None:
    try:
        raise ValueError("lookup failed for alex@example.com")
    except ValueError:
        record = logging.LogRecord(
            "synari.test",
            logging.ERROR,
            __file__,
            1,
            "Sent to %s",
            ("+15552013344",),
            sys.exc_info(),
        )
    token = request_id.set("req-12345678")
    try:
        assert RedactionFilter().filter(record)
    finally:
        request_id.reset(token)
    line = json.loads(JsonFormatter().format(record))
    assert line["message"] == "Sent to [phone]"
    assert line["level"] == "ERROR" and line["logger"] == "synari.test"
    assert line["request_id"] == "req-12345678"
    assert "ValueError: lookup failed for [email]" in line["exception"]
    assert "alex@example.com" not in json.dumps(line)


def request_logs(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "synari.request"]


def test_requests_are_logged_by_route_template_never_the_raw_path(
    api: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "Xy3kP0qL9vR2mN8tB4wZ1aC6dE7fG5hJ"  # gitleaks:allow
    with caplog.at_level(logging.INFO, logger="synari.request"):
        response = api.get(f"/api/calendar-feed/{secret}.ics?token={secret}")
        missing = api.get(f"/api/nothing-here/{secret}")
    assert response.status_code == 404
    first, second = request_logs(caplog)
    assert (first.method, first.route, first.status) == (
        "GET",
        "/api/calendar-feed/{token}.ics",
        404,
    )
    assert first.duration_ms >= 0
    assert (second.route, second.status) == ("<unmatched>", 404)
    assert secret not in caplog.text
    assert response.headers["x-request-id"] != missing.headers["x-request-id"]


def test_request_ids_from_a_proxy_are_kept_only_when_plain(api: TestClient) -> None:
    kept = api.get("/api/health", headers={"X-Request-ID": "caddy-0a1b2c3d"})
    assert kept.headers["x-request-id"] == "caddy-0a1b2c3d"
    replaced = api.get("/api/health", headers={"X-Request-ID": "alex@example.com"})
    assert replaced.headers["x-request-id"] != "alex@example.com"


def test_twilio_errors_keep_the_code_but_not_the_number(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "twilio_account_sid", "AC123")
    monkeypatch.setattr(settings, "twilio_auth_token", "token")
    monkeypatch.setattr(settings, "twilio_from_number", "+15550000000")
    body = {"code": 21211, "message": "The 'To' number +15552013344 is not a valid phone number."}

    def rejected(*args: Any, **kwargs: Any) -> httpx.Response:
        return httpx.Response(400, json=body)

    monkeypatch.setattr(delivery.httpx, "post", rejected)
    with pytest.raises(DeliveryError) as error:
        delivery.send_sms("+15552013344", "Reminder: your appointment is tomorrow")
    assert str(error.value) == "Twilio error 400 (code 21211)"
    assert error.value.__cause__ is None


def test_smtp_errors_keep_the_type_but_not_the_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_security", "ssl")

    def refuse(*args: Any, **kwargs: Any) -> smtplib.SMTP:
        raise smtplib.SMTPRecipientsRefused({"alex@example.com": (550, b"No such user")})

    monkeypatch.setattr(delivery.smtplib, "SMTP_SSL", refuse)
    with pytest.raises(DeliveryError) as error:
        delivery.send_email("alex@example.com", "Hello", "Body", None)
    assert str(error.value) == "SMTP error: SMTPRecipientsRefused"


def test_sql_errors_never_carry_bound_values(clinician: StaffAccount, db: Session) -> None:
    assert engine.hide_parameters
    for _ in range(2):
        db.add(
            StoredFile(
                practice_id=clinician.practice_id,
                client_id=None,
                purpose=FilePurpose.SHARED_DOCUMENT,
                filename="Alex Rivera discharge summary.pdf",
                content_type="application/pdf",
                size_bytes=1,
                storage_key="practices/alex-rivera.pdf",
                uploaded_by=Role.STAFF,
            )
        )
    with pytest.raises(IntegrityError) as error:
        db.commit()
    db.rollback()
    message = str(error.value)
    assert "Alex Rivera discharge summary" not in message
    assert "SQL parameters hidden" in message
    assert "alex-rivera" not in redact(message)


def outbound(db: Session, status: OutboundStatus, **fields: Any) -> OutboundMessage:
    message = OutboundMessage(
        channel=OutboundChannel.EMAIL,
        to_address="alex@example.com",
        subject="Sign in to view Alex's portal",
        body_text="Sign in: https://app.test/client/auth?token=abc",
        body_html="<p>Sign in</p>",
        status=status,
        **fields,
    )
    db.add(message)
    return message


def test_outbound_content_is_cleared_a_week_after_it_finishes(db: Session) -> None:
    now = utcnow()
    week_ago = now - timedelta(days=7, minutes=1)
    old_sent = outbound(db, OutboundStatus.SENT, sent_at=week_ago, send_after=week_ago)
    recent = outbound(db, OutboundStatus.SENT, sent_at=now - timedelta(days=6), send_after=week_ago)
    old_failed = outbound(db, OutboundStatus.FAILED, send_after=week_ago)
    old_canceled = outbound(db, OutboundStatus.CANCELED, send_after=week_ago)
    still_queued = outbound(db, OutboundStatus.PENDING, send_after=week_ago)
    db.commit()

    purge_outbound_content(db, now)

    db.expire_all()
    for message in (old_sent, old_failed, old_canceled):
        assert (message.subject, message.body_text, message.body_html) == ("", "", None)
        # The envelope stays for troubleshooting.
        assert message.to_address == "alex@example.com"
    for message in (recent, still_queued):
        assert message.body_text.startswith("Sign in")
        assert message.subject == "Sign in to view Alex's portal"
