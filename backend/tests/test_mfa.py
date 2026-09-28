from datetime import timedelta

import pyotp
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import AuditEvent
from tests.conftest import StaffAccount, link_token, outbound_to

PASSWORD = "correct horse battery"


def next_code(secret: str) -> str:
    """The authenticator code for the next 30-second step (a used code can't be replayed)."""
    return pyotp.TOTP(secret).at(utcnow() + timedelta(seconds=30))


def _enable(api: TestClient, clinician: StaffAccount) -> tuple[str, list[str]]:
    setup = api.post("/api/auth/mfa/setup", headers=clinician.headers)
    assert setup.status_code == 200
    secret = setup.json()["secret"]
    assert setup.json()["otpauth_uri"].startswith("otpauth://totp/Synari:")
    wrong = api.post("/api/auth/mfa/enable", json={"code": "000000"}, headers=clinician.headers)
    assert wrong.status_code == 400
    enabled = api.post(
        "/api/auth/mfa/enable", json={"code": pyotp.TOTP(secret).now()}, headers=clinician.headers
    )
    assert enabled.status_code == 200
    codes = enabled.json()["recovery_codes"]
    assert len(codes) == 8
    return secret, codes


def test_login_requires_second_factor_once_enabled(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    secret, _ = _enable(api, clinician)
    assert api.get("/api/me", headers=clinician.headers).json()["staff"]["mfa_enabled"] is True

    challenge = api.post("/api/auth/login", json={"email": clinician.email, "password": PASSWORD})
    assert challenge.status_code == 200
    body = challenge.json()
    assert body["mfa_required"] is True and "access_token" not in body

    bad = api.post("/api/auth/login/mfa", json={"mfa_token": body["mfa_token"], "code": "123456"})
    assert bad.status_code == 401
    good = api.post(
        "/api/auth/login/mfa",
        json={"mfa_token": body["mfa_token"], "code": next_code(secret)},
    )
    assert good.status_code == 200
    assert good.json()["staff"]["id"] == clinician.id
    actions = [e.action for e in db.query(AuditEvent).order_by(AuditEvent.id)]
    assert "auth.mfa_failed" in actions and "auth.mfa_enabled" in actions

    # The challenge token is not an access token.
    headers = {"Authorization": f"Bearer {body['mfa_token']}"}
    assert api.get("/api/me", headers=headers).status_code == 401


def test_recovery_codes_work_once(api: TestClient, clinician: StaffAccount) -> None:
    _, codes = _enable(api, clinician)
    for expected in (200, 401):
        token = api.post(
            "/api/auth/login", json={"email": clinician.email, "password": PASSWORD}
        ).json()["mfa_token"]
        response = api.post("/api/auth/login/mfa", json={"mfa_token": token, "code": codes[0]})
        assert response.status_code == expected


def test_password_reset_still_requires_second_factor(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    secret, _ = _enable(api, clinician)
    api.post("/api/auth/password-reset/request", json={"email": clinician.email})
    token = link_token(outbound_to(db, clinician.email)[-1].body_text)
    reset = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "a brand new password"},
    )
    assert reset.status_code == 200
    assert reset.json()["mfa_required"] is True
    done = api.post(
        "/api/auth/login/mfa",
        json={"mfa_token": reset.json()["mfa_token"], "code": next_code(secret)},
    )
    assert done.status_code == 200


def test_disable_and_regenerate_need_password_and_code(
    api: TestClient, clinician: StaffAccount
) -> None:
    secret, codes = _enable(api, clinician)
    regenerated = api.post(
        "/api/auth/mfa/recovery-codes",
        json={"password": PASSWORD, "code": next_code(secret)},
        headers=clinician.headers,
    )
    assert regenerated.status_code == 200
    assert set(regenerated.json()["recovery_codes"]).isdisjoint(codes)

    wrong_password = api.post(
        "/api/auth/mfa/disable",
        json={"password": "not the password", "code": pyotp.TOTP(secret).now()},
        headers=clinician.headers,
    )
    assert wrong_password.status_code == 400
    disabled = api.post(
        "/api/auth/mfa/disable",
        json={"password": PASSWORD, "code": regenerated.json()["recovery_codes"][0]},
        headers=clinician.headers,
    )
    assert disabled.status_code == 200
    plain = api.post("/api/auth/login", json={"email": clinician.email, "password": PASSWORD})
    assert "access_token" in plain.json()


def test_setup_keeps_the_same_key_until_it_is_confirmed(
    api: TestClient, clinician: StaffAccount
) -> None:
    # A setup screen may ask twice (or be reopened); both answers must show the same key.
    first = api.post("/api/auth/mfa/setup", headers=clinician.headers).json()["secret"]
    second = api.post("/api/auth/mfa/setup", headers=clinician.headers).json()["secret"]
    assert first == second
    enabled = api.post(
        "/api/auth/mfa/enable", json={"code": pyotp.TOTP(first).now()}, headers=clinician.headers
    )
    assert enabled.status_code == 200

    # Turning it off forgets the key, so setting up again starts with a new one.
    disabled = api.post(
        "/api/auth/mfa/disable",
        json={"password": PASSWORD, "code": next_code(first)},
        headers=clinician.headers,
    )
    assert disabled.status_code == 200, disabled.text
    again = api.post("/api/auth/mfa/setup", headers=clinician.headers).json()["secret"]
    assert again != first
