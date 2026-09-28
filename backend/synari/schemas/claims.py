"""Insurance claims, the unbilled-sessions queue, remittances (ERAs) and response files."""

import re
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field

from synari.models.enums import (
    ClaimStatus,
    ClaimSubmissionMethod,
    EligibilityStatus,
    RemittanceStatus,
)
from synari.schemas.common import PartialUpdate, Schema

_ICD10 = re.compile(r"^[A-Z][0-9][0-9A-Z][0-9A-Z]{0,4}$")


def _diagnosis_code(value: str) -> str:
    """ICD-10 as stored on claims: capital letters, without the dot."""
    code = value.strip().upper().replace(".", "")
    if not _ICD10.match(code):
        raise ValueError(f"“{value}” isn't a valid ICD-10 code")
    return code


def _upper(value: str) -> str:
    return value.strip().upper()


DiagnosisCode = Annotated[str, AfterValidator(_diagnosis_code)]
Modifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9]{2}$"), AfterValidator(_upper)]
ProcedureCode = Annotated[str, Field(pattern=r"^[A-Za-z0-9]{5}$"), AfterValidator(_upper)]
PlaceOfService = Annotated[str, Field(pattern=r"^\d{2}$")]
PayerResponsibility = Literal["P", "S", "T"]


class ClaimIssueOut(Schema):
    """One problem that would get the claim rejected. `field` points into the claim."""

    code: str
    field: str
    message: str


class ClaimValidation(Schema):
    claim_id: int
    patient_control_number: str
    issues: list[ClaimIssueOut]


class ClaimLineOut(Schema):
    id: int
    participant_id: int | None
    appointment_id: int | None = None
    line_control_number: str
    service_date: date
    procedure_code: str
    modifiers: list[str]
    units: int
    charge_cents: int
    place_of_service: str
    diagnosis_pointers: list[int]
    allowed_cents: int | None
    paid_cents: int
    adjustment_cents: int
    patient_responsibility_cents: int


class ClaimEventOut(Schema):
    id: int
    # created, updated, queued, submitted, accepted, rejected, file_accepted, paid, denied,
    # reversed, corrected, void_requested, voided, secondary_created
    kind: str
    message: str
    data: dict[str, Any] | None
    staff_id: int | None
    created_at: datetime


class ClaimDiagnosis(Schema):
    code: str
    description: str


class ClaimOut(Schema):
    id: int
    client_id: int
    client_name: str = ""
    policy_id: int
    payer_id: int
    payer_name: str = ""
    payer_responsibility: str
    status: ClaimStatus
    submission_method: ClaimSubmissionMethod
    patient_control_number: str
    frequency_code: str
    original_claim_id: int | None
    primary_claim_id: int | None
    payer_claim_number: str
    rendering_clinician_id: int
    rendering_clinician_name: str = ""
    supervising_clinician_id: int | None
    supervising_clinician_name: str = ""
    place_of_service: str
    prior_authorization_number: str
    diagnosis_codes: list[str]
    total_charge_cents: int
    paid_cents: int
    adjustment_cents: int
    patient_responsibility_cents: int
    insurance_balance_cents: int
    first_service_date: date | None = None
    last_service_date: date | None = None
    clearinghouse_ref: str
    submitted_at: datetime | None
    adjudicated_at: datetime | None
    last_error: str
    created_at: datetime
    updated_at: datetime


class ClaimDetailOut(ClaimOut):
    lines: list[ClaimLineOut]
    events: list[ClaimEventOut]
    # Computed now: what would stop the claim from being accepted.
    issues: list[ClaimIssueOut]
    diagnoses: list[ClaimDiagnosis]


class ClaimCreate(Schema):
    """Sessions of one client to bill. Omit policy_id to use the active primary policy."""

    participant_ids: list[int] = Field(min_length=1, max_length=200)
    policy_id: int | None = None
    # Defaults from the policy's rank (primary P, secondary S, tertiary T).
    payer_responsibility: PayerResponsibility | None = None


class ClaimLineUpdate(PartialUpdate):
    id: int
    procedure_code: ProcedureCode | None = None
    modifiers: list[Modifier] | None = Field(default=None, max_length=4)
    units: int | None = Field(default=None, ge=1, le=99)
    place_of_service: PlaceOfService | None = None
    diagnosis_pointers: list[Annotated[int, Field(ge=1, le=12)]] | None = Field(
        default=None, min_length=1, max_length=4
    )


