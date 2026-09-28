"""Sign-in protections: the staff 2FA requirement and enrollment-only sessions, 2FA resets, TOTP
replay, per-challenge attempt limits, throttling with backoff, alerts and new-device sign-ins."""

from datetime import timedelta

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import Settings, settings
from synari.db import utcnow
from synari.main import app
from synari.models import AuditEvent, AuthSession, Notification, SecurityEvent, StaffMember
from synari.models.enums import ClinicianAccess, StaffRole
from synari.ratelimit import reset_all_limits
from synari.services.security_events import (
    MFA_DISABLED,
    MFA_REQUIREMENT_DISABLED,
    MFA_RESET,
    NEW_DEVICE,
    REPEATED_FAILURES,
    SIGN_IN_PAUSED,
)
from tests.conftest import StaffAccount, add_staff, outbound_to, register_practice

PASSWORD = "correct horse battery"
BAD_CREDENTIALS = "Incorrect email or password."


@pytest.fixture
def practice_mfa_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let each practice's require_staff_mfa setting decide (no server override)."""
    monkeypatch.setattr(settings, "require_staff_mfa", None)


def _code(secret: str, steps_ahead: int = 0) -> str:
    return pyotp.TOTP(secret).at(utcnow() + timedelta(seconds=30 * steps_ahead))


def _enable_mfa(api: TestClient, headers: dict[str, str]) -> str:
    secret = api.post("/api/auth/mfa/setup", headers=headers).json()["secret"]
    enabled = api.post("/api/auth/mfa/enable", json={"code": _code(secret)}, headers=headers)
    assert enabled.status_code == 200, enabled.text
    return secret


def _login(api: TestClient, email: str, password: str = PASSWORD) -> tuple[int, dict]:
    response = api.post("/api/auth/login", json={"email": email, "password": password})
    return response.status_code, response.json()


def _staff(db: Session, staff_id: int) -> StaffMember:
    db.expire_all()
    return db.get(StaffMember, staff_id)


def _events(db: Session, kind: str) -> list[SecurityEvent]:
    db.expire_all()
    return list(db.scalars(select(SecurityEvent).where(SecurityEvent.kind == kind)))


# --- The 2FA requirement --------------------------------------------------------------------


def test_new_practices_require_2fa_with_an_enrollment_only_session(
    api: TestClient, db: Session, practice_mfa_policy: None
) -> None:
    owner = register_practice(api)
    assert owner.data["mfa_setup_required"] is True
    blocked = api.get("/api/clients", headers=owner.headers)
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "Set up two-factor authentication to continue."
    assert api.get("/api/practice", headers=owner.headers).status_code == 403
    assert api.get("/api/me/sessions", headers=owner.headers).status_code == 403
    assert api.get("/api/me", headers=owner.headers).json()["mfa_setup_required"] is True

    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": owner.data["access_token"]})
        with pytest.raises(Exception):  # noqa: B017  (server closes the socket)
            websocket.receive_json()

    _enable_mfa(api, owner.headers)
    assert api.get("/api/me", headers=owner.headers).json()["mfa_setup_required"] is False
    assert api.get("/api/clients", headers=owner.headers).status_code == 200


def test_enrollment_only_sessions_can_sign_out(api: TestClient, practice_mfa_policy: None) -> None:
    owner = register_practice(api)
    assert api.post("/api/auth/logout", headers=owner.headers).status_code == 200
    assert api.get("/api/me", headers=owner.headers).status_code == 401


