"""The files the SimplePractice importer understands: their columns, header aliases and how
each kind of report is recognized from its headings.

SimplePractice's exact column headings aren't published, so every field lists the report labels
from SimplePractice's documentation plus common variants, matched case-insensitively and
ignoring punctuation. Practices can correct the mapping before importing.
"""

import re
from dataclasses import dataclass, field

from synari.models.enums import ImportFileKind

SPREADSHEET_EXTENSIONS = (".csv", ".xlsx")
ZIP_EXTENSIONS = (".zip",)

# A kind is only recognized when its headings score at least this much.
MIN_DETECTION_SCORE = 3


@dataclass(frozen=True)
class FieldDef:
    """A column the importer reads (or, with imported=False, only uses to recognize a report)."""

    name: str
    label: str
    aliases: tuple[str, ...]
    required: bool = False
    # How strongly this column suggests the report kind.
    weight: int = 1
    imported: bool = True


@dataclass(frozen=True)
class KindDef:
    kind: ImportFileKind
    label: str
    description: str
    extensions: tuple[str, ...]
    fields: tuple[FieldDef, ...] = field(default_factory=tuple)

    def field(self, name: str) -> FieldDef:
        return next(f for f in self.fields if f.name == name)


def normalize_header(header: str) -> str:
    """'Prev. Total balance' -> 'prev total balance'; 'Date_of_Birth' -> 'date of birth';
    'D.O.S.' -> 'dos'."""
    lowered = re.sub(r"[.'\u2019\ufeff]", "", header.strip().lower())
    return " ".join(re.sub(r"[^a-z0-9]+", " ", lowered).split())


def _f(
    name: str,
    label: str,
    *aliases: str,
    required: bool = False,
    weight: int = 1,
    imported: bool = True,
) -> FieldDef:
    return FieldDef(
        name,
        label,
        tuple(normalize_header(a) for a in (label, *aliases)),
        required,
        weight,
        imported,
    )


_NAME = _f("name", "Client", "client name", "name", "full name", "client full name", required=True)
_FIRST = _f(
    "first_name", "First name", "first", "given name", "legal first name", "client first name"
)
_LAST = _f(
    "last_name",
    "Last name",
    "last",
    "surname",
    "family name",
    "legal last name",
    "client last name",
)
_EMAIL = _f("email", "Email", "email address", "client email", "primary email", "emails", "email 1")
_PHONE = _f(
    "phone",
    "Phone number",
    "phone",
    "mobile phone",
    "cell phone",
    "home phone",
    "primary phone",
    "phones",
    "phone 1",
    "mobile",
)
_ADDRESS = _f("address", "Address", "street", "street address", "address 1", "address line 1")
_ADDRESS2 = _f("address2", "Address line 2", "address 2", "apt", "suite", "unit")
_CITY = _f("city", "City", "town")
_STATE = _f("state", "State", "state province", "province", "region")
_ZIP = _f("zip", "ZIP", "zip code", "postal code", "zipcode", "postcode")
_DOB = _f("date_of_birth", "Date of birth", "dob", "birth date", "birthdate", "birthday")
_SEX = _f("sex", "Sex", "sex assigned at birth", "legal sex", "biological sex")
_CLINICIAN = _f(
    "clinician",
    "Clinician",
    "clinician name",
    "primary clinician",
    "assigned clinician",
    "provider",
    "rendering provider",
    "therapist",
)
_STATUS = _f("status", "Status", "client status", "active status")
_DATE_OF_SERVICE = _f(
    "date_of_service",
    "Date of service",
    "dos",
    "service date",
    "date",
    "appointment date",
    "session date",
    required=True,
    weight=2,
)
_CLIENT = _f("client", "Client", "client name", "name", "patient", "patient name", required=True)
_CLIENT_FIRST = _f("first_name", "First name", "client first name", "first")
_CLIENT_LAST = _f("last_name", "Last name", "client last name", "last")

