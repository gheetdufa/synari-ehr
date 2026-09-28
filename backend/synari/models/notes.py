"""Clinical documentation."""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.integrity import Integrity, check, note_content_sha256
from synari.models.enums import NoteStatus, NoteType, RiskLevel

if TYPE_CHECKING:
    from synari.models.accounts import StaffMember
    from synari.models.clients import Client
    from synari.models.records import NoteAddendum, NoteRevision
    from synari.models.scheduling import Appointment


class Note(TimestampMixin, Base):
    """A clinical note. Signed notes are locked until their author unlocks them."""

    __tablename__ = "notes"
    __table_args__ = (
        # The notes list, newest first, and counting a practice's notes without the note text.
        Index("ix_notes_practice_created", "practice_id", "created_at", "id"),
        Index("ix_notes_practice_client", "practice_id", "client_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"))
    # The clinician who wrote (and signs) the note.
    author_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id", ondelete="SET NULL"), index=True
    )
    note_type: Mapped[str] = mapped_column(String(30), default=NoteType.PROGRESS)
    format: Mapped[str] = mapped_column(String(20), default="SOAP")
    title: Mapped[str] = mapped_column(EncryptedText("notes.title"), default="")
    # Ordered section text keyed by section id, e.g. {"subjective": "...", "objective": "..."}
    sections: Mapped[dict[str, str]] = mapped_column(EncryptedJSON("notes.sections"), default=dict)
    content: Mapped[str] = mapped_column(EncryptedText("notes.content"), default="")
    status: Mapped[str] = mapped_column(String(20), default=NoteStatus.DRAFT)
    signed_at: Mapped[datetime | None]
    # SHA-256 of the signed content (see synari/integrity.py), checked whenever it's read.
    # Empty while the note is a draft.
    content_sha256: Mapped[str] = mapped_column(String(64), default="")
    # Why the signed note was unlocked (or sent back); saved on the next signed revision.
    pending_revision_reason: Mapped[str] = mapped_column(
        EncryptedText("notes.pending_revision_reason"), default=""
    )
    # Supervision: a supervisee's signed note waits for this supervisor's co-signature.
    supervisor_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    cosigned_at: Mapped[datetime | None]
    # The supervisor's comment when sending the note back for edits.
    supervisor_comment: Mapped[str] = mapped_column(
        EncryptedText("notes.supervisor_comment"), default=""
    )
    # Set on first signature and never cleared, so once-signed notes can't be deleted.
    was_signed: Mapped[bool] = mapped_column(default=False, server_default="false")
    ai_generated: Mapped[bool] = mapped_column(default=False)
    risk_level: Mapped[str] = mapped_column(String(20), default=RiskLevel.NONE)
    # Safety concerns the AI noticed in the source material, for the clinician to review.
    risk_flags: Mapped[list[str]] = mapped_column(EncryptedJSON("notes.risk_flags"), default=list)

    author: Mapped["StaffMember"] = relationship(foreign_keys=[author_id])
    supervisor: Mapped["StaffMember | None"] = relationship(foreign_keys=[supervisor_id])
    client: Mapped["Client"] = relationship()
    appointment: Mapped["Appointment | None"] = relationship()
    # Each signed version, oldest first, and the addenda written after signing.
    revisions: Mapped[list["NoteRevision"]] = relationship(
        order_by="NoteRevision.version", viewonly=True
    )
    addenda: Mapped[list["NoteAddendum"]] = relationship(order_by="NoteAddendum.id", viewonly=True)

    def compute_content_sha256(self) -> str:
        """The signature hash of the note's current text (needs `signed_at`)."""
        if self.signed_at is None:
            raise ValueError("Only signed notes have a signature hash")
        return note_content_sha256(
            note_id=self.id,
            client_id=self.client_id,
            author_id=self.author_id,
            title=self.title,
            sections=self.sections,
            content=self.content,
            signed_at=self.signed_at,
        )

    @property
    def integrity(self) -> Integrity | None:
        """Whether the signed text still matches its signature hash (None for drafts)."""
        if not self.content_sha256 or self.signed_at is None:
            return None
        return check(self.content_sha256, self.compute_content_sha256())

    @property
    def is_psychotherapy(self) -> bool:
        """Psychotherapy notes are kept apart from the rest of the record (HIPAA 164.501)."""
        return self.note_type == NoteType.PSYCHOTHERAPY

    @property
    def appointment_starts_at(self) -> datetime | None:
        """When the linked session took place (for lists and exports)."""
        return self.appointment.starts_at if self.appointment is not None else None
