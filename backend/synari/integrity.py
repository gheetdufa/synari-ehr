"""Content hashes that make signed records tamper-evident: notes, their revisions and addenda,
and e-signed forms.

A hash is SHA-256 over canonical JSON (sorted keys, no whitespace, UTC ISO-8601 timestamps with
microseconds), so the same record always hashes the same way and any change to the signed
content, signer or signing time changes the hash.
"""

import hashlib
import hmac
import json
from datetime import UTC, date, datetime
from typing import Any, Literal

Integrity = Literal["verified", "mismatch"]


def _default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"Can't hash a {type(value).__name__}")


def canonical_json(value: Any) -> bytes:
    """Deterministic JSON bytes for hashing."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=_default
    ).encode()


def sha256_hex(value: Any) -> str:
    """SHA-256 of the canonical JSON of `value`, as 64 hex characters."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def note_content_sha256(
    *,
    note_id: int,
    client_id: int,
    author_id: int,
    title: str,
    sections: dict[str, str],
    content: str,
    signed_at: datetime,
) -> str:
    """The signature hash of a note version."""
    return sha256_hex(
        {
            "note_id": note_id,
            "client_id": client_id,
            "author_id": author_id,
            "title": title,
            "sections": sections,
            "content": content,
            "signed_at": signed_at,
        }
    )


def addendum_sha256(
    *,
    note_id: int,
    author_id: int,
    content: str,
    amendment_request_id: int | None,
    created_at: datetime,
) -> str:
    """The hash of an addendum to a signed note."""
    return sha256_hex(
        {
            "note_id": note_id,
            "author_id": author_id,
            "content": content,
            "amendment_request_id": amendment_request_id,
            "created_at": created_at,
        }
    )


def form_signature_sha256(
    *,
    form_id: int,
    client_id: int,
    fields: list[dict[str, Any]],
    answers: dict[str, Any] | None,
    signature_name: str,
    signed_at: datetime,
) -> str:
    """The hash of an e-signed form: what was asked, what was answered, who signed and when."""
    return sha256_hex(
        {
            "form_id": form_id,
            "client_id": client_id,
            "fields": fields,
            "answers": answers or {},
            "signature_name": signature_name,
            "signed_at": signed_at,
        }
    )


def check(expected: str, actual: str) -> Integrity:
    """'verified' when the stored hash matches the recomputed one, else 'mismatch'."""
    return "verified" if hmac.compare_digest(expected, actual) else "mismatch"
