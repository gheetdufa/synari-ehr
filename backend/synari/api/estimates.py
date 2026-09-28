"""Good Faith Estimates for self-pay clients (No Surprises Act): drafts, issuing, replacements,
PDFs and the "estimates needed" work queue.

Access:
- Reading a client's estimates needs billing access to the client or clinical access (the
  care team and their supervisors): estimates hold fees and diagnoses, which both roles see.
- Creating, editing, issuing, replacing and voiding needs billing access to the client, or
  being the estimate's clinician on the client's care team (a clinician without billing
  access writes estimates for their own services only).
- The work queue lists pairs the person can write for: every reachable client with billing
  access, else their own clients as clinician. Roles with neither (schedulers) get a 403.
Clients out of reach are a 404, a missing permission a 403. Every view and change is audited
with the client's id.
"""

from collections.abc import Sequence
from datetime import date

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import select

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import Client, ClientClinician, GoodFaithEstimate, StaffMember, StoredFile
from synari.models.enums import GoodFaithEstimateStatus, StaffStatus
from synari.permissions import Capability
from synari.schemas.appointments import ClientRef
from synari.schemas.estimates import (
    EstimateClinicianOption,
    EstimateDiagnosis,
    EstimateDraftIn,
    EstimateIssue,
    EstimateItemOut,
    EstimateNeedOut,
    EstimateOptions,
    EstimateOut,
    EstimateProvider,
    EstimateServiceOption,
    EstimateSupersede,
    EstimateVoid,
    SeparatelyScheduledItem,
)
from synari.services.billing import local_date, lock_client
from synari.services.estimate_lifecycle import (
    document_for,
    issue_estimate,
    issue_problems,
    supersede_estimate,
    void_estimate,
)
from synari.services.estimate_pdf import estimate_pdf
from synari.services.estimates import (
    REASON_MANUAL,
    apply_draft,
    estimate_needs,
    estimates_enabled,
    flag_estimate_need,
    max_period_end,
    missing_client_fields,
    missing_provider_fields,
    needs_estimates,
    new_draft,
    open_draft,
    practice_locations,
    provider_snapshot,
    service_options,
    suggest_for,
)
from synari.services.scheduling import zone_of
from synari.services.storage import file_response

router = APIRouter(tags=["estimates"])

DRAFT_ONLY = "Issued estimates can't be changed. Create an updated estimate instead."
DRAFT_EXISTS = (
    "There's already a draft estimate for this clinician and client. Open it to continue."
)
NO_WRITE = "Only billing staff or the client's clinician can change estimates"


def can_read(access: Access, client: Client) -> bool:
    """Billing or clinical access to the client."""
    return access.can_access_client(client, ClientAccess.BILLING) or access.can_access_client(
        client, ClientAccess.CLINICAL
    )


def can_write(access: Access, client: Client, clinician_id: int) -> bool:
    """Billing access to the client, or being that clinician on the client's care team."""
    if access.can_access_client(client, ClientAccess.BILLING):
        return True
    return (
        clinician_id == access.staff.id
        and access.staff.is_clinician
        and any(member.staff_id == access.staff.id for member in client.care_team)
    )


def _readable_client(access: Access, client_id: int) -> Client:
    client = access.db.get(Client, client_id)
    if client is None or client.practice_id != access.practice_id or not can_read(access, client):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
    return client


def _estimate(access: Access, estimate_id: int) -> tuple[GoodFaithEstimate, Client]:
    estimate = access.get(GoodFaithEstimate, estimate_id, label="Estimate")
    client = access.db.get_one(Client, estimate.client_id)
    if not can_read(access, client):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Estimate not found")
    return estimate, client


def _require_write(access: Access, client: Client, clinician_id: int) -> None:
    if not can_write(access, client, clinician_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, NO_WRITE)


def _require_draft(estimate: GoodFaithEstimate) -> None:
    if estimate.status != GoodFaithEstimateStatus.DRAFT:
        raise HTTPException(status.HTTP_409_CONFLICT, DRAFT_ONLY)


