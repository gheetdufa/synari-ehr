"""Invoices measured against good faith estimates.

A self-pay client may dispute a bill (patient-provider dispute resolution) when a provider's
billed charges are $400 or more above that provider's estimate. When invoicing, charges in the
estimate's period for each clinician (earlier invoices plus the new lines) are compared with
the estimate's total: staff are warned from 80% of it, when there are more visits than it
expected, and when no estimate covers a self-pay client's services. Invoicing $400 or more
above an estimate needs a reason from staff; the nightly invoicing run never blocks, it alerts.
"""

from collections import defaultdict
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.models import (
    AppointmentParticipant,
    Client,
    GoodFaithEstimate,
    Invoice,
    InvoiceItem,
    StaffMember,
)
from synari.models.enums import (
    BillingType,
    InvoiceItemKind,
    InvoiceStatus,
    Role,
    SecuritySeverity,
)
from synari.services.billing import format_money, local_date, staff_billing_link
from synari.services.estimates import (
    estimate_staff,
    estimates_enabled,
    issued_estimates,
    issued_estimates_for,
)
from synari.services.notifications import notify, short_name
from synari.services.scheduling import zone_of
from synari.services.security_events import record_security_event

WARN_AT_PERCENT = 80
DISPUTE_THRESHOLD_CENTS = 40_000
OVERRIDE_REQUIRED_CODE = "estimate_override_required"


@dataclass(frozen=True)
class EstimateOverage:
    estimate_id: int
    clinician_id: int
    over_by_cents: int


@dataclass
class EstimateCheck:
    """Warnings for staff and the estimates the charges would exceed by $400 or more."""

    warnings: list[str] = field(default_factory=list)
    overages: list[EstimateOverage] = field(default_factory=list)

    @property
    def override_required(self) -> bool:
        return bool(self.overages)

    @property
    def over_by_cents(self) -> int:
        return max((overage.over_by_cents for overage in self.overages), default=0)


def applies_to(client: Client) -> bool:
    """Estimates matter for self-pay clients of practices that use them."""
    return client.billing_type == BillingType.SELF_PAY and estimates_enabled(client.practice)


def covering_estimate(
    estimates: Iterable[GoodFaithEstimate], service_date: date
) -> GoodFaithEstimate | None:
    """The issued estimate whose period includes the date (the newest when several do)."""
    return next(
        (e for e in estimates if e.period_start <= service_date <= e.period_end),
        None,
    )


def billed_in_period(
    db: Session, client_id: int, clinician_id: int, estimate: GoodFaithEstimate
) -> tuple[int, int]:
    """Charges and session lines already invoiced (not void) for the clinician's services to
    the client in the estimate's period."""
    in_period = (
        Invoice.client_id == client_id,
        Invoice.status != InvoiceStatus.VOID,
        InvoiceItem.clinician_id == clinician_id,
        InvoiceItem.service_date >= estimate.period_start,
        InvoiceItem.service_date <= estimate.period_end,
    )
    charged, visits = db.execute(
        select(
            func.coalesce(func.sum(InvoiceItem.amount_cents), 0),
            func.count(InvoiceItem.id).filter(InvoiceItem.kind == InvoiceItemKind.SERVICE),
        )
        .join(Invoice, Invoice.id == InvoiceItem.invoice_id)
        .where(*in_period)
    ).one()
    return int(charged), int(visits)


def billed_by_estimate(db: Session, estimates: Collection[GoodFaithEstimate]) -> dict[int, int]:
    """For each estimate, the charges already invoiced (not void) for its clinician's services
    to its client in its period (see billed_in_period), in one query."""
    if not estimates:
        return {}
    rows = db.execute(
        select(GoodFaithEstimate.id, func.coalesce(func.sum(InvoiceItem.amount_cents), 0))
        .join(
            Invoice,
            (Invoice.client_id == GoodFaithEstimate.client_id)
            & (Invoice.status != InvoiceStatus.VOID),
        )
        .join(
            InvoiceItem,
            (InvoiceItem.invoice_id == Invoice.id)
            & (InvoiceItem.clinician_id == GoodFaithEstimate.clinician_id)
            & (InvoiceItem.service_date >= GoodFaithEstimate.period_start)
            & (InvoiceItem.service_date <= GoodFaithEstimate.period_end),
        )
        .where(GoodFaithEstimate.id.in_([estimate.id for estimate in estimates]))
        .group_by(GoodFaithEstimate.id)
    ).all()
    billed = dict.fromkeys((estimate.id for estimate in estimates), 0)
    billed.update({estimate_id: int(cents) for estimate_id, cents in rows})
    return billed


def _estimate_warnings(
    name: str, estimate: GoodFaithEstimate, charged: int, visits: int
) -> tuple[list[str], int]:
    """Warnings for charges and visits against one estimate, and how far over it they are."""
    warnings = []
    total = estimate.total_cents
    over_by = charged - total
    if over_by >= DISPUTE_THRESHOLD_CENTS:
        warnings.append(
            f"Charges for {name} would be {format_money(over_by)} above the good faith "
            f"estimate ({format_money(charged)} of {format_money(total)}). The client may "
            f"dispute bills $400 or more above it."
        )
    elif total == 0 and charged > 0:
        warnings.append(f"The good faith estimate for {name} expected no charges.")
    elif total > 0 and charged * 100 >= total * WARN_AT_PERCENT:
        warnings.append(
            f"Charges for {name} reach {charged * 100 // total}% of the good faith estimate "
            f"({format_money(charged)} of {format_money(total)})."
        )
    expected_visits = sum(item.quantity for item in estimate.items)
    if visits > expected_visits:
        warnings.append(
            f"More sessions with {name} than the good faith estimate expected "
            f"({visits} of {expected_visits})."
        )
    return warnings, over_by


