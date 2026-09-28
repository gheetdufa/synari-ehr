"""Note signing rules shared by the notes API and the recording worker.

Signing: a clinician with an active supervisor signs into `pending_cosign` and the supervisor
co-signs (or sends the note back); everyone else signs straight to `signed`. Every signature and
co-signature is hashed and kept as a revision (services/note_records.py). Session audio and
transcripts are deleted once the notes drafted from them are signed.
"""

from datetime import datetime

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    Note,
    Recording,
    StaffMember,
    StoredFile,
)
from synari.models.enums import AppointmentStatus, NoteStatus, Role
from synari.services.note_records import readable_notes, seal_signature
from synari.services.notifications import notify
from synari.services.storage import get_storage

# A participant with one of these statuses wasn't in the session, so gets no session note.
ABSENT_STATUSES = frozenset(
    {
        AppointmentStatus.NO_SHOW,
        AppointmentStatus.CANCELED,
        AppointmentStatus.LATE_CANCELED,
        AppointmentStatus.DECLINED,
    }
)


def note_link(note: Note) -> str:
    """Where a note opens in the staff app (for notifications)."""
    return f"/portal/notes/{note.id}"


def present_participants(appointment: Appointment) -> list[AppointmentParticipant]:
    """The session's clients, leaving out anyone marked as a no-show or canceled."""
    return [p for p in appointment.participants if p.effective_status not in ABSENT_STATUSES]


def active_supervisor(db: Session, author: StaffMember) -> StaffMember | None:
    """The author's supervisor while they're an active member of the same practice."""
    if author.supervisor_id is None:
        return None
    supervisor = db.get(StaffMember, author.supervisor_id)
    if supervisor is None or not supervisor.is_active:
        return None
    return supervisor if supervisor.practice_id == author.practice_id else None


def sign_note(db: Session, note: Note, author: StaffMember, now: datetime) -> int:
    """Sign the author's non-empty draft (the caller checks that) and lock it.

    With an active supervisor the note waits for their co-signature and they're notified;
    otherwise it's signed. Returns how many recordings' audio and transcripts were deleted.
    The caller commits.
    """
    supervisor = active_supervisor(db, author)
    note.status = NoteStatus.SIGNED if supervisor is None else NoteStatus.PENDING_COSIGN
    note.signed_at = now
    note.was_signed = True
    note.supervisor = supervisor
    note.cosigned_at = None
    if supervisor is None:
        note.supervisor_comment = ""
    db.flush()
    seal_signature(db, note)
    if supervisor is not None:
        notify(
            db,
            Role.STAFF,
            supervisor.id,
            kind="note_cosign_requested",
            title=f"{author.display_name} signed a note that needs your co-signature",
            link=note_link(note),
        )
    return discard_recording_audio(db, note)


def _session_notes(db: Session, note: Note) -> list[Note]:
    """The author's notes on the same session (just this note when it has no appointment)."""
    if note.appointment_id is None:
        return [note]
    return list(
        db.scalars(
            select(Note).where(
                Note.practice_id == note.practice_id,
                Note.author_id == note.author_id,
                Note.appointment_id == note.appointment_id,
            )
        )
    )


def discard_recording_audio(db: Session, note: Note) -> int:
    """Delete audio and transcripts of recordings drafted into the author's notes on this
    session once none of those notes is a draft; the signed notes are the record.

    A multi-client session's recording is drafted into one note per client, so its audio stays
    until the last of them is signed. Returns how many recordings were cleared.
    """
    session_notes = _session_notes(db, note)
    if any(n.status == NoteStatus.DRAFT for n in session_notes):
        return 0
    recordings = db.scalars(
        select(Recording).where(
            Recording.practice_id == note.practice_id,
            Recording.note_id.in_([n.id for n in session_notes]),
        )
    ).all()
    for recording in recordings:
        recording.transcript = ""
        stored = db.get(StoredFile, recording.file_id) if recording.file_id is not None else None
        recording.file_id = None
        if stored is None:
            continue
        # Deleting the bytes first keeps this retryable: if the commit fails, signing again
        # finds the same row and the storage delete is a no-op.
        get_storage().delete(stored.storage_key)
        db.delete(stored)
    return len(recordings)


def reopen_signed_note(note: Note, reason: str) -> None:
    """Return a signed (or pending) note to draft; `reason` is kept for its next revision."""
    note.status = NoteStatus.DRAFT
    note.signed_at = None
    note.cosigned_at = None
    note.content_sha256 = ""
    note.pending_revision_reason = reason


def awaiting_cosign(access: Access) -> Select[tuple[Note]]:
    """Notes waiting for the signed-in staff member's co-signature, oldest signature first,
    limited to clients they can see clinically."""
    return (
        select(Note)
        .join(Client, Client.id == Note.client_id)
        .where(
            Note.practice_id == access.practice_id,
            Note.supervisor_id == access.staff.id,
            Note.status == NoteStatus.PENDING_COSIGN,
            access.client_filter(ClientAccess.CLINICAL),
            readable_notes(access),
        )
        .order_by(Note.signed_at, Note.id)
    )
