"""The signed-in staff member: session, own professional profile and personal preferences."""

from fastapi import APIRouter, Request

from synari.audit import audit_staff
from synari.deps import CurrentStaff, DbSession, EnrollingStaffSession
from synari.models import StaffMember
from synari.schemas.auth import SessionOut
from synari.schemas.practice import PreferencesOut, PreferencesUpdate, ProfileUpdate
from synari.services.staff import session_for

router = APIRouter(prefix="/me", tags=["me"])


@router.get("", response_model=SessionOut)
def get_session(current: EnrollingStaffSession) -> SessionOut:
    """Who is signed in, their practice and what their role allows (also answers during an
    enrollment-only session, whose `mfa_setup_required` is true)."""
    return session_for(current.staff)


@router.patch("", response_model=SessionOut)
def update_profile(
    body: ProfileUpdate, staff: CurrentStaff, db: DbSession, request: Request
) -> SessionOut:
    """Update your own name, credentials, license, NPI, time zone and availability for new
    clients."""
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(staff, field, value)
    audit_staff(db, request, staff, "account.profile_update", detail={"fields": sorted(changes)})
    db.commit()
    return session_for(staff)


@router.get("/preferences", response_model=PreferencesOut)
def get_preferences(staff: CurrentStaff) -> StaffMember:
    return staff


@router.patch("/preferences", response_model=PreferencesOut)
def update_preferences(
    body: PreferencesUpdate, staff: CurrentStaff, db: DbSession, request: Request
) -> StaffMember:
    """Update your away message, note defaults, AI writing style and email notifications."""
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(staff, field, value)
    audit_staff(
        db, request, staff, "account.preferences_update", detail={"fields": sorted(changes)}
    )
    db.commit()
    return staff
