"""Intake, consent and assessment forms: field rules, answers, scoring, sharing and reminders.

Fields are stored as JSON dicts (see models/forms.py). Templates are snapshotted into a
ClientForm when shared, so later template edits never change what a client was asked.
"""

import copy
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import Column, String, exists, func, select
from sqlalchemy.orm import Session, aliased

from synari.access import ClientAccess
from synari.models import Client, ClientContact, ClientForm, FormTemplate, StaffMember
from synari.models.enums import ClientFormStatus, ClientStatus, Role
from synari.realtime import publish
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_portal_email, queue_staff_email
from synari.services.recipients import client_team_recipients, staff_with_client_access


class FieldType(StrEnum):
    HEADING = "heading"
    PARAGRAPH = "paragraph"
    SHORT_TEXT = "short_text"
    LONG_TEXT = "long_text"
    DATE = "date"
    SINGLE_CHOICE = "single_choice"
    MULTI_CHOICE = "multi_choice"
    YES_NO = "yes_no"


class MappableField(StrEnum):
    """Parts of the client's record that a form answer may fill in while they are still empty.

    The emergency_contact_* answers fill in the client's emergency contact (a ClientContact),
    adding one when needed; the others are Client columns.
    """

    PREFERRED_NAME = "preferred_name"
    PRONOUNS = "pronouns"
    DATE_OF_BIRTH = "date_of_birth"
    GENDER_IDENTITY = "gender_identity"
    PHONE = "phone"
    ADDRESS_LINE1 = "address_line1"
    ADDRESS_LINE2 = "address_line2"
    CITY = "city"
    STATE = "state"
    POSTAL_CODE = "postal_code"
    EMERGENCY_CONTACT_NAME = "emergency_contact_name"
    EMERGENCY_CONTACT_PHONE = "emergency_contact_phone"
    EMERGENCY_CONTACT_RELATIONSHIP = "emergency_contact_relationship"


DISPLAY_TYPES = frozenset({FieldType.HEADING, FieldType.PARAGRAPH})
TEXT_TYPES = frozenset({FieldType.SHORT_TEXT, FieldType.LONG_TEXT})
CHOICE_TYPES = frozenset({FieldType.SINGLE_CHOICE, FieldType.MULTI_CHOICE})

FIELD_ID_PATTERN = r"^[a-z0-9_]{1,40}$"
MAX_FIELDS = 200
MAX_OPTIONS = 50
MAX_ANSWER_LENGTH = 5000
MAX_FORMS_PER_SHARE = 20
SIGNATURE_MIN_LENGTH = 2
SIGNATURE_MAX_LENGTH = 200

REMINDER_INTERVAL = timedelta(days=3)
MAX_REMINDERS = 3
REMINDER_BATCH_SIZE = 500
# Mirrors Client.can_use_portal so the reminder job can filter in SQL.
PORTAL_CLIENT_STATUSES = (ClientStatus.ACTIVE, ClientStatus.PROSPECTIVE)

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAPPABLE_COLUMNS = frozenset(m.value for m in MappableField)
# The emergency contact's column for each emergency-contact answer. The full name is split
# into first and last name, so it's limited to the length of a first name.
_EMERGENCY_CONTACT_COLUMNS = {
    MappableField.EMERGENCY_CONTACT_NAME: "first_name",
    MappableField.EMERGENCY_CONTACT_PHONE: "phone",
    MappableField.EMERGENCY_CONTACT_RELATIONSHIP: "relation",
}


# --- Field structure -------------------------------------------------------------------------


def _mappable_types(column: str) -> frozenset[FieldType]:
    if column == MappableField.DATE_OF_BIRTH:
        return frozenset({FieldType.DATE})
    return TEXT_TYPES


def _options_problem(options: Sequence[Mapping[str, Any]] | None) -> str | None:
    if not options or len(options) < 2:
        return "choice questions need at least 2 options"
    if len(options) > MAX_OPTIONS:
        return f"choice questions can have at most {MAX_OPTIONS} options"
    values = [option["value"] for option in options]
    if any(type(value) not in (int, str) for value in values):
        return "option values must be whole numbers or text"
    if len({type(value) for value in values}) > 1:
        return "option values must be all numbers or all text"
    if len(set(values)) != len(values):
        return "option values must be unique"
    return None


