"""Server-side sign-in sessions for staff and client-portal users (clients and their contacts).

Each sign-in creates an `AuthSession`. Access tokens are short-lived JWTs that name the session
(`sid`); every request checks the session is still live:

- not revoked (sign-out, "sign out everywhere", a revoked device, refresh-token reuse),
- not idle longer than the limit (staff: the practice's session_idle_minutes, 5-60; portal:
  PORTAL_IDLE_MINUTES),
- not past its absolute lifetime (staff: STAFF_SESSION_HOURS; portal: PORTAL_SESSION_DAYS),
- issued under the account's current token version.

Refresh tokens are opaque random strings; only their SHA-256 hashes are stored. Each refresh
rotates the token. Presenting a token that was already rotated means it was copied, so the whole
family is revoked and a security event is recorded, unless it comes within a few seconds of
the rotation (two tabs refreshing at once), which is refused without revoking anything.
"""

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import Request
from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from synari.config import settings
from synari.db import engine, utcnow
from synari.models import AuthSession, Client, StaffMember
from synari.models.enums import Role, SecuritySeverity
from synari.security import create_token, hash_opaque_token, new_opaque_token
from synari.services.security_events import REFRESH_TOKEN_REUSE, record_security_event

MIN_IDLE_MINUTES = 5
MAX_IDLE_MINUTES = 60
# last_seen_at is written at most this often per session.
TOUCH_INTERVAL = timedelta(minutes=1)
# A rotated refresh token presented this soon after rotation is a race between tabs, not theft.
REUSE_GRACE = timedelta(seconds=30)
# How far back a device (IP address or browser) counts as known for new-device alerts.
KNOWN_DEVICE_WINDOW = timedelta(days=90)
# Ended sessions are kept this long (for review and reuse detection), then purged.
SESSION_RETENTION = timedelta(days=30)

# Why a session ended (AuthSession.revoked_reason).
REVOKED_SIGNED_OUT = "signed_out"
REVOKED_EVERYWHERE = "signed_out_everywhere"
REVOKED_BY_USER = "revoked_by_user"
REVOKED_BY_ADMIN = "revoked_by_admin"
REVOKED_REUSE = "refresh_token_reuse"
REVOKED_PASSWORD_CHANGED = "password_changed"
REVOKED_MFA_RESET = "mfa_reset"
REVOKED_DEACTIVATED = "deactivated"


@dataclass(frozen=True)
class IssuedTokens:
    """Tokens for a session: a short-lived access JWT and an opaque, rotating refresh token."""

    access_token: str
    refresh_token: str
    expires_in: int
    session_id: str


def clamp_idle_minutes(minutes: int) -> int:
    """Keep an idle limit within 5-60 minutes."""
    return max(MIN_IDLE_MINUTES, min(MAX_IDLE_MINUTES, minutes))


def staff_idle_minutes(staff: StaffMember) -> int:
    """How long a staff member's sessions may sit idle (their practice's setting)."""
    return clamp_idle_minutes(staff.practice.settings.session_idle_minutes)


def portal_idle_minutes() -> int:
    """How long client-portal sessions may sit idle."""
    return clamp_idle_minutes(settings.portal_idle_minutes)


def _request_origin(request: Request | None) -> tuple[str, str]:
    if request is None:
        return "", ""
    ip = request.client.host if request.client else ""
    return ip[:45], request.headers.get("user-agent", "")[:300]


def _access_token(session: AuthSession) -> str:
    extra: dict[str, str | int] = {"sid": session.id}
    if session.contact_id is not None:
        extra["contact"] = session.contact_id
    return create_token(
        subject_id=session.subject_id,
        role=session.subject_role,
        token_type="access",
        version=session.token_version,
        expires_in=timedelta(minutes=settings.access_token_minutes),
        extra=extra,
    )


def _issued(session: AuthSession, refresh_token: str) -> IssuedTokens:
    return IssuedTokens(
        access_token=_access_token(session),
        refresh_token=refresh_token,
        expires_in=settings.access_token_minutes * 60,
        session_id=session.id,
    )


