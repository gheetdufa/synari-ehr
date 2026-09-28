"""The staff home screen: today's schedule and the work waiting on the signed-in person.

Everything is personal: my calendar, my notes, my conversations, and counts limited to the
clients I can reach. Staff who manage every calendar can switch today's schedule to the whole
practice with `scope=practice`.
"""

from datetime import datetime, time, timedelta
from enum import StrEnum

from fastapi import APIRouter, Request
from sqlalchemy import ColumnElement, Select, exists, func, select

from synari.access import Access, ClientAccess
from synari.api.appointments import appointment_views, visible_client_ids
from synari.audit import audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import Appointment, Client, ClientForm, Invoice, Note, WaitingRoomEntry
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    ClientFormStatus,
    ClientStatus,
    InvoiceStatus,
    NoteStatus,
    Role,
    WaitingStatus,
)
from synari.permissions import Capability
from synari.schemas.appointments import AppointmentOut
from synari.schemas.common import Schema
from synari.services.messaging import unread_by_conversation
from synari.services.note_records import part_of_record
from synari.services.notes import awaiting_cosign
from synari.services.notifications import unread_count
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

NOTE_BACKLOG_DAYS = 30
FLAGGED_FORM_DAYS = 14


class DashboardScope(StrEnum):
    """Whose appointments `today` lists."""

    MINE = "mine"
    PRACTICE = "practice"


class DashboardOut(Schema):
    scope: DashboardScope
    today: list[AppointmentOut]
    pending_requests: int
    unread_messages: int
    unread_notifications: int
    draft_notes: int
    # Supervisees' signed notes waiting for my co-signature.
    notes_awaiting_cosign: int
    appointments_missing_notes: int
    pending_forms: int
    flagged_forms: int
    waiting_room: int
    # Open invoice balances I may see: practice-wide with full billing access, my clients'
    # with billing access to my own clients, otherwise null.
    outstanding_cents: int | None
    client_count: int


def _today_bounds(access: Access, scope: DashboardScope) -> tuple[datetime, datetime]:
    """Start and end of today on my wall clock, or the practice's for the practice schedule."""
    clock = access.staff.practice if scope == DashboardScope.PRACTICE else access.staff
    zone = zone_of(clock)
    day_start = datetime.combine(utcnow().astimezone(zone).date(), time.min, tzinfo=zone)
    return day_start, day_start + timedelta(days=1)


def _clients(access: Access, level: ClientAccess) -> Select[tuple[int]]:
    """Ids of the clients I can reach at `level`."""
    return select(Client.id).where(access.client_filter(level))


def _outstanding(access: Access) -> int | None:
    if not (access.can(Capability.BILLING_ALL) or access.can(Capability.BILLING_OWN)):
        return None
    total = access.db.scalar(
        select(func.coalesce(func.sum(Invoice.total_cents - Invoice.paid_cents), 0)).where(
            Invoice.practice_id == access.practice_id,
            Invoice.status == InvoiceStatus.OPEN,
            Invoice.client_id.in_(_clients(access, ClientAccess.BILLING)),
        )
    )
    return int(total or 0)


@router.get("", response_model=DashboardOut)
def dashboard(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    scope: DashboardScope = DashboardScope.MINE,
) -> DashboardOut:
    """Today's appointments and the counts behind "needs your attention" for the signed-in person.

    `scope=practice` (for staff who manage every calendar) lists everyone's appointments today;
    the counts stay personal either way.
    """
    if scope == DashboardScope.PRACTICE:
        access.require(Capability.SCHEDULE_ALL, "You can only see your own calendar")
    me = access.staff.id
    now = utcnow()
    day_start, day_end = _today_bounds(access, scope)
    on_calendar: ColumnElement[bool] = (
        Appointment.practice_id == access.practice_id
        if scope == DashboardScope.PRACTICE
        else Appointment.clinician_id == me
    )
    today = list(
        db.scalars(
            select(Appointment)
            .where(
                on_calendar,
                Appointment.starts_at < day_end,
                Appointment.ends_at > day_start,
                Appointment.status.not_in((AppointmentStatus.CANCELED, AppointmentStatus.DECLINED)),
            )
            .order_by(Appointment.starts_at, Appointment.id)
        )
    )

    def count(query: Select[tuple[int]]) -> int:
        return int(db.scalar(select(func.count()).select_from(query.subquery())) or 0)

    requests = select(Appointment.id).where(
        Appointment.practice_id == access.practice_id,
        Appointment.status == AppointmentStatus.REQUESTED,
    )
    if not access.can(Capability.SCHEDULE_ALL):
        requests = requests.where(Appointment.clinician_id == me)
    mine_today = select(Appointment.id).where(
        Appointment.clinician_id == me,
        Appointment.starts_at < day_end,
        Appointment.ends_at > day_start,
    )
    missing_notes = select(Appointment.id).where(
        Appointment.clinician_id == me,
        Appointment.kind == AppointmentKind.APPOINTMENT,
        Appointment.status == AppointmentStatus.ATTENDED,
        # Imported history is documented in the notes that came with it.
        Appointment.source != BookingSource.IMPORT,
        Appointment.starts_at >= now - timedelta(days=NOTE_BACKLOG_DAYS),
        # A psychotherapy note is kept apart from the record, so it doesn't document the session.
        ~exists().where(
            Note.appointment_id == Appointment.id, Note.author_id == me, part_of_record()
        ),
    )
    # Like the calendar: clients this person can't reach are left out of the list.
    views = appointment_views(access, today)
    audit_staff_list(db, request, access.staff, "dashboard.view", visible_client_ids(views))
    db.commit()
    return DashboardOut(
        scope=scope,
        today=views,
        pending_requests=count(requests),
        unread_messages=sum(unread_by_conversation(db, me).values()),
        unread_notifications=unread_count(db, Role.STAFF, me),
        draft_notes=count(
            select(Note.id).where(Note.author_id == me, Note.status == NoteStatus.DRAFT)
        ),
        notes_awaiting_cosign=count(awaiting_cosign(access).with_only_columns(Note.id)),
        appointments_missing_notes=count(missing_notes),
        pending_forms=count(
            select(ClientForm.id).where(
                ClientForm.status == ClientFormStatus.PENDING,
                ClientForm.client_id.in_(_clients(access, ClientAccess.PROFILE)),
            )
        ),
        flagged_forms=count(
            select(ClientForm.id).where(
                ClientForm.flagged,
                ClientForm.completed_at >= now - timedelta(days=FLAGGED_FORM_DAYS),
                ClientForm.client_id.in_(_clients(access, ClientAccess.CLINICAL)),
            )
        ),
        waiting_room=count(
            select(WaitingRoomEntry.id).where(
                WaitingRoomEntry.appointment_id.in_(mine_today),
                WaitingRoomEntry.status == WaitingStatus.WAITING,
            )
        ),
        outstanding_cents=_outstanding(access),
        client_count=count(
            _clients(access, ClientAccess.PROFILE).where(Client.status != ClientStatus.ARCHIVED)
        ),
    )
