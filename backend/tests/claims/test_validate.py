"""Claim validation: every rule gets a case that breaks it in an otherwise valid claim."""

from collections.abc import Callable
from dataclasses import replace
from datetime import date

import pytest

from synari.claims.document import (
    Address,
    Adjustment,
    ClaimDocument,
    Patient,
    PersonName,
)
from synari.claims.validate import ClaimIssue, npi_is_valid, ssn_is_valid, validate_claim
from tests.claims.samples import (
    ASSOCIATE,
    corrected_claim,
    group_claim,
    individual_claim,
    secondary_claim,
)

TODAY = date(2026, 9, 26)


def _claim(document: ClaimDocument, **changes: object) -> ClaimDocument:
    return replace(document, claim=replace(document.claim, **changes))


def _line(document: ClaimDocument, **changes: object) -> ClaimDocument:
    """Change the first line, keeping the claim total in step with the lines."""
    lines = (replace(document.claim.lines[0], **changes), *document.claim.lines[1:])
    total = sum(line.charge_cents for line in lines)
    return _claim(document, lines=lines, total_charge_cents=total)


def _billing(document: ClaimDocument, **changes: object) -> ClaimDocument:
    return replace(document, billing_provider=replace(document.billing_provider, **changes))


def _billing_address(document: ClaimDocument, **changes: object) -> ClaimDocument:
    address = replace(document.billing_provider.address, **changes)
    return _billing(document, address=address)


def _subscriber(document: ClaimDocument, **changes: object) -> ClaimDocument:
    return replace(document, subscriber=replace(document.subscriber, **changes))


def _many_lines(count: int) -> ClaimDocument:
    document = individual_claim()
    template = document.claim.lines[0]
    lines = tuple(
        replace(template, line_control_number=f"L{index}", charge_cents=1000)
        for index in range(count)
    )
    return _claim(document, lines=lines, total_charge_cents=1000 * count)


def _cob_line(**changes: object) -> ClaimDocument:
    document = secondary_claim()
    other = document.claim.other_payer
    assert other is not None
    adjudication = replace(other.line_adjudications[0], **changes)
    return _claim(document, other_payer=replace(other, line_adjudications=(adjudication,)))


SOME_PATIENT = Patient(
    name=PersonName(first="Casey", last="Lee"),
    birth_date=date(2015, 1, 1),
    sex="F",
    address=Address(line1="15 Oak Ave", city="Portland", state="OR", postal_code="97209"),
)

