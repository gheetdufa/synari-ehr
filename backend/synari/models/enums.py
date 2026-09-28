"""String enums shared by models and API schemas. Values are stored as plain strings."""

from enum import StrEnum


class Role(StrEnum):
    """Who a token or action belongs to: a practice staff member or a client."""

    STAFF = "staff"
    CLIENT = "client"


class StaffRole(StrEnum):
    """A staff member's role in the practice (see synari/permissions.py for what each can do)."""

    OWNER = "owner"
    CLINICIAN = "clinician"
    PRACTICE_MANAGER = "practice_manager"
    BILLER = "biller"
    SCHEDULER = "scheduler"


class ClinicianAccess(StrEnum):
    """How much of the practice a clinician (role CLINICIAN) can see beyond their own clients."""

    BASIC = "basic"
    BILLING = "billing"
    CLIENT_LIST = "client_list"
    PRACTICE = "practice"


class StaffStatus(StrEnum):
    INVITED = "invited"
    ACTIVE = "active"
    DEACTIVATED = "deactivated"


class BillingProviderType(StrEnum):
    """Who bills insurance: each clinician under their own NPI, or the practice's group NPI."""

    INDIVIDUAL = "individual"
    ORGANIZATION = "organization"


class TaxIdType(StrEnum):
    EIN = "EIN"
    SSN = "SSN"


class ClientStatus(StrEnum):
    PROSPECTIVE = "prospective"
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"


class BillingType(StrEnum):
    SELF_PAY = "self_pay"
    INSURANCE = "insurance"


class AppointmentKind(StrEnum):
    APPOINTMENT = "appointment"
    EVENT = "event"


class AppointmentStatus(StrEnum):
    REQUESTED = "requested"
    SCHEDULED = "scheduled"
    ATTENDED = "attended"
    NO_SHOW = "no_show"
    LATE_CANCELED = "late_canceled"
    CANCELED = "canceled"
    DECLINED = "declined"


# Statuses that occupy a slot on the calendar.
ACTIVE_APPOINTMENT_STATUSES = (
    AppointmentStatus.REQUESTED,
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.ATTENDED,
)

# Statuses that generate a charge.
BILLABLE_APPOINTMENT_STATUSES = (
    AppointmentStatus.ATTENDED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.LATE_CANCELED,
)


class LocationType(StrEnum):
    VIDEO = "video"
    IN_PERSON = "in_person"
    PHONE = "phone"


class BookingSource(StrEnum):
    STAFF = "staff"
    # History brought in by an import; never invoiced, claimed, reminded or counted as undocumented.
    IMPORT = "import"
    PORTAL = "portal"
    PUBLIC = "public"


