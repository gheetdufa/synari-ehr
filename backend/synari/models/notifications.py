"""In-app notifications and the outbound email/SMS queue."""

from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from synari.db import Base
from synari.models.enums import OutboundStatus


class Notification(Base):
    """An in-app notification for a staff member or client."""

    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_recipient", "recipient_role", "recipient_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    recipient_role: Mapped[str] = mapped_column(String(20))
    recipient_id: Mapped[int]
    kind: Mapped[str] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(300), default="")
    urgent: Mapped[bool] = mapped_column(default=False)
    read_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class OutboundMessage(Base):
    """An email or SMS waiting to be sent by the worker (transactional outbox).

    A condition lets a message be dropped at send time, e.g. a "new message" email is
    skipped if the recipient already read the message in the app.
    """

    __tablename__ = "outbound_messages"
    __table_args__ = (Index("ix_outbound_pending", "status", "send_after"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int | None] = mapped_column(ForeignKey("practices.id"), index=True)
    channel: Mapped[str] = mapped_column(String(10))
    to_address: Mapped[str] = mapped_column(String(320))
    subject: Mapped[str] = mapped_column(String(300), default="")
    body_text: Mapped[str] = mapped_column(Text)
    body_html: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default=OutboundStatus.PENDING)
    attempts: Mapped[int] = mapped_column(default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")
    send_after: Mapped[datetime] = mapped_column(server_default=func.now())
    sent_at: Mapped[datetime | None]
    dedupe_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    condition_kind: Mapped[str | None] = mapped_column(String(50))
    condition_ref: Mapped[int | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
