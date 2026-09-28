"""Claim documents from the database, and the checks that run before a claim is sent.

`claim_document` turns a Claim row plus the current practice, clinician, client, policy and
payer records into the DB-free `synari.claims.document.ClaimDocument`. Secondary claims carry
the primary payer's adjudication (coordination of benefits) from its posted remittance, stored
per RemittanceClaim as JSON (`payment_detail` / `stored_payment`).

`claim_issues` combines checks against our records (with messages saying where to fix them)
with the claims engine's own `validate_claim`.
"""

import json
from collections.abc import Sequence
from dataclasses import asdict
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.claims import document as doc
from synari.claims.document import Adjustment, ClaimDocument
from synari.claims.responses import ClaimPayment, ServicePayment
from synari.claims.validate import ClaimIssue, validate_claim
from synari.claims.x12 import digits
from synari.db import utcnow
from synari.models import (
    AppointmentParticipant,
    Claim,
    ClaimLine,
    Client,
    InsurancePolicy,
    Payer,
    Practice,
    RemittanceClaim,
    StaffMember,
)
from synari.models.enums import (
    AppointmentStatus,
    BillingProviderType,
    ClaimSubmissionMethod,
    TaxIdType,
)
from synari.services.billing import local_date
from synari.services.scheduling import zone_of

# The subscriber relationship meaning the client is the subscriber.
SELF = "18"
_MALE = frozenset({"M", "MALE", "MAN"})
_FEMALE = frozenset({"F", "FEMALE", "WOMAN"})


def policy_active_on(policy: InsurancePolicy, day: date) -> bool:
    """Whether the policy covered `day` (open-ended dates count as covered)."""
    started = policy.effective_date is None or policy.effective_date <= day
    return started and (policy.termination_date is None or day <= policy.termination_date)


# The claim document ------------------------------------------------------------------------


def phone_digits(value: str) -> str:
    """A US phone number as its 10 digits (a leading 1 dropped)."""
    number = digits(value)
    return number[1:] if len(number) == 11 and number.startswith("1") else number


def _address(line1: str, line2: str, city: str, state: str, postal_code: str) -> doc.Address | None:
    """An address, or None when every part is blank."""
    if not any(part.strip() for part in (line1, line2, city, state, postal_code)):
        return None
    return doc.Address(
        line1=line1.strip(),
        line2=line2.strip(),
        city=city.strip(),
        state=state.strip().upper(),
        postal_code=digits(postal_code),
    )


def _client_address(client: Client) -> doc.Address | None:
    return _address(
        client.address_line1, client.address_line2, client.city, client.state, client.postal_code
    )


def _sex(value: str) -> str:
    word = value.strip().upper()
    if word in _MALE:
        return "M"
    if word in _FEMALE:
        return "F"
    return "U"


def _person(first: str, last: str) -> doc.PersonName:
    return doc.PersonName(first=first.strip(), last=last.strip())


def _provider(clinician: StaffMember) -> doc.Provider:
    return doc.Provider(
        name=_person(clinician.first_name, clinician.last_name),
        npi=clinician.npi.strip(),
        taxonomy=clinician.taxonomy_code.strip(),
    )


def _payer(payer: Payer) -> doc.Payer:
    return doc.Payer(
        name=payer.name.strip(),
        payer_id=payer.external_id.strip(),
        address=_address(
            payer.address_line1, payer.address_line2, payer.city, payer.state, payer.postal_code
        ),
    )


def billing_provider(practice: Practice, clinician: StaffMember | None) -> doc.BillingProvider:
    """The practice under its group NPI, or `clinician` under their own NPI.

    `clinician` may be None only for practices billing as an organization.
    """
    address = _address(
        practice.address_line1,
        practice.address_line2,
        practice.city,
        practice.state,
        practice.postal_code,
    ) or doc.Address(line1="", city="", state="", postal_code="")
    common: dict[str, Any] = {
        "tax_id": digits(practice.tax_id),
        "tax_id_type": "SSN" if practice.tax_id_type == TaxIdType.SSN else "EIN",
        "address": address,
        "contact": doc.Contact(name=practice.name.strip(), phone=phone_digits(practice.phone)),
    }
    if practice.billing_provider == BillingProviderType.ORGANIZATION:
        return doc.BillingProvider(
            entity_type="organization",
            organization_name=practice.name.strip(),
            npi=practice.npi.strip(),
            taxonomy=practice.taxonomy_code.strip(),
            **common,
        )
    if clinician is None:
        raise ValueError("Practices that bill individually need the billing clinician.")
    return doc.BillingProvider(
        entity_type="individual",
        person=_person(clinician.first_name, clinician.last_name),
        npi=clinician.npi.strip(),
        taxonomy=(clinician.taxonomy_code or practice.taxonomy_code).strip(),
        **common,
    )


