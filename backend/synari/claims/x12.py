"""Shared ASC X12 5010 pieces: separators, element cleaning, amounts, dates and envelopes.

Files we write use `*` between elements, `:` between components, `^` for repetitions and `~`
to end a segment (followed by a newline, which receivers ignore, so files stay readable). Text
never contains any of those characters or `>`, which some clearinghouses use as a separator.
"""

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

ELEMENT_SEPARATOR = "*"
COMPONENT_SEPARATOR = ":"
REPETITION_SEPARATOR = "^"
SEGMENT_TERMINATOR = "~"

_DELIMITERS = re.compile(r"[*:^~>]")


@dataclass(frozen=True)
class Envelope:
    """Interchange (ISA/IEA) and functional group (GS/GE) settings chosen by the caller.

    Sender and receiver ids and qualifiers come from the clearinghouse enrollment ("ZZ" is a
    mutually defined id). Control numbers must be unique per sender; keep a counter. `usage`
    is T for test files and P for production. `created_at` is written as-is (use UTC).
    """

    sender_id: str
    receiver_id: str
    interchange_control_number: int
    group_control_number: int
    created_at: datetime
    usage: Literal["T", "P"] = "T"
    sender_qualifier: str = "ZZ"
    receiver_qualifier: str = "ZZ"
    application_sender_code: str = ""
    application_receiver_code: str = ""
    acknowledgment_requested: bool = False


def clean(value: str) -> str:
    """Text folded to ASCII, without delimiters or repeated whitespace; case is kept."""
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return " ".join(_DELIMITERS.sub(" ", folded).split())


def text(value: str, max_length: int) -> str:
    """Free text (names, addresses) as cleaned uppercase, cut to `max_length`."""
    return clean(value).upper()[:max_length].rstrip()


def identifier(value: str, max_length: int) -> str:
    """An id or code: delimiters, spaces and non-ASCII removed, case kept."""
    folded = value.encode("ascii", "ignore").decode("ascii")
    return "".join(_DELIMITERS.sub("", folded).split())[:max_length]


def digits(value: str) -> str:
    """Only the digits of `value` (phone numbers, tax ids)."""
    return "".join(char for char in value if char.isdigit())


def amount(cents: int) -> str:
    """Cents as an X12 decimal: 15000 -> "150", 15050 -> "150.5", 15005 -> "150.05"."""
    sign = "-" if cents < 0 else ""
    dollars, remainder = divmod(abs(cents), 100)
    if remainder == 0:
        return f"{sign}{dollars}"
    return f"{sign}{dollars}.{remainder:02d}".rstrip("0")


def x12_date(day: date) -> str:
    """CCYYMMDD."""
    return f"{day:%Y%m%d}"


def cents(value: str) -> int:
    """A decimal amount from a file or API ("150", "150.5", "-12.34") as cents; blank is 0."""
    if not value.strip():
        return 0
    try:
        return int((Decimal(value.strip()) * 100).to_integral_value(rounding=ROUND_HALF_UP))
    except InvalidOperation as exc:
        raise ValueError(f"Not an amount: {value!r}") from exc


def units(value: str, default: int = 1) -> int:
    """A unit count or quantity ("1", "2.0") as a whole number; `default` when blank."""
    if not value.strip():
        return default
    try:
        return int(Decimal(value.strip()))
    except InvalidOperation as exc:
        raise ValueError(f"Not a number: {value!r}") from exc


def parse_date(value: str) -> date | None:
    """A CCYYMMDD or YYYY-MM-DD date; None when blank."""
    value = value.strip()
    return date.fromisoformat(value) if value else None


def composite(*components: str) -> str:
    """Components joined with the component separator, without trailing empty ones."""
    return COMPONENT_SEPARATOR.join(components).rstrip(COMPONENT_SEPARATOR)


def segment(tag: str, *elements: str) -> str:
    """One segment (without its terminator), dropping trailing empty elements."""
    return ELEMENT_SEPARATOR.join((tag, *elements)).rstrip(ELEMENT_SEPARATOR)


def transaction_set(
    code: str, control_number: str, implementation: str, body: Sequence[str]
) -> list[str]:
    """ST ... SE around `body`; SE01 counts every segment including ST and SE."""
    return [
        segment("ST", code, control_number, implementation),
        *body,
        segment("SE", str(len(body) + 2), control_number),
    ]


def interchange(
    envelope: Envelope,
    functional_id: str,
    implementation: str,
    transaction_sets: Sequence[Sequence[str]],
) -> str:
    """A complete interchange with one functional group holding `transaction_sets`."""
    created = envelope.created_at
    control = f"{envelope.interchange_control_number:09d}"
    group_control = str(envelope.group_control_number)
    isa = segment(
        "ISA",
        "00",
        " " * 10,
        "00",
        " " * 10,
        envelope.sender_qualifier,
        identifier(envelope.sender_id, 15).ljust(15),
        envelope.receiver_qualifier,
        identifier(envelope.receiver_id, 15).ljust(15),
        f"{created:%y%m%d}",
        f"{created:%H%M}",
        REPETITION_SEPARATOR,
        "00501",
        control,
        "1" if envelope.acknowledgment_requested else "0",
        envelope.usage,
        COMPONENT_SEPARATOR,
    )
    gs = segment(
        "GS",
        functional_id,
        identifier(envelope.application_sender_code or envelope.sender_id, 15),
        identifier(envelope.application_receiver_code or envelope.receiver_id, 15),
        f"{created:%Y%m%d}",
        f"{created:%H%M}",
        group_control,
        "X",
        implementation,
    )
    segments = [
        isa,
        gs,
        *(line for transaction in transaction_sets for line in transaction),
        segment("GE", str(len(transaction_sets)), group_control),
        segment("IEA", "1", control),
    ]
    return "".join(f"{line}{SEGMENT_TERMINATOR}\n" for line in segments)
