"""The practice calendar: appointments with one or more clients, recurring series and
non-clinical events.

An appointment has 1 to 15 participants. An individual session bills its client; a couples or
family session bills only its identified patient; a group session bills every member. Each
participant has their own fee, attendance, reminders and video link.

Everyone in the practice sees the whole calendar so people and rooms aren't double-booked, but
clients someone can't reach are left out of what they see, and an appointment with none they
can reach shows only as busy time. Booking, changing or canceling needs the clinician's calendar
(your own, or any with the schedule-all permission) and access to every client's profile.
"""

from collections.abc import Collection, Iterable, Mapping, Sequence
from datetime import UTC, datetime, time, timedelta
from typing import Any, NamedTuple, NoReturn

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import exists, select
from sqlalchemy.orm import Session, selectinload

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list, audit_staff_throttled
from synari.deps import CurrentAccess, DbSession
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AppointmentSeries,
    Client,
    Location,
    Note,
    Recording,
    Service,
    StaffMember,
)
from synari.models.enums import (
    ACTIVE_APPOINTMENT_STATUSES,
    AppointmentKind,
    AppointmentStatus,
    ClientStatus,
    LocationType,
    Role,
)
from synari.schemas.appointments import (
    AppointmentCancel,
    AppointmentCreate,
    AppointmentOut,
    AppointmentUpdate,
    ConflictDetail,
    EditScope,
    ExternalBusyTime,
    ParticipantIn,
    ParticipantUpdate,
)
from synari.services.appointment_notices import (
    Attendee,
    attendees,
    notify_canceled,
    notify_changed,
    notify_scheduled,
    publish_calendar_change,
)
from synari.services.billing import is_on_active_invoice, service_billed
from synari.services.calendar_sync.busy import external_conflicts
from synari.services.calendar_sync.hooks import appointment_changed
from synari.services.estimates import review_estimate_needs
from synari.services.scheduling import (
    GROUP_SERVICE_CODES,
    Recurrence,
    ensure_on_care_team,
    expand_occurrences,
    find_client_conflicts,
    find_conflicts,
    is_group_session,
    new_video_room_name,
    participant_ids_with_billing,
    resolve_fee,
    zone_of,
)

router = APIRouter(prefix="/appointments", tags=["appointments"])

MAX_RANGE_DAYS = 400
MAX_LISTED_CONFLICTS = 5
DEFAULT_EVENT_MINUTES = 60
CANCELED_STATUSES = (
    AppointmentStatus.CANCELED,
    AppointmentStatus.LATE_CANCELED,
    AppointmentStatus.DECLINED,
)
_CANCELING = (AppointmentStatus.CANCELED, AppointmentStatus.LATE_CANCELED)
ALREADY_INVOICED = "This client's session is already invoiced, so its billing can't change"


def appointment_views(access: Access, appointments: Sequence[Appointment]) -> list[AppointmentOut]:
    """Appointments as this person may see them: clients they can't reach are left out, and
    appointments with none they can reach show only as busy time."""
    client_ids = {p.client_id for a in appointments for p in a.participants}
    reachable = (
        set(
            access.db.scalars(
                select(Client.id).where(Client.id.in_(client_ids), access.client_filter())
            )
        )
        if client_ids
        else set()
    )
    return [AppointmentOut.for_viewer(a, reachable) for a in appointments]


def with_external_conflicts(
    db: Session, appointments: Sequence[Appointment], views: Sequence[AppointmentOut]
) -> list[AppointmentOut]:
    """Add the non-blocking warning: busy times in the clinician's connected calendars that
    each saved entry overlaps."""
    found = external_conflicts(db, appointments)
    return [
        view.model_copy(
            update={
                "external_conflicts": [
                    ExternalBusyTime(starts_at=start, ends_at=end) for start, end in found[view.id]
                ]
            }
        )
        if view.id in found
        else view
        for view in views
    ]


def visible_client_ids(views: Iterable[AppointmentOut]) -> list[int]:
    """The clients a viewer actually sees in these appointments (for list audit events)."""
    return [participant.client.id for view in views for participant in view.participants]


