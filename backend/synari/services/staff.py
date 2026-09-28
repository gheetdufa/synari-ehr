"""Staff accounts: the signed-in session payload and team invitations."""

from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import AuthToken, StaffMember
from synari.models.enums import AuthTokenPurpose, StaffRole, StaffStatus
from synari.permissions import capabilities_for
from synari.schemas.auth import PracticeOut, SessionOut, StaffOut
from synari.security import new_opaque_token
from synari.services.email_templates import render_email
from synari.services.outbox import queue_email
from synari.services.sessions import staff_idle_minutes
from synari.services.sign_in import needs_mfa_setup

INVITATION_TTL = timedelta(days=7)

ROLE_LABELS = {
    StaffRole.OWNER: "owner",
    StaffRole.CLINICIAN: "clinician",
    StaffRole.PRACTICE_MANAGER: "practice manager",
    StaffRole.BILLER: "biller",
    StaffRole.SCHEDULER: "scheduler",
}


def session_for(staff: StaffMember) -> SessionOut:
    """The signed-in staff member, their practice, capabilities and session rules."""
    return SessionOut(
        staff=StaffOut.model_validate(staff),
        practice=PracticeOut.model_validate(staff.practice),
        capabilities=sorted(capabilities_for(staff)),
        mfa_setup_required=needs_mfa_setup(staff),
        idle_timeout_minutes=staff_idle_minutes(staff),
    )


def active_owner_count(db: Session, practice_id: int) -> int:
    """How many active owners the practice has (it must always keep at least one)."""
    return (
        db.scalar(
            select(func.count())
            .select_from(StaffMember)
            .where(
                StaffMember.practice_id == practice_id,
                StaffMember.role == StaffRole.OWNER,
                StaffMember.status == StaffStatus.ACTIVE,
            )
        )
        or 0
    )


def send_invitation(db: Session, staff: StaffMember, inviter: StaffMember) -> None:
    """Email a single-use link to join the practice, replacing any earlier invitation link."""
    db.execute(
        delete(AuthToken).where(
            AuthToken.purpose == AuthTokenPurpose.STAFF_INVITE,
            AuthToken.subject_id == staff.id,
        )
    )
    raw, token_hash = new_opaque_token()
    db.add(
        AuthToken(
            purpose=AuthTokenPurpose.STAFF_INVITE,
            subject_id=staff.id,
            token_hash=token_hash,
            expires_at=utcnow() + INVITATION_TTL,
        )
    )
    staff.invited_at = utcnow()
    practice_name = staff.practice.name
    url = f"{settings.frontend_url.rstrip('/')}/join-practice?token={raw}"
    queue_email(
        db,
        to=staff.email,
        practice_id=staff.practice_id,
        content=render_email(
            subject=f"You're invited to join {practice_name} on Synari",
            heading=f"Join {practice_name}",
            paragraphs=[
                f"{inviter.full_name} invited you to join {practice_name} as a "
                f"{ROLE_LABELS[StaffRole(staff.role)]}.",
                "Choose a password to set up your account. This link expires in 7 days.",
            ],
            sender_name=practice_name,
            button_label="Accept invitation",
            button_url=url,
        ),
    )