def _subscriber_name(policy: InsurancePolicy) -> doc.PersonName:
    if policy.subscriber_relationship == SELF:
        return _person(policy.client.first_name, policy.client.last_name)
    return _person(policy.subscriber_first_name, policy.subscriber_last_name)


def _filing_indicator(policy: InsurancePolicy) -> str:
    return policy.claim_filing_indicator or policy.payer.claim_filing_indicator


def _subscriber(
    policy: InsurancePolicy, payer_responsibility: str
) -> tuple[doc.Subscriber, doc.Patient | None]:
    """The subscriber loop, plus the patient loop when the client isn't the subscriber."""
    client = policy.client
    common: dict[str, Any] = {
        "member_id": policy.member_id.strip(),
        "name": _subscriber_name(policy),
        "claim_filing_indicator": _filing_indicator(policy),
        "payer_responsibility": payer_responsibility,
        "patient_relationship": policy.subscriber_relationship,
        "group_number": policy.group_number.strip(),
        "plan_name": policy.plan_name.strip(),
    }
    if policy.subscriber_relationship == SELF:
        subscriber = doc.Subscriber(
            birth_date=client.date_of_birth,
            sex=_sex(client.sex),
            address=_client_address(client),
            **common,
        )
        return subscriber, None
    subscriber = doc.Subscriber(
        birth_date=policy.subscriber_dob,
        sex=_sex(policy.subscriber_sex),
        address=_address(
            policy.subscriber_address_line1,
            policy.subscriber_address_line2,
            policy.subscriber_city,
            policy.subscriber_state,
            policy.subscriber_postal_code,
        ),
        **common,
    )
    if client.date_of_birth is None:
        return subscriber, None
    patient = doc.Patient(
        name=_person(client.first_name, client.last_name),
        birth_date=client.date_of_birth,
        sex=_sex(client.sex),
        address=_client_address(client) or doc.Address(line1="", city="", state="", postal_code=""),
    )
    return subscriber, patient


def _adjustment(data: dict[str, Any]) -> Adjustment:
    return Adjustment(
        group_code=data["group_code"],
        reason_code=data["reason_code"],
        amount_cents=data["amount_cents"],
        quantity=data.get("quantity", 0),
    )


def _adjustment_json(adjustment: Adjustment) -> dict[str, Any]:
    return {
        "group_code": adjustment.group_code,
        "reason_code": adjustment.reason_code,
        "amount_cents": adjustment.amount_cents,
        "quantity": adjustment.quantity,
    }


def payment_detail(payment: ClaimPayment) -> dict[str, Any]:
    """A claim payment's adjustments and service lines as JSON (RemittanceClaim.detail)."""
    return {
        "adjustments": [_adjustment_json(a) for a in payment.adjustments],
        "lines": [
            {
                "procedure_code": line.procedure_code,
                "modifiers": list(line.modifiers),
                "units": line.units,
                "line_control_number": line.line_control_number,
                "service_date": line.service_date.isoformat() if line.service_date else None,
                "charge_cents": line.charge_cents,
                "paid_cents": line.paid_cents,
                "allowed_cents": line.allowed_cents,
                "adjustments": [_adjustment_json(a) for a in line.adjustments],
                "remark_codes": list(line.remark_codes),
            }
            for line in payment.lines
        ],
    }


def stored_payment(remittance_claim: RemittanceClaim) -> ClaimPayment:
    """The claim payment a RemittanceClaim row recorded, as the engine's dataclass."""
    detail = remittance_claim.detail or {}
    return ClaimPayment(
        patient_control_number=remittance_claim.patient_control_number,
        status_code=remittance_claim.status_code,
        charge_cents=remittance_claim.charge_cents,
        paid_cents=remittance_claim.paid_cents,
        patient_responsibility_cents=remittance_claim.patient_responsibility_cents,
        payer_claim_number=remittance_claim.payer_claim_number,
        adjustments=tuple(_adjustment(a) for a in detail.get("adjustments", [])),
        lines=tuple(
            ServicePayment(
                procedure_code=line["procedure_code"],
                charge_cents=line["charge_cents"],
                paid_cents=line["paid_cents"],
                modifiers=tuple(line.get("modifiers", [])),
                units=line.get("units", 1),
                line_control_number=line.get("line_control_number", ""),
                service_date=date.fromisoformat(line["service_date"])
                if line.get("service_date")
                else None,
                allowed_cents=line.get("allowed_cents"),
                adjustments=tuple(_adjustment(a) for a in line.get("adjustments", [])),
                remark_codes=tuple(line.get("remark_codes", [])),
            )
            for line in detail.get("lines", [])
        ),
    )


