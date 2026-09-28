"""Practices, staff accounts, practice settings, office locations and single-use auth tokens."""

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import (
    BillingProviderType,
    ClinicianAccess,
    StaffRole,
    StaffStatus,
    SupervisedBilling,
    TaxIdType,
)


class Practice(TimestampMixin, Base):
    """A practice: the tenant that owns clients, schedules, records and billing."""

    __tablename__ = "practices"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str] = mapped_column(String(30), default="")
    # Billing address. Insurance claims need a street address here, not a PO box.
    address_line1: Mapped[str] = mapped_column(String(200), default="")
    address_line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    state: Mapped[str] = mapped_column(String(50), default="")
    postal_code: Mapped[str] = mapped_column(String(20), default="")
    # Practice-wide wall clock: billing days, invoice dates and practice-wide rules.
    time_zone: Mapped[str] = mapped_column(String(64), default="America/New_York")

    # Insurance billing identity
    tax_id: Mapped[str] = mapped_column(String(20), default="")
    tax_id_type: Mapped[str] = mapped_column(String(3), default=TaxIdType.EIN)
    npi: Mapped[str] = mapped_column(String(10), default="")  # group (type 2) NPI
    taxonomy_code: Mapped[str] = mapped_column(String(10), default="")
    billing_provider: Mapped[str] = mapped_column(
        String(20), default=BillingProviderType.INDIVIDUAL
    )

    booking_slug: Mapped[str | None] = mapped_column(String(80), unique=True)

    settings: Mapped["PracticeSettings"] = relationship(
        back_populates="practice", cascade="all, delete-orphan", uselist=False
    )


class StaffMember(TimestampMixin, Base):
    """A person who works in a practice: clinician, owner, manager, biller or scheduler."""

    __tablename__ = "staff_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    # Empty until an invited staff member accepts and chooses a password.
    password_hash: Mapped[str] = mapped_column(String(100), default="")
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default=StaffStatus.ACTIVE)

    # Access (see synari/permissions.py)
    role: Mapped[str] = mapped_column(String(30), default=StaffRole.OWNER)
    clinician_access: Mapped[str] = mapped_column(String(20), default=ClinicianAccess.BASIC)
    is_clinician: Mapped[bool] = mapped_column(default=True)
    supervisor_id: Mapped[int | None] = mapped_column(
        ForeignKey("staff_members.id", ondelete="SET NULL"), index=True
    )

    # Professional details (clinicians)
    credentials: Mapped[str] = mapped_column(String(100), default="")
    license_number: Mapped[str] = mapped_column(String(50), default="")
    license_state: Mapped[str] = mapped_column(String(50), default="")
    npi: Mapped[str] = mapped_column(String(10), default="")  # individual (type 1) NPI
    taxonomy_code: Mapped[str] = mapped_column(String(10), default="")
    # Licensure modifier some payers (mostly Medicaid) require on this clinician's claim lines,
    # e.g. HO (master's level), AH (psychologist), AJ (clinical social worker).
    claim_modifier: Mapped[str] = mapped_column(String(2), default="")
    phone: Mapped[str] = mapped_column(String(30), default="")
    # Personal wall clock: this person's calendar, availability and reminders.
    time_zone: Mapped[str] = mapped_column(String(64), default="America/New_York")
    accepting_new_clients: Mapped[bool] = mapped_column(default=True)

    # Personal preferences
    away_message_enabled: Mapped[bool] = mapped_column(default=False)
    away_message: Mapped[str] = mapped_column(Text, default="")
    note_format_default: Mapped[str] = mapped_column(String(20), default="SOAP")
    ai_style_instructions: Mapped[str] = mapped_column(Text, default="")
    # Email notifications (content-free; they link back to the app)
    notify_email_messages: Mapped[bool] = mapped_column(default=True)
    notify_email_requests: Mapped[bool] = mapped_column(default=True)
    notify_email_forms: Mapped[bool] = mapped_column(default=True)

    # Hash of the secret in the private calendar-subscription URL (null = feed off).
    calendar_feed_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    token_version: Mapped[int] = mapped_column(default=0)
    # Two-factor authentication (TOTP). The secret is set during setup and only used once enabled.
    mfa_enabled: Mapped[bool] = mapped_column(default=False, server_default="false")
    mfa_secret: Mapped[str | None] = mapped_column(EncryptedText("staff_members.mfa_secret"))
    mfa_recovery_codes: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    # The last TOTP time step used, so a code can't be replayed within its window.
    mfa_last_step: Mapped[int | None]
    # Sign-in throttling: consecutive failures and when the next attempt is allowed.
    failed_logins: Mapped[int] = mapped_column(default=0)
    locked_until: Mapped[datetime | None]
    password_changed_at: Mapped[datetime | None]
    invited_at: Mapped[datetime | None]
    last_login_at: Mapped[datetime | None]

    practice: Mapped[Practice] = relationship()

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def display_name(self) -> str:
        """Name with credentials, e.g. 'Jordan Lee, LCSW'."""
        return f"{self.full_name}, {self.credentials}" if self.credentials else self.full_name

    @property
    def is_active(self) -> bool:
        return self.status == StaffStatus.ACTIVE


