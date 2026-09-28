"""Clinical notes: drafting, editing, signing (which locks the note), co-signing and unlocking.

Reading a note needs clinical access to its client (the care team, their supervisors and staff
with practice-wide clinical access). Only a note's author may change, sign, unlock or delete it.
A note linked to an appointment is about one of its participants; multi-client sessions have a
note per client (`POST /appointments/{id}/group-notes` starts them all).

Supervision: when a clinician with a supervisor signs, the note waits for that supervisor's
co-signature (`pending_cosign`) and stays locked for its author. Only that supervisor may
co-sign it or send it back with a comment.

Record integrity: every signature and co-signature keeps a hashed revision; unlocking needs a
reason (saved with the next revision); addenda add to a signed note without unlocking it, by its
author or their supervisor. Reads report whether the signed text still matches its hash.

Psychotherapy notes are kept apart from the record: only their author and the supervisor asked
to co-sign can see them (everyone else gets a 404), and every view is audited.
"""

from collections.abc import Iterable
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import joinedload

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession, get_current_staff
from synari.models import Appointment, Client, Note, NoteAddendum, NoteRevision, StaffMember
from synari.models.enums import AppointmentKind, NoteStatus, NoteType, Role
from synari.pagination import ListPage, paginate
from synari.schemas.notes import (
    AddendumCreate,
    AddendumOut,
    ChangesRequest,
    GroupNoteCreate,
    NoteCreate,
    NoteFormatOut,
    NoteOut,
    NoteRevisionOut,
    NoteSummary,
    NoteUpdate,
    UnlockRequest,
)
from synari.services.note_formats import (
    FORMATS,
    NoteFormat,
    default_title,
    normalize_note_text,
    note_is_empty,
)
from synari.services.note_pdf import note_pdf_filename, render_note_pdf
from synari.services.note_records import (
    add_addendum,
    can_read_note,
    readable_notes,
    report_integrity_mismatch,
    seal_signature,
)
from synari.services.notes import (
    active_supervisor,
    awaiting_cosign,
    note_link,
    present_participants,
    reopen_signed_note,
    sign_note,
)
from synari.services.notifications import notify
from synari.services.scheduling import zone_of

router = APIRouter(tags=["notes"])

LOCKED_DETAIL = "Unlock the note to edit it"
PENDING_DETAIL = "This note is waiting for your supervisor's co-signature"
NOT_AUTHOR_DETAIL = "Only the note's author can change it"
NOT_SUPERVISOR_DETAIL = "Only the supervisor asked to co-sign this note can do that"
EMPTY_DETAIL = "Add some content before signing the note"
# Relationships every note summary shows.
SUMMARY_LOADS = (
    joinedload(Note.client),
    joinedload(Note.author),
    joinedload(Note.supervisor),
    joinedload(Note.appointment),
)


def require_clinician(access: Access) -> StaffMember:
    """The signed-in staff member, who must be a clinician to write notes; 403 otherwise."""
    if not access.staff.is_clinician:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only clinicians can write notes")
    return access.staff


def load_note_subject(
    access: Access, client_id: int, appointment_id: int | None
) -> tuple[Client, Appointment | None]:
    """The client a note is about (with clinical access) and its appointment, which the client
    must be a participant of."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    if appointment_id is None:
        return client, None
    appointment = access.get(Appointment, appointment_id, label="Appointment")
    if all(participant.client_id != client.id for participant in appointment.participants):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "That client isn't part of this appointment"
        )
    return client, appointment


def _readable_note(access: Access, note_id: int) -> Note:
    """A note this person may read: clinical access to its client, and for a psychotherapy
    note, being its author or the supervisor asked to co-sign it; 404 otherwise."""
    note = access.client_record(Note, note_id, ClientAccess.CLINICAL, label="Note")
    if not can_read_note(access, note):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Note not found")
    return note


def _note_detail(note: Note) -> dict[str, bool] | None:
    """Audit detail flagging psychotherapy notes (every view of one is audited)."""
    return {"psychotherapy": True} if note.is_psychotherapy else None


def _check_integrity(access: Access, notes: Iterable[Note]) -> None:
    """Raise a security event for signed notes whose text no longer matches its hash."""
    for note in notes:
        if note.integrity == "mismatch":
            report_integrity_mismatch(access.db, note, access.staff, utcnow())


def _authored_note(access: Access, note_id: int) -> Note:
    """A note the signed-in staff member wrote; 404 if unreadable, 403 if someone else's."""
    note = _readable_note(access, note_id)
    if note.author_id != access.staff.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, NOT_AUTHOR_DETAIL)
    return note


