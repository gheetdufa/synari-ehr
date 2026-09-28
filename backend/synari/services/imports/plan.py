"""Turning the uploaded files into what an import will create (the plan) and its preview.

SimplePractice reports share no client id, so clients are matched across files by name:
names are compared ignoring order, case, accents, middle initials and honorifics, and a date of
birth, email or phone number tells apart clients who share a name. Files that list clients
(Client List, Client details, contact cards, demographics, in that order of trust) build the
roster; sessions, balances and document folders are matched to it. Names that are only similar
(e.g. "Katie" and "Katherine Doe") or ambiguous are listed for the practice to confirm, and
clients that may already be in Synari (same name without a matching birth date or email) too.

The plan is built from the same files, column mapping and options for the preview and for
the import, so the practice's decisions apply to both and the import is repeatable.
"""

import hashlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from difflib import SequenceMatcher
from pathlib import PurePosixPath

from sqlalchemy import Row, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import Client, ImportRecord, StaffMember
from synari.models.enums import AppointmentStatus, BillingType, ImportFileKind, StaffStatus
from synari.schemas.imports import (
    ClinicianInvite,
    ExistingReview,
    ImportOptions,
    ImportPreview,
    ImportWarning,
    MatchCandidate,
    MatchReview,
    PreviewClinician,
    PreviewCounts,
    PreviewFile,
    PreviewFolder,
)
from synari.services.imports import values
from synari.services.imports.archive import (
    PSYCHOTHERAPY_NOTES,
    SECURE_MESSAGES,
    ExportArchive,
    ZipEntry,
    folder_person,
)
from synari.services.imports.fields import CLINICAL_FIELDS, KINDS, missing_required
from synari.services.imports.tables import Table
from synari.services.imports.vcard import ContactCard
from synari.services.storage import ALLOWED_TYPES

# Sessions without a time in the report start at 9:00 in the clinician's time zone; a
# clinician's later sessions that day follow on the next hour.
DEFAULT_START = time(9, 0)
LATEST_START = time(21, 0)
DEFAULT_MINUTES = 50
CPT_MINUTES = {
    "90832": 30,
    "90833": 30,
    "90834": 45,
    "90836": 45,
    "90837": 60,
    "90838": 60,
    "90791": 60,
    "90792": 60,
    "90839": 60,
    "90846": 50,
    "90847": 50,
    "90849": 60,
    "90853": 60,
}
SIMILARITY_THRESHOLD = 0.85
NO_CLINICIAN = "No clinician listed"
MAX_CANDIDATES = 5
MAX_REVIEW_ITEMS = 500
SAMPLE_ROWS = 3

# Roster files, most trusted first.
ROSTER_KINDS = (
    ImportFileKind.CLIENT_LIST,
    ImportFileKind.CLIENT_DETAILS,
    ImportFileKind.CLIENT_DEMOGRAPHICS,
)
CONTACT_CARD = "contact_card"
FOLDER = "folder"
_GUARDIAN_WORDS = (
    "guardian",
    "parent",
    "mother",
    "father",
    "mom",
    "dad",
    "grandmother",
    "grandfather",
    "grandparent",
    "foster",
)
_DEMOGRAPHIC_FIELDS = (
    ("race", "Race"),
    ("relationship_status", "Relationship status"),
    ("employment_status", "Employment status"),
    ("preferred_language", "Preferred language"),
)


# Inputs ----------------------------------------------------------------------------------------


@dataclass
class SheetInput:
    file_id: int
    kind: ImportFileKind
    filename: str
    table: Table
    mapping: dict[str, str | None]


# The plan --------------------------------------------------------------------------------------


@dataclass
class PlannedContact:
    key: str
    first_name: str
    last_name: str
    relation: str = ""
    email: str = ""
    phone: str = ""
    is_emergency_contact: bool = False
    is_guardian: bool = False


@dataclass
class PlannedPolicy:
    payer_name: str
    payer_external_id: str = ""
    member_id: str = ""
    group_number: str = ""
    copay_cents: int | None = None
    subscriber_relationship: str = "18"
    subscriber_first_name: str = ""
    subscriber_last_name: str = ""
    subscriber_dob: date | None = None
    subscriber_sex: str = ""
    subscriber_address_line1: str = ""
    subscriber_city: str = ""
    subscriber_state: str = ""
    subscriber_postal_code: str = ""


@dataclass
class PlannedClient:
    key: str
    first_name: str
    last_name: str
    preferred_name: str = ""
    birth: date | None = None
    sex: str = ""
    gender_identity: str = ""
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    address_line1: str = ""
    address_line2: str = ""
    city: str = ""
    state: str = ""
    postal_code: str = ""
    status: str | None = None
    client_type: str = ""
    is_minor: bool | None = None
    age: int | None = None
    billing_type: str | None = None
    clinician_key: str = ""
    # Every clinician who saw the client in the imported sessions.
    session_clinicians: Counter[str] = field(default_factory=Counter)
    diagnoses: list[dict[str, str]] = field(default_factory=list)
    demographics: list[str] = field(default_factory=list)
    contacts: dict[str, PlannedContact] = field(default_factory=dict)
    policy: PlannedPolicy | None = None
    name_keys: set[str] = field(default_factory=set)
    phone_digits: set[str] = field(default_factory=set)
    roster_files: set[tuple[str, int | None]] = field(default_factory=set)
    # The Synari client to update (else a new client is added).
    existing_id: int | None = None
    # Whether an earlier import created the Synari client (its fields may be overwritten).
    created_by_import: bool = False

    @property
    def display_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


