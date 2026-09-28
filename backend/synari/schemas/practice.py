"""Practice details, personal profile and preferences, settings, locations and services."""

from pydantic import Field

from synari.models.enums import BillingProviderType, TaxIdType
from synari.schemas.common import LongText, PartialUpdate, Schema, ShortText, TimeZone

NOTE_FORMATS = ("SOAP", "DAP", "BIRP", "GIRP", "PIRP", "SIRP", "FREEFORM")


NPI_PATTERN = r"^(\d{10})?$"
TAXONOMY_PATTERN = r"^([0-9A-Z]{9}X)?$"
SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$"


class PracticeUpdate(PartialUpdate):
    """Practice details (owner or a role that manages the practice)."""

    NULLABLE = frozenset({"booking_slug"})

    name: ShortText | None = Field(default=None, min_length=1)
    phone: str | None = Field(default=None, max_length=30)
    address_line1: ShortText | None = None
    address_line2: ShortText | None = None
    city: ShortText | None = None
    state: ShortText | None = None
    postal_code: str | None = Field(default=None, max_length=20)
    time_zone: TimeZone | None = None
    tax_id: str | None = Field(default=None, pattern=r"^(\d{2}-?\d{7}|\d{3}-?\d{2}-?\d{4})?$")
    tax_id_type: TaxIdType | None = None
    npi: str | None = Field(default=None, pattern=NPI_PATTERN)
    taxonomy_code: str | None = Field(default=None, pattern=TAXONOMY_PATTERN)
    billing_provider: BillingProviderType | None = None
    booking_slug: str | None = Field(default=None, pattern=SLUG_PATTERN)


class ProfileUpdate(PartialUpdate):
    """A staff member's own professional details."""

    first_name: ShortText | None = Field(default=None, min_length=1)
    last_name: ShortText | None = Field(default=None, min_length=1)
    credentials: str | None = Field(default=None, max_length=100)
    license_number: str | None = Field(default=None, max_length=50)
    license_state: str | None = Field(default=None, max_length=50)
    npi: str | None = Field(default=None, pattern=NPI_PATTERN)
    taxonomy_code: str | None = Field(default=None, pattern=TAXONOMY_PATTERN)
    phone: str | None = Field(default=None, max_length=30)
    time_zone: TimeZone | None = None
    accepting_new_clients: bool | None = None


class PreferencesFields(Schema):
    away_message_enabled: bool
    away_message: str = Field(max_length=600)
    note_format_default: str = Field(pattern="^(" + "|".join(NOTE_FORMATS) + ")$")
    ai_style_instructions: LongText
    notify_email_messages: bool
    notify_email_requests: bool
    notify_email_forms: bool


class PreferencesOut(PreferencesFields):
    pass


class PreferencesUpdate(PartialUpdate):
    """A staff member's own messaging, documentation and notification preferences."""

    away_message_enabled: bool | None = None
    away_message: str | None = Field(default=None, max_length=600)
    note_format_default: str | None = Field(
        default=None, pattern="^(" + "|".join(NOTE_FORMATS) + ")$"
    )
    ai_style_instructions: LongText | None = None
    notify_email_messages: bool | None = None
    notify_email_requests: bool | None = None
    notify_email_forms: bool | None = None


class SettingsFields(Schema):
    cancellation_window_hours: int = Field(ge=0, le=168)
    booking_enabled: bool
    booking_accepts_new_clients: bool
    booking_min_notice_hours: int = Field(ge=0, le=720)
    booking_max_days_ahead: int = Field(ge=1, le=365)
    booking_slot_interval_minutes: int = Field(ge=0, le=240)
    booking_intro: LongText
    reminder_email_enabled: bool
    reminder_email_hours: int = Field(ge=1, le=168)
    reminder_sms_enabled: bool
    reminder_sms_hours: int = Field(ge=1, le=168)
    messaging_enabled: bool
    waiting_room_enabled: bool
    recording_enabled: bool
    bill_missed_appointments: bool
    autopay_enabled: bool
    invoice_due_days: int = Field(ge=0, le=90)
    # Years to keep records after a client's last activity (state law may require more).
    record_retention_years: int
    # Good Faith Estimates (No Surprises Act) for self-pay clients.
    gfe_enabled: bool


class SettingsOut(SettingsFields):
    pass


class SettingsUpdate(PartialUpdate):
    """Partial update of practice-wide settings."""

    cancellation_window_hours: int | None = Field(default=None, ge=0, le=168)
    booking_enabled: bool | None = None
    booking_accepts_new_clients: bool | None = None
    booking_min_notice_hours: int | None = Field(default=None, ge=0, le=720)
    booking_max_days_ahead: int | None = Field(default=None, ge=1, le=365)
    booking_slot_interval_minutes: int | None = Field(default=None, ge=0, le=240)
    booking_intro: LongText | None = None
    reminder_email_enabled: bool | None = None
    reminder_email_hours: int | None = Field(default=None, ge=1, le=168)
    reminder_sms_enabled: bool | None = None
    reminder_sms_hours: int | None = Field(default=None, ge=1, le=168)
    messaging_enabled: bool | None = None
    waiting_room_enabled: bool | None = None
    recording_enabled: bool | None = None
    bill_missed_appointments: bool | None = None
    autopay_enabled: bool | None = None
    invoice_due_days: int | None = Field(default=None, ge=0, le=90)
    record_retention_years: int | None = Field(default=None, ge=6, le=100)
    gfe_enabled: bool | None = None


class LocationFields(Schema):
    name: ShortText = Field(min_length=1)
    address_line1: ShortText = ""
    address_line2: ShortText = ""
    city: ShortText = ""
    state: ShortText = ""
    postal_code: str = Field(default="", max_length=20)
    place_of_service: str = Field(default="11", pattern=r"^\d{2}$")
    is_video: bool = False
    is_active: bool = True


class LocationOut(LocationFields):
    id: int


class LocationUpdate(PartialUpdate):
    name: ShortText | None = Field(default=None, min_length=1)
    address_line1: ShortText | None = None
    address_line2: ShortText | None = None
    city: ShortText | None = None
    state: ShortText | None = None
    postal_code: str | None = Field(default=None, max_length=20)
    place_of_service: str | None = Field(default=None, pattern=r"^\d{2}$")
    is_video: bool | None = None
    is_active: bool | None = None


class ServiceFields(Schema):
    code: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9-]+$")
    description: ShortText = Field(min_length=1)
    duration_minutes: int = Field(ge=5, le=600)
    rate_cents: int = Field(ge=0, le=10_000_000)
    is_default: bool = False
    is_active: bool = True
    bookable_online: bool = False
    bookable_by_new_clients: bool = False


class ServiceUpdate(PartialUpdate):
    code: str | None = Field(default=None, min_length=1, max_length=20, pattern=r"^[A-Za-z0-9-]+$")
    description: ShortText | None = Field(default=None, min_length=1)
    duration_minutes: int | None = Field(default=None, ge=5, le=600)
    rate_cents: int | None = Field(default=None, ge=0, le=10_000_000)
    is_default: bool | None = None
    is_active: bool | None = None
    bookable_online: bool | None = None
    bookable_by_new_clients: bool | None = None


class ServiceOut(ServiceFields):
    id: int
