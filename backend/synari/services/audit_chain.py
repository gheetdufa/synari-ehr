"""Tamper evidence for the audit log: per-practice hash chains, daily checkpoints, verification
and the retention purge.

- **Sealing.** The worker seals new events into their practice's chain (anonymous events with no
  practice form their own chain): `hash = SHA-256(prev_hash || canonical JSON of the event)`.
  Chain order is `(sealed_at, id)`: each run seals everything committed so far in id order with
  one database timestamp, so an event that commits late simply joins a later run. Runs are
  serialized with a transaction-level advisory lock.
- **The database refuses changes** (migration ..._audit_log_append_only): sealed events can't be
  updated, events can't be deleted except by the retention purge, and neither audit table can
  be truncated.
- **Checkpoints** record a chain's head once a day. A checkpoint's `event_count` is the head's
  position in the chain counted from its very first event, so deleting the newest events
  (past the last checkpoint's head) is detected too.
- **Retention.** Events older than AUDIT_RETENTION_YEARS (at least 6) are purged from the start
  of each chain; a checkpoint at the last purged event lets the rest of the chain verify.
"""

import hashlib
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, delete, func, select, text, tuple_
from sqlalchemy.orm import Session

from synari.config import settings
from synari.integrity import canonical_json
from synari.models import AuditCheckpoint, AuditEvent, Practice, SecurityEvent
from synari.models.enums import SecuritySeverity
from synari.services.security_events import record_security_event

logger = logging.getLogger(__name__)

GENESIS_HASH = "0" * 64
# pg_advisory_xact_lock key serializing seal runs across workers ("SYNAUDIT" folded to 63 bits).
SEAL_LOCK_KEY = 0x53594E4155444954 & 0x7FFFFFFFFFFFFFFF
SEAL_BATCH_SIZE = 5000
CHECKPOINT_INTERVAL = timedelta(days=1)
VERIFY_INTERVAL = timedelta(days=1)
VERIFICATION_RUN = "audit.verification_run"
VERIFICATION_FAILED = "audit.verification_failed"

ChainKey = int | None


def event_payload(event: AuditEvent) -> dict[str, Any]:
    """The event's fields that its hash covers (everything except the seal itself)."""
    return {
        "id": event.id,
        "practice_id": event.practice_id,
        "client_id": event.client_id,
        "actor_role": event.actor_role,
        "actor_id": event.actor_id,
        "action": event.action,
        "resource_type": event.resource_type,
        "resource_id": event.resource_id,
        "ip_address": event.ip_address,
        "user_agent": event.user_agent,
        "detail": event.detail,
        "created_at": event.created_at,
    }


def event_hash(prev_hash: str, event: AuditEvent) -> str:
    """SHA-256 of the previous hash followed by the event's canonical JSON."""
    return hashlib.sha256(prev_hash.encode() + canonical_json(event_payload(event))).hexdigest()


def in_chain(practice_id: ChainKey) -> ColumnElement[bool]:
    """SQL condition on AuditEvent for one practice's chain."""
    return AuditEvent.practice_id.is_not_distinct_from(practice_id)


def _chain_order() -> tuple[Any, Any]:
    return AuditEvent.sealed_at, AuditEvent.id


def _sealed_in(practice_id: ChainKey) -> list[ColumnElement[bool]]:
    return [in_chain(practice_id), AuditEvent.sealed_at.is_not(None)]


def chain_head(db: Session, practice_id: ChainKey) -> AuditEvent | None:
    """The last sealed event in a practice's chain."""
    return db.scalar(
        select(AuditEvent)
        .where(*_sealed_in(practice_id))
        .order_by(AuditEvent.sealed_at.desc(), AuditEvent.id.desc())
        .limit(1)
    )


def _checkpoints(db: Session, practice_id: ChainKey) -> list[AuditCheckpoint]:
    return list(
        db.scalars(
            select(AuditCheckpoint)
            .where(AuditCheckpoint.practice_id.is_not_distinct_from(practice_id))
            .order_by(AuditCheckpoint.id)
        )
    )


def _chain_base(db: Session, practice_id: ChainKey) -> tuple[str, int]:
    """Where the chain's remaining events start: the genesis hash at position 0, or the
    checkpoint at the last event removed by the retention purge."""
    first = db.scalar(
        select(AuditEvent.prev_hash)
        .where(*_sealed_in(practice_id))
        .order_by(*_chain_order())
        .limit(1)
    )
    if first is None or first == GENESIS_HASH:
        latest = _checkpoints(db, practice_id)
        if first is None and latest:
            # Every event was purged; new events continue after the last checkpoint.
            return latest[-1].head_hash, latest[-1].event_count
        return GENESIS_HASH, 0
    for checkpoint in _checkpoints(db, practice_id):
        if checkpoint.head_hash == first:
            return checkpoint.head_hash, checkpoint.event_count
    return first, 0


