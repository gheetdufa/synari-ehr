"""Bookable time slots computed from each clinician's weekly availability, and appointment
requests.

Availability blocks are wall-clock windows in the clinician's time zone. Slots are generated on
local wall time for each date and only then converted to UTC, so a 9:00 block stays at 9:00
across DST changes. Wall times that don't exist (the spring-forward gap) are skipped; ambiguous
ones (the fall-back hour) use their first occurrence. The practice's booking settings (minimum
notice, horizon, slot interval) apply to every clinician. Busy times from a clinician's
connected Google or Microsoft calendars (services/calendar_sync/busy.py) block slots too.
"""

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    AvailabilityBlock,
    Client,
    ClinicianService,
    PracticeSettings,
    Service,
    StaffMember,
)
from synari.models.enums import (
    ACTIVE_APPOINTMENT_STATUSES,
    AppointmentStatus,
    BookingSource,
    LocationType,
)
from synari.services.calendar_sync.busy import external_busy_intervals
from synari.services.scheduling import new_video_room_name, resolve_fee, zone_of

MAX_RANGE_DAYS = 31

Interval = tuple[datetime, datetime]


@dataclass(frozen=True)
class Slot:
    starts_at: datetime
    ends_at: datetime
    location_type: str
    location_id: int | None


@dataclass(frozen=True)
class SlotRules:
    """What the booking settings allow for one service."""

    duration: timedelta
    step: timedelta
    earliest_start: datetime
    last_date: date


def _existing_instant(wall: datetime, zone: ZoneInfo) -> datetime | None:
    """UTC instant of a naive local wall time, or None if DST skips it."""
    instant = wall.replace(tzinfo=zone).astimezone(UTC)
    if instant.astimezone(zone).replace(tzinfo=None) != wall:
        return None
    return instant


def _earliest_instant(wall: datetime, zone: ZoneInfo) -> datetime:
    """The earlier UTC reading of a wall time, so a block never extends past its local end."""
    return min(
        wall.replace(tzinfo=zone, fold=0).astimezone(UTC),
        wall.replace(tzinfo=zone, fold=1).astimezone(UTC),
    )


def local_midnight(day: date, zone: ZoneInfo) -> datetime:
    """UTC instant at which a local date begins."""
    return _earliest_instant(datetime.combine(day, time.min), zone)


def slot_rules(
    settings: PracticeSettings, zone: ZoneInfo, service: Service, end_date: date, now: datetime
) -> SlotRules:
    """Apply the practice's interval, minimum notice and booking horizon to a service, counting
    days on the clinician's calendar (`zone`)."""
    duration = timedelta(minutes=service.duration_minutes)
    step = timedelta(minutes=settings.booking_slot_interval_minutes) or duration
    today = now.astimezone(zone).date()
    return SlotRules(
        duration=duration,
        step=step,
        earliest_start=now + timedelta(hours=settings.booking_min_notice_hours),
        last_date=min(end_date, today + timedelta(days=settings.booking_max_days_ahead)),
    )


def compute_slots(
    blocks: Iterable[AvailabilityBlock],
    busy: Sequence[Interval],
    zone: ZoneInfo,
    start_date: date,
    rules: SlotRules,
) -> list[Slot]:
    """Every slot that fits inside a block, respects the rules and overlaps nothing busy."""
    by_weekday: dict[int, list[AvailabilityBlock]] = defaultdict(list)
    for block in blocks:
        by_weekday[block.weekday].append(block)

    slots: list[Slot] = []
    day = max(start_date, rules.earliest_start.astimezone(zone).date())
    while day <= rules.last_date:
        for block in by_weekday.get(day.weekday(), []):
            wall = datetime.combine(day, block.start_time)
            wall_end = datetime.combine(day, block.end_time)
            block_end = _earliest_instant(wall_end, zone)
            while wall < wall_end:
                starts_at = _existing_instant(wall, zone)
                wall += rules.step
                if starts_at is None:
                    continue
                ends_at = starts_at + rules.duration
                if ends_at > block_end:
                    break
                if starts_at < rules.earliest_start:
                    continue
                if any(start < ends_at and end > starts_at for start, end in busy):
                    continue
                slots.append(Slot(starts_at, ends_at, block.location_type, block.location_id))
        day += timedelta(days=1)
    return sorted(slots, key=lambda slot: slot.starts_at)


