"""ASC X12 5010 837P (005010X222A1) professional claim files.

`build_837p` writes one interchange with one transaction set holding every claim in the batch.
Claims are grouped under their billing provider (loop 2000A); each claim gets its own
subscriber loop (2000B) and, when the client is not the subscriber, a patient loop (2000C).

Validate documents with `validate_claim` first; this module formats what it is given and
does not re-check it.
"""

from collections.abc import Sequence

from synari.claims.document import (
    Address,
    Adjustment,
    BillingProvider,
    ClaimDocument,
    ClaimLine,
    Contact,
    OtherPayer,
    PersonName,
    Provider,
    Receiver,
    Submitter,
)
from synari.claims.x12 import (
    Envelope,
    amount,
    composite,
    digits,
    identifier,
    interchange,
    segment,
    text,
    transaction_set,
    x12_date,
)

IMPLEMENTATION = "005010X222A1"
_CAS_TRIPLES_PER_SEGMENT = 6


def build_837p(
    documents: Sequence[ClaimDocument],
    envelope: Envelope,
    submitter: Submitter,
    receiver: Receiver,
) -> str:
    """An 837P interchange for `documents`, ready to upload to the receiver."""
    if not documents:
        raise ValueError("An 837P needs at least one claim.")
    writer = _Writer()
    writer.header(envelope, submitter, receiver)
    by_provider: dict[BillingProvider, list[ClaimDocument]] = {}
    for document in documents:
        by_provider.setdefault(document.billing_provider, []).append(document)
    for provider, provider_documents in by_provider.items():
        provider_hl = writer.billing_provider(provider)
        for document in provider_documents:
            writer.claim(document, provider_hl)
    body = transaction_set("837", "0001", IMPLEMENTATION, writer.segments)
    return interchange(envelope, "HC", IMPLEMENTATION, [body])


def _name_elements(name: PersonName) -> tuple[str, ...]:
    """NM103-NM107 for a person: last, first, middle, prefix (unused), suffix."""
    return (
        text(name.last, 60),
        text(name.first, 35),
        text(name.middle, 25),
        "",
        text(name.suffix, 10),
    )


