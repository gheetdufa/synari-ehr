"""The tamper-evident audit log: sealing, verification, the append-only triggers, checkpoints,
the retention purge, the nightly verification job and the admin command."""

import hashlib
from datetime import timedelta
from itertools import pairwise

import pytest
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from synari.admin import main as admin_main
from synari.config import Settings
from synari.db import engine, utcnow
from synari.integrity import canonical_json
from synari.models import AuditCheckpoint, AuditEvent, Practice, SecurityEvent
from synari.models.enums import SecuritySeverity
from synari.services.audit_chain import (
    GENESIS_HASH,
    VERIFICATION_FAILED,
    VERIFICATION_RUN,
    checkpoint_audit_chains,
    event_payload,
    purge_expired_audit_events,
    seal_audit_events,
    verify_all,
    verify_audit_chains,
    verify_chain,
)
from synari.worker import JOBS
from tests.conftest import StaffAccount


def _add_events(db: Session, practice_id: int | None, count: int, **fields: object) -> list[int]:
    events = [
        AuditEvent(practice_id=practice_id, actor_role="staff", action=f"test.event{i}", **fields)
        for i in range(count)
    ]
    db.add_all(events)
    db.commit()
    return [event.id for event in events]


def _chain(db: Session, practice_id: int | None) -> list[AuditEvent]:
    db.expire_all()
    return list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.practice_id.is_not_distinct_from(practice_id))
            .order_by(AuditEvent.sealed_at, AuditEvent.id)
        )
    )


def _other_practice(db: Session) -> int:
    """A second practice's id (an audit chain only needs the practice row)."""
    practice = Practice(name="Other Practice")
    db.add(practice)
    db.commit()
    return practice.id


def _tamper(sql: str, **params: object) -> None:
    """Change the log behind the triggers' back, as someone with superuser access could."""
    with engine.begin() as connection:
        connection.execute(text("SET LOCAL session_replication_role = replica"))
        connection.execute(text(sql), params)


def test_sealing_links_each_practice_chain_from_genesis(
    db: Session, clinician: StaffAccount
) -> None:
    other = _other_practice(db)
    _add_events(db, clinician.practice_id, 3)
    _add_events(db, other, 2)
    _add_events(db, None, 1)

    seal_audit_events(db, utcnow())

    for practice_id in (clinician.practice_id, other, None):
        chain = _chain(db, practice_id)
        assert chain, practice_id
        assert chain[0].prev_hash == GENESIS_HASH
        for before, event in pairwise(chain):
            assert event.prev_hash == before.hash
        for event in chain:
            expected = hashlib.sha256(
                event.prev_hash.encode() + canonical_json(event_payload(event))
            ).hexdigest()
            assert event.hash == expected
            assert event.sealed_at is not None
    assert all(report.verified for report in verify_all(db))


def test_later_runs_continue_the_chain_even_for_late_lower_ids(
    db: Session, clinician: StaffAccount
) -> None:
    practice_id = clinician.practice_id
    seal_audit_events(db, utcnow())
    # Simulate an event that got its id earlier but committed after a seal run.
    head = _chain(db, practice_id)[-1]
    db.add(AuditEvent(id=head.id + 1000, practice_id=practice_id, actor_role="staff", action="a"))
    db.commit()
    seal_audit_events(db, utcnow())
    db.add(AuditEvent(id=head.id + 500, practice_id=practice_id, actor_role="staff", action="b"))
    db.commit()
    seal_audit_events(db, utcnow())

    chain = _chain(db, practice_id)
    assert [event.action for event in chain[-2:]] == ["a", "b"]
    assert chain[-1].prev_hash == chain[-2].hash
    assert verify_chain(db, practice_id).verified


def test_seal_is_a_no_op_without_new_events(db: Session, clinician: StaffAccount) -> None:
    seal_audit_events(db, utcnow())
    before = [(e.id, e.hash, e.sealed_at) for e in _chain(db, clinician.practice_id)]
    seal_audit_events(db, utcnow())
    assert [(e.id, e.hash, e.sealed_at) for e in _chain(db, clinician.practice_id)] == before


@pytest.mark.parametrize(
    ("sql", "problem"),
    [
        ("UPDATE audit_events SET detail = '{\"x\": 1}' WHERE id = :middle", "was changed"),
        ("UPDATE audit_events SET actor_id = 999 WHERE id = :middle", "was changed"),
        ("DELETE FROM audit_events WHERE id = :middle", "doesn't follow"),
        ("DELETE FROM audit_events WHERE id = :first", "doesn't continue"),
    ],
)
def test_verification_detects_tampering(
    db: Session, clinician: StaffAccount, sql: str, problem: str
) -> None:
    ids = _add_events(db, clinician.practice_id, 3)
    seal_audit_events(db, utcnow())
    chain = _chain(db, clinician.practice_id)
    assert verify_chain(db, clinician.practice_id).verified

    _tamper(sql, middle=ids[1], first=chain[0].id)

    report = verify_chain(db, clinician.practice_id)
    assert not report.verified
    assert report.problem is not None and problem in report.problem


