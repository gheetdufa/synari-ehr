"""Client portal: the client's good faith estimates, acknowledging one, and asking for one.

Clients (and contacts signed in for them) see every estimate they were given, including ones
since replaced, as a record of their right to a good faith estimate; drafts and estimates
withdrawn as issued in error stay hidden. This doesn't depend on the portal billing
permission. Acknowledging receipt is optional and records the typed name, IP and browser.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from synari.audit import audit_client
from synari.db import utcnow
from synari.deps import CurrentClient, DbSession
from synari.models import Client, GoodFaithEstimate, StaffMember, StoredFile
from synari.models.enums import GoodFaithEstimateStatus
from synari.ratelimit import rate_limit
from synari.schemas.common import Message
from synari.schemas.estimates import (
    PortalClinician,
    PortalEstimateAcknowledge,
    PortalEstimateOut,
    PortalEstimateRequest,
    PortalEstimates,
)
from synari.services.estimates import estimates_enabled, request_estimate
from synari.services.storage import file_response

router = APIRouter(prefix="/portal/estimates", tags=["portal estimates"])

VISIBLE_STATUSES = (GoodFaithEstimateStatus.ISSUED, GoodFaithEstimateStatus.SUPERSEDED)


def _team_clinicians(client: Client) -> list[StaffMember]:
    """The client's active clinicians, primary first."""
    members = sorted(client.care_team, key=lambda member: not member.is_primary)
    return [
        member.staff for member in members if member.staff.is_active and member.staff.is_clinician
    ]


def _own_estimate(db: Session, client: Client, estimate_id: int) -> GoodFaithEstimate:
    estimate = db.get(GoodFaithEstimate, estimate_id)
    if (
        estimate is None
        or estimate.client_id != client.id
        or estimate.status not in VISIBLE_STATUSES
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Estimate not found")
    return estimate


def _view(estimate: GoodFaithEstimate, clinician: StaffMember | None) -> PortalEstimateOut:
    return PortalEstimateOut(
        id=estimate.id,
        clinician_name=clinician.display_name if clinician is not None else "",
        status=GoodFaithEstimateStatus(estimate.status),
        period_start=estimate.period_start,
        period_end=estimate.period_end,
        primary_service=estimate.primary_service,
        total_cents=estimate.total_cents,
        issued_at=estimate.issued_at,
        change_summary=estimate.change_summary,
        acknowledged_at=estimate.acknowledged_at,
        acknowledged_name=estimate.acknowledged_name,
    )


@router.get("", response_model=PortalEstimates)
def list_estimates(client: CurrentClient, db: DbSession, request: Request) -> PortalEstimates:
    """Every estimate the client was given, newest first, and whether they can ask for one."""
    estimates = list(
        db.scalars(
            select(GoodFaithEstimate)
            .where(
                GoodFaithEstimate.client_id == client.id,
                GoodFaithEstimate.status.in_(VISIBLE_STATUSES),
            )
            .order_by(GoodFaithEstimate.issued_at.desc(), GoodFaithEstimate.id.desc())
        )
    )
    staff = {
        member.id: member
        for member in db.scalars(
            select(StaffMember).where(StaffMember.id.in_({e.clinician_id for e in estimates}))
        )
    }
    pending = db.scalar(
        select(
            exists().where(
                GoodFaithEstimate.client_id == client.id,
                GoodFaithEstimate.status == GoodFaithEstimateStatus.DRAFT,
                GoodFaithEstimate.due_on.is_not(None),
            )
        )
    )
    result = PortalEstimates(
        enabled=estimates_enabled(client.practice),
        estimates=[_view(e, staff.get(e.clinician_id)) for e in estimates],
        clinicians=[
            PortalClinician(id=clinician.id, name=clinician.display_name)
            for clinician in _team_clinicians(client)
        ],
        request_pending=bool(pending),
    )
    audit_client(db, request, client, "estimate.list", "good_faith_estimate")
    db.commit()
    return result


@router.get("/{estimate_id}/pdf")
def download_estimate(
    estimate_id: int, client: CurrentClient, db: DbSession, request: Request
) -> Response:
    """The estimate's PDF, as issued."""
    estimate = _own_estimate(db, client, estimate_id)
    stored = db.get(StoredFile, estimate.file_id) if estimate.file_id is not None else None
    if stored is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Estimate not found")
    audit_client(db, request, client, "estimate.download", "good_faith_estimate", estimate.id)
    db.commit()
    return file_response(stored)


@router.post("/{estimate_id}/acknowledge", response_model=PortalEstimateOut)
def acknowledge_estimate(
    estimate_id: int,
    body: PortalEstimateAcknowledge,
    client: CurrentClient,
    db: DbSession,
    request: Request,
) -> PortalEstimateOut:
    """Acknowledge receiving the estimate (optional; the first acknowledgment is kept)."""
    estimate = _own_estimate(db, client, estimate_id)
    if estimate.acknowledged_at is None:
        estimate.acknowledged_at = utcnow()
        estimate.acknowledged_name = body.name
        estimate.acknowledged_ip = request.client.host if request.client else ""
        estimate.acknowledged_user_agent = request.headers.get("user-agent", "")[:300]
        audit_client(
            db, request, client, "estimate.acknowledge", "good_faith_estimate", estimate.id
        )
        db.commit()
    return _view(estimate, db.get(StaffMember, estimate.clinician_id))


@router.post(
    "/request",
    response_model=Message,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(rate_limit("estimate-request", limit=5, window_seconds=3600))],
)
def request_cost_estimate(
    body: PortalEstimateRequest, client: CurrentClient, db: DbSession, request: Request
) -> Message:
    """Ask the practice for a good faith estimate; it's due within 3 business days."""
    if not estimates_enabled(client.practice):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "Cost estimates aren't available in this portal"
        )
    clinicians = _team_clinicians(client)
    if body.clinician_id is not None:
        clinician = next((c for c in clinicians if c.id == body.clinician_id), None)
        if clinician is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Clinician not found")
    elif clinicians:
        clinician = clinicians[0]
    else:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Contact {client.practice.name} to ask for a cost estimate.",
        )
    estimate = request_estimate(db, client, clinician, utcnow())
    audit_client(
        db,
        request,
        client,
        "estimate.request",
        "good_faith_estimate",
        estimate.id,
        {"clinician_id": clinician.id},
    )
    db.commit()
    return Message(
        detail=f"Your request was sent. {client.practice.name} will send your estimate within "
        "3 business days."
    )