CASES: list[tuple[str, Callable[[], ClaimDocument], str, str]] = [
    (
        "npi check digit",
        lambda: _billing(individual_claim(), npi="1234567890"),
        "npi_invalid",
        "billing_provider.npi",
    ),
    (
        "npi length",
        lambda: _billing(individual_claim(), npi="12345"),
        "npi_invalid",
        "billing_provider.npi",
    ),
    (
        "npi missing",
        lambda: _billing(individual_claim(), npi=""),
        "required",
        "billing_provider.npi",
    ),
    (
        "rendering npi",
        lambda: _claim(group_claim(), rendering_provider=replace(ASSOCIATE, npi="1222222222")),
        "npi_invalid",
        "claim.rendering_provider.npi",
    ),
    (
        "billing taxonomy",
        lambda: _billing(individual_claim(), taxonomy="1041C0700"),
        "taxonomy_invalid",
        "billing_provider.taxonomy",
    ),
    (
        "rendering taxonomy",
        lambda: _claim(group_claim(), rendering_provider=replace(ASSOCIATE, taxonomy="")),
        "required",
        "claim.rendering_provider.taxonomy",
    ),
    (
        "ein length",
        lambda: _billing(group_claim(), tax_id="98765432"),
        "tax_id_invalid",
        "billing_provider.tax_id",
    ),
    (
        "ssn area",
        lambda: _billing(individual_claim(), tax_id="000123456"),
        "tax_id_invalid",
        "billing_provider.tax_id",
    ),
    (
        "po box",
        lambda: _billing_address(individual_claim(), line1="P.O. Box 55"),
        "po_box_address",
        "billing_provider.address.line1",
    ),
    (
        "lock box on line 2",
        lambda: _billing_address(individual_claim(), line2="Lockbox 12"),
        "po_box_address",
        "billing_provider.address.line1",
    ),
    (
        "billing zip needs 9 digits",
        lambda: _billing_address(individual_claim(), postal_code="97205"),
        "postal_code_invalid",
        "billing_provider.address.postal_code",
    ),
    (
        "subscriber zip shape",
        lambda: _subscriber(
            individual_claim(),
            address=Address(line1="1 A St", city="Portland", state="OR", postal_code="9720"),
        ),
        "postal_code_invalid",
        "subscriber.address.postal_code",
    ),
    (
        "state name",
        lambda: _billing_address(individual_claim(), state="Oregon"),
        "state_invalid",
        "billing_provider.address.state",
    ),
    (
        "contact phone",
        lambda: _billing(
            individual_claim(),
            contact=replace(individual_claim().billing_provider.contact, phone="555-0100"),
        ),
        "phone_invalid",
        "billing_provider.contact.phone",
    ),
    (
        "no diagnoses",
        lambda: _claim(individual_claim(), diagnoses=()),
        "diagnosis_count",
        "claim.diagnoses",
    ),
    (
        "thirteen diagnoses",
        lambda: _claim(individual_claim(), diagnoses=tuple(f"F4{n:02d}" for n in range(13))),
        "diagnosis_count",
        "claim.diagnoses",
    ),
    (
        "diagnosis with dot",
        lambda: _claim(individual_claim(), diagnoses=("F41.1", "F331")),
        "diagnosis_invalid",
        "claim.diagnoses[0]",
    ),
    (
        "diagnosis lowercase",
        lambda: _claim(individual_claim(), diagnoses=("F411", "f331")),
        "diagnosis_invalid",
        "claim.diagnoses[1]",
    ),
    (
        "duplicate diagnosis",
        lambda: _claim(individual_claim(), diagnoses=("F411", "F411")),
        "diagnosis_duplicate",
        "claim.diagnoses",
    ),
    (
        "no pointers",
        lambda: _line(individual_claim(), diagnosis_pointers=()),
        "pointer_count",
        "claim.lines[0].diagnosis_pointers",
    ),
    (
        "five pointers",
        lambda: _line(individual_claim(), diagnosis_pointers=(1, 2, 1, 2, 1)),
        "pointer_count",
        "claim.lines[0].diagnosis_pointers",
    ),
    (
        "pointer past the diagnoses",
        lambda: _line(individual_claim(), diagnosis_pointers=(1, 3)),
        "pointer_invalid",
        "claim.lines[0].diagnosis_pointers",
    ),
    (
        "repeated pointer",
        lambda: _line(individual_claim(), diagnosis_pointers=(2, 2)),
        "pointer_invalid",
        "claim.lines[0].diagnosis_pointers",
    ),
    (
        "zero charge",
        lambda: _line(individual_claim(), charge_cents=0),
        "charge_invalid",
        "claim.lines[0].charge_cents",
    ),
    (
        "zero units",
        lambda: _line(individual_claim(), units=0),
        "units_invalid",
        "claim.lines[0].units",
    ),
    (
        "five modifiers",
        lambda: _line(individual_claim(), modifiers=("95", "HO", "GT", "59", "XE")),
        "modifier_count",
        "claim.lines[0].modifiers",
    ),
    (
        "one-character modifier",
        lambda: _line(individual_claim(), modifiers=("9",)),
        "modifier_invalid",
        "claim.lines[0].modifiers[0]",
    ),
    (
        "procedure code",
        lambda: _line(individual_claim(), procedure_code="9083"),
        "procedure_code_invalid",
        "claim.lines[0].procedure_code",
    ),
    (
        "line place of service",
        lambda: _line(individual_claim(), place_of_service="2"),
        "place_of_service_invalid",
        "claim.lines[0].place_of_service",
    ),
    (
        "claim place of service",
        lambda: _claim(individual_claim(), place_of_service=""),
        "place_of_service_invalid",
        "claim.place_of_service",
    ),
    (
        "total mismatch",
        lambda: _claim(individual_claim(), total_charge_cents=14999),
        "total_mismatch",
        "claim.total_charge_cents",
    ),
    (
        "no lines",
        lambda: _claim(individual_claim(), lines=(), total_charge_cents=0),
        "line_count",
        "claim.lines",
    ),
    ("51 lines", lambda: _many_lines(51), "line_count", "claim.lines"),
    (
        "duplicate line id",
        lambda: _claim(
            group_claim(),
            lines=(
                group_claim().claim.lines[0],
                replace(group_claim().claim.lines[1], line_control_number="C2002-1"),
            ),
        ),
        "line_control_number_duplicate",
        "claim.lines[1].line_control_number",
    ),
    (
        "line id too long",
        lambda: _line(individual_claim(), line_control_number="L" * 31),
        "line_control_number_invalid",
        "claim.lines[0].line_control_number",
    ),
    (
        "future service date",
        lambda: _line(individual_claim(), service_date=date(2026, 9, 27)),
        "service_date_future",
        "claim.lines[0].service_date",
    ),
    (
        "future birth date",
        lambda: _subscriber(individual_claim(), birth_date=date(2027, 1, 1)),
        "birth_date_future",
        "subscriber.birth_date",
    ),
    (
        "subscriber is the client but has no birth date",
        lambda: _subscriber(individual_claim(), birth_date=None),
        "required",
        "subscriber.birth_date",
    ),
    (
        "replacement without the payer claim number",
        lambda: _claim(corrected_claim(), payer_claim_number=""),
        "payer_claim_number_required",
        "claim.payer_claim_number",
    ),
    (
        "void without the payer claim number",
        lambda: _claim(individual_claim(), frequency_code="8"),
        "payer_claim_number_required",
        "claim.payer_claim_number",
    ),
    (
        "unknown frequency",
        lambda: _claim(individual_claim(), frequency_code="2"),
        "code_invalid",
        "claim.frequency_code",
    ),
    (
        "claim number too long",
        lambda: _claim(individual_claim(), patient_control_number="C" * 18),
        "patient_control_number_invalid",
        "claim.patient_control_number",
    ),
    (
        "claim number punctuation",
        lambda: _claim(individual_claim(), patient_control_number="C-1001"),
        "patient_control_number_invalid",
        "claim.patient_control_number",
    ),
    (
        "dependent without patient details",
        lambda: replace(group_claim(), patient=None),
        "patient_required",
        "patient",
    ),
    (
        "patient details for a self-insured client",
        lambda: replace(individual_claim(), patient=SOME_PATIENT),
        "patient_unexpected",
        "patient",
    ),
    (
        "unknown relationship",
        lambda: _subscriber(group_claim(), patient_relationship="99"),
        "code_invalid",
        "subscriber.patient_relationship",
    ),
    (
        "member id missing",
        lambda: _subscriber(individual_claim(), member_id=" "),
        "required",
        "subscriber.member_id",
    ),
    (
        "sex code",
        lambda: _subscriber(individual_claim(), sex="X"),
        "code_invalid",
        "subscriber.sex",
    ),
    (
        "filing indicator",
        lambda: _subscriber(individual_claim(), claim_filing_indicator="XX"),
        "code_invalid",
        "subscriber.claim_filing_indicator",
    ),
    (
        "payer id missing",
        lambda: replace(individual_claim(), payer=replace(individual_claim().payer, payer_id="")),
        "required",
        "payer.payer_id",
    ),
    (
        "group practice without a rendering clinician",
        lambda: _claim(group_claim(), rendering_provider=None),
        "rendering_provider_required",
        "claim.rendering_provider",
    ),
    (
        "service facility zip",
        lambda: _claim(
            group_claim(),
            service_facility=replace(
                group_claim().claim.service_facility,
                address=Address(
                    line1="12 Lake Way", city="Bellevue", state="WA", postal_code="98004"
                ),
            ),
        ),
        "postal_code_invalid",
        "claim.service_facility.address.postal_code",
    ),
    (
        "secondary without the primary's payment",
        lambda: _claim(secondary_claim(), other_payer=None),
        "other_payer_required",
        "claim.other_payer",
    ),
    (
        "cob line out of balance",
        lambda: _cob_line(
            adjustments=(Adjustment(group_code="CO", reason_code="45", amount_cents=3000),)
        ),
        "other_payer_out_of_balance",
        "claim.other_payer.line_adjudications[0]",
    ),
    (
        "cob line for an unknown line",
        lambda: _cob_line(line_control_number="NOPE"),
        "other_payer_line_unknown",
        "claim.other_payer.line_adjudications[0].line_control_number",
    ),
    (
        "cob adjustment group",
        lambda: _cob_line(
            adjustments=(
                Adjustment(group_code="XX", reason_code="45", amount_cents=3000),
                Adjustment(group_code="PR", reason_code="2", amount_cents=3000),
            )
        ),
        "code_invalid",
        "claim.other_payer.line_adjudications[0].adjustments[0].group_code",
    ),
    (
        "cob paid total differs from the line payments",
        lambda: _claim(
            secondary_claim(),
            other_payer=replace(secondary_claim().claim.other_payer, paid_cents=8000),
        ),
        "other_payer_out_of_balance",
        "claim.other_payer.paid_cents",
    ),
]


