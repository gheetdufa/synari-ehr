"""Client records and insurance policies."""

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedJSON, EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import BillingType, ClientStatus

if TYPE_CHECKING:
    from synari.models.accounts import Practice, StaffMember
    from synari.models.insurance import Payer, PriorAuthorization


class Client(TimestampMixin, Base):
    """A person receiving care. Clients are archived, never hard-deleted."""

    __tablename__ = "clients"
    __table_args__ = (
        Index(
            "uq_clients_practice_email",
            "practice_id",
            text("lower(email)"),
            unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default=ClientStatus.ACTIVE)

    # Demographics
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    preferred_name: Mapped[str] = mapped_column(String(100), default="")
    pronouns: Mapped[str] = mapped_column(String(50), default="")
    date_of_birth: Mapped[date | None]
    sex: Mapped[str] = mapped_column(String(20), default="")
    gender_identity: Mapped[str] = mapped_column(String(100), default="")
    email: Mapped[str | None] = mapped_column(String(320))
    phone: Mapped[str] = mapped_column(String(30), default="")
    address_line1: Mapped[str] = mapped_column(String(200), default="")
    address_line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    state: Mapped[str] = mapped_column(String(50), default="")
    postal_code: Mapped[str] = mapped_column(String(20), default="")
    time_zone: Mapped[str | None] = mapped_column(String(64))
    # Minors are usually represented by a guardian contact (portal access, billing, consent).
    is_minor: Mapped[bool] = mapped_column(default=False)
    referral_source: Mapped[str] = mapped_column(String(200), default="")
    internal_notes: Mapped[str] = mapped_column(EncryptedText("clients.internal_notes"), default="")

    # Clinical: list of {"code": "F41.1", "description": "Generalized anxiety disorder"}
    diagnosis_codes: Mapped[list[dict[str, str]]] = mapped_column(
        EncryptedJSON("clients.diagnosis_codes"), default=list
    )

    # Billing
    billing_type: Mapped[str] = mapped_column(String(20), default=BillingType.SELF_PAY)
    default_service_id: Mapped[int | None] = mapped_column(
        ForeignKey("services.id", ondelete="SET NULL")
    )
    rate_override_cents: Mapped[int | None]
    stripe_customer_id: Mapped[str | None] = mapped_column(String(100))
    autopay_enabled: Mapped[bool] = mapped_column(default=False)
    autopay_failures: Mapped[int] = mapped_column(default=0)
    last_autopay_attempt_on: Mapped[date | None]

    # Communication consent
    email_reminders: Mapped[bool] = mapped_column(default=True)
    sms_reminders: Mapped[bool] = mapped_column(default=False)
    sms_opted_out: Mapped[bool] = mapped_column(default=False)

    # Client portal permissions
    portal_enabled: Mapped[bool] = mapped_column(default=True)
    portal_messaging: Mapped[bool] = mapped_column(default=True)
    portal_booking: Mapped[bool] = mapped_column(default=True)
    portal_billing: Mapped[bool] = mapped_column(default=True)
    portal_token_version: Mapped[int] = mapped_column(default=0)
    portal_last_login_at: Mapped[datetime | None]

    practice: Mapped["Practice"] = relationship()
    care_team: Mapped[list["ClientClinician"]] = relationship(
        back_populates="client", cascade="all, delete-orphan", lazy="selectin"
    )
    contacts: Mapped[list["ClientContact"]] = relationship(
        back_populates="client", cascade="all, delete-orphan", order_by="ClientContact.id"
    )
    insurance_policies: Mapped[list["InsurancePolicy"]] = relationship(
        back_populates="client",
        cascade="all, delete-orphan",
        order_by="(InsurancePolicy.rank, InsurancePolicy.id)",
    )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def display_first_name(self) -> str:
        return self.preferred_name or self.first_name

    @property
    def primary_clinician(self) -> "StaffMember | None":
        """The clinician mainly responsible for this client, if one is assigned."""
        return next((member.staff for member in self.care_team if member.is_primary), None)

    @property
    def billing_contact(self) -> "ClientContact | None":
        """The contact responsible for this client's bills (e.g. a minor's parent), if any."""
        return next((contact for contact in self.contacts if contact.responsible_for_billing), None)

    @property
    def can_use_portal(self) -> bool:
        return self.portal_enabled and self.status in (
            ClientStatus.ACTIVE,
            ClientStatus.PROSPECTIVE,
        )


class ClientClinician(Base):
    """A clinician on a client's care team. Each client has at most one primary clinician."""

    __tablename__ = "client_clinicians"
    __table_args__ = (
        UniqueConstraint("client_id", "staff_id"),
        Index(
            "uq_client_clinicians_primary",
            "client_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    is_primary: Mapped[bool] = mapped_column(default=False)

    client: Mapped[Client] = relationship(back_populates="care_team")
    staff: Mapped["StaffMember"] = relationship(lazy="joined")


class ClientContact(TimestampMixin, Base):
    """Someone connected to a client: a parent or guardian, partner, or emergency contact.

    Guardians with portal access sign in to the client portal on the client's behalf.
    """

    __tablename__ = "client_contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100), default="")
    relation: Mapped[str] = mapped_column(String(50), default="")  # e.g. Mother, Partner
    email: Mapped[str | None] = mapped_column(String(320), index=True)
    phone: Mapped[str] = mapped_column(String(30), default="")
    is_emergency_contact: Mapped[bool] = mapped_column(default=False)
    is_guardian: Mapped[bool] = mapped_column(default=False)
    responsible_for_billing: Mapped[bool] = mapped_column(default=False)
    portal_access: Mapped[bool] = mapped_column(default=False)
    portal_token_version: Mapped[int] = mapped_column(default=0)
    portal_last_login_at: Mapped[datetime | None]

    client: Mapped[Client] = relationship(back_populates="contacts")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


class InsurancePolicy(TimestampMixin, Base):
    """A client's insurance coverage, used on superbills and insurance claims."""

    __tablename__ = "insurance_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    payer_id: Mapped[int] = mapped_column(ForeignKey("payers.id"), index=True)
    rank: Mapped[str] = mapped_column(String(20), default="primary")
    member_id: Mapped[str] = mapped_column(
        EncryptedText("insurance_policies.member_id"), default=""
    )
    group_number: Mapped[str] = mapped_column(
        EncryptedText("insurance_policies.group_number"), default=""
    )
    plan_name: Mapped[str] = mapped_column(String(200), default="")

    # The subscriber (policyholder). With relationship "18" (self) the client is the subscriber;
    # otherwise the X12 patient relationship code: 01 spouse, 19 child, 20 employee, 21 unknown,
    # 53 life partner, G8 other.
    subscriber_relationship: Mapped[str] = mapped_column(String(2), default="18")
    subscriber_first_name: Mapped[str] = mapped_column(String(100), default="")
    subscriber_last_name: Mapped[str] = mapped_column(String(100), default="")
    subscriber_dob: Mapped[date | None]
    subscriber_sex: Mapped[str] = mapped_column(String(1), default="")
    subscriber_address_line1: Mapped[str] = mapped_column(String(200), default="")
    subscriber_address_line2: Mapped[str] = mapped_column(String(200), default="")
    subscriber_city: Mapped[str] = mapped_column(String(100), default="")
    subscriber_state: Mapped[str] = mapped_column(String(50), default="")
    subscriber_postal_code: Mapped[str] = mapped_column(String(20), default="")

    # Blank uses the payer's claim filing indicator (CI commercial, MB Medicare, MC Medicaid...).
    claim_filing_indicator: Mapped[str] = mapped_column(String(2), default="")
    effective_date: Mapped[date | None]
    termination_date: Mapped[date | None]
    copay_cents: Mapped[int | None]
    coinsurance_percent: Mapped[int | None]

    client: Mapped[Client] = relationship(back_populates="insurance_policies")
    payer: Mapped["Payer"] = relationship(lazy="joined")
    authorizations: Mapped[list["PriorAuthorization"]] = relationship(
        back_populates="policy",
        cascade="all, delete-orphan",
        order_by="PriorAuthorization.start_date",
    )
