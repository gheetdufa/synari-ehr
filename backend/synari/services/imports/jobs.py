"""Worker jobs: analyze uploaded SimplePractice files and run imports.

A job the practice queues (status analyzing or importing) is picked up by one worker at a
time: the worker holds a Postgres advisory lock on it while working, so a worker that dies
releases it at once and the next pass carries on. Imports run in time slices so the other
worker jobs (reminders, emails) keep flowing; each slice resumes from the ImportRecords the
previous one committed.
"""

import logging
import time as clock
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.db import engine, utcnow
from synari.models import ImportJob, Practice, StoredFile
from synari.models.enums import ImportFileKind, ImportStatus, Role
from synari.schemas.imports import ImportOptions, ImportResult
from synari.services.billing import audit_system
from synari.services.imports import ImportFailed
from synari.services.imports.archive import ExportArchive
from synari.services.imports.fields import auto_mapping
from synari.services.imports.plan import Plan, SheetInput, build_plan
from synari.services.imports.runner import Runner, publish_progress, today_in
from synari.services.imports.sources import (
    clear_work_dir,
    delete_source,
    local_copy,
    set_zip_password,
    work_dir,
    zip_password,
)
from synari.services.imports.tables import read_table
from synari.services.notifications import notify

logger = logging.getLogger(__name__)

# Advisory lock namespace for import jobs (the second key is the job id).
LOCK_NAMESPACE = 7201
SLICE_SECONDS = 45
MAX_ERROR_CHARS = 500
UNEXPECTED = "Something went wrong while reading the files. Try again, or contact support."
FINAL_STATUSES = (ImportStatus.COMPLETED, ImportStatus.FAILED, ImportStatus.CANCELED)


def job_options(job: ImportJob) -> ImportOptions:
    """The job's options without its stored zip password."""
    return ImportOptions.model_validate(
        {k: v for k, v in (job.options or {}).items() if k != "zip_password"}
    )


def import_link(job: ImportJob) -> str:
    return f"/portal/settings?tab=import&import={job.id}"


@contextmanager
def _job_lock(job_id: int) -> Iterator[bool]:
    """Hold the job's advisory lock on a connection of its own for the duration."""
    with engine.connect() as connection:
        locked = bool(connection.scalar(select(func.pg_try_advisory_lock(LOCK_NAMESPACE, job_id))))
        try:
            yield locked
        finally:
            if locked:
                connection.scalar(select(func.pg_advisory_unlock(LOCK_NAMESPACE, job_id)))
            connection.commit()


@contextmanager
def open_inputs(
    db: Session, job: ImportJob
) -> Iterator[tuple[list[SheetInput], ExportArchive | None]]:
    """The job's spreadsheets (read) and its export zip (opened), from local copies."""
    if not job.files:
        raise ImportFailed("Upload at least one file to import")
    sheets: list[SheetInput] = []
    archive: ExportArchive | None = None
    try:
        for entry in job.files:
            filename = entry["filename"]
            if not entry.get("kind"):
                raise ImportFailed(f"Choose what kind of file {filename} is")
            stored = db.get(StoredFile, entry["file_id"])
            if stored is None or stored.practice_id != job.practice_id:
                raise ImportFailed(f"{filename} is missing; upload it again")
            path = local_copy(job.id, stored)
            kind = ImportFileKind(entry["kind"])
            if kind == ImportFileKind.EXPORT_ZIP:
                archive = ExportArchive(path, zip_password(job))
                continue
            table = read_table(path, filename)
            mapping = (job.mapping or {}).get(str(stored.id)) or auto_mapping(kind, table.headers)
            sheets.append(SheetInput(stored.id, kind, filename, table, mapping))
        yield sheets, archive
    finally:
        if archive is not None:
            archive.close()


def plan_for(
    db: Session, job: ImportJob, sheets: list[SheetInput], archive: ExportArchive | None
) -> Plan:
    """Match the job's files with its current options."""
    return build_plan(
        db,
        job.practice_id,
        sheets,
        archive,
        job_options(job),
        today_in(db.get_one(Practice, job.practice_id)),
    )


