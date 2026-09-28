"""Export a client's complete record as a zip (records requests, transfers, leaving Synari).

Psychotherapy notes are never exported: they're kept apart from the record. Notes carry their
signature hashes, addenda and signed-version history; amendment requests (with any denial,
statement of disagreement and rebuttal) are included so later copies carry them.
"""

import csv
import io
import json
import re
import zipfile
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.access import Access
from synari.db import utcnow
from synari.models import (
    AmendmentRequest,
    Appointment,
    AppointmentParticipant,
    Client,
    ClientForm,
    Conversation,
    GoodFaithEstimate,
    Invoice,
    Message,
    MessageAttachment,
    Note,
    Payment,
    StaffMember,
    StoredFile,
    Superbill,
)
from synari.models.enums import ClientFormStatus, FilePurpose, Role
from synari.models.files import PSYCHOTHERAPY_NOTES_CATEGORY
from synari.schemas.clients import ClientOut, InsurancePolicyOut, RecordAccess
from synari.services.billing_pdf import invoice_pdf, superbill_pdf
from synari.services.form_pdf import pdf_filename, render_client_form_pdf
from synari.services.messaging import can_read_conversation, contact_sender_name
from synari.services.note_formats import NOTE_TYPE_LABELS
from synari.services.note_pdf import note_pdf_filename, render_note_pdf
from synari.services.note_records import part_of_record
from synari.services.scheduling import zone_of
from synari.services.storage import get_storage


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")[:120] or "file"


def _local(value: datetime | None, zone: ZoneInfo) -> str:
    return value.astimezone(zone).strftime("%Y-%m-%d %H:%M %Z") if value else ""


def _csv(rows: list[list[str]]) -> str:
    buffer = io.StringIO()
    csv.writer(buffer).writerows(rows)
    return buffer.getvalue()


def _staff_name(db: Session, staff_id: int) -> str:
    staff = db.get(StaffMember, staff_id)
    return staff.display_name if staff is not None else ""


def _write_appointments(
    bundle: zipfile.ZipFile, participations: list[AppointmentParticipant], zone: ZoneInfo
) -> None:
    """The client's sessions with their own attendance and fee (other attendees aren't named)."""
    rows = [
        [
            "starts",
            "ends",
            "status",
            "clinician",
            "service_code",
            "service",
            "fee",
            "billable",
            "location",
            "cancel_reason",
        ]
    ]
    for participant in participations:
        appointment = participant.appointment
        rows.append(
            [
                _local(appointment.starts_at, zone),
                _local(appointment.ends_at, zone),
                participant.effective_status,
                appointment.clinician.display_name,
                appointment.service_code,
                appointment.service_description,
                f"{participant.fee_cents / 100:.2f}",
                "yes" if participant.billable else "no",
                appointment.location_type,
                appointment.cancel_reason,
            ]
        )
    bundle.writestr("appointments.csv", _csv(rows))


def _write_notes(
    db: Session,
    bundle: zipfile.ZipFile,
    client: Client,
    appointments: list[Appointment],
    zone: ZoneInfo,
) -> None:
    by_id = {a.id: a for a in appointments}
    rows = [["created", "type", "status", "author", "signed", "signature_sha256", "file"]]
    history = [
        [
            "file",
            "version",
            "signed_by",
            "signed",
            "cosigned_by",
            "cosigned",
            "sha256",
            "reason_for_change",
        ]
    ]
    for note in db.scalars(
        select(Note).where(Note.client_id == client.id, part_of_record()).order_by(Note.created_at)
    ):
        filename = note_pdf_filename(note)
        appointment = by_id.get(note.appointment_id) if note.appointment_id else None
        bundle.writestr(f"notes/{filename}", render_note_pdf(note, client, appointment))
        rows.append(
            [
                _local(note.created_at, zone),
                NOTE_TYPE_LABELS.get(note.note_type, note.note_type),
                note.status,
                note.author.display_name,
                _local(note.signed_at, zone),
                note.content_sha256,
                filename,
            ]
        )
        history += [
            [
                filename,
                str(revision.version),
                revision.signed_by.display_name,
                _local(revision.signed_at, zone),
                revision.cosigned_by.display_name if revision.cosigned_by else "",
                _local(revision.cosigned_at, zone),
                revision.content_sha256,
                revision.reason,
            ]
            for revision in note.revisions
        ]
    bundle.writestr("notes.csv", _csv(rows))
    bundle.writestr("note_history.csv", _csv(history))