@dataclass
class PlannedAppointment:
    key: str
    client_key: str
    clinician_key: str
    day: date
    start: time
    minutes: int
    cpt: str
    fee_cents: int | None
    status: AppointmentStatus
    location: str = ""


@dataclass
class PlannedDocument:
    key: str
    client_key: str
    entry: ZipEntry


@dataclass
class PlannedBalance:
    key: str
    client_key: str
    amount_cents: int


@dataclass
class ClinicianRef:
    key: str
    name: str


@dataclass
class ClinicianTarget:
    """Who a SimplePractice clinician becomes: a staff id, an invitation, or neither (the
    default clinician)."""

    staff_id: int | None
    invite: ClinicianInvite | None
    matched: bool


@dataclass
class Plan:
    clients: list[PlannedClient]
    appointments: list[PlannedAppointment]
    documents: list[PlannedDocument]
    balances: list[PlannedBalance]
    clinicians: dict[str, ClinicianRef]
    choices: dict[str, ClinicianTarget]
    preview: ImportPreview

    def __post_init__(self) -> None:
        self._by_key = {c.key: c for c in self.clients}

    def client(self, key: str) -> PlannedClient:
        return self._by_key[key]


# Building ----------------------------------------------------------------------------------------


@dataclass
class _Mention:
    source: str
    kind: str
    file_id: int | None
    person: values.PersonName
    birth: date | None = None
    email: str = ""
    phone: str = ""
    primary: bool = False

    @property
    def review_id(self) -> str:
        raw = f"{self.person.key}|{self.birth or ''}"
        return hashlib.sha256(raw.encode()).hexdigest()[:12]


@dataclass
class _Review:
    reason: str
    name: str
    candidates: list[PlannedClient]
    sources: Counter[str] = field(default_factory=Counter)


class _Warnings:
    def __init__(self) -> None:
        self._counts: Counter[str] = Counter()
        self._messages: dict[str, tuple[str, dict[str, str]]] = {}

    def add(self, code: str, message: str, count: int = 1, **names: str) -> None:
        """Count a warning; `message` is a values.counted() template for the total."""
        self._counts[code] += count
        self._messages[code] = (message, names)

    def render(self) -> list[ImportWarning]:
        warnings: list[ImportWarning] = []
        for code, n in self._counts.items():
            template, names = self._messages[code]
            message = values.counted(template, n, **names)
            warnings.append(ImportWarning(code=code.split(":")[0], message=message, count=n))
        return warnings


def _row_person(row: dict[str, str]) -> values.PersonName | None:
    first = " ".join(row.get("first_name", "").split())
    last = " ".join(row.get("last_name", "").split())
    preferred = " ".join(row.get("preferred_name", "").split())
    if first or last:
        person = values.PersonName(first, last, preferred)
    else:
        full = row.get("name") or row.get("client") or ""
        if not full.strip():
            return None
        split = values.split_name(full)
        person = values.PersonName(split.first, split.last, preferred or split.preferred)
    return person if person.key else None


def _contact_flags(relation: str) -> tuple[bool, bool]:
    lowered = relation.lower()
    return "emergency" in lowered, any(word in lowered for word in _GUARDIAN_WORDS)


def _first(*candidates: str) -> str:
    return next((c.strip() for c in candidates if c and c.strip()), "")


