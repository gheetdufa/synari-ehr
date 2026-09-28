"""Insurance billing: payers, authorizations, eligibility checks, claims and remittances (ERAs).

Claims are built from attended appointment participants, validated and turned into 837P files
or clearinghouse submissions by the DB-free `synari.claims` package. Remittances (835s) post
insurance payments and adjustments back onto claim lines and the client's balance.
"""

from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, ColumnElement, ForeignKey, String, Text, UniqueConstraint, case, func
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import (
    ClaimStatus,
    ClaimSubmissionMethod,
    EligibilityStatus,
    RemittanceStatus,
)

if TYPE_CHECKING:
    from synari.models.clients import Client, InsurancePolicy

# Claims the payer owes nothing more on.
CLOSED_WITHOUT_BALANCE = (ClaimStatus.VOID, ClaimStatus.DENIED)


class Payer(TimestampMixin, Base):
    """An insurance company on the practice's payer list."""

    __tablename__ = "payers"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    # The clearinghouse's payer ID (blank for payers billed on paper only).
    external_id: Mapped[str] = mapped_column(String(50), default="")
    address_line1: Mapped[str] = mapped_column(String(200), default="")
    address_line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    state: Mapped[str] = mapped_column(String(50), default="")
    postal_code: Mapped[str] = mapped_column(String(20), default="")
    # X12 claim filing indicator: CI commercial, BL Blue Cross, HM HMO, MB Medicare Part B,
    # MC Medicaid, CH Tricare, ...
    claim_filing_indicator: Mapped[str] = mapped_column(String(2), default="CI")
    # Whether the practice is enrolled to receive ERAs (835s) from this payer.
    era_enrolled: Mapped[bool] = mapped_column(default=False)
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(default=True)


