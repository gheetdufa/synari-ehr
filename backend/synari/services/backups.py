"""Encrypted backups and restore tests (`python -m synari.admin backup` / `restore-test`).

A backup is a folder named synari-<UTC time> in BACKUP_TARGET (a directory, or
s3://bucket/prefix using the S3_* credentials) holding:

- database.dump.age: `pg_dump --format=custom` of the whole database;
- files.tar.age: a tar of local file storage (STORAGE_BACKEND=local only; for S3 storage rely
  on the bucket's versioning and replication);
- manifest.json: each archive's SHA-256 and size, the schema revision and per-table row
  counts (counts only, never data). It's written last: a folder without one is incomplete.

Archives are encrypted with age to the AGE_RECIPIENTS public keys while they're produced, so
nothing unencrypted touches disk. Sensitive columns and stored files are also encrypted by
Synari itself, so a restore needs the age private key AND DATA_ENCRYPTION_KEYS: escrow both,
apart from the backups and from each other. Row counts are taken from the same database
snapshot pg_dump reads, so a restore test can compare them exactly.

The restore test restores the newest backup into a throwaway database, runs `alembic check`,
compares row counts, decrypts a sample of every encrypted column and of the stored files, then
drops the database. Both commands record security events (backup.completed, backup.failed,
backup.restore_tested, backup.restore_test_failed); the worker raises backup.overdue or
backup.restore_test_overdue when those go stale.
"""

import argparse
import hashlib
import io
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO, Protocol

import psycopg
import pyrage
from psycopg import sql
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from synari.config import settings
from synari.crypto import EncryptionError
from synari.db import Base, SessionLocal, engine, utcnow
from synari.logs import redact
from synari.models import Practice, SecurityEvent, StoredFile
from synari.models.enums import SecuritySeverity
from synari.services.key_rotation import encrypted_columns
from synari.services.security_events import record_security_event
from synari.services.storage import (
    EncryptedStorage,
    LocalBackend,
    get_storage,
    s3_client,
    s3_upload_args,
)

logger = logging.getLogger(__name__)

BACKUP_PREFIX = "synari-"
MANIFEST = "manifest.json"
DATABASE_ARCHIVE = "database.dump.age"
FILES_ARCHIVE = "files.tar.age"
MANIFEST_FORMAT = 1
# How many values per encrypted column, and how many stored files, a restore test decrypts.
SAMPLE_VALUES = 3
SAMPLE_FILES = 5
# The worker's alerting thresholds.
BACKUP_MAX_AGE = timedelta(hours=26)
RESTORE_TEST_MAX_AGE = timedelta(days=90)
OVERDUE_ALERT_INTERVAL = timedelta(hours=24)
BACKEND_ROOT = Path(__file__).resolve().parents[2]


class BackupError(Exception):
    """A backup or restore test couldn't be completed; the message says why (no data)."""


@dataclass(frozen=True)
class Archive:
    """One encrypted file of a backup."""

    filename: str
    sha256: str
    size_bytes: int

    def manifest_entry(self) -> dict[str, Any]:
        return {"file": self.filename, "sha256": self.sha256, "bytes": self.size_bytes}


@dataclass(frozen=True)
class BackupResult:
    name: str
    archives: list[Archive]
    row_counts: dict[str, int]


@dataclass(frozen=True)
class RestoreReport:
    name: str
    tables: int
    rows: int
    encrypted_values: int
    files: int


# --- where backups go ---------------------------------------------------------------------


class BackupTarget(Protocol):
    """A place that keeps backup folders."""

    def publish(self, name: str, folder: Path) -> None: ...
    def names(self) -> list[str]: ...
    def fetch(self, name: str, workdir: Path) -> Path: ...
    def remove(self, name: str) -> None: ...


