"""WebSocket endpoint for real-time events (new messages, waiting room arrivals, ...).

Protocol: connect to /api/ws, then send {"type": "auth", "token": "<access token>"} within
10 seconds. The server replies {"type": "ready"} and then pushes {"type", "data"} events.
Send {"type": "ping"} to receive {"type": "pong"}. The server closes the socket with code
4401 when the token is invalid or expires, or (checked every minute) when its session ends;
reconnect with a fresh token.
"""

import asyncio
import contextlib
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from synari.db import SessionLocal
from synari.deps import load_portal_actor_from_claims, load_staff_from_claims
from synari.models.enums import Role
from synari.realtime import Recipient, hub
from synari.security import decode_token
from synari.services.sessions import (
    live_session_for_claims,
    portal_idle_minutes,
    staff_idle_minutes,
)
from synari.services.sign_in import needs_mfa_setup

router = APIRouter(tags=["realtime"])

AUTH_TIMEOUT_SECONDS = 10
SESSION_CHECK_SECONDS = 60
CLOSE_UNAUTHORIZED = 4401


def _resolve_recipient(claims: dict[str, Any]) -> Recipient | None:
    """Who a token's live session belongs to (staff with full access, or a portal client).

    Listening doesn't count as activity, so it never keeps an idle session alive.
    """
    with SessionLocal() as db:
        if claims.get("role") == Role.STAFF:
            staff = load_staff_from_claims(db, claims)
            if staff is None or needs_mfa_setup(staff):
                return None
            session = live_session_for_claims(
                db, claims, role=Role.STAFF, idle_minutes=staff_idle_minutes(staff), touch=False
            )
            return (Role.STAFF.value, staff.id) if session else None
        if claims.get("role") == Role.CLIENT:
            actor = load_portal_actor_from_claims(db, claims)
            if actor is None:
                return None
            session = live_session_for_claims(
                db, claims, role=Role.CLIENT, idle_minutes=portal_idle_minutes(), touch=False
            )
            return (Role.CLIENT.value, actor.client.id) if session else None
    return None


async def _authenticate(websocket: WebSocket) -> tuple[Recipient, dict[str, Any]] | None:
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=AUTH_TIMEOUT_SECONDS)
    except (TimeoutError, ValueError, WebSocketDisconnect):
        return None
    if not isinstance(first, dict) or first.get("type") != "auth":
        return None
    claims = decode_token(str(first.get("token", "")), "access")
    if claims is None:
        return None
    recipient = await run_in_threadpool(_resolve_recipient, claims)
    if recipient is None:
        return None
    return recipient, claims


@router.websocket("/ws")
async def websocket_events(websocket: WebSocket) -> None:
    await websocket.accept()
    authenticated = await _authenticate(websocket)
    if authenticated is None:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return
    recipient, claims = authenticated
    expires_at = float(claims["exp"])
    hub.add(recipient, websocket)
    try:
        await websocket.send_json({"type": "ready"})
        next_check = time.time() + SESSION_CHECK_SECONDS
        while True:
            now = time.time()
            if now >= expires_at:
                break
            if now >= next_check:
                if await run_in_threadpool(_resolve_recipient, claims) is None:
                    break
                next_check = now + SESSION_CHECK_SECONDS
            try:
                message = await asyncio.wait_for(
                    websocket.receive_json(), timeout=min(expires_at, next_check) - now
                )
            except TimeoutError:
                continue
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=CLOSE_UNAUTHORIZED)
    except (WebSocketDisconnect, ValueError):
        pass
    finally:
        hub.remove(recipient, websocket)