def start_session(
    db: Session,
    *,
    role: Role,
    subject_id: int,
    token_version: int,
    lifetime: timedelta,
    request: Request | None,
    contact_id: int | None = None,
) -> IssuedTokens:
    """Create a session and its first tokens (caller commits)."""
    now = utcnow()
    raw, token_hash = new_opaque_token()
    session_id = secrets.token_hex(16)
    ip, user_agent = _request_origin(request)
    session = AuthSession(
        id=session_id,
        family_id=session_id,
        subject_role=role,
        subject_id=subject_id,
        contact_id=contact_id,
        token_version=token_version,
        refresh_token_hash=token_hash,
        ip_address=ip,
        user_agent=user_agent,
        created_at=now,
        last_seen_at=now,
        expires_at=now + lifetime,
    )
    db.add(session)
    db.flush()
    return _issued(session, raw)


def start_staff_session(db: Session, staff: StaffMember, request: Request | None) -> IssuedTokens:
    """Sign a staff member in on this device (caller commits)."""
    return start_session(
        db,
        role=Role.STAFF,
        subject_id=staff.id,
        token_version=staff.token_version,
        lifetime=timedelta(hours=settings.staff_session_hours),
        request=request,
    )


def start_portal_session(
    db: Session, client: Client, contact_id: int | None, version: int, request: Request | None
) -> IssuedTokens:
    """Sign a client, or one of their contacts, in to the client's portal (caller commits)."""
    return start_session(
        db,
        role=Role.CLIENT,
        subject_id=client.id,
        contact_id=contact_id,
        token_version=version,
        lifetime=timedelta(days=settings.portal_session_days),
        request=request,
    )


def is_live(session: AuthSession, idle_minutes: int, now: datetime | None = None) -> bool:
    """Whether a session is unrevoked, not idle past the limit and not past its lifetime."""
    now = now or utcnow()
    return (
        session.revoked_at is None
        and now < session.expires_at
        and now - session.last_seen_at <= timedelta(minutes=idle_minutes)
    )


def _touch(session: AuthSession, now: datetime) -> None:
    # Written in its own transaction so read-only requests count as activity too.
    with engine.begin() as connection:
        connection.execute(
            update(AuthSession).where(AuthSession.id == session.id).values(last_seen_at=now)
        )
    set_committed_value(session, "last_seen_at", now)


def live_session_for_claims(
    db: Session,
    claims: dict[str, object],
    *,
    role: Role,
    idle_minutes: int,
    touch: bool = True,
) -> AuthSession | None:
    """The live session an access token names, recording activity at most once a minute."""
    session_id = claims.get("sid")
    if not isinstance(session_id, str):
        return None
    session = db.get(AuthSession, session_id)
    if (
        session is None
        or session.subject_role != role
        or str(session.subject_id) != claims.get("sub")
        or session.contact_id != claims.get("contact")
        or session.token_version != claims.get("ver")
    ):
        return None
    now = utcnow()
    if not is_live(session, idle_minutes, now):
        return None
    if touch and now - session.last_seen_at >= TOUCH_INTERVAL:
        _touch(session, now)
    return session


def _practice_of(db: Session, session: AuthSession) -> int | None:
    model = StaffMember if session.subject_role == Role.STAFF else Client
    subject = db.get(model, session.subject_id)
    return subject.practice_id if subject is not None else None


def revoke_family(db: Session, family_id: str, reason: str) -> None:
    """End every live session of a sign-in family (caller commits)."""
    db.execute(
        update(AuthSession)
        .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
        .execution_options(synchronize_session="fetch")
    )


def find_refresh_session(db: Session, refresh_token: str, role: Role) -> AuthSession | None:
    """The session a refresh token currently belongs to, locked for rotation.

    A token that was already rotated away is reuse: outside the grace period the family is
    revoked and a security event recorded. Returns None for reuse and unknown tokens; the
    caller commits (so a revocation sticks) and rejects the request.
    """
    token_hash = hash_opaque_token(refresh_token)
    session = db.scalar(
        select(AuthSession)
        .where(AuthSession.refresh_token_hash == token_hash, AuthSession.subject_role == role)
        .with_for_update()
    )
    if session is not None:
        return session
    rotated = db.scalar(
        select(AuthSession)
        .where(
            AuthSession.previous_refresh_token_hash == token_hash,
            AuthSession.subject_role == role,
        )
        .with_for_update()
    )
    if rotated is None or rotated.revoked_at is not None:
        return None
    if rotated.rotated_at is not None and utcnow() - rotated.rotated_at <= REUSE_GRACE:
        return None
    revoke_family(db, rotated.family_id, REVOKED_REUSE)
    record_security_event(
        db,
        practice_id=_practice_of(db, rotated),
        kind=REFRESH_TOKEN_REUSE,
        severity=SecuritySeverity.WARNING,
        staff_id=rotated.subject_id if rotated.subject_role == Role.STAFF else None,
        detail={
            "session_id": rotated.id,
            "role": rotated.subject_role,
            "subject_id": rotated.subject_id,
            "contact_id": rotated.contact_id,
        },
    )
    return None


