"""What comes back after claims are sent: acknowledgments (999, 277CA) and remittances (835).

Acknowledgments move claims to accepted or rejected. Remittances are stored with one
RemittanceClaim per claim they cover, matched to our claims by patient control number, and
posted: payments, contractual adjustments and patient responsibility go onto the claim and its
lines, and each session's patient responsibility is handed to billing
(`record_patient_responsibility`), which bills the client any difference. A remittance is
posted automatically only when it balances and every claim and line in it matches; otherwise
it waits for review (`post_remittance` after the biller matches the rest).

Reversals (CLP02 22) carry negative amounts, so posting them simply takes back what an earlier
posting added; the corrected payment usually follows in the same remittance.
"""

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.claims import responses
from synari.claims.document import Adjustment
from synari.claims.responses import ClaimAcknowledgment, ClaimPayment, FunctionalAcknowledgment
from synari.models import (
    AppointmentParticipant,
    Claim,
    ClaimLine,
    Payer,
    Practice,
    Remittance,
    RemittanceClaim,
    StaffMember,
)
from synari.models.enums import (
    OPEN_CLAIM_STATUSES,
    ClaimStatus,
    ClaimSubmissionMethod,
    RemittanceStatus,
    Role,
)
from synari.permissions import Capability, capabilities_for
from synari.realtime import publish
from synari.services.billing import format_money, record_patient_responsibility
from synari.services.claims import (
    ADJUDICABLE_STATUSES,
    EVENT_CLAIMS_CHANGED,
    add_event,
    claims_changed,
    reject,
)
from synari.services.claims_document import match_service_lines, payment_detail, stored_payment
from synari.services.notifications import notify
from synari.services.recipients import active_staff

logger = logging.getLogger(__name__)

PATIENT_RESPONSIBILITY = "PR"
REVERSAL = "22"
DENIED = "4"
# CLP02 codes we post: processed as primary/secondary/tertiary (and forwarded), denied, reversal.
POSTABLE_STATUS_CODES = frozenset({"1", "2", "3", "19", "20", "21", DENIED, REVERSAL})


def remittance_link(remittance_id: int) -> str:
    """Where billers open a remittance in the app."""
    return f"/portal/billing/remittances/{remittance_id}"


def find_claim(db: Session, patient_control_number: str, practice_id: int | None) -> Claim | None:
    """Our claim with this number (in the practice, when given)."""
    query = select(Claim).where(
        Claim.patient_control_number == patient_control_number.strip().upper()
    )
    if practice_id is not None:
        query = query.where(Claim.practice_id == practice_id)
    return db.scalars(query.order_by(Claim.id)).first()


# Acknowledgments ---------------------------------------------------------------------------


def apply_acknowledgment(
    db: Session, claim: Claim, acknowledgment: ClaimAcknowledgment, *, transaction_id: str = ""
) -> None:
    """Record a 277CA verdict: accepted claims move on, rejected ones need fixing."""
    db.flush()
    db.refresh(claim, with_for_update=True)
    source = acknowledgment.source or "the clearinghouse"
    statuses = [
        " ".join(
            part
            for part in (f"{s.category_code}:{s.status_code}", s.description)
            if part and part != ":"
        )
        for s in acknowledgment.statuses
    ]
    data = {
        "transaction_id": transaction_id,
        "source": acknowledgment.source,
        "statuses": statuses,
        "messages": list(acknowledgment.messages),
        "payer_claim_number": acknowledgment.payer_claim_number,
    }
    if acknowledgment.payer_claim_number:
        claim.payer_claim_number = acknowledgment.payer_claim_number
    if acknowledgment.accepted:
        add_event(claim, "accepted", f"Accepted by {source}", data=data)
        if claim.status == ClaimStatus.SUBMITTED:
            claim.status = ClaimStatus.ACCEPTED
        return
    message = "; ".join(acknowledgment.messages or statuses) or f"Rejected by {source}"
    if claim.status in OPEN_CLAIM_STATUSES:
        reject(db, claim, message, data=data)
    else:
        add_event(claim, "rejected", message, data=data)


def apply_file_acknowledgment(
    db: Session, practice_id: int, acknowledgment: FunctionalAcknowledgment
) -> list[Claim]:
    """A 999 for an 837P file we exported: a rejected file rejects every claim in it."""
    control_number = acknowledgment.group_control_number.lstrip("0")
    claims = list(
        db.scalars(
            select(Claim)
            .where(
                Claim.practice_id == practice_id,
                Claim.submission_method == ClaimSubmissionMethod.X12_FILE,
                Claim.clearinghouse_ref == control_number,
            )
            .order_by(Claim.id)
            .with_for_update()
        )
    )
    transactions = acknowledgment.transactions
    rejected = not acknowledgment.accepted or (
        bool(transactions) and not any(t.accepted for t in transactions)
    )
    errors = [error for t in transactions for error in t.errors]
    for claim in claims:
        if rejected and claim.status in OPEN_CLAIM_STATUSES:
            message = "The clearinghouse rejected the 837P file"
            if errors:
                message += ": " + "; ".join(errors)
            reject(db, claim, message, data={"group_control_number": control_number})
        else:
            add_event(
                claim,
                "file_accepted",
                "The clearinghouse accepted the 837P file",
                data={"group_control_number": control_number},
            )
    return claims


