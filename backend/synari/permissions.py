"""What each staff role can do. The single source of truth for staff authorization.

Roles follow SimplePractice's model:

- **Owner**: everything, including the team and practice settings.
- **Clinician**: their own clients' charts, plus more depending on `clinician_access`:
  - basic: nothing more.
  - billing: their own clients' billing.
  - client_list: sees and schedules every client, but opens only their own charts.
  - practice: everything except managing the team.
- **Practice manager**: team, settings, every calendar and all billing; never clinical records.
- **Biller**: all billing, insurance and reports; client profiles but not clinical records.
- **Scheduler**: every calendar and client profile; no clinical records or billing.

Clinical access to a client's chart also comes from being on the client's care team, or from
supervising a clinician who is (see `synari/access.py`).
"""

from enum import StrEnum
from typing import Protocol

from synari.models.enums import ClinicianAccess, StaffRole


class Capability(StrEnum):
    MANAGE_TEAM = "manage_team"
    MANAGE_PRACTICE = "manage_practice"
    VIEW_ALL_CLIENTS = "view_all_clients"
    CLINICAL_ALL = "clinical_all"
    SCHEDULE_ALL = "schedule_all"
    BILLING_OWN = "billing_own"
    BILLING_ALL = "billing_all"
    VIEW_REPORTS = "view_reports"
    VIEW_AUDIT_LOG = "view_audit_log"


ALL_CAPABILITIES = frozenset(Capability)

ROLE_CAPABILITIES: dict[StaffRole, frozenset[Capability]] = {
    StaffRole.OWNER: ALL_CAPABILITIES,
    StaffRole.PRACTICE_MANAGER: frozenset(
        {
            Capability.MANAGE_TEAM,
            Capability.MANAGE_PRACTICE,
            Capability.VIEW_ALL_CLIENTS,
            Capability.SCHEDULE_ALL,
            Capability.BILLING_ALL,
            Capability.VIEW_REPORTS,
            Capability.VIEW_AUDIT_LOG,
        }
    ),
    StaffRole.BILLER: frozenset(
        {Capability.VIEW_ALL_CLIENTS, Capability.BILLING_ALL, Capability.VIEW_REPORTS}
    ),
    StaffRole.SCHEDULER: frozenset({Capability.VIEW_ALL_CLIENTS, Capability.SCHEDULE_ALL}),
}

CLINICIAN_CAPABILITIES: dict[ClinicianAccess, frozenset[Capability]] = {
    ClinicianAccess.BASIC: frozenset(),
    ClinicianAccess.BILLING: frozenset({Capability.BILLING_OWN}),
    ClinicianAccess.CLIENT_LIST: frozenset({Capability.VIEW_ALL_CLIENTS, Capability.BILLING_OWN}),
    ClinicianAccess.PRACTICE: ALL_CAPABILITIES - {Capability.MANAGE_TEAM},
}

# Roles that may also see clients as a clinician (a clinician-owner, a clinician-manager).
ROLES_THAT_CAN_BE_CLINICIANS = frozenset(
    {StaffRole.OWNER, StaffRole.CLINICIAN, StaffRole.PRACTICE_MANAGER}
)


class HasRole(Protocol):
    role: str
    clinician_access: str


def capabilities_for(staff: HasRole) -> frozenset[Capability]:
    """The capabilities a staff member's role grants."""
    if staff.role == StaffRole.CLINICIAN:
        return CLINICIAN_CAPABILITIES[ClinicianAccess(staff.clinician_access)]
    return ROLE_CAPABILITIES[StaffRole(staff.role)]