class PriorAuthorization(TimestampMixin, Base):
    """An insurer's approval for a number of visits in a date range."""

    __tablename__ = "prior_authorizations"

    id: Mapped[int] = mapped_column(primary_key=True)
    policy_id: Mapped[int] = mapped_column(
        ForeignKey("insurance_policies.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[str] = mapped_column(String(50))
    start_date: Mapped[date]
    end_date: Mapped[date]
    visits_authorized: Mapped[int | None]
    notes: Mapped[str] = mapped_column(EncryptedText("prior_authorizations.notes"), default="")

    policy: Mapped["InsurancePolicy"] = relationship(back_populates="authorizations")


class EligibilityCheck(Base):
    """The result of a real-time insurance eligibility check (270/271)."""

    __tablename__ = "eligibility_checks"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    policy_id: Mapped[int] = mapped_column(
        ForeignKey("insurance_policies.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default=EligibilityStatus.ERROR)
    # Plan, dates, mental-health copay/coinsurance/deductible and payer messages.
    result: Mapped[dict[str, Any]] = mapped_column(
        EncryptedJSON("eligibility_checks.result"), default=dict
    )
    error: Mapped[str] = mapped_column(Text, default="")
    checked_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)


class Claim(TimestampMixin, Base):
    """A professional (CMS-1500 / 837P) claim to one payer for one client."""

    __tablename__ = "claims"
    __table_args__ = (UniqueConstraint("practice_id", "patient_control_number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    policy_id: Mapped[int] = mapped_column(ForeignKey("insurance_policies.id"))
    payer_id: Mapped[int] = mapped_column(ForeignKey("payers.id"), index=True)
    # P primary, S secondary, T tertiary.
    payer_responsibility: Mapped[str] = mapped_column(String(1), default="P")
    status: Mapped[str] = mapped_column(String(20), default=ClaimStatus.DRAFT, index=True)
    submission_method: Mapped[str] = mapped_column(String(20), default=ClaimSubmissionMethod.STEDI)
    # Our claim number on the claim and in the payer's remittance (<= 17 characters).
    patient_control_number: Mapped[str] = mapped_column(String(17))
    # 1 original, 7 replacement (corrected), 8 void; 7 and 8 reference the payer's claim number.
    frequency_code: Mapped[str] = mapped_column(String(1), default="1")
    original_claim_id: Mapped[int | None] = mapped_column(ForeignKey("claims.id"))
    # For secondary claims: the primary claim whose remittance supplies the COB data.
    primary_claim_id: Mapped[int | None] = mapped_column(ForeignKey("claims.id"))
    payer_claim_number: Mapped[str] = mapped_column(String(50), default="")

    rendering_clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    supervising_clinician_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    place_of_service: Mapped[str] = mapped_column(String(2), default="11")
    prior_authorization_number: Mapped[str] = mapped_column(String(50), default="")
    diagnosis_codes: Mapped[list[str]] = mapped_column(
        EncryptedJSON("claims.diagnosis_codes"), default=list
    )

    total_charge_cents: Mapped[int] = mapped_column(default=0)
    paid_cents: Mapped[int] = mapped_column(default=0)
    adjustment_cents: Mapped[int] = mapped_column(default=0)
    patient_responsibility_cents: Mapped[int] = mapped_column(default=0)

    # The clearinghouse's id for the submission, for matching acknowledgments.
    clearinghouse_ref: Mapped[str] = mapped_column(String(100), default="")
    submitted_at: Mapped[datetime | None]
    adjudicated_at: Mapped[datetime | None]
    # The claim document exactly as last submitted or exported.
    snapshot: Mapped[dict[str, Any] | None] = mapped_column(EncryptedJSON("claims.snapshot"))
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))

    client: Mapped["Client"] = relationship()
    policy: Mapped["InsurancePolicy"] = relationship()
    payer: Mapped[Payer] = relationship()
    lines: Mapped[list["ClaimLine"]] = relationship(
        back_populates="claim", cascade="all, delete-orphan", order_by="ClaimLine.service_date"
    )
    events: Mapped[list["ClaimEvent"]] = relationship(
        back_populates="claim", cascade="all, delete-orphan", order_by="ClaimEvent.id"
    )

    @hybrid_property
    def insurance_balance_cents(self) -> int:
        """Charges not yet paid, adjusted or moved to the client."""
        if self.status in CLOSED_WITHOUT_BALANCE:
            return 0
        return (
            self.total_charge_cents
            - self.paid_cents
            - self.adjustment_cents
            - self.patient_responsibility_cents
        )

    @insurance_balance_cents.inplace.expression
    @classmethod
    def _insurance_balance_expression(cls) -> ColumnElement[int]:
        return case(
            (cls.status.in_(CLOSED_WITHOUT_BALANCE), 0),
            else_=cls.total_charge_cents
            - cls.paid_cents
            - cls.adjustment_cents
            - cls.patient_responsibility_cents,
        )


class ClaimLine(Base):
    """One service line: a date of service for one appointment participant."""

    __tablename__ = "claim_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    claim_id: Mapped[int] = mapped_column(ForeignKey("claims.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointment_participants.id"), index=True
    )
    # Echoed back per service line in the remittance (REF*6R).
    line_control_number: Mapped[str] = mapped_column(String(30), unique=True)
    service_date: Mapped[date]
    procedure_code: Mapped[str] = mapped_column(String(10))
    modifiers: Mapped[list[str]] = mapped_column(JSON, default=list)
    units: Mapped[int] = mapped_column(default=1)
    charge_cents: Mapped[int]
    place_of_service: Mapped[str] = mapped_column(String(2), default="")
    diagnosis_pointers: Mapped[list[int]] = mapped_column(JSON, default=list)

    allowed_cents: Mapped[int | None]
    paid_cents: Mapped[int] = mapped_column(default=0)
    adjustment_cents: Mapped[int] = mapped_column(default=0)
    patient_responsibility_cents: Mapped[int] = mapped_column(default=0)

    claim: Mapped[Claim] = relationship(back_populates="lines")


class ClaimEvent(Base):
    """Something that happened to a claim: created, submitted, acknowledged, paid..."""

    __tablename__ = "claim_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    claim_id: Mapped[int] = mapped_column(ForeignKey("claims.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    message: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any] | None] = mapped_column(EncryptedJSON("claim_events.data"))
    staff_id: Mapped[int | None] = mapped_column(ForeignKey("staff_members.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    claim: Mapped[Claim] = relationship(back_populates="events")


class Remittance(Base):
    """An electronic remittance advice (835): one payment from a payer covering claims."""

    __tablename__ = "remittances"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    payer_id: Mapped[int | None] = mapped_column(ForeignKey("payers.id"))
    payer_name: Mapped[str] = mapped_column(String(200), default="")
    # Check or EFT trace number (TRN02).
    trace_number: Mapped[str] = mapped_column(String(50), default="")
    payment_method: Mapped[str] = mapped_column(String(3), default="")
    payment_date: Mapped[date | None]
    total_paid_cents: Mapped[int] = mapped_column(default=0)
    # Provider-level adjustments (PLB), e.g. interest or overpayment recovery.
    provider_adjustments: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default=RemittanceStatus.UNPOSTED)
    source: Mapped[str] = mapped_column(String(20))
    # The clearinghouse transaction id, so the same ERA is never imported twice.
    clearinghouse_ref: Mapped[str | None] = mapped_column(String(100), unique=True)
    file_id: Mapped[int | None] = mapped_column(ForeignKey("stored_files.id"))
    posted_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    claims: Mapped[list["RemittanceClaim"]] = relationship(
        back_populates="remittance", cascade="all, delete-orphan", order_by="RemittanceClaim.id"
    )


class RemittanceClaim(Base):
    """One claim's adjudication in a remittance (CLP loop), matched to our claim when possible."""

    __tablename__ = "remittance_claims"

    id: Mapped[int] = mapped_column(primary_key=True)
    remittance_id: Mapped[int] = mapped_column(
        ForeignKey("remittances.id", ondelete="CASCADE"), index=True
    )
    claim_id: Mapped[int | None] = mapped_column(ForeignKey("claims.id"), index=True)
    patient_control_number: Mapped[str] = mapped_column(String(38))
    # CLP02: 1/2/3 processed as primary/secondary/tertiary, 4 denied, 22 reversal.
    status_code: Mapped[str] = mapped_column(String(2))
    charge_cents: Mapped[int] = mapped_column(default=0)
    paid_cents: Mapped[int] = mapped_column(default=0)
    patient_responsibility_cents: Mapped[int] = mapped_column(default=0)
    payer_claim_number: Mapped[str] = mapped_column(String(50), default="")
    # Claim adjustments (CAS) and service lines (SVC) with their adjustments and remarks.
    detail: Mapped[dict[str, Any]] = mapped_column(
        EncryptedJSON("remittance_claims.detail"), default=dict
    )
    posted_at: Mapped[datetime | None]

    remittance: Mapped[Remittance] = relationship(back_populates="claims")
