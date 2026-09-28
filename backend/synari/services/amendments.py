"""Amendment requests (HIPAA 164.526): a client asks to correct their record and the practice
decides within 60 days.

Accepting adds the correction as an addendum to the note (the signed text is never rewritten).
Denying keeps the reason; the client may then file a statement of disagreement and the
practice may answer it with a rebuttal. All of it stays linked to the request and is included
in later copies of the record.
"""

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import AmendmentRequest, Client, Note, NoteAddendum
from synari.models.enums import AmendmentStatus, NoteStatus, Role
from synari.services.note_records import add_addendum, can_read_note
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_portal_email
from synari.services.request_deadlines import (
    CLIENT_RECORDS_PATH,
    due_date,
    notify_handlers,
    practice_today,
    send_deadline_nudge,
)

RESPONSE_DAYS = 60


def amendment_link(amendment: AmendmentRequest) -> str:
    """Where an amendment request opens in the staff app."""
    return f"/portal/records?amendment={amendment.id}"


def amendable_note(access: Access, client: Client, note_id: int) -> Note:
    """A signed note of `client`'s that an amendment can apply to: part of the record (not a
    psychotherapy note) and readable by this person."""
    note = access.client_record(Note, note_id, ClientAccess.CLINICAL, label="Note")
    if note.client_id != client.id or not can_read_note(access, note):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Note not found")
    if note.is_psychotherapy:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Psychotherapy notes aren't part of the record a client can amend",
        )
    return note


def create_amendment_request(
    db: Session,
    client: Client,
    *,
    requested_by: str,
    request: str,
    now: datetime,
    note: Note | None = None,
) -> AmendmentRequest:
    """Record a new amendment request, due 60 days after it arrived (the caller commits)."""
    amendment = AmendmentRequest(
        practice_id=client.practice_id,
        client_id=client.id,
        note_id=note.id if note is not None else None,
        requested_by=requested_by,
        received_at=now,
        due_on=due_date(client.practice, now, RESPONSE_DAYS),
        request=request,
    )
    db.add(amendment)
    db.flush()
    return amendment


def notify_new_amendment_request(db: Session, client: Client, amendment: AmendmentRequest) -> None:
    """Tell the handlers a client asked to amend their record."""
    notify_handlers(
        db,
        client,
        kind="amendment_request",
        title=f"{short_name(client)} asked to amend their record",
        link=amendment_link(amendment),
        email_subject="New request to amend a record",
    )


def require_open(amendment: AmendmentRequest) -> None:
    """409 unless the request is still waiting for a decision."""
    if amendment.status != AmendmentStatus.OPEN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request has already been decided")


def _notify_client(db: Session, amendment: AmendmentRequest, title: str, event: str) -> None:
    """Tell the client (in the app and by content-free email) there's news on their request."""
    client = amendment.client
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="amendment_request_update",
        title=title,
        link=CLIENT_RECORDS_PATH,
    )
    queue_portal_email(
        db,
        client,
        subject=f"An update on your request from {client.practice.name}",
        heading="Your request was reviewed",
        paragraphs=[
            "Your practice responded to your request to amend your record. Sign in to your "
            "client portal to see their response."
        ],
        button_label="View response",
        next_path=CLIENT_RECORDS_PATH,
        dedupe_key=f"amendment-{amendment.id}-{event}",
    )


def accept_amendment(
    access: Access, amendment: AmendmentRequest, content: str, note_id: int | None, now: datetime
) -> NoteAddendum:
    """Accept the request: add `content` as an addendum (by the person accepting) to the
    request's note or `note_id`, and tell the client. The caller commits."""
    require_open(amendment)
    target_id = amendment.note_id if note_id is None else note_id
    if target_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the note the amendment applies to"
        )
    note = amendable_note(access, amendment.client, target_id)
    if note.status == NoteStatus.DRAFT:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Amendments are added to signed notes; edit the draft instead"
        )
    addendum = add_addendum(
        access.db, note, access.staff, content, now, amendment_request_id=amendment.id
    )
    amendment.note_id = note.id
    amendment.status = AmendmentStatus.ACCEPTED
    amendment.decided_at = now
    amendment.decided_by_id = access.staff.id
    _notify_client(
        access.db, amendment, "Your request to amend your record was accepted", "accepted"
    )
    return addendum


def deny_amendment(access: Access, amendment: AmendmentRequest, reason: str, now: datetime) -> None:
    """Deny the request with a reason; the client may file a statement of disagreement."""
    require_open(amendment)
    amendment.status = AmendmentStatus.DENIED
    amendment.denial_reason = reason
    amendment.decided_at = now
    amendment.decided_by_id = access.staff.id
    _notify_client(access.db, amendment, "Your request to amend your record was reviewed", "denied")


def file_disagreement(db: Session, amendment: AmendmentRequest, statement: str) -> None:
    """The client's statement of disagreement with a denial (once)."""
    if amendment.status != AmendmentStatus.DENIED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "You can disagree only with a request that was denied"
        )
    if amendment.disagreement:
        raise HTTPException(status.HTTP_409_CONFLICT, "You've already filed a statement")
    amendment.disagreement = statement
    notify_handlers(
        db,
        amendment.client,
        kind="amendment_disagreement",
        title=f"{short_name(amendment.client)} disagreed with a denied amendment",
        link=amendment_link(amendment),
    )


def add_rebuttal(access: Access, amendment: AmendmentRequest, rebuttal: str) -> None:
    """The practice's answer to the client's statement of disagreement (once); the client gets
    a copy in their portal."""
    if not amendment.disagreement:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A rebuttal answers the client's statement of disagreement"
        )
    if amendment.rebuttal:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request already has a rebuttal")
    amendment.rebuttal = rebuttal
    _notify_client(access.db, amendment, "Your practice responded to your statement", "rebuttal")


def addendum_ids(db: Session, amendment_ids: list[int]) -> dict[int, int]:
    """The addendum each accepted request added, by request id."""
    if not amendment_ids:
        return {}
    rows = db.execute(
        select(NoteAddendum.amendment_request_id, NoteAddendum.id).where(
            NoteAddendum.amendment_request_id.in_(amendment_ids)
        )
    )
    return {request_id: addendum_id for request_id, addendum_id in rows if request_id is not None}


def nudge_amendment_deadlines(db: Session, now: datetime) -> int:
    """Remind handlers of open amendment requests nearing (or past) their 60-day deadline.
    Returns how many reminders went out; the caller commits."""
    sent = 0
    open_requests = db.scalars(
        select(AmendmentRequest)
        .where(AmendmentRequest.status == AmendmentStatus.OPEN)
        .order_by(AmendmentRequest.id)
        .with_for_update(skip_locked=True, of=AmendmentRequest)
    ).all()
    for amendment in open_requests:
        client = amendment.client
        if send_deadline_nudge(
            db,
            client,
            kind_prefix="amendment_request",
            label="An amendment request",
            link=amendment_link(amendment),
            due_on=amendment.due_on,
            today=practice_today(client.practice, now),
        ):
            sent += 1
    return sent
