"""Amendment requests: a client asks (in the portal, or through staff) to correct their record
and the practice accepts (adding an addendum) or denies within 60 days. After a denial the
client may file a statement of disagreement, which staff may answer with a rebuttal.

Staff need clinical access to the client. Portal routes only see the signed-in client's
requests.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, CurrentPortalActor, DbSession
from synari.models import AmendmentRequest, Client
from synari.models.enums import AmendmentStatus
from synari.ratelimit import rate_limit
from synari.schemas.appointments import ClientRef
from synari.schemas.notes import StaffRef
from synari.schemas.records import (
    AmendmentAccept,
    AmendmentCreate,
    AmendmentDeny,
    AmendmentOut,
    DisagreementCreate,
    PortalAmendmentCreate,
    PortalAmendmentOut,
    RebuttalCreate,
)
from synari.services.amendments import (
    accept_amendment,
    add_rebuttal,
    addendum_ids,
    amendable_note,
    create_amendment_request,
    deny_amendment,
    file_disagreement,
    notify_new_amendment_request,
)
from synari.services.note_records import can_read_note
from synari.services.request_deadlines import days_until, practice_today

router = APIRouter(tags=["amendments"])

_portal_limit = rate_limit("records_request", limit=10, window_seconds=3600)


def amendment_out(
    access: Access, amendment: AmendmentRequest, addendum_id: int | None, now: datetime
) -> AmendmentOut:
    """A request with its deadline counted on the practice's calendar."""
    left = days_until(amendment.due_on, practice_today(amendment.client.practice, now))
    note = amendment.note
    decided_by = amendment.decided_by
    return AmendmentOut(
        id=amendment.id,
        client=ClientRef.model_validate(amendment.client),
        note_id=amendment.note_id,
        note_title=note.title if note is not None and can_read_note(access, note) else "",
        requested_by=amendment.requested_by,
        received_at=amendment.received_at,
        due_on=amendment.due_on,
        days_left=left,
        overdue=amendment.status == AmendmentStatus.OPEN and left < 0,
        request=amendment.request,
        status=amendment.status,
        decided_at=amendment.decided_at,
        decided_by=StaffRef.model_validate(decided_by) if decided_by is not None else None,
        denial_reason=amendment.denial_reason,
        disagreement=amendment.disagreement,
        rebuttal=amendment.rebuttal,
        addendum_id=addendum_id,
        created_at=amendment.created_at,
    )


def portal_amendment_out(amendment: AmendmentRequest) -> PortalAmendmentOut:
    """A request as the client sees it."""
    return PortalAmendmentOut(
        id=amendment.id,
        received_at=amendment.received_at,
        due_on=amendment.due_on,
        request=amendment.request,
        status=amendment.status,
        decided_at=amendment.decided_at,
        denial_reason=amendment.denial_reason,
        disagreement=amendment.disagreement,
        rebuttal=amendment.rebuttal,
        can_disagree=amendment.status == AmendmentStatus.DENIED and not amendment.disagreement,
    )


def _staff_amendment(access: Access, amendment_id: int) -> AmendmentRequest:
    return access.client_record(
        AmendmentRequest, amendment_id, ClientAccess.CLINICAL, label="Amendment request"
    )


def _single_out(access: Access, amendment: AmendmentRequest) -> AmendmentOut:
    addendum_id = addendum_ids(access.db, [amendment.id]).get(amendment.id)
    return amendment_out(access, amendment, addendum_id, utcnow())


def _audit(
    db: Session,
    request: Request,
    access: Access,
    action: str,
    amendment: AmendmentRequest,
    detail: dict[str, object] | None = None,
) -> None:
    audit_staff(
        db,
        request,
        access.staff,
        action,
        "amendment_request",
        amendment.id,
        detail,
        client_id=amendment.client_id,
    )


