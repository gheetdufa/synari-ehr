"""Master key rotation: `python -m synari.admin reencrypt`."""

import base64
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari import admin, crypto
from synari.config import settings
from synari.models import Client, StoredFile
from synari.services import storage
from synari.services.key_rotation import encrypted_columns, reencrypt_all
from tests.conftest import StaffAccount, create_client_record

OLD = f"k1:{base64.b64encode(os.urandom(32)).decode()}"
NEW = f"k2:{base64.b64encode(os.urandom(32)).decode()}"


def use_keys(monkeypatch: pytest.MonkeyPatch, keys: str) -> None:
    monkeypatch.setattr(settings, "data_encryption_keys", keys)
    crypto.keyring.cache_clear()


@pytest.fixture(autouse=True)
def _old_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()
    use_keys(monkeypatch, OLD)
    yield
    crypto.keyring.cache_clear()
    storage.get_storage.cache_clear()


def values_under(db: Session, key_id: str) -> int:
    """How many encrypted values in the database were encrypted with `key_id`."""
    total = 0
    for target in encrypted_columns():
        raw = target.raw()
        total += (
            db.scalar(
                select(func.count())
                .select_from(target.table)
                .where(raw.startswith(f"{crypto.PREFIX}{key_id}:"))
            )
            or 0
        )
    return total


def seed(api: TestClient, db: Session, clinician: StaffAccount) -> tuple[Client, int]:
    client = create_client_record(
        db, clinician, internal_notes="Discussed panic symptoms", diagnosis_codes=["F41.0"]
    )
    uploaded = api.post(
        f"/api/clients/{client.id}/files",
        files={"file": ("plan.pdf", b"%PDF safety plan", "application/pdf")},
        headers=clinician.headers,
    )
    assert uploaded.status_code == 201, uploaded.text
    return client, uploaded.json()["id"]


def test_reencrypt_moves_every_value_and_file_key_to_the_active_key(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, file_id = seed(api, db, clinician)
    updated_at = client.updated_at
    under_old = values_under(db, "k1")
    assert under_old >= 3  # at least the notes, the diagnoses and the file's key

    use_keys(monkeypatch, f"{NEW},{OLD}")
    assert reencrypt_all(db, batch_size=2) == under_old
    assert values_under(db, "k1") == 0
    assert values_under(db, "k2") == under_old
    assert reencrypt_all(db) == 0  # nothing left: safe to run again

    # Only the new key is needed from now on.
    use_keys(monkeypatch, NEW)
    db.expire_all()
    restored = db.get_one(Client, client.id)
    assert restored.internal_notes == "Discussed panic symptoms"
    assert restored.diagnosis_codes == ["F41.0"]
    assert restored.updated_at == updated_at  # re-encrypting isn't an edit
    stored = db.get_one(StoredFile, file_id)
    assert stored.wrapped_key is not None and stored.wrapped_key.startswith("enc:v1:k2:")
    download = api.get(f"/api/files/{file_id}", headers=clinician.headers)
    assert download.content == b"%PDF safety plan"


def test_admin_command_reports_progress(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(admin, "configure_logging", lambda: None)
    seed(api, db, clinician)
    use_keys(monkeypatch, f"{NEW},{OLD}")

    assert admin.main(["reencrypt", "--batch", "1"]) == 0
    output = capsys.readouterr().out
    assert "Re-encrypting under key 'k2'" in output
    assert "clients.internal_notes: 1/1" in output
    assert "stored_files.wrapped_key: 1/1" in output
    assert values_under(db, "k1") == 0

    assert admin.main(["reencrypt", "--batch", "0"]) == 2


def test_values_that_cannot_be_decrypted_stop_the_run(
    db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    create_client_record(db, clinician, internal_notes="Private")
    # The key the data was written with is missing: nothing can be re-encrypted.
    use_keys(monkeypatch, NEW)
    with pytest.raises(crypto.EncryptionError):
        reencrypt_all(db)
