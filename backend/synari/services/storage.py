"""Encrypted file storage on local disk or any S3-compatible bucket, plus upload validation.

Every file is encrypted with its own key before it reaches the backend (see
services/file_encryption.py), and callers never handle keys:

- `store_upload()` validates an upload, saves it and adds its StoredFile row.
- `get_storage().save(key, data, content_type)` (or `.save_stream(...)` for large files)
  encrypts and writes bytes. Save the bytes first, then add the StoredFile row for that key in
  the same process: the row picks up the file's wrapped key when it's inserted.
- `file_response(stored)` and `get_storage().read(key)` / `.stream(key)` decrypt.
- `get_storage().delete(key)` removes the bytes. A StoredFile whose wrapped_key is cleared (or
  whose row is deleted) can never be decrypted again, even from backups.
"""

import io
import os
import secrets
import threading
from collections.abc import Iterable, Iterator
from functools import cache
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Protocol, cast

import boto3
from fastapi import HTTPException, UploadFile, status
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import event, select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Mapper, Session

from synari.config import settings
from synari.db import SessionLocal
from synari.models import StoredFile
from synari.models.enums import FilePurpose
from synari.services.file_encryption import (
    chunks_of,
    new_file_key,
    open_sealed,
    seal,
    unwrap_file_key,
)

# Extension -> content type. The browser-declared type is never trusted.
ALLOWED_TYPES: dict[str, str] = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".webm", ".ogg"}
# Backends only ever hold ciphertext.
SEALED_CONTENT_TYPE = "application/octet-stream"
# Downloads up to this size are decrypted in full before the response starts.
BUFFERED_DOWNLOAD_BYTES = 16 * 1024 * 1024


class Backend(Protocol):
    """Where encrypted bytes are kept, by storage key."""

    def write(self, key: str, chunks: Iterable[bytes]) -> None: ...
    def open(self, key: str) -> BinaryIO: ...
    def delete(self, key: str) -> None: ...


class LocalBackend:
    """Files under a directory; keys are relative POSIX paths. Writes are atomic."""

    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        """Where `key` lives on disk (refuses keys that escape the root)."""
        path = (self.root / PurePosixPath(key)).resolve()
        if self.root not in path.parents:
            raise ValueError("Invalid storage key")
        return path

    def write(self, key: str, chunks: Iterable[bytes]) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(f".{path.name}.{secrets.token_hex(4)}.partial")
        try:
            with partial.open("wb") as out:
                for chunk in chunks:
                    out.write(chunk)
            os.replace(partial, path)
        finally:
            partial.unlink(missing_ok=True)

    def open(self, key: str) -> BinaryIO:
        return self._path(key).open("rb")

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class _ChunkReader(io.RawIOBase):
    """A read-only file object over an iterator of byte chunks (for boto3 uploads)."""

    def __init__(self, chunks: Iterable[bytes]) -> None:
        self._chunks = iter(chunks)
        self._pending = b""

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: memoryview) -> int:
        while not self._pending:
            chunk = next(self._chunks, None)
            if chunk is None:
                return 0
            self._pending = chunk
        size = min(len(buffer), len(self._pending))
        buffer[:size] = self._pending[:size]
        self._pending = self._pending[size:]
        return size


def s3_client() -> Any:
    """A client for the configured S3-compatible service (S3_* settings)."""
    return boto3.client(
        "s3",
        region_name=settings.s3_region or None,
        endpoint_url=settings.s3_endpoint_url or None,
        aws_access_key_id=settings.s3_access_key_id or None,
        aws_secret_access_key=settings.s3_secret_access_key or None,
    )


def s3_upload_args() -> dict[str, str]:
    """Upload options: ciphertext content type plus the bucket's server-side encryption."""
    args = {"ContentType": SEALED_CONTENT_TYPE, "ServerSideEncryption": settings.s3_sse}
    if settings.s3_sse == "aws:kms" and settings.s3_kms_key_id:
        args["SSEKMSKeyId"] = settings.s3_kms_key_id
    return args


