"""Insurance remittances (835 ERAs) and uploaded clearinghouse response files.

Remittances cover many clients at once, so everything here needs practice-wide billing
access. Remittances arrive from Stedi automatically (see services/claims_jobs.py) or are
uploaded as X12 files; uploads of 999 and 277CA acknowledgments update claim statuses too.
"""

import secrets
from pathlib import PurePosixPath

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import exists, select
from sqlalchemy.orm import selectinload

from synari.access import Access
from synari.audit import MAX_LISTED_CLIENTS, audit_staff
from synari.claims.responses import CLAIM_STATUS_DESCRIPTIONS
from synari.claims.responses import Remittance as ParsedRemittance
from synari.claims.x12_parse import parse_277ca, parse_835, parse_999, tokenize
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import Claim, Remittance, RemittanceClaim, StoredFile
from synari.models.enums import FilePurpose, RemittanceStatus
from synari.pagination import ListPage, paginate
from synari.permissions import Capability
from synari.schemas.claims import (
    RemittanceClaimOut,
    RemittanceDetailOut,
    RemittanceOut,
    RemittancePost,
    ResponseFileResult,
)
from synari.services.claims import claims_changed
from synari.services.claims_document import stored_payment
from synari.services.claims_responses import (
    apply_acknowledgment,
    apply_file_acknowledgment,
    find_claim,
    import_remittance,
    is_postable,
    line_postings,
    post_remittance,
    remittances_changed,
)
from synari.services.storage import file_response, get_storage

router = APIRouter(prefix="/remittances", tags=["remittances"])

UPLOAD_SOURCE = "upload"
X12_CONTENT_TYPE = "text/plain"


def _require_remittances(access: Access) -> None:
    access.require(Capability.BILLING_ALL, "Insurance payments need practice-wide billing access")


def _remittance(access: Access, remittance_id: int) -> Remittance:
    _require_remittances(access)
    return access.get(Remittance, remittance_id, label="Remittance")


def remittance_view(remittance: Remittance) -> RemittanceOut:
    """A remittance with how many claims it covers and how many didn't match ours."""
    view = RemittanceOut.model_validate(remittance)
    view.claim_count = len(remittance.claims)
    view.unmatched_count = sum(1 for claim in remittance.claims if claim.claim_id is None)
    return view


def _claim_view(access: Access, remittance_claim: RemittanceClaim) -> RemittanceClaimOut:
    claim = access.db.get(Claim, remittance_claim.claim_id) if remittance_claim.claim_id else None
    detail = remittance_claim.detail or {}
    return RemittanceClaimOut(
        id=remittance_claim.id,
        claim_id=remittance_claim.claim_id,
        client_id=claim.client_id if claim else None,
        client_name=claim.client.full_name if claim else "",
        patient_control_number=remittance_claim.patient_control_number,
        status_code=remittance_claim.status_code,
        status_description=CLAIM_STATUS_DESCRIPTIONS.get(remittance_claim.status_code, ""),
        charge_cents=remittance_claim.charge_cents,
        paid_cents=remittance_claim.paid_cents,
        patient_responsibility_cents=remittance_claim.patient_responsibility_cents,
        payer_claim_number=remittance_claim.payer_claim_number,
        adjustments=detail.get("adjustments", []),
        lines=detail.get("lines", []),
        posted_at=remittance_claim.posted_at,
    )


def _audit_remittance(
    access: Access, request: Request, action: str, remittance: Remittance
) -> None:
    """Audit access to a remittance, naming the clients whose claim payments it holds (the
    event's client_id when there's just one)."""
    claim_ids = [claim.claim_id for claim in remittance.claims if claim.claim_id is not None]
    client_ids = (
        sorted(set(access.db.scalars(select(Claim.client_id).where(Claim.id.in_(claim_ids)))))
        if claim_ids
        else []
    )
    audit_staff(
        access.db,
        request,
        access.staff,
        action,
        "remittance",
        remittance.id,
        {"client_ids": client_ids[:MAX_LISTED_CLIENTS], "client_count": len(client_ids)},
        client_id=client_ids[0] if len(client_ids) == 1 else None,
    )


