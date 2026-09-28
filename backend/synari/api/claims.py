"""Insurance claims: the sessions waiting to be billed, drafting, editing, validating,
submitting (Stedi, 837P file or CMS-1500 paper), corrections, voids and secondary claims.

Everything needs billing access to the claim's client (see synari/access.py): practice-wide
billing reaches every client, clinicians with billing access reach their own clients. Lists
without any billing access are a 403; a claim the person can't reach is a 404.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import Select, exists, func, select
from sqlalchemy.orm import contains_eager, selectinload

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list
from synari.deps import CurrentAccess, DbSession
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Claim,
    ClaimLine,
    Client,
    EligibilityCheck,
    InsurancePolicy,
    Note,
    StaffMember,
)
from synari.models.enums import BillingType, ClaimStatus, ClaimSubmissionMethod, NoteStatus
from synari.pagination import ListPage, QueuePage, paginate
from synari.schemas.claims import (
    ClaimCreate,
    ClaimDetailOut,
    ClaimDiagnosis,
    ClaimEventOut,
    ClaimIssueOut,
    ClaimLineOut,
    ClaimOut,
    ClaimsRejected,
    ClaimStatusTotalsOut,
    ClaimSubmit,
    ClaimUpdate,
    ClaimValidation,
    UnbilledSessionOut,
)
from synari.services import claims_stedi
from synari.services.billing import local_midnight, session_policy_sql
from synari.services.claims import (
    ADJUDICABLE_STATUSES,
    EDITABLE_STATUSES,
    RESPONSIBILITY_BY_RANK,
    active_policy,
    add_event,
    claim_blocker,
    claims_changed,
    cms1500_for,
    correct_claim,
    create_claims,
    default_pointers,
    export_837p,
    print_on_paper,
    queue_for_stedi,
    require_billing,
    secondary_claim,
    service_date,
    successor_claim,
    unbilled_participants,
    void_claim,
)
from synari.services.claims_document import claim_issues
from synari.services.note_records import part_of_record
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/claims", tags=["claims"])

PRIMARY = "primary"
SECONDARY = "secondary"
X12_MEDIA_TYPE = "application/edi-x12"


def _download(content: bytes | str, media_type: str, filename: str) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _claim(access: Access, claim_id: int) -> Claim:
    return access.client_record(Claim, claim_id, ClientAccess.BILLING, label="Claim")


def _locked_claim(access: Access, claim_id: int) -> Claim:
    """A reachable claim, row-locked for a status change."""
    claim = _claim(access, claim_id)
    access.db.refresh(claim, with_for_update=True)
    return claim


def _names(access: Access, claims: list[Claim]) -> dict[int, str]:
    staff_ids = {c.rendering_clinician_id for c in claims} | {
        c.supervising_clinician_id for c in claims if c.supervising_clinician_id
    }
    return {
        member.id: member.display_name
        for member in access.db.scalars(select(StaffMember).where(StaffMember.id.in_(staff_ids)))
    }


def claim_views(access: Access, claims: list[Claim]) -> list[ClaimOut]:
    """Claims with client, payer and clinician names and their date span."""
    names = _names(access, claims)
    views = []
    for claim in claims:
        view = ClaimOut.model_validate(claim)
        view.client_name = claim.client.full_name
        view.payer_name = claim.payer.name
        view.rendering_clinician_name = names.get(claim.rendering_clinician_id, "")
        view.supervising_clinician_name = names.get(claim.supervising_clinician_id or 0, "")
        dates = [line.service_date for line in claim.lines]
        view.first_service_date = min(dates, default=None)
        view.last_service_date = max(dates, default=None)
        views.append(view)
    return views


def claim_detail(access: Access, claim: Claim) -> ClaimDetailOut:
    """A claim with its lines, history, live validation issues and diagnosis descriptions."""
    base = claim_views(access, [claim])[0]
    descriptions = {
        str(entry.get("code", "")).strip().upper().replace(".", ""): str(
            entry.get("description", "")
        )
        for entry in claim.client.diagnosis_codes
    }
    appointment_ids = dict(
        access.db.execute(
            select(AppointmentParticipant.id, AppointmentParticipant.appointment_id).where(
                AppointmentParticipant.id.in_(
                    [line.participant_id for line in claim.lines if line.participant_id]
                )
            )
        ).all()
    )
    lines = []
    for line in claim.lines:
        view = ClaimLineOut.model_validate(line)
        view.appointment_id = appointment_ids.get(line.participant_id or 0)
        lines.append(view)
    return ClaimDetailOut(
        **base.model_dump(),
        lines=lines,
        events=[ClaimEventOut.model_validate(event) for event in claim.events],
        issues=[ClaimIssueOut.model_validate(i) for i in claim_issues(access.db, claim)],
        diagnoses=[
            ClaimDiagnosis(code=code, description=descriptions.get(code, ""))
            for code in claim.diagnosis_codes
        ],
    )


# The unbilled queue -----------------------------------------------------------------------


@router.get("/unbilled", response_model=list[UnbilledSessionOut])
def list_unbilled(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: QueuePage,
    response: Response,
    clinician_id: int | None = Query(default=None),
    payer_id: int | None = Query(default=None),
    client_id: int | None = Query(default=None),
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
) -> list[UnbilledSessionOut]:
    """A page of the attended sessions of insurance clients with a primary policy in effect
    that day, not yet claimed; by client, then oldest first."""
    require_billing(access)
    practice = access.staff.practice
    zone = zone_of(practice)
    primary_policy_id = session_policy_sql(lambda policy: policy.id, PRIMARY, zone)
    query = (
        unbilled_participants(practice.id)
        .join(InsurancePolicy, InsurancePolicy.id == primary_policy_id)
        .where(
            access.client_filter(ClientAccess.BILLING),
            Client.billing_type == BillingType.INSURANCE,
        )
        .add_columns(InsurancePolicy)
    )
    if clinician_id is not None:
        query = query.where(Appointment.clinician_id == clinician_id)
    if payer_id is not None:
        query = query.where(InsurancePolicy.payer_id == payer_id)
    if client_id is not None:
        query = query.where(AppointmentParticipant.client_id == client_id)
    if start is not None:
        query = query.where(Appointment.starts_at >= local_midnight(start, zone))
    if end is not None:
        query = query.where(Appointment.starts_at < local_midnight(end + timedelta(days=1), zone))
    ordered = query.options(
        contains_eager(AppointmentParticipant.appointment),
        contains_eager(AppointmentParticipant.client),
    ).order_by(
        Client.last_name,
        Client.first_name,
        Client.id,
        Appointment.starts_at,
        AppointmentParticipant.id,
    )
    sessions = [
        (participant, service_date(participant.appointment, practice), policy)
        for participant, policy in db.execute(paginate(db, ordered, page, response))
    ]

    appointment_ids = {participant.appointment_id for participant, _, _ in sessions}
    signed = {
        (appointment_id, note_client_id)
        for appointment_id, note_client_id in db.execute(
            select(Note.appointment_id, Note.client_id).where(
                Note.appointment_id.in_(appointment_ids),
                Note.status == NoteStatus.SIGNED,
                part_of_record(),
            )
        )
    }
    eligibility: dict[int, str] = {}
    for policy_id, check_status in db.execute(
        select(EligibilityCheck.policy_id, EligibilityCheck.status)
        .where(EligibilityCheck.policy_id.in_({policy.id for _, _, policy in sessions}))
        .order_by(EligibilityCheck.created_at, EligibilityCheck.id)
    ):
        eligibility[policy_id] = check_status
    clinicians = {
        member.id: member.display_name
        for member in db.scalars(
            select(StaffMember).where(
                StaffMember.id.in_({p.appointment.clinician_id for p, _, _ in sessions})
            )
        )
    }
    result = [
        UnbilledSessionOut(
            participant_id=participant.id,
            appointment_id=participant.appointment_id,
            client_id=participant.client_id,
            client_name=participant.client.full_name,
            clinician_id=participant.appointment.clinician_id,
            clinician_name=clinicians.get(participant.appointment.clinician_id, ""),
            starts_at=participant.appointment.starts_at,
            service_date=day,
            service_code=participant.appointment.service_code,
            service_description=participant.appointment.service_description,
            fee_cents=participant.fee_cents,
            location_type=participant.appointment.location_type,
            policy_id=policy.id,
            payer_id=policy.payer_id,
            payer_name=policy.payer.name,
            note_signed=(participant.appointment_id, participant.client_id) in signed,
            has_diagnoses=bool(participant.client.diagnosis_codes),
            eligibility_status=eligibility.get(policy.id),
        )
        for participant, day, policy in sessions
    ]
    audit_staff_list(
        db, request, access.staff, "claims.unbilled_list", (row.client_id for row in result)
    )
    db.commit()
    return result


# Claims -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class ClaimFilters:
    """Which claims a list shows (the status filter aside)."""

    payer_id: int | None
    client_id: int | None
    clinician_id: int | None
    start: date | None
    end: date | None


def claim_filters(
    payer_id: int | None = Query(default=None),
    client_id: int | None = Query(default=None),
    clinician_id: int | None = Query(
        default=None, description="The rendering or supervising clinician"
    ),
    start: date | None = Query(default=None, description="A date of service on or after"),
    end: date | None = Query(default=None, description="A date of service on or before"),
) -> ClaimFilters:
    """The claim list filters from the query string."""
    return ClaimFilters(payer_id, client_id, clinician_id, start, end)


Filters = Annotated[ClaimFilters, Depends(claim_filters)]


def _filtered_claims[T: tuple[Any, ...]](
    access: Access, query: Select[T], filters: ClaimFilters
) -> Select[T]:
    """The query limited to reachable clients' claims that match the filters."""
    query = query.join(Client, Client.id == Claim.client_id).where(
        Claim.practice_id == access.practice_id, access.client_filter(ClientAccess.BILLING)
    )
    if filters.payer_id is not None:
        query = query.where(Claim.payer_id == filters.payer_id)
    if filters.client_id is not None:
        query = query.where(Claim.client_id == filters.client_id)
    if filters.clinician_id is not None:
        query = query.where(
            (Claim.rendering_clinician_id == filters.clinician_id)
            | (Claim.supervising_clinician_id == filters.clinician_id)
        )
    if filters.start is not None or filters.end is not None:
        in_range = ClaimLine.claim_id == Claim.id
        if filters.start is not None:
            in_range &= ClaimLine.service_date >= filters.start
        if filters.end is not None:
            in_range &= ClaimLine.service_date <= filters.end
        query = query.where(exists().where(in_range))
    return query


