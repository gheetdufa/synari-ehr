"""Issuing, replacing and withdrawing good faith estimates.

Issuing snapshots the provider, renders the PDF, keeps it with the client's record (with its
SHA-256, so the copy given to the client can be verified later), shares it in the client's
portal documents and tells the client it's ready without saying what it is. An issued
estimate never changes: a replacement is a new draft that supersedes it once issued, and an
estimate issued in error is voided (and unshared) rather than deleted.
"""

import hashlib
import secrets
from datetime import date, datetime

from sqlalchemy.orm import Session

from synari.models import Client, GoodFaithEstimate, StaffMember, StoredFile
from synari.models.enums import FilePurpose, GoodFaithEstimateStatus, Role
from synari.schemas.estimates import EstimateProvider
from synari.services.billing import local_date
from synari.services.estimate_pdf import EstimateDocument, estimate_pdf
from synari.services.estimates import (
    CLIENT_ESTIMATES_PATH,
    REASON_UPDATE,
    apply_totals,
    draft_input,
    max_period_end,
    missing_client_fields,
    missing_provider_fields,
    new_draft,
    open_draft,
    pair_state,
    provider_snapshot,
    update_due_date,
)
from synari.services.notifications import notify
from synari.services.portal_links import queue_portal_email
from synari.services.scheduling import zone_of
from synari.services.storage import get_storage

PDF_CONTENT_TYPE = "application/pdf"
EMAILED_DELIVERY = ("portal", "email")


def issue_problems(
    estimate: GoodFaithEstimate, client: Client, provider: EstimateProvider, today: date
) -> list[str]:
    """What must be fixed before the estimate can be issued (empty when it's ready); `today`
    is the practice's date."""
    problems = []
    if not estimate.items:
        problems.append("add at least one service")
    if estimate.period_end > max_period_end(estimate.period_start):
        problems.append("shorten the period to 12 months or less")
    if estimate.period_end < today:
        problems.append("choose a period that hasn't already ended")
    problems += [f"add the client's {field}" for field in missing_client_fields(client)]
    problems += [f"add {field}" for field in missing_provider_fields(client.practice, provider)]
    if estimate.supersedes_id is not None and not estimate.change_summary.strip():
        problems.append("describe what changed from the previous estimate")
    return problems


def document_for(
    db: Session, estimate: GoodFaithEstimate, client: Client, now: datetime
) -> EstimateDocument:
    """What the estimate's PDF prints: the provider as issued (or as it would be issued now,
    for a draft preview), the estimate's date and the date of the estimate it replaces."""
    zone = zone_of(client.practice)
    draft = estimate.issued_at is None
    if draft:
        clinician = db.get_one(StaffMember, estimate.clinician_id)
        provider = provider_snapshot(db, client.practice, clinician)
    else:
        provider = EstimateProvider.model_validate(estimate.provider)
    issued_at = estimate.issued_at or now
    replaced = (
        db.get(GoodFaithEstimate, estimate.supersedes_id)
        if estimate.supersedes_id is not None
        else None
    )
    replaces_date = (
        local_date(replaced.issued_at, zone)
        if replaced is not None and replaced.issued_at is not None
        else None
    )
    return EstimateDocument(
        client=client,
        provider=provider,
        estimate_date=local_date(issued_at, zone),
        replaces_date=replaces_date,
        draft=draft,
    )


def _store_pdf(
    db: Session, client: Client, data: bytes, issued_on: date, staff_id: int
) -> StoredFile:
    """Keep the issued PDF with the client's record, shared in their portal."""
    key = (
        f"practices/{client.practice_id}/{FilePurpose.GOOD_FAITH_ESTIMATE}/"
        f"{secrets.token_hex(16)}.pdf"
    )
    get_storage().save(key, data, PDF_CONTENT_TYPE)
    stored = StoredFile(
        practice_id=client.practice_id,
        client_id=client.id,
        purpose=FilePurpose.GOOD_FAITH_ESTIMATE,
        filename=f"Good Faith Estimate {issued_on.isoformat()}.pdf",
        content_type=PDF_CONTENT_TYPE,
        size_bytes=len(data),
        storage_key=key,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=staff_id,
        shared_with_client=True,
    )
    db.add(stored)
    db.flush()
    return stored


