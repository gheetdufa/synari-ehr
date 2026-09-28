"""Good Faith Estimates (No Surprises Act, 45 CFR 149.610) for self-pay and uninsured clients.

Who needs one: clients billed as self-pay, in practices with estimates turned on. They get an
estimate when they schedule (due 1 business day after scheduling for a session at least 3
business days out, 3 business days for one at least 10 out; nothing for a session sooner) or
ask for one (due in 3 business days). When the care changes (a higher fee, a new service, more
visits than estimated, or sessions after the estimate's period) a replacement is due 1
business day before the next session.

A need is kept as the pair's open draft (one per client and clinician) with its reason and due
date: scheduling hooks, portal requests and scope changes create or bring forward that draft,
prefilled from the upcoming sessions, and tell the clinician and billing staff. The work queue
also shows upcoming sessions no issued estimate covers, so a need is never lost.

An issued estimate covers a session when the session's date falls in its period, one of its
items has the session's service code at a unit fee no lower than the session's, and the
session is within the item's quantity (visits counted in date order). Issued estimates never
change: a replacement supersedes them when it's issued.
"""

from collections import Counter, defaultdict
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, Integer, Select, any_, literal, select, true, tuple_
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import InstrumentedAttribute, selectinload
from sqlalchemy.orm import Session as DbSession

from synari.access import ClientAccess
from synari.db import utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AppointmentSeries,
    Client,
    GoodFaithEstimate,
    GoodFaithEstimateItem,
    Location,
    Practice,
    Service,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BillingProviderType,
    BillingType,
    BookingSource,
    ClientStatus,
    GoodFaithEstimateStatus,
    LocationType,
    RecurrenceFrequency,
    Role,
)
from synari.schemas.estimates import (
    DIAGNOSIS_LETTERS,
    MAX_DIAGNOSES,
    EstimateDiagnosis,
    EstimateDraftIn,
    EstimateItemIn,
    EstimateProvider,
    SeparatelyScheduledItem,
)
from synari.services.appointment_notices import one_line_address
from synari.services.billing import (
    address_lines,
    effective_status,
    local_date,
    local_midnight,
    lock_client,
)
from synari.services.business_days import add_business_days, business_days_between
from synari.services.notifications import notify, short_name
from synari.services.recipients import staff_with_client_access
from synari.services.scheduling import clinician_offers, resolve_fee, zone_of

REASON_SCHEDULING = "scheduling"
REASON_REQUEST = "request"
REASON_UPDATE = "update"
REASON_MANUAL = "manual"

SCHEDULING_MIN_LEAD_DAYS = 3  # business days out before scheduling triggers an estimate
SCHEDULING_LONG_LEAD_DAYS = 10
MAX_PERIOD_MONTHS = 12
# How far ahead scheduled sessions are considered.
SESSION_HORIZON = timedelta(days=400)
MAX_SCHEDULED_DATES = 400
# Sessions that count as visits against an estimate's quantity.
COUNTED_STATUSES = (AppointmentStatus.SCHEDULED, AppointmentStatus.ATTENDED)
DEFAULT_SERVICE_DESCRIPTION = "Psychotherapy session"
PROVIDER_TYPE = "Behavioral health clinician"
CLIENT_ESTIMATES_PATH = "/client/documents"
ESTIMATES_QUEUE_PATH = "/portal/billing?tab=estimates"


def staff_estimates_path(client_id: int) -> str:
    """Where staff work on a client's estimates in the app."""
    return f"/portal/clients/{client_id}?tab=estimates"


def short_date(day: date) -> str:
    """e.g. 'Oct 2'."""
    return f"{day:%b} {day.day}"


# Deadlines ---------------------------------------------------------------------------------


def scheduling_due_date(scheduled_on: date, service_on: date) -> date | None:
    """When an estimate is due for a session scheduled on `scheduled_on`: 3 business days
    later for a session at least 10 business days out, 1 business day later for one at least 3
    out, and none for anything sooner."""
    lead = business_days_between(scheduled_on, service_on)
    if lead >= SCHEDULING_LONG_LEAD_DAYS:
        return add_business_days(scheduled_on, 3)
    if lead >= SCHEDULING_MIN_LEAD_DAYS:
        return add_business_days(scheduled_on, 1)
    return None


def request_due_date(requested_on: date) -> date:
    """An estimate the client asked for is due within 3 business days."""
    return add_business_days(requested_on, 3)


