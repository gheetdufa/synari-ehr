"""Built-in form library: intake questionnaire, consents, policies and scored assessments.

Every new practice gets a copy of each form (FormTemplate.library_key set). Consent and
policy text is a plain-language starting point; the template description tells the practice
to review it against its own jurisdiction before use. Descriptions are staff-facing and
never shown in the client portal.
"""

import copy
from dataclasses import dataclass
from typing import Any

from synari.models import FormTemplate
from synari.models.enums import FormKind
from synari.services.forms import FieldType, MappableField

REVIEW_NOTE = (
    "Starting template: review and edit this text so it matches how your practice works and "
    "the legal and licensing requirements where you and your clients are located before "
    "sending it."
)
CRISIS_TEXT = (
    "This form isn't monitored around the clock. If you are thinking about harming yourself "
    "or are in crisis, call or text 988 (Suicide & Crisis Lifeline, US), call 911 or your "
    "local emergency number, or go to the nearest emergency room."
)
PFIZER_ATTRIBUTION = (
    "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, "
    "with an educational grant from Pfizer Inc. No permission required to reproduce, "
    "translate, display or distribute."
)


@dataclass(frozen=True)
class LibraryForm:
    key: str
    kind: FormKind
    name: str
    description: str
    fields: list[dict[str, Any]]
    requires_signature: bool = False
    scoring: dict[str, Any] | None = None


def _heading(field_id: str, text: str) -> dict[str, Any]:
    return {"id": field_id, "type": FieldType.HEADING.value, "label": text}


def _paragraph(field_id: str, text: str) -> dict[str, Any]:
    return {"id": field_id, "type": FieldType.PARAGRAPH.value, "label": text}


def _question(
    field_id: str,
    field_type: FieldType,
    label: str,
    *,
    required: bool = False,
    help_text: str = "",
    maps_to: MappableField | None = None,
    options: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": field_id,
        "type": field_type.value,
        "label": label,
        "required": required,
    }
    if help_text:
        result["help"] = help_text
    if maps_to is not None:
        result["maps_to"] = maps_to.value
    if options is not None:
        result["options"] = options
    return result


def _options(*pairs: tuple[str, int | str]) -> list[dict[str, Any]]:
    return [{"label": label, "value": value} for label, value in pairs]


# --- Intake ----------------------------------------------------------------------------------

_USE_FREQUENCY = _options(
    ("Never", "never"),
    ("Monthly or less", "monthly_or_less"),
    ("2 to 4 times a month", "two_to_four_monthly"),
    ("2 to 3 times a week", "two_to_three_weekly"),
    ("4 or more times a week", "four_plus_weekly"),
)

