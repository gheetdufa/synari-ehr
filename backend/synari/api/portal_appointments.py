"""Client portal: request appointments online with a clinician on the care team, see
appointments and cancel within the practice's policy.

A client sees every appointment they take part in (a guardian signed in for them sees the
same). In a couples or family session they see the others' first names; in a group session they
see nothing about the other members. Canceling a shared session cancels only the client's own
place in it.
"""

from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from synari.api.booking import SLOT_TAKEN, booking_locations, check_range
from synari.audit import audit_client
from synari.db import utcnow
from synari.deps import CurrentClient, DbSession
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    PracticeSettings,
    Service,
    StaffMember,
)
from synari.models.enums import AppointmentKind, AppointmentStatus, BookingSource, Role
from synari.schemas.booking import (
    BookableService,
    PortalAppointmentOut,
    PortalBookingClinician,
    PortalBookingOptions,
    PortalBookingRequest,
    PortalCancelRequest,
    SlotOut,
)
from synari.services.appointment_notices import (
    addressees,
    alert_clinician_of_cancellation,
    alert_staff_of_request,
    appointment_address,
    client_zone,
    notify_request_received,
)
from synari.services.availability import (
    Slot,
    available_slots,
    bookable_services,
    build_request,
    find_open_slot,
    lock_schedule,
)
from synari.services.calendar_sync.busy import live_busy_check
from synari.services.calendar_sync.hooks import appointment_changed
from synari.services.scheduling import is_group_session

router = APIRouter(prefix="/portal", tags=["portal appointments"])

UPCOMING_STATUSES = (AppointmentStatus.REQUESTED, AppointmentStatus.SCHEDULED)
PAST_LIMIT = 100
UNAVAILABLE = "Online booking isn't available. Please contact your practice to schedule."


def _require_booking(client: Client) -> None:
    """403 unless this client may request appointments online."""
    if not (client.portal_booking and client.practice.settings.booking_enabled):
        raise HTTPException(status.HTTP_403_FORBIDDEN, UNAVAILABLE)


def _care_team_clinicians(client: Client) -> list[StaffMember]:
    """Active clinicians on the client's care team, primary first."""
    members = sorted(client.care_team, key=lambda member: not member.is_primary)
    return [m.staff for m in members if m.staff.is_active and m.staff.is_clinician]


def _booking_clinician(client: Client, clinician_id: int) -> StaffMember:
    _require_booking(client)
    clinician = next((c for c in _care_team_clinicians(client) if c.id == clinician_id), None)
    if clinician is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clinician not found")
    return clinician


def _bookable_service(db: Session, clinician: StaffMember, service_id: int) -> Service:
    service = db.scalar(
        bookable_services(clinician, new_clients=False).where(Service.id == service_id)
    )
    if service is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Service not found")
    return service


def _hours(count: int) -> str:
    return f"{count} hour" if count == 1 else f"{count} hours"


def _is_shared(appointment: Appointment) -> bool:
    return len(appointment.participants) > 1


def _inside_window(appointment: Appointment, settings: PracticeSettings, now: datetime) -> bool:
    return appointment.starts_at - now < timedelta(hours=settings.cancellation_window_hours)


def can_cancel(
    appointment: Appointment,
    participant: AppointmentParticipant,
    settings: PracticeSettings,
    now: datetime,
) -> bool:
    """Pending requests can be withdrawn until their time. Scheduled visits can be canceled if
    the practice allows it online: individual sessions only outside its cancellation window,
    a place in a shared session at any time before it starts (late inside the window)."""
    if participant.attendance is not None or appointment.starts_at <= now:
        return False
    if appointment.status == AppointmentStatus.REQUESTED:
        return True
    if appointment.status != AppointmentStatus.SCHEDULED or settings.cancellation_window_hours == 0:
        return False
    return _is_shared(appointment) or not _inside_window(appointment, settings, now)


def _other_first_names(appointment: Appointment, client: Client) -> list[str]:
    """Who else is in a couples or family session; nothing about a group's other members."""
    if is_group_session(appointment):
        return []
    return [
        p.client.display_first_name for p in appointment.participants if p.client_id != client.id
    ]


def _portal_view(
    appointment: Appointment, participant: AppointmentParticipant, client: Client, now: datetime
) -> PortalAppointmentOut:
    practice = client.practice
    cancelable = can_cancel(appointment, participant, practice.settings, now)
    return PortalAppointmentOut(
        id=appointment.id,
        starts_at=appointment.starts_at,
        ends_at=appointment.ends_at,
        status=participant.effective_status,
        location_type=appointment.location_type,
        location_details=appointment_address(appointment, practice),
        has_video=appointment.has_video,
        clinician_name=appointment.clinician.display_name,
        service_description=appointment.service_description,
        is_group=is_group_session(appointment),
        other_participants=_other_first_names(appointment, client),
        can_cancel=cancelable,
        cancel_is_late=(
            cancelable
            and appointment.status == AppointmentStatus.SCHEDULED
            and _inside_window(appointment, practice.settings, now)
        ),
    )


def _own_place(
    db: Session, client: Client, appointment_id: int
) -> tuple[Appointment, AppointmentParticipant]:
    """An appointment the client takes part in, with their place in it; 404 otherwise."""
    appointment = db.get(Appointment, appointment_id)
    if appointment is None or appointment.kind != AppointmentKind.APPOINTMENT:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    participant = next((p for p in appointment.participants if p.client_id == client.id), None)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    return appointment, participant


