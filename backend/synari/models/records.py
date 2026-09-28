"""Record integrity and patients' rights: note versions and addenda, right-of-access requests,
accounting of disclosures and amendment requests (HIPAA 164.524, 164.526, 164.528)."""

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.integrity import Integrity, addendum_sha256, check, note_content_sha256
from synari.models.enums import (
    AmendmentStatus,
    DisclosureSource,
    RecordDelivery,
    RecordRequestStatus,
)

if TYPE_CHECKING:
    from synari.models.accounts import StaffMember
    from synari.models.clients import Client
    from synari.models.notes import Note


class NoteRevision(Base):
    """A signed version of a note. Each signature (and co-signature) adds one; unlocking a note
    to amend it keeps the earlier versions."""

    __tablename__ = "note_revisions"
    __table_args__ = (UniqueConstraint("note_id", "version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    version: Mapped[int]
    title: Mapped[str] = mapped_column(EncryptedText("note_revisions.title"), default="")
    sections: Mapped[dict[str, str]] = mapped_column(
        EncryptedJSON("note_revisions.sections"), default=dict
    )
    content: Mapped[str] = mapped_column(EncryptedText("note_revisions.content"), default="")
    content_sha256: Mapped[str] = mapped_column(String(64))
    signed_by_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    signed_at: Mapped[datetime]
    cosigned_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    cosigned_at: Mapped[datetime | None]
    # Why the previous version was unlocked and changed (empty for the first version).
    reason: Mapped[str] = mapped_column(EncryptedText("note_revisions.reason"), default="")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    note: Mapped["Note"] = relationship()
    signed_by: Mapped["StaffMember"] = relationship(foreign_keys=[signed_by_id])
    cosigned_by: Mapped["StaffMember | None"] = relationship(foreign_keys=[cosigned_by_id])

    @property
    def integrity(self) -> Integrity:
        """Whether this version still matches the hash taken when it was signed."""
        actual = note_content_sha256(
            note_id=self.note_id,
            client_id=self.note.client_id,
            author_id=self.signed_by_id,
            title=self.title,
            sections=self.sections,
            content=self.content,
            signed_at=self.signed_at,
        )
        return check(self.content_sha256, actual)


class NoteAddendum(Base):
    """An addition to a signed note that leaves the signed text untouched."""

    __tablename__ = "note_addenda"

    id: Mapped[int] = mapped_column(primary_key=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    content: Mapped[str] = mapped_column(EncryptedText("note_addenda.content"))
    content_sha256: Mapped[str] = mapped_column(String(64))
    # Set when the addendum records an accepted amendment request.
    amendment_request_id: Mapped[int | None] = mapped_column(
        ForeignKey("amendment_requests.id", ondelete="SET NULL")
    )
    # Set by the app when the addendum is written, since it's part of the hash.
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    author: Mapped["StaffMember"] = relationship()

    @property
    def integrity(self) -> Integrity:
        """Whether the addendum still matches the hash taken when it was written."""
        actual = addendum_sha256(
            note_id=self.note_id,
            author_id=self.author_id,
            content=self.content,
            amendment_request_id=self.amendment_request_id,
            created_at=self.created_at,
        )
        return check(self.content_sha256, actual)


class RecordRequest(TimestampMixin, Base):
    """A request for a copy of a client's record (right of access): due within 30 days, with at
    most one 30-day extension."""

    __tablename__ = "record_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    # client | contact | staff (entered on the client's behalf)
    requested_by: Mapped[str] = mapped_column(String(20))
    requested_by_contact_id: Mapped[int | None] = mapped_column(
        ForeignKey("client_contacts.id", ondelete="SET NULL")
    )
    received_at: Mapped[datetime]
    due_on: Mapped[date]
    extended_on: Mapped[date | None]
    extension_reason: Mapped[str] = mapped_column(Text, default="")
    # What was asked for, e.g. "complete record" or "notes from 2025".
    scope: Mapped[str] = mapped_column(EncryptedText("record_requests.scope"), default="")
    delivery: Mapped[str] = mapped_column(String(20), default=RecordDelivery.PORTAL)
    # Who and where to send it for third-party delivery (a person or organization the client
    # designates, with an address).
    recipient: Mapped[str] = mapped_column(EncryptedText("record_requests.recipient"), default="")
    status: Mapped[str] = mapped_column(String(20), default=RecordRequestStatus.OPEN)
    fulfilled_at: Mapped[datetime | None]
    fulfilled_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    # The released copy in the client's portal, removed once it expires.
    file_id: Mapped[int | None] = mapped_column(ForeignKey("stored_files.id", ondelete="SET NULL"))
    release_expires_at: Mapped[datetime | None]
    denial_reason: Mapped[str] = mapped_column(
        EncryptedText("record_requests.denial_reason"), default=""
    )

    client: Mapped["Client"] = relationship()
    fulfilled_by: Mapped["StaffMember | None"] = relationship()


class Disclosure(Base):
    """A disclosure of a client's information outside treatment, payment and operations, kept
    six years for the accounting of disclosures."""

    __tablename__ = "disclosures"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    disclosed_on: Mapped[date]
    recipient_name: Mapped[str] = mapped_column(EncryptedText("disclosures.recipient_name"))
    recipient_address: Mapped[str] = mapped_column(
        EncryptedText("disclosures.recipient_address"), default=""
    )
    description: Mapped[str] = mapped_column(EncryptedText("disclosures.description"))
    purpose: Mapped[str] = mapped_column(EncryptedText("disclosures.purpose"))
    # e.g. "court order", "public health", "client authorization"
    legal_basis: Mapped[str] = mapped_column(String(100), default="")
    source: Mapped[str] = mapped_column(String(20), default=DisclosureSource.MANUAL)
    record_request_id: Mapped[int | None] = mapped_column(
        ForeignKey("record_requests.id", ondelete="SET NULL")
    )
    recorded_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    recorded_by: Mapped["StaffMember | None"] = relationship()


class AmendmentRequest(TimestampMixin, Base):
    """A client's request to amend their record: decided within 60 days. Accepted requests add
    an addendum; denials keep the reason, the client's disagreement and any rebuttal."""

    __tablename__ = "amendment_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    note_id: Mapped[int | None] = mapped_column(ForeignKey("notes.id", ondelete="SET NULL"))
    requested_by: Mapped[str] = mapped_column(String(20))
    received_at: Mapped[datetime]
    due_on: Mapped[date]
    request: Mapped[str] = mapped_column(EncryptedText("amendment_requests.request"))
    status: Mapped[str] = mapped_column(String(20), default=AmendmentStatus.OPEN)
    decided_at: Mapped[datetime | None]
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    denial_reason: Mapped[str] = mapped_column(
        EncryptedText("amendment_requests.denial_reason"), default=""
    )
    disagreement: Mapped[str] = mapped_column(
        EncryptedText("amendment_requests.disagreement"), default=""
    )
    rebuttal: Mapped[str] = mapped_column(EncryptedText("amendment_requests.rebuttal"), default="")

    client: Mapped["Client"] = relationship()
    note: Mapped["Note | None"] = relationship()
    decided_by: Mapped["StaffMember | None"] = relationship()