def _supervised_note(access: Access, note_id: int) -> Note:
    """A note waiting for the signed-in supervisor's co-signature; 404 if unreadable, 403 if
    another supervisor was asked, 409 if it isn't waiting."""
    note = _readable_note(access, note_id)
    if note.supervisor_id != access.staff.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, NOT_SUPERVISOR_DETAIL)
    if note.status != NoteStatus.PENDING_COSIGN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This note isn't waiting for a co-signature")
    return note


def _ensure_editable(note: Note) -> None:
    if note.status == NoteStatus.PENDING_COSIGN:
        raise HTTPException(status.HTTP_409_CONFLICT, PENDING_DETAIL)
    if note.status == NoteStatus.SIGNED:
        raise HTTPException(status.HTTP_409_CONFLICT, LOCKED_DETAIL)


def _note_date(author: StaffMember, appointment: Appointment | None) -> date:
    moment = appointment.starts_at if appointment is not None else utcnow()
    return moment.astimezone(zone_of(author)).date()


def _normalized_text(
    format_id: str, sections: dict[str, str], content: str
) -> tuple[dict[str, str], str]:
    try:
        return normalize_note_text(format_id, sections, content)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


def _sign(access: Access, note: Note, request: Request) -> None:
    """Sign one of the caller's non-empty drafts and audit it (the caller commits)."""
    cleared = sign_note(access.db, note, access.staff, utcnow())
    detail: dict[str, int] = {"recordings_cleared": cleared}
    if note.supervisor_id is not None:
        detail["supervisor_id"] = note.supervisor_id
    audit_staff(
        access.db,
        request,
        access.staff,
        "note.sign",
        "note",
        note.id,
        detail,
        client_id=note.client_id,
    )


@router.get(
    "/notes/formats",
    response_model=list[NoteFormatOut],
    dependencies=[Depends(get_current_staff)],
)
def list_note_formats() -> list[NoteFormat]:
    """Supported note formats with their ordered sections and writing guidance."""
    return list(FORMATS.values())


@router.get("/notes", response_model=list[NoteSummary])
def list_notes(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    client_id: int | None = Query(default=None),
    appointment_id: int | None = Query(default=None),
    author_id: int | None = Query(default=None),
    status_filter: NoteStatus | None = Query(default=None, alias="status"),
    note_type: NoteType | None = Query(default=None),
) -> list[Note]:
    """A page of the notes about clients this person may see clinically, newest first,
    optionally filtered (other clinicians' psychotherapy notes are never listed)."""
    query = (
        select(Note)
        .join(Client, Client.id == Note.client_id)
        .where(
            Note.practice_id == access.practice_id,
            access.client_filter(ClientAccess.CLINICAL),
            readable_notes(access),
        )
        .options(*SUMMARY_LOADS)
    )
    if client_id is not None:
        query = query.where(Note.client_id == client_id)
    if appointment_id is not None:
        query = query.where(Note.appointment_id == appointment_id)
    if author_id is not None:
        query = query.where(Note.author_id == author_id)
    if status_filter is not None:
        query = query.where(Note.status == status_filter)
    if note_type is not None:
        query = query.where(Note.note_type == note_type)
    ordered = query.order_by(Note.created_at.desc(), Note.id.desc())
    notes = list(db.scalars(paginate(db, ordered, page, response)))
    _check_integrity(access, notes)
    audit_staff_list(db, request, access.staff, "note.list", [n.client_id for n in notes])
    db.commit()
    return notes


