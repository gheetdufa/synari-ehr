"""Reading the X12 files that come back after a claim is sent: 999, 277CA and 835.

`tokenize` reads the separators each file declares in its ISA segment, so files using any
delimiters (and with or without line breaks) parse the same way. The parsers return the
dataclasses in `responses`, the same ones the Stedi client builds from JSON reports.

Malformed amounts or dates raise ValueError; everything else unexpected is skipped.
"""

from dataclasses import dataclass, replace

from synari.claims.document import Adjustment
from synari.claims.responses import (
    CATEGORY_DESCRIPTIONS,
    ClaimAcknowledgment,
    ClaimPayment,
    ClaimStatus,
    FunctionalAcknowledgment,
    ProviderAdjustment,
    Remittance,
    ServicePayment,
    TransactionAcknowledgment,
)
from synari.claims.x12 import cents, parse_date, units

_ISA_ELEMENTS = 16

_SEGMENT_ERRORS = {
    "1": "unrecognized segment",
    "2": "unexpected segment",
    "3": "required segment missing",
    "4": "loop occurs more times than allowed",
    "5": "segment occurs more times than allowed",
    "6": "segment not in the transaction set",
    "7": "segment out of order",
    "8": "segment has data element errors",
    "I4": "segment not used in this implementation",
    "I6": "required segment missing for this implementation",
    "I7": "loop occurs fewer times than required",
    "I8": "segment occurs fewer times than required",
    "I9": "segment not used in this situation",
}
_ELEMENT_ERRORS = {
    "1": "required element missing",
    "2": "conditionally required element missing",
    "3": "too many elements",
    "4": "value too short",
    "5": "value too long",
    "6": "invalid character",
    "7": "invalid code value",
    "8": "invalid date",
    "9": "invalid time",
    "10": "element not allowed with another element",
    "12": "too many repetitions",
    "13": "too many components",
    "I6": "code value not used in this implementation",
    "I9": "required element missing for this implementation",
    "I10": "element not used in this implementation",
    "I11": "too few repetitions",
    "I12": "value doesn't match the required format",
    "I13": "element not used in this situation",
}
_TRANSACTION_ERRORS = {
    "1": "transaction set not supported",
    "2": "transaction set trailer missing",
    "3": "transaction set control numbers don't match",
    "4": "segment count doesn't match",
    "5": "one or more segments in error",
    "6": "missing or invalid transaction set identifier",
    "7": "missing or invalid transaction set control number",
    "18": "transaction set not in a functional group",
    "19": "invalid implementation guide reference",
    "23": "transaction set control number not unique in the group",
    "I5": "one or more segments in error for this implementation",
    "I6": "implementation guide not supported",
}


@dataclass(frozen=True)
class Segment:
    """One segment. `get(1)` is the first element after the tag, as in X12 names (CLP01)."""

    tag: str
    elements: tuple[str, ...]
    component_separator: str

    def get(self, position: int) -> str:
        """The element at 1-based `position`, or "" when absent."""
        return self.elements[position - 1] if 0 < position <= len(self.elements) else ""

    def components(self, position: int) -> list[str]:
        """The components of a composite element."""
        return self.get(position).split(self.component_separator)


def tokenize(text: str) -> list[Segment]:
    """Split an interchange into segments using the separators declared in its ISA."""
    start = text.find("ISA")
    if start < 0 or len(text) < start + 106:
        raise ValueError("Not an X12 file: it doesn't start with an ISA segment.")
    element_separator = text[start + 3]
    isa_fields = text[start:].split(element_separator, _ISA_ELEMENTS)
    component_separator, segment_terminator = isa_fields[-1][0], isa_fields[-1][1]
    segments = []
    for raw in text[start:].split(segment_terminator):
        raw = raw.strip()
        if raw:
            tag, *elements = raw.split(element_separator)
            segments.append(Segment(tag, tuple(elements), component_separator))
    return segments


def _adjustments(segment: Segment) -> list[Adjustment]:
    """Expand a CAS segment's reason/amount/quantity triples."""
    group_code = segment.get(1)
    found = []
    for position in range(2, 20, 3):
        reason = segment.get(position)
        if reason:
            quantity = segment.get(position + 2)
            found.append(
                Adjustment(
                    group_code=group_code,
                    reason_code=reason,
                    amount_cents=cents(segment.get(position + 1)),
                    quantity=units(quantity, default=0),
                )
            )
    return found


# 999 ------------------------------------------------------------------------------------