def _field_problem(field: Mapping[str, Any]) -> str | None:
    kind = FieldType(field["type"])
    column = field.get("maps_to")
    if column is not None:
        if column not in _MAPPABLE_COLUMNS:
            return f"{column} isn't a client field forms can fill in"
        if kind not in _mappable_types(column):
            return f"this type of question can't fill in {column}"
    if kind in DISPLAY_TYPES and field.get("required"):
        return "headings and paragraphs can't be required"
    if kind in CHOICE_TYPES:
        return _options_problem(field.get("options"))
    if field.get("options"):
        return "only choice questions can have options"
    return None


def check_fields(fields: Sequence[Mapping[str, Any]]) -> None:
    """Raise ValueError if a field list breaks a structural rule.

    The API schema checks each field's shape (id pattern, type, lengths); this covers rules
    that span a field's keys or the whole list, and also guards the built-in library.
    """
    if not fields:
        raise ValueError("A form needs at least one field")
    if len(fields) > MAX_FIELDS:
        raise ValueError(f"A form can have at most {MAX_FIELDS} fields")
    seen_ids: set[str] = set()
    mapped_columns: set[str] = set()
    for field in fields:
        field_id = field["id"]
        if not re.fullmatch(FIELD_ID_PATTERN, field_id):
            raise ValueError(f"Field id '{field_id}' must be 1-40 lowercase letters, digits or _")
        if field_id in seen_ids:
            raise ValueError(f"Field id '{field_id}' is used more than once")
        seen_ids.add(field_id)
        problem = _field_problem(field)
        if problem:
            raise ValueError(f"Field '{field_id}': {problem}")
        column = field.get("maps_to")
        if column is not None:
            if column in mapped_columns:
                raise ValueError(f"Only one question can fill in {column}")
            mapped_columns.add(column)


# --- Answers ---------------------------------------------------------------------------------


def _record_column(mapped: str) -> Column[Any]:
    """The database column a mapped answer is stored in."""
    if mapped in _EMERGENCY_CONTACT_COLUMNS:
        return ClientContact.__table__.c[_EMERGENCY_CONTACT_COLUMNS[mapped]]
    return Client.__table__.c[mapped]


def _text_limit(field: Mapping[str, Any]) -> int:
    column = field.get("maps_to")
    if column is None:
        return MAX_ANSWER_LENGTH
    column_type = _record_column(column).type
    if isinstance(column_type, String) and column_type.length:
        return min(MAX_ANSWER_LENGTH, column_type.length)
    return MAX_ANSWER_LENGTH


def _matches_option(value: Any, allowed: Sequence[Any]) -> bool:
    # Exact type match so True never counts as the option value 1.
    return any(type(value) is type(option) and value == option for option in allowed)


def _clean_value(field: Mapping[str, Any], value: Any) -> tuple[Any, str | None]:
    """The normalized answer (None when left blank) or an error message."""
    kind = FieldType(field["type"])
    if kind in TEXT_TYPES:
        if not isinstance(value, str):
            return None, "Enter text"
        text = value.strip()
        limit = _text_limit(field)
        if len(text) > limit:
            return None, f"Keep this to {limit} characters or fewer"
        return text or None, None
    if kind == FieldType.DATE:
        if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
            return None, "Enter a date as YYYY-MM-DD"
        try:
            return date.fromisoformat(value).isoformat(), None
        except ValueError:
            return None, "Enter a valid date"
    if kind == FieldType.YES_NO:
        if not isinstance(value, bool):
            return None, "Answer yes or no"
        return value, None
    allowed = [option["value"] for option in field["options"]]
    if kind == FieldType.SINGLE_CHOICE:
        if not _matches_option(value, allowed):
            return None, "Choose one of the options"
        return value, None
    if not isinstance(value, list) or not all(_matches_option(v, allowed) for v in value):
        return None, "Choose from the options"
    chosen = [option for option in allowed if _matches_option(option, value)]
    return chosen or None, None


