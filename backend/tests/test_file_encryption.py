"""Stored files are encrypted with per-file keys, fail closed, and can be crypto-shredded."""

import base64
import io
import os
import secrets
from collections.abc import Iterator
from pathlib import Path

import boto3
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari import crypto
from synari.config import settings
from synari.crypto import EncryptionError
from synari.main import app
from synari.models import StoredFile
from synari.models.enums import FilePurpose, Role
from synari.services import storage
from synari.services.file_encryption import (
    CHUNK_BYTES,
    MAGIC,
    SEALED_CHUNK_BYTES,
    chunks_of,
    new_file_key,
    open_sealed,
    seal,
    unwrap_file_key,
)
from tests.conftest import StaffAccount, create_client_record
from tests.fake_s3 import FakeS3

SECRET = b"%PDF-1.4 Alex Rivera intake: panic attacks since March"


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()
    yield
    storage.get_storage.cache_clear()
    crypto.keyring.cache_clear()


def use_master_key(monkeypatch: pytest.MonkeyPatch, entry: str) -> None:
    monkeypatch.setattr(settings, "data_encryption_keys", entry)
    crypto.keyring.cache_clear()


def random_key_entry(key_id: str) -> str:
    return f"{key_id}:{base64.b64encode(os.urandom(32)).decode()}"


def upload(api: TestClient, db: Session, clinician: StaffAccount, client_id: int) -> StoredFile:
    response = api.post(
        f"/api/clients/{client_id}/files",
        files={"file": ("intake.pdf", SECRET, "application/pdf")},
        headers=clinician.headers,
    )
    assert response.status_code == 201, response.text
    return db.get_one(StoredFile, response.json()["id"])


def stored_bytes(stored: StoredFile) -> bytes:
    return (Path(settings.storage_local_path) / stored.storage_key).read_bytes()


def sealed(data: bytes) -> tuple[bytes, bytes]:
    key, _wrapped = new_file_key()
    return key, b"".join(seal(key, chunks_of(io.BytesIO(data))))


