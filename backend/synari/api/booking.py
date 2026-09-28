"""Public booking page: new clients pick a clinician, see open times and request an appointment
(no sign-in)."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from synari.audit import audit_anonymous
from synari.db import utcnow
from synari.deps import DbSession
from synari.models import Client, ClientClinician, Location, Practice, Service, StaffMember
from synari.models.enums import BookingSource, ClientStatus, StaffStatus
from synari.ratelimit import rate_limit
from synari.schemas.booking import (
    BookingLocation,
    BookingPage,
    BookingRequestStatus,
    PricedService,
    PublicBookingClinician,
    PublicBookingRequest,
    SlotOut,
)
from synari.services.appointment_notices import (
    Addressee,
    alert_staff_of_request,
    client_zone,
    notify_request_received,
    one_line_address,
)
from synari.services.availability import (
    MAX_RANGE_DAYS,
    Slot,
    available_slots,
    bookable_services,
    build_request,
    find_open_slot,
    lock_schedule,
)
from synari.services.calendar_sync.busy import live_busy_check
from synari.services.calendar_sync.hooks import appointment_changed
from synari.services.scheduling import resolve_fee

router = APIRouter(prefix="/booking", tags=["booking"])

SLOT_TAKEN = "That time is no longer available. Please choose another time."
Slug = Annotated[str, Path(min_length=1, max_length=80)]


def check_range(start_date: date, end_date: date) -> None:
    """Reject reversed ranges and ranges longer than MAX_RANGE_DAYS."""
    if end_date < start_date or (end_date - start_date).days >= MAX_RANGE_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Choose a date range of up to {MAX_RANGE_DAYS} days",
        )


def booking_locations(db: Session, practice_id: int) -> list[BookingLocation]:
    """The practice's offices in use, so booking pages can say where each slot is."""
    locations = db.scalars(
        select(Location)
        .where(Location.practice_id == practice_id, Location.is_active)
        .order_by(Location.is_video, Location.name)
    )
    return [
        BookingLocation(id=location.id, name=location.name, address=one_line_address(location))
        for location in locations
    ]