def audit_appointment(
    db: Session,
    request: Request,
    staff: StaffMember,
    action: str,
    appointment_id: int,
    client_ids: Iterable[int],
    detail: dict[str, Any] | None = None,
) -> None:
    """Audit an action on an appointment once per client in it, so each client's access history
    shows it. An appointment without clients (an event) gets one event."""
    ids: list[int | None] = [*sorted(set(client_ids))] or [None]
    for client_id in ids:
        audit_staff(
            db, request, staff, action, "appointment", appointment_id, detail, client_id=client_id
        )


def _distinct(appointments: Iterable[Appointment]) -> list[Appointment]:
    return list({a.id: a for a in appointments}.values())


def raise_conflict(
    access: Access,
    conflicts: Sequence[Appointment],
    client_conflicts: Iterable[Appointment] = (),
    message: str = "This time overlaps another appointment",
) -> NoReturn:
    """409 listing (up to five of) the clinician's overlapping calendar entries and the clients'
    other appointments at the same time. Staff can save anyway with allow_conflicts."""
    listed = _distinct(conflicts)[:MAX_LISTED_CONFLICTS]
    listed_ids = {a.id for a in conflicts}
    others = [a for a in _distinct(client_conflicts) if a.id not in listed_ids]
    detail = ConflictDetail(
        message=message,
        conflicts=appointment_views(access, listed),
        client_conflicts=appointment_views(access, others[:MAX_LISTED_CONFLICTS]),
    )
    raise HTTPException(status.HTTP_409_CONFLICT, detail.model_dump(mode="json"))


def _conflict_message(clinician_conflicts: Sequence[Appointment]) -> str:
    if clinician_conflicts:
        return "This time overlaps another appointment"
    return "A client in this session already has an appointment at this time"


def _calendar_clinician(access: Access, clinician_id: int | None) -> StaffMember:
    """The clinician whose calendar to book on (yourself unless another is chosen)."""
    if clinician_id is None:
        if not access.staff.is_clinician:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a clinician")
        clinician_id = access.staff.id
    clinician = access.clinician(clinician_id)
    access.require_calendar(clinician.id)
    return clinician


def _load_clients(
    access: Access, entries: Sequence[ParticipantIn], existing: Collection[int] = ()
) -> list[Client]:
    """The participants' clients, each reachable at profile level. Archived clients can stay in
    an appointment they're already in but can't be added."""
    clients: list[Client] = []
    for entry in entries:
        client = access.client(entry.client_id, ClientAccess.PROFILE)
        if client.status == ClientStatus.ARCHIVED and client.id not in existing:
            raise HTTPException(status.HTTP_409_CONFLICT, "This client is archived")
        clients.append(client)
    return clients


def _billable_flags(
    entries: Sequence[ParticipantIn], *, group: bool, current: Mapping[int, bool]
) -> list[bool]:
    """Who is billed: as marked in the request, else clients already in the session keep their
    setting and new ones are billed only in a group, with the first client (the identified
    patient) billed when no one else is. An individual session always bills its client."""
    if len(entries) == 1:
        if entries[0].billable is False:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "An individual session bills its client"
            )
        return [True]
    if any(entry.billable is not None for entry in entries):
        flags = [bool(entry.billable) for entry in entries]
    else:
        flags = [current.get(entry.client_id, group) for entry in entries]
        flags[0] = flags[0] or not any(flags)
    if not any(flags):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Bill at least one client for the session"
        )
    return flags


def _price(db: Session, appointment: Appointment, participant: AppointmentParticipant) -> None:
    """The participant's usual fee for this session (nothing when they aren't billed)."""
    participant.fee_cents = (
        resolve_fee(db, appointment.service, participant.client, appointment.clinician_id)
        if participant.billable
        else 0
    )


