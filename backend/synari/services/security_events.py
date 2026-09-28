"""Security events: what a practice's owners should know about.

Repeated failed sign-ins, 2FA resets, reused refresh tokens, emergency access, exports, role
changes and unusual access volume are recorded as `SecurityEvent`s. Warnings and critical events
also alert the practice's security reviewers (staff who manage the team or read the audit log)
in the app and by email. Details hold ids and counts only, never clinical content, and alerts
only name the kind of event and link to Settings -> Security.
"""

import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import distinct, exists, func, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import AuditEvent, Practice, SecurityEvent, StaffMember
from synari.models.enums import Role, SecuritySeverity
from synari.permissions import Capability, capabilities_for
from synari.services.email_templates import EmailContent, render_email
from synari.services.notifications import notify
from synari.services.outbox import queue_email
from synari.services.recipients import active_staff

logger = logging.getLogger(__name__)

SECURITY_SETTINGS_PATH = "/portal/settings?tab=security"
NOTIFICATION_KIND = "security_event"

# Event kinds recorded by the sign-in and access code.
SIGN_IN_PAUSED = "auth.sign_in_paused"
REPEATED_FAILURES = "auth.repeated_failures"
NEW_DEVICE = "auth.new_device"
REFRESH_TOKEN_REUSE = "auth.refresh_token_reuse"
MFA_DISABLED = "mfa.disabled"
MFA_RESET = "mfa.reset"
MFA_REQUIREMENT_DISABLED = "mfa.requirement_disabled"
EMERGENCY_ACCESS = "emergency_access.granted"
ROLE_CHANGED = "team.role_changed"
CLIENT_EXPORTED = "client.exported"
UNUSUAL_ACCESS_VOLUME = "access.unusual_volume"
ACCOUNT_UNLOCKED = "account.unlocked"
OWNER_CREATED = "account.owner_created"

KIND_LABELS = {
    SIGN_IN_PAUSED: "Sign-in paused after failed attempts",
    REPEATED_FAILURES: "Repeated failed sign-ins",
    NEW_DEVICE: "Sign-in from a new device",
    REFRESH_TOKEN_REUSE: "Reused sign-in token (possible stolen session)",
    MFA_DISABLED: "Two-factor authentication turned off",
    MFA_RESET: "Two-factor authentication reset",
    MFA_REQUIREMENT_DISABLED: "Two-factor requirement turned off",
    EMERGENCY_ACCESS: "Emergency access to a client record",
    ROLE_CHANGED: "Team role changed",
    CLIENT_EXPORTED: "Client record exported",
    UNUSUAL_ACCESS_VOLUME: "Unusually many client records opened",
    ACCOUNT_UNLOCKED: "Sign-in unlocked by an administrator",
    OWNER_CREATED: "Owner account created by an administrator",
    # Recorded elsewhere (audit log, note integrity, estimates, backups).
    "audit.verification_run": "Activity log integrity verified",
    "audit.verification_failed": "Activity log integrity check failed",
    "audit_log.exported": "Activity log exported",
    "note.integrity_mismatch": "A signed note doesn't match its recorded hash",
    "gfe_overage": "Invoice above a good faith estimate",
    "backup.completed": "Backup completed",
    "backup.failed": "Backup failed",
    "backup.overdue": "No recent backup",
    "backup.restore_tested": "Backup restore test passed",
    "backup.restore_test_failed": "Backup restore test failed",
    "backup.restore_test_overdue": "No recent backup restore test",
}

# Serializes the detector across workers (an arbitrary constant for pg_advisory_xact_lock).
_DETECTOR_LOCK_KEY = 7_311_204


def security_event_label(kind: str) -> str:
    """Human-readable name of an event kind (a readable fallback for kinds added elsewhere)."""
    return KIND_LABELS.get(kind) or kind.replace("_", " ").replace(".", ": ").capitalize()


def is_security_reviewer(staff: StaffMember) -> bool:
    """Staff who see the security events feed and get its alerts."""
    capabilities = capabilities_for(staff)
    return Capability.MANAGE_TEAM in capabilities or Capability.VIEW_AUDIT_LOG in capabilities


def security_reviewers(db: Session, practice_id: int) -> list[StaffMember]:
    """Active staff who review the practice's security events."""
    return [member for member in active_staff(db, practice_id) if is_security_reviewer(member)]


def _alert_email(practice_name: str, label: str) -> EmailContent:
    return render_email(
        subject=f"Security alert: {label}",
        heading="A security event needs your review",
        paragraphs=[
            f"Synari recorded a security event for {practice_name}: {label}.",
            "Sign in and open Settings, then Security, to see the details and acknowledge it.",
        ],
        sender_name="Synari",
        button_label="Review security events",
        button_url=f"{settings.frontend_url.rstrip('/')}{SECURITY_SETTINGS_PATH}",
    )


