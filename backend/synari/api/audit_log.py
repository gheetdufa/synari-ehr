"""The practice's audit log: filtered viewing, export with the hash-chain head, chain integrity,
and a client's access history.

The practice-wide log needs the view_audit_log capability (owners, practice managers and
clinicians with practice-wide access). A client's access history is also open to the client's
primary clinician. Viewing or exporting the log is itself audited.
"""

import csv
import io
import json
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.orm import Session

from synari.access import Access
from synari.audit import audit_staff, audit_staff_throttled
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import AuditEvent, Client, StaffMember
from synari.models.enums import Role, SecuritySeverity
from synari.permissions import Capability
from synari.schemas.common import Schema
from synari.services.audit_chain import (
    ChainReport,
    in_chain,
    last_checkpoint_at,
    unsealed_count,
    verify_chain,
)
from synari.services.security_events import record_security_event

router = APIRouter(tags=["audit"])

MAX_EXPORT_EVENTS = 100_000
EXPORT_COLUMNS = (
    "id",
    "created_at",
    "actor_role",
    "actor_id",
    "actor_name",
    "client_id",
    "action",
    "resource_type",
    "resource_id",
    "ip_address",
    "user_agent",
    "detail",
    "prev_hash",
    "hash",
    "sealed_at",
)


class AuditEventOut(Schema):
    id: int
    actor_role: str
    actor_id: int | None
    # Staff members' names; empty for clients (see client_name) and anonymous events.
    actor_name: str
    client_id: int | None
    client_name: str
    action: str
    resource_type: str
    resource_id: int | None
    ip_address: str
    user_agent: str
    # Ids and counts only (e.g. which fields changed); never clinical content.
    detail: dict[str, Any] | None
    created_at: datetime
    # Sealed into the practice's tamper-evident hash chain (new events are sealed within a
    # minute or so).
    sealed: bool


class AuditLogPage(Schema):
    """Newest first; pass `next_cursor` as `cursor` for older events (null when done)."""

    events: list[AuditEventOut]
    next_cursor: int | None


class AuditIntegrityOut(Schema):
    verified: bool
    # What's wrong when verification failed (event ids only).
    problem: str | None
    head_event_id: int | None
    head_hash: str | None
    sealed_events: int
    unsealed_events: int
    last_checkpoint_at: datetime | None


class AuditFilters:
    """Query filters shared by the log and its export."""

    def __init__(
        self,
        client_id: int | None = Query(default=None),
        actor_id: int | None = Query(default=None),
        action: str = Query(default="", max_length=64, description="Action prefix"),
        from_: datetime | None = Query(default=None, alias="from"),
        to: datetime | None = Query(default=None),
    ) -> None:
        self.client_id = client_id
        self.actor_id = actor_id
        self.action = action.strip()
        self.from_ = from_
        self.to = to

    def conditions(self) -> list[ColumnElement[bool]]:
        conditions: list[ColumnElement[bool]] = []
        if self.client_id is not None:
            conditions.append(AuditEvent.client_id == self.client_id)
        if self.actor_id is not None:
            conditions += [
                AuditEvent.actor_role == Role.STAFF,
                AuditEvent.actor_id == self.actor_id,
            ]
        if self.action:
            conditions.append(AuditEvent.action.startswith(self.action, autoescape=True))
        if self.from_ is not None:
            conditions.append(AuditEvent.created_at >= self.from_)
        if self.to is not None:
            conditions.append(AuditEvent.created_at < self.to)
        return conditions

    def summary(self) -> dict[str, Any]:
        """The filters for the audit event and export header (ids and dates only)."""
        values = {
            "client_id": self.client_id,
            "actor_id": self.actor_id,
            "action": self.action or None,
            "from": self.from_.isoformat() if self.from_ else None,
            "to": self.to.isoformat() if self.to else None,
        }
        return {key: value for key, value in values.items() if value is not None}


def _require_log_access(access: Access) -> None:
    access.require(Capability.VIEW_AUDIT_LOG, "Only owners and managers can see the activity log")


