"""Right of access: clients ask for a copy of their record in the portal (or staff enter a
request on their behalf) and the practice responds within 30 days (one 30-day extension).

Staff need clinical access to the client for every step. Portal routes only ever see the
signed-in client's own requests.
"""

from datetime import UTC, date, datetime, time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, CurrentPortalActor, DbSession
from synari.models import Client, RecordRequest, StoredFile
from synari.models.enums import RecordRequestStatus
from synari.ratelimit import rate_limit
from synari.schemas.appointments import ClientRef
from synari.schemas.notes import StaffRef
from synari.schemas.records import (
    DenyRequest,
    ExtensionRequest,
    FulfillRequest,
    PackageRequest,
    PortalRecordRequestCreate,
    PortalRecordRequestOut,
    RecordRequestCreate,
    RecordRequestOut,
)
from synari.services.record_requests import (
    build_release,
    create_record_request,
    deny_record_request,
    extend_record_request,
    fulfill_record_request,
    notify_new_record_request,
    release_available,
)
from synari.services.request_deadlines import days_until, practice_today
from synari.services.scheduling import zone_of
from synari.services.storage import file_response

router = APIRouter(tags=["record requests"])

_portal_limit = rate_limit("records_request", limit=10, window_seconds=3600)


def record_request_out(record_request: RecordRequest, now: datetime) -> RecordRequestOut:
    """A request with its deadline counted on the practice's calendar."""
    client = record_request.client
    left = days_until(record_request.due_on, practice_today(client.practice, now))
    fulfilled_by = record_request.fulfilled_by
    return RecordRequestOut(
        id=record_request.id,
        client=ClientRef.model_validate(client),
        requested_by=record_request.requested_by,
        requested_by_contact_id=record_request.requested_by_contact_id,
        received_at=record_request.received_at,
        due_on=record_request.due_on,
        days_left=left,
        overdue=record_request.status == RecordRequestStatus.OPEN and left < 0,
        extended_on=record_request.extended_on,
        extension_reason=record_request.extension_reason,
        scope=record_request.scope,
        delivery=record_request.delivery,
        recipient=record_request.recipient,
        status=record_request.status,
        fulfilled_at=record_request.fulfilled_at,
        fulfilled_by=StaffRef.model_validate(fulfilled_by) if fulfilled_by is not None else None,
        release_expires_at=record_request.release_expires_at,
        release_available=release_available(record_request, now),
        denial_reason=record_request.denial_reason,
        created_at=record_request.created_at,
    )


def portal_record_request_out(
    record_request: RecordRequest, now: datetime
) -> PortalRecordRequestOut:
    """A request as the client sees it."""
    return PortalRecordRequestOut(
        id=record_request.id,
        received_at=record_request.received_at,
        due_on=record_request.due_on,
        extended_on=record_request.extended_on,
        extension_reason=record_request.extension_reason,
        scope=record_request.scope,
        delivery=record_request.delivery,
        recipient=record_request.recipient,
        status=record_request.status,
        fulfilled_at=record_request.fulfilled_at,
        denial_reason=record_request.denial_reason,
        release_available=release_available(record_request, now),
        release_expires_at=record_request.release_expires_at,
    )


def _staff_request(access: Access, request_id: int) -> RecordRequest:
    return access.client_record(
        RecordRequest, request_id, ClientAccess.CLINICAL, label="Record request"
    )


def _received_at(client: Client, received_on: date | None, now: datetime) -> datetime:
    """When a staff-entered request arrived: now, or midday on an earlier day (practice zone)."""
    today = practice_today(client.practice, now)
    if received_on is None or received_on == today:
        return now
    if received_on > today:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "The request can't arrive in the future"
        )
    return datetime.combine(received_on, time(12), zone_of(client.practice)).astimezone(UTC)


def _audit(
    db: Session,
    request: Request,
    access: Access,
    action: str,
    record_request: RecordRequest,
    **detail: object,
) -> None:
    audit_staff(
        db,
        request,
        access.staff,
        action,
        "record_request",
        record_request.id,
        dict(detail) or None,
        client_id=record_request.client_id,
    )


