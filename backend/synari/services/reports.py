"""Practice reports: income, sessions and attendance, receivables aging and claims.

Every report is limited to the clients the viewer can bill (`ReportScope.client_filter`), so a
clinician with billing access sees only their own caseload. Dates are the practice's calendar
days. Amounts are integer cents.
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, Date, Row, case, cast, distinct, func, literal, select
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    Claim,
    ClaimLine,
    Client,
    Invoice,
    InvoiceItem,
    Payer,
    Payment,
    PaymentAllocation,
    StaffMember,
)
from synari.models.enums import (
    RECEIVED_PAYMENT_STATUSES,
    AppointmentKind,
    AppointmentStatus,
    ClaimStatus,
    InvoiceStatus,
)

AGING_BUCKETS = ("0-30", "31-60", "61-90", "90+")
OTHER = "Other"


@dataclass(frozen=True)
class ReportScope:
    """Which practice and clients a report covers, and the practice's wall clock."""

    practice_id: int
    zone: ZoneInfo
    client_filter: ColumnElement[bool]


def _window(scope: ReportScope, start: date, end: date) -> tuple[datetime, datetime]:
    """UTC bounds of the practice-local days start..end (inclusive)."""
    first = datetime.combine(start, datetime.min.time(), tzinfo=scope.zone)
    after = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=scope.zone)
    return first, after


def split_pro_rata(total: int, weights: list[int]) -> list[int]:
    """Split `total` cents across `weights` proportionally; the parts always sum to `total`."""
    weight_sum = sum(weights)
    if weight_sum == 0:
        return [0 for _ in weights]
    raw = [total * weight / weight_sum for weight in weights]
    parts = [int(value) for value in raw]
    leftover = total - sum(parts)
    by_remainder = sorted(range(len(raw)), key=lambda i: raw[i] - parts[i], reverse=True)
    for index in by_remainder[: abs(leftover)]:
        parts[index] += 1 if leftover > 0 else -1
    return parts


def _staff_names(db: Session, staff_ids: Iterable[int]) -> dict[int, str]:
    ids = set(staff_ids)
    if not ids:
        return {}
    return {
        member.id: member.display_name
        for member in db.scalars(select(StaffMember).where(StaffMember.id.in_(ids)))
    }


# Income ----------------------------------------------------------------------------------------


@dataclass
class IncomeRow:
    clinician_id: int | None
    clinician_name: str
    client_payments_cents: int = 0
    insurance_payments_cents: int = 0

    @property
    def total_cents(self) -> int:
        return self.client_payments_cents + self.insurance_payments_cents


@dataclass
class IncomeReport:
    start: date
    end: date
    rows: list[IncomeRow]
    # Client money received but not applied to any invoice (their credit).
    unapplied_cents: int

    @property
    def total_cents(self) -> int:
        return sum(row.total_cents for row in self.rows) + self.unapplied_cents


