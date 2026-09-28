"""Append-only audit trail of sign-ins and access to protected health information."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from synari.db import Base


class AuditEvent(Base):
    """Who did what to which record, from where."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    # The practice whose log this belongs to (null for sign-in attempts on unknown accounts).
    practice_id: Mapped[int | None] = mapped_column(ForeignKey("practices.id"), index=True)
    # The client whose record was touched, for per-client access history and breach reviews.
    client_id: Mapped[int | None] = mapped_column(index=True)
    actor_role: Mapped[str] = mapped_column(String(20))
    actor_id: Mapped[int | None]
    action: Mapped[str] = mapped_column(String(64))
    resource_type: Mapped[str] = mapped_column(String(50), default="")
    resource_id: Mapped[int | None]
    ip_address: Mapped[str] = mapped_column(String(45), default="")
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    # Tamper evidence: events are sealed in id order per practice into a hash chain
    # (hash = SHA-256 of the previous hash and this event). The database refuses updates
    # and deletes of sealed events.
    prev_hash: Mapped[str | None] = mapped_column(String(64))
    hash: Mapped[str | None] = mapped_column(String(64))
    sealed_at: Mapped[datetime | None]