def update_due_date(next_session_on: date) -> date:
    """A replacement estimate is due 1 business day before the next session."""
    return add_business_days(next_session_on, -1)


def max_period_end(period_start: date) -> date:
    """The last day an estimate starting on `period_start` may cover (12 months)."""
    try:
        anniversary = period_start.replace(year=period_start.year + 1)
    except ValueError:  # February 29
        anniversary = date(period_start.year + 1, 3, 1)
    return anniversary - timedelta(days=1)


# Who needs one -----------------------------------------------------------------------------


def estimates_enabled(practice: Practice) -> bool:
    return practice.settings.gfe_enabled


def needs_estimates(client: Client) -> bool:
    """Self-pay clients (uninsured, or not using insurance) of practices with estimates on."""
    return (
        client.billing_type == BillingType.SELF_PAY
        and client.status != ClientStatus.ARCHIVED
        and estimates_enabled(client.practice)
    )


def missing_client_fields(client: Client) -> list[str]:
    """Client details an estimate must show before it can be issued."""
    return [] if client.date_of_birth else ["date of birth"]


# Totals ------------------------------------------------------------------------------------


def apply_totals(estimate: GoodFaithEstimate) -> None:
    """Recompute each item's total (unit fee x quantity) and the estimate's total."""
    for item in estimate.items:
        item.total_cents = item.unit_fee_cents * item.quantity
    estimate.total_cents = sum(item.total_cents for item in estimate.items)


def set_items(estimate: GoodFaithEstimate, items: Iterable[EstimateItemIn]) -> None:
    """Replace a draft's items and recompute its totals."""
    estimate.items = [
        GoodFaithEstimateItem(
            description=item.description.strip(),
            service_code=item.service_code.strip().upper(),
            location=item.location.strip(),
            diagnosis_pointers=item.diagnosis_pointers,
            unit_fee_cents=item.unit_fee_cents,
            quantity=item.quantity,
            frequency=item.frequency.strip(),
            total_cents=item.unit_fee_cents * item.quantity,
        )
        for item in items
    ]
    apply_totals(estimate)


def apply_draft(estimate: GoodFaithEstimate, data: EstimateDraftIn) -> None:
    """Copy a draft's editable fields onto the estimate."""
    estimate.clinician_id = data.clinician_id
    estimate.period_start = data.period_start
    estimate.period_end = data.period_end
    estimate.primary_service = data.primary_service.strip()
    estimate.scheduled_dates = [day.isoformat() for day in sorted(set(data.scheduled_dates))]
    estimate.diagnosis_codes = [
        {"code": d.code.strip().upper(), "description": d.description.strip()}
        for d in data.diagnosis_codes
    ]
    estimate.separately_scheduled = [
        {
            "description": s.description.strip(),
            "provider": s.provider.strip(),
            "note": s.note.strip(),
        }
        for s in data.separately_scheduled
    ]
    estimate.notes = data.notes.strip()
    estimate.change_summary = data.change_summary.strip()
    if data.due_on != estimate.due_on:
        estimate.overdue_notified_at = None
    estimate.due_on = data.due_on
    set_items(estimate, data.items)


def draft_input(estimate: GoodFaithEstimate) -> EstimateDraftIn:
    """An estimate's editable fields, e.g. to copy them into a replacement."""
    return EstimateDraftIn(
        clinician_id=estimate.clinician_id,
        period_start=estimate.period_start,
        period_end=estimate.period_end,
        primary_service=estimate.primary_service,
        scheduled_dates=[date.fromisoformat(day) for day in estimate.scheduled_dates],
        diagnosis_codes=[EstimateDiagnosis.model_validate(d) for d in estimate.diagnosis_codes],
        items=[
            EstimateItemIn(
                description=item.description,
                service_code=item.service_code,
                location=item.location,
                diagnosis_pointers=item.diagnosis_pointers,
                unit_fee_cents=item.unit_fee_cents,
                quantity=item.quantity,
                frequency=item.frequency,
            )
            for item in estimate.items
        ],
        separately_scheduled=[
            SeparatelyScheduledItem.model_validate(s) for s in estimate.separately_scheduled
        ],
        notes=estimate.notes,
        change_summary=estimate.change_summary,
        due_on=estimate.due_on,
    )


# Provider ----------------------------------------------------------------------------------


def location_label(location: Location) -> str:
    """How an office appears on an estimate: its name and address."""
    if location.is_video:
        return "Telehealth (video)"
    address = one_line_address(location)
    return f"{location.name}, {address}" if address else location.name


