"""Encrypted backups, restore tests and the worker's overdue-backup alerts."""

import base64
import io
import json
import os
import shutil
import sys
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import boto3
import pyrage
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from synari import admin, crypto
from synari.config import settings
from synari.db import utcnow
from synari.models import Practice, SecurityEvent
from synari.models.enums import SecuritySeverity
from synari.services import backups, storage
from synari.services.security_events import record_security_event
from tests.conftest import StaffAccount, create_client_record
from tests.fake_s3 import FakeS3

needs_pg_tools = pytest.mark.skipif(
    not (shutil.which("pg_dump") and shutil.which("pg_restore")),
    reason="needs PostgreSQL client tools (pg_dump/pg_restore) as new as the server",
)
AGE_HEADER = b"age-encryption.org/v1"
SECRET_NOTE = "Discussed panic symptoms"
SECRET_FILE = b"%PDF safety plan for Alex"


@pytest.fixture
def identity_file(tmp_path: Path) -> Path:
    identity = pyrage.x25519.Identity.generate()
    path = tmp_path / "backup-key.txt"
    path.write_text(f"# public key: {identity.to_public()}\n{identity}\n")
    return path


@pytest.fixture(autouse=True)
def _backup_settings(
    tmp_path: Path, identity_file: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[None]:
    public_key = identity_file.read_text().splitlines()[0].removeprefix("# public key: ")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path / "files"))
    monkeypatch.setattr(settings, "backup_target", str(tmp_path / "backups"))
    monkeypatch.setattr(settings, "age_recipients", public_key)
    monkeypatch.setattr(settings, "age_identity_file", str(identity_file))
    monkeypatch.setattr(settings, "backup_retention_count", 2)
    monkeypatch.setattr(admin, "configure_logging", lambda: None)
    storage.get_storage.cache_clear()
    yield
    storage.get_storage.cache_clear()
    crypto.keyring.cache_clear()


