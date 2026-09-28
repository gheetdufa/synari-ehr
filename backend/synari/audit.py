"""Helpers for writing audit events. Callers commit them with their own transaction.

Every event that touches a client's record names the client (`client_id`), so a client's
access history and breach reviews can find it. Events are later sealed into a per-practice hash
chain by the worker (services/audit_chain.py) and the database refuses to change them.
"""

import hashlib
from collections.abc import Iterable
from datetime import timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import ColumnElement, exists, func, select
from sqlalchemy.orm import Session

from synari.access import active_emergency_client_ids
from synari.models import AuditEvent, Client, StaffMember
from synari.models.enums import Role

# List views name at most this many clients in one event (the total is always recorded).
MAX_LISTED_CLIENTS = 200
DEFAULT_THROTTLE_WINDOW = timedelta(minutes=10)
# Actor role for changes made by the server's admin commands (python -m synari.admin).
SYSTEM_ACTOR = "system"


def _request_origin(request: Request | None) -> tuple[str, str]:
    if request is None:
        return "", ""
    ip = request.client.host if request.client else ""
    return ip, request.headers.get("user-agent", "")[:300]


def _within(window: timedelta) -> ColumnElement[bool]:
    """Events recorded in the last `window`, by the database's clock (the one that stamps
    created_at), so a server clock that drifts from the database's doesn't defeat throttling."""
    return AuditEvent.created_at >= func.now() - window


def audit_staff(
    db: Session,
    request: Request | None,
    staff: StaffMember,
    action: str,
    resource_type: str = "",
    resource_id: int | None = None,
    detail: dict[str, Any] | None = None,
    *,
    client_id: int | None = None,
) -> None:
    """Record an action taken by a staff member.

    `client_id` names the client whose record was touched (it defaults to the resource for
    client resources). Actions on a client reached through emergency access carry
    emergency=true in `detail`.
    """
    ip, user_agent = _request_origin(request)
    if client_id is None and resource_type == "client":
        client_id = resource_id
    if client_id is not None and client_id in active_emergency_client_ids(db, staff):
        detail = {**(detail or {}), "emergency": True}
    db.add(
        AuditEvent(
            practice_id=staff.practice_id,
            client_id=client_id,
            actor_role=Role.STAFF,
            actor_id=staff.id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            ip_address=ip,
            user_agent=user_agent,
            detail=detail,
        )
    )


def audit_staff_throttled(
    db: Session,
    request: Request | None,
    staff: StaffMember,
    action: str,
    resource_type: str,
    resource_id: int | None,
    window: timedelta = DEFAULT_THROTTLE_WINDOW,
    *,
    client_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Like audit_staff, but skip if the same view was recorded within `window`.

    For screens that poll (e.g. a live waiting room) so the log records access, not refreshes.
    """
    recent = db.scalar(
        select(
            exists().where(
                AuditEvent.practice_id == staff.practice_id,
                AuditEvent.actor_role == Role.STAFF,
                AuditEvent.actor_id == staff.id,
                AuditEvent.action == action,
                AuditEvent.resource_type == resource_type,
                AuditEvent.resource_id.is_not_distinct_from(resource_id),
                AuditEvent.client_id.is_not_distinct_from(client_id),
                _within(window),
            )
        )
    )
    if not recent:
        audit_staff(
            db, request, staff, action, resource_type, resource_id, detail, client_id=client_id
        )


def audit_staff_list(
    db: Session,
    request: Request | None,
    staff: StaffMember,
    action: str,
    client_ids: Iterable[int],
    *,
    detail: dict[str, Any] | None = None,
    window: timedelta = DEFAULT_THROTTLE_WINDOW,
) -> None:
    """Record that a staff member viewed a list naming these clients (dashboards, client and
    note lists, queues).

    One event per distinct set of clients per `window`, so polling screens don't flood the log.
    The event lists up to MAX_LISTED_CLIENTS client ids plus the total; a list about a single
    client also sets `client_id`, so it shows in that client's access history. Empty lists
    aren't recorded.
    """
    ids = sorted(set(client_ids))
    if not ids:
        return
    digest = hashlib.sha256(",".join(map(str, ids)).encode()).hexdigest()[:32]
    client_id = ids[0] if len(ids) == 1 else None
    recent = db.scalar(
        select(
            exists().where(
                AuditEvent.practice_id == staff.practice_id,
                AuditEvent.actor_role == Role.STAFF,
                AuditEvent.actor_id == staff.id,
                AuditEvent.action == action,
                AuditEvent.resource_type == "client_list",
                AuditEvent.detail["list_digest"].as_string() == digest,
                _within(window),
            )
        )
    )
    if recent:
        return
    audit_staff(
        db,
        request,
        staff,
        action,
        "client_list",
        None,
        {
            **(detail or {}),
            "client_ids": ids[:MAX_LISTED_CLIENTS],
            "client_count": len(ids),
            "list_digest": digest,
        },
        client_id=client_id,
    )


def audit_client(
    db: Session,
    request: Request | None,
    client: Client,
    action: str,
    resource_type: str = "",
    resource_id: int | None = None,
    detail: dict[str, Any] | None = None,
    *,
    client_id: int | None = None,
) -> None:
    """Record an action taken in a client's portal (`client_id` defaults to the client).

    The event is about the signed-in client's own record unless `client_id` names another.
    When one of the client's contacts (e.g. a guardian) is signed in, the portal auth
    dependency notes them on the request and their id is added to `detail` as contact_id.
    """
    ip, user_agent = _request_origin(request)
    contact_id = getattr(request.state, "portal_contact_id", None) if request else None
    if contact_id is not None:
        detail = {**(detail or {}), "contact_id": contact_id}
    db.add(
        AuditEvent(
            practice_id=client.practice_id,
            client_id=client.id if client_id is None else client_id,
            actor_role=Role.CLIENT,
            actor_id=client.id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            ip_address=ip,
            user_agent=user_agent,
            detail=detail,
        )
    )


def audit_anonymous(
    db: Session,
    request: Request | None,
    action: str,
    practice_id: int | None = None,
    detail: dict[str, Any] | None = None,
    *,
    client_id: int | None = None,
) -> None:
    """Record an unauthenticated event such as a failed sign-in or a guest joining a session."""
    ip, user_agent = _request_origin(request)
    db.add(
        AuditEvent(
            practice_id=practice_id,
            client_id=client_id,
            actor_role="anonymous",
            actor_id=None,
            action=action,
            ip_address=ip,
            user_agent=user_agent,
            detail=detail,
        )
    )


def audit_system(
    db: Session,
    action: str,
    *,
    practice_id: int | None,
    resource_type: str = "",
    resource_id: int | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Record a change made by the server's admin commands rather than a signed-in person."""
    db.add(
        AuditEvent(
            practice_id=practice_id,
            actor_role=SYSTEM_ACTOR,
            actor_id=None,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            detail=detail,
        )
    )
