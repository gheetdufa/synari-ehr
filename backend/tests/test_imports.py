"""Importing a practice from SimplePractice: reading the files, matching clients, the review
choices, the import itself and who may run it. All data is synthetic (tests/import_fixtures)."""

import io
import tempfile
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import (
    Appointment,
    AuditEvent,
    Client,
    ClientClinician,
    ClientContact,
    ImportJob,
    ImportRecord,
    InsurancePolicy,
    Invoice,
    Notification,
    Payer,
    StaffMember,
    StoredFile,
)
from synari.models.enums import (
    AppointmentStatus,
    BookingSource,
    ClientStatus,
    ClinicianAccess,
    FilePurpose,
    ImportFileKind,
    ImportStatus,
    LocationType,
    StaffRole,
    StaffStatus,
)
from synari.services import storage
from synari.services.billing_jobs import create_daily_invoices
from synari.services.imports import ImportFailed, jobs, runner, sources, tables, values
from synari.services.imports.fields import auto_mapping, detect_kind
from synari.services.imports.jobs import analyze_imports, run_imports
from synari.services.imports.tables import read_headers, read_table
from synari.services.imports.vcard import parse_vcards
from synari.services.reminders import send_appointment_reminders
from tests import import_fixtures as fx
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)
from tests.insurance_helpers import add_payer, configure_practice, insured_client, session_at


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path / "files"))
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "work"))
    (tmp_path / "work").mkdir()
    storage.get_storage.cache_clear()


# Reading the files ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("headers", "kind"),
    [
        (fx.CLIENT_DETAILS_HEADERS, ImportFileKind.CLIENT_DETAILS),
        (fx.DEMOGRAPHICS_HEADERS, ImportFileKind.CLIENT_DEMOGRAPHICS),
        (fx.APPOINTMENT_STATUS_HEADERS, ImportFileKind.APPOINTMENT_STATUS),
        (fx.ATTENDANCE_HEADERS, ImportFileKind.ATTENDANCE),
        (fx.BALANCES_HEADERS, ImportFileKind.OUTSTANDING_BALANCES),
        (fx.CLIENT_LIST_HEADERS, ImportFileKind.CLIENT_LIST),
        (["CLIENT NAME", "clinician_name", "Date Of Service", "status"], ImportFileKind.ATTENDANCE),
        (["DOS", "Patient", "Provider", "CPT", "Units"], ImportFileKind.APPOINTMENT_STATUS),
        (["Client", "Balance"], ImportFileKind.OUTSTANDING_BALANCES),
        (["Name", "DOB", "Race", "Marital status"], ImportFileKind.CLIENT_DEMOGRAPHICS),
        (["First Name", "Last Name", "Payer ID", "Group Number"], ImportFileKind.CLIENT_LIST),
        (["Invoice #", "Amount"], None),
        ([], None),
    ],
)
def test_detects_the_kind_of_report(headers: list[str], kind: ImportFileKind | None) -> None:
    assert detect_kind(headers) == kind


def test_header_aliases_ignore_case_punctuation_and_order() -> None:
    mapping = auto_mapping(
        ImportFileKind.APPOINTMENT_STATUS,
        ["client name", "D.O.S.", "Billing Code", "Provider", "Total Charge", "Unused"],
    )
    assert mapping["client"] == "client name"
    assert mapping["date_of_service"] == "D.O.S."
    assert mapping["cpt_code"] == "Billing Code"
    assert mapping["clinician"] == "Provider"
    assert mapping["charge"] == "Total Charge"
    assert mapping["units"] is None
    client_list = auto_mapping(ImportFileKind.CLIENT_LIST, fx.CLIENT_LIST_HEADERS)
    assert client_list["email"] == "Email 1"
    assert client_list["payer_name"] == "Insurance Payer"
    assert client_list["member_id"] == "Member ID"
    assert client_list["contact_relationship"] == "First Contact Relationship"


@pytest.mark.parametrize(
    ("raw", "first", "last", "preferred"),
    [
        ("Jane Doe", "Jane", "Doe", ""),
        ("Doe, Jane M.", "Jane", "Doe", ""),
        ('Jane "JJ" Doe', "Jane", "Doe", "JJ"),
        ("Jane (Janie) Doe", "Jane", "Doe", "Janie"),
        ("Mary Ann Smith", "Mary Ann", "Smith", ""),
        ("Juan Carlos de la Cruz", "Juan Carlos", "de la Cruz", ""),
        ("Robert Smith Jr.", "Robert", "Smith Jr.", ""),
        ("Smith, Robert, Jr.", "Robert, Jr.", "Smith", ""),
        ("D'Angelo O'Brien", "D'Angelo", "O'Brien", ""),
        ("  Cher  ", "Cher", "", ""),
    ],
)
def test_splits_full_names(raw: str, first: str, last: str, preferred: str) -> None:
    assert values.split_name(raw) == values.PersonName(first, last, preferred)


def test_name_keys_ignore_order_case_accents_and_initials() -> None:
    assert values.name_key("Doe, Jane M.") == values.name_key("jane doe")
    assert values.name_key("José Núñez") == values.name_key("Jose Nunez")
    assert values.name_key("Dr. Ana Ruiz") == values.name_key("Ana Ruiz")
    assert values.clinician_key("Jordan Lee, LCSW") == values.clinician_key("Jordan Lee LCSW")
    assert values.clinician_key("Dr. Ana Ruiz PhD") == "ana ruiz"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2025-01-06", date(2025, 1, 6)),
        ("01/06/2025", date(2025, 1, 6)),
        ("1/6/2025", date(2025, 1, 6)),
        ("01/06/25", date(2025, 1, 6)),
        ("Jan 6, 2025", date(2025, 1, 6)),
        ("January 6, 2025", date(2025, 1, 6)),
        ("06-Jan-2025", date(2025, 1, 6)),
        ("01/06/2025 2:30 PM", date(2025, 1, 6)),
        ("2025-01-06T14:30:00", date(2025, 1, 6)),
        ("13/31/2025", None),
        ("soon", None),
        ("", None),
    ],
)
def test_reads_report_dates(raw: str, expected: date | None) -> None:
    assert values.parse_date(raw) == expected


