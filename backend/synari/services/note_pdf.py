"""PDF of a clinical note, for printing, records requests and client record exports.

Signed notes print their signature hash, any addenda written since, and the history of signed
versions, so a copy carries the evidence that the record wasn't altered.
"""

import re
from datetime import datetime
from zoneinfo import ZoneInfo

from synari.models import Appointment, Client, Note
from synari.models.enums import NoteStatus
from synari.services.note_formats import FORMATS, FREEFORM, NOTE_TYPE_LABELS
from synari.services.pdf import ACCENT, ALERT, INK, MUTED, BaseDocument, pdf_text


def _format_datetime(value: datetime, zone: ZoneInfo) -> str:
    local = value.astimezone(zone)
    hour = local.hour % 12 or 12
    return f"{local:%b} {local.day}, {local.year} at {hour}:{local:%M} {local:%p} {local:%Z}"


def note_pdf_filename(note: Note) -> str:
    """A download name like 'progress-note-2026-10-05-12.pdf'."""
    slug = re.sub(r"[^a-z0-9]+", "-", NOTE_TYPE_LABELS.get(note.note_type, "note").lower())
    return f"{slug.strip('-')}-{note.created_at:%Y-%m-%d}-{note.id}.pdf"


def render_note_pdf(note: Note, client: Client, appointment: Appointment | None) -> bytes:
    """Render the note's text with practice, author, client and signature details.

    Dates are shown on the author's wall clock, like the note's default title.
    """
    author = note.author
    practice_name = author.practice.name
    zone = ZoneInfo(author.time_zone)
    document = BaseDocument(
        note.title or "Clinical note", footer_text=f"Confidential | {client.full_name}"
    )
    document.set_author(pdf_text(practice_name))
    document.write_block(practice_name, size=14, style="B", color=ACCENT)
    document.write_block(author.display_name, size=9, color=MUTED, space_after=4)
    document.write_block(
        note.title or "Clinical note", size=16, style="B", line_height=7, space_after=2
    )

    dob = (
        f"{client.date_of_birth:%b} {client.date_of_birth.day}, {client.date_of_birth.year}"
        if client.date_of_birth
        else "Not on file"
    )
    details = [f"Client: {client.full_name}", f"Date of birth: {dob}"]
    if appointment is not None:
        details.append(f"Date of service: {_format_datetime(appointment.starts_at, zone)}")
        if appointment.service_code:
            details.append(f"Service: {appointment.service_code} {appointment.service_description}")
    format_name = FORMATS[note.format].name if note.format in FORMATS else note.format
    details.append(f"{NOTE_TYPE_LABELS.get(note.note_type, 'Note')} ({format_name})")
    for line in details:
        document.write_block(line, color=MUTED)
    document.rule(6)

    if note.format == FREEFORM or note.format not in FORMATS:
        document.write_block(note.content.strip() or "No content.", space_after=3)
    else:
        for section in FORMATS[note.format].sections:
            document.keep_together(18)
            document.write_block(section.label, style="B", color=ACCENT)
            text = note.sections.get(section.id, "").strip()
            document.write_block(
                text or "Not documented.", color=INK if text else MUTED, space_after=4
            )

    if note.risk_flags:
        document.keep_together(20)
        document.write_block("Safety concerns noted", style="B", color=ALERT)
        for flag in note.risk_flags:
            document.write_block(f"- {flag}", color=ALERT)
        document.ln(3)

    document.keep_together(24)
    document.rule(6)
    for line, color in _signature_lines(note, zone):
        document.write_block(line, style="B", color=color)
    if note.content_sha256 and note.status != NoteStatus.DRAFT:
        document.write_block(f"Signature hash (SHA-256): {note.content_sha256}", color=MUTED)
    _addenda(document, note, zone)
    _revision_history(document, note, zone)
    return document.output_bytes()


def _addenda(document: BaseDocument, note: Note, zone: ZoneInfo) -> None:
    if not note.addenda:
        return
    document.ln(4)
    document.keep_together(24)
    document.write_block("Addenda", size=12, style="B", color=ACCENT, space_after=2)
    for addendum in note.addenda:
        document.keep_together(18)
        written = _format_datetime(addendum.created_at, zone)
        label = "Amendment accepted" if addendum.amendment_request_id else "Addendum"
        document.write_block(
            f"{label} by {addendum.author.display_name} on {written}", style="B", color=INK
        )
        document.write_block(addendum.content.strip(), space_after=1)
        document.write_block(f"SHA-256: {addendum.content_sha256}", color=MUTED, space_after=3)


def _revision_history(document: BaseDocument, note: Note, zone: ZoneInfo) -> None:
    if len(note.revisions) < 2:
        return
    document.ln(4)
    document.keep_together(24)
    document.write_block("Signature history", size=12, style="B", color=ACCENT, space_after=2)
    for revision in note.revisions:
        document.keep_together(14)
        signed = _format_datetime(revision.signed_at, zone)
        line = (
            f"Version {revision.version}: signed by {revision.signed_by.display_name} on {signed}"
        )
        if revision.cosigned_by is not None and revision.cosigned_at is not None:
            cosigned = _format_datetime(revision.cosigned_at, zone)
            line += f", co-signed by {revision.cosigned_by.display_name} on {cosigned}"
        document.write_block(line, color=INK)
        if revision.reason:
            document.write_block(f"Reason for change: {revision.reason}", color=MUTED)
        document.write_block(f"SHA-256: {revision.content_sha256}", color=MUTED, space_after=2)


def _signature_lines(note: Note, zone: ZoneInfo) -> list[tuple[str, tuple[int, int, int]]]:
    """The author's signature, then the supervisor's co-signature (or that it's pending)."""
    if note.status == NoteStatus.DRAFT or note.signed_at is None:
        return [("DRAFT - not signed", ALERT)]
    signed_on = _format_datetime(note.signed_at, zone)
    lines = [(f"Electronically signed by {note.author.display_name} on {signed_on}", INK)]
    supervisor = note.supervisor
    if supervisor is None:
        return lines
    if note.status == NoteStatus.PENDING_COSIGN:
        lines.append((f"Awaiting co-signature by {supervisor.display_name}", ALERT))
    elif note.cosigned_at is not None:
        cosigned_on = _format_datetime(note.cosigned_at, zone)
        lines.append((f"Co-signed by {supervisor.display_name} on {cosigned_on}", INK))
    return lines
