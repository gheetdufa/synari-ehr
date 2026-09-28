"""All ORM models; importing this package registers every table on Base.metadata."""

from synari.models.accounts import AuthToken, Location, Practice, PracticeSettings, StaffMember
from synari.models.audit import AuditEvent
from synari.models.billing import (
    Invoice,
    InvoiceItem,
    Payment,
    PaymentAllocation,
    SavedCard,
    Superbill,
)
from synari.models.calendar_sync import CalendarConnection, CalendarEventLink, ExternalBusyBlock
from synari.models.clients import Client, ClientClinician, ClientContact, InsurancePolicy
from synari.models.estimates import GoodFaithEstimate, GoodFaithEstimateItem
from synari.models.files import StoredFile
from synari.models.forms import ClientForm, FormTemplate
from synari.models.imports import ImportJob, ImportRecord
from synari.models.insurance import (
    Claim,
    ClaimEvent,
    ClaimLine,
    EligibilityCheck,
    Payer,
    PriorAuthorization,
    Remittance,
    RemittanceClaim,
)
from synari.models.messaging import Conversation, Message, MessageAttachment
from synari.models.notes import Note
from synari.models.notifications import Notification, OutboundMessage
from synari.models.records import (
    AmendmentRequest,
    Disclosure,
    NoteAddendum,
    NoteRevision,
    RecordRequest,
)
from synari.models.scheduling import (
    Appointment,
    AppointmentParticipant,
    AppointmentSeries,
    AvailabilityBlock,
    ClinicianService,
    Service,
)
from synari.models.security import (
    AuditCheckpoint,
    AuthSession,
    EmergencyAccessGrant,
    RateLimitBucket,
    SecurityEvent,
)
from synari.models.telehealth import Recording, WaitingRoomEntry

__all__ = [
    "AmendmentRequest",
    "Appointment",
    "AppointmentParticipant",
    "AppointmentSeries",
    "AuditCheckpoint",
    "AuditEvent",
    "AuthSession",
    "AuthToken",
    "AvailabilityBlock",
    "CalendarConnection",
    "CalendarEventLink",
    "Claim",
    "ClaimEvent",
    "ClaimLine",
    "Client",
    "ClientClinician",
    "ClientContact",
    "ClientForm",
    "ClinicianService",
    "Conversation",
    "Disclosure",
    "EligibilityCheck",
    "EmergencyAccessGrant",
    "ExternalBusyBlock",
    "FormTemplate",
    "GoodFaithEstimate",
    "GoodFaithEstimateItem",
    "ImportJob",
    "ImportRecord",
    "InsurancePolicy",
    "Invoice",
    "InvoiceItem",
    "Location",
    "Message",
    "MessageAttachment",
    "Note",
    "NoteAddendum",
    "NoteRevision",
    "Notification",
    "OutboundMessage",
    "Payer",
    "Payment",
    "PaymentAllocation",
    "Practice",
    "PracticeSettings",
    "PriorAuthorization",
    "RateLimitBucket",
    "RecordRequest",
    "Recording",
    "Remittance",
    "RemittanceClaim",
    "SavedCard",
    "SecurityEvent",
    "Service",
    "StaffMember",
    "StoredFile",
    "Superbill",
    "WaitingRoomEntry",
]
