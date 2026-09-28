"""Telehealth waiting room entries and session audio recordings."""

from datetime import datetime

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from synari.crypto import EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import RecordingStatus, WaitingStatus


class WaitingRoomEntry(TimestampMixin, Base):
    """Someone who opened a video link and is waiting to be admitted (or was admitted)."""

    __tablename__ = "waiting_room_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    appointment_id: Mapped[int] = mapped_column(
        ForeignKey("appointments.id", ondelete="CASCADE"), index=True
    )
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"))
    display_name: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default=WaitingStatus.WAITING)
    secret_hash: Mapped[str] = mapped_column(String(64), unique=True)
    recording_consent: Mapped[bool] = mapped_column(default=False)
    current_location: Mapped[str] = mapped_column(String(300), default="")
    admitted_at: Mapped[datetime | None]


class Recording(TimestampMixin, Base):
    """Session audio captured with participant consent, transcribed into a draft note."""

    __tablename__ = "recordings"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    appointment_id: Mapped[int] = mapped_column(ForeignKey("appointments.id"), index=True)
    file_id: Mapped[int | None] = mapped_column(ForeignKey("stored_files.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(20), default=RecordingStatus.UPLOADED)
    transcript: Mapped[str] = mapped_column(EncryptedText("recordings.transcript"), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    note_id: Mapped[int | None] = mapped_column(ForeignKey("notes.id", ondelete="SET NULL"))
