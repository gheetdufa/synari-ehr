"""Per-file encryption: every stored file is sealed with its own AES-256-GCM key.

The file's key is wrapped (encrypted) with the master key from DATA_ENCRYPTION_KEYS and kept in
StoredFile.wrapped_key, so storage (disk, S3, backups of either) only ever holds ciphertext.
Deleting a file's wrapped key makes its bytes unreadable wherever they were copied
(crypto-shredding). Rotating the master key only re-wraps the small file keys (`python -m
synari.admin reencrypt`); the files themselves are never rewritten.

Format, version 1: the 5-byte header b"SYNF1", then the content in 64 KiB chunks, each sealed
with AES-256-GCM (a 16-byte tag per chunk). A chunk's nonce is an 11-byte big-endian counter
plus a final-chunk flag, and the header is authenticated with every chunk, so chunks can't be
reordered, dropped, truncated or extended without detection (the STREAM construction that age
and Tink use). Files of any size are encrypted and decrypted a chunk at a time.
"""

import base64
from collections.abc import Iterable, Iterator
from contextlib import closing
from typing import BinaryIO

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from synari.crypto import EncryptionError, decrypt, encrypt

MAGIC = b"SYNF1"
CHUNK_BYTES = 64 * 1024
TAG_BYTES = 16
SEALED_CHUNK_BYTES = CHUNK_BYTES + TAG_BYTES
# Encryption context of StoredFile.wrapped_key (see synari/crypto.py).
WRAPPED_KEY_CONTEXT = "stored_files.wrapped_key"


def new_file_key() -> tuple[bytes, str]:
    """A fresh random file key and its wrapped form for StoredFile.wrapped_key."""
    key = AESGCM.generate_key(bit_length=256)
    return key, encrypt(base64.b64encode(key).decode(), WRAPPED_KEY_CONTEXT)


def unwrap_file_key(wrapped: str | None) -> bytes:
    """The file key inside a wrapped key; fails closed if it's missing or won't decrypt."""
    if not wrapped:
        raise EncryptionError("This file has no key: it was shredded or saved unencrypted")
    return base64.b64decode(decrypt(wrapped, WRAPPED_KEY_CONTEXT))


def read_exact(source: BinaryIO, size: int) -> bytes:
    """Read `size` bytes (fewer only at the end of the stream)."""
    parts: list[bytes] = []
    remaining = size
    while remaining:
        part = source.read(remaining)
        if not part:
            break
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def chunks_of(source: BinaryIO, size: int = CHUNK_BYTES) -> Iterator[bytes]:
    """`source` in pieces of exactly `size` bytes; the last may be shorter (b"" if empty)."""
    chunk = read_exact(source, size)
    yield chunk
    while len(chunk) == size:
        chunk = read_exact(source, size)
        if not chunk:
            return
        yield chunk


def _nonce(counter: int, last: bool) -> bytes:
    return counter.to_bytes(11, "big") + (b"\x01" if last else b"\x00")


def seal(key: bytes, plaintext_chunks: Iterable[bytes]) -> Iterator[bytes]:
    """Encrypt chunks from chunks_of() into the stored format, header first."""
    cipher = AESGCM(key)
    chunks = iter(plaintext_chunks)
    yield MAGIC
    current = next(chunks, b"")
    counter = 0
    while True:
        following = next(chunks, None)
        yield cipher.encrypt(_nonce(counter, following is None), current, MAGIC)
        if following is None:
            return
        current = following
        counter += 1


def open_sealed(key: bytes, source: BinaryIO) -> Iterator[bytes]:
    """Check the header of a stored file now, then decrypt it chunk by chunk as it's read.

    Every chunk is authenticated before it's returned; tampering raises EncryptionError.
    """
    if read_exact(source, len(MAGIC)) != MAGIC:
        source.close()
        raise EncryptionError("A stored file isn't in Synari's encrypted file format")
    return _open_chunks(AESGCM(key), source)


def _open_chunks(cipher: AESGCM, source: BinaryIO) -> Iterator[bytes]:
    with closing(source):
        chunks = chunks_of(source, SEALED_CHUNK_BYTES)
        current = next(chunks)
        counter = 0
        while True:
            following = next(chunks, None)
            try:
                plaintext = cipher.decrypt(_nonce(counter, following is None), current, MAGIC)
            except (InvalidTag, ValueError) as exc:
                raise EncryptionError("A stored file failed its integrity check") from exc
            yield plaintext
            if following is None:
                return
            current = following
            counter += 1
