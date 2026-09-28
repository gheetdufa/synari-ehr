"""Parsing the values in SimplePractice reports: names, dates, money, phones and statuses.

Reports are US-formatted (month before day). Every parser returns an empty value rather than
raising, and callers count what couldn't be read as warnings.
"""

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation

from synari.models.enums import AppointmentStatus, BillingType, ClientStatus

# Words dropped when comparing names: honorifics, generational suffixes.
_NAME_NOISE = frozenset({"mr", "mrs", "ms", "miss", "mx", "dr", "jr", "sr", "ii", "iii", "iv"})
_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv"})
# Lower-case words that start a surname ("de la Cruz", "van Dyke").
_PARTICLES = frozenset({"de", "del", "della", "der", "di", "da", "du", "la", "le", "van", "von"})
# A nickname in quotes or parentheses: Jane "JJ" Doe, Jane (Janie) Doe.
_NICKNAME = re.compile(
    r"[\"\u201c\u201d\u2018]([^\"\u201c\u201d\u2018\u2019]+)[\"\u201c\u201d\u2019]"
    r"|\(([^)]+)\)"
)
# Professional credentials after a clinician's name ("Jordan Lee, LCSW", "Dr. Ana Ruiz PhD").
_CREDENTIAL = re.compile(
    r"^(?:[A-Z]{2,6}(?:-[A-Z]{1,3})?|PhD|PsyD|EdD|MSEd|MEd|MSc|MA|MS|MSW|MFT|RN|APRN|PMHNP-BC)$"
)
_JOINED = re.compile(r"\s(?:&|\+|and)\s", re.IGNORECASE)
_ICD10 = re.compile(r"\b([A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?)\b")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%m-%d-%y",
    "%Y/%m/%d",
    "%b %d, %Y",
    "%B %d, %Y",
    "%b %d %Y",
    "%B %d %Y",
    "%d-%b-%Y",
    "%d %b %Y",
    "%d %B %Y",
    "%Y%m%d",
)
_TIME_FORMATS = ("%I:%M %p", "%I:%M%p", "%I %p", "%H:%M", "%H:%M:%S", "%I:%M:%S %p")


@dataclass(frozen=True)
class PersonName:
    first: str
    last: str
    preferred: str = ""

    @property
    def key(self) -> str:
        return name_key(f"{self.first} {self.last}")

    @property
    def display(self) -> str:
        return f"{self.first} {self.last}".strip()