def _names(
    db: Session, events: Sequence[AuditEvent], practice_id: int
) -> tuple[dict[int, str], dict[int, str]]:
    """Staff and client names for a page of events, limited to this practice."""
    staff_ids = {e.actor_id for e in events if e.actor_role == Role.STAFF and e.actor_id}
    client_ids = {e.client_id for e in events if e.client_id}
    staff = {
        member.id: member.full_name
        for member in db.scalars(
            select(StaffMember).where(
                StaffMember.id.in_(staff_ids), StaffMember.practice_id == practice_id
            )
        )
    }
    clients = {
        client.id: client.full_name
        for client in db.scalars(
            select(Client).where(Client.id.in_(client_ids), Client.practice_id == practice_id)
        )
    }
    return staff, clients


def _page(
    db: Session, practice_id: int, query: Select[tuple[AuditEvent]], limit: int
) -> AuditLogPage:
    events = list(db.scalars(query.order_by(AuditEvent.id.desc()).limit(limit + 1)))
    more = len(events) > limit
    events = events[:limit]
    staff, clients = _names(db, events, practice_id)
    return AuditLogPage(
        events=[
            AuditEventOut(
                id=event.id,
                actor_role=event.actor_role,
                actor_id=event.actor_id,
                actor_name=staff.get(event.actor_id or 0, "")
                if event.actor_role == Role.STAFF
                else "",
                client_id=event.client_id,
                client_name=clients.get(event.client_id or 0, ""),
                action=event.action,
                resource_type=event.resource_type,
                resource_id=event.resource_id,
                ip_address=event.ip_address,
                user_agent=event.user_agent,
                detail=event.detail,
                created_at=event.created_at,
                sealed=event.sealed_at is not None,
            )
            for event in events
        ],
        next_cursor=events[-1].id if more else None,
    )


