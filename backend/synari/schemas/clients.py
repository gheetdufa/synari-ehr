"""Client, contact, care team and insurance schemas."""

import re
from datetime import date, datetime
from typing import TYPE_CHECKING, Annotated, Literal, Self

from pydantic import AfterValidator, AliasPath, Field, field_validator, model_validator

from synari.models.enums import BillingType, ClientStatus, ExportPurpose
from synari.schemas.common import Email, LongText, PartialUpdate, Schema, ShortText, TimeZone

if TYPE_CHECKING:
    from synari.models import Client

_ICD10 = re.compile(r"^[A-TV-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$")


def _icd10(value: str) -> str:
    code = value.strip().upper()
    if not _ICD10.match(code):
        raise ValueError(f"{code} is not a valid ICD-10 code")
    return code


class DiagnosisCode(Schema):
    code: Annotated[str, Field(max_length=10), AfterValidator(_icd10)]
    description: ShortText = ""


def _strip(value: str) -> str:
    return value.strip()


Name = Annotated[str, Field(min_length=1, max_length=100), AfterValidator(_strip)]
OptionalName = Annotated[str, Field(max_length=100), AfterValidator(_strip)]
Phone = Annotated[str, Field(max_length=30)]


class ClientFields(Schema):
    preferred_name: ShortText = ""
    pronouns: ShortText = ""
    date_of_birth: date | None = None
    sex: str = Field(default="", max_length=20)
    gender_identity: ShortText = ""
    email: Email | None = None
    phone: str = Field(default="", max_length=30)
    address_line1: ShortText = ""
    address_line2: ShortText = ""
    city: ShortText = ""
    state: ShortText = ""
    postal_code: str = Field(default="", max_length=20)
    time_zone: TimeZone | None = None
    is_minor: bool = False
    referral_source: ShortText = ""
    internal_notes: LongText = ""
    diagnosis_codes: list[DiagnosisCode] = Field(default_factory=list, max_length=12)
    billing_type: BillingType = BillingType.SELF_PAY
    default_service_id: int | None = None
    rate_override_cents: int | None = Field(default=None, ge=0)
    email_reminders: bool = True
    sms_reminders: bool = False
    portal_enabled: bool = True
    portal_messaging: bool = True
    portal_booking: bool = True
    portal_billing: bool = True


class ClientCreate(ClientFields):
    first_name: Name
    last_name: Name
    status: ClientStatus = ClientStatus.ACTIVE
    # Defaults to the creator when they're a clinician; required otherwise.
    primary_clinician_id: int | None = None
    send_portal_invite: bool = False


class ClientUpdate(PartialUpdate):
    """Partial update: only fields present in the request are changed."""

    NULLABLE = frozenset(
        {"date_of_birth", "email", "time_zone", "default_service_id", "rate_override_cents"}
    )

    first_name: Name | None = None
    last_name: Name | None = None
    status: ClientStatus | None = None
    preferred_name: ShortText | None = None
    pronouns: ShortText | None = None
    date_of_birth: date | None = None
    sex: str | None = Field(default=None, max_length=20)
    gender_identity: ShortText | None = None
    email: Email | None = None
    phone: str | None = Field(default=None, max_length=30)
    address_line1: ShortText | None = None
    address_line2: ShortText | None = None
    city: ShortText | None = None
    state: ShortText | None = None
    postal_code: str | None = Field(default=None, max_length=20)
    time_zone: TimeZone | None = None
    is_minor: bool | None = None
    referral_source: ShortText | None = None
    internal_notes: LongText | None = None
    diagnosis_codes: list[DiagnosisCode] | None = Field(default=None, max_length=12)
    billing_type: BillingType | None = None
    default_service_id: int | None = None
    rate_override_cents: int | None = Field(default=None, ge=0)
    email_reminders: bool | None = None
    sms_reminders: bool | None = None
    autopay_enabled: bool | None = None
    portal_enabled: bool | None = None
    portal_messaging: bool | None = None
    portal_booking: bool | None = None
    portal_billing: bool | None = None


class ClientExportRequest(Schema):
    """Why a client's record is being exported. Anything other than treatment, payment,
    operations or giving it to the client is a disclosure: name the recipient and describe what
    was disclosed and why, for the client's accounting of disclosures."""

    purpose: ExportPurpose
    recipient_name: ShortText = ""
    recipient_address: Annotated[str, Field(max_length=500)] = ""
    description: Annotated[str, Field(max_length=2000)] = ""
    legal_basis: Annotated[str, Field(max_length=100)] = ""

    @model_validator(mode="after")
    def _disclosure_details(self) -> Self:
        if self.purpose == ExportPurpose.OTHER and not (
            self.recipient_name.strip() and self.description.strip()
        ):
            raise ValueError("Name the recipient and describe the disclosure")
        return self


class CareTeamUpdate(Schema):
    """The client's clinicians; the primary clinician is always part of the team."""

    primary_clinician_id: int
    clinician_ids: list[int] = Field(default_factory=list, max_length=50)


class CareTeamMember(Schema):
    staff_id: int
    name: str = Field(validation_alias=AliasPath("staff", "display_name"))
    is_primary: bool


class RecordAccess(Schema):
    """Which restricted parts of a client's record the signed-in staff member may open."""

    clinical: bool
    billing: bool


class ClientSummary(Schema):
    id: int
    first_name: str
    last_name: str
    preferred_name: str
    status: ClientStatus
    email: str | None
    phone: str
    date_of_birth: date | None
    created_at: datetime
    care_team: list[CareTeamMember]

    @field_validator("care_team")
    @classmethod
    def _primary_first(cls, members: list[CareTeamMember]) -> list[CareTeamMember]:
        return sorted(members, key=lambda member: (not member.is_primary, member.name))


