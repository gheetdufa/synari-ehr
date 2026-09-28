"""Secure messaging between a client and one of their clinicians."""

from datetime import datetime

from sqlalchemy import ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedText
from synari.db import Base
from synari.models.enums import RiskLevel
from synari.models.files import StoredFile


class Conversation(Base):
    """The secure-message thread between one client and one of their clinicians."""

    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("clinician_id", "client_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    last_message_at: Mapped[datetime | None]
    clinician_read_at: Mapped[datetime | None]
    client_read_at: Mapped[datetime | None]
    away_reply_sent_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Message(Base):
    """One message. Removed messages keep their row (marked removed) for the record."""

    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    sender_role: Mapped[str] = mapped_column(String(20))
    # Which staff member wrote it (null for client messages and automatic replies).
    sender_staff_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    # Set when a guardian or other portal contact wrote it on the client's behalf.
    sender_contact_id: Mapped[int | None] = mapped_column(
        ForeignKey("client_contacts.id", ondelete="SET NULL")
    )
    body: Mapped[str] = mapped_column(EncryptedText("messages.body"))
    risk_level: Mapped[str] = mapped_column(String(20), default=RiskLevel.NONE)
    is_automatic: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    removed_at: Mapped[datetime | None]

    attachments: Mapped[list["MessageAttachment"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )


class MessageAttachment(Base):
    """Links a stored file to a message."""

    __tablename__ = "message_attachments"
    __table_args__ = (UniqueConstraint("message_id", "file_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    file_id: Mapped[int] = mapped_column(ForeignKey("stored_files.id"))

    file: Mapped[StoredFile] = relationship(lazy="joined")