def income(db: Session, scope: ReportScope, start: date, end: date) -> IncomeReport:
    """Money received in the period, attributed to the clinician who provided each service.

    Client payments are attributed across the invoice lines they paid in proportion to each
    line's amount; insurance payments by the claim line's session. Custom invoice lines (no
    clinician) fall under "Other".
    """
    first, after = _window(scope, start, end)
    by_clinician: dict[int | None, IncomeRow] = {}

    def row(clinician_id: int | None) -> IncomeRow:
        return by_clinician.setdefault(clinician_id, IncomeRow(clinician_id, ""))

    received = (
        select(Payment.id)
        .join(Client, Client.id == Payment.client_id)
        .where(
            Payment.practice_id == scope.practice_id,
            scope.client_filter,
            Payment.status.in_(RECEIVED_PAYMENT_STATUSES),
            Payment.received_at >= first,
            Payment.received_at < after,
        )
    )
    allocations = db.execute(
        select(PaymentAllocation.invoice_id, PaymentAllocation.amount_cents).where(
            PaymentAllocation.payment_id.in_(received)
        )
    ).all()
    applied = (
        select(func.coalesce(func.sum(PaymentAllocation.amount_cents), 0))
        .where(PaymentAllocation.payment_id == Payment.id)
        .correlate(Payment)
        .scalar_subquery()
    )
    unapplied = db.scalar(
        select(
            func.coalesce(func.sum(Payment.amount_cents - Payment.refunded_cents - applied), 0)
        ).where(Payment.id.in_(received))
    )
    lines: dict[int, list[tuple[int | None, int]]] = {}
    for invoice_id, clinician_id, amount in db.execute(
        select(InvoiceItem.invoice_id, InvoiceItem.clinician_id, InvoiceItem.amount_cents)
        .where(InvoiceItem.invoice_id.in_({invoice_id for invoice_id, _ in allocations}))
        .order_by(InvoiceItem.invoice_id, InvoiceItem.service_date, InvoiceItem.id)
    ):
        lines.setdefault(invoice_id, []).append((clinician_id, amount))
    for invoice_id, amount in allocations:
        items = lines.get(invoice_id, [])
        if not items:
            row(None).client_payments_cents += amount
        shares = split_pro_rata(amount, [line_amount for _, line_amount in items])
        for (clinician_id, _), share in zip(items, shares, strict=True):
            row(clinician_id).client_payments_cents += share

    claim_lines = db.execute(
        select(ClaimLine.paid_cents, Claim.rendering_clinician_id, Appointment.clinician_id)
        .join(Claim, Claim.id == ClaimLine.claim_id)
        .join(Client, Client.id == Claim.client_id)
        .outerjoin(AppointmentParticipant, AppointmentParticipant.id == ClaimLine.participant_id)
        .outerjoin(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .where(
            Claim.practice_id == scope.practice_id,
            scope.client_filter,
            Claim.adjudicated_at >= first,
            Claim.adjudicated_at < after,
            ClaimLine.paid_cents != 0,
        )
    ).all()
    for paid_cents, rendering_id, session_clinician_id in claim_lines:
        row(session_clinician_id or rendering_id).insurance_payments_cents += paid_cents

    names = _staff_names(db, (cid for cid in by_clinician if cid is not None))
    for clinician_id, entry in by_clinician.items():
        entry.clinician_name = names.get(clinician_id, OTHER) if clinician_id else OTHER
    rows = sorted(
        by_clinician.values(),
        key=lambda r: (r.clinician_id is None, r.clinician_name.lower()),
    )
    return IncomeReport(start=start, end=end, rows=rows, unapplied_cents=int(unapplied or 0))


# Sessions and attendance -----------------------------------------------------------------------


@dataclass
class SessionRow:
    clinician_id: int
    clinician_name: str
    sessions: int = 0  # appointments with at least one attended client
    attended: int = 0  # client attendances
    no_show: int = 0
    late_canceled: int = 0
    canceled: int = 0
    upcoming: int = 0
    billed_cents: int = 0  # fees of billable participants who attended


def sessions(db: Session, scope: ReportScope, start: date, end: date) -> list[SessionRow]:
    """Per clinician: sessions held, client attendance outcomes and fees for attended sessions.

    Counts the clients the viewer can bill; a session counts as held when one of them attended.
    """
    first, after = _window(scope, start, end)
    status = func.coalesce(AppointmentParticipant.attendance, Appointment.status)
    attended = status == AppointmentStatus.ATTENDED
    outcomes = (
        AppointmentStatus.ATTENDED,
        AppointmentStatus.NO_SHOW,
        AppointmentStatus.LATE_CANCELED,
        AppointmentStatus.CANCELED,
    )
    totals = db.execute(
        select(
            Appointment.clinician_id,
            func.count(distinct(Appointment.id)).filter(attended),
            func.count().filter(attended),
            func.count().filter(status == AppointmentStatus.NO_SHOW),
            func.count().filter(status == AppointmentStatus.LATE_CANCELED),
            func.count().filter(status == AppointmentStatus.CANCELED),
            func.count().filter(status.not_in(outcomes)),
            func.coalesce(
                func.sum(AppointmentParticipant.fee_cents).filter(
                    attended, AppointmentParticipant.billable
                ),
                0,
            ),
        )
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(
            Appointment.practice_id == scope.practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.starts_at >= first,
            Appointment.starts_at < after,
            Appointment.status.not_in([AppointmentStatus.REQUESTED, AppointmentStatus.DECLINED]),
            scope.client_filter,
        )
        .group_by(Appointment.clinician_id)
    ).all()
    names = _staff_names(db, (clinician_id for clinician_id, *_ in totals))
    rows = [
        SessionRow(
            clinician_id=clinician_id,
            clinician_name=names.get(clinician_id, ""),
            sessions=held,
            attended=attended_count,
            no_show=no_show,
            late_canceled=late_canceled,
            canceled=canceled,
            upcoming=upcoming,
            billed_cents=int(billed),
        )
        for (
            clinician_id,
            held,
            attended_count,
            no_show,
            late_canceled,
            canceled,
            upcoming,
            billed,
        ) in totals
    ]
    return sorted(rows, key=lambda r: r.clinician_name.lower())


# Receivables aging ---------------------------------------------------------------------------


@dataclass
class AgingRow:
    label: str
    buckets: dict[str, int] = field(default_factory=lambda: dict.fromkeys(AGING_BUCKETS, 0))
    # The client a client row is about (None for insurers), for the audit log.
    client_id: int | None = None

    @property
    def total_cents(self) -> int:
        return sum(self.buckets.values())


@dataclass
class AgingReport:
    as_of: date
    clients: list[AgingRow]
    insurance: list[AgingRow]


def _bucket(age_days: ColumnElement[int]) -> ColumnElement[str]:
    """SQL: the aging bucket for an age in days."""
    return case(
        (age_days <= 30, "0-30"),
        (age_days <= 60, "31-60"),
        (age_days <= 90, "61-90"),
        else_="90+",
    )


def _aging_rows(
    rows: Iterable[Row[tuple[int, str, str, int]]], *, keyed_by_client: bool = False
) -> list[AgingRow]:
    """(key, label, bucket, cents) sums as aging rows, largest total first."""
    by_key: dict[int, AgingRow] = {}
    for key, label, bucket, cents in rows:
        row = by_key.setdefault(key, AgingRow(label, client_id=key if keyed_by_client else None))
        row.buckets[bucket] += int(cents)
    return sorted(by_key.values(), key=lambda r: (-r.total_cents, r.label.lower()))


def aging(db: Session, scope: ReportScope, as_of: date) -> AgingReport:
    """What clients owe (open invoice balances by invoice age) and insurers owe (unresolved claim
    balances by submission age), as of a day."""
    invoice_balance = Invoice.total_cents - Invoice.paid_cents
    invoice_bucket = _bucket(literal(as_of) - Invoice.issued_on)
    client_totals = db.execute(
        select(
            Client.id,
            Client.first_name + " " + Client.last_name,
            invoice_bucket,
            func.sum(invoice_balance),
        )
        .join(Invoice, Invoice.client_id == Client.id)
        .where(
            Invoice.practice_id == scope.practice_id,
            scope.client_filter,
            Invoice.status == InvoiceStatus.OPEN,
            Invoice.issued_on <= as_of,
            invoice_balance > 0,
        )
        .group_by(Client.id, invoice_bucket)
    ).all()

    submitted_on = cast(func.timezone(scope.zone.key, Claim.submitted_at), Date)
    claim_bucket = _bucket(literal(as_of) - submitted_on)
    payer_totals = db.execute(
        select(Payer.id, Payer.name, claim_bucket, func.sum(Claim.insurance_balance_cents))
        .join(Claim, Claim.payer_id == Payer.id)
        .join(Client, Client.id == Claim.client_id)
        .where(
            Claim.practice_id == scope.practice_id,
            scope.client_filter,
            Claim.status.in_(
                [
                    ClaimStatus.SUBMITTED,
                    ClaimStatus.ACCEPTED,
                    ClaimStatus.REJECTED,
                    ClaimStatus.PAID,
                ]
            ),
            Claim.submitted_at.is_not(None),
            submitted_on <= as_of,
            Claim.insurance_balance_cents > 0,
        )
        .group_by(Payer.id, claim_bucket)
    ).all()
    return AgingReport(
        as_of=as_of,
        clients=_aging_rows(client_totals, keyed_by_client=True),
        insurance=_aging_rows(payer_totals),
    )


# Claims ------------------------------------------------------------------------------------------


@dataclass
class ClaimSummaryRow:
    payer_name: str
    status: str
    claims: int = 0
    charged_cents: int = 0
    paid_cents: int = 0
    adjustment_cents: int = 0
    patient_responsibility_cents: int = 0


def claims_summary(
    db: Session, scope: ReportScope, start: date, end: date
) -> list[ClaimSummaryRow]:
    """Claims created in the period, by payer and status, with charges and outcomes."""
    first, after = _window(scope, start, end)
    rows: dict[tuple[str, str], ClaimSummaryRow] = {}
    for claim, payer_name in db.execute(
        select(Claim, Payer.name)
        .join(Client, Client.id == Claim.client_id)
        .join(Payer, Payer.id == Claim.payer_id)
        .where(
            Claim.practice_id == scope.practice_id,
            scope.client_filter,
            Claim.created_at >= first,
            Claim.created_at < after,
        )
    ).all():
        entry = rows.setdefault(
            (payer_name, claim.status), ClaimSummaryRow(payer_name, claim.status)
        )
        entry.claims += 1
        entry.charged_cents += claim.total_charge_cents
        entry.paid_cents += claim.paid_cents
        entry.adjustment_cents += claim.adjustment_cents
        entry.patient_responsibility_cents += claim.patient_responsibility_cents
    return sorted(rows.values(), key=lambda r: (r.payer_name.lower(), r.status))
