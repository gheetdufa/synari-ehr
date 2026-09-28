"""AI documentation assistant: note drafts, "Ask Synari" and dictation.

Nothing here saves clinical content: drafts and transcripts go back to the staff member to
review. Client context needs clinical access to the client. Note drafts are for clinicians (who
author notes) and follow the clinician's own note format and writing-style preferences. A draft
for one client of a multi-client session shares only that client's details.

Each route commits its audit event before calling the provider, so the disclosure is recorded
even if the call fails and no database transaction is held open while the model works.
"""

from pathlib import PurePosixPath

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from synari.access import ClientAccess
from synari.api.notes import load_note_subject, require_clinician
from synari.audit import audit_staff
from synari.config import settings
from synari.deps import CurrentAccess, CurrentStaff, DbSession
from synari.models import Client, Note, StaffMember
from synari.models.enums import NoteStatus
from synari.schemas.ai import (
    AssistantReply,
    AssistantRequest,
    NoteGenerateRequest,
    NoteProposalOut,
    TranscriptionOut,
)
from synari.services import ai as ai_service
from synari.services.ai import (
    AI_DISABLED_DETAIL,
    MAX_TRANSCRIPTION_BYTES,
    TRANSCRIBABLE_EXTENSIONS,
    AIError,
    ChatMessage,
)
from synari.services.note_formats import note_plain_text
from synari.services.note_records import part_of_record
from synari.services.notes import present_participants

router = APIRouter(prefix="/ai", tags=["ai"])

ASSISTANT_NOTE_COUNT = 3
ASSISTANT_NOTE_CHARS = 2000


def _require_ai() -> None:
    if not settings.ai_enabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, AI_DISABLED_DETAIL)


def _provider_failed(exc: AIError) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + " [truncated]"


def _practice_context(staff: StaffMember, client: Client | None, notes: list[Note]) -> str:
    if staff.is_clinician:
        lines = [
            f"Clinician: {staff.display_name}",
            f"Default note format: {staff.note_format_default}",
        ]
    else:
        lines = [f"Team member: {staff.display_name} ({staff.role.replace('_', ' ')})"]
    lines.append(f"Practice: {staff.practice.name}")
    if client is None:
        return "\n".join(lines)
    lines += ["", "Selected client:", ai_service.describe_client(client)]
    if notes:
        lines += ["", "Most recent signed notes (newest first):"]
        for note in notes:
            lines += ["", f"[{note.title}]", _truncate(note_plain_text(note), ASSISTANT_NOTE_CHARS)]
    return "\n".join(lines)


@router.post("/notes/generate", response_model=NoteProposalOut)
def generate_note(
    body: NoteGenerateRequest, access: CurrentAccess, db: DbSession, request: Request
) -> NoteProposalOut:
    """Draft a note from session material. Nothing is saved; the clinician reviews the draft."""
    _require_ai()
    author = require_clinician(access)
    client, appointment = load_note_subject(access, body.client_id, body.appointment_id)
    format_id = body.format or author.note_format_default
    style_instructions = author.ai_style_instructions
    others = (
        sum(p.client_id != client.id for p in present_participants(appointment))
        if appointment is not None
        else 0
    )
    client_context = ai_service.describe_client(client, other_clients_in_session=others)
    audit_staff(
        db,
        request,
        author,
        "ai.note_generate",
        "client",
        client.id,
        {"format": format_id, "appointment_id": appointment.id if appointment else None},
        client_id=client.id,
    )
    db.commit()
    try:
        proposal = ai_service.generate_note(
            format_id, body.note_type, body.source_text, style_instructions, client_context
        )
    except AIError as exc:
        raise _provider_failed(exc) from exc
    return NoteProposalOut(
        format=format_id,
        sections=proposal.sections,
        content=proposal.content,
        risk_flags=proposal.risk_flags,
    )


@router.post("/assistant", response_model=AssistantReply)
def ask_synari(
    body: AssistantRequest, access: CurrentAccess, db: DbSession, request: Request
) -> AssistantReply:
    """Answer a documentation or practice question, optionally about one client (which needs
    clinical access to that client)."""
    _require_ai()
    client: Client | None = None
    notes: list[Note] = []
    if body.client_id is not None:
        client = access.client(body.client_id, ClientAccess.CLINICAL)
        notes = list(
            db.scalars(
                select(Note)
                .where(
                    Note.practice_id == access.practice_id,
                    Note.client_id == client.id,
                    Note.status == NoteStatus.SIGNED,
                    part_of_record(),
                )
                .order_by(Note.signed_at.desc(), Note.id.desc())
                .limit(ASSISTANT_NOTE_COUNT)
            )
        )
    context = _practice_context(access.staff, client, notes)
    audit_staff(
        db,
        request,
        access.staff,
        "ai.assistant",
        "client" if client else "",
        client.id if client else None,
        {"note_ids": [note.id for note in notes]},
        client_id=client.id if client else None,
    )
    db.commit()
    messages = [ChatMessage(role=m.role, content=m.content) for m in body.messages]
    try:
        reply = ai_service.assistant_reply(messages, context)
    except AIError as exc:
        raise _provider_failed(exc) from exc
    return AssistantReply(reply=reply)


@router.post("/transcribe", response_model=TranscriptionOut)
def transcribe_dictation(
    staff: CurrentStaff, db: DbSession, request: Request, file: UploadFile = File(...)
) -> TranscriptionOut:
    """Transcribe dictated audio (up to 25 MB). Neither the audio nor the text is stored."""
    _require_ai()
    extension = PurePosixPath(file.filename or "").suffix.lower()
    if extension not in TRANSCRIBABLE_EXTENSIONS:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Upload an audio file (mp3, m4a, mp4, wav, webm, ogg or flac)",
        )
    audio = file.file.read(MAX_TRANSCRIPTION_BYTES + 1)
    if len(audio) > MAX_TRANSCRIPTION_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Audio must be under 25 MB")
    if not audio:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The file is empty")
    audit_staff(db, request, staff, "ai.transcribe", detail={"bytes": len(audio)})
    db.commit()
    try:
        text = ai_service.transcribe(audio, f"dictation{extension}")
    except AIError as exc:
        raise _provider_failed(exc) from exc
    return TranscriptionOut(text=text)