def practice_locations(db: DbSession, practice: Practice) -> list[str]:
    """The practice's active offices, else its own address."""
    offices = db.scalars(
        select(Location)
        .where(Location.practice_id == practice.id, Location.is_active)
        .order_by(Location.is_video, Location.name)
    ).all()
    labels = [location_label(office) for office in offices]
    if not any(not office.is_video for office in offices) and (
        address := one_line_address(practice)
    ):
        labels.insert(0, address)
    return labels


def provider_snapshot(
    db: DbSession, practice: Practice, clinician: StaffMember
) -> EstimateProvider:
    """The convening provider as the estimate prints it: the clinician, the practice's address,
    tax ID and states, and the NPI claims use (the clinician's, or the group's)."""
    group = practice.billing_provider == BillingProviderType.ORGANIZATION
    offices = db.scalars(
        select(Location).where(
            Location.practice_id == practice.id, Location.is_active, ~Location.is_video
        )
    ).all()
    states = {practice.state, clinician.license_state, *(office.state for office in offices)}
    credentials = clinician.credentials.strip()
    return EstimateProvider(
        name=clinician.full_name,
        credentials=credentials,
        type=f"{PROVIDER_TYPE} ({credentials})" if credentials else PROVIDER_TYPE,
        practice_name=practice.name,
        address_lines=address_lines(
            practice.address_line1,
            practice.address_line2,
            practice.city,
            practice.state,
            practice.postal_code,
        ),
        contact=clinician.display_name,
        phone=clinician.phone or practice.phone,
        email=clinician.email,
        npi=practice.npi if group else clinician.npi,
        npi_kind="group" if group else "individual",
        tin=practice.tax_id,
        tin_type=practice.tax_id_type,
        states=sorted(state.strip() for state in states if state and state.strip()),
        locations=practice_locations(db, practice),
    )


def missing_provider_fields(practice: Practice, provider: EstimateProvider) -> list[str]:
    """Provider identifiers an estimate must show before it can be issued, each saying where
    it's entered (shown after "Add ")."""
    missing = []
    if not provider.npi:
        missing.append(
            "the practice's group NPI in Settings → Practice"
            if provider.npi_kind == "group"
            else "the clinician's NPI to their profile (Settings → Team, or My profile)"
        )
    if not provider.tin:
        missing.append("the practice's tax ID in Settings → Practice")
    if not (practice.address_line1 and practice.city and practice.state):
        missing.append("the practice's street address in Settings → Practice")
    return missing


# Sessions and coverage ---------------------------------------------------------------------


@dataclass(frozen=True)
class EstimatedSession:
    """One billed client's session with a clinician, as estimates see it."""

    participant_id: int
    starts_at: datetime
    service_on: date  # the practice's calendar date
    scheduled_on: date  # when it was put on the calendar
    status: str
    service_code: str
    description: str
    fee_cents: int
    frequency: str
    location: str


def _frequency_label(series: AppointmentSeries | None) -> str:
    if series is None:
        return ""
    if series.frequency == RecurrenceFrequency.MONTHLY:
        return "Monthly" if series.interval == 1 else f"Every {series.interval} months"
    return "Weekly" if series.interval == 1 else f"Every {series.interval} weeks"


def _session_location(appointment: Appointment, practice: Practice) -> str:
    if appointment.location_type == LocationType.VIDEO:
        return "Telehealth (video)"
    if appointment.location_type == LocationType.PHONE:
        return "Telephone"
    if appointment.location is not None and not appointment.location.is_video:
        return location_label(appointment.location)
    return one_line_address(practice)


def _session_query(
    practice_id: int,
) -> Select[tuple[AppointmentParticipant, Appointment, AppointmentSeries | None]]:
    """Billed sessions (scheduled or attended) of the practice, oldest first; imported history
    never counts."""
    return (
        select(AppointmentParticipant, Appointment, AppointmentSeries)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .outerjoin(AppointmentSeries, AppointmentSeries.id == Appointment.series_id)
        .where(
            Appointment.practice_id == practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.source != BookingSource.IMPORT,
            AppointmentParticipant.billable,
            effective_status().in_(COUNTED_STATUSES),
        )
        .options(selectinload(Appointment.location))
        .order_by(Appointment.starts_at, Appointment.id)
    )