def _position(db: Session, practice_id: ChainKey, event: AuditEvent) -> int:
    """An event's position in its chain counted from the chain's very first event."""
    _, base = _chain_base(db, practice_id)
    present = db.scalar(
        select(func.count(AuditEvent.id)).where(
            *_sealed_in(practice_id),
            tuple_(*_chain_order()) <= tuple_(event.sealed_at, event.id),
        )
    )
    return base + (present or 0)


def seal_audit_events(db: Session, now: datetime) -> None:
    """Worker job: seal committed, unsealed events into their practices' chains."""
    db.execute(select(func.pg_advisory_xact_lock(SEAL_LOCK_KEY)))
    events = list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.sealed_at.is_(None))
            .order_by(AuditEvent.id)
            .limit(SEAL_BATCH_SIZE)
        )
    )
    if not events:
        db.rollback()
        return
    stamp: datetime = db.scalar(select(func.clock_timestamp()))
    chains: dict[ChainKey, list[AuditEvent]] = {}
    for event in events:
        chains.setdefault(event.practice_id, []).append(event)
    for practice_id, chain_events in chains.items():
        head = chain_head(db, practice_id)
        prev_hash = head.hash if head is not None and head.hash else _chain_base(db, practice_id)[0]
        sealed_at = stamp
        if head is not None and head.sealed_at is not None and head.sealed_at >= stamp:
            sealed_at = head.sealed_at + timedelta(microseconds=1)
        for event in chain_events:
            event.prev_hash = prev_hash
            event.hash = event_hash(prev_hash, event)
            event.sealed_at = sealed_at
            prev_hash = event.hash
    db.commit()


def checkpoint_audit_chains(db: Session, now: datetime) -> None:
    """Worker job: once a day, record each chain's head as a checkpoint."""
    chain_keys = db.scalars(
        select(AuditEvent.practice_id).where(AuditEvent.sealed_at.is_not(None)).distinct()
    ).all()
    for practice_id in chain_keys:
        latest = db.scalar(
            select(AuditCheckpoint)
            .where(AuditCheckpoint.practice_id.is_not_distinct_from(practice_id))
            .order_by(AuditCheckpoint.id.desc())
            .limit(1)
        )
        if latest is not None and latest.created_at > now - CHECKPOINT_INTERVAL:
            continue
        head = chain_head(db, practice_id)
        if head is None or head.hash is None:
            continue
        if latest is not None and latest.last_event_id == head.id:
            continue
        db.add(
            AuditCheckpoint(
                practice_id=practice_id,
                last_event_id=head.id,
                head_hash=head.hash,
                event_count=_position(db, practice_id, head),
            )
        )
    db.commit()


@dataclass(frozen=True)
class ChainReport:
    """The result of verifying one chain."""

    practice_id: ChainKey
    verified: bool
    problem: str | None
    sealed_events: int
    head_event_id: int | None
    head_hash: str | None
    failed_event_id: int | None = None


def _sealed_events(db: Session, practice_id: ChainKey) -> Iterator[AuditEvent]:
    return iter(
        db.scalars(
            select(AuditEvent)
            .where(*_sealed_in(practice_id))
            .order_by(*_chain_order())
            # Always compare against what's stored, never rows already loaded in this session.
            .execution_options(yield_per=2000, populate_existing=True)
        )
    )


def verify_chain(db: Session, practice_id: ChainKey) -> ChainReport:
    """Recompute a chain from its start: every sealed event must follow the one before it
    and still match its hash, and every checkpoint past the retention boundary must match."""
    checkpoints = _checkpoints(db, practice_id)
    start_hash, base = _chain_base(db, practice_id)
    by_event: dict[int, list[AuditCheckpoint]] = {}
    for checkpoint in checkpoints:
        if checkpoint.event_count > base:
            by_event.setdefault(checkpoint.last_event_id, []).append(checkpoint)
    expected = start_hash
    position = base
    head: AuditEvent | None = None

    def failed(problem: str, event_id: int | None) -> ChainReport:
        return ChainReport(
            practice_id,
            False,
            problem,
            position - base,
            head.id if head else None,
            head.hash if head else None,
            event_id,
        )

    if start_hash != GENESIS_HASH and base == 0:
        first = next(_sealed_events(db, practice_id))
        return failed(
            f"Event {first.id} doesn't continue from the start of the log or a retention "
            "checkpoint (earlier events were removed)",
            first.id,
        )
    matched: set[int] = set()
    for event in _sealed_events(db, practice_id):
        position += 1
        if event.prev_hash != expected:
            return failed(
                f"Event {event.id} doesn't follow the event before it (events are missing or "
                "were reordered)",
                event.id,
            )
        if event.hash != event_hash(event.prev_hash, event):
            return failed(f"Event {event.id} was changed after it was sealed", event.id)
        for checkpoint in by_event.get(event.id, []):
            if checkpoint.head_hash != event.hash or checkpoint.event_count != position:
                return failed(
                    f"Checkpoint {checkpoint.id} doesn't match event {event.id}", event.id
                )
            matched.add(checkpoint.id)
        expected = event.hash
        head = event
    for checkpoint in checkpoints:
        if checkpoint.event_count > base and checkpoint.id not in matched:
            return failed(
                f"Event {checkpoint.last_event_id} recorded by checkpoint {checkpoint.id} is "
                "missing (events were deleted)",
                checkpoint.last_event_id,
            )
    return ChainReport(
        practice_id,
        True,
        None,
        position - base,
        head.id if head else None,
        head.hash if head else None,
    )


