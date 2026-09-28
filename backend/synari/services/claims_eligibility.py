"""Insurance eligibility checks (270/271 through Stedi), on demand and automatically.

A check asks the payer about the client's coverage and mental-health cost sharing and stores
an EligibilityCheck: active, inactive, review (the payer answered with errors, such as
"subscriber not found") or error (the check couldn't be run). Practices with automatic checks
re-check active insurance clients monthly and whenever a policy is added or changed.
"""

import logging
from datetime import date, datetime, timedelta

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from synari.claims.document import PersonName
from synari.claims.stedi import ClearinghouseError, EligibilityRequest, EligibilityResult
from synari.config import settings
from synari.models import (
    Client,
    EligibilityCheck,
    InsurancePolicy,
    Payer,
    Practice,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import (
    BillingProviderType,
    BillingType,
    ClientStatus,
    EligibilityStatus,
)
from synari.schemas.insurance import EligibilitySummary
from synari.services import claims_stedi
from synari.services.billing import local_date
from synari.services.claims_document import SELF, billing_provider, policy_active_on
from synari.services.scheduling import zone_of

logger = logging.getLogger(__name__)

RECHECK_AFTER = timedelta(days=30)
RETRY_ERRORS_AFTER = timedelta(days=1)
MAX_AUTO_CHECKS_PER_RUN = 20


class EligibilityUnavailable(Exception):
    """The records lack something a check needs (payer ID, NPI). The message says what."""


def eligibility_clinician(client: Client, staff: StaffMember | None) -> StaffMember | None:
    """Whose NPI asks for an individually billing practice: the primary clinician, else `staff`."""
    for candidate in (client.primary_clinician, staff):
        if candidate is not None and candidate.is_clinician and candidate.npi.strip():
            return candidate
    return None


def eligibility_request(
    policy: InsurancePolicy, practice: Practice, staff: StaffMember | None, today: date
) -> EligibilityRequest:
    """The 270 question for this policy, asking about mental-health benefits today."""
    client = policy.client
    payer = policy.payer
    if not payer.external_id.strip():
        raise EligibilityUnavailable(f"Add {payer.name}'s payer ID in the payer list first.")
    if not policy.member_id.strip():
        raise EligibilityUnavailable("Add the member ID to the policy first.")
    if practice.billing_provider == BillingProviderType.ORGANIZATION:
        if not practice.npi.strip():
            raise EligibilityUnavailable("Add the practice's group NPI first.")
        provider = billing_provider(practice, None)
    else:
        clinician = eligibility_clinician(client, staff)
        if clinician is None:
            raise EligibilityUnavailable("Add an NPI to the client's clinician's profile first.")
        provider = billing_provider(practice, clinician)
    dependent = policy.subscriber_relationship != SELF
    subscriber = (
        (policy.subscriber_first_name, policy.subscriber_last_name)
        if dependent
        else (client.first_name, client.last_name)
    )
    return EligibilityRequest(
        payer_id=payer.external_id.strip(),
        provider=provider,
        member_id=policy.member_id.strip(),
        subscriber=PersonName(first=subscriber[0].strip(), last=subscriber[1].strip()),
        subscriber_birth_date=policy.subscriber_dob if dependent else client.date_of_birth,
        dependent=PersonName(first=client.first_name.strip(), last=client.last_name.strip())
        if dependent
        else None,
        dependent_birth_date=client.date_of_birth if dependent else None,
        dependent_relationship=policy.subscriber_relationship,
        service_date=today,
    )


def _summary(result: EligibilityResult) -> EligibilitySummary:
    return EligibilitySummary(
        check_id=result.check_id,
        plan_name=result.plan_name,
        group_number=result.group_number,
        coverage_start=result.coverage_start,
        coverage_end=result.coverage_end,
        in_network=result.in_network,
        copay_cents=result.copay_cents,
        coinsurance_percent=float(result.coinsurance_percent)
        if result.coinsurance_percent is not None
        else None,
        deductible_cents=result.deductible_cents,
        deductible_remaining_cents=result.deductible_remaining_cents,
        out_of_pocket_cents=result.out_of_pocket_cents,
        out_of_pocket_remaining_cents=result.out_of_pocket_remaining_cents,
        prior_authorization_required=result.prior_authorization_required,
        messages=list(result.messages),
        errors=list(result.errors),
    )


def _status(result: EligibilityResult) -> EligibilityStatus:
    if result.errors:
        return EligibilityStatus.REVIEW
    return EligibilityStatus.ACTIVE if result.active else EligibilityStatus.INACTIVE


def check_eligibility(
    db: Session, policy: InsurancePolicy, request: EligibilityRequest, staff_id: int | None
) -> EligibilityCheck:
    """Run the check with Stedi and store the answer (or why it failed). Caller commits."""
    check = EligibilityCheck(
        practice_id=policy.client.practice_id, policy_id=policy.id, checked_by_id=staff_id
    )
    try:
        with claims_stedi.stedi_client() as stedi:
            result = stedi.check_eligibility(request)
    except ClearinghouseError as exc:
        check.status = EligibilityStatus.ERROR
        check.result = EligibilitySummary().model_dump(mode="json")
        check.error = str(exc)
    else:
        check.status = _status(result)
        check.result = _summary(result).model_dump(mode="json")
        check.error = ""
    db.add(check)
    db.flush()
    return check


def _due_policies(db: Session, now: datetime) -> list[InsurancePolicy]:
    """Policies of active insurance clients, in practices with automatic checks, to re-check."""
    last_answer = (
        select(func.max(EligibilityCheck.created_at))
        .where(
            EligibilityCheck.policy_id == InsurancePolicy.id,
            EligibilityCheck.status != EligibilityStatus.ERROR,
        )
        .correlate(InsurancePolicy)
        .scalar_subquery()
    )
    recent_error = exists().where(
        EligibilityCheck.policy_id == InsurancePolicy.id,
        EligibilityCheck.status == EligibilityStatus.ERROR,
        EligibilityCheck.created_at >= now - RETRY_ERRORS_AFTER,
    )
    policies = db.scalars(
        select(InsurancePolicy)
        .join(Client, Client.id == InsurancePolicy.client_id)
        .join(Payer, Payer.id == InsurancePolicy.payer_id)
        .join(PracticeSettings, PracticeSettings.practice_id == Client.practice_id)
        .where(
            PracticeSettings.eligibility_auto_check,
            Client.status == ClientStatus.ACTIVE,
            Client.billing_type == BillingType.INSURANCE,
            Payer.external_id != "",
            InsurancePolicy.member_id != "",
            last_answer.is_(None)
            | (last_answer < now - RECHECK_AFTER)
            | (InsurancePolicy.updated_at > last_answer),
            ~recent_error,
        )
        .order_by(InsurancePolicy.id)
    ).all()
    return [
        policy
        for policy in policies
        if policy_active_on(policy, local_date(now, zone_of(policy.client.practice)))
    ]


def run_eligibility_checks(db: Session, now: datetime) -> None:
    """Worker job: re-check due policies, a limited number per run."""
    if not settings.stedi_enabled:
        return
    checked = 0
    for policy in _due_policies(db, now):
        if checked == MAX_AUTO_CHECKS_PER_RUN:
            return
        client = policy.client
        today = local_date(now, zone_of(client.practice))
        try:
            request = eligibility_request(policy, client.practice, None, today)
        except EligibilityUnavailable as exc:
            logger.info("Skipping automatic eligibility check for policy %s: %s", policy.id, exc)
            continue
        check_eligibility(db, policy, request, None)
        db.commit()
        checked += 1
