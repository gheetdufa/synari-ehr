"""The activity log API: filters and paging, export with the chain head, chain integrity, and a
client's access history (who may see it)."""

import csv
import json
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from synari.db import engine, utcnow
from synari.models import AuditEvent, SecurityEvent
from synari.models.enums import ClinicianAccess, SecuritySeverity, StaffRole
from synari.services.audit_chain import seal_audit_events
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    register_practice,
)


def _log(api: TestClient, account: StaffAccount, **params: Any) -> dict[str, Any]:
    response = api.get("/api/practice/audit-log", params=params, headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_log_filters_by_client_actor_action_and_time_with_cursor_paging(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    first = create_client_record(db, clinician)
    second = create_client_record(db, clinician, email="b@example.com", first_name="Blake")
    assign_clinician(db, second, colleague)
    api.get(f"/api/clients/{first.id}", headers=clinician.headers)
    api.get(f"/api/clients/{second.id}", headers=clinician.headers)
    api.get(f"/api/clients/{second.id}", headers=colleague.headers)

    by_client = _log(api, clinician, client_id=second.id)["events"]
    assert {e["client_id"] for e in by_client} == {second.id}
    assert {e["client_name"] for e in by_client} == {"Blake Rivera"}
    by_actor = _log(api, clinician, actor_id=colleague.id)["events"]
    assert {(e["actor_id"], e["action"]) for e in by_actor} == {(colleague.id, "client.view")}
    by_action = _log(api, clinician, action="client.")["events"]
    assert by_action and all(e["action"].startswith("client.") for e in by_action)
    assert _log(api, clinician, action="client%")["events"] == []  # wildcards are literal
    future = (utcnow() + timedelta(hours=1)).isoformat()
    assert _log(api, clinician, **{"from": future})["events"] == []
    assert len(_log(api, clinician, to=future)["events"]) >= 4

    page = _log(api, clinician, limit=2)
    assert len(page["events"]) == 2
    older = _log(api, clinician, limit=2, cursor=page["next_cursor"])
    assert older["events"][0]["id"] < page["events"][-1]["id"]
    everything = _log(api, clinician, limit=500)
    assert everything["next_cursor"] is None
    assert everything["events"][0]["sealed"] is False


def test_log_needs_view_audit_log_and_viewing_is_audited(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    for role, expected in (
        (StaffRole.CLINICIAN, 403),
        (StaffRole.BILLER, 403),
        (StaffRole.SCHEDULER, 403),
        (StaffRole.PRACTICE_MANAGER, 200),
    ):
        member = add_staff(db, clinician.practice_id, f"{role}@example.com", role)
        assert api.get("/api/practice/audit-log", headers=member.headers).status_code == expected
    practice_wide = add_staff(
        db,
        clinician.practice_id,
        "pw@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.PRACTICE,
    )
    assert api.get("/api/practice/audit-log", headers=practice_wide.headers).status_code == 200

    _log(api, clinician)
    _log(api, clinician)
    views = db.scalars(
        select(AuditEvent).where(
            AuditEvent.action == "audit_log.view", AuditEvent.actor_id == clinician.id
        )
    ).all()
    assert len(views) == 1

    other = register_practice(api, email="other@example.com")
    foreign = _log(api, other)["events"]
    assert all(e["actor_id"] != clinician.id for e in foreign)


def test_export_includes_hashes_chain_head_and_verification(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    api.get(f"/api/clients/{client.id}", headers=clinician.headers)
    seal_audit_events(db, utcnow())

    ndjson = api.get(
        "/api/practice/audit-log/export", params={"format": "ndjson"}, headers=clinician.headers
    )
    assert ndjson.status_code == 200
    assert ndjson.headers["content-type"].startswith("application/x-ndjson")
    assert ".ndjson" in ndjson.headers["content-disposition"]
    lines = [json.loads(line) for line in ndjson.text.splitlines()]
    header, events = lines[0], lines[1:]
    assert header["type"] == "export"
    assert header["chain"]["verified"] is True
    assert header["chain"]["head_event_id"] == events[-1]["id"]
    assert header["chain"]["head_hash"] == events[-1]["hash"]
    assert [e["id"] for e in events] == sorted(e["id"] for e in events)
    assert all(e["type"] == "event" and e["hash"] for e in events)

    exported = api.get(
        "/api/practice/audit-log/export",
        params={"format": "csv", "client_id": client.id},
        headers=clinician.headers,
    )
    body = exported.text
    assert "# verification=passed" in body
    assert f"chain_head_hash={header['chain']['head_hash']}" in body
    rows = list(csv.DictReader(line for line in body.splitlines() if not line.startswith("#")))
    assert rows and {row["client_id"] for row in rows} == {str(client.id)}
    assert {"prev_hash", "hash", "sealed_at"} <= rows[0].keys()

    audited = db.scalars(select(AuditEvent).where(AuditEvent.action == "audit_log.export")).all()
    assert [event.client_id for event in audited] == [None, client.id]
    security = db.scalars(select(SecurityEvent).where(SecurityEvent.kind == "audit_log.exported"))
    assert {event.severity for event in security} == {SecuritySeverity.INFO}


def test_export_limits_and_access(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("synari.api.audit_log.MAX_EXPORT_EVENTS", 1)
    _log(api, clinician)  # a second event after registering
    too_many = api.get("/api/practice/audit-log/export", headers=clinician.headers)
    assert too_many.status_code == 422
    biller = add_staff(db, clinician.practice_id, "b@example.com", StaffRole.BILLER)
    assert api.get("/api/practice/audit-log/export", headers=biller.headers).status_code == 403
    assert api.get("/api/practice/audit-log/integrity", headers=biller.headers).status_code == 403


def test_integrity_endpoint_reports_tampering(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    seal_audit_events(db, utcnow())
    api.get("/api/practice", headers=clinician.headers)
    create_client_record(db, clinician)
    api.get("/api/clients", headers=clinician.headers)
    ok = api.get("/api/practice/audit-log/integrity", headers=clinician.headers).json()
    assert ok["verified"] is True
    assert ok["sealed_events"] >= 1
    assert ok["unsealed_events"] >= 1

    seal_audit_events(db, utcnow())
    head = ok["head_event_id"]
    with engine.begin() as connection:
        connection.execute(text("SET LOCAL session_replication_role = replica"))
        connection.execute(
            text("UPDATE audit_events SET ip_address = '6.6.6.6' WHERE id = :id"), {"id": head}
        )
    broken = api.get("/api/practice/audit-log/integrity", headers=clinician.headers).json()
    assert broken["verified"] is False
    assert f"Event {head} was changed" in broken["problem"]


def test_access_history_is_for_log_viewers_and_the_primary_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    primary = add_staff(db, clinician.practice_id, "p@example.com", StaffRole.CLINICIAN)
    teammate = add_staff(db, clinician.practice_id, "t@example.com", StaffRole.CLINICIAN)
    manager = add_staff(db, clinician.practice_id, "m@example.com", StaffRole.PRACTICE_MANAGER)
    biller = add_staff(db, clinician.practice_id, "b@example.com", StaffRole.BILLER)
    client = create_client_record(db, primary)
    other_client = create_client_record(db, clinician, email="o@example.com")
    assign_clinician(db, client, teammate)
    api.get(f"/api/clients/{client.id}", headers=teammate.headers)
    api.get(f"/api/clients/{other_client.id}", headers=clinician.headers)
    url = f"/api/clients/{client.id}/access-history"

    history = api.get(url, headers=primary.headers)
    assert history.status_code == 200
    events = history.json()["events"]
    assert events and {e["client_id"] for e in events} == {client.id}
    assert any(e["actor_id"] == teammate.id and e["action"] == "client.view" for e in events)
    assert api.get(url, headers=clinician.headers).status_code == 200
    assert api.get(url, headers=manager.headers).status_code == 200
    assert api.get(url, headers=teammate.headers).status_code == 403
    assert api.get(url, headers=biller.headers).status_code == 403
    other = register_practice(api, email="other@example.com")
    assert api.get(url, headers=other.headers).status_code == 404

    viewed = db.scalars(
        select(AuditEvent).where(AuditEvent.action == "client.access_history_view")
    ).all()
    assert {(event.actor_id, event.client_id) for event in viewed} == {
        (primary.id, client.id),
        (clinician.id, client.id),
        (manager.id, client.id),
    }
