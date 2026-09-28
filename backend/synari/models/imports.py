"""Importing a practice's records from another system (starting with SimplePractice)."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from synari.db import Base, TimestampMixin
from synari.models.enums import ImportStatus


class ImportJob(TimestampMixin, Base):
    """One import: uploaded source files, the analysis the practice reviews, and the result."""

    __tablename__ = "import_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    source: Mapped[str] = mapped_column(String(30), default="simplepractice")
    status: Mapped[str] = mapped_column(String(20), default=ImportStatus.UPLOADED)
    # The uploaded files: [{"file_id", "kind", "filename"}]; kind is e.g. export_zip,
    # client_details, client_demographics, appointment_status, attendance,
    # outstanding_balances, client_list.
    files: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # Column mapping per file kind, adjustable by the practice before importing.
    mapping: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Counts, sample rows, clients needing a manual match and warnings (no clinical content).
    preview: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Choices made on the preview: default clinician, how to treat unmatched clients...
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Created, updated and skipped counts and any warnings.
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]


class ImportRecord(Base):
    """What an import created for one source record, so re-running an import doesn't duplicate."""

    __tablename__ = "import_records"
    __table_args__ = (Index("ix_import_records_lookup", "practice_id", "kind", "source_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("import_jobs.id", ondelete="CASCADE"), index=True
    )
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"))
    # client | contact | policy | appointment | document | balance
    kind: Mapped[str] = mapped_column(String(20))
    # A stable key derived from the source (e.g. normalized name + date of birth).
    source_key: Mapped[str] = mapped_column(String(300))
    target_id: Mapped[int | None]
    # created | updated | skipped | failed
    outcome: Mapped[str] = mapped_column(String(20))
    message: Mapped[str] = mapped_column(Text, default="")