_INTAKE_FIELDS = [
    _paragraph(
        "intro",
        "These questions help your therapist get to know you before your first session. "
        "Answer what you're comfortable sharing; you can talk through anything in person.",
    ),
    _heading("about_heading", "About you"),
    _question(
        "preferred_name",
        FieldType.SHORT_TEXT,
        "Preferred name",
        help_text="If different from your legal name",
        maps_to=MappableField.PREFERRED_NAME,
    ),
    _question("pronouns", FieldType.SHORT_TEXT, "Pronouns", maps_to=MappableField.PRONOUNS),
    _question(
        "date_of_birth",
        FieldType.DATE,
        "Date of birth",
        required=True,
        maps_to=MappableField.DATE_OF_BIRTH,
    ),
    _question(
        "gender_identity",
        FieldType.SHORT_TEXT,
        "Gender identity",
        maps_to=MappableField.GENDER_IDENTITY,
    ),
    _question(
        "phone", FieldType.SHORT_TEXT, "Phone number", required=True, maps_to=MappableField.PHONE
    ),
    _question(
        "address_line1",
        FieldType.SHORT_TEXT,
        "Street address",
        maps_to=MappableField.ADDRESS_LINE1,
    ),
    _question(
        "address_line2",
        FieldType.SHORT_TEXT,
        "Apartment, suite or unit",
        maps_to=MappableField.ADDRESS_LINE2,
    ),
    _question("city", FieldType.SHORT_TEXT, "City", maps_to=MappableField.CITY),
    _question("state", FieldType.SHORT_TEXT, "State", maps_to=MappableField.STATE),
    _question("postal_code", FieldType.SHORT_TEXT, "ZIP code", maps_to=MappableField.POSTAL_CODE),
    _heading("emergency_heading", "Emergency contact"),
    _paragraph(
        "emergency_intro",
        "Someone your therapist can contact if they are seriously worried about your safety "
        "or can't reach you in an emergency.",
    ),
    _question(
        "emergency_contact_name",
        FieldType.SHORT_TEXT,
        "Name",
        required=True,
        maps_to=MappableField.EMERGENCY_CONTACT_NAME,
    ),
    _question(
        "emergency_contact_phone",
        FieldType.SHORT_TEXT,
        "Phone number",
        required=True,
        maps_to=MappableField.EMERGENCY_CONTACT_PHONE,
    ),
    _question(
        "emergency_contact_relationship",
        FieldType.SHORT_TEXT,
        "Relationship to you",
        maps_to=MappableField.EMERGENCY_CONTACT_RELATIONSHIP,
    ),
    _heading("reason_heading", "Reason for seeking care"),
    _question(
        "reason", FieldType.LONG_TEXT, "What brings you to therapy right now?", required=True
    ),
    _question("concern_duration", FieldType.SHORT_TEXT, "How long has this been going on?"),
    _question(
        "daily_impact",
        FieldType.LONG_TEXT,
        "How is it affecting your daily life?",
        help_text="For example work or school, relationships, sleep or appetite",
    ),
    _heading("history_heading", "Counseling history"),
    _question(
        "prior_therapy",
        FieldType.YES_NO,
        "Have you seen a therapist or counselor before?",
        required=True,
    ),
    _question(
        "prior_therapy_details",
        FieldType.LONG_TEXT,
        "If yes, when and for how long? What was or wasn't helpful?",
    ),
    _heading("health_heading", "Health"),
    _question(
        "medications",
        FieldType.LONG_TEXT,
        "Current medications",
        help_text="Include supplements, doses and who prescribes them if you know. "
        "Write 'none' if you don't take any.",
    ),
    _question(
        "medical_conditions",
        FieldType.LONG_TEXT,
        "Medical conditions",
        help_text="Current or past conditions, injuries or hospital stays",
    ),
    _heading("substance_heading", "Alcohol and substance use"),
    _question(
        "alcohol_use",
        FieldType.SINGLE_CHOICE,
        "How often do you drink alcohol?",
        options=copy.deepcopy(_USE_FREQUENCY),
    ),
    _question(
        "drug_use",
        FieldType.SINGLE_CHOICE,
        "How often do you use recreational drugs or take prescription medication other than "
        "as prescribed?",
        options=copy.deepcopy(_USE_FREQUENCY),
    ),
    _question(
        "substance_details",
        FieldType.LONG_TEXT,
        "Is there anything you'd like your therapist to know about your alcohol or substance use?",
    ),
    _heading("safety_heading", "Safety"),
    _question(
        "safety_thoughts",
        FieldType.YES_NO,
        "In the past month, have you had thoughts of ending your life or harming yourself?",
        required=True,
    ),
    _paragraph("crisis_note", CRISIS_TEXT),
    _heading("goals_heading", "Goals"),
    _question(
        "goals",
        FieldType.LONG_TEXT,
        "What would you like to be different as a result of therapy?",
    ),
    _question(
        "anything_else",
        FieldType.LONG_TEXT,
        "Is there anything else you'd like your therapist to know?",
    ),
]

# --- Consents and policies -------------------------------------------------------------------