def _write_amendments(db: Session, bundle: zipfile.ZipFile, client: Client, zone: ZoneInfo) -> None:
    """Requests to amend the record, with the decision and any disagreement and rebuttal."""
    requests = db.scalars(
        select(AmendmentRequest)
        .where(AmendmentRequest.client_id == client.id)
        .order_by(AmendmentRequest.received_at, AmendmentRequest.id)
    ).all()
    if not requests:
        return
    sections = []
    for request in requests:
        lines = [
            f"Amendment request received {_local(request.received_at, zone)} ({request.status})",
            f"Request: {request.request}",
        ]
        if request.note is not None:
            lines.append(f"About: {note_pdf_filename(request.note)}")
        if request.decided_at is not None:
            decider = request.decided_by.display_name if request.decided_by else ""
            lines.append(f"Decided {_local(request.decided_at, zone)} by {decider}".rstrip())
        if request.denial_reason:
            lines.append(f"Reason for denial: {request.denial_reason}")
        if request.disagreement:
            lines.append(f"Statement of disagreement: {request.disagreement}")
        if request.rebuttal:
            lines.append(f"Practice's rebuttal: {request.rebuttal}")
        sections.append("\n".join(lines))
    bundle.writestr("amendments.txt", "\n\n".join(sections) + "\n")


def _write_forms(db: Session, bundle: zipfile.ZipFile, client: Client, zone: ZoneInfo) -> None:
    forms = db.scalars(
        select(ClientForm).where(ClientForm.client_id == client.id).order_by(ClientForm.sent_at)
    ).all()
    rows = [["form", "status", "shared", "completed", "score", "flagged"]]
    for form in forms:
        rows.append(
            [
                form.name,
                form.status,
                _local(form.sent_at, zone),
                _local(form.completed_at, zone),
                "" if form.score is None else str(form.score),
                "yes" if form.flagged else "",
            ]
        )
        if form.status == ClientFormStatus.COMPLETED:
            bundle.writestr(
                f"forms/{form.id}-{pdf_filename(form)}", render_client_form_pdf(form, client)
            )
    bundle.writestr("forms.csv", _csv(rows))


def _write_billing(db: Session, bundle: zipfile.ZipFile, client: Client, zone: ZoneInfo) -> None:
    for invoice in db.scalars(select(Invoice).where(Invoice.client_id == client.id)):
        bundle.writestr(
            f"billing/invoices/{_safe(invoice.number)}.pdf",
            invoice_pdf(db, invoice),
        )
    for superbill in db.scalars(select(Superbill).where(Superbill.client_id == client.id)):
        bundle.writestr(
            f"billing/superbills/{_safe(superbill.number)}.pdf", superbill_pdf(superbill)
        )
    rows = [["received", "amount", "method", "status", "refunded", "reference"]]
    rows += [
        [
            _local(p.received_at or p.created_at, zone),
            f"{p.amount_cents / 100:.2f}",
            p.method,
            p.status,
            f"{p.refunded_cents / 100:.2f}",
            p.reference,
        ]
        for p in db.scalars(
            select(Payment).where(Payment.client_id == client.id).order_by(Payment.created_at)
        )
    ]
    bundle.writestr("billing/payments.csv", _csv(rows))


def _write_estimates(db: Session, bundle: zipfile.ZipFile, client: Client) -> None:
    """Good faith estimates exactly as they were given to the client (drafts aren't)."""
    storage = get_storage()
    for stored in db.scalars(
        select(StoredFile)
        .join(GoodFaithEstimate, GoodFaithEstimate.file_id == StoredFile.id)
        .where(GoodFaithEstimate.client_id == client.id)
        .order_by(GoodFaithEstimate.issued_at, GoodFaithEstimate.id)
    ):
        bundle.writestr(
            f"estimates/{stored.id}-{_safe(stored.filename)}", storage.read(stored.storage_key)
        )


def _readable_conversations(access: Access, client: Client) -> list[Conversation]:
    """The client's conversations the exporter may read (threads are private to their
    clinician, supervisors and practice-wide clinical staff)."""
    conversations = access.db.scalars(
        select(Conversation).where(Conversation.client_id == client.id).order_by(Conversation.id)
    ).all()
    return [c for c in conversations if can_read_conversation(access, c, client)]


def _write_messages(
    db: Session,
    bundle: zipfile.ZipFile,
    client: Client,
    conversations: list[Conversation],
    zone: ZoneInfo,
) -> None:
    """One section per conversation (each is with one of the client's clinicians)."""
    contact_names = {
        contact.id: contact_sender_name(contact, client) for contact in client.contacts
    }
    if not conversations:
        return
    sections = []
    for conversation in conversations:
        clinician_name = _staff_name(db, conversation.clinician_id)
        lines = [f"Conversation with {clinician_name}", ""]
        for message in db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at)
        ):
            if message.sender_role == Role.CLIENT:
                sender = contact_names.get(message.sender_contact_id, "Client")
            elif message.sender_staff_id is not None:
                sender = _staff_name(db, message.sender_staff_id)
            else:
                sender = f"{clinician_name} (automatic reply)"
            body = "[message removed]" if message.removed_at else message.body
            files = ", ".join(a.file.filename for a in message.attachments)
            attached = f"\n  Attachments: {files}" if files else ""
            lines.append(f"{_local(message.created_at, zone)} | {sender}\n{body}{attached}\n")
        sections.append("\n".join(lines))
    bundle.writestr("messages.txt", "\n\n".join(sections))


