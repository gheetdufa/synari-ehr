"""Importing a practice from SimplePractice: upload the exports, review the analysis, import.

A job moves uploaded -> analyzing -> ready (the practice reviews the preview and decides on
possible matches, clinicians and options) -> importing -> completed, or failed / canceled. The
worker does the analysis and the import (services/imports/jobs.py); these routes manage the
files and choices. Only staff who manage the practice can import.
"""

import zipfile
from datetime import timedelta
from typing import Any

import pyzipper
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from synari.access import Access
from synari.audit import audit_staff, audit_staff_throttled
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import ImportJob, StaffMember, StoredFile
from synari.models.enums import ImportFileKind, ImportStatus, StaffStatus
from synari.permissions import Capability
from synari.schemas.imports import (
    ImportFieldInfo,
    ImportFileOut,
    ImportJobOut,
    ImportJobSummary,
    ImportJobUpdate,
    ImportKindInfo,
    ImportOptions,
    ImportOptionsOut,
    ImportPreview,
    ImportResult,
)
from synari.services.imports import ImportFailed
from synari.services.imports.fields import KINDS, auto_mapping, detect_kind
from synari.services.imports.jobs import job_options
from synari.services.imports.plan import ClinicianRef, clinician_choices
from synari.services.imports.runner import publish_progress
from synari.services.imports.sources import (
    clear_work_dir,
    delete_source,
    extension_of,
    set_zip_password,
    store_source,
)
from synari.services.imports.tables import read_headers

router = APIRouter(prefix="/imports", tags=["imports"])

EDITABLE = (ImportStatus.UPLOADED, ImportStatus.READY, ImportStatus.FAILED)
FINAL = (ImportStatus.COMPLETED, ImportStatus.CANCELED)
VIEW_AUDIT_WINDOW = timedelta(minutes=10)


def _require(access: Access) -> None:
    access.require(
        Capability.MANAGE_PRACTICE, "Only staff who manage the practice can import records"
    )


def _job(access: Access, import_id: int) -> ImportJob:
    _require(access)
    return access.get(ImportJob, import_id, label="Import")


def _require_editable(job: ImportJob) -> None:
    if job.status == ImportStatus.ANALYZING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Wait for the analysis to finish")
    if job.status not in EDITABLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"This import is {job.status}")


def _summary(job: ImportJob) -> ImportJobSummary:
    return ImportJobSummary(
        id=job.id,
        source=job.source,
        status=ImportStatus(job.status),
        created_by_id=job.created_by_id,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        file_count=len(job.files or []),
    )


def _out(job: ImportJob) -> ImportJobOut:
    return ImportJobOut(
        **_summary(job).model_dump(),
        files=[ImportFileOut.model_validate(entry) for entry in job.files or []],
        mapping=job.mapping or {},
        options=ImportOptionsOut(
            **job_options(job).model_dump(),
            zip_password_set=bool((job.options or {}).get("zip_password")),
        ),
        preview=ImportPreview.model_validate(job.preview) if job.preview else None,
        result=ImportResult.model_validate(job.result) if job.result else None,
        error=job.error,
    )


def _needs_analysis(job: ImportJob) -> None:
    """Files or mapping changed: the preview no longer applies."""
    job.status = ImportStatus.UPLOADED
    job.preview = {}
    job.error = ""


def _entry(job: ImportJob, file_id: int) -> dict[str, Any]:
    entry = next((e for e in job.files or [] if e["file_id"] == file_id), None)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return entry


def _check_kind(filename: str, kind: ImportFileKind) -> None:
    is_zip = filename.lower().endswith(".zip")
    if is_zip != (kind == ImportFileKind.EXPORT_ZIP):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Only a .zip can be the Complete export, and a .zip can't be a report",
        )


