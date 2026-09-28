"""Staff registration, sign-in, invitations, sessions, passwords and two-factor authentication.

Sign-in creates a server-side session (synari/services/sessions.py): a short-lived access token
and an opaque refresh token that rotates on every use. Signing out ends this device's session;
"sign out everywhere" ends them all. Failed sign-ins are throttled per account and rate limited
per IP address and per email (synari/services/sign_in.py, synari/ratelimit.py).
"""

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select

from synari.audit import audit_staff
from synari.config import settings
from synari.db import utcnow
from synari.deps import (
    CurrentStaff,
    DbSession,
    EnrollingStaffSession,
    load_staff,
    load_staff_from_claims,
)
from synari.models import AuthToken, StaffMember
from synari.models.enums import AuthTokenPurpose, Role, SecuritySeverity, StaffStatus
from synari.ratelimit import enforce_limit, hit, rate_limit
from synari.schemas.auth import (
    AcceptInvitationRequest,
    ChangePasswordRequest,
    InvitationOut,
    LoginRequest,
    MfaChallenge,
    MfaCodeRequest,
    MfaLoginRequest,
    MfaPasswordRequest,
    MfaSetupOut,
    PasswordResetConfirm,
    PasswordResetRequest,
    RecoveryCodesOut,
    RefreshRequest,
    RegisterRequest,
    StaffAuthResponse,
)
from synari.schemas.common import Message, TokenResponse
from synari.security import (
    DUMMY_PASSWORD_HASH,
    create_token,
    decode_token,
    hash_opaque_token,
    hash_password,
    new_opaque_token,
    verify_password,
)
from synari.services import sessions
from synari.services.email_templates import render_email
from synari.services.mfa import (
    clear_mfa,
    generate_recovery_codes,
    new_secret,
    provisioning_uri,
    verify_second_factor,
    verify_totp,
)
from synari.services.onboarding import create_practice
from synari.services.outbox import queue_email
from synari.services.passwords import context_words, require_acceptable_password
from synari.services.security_events import MFA_DISABLED, record_security_event
from synari.services.sign_in import (
    LOGIN_FAILED,
    MFA_FAILED,
    clear_throttle,
    complete_sign_in,
    is_paused,
    record_failed_sign_in,
    sign_out_everywhere,
)
from synari.services.staff import session_for

router = APIRouter(prefix="/auth", tags=["auth"])

PASSWORD_RESET_TTL = timedelta(hours=1)
MFA_CHALLENGE_TTL = timedelta(minutes=5)
MFA_CHALLENGE_ATTEMPTS = 5

BAD_CREDENTIALS = "Incorrect email or password."
BAD_CODE = "That code isn't right."
CHALLENGE_EXPIRED = "Sign-in expired, please start again."
SESSION_EXPIRED = "Session expired, please sign in again"


def _mfa_challenge(staff: StaffMember) -> MfaChallenge:
    return MfaChallenge(
        mfa_token=create_token(
            subject_id=staff.id,
            role=Role.STAFF,
            token_type="mfa",
            version=staff.token_version,
            expires_in=MFA_CHALLENGE_TTL,
            extra={"jti": secrets.token_hex(16)},
        )
    )


def _auth_response(staff: StaffMember, tokens: sessions.IssuedTokens) -> StaffAuthResponse:
    return StaffAuthResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
        **session_for(staff).model_dump(),
    )


def _new_session_response(db: DbSession, staff: StaffMember, request: Request) -> StaffAuthResponse:
    return _auth_response(staff, sessions.start_staff_session(db, staff, request))


def _password_context(staff: StaffMember) -> list[str]:
    return context_words(staff.email, staff.first_name, staff.last_name, staff.practice.name)


def _set_password(staff: StaffMember, password: str) -> None:
    staff.password_hash = hash_password(password)
    staff.password_changed_at = utcnow()