_INFORMED_CONSENT_FIELDS = [
    _paragraph(
        "intro",
        "This form explains how therapy works in this practice. Please read it carefully and "
        "ask about anything that isn't clear before you sign.",
    ),
    _heading("process_heading", "What therapy involves"),
    _paragraph(
        "process",
        "Therapy is a collaborative process. Together you and your therapist will talk about "
        "what brings you in, agree on goals and review your progress. Your active "
        "participation, including between sessions, makes a real difference.",
    ),
    _heading("risks_heading", "Benefits and risks"),
    _paragraph(
        "risks",
        "Many people find that therapy eases distress, improves relationships and helps them "
        "handle problems. Therapy can also bring up uncomfortable feelings or memories, and no "
        "particular result can be guaranteed. You can raise any concern about how therapy is "
        "going at any time.",
    ),
    _heading("confidentiality_heading", "Confidentiality and its limits"),
    _paragraph(
        "confidentiality",
        "What you share in therapy is kept confidential and is not released without your "
        "written permission, except where the law requires or allows it. These exceptions "
        "include: when there is a serious risk that you may harm yourself or someone else; "
        "when there is reason to suspect that a child, older adult or dependent adult is being "
        "abused or neglected; when a court orders records to be released; and when needed to "
        "arrange emergency care. Your therapist may also consult other professionals about your "
        "care without sharing who you are.",
    ),
    _heading("contact_heading", "Appointments and contact between sessions"),
    _paragraph(
        "contact",
        "Sessions are scheduled in advance. Messages between sessions are usually answered "
        "within one to two business days. Messages, email and voicemail are not monitored "
        "around the clock and should never be used for emergencies.",
    ),
    _heading("emergencies_heading", "Emergencies"),
    _paragraph(
        "emergencies",
        "If you are in crisis or think you may harm yourself or someone else, call or text 988 "
        "(Suicide & Crisis Lifeline, US), call 911 or your local emergency number, or go to "
        "the nearest emergency room.",
    ),
    _heading("records_heading", "Records"),
    _paragraph(
        "records",
        "Your therapist keeps records of your care as required by law and professional "
        "standards. You can ask to see or get a copy of your records, within the limits the "
        "law sets.",
    ),
    _heading("rights_heading", "Your rights"),
    _paragraph(
        "rights",
        "You can ask questions about your treatment, decline any recommendation and end "
        "therapy at any time. If you have a concern about your care, please raise it with your "
        "therapist. You may also contact the board that licenses your therapist.",
    ),
    _paragraph(
        "agreement",
        "By signing below, you confirm that you have read this information, have had the "
        "chance to ask questions, and agree to take part in therapy.",
    ),
]

_TELEHEALTH_CONSENT_FIELDS = [
    _paragraph(
        "intro",
        "Telehealth means meeting with your therapist by secure video or phone instead of in "
        "person. This form explains how it works and what to expect.",
    ),
    _heading("how_heading", "How it works"),
    _paragraph(
        "how",
        "Sessions use a secure video service. You'll need a reliable internet connection and a "
        "device with a camera, microphone and speakers or headphones. Please join from a "
        "private place where you won't be overheard or interrupted.",
    ),
    _heading("risks_heading", "Benefits and risks"),
    _paragraph(
        "risks",
        "Telehealth can save travel time and make care easier to fit into your life. It also "
        "has risks: technical problems can interrupt a session, and your privacy depends partly "
        "on your surroundings and the security of your own device and network. Telehealth isn't "
        "right for every situation, and your therapist may recommend meeting in person.",
    ),
    _heading("privacy_heading", "Privacy"),
    _paragraph(
        "privacy",
        "The same confidentiality protections apply as for in-person sessions. Neither you nor "
        "your therapist may record a session without the other's written agreement.",
    ),
    _heading("safety_heading", "Safety and emergencies"),
    _paragraph(
        "safety",
        "At the start of a session your therapist may ask where you are, so help can be sent "
        "if there is an emergency. Please keep an emergency contact on file. If you are in "
        "crisis, call or text 988 (US), or call 911 or your local emergency number.",
    ),
    _heading("disconnect_heading", "If the connection drops"),
    _paragraph(
        "disconnect",
        "If a video session disconnects, try to rejoin. If that doesn't work within a few "
        "minutes, your therapist will call you at the phone number on file.",
    ),
    _paragraph(
        "agreement",
        "By signing below, you agree to receive services by telehealth. You can withdraw this "
        "consent at any time by telling your therapist.",
    ),
]

_PRIVACY_NOTICE_FIELDS = [
    _paragraph(
        "intro",
        "The Notice of Privacy Practices explains how health information about you may be used "
        "and shared, and how you can get access to it. You can ask your therapist for a copy at "
        "any time.",
    ),
    _heading("use_heading", "How your information is used"),
    _paragraph(
        "use",
        "Your information is used and shared to provide your care, to bill and get paid for "
        "services, and to run the practice. It is shared for other purposes only when the law "
        "requires or allows it, or with your written permission.",
    ),
    _heading("rights_heading", "Your rights in brief"),
    _paragraph(
        "rights",
        "You have the right to see and get a copy of your health records, ask for corrections, "
        "ask for limits on what is shared, ask to be contacted in a particular way or place, "
        "get a list of certain disclosures, and file a complaint if you believe your privacy "
        "rights were violated. You will not be penalized for filing a complaint.",
    ),
    _paragraph(
        "agreement",
        "By signing below, you acknowledge that you have received or been offered a copy of "
        "the Notice of Privacy Practices.",
    ),
]