def clean_answers(
    fields: Sequence[Mapping[str, Any]], submitted: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, str]]:
    """Validate submitted answers against the form's fields.

    Returns (answers, errors). Answers are normalized (text stripped, blanks dropped,
    multi-choice values in option order); errors map field ids to a message.
    """
    answerable = {f["id"]: f for f in fields if f["type"] not in DISPLAY_TYPES}
    errors = {
        key[:40]: "This question isn't on the form" for key in submitted if key not in answerable
    }
    answers: dict[str, Any] = {}
    for field_id, field in answerable.items():
        raw = submitted.get(field_id)
        value, error = (None, None) if raw is None else _clean_value(field, raw)
        if error:
            errors[field_id] = error
        elif value is not None:
            answers[field_id] = value
        elif field.get("required"):
            errors[field_id] = "This question is required"
    return answers, errors


def signature_problem(form: ClientForm, name: str | None, agreed: bool) -> str | None:
    """Why a signature is missing or invalid for a form that requires one, else None."""
    if not form.requires_signature:
        return None
    if len((name or "").strip()) < SIGNATURE_MIN_LENGTH:
        return "Type your full name to sign"
    if not agreed:
        return "Agree to sign electronically to continue"
    return None


# --- Scoring ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class ScoreResult:
    score: int | None = None
    label: str = ""
    flagged: bool = False
    flag_reason: str = ""


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _flag_fires(flag: Mapping[str, Any], answers: Mapping[str, Any]) -> bool:
    answer = answers.get(flag["item"])
    if "equals" in flag:
        return (
            answer is not None and answer == flag["equals"] and type(answer) is type(flag["equals"])
        )
    return _is_int(answer) and answer >= flag["min"]


def score_answers(scoring: Mapping[str, Any] | None, answers: Mapping[str, Any]) -> ScoreResult:
    """Apply a scoring spec: sum the listed items, pick the matching band, raise flags.

    Spec: {"method": "sum", "items": [ids], "max_score": n,
           "bands": [{"min", "max", "label"}],
           "flags": [{"item", "min", "reason"} | {"item", "equals", "reason"}]}
    A flag with "min" fires on a numeric answer at or above it; one with "equals" fires on an
    exact answer (e.g. true for a yes/no screening question).
    """
    if not scoring:
        return ScoreResult()
    values = [answers.get(item) for item in scoring.get("items", [])]
    score: int | None = None
    if scoring.get("method") == "sum" and values and all(_is_int(v) for v in values):
        score = sum(values)
    label = ""
    if score is not None:
        label = next(
            (b["label"] for b in scoring.get("bands", []) if b["min"] <= score <= b["max"]), ""
        )
    reasons = [flag["reason"] for flag in scoring.get("flags", []) if _flag_fires(flag, answers)]
    return ScoreResult(score, label, bool(reasons), "; ".join(reasons)[:300])


# --- Sharing, submission and notifications ----------------------------------------------------


def _queue_documents_email(
    db: Session,
    client: Client,
    *,
    subject: str,
    heading: str,
    paragraphs: list[str],
    dedupe_key: str | None = None,
) -> bool:
    """Email the client a content-free portal link to their documents (False if not possible)."""
    return queue_portal_email(
        db,
        client,
        subject=subject,
        heading=heading,
        paragraphs=paragraphs,
        button_label="Complete documents",
        next_path="/client/documents",
        dedupe_key=dedupe_key,
    )


def share_forms(
    db: Session,
    shared_by: StaffMember,
    client: Client,
    templates: Sequence[FormTemplate],
    now: datetime,
) -> list[ClientForm]:
    """Snapshot templates as pending forms for the client and send one portal email.

    The email names the clinician who shared the forms, or the practice when someone on the
    administrative team did.
    """
    forms = [
        ClientForm(
            practice_id=client.practice_id,
            client_id=client.id,
            template_id=template.id,
            kind=template.kind,
            name=template.name,
            description=template.description,
            fields=copy.deepcopy(template.fields),
            scoring=copy.deepcopy(template.scoring),
            requires_signature=template.requires_signature,
            status=ClientFormStatus.PENDING,
            sent_at=now,
        )
        for template in templates
    ]
    db.add_all(forms)
    db.flush()
    practice = client.practice.name
    sender = shared_by.display_name if shared_by.is_clinician else practice
    _queue_documents_email(
        db,
        client,
        subject=f"Documents to complete for {practice}",
        heading="You have documents to complete",
        paragraphs=[
            f"{sender} shared documents for you to review and complete in your secure client "
            "portal."
        ],
    )
    publish(
        db,
        [(Role.CLIENT, client.id)],
        "client_form.shared",
        {"client_form_ids": [form.id for form in forms]},
    )
    notify(
        db,
        Role.CLIENT,
        client.id,
        kind="forms_shared",
        title="You have documents to complete",
        link="/client/documents",
    )
    return forms


