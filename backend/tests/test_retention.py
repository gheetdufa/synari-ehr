"""Records retention: the practice setting and the report of archived clients kept past it."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Client, Note
from synari.models.enums import ClientStatus, StaffRole
from synari.services.request_deadlines import practice_today
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    create_client_record,
)
from tests.records_helpers import audit_events


def _archived(db: Session, staff: StaffAccount, email: str, **fields: object) -> Client:
    return create_client_record(db, staff, email=email, status=ClientStatus.ARCHIVED, **fields)


def _backdate(db: Session, client: Client, years: int) -> None:
    client.created_at = utcnow() - timedelta(days=365 * years + 10)
    db.commit()


def test_retention_setting(api: TestClient, clinician: StaffAccount) -> None:
    settings = api.get("/api/practice/settings", headers=clinician.headers).json()
    assert settings["record_retention_years"] == 7
    for years, expected in ((5, 422), (101, 422), (10, 200)):
        response = api.patch(
            "/api/practice/settings",
            json={"record_retention_years": years},
            headers=clinician.headers,
        )
        assert response.status_code == expected, years
    assert (
        api.get("/api/practice/settings", headers=clinician.headers).json()[
            "record_retention_years"
        ]
        == 10
    )


def test_report_lists_archived_clients_past_retention(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    long_gone = _archived(db, clinician, "gone@example.com", first_name="Gone")
    _backdate(db, long_gone, 10)
    create_appointment(db, clinician, [long_gone], starts_at=datetime(2017, 3, 1, 15, tzinfo=UTC))

    recent_session = _archived(db, clinician, "recent@example.com", first_name="Recent")
    _backdate(db, recent_session, 9)
    create_appointment(db, clinician, [recent_session], starts_at=utcnow() - timedelta(days=400))

    recent_note = _archived(db, clinician, "noted@example.com", first_name="Noted")
    _backdate(db, recent_note, 9)
    db.add(
        Note(
            practice_id=recent_note.practice_id,
            author_id=clinician.id,
            client_id=recent_note.id,
            format="FREEFORM",
        )
    )
    db.commit()

    still_active = create_client_record(db, clinician, email="active@example.com")
    _backdate(db, still_active, 9)

    report = api.get("/api/practice/retention-report", headers=clinician.headers)
    assert report.status_code == 200, report.text
    rows = report.json()
    assert [row["client"]["id"] for row in rows] == [long_gone.id]
    row = rows[0]
    assert row["status"] == "archived"
    assert row["last_activity_at"].startswith("2017-03-01")
    assert row["retention_ends_on"] == "2024-03-01"
    event = audit_events(db, "retention.report_view")[0]
    assert event.client_id == long_gone.id

    # A longer retention period keeps everyone.
    api.patch(
        "/api/practice/settings", json={"record_retention_years": 20}, headers=clinician.headers
    )
    assert api.get("/api/practice/retention-report", headers=clinician.headers).json() == []


def test_client_without_activity_counts_from_when_they_were_added(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    client = _archived(db, clinician, "old@example.com")
    _backdate(db, client, 8)
    rows = api.get("/api/practice/retention-report", headers=clinician.headers).json()
    assert [row["client"]["id"] for row in rows] == [client.id]
    today = practice_today(client.practice, utcnow())
    assert rows[0]["retention_ends_on"] < today.isoformat()


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (StaffRole.PRACTICE_MANAGER, 200),
        (StaffRole.CLINICIAN, 403),
        (StaffRole.BILLER, 403),
        (StaffRole.SCHEDULER, 403),
    ],
)
def test_report_needs_practice_management(
    api: TestClient, db: Session, clinician: StaffAccount, role: StaffRole, expected: int
) -> None:
    member = add_staff(db, clinician.practice_id, "member@example.com", role)
    response = api.get("/api/practice/retention-report", headers=member.headers)
    assert response.status_code == expected
