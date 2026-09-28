"""Two-way calendar sync with Google Calendar and Microsoft Outlook/365.

Synari pushes each clinician's appointments into a dedicated "Synari" calendar in their
account with PHI-free titles, and polls their busy times so online booking and scheduling
avoid them.
"""

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from synari.crypto import EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import CalendarConnectionStatus


class CalendarConnection(TimestampMixin, Base):
    """A clinician's connected Google or Microsoft calendar account."""

    __tablename__ = "calendar_connections"
    __table_args__ = (UniqueConstraint("staff_id", "provider"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    account_email: Mapped[str] = mapped_column(String(320), default="")
    provider_account_id: Mapped[str] = mapped_column(String(200), default="")
    granted_scopes: Mapped[str] = mapped_column(Text, default="")
    refresh_token: Mapped[str | None] = mapped_column(
        EncryptedText("calendar_connections.refresh_token")
    )
    access_token: Mapped[str | None] = mapped_column(
        EncryptedText("calendar_connections.access_token")
    )
    access_expires_at: Mapped[datetime | None]
    # The calendar Synari writes appointments to (created on connect).
    write_calendar_id: Mapped[str] = mapped_column(String(300), default="")
    # Calendars whose busy times block availability (default: the primary calendar).
    busy_calendar_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default=CalendarConnectionStatus.ACTIVE)
    last_error: Mapped[str] = mapped_column(Text, default="")
    last_error_at: Mapped[datetime | None]
    consecutive_failures: Mapped[int] = mapped_column(default=0)
    last_busy_sync_at: Mapped[datetime | None]


class CalendarEventLink(Base):
    """An appointment's copy in a connected calendar, and whether it's up to date."""

    __tablename__ = "calendar_event_links"
    __table_args__ = (UniqueConstraint("connection_id", "appointment_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(
        ForeignKey("calendar_connections.id", ondelete="CASCADE"), index=True
    )
    # Null once the appointment is deleted and the event still has to be removed.
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id", ondelete="SET NULL"), index=True
    )
    external_event_id: Mapped[str] = mapped_column(String(300), default="")
    # Bumped whenever the event has to be created anew (e.g. someone deleted it in their
    # calendar), so Microsoft's create-retry dedupe key (transactionId) changes with it.
    generation: Mapped[int] = mapped_column(default=0)
    # Hash of what was last pushed, to skip unchanged events.
    payload_hash: Mapped[str] = mapped_column(String(64), default="")
    # pending | synced | deleting | failed
    state: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    next_attempt_at: Mapped[datetime | None]
    last_error: Mapped[str] = mapped_column(Text, default="")


class ExternalBusyBlock(Base):
    """A busy time in a clinician's own calendar (times only; titles are never read)."""

    __tablename__ = "external_busy_blocks"
    __table_args__ = (Index("ix_external_busy_blocks_window", "connection_id", "starts_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(
        ForeignKey("calendar_connections.id", ondelete="CASCADE")
    )
    starts_at: Mapped[datetime]
    ends_at: Mapped[datetime]