class S3Backend:
    """Objects in an S3-compatible bucket, with the bucket's server-side encryption on top."""

    def __init__(self) -> None:
        self.bucket = settings.s3_bucket
        self.client = s3_client()
        self.upload_args = s3_upload_args()

    def write(self, key: str, chunks: Iterable[bytes]) -> None:
        # upload_fileobj streams in parts, so large files never sit in memory whole.
        self.client.upload_fileobj(
            _ChunkReader(chunks), self.bucket, key, ExtraArgs=self.upload_args
        )

    def open(self, key: str) -> BinaryIO:
        return cast(BinaryIO, self.client.get_object(Bucket=self.bucket, Key=key)["Body"])

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


class _UnclaimedKeys:
    """Wrapped keys of files this process saved whose StoredFile row isn't inserted yet."""

    # Rows that never get inserted (a request failed after saving) are forgotten eventually.
    LIMIT = 10_000

    def __init__(self) -> None:
        self._keys: dict[str, str] = {}
        self._lock = threading.Lock()

    def add(self, storage_key: str, wrapped_key: str) -> None:
        with self._lock:
            self._keys[storage_key] = wrapped_key
            while len(self._keys) > self.LIMIT:
                del self._keys[next(iter(self._keys))]

    def get(self, storage_key: str) -> str | None:
        with self._lock:
            return self._keys.get(storage_key)

    def claim(self, storage_key: str) -> str | None:
        with self._lock:
            return self._keys.pop(storage_key, None)


_unclaimed = _UnclaimedKeys()


@event.listens_for(StoredFile, "before_insert")
def _attach_wrapped_key(
    _mapper: Mapper[StoredFile], _connection: Connection, stored: StoredFile
) -> None:
    """Give a new StoredFile row the key its bytes were encrypted with."""
    if stored.wrapped_key is None:
        stored.wrapped_key = _unclaimed.claim(stored.storage_key)


class EncryptedStorage:
    """Encrypts each file with its own key on the way into the backend, decrypts on the way out."""

    def __init__(self, backend: Backend) -> None:
        self.backend = backend

    def save(self, key: str, data: bytes, content_type: str) -> None:
        """Encrypt and store `data` under `key`.

        `content_type` is kept for callers; the backend stores ciphertext.
        """
        self.save_stream(key, io.BytesIO(data), content_type)

    def save_stream(self, key: str, source: BinaryIO, content_type: str) -> int:
        """Encrypt and store everything read from `source` a chunk at a time.

        Returns the number of bytes read, for StoredFile.size_bytes.
        """
        file_key, wrapped_key = new_file_key()
        size = 0

        def counted() -> Iterator[bytes]:
            nonlocal size
            for chunk in chunks_of(source):
                size += len(chunk)
                yield chunk

        self.backend.write(key, seal(file_key, counted()))
        _unclaimed.add(key, wrapped_key)
        return size

    def read(self, key: str) -> bytes:
        """The decrypted bytes stored under `key`."""
        return b"".join(self.stream(key))

    def stream(self, key: str) -> Iterator[bytes]:
        """The decrypted bytes stored under `key`, a chunk at a time."""
        wrapped_key = _unclaimed.get(key)
        if wrapped_key is None:
            with SessionLocal() as db:
                wrapped_key = db.scalar(
                    select(StoredFile.wrapped_key).where(StoredFile.storage_key == key)
                )
        return self.stream_with_key(key, wrapped_key)

    def stream_with_key(self, key: str, wrapped_key: str | None) -> Iterator[bytes]:
        """Decrypt the file under `key` with its wrapped key (fails closed if it's missing)."""
        file_key = unwrap_file_key(wrapped_key)
        return open_sealed(file_key, self.backend.open(key))

    def delete(self, key: str) -> None:
        """Remove the bytes stored under `key`."""
        self.backend.delete(key)
        _unclaimed.claim(key)