def busy_intervals(
    db: Session, clinician_id: int, range_start: datetime, range_end: datetime
) -> list[Interval]:
    """Times the clinician is taken by appointments, events and pending requests (busy times
    from their connected calendars are added in available_slots)."""
    rows = db.execute(
        select(Appointment.starts_at, Appointment.ends_at).where(
            Appointment.clinician_id == clinician_id,
            Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
            Appointment.starts_at < range_end,
            Appointment.ends_at > range_start,
        )
    )
    return [(start, end) for start, end in rows]


def available_slots(
    db: Session,
    clinician: StaffMember,
    service: Service,
    start_date: date,
    end_date: date,
    now: datetime,
) -> list[Slot]:
    """The clinician's open slots for a service between two of their local dates (inclusive)."""
    zone = zone_of(clinician)
    rules = slot_rules(clinician.practice.settings, zone, service, end_date, now)
    if rules.last_date < start_date:
        return []
    blocks = db.scalars(
        select(AvailabilityBlock).where(AvailabilityBlock.clinician_id == clinician.id)
    ).all()
    range_start = local_midnight(start_date, zone)
    range_end = local_midnight(rules.last_date + timedelta(days=1), zone)
    busy = busy_intervals(db, clinician.id, range_start, range_end)
    busy += external_busy_intervals(db, clinician.id, range_start, range_end)
    return compute_slots(blocks, busy, zone, start_date, rules)


def bookable_services(clinician: StaffMember, *, new_clients: bool) -> Select[tuple[Service]]:
    """Active services the clinician offers that clients may book online (new clients only
    those marked for them)."""
    not_offered = select(ClinicianService.service_id).where(
        ClinicianService.staff_id == clinician.id, ClinicianService.offered.is_(False)
    )
    query = select(Service).where(
        Service.practice_id == clinician.practice_id,
        Service.is_active,
        Service.bookable_online,
        Service.id.not_in(not_offered),
    )
    if new_clients:
        query = query.where(Service.bookable_by_new_clients)
    return query.order_by(Service.description)


def lock_schedule(db: Session, clinician_id: int) -> None:
    """Serialize bookings on one clinician's calendar until the transaction ends."""
    db.execute(select(StaffMember.id).where(StaffMember.id == clinician_id).with_for_update())


def find_open_slot(
    db: Session,
    clinician: StaffMember,
    service: Service,
    starts_at: datetime,
    location_type: LocationType,
    now: datetime,
) -> Slot | None:
    """The offered slot starting exactly at `starts_at` with this location, if still open."""
    local_date = starts_at.astimezone(zone_of(clinician)).date()
    for slot in available_slots(db, clinician, service, local_date, local_date, now):
        if slot.starts_at == starts_at and slot.location_type == location_type:
            return slot
    return None


def build_request(
    db: Session,
    clinician: StaffMember,
    client: Client,
    service: Service,
    slot: Slot,
    source: BookingSource,
    message: str,
) -> Appointment:
    """A requested individual appointment awaiting accept or decline (caller adds it)."""
    participant = AppointmentParticipant(
        client=client, billable=True, fee_cents=resolve_fee(db, service, client, clinician.id)
    )
    return Appointment(
        practice_id=clinician.practice_id,
        clinician_id=clinician.id,
        participants=[participant],
        service_id=service.id,
        service_code=service.code,
        service_description=service.description,
        starts_at=slot.starts_at,
        ends_at=slot.ends_at,
        location_type=slot.location_type,
        location_id=slot.location_id,
        status=AppointmentStatus.REQUESTED,
        source=source,
        request_message=message.strip(),
        video_room_name=(
            new_video_room_name() if slot.location_type == LocationType.VIDEO else None
        ),
    )
