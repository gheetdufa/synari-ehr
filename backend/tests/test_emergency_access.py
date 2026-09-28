"""Emergency ("break-glass") access: who may use it, what it opens and for how long, how it's
audited and announced, and the owners' review queue."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import (
    AuditEvent,
    EmergencyAccessGrant,
    Note,
    Notification,
    SecurityEvent,
)
from synari.models.enums import ClinicianAccess, StaffRole
from synari.services.security_events import EMERGENCY_ACCESS
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    outbound_to,
    register_practice,
)

REASON = "Client called in crisis while their clinician is on leave"


@pytest.fixture
def covering(clinician: StaffAccount, db: Session) -> StaffAccount:
    """A basic clinician who isn't on the client's care team."""
    return add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)


def _break_glass(api: TestClient, headers: dict[str, str], client_id: int, reason: str = REASON):
    return api.post(
        f"/api/clients/{client_id}/emergency-access", json={"reason": reason}, headers=headers
    )


def test_a_clinician_opens_a_chart_in_an_emergency(
    api: TestClient, clinician: StaffAccount, covering: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    db.add(Note(practice_id=client.practice_id, client_id=client.id, author_id=clinician.id))
    db.commit()
    assert api.get(f"/api/clients/{client.id}", headers=covering.headers).status_code == 404
    assert api.get("/api/clients", headers=covering.headers).json() == []

    assert _break_glass(api, covering.headers, client.id, "too short").status_code == 422
    granted = _break_glass(api, covering.headers, client.id)
    assert granted.status_code == 201
    expires = granted.json()["expires_at"]
    assert granted.json()["client_id"] == client.id

    chart = api.get(f"/api/clients/{client.id}", headers=covering.headers)
    assert chart.status_code == 200
    assert chart.json()["access"]["clinical"] is True
    assert chart.json()["access"]["billing"] is False
    assert [c["id"] for c in api.get("/api/clients", headers=covering.headers).json()] == [
        client.id
    ]
    notes = api.get("/api/notes", params={"client_id": client.id}, headers=covering.headers)
    assert len(notes.json()) == 1
    billing = api.get(f"/api/billing/clients/{client.id}/summary", headers=covering.headers)
    assert billing.status_code in (403, 404)
    mine = api.get("/api/me/emergency-access", headers=covering.headers).json()
    assert [(g["client_id"], g["expires_at"]) for g in mine] == [(client.id, expires)]
    # Asking again while the grant lasts isn't needed.
    assert _break_glass(api, covering.headers, client.id).status_code == 409
    # Break-glass is for care, not for taking the record away.
    export = api.post(
        f"/api/clients/{client.id}/export", json={"purpose": "treatment"}, headers=covering.headers
    )
    assert export.status_code == 403

    grant = db.scalar(select(EmergencyAccessGrant))
    assert grant.reason == REASON
    assert timedelta(hours=3, minutes=59) < grant.expires_at - grant.created_at
    views = db.query(AuditEvent).filter_by(action="client.view", actor_id=covering.id).all()
    assert views and all(event.detail == {"emergency": True} for event in views)
    assert all(event.client_id == client.id for event in views)
    opened = db.query(AuditEvent).filter_by(action="client.emergency_access").one()
    assert opened.detail == {"emergency": True} and opened.client_id == client.id


def test_emergency_access_is_announced(api: TestClient, db: Session) -> None:
    owner = register_practice(api, email="owner@example.com", is_clinician=False)
    primary = add_staff(db, owner.practice_id, "primary@example.com", StaffRole.CLINICIAN)
    covering = add_staff(db, owner.practice_id, "cover@example.com", StaffRole.CLINICIAN)
    client = create_client_record(db, primary)
    assert _break_glass(api, covering.headers, client.id).status_code == 201

    [event] = db.scalars(select(SecurityEvent).where(SecurityEvent.kind == EMERGENCY_ACCESS))
    assert (event.severity, event.staff_id) == ("warning", covering.id)
    assert event.detail["client_id"] == client.id
    [owner_email] = outbound_to(db, owner.email)
    assert owner_email.subject == "Security alert: Emergency access to a client record"
    [primary_email] = outbound_to(db, primary.email)
    assert primary_email.subject == "Emergency access to one of your clients' records"
    for email in (owner_email, primary_email):
        assert "Alex" not in email.body_text and "crisis" not in email.body_text
    [note] = db.query(Notification).filter_by(recipient_id=primary.id).all()
    assert note.title == "Sam Patel used emergency access to Alex R.'s chart"
    assert note.link == f"/portal/clients/{client.id}" and note.urgent


@pytest.mark.parametrize(
    ("role", "is_clinician"),
    [
        (StaffRole.BILLER, False),
        (StaffRole.SCHEDULER, False),
        (StaffRole.PRACTICE_MANAGER, False),
    ],
)
def test_only_clinicians_can_break_the_glass(
    api: TestClient, clinician: StaffAccount, db: Session, role: StaffRole, is_clinician: bool
) -> None:
    member = add_staff(db, clinician.practice_id, "m@example.com", role, is_clinician=is_clinician)
    client = create_client_record(db, clinician)
    response = _break_glass(api, member.headers, client.id)
    assert response.status_code == 403
    assert response.json()["detail"] == "Only clinicians can use emergency access"
    assert db.scalar(select(EmergencyAccessGrant)) is None


def test_clinicians_who_already_have_access_or_other_practices_are_refused(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    assert _break_glass(api, clinician.headers, client.id).status_code == 409
    practice_wide = add_staff(
        db,
        clinician.practice_id,
        "full@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.PRACTICE,
    )
    assert _break_glass(api, practice_wide.headers, client.id).status_code == 409
    elsewhere = register_practice(api, email="other@example.com")
    assert _break_glass(api, elsewhere.headers, client.id).status_code == 404


def test_emergency_access_expires(
    api: TestClient, clinician: StaffAccount, covering: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    _break_glass(api, covering.headers, client.id)
    db.execute(update(EmergencyAccessGrant).values(expires_at=utcnow() - timedelta(seconds=1)))
    db.commit()
    assert api.get(f"/api/clients/{client.id}", headers=covering.headers).status_code == 404
    assert api.get("/api/me/emergency-access", headers=covering.headers).json() == []


def test_owners_review_and_end_emergency_access(
    api: TestClient, clinician: StaffAccount, covering: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    grant_id = _break_glass(api, covering.headers, client.id).json()["id"]

    queue = api.get("/api/practice/emergency-access", headers=clinician.headers)
    assert queue.status_code == 200
    [item] = queue.json()
    assert item["reason"] == REASON and item["active"] is True
    assert (item["staff_name"], item["client_name"]) == ("Sam Patel", "Alex Rivera")

    revoked = api.post(
        f"/api/practice/emergency-access/{grant_id}/revoke", headers=clinician.headers
    )
    assert revoked.status_code == 200 and revoked.json()["active"] is False
    assert api.get(f"/api/clients/{client.id}", headers=covering.headers).status_code == 404

    reviewed = api.post(
        f"/api/practice/emergency-access/{grant_id}/review",
        json={"note": "Confirmed with the client's clinician"},
        headers=clinician.headers,
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["reviewed_by_name"] == "Jordan Lee"
    assert api.get("/api/practice/emergency-access", headers=clinician.headers).json() == []
    everything = api.get(
        "/api/practice/emergency-access",
        params={"pending_only": False},
        headers=clinician.headers,
    )
    assert len(everything.json()) == 1
    actions = {e.action for e in db.query(AuditEvent).filter_by(actor_id=clinician.id)}
    assert {
        "emergency_access.list",
        "emergency_access.review",
        "emergency_access.revoke",
    } <= actions


@pytest.mark.parametrize(
    ("role", "access_level"),
    [
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE),
        (StaffRole.BILLER, ClinicianAccess.BASIC),
    ],
)
def test_only_owners_see_the_review_queue(
    api: TestClient,
    clinician: StaffAccount,
    covering: StaffAccount,
    db: Session,
    role: StaffRole,
    access_level: ClinicianAccess,
) -> None:
    client = create_client_record(db, clinician)
    grant_id = _break_glass(api, covering.headers, client.id).json()["id"]
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=access_level
    )
    assert api.get("/api/practice/emergency-access", headers=member.headers).status_code == 403
    for action in ("review", "revoke"):
        response = api.post(
            f"/api/practice/emergency-access/{grant_id}/{action}",
            json={},
            headers=member.headers,
        )
        assert response.status_code == 403
    other_owner = register_practice(api, email="other@example.com")
    response = api.post(
        f"/api/practice/emergency-access/{grant_id}/revoke", headers=other_owner.headers
    )
    assert response.status_code == 404


@pytest.mark.usefixtures("steady_rate_limits")
def test_emergency_access_is_rate_limited(
    api: TestClient, clinician: StaffAccount, covering: StaffAccount, db: Session
) -> None:
    clients = [create_client_record(db, clinician, email=f"c{i}@example.com") for i in range(6)]
    statuses = [_break_glass(api, covering.headers, c.id).status_code for c in clients]
    assert statuses == [201] * 5 + [429]
