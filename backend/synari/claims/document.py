"""A professional claim (837P / CMS-1500) described as plain frozen dataclasses.

Nothing here knows about the database or about any output format. Callers build a
`ClaimDocument` from their own records; `validate.py` checks it, and `x12_837p.py`, `stedi.py`
and `cms1500.py` turn it into an X12 file, a clearinghouse API request or a paper form.

Conventions:
- Money is integer cents. Dates are `datetime.date` values.
- Codes are the X12 code values themselves (for example sex "M"/"F"/"U", payer responsibility
  "P"/"S"/"T", claim frequency "1"/"7"/"8"), so they can be written out unchanged.
- ICD-10 codes are stored without the dot ("F411", not "F41.1").
- Identifiers (NPI, tax id, phone) are stored as digits only.
"""

from dataclasses import dataclass
from datetime import date
from typing import Literal

EntityType = Literal["individual", "organization"]
TaxIdType = Literal["EIN", "SSN"]


@dataclass(frozen=True)
class Address:
    """A US street address. `postal_code` is a 5 or 9 digit ZIP code without the hyphen."""

    line1: str
    city: str
    state: str
    postal_code: str
    line2: str = ""


@dataclass(frozen=True)
class PersonName:
    """A person's legal name as it appears on their insurance card."""

    first: str
    last: str
    middle: str = ""
    suffix: str = ""


@dataclass(frozen=True)
class Contact:
    """Someone the payer or clearinghouse can reach about the claim. `phone` is 10 digits."""

    name: str
    phone: str
    email: str = ""


@dataclass(frozen=True)
class BillingProvider:
    """Who gets paid: a group practice (type 2 NPI) or a solo clinician (type 1 NPI).

    Organizations set `organization_name`; individuals set `person`. The address must be a
    street address (payers reject PO boxes here); use `pay_to_address` to receive mail
    elsewhere.
    """

    entity_type: EntityType
    npi: str
    taxonomy: str
    tax_id: str
    tax_id_type: TaxIdType
    address: Address
    contact: Contact
    organization_name: str = ""
    person: PersonName | None = None
    pay_to_address: Address | None = None

    @property
    def display_name(self) -> str:
        """The organization name, or "First Last" for an individual."""
        if self.entity_type == "organization" or self.person is None:
            return self.organization_name
        return f"{self.person.first} {self.person.last}".strip()


@dataclass(frozen=True)
class Submitter:
    """The practice (or its billing service) sending the file, identified to the receiver."""

    name: str
    identifier: str
    contact: Contact


@dataclass(frozen=True)
class Receiver:
    """The clearinghouse or payer that receives the file."""

    name: str
    identifier: str


@dataclass(frozen=True)
class Payer:
    """An insurance company. `payer_id` is the electronic payer id used by the clearinghouse."""

    name: str
    payer_id: str
    address: Address | None = None


@dataclass(frozen=True)
class Subscriber:
    """The insured person (policyholder) and their coverage with the payer being billed.

    `claim_filing_indicator` is the X12 claim filing code: CI commercial, BL Blue Cross/Blue
    Shield, HM HMO, MB Medicare Part B, MC Medicaid, CH TRICARE, VA Veterans Affairs,
    11-17 other plan types, and so on.

    `payer_responsibility` is P when this payer is primary, S secondary, T tertiary.

    `patient_relationship` is the patient's relationship to this subscriber: "18" when the
    patient is the subscriber, otherwise 01 spouse, 19 child, 20 employee, 21 unknown,
    53 life partner or G8 other relationship. When it is not "18" the claim document must
    include a `Patient`.

    Birth date, sex and address are required when the subscriber is the patient.
    """

    member_id: str
    name: PersonName
    claim_filing_indicator: str
    payer_responsibility: str = "P"
    patient_relationship: str = "18"
    birth_date: date | None = None
    sex: str = "U"
    address: Address | None = None
    group_number: str = ""
    plan_name: str = ""

    @property
    def is_patient(self) -> bool:
        """True when the subscriber is the person who received the services."""
        return self.patient_relationship == "18"


@dataclass(frozen=True)
class Patient:
    """The person who received the services, when they are not the subscriber.

    Their relationship to the subscriber is `Subscriber.patient_relationship`.
    """

    name: PersonName
    birth_date: date
    sex: str
    address: Address


@dataclass(frozen=True)
class Provider:
    """A clinician on the claim (rendering, supervising or referring).

    `taxonomy` is required for the rendering provider only.
    """

    name: PersonName
    npi: str
    taxonomy: str = ""


@dataclass(frozen=True)
class ServiceFacility:
    """Where the services were provided, when that is not the billing provider's address."""

    name: str
    address: Address
    npi: str = ""