def _zip_details(upload: UploadFile) -> bool:
    """Whether the uploaded zip is readable (422 if not) and password protected."""
    upload.file.seek(0)
    try:
        with pyzipper.AESZipFile(upload.file) as archive:
            encrypted = any(info.flag_bits & 0x1 for info in archive.infolist())
    except (zipfile.BadZipFile, pyzipper.BadZipFile, OSError) as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "This file isn't a complete zip archive. Download the export from SimplePractice "
            "again and upload it as is.",
        ) from exc
    finally:
        upload.file.seek(0)
    return encrypted


@router.get("/kinds", response_model=list[ImportKindInfo])
def list_kinds(access: CurrentAccess) -> list[ImportKindInfo]:
    """The files the importer accepts, where to find them and the columns it reads."""
    _require(access)
    return [
        ImportKindInfo(
            kind=definition.kind,
            label=definition.label,
            description=definition.description,
            extensions=list(definition.extensions),
            fields=[
                ImportFieldInfo(name=f.name, label=f.label, required=f.required)
                for f in definition.fields
                if f.imported
            ],
        )
        for definition in KINDS.values()
    ]


@router.post("", response_model=ImportJobOut, status_code=status.HTTP_201_CREATED)
def create_import(access: CurrentAccess, db: DbSession, request: Request) -> ImportJobOut:
    """Start a new import from SimplePractice."""
    _require(access)
    job = ImportJob(
        practice_id=access.practice_id,
        created_by_id=access.staff.id,
        status=ImportStatus.UPLOADED,
        files=[],
        mapping={},
        preview={},
        options={},
        result={},
    )
    db.add(job)
    db.flush()
    audit_staff(db, request, access.staff, "import.create", "import", job.id)
    db.commit()
    return _out(job)


@router.get("", response_model=list[ImportJobSummary])
def list_imports(access: CurrentAccess, db: DbSession) -> list[ImportJobSummary]:
    """The practice's imports, newest first."""
    _require(access)
    jobs = db.scalars(
        select(ImportJob)
        .where(ImportJob.practice_id == access.practice_id)
        .order_by(ImportJob.created_at.desc(), ImportJob.id.desc())
    )
    return [_summary(job) for job in jobs]


@router.get("/{import_id}", response_model=ImportJobOut)
def get_import(
    import_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """An import with its files, mapping, preview (client names for matching) and result."""
    job = _job(access, import_id)
    audit_staff_throttled(
        db, request, access.staff, "import.view", "import", job.id, window=VIEW_AUDIT_WINDOW
    )
    db.commit()
    return _out(job)


@router.post("/{import_id}/files", response_model=ImportJobOut, status_code=status.HTTP_201_CREATED)
def upload_import_file(
    import_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    file: UploadFile = File(...),
    kind: ImportFileKind | None = Form(default=None),
) -> ImportJobOut:
    """Add a SimplePractice export or report; its kind is detected from its headings."""
    job = _job(access, import_id)
    _require_editable(job)
    filename = file.filename or "file"
    extension_of(filename)
    if kind is not None:
        _check_kind(filename, kind)
    is_zip = filename.lower().endswith(".zip")
    if is_zip and any(e.get("kind") == ImportFileKind.EXPORT_ZIP for e in job.files or []):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This import already has an export zip. Remove it first, or run another import "
            "for a second export.",
        )
    headers: list[str] = []
    encrypted = False
    detected: ImportFileKind | None = None
    if is_zip:
        encrypted = _zip_details(file)
        detected = ImportFileKind.EXPORT_ZIP
    else:
        try:
            headers = read_headers(file.file, filename)
        except ImportFailed as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
        detected = detect_kind(headers)
    stored = store_source(
        db, file.file, filename, practice_id=access.practice_id, staff_id=access.staff.id
    )
    chosen = kind or detected
    job.files = [
        *(job.files or []),
        {
            "file_id": stored.id,
            "kind": chosen,
            "detected_kind": detected,
            "filename": stored.filename,
            "size_bytes": stored.size_bytes,
            "headers": headers,
            "encrypted": encrypted,
        },
    ]
    if chosen is not None and not is_zip:
        job.mapping = {**(job.mapping or {}), str(stored.id): auto_mapping(chosen, headers)}
    _needs_analysis(job)
    audit_staff(
        db,
        request,
        access.staff,
        "import.upload",
        "import",
        job.id,
        {"file_id": stored.id, "kind": chosen, "size_bytes": stored.size_bytes},
    )
    publish_progress(db, job)
    db.commit()
    return _out(job)