def _locked_job(db: Session, job_id: int) -> ImportJob | None:
    return db.scalars(
        select(ImportJob)
        .where(ImportJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()


def _audit(db: Session, job: ImportJob, action: str, detail: dict[str, object]) -> None:
    audit_system(
        db,
        job.practice_id,
        action,
        "import",
        job.id,
        {"started_by": job.created_by_id, **detail},
    )


def _fail(db: Session, job_id: int, message: str) -> None:
    db.rollback()
    job = _locked_job(db, job_id)
    if job is None or job.status not in (ImportStatus.ANALYZING, ImportStatus.IMPORTING):
        db.rollback()
        return
    importing = job.status == ImportStatus.IMPORTING
    job.status = ImportStatus.FAILED
    job.error = message[:MAX_ERROR_CHARS]
    _audit(db, job, "import.failed", {"phase": "import" if importing else "analysis"})
    if importing:
        notify(
            db,
            Role.STAFF,
            job.created_by_id,
            kind="import_failed",
            title="Your SimplePractice import stopped with a problem",
            link=import_link(job),
        )
    publish_progress(db, job)
    db.commit()
    clear_work_dir(job_id)


def _sweep_work_dirs(db: Session) -> None:
    """Delete local copies left by jobs that are over (e.g. finished by another worker)."""
    root = work_dir(0).parent
    if not root.exists():
        return
    ids = {
        int(path.name.removeprefix("job-")): path
        for path in root.iterdir()
        if path.name.startswith("job-") and path.name.removeprefix("job-").isdigit()
    }
    if not ids:
        return
    active = set(
        db.scalars(
            select(ImportJob.id).where(
                ImportJob.id.in_(ids), ImportJob.status.not_in(FINAL_STATUSES)
            )
        )
    )
    for job_id in ids.keys() - active:
        clear_work_dir(job_id)


# Analysis --------------------------------------------------------------------------------------


def _analyze(db: Session, job_id: int) -> None:
    job = db.get(ImportJob, job_id)
    if job is None or job.status != ImportStatus.ANALYZING:
        return
    try:
        with open_inputs(db, job) as (sheets, archive):
            plan = plan_for(db, job, sheets, archive)
    except ImportFailed as exc:
        _fail(db, job_id, str(exc))
        return
    except Exception:
        logger.exception("Analyzing import %s failed", job_id)
        _fail(db, job_id, UNEXPECTED)
        return
    job = _locked_job(db, job_id)
    if job is None or job.status != ImportStatus.ANALYZING:
        db.rollback()  # changed or canceled while we worked
        return
    job.preview = plan.preview.model_dump(mode="json")
    job.status = ImportStatus.READY
    job.error = ""
    counts = plan.preview.counts
    _audit(
        db,
        job,
        "import.analyzed",
        {
            "clients": counts.clients_new + counts.clients_existing,
            "appointments": counts.appointments,
            "documents": counts.documents,
            "balances": counts.balances,
        },
    )
    publish_progress(db, job)
    db.commit()


def analyze_imports(db: Session, now: datetime) -> None:
    """Worker job: analyze the uploaded files of jobs waiting for it."""
    _sweep_work_dirs(db)
    queued = db.scalars(
        select(ImportJob.id)
        .where(ImportJob.status == ImportStatus.ANALYZING)
        .order_by(ImportJob.id)
    ).all()
    db.commit()
    for job_id in queued:
        with _job_lock(job_id) as locked:
            if locked:
                _analyze(db, job_id)


# Importing -------------------------------------------------------------------------------------


def _finish(db: Session, job_id: int, runner: Runner) -> None:
    runner.save_progress()
    db.commit()
    job = _locked_job(db, job_id)
    if job is None or job.status != ImportStatus.IMPORTING:
        db.commit()
        return
    for entry in job.files:
        stored = db.get(StoredFile, entry["file_id"])
        if stored is not None and stored.practice_id == job.practice_id:
            delete_source(db, stored)
    set_zip_password(job, "")
    result = ImportResult.model_validate(job.result or {})
    result.phase = "done"
    job.result = result.model_dump(mode="json")
    job.status = ImportStatus.COMPLETED
    job.finished_at = utcnow()
    _audit(
        db,
        job,
        "import.completed",
        {"created": result.created, "updated": result.updated, "skipped": result.skipped},
    )
    notify(
        db,
        Role.STAFF,
        job.created_by_id,
        kind="import_completed",
        title="Your SimplePractice import finished",
        link=import_link(job),
    )
    publish_progress(db, job)
    db.commit()
    clear_work_dir(job_id)


def _import_slice(db: Session, job_id: int, deadline: float) -> None:
    job = db.get(ImportJob, job_id)
    if job is None or job.status != ImportStatus.IMPORTING:
        return
    try:
        with open_inputs(db, job) as (sheets, archive):
            plan = plan_for(db, job, sheets, archive)
            runner = Runner(db, job, plan, archive, job_options(job), deadline)
            finished = runner.run()
            if finished:
                _finish(db, job_id, runner)
                return
            runner.save_progress()
            db.commit()
    except ImportFailed as exc:
        _fail(db, job_id, str(exc))
        return
    except Exception:
        logger.exception("Import %s failed", job_id)
        _fail(db, job_id, "Something went wrong while importing. Start it again to continue.")
        return
    db.refresh(job, attribute_names=["status"])
    if job.status == ImportStatus.CANCELED:
        clear_work_dir(job_id)


def run_imports(db: Session, now: datetime) -> None:
    """Worker job: continue imports the practice started, for up to SLICE_SECONDS a pass."""
    deadline = clock.monotonic() + SLICE_SECONDS
    queued = db.scalars(
        select(ImportJob.id)
        .where(ImportJob.status == ImportStatus.IMPORTING)
        .order_by(ImportJob.id)
    ).all()
    db.commit()
    for job_id in queued:
        with _job_lock(job_id) as locked:
            if locked:
                _import_slice(db, job_id, deadline)
        if clock.monotonic() >= deadline:
            return
