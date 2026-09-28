"""AI documentation assistant schemas."""

from typing import Annotated, Self

from pydantic import Field, StringConstraints, model_validator

from synari.models.enums import NoteType
from synari.schemas.common import Schema
from synari.services.ai import ChatRole
from synari.services.note_formats import NoteFormatId

MAX_SOURCE_CHARS = 60_000
MAX_MESSAGE_CHARS = 20_000
MAX_MESSAGES = 40


class NoteGenerateRequest(Schema):
    """Session material (a transcript, dictation or rough notes) to draft a note from.
    `format` defaults to the signed-in clinician's default note format."""

    client_id: int
    appointment_id: int | None = None
    format: NoteFormatId | None = None
    note_type: NoteType = NoteType.PROGRESS
    source_text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_SOURCE_CHARS)
    ]


class NoteProposalOut(Schema):
    """A draft for the clinician to review; nothing is saved. Structured formats fill
    `sections` (every section id, in order) and leave `content` empty; FREEFORM fills
    `content` and leaves `sections` empty."""

    format: NoteFormatId
    sections: dict[str, str]
    content: str
    risk_flags: list[str]


class AssistantMessage(Schema):
    role: ChatRole
    content: Annotated[str, Field(min_length=1, max_length=MAX_MESSAGE_CHARS)]


class AssistantRequest(Schema):
    """The conversation so far, ending with the signed-in staff member's question."""

    messages: list[AssistantMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    client_id: int | None = None

    @model_validator(mode="after")
    def _ends_with_question(self) -> Self:
        if self.messages[-1].role != "user":
            raise ValueError("The last message must be from the user")
        return self


class AssistantReply(Schema):
    reply: str


class TranscriptionOut(Schema):
    text: str