class ContactFields(Schema):
    """Someone connected to a client: a parent or guardian, partner or emergency contact.

    Portal access lets the contact sign in to the client's portal with their email. Only one
    contact is responsible for billing; marking another one moves it.
    """

    first_name: Name
    last_name: OptionalName = ""
    relation: str = Field(default="", max_length=50)
    email: Email | None = None
    phone: Phone = ""
    is_emergency_contact: bool = False
    is_guardian: bool = False
    responsible_for_billing: bool = False
    portal_access: bool = False


class ContactUpdate(PartialUpdate):
    """Partial update: only fields present in the request are changed."""

    NULLABLE = frozenset({"email"})

    first_name: Name | None = None
    last_name: OptionalName | None = None
    relation: str | None = Field(default=None, max_length=50)
    email: Email | None = None
    phone: Phone | None = None
    is_emergency_contact: bool | None = None
    is_guardian: bool | None = None
    responsible_for_billing: bool | None = None
    portal_access: bool | None = None


class ContactOut(ContactFields):
    id: int
    client_id: int
    portal_last_login_at: datetime | None
    created_at: datetime


class ClientProfile(ClientSummary):
    """Everything on a client's record that anyone who can see the client may read."""

    pronouns: str
    sex: str
    gender_identity: str
    address_line1: str
    address_line2: str
    city: str
    state: str
    postal_code: str
    time_zone: str | None
    is_minor: bool
    contacts: list[ContactOut]
    referral_source: str
    billing_type: BillingType
    default_service_id: int | None
    rate_override_cents: int | None
    autopay_enabled: bool
    email_reminders: bool
    sms_reminders: bool
    sms_opted_out: bool
    portal_enabled: bool
    portal_messaging: bool
    portal_booking: bool
    portal_billing: bool
    portal_last_login_at: datetime | None
    updated_at: datetime


class ClientOut(ClientProfile):
    """A client's record as the viewer may see it: fields outside their access are null.

    Internal notes need clinical access; diagnoses need clinical or billing access (they go
    on claims and superbills).
    """

    internal_notes: str | None
    diagnosis_codes: list[DiagnosisCode] | None
    access: RecordAccess

    @classmethod
    def build(cls, client: "Client", access: RecordAccess) -> Self:
        """The client's record, leaving out what `access` doesn't cover."""
        return cls(
            **dict(ClientProfile.model_validate(client)),
            internal_notes=client.internal_notes if access.clinical else None,
            diagnosis_codes=client.diagnosis_codes if access.clinical or access.billing else None,
            access=access,
        )


# X12 patient-to-subscriber relationship codes: 18 self, 01 spouse, 19 child, 20 employee,
# 21 unknown, 53 life partner, G8 other relationship.
SubscriberRelationship = Literal["18", "01", "19", "20", "21", "53", "G8"]
SELF = "18"


def _upper(value: str) -> str:
    return value.strip().upper()


class InsurancePolicyBase(Schema):
    payer_id: int
    rank: str = Field(default="primary", pattern="^(primary|secondary|other)$")
    member_id: str = Field(default="", max_length=100)
    group_number: str = Field(default="", max_length=100)
    plan_name: ShortText = ""
    subscriber_relationship: SubscriberRelationship = SELF
    subscriber_first_name: OptionalName = ""
    subscriber_last_name: OptionalName = ""
    subscriber_dob: date | None = None
    subscriber_sex: Literal["", "M", "F", "U"] = ""
    subscriber_address_line1: ShortText = ""
    subscriber_address_line2: ShortText = ""
    subscriber_city: str = Field(default="", max_length=100)
    subscriber_state: str = Field(default="", max_length=50)
    subscriber_postal_code: str = Field(default="", max_length=20)
    # Blank uses the payer's claim filing indicator.
    claim_filing_indicator: Annotated[
        str, AfterValidator(_upper), Field(pattern="^([A-Za-z0-9]{2})?$")
    ] = ""
    effective_date: date | None = None
    termination_date: date | None = None
    copay_cents: int | None = Field(default=None, ge=0)
    coinsurance_percent: int | None = Field(default=None, ge=0, le=100)


class InsurancePolicyFields(InsurancePolicyBase):
    """A client's coverage with one of the practice's payers.

    With subscriber_relationship "18" the client is the subscriber (policyholder); otherwise
    the subscriber's name, date of birth and sex are required.
    """

    @model_validator(mode="after")
    def _check_subscriber_and_dates(self) -> Self:
        if self.subscriber_relationship != SELF:
            missing = [
                label
                for label, value in (
                    ("first name", self.subscriber_first_name),
                    ("last name", self.subscriber_last_name),
                    ("date of birth", self.subscriber_dob),
                    ("sex", self.subscriber_sex),
                )
                if not value
            ]
            if missing:
                raise ValueError(
                    f"Enter the subscriber's {', '.join(missing)} when the client isn't the "
                    "subscriber"
                )
        if (
            self.effective_date is not None
            and self.termination_date is not None
            and self.termination_date < self.effective_date
        ):
            raise ValueError("The termination date can't be before the effective date")
        return self


class PayerRef(Schema):
    id: int
    name: str
    external_id: str


class AuthorizationRef(Schema):
    """A prior authorization on the policy (managed through the insurance API)."""

    id: int
    number: str
    start_date: date
    end_date: date
    visits_authorized: int | None


class InsurancePolicyOut(InsurancePolicyBase):
    id: int
    client_id: int
    payer: PayerRef
    authorizations: list[AuthorizationRef]