@router.delete("/{import_id}/files/{file_id}", response_model=ImportJobOut)
def remove_import_file(
    import_id: int, file_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """Remove an uploaded file from an import that hasn't started."""
    job = _job(access, import_id)
    _require_editable(job)
    _entry(job, file_id)
    stored = db.get(StoredFile, file_id)
    if stored is not None and stored.practice_id == job.practice_id:
        delete_source(db, stored)
    job.files = [e for e in job.files if e["file_id"] != file_id]
    job.mapping = {k: v for k, v in (job.mapping or {}).items() if k != str(file_id)}
    _needs_analysis(job)
    clear_work_dir(job.id)
    audit_staff(
        db, request, access.staff, "import.remove_file", "import", job.id, {"file_id": file_id}
    )
    publish_progress(db, job)
    db.commit()
    return _out(job)


def _apply_kinds(job: ImportJob, body: ImportJobUpdate) -> None:
    files = [dict(entry) for entry in job.files or []]
    mapping = dict(job.mapping or {})
    for update in body.files or []:
        entry = next((e for e in files if e["file_id"] == update.file_id), None)
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
        _check_kind(entry["filename"], update.kind)
        if entry.get("kind") != update.kind:
            entry["kind"] = update.kind
            if update.kind != ImportFileKind.EXPORT_ZIP:
                mapping[str(update.file_id)] = auto_mapping(update.kind, entry.get("headers", []))
    job.files = files
    job.mapping = mapping


def _apply_mapping(job: ImportJob, submitted: dict[str, dict[str, str | None]]) -> None:
    mapping = dict(job.mapping or {})
    for file_key, fields in submitted.items():
        entry = next((e for e in job.files or [] if str(e["file_id"]) == file_key), None)
        if entry is None or not entry.get("kind") or entry["kind"] == ImportFileKind.EXPORT_ZIP:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Columns can only be mapped for reports"
            )
        known = {f.name for f in KINDS[ImportFileKind(entry["kind"])].fields if f.imported}
        headers = set(entry.get("headers", []))
        current = dict(mapping.get(file_key) or {})
        for field_name, header in fields.items():
            if field_name not in known:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown column {field_name}"
                )
            if header is not None and header not in headers:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    f"{entry['filename']} has no column named {header}",
                )
            current[field_name] = header
        mapping[file_key] = current
    job.mapping = mapping


def _check_clinician(access: Access, staff_id: int | None) -> None:
    if staff_id is None:
        return
    staff = access.db.get(StaffMember, staff_id)
    if (
        staff is None
        or staff.practice_id != access.practice_id
        or not staff.is_clinician
        or staff.status not in (StaffStatus.ACTIVE, StaffStatus.INVITED)
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a clinician on your team"
        )


def _check_options(access: Access, options: ImportOptions) -> None:
    _check_clinician(access, options.default_clinician_id)
    emails: set[str] = set()
    for choice in options.clinicians.values():
        _check_clinician(access, choice.staff_id)
        if choice.invite is None:
            continue
        access.require(Capability.MANAGE_TEAM, "Only staff who manage the team can invite")
        email = str(choice.invite.email)
        if email in emails:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Invite each new clinician only once"
            )
        emails.add(email)
        taken = access.db.scalar(select(StaffMember.id).where(StaffMember.email == email))
        if taken is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{email} already has an account; choose that clinician instead",
            )


