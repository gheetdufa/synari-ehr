"""Server admin commands (python -m synari.admin): reset-mfa, unlock and create-owner, audited
as the system actor."""

from datetime import timedelta

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari import admin
from synari.db import utcnow
from synari.models import AuditEvent, SecurityEvent, StaffMember
from synari.models.enums import StaffRole
from synari.services.security_events import ACCOUNT_UNLOCKED, MFA_RESET, OWNER_CREATED
from tests.conftest import StaffAccount, outbound_to

PASSWORD = "correct horse battery"


def _staff(db: Session, staff_id: int) -> StaffMember:
    db.expire_all()
    return db.get(StaffMember, staff_id)


def _system_audit(db: Session, action: str) -> AuditEvent:
    db.expire_all()
    event = db.scalar(select(AuditEvent).where(AuditEvent.action == action))
    assert event is not None
    assert (event.actor_role, event.actor_id) == ("system", None)
    return event


def _kinds(db: Session) -> list[str]:
    db.expire_all()
    return [event.kind for event in db.scalars(select(SecurityEvent).order_by(SecurityEvent.id))]


def test_reset_mfa(
    api: TestClient, clinician: StaffAccount, db: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = api.post("/api/auth/mfa/setup", headers=clinician.headers).json()["secret"]
    api.post(
        "/api/auth/mfa/enable",
        json={"code": pyotp.TOTP(secret).now()},
        headers=clinician.headers,
    )
    assert admin.main(["reset-mfa", "JORDAN@example.com"]) == 0
    assert "was reset" in capsys.readouterr().out
    assert _staff(db, clinician.id).mfa_enabled is False
    assert api.get("/api/me", headers=clinician.headers).status_code == 401
    event = _system_audit(db, "admin.mfa_reset")
    assert (event.resource_type, event.resource_id) == ("staff", clinician.id)
    assert _kinds(db) == [MFA_RESET]
    # They're told, and (as the practice's only owner here) so is the security feed.
    assert {m.subject for m in outbound_to(db, clinician.email)} == {
        "Your two-factor authentication was reset",
        "Security alert: Two-factor authentication reset",
    }

    assert admin.main(["reset-mfa", clinician.email]) == 0
    assert "already off" in capsys.readouterr().out
    assert admin.main(["reset-mfa", "ghost@example.com"]) == 1
    assert "No staff account" in capsys.readouterr().err


def test_unlock(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    staff = _staff(db, clinician.id)
    staff.failed_logins = 7
    staff.locked_until = utcnow() + timedelta(minutes=60)
    db.commit()
    assert (
        api.post(
            "/api/auth/login", json={"email": clinician.email, "password": PASSWORD}
        ).status_code
        == 401
    )

    assert admin.main(["unlock", clinician.email]) == 0
    unlocked = _staff(db, clinician.id)
    assert (unlocked.failed_logins, unlocked.locked_until) == (0, None)
    _system_audit(db, "admin.unlock")
    assert _kinds(db) == [ACCOUNT_UNLOCKED]
    assert (
        api.post(
            "/api/auth/login", json={"email": clinician.email, "password": PASSWORD}
        ).status_code
        == 200
    )


def test_create_owner(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    code = admin.main(
        [
            "create-owner",
            "--practice-id",
            str(clinician.practice_id),
            "--email",
            "New.Owner@example.com",
            "--first-name",
            "Robin",
            "--last-name",
            "Park",
            "--password",
            "harbor window lantern",
        ]
    )
    assert code == 0
    owner = db.scalar(select(StaffMember).where(StaffMember.email == "new.owner@example.com"))
    assert (owner.role, owner.status, owner.practice_id) == (
        StaffRole.OWNER,
        "active",
        clinician.practice_id,
    )
    assert owner.is_clinician is False
    _system_audit(db, "admin.create_owner")
    assert _kinds(db) == [OWNER_CREATED]
    signed_in = api.post(
        "/api/auth/login",
        json={"email": "new.owner@example.com", "password": "harbor window lantern"},
    )
    assert signed_in.status_code == 200
    assert "manage_team" in signed_in.json()["capabilities"]


def test_create_owner_prompts_for_the_password(
    clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    answers = iter(["harbor window lantern", "harbor window lantern"])
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: next(answers))
    args = [
        "create-owner",
        "--practice-id",
        str(clinician.practice_id),
        "--email",
        "robin@example.com",
        "--first-name",
        "Robin",
        "--last-name",
        "Park",
        "--clinician",
    ]
    assert admin.main(args) == 0
    owner = db.scalar(select(StaffMember).where(StaffMember.email == "robin@example.com"))
    assert owner.is_clinician is True


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"--practice-id": "999999"}, "No practice with id"),
        ({"--email": "jordan@example.com"}, "already has an account"),
        ({"--email": "not-an-email"}, "isn't a valid email address"),
        ({"--password": "password1234"}, "too common"),
        ({"--password": "RobinPark2024"}, "Don't base your password"),  # gitleaks:allow
    ],
)
def test_create_owner_refuses_bad_input(
    clinician: StaffAccount,
    db: Session,
    capsys: pytest.CaptureFixture[str],
    overrides: dict[str, str],
    message: str,
) -> None:
    options = {
        "--practice-id": str(clinician.practice_id),
        "--email": "robin@example.com",
        "--first-name": "Robin",
        "--last-name": "Park",
        "--password": "harbor window lantern",
        **overrides,
    }
    args = ["create-owner"]
    for flag, value in options.items():
        args += [flag, value]
    assert admin.main(args) == 1
    assert message in capsys.readouterr().err
    assert db.scalar(select(StaffMember).where(StaffMember.email == "robin@example.com")) is None


def test_mismatched_prompted_passwords_are_refused(
    clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    answers = iter(["harbor window lantern", "harbor window lanterns"])
    monkeypatch.setattr(admin.getpass, "getpass", lambda prompt: next(answers))
    args = [
        "create-owner",
        "--practice-id",
        str(clinician.practice_id),
        "--email",
        "robin@example.com",
        "--first-name",
        "Robin",
        "--last-name",
        "Park",
    ]
    assert admin.main(args) == 1
    assert "don't match" in capsys.readouterr().err
