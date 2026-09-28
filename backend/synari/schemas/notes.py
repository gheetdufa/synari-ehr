"""Clinical note schemas."""

from datetime import datetime
from typing import Annotated, Any

from pydantic import Field, StringConstraints, field_validator

from synari.integrity import Integrity
from synari.models import Appointment
from synari.models.enums import NoteStatus, NoteType, RiskLevel
from synari.schemas.appointments import ClientRef
from synari.schemas.common import PartialUpdate, Schema
from synari.services.note_formats import NoteFormatId

MAX_SECTION_CHARS = 20_000
MAX_CONTENT_CHARS = 60_000
MAX_RISK_FLAGS = 20
MAX_COMMENT_CHARS = 5_000
MAX_REASON_CHARS = 1_000
MAX_ADDENDUM_CHARS = 20_000


SectionText = Annotated[str, Field(max_length=MAX_SECTION_CHARS)]
NoteContent = Annotated[str, Field(max_length=MAX_CONTENT_CHARS)]
Sections = Annotated[dict[str, SectionText], Field(max_length=20)]
RiskFlag = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
RiskFlags = Annotated[list[RiskFlag], Field(max_length=MAX_RISK_FLAGS)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
RequiredTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class NoteSectionOut(Schema):
    id: str
    label: str
    guidance: str


class NoteFormatOut(Schema):
    id: NoteFormatId
    name: str
    description: str
    sections: list[NoteSectionOut]


class NoteCreate(Schema):
    """A new draft note by the signed-in clinician. `format` defaults to their own default."""

    client_id: int
    appointment_id: int | None = None
    note_type: NoteType = NoteType.PROGRESS
    format: NoteFormatId | None = None
    title: Title = ""
    sections: Sections = Field(default_factory=dict)
    content: NoteContent = ""
    risk_level: RiskLevel = RiskLevel.NONE
    risk_flags: RiskFlags = Field(default_factory=list)
    ai_generated: bool = False


class GroupNoteCreate(Schema):
    """Drafts for everyone in a session, each starting from the same text. `format` defaults
    to the signed-in clinician's default."""

    note_type: NoteType = NoteType.PROGRESS
    format: NoteFormatId | None = None
    title: Title = ""
    sections: Sections = Field(default_factory=dict)
    content: NoteContent = ""


class ChangesRequest(Schema):
    """A supervisor's reason for sending a note back to its author."""

    comment: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_COMMENT_CHARS)
    ]


class UnlockRequest(Schema):
    """Why a signed note is being unlocked; kept with the next signed version."""

    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_REASON_CHARS)
    ]


class AddendumCreate(Schema):
    content: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_ADDENDUM_CHARS)
    ]


class NoteUpdate(PartialUpdate):
    """Partial update of a draft note. `sections` replaces all section text."""

    NULLABLE = frozenset({"appointment_id"})

    appointment_id: int | None = None
    note_type: NoteType | None = None
    format: NoteFormatId | None = None
    title: RequiredTitle | None = None
    sections: Sections | None = None
    content: NoteContent | None = None
    risk_level: RiskLevel | None = None
    risk_flags: RiskFlags | None = None


class StaffRef(Schema):
    """The staff member behind a record, by name (with credentials) only."""

    id: int
    name: str = Field(validation_alias="display_name")


class NoteSummary(Schema):
    id: int
    client: ClientRef
    author: StaffRef
    appointment_id: int | None
    note_type: NoteType
    format: NoteFormatId
    title: str
    status: NoteStatus
    # When the author signed (kept while the note waits for and after its co-signature).
    signed_at: datetime | None
    # The supervisor asked to co-sign (set when a supervisee signs).
    supervisor: StaffRef | None
    cosigned_at: datetime | None
    # Why the supervisor sent the note back (cleared once it's co-signed).
    supervisor_comment: str
    was_signed: bool
    ai_generated: bool
    risk_level: RiskLevel
    risk_flags: list[str]
    appointment_starts_at: datetime | None
    # How many clients were in the linked session (0 without one); over 1 is a multi-client
    # session where each client has their own note.
    appointment_participant_count: int = Field(validation_alias="appointment")
    # Whether the signed text still matches its signature hash (null for drafts).
    integrity: Integrity | None
    created_at: datetime
    updated_at: datetime

    @field_validator("appointment_participant_count", mode="before")
    @classmethod
    def _count_participants(cls, appointment: Appointment | None) -> int:
        return len(appointment.participants) if appointment is not None else 0


class NoteOut(NoteSummary):
    sections: dict[str, str]
    content: str
    # Why the note was unlocked (or sent back), saved with its next signature.
    pending_revision_reason: str
    # Signed versions kept (one per signature and co-signature) and addenda written since.
    revision_count: int = Field(validation_alias="revisions")
    addendum_count: int = Field(validation_alias="addenda")

    @field_validator("revision_count", "addendum_count", mode="before")
    @classmethod
    def _count(cls, rows: list[Any]) -> int:
        return len(rows)


class NoteRevisionOut(Schema):
    """One signed version of a note."""

    id: int
    version: int
    title: str
    sections: dict[str, str]
    content: str
    content_sha256: str
    signed_by: StaffRef
    signed_at: datetime
    cosigned_by: StaffRef | None
    cosigned_at: datetime | None
    # Why the previous version was unlocked or sent back (empty for the first).
    reason: str
    created_at: datetime
    integrity: Integrity


class AddendumOut(Schema):
    """An addition to a signed note that leaves the signed text untouched."""

    id: int
    note_id: int
    author: StaffRef
    content: str
    content_sha256: str
    # Set when the addendum records an accepted amendment request.
    amendment_request_id: int | None
    created_at: datetime
    integrity: Integrity