def _ascii(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()


def name_tokens(value: str) -> list[str]:
    """Lower-case name words without accents, punctuation, initials or honorifics."""
    words = re.sub(r"[^a-z0-9\s]", "", _ascii(value).lower().replace("-", "")).split()
    return [w for w in words if len(w) > 1 and w not in _NAME_NOISE]


def name_key(value: str) -> str:
    """A comparison key for a person's name that ignores word order, case, accents, middle
    initials and honorifics: 'Doe, Jane M.' and 'Jane Doe' share 'doe jane'."""
    return " ".join(sorted(name_tokens(value)))


def _clean(value: str) -> str:
    return " ".join(value.replace("\u00a0", " ").split())


def split_name(value: str) -> PersonName:
    """Split a full name as SimplePractice writes it: 'Jane Doe', 'Doe, Jane', 'Jane M. Doe',
    'Jane "JJ" Doe', 'Juan Carlos de la Cruz', 'Robert Smith Jr.'."""
    text = _clean(value)
    preferred = ""
    nickname = _NICKNAME.search(text)
    if nickname:
        preferred = _clean(nickname.group(1) or nickname.group(2))
        text = _clean(_NICKNAME.sub(" ", text))
    if "," in text:
        last, _, rest = text.partition(",")
        rest_words = rest.split()
        if rest_words and rest_words[0].lower().strip(".") not in _SUFFIXES:
            return PersonName(_drop_initials(rest.strip()), last.strip(), preferred)
        text = f"{last} {rest}".strip()
    words = text.split()
    if len(words) <= 1:
        return PersonName(text, "", preferred)
    if _JOINED.search(text):
        # A couple or family record ("Jane Doe & John Doe"): keep it whole.
        return PersonName(" ".join(words[:-1]), words[-1], preferred)
    suffix = ""
    if words[-1].lower().strip(".") in _SUFFIXES and len(words) > 2:
        suffix = f" {words.pop()}"
    start = len(words) - 1
    for index in range(1, len(words) - 1):
        if words[index].lower() in _PARTICLES:
            start = index
            break
    first = _drop_initials(" ".join(words[:start]))
    return PersonName(first or words[0], " ".join(words[start:]) + suffix, preferred)


def _drop_initials(first: str) -> str:
    words = first.split()
    kept = [w for w in words[1:] if len(w.strip(".")) > 1]
    return " ".join([*words[:1], *kept])


def clinician_key(value: str) -> str:
    """A clinician's name without credentials or titles: 'Dr. Ana Ruiz, PhD' -> 'ana ruiz'."""
    words = value.split(",")[0].split()
    while len(words) > 2 and _CREDENTIAL.match(words[-1].strip(".")):
        words.pop()
    return name_key(" ".join(words))


def parse_date(value: str) -> date | None:
    """A date in any common US report format (time of day ignored), or None."""
    text = _clean(value)
    if not text:
        return None
    candidates = [text]
    head = text.split(" ")[0]
    if head != text:
        candidates.append(head)
    if "T" in text:
        candidates.append(text.split("T")[0])
    for candidate in candidates:
        for fmt in _DATE_FORMATS:
            try:
                parsed = datetime.strptime(candidate, fmt)  # noqa: DTZ007 - a calendar date
            except ValueError:
                continue
            if 1900 <= parsed.year <= 2100:
                return parsed.date()
    return None


def parse_time(value: str) -> time | None:
    """A time of day like '2:30 PM' or '14:30', or None."""
    text = _clean(value).upper().replace(".", "")
    for fmt in _TIME_FORMATS:
        try:
            return datetime.strptime(text, fmt).time()  # noqa: DTZ007 - a wall-clock time
        except ValueError:
            continue
    return None


def parse_minutes(value: str) -> int | None:
    """A duration like '50', '50 min' or '1:00', in minutes, or None."""
    text = _clean(value).lower()
    hours_minutes = re.fullmatch(r"(\d{1,2}):(\d{2})", text)
    if hours_minutes:
        return int(hours_minutes.group(1)) * 60 + int(hours_minutes.group(2))
    number = re.match(r"(\d{1,3})", text)
    minutes = int(number.group(1)) if number else 0
    return minutes if 5 <= minutes <= 600 else None


def parse_cents(value: str) -> int | None:
    """Money as integer cents: '$1,234.50', '(12.00)' and '-$12' (negative), '150'."""
    text = _clean(value)
    if not text:
        return None
    negative = (text.startswith("(") and text.endswith(")")) or "-" in text
    digits = re.sub(r"[^0-9.]", "", text)
    if not digits or digits.count(".") > 1:
        return None
    try:
        cents = int((Decimal(digits) * 100).quantize(Decimal(1)))
    except InvalidOperation:
        return None
    return -cents if negative else cents


def phone_digits(value: str) -> str:
    """The last ten digits of a US phone number, for comparing numbers."""
    return re.sub(r"\D", "", value)[-10:]


def clean_phone(value: str) -> str:
    """A phone number as written, trimmed to fit (first number when several are listed)."""
    first = re.split(r"[;,/]| or ", _clean(value))[0].strip()
    return first[:30]


def clean_email(value: str) -> str:
    """A lower-case email address, or '' when it doesn't look like one (first of several)."""
    first = re.split(r"[;,\s]+", value.strip())[0].strip().lower()
    return first if _EMAIL.match(first) and len(first) <= 320 else ""


def yes(value: str) -> bool | None:
    """Yes/No, True/False, Y/N, 1/0; None when blank or unclear."""
    word = _clean(value).lower()
    if word in ("yes", "y", "true", "1", "x", "minor"):
        return True
    if word in ("no", "n", "false", "0", "adult"):
        return False
    return None


def client_status(value: str) -> ClientStatus | None:
    word = _clean(value).lower()
    if word.startswith("active") or word in ("yes", "true"):
        return ClientStatus.ACTIVE
    if word.startswith("inactive") or word in ("no", "false", "discharged"):
        return ClientStatus.INACTIVE
    if word.startswith(("prospect", "potential", "lead")):
        return ClientStatus.PROSPECTIVE
    if word.startswith("archived"):
        return ClientStatus.ARCHIVED
    return None


def billing_type(value: str) -> BillingType | None:
    word = _clean(value).lower().replace("-", " ")
    if "insurance" in word:
        return BillingType.INSURANCE
    if "self" in word or "private" in word or "cash" in word:
        return BillingType.SELF_PAY
    return None


def attendance(value: str) -> AppointmentStatus | None:
    """SimplePractice attendance ('Show', 'No Show', 'Late Cancel', 'Canceled', ...)."""
    word = re.sub(r"[^a-z ]", " ", _clean(value).lower())
    word = " ".join(word.split())
    if not word:
        return None
    if "no show" in word or word == "noshow":
        return AppointmentStatus.NO_SHOW
    if "late" in word and "cancel" in word:
        return AppointmentStatus.LATE_CANCELED
    if "cancel" in word:
        return AppointmentStatus.CANCELED
    if word in ("show", "shows", "attended", "arrived", "kept", "completed", "complete"):
        return AppointmentStatus.ATTENDED
    return None


def sex(value: str) -> str:
    """Synari's sex choices (Female, Male, Intersex, Unknown), else the value as written."""
    word = _clean(value)
    lowered = word.lower()
    if lowered in ("f", "female", "woman"):
        return "Female"
    if lowered in ("m", "male", "man"):
        return "Male"
    if lowered == "intersex":
        return "Intersex"
    if lowered in ("u", "unknown", "not specified"):
        return "Unknown"
    return word[:20]


def subscriber_sex(value: str) -> str:
    """The M/F/U code insurance policies use."""
    return {"Female": "F", "Male": "M"}.get(sex(value), "U" if value.strip() else "")


# X12 patient-to-subscriber relationship codes.
_RELATIONSHIPS = (
    ("self", "18"),
    ("spouse", "01"),
    ("husband", "01"),
    ("wife", "01"),
    ("child", "19"),
    ("son", "19"),
    ("daughter", "19"),
    ("dependent", "19"),
    ("employee", "20"),
    ("partner", "53"),
    ("other", "G8"),
)


def subscriber_relationship(value: str) -> str:
    """X12 relationship code for 'Self', 'Spouse', 'Child', ...; '18' (self) when blank."""
    word = _clean(value).lower()
    if not word:
        return "18"
    return next((code for label, code in _RELATIONSHIPS if label in word), "21")


def diagnoses(value: str) -> list[dict[str, str]]:
    """ICD-10 codes with any description that follows each: 'F41.1 - Generalized anxiety
    disorder; F32.9 Major depressive disorder' -> two {code, description} entries."""
    found: list[dict[str, str]] = []
    matches = list(_ICD10.finditer(value))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(value)
        description = value[match.end() : end].strip(" \t-:;,|/")
        code = match.group(1).upper()
        if any(existing["code"] == code for existing in found):
            continue
        found.append({"code": code, "description": _clean(description)[:200]})
    return found


def counted(template: str, n: int, **names: str) -> str:
    """A message about `n` things with its words agreeing: {n}, {s} (row/rows), {v}
    (shares/share), {were}, {werent}, {have}, {are}, {they} and {them}; `names` fill the rest
    (e.g. {file}) as plain values."""
    one = n == 1
    return template.format(
        n=n,
        s="" if one else "s",
        v="s" if one else "",
        were="was" if one else "were",
        werent="wasn't" if one else "weren't",
        have="has" if one else "have",
        are="is" if one else "are",
        they="it's" if one else "they're",
        them="it" if one else "them",
        **names,
    )


def is_minor_on(birth: date | None, day: date) -> bool | None:
    """Whether someone born on `birth` is under 18 on `day` (None without a birth date)."""
    if birth is None:
        return None
    age = day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))
    return age < 18
