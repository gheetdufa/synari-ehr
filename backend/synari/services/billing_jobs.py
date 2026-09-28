"""Worker jobs for billing: the daily invoicing run and AutoPay.

Both run per practice, on the practice's local day, and only for practices with an active
owner. Both are safe to run every worker cycle and from several workers at once: invoicing
skips a practice whose settings row another worker holds, and AutoPay records each client's
attempt day before charging.
"""

import logging
from collections import defaultdict
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, and_, exists, func, or_, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from synari.access import ClientAccess
from synari.config import settings
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    Invoice,
    InvoiceItem,
    Practice,
    PracticeSettings,
    SavedCard,
    StaffMember,
)
from synari.models.enums import (
    BILLABLE_APPOINTMENT_STATUSES,
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    InvoiceItemKind,
    InvoiceStatus,
    Role,
    StaffRole,
    StaffStatus,
)
from synari.services import payments
from synari.services.billing import (
    MIN_CARD_CHARGE_CENTS,
    apply_client_credit,
    audit_system,
    billable_statuses,
    billing_changed,
    charge_saved_card,
    client_balance_cents,
    create_invoice,
    default_card,
    effective_status,
    local_date,
    local_midnight,
    lock_client,
    notify_new_invoice,
    service_line,
    staff_billing_link,
    uninvoiced_participants,
)
from synari.services.estimate_billing import check_invoice, record_overage
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_staff_email
from synari.services.recipients import staff_with_client_access
from synari.services.scheduling import zone_of

logger = logging.getLogger(__name__)

AUTOPAY_MAX_FAILURES = 3


def _has_active_owner() -> ColumnElement[bool]:
    """Practices someone still runs: at least one owner is active."""
    return exists().where(
        StaffMember.practice_id == Practice.id,
        StaffMember.role == StaffRole.OWNER,
        StaffMember.status == StaffStatus.ACTIVE,
    )


def _never_invoiced() -> ColumnElement[bool]:
    """Sessions (participants) that were never on any invoice, even a voided one."""
    return ~exists().where(
        InvoiceItem.participant_id == AppointmentParticipant.id,
        InvoiceItem.kind == InvoiceItemKind.SERVICE,
    )


def _practices_with_billing_work(db: Session, now: datetime) -> list[int]:
    """Active practices with finished sessions to mark attended or to invoice (a superset)."""
    to_mark = and_(Appointment.status == AppointmentStatus.SCHEDULED, Appointment.ends_at <= now)
    attendance = effective_status()
    to_invoice = and_(
        Appointment.ends_at < now,
        exists().where(
            AppointmentParticipant.appointment_id == Appointment.id,
            AppointmentParticipant.billable,
            func.coalesce(
                AppointmentParticipant.client_owes_cents, AppointmentParticipant.fee_cents
            )
            > 0,
            or_(
                attendance == AppointmentStatus.ATTENDED,
                and_(
                    attendance.in_(BILLABLE_APPOINTMENT_STATUSES),
                    PracticeSettings.bill_missed_appointments,
                ),
            ),
            _never_invoiced(),
        ),
    )
    return list(
        db.scalars(
            select(Practice.id)
            .join(Appointment, Appointment.practice_id == Practice.id)
            .join(PracticeSettings, PracticeSettings.practice_id == Practice.id)
            .where(
                _has_active_owner(),
                Appointment.kind == AppointmentKind.APPOINTMENT,
                Appointment.source != BookingSource.IMPORT,
                or_(to_mark, to_invoice),
            )
            .distinct()
        )
    )


def _invoice_practice(db: Session, practice_id: int, now: datetime) -> None:
    practice_settings = db.scalar(
        select(PracticeSettings)
        .where(PracticeSettings.practice_id == practice_id)
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )
    if practice_settings is None:
        return  # another worker (or a manual invoice) holds it; the next run catches up
    zone = zone_of(db.get_one(Practice, practice_id))
    today = local_date(now, zone)

    # SimplePractice's default: a finished appointment nobody updated counts as attended.
    db.execute(
        update(Appointment)
        .where(
            Appointment.practice_id == practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.status == AppointmentStatus.SCHEDULED,
            Appointment.ends_at <= now,
        )
        .values(status=AppointmentStatus.ATTENDED)
    )

    # Sessions on a voided invoice are left for staff to re-invoice by hand, so voiding an
    # invoice to waive a charge sticks. Resolving each amount records insurance copays; a
    # session the client owes nothing for (a $0 copay) gets no line.
    due = db.scalars(
        uninvoiced_participants(
            practice_id, billable_statuses(practice_settings), local_midnight(today, zone)
        )
        .where(_never_invoiced())
        .order_by(AppointmentParticipant.client_id, Appointment.starts_at)
    ).all()
    groups: dict[tuple[int, date], list[InvoiceItem]] = defaultdict(list)
    for participant in due:
        line = service_line(db, participant, zone)
        if line.amount_cents > 0:
            groups[(participant.client_id, line.service_date)].append(line)

    first_invoice: dict[int, int] = {}
    for (client_id, _service_day), lines in groups.items():
        client = lock_client(db, client_id)
        check = check_invoice(db, client, lines)
        invoice = create_invoice(db, practice_settings, client, lines, today)
        first_invoice.setdefault(client_id, invoice.id)
        audit_system(
            db, practice_id, "invoice.auto_create", "invoice", invoice.id, client_id=client_id
        )
        # Never held back: $400+ above a good faith estimate is flagged for staff instead.
        if check.override_required:
            record_overage(db, client, invoice.id, check)

    for client_id, invoice_id in first_invoice.items():
        apply_client_credit(db, client_id)
        client = db.get_one(Client, client_id)
        notify_new_invoice(db, client, invoice_id)
        billing_changed(db, client)


