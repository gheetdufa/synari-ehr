"""Synthetic SimplePractice exports for the importer's tests (no real people or records).

The reports use the column labels from SimplePractice's documentation and the Complete export
mirrors its documented layout: one folder per kind of record, each with a folder per client.
`write_samples(folder)` writes the same files to disk for trying the wizard by hand (see
tests/fixtures/simplepractice).

The practice: Jordan Lee, LCSW (the owner in tests) and Maya Chen, LMFT (not in Synari yet).
Clients: Jane Doe, Katherine "Kate" Smith (Kate Smith in session reports, Katie Smith in the
balances report, which needs confirming), Liam Johnson
(a minor; his mother Olivia is his insurance subscriber), Robert Brown Jr. (inactive, owes
$120), Maria Garcia (prospective) and two different clients both named Alex Morgan.
"""

import csv
import io
import os
import struct
import zipfile
import zlib
from pathlib import Path

import pyzipper
from openpyxl import Workbook

ZIP_PASSWORD = "Synthetic-Export-2026"
ROOT = "SimplePractice Export 2026-09-01"

CLIENT_DETAILS_HEADERS = [
    "Client",
    "Client type",
    "Clinician",
    "Date added",
    "Last appointment",
    "Next appointment",
    "Address",
    "City",
    "State",
    "ZIP",
    "Phone number",
    "Email",
    "Primary insurance",
    "Insurance ID",
    "Status",
    "Contact name",
    "Contact phone number",
    "Contact email",
]
CLIENT_DETAILS_ROWS = [
    [
        "Jane Doe",
        "Adult",
        "Jordan Lee, LCSW",
        "01/02/2024",
        "01/13/2025",
        "",
        "12 Elm St",
        "Springfield",
        "IL",
        "62701",
        "(555) 201-0001",
        "jane.doe@example.com",
        "Aetna",
        "W123456789",
        "Active",
        "John Doe",
        "(555) 201-0099",
        "john.doe@example.com",
    ],
    [
        "Katherine Smith",
        "Adult",
        "Maya Chen, LMFT",
        "03/15/2024",
        "01/06/2025",
        "",
        "40 Oak Ave",
        "Springfield",
        "IL",
        "62702",
        "555-201-0002",
        "kate.smith@example.com",
        "",
        "",
        "Active",
        "",
        "",
        "",
    ],
    [
        "Liam Johnson",
        "Minor",
        "Jordan Lee, LCSW",
        "05/01/2024",
        "01/06/2025",
        "",
        "7 Pine Rd",
        "Springfield",
        "IL",
        "62703",
        "555-201-0003",
        "",
        "Blue Cross Blue Shield",
        "XJ998877",
        "Active",
        "Olivia Johnson",
        "555-201-0003",
        "olivia.j@example.com",
    ],
    [
        "Robert Brown Jr.",
        "Adult",
        "Jordan Lee, LCSW",
        "06/01/2023",
        "02/03/2025",
        "",
        "",
        "",
        "",
        "",
        "555-201-0004",
        "rbrown@example.com",
        "",
        "",
        "Inactive",
        "",
        "",
        "",
    ],
    [
        "Maria Garcia",
        "Adult",
        "Maya Chen, LMFT",
        "08/20/2025",
        "",
        "",
        "",
        "",
        "",
        "",
        "555-201-0005",
        "maria.g@example.com",
        "",
        "",
        "Prospective",
        "",
        "",
        "",
    ],
    [
        "Alex Morgan",
        "Adult",
        "Jordan Lee, LCSW",
        "02/02/2024",
        "",
        "",
        "",
        "",
        "",
        "",
        "555-201-0006",
        "alex.m1@example.com",
        "",
        "",
        "Active",
        "",
        "",
        "",
    ],
    [
        "Alex Morgan",
        "Adult",
        "Jordan Lee, LCSW",
        "02/03/2024",
        "",
        "",
        "",
        "",
        "",
        "",
        "555-201-0007",
        "alex.m2@example.com",
        "",
        "",
        "Active",
        "",
        "",
        "",
    ],
]

