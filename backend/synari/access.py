"""Per-request authorization for staff: which clients, records and calendars they can reach.

Every staff route gets an `Access` (via `CurrentAccess` in deps.py) and loads rows through it:

- `access.get(Model, id)` for practice-owned rows (services, templates, invoices...).
- `access.client(client_id, level)` for a client at a given level of access.
- `access.client_record(Model, id, level)` for rows that belong to a client (notes, invoices...).
- `access.client_filter(level)` to restrict list queries to the clients this person may see.

Anything outside the practice, or a client the person can't reach, is a 404 so its existence
is never revealed. Missing role permissions are a 403.

Clinicians may also hold a temporary emergency ("break-glass") grant to one client's chart
(`EmergencyAccessGrant`, see synari/services/emergency_access.py); it opens the chart at the
PROFILE and CLINICAL levels, never BILLING, until it expires or an owner revokes it.
"""

from enum import StrEnum
from functools import cached_property
from typing import Any, Protocol

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, false, or_, select
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Client, ClientClinician, EmergencyAccessGrant, StaffMember
from synari.models.enums import StaffStatus
from synari.permissions import Capability, capabilities_for


class ClientAccess(StrEnum):
    """What part of a client's record an action needs."""

    # Name, contact details, appointments and the status of shared forms.
    PROFILE = "profile"
    # Notes, diagnoses, documents, messages, form answers and recordings.
    CLINICAL = "clinical"
    # Invoices, payments, cards, insurance and claims (including the diagnoses on claims).
    BILLING = "billing"


# Levels an emergency grant opens.
EMERGENCY_LEVELS = frozenset({ClientAccess.PROFILE, ClientAccess.CLINICAL})
_EMERGENCY_CACHE_KEY = "emergency_client_ids"


def active_emergency_client_ids(db: Session, staff: StaffMember) -> frozenset[int]:
    """Clients a clinician currently reaches through an unexpired, unrevoked emergency grant.

    Cached on the database session for the rest of the request; creating or revoking a grant
    clears the cache (`forget_emergency_grants`).
    """
    if not staff.is_clinician:
        return frozenset()
    cache: dict[int, frozenset[int]] = db.info.setdefault(_EMERGENCY_CACHE_KEY, {})
    if staff.id not in cache:
        cache[staff.id] = frozenset(
            db.scalars(
                select(EmergencyAccessGrant.client_id).where(
                    EmergencyAccessGrant.staff_id == staff.id,
                    EmergencyAccessGrant.practice_id == staff.practice_id,
                    EmergencyAccessGrant.revoked_at.is_(None),
                    EmergencyAccessGrant.expires_at > utcnow(),
                )
            )
        )
    return cache[staff.id]


def forget_emergency_grants(db: Session) -> None:
    """Drop cached emergency grants after one is created or revoked."""
    db.info.pop(_EMERGENCY_CACHE_KEY, None)


class PracticeOwned(Protocol):
    id: Any
    practice_id: Any


class ClientOwned(PracticeOwned, Protocol):
    client_id: Any


