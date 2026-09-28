"""Schemas for staff and client-portal authentication."""

from pydantic import Field

from synari.permissions import Capability
from synari.schemas.common import Email, Password, Schema, ShortText, TimeZone, TokenResponse


class PracticeOut(Schema):
    id: int
    name: str
    phone: str
    address_line1: str
    address_line2: str
    city: str
    state: str
    postal_code: str
    time_zone: str
    tax_id: str
    tax_id_type: str
    npi: str
    taxonomy_code: str
    billing_provider: str
    booking_slug: str | None


class StaffOut(Schema):
    """The signed-in staff member's own account."""

    id: int
    email: str
    first_name: str
    last_name: str
    display_name: str
    status: str
    role: str
    clinician_access: str
    is_clinician: bool
    supervisor_id: int | None
    credentials: str
    license_number: str
    license_state: str
    npi: str
    taxonomy_code: str
    phone: str
    time_zone: str
    accepting_new_clients: bool
    mfa_enabled: bool


class SessionOut(Schema):
    """Who is signed in, their practice, and what their role lets them do.

    `mfa_setup_required` means this is an enrollment-only session: two-factor authentication
    is required and must be set up before anything else works. `idle_timeout_minutes` is how
    long the session may sit idle before the server ends it.
    """

    staff: StaffOut
    practice: PracticeOut
    capabilities: list[Capability]
    mfa_setup_required: bool
    idle_timeout_minutes: int


class StaffAuthResponse(TokenResponse, SessionOut):
    pass


class RegisterRequest(Schema):
    email: Email
    password: Password
    first_name: ShortText = Field(min_length=1)
    last_name: ShortText = Field(min_length=1)
    practice_name: ShortText = ""
    time_zone: TimeZone = "America/New_York"
    # False for an owner who runs the practice but doesn't see clients.
    is_clinician: bool = True


class InvitationOut(Schema):
    email: str
    first_name: str
    last_name: str
    practice_name: str
    role: str


class AcceptInvitationRequest(Schema):
    token: str
    password: Password
    first_name: ShortText | None = Field(default=None, min_length=1)
    last_name: ShortText | None = Field(default=None, min_length=1)


class LoginRequest(Schema):
    email: Email
    password: str = Field(max_length=256)


class RefreshRequest(Schema):
    refresh_token: str


class MfaChallenge(Schema):
    """Returned by login instead of tokens when the account has two-factor authentication."""

    mfa_required: bool = True
    mfa_token: str


class MfaLoginRequest(Schema):
    mfa_token: str
    code: str = Field(min_length=6, max_length=20)


class MfaSetupOut(Schema):
    secret: str
    otpauth_uri: str


class MfaCodeRequest(Schema):
    code: str = Field(min_length=6, max_length=20)


class MfaPasswordRequest(Schema):
    password: str = Field(max_length=256)
    code: str = Field(default="", max_length=20)


class RecoveryCodesOut(Schema):
    recovery_codes: list[str]


class PasswordResetRequest(Schema):
    email: Email


class PasswordResetConfirm(Schema):
    token: str
    new_password: Password


class ChangePasswordRequest(Schema):
    current_password: str = Field(max_length=256)
    new_password: Password


class MagicLinkRequest(Schema):
    email: Email


class MagicLinkVerify(Schema):
    token: str


class PortalPermissions(Schema):
    messaging: bool
    booking: bool
    billing: bool


class ActingContact(Schema):
    """The contact (e.g. a minor's parent) signed in to the client's portal."""

    id: int
    name: str


class PortalClientOut(Schema):
    """The client whose portal is open; acting_contact is set when a contact signed in."""

    id: int
    first_name: str
    last_name: str
    preferred_name: str
    email: str | None
    clinician_name: str
    practice_name: str
    time_zone: str
    permissions: PortalPermissions
    acting_contact: ActingContact | None
    # How long the portal may sit idle before the server ends the session.
    idle_timeout_minutes: int


class PortalAuthResponse(TokenResponse):
    client: PortalClientOut