def check_invoice(db: Session, client: Client, lines: Sequence[InvoiceItem]) -> EstimateCheck:
    """Compare new invoice lines (not yet saved) with the client's issued estimates, per
    clinician. Lines without a clinician (custom charges) aren't counted."""
    check = EstimateCheck()
    if not applies_to(client):
        return check
    by_clinician: dict[int, list[InvoiceItem]] = defaultdict(list)
    for line in lines:
        if line.clinician_id is not None:
            by_clinician[line.clinician_id].append(line)
    for clinician_id, clinician_lines in sorted(by_clinician.items()):
        clinician = db.get_one(StaffMember, clinician_id)
        estimates = issued_estimates(db, client.id, clinician_id)
        grouped: dict[int, list[InvoiceItem]] = defaultdict(list)
        uncovered: list[date] = []
        for line in clinician_lines:
            estimate = covering_estimate(estimates, line.service_date)
            if estimate is None:
                uncovered.append(line.service_date)
            else:
                grouped[estimate.id].append(line)
        if uncovered:
            days = ", ".join(f"{day:%b} {day.day}" for day in sorted(set(uncovered)))
            check.warnings.append(
                f"No good faith estimate covers {clinician.display_name}'s services on {days} "
                f"for this self-pay client."
            )
        for estimate in estimates:
            new_lines = grouped.get(estimate.id)
            if not new_lines:
                continue
            charged, visits = billed_in_period(db, client.id, clinician_id, estimate)
            charged += sum(line.amount_cents for line in new_lines)
            visits += sum(1 for line in new_lines if line.kind == InvoiceItemKind.SERVICE)
            warnings, over_by = _estimate_warnings(
                clinician.display_name, estimate, charged, visits
            )
            check.warnings += warnings
            if over_by >= DISPUTE_THRESHOLD_CENTS:
                check.overages.append(EstimateOverage(estimate.id, clinician_id, over_by))
    return check


def override_required_detail(check: EstimateCheck) -> dict[str, object]:
    """The 409 detail asking staff for a reason to invoice above an estimate."""
    return {
        "code": OVERRIDE_REQUIRED_CODE,
        "message": (
            f"This invoice would bill {format_money(check.over_by_cents)} above the client's "
            f"good faith estimate. Enter a reason to invoice anyway."
        ),
        "over_by_cents": check.over_by_cents,
        "warnings": check.warnings,
    }


def record_overage(
    db: Session,
    client: Client,
    invoice_id: int,
    check: EstimateCheck,
    *,
    staff_id: int | None = None,
) -> None:
    """Log invoicing $400+ above an estimate as a security/billing event and tell the
    clinician and billing staff. `staff_id` is who overrode it (None for the nightly run)."""
    for overage in check.overages:
        record_security_event(
            db,
            practice_id=client.practice_id,
            kind="gfe_overage",
            severity=SecuritySeverity.WARNING,
            staff_id=staff_id,
            detail={
                "client_id": client.id,
                "invoice_id": invoice_id,
                "estimate_id": overage.estimate_id,
                "clinician_id": overage.clinician_id,
                "over_by_cents": overage.over_by_cents,
            },
        )
        title = (
            f"An invoice for {short_name(client)} is {format_money(overage.over_by_cents)} "
            f"above the good faith estimate"
        )
        for member in estimate_staff(db, client, overage.clinician_id):
            if member.id == staff_id:
                continue
            notify(
                db,
                Role.STAFF,
                member.id,
                kind="estimate_overage",
                title=title,
                link=staff_billing_link(client),
                urgent=True,
            )


def session_warnings(
    db: Session, sessions: Sequence[tuple[AppointmentParticipant, int]]
) -> dict[int, str]:
    """A short estimate warning per uninvoiced session (by participant id), for self-pay
    clients: no estimate covers it, or invoicing it (with the earlier ones in the list) reaches
    80% of the estimate or $400 above it."""
    warnings: dict[int, str] = {}
    self_pay = [(p, amount) for p, amount in sessions if applies_to(p.client)]
    issued = issued_estimates_for(
        db, {(p.client_id, p.appointment.clinician_id) for p, _ in self_pay}
    )
    running = billed_by_estimate(db, [e for estimates in issued.values() for e in estimates])
    for participant, amount in self_pay:
        appointment = participant.appointment
        pair = (participant.client_id, appointment.clinician_id)
        day = local_date(appointment.starts_at, zone_of(participant.client.practice))
        estimate = covering_estimate(issued.get(pair, []), day)
        if estimate is None:
            warnings[participant.id] = "No good faith estimate"
            continue
        running[estimate.id] += amount
        charged = running[estimate.id]
        if charged - estimate.total_cents >= DISPUTE_THRESHOLD_CENTS:
            over = format_money(charged - estimate.total_cents)
            warnings[participant.id] = f"{over} above the good faith estimate"
        elif estimate.total_cents and charged * 100 >= estimate.total_cents * WARN_AT_PERCENT:
            percent = charged * 100 // estimate.total_cents
            warnings[participant.id] = f"{percent}% of the good faith estimate"
    return warnings
