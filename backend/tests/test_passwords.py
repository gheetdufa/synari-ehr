"""Staff password policy: length, common and predictable passwords, personal words and the
optional breached-password check (mocked Have I Been Pwned range API)."""

import hashlib

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models.enums import StaffRole
from synari.services import passwords
from synari.services.passwords import (
    BREACHED,
    PERSONAL,
    TOO_COMMON,
    TOO_SHORT,
    context_words,
    password_problem,
)
from tests.conftest import StaffAccount, link_token, outbound_to

CONTEXT = context_words("jordan.lee@example.com", "Jordan", "Lee", "Blue Sky Counseling")


@pytest.mark.parametrize(
    ("password", "problem"),
    [
        ("short pass", TOO_SHORT),
        ("Password1234", TOO_COMMON),
        ("Sunshine2024!!", TOO_COMMON),
        ("qwertyuiop123", TOO_COMMON),
        ("123456789012", TOO_COMMON),
        ("210987654321", TOO_COMMON),
        ("aaaaaaaaaaaaaa", TOO_COMMON),
        ("abababababab", TOO_COMMON),
        ("asdfghjkl;'!", TOO_COMMON),
        ("!!!!!!!!!!!!", TOO_COMMON),
        ("Jordan2024!!Lee", PERSONAL),
        ("jordan.lee@example.com", PERSONAL),
        ("BlueSkyCounseling1", PERSONAL),
        ("SynariSynari99", PERSONAL),
        ("correct horse battery", None),
        ("blue horizons at dawn", None),
        ("8#4!9$2@7&1%", None),
        ("Jordan's garden gnome parade", None),
    ],
)
def test_password_problems(password: str, problem: str | None) -> None:
    assert password_problem(password, context=CONTEXT) == problem


def test_context_words_cover_names_email_and_practice() -> None:
    assert {"jordan", "lee", "example", "blue", "sky", "counseling", "synari"} <= set(CONTEXT)


def _register(api: TestClient, password: str, **fields: str) -> httpx.Response:
    return api.post(
        "/api/auth/register",
        json={
            "email": "morgan.hale@example.com",
            "password": password,
            "first_name": "Morgan",
            "last_name": "Hale",
            "practice_name": "Harbor Therapy",
            **fields,
        },
    )


def test_registration_explains_what_is_wrong_with_a_password(api: TestClient) -> None:
    common = _register(api, "Welcome12345!")
    assert (common.status_code, common.json()["detail"]) == (400, TOO_COMMON)
    personal = _register(api, "HarborTherapy2024")  # gitleaks:allow
    assert (personal.status_code, personal.json()["detail"]) == (400, PERSONAL)
    short = _register(api, "eleven char")
    assert short.status_code == 422
    assert _register(api, "tidal lantern orchard").status_code == 201


def test_every_new_password_follows_the_policy(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    changed = api.post(
        "/api/auth/change-password",
        headers=clinician.headers,
        json={"current_password": "correct horse battery", "new_password": "LeeCounseling99"},
    )
    assert (changed.status_code, changed.json()["detail"]) == (400, PERSONAL)

    api.post("/api/auth/password-reset/request", json={"email": clinician.email})
    token = link_token(outbound_to(db, clinician.email)[-1].body_text)
    reset = api.post(
        "/api/auth/password-reset/confirm", json={"token": token, "new_password": "iloveyou1234"}
    )
    assert (reset.status_code, reset.json()["detail"]) == (400, TOO_COMMON)
    # A rejected password doesn't use up the link.
    retry = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "velvet thunder canyon"},
    )
    assert retry.status_code == 200

    invited = api.post(
        "/api/team/invitations",
        json={
            "email": "riley@example.com",
            "first_name": "Riley",
            "last_name": "Chen",
            "role": StaffRole.CLINICIAN,
        },
        headers=_bearer(retry.json()["access_token"]),
    )
    assert invited.status_code == 201
    invite = link_token(outbound_to(db, "riley@example.com")[-1].body_text)
    weak = api.post(
        "/api/auth/invitations/accept", json={"token": invite, "password": "RileyChen2024"}
    )
    assert (weak.status_code, weak.json()["detail"]) == (400, PERSONAL)
    accepted = api.post(
        "/api/auth/invitations/accept", json={"token": invite, "password": "quiet maple ferry"}
    )
    assert accepted.status_code == 200


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _suffix(password: str) -> str:
    return hashlib.sha1(password.encode(), usedforsecurity=False).hexdigest().upper()[5:]


@pytest.fixture
def breach_api(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    """Turn the breach check on against a fake range API that knows one breached password."""
    requests: list[httpx.Request] = []
    breached = _suffix("tidal lantern orchard")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = f"{'0' * 35}:0\r\n{breached}:42\r\n{_suffix('quiet maple ferry')}:0"
        return httpx.Response(200, text=body)

    monkeypatch.setattr(settings, "password_breach_check", True)
    monkeypatch.setattr(
        passwords,
        "_hibp_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    return requests


def test_breached_passwords_are_refused(api: TestClient, breach_api: list[httpx.Request]) -> None:
    refused = _register(api, "tidal lantern orchard")
    assert (refused.status_code, refused.json()["detail"]) == (400, BREACHED)
    [request] = breach_api
    digest = hashlib.sha1(b"tidal lantern orchard", usedforsecurity=False).hexdigest().upper()
    assert request.url.path == f"/range/{digest[:5]}"
    assert request.headers["Add-Padding"] == "true"
    assert digest[5:] not in str(request.url)
    # Padding entries (count 0) don't count as breached.
    assert _register(api, "quiet maple ferry").status_code == 201


def test_breach_check_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    monkeypatch.setattr(settings, "password_breach_check", True)
    monkeypatch.setattr(
        passwords,
        "_hibp_client",
        lambda: httpx.Client(transport=httpx.MockTransport(unreachable)),
    )
    assert password_problem("tidal lantern orchard") is None