def create_daily_invoices(db: Session, now: datetime) -> None:
    """Worker job: mark finished appointments attended, then invoice billable sessions.

    Per practice and in its time zone, each billed client of a session that ended before today
    started is invoiced once, one invoice per client and day of service (with whichever
    clinicians saw them), dated today. Couples and family sessions bill only the identified
    patient; group sessions bill each member. Existing client credit is applied and whoever
    pays the client's bills is emailed. Re-running never bills a session twice.
    """
    for practice_id in _practices_with_billing_work(db, now):
        try:
            _invoice_practice(db, practice_id, now)
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            logger.exception("Invoicing failed for practice %s", practice_id)


def _autopay_turned_off(db: Session, client: Client, today: date) -> None:
    """Email and notify everyone who handles the client's billing (content-free)."""
    title = f"AutoPay was turned off for {short_name(client)} after 3 declined charges"
    for member in staff_with_client_access(db, client, ClientAccess.BILLING):
        queue_staff_email(
            db,
            member,
            subject="AutoPay was turned off for a client",
            heading="AutoPay was turned off",
            paragraphs=[
                "A client's saved card was declined three days in a row, so AutoPay is now off "
                "for them.",
                "Sign in to review their billing. You can turn AutoPay back on once their card "
                "is updated.",
            ],
            button_label="Open Synari",
            app_path=staff_billing_link(client),
            dedupe_key=f"autopay-off:{client.id}:{member.id}:{today.isoformat()}",
        )
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="autopay_disabled",
            title=title,
            link=staff_billing_link(client),
        )


def _count_autopay_failure(db: Session, client_id: int, today: date) -> None:
    client = lock_client(db, client_id)
    client.autopay_failures += 1
    if client.autopay_failures < AUTOPAY_MAX_FAILURES:
        return
    client.autopay_enabled = False
    client.autopay_failures = 0
    _autopay_turned_off(db, client, today)
    audit_system(
        db, client.practice_id, "client.autopay_disabled", "client", client.id, client_id=client.id
    )
    billing_changed(db, client)


def _autopay_client(db: Session, client_id: int, today: date) -> None:
    client = db.scalar(
        select(Client)
        .where(
            Client.id == client_id,
            Client.autopay_enabled,
            or_(Client.last_autopay_attempt_on.is_(None), Client.last_autopay_attempt_on < today),
        )
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )
    if client is None:
        db.rollback()
        return
    balance = client_balance_cents(db, client.id, include_disputed=False)
    card = default_card(db, client.id)
    if card is None or balance < MIN_CARD_CHARGE_CENTS:
        db.rollback()
        return
    client.last_autopay_attempt_on = today
    audit_system(
        db,
        client.practice_id,
        "payment.autopay",
        "client",
        client.id,
        {"amount_cents": balance},
        client_id=client.id,
    )
    try:
        charge_saved_card(db, client, card, balance, purpose="autopay")
    except payments.PaymentError as exc:
        if exc.declined:
            _count_autopay_failure(db, client.id, today)
        db.commit()
        return
    lock_client(db, client.id).autopay_failures = 0
    db.commit()


def run_autopay(db: Session, now: datetime) -> None:
    """Worker job: once per practice-local day, charge each AutoPay client's default card in full.

    Runs after invoicing so the night's invoices are included. Disputed invoices are left out
    until the dispute is resolved. Three declines in a row turn AutoPay off for the client and
    email the staff who handle their billing.
    """
    if not settings.stripe_enabled:
        return
    has_balance = exists().where(
        Invoice.client_id == Client.id,
        Invoice.status == InvoiceStatus.OPEN,
        Invoice.disputed_at.is_(None),
        Invoice.total_cents > Invoice.paid_cents,
    )
    has_card = exists().where(SavedCard.client_id == Client.id, SavedCard.is_default)
    candidates = db.execute(
        select(Client.id, Practice.time_zone)
        .join(Practice, Practice.id == Client.practice_id)
        .join(PracticeSettings, PracticeSettings.practice_id == Practice.id)
        .where(
            _has_active_owner(),
            PracticeSettings.autopay_enabled,
            Client.autopay_enabled,
            has_balance,
            has_card,
        )
        .order_by(Client.id)
    ).all()
    for client_id, time_zone in candidates:
        try:
            _autopay_client(db, client_id, local_date(now, ZoneInfo(time_zone)))
        except SQLAlchemyError:
            db.rollback()
            logger.exception("AutoPay failed for client %s", client_id)
