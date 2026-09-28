"""Invoices, payment allocation, refunds, client credit, saved cards and superbills.

Billing is practice-wide: invoice and superbill numbers count per practice, billing days
follow the practice's time zone, and one invoice can hold sessions with different clinicians.
Sessions are billed per appointment participant: a couples or family session bills only its
identified patient, a group session bills each member. Invoices are addressed to the client's
billing contact (e.g. a minor's parent) when they have one. Changes are pushed to the client
and to staff who can see the client's billing.

Amounts are integer cents. Every change to a client's invoices or payments happens while
holding a row lock on the client (`lock_client`), so concurrent payments, refunds and
webhooks can't interleave their allocations. When the practice settings row is needed too
(for invoice and superbill numbers) it is locked first: settings, then client.

The session is created with autoflush off, so helpers that query flush pending changes
first and reload locked rows with populate_existing.
"""

import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ColumnElement,
    Date,
    ScalarSelect,
    Select,
    and_,
    case,
    cast,
    exists,
    func,
    null,
    or_,
    select,
)
from sqlalchemy.orm import InstrumentedAttribute, Session, aliased
from sqlalchemy.orm.util import AliasedClass

from synari.access import ClientAccess
from synari.config import settings
from synari.db import utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AuditEvent,
    Client,
    ClientContact,
    InsurancePolicy,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentAllocation,
    PracticeSettings,
    SavedCard,
    StaffMember,
)
from synari.models.enums import (
    BILLABLE_APPOINTMENT_STATUSES,
    RECEIVED_PAYMENT_STATUSES,
    AppointmentKind,
    AppointmentStatus,
    BillingProviderType,
    BillingType,
    BookingSource,
    InvoiceItemKind,
    InvoiceStatus,
    LocationType,
    PaymentMethod,
    PaymentStatus,
    Role,
    TaxIdType,
)
from synari.realtime import publish
from synari.schemas.billing import (
    SuperbillClient,
    SuperbillData,
    SuperbillDiagnosis,
    SuperbillInsurance,
    SuperbillLine,
    SuperbillPayment,
    SuperbillPractice,
    SuperbillProvider,
)
from synari.services import payments
from synari.services.email_templates import render_email
from synari.services.notifications import notify, short_name
from synari.services.outbox import queue_email
from synari.services.portal_links import queue_portal_email
from synari.services.recipients import client_team_recipients, staff_with_client_access
from synari.services.scheduling import zone_of

logger = logging.getLogger(__name__)

# Stripe's smallest USD charge.
MIN_CARD_CHARGE_CENTS = 50
EVENT_BILLING_CHANGED = "billing.changed"
CLIENT_BILLING_PATH = "/client/billing"
DEFAULT_LINE_DESCRIPTION = "Session"
FEE_DESCRIPTIONS = {
    AppointmentStatus.NO_SHOW: "Missed appointment fee",
    AppointmentStatus.LATE_CANCELED: "Late cancellation fee",
}
PAYMENT_METHOD_LABELS = {
    PaymentMethod.CARD: "Card",
    PaymentMethod.CASH: "Cash",
    PaymentMethod.CHECK: "Check",
    PaymentMethod.EXTERNAL_CARD: "Card (external)",
    PaymentMethod.OTHER: "Other",
}
PLACE_OF_SERVICE_TELEHEALTH = "02"
PLACE_OF_SERVICE_OFFICE = "11"
PRIMARY_POLICY = "primary"
SUBSCRIBER_SELF = "18"
# X12 patient-to-subscriber relationship codes, as printed on superbills.
SUBSCRIBER_RELATIONSHIPS = {
    SUBSCRIBER_SELF: "Self",
    "01": "Spouse",
    "19": "Child",
    "20": "Employee",
    "21": "Unknown",
    "53": "Life partner",
    "G8": "Other",
}
CARD_NEEDS_CLIENT_MESSAGE = (
    "This card needs the client to approve the payment. Ask them to pay from their portal."
)


def format_money(cents: int) -> str:
    """Cents as dollars, e.g. 123456 -> '$1,234.56'."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def local_date(moment: datetime, zone: ZoneInfo) -> date:
    """The calendar date of a UTC instant in the given time zone."""
    return moment.astimezone(zone).date()


def local_midnight(day: date, zone: ZoneInfo) -> datetime:
    """The UTC instant a local calendar day starts."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


def card_label(brand: str, last4: str) -> str:
    """How a card is shown on payments, e.g. 'Visa ending 4242'."""
    return f"{brand.title()} ending {last4}" if last4 else "Card"


# Locks -------------------------------------------------------------------------------------