def parse_999(text: str) -> list[FunctionalAcknowledgment]:
    """Every functional group acknowledged in a 999 file."""
    groups: list[FunctionalAcknowledgment] = []
    group: FunctionalAcknowledgment | None = None
    transaction: TransactionAcknowledgment | None = None
    errors: list[str] = []
    segment_id = ""
    for segment in tokenize(text):
        if segment.tag == "AK1":
            group = FunctionalAcknowledgment(
                group_control_number=segment.get(2), functional_id=segment.get(1), status=""
            )
        elif segment.tag == "AK2":
            transaction = TransactionAcknowledgment(
                control_number=segment.get(2), transaction_set=segment.get(1), status=""
            )
            errors = []
        elif segment.tag == "IK3":
            segment_id = segment.get(1)
            loop = f" in loop {segment.get(3)}" if segment.get(3) else ""
            problem = _SEGMENT_ERRORS.get(segment.get(4), f"error {segment.get(4)}")
            errors.append(f"Segment {segment_id} (#{segment.get(2)}{loop}): {problem}")
        elif segment.tag == "IK4":
            position = segment.components(1)[0].zfill(2)
            problem = _ELEMENT_ERRORS.get(segment.get(3), f"error {segment.get(3)}")
            value = f" (sent “{segment.get(4)}”)" if segment.get(4) else ""
            errors.append(f"{segment_id}{position}: {problem}{value}")
        elif segment.tag == "IK5" and transaction is not None and group is not None:
            codes = [segment.get(position) for position in range(2, 7) if segment.get(position)]
            errors += [_TRANSACTION_ERRORS.get(code, f"error {code}") for code in codes]
            transaction = replace(transaction, status=segment.get(1), errors=tuple(errors))
            group = replace(group, transactions=(*group.transactions, transaction))
            transaction = None
        elif segment.tag == "AK9" and group is not None:
            groups.append(replace(group, status=segment.get(1)))
            group = None
    return groups


# 277CA ----------------------------------------------------------------------------------


def _statuses(segment: Segment) -> list[ClaimStatus]:
    """The status composites in STC01, STC10 and STC11."""
    found = []
    for position in (1, 10, 11):
        parts = [*segment.components(position), "", "", ""]
        if parts[0]:
            found.append(
                ClaimStatus(
                    category_code=parts[0],
                    status_code=parts[1],
                    entity_code=parts[2],
                    description=CATEGORY_DESCRIPTIONS.get(parts[0], ""),
                )
            )
    return found


def parse_277ca(text: str) -> list[ClaimAcknowledgment]:
    """The verdict on each claim in a 277CA file, in file order."""
    acknowledgments: list[ClaimAcknowledgment] = []
    claim: ClaimAcknowledgment | None = None
    rejected_by_action = False
    in_service_line = False
    source = ""
    level = ""

    def finish() -> None:
        if claim is not None:
            rejected = rejected_by_action or any(status.rejected for status in claim.statuses)
            acknowledgments.append(replace(claim, accepted=not rejected))

    for segment in tokenize(text):
        tag = segment.tag
        if tag in ("HL", "SE"):
            finish()
            claim = None
            level = segment.get(3) if tag == "HL" else ""
            if level == "PT":
                claim = ClaimAcknowledgment(
                    patient_control_number="", accepted=True, statuses=(), source=source
                )
                rejected_by_action = False
                in_service_line = False
        elif tag == "NM1" and level == "20":
            source = segment.get(3)
        elif claim is None:
            continue
        elif tag == "TRN" and segment.get(1) == "2":
            claim = replace(claim, patient_control_number=segment.get(2))
        elif tag == "SVC":
            in_service_line = True
        elif tag == "STC":
            message = segment.get(12)
            if message:
                claim = replace(claim, messages=(*claim.messages, message))
            if in_service_line:
                continue
            charge = segment.get(4)
            claim = replace(
                claim,
                statuses=(*claim.statuses, *_statuses(segment)),
                status_date=claim.status_date or parse_date(segment.get(2)),
                charge_cents=cents(charge) if charge else claim.charge_cents,
            )
            rejected_by_action = rejected_by_action or segment.get(3) == "U"
        elif tag == "REF" and segment.get(1) == "1K":
            claim = replace(claim, payer_claim_number=segment.get(2))
        elif tag == "REF" and segment.get(1) == "D9":
            claim = replace(claim, clearinghouse_trace_number=segment.get(2))
    return acknowledgments


# 835 ------------------------------------------------------------------------------------