def _estimated_session(
    participant: AppointmentParticipant,
    appointment: Appointment,
    series: AppointmentSeries | None,
    practice: Practice,
    zone: ZoneInfo,
) -> EstimatedSession:
    return EstimatedSession(
        participant_id=participant.id,
        starts_at=appointment.starts_at,
        service_on=local_date(appointment.starts_at, zone),
        scheduled_on=local_date(appointment.created_at, zone),
        status=participant.effective_status,
        service_code=appointment.service_code.strip().upper(),
        description=appointment.service_description or DEFAULT_SERVICE_DESCRIPTION,
        fee_cents=participant.fee_cents,
        frequency=_frequency_label(series),
        location=_session_location(appointment, practice),
    )


def load_sessions(
    db: DbSession, client: Client, clinician_id: int, since: datetime, until: datetime
) -> list[EstimatedSession]:
    """The client's billed sessions with the clinician (scheduled or attended) starting in
    [since, until), oldest first. Imported history never counts."""
    db.flush()
    practice = client.practice
    zone = zone_of(practice)
    rows = db.execute(
        _session_query(client.practice_id).where(
            Appointment.clinician_id == clinician_id,
            Appointment.starts_at >= since,
            Appointment.starts_at < until,
            AppointmentParticipant.client_id == client.id,
        )
    ).all()
    return [
        _estimated_session(participant, appointment, series, practice, zone)
        for participant, appointment, series in rows
    ]


def _matching_items(
    estimate: GoodFaithEstimate, service_code: str, fee_cents: int
) -> list[GoodFaithEstimateItem]:
    """Items of the estimate for this service code (any, when the session has none) whose unit
    fee is at least the session's fee."""
    code = service_code.strip().upper()
    return [
        item
        for item in estimate.items
        if (not code or item.service_code.strip().upper() == code)
        and fee_cents <= item.unit_fee_cents
    ]


def estimate_covers(
    estimate: GoodFaithEstimate,
    *,
    service_on: date,
    service_code: str,
    fee_cents: int,
    visit_number: int,
) -> bool:
    """Whether an issued estimate covers the `visit_number`-th session with this service code
    in its period, on `service_on` at `fee_cents`."""
    if estimate.status != GoodFaithEstimateStatus.ISSUED:
        return False
    if not estimate.period_start <= service_on <= estimate.period_end:
        return False
    items = _matching_items(estimate, service_code, fee_cents)
    return bool(items) and visit_number <= sum(item.quantity for item in items)


def covered_participant_ids(
    estimates: Iterable[GoodFaithEstimate], sessions: Iterable[EstimatedSession]
) -> set[int]:
    """The sessions at least one of the estimates covers. Visits are counted per service code
    in date order within each estimate's period."""
    ordered = sorted(sessions, key=lambda session: session.starts_at)
    covered: set[int] = set()
    for estimate in estimates:
        visits: Counter[str] = Counter()
        for session in ordered:
            if not estimate.period_start <= session.service_on <= estimate.period_end:
                continue
            visits[session.service_code] += 1
            if estimate_covers(
                estimate,
                service_on=session.service_on,
                service_code=session.service_code,
                fee_cents=session.fee_cents,
                visit_number=visits[session.service_code],
            ):
                covered.add(session.participant_id)
    return covered


def issued_estimates(db: DbSession, client_id: int, clinician_id: int) -> list[GoodFaithEstimate]:
    """The pair's issued (current) estimates, newest first."""
    return list(
        db.scalars(
            select(GoodFaithEstimate)
            .where(
                GoodFaithEstimate.client_id == client_id,
                GoodFaithEstimate.clinician_id == clinician_id,
                GoodFaithEstimate.status == GoodFaithEstimateStatus.ISSUED,
            )
            .order_by(GoodFaithEstimate.issued_at.desc(), GoodFaithEstimate.id.desc())
        )
    )


def issued_estimates_for(
    db: DbSession, pairs: Collection[tuple[int, int]]
) -> dict[tuple[int, int], list[GoodFaithEstimate]]:
    """Issued estimates (with their items) of each (client, clinician) pair, newest first."""
    if not pairs:
        return {}
    found: dict[tuple[int, int], list[GoodFaithEstimate]] = defaultdict(list)
    for estimate in db.scalars(
        select(GoodFaithEstimate)
        .where(
            tuple_(GoodFaithEstimate.client_id, GoodFaithEstimate.clinician_id).in_(list(pairs)),
            GoodFaithEstimate.status == GoodFaithEstimateStatus.ISSUED,
        )
        .options(selectinload(GoodFaithEstimate.items))
        .order_by(GoodFaithEstimate.issued_at.desc(), GoodFaithEstimate.id.desc())
    ):
        found[(estimate.client_id, estimate.clinician_id)].append(estimate)
    return found