def _reconcile_participants(
    db: Session,
    appointment: Appointment,
    entries: Sequence[ParticipantIn],
    clients: Sequence[Client],
    invoiced: Collection[int],
) -> list[AppointmentParticipant]:
    """Make the participants match the request: existing rows (with their attendance and
    reminders) stay, new clients join, and dropped ones leave unless they've been billed.
    Returns the participants that are new or whose billing changed."""
    current = {p.client_id: p for p in appointment.participants}
    wanted = {client.id for client in clients}
    dropped = [p for p in appointment.participants if p.client_id not in wanted]
    if participant_ids_with_billing(db, [p.id for p in dropped]):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A client who has been invoiced can't be removed from the appointment",
        )
    flags = _billable_flags(
        entries,
        group=is_group_session(appointment),
        current={client_id: p.billable for client_id, p in current.items()},
    )
    for participant in dropped:
        appointment.participants.remove(participant)
    changed: list[AppointmentParticipant] = []
    for client, billable in zip(clients, flags, strict=True):
        participant = current.get(client.id)
        if participant is None:
            participant = AppointmentParticipant(client=client, billable=billable)
            appointment.participants.append(participant)
        elif participant.billable == billable:
            continue
        elif participant.id in invoiced:
            raise HTTPException(status.HTTP_409_CONFLICT, ALREADY_INVOICED)
        else:
            participant.billable = billable
        changed.append(participant)
    return changed


def _update_participants(
    db: Session,
    appointment: Appointment,
    body: AppointmentUpdate,
    clients: Sequence[Client] | None,
    *,
    reprice: bool,
) -> None:
    """Apply a new participant list and fees. Participants who haven't been invoiced are
    re-priced: all of them when the service, clinician or fee changed, else new and newly
    billed ones."""
    invoiced = set(
        db.scalars(
            select(AppointmentParticipant.id).where(
                AppointmentParticipant.appointment_id == appointment.id,
                service_billed(AppointmentParticipant.id),
            )
        )
    )
    changed = (
        _reconcile_participants(db, appointment, body.participants, clients, invoiced)
        if body.participants is not None and clients is not None
        else []
    )
    to_price = appointment.participants if reprice or body.fee_cents is not None else changed
    for participant in to_price:
        if participant.id in invoiced:
            continue
        if participant.billable and body.fee_cents is not None:
            participant.fee_cents = body.fee_cents
        else:
            _price(db, appointment, participant)


def _load_service(access: Access, service_id: int | None) -> Service | None:
    if service_id is None:
        return None
    return access.get(Service, service_id, label="Service")


def _load_location(access: Access, location_id: int | None) -> Location | None:
    if location_id is None:
        return None
    location = access.get(Location, location_id, label="Location")
    if not location.is_active:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "This location is no longer in use"
        )
    return location


def _default_service(db: Session, client: Client) -> Service | None:
    if client.default_service_id is not None:
        return db.get(Service, client.default_service_id)
    return db.scalar(
        select(Service).where(
            Service.practice_id == client.practice_id, Service.is_default, Service.is_active
        )
    )


def _managed_appointment(access: Access, appointment_id: int) -> Appointment:
    """An appointment this person may change: they can reach every one of its clients and they
    manage the clinician's calendar."""
    appointment = access.get(Appointment, appointment_id, label="Appointment")
    reachable = [
        access.can_access_client(p.client, ClientAccess.PROFILE) for p in appointment.participants
    ]
    if reachable and not any(reachable):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    if not all(reachable):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Some of this appointment's clients are outside your access"
        )
    access.require_calendar(appointment.clinician_id)
    return appointment


def _series_targets(
    access: Access, appointment: Appointment, scope: EditScope
) -> list[Appointment]:
    """This occurrence, or it and the rest of its series (all on calendars this person manages)."""
    if scope == "this" or appointment.series_id is None:
        return [appointment]
    targets = list(
        access.db.scalars(
            select(Appointment)
            .where(
                Appointment.series_id == appointment.series_id,
                Appointment.starts_at >= appointment.starts_at,
                Appointment.status.in_(ACTIVE_APPOINTMENT_STATUSES),
            )
            .order_by(Appointment.starts_at)
        )
    )
    for clinician_id in {target.clinician_id for target in targets}:
        access.require_calendar(clinician_id)
    return targets


def _client_ids(appointment: Appointment) -> list[int]:
    return [participant.client_id for participant in appointment.participants]


class _NoticeFields(NamedTuple):
    """What client-facing "appointment changed" notices depend on."""

    starts_at: datetime
    ends_at: datetime
    clinician_id: int
    location_type: str
    location_id: int | None
    location_details: str


def _notice_fields(appointment: Appointment) -> _NoticeFields:
    return _NoticeFields(
        appointment.starts_at,
        appointment.ends_at,
        appointment.clinician_id,
        appointment.location_type,
        appointment.location_id,
        appointment.location_details,
    )


