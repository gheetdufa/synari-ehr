"""Emergency ("break-glass") access to a client's chart.

Who may use it: clinicians (anyone with `is_clinician`) who can't already open the chart, e.g. a
colleague covering a crisis while the client's clinician is away. Staff who aren't clinicians
(billers, schedulers, non-clinician managers) never get clinical access this way; owners already
have it.

What it opens: the client's chart at the PROFILE and CLINICAL levels (never BILLING) for four
hours, unless an owner ends it sooner (honored by synari/access.py). Every audit event about the
client while the grant lasts carries emergency=true.

Who hears about it: a security event alerts the practice's security reviewers (owners and
managers) in the app and by email, the client's primary clinician gets an in-app notification
and an email, and the grant waits in the owners' review queue until someone reviews it.
"""

from datetime import timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess, forget_emergency_grants
from synari.audit import audit_staff
from synari.config import settings
from synari.db import utcnow
from synari.models import Client, EmergencyAccessGrant, StaffMember
from synari.models.enums import Role, SecuritySeverity
from synari.ratelimit import enforce_limit
from synari.services.email_templates import render_email
from synari.services.notifications import notify, short_name
from synari.services.outbox import queue_email
from synari.services.security_events import (
    EMERGENCY_ACCESS,
    is_security_reviewer,
    record_security_event,
)

GRANT_DURATION = timedelta(hours=4)
# At most this many emergency grants per person per hour.
GRANTS_PER_HOUR = 5
NOTIFICATION_KIND = "emergency_access"


def is_active(grant: EmergencyAccessGrant) -> bool:
    """Whether a grant still opens the chart."""
    return grant.revoked_at is None and grant.expires_at > utcnow()


def _notify_primary_clinician(
    db: Session, client: Client, grant: EmergencyAccessGrant, requester: StaffMember
) -> None:
    primary = client.primary_clinician
    if (
        primary is None
        or primary.id == requester.id
        or not primary.is_active
        or is_security_reviewer(primary)
    ):
        return
    notify(
        db,
        Role.STAFF,
        primary.id,
        kind=NOTIFICATION_KIND,
        title=f"{requester.full_name} used emergency access to {short_name(client)}'s chart",
        link=f"/portal/clients/{client.id}",
        urgent=True,
    )
    queue_email(
        db,
        to=primary.email,
        practice_id=client.practice_id,
        content=render_email(
            subject="Emergency access to one of your clients' records",
            heading="Emergency access was used",
            paragraphs=[
                "A team member used emergency access to open the record of a client you're the "
                "primary clinician for. Your practice's owners have been notified and will "
                "review it.",
                "Sign in to Synari to see the details.",
            ],
            sender_name=client.practice.name,
            button_label="Open Synari",
            button_url=f"{settings.frontend_url.rstrip('/')}/portal",
        ),
        dedupe_key=f"emergency-access:{grant.id}:{primary.id}",
    )


def grant_emergency_access(
    db: Session, access: Access, client_id: int, reason: str, request: Request
) -> EmergencyAccessGrant:
    """Open a chart for four hours in an emergency and tell the people who oversee it (caller
    commits)."""
    staff = access.staff
    if not staff.is_clinician:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only clinicians can use emergency access")
    client = db.get(Client, client_id)
    if client is None or client.practice_id != access.practice_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
    if access.can_access_client(client, ClientAccess.CLINICAL):
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have access to this chart")
    enforce_limit(
        "emergency-access",
        f"staff:{staff.id}",
        limit=GRANTS_PER_HOUR,
        window_seconds=3600,
        detail="You've used emergency access too often. Ask an owner for access instead.",
    )
    grant = EmergencyAccessGrant(
        practice_id=access.practice_id,
        staff_id=staff.id,
        client_id=client.id,
        reason=reason.strip(),
        expires_at=utcnow() + GRANT_DURATION,
    )
    db.add(grant)
    db.flush()
    forget_emergency_grants(db)
    audit_staff(
        db,
        request,
        staff,
        "client.emergency_access",
        "emergency_access_grant",
        grant.id,
        client_id=client.id,
    )
    record_security_event(
        db,
        practice_id=access.practice_id,
        kind=EMERGENCY_ACCESS,
        severity=SecuritySeverity.WARNING,
        staff_id=staff.id,
        detail={"grant_id": grant.id, "client_id": client.id},
    )
    _notify_primary_clinician(db, client, grant, staff)
    return grant


def end_emergency_access(db: Session, grant: EmergencyAccessGrant) -> None:
    """End a grant now (caller audits and commits)."""
    if grant.revoked_at is None:
        grant.revoked_at = utcnow()
    forget_emergency_grants(db)