class _Builder:
    def __init__(self, db: Session, practice_id: int, options: ImportOptions, today: date) -> None:
        self.db = db
        self.practice_id = practice_id
        self.options = options
        self.today = today
        self.warnings = _Warnings()
        self.clients: list[PlannedClient] = []
        self.by_key: dict[str, PlannedClient] = {}
        self.positions: dict[str, int] = {}
        self.by_name: dict[str, list[PlannedClient]] = {}
        self.by_token: dict[str, set[int]] = {}
        self.reviews: dict[str, _Review] = {}
        self.review_counts: Counter[tuple[str, str]] = Counter()
        # Planned client key -> reviews whose names were resolved to it.
        self.reviewed: dict[str, set[str]] = {}
        self.clinicians: dict[str, ClinicianRef] = {}
        self.appointments: list[PlannedAppointment] = []
        self.documents: list[PlannedDocument] = []
        self.balances: list[PlannedBalance] = []
        self.counts = PreviewCounts()
        self.preview_files: list[PreviewFile] = []
        self.folders: list[PreviewFolder] = []

    # Clients ------------------------------------------------------------------------------------

    def _index(self, client: PlannedClient, key: str) -> None:
        if key in client.name_keys:
            return
        client.name_keys.add(key)
        self.by_name.setdefault(key, []).append(client)
        position = self.positions[client.key]
        for token in key.split():
            self.by_token.setdefault(token, set()).add(position)

    def _compatible(self, client: PlannedClient, mention: _Mention) -> bool:
        if mention.primary and (mention.kind, mention.file_id) in client.roster_files:
            return False  # a roster file lists each client once
        return not (client.birth and mention.birth and client.birth != mention.birth)

    def _narrow(self, candidates: list[PlannedClient], mention: _Mention) -> list[PlannedClient]:
        tests = (
            (mention.birth, lambda c: c.birth == mention.birth),
            (mention.email, lambda c: mention.email in c.emails),
            (mention.phone, lambda c: mention.phone in c.phone_digits),
        )
        for present, test in tests:
            if not present:
                continue
            narrowed = [c for c in candidates if test(c)]
            if len(narrowed) == 1:
                return narrowed
        return candidates

    def _similar(self, mention: _Mention) -> list[PlannedClient]:
        tokens = mention.person.key.split()
        pool = set().union(*(self.by_token.get(t, set()) for t in tokens)) if tokens else set()
        scored: list[tuple[float, int, PlannedClient]] = []
        for position in sorted(pool):
            client = self.clients[position]
            if not self._compatible(client, mention):
                continue
            score = max(_similarity(mention.person.key, key) for key in client.name_keys)
            if score >= SIMILARITY_THRESHOLD:
                scored.append((score, position, client))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [client for _, _, client in scored[:MAX_CANDIDATES]]

    def _new_client(self, mention: _Mention) -> PlannedClient:
        base = f"{mention.person.key}|{mention.birth.isoformat() if mention.birth else ''}"
        key = base
        taken = {c.key for c in self.clients}
        counter = 1
        while key in taken:
            counter += 1
            key = f"{base}#{counter}"
        client = PlannedClient(
            key=key,
            first_name=mention.person.first[:100] or mention.person.last[:100],
            last_name=mention.person.last[:100],
            preferred_name=mention.person.preferred[:100],
        )
        self.positions[key] = len(self.clients)
        self.clients.append(client)
        self.by_key[key] = client
        self._index(client, mention.person.key)
        if len(self.by_name[mention.person.key]) == 2:
            self.warnings.add(
                "duplicate_names",
                "{n} client{s} share{v} a name with another client: kept apart by date of "
                "birth, email or phone, or listed to confirm",
            )
        return self._attach(client, mention)

    def _attach(self, client: PlannedClient, mention: _Mention) -> PlannedClient:
        self._index(client, mention.person.key)
        if mention.person.preferred:
            # "Kate Smith" in a session report is Katherine Smith who goes by Kate.
            alias = values.name_key(f"{mention.person.preferred} {mention.person.last}")
            if alias:
                self._index(client, alias)
        if mention.primary:
            client.roster_files.add((mention.kind, mention.file_id))
        if mention.birth and not client.birth:
            client.birth = mention.birth
        if mention.email and mention.email not in client.emails:
            client.emails.append(mention.email)
        if mention.phone:
            client.phone_digits.add(mention.phone)
        if mention.person.preferred and not client.preferred_name:
            client.preferred_name = mention.person.preferred[:100]
        return client

    def place(self, mention: _Mention) -> PlannedClient | None:
        """The planned client a mention belongs to (new if needed), or None to skip it."""
        exact = [
            c for c in self.by_name.get(mention.person.key, []) if self._compatible(c, mention)
        ]
        if len(exact) == 1:
            return self._matched(exact[0], mention)
        if len(exact) > 1:
            narrowed = self._narrow(exact, mention)
            if len(narrowed) == 1:
                return self._matched(narrowed[0], mention)
            reason, candidates = "same_name", exact
        else:
            candidates = self._similar(mention)
            reason = "similar_name"
        if not candidates:
            return self._new_or_skip(mention)
        self.review_counts[(mention.review_id, mention.source)] += 1
        review = self.reviews.setdefault(
            mention.review_id,
            _Review(reason, mention.person.display, candidates[:MAX_CANDIDATES]),
        )
        decision = self.options.matches.get(mention.review_id)
        chosen = next((c for c in review.candidates if c.key == decision), None)
        if chosen is not None:
            client: PlannedClient | None = self._attach(chosen, mention)
        elif decision is None and reason == "same_name" and not mention.primary:
            return None  # an undecided ambiguous name: skip rather than guess
        else:
            client = self._new_or_skip(mention)
        if client is not None:
            self.reviewed.setdefault(client.key, set()).add(mention.review_id)
        return client

    def _matched(self, client: PlannedClient, mention: _Mention) -> PlannedClient:
        """Attach a clear match, counting it towards a review its name went through before."""
        if mention.review_id in self.reviewed.get(client.key, set()):
            self.review_counts[(mention.review_id, mention.source)] += 1
        return self._attach(client, mention)

    def _new_or_skip(self, mention: _Mention) -> PlannedClient | None:
        if mention.primary or self.options.create_missing_clients:
            return self._new_client(mention)
        return None

    # Roster files -------------------------------------------------------------------------------

    def _mention(
        self, row: dict[str, str], source: str, kind: str, file_id: int, *, primary: bool
    ) -> _Mention | None:
        person = _row_person(row)
        if person is None:
            return None
        contact = row.get("contact", "")
        email = values.clean_email(_first(row.get("email", ""), contact if "@" in contact else ""))
        phone = values.phone_digits(_first(row.get("phone", ""), "" if "@" in contact else contact))
        return _Mention(
            source=source,
            kind=kind,
            file_id=file_id,
            person=person,
            birth=values.parse_date(row.get("date_of_birth", "")),
            email=email,
            phone=phone,
            primary=primary,
        )

    def add_roster_sheet(self, sheet: SheetInput) -> None:
        label = KINDS[sheet.kind].label
        rows = sheet.table.records(sheet.mapping)
        for row in rows:
            if row.get("date_of_birth") and values.parse_date(row["date_of_birth"]) is None:
                self.warnings.add(
                    f"bad_birth_date:{sheet.file_id}",
                    "{n} date{s} of birth in {file} couldn't be read and {were} left blank",
                    file=sheet.filename,
                )
            mention = self._mention(row, label, sheet.kind, sheet.file_id, primary=True)
            if mention is None:
                self._no_name(sheet)
                continue
            client = self.place(mention)
            if client is not None:
                self._merge_row(client, sheet.kind, row)

    def _no_name(self, sheet: SheetInput) -> None:
        self.warnings.add(
            f"no_name:{sheet.file_id}",
            "{n} row{s} in {file} {have} no client name and {were} skipped",
            file=sheet.filename,
        )

    def _merge_row(self, client: PlannedClient, kind: ImportFileKind, row: dict[str, str]) -> None:
        get = row.get
        if get("phone") and not client.phones:
            client.phones.append(values.clean_phone(get("phone", "")))
        contact = get("contact", "")
        if contact and "@" not in contact and not client.phones:
            client.phones.append(values.clean_phone(contact))
        if not client.address_line1 and get("address"):
            client.address_line1 = get("address", "")[:200]
            client.address_line2 = get("address2", "")[:200]
        client.city = client.city or get("city", "")[:100]
        client.state = client.state or get("state", "")[:50]
        client.postal_code = client.postal_code or get("zip", "")[:20]
        client.sex = client.sex or values.sex(get("sex", ""))
        client.gender_identity = client.gender_identity or get("gender_identity", "")[:100]
        client.status = client.status or values.client_status(get("status", ""))
        client.client_type = client.client_type or get("client_type", "")
        if client.is_minor is None and get("minor"):
            client.is_minor = values.yes(get("minor", ""))
        if client.age is None and get("age", "").strip().isdigit():
            client.age = int(get("age", "").strip())
        if client.billing_type is None and get("billing_type"):
            client.billing_type = values.billing_type(get("billing_type", ""))
        if not client.clinician_key and get("clinician"):
            client.clinician_key = self.clinician(get("clinician", ""))
        for code in values.diagnoses(get("diagnoses", "")):
            if all(existing["code"] != code["code"] for existing in client.diagnoses):
                client.diagnoses.append(code)
        for name, label in _DEMOGRAPHIC_FIELDS:
            value = " ".join(get(name, "").split())
            if value and not any(line.startswith(f"{label}:") for line in client.demographics):
                client.demographics.append(f"{label}: {value}")
        self._merge_policy(client, kind, row)
        self._merge_contact(
            client,
            name=get("contact_name", ""),
            relation=get("contact_relationship", ""),
            email=get("contact_email", ""),
            phone=get("contact_phone", ""),
        )

    def _merge_policy(
        self, client: PlannedClient, kind: ImportFileKind, row: dict[str, str]
    ) -> None:
        if client.policy is not None:
            return
        get = row.get
        payer = _first(get("payer_name", ""), get("primary_insurance", ""))
        if not payer and not get("payer_id"):
            return
        subscriber = values.split_name(get("subscriber_name", ""))
        client.policy = PlannedPolicy(
            payer_name=(payer or get("payer_id", ""))[:200],
            payer_external_id=get("payer_id", "").strip()[:50],
            member_id=_first(get("member_id", ""), get("insurance_id", ""))[:80],
            group_number=get("group_id", "").strip()[:80],
            copay_cents=values.parse_cents(get("copay", "")),
            subscriber_relationship=values.subscriber_relationship(
                get("subscriber_relationship", "")
            ),
            subscriber_first_name=_first(get("subscriber_first_name", ""), subscriber.first)[:100],
            subscriber_last_name=_first(get("subscriber_last_name", ""), subscriber.last)[:100],
            subscriber_dob=values.parse_date(get("subscriber_dob", "")),
            subscriber_sex=values.subscriber_sex(get("subscriber_sex", "")),
            subscriber_address_line1=get("subscriber_address", "")[:200],
            subscriber_city=get("subscriber_city", "")[:100],
            subscriber_state=get("subscriber_state", "")[:50],
            subscriber_postal_code=get("subscriber_zip", "")[:20],
        )

    def _merge_contact(
        self, client: PlannedClient, *, name: str, relation: str, email: str, phone: str
    ) -> None:
        person = values.split_name(name)
        if not person.key or person.key in client.name_keys:
            return
        emergency, guardian = _contact_flags(relation)
        found = client.contacts.get(person.key)
        if found is None:
            client.contacts[person.key] = PlannedContact(
                key=person.key,
                first_name=(person.first or person.last)[:100],
                last_name=person.last[:100] if person.first else "",
                relation=relation.strip()[:50],
                email=values.clean_email(email),
                phone=values.clean_phone(phone),
                is_emergency_contact=emergency,
                is_guardian=guardian,
            )
            return
        found.relation = found.relation or relation.strip()[:50]
        found.email = found.email or values.clean_email(email)
        found.phone = found.phone or values.clean_phone(phone)
        found.is_emergency_contact = found.is_emergency_contact or emergency
        found.is_guardian = found.is_guardian or guardian

    def add_contact_cards(self, archive: ExportArchive) -> None:
        groups, unreadable = archive.contact_groups()
        if unreadable:
            self.warnings.add(
                "unreadable_contacts",
                "{n} contact file{s} in the export couldn't be read and {were} skipped",
                unreadable,
            )
        for group in groups:
            card = group.client
            person = values.split_name(card.name)
            if not person.key:
                person, _ = folder_person(group.folder)
            if not person.key:
                continue
            if card.nickname:
                person = values.PersonName(person.first, person.last, card.nickname)
            mention = _Mention(
                source="Export contact cards",
                kind=CONTACT_CARD,
                file_id=None,
                person=person,
                birth=card.birthday,
                email=values.clean_email(card.emails[0]) if card.emails else "",
                phone=values.phone_digits(card.phones[0]) if card.phones else "",
                primary=True,
            )
            client = self.place(mention)
            if client is None:
                continue
            self._merge_card(client, card)
            for contact in group.contacts:
                self._merge_contact(
                    client,
                    name=contact.name,
                    relation=contact.relationship,
                    email=contact.emails[0] if contact.emails else "",
                    phone=contact.phones[0] if contact.phones else "",
                )

    def _merge_card(self, client: PlannedClient, card: ContactCard) -> None:
        for email in card.emails:
            cleaned = values.clean_email(email)
            if cleaned and cleaned not in client.emails:
                client.emails.append(cleaned)
        if card.phones and not client.phones:
            client.phones.append(values.clean_phone(card.phones[0]))
        if not client.address_line1 and card.street:
            client.address_line1 = card.street[:200]
            client.city = client.city or card.city[:100]
            client.state = client.state or card.state[:50]
            client.postal_code = client.postal_code or card.postal_code[:20]
        client.sex = client.sex or values.sex(card.gender)

    # Clinicians ---------------------------------------------------------------------------------

    def clinician(self, name: str) -> str:
        """The clinician's key; the fullest spelling (e.g. with credentials) is kept to show."""
        key = values.clinician_key(name)
        spelled = " ".join(name.split())[:200]
        if key and len(spelled) > len(self.clinicians.get(key, ClinicianRef(key, "")).name):
            self.clinicians[key] = ClinicianRef(key, spelled)
        return key

    # Sessions -----------------------------------------------------------------------------------

    def _session_rows(
        self, sheet: SheetInput
    ) -> list[tuple[PlannedClient, date, str, dict[str, str]]]:
        """Rows with a readable date and a matched client, in the past."""
        label = KINDS[sheet.kind].label
        found: list[tuple[PlannedClient, date, str, dict[str, str]]] = []
        for row in sheet.table.records(sheet.mapping):
            day = values.parse_date(row.get("date_of_service", ""))
            if day is None:
                self.warnings.add(
                    f"bad_date:{sheet.file_id}",
                    "{n} row{s} in {file} {have} a date that couldn't be read and {were} skipped",
                    file=sheet.filename,
                )
                continue
            mention = self._mention(row, label, sheet.kind, sheet.file_id, primary=False)
            if mention is None:
                self._no_name(sheet)
                continue
            client = self.place(mention)
            if client is None:
                self._unmatched(sheet.filename, sheet.file_id)
                continue
            if day >= self.today:
                self.counts.future_appointments_skipped += 1
                continue
            clinician_key = self.clinician(row.get("clinician", ""))
            found.append((client, day, clinician_key, row))
        return found

    def _unmatched(self, filename: str, file_id: int) -> None:
        self.warnings.add(
            f"unmatched:{file_id}",
            "{n} row{s} in {file} name{v} a client who isn't in the import and {were} skipped",
            file=filename,
        )

    def _status(self, raw: str, filename: str, file_id: int) -> AppointmentStatus | None:
        status = values.attendance(raw)
        if status is None and raw.strip():
            self.warnings.add(
                f"unknown_status:{file_id}",
                "{n} session{s} in {file} {have} a status that wasn't recognized; {they} "
                "imported as attended",
                file=filename,
            )
        return status

    def add_sessions(
        self, status_sheets: list[SheetInput], attendance_sheets: list[SheetInput]
    ) -> None:
        attendance: dict[tuple[str, date], list[tuple[str, AppointmentStatus | None, str]]] = {}
        for sheet in attendance_sheets:
            for client, day, clinician_key, row in self._session_rows(sheet):
                status = self._status(row.get("status", ""), sheet.filename, sheet.file_id)
                attendance.setdefault((client.key, day), []).append(
                    (clinician_key, status, " ".join(row.get("location", "").split()))
                )
        drafts: list[tuple[PlannedClient, date, str, dict[str, str], str]] = []
        for sheet in status_sheets:
            for client, day, clinician_key, row in self._session_rows(sheet):
                status = self._status(row.get("status", ""), sheet.filename, sheet.file_id)
                pending = attendance.get((client.key, day), [])
                match = next((a for a in pending if a[0] == clinician_key), None) or (
                    pending[0] if pending else None
                )
                location = ""
                if match is not None:
                    pending.remove(match)
                    status = status or match[1]
                    location = match[2]
                row = {**row, "_status": (status or AppointmentStatus.ATTENDED).value}
                drafts.append((client, day, clinician_key, row, location))
        for (client_key, day), remaining in attendance.items():
            client = self.by_key[client_key]
            for clinician_key, status, location in remaining:
                row = {"_status": (status or AppointmentStatus.ATTENDED).value}
                drafts.append((client, day, clinician_key, row, location))
        self._schedule(drafts)

    def _schedule(self, drafts: list[tuple[PlannedClient, date, str, dict[str, str], str]]) -> None:
        """Give each session a start time and duration, and a stable key."""
        cursors: dict[tuple[str, date], datetime] = {}
        ordinals: Counter[str] = Counter()
        for client, day, clinician_key, row, location in drafts:
            cpt = (row.get("cpt_code", "").replace(",", " ").split() or [""])[0][:20]
            minutes = values.parse_minutes(row.get("duration", "")) or CPT_MINUTES.get(
                cpt, DEFAULT_MINUTES
            )
            owner = clinician_key or client.clinician_key
            start = values.parse_time(row.get("start_time", ""))
            if start is None:
                cursor = cursors.get((owner, day), datetime.combine(day, DEFAULT_START))
                late = cursor.date() != day or cursor.time() > LATEST_START
                start = LATEST_START if late else cursor.time()
                end = datetime.combine(day, start) + timedelta(minutes=minutes)
                next_hour = end.replace(minute=0) + timedelta(hours=1 if end.minute else 0)
                cursors[(owner, day)] = next_hour
            base = f"appt|{client.key}|{day.isoformat()}|{clinician_key}|{cpt}"
            ordinals[base] += 1
            if clinician_key:
                client.session_clinicians[clinician_key] += 1
            self.appointments.append(
                PlannedAppointment(
                    key=f"{base}|{ordinals[base]}",
                    client_key=client.key,
                    clinician_key=clinician_key,
                    day=day,
                    start=start,
                    minutes=minutes,
                    cpt=cpt,
                    fee_cents=_fee(row),
                    status=AppointmentStatus(row["_status"]),
                    location=location[:300],
                )
            )

    # Balances -----------------------------------------------------------------------------------

    def add_balances(self, sheets: list[SheetInput]) -> None:
        totals: dict[str, int] = {}
        for sheet in sheets:
            label = KINDS[sheet.kind].label
            for row in sheet.table.records(sheet.mapping):
                amount = values.parse_cents(row.get("client_balance", ""))
                if amount is None:
                    if row.get("client_balance", "").strip():
                        self.warnings.add(
                            f"bad_amount:{sheet.file_id}",
                            "{n} balance{s} in {file} couldn't be read and {were} skipped",
                            file=sheet.filename,
                        )
                    continue
                if amount == 0:
                    continue
                mention = self._mention(row, label, sheet.kind, sheet.file_id, primary=False)
                if mention is None:
                    self._no_name(sheet)
                    continue
                client = self.place(mention)
                if client is None:
                    self._unmatched(sheet.filename, sheet.file_id)
                    continue
                totals[client.key] = totals.get(client.key, 0) + amount
        for client_key, amount in totals.items():
            if amount > 0:
                self.balances.append(PlannedBalance(f"balance|{client_key}", client_key, amount))
            else:
                self.warnings.add(
                    "credit_balance",
                    "{n} client{s} {have} a credit in SimplePractice; record it as a payment "
                    "in Synari if you want to keep it",
                )

    # Documents ----------------------------------------------------------------------------------

    def add_documents(self, archive: ExportArchive) -> None:
        folders: dict[str, PlannedClient | None] = {}
        folder_names: dict[str, set[str]] = {}
        file_counts: Counter[str] = Counter()
        for entry in archive.entries:
            file_counts[entry.category] += 1
            folder_names.setdefault(entry.category, set())
            if entry.folder:
                folder_names[entry.category].add(entry.folder)
            if not entry.folder:
                self.counts.documents_skipped += 1
                self.warnings.add(
                    "no_client_folder",
                    "{n} file{s} in the export {werent} in a client's folder and {were} skipped",
                )
                continue
            if entry.folder not in folders:
                person, birth = folder_person(entry.folder)
                mention = (
                    _Mention("Export folders", FOLDER, None, person, birth) if person.key else None
                )
                folders[entry.folder] = self.place(mention) if mention else None
            client = folders[entry.folder]
            if client is None:
                self.counts.documents_skipped += 1
                self.warnings.add(
                    "unmatched_folder",
                    "{n} file{s} {are} in folders that don't match a client in the import and "
                    "{were} skipped",
                )
                continue
            if PurePosixPath(entry.filename).suffix.lower() not in ALLOWED_TYPES:
                self.counts.documents_skipped += 1
                self.warnings.add(
                    "unsupported_document",
                    "{n} file{s} in the export {are} of a type Synari doesn't store and {were} "
                    "skipped",
                )
                continue
            if entry.size > settings.max_upload_bytes:
                self.counts.documents_skipped += 1
                self.warnings.add(
                    "large_document",
                    "{n} file{s} in the export {are} larger than the upload limit and {were} "
                    "skipped",
                )
                continue
            self.documents.append(PlannedDocument(f"doc|{entry.path}", client.key, entry))
        if archive.skipped_outside:
            self.warnings.add(
                "outside_folders",
                "{n} file{s} in the export {werent} in a known SimplePractice folder and {were} "
                "skipped",
                archive.skipped_outside,
            )
        self.folders = [
            PreviewFolder(name=name, clients=len(folder_names[name]), files=file_counts[name])
            for name in sorted(file_counts)
        ]

    # Finishing ----------------------------------------------------------------------------------

    def finish_clients(self) -> None:
        for client in self.clients:
            if not client.clinician_key and client.session_clinicians:
                client.clinician_key = client.session_clinicians.most_common(1)[0][0]
            if client.is_minor is None:
                client.is_minor = values.is_minor_on(client.birth, self.today)
            if client.is_minor is None and client.age is not None:
                client.is_minor = client.age < 18
            if client.is_minor is None and "minor" in client.client_type.lower():
                client.is_minor = True
            if client.billing_type is None and client.policy is not None:
                client.billing_type = BillingType.INSURANCE
            if client.is_minor:
                for contact in client.contacts.values():
                    contact.is_guardian = (
                        contact.is_guardian or "parent" in contact.relation.lower()
                    )
            if client.client_type.lower() in ("couple", "family"):
                self.warnings.add(
                    "couple_records",
                    "{n} SimplePractice couple or family record{s} {were} imported as one "
                    "client each; review {them}",
                )

    def match_existing(self) -> list[ExistingReview]:
        """Link planned clients to Synari clients: an earlier import's client, the same email,
        or the same name and date of birth; same name only is listed for the practice."""
        existing = self.db.execute(
            select(
                Client.id, Client.first_name, Client.last_name, Client.date_of_birth, Client.email
            ).where(Client.practice_id == self.practice_id)
        ).all()
        by_email = {row.email.lower(): row for row in existing if row.email}
        by_name: dict[str, list[Row[tuple[int, str, str, date | None, str | None]]]] = {}
        for row in existing:
            by_name.setdefault(values.name_key(f"{row.first_name} {row.last_name}"), []).append(row)
        known_ids = {row.id for row in existing}
        records = self.db.scalars(
            select(ImportRecord)
            .where(ImportRecord.practice_id == self.practice_id, ImportRecord.kind == "client")
            .order_by(ImportRecord.id)
        ).all()
        imported = {r.source_key: r.target_id for r in records if r.target_id in known_ids}
        created = {r.target_id for r in records if r.outcome == "created"}
        claimed: set[int] = set()
        reviews: list[ExistingReview] = []
        for client in self.clients:
            target_id = imported.get(client.key)
            if target_id is not None:
                client.existing_id = target_id
                client.created_by_import = target_id in created
                claimed.add(target_id)
                continue
            match = next((by_email[e] for e in client.emails if e in by_email), None)
            if match is None and client.birth:
                match = next(
                    (
                        row
                        for key in client.name_keys
                        for row in by_name.get(key, [])
                        if row.date_of_birth == client.birth
                    ),
                    None,
                )
            if match is not None and match.id not in claimed:
                client.existing_id = match.id
                claimed.add(match.id)
                continue
            same_name = [
                row
                for key in sorted(client.name_keys)
                for row in by_name.get(key, [])
                if row.id not in claimed
                and not (row.date_of_birth and client.birth and row.date_of_birth != client.birth)
            ]
            if not same_name:
                continue
            decision = self.options.existing.get(client.key)
            chosen = next((row for row in same_name if row.id == decision), None)
            if chosen is not None:
                client.existing_id = chosen.id
                claimed.add(chosen.id)
            reviews.append(
                ExistingReview(
                    key=client.key,
                    name=client.display_name,
                    detail=_detail(client.birth, client.emails[0] if client.emails else ""),
                    candidates=[
                        MatchCandidate(
                            key=str(row.id),
                            name=f"{row.first_name} {row.last_name}",
                            detail=_detail(row.date_of_birth, row.email or ""),
                        )
                        for row in same_name[:MAX_CANDIDATES]
                    ],
                    decision=decision,
                )
            )
        return reviews

    def match_reviews(self) -> list[MatchReview]:
        sources_by_review: dict[str, list[str]] = {}
        for (review_id, source), count in sorted(self.review_counts.items()):
            if review_id in self.reviews:
                sources_by_review.setdefault(review_id, []).append(
                    f"{source} ({count} {'mention' if count == 1 else 'mentions'})"
                )
        reviews: list[MatchReview] = []
        for review_id, review in self.reviews.items():
            sources = sources_by_review.get(review_id, [])
            reviews.append(
                MatchReview(
                    id=review_id,
                    name=review.name,
                    sources=sources,
                    reason="same_name" if review.reason == "same_name" else "similar_name",
                    candidates=[
                        MatchCandidate(
                            key=c.key,
                            name=c.display_name,
                            detail=_detail(c.birth, c.emails[0] if c.emails else ""),
                        )
                        for c in review.candidates
                    ],
                    decision=self.options.matches.get(review_id),
                )
            )
        return reviews