def verify_all(db: Session) -> list[ChainReport]:
    """Verify every chain: each practice's, then the one for events without a practice."""
    practices: list[ChainKey] = list(db.scalars(select(Practice.id).order_by(Practice.id)))
    return [verify_chain(db, key) for key in [*practices, None]]


def verify_audit_chains(db: Session, now: datetime) -> None:
    """Worker job: once a day, verify every chain; each failing practice gets a critical
    security event, and the run itself is recorded (so owners and operators can see when the
    log was last verified)."""
    last_run = db.scalar(
        select(func.max(SecurityEvent.created_at)).where(
            SecurityEvent.practice_id.is_(None), SecurityEvent.kind == VERIFICATION_RUN
        )
    )
    if last_run is not None and last_run > now - VERIFY_INTERVAL:
        return
    reports = verify_all(db)
    failures = [report for report in reports if not report.verified]
    for report in failures:
        logger.error("Audit chain verification failed for practice %s", report.practice_id)
        record_security_event(
            db,
            practice_id=report.practice_id,
            kind=VERIFICATION_FAILED,
            severity=SecuritySeverity.CRITICAL,
            detail={"event_id": report.failed_event_id, "sealed_events": report.sealed_events},
        )
    record_security_event(
        db,
        practice_id=None,
        kind=VERIFICATION_RUN,
        severity=SecuritySeverity.CRITICAL if failures else SecuritySeverity.INFO,
        detail={
            "chains": len(reports),
            "failed_practice_ids": [report.practice_id for report in failures],
            "sealed_events": sum(report.sealed_events for report in reports),
        },
    )
    db.commit()


def _years_before(moment: datetime, years: int) -> datetime:
    try:
        return moment.replace(year=moment.year - years)
    except ValueError:  # February 29
        return moment.replace(year=moment.year - years, day=28)


def purge_expired_audit_events(db: Session, now: datetime) -> None:
    """Worker job: delete sealed events older than AUDIT_RETENTION_YEARS from the start of each
    chain, leaving a checkpoint at the last one removed.

    The cutoff uses the database clock, which the append-only trigger also checks.
    """
    db_now: datetime = db.scalar(select(func.now()))
    cutoff = _years_before(db_now, settings.audit_retention_years)
    expired_chains = db.scalars(
        select(AuditEvent.practice_id)
        .where(AuditEvent.sealed_at.is_not(None), AuditEvent.created_at < cutoff)
        .distinct()
    ).all()
    if not expired_chains:
        return
    db.execute(select(func.pg_advisory_xact_lock(SEAL_LOCK_KEY)))
    db.execute(text("SELECT set_config('synari.audit_purge', 'on', true)"))
    for practice_id in expired_chains:
        first_kept = db.scalar(
            select(AuditEvent)
            .where(*_sealed_in(practice_id), AuditEvent.created_at >= cutoff)
            .order_by(*_chain_order())
            .limit(1)
        )
        before_kept = (
            [tuple_(*_chain_order()) < tuple_(first_kept.sealed_at, first_kept.id)]
            if first_kept is not None
            else []
        )
        last_purged = db.scalar(
            select(AuditEvent)
            .where(*_sealed_in(practice_id), *before_kept)
            .order_by(AuditEvent.sealed_at.desc(), AuditEvent.id.desc())
            .limit(1)
        )
        if last_purged is None or last_purged.hash is None:
            continue
        db.add(
            AuditCheckpoint(
                practice_id=practice_id,
                last_event_id=last_purged.id,
                head_hash=last_purged.hash,
                event_count=_position(db, practice_id, last_purged),
            )
        )
        db.flush()
        db.execute(
            delete(AuditEvent)
            .where(
                *_sealed_in(practice_id),
                tuple_(*_chain_order()) <= tuple_(last_purged.sealed_at, last_purged.id),
            )
            .execution_options(synchronize_session=False)
        )
    db.commit()


def unsealed_count(db: Session, practice_id: ChainKey) -> int:
    """Events in a chain still waiting to be sealed."""
    return (
        db.scalar(
            select(func.count(AuditEvent.id)).where(
                in_chain(practice_id), AuditEvent.sealed_at.is_(None)
            )
        )
        or 0
    )


def last_checkpoint_at(db: Session, practice_id: ChainKey) -> datetime | None:
    """When the chain's head was last checkpointed."""
    return db.scalar(
        select(func.max(AuditCheckpoint.created_at)).where(
            AuditCheckpoint.practice_id.is_not_distinct_from(practice_id)
        )
    )