class LocalTarget:
    """Backups as folders in a local directory (mount it from another disk or host)."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def staging(self, name: str) -> Path:
        """A hidden folder to build a backup in before it's published."""
        folder = self.root / f".{name}.partial"
        folder.mkdir(parents=True)
        return folder

    def publish(self, name: str, folder: Path) -> None:
        folder.rename(self.root / name)

    def names(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(
            entry.name
            for entry in self.root.iterdir()
            if entry.name.startswith(BACKUP_PREFIX) and (entry / MANIFEST).is_file()
        )

    def fetch(self, name: str, workdir: Path) -> Path:
        return self.root / name

    def remove(self, name: str) -> None:
        shutil.rmtree(self.root / name)


class S3Target:
    """Backups under a prefix of an S3-compatible bucket (use one with versioning/object lock)."""

    def __init__(self, bucket: str, prefix: str) -> None:
        self.bucket = bucket
        self.prefix = f"{prefix.strip('/')}/" if prefix.strip("/") else ""
        self.client = s3_client()

    def staging(self, name: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=f"{name}-"))

    def _key(self, name: str, filename: str) -> str:
        return f"{self.prefix}{name}/{filename}"

    def publish(self, name: str, folder: Path) -> None:
        upload_args = s3_upload_args()
        # The manifest goes last: a backup without one is incomplete.
        paths = [*sorted(p for p in folder.iterdir() if p.name != MANIFEST), folder / MANIFEST]
        for path in paths:
            self.client.upload_file(
                str(path), self.bucket, self._key(name, path.name), ExtraArgs=upload_args
            )
        shutil.rmtree(folder)

    def _objects(self, prefix: str) -> list[str]:
        keys: list[str] = []
        for page in self.client.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=prefix
        ):
            keys += [item["Key"] for item in page.get("Contents", [])]
        return keys

    def names(self) -> list[str]:
        found = set()
        for key in self._objects(self.prefix + BACKUP_PREFIX):
            name, _, filename = key[len(self.prefix) :].partition("/")
            if filename == MANIFEST:
                found.add(name)
        return sorted(found)

    def fetch(self, name: str, workdir: Path) -> Path:
        folder = workdir / name
        folder.mkdir()
        for key in self._objects(self._key(name, "")):
            filename = key.rsplit("/", 1)[-1]
            self.client.download_file(self.bucket, key, str(folder / filename))
        return folder

    def remove(self, name: str) -> None:
        keys = self._objects(self._key(name, ""))
        for start in range(0, len(keys), 1000):
            self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in keys[start : start + 1000]]},
            )


def backup_target() -> LocalTarget | S3Target:
    """The configured BACKUP_TARGET."""
    target = settings.backup_target.strip()
    if not target:
        raise BackupError("Set BACKUP_TARGET to a directory or s3://bucket/prefix")
    if target.startswith("s3://"):
        bucket, _, prefix = target.removeprefix("s3://").partition("/")
        return S3Target(bucket, prefix)
    return LocalTarget(Path(target))


# --- age encryption and helper processes -----------------------------------------------------


def age_recipients() -> list[pyrage.x25519.Recipient]:
    """The AGE_RECIPIENTS public keys backups are encrypted to."""
    keys = [key for key in re.split(r"[\s,]+", settings.age_recipients) if key]
    if not keys:
        raise BackupError("Set AGE_RECIPIENTS to at least one age public key (age1...)")
    try:
        return [pyrage.x25519.Recipient.from_str(key) for key in keys]
    except pyrage.RecipientError as exc:
        raise BackupError("AGE_RECIPIENTS holds something that isn't an age public key") from exc


def age_identities(path: str) -> list[pyrage.x25519.Identity]:
    """The private keys in an age identity file (as written by age-keygen); `-` reads it from
    standard input, so the key needn't be mounted into a container."""
    if not path:
        raise BackupError("Pass --identity or set AGE_IDENTITY_FILE to the age private key file")
    try:
        lines = (sys.stdin.read() if path == "-" else Path(path).read_text()).splitlines()
    except OSError as exc:
        raise BackupError(f"Couldn't read the age identity file {path}") from exc
    try:
        identities = [
            pyrage.x25519.Identity.from_str(line.strip())
            for line in lines
            if line.strip().startswith("AGE-SECRET-KEY-")
        ]
    except pyrage.IdentityError as exc:
        raise BackupError(f"{path} holds a malformed age private key") from exc
    if not identities:
        raise BackupError(f"{path} has no age private key (AGE-SECRET-KEY-...)")
    return identities