@router.patch("/{import_id}", response_model=ImportJobOut)
def update_import(
    import_id: int, body: ImportJobUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """Correct file kinds or column mapping, set the zip password, or change the options."""
    job = _job(access, import_id)
    _require_editable(job)
    changed = sorted(body.model_fields_set)
    if body.files is not None:
        _apply_kinds(job, body)
    if body.mapping is not None:
        _apply_mapping(job, body.mapping)
    if body.options is not None:
        _check_options(access, body.options)
        stored_password = (job.options or {}).get("zip_password")
        options = body.options.model_dump(mode="json")
        job.options = {**options, "zip_password": stored_password} if stored_password else options
    if body.zip_password is not None:
        set_zip_password(job, body.zip_password)
    if {"files", "mapping", "zip_password"} & set(changed):
        _needs_analysis(job)
        clear_work_dir(job.id)
    audit_staff(db, request, access.staff, "import.update", "import", job.id, {"changed": changed})
    publish_progress(db, job)
    db.commit()
    return _out(job)


@router.post(
    "/{import_id}/analyze", response_model=ImportJobOut, status_code=status.HTTP_202_ACCEPTED
)
def analyze_import(
    import_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """Queue the files for analysis (the worker builds the preview)."""
    job = _job(access, import_id)
    _require_editable(job)
    if not job.files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload at least one file first")
    unknown = [e["filename"] for e in job.files if not e.get("kind")]
    if unknown:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Choose what kind of file {', '.join(unknown)} is"
        )
    job.status = ImportStatus.ANALYZING
    job.error = ""
    audit_staff(db, request, access.staff, "import.analyze", "import", job.id)
    publish_progress(db, job)
    db.commit()
    return _out(job)


def _unassigned_clinicians(access: Access, job: ImportJob, options: ImportOptions) -> list[str]:
    preview = ImportPreview.model_validate(job.preview)
    refs = {c.key: ClinicianRef(c.key, c.name) for c in preview.clinicians if c.key}
    choices = clinician_choices(access.db, access.practice_id, refs, options)
    return [
        clinician.name
        for clinician in preview.clinicians
        if choices[clinician.key].staff_id is None and choices[clinician.key].invite is None
    ]


@router.post(
    "/{import_id}/start", response_model=ImportJobOut, status_code=status.HTTP_202_ACCEPTED
)
def start_import(
    import_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """Import everything the preview describes, with the practice's choices."""
    job = _job(access, import_id)
    retry = job.status == ImportStatus.FAILED and job.started_at is not None and bool(job.preview)
    if job.status != ImportStatus.READY and not retry:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Analyze the files and review the preview before importing"
        )
    running = db.scalar(
        select(ImportJob.id).where(
            ImportJob.practice_id == job.practice_id,
            ImportJob.status == ImportStatus.IMPORTING,
            ImportJob.id != job.id,
        )
    )
    if running is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Another import is running; wait for it to finish"
        )
    options = job_options(job)
    unassigned = _unassigned_clinicians(access, job, options)
    if unassigned and options.default_clinician_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Choose who becomes {', '.join(unassigned)} in Synari, or a default clinician",
        )
    job.status = ImportStatus.IMPORTING
    job.error = ""
    if not retry:
        job.started_at = utcnow()
        job.result = {}
    audit_staff(db, request, access.staff, "import.start", "import", job.id, {"retry": retry})
    publish_progress(db, job)
    db.commit()
    return _out(job)


@router.post("/{import_id}/cancel", response_model=ImportJobOut)
def cancel_import(
    import_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ImportJobOut:
    """Stop an import (records already created stay) and delete its uploaded files."""
    job = _job(access, import_id)
    if job.status in FINAL:
        raise HTTPException(status.HTTP_409_CONFLICT, f"This import is {job.status}")
    job = db.scalars(
        select(ImportJob)
        .where(ImportJob.id == job.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one()
    for entry in job.files or []:
        stored = db.get(StoredFile, entry["file_id"])
        if stored is not None and stored.practice_id == job.practice_id:
            delete_source(db, stored)
    set_zip_password(job, "")
    job.status = ImportStatus.CANCELED
    job.finished_at = utcnow()
    audit_staff(db, request, access.staff, "import.cancel", "import", job.id)
    publish_progress(db, job)
    db.commit()
    clear_work_dir(job.id)
    return _out(job)