@router.post(
    "/register",
    response_model=StaffAuthResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("register", limit=5))],
)
def register(body: RegisterRequest, db: DbSession, request: Request) -> StaffAuthResponse:
    """Create a practice with the registering person as its owner."""
    if not settings.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is disabled on this server")
    if db.scalar(select(StaffMember.id).where(StaffMember.email == body.email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    require_acceptable_password(
        body.password,
        context=context_words(body.email, body.first_name, body.last_name, body.practice_name),
    )
    owner = create_practice(
        db,
        practice_name=body.practice_name.strip(),
        time_zone=body.time_zone,
        owner_email=body.email,
        owner_password_hash=hash_password(body.password),
        owner_first_name=body.first_name.strip(),
        owner_last_name=body.last_name.strip(),
        owner_is_clinician=body.is_clinician,
    )
    owner.password_changed_at = owner.last_login_at = utcnow()
    audit_staff(db, request, owner, "account.register", "staff", owner.id)
    response = _new_session_response(db, owner, request)
    db.commit()
    return response


def _invitation_token(db: DbSession, raw: str, *, lock: bool = False) -> AuthToken:
    query = select(AuthToken).where(
        AuthToken.token_hash == hash_opaque_token(raw),
        AuthToken.purpose == AuthTokenPurpose.STAFF_INVITE,
    )
    token = db.scalar(query.with_for_update() if lock else query)
    if token is None or token.used_at is not None or token.expires_at < utcnow():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This invitation is invalid or has expired. Ask your practice to send a new one.",
        )
    return token


def _invited_staff(db: DbSession, token: AuthToken) -> StaffMember:
    staff = db.get(StaffMember, token.subject_id)
    if staff is None or staff.status != StaffStatus.INVITED:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This invitation is invalid or has expired. Ask your practice to send a new one.",
        )
    return staff


@router.get(
    "/invitations/{token}",
    response_model=InvitationOut,
    dependencies=[Depends(rate_limit("invitation", limit=20))],
)
def get_invitation(token: str, db: DbSession) -> InvitationOut:
    """Who an invitation is for, so the sign-up page can greet them."""
    staff = _invited_staff(db, _invitation_token(db, token))
    return InvitationOut(
        email=staff.email,
        first_name=staff.first_name,
        last_name=staff.last_name,
        practice_name=staff.practice.name,
        role=staff.role,
    )


@router.post(
    "/invitations/accept",
    response_model=StaffAuthResponse,
    dependencies=[Depends(rate_limit("invitation", limit=20))],
)
def accept_invitation(
    body: AcceptInvitationRequest, db: DbSession, request: Request
) -> StaffAuthResponse:
    """Join a practice: choose a password and start a session."""
    token = _invitation_token(db, body.token, lock=True)
    staff = _invited_staff(db, token)
    if body.first_name:
        staff.first_name = body.first_name.strip()
    if body.last_name:
        staff.last_name = body.last_name.strip()
    require_acceptable_password(body.password, context=_password_context(staff))
    token.used_at = utcnow()
    _set_password(staff, body.password)
    staff.status = StaffStatus.ACTIVE
    staff.last_login_at = utcnow()
    audit_staff(db, request, staff, "team.invitation_accepted", "staff", staff.id)
    response = _new_session_response(db, staff, request)
    db.commit()
    return response


@router.post(
    "/login",
    response_model=StaffAuthResponse | MfaChallenge,
    dependencies=[Depends(rate_limit("login", limit=10))],
)
def login(body: LoginRequest, db: DbSession, request: Request) -> StaffAuthResponse | MfaChallenge:
    """Sign in with email and password; accounts with 2FA get a challenge to complete.

    Wrong passwords, unknown emails, inactive accounts and paused sign-in all get the same
    answer.
    """
    enforce_limit("login-account", f"email:{body.email}", limit=10, window_seconds=300)
    staff = db.scalar(select(StaffMember).where(StaffMember.email == body.email))
    password_hash = staff.password_hash if staff and staff.password_hash else DUMMY_PASSWORD_HASH
    valid = verify_password(body.password, password_hash)
    if staff is None or not valid or not staff.is_active or is_paused(staff):
        record_failed_sign_in(db, request, staff, LOGIN_FAILED)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)
    if staff.mfa_enabled:
        return _mfa_challenge(staff)
    response = _auth_response(staff, complete_sign_in(db, request, staff, mfa=False))
    db.commit()
    return response


@router.post(
    "/login/mfa",
    response_model=StaffAuthResponse,
    dependencies=[Depends(rate_limit("login-mfa", limit=10))],
)
def login_second_factor(
    body: MfaLoginRequest, db: DbSession, request: Request
) -> StaffAuthResponse:
    """Finish signing in with an authenticator or recovery code (5 tries per challenge)."""
    claims = decode_token(body.mfa_token, "mfa")
    staff = load_staff_from_claims(db, claims) if claims else None
    if claims is None or staff is None or not staff.mfa_enabled or "jti" not in claims:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHALLENGE_EXPIRED)
    attempts = hit(
        "mfa-challenge",
        str(claims["jti"]),
        int(MFA_CHALLENGE_TTL.total_seconds()),
        window_start=datetime.fromtimestamp(int(claims["iat"]), UTC),
    )
    if attempts > MFA_CHALLENGE_ATTEMPTS:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHALLENGE_EXPIRED)
    if is_paused(staff) or not verify_second_factor(staff, body.code):
        record_failed_sign_in(db, request, staff, MFA_FAILED)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CODE)
    response = _auth_response(staff, complete_sign_in(db, request, staff, mfa=True))
    db.commit()
    return response


