"""Good Faith Estimates for self-pay and uninsured clients (No Surprises Act, 45 CFR 149.610).

An issued estimate is part of the medical record: it's never edited or deleted. A change in
services, fees or frequency issues a new estimate that supersedes the old one.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON
from synari.db import Base, TimestampMixin
from synari.models.enums import GoodFaithEstimateStatus

if TYPE_CHECKING:
    from synari.models.clients import Client


class GoodFaithEstimate(TimestampMixin, Base):
    """The expected charges for a client's care over a period of up to 12 months."""

    __tablename__ = "good_faith_estimates"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    # The clinician whose services are estimated (the convening provider).
    clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    status: Mapped[str] = mapped_column(String(20), default=GoodFaithEstimateStatus.DRAFT)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey("good_faith_estimates.id"))
    # What changed from the estimate it replaces.
    change_summary: Mapped[str] = mapped_column(Text, default="")

    # Why it was needed and by when: scheduling (1 or 3 business days), request (3 business
    # days), update (1 business day before the next session) or manual.
    reason: Mapped[str] = mapped_column(String(20), default="manual")
    due_on: Mapped[date | None]

    period_start: Mapped[date]
    period_end: Mapped[date]
    primary_service: Mapped[str] = mapped_column(String(300))
    # Scheduled dates of service, or empty when not yet scheduled.
    scheduled_dates: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Diagnosis codes if determined: [{"code", "description"}].
    diagnosis_codes: Mapped[list[dict[str, str]]] = mapped_column(
        EncryptedJSON("good_faith_estimates.diagnosis_codes"), default=list
    )
    # The provider as printed on the estimate when issued: name, type, address, contact,
    # phone, email, NPI, TIN, locations.
    provider: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Items expected to be scheduled separately by other providers: [{"description",
    # "provider", "note"}].
    separately_scheduled: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    total_cents: Mapped[int] = mapped_column(default=0)

    issued_at: Mapped[datetime | None]
    issued_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    # portal | email | paper | mail
    delivery_method: Mapped[str] = mapped_column(String(20), default="portal")
    file_id: Mapped[int | None] = mapped_column(ForeignKey("stored_files.id", ondelete="SET NULL"))
    pdf_sha256: Mapped[str] = mapped_column(String(64), default="")
    # Optional acknowledgment of receipt by the client (never required).
    acknowledged_at: Mapped[datetime | None]
    acknowledged_name: Mapped[str] = mapped_column(String(200), default="")
    acknowledged_ip: Mapped[str] = mapped_column(String(45), default="")
    acknowledged_user_agent: Mapped[str] = mapped_column(String(300), default="")
    # Withdrawn: a draft nobody needs, or an estimate issued in error (with why).
    voided_at: Mapped[datetime | None]
    void_reason: Mapped[str] = mapped_column(Text, default="")
    # When staff were told the estimate expires within 30 days, and that a draft is overdue.
    expiry_notified_at: Mapped[datetime | None]
    overdue_notified_at: Mapped[datetime | None]

    client: Mapped["Client"] = relationship()
    items: Mapped[list["GoodFaithEstimateItem"]] = relationship(
        back_populates="estimate",
        cascade="all, delete-orphan",
        order_by="GoodFaithEstimateItem.id",
        lazy="selectin",
    )


class GoodFaithEstimateItem(Base):
    """One expected service: code, fee, how many, how often."""

    __tablename__ = "good_faith_estimate_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    estimate_id: Mapped[int] = mapped_column(
        ForeignKey("good_faith_estimates.id", ondelete="CASCADE"), index=True
    )
    description: Mapped[str] = mapped_column(String(300))
    service_code: Mapped[str] = mapped_column(String(20), default="")
    location: Mapped[str] = mapped_column(String(300), default="")
    # Letters pointing into the estimate's diagnosis list, e.g. ["A"].
    diagnosis_pointers: Mapped[list[str]] = mapped_column(JSON, default=list)
    unit_fee_cents: Mapped[int]
    quantity: Mapped[int] = mapped_column(default=1)
    # e.g. "Weekly", "Every other week"
    frequency: Mapped[str] = mapped_column(String(100), default="")
    total_cents: Mapped[int]

    estimate: Mapped[GoodFaithEstimate] = relationship(back_populates="items")
