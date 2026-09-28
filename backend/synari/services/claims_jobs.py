"""Worker jobs for electronic claims through Stedi: send queued claims, collect responses.

Both jobs do nothing unless a Stedi API key is configured. One Stedi account serves the whole
server, so responses are matched to claims by patient control number, which is unique across
practices.
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from synari.claims.stedi import ClearinghouseError, StediClient
from synari.config import settings
from synari.models import Claim, ClaimEvent, Remittance
from synari.models.enums import ClaimStatus, ClaimSubmissionMethod
from synari.services import claims_stedi
from synari.services.claims import claims_changed, mark_submitted, reject
from synari.services.claims_document import claim_document, claim_issues, document_snapshot
from synari.services.claims_responses import (
    apply_acknowledgment,
    find_claim,
    import_remittance,
    remittance_practice,
)

logger = logging.getLogger(__name__)

SUBMIT_BATCH = 50
# How far back each poll looks. Reports already handled are skipped by transaction id.
POLL_WINDOW = timedelta(days=7)
STEDI_SOURCE = "stedi"
_ACKNOWLEDGMENT_EVENTS = ("accepted", "rejected")


class _TryLater(Exception):
    """Stedi couldn't be reached or was busy; the claim stays queued."""


def _is_temporary(error: ClearinghouseError) -> bool:
    """Network trouble, rate limits, Stedi outages and a bad API key aren't the claim's fault."""
    code = error.status_code
    return code is None or code in (401, 403, 429) or code >= 500


def _submit(db: Session, stedi: StediClient, claim: Claim) -> None:
    """Send one queued claim and record the outcome."""
    document = claim_document(db, claim)
    issues = claim_issues(db, claim, ClaimSubmissionMethod.STEDI, document)
    if issues:
        reject(db, claim, " ".join(issue.message for issue in issues))
        return
    try:
        result = stedi.submit_claim(document, settings.stedi_usage)
    except ClearinghouseError as exc:
        if _is_temporary(exc):
            claim.last_error = str(exc)
            raise _TryLater from exc
        reject(db, claim, str(exc))
        return
    if result.accepted:
        mark_submitted(
            claim,
            ClaimSubmissionMethod.STEDI,
            document,
            message="Sent to the clearinghouse",
            reference=result.correlation_id,
        )
        return
    claim.snapshot = document_snapshot(document)
    reject(
        db,
        claim,
        "; ".join(result.errors) or "The clearinghouse rejected the claim",
        data={"errors": list(result.errors)},
    )


def submit_queued_claims(db: Session, now: datetime) -> None:
    """Send queued claims to Stedi one at a time, each in its own transaction."""
    if not settings.stedi_enabled:
        return
    stedi: StediClient | None = None
    try:
        for _ in range(SUBMIT_BATCH):
            claim = db.scalars(
                select(Claim)
                .where(Claim.status == ClaimStatus.QUEUED)
                .order_by(Claim.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            ).first()
            if claim is None:
                return
            stedi = stedi or claims_stedi.stedi_client()
            try:
                _submit(db, stedi, claim)
            except _TryLater:
                logger.warning("Stedi unavailable; claim %s stays queued", claim.id)
                db.commit()
                return
            claims_changed(db, [claim])
            db.commit()
    finally:
        if stedi is not None:
            stedi.close()


def _handled_transactions(db: Session, since: datetime) -> set[str]:
    """Stedi transactions already stored as remittances or acknowledgment events."""
    references = db.scalars(
        select(Remittance.clearinghouse_ref).where(
            Remittance.source == STEDI_SOURCE, Remittance.created_at >= since - POLL_WINDOW
        )
    ).all()
    handled = {reference.split("#")[0] for reference in references if reference}
    event_data = db.scalars(
        select(ClaimEvent.data).where(
            ClaimEvent.kind.in_(_ACKNOWLEDGMENT_EVENTS),
            ClaimEvent.created_at >= since - POLL_WINDOW,
        )
    ).all()
    handled.update(
        data["transaction_id"] for data in event_data if data and data.get("transaction_id")
    )
    return handled


def _remittance_reference(transaction_id: str, index: int) -> str:
    """One reference per remittance in a transaction (almost always just one)."""
    return transaction_id if index == 0 else f"{transaction_id}#{index}"


def poll_clearinghouse(db: Session, now: datetime) -> None:
    """Collect new 277CA acknowledgments and 835 remittances while claims are in flight."""
    if not settings.stedi_enabled:
        return
    in_flight = db.scalar(
        select(
            exists().where(
                Claim.submission_method == ClaimSubmissionMethod.STEDI,
                Claim.status.in_((ClaimStatus.SUBMITTED, ClaimStatus.ACCEPTED)),
            )
        )
    )
    if not in_flight:
        return
    since = now - POLL_WINDOW
    with claims_stedi.stedi_client() as stedi:
        page = stedi.list_new_reports(
            since=since, skip_transaction_ids=_handled_transactions(db, since)
        )
    for report in page.reports:
        changed = []
        for acknowledgment in report.acknowledgments:
            claim = find_claim(db, acknowledgment.patient_control_number, None)
            if claim is None:
                continue
            apply_acknowledgment(db, claim, acknowledgment, transaction_id=report.transaction_id)
            changed.append(claim)
        for index, remittance in enumerate(report.remittances):
            reference = _remittance_reference(report.transaction_id, index)
            if db.scalar(select(exists().where(Remittance.clearinghouse_ref == reference))):
                continue
            practice_id = remittance_practice(db, remittance)
            if practice_id is None:
                logger.warning("No practice matches Stedi remittance %s", reference)
                continue
            import_remittance(
                db,
                practice_id,
                remittance,
                source=STEDI_SOURCE,
                now=now,
                clearinghouse_ref=reference,
            )
        claims_changed(db, changed)
        db.commit()