@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, db: DbSession, request: Request) -> TokenResponse:
    """Exchange a refresh token for new tokens. The refresh token rotates: the old one stops
    working, and presenting it again ends the session."""
    session = sessions.find_refresh_session(db, body.refresh_token, Role.STAFF)
    staff = load_staff(db, session.subject_id, session.token_version) if session else None
    if (
        session is None
        or staff is None
        or not sessions.is_live(session, sessions.staff_idle_minutes(staff))
    ):
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED)
    tokens = sessions.rotate(db, session, request)
    audit_staff(db, request, staff, "auth.refresh")
    db.commit()
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
    )


@router.post("/logout", response_model=Message)
def logout(current: EnrollingStaffSession, db: DbSession, request: Request) -> Message:
    """Sign out on this device."""
    sessions.revoke(current.session, sessions.REVOKED_SIGNED_OUT)
    audit_staff(db, request, current.staff, "auth.logout")
    db.commit()
    return Message(detail="Signed out")


@router.post("/logout-everywhere", response_model=Message)
def logout_everywhere(current: EnrollingStaffSession, db: DbSession, request: Request) -> Message:
    """Sign out on every device, including this one."""
    sign_out_everywhere(db, current.staff, sessions.REVOKED_EVERYWHERE)
    audit_staff(db, request, current.staff, "auth.logout_everywhere")
    db.commit()
    return Message(detail="Signed out everywhere")


@router.post(
    "/password-reset/request",
    response_model=Message,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(rate_limit("password-reset", limit=5))],
)
def request_password_reset(body: PasswordResetRequest, db: DbSession, request: Request) -> Message:
    """Email a reset link if the account exists. The response never reveals whether it does."""
    enforce_limit("password-reset-account", f"email:{body.email}", limit=5, window_seconds=3600)
    staff = db.scalar(select(StaffMember).where(StaffMember.email == body.email))
    if staff is not None and staff.is_active:
        raw, token_hash = new_opaque_token()
        db.add(
            AuthToken(
                purpose=AuthTokenPurpose.PASSWORD_RESET,
                subject_id=staff.id,
                token_hash=token_hash,
                expires_at=utcnow() + PASSWORD_RESET_TTL,
            )
        )
        url = f"{settings.frontend_url.rstrip('/')}/reset-password?token={raw}"
        queue_email(
            db,
            to=staff.email,
            practice_id=staff.practice_id,
            content=render_email(
                subject="Reset your Synari password",
                heading="Reset your password",
                paragraphs=[
                    "We received a request to reset your password. This link expires in one hour.",
                    "If you didn't ask for this, you can ignore this email.",
                ],
                sender_name="Synari",
                button_label="Choose a new password",
                button_url=url,
            ),
        )
        audit_staff(db, request, staff, "auth.password_reset_requested")
        db.commit()
    return Message(detail="If that email has an account, a reset link is on its way.")


@router.post(
    "/password-reset/confirm",
    response_model=StaffAuthResponse | MfaChallenge,
    dependencies=[Depends(rate_limit("password-reset-confirm", limit=10))],
)
def confirm_password_reset(
    body: PasswordResetConfirm, db: DbSession, request: Request
) -> StaffAuthResponse | MfaChallenge:
    """Set a new password with a reset token; signs out every session.

    Accounts with 2FA must still pass the second factor before getting a session.
    """
    token = db.scalar(
        select(AuthToken)
        .where(
            AuthToken.token_hash == hash_opaque_token(body.token),
            AuthToken.purpose == AuthTokenPurpose.PASSWORD_RESET,
        )
        .with_for_update()
    )
    if token is None or token.used_at is not None or token.expires_at < utcnow():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This reset link is invalid or has expired"
        )
    staff = db.get(StaffMember, token.subject_id)
    if staff is None or not staff.is_active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "This reset link is invalid or has expired"
        )
    require_acceptable_password(body.new_password, context=_password_context(staff))
    token.used_at = utcnow()
    _set_password(staff, body.new_password)
    clear_throttle(staff)
    sign_out_everywhere(db, staff, sessions.REVOKED_PASSWORD_CHANGED)
    audit_staff(db, request, staff, "auth.password_reset")
    if staff.mfa_enabled:
        challenge = _mfa_challenge(staff)
        db.commit()
        return challenge
    staff.last_login_at = utcnow()
    response = _new_session_response(db, staff, request)
    db.commit()
    return response


