"""Shared setup for the good faith estimate tests. All people and ids are fictional."""

import re
import zlib
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Client, GoodFaithEstimate, Notification, Practice, Service, StaffMember
from synari.models.enums import Role
from tests.conftest import StaffAccount, create_client_record

NY = ZoneInfo("America/New_York")


def today() -> date:
    return utcnow().astimezone(NY).date()


def at(day: date, hour: int = 10) -> datetime:
    return datetime.combine(day, time(hour), tzinfo=NY)


def ready_practice(db: Session, account: StaffAccount) -> None:
    """Give the practice and clinician what an estimate must print."""
    practice = db.get_one(Practice, account.practice_id)
    practice.address_line1 = "12 Oak Street"
    practice.city = "Springfield"
    practice.state = "IL"
    practice.postal_code = "62701"
    practice.phone = "555-100-2000"
    practice.tax_id = "12-3456789"
    member = db.get_one(StaffMember, account.id)
    member.npi = "1234567893"
    member.credentials = "LCSW"
    member.license_state = "IL"
    db.commit()


@pytest.fixture(name="practice")
def practice_fixture(clinician: StaffAccount, db: Session) -> StaffAccount:
    """A solo practice (owner-clinician) ready to issue estimates."""
    ready_practice(db, clinician)
    return clinician


def self_pay_client(db: Session, account: StaffAccount, **fields: Any) -> Client:
    values: dict[str, Any] = {"date_of_birth": date(1990, 4, 2), **fields}
    return create_client_record(db, account, **values)


def add_service(
    db: Session,
    account: StaffAccount,
    code: str = "90834",
    rate_cents: int = 15000,
    description: str = "Psychotherapy, 45 minutes",
) -> Service:
    service = Service(
        practice_id=account.practice_id,
        code=code,
        description=description,
        duration_minutes=45,
        rate_cents=rate_cents,
    )
    db.add(service)
    db.commit()
    return service


def item(**overrides: Any) -> dict[str, Any]:
    return {
        "description": "Psychotherapy, 45 minutes",
        "service_code": "90834",
        "unit_fee_cents": 15000,
        "quantity": 10,
        "frequency": "Weekly",
        "location": "Telehealth (video)",
        "diagnosis_pointers": ["A"],
        **overrides,
    }


def draft_body(clinician_id: int, **overrides: Any) -> dict[str, Any]:
    start = overrides.pop("period_start", today())
    end = overrides.pop("period_end", start + timedelta(days=300))
    return {
        "clinician_id": clinician_id,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "primary_service": "Individual psychotherapy (90834)",
        "diagnosis_codes": [{"code": "F41.1", "description": "Generalized anxiety disorder"}],
        "items": [item()],
        **overrides,
    }


def create_draft(
    api: TestClient, account: StaffAccount, client_id: int, **overrides: Any
) -> dict[str, Any]:
    clinician_id = overrides.pop("clinician_id", account.id)
    response = api.post(
        f"/api/clients/{client_id}/estimates",
        json=draft_body(clinician_id, **overrides),
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def issue(
    api: TestClient, account: StaffAccount, estimate_id: int, method: str = "portal"
) -> dict[str, Any]:
    response = api.post(
        f"/api/estimates/{estimate_id}/issue",
        json={"delivery_method": method},
        headers=account.headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def issued(api: TestClient, account: StaffAccount, client_id: int, **overrides: Any) -> dict:
    return issue(api, account, create_draft(api, account, client_id, **overrides)["id"])


def estimates_of(db: Session, client_id: int) -> list[GoodFaithEstimate]:
    db.expire_all()
    return list(
        db.scalars(
            select(GoodFaithEstimate)
            .where(GoodFaithEstimate.client_id == client_id)
            .order_by(GoodFaithEstimate.id)
        )
    )


def drafts_of(db: Session, client_id: int) -> list[GoodFaithEstimate]:
    return [e for e in estimates_of(db, client_id) if e.status == "draft"]


def notifications(db: Session, recipient_id: int, kind: str, role: Role = Role.STAFF) -> list:
    db.expire_all()
    return list(
        db.scalars(
            select(Notification)
            .where(
                Notification.recipient_role == role,
                Notification.recipient_id == recipient_id,
                Notification.kind == kind,
            )
            .order_by(Notification.id)
        )
    )


def pdf_text(data: bytes) -> str:
    """The text drawn in a PDF, one space between drawn strings (so wrapped lines rejoin)."""
    parts = []
    for chunk in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            parts.append(zlib.decompress(chunk).decode("latin-1"))
        except zlib.error:
            parts.append(chunk.decode("latin-1"))
    drawn = re.findall(r"\(((?:\\.|[^\\)])*)\)\s*Tj", "\n".join(parts))
    text = " ".join(re.sub(r"\\([()\\])", r"\1", piece) for piece in drawn)
    return re.sub(r"\s+", " ", text)


def book(
    api: TestClient,
    account: StaffAccount,
    client: Client,
    service: Service,
    day: date,
    **extra: Any,
) -> list[dict[str, Any]]:
    """Book through the API, as staff do, so scheduling hooks run."""
    response = api.post(
        "/api/appointments",
        json={
            "clinician_id": account.id,
            "participants": [{"client_id": client.id}],
            "service_id": service.id,
            "starts_at": at(day).isoformat(),
            "location_type": "video",
            "notify_client": False,
            "allow_conflicts": True,
            **extra,
        },
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()
