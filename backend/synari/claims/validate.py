"""Pre-submission checks for a claim document.

`validate_claim` returns every problem at once so a therapist can fix them in one pass. Each
`ClaimIssue` has a stable `code` for programs, a `field` path into the `ClaimDocument` (for
example "subscriber.member_id" or "claim.lines[0].charge_cents") and a plain-English message.
An empty list means the claim is ready to send; payers can still reject it for reasons only
they know (eligibility, coverage, timely filing).
"""

import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime

from synari.claims.document import (
    Address,
    Adjustment,
    ClaimDocument,
    Contact,
    PersonName,
    Provider,
)

MAX_DIAGNOSES = 12
MAX_LINES = 50
MAX_POINTERS = 4
MAX_MODIFIERS = 4
MAX_PATIENT_CONTROL_NUMBER = 17
MAX_LINE_CONTROL_NUMBER = 30

SEX_CODES = frozenset({"M", "F", "U"})
PATIENT_RELATIONSHIPS = frozenset({"01", "19", "20", "21", "39", "40", "53", "G8"})
CLAIM_FILING_INDICATORS = frozenset(
    {
        *("11", "12", "13", "14", "15", "16", "17", "AM", "BL", "CH", "CI", "DS"),
        *("FI", "HM", "LM", "MA", "MB", "MC", "OF", "TV", "VA", "WC", "ZZ"),
    }
)
PAYER_RESPONSIBILITIES = frozenset({"P", "S", "T"})
FREQUENCY_CODES = frozenset({"1", "7", "8"})
ASSIGNMENT_CODES = frozenset({"A", "B", "C"})
BENEFITS_ASSIGNMENT_CODES = frozenset({"Y", "N", "W"})
RELEASE_CODES = frozenset({"I", "Y"})
ADJUSTMENT_GROUPS = frozenset({"CO", "OA", "PI", "PR"})

_ICD10 = re.compile(r"[A-Z][0-9][0-9A-Z][0-9A-Z]{0,4}")
_PROCEDURE = re.compile(r"[A-Z0-9]{5}")
_MODIFIER = re.compile(r"[A-Z0-9]{2}")
_TAXONOMY = re.compile(r"[0-9A-Z]{9}X")
_POSTAL_CODE = re.compile(r"[0-9]{5}(?:[0-9]{4})?")
_STATE = re.compile(r"[A-Z]{2}")
_PLACE_OF_SERVICE = re.compile(r"[0-9]{2}")
_PATIENT_CONTROL_NUMBER = re.compile(rf"[A-Za-z0-9]{{1,{MAX_PATIENT_CONTROL_NUMBER}}}")
_LINE_CONTROL_NUMBER = re.compile(rf"[A-Za-z0-9-]{{1,{MAX_LINE_CONTROL_NUMBER}}}")
_PO_BOX = re.compile(r"\b(?:P\.?\s*O\.?\s*BOX|POST\s+OFFICE\s+BOX|LOCK\s*BOX)\b", re.IGNORECASE)


@dataclass(frozen=True)
class ClaimIssue:
    """One problem that would get the claim rejected."""

    code: str
    field: str
    message: str


def npi_is_valid(npi: str) -> bool:
    """True for a 10-digit NPI whose check digit is right (Luhn over "80840" + NPI)."""
    if not re.fullmatch(r"[12][0-9]{9}", npi):
        return False
    total = 0
    for position, char in enumerate(reversed("80840" + npi)):
        digit = int(char)
        if position % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def ssn_is_valid(ssn: str) -> bool:
    """True for 9 digits that could be an issued SSN (no 000/666/9xx area, 00 group, 0000)."""
    if not re.fullmatch(r"[0-9]{9}", ssn):
        return False
    area, group, serial = ssn[:3], ssn[3:5], ssn[5:]
    return area not in {"000", "666"} and area[0] != "9" and group != "00" and serial != "0000"


def validate_claim(document: ClaimDocument, today: date | None = None) -> list[ClaimIssue]:
    """Every problem found in `document`, in the order the fields appear on the claim."""
    checks = _Checks(today or datetime.now(UTC).date())
    checks.billing_provider(document)
    checks.subscriber(document)
    checks.payer(document)
    checks.patient(document)
    checks.claim(document)
    checks.lines(document)
    checks.other_payer(document)
    return checks.issues