def sole_practice_id(db: Session) -> int | None:
    """The practice's id when it's the only one on this server, else None.

    Server-wide events (backups, the audit log's own checks) belong to whoever runs the
    server. When a single practice does, they also show in its feed and alert its reviewers;
    on a server hosting several practices they go to SECURITY_ALERT_EMAIL only, so no practice
    sees or acknowledges them for the others.
    """
    ids = db.scalars(select(Practice.id).limit(2)).all()
    return ids[0] if len(ids) == 1 else None


def _alert_reviewers(db: Session, event: SecurityEvent, practice_id: int, label: str) -> None:
    practice = db.get(Practice, practice_id)
    practice_name = practice.name if practice is not None else "your practice"
    for member in security_reviewers(db, practice_id):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind=NOTIFICATION_KIND,
            title=f"Security alert: {label}",
            link=SECURITY_SETTINGS_PATH,
            urgent=event.severity == SecuritySeverity.CRITICAL,
        )
        queue_email(
            db,
            to=member.email,
            practice_id=practice_id,
            content=_alert_email(practice_name, label),
            dedupe_key=f"security-event:{event.id}:{member.id}",
        )


def _alert(db: Session, event: SecurityEvent) -> None:
    label = security_event_label(event.kind)
    if event.practice_id is not None:
        _alert_reviewers(db, event, event.practice_id, label)
        return
    logger.warning("Server security event %s (%s), id %s", event.kind, event.severity, event.id)
    if settings.security_alert_email:
        queue_email(
            db,
            to=settings.security_alert_email,
            content=_alert_email("this Synari server", label),
            dedupe_key=f"security-event:{event.id}:server",
        )
    sole = sole_practice_id(db)
    if sole is not None:
        _alert_reviewers(db, event, sole, label)


def record_security_event(
    db: Session,
    *,
    practice_id: int | None,
    kind: str,
    severity: SecuritySeverity,
    staff_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> SecurityEvent:
    """Record a security event; warnings and critical events alert the practice's reviewers.

    `practice_id` is None for server-wide events (they show in every practice's feed and are
    emailed to SECURITY_ALERT_EMAIL). `staff_id` is the account the event is about. `detail`
    holds ids and counts only, never clinical content. The caller commits.
    """
    event = SecurityEvent(
        practice_id=practice_id,
        kind=kind,
        severity=severity,
        staff_id=staff_id,
        detail=detail,
    )
    db.add(event)
    db.flush()
    if severity != SecuritySeverity.INFO:
        _alert(db, event)
    return event


def recent_event_exists(db: Session, *, kind: str, staff_id: int | None, since: datetime) -> bool:
    """Whether an event of `kind` about `staff_id` was recorded since `since` (for dedupe)."""
    return bool(
        db.scalar(
            select(
                exists().where(
                    SecurityEvent.kind == kind,
                    SecurityEvent.staff_id == staff_id,
                    SecurityEvent.created_at >= since,
                )
            )
        )
    )


def detect_security_events(db: Session, now: datetime) -> None:
    """Worker job: flag anyone who opened more distinct clients in the last hour than
    SECURITY_ALERT_CLIENTS_PER_HOUR allows (from audit events that name a client)."""
    db.execute(select(func.pg_advisory_xact_lock(_DETECTOR_LOCK_KEY)))
    since = now - timedelta(hours=1)
    distinct_clients = func.count(distinct(AuditEvent.client_id))
    rows = db.execute(
        select(AuditEvent.practice_id, AuditEvent.actor_id, distinct_clients)
        .where(
            AuditEvent.actor_role == Role.STAFF,
            AuditEvent.actor_id.is_not(None),
            AuditEvent.practice_id.is_not(None),
            AuditEvent.client_id.is_not(None),
            AuditEvent.created_at >= since,
        )
        .group_by(AuditEvent.practice_id, AuditEvent.actor_id)
        .having(distinct_clients > settings.security_alert_clients_per_hour)
    ).all()
    for practice_id, staff_id, count in rows:
        if recent_event_exists(db, kind=UNUSUAL_ACCESS_VOLUME, staff_id=staff_id, since=since):
            continue
        record_security_event(
            db,
            practice_id=practice_id,
            kind=UNUSUAL_ACCESS_VOLUME,
            severity=SecuritySeverity.WARNING,
            staff_id=staff_id,
            detail={"distinct_clients": count, "window_minutes": 60},
        )
    db.commit()
