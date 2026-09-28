"""Form templates, forms shared with clients, and portal submissions."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, StrictBool, StrictInt, StringConstraints

from synari.integrity import Integrity
from synari.models.enums import ClientFormStatus, FormKind
from synari.schemas.common import Schema
from synari.services.forms import (
    FIELD_ID_PATTERN,
    MAX_ANSWER_LENGTH,
    MAX_FIELDS,
    MAX_FORMS_PER_SHARE,
    MAX_OPTIONS,
    SIGNATURE_MAX_LENGTH,
    FieldType,
    MappableField,
    check_fields,
)

FieldId = Annotated[str, Field(pattern=FIELD_ID_PATTERN)]
OptionValue = StrictInt | Annotated[str, Field(min_length=1, max_length=100)]
TemplateName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
Description = Annotated[str, Field(max_length=5000)]


class ChoiceOption(Schema):
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    value: OptionValue


class FormField(Schema):
    """One item on a form. Headings and paragraphs are display text and take no answer.

    For paragraphs, `label` holds the text shown to the client. `maps_to` names a client
    record field that the answer fills in when it is still empty.
    """

    id: FieldId
    type: FieldType
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)]
    required: bool = False
    options: list[ChoiceOption] | None = Field(default=None, max_length=MAX_OPTIONS)
    help: Annotated[str, Field(max_length=1000)] = ""
    maps_to: MappableField | None = None


def _checked_fields(fields: list[FormField]) -> list[FormField]:
    check_fields([f.model_dump(mode="json", exclude_none=True) for f in fields])
    return fields


TemplateFields = Annotated[
    list[FormField], Field(min_length=1, max_length=MAX_FIELDS), AfterValidator(_checked_fields)
]


class ScoreBand(Schema):
    min: int
    max: int
    label: str


class ScoreFlag(Schema):
    """Fires when a numeric answer is at least `min`, or an answer equals `equals`."""

    item: str
    min: int | None = None
    equals: bool | int | str | None = None
    reason: str


class ScoringSpec(Schema):
    """How a form is totaled, banded and flagged. Screening-only forms have just flags."""

    method: Literal["sum"] | None = None
    items: list[str] = Field(default_factory=list)
    max_score: int | None = None
    bands: list[ScoreBand] = Field(default_factory=list)
    flags: list[ScoreFlag] = Field(default_factory=list)


class LibraryFormOut(Schema):
    key: str
    name: str
    kind: FormKind
    description: str


class TemplateCreate(Schema):
    kind: FormKind
    name: TemplateName
    description: Description = ""
    fields: TemplateFields
    requires_signature: bool = False


class TemplateUpdate(Schema):
    """Partial update: only fields present in the request are changed."""

    kind: FormKind | None = None
    name: TemplateName | None = None
    description: Description | None = None
    fields: TemplateFields | None = None
    requires_signature: bool | None = None


class TemplateSummary(Schema):
    id: int
    kind: FormKind
    name: str
    description: str
    requires_signature: bool
    library_key: str | None
    read_only: bool
    created_at: datetime
    updated_at: datetime


class TemplateOut(TemplateSummary):
    fields: list[FormField]
    scoring: ScoringSpec | None


class ShareFormsRequest(Schema):
    template_ids: list[int] = Field(min_length=1, max_length=MAX_FORMS_PER_SHARE)


class ClientFormSummary(Schema):
    """A shared form's status and, for staff with clinical access, its results.

    score, score_label and flagged are null for staff who can see the client's profile but not
    their clinical record.
    """

    id: int
    client_id: int
    template_id: int | None
    kind: FormKind
    name: str
    status: ClientFormStatus
    requires_signature: bool
    sent_at: datetime
    viewed_at: datetime | None
    completed_at: datetime | None
    last_reminded_at: datetime | None
    reminder_count: int
    score: int | None
    score_label: str | None
    flagged: bool | None


class ClientFormOut(ClientFormSummary):
    """Everything about a shared form, for staff with clinical access to the client."""

    score_label: str
    flagged: bool
    description: str
    fields: list[FormField]
    scoring: ScoringSpec | None
    answers: dict[str, Any] | None
    flag_reason: str
    signature_name: str
    signed_at: datetime | None
    signer_ip: str
    signer_user_agent: str
    # SHA-256 of what was signed (empty when unsigned) and whether the form still matches it.
    signature_sha256: str
    signature_integrity: Integrity | None


class PortalFormSummary(Schema):
    id: int
    kind: FormKind
    name: str
    status: ClientFormStatus
    requires_signature: bool
    sent_at: datetime
    completed_at: datetime | None


class PortalFormOut(PortalFormSummary):
    """A form as the client sees it: questions, and their own answers once submitted."""

    fields: list[FormField]
    answers: dict[str, Any] | None
    signature_name: str
    signed_at: datetime | None


AnswerText = Annotated[str, Field(max_length=MAX_ANSWER_LENGTH)]
AnswerValue = (
    StrictBool
    | StrictInt
    | AnswerText
    | Annotated[list[StrictInt | AnswerText], Field(max_length=MAX_OPTIONS)]
    | None
)


class FormSubmission(Schema):
    """Answers keyed by field id: text/date (YYYY-MM-DD) as strings, yes/no as booleans,
    single choice as an option value, multi choice as a list of option values."""

    answers: dict[Annotated[str, Field(max_length=40)], AnswerValue] = Field(
        default_factory=dict, max_length=MAX_FIELDS
    )
    signature_name: Annotated[str, Field(max_length=SIGNATURE_MAX_LENGTH)] | None = None
    signature_agreed: bool = False


class SubmissionProblem(Schema):
    """422 detail when a submission has invalid answers or a missing signature."""

    message: str
    errors: dict[str, str]
    signature: str | None
