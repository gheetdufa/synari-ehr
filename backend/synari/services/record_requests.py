"""Right of access (HIPAA 164.524): requests for a copy of a client's record.

A request is due 30 days after it arrives, with at most one 30-day extension (the client is
told why). Fulfilling it either shares the copy in the client's portal for 30 days or records
that the practice sent it to the third party the client named (which is also logged as a
disclosure). Psychotherapy notes are never part of the copy (services/client_export.py).
"""

from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import Client, ClientContact, Disclosure, RecordRequest, StoredFile
from synari.models.enums import (
    DisclosureSource,
    FilePurpose,
    RecordDelivery,
    RecordRequestStatus,
    Role,
)
from synari.services.amendments import nudge_amendment_deadlines
from synari.services.client_export import build_client_export
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_portal_email
from synari.services.request_deadlines import (
    CLIENT_RECORDS_PATH,
    due_date,
    format_day,
    notify_handlers,
    practice_today,
    send_deadline_nudge,
)
from synari.services.storage import get_storage, store_generated_file

RESPONSE_DAYS = 30
EXTENSION_DAYS = 30
# How long a released copy stays downloadable in the client's portal.
RELEASE_DAYS = 30
THIRD_PARTY_LEGAL_BASIS = "client's request (right of access)"
THIRD_PARTY_PURPOSE = "Copy of record sent at the client's request"


def request_link(record_request: RecordRequest) -> str:
    """Where a record request opens in the staff app."""
    return f"/portal/records?request={record_request.id}"


def create_record_request(
    db: Session,
    client: Client,
    *,
    requested_by: str,
    scope: str,
    delivery: RecordDelivery,
    recipient: str,
    received_at: datetime,
    contact: ClientContact | None = None,
) -> RecordRequest:
    """Record a request for a copy of the record, due 30 days after it arrived (the caller
    commits)."""
    record_request = RecordRequest(
        practice_id=client.practice_id,
        client_id=client.id,
        requested_by=requested_by,
        requested_by_contact_id=contact.id if contact is not None else None,
        received_at=received_at,
        due_on=due_date(client.practice, received_at, RESPONSE_DAYS),
        scope=scope,
        delivery=delivery,
        recipient=recipient,
    )
    db.add(record_request)
    db.flush()
    return record_request


def notify_new_record_request(db: Session, client: Client, record_request: RecordRequest) -> None:
    """Tell the handlers a client asked for a copy of their record."""
    notify_handlers(
        db,
        client,
        kind="record_request",
        title=f"{short_name(client)} asked for a copy of their record",
        body=f"Due by {format_day(record_request.due_on)}.",
        link=request_link(record_request),
        email_subject="New request for a copy of a record",
    )


def release_available(record_request: RecordRequest, now: datetime) -> bool:
    """Whether the client can still download the released copy in their portal."""
    return (
        record_request.file_id is not None
        and record_request.release_expires_at is not None
        and record_request.release_expires_at > now
    )


def require_open(record_request: RecordRequest) -> None:
    """409 unless the request is still waiting for a response."""
    if record_request.status != RecordRequestStatus.OPEN:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request has already been closed")


def _notify_client(db: Session, record_request: RecordRequest, title: str, event: str) -> None:
    """Tell the client (in the app and by content-free email) there's news on their request."""
    client = record_request.client
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="record_request_update",
        title=title,
        link=CLIENT_RECORDS_PATH,
    )
    queue_portal_email(
        db,
        client,
        subject=f"An update on your records request from {client.practice.name}",
        heading=title,
        paragraphs=["Sign in to your client portal to see the details."],
        button_label="Open your portal",
        next_path=CLIENT_RECORDS_PATH,
        dedupe_key=f"record-request-{record_request.id}-{event}",
    )


def extend_record_request(
    db: Session, record_request: RecordRequest, reason: str, now: datetime
) -> None:
    """Take the one 30-day extension the rule allows, telling the client why (the caller
    commits)."""
    require_open(record_request)
    if record_request.extended_on is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request has already been extended")
    record_request.extended_on = practice_today(record_request.client.practice, now)
    record_request.due_on = record_request.due_on + timedelta(days=EXTENSION_DAYS)
    record_request.extension_reason = reason
    _notify_client(db, record_request, "Your records request needs a little more time", "extended")