DEMOGRAPHICS_HEADERS = [
    "Name",
    "Contact",
    "Age",
    "Date of Birth",
    "Sex",
    "Gender Identity",
    "Race",
    "Relationship Status",
    "Employment Status",
    "Preferred Language",
    "City",
    "ZIP",
]
DEMOGRAPHICS_ROWS = [
    ["Jane Doe", "jane.doe@example.com", "37", "04/12/1988", "Female", "Woman", "White",
     "Married", "Employed", "English", "Springfield", "62701"],
    ["Katherine Smith", "kate.smith@example.com", "33", "09/30/1992", "F", "", "Asian",
     "Single", "Student", "English", "Springfield", "62702"],
    ["Liam Johnson", "555-201-0003", "13", "06/15/2012", "Male", "", "", "", "", "English",
     "Springfield", "62703"],
    ["Robert Brown Jr.", "rbrown@example.com", "51", "01/20/1975", "M", "", "", "", "", "",
     "", ""],
    ["Alex Morgan", "alex.m1@example.com", "36", "01/01/1990", "", "Nonbinary", "", "", "",
     "", "", ""],
    ["Alex Morgan", "alex.m2@example.com", "31", "05/05/1995", "", "", "", "", "", "", "", ""],
]  # fmt: skip

APPOINTMENT_STATUS_HEADERS = [
    "Date of Service",
    "Client",
    "Clinician",
    "CPT code",
    "Units",
    "Client charge",
    "Claim status",
    "Charge",
    "Paid",
    "Write off",
    "Unpaid",
    "Details",
    "Progress Note Status",
]
APPOINTMENT_STATUS_ROWS = [
    ["01/06/2025", "Jane Doe", "Jordan Lee, LCSW", "90837", "1", "$25.00", "Paid", "$150.00",
     "$125.00", "$0.00", "$0.00", "", "Locked"],
    ["01/13/2025", "Jane Doe", "Jordan Lee, LCSW", "90837", "1", "$25.00", "Paid", "$150.00",
     "$125.00", "$0.00", "$0.00", "", "Locked"],
    ["01/06/2025", "Kate Smith", "Maya Chen, LMFT", "90834", "1", "$130.00", "", "$130.00",
     "$0.00", "$0.00", "$0.00", "", "Locked"],
    ["01/06/2025", "Liam Johnson", "Jordan Lee, LCSW", "90832", "1", "$20.00", "Submitted",
     "$100.00", "$0.00", "$0.00", "$100.00", "", "No Note"],
    ["02/03/2025", "Robert Brown", "Jordan Lee, LCSW", "90834", "1", "$120.00", "",
     "$120.00", "$0.00", "$0.00", "$120.00", "", "Unlocked"],
    ["02/10/2025", "Alex Morgan", "Jordan Lee, LCSW", "90791", "1", "$180.00", "", "$180.00",
     "$180.00", "$0.00", "$0.00", "", "Locked"],
    ["01/06/2099", "Jane Doe", "Jordan Lee, LCSW", "90837", "1", "$25.00", "", "$150.00",
     "$0.00", "$0.00", "$0.00", "", "No Note"],
    ["not a date", "Jane Doe", "Jordan Lee, LCSW", "90837", "1", "", "", "$150.00", "", "",
     "", "", ""],
]  # fmt: skip

ATTENDANCE_HEADERS = ["Client name", "Clinician Name", "Date of service", "Location", "Status"]
ATTENDANCE_ROWS = [
    ["Jane Doe", "Jordan Lee, LCSW", "01/06/2025", "Main Office", "Show"],
    ["Jane Doe", "Jordan Lee, LCSW", "01/13/2025", "Main Office", "No Show"],
    ["Liam Johnson", "Jordan Lee, LCSW", "01/06/2025", "Video Office", "Late Cancel"],
    ["Jane Doe", "Jordan Lee, LCSW", "01/20/2025", "Main Office", "Canceled"],
]

