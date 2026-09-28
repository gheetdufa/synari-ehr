"""The files uploaded for an import: streamed to storage, copied to a local working file when
the worker needs them, and deleted when the import is over.

Exports can be hundreds of megabytes, so an upload is never held in memory: it is streamed from
the request's temporary file into (encrypted) storage a chunk at a time, and back out the same
way. IMPORT_MAX_BYTES caps its size.
"""

import io
import secrets
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from botocore.exceptions import ClientError
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from synari.config import settings
from synari.crypto import EncryptionError, decrypt, encrypt
from synari.models import ImportJob, StoredFile
from synari.models.enums import FilePurpose, Role
from synari.services.imports import ImportFailed
from synari.services.imports.fields import SPREADSHEET_EXTENSIONS, ZIP_EXTENSIONS
from synari.services.storage import get_storage

CONTENT_TYPES = {
    ".zip": "application/zip",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
_PASSWORD_CONTEXT = "import_jobs.zip_password"
_WORK_ROOT = "synari-imports"


def safe_filename(filename: str) -> str:
    """The file's own name without folders or characters that don't belong in a name."""
    name = PurePosixPath(filename.replace("\\", "/")).name.strip() or "file"
    return "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*')[:200] or "file"


def extension_of(filename: str) -> str:
    """The lower-case extension if the importer accepts it; 415 otherwise."""
    extension = PurePosixPath(filename).suffix.lower()
    if extension == ".xls":
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Old Excel files (.xls) aren't supported; download the report as .xlsx or CSV",
        )
    if extension not in (*ZIP_EXTENSIONS, *SPREADSHEET_EXTENSIONS):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "Upload the SimplePractice export (.zip) or reports as .csv or .xlsx",
        )
    return extension


def store_source(
    db: Session, upload: BinaryIO, filename: str, *, practice_id: int, staff_id: int
) -> StoredFile:
    """Stream an upload to storage and add its StoredFile row (caller commits)."""
    extension = extension_of(filename)
    key = f"practices/{practice_id}/{FilePurpose.IMPORT_SOURCE}/{secrets.token_hex(16)}{extension}"
    upload.seek(0, io.SEEK_END)
    size = upload.tell()
    if size > settings.import_max_bytes:
        limit_mb = settings.import_max_bytes // (1024 * 1024)
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE, f"Import files must be under {limit_mb:,} MB"
        )
    if size == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The file is empty")
    upload.seek(0)
    size = get_storage().save_stream(key, upload, CONTENT_TYPES[extension])
    stored = StoredFile(
        practice_id=practice_id,
        client_id=None,
        purpose=FilePurpose.IMPORT_SOURCE,
        filename=safe_filename(filename),
        content_type=CONTENT_TYPES[extension],
        size_bytes=size,
        storage_key=key,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=staff_id,
    )
    db.add(stored)
    db.flush()
    return stored


def delete_source(db: Session, stored: StoredFile) -> None:
    """Remove an uploaded file and its row (caller commits)."""
    get_storage().delete(stored.storage_key)
    db.delete(stored)


def work_dir(job_id: int) -> Path:
    """This process's scratch folder for a job's files."""
    return Path(tempfile.gettempdir()) / _WORK_ROOT / f"job-{job_id}"


def local_copy(job_id: int, stored: StoredFile) -> Path:
    """A local file with the upload's (decrypted) bytes, copied from storage once per process."""
    folder = work_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / PurePosixPath(stored.storage_key).name
    if path.exists() and path.stat().st_size == stored.size_bytes:
        return path
    partial = path.with_suffix(".partial")
    try:
        with partial.open("wb") as out:
            for chunk in get_storage().stream_with_key(stored.storage_key, stored.wrapped_key):
                out.write(chunk)
    except EncryptionError as exc:
        partial.unlink(missing_ok=True)
        raise ImportFailed(f"{stored.filename} is damaged in storage; upload it again") from exc
    except (OSError, KeyError, ClientError) as exc:
        partial.unlink(missing_ok=True)
        raise ImportFailed(f"{stored.filename} is missing from storage; upload it again") from exc
    if partial.stat().st_size != stored.size_bytes:
        partial.unlink(missing_ok=True)
        raise ImportFailed(f"{stored.filename} is incomplete in storage; upload it again")
    partial.replace(path)
    return path


def clear_work_dir(job_id: int) -> None:
    """Delete this process's local copies of a job's files."""
    shutil.rmtree(work_dir(job_id), ignore_errors=True)


def set_zip_password(job: ImportJob, password: str) -> None:
    """Keep the export's password encrypted in the job's options ("" forgets it)."""
    options = {k: v for k, v in job.options.items() if k != "zip_password"}
    if password:
        options["zip_password"] = encrypt(password, _PASSWORD_CONTEXT)
    job.options = options


def zip_password(job: ImportJob) -> str:
    stored = job.options.get("zip_password")
    return decrypt(stored, _PASSWORD_CONTEXT) if stored else ""