def open_draft(db: DbSession, client_id: int, clinician_id: int) -> GoodFaithEstimate | None:
    """The pair's draft in progress (there's at most one)."""
    db.flush()
    return db.scalar(
        select(GoodFaithEstimate)
        .where(
            GoodFaithEstimate.client_id == client_id,
            GoodFaithEstimate.clinician_id == clinician_id,
            GoodFaithEstimate.status == GoodFaithEstimateStatus.DRAFT,
        )
        .order_by(GoodFaithEstimate.id.desc())
        .limit(1)
    )


@dataclass
class PairState:
    """A client's sessions with one clinician and the estimates that cover them."""

    sessions: list[EstimatedSession]
    issued: list[GoodFaithEstimate]
    uncovered: list[EstimatedSession]  # upcoming scheduled sessions no issued estimate covers


def _history_start(issued: Iterable[GoodFaithEstimate], now: datetime, zone: ZoneInfo) -> datetime:
    """Where a pair's sessions start to count: the start of its earliest issued estimate (so
    earlier visits count against quantities), or now."""
    return min([now, *(local_midnight(estimate.period_start, zone) for estimate in issued)])


def _state_of(
    issued: list[GoodFaithEstimate], sessions: list[EstimatedSession], now: datetime
) -> PairState:
    covered = covered_participant_ids(issued, sessions)
    uncovered = [
        session
        for session in sessions
        if session.starts_at >= now
        and session.status == AppointmentStatus.SCHEDULED
        and session.participant_id not in covered
    ]
    return PairState(sessions, issued, uncovered)


def pair_state(db: DbSession, client: Client, clinician_id: int, now: datetime) -> PairState:
    """Load the pair's sessions from the start of its earliest issued estimate through the
    horizon, and find the uncovered ones."""
    issued = issued_estimates(db, client.id, clinician_id)
    since = _history_start(issued, now, zone_of(client.practice))
    sessions = load_sessions(db, client, clinician_id, since, now + SESSION_HORIZON)
    return _state_of(issued, sessions, now)


def needed_by(
    state: PairState, today: date, *, scheduled_on: date | None
) -> tuple[str, date] | None:
    """The reason and due date for the pair's uncovered sessions, or None if nothing is due.

    With an issued estimate the care changed: a replacement is due before the next session.
    Otherwise sessions were scheduled: each is due by the scheduling rule, counted from
    `scheduled_on` (else when each session was put on the calendar).
    """
    if not state.uncovered:
        return None
    if state.issued:
        return REASON_UPDATE, update_due_date(state.uncovered[0].service_on)
    dues = [
        due
        for session in state.uncovered
        if (due := scheduling_due_date(scheduled_on or session.scheduled_on, session.service_on))
        is not None
    ]
    return (REASON_SCHEDULING, min(dues)) if dues else None


# Suggested drafts --------------------------------------------------------------------------


def _item_for_group(sessions: list[EstimatedSession], pointers: list[str]) -> EstimateItemIn:
    first = sessions[0]
    frequencies = Counter(session.frequency for session in sessions if session.frequency)
    locations = Counter(session.location for session in sessions if session.location)
    return EstimateItemIn(
        description=first.description,
        service_code=first.service_code,
        location=locations.most_common(1)[0][0] if locations else "",
        diagnosis_pointers=pointers,
        unit_fee_cents=max(session.fee_cents for session in sessions),
        quantity=len(sessions),
        frequency=frequencies.most_common(1)[0][0] if frequencies else "",
    )