def _audit_claim_list(
    access: Access,
    request: Request,
    client_ids: Iterable[int],
    filters: ClaimFilters,
    status: ClaimStatus | None = None,
) -> None:
    """Record that these clients' claims were listed."""
    audit_staff_list(
        access.db,
        request,
        access.staff,
        "claim.list",
        client_ids,
        detail={"client_id": filters.client_id, "status": status},
    )
    access.db.commit()


@router.get("", response_model=list[ClaimOut])
def list_claims(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    filters: Filters,
    page: ListPage,
    response: Response,
    status_filter: ClaimStatus | None = Query(default=None, alias="status"),
) -> list[ClaimOut]:
    """A page of the claims of the clients whose billing this person sees, newest first."""
    require_billing(access)
    query = _filtered_claims(access, select(Claim), filters)
    if status_filter is not None:
        query = query.where(Claim.status == status_filter)
    ordered = query.options(
        selectinload(Claim.lines), selectinload(Claim.client), selectinload(Claim.payer)
    ).order_by(Claim.id.desc())
    claims = list(db.scalars(paginate(db, ordered, page, response)))
    _audit_claim_list(
        access, request, (claim.client_id for claim in claims), filters, status_filter
    )
    return claim_views(access, claims)


@router.get("/summary", response_model=list[ClaimStatusTotalsOut])
def claims_summary(
    access: CurrentAccess, request: Request, filters: Filters
) -> list[ClaimStatusTotalsOut]:
    """How many claims of each status match the filters, with their money totals."""
    require_billing(access)
    totals = select(
        Claim.status,
        func.count(Claim.id),
        func.sum(Claim.total_charge_cents),
        func.sum(Claim.paid_cents),
        func.sum(Claim.patient_responsibility_cents),
        func.sum(Claim.insurance_balance_cents),
    )
    rows = access.db.execute(
        _filtered_claims(access, totals, filters).group_by(Claim.status).order_by(Claim.status)
    ).all()
    # Totals name a client only when filtered to one.
    _audit_claim_list(
        access, request, [filters.client_id] if filters.client_id is not None else [], filters
    )
    return [
        ClaimStatusTotalsOut(
            status=ClaimStatus(status),
            claims=count,
            charged_cents=charged,
            paid_cents=paid,
            patient_responsibility_cents=responsibility,
            insurance_balance_cents=balance,
        )
        for status, count, charged, paid, responsibility, balance in rows
    ]