def lock_client(db: Session, client_id: int) -> Client:
    """Lock the client's row until the transaction ends and return it freshly loaded."""
    db.flush()
    return db.scalars(
        select(Client)
        .where(Client.id == client_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()


def lock_practice_settings(db: Session, practice_id: int) -> PracticeSettings:
    """Lock the practice settings row (it holds the invoice and superbill counters)."""
    db.flush()
    return db.scalars(
        select(PracticeSettings)
        .where(PracticeSettings.practice_id == practice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()


# Events, emails and audit ------------------------------------------------------------------


def billing_changed(db: Session, client: Client) -> None:
    """Tell the client's open apps, and those of staff who see their billing, to refetch it."""
    recipients = [
        *client_team_recipients(db, client, ClientAccess.BILLING),
        (Role.CLIENT, client.id),
    ]
    publish(db, recipients, EVENT_BILLING_CHANGED, {"client_id": client.id})


def staff_billing_link(client: Client) -> str:
    """Where staff review a client's billing in the app."""
    return f"/portal/clients/{client.id}?tab=billing"


def audit_system(
    db: Session,
    practice_id: int,
    action: str,
    resource_type: str,
    resource_id: int | None,
    detail: dict[str, Any] | None = None,
    *,
    client_id: int | None = None,
) -> None:
    """Record a change made by the worker or a verified Stripe webhook to a client's record."""
    db.add(
        AuditEvent(
            practice_id=practice_id,
            client_id=client_id,
            actor_role="system",
            actor_id=None,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            detail=detail,
        )
    )


def _portal_sign_in_url() -> str:
    """The portal's sign-in page, continuing to billing (contacts request a link there)."""
    query = urlencode({"next": CLIENT_BILLING_PATH})
    return f"{settings.frontend_url.rstrip('/')}/client/sign-in?{query}"


def queue_billing_email(
    db: Session,
    client: Client,
    *,
    subject: str,
    heading: str,
    message: str,
    portal_hint: str,
    dedupe_key: str,
) -> None:
    """Email a content-free billing notice to whoever pays the client's bills.

    That's the client's billing contact (e.g. a minor's parent) when they have an email, and
    the client too unless they're a minor. The client gets a sign-in button to portal billing;
    a contact with portal access gets a button to the portal's sign-in page, and a contact
    without it is asked to contact the practice. Nothing is sent when portal billing is off
    for the client.
    """
    if not client.portal_billing:
        return
    practice_name = client.practice.name
    contact = client.billing_contact
    if contact is not None and contact.email:
        with_portal = contact.portal_access and client.can_use_portal
        closing = portal_hint if with_portal else f"Contact {practice_name} for a copy."
        content = render_email(
            subject=subject,
            heading=heading,
            paragraphs=[message, closing],
            sender_name=practice_name,
            button_label="View billing" if with_portal else None,
            button_url=_portal_sign_in_url() if with_portal else None,
        )
        queue_email(
            db,
            to=contact.email,
            content=content,
            practice_id=client.practice_id,
            dedupe_key=f"{dedupe_key}:contact-{contact.id}",
        )
    if not client.is_minor:
        queue_portal_email(
            db,
            client,
            subject=subject,
            heading=heading,
            paragraphs=[message, portal_hint],
            button_label="View billing",
            next_path=CLIENT_BILLING_PATH,
            dedupe_key=dedupe_key,
        )


def notify_new_invoice(db: Session, client: Client, invoice_id: int) -> None:
    """Tell the client in the portal, and whoever pays their bills by email, about an invoice."""
    if not client.portal_billing:
        return
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="invoice_created",
        title="A new invoice is available",
        link=CLIENT_BILLING_PATH,
    )
    practice_name = client.practice.name
    queue_billing_email(
        db,
        client,
        subject=f"New invoice from {practice_name}",
        heading="A new invoice is available",
        message=f"{practice_name} added a new invoice to the client portal.",
        portal_hint="Sign in to view it.",
        dedupe_key=f"invoice-created:{invoice_id}",
    )


def send_payment_receipt(db: Session, client: Client, payment_id: int) -> None:
    """Email whoever pays the client's bills a content-free receipt notice."""
    queue_billing_email(
        db,
        client,
        subject="We received your payment",
        heading="We received your payment",
        message=f"Thank you. {client.practice.name} received your payment.",
        portal_hint="You can see the payment history in the client portal.",
        dedupe_key=f"payment-receipt:{payment_id}",
    )


# Queries -----------------------------------------------------------------------------------


def effective_status() -> ColumnElement[str]:
    """SQL for a participant's attendance: their own, else the session's status.

    For queries that join Appointment to AppointmentParticipant.
    """
    return func.coalesce(AppointmentParticipant.attendance, Appointment.status)


def effective_status_in(statuses: Iterable[AppointmentStatus]) -> ColumnElement[bool]:
    """SQL: the participant's attendance (their own, else the session's status) is one of
    `statuses`.

    Spelled out rather than coalesced so Postgres can estimate it from column statistics and
    plan joins over a practice's whole history well. For queries that join Appointment to
    AppointmentParticipant.
    """
    values = list(statuses)
    return or_(
        AppointmentParticipant.attendance.in_(values),
        and_(AppointmentParticipant.attendance.is_(None), Appointment.status.in_(values)),
    )


def service_billed(participant_id: InstrumentedAttribute[int] | int) -> ColumnElement[bool]:
    """SQL: the session's service line is on an invoice that isn't void."""
    return exists().where(
        InvoiceItem.participant_id == participant_id,
        InvoiceItem.kind == InvoiceItemKind.SERVICE,
        InvoiceItem.invoice_id == Invoice.id,
        Invoice.status != InvoiceStatus.VOID,
    )


def billable_statuses(practice_settings: PracticeSettings) -> tuple[AppointmentStatus, ...]:
    """Statuses that generate a charge under this practice's settings."""
    if practice_settings.bill_missed_appointments:
        return BILLABLE_APPOINTMENT_STATUSES
    return (AppointmentStatus.ATTENDED,)


def uninvoiced_participants(
    practice_id: int, statuses: tuple[AppointmentStatus, ...], ended_before: datetime
) -> Select[tuple[AppointmentParticipant]]:
    """Billed clients of sessions that ended before the cutoff and aren't on a live invoice.

    Only participants who are billable, whose attendance is one of the statuses and who have
    a fee or an amount owed; imported history is never invoiced. The query joins Appointment.
    An insurance client's copay can still make what they owe zero (see `owed_cents_sql`).
    """
    return (
        select(AppointmentParticipant)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .where(
            Appointment.practice_id == practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.source != BookingSource.IMPORT,
            Appointment.ends_at < ended_before,
            AppointmentParticipant.billable,
            or_(
                AppointmentParticipant.client_owes_cents > 0,
                and_(
                    AppointmentParticipant.client_owes_cents.is_(None),
                    AppointmentParticipant.fee_cents > 0,
                ),
            ),
            effective_status_in(statuses),
            ~service_billed(AppointmentParticipant.id),
        )
    )


def is_on_active_invoice(db: Session, participant_id: int) -> bool:
    """Whether the session is already billed on an invoice that isn't void."""
    return bool(db.scalar(select(service_billed(participant_id))))


def _allocated_cents() -> ColumnElement[int]:
    return (
        select(func.coalesce(func.sum(PaymentAllocation.amount_cents), 0))
        .where(PaymentAllocation.payment_id == Payment.id)
        .correlate(Payment)
        .scalar_subquery()
    )


def _unapplied_cents() -> ColumnElement[int]:
    return Payment.amount_cents - Payment.refunded_cents - _allocated_cents()


def client_balance_cents(db: Session, client_id: int, *, include_disputed: bool = True) -> int:
    """What the client owes on open invoices (without disputed ones, for collecting)."""
    db.flush()
    query = select(func.coalesce(func.sum(Invoice.total_cents - Invoice.paid_cents), 0)).where(
        Invoice.client_id == client_id, Invoice.status == InvoiceStatus.OPEN
    )
    if not include_disputed:
        query = query.where(Invoice.disputed_at.is_(None))
    total = db.scalar(query)
    return int(total or 0)


def client_credit_cents(db: Session, client_id: int) -> int:
    """Money the client paid that isn't applied to any invoice."""
    db.flush()
    total = db.scalar(
        select(func.coalesce(func.sum(_unapplied_cents()), 0)).where(
            Payment.client_id == client_id, Payment.status.in_(RECEIVED_PAYMENT_STATUSES)
        )
    )
    return int(total or 0)


def open_invoices(db: Session, client_id: int) -> list[Invoice]:
    """The client's open invoices, oldest first."""
    db.flush()
    return list(
        db.scalars(
            select(Invoice)
            .where(Invoice.client_id == client_id, Invoice.status == InvoiceStatus.OPEN)
            .order_by(Invoice.issued_on, Invoice.id)
            .execution_options(populate_existing=True)
        )
    )


def client_cards(db: Session, client_id: int) -> list[SavedCard]:
    """The client's saved cards, default first, then newest."""
    return list(
        db.scalars(
            select(SavedCard)
            .where(SavedCard.client_id == client_id)
            .order_by(SavedCard.is_default.desc(), SavedCard.id.desc())
        )
    )


def default_card(db: Session, client_id: int) -> SavedCard | None:
    """The card used for AutoPay and quick charges."""
    return db.scalar(
        select(SavedCard).where(SavedCard.client_id == client_id, SavedCard.is_default)
    )


def line_clinicians(db: Session, invoices: Iterable[Invoice]) -> dict[int, StaffMember]:
    """The clinicians recorded on these invoices' lines, by id."""
    clinician_ids = {
        item.clinician_id
        for invoice in invoices
        for item in invoice.items
        if item.clinician_id is not None
    }
    if not clinician_ids:
        return {}
    found = db.scalars(select(StaffMember).where(StaffMember.id.in_(clinician_ids)))
    return {clinician.id: clinician for clinician in found}


def line_appointments(db: Session, invoices: Iterable[Invoice]) -> dict[int, int]:
    """The appointment of each session on these invoices: appointment id by participant id."""
    participant_ids = {
        item.participant_id
        for invoice in invoices
        for item in invoice.items
        if item.participant_id is not None
    }
    if not participant_ids:
        return {}
    rows = db.execute(
        select(AppointmentParticipant.id, AppointmentParticipant.appointment_id).where(
            AppointmentParticipant.id.in_(participant_ids)
        )
    ).all()
    return {participant_id: appointment_id for participant_id, appointment_id in rows}


def bill_to_contacts(db: Session, invoices: Iterable[Invoice]) -> dict[int, ClientContact]:
    """The contacts these invoices are addressed to, by id."""
    contact_ids = {
        invoice.bill_to_contact_id for invoice in invoices if invoice.bill_to_contact_id is not None
    }
    if not contact_ids:
        return {}
    found = db.scalars(select(ClientContact).where(ClientContact.id.in_(contact_ids)))
    return {contact.id: contact for contact in found}


# What clients owe --------------------------------------------------------------------------


def policy_in_effect(
    policy: type[InsurancePolicy] | AliasedClass[InsurancePolicy],
    client_id: ColumnElement[int] | int,
    rank: str,
    first_day: ColumnElement[date] | date,
    last_day: ColumnElement[date] | date,
) -> list[ColumnElement[bool]]:
    """SQL conditions: `policy` is the client's policy of `rank` in effect on any day of the
    period (open-ended dates count as covered)."""
    return [
        policy.client_id == client_id,
        policy.rank == rank,
        or_(policy.effective_date.is_(None), policy.effective_date <= last_day),
        or_(policy.termination_date.is_(None), policy.termination_date >= first_day),
    ]


def primary_policy(
    db: Session, client_id: int, first_day: date, last_day: date | None = None
) -> InsurancePolicy | None:
    """The client's primary insurance policy in effect on any day from first_day to last_day."""
    return db.scalar(
        select(InsurancePolicy)
        .where(
            *policy_in_effect(
                InsurancePolicy, client_id, PRIMARY_POLICY, first_day, last_day or first_day
            )
        )
        .order_by(InsurancePolicy.id)
        .limit(1)
    )


def session_day_sql(zone: ZoneInfo) -> ColumnElement[date]:
    """SQL: the calendar day in `zone` an appointment starts on."""
    return cast(func.timezone(zone.key, Appointment.starts_at), Date)


def session_policy_sql[T](
    column: Callable[[AliasedClass[InsurancePolicy]], InstrumentedAttribute[T]],
    rank: str,
    zone: ZoneInfo,
) -> ScalarSelect[T]:
    """SQL: a column of the participant's policy of `rank` that covered the session's day in
    `zone` (the first one added, if several did); NULL when none did.

    For queries joining AppointmentParticipant and Appointment.
    """
    policy = aliased(InsurancePolicy)
    day = session_day_sql(zone)
    return (
        select(column(policy))
        .where(*policy_in_effect(policy, AppointmentParticipant.client_id, rank, day, day))
        .order_by(policy.id)
        .limit(1)
        .scalar_subquery()
    )


def copay_cents_sql(zone: ZoneInfo) -> ColumnElement[int | None]:
    """SQL: an insurance client's copay for a session, under the primary policy in effect on
    the session's day in `zone`; NULL when there is none.

    Missed sessions (no-show, late cancel) aren't covered by insurance, so they have no copay:
    the client owes the missed-session fee. For queries joining AppointmentParticipant,
    Appointment and Client.
    """
    covered = and_(
        Client.billing_type == BillingType.INSURANCE,
        effective_status() == AppointmentStatus.ATTENDED,
    )
    copay = session_policy_sql(lambda policy: policy.copay_cents, PRIMARY_POLICY, zone)
    return case((covered, copay), else_=null())


def owed_cents_sql(zone: ZoneInfo) -> ColumnElement[int]:
    """SQL: what the client owes for a session: what's recorded, else an insurance client's
    copay (copay_cents_sql), else the session fee.

    For queries joining AppointmentParticipant, Appointment and Client.
    """
    return func.coalesce(
        AppointmentParticipant.client_owes_cents,
        copay_cents_sql(zone),
        AppointmentParticipant.fee_cents,
    )


def _session_value[T](
    db: Session, participant: AppointmentParticipant, value: ColumnElement[T]
) -> T | None:
    """Evaluate a session expression (e.g. owed_cents_sql) for one participant."""
    db.flush()
    return db.scalar(
        select(value)
        .select_from(AppointmentParticipant)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(AppointmentParticipant.id == participant.id)
    )


def client_share_cents(db: Session, participant: AppointmentParticipant) -> int:
    """What the client owes for a session, as invoice_amount_for but without recording it."""
    zone = zone_of(participant.client.practice)
    return _session_value(db, participant, owed_cents_sql(zone)) or 0


def invoice_amount_for(db: Session, participant: AppointmentParticipant) -> int:
    """What to bill the client for one session.

    What the client owes when it's recorded; else, for an insurance client whose primary policy
    in effect that day has a copay, the copay (recorded as what they owe, so later policy
    changes don't alter this session); else the session fee. The caller commits.
    """
    if participant.client_owes_cents is None:
        zone = zone_of(participant.client.practice)
        participant.client_owes_cents = _session_value(db, participant, copay_cents_sql(zone))
    return participant.amount_due_cents


# Invoices ----------------------------------------------------------------------------------


def service_line(db: Session, participant: AppointmentParticipant, zone: ZoneInfo) -> InvoiceItem:
    """The invoice line for one client's session, dated in the practice's time zone.

    It records the session's clinician and bills what the client owes (invoice_amount_for).
    """
    appointment = participant.appointment
    description = FEE_DESCRIPTIONS.get(
        AppointmentStatus(participant.effective_status),
        appointment.service_description or DEFAULT_LINE_DESCRIPTION,
    )
    return InvoiceItem(
        kind=InvoiceItemKind.SERVICE,
        participant_id=participant.id,
        clinician_id=appointment.clinician_id,
        service_date=local_date(appointment.starts_at, zone),
        service_code=appointment.service_code,
        description=description,
        amount_cents=invoice_amount_for(db, participant),
    )


def create_invoice(
    db: Session,
    practice_settings: PracticeSettings,
    client: Client,
    items: list[InvoiceItem],
    issued_on: date,
    notes: str = "",
) -> Invoice:
    """Number and add an invoice, addressed to the client's billing contact if they have one.

    The caller holds the practice settings and client locks.
    """
    practice_settings.invoice_counter += 1
    contact = client.billing_contact
    invoice = Invoice(
        practice_id=practice_settings.practice_id,
        client_id=client.id,
        number=f"INV-{practice_settings.invoice_counter:06d}",
        issued_on=issued_on,
        due_on=issued_on + timedelta(days=practice_settings.invoice_due_days),
        status=InvoiceStatus.OPEN,
        total_cents=sum(item.amount_cents for item in items),
        paid_cents=0,
        notes=notes,
        bill_to_contact_id=contact.id if contact is not None else None,
        items=items,
    )
    db.add(invoice)
    db.flush()
    return invoice


def _allocations_to(db: Session, invoice_id: int) -> list[tuple[Payment, PaymentAllocation]]:
    """The payment allocations to an invoice, with their payments, newest first."""
    paying = db.scalars(
        select(Payment)
        .where(
            Payment.id.in_(
                select(PaymentAllocation.payment_id).where(
                    PaymentAllocation.invoice_id == invoice_id
                )
            )
        )
        .execution_options(populate_existing=True)
    ).all()
    return sorted(
        (
            (payment, allocation)
            for payment in paying
            for allocation in payment.allocations
            if allocation.invoice_id == invoice_id
        ),
        key=lambda pair: pair[1].id,
        reverse=True,
    )


def release_overpayment(db: Session, invoice: Invoice) -> None:
    """Take back the newest payment allocations beyond the invoice's total; settle its status.

    Released money stays on its payment as the client's credit. The caller holds the client lock.
    """
    excess = invoice.paid_cents - invoice.total_cents
    if excess > 0:
        for payment, allocation in _allocations_to(db, invoice.id):
            amount = min(excess, allocation.amount_cents)
            allocation.amount_cents -= amount
            if allocation.amount_cents == 0:
                payment.allocations.remove(allocation)
            invoice.paid_cents -= amount
            excess -= amount
            if excess == 0:
                break
    invoice.status = InvoiceStatus.PAID if invoice.balance_cents == 0 else InvoiceStatus.OPEN


def _session_lines(db: Session, participant_id: int) -> list[InvoiceItem]:
    """A session's lines (its service line and adjustments) on invoices that aren't void."""
    return list(
        db.scalars(
            select(InvoiceItem)
            .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
            .where(
                InvoiceItem.participant_id == participant_id,
                Invoice.status != InvoiceStatus.VOID,
            )
            .order_by(InvoiceItem.id)
        )
    )


def _adjustment(service: InvoiceItem, amount_cents: int, description: str) -> InvoiceItem:
    """An adjustment line for the session of a service line."""
    return InvoiceItem(
        kind=InvoiceItemKind.ADJUSTMENT,
        participant_id=service.participant_id,
        clinician_id=service.clinician_id,
        service_date=service.service_date,
        service_code=service.service_code,
        description=description,
        amount_cents=amount_cents,
    )


def _credit_session(
    db: Session, lines: list[InvoiceItem], service: InvoiceItem, amount_cents: int, description: str
) -> None:
    """Take amount_cents off a session's invoices with negative adjustment lines.

    The session's original invoice comes first, then the invoices of its earlier adjustments,
    newest first; no invoice drops below zero. Payment beyond an invoice's new total is
    released to the client's credit.
    """
    others = sorted({line.invoice_id for line in lines} - {service.invoice_id}, reverse=True)
    remaining = amount_cents
    for invoice_id in [service.invoice_id, *others]:
        invoice = db.get_one(Invoice, invoice_id, populate_existing=True)
        amount = min(remaining, invoice.total_cents)
        if amount <= 0:
            continue
        invoice.items.append(_adjustment(service, -amount, description))
        invoice.total_cents -= amount
        release_overpayment(db, invoice)
        remaining -= amount
        if remaining == 0:
            return


def record_patient_responsibility(
    db: Session, participant: AppointmentParticipant, amount_cents: int, *, description: str
) -> None:
    """Record that the insurer says the client owes amount_cents for a session; bill the change.

    Sets what the client owes. If the session is already on a live invoice and what it was
    billed so far (its service line plus earlier adjustments) differs, the difference is billed
    as an adjustment line with this description: an increase on a new open invoice for the
    client, a decrease on the session's original invoice. Payment beyond an invoice's new total
    becomes the client's credit, which then pays their other open invoices. A session not yet
    invoiced is billed the new amount when it is; calling again with the same amount changes
    nothing. Takes the practice settings lock, then the client's (so callers mustn't hold the
    client lock without the settings lock); the caller commits.
    """
    client = participant.client
    practice_settings = lock_practice_settings(db, client.practice_id)
    lock_client(db, client.id)
    participant.client_owes_cents = amount_cents
    lines = _session_lines(db, participant.id)
    service = next((line for line in lines if line.kind == InvoiceItemKind.SERVICE), None)
    if service is None:
        return
    difference = amount_cents - sum(line.amount_cents for line in lines)
    if difference == 0:
        return
    if difference > 0:
        today = local_date(utcnow(), zone_of(client.practice))
        invoice = create_invoice(
            db, practice_settings, client, [_adjustment(service, difference, description)], today
        )
        audit_system(
            db,
            client.practice_id,
            "invoice.adjustment_create",
            "invoice",
            invoice.id,
            {"participant_id": participant.id},
            client_id=client.id,
        )
        apply_client_credit(db, client.id)
        notify_new_invoice(db, client, invoice.id)
    else:
        _credit_session(db, lines, service, -difference, description)
        apply_client_credit(db, client.id)
    billing_changed(db, client)


# Payments ----------------------------------------------------------------------------------


def allocate_payment(
    db: Session, payment: Payment, preferred_invoice_id: int | None = None
) -> None:
    """Apply the payment's unapplied amount to open invoices: the preferred one, then oldest.

    Disputed invoices only get money paid toward them specifically (the preferred invoice).
    Whatever is left over stays on the payment as client credit.
    """
    remaining = payment.unapplied_cents
    if remaining <= 0:
        return
    invoices = [
        invoice
        for invoice in open_invoices(db, payment.client_id)
        if invoice.disputed_at is None or invoice.id == preferred_invoice_id
    ]
    invoices.sort(key=lambda invoice: invoice.id != preferred_invoice_id)
    for invoice in invoices:
        amount = min(remaining, invoice.balance_cents)
        if amount <= 0:
            continue
        payment.allocations.append(PaymentAllocation(invoice_id=invoice.id, amount_cents=amount))
        invoice.paid_cents += amount
        if invoice.balance_cents == 0:
            invoice.status = InvoiceStatus.PAID
        remaining -= amount
        if remaining == 0:
            return


def apply_client_credit(db: Session, client_id: int) -> None:
    """Use the client's unapplied payments to pay their open invoices, oldest money first."""
    db.flush()
    with_credit = db.scalars(
        select(Payment)
        .where(
            Payment.client_id == client_id,
            Payment.status.in_(RECEIVED_PAYMENT_STATUSES),
            _unapplied_cents() > 0,
        )
        .order_by(Payment.received_at, Payment.id)
        .execution_options(populate_existing=True)
    ).all()
    for payment in with_credit:
        allocate_payment(db, payment)


def mark_payment_received(
    db: Session, payment: Payment, preferred_invoice_id: int | None = None
) -> None:
    """Mark a payment succeeded and allocate it. The caller holds the client lock."""
    payment.status = PaymentStatus.SUCCEEDED
    payment.failure_reason = ""
    payment.received_at = payment.received_at or utcnow()
    allocate_payment(db, payment, preferred_invoice_id)


def apply_refund(db: Session, payment: Payment, amount_cents: int) -> None:
    """Record a refund of up to the refundable amount. The caller holds the client lock.

    The refund comes out of the payment's unapplied credit first, then out of its most recent
    allocations, which reopens those invoices. Other credit is then reapplied.
    """
    db.flush()
    invoices = {
        invoice.id: invoice
        for invoice in db.scalars(
            select(Invoice)
            .where(Invoice.id.in_([a.invoice_id for a in payment.allocations]))
            .execution_options(populate_existing=True)
        )
    }
    from_allocations = max(0, amount_cents - payment.unapplied_cents)
    for allocation in sorted(payment.allocations, key=lambda a: a.id, reverse=True):
        if from_allocations == 0:
            break
        amount = min(from_allocations, allocation.amount_cents)
        invoice = invoices[allocation.invoice_id]
        invoice.paid_cents -= amount
        if invoice.status == InvoiceStatus.PAID:
            invoice.status = InvoiceStatus.OPEN
        allocation.amount_cents -= amount
        if allocation.amount_cents == 0:
            payment.allocations.remove(allocation)
        from_allocations -= amount
    payment.refunded_cents += amount_cents
    payment.status = (
        PaymentStatus.REFUNDED
        if payment.refunded_cents >= payment.amount_cents
        else PaymentStatus.PARTIALLY_REFUNDED
    )
    apply_client_credit(db, payment.client_id)


# Stripe: customers, cards and charges ------------------------------------------------------


def ensure_stripe_customer(db: Session, client: Client) -> str:
    """The client's Stripe Customer id, creating the customer on first use.

    Commits right away (under the client lock) so a later failure can't orphan the customer
    and two requests can't create two customers.
    """
    if client.stripe_customer_id:
        return client.stripe_customer_id
    locked = lock_client(db, client.id)
    payer = locked.billing_contact
    customer_id = locked.stripe_customer_id or payments.create_customer(
        name=payer.full_name if payer else locked.full_name,
        # Receipts go to whoever pays: a minor's parent rather than the minor.
        email=payer.email if payer else locked.email,
        metadata={"client_id": str(locked.id), "practice_id": str(locked.practice_id)},
    )
    locked.stripe_customer_id = customer_id
    db.commit()
    return customer_id


def save_card(db: Session, client: Client, card: payments.CardDetails) -> SavedCard:
    """Store a card saved in Stripe; the client's first card becomes the default."""
    lock_client(db, client.id)
    existing = db.scalar(
        select(SavedCard).where(SavedCard.stripe_payment_method_id == card.payment_method_id)
    )
    if existing is not None:
        return existing
    has_default = db.scalar(
        select(exists().where(SavedCard.client_id == client.id, SavedCard.is_default))
    )
    saved = SavedCard(
        client_id=client.id,
        stripe_payment_method_id=card.payment_method_id,
        brand=card.brand,
        last4=card.last4,
        exp_month=card.exp_month,
        exp_year=card.exp_year,
        is_default=not has_default,
    )
    db.add(saved)
    db.flush()
    audit_system(db, client.practice_id, "card.save", "saved_card", saved.id, client_id=client.id)
    billing_changed(db, client)
    return saved


def make_default_card(db: Session, card: SavedCard) -> None:
    """Make this the client's default card. The caller holds the client lock."""
    for other in client_cards(db, card.client_id):
        other.is_default = other.id == card.id


def remove_card(db: Session, card: SavedCard) -> None:
    """Detach a card in Stripe and forget it; the newest remaining card becomes the default."""
    payments.detach_card(card.stripe_payment_method_id)
    was_default = card.is_default
    client_id = card.client_id
    db.delete(card)
    db.flush()
    if not was_default:
        return
    replacement = db.scalar(
        select(SavedCard).where(SavedCard.client_id == client_id).order_by(SavedCard.id.desc())
    )
    if replacement is not None:
        replacement.is_default = True


def _record_charge_failure(db: Session, payment: Payment, reason: str) -> None:
    lock_client(db, payment.client_id)
    db.refresh(payment)
    if payment.status != PaymentStatus.PENDING:
        return
    payment.status = PaymentStatus.FAILED
    payment.failure_reason = reason[:300]
    billing_changed(db, payment.client)


def charge_saved_card(
    db: Session,
    client: Client,
    card: SavedCard,
    amount_cents: int,
    *,
    purpose: str,
) -> Payment:
    """Charge a saved card with the client absent and record the outcome.

    The pending payment is committed before Stripe is called, so a webhook that beats the API
    response finds it (through the payment_id metadata) instead of recording a second payment;
    the outcome is committed too. Raises PaymentError, after recording the failed payment,
    when the charge doesn't go through.
    """
    customer_id = ensure_stripe_customer(db, client)
    payment = Payment(
        practice_id=client.practice_id,
        client_id=client.id,
        amount_cents=amount_cents,
        method=PaymentMethod.CARD,
        status=PaymentStatus.PENDING,
        reference=card_label(card.brand, card.last4),
    )
    db.add(payment)
    db.commit()
    try:
        result = payments.charge_saved_card(
            customer_id=customer_id,
            payment_method_id=card.stripe_payment_method_id,
            amount_cents=amount_cents,
            description=f"Payment to {client.practice.name}",
            metadata={
                "practice_id": str(client.practice_id),
                "client_id": str(client.id),
                "payment_id": str(payment.id),
                "purpose": purpose,
            },
            idempotency_key=f"synari-payment-{payment.id}",
        )
    except payments.PaymentError as exc:
        _record_charge_failure(db, payment, exc.message)
        db.commit()
        raise
    if result.status not in ("succeeded", "processing"):
        _record_charge_failure(db, payment, CARD_NEEDS_CLIENT_MESSAGE)
        db.commit()
        raise payments.PaymentError(CARD_NEEDS_CLIENT_MESSAGE, declined=True)
    lock_client(db, client.id)
    db.refresh(payment)
    payment.stripe_payment_intent_id = payment.stripe_payment_intent_id or result.payment_intent_id
    if result.status == "succeeded" and payment.status not in RECEIVED_PAYMENT_STATUSES:
        mark_payment_received(db, payment)
        send_payment_receipt(db, client, payment.id)
    billing_changed(db, client)
    db.commit()
    return payment


# Stripe webhooks ---------------------------------------------------------------------------


def _metadata_id(metadata: Mapping[str, object], key: str) -> int | None:
    value = metadata.get(key)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def client_from_metadata(db: Session, metadata: Mapping[str, object]) -> Client | None:
    """The client a Stripe object belongs to, if its metadata names a client of that practice."""
    client_id = _metadata_id(metadata, "client_id")
    practice_id = _metadata_id(metadata, "practice_id")
    if client_id is None or practice_id is None:
        return None
    client = db.get(Client, client_id)
    if client is None or client.practice_id != practice_id:
        return None
    return client


def _find_card_payment(
    db: Session, payment_intent_id: str, metadata: Mapping[str, object]
) -> Payment | None:
    payment_id = _metadata_id(metadata, "payment_id")
    if payment_id is not None:
        payment = db.get(Payment, payment_id, populate_existing=True)
        if payment is not None:
            return payment
    return db.scalar(
        select(Payment)
        .where(Payment.stripe_payment_intent_id == payment_intent_id)
        .execution_options(populate_existing=True)
    )


def record_card_success(
    db: Session, *, payment_intent_id: str, amount_cents: int, metadata: Mapping[str, object]
) -> Payment | None:
    """Record a card payment Stripe reports as succeeded. Replays change nothing."""
    found = client_from_metadata(db, metadata)
    if found is None:
        logger.info("Ignoring Stripe payment %s without Synari metadata", payment_intent_id)
        return None
    client = lock_client(db, found.id)
    payment = _find_card_payment(db, payment_intent_id, metadata)
    if payment is not None and payment.client_id != client.id:
        logger.error("Stripe payment %s doesn't match its client", payment_intent_id)
        return None
    if payment is None:
        payment = Payment(
            practice_id=client.practice_id,
            client_id=client.id,
            amount_cents=amount_cents,
            method=PaymentMethod.CARD,
            status=PaymentStatus.PENDING,
            refunded_cents=0,
            reference="",
        )
        db.add(payment)
    payment.stripe_payment_intent_id = payment.stripe_payment_intent_id or payment_intent_id
    if payment.status in RECEIVED_PAYMENT_STATUSES:
        return payment
    mark_payment_received(db, payment, _metadata_id(metadata, "invoice_id"))
    db.flush()
    send_payment_receipt(db, client, payment.id)
    title = f"Card payment of {format_money(payment.amount_cents)} from {short_name(client)}"
    for member in staff_with_client_access(db, client, ClientAccess.BILLING):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="payment_received",
            title=title,
            link=staff_billing_link(client),
        )
    audit_system(
        db,
        client.practice_id,
        "payment.card_succeeded",
        "payment",
        payment.id,
        client_id=client.id,
    )
    billing_changed(db, client)
    return payment


def record_card_failure(
    db: Session, *, payment_intent_id: str, metadata: Mapping[str, object], reason: str
) -> None:
    """Mark a pending card payment failed when Stripe reports the charge failed."""
    found = client_from_metadata(db, metadata)
    if found is None:
        return
    lock_client(db, found.id)
    payment = _find_card_payment(db, payment_intent_id, metadata)
    if payment is None or payment.client_id != found.id:
        return
    if payment.status != PaymentStatus.PENDING:
        return
    payment.status = PaymentStatus.FAILED
    payment.failure_reason = (reason or "The card was declined.")[:300]
    payment.stripe_payment_intent_id = payment.stripe_payment_intent_id or payment_intent_id
    audit_system(
        db, found.practice_id, "payment.card_failed", "payment", payment.id, client_id=found.id
    )
    billing_changed(db, found)


def sync_card_refund(db: Session, *, payment_intent_id: str, amount_refunded: int) -> None:
    """Catch up with refunds made in Stripe (e.g. from its dashboard). Replays change nothing."""
    payment = db.scalar(
        select(Payment).where(Payment.stripe_payment_intent_id == payment_intent_id)
    )
    if payment is None:
        return
    lock_client(db, payment.client_id)
    db.refresh(payment)
    if payment.status not in RECEIVED_PAYMENT_STATUSES:
        return
    newly_refunded = min(amount_refunded, payment.amount_cents) - payment.refunded_cents
    if newly_refunded <= 0:
        return
    apply_refund(db, payment, newly_refunded)
    audit_system(
        db,
        payment.practice_id,
        "payment.refund_synced",
        "payment",
        payment.id,
        {"amount_cents": newly_refunded},
        client_id=payment.client_id,
    )
    billing_changed(db, payment.client)


# Superbills --------------------------------------------------------------------------------


def address_lines(line1: str, line2: str, city: str, state: str, postal_code: str) -> list[str]:
    """Postal address as printable lines, skipping empty parts."""
    region = " ".join(part for part in (state, postal_code) if part)
    last = ", ".join(part for part in (city, region) if part)
    return [line for line in (line1, line2, last) if line]


def place_of_service(appointment: Appointment) -> str:
    """The CMS place-of-service code: the appointment location's, else by how it was held."""
    if appointment.location is not None and appointment.location.place_of_service:
        return appointment.location.place_of_service
    if appointment.location_type in (LocationType.VIDEO, LocationType.PHONE):
        return PLACE_OF_SERVICE_TELEHEALTH
    return PLACE_OF_SERVICE_OFFICE


def superbill_provider(clinician: StaffMember) -> SuperbillProvider:
    """A clinician's details as the rendering provider on a superbill."""
    license_text = clinician.license_number
    if clinician.license_number and clinician.license_state:
        license_text = f"{clinician.license_number} ({clinician.license_state})"
    return SuperbillProvider(
        name=clinician.full_name,
        credentials=clinician.credentials,
        npi=clinician.npi,
        taxonomy_code=clinician.taxonomy_code,
        license=license_text,
    )


def superbill_insurance(client: Client, policy: InsurancePolicy) -> SuperbillInsurance:
    """A policy's payer, member and subscriber details as printed on a superbill."""
    is_self = policy.subscriber_relationship == SUBSCRIBER_SELF
    subscriber_name = f"{policy.subscriber_first_name} {policy.subscriber_last_name}".strip()
    return SuperbillInsurance(
        payer_name=policy.payer.name,
        payer_id=policy.payer.external_id,
        member_id=policy.member_id,
        group_number=policy.group_number,
        plan_name=policy.plan_name,
        subscriber_name=client.full_name if is_self else subscriber_name,
        subscriber_relationship=SUBSCRIBER_RELATIONSHIPS.get(
            policy.subscriber_relationship, policy.subscriber_relationship
        ),
        subscriber_dob=client.date_of_birth if is_self else policy.subscriber_dob,
    )


def build_superbill(
    db: Session, client: Client, period_start: date, period_end: date
) -> SuperbillData:
    """Snapshot the practice, client, insurance, diagnoses, services and payments for a period.

    Services are the client's attended sessions they're billed for (with a fee), with any of
    the practice's clinicians, whose date in the practice's time zone falls in the period.
    Each line names its clinician; when one clinician provided every service they are the
    superbill's provider. Insurance is the primary policy in effect during the period.
    """
    practice = client.practice
    zone = zone_of(practice)
    window_start = local_midnight(period_start, zone)
    window_end = local_midnight(period_end + timedelta(days=1), zone)
    participants = db.scalars(
        select(AppointmentParticipant)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .where(
            Appointment.practice_id == client.practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.starts_at >= window_start,
            Appointment.starts_at < window_end,
            AppointmentParticipant.client_id == client.id,
            AppointmentParticipant.billable,
            AppointmentParticipant.fee_cents > 0,
            effective_status() == AppointmentStatus.ATTENDED,
        )
        .order_by(Appointment.starts_at)
    ).all()
    lines = [
        SuperbillLine(
            date=local_date(participant.appointment.starts_at, zone),
            cpt=participant.appointment.service_code,
            description=participant.appointment.service_description or DEFAULT_LINE_DESCRIPTION,
            place_of_service=place_of_service(participant.appointment),
            units=1,
            fee_cents=participant.fee_cents,
            provider=superbill_provider(participant.appointment.clinician),
        )
        for participant in participants
    ]
    clinician_ids = {participant.appointment.clinician_id for participant in participants}
    received = db.scalars(
        select(Payment)
        .where(
            Payment.client_id == client.id,
            Payment.status.in_((PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED)),
            Payment.received_at >= window_start,
            Payment.received_at < window_end,
        )
        .order_by(Payment.received_at, Payment.id)
    ).all()
    payments_in_period = [
        SuperbillPayment(
            date=local_date(payment.received_at or payment.created_at, zone),
            method=PAYMENT_METHOD_LABELS[PaymentMethod(payment.method)],
            amount_cents=payment.amount_cents - payment.refunded_cents,
        )
        for payment in received
    ]
    policy = primary_policy(db, client.id, period_start, period_end)
    return SuperbillData(
        practice=SuperbillPractice(
            name=practice.name,
            address_lines=address_lines(
                practice.address_line1,
                practice.address_line2,
                practice.city,
                practice.state,
                practice.postal_code,
            ),
            phone=practice.phone,
            tax_id=practice.tax_id,
            tax_id_type=TaxIdType(practice.tax_id_type),
            npi=practice.npi,
            taxonomy_code=practice.taxonomy_code,
            billing_provider=BillingProviderType(practice.billing_provider),
        ),
        provider=lines[0].provider if len(clinician_ids) == 1 else None,
        client=SuperbillClient(
            name=client.full_name,
            date_of_birth=client.date_of_birth,
            address_lines=address_lines(
                client.address_line1,
                client.address_line2,
                client.city,
                client.state,
                client.postal_code,
            ),
            phone=client.phone,
        ),
        insurance=superbill_insurance(client, policy) if policy is not None else None,
        diagnosis_codes=[
            SuperbillDiagnosis(code=d.get("code", ""), description=d.get("description", ""))
            for d in client.diagnosis_codes
        ],
        lines=lines,
        payments=payments_in_period,
        total_cents=sum(line.fee_cents for line in lines),
        paid_cents=sum(payment.amount_cents for payment in payments_in_period),
    )


def next_superbill_number(practice_settings: PracticeSettings) -> str:
    """The next superbill number. The caller holds the practice settings lock."""
    practice_settings.superbill_counter += 1
    return f"SB-{practice_settings.superbill_counter:06d}"
