"""Team members, invitations, roles and clinician service rates."""

from datetime import datetime

from pydantic import Field

from synari.models.enums import ClinicianAccess, StaffRole
from synari.schemas.common import Email, PartialUpdate, Schema, ShortText
from synari.schemas.practice import NPI_PATTERN, TAXONOMY_PATTERN


class TeamMemberOut(Schema):
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
    claim_modifier: str
    accepting_new_clients: bool
    mfa_enabled: bool
    invited_at: datetime | None
    last_login_at: datetime | None


class InviteRequest(Schema):
    email: Email
    first_name: ShortText = Field(min_length=1)
    last_name: ShortText = Field(min_length=1)
    role: StaffRole
    clinician_access: ClinicianAccess = ClinicianAccess.BASIC
    # Owners and practice managers may also see clients; clinicians always do.
    is_clinician: bool = False
    supervisor_id: int | None = None
    credentials: str = Field(default="", max_length=100)


class TeamMemberUpdate(PartialUpdate):
    NULLABLE = frozenset({"supervisor_id"})

    first_name: ShortText | None = Field(default=None, min_length=1)
    last_name: ShortText | None = Field(default=None, min_length=1)
    role: StaffRole | None = None
    clinician_access: ClinicianAccess | None = None
    is_clinician: bool | None = None
    supervisor_id: int | None = None
    credentials: str | None = Field(default=None, max_length=100)
    license_number: str | None = Field(default=None, max_length=50)
    license_state: str | None = Field(default=None, max_length=50)
    npi: str | None = Field(default=None, pattern=NPI_PATTERN)
    taxonomy_code: str | None = Field(default=None, pattern=TAXONOMY_PATTERN)
    # Licensure modifier some payers require on this clinician's claim lines (e.g. HO, AJ).
    claim_modifier: str | None = Field(default=None, pattern=r"^([A-Z0-9]{2})?$")
    accepting_new_clients: bool | None = None


class ClinicianServiceRate(Schema):
    """Whether a clinician offers a service, and at what rate (null = the practice rate)."""

    service_id: int
    offered: bool = True
    rate_cents: int | None = Field(default=None, ge=0, le=10_000_000)