@router.post("", response_model=list[ClaimOut], status_code=status.HTTP_201_CREATED)
def create_claim(
    body: ClaimCreate, access: CurrentAccess, db: DbSession, request: Request
) -> list[ClaimOut]:
    """Draft claims for sessions of one client (split so each has at most 6 dates)."""
    require_billing(access)
    participant_ids = list(dict.fromkeys(body.participant_ids))
    participants = list(
        db.scalars(
            select(AppointmentParticipant)
            .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
            .where(
                AppointmentParticipant.id.in_(participant_ids),
                Appointment.practice_id == access.practice_id,
            )
            .order_by(AppointmentParticipant.id)
            .with_for_update(of=AppointmentParticipant)
        )
    )
    if len(participants) != len(participant_ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if len({participant.client_id for participant in participants}) != 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A claim covers sessions of one client"
        )
    client = access.client(participants[0].client_id, ClientAccess.BILLING, label="Session")
    for participant in participants:
        blocker = claim_blocker(db, participant)
        if blocker:
            raise HTTPException(status.HTTP_409_CONFLICT, blocker)

    first_day = min(service_date(p.appointment, client.practice) for p in participants)
    if body.policy_id is not None:
        policy = db.get(InsurancePolicy, body.policy_id)
        if policy is None or policy.client_id != client.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurance policy not found")
    else:
        found = active_policy(client, PRIMARY, first_day)
        if found is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{client.full_name} has no active primary insurance policy",
            )
        policy = found
    responsibility = body.payer_responsibility or RESPONSIBILITY_BY_RANK.get(policy.rank, "P")
    claims = create_claims(db, client, participants, policy, responsibility, access.staff.id)
    audit_staff(
        db,
        request,
        access.staff,
        "claim.create",
        "claim",
        claims[0].id,
        {"claim_ids": [claim.id for claim in claims]},
        client_id=client.id,
    )
    claims_changed(db, claims)
    db.commit()
    return claim_views(access, claims)


