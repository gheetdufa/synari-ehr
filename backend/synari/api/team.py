"""The practice team: invitations, roles, supervision, deactivation, sessions, 2FA resets and
clinician rates."""

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, select

from synari.audit import audit_staff
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import AuthToken, ClinicianService, Service, StaffMember
from synari.models.enums import (
    AuthTokenPurpose,
    ClinicianAccess,
    SecuritySeverity,
    StaffRole,
    StaffStatus,
)
from synari.permissions import ROLES_THAT_CAN_BE_CLINICIANS, Capability
from synari.schemas.common import Message
from synari.schemas.team import (
    ClinicianServiceRate,
    InviteRequest,
    TeamMemberOut,
    TeamMemberUpdate,
)
from synari.services import sessions
from synari.services.calendar_sync.oauth import disconnect_staff
from synari.services.security_events import ROLE_CHANGED, record_security_event
from synari.services.sign_in import reset_mfa, sign_out_everywhere
from synari.services.staff import active_owner_count, send_invitation

router = APIRouter(prefix="/team", tags=["team"])


def _member(access: CurrentAccess, staff_id: int) -> StaffMember:
    member = access.db.get(StaffMember, staff_id)
    if member is None or member.practice_id != access.practice_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Team member not found")
    return member


def _is_clinician_for(role: StaffRole, requested: bool) -> bool:
    if role == StaffRole.CLINICIAN:
        return True
    return requested and role in ROLES_THAT_CAN_BE_CLINICIANS


def _check_supervisor(
    access: CurrentAccess, supervisor_id: int | None, member_id: int | None
) -> None:
    if supervisor_id is None:
        return
    if supervisor_id == member_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Someone can't supervise themselves")
    supervisor = access.db.get(StaffMember, supervisor_id)
    if (
        supervisor is None
        or supervisor.practice_id != access.practice_id
        or supervisor.status != StaffStatus.ACTIVE
        or not supervisor.is_clinician
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose an active clinician as supervisor")


def _require_owner_for(access: CurrentAccess, *roles: str) -> None:
    if StaffRole.OWNER in roles and access.staff.role != StaffRole.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an owner can manage owners")


def _record_role_change(
    access: CurrentAccess, member: StaffMember, before: dict[str, object]
) -> None:
    after = {
        "role": member.role,
        "clinician_access": member.clinician_access,
        "is_clinician": member.is_clinician,
    }
    if after == before:
        return
    elevated = member.role in (StaffRole.OWNER, StaffRole.PRACTICE_MANAGER) or (
        member.role == StaffRole.CLINICIAN and member.clinician_access == ClinicianAccess.PRACTICE
    )
    record_security_event(
        access.db,
        practice_id=access.practice_id,
        kind=ROLE_CHANGED,
        severity=SecuritySeverity.WARNING if elevated else SecuritySeverity.INFO,
        staff_id=member.id,
        detail={"changed_by_staff_id": access.staff.id, "before": before, "after": after},
    )


@router.get("", response_model=list[TeamMemberOut])
def list_team(access: CurrentAccess) -> list[StaffMember]:
    """Everyone in the practice. Pending and deactivated members are shown to team managers."""
    query = select(StaffMember).where(StaffMember.practice_id == access.practice_id)
    if not access.can(Capability.MANAGE_TEAM):
        query = query.where(StaffMember.status == StaffStatus.ACTIVE)
    return list(access.db.scalars(query.order_by(StaffMember.last_name, StaffMember.first_name)))


@router.post("/invitations", response_model=TeamMemberOut, status_code=status.HTTP_201_CREATED)
def invite(
    body: InviteRequest, access: CurrentAccess, db: DbSession, request: Request
) -> StaffMember:
    """Invite someone to the practice by email with a role."""
    access.require(Capability.MANAGE_TEAM)
    _require_owner_for(access, body.role)
    if db.scalar(select(StaffMember.id).where(StaffMember.email == body.email)) is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Someone with this email already has an account"
        )
    _check_supervisor(access, body.supervisor_id, None)
    member = StaffMember(
        practice_id=access.practice_id,
        email=body.email,
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        status=StaffStatus.INVITED,
        role=body.role,
        clinician_access=body.clinician_access,
        is_clinician=_is_clinician_for(body.role, body.is_clinician),
        supervisor_id=body.supervisor_id,
        credentials=body.credentials,
        time_zone=access.staff.practice.time_zone,
    )
    db.add(member)
    db.flush()
    send_invitation(db, member, access.staff)
    audit_staff(db, request, access.staff, "team.invite", "staff", member.id, {"role": body.role})
    db.commit()
    return member


