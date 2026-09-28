"""Schemas for sessions, practice security settings, security events and emergency access."""

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from synari.models.enums import SecuritySeverity
from synari.schemas.common import PartialUpdate, Schema
from synari.services.sessions import MAX_IDLE_MINUTES, MIN_IDLE_MINUTES


class AuthSessionOut(Schema):
    """A device signed in to your account."""

    id: str
    device: str
    user_agent: str
    ip_address: str
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    current: bool


class PracticeSecurityOut(Schema):
    """The practice's sign-in rules and how many people use two-factor authentication.

    `mfa_server_policy` is set when the server's REQUIRE_STAFF_MFA overrides the practice
    setting ("required" or "off"); `mfa_required` is the rule actually in force.
    """

    require_staff_mfa: bool
    mfa_server_policy: Literal["required", "off"] | None
    mfa_required: bool
    session_idle_minutes: int
    staff_mfa_enabled: int
    staff_active: int


class PracticeSecurityUpdate(PartialUpdate):
    require_staff_mfa: bool | None = None
    session_idle_minutes: int | None = Field(default=None, ge=MIN_IDLE_MINUTES, le=MAX_IDLE_MINUTES)


class SecurityEventOut(Schema):
    id: int
    kind: str
    label: str
    severity: SecuritySeverity
    staff_id: int | None
    staff_name: str
    # Ids and counts only.
    detail: dict[str, Any] | None
    created_at: datetime
    acknowledged_at: datetime | None
    acknowledged_by_name: str


class EmergencyAccessRequest(Schema):
    """Why you need a chart you normally can't open (kept with the grant for review)."""

    reason: str = Field(min_length=20, max_length=1000)


class EmergencyGrantOut(Schema):
    """Your emergency access to one client's chart."""

    id: int
    client_id: int
    created_at: datetime
    expires_at: datetime


class EmergencyGrantReviewOut(Schema):
    """An emergency access grant in the owners' review queue."""

    id: int
    staff_id: int
    staff_name: str
    client_id: int
    client_name: str
    reason: str
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    reviewed_at: datetime | None
    reviewed_by_name: str
    review_note: str
    active: bool


class EmergencyReviewRequest(Schema):
    note: str = Field(default="", max_length=1000)