@router.get("/notes/cosign-queue", response_model=list[NoteSummary])
def cosign_queue(access: CurrentAccess, db: DbSession, request: Request) -> list[Note]:
    """Notes waiting for my co-signature as a supervisor, oldest signature first."""
    notes = list(db.scalars(awaiting_cosign(access).options(*SUMMARY_LOADS)))
    _check_integrity(access, notes)
    audit_staff_list(db, request, access.staff, "note.cosign_queue", [n.client_id for n in notes])
    db.commit()
    return notes


@router.post("/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(body: NoteCreate, access: CurrentAccess, db: DbSession, request: Request) -> Note:
    """Start a draft note for a client, optionally linked to an appointment they were in."""
    author = require_clinician(access)
    client, appointment = load_note_subject(access, body.client_id, body.appointment_id)
    format_id = body.format or author.note_format_default
    sections, content = _normalized_text(format_id, body.sections, body.content)
    note = Note(
        practice_id=access.practice_id,
        author=author,
        client=client,
        appointment=appointment,
        note_type=body.note_type,
        format=format_id,
        title=body.title or default_title(body.note_type, _note_date(author, appointment)),
        sections=sections,
        content=content,
        risk_level=body.risk_level,
        risk_flags=body.risk_flags,
        ai_generated=body.ai_generated,
    )
    db.add(note)
    db.flush()
    audit_staff(db, request, author, "note.create", "note", note.id, client_id=client.id)
    db.commit()
    return note


@router.post(
    "/appointments/{appointment_id}/group-notes",
    response_model=list[NoteOut],
    status_code=status.HTTP_201_CREATED,
)
def create_group_notes(
    appointment_id: int,
    body: GroupNoteCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> list[Note]:
    """Start a draft for each client in the session who doesn't have one from me yet, each
    with the same starting text. Clients marked absent are left out.

    Only the appointment's clinician may do this, and they need clinical access to every
    client in the session. Returns the drafts created.
    """
    author = require_clinician(access)
    appointment = access.get(Appointment, appointment_id, label="Appointment")
    if appointment.clinician_id != author.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the appointment's clinician can start its notes"
        )
    if appointment.kind == AppointmentKind.EVENT or not appointment.participants:
        raise HTTPException(status.HTTP_409_CONFLICT, "This appointment has no clients")
    clients = [
        access.client(participant.client_id, ClientAccess.CLINICAL)
        for participant in present_participants(appointment)
    ]
    format_id = body.format or author.note_format_default
    sections, content = _normalized_text(format_id, body.sections, body.content)
    title = body.title or default_title(body.note_type, _note_date(author, appointment))
    documented = set(
        db.scalars(
            select(Note.client_id).where(
                Note.practice_id == access.practice_id,
                Note.appointment_id == appointment.id,
                Note.author_id == author.id,
            )
        )
    )
    notes = [
        Note(
            practice_id=access.practice_id,
            author=author,
            client=client,
            appointment=appointment,
            note_type=body.note_type,
            format=format_id,
            title=title,
            sections=dict(sections),
            content=content,
        )
        for client in clients
        if client.id not in documented
    ]
    db.add_all(notes)
    db.flush()
    for note in notes:
        audit_staff(
            db,
            request,
            author,
            "note.create",
            "note",
            note.id,
            {"appointment_id": appointment.id},
            client_id=note.client_id,
        )
    db.commit()
    return notes


@router.post("/appointments/{appointment_id}/notes/sign", response_model=list[NoteOut])
def sign_session_notes(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[Note]:
    """Sign all of my draft notes for this appointment at once (each follows the single-note
    rules, including supervision). Nothing is signed if any draft is empty."""
    appointment = access.get(Appointment, appointment_id, label="Appointment")
    drafts = list(
        db.scalars(
            select(Note)
            .join(Client, Client.id == Note.client_id)
            .where(
                Note.practice_id == access.practice_id,
                Note.appointment_id == appointment.id,
                Note.author_id == access.staff.id,
                Note.status == NoteStatus.DRAFT,
                access.client_filter(ClientAccess.CLINICAL),
            )
            .order_by(Note.id)
        )
    )
    if any(note_is_empty(note) for note in drafts):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Add some content to every note before signing"
        )
    for note in drafts:
        _sign(access, note, request)
    db.commit()
    return drafts


@router.get("/notes/{note_id}", response_model=NoteOut)
def get_note(note_id: int, access: CurrentAccess, db: DbSession, request: Request) -> Note:
    """A note's full text, with whether its signed text still matches its signature hash."""
    note = _readable_note(access, note_id)
    _check_integrity(access, [note])
    audit_staff(
        db,
        request,
        access.staff,
        "note.view",
        "note",
        note.id,
        _note_detail(note),
        client_id=note.client_id,
    )
    db.commit()
    return note


@router.get("/notes/{note_id}/revisions", response_model=list[NoteRevisionOut])
def list_note_revisions(
    note_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[NoteRevision]:
    """Every signed version of the note, oldest first, with who signed (and co-signed) it,
    why it was changed and whether it still matches its hash."""
    note = _readable_note(access, note_id)
    revisions = list(note.revisions)
    if any(revision.integrity == "mismatch" for revision in revisions):
        report_integrity_mismatch(db, note, access.staff, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "note.revisions_view",
        "note",
        note.id,
        _note_detail(note),
        client_id=note.client_id,
    )
    db.commit()
    return revisions


@router.get("/notes/{note_id}/addenda", response_model=list[AddendumOut])
def list_note_addenda(
    note_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[NoteAddendum]:
    """Addenda written after the note was signed, oldest first."""
    note = _readable_note(access, note_id)
    addenda = list(note.addenda)
    if any(addendum.integrity == "mismatch" for addendum in addenda):
        report_integrity_mismatch(db, note, access.staff, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "note.addenda_view",
        "note",
        note.id,
        _note_detail(note),
        client_id=note.client_id,
    )
    db.commit()
    return addenda


@router.post(
    "/notes/{note_id}/addenda", response_model=AddendumOut, status_code=status.HTTP_201_CREATED
)
def create_note_addendum(
    note_id: int, body: AddendumCreate, access: CurrentAccess, db: DbSession, request: Request
) -> NoteAddendum:
    """Add to a signed note without unlocking it. For the note's author, the supervisor asked
    to co-sign it and the author's supervisor."""
    note = _readable_note(access, note_id)
    author_supervisor = db.scalar(
        select(StaffMember.supervisor_id).where(StaffMember.id == note.author_id)
    )
    if access.staff.id not in (note.author_id, note.supervisor_id, author_supervisor):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the note's author or their supervisor can add to it"
        )
    if note.status == NoteStatus.DRAFT:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Addenda are for signed notes; edit the draft instead"
        )
    addendum = add_addendum(db, note, access.staff, body.content, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "note.addendum_create",
        "note",
        note.id,
        {"addendum_id": addendum.id, **(_note_detail(note) or {})},
        client_id=note.client_id,
    )
    db.commit()
    return addendum


@router.get("/notes/{note_id}/pdf")
def download_note_pdf(
    note_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    """The note as a PDF (drafts are clearly marked as unsigned)."""
    note = _readable_note(access, note_id)
    content = render_note_pdf(note, note.client, note.appointment)
    audit_staff(
        db,
        request,
        access.staff,
        "note.download",
        "note",
        note.id,
        _note_detail(note),
        client_id=note.client_id,
    )
    db.commit()
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{note_pdf_filename(note)}"'},
    )


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(
    note_id: int, body: NoteUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> Note:
    """Edit your draft note. Signed notes must be unlocked first."""
    note = _authored_note(access, note_id)
    _ensure_editable(note)
    changes = body.model_dump(exclude_unset=True)
    if "appointment_id" in changes:
        _, appointment = load_note_subject(access, note.client_id, body.appointment_id)
        note.appointment = appointment
    if changes.keys() & {"format", "sections", "content"}:
        format_id = body.format or note.format
        note.sections, note.content = _normalized_text(
            format_id,
            body.sections if body.sections is not None else note.sections,
            body.content if body.content is not None else note.content,
        )
        note.format = format_id
    for field in ("note_type", "title", "risk_level", "risk_flags"):
        if changes.get(field) is not None:
            setattr(note, field, changes[field])
    audit_staff(
        db,
        request,
        access.staff,
        "note.update",
        "note",
        note.id,
        {"fields": sorted(changes)},
        client_id=note.client_id,
    )
    db.commit()
    return note


@router.post("/notes/{note_id}/sign", response_model=NoteOut)
def sign_one_note(note_id: int, access: CurrentAccess, db: DbSession, request: Request) -> Note:
    """Sign and lock your note. If you have a supervisor it then waits for their co-signature.
    Session audio and transcripts behind it are deleted."""
    note = _authored_note(access, note_id)
    if note.status == NoteStatus.PENDING_COSIGN:
        raise HTTPException(status.HTTP_409_CONFLICT, PENDING_DETAIL)
    if note.status == NoteStatus.SIGNED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This note is already signed")
    if note_is_empty(note):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, EMPTY_DETAIL)
    _sign(access, note, request)
    db.commit()
    return note


@router.post("/notes/{note_id}/unlock", response_model=NoteOut)
def unlock_note(
    note_id: int, body: UnlockRequest, access: CurrentAccess, db: DbSession, request: Request
) -> Note:
    """Return your signed note to draft so it can be amended; it must be signed (and co-signed)
    again. The signed text stays in the note's revisions and `reason` is saved with the next
    one. A note waiting for co-signature stays locked while the supervisor asked is still your
    supervisor (if they left or were replaced, unlock and sign it again)."""
    note = _authored_note(access, note_id)
    if note.status == NoteStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, "This note isn't signed")
    if note.status == NoteStatus.PENDING_COSIGN:
        supervisor = active_supervisor(db, access.staff)
        if supervisor is not None and supervisor.id == note.supervisor_id:
            raise HTTPException(status.HTTP_409_CONFLICT, PENDING_DETAIL)
    reopen_signed_note(note, body.reason)
    audit_staff(db, request, access.staff, "note.unlock", "note", note.id, client_id=note.client_id)
    db.commit()
    return note