KINDS: dict[ImportFileKind, KindDef] = {
    ImportFileKind.EXPORT_ZIP: KindDef(
        ImportFileKind.EXPORT_ZIP,
        "Complete data export (zip)",
        "Settings > Practice > Data export > Start export, choosing Complete for all clients. "
        "It's password protected by default: enter the password here. The download link and "
        "password expire after a week. Brings in documents, notes and treatment plans (as "
        "PDFs), secure message transcripts and contact cards.",
        ZIP_EXTENSIONS,
    ),
    ImportFileKind.CLIENT_DETAILS: KindDef(
        ImportFileKind.CLIENT_DETAILS,
        "Client details report",
        "Analytics (Reports) > Client details. Include Active, Inactive and Prospective "
        "clients and tick Include Contacts, then download as CSV or Excel.",
        SPREADSHEET_EXTENSIONS,
        (
            _NAME,
            _FIRST,
            _LAST,
            _f("client_type", "Client type", "type", weight=3),
            _CLINICIAN,
            _f("date_added", "Date added", "created", weight=3, imported=False),
            _f("last_appointment", "Last appointment", weight=2, imported=False),
            _f("next_appointment", "Next appointment", weight=2, imported=False),
            _STATUS,
            _EMAIL,
            _PHONE,
            _ADDRESS,
            _ADDRESS2,
            _CITY,
            _STATE,
            _ZIP,
            _DOB,
            _f(
                "primary_insurance",
                "Primary insurance",
                "insurance",
                "insurance company",
                "insurance payer",
                "primary insurance payer",
                weight=2,
            ),
            _f(
                "insurance_id",
                "Insurance ID",
                "member id",
                "insurance member id",
                "subscriber id",
                "policy number",
            ),
            _f("contact_name", "Contact name", "contact"),
            _f("contact_phone", "Contact phone number", "contact phone"),
            _f("contact_email", "Contact email", "contact email address"),
        ),
    ),
    ImportFileKind.CLIENT_DEMOGRAPHICS: KindDef(
        ImportFileKind.CLIENT_DEMOGRAPHICS,
        "Client demographics report",
        "Analytics (Reports) > Client demographics (Essential and Plus plans), downloaded as "
        "CSV or Excel. Adds dates of birth, sex and gender identity.",
        SPREADSHEET_EXTENSIONS,
        (
            _f("name", "Name", "client", "client name", "full name", required=True),
            _FIRST,
            _LAST,
            _f("contact", "Contact", "contact info", "email or phone"),
            _f("age", "Age", weight=2),
            _DOB,
            _SEX,
            _f("gender_identity", "Gender identity", "gender", weight=2),
            _f("race", "Race", "race ethnicity", "ethnicity", weight=3),
            _f("relationship_status", "Relationship status", "marital status", weight=3),
            _f("employment_status", "Employment status", "employment", weight=3),
            _f("preferred_language", "Preferred language", "language", weight=2),
            _CITY,
            _ZIP,
        ),
    ),
    ImportFileKind.APPOINTMENT_STATUS: KindDef(
        ImportFileKind.APPOINTMENT_STATUS,
        "Appointment status report",
        "Analytics (Reports) > Appointment status for the whole date range you want, with "
        "Include Insurance and Include Documentation, downloaded as CSV or Excel. Brings in past "
        "sessions with their billing code and fee.",
        SPREADSHEET_EXTENSIONS,
        (
            _DATE_OF_SERVICE,
            _CLIENT,
            _CLIENT_FIRST,
            _CLIENT_LAST,
            _CLINICIAN,
            _f(
                "cpt_code",
                "CPT code",
                "cpt",
                "billing code",
                "service code",
                "code",
                "procedure code",
                weight=3,
            ),
            _f("units", "Units", weight=2),
            _f("status", "Status", "appointment status", "attendance", "attendance status"),
            _f("start_time", "Time", "start time", "appointment time"),
            _f("duration", "Duration", "duration minutes", "length"),
            _f(
                "charge",
                "Charge",
                "fee",
                "rate",
                "total fee",
                "total charge",
                "billed amount",
                "amount",
            ),
            _f("client_charge", "Client charge", "client responsibility", "client fee"),
            _f("claim_status", "Claim status", weight=2, imported=False),
            _f("note_status", "Progress note status", "note status", weight=2, imported=False),
            _f("write_off", "Write off", weight=2, imported=False),
        ),
    ),
    ImportFileKind.ATTENDANCE: KindDef(
        ImportFileKind.ATTENDANCE,
        "Attendance report",
        "Analytics (Reports) > Attendance for the same date range, downloaded as CSV or Excel. "
        "Adds whether each session was attended, a no-show or canceled, and its location.",
        SPREADSHEET_EXTENSIONS,
        (
            _CLIENT,
            _CLIENT_FIRST,
            _CLIENT_LAST,
            _CLINICIAN,
            _DATE_OF_SERVICE,
            _f("location", "Location", "place of service", "office", weight=2),
            _f(
                "status",
                "Status",
                "attendance",
                "attendance status",
                "appointment status",
                required=True,
                weight=2,
            ),
        ),
    ),
    ImportFileKind.OUTSTANDING_BALANCES: KindDef(
        ImportFileKind.OUTSTANDING_BALANCES,
        "Outstanding balances report",
        "Analytics (Reports) > Outstanding balances, downloaded as CSV or Excel. Each client's "
        "balance becomes one opening invoice in Synari (no email is sent).",
        SPREADSHEET_EXTENSIONS,
        (
            _CLIENT,
            _CLIENT_FIRST,
            _CLIENT_LAST,
            _CLINICIAN,
            _f(
                "client_balance",
                "Client balance",
                "balance",
                "total balance",
                "client balance due",
                "amount due",
                "outstanding balance",
                required=True,
                weight=3,
            ),
            _f("services_provided", "Services provided", weight=3, imported=False),
            _f("uninvoiced", "Uninvoiced", weight=3, imported=False),
            _f("invoiced", "Invoiced", weight=2, imported=False),
            _f("client_paid", "Client paid", weight=2, imported=False),
        ),
    ),
    ImportFileKind.CLIENT_LIST: KindDef(
        ImportFileKind.CLIENT_LIST,
        "Client List (from SimplePractice support)",
        "Optional. SimplePractice support can provide a Client List CSV when you move accounts. "
        "It adds insurance details (payer ID, group, copay, subscriber), diagnoses, minors and "
        "billing type.",
        SPREADSHEET_EXTENSIONS,
        (
            _f("name", "Name", "client", "client name", "full name", required=True),
            _FIRST,
            _LAST,
            _f(
                "preferred_name",
                "Name they go by",
                "preferred name",
                "goes by",
                "nickname",
                weight=2,
            ),
            _DOB,
            _SEX,
            _ADDRESS,
            _ADDRESS2,
            _CITY,
            _STATE,
            _ZIP,
            _EMAIL,
            _PHONE,
            _f("billing_type", "Billing type", "payment type", "billing method", weight=3),
            _STATUS,
            _CLINICIAN,
            _f("minor", "Minor", "is minor", "minor client", weight=3),
            _f(
                "diagnoses",
                "Diagnoses",
                "diagnosis",
                "diagnosis codes",
                "dx",
                "icd 10 codes",
                "icd codes",
                weight=3,
            ),
            _f(
                "payer_name",
                "Insurance payer",
                "payer",
                "payer name",
                "insurance company",
                "primary insurance",
                "insurance",
                "insurance name",
            ),
            _f("payer_id", "Payer ID", "insurance payer id", "electronic payer id", weight=3),
            _f("member_id", "Member ID", "insurance id", "subscriber id", "insurance member id"),
            _f("group_id", "Group ID", "group number", "group", "group no", weight=3),
            _f("copay", "Default copay", "copay", "copay amount", weight=2),
            _f(
                "subscriber_relationship",
                "Subscriber relationship",
                "relationship to subscriber",
                "relationship to insured",
                "insured relationship",
                "patient relationship to insured",
                weight=3,
            ),
            _f("subscriber_name", "Subscriber name", "insured name", "policyholder name"),
            _f("subscriber_first_name", "Subscriber first name", "insured first name"),
            _f("subscriber_last_name", "Subscriber last name", "insured last name"),
            _f(
                "subscriber_dob",
                "Subscriber date of birth",
                "subscriber dob",
                "insured dob",
                "insured date of birth",
            ),
            _f("subscriber_sex", "Subscriber sex", "insured sex", "subscriber gender"),
            _f("subscriber_address", "Subscriber address", "insured address"),
            _f("subscriber_city", "Subscriber city", "insured city"),
            _f("subscriber_state", "Subscriber state", "insured state"),
            _f("subscriber_zip", "Subscriber ZIP", "subscriber zip code", "insured zip"),
            _f("contact_name", "First contact name", "contact name"),
            _f("contact_email", "First contact email", "contact email"),
            _f("contact_phone", "First contact phone", "contact phone", "contact phone number"),
            _f(
                "contact_relationship",
                "First contact relationship",
                "contact relationship",
                "contact relation",
            ),
        ),
    ),
}