def remind_client(
    db: Session,
    client: Client,
    forms: Sequence[ClientForm],
    now: datetime,
    *,
    dedupe_key: str | None = None,
) -> bool:
    """Send one reminder email covering the client's pending forms and record it on each."""
    sent = _queue_documents_email(
        db,
        client,
        subject=f"Reminder: documents to complete for {client.practice.name}",
        heading="Your documents are waiting",
        paragraphs=[
            "You have documents waiting in your secure client portal.",
            "Completing them before your next appointment helps your session start smoothly.",
        ],
        dedupe_key=dedupe_key,
    )
    if not sent:
        return False
    for form in forms:
        form.last_reminded_at = now
        form.reminder_count += 1
    return True


def record_submission(
    form: ClientForm,
    answers: dict[str, Any],
    *,
    signature_name: str | None,
    signer_ip: str,
    signer_user_agent: str,
    now: datetime,
) -> None:
    """Store validated answers, the computed score and (when required) the e-signature."""
    result = score_answers(form.scoring, answers)
    form.answers = answers
    form.score = result.score
    form.score_label = result.label
    form.flagged = result.flagged
    form.flag_reason = result.flag_reason
    form.status = ClientFormStatus.COMPLETED
    form.completed_at = now
    if form.viewed_at is None:
        form.viewed_at = now
    if form.requires_signature:
        form.signature_name = (signature_name or "").strip()
        form.signed_at = now
        form.signer_ip = signer_ip[:45]
        form.signer_user_agent = signer_user_agent[:300]
        form.signature_sha256 = form.compute_signature_sha256()


def _fill_emergency_contact(client: Client, answers: Mapping[str, str]) -> list[str]:
    """Record the emergency contact given in a form's emergency-contact answers.

    A named person who is already one of the client's contacts (say, the parent filling in
    the form) becomes an emergency contact; anyone else is added as one. Without a name the
    answers go to the client's first emergency contact. Only empty details are filled in.
    """
    name = answers.get(MappableField.EMERGENCY_CONTACT_NAME)
    if name is None:
        contact = next((c for c in client.contacts if c.is_emergency_contact), None)
        if contact is None:
            return []
    else:
        contact = next(
            (c for c in client.contacts if c.full_name.casefold() == name.casefold()), None
        )
    filled: list[str] = []
    if contact is None:
        first_name, _, last_name = name.partition(" ")
        contact = ClientContact(first_name=first_name, last_name=last_name.strip())
        client.contacts.append(contact)
        filled.append(MappableField.EMERGENCY_CONTACT_NAME.value)
    contact.is_emergency_contact = True
    for mapped in (
        MappableField.EMERGENCY_CONTACT_PHONE,
        MappableField.EMERGENCY_CONTACT_RELATIONSHIP,
    ):
        value = answers.get(mapped)
        attribute = _EMERGENCY_CONTACT_COLUMNS[mapped]
        if value is not None and not getattr(contact, attribute):
            setattr(contact, attribute, value)
            filled.append(mapped.value)
    return filled


def autofill_client(
    client: Client, fields: Sequence[Mapping[str, Any]], answers: Mapping[str, Any]
) -> list[str]:
    """Copy mapped answers into the client's record where those fields are still empty.

    Returns the maps_to values that filled something in.
    """
    filled: list[str] = []
    emergency: dict[str, str] = {}
    for field in fields:
        column = field.get("maps_to")
        value = answers.get(field["id"])
        if column not in _MAPPABLE_COLUMNS or value is None:
            continue
        if column in _EMERGENCY_CONTACT_COLUMNS:
            emergency[column] = value
            continue
        if getattr(client, column):
            continue
        if column == MappableField.DATE_OF_BIRTH:
            value = date.fromisoformat(value)
        setattr(client, column, value)
        filled.append(column)
    return filled + _fill_emergency_contact(client, emergency)


def form_reviewers(db: Session, client: Client) -> list[StaffMember]:
    """Who hears about a client's completed forms: their care-team clinicians and supervisors.

    Only staff with clinical access to the client qualify. A client without a care team falls
    back to everyone with clinical access, so a flagged response always reaches someone.
    """
    clinical = staff_with_client_access(db, client, ClientAccess.CLINICAL)
    care_team = [member.staff for member in client.care_team]
    reviewer_ids = {staff.id for staff in care_team} | {staff.supervisor_id for staff in care_team}
    reviewers = [staff for staff in clinical if staff.id in reviewer_ids]
    return reviewers or clinical