def _similarity(left: str, right: str) -> float:
    """1.0 for the same name; nicknames that share a surname and the first three letters
    ('kate doe' / 'katherine doe') score 0.9; otherwise the character similarity."""
    if left == right:
        return 1.0
    left_tokens, right_tokens = set(left.split()), set(right.split())
    only_left, only_right = left_tokens - right_tokens, right_tokens - left_tokens
    if (
        len(only_left) == 1
        and len(only_right) == 1
        and left_tokens & right_tokens
        and next(iter(only_left))[:3] == next(iter(only_right))[:3]
    ):
        return 0.9
    return SequenceMatcher(None, left, right).ratio()


def _detail(birth: date | None, email: str) -> str:
    parts = [f"born {birth.isoformat()}" if birth else "", email]
    return " · ".join(p for p in parts if p)


def _fee(row: dict[str, str]) -> int | None:
    fee = values.parse_cents(row.get("charge", ""))
    if fee is None:
        fee = values.parse_cents(row.get("client_charge", ""))
    return fee if fee is None or fee >= 0 else None


def _sample(sheet: SheetInput) -> list[dict[str, str]]:
    rows = sheet.table.records(sheet.mapping)[:SAMPLE_ROWS]
    return [
        {name: value for name, value in row.items() if name not in CLINICAL_FIELDS and value}
        for row in rows
    ]


