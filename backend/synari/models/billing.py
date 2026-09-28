"""Invoices, payments, saved cards and superbills. All amounts are integer cents."""

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import ForeignKey, Index, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import (
    RECEIVED_PAYMENT_STATUSES,
    InvoiceItemKind,
    InvoiceStatus,
    PaymentStatus,
)

if TYPE_CHECKING:
    from synari.models.clients import Client


class Invoice(TimestampMixin, Base):
    """A bill to a client for one or more services."""

    __tablename__ = "invoices"
    __table_args__ = (
        UniqueConstraint("practice_id", "number"),
        # The invoices list, newest first.
        Index("ix_invoices_practice_issued", "practice_id", "issued_on", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"))
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    number: Mapped[str] = mapped_column(String(30))
    issued_on: Mapped[date]
    due_on: Mapped[date]
    status: Mapped[str] = mapped_column(String(20), default=InvoiceStatus.OPEN)
    total_cents: Mapped[int] = mapped_column(default=0)
    paid_cents: Mapped[int] = mapped_column(default=0)
    notes: Mapped[str] = mapped_column(EncryptedText("invoices.notes"), default="")
    # Who the bill is addressed to when not the client (e.g. a minor's parent), at issue time.
    bill_to_contact_id: Mapped[int | None] = mapped_column(
        ForeignKey("client_contacts.id", ondelete="SET NULL")
    )
    voided_at: Mapped[datetime | None]
    # The client started patient-provider dispute resolution over this bill (No Surprises Act):
    # no reminders, AutoPay, late fees or collections until it's resolved.
    disputed_at: Mapped[datetime | None]
    # Why staff invoiced $400 or more above the client's good faith estimate.
    gfe_override_reason: Mapped[str] = mapped_column(Text, default="")

    items: Mapped[list["InvoiceItem"]] = relationship(
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="(InvoiceItem.service_date, InvoiceItem.id)",
    )
    client: Mapped["Client"] = relationship()

    @property
    def balance_cents(self) -> int:
        if self.status == InvoiceStatus.VOID:
            return 0
        return self.total_cents - self.paid_cents


class InvoiceItem(Base):
    """One line on an invoice: a session (one appointment participant), an adjustment or a fee."""

    __tablename__ = "invoice_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), default=InvoiceItemKind.SERVICE)
    participant_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointment_participants.id"), index=True
    )
    # The clinician who provided the service, recorded when the line is created.
    clinician_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    service_date: Mapped[date]
    service_code: Mapped[str] = mapped_column(String(20), default="")
    description: Mapped[str] = mapped_column(String(300))
    amount_cents: Mapped[int]


class Payment(Base):
    """Money received from a client, by card through Stripe or recorded manually."""

    __tablename__ = "payments"
    __table_args__ = (
        # The payments list, newest first, and money received in a period (overview, reports).
        Index("ix_payments_practice_created", "practice_id", "created_at", "id"),
        Index("ix_payments_practice_received", "practice_id", "received_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"))
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    amount_cents: Mapped[int]
    method: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default=PaymentStatus.PENDING)
    stripe_payment_intent_id: Mapped[str | None] = mapped_column(String(100), unique=True)
    refunded_cents: Mapped[int] = mapped_column(default=0)
    reference: Mapped[str] = mapped_column(String(200), default="")
    failure_reason: Mapped[str] = mapped_column(String(300), default="")
    received_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    allocations: Mapped[list["PaymentAllocation"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by="PaymentAllocation.id"
    )
    client: Mapped["Client"] = relationship()

    @property
    def allocated_cents(self) -> int:
        """How much of this payment is applied to invoices."""
        return sum(allocation.amount_cents for allocation in self.allocations)

    @property
    def refundable_cents(self) -> int:
        """Received money not yet refunded."""
        if self.status not in RECEIVED_PAYMENT_STATUSES:
            return 0
        return self.amount_cents - self.refunded_cents

    @property
    def unapplied_cents(self) -> int:
        """Received money not applied to any invoice: the client's credit from this payment."""
        return self.refundable_cents - self.allocated_cents


class PaymentAllocation(Base):
    """How much of a payment was applied to a given invoice."""

    __tablename__ = "payment_allocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    payment_id: Mapped[int] = mapped_column(
        ForeignKey("payments.id", ondelete="CASCADE"), index=True
    )
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), index=True)
    amount_cents: Mapped[int]


class SavedCard(Base):
    """A client's card saved with Stripe for portal payments and AutoPay."""

    __tablename__ = "saved_cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    stripe_payment_method_id: Mapped[str] = mapped_column(String(100), unique=True)
    brand: Mapped[str] = mapped_column(String(30), default="")
    last4: Mapped[str] = mapped_column(String(4), default="")
    exp_month: Mapped[int] = mapped_column(default=0)
    exp_year: Mapped[int] = mapped_column(default=0)
    is_default: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Superbill(Base):
    """A snapshot of services, diagnoses and payments a client can submit for reimbursement."""

    __tablename__ = "superbills"
    __table_args__ = (UniqueConstraint("practice_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    number: Mapped[str] = mapped_column(String(30))
    period_start: Mapped[date]
    period_end: Mapped[date]
    total_cents: Mapped[int]
    paid_cents: Mapped[int]
    data: Mapped[dict[str, Any]] = mapped_column(EncryptedJSON("superbills.data"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
