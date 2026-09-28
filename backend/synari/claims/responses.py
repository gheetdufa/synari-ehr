"""What comes back after a claim is sent, whichever path it took (X12 files or Stedi's API).

- `FunctionalAcknowledgment` (999): did the receiver accept the file's structure?
- `ClaimAcknowledgment` (277CA): did the clearinghouse or payer accept each claim?
- `Remittance` (835): what the payer paid and adjusted, claim by claim and line by line.

Money is integer cents. Adjustment amounts are positive when they reduce payment.
"""

from dataclasses import dataclass
from datetime import date

from synari.claims.document import Adjustment

REJECTED_CATEGORIES = frozenset({"A3", "A4", "A6", "A7", "A8"})
CATEGORY_DESCRIPTIONS = {
    "A0": "Forwarded to another entity",
    "A1": "Received",
    "A2": "Accepted into adjudication",
    "A3": "Returned as unprocessable",
    "A4": "Not found",
    "A5": "Split claim",
    "A6": "Rejected for missing information",
    "A7": "Rejected for invalid information",
    "A8": "Rejected for relational field in error",
}
CLAIM_STATUS_DESCRIPTIONS = {
    "1": "Processed as primary",
    "2": "Processed as secondary",
    "3": "Processed as tertiary",
    "4": "Denied",
    "19": "Processed as primary, forwarded to additional payer",
    "20": "Processed as secondary, forwarded to additional payer",
    "21": "Processed as tertiary, forwarded to additional payer",
    "22": "Reversal of previous payment",
    "23": "Not our claim, forwarded to additional payer",
    "25": "Predetermination pricing only, no payment",
}


@dataclass(frozen=True)
class TransactionAcknowledgment:
    """One transaction set (for example one 837) inside a 999.

    `status` is IK501: A accepted, E accepted with errors, R rejected (M, W and X are also
    rejections).
    """

    control_number: str
    transaction_set: str
    status: str
    errors: tuple[str, ...] = ()

    @property
    def accepted(self) -> bool:
        """True when the transaction set will be processed."""
        return self.status in ("A", "E")


@dataclass(frozen=True)
class FunctionalAcknowledgment:
    """A 999 answering one functional group we sent.

    `status` is AK901: A accepted, E accepted with errors, P partially accepted (some
    transaction sets rejected), R rejected.
    """

    group_control_number: str
    functional_id: str
    status: str
    transactions: tuple[TransactionAcknowledgment, ...] = ()

    @property
    def accepted(self) -> bool:
        """True when at least part of the group will be processed."""
        return self.status in ("A", "E", "P")


@dataclass(frozen=True)
class ClaimStatus:
    """One claim status: category (A1, A7, ...), status code and optional entity code."""

    category_code: str
    status_code: str
    entity_code: str = ""
    description: str = ""

    @property
    def rejected(self) -> bool:
        """True for the rejection categories (A3, A4, A6, A7, A8)."""
        return self.category_code in REJECTED_CATEGORIES


@dataclass(frozen=True)
class ClaimAcknowledgment:
    """A 277CA verdict on one claim, matched to ours by `patient_control_number`.

    `source` names who sent it (the clearinghouse or the payer). `payer_claim_number` is the
    payer's id for the claim, when they assigned one.
    """

    patient_control_number: str
    accepted: bool
    statuses: tuple[ClaimStatus, ...]
    messages: tuple[str, ...] = ()
    payer_claim_number: str = ""
    clearinghouse_trace_number: str = ""
    charge_cents: int | None = None
    status_date: date | None = None
    source: str = ""


@dataclass(frozen=True)
class ServicePayment:
    """How the payer handled one service line, matched by `line_control_number` (REF*6R)."""

    procedure_code: str
    charge_cents: int
    paid_cents: int
    modifiers: tuple[str, ...] = ()
    units: int = 1
    line_control_number: str = ""
    service_date: date | None = None
    allowed_cents: int | None = None
    adjustments: tuple[Adjustment, ...] = ()
    remark_codes: tuple[str, ...] = ()

    @property
    def adjustment_cents(self) -> int:
        """Sum of the line's adjustments."""
        return sum(adjustment.amount_cents for adjustment in self.adjustments)

    @property
    def is_balanced(self) -> bool:
        """Charge minus payment equals the adjustments, as the 835 rules require."""
        return self.charge_cents - self.paid_cents == self.adjustment_cents


@dataclass(frozen=True)
class ClaimPayment:
    """How the payer handled one claim (CLP).

    `status_code` is CLP02: 1/2/3 processed as primary/secondary/tertiary, 4 denied,
    19-21 processed and forwarded, 22 reversal of an earlier payment, 23 not our claim.
    Reversals carry negative amounts that cancel the original payment.
    """

    patient_control_number: str
    status_code: str
    charge_cents: int
    paid_cents: int
    patient_responsibility_cents: int = 0
    payer_claim_number: str = ""
    adjustments: tuple[Adjustment, ...] = ()
    lines: tuple[ServicePayment, ...] = ()

    @property
    def is_reversal(self) -> bool:
        """True when this entry takes back an earlier payment."""
        return self.status_code == "22"

    @property
    def is_denied(self) -> bool:
        """True when the payer denied the claim."""
        return self.status_code == "4"

    @property
    def status_description(self) -> str:
        """Plain-English meaning of `status_code`."""
        return CLAIM_STATUS_DESCRIPTIONS.get(self.status_code, f"Status {self.status_code}")

    @property
    def adjustment_cents(self) -> int:
        """Claim-level plus line-level adjustments."""
        claim_level = sum(adjustment.amount_cents for adjustment in self.adjustments)
        return claim_level + sum(line.adjustment_cents for line in self.lines)

    @property
    def is_balanced(self) -> bool:
        """Charge minus payment equals all adjustments, and every line balances."""
        return self.charge_cents - self.paid_cents == self.adjustment_cents and all(
            line.is_balanced for line in self.lines
        )


@dataclass(frozen=True)
class ProviderAdjustment:
    """A provider-level adjustment (PLB), such as a recoupment (WO) or interest (L6).

    Positive amounts reduce the payment; `reference` usually names the claim involved.
    """

    provider_id: str
    reason_code: str
    amount_cents: int
    reference: str = ""
    fiscal_period_date: date | None = None


@dataclass(frozen=True)
class Remittance:
    """One 835: a payment (or a notice of no payment) covering one or more claims.

    `payment_method` is BPR04: ACH, CHK (check), BOP (financial institution option),
    FWT (wire) or NON (no payment). `trace_number` is the check or EFT trace number; use it
    to spot duplicates and to match the bank deposit.
    """

    payer_name: str
    payment_cents: int
    payment_method: str
    trace_number: str
    claims: tuple[ClaimPayment, ...]
    payer_id: str = ""
    payee_name: str = ""
    payee_npi: str = ""
    payee_tax_id: str = ""
    payment_date: date | None = None
    provider_adjustments: tuple[ProviderAdjustment, ...] = ()

    @property
    def claims_paid_cents(self) -> int:
        """Sum of the claim payments."""
        return sum(claim.paid_cents for claim in self.claims)

    @property
    def provider_adjustment_cents(self) -> int:
        """Sum of the provider-level adjustments."""
        return sum(adjustment.amount_cents for adjustment in self.provider_adjustments)

    @property
    def is_balanced(self) -> bool:
        """The payment equals claim payments minus provider adjustments, and claims balance."""
        payment_matches = self.payment_cents == (
            self.claims_paid_cents - self.provider_adjustment_cents
        )
        return payment_matches and all(claim.is_balanced for claim in self.claims)