class _HashingWriter(io.RawIOBase):
    """Writes through to a file while hashing and counting what's written."""

    def __init__(self, out: BinaryIO) -> None:
        self.out = out
        self.sha256 = hashlib.sha256()
        self.size = 0

    def writable(self) -> bool:
        return True

    def write(self, data: bytes) -> int:
        self.out.write(data)
        self.sha256.update(data)
        self.size += len(data)
        return len(data)


def _libpq_env(url: URL) -> dict[str, str]:
    """Environment for pg_dump/pg_restore: connection details without a password on argv."""
    env = dict(os.environ)
    values = {
        "PGHOST": url.host,
        "PGPORT": str(url.port) if url.port else None,
        "PGUSER": url.username,
        "PGPASSWORD": url.password if isinstance(url.password, str) else None,
        "PGDATABASE": url.database,
        "PGSSLMODE": url.query.get("sslmode")
        if isinstance(url.query.get("sslmode"), str)
        else None,
    }
    env.update({name: value for name, value in values.items() if value})
    return env


def _failed(tool: str, errors: BinaryIO) -> BackupError:
    errors.seek(0)
    message = redact(errors.read().decode(errors="replace").strip())[-500:]
    return BackupError(f"{tool} failed: {message or 'no output'}")


def _encrypt_output(
    command: list[str], env: dict[str, str], destination: Path, recipients: list[Any]
) -> Archive:
    """Run `command` and age-encrypt its standard output into `destination` as it's produced."""
    with (
        destination.open("wb") as out,
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, env=env) as process,  # noqa: S603
    ):
        writer = _HashingWriter(out)
        pyrage.encrypt_io(process.stdout, writer, recipients)
        if process.wait() != 0:
            raise _failed(command[0], errors)
    return Archive(destination.name, writer.sha256.hexdigest(), writer.size)


def _decrypt_into(
    archive: Path, command: list[str], env: dict[str, str], identities: list[Any]
) -> None:
    """age-decrypt `archive` straight into the standard input of `command`."""
    with (
        archive.open("rb") as sealed,
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(command, stdin=subprocess.PIPE, stderr=errors, env=env) as process,  # noqa: S603
    ):
        assert process.stdin is not None
        try:
            pyrage.decrypt_io(sealed, process.stdin, identities)
        except pyrage.DecryptError as exc:
            raise BackupError(f"Couldn't decrypt {archive.name} with the age identity") from exc
        except BrokenPipeError:
            pass  # the command stopped reading; its exit status says why
        finally:
            process.stdin.close()
        if process.wait() != 0:
            raise _failed(command[0], errors)


# --- backup ----------------------------------------------------------------------------------


def create_backup(now: datetime | None = None) -> BackupResult:
    """Write an encrypted backup to BACKUP_TARGET and prune old ones beyond the retention."""
    target = backup_target()
    recipients = age_recipients()
    now = now or utcnow()
    name = f"{BACKUP_PREFIX}{now:%Y%m%dT%H%M%S%fZ}"
    folder = target.staging(name)
    try:
        archives, row_counts, revision = _dump_database(folder, recipients)
        if settings.storage_backend == "local":
            archives.append(_archive_files(folder, recipients))
        manifest = {
            "format": MANIFEST_FORMAT,
            "name": name,
            "created_at": now.isoformat(),
            "schema_revision": revision,
            "storage_backend": settings.storage_backend,
            "archives": {archive.filename: archive.manifest_entry() for archive in archives},
            "row_counts": row_counts,
        }
        (folder / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True))
        target.publish(name, folder)
    finally:
        if folder.exists():
            shutil.rmtree(folder)
    for old in target.names()[: -settings.backup_retention_count]:
        target.remove(old)
    return BackupResult(name, archives, row_counts)


