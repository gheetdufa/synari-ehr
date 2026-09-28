"""Print claims onto the red CMS-1500 (02/12) paper claim form.

Payers that take paper claims scan the pre-printed red form, so this produces a data-only
overlay: load red forms in the printer and print at actual size (not "fit to page"). With
`form_background=True` faint item labels are drawn too, for proofing on plain paper.

The form is laid out on a grid of 10 characters per inch and 6 lines per inch. Items are
placed by print line and column on that grid, following the line/column layout of OpenEMR's
CMS-1500 (02/12) generator (src/Billing/Hcfa1500.php) and its default margins (20pt left, 24pt
top), in 12pt Courier (exactly 10 characters per inch). Printers feed slightly differently;
nudge the whole overlay with `offset_left_mm` / `offset_top_mm`.

Content follows the NUCC 1500 instructions: capital letters, names as "LAST, FIRST, M",
diagnosis codes without the dot and ICD indicator 0, up to six service lines per form with the
shaded supplemental lines left blank. Claims with more than six lines continue on further
forms, each totaled on its own. Item 26 shows the first 15 characters of the claim number.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from synari.claims.document import (
    Address,
    ClaimDocument,
    ClaimLine,
    OtherPayer,
    PersonName,
    Provider,
)
from synari.claims.x12 import clean
from synari.services.pdf import BaseDocument, pdf_text

LINES_PER_FORM = 6
_POINTS_PER_MM = 72 / 25.4
_LEFT_MARGIN_PT = 20.0
_TOP_MARGIN_PT = 24.0
_COLUMN_PT = 7.2  # 10 characters per inch
_LINE_PT = 12.0  # 6 lines per inch
_BASELINE_PT = 9.0  # from the top of a print line to the text baseline
_FONT_SIZE = 12
_LABEL_FONT_SIZE = 5.5
_LABEL_INK = (205, 90, 90)
_RULE_INK = (240, 190, 190)

_GROUP_HEALTH_PLANS = frozenset({"CI", "BL", "HM", "12", "13", "14", "15", "16", "17", "DS"})
_INSURANCE_TYPE_COLUMNS = {"MA": 1, "MB": 1, "MC": 8, "CH": 15, "VA": 24, "FI": 39}
_RELATIONSHIP_COLUMNS = {"18": 33, "01": 38, "19": 42}

# The optional background: item captions (each with a faint rule above) as
# (line, column, caption), and small captions beside the check boxes.
_CAPTIONS = (
    (7, 1, "1. INSURANCE TYPE"),
    (7, 50, "1a. INSURED'S I.D. NUMBER"),
    (9, 1, "2. PATIENT'S NAME (LAST, FIRST, MI)"),
    (9, 31, "3. PATIENT'S BIRTH DATE / SEX"),
    (9, 50, "4. INSURED'S NAME (LAST, FIRST, MI)"),
    (11, 1, "5. PATIENT'S ADDRESS"),
    (11, 31, "6. PATIENT RELATIONSHIP TO INSURED"),
    (11, 50, "7. INSURED'S ADDRESS"),
    (17, 1, "9. OTHER INSURED'S NAME"),
    (17, 31, "10. IS CONDITION RELATED TO:"),
    (17, 50, "11. INSURED'S POLICY GROUP OR FECA NUMBER"),
    (19, 1, "a. OTHER INSURED'S POLICY OR GROUP NUMBER"),
    (19, 31, "a. EMPLOYMENT?"),
    (19, 50, "a. INSURED'S DATE OF BIRTH / SEX"),
    (21, 31, "b. AUTO ACCIDENT?"),
    (23, 31, "c. OTHER ACCIDENT?"),
    (23, 50, "c. INSURANCE PLAN NAME OR PROGRAM NAME"),
    (25, 1, "d. INSURANCE PLAN NAME OR PROGRAM NAME"),
    (25, 50, "d. IS THERE ANOTHER HEALTH BENEFIT PLAN?"),
    (28, 1, "12. PATIENT'S OR AUTHORIZED PERSON'S SIGNATURE"),
    (28, 50, "13. INSURED'S OR AUTHORIZED PERSON'S SIGNATURE"),
    (31, 1, "14. DATE OF CURRENT ILLNESS"),
    (33, 1, "17. REFERRING PROVIDER OR OTHER SOURCE"),
    (33, 31, "17b. NPI"),
    (36, 1, "21. DIAGNOSIS OR NATURE OF ILLNESS OR INJURY"),
    (36, 38, "ICD IND."),
    (37, 50, "22. RESUBMISSION CODE / ORIGINAL REF. NO."),
    (39, 50, "23. PRIOR AUTHORIZATION NUMBER"),
    (41, 1, "24. A. DATE(S) OF SERVICE"),
    (41, 19, "B. POS"),
    (41, 25, "D. PROCEDURE  MODIFIER"),
    (41, 45, "E. DX PTR"),
    (41, 50, "F. $ CHARGES"),
    (41, 59, "G. UNITS"),
    (41, 68, "J. RENDERING NPI"),
    (55, 1, "25. FEDERAL TAX I.D. NUMBER"),
    (55, 23, "26. PATIENT'S ACCOUNT NO."),
    (55, 37, "27. ACCEPT ASSIGNMENT?"),
    (55, 50, "28. TOTAL CHARGE"),
    (55, 61, "29. AMOUNT PAID"),
    (57, 1, "31. SIGNATURE OF PHYSICIAN"),
    (57, 23, "32. SERVICE FACILITY LOCATION"),
    (57, 50, "33. BILLING PROVIDER INFO & PH #"),
)
_CHOICES = (
    (8, 2, "MEDICARE"),
    (8, 9, "MEDICAID"),
    (8, 16, "TRICARE"),
    (8, 25, "CHAMPVA"),
    (8, 32, "GROUP"),
    (8, 40, "FECA"),
    (8, 46, "OTHER"),
    (10, 43, "M"),
    (10, 48, "F"),
    (12, 34, "SELF"),
    (12, 39, "SPOUSE"),
    (12, 43, "CHILD"),
    (12, 48, "OTHER"),
    *(
        (line, column, caption)
        for line in (20, 22, 24)
        for column, caption in ((36, "YES"), (42, "NO"))
    ),
    (20, 69, "M"),
    (20, 76, "F"),
    (26, 53, "YES"),
    (26, 58, "NO"),
    (55, 16, "SSN"),
    (55, 19, "EIN"),
    (56, 39, "YES"),
    (56, 44, "NO"),
)


@dataclass(frozen=True)
class FormField:
    """Text for one spot on the form: 1-based print `line` and `column`, and its `item`."""

    item: str
    line: int
    column: int
    text: str


def _upper(value: str) -> str:
    return clean(value).upper()


def _form_name(name: PersonName) -> str:
    """NUCC item 2/4/9 format: "LAST SUFFIX, FIRST, M"."""
    last = " ".join(part for part in (name.last, name.suffix) if part)
    parts = [last, name.first] + ([name.middle[0]] if name.middle else [])
    return _upper(", ".join(part for part in parts if part))


def _provider_name(provider: Provider) -> str:
    """NUCC item 17 format: "FIRST M LAST"."""
    name = provider.name
    return _upper(" ".join(part for part in (name.first, name.middle[:1], name.last) if part))


def _money(cents: int) -> str:
    """Dollars right-aligned in five columns, a space, then cents: " 150 00"."""
    return f"{cents // 100:>5} {cents % 100:02d}"


def _city_line(address: Address) -> str:
    return _upper(f"{address.city}, {address.state} {address.postal_code}")


class _Page:
    """Collects the fields for one form."""

    def __init__(self) -> None:
        self.fields: list[FormField] = []

    def put(self, item: str, line: int, column: int, width: int, value: str) -> None:
        text = value[:width].rstrip()
        if text:
            self.fields.append(FormField(item=item, line=line, column=column, text=text))

    def check(self, item: str, line: int, column: int) -> None:
        self.put(item, line, column, 1, "X")

    def date(self, item: str, line: int, column: int, day: date) -> None:
        """MM DD YYYY in the three date boxes."""
        self.put(item, line, column, 2, f"{day:%m}")
        self.put(item, line, column + 3, 2, f"{day:%d}")
        self.put(item, line, column + 6, 4, f"{day:%Y}")

    def sex(self, item: str, line: int, male_column: int, female_column: int, sex: str) -> None:
        if sex in ("M", "F"):
            self.check(item, line, male_column if sex == "M" else female_column)


def cms1500_pages(document: ClaimDocument, *, signed_on: date) -> list[list[FormField]]:
    """The fields for each form this claim needs (six service lines per form)."""
    lines = document.claim.lines
    chunks = [
        lines[start : start + LINES_PER_FORM] for start in range(0, len(lines), LINES_PER_FORM)
    ]
    return [
        _form(document, chunk, signed_on=signed_on, first_page=index == 0)
        for index, chunk in enumerate(chunks or [()])
    ]


def _form(
    document: ClaimDocument,
    lines: Sequence[ClaimLine],
    *,
    signed_on: date,
    first_page: bool,
) -> list[FormField]:
    page = _Page()
    _header(page, document)
    _other_insurance(page, document)
    _claim_details(page, document)
    _service_lines(page, document, lines)
    _totals(page, document, lines, first_page=first_page)
    _providers(page, document, signed_on)
    return page.fields


def _header(page: _Page, document: ClaimDocument) -> None:
    """Payer block and items 1 to 7."""
    payer = document.payer
    subscriber = document.subscriber
    patient = document.patient
    page.put("payer", 2, 41, 31, _upper(payer.name))
    if payer.address is not None:
        page.put("payer", 3, 41, 31, _upper(payer.address.line1))
        page.put("payer", 4, 41, 31, _upper(payer.address.line2))
        page.put("payer", 5, 41, 31, _city_line(payer.address))

    filing = subscriber.claim_filing_indicator
    column = _INSURANCE_TYPE_COLUMNS.get(filing, 31 if filing in _GROUP_HEALTH_PLANS else 45)
    page.check("1", 8, column)
    page.put("1a", 8, 50, 29, _upper(subscriber.member_id))

    page.put("2", 10, 1, 28, _form_name(document.patient_name))
    birth_date = patient.birth_date if patient else subscriber.birth_date
    if birth_date is not None:
        page.date("3", 10, 31, birth_date)
    page.sex("3", 10, 42, 47, patient.sex if patient else subscriber.sex)
    page.put("4", 10, 50, 29, _form_name(subscriber.name))

    patient_address = patient.address if patient else subscriber.address
    if patient_address is not None:
        page.put("5", 12, 1, 28, _upper(patient_address.line1))
        page.put("5", 14, 1, 24, _upper(patient_address.city))
        page.put("5", 14, 26, 2, patient_address.state)
        page.put("5", 16, 1, 10, patient_address.postal_code)
    page.check("6", 12, _RELATIONSHIP_COLUMNS.get(subscriber.patient_relationship, 47))
    if subscriber.address is not None:
        page.put("7", 12, 50, 29, _upper(subscriber.address.line1))
        page.put("7", 14, 50, 23, _upper(subscriber.address.city))
        page.put("7", 14, 74, 2, subscriber.address.state)
        page.put("7", 16, 50, 10, subscriber.address.postal_code)


def _other_insurance(page: _Page, document: ClaimDocument) -> None:
    """Items 9 to 11d: other coverage, condition questions and the insured's plan."""
    subscriber = document.subscriber
    other = document.claim.other_payer
    if other is not None:
        page.put("9", 18, 1, 28, _form_name(other.subscriber.name))
        page.put("9a", 20, 1, 28, other.subscriber.group_number or other.subscriber.member_id)
        page.put("9d", 26, 1, 28, _upper(other.subscriber.plan_name or other.payer.name))
    for item, line in (("10a", 20), ("10b", 22), ("10c", 24)):
        page.check(item, line, 41)  # NO: therapy claims aren't for employment or accidents
    page.put("11", 18, 50, 29, _upper(subscriber.group_number))
    if subscriber.birth_date is not None:
        page.date("11a", 20, 53, subscriber.birth_date)
    page.sex("11a", 20, 68, 75, subscriber.sex)
    page.put("11c", 24, 50, 29, _upper(subscriber.plan_name or document.payer.name))
    page.check("11d", 26, 52 if other is not None else 57)


