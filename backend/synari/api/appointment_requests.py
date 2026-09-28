"""Online appointment requests awaiting accept or decline. A request is always for one client.

Clinicians handle requests on their own calendar; staff who schedule for the whole practice
see and handle everyone's.
"""

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import exists, select
from sqlalchemy.orm import Session, selectinload

from synari.access import Access, ClientAccess
from synari.api.appointments import appointment_views, raise_conflict
from synari.audit import audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import Appointment, AppointmentParticipant, Client
from synari.models.enums import AppointmentStatus, ClientStatus, Role
from synari.permissions import Capability
from synari.schemas.appointments import AppointmentOut
from synari.schemas.booking import AppointmentRequestOut, DeclineRequest
from synari.services.appointment_notices import (
    notify_request_accepted,
    notify_request_declined,
    publish_calendar_change,
)
from synari.services.calendar_sync.hooks import appointment_changed
from synari.services.estimates import review_estimate_needs
from synari.services.notifications import notify
from synari.services.portal_links import send_portal_welcome
from synari.services.scheduling import ensure_on_care_team, find_client_conflicts, find_conflicts

router = APIRouter(prefix="/appointment-requests", tags=["appointment requests"])


def _pending_request(access: Access, appointment_id: int) -> tuple[Appointment, Client]:
    """A pending request on a calendar this person manages, for a client they can reach."""
    appointment = access.get(Appointment, appointment_id, label="Appointment request")
    client = appointment.participants[0].client if appointment.participants else None
    if client is None or not access.can_access_client(client, ClientAccess.PROFILE):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment request not found")
    access.require_calendar(appointment.clinician_id)
    if appointment.status != AppointmentStatus.REQUESTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request has already been handled")
    return appointment, client


def _has_other_appointments(db: Session, client: Client, appointment_id: int) -> bool:
    return bool(
        db.scalar(
            select(
                exists().where(
                    AppointmentParticipant.client_id == client.id,
                    AppointmentParticipant.appointment_id != appointment_id,
                )
            )
        )
    )


@router.get("", response_model=list[AppointmentRequestOut])
def list_requests(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    clinician_id: int | None = Query(
        default=None, description="Only this clinician's requests (default: all you handle)"
    ),
) -> list[Appointment]:
    """Pending requests with the requester's contact details, soonest first."""
    query = (
        select(Appointment)
        .join(AppointmentParticipant, AppointmentParticipant.appointment_id == Appointment.id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(
            Appointment.practice_id == access.practice_id,
            Appointment.status == AppointmentStatus.REQUESTED,
            access.client_filter(ClientAccess.PROFILE),
        )
    )
    if clinician_id is not None:
        access.require_calendar(clinician_id)
        query = query.where(Appointment.clinician_id == clinician_id)
    elif not access.can(Capability.SCHEDULE_ALL):
        query = query.where(Appointment.clinician_id == access.staff.id)
    pending = list(
        db.scalars(
            query.options(selectinload(Appointment.clinician)).order_by(Appointment.starts_at)
        )
    )
    audit_staff_list(
        db,
        request,
        access.staff,
        "appointment_request.list",
        (p.client_id for appointment in pending for p in appointment.participants),
    )
    db.commit()
    return pending


@router.post("/{appointment_id}/accept", response_model=AppointmentOut)
def accept_request(
    appointment_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    allow_conflicts: bool = Query(default=False),
) -> AppointmentOut:
    """Schedule the requested time, activate a new client and email them a confirmation."""
    appointment, client = _pending_request(access, appointment_id)
    clinician = appointment.clinician
    conflicts = (
        []
        if allow_conflicts
        else [
            c
            for c in find_conflicts(
                db, clinician.id, appointment.starts_at, appointment.ends_at, {appointment.id}
            )
            if c.status != AppointmentStatus.REQUESTED
        ]
    )
    if conflicts:
        client_conflicts = find_client_conflicts(
            db, [client.id], appointment.starts_at, appointment.ends_at, {appointment.id}
        )
        raise_conflict(
            access, conflicts, client_conflicts, "This time now overlaps another appointment"
        )

    appointment.status = AppointmentStatus.SCHEDULED
    if access.can_manage_care_team(client):
        ensure_on_care_team(client, clinician.id)
    newly_activated = client.status != ClientStatus.ACTIVE
    client.status = ClientStatus.ACTIVE
    review_estimate_needs(db, [appointment])
    notify_request_accepted(db, appointment, client, clinician)
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="appointment_accepted",
        title="Your appointment request was accepted",
        link="/client/appointments",
    )
    if newly_activated:
        send_portal_welcome(db, client)
    appointment_changed(db, appointment)
    publish_calendar_change(db, [appointment], "appointment.updated")
    audit_staff(
        db,
        request,
        access.staff,
        "appointment_request.accept",
        "appointment",
        appointment.id,
        {"client_activated": newly_activated},
        client_id=client.id,
    )
    db.commit()
    return appointment_views(access, [appointment])[0]


@router.post("/{appointment_id}/decline", response_model=AppointmentOut)
def decline_request(
    appointment_id: int,
    body: DeclineRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AppointmentOut:
    """Decline a request and email the requester; a brand-new prospective client is archived."""
    appointment, client = _pending_request(access, appointment_id)
    reason = body.reason.strip()
    appointment.status = AppointmentStatus.DECLINED
    appointment.canceled_at = utcnow()
    appointment.canceled_by = Role.STAFF
    appointment.cancel_reason = reason
    notify_request_declined(
        db, appointment, client, appointment.clinician, reason if body.include_reason else ""
    )
    archived = client.status == ClientStatus.PROSPECTIVE and not _has_other_appointments(
        db, client, appointment.id
    )
    if archived:
        # End every portal session for the client, including guardians signed in for them.
        client.status = ClientStatus.ARCHIVED
        client.portal_token_version += 1
        for contact in client.contacts:
            contact.portal_token_version += 1
    appointment_changed(db, appointment)
    publish_calendar_change(db, [appointment], "appointment.updated")
    audit_staff(
        db,
        request,
        access.staff,
        "appointment_request.decline",
        "appointment",
        appointment.id,
        {"client_archived": archived},
        client_id=client.id,
    )
    db.commit()
    return appointment_views(access, [appointment])[0]