# Posting -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class _LinePosting:
    line: ClaimLine
    paid_cents: int
    adjustments: tuple[Adjustment, ...]
    allowed_cents: int | None


def _patient_share(adjustments: tuple[Adjustment, ...]) -> int:
    return sum(a.amount_cents for a in adjustments if a.group_code == PATIENT_RESPONSIBILITY)


def _written_off(adjustments: tuple[Adjustment, ...]) -> int:
    return sum(a.amount_cents for a in adjustments if a.group_code != PATIENT_RESPONSIBILITY)


def line_postings(claim: Claim, payment: ClaimPayment) -> list[_LinePosting] | None:
    """How a claim payment splits over our lines; None when its lines can't all be matched.

    Claim-level adjustments go to the line of a one-line claim; on longer claims they stay on
    the claim totals only.
    """
    lines = list(claim.lines)
    if not payment.lines:
        if len(lines) != 1:
            return None
        return [_LinePosting(lines[0], payment.paid_cents, payment.adjustments, None)]
    matches = match_service_lines(lines, payment.lines)
    if any(line is None for line in matches):
        return None
    postings = [
        _LinePosting(line, service.paid_cents, service.adjustments, service.allowed_cents)
        for service, line in zip(payment.lines, matches, strict=True)
        if line is not None
    ]
    if payment.adjustments and len(lines) == 1:
        first = postings[0]
        postings[0] = _LinePosting(
            first.line,
            first.paid_cents,
            (*first.adjustments, *payment.adjustments),
            first.allowed_cents,
        )
    return postings


def is_postable(remittance_claim: RemittanceClaim) -> bool:
    """A matched, unposted claim payment with a status we post."""
    return (
        remittance_claim.claim_id is not None
        and remittance_claim.posted_at is None
        and remittance_claim.status_code in POSTABLE_STATUS_CODES
    )


def can_auto_post(claim: Claim | None, payment: ClaimPayment) -> bool:
    """Whether a claim payment can be posted without a person looking at it."""
    if claim is None or claim.status not in ADJUDICABLE_STATUSES:
        return False
    if payment.status_code not in POSTABLE_STATUS_CODES or not payment.is_balanced:
        return False
    if payment.adjustments and payment.lines and len(claim.lines) != 1:
        return False
    return line_postings(claim, payment) is not None


def _post_claim_payment(
    db: Session,
    remittance: Remittance,
    remittance_claim: RemittanceClaim,
    claim: Claim,
    now: datetime,
) -> None:
    payment = stored_payment(remittance_claim)
    postings = line_postings(claim, payment) or []
    for posting in postings:
        line = posting.line
        line.paid_cents += posting.paid_cents
        line.adjustment_cents += _written_off(posting.adjustments)
        line.patient_responsibility_cents += _patient_share(posting.adjustments)
        line.allowed_cents = None if payment.is_reversal else posting.allowed_cents
    every_adjustment = (
        *payment.adjustments,
        *(adjustment for service in payment.lines for adjustment in service.adjustments),
    )
    claim.paid_cents += payment.paid_cents
    claim.adjustment_cents += _written_off(every_adjustment)
    claim.patient_responsibility_cents += _patient_share(every_adjustment)
    if payment.payer_claim_number:
        claim.payer_claim_number = payment.payer_claim_number
    payer_name = remittance.payer_name or claim.payer.name
    data = {"remittance_id": remittance.id, "remittance_claim_id": remittance_claim.id}
    remittance_claim.claim_id = claim.id
    remittance_claim.posted_at = now
    if payment.is_reversal:
        claim.status = ClaimStatus.ACCEPTED
        message = f"{payer_name} reversed a payment of {format_money(-payment.paid_cents)}"
        add_event(claim, "reversed", message, data=data)
        return
    claim.adjudicated_at = now
    if payment.is_denied:
        claim.status = ClaimStatus.DENIED
        add_event(claim, "denied", f"Denied by {payer_name}", data=data)
        return
    claim.status = ClaimStatus.PAID
    add_event(
        claim,
        "paid",
        f"{payer_name} paid {format_money(payment.paid_cents)}; client responsibility "
        f"{format_money(claim.patient_responsibility_cents)}",
        data=data,
    )
    for posting in postings:
        participant = (
            db.get(AppointmentParticipant, posting.line.participant_id)
            if posting.line.participant_id
            else None
        )
        if participant is not None:
            record_patient_responsibility(
                db,
                participant,
                posting.line.patient_responsibility_cents,
                description=f"Balance after insurance ({payer_name})",
            )


