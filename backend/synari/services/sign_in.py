"""Staff sign-in protections: throttling after failed attempts, alerts about attacks and new
devices, the two-factor requirement, and account recovery (2FA reset, unlock, sign out
everywhere).

Throttling pauses sign-in instead of locking accounts: after 5 consecutive failures (password or
2FA code) the account waits 1 minute, then 5, 15 and 60 minutes after each further failure.
Attempts during a pause get the same generic error as a wrong password and don't extend it.
10 failures in 24 hours raise a security event that emails the practice's reviewers.
"""

from datetime import datetime, timedelta

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.audit import audit_anonymous, audit_staff
from synari.config import settings
from synari.db import utcnow
from synari.models import AuditEvent, PracticeSettings, StaffMember
from synari.models.enums import Role, SecuritySeverity
from synari.services import sessions
from synari.services.email_templates import render_email
from synari.services.mfa import clear_mfa
from synari.services.outbox import queue_email
from synari.services.security_events import (
    MFA_RESET,
    NEW_DEVICE,
    REPEATED_FAILURES,
    SIGN_IN_PAUSED,
    recent_event_exists,
    record_security_event,
)

PAUSE_AFTER_FAILURES = 5
PAUSE_STEPS = (
    timedelta(minutes=1),
    timedelta(minutes=5),
    timedelta(minutes=15),
    timedelta(minutes=60),
)
ALERT_AFTER_FAILURES = 10
ALERT_WINDOW = timedelta(hours=24)
LOGIN_FAILED = "auth.login_failed"
MFA_FAILED = "auth.mfa_failed"


def mfa_server_policy() -> str | None:
    """The server's REQUIRE_STAFF_MFA override: "required", "off", or None (practices decide)."""
    if settings.require_staff_mfa is None:
        return None
    return "required" if settings.require_staff_mfa else "off"


def practice_requires_mfa(practice_settings: PracticeSettings) -> bool:
    """Whether a practice's staff must use two-factor authentication (the server may decide)."""
    if settings.require_staff_mfa is not None:
        return settings.require_staff_mfa
    return practice_settings.require_staff_mfa


def mfa_required(staff: StaffMember) -> bool:
    """Whether this person must use two-factor authentication."""
    return practice_requires_mfa(staff.practice.settings)


def needs_mfa_setup(staff: StaffMember) -> bool:
    """Whether this person may only set up 2FA until they do (an enrollment-only session)."""
    return mfa_required(staff) and not staff.mfa_enabled


def is_paused(staff: StaffMember, now: datetime | None = None) -> bool:
    """Whether sign-in is paused for this account after repeated failures."""
    return staff.locked_until is not None and staff.locked_until > (now or utcnow())


def _failures_in_window(db: Session, staff: StaffMember, now: datetime) -> int:
    return (
        db.scalar(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.practice_id == staff.practice_id,
                AuditEvent.action.in_((LOGIN_FAILED, MFA_FAILED)),
                AuditEvent.created_at >= now - ALERT_WINDOW,
                AuditEvent.detail["target_staff_id"].as_integer() == staff.id,
            )
        )
        or 0
    )