BALANCES_HEADERS = [
    "Client",
    "Clinician",
    "Services provided",
    "Uninvoiced",
    "Invoiced",
    "Client paid",
    "Client balance",
]
BALANCES_ROWS = [
    ["Robert Brown Jr.", "Jordan Lee, LCSW", "$120.00", "$0.00", "$120.00", "$0.00", "$120.00"],
    ["Jane Doe", "Jordan Lee, LCSW", "$300.00", "$0.00", "$50.00", "$50.00", "$0.00"],
    ["Katie Smith", "Maya Chen, LMFT", "$130.00", "$0.00", "$130.00", "$84.50", "$45.50"],
    ["Total", "", "$550.00", "$0.00", "$300.00", "$134.50", "$165.50"],
]

CLIENT_LIST_HEADERS = [
    "First Name",
    "Last Name",
    "Name They Go By",
    "Date of Birth",
    "Sex",
    "Address 1",
    "City",
    "State",
    "Zip",
    "Email 1",
    "Phone 1",
    "Billing Type",
    "Active Status",
    "Primary Clinician",
    "Minor",
    "Diagnoses",
    "Insurance Payer",
    "Payer ID",
    "Member ID",
    "Group ID",
    "Default Copay",
    "Subscriber Relationship",
    "Subscriber Name",
    "Subscriber DOB",
    "Subscriber Sex",
    "First Contact Name",
    "First Contact Email",
    "First Contact Phone",
    "First Contact Relationship",
]
CLIENT_LIST_ROWS = [
    ["Jane", "Doe", "", "04/12/1988", "Female", "12 Elm St", "Springfield", "IL", "62701",
     "jane.doe@example.com", "555-201-0001", "Insurance", "Active", "Jordan Lee",
     "No", "F41.1 - Generalized anxiety disorder", "Aetna", "60054", "W123456789", "GRP100",
     "$25.00", "Self", "", "", "", "", "", "", ""],
    ["Liam", "Johnson", "", "06/15/2012", "Male", "7 Pine Rd", "Springfield", "IL", "62703",
     "", "555-201-0003", "Insurance", "Active", "Jordan Lee", "Yes",
     "F90.0 Attention-deficit hyperactivity disorder, predominantly inattentive type",
     "Blue Cross Blue Shield", "BCBSIL", "XJ998877", "G-2231", "$20.00", "Child",
     "Olivia Johnson", "03/02/1984", "F", "Olivia Johnson", "olivia.j@example.com",
     "555-201-0003", "Mother"],
]  # fmt: skip


