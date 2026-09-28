"""Invoice, payment, saved card and superbill schemas. Amounts are integer cents."""

from datetime import UTC, date, datetime, timedelta
from typing import Literal, Self

from pydantic import AwareDatetime, Field, field_validator, model_validator

from synari.models.enums import (
    AppointmentStatus,
    BillingProviderType,
    InvoiceItemKind,
    InvoiceStatus,
    PaymentMethod,
    PaymentStatus,
    TaxIdType,
)
from synari.schemas.appointments import ClientRef
from synari.schemas.common import Schema, ShortText

MAX_AMOUNT_CENTS = 10_000_000
MAX_SUPERBILL_DAYS = 366

ManualPaymentMethod = Literal["cash", "check", "external_card", "other"]


class InvoiceItemOut(Schema):
    id: int
    kind: InvoiceItemKind
    # The session (appointment participant) a service or adjustment line is for.
    participant_id: int | None
    # That session's appointment, for linking to it.
    appointment_id: int | None = None
    service_date: date
    service_code: str
    description: str
    amount_cents: int
    # The clinician who provided the session (empty for custom lines).
    clinician_id: int | None
    clinician_name: str = ""


class InvoiceOut(Schema):
    id: int
    client: ClientRef
    number: str
    issued_on: date
    due_on: date
    status: InvoiceStatus
    total_cents: int
    paid_cents: int
    balance_cents: int
    notes: str
    # Who the invoice is addressed to when not the client (e.g. a minor's parent).
    bill_to_contact_id: int | None
    bill_to_name: str = ""
    voided_at: datetime | None
    # The client is disputing the bill: AutoPay (and collections) are paused for it.
    disputed_at: datetime | None = None
    # Why staff invoiced $400 or more above the good faith estimate (staff only).
    gfe_override_reason: str = ""
    # How the invoice compares with the client's good faith estimates (only when created).
    estimate_warnings: list[str] = Field(default_factory=list)
    created_at: datetime
    items: list[InvoiceItemOut]


class InvoiceLineIn(Schema):
    """A custom line on a manual invoice (not tied to a session)."""

    service_date: date
    description: str = Field(min_length=1, max_length=300)
    service_code: str = Field(default="", max_length=20)
    amount_cents: int = Field(gt=0, le=MAX_AMOUNT_CENTS)


class InvoiceCreate(Schema):
    """A manual invoice: the client's sessions (by participant id) and/or custom lines."""

    client_id: int
    participant_ids: list[int] = Field(default_factory=list, max_length=100)
    items: list[InvoiceLineIn] = Field(default_factory=list, max_length=100)
    notes: str = Field(default="", max_length=2000)
    notify: bool = True
    # Required to bill $400 or more above a self-pay client's good faith estimate.
    gfe_override_reason: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _has_lines(self) -> Self:
        if not self.participant_ids and not self.items:
            raise ValueError("An invoice needs at least one session or line")
        if len(set(self.participant_ids)) != len(self.participant_ids):
            raise ValueError("A session can only be listed once")
        return self


class UninvoicedSessionOut(Schema):
    """A client's past billable session that isn't on an invoice yet."""

    participant_id: int
    appointment_id: int
    client: ClientRef
    clinician_id: int
    clinician_name: str
    starts_at: datetime
    ends_at: datetime
    service_code: str
    service_description: str
    # This client's attendance (their own, else the session's status).
    status: AppointmentStatus
    # What the invoice line will be: what the client owes (e.g. a copay), else the fee.
    amount_cents: int
    # For self-pay clients: no good faith estimate covers it, or it nears or passes the estimate.
    estimate_warning: str = ""


class AllocationOut(Schema):
    invoice_id: int
    amount_cents: int


class PaymentOut(Schema):
    id: int
    client: ClientRef
    amount_cents: int
    method: PaymentMethod
    status: PaymentStatus
    refunded_cents: int
    refundable_cents: int
    unapplied_cents: int
    reference: str
    failure_reason: str
    received_at: datetime | None
    created_at: datetime
    allocations: list[AllocationOut]


class PaymentCreate(Schema):
    """A payment received outside Synari (cash, check, a card run elsewhere)."""

    client_id: int
    amount_cents: int = Field(gt=0, le=MAX_AMOUNT_CENTS)
    method: ManualPaymentMethod
    reference: ShortText = ""
    received_at: AwareDatetime | None = None
    invoice_id: int | None = None
    send_receipt: bool = True

    @field_validator("received_at")
    @classmethod
    def _not_in_future(cls, value: datetime | None) -> datetime | None:
        if value is not None and value > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError("The date received can't be in the future")
        return value


