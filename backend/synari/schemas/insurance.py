"""Insurance settings, the payer list, prior authorizations and eligibility checks."""

from datetime import date, datetime
from typing import Annotated, Self

from pydantic import AfterValidator, Field, model_validator

from synari.claims.validate import CLAIM_FILING_INDICATORS
from synari.models.enums import EligibilityStatus, SupervisedBilling
from synari.schemas.common import LongText, PartialUpdate, Schema, ShortText

PAYER_ID_PATTERN = r"^[A-Za-z0-9]*$"


def _upper(value: str) -> str:
    return value.strip().upper()


def _filing_indicator(value: str) -> str:
    value = value.strip().upper()
    if value not in CLAIM_FILING_INDICATORS:
        raise ValueError(f"Unknown claim filing indicator: {value}")
    return value


Modifier = Annotated[str, Field(pattern=r"^([A-Za-z0-9]{2})?$"), AfterValidator(_upper)]
FilingIndicator = Annotated[str, AfterValidator(_filing_indicator)]
PayerExternalId = Annotated[str, Field(max_length=50, pattern=PAYER_ID_PATTERN)]
EnvelopeId = Annotated[str, Field(max_length=15, pattern=r"^[A-Za-z0-9 ]*$")]


# Settings ---------------------------------------------------------------------------------


class InsuranceSettingsOut(Schema):
    """Claim options for the practice, plus whether a clearinghouse is connected."""

    telehealth_modifier: str
    supervised_billing: SupervisedBilling
    x12_submitter_id: str
    x12_receiver_id: str
    x12_receiver_name: str
    eligibility_auto_check: bool
    # Stedi is configured on the server (claims can be sent electronically, eligibility checked).
    clearinghouse_enabled: bool
    # "T" while claims go to Stedi as test data, "P" in production.
    clearinghouse_usage: str


class InsuranceSettingsUpdate(PartialUpdate):
    telehealth_modifier: Modifier | None = None
    supervised_billing: SupervisedBilling | None = None
    x12_submitter_id: EnvelopeId | None = None
    x12_receiver_id: EnvelopeId | None = None
    x12_receiver_name: str | None = Field(default=None, max_length=60)
    eligibility_auto_check: bool | None = None


# Payers -----------------------------------------------------------------------------------


class PayerFields(Schema):
    name: ShortText = Field(min_length=1)
    # The clearinghouse payer ID (blank for payers billed on paper only).
    external_id: PayerExternalId = ""
    address_line1: ShortText = ""
    address_line2: ShortText = ""
    city: ShortText = ""
    state: ShortText = ""
    postal_code: str = Field(default="", max_length=20)
    claim_filing_indicator: FilingIndicator = "CI"
    era_enrolled: bool = False
    notes: LongText = ""
    is_active: bool = True


class PayerOut(PayerFields):
    id: int


class PayerUpdate(PartialUpdate):
    name: ShortText | None = Field(default=None, min_length=1)
    external_id: PayerExternalId | None = None
    address_line1: ShortText | None = None
    address_line2: ShortText | None = None
    city: ShortText | None = None
    state: ShortText | None = None
    postal_code: str | None = Field(default=None, max_length=20)
    claim_filing_indicator: FilingIndicator | None = None
    era_enrolled: bool | None = None
    notes: LongText | None = None
    is_active: bool | None = None


class PayerSearchResult(Schema):
    """A payer in the clearinghouse's network. Support values: SUPPORTED,
    ENROLLMENT_REQUIRED or NOT_SUPPORTED."""

    stedi_id: str
    name: str
    # Use as the payer's external_id.
    payer_id: str
    aliases: list[str]
    professional_claims: str
    eligibility: str
    remittances: str


# Prior authorizations ---------------------------------------------------------------------


class AuthorizationFields(Schema):
    number: str = Field(min_length=1, max_length=50)
    start_date: date
    end_date: date
    visits_authorized: int | None = Field(default=None, ge=0, le=10_000)
    notes: LongText = ""

    @model_validator(mode="after")
    def _dates_in_order(self) -> Self:
        if self.end_date < self.start_date:
            raise ValueError("The end date must be on or after the start date")
        return self


class AuthorizationOut(AuthorizationFields):
    id: int
    policy_id: int
    # Service lines billed under this authorization number (claims that aren't void).
    visits_used: int = 0


class AuthorizationUpdate(PartialUpdate):
    NULLABLE = frozenset({"visits_authorized"})

    number: str | None = Field(default=None, min_length=1, max_length=50)
    start_date: date | None = None
    end_date: date | None = None
    visits_authorized: int | None = Field(default=None, ge=0, le=10_000)
    notes: LongText | None = None


# Eligibility ------------------------------------------------------------------------------


class EligibilitySummary(Schema):
    """What the payer said, for mental-health services where it said so. None = not stated."""

    check_id: str = ""
    plan_name: str = ""
    group_number: str = ""
    coverage_start: date | None = None
    coverage_end: date | None = None
    in_network: bool | None = None
    copay_cents: int | None = None
    # The client's share, e.g. 20 for 20%.
    coinsurance_percent: float | None = None
    deductible_cents: int | None = None
    deductible_remaining_cents: int | None = None
    out_of_pocket_cents: int | None = None
    out_of_pocket_remaining_cents: int | None = None
    prior_authorization_required: bool | None = None
    messages: list[str] = []
    # The payer's rejection reasons, e.g. "Subscriber not found — correct and resubmit".
    errors: list[str] = []


class EligibilityCheckOut(Schema):
    id: int
    policy_id: int
    status: EligibilityStatus
    result: EligibilitySummary
    # Why the check couldn't be run (status "error").
    error: str
    checked_by_id: int | None
    created_at: datetime