def suggested_draft(
    client: Client,
    clinician_id: int,
    state: PairState,
    today: date,
    *,
    based_on: GoodFaithEstimate | None = None,
) -> EstimateDraftIn:
    """A draft for the pair: the replaced estimate (if any) brought up to date with the
    scheduled sessions, else one item per service from the sessions in the next 12 months."""
    if based_on is not None:
        base = draft_input(based_on)
        base.change_summary = ""
        base.due_on = None
        if any(session.service_on > base.period_end for session in state.uncovered):
            base.period_start, base.period_end = today, max_period_end(today)
    else:
        diagnoses = [
            EstimateDiagnosis(
                code=str(d["code"])[:20], description=str(d.get("description", ""))[:300]
            )
            for d in client.diagnosis_codes[:MAX_DIAGNOSES]
            if d.get("code")
        ]
        base = EstimateDraftIn(
            clinician_id=clinician_id,
            period_start=today,
            period_end=max_period_end(today),
            primary_service=DEFAULT_SERVICE_DESCRIPTION,
            diagnosis_codes=diagnoses,
        )
    in_period = [
        session
        for session in state.sessions
        if base.period_start <= session.service_on <= base.period_end
    ]
    groups: dict[str, list[EstimatedSession]] = {}
    for session in in_period:
        groups.setdefault(session.service_code, []).append(session)
    pointers = list(DIAGNOSIS_LETTERS[: min(1, len(base.diagnosis_codes))])
    items = list(base.items)
    for code, sessions in groups.items():
        suggested = _item_for_group(sessions, pointers)
        existing = next((item for item in items if item.service_code == code), None)
        if existing is None:
            items.append(suggested)
            continue
        existing.unit_fee_cents = max(existing.unit_fee_cents, suggested.unit_fee_cents)
        existing.quantity = max(existing.quantity, suggested.quantity)
    base.items = items
    if based_on is None and items:
        first = items[0]
        base.primary_service = (
            f"{first.description} ({first.service_code})"
            if first.service_code
            else first.description
        )[:300]
    upcoming = sorted({session.service_on for session in in_period if session.service_on >= today})
    base.scheduled_dates = upcoming[:MAX_SCHEDULED_DATES]
    return base


def suggest_for(
    db: DbSession, client: Client, clinician_id: int, now: datetime
) -> EstimateDraftIn | None:
    """A draft prefilled from the pair's upcoming sessions (None when there are none)."""
    state = pair_state(db, client, clinician_id, now)
    if not any(session.starts_at >= now for session in state.sessions):
        return None
    today = local_date(now, zone_of(client.practice))
    based_on = state.issued[0] if state.issued else None
    return suggested_draft(client, clinician_id, state, today, based_on=based_on)


def new_draft(
    client: Client,
    data: EstimateDraftIn,
    *,
    reason: str,
    supersedes_id: int | None = None,
) -> GoodFaithEstimate:
    """A draft estimate for the client from the given fields (the caller adds it)."""
    estimate = GoodFaithEstimate(
        practice_id=client.practice_id,
        client_id=client.id,
        status=GoodFaithEstimateStatus.DRAFT,
        reason=reason,
        supersedes_id=supersedes_id,
        delivery_method="portal",
    )
    apply_draft(estimate, data)
    return estimate


# Needs: hooks, requests and notifications --------------------------------------------------


def estimate_staff(db: DbSession, client: Client, clinician_id: int) -> list[StaffMember]:
    """Who hears about a client's estimates: the clinician and staff who handle their billing."""
    members = {
        member.id: member for member in staff_with_client_access(db, client, ClientAccess.BILLING)
    }
    clinician = db.get(StaffMember, clinician_id)
    if (
        clinician is not None
        and clinician.is_active
        and clinician.practice_id == client.practice_id
    ):
        members.setdefault(clinician.id, clinician)
    return list(members.values())


def notify_estimate_staff(
    db: DbSession, client: Client, clinician_id: int, *, kind: str, title: str, urgent: bool = False
) -> None:
    """An in-app notification (content-free) for everyone who hears about the pair's estimates,
    linking to the client's estimates."""
    for member in estimate_staff(db, client, clinician_id):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind=kind,
            title=title,
            link=staff_estimates_path(client.id),
            urgent=urgent,
        )


def _ensure_draft(
    db: DbSession,
    client: Client,
    clinician_id: int,
    *,
    reason: str,
    due_on: date,
    state: PairState,
    today: date,
) -> tuple[GoodFaithEstimate, bool]:
    """The pair's open draft, created (prefilled) or with its due date brought forward.

    Returns the draft and whether it's new or now due sooner. The caller holds the client lock.
    """
    draft = open_draft(db, client.id, clinician_id)
    if draft is not None:
        if draft.due_on is not None and draft.due_on <= due_on:
            return draft, False
        if draft.due_on is None:
            draft.reason = reason
        draft.due_on = due_on
        draft.overdue_notified_at = None
        return draft, True
    based_on = state.issued[0] if state.issued else None
    data = suggested_draft(client, clinician_id, state, today, based_on=based_on)
    data.due_on = due_on
    draft = new_draft(
        client, data, reason=reason, supersedes_id=based_on.id if based_on is not None else None
    )
    db.add(draft)
    db.flush()
    return draft, True


