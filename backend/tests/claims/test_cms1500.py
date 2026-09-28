"""CMS-1500 overlay: field placement on the print grid, pagination and the PDF itself."""

import re
import zlib
from dataclasses import replace
from datetime import date

import pytest

from synari.claims.cms1500 import FormField, cms1500_pages, cms1500_pdf
from synari.claims.document import ClaimDocument
from tests.claims.samples import corrected_claim, group_claim, individual_claim, secondary_claim

SIGNED_ON = date(2026, 9, 26)


def _fields(document: ClaimDocument) -> set[tuple[str, int, int, str]]:
    [page] = cms1500_pages(document, signed_on=SIGNED_ON)
    return {(field.item, field.line, field.column, field.text) for field in page}


def _page_text(pdf: bytes) -> str:
    """The decompressed page content streams."""
    streams = re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S)
    return "\n".join(zlib.decompress(stream).decode("latin-1") for stream in streams)


def test_group_claim_fields() -> None:
    fields = _fields(group_claim())
    expected = {
        ("payer", 2, 41, "EVERGREEN HEALTH PLAN"),
        ("1", 8, 31, "X"),  # BL: group health plan
        ("1a", 8, 50, "EVG555000111"),
        ("2", 10, 1, "SMITH, RILEY"),
        ("3", 10, 31, "06"),
        ("3", 10, 34, "03"),
        ("3", 10, 37, "2014"),
        ("3", 10, 42, "X"),  # male
        ("4", 10, 50, "SMITH JR, MORGAN"),
        ("5", 12, 1, "88 PINE ST"),
        ("5", 14, 1, "BELLEVUE"),
        ("5", 14, 26, "WA"),
        ("5", 16, 1, "98004"),
        ("6", 12, 42, "X"),  # child
        ("10a", 20, 41, "X"),
        ("10b", 22, 41, "X"),
        ("10c", 24, 41, "X"),
        ("11c", 24, 50, "EVERGREEN FAMILY PPO"),
        ("11d", 26, 57, "X"),  # no other plan
        ("12", 29, 7, "SIGNATURE ON FILE"),
        ("13", 29, 55, "SIGNATURE ON FILE"),
        ("14", 32, 2, "08"),
        ("14", 32, 5, "15"),
        ("14", 32, 8, "2026"),
        ("14", 32, 16, "431"),
        ("17", 34, 1, "DN"),
        ("17", 34, 4, "ROBIN KIM"),
        ("17b", 34, 33, "1444444446"),
        ("21", 37, 42, "0"),
        ("21", 38, 3, "F902"),
        ("21", 38, 16, "F4323"),
        ("21", 38, 29, "Z634"),
        ("23", 40, 50, "PA12345"),
        ("24A", 42, 1, "09"),
        ("24A", 42, 4, "01"),
        ("24A", 42, 7, "26"),
        ("24A", 42, 10, "09"),
        ("24B", 42, 19, "11"),
        ("24D", 42, 25, "90791"),
        ("24E", 42, 45, "AB"),
        ("24F", 42, 50, "  180 00"),
        ("24G", 42, 59, "1"),
        ("24J", 42, 68, "1222222220"),
        ("24B", 44, 19, "02"),
        ("24D", 44, 25, "90834"),
        ("24D", 44, 33, "95 HO"),
        ("24E", 44, 45, "AC"),
        ("24F", 44, 50, "  140 50"),
        ("25", 56, 1, "987654321"),
        ("25", 56, 19, "X"),  # EIN
        ("26", 56, 23, "C2002"),
        ("27", 56, 38, "X"),
        ("28", 56, 52, "  320 50"),
        ("31", 60, 1, "SIGNATURE ON FILE"),
        ("31", 61, 6, "09/26/2026"),
        ("32", 58, 23, "MAPLE COUNSELING BELLEVUE"),
        ("32", 59, 23, "12 LAKE WAY"),
        ("32", 60, 23, "BELLEVUE, WA 980041002"),
        ("32a", 61, 23, "1555555550"),
        ("33", 57, 66, "206"),
        ("33", 57, 70, "555-0199"),
        ("33", 58, 50, "MAPLE COUNSELING GROUP"),
        ("33", 59, 50, "500 CEDAR BLVD"),
        ("33", 60, 50, "SEATTLE, WA 981011234"),
        ("33a", 61, 50, "1111111112"),
        ("33b", 61, 63, "ZZ261QM0801X"),
    }
    assert expected <= fields, expected - fields
    # The client isn't the subscriber: no insured address, birth date or other coverage.
    assert not {"7", "11a", "9", "9a", "9d", "22", "29"} & {field[0] for field in fields}
    # Shaded supplemental lines (odd lines 41-51) stay blank.
    assert not [field for field in fields if field[1] in range(41, 52, 2)]