class PracticeSettings(Base):
    """Practice-wide configuration for scheduling, reminders, messaging, telehealth and billing."""

    __tablename__ = "practice_settings"

    practice_id: Mapped[int] = mapped_column(
        ForeignKey("practices.id", ondelete="CASCADE"), primary_key=True
    )

    # Scheduling and online booking
    cancellation_window_hours: Mapped[int] = mapped_column(default=24)
    booking_enabled: Mapped[bool] = mapped_column(default=False)
    booking_accepts_new_clients: Mapped[bool] = mapped_column(default=True)
    booking_min_notice_hours: Mapped[int] = mapped_column(default=24)
    booking_max_days_ahead: Mapped[int] = mapped_column(default=60)
    booking_slot_interval_minutes: Mapped[int] = mapped_column(default=0)
    booking_intro: Mapped[str] = mapped_column(Text, default="")

    # Reminders
    reminder_email_enabled: Mapped[bool] = mapped_column(default=True)
    reminder_email_hours: Mapped[int] = mapped_column(default=24)
    reminder_sms_enabled: Mapped[bool] = mapped_column(default=False)
    reminder_sms_hours: Mapped[int] = mapped_column(default=24)

    # Messaging
    messaging_enabled: Mapped[bool] = mapped_column(default=True)

    # Telehealth
    waiting_room_enabled: Mapped[bool] = mapped_column(default=True)
    recording_enabled: Mapped[bool] = mapped_column(default=False)

    # Billing
    bill_missed_appointments: Mapped[bool] = mapped_column(default=True)
    autopay_enabled: Mapped[bool] = mapped_column(default=False)
    invoice_due_days: Mapped[int] = mapped_column(default=0)
    invoice_counter: Mapped[int] = mapped_column(default=0)
    superbill_counter: Mapped[int] = mapped_column(default=0)

    # Insurance claims
    claim_counter: Mapped[int] = mapped_column(default=0)
    # Modifier added to video session lines ("95", "GT" for some Medicaid plans, or none).
    telehealth_modifier: Mapped[str] = mapped_column(String(2), default="95")
    supervised_billing: Mapped[str] = mapped_column(
        String(30), default=SupervisedBilling.SUPERVISOR_RENDERS
    )
    # Envelope ids for 837P files uploaded to a clearinghouse by hand (from its setup guide).
    x12_submitter_id: Mapped[str] = mapped_column(String(80), default="")
    x12_receiver_id: Mapped[str] = mapped_column(String(80), default="")
    x12_receiver_name: Mapped[str] = mapped_column(String(60), default="")
    interchange_counter: Mapped[int] = mapped_column(default=0)
    # Re-check eligibility automatically for active insurance clients.
    eligibility_auto_check: Mapped[bool] = mapped_column(default=False)

    # Security and records
    # Every staff member must set up two-factor authentication before using the app.
    require_staff_mfa: Mapped[bool] = mapped_column(default=True)
    # Sign staff out after this many idle minutes (the server enforces it; at most 60).
    session_idle_minutes: Mapped[int] = mapped_column(default=30)
    # How long records are kept after a client's last activity (state law may require more).
    record_retention_years: Mapped[int] = mapped_column(default=7)

    # Good Faith Estimates (No Surprises Act) for self-pay and uninsured clients.
    gfe_enabled: Mapped[bool] = mapped_column(default=True)

    # Calendar sync: show client initials on synced events (off unless every connected account
    # is covered by a BAA, e.g. Google Workspace or Microsoft 365 with a signed BAA).
    calendar_include_initials: Mapped[bool] = mapped_column(default=False)

    practice: Mapped[Practice] = relationship(back_populates="settings")


class Location(TimestampMixin, Base):
    """An office (or the video office) where appointments take place."""

    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    address_line1: Mapped[str] = mapped_column(String(200), default="")
    address_line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    state: Mapped[str] = mapped_column(String(50), default="")
    postal_code: Mapped[str] = mapped_column(String(20), default="")
    # CMS place-of-service code for claims: 11 office, 10 telehealth at home, 02 elsewhere.
    place_of_service: Mapped[str] = mapped_column(String(2), default="11")
    is_video: Mapped[bool] = mapped_column(default=False)
    is_active: Mapped[bool] = mapped_column(default=True)


class AuthToken(Base):
    """A hashed, single-use token for magic-link sign-in, password reset or a staff invite."""

    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    purpose: Mapped[str] = mapped_column(String(30))
    subject_id: Mapped[int] = mapped_column(index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