def match_service_lines(
    lines: Sequence[ClaimLine], payments: Sequence[ServicePayment]
) -> list[ClaimLine | None]:
    """Our line for each paid service line: by line control number, else date and code."""
    by_control_number = {line.line_control_number: line for line in lines}
    used: list[ClaimLine] = []
    matches: list[ClaimLine | None] = []
    for payment in payments:
        line = by_control_number.get(payment.line_control_number)
        if line is None:
            line = next(
                (
                    candidate
                    for candidate in lines
                    if candidate not in used
                    and candidate.service_date == payment.service_date
                    and candidate.procedure_code == payment.procedure_code
                ),
                None,
            )
        if line is None and len(lines) == 1 and len(payments) == 1:
            line = lines[0]
        if line is not None:
            used.append(line)
        matches.append(line)
    return matches


def primary_adjudication(db: Session, primary: Claim) -> RemittanceClaim | None:
    """The primary payer's current (posted, not reversed) answer on a claim."""
    return db.scalars(
        select(RemittanceClaim)
        .where(
            RemittanceClaim.claim_id == primary.id,
            RemittanceClaim.posted_at.is_not(None),
            RemittanceClaim.status_code != "22",
        )
        .order_by(RemittanceClaim.posted_at.desc(), RemittanceClaim.id.desc())
    ).first()


def _other_payer(db: Session, claim: Claim) -> doc.OtherPayer | None:
    """Coordination of benefits for a secondary claim, from the primary's posted remittance."""
    primary = db.get(Claim, claim.primary_claim_id) if claim.primary_claim_id else None
    if primary is None:
        return None
    adjudication = primary_adjudication(db, primary)
    if adjudication is None:
        return None
    payment = stored_payment(adjudication)
    remittance = adjudication.remittance
    adjudicated_on = remittance.payment_date or local_date(
        adjudication.posted_at or utcnow(), zone_of(claim.client.practice)
    )
    ours_by_participant = {line.participant_id: line for line in claim.lines}
    line_adjudications = []
    for service, primary_line in zip(
        payment.lines, match_service_lines(primary.lines, payment.lines), strict=True
    ):
        ours = ours_by_participant.get(primary_line.participant_id) if primary_line else None
        if ours is None:
            continue
        line_adjudications.append(
            doc.LineAdjudication(
                line_control_number=ours.line_control_number,
                procedure_code=service.procedure_code,
                paid_cents=service.paid_cents,
                adjudication_date=adjudicated_on,
                units=service.units,
                modifiers=service.modifiers,
                adjustments=service.adjustments,
            )
        )
    policy = primary.policy
    return doc.OtherPayer(
        payer=_payer(primary.payer),
        subscriber=doc.OtherSubscriber(
            member_id=policy.member_id.strip(),
            name=_subscriber_name(policy),
            claim_filing_indicator=_filing_indicator(policy),
            patient_relationship=policy.subscriber_relationship,
            group_number=policy.group_number.strip(),
            plan_name=policy.plan_name.strip(),
        ),
        paid_cents=payment.paid_cents,
        adjudication_date=adjudicated_on,
        payer_responsibility=primary.payer_responsibility,
        payer_claim_number=primary.payer_claim_number,
        claim_adjustments=payment.adjustments,
        line_adjudications=tuple(line_adjudications),
    )


def claim_document(db: Session, claim: Claim) -> ClaimDocument:
    """The claim as the claims engine sees it, from the current records."""
    practice = db.get_one(Practice, claim.practice_id)
    rendering = db.get_one(StaffMember, claim.rendering_clinician_id)
    supervising = (
        db.get(StaffMember, claim.supervising_clinician_id)
        if claim.supervising_clinician_id
        else None
    )
    provider = billing_provider(practice, rendering)
    subscriber, patient = _subscriber(claim.policy, claim.payer_responsibility)
    lines = tuple(
        doc.ClaimLine(
            line_control_number=line.line_control_number,
            service_date=line.service_date,
            procedure_code=line.procedure_code,
            charge_cents=line.charge_cents,
            diagnosis_pointers=tuple(line.diagnosis_pointers),
            modifiers=tuple(line.modifiers),
            units=line.units,
            place_of_service=line.place_of_service,
        )
        for line in claim.lines
    )
    replaces_original = claim.frequency_code in ("7", "8")
    return ClaimDocument(
        billing_provider=provider,
        subscriber=subscriber,
        payer=_payer(claim.payer),
        patient=patient,
        claim=doc.Claim(
            patient_control_number=claim.patient_control_number,
            total_charge_cents=sum(line.charge_cents for line in lines),
            place_of_service=claim.place_of_service,
            diagnoses=tuple(claim.diagnosis_codes),
            lines=lines,
            frequency_code=claim.frequency_code,
            payer_claim_number=claim.payer_claim_number if replaces_original else "",
            prior_authorization_number=claim.prior_authorization_number,
            rendering_provider=_provider(rendering)
            if provider.entity_type == "organization"
            else None,
            supervising_provider=_provider(supervising) if supervising else None,
            other_payer=_other_payer(db, claim),
        ),
    )