def _dump_database(
    folder: Path, recipients: list[Any]
) -> tuple[list[Archive], dict[str, int], str]:
    """pg_dump from one exported snapshot, with row counts taken from the same snapshot."""
    with engine.connect() as connection:
        connection = connection.execution_options(isolation_level="REPEATABLE READ")
        with connection.begin():
            snapshot = connection.scalar(text("SELECT pg_export_snapshot()"))
            revision = connection.scalar(text("SELECT version_num FROM alembic_version")) or ""
            row_counts = {
                table.name: connection.scalar(select(func.count()).select_from(table)) or 0
                for table in Base.metadata.sorted_tables
            }
            database = _encrypt_output(
                [
                    "pg_dump",
                    "--format=custom",
                    "--no-owner",
                    "--no-privileges",
                    f"--snapshot={snapshot}",
                ],
                _libpq_env(make_url(settings.sqlalchemy_url)),
                folder / DATABASE_ARCHIVE,
                recipients,
            )
    return [database], row_counts, revision


def _archive_files(folder: Path, recipients: list[Any]) -> Archive:
    """A tar of local file storage (already encrypted per file), age-encrypted again."""
    root = Path(settings.storage_local_path).resolve()
    if not root.is_dir():
        # Nothing uploaded yet. The backup container mounts storage read-only, so the folder
        # can't be created here: archive an empty one instead.
        with tempfile.TemporaryDirectory() as empty:
            return _tar_encrypted(Path(empty), folder, recipients)
    return _tar_encrypted(root, folder, recipients)


def _tar_encrypted(root: Path, folder: Path, recipients: list[Any]) -> Archive:
    return _encrypt_output(
        ["tar", "-c", "-f", "-", "--exclude=*.partial", "-C", str(root), "."],
        dict(os.environ),
        folder / FILES_ARCHIVE,
        recipients,
    )


# --- restore test ----------------------------------------------------------------------------


def restore_test(identity_file: str) -> RestoreReport:
    """Restore the newest backup into a throwaway database and prove it can be read."""
    identities = age_identities(identity_file)
    target = backup_target()
    names = target.names()
    if not names:
        raise BackupError("There are no complete backups in BACKUP_TARGET yet")
    name = names[-1]
    admin_url = make_url(settings.restore_test_database_url or settings.sqlalchemy_url).set(
        drivername="postgresql+psycopg"
    )
    restore_url = admin_url.set(database=f"synari_restore_{secrets.token_hex(4)}")
    with tempfile.TemporaryDirectory(prefix="synari-restore-") as workdir:
        folder = target.fetch(name, Path(workdir))
        manifest = _verified_manifest(folder)
        _create_database(admin_url, restore_url)
        try:
            _decrypt_into(
                folder / DATABASE_ARCHIVE,
                [
                    "pg_restore",
                    "--no-owner",
                    "--no-privileges",
                    "--exit-on-error",
                    "--dbname",
                    restore_url.database or "",
                ],
                _libpq_env(restore_url),
                identities,
            )
            _alembic_check(restore_url)
            restored = create_engine(restore_url, poolclass=NullPool, hide_parameters=True)
            try:
                with Session(restored) as db:
                    rows = _check_row_counts(db, manifest["row_counts"])
                    values = _check_encrypted_columns(db)
                    files = _check_files(db, folder, manifest, identities, Path(workdir))
            finally:
                restored.dispose()
        finally:
            _drop_database(admin_url, restore_url)
    return RestoreReport(name, len(manifest["row_counts"]), rows, values, files)


