"""Account and practice security: your sessions, the practice's sign-in rules, the security
events feed and emergency ("break-glass") access to charts.

- /me/sessions: the devices signed in to your account; sign any of them out.
- /practice/security: whether 2FA is required and the idle limit (owners and practice managers
  change them).
- /practice/security-events: the feed for owners and managers (manage_team or view_audit_log).
- /clients/{id}/emergency-access: a clinician opens a chart they normally can't, for four hours
  (see synari/services/emergency_access.py); /practice/emergency-access is the owners' review
  queue.
"""

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import ColumnElement, select

from synari.audit import audit_staff
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentStaffSession, DbSession
from synari.models import AuthSession, Client, EmergencyAccessGrant, SecurityEvent, StaffMember
from synari.models.enums import Role, SecuritySeverity, StaffRole, StaffStatus
from synari.permissions import Capability
from synari.schemas.security import (
    AuthSessionOut,
    EmergencyAccessRequest,
    EmergencyGrantOut,
    EmergencyGrantReviewOut,
    EmergencyReviewRequest,
    PracticeSecurityOut,
    PracticeSecurityUpdate,
    SecurityEventOut,
)
from synari.services import sessions
from synari.services.emergency_access import (
    end_emergency_access,
    grant_emergency_access,
    is_active,
)
from synari.services.security_events import (
    MFA_REQUIREMENT_DISABLED,
    is_security_reviewer,
    record_security_event,
    security_event_label,
    sole_practice_id,
)
from synari.services.sign_in import mfa_server_policy, practice_requires_mfa

router = APIRouter(tags=["security"])


# Your sessions


def _session_out(session: AuthSession, current_id: str) -> AuthSessionOut:
    return AuthSessionOut(
        id=session.id,
        device=sessions.describe_device(session.user_agent),
        user_agent=session.user_agent,
        ip_address=session.ip_address,
        created_at=session.created_at,
        last_seen_at=session.last_seen_at,
        expires_at=session.expires_at,
        current=session.id == current_id,
    )


@router.get("/me/sessions", response_model=list[AuthSessionOut])
def list_my_sessions(current: CurrentStaffSession, db: DbSession) -> list[AuthSessionOut]:
    """The devices signed in to your account, most recently active first."""
    live = sessions.live_sessions(
        db, Role.STAFF, current.staff.id, sessions.staff_idle_minutes(current.staff)
    )
    return [_session_out(session, current.session.id) for session in live]