def test_solo_clinician_self_insured_claim() -> None:
    fields = _fields(individual_claim())
    expected = {
        ("1", 8, 31, "X"),  # CI: group health plan
        ("2", 10, 1, "LEE, JORDAN"),
        ("3", 10, 47, "X"),  # female
        ("4", 10, 50, "LEE, JORDAN"),
        ("6", 12, 33, "X"),  # self
        ("7", 12, 50, "15 OAK AVE"),
        ("7", 14, 74, "OR"),
        ("7", 16, 50, "972091234"),
        ("11", 18, 50, "GRP100"),
        ("11a", 20, 53, "04"),
        ("11a", 20, 56, "12"),
        ("11a", 20, 59, "1990"),
        ("11a", 20, 75, "X"),
        ("11c", 24, 50, "EVERGREEN HEALTH PLAN"),
        ("24B", 42, 19, "10"),
        ("24D", 42, 33, "95"),
        ("24J", 42, 68, "1234567893"),  # the clinician's own NPI
        ("25", 56, 1, "234567891"),
        ("25", 56, 17, "X"),  # SSN
        ("33", 58, 50, "ANA RIVERA"),
    }
    assert expected <= fields, expected - fields
    assert not {"14", "17", "17b", "23", "32", "32a"} & {field[0] for field in fields}


def test_supervisor_fills_item_17_without_a_referrer() -> None:
    document = group_claim()
    document = replace(document, claim=replace(document.claim, referring_provider=None))
    assert {("17", 34, 1, "DQ"), ("17", 34, 4, "LEE A CHEN"), ("17b", 34, 33, "1333333338")} <= (
        _fields(document)
    )


def test_corrected_claim_resubmission_code() -> None:
    fields = _fields(corrected_claim())
    assert {("22", 38, 50, "7"), ("22", 38, 62, "EVG20260915001")} <= fields


def test_secondary_claim_other_insurance() -> None:
    fields = _fields(secondary_claim())
    expected = {
        ("payer", 2, 41, "CASCADE MUTUAL"),
        ("payer", 3, 41, "PO BOX 900"),
        ("payer", 5, 41, "SALEM, OR 97301"),
        ("1a", 8, 50, "CM7788"),
        ("9", 18, 1, "LEE, JORDAN"),
        ("9a", 20, 1, "GRP100"),
        ("9d", 26, 1, "EVERGREEN HEALTH PLAN"),
        ("11c", 24, 50, "CASCADE GOLD"),
        ("11d", 26, 52, "X"),  # yes, another plan
        ("29", 56, 62, "   90 00"),
    }
    assert expected <= fields, expected - fields


def test_more_than_six_lines_continue_on_another_form() -> None:
    document = secondary_claim()
    template = document.claim.lines[0]
    lines = tuple(
        replace(template, line_control_number=f"L{index}", charge_cents=10000) for index in range(8)
    )
    other = document.claim.other_payer
    assert other is not None
    results = tuple(
        replace(other.line_adjudications[0], line_control_number=f"L{index}", paid_cents=6000)
        for index in range(8)
    )
    claim = replace(
        document.claim,
        lines=lines,
        total_charge_cents=80000,
        other_payer=replace(other, line_adjudications=results, paid_cents=48000),
    )
    first, second = cms1500_pages(replace(document, claim=claim), signed_on=SIGNED_ON)

    def rows(page: list[FormField]) -> list[int]:
        return sorted({field.line for field in page if field.item == "24D"})

    assert rows(first) == [42, 44, 46, 48, 50, 52]
    assert rows(second) == [42, 44]
    totals = [
        [field.text for field in page if field.item in ("28", "29")] for page in (first, second)
    ]
    assert totals == [["  600 00", "  360 00"], ["  200 00", "  120 00"]]
    assert [field for field in second if field.item == "1a"] == [
        FormField(item="1a", line=8, column=50, text="CM7788")
    ]


def test_pdf_places_text_on_the_print_grid() -> None:
    pdf = cms1500_pdf([group_claim(), individual_claim()], signed_on=SIGNED_ON)
    assert pdf.startswith(b"%PDF")
    assert len(re.findall(rb"/Type\s*/Page\b", pdf)) == 2
    text = _page_text(pdf)
    # Item 1a: column 50 is 20pt + 49 * 7.2pt from the left; line 8's baseline is
    # 24pt + 7 * 12pt + 9pt from the top of the 792pt page.
    assert "BT 372.80 675.00 Td (EVG555000111) Tj ET" in text
    assert "(SIGNATURE ON FILE) Tj" in text
    assert "(PA12345) Tj" in text
    assert "(LEE, JORDAN) Tj" in text
    assert "/F1 12.00 Tf" in text
    assert "INSURED'S I.D. NUMBER" not in text


def test_pdf_background_and_offsets() -> None:
    pdf = cms1500_pdf(
        [group_claim()],
        signed_on=SIGNED_ON,
        form_background=True,
        offset_left_mm=2.54,
        offset_top_mm=-2.54,
    )
    text = _page_text(pdf)
    assert "(1a. INSURED'S I.D. NUMBER) Tj" in text
    # A tenth of an inch is 7.2pt: right and up.
    assert "BT 380.00 682.20 Td (EVG555000111) Tj ET" in text


def test_pdf_needs_a_claim() -> None:
    with pytest.raises(ValueError, match="at least one claim"):
        cms1500_pdf([], signed_on=SIGNED_ON)