def document_snapshot(document: ClaimDocument) -> dict[str, Any]:
    """The claim document as JSON, stored with each submission."""
    return json.loads(json.dumps(asdict(document), default=str))


# Validation --------------------------------------------------------------------------------


def _record_issues(db: Session, claim: Claim, document: ClaimDocument) -> list[ClaimIssue]:
    """Problems explained in terms of our records (where to fix them), not claim fields."""
    issues: list[ClaimIssue] = []

    def add(code: str, field: str, message: str) -> None:
        issues.append(ClaimIssue(code=code, field=field, message=message))

    provider = document.billing_provider
    practice = db.get_one(Practice, claim.practice_id)
    rendering = db.get_one(StaffMember, claim.rendering_clinician_id)
    if provider.entity_type == "organization":
        if not provider.npi:
            add("npi_missing", "billing_provider.npi", "Add the practice's group NPI.")
        if not provider.taxonomy:
            add("taxonomy_missing", "billing_provider.taxonomy", "Add the practice's taxonomy.")
        if not rendering.npi.strip():
            add(
                "npi_missing",
                "claim.rendering_provider.npi",
                f"Add {rendering.full_name}'s NPI to their profile.",
            )
        if not rendering.taxonomy_code.strip():
            add(
                "taxonomy_missing",
                "claim.rendering_provider.taxonomy",
                f"Add {rendering.full_name}'s taxonomy code to their profile.",
            )
    else:
        if not provider.npi:
            add(
                "npi_missing",
                "billing_provider.npi",
                f"Add {rendering.full_name}'s NPI to their profile.",
            )
        if not provider.taxonomy:
            add(
                "taxonomy_missing",
                "billing_provider.taxonomy",
                f"Add {rendering.full_name}'s taxonomy code to their profile.",
            )
    if not provider.tax_id:
        add("tax_id_missing", "billing_provider.tax_id", "Add the practice's tax ID (EIN or SSN).")
    if not practice.address_line1.strip():
        add(
            "address_missing",
            "billing_provider.address.line1",
            "Add the practice's street address.",
        )
    supervising = document.claim.supervising_provider
    if supervising is not None and not supervising.npi:
        add(
            "npi_missing",
            "claim.supervising_provider.npi",
            f"Add {supervising.name.first} {supervising.name.last}'s NPI to their profile.",
        )

    payer, client, policy = claim.payer, claim.client, claim.policy
    if not payer.external_id.strip():
        add("payer_id_missing", "payer.payer_id", f"Add {payer.name}'s payer ID in the payer list.")
    if not policy.member_id.strip():
        add(
            "member_id_missing",
            "subscriber.member_id",
            f"Add the member ID to {client.full_name}'s {payer.name} policy.",
        )
    if not document.subscriber.is_patient and client.date_of_birth is None:
        add("birth_date_missing", "patient", f"Add {client.full_name}'s date of birth.")
    for day in sorted({line.service_date for line in claim.lines}):
        if not policy_active_on(policy, day):
            add(
                "policy_inactive",
                "policy",
                f"The {payer.name} policy wasn't active on {day:%m/%d/%Y}.",
            )
    for index, line in enumerate(claim.lines):
        participant = (
            db.get(AppointmentParticipant, line.participant_id) if line.participant_id else None
        )
        if participant is not None and (
            not participant.billable or participant.effective_status != AppointmentStatus.ATTENDED
        ):
            add(
                "session_not_billable",
                f"claim.lines[{index}]",
                f"The session on {line.service_date:%m/%d/%Y} is no longer marked attended.",
            )
    return issues


def claim_issues(
    db: Session,
    claim: Claim,
    method: ClaimSubmissionMethod | None = None,
    document: ClaimDocument | None = None,
) -> list[ClaimIssue]:
    """Everything that would get the claim rejected, record problems first.

    Paper claims don't need an electronic payer ID.
    """
    document = document or claim_document(db, claim)
    record_issues = _record_issues(db, claim, document)
    covered = {issue.field for issue in record_issues}
    issues = [
        *record_issues,
        *(issue for issue in validate_claim(document) if issue.field not in covered),
    ]
    if method == ClaimSubmissionMethod.PAPER:
        issues = [issue for issue in issues if issue.field != "payer.payer_id"]
    return issues
