"""Good Faith Estimate schemas (No Surprises Act). Amounts are integer cents."""

from datetime import date, datetime
from typing import Literal, Self

from pydantic import Field, field_validator, model_validator

from synari.models.enums import GoodFaithEstimateStatus
from synari.schemas.appointments import ClientRef
from synari.schemas.common import Schema

MAX_UNIT_FEE_CENTS = 10_000_000
MAX_QUANTITY = 400
MAX_ITEMS = 50
MAX_DIAGNOSES = 12
DIAGNOSIS_LETTERS = "ABCDEFGHIJKL"

# Why an estimate is needed: a session was scheduled, the client asked, the care changed, or
# staff started one themselves.
EstimateReason = Literal["scheduling", "request", "update", "manual"]
DeliveryMethod = Literal["portal", "email", "paper", "mail"]


class EstimateDiagnosis(Schema):
    code: str = Field(min_length=1, max_length=20)
    description: str = Field(default="", max_length=300)


class SeparatelyScheduledItem(Schema):
    """An item or service another provider is expected to schedule separately."""

    description: str = Field(min_length=1, max_length=300)
    provider: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=500)


class EstimateItemIn(Schema):
    description: str = Field(min_length=1, max_length=300)
    service_code: str = Field(default="", max_length=20)
    location: str = Field(default="", max_length=300)
    # Letters into the estimate's diagnosis list (A = first).
    diagnosis_pointers: list[str] = Field(default_factory=list, max_length=MAX_DIAGNOSES)
    unit_fee_cents: int = Field(ge=0, le=MAX_UNIT_FEE_CENTS)
    quantity: int = Field(default=1, ge=1, le=MAX_QUANTITY)
    frequency: str = Field(default="", max_length=100)

    @field_validator("diagnosis_pointers")
    @classmethod
    def _letters(cls, pointers: list[str]) -> list[str]:
        cleaned = [pointer.strip().upper() for pointer in pointers]
        if any(pointer not in DIAGNOSIS_LETTERS or not pointer for pointer in cleaned):
            raise ValueError("Diagnosis pointers are letters A to L")
        return list(dict.fromkeys(cleaned))


class EstimateItemOut(EstimateItemIn):
    id: int
    total_cents: int


class EstimateDraftIn(Schema):
    """The editable part of an estimate. Issued estimates never change."""

    clinician_id: int
    period_start: date
    period_end: date
    primary_service: str = Field(min_length=1, max_length=300)
    scheduled_dates: list[date] = Field(default_factory=list, max_length=400)
    diagnosis_codes: list[EstimateDiagnosis] = Field(default_factory=list, max_length=MAX_DIAGNOSES)
    items: list[EstimateItemIn] = Field(default_factory=list, max_length=MAX_ITEMS)
    separately_scheduled: list[SeparatelyScheduledItem] = Field(default_factory=list, max_length=20)
    notes: str = Field(default="", max_length=4000)
    # What changed from the estimate this one replaces (required to issue a replacement).
    change_summary: str = Field(default="", max_length=2000)
    due_on: date | None = None

    @model_validator(mode="after")
    def _valid(self) -> Self:
        if self.period_end < self.period_start:
            raise ValueError("The estimate period can't end before it starts")
        letters = DIAGNOSIS_LETTERS[: len(self.diagnosis_codes)]
        for item in self.items:
            if any(pointer not in letters for pointer in item.diagnosis_pointers):
                raise ValueError("A service points to a diagnosis that isn't listed")
        return self


class EstimateProvider(Schema):
    """The provider as printed on the estimate: a snapshot taken when it's issued."""

    name: str = ""
    credentials: str = ""
    # e.g. "Licensed clinical social worker (LCSW)"; the credentials when nothing better is known.
    type: str = ""
    practice_name: str = ""
    address_lines: list[str] = Field(default_factory=list)
    contact: str = ""
    phone: str = ""
    email: str = ""
    npi: str = ""
    # Whose NPI: the clinician's (individual) or the practice's group NPI.
    npi_kind: Literal["individual", "group"] = "individual"
    tin: str = ""
    tin_type: str = ""
    states: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)


