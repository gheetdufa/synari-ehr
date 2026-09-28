"""Patients' rights schemas: record requests (right of access), the accounting of disclosures,
amendment requests and the records-retention report."""

from datetime import date, datetime
from typing import Annotated, Literal, Self

from pydantic import StringConstraints, model_validator

from synari.models.enums import (
    AmendmentStatus,
    ClientStatus,
    DisclosureSource,
    RecordDelivery,
    RecordRequestStatus,
)
from synari.schemas.appointments import ClientRef
from synari.schemas.common import PartialUpdate, Schema
from synari.schemas.notes import StaffRef

RequestedBy = Literal["client", "contact", "staff"]


def _required(max_length: int) -> StringConstraints:
    return StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length)


def _optional(max_length: int) -> StringConstraints:
    return StringConstraints(strip_whitespace=True, max_length=max_length)


Scope = Annotated[str, _required(2000)]
Recipient = Annotated[str, _optional(1000)]
Reason = Annotated[str, _required(1000)]
DenialReason = Annotated[str, _required(2000)]
DeliveryNote = Annotated[str, _optional(500)]
RecipientName = Annotated[str, _required(200)]
RecipientAddress = Annotated[str, _optional(500)]
DisclosureDescription = Annotated[str, _required(2000)]
DisclosurePurpose = Annotated[str, _required(500)]
LegalBasis = Annotated[str, _optional(100)]
AmendmentText = Annotated[str, _required(5000)]
AddendumText = Annotated[str, _required(20_000)]


# Record requests


class RecordRequestFields(Schema):
    """What a client asked for and where it should go."""

    scope: Scope
    delivery: RecordDelivery = RecordDelivery.PORTAL
    recipient: Recipient = ""

    @model_validator(mode="after")
    def _recipient_for_third_party(self) -> Self:
        if self.delivery == RecordDelivery.THIRD_PARTY and not self.recipient:
            raise ValueError("Say who the copy should be sent to, and where")
        if self.delivery == RecordDelivery.PORTAL:
            self.recipient = ""
        return self


class PortalRecordRequestCreate(RecordRequestFields):
    """A client (or their contact) asking for a copy of their record in the portal."""


class RecordRequestCreate(RecordRequestFields):
    """A request staff enter on the client's behalf, e.g. from a letter. `received_at` is the
    day it arrived (today when left out)."""

    received_at: date | None = None


class ExtensionRequest(Schema):
    reason: Reason


class FulfillRequest(Schema):
    """How to release the copy. Billing records are included only when the person releasing it
    has billing access to the client. `note` says how a third-party copy was sent."""

    include_billing: bool = True
    note: DeliveryNote = ""


class PackageRequest(Schema):
    include_billing: bool = True


class DenyRequest(Schema):
    reason: DenialReason


class RecordRequestOut(Schema):
    id: int
    client: ClientRef
    requested_by: RequestedBy
    requested_by_contact_id: int | None
    received_at: datetime
    due_on: date
    # Days until the due date in the practice's time zone (negative once overdue).
    days_left: int
    overdue: bool
    extended_on: date | None
    extension_reason: str
    scope: str
    delivery: RecordDelivery
    recipient: str
    status: RecordRequestStatus
    fulfilled_at: datetime | None
    fulfilled_by: StaffRef | None
    release_expires_at: datetime | None
    release_available: bool
    denial_reason: str
    created_at: datetime


class PortalRecordRequestOut(Schema):
    id: int
    received_at: datetime
    due_on: date
    extended_on: date | None
    extension_reason: str
    scope: str
    delivery: RecordDelivery
    recipient: str
    status: RecordRequestStatus
    fulfilled_at: datetime | None
    denial_reason: str
    release_available: bool
    release_expires_at: datetime | None


# Accounting of disclosures


class DisclosureCreate(Schema):
    """A disclosure made outside the app (a letter, a fax, a phone call to a court...)."""

    disclosed_on: date
    recipient_name: RecipientName
    recipient_address: RecipientAddress = ""
    description: DisclosureDescription
    purpose: DisclosurePurpose
    legal_basis: LegalBasis = ""


class DisclosureUpdate(PartialUpdate):
    disclosed_on: date | None = None
    recipient_name: RecipientName | None = None
    recipient_address: RecipientAddress | None = None
    description: DisclosureDescription | None = None
    purpose: DisclosurePurpose | None = None
    legal_basis: LegalBasis | None = None


class PortalDisclosureOut(Schema):
    id: int
    disclosed_on: date
    recipient_name: str
    recipient_address: str
    description: str
    purpose: str
    legal_basis: str


class DisclosureOut(PortalDisclosureOut):
    client_id: int
    # manual entries can be edited or deleted; export and record_request ones can't.
    source: DisclosureSource
    record_request_id: int | None
    recorded_by: StaffRef | None
    created_at: datetime


class DisclosureReportOut(Schema):
    """The accounting of disclosures for the six years before `period_end`."""

    client_id: int
    client_name: str
    practice_name: str
    period_start: date
    period_end: date
    generated_at: datetime
    disclosures: list[DisclosureOut]


class PortalDisclosureReportOut(Schema):
    client_id: int
    client_name: str
    practice_name: str
    period_start: date
    period_end: date
    generated_at: datetime
    disclosures: list[PortalDisclosureOut]


# Amendments


class PortalAmendmentCreate(Schema):
    request: AmendmentText


class AmendmentCreate(Schema):
    """An amendment request staff enter on the client's behalf, optionally about one note."""

    request: AmendmentText
    note_id: int | None = None


class AmendmentAccept(Schema):
    """Accepting adds `content` as an addendum to the request's note (or `note_id`)."""

    content: AddendumText
    note_id: int | None = None


class AmendmentDeny(Schema):
    reason: DenialReason


class DisagreementCreate(Schema):
    statement: AmendmentText


class RebuttalCreate(Schema):
    rebuttal: AmendmentText


class AmendmentOut(Schema):
    id: int
    client: ClientRef
    note_id: int | None
    note_title: str
    requested_by: RequestedBy
    received_at: datetime
    due_on: date
    days_left: int
    overdue: bool
    request: str
    status: AmendmentStatus
    decided_at: datetime | None
    decided_by: StaffRef | None
    denial_reason: str
    disagreement: str
    rebuttal: str
    addendum_id: int | None
    created_at: datetime


class PortalAmendmentOut(Schema):
    id: int
    received_at: datetime
    due_on: date
    request: str
    status: AmendmentStatus
    decided_at: datetime | None
    denial_reason: str
    disagreement: str
    rebuttal: str
    can_disagree: bool


# Retention


class RetentionReportRow(Schema):
    """An archived client whose records have been kept past the practice's retention period."""

    client: ClientRef
    status: ClientStatus
    last_activity_at: datetime | None
    retention_ends_on: date