@router.get("/booking", response_model=PortalBookingOptions)
def booking_options(client: CurrentClient, db: DbSession) -> PortalBookingOptions:
    """The clinicians on this client's care team they can book with, their services online,
    and the practice's offices."""
    _require_booking(client)
    clinicians = [
        PortalBookingClinician(
            id=clinician.id,
            name=clinician.display_name,
            time_zone=clinician.time_zone,
            services=[
                BookableService.model_validate(service)
                for service in db.scalars(bookable_services(clinician, new_clients=False))
            ],
        )
        for clinician in _care_team_clinicians(client)
    ]
    return PortalBookingOptions(
        clinicians=clinicians, locations=booking_locations(db, client.practice_id)
    )


@router.get("/booking/slots", response_model=list[SlotOut])
def booking_slots(
    client: CurrentClient,
    db: DbSession,
    clinician_id: int = Query(),
    service_id: int = Query(),
    start_date: date = Query(description="First local date (the clinician's time zone)"),
    end_date: date = Query(description="Last local date, inclusive; at most 31 days in all"),
) -> list[Slot]:
    """A care-team clinician's open times for a service; starts_at/ends_at are UTC."""
    check_range(start_date, end_date)
    clinician = _booking_clinician(client, clinician_id)
    service = _bookable_service(db, clinician, service_id)
    return available_slots(db, clinician, service, start_date, end_date, utcnow())


@router.post(
    "/booking/requests", response_model=PortalAppointmentOut, status_code=status.HTTP_201_CREATED
)
def request_appointment(
    body: PortalBookingRequest, client: CurrentClient, db: DbSession, request: Request
) -> PortalAppointmentOut:
    """Request an open time; it stays 'requested' until the practice accepts or declines."""
    clinician = _booking_clinician(client, body.clinician_id)
    service = _bookable_service(db, clinician, body.service_id)
    lock_schedule(db, clinician.id)
    now = utcnow()
    slot = find_open_slot(db, clinician, service, body.starts_at, body.location_type, now)
    if slot is None or live_busy_check(clinician.id, slot.starts_at, slot.ends_at):
        raise HTTPException(status.HTTP_409_CONFLICT, SLOT_TAKEN)
    appointment = build_request(
        db, clinician, client, service, slot, BookingSource.PORTAL, body.message
    )
    db.add(appointment)
    db.flush()
    appointment_changed(db, appointment)
    alert_staff_of_request(db, appointment, client, clinician)
    notify_request_received(
        db, appointment, clinician, addressees(client), client_zone(client, clinician)
    )
    audit_client(db, request, client, "appointment_request.create", "appointment", appointment.id)
    db.commit()
    return _portal_view(appointment, appointment.participants[0], client, now)


@router.get("/appointments", response_model=list[PortalAppointmentOut])
def list_appointments(
    client: CurrentClient,
    db: DbSession,
    request: Request,
    when: Literal["upcoming", "past"] = Query(default="upcoming"),
) -> list[PortalAppointmentOut]:
    """Upcoming (requested or scheduled, soonest first) or past appointments (newest first)."""
    now = utcnow()
    query = (
        select(Appointment, AppointmentParticipant)
        .join(AppointmentParticipant, AppointmentParticipant.appointment_id == Appointment.id)
        .where(
            AppointmentParticipant.client_id == client.id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
        )
        .options(selectinload(Appointment.clinician), selectinload(Appointment.location))
    )
    if when == "upcoming":
        query = query.where(
            Appointment.ends_at > now,
            Appointment.status.in_(UPCOMING_STATUSES),
            AppointmentParticipant.attendance.is_(None),
        ).order_by(Appointment.starts_at)
    else:
        query = (
            query.where(Appointment.ends_at <= now)
            .order_by(Appointment.starts_at.desc())
            .limit(PAST_LIMIT)
        )
    views = [_portal_view(a, p, client, now) for a, p in db.execute(query)]
    audit_client(db, request, client, "appointment.list", detail={"when": when})
    db.commit()
    return views


@router.post("/appointments/{appointment_id}/cancel", response_model=PortalAppointmentOut)
def cancel_appointment(
    appointment_id: int,
    body: PortalCancelRequest,
    client: CurrentClient,
    db: DbSession,
    request: Request,
) -> PortalAppointmentOut:
    """Cancel an individual session outside the practice's cancellation window, withdraw a
    pending request, or cancel the client's place in a couples, family or group session (a late
    cancellation inside the window). The clinician is told either way."""
    appointment, participant = _own_place(db, client, appointment_id)
    now = utcnow()
    if participant.attendance is not None or appointment.status not in UPCOMING_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This appointment can't be canceled")
    settings = client.practice.settings
    late = False
    if appointment.status == AppointmentStatus.SCHEDULED:
        window = settings.cancellation_window_hours
        if appointment.starts_at <= now:
            raise HTTPException(status.HTTP_409_CONFLICT, "This appointment has already started")
        if window == 0:
            raise HTTPException(status.HTTP_409_CONFLICT, "Please contact your practice to cancel")
        late = _inside_window(appointment, settings, now)
        if late and not _is_shared(appointment):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Please contact your practice to cancel within {_hours(window)} "
                "of your appointment",
            )
    if _is_shared(appointment):
        participant.attendance = (
            AppointmentStatus.LATE_CANCELED if late else AppointmentStatus.CANCELED
        )
    else:
        appointment.status = AppointmentStatus.CANCELED
        appointment.canceled_at = now
        appointment.canceled_by = Role.CLIENT
        appointment.cancel_reason = body.reason.strip()
    alert_clinician_of_cancellation(
        db, appointment, client, whole_session=not _is_shared(appointment)
    )
    appointment_changed(db, appointment)
    audit_client(
        db,
        request,
        client,
        "appointment.cancel",
        "appointment",
        appointment.id,
        {"late": late} if _is_shared(appointment) else None,
    )
    db.commit()
    return _portal_view(appointment, participant, client, now)