def rotate(db: Session, session: AuthSession, request: Request | None) -> IssuedTokens:
    """Issue a new refresh token (the old one stops working) and access token (caller commits)."""
    now = utcnow()
    raw, token_hash = new_opaque_token()
    session.previous_refresh_token_hash = session.refresh_token_hash
    session.refresh_token_hash = token_hash
    session.rotated_at = now
    session.last_seen_at = now
    ip, user_agent = _request_origin(request)
    if ip:
        session.ip_address = ip
    if user_agent:
        session.user_agent = user_agent
    return _issued(session, raw)


def revoke(session: AuthSession, reason: str) -> None:
    """End one session (caller commits)."""
    if session.revoked_at is None:
        session.revoked_at = utcnow()
        session.revoked_reason = reason


def revoke_all(
    db: Session, role: Role, subject_id: int, reason: str, *, contact_id: int | None = None
) -> None:
    """End every session of an account (for the portal: the client's own, or one contact's)."""
    db.execute(
        update(AuthSession)
        .where(
            AuthSession.subject_role == role,
            AuthSession.subject_id == subject_id,
            AuthSession.contact_id.is_(None)
            if contact_id is None
            else AuthSession.contact_id == contact_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow(), revoked_reason=reason)
        .execution_options(synchronize_session="fetch")
    )


def live_sessions(
    db: Session, role: Role, subject_id: int, idle_minutes: int, *, contact_id: int | None = None
) -> list[AuthSession]:
    """An account's live sessions, most recently active first."""
    now = utcnow()
    return list(
        db.scalars(
            select(AuthSession)
            .where(
                AuthSession.subject_role == role,
                AuthSession.subject_id == subject_id,
                AuthSession.contact_id.is_(None)
                if contact_id is None
                else AuthSession.contact_id == contact_id,
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.last_seen_at >= now - timedelta(minutes=idle_minutes),
            )
            .order_by(AuthSession.last_seen_at.desc())
        )
    )


def is_new_device(db: Session, staff: StaffMember, request: Request | None) -> bool:
    """Whether a staff sign-in comes from an IP address and a browser this account hasn't used
    in the last 90 days (the very first sign-in doesn't count)."""
    ip, user_agent = _request_origin(request)
    recent = (
        select(AuthSession.id)
        .where(
            AuthSession.subject_role == Role.STAFF,
            AuthSession.subject_id == staff.id,
            AuthSession.created_at >= utcnow() - KNOWN_DEVICE_WINDOW,
        )
        .limit(1)
    )
    if db.scalar(recent) is None:
        return False
    known = recent.where(or_(AuthSession.ip_address == ip, AuthSession.user_agent == user_agent))
    return db.scalar(known) is None


_BROWSERS = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Firefox/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
)
_SYSTEMS = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("Windows", "Windows"),
    ("Mac OS X", "macOS"),
    ("CrOS", "ChromeOS"),
    ("Linux", "Linux"),
)


def describe_device(user_agent: str) -> str:
    """A short, friendly device name from a user agent, e.g. 'Chrome on macOS'."""
    browser = next((name for marker, name in _BROWSERS if marker in user_agent), "")
    system = next((name for marker, name in _SYSTEMS if marker in user_agent), "")
    if browser and system:
        return f"{browser} on {system}"
    return browser or system or "Unknown device"


def purge_ended_sessions(db: Session, now: datetime) -> None:
    """Worker job: delete sessions that ended more than 30 days ago."""
    cutoff = now - SESSION_RETENTION
    db.execute(
        delete(AuthSession).where(
            or_(AuthSession.expires_at < cutoff, AuthSession.revoked_at < cutoff)
        )
    )
    db.commit()