def remittance_detail(access: Access, remittance: Remittance) -> RemittanceDetailOut:
    """A remittance with each claim payment, its adjustments and service lines."""
    return RemittanceDetailOut(
        **remittance_view(remittance).model_dump(),
        claims=[_claim_view(access, claim) for claim in remittance.claims],
    )


def _read_x12(upload: UploadFile) -> tuple[str, bytes]:
    data = upload.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes // (1024 * 1024)
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"Files must be under {limit_mb} MB")
    text = data.decode("utf-8", errors="replace")
    if not text.lstrip().startswith("ISA"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "That isn't an X12 file. Upload the 835, 277CA or 999 file from your clearinghouse.",
        )
    return text, data


def _store_x12(access: Access, filename: str, data: bytes) -> StoredFile:
    """Keep the uploaded file with the practice's records (no client: it covers many)."""
    name = PurePosixPath(filename.replace("\\", "/")).name[:200] or "remittance.txt"
    key = f"practices/{access.practice_id}/{FilePurpose.REMITTANCE}/{secrets.token_hex(16)}.txt"
    get_storage().save(key, data, X12_CONTENT_TYPE)
    stored = StoredFile(
        practice_id=access.practice_id,
        client_id=None,
        purpose=FilePurpose.REMITTANCE,
        filename=name,
        content_type=X12_CONTENT_TYPE,
        size_bytes=len(data),
        storage_key=key,
        uploaded_by="staff",
        uploaded_by_staff_id=access.staff.id,
    )
    access.db.add(stored)
    access.db.flush()
    return stored


def _transaction_set(text: str) -> str:
    try:
        segments = tokenize(text)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return next((segment.get(1) for segment in segments if segment.tag == "ST"), "")


@router.get("", response_model=list[RemittanceOut])
def list_remittances(
    access: CurrentAccess,
    db: DbSession,
    page: ListPage,
    response: Response,
    status_filter: RemittanceStatus | None = Query(default=None, alias="status"),
) -> list[RemittanceOut]:
    """A page of the practice's remittances, newest first."""
    _require_remittances(access)
    query = select(Remittance).where(Remittance.practice_id == access.practice_id)
    if status_filter is not None:
        query = query.where(Remittance.status == status_filter)
    ordered = query.options(selectinload(Remittance.claims)).order_by(
        Remittance.created_at.desc(), Remittance.id.desc()
    )
    remittances = db.scalars(paginate(db, ordered, page, response)).all()
    return [remittance_view(remittance) for remittance in remittances]


def _import_remittances(
    access: Access, parsed: list[ParsedRemittance], file_id: int
) -> tuple[list[Remittance], list[Claim]]:
    """Store and (when possible) post each new remittance in an 835 file."""
    db = access.db
    remittances: list[Remittance] = []
    posted: list[Claim] = []
    for remittance in parsed:
        duplicate = db.scalar(
            select(
                exists().where(
                    Remittance.practice_id == access.practice_id,
                    Remittance.trace_number == remittance.trace_number,
                    Remittance.total_paid_cents == remittance.payment_cents,
                    Remittance.payer_name == remittance.payer_name,
                )
            )
        )
        if duplicate:
            continue
        row, claims = import_remittance(
            db,
            access.practice_id,
            remittance,
            source=UPLOAD_SOURCE,
            now=utcnow(),
            file_id=file_id,
        )
        remittances.append(row)
        posted += claims
    if parsed and not remittances:
        raise HTTPException(status.HTTP_409_CONFLICT, "This remittance was already imported")
    return remittances, posted