def seed(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    client = create_client_record(db, clinician, internal_notes=SECRET_NOTE)
    uploaded = api.post(
        f"/api/clients/{client.id}/files",
        files={"file": ("plan.pdf", SECRET_FILE, "application/pdf")},
        headers=clinician.headers,
    )
    assert uploaded.status_code == 201, uploaded.text


def events(db: Session, kind: str) -> list[SecurityEvent]:
    db.expire_all()
    return list(db.scalars(select(SecurityEvent).where(SecurityEvent.kind == kind)))


def backup_folders() -> list[Path]:
    return sorted(Path(settings.backup_target).glob("synari-*"))


def leftover_restore_databases(db: Session) -> list[str]:
    return list(
        db.scalars(text("SELECT datname FROM pg_database WHERE datname LIKE 'synari_restore_%'"))
    )


def test_the_backup_key_can_come_from_standard_input(
    identity_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO(identity_file.read_text()))
    from_stdin = [str(key) for key in backups.age_identities("-")]
    assert from_stdin == [str(key) for key in backups.age_identities(str(identity_file))]


@needs_pg_tools
def test_a_fresh_install_backs_up_before_any_file_is_uploaded(
    clinician: StaffAccount, db: Session
) -> None:
    # No file storage folder yet (the backup container can't create it: storage is read-only).
    assert not Path(settings.storage_local_path).exists()
    assert admin.main(["backup"]) == 0
    assert not Path(settings.storage_local_path).exists()
    assert events(db, "backup.completed")
    assert admin.main(["restore-test"]) == 0


@needs_pg_tools
def test_backup_and_restore_test_round_trip(
    api: TestClient, clinician: StaffAccount, db: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    seed(api, db, clinician)

    assert admin.main(["backup"]) == 0
    (folder,) = backup_folders()
    manifest = json.loads((folder / backups.MANIFEST).read_text())
    assert set(manifest["archives"]) == {backups.DATABASE_ARCHIVE, backups.FILES_ARCHIVE}
    assert manifest["row_counts"]["clients"] == 1
    assert manifest["row_counts"]["stored_files"] == 1
    for name, entry in manifest["archives"].items():
        archive = (folder / name).read_bytes()
        assert archive.startswith(AGE_HEADER)  # encrypted to the operator's key
        assert entry["bytes"] == len(archive)
        assert SECRET_NOTE.encode() not in archive and b"Alex" not in archive
    (completed,) = events(db, "backup.completed")
    assert completed.practice_id is None
    assert completed.detail is not None and completed.detail["backup"] == folder.name
    assert completed.detail["rows"] == sum(manifest["row_counts"].values())

    assert admin.main(["restore-test"]) == 0
    assert "passed" in capsys.readouterr().out
    (tested,) = events(db, "backup.restore_tested")
    assert tested.detail is not None
    assert tested.detail["backup"] == folder.name
    assert tested.detail["files"] == 1
    assert tested.detail["encrypted_values"] > 0
    assert leftover_restore_databases(db) == []


@needs_pg_tools
def test_restore_test_fails_closed(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed(api, db, clinician)
    assert admin.main(["backup"]) == 0
    (folder,) = backup_folders()

    # Someone else's age key can't open the backup.
    stranger = tmp_path / "stranger.txt"
    stranger.write_text(f"{pyrage.x25519.Identity.generate()}\n")
    assert admin.main(["restore-test", "--identity", str(stranger)]) == 1

    # Without the DATA_ENCRYPTION_KEYS the data was written with, the backup is unreadable.
    original_keys = settings.data_encryption_keys
    monkeypatch.setattr(
        settings, "data_encryption_keys", f"k9:{base64.b64encode(os.urandom(32)).decode()}"
    )
    crypto.keyring.cache_clear()
    assert admin.main(["restore-test"]) == 1
    monkeypatch.setattr(settings, "data_encryption_keys", original_keys)
    crypto.keyring.cache_clear()

    # A damaged archive doesn't match its checksum.
    database = folder / backups.DATABASE_ARCHIVE
    database.write_bytes(database.read_bytes()[:-1] + b"\x00")
    assert admin.main(["restore-test"]) == 1

    failures = events(db, "backup.restore_test_failed")
    assert len(failures) == 3
    assert all(f.severity == SecuritySeverity.CRITICAL for f in failures)
    assert events(db, "backup.restore_tested") == []
    assert leftover_restore_databases(db) == []


@needs_pg_tools
def test_backups_keep_only_the_newest() -> None:
    now = utcnow()
    names = [backups.create_backup(now + timedelta(minutes=i)).name for i in range(3)]
    assert [folder.name for folder in backup_folders()] == names[1:]
    assert not list(Path(settings.backup_target).glob(".*partial"))


def test_a_backup_without_recipients_fails_and_is_recorded(
    db: Session, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(settings, "age_recipients", "")
    assert admin.main(["backup"]) == 1
    assert "AGE_RECIPIENTS" in capsys.readouterr().out
    monkeypatch.setattr(settings, "age_recipients", "not-a-key")
    assert admin.main(["backup"]) == 1
    assert len(events(db, "backup.failed")) == 2
    assert backup_folders() == []


@needs_pg_tools
def test_backups_to_s3(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeS3()
    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: fake)
    monkeypatch.setattr(settings, "backup_target", "s3://backups/synari/prod")
    seed(api, db, clinician)
    now = utcnow()

    first = backups.create_backup(now)
    uploaded = [key for bucket, key in fake.objects if bucket == "backups"]
    assert uploaded[-1] == f"synari/prod/{first.name}/manifest.json"  # written last
    assert {key.rsplit("/", 1)[-1] for key in uploaded} == {
        "manifest.json",
        backups.DATABASE_ARCHIVE,
        backups.FILES_ARCHIVE,
    }
    assert all(args["ServerSideEncryption"] == "AES256" for args in fake.upload_args.values())

    report = backups.restore_test(settings.age_identity_file)
    assert (report.name, report.files) == (first.name, 1)

    for minutes in (1, 2):
        backups.create_backup(now + timedelta(minutes=minutes))
    assert len(backups.backup_target().names()) == 2
    assert not any(first.name in key for _bucket, key in fake.objects)


def test_overdue_backups_and_restore_tests_raise_security_events(
    clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def run() -> set[str]:
        backups.check_backup_health(db, utcnow())
        return {event.kind for event in events(db, "backup.overdue")} | {
            event.kind for event in events(db, "backup.restore_test_overdue")
        }

    def age(model: type[Practice] | type[SecurityEvent], kind: str | None, by: timedelta) -> None:
        statement = update(model).values(created_at=model.created_at - by)
        if kind is not None:
            statement = statement.where(SecurityEvent.kind == kind)
        db.execute(statement)
        db.commit()

    monkeypatch.setattr(settings, "backup_target", "")
    age(Practice, None, timedelta(days=100))
    assert run() == set()  # backups aren't configured: nothing to watch

    monkeypatch.setattr(settings, "backup_target", "/backups")
    assert run() == {"backup.overdue", "backup.restore_test_overdue"}
    assert run() == {"backup.overdue", "backup.restore_test_overdue"}
    assert len(events(db, "backup.overdue")) == 1  # at most one alert a day
    age(SecurityEvent, "backup.overdue", timedelta(hours=25))
    run()
    assert len(events(db, "backup.overdue")) == 2

    db.execute(text("DELETE FROM security_events"))
    for kind in ("backup.completed", "backup.restore_tested"):
        record_security_event(
            db, practice_id=None, kind=kind, severity=SecuritySeverity.INFO, detail={}
        )
    db.commit()
    age(SecurityEvent, "backup.completed", timedelta(hours=25))
    age(SecurityEvent, "backup.restore_tested", timedelta(days=89))
    assert run() == set()
    age(SecurityEvent, "backup.completed", timedelta(hours=2))
    assert run() == {"backup.overdue"}