def _not_found(label: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")


class Access:
    """What the signed-in staff member may do, bound to the request's database session."""

    def __init__(self, db: Session, staff: StaffMember) -> None:
        self.db = db
        self.staff = staff
        self.capabilities = capabilities_for(staff)

    @property
    def practice_id(self) -> int:
        return self.staff.practice_id

    def can(self, capability: Capability) -> bool:
        return capability in self.capabilities

    def require(self, capability: Capability, detail: str = "Your role doesn't allow this") -> None:
        """Raise 403 unless the role grants `capability`."""
        if not self.can(capability):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail)

    @cached_property
    def supervisee_ids(self) -> list[int]:
        """Active clinicians this person supervises."""
        return list(
            self.db.scalars(
                select(StaffMember.id).where(
                    StaffMember.supervisor_id == self.staff.id,
                    StaffMember.status == StaffStatus.ACTIVE,
                )
            )
        )

    def _care_team_staff_ids(self, level: ClientAccess) -> list[int] | None:
        """Staff whose care-team membership grants access at `level`; None means every client."""
        if level == ClientAccess.PROFILE:
            if self.can(Capability.VIEW_ALL_CLIENTS):
                return None
            return [self.staff.id, *self.supervisee_ids]
        if level == ClientAccess.CLINICAL:
            if self.can(Capability.CLINICAL_ALL):
                return None
            own = [self.staff.id] if self.staff.is_clinician else []
            return [*own, *self.supervisee_ids]
        if self.can(Capability.BILLING_ALL):
            return None
        return [self.staff.id] if self.can(Capability.BILLING_OWN) else []

    def _emergency_client_ids(self, level: ClientAccess) -> frozenset[int]:
        if level not in EMERGENCY_LEVELS:
            return frozenset()
        return active_emergency_client_ids(self.db, self.staff)

    def client_filter(self, level: ClientAccess = ClientAccess.PROFILE) -> ColumnElement[bool]:
        """SQL condition on `Client` for the clients this person may reach at `level`."""
        in_practice = Client.practice_id == self.practice_id
        staff_ids = self._care_team_staff_ids(level)
        if staff_ids is None:
            return in_practice
        reachable: list[ColumnElement[bool]] = []
        if staff_ids:
            on_team = select(ClientClinician.client_id).where(
                ClientClinician.staff_id.in_(staff_ids)
            )
            reachable.append(Client.id.in_(on_team))
        emergency = self._emergency_client_ids(level)
        if emergency:
            reachable.append(Client.id.in_(emergency))
        if not reachable:
            return false()
        return in_practice & or_(*reachable)

    def can_access_client(self, client: Client, level: ClientAccess = ClientAccess.PROFILE) -> bool:
        """Whether this person may reach `client` at `level`."""
        if client.practice_id != self.practice_id:
            return False
        if self._reaches_by_role(client, level):
            return True
        return client.id in self._emergency_client_ids(level)

    def only_by_emergency(
        self, client: Client, level: ClientAccess = ClientAccess.CLINICAL
    ) -> bool:
        """Whether this person reaches `client` at `level` only through emergency access (for
        what break-glass access doesn't cover, like exporting the record)."""
        if client.practice_id != self.practice_id or self._reaches_by_role(client, level):
            return False
        return client.id in self._emergency_client_ids(level)

    def _reaches_by_role(self, client: Client, level: ClientAccess) -> bool:
        staff_ids = self._care_team_staff_ids(level)
        return staff_ids is None or any(member.staff_id in staff_ids for member in client.care_team)

    def client(
        self, client_id: int, level: ClientAccess = ClientAccess.PROFILE, *, label: str = "Client"
    ) -> Client:
        """Load a client this person may reach at `level`; 404 otherwise."""
        client = self.db.get(Client, client_id)
        if client is None or not self.can_access_client(client, level):
            raise _not_found(label)
        return client

    def get[T: PracticeOwned](self, model: type[T], object_id: int, *, label: str = "Record") -> T:
        """Load a row that belongs to this practice; 404 otherwise."""
        row = self.db.get(model, object_id)
        if row is None or row.practice_id != self.practice_id:
            raise _not_found(label)
        return row

    def client_record[T: ClientOwned](
        self,
        model: type[T],
        object_id: int,
        level: ClientAccess,
        *,
        label: str = "Record",
    ) -> T:
        """Load a client's row (note, invoice, form...) when the client is reachable at `level`."""
        row = self.get(model, object_id, label=label)
        client = self.db.get(Client, row.client_id)
        if client is None or not self.can_access_client(client, level):
            raise _not_found(label)
        return row

    def can_manage_care_team(self, client: Client) -> bool:
        """Whether this person may change who is on a client's care team (and so who can open
        the chart): the client's primary clinician, or staff who schedule for or manage the
        practice. Booking a session never widens chart access on its own."""
        if self.can(Capability.SCHEDULE_ALL) or self.can(Capability.MANAGE_PRACTICE):
            return True
        primary = client.primary_clinician
        return primary is not None and primary.id == self.staff.id

    def can_manage_calendar(self, clinician_id: int) -> bool:
        """Whether this person may book, change or cancel on `clinician_id`'s calendar."""
        return clinician_id == self.staff.id or self.can(Capability.SCHEDULE_ALL)

    def require_calendar(self, clinician_id: int) -> None:
        """Raise 403 unless this person may manage `clinician_id`'s calendar."""
        if not self.can_manage_calendar(clinician_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only manage your own calendar")

    def clinician(self, staff_id: int) -> StaffMember:
        """Load an active clinician in this practice (e.g. for booking); 404 otherwise."""
        staff = self.db.get(StaffMember, staff_id)
        if (
            staff is None
            or staff.practice_id != self.practice_id
            or not staff.is_clinician
            or staff.status != StaffStatus.ACTIVE
        ):
            raise _not_found("Clinician")
        return staff
