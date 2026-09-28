"""Application-level encryption for sensitive columns and stored secrets (AES-256-GCM).

Clinical free text (notes, messages, form answers, transcripts), identifiers and OAuth tokens
are encrypted before they reach the database, so a database dump or backup alone doesn't
expose them. Columns that must be searched or filtered (names, emails, dates, statuses) stay
in plain text; protect those with encrypted disks and backups.

Keys come from DATA_ENCRYPTION_KEYS: comma-separated `key_id:base64key` pairs of 32-byte keys.
The first key encrypts; every listed key can decrypt, so keys can be rotated by adding a new
key first and re-encrypting (`python -m synari.admin reencrypt`, see
services/key_rotation.py). Stored files get their own keys, wrapped with these
(services/file_encryption.py). Generate one with:

    python -c "import base64, os; print('k1:' + base64.b64encode(os.urandom(32)).decode())"

Ciphertext is stored as `enc:v1:<key_id>:<base64(nonce + ciphertext)>`. Each column's name is
bound in as associated data, so a value copied into another column won't decrypt.
"""

import base64
import json
import os
from functools import lru_cache
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import Text
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator

from synari.config import settings

PREFIX = "enc:v1:"
NONCE_BYTES = 12


class EncryptionError(Exception):
    """A value couldn't be encrypted or decrypted (missing key, tampering, wrong column)."""


@lru_cache(maxsize=1)
def keyring() -> tuple[str, dict[str, AESGCM]]:
    """(primary key id, all keys by id) from settings, or a development key from SECRET_KEY."""
    configured = settings.data_encryption_keys.strip()
    if not configured:
        derived = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None, info=b"synari-data-encryption"
        ).derive(settings.secret_key.encode())
        return "dev", {"dev": AESGCM(derived)}
    keys: dict[str, AESGCM] = {}
    primary = ""
    for entry in configured.split(","):
        key_id, _, encoded = entry.strip().partition(":")
        key = base64.b64decode(encoded)
        if not key_id or len(key) != 32:
            raise EncryptionError("Each DATA_ENCRYPTION_KEYS entry must be key_id:base64(32 bytes)")
        keys[key_id] = AESGCM(key)
        primary = primary or key_id
    return primary, keys


def encrypt(plaintext: str, context: str) -> str:
    """Encrypt text for storage; `context` names where it's stored (e.g. "notes.content")."""
    key_id, keys = keyring()
    nonce = os.urandom(NONCE_BYTES)
    sealed = keys[key_id].encrypt(nonce, plaintext.encode(), context.encode())
    return f"{PREFIX}{key_id}:{base64.b64encode(nonce + sealed).decode()}"


def decrypt(stored: str, context: str) -> str:
    """Decrypt a value produced by encrypt() for the same context."""
    if not stored.startswith(PREFIX):
        raise EncryptionError(f"{context} holds a value that isn't encrypted")
    key_id, _, payload = stored[len(PREFIX) :].partition(":")
    key = keyring()[1].get(key_id)
    if key is None:
        raise EncryptionError(f"No key {key_id!r} in DATA_ENCRYPTION_KEYS to decrypt {context}")
    raw = base64.b64decode(payload)
    try:
        return key.decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], context.encode()).decode()
    except Exception as exc:  # InvalidTag: wrong key, wrong column or tampering
        raise EncryptionError(f"Couldn't decrypt {context}") from exc


def key_id_of(stored: str) -> str:
    """The id of the key that encrypted a stored value."""
    return stored[len(PREFIX) :].partition(":")[0]


class EncryptedText(TypeDecorator[str]):
    """A text column encrypted at rest. `context` is usually "table.column"."""

    impl = Text
    cache_ok = True

    def __init__(self, context: str) -> None:
        super().__init__()
        self.context = context

    def process_bind_param(self, value: str | None, dialect: Dialect) -> str | None:
        return None if value is None else encrypt(value, self.context)

    def process_result_value(self, value: str | None, dialect: Dialect) -> str | None:
        return None if value is None else decrypt(value, self.context)


class EncryptedJSON(TypeDecorator[Any]):
    """A JSON value encrypted at rest (stored as encrypted text)."""

    impl = Text
    cache_ok = True

    def __init__(self, context: str) -> None:
        super().__init__()
        self.context = context

    def process_bind_param(self, value: Any, dialect: Dialect) -> str | None:
        return None if value is None else encrypt(json.dumps(value), self.context)

    def process_result_value(self, value: str | None, dialect: Dialect) -> Any:
        return None if value is None else json.loads(decrypt(value, self.context))
