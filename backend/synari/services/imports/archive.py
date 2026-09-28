"""Reading SimplePractice's Complete data export (a zip, usually password protected).

The export has one folder per kind of record (Administrative, Billing Documents, Contacts,
Medical Records, Psychotherapy Notes, Secure messages, Stored Documents), each with one
subfolder per client named after the client. Contacts holds vCards (sometimes CSV); every
other folder holds documents, mostly PDFs, and Secure messages holds .txt transcripts.

Both standard zip encryption and AES (WinZip) encryption are supported.
"""

import re
import zipfile
import zlib
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path, PurePosixPath

import pyzipper

from synari.models.enums import ImportFileKind
from synari.models.files import PSYCHOTHERAPY_NOTES_CATEGORY
from synari.services.imports import ImportFailed
from synari.services.imports.fields import auto_mapping
from synari.services.imports.tables import csv_table, decode_text
from synari.services.imports.values import PersonName, name_key, parse_date, split_name
from synari.services.imports.vcard import ContactCard, parse_vcards

PSYCHOTHERAPY_NOTES = PSYCHOTHERAPY_NOTES_CATEGORY
SECURE_MESSAGES = "Secure messages"
CONTACTS = "Contacts"
# Normalized folder name -> category shown on imported documents.
KNOWN_FOLDERS = {
    "administrative": "Administrative",
    "billing documents": "Billing Documents",
    "contacts": CONTACTS,
    "medical records": "Medical Records",
    "psychotherapy notes": PSYCHOTHERAPY_NOTES,
    "secure messages": SECURE_MESSAGES,
    "stored documents": "Stored Documents",
}
_IGNORED = re.compile(r"(^|/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(/|$)|(^|/)\._")
_FOLDER_DATE = re.compile(r"\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}")
_FOLDER_ID = re.compile(r"[(\[][^)\]]*\d[^)\]]*[)\]]|\b\d+\b")
MAX_CONTACT_FILE_BYTES = 5 * 1024 * 1024


@dataclass
class ZipEntry:
    path: str
    category: str
    # The client's folder name ("" when the file sits directly in the category folder).
    folder: str
    filename: str
    size: int


@dataclass
class ContactGroup:
    """The cards found for one client folder (or one file at the top of Contacts)."""

    folder: str
    client: ContactCard
    contacts: list[ContactCard] = field(default_factory=list)


def _norm(part: str) -> str:
    return " ".join(part.lower().replace("_", " ").split())


def folder_person(folder: str) -> tuple[PersonName, date | None]:
    """The client named by a folder like 'Jane Doe', 'Doe, Jane', 'Jane_Doe (12345)' or
    'Jane Doe - 1990-01-02' (a date in the name is taken as the date of birth)."""
    text = folder.replace("_", " ")
    found = _FOLDER_DATE.search(text)
    birth = parse_date(found.group(0)) if found else None
    if found:
        text = text.replace(found.group(0), " ")
    text = _FOLDER_ID.sub(" ", text)
    text = " ".join(text.replace(" - ", " ").split()).strip(" -")
    return split_name(text), birth