def clinician_choices(
    db: Session, practice_id: int, clinicians: dict[str, ClinicianRef], options: ImportOptions
) -> dict[str, ClinicianTarget]:
    """Each SimplePractice clinician's Synari clinician: the practice's choice, else the team
    member with the same name, else the only clinician of a solo practice."""
    staff = db.scalars(
        select(StaffMember).where(
            StaffMember.practice_id == practice_id,
            StaffMember.is_clinician,
            StaffMember.status.in_((StaffStatus.ACTIVE, StaffStatus.INVITED)),
        )
    ).all()
    by_name = {values.clinician_key(s.full_name): s.id for s in staff}
    active = [s for s in staff if s.status == StaffStatus.ACTIVE]
    solo = active[0].id if len(active) == 1 else None
    choices: dict[str, ClinicianTarget] = {}
    # "" stands for clients and sessions with no clinician in the files.
    for key in [*clinicians, ""]:
        chosen = options.clinicians.get(key)
        if chosen is not None:
            # An explicit choice; neither a clinician nor an invitation means the default.
            choices[key] = ClinicianTarget(chosen.staff_id, chosen.invite, matched=False)
            continue
        automatic = by_name.get(key, solo)
        choices[key] = ClinicianTarget(automatic, None, matched=automatic is not None)
    return choices