def _tell_client(db: Session, client: Client, estimate: GoodFaithEstimate) -> None:
    """A content-free notice that a document is ready in the portal."""
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="estimate_issued",
        title="A new document is ready",
        link=CLIENT_ESTIMATES_PATH,
    )
    if estimate.delivery_method not in EMAILED_DELIVERY:
        return
    practice_name = client.practice.name
    queue_portal_email(
        db,
        client,
        subject=f"New document from {practice_name}",
        heading="A document is ready",
        paragraphs=[f"{practice_name} shared a document in your client portal."],
        button_label="View document",
        next_path=CLIENT_ESTIMATES_PATH,
        dedupe_key=f"estimate-issued:{estimate.id}",
    )


def issue_estimate(
    db: Session,
    estimate: GoodFaithEstimate,
    client: Client,
    staff: StaffMember,
    delivery_method: str,
    now: datetime,
) -> None:
    """Issue a checked draft (see issue_problems): snapshot the provider, store and share the
    PDF, supersede the estimate it replaces and tell the client. The caller commits."""
    clinician = db.get_one(StaffMember, estimate.clinician_id)
    provider = provider_snapshot(db, client.practice, clinician)
    apply_totals(estimate)
    estimate.provider = provider.model_dump(mode="json")
    estimate.status = GoodFaithEstimateStatus.ISSUED
    estimate.issued_at = now
    estimate.issued_by_id = staff.id
    estimate.delivery_method = delivery_method
    document = document_for(db, estimate, client, now)
    data = estimate_pdf(estimate, document)
    stored = _store_pdf(db, client, data, document.estimate_date, staff.id)
    estimate.file_id = stored.id
    estimate.pdf_sha256 = hashlib.sha256(data).hexdigest()
    if estimate.supersedes_id is not None:
        replaced = db.get(GoodFaithEstimate, estimate.supersedes_id)
        if replaced is not None and replaced.status == GoodFaithEstimateStatus.ISSUED:
            replaced.status = GoodFaithEstimateStatus.SUPERSEDED
    _tell_client(db, client, estimate)


def supersede_estimate(
    db: Session, estimate: GoodFaithEstimate, client: Client, change_summary: str, now: datetime
) -> GoodFaithEstimate | None:
    """A draft replacing an issued estimate, copied from it: the existing replacement draft
    if there is one, None if another draft for the pair is in the way. It's due 1 business
    day before the pair's next session. The caller adds and commits."""
    existing = open_draft(db, client.id, estimate.clinician_id)
    if existing is not None:
        if existing.supersedes_id != estimate.id:
            return None
        if change_summary and not existing.change_summary:
            existing.change_summary = change_summary
        return existing
    data = draft_input(estimate)
    data.change_summary = change_summary
    upcoming = [
        session
        for session in pair_state(db, client, estimate.clinician_id, now).sessions
        if session.starts_at >= now
    ]
    data.due_on = update_due_date(upcoming[0].service_on) if upcoming else None
    replacement = new_draft(client, data, reason=REASON_UPDATE, supersedes_id=estimate.id)
    db.add(replacement)
    db.flush()
    return replacement


def void_estimate(db: Session, estimate: GoodFaithEstimate, reason: str, now: datetime) -> bool:
    """Withdraw a draft, or an estimate issued in error (unshared from the portal; the one it
    replaced is current again). Returns whether it had been issued. The caller commits."""
    was_issued = estimate.status == GoodFaithEstimateStatus.ISSUED
    estimate.status = GoodFaithEstimateStatus.VOID
    estimate.voided_at = now
    estimate.void_reason = reason
    if not was_issued:
        return False
    if estimate.file_id is not None:
        stored = db.get(StoredFile, estimate.file_id)
        if stored is not None:
            stored.shared_with_client = False
    if estimate.supersedes_id is not None:
        replaced = db.get(GoodFaithEstimate, estimate.supersedes_id)
        if replaced is not None and replaced.status == GoodFaithEstimateStatus.SUPERSEDED:
            replaced.status = GoodFaithEstimateStatus.ISSUED
    return True