def test_checkpoints_catch_deleted_newest_events(db: Session, clinician: StaffAccount) -> None:
    _add_events(db, clinician.practice_id, 3)
    seal_audit_events(db, utcnow())
    checkpoint_audit_chains(db, utcnow())
    checkpoint = db.scalars(select(AuditCheckpoint)).one()
    chain = _chain(db, clinician.practice_id)
    assert checkpoint.last_event_id == chain[-1].id
    assert checkpoint.head_hash == chain[-1].hash
    assert checkpoint.event_count == len(chain)

    _tamper("DELETE FROM audit_events WHERE id = :id", id=chain[-1].id)

    report = verify_chain(db, clinician.practice_id)
    assert not report.verified
    assert report.problem is not None and "missing" in report.problem


def test_checkpoints_are_daily(db: Session, clinician: StaffAccount) -> None:
    seal_audit_events(db, utcnow())
    checkpoint_audit_chains(db, utcnow())
    _add_events(db, clinician.practice_id, 1)
    seal_audit_events(db, utcnow())
    checkpoint_audit_chains(db, utcnow())
    assert db.scalar(select(AuditCheckpoint.id).where(AuditCheckpoint.id > 1)) is None

    checkpoint_audit_chains(db, utcnow() + timedelta(days=1, minutes=1))
    checkpoints = list(db.scalars(select(AuditCheckpoint).order_by(AuditCheckpoint.id)))
    assert len(checkpoints) == 2
    assert checkpoints[1].event_count == len(_chain(db, clinician.practice_id))
    assert verify_chain(db, clinician.practice_id).verified


def _refused(sql: str, **params: object) -> str:
    with pytest.raises(DBAPIError) as error, engine.begin() as connection:
        connection.execute(text(sql), params)
    return str(error.value)


def test_database_refuses_changes_to_the_log(db: Session, clinician: StaffAccount) -> None:
    unsealed = _add_events(db, clinician.practice_id, 1)[0]
    assert "append-only" in _refused(
        "UPDATE audit_events SET action = 'x' WHERE id = :id", id=unsealed
    )
    assert "append-only" in _refused(
        "UPDATE audit_events SET action = 'x', hash = 'h', prev_hash = 'p', sealed_at = now() "
        "WHERE id = :id",
        id=unsealed,
    )
    assert "append-only" in _refused("DELETE FROM audit_events WHERE id = :id", id=unsealed)

    seal_audit_events(db, utcnow())
    assert "append-only" in _refused(
        "UPDATE audit_events SET hash = :hash WHERE id = :id", id=unsealed, hash="0" * 64
    )
    assert "append-only" in _refused(
        "UPDATE audit_events SET sealed_at = NULL, hash = NULL, prev_hash = NULL WHERE id = :id",
        id=unsealed,
    )
    assert "append-only" in _refused("DELETE FROM audit_events WHERE id = :id", id=unsealed)
    # The purge switch only allows deleting sealed events past the six-year minimum.
    assert "append-only" in _refused(
        "SELECT set_config('synari.audit_purge', 'on', true); DELETE FROM audit_events"
    )
    assert "truncated" in _refused("TRUNCATE audit_events")

    checkpoint_audit_chains(db, utcnow())
    assert "append-only" in _refused("UPDATE audit_checkpoints SET event_count = 0")
    assert "append-only" in _refused("DELETE FROM audit_checkpoints")
    assert "truncated" in _refused("TRUNCATE audit_checkpoints")
    assert verify_chain(db, clinician.practice_id).verified


def _add_old_events(practice_id: int, count: int, years: int) -> None:
    with engine.begin() as connection:
        for i in range(count):
            connection.execute(
                text(
                    "INSERT INTO audit_events (practice_id, actor_role, action, resource_type, "
                    "ip_address, user_agent, created_at) VALUES (:practice_id, 'staff', :action, "
                    "'', '', '', now() - make_interval(years => :years))"
                ),
                {"practice_id": practice_id, "action": f"old.event{i}", "years": years},
            )