_PRACTICE_POLICIES_FIELDS = [
    _paragraph(
        "intro",
        "These policies help keep scheduling fair for everyone. Please read them and ask your "
        "therapist if you have any questions.",
    ),
    _heading("cancellation_heading", "Cancelling or rescheduling"),
    _paragraph(
        "cancellation",
        "If you need to cancel or reschedule, please give at least 24 hours' notice. You can "
        "do this in the client portal or by contacting your therapist.",
    ),
    _heading("late_cancel_heading", "Late cancellations and missed appointments"),
    _paragraph(
        "late_cancel",
        "Appointments cancelled with less notice, or missed without notice, may be charged the "
        "full session fee. Insurance does not pay for missed appointments. Exceptions may be "
        "made for emergencies and sudden illness.",
    ),
    _heading("late_arrival_heading", "Arriving late"),
    _paragraph(
        "late_arrival",
        "If you arrive late, the session usually still ends at its scheduled time and the full "
        "fee applies.",
    ),
    _heading("payment_heading", "Payment"),
    _paragraph(
        "payment",
        "Payment is due at the time of each session unless you've agreed on something else "
        "with your therapist. If you keep a card on file, it may be charged for session fees "
        "and for any late-cancellation or missed-appointment fees. Receipts and statements are "
        "available in the client portal.",
    ),
    _heading("insurance_heading", "Insurance"),
    _paragraph(
        "insurance",
        "If you use insurance, you are responsible for any copay, coinsurance or deductible, "
        "and for any fees your plan does not cover. You can ask for a superbill to submit to "
        "your insurer for out-of-network reimbursement.",
    ),
    _paragraph(
        "agreement",
        "By signing below, you confirm that you have read and agree to these policies.",
    ),
]

# --- Scored assessments ----------------------------------------------------------------------

_FREQUENCY = (
    ("Not at all", 0),
    ("Several days", 1),
    ("More than half the days", 2),
    ("Nearly every day", 3),
)
_DIFFICULTY = (
    ("Not difficult at all", "not_difficult"),
    ("Somewhat difficult", "somewhat_difficult"),
    ("Very difficult", "very_difficult"),
    ("Extremely difficult", "extremely_difficult"),
)
_DIFFICULTY_LABEL = (
    "If you checked off any problems, how difficult have these problems made it for you to do "
    "your work, take care of things at home, or get along with other people?"
)

PHQ9_ITEMS = (
    "Little interest or pleasure in doing things",
    "Feeling down, depressed, or hopeless",
    "Trouble falling or staying asleep, or sleeping too much",
    "Feeling tired or having little energy",
    "Poor appetite or overeating",
    "Feeling bad about yourself — or that you are a failure or have let yourself or your "
    "family down",
    "Trouble concentrating on things, such as reading the newspaper or watching television",
    "Moving or speaking so slowly that other people could have noticed? Or the opposite "
    "— being so fidgety or restless that you have been moving around a lot more than usual",
    "Thoughts that you would be better off dead or of hurting yourself in some way",
)
GAD7_ITEMS = (
    "Feeling nervous, anxious, or on edge",
    "Not being able to stop or control worrying",
    "Worrying too much about different things",
    "Trouble relaxing",
    "Being so restless that it is hard to sit still",
    "Becoming easily annoyed or irritable",
    "Feeling afraid as if something awful might happen",
)


def _scored_fields(instructions: str, items: tuple[str, ...]) -> list[dict[str, Any]]:
    return [
        _paragraph("instructions", instructions),
        *(
            _question(
                f"q{number}",
                FieldType.SINGLE_CHOICE,
                text,
                required=True,
                options=_options(*_FREQUENCY),
            )
            for number, text in enumerate(items, start=1)
        ),
        _question(
            "difficulty", FieldType.SINGLE_CHOICE, _DIFFICULTY_LABEL, options=_options(*_DIFFICULTY)
        ),
    ]


def _band(low: int, high: int, label: str) -> dict[str, Any]:
    return {"min": low, "max": high, "label": label}


_PHQ9_FIELDS = [
    *_scored_fields(
        "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
        PHQ9_ITEMS,
    ),
    _paragraph("crisis_note", CRISIS_TEXT),
]
_PHQ9_SCORING = {
    "method": "sum",
    "items": [f"q{n}" for n in range(1, len(PHQ9_ITEMS) + 1)],
    "max_score": 27,
    "bands": [
        _band(0, 4, "Minimal"),
        _band(5, 9, "Mild"),
        _band(10, 14, "Moderate"),
        _band(15, 19, "Moderately severe"),
        _band(20, 27, "Severe"),
    ],
    "flags": [{"item": "q9", "min": 1, "reason": "Item 9 (thoughts of self-harm) endorsed"}],
}