class _Writer:
    """Accumulates the segments between ST and SE and numbers the HL loops."""

    def __init__(self) -> None:
        self.segments: list[str] = []
        self.hl_count = 0

    def add(self, tag: str, *elements: str) -> None:
        self.segments.append(segment(tag, *elements))

    def hl(self, parent: str, level: str, has_children: bool) -> str:
        self.hl_count += 1
        number = str(self.hl_count)
        self.add("HL", number, parent, level, "1" if has_children else "0")
        return number

    def address(self, address: Address) -> None:
        self.add("N3", text(address.line1, 55), text(address.line2, 55))
        self.add(
            "N4",
            text(address.city, 30),
            text(address.state, 2),
            identifier(address.postal_code, 15),
        )

    def contact(self, contact: Contact) -> None:
        elements = ["IC", text(contact.name, 60), "TE", digits(contact.phone)]
        if contact.email:
            elements += ["EM", identifier(contact.email, 256)]
        self.add("PER", *elements)

    def person(self, code: str, name: PersonName, qualifier: str, id_value: str) -> None:
        self.add("NM1", code, "1", *_name_elements(name), qualifier, identifier(id_value, 80))

    def organization(self, code: str, name: str, qualifier: str = "", id_value: str = "") -> None:
        self.add(
            "NM1", code, "2", text(name, 60), "", "", "", "", qualifier, identifier(id_value, 80)
        )

    def provider(self, code: str, provider: Provider, *, taxonomy: bool) -> None:
        self.person(code, provider.name, "XX", provider.npi)
        if taxonomy:
            self.add("PRV", "PE", "PXC", identifier(provider.taxonomy, 50))

    def adjustments(self, adjustments: Sequence[Adjustment]) -> None:
        """CAS segments: one per group code, up to six reason/amount/quantity triples each."""
        by_group: dict[str, list[Adjustment]] = {}
        for adjustment in adjustments:
            by_group.setdefault(adjustment.group_code, []).append(adjustment)
        for group_code, group in by_group.items():
            for start in range(0, len(group), _CAS_TRIPLES_PER_SEGMENT):
                elements = [group_code]
                for adjustment in group[start : start + _CAS_TRIPLES_PER_SEGMENT]:
                    quantity = str(adjustment.quantity) if adjustment.quantity else ""
                    elements += [
                        identifier(adjustment.reason_code, 5),
                        amount(adjustment.amount_cents),
                        quantity,
                    ]
                self.add("CAS", *elements)

    # Loops -----------------------------------------------------------------------------

    def header(self, envelope: Envelope, submitter: Submitter, receiver: Receiver) -> None:
        created = envelope.created_at
        self.add(
            "BHT",
            "0019",
            "00",
            f"{envelope.interchange_control_number:09d}",
            f"{created:%Y%m%d}",
            f"{created:%H%M}",
            "CH",
        )
        self.organization("41", submitter.name, "46", submitter.identifier)
        self.contact(submitter.contact)
        self.organization("40", receiver.name, "46", receiver.identifier)

    def billing_provider(self, provider: BillingProvider) -> str:
        """Loops 2000A, 2010AA and 2010AB; returns the HL number claims hang under."""
        number = self.hl("", "20", True)
        self.add("PRV", "BI", "PXC", identifier(provider.taxonomy, 50))
        if provider.entity_type == "organization" or provider.person is None:
            self.organization("85", provider.organization_name, "XX", provider.npi)
        else:
            self.person("85", provider.person, "XX", provider.npi)
        self.address(provider.address)
        self.add("REF", "EI" if provider.tax_id_type == "EIN" else "SY", digits(provider.tax_id))
        self.contact(provider.contact)
        if provider.pay_to_address is not None:
            self.add("NM1", "87", "2")
            self.address(provider.pay_to_address)
        return number

    def claim(self, document: ClaimDocument, provider_hl: str) -> None:
        """Loops 2000B, 2010BA, 2010BB, optional 2000C/2010CA, then 2300 and its lines."""
        subscriber = document.subscriber
        patient = document.patient
        subscriber_hl = self.hl(provider_hl, "22", patient is not None)
        self.add(
            "SBR",
            subscriber.payer_responsibility,
            "18" if patient is None else "",
            text(subscriber.group_number, 50),
            "" if subscriber.group_number else text(subscriber.plan_name, 60),
            "",
            "",
            "",
            "",
            subscriber.claim_filing_indicator,
        )
        self.person("IL", subscriber.name, "MI", subscriber.member_id)
        if patient is None:
            if subscriber.address is not None:
                self.address(subscriber.address)
            if subscriber.birth_date is not None:
                self.add("DMG", "D8", x12_date(subscriber.birth_date), subscriber.sex)
        self.organization("PR", document.payer.name, "PI", document.payer.payer_id)
        if document.payer.address is not None:
            self.address(document.payer.address)

        if patient is not None:
            self.hl(subscriber_hl, "23", False)
            self.add("PAT", subscriber.patient_relationship)
            self.add("NM1", "QC", "1", *_name_elements(patient.name))
            self.address(patient.address)
            self.add("DMG", "D8", x12_date(patient.birth_date), patient.sex)

        self.claim_information(document)
        for index, line in enumerate(document.claim.lines, start=1):
            self.service_line(document, line, index)

    def claim_information(self, document: ClaimDocument) -> None:
        """Loop 2300 with its provider (2310x) and other-payer (2320/2330x) loops."""
        claim = document.claim
        self.add(
            "CLM",
            identifier(claim.patient_control_number, 38),
            amount(claim.total_charge_cents),
            "",
            "",
            composite(claim.place_of_service, "B", claim.frequency_code),
            "Y" if claim.provider_signature_on_file else "N",
            claim.assignment_code,
            claim.benefits_assignment,
            claim.release_of_information,
        )
        if claim.onset_date is not None:
            self.add("DTP", "431", "D8", x12_date(claim.onset_date))
        if claim.prior_authorization_number:
            self.add("REF", "G1", identifier(claim.prior_authorization_number, 50))
        if claim.frequency_code in ("7", "8"):
            self.add("REF", "F8", identifier(claim.payer_claim_number, 50))
        self.add(
            "HI",
            *(
                composite("ABK" if index == 0 else "ABF", identifier(code, 30))
                for index, code in enumerate(claim.diagnoses)
            ),
        )
        if claim.referring_provider is not None:
            self.provider("DN", claim.referring_provider, taxonomy=False)
        rendering = claim.rendering_provider
        if rendering is not None and rendering.npi != document.billing_provider.npi:
            self.provider("82", rendering, taxonomy=True)
        if claim.service_facility is not None:
            facility = claim.service_facility
            self.organization("77", facility.name, "XX" if facility.npi else "", facility.npi)
            self.address(facility.address)
        if claim.supervising_provider is not None:
            self.provider("DQ", claim.supervising_provider, taxonomy=False)
        if claim.other_payer is not None:
            self.other_payer(document, claim.other_payer)

    def other_payer(self, document: ClaimDocument, other: OtherPayer) -> None:
        """Loops 2320 (what the other payer did), 2330A (its subscriber) and 2330B (payer)."""
        subscriber = other.subscriber
        self.add(
            "SBR",
            other.payer_responsibility,
            subscriber.patient_relationship,
            text(subscriber.group_number, 50),
            "" if subscriber.group_number else text(subscriber.plan_name, 60),
            "",
            "",
            "",
            "",
            subscriber.claim_filing_indicator,
        )
        self.adjustments(other.claim_adjustments)
        self.add("AMT", "D", amount(other.paid_cents))
        claim = document.claim
        self.add("OI", "", "", claim.benefits_assignment, "", "", claim.release_of_information)
        self.person("IL", subscriber.name, "MI", subscriber.member_id)
        if subscriber.address is not None:
            self.address(subscriber.address)
        self.organization("PR", other.payer.name, "PI", other.payer.payer_id)
        if other.payer.address is not None:
            self.address(other.payer.address)
        if not other.line_adjudications:
            self.add("DTP", "573", "D8", x12_date(other.adjudication_date))
        if other.payer_claim_number:
            self.add("REF", "F8", identifier(other.payer_claim_number, 50))

    def service_line(self, document: ClaimDocument, line: ClaimLine, number: int) -> None:
        """Loop 2400 with an optional line rendering provider (2420A) and COB (2430)."""
        claim = document.claim
        self.add("LX", str(number))
        place = line.place_of_service if line.place_of_service != claim.place_of_service else ""
        self.add(
            "SV1",
            composite("HC", identifier(line.procedure_code, 48), *line.modifiers),
            amount(line.charge_cents),
            "UN",
            str(line.units),
            place,
            "",
            composite(*(str(pointer) for pointer in line.diagnosis_pointers)),
        )
        self.add("DTP", "472", "D8", x12_date(line.service_date))
        self.add("REF", "6R", identifier(line.line_control_number, 50))
        rendering = line.rendering_provider
        if rendering is not None and rendering.npi != _rendering_npi(document):
            self.provider("82", rendering, taxonomy=True)
        other = claim.other_payer
        if other is None:
            return
        for adjudication in other.line_adjudications:
            if adjudication.line_control_number != line.line_control_number:
                continue
            self.add(
                "SVD",
                identifier(other.payer.payer_id, 80),
                amount(adjudication.paid_cents),
                composite(
                    "HC", identifier(adjudication.procedure_code, 48), *adjudication.modifiers
                ),
                "",
                str(adjudication.units),
            )
            self.adjustments(adjudication.adjustments)
            self.add("DTP", "573", "D8", x12_date(adjudication.adjudication_date))


def _rendering_npi(document: ClaimDocument) -> str:
    """The NPI the payer treats as the claim's rendering provider."""
    rendering = document.claim.rendering_provider
    return rendering.npi if rendering is not None else document.billing_provider.npi
