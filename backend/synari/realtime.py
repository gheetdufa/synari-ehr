"""Real-time events over WebSockets, fanned out across API processes with Postgres LISTEN/NOTIFY.

`publish()` issues pg_notify inside the caller's transaction, so an event is delivered only
if the change that caused it commits. Every API process listens on the channel and forwards
events to its own connected sockets. Events carry ids, not clinical content; clients refetch.
"""

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

import psycopg
from fastapi import WebSocket
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.config import settings

logger = logging.getLogger(__name__)

CHANNEL = "synari_events"
Recipient = tuple[str, int]


def publish(
    db: Session, recipients: Iterable[Recipient], event_type: str, data: dict[str, Any]
) -> None:
    """Queue an event for the given (role, id) recipients; sent when the transaction commits."""
    payload = json.dumps({"to": [list(r) for r in recipients], "type": event_type, "data": data})
    db.execute(select(func.pg_notify(CHANNEL, payload)))


class RealtimeHub:
    """Tracks this process's WebSocket connections and relays notifications to them."""

    def __init__(self) -> None:
        self._sockets: dict[Recipient, set[WebSocket]] = defaultdict(set)

    def add(self, recipient: Recipient, websocket: WebSocket) -> None:
        self._sockets[recipient].add(websocket)

    def remove(self, recipient: Recipient, websocket: WebSocket) -> None:
        sockets = self._sockets.get(recipient)
        if sockets is None:
            return
        sockets.discard(websocket)
        if not sockets:
            del self._sockets[recipient]

    async def dispatch(self, payload: str) -> None:
        """Deliver one NOTIFY payload to every matching local socket."""
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            logger.error("Dropping malformed realtime payload")
            return
        message = {"type": event["type"], "data": event["data"]}
        for role, recipient_id in event["to"]:
            for websocket in list(self._sockets.get((role, recipient_id), ())):
                try:
                    await websocket.send_json(message)
                except (RuntimeError, OSError):
                    self.remove((role, recipient_id), websocket)

    async def listen(self) -> None:
        """LISTEN on the event channel forever, reconnecting with backoff on failure."""
        backoff = 1.0
        while True:
            try:
                async with await psycopg.AsyncConnection.connect(
                    settings.libpq_url, autocommit=True
                ) as connection:
                    await connection.execute(f"LISTEN {CHANNEL}")
                    backoff = 1.0
                    async for notification in connection.notifies():
                        await self.dispatch(notification.payload)
            except psycopg.Error as exc:
                logger.warning(
                    "Realtime listener disconnected (%s); retrying in %.0fs", exc, backoff
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)


hub = RealtimeHub()