def test_retention_purge_removes_only_expired_events_and_keeps_the_chain_verifiable(
    db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    practice_id = clinician.practice_id
    _tamper("DELETE FROM audit_events")  # start the chain with the backdated events
    _add_old_events(practice_id, 3, years=8)
    _add_old_events(practice_id, 1, years=5)
    _add_events(db, practice_id, 2)
    seal_audit_events(db, utcnow())
    checkpoint_audit_chains(db, utcnow())
    total = len(_chain(db, practice_id))

    purge_expired_audit_events(db, utcnow())

    remaining = _chain(db, practice_id)
    assert [event.action for event in remaining] == ["old.event0", "test.event0", "test.event1"]
    boundary = db.scalars(select(AuditCheckpoint).order_by(AuditCheckpoint.id.desc())).first()
    assert boundary is not None and boundary.event_count == 3
    assert remaining[0].prev_hash == boundary.head_hash
    assert verify_chain(db, practice_id).verified

    # New events continue the chain, and later checkpoints count from the very first event.
    _add_events(db, practice_id, 1)
    seal_audit_events(db, utcnow())
    checkpoint_audit_chains(db, utcnow() + timedelta(days=2))
    latest = db.scalars(select(AuditCheckpoint).order_by(AuditCheckpoint.id.desc())).first()
    assert latest is not None and latest.event_count == total + 1
    assert verify_chain(db, practice_id).verified

    # A longer retention keeps everything younger than it.
    monkeypatch.setattr("synari.services.audit_chain.settings.audit_retention_years", 10)
    purge_expired_audit_events(db, utcnow())
    assert len(_chain(db, practice_id)) == len(remaining) + 1


def test_purge_when_every_event_expired_lets_new_events_continue(
    db: Session, clinician: StaffAccount
) -> None:
    practice_id = clinician.practice_id
    _tamper("DELETE FROM audit_events")
    _add_old_events(practice_id, 2, years=7)
    seal_audit_events(db, utcnow())
    purge_expired_audit_events(db, utcnow())
    assert _chain(db, practice_id) == []

    _add_events(db, practice_id, 2)
    seal_audit_events(db, utcnow())
    chain = _chain(db, practice_id)
    assert chain[0].prev_hash != GENESIS_HASH
    assert verify_chain(db, practice_id).verified


def test_retention_can_not_be_under_six_years() -> None:
    with pytest.raises(ValidationError):
        Settings(audit_retention_years=5)


def test_nightly_verification_records_runs_and_failures(
    db: Session, clinician: StaffAccount
) -> None:
    ids = _add_events(db, clinician.practice_id, 2)
    seal_audit_events(db, utcnow())
    now = utcnow()
    verify_audit_chains(db, now)
    run = db.scalars(select(SecurityEvent).where(SecurityEvent.kind == VERIFICATION_RUN)).one()
    assert run.severity == SecuritySeverity.INFO
    assert run.practice_id is None

    _tamper("UPDATE audit_events SET action = 'forged' WHERE id = :id", id=ids[0])
    verify_audit_chains(db, now + timedelta(hours=1))  # already ran today
    assert (
        db.scalar(select(SecurityEvent.id).where(SecurityEvent.kind == VERIFICATION_FAILED)) is None
    )

    verify_audit_chains(db, now + timedelta(days=1, minutes=1))
    failure = db.scalars(
        select(SecurityEvent).where(SecurityEvent.kind == VERIFICATION_FAILED)
    ).one()
    assert failure.practice_id == clinician.practice_id
    assert failure.severity == SecuritySeverity.CRITICAL
    assert failure.detail is not None and failure.detail["event_id"] == ids[0]
    runs = db.scalars(
        select(SecurityEvent)
        .where(SecurityEvent.kind == VERIFICATION_RUN)
        .order_by(SecurityEvent.id)
    ).all()
    assert runs[-1].severity == SecuritySeverity.CRITICAL
    assert runs[-1].detail is not None
    assert runs[-1].detail["failed_practice_ids"] == [clinician.practice_id]


def test_admin_audit_verify_command(
    db: Session, clinician: StaffAccount, capsys: pytest.CaptureFixture[str]
) -> None:
    ids = _add_events(db, clinician.practice_id, 2)
    seal_audit_events(db, utcnow())
    assert admin_main(["audit-verify"]) == 0
    assert f"OK      practice {clinician.practice_id}" in capsys.readouterr().out

    _tamper("UPDATE audit_events SET action = 'forged' WHERE id = :id", id=ids[1])
    assert admin_main(["audit-verify", "--practice", str(clinician.practice_id)]) == 1
    out = capsys.readouterr().out
    assert f"FAILED  practice {clinician.practice_id}" in out
    assert f"Event {ids[1]} was changed" in out


def test_audit_jobs_run_after_the_others() -> None:
    audit_jobs = [
        seal_audit_events,
        checkpoint_audit_chains,
        verify_audit_chains,
        purge_expired_audit_events,
    ]
    assert JOBS[-len(audit_jobs) :] == audit_jobs