def _verified_manifest(folder: Path) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads((folder / MANIFEST).read_text())
    if manifest.get("format") != MANIFEST_FORMAT:
        raise BackupError(f"{folder.name} has a manifest format this version can't read")
    for filename, entry in manifest["archives"].items():
        digest = hashlib.sha256()
        with (folder / filename).open("rb") as archive:
            for block in iter(lambda: archive.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != entry["sha256"]:
            raise BackupError(f"{filename} doesn't match its checksum in the manifest")
    return manifest


def _connect_admin(admin_url: URL) -> psycopg.Connection[Any]:
    return psycopg.connect(
        admin_url.set(drivername="postgresql").render_as_string(hide_password=False),
        autocommit=True,
    )


def _create_database(admin_url: URL, restore_url: URL) -> None:
    with _connect_admin(admin_url) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(restore_url.database or ""))
        )


def _drop_database(admin_url: URL, restore_url: URL) -> None:
    with _connect_admin(admin_url) as connection:
        connection.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(
                sql.Identifier(restore_url.database or "")
            )
        )


def _alembic_check(restore_url: URL) -> None:
    """The restored schema matches this version's models and migrations."""
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "check"],
        cwd=BACKEND_ROOT,
        env={**os.environ, "DATABASE_URL": restore_url.render_as_string(hide_password=False)},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        output = redact((result.stdout + result.stderr).strip())[-500:]
        raise BackupError(f"alembic check failed on the restored database: {output}")


def _check_row_counts(db: Session, expected: dict[str, int]) -> int:
    """Every table has exactly the rows the backup's snapshot had; returns the total."""
    actual = {
        table.name: db.scalar(select(func.count()).select_from(table)) or 0
        for table in Base.metadata.sorted_tables
    }
    differing = sorted(name for name in actual if actual[name] != expected.get(name))
    if differing:
        raise BackupError(f"Restored row counts differ from the backup in: {', '.join(differing)}")
    return sum(actual.values())


def _check_encrypted_columns(db: Session) -> int:
    """A sample of every encrypted column decrypts with DATA_ENCRYPTION_KEYS."""
    checked = 0
    for target in encrypted_columns():
        for (sealed,) in db.execute(
            select(target.raw()).where(target.raw().is_not(None)).limit(SAMPLE_VALUES)
        ):
            try:
                target.decrypt(sealed)
            except (EncryptionError, ValueError) as exc:
                raise BackupError(
                    f"{target.name} in the backup can't be decrypted with DATA_ENCRYPTION_KEYS"
                ) from exc
            checked += 1
    return checked


def _check_files(
    db: Session,
    folder: Path,
    manifest: dict[str, Any],
    identities: list[Any],
    workdir: Path,
) -> int:
    """A sample of stored files decrypts to their recorded sizes.

    Local storage is checked from the backup's own file archive; S3 storage from the bucket.
    """
    if FILES_ARCHIVE in manifest["archives"]:
        files_root = workdir / "files"
        files_root.mkdir()
        _decrypt_into(
            folder / FILES_ARCHIVE,
            ["tar", "-x", "-f", "-", "-C", str(files_root)],
            dict(os.environ),
            identities,
        )
        storage = EncryptedStorage(LocalBackend(str(files_root)))
    else:
        storage = get_storage()
    samples = db.execute(
        select(StoredFile.storage_key, StoredFile.wrapped_key, StoredFile.size_bytes)
        .where(StoredFile.wrapped_key.is_not(None))
        .order_by(func.random())
        .limit(SAMPLE_FILES)
    ).all()
    for storage_key, wrapped_key, size_bytes in samples:
        try:
            size = sum(len(chunk) for chunk in storage.stream_with_key(storage_key, wrapped_key))
        except (EncryptionError, OSError) as exc:
            raise BackupError("A stored file in the backup couldn't be decrypted") from exc
        if size != size_bytes:
            raise BackupError("A stored file in the backup isn't the size its record says")
    return len(samples)


# --- health checks (worker) ------------------------------------------------------------------


