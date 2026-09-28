"""Good Faith Estimate PDFs, laid out like the CMS model notice (OMB 0938-1433).

A regular estimate has the patient and convening provider, diagnoses, the primary service and
its dates, a summary of expected charges, the provider's details with itemized services,
items expected to be scheduled separately, and a disclaimer page (dispute rights, not a
contract, where to learn more). When nothing will be charged the abbreviated no-cost form is
used instead.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from fpdf.enums import TableBordersLayout, XPos, YPos
from fpdf.fonts import FontFace

from synari.models import Client, GoodFaithEstimate
from synari.schemas.estimates import DIAGNOSIS_LETTERS, EstimateProvider
from synari.services.billing import address_lines, format_money
from synari.services.pdf import ACCENT, ALERT, FONT, HEADING_FILL, INK, BaseDocument, pdf_text

TITLE = "Good Faith Estimate for Health Care Items and Services"
NO_COST_TITLE = "Good Faith Estimate for No-Cost Items and Services"
CMS_URL = "www.cms.gov/nosurprises"
CMS_PHONE = "1-800-985-3059"
DISPUTE_THRESHOLD = "$400"

NOT_A_CONTRACT = (
    "This Good Faith Estimate is not a contract. It does not require you to obtain the items "
    "or services from any of the providers or facilities listed."
)
MAY_DIFFER = "The actual items, services or charges may differ from this Good Faith Estimate."
OTHER_ITEMS = (
    "Other items or services may be recommended as part of your care. They are not reflected "
    "in this estimate and would be scheduled separately."
)
SEPARATE_ESTIMATES = (
    "The following items or services are reasonably expected to be furnished by other "
    "providers or facilities. They are not included in this estimate; you will receive "
    "separate Good Faith Estimates for them."
)
DISCLAIMER = (
    "This Good Faith Estimate shows the costs of items and services that are reasonably "
    "expected for your health care needs. The estimate is based on information known at the "
    "time the estimate was created.",
    "The Good Faith Estimate does not include any unknown or unexpected costs that may arise "
    "during treatment. You could be charged more if complications or special circumstances "
    "occur. If this happens, federal law allows you to dispute (appeal) the bill.",
    f"If you are billed for more than this Good Faith Estimate, you have the right to dispute "
    f"the bill. You may be eligible if the billed charges are at least {DISPUTE_THRESHOLD} more "
    f"than the total expected charges for this provider.",
    "You may contact the health care provider or facility listed to let them know the billed "
    "charges are higher than the Good Faith Estimate. You can ask them to update the bill to "
    "match the Good Faith Estimate, ask to negotiate the bill, or ask if there is financial "
    "assistance available.",
    "You may also start a dispute resolution process with the U.S. Department of Health and "
    "Human Services (HHS). If you choose to use the dispute resolution process, you must start "
    "the dispute process within 120 calendar days (about 4 months) of the date on the original "
    "bill. There is a $25 fee to use the dispute process. While your dispute is pending, the "
    "provider can't move the bill to collections, charge late fees on it, or retaliate against "
    "you.",
    "If the agency reviewing your dispute agrees with you, you will have to pay the price on "
    "this Good Faith Estimate. If the agency disagrees with you and agrees with the health care "
    "provider or facility, you will have to pay the higher amount.",
    f"To learn more and get a form to start the process, go to {CMS_URL} or call {CMS_PHONE}. "
    f"For questions or more information about your right to a Good Faith Estimate or the "
    f"dispute process, visit {CMS_URL} or call {CMS_PHONE}.",
    "Keep a copy of this Good Faith Estimate in a safe place or take pictures of it. You may "
    "need it if you are billed a higher amount.",
)
NO_COST_STATEMENT = (
    "The items and services listed above are expected to be provided at no cost to you. You "
    "should not receive a bill for them."
)
NO_COST_DISCLAIMER = (
    f"If you receive a bill for these items or services, you may have the right to dispute it. "
    f"To learn more, go to {CMS_URL} or call {CMS_PHONE}. Keep a copy of this Good Faith "
    f"Estimate in a safe place."
)


def format_long_date(day: date) -> str:
    """e.g. 'Oct 2, 2026'."""
    return f"{day:%b} {day.day}, {day.year}"


@dataclass(frozen=True)
class EstimateDocument:
    """What an estimate PDF shows besides the estimate itself."""

    client: Client
    provider: EstimateProvider
    estimate_date: date  # the date issued (today for a draft preview)
    replaces_date: date | None = None  # the date of the estimate this one replaces
    draft: bool = False


class _Pdf(BaseDocument):
    """Estimate layout helpers on the shared letter-size document."""

    def title_block(self, title: str, provider_name: str, estimate_date: date) -> None:
        self.set_font(FONT, style="B", size=15)
        self.set_text_color(*ACCENT)
        self.multi_cell(0, 7, pdf_text(title), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.text_line(provider_name, size=11, bold=True)
        self.text_line(f"Date of Good Faith Estimate: {format_long_date(estimate_date)}", size=9)
        self.rule()

    def draft_banner(self) -> None:
        self.set_font(FONT, style="B", size=10)
        self.set_text_color(*ALERT)
        self.cell(
            0,
            6,
            "DRAFT - not yet issued. Review before giving it to the client.",
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )

    def field(self, label: str, value: str) -> None:
        """A 'Label: value' line that wraps."""
        self.set_font(FONT, style="B", size=9)
        self.set_text_color(*INK)
        label_text = pdf_text(f"{label}: ")
        self.cell(self.get_string_width(label_text) + 1, 5, label_text)
        self.set_font(FONT, size=9)
        self.multi_cell(
            0, 5, pdf_text(value or "-"), align="L", new_x=XPos.LMARGIN, new_y=YPos.NEXT
        )

    def data_table(
        self,
        headings: Sequence[str],
        rows: Sequence[Sequence[str]],
        widths: Sequence[int],
        *,
        money_last: bool = True,
    ) -> None:
        """A table with a shaded heading row; the last column right-aligned when it's money."""
        self.set_font(FONT, size=8.5)
        self.set_text_color(*INK)
        last = "RIGHT" if money_last else "LEFT"
        alignment = tuple(["LEFT"] * (len(headings) - 1) + [last])
        with self.table(
            col_widths=tuple(widths),
            text_align=alignment,
            borders_layout=TableBordersLayout.HORIZONTAL_LINES,
            headings_style=FontFace(emphasis="BOLD", fill_color=HEADING_FILL),
            line_height=5,
        ) as table:
            heading_row = table.row()
            for heading in headings:
                heading_row.cell(pdf_text(heading))
            for values in rows:
                row = table.row()
                for value in values:
                    row.cell(pdf_text(value))

    def total_line(self, label: str, amount_cents: int, *, strong: bool = True) -> None:
        self.ln(1)
        right = self.w - self.r_margin
        self.set_x(right - 110)
        self.set_font(FONT, style="B" if strong else "", size=10)
        self.set_text_color(*INK)
        self.cell(80, 6, pdf_text(label), align="R")
        self.cell(30, 6, format_money(amount_cents), align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def paragraphs(self, texts: Sequence[str], *, size: float = 9) -> None:
        for text in texts:
            self.write_block(text, size=size, line_height=4.6, space_after=2)


def _patient(document: _Pdf, client: Client) -> None:
    document.section_title("Patient")
    document.field("Name", client.full_name)
    document.field(
        "Date of birth",
        format_long_date(client.date_of_birth) if client.date_of_birth else "",
    )
    address = ", ".join(
        address_lines(
            client.address_line1,
            client.address_line2,
            client.city,
            client.state,
            client.postal_code,
        )
    )
    document.field("Mailing address", address)
    document.field("Phone", client.phone)
    document.field("Email", client.email or "")


def _diagnoses(document: _Pdf, estimate: GoodFaithEstimate) -> None:
    document.section_title("Diagnosis")
    if not estimate.diagnosis_codes:
        document.field("Diagnosis", "Not yet determined")
        return
    for index, diagnosis in enumerate(estimate.diagnosis_codes):
        label = "Primary diagnosis" if index == 0 else "Secondary diagnosis"
        text = diagnosis.get("code", "")
        if diagnosis.get("description"):
            text = f"{diagnosis['description']} ({text})"
        document.field(label, text)


def _diagnosis_codes_for(estimate: GoodFaithEstimate, pointers: Sequence[str]) -> str:
    codes = [
        estimate.diagnosis_codes[DIAGNOSIS_LETTERS.index(pointer)].get("code", "")
        for pointer in pointers
        if pointer in DIAGNOSIS_LETTERS
        and DIAGNOSIS_LETTERS.index(pointer) < len(estimate.diagnosis_codes)
    ]
    return ", ".join(code for code in codes if code)


def _service_dates(estimate: GoodFaithEstimate) -> str:
    if not estimate.scheduled_dates:
        return "Not yet scheduled"
    days = [format_long_date(date.fromisoformat(day)) for day in estimate.scheduled_dates]
    return "; ".join(days)


def _provider_details(document: _Pdf, provider: EstimateProvider) -> None:
    name = f"{provider.name}, {provider.credentials}" if provider.credentials else provider.name
    document.field("Provider name", name)
    document.field("Provider type", provider.type)
    if provider.practice_name:
        document.field("Practice", provider.practice_name)
    document.field("Address", ", ".join(provider.address_lines))
    document.field("Contact person", provider.contact)
    document.field("Phone", provider.phone)
    document.field("Email", provider.email)
    npi_label = "NPI (group)" if provider.npi_kind == "group" else "NPI"
    document.field(npi_label, provider.npi)
    tin_label = f"TIN ({provider.tin_type})" if provider.tin_type else "TIN"
    document.field(tin_label, provider.tin)
    document.field("State(s)", ", ".join(provider.states))
    if provider.locations:
        document.field("Office location(s)", "; ".join(provider.locations))


def _item_rows(estimate: GoodFaithEstimate) -> list[list[str]]:
    rows = []
    for item in estimate.items:
        service = f"{item.description} ({format_money(item.unit_fee_cents)} each)"
        quantity = f"{item.quantity} ({item.frequency})" if item.frequency else str(item.quantity)
        rows.append(
            [
                service,
                item.location,
                _diagnosis_codes_for(estimate, item.diagnosis_pointers),
                item.service_code,
                quantity,
                format_money(item.total_cents),
            ]
        )
    return rows


def _change_note(document: _Pdf, estimate: GoodFaithEstimate, replaces_date: date | None) -> None:
    if estimate.supersedes_id is None:
        return
    document.section_title("What changed")
    replaced = (
        f"This Good Faith Estimate replaces the one dated {format_long_date(replaces_date)}."
        if replaces_date is not None
        else "This Good Faith Estimate replaces an earlier one."
    )
    document.paragraphs(
        [replaced, estimate.change_summary] if estimate.change_summary else [replaced]
    )


def _separately_scheduled(document: _Pdf, estimate: GoodFaithEstimate) -> None:
    document.section_title("Items or services scheduled separately")
    if estimate.separately_scheduled:
        document.paragraphs([SEPARATE_ESTIMATES])
        document.data_table(
            ["Item or service", "Provider or facility", "Notes"],
            [
                [item.get("description", ""), item.get("provider", ""), item.get("note", "")]
                for item in estimate.separately_scheduled
            ],
            [70, 50, 60],
            money_last=False,
        )
        document.ln(2)
    document.paragraphs([OTHER_ITEMS])


def _full_estimate(document: _Pdf, estimate: GoodFaithEstimate, info: EstimateDocument) -> None:
    provider = info.provider
    _patient(document, info.client)
    _diagnoses(document, estimate)

    document.section_title("Primary service or item")
    document.field("Requested or scheduled", estimate.primary_service)
    document.field("Scheduled date(s)", _service_dates(estimate))
    document.field(
        "Estimate period",
        f"{format_long_date(estimate.period_start)} to {format_long_date(estimate.period_end)}. "
        "This estimate is valid for up to 12 months from the date of the Good Faith Estimate.",
    )
    _change_note(document, estimate, info.replaces_date)

    document.section_title("Summary of expected charges")
    document.data_table(
        ["Provider", "Estimated total cost"],
        [[provider.name or provider.practice_name, format_money(estimate.total_cents)]],
        [130, 50],
    )
    document.total_line("Total estimated cost", estimate.total_cents)

    document.keep_together(60)
    document.section_title("Provider estimate")
    _provider_details(document, provider)
    document.ln(2)
    document.data_table(
        [
            "Service or item",
            "Address where provided",
            "Diagnosis code",
            "Service code",
            "Quantity",
            "Expected cost",
        ],
        _item_rows(estimate),
        [52, 42, 20, 20, 22, 24],
    )
    document.total_line("Provider estimated total", estimate.total_cents)
    if estimate.notes:
        document.section_title("Notes")
        document.paragraphs([estimate.notes])
    _separately_scheduled(document, estimate)

    document.add_page()
    document.section_title("Disclaimer")
    document.paragraphs([*DISCLAIMER, MAY_DIFFER, NOT_A_CONTRACT], size=9.5)


def _no_cost_estimate(document: _Pdf, estimate: GoodFaithEstimate, info: EstimateDocument) -> None:
    _patient(document, info.client)
    document.section_title("Provider")
    _provider_details(document, info.provider)
    document.section_title("Items and services")
    document.field("Primary service", estimate.primary_service)
    document.field("Scheduled date(s)", _service_dates(estimate))
    document.field(
        "Estimate period",
        f"{format_long_date(estimate.period_start)} to {format_long_date(estimate.period_end)}",
    )
    _change_note(document, estimate, info.replaces_date)
    document.ln(1)
    document.data_table(
        ["Service or item", "Service code", "Quantity", "Expected cost"],
        [
            [
                item.description,
                item.service_code,
                str(item.quantity),
                format_money(item.total_cents),
            ]
            for item in estimate.items
        ],
        [100, 30, 20, 30],
    )
    document.ln(2)
    document.paragraphs([NO_COST_STATEMENT, OTHER_ITEMS, NOT_A_CONTRACT, NO_COST_DISCLAIMER])


def estimate_pdf(estimate: GoodFaithEstimate, info: EstimateDocument) -> bytes:
    """The estimate as a printable PDF: the full CMS model form, or the abbreviated form when
    nothing will be charged. Draft previews are marked as drafts."""
    no_cost = estimate.total_cents == 0
    title = NO_COST_TITLE if no_cost else TITLE
    footer = "Good Faith Estimate - keep a copy for your records"
    document = _Pdf(title, footer_text=footer)
    if info.draft:
        document.draft_banner()
    provider_name = info.provider.practice_name or info.provider.name
    document.title_block(title, provider_name, info.estimate_date)
    if no_cost:
        _no_cost_estimate(document, estimate, info)
    else:
        _full_estimate(document, estimate, info)
    return document.output_bytes()
