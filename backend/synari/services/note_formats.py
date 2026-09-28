"""Clinical note formats (SOAP, DAP, BIRP, ...), their sections, and note text helpers."""

from dataclasses import dataclass
from datetime import date
from typing import Literal

from synari.models import Note
from synari.models.enums import NoteType

NoteFormatId = Literal["SOAP", "DAP", "BIRP", "GIRP", "PIRP", "SIRP", "FREEFORM"]
FREEFORM: NoteFormatId = "FREEFORM"

NOTE_TYPE_LABELS: dict[str, str] = {
    NoteType.PROGRESS: "Progress note",
    NoteType.INTAKE: "Intake note",
    NoteType.TREATMENT_PLAN: "Treatment plan",
    NoteType.CONSULTATION: "Consultation note",
    NoteType.PSYCHOTHERAPY: "Psychotherapy note",
    NoteType.OTHER: "Note",
}


@dataclass(frozen=True)
class NoteSection:
    """One heading of a structured note, with guidance on what belongs under it."""

    id: str
    label: str
    guidance: str


@dataclass(frozen=True)
class NoteFormat:
    """A documentation format and its ordered sections (empty for freeform notes)."""

    id: str
    name: str
    description: str
    sections: tuple[NoteSection, ...]

    @property
    def section_ids(self) -> tuple[str, ...]:
        return tuple(section.id for section in self.sections)


_PLAN = NoteSection(
    "plan",
    "Plan",
    "Next steps: interventions planned, homework or between-session tasks, referrals, "
    "safety planning if needed, and when the client will be seen next.",
)
_INTERVENTION = NoteSection(
    "intervention",
    "Intervention",
    "Therapeutic interventions and techniques used in the session (for example CBT "
    "restructuring, DBT skills, motivational interviewing) and the goals they addressed.",
)
_RESPONSE = NoteSection(
    "response",
    "Response",
    "How the client responded to the interventions: engagement, insight, skill use, "
    "reported or observed change, and progress toward treatment goals.",
)

# Keyed by NoteFormatId, in the order the app offers them.
FORMATS: dict[str, NoteFormat] = {
    "SOAP": NoteFormat(
        "SOAP",
        "SOAP",
        "Subjective, Objective, Assessment, Plan. The most widely used progress note format.",
        (
            NoteSection(
                "subjective",
                "Subjective",
                "What the client reported, in their own words where useful: presenting concerns, "
                "mood, symptoms, stressors and relevant events since the last session.",
            ),
            NoteSection(
                "objective",
                "Objective",
                "What you observed: appearance, behavior, affect, speech, thought process, "
                "orientation, and any measures or screening scores.",
            ),
            NoteSection(
                "assessment",
                "Assessment",
                "Your clinical interpretation: progress toward goals, response to treatment, "
                "risk assessment and diagnostic impressions.",
            ),
            _PLAN,
        ),
    ),
    "DAP": NoteFormat(
        "DAP",
        "DAP",
        "Data, Assessment, Plan. A compact format that combines subjective and objective data.",
        (
            NoteSection(
                "data",
                "Data",
                "Subjective and objective information from the session: what the client "
                "reported, what you observed, and the interventions used.",
            ),
            NoteSection(
                "assessment",
                "Assessment",
                "Your interpretation of the data: progress toward goals, clinical impressions "
                "and risk.",
            ),
            _PLAN,
        ),
    ),
    "BIRP": NoteFormat(
        "BIRP",
        "BIRP",
        "Behavior, Intervention, Response, Plan. Focuses on observable behavior and "
        "how the client responds to treatment.",
        (
            NoteSection(
                "behavior",
                "Behavior",
                "The client's presentation, reported and observed behaviors, symptoms and "
                "concerns in this session.",
            ),
            _INTERVENTION,
            _RESPONSE,
            _PLAN,
        ),
    ),
    "GIRP": NoteFormat(
        "GIRP",
        "GIRP",
        "Goals, Intervention, Response, Plan. Ties each session to treatment plan goals.",
        (
            NoteSection(
                "goals",
                "Goals",
                "The treatment plan goals and objectives addressed in this session.",
            ),
            _INTERVENTION,
            _RESPONSE,
            _PLAN,
        ),
    ),
    "PIRP": NoteFormat(
        "PIRP",
        "PIRP",
        "Problem, Intervention, Response, Plan. Organizes the session around the presenting "
        "problem.",
        (
            NoteSection(
                "problem",
                "Problem",
                "The presenting problem or concern addressed in this session and how it shows up "
                "for the client.",
            ),
            _INTERVENTION,
            _RESPONSE,
            _PLAN,
        ),
    ),
    "SIRP": NoteFormat(
        "SIRP",
        "SIRP",
        "Situation, Intervention, Response, Plan. Starts from the client's current circumstances.",
        (
            NoteSection(
                "situation",
                "Situation",
                "The client's current situation: circumstances, stressors and the concern that "
                "brought them to this session.",
            ),
            _INTERVENTION,
            _RESPONSE,
            _PLAN,
        ),
    ),
    "FREEFORM": NoteFormat(
        "FREEFORM",
        "Freeform",
        "A single narrative note without fixed sections.",
        (),
    ),
}


def get_format(format_id: str) -> NoteFormat:
    """Look up a format by id; raises KeyError for unknown ids."""
    return FORMATS[format_id]


def normalize_note_text(
    format_id: str, sections: dict[str, str], content: str
) -> tuple[dict[str, str], str]:
    """Validate note text against its format and return (sections, content) to store.

    Structured formats keep every section in format order (missing ones become empty) and no
    freeform content; freeform notes keep only content. Raises ValueError with a readable
    message when the text doesn't fit the format.
    """
    note_format = get_format(format_id)
    if note_format.id == FREEFORM:
        if any(text.strip() for text in sections.values()):
            raise ValueError("Freeform notes use content, not sections")
        return {}, content
    if content.strip():
        raise ValueError(f"{note_format.name} notes use sections, not content")
    unknown = sorted(set(sections) - set(note_format.section_ids))
    if unknown:
        raise ValueError(f"{note_format.name} notes have no section named {', '.join(unknown)}")
    return {section_id: sections.get(section_id, "") for section_id in note_format.section_ids}, ""


def note_is_empty(note: Note) -> bool:
    """True when a note has no text in any section or its content."""
    return not note.content.strip() and not any(text.strip() for text in note.sections.values())


def note_plain_text(note: Note) -> str:
    """The note as plain text: labelled sections for structured formats, content otherwise."""
    note_format = FORMATS.get(note.format)
    if note_format is None or note_format.id == FREEFORM:
        return note.content.strip()
    return "\n\n".join(
        f"{section.label}: {note.sections.get(section.id, '').strip()}"
        for section in note_format.sections
        if note.sections.get(section.id, "").strip()
    )


def default_title(note_type: str, on: date) -> str:
    """A title like 'Progress note - Oct 5, 2026' (with an en dash)."""
    label = NOTE_TYPE_LABELS.get(note_type, "Note")
    return f"{label} \N{EN DASH} {on:%b} {on.day}, {on.year}"