@router.post("/submit", response_model=None)
def submit_claims(
    body: ClaimSubmit, access: CurrentAccess, db: DbSession, request: Request
) -> list[ClaimOut] | Response:
    """Submit draft or rejected claims.

    - stedi: queued for the worker to send; returns the claims.
    - x12_file: returns one 837P file to upload to a clearinghouse; claims are marked submitted.
    - paper: returns CMS-1500 forms (PDF) to print on red forms; claims are marked submitted.

    Nothing is submitted when any claim has issues: 422 with {message, claims: [{claim_id,
    patient_control_number, issues}]}.
    """
    require_billing(access)
    claims = [_locked_claim(access, claim_id) for claim_id in dict.fromkeys(body.claim_ids)]
    for claim in claims:
        if claim.status not in EDITABLE_STATUSES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Claim {claim.patient_control_number} isn't a draft or rejected claim",
            )
    practice = access.staff.practice
    if body.method == ClaimSubmissionMethod.STEDI:
        claims_stedi.require_stedi()
    if body.method == ClaimSubmissionMethod.X12_FILE and not (
        practice.settings.x12_submitter_id and practice.settings.x12_receiver_id
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Add your clearinghouse's submitter and receiver IDs in insurance settings first",
        )
    problems = [
        ClaimValidation(
            claim_id=claim.id,
            patient_control_number=claim.patient_control_number,
            issues=[ClaimIssueOut.model_validate(issue) for issue in issues],
        )
        for claim in claims
        if (issues := claim_issues(db, claim, body.method))
    ]
    if problems:
        rejected = ClaimsRejected(
            message="Fix these claims before submitting them.", claims=problems
        )
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, rejected.model_dump())

    staff_id = access.staff.id
    download: Response | None = None
    if body.method == ClaimSubmissionMethod.STEDI:
        for claim in claims:
            queue_for_stedi(claim, staff_id)
    elif body.method == ClaimSubmissionMethod.X12_FILE:
        content, control_number = export_837p(db, practice, claims, staff_id)
        download = _download(content, X12_MEDIA_TYPE, f"claims-837p-{control_number:09d}.txt")
    else:
        pdf = print_on_paper(db, practice, claims, staff_id)
        download = _download(pdf, "application/pdf", "cms1500-claims.pdf")
    for claim in claims:
        audit_staff(
            db,
            request,
            access.staff,
            "claim.submit",
            "claim",
            claim.id,
            {"method": body.method},
            client_id=claim.client_id,
        )
    claims_changed(db, claims)
    db.commit()
    return download if download is not None else claim_views(access, claims)