def _service_payment(segment: Segment) -> ServicePayment:
    """A service line from SVC: composite procedure, charge, payment and paid units."""
    procedure = segment.components(1)
    return ServicePayment(
        procedure_code=procedure[1] if len(procedure) > 1 else procedure[0],
        modifiers=tuple(modifier for modifier in procedure[2:6] if modifier),
        charge_cents=cents(segment.get(2)),
        paid_cents=cents(segment.get(3)),
        units=units(segment.get(5)),
    )


def _provider_adjustments(segment: Segment) -> list[ProviderAdjustment]:
    """Expand a PLB segment's reason/amount pairs."""
    found = []
    for position in range(3, 15, 2):
        reason = segment.components(position)
        if reason[0]:
            found.append(
                ProviderAdjustment(
                    provider_id=segment.get(1),
                    fiscal_period_date=parse_date(segment.get(2)),
                    reason_code=reason[0],
                    reference=reason[1] if len(reason) > 1 else "",
                    amount_cents=cents(segment.get(position + 1)),
                )
            )
    return found


def parse_835(text: str) -> list[Remittance]:
    """Every remittance (one per 835 transaction set) in the file.

    A debit (BPR03 "D", the provider owes the payer) is returned as a negative payment.
    """
    remittances: list[Remittance] = []
    remittance: Remittance | None = None
    claim: ClaimPayment | None = None
    line: ServicePayment | None = None
    party = ""

    def close_line() -> None:
        nonlocal claim, line
        if claim is not None and line is not None:
            claim = replace(claim, lines=(*claim.lines, line))
        line = None

    def close_claim() -> None:
        nonlocal remittance, claim
        close_line()
        if remittance is not None and claim is not None:
            remittance = replace(remittance, claims=(*remittance.claims, claim))
        claim = None

    for segment in tokenize(text):
        tag, code = segment.tag, segment.get(1)
        if tag == "ST":
            remittance = Remittance(
                payer_name="", payment_cents=0, payment_method="", trace_number="", claims=()
            )
        elif remittance is None:
            continue
        elif tag == "BPR":
            payment = cents(segment.get(2))
            remittance = replace(
                remittance,
                payment_cents=-payment if segment.get(3) == "D" else payment,
                payment_method=segment.get(4),
                payment_date=parse_date(segment.get(16)),
            )
        elif tag == "TRN":
            remittance = replace(remittance, trace_number=segment.get(2))
        elif tag == "N1":
            party = code
            if code == "PR":
                remittance = replace(remittance, payer_name=segment.get(2), payer_id=segment.get(4))
            elif code == "PE":
                qualifier, identifier = segment.get(3), segment.get(4)
                remittance = replace(
                    remittance,
                    payee_name=segment.get(2),
                    payee_npi=identifier if qualifier == "XX" else "",
                    payee_tax_id=identifier if qualifier == "FI" else "",
                )
        elif tag == "REF" and claim is None:
            if party == "PR" and code == "2U":
                remittance = replace(remittance, payer_id=segment.get(2))
            elif party == "PE" and code == "TJ":
                remittance = replace(remittance, payee_tax_id=segment.get(2))
        elif tag == "CLP":
            close_claim()
            claim = ClaimPayment(
                patient_control_number=code,
                status_code=segment.get(2),
                charge_cents=cents(segment.get(3)),
                paid_cents=cents(segment.get(4)),
                patient_responsibility_cents=cents(segment.get(5)),
                payer_claim_number=segment.get(7),
            )
        elif tag == "SVC" and claim is not None:
            close_line()
            line = _service_payment(segment)
        elif tag == "CAS" and line is not None:
            line = replace(line, adjustments=(*line.adjustments, *_adjustments(segment)))
        elif tag == "CAS" and claim is not None:
            claim = replace(claim, adjustments=(*claim.adjustments, *_adjustments(segment)))
        elif line is not None and tag == "DTM" and code in ("472", "150"):
            line = replace(line, service_date=line.service_date or parse_date(segment.get(2)))
        elif line is not None and tag == "REF" and code == "6R":
            line = replace(line, line_control_number=segment.get(2))
        elif line is not None and tag == "AMT" and code == "B6":
            line = replace(line, allowed_cents=cents(segment.get(2)))
        elif line is not None and tag == "LQ" and code == "HE":
            line = replace(line, remark_codes=(*line.remark_codes, segment.get(2)))
        elif tag == "PLB":
            close_claim()
            remittance = replace(
                remittance,
                provider_adjustments=(
                    *remittance.provider_adjustments,
                    *_provider_adjustments(segment),
                ),
            )
        elif tag == "SE":
            close_claim()
            remittances.append(remittance)
            remittance = None
    return remittances