@router.post("/upload", response_model=ResponseFileResult, status_code=status.HTTP_201_CREATED)
def upload_response_file(
    file: UploadFile, access: CurrentAccess, db: DbSession, request: Request
) -> ResponseFileResult:
    """Import a clearinghouse file: an 835 remittance (stored and posted when it balances and
    matches), a 277CA claim acknowledgment or a 999 file acknowledgment."""
    _require_remittances(access)
    text, data = _read_x12(file)
    kind = _transaction_set(text)
    if kind not in ("835", "277", "999"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Only 835, 277CA and 999 files can be imported here.",
        )
    try:
        remittance_files = parse_835(text) if kind == "835" else []
        acknowledgments = parse_277ca(text) if kind == "277" else []
        file_acknowledgments = parse_999(text) if kind == "999" else []
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"The file couldn't be read: {exc}"
        ) from exc

    stored = _store_x12(access, file.filename or "", data)
    remittances, changed = _import_remittances(access, remittance_files, stored.id)
    for acknowledgment in acknowledgments:
        claim = find_claim(db, acknowledgment.patient_control_number, access.practice_id)
        if claim is not None:
            apply_acknowledgment(db, claim, acknowledgment)
            changed.append(claim)
    for file_acknowledgment in file_acknowledgments:
        changed += apply_file_acknowledgment(db, access.practice_id, file_acknowledgment)
    claim_ids = sorted({claim.id for claim in changed})
    message = (
        f"Imported {len(remittances)} remittance(s)"
        if kind == "835"
        else f"Updated {len(claim_ids)} claim(s)"
    )
    audit_staff(
        db,
        request,
        access.staff,
        "remittance.upload",
        "stored_file",
        stored.id,
        {"kind": kind, "remittance_ids": [r.id for r in remittances]},
    )
    claims_changed(db, changed)
    db.commit()
    return ResponseFileResult(
        kind=kind,
        remittances=[remittance_view(remittance) for remittance in remittances],
        claim_ids=claim_ids,
        message=message,
    )


@router.get("/{remittance_id}", response_model=RemittanceDetailOut)
def get_remittance(
    remittance_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> RemittanceDetailOut:
    """A remittance with its claim payments."""
    remittance = _remittance(access, remittance_id)
    detail = remittance_detail(access, remittance)
    _audit_remittance(access, request, "remittance.view", remittance)
    db.commit()
    return detail


@router.post("/{remittance_id}/post", response_model=RemittanceDetailOut)
def post_after_review(
    remittance_id: int,
    body: RemittancePost,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> RemittanceDetailOut:
    """Post a remittance that needed review, after matching unmatched claims by hand.

    Payments still unmatched stay unposted for the record; the remittance is marked posted.
    """
    remittance = _remittance(access, remittance_id)
    db.refresh(remittance, with_for_update=True)
    if remittance.status == RemittanceStatus.POSTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This remittance is already posted")
    by_id = {claim.id: claim for claim in remittance.claims}
    for assignment in body.assignments:
        remittance_claim = by_id.get(assignment.remittance_claim_id)
        if remittance_claim is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Remittance claim not found")
        if remittance_claim.posted_at is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "That payment is already posted")
        remittance_claim.claim_id = access.get(Claim, assignment.claim_id, label="Claim").id
    for remittance_claim in remittance.claims:
        if not is_postable(remittance_claim):
            continue
        claim = db.get_one(Claim, remittance_claim.claim_id)
        if line_postings(claim, stored_payment(remittance_claim)) is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"The service lines paid for {remittance_claim.patient_control_number} don't "
                f"match claim {claim.patient_control_number}",
            )
    posted = post_remittance(db, remittance, utcnow())
    _audit_remittance(access, request, "remittance.post", remittance)
    remittances_changed(db, remittance)
    claims_changed(db, posted)
    db.commit()
    return remittance_detail(access, remittance)


@router.get("/{remittance_id}/file")
def download_remittance_file(
    remittance_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    """The X12 file the remittance was imported from, when it was uploaded."""
    remittance = _remittance(access, remittance_id)
    stored = access.db.get(StoredFile, remittance.file_id) if remittance.file_id else None
    if stored is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This remittance has no file")
    _audit_remittance(access, request, "remittance.download", remittance)
    db.commit()
    return file_response(stored)
