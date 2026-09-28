"""Invoice and superbill PDFs."""

from collections.abc import Sequence
from datetime import date

from fpdf.enums import TableBordersLayout, XPos, YPos
from fpdf.fonts import FontFace
from sqlalchemy.orm import Session

from synari.models import ClientContact, Invoice, Practice, Superbill
from synari.models.enums import InvoiceStatus
from synari.schemas.billing import SuperbillData, SuperbillProvider
from synari.services.billing import address_lines, format_money, line_clinicians
from synari.services.pdf import ACCENT, FONT, HEADING_FILL, INK, MUTED, BaseDocument, pdf_text


def _format_date(day: date | None) -> str:
    return f"{day:%b} {day.day}, {day.year}" if day else ""


def _provider_name(provider: SuperbillProvider) -> str:
    return f"{provider.name}, {provider.credentials}" if provider.credentials else provider.name


class _Document(BaseDocument):
    """Billing document with a practice masthead, tables and totals."""

    def masthead(
        self, name: str, lines: Sequence[str], title: str, details: Sequence[tuple[str, str]]
    ) -> None:
        """Practice name and contact lines on the left, document title and details on the right."""
        top = self.get_y()
        self.text_line(name, size=16, bold=True)
        for line in lines:
            if line:
                self.text_line(line, size=9, muted=True)
        left_bottom = self.get_y()

        right = self.w - self.r_margin
        width = 70
        self.set_xy(right - width, top)
        self.set_font(FONT, style="B", size=18)
        self.set_text_color(*ACCENT)
        self.cell(width, 9, pdf_text(title), align="R", new_x=XPos.LEFT, new_y=YPos.NEXT)
        for label, value in details:
            self.set_x(right - width)
            self.set_font(FONT, size=9)
            self.set_text_color(*MUTED)
            self.cell(width, 5, pdf_text(f"{label}: {value}"), align="R", new_y=YPos.NEXT)
        self.set_y(max(left_bottom, self.get_y()) + 4)
        self.set_draw_color(*ACCENT)
        self.line(self.l_margin, self.get_y(), right, self.get_y())
        self.ln(3)

    def data_table(
        self, headings: Sequence[str], rows: Sequence[Sequence[str]], widths: Sequence[int]
    ) -> None:
        """A table with a shaded heading row; the last column is right-aligned (money)."""
        self.set_font(FONT, size=9)
        self.set_text_color(*INK)
        alignment = tuple(["LEFT"] * (len(headings) - 1) + ["RIGHT"])
        with self.table(
            col_widths=tuple(widths),
            text_align=alignment,
            borders_layout=TableBordersLayout.HORIZONTAL_LINES,
            headings_style=FontFace(emphasis="BOLD", fill_color=HEADING_FILL),
            line_height=6,
        ) as table:
            heading_row = table.row()
            for heading in headings:
                heading_row.cell(pdf_text(heading))
            for values in rows:
                row = table.row()
                for value in values:
                    row.cell(pdf_text(value))

    def totals(self, rows: Sequence[tuple[str, str]], *, emphasize_last: bool = True) -> None:
        """Right-aligned label/amount pairs under a table."""
        self.ln(2)
        right = self.w - self.r_margin
        for index, (label, value) in enumerate(rows):
            strong = emphasize_last and index == len(rows) - 1
            self.set_font(FONT, style="B" if strong else "", size=11 if strong else 10)
            self.set_text_color(*INK)
            self.set_x(right - 90)
            self.cell(60, 6, pdf_text(label), align="R")
            self.cell(30, 6, pdf_text(value), align="R", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def provider_block(self, provider: SuperbillProvider) -> None:
        """A rendering provider's name and identifiers."""
        self.text_line(_provider_name(provider), bold=True)
        for label, value in (
            ("NPI", provider.npi),
            ("Taxonomy", provider.taxonomy_code),
            ("License", provider.license),
        ):
            if value:
                self.text_line(f"{label}: {value}", size=9)


def invoice_pdf(db: Session, invoice: Invoice) -> bytes:
    """A printable invoice: practice header, bill-to, lines with their clinicians and totals.

    Under "Bill to", an invoice addressed to a contact (e.g. a minor's parent) names the
    contact, then "For: <client>".
    """
    practice = db.get_one(Practice, invoice.practice_id)
    client = invoice.client
    clinicians = line_clinicians(db, [invoice])
    document = _Document(f"Invoice {invoice.number}")
    practice_lines = [
        *address_lines(
            practice.address_line1,
            practice.address_line2,
            practice.city,
            practice.state,
            practice.postal_code,
        ),
        practice.phone,
    ]
    details = [
        ("Invoice", invoice.number),
        ("Issued", _format_date(invoice.issued_on)),
        ("Due", _format_date(invoice.due_on)),
    ]
    if invoice.status == InvoiceStatus.VOID:
        details.append(("Status", "VOID"))
    elif invoice.status == InvoiceStatus.PAID:
        details.append(("Status", "PAID"))
    document.masthead(practice.name, practice_lines, "INVOICE", details)

    contact = (
        db.get(ClientContact, invoice.bill_to_contact_id)
        if invoice.bill_to_contact_id is not None
        else None
    )
    document.section_title("Bill to")
    if contact is not None:
        document.text_line(contact.full_name, bold=True)
        document.text_line(f"For: {client.full_name}")
    else:
        document.text_line(client.full_name, bold=True)
    for line in address_lines(
        client.address_line1, client.address_line2, client.city, client.state, client.postal_code
    ):
        document.text_line(line, size=9, muted=True)

    document.section_title("Services")
    rows = []
    for item in invoice.items:
        row = [_format_date(item.service_date), item.service_code, item.description]
        if clinicians:
            clinician = clinicians.get(item.clinician_id) if item.clinician_id else None
            row.append(clinician.display_name if clinician is not None else "")
        rows.append([*row, format_money(item.amount_cents)])
    if clinicians:
        document.data_table(
            ["Date", "Code", "Description", "Clinician", "Amount"], rows, [26, 18, 64, 38, 26]
        )
    else:
        document.data_table(["Date", "Code", "Description", "Amount"], rows, [28, 20, 94, 30])
    document.totals(
        [
            ("Total", format_money(invoice.total_cents)),
            ("Paid", format_money(invoice.paid_cents)),
            ("Balance due", format_money(invoice.balance_cents)),
        ]
    )
    if invoice.notes:
        document.section_title("Notes")
        document.set_font(FONT, size=9)
        document.set_text_color(*INK)
        document.multi_cell(0, 5, pdf_text(invoice.notes))
    return document.output_bytes()


def superbill_pdf(superbill: Superbill) -> bytes:
    """A superbill a client can submit to their insurer for out-of-network reimbursement."""
    data = SuperbillData.model_validate(superbill.data)
    document = _Document(f"Superbill {superbill.number}")
    practice = data.practice
    practice_lines = [
        *practice.address_lines,
        practice.phone,
        f"Group NPI: {practice.npi}" if practice.npi else "",
        f"Taxonomy: {practice.taxonomy_code}" if practice.taxonomy_code else "",
        f"Tax ID ({practice.tax_id_type}): {practice.tax_id}" if practice.tax_id else "",
    ]
    document.masthead(
        practice.name,
        practice_lines,
        "SUPERBILL",
        [
            ("Number", superbill.number),
            (
                "Period",
                f"{_format_date(superbill.period_start)} - {_format_date(superbill.period_end)}",
            ),
        ],
    )

    if data.provider is not None:
        document.section_title("Provider")
        document.provider_block(data.provider)
    else:
        document.section_title("Providers")
        providers: list[SuperbillProvider] = []
        for line in data.lines:
            if line.provider not in providers:
                providers.append(line.provider)
        for provider in providers:
            document.provider_block(provider)

    document.section_title("Client")
    document.text_line(data.client.name, bold=True)
    if data.client.date_of_birth:
        document.text_line(f"Date of birth: {_format_date(data.client.date_of_birth)}", size=9)
    for line in [*data.client.address_lines, data.client.phone]:
        if line:
            document.text_line(line, size=9, muted=True)

    if data.insurance is not None:
        insurance = data.insurance
        document.section_title("Insurance")
        payer = insurance.payer_name
        if insurance.payer_id:
            payer = f"{payer} (payer ID {insurance.payer_id})"
        document.text_line(payer, bold=True)
        for label, value in (
            ("Plan", insurance.plan_name),
            ("Member ID", insurance.member_id),
            ("Group", insurance.group_number),
            ("Policyholder", insurance.subscriber_name),
            ("Client's relationship to policyholder", insurance.subscriber_relationship),
            ("Policyholder date of birth", _format_date(insurance.subscriber_dob)),
        ):
            if value:
                document.text_line(f"{label}: {value}", size=9)

    if data.diagnosis_codes:
        document.section_title("Diagnoses (ICD-10)")
        for diagnosis in data.diagnosis_codes:
            text = diagnosis.code
            if diagnosis.description:
                text = f"{diagnosis.code}  {diagnosis.description}"
            document.text_line(text, size=9)

    document.section_title("Services")
    if data.provider is not None:
        document.data_table(
            ["Date", "POS", "CPT", "Description", "Units", "Fee"],
            [
                [
                    _format_date(line.date),
                    line.place_of_service,
                    line.cpt,
                    line.description,
                    str(line.units),
                    format_money(line.fee_cents),
                ]
                for line in data.lines
            ],
            [26, 12, 18, 78, 12, 26],
        )
    else:
        document.data_table(
            ["Date", "POS", "CPT", "Description", "Provider", "Units", "Fee"],
            [
                [
                    _format_date(line.date),
                    line.place_of_service,
                    line.cpt,
                    line.description,
                    line.provider.name,
                    str(line.units),
                    format_money(line.fee_cents),
                ]
                for line in data.lines
            ],
            [24, 11, 16, 55, 36, 10, 20],
        )
    document.set_font(FONT, size=8)
    document.set_text_color(*MUTED)
    document.cell(
        0,
        5,
        "Place of service: 02 = telehealth, 10 = telehealth in the client's home, 11 = office.",
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )

    if data.payments:
        document.section_title("Payments")
        document.data_table(
            ["Date", "Method", "Amount"],
            [[_format_date(p.date), p.method, format_money(p.amount_cents)] for p in data.payments],
            [40, 102, 30],
        )
    document.totals(
        [
            ("Total charges", format_money(data.total_cents)),
            ("Total paid", format_money(data.paid_cents)),
        ],
        emphasize_last=False,
    )
    return document.output_bytes()