@pytest.mark.parametrize(
    ("raw", "cents"),
    [("$1,234.50", 123450), ("150", 15000), ("(12.00)", -1200), ("-$5", -500), ("", None)],
)
def test_reads_money_as_cents(raw: str, cents: int | None) -> None:
    assert values.parse_cents(raw) == cents


@pytest.mark.parametrize(
    ("raw", "status"),
    [
        ("Show", AppointmentStatus.ATTENDED),
        ("No Show", AppointmentStatus.NO_SHOW),
        ("no-show", AppointmentStatus.NO_SHOW),
        ("Late Cancel", AppointmentStatus.LATE_CANCELED),
        ("Clinician Canceled", AppointmentStatus.CANCELED),
        ("Cancelled", AppointmentStatus.CANCELED),
        ("", None),
        ("Rescheduled?", None),
    ],
)
def test_reads_attendance(raw: str, status: AppointmentStatus | None) -> None:
    assert values.attendance(raw) == status


def test_reads_diagnoses_and_relationships() -> None:
    codes = values.diagnoses("F41.1 - Generalized anxiety disorder; F32.9 Major depressive")
    assert codes == [
        {"code": "F41.1", "description": "Generalized anxiety disorder"},
        {"code": "F32.9", "description": "Major depressive"},
    ]
    assert values.subscriber_relationship("Child") == "19"
    assert values.subscriber_relationship("") == "18"
    assert values.subscriber_relationship("Grandparent") == "21"


def test_warnings_agree_with_their_counts() -> None:
    template = "{n} file{s} in {file} {are} damaged and {were} skipped"
    assert values.counted(template, 1, file="a{b}.zip") == (
        "1 file in a{b}.zip is damaged and was skipped"
    )
    assert (
        values.counted(template, 3, file="x.zip") == "3 files in x.zip are damaged and were skipped"
    )


def test_parses_vcards() -> None:
    text = (
        "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\n"
        "EMAIL;TYPE=INTERNET:jane@example.com\r\nitem1.TEL:555-0100\r\n"
        "ADR:;;12 Elm St;Spring\r\n field;IL;62701;USA\r\nBDAY:19880412\r\nEND:VCARD\r\n"
        "BEGIN:VCARD\r\nFN:Olivia Doe\r\nX-RELATIONSHIP:Emergency contact\r\nEND:VCARD\r\n"
    )
    jane, olivia = parse_vcards(text)
    assert (jane.first_name, jane.last_name, jane.emails, jane.phones) == (
        "Jane",
        "Doe",
        ["jane@example.com"],
        ["555-0100"],
    )
    assert (jane.city, jane.postal_code, jane.birthday) == (
        "Springfield",
        "62701",
        date(1988, 4, 12),
    )
    assert olivia.relationship == "Emergency contact"


def test_reads_reports_with_title_rows_and_totals(tmp_path: Path) -> None:
    path = tmp_path / "balances.xlsx"
    path.write_bytes(fx.xlsx_bytes(fx.BALANCES_HEADERS, fx.BALANCES_ROWS, title="Balances"))
    table = read_table(path, "balances.xlsx")
    assert table.headers == fx.BALANCES_HEADERS
    assert [row[0] for row in table.rows] == ["Robert Brown Jr.", "Jane Doe", "Katie Smith"]
    csv_path = tmp_path / "status.csv"
    csv_path.write_bytes(fx.report_files()["Appointment status.csv"])
    assert read_table(csv_path, "status.csv").headers == fx.APPOINTMENT_STATUS_HEADERS
    upload = io.BytesIO(fx.report_files()["Appointment status.csv"])
    assert read_headers(upload, "status.csv") == fx.APPOINTMENT_STATUS_HEADERS


def test_reports_too_large_to_read_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tables, "MAX_REPORT_BYTES", 10)
    path = tmp_path / "report.csv"
    path.write_bytes(b"Client,Balance\nA,1\n")
    with pytest.raises(ImportFailed, match="too large for a report"):
        tables.read_table(path, "report.csv")


# Helpers ----------------------------------------------------------------------------------------