def _claim_details(page: _Page, document: ClaimDocument) -> None:
    """Items 12 to 23."""
    claim = document.claim
    if claim.release_of_information == "Y":
        page.put("12", 29, 7, 17, "SIGNATURE ON FILE")
    if claim.benefits_assignment == "Y":
        page.put("13", 29, 55, 17, "SIGNATURE ON FILE")
    if claim.onset_date is not None:
        page.date("14", 32, 2, claim.onset_date)
        page.put("14", 32, 16, 3, "431")
    # Item 17 holds one provider: the referring provider, otherwise the supervisor.
    qualifier, provider = (
        ("DN", claim.referring_provider)
        if claim.referring_provider
        else ("DQ", claim.supervising_provider)
    )
    if provider is not None:
        page.put("17", 34, 1, 3, qualifier)
        page.put("17", 34, 4, 25, _provider_name(provider))
        page.put("17b", 34, 33, 10, provider.npi)

    page.put("21", 37, 42, 1, "0")
    for index, code in enumerate(claim.diagnoses[:12]):
        page.put("21", 38 + index // 4, 3 + 13 * (index % 4), 8, code)
    if claim.frequency_code in ("7", "8"):
        page.put("22", 38, 50, 10, claim.frequency_code)
        page.put("22", 38, 62, 15, claim.payer_claim_number)
    page.put("23", 40, 50, 28, claim.prior_authorization_number)


def _service_lines(page: _Page, document: ClaimDocument, lines: Sequence[ClaimLine]) -> None:
    """Item 24 on the unshaded half of each of the six line pairs."""
    claim = document.claim
    default_npi = (
        claim.rendering_provider.npi if claim.rendering_provider else document.billing_provider.npi
    )
    for index, line in enumerate(lines):
        row = 42 + 2 * index
        day = line.service_date
        for column in (1, 10):  # from and to dates (single-day services)
            page.put("24A", row, column, 2, f"{day:%m}")
            page.put("24A", row, column + 3, 2, f"{day:%d}")
            page.put("24A", row, column + 6, 2, f"{day:%y}")
        page.put("24B", row, 19, 2, line.place_of_service or claim.place_of_service)
        page.put("24D", row, 25, 6, line.procedure_code)
        page.put("24D", row, 33, 12, " ".join(line.modifiers[:4]))
        pointers = "".join(chr(ord("A") + pointer - 1) for pointer in line.diagnosis_pointers)
        page.put("24E", row, 45, 4, pointers)
        page.put("24F", row, 50, 8, _money(line.charge_cents))
        page.put("24G", row, 59, 3, str(line.units))
        rendering = line.rendering_provider
        page.put("24J", row, 68, 10, rendering.npi if rendering else default_npi)


def _other_paid(other: OtherPayer, lines: Sequence[ClaimLine], *, first_page: bool) -> int:
    """What the earlier payer paid for the lines on this form."""
    if not other.line_adjudications:
        return other.paid_cents if first_page else 0
    ids = {line.line_control_number for line in lines}
    return sum(
        result.paid_cents
        for result in other.line_adjudications
        if result.line_control_number in ids
    )


def _totals(
    page: _Page, document: ClaimDocument, lines: Sequence[ClaimLine], *, first_page: bool
) -> None:
    """Items 25 to 29."""
    billing = document.billing_provider
    claim = document.claim
    page.put("25", 56, 1, 15, billing.tax_id)
    page.check("25", 56, 17 if billing.tax_id_type == "SSN" else 19)
    page.put("26", 56, 23, 15, claim.patient_control_number)
    page.check("27", 56, 38 if claim.assignment_code == "A" else 43)
    page.put("28", 56, 52, 8, _money(sum(line.charge_cents for line in lines)))
    if claim.other_payer is not None:
        paid = _other_paid(claim.other_payer, lines, first_page=first_page)
        page.put("29", 56, 62, 8, _money(paid))


def _providers(page: _Page, document: ClaimDocument, signed_on: date) -> None:
    """Items 31 to 33."""
    billing = document.billing_provider
    claim = document.claim
    if claim.provider_signature_on_file:
        page.put("31", 60, 1, 20, "SIGNATURE ON FILE")
        page.put("31", 61, 6, 10, f"{signed_on:%m/%d/%Y}")

    facility = claim.service_facility
    if facility is not None:
        page.put("32", 58, 23, 25, _upper(facility.name))
        page.put("32", 59, 23, 25, _upper(facility.address.line1))
        page.put("32", 60, 23, 26, _city_line(facility.address))
        page.put("32a", 61, 23, 10, facility.npi)

    phone = billing.contact.phone
    page.put("33", 57, 66, 3, phone[:3])
    page.put("33", 57, 70, 8, f"{phone[3:6]}-{phone[6:10]}" if len(phone) == 10 else "")
    page.put("33", 58, 50, 29, _upper(billing.display_name))
    page.put("33", 59, 50, 29, _upper(billing.address.line1))
    page.put("33", 60, 50, 29, _city_line(billing.address))
    page.put("33a", 61, 50, 10, billing.npi)
    page.put("33b", 61, 63, 14, f"ZZ{billing.taxonomy}")


class _FormDocument(BaseDocument):
    """Letter pages with text placed on the form's print grid and no page furniture."""

    def __init__(self, offset_left_mm: float, offset_top_mm: float) -> None:
        super().__init__("CMS-1500 claim forms")
        self.set_auto_page_break(auto=False)
        self.offset_left_mm = offset_left_mm
        self.offset_top_mm = offset_top_mm
        self.pages_used = 0

    def footer(self) -> None:
        """Nothing: the red form has its own footer."""

    def next_page(self) -> None:
        if self.pages_used:
            self.add_page()
        self.pages_used += 1

    def place(self, line: int, column: int, text: str, size: float) -> None:
        x = (_LEFT_MARGIN_PT + (column - 1) * _COLUMN_PT) / _POINTS_PER_MM
        y = (_TOP_MARGIN_PT + (line - 1) * _LINE_PT + _BASELINE_PT) / _POINTS_PER_MM
        self.set_font("Courier", size=size)
        self.text(x + self.offset_left_mm, y + self.offset_top_mm, pdf_text(text))

    def background(self) -> None:
        """Faint item captions and rules, for proofing on plain paper."""
        self.set_draw_color(*_RULE_INK)
        for line in sorted({caption[0] for caption in _CAPTIONS}):
            y = (_TOP_MARGIN_PT + (line - 1) * _LINE_PT) / _POINTS_PER_MM
            self.line(8, y + self.offset_top_mm, self.w - 8, y + self.offset_top_mm)
        self.set_text_color(*_LABEL_INK)
        for line, column, caption in (*_CAPTIONS, *_CHOICES):
            self.place(line, column, caption, _LABEL_FONT_SIZE)


def cms1500_pdf(
    documents: Sequence[ClaimDocument],
    *,
    signed_on: date,
    form_background: bool = False,
    offset_left_mm: float = 0.0,
    offset_top_mm: float = 0.0,
) -> bytes:
    """A PDF with one CMS-1500 overlay page per form, for all `documents` in order.

    `signed_on` is the date printed with the provider's signature (item 31).
    """
    if not documents:
        raise ValueError("A CMS-1500 PDF needs at least one claim.")
    pdf = _FormDocument(offset_left_mm, offset_top_mm)
    for document in documents:
        for fields in cms1500_pages(document, signed_on=signed_on):
            pdf.next_page()
            if form_background:
                pdf.background()
            pdf.set_text_color(0, 0, 0)
            for field in fields:
                pdf.place(field.line, field.column, field.text, _FONT_SIZE)
    return pdf.output_bytes()
