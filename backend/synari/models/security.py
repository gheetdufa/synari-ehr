"""Security infrastructure: server-side sessions, shared rate limits, security events, emergency
("break-glass") access and audit-chain checkpoints."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from synari.crypto import EncryptedText
from synari.db import Base
from synari.models.enums import SecuritySeverity


class AuthSession(Base):
    """One signed-in device. Access tokens name the session; refresh tokens rotate on every use.

    A session ends when it's revoked, idle past the practice's limit, or past its absolute
    lifetime. Reusing an already-rotated refresh token revokes every session in its family.
    """

    __tablename__ = "auth_sessions"
    __table_args__ = (Index("ix_auth_sessions_subject", "subject_role", "subject_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    subject_role: Mapped[str] = mapped_column(String(20))  # staff | client
    subject_id: Mapped[int]
    # Set when a client's contact (e.g. a parent) signed in to the client's portal.
    contact_id: Mapped[int | None]
    # The sign-in this session descends from; every refresh token rotated from it belongs to
    # the family, and reusing any rotated one revokes the whole family.
    family_id: Mapped[str] = mapped_column(String(32), index=True)
    # The account's token version at sign-in (staff token_version, or the client's or
    # contact's portal_token_version); bumping it ends the session.
    token_version: Mapped[int] = mapped_column(default=0)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # The hash the refresh token had before its last rotation, to detect reuse.
    previous_refresh_token_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    # When the refresh token last rotated (a concurrent refresh from another tab within a few
    # seconds is refused without being treated as theft).
    rotated_at: Mapped[datetime | None]
    ip_address: Mapped[str] = mapped_column(String(45), default="")
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    revoked_reason: Mapped[str] = mapped_column(String(50), default="")


class RateLimitBucket(Base):
    """Hits per key in a fixed window, shared by every API process."""

    __tablename__ = "rate_limit_buckets"

    bucket: Mapped[str] = mapped_column(String(50), primary_key=True)
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(primary_key=True)
    hits: Mapped[int] = mapped_column(default=0)


class SecurityEvent(Base):
    """Something an owner should know about: lockouts, MFA changes, token reuse, emergency
    access, exports, audit verification failures, stale backups."""

    __tablename__ = "security_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Null for server-wide events (backups, audit verification).
    practice_id: Mapped[int | None] = mapped_column(ForeignKey("practices.id"), index=True)
    kind: Mapped[str] = mapped_column(String(50))
    severity: Mapped[str] = mapped_column(String(20), default=SecuritySeverity.INFO)
    staff_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    # Ids and counts only: never clinical content.
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    acknowledged_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    acknowledged_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)


class EmergencyAccessGrant(Base):
    """Temporary clinical access to a client outside one's care team, with a stated reason.

    Every grant notifies the client's primary clinician and the owners and waits in their
    review queue.
    """

    __tablename__ = "emergency_access_grants"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    reason: Mapped[str] = mapped_column(EncryptedText("emergency_access_grants.reason"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    reviewed_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    reviewed_at: Mapped[datetime | None]
    review_note: Mapped[str] = mapped_column(Text, default="")


class AuditCheckpoint(Base):
    """A periodic record of a practice's audit-chain head, for verification and export."""

    __tablename__ = "audit_checkpoints"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int | None] = mapped_column(ForeignKey("practices.id"), index=True)
    last_event_id: Mapped[int]
    head_hash: Mapped[str] = mapped_column(String(64))
    event_count: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