def _reminder_fields(appointment: Appointment) -> tuple[datetime, str, int | None]:
    """What a reminder tells the client about when and where."""
    return appointment.starts_at, appointment.location_type, appointment.location_id


@router.get("", response_model=list[AppointmentOut])
def list_appointments(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    start: datetime = Query(description="Inclusive range start (ISO 8601 with offset)"),
    end: datetime = Query(description="Exclusive range end"),
    clinician_ids: list[int] | None = Query(
        default=None, description="Only these clinicians' calendars (default: everyone's)"
    ),
    client_id: int | None = Query(default=None, description="Only appointments with this client"),
    include_canceled: bool = Query(default=True),
) -> list[AppointmentOut]:
    """The practice's calendar entries overlapping [start, end)."""
    if start.tzinfo is None or end.tzinfo is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "start and end need a UTC offset"
        )
    if end <= start or end - start > timedelta(days=MAX_RANGE_DAYS):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid date range")
    query = select(Appointment).where(
        Appointment.practice_id == access.practice_id,
        Appointment.starts_at < end,
        Appointment.ends_at > start,
    )
    if clinician_ids:
        query = query.where(Appointment.clinician_id.in_(clinician_ids))
    if client_id is not None:
        access.client(client_id, ClientAccess.PROFILE)
        query = query.where(
            Appointment.participants.any(AppointmentParticipant.client_id == client_id)
        )
    if not include_canceled:
        query = query.where(Appointment.status.not_in(CANCELED_STATUSES))
    appointments = db.scalars(
        query.options(
            selectinload(Appointment.clinician), selectinload(Appointment.location)
        ).order_by(Appointment.starts_at)
    )
    views = appointment_views(access, list(appointments))
    audit_staff_list(db, request, access.staff, "appointment.list", visible_client_ids(views))
    db.commit()
    return views


@router.post("", response_model=list[AppointmentOut], status_code=status.HTTP_201_CREATED)
def create_appointments(
    body: AppointmentCreate, access: CurrentAccess, db: DbSession, request: Request
) -> list[AppointmentOut]:
    """Create an appointment or event on a clinician's calendar, expanding a recurrence into up
    to 100 occurrences. The clinician joins the care team of any client they aren't yet on."""
    clinician = _calendar_clinician(access, body.clinician_id)
    clients = _load_clients(access, body.participants)
    service = _load_service(access, body.service_id)
    if service is None and clients:
        service = _default_service(db, clients[0])
    location = _load_location(access, body.location_id)

    is_appointment = body.kind == AppointmentKind.APPOINTMENT
    group = body.group or (service is not None and service.code in GROUP_SERVICE_CODES)
    billed = _billable_flags(body.participants, group=group, current={}) if clients else []
    duration = body.duration_minutes or (
        service.duration_minutes if service and is_appointment else None
    )
    length = timedelta(minutes=duration or DEFAULT_EVENT_MINUTES)
    starts = [body.starts_at.astimezone(UTC)]
    series: AppointmentSeries | None = None
    if body.recurrence is not None:
        zone = zone_of(clinician)
        until = (
            datetime.combine(body.recurrence.until, time.max, tzinfo=zone)
            if body.recurrence.until
            else None
        )
        starts = expand_occurrences(
            body.starts_at,
            Recurrence(
                body.recurrence.frequency, body.recurrence.interval, body.recurrence.count, until
            ),
            zone,
        )
        series = AppointmentSeries(
            practice_id=access.practice_id,
            clinician_id=clinician.id,
            frequency=body.recurrence.frequency,
            interval=body.recurrence.interval,
        )
        db.add(series)
        db.flush()

    if not body.allow_conflicts:
        client_ids = [client.id for client in clients]
        conflicts = [
            c for start in starts for c in find_conflicts(db, clinician.id, start, start + length)
        ]
        client_conflicts = [
            c
            for start in starts
            for c in find_client_conflicts(db, client_ids, start, start + length)
        ]
        if conflicts or client_conflicts:
            raise_conflict(access, conflicts, client_conflicts, _conflict_message(conflicts))

    joined_care_team = [
        client.id
        for client in clients
        if access.can_manage_care_team(client) and ensure_on_care_team(client, clinician.id)
    ]
    fees = [
        (
            body.fee_cents
            if body.fee_cents is not None
            else resolve_fee(db, service, client, clinician.id)
        )
        if bill
        else 0
        for client, bill in zip(clients, billed, strict=True)
    ]
    created: list[Appointment] = []
    for start in starts:
        appointment = Appointment(
            practice_id=access.practice_id,
            clinician_id=clinician.id,
            kind=body.kind,
            title=body.title.strip(),
            service_id=service.id if service and is_appointment else None,
            service_code=service.code if service and is_appointment else "",
            service_description=service.description if service and is_appointment else "",
            starts_at=start,
            ends_at=start + length,
            location_type=body.location_type,
            location_id=location.id if location else None,
            location_details=body.location_details,
            memo=body.memo,
            series_id=series.id if series else None,
            video_room_name=(
                new_video_room_name()
                if is_appointment and body.location_type == LocationType.VIDEO
                else None
            ),
            participants=[
                AppointmentParticipant(client=client, billable=bill, fee_cents=fee)
                for client, bill, fee in zip(clients, billed, fees, strict=True)
            ],
        )
        db.add(appointment)
        created.append(appointment)
    db.flush()
    for appointment in created:
        appointment_changed(db, appointment)
    review_estimate_needs(db, created)
    if body.notify_client:
        notify_scheduled(db, attendees(created))
    audit_appointment(
        db,
        request,
        access.staff,
        "appointment.create",
        created[0].id,
        [client.id for client in clients],
        {
            "count": len(created),
            "clinician_id": clinician.id,
            "joined_care_team": joined_care_team,
        },
    )
    publish_calendar_change(db, created, "appointment.created")
    db.commit()
    return with_external_conflicts(db, created, appointment_views(access, created))