@router.get("/{claim_id}", response_model=ClaimDetailOut)
def get_claim(
    claim_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ClaimDetailOut:
    """A claim with its lines, history and what would stop it from being accepted."""
    claim = _claim(access, claim_id)
    detail = claim_detail(access, claim)
    audit_staff(
        db, request, access.staff, "claim.view", "claim", claim.id, client_id=claim.client_id
    )
    db.commit()
    return detail


def _clinician(access: Access, staff_id: int) -> StaffMember:
    member = access.get(StaffMember, staff_id, label="Clinician")
    if not member.is_clinician:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a clinician")
    return member


@router.patch("/{claim_id}", response_model=ClaimDetailOut)
def update_claim(
    claim_id: int, body: ClaimUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> ClaimDetailOut:
    """Edit a draft or rejected claim: diagnoses and their order, line codes, modifiers,
    units, place of service and pointers, prior authorization and clinicians."""
    claim = _locked_claim(access, claim_id)
    if claim.status not in EDITABLE_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only draft or rejected claims can be edited")
    changes = body.model_dump(exclude_unset=True)
    if "diagnosis_codes" in changes:
        if len(set(body.diagnosis_codes or [])) != len(body.diagnosis_codes or []):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "A diagnosis is listed twice"
            )
        claim.diagnosis_codes = list(body.diagnosis_codes or [])
        count = len(claim.diagnosis_codes)
        for line in claim.lines:
            kept = [pointer for pointer in line.diagnosis_pointers if pointer <= count]
            line.diagnosis_pointers = kept or default_pointers(count)
    for field in ("place_of_service", "prior_authorization_number", "payer_claim_number"):
        if field in changes:
            setattr(claim, field, (changes[field] or "").strip())
    if body.rendering_clinician_id is not None:
        claim.rendering_clinician_id = _clinician(access, body.rendering_clinician_id).id
    if "supervising_clinician_id" in changes:
        supervisor_id = body.supervising_clinician_id
        claim.supervising_clinician_id = (
            _clinician(access, supervisor_id).id if supervisor_id is not None else None
        )
    lines_by_id = {line.id: line for line in claim.lines}
    for update in body.lines or []:
        line = lines_by_id.get(update.id)
        if line is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Claim line not found")
        for field, value in update.model_dump(exclude_unset=True, exclude={"id"}).items():
            setattr(line, field, value)
    add_event(
        claim, "updated", "Claim edited", staff_id=access.staff.id, data={"fields": sorted(changes)}
    )
    audit_staff(
        db,
        request,
        access.staff,
        "claim.update",
        "claim",
        claim.id,
        {"fields": sorted(changes)},
        client_id=claim.client_id,
    )
    claims_changed(db, [claim])
    db.commit()
    return claim_detail(access, claim)


@router.post("/{claim_id}/validate", response_model=ClaimValidation)
def validate(claim_id: int, access: CurrentAccess) -> ClaimValidation:
    """What would stop the claim from being accepted (empty when it's ready to send)."""
    claim = _claim(access, claim_id)
    return ClaimValidation(
        claim_id=claim.id,
        patient_control_number=claim.patient_control_number,
        issues=[ClaimIssueOut.model_validate(issue) for issue in claim_issues(access.db, claim)],
    )


def _require_no_successor(access: Access, claim: Claim) -> None:
    successor = successor_claim(access.db, claim)
    if successor is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Claim {successor.patient_control_number} already corrects or voids this claim",
        )