def check_backup_health(db: Session, now: datetime) -> None:
    """Worker job: raise a security event when backups or restore tests are overdue.

    Only runs when BACKUP_TARGET is set. Alerts at most once a day for each problem.
    """
    if not settings.backup_target.strip():
        return
    # Nothing is overdue before the server holds any practice.
    first_practice = db.scalar(select(func.min(Practice.created_at)))
    if first_practice is None:
        return
    _alert_if_overdue(db, now, first_practice, "backup.completed", "backup.overdue", BACKUP_MAX_AGE)
    _alert_if_overdue(
        db,
        now,
        first_practice,
        "backup.restore_tested",
        "backup.restore_test_overdue",
        RESTORE_TEST_MAX_AGE,
    )
    db.commit()


def _latest(db: Session, kind: str) -> datetime | None:
    return db.scalar(
        select(func.max(SecurityEvent.created_at)).where(
            SecurityEvent.practice_id.is_(None), SecurityEvent.kind == kind
        )
    )


def _alert_if_overdue(
    db: Session,
    now: datetime,
    since: datetime,
    done_kind: str,
    overdue_kind: str,
    max_age: timedelta,
) -> None:
    last_done = _latest(db, done_kind) or since
    if now - last_done < max_age:
        return
    last_alert = _latest(db, overdue_kind)
    if last_alert is not None and now - last_alert < OVERDUE_ALERT_INTERVAL:
        return
    record_security_event(
        db,
        practice_id=None,
        kind=overdue_kind,
        severity=SecuritySeverity.WARNING,
        detail={"hours_since": int((now - last_done).total_seconds() // 3600)},
    )


# --- command line ----------------------------------------------------------------------------


def _say(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _record(kind: str, severity: SecuritySeverity, detail: dict[str, Any]) -> None:
    with SessionLocal() as db:
        record_security_event(db, practice_id=None, kind=kind, severity=severity, detail=detail)
        db.commit()


def run_backup(args: argparse.Namespace) -> int:
    """`admin backup`: write an encrypted backup to BACKUP_TARGET."""
    try:
        result = create_backup()
    except Exception as exc:
        logger.exception("Backup failed")
        _record("backup.failed", SecuritySeverity.CRITICAL, {"error": type(exc).__name__})
        _say(f"Backup failed: {exc}")
        return 1
    size = sum(archive.size_bytes for archive in result.archives)
    _record(
        "backup.completed",
        SecuritySeverity.INFO,
        {
            "backup": result.name,
            "bytes": size,
            "tables": len(result.row_counts),
            "rows": sum(result.row_counts.values()),
        },
    )
    _say(f"Backup {result.name} written ({size} bytes)")
    return 0


def add_restore_test_arguments(parser: argparse.ArgumentParser) -> None:
    """Options for `admin restore-test`."""
    parser.add_argument(
        "--identity",
        default=settings.age_identity_file,
        help="age private key file matching AGE_RECIPIENTS, or - to read it from standard input "
        "(default: AGE_IDENTITY_FILE)",
    )


def run_restore_test(args: argparse.Namespace) -> int:
    """`admin restore-test`: restore the newest backup into a throwaway database and check it."""
    try:
        report = restore_test(args.identity)
    except Exception as exc:
        logger.exception("Restore test failed")
        _record(
            "backup.restore_test_failed", SecuritySeverity.CRITICAL, {"error": type(exc).__name__}
        )
        _say(f"Restore test failed: {exc}")
        return 1
    _record(
        "backup.restore_tested",
        SecuritySeverity.INFO,
        {
            "backup": report.name,
            "tables": report.tables,
            "rows": report.rows,
            "encrypted_values": report.encrypted_values,
            "files": report.files,
        },
    )
    _say(
        f"Restore test of {report.name} passed: {report.tables} tables, {report.rows} rows, "
        f"{report.encrypted_values} encrypted values and {report.files} files decrypted"
    )
    return 0
