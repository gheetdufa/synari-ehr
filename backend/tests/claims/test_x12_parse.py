"""Parsing 999, 277CA and 835 files into the shared response dataclasses."""

from datetime import date
from pathlib import Path

import pytest

from synari.claims.document import Adjustment
from synari.claims.responses import (
    ClaimAcknowledgment,
    ClaimPayment,
    ClaimStatus,
    FunctionalAcknowledgment,
    ProviderAdjustment,
    ServicePayment,
    TransactionAcknowledgment,
)
from synari.claims.x12 import cents, parse_date
from synari.claims.x12_parse import parse_277ca, parse_835, parse_999, tokenize

FIXTURES = Path(__file__).parent / "fixtures"
ERA = (FIXTURES / "835_era.x12").read_text()
ACK_999 = (FIXTURES / "999_partial.x12").read_text()
ACK_277 = (FIXTURES / "277ca_mixed.x12").read_text()

C2002 = ClaimPayment(
    patient_control_number="C2002",
    status_code="1",
    charge_cents=32050,
    paid_cents=19000,
    patient_responsibility_cents=6000,
    payer_claim_number="EVG2026090100077",
    lines=(
        ServicePayment(
            procedure_code="90791",
            charge_cents=18000,
            paid_cents=11000,
            line_control_number="C2002-1",
            service_date=date(2026, 9, 1),
            allowed_cents=14000,
            adjustments=(Adjustment("CO", "45", 4000), Adjustment("PR", "2", 3000)),
        ),
        ServicePayment(
            procedure_code="90834",
            modifiers=("95", "HO"),
            charge_cents=14050,
            paid_cents=8000,
            line_control_number="C2002-2",
            service_date=date(2026, 9, 8),
            allowed_cents=11000,
            adjustments=(Adjustment("CO", "45", 3050), Adjustment("PR", "3", 3000)),
            remark_codes=("N130",),
        ),
    ),
)
C1001_REVERSAL = ClaimPayment(
    patient_control_number="C1001",
    status_code="22",
    charge_cents=-15000,
    paid_cents=-9000,
    patient_responsibility_cents=-3000,
    payer_claim_number="EVG20260915001",
    adjustments=(Adjustment("CO", "45", -3000), Adjustment("PR", "2", -3000)),
)
C1001_CORRECTION = ClaimPayment(
    patient_control_number="C1001",
    status_code="1",
    charge_cents=15000,
    paid_cents=10000,
    patient_responsibility_cents=2000,
    payer_claim_number="EVG20260915001",
    adjustments=(
        Adjustment("CO", "45", 3000, quantity=1),
        Adjustment("CO", "253", 0),
        Adjustment("PR", "2", 2000),
    ),
)


def test_835_payment_header() -> None:
    payment, denial = parse_835(ERA)
    assert (payment.payer_name, payment.payer_id) == ("EVERGREEN HEALTH PLAN", "EVRGN")
    assert (payment.payee_name, payment.payee_npi, payment.payee_tax_id) == (
        "MAPLE COUNSELING GROUP",
        "1111111112",
        "987654321",
    )
    assert (payment.payment_cents, payment.payment_method, payment.payment_date) == (
        17650,
        "ACH",
        date(2026, 9, 26),
    )
    assert payment.trace_number == "EFT20260926001"
    assert (denial.payer_name, denial.payer_id, denial.payee_npi) == (
        "CASCADE MUTUAL",
        "CSCDM",
        "1234567893",
    )


def test_835_claims_lines_reversal_and_correction() -> None:
    payment, _ = parse_835(ERA)
    assert payment.claims == (C2002, C1001_REVERSAL, C1001_CORRECTION)
    assert [claim.is_reversal for claim in payment.claims] == [False, True, False]
    assert all(claim.is_balanced for claim in payment.claims)
    assert C2002.adjustment_cents == 13050
    assert C1001_REVERSAL.status_description == "Reversal of previous payment"


def test_835_provider_adjustments_and_balance() -> None:
    payment, _ = parse_835(ERA)
    assert payment.provider_adjustments == (
        ProviderAdjustment(
            provider_id="1111111112",
            reason_code="WO",
            reference="EVG2026080100012",
            amount_cents=2500,
            fiscal_period_date=date(2026, 12, 31),
        ),
        ProviderAdjustment(
            provider_id="1111111112",
            reason_code="L6",
            amount_cents=-150,
            fiscal_period_date=date(2026, 12, 31),
        ),
    )
    assert payment.claims_paid_cents == 20000
    assert payment.provider_adjustment_cents == 2350
    assert payment.is_balanced


def test_835_denial_without_payment() -> None:
    _, denial = parse_835(ERA)
    assert (denial.payment_cents, denial.payment_method, denial.trace_number) == (
        0,
        "NON",
        "0000000002",
    )
    [claim] = denial.claims
    assert claim.is_denied
    assert claim.adjustments == (Adjustment("CO", "197", 15000),)
    assert denial.is_balanced