@router.get("/amendment-requests", response_model=list[AmendmentOut])
def list_amendment_requests(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    status_filter: AmendmentStatus | None = Query(default=None, alias="status"),
    client_id: int | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[AmendmentOut]:
    """Requests for clients this person can see clinically: open ones first by due date, then
    the rest newest first."""
    is_open = AmendmentRequest.status == AmendmentStatus.OPEN
    query = (
        select(AmendmentRequest)
        .join(Client, Client.id == AmendmentRequest.client_id)
        .where(
            AmendmentRequest.practice_id == access.practice_id,
            access.client_filter(ClientAccess.CLINICAL),
        )
    )
    if status_filter is not None:
        query = query.where(AmendmentRequest.status == status_filter)
    if client_id is not None:
        query = query.where(AmendmentRequest.client_id == client_id)
    rows = list(
        db.scalars(
            query.order_by(
                case((is_open, 0), else_=1),
                case((is_open, AmendmentRequest.due_on)),
                AmendmentRequest.received_at.desc(),
                AmendmentRequest.id.desc(),
            ).limit(limit)
        )
    )
    audit_staff_list(db, request, access.staff, "amendment.list", [r.client_id for r in rows])
    db.commit()
    addenda = addendum_ids(db, [row.id for row in rows])
    now = utcnow()
    return [amendment_out(access, row, addenda.get(row.id), now) for row in rows]


@router.post(
    "/clients/{client_id}/amendment-requests",
    response_model=AmendmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_staff_amendment_request(
    client_id: int,
    body: AmendmentCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AmendmentOut:
    """Enter an amendment request the client made outside the portal."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    note = amendable_note(access, client, body.note_id) if body.note_id is not None else None
    amendment = create_amendment_request(
        db, client, requested_by="staff", request=body.request, now=utcnow(), note=note
    )
    _audit(db, request, access, "amendment.create", amendment)
    db.commit()
    return _single_out(access, amendment)


@router.get("/amendment-requests/{amendment_id}", response_model=AmendmentOut)
def get_amendment_request(
    amendment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> AmendmentOut:
    amendment = _staff_amendment(access, amendment_id)
    _audit(db, request, access, "amendment.view", amendment)
    db.commit()
    return _single_out(access, amendment)


@router.post("/amendment-requests/{amendment_id}/accept", response_model=AmendmentOut)
def accept_amendment_request(
    amendment_id: int,
    body: AmendmentAccept,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AmendmentOut:
    """Accept: add the correction as an addendum to the note and tell the client."""
    amendment = _staff_amendment(access, amendment_id)
    addendum = accept_amendment(access, amendment, body.content, body.note_id, utcnow())
    _audit(
        db,
        request,
        access,
        "amendment.accept",
        amendment,
        {"note_id": addendum.note_id, "addendum_id": addendum.id},
    )
    db.commit()
    return _single_out(access, amendment)


@router.post("/amendment-requests/{amendment_id}/deny", response_model=AmendmentOut)
def deny_amendment_request(
    amendment_id: int,
    body: AmendmentDeny,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AmendmentOut:
    """Deny with the reason the client will see; they may file a statement of disagreement."""
    amendment = _staff_amendment(access, amendment_id)
    deny_amendment(access, amendment, body.reason, utcnow())
    _audit(db, request, access, "amendment.deny", amendment)
    db.commit()
    return _single_out(access, amendment)


@router.post("/amendment-requests/{amendment_id}/rebuttal", response_model=AmendmentOut)
def add_amendment_rebuttal(
    amendment_id: int,
    body: RebuttalCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AmendmentOut:
    """Answer the client's statement of disagreement (the client gets a copy)."""
    amendment = _staff_amendment(access, amendment_id)
    add_rebuttal(access, amendment, body.rebuttal)
    _audit(db, request, access, "amendment.rebuttal", amendment)
    db.commit()
    return _single_out(access, amendment)


# Client portal


def _portal_amendment(db: Session, client: Client, amendment_id: int) -> AmendmentRequest:
    amendment = db.get(AmendmentRequest, amendment_id)
    if amendment is None or amendment.client_id != client.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found")
    return amendment


@router.post(
    "/portal/amendment-requests",
    response_model=PortalAmendmentOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_portal_limit)],
)
def portal_create_amendment_request(
    body: PortalAmendmentCreate, actor: CurrentPortalActor, db: DbSession, request: Request
) -> PortalAmendmentOut:
    """Ask the practice to correct something in your record."""
    client = actor.client
    amendment = create_amendment_request(
        db,
        client,
        requested_by="client" if actor.contact is None else "contact",
        request=body.request,
        now=utcnow(),
    )
    notify_new_amendment_request(db, client, amendment)
    audit_client(db, request, client, "amendment.create", "amendment_request", amendment.id)
    db.commit()
    return portal_amendment_out(amendment)


@router.get("/portal/amendment-requests", response_model=list[PortalAmendmentOut])
def portal_list_amendment_requests(
    client: CurrentClient, db: DbSession
) -> list[PortalAmendmentOut]:
    """Your amendment requests, newest first."""
    rows = db.scalars(
        select(AmendmentRequest)
        .where(AmendmentRequest.client_id == client.id)
        .order_by(AmendmentRequest.received_at.desc(), AmendmentRequest.id.desc())
    )
    return [portal_amendment_out(row) for row in rows]


@router.post(
    "/portal/amendment-requests/{amendment_id}/disagreement",
    response_model=PortalAmendmentOut,
    dependencies=[Depends(_portal_limit)],
)
def portal_file_disagreement(
    amendment_id: int,
    body: DisagreementCreate,
    client: CurrentClient,
    db: DbSession,
    request: Request,
) -> PortalAmendmentOut:
    """Disagree with a denied request; your statement is kept with your record."""
    amendment = _portal_amendment(db, client, amendment_id)
    file_disagreement(db, amendment, body.statement)
    audit_client(db, request, client, "amendment.disagreement", "amendment_request", amendment.id)
    db.commit()
    return portal_amendment_out(amendment)