def _new_import(api: TestClient, account: StaffAccount) -> dict[str, Any]:
    response = api.post("/api/imports", json={}, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _upload(
    api: TestClient,
    account: StaffAccount,
    import_id: int,
    name: str,
    data: bytes,
    kind: str | None = None,
) -> Any:
    return api.post(
        f"/api/imports/{import_id}/files",
        files={"file": (name, data, "application/octet-stream")},
        data={"kind": kind} if kind else {},
        headers=account.headers,
    )


def _upload_all(
    api: TestClient, account: StaffAccount, import_id: int, zip_encryption: str = "aes"
) -> dict[str, Any]:
    for name, data in fx.report_files().items():
        response = _upload(api, account, import_id, name, data)
        assert response.status_code == 201, response.text
    response = _upload(
        api, account, import_id, "export.zip", fx.export_zip(encryption=zip_encryption)
    )
    assert response.status_code == 201, response.text
    return response.json()


def _patch(api: TestClient, account: StaffAccount, import_id: int, body: dict[str, Any]) -> Any:
    return api.patch(f"/api/imports/{import_id}", json=body, headers=account.headers)


def _analyze(api: TestClient, account: StaffAccount, import_id: int, db: Session) -> dict[str, Any]:
    response = api.post(f"/api/imports/{import_id}/analyze", headers=account.headers)
    assert response.status_code == 202, response.text
    analyze_imports(db, utcnow())
    return api.get(f"/api/imports/{import_id}", headers=account.headers).json()


def _run(db: Session) -> None:
    for _ in range(50):
        run_imports(db, utcnow())
        db.expire_all()
        if (
            db.scalar(select(ImportJob.id).where(ImportJob.status == ImportStatus.IMPORTING))
            is None
        ):
            return
    raise AssertionError("the import didn't finish")


def _start(api: TestClient, account: StaffAccount, import_id: int, db: Session) -> dict[str, Any]:
    response = api.post(f"/api/imports/{import_id}/start", headers=account.headers)
    assert response.status_code == 202, response.text
    _run(db)
    return api.get(f"/api/imports/{import_id}", headers=account.headers).json()


@pytest.fixture
def practice(api: TestClient, clinician: StaffAccount, db: Session) -> dict[str, Any]:
    """The owner-clinician Jordan Lee, a second clinician, and two clients already in Synari:
    Jane Doe (same email as in SimplePractice) and a Maria Garcia with nothing to confirm her."""
    colleague = add_staff(
        db, clinician.practice_id, "sam@example.com", StaffRole.CLINICIAN, first_name="Sam"
    )
    jane = create_client_record(
        db, clinician, first_name="Jane", last_name="Doe", email="jane.doe@example.com", phone=""
    )
    maria = create_client_record(
        db, clinician, first_name="Maria", last_name="Garcia", email="maria.other@example.com"
    )
    return {"owner": clinician, "colleague": colleague, "jane": jane, "maria": maria}


def _analyzed(
    api: TestClient, db: Session, owner: StaffAccount, zip_encryption: str = "aes"
) -> dict[str, Any]:
    job = _new_import(api, owner)
    _upload_all(api, owner, job["id"], zip_encryption)
    response = _patch(api, owner, job["id"], {"zip_password": fx.ZIP_PASSWORD})
    assert response.status_code == 200, response.text
    analyzed = _analyze(api, owner, job["id"], db)
    assert analyzed["status"] == "ready", analyzed["error"]
    return analyzed


def _decide_everything(
    api: TestClient, owner: StaffAccount, job: dict[str, Any], *, invite: bool = True
) -> dict[str, Any]:
    """Accept the suggested matches, update the existing Maria Garcia and invite Maya Chen."""
    preview = job["preview"]
    matches = {m["id"]: m["candidates"][0]["key"] for m in preview["matches"]}
    existing = {e["key"]: int(e["candidates"][0]["key"]) for e in preview["existing"]}
    options = {
        "default_clinician_id": owner.id,
        "clinicians": {
            "chen maya": {
                "invite": {"first_name": "Maya", "last_name": "Chen", "email": "maya@example.com"}
            }
        }
        if invite
        else {},
        "matches": matches,
        "existing": existing,
    }
    response = _patch(api, owner, job["id"], {"options": options})
    assert response.status_code == 200, response.text
    return response.json()


def _imported(api: TestClient, db: Session, owner: StaffAccount) -> dict[str, Any]:
    job = _analyzed(api, db, owner)
    _decide_everything(api, owner, job)
    finished = _start(api, owner, job["id"], db)
    assert finished["status"] == "completed", finished["error"]
    return finished


def _client(db: Session, first: str, last: str) -> Client:
    return db.scalars(
        select(Client).where(Client.first_name == first, Client.last_name == last)
    ).one()


# The whole import ----------------------------------------------------------------------------


def test_uploads_are_recognized_and_mapped(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner = practice["owner"]
    job = _new_import(api, owner)
    uploaded = _upload_all(api, owner, job["id"])
    kinds = {f["filename"]: (f["kind"], f["detected_kind"]) for f in uploaded["files"]}
    assert kinds == {
        "Client details.csv": ("client_details", "client_details"),
        "Client demographics.xlsx": ("client_demographics", "client_demographics"),
        "Appointment status.csv": ("appointment_status", "appointment_status"),
        "Attendance.xlsx": ("attendance", "attendance"),
        "Outstanding balances.csv": ("outstanding_balances", "outstanding_balances"),
        "Client List.csv": ("client_list", "client_list"),
        "export.zip": ("export_zip", "export_zip"),
    }
    zip_entry = next(f for f in uploaded["files"] if f["kind"] == "export_zip")
    assert zip_entry["encrypted"] is True
    assert uploaded["options"]["zip_password_set"] is False
    status_file = next(f for f in uploaded["files"] if f["kind"] == "appointment_status")
    assert status_file["headers"] == fx.APPOINTMENT_STATUS_HEADERS
    assert uploaded["mapping"][str(status_file["file_id"])]["cpt_code"] == "CPT code"
    stored = db.get(StoredFile, zip_entry["file_id"])
    assert stored.purpose == FilePurpose.IMPORT_SOURCE
    assert stored.client_id is None
    # Import uploads can't be downloaded like documents.
    assert api.get(f"/api/files/{stored.id}", headers=owner.headers).status_code == 404

    with_password = _patch(api, owner, job["id"], {"zip_password": fx.ZIP_PASSWORD}).json()
    assert with_password["options"]["zip_password_set"] is True
    assert "zip_password" not in with_password["options"]
    raw = db.get(ImportJob, job["id"])
    db.refresh(raw)
    assert fx.ZIP_PASSWORD not in str(raw.options)


def test_analysis_previews_matches_clinicians_and_warnings(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner = practice["owner"]
    job = _analyzed(api, db, owner)
    preview = job["preview"]
    counts = preview["counts"]
    # Jane Doe (same email) is updated; the Maria Garcia match needs confirming, so undecided
    # she's new. Katie Smith (balances) and Pat Quinn (a document folder) are new until then.
    assert counts["clients_existing"] == 1
    assert counts["clients_new"] == 8
    assert counts["appointments"] == 6
    assert counts["future_appointments_skipped"] == 1
    assert counts["documents"] == 10
    assert counts["psychotherapy_notes"] == 1
    assert counts["secure_messages"] == 1
    assert counts["documents_skipped"] == 1
    assert counts["insurance_policies"] == 2
    assert counts["contacts"] == 2
    assert counts["clients_with_diagnoses"] == 2
    assert counts["balances"] == 2
    assert counts["balance_total_cents"] == 12000 + 4550

    matches = {m["name"]: m for m in preview["matches"]}
    assert set(matches) == {"Katie Smith", "Alex Morgan"}
    assert matches["Katie Smith"]["reason"] == "similar_name"
    assert [c["name"] for c in matches["Katie Smith"]["candidates"]] == ["Katherine Smith"]
    assert matches["Alex Morgan"]["reason"] == "same_name"
    assert {c["detail"] for c in matches["Alex Morgan"]["candidates"]} == {
        "born 1990-01-01 · alex.m1@example.com",
        "born 1995-05-05 · alex.m2@example.com",
    }
    assert matches["Alex Morgan"]["decision"] is None
    # Only the rows that need confirming are counted, not the clients they might be.
    assert matches["Alex Morgan"]["sources"] == ["Appointment status report (1 mention)"]
    assert matches["Katie Smith"]["sources"] == ["Outstanding balances report (1 mention)"]
    [existing] = preview["existing"]
    assert existing["name"] == "Maria Garcia"
    assert existing["candidates"][0]["key"] == str(practice["maria"].id)

    clinicians = {c["name"]: c for c in preview["clinicians"]}
    assert clinicians["Jordan Lee, LCSW"]["staff_id"] == owner.id
    assert clinicians["Jordan Lee, LCSW"]["matched"] is True
    assert clinicians["Maya Chen, LMFT"]["staff_id"] is None
    assert clinicians["No clinician listed"]["clients"] == 2

    status_file = next(f for f in preview["files"] if f["kind"] == "appointment_status")
    assert status_file["rows"] == 8
    assert status_file["missing_required"] == []
    assert status_file["sample"][0]["client"] == "Jane Doe"
    client_list = next(f for f in preview["files"] if f["kind"] == "client_list")
    assert all("diagnoses" not in row for row in client_list["sample"])
    folders = {f["name"]: f for f in preview["folders"]}
    assert folders["Medical Records"] == {"name": "Medical Records", "clients": 2, "files": 3}
    messages = {w["code"]: w["message"] for w in preview["warnings"]}
    assert {"bad_date", "duplicate_names", "unsupported_document"} <= set(messages)
    assert messages["bad_date"] == (
        "1 row in Appointment status.csv has a date that couldn't be read and was skipped"
    )
    assert db.scalar(select(func.count()).select_from(Client)) == 2  # nothing imported yet
    events = db.scalars(select(AuditEvent.action).where(AuditEvent.resource_type == "import"))
    assert "import.analyzed" in set(events)


def test_start_needs_a_clinician_for_everyone(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner = practice["owner"]
    job = _analyzed(api, db, owner)
    response = api.post(f"/api/imports/{job['id']}/start", headers=owner.headers)
    assert response.status_code == 400
    assert "Maya Chen, LMFT" in response.json()["detail"]
    assert "default clinician" in response.json()["detail"]


def test_imports_clients_sessions_documents_and_balances(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner = practice["owner"]
    finished = _imported(api, db, owner)
    result = finished["result"]
    assert result["phase"] == "done"
    assert result["created"]["client"] == 6
    assert result["updated"]["client"] == 2
    assert result["created"]["appointment"] == 7
    assert result["created"]["document"] == 10
    assert result["created"]["balance"] == 2
    assert result["created"]["policy"] == 2
    assert result["created"]["payer"] == 2
    assert result["created"]["clinician"] == 1
    assert result["processed"] == result["total"]

    # Clinicians: Maya Chen was invited and sees her clients.
    maya = db.scalars(select(StaffMember).where(StaffMember.email == "maya@example.com")).one()
    assert maya.status == StaffStatus.INVITED
    assert maya.is_clinician
    assert len(outbound_to(db, "maya@example.com")) == 1

    # Existing clients keep what Synari had and get blanks filled in.
    jane = _client(db, "Jane", "Doe")
    assert jane.id == practice["jane"].id
    assert jane.phone == "555-201-0001"
    assert jane.date_of_birth == date(1988, 4, 12)
    assert jane.city == "Springfield"
    assert jane.diagnosis_codes == [
        {"code": "F41.1", "description": "Generalized anxiety disorder"}
    ]
    assert "Race: White" in jane.internal_notes
    maria = _client(db, "Maria", "Garcia")
    assert maria.id == practice["maria"].id
    assert maria.email == "maria.other@example.com"
    assert maria.phone == "555-201-3344"  # what Synari had

    # New clients carry their SimplePractice details.
    kate = _client(db, "Katherine", "Smith")
    assert kate.preferred_name == "Kate"
    assert kate.date_of_birth == date(1992, 9, 30)
    assert kate.sex == "Female"
    assert kate.primary_clinician.id == maya.id
    liam = _client(db, "Liam", "Johnson")
    assert liam.is_minor
    assert liam.billing_type == "insurance"
    assert liam.primary_clinician.id == owner.id
    robert = _client(db, "Robert", "Brown Jr.")
    assert robert.status == ClientStatus.INACTIVE
    assert robert.date_of_birth == date(1975, 1, 20)
    pat = _client(db, "Pat", "Quinn")
    assert pat.primary_clinician.id == owner.id  # the default clinician
    alexes = db.scalars(select(Client).where(Client.last_name == "Morgan")).all()
    assert sorted(a.email or "" for a in alexes) == ["alex.m1@example.com", "alex.m2@example.com"]

    # Contacts and insurance.
    [olivia] = db.scalars(select(ClientContact).where(ClientContact.client_id == liam.id)).all()
    assert (olivia.first_name, olivia.last_name, olivia.relation) == ("Olivia", "Johnson", "Mother")
    assert olivia.is_guardian
    assert olivia.email == "olivia.j@example.com"
    assert not olivia.portal_access
    [john] = db.scalars(select(ClientContact).where(ClientContact.client_id == jane.id)).all()
    assert john.full_name == "John Doe"
    [policy] = db.scalars(select(InsurancePolicy).where(InsurancePolicy.client_id == liam.id)).all()
    assert policy.payer.name == "Blue Cross Blue Shield"
    assert policy.payer.external_id == "BCBSIL"
    assert (policy.member_id, policy.group_number, policy.copay_cents) == (
        "XJ998877",
        "G-2231",
        2000,
    )
    assert policy.subscriber_relationship == "19"
    assert (policy.subscriber_first_name, policy.subscriber_last_name) == ("Olivia", "Johnson")
    assert policy.subscriber_dob == date(1984, 3, 2)
    assert policy.subscriber_sex == "F"
    [aetna] = db.scalars(select(InsurancePolicy).where(InsurancePolicy.client_id == jane.id)).all()
    assert (aetna.payer.name, aetna.subscriber_relationship) == ("Aetna", "18")

    # Past sessions: default 9:00 start in the clinician's zone, staggered, CPT durations.
    sessions = db.scalars(select(Appointment).order_by(Appointment.starts_at)).all()
    assert len(sessions) == 7
    assert {s.source for s in sessions} == {BookingSource.IMPORT}
    assert all(s.video_room_name is None for s in sessions)
    jan6 = [s for s in sessions if s.starts_at.date() == date(2025, 1, 6)]
    by_client = {s.participants[0].client_id: s for s in jan6}
    jane_first = by_client[jane.id]
    assert jane_first.starts_at == datetime(2025, 1, 6, 14, 0, tzinfo=UTC)  # 9:00 in New York
    assert jane_first.duration_minutes == 60
    assert jane_first.status == AppointmentStatus.ATTENDED
    assert jane_first.service_code == "90837"
    assert jane_first.location_details == "Main Office"
    assert jane_first.participants[0].fee_cents == 15000
    liam_session = by_client[liam.id]
    assert liam_session.starts_at == datetime(2025, 1, 6, 15, 0, tzinfo=UTC)  # after Jane's
    assert liam_session.duration_minutes == 30
    assert liam_session.status == AppointmentStatus.LATE_CANCELED
    assert liam_session.location_type == LocationType.VIDEO
    assert by_client[kate.id].clinician_id == maya.id
    statuses = sorted(
        s.status for s in sessions if jane.id in [p.client_id for p in s.participants]
    )
    assert statuses == ["attended", "canceled", "no_show"]

    # Documents by folder; psychotherapy notes belong to the primary clinician.
    documents = db.scalars(
        select(StoredFile).where(StoredFile.purpose == FilePurpose.IMPORTED_DOCUMENT)
    ).all()
    assert len(documents) == 10
    categories = {(d.client_id, d.category, d.filename) for d in documents}
    assert (jane.id, "Medical Records", "Treatment Plan.pdf") in categories
    assert (jane.id, "Secure messages", "Secure messages.txt") in categories
    assert (kate.id, "Stored Documents", "Insurance card.jpg") in categories
    assert (robert.id, "Billing Documents", "Statement 2025-02.pdf") in categories
    note = next(d for d in documents if d.category == "Psychotherapy Notes")
    assert note.uploaded_by_staff_id == owner.id
    assert not any(d.shared_with_client for d in documents)

    # Opening balances, one invoice each, without emails.
    invoices = db.scalars(select(Invoice).order_by(Invoice.total_cents)).all()
    assert [(i.client_id, i.total_cents) for i in invoices] == [(kate.id, 4550), (robert.id, 12000)]
    assert invoices[0].items[0].description == "Balance carried over from SimplePractice"
    assert outbound_to(db, "rbrown@example.com") == []

    # Uploaded files are gone; the summary stays. The creator is told.
    assert (
        db.scalar(
            select(func.count())
            .select_from(StoredFile)
            .where(StoredFile.purpose == FilePurpose.IMPORT_SOURCE)
        )
        == 0
    )
    job = db.get(ImportJob, finished["id"])
    db.refresh(job)
    assert "zip_password" not in job.options
    assert finished["files"]  # the list of what was uploaded stays for the record
    notice = db.scalars(select(Notification).where(Notification.recipient_id == owner.id)).all()
    assert any(n.link == f"/portal/settings?tab=import&import={job.id}" for n in notice)
    completed = db.scalars(select(AuditEvent).where(AuditEvent.action == "import.completed")).one()
    assert completed.detail["created"]["client"] == 6
    assert "Jane" not in str(completed.detail)


def test_running_the_same_files_again_duplicates_nothing(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner = practice["owner"]
    _imported(api, db, owner)
    models = (Client, Appointment, StoredFile, Invoice, ClientContact, InsurancePolicy, Payer)
    counts_before = {m: db.scalar(select(func.count()).select_from(m)) for m in models}
    again = _analyzed(api, db, owner)
    # Clients from the first run are recognized; the name to confirm is asked again.
    assert again["preview"]["counts"]["clients_existing"] == 8
    assert again["preview"]["existing"] == []
    assert {m["name"] for m in again["preview"]["matches"]} == {"Katie Smith", "Alex Morgan"}
    maya = db.scalars(select(StaffMember).where(StaffMember.email == "maya@example.com")).one()
    clinicians = {c["key"]: c for c in again["preview"]["clinicians"]}
    assert clinicians["chen maya"]["staff_id"] == maya.id  # the clinician invited last time
    decided = _decide_everything(api, owner, again, invite=False)
    assert decided["status"] == "ready"
    reviewed = _analyze(api, owner, again["id"], db)
    assert reviewed["preview"]["counts"]["clients_new"] == 0
    finished = _start(api, owner, again["id"], db)
    assert finished["status"] == "completed", finished["error"]
    result = finished["result"]
    assert result["created"].get("client", 0) == 0
    assert result["updated"]["client"] == 8
    assert result["skipped"]["appointment"] == 7
    assert result["skipped"]["document"] == 10
    assert result["skipped"]["balance"] == 2
    db.expire_all()
    assert {m: db.scalar(select(func.count()).select_from(m)) for m in models} == counts_before


def test_imports_resume_across_slices_and_after_a_failure(
    api: TestClient, practice: dict[str, Any], db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = practice["owner"]
    job = _analyzed(api, db, owner)
    _decide_everything(api, owner, job)
    monkeypatch.setattr(runner, "BATCH_SIZE", 3)
    monkeypatch.setattr(jobs, "SLICE_SECONDS", 0)  # one batch per worker pass
    real_store = runner.store_upload
    calls = {"count": 0}

    def flaky_store(*args: Any, **kwargs: Any) -> StoredFile:
        calls["count"] += 1
        if calls["count"] == 4:
            raise RuntimeError("storage went away")
        return real_store(*args, **kwargs)

    monkeypatch.setattr(runner, "store_upload", flaky_store)
    api.post(f"/api/imports/{job['id']}/start", headers=owner.headers)
    passes = 0
    while passes < 100:
        run_imports(db, utcnow())
        db.expire_all()
        passes += 1
        if db.get_one(ImportJob, job["id"]).status != ImportStatus.IMPORTING:
            break
    failed = api.get(f"/api/imports/{job['id']}", headers=owner.headers).json()
    assert failed["status"] == "failed"
    assert failed["error"] == "Something went wrong while importing. Start it again to continue."
    assert passes > 5  # it really ran in slices
    assert 0 < failed["result"]["processed"] < failed["result"]["total"]
    notices = db.scalars(select(Notification.kind).where(Notification.recipient_id == owner.id))
    assert "import_failed" in set(notices)

    finished = _start(api, owner, job["id"], db)
    assert finished["status"] == "completed"
    assert finished["result"]["created"]["client"] == 6
    assert finished["result"]["created"]["appointment"] == 7
    assert finished["result"]["created"]["document"] == 10
    assert db.scalar(select(func.count()).select_from(Appointment)) == 7
    assert db.scalar(select(func.count()).select_from(Invoice)) == 2
    imported_documents = (
        select(func.count())
        .select_from(StoredFile)
        .where(StoredFile.purpose == FilePurpose.IMPORTED_DOCUMENT)
    )
    assert db.scalar(imported_documents) == 10
    keys = list(db.scalars(select(ImportRecord.source_key).where(ImportRecord.job_id == job["id"])))
    assert len(keys) == len(set(keys))


def test_standard_zip_encryption_and_wrong_passwords(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    job = _new_import(api, clinician)
    _upload(api, clinician, job["id"], "export.zip", fx.export_zip(encryption="zipcrypto"))
    no_password = _analyze(api, clinician, job["id"], db)
    assert no_password["status"] == "failed"
    assert no_password["error"] == "The export zip is password protected: enter its password"
    _patch(api, clinician, job["id"], {"zip_password": "not it"})
    wrong = _analyze(api, clinician, job["id"], db)
    assert wrong["status"] == "failed"
    assert wrong["error"].startswith("The export zip's password is incorrect")
    _patch(api, clinician, job["id"], {"zip_password": fx.ZIP_PASSWORD})
    ready = _analyze(api, clinician, job["id"], db)
    assert ready["status"] == "ready", ready["error"]
    assert ready["preview"]["counts"]["documents"] == 10
    # A solo practice's clinician takes every SimplePractice clinician's clients.
    assert {c["staff_id"] for c in ready["preview"]["clinicians"]} == {clinician.id}


def test_unreadable_files_fail_with_a_clear_error(
    api: TestClient, clinician: StaffAccount, db: Session, tmp_path: Path
) -> None:
    job = _new_import(api, clinician)
    not_zip = _upload(api, clinician, job["id"], "export.zip", b"PK\x03\x04 truncated")
    assert not_zip.status_code == 422
    assert "isn't a complete zip archive" in not_zip.json()["detail"]
    bad_xlsx = _upload(api, clinician, job["id"], "report.xlsx", b"not a workbook")
    assert bad_xlsx.status_code == 422
    assert "couldn't be opened as an Excel workbook" in bad_xlsx.json()["detail"]

    uploaded = _upload(api, clinician, job["id"], "export.zip", fx.export_zip(encryption="none"))
    stored = db.get_one(StoredFile, uploaded.json()["files"][0]["file_id"])
    # Stored files are encrypted, so damaged bytes fail to decrypt.
    saved = tmp_path / "files" / stored.storage_key
    saved.write_bytes(saved.read_bytes()[: stored.size_bytes // 2])
    damaged = _analyze(api, clinician, job["id"], db)
    assert damaged["status"] == "failed"
    assert damaged["error"] == "export.zip is damaged in storage; upload it again"
    # A worker's local copy that isn't a zip after all.
    local = sources.work_dir(job["id"]) / PurePosixPath(stored.storage_key).name
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(b"\x00" * stored.size_bytes)
    corrupt = _analyze(api, clinician, job["id"], db)
    assert corrupt["status"] == "failed"
    assert corrupt["error"].startswith("The export zip couldn't be read")
    events = db.scalars(select(AuditEvent).where(AuditEvent.action == "import.failed")).all()
    assert events
    assert all(event.detail["phase"] == "analysis" for event in events)


def test_psychotherapy_notes_are_only_for_the_author_or_primary_clinician(
    api: TestClient, practice: dict[str, Any], db: Session
) -> None:
    owner, colleague = practice["owner"], practice["colleague"]
    _imported(api, db, owner)
    jane = _client(db, "Jane", "Doe")
    note = db.scalars(select(StoredFile).where(StoredFile.category == "Psychotherapy Notes")).one()
    mine = api.get(f"/api/clients/{jane.id}/files", headers=owner.headers).json()
    assert note.id in [f["id"] for f in mine]
    assert {f["category"] for f in mine} >= {"Psychotherapy Notes", "Medical Records"}
    assert api.get(f"/api/files/{note.id}", headers=owner.headers).status_code == 200

    # A colleague on the care team, and a clinician who sees every chart, see the rest only.
    db.add(ClientClinician(client_id=jane.id, staff_id=colleague.id))
    db.commit()
    everything = add_staff(
        db,
        owner.practice_id,
        "all@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.PRACTICE,
        first_name="Ana",
    )
    for other in (colleague, everything):
        listed = api.get(f"/api/clients/{jane.id}/files", headers=other.headers).json()
        assert note.id not in [f["id"] for f in listed]
        assert len(listed) == len(mine) - 1
        assert api.get(f"/api/files/{note.id}", headers=other.headers).status_code == 404

    # Never in a record export, never in the client's portal.
    export = api.post(
        f"/api/clients/{jane.id}/export", json={"purpose": "treatment"}, headers=owner.headers
    )
    assert export.status_code == 200
    with zipfile.ZipFile(io.BytesIO(export.content)) as bundle:
        names = bundle.namelist()
    assert any("Treatment-Plan.pdf" in name for name in names)
    assert not any("Psychotherapy" in name for name in names)
    assert api.get("/api/portal/files", headers=portal_headers(jane)).json() == []


def test_imported_sessions_are_never_billed_claimed_reminded_or_flagged(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    configure_practice(db, clinician)
    client = insured_client(db, clinician, add_payer(db, clinician.practice_id))
    imported = create_appointment(
        db,
        clinician,
        [client],
        starts_at=session_at(2),
        status="attended",
        service_code="90837",
        source=BookingSource.IMPORT,
    )
    live = create_appointment(
        db, clinician, [client], starts_at=session_at(3), status="attended", service_code="90837"
    )
    live_id = live.participants[0].id
    imported_id = imported.participants[0].id
    uninvoiced = api.get("/api/billing/uninvoiced", headers=clinician.headers).json()
    assert [s["participant_id"] for s in uninvoiced] == [live_id]
    unbilled = api.get("/api/claims/unbilled", headers=clinician.headers).json()
    assert [s["participant_id"] for s in unbilled] == [live_id]
    manual = api.post(
        "/api/billing/invoices",
        json={"client_id": client.id, "participant_ids": [imported_id]},
        headers=clinician.headers,
    )
    assert manual.status_code == 422
    assert "imported" in manual.json()["detail"]
    claim = api.post(
        "/api/claims", json={"participant_ids": [imported_id]}, headers=clinician.headers
    )
    assert claim.status_code == 409
    assert "was imported" in claim.json()["detail"]
    dashboard = api.get("/api/dashboard", headers=clinician.headers).json()
    assert dashboard["appointments_missing_notes"] == 1  # only the live session

    create_daily_invoices(db, utcnow())
    billed = [
        item.participant_id for invoice in db.scalars(select(Invoice)) for item in invoice.items
    ]
    assert billed == [live_id]

    upcoming = create_appointment(
        db,
        clinician,
        [client],
        starts_at=utcnow().replace(microsecond=0) + timedelta(hours=20),
        source=BookingSource.IMPORT,
    )
    upcoming.created_at = utcnow() - timedelta(days=2)
    db.commit()
    send_appointment_reminders(db, utcnow())
    db.refresh(upcoming)
    assert upcoming.participants[0].reminder_email_sent_at is None


def test_only_practice_managers_can_import(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    job = _new_import(api, clinician)
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    assert api.get(f"/api/imports/{job['id']}", headers=manager.headers).status_code == 200
    practice_clinician = add_staff(
        db,
        clinician.practice_id,
        "pc@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.PRACTICE,
    )
    assert api.get("/api/imports", headers=practice_clinician.headers).status_code == 200
    invite = {"invite": {"first_name": "Maya", "last_name": "Chen", "email": "maya@example.com"}}
    with_invite = {"options": {"clinicians": {"chen maya": invite}}}
    # Inviting clinicians also takes managing the team.
    assert _patch(api, practice_clinician, job["id"], with_invite).status_code == 403
    assert _patch(api, manager, job["id"], with_invite).status_code == 200
    taken = {"invite": {"first_name": "P", "last_name": "C", "email": "pc@example.com"}}
    conflict = _patch(api, manager, job["id"], {"options": {"clinicians": {"x": taken}}})
    assert conflict.status_code == 409
    outsider = {"options": {"default_clinician_id": manager.id}}  # not a clinician
    assert _patch(api, manager, job["id"], outsider).status_code == 422

    for role, level in (
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST),
        (StaffRole.BILLER, ClinicianAccess.BASIC),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC),
    ):
        member = add_staff(
            db, clinician.practice_id, f"{role}-{level}@example.com", role, clinician_access=level
        )
        headers = member.headers
        assert api.get("/api/imports", headers=headers).status_code == 403
        assert api.get("/api/imports/kinds", headers=headers).status_code == 403
        assert api.post("/api/imports", json={}, headers=headers).status_code == 403
        assert api.get(f"/api/imports/{job['id']}", headers=headers).status_code == 403
        upload = _upload(api, member, job["id"], "a.csv", b"Client,Balance\nA,1\n")
        assert upload.status_code == 403
        for action in ("analyze", "start", "cancel"):
            response = api.post(f"/api/imports/{job['id']}/{action}", headers=headers)
            assert response.status_code == 403
        assert _patch(api, member, job["id"], {"options": {}}).status_code == 403
        removed = api.delete(f"/api/imports/{job['id']}/files/1", headers=headers)
        assert removed.status_code == 403

    other = register_practice(api, "other@example.com")
    assert api.get(f"/api/imports/{job['id']}", headers=other.headers).status_code == 404
    assert _patch(api, other, job["id"], {"options": {}}).status_code == 404
    assert api.post(f"/api/imports/{job['id']}/cancel", headers=other.headers).status_code == 404
    assert api.get("/api/imports", headers=other.headers).json() == []
    views = db.scalars(select(AuditEvent).where(AuditEvent.action == "import.view")).all()
    assert views  # viewing a preview (client names) is audited


def test_upload_rules(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _new_import(api, clinician)
    old_excel = _upload(api, clinician, job["id"], "report.xls", b"x")
    assert old_excel.status_code == 415
    assert ".xlsx or CSV" in old_excel.json()["detail"]
    assert _upload(api, clinician, job["id"], "notes.txt", b"x").status_code == 415
    assert _upload(api, clinician, job["id"], "empty.csv", b"").status_code == 422
    wrong_kind = _upload(api, clinician, job["id"], "a.csv", b"Client\nA\n", kind="export_zip")
    assert wrong_kind.status_code == 422
    unknown = _upload(api, clinician, job["id"], "mystery.csv", b"Invoice #,Amount\n1,2\n")
    assert unknown.status_code == 201
    assert unknown.json()["files"][0]["kind"] is None
    not_ready = api.post(f"/api/imports/{job['id']}/analyze", headers=clinician.headers)
    assert not_ready.status_code == 400
    assert "mystery.csv" in not_ready.json()["detail"]

    assert _upload(api, clinician, job["id"], "export.zip", fx.export_zip()).status_code == 201
    assert _upload(api, clinician, job["id"], "again.zip", fx.export_zip()).status_code == 409

    monkeypatch.setattr(settings, "import_max_bytes", 1024)
    big = _upload(api, clinician, job["id"], "big.csv", b"Client,Balance\n" + b"A,1\n" * 400)
    assert big.status_code == 413
    remaining = db.scalars(
        select(StoredFile).where(StoredFile.purpose == FilePurpose.IMPORT_SOURCE)
    ).all()
    assert len(remaining) == 2  # the rejected upload left nothing behind
    # Each upload is one encrypted file whose key is on its row, so a separate worker process
    # can read it.
    assert all(stored.wrapped_key for stored in remaining)
    folder = Path(settings.storage_local_path) / f"practices/{clinician.practice_id}/import_source"
    assert len(list(folder.iterdir())) == 2
    assert api.get("/api/config").json()["import_max_bytes"] == 1024


def test_fixing_kinds_and_columns_needs_a_new_analysis(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    job = _new_import(api, clinician)
    csv_data = fx.csv_bytes(
        ["Name", "Seen on", "Therapist", "Code"],
        [["Jane Doe", "01/06/2025", "Jordan Lee", "90837"]],
    )
    uploaded = _upload(api, clinician, job["id"], "sessions.csv", csv_data).json()
    file_id = uploaded["files"][0]["file_id"]
    assert uploaded["files"][0]["kind"] is None
    kinded = _patch(
        api, clinician, job["id"], {"files": [{"file_id": file_id, "kind": "appointment_status"}]}
    ).json()
    assert kinded["mapping"][str(file_id)]["client"] == "Name"
    assert kinded["mapping"][str(file_id)]["date_of_service"] is None
    analyzed = _analyze(api, clinician, job["id"], db)
    assert analyzed["status"] == "ready"
    [preview_file] = analyzed["preview"]["files"]
    assert preview_file["missing_required"] == ["Date of service"]
    assert any(w["code"] == "missing_columns" for w in analyzed["preview"]["warnings"])

    bad = _patch(api, clinician, job["id"], {"mapping": {str(file_id): {"date_of_service": "X"}}})
    assert bad.status_code == 422
    unknown = _patch(api, clinician, job["id"], {"mapping": {str(file_id): {"zodiac": "Name"}}})
    assert unknown.status_code == 422
    fixed = _patch(
        api,
        clinician,
        job["id"],
        {"mapping": {str(file_id): {"date_of_service": "Seen on", "clinician": "Therapist"}}},
    ).json()
    assert fixed["status"] == "uploaded"
    assert fixed["preview"] is None
    assert fixed["mapping"][str(file_id)]["client"] == "Name"
    reanalyzed = _analyze(api, clinician, job["id"], db)
    assert reanalyzed["preview"]["counts"]["appointments"] == 1
    # Options alone keep the preview.
    kept = _patch(api, clinician, job["id"], {"options": {"import_balances": False}}).json()
    assert kept["status"] == "ready"
    assert kept["options"]["import_balances"] is False
    removed = api.delete(f"/api/imports/{job['id']}/files/{file_id}", headers=clinician.headers)
    assert removed.json()["files"] == []
    assert removed.json()["status"] == "uploaded"
    assert db.get(StoredFile, file_id) is None


def test_canceling_deletes_the_uploads_and_tells_the_creator(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[tuple[list[tuple[str, int]], str, dict[str, Any]]] = []
    monkeypatch.setattr(
        runner, "publish", lambda _db, to, kind, data: events.append((list(to), kind, data))
    )
    job = _new_import(api, clinician)
    _upload(api, clinician, job["id"], "export.zip", fx.export_zip())
    _patch(api, clinician, job["id"], {"zip_password": fx.ZIP_PASSWORD})
    canceled = api.post(f"/api/imports/{job['id']}/cancel", headers=clinician.headers).json()
    assert canceled["status"] == "canceled"
    assert canceled["options"]["zip_password_set"] is False
    assert db.scalars(select(StoredFile)).all() == []
    analyze = api.post(f"/api/imports/{job['id']}/analyze", headers=clinician.headers)
    assert analyze.status_code == 409
    again = api.post(f"/api/imports/{job['id']}/cancel", headers=clinician.headers)
    assert again.status_code == 409
    assert events
    assert all(to == [("staff", clinician.id)] for to, _, _ in events)
    assert {kind for _, kind, _ in events} == {"import.updated"}
    assert events[-1][2] == {
        "import_id": job["id"],
        "status": "canceled",
        "phase": "",
        "processed": 0,
        "total": 0,
    }
    listed = api.get("/api/imports", headers=clinician.headers).json()
    assert [(j["id"], j["status"], j["file_count"]) for j in listed] == [(job["id"], "canceled", 1)]


def test_kinds_catalog(api: TestClient, clinician: StaffAccount) -> None:
    listed = api.get("/api/imports/kinds", headers=clinician.headers).json()
    kinds = {k["kind"]: k for k in listed}
    assert set(kinds) == {k.value for k in ImportFileKind}
    assert "Data export" in kinds["export_zip"]["description"]
    fields = {f["name"]: f for f in kinds["attendance"]["fields"]}
    assert fields["status"]["required"] is True
    assert "services_provided" not in {f["name"] for f in kinds["outstanding_balances"]["fields"]}


def test_local_copies_are_cleaned_up(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    job = _new_import(api, clinician)
    _upload(api, clinician, job["id"], "export.zip", fx.export_zip(encryption="none"))
    _analyze(api, clinician, job["id"], db)
    assert sources.work_dir(job["id"]).exists()
    api.post(f"/api/imports/{job['id']}/cancel", headers=clinician.headers)
    assert not sources.work_dir(job["id"]).exists()
    leftover = sources.work_dir(999)
    leftover.mkdir(parents=True)
    analyze_imports(db, utcnow())
    assert not leftover.exists()
