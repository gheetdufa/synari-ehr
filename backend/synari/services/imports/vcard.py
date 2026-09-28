"""Reading contact cards (vCard 3.0/4.0 .vcf files) from the Complete export's Contacts folder.

Only identifying and contact details are read: names, emails, phones, address, birthday,
gender and how the person relates to the client. Notes on the card are ignored.
"""

import re
from dataclasses import dataclass, field
from datetime import date

from synari.services.imports.values import parse_date


@dataclass
class ContactCard:
    full_name: str = ""
    first_name: str = ""
    last_name: str = ""
    nickname: str = ""
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    street: str = ""
    city: str = ""
    state: str = ""
    postal_code: str = ""
    birthday: date | None = None
    gender: str = ""
    # How this person relates to the client (e.g. "Mother", "Emergency contact").
    relationship: str = ""

    @property
    def name(self) -> str:
        return self.full_name or f"{self.first_name} {self.last_name}".strip()


_RELATIONSHIP_PROPERTIES = ("RELATED", "X-RELATIONSHIP", "X-ABRELATEDNAMES", "ROLE", "CATEGORIES")


def _unescape(value: str) -> str:
    return (
        value.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )


def _split(value: str, separator: str = ";") -> list[str]:
    """Split a structured value on unescaped separators."""
    return [_unescape(part) for part in re.split(rf"(?<!\\){separator}", value)]


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw.strip():
            lines.append(raw)
    return lines


def _property(line: str) -> tuple[str, dict[str, str], str]:
    head, _, value = line.partition(":")
    name, *params = head.split(";")
    # Apple groups properties as item1.EMAIL.
    name = name.rsplit(".", 1)[-1].upper()
    parsed: dict[str, str] = {}
    for param in params:
        key, _, param_value = param.partition("=")
        parsed[key.upper()] = param_value.strip('"')
    return name, parsed, value


def _apply(card: ContactCard, name: str, params: dict[str, str], value: str) -> None:
    if name == "FN":
        card.full_name = _unescape(value)
    elif name == "N":
        parts = [*_split(value), "", ""]
        card.last_name, card.first_name = parts[0], parts[1]
    elif name == "NICKNAME":
        card.nickname = _split(value, ",")[0]
    elif name == "EMAIL" and value.strip():
        card.emails.append(_unescape(value))
    elif name == "TEL" and value.strip():
        card.phones.append(_unescape(value.removeprefix("tel:")))
    elif name == "ADR" and not card.street:
        parts = [*_split(value), "", "", "", "", "", "", ""]
        card.street = " ".join(p for p in (parts[1], parts[2]) if p)
        card.city, card.state, card.postal_code = parts[3], parts[4], parts[5]
    elif name == "BDAY":
        card.birthday = parse_date(value.replace("--", "").strip())
    elif name == "GENDER":
        card.gender = _split(value)[0]
    elif name in _RELATIONSHIP_PROPERTIES and not card.relationship:
        label = params.get("TYPE", "") if name == "RELATED" else ""
        card.relationship = _unescape(label or value)[:50]


def parse_vcards(text: str) -> list[ContactCard]:
    """Every card in a .vcf file (a file may hold several)."""
    cards: list[ContactCard] = []
    current: ContactCard | None = None
    for line in _unfold(text):
        name, params, value = _property(line)
        if name == "BEGIN" and value.strip().upper() == "VCARD":
            current = ContactCard()
        elif name == "END" and value.strip().upper() == "VCARD":
            if current is not None and current.name:
                cards.append(current)
            current = None
        elif current is not None:
            _apply(current, name, params, value)
    return cards