class RefundCreate(Schema):
    amount_cents: int = Field(gt=0, le=MAX_AMOUNT_CENTS)


class SavedCardOut(Schema):
    id: int
    brand: str
    last4: str
    exp_month: int
    exp_year: int
    is_default: bool
    created_at: datetime


class ChargeCreate(Schema):
    """Charge a client's saved card (the default card unless one is chosen)."""

    amount_cents: int = Field(gt=0, le=MAX_AMOUNT_CENTS)
    card_id: int | None = None


class ClientBillingSummary(Schema):
    client_id: int
    balance_cents: int
    credit_cents: int
    open_invoices: list[InvoiceOut]
    recent_payments: list[PaymentOut]
    saved_cards: list[SavedCardOut]
    autopay_enabled: bool
    autopay_failures: int
    payments_enabled: bool


class BillingOverview(Schema):
    outstanding_cents: int
    collected_this_month_cents: int
    open_invoice_count: int
    uninvoiced_count: int


class SuperbillCreate(Schema):
    client_id: int
    period_start: date
    period_end: date

    @model_validator(mode="after")
    def _valid_period(self) -> Self:
        if self.period_end < self.period_start:
            raise ValueError("The period must end on or after its start")
        if self.period_end - self.period_start > timedelta(days=MAX_SUPERBILL_DAYS):
            raise ValueError("A superbill can cover at most one year")
        return self


class SuperbillPractice(Schema):
    """The practice's billing identity."""

    name: str
    address_lines: list[str]
    phone: str
    tax_id: str
    tax_id_type: TaxIdType
    npi: str  # group (type 2) NPI
    taxonomy_code: str
    billing_provider: BillingProviderType


class SuperbillProvider(Schema):
    """The clinician who provided a service (the rendering provider)."""

    name: str
    credentials: str
    npi: str  # individual (type 1) NPI
    taxonomy_code: str
    license: str


class SuperbillClient(Schema):
    name: str
    date_of_birth: date | None
    address_lines: list[str]
    phone: str


class SuperbillInsurance(Schema):
    """The client's primary insurance policy."""

    payer_name: str
    payer_id: str  # the payer's electronic payer ID, if it has one
    member_id: str
    group_number: str
    plan_name: str
    # The policyholder: the client themselves (relationship "Self") or e.g. a parent.
    subscriber_name: str
    subscriber_relationship: str
    subscriber_dob: date | None


class SuperbillDiagnosis(Schema):
    code: str
    description: str


class SuperbillLine(Schema):
    date: date
    cpt: str
    description: str
    place_of_service: str
    units: int
    fee_cents: int
    provider: SuperbillProvider


class SuperbillPayment(Schema):
    date: date
    method: str
    amount_cents: int


class SuperbillData(Schema):
    """Everything printed on a superbill, frozen when it was created."""

    practice: SuperbillPractice
    # The one clinician who provided every service, or None when several did.
    provider: SuperbillProvider | None
    client: SuperbillClient
    insurance: SuperbillInsurance | None
    diagnosis_codes: list[SuperbillDiagnosis]
    lines: list[SuperbillLine]
    payments: list[SuperbillPayment]
    total_cents: int
    paid_cents: int


class SuperbillOut(Schema):
    id: int
    client_id: int
    number: str
    period_start: date
    period_end: date
    total_cents: int
    paid_cents: int
    data: SuperbillData
    created_at: datetime


class PortalBillingSummary(Schema):
    balance_cents: int
    credit_cents: int
    payments_enabled: bool
    autopay_enabled: bool
    default_card: SavedCardOut | None


class CheckoutCreate(Schema):
    """Pay one invoice, a chosen amount, or (with neither) the whole balance."""

    invoice_id: int | None = None
    amount_cents: int | None = Field(default=None, gt=0, le=MAX_AMOUNT_CENTS)
    save_card: bool = False

    @model_validator(mode="after")
    def _one_target(self) -> Self:
        if self.invoice_id is not None and self.amount_cents is not None:
            raise ValueError("Choose an invoice or an amount, not both")
        return self


class CheckoutOut(Schema):
    url: str
