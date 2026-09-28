"""Shared setup for the insurance, claims and remittance tests. All ids and people are fictional."""

import json
from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy.orm import Session

from synari.claims.stedi import StediClient
from synari.config import settings
from synari.db import utcnow
from synari.models import (
    AppointmentParticipant,
    Client,
    InsurancePolicy,
    Payer,
    Practice,
    StaffMember,
)
from synari.models.enums import BillingProviderType, BillingType
from synari.services import claims_stedi
from tests.conftest import StaffAccount, create_appointment, create_client_record

GROUP_NPI = "1111111112"
CLINICIAN_NPI = "1234567893"
SUPERVISEE_NPI = "1222222220"
SUPERVISOR_NPI = "1333333338"

Handler = Callable[[httpx.Request], httpx.Response]


def configure_practice(
    db: Session, staff: StaffAccount, *, organization: bool = False, **fields: Any
) -> Practice:
    """Give the practice and its owner-clinician everything a claim needs."""
    practice = db.get_one(Practice, staff.practice_id)
    values: dict[str, Any] = {
        "name": "Lee Counseling",
        "phone": "503-555-0111",
        "address_line1": "200 Main St",
        "city": "Portland",
        "state": "OR",
        "postal_code": "97205-1234",
        "tax_id": "98-7654321",
        "tax_id_type": "EIN",
        "npi": GROUP_NPI,
        "taxonomy_code": "261QM0801X",
        "billing_provider": BillingProviderType.ORGANIZATION
        if organization
        else BillingProviderType.INDIVIDUAL,
        **fields,
    }
    for field, value in values.items():
        setattr(practice, field, value)
    clinician = db.get_one(StaffMember, staff.id)
    clinician.npi = CLINICIAN_NPI
    clinician.taxonomy_code = "1041C0700X"
    clinician.credentials = "LCSW"
    db.commit()
    return practice


def add_payer(
    db: Session, practice_id: int, name: str = "Evergreen Health Plan", external_id: str = "EVRGN"
) -> Payer:
    """A payer on the practice's list."""
    payer = Payer(practice_id=practice_id, name=name, external_id=external_id)
    db.add(payer)
    db.commit()
    return payer


def insured_client(
    db: Session,
    staff: StaffAccount,
    payer: Payer,
    *,
    email: str = "alex@example.com",
    rank: str = "primary",
    **policy_fields: Any,
) -> Client:
    """An insurance-billed client (the subscriber on their own policy) with two diagnoses."""
    client = create_client_record(
        db,
        staff,
        email=email,
        date_of_birth=date(1990, 4, 12),
        sex="female",
        address_line1="15 Oak Ave",
        city="Portland",
        state="OR",
        postal_code="97209",
        billing_type=BillingType.INSURANCE,
        diagnosis_codes=[
            {"code": "F41.1", "description": "Generalized anxiety disorder"},
            {"code": "F33.1", "description": "Major depressive disorder, recurrent"},
        ],
    )
    add_policy(db, client, payer, rank=rank, **policy_fields)
    return client


def add_policy(
    db: Session, client: Client, payer: Payer, *, rank: str = "primary", **fields: Any
) -> InsurancePolicy:
    """A policy for `client` with `payer` (the client is the subscriber unless overridden)."""
    values: dict[str, Any] = {"member_id": "EVG123456789", "group_number": "GRP100", **fields}
    policy = InsurancePolicy(client_id=client.id, payer_id=payer.id, rank=rank, **values)
    db.add(policy)
    db.commit()
    db.refresh(client)
    return policy


def session_at(days_ago: int, hour: int = 15) -> datetime:
    """A past start time, mid-afternoon UTC (the same date in US time zones)."""
    day = utcnow().date() - timedelta(days=days_ago)
    return datetime.combine(day, time(hour), tzinfo=utcnow().tzinfo)


def attended_session(
    db: Session,
    staff: StaffAccount,
    clients: list[Client],
    *,
    days_ago: int = 3,
    fee_cents: int = 15000,
    **fields: Any,
) -> list[AppointmentParticipant]:
    """An attended 90837 session in the past; returns its participants."""
    values: dict[str, Any] = {
        "status": "attended",
        "service_code": "90837",
        "service_description": "Psychotherapy, 60 minutes",
        **fields,
    }
    appointment = create_appointment(
        db, staff, clients, starts_at=session_at(days_ago), fee_cents=fee_cents, **values
    )
    return list(appointment.participants)


@pytest.fixture(autouse=True)
def no_clearinghouse(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests start without Stedi, whatever the developer's .env says."""
    monkeypatch.setattr(settings, "stedi_api_key", "")
    monkeypatch.setattr(settings, "stedi_usage", "T")


def use_stedi(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> list[httpx.Request]:
    """Turn Stedi on with every request answered by `handler`; returns the requests made."""
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    def factory() -> StediClient:
        transport = httpx.MockTransport(record)
        return StediClient("test-key", client=httpx.Client(transport=transport))

    monkeypatch.setattr(settings, "stedi_api_key", "test-key")
    monkeypatch.setattr(claims_stedi, "stedi_client", factory)
    return requests


def json_body(request: httpx.Request) -> dict[str, Any]:
    """The JSON a mocked Stedi request sent."""
    return json.loads(request.content)