@pytest.mark.parametrize(
    ("build", "code", "field"), [case[1:] for case in CASES], ids=[case[0] for case in CASES]
)
def test_rule(build: Callable[[], ClaimDocument], code: str, field: str) -> None:
    issues = validate_claim(build(), today=TODAY)
    assert (code, field) in {(issue.code, issue.field) for issue in issues}, issues
    assert all(issue.message.endswith(".") for issue in issues)


@pytest.mark.parametrize("build", [individual_claim, group_claim, corrected_claim, secondary_claim])
def test_sample_claims_are_valid(build: Callable[[], ClaimDocument]) -> None:
    assert validate_claim(build(), today=TODAY) == []


def test_all_problems_are_reported_together() -> None:
    document = _billing(_line(individual_claim(), units=0, charge_cents=0), npi="1")
    issues = validate_claim(document, today=TODAY)
    assert {issue.code for issue in issues} >= {"npi_invalid", "units_invalid", "charge_invalid"}


def test_messages_name_the_problem() -> None:
    document = _claim(individual_claim(), total_charge_cents=12345)
    assert validate_claim(document, today=TODAY) == [
        ClaimIssue(
            code="total_mismatch",
            field="claim.total_charge_cents",
            message="The claim total ($123.45) doesn't match the sum of the lines ($150.00).",
        )
    ]