def notify_form_completed(db: Session, form: ClientForm, client: Client) -> None:
    """Tell staff a form was completed.

    Everyone who can see the client's forms gets a realtime refresh; the client's reviewers
    (see form_reviewers) get an in-app notification and a content-free email. Flagged responses
    are urgent and always emailed; otherwise the email waits for the client's last pending form
    and respects each reviewer's notify_email_forms preference.
    """
    publish(
        db,
        client_team_recipients(db, client, ClientAccess.PROFILE),
        "client_form.completed",
        {"client_form_id": form.id, "client_id": client.id},
    )
    app_path = f"/portal/clients/{client.id}"
    title = (
        f"{short_name(client)}'s {form.name} needs your review"
        if form.flagged
        else f"{short_name(client)} completed {form.name}"
    )
    reviewers = form_reviewers(db, client)
    for staff in reviewers:
        notify(
            db,
            Role.STAFF,
            staff.id,
            kind="form_flagged" if form.flagged else "form_completed",
            title=title,
            link=f"{app_path}?tab=forms",
            urgent=form.flagged,
        )
    if form.flagged:
        for staff in reviewers:
            queue_staff_email(
                db,
                staff,
                subject="A completed assessment needs your review",
                heading="An assessment needs your review",
                paragraphs=[
                    "A client completed an assessment with a response that may need your prompt "
                    "attention. Sign in to review it."
                ],
                button_label="Review in Synari",
                app_path=app_path,
                dedupe_key=f"client-form-flagged:{form.id}:{staff.id}",
            )
        return
    still_pending = db.scalar(
        select(func.count())
        .select_from(ClientForm)
        .where(
            ClientForm.client_id == client.id,
            ClientForm.status == ClientFormStatus.PENDING,
            ClientForm.id != form.id,
        )
    )
    if still_pending:
        return
    for staff in reviewers:
        if not staff.notify_email_forms:
            continue
        queue_staff_email(
            db,
            staff,
            subject="A client completed their documents",
            heading="Documents completed",
            paragraphs=[
                "A client finished all the documents shared with them. Sign in to review them."
            ],
            button_label="Open Synari",
            app_path=app_path,
            dedupe_key=f"client-forms-completed:{form.id}:{staff.id}",
        )


# --- Worker job ------------------------------------------------------------------------------


def remind_incomplete_forms(db: Session, now: datetime) -> None:
    """Worker job: remind clients about forms still pending 3+ days after they were shared.

    One email per client per 3-day window covers all their pending forms, and each form is
    reminded at most MAX_REMINDERS times (reminders sent by staff count too). The email comes
    from the client's practice.
    """
    cutoff = now - REMINDER_INTERVAL
    other = aliased(ClientForm)
    reminded_recently = exists().where(
        other.client_id == ClientForm.client_id, other.last_reminded_at > cutoff
    )
    rows = db.execute(
        select(ClientForm, Client)
        .join(Client, Client.id == ClientForm.client_id)
        .where(
            ClientForm.status == ClientFormStatus.PENDING,
            ClientForm.sent_at <= cutoff,
            ClientForm.reminder_count < MAX_REMINDERS,
            Client.portal_enabled,
            Client.status.in_(PORTAL_CLIENT_STATUSES),
            Client.email.is_not(None),
            ~reminded_recently,
        )
        .order_by(ClientForm.client_id, ClientForm.id)
        .limit(REMINDER_BATCH_SIZE)
        .with_for_update(of=ClientForm, skip_locked=True)
    ).all()
    forms_by_client: dict[int, list[ClientForm]] = defaultdict(list)
    clients: dict[int, Client] = {}
    for form, client in rows:
        forms_by_client[client.id].append(form)
        clients[client.id] = client
    window = int(now.timestamp() // REMINDER_INTERVAL.total_seconds())
    for client_id, forms in forms_by_client.items():
        remind_client(
            db,
            clients[client_id],
            forms,
            now,
            dedupe_key=f"client-forms-reminder:{client_id}:{window}",
        )
    db.commit()