def post_remittance(db: Session, remittance: Remittance, now: datetime) -> list[Claim]:
    """Post every matched, unposted claim payment and mark the remittance posted.

    Payments that match no claim (or have a status we don't post) stay unposted for the
    record. Returns the claims that changed.
    """
    posted = []
    for remittance_claim in remittance.claims:
        if not is_postable(remittance_claim):
            continue
        db.flush()
        claim = db.scalars(
            select(Claim)
            .where(Claim.id == remittance_claim.claim_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).one()
        _post_claim_payment(db, remittance, remittance_claim, claim, now)
        posted.append(claim)
    remittance.status = RemittanceStatus.POSTED
    remittance.posted_at = now
    return posted


# Importing remittances ---------------------------------------------------------------------


def remittance_practice(db: Session, remittance: responses.Remittance) -> int | None:
    """Which practice a clearinghouse remittance belongs to: by its claims, else the payee NPI."""
    numbers = [claim.patient_control_number.strip().upper() for claim in remittance.claims]
    practice_ids = db.scalars(
        select(Claim.practice_id).where(Claim.patient_control_number.in_(numbers))
    ).all()
    if practice_ids:
        return Counter(practice_ids).most_common(1)[0][0]
    npi = remittance.payee_npi.strip()
    if not npi:
        return None
    by_practice = db.scalar(select(Practice.id).where(Practice.npi == npi).order_by(Practice.id))
    if by_practice is not None:
        return by_practice
    return db.scalar(
        select(StaffMember.practice_id).where(StaffMember.npi == npi).order_by(StaffMember.id)
    )


def import_remittance(
    db: Session,
    practice_id: int,
    remittance: responses.Remittance,
    *,
    source: str,
    now: datetime,
    clearinghouse_ref: str | None = None,
    file_id: int | None = None,
) -> tuple[Remittance, list[Claim]]:
    """Store an 835 remittance and post it when it balances and everything matches.

    Returns the stored remittance and the claims that were posted.
    """
    payer = (
        db.scalars(
            select(Payer)
            .where(Payer.practice_id == practice_id, Payer.external_id == remittance.payer_id)
            .order_by(Payer.id)
        ).first()
        if remittance.payer_id
        else None
    )
    row = Remittance(
        practice_id=practice_id,
        payer_id=payer.id if payer else None,
        payer_name=remittance.payer_name or (payer.name if payer else ""),
        trace_number=remittance.trace_number[:50],
        payment_method=remittance.payment_method[:3],
        payment_date=remittance.payment_date,
        total_paid_cents=remittance.payment_cents,
        provider_adjustments=[
            {
                "provider_id": adjustment.provider_id,
                "reason_code": adjustment.reason_code,
                "amount_cents": adjustment.amount_cents,
                "reference": adjustment.reference,
                "fiscal_period_date": adjustment.fiscal_period_date.isoformat()
                if adjustment.fiscal_period_date
                else None,
            }
            for adjustment in remittance.provider_adjustments
        ],
        status=RemittanceStatus.UNPOSTED,
        source=source,
        clearinghouse_ref=clearinghouse_ref,
        file_id=file_id,
    )
    matched = []
    for payment in remittance.claims:
        claim = find_claim(db, payment.patient_control_number, practice_id)
        matched.append(claim)
        row.claims.append(
            RemittanceClaim(
                claim_id=claim.id if claim else None,
                patient_control_number=payment.patient_control_number[:38],
                status_code=payment.status_code[:2],
                charge_cents=payment.charge_cents,
                paid_cents=payment.paid_cents,
                patient_responsibility_cents=payment.patient_responsibility_cents,
                payer_claim_number=payment.payer_claim_number[:50],
                detail=payment_detail(payment),
            )
        )
    db.add(row)
    db.flush()
    automatic = remittance.is_balanced and all(
        can_auto_post(claim, payment)
        for claim, payment in zip(matched, remittance.claims, strict=True)
    )
    posted: list[Claim] = []
    if automatic:
        posted = post_remittance(db, row, now)
    else:
        row.status = RemittanceStatus.NEEDS_REVIEW
        notify_remittance_review(db, row)
    remittances_changed(db, row)
    if posted:
        claims_changed(db, posted)
    return row, posted


# Events and notifications ------------------------------------------------------------------


def remittance_staff(db: Session, practice_id: int) -> list[StaffMember]:
    """Active staff who handle every client's billing (remittances cover many clients)."""
    return [
        member
        for member in active_staff(db, practice_id)
        if Capability.BILLING_ALL in capabilities_for(member)
    ]


def remittances_changed(db: Session, remittance: Remittance) -> None:
    """Tell practice billers to refetch the remittance (ids only)."""
    publish(
        db,
        [(Role.STAFF, member.id) for member in remittance_staff(db, remittance.practice_id)],
        EVENT_CLAIMS_CHANGED,
        {"remittance_ids": [remittance.id]},
    )


def notify_remittance_review(db: Session, remittance: Remittance) -> None:
    """In-app notification to billers that an insurance payment couldn't be posted by itself."""
    payer = remittance.payer_name or "An insurer"
    for member in remittance_staff(db, remittance.practice_id):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="remittance_review",
            title="An insurance payment needs review",
            body=f"{payer} sent a remittance that couldn't be posted automatically.",
            link=remittance_link(remittance.id),
        )