def _check_period(data: EstimateDraftIn) -> None:
    if data.period_end > max_period_end(data.period_start):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "An estimate can cover at most 12 months"
        )


def _estimate_clinician(access: Access, client: Client, clinician_id: int) -> StaffMember:
    """An active clinician of the practice this person may write the client's estimate for."""
    clinician = access.clinician(clinician_id)
    _require_write(access, client, clinician.id)
    return clinician


def _views(access: Access, estimates: Sequence[GoodFaithEstimate]) -> list[EstimateOut]:
    """Estimates as the API returns them: names, what replaced each, and for drafts a live
    provider preview with any identifiers still missing."""
    db = access.db
    if not estimates:
        return []
    staff_ids = {e.clinician_id for e in estimates} | {
        e.issued_by_id for e in estimates if e.issued_by_id is not None
    }
    staff = {s.id: s for s in db.scalars(select(StaffMember).where(StaffMember.id.in_(staff_ids)))}
    replaced_by = {
        row.supersedes_id: row.id
        for row in db.scalars(
            select(GoodFaithEstimate).where(
                GoodFaithEstimate.supersedes_id.in_([e.id for e in estimates]),
                GoodFaithEstimate.status.in_(
                    (GoodFaithEstimateStatus.ISSUED, GoodFaithEstimateStatus.SUPERSEDED)
                ),
            )
        )
    }
    practice = access.staff.practice
    today = local_date(utcnow(), zone_of(practice))
    views = []
    for estimate in estimates:
        draft = estimate.status == GoodFaithEstimateStatus.DRAFT
        clinician = staff[estimate.clinician_id]
        provider = (
            provider_snapshot(db, practice, clinician)
            if draft
            else EstimateProvider.model_validate(estimate.provider)
        )
        issued_by = staff.get(estimate.issued_by_id) if estimate.issued_by_id else None
        views.append(
            EstimateOut(
                id=estimate.id,
                client=ClientRef.model_validate(estimate.client),
                clinician_id=estimate.clinician_id,
                clinician_name=clinician.display_name,
                status=GoodFaithEstimateStatus(estimate.status),
                supersedes_id=estimate.supersedes_id,
                superseded_by_id=replaced_by.get(estimate.id),
                change_summary=estimate.change_summary,
                reason=estimate.reason,
                due_on=estimate.due_on,
                overdue=draft and estimate.due_on is not None and estimate.due_on < today,
                period_start=estimate.period_start,
                period_end=estimate.period_end,
                primary_service=estimate.primary_service,
                scheduled_dates=[date.fromisoformat(day) for day in estimate.scheduled_dates],
                diagnosis_codes=[
                    EstimateDiagnosis.model_validate(d) for d in estimate.diagnosis_codes
                ],
                items=[EstimateItemOut.model_validate(item) for item in estimate.items],
                separately_scheduled=[
                    SeparatelyScheduledItem.model_validate(item)
                    for item in estimate.separately_scheduled
                ],
                notes=estimate.notes,
                total_cents=estimate.total_cents,
                provider=provider,
                missing_provider_fields=missing_provider_fields(practice, provider)
                if draft
                else [],
                issued_at=estimate.issued_at,
                issued_by_name=issued_by.display_name if issued_by is not None else "",
                delivery_method=estimate.delivery_method,
                pdf_sha256=estimate.pdf_sha256,
                acknowledged_at=estimate.acknowledged_at,
                acknowledged_name=estimate.acknowledged_name,
                voided_at=estimate.voided_at,
                void_reason=estimate.void_reason,
                created_at=estimate.created_at,
                updated_at=estimate.updated_at,
            )
        )
    return views


def _view(access: Access, estimate: GoodFaithEstimate) -> EstimateOut:
    return _views(access, [estimate])[0]


