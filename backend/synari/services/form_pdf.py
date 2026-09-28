"""PDF export of a completed client form: answers, score and e-signature record.

Times are shown in the practice's time zone, since the form is part of the practice's record.
"""

import re
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from synari.models import Client, ClientForm
from synari.services.forms import DISPLAY_TYPES, FieldType
from synari.services.pdf import ACCENT, ALERT, INK, MUTED, BaseDocument, pdf_text


def _format_date(value: date) -> str:
    return f"{value:%B} {value.day}, {value.year}"


def _format_datetime(value: datetime, zone: ZoneInfo) -> str:
    local = value.astimezone(zone)
    hour = local.hour % 12 or 12
    return f"{_format_date(local)} at {hour}:{local:%M} {local:%p} {local:%Z}"


def _option_label(field: Mapping[str, Any], value: Any) -> str:
    for option in field.get("options") or []:
        if type(option["value"]) is type(value) and option["value"] == value:
            return str(option["label"])
    return str(value)


def format_answer(field: Mapping[str, Any], value: Any) -> str:
    """Human-readable answer text for one field ("No answer" when blank)."""
    if value is None:
        return "No answer"
    kind = FieldType(field["type"])
    if kind == FieldType.YES_NO:
        return "Yes" if value else "No"
    if kind == FieldType.DATE:
        return _format_date(date.fromisoformat(value))
    if kind == FieldType.SINGLE_CHOICE:
        return _option_label(field, value)
    if kind == FieldType.MULTI_CHOICE:
        return "; ".join(_option_label(field, item) for item in value)
    return str(value)


def pdf_filename(form: ClientForm) -> str:
    """A safe download name like 'phq-9-2026-09-25.pdf'."""
    slug = re.sub(r"[^a-z0-9]+", "-", form.name.lower()).strip("-")[:60] or "form"
    completed = form.completed_at or form.sent_at
    return f"{slug}-{completed:%Y-%m-%d}.pdf"


def _header(pdf: BaseDocument, form: ClientForm, client: Client, zone: ZoneInfo) -> None:
    pdf.write_block(client.practice.name, size=14, style="B", color=ACCENT)
    clinician = client.primary_clinician
    if clinician is not None:
        pdf.write_block(f"Clinician: {clinician.display_name}", size=9, color=MUTED)
    pdf.ln(4)
    pdf.write_block(form.name, size=16, style="B", line_height=7, space_after=2)
    dob = _format_date(client.date_of_birth) if client.date_of_birth else "Not on file"
    pdf.write_block(f"Client: {client.full_name}    Date of birth: {dob}", color=MUTED)
    details = [f"Shared: {_format_datetime(form.sent_at, zone)}"]
    if form.completed_at is not None:
        details.append(f"Completed: {_format_datetime(form.completed_at, zone)}")
    pdf.write_block("    ".join(details), color=MUTED)
    pdf.rule(6)


def _score_section(pdf: BaseDocument, form: ClientForm) -> None:
    if form.score is None and not form.flagged:
        return
    if form.score is not None:
        max_score = (form.scoring or {}).get("max_score")
        total = f"{form.score} of {max_score}" if max_score is not None else str(form.score)
        label = f" ({form.score_label})" if form.score_label else ""
        pdf.write_block(f"Score: {total}{label}", size=12, style="B", line_height=6)
    if form.flagged:
        pdf.write_block(f"Flagged for review: {form.flag_reason}", style="B", color=ALERT)
    pdf.rule(6)


def _fields_section(pdf: BaseDocument, form: ClientForm) -> None:
    answers = form.answers or {}
    for field in form.fields:
        kind = FieldType(field["type"])
        if kind == FieldType.HEADING:
            pdf.keep_together(25)
            pdf.ln(2)
            pdf.write_block(field["label"], size=12, style="B", color=ACCENT, line_height=6)
            pdf.ln(1)
            continue
        if kind in DISPLAY_TYPES:
            pdf.write_block(field["label"], size=9.5, color=MUTED, space_after=3)
            continue
        pdf.keep_together(15)
        pdf.write_block(field["label"], style="B")
        value = answers.get(field["id"])
        pdf.write_block(
            format_answer(field, value),
            color=INK if value is not None else MUTED,
            space_after=3.5,
        )


def _signature_section(pdf: BaseDocument, form: ClientForm, zone: ZoneInfo) -> None:
    if not form.requires_signature or form.signed_at is None:
        return
    pdf.keep_together(45)
    pdf.rule(6)
    pdf.write_block("Electronic signature", size=12, style="B", line_height=6, space_after=1)
    pdf.write_block(f"Signed by: {form.signature_name}")
    pdf.write_block(f"Signed on: {_format_datetime(form.signed_at, zone)}")
    pdf.write_block(f"IP address: {form.signer_ip or 'Not recorded'}")
    if form.signer_user_agent:
        pdf.write_block(f"Device: {form.signer_user_agent}", size=8.5, color=MUTED)
    pdf.write_block(
        "The signer typed their name and agreed that it serves as their electronic signature.",
        size=8.5,
        color=MUTED,
    )
    if form.signature_sha256:
        pdf.write_block(f"Signature hash (SHA-256): {form.signature_sha256}", size=8.5, color=MUTED)
    if form.signature_integrity == "mismatch":
        pdf.write_block(
            "Warning: this form no longer matches what was signed.", style="B", color=ALERT
        )


def render_client_form_pdf(form: ClientForm, client: Client) -> bytes:
    """Render a completed form with its answers, score and signature block as a PDF.

    The header names the client's practice and primary clinician.
    """
    zone = ZoneInfo(client.practice.time_zone)
    pdf = BaseDocument(form.name, footer_text=f"Confidential | {client.full_name} | {form.name}")
    pdf.set_author(pdf_text(client.practice.name))
    _header(pdf, form, client, zone)
    _score_section(pdf, form)
    _fields_section(pdf, form)
    _signature_section(pdf, form, zone)
    return pdf.output_bytes()
