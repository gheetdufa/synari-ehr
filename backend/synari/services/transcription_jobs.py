"""Worker job: transcribe uploaded session recordings and draft progress notes from each.

A recording moves uploaded -> transcribing -> transcribed (with linked draft notes) or failed
(with a short, clinician-readable error). Recordings stuck in "transcribing" because a worker
died mid-job are picked up again after STALE_AFTER.

Recordings belong to the practice. The session's transcript becomes one draft progress note per
client who attended (one for an individual session), each drafted with only that client's
details. The drafts are authored by the appointment's clinician, in their default note format
and writing style, and only they hear about the result. `Recording.note_id` points to the
first client's draft.
"""

import logging
from datetime import datetime, timedelta
from pathlib import PurePosixPath

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import Appointment, AuditEvent, Note, Recording, StoredFile
from synari.models.enums import NoteType, RecordingStatus, RiskLevel, Role
from synari.realtime import publish
from synari.services import ai
from synari.services.note_formats import default_title
from synari.services.notes import note_link, present_participants
from synari.services.notifications import notify
from synari.services.scheduling import zone_of
from synari.services.storage import get_storage

logger = logging.getLogger(__name__)

BATCH_SIZE = 3
STALE_AFTER = timedelta(hours=1)
MAX_ERROR_CHARS = 500

NOT_CONFIGURED = "Transcription isn't configured"
FILE_MISSING = "The recording file is missing"
NO_CLIENT = "The appointment for this recording has no client"
NO_SPEECH = "No speech was detected in the recording"
UNEXPECTED = "Something went wrong while processing the recording"


class _Unprocessable(Exception):
    """A recording that can't become a note; the message is shown to the clinician."""


def process_recordings(db: Session, now: datetime) -> None:
    """Worker job: claim a small batch of uploaded recordings and process each one."""
    claimed = db.scalars(
        select(Recording)
        .where(
            or_(
                Recording.status == RecordingStatus.UPLOADED,
                and_(
                    Recording.status == RecordingStatus.TRANSCRIBING,
                    Recording.updated_at < now - STALE_AFTER,
                ),
            )
        )
        .order_by(Recording.id)
        .limit(BATCH_SIZE)
        .with_for_update(skip_locked=True)
    ).all()
    if not claimed:
        return
    for recording in claimed:
        recording.status = RecordingStatus.TRANSCRIBING
        recording.updated_at = now
    db.commit()
    for recording in claimed:
        _process(db, recording)


def _process(db: Session, recording: Recording) -> None:
    try:
        _transcribe_and_draft(db, recording)
    except (ai.AIError, _Unprocessable) as exc:
        db.rollback()
        _mark_failed(db, recording, str(exc))
    except Exception:
        logger.exception("Processing recording %s failed", recording.id)
        db.rollback()
        _mark_failed(db, recording, UNEXPECTED)


def _transcribe_and_draft(db: Session, recording: Recording) -> None:
    if not settings.ai_enabled:
        raise _Unprocessable(NOT_CONFIGURED)
    appointment = db.get(Appointment, recording.appointment_id)
    if appointment is None or appointment.practice_id != recording.practice_id:
        raise _Unprocessable(NO_CLIENT)
    participants = present_participants(appointment)
    if not participants:
        raise _Unprocessable(NO_CLIENT)
    stored = db.get(StoredFile, recording.file_id) if recording.file_id is not None else None
    if stored is None or stored.practice_id != recording.practice_id:
        raise _Unprocessable(FILE_MISSING)
    clinician = appointment.clinician
    format_id = clinician.note_format_default
    style_instructions = clinician.ai_style_instructions
    # Each client's draft sees only that client's details.
    client_contexts = [
        (
            participant.client_id,
            ai.describe_client(participant.client, other_clients_in_session=len(participants) - 1),
        )
        for participant in participants
    ]
    title = default_title(
        NoteType.PROGRESS, appointment.starts_at.astimezone(zone_of(clinician)).date()
    )
    audio = get_storage().read(stored.storage_key)
    # The provider only needs the extension to detect the format, never the original name.
    upload_name = f"recording{PurePosixPath(stored.filename).suffix.lower()}"
    # End the read transaction so nothing is held open while the provider works.
    db.commit()

    transcript = ai.transcribe(audio, upload_name)
    if not transcript:
        raise _Unprocessable(NO_SPEECH)
    proposals = [
        (
            client_id,
            ai.generate_note(format_id, NoteType.PROGRESS, transcript, style_instructions, context),
        )
        for client_id, context in client_contexts
    ]

    notes = [
        Note(
            practice_id=recording.practice_id,
            author_id=clinician.id,
            client_id=client_id,
            appointment_id=appointment.id,
            note_type=NoteType.PROGRESS,
            format=format_id,
            title=title,
            sections=proposal.sections,
            content=proposal.content,
            ai_generated=True,
            risk_flags=proposal.risk_flags,
            risk_level=RiskLevel.MODERATE if proposal.risk_flags else RiskLevel.NONE,
        )
        for client_id, proposal in proposals
    ]
    db.add_all(notes)
    db.flush()
    note_ids = [note.id for note in notes]
    recording.transcript = transcript
    recording.note_id = note_ids[0]
    recording.status = RecordingStatus.TRANSCRIBED
    recording.error = ""
    db.add(
        AuditEvent(
            practice_id=recording.practice_id,
            actor_role="system",
            action="recording.transcribe",
            resource_type="recording",
            resource_id=recording.id,
            detail={"note_ids": note_ids, "author_id": clinician.id},
            client_id=notes[0].client_id if len(notes) == 1 else None,
        )
    )
    publish(
        db,
        [(Role.STAFF, clinician.id)],
        "recording.processed",
        {
            "recording_id": recording.id,
            "note_id": note_ids[0],
            "note_ids": note_ids,
            "appointment_id": appointment.id,
        },
    )
    if len(notes) == 1:
        heading = "Session transcribed: a draft note is ready to review"
        link = note_link(notes[0])
    else:
        heading = f"Session transcribed: {len(notes)} draft notes are ready to review"
        link = "/portal/notes?status=draft"
    notify(db, Role.STAFF, clinician.id, kind="note_drafted", title=heading, link=link)
    db.commit()


def _mark_failed(db: Session, recording: Recording, error: str) -> None:
    recording.status = RecordingStatus.FAILED
    recording.error = error[:MAX_ERROR_CHARS]
    clinician_id = db.get_one(Appointment, recording.appointment_id).clinician_id
    publish(
        db,
        [(Role.STAFF, clinician_id)],
        "recording.failed",
        {"recording_id": recording.id, "appointment_id": recording.appointment_id},
    )
    notify(
        db,
        Role.STAFF,
        clinician_id,
        kind="recording_failed",
        title="A session recording couldn't be transcribed",
        link=f"/portal/calendar?appointment={recording.appointment_id}",
    )
    db.commit()