def test_invited_staff_must_set_up_2fa_too(
    api: TestClient, db: Session, practice_mfa_policy: None
) -> None:
    owner = register_practice(api)
    _enable_mfa(api, owner.headers)
    member = add_staff(db, owner.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    assert api.get("/api/clients", headers=member.headers).status_code == 403
    team = api.get("/api/team", headers=owner.headers).json()
    assert {m["email"]: m["mfa_enabled"] for m in team} == {
        "jordan@example.com": True,
        "casey@example.com": False,
    }


@pytest.mark.parametrize(
    ("server", "practice", "required"),
    [(None, True, True), (None, False, False), (True, False, True), (False, True, False)],
)
def test_the_server_can_override_the_practice_setting(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    server: bool | None,
    practice: bool,
    required: bool,
) -> None:
    owner = register_practice(api)
    monkeypatch.setattr(settings, "require_staff_mfa", False)
    api.patch("/api/practice/security", json={"require_staff_mfa": practice}, headers=owner.headers)
    monkeypatch.setattr(settings, "require_staff_mfa", server)
    assert api.get("/api/me", headers=owner.headers).json()["mfa_setup_required"] is required
    policy = {None: None, True: "required", False: "off"}[server]
    if not required:
        security = api.get("/api/practice/security", headers=owner.headers).json()
        assert security["mfa_server_policy"] == policy
        assert security["mfa_required"] is False


def test_a_blank_server_override_leaves_2fa_to_practices() -> None:
    assert Settings(require_staff_mfa="").require_staff_mfa is None


def test_practice_security_settings(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    security = api.get("/api/practice/security", headers=clinician.headers).json()
    assert security == {
        "require_staff_mfa": True,
        "mfa_server_policy": "off",
        "mfa_required": False,
        "session_idle_minutes": 30,
        "staff_mfa_enabled": 0,
        "staff_active": 1,
    }
    for minutes in (4, 61):
        bad = api.patch(
            "/api/practice/security",
            json={"session_idle_minutes": minutes},
            headers=clinician.headers,
        )
        assert bad.status_code == 422

    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    changed = api.patch(
        "/api/practice/security",
        json={"require_staff_mfa": False, "session_idle_minutes": 15},
        headers=manager.headers,
    )
    assert changed.status_code == 200
    assert changed.json()["require_staff_mfa"] is False
    assert changed.json()["session_idle_minutes"] == 15
    [event] = _events(db, MFA_REQUIREMENT_DISABLED)
    assert event.severity == "warning" and event.staff_id == manager.id
    assert db.query(AuditEvent).filter_by(action="practice.security_update").count() == 1


@pytest.mark.parametrize(
    ("role", "access_level"),
    [
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE),
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC),
        (StaffRole.BILLER, ClinicianAccess.BASIC),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC),
    ],
)
def test_only_team_managers_change_security_settings(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    access_level: ClinicianAccess,
) -> None:
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=access_level
    )
    assert api.get("/api/practice/security", headers=member.headers).status_code == 200
    response = api.patch(
        "/api/practice/security", json={"require_staff_mfa": False}, headers=member.headers
    )
    assert response.status_code == 403