@dataclass(frozen=True)
class ClaimLine:
    """One service line (a CPT/HCPCS code on a date).

    `line_control_number` is our id for the line (up to 30 characters, sent as REF*6R). Payers
    echo it back on the remittance so payments can be matched to lines.

    `diagnosis_pointers` are 1-based positions into `Claim.diagnoses` (1 to 4 of them, the
    first being the primary diagnosis for this line). `place_of_service` overrides the claim's
    place of service for this line only. `rendering_provider` overrides the claim's rendering
    provider for this line only.
    """

    line_control_number: str
    service_date: date
    procedure_code: str
    charge_cents: int
    diagnosis_pointers: tuple[int, ...]
    modifiers: tuple[str, ...] = ()
    units: int = 1
    place_of_service: str = ""
    rendering_provider: Provider | None = None


@dataclass(frozen=True)
class Adjustment:
    """A payer adjustment: group code (CO, PR, OA, PI), CARC reason code and amount.

    Positive amounts reduce payment. `quantity` is the number of units adjusted, when given.
    """

    group_code: str
    reason_code: str
    amount_cents: int
    quantity: int = 0


@dataclass(frozen=True)
class LineAdjudication:
    """How another payer adjudicated one of our lines, matched by `line_control_number`."""

    line_control_number: str
    procedure_code: str
    paid_cents: int
    adjudication_date: date
    units: int = 1
    modifiers: tuple[str, ...] = ()
    adjustments: tuple[Adjustment, ...] = ()


@dataclass(frozen=True)
class OtherSubscriber:
    """The subscriber on the other (earlier) payer's policy, for coordination of benefits."""

    member_id: str
    name: PersonName
    claim_filing_indicator: str
    patient_relationship: str = "18"
    group_number: str = ""
    plan_name: str = ""
    address: Address | None = None


@dataclass(frozen=True)
class OtherPayer:
    """What an earlier payer did with this claim, sent with secondary or tertiary claims.

    `payer_responsibility` is that payer's position (P when it was primary). Adjustments are
    reported either per line (`line_adjudications`, preferred) or for the whole claim
    (`claim_adjustments`), never the same adjustment in both places.
    """

    payer: Payer
    subscriber: OtherSubscriber
    paid_cents: int
    adjudication_date: date
    payer_responsibility: str = "P"
    payer_claim_number: str = ""
    claim_adjustments: tuple[Adjustment, ...] = ()
    line_adjudications: tuple[LineAdjudication, ...] = ()


@dataclass(frozen=True)
class Claim:
    """One claim: the services, diagnoses and billing indicators.

    - `patient_control_number`: our claim id (up to 17 letters and digits). Payers return it on
      acknowledgments and remittances.
    - `place_of_service`: 11 office, 10 telehealth in the patient's home, 02 telehealth
      elsewhere, and so on.
    - `frequency_code`: "1" original, "7" replacement of a prior claim, "8" void of a prior
      claim. 7 and 8 require the payer's `payer_claim_number` for the original.
    - `assignment_code`: A assigned, B lab services only, C not assigned.
    - `benefits_assignment`: Y the patient assigned benefits to the provider, N no, W not
      applicable.
    - `release_of_information`: Y signed release on file, I informed consent without a
      signature.
    - `diagnoses`: 1 to 12 ICD-10 codes without the dot; the first is the principal diagnosis.
    - `rendering_provider`: the clinician who provided the services. Required when the billing
      provider is an organization; omit it when a solo clinician bills under their own NPI.
    - `total_charge_cents` must equal the sum of the line charges.
    """

    patient_control_number: str
    total_charge_cents: int
    place_of_service: str
    diagnoses: tuple[str, ...]
    lines: tuple[ClaimLine, ...]
    frequency_code: str = "1"
    payer_claim_number: str = ""
    provider_signature_on_file: bool = True
    assignment_code: str = "A"
    benefits_assignment: str = "Y"
    release_of_information: str = "Y"
    prior_authorization_number: str = ""
    onset_date: date | None = None
    rendering_provider: Provider | None = None
    supervising_provider: Provider | None = None
    referring_provider: Provider | None = None
    service_facility: ServiceFacility | None = None
    other_payer: OtherPayer | None = None


@dataclass(frozen=True)
class ClaimDocument:
    """Everything needed to bill one claim to one payer."""

    billing_provider: BillingProvider
    subscriber: Subscriber
    payer: Payer
    claim: Claim
    patient: Patient | None = None

    @property
    def patient_name(self) -> PersonName:
        """The name of the person who received the services."""
        return self.patient.name if self.patient else self.subscriber.name