def csv_bytes(headers: list[str], rows: list[list[str]], preamble: tuple[str, ...] = ()) -> bytes:
    """A report as SimplePractice-style CSV (UTF-8 with BOM), optionally after title lines."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for line in preamble:
        writer.writerow([line])
    writer.writerow(headers)
    writer.writerows(rows)
    return ("﻿" + buffer.getvalue()).encode()


def xlsx_bytes(headers: list[str], rows: list[list[str]], title: str = "") -> bytes:
    """A report as an Excel workbook, with an optional title row above the headings."""
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    if title:
        sheet.append([title])
        sheet.append([])
    sheet.append(headers)
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def minimal_pdf(title: str) -> bytes:
    """A tiny valid one-page PDF showing `title` (synthetic content only)."""
    stream = f"BT /F1 12 Tf 72 720 Td ({title}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return out.getvalue()


def _vcard(lines: list[str]) -> str:
    return "\r\n".join(["BEGIN:VCARD", "VERSION:3.0", *lines, "END:VCARD"]) + "\r\n"


# A small JPEG header is enough: Synari stores files as they are.
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


def export_files() -> dict[str, bytes]:
    """The Complete export's files by path."""
    jane_card = _vcard(
        [
            "N:Doe;Jane;;;",
            "FN:Jane Doe",
            "EMAIL;TYPE=INTERNET:jane.doe@example.com",
            "TEL;TYPE=CELL:(555) 201-0001",
            "ADR;TYPE=HOME:;;12 Elm St;Springfield;IL;62701;USA",
            "BDAY:1988-04-12",
        ]
    )
    liam_cards = _vcard(
        [
            "N:Johnson;Liam;;;",
            "FN:Liam Johnson",
            "TEL:555-201-0003",
            "BDAY:20120615",
        ]
    ) + _vcard(
        [
            "N:Johnson;Olivia;;;",
            "FN:Olivia Johnson",
            "EMAIL:olivia.j@example.com",
            "TEL:555-201-0003",
            "ROLE:Mother",
        ]
    )
    kate_card = _vcard(
        [
            "N:Smith;Katherine;;;",
            "FN:Katherine Smith",
            "NICKNAME:Kate",
            "EMAIL:kate.smith@example.com",
            "BDAY:1992-09-30",
        ]
    )
    return {
        f"{ROOT}/Administrative/Jane Doe/Appointment memo 2025-01-06.pdf": minimal_pdf(
            "Synthetic memo"
        ),
        f"{ROOT}/Billing Documents/Jane Doe/Invoice INV-0001.pdf": minimal_pdf("Synthetic invoice"),
        f"{ROOT}/Billing Documents/Robert Brown Jr/Statement 2025-02.pdf": minimal_pdf(
            "Synthetic statement"
        ),
        f"{ROOT}/Contacts/Jane Doe/Jane Doe.vcf": jane_card.encode(),
        f"{ROOT}/Contacts/Liam Johnson/Liam Johnson.vcf": liam_cards.encode(),
        f"{ROOT}/Contacts/Katherine Smith/Katherine Smith.vcf": kate_card.encode(),
        f"{ROOT}/Medical Records/Jane Doe/Progress Note 2025-01-06.pdf": minimal_pdf(
            "Synthetic progress note"
        ),
        f"{ROOT}/Medical Records/Jane Doe/Treatment Plan.pdf": minimal_pdf("Synthetic plan"),
        f"{ROOT}/Medical Records/Liam Johnson/Intake Questionnaire.pdf": minimal_pdf(
            "Synthetic intake"
        ),
        f"{ROOT}/Psychotherapy Notes/Jane Doe/Psychotherapy Note 2025-01-06.pdf": minimal_pdf(
            "Synthetic psychotherapy note"
        ),
        f"{ROOT}/Secure messages/Jane Doe/Secure messages.txt": (
            b"01/05/2025 10:02 AM Jane Doe: Synthetic message.\n"
            b"01/05/2025 11:15 AM Jordan Lee: Synthetic reply.\n"
        ),
        f"{ROOT}/Stored Documents/Katherine Smith/Insurance card.jpg": JPEG,
        f"{ROOT}/Stored Documents/Katherine Smith/Scan.xyz": b"unsupported",
        f"{ROOT}/Stored Documents/Pat Quinn/Release of information.pdf": minimal_pdf(
            "Synthetic release"
        ),
        "__MACOSX/._Jane Doe.vcf": b"resource fork",
    }


def export_zip(password: str = ZIP_PASSWORD, encryption: str = "aes") -> bytes:
    """The Complete export as a zip: AES-encrypted (like SimplePractice's), with standard
    ("zipcrypto") encryption, or unencrypted ("none")."""
    files = export_files()
    if encryption == "zipcrypto":
        return zipcrypto_zip(files, password)
    buffer = io.BytesIO()
    if encryption == "none":
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path, data in files.items():
                archive.writestr(path, data)
        return buffer.getvalue()
    with pyzipper.AESZipFile(
        buffer, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES
    ) as archive:
        archive.setpassword(password.encode())
        for path, data in files.items():
            archive.writestr(path, data)
    return buffer.getvalue()


def _crc_table() -> list[int]:
    table = []
    for byte in range(256):
        value = byte
        for _ in range(8):
            value = (value >> 1) ^ 0xEDB88320 if value & 1 else value >> 1
        table.append(value)
    return table


