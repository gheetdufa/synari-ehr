"""Insurance setup: claim settings, the payer list, prior authorizations and eligibility checks.

Reading needs billing access (practice-wide or for one's own clients). Changing settings needs
the practice-management permission; changing payers needs practice-wide billing or practice
management. Authorizations and eligibility checks need billing access to the policy's client.
"""

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import func, select

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_throttled
from synari.claims.stedi import ClearinghouseError
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import (
    Claim,
    ClaimLine,
    EligibilityCheck,
    InsurancePolicy,
    Payer,
    PracticeSettings,
    PriorAuthorization,
)
from synari.models.enums import ClaimStatus
from synari.permissions import Capability
from synari.schemas.insurance import (
    AuthorizationFields,
    AuthorizationOut,
    AuthorizationUpdate,
    EligibilityCheckOut,
    InsuranceSettingsOut,
    InsuranceSettingsUpdate,
    PayerFields,
    PayerOut,
    PayerSearchResult,
    PayerUpdate,
)
from synari.services import claims_stedi
from synari.services.billing import local_date
from synari.services.claims import require_billing
from synari.services.claims_eligibility import (
    EligibilityUnavailable,
    check_eligibility,
    eligibility_request,
)
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/insurance", tags=["insurance"])


def _settings_out(practice_settings: PracticeSettings) -> InsuranceSettingsOut:
    return InsuranceSettingsOut(
        telehealth_modifier=practice_settings.telehealth_modifier,
        supervised_billing=practice_settings.supervised_billing,
        x12_submitter_id=practice_settings.x12_submitter_id,
        x12_receiver_id=practice_settings.x12_receiver_id,
        x12_receiver_name=practice_settings.x12_receiver_name,
        eligibility_auto_check=practice_settings.eligibility_auto_check,
        clearinghouse_enabled=settings.stedi_enabled,
        clearinghouse_usage=settings.stedi_usage,
    )