class ClaimUpdate(PartialUpdate):
    """Edit a draft or rejected claim."""

    NULLABLE = frozenset({"supervising_clinician_id"})

    diagnosis_codes: list[DiagnosisCode] | None = Field(default=None, max_length=12)
    place_of_service: PlaceOfService | None = None
    prior_authorization_number: str | None = Field(default=None, max_length=50)
    # For corrected (7) and void (8) claims: the payer's number for the original claim.
    payer_claim_number: str | None = Field(default=None, max_length=50)
    rendering_clinician_id: int | None = None
    supervising_clinician_id: int | None = None
    lines: list[ClaimLineUpdate] | None = None


class ClaimSubmit(Schema):
    claim_ids: list[int] = Field(min_length=1, max_length=100)
    method: ClaimSubmissionMethod


class ClaimsRejected(Schema):
    """422 detail when some claims can't be submitted yet."""

    message: str
    claims: list[ClaimValidation]


class ClaimStatusTotalsOut(Schema):
    """How many claims of one status match the list's filters, and their money totals."""

    status: ClaimStatus
    claims: int
    charged_cents: int
    paid_cents: int
    patient_responsibility_cents: int
    insurance_balance_cents: int


class UnbilledSessionOut(Schema):
    """An attended session of an insurance client that isn't on a claim yet."""

    participant_id: int
    appointment_id: int
    client_id: int
    client_name: str
    clinician_id: int
    clinician_name: str
    starts_at: datetime
    service_date: date
    service_code: str
    service_description: str
    fee_cents: int
    location_type: str
    policy_id: int
    payer_id: int
    payer_name: str
    note_signed: bool
    has_diagnoses: bool
    eligibility_status: EligibilityStatus | None = None


# Remittances ------------------------------------------------------------------------------


class AdjustmentOut(Schema):
    """CO contractual, PR patient responsibility, OA other, PI payer initiated."""

    group_code: str
    reason_code: str
    amount_cents: int
    quantity: int = 0


class RemittanceLineOut(Schema):
    procedure_code: str
    modifiers: list[str]
    units: int
    line_control_number: str
    service_date: date | None
    charge_cents: int
    paid_cents: int
    allowed_cents: int | None
    adjustments: list[AdjustmentOut]
    remark_codes: list[str]


class RemittanceClaimOut(Schema):
    id: int
    claim_id: int | None
    client_id: int | None = None
    client_name: str = ""
    patient_control_number: str
    status_code: str
    status_description: str = ""
    charge_cents: int
    paid_cents: int
    patient_responsibility_cents: int
    payer_claim_number: str
    adjustments: list[AdjustmentOut] = []
    lines: list[RemittanceLineOut] = []
    posted_at: datetime | None


class ProviderAdjustmentOut(Schema):
    """A provider-level adjustment (PLB): positive amounts reduce the payment."""

    provider_id: str
    reason_code: str
    amount_cents: int
    reference: str = ""
    fiscal_period_date: date | None = None


class RemittanceOut(Schema):
    id: int
    payer_id: int | None
    payer_name: str
    trace_number: str
    payment_method: str
    payment_date: date | None
    total_paid_cents: int
    provider_adjustments: list[ProviderAdjustmentOut]
    status: RemittanceStatus
    # "stedi" (received automatically) or "upload".
    source: str
    file_id: int | None
    posted_at: datetime | None
    created_at: datetime
    claim_count: int = 0
    unmatched_count: int = 0


class RemittanceDetailOut(RemittanceOut):
    claims: list[RemittanceClaimOut]


class RemittanceAssignment(Schema):
    remittance_claim_id: int
    claim_id: int


class RemittancePost(Schema):
    """Post a remittance after review, matching any unmatched claims by hand first."""

    assignments: list[RemittanceAssignment] = []


class ResponseFileResult(Schema):
    """What an uploaded X12 response file did."""

    # 835 remittance, 277 claim acknowledgment, 999 file acknowledgment.
    kind: Literal["835", "277", "999"]
    remittances: list[RemittanceOut]
    # Claims whose status changed.
    claim_ids: list[int]
    message: str