@router.get("/{appointment_id}", response_model=AppointmentOut)
def get_appointment(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> AppointmentOut:
    """One calendar entry (only busy time if its clients are out of your reach). Opening it is
    audited for each client it shows (memo and cancel reason included)."""
    appointment = access.get(Appointment, appointment_id, label="Appointment")
    view = appointment_views(access, [appointment])[0]
    for client_id in visible_client_ids([view]):
        audit_staff_throttled(
            db,
            request,
            access.staff,
            "appointment.view",
            "appointment",
            appointment.id,
            client_id=client_id,
        )
    db.commit()
    return view


def _removed(
    targets: Sequence[Appointment], had: Mapping[int, Mapping[int, Client]]
) -> list[Attendee]:
    """Clients who were in each appointment (`had`, by appointment id) but no longer are."""
    return [
        (client, target)
        for target in targets
        for client_id, client in had[target.id].items()
        if client_id not in _client_ids(target)
    ]


def _notify_update(
    db: Session,
    targets: Sequence[Appointment],
    body: AppointmentUpdate,
    before: Mapping[int, _NoticeFields],
    had: Mapping[int, Mapping[int, Client]],
) -> None:
    """Email clients about a change: a cancellation; a new time, place or clinician; or being
    added to or taken out of an appointment."""
    if body.status in _CANCELING:
        notify_canceled(db, attendees(targets))
        return
    current = attendees(targets)
    changed = {t.id for t in targets if _notice_fields(t) != before[t.id]}
    notify_changed(db, [(c, a) for c, a in current if a.id in changed and c.id in had[a.id]])
    notify_scheduled(db, [(c, a) for c, a in current if c.id not in had[a.id]])
    notify_canceled(db, _removed(targets, had))


@router.patch("/{appointment_id}", response_model=list[AppointmentOut])
def update_appointment(
    appointment_id: int,
    body: AppointmentUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    scope: EditScope = Query(default="this"),
) -> list[AppointmentOut]:
    """Edit one occurrence, or this and all following occurrences of a series. Moving it to
    another clinician needs both calendars. `participants` replaces the client list."""
    appointment = _managed_appointment(access, appointment_id)
    changes = body.model_dump(exclude_unset=True, exclude={"allow_conflicts", "notify_client"})
    if "status" in changes and scope != "this":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Change status one appointment at a time"
        )
    if body.participants is not None and appointment.kind == AppointmentKind.EVENT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Events don't have clients")
    previous_clinician = appointment.clinician
    clinician = previous_clinician
    if body.clinician_id is not None and body.clinician_id != previous_clinician.id:
        clinician = _calendar_clinician(access, body.clinician_id)
    clinician_changed = clinician.id != previous_clinician.id
    targets = _series_targets(access, appointment, scope)
    clients = (
        _load_clients(access, body.participants, existing=_client_ids(appointment))
        if body.participants is not None
        else None
    )
    zone = zone_of(previous_clinician)

    shift = timedelta(0)
    if body.starts_at is not None:
        new_local = body.starts_at.astimezone(zone).replace(tzinfo=None)
        old_local = appointment.starts_at.astimezone(zone).replace(tzinfo=None)
        shift = new_local - old_local
    service = _load_service(access, body.service_id) if "service_id" in changes else None
    location = _load_location(access, body.location_id) if "location_id" in changes else None
    before = {target.id: _notice_fields(target) for target in targets}
    reminded = {target.id: _reminder_fields(target) for target in targets}
    had = {target.id: {p.client_id: p.client for p in target.participants} for target in targets}

    for target in targets:
        duration = body.duration_minutes or target.duration_minutes
        if body.starts_at is not None:
            local = target.starts_at.astimezone(zone).replace(tzinfo=None) + shift
            target.starts_at = local.replace(tzinfo=zone).astimezone(UTC)
        target.ends_at = target.starts_at + timedelta(minutes=duration)
        if clinician_changed:
            target.clinician = clinician
        if "service_id" in changes:
            target.service = service
            target.service_code = service.code if service else ""
            target.service_description = service.description if service else ""
        if "location_id" in changes:
            target.location = location
        if body.location_type is not None:
            target.location_type = body.location_type
            if body.location_type == LocationType.VIDEO and target.video_room_name is None:
                target.video_room_name = (
                    new_video_room_name() if target.kind == AppointmentKind.APPOINTMENT else None
                )
            elif body.location_type != LocationType.VIDEO:
                target.video_room_name = None
        for field in ("location_details", "memo", "title"):
            if field in changes:
                setattr(target, field, changes[field])
        if body.status is not None:
            target.status = body.status
            if body.status in _CANCELING:
                target.canceled_at = datetime.now(UTC)
                target.canceled_by = Role.STAFF
            else:
                target.canceled_at = None
                target.canceled_by = None
                target.cancel_reason = ""
    db.flush()  # sync the clinician, service and location ids for the checks below
    reprice = "service_id" in changes or clinician_changed
    for target in targets:
        if target.kind == AppointmentKind.APPOINTMENT:
            _update_participants(db, target, body, clients, reprice=reprice)
        if _reminder_fields(target) != reminded[target.id]:
            # Re-arm reminders so each client is reminded of the new time or place.
            for participant in target.participants:
                participant.reminder_email_sent_at = None
                participant.reminder_sms_sent_at = None
        if clinician_changed or body.participants is not None:
            for participant in target.participants:
                if access.can_manage_care_team(participant.client):
                    ensure_on_care_team(participant.client, target.clinician_id)
    db.flush()

    time_changed = body.starts_at is not None or body.duration_minutes is not None
    who_changed = clinician_changed or body.participants is not None
    if (time_changed or who_changed) and not body.allow_conflicts:
        target_ids = {t.id for t in targets}
        active = [t for t in targets if t.status in ACTIVE_APPOINTMENT_STATUSES]
        conflicts = [
            c
            for t in active
            for c in find_conflicts(db, t.clinician_id, t.starts_at, t.ends_at, target_ids)
        ]
        client_conflicts = [
            c
            for t in active
            for c in find_client_conflicts(db, _client_ids(t), t.starts_at, t.ends_at, target_ids)
        ]
        if conflicts or client_conflicts:
            db.rollback()
            raise_conflict(access, conflicts, client_conflicts, _conflict_message(conflicts))

    for target in targets:
        appointment_changed(db, target)
    review_estimate_needs(db, targets)
    if body.notify_client:
        _notify_update(db, targets, body, before, had)
    removed = _removed(targets, had)
    detail: dict[str, object] = {"fields": sorted(changes), "scope": scope, "count": len(targets)}
    if body.participants is not None:
        detail["removed_client_ids"] = sorted({client.id for client, _ in removed})
    audit_appointment(
        db,
        request,
        access.staff,
        "appointment.update",
        appointment.id,
        [*_client_ids(appointment), *(client.id for client, _ in removed)],
        detail,
    )
    publish_calendar_change(
        db,
        targets,
        "appointment.updated",
        extra_staff_ids=[previous_clinician.id],
        extra_clients=[client for client, _ in removed],
    )
    db.commit()
    return with_external_conflicts(db, targets, appointment_views(access, targets))


