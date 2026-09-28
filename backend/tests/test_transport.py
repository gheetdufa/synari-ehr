"""Transport guardrails: API security headers, docs in production, production settings."""

import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from synari import main
from synari.config import Settings, is_local_host, settings
from synari.middleware import API_CSP


def test_api_responses_carry_security_headers(api: TestClient) -> None:
    response = api.get("/api/health")
    assert response.headers["content-security-policy"] == API_CSP
    assert "default-src 'none'" in API_CSP and "frame-ancestors 'none'" in API_CSP
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "strict-transport-security" not in response.headers  # plain HTTP (local dev)

    over_https = TestClient(main.app, base_url="https://testserver").get("/api/health")
    assert over_https.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"


def test_docs_are_served_outside_production_only(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    docs = api.get("/api/docs")
    assert docs.status_code == 200
    assert "content-security-policy" not in docs.headers  # Swagger UI loads its own scripts
    assert api.get("/api/openapi.json").headers["content-security-policy"] == API_CSP

    monkeypatch.setattr(main, "configure_logging", lambda: None)
    monkeypatch.setattr(settings, "environment", "production")
    production = TestClient(main.create_app())
    assert production.get("/api/docs").status_code == 404
    assert production.get("/api/openapi.json").status_code == 404
    assert production.get("/redoc").status_code == 404
    assert production.get("/api/health").status_code == 200


@pytest.mark.parametrize(
    ("host", "local"),
    [
        ("localhost", True),
        ("127.0.0.1", True),
        ("[::1]", True),
        ("db", True),  # a Docker Compose service
        ("/var/run/postgresql", True),
        ("", True),
        ("10.0.0.5", False),
        ("smtp.example.com", False),
        ("db.internal", False),
    ],
)
def test_is_local_host(host: str, local: bool) -> None:
    assert is_local_host(host) is local


def production(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "production",
        "secret_key": "s" * 40,
        "data_encryption_keys": "k1:" + "A" * 43 + "=",
        "frontend_url": "https://app.example.com",
        "database_url": "postgresql+psycopg://synari:pw@db:5432/synari",
        "smtp_host": "email-smtp.us-east-1.amazonaws.com",
        "smtp_security": "starttls",
        **overrides,
    }
    return Settings(_env_file=None, **values)


def test_production_accepts_a_sound_configuration(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="synari.config"):
        production()
        production(smtp_host="mailpit", smtp_security="none")  # relay on the Docker network
        production(database_url="postgresql://u:p@db.example.com:5432/synari?sslmode=verify-full")
    assert caplog.records == []


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"frontend_url": "http://app.example.com"}, "FRONTEND_URL must be an https"),
        ({"smtp_security": "none"}, "SMTP_SECURITY=none"),
    ],
)
def test_production_rejects_plaintext_transport(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        production(**overrides)


def test_production_warns_about_a_remote_database_without_tls(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="synari.config"):
        production(database_url="postgresql://u:p@db.example.com:5432/synari")
    assert "sslmode=require" in caplog.text


def test_other_environments_allow_local_development() -> None:
    Settings(
        _env_file=None,
        environment="development",
        frontend_url="http://localhost:5173",
        smtp_host="smtp.example.com",
        smtp_security="none",
    )