@pytest.mark.parametrize(
    "size", [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES]
)
def test_format_round_trips_every_size(size: int) -> None:
    data = os.urandom(size)
    key, ciphertext = sealed(data)
    assert ciphertext.startswith(MAGIC)
    chunks = max(1, -(-size // CHUNK_BYTES))
    assert len(ciphertext) == len(MAGIC) + size + 16 * chunks
    assert b"".join(open_sealed(key, io.BytesIO(ciphertext))) == data


def _tampered(ciphertext: bytes, how: str) -> bytes:
    body = ciphertext[len(MAGIC) :]
    first, second = body[:SEALED_CHUNK_BYTES], body[SEALED_CHUNK_BYTES:]
    if how == "flipped":
        return ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
    if how == "truncated":  # cut cleanly at a chunk boundary
        return MAGIC + first
    if how == "extended":
        return ciphertext + ciphertext[len(MAGIC) : len(MAGIC) + SEALED_CHUNK_BYTES]
    if how == "reordered":
        return MAGIC + second + first
    return b"SYNF0" + body


@pytest.mark.parametrize("how", ["flipped", "truncated", "extended", "reordered", "header"])
def test_tampering_is_detected(how: str) -> None:
    key, ciphertext = sealed(os.urandom(CHUNK_BYTES + 10))
    with pytest.raises(EncryptionError):
        b"".join(open_sealed(key, io.BytesIO(_tampered(ciphertext, how))))


def test_a_different_file_key_cannot_open_a_file() -> None:
    _key, ciphertext = sealed(SECRET)
    other, _wrapped = new_file_key()
    with pytest.raises(EncryptionError):
        b"".join(open_sealed(other, io.BytesIO(ciphertext)))


def test_uploads_are_stored_encrypted_and_download_as_plaintext(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    stored = upload(api, db, clinician, client.id)

    on_disk = stored_bytes(stored)
    assert on_disk.startswith(MAGIC)
    assert b"Alex Rivera" not in on_disk and b"%PDF" not in on_disk
    assert stored.wrapped_key is not None and stored.wrapped_key.startswith("enc:v1:")
    # Each file has its own key.
    other = upload(api, db, clinician, client.id)
    assert unwrap_file_key(other.wrapped_key) != unwrap_file_key(stored.wrapped_key)

    download = api.get(f"/api/files/{stored.id}", headers=clinician.headers)
    assert download.status_code == 200
    assert download.content == SECRET
    assert download.headers["content-type"] == "application/pdf"
    assert storage.get_storage().read(stored.storage_key) == SECRET


def test_a_different_master_key_fails_closed(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = create_client_record(db, clinician)
    stored = upload(api, db, clinician, client.id)
    loose = TestClient(app, raise_server_exceptions=False)

    # The key the file was wrapped with is gone...
    use_master_key(monkeypatch, random_key_entry("k2"))
    with pytest.raises(EncryptionError, match="No key"):
        storage.get_storage().read(stored.storage_key)
    # ...or a key with the same id holds different bytes.
    use_master_key(monkeypatch, random_key_entry(crypto.key_id_of(stored.wrapped_key or "")))
    with pytest.raises(EncryptionError):
        storage.get_storage().read(stored.storage_key)
    response = loose.get(f"/api/files/{stored.id}", headers=clinician.headers)
    assert response.status_code == 500
    assert b"Alex" not in response.content


def test_tampered_bytes_on_disk_fail_closed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    stored = upload(api, db, clinician, client.id)
    path = Path(settings.storage_local_path) / stored.storage_key
    data = bytearray(path.read_bytes())
    data[len(MAGIC) + 3] ^= 0xFF
    path.write_bytes(bytes(data))
    response = TestClient(app, raise_server_exceptions=False).get(
        f"/api/files/{stored.id}", headers=clinician.headers
    )
    assert response.status_code == 500
    assert b"Alex" not in response.content


def test_deleting_the_wrapped_key_crypto_shreds_the_file(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    stored = upload(api, db, clinician, client.id)
    copy_of_bytes = stored_bytes(stored)  # e.g. still sitting in an old backup

    row = db.get_one(StoredFile, stored.id)
    row.wrapped_key = None
    db.commit()

    with pytest.raises(EncryptionError, match="no key"):
        storage.get_storage().read(stored.storage_key)
    assert stored_bytes(stored) == copy_of_bytes  # the ciphertext alone is useless
    response = TestClient(app, raise_server_exceptions=False).get(
        f"/api/files/{stored.id}", headers=clinician.headers
    )
    assert response.status_code == 500


def test_raw_saves_hand_their_key_to_the_stored_file_row(
    clinician: StaffAccount, db: Session
) -> None:
    """The documented pattern: save bytes, then add the StoredFile row in the same process."""
    key = f"practices/{clinician.practice_id}/recording/{secrets.token_hex(8)}.webm"
    storage.get_storage().save(key, b"audio bytes", "audio/webm")
    # Readable before the row exists...
    assert storage.get_storage().read(key) == b"audio bytes"
    stored = StoredFile(
        practice_id=clinician.practice_id,
        client_id=None,
        purpose=FilePurpose.RECORDING,
        filename="session.webm",
        content_type="audio/webm",
        size_bytes=11,
        storage_key=key,
        uploaded_by=Role.STAFF,
    )
    db.add(stored)
    db.commit()
    assert stored.wrapped_key is not None
    # ...and afterwards from any process, through the row's key.
    assert storage.get_storage().read(key) == b"audio bytes"
    assert b"".join(storage.get_storage().stream_with_key(key, stored.wrapped_key)) == (
        b"audio bytes"
    )
    storage.get_storage().delete(key)
    with pytest.raises(FileNotFoundError):
        storage.get_storage().read(key)


def test_large_files_stream_in_chunks() -> None:
    data = os.urandom(3 * CHUNK_BYTES + 123)
    key = f"practices/1/import_source/{secrets.token_hex(8)}.zip"
    size = storage.get_storage().save_stream(key, io.BytesIO(data), "application/zip")
    assert size == len(data)
    chunks = list(storage.get_storage().stream(key))
    assert len(chunks) == 4
    assert b"".join(chunks) == data
    storage.get_storage().delete(key)


def test_s3_objects_are_encrypted_and_use_the_configured_kms_key(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeS3()
    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: fake)
    monkeypatch.setattr(settings, "storage_backend", "s3")
    monkeypatch.setattr(settings, "s3_bucket", "practice-files")
    monkeypatch.setattr(settings, "s3_sse", "aws:kms")
    monkeypatch.setattr(settings, "s3_kms_key_id", "alias/synari")
    storage.get_storage.cache_clear()
    client = create_client_record(db, clinician)

    stored = upload(api, db, clinician, client.id)

    body = fake.objects["practice-files", stored.storage_key]
    assert body.startswith(MAGIC) and b"Alex" not in body
    assert fake.upload_args["practice-files", stored.storage_key] == {
        "ContentType": "application/octet-stream",
        "ServerSideEncryption": "aws:kms",
        "SSEKMSKeyId": "alias/synari",
    }
    download = api.get(f"/api/files/{stored.id}", headers=clinician.headers)
    assert download.content == SECRET
    storage.get_storage().delete(stored.storage_key)
    assert ("practice-files", stored.storage_key) not in fake.objects


def test_large_downloads_stream(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(storage, "BUFFERED_DOWNLOAD_BYTES", 10)
    client = create_client_record(db, clinician)
    stored = upload(api, db, clinician, client.id)
    download = api.get(f"/api/files/{stored.id}", headers=clinician.headers)
    assert download.status_code == 200
    assert "content-length" not in download.headers
    assert download.content == SECRET