@router.put("/{appointment_id}/participants/{participant_id}", response_model=AppointmentOut)
def update_participant(
    appointment_id: int,
    participant_id: int,
    body: ParticipantUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AppointmentOut:
    """Set one client's attendance (e.g. a group member who didn't show up; null follows the
    session's status) or whether they're billed (only before their session is invoiced)."""
    appointment = _managed_appointment(access, appointment_id)
    participant = next((p for p in appointment.participants if p.id == participant_id), None)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found")
    if appointment.status in (AppointmentStatus.REQUESTED, AppointmentStatus.DECLINED):
        raise HTTPException(status.HTTP_409_CONFLICT, "This appointment isn't scheduled")
    changes = body.model_dump(exclude_unset=True)
    if "attendance" in changes:
        participant.attendance = body.attendance
    if body.billable is not None and body.billable != participant.billable:
        if len(appointment.participants) == 1:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "An individual session bills its client"
            )
        if is_on_active_invoice(db, participant.id):
            raise HTTPException(status.HTTP_409_CONFLICT, ALREADY_INVOICED)
        participant.billable = body.billable
        _price(db, appointment, participant)
    appointment_changed(db, appointment)
    review_estimate_needs(db, [appointment])
    audit_staff(
        db,
        request,
        access.staff,
        "appointment.participant_update",
        "appointment",
        appointment.id,
        {"participant_id": participant.id, "fields": sorted(changes)},
        client_id=participant.client_id,
    )
    publish_calendar_change(db, [appointment], "appointment.updated")
    db.commit()
    return appointment_views(access, [appointment])[0]