def _write_documents(
    db: Session, bundle: zipfile.ZipFile, client: Client, conversations: list[Conversation]
) -> None:
    """Shared, uploaded and imported documents (never psychotherapy notes), plus attachments
    from the conversations being exported."""
    storage = get_storage()
    attachments = select(MessageAttachment.file_id).join(
        Message, Message.id == MessageAttachment.message_id
    )
    exported_attachments = attachments.where(
        Message.conversation_id.in_([c.id for c in conversations])
    )
    documents = StoredFile.purpose.in_(
        [FilePurpose.SHARED_DOCUMENT, FilePurpose.CLIENT_UPLOAD, FilePurpose.IMPORTED_DOCUMENT]
    )
    for stored in db.scalars(
        select(StoredFile).where(
            StoredFile.client_id == client.id,
            (documents & (StoredFile.category != PSYCHOTHERAPY_NOTES_CATEGORY))
            | StoredFile.id.in_(exported_attachments),
        )
    ):
        bundle.writestr(
            f"documents/{stored.purpose}/{stored.id}-{_safe(stored.filename)}",
            storage.read(stored.storage_key),
        )


def _readme(client: Client, exported: str, include_billing: bool) -> str:
    contents = [
        "client.json: profile, contacts and care team" + (", insurance" if include_billing else ""),
        "appointments.csv: appointments and their clinicians",
        "notes.csv and notes/: clinical notes (PDFs with addenda) and their authors",
        "note_history.csv: every signed version of each note, with its SHA-256 hash",
        "amendments.txt: requests to amend the record and their outcome (if any)",
        "forms.csv and forms/: shared forms, completed ones as PDFs",
        "estimates/: good faith estimates as issued",
        "messages.txt: secure messages",
        "documents/: shared, uploaded and imported files",
    ]
    if include_billing:
        contents.append("billing/: invoices, superbills and payments")
    listing = "\n".join(f"- {item}" for item in contents)
    return (
        f"Client record export for {client.full_name}\n"
        f"Practice: {client.practice.name}\n"
        f"Exported: {exported}\n\n"
        f"Contents:\n{listing}\n\n"
        "Psychotherapy notes are kept separately and aren't part of this export.\n"
        "This file contains protected health information. Store and send it securely.\n"
    )


def build_client_export(access: Access, client: Client, *, include_billing: bool) -> bytes:
    """Zip of the client's record as the exporter may see it. Session recordings are excluded
    (deleted once notes are signed), psychotherapy notes are never included, and only
    conversations the exporter can read are included.

    Billing records (insurance, invoices, superbills, payments) are included only when
    `include_billing` is set, i.e. the exporter also has billing access. Times are shown in the
    practice's time zone. Built in memory: fine for typical records (documents are capped at
    50 MB each).
    """
    db = access.db
    zone = zone_of(client.practice)
    conversations = _readable_conversations(access, client)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        record = ClientOut.build(client, RecordAccess(clinical=True, billing=include_billing))
        profile = record.model_dump(mode="json", exclude={"access"})
        if include_billing:
            profile["insurance_policies"] = [
                InsurancePolicyOut.model_validate(p).model_dump(mode="json")
                for p in client.insurance_policies
            ]
        bundle.writestr("client.json", json.dumps(profile, indent=2))

        participations = list(
            db.scalars(
                select(AppointmentParticipant)
                .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
                .where(AppointmentParticipant.client_id == client.id)
                .order_by(Appointment.starts_at)
            )
        )
        _write_appointments(bundle, participations, zone)
        appointments = [participant.appointment for participant in participations]
        _write_notes(db, bundle, client, appointments, zone)
        _write_amendments(db, bundle, client, zone)
        _write_forms(db, bundle, client, zone)
        _write_estimates(db, bundle, client)
        if include_billing:
            _write_billing(db, bundle, client, zone)
        _write_messages(db, bundle, client, conversations, zone)
        _write_documents(db, bundle, client, conversations)

        bundle.writestr("README.txt", _readme(client, _local(utcnow(), zone), include_billing))
    return archive.getvalue()
