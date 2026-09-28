"""Password hashing, JWT issuance/verification and opaque tokens (stored only as hashes)."""

import base64
import hashlib
import secrets
from datetime import timedelta
from typing import Any, Literal

import bcrypt
import jwt

from synari.config import settings
from synari.db import utcnow
from synari.models.enums import Role

JWT_ALGORITHM = "HS256"
TokenType = Literal["access", "video_join", "mfa"]


def _prehash(password: str) -> bytes:
    # bcrypt only reads 72 bytes; pre-hashing keeps long passphrases fully significant.
    return base64.b64encode(hashlib.sha256(password.encode()).digest())


def hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    """Check a password against a stored bcrypt hash."""
    return bcrypt.checkpw(_prehash(password), password_hash.encode())


# A real hash so failed logins for unknown emails take as long as for known ones.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_hex(16))


def create_token(
    *,
    subject_id: int,
    role: Role | str,
    token_type: TokenType,
    version: int,
    expires_in: timedelta,
    extra: dict[str, Any] | None = None,
) -> str:
    """Sign a JWT carrying the subject, role, token type and account token version."""
    now = utcnow()
    claims: dict[str, Any] = {
        "sub": str(subject_id),
        "role": str(role),
        "type": token_type,
        "ver": version,
        "iat": now,
        "exp": now + expires_in,
    }
    if extra:
        claims.update(extra)
    return jwt.encode(claims, settings.secret_key, algorithm=JWT_ALGORITHM)


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any] | None:
    """Return the claims of a valid, unexpired token of the expected type, else None."""
    try:
        claims = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "sub", "type"]},
        )
    except jwt.PyJWTError:
        return None
    if claims.get("type") != expected_type:
        return None
    return claims


def new_opaque_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). Store only the hash; send only the raw token."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_opaque_token(raw)


def hash_opaque_token(raw: str) -> str:
    """SHA-256 hex digest used to look up opaque tokens."""
    return hashlib.sha256(raw.encode()).hexdigest()