@router.post("/notes/{note_id}/cosign", response_model=NoteOut)
def cosign_note(note_id: int, access: CurrentAccess, db: DbSession, request: Request) -> Note:
    """Co-sign a supervisee's note that's waiting for you; it's then fully signed."""
    note = _supervised_note(access, note_id)
    note.status = NoteStatus.SIGNED
    note.cosigned_at = utcnow()
    note.supervisor_comment = ""
    seal_signature(db, note, cosigner=access.staff)
    notify(
        db,
        Role.STAFF,
        note.author_id,
        kind="note_cosigned",
        title=f"{access.staff.display_name} co-signed your note",
        link=note_link(note),
    )
    audit_staff(db, request, access.staff, "note.cosign", "note", note.id, client_id=note.client_id)
    db.commit()
    return note


@router.post("/notes/{note_id}/request-changes", response_model=NoteOut)
def request_note_changes(
    note_id: int, body: ChangesRequest, access: CurrentAccess, db: DbSession, request: Request
) -> Note:
    """Send a supervisee's note back to draft with a comment; they edit and sign it again."""
    note = _supervised_note(access, note_id)
    reopen_signed_note(note, f"Returned for changes by {access.staff.display_name}: {body.comment}")
    note.supervisor_comment = body.comment
    notify(
        db,
        Role.STAFF,
        note.author_id,
        kind="note_changes_requested",
        title=f"{access.staff.display_name} asked for changes to your note",
        link=note_link(note),
    )
    audit_staff(
        db, request, access.staff, "note.request_changes", "note", note.id, client_id=note.client_id
    )
    db.commit()
    return note


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: int, access: CurrentAccess, db: DbSession, request: Request) -> None:
    """Delete your draft note. Signed notes are part of the record and can't be deleted."""
    note = _authored_note(access, note_id)
    if note.was_signed:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Notes that have been signed are part of the record"
        )
    db.delete(note)
    audit_staff(db, request, access.staff, "note.delete", "note", note_id, client_id=note.client_id)
    db.commit()
