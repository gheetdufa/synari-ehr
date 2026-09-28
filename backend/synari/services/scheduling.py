"""Calendar rules: recurrence expansion, conflict detection, fees, participants and care-team
membership."""

import secrets
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    ClaimLine,
    Client,
    ClientClinician,
    ClinicianService,
    InvoiceItem,
    Service,
)
from synari.models.enums import (
    ACTIVE_APPOINTMENT_STATUSES,
    AppointmentStatus,
    RecurrenceFrequency,
)

MAX_OCCURRENCES = 100
MAX_PARTICIPANTS = 15
# Group psychotherapy (90853) and its interactive-complexity add-on (90849) bill every member.
GROUP_SERVICE_CODES = frozenset({"90853", "90849"})


@dataclass(frozen=True)
class Recurrence:
    frequency: RecurrenceFrequency
    interval: int
    count: int | None
    until: datetime | None


class HasTimeZone(Protocol):
    time_zone: str


def zone_of(owner: HasTimeZone) -> ZoneInfo:
    """The wall clock of a practice (billing days) or staff member (their calendar)."""
    return ZoneInfo(owner.time_zone)


def _add_months(local: datetime, months: int) -> datetime | None:
    month_index = local.month - 1 + months
    year = local.year + month_index // 12
    month = month_index % 12 + 1
    try:
        return local.replace(year=year, month=month)
    except ValueError:  # e.g. the 31st in a 30-day month: skip that month
        return None


def expand_occurrences(start: datetime, recurrence: Recurrence, zone: ZoneInfo) -> list[datetime]:
    """UTC start times for each occurrence, keeping the same local wall-clock time across DST."""
    local_start = start.astimezone(zone)
    limit = min(recurrence.count or MAX_OCCURRENCES, MAX_OCCURRENCES)
    occurrences: list[datetime] = []
    step = 0
    while len(occurrences) < limit and step < MAX_OCCURRENCES * 2:
        if recurrence.frequency == RecurrenceFrequency.WEEKLY:
            local = local_start + timedelta(weeks=step * recurrence.interval)
        else:
            shifted = _add_months(local_start, step * recurrence.interval)
            if shifted is None:
                step += 1
                continue
            local = shifted
        # Aware-datetime arithmetic is wall-clock, so the UTC offset follows DST on each date.
        if recurrence.until is not None and local > recurrence.until:
            break
        occurrences.append(local.astimezone(UTC))
        step += 1
    return occurrences


def find_conflicts(
    db: Session,
    clinician_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_ids: Collection[int] = (),
) -> list[Appointment]:
    """The clinician's active appointments and events that overlap the given interval."""
    query = select(Appointment).where(
        Appointment.clinician_id == clinician_id,
        Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
        Appointment.starts_at < ends_at,
        Appointment.ends_at > starts_at,
    )
    if exclude_ids:
        query = query.where(Appointment.id.not_in(exclude_ids))
    return list(db.scalars(query.order_by(Appointment.starts_at)))


def find_client_conflicts(
    db: Session,
    client_ids: Collection[int],
    starts_at: datetime,
    ends_at: datetime,
    exclude_ids: Collection[int] = (),
) -> list[Appointment]:
    """Active appointments (with any clinician) that one of these clients attends during the
    interval."""
    if not client_ids:
        return []
    attends = AppointmentParticipant.client_id.in_(client_ids) & or_(
        AppointmentParticipant.attendance.is_(None),
        AppointmentParticipant.attendance == AppointmentStatus.ATTENDED,
    )
    query = select(Appointment).where(
        Appointment.participants.any(attends),
        Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
        Appointment.starts_at < ends_at,
        Appointment.ends_at > starts_at,
    )
    if exclude_ids:
        query = query.where(Appointment.id.not_in(exclude_ids))
    return list(db.scalars(query.order_by(Appointment.starts_at)))


def is_group_session(appointment: Appointment) -> bool:
    """A group session, where each member is billed: a group psychotherapy service or more than
    one billed participant. Anything else is an individual or a couples/family session."""
    billed = sum(participant.billable for participant in appointment.participants)
    return appointment.service_code in GROUP_SERVICE_CODES or billed > 1


def participant_ids_with_billing(db: Session, participant_ids: Collection[int]) -> set[int]:
    """Participants that any invoice line or insurance claim line refers to, even voided ones:
    they can't be removed from their appointment."""
    if not participant_ids:
        return set()
    invoiced = select(InvoiceItem.participant_id).where(
        InvoiceItem.participant_id.in_(participant_ids)
    )
    claimed = select(ClaimLine.participant_id).where(ClaimLine.participant_id.in_(participant_ids))
    return {row for row in db.scalars(invoiced.union(claimed)) if row is not None}


def resolve_fee(
    db: Session, service: Service | None, client: Client | None, clinician_id: int
) -> int:
    """The client's custom rate, else the clinician's rate for the service, else the service's."""
    if client is not None and client.rate_override_cents is not None:
        return client.rate_override_cents
    if service is None:
        return 0
    clinician_rate = db.scalar(
        select(ClinicianService.rate_cents).where(
            ClinicianService.staff_id == clinician_id, ClinicianService.service_id == service.id
        )
    )
    return clinician_rate if clinician_rate is not None else service.rate_cents


def clinician_offers(db: Session, clinician_id: int, service_id: int) -> bool:
    """Whether the clinician offers a service (they do unless marked otherwise)."""
    offered = db.scalar(
        select(ClinicianService.offered).where(
            ClinicianService.staff_id == clinician_id, ClinicianService.service_id == service_id
        )
    )
    return offered is not False


def ensure_on_care_team(client: Client, clinician_id: int) -> bool:
    """Add a clinician who sees the client to their care team (not as primary), so they can
    open the chart. Returns whether they were added."""
    if any(member.staff_id == clinician_id for member in client.care_team):
        return False
    client.care_team.append(ClientClinician(staff_id=clinician_id, is_primary=False))
    return True


def new_video_room_name() -> str:
    """An unguessable LiveKit room name."""
    return f"synari-{secrets.token_hex(12)}"