def flag_estimate_need(
    db: DbSession, client: Client, clinician_id: int, now: datetime
) -> GoodFaithEstimate | None:
    """Record that the client needs a (new) estimate from the clinician, if they do.

    Upcoming sessions no issued estimate covers make the pair's draft due: by the scheduling
    rule counted from today, or 1 business day before the next session when an issued
    estimate no longer covers the care. The clinician and billing staff are told when the
    draft is new or due sooner. Returns the draft, or None when nothing is needed.
    """
    if not needs_estimates(client):
        return None
    lock_client(db, client.id)
    today = local_date(now, zone_of(client.practice))
    state = pair_state(db, client, clinician_id, now)
    needed = needed_by(state, today, scheduled_on=today)
    if needed is None:
        return None
    reason, due_on = needed
    draft, changed = _ensure_draft(
        db, client, clinician_id, reason=reason, due_on=due_on, state=state, today=today
    )
    if changed:
        what = (
            "An updated good faith estimate" if reason == REASON_UPDATE else "A good faith estimate"
        )
        notify_estimate_staff(
            db,
            client,
            clinician_id,
            kind="estimate_needed",
            title=f"{what} for {short_name(client)} is due {short_date(due_on)}",
        )
    return draft


def review_estimate_needs(
    db: DbSession, appointments: Iterable[Appointment], now: datetime | None = None
) -> None:
    """Scheduling hook: after sessions are booked, accepted, moved or repriced, flag the
    estimates their self-pay clients now need (see flag_estimate_need)."""
    moment = now or utcnow()
    pairs = sorted(
        {
            (participant.client_id, appointment.clinician_id)
            for appointment in appointments
            if appointment.kind == AppointmentKind.APPOINTMENT
            and appointment.status == AppointmentStatus.SCHEDULED
            and appointment.source != BookingSource.IMPORT
            for participant in appointment.participants
            if participant.billable
        }
    )
    if not pairs:
        return
    db.flush()
    for client_id, clinician_id in pairs:
        client = db.get(Client, client_id)
        if client is not None:
            flag_estimate_need(db, client, clinician_id, moment)


def request_estimate(
    db: DbSession, client: Client, clinician: StaffMember, now: datetime
) -> GoodFaithEstimate:
    """The client asked for a cost estimate: the pair's draft is due within 3 business days
    (created, prefilled, if needed) and the clinician and billing staff are told."""
    lock_client(db, client.id)
    today = local_date(now, zone_of(client.practice))
    due_on = request_due_date(today)
    state = pair_state(db, client, clinician.id, now)
    draft, _ = _ensure_draft(
        db, client, clinician.id, reason=REASON_REQUEST, due_on=due_on, state=state, today=today
    )
    notify_estimate_staff(
        db,
        client,
        clinician.id,
        kind="estimate_requested",
        title=(
            f"{short_name(client)} asked for a good faith estimate "
            f"(due {short_date(draft.due_on or due_on)})"
        ),
    )
    return draft


# Work queue --------------------------------------------------------------------------------


@dataclass
class EstimateNeed:
    """A client and clinician who need a (new) estimate."""

    client: Client
    clinician_id: int
    reason: str
    due_on: date | None
    estimate_id: int | None
    uncovered_sessions: int
    next_session_at: datetime | None


def _any_of(column: InstrumentedAttribute[int], ids: Iterable[int]) -> ColumnElement[bool]:
    """`column = ANY(:ids)`: one array parameter however many ids there are."""
    return column == any_(literal(sorted(ids), ARRAY(Integer)))