def _require_payer_admin(access: Access) -> None:
    if not (access.can(Capability.BILLING_ALL) or access.can(Capability.MANAGE_PRACTICE)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role can't change the payer list")


def billing_policy(access: Access, policy_id: int) -> InsurancePolicy:
    """A policy whose client's billing this person can reach; 404 otherwise."""
    policy = access.db.get(InsurancePolicy, policy_id)
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurance policy not found")
    access.client(policy.client_id, ClientAccess.BILLING, label="Insurance policy")
    return policy


# Settings ---------------------------------------------------------------------------------


@router.get("/settings", response_model=InsuranceSettingsOut)
def get_insurance_settings(access: CurrentAccess) -> InsuranceSettingsOut:
    """Claim options, and whether a clearinghouse is connected."""
    require_billing(access)
    return _settings_out(access.staff.practice.settings)


@router.patch("/settings", response_model=InsuranceSettingsOut)
def update_insurance_settings(
    body: InsuranceSettingsUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> InsuranceSettingsOut:
    """Change claim options (telehealth modifier, supervised billing, 837P ids, auto checks)."""
    access.require(Capability.MANAGE_PRACTICE)
    practice_settings = access.staff.practice.settings
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(practice_settings, field, value.strip() if isinstance(value, str) else value)
    audit_staff(
        db, request, access.staff, "insurance.settings_update", detail={"fields": sorted(changes)}
    )
    db.commit()
    return _settings_out(practice_settings)


# Payers -----------------------------------------------------------------------------------


@router.get("/payers", response_model=list[PayerOut])
def list_payers(
    access: CurrentAccess, include_inactive: bool = Query(default=False)
) -> list[Payer]:
    """The practice's payer list, by name."""
    require_billing(access)
    query = select(Payer).where(Payer.practice_id == access.practice_id)
    if not include_inactive:
        query = query.where(Payer.is_active)
    return list(access.db.scalars(query.order_by(func.lower(Payer.name), Payer.id)))


@router.get("/payers/search", response_model=list[PayerSearchResult])
def search_payers(
    access: CurrentAccess, q: str = Query(min_length=2, max_length=100)
) -> list[PayerSearchResult]:
    """Payers in the clearinghouse's network matching a name or payer ID."""
    require_billing(access)
    claims_stedi.require_stedi()
    try:
        with claims_stedi.stedi_client() as stedi:
            matches = stedi.search_payers(q.strip())
    except ClearinghouseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return [
        PayerSearchResult(
            stedi_id=match.stedi_id,
            name=match.name,
            payer_id=match.primary_payer_id,
            aliases=list(match.aliases),
            professional_claims=match.professional_claims,
            eligibility=match.eligibility,
            remittances=match.remittances,
        )
        for match in matches
    ]


@router.post("/payers", response_model=PayerOut, status_code=status.HTTP_201_CREATED)
def create_payer(
    body: PayerFields, access: CurrentAccess, db: DbSession, request: Request
) -> Payer:
    """Add an insurance company to the payer list."""
    _require_payer_admin(access)
    payer = Payer(practice_id=access.practice_id, **body.model_dump())
    db.add(payer)
    db.flush()
    audit_staff(db, request, access.staff, "payer.create", "payer", payer.id)
    db.commit()
    return payer


@router.patch("/payers/{payer_id}", response_model=PayerOut)
def update_payer(
    payer_id: int, body: PayerUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> Payer:
    """Edit a payer. Deactivate it (is_active=false) instead of deleting it."""
    _require_payer_admin(access)
    payer = access.get(Payer, payer_id, label="Payer")
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(payer, field, value)
    audit_staff(
        db, request, access.staff, "payer.update", "payer", payer.id, {"fields": sorted(changes)}
    )
    db.commit()
    return payer


# Prior authorizations ---------------------------------------------------------------------


def _authorization_out(access: Access, authorization: PriorAuthorization) -> AuthorizationOut:
    used = access.db.scalar(
        select(func.count(ClaimLine.id))
        .join(Claim, Claim.id == ClaimLine.claim_id)
        .where(
            Claim.policy_id == authorization.policy_id,
            Claim.status != ClaimStatus.VOID,
            Claim.frequency_code == "1",
            Claim.prior_authorization_number == authorization.number,
            ClaimLine.service_date.between(authorization.start_date, authorization.end_date),
        )
    )
    view = AuthorizationOut.model_validate(authorization)
    view.visits_used = int(used or 0)
    return view


def _authorization(policy: InsurancePolicy, authorization_id: int) -> PriorAuthorization:
    authorization = next((a for a in policy.authorizations if a.id == authorization_id), None)
    if authorization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Authorization not found")
    return authorization


@router.get("/policies/{policy_id}/authorizations", response_model=list[AuthorizationOut])
def list_authorizations(
    policy_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[AuthorizationOut]:
    """The policy's prior authorizations, by start date, with the visits billed under each."""
    policy = billing_policy(access, policy_id)
    authorizations = [_authorization_out(access, a) for a in policy.authorizations]
    audit_staff_throttled(
        db,
        request,
        access.staff,
        "authorization.list",
        "insurance_policy",
        policy.id,
        client_id=policy.client_id,
    )
    db.commit()
    return authorizations


@router.post(
    "/policies/{policy_id}/authorizations",
    response_model=AuthorizationOut,
    status_code=status.HTTP_201_CREATED,
)
def create_authorization(
    policy_id: int,
    body: AuthorizationFields,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AuthorizationOut:
    """Record an insurer's approval for visits in a date range."""
    policy = billing_policy(access, policy_id)
    authorization = PriorAuthorization(policy_id=policy.id, **body.model_dump())
    db.add(authorization)
    db.flush()
    audit_staff(
        db,
        request,
        access.staff,
        "authorization.create",
        "prior_authorization",
        authorization.id,
        client_id=policy.client_id,
    )
    db.commit()
    return _authorization_out(access, authorization)


@router.patch(
    "/policies/{policy_id}/authorizations/{authorization_id}", response_model=AuthorizationOut
)
def update_authorization(
    policy_id: int,
    authorization_id: int,
    body: AuthorizationUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> AuthorizationOut:
    """Edit a prior authorization."""
    policy = billing_policy(access, policy_id)
    authorization = _authorization(policy, authorization_id)
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(authorization, field, value)
    if authorization.end_date < authorization.start_date:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "The end date must be on or after the start date",
        )
    audit_staff(
        db,
        request,
        access.staff,
        "authorization.update",
        "prior_authorization",
        authorization.id,
        {"fields": sorted(changes)},
        client_id=policy.client_id,
    )
    db.commit()
    return _authorization_out(access, authorization)


@router.delete(
    "/policies/{policy_id}/authorizations/{authorization_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_authorization(
    policy_id: int,
    authorization_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> None:
    """Remove a prior authorization."""
    policy = billing_policy(access, policy_id)
    authorization = _authorization(policy, authorization_id)
    policy.authorizations.remove(authorization)
    audit_staff(
        db,
        request,
        access.staff,
        "authorization.delete",
        "prior_authorization",
        authorization_id,
        client_id=policy.client_id,
    )
    db.commit()


# Eligibility ------------------------------------------------------------------------------


@router.post(
    "/policies/{policy_id}/eligibility",
    response_model=EligibilityCheckOut,
    status_code=status.HTTP_201_CREATED,
)
def run_eligibility_check(
    policy_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> EligibilityCheck:
    """Ask the payer about the client's coverage and mental-health benefits now.

    Payer answers (active, inactive or with errors to review) and clearinghouse failures are
    both stored and returned; missing setup (payer ID, member ID, NPI) is a 422.
    """
    policy = billing_policy(access, policy_id)
    claims_stedi.require_stedi()
    practice = access.staff.practice
    try:
        eligibility = eligibility_request(
            policy, practice, access.staff, local_date(utcnow(), zone_of(practice))
        )
    except EligibilityUnavailable as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    check = check_eligibility(db, policy, eligibility, access.staff.id)
    audit_staff(
        db,
        request,
        access.staff,
        "eligibility.check",
        "eligibility_check",
        check.id,
        client_id=policy.client_id,
    )
    db.commit()
    return check


@router.get("/policies/{policy_id}/eligibility", response_model=list[EligibilityCheckOut])
def list_eligibility_checks(
    policy_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[EligibilityCheck]:
    """The policy's eligibility checks, newest first."""
    policy = billing_policy(access, policy_id)
    checks = list(
        db.scalars(
            select(EligibilityCheck)
            .where(EligibilityCheck.policy_id == policy.id)
            .order_by(EligibilityCheck.created_at.desc(), EligibilityCheck.id.desc())
        )
    )
    audit_staff(
        db,
        request,
        access.staff,
        "eligibility.list",
        "insurance_policy",
        policy.id,
        client_id=policy.client_id,
    )
    db.commit()
    return checks