def record_failed_sign_in(
    db: Session, request: Request, staff: StaffMember | None, action: str
) -> None:
    """Audit a failed password or 2FA step and apply throttling and alerts (caller commits).

    `staff` is the account the attempt targeted, when it exists.
    """
    now = utcnow()
    if staff is None:
        audit_anonymous(db, request, action)
        return
    paused = is_paused(staff, now)
    detail: dict[str, object] = {"target_staff_id": staff.id}
    if paused:
        detail["paused"] = True
    audit_anonymous(db, request, action, practice_id=staff.practice_id, detail=detail)
    if not staff.is_active:
        return
    if not paused:
        staff.failed_logins += 1
        if staff.failed_logins >= PAUSE_AFTER_FAILURES:
            step = min(staff.failed_logins - PAUSE_AFTER_FAILURES, len(PAUSE_STEPS) - 1)
            staff.locked_until = now + PAUSE_STEPS[step]
            record_security_event(
                db,
                practice_id=staff.practice_id,
                kind=SIGN_IN_PAUSED,
                severity=SecuritySeverity.INFO,
                staff_id=staff.id,
                detail={
                    "failed_attempts": staff.failed_logins,
                    "paused_minutes": int(PAUSE_STEPS[step].total_seconds() // 60),
                },
            )
    db.flush()
    failures = _failures_in_window(db, staff, now)
    if failures >= ALERT_AFTER_FAILURES and not recent_event_exists(
        db, kind=REPEATED_FAILURES, staff_id=staff.id, since=now - ALERT_WINDOW
    ):
        record_security_event(
            db,
            practice_id=staff.practice_id,
            kind=REPEATED_FAILURES,
            severity=SecuritySeverity.WARNING,
            staff_id=staff.id,
            detail={"failed_attempts_24h": failures},
        )


def clear_throttle(staff: StaffMember) -> None:
    """Forget failed attempts (after a successful sign-in, password reset or admin unlock)."""
    staff.failed_logins = 0
    staff.locked_until = None


def _queue_new_device_email(db: Session, staff: StaffMember) -> None:
    queue_email(
        db,
        to=staff.email,
        practice_id=staff.practice_id,
        content=render_email(
            subject="New sign-in to your Synari account",
            heading="New sign-in to your account",
            paragraphs=[
                "Your Synari account was just signed in to from a device and location it "
                "hasn't used recently.",
                "If this was you, there's nothing to do. If it wasn't, change your password "
                "and sign out everywhere from Settings, then Security.",
            ],
            sender_name="Synari",
            button_label="Review your sessions",
            button_url=f"{settings.frontend_url.rstrip('/')}/portal/settings?tab=security",
        ),
    )


def complete_sign_in(
    db: Session, request: Request, staff: StaffMember, *, mfa: bool
) -> sessions.IssuedTokens:
    """Start a session after the password (and 2FA code, if any) checked out (caller commits).

    Clears throttling, audits the sign-in and flags sign-ins from a new device.
    """
    clear_throttle(staff)
    staff.last_login_at = utcnow()
    new_device = sessions.is_new_device(db, staff, request)
    tokens = sessions.start_staff_session(db, staff, request)
    audit_staff(db, request, staff, "auth.login", detail={"mfa": True} if mfa else None)
    if new_device:
        record_security_event(
            db,
            practice_id=staff.practice_id,
            kind=NEW_DEVICE,
            severity=SecuritySeverity.INFO,
            staff_id=staff.id,
            detail={"session_id": tokens.session_id},
        )
        _queue_new_device_email(db, staff)
    return tokens


def sign_out_everywhere(db: Session, staff: StaffMember, reason: str) -> None:
    """End every session and invalidate every token of a staff account (caller commits)."""
    staff.token_version += 1
    sessions.revoke_all(db, Role.STAFF, staff.id, reason)


def reset_mfa(db: Session, staff: StaffMember, *, reset_by_id: int | None) -> None:
    """Turn off someone's 2FA so they can set it up again (lost phone), sign them out everywhere,
    tell them by email and record a security event (caller audits and commits).

    `reset_by_id` is the owner who did it, or None for the server's admin command.
    """
    clear_mfa(staff)
    sign_out_everywhere(db, staff, sessions.REVOKED_MFA_RESET)
    record_security_event(
        db,
        practice_id=staff.practice_id,
        kind=MFA_RESET,
        severity=SecuritySeverity.WARNING,
        staff_id=staff.id,
        detail={"reset_by_staff_id": reset_by_id},
    )
    queue_email(
        db,
        to=staff.email,
        practice_id=staff.practice_id,
        content=render_email(
            subject="Your two-factor authentication was reset",
            heading="Two-factor authentication was reset",
            paragraphs=[
                "Two-factor authentication on your Synari account was reset, and you were "
                "signed out everywhere.",
                "Sign in again and set up your authenticator app. If you didn't ask for this, "
                "contact your practice's owner right away.",
            ],
            sender_name="Synari",
            button_label="Sign in",
            button_url=f"{settings.frontend_url.rstrip('/')}/login",
        ),
    )
