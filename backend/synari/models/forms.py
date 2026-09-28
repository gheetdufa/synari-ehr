"""Intake, consent and assessment forms: templates and the copies sent to clients."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.integrity import Integrity, check, form_signature_sha256
from synari.models.enums import ClientFormStatus, FormKind

# A field is a dict like:
#   {"id": "q1", "type": "single_choice", "label": "...", "required": true,
#    "options": [{"label": "Not at all", "value": 0}, ...]}
# Types: heading, paragraph, short_text, long_text, date, single_choice, multi_choice, yes_no.
# Optional keys: "help" (hint text) and "maps_to" (a Client column the answer may fill in).
FormFields = list[dict[str, Any]]


class FormTemplate(TimestampMixin, Base):
    """A reusable form owned by a practice. Library assessments keep their library_key."""

    __tablename__ = "form_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    fields: Mapped[FormFields] = mapped_column(JSON, default=list)
    scoring: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    requires_signature: Mapped[bool] = mapped_column(default=False)
    library_key: Mapped[str | None] = mapped_column(String(50))
    is_active: Mapped[bool] = mapped_column(default=True)

    @property
    def read_only(self) -> bool:
        """Library assessments can't be edited, so their validated scoring stays intact."""
        return self.library_key is not None and self.kind == FormKind.ASSESSMENT


class ClientForm(Base):
    """A form shared with a client; fields are snapshotted so template edits don't alter it."""

    __tablename__ = "client_forms"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    template_id: Mapped[int | None] = mapped_column(
        ForeignKey("form_templates.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    fields: Mapped[FormFields] = mapped_column(JSON)
    scoring: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    requires_signature: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(20), default=ClientFormStatus.PENDING)

    sent_at: Mapped[datetime] = mapped_column(server_default=func.now())
    viewed_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    last_reminded_at: Mapped[datetime | None]
    reminder_count: Mapped[int] = mapped_column(default=0, server_default=text("0"))

    answers: Mapped[dict[str, Any] | None] = mapped_column(EncryptedJSON("client_forms.answers"))
    score: Mapped[int | None]
    score_label: Mapped[str] = mapped_column(String(100), default="")
    flagged: Mapped[bool] = mapped_column(default=False)
    flag_reason: Mapped[str] = mapped_column(String(300), default="")

    signature_name: Mapped[str] = mapped_column(
        EncryptedText("client_forms.signature_name"), default=""
    )
    # SHA-256 of the signed form (fields, answers, signer, time), checked when it is read.
    signature_sha256: Mapped[str] = mapped_column(String(64), default="")
    signed_at: Mapped[datetime | None]
    signer_ip: Mapped[str] = mapped_column(String(45), default="")
    signer_user_agent: Mapped[str] = mapped_column(String(300), default="")

    def compute_signature_sha256(self) -> str:
        """The hash of what was signed (needs `signed_at`)."""
        if self.signed_at is None:
            raise ValueError("Only signed forms have a signature hash")
        return form_signature_sha256(
            form_id=self.id,
            client_id=self.client_id,
            fields=self.fields,
            answers=self.answers,
            signature_name=self.signature_name,
            signed_at=self.signed_at,
        )

    @property
    def signature_integrity(self) -> Integrity | None:
        """Whether the signed form still matches its signature hash (None when unsigned)."""
        if not self.signature_sha256 or self.signed_at is None:
            return None
        return check(self.signature_sha256, self.compute_signature_sha256())