def build_plan(
    db: Session,
    practice_id: int,
    sheets: list[SheetInput],
    archive: ExportArchive | None,
    options: ImportOptions,
    today: date,
) -> Plan:
    """Match everything in the files and summarize it for the preview."""
    builder = _Builder(db, practice_id, options, today)
    by_kind: dict[ImportFileKind, list[SheetInput]] = {}
    for sheet in sheets:
        missing = missing_required(sheet.kind, sheet.mapping)
        builder.preview_files.append(
            PreviewFile(
                file_id=sheet.file_id,
                kind=sheet.kind,
                filename=sheet.filename,
                rows=len(sheet.table.rows),
                columns=sheet.mapping,
                missing_required=missing,
                sample=_sample(sheet),
            )
        )
        if missing:
            builder.warnings.add(
                f"missing_columns:{sheet.file_id}",
                "{file} has no column for {columns}, so it wasn't used; fix its column mapping",
                file=sheet.filename,
                columns=", ".join(missing),
            )
            continue
        by_kind.setdefault(sheet.kind, []).append(sheet)
    for kind in ROSTER_KINDS[:2]:
        for sheet in by_kind.get(kind, []):
            builder.add_roster_sheet(sheet)
    if archive is not None:
        builder.add_contact_cards(archive)
    for sheet in by_kind.get(ImportFileKind.CLIENT_DEMOGRAPHICS, []):
        builder.add_roster_sheet(sheet)
    builder.add_sessions(
        by_kind.get(ImportFileKind.APPOINTMENT_STATUS, []),
        by_kind.get(ImportFileKind.ATTENDANCE, []),
    )
    builder.add_balances(by_kind.get(ImportFileKind.OUTSTANDING_BALANCES, []))
    if archive is not None:
        builder.add_documents(archive)
    builder.finish_clients()
    existing = builder.match_existing()
    choices = clinician_choices(db, practice_id, builder.clinicians, options)
    plan_clients = builder.clients
    counts = builder.counts
    counts.clients_new = sum(1 for c in plan_clients if c.existing_id is None)
    counts.clients_existing = len(plan_clients) - counts.clients_new
    counts.contacts = sum(len(c.contacts) for c in plan_clients) if options.import_contacts else 0
    counts.insurance_policies = (
        sum(1 for c in plan_clients if c.policy) if options.import_insurance else 0
    )
    counts.clients_with_diagnoses = sum(1 for c in plan_clients if c.diagnoses)
    counts.appointments = len(builder.appointments) if options.import_appointments else 0
    if options.import_documents:
        counts.documents = len(builder.documents)
        counts.psychotherapy_notes = sum(
            1 for d in builder.documents if d.entry.category == PSYCHOTHERAPY_NOTES
        )
        counts.secure_messages = sum(
            1 for d in builder.documents if d.entry.category == SECURE_MESSAGES
        )
    if options.import_balances:
        counts.balances = len(builder.balances)
        counts.balance_total_cents = sum(b.amount_cents for b in builder.balances)
    clients_per = Counter(c.clinician_key for c in plan_clients)
    sessions_per = Counter(a.clinician_key for a in builder.appointments)
    matches = builder.match_reviews()
    if len(matches) > MAX_REVIEW_ITEMS or len(existing) > MAX_REVIEW_ITEMS:
        builder.warnings.add(
            "many_reviews",
            "Only the first {n} possible matches are listed; undecided ones are kept separate",
            MAX_REVIEW_ITEMS,
        )
    preview = ImportPreview(
        analyzed_at=utcnow(),
        counts=counts,
        files=builder.preview_files,
        folders=builder.folders,
        matches=matches[:MAX_REVIEW_ITEMS],
        existing=existing[:MAX_REVIEW_ITEMS],
        clinicians=[
            PreviewClinician(
                key=key,
                name=ref.name,
                clients=clients_per[key],
                appointments=sessions_per[key],
                staff_id=choices[key].staff_id,
                matched=choices[key].matched,
                invite=choices[key].invite,
            )
            for key, ref in [
                *sorted(builder.clinicians.items(), key=lambda item: item[1].name),
                *(
                    [("", ClinicianRef("", NO_CLINICIAN))]
                    if clients_per[""] or sessions_per[""]
                    else []
                ),
            ]
        ],
        warnings=builder.warnings.render(),
    )
    return Plan(
        clients=plan_clients,
        appointments=builder.appointments,
        documents=builder.documents,
        balances=builder.balances,
        clinicians=builder.clinicians,
        choices=choices,
        preview=preview,
    )
