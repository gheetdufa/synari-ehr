"""Test harness: a throwaway Postgres database per test run, migrated with Alembic.

Requires a Postgres server (`docker compose up -d db`). Override the admin connection with
TEST_DATABASE_ADMIN_URL if yours differs.
"""

import os
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import psycopg
import pytest

_ADMIN_URL = os.environ.get(
    "TEST_DATABASE_ADMIN_URL", "postgresql://synari:synari@localhost:5432/postgres"
)
_TEST_DB = f"synari_test_{secrets.token_hex(4)}"
_TEST_URL = _ADMIN_URL.rsplit("/", 1)[0] + f"/{_TEST_DB}"

os.environ.update(
    {
        "ENVIRONMENT": "test",
        "SECRET_KEY": secrets.token_hex(32),
        "DATABASE_URL": _TEST_URL,
        "FRONTEND_URL": "http://app.test",
        "SMTP_HOST": "",
        "TWILIO_ACCOUNT_SID": "",
        "STRIPE_SECRET_KEY": "",
        "OPENAI_API_KEY": "",
        "LIVEKIT_URL": "ws://livekit.test",
        "LIVEKIT_API_KEY": "test-key",
        "LIVEKIT_API_SECRET": "test-secret-that-is-long-enough-for-hmac",
        "RUN_WORKER_IN_API": "false",
        # Most tests act as staff without 2FA; tests of the requirement turn this back on.
        "REQUIRE_STAFF_MFA": "false",
        "PASSWORD_BREACH_CHECK": "false",
    }
)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from synari import ratelimit  # noqa: E402
from synari.db import Base, SessionLocal, engine, utcnow  # noqa: E402
from synari.main import app  # noqa: E402
from synari.models import (  # noqa: E402
    Appointment,
    AppointmentParticipant,
    Client,
    ClientClinician,
    ClientContact,
    OutboundMessage,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, StaffRole  # noqa: E402
from synari.ratelimit import reset_all_limits  # noqa: E402
from synari.services.sessions import start_portal_session, start_staff_session  # noqa: E402


def _offset_practice_ids() -> None:
    # Practice ids start far from staff and client ids, so code that mixes them up fails.
    with engine.begin() as connection:
        connection.execute(text("ALTER SEQUENCE practices_id_seq RESTART WITH 501"))


@pytest.fixture(scope="session", autouse=True)
def _database() -> Iterator[None]:
    with psycopg.connect(_ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{_TEST_DB}"')
    config = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    command.upgrade(config, "head")
    _offset_practice_ids()
    yield
    engine.dispose()
    with psycopg.connect(_ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{_TEST_DB}" WITH (FORCE)')


@pytest.fixture
def steady_rate_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rate-limit windows follow the wall clock: pin it, so a test counting requests up to a
    limit can't have them split across two windows."""
    now = ratelimit.utcnow()
    monkeypatch.setattr(ratelimit, "utcnow", lambda: now)


@pytest.fixture(autouse=True)
def _clean_tables() -> Iterator[None]:
    reset_all_limits()
    yield
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with engine.begin() as connection:
        # Test-only: the audit tables refuse TRUNCATE (migration ..._audit_log_append_only).
        # Replica mode skips user triggers for this cleanup transaction only; it needs a
        # superuser, which the docker Postgres role is. Production code never does this.
        connection.execute(text("SET LOCAL session_replication_role = replica"))
        connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    _offset_practice_ids()


@pytest.fixture
def api() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


@dataclass
class StaffAccount:
    id: int
    practice_id: int
    email: str
    headers: dict[str, str]
    data: dict[str, Any]


def register_practice(
    api: TestClient, email: str = "jordan@example.com", **overrides: Any
) -> StaffAccount:
    """Register a new practice through the API; returns its owner (a clinician by default)."""
    body = {
        "email": email,
        "password": "correct horse battery",
        "first_name": "Jordan",
        "last_name": "Lee",
        "practice_name": "Lee Counseling",
        "time_zone": "America/New_York",
        **overrides,
    }
    response = api.post("/api/auth/register", json=body)
    assert response.status_code == 201, response.text
    data = response.json()
    return StaffAccount(
        id=data["staff"]["id"],
        practice_id=data["practice"]["id"],
        email=email,
        headers={"Authorization": f"Bearer {data['access_token']}"},
        data=data,
    )


@pytest.fixture
def clinician(api: TestClient) -> StaffAccount:
    """The owner of a new solo practice, who is also its clinician (the single-therapist case)."""
    return register_practice(api)


def add_staff(
    db: Session,
    practice_id: int,
    email: str,
    role: StaffRole,
    *,
    clinician_access: ClinicianAccess = ClinicianAccess.BASIC,
    is_clinician: bool | None = None,
    supervisor_id: int | None = None,
    first_name: str = "Sam",
    last_name: str = "Patel",
) -> StaffAccount:
    """Add an active team member directly (skipping the invitation email) with a session."""
    member = StaffMember(
        practice_id=practice_id,
        email=email,
        first_name=first_name,
        last_name=last_name,
        role=role,
        clinician_access=clinician_access,
        is_clinician=role == StaffRole.CLINICIAN if is_clinician is None else is_clinician,
        supervisor_id=supervisor_id,
    )
    db.add(member)
    db.flush()
    return StaffAccount(
        id=member.id,
        practice_id=practice_id,
        email=email,
        headers=staff_headers(db, member),
        data={},
    )


def staff_headers(db: Session, member: StaffMember) -> dict[str, str]:
    """Headers for a new signed-in session of `member` (commits)."""
    tokens = start_staff_session(db, member, None)
    db.commit()
    return {"Authorization": f"Bearer {tokens.access_token}"}


def assign_clinician(
    db: Session, client: Client, staff: StaffAccount, *, primary: bool = False
) -> None:
    """Put a clinician on a client's care team."""
    db.add(ClientClinician(client_id=client.id, staff_id=staff.id, is_primary=primary))
    db.commit()
    db.refresh(client)


def create_client_record(db: Session, staff: StaffAccount, **fields: Any) -> Client:
    """A client in `staff`'s practice, with `staff` as primary clinician when they are one."""
    values: dict[str, Any] = {
        "first_name": "Alex",
        "last_name": "Rivera",
        "email": "alex@example.com",
        "phone": "555-201-3344",
        **fields,
    }
    client = Client(practice_id=staff.practice_id, **values)
    db.add(client)
    db.flush()
    member = db.get(StaffMember, staff.id)
    if member is not None and member.is_clinician:
        db.add(ClientClinician(client_id=client.id, staff_id=staff.id, is_primary=True))
    db.commit()
    db.refresh(client)
    return client


def create_appointment(
    db: Session,
    clinician: StaffAccount,
    clients: list[Client],
    *,
    starts_at: datetime | None = None,
    minutes: int = 50,
    fee_cents: int = 15000,
    **fields: Any,
) -> Appointment:
    """A session on `clinician`'s calendar with each client as a billable participant."""
    start = starts_at or (utcnow() + timedelta(days=1)).replace(microsecond=0)
    appointment = Appointment(
        practice_id=clinician.practice_id,
        clinician_id=clinician.id,
        starts_at=start,
        ends_at=start + timedelta(minutes=minutes),
        participants=[
            AppointmentParticipant(client_id=client.id, fee_cents=fee_cents) for client in clients
        ],
        **fields,
    )
    db.add(appointment)
    db.commit()
    db.refresh(appointment)
    return appointment


def portal_headers(client: Client, contact: ClientContact | None = None) -> dict[str, str]:
    """Headers for a new portal session of `client`, or of `contact` acting for `client`."""
    version = client.portal_token_version if contact is None else contact.portal_token_version
    with SessionLocal() as db:
        tokens = start_portal_session(
            db, client, contact.id if contact is not None else None, version, None
        )
        db.commit()
    return {"Authorization": f"Bearer {tokens.access_token}"}


def outbound_to(db: Session, address: str) -> list[OutboundMessage]:
    db.expire_all()
    return list(
        db.query(OutboundMessage)
        .filter(OutboundMessage.to_address == address)
        .order_by(OutboundMessage.id)
    )


def link_token(body: str) -> str:
    """Pull the `token` query parameter out of the first sign-in link in an email body."""
    marker = "token="
    start = body.index(marker) + len(marker)
    end = start
    while end < len(body) and body[end] not in '&\n" ':
        end += 1
    return body[start:end]