class _Checks:
    """Collects issues while walking the document."""

    def __init__(self, today: date) -> None:
        self.today = today
        self.issues: list[ClaimIssue] = []

    def add(self, code: str, field: str, message: str) -> None:
        self.issues.append(ClaimIssue(code=code, field=field, message=message))

    def required(self, value: str, field: str, label: str) -> bool:
        """Add a "required" issue when `value` is blank; returns whether it was present."""
        if value.strip():
            return True
        self.add("required", field, f"{label} is missing.")
        return False

    def code(self, value: str, allowed: frozenset[str], field: str, label: str) -> None:
        if value not in allowed:
            choices = ", ".join(sorted(allowed))
            self.add("code_invalid", field, f"{label} “{value}” isn't valid. Use one of {choices}.")

    def npi(self, npi: str, field: str, label: str) -> None:
        if not self.required(npi, field, f"{label}'s NPI"):
            return
        if not npi_is_valid(npi):
            self.add(
                "npi_invalid",
                field,
                f"{label}'s NPI “{npi}” isn't a valid NPI. Check the 10 digits against NPPES.",
            )

    def taxonomy(self, taxonomy: str, field: str, label: str) -> None:
        if not self.required(taxonomy, field, f"{label}'s taxonomy code"):
            return
        if not _TAXONOMY.fullmatch(taxonomy):
            self.add(
                "taxonomy_invalid",
                field,
                f"{label}'s taxonomy code “{taxonomy}” should be 10 characters ending in X, "
                "for example 101YM0800X.",
            )

    def person_name(self, name: PersonName, field: str, label: str) -> None:
        self.required(name.last, f"{field}.last", f"{label}'s last name")
        self.required(name.first, f"{field}.first", f"{label}'s first name")

    def address(
        self, address: Address, field: str, label: str, *, zip_plus_four: bool = False
    ) -> None:
        """Street, city, state and ZIP; billing and service locations need all 9 ZIP digits."""
        self.required(address.line1, f"{field}.line1", f"{label}'s street address")
        self.required(address.city, f"{field}.city", f"{label}'s city")
        if self.required(address.state, f"{field}.state", f"{label}'s state") and not (
            _STATE.fullmatch(address.state)
        ):
            self.add(
                "state_invalid",
                f"{field}.state",
                f"{label}'s state should be the two-letter postal code, for example NY.",
            )
        if not self.required(address.postal_code, f"{field}.postal_code", f"{label}'s ZIP code"):
            return
        if not _POSTAL_CODE.fullmatch(address.postal_code):
            self.add(
                "postal_code_invalid",
                f"{field}.postal_code",
                f"{label}'s ZIP code should be 5 or 9 digits without spaces or a hyphen.",
            )
        elif zip_plus_four and len(address.postal_code) != 9:
            self.add(
                "postal_code_invalid",
                f"{field}.postal_code",
                f"{label}'s ZIP code needs all 9 digits (ZIP+4). Look it up at usps.com.",
            )

    def contact(self, contact: Contact, field: str, label: str) -> None:
        self.required(contact.name, f"{field}.name", f"{label} contact name")
        if not re.fullmatch(r"[0-9]{10}", contact.phone):
            self.add(
                "phone_invalid",
                f"{field}.phone",
                f"{label} contact phone should be 10 digits, area code first.",
            )

    def not_future(self, day: date | None, code: str, field: str, message: str) -> None:
        if day is not None and day > self.today:
            self.add(code, field, message)

    def provider(self, provider: Provider, field: str, label: str, *, taxonomy: bool) -> None:
        self.person_name(provider.name, f"{field}.name", label)
        self.npi(provider.npi, f"{field}.npi", label)
        if taxonomy:
            self.taxonomy(provider.taxonomy, f"{field}.taxonomy", label)

    def adjustments(self, adjustments: tuple[Adjustment, ...], field: str) -> None:
        for index, adjustment in enumerate(adjustments):
            path = f"{field}[{index}]"
            self.code(
                adjustment.group_code,
                ADJUSTMENT_GROUPS,
                f"{path}.group_code",
                "Adjustment group code",
            )
            self.required(adjustment.reason_code, f"{path}.reason_code", "Adjustment reason code")

    # Sections --------------------------------------------------------------------------

    def billing_provider(self, document: ClaimDocument) -> None:
        provider = document.billing_provider
        label = "The billing provider"
        if provider.entity_type == "organization":
            self.required(
                provider.organization_name,
                "billing_provider.organization_name",
                "The practice's legal name",
            )
        elif provider.person is None:
            self.add(
                "required", "billing_provider.person", "The billing clinician's name is missing."
            )
        else:
            self.person_name(provider.person, "billing_provider.person", "The billing clinician")
        self.npi(provider.npi, "billing_provider.npi", label)
        self.taxonomy(provider.taxonomy, "billing_provider.taxonomy", label)

        if self.required(provider.tax_id, "billing_provider.tax_id", "The billing tax ID"):
            if provider.tax_id_type == "EIN" and not re.fullmatch(r"[0-9]{9}", provider.tax_id):
                self.add(
                    "tax_id_invalid",
                    "billing_provider.tax_id",
                    "The EIN should be 9 digits without the hyphen.",
                )
            elif provider.tax_id_type == "SSN" and not ssn_is_valid(provider.tax_id):
                self.add(
                    "tax_id_invalid",
                    "billing_provider.tax_id",
                    "The SSN should be 9 digits without hyphens.",
                )
            elif provider.tax_id_type not in ("EIN", "SSN"):
                self.add(
                    "code_invalid",
                    "billing_provider.tax_id_type",
                    "The tax ID type must be EIN or SSN.",
                )

        self.address(provider.address, "billing_provider.address", label, zip_plus_four=True)
        if _PO_BOX.search(f"{provider.address.line1} {provider.address.line2}"):
            self.add(
                "po_box_address",
                "billing_provider.address.line1",
                "The billing provider address must be a street address, not a PO box or lock "
                "box. Put the mailing address in the pay-to address instead.",
            )
        self.contact(provider.contact, "billing_provider.contact", "The billing")
        if provider.pay_to_address is not None:
            self.address(provider.pay_to_address, "billing_provider.pay_to_address", "The pay-to")

    def subscriber(self, document: ClaimDocument) -> None:
        subscriber = document.subscriber
        label = "The subscriber"
        if self.required(subscriber.member_id, "subscriber.member_id", "The member ID") and (
            len(subscriber.member_id) > 80
        ):
            self.add("member_id_invalid", "subscriber.member_id", "The member ID is too long.")
        self.person_name(subscriber.name, "subscriber.name", label)
        self.code(
            subscriber.claim_filing_indicator,
            CLAIM_FILING_INDICATORS,
            "subscriber.claim_filing_indicator",
            "The insurance type (claim filing indicator)",
        )
        self.code(
            subscriber.payer_responsibility,
            PAYER_RESPONSIBILITIES,
            "subscriber.payer_responsibility",
            "The payer order (primary/secondary/tertiary)",
        )
        self.code(
            subscriber.patient_relationship,
            PATIENT_RELATIONSHIPS | {"18"},
            "subscriber.patient_relationship",
            "The patient's relationship to the subscriber",
        )
        self.code(subscriber.sex, SEX_CODES, "subscriber.sex", "The subscriber's sex")
        if subscriber.is_patient:
            if subscriber.birth_date is None:
                self.add(
                    "required", "subscriber.birth_date", "The client's date of birth is missing."
                )
            if subscriber.address is None:
                self.add("required", "subscriber.address", "The client's address is missing.")
        if subscriber.address is not None:
            self.address(subscriber.address, "subscriber.address", label)
        self.not_future(
            subscriber.birth_date,
            "birth_date_future",
            "subscriber.birth_date",
            "The subscriber's date of birth is in the future.",
        )

    def payer(self, document: ClaimDocument) -> None:
        payer = document.payer
        self.required(payer.name, "payer.name", "The insurance company name")
        self.required(payer.payer_id, "payer.payer_id", "The payer ID")
        if payer.address is not None:
            self.address(payer.address, "payer.address", "The payer")

    def patient(self, document: ClaimDocument) -> None:
        patient = document.patient
        if document.subscriber.is_patient:
            if patient is not None:
                self.add(
                    "patient_unexpected",
                    "patient",
                    "The client is the subscriber, so leave the separate patient details empty "
                    "or change the relationship to the subscriber.",
                )
            return
        if patient is None:
            self.add(
                "patient_required",
                "patient",
                "The client isn't the subscriber, so the client's own name, date of birth, sex "
                "and address are needed.",
            )
            return
        self.person_name(patient.name, "patient.name", "The client")
        self.code(patient.sex, SEX_CODES, "patient.sex", "The client's sex")
        self.address(patient.address, "patient.address", "The client")
        self.not_future(
            patient.birth_date,
            "birth_date_future",
            "patient.birth_date",
            "The client's date of birth is in the future.",
        )

    def claim(self, document: ClaimDocument) -> None:
        claim = document.claim
        if not _PATIENT_CONTROL_NUMBER.fullmatch(claim.patient_control_number):
            self.add(
                "patient_control_number_invalid",
                "claim.patient_control_number",
                f"The claim number must be 1 to {MAX_PATIENT_CONTROL_NUMBER} letters and digits.",
            )
        if not _PLACE_OF_SERVICE.fullmatch(claim.place_of_service):
            self.add(
                "place_of_service_invalid",
                "claim.place_of_service",
                "The place of service should be a two-digit code, for example 11 (office) or "
                "10 (telehealth in the client's home).",
            )
        self.code(claim.frequency_code, FREQUENCY_CODES, "claim.frequency_code", "The claim type")
        if claim.frequency_code in ("7", "8") and not claim.payer_claim_number.strip():
            self.add(
                "payer_claim_number_required",
                "claim.payer_claim_number",
                "Corrected and voided claims need the payer's claim number for the original "
                "claim. Find it on the remittance or the payer's portal.",
            )
        self.code(
            claim.assignment_code, ASSIGNMENT_CODES, "claim.assignment_code", "The assignment code"
        )
        self.code(
            claim.benefits_assignment,
            BENEFITS_ASSIGNMENT_CODES,
            "claim.benefits_assignment",
            "The benefits assignment",
        )
        self.code(
            claim.release_of_information,
            RELEASE_CODES,
            "claim.release_of_information",
            "The release of information code",
        )
        self.not_future(
            claim.onset_date,
            "onset_date_future",
            "claim.onset_date",
            "The onset date is in the future.",
        )
        self.diagnoses(document)

        if claim.rendering_provider is not None:
            self.provider(
                claim.rendering_provider,
                "claim.rendering_provider",
                "The rendering clinician",
                taxonomy=True,
            )
        elif document.billing_provider.entity_type == "organization":
            self.add(
                "rendering_provider_required",
                "claim.rendering_provider",
                "Group practices must name the clinician who provided the services.",
            )
        if claim.supervising_provider is not None:
            self.provider(
                claim.supervising_provider,
                "claim.supervising_provider",
                "The supervisor",
                taxonomy=False,
            )
        if claim.referring_provider is not None:
            self.provider(
                claim.referring_provider,
                "claim.referring_provider",
                "The referring provider",
                taxonomy=False,
            )
        if claim.service_facility is not None:
            facility = claim.service_facility
            self.required(facility.name, "claim.service_facility.name", "The service location name")
            self.address(
                facility.address,
                "claim.service_facility.address",
                "The service location",
                zip_plus_four=True,
            )
            if facility.npi:
                self.npi(facility.npi, "claim.service_facility.npi", "The service location")

    def diagnoses(self, document: ClaimDocument) -> None:
        diagnoses = document.claim.diagnoses
        if not diagnoses or len(diagnoses) > MAX_DIAGNOSES:
            self.add(
                "diagnosis_count",
                "claim.diagnoses",
                f"A claim needs 1 to {MAX_DIAGNOSES} diagnosis codes; this one has "
                f"{len(diagnoses)}.",
            )
        for index, code in enumerate(diagnoses):
            if not _ICD10.fullmatch(code):
                self.add(
                    "diagnosis_invalid",
                    f"claim.diagnoses[{index}]",
                    f"“{code}” isn't a valid ICD-10 code. Use capital letters and leave out the "
                    "dot, for example F411.",
                )
        for code, count in Counter(diagnoses).items():
            if count > 1:
                self.add(
                    "diagnosis_duplicate",
                    "claim.diagnoses",
                    f"The diagnosis {code} is listed more than once.",
                )

    def lines(self, document: ClaimDocument) -> None:
        claim = document.claim
        if not claim.lines or len(claim.lines) > MAX_LINES:
            self.add(
                "line_count",
                "claim.lines",
                f"A claim needs 1 to {MAX_LINES} service lines; this one has {len(claim.lines)}.",
            )
        control_numbers = Counter(line.line_control_number for line in claim.lines)
        for index, line in enumerate(claim.lines):
            path = f"claim.lines[{index}]"
            label = f"Line {index + 1}"
            if not _LINE_CONTROL_NUMBER.fullmatch(line.line_control_number):
                self.add(
                    "line_control_number_invalid",
                    f"{path}.line_control_number",
                    f"{label}'s line ID must be 1 to {MAX_LINE_CONTROL_NUMBER} letters, digits "
                    "or hyphens.",
                )
            elif control_numbers[line.line_control_number] > 1:
                self.add(
                    "line_control_number_duplicate",
                    f"{path}.line_control_number",
                    f"{label}'s line ID is used by another line on this claim.",
                )
            if not _PROCEDURE.fullmatch(line.procedure_code):
                self.add(
                    "procedure_code_invalid",
                    f"{path}.procedure_code",
                    f"{label}'s service code “{line.procedure_code}” should be a 5-character "
                    "CPT or HCPCS code, for example 90837.",
                )
            if len(line.modifiers) > MAX_MODIFIERS:
                self.add(
                    "modifier_count",
                    f"{path}.modifiers",
                    f"{label} has {len(line.modifiers)} modifiers; the most allowed is "
                    f"{MAX_MODIFIERS}.",
                )
            for modifier_index, modifier in enumerate(line.modifiers):
                if not _MODIFIER.fullmatch(modifier):
                    self.add(
                        "modifier_invalid",
                        f"{path}.modifiers[{modifier_index}]",
                        f"{label}'s modifier “{modifier}” should be 2 letters or digits, "
                        "for example 95.",
                    )
            self.pointers(line.diagnosis_pointers, len(claim.diagnoses), path, label)
            if line.charge_cents <= 0:
                self.add(
                    "charge_invalid", f"{path}.charge_cents", f"{label}'s fee must be above $0."
                )
            if line.units < 1:
                self.add("units_invalid", f"{path}.units", f"{label} must have at least 1 unit.")
            if line.place_of_service and not _PLACE_OF_SERVICE.fullmatch(line.place_of_service):
                self.add(
                    "place_of_service_invalid",
                    f"{path}.place_of_service",
                    f"{label}'s place of service should be a two-digit code.",
                )
            self.not_future(
                line.service_date,
                "service_date_future",
                f"{path}.service_date",
                f"{label}'s date of service is in the future.",
            )
            if line.rendering_provider is not None:
                self.provider(
                    line.rendering_provider,
                    f"{path}.rendering_provider",
                    f"{label}'s rendering clinician",
                    taxonomy=True,
                )
        line_total = sum(line.charge_cents for line in claim.lines)
        if claim.total_charge_cents != line_total:
            self.add(
                "total_mismatch",
                "claim.total_charge_cents",
                f"The claim total ({_dollars(claim.total_charge_cents)}) doesn't match the sum "
                f"of the lines ({_dollars(line_total)}).",
            )

    def pointers(
        self, pointers: tuple[int, ...], diagnosis_count: int, path: str, label: str
    ) -> None:
        if not pointers or len(pointers) > MAX_POINTERS:
            self.add(
                "pointer_count",
                f"{path}.diagnosis_pointers",
                f"{label} must point to 1 to {MAX_POINTERS} of the claim's diagnoses.",
            )
        for pointer in pointers:
            if not 1 <= pointer <= min(diagnosis_count, MAX_DIAGNOSES):
                self.add(
                    "pointer_invalid",
                    f"{path}.diagnosis_pointers",
                    f"{label} points to diagnosis {pointer}, but the claim lists "
                    f"{diagnosis_count}.",
                )
        if len(set(pointers)) != len(pointers):
            self.add(
                "pointer_invalid",
                f"{path}.diagnosis_pointers",
                f"{label} points to the same diagnosis more than once.",
            )

    def other_payer(self, document: ClaimDocument) -> None:
        claim = document.claim
        other = claim.other_payer
        if other is None:
            if document.subscriber.payer_responsibility != "P":
                self.add(
                    "other_payer_required",
                    "claim.other_payer",
                    "Secondary and tertiary claims need what the earlier payer paid and adjusted. "
                    "Enter it from that payer's remittance.",
                )
            return
        path = "claim.other_payer"
        self.required(other.payer.name, f"{path}.payer.name", "The other payer's name")
        self.required(other.payer.payer_id, f"{path}.payer.payer_id", "The other payer's ID")
        self.required(
            other.subscriber.member_id, f"{path}.subscriber.member_id", "The other member ID"
        )
        self.person_name(other.subscriber.name, f"{path}.subscriber.name", "The other subscriber")
        self.code(
            other.subscriber.claim_filing_indicator,
            CLAIM_FILING_INDICATORS,
            f"{path}.subscriber.claim_filing_indicator",
            "The other insurance type",
        )
        self.code(
            other.subscriber.patient_relationship,
            PATIENT_RELATIONSHIPS | {"18"},
            f"{path}.subscriber.patient_relationship",
            "The patient's relationship to the other subscriber",
        )
        self.code(
            other.payer_responsibility,
            PAYER_RESPONSIBILITIES,
            f"{path}.payer_responsibility",
            "The other payer's order",
        )
        if other.paid_cents < 0:
            self.add(
                "charge_invalid",
                f"{path}.paid_cents",
                "The other payer's payment can't be negative.",
            )
        self.not_future(
            other.adjudication_date,
            "adjudication_date_future",
            f"{path}.adjudication_date",
            "The other payer's processing date is in the future.",
        )
        self.adjustments(other.claim_adjustments, f"{path}.claim_adjustments")

        lines_by_control = {line.line_control_number: line for line in claim.lines}
        adjusted_total = sum(a.amount_cents for a in other.claim_adjustments)
        for index, adjudication in enumerate(other.line_adjudications):
            line_path = f"{path}.line_adjudications[{index}]"
            self.adjustments(adjudication.adjustments, f"{line_path}.adjustments")
            adjusted_total += sum(a.amount_cents for a in adjudication.adjustments)
            line = lines_by_control.get(adjudication.line_control_number)
            if line is None:
                self.add(
                    "other_payer_line_unknown",
                    f"{line_path}.line_control_number",
                    f"The other payer's line “{adjudication.line_control_number}” doesn't "
                    "match any line on this claim.",
                )
                continue
            line_adjusted = sum(a.amount_cents for a in adjudication.adjustments)
            if line.charge_cents - adjudication.paid_cents != line_adjusted:
                self.add(
                    "other_payer_out_of_balance",
                    line_path,
                    f"For {line.procedure_code} on {line.service_date:%m/%d/%Y}, the fee minus "
                    "the other payer's payment must equal its adjustments.",
                )
        if other.line_adjudications:
            line_paid = sum(a.paid_cents for a in other.line_adjudications)
            if line_paid != other.paid_cents:
                self.add(
                    "other_payer_out_of_balance",
                    f"{path}.paid_cents",
                    "The other payer's total payment doesn't match its line payments.",
                )
        if claim.total_charge_cents - other.paid_cents != adjusted_total:
            self.add(
                "other_payer_out_of_balance",
                path,
                "The claim total minus the other payer's payment must equal the other payer's "
                "adjustments (including patient responsibility).",
            )


def _dollars(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    dollars, remainder = divmod(abs(cents), 100)
    return f"{sign}${dollars:,}.{remainder:02d}"