@router.post("/{appointment_id}/cancel", response_model=list[AppointmentOut])
def cancel_appointment(
    appointment_id: int,
    body: AppointmentCancel,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    scope: EditScope = Query(default="this"),
) -> list[AppointmentOut]:
    """Cancel one occurrence or the rest of a series, for every client in it. Late
    cancellations can be billed."""
    appointment = _managed_appointment(access, appointment_id)
    if appointment.status not in ACTIVE_APPOINTMENT_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This appointment is already canceled")
    targets = _series_targets(access, appointment, scope)
    now = datetime.now(UTC)
    for target in targets:
        target.status = AppointmentStatus.LATE_CANCELED if body.late else AppointmentStatus.CANCELED
        target.canceled_at = now
        target.canceled_by = Role.STAFF
        target.cancel_reason = body.reason
        appointment_changed(db, target)
    if body.notify_client:
        notify_canceled(db, attendees(targets))
    audit_appointment(
        db,
        request,
        access.staff,
        "appointment.cancel",
        appointment.id,
        _client_ids(appointment),
        {"count": len(targets)},
    )
    publish_calendar_change(db, targets, "appointment.canceled")
    db.commit()
    return appointment_views(access, targets)


@router.delete("/{appointment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_appointment(
    appointment_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    scope: EditScope = Query(default="this"),
) -> None:
    """Delete appointments that have no notes, recordings or billing; otherwise cancel them
    instead."""
    appointment = _managed_appointment(access, appointment_id)
    targets = _series_targets(access, appointment, scope)
    target_ids = [t.id for t in targets]
    has_records = db.scalar(
        select(
            exists().where(Note.appointment_id.in_(target_ids))
            | exists().where(Recording.appointment_id.in_(target_ids))
        )
    ) or participant_ids_with_billing(db, [p.id for t in targets for p in t.participants])
    if has_records:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This appointment has notes or invoices, so it can't be deleted. Cancel it instead.",
        )
    publish_calendar_change(db, targets, "appointment.deleted")
    client_ids = _client_ids(appointment)
    for target in targets:
        db.delete(target)
        appointment_changed(db, target)
    audit_appointment(
        db,
        request,
        access.staff,
        "appointment.delete",
        appointment.id,
        client_ids,
        {"count": len(targets)},
    )
    db.commit()