_CRC = _crc_table()


class _ZipCrypto:
    """Traditional PKWARE zip encryption (what `zip -e` and Windows produce)."""

    def __init__(self, password: bytes) -> None:
        self.keys = [0x12345678, 0x23456789, 0x34567890]
        for byte in password:
            self._update(byte)

    def _crc(self, crc: int, byte: int) -> int:
        return (crc >> 8) ^ _CRC[(crc ^ byte) & 0xFF]

    def _update(self, byte: int) -> None:
        self.keys[0] = self._crc(self.keys[0], byte)
        self.keys[1] = (self.keys[1] + (self.keys[0] & 0xFF)) & 0xFFFFFFFF
        self.keys[1] = (self.keys[1] * 134775813 + 1) & 0xFFFFFFFF
        self.keys[2] = self._crc(self.keys[2], self.keys[1] >> 24)

    def encrypt(self, data: bytes) -> bytes:
        out = bytearray()
        for byte in data:
            temp = (self.keys[2] | 2) & 0xFFFF
            out.append(byte ^ (((temp * (temp ^ 1)) >> 8) & 0xFF))
            self._update(byte)
        return bytes(out)


def zipcrypto_zip(files: dict[str, bytes], password: str) -> bytes:
    """A zip whose members use standard (ZipCrypto) encryption."""
    out = io.BytesIO()
    central = io.BytesIO()
    for path, data in files.items():
        name = path.encode()
        crc = zlib.crc32(data)
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        compressed = compressor.compress(data) + compressor.flush()
        header = os.urandom(11) + bytes([crc >> 24 & 0xFF])
        encrypted = _ZipCrypto(password.encode()).encrypt(header + compressed)
        offset = out.tell()
        out.write(
            struct.pack(
                "<IHHHHHIIIHH",
                0x04034B50,
                20,
                1,
                8,
                0,
                0x5A21,
                crc,
                len(encrypted),
                len(data),
                len(name),
                0,
            )
        )
        out.write(name + encrypted)
        central.write(
            struct.pack(
                "<IHHHHHHIIIHHHHHII",
                0x02014B50,
                20,
                20,
                1,
                8,
                0,
                0x5A21,
                crc,
                len(encrypted),
                len(data),
                len(name),
                0,
                0,
                0,
                0,
                0,
                offset,
            )
        )
        central.write(name)
    directory = central.getvalue()
    start = out.tell()
    out.write(directory)
    out.write(
        struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(files), len(files), len(directory), start, 0)
    )
    return out.getvalue()


def report_files() -> dict[str, bytes]:
    """Every report, named as SimplePractice downloads them (a mix of CSV and Excel)."""
    return {
        "Client details.csv": csv_bytes(CLIENT_DETAILS_HEADERS, CLIENT_DETAILS_ROWS),
        "Client demographics.xlsx": xlsx_bytes(
            DEMOGRAPHICS_HEADERS, DEMOGRAPHICS_ROWS, title="Client demographics"
        ),
        "Appointment status.csv": csv_bytes(
            APPOINTMENT_STATUS_HEADERS,
            APPOINTMENT_STATUS_ROWS,
            preamble=("Appointment status", "01/01/2025 - 12/31/2099"),
        ),
        "Attendance.xlsx": xlsx_bytes(ATTENDANCE_HEADERS, ATTENDANCE_ROWS),
        "Outstanding balances.csv": csv_bytes(BALANCES_HEADERS, BALANCES_ROWS),
        "Client List.csv": csv_bytes(CLIENT_LIST_HEADERS, CLIENT_LIST_ROWS),
    }


def write_samples(folder: Path) -> None:
    """Write the sample export and reports (for trying the import wizard by hand)."""
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in report_files().items():
        (folder / name).write_bytes(data)
    (folder / "SimplePractice Complete Export.zip").write_bytes(export_zip())