def test_835_detects_out_of_balance_files() -> None:
    wrong_payment = ERA.replace("BPR*I*176.5*", "BPR*I*180*")
    assert not parse_835(wrong_payment)[0].is_balanced
    wrong_adjustment = ERA.replace("CAS*PR*3*30~", "CAS*PR*3*25~")
    payment = parse_835(wrong_adjustment)[0]
    assert not payment.claims[0].lines[1].is_balanced
    assert not payment.claims[0].is_balanced
    assert not payment.is_balanced


def test_835_debit_is_a_negative_payment() -> None:
    debit = ERA.replace("BPR*I*176.5*C*", "BPR*I*176.5*D*")
    assert parse_835(debit)[0].payment_cents == -17650


def test_999_partial_acceptance() -> None:
    assert parse_999(ACK_999) == [
        FunctionalAcknowledgment(
            group_control_number="42",
            functional_id="HC",
            status="P",
            transactions=(
                TransactionAcknowledgment(
                    control_number="0001",
                    transaction_set="837",
                    status="R",
                    errors=(
                        "Segment NM1 (#17 in loop 2010BA): segment has data element errors",
                        "NM109: required element missing",
                        "Segment N4 (#12 in loop 2010AA): segment has data element errors",
                        "N403: value too long (sent “9720512345”)",
                        "one or more segments in error",
                    ),
                ),
                TransactionAcknowledgment(control_number="0002", transaction_set="837", status="A"),
            ),
        )
    ]
    [group] = parse_999(ACK_999)
    assert group.accepted
    assert [transaction.accepted for transaction in group.transactions] == [False, True]


def test_277ca_accepted_and_rejected_claims() -> None:
    source = "EVERGREEN HEALTH PLAN"
    assert parse_277ca(ACK_277) == [
        ClaimAcknowledgment(
            patient_control_number="C1001",
            accepted=True,
            statuses=(ClaimStatus("A2", "20", "PR", "Accepted into adjudication"),),
            payer_claim_number="EVG20260915001",
            clearinghouse_trace_number="CH0042A",
            charge_cents=15000,
            status_date=date(2026, 9, 20),
            source=source,
        ),
        ClaimAcknowledgment(
            patient_control_number="C2002",
            accepted=False,
            statuses=(ClaimStatus("A7", "562", "85", "Rejected for invalid information"),),
            messages=(
                "Billing provider NPI not on file with the payer",
                "Modifier HO not allowed with place of service 02",
            ),
            clearinghouse_trace_number="CH0042B",
            charge_cents=32050,
            status_date=date(2026, 9, 20),
            source=source,
        ),
    ]


def test_277ca_action_code_alone_marks_a_rejection() -> None:
    text = ACK_277.replace("STC*A2:20:PR*20260920*WQ*150~", "STC*A2:20:PR*20260920*U*150~")
    assert [ack.accepted for ack in parse_277ca(text)] == [False, False]


def test_277ca_additional_statuses() -> None:
    text = ACK_277.replace(
        "STC*A2:20:PR*20260920*WQ*150~", "STC*A2:20:PR*20260920*WQ*150******A1:19:PR~"
    )
    first = parse_277ca(text)[0]
    assert [(s.category_code, s.status_code) for s in first.statuses] == [
        ("A2", "20"),
        ("A1", "19"),
    ]


def _with_separators(text: str) -> str:
    """Rewrite a fixture with | between elements, > between components and newlines only."""
    return text.replace("*", "|").replace(":", ">").replace("~\n", "\n")


def test_tokenizer_reads_separators_from_isa() -> None:
    assert parse_999(_with_separators(ACK_999)) == parse_999(ACK_999)
    assert parse_277ca(_with_separators(ACK_277)) == parse_277ca(ACK_277)
    assert parse_835(ERA.replace("~\n", "~")) == parse_835(ERA)


def test_tokenizer_segments() -> None:
    segments = tokenize(ACK_999)
    assert [segment.tag for segment in segments[:3]] == ["ISA", "GS", "ST"]
    clp = tokenize(ERA)[14]
    assert (clp.tag, clp.get(1), clp.get(7), clp.get(99)) == (
        "CLP",
        "C2002",
        "EVG2026090100077",
        "",
    )
    assert tokenize(ERA)[16].components(1) == ["HC", "90791"]


def test_tokenizer_rejects_other_text() -> None:
    with pytest.raises(ValueError, match="Not an X12 file"):
        tokenize("hello")


def test_bad_amount_is_reported() -> None:
    with pytest.raises(ValueError, match="Not an amount"):
        parse_835(ERA.replace("CLP*C2002*1*320.5*", "CLP*C2002*1*abc*"))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("150", 15000), ("150.5", 15050), ("150.05", 15005), ("-12.34", -1234), ("", 0), (".5", 50)],
)
def test_cents(raw: str, expected: int) -> None:
    assert cents(raw) == expected


def test_parse_date() -> None:
    assert parse_date("20260915") == parse_date("2026-09-15") == date(2026, 9, 15)
    assert parse_date(" ") is None