@router.post(
    "/{claim_id}/correct", response_model=ClaimDetailOut, status_code=status.HTTP_201_CREATED
)
def correct(
    claim_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ClaimDetailOut:
    """A draft replacement claim (frequency 7) for a claim the payer already has."""
    claim = _locked_claim(access, claim_id)
    if claim.status not in ADJUDICABLE_STATUSES:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Only submitted, accepted, paid or denied claims can be corrected; edit drafts and "
            "rejected claims directly",
        )
    _require_no_successor(access, claim)
    replacement = correct_claim(db, claim, access.staff.id)
    audit_staff(
        db,
        request,
        access.staff,
        "claim.correct",
        "claim",
        replacement.id,
        {"of": claim.id},
        client_id=claim.client_id,
    )
    claims_changed(db, [claim, replacement])
    db.commit()
    return claim_detail(access, replacement)


@router.post("/{claim_id}/void", response_model=ClaimDetailOut)
def void(claim_id: int, access: CurrentAccess, db: DbSession, request: Request) -> ClaimDetailOut:
    """Void a claim. Drafts, queued and rejected claims are voided at once; claims the payer
    has get a void claim (frequency 8), returned as a draft to submit."""
    claim = _locked_claim(access, claim_id)
    if claim.status == ClaimStatus.VOID:
        raise HTTPException(status.HTTP_409_CONFLICT, "The claim is already void")
    if claim.status in ADJUDICABLE_STATUSES:
        _require_no_successor(access, claim)
    result = void_claim(db, claim, access.staff.id)
    audit_staff(
        db,
        request,
        access.staff,
        "claim.void",
        "claim",
        result.id,
        {"of": claim.id},
        client_id=claim.client_id,
    )
    claims_changed(db, {claim.id: claim, result.id: result}.values())
    db.commit()
    return claim_detail(access, result)


@router.post(
    "/{claim_id}/secondary", response_model=ClaimDetailOut, status_code=status.HTTP_201_CREATED
)
def create_secondary(
    claim_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ClaimDetailOut:
    """A draft claim to the client's secondary policy, after the primary payer paid."""
    claim = _locked_claim(access, claim_id)
    if claim.payer_responsibility != "P" or claim.status not in (
        ClaimStatus.PAID,
        ClaimStatus.DENIED,
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Secondary claims follow a primary claim the payer has paid or denied",
        )
    exists_already = db.scalar(
        select(Claim.id).where(Claim.primary_claim_id == claim.id, Claim.status != ClaimStatus.VOID)
    )
    if exists_already is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "A secondary claim already exists")
    first_day = min(line.service_date for line in claim.lines)
    policy = active_policy(claim.client, SECONDARY, first_day)
    if policy is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{claim.client.full_name} has no active secondary insurance policy",
        )
    secondary = secondary_claim(db, claim, policy, access.staff.id)
    audit_staff(
        db,
        request,
        access.staff,
        "claim.secondary",
        "claim",
        secondary.id,
        {"of": claim.id},
        client_id=claim.client_id,
    )
    claims_changed(db, [claim, secondary])
    db.commit()
    return claim_detail(access, secondary)


@router.get("/{claim_id}/cms1500.pdf")
def download_cms1500(
    claim_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    """The claim on a CMS-1500 form (data only, for red pre-printed forms)."""
    claim = _claim(access, claim_id)
    pdf = cms1500_for(db, access.staff.practice, [claim])
    audit_staff(
        db, request, access.staff, "claim.cms1500", "claim", claim.id, client_id=claim.client_id
    )
    db.commit()
    return _download(pdf, "application/pdf", f"cms1500-{claim.patient_control_number}.pdf")