@cache
def get_storage() -> EncryptedStorage:
    """The configured storage backend, wrapped in per-file encryption."""
    if settings.storage_backend == "s3":
        return EncryptedStorage(S3Backend())
    return EncryptedStorage(LocalBackend(settings.storage_local_path))


def _safe_filename(filename: str) -> str:
    name = PurePosixPath(filename.replace("\\", "/")).name.strip() or "file"
    return "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*')[:200] or "file"


def store_upload(
    db: Session,
    upload: UploadFile,
    *,
    practice_id: int,
    client_id: int | None,
    purpose: FilePurpose,
    uploaded_by: str,
    uploaded_by_staff_id: int | None = None,
    shared_with_client: bool = False,
    audio_only: bool = False,
) -> StoredFile:
    """Validate an upload, write its bytes to storage and add a StoredFile row (caller commits).

    Storage keys are namespaced by practice: practices/<practice_id>/<purpose>/<random>.<ext>.
    """
    filename = _safe_filename(upload.filename or "file")
    extension = PurePosixPath(filename).suffix.lower()
    allowed = AUDIO_EXTENSIONS if audio_only else ALLOWED_TYPES.keys()
    if extension not in allowed:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"Files of type {extension or 'unknown'} aren't allowed",
        )
    data = upload.file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes // (1024 * 1024)
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"Files must be under {limit_mb} MB")
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The file is empty")
    content_type = ALLOWED_TYPES[extension]
    key = f"practices/{practice_id}/{purpose}/{secrets.token_hex(16)}{extension}"
    get_storage().save(key, data, content_type)
    stored = StoredFile(
        practice_id=practice_id,
        client_id=client_id,
        purpose=purpose,
        filename=filename,
        content_type=content_type,
        size_bytes=len(data),
        storage_key=key,
        uploaded_by=uploaded_by,
        uploaded_by_staff_id=uploaded_by_staff_id,
        shared_with_client=shared_with_client,
    )
    db.add(stored)
    db.flush()
    return stored


def store_generated_file(
    db: Session,
    data: bytes,
    *,
    practice_id: int,
    client_id: int | None,
    purpose: FilePurpose,
    filename: str,
    content_type: str,
    uploaded_by: str,
    uploaded_by_staff_id: int | None = None,
    shared_with_client: bool = False,
) -> StoredFile:
    """Save a file the app produced (e.g. a released copy of a record) and add its StoredFile
    row (caller commits). Keys follow the same scheme as uploads."""
    safe_name = _safe_filename(filename)
    extension = PurePosixPath(safe_name).suffix.lower()
    key = f"practices/{practice_id}/{purpose}/{secrets.token_hex(16)}{extension}"
    get_storage().save(key, data, content_type)
    stored = StoredFile(
        practice_id=practice_id,
        client_id=client_id,
        purpose=purpose,
        filename=safe_name,
        content_type=content_type,
        size_bytes=len(data),
        storage_key=key,
        uploaded_by=uploaded_by,
        uploaded_by_staff_id=uploaded_by_staff_id,
        shared_with_client=shared_with_client,
    )
    db.add(stored)
    db.flush()
    return stored


def file_response(stored: StoredFile, *, inline: bool = False) -> Response:
    """Return the file's decrypted bytes as a download.

    A missing or wrong key is always an error response. Files up to BUFFERED_DOWNLOAD_BYTES
    are decrypted in full first, so a damaged file is an error too; larger files stream, and
    a damaged chunk cuts the download short (nothing unauthenticated is ever sent).
    """
    disposition = "inline" if inline else "attachment"
    quoted = stored.filename.replace('"', "")
    headers = {"Content-Disposition": f'{disposition}; filename="{quoted}"'}
    chunks = get_storage().stream_with_key(stored.storage_key, stored.wrapped_key)
    if stored.size_bytes <= BUFFERED_DOWNLOAD_BYTES:
        return Response(b"".join(chunks), media_type=stored.content_type, headers=headers)
    return StreamingResponse(chunks, media_type=stored.content_type, headers=headers)
