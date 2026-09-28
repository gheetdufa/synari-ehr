"""The security events feed: recording and alerting, the API for owners and managers, inline
events (exports, role changes) and the unusual-access detector."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import AuditEvent, Notification, RateLimitBucket, SecurityEvent
from synari.models.enums import ClinicianAccess, Role, SecuritySeverity, StaffRole
from synari.ratelimit import hit, purge_rate_limit_buckets
from synari.services.security_events import (
    CLIENT_EXPORTED,
    ROLE_CHANGED,
    UNUSUAL_ACCESS_VOLUME,
    detect_security_events,
    record_security_event,
)
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    outbound_to,
    register_practice,
)


def _events(db: Session, kind: str | None = None) -> list[SecurityEvent]:
    db.expire_all()
    query = select(SecurityEvent).order_by(SecurityEvent.id)
    if kind is not None:
        query = query.where(SecurityEvent.kind == kind)
    return list(db.scalars(query))


def test_warnings_alert_security_reviewers_without_details(
    clinician: StaffAccount, db: Session
) -> None:
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    biller = add_staff(db, clinician.practice_id, "bill@example.com", StaffRole.BILLER)
    record_security_event(
        db,
        practice_id=clinician.practice_id,
        kind="test.info",
        severity=SecuritySeverity.INFO,
    )
    db.commit()
    assert outbound_to(db, clinician.email) == []

    record_security_event(
        db,
        practice_id=clinician.practice_id,
        kind="backup.stale",
        severity=SecuritySeverity.CRITICAL,
        detail={"hours_since_backup": 30},
    )
    db.commit()
    for reviewer in (clinician, manager):
        [email] = outbound_to(db, reviewer.email)
        assert email.subject == "Security alert: Backup: stale"
        assert "30" not in email.body_text
    assert outbound_to(db, biller.email) == []
    alerts = db.query(Notification).filter_by(kind="security_event").all()
    assert {(n.recipient_id, n.urgent) for n in alerts} == {
        (clinician.id, True),
        (manager.id, True),
    }


def test_server_wide_events_go_to_the_operator(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "security_alert_email", "ops@example.com")
    record_security_event(
        db, practice_id=None, kind="audit.verification_failed", severity=SecuritySeverity.CRITICAL
    )
    db.commit()
    [email] = outbound_to(db, "ops@example.com")
    assert "Activity log integrity check failed" in email.subject
    # The only practice on the server runs it, so its owner hears about it and sees it.
    assert len(outbound_to(db, clinician.email)) == 1
    [event] = _events(db, "audit.verification_failed")
    listed = api.get("/api/practice/security-events", headers=clinician.headers).json()
    assert [e["id"] for e in listed] == [event.id]


def test_server_events_stay_with_the_operator_when_practices_share_a_server(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "security_alert_email", "ops@example.com")
    other = register_practice(api, email="other@example.com")
    record_security_event(
        db, practice_id=None, kind="backup.failed", severity=SecuritySeverity.CRITICAL
    )
    db.commit()
    assert len(outbound_to(db, "ops@example.com")) == 1
    for account in (clinician, other):
        assert outbound_to(db, account.email) == []
        listed = api.get("/api/practice/security-events", headers=account.headers).json()
        assert listed == []


@pytest.mark.parametrize(
    ("role", "access_level", "allowed"),
    [
        (StaffRole.OWNER, ClinicianAccess.BASIC, True),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, True),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, True),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, False),
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, False),
        (StaffRole.BILLER, ClinicianAccess.BASIC, False),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, False),
    ],
)
def test_who_sees_the_security_feed(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    access_level: ClinicianAccess,
    allowed: bool,
) -> None:
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=access_level
    )
    event = record_security_event(
        db, practice_id=clinician.practice_id, kind="test.info", severity=SecuritySeverity.INFO
    )
    db.commit()
    listed = api.get("/api/practice/security-events", headers=member.headers)
    acknowledged = api.post(
        f"/api/practice/security-events/{event.id}/acknowledge", headers=member.headers
    )
    expected = 200 if allowed else 403
    assert (listed.status_code, acknowledged.status_code) == (expected, expected)


def test_security_feed_filters_and_acknowledgement(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    other = register_practice(api, email="other@example.com")
    member = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    info = record_security_event(
        db,
        practice_id=clinician.practice_id,
        kind="auth.new_device",
        severity=SecuritySeverity.INFO,
        staff_id=member.id,
        detail={"session_id": "abc"},
    )
    warning = record_security_event(
        db, practice_id=clinician.practice_id, kind="mfa.reset", severity=SecuritySeverity.WARNING
    )
    server = record_security_event(
        db, practice_id=None, kind="backup.completed", severity=SecuritySeverity.INFO
    )
    theirs = record_security_event(
        db, practice_id=other.practice_id, kind="mfa.reset", severity=SecuritySeverity.WARNING
    )
    db.commit()

    listed = api.get("/api/practice/security-events", headers=clinician.headers).json()
    # Two practices share this server, so its own events go to the operator, not to them.
    assert [e["id"] for e in listed] == [warning.id, info.id]
    newest_device = listed[1]
    assert newest_device["label"] == "Sign-in from a new device"
    assert newest_device["staff_name"] == "Sam Patel"
    assert newest_device["detail"] == {"session_id": "abc"}
    warnings = api.get(
        "/api/practice/security-events", params={"severity": "warning"}, headers=clinician.headers
    ).json()
    assert [e["id"] for e in warnings] == [warning.id]
    older = api.get(
        "/api/practice/security-events", params={"before_id": warning.id}, headers=clinician.headers
    ).json()
    assert [e["id"] for e in older] == [info.id]

    acknowledged = api.post(
        f"/api/practice/security-events/{warning.id}/acknowledge", headers=clinician.headers
    )
    assert acknowledged.status_code == 200
    assert acknowledged.json()["acknowledged_by_name"] == "Jordan Lee"
    assert acknowledged.json()["acknowledged_at"] is not None
    pending = api.get(
        "/api/practice/security-events", params={"unacknowledged": True}, headers=clinician.headers
    ).json()
    assert [e["id"] for e in pending] == [info.id]
    for foreign in (theirs, server):
        response = api.post(
            f"/api/practice/security-events/{foreign.id}/acknowledge", headers=clinician.headers
        )
        assert response.status_code == 404


def test_exports_and_role_changes_are_recorded(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    exported = api.post(
        f"/api/clients/{client.id}/export", json={"purpose": "treatment"}, headers=clinician.headers
    )
    assert exported.status_code == 200
    [export] = _events(db, CLIENT_EXPORTED)
    assert (export.severity, export.staff_id) == ("info", clinician.id)
    assert export.detail == {"client_id": client.id, "purpose": "treatment", "billing": True}

    member = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    api.patch(f"/api/team/{member.id}", json={"credentials": "LCSW"}, headers=clinician.headers)
    assert _events(db, ROLE_CHANGED) == []
    api.patch(
        f"/api/team/{member.id}", json={"clinician_access": "billing"}, headers=clinician.headers
    )
    api.patch(f"/api/team/{member.id}", json={"role": "owner"}, headers=clinician.headers)
    minor, promotion = _events(db, ROLE_CHANGED)
    assert minor.severity == "info"
    assert minor.detail["before"]["clinician_access"] == "basic"
    assert minor.detail["after"]["clinician_access"] == "billing"
    assert promotion.severity == "warning"
    assert promotion.detail["after"]["role"] == "owner"
    assert promotion.detail["changed_by_staff_id"] == clinician.id


def _open_clients(db: Session, practice_id: int, staff_id: int, count: int, minutes_ago: int):
    for client_id in range(1, count + 1):
        db.add(
            AuditEvent(
                practice_id=practice_id,
                client_id=client_id,
                actor_role=Role.STAFF,
                actor_id=staff_id,
                action="client.view",
                created_at=utcnow() - timedelta(minutes=minutes_ago),
            )
        )
    db.commit()


def test_detector_flags_unusually_many_clients_in_an_hour(
    clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "security_alert_clients_per_hour", 5)
    member = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    _open_clients(db, clinician.practice_id, clinician.id, 5, minutes_ago=10)
    _open_clients(db, clinician.practice_id, member.id, 8, minutes_ago=90)
    detect_security_events(db, utcnow())
    assert _events(db, UNUSUAL_ACCESS_VOLUME) == []

    _open_clients(db, clinician.practice_id, member.id, 6, minutes_ago=10)
    detect_security_events(db, utcnow())
    detect_security_events(db, utcnow())
    [event] = _events(db, UNUSUAL_ACCESS_VOLUME)
    assert (event.staff_id, event.severity) == (member.id, "warning")
    assert event.detail == {"distinct_clients": 6, "window_minutes": 60}
    [alert] = outbound_to(db, clinician.email)
    assert alert.subject == "Security alert: Unusually many client records opened"


def test_rate_limit_keys_are_hashed_and_purged(db: Session) -> None:
    assert hit("test", "ip:198.51.100.7", 60) == 1
    assert hit("test", "ip:198.51.100.7", 60) == 2
    bucket = db.scalar(select(RateLimitBucket))
    assert "198.51.100.7" not in bucket.key and len(bucket.key) == 64
    purge_rate_limit_buckets(db, utcnow() + timedelta(days=2))
    assert db.scalar(select(RateLimitBucket)) is None