_GAD7_FIELDS = _scored_fields(
    "Over the last 2 weeks, how often have you been bothered by the following problems?",
    GAD7_ITEMS,
)
_GAD7_SCORING = {
    "method": "sum",
    "items": [f"q{n}" for n in range(1, len(GAD7_ITEMS) + 1)],
    "max_score": 21,
    "bands": [
        _band(0, 4, "Minimal"),
        _band(5, 9, "Mild"),
        _band(10, 14, "Moderate"),
        _band(15, 21, "Severe"),
    ],
    "flags": [],
}

LIBRARY: dict[str, LibraryForm] = {
    form.key: form
    for form in (
        LibraryForm(
            key="intake",
            kind=FormKind.INTAKE,
            name="Intake Questionnaire",
            description=(
                "Contact details, emergency contact, reasons for seeking care, history, health, "
                "substance use, a safety screening question and goals. Contact answers fill in "
                "the client's record where it is still blank. Review and adjust the questions "
                "to suit your practice."
            ),
            fields=_INTAKE_FIELDS,
            scoring={
                "flags": [
                    {
                        "item": "safety_thoughts",
                        "equals": True,
                        "reason": "Safety question answered yes (thoughts of self-harm)",
                    }
                ]
            },
        ),
        LibraryForm(
            key="informed_consent",
            kind=FormKind.CONSENT,
            name="Informed Consent for Psychotherapy",
            description=REVIEW_NOTE,
            fields=_INFORMED_CONSENT_FIELDS,
            requires_signature=True,
        ),
        LibraryForm(
            key="telehealth_consent",
            kind=FormKind.CONSENT,
            name="Telehealth Consent",
            description=REVIEW_NOTE,
            fields=_TELEHEALTH_CONSENT_FIELDS,
            requires_signature=True,
        ),
        LibraryForm(
            key="privacy_notice",
            kind=FormKind.CONSENT,
            name="Notice of Privacy Practices Acknowledgement",
            description=(
                f"{REVIEW_NOTE} Share your full Notice of Privacy Practices with clients too, "
                "for example as a document in their portal."
            ),
            fields=_PRIVACY_NOTICE_FIELDS,
            requires_signature=True,
        ),
        LibraryForm(
            key="practice_policies",
            kind=FormKind.CONSENT,
            name="Practice Policies",
            description=(
                f"{REVIEW_NOTE} Make sure the notice period, fees and payment terms match your "
                "own policies and your cancellation window in Settings."
            ),
            fields=_PRACTICE_POLICIES_FIELDS,
            requires_signature=True,
        ),
        LibraryForm(
            key="phq9",
            kind=FormKind.ASSESSMENT,
            name="PHQ-9",
            description=(
                "Patient Health Questionnaire-9, a depression screening measure. Scored "
                "automatically from 0 to 27: 0-4 minimal, 5-9 mild, 10-14 moderate, 15-19 "
                "moderately severe, 20-27 severe. Any answer other than 'Not at all' on item 9 "
                f"is flagged for your review. {PFIZER_ATTRIBUTION}"
            ),
            fields=_PHQ9_FIELDS,
            scoring=_PHQ9_SCORING,
        ),
        LibraryForm(
            key="gad7",
            kind=FormKind.ASSESSMENT,
            name="GAD-7",
            description=(
                "Generalized Anxiety Disorder-7, an anxiety screening measure. Scored "
                "automatically from 0 to 21: 0-4 minimal, 5-9 mild, 10-14 moderate, 15-21 "
                f"severe. {PFIZER_ATTRIBUTION}"
            ),
            fields=_GAD7_FIELDS,
            scoring=_GAD7_SCORING,
        ),
    )
}


def new_template(practice_id: int, entry: LibraryForm) -> FormTemplate:
    """A fresh, independent FormTemplate copy of a library form for the practice."""
    return FormTemplate(
        practice_id=practice_id,
        kind=entry.kind,
        name=entry.name,
        description=entry.description,
        fields=copy.deepcopy(entry.fields),
        scoring=copy.deepcopy(entry.scoring),
        requires_signature=entry.requires_signature,
        library_key=entry.key,
        is_active=True,
    )