@router.post("/change-password", response_model=StaffAuthResponse)
def change_password(
    body: ChangePasswordRequest, staff: CurrentStaff, db: DbSession, request: Request
) -> StaffAuthResponse:
    """Change password; every session ends and this device gets a fresh one."""
    enforce_limit("change-password", f"staff:{staff.id}", limit=5, window_seconds=300)
    if not verify_password(body.current_password, staff.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    require_acceptable_password(body.new_password, context=_password_context(staff))
    _set_password(staff, body.new_password)
    sign_out_everywhere(db, staff, sessions.REVOKED_PASSWORD_CHANGED)
    audit_staff(db, request, staff, "auth.password_changed")
    response = _new_session_response(db, staff, request)
    db.commit()
    return response


@router.post("/mfa/setup", response_model=MfaSetupOut)
def start_mfa_setup(current: EnrollingStaffSession, db: DbSession, request: Request) -> MfaSetupOut:
    """The authenticator secret to set up; 2FA turns on once a code is confirmed.

    A secret not yet confirmed is reused (the row is locked), so a setup screen that asks twice,
    or is reopened, shows the same key whichever answer it keeps. Turning 2FA off or resetting
    it forgets the secret, so an unconfirmed one is never a key that was in use.
    """
    staff = db.scalars(
        select(StaffMember)
        .where(StaffMember.id == current.staff.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    if staff.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is already on")
    if staff.mfa_secret is None:
        staff.mfa_secret = new_secret()
        audit_staff(db, request, staff, "auth.mfa_setup_started")
    db.commit()
    return MfaSetupOut(
        secret=staff.mfa_secret,
        otpauth_uri=provisioning_uri(staff, staff.mfa_secret),
    )


@router.post("/mfa/enable", response_model=RecoveryCodesOut)
def enable_mfa(
    body: MfaCodeRequest, current: EnrollingStaffSession, db: DbSession, request: Request
) -> RecoveryCodesOut:
    """Confirm the authenticator app works and turn on 2FA. Recovery codes are shown once."""
    staff = current.staff
    if staff.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is already on")
    enforce_limit("mfa-enable", f"staff:{staff.id}", limit=10, window_seconds=300)
    step = verify_totp(staff.mfa_secret, body.code)
    if step is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_CODE)
    codes, hashes = generate_recovery_codes()
    staff.mfa_enabled = True
    staff.mfa_last_step = step
    staff.mfa_recovery_codes = hashes
    audit_staff(db, request, staff, "auth.mfa_enabled")
    db.commit()
    return RecoveryCodesOut(recovery_codes=codes)


def _confirm_identity(staff: StaffMember, body: MfaPasswordRequest) -> None:
    enforce_limit("mfa-confirm", f"staff:{staff.id}", limit=5, window_seconds=300)
    if not verify_password(body.password, staff.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is incorrect")
    if not verify_second_factor(staff, body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_CODE)


@router.post("/mfa/disable", response_model=Message)
def disable_mfa(
    body: MfaPasswordRequest, staff: CurrentStaff, db: DbSession, request: Request
) -> Message:
    """Turn off 2FA (needs the password and a current code or recovery code).

    Where the practice requires 2FA, the next request asks to set it up again (e.g. on a new
    phone).
    """
    if not staff.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is off")
    _confirm_identity(staff, body)
    clear_mfa(staff)
    audit_staff(db, request, staff, "auth.mfa_disabled")
    record_security_event(
        db,
        practice_id=staff.practice_id,
        kind=MFA_DISABLED,
        severity=SecuritySeverity.INFO,
        staff_id=staff.id,
    )
    db.commit()
    return Message(detail="Two-factor authentication is off")


@router.post("/mfa/recovery-codes", response_model=RecoveryCodesOut)
def regenerate_recovery_codes(
    body: MfaPasswordRequest, staff: CurrentStaff, db: DbSession, request: Request
) -> RecoveryCodesOut:
    """Replace all recovery codes (the old ones stop working)."""
    if not staff.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Two-factor authentication is off")
    _confirm_identity(staff, body)
    codes, hashes = generate_recovery_codes()
    staff.mfa_recovery_codes = hashes
    audit_staff(db, request, staff, "auth.mfa_recovery_codes_regenerated")
    db.commit()
    return RecoveryCodesOut(recovery_codes=codes)