def _audit(
    access: Access,
    request: Request,
    action: str,
    client: Client,
    estimate_id: int | None = None,
    detail: dict[str, object] | None = None,
) -> None:
    audit_staff(
        access.db,
        request,
        access.staff,
        action,
        "good_faith_estimate",
        estimate_id,
        detail,
        client_id=client.id,
    )


# A client's estimates ----------------------------------------------------------------------


@router.get("/clients/{client_id}/estimates", response_model=list[EstimateOut])
def list_client_estimates(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[EstimateOut]:
    """Every estimate for the client (drafts, issued, replaced and void), newest first."""
    client = _readable_client(access, client_id)
    estimates = list(
        db.scalars(
            select(GoodFaithEstimate)
            .where(GoodFaithEstimate.client_id == client.id)
            .order_by(GoodFaithEstimate.created_at.desc(), GoodFaithEstimate.id.desc())
        )
    )
    views = _views(access, estimates)
    _audit(access, request, "estimate.list", client)
    db.commit()
    return views


@router.get("/clients/{client_id}/estimates/options", response_model=EstimateOptions)
def estimate_options(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> EstimateOptions:
    """What the estimate form offers: clinicians this person may write for (with their rates
    and a draft suggested from upcoming sessions), the client's diagnoses and the offices."""
    client = _readable_client(access, client_id)
    now = utcnow()
    team_ids = {member.staff_id for member in client.care_team}
    if access.can_access_client(client, ClientAccess.BILLING):
        clinicians = list(
            db.scalars(
                select(StaffMember)
                .where(
                    StaffMember.practice_id == access.practice_id,
                    StaffMember.is_clinician,
                    StaffMember.status == StaffStatus.ACTIVE,
                )
                .order_by(StaffMember.last_name, StaffMember.first_name)
            )
        )
    else:
        clinicians = [access.staff] if can_write(access, client, access.staff.id) else []
    options = [
        EstimateClinicianOption(
            id=clinician.id,
            name=clinician.display_name,
            services=[
                EstimateServiceOption(
                    service_id=service.id,
                    code=service.code,
                    description=service.description,
                    duration_minutes=service.duration_minutes,
                    rate_cents=rate,
                )
                for service, rate in service_options(db, access.practice_id, clinician.id)
            ],
            suggested=suggest_for(db, client, clinician.id, now)
            if clinician.id in team_ids
            else None,
        )
        for clinician in clinicians
    ]
    primary = client.primary_clinician
    offered = {option.id for option in options}
    default_id = (
        primary.id if primary is not None and primary.id in offered else next(iter(offered), None)
    )
    result = EstimateOptions(
        enabled=estimates_enabled(client.practice),
        self_pay=needs_estimates(client),
        clinicians=options,
        diagnoses=[
            EstimateDiagnosis(
                code=str(d["code"])[:20], description=str(d.get("description", ""))[:300]
            )
            for d in client.diagnosis_codes
            if d.get("code")
        ],
        locations=practice_locations(db, client.practice),
        default_clinician_id=default_id,
        missing_client_fields=missing_client_fields(client),
    )
    _audit(access, request, "estimate.options_view", client)
    db.commit()
    return result


@router.post(
    "/clients/{client_id}/estimates",
    response_model=EstimateOut,
    status_code=status.HTTP_201_CREATED,
)
def create_estimate(
    client_id: int, body: EstimateDraftIn, access: CurrentAccess, db: DbSession, request: Request
) -> EstimateOut:
    """Start a draft estimate (one draft at a time per client and clinician)."""
    client = _readable_client(access, client_id)
    _estimate_clinician(access, client, body.clinician_id)
    _check_period(body)
    lock_client(db, client.id)
    if open_draft(db, client.id, body.clinician_id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, DRAFT_EXISTS)
    estimate = new_draft(client, body, reason=REASON_MANUAL)
    db.add(estimate)
    db.flush()
    _audit(access, request, "estimate.create", client, estimate.id)
    db.commit()
    db.refresh(estimate)
    return _view(access, estimate)


# Work queue --------------------------------------------------------------------------------


@router.get("/estimates/needed", response_model=list[EstimateNeedOut])
def list_needed_estimates(
    access: CurrentAccess, db: DbSession, request: Request
) -> list[EstimateNeedOut]:
    """Clients and clinicians needing an estimate: open drafts and upcoming self-pay sessions
    no issued estimate covers, soonest due first (overdue ones flagged)."""
    billing = access.can(Capability.BILLING_ALL) or access.can(Capability.BILLING_OWN)
    if not (billing or access.staff.is_clinician):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't include estimates")
    now = utcnow()
    practice = access.staff.practice
    today = local_date(now, zone_of(practice))
    readable = access.client_filter(ClientAccess.BILLING) | access.client_filter(
        ClientAccess.CLINICAL
    )
    found = estimate_needs(db, practice, now, clients=readable)
    # Who may write each estimate (see can_write), worked out for the whole list at once.
    ids = {need.client.id for need in found}
    billing = set(
        db.scalars(
            select(Client.id).where(Client.id.in_(ids), access.client_filter(ClientAccess.BILLING))
        )
    )
    my_clients = (
        set(
            db.scalars(
                select(ClientClinician.client_id).where(
                    ClientClinician.staff_id == access.staff.id, ClientClinician.client_id.in_(ids)
                )
            )
        )
        if access.staff.is_clinician
        else set()
    )
    needs = [
        need
        for need in found
        if need.client.id in billing
        or (need.clinician_id == access.staff.id and need.client.id in my_clients)
    ]
    staff = {
        s.id: s
        for s in db.scalars(
            select(StaffMember).where(StaffMember.id.in_({n.clinician_id for n in needs}))
        )
    }
    views = [
        EstimateNeedOut(
            client=ClientRef.model_validate(need.client),
            clinician_id=need.clinician_id,
            clinician_name=staff[need.clinician_id].display_name,
            reason=need.reason,
            due_on=need.due_on,
            overdue=need.due_on is not None and need.due_on < today,
            estimate_id=need.estimate_id,
            uncovered_sessions=need.uncovered_sessions,
            next_session_at=need.next_session_at,
        )
        for need in needs
    ]
    audit_staff_list(
        db, request, access.staff, "estimate.needed_list", (need.client.id for need in needs)
    )
    db.commit()
    return views


# One estimate ------------------------------------------------------------------------------


@router.get("/estimates/{estimate_id}", response_model=EstimateOut)
def get_estimate(
    estimate_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> EstimateOut:
    estimate, client = _estimate(access, estimate_id)
    view = _view(access, estimate)
    _audit(access, request, "estimate.view", client, estimate.id)
    db.commit()
    return view


@router.put("/estimates/{estimate_id}", response_model=EstimateOut)
def update_estimate(
    estimate_id: int,
    body: EstimateDraftIn,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EstimateOut:
    """Replace a draft's contents."""
    estimate, client = _estimate(access, estimate_id)
    _require_write(access, client, estimate.clinician_id)
    _require_draft(estimate)
    _check_period(body)
    if body.clinician_id != estimate.clinician_id:
        _estimate_clinician(access, client, body.clinician_id)
        lock_client(db, client.id)
        if open_draft(db, client.id, body.clinician_id) is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, DRAFT_EXISTS)
    apply_draft(estimate, body)
    _audit(access, request, "estimate.update", client, estimate.id)
    db.commit()
    db.refresh(estimate)
    return _view(access, estimate)


@router.delete("/estimates/{estimate_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_estimate(
    estimate_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Delete a draft. Issued estimates are part of the record and are never deleted."""
    estimate, client = _estimate(access, estimate_id)
    _require_write(access, client, estimate.clinician_id)
    _require_draft(estimate)
    db.delete(estimate)
    _audit(access, request, "estimate.delete", client, estimate_id)
    db.commit()


@router.post("/estimates/{estimate_id}/issue", response_model=EstimateOut)
def issue(
    estimate_id: int,
    body: EstimateIssue,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EstimateOut:
    """Give the estimate to the client: it's frozen, its PDF is stored and shared in their
    portal documents, and the client is told a document is ready. A replacement supersedes
    the estimate it replaces."""
    estimate, client = _estimate(access, estimate_id)
    _require_write(access, client, estimate.clinician_id)
    lock_client(db, client.id)
    db.refresh(estimate)
    _require_draft(estimate)
    now = utcnow()
    clinician = db.get_one(StaffMember, estimate.clinician_id)
    provider = provider_snapshot(db, client.practice, clinician)
    today = local_date(now, zone_of(client.practice))
    problems = issue_problems(estimate, client, provider, today)
    if problems:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Before issuing this estimate, {'; '.join(problems)}.",
        )
    issue_estimate(db, estimate, client, access.staff, body.delivery_method, now)
    _audit(
        access,
        request,
        "estimate.issue",
        client,
        estimate.id,
        {"supersedes_id": estimate.supersedes_id, "delivery_method": body.delivery_method},
    )
    db.commit()
    db.refresh(estimate)
    return _view(access, estimate)


@router.post(
    "/estimates/{estimate_id}/supersede",
    response_model=EstimateOut,
    status_code=status.HTTP_201_CREATED,
)
def supersede(
    estimate_id: int,
    body: EstimateSupersede,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EstimateOut:
    """Start an updated estimate from an issued one; issuing it supersedes the original."""
    estimate, client = _estimate(access, estimate_id)
    _require_write(access, client, estimate.clinician_id)
    if estimate.status != GoodFaithEstimateStatus.ISSUED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Only a current issued estimate can be updated"
        )
    lock_client(db, client.id)
    replacement = supersede_estimate(db, estimate, client, body.change_summary.strip(), utcnow())
    if replacement is None:
        raise HTTPException(status.HTTP_409_CONFLICT, DRAFT_EXISTS)
    _audit(
        access,
        request,
        "estimate.supersede",
        client,
        replacement.id,
        {"supersedes_id": estimate.id},
    )
    db.commit()
    db.refresh(replacement)
    return _view(access, replacement)


@router.post("/estimates/{estimate_id}/void", response_model=EstimateOut)
def void(
    estimate_id: int,
    body: EstimateVoid,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> EstimateOut:
    """Withdraw a draft, or an estimate issued in error (it's kept, unshared, with the reason)."""
    estimate, client = _estimate(access, estimate_id)
    _require_write(access, client, estimate.clinician_id)
    lock_client(db, client.id)
    db.refresh(estimate)
    if estimate.status not in (GoodFaithEstimateStatus.DRAFT, GoodFaithEstimateStatus.ISSUED):
        raise HTTPException(status.HTTP_409_CONFLICT, "This estimate can't be voided")
    now = utcnow()
    was_issued = void_estimate(db, estimate, body.reason.strip(), now)
    if was_issued:
        flag_estimate_need(db, client, estimate.clinician_id, now)
    _audit(access, request, "estimate.void", client, estimate.id, {"was_issued": was_issued})
    db.commit()
    db.refresh(estimate)
    return _view(access, estimate)


@router.get("/estimates/{estimate_id}/pdf")
def download_estimate_pdf(
    estimate_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    """The issued PDF exactly as the client received it, or a marked preview of a draft."""
    estimate, client = _estimate(access, estimate_id)
    stored = db.get(StoredFile, estimate.file_id) if estimate.file_id is not None else None
    _audit(access, request, "estimate.download", client, estimate.id)
    db.commit()
    if stored is not None:
        return file_response(stored)
    content = estimate_pdf(estimate, document_for(db, estimate, client, utcnow()))
    filename = f"Good Faith Estimate draft {estimate.id}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
