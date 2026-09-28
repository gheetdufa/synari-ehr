"""Record integrity for notes: signed revisions, addenda, integrity checks and the separate
handling of psychotherapy notes.

- Every signature and co-signature adds a NoteRevision holding the signed text and its hash, so
  unlocking a note to amend it never loses what was signed.
- Addenda add to a signed note without unlocking it. The note's author and their supervisor may
  write them (clinical staff also add one when accepting a client's amendment request).
- Psychotherapy notes (NoteType.PSYCHOTHERAPY) are readable only by their author and the
  supervisor asked to co-sign them, even by staff who can open the rest of the chart.
"""

from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, exists, func, or_, select
from sqlalchemy.orm import Session

from synari.access import Access
from synari.integrity import addendum_sha256
from synari.models import Note, NoteAddendum, NoteRevision, SecurityEvent, StaffMember
from synari.models.enums import NoteType, SecuritySeverity
from synari.services.security_events import record_security_event

INTEGRITY_EVENT = "note.integrity_mismatch"
# One integrity alert per note per day, however often the note is opened.
INTEGRITY_EVENT_INTERVAL = timedelta(days=1)


def can_read_note(access: Access, note: Note) -> bool:
    """Whether this person may read a note they can already reach clinically: psychotherapy
    notes are limited to their author and the supervisor asked to co-sign them."""
    if not note.is_psychotherapy:
        return True
    return access.staff.id in (note.author_id, note.supervisor_id)


def readable_notes(access: Access) -> ColumnElement[bool]:
    """SQL condition on `Note` matching can_read_note (combine with the client filter)."""
    return or_(
        Note.note_type != NoteType.PSYCHOTHERAPY,
        Note.author_id == access.staff.id,
        Note.supervisor_id == access.staff.id,
    )


def part_of_record() -> ColumnElement[bool]:
    """SQL condition on `Note` for notes that belong to the client's record: everything except
    psychotherapy notes, which never leave their author's hands (exports, releases, claims, AI,
    reports)."""
    return Note.note_type != NoteType.PSYCHOTHERAPY


def seal_signature(db: Session, note: Note, *, cosigner: StaffMember | None = None) -> NoteRevision:
    """Hash a just-signed (or just co-signed) note and keep the signed text as a new revision.

    The reason the note was last unlocked moves onto the revision. The caller commits.
    """
    note.content_sha256 = note.compute_content_sha256()
    latest = db.scalar(
        select(func.max(NoteRevision.version)).where(NoteRevision.note_id == note.id)
    )
    revision = NoteRevision(
        note_id=note.id,
        version=(latest or 0) + 1,
        title=note.title,
        sections=dict(note.sections),
        content=note.content,
        content_sha256=note.content_sha256,
        signed_by_id=note.author_id,
        signed_at=note.signed_at,
        cosigned_by_id=cosigner.id if cosigner is not None else None,
        cosigned_at=note.cosigned_at if cosigner is not None else None,
        reason="" if cosigner is not None else note.pending_revision_reason,
    )
    if cosigner is None:
        note.pending_revision_reason = ""
    db.add(revision)
    db.flush()
    return revision


def add_addendum(
    db: Session,
    note: Note,
    author: StaffMember,
    content: str,
    now: datetime,
    *,
    amendment_request_id: int | None = None,
) -> NoteAddendum:
    """Append an addendum to a signed note (the caller checks who may and commits)."""
    addendum = NoteAddendum(
        note_id=note.id,
        author_id=author.id,
        content=content,
        amendment_request_id=amendment_request_id,
        created_at=now,
        content_sha256=addendum_sha256(
            note_id=note.id,
            author_id=author.id,
            content=content,
            amendment_request_id=amendment_request_id,
            created_at=now,
        ),
    )
    db.add(addendum)
    db.flush()
    return addendum


def report_integrity_mismatch(
    db: Session, note: Note, staff: StaffMember | None, now: datetime
) -> None:
    """Raise a critical security event when a note's text no longer matches its signature hash
    (at most once a day per note). The caller commits."""
    already = db.scalar(
        select(
            exists().where(
                SecurityEvent.practice_id == note.practice_id,
                SecurityEvent.kind == INTEGRITY_EVENT,
                SecurityEvent.detail["note_id"].as_integer() == note.id,
                SecurityEvent.created_at >= now - INTEGRITY_EVENT_INTERVAL,
            )
        )
    )
    if already:
        return
    record_security_event(
        db,
        practice_id=note.practice_id,
        kind=INTEGRITY_EVENT,
        severity=SecuritySeverity.CRITICAL,
        staff_id=staff.id if staff is not None else None,
        detail={"note_id": note.id, "client_id": note.client_id},
    )