@router.get("/record-requests", response_model=list[RecordRequestOut])
def list_record_requests(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    status_filter: RecordRequestStatus | None = Query(default=None, alias="status"),
    client_id: int | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[RecordRequestOut]:
    """Requests for clients this person can see clinically: open ones first by due date, then
    the rest newest first."""
    is_open = RecordRequest.status == RecordRequestStatus.OPEN
    query = (
        select(RecordRequest)
        .join(Client, Client.id == RecordRequest.client_id)
        .where(
            RecordRequest.practice_id == access.practice_id,
            access.client_filter(ClientAccess.CLINICAL),
        )
    )
    if status_filter is not None:
        query = query.where(RecordRequest.status == status_filter)
    if client_id is not None:
        query = query.where(RecordRequest.client_id == client_id)
    rows = list(
        db.scalars(
            query.order_by(
                case((is_open, 0), else_=1),
                case((is_open, RecordRequest.due_on)),
                RecordRequest.received_at.desc(),
                RecordRequest.id.desc(),
            ).limit(limit)
        )
    )
    audit_staff_list(db, request, access.staff, "record_request.list", [r.client_id for r in rows])
    db.commit()
    now = utcnow()
    return [record_request_out(row, now) for row in rows]


@router.post(
    "/clients/{client_id}/record-requests",
    response_model=RecordRequestOut,
    status_code=status.HTTP_201_CREATED,
)
def create_staff_record_request(
    client_id: int,
    body: RecordRequestCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> RecordRequestOut:
    """Enter a request the client made outside the portal (by letter, say)."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    now = utcnow()
    record_request = create_record_request(
        db,
        client,
        requested_by="staff",
        scope=body.scope,
        delivery=body.delivery,
        recipient=body.recipient,
        received_at=_received_at(client, body.received_at, now),
    )
    _audit(db, request, access, "record_request.create", record_request, delivery=body.delivery)
    db.commit()
    return record_request_out(record_request, now)


@router.get("/record-requests/{request_id}", response_model=RecordRequestOut)
def get_record_request(
    request_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> RecordRequestOut:
    record_request = _staff_request(access, request_id)
    _audit(db, request, access, "record_request.view", record_request)
    db.commit()
    return record_request_out(record_request, utcnow())


@router.post("/record-requests/{request_id}/extend", response_model=RecordRequestOut)
def extend_request(
    request_id: int,
    body: ExtensionRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> RecordRequestOut:
    """Take the one 30-day extension, with the reason the client will see."""
    record_request = _staff_request(access, request_id)
    now = utcnow()
    extend_record_request(db, record_request, body.reason, now)
    _audit(db, request, access, "record_request.extend", record_request)
    db.commit()
    return record_request_out(record_request, now)


@router.post("/record-requests/{request_id}/package")
def download_package(
    request_id: int,
    body: PackageRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> Response:
    """The copy that would be released, for the practice to send to a third party itself."""
    record_request = _staff_request(access, request_id)
    if record_request.status == RecordRequestStatus.DENIED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request was denied")
    content = build_release(access, record_request, body.include_billing)
    _audit(db, request, access, "record_request.package_download", record_request)
    db.commit()
    filename = f"record-{record_request.client_id}-{utcnow():%Y%m%d}.zip"
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/record-requests/{request_id}/fulfill", response_model=RecordRequestOut)
def fulfill_request(
    request_id: int,
    body: FulfillRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> RecordRequestOut:
    """Release the copy in the client's portal, or record that it went to the third party."""
    record_request = _staff_request(access, request_id)
    now = utcnow()
    disclosure = fulfill_record_request(
        access, record_request, include_billing=body.include_billing, note=body.note, now=now
    )
    detail: dict[str, object] = {"delivery": record_request.delivery}
    if record_request.file_id is not None:
        detail["file_id"] = record_request.file_id
    if disclosure is not None:
        detail["disclosure_id"] = disclosure.id
    _audit(db, request, access, "record_request.fulfill", record_request, **detail)
    db.commit()
    return record_request_out(record_request, now)


@router.post("/record-requests/{request_id}/deny", response_model=RecordRequestOut)
def deny_request(
    request_id: int,
    body: DenyRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> RecordRequestOut:
    """Deny the request with the reason the client will see."""
    record_request = _staff_request(access, request_id)
    deny_record_request(db, record_request, body.reason)
    _audit(db, request, access, "record_request.deny", record_request)
    db.commit()
    return record_request_out(record_request, utcnow())


# Client portal


@router.post(
    "/portal/record-requests",
    response_model=PortalRecordRequestOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_portal_limit)],
)
def portal_create_record_request(
    body: PortalRecordRequestCreate, actor: CurrentPortalActor, db: DbSession, request: Request
) -> PortalRecordRequestOut:
    """Ask for a copy of your record, in the portal or sent to someone you name."""
    client = actor.client
    now = utcnow()
    record_request = create_record_request(
        db,
        client,
        requested_by="client" if actor.contact is None else "contact",
        contact=actor.contact,
        scope=body.scope,
        delivery=body.delivery,
        recipient=body.recipient,
        received_at=now,
    )
    notify_new_record_request(db, client, record_request)
    audit_client(
        db,
        request,
        client,
        "record_request.create",
        "record_request",
        record_request.id,
        {"delivery": body.delivery},
    )
    db.commit()
    return portal_record_request_out(record_request, now)


@router.get("/portal/record-requests", response_model=list[PortalRecordRequestOut])
def portal_list_record_requests(
    client: CurrentClient, db: DbSession
) -> list[PortalRecordRequestOut]:
    """Your requests, newest first."""
    rows = db.scalars(
        select(RecordRequest)
        .where(RecordRequest.client_id == client.id)
        .order_by(RecordRequest.received_at.desc(), RecordRequest.id.desc())
    )
    now = utcnow()
    return [portal_record_request_out(row, now) for row in rows]


@router.get("/portal/record-requests/{request_id}/download")
def portal_download_release(
    request_id: int, client: CurrentClient, db: DbSession, request: Request
) -> Response:
    """Download the released copy of your record while it's available."""
    record_request = db.get(RecordRequest, request_id)
    if (
        record_request is None
        or record_request.client_id != client.id
        or not release_available(record_request, utcnow())
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Download not available")
    stored = db.get(StoredFile, record_request.file_id)
    if stored is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Download not available")
    audit_client(
        db, request, client, "record_request.release_download", "record_request", record_request.id
    )
    db.commit()
    return file_response(stored)