class ExportArchive:
    """An open Complete export. Use as a context manager."""

    def __init__(self, path: Path, password: str) -> None:
        try:
            self._zip = pyzipper.AESZipFile(path)
        except (zipfile.BadZipFile, pyzipper.BadZipFile, OSError) as exc:
            raise ImportFailed(
                "The export zip couldn't be read. It may be incomplete or damaged; download it "
                "from SimplePractice again."
            ) from exc
        self._password = password.encode()
        self.entries: list[ZipEntry] = []
        self.contact_entries: list[ZipEntry] = []
        self.skipped_outside = 0
        infos = [i for i in self._zip.infolist() if not i.is_dir()]
        self.encrypted = any(i.flag_bits & 0x1 for i in infos)
        for info in infos:
            entry = self._entry(info)
            if entry is None:
                continue
            if entry.category == CONTACTS:
                self.contact_entries.append(entry)
            else:
                self.entries.append(entry)
        self._check_password(infos)

    def __enter__(self) -> "ExportArchive":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._zip.close()

    def _entry(self, info: zipfile.ZipInfo) -> ZipEntry | None:
        path = info.filename.replace("\\", "/")
        if _IGNORED.search(path):
            return None
        parts = [p for p in path.split("/") if p]
        index = next((i for i, p in enumerate(parts[:-1]) if _norm(p) in KNOWN_FOLDERS), None)
        if index is None:
            self.skipped_outside += 1
            return None
        folder = parts[index + 1] if len(parts) > index + 2 else ""
        return ZipEntry(
            path=info.filename,
            category=KNOWN_FOLDERS[_norm(parts[index])],
            folder=folder,
            filename=parts[-1],
            size=info.file_size,
        )

    def _check_password(self, infos: list[zipfile.ZipInfo]) -> None:
        encrypted = sorted((i for i in infos if i.flag_bits & 0x1), key=lambda i: i.file_size)
        if not encrypted:
            return
        if not self._password:
            raise ImportFailed("The export zip is password protected: enter its password")
        try:
            with self._zip.open(encrypted[0], pwd=self._password) as member:
                member.read()
        except (RuntimeError, zipfile.BadZipFile, pyzipper.BadZipFile, zlib.error) as exc:
            raise ImportFailed(
                "The export zip's password is incorrect. Check the password SimplePractice "
                "showed with the download link (it expires after a week)."
            ) from exc

    def read(self, entry: ZipEntry, limit: int) -> bytes | None:
        """A member's bytes; None if it's bigger than `limit` or can't be read (damaged)."""
        if entry.size > limit:
            return None
        try:
            with self._zip.open(entry.path, pwd=self._password or None) as member:
                data = member.read(limit + 1)
        except (
            zipfile.BadZipFile,
            pyzipper.BadZipFile,
            RuntimeError,
            OSError,
            EOFError,
            zlib.error,
        ):
            return None
        return data if len(data) <= limit else None

    def contact_groups(self) -> tuple[list[ContactGroup], int]:
        """Cards per client from the Contacts folder, and how many files couldn't be read."""
        by_group: dict[str, list[ContactCard]] = {}
        unreadable = 0
        for entry in self.contact_entries:
            suffix = PurePosixPath(entry.filename).suffix.lower()
            if suffix not in (".vcf", ".csv"):
                continue
            data = self.read(entry, MAX_CONTACT_FILE_BYTES)
            if data is None:
                unreadable += 1
                continue
            text = decode_text(data)
            cards = parse_vcards(text) if suffix == ".vcf" else _csv_cards(text, entry.filename)
            group = entry.folder or PurePosixPath(entry.filename).stem
            by_group.setdefault(group, []).extend(cards)
        groups: list[ContactGroup] = []
        for folder, cards in by_group.items():
            if not cards:
                continue
            person, _ = folder_person(folder)
            client = next((c for c in cards if name_key(c.name) == person.key), cards[0])
            groups.append(ContactGroup(folder, client, [c for c in cards if c is not client]))
        return groups, unreadable


def _csv_cards(text: str, filename: str) -> list[ContactCard]:
    """Contact rows from a CSV in the Contacts folder, read with the Client List columns."""
    try:
        table = csv_table(text, filename)
    except ImportFailed:
        return []
    mapping = auto_mapping(ImportFileKind.CLIENT_LIST, table.headers)
    cards: list[ContactCard] = []
    for row in table.records(mapping):
        name = row.get("name") or f"{row.get('first_name', '')} {row.get('last_name', '')}"
        if not name.strip():
            continue
        cards.append(
            ContactCard(
                full_name=name.strip(),
                emails=[row["email"]] if row.get("email") else [],
                phones=[row["phone"]] if row.get("phone") else [],
                street=row.get("address", ""),
                city=row.get("city", ""),
                state=row.get("state", ""),
                postal_code=row.get("zip", ""),
                birthday=parse_date(row.get("date_of_birth", "")),
                relationship=row.get("contact_relationship", ""),
            )
        )
    return cards
