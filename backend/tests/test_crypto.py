import base64
import os
from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from synari import crypto
from synari.config import settings
from synari.models import Note
from tests.conftest import StaffAccount, create_client_record

DIALECT = postgresql.dialect()


def _key(key_id: str) -> str:
    return f"{key_id}:{base64.b64encode(os.urandom(32)).decode()}"


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Explicit keys for a test (the keyring is cached, so reset it around the test)."""
    configured = [_key("k1")]
    monkeypatch.setattr(settings, "data_encryption_keys", ",".join(configured))
    crypto.keyring.cache_clear()
    yield configured
    crypto.keyring.cache_clear()


def test_round_trip_and_randomized(keys: list[str]) -> None:
    first = crypto.encrypt("Client disclosed panic attacks.", "notes.content")
    second = crypto.encrypt("Client disclosed panic attacks.", "notes.content")
    assert first.startswith("enc:v1:k1:")
    assert first != second  # a fresh nonce every time
    assert crypto.decrypt(first, "notes.content") == "Client disclosed panic attacks."
    assert crypto.decrypt(crypto.encrypt("", "notes.content"), "notes.content") == ""


def test_values_are_bound_to_their_column(keys: list[str]) -> None:
    stored = crypto.encrypt("secret", "notes.content")
    with pytest.raises(crypto.EncryptionError):
        crypto.decrypt(stored, "messages.body")


def test_tampering_is_detected(keys: list[str]) -> None:
    stored = crypto.encrypt("secret", "notes.content")
    prefix, _, payload = stored.rpartition(":")
    raw = bytearray(base64.b64decode(payload))
    raw[-1] ^= 1
    with pytest.raises(crypto.EncryptionError):
        crypto.decrypt(f"{prefix}:{base64.b64encode(bytes(raw)).decode()}", "notes.content")
    with pytest.raises(crypto.EncryptionError):
        crypto.decrypt("plain text", "notes.content")


def test_rotation_keeps_old_values_readable(
    keys: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    old = crypto.encrypt("before rotation", "messages.body")
    monkeypatch.setattr(settings, "data_encryption_keys", ",".join([_key("k2"), *keys]))
    crypto.keyring.cache_clear()
    new = crypto.encrypt("after rotation", "messages.body")
    assert crypto.key_id_of(old) == "k1" and crypto.key_id_of(new) == "k2"
    assert crypto.decrypt(old, "messages.body") == "before rotation"

    monkeypatch.setattr(settings, "data_encryption_keys", _key("k3"))
    crypto.keyring.cache_clear()
    with pytest.raises(crypto.EncryptionError, match="No key 'k2'"):
        crypto.decrypt(new, "messages.body")


def test_bad_key_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "data_encryption_keys", "k1:c2hvcnQ=")
    crypto.keyring.cache_clear()
    try:
        with pytest.raises(crypto.EncryptionError, match="32 bytes"):
            crypto.encrypt("x", "notes.content")
    finally:
        crypto.keyring.cache_clear()


def test_json_column_type_round_trip(keys: list[str]) -> None:
    column = crypto.EncryptedJSON("client_forms.answers")
    stored = column.process_bind_param({"q1": 3, "q2": ["a", "b"]}, DIALECT)
    assert stored is not None and stored.startswith("enc:v1:")
    assert column.process_result_value(stored, DIALECT) == {"q1": 3, "q2": ["a", "b"]}
    assert column.process_bind_param(None, DIALECT) is None


def test_clinical_text_is_ciphertext_in_the_database(clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician, internal_notes="Prefers morning sessions")
    note = Note(
        practice_id=clinician.practice_id,
        author_id=clinician.id,
        client_id=client.id,
        content="Discussed trauma history.",
        sections={"subjective": "Reports nightmares."},
    )
    db.add(note)
    db.commit()
    raw_note = db.execute(
        text("SELECT content, sections FROM notes WHERE id = :id"), {"id": note.id}
    ).one()
    raw_client = db.execute(
        text("SELECT internal_notes FROM clients WHERE id = :id"), {"id": client.id}
    ).one()
    for value in (*raw_note, *raw_client):
        assert value.startswith("enc:v1:")
        assert "trauma" not in value and "nightmares" not in value and "morning" not in value
    db.expire_all()
    assert db.get(Note, note.id).sections == {"subjective": "Reports nightmares."}