@router.delete("/me/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_my_session(
    session_id: str, current: CurrentStaffSession, db: DbSession, request: Request
) -> None:
    """Sign one of your devices out (this one too, if you choose it)."""
    session = db.get(AuthSession, session_id)
    if (
        session is None
        or session.subject_role != Role.STAFF
        or session.subject_id != current.staff.id
        or session.revoked_at is not None
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    sessions.revoke(session, sessions.REVOKED_BY_USER)
    audit_staff(
        db, request, current.staff, "auth.session_revoked", detail={"session_id": session.id}
    )
    db.commit()


# Practice sign-in rules


def _practice_security(access: CurrentAccess) -> PracticeSecurityOut:
    practice_settings = access.staff.practice.settings
    active = list(
        access.db.scalars(
            select(StaffMember).where(
                StaffMember.practice_id == access.practice_id,
                StaffMember.status == StaffStatus.ACTIVE,
            )
        )
    )
    return PracticeSecurityOut(
        require_staff_mfa=practice_settings.require_staff_mfa,
        mfa_server_policy=mfa_server_policy(),
        mfa_required=practice_requires_mfa(practice_settings),
        session_idle_minutes=sessions.clamp_idle_minutes(practice_settings.session_idle_minutes),
        staff_mfa_enabled=sum(1 for member in active if member.mfa_enabled),
        staff_active=len(active),
    )


@router.get("/practice/security", response_model=PracticeSecurityOut)
def get_practice_security(access: CurrentAccess) -> PracticeSecurityOut:
    """Whether staff must use 2FA, the idle limit, and how many people have 2FA on."""
    return _practice_security(access)


@router.patch("/practice/security", response_model=PracticeSecurityOut)
def update_practice_security(
    body: PracticeSecurityUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> PracticeSecurityOut:
    """Require 2FA for the team or not, and set how long sessions may sit idle (5-60 minutes).

    Owners and practice managers only. Turning the 2FA requirement off raises a security event.
    """
    access.require(Capability.MANAGE_TEAM)
    practice_settings = access.staff.practice.settings
    changes = body.model_dump(exclude_unset=True)
    turning_mfa_off = (
        practice_settings.require_staff_mfa and changes.get("require_staff_mfa") is False
    )
    for field, value in changes.items():
        setattr(practice_settings, field, value)
    audit_staff(
        db, request, access.staff, "practice.security_update", detail={"fields": sorted(changes)}
    )
    if turning_mfa_off:
        record_security_event(
            db,
            practice_id=access.practice_id,
            kind=MFA_REQUIREMENT_DISABLED,
            severity=SecuritySeverity.WARNING,
            staff_id=access.staff.id,
        )
    db.commit()
    return _practice_security(access)


# Security events


def _require_security_reviewer(access: CurrentAccess) -> None:
    if not is_security_reviewer(access.staff):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this")


def _names(db: DbSession, staff_ids: set[int | None]) -> dict[int, str]:
    ids = {staff_id for staff_id in staff_ids if staff_id is not None}
    if not ids:
        return {}
    return {
        member.id: member.full_name
        for member in db.scalars(select(StaffMember).where(StaffMember.id.in_(ids)))
    }


def _events_out(db: DbSession, events: list[SecurityEvent]) -> list[SecurityEventOut]:
    names = _names(db, {e.staff_id for e in events} | {e.acknowledged_by_id for e in events})
    return [
        SecurityEventOut(
            id=event.id,
            kind=event.kind,
            label=security_event_label(event.kind),
            severity=SecuritySeverity(event.severity),
            staff_id=event.staff_id,
            staff_name=names.get(event.staff_id or 0, ""),
            detail=event.detail,
            created_at=event.created_at,
            acknowledged_at=event.acknowledged_at,
            acknowledged_by_name=names.get(event.acknowledged_by_id or 0, ""),
        )
        for event in events
    ]


def _feed(access: CurrentAccess) -> ColumnElement[bool]:
    """The practice's events, plus server-wide ones when it's the server's only practice."""
    mine = SecurityEvent.practice_id == access.practice_id
    if sole_practice_id(access.db) == access.practice_id:
        return mine | SecurityEvent.practice_id.is_(None)
    return mine


def _visible_event(access: CurrentAccess, event_id: int) -> SecurityEvent:
    event = access.db.scalar(
        select(SecurityEvent).where(SecurityEvent.id == event_id, _feed(access))
    )
    if event is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Security event not found")
    return event


@router.get("/practice/security-events", response_model=list[SecurityEventOut])
def list_security_events(
    access: CurrentAccess,
    unacknowledged: bool = Query(default=False),
    severity: SecuritySeverity | None = Query(default=None),
    before_id: int | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[SecurityEventOut]:
    """The practice's security events (and server-wide ones when it's the server's only
    practice), newest first."""
    _require_security_reviewer(access)
    query = select(SecurityEvent).where(_feed(access))
    if unacknowledged:
        query = query.where(SecurityEvent.acknowledged_at.is_(None))
    if severity is not None:
        query = query.where(SecurityEvent.severity == severity)
    if before_id is not None:
        query = query.where(SecurityEvent.id < before_id)
    events = list(access.db.scalars(query.order_by(SecurityEvent.id.desc()).limit(limit)))
    return _events_out(access.db, events)


@router.post("/practice/security-events/{event_id}/acknowledge", response_model=SecurityEventOut)
def acknowledge_security_event(
    event_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> SecurityEventOut:
    """Mark a security event as reviewed."""
    _require_security_reviewer(access)
    event = _visible_event(access, event_id)
    if event.acknowledged_at is None:
        event.acknowledged_at = utcnow()
        event.acknowledged_by_id = access.staff.id
        audit_staff(
            db, request, access.staff, "security_event.acknowledge", "security_event", event.id
        )
        db.commit()
    return _events_out(db, [event])[0]


# Emergency access


@router.post(
    "/clients/{client_id}/emergency-access",
    response_model=EmergencyGrantOut,
    status_code=status.HTTP_201_CREATED,
)
def request_emergency_access(
    client_id: int,
    body: EmergencyAccessRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EmergencyAccessGrant:
    """Open a chart you normally can't, for four hours, in an emergency. Clinicians only; the
    owners and the client's clinician are told right away and the owners review it."""
    grant = grant_emergency_access(db, access, client_id, body.reason, request)
    db.commit()
    return grant


@router.get("/me/emergency-access", response_model=list[EmergencyGrantOut])
def list_my_emergency_access(access: CurrentAccess) -> list[EmergencyAccessGrant]:
    """Your emergency access grants that are still open."""
    return list(
        access.db.scalars(
            select(EmergencyAccessGrant)
            .where(
                EmergencyAccessGrant.staff_id == access.staff.id,
                EmergencyAccessGrant.revoked_at.is_(None),
                EmergencyAccessGrant.expires_at > utcnow(),
            )
            .order_by(EmergencyAccessGrant.id.desc())
        )
    )


def _require_owner(access: CurrentAccess) -> None:
    if access.staff.role != StaffRole.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can review emergency access")


def _grants_out(db: DbSession, grants: list[EmergencyAccessGrant]) -> list[EmergencyGrantReviewOut]:
    names = _names(db, {g.staff_id for g in grants} | {g.reviewed_by_id for g in grants})
    client_ids = {grant.client_id for grant in grants}
    clients = (
        {c.id: c for c in db.scalars(select(Client).where(Client.id.in_(client_ids)))}
        if client_ids
        else {}
    )
    return [
        EmergencyGrantReviewOut(
            id=grant.id,
            staff_id=grant.staff_id,
            staff_name=names.get(grant.staff_id, ""),
            client_id=grant.client_id,
            client_name=clients[grant.client_id].full_name if grant.client_id in clients else "",
            reason=grant.reason,
            created_at=grant.created_at,
            expires_at=grant.expires_at,
            revoked_at=grant.revoked_at,
            reviewed_at=grant.reviewed_at,
            reviewed_by_name=names.get(grant.reviewed_by_id or 0, ""),
            review_note=grant.review_note,
            active=is_active(grant),
        )
        for grant in grants
    ]


def _grant(access: CurrentAccess, grant_id: int) -> EmergencyAccessGrant:
    return access.get(EmergencyAccessGrant, grant_id, label="Emergency access")


@router.get("/practice/emergency-access", response_model=list[EmergencyGrantReviewOut])
def list_emergency_access(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    pending_only: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[EmergencyGrantReviewOut]:
    """The owners' review queue of emergency access, newest first."""
    _require_owner(access)
    query = select(EmergencyAccessGrant).where(
        EmergencyAccessGrant.practice_id == access.practice_id
    )
    if pending_only:
        query = query.where(EmergencyAccessGrant.reviewed_at.is_(None))
    grants = list(db.scalars(query.order_by(EmergencyAccessGrant.id.desc()).limit(limit)))
    audit_staff(
        db,
        request,
        access.staff,
        "emergency_access.list",
        detail={"client_ids": sorted({grant.client_id for grant in grants})},
    )
    db.commit()
    return _grants_out(db, grants)


@router.post("/practice/emergency-access/{grant_id}/review", response_model=EmergencyGrantReviewOut)
def review_emergency_access(
    grant_id: int,
    body: EmergencyReviewRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EmergencyGrantReviewOut:
    """Mark an emergency access grant reviewed, with an optional note."""
    _require_owner(access)
    grant = _grant(access, grant_id)
    grant.reviewed_by_id = access.staff.id
    grant.reviewed_at = utcnow()
    grant.review_note = body.note.strip()
    audit_staff(
        db,
        request,
        access.staff,
        "emergency_access.review",
        "emergency_access_grant",
        grant.id,
        client_id=grant.client_id,
    )
    db.commit()
    return _grants_out(db, [grant])[0]


@router.post("/practice/emergency-access/{grant_id}/revoke", response_model=EmergencyGrantReviewOut)
def revoke_emergency_access(
    grant_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> EmergencyGrantReviewOut:
    """End an emergency access grant now."""
    _require_owner(access)
    grant = _grant(access, grant_id)
    end_emergency_access(db, grant)
    audit_staff(
        db,
        request,
        access.staff,
        "emergency_access.revoke",
        "emergency_access_grant",
        grant.id,
        client_id=grant.client_id,
    )
    db.commit()
    return _grants_out(db, [grant])[0]