class EstimateOut(Schema):
    id: int
    client: ClientRef
    clinician_id: int
    clinician_name: str
    status: GoodFaithEstimateStatus
    supersedes_id: int | None
    # The estimate that replaced this one, once issued.
    superseded_by_id: int | None = None
    change_summary: str
    reason: EstimateReason
    due_on: date | None
    overdue: bool = False
    period_start: date
    period_end: date
    primary_service: str
    scheduled_dates: list[date]
    diagnosis_codes: list[EstimateDiagnosis]
    items: list[EstimateItemOut]
    separately_scheduled: list[SeparatelyScheduledItem]
    notes: str
    total_cents: int
    # Stored when issued; a live preview from current settings while a draft.
    provider: EstimateProvider
    # Identifiers the estimate needs before it can be issued (drafts only), e.g. "NPI".
    missing_provider_fields: list[str] = Field(default_factory=list)
    issued_at: datetime | None
    issued_by_name: str = ""
    delivery_method: DeliveryMethod
    pdf_sha256: str
    acknowledged_at: datetime | None
    acknowledged_name: str
    voided_at: datetime | None
    void_reason: str
    created_at: datetime
    updated_at: datetime


class EstimateIssue(Schema):
    delivery_method: DeliveryMethod = "portal"


class EstimateSupersede(Schema):
    change_summary: str = Field(default="", max_length=2000)


class EstimateVoid(Schema):
    reason: str = Field(min_length=1, max_length=500)


class EstimateServiceOption(Schema):
    """A practice service as it would be estimated for one clinician (their rate)."""

    service_id: int
    code: str
    description: str
    duration_minutes: int
    rate_cents: int


class EstimateClinicianOption(Schema):
    id: int
    name: str
    services: list[EstimateServiceOption]
    # A draft filled in from the client's upcoming sessions with this clinician, if any.
    suggested: EstimateDraftIn | None = None


class EstimateOptions(Schema):
    """What the estimate form offers for a client."""

    enabled: bool
    self_pay: bool
    # The clinicians this person may write estimates for (care team; any with billing access).
    clinicians: list[EstimateClinicianOption]
    diagnoses: list[EstimateDiagnosis]
    locations: list[str]
    default_clinician_id: int | None
    # Missing client details the estimate needs before it can be issued, e.g. "date of birth".
    missing_client_fields: list[str]


class EstimateNeedOut(Schema):
    """A client and clinician who need a (new) estimate: from a draft waiting to be issued, or
    upcoming sessions no issued estimate covers."""

    client: ClientRef
    clinician_id: int
    clinician_name: str
    reason: EstimateReason
    due_on: date | None
    overdue: bool
    # The open draft, if one was started.
    estimate_id: int | None
    uncovered_sessions: int
    next_session_at: datetime | None


# Client portal ------------------------------------------------------------------------------


class PortalEstimateOut(Schema):
    id: int
    clinician_name: str
    status: GoodFaithEstimateStatus
    period_start: date
    period_end: date
    primary_service: str
    total_cents: int
    issued_at: datetime | None
    change_summary: str
    acknowledged_at: datetime | None
    acknowledged_name: str


class PortalClinician(Schema):
    id: int
    name: str


class PortalEstimates(Schema):
    """The client's estimates (every one they were given, newest first) and whether they can
    ask for one."""

    enabled: bool
    estimates: list[PortalEstimateOut]
    clinicians: list[PortalClinician]
    # An estimate request (or a scheduled one) is already waiting on the practice.
    request_pending: bool


class PortalEstimateAcknowledge(Schema):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def _strip(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Type your name to acknowledge")
        return stripped


class PortalEstimateRequest(Schema):
    clinician_id: int | None = None


# Billing ------------------------------------------------------------------------------------


class EstimateCheckOut(Schema):
    """How a new invoice compares with the client's good faith estimates."""

    warnings: list[str]
    # Billed charges would be $400 or more above an estimate: a reason is needed to invoice.
    override_required: bool
    over_by_cents: int