def test_line_messages_count_from_one() -> None:
    lines = (
        *group_claim().claim.lines,
        replace(group_claim().claim.lines[0], units=0, line_control_number="X"),
    )
    document = _claim(group_claim(), lines=lines, total_charge_cents=32050 + 18000)
    [issue] = validate_claim(document, today=TODAY)
    assert issue.field == "claim.lines[2].units"
    assert issue.message == "Line 3 must have at least 1 unit."


@pytest.mark.parametrize(
    ("npi", "valid"),
    [
        ("1234567893", True),
        ("1111111112", True),
        ("1234567890", False),
        ("123456789", False),
        ("12345678931", False),
        ("3234567893", False),
        ("12345678X3", False),
    ],
)
def test_npi_check_digit(npi: str, valid: bool) -> None:
    assert npi_is_valid(npi) is valid


@pytest.mark.parametrize(
    ("ssn", "valid"),
    [
        ("234567891", True),
        ("000123456", False),
        ("666123456", False),
        ("912345678", False),
        ("123004567", False),
        ("123450000", False),
        ("12345678", False),
    ],
)
def test_ssn_shape(ssn: str, valid: bool) -> None:
    assert ssn_is_valid(ssn) is valid


def test_line_rendering_override_is_checked() -> None:
    document = _line(
        group_claim(),
        rendering_provider=replace(ASSOCIATE, name=PersonName(first="", last="Patel")),
    )
    issues = validate_claim(document, today=TODAY)
    assert [(issue.code, issue.field) for issue in issues] == [
        ("required", "claim.lines[0].rendering_provider.name.first")
    ]


def test_missing_billing_zip_is_reported_once() -> None:
    issues = validate_claim(_billing_address(individual_claim(), postal_code=""), today=TODAY)
    assert [(issue.code, issue.field) for issue in issues] == [
        ("required", "billing_provider.address.postal_code")
    ]