def test_owners_reset_a_members_2fa(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    member = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    _enable_mfa(api, member.headers)
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    url = f"/api/team/{member.id}/mfa/reset"
    assert api.post(url, headers=manager.headers).status_code == 403
    assert api.post(url, headers=member.headers).status_code == 403

    reset = api.post(url, headers=clinician.headers)
    assert reset.status_code == 200
    assert reset.json()["mfa_enabled"] is False
    stored = _staff(db, member.id)
    assert stored.mfa_secret is None and stored.mfa_recovery_codes == []
    assert api.get("/api/me", headers=member.headers).status_code == 401
    [notice] = outbound_to(db, "casey@example.com")
    assert notice.subject == "Your two-factor authentication was reset"
    [event] = _events(db, MFA_RESET)
    assert (event.staff_id, event.detail) == (member.id, {"reset_by_staff_id": clinician.id})
    assert db.query(AuditEvent).filter_by(action="team.mfa_reset").count() == 1

    assert api.post(url, headers=clinician.headers).status_code == 409
    own = api.post(f"/api/team/{clinician.id}/mfa/reset", headers=clinician.headers)
    assert own.status_code == 400


def test_turning_2fa_off_is_recorded(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    secret = _enable_mfa(api, clinician.headers)
    disabled = api.post(
        "/api/auth/mfa/disable",
        json={"password": PASSWORD, "code": _code(secret, 1)},
        headers=clinician.headers,
    )
    assert disabled.status_code == 200
    [event] = _events(db, MFA_DISABLED)
    assert event.severity == "info" and event.staff_id == clinician.id


# --- Second-factor codes --------------------------------------------------------------------


def test_an_authenticator_code_cant_be_replayed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    secret = _enable_mfa(api, clinician.headers)
    used_for_setup = _code(secret)
    _, challenge = _login(api, clinician.email)
    replay = api.post(
        "/api/auth/login/mfa",
        json={"mfa_token": challenge["mfa_token"], "code": used_for_setup},
    )
    assert replay.status_code == 401
    fresh = _code(secret, 1)
    good = api.post(
        "/api/auth/login/mfa", json={"mfa_token": challenge["mfa_token"], "code": fresh}
    )
    assert good.status_code == 200
    _, again = _login(api, clinician.email)
    reused = api.post("/api/auth/login/mfa", json={"mfa_token": again["mfa_token"], "code": fresh})
    assert reused.status_code == 401


def test_a_challenge_allows_five_attempts(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    secret = _enable_mfa(api, clinician.headers)
    _, challenge = _login(api, clinician.email)
    for _ in range(5):
        wrong = api.post(
            "/api/auth/login/mfa", json={"mfa_token": challenge["mfa_token"], "code": "000000"}
        )
        assert wrong.json()["detail"] == "That code isn't right."
    sixth = api.post(
        "/api/auth/login/mfa",
        json={"mfa_token": challenge["mfa_token"], "code": _code(secret, 1)},
    )
    assert sixth.status_code == 401
    assert sixth.json()["detail"] == "Sign-in expired, please start again."
    failures = db.query(AuditEvent).filter_by(action="auth.mfa_failed").all()
    assert len(failures) == 5
    assert {e.detail["target_staff_id"] for e in failures} == {clinician.id}


# --- Throttling -----------------------------------------------------------------------------


def _unpause(db: Session, staff_id: int) -> None:
    staff = _staff(db, staff_id)
    staff.locked_until = utcnow() - timedelta(seconds=1)
    db.commit()
    reset_all_limits()


def _fail(api: TestClient, email: str) -> int:
    status_code, body = _login(api, email, "not the password at all")
    assert body["detail"] == BAD_CREDENTIALS
    return status_code


def test_sign_in_pauses_with_growing_backoff(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    for _ in range(4):
        _fail(api, clinician.email)
    assert _staff(db, clinician.id).locked_until is None
    _fail(api, clinician.email)
    paused = _staff(db, clinician.id)
    assert paused.failed_logins == 5
    assert timedelta(seconds=50) < paused.locked_until - utcnow() <= timedelta(minutes=1)
    # The right password gets the same answer while paused, and doesn't extend the pause.
    status_code, body = _login(api, clinician.email)
    assert (status_code, body["detail"]) == (401, BAD_CREDENTIALS)
    assert _staff(db, clinician.id).failed_logins == 5

    for minutes in (5, 15, 60, 60):
        _unpause(db, clinician.id)
        _fail(api, clinician.email)
        remaining = _staff(db, clinician.id).locked_until - utcnow()
        assert timedelta(minutes=minutes) - timedelta(seconds=10) < remaining
        assert remaining <= timedelta(minutes=minutes)

    _unpause(db, clinician.id)
    assert _login(api, clinician.email)[0] == 200
    cleared = _staff(db, clinician.id)
    assert (cleared.failed_logins, cleared.locked_until) == (0, None)
    paused_events = _events(db, SIGN_IN_PAUSED)
    assert len(paused_events) == 5
    assert paused_events[0].detail == {"failed_attempts": 5, "paused_minutes": 1}


def test_wrong_2fa_codes_count_toward_the_pause(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    secret = _enable_mfa(api, clinician.headers)
    for _ in range(3):
        _fail(api, clinician.email)
    _, challenge = _login(api, clinician.email)
    for _ in range(2):
        api.post(
            "/api/auth/login/mfa", json={"mfa_token": challenge["mfa_token"], "code": "1234567"}
        )
    assert _staff(db, clinician.id).locked_until is not None
    # While paused, even the right code and the right password are refused.
    right_code = api.post(
        "/api/auth/login/mfa",
        json={"mfa_token": challenge["mfa_token"], "code": _code(secret, 1)},
    )
    assert (right_code.status_code, right_code.json()["detail"]) == (401, "That code isn't right.")
    status_code, body = _login(api, clinician.email)
    assert (status_code, body["detail"]) == (401, BAD_CREDENTIALS)


def test_repeated_failures_alert_the_practice_once(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    biller = add_staff(db, clinician.practice_id, "bill@example.com", StaffRole.BILLER)
    target = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    for attempt in range(12):
        if attempt and attempt % 4 == 0:
            _unpause(db, target.id)
        _fail(api, "casey@example.com")
    [alert] = _events(db, REPEATED_FAILURES)
    assert (alert.severity, alert.staff_id) == ("warning", target.id)
    assert alert.detail["failed_attempts_24h"] == 10
    for reviewer in (clinician.email, manager.email):
        [email] = outbound_to(db, reviewer)
        assert email.subject == "Security alert: Repeated failed sign-ins"
        assert "casey" not in email.body_text.lower()
    assert outbound_to(db, biller.email) == []
    assert outbound_to(db, "casey@example.com") == []
    notified = {
        n.recipient_id for n in db.query(Notification).filter_by(kind="security_event").all()
    }
    assert notified == {clinician.id, manager.id}


def test_failed_sign_ins_name_the_targeted_account(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _fail(api, clinician.email)
    _fail(api, "nobody@example.com")
    known, unknown = (
        db.query(AuditEvent).filter_by(action="auth.login_failed").order_by(AuditEvent.id)
    )
    assert known.detail == {"target_staff_id": clinician.id}
    assert known.practice_id == clinician.practice_id
    assert unknown.detail is None and unknown.practice_id is None


@pytest.mark.usefixtures("steady_rate_limits")
def test_sign_in_is_rate_limited_per_email_across_addresses(
    api: TestClient, clinician: StaffAccount
) -> None:
    body = {"email": "nobody@example.com", "password": "x" * 12}
    for index in range(10):
        other_ip = TestClient(app, client=(f"10.0.0.{index}", 5000))
        assert other_ip.post("/api/auth/login", json=body).status_code == 401
    another = TestClient(app, client=("10.0.1.1", 5000))
    assert another.post("/api/auth/login", json=body).status_code == 429
    other_email = {"email": clinician.email, "password": PASSWORD}
    assert another.post("/api/auth/login", json=other_email).status_code == 200


# --- New devices ----------------------------------------------------------------------------


def test_sign_in_from_a_new_device_is_flagged(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    assert _login(api, clinician.email)[0] == 200
    assert _events(db, NEW_DEVICE) == []
    elsewhere = TestClient(app, client=("203.0.113.9", 5000))
    response = elsewhere.post(
        "/api/auth/login",
        json={"email": clinician.email, "password": PASSWORD},
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0"},
    )
    assert response.status_code == 200
    [event] = _events(db, NEW_DEVICE)
    assert event.severity == "info" and event.staff_id == clinician.id
    session = db.get(AuthSession, event.detail["session_id"])
    assert session.ip_address == "203.0.113.9"
    [email] = outbound_to(db, clinician.email)
    assert email.subject == "New sign-in to your Synari account"
