"""Uploaded file metadata."""

from datetime import datetime

from sqlalchemy import ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from synari.db import Base

# Imported psychotherapy notes (HIPAA 164.501): only their author or the client's primary
# clinician may open them; they're never shared with the client or included in exports.
PSYCHOTHERAPY_NOTES_CATEGORY = "Psychotherapy Notes"


class StoredFile(Base):
    """Metadata for an uploaded file; the bytes live in the configured storage backend."""

    __tablename__ = "stored_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(30))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int]
    storage_key: Mapped[str] = mapped_column(String(300), unique=True)
    uploaded_by: Mapped[str] = mapped_column(String(20))
    uploaded_by_staff_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    # Where an imported document came from (e.g. "Medical Records"); empty otherwise.
    category: Mapped[str] = mapped_column(String(80), default="")
    # The file's own AES-256-GCM key, encrypted with the master key (synari/crypto.py).
    # Deleting it makes the stored bytes unreadable (crypto-shredding).
    wrapped_key: Mapped[str | None] = mapped_column(Text)
    shared_with_client: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
