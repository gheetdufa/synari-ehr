"""Shared PDF building blocks (invoices, superbills, forms, notes).

Documents use fpdf2's built-in Helvetica so there are no font files to ship. Core fonts are
cp1252-encoded, so all text goes through `pdf_text`, which keeps what cp1252 can draw (including
curly quotes and dashes), strips accents it can't, and replaces anything else with "?".
"""

import unicodedata

from fpdf import FPDF
from fpdf.enums import XPos, YPos

FONT = "Helvetica"
INK = (31, 42, 48)
MUTED = (91, 107, 115)
ACCENT = (14, 116, 144)
ALERT = (180, 35, 24)
RULE = (215, 223, 227)
HEADING_FILL = (236, 244, 246)


def pdf_text(value: str) -> str:
    """Fold text into the cp1252 range the PDF core fonts can draw."""
    folded: list[str] = []
    for char in value.replace("\r\n", "\n").replace("\t", "    "):
        if char != "\n" and unicodedata.category(char).startswith("C"):
            continue
        try:
            char.encode("cp1252")
            folded.append(char)
            continue
        except UnicodeEncodeError:
            pass
        base = unicodedata.normalize("NFKD", char).encode("cp1252", "ignore").decode("cp1252")
        folded.append(base or "?")
    return "".join(folded)


class BaseDocument(FPDF):
    """Letter-size page with consistent margins, an optional footer note and page numbers."""

    def __init__(self, title: str, footer_text: str = "") -> None:
        super().__init__(format="Letter")
        self.core_fonts_encoding = "cp1252"
        self.footer_text = pdf_text(footer_text)
        self.set_title(pdf_text(title))
        self.set_creator("Synari")
        self.set_margins(18, 18, 18)
        self.set_auto_page_break(auto=True, margin=20)
        self.add_page()

    def footer(self) -> None:
        self.set_y(-14)
        self.set_font(FONT, size=8)
        self.set_text_color(*MUTED)
        if self.footer_text:
            self.cell(0, 5, self.footer_text, align="L")
            self.set_x(self.l_margin)
        self.cell(0, 5, f"Page {self.page_no()} of {{nb}}", align="R" if self.footer_text else "C")

    def text_line(
        self, text: str, *, size: float = 10, bold: bool = False, muted: bool = False
    ) -> None:
        """One line of text at the current position, then move to the next line."""
        self.set_font(FONT, style="B" if bold else "", size=size)
        self.set_text_color(*(MUTED if muted else INK))
        self.cell(0, size * 0.5, pdf_text(text), new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def write_block(
        self,
        text: str,
        *,
        size: float = 10,
        style: str = "",
        color: tuple[int, int, int] = INK,
        line_height: float = 5,
        space_after: float = 0,
    ) -> None:
        """Wrapped paragraph text."""
        self.set_font(FONT, style=style, size=size)
        self.set_text_color(*color)
        self.multi_cell(
            0, line_height, pdf_text(text), align="L", new_x=XPos.LMARGIN, new_y=YPos.NEXT
        )
        if space_after:
            self.ln(space_after)

    def section_title(self, text: str) -> None:
        self.ln(4)
        self.set_font(FONT, style="B", size=11)
        self.set_text_color(*ACCENT)
        self.cell(0, 7, pdf_text(text), new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def keep_together(self, height: float) -> None:
        """Start a new page unless `height` mm still fits, so blocks don't split awkwardly."""
        if self.will_page_break(height):
            self.add_page()

    def rule(self, space: float = 4) -> None:
        self.ln(space / 2)
        self.set_draw_color(*RULE)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(space / 2)

    def output_bytes(self) -> bytes:
        return bytes(self.output())