@router.post("/{staff_id}/invitation", response_model=Message)
def resend_invitation(
    staff_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Message:
    """Send a fresh invitation link (the previous one stops working)."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    if member.status != StaffStatus.INVITED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person has already joined")
    send_invitation(db, member, access.staff)
    audit_staff(db, request, access.staff, "team.invite_resent", "staff", member.id)
    db.commit()
    return Message(detail=f"Invitation sent to {member.email}")


@router.delete("/{staff_id}/invitation", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invitation(
    staff_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Withdraw an invitation that hasn't been accepted."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    if member.status != StaffStatus.INVITED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person has already joined")
    _require_owner_for(access, member.role)
    db.execute(
        delete(AuthToken).where(
            AuthToken.purpose == AuthTokenPurpose.STAFF_INVITE, AuthToken.subject_id == member.id
        )
    )
    audit_staff(
        db,
        request,
        access.staff,
        "team.invite_revoked",
        "staff",
        member.id,
        {"email": member.email},
    )
    db.delete(member)
    db.commit()


@router.patch("/{staff_id}", response_model=TeamMemberOut)
def update_member(
    staff_id: int, body: TeamMemberUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> StaffMember:
    """Change someone's role, access, supervisor or professional details."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    changes = body.model_dump(exclude_unset=True)
    role_fields = {"role", "clinician_access", "is_clinician"} & changes.keys()
    if role_fields and member.id == access.staff.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't change your own role")
    new_role = StaffRole(changes.get("role", member.role))
    _require_owner_for(access, member.role, new_role)
    if (
        member.role == StaffRole.OWNER
        and new_role != StaffRole.OWNER
        and member.status == StaffStatus.ACTIVE
        and active_owner_count(db, access.practice_id) <= 1
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The practice needs at least one owner")
    if "supervisor_id" in changes:
        _check_supervisor(access, changes["supervisor_id"], member.id)
    before: dict[str, object] = {
        "role": member.role,
        "clinician_access": member.clinician_access,
        "is_clinician": member.is_clinician,
    }
    for field, value in changes.items():
        setattr(member, field, value)
    member.is_clinician = _is_clinician_for(new_role, member.is_clinician)
    audit_staff(
        db, request, access.staff, "team.update", "staff", member.id, {"fields": sorted(changes)}
    )
    _record_role_change(access, member, before)
    db.commit()
    return member


@router.post("/{staff_id}/deactivate", response_model=TeamMemberOut)
def deactivate(
    staff_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> StaffMember:
    """Remove someone's access. Their records and history stay; reassign their clients."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    if member.id == access.staff.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't deactivate yourself")
    if member.status != StaffStatus.ACTIVE:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person isn't active")
    _require_owner_for(access, member.role)
    if member.role == StaffRole.OWNER and active_owner_count(db, access.practice_id) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The practice needs at least one owner")
    member.status = StaffStatus.DEACTIVATED
    sign_out_everywhere(db, member, sessions.REVOKED_DEACTIVATED)
    # Stop putting the practice's appointments in their own calendars.
    calendars = disconnect_staff(db, member.id, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "team.deactivate",
        "staff",
        member.id,
        {"calendars_disconnected": calendars} if calendars else None,
    )
    db.commit()
    return member


@router.delete("/{staff_id}/sessions", status_code=status.HTTP_204_NO_CONTENT)
def sign_member_out(staff_id: int, access: CurrentAccess, db: DbSession, request: Request) -> None:
    """Sign a team member out on every device (e.g. a lost laptop)."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    if member.id == access.staff.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Sign yourself out from Settings, then Security"
        )
    _require_owner_for(access, member.role)
    sign_out_everywhere(db, member, sessions.REVOKED_BY_ADMIN)
    audit_staff(db, request, access.staff, "team.sessions_revoked", "staff", member.id)
    db.commit()


@router.post("/{staff_id}/mfa/reset", response_model=TeamMemberOut)
def reset_member_mfa(
    staff_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> StaffMember:
    """Turn off a member's 2FA so they can set it up again (e.g. a lost phone). Owners only;
    the member is signed out everywhere and told by email."""
    if access.staff.role != StaffRole.OWNER:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only an owner can reset two-factor authentication"
        )
    member = _member(access, staff_id)
    if member.id == access.staff.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Turn off your own two-factor authentication from Settings, then Security",
        )
    if not member.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is already off")
    reset_mfa(db, member, reset_by_id=access.staff.id)
    audit_staff(db, request, access.staff, "team.mfa_reset", "staff", member.id)
    db.commit()
    return member


@router.post("/{staff_id}/reactivate", response_model=TeamMemberOut)
def reactivate(
    staff_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> StaffMember:
    """Restore a deactivated member's access."""
    access.require(Capability.MANAGE_TEAM)
    member = _member(access, staff_id)
    if member.status != StaffStatus.DEACTIVATED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person isn't deactivated")
    _require_owner_for(access, member.role)
    member.status = StaffStatus.ACTIVE
    audit_staff(db, request, access.staff, "team.reactivate", "staff", member.id)
    db.commit()
    return member


def _rates(db: DbSession, practice_id: int, staff_id: int) -> list[ClinicianServiceRate]:
    overrides = {
        row.service_id: row
        for row in db.scalars(select(ClinicianService).where(ClinicianService.staff_id == staff_id))
    }
    services = db.scalars(
        select(Service).where(Service.practice_id == practice_id).order_by(Service.code)
    )
    return [
        ClinicianServiceRate(
            service_id=service.id,
            offered=overrides[service.id].offered if service.id in overrides else True,
            rate_cents=overrides[service.id].rate_cents if service.id in overrides else None,
        )
        for service in services
    ]


@router.get("/{staff_id}/services", response_model=list[ClinicianServiceRate])
def get_clinician_services(staff_id: int, access: CurrentAccess) -> list[ClinicianServiceRate]:
    """Which services a clinician offers and their own rates (null = practice rate)."""
    member = _member(access, staff_id)
    if member.id != access.staff.id:
        access.require(Capability.MANAGE_PRACTICE)
    return _rates(access.db, access.practice_id, member.id)


@router.put("/{staff_id}/services", response_model=list[ClinicianServiceRate])
def set_clinician_services(
    staff_id: int,
    body: list[ClinicianServiceRate],
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> list[ClinicianServiceRate]:
    """Set which services a clinician offers and at what rates."""
    access.require(Capability.MANAGE_PRACTICE)
    member = _member(access, staff_id)
    if not member.is_clinician:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rates apply to clinicians only")
    service_ids = set(
        db.scalars(select(Service.id).where(Service.practice_id == access.practice_id))
    )
    if any(entry.service_id not in service_ids for entry in body):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown service")
    db.execute(delete(ClinicianService).where(ClinicianService.staff_id == member.id))
    for entry in body:
        if entry.offered and entry.rate_cents is None:
            continue
        db.add(
            ClinicianService(
                staff_id=member.id,
                service_id=entry.service_id,
                offered=entry.offered,
                rate_cents=entry.rate_cents,
            )
        )
    audit_staff(db, request, access.staff, "team.rates_update", "staff", member.id)
    db.commit()
    return _rates(db, access.practice_id, member.id)