class RecurrenceFrequency(StrEnum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class RiskLevel(StrEnum):
    NONE = "none"
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class FormKind(StrEnum):
    INTAKE = "intake"
    CONSENT = "consent"
    ASSESSMENT = "assessment"
    OTHER = "other"


class ClientFormStatus(StrEnum):
    PENDING = "pending"
    COMPLETED = "completed"


class InvoiceStatus(StrEnum):
    OPEN = "open"
    PAID = "paid"
    VOID = "void"


class PaymentMethod(StrEnum):
    CARD = "card"
    CASH = "cash"
    CHECK = "check"
    EXTERNAL_CARD = "external_card"
    OTHER = "other"


class PaymentStatus(StrEnum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    REFUNDED = "refunded"
    PARTIALLY_REFUNDED = "partially_refunded"


# Payments whose money was received (possibly refunded since).
RECEIVED_PAYMENT_STATUSES = (
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
)


class WaitingStatus(StrEnum):
    WAITING = "waiting"
    ADMITTED = "admitted"
    DECLINED = "declined"
    LEFT = "left"


class RecordingStatus(StrEnum):
    UPLOADED = "uploaded"
    TRANSCRIBING = "transcribing"
    TRANSCRIBED = "transcribed"
    FAILED = "failed"


class NoteStatus(StrEnum):
    DRAFT = "draft"
    # Signed by a supervisee and waiting for their supervisor's co-signature.
    PENDING_COSIGN = "pending_cosign"
    SIGNED = "signed"


class NoteType(StrEnum):
    PROGRESS = "progress"
    INTAKE = "intake"
    TREATMENT_PLAN = "treatment_plan"
    CONSULTATION = "consultation"
    # Kept apart from the rest of the record (HIPAA 164.501): author-only, never exported,
    # shared in the portal, sent to AI or used on claims.
    PSYCHOTHERAPY = "psychotherapy"
    OTHER = "other"


class OutboundChannel(StrEnum):
    EMAIL = "email"
    SMS = "sms"


class OutboundStatus(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    CANCELED = "canceled"


class FilePurpose(StrEnum):
    MESSAGE_ATTACHMENT = "message_attachment"
    CLIENT_UPLOAD = "client_upload"
    SHARED_DOCUMENT = "shared_document"
    RECORDING = "recording"
    # Documents brought in by an import (StoredFile.category keeps the source folder).
    IMPORTED_DOCUMENT = "imported_document"
    # A copy of the record released to the client on request (right of access).
    RECORD_RELEASE = "record_release"
    # A Good Faith Estimate PDF.
    GOOD_FAITH_ESTIMATE = "good_faith_estimate"
    # Uploaded files for an import (removed when the import finishes).
    IMPORT_SOURCE = "import_source"
    REMITTANCE = "remittance"  # an uploaded 835/277CA/999 file (practice-level, no client)


class AuthTokenPurpose(StrEnum):
    CLIENT_LOGIN = "client_login"
    CONTACT_LOGIN = "contact_login"
    PASSWORD_RESET = "password_reset"
    STAFF_INVITE = "staff_invite"


class InvoiceItemKind(StrEnum):
    SERVICE = "service"  # a session (one participant of an appointment)
    ADJUSTMENT = "adjustment"  # a change to what the client owes, e.g. after insurance paid
    CUSTOM = "custom"  # anything else, like a records request


class SupervisedBilling(StrEnum):
    """How claims name the provider for a supervisee's session."""

    SUPERVISOR_RENDERS = "supervisor_renders"  # supervisor as rendering provider
    SUPERVISEE_RENDERS = "supervisee_renders"  # supervisee renders; supervisor in the DQ loop


class ClaimStatus(StrEnum):
    DRAFT = "draft"
    QUEUED = "queued"  # waiting for the worker to send it to the clearinghouse
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"  # accepted by the clearinghouse/payer for processing
    REJECTED = "rejected"  # rejected before processing; fix and resubmit
    DENIED = "denied"  # processed, nothing paid
    PAID = "paid"  # processed with payment (may leave patient responsibility)
    VOID = "void"


# Claims that may still change through clearinghouse responses.
OPEN_CLAIM_STATUSES = (
    ClaimStatus.QUEUED,
    ClaimStatus.SUBMITTED,
    ClaimStatus.ACCEPTED,
)


class ClaimSubmissionMethod(StrEnum):
    STEDI = "stedi"
    X12_FILE = "x12_file"  # downloaded 837P file uploaded to any clearinghouse
    PAPER = "paper"  # printed on a CMS-1500 form


class RemittanceStatus(StrEnum):
    UNPOSTED = "unposted"
    POSTED = "posted"
    NEEDS_REVIEW = "needs_review"


class EligibilityStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    REVIEW = "review"  # the payer answered but the details need a look
    ERROR = "error"


class GoodFaithEstimateStatus(StrEnum):
    DRAFT = "draft"
    ISSUED = "issued"  # given to the client; never edited afterwards
    SUPERSEDED = "superseded"  # replaced by a newer estimate
    VOID = "void"  # withdrawn draft or issued in error


class ImportStatus(StrEnum):
    UPLOADED = "uploaded"
    ANALYZING = "analyzing"
    READY = "ready"  # analyzed; waiting for the practice to review the preview
    IMPORTING = "importing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


class ImportFileKind(StrEnum):
    """What an uploaded import file is (SimplePractice exports and reports)."""

    EXPORT_ZIP = "export_zip"  # Complete data export (documents, contacts, messages)
    CLIENT_DETAILS = "client_details"
    CLIENT_DEMOGRAPHICS = "client_demographics"
    APPOINTMENT_STATUS = "appointment_status"
    ATTENDANCE = "attendance"
    OUTSTANDING_BALANCES = "outstanding_balances"
    CLIENT_LIST = "client_list"  # the "Client List" CSV SimplePractice support can provide


class CalendarProvider(StrEnum):
    GOOGLE = "google"
    MICROSOFT = "microsoft"


class CalendarConnectionStatus(StrEnum):
    ACTIVE = "active"
    NEEDS_REAUTH = "needs_reauth"
    ERROR = "error"
    DISCONNECTED = "disconnected"


class RecordRequestStatus(StrEnum):
    OPEN = "open"
    FULFILLED = "fulfilled"
    DENIED = "denied"


class RecordDelivery(StrEnum):
    """Where a released copy of the record goes."""

    PORTAL = "portal"  # a download in the client's portal
    THIRD_PARTY = "third_party"  # someone the client designates (sent by the practice)


class DisclosureSource(StrEnum):
    """How a disclosure came to be recorded. Only manual entries can be edited or deleted."""

    MANUAL = "manual"  # entered by staff for a disclosure made outside the app
    EXPORT = "export"  # a record export for a purpose other than treatment, payment or operations
    RECORD_REQUEST = "record_request"  # a copy sent to a third party the client designated


class ExportPurpose(StrEnum):
    """Why a client's record is exported. Anything other than treatment, payment, operations
    or giving it to the client is a disclosure the client can ask to have accounted for."""

    TREATMENT = "treatment"
    PAYMENT = "payment"
    OPERATIONS = "operations"
    CLIENT = "client"
    OTHER = "other"


class AmendmentStatus(StrEnum):
    OPEN = "open"
    ACCEPTED = "accepted"
    DENIED = "denied"


class SecuritySeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"
