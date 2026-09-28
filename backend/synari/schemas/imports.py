"""Importing a practice from SimplePractice: jobs, uploaded files, the preview and the result.

The preview and result are stored as JSON on the job (models/imports.py) and validated with
these models on the way out. They hold counts, column names, client names needed for manual
matching and warnings, never clinical content.
"""

from datetime import datetime
from typing import Literal, Self

from pydantic import Field, model_validator

from synari.models.enums import ImportFileKind, ImportStatus
from synari.schemas.common import Email, PartialUpdate, Schema, ShortText

# Fields and review lists ---------------------------------------------------------------------


class ImportFieldInfo(Schema):
    """One column the importer understands in a file kind."""

    name: str
    label: str
    required: bool


class ImportKindInfo(Schema):
    """A kind of file the importer accepts, with where to find it in SimplePractice."""

    kind: ImportFileKind
    label: str
    description: str
    extensions: list[str]
    fields: list[ImportFieldInfo]


class ImportFileOut(Schema):
    """An uploaded source file."""

    file_id: int
    kind: ImportFileKind | None
    detected_kind: ImportFileKind | None
    filename: str
    size_bytes: int
    # Column headings found in the file (spreadsheets only).
    headers: list[str] = []
    # Whether a zip's contents are password protected.
    encrypted: bool = False


class PreviewFile(Schema):
    """What the analysis found in one spreadsheet."""

    file_id: int
    kind: ImportFileKind
    filename: str
    rows: int
    # Field name -> the column heading it's read from (null when not found).
    columns: dict[str, str | None]
    missing_required: list[str]
    # A few rows of mapped values (identifying details only; never diagnoses or notes).
    sample: list[dict[str, str]]


class PreviewFolder(Schema):
    """One folder of the Complete export zip."""

    name: str
    clients: int
    files: int


class PreviewCounts(Schema):
    clients_new: int = 0
    clients_existing: int = 0
    contacts: int = 0
    insurance_policies: int = 0
    clients_with_diagnoses: int = 0
    appointments: int = 0
    future_appointments_skipped: int = 0
    documents: int = 0
    psychotherapy_notes: int = 0
    secure_messages: int = 0
    documents_skipped: int = 0
    balances: int = 0
    balance_total_cents: int = 0


class MatchCandidate(Schema):
    # A client in this import (its key) or an existing Synari client (its id as text).
    key: str
    name: str
    detail: str = ""


class MatchReview(Schema):
    """A name that may be a client already in the import; the practice confirms or rejects."""

    id: str
    name: str
    sources: list[str]
    reason: Literal["similar_name", "same_name"]
    candidates: list[MatchCandidate]
    # The chosen candidate key, "" to keep it separate, null while undecided (kept separate).
    decision: str | None = None


class ExistingReview(Schema):
    """A client in the import that may already exist in Synari."""

    key: str
    name: str
    detail: str = ""
    candidates: list[MatchCandidate]
    # The existing client's id to update, 0 to add a new client, null while undecided (new).
    decision: int | None = None


class ClinicianInvite(Schema):
    """Invite a new clinician for a SimplePractice clinician who isn't on the team yet."""

    first_name: ShortText = Field(min_length=1)
    last_name: ShortText = Field(min_length=1)
    email: Email


class PreviewClinician(Schema):
    """A clinician named in the SimplePractice files and who they become in Synari."""

    key: str
    name: str
    clients: int
    appointments: int
    # The Synari clinician chosen (or suggested); null uses the default clinician.
    staff_id: int | None
    # Found automatically by name (or because the practice has one clinician).
    matched: bool
    invite: ClinicianInvite | None = None


class ImportWarning(Schema):
    code: str
    message: str
    count: int = 1


class ImportPreview(Schema):
    analyzed_at: datetime
    counts: PreviewCounts
    files: list[PreviewFile]
    folders: list[PreviewFolder]
    matches: list[MatchReview]
    existing: list[ExistingReview]
    clinicians: list[PreviewClinician]
    warnings: list[ImportWarning]


class ImportResult(Schema):
    """Progress while importing, then the summary."""

    phase: str = ""
    processed: int = 0
    total: int = 0
    # Per kind of record (client, contact, policy, payer, appointment, document, balance,
    # clinician): how many were created, updated or skipped.
    created: dict[str, int] = {}
    updated: dict[str, int] = {}
    skipped: dict[str, int] = {}
    warnings: list[ImportWarning] = []


# Options -------------------------------------------------------------------------------------


class ClinicianChoice(Schema):
    """Who a SimplePractice clinician becomes: an existing clinician, a new invited one, or
    (neither set) the default clinician."""

    staff_id: int | None = None
    invite: ClinicianInvite | None = None

    @model_validator(mode="after")
    def _one_choice(self) -> Self:
        if self.staff_id is not None and self.invite is not None:
            raise ValueError("Choose a clinician or an invitation, not both")
        return self


class ImportOptions(Schema):
    """Choices made while reviewing the preview."""

    # Clinician for clients and sessions whose SimplePractice clinician isn't mapped.
    default_clinician_id: int | None = None
    # SimplePractice clinician key (from the preview) -> choice.
    clinicians: dict[str, ClinicianChoice] = {}
    # Match review id -> candidate key, or "" to keep separate.
    matches: dict[str, str] = {}
    # Import client key -> existing client id to update, or 0 to add a new client.
    existing: dict[str, int] = {}
    # Create clients named only in appointment, balance or document files.
    create_missing_clients: bool = True
    import_contacts: bool = True
    import_insurance: bool = True
    import_appointments: bool = True
    import_documents: bool = True
    import_balances: bool = True


class ImportOptionsOut(ImportOptions):
    zip_password_set: bool = False


# Jobs ----------------------------------------------------------------------------------------


class ImportJobSummary(Schema):
    id: int
    source: str
    status: ImportStatus
    created_by_id: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    file_count: int


class ImportJobOut(ImportJobSummary):
    files: list[ImportFileOut]
    # File id (as text) -> field name -> column heading (null = not imported).
    mapping: dict[str, dict[str, str | None]]
    options: ImportOptionsOut
    preview: ImportPreview | None
    result: ImportResult | None
    error: str


class ImportFileKindUpdate(Schema):
    file_id: int
    kind: ImportFileKind


class ImportJobUpdate(PartialUpdate):
    """Correct file kinds or column mapping (both need a new analysis), set the zip password
    or change the options."""

    files: list[ImportFileKindUpdate] | None = None
    mapping: dict[str, dict[str, str | None]] | None = None
    options: ImportOptions | None = None
    # The Complete export's password ("" clears it). Stored encrypted, never returned.
    zip_password: str | None = Field(default=None, max_length=200)
