"""837P generation: golden files for each claim shape, plus envelope and loop bookkeeping."""

from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import pytest

from synari.claims.document import ClaimDocument, PersonName
from synari.claims.x12 import amount, identifier, text
from synari.claims.x12_837p import build_837p
from tests.claims.samples import (
    ASSOCIATE,
    ENVELOPE,
    RECEIVER,
    SUBMITTER,
    SUPERVISOR,
    corrected_claim,
    group_claim,
    individual_claim,
    secondary_claim,
)

GOLDEN = Path(__file__).parent / "golden"


def _build(*documents: ClaimDocument) -> str:
    return build_837p(documents, ENVELOPE, SUBMITTER, RECEIVER)


def _segments(x12: str) -> list[list[str]]:
    return [raw.strip().split("*") for raw in x12.split("~") if raw.strip()]


@pytest.mark.parametrize(
    ("golden", "documents"),
    [
        ("837p_batch.x12", lambda: [individual_claim(), group_claim()]),
        ("837p_corrected.x12", lambda: [corrected_claim()]),
        ("837p_secondary.x12", lambda: [secondary_claim()]),
    ],
)
def test_matches_golden_file(golden: str, documents: Callable[[], list[ClaimDocument]]) -> None:
    assert _build(*documents()) == (GOLDEN / golden).read_text()


def test_envelope_counts_and_control_numbers() -> None:
    output = _build(individual_claim(), group_claim(), secondary_claim(), corrected_claim())
    segments = _segments(output)
    isa, gs, st = segments[0], segments[1], segments[2]
    se, ge, iea = segments[-3], segments[-2], segments[-1]

    assert len(output.split("~")[0]) + 1 == 106  # ISA is fixed width
    assert (isa[0], gs[0], st[0], se[0], ge[0], iea[0]) == ("ISA", "GS", "ST", "SE", "GE", "IEA")
    assert int(se[1]) == len(segments) - 4  # ST through SE
    assert se[2] == st[2] == "0001"
    assert (ge[1], ge[2]) == ("1", gs[6])
    assert (iea[1], iea[2]) == ("1", isa[13])
    assert isa[15] == "T"
    # Claims are grouped under their billing provider.
    assert [segment[1] for segment in segments if segment[0] == "CLM"] == [
        "C1001",
        "C1001",
        "C1001",
        "C2002",
    ]


def test_hierarchy_is_consistent() -> None:
    segments = _segments(_build(individual_claim(), group_claim(), secondary_claim()))
    levels = [segment[1:] for segment in segments if segment[0] == "HL"]
    numbers = [level[0] for level in levels]
    assert numbers == [str(n) for n in range(1, len(levels) + 1)]
    parents = {level[1] for level in levels if level[1]}
    for number, parent, code, has_children in levels:
        assert (has_children == "1") == (number in parents)
        if code == "20":
            assert parent == ""
        else:
            assert parent and int(parent) < int(number)
    # The solo clinician's two claims share one billing provider loop.
    assert [level[2] for level in levels] == ["20", "22", "22", "20", "22", "23"]


def test_billing_providers_are_grouped_in_first_seen_order() -> None:
    segments = _segments(_build(individual_claim(), group_claim(), secondary_claim()))
    billing = [segment[3] for segment in segments if segment[:2] == ["NM1", "85"]]
    assert billing == ["RIVERA", "MAPLE COUNSELING GROUP"]


def test_line_rendering_override_adds_2420a() -> None:
    document = group_claim()
    other = replace(ASSOCIATE, name=PersonName(first="Jo", last="Park"), npi="1666666668")
    lines = (document.claim.lines[0], replace(document.claim.lines[1], rendering_provider=other))
    segments = _segments(_build(replace(document, claim=replace(document.claim, lines=lines))))
    rendering = [segment for segment in segments if segment[:2] == ["NM1", "82"]]
    assert [segment[3] for segment in rendering] == ["PATEL", "PARK"]
    lx2 = segments.index(["LX", "2"])
    assert segments[lx2 + 4] == ["NM1", "82", "1", "PARK", "JO", "", "", "", "XX", "1666666668"]
    assert segments[lx2 + 5] == ["PRV", "PE", "PXC", "101YM0800X"]


def test_solo_clinician_named_as_rendering_is_not_repeated() -> None:
    document = individual_claim()
    self_rendering = replace(SUPERVISOR, npi=document.billing_provider.npi, taxonomy="1041C0700X")
    document = replace(document, claim=replace(document.claim, rendering_provider=self_rendering))
    assert ["NM1", "82"] not in [segment[:2] for segment in _segments(_build(document))]


def test_free_text_is_cleaned() -> None:
    document = individual_claim()
    name = PersonName(first="José~", last="O'Brien*Núñez", middle="Ä:B")
    subscriber = replace(document.subscriber, name=name, member_id="EVG 123*456")
    segments = _segments(_build(replace(document, subscriber=subscriber)))
    [nm1] = [segment for segment in segments if segment[:2] == ["NM1", "IL"]]
    assert nm1 == ["NM1", "IL", "1", "O'BRIEN NUNEZ", "JOSE", "A B", "", "", "MI", "EVG123456"]


def test_empty_batch_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one claim"):
        build_837p([], ENVELOPE, SUBMITTER, RECEIVER)


@pytest.mark.parametrize(
    ("cents", "expected"),
    [
        (15000, "150"),
        (15050, "150.5"),
        (15005, "150.05"),
        (15099, "150.99"),
        (1, "0.01"),
        (0, "0"),
        (-1250, "-12.5"),
    ],
)
def test_amount(cents: int, expected: str) -> None:
    assert amount(cents) == expected


@pytest.mark.parametrize(
    ("raw", "max_length", "expected"),
    [
        ("Ana Rivera", 60, "ANA RIVERA"),
        ("Zoë  Ńowak", 60, "ZOE NOWAK"),
        ("A*B~C:D^E", 60, "A B C D E"),
        ("  lots \n of   space ", 60, "LOTS OF SPACE"),
        ("Longer name", 7, "LONGER"),
        ("中文", 60, ""),
    ],
)
def test_text(raw: str, max_length: int, expected: str) -> None:
    assert text(raw, max_length) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("abc-123", "abc-123"), ("A B*C~D", "ABCD"), ("x" * 40, "x" * 30)],
)
def test_identifier(raw: str, expected: str) -> None:
    assert identifier(raw, 30) == expected