def _pair_states(
    db: DbSession, practice: Practice, pairs: set[tuple[int, int]], now: datetime
) -> dict[tuple[int, int], PairState]:
    """Every pair's state with a fixed number of queries: issued estimates, then the sessions
    from now through the horizon plus, for pairs with an issued estimate, their earlier ones."""
    zone = zone_of(practice)
    issued = issued_estimates_for(db, pairs)
    since = {pair: _history_start(issued.get(pair, []), now, zone) for pair in pairs}
    with_history = [pair for pair in pairs if since[pair] < now]
    window = Appointment.starts_at >= now
    if with_history:
        history_clients = sorted({client_id for client_id, _ in with_history})
        window |= AppointmentParticipant.client_id.in_(history_clients) & (
            Appointment.starts_at >= min(since[pair] for pair in with_history)
        )
    client_ids = {client_id for client_id, _ in pairs}
    sessions: dict[tuple[int, int], list[EstimatedSession]] = defaultdict(list)
    for participant, appointment, series in db.execute(
        _session_query(practice.id).where(
            _any_of(AppointmentParticipant.client_id, client_ids),
            Appointment.starts_at < now + SESSION_HORIZON,
            window,
        )
    ):
        pair = (participant.client_id, appointment.clinician_id)
        if pair in since and appointment.starts_at >= since[pair]:
            sessions[pair].append(
                _estimated_session(participant, appointment, series, practice, zone)
            )
    return {pair: _state_of(issued.get(pair, []), sessions[pair], now) for pair in pairs}


def estimate_needs(
    db: DbSession,
    practice: Practice,
    now: datetime,
    clients: ColumnElement[bool] | None = None,
) -> list[EstimateNeed]:
    """Open drafts plus upcoming sessions of self-pay clients no issued estimate covers, one
    row per client and clinician, soonest due first. `clients` limits which clients (a
    condition on Client, e.g. the ones the viewer can reach)."""
    if not estimates_enabled(practice):
        return []
    db.flush()
    reachable = clients if clients is not None else true()
    today = local_date(now, zone_of(practice))
    drafts: dict[tuple[int, int], GoodFaithEstimate] = {}
    for draft in db.scalars(
        select(GoodFaithEstimate)
        .join(Client, Client.id == GoodFaithEstimate.client_id)
        .where(
            GoodFaithEstimate.practice_id == practice.id,
            GoodFaithEstimate.status == GoodFaithEstimateStatus.DRAFT,
            reachable,
        )
        .order_by(GoodFaithEstimate.id)
    ):
        drafts[(draft.client_id, draft.clinician_id)] = draft
    upcoming_pairs = db.execute(
        select(AppointmentParticipant.client_id, Appointment.clinician_id)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(
            Appointment.practice_id == practice.id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.source != BookingSource.IMPORT,
            Appointment.starts_at >= now,
            Appointment.starts_at < now + SESSION_HORIZON,
            AppointmentParticipant.billable,
            effective_status() == AppointmentStatus.SCHEDULED,
            Client.billing_type == BillingType.SELF_PAY,
            Client.status != ClientStatus.ARCHIVED,
            reachable,
        )
        .distinct()
    ).all()
    pairs = {(client_id, clinician_id) for client_id, clinician_id in upcoming_pairs} | set(drafts)
    if not pairs:
        return []
    states = _pair_states(db, practice, pairs, now)
    by_id = {
        client.id: client
        for client in db.scalars(
            select(Client).where(_any_of(Client.id, {client_id for client_id, _ in pairs}))
        )
    }
    needs: list[EstimateNeed] = []
    for (client_id, clinician_id), state in states.items():
        draft = drafts.get((client_id, clinician_id))
        needed = needed_by(state, today, scheduled_on=None)
        if draft is None and needed is None:
            continue
        reason, due_on = needed if needed is not None else (REASON_MANUAL, None)
        if draft is not None:
            reason = draft.reason
            due_on = draft.due_on or due_on
        needs.append(
            EstimateNeed(
                client=by_id[client_id],
                clinician_id=clinician_id,
                reason=reason,
                due_on=due_on,
                estimate_id=draft.id if draft is not None else None,
                uncovered_sessions=len(state.uncovered),
                next_session_at=state.uncovered[0].starts_at if state.uncovered else None,
            )
        )
    far = date.max
    return sorted(
        needs,
        key=lambda need: (
            need.due_on or far,
            need.next_session_at or datetime.max.replace(tzinfo=now.tzinfo),
            need.client.id,
        ),
    )


def service_options(
    db: DbSession, practice_id: int, clinician_id: int
) -> list[tuple[Service, int]]:
    """The practice's active services a clinician offers, with the clinician's rate."""
    services = db.scalars(
        select(Service)
        .where(Service.practice_id == practice_id, Service.is_active)
        .order_by(Service.code, Service.description)
    ).all()
    return [
        (service, resolve_fee(db, service, None, clinician_id))
        for service in services
        if clinician_offers(db, clinician_id, service.id)
    ]