def _booking_practice(db: Session, slug: str) -> Practice:
    """The practice behind a public booking page that is open to new clients; 404 otherwise."""
    practice = db.scalar(select(Practice).where(Practice.booking_slug == slug))
    if (
        practice is None
        or not practice.settings.booking_enabled
        or not practice.settings.booking_accepts_new_clients
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Booking page not found")
    return practice


def _new_client_clinicians(practice: Practice) -> Select[tuple[StaffMember]]:
    return select(StaffMember).where(
        StaffMember.practice_id == practice.id,
        StaffMember.status == StaffStatus.ACTIVE,
        StaffMember.is_clinician,
        StaffMember.accepting_new_clients,
    )


def _booking_clinician(db: Session, practice: Practice, clinician_id: int) -> StaffMember:
    clinician = db.scalar(_new_client_clinicians(practice).where(StaffMember.id == clinician_id))
    if clinician is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clinician not found")
    return clinician


def _new_client_service(db: Session, clinician: StaffMember, service_id: int) -> Service:
    service = db.scalar(
        bookable_services(clinician, new_clients=True).where(Service.id == service_id)
    )
    if service is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Service not found")
    return service


def _find_or_create_client(
    db: Session, clinician: StaffMember, body: PublicBookingRequest
) -> Client:
    """Reuse the practice's client with this email, else create a prospective client with the
    clinician as primary.

    An anonymous request never changes an existing client's care team: whoever accepts it
    decides whether the clinician should see the chart.
    """
    existing = db.scalar(
        select(Client).where(
            Client.practice_id == clinician.practice_id, func.lower(Client.email) == body.email
        )
    )
    if existing is not None:
        return existing
    client = Client(
        practice_id=clinician.practice_id,
        status=ClientStatus.PROSPECTIVE,
        first_name=body.first_name,
        last_name=body.last_name,
        date_of_birth=body.date_of_birth,
        email=body.email,
        phone=body.phone.strip(),
        care_team=[ClientClinician(staff_id=clinician.id, is_primary=True)],
    )
    db.add(client)
    db.flush()
    return client


@router.get(
    "/{slug}",
    response_model=BookingPage,
    dependencies=[Depends(rate_limit("booking-page", limit=60))],
)
def booking_page(
    slug: Slug,
    db: DbSession,
    clinician_id: int | None = Query(default=None, description="Show only this clinician"),
) -> BookingPage:
    """What the public booking page shows: the practice, and the clinicians taking new clients
    with the services each offers them."""
    practice = _booking_practice(db, slug)
    query = _new_client_clinicians(practice)
    if clinician_id is not None:
        query = query.where(StaffMember.id == clinician_id)
    clinicians: list[PublicBookingClinician] = []
    for clinician in db.scalars(query.order_by(StaffMember.last_name, StaffMember.first_name)):
        services = [
            PricedService(
                id=service.id,
                description=service.description,
                duration_minutes=service.duration_minutes,
                rate_cents=resolve_fee(db, service, None, clinician.id),
            )
            for service in db.scalars(bookable_services(clinician, new_clients=True))
        ]
        if services:
            clinicians.append(
                PublicBookingClinician(
                    id=clinician.id,
                    name=clinician.display_name,
                    time_zone=clinician.time_zone,
                    services=services,
                )
            )
    return BookingPage(
        practice_name=practice.name,
        intro=practice.settings.booking_intro,
        time_zone=practice.time_zone,
        clinicians=clinicians,
        locations=booking_locations(db, practice.id),
        gfe_notice=practice.settings.gfe_enabled,
    )


@router.get(
    "/{slug}/slots",
    response_model=list[SlotOut],
    dependencies=[Depends(rate_limit("booking-slots", limit=60))],
)
def booking_slots(
    slug: Slug,
    db: DbSession,
    clinician_id: int = Query(),
    service_id: int = Query(),
    start_date: date = Query(description="First local date (the clinician's time zone)"),
    end_date: date = Query(description="Last local date, inclusive; at most 31 days in all"),
) -> list[Slot]:
    """A clinician's open times for a service; starts_at/ends_at are UTC."""
    check_range(start_date, end_date)
    practice = _booking_practice(db, slug)
    clinician = _booking_clinician(db, practice, clinician_id)
    service = _new_client_service(db, clinician, service_id)
    return available_slots(db, clinician, service, start_date, end_date, utcnow())


@router.post(
    "/{slug}/requests",
    response_model=BookingRequestStatus,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(rate_limit("booking-request", limit=10, window_seconds=600))],
)
def request_appointment(
    slug: Slug, body: PublicBookingRequest, db: DbSession, request: Request
) -> BookingRequestStatus:
    """Ask a clinician for an open time. They (or the practice's schedulers) accept or decline;
    the requester is emailed."""
    practice = _booking_practice(db, slug)
    if body.website:
        return BookingRequestStatus()
    clinician = _booking_clinician(db, practice, body.clinician_id)
    service = _new_client_service(db, clinician, body.service_id)
    lock_schedule(db, clinician.id)
    slot = find_open_slot(db, clinician, service, body.starts_at, body.location_type, utcnow())
    if slot is None or live_busy_check(clinician.id, slot.starts_at, slot.ends_at):
        raise HTTPException(status.HTTP_409_CONFLICT, SLOT_TAKEN)
    client = _find_or_create_client(db, clinician, body)
    appointment = build_request(
        db, clinician, client, service, slot, BookingSource.PUBLIC, body.message
    )
    db.add(appointment)
    db.flush()
    appointment_changed(db, appointment)
    alert_staff_of_request(db, appointment, client, clinician)
    requester = Addressee(body.email, body.first_name, "your", "requester")
    notify_request_received(db, appointment, clinician, [requester], client_zone(client, clinician))
    audit_anonymous(
        db,
        request,
        "appointment_request.create",
        practice_id=practice.id,
        detail={"appointment_id": appointment.id},
        client_id=client.id,
    )
    db.commit()
    return BookingRequestStatus()