# Report fields never shown in previews (clinical details).
CLINICAL_FIELDS = frozenset({"diagnoses"})


def kind_for_extension(filename: str) -> ImportFileKind | None:
    """EXPORT_ZIP for zips; None for spreadsheets (their kind comes from their headings)."""
    return ImportFileKind.EXPORT_ZIP if filename.lower().endswith(ZIP_EXTENSIONS) else None


def auto_mapping(kind: ImportFileKind, headers: list[str]) -> dict[str, str | None]:
    """Field -> the first heading matching one of its aliases (earlier aliases win)."""
    normalized = [(normalize_header(h), h) for h in headers]
    used: set[str] = set()
    mapping: dict[str, str | None] = {}
    for field_def in KINDS[kind].fields:
        if not field_def.imported:
            continue
        match = None
        for alias in field_def.aliases:
            match = next((h for n, h in normalized if n == alias and h not in used), None)
            if match is not None:
                break
        if match is not None:
            used.add(match)
        mapping[field_def.name] = match
    return mapping


def detection_score(kind: ImportFileKind, headers: list[str]) -> int:
    """How well the headings fit a report kind; 0 when its required columns are missing."""
    present = {normalize_header(h) for h in headers}
    definition = KINDS[kind]
    matched = {f.name for f in definition.fields if present.intersection(f.aliases)}
    for required in (f for f in definition.fields if f.required):
        if required.name in matched:
            continue
        # A single name column may be split into first and last names.
        if required.name in ("name", "client") and {"first_name", "last_name"} <= matched:
            continue
        return 0
    return sum(f.weight for f in definition.fields if f.name in matched)


def detect_kind(headers: list[str]) -> ImportFileKind | None:
    """The report kind whose columns best match the headings, if any fits well enough."""
    scores = {
        kind: detection_score(kind, headers) for kind in KINDS if kind != ImportFileKind.EXPORT_ZIP
    }
    best = max(scores, key=lambda kind: scores[kind])
    return best if scores[best] >= MIN_DETECTION_SCORE else None


def missing_required(kind: ImportFileKind, mapping: dict[str, str | None]) -> list[str]:
    """Labels of required fields without a column (a name may come from first + last)."""
    missing: list[str] = []
    for field_def in KINDS[kind].fields:
        if not field_def.required or mapping.get(field_def.name):
            continue
        if field_def.name in ("name", "client") and (
            mapping.get("first_name") and mapping.get("last_name")
        ):
            continue
        missing.append(field_def.label)
    return missing
