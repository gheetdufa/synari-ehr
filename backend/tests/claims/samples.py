"""Sample claim documents shared by the claims tests. All people, ids and numbers are fictional."""

from dataclasses import replace
from datetime import UTC, date, datetime

from synari.claims.document import (
    Address,
    Adjustment,
    BillingProvider,
    Claim,
    ClaimDocument,
    ClaimLine,
    Contact,
    LineAdjudication,
    OtherPayer,
    OtherSubscriber,
    Patient,
    Payer,
    PersonName,
    Provider,
    Receiver,
    ServiceFacility,
    Submitter,
    Subscriber,
)
from synari.claims.x12 import Envelope

SUBMITTER = Submitter(
    name="Maple Counseling",
    identifier="MAPLE01",
    contact=Contact(name="Dana Ortiz", phone="5035550100", email="billing@maple.test"),
)
RECEIVER = Receiver(name="Test Clearinghouse", identifier="CLEARHOUSE")
ENVELOPE = Envelope(
    sender_id="MAPLE01",
    receiver_id="CLEARHOUSE",
    interchange_control_number=42,
    group_control_number=42,
    created_at=datetime(2026, 9, 20, 14, 5, tzinfo=UTC),
)

EVERGREEN = Payer(name="Evergreen Health Plan", payer_id="EVRGN")
CASCADE = Payer(
    name="Cascade Mutual",
    payer_id="CSCDM",
    address=Address(line1="PO Box 900", city="Salem", state="OR", postal_code="97301"),
)

SOLO_CLINICIAN = BillingProvider(
    entity_type="individual",
    person=PersonName(first="Ana", last="Rivera"),
    npi="1234567893",
    taxonomy="1041C0700X",
    tax_id="234567891",
    tax_id_type="SSN",
    address=Address(
        line1="200 Main St", line2="Suite 4", city="Portland", state="OR", postal_code="972051234"
    ),
    contact=Contact(name="Ana Rivera", phone="5035550111"),
)

GROUP_PRACTICE = BillingProvider(
    entity_type="organization",
    organization_name="Maple Counseling Group",
    npi="1111111112",
    taxonomy="261QM0801X",
    tax_id="987654321",
    tax_id_type="EIN",
    address=Address(line1="500 Cedar Blvd", city="Seattle", state="WA", postal_code="981011234"),
    contact=Contact(name="Dana Ortiz", phone="2065550199", email="billing@maple.test"),
    pay_to_address=Address(line1="PO Box 1234", city="Seattle", state="WA", postal_code="98111"),
)

ASSOCIATE = Provider(
    name=PersonName(first="Sam", last="Patel"), npi="1222222220", taxonomy="101YM0800X"
)
SUPERVISOR = Provider(name=PersonName(first="Lee", last="Chen", middle="A"), npi="1333333338")
REFERRER = Provider(name=PersonName(first="Robin", last="Kim"), npi="1444444446")


def individual_claim() -> ClaimDocument:
    """A solo clinician billing under their own NPI; the client is the subscriber."""
    return ClaimDocument(
        billing_provider=SOLO_CLINICIAN,
        payer=EVERGREEN,
        subscriber=Subscriber(
            member_id="EVG123456789",
            name=PersonName(first="Jordan", last="Lee"),
            claim_filing_indicator="CI",
            birth_date=date(1990, 4, 12),
            sex="F",
            address=Address(
                line1="15 Oak Ave", city="Portland", state="OR", postal_code="972091234"
            ),
            group_number="GRP100",
        ),
        claim=Claim(
            patient_control_number="C1001",
            total_charge_cents=15000,
            place_of_service="10",
            diagnoses=("F411", "F331"),
            lines=(
                ClaimLine(
                    line_control_number="C1001-1",
                    service_date=date(2026, 9, 15),
                    procedure_code="90837",
                    modifiers=("95",),
                    charge_cents=15000,
                    diagnosis_pointers=(1, 2),
                ),
            ),
        ),
    )


def group_claim() -> ClaimDocument:
    """A group practice billing for a supervised associate; the client is a dependent child."""
    return ClaimDocument(
        billing_provider=GROUP_PRACTICE,
        payer=EVERGREEN,
        subscriber=Subscriber(
            member_id="EVG555000111",
            name=PersonName(first="Morgan", last="Smith", suffix="Jr"),
            claim_filing_indicator="BL",
            patient_relationship="19",
            plan_name="Evergreen Family PPO",
        ),
        patient=Patient(
            name=PersonName(first="Riley", last="Smith"),
            birth_date=date(2014, 6, 3),
            sex="M",
            address=Address(line1="88 Pine St", city="Bellevue", state="WA", postal_code="98004"),
        ),
        claim=Claim(
            patient_control_number="C2002",
            total_charge_cents=32050,
            place_of_service="11",
            diagnoses=("F902", "F4323", "Z634"),
            prior_authorization_number="PA12345",
            onset_date=date(2026, 8, 15),
            rendering_provider=ASSOCIATE,
            supervising_provider=SUPERVISOR,
            referring_provider=REFERRER,
            service_facility=ServiceFacility(
                name="Maple Counseling Bellevue",
                npi="1555555550",
                address=Address(
                    line1="12 Lake Way", city="Bellevue", state="WA", postal_code="980041002"
                ),
            ),
            lines=(
                ClaimLine(
                    line_control_number="C2002-1",
                    service_date=date(2026, 9, 1),
                    procedure_code="90791",
                    charge_cents=18000,
                    diagnosis_pointers=(1, 2),
                ),
                ClaimLine(
                    line_control_number="C2002-2",
                    service_date=date(2026, 9, 8),
                    procedure_code="90834",
                    modifiers=("95", "HO"),
                    charge_cents=14050,
                    diagnosis_pointers=(1, 3),
                    place_of_service="02",
                ),
            ),
        ),
    )


def corrected_claim() -> ClaimDocument:
    """The individual claim resubmitted as a replacement (frequency 7)."""
    document = individual_claim()
    return replace(
        document,
        claim=replace(document.claim, frequency_code="7", payer_claim_number="EVG20260915001"),
    )


def secondary_claim() -> ClaimDocument:
    """The individual claim sent to the secondary payer after Evergreen paid $90."""
    document = individual_claim()
    return replace(
        document,
        payer=CASCADE,
        subscriber=replace(
            document.subscriber,
            member_id="CM7788",
            payer_responsibility="S",
            group_number="",
            plan_name="Cascade Gold",
        ),
        claim=replace(
            document.claim,
            other_payer=OtherPayer(
                payer=EVERGREEN,
                subscriber=OtherSubscriber(
                    member_id="EVG123456789",
                    name=PersonName(first="Jordan", last="Lee"),
                    claim_filing_indicator="CI",
                    group_number="GRP100",
                ),
                paid_cents=9000,
                adjudication_date=date(2026, 9, 18),
                payer_claim_number="EVG20260915001",
                line_adjudications=(
                    LineAdjudication(
                        line_control_number="C1001-1",
                        procedure_code="90837",
                        modifiers=("95",),
                        paid_cents=9000,
                        adjudication_date=date(2026, 9, 18),
                        adjustments=(
                            Adjustment(group_code="CO", reason_code="45", amount_cents=3000),
                            Adjustment(group_code="PR", reason_code="2", amount_cents=2500),
                            Adjustment(group_code="PR", reason_code="3", amount_cents=500),
                        ),
                    ),
                ),
            ),
        ),
    )