@router.get("/practice/audit-log", response_model=AuditLogPage)
def audit_log(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    filters: Annotated[AuditFilters, Depends()],
    cursor: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> AuditLogPage:
    """The practice's activity, newest first, optionally filtered by client, staff member,
    action prefix (e.g. `note.`) and time range (`from` inclusive, `to` exclusive)."""
    _require_log_access(access)
    query = select(AuditEvent).where(
        AuditEvent.practice_id == access.practice_id, *filters.conditions()
    )
    if cursor is not None:
        query = query.where(AuditEvent.id < cursor)
    page = _page(db, access.practice_id, query, limit)
    audit_staff_throttled(
        db,
        request,
        access.staff,
        "audit_log.view",
        "audit_log",
        None,
        client_id=filters.client_id,
        detail={"filters": filters.summary()},
    )
    db.commit()
    return page


def _integrity(db: Session, practice_id: int) -> tuple[ChainReport, AuditIntegrityOut]:
    report = verify_chain(db, practice_id)
    return report, AuditIntegrityOut(
        verified=report.verified,
        problem=report.problem,
        head_event_id=report.head_event_id,
        head_hash=report.head_hash,
        sealed_events=report.sealed_events,
        unsealed_events=unsealed_count(db, practice_id),
        last_checkpoint_at=last_checkpoint_at(db, practice_id),
    )


@router.get("/practice/audit-log/integrity", response_model=AuditIntegrityOut)
def audit_log_integrity(access: CurrentAccess, db: DbSession) -> AuditIntegrityOut:
    """Verify the practice's audit chain now: every sealed event must still match its hash and
    follow the one before it."""
    _require_log_access(access)
    _, integrity = _integrity(db, access.practice_id)
    return integrity


def _export_row(event: AuditEvent, staff: dict[int, str]) -> dict[str, Any]:
    return {
        "id": event.id,
        "created_at": event.created_at.isoformat(),
        "actor_role": event.actor_role,
        "actor_id": event.actor_id,
        "actor_name": staff.get(event.actor_id or 0, "") if event.actor_role == Role.STAFF else "",
        "client_id": event.client_id,
        "action": event.action,
        "resource_type": event.resource_type,
        "resource_id": event.resource_id,
        "ip_address": event.ip_address,
        "user_agent": event.user_agent,
        "detail": event.detail,
        "prev_hash": event.prev_hash,
        "hash": event.hash,
        "sealed_at": event.sealed_at.isoformat() if event.sealed_at else None,
    }


def _ndjson(header: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    lines = [json.dumps({"type": "export", **header})]
    lines += [json.dumps({"type": "event", **row}) for row in rows]
    return "\n".join(lines) + "\n"


def _csv(header: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    buffer = io.StringIO()
    chain = header["chain"]
    buffer.write("# Synari audit log export\n")
    buffer.write(f"# practice_id={header['practice_id']} exported_at={header['exported_at']}\n")
    buffer.write(f"# filters={json.dumps(header['filters'], sort_keys=True)}\n")
    buffer.write(
        f"# chain_head_event_id={chain['head_event_id'] or ''} "
        f"chain_head_hash={chain['head_hash'] or ''} "
        f"sealed_events={chain['sealed_events']} unsealed_events={chain['unsealed_events']}\n"
    )
    verification = "passed" if chain["verified"] else f"FAILED ({chain['problem']})"
    buffer.write(f"# verification={verification}\n")
    writer = csv.DictWriter(buffer, fieldnames=EXPORT_COLUMNS)
    writer.writeheader()
    for row in rows:
        writer.writerow({**row, "detail": json.dumps(row["detail"]) if row["detail"] else ""})
    return buffer.getvalue()


@router.get("/practice/audit-log/export")
def export_audit_log(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    filters: Annotated[AuditFilters, Depends()],
    export_format: Literal["csv", "ndjson"] = Query(default="csv", alias="format"),
) -> Response:
    """Download the filtered log, oldest first, with each event's hashes and the chain's head
    and verification status, so an auditor can recompute the chain independently."""
    _require_log_access(access)
    conditions = [AuditEvent.practice_id == access.practice_id, *filters.conditions()]
    total = db.scalar(select(func.count(AuditEvent.id)).where(*conditions)) or 0
    if total > MAX_EXPORT_EVENTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"That's {total:,} events; narrow the filters to {MAX_EXPORT_EVENTS:,} or fewer",
        )
    events = list(db.scalars(select(AuditEvent).where(*conditions).order_by(AuditEvent.id)))
    staff, _ = _names(db, events, access.practice_id)
    report, integrity = _integrity(db, access.practice_id)
    now = utcnow()
    header = {
        "practice_id": access.practice_id,
        "exported_at": now.isoformat(),
        "filters": filters.summary(),
        "events": len(events),
        "chain": {**integrity.model_dump(mode="json"), "genesis_hash": "0" * 64},
    }
    rows = [_export_row(event, staff) for event in events]
    body = _ndjson(header, rows) if export_format == "ndjson" else _csv(header, rows)
    audit_staff(
        db,
        request,
        access.staff,
        "audit_log.export",
        "audit_log",
        None,
        {"format": export_format, "events": len(events), "filters": filters.summary()},
        client_id=filters.client_id,
    )
    record_security_event(
        db,
        practice_id=access.practice_id,
        kind="audit_log.exported",
        severity=SecuritySeverity.INFO if report.verified else SecuritySeverity.CRITICAL,
        staff_id=access.staff.id,
        detail={"events": len(events), "verified": report.verified},
    )
    db.commit()
    media_type = "application/x-ndjson" if export_format == "ndjson" else "text/csv"
    filename = f"audit-log-{access.practice_id}-{now:%Y%m%d}.{export_format}"
    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/clients/{client_id}/access-history", response_model=AuditLogPage)
def client_access_history(
    client_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    cursor: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> AuditLogPage:
    """Who viewed or changed this client's record, newest first. For staff who can see the
    activity log, and for the client's primary clinician."""
    client = access.client(client_id)
    primary = client.primary_clinician
    is_primary = primary is not None and primary.id == access.staff.id
    if not (access.can(Capability.VIEW_AUDIT_LOG) or is_primary):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only owners, managers and the client's primary clinician can see who opened this "
            "record",
        )
    query = select(AuditEvent).where(
        in_chain(access.practice_id), AuditEvent.client_id == client.id
    )
    if cursor is not None:
        query = query.where(AuditEvent.id < cursor)
    page = _page(db, access.practice_id, query, limit)
    audit_staff_throttled(
        db,
        request,
        access.staff,
        "client.access_history_view",
        "client",
        client.id,
        client_id=client.id,
    )
    db.commit()
    return page