def build_release(access: Access, record_request: RecordRequest, include_billing: bool) -> bytes:
    """The copy of the record for this request as the person releasing it may see it: billing
    records only with billing access, never psychotherapy notes."""
    client = record_request.client
    billing = include_billing and access.can_access_client(client, ClientAccess.BILLING)
    return build_client_export(access, client, include_billing=billing)


def fulfill_record_request(
    access: Access,
    record_request: RecordRequest,
    *,
    include_billing: bool,
    note: str,
    now: datetime,
) -> Disclosure | None:
    """Release the copy: in the client's portal for 30 days, or record that it was sent to the
    third party (logged as a disclosure, which is returned). The caller commits."""
    require_open(record_request)
    db = access.db
    client = record_request.client
    disclosure = None
    if record_request.delivery == RecordDelivery.PORTAL:
        if not client.can_use_portal:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This client can't sign in to the portal; turn on portal access first",
            )
        data = build_release(access, record_request, include_billing)
        stored = store_generated_file(
            db,
            data,
            practice_id=client.practice_id,
            client_id=client.id,
            purpose=FilePurpose.RECORD_RELEASE,
            filename=f"record-{practice_today(client.practice, now):%Y%m%d}.zip",
            content_type="application/zip",
            uploaded_by=Role.STAFF,
            uploaded_by_staff_id=access.staff.id,
            shared_with_client=True,
        )
        record_request.file_id = stored.id
        record_request.release_expires_at = now + timedelta(days=RELEASE_DAYS)
    else:
        description = record_request.scope
        if note:
            description = f"{description}\n\nSent: {note}"
        disclosure = Disclosure(
            practice_id=client.practice_id,
            client_id=client.id,
            disclosed_on=practice_today(client.practice, now),
            recipient_name=record_request.recipient,
            description=description,
            purpose=THIRD_PARTY_PURPOSE,
            legal_basis=THIRD_PARTY_LEGAL_BASIS,
            record_request_id=record_request.id,
            source=DisclosureSource.RECORD_REQUEST,
            recorded_by_id=access.staff.id,
        )
        db.add(disclosure)
    record_request.status = RecordRequestStatus.FULFILLED
    record_request.fulfilled_at = now
    record_request.fulfilled_by_id = access.staff.id
    db.flush()
    title = (
        "A copy of your record is ready to download"
        if record_request.delivery == RecordDelivery.PORTAL
        else "Your practice sent a copy of your record"
    )
    _notify_client(db, record_request, title, "fulfilled")
    return disclosure


def deny_record_request(db: Session, record_request: RecordRequest, reason: str) -> None:
    """Deny the request with the reason the client will see (the caller commits)."""
    require_open(record_request)
    record_request.status = RecordRequestStatus.DENIED
    record_request.denial_reason = reason
    _notify_client(db, record_request, "Your records request was reviewed", "denied")


def purge_expired_releases(db: Session, now: datetime) -> int:
    """Delete released copies whose download window has passed (the request keeps its
    history). Returns how many were removed; the caller commits."""
    expired = db.scalars(
        select(RecordRequest)
        .where(
            RecordRequest.file_id.is_not(None),
            RecordRequest.release_expires_at <= now,
        )
        .order_by(RecordRequest.id)
        .with_for_update(skip_locked=True, of=RecordRequest)
    ).all()
    for record_request in expired:
        stored = db.get(StoredFile, record_request.file_id)
        record_request.file_id = None
        if stored is None:
            continue
        # Bytes first, so a failed commit leaves the row to retry (deleting twice is a no-op).
        get_storage().delete(stored.storage_key)
        db.delete(stored)
    return len(expired)


def run_record_request_deadlines(db: Session, now: datetime) -> None:
    """Worker job: remind handlers of record and amendment requests nearing (10 and 2 days) or
    past their deadlines, and remove expired released copies."""
    open_requests = db.scalars(
        select(RecordRequest)
        .where(RecordRequest.status == RecordRequestStatus.OPEN)
        .order_by(RecordRequest.id)
        .with_for_update(skip_locked=True, of=RecordRequest)
    ).all()
    for record_request in open_requests:
        client = record_request.client
        send_deadline_nudge(
            db,
            client,
            kind_prefix="record_request",
            label="A record request",
            link=request_link(record_request),
            due_on=record_request.due_on,
            today=practice_today(client.practice, now),
        )
    nudge_amendment_deadlines(db, now)
    purge_expired_releases(db, now)
    db.commit()
