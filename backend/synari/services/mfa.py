"""Two-factor authentication with time-based one-time passwords (authenticator apps)."""

import hashlib
import hmac
import secrets

import pyotp

from synari.db import utcnow
from synari.models import StaffMember

ISSUER = "Synari"
RECOVERY_CODE_COUNT = 8


def new_secret() -> str:
    """A fresh base32 TOTP secret."""
    return pyotp.random_base32()


def provisioning_uri(staff: StaffMember, secret: str) -> str:
    """otpauth:// URI for authenticator apps (usually shown as a QR code)."""
    return pyotp.TOTP(secret).provisioning_uri(name=staff.email, issuer_name=ISSUER)


def verify_totp(secret: str | None, code: str, *, last_step: int | None = None) -> int | None:
    """The 30-second time step a 6-digit code belongs to, or None if it doesn't match.

    Allows one step of clock drift either way. Steps at or before `last_step` (the last code
    this account used) are refused, so a code can't be replayed.
    """
    digits = code.replace(" ", "")
    if not secret or not digits.isdigit() or len(digits) != 6:
        return None
    totp = pyotp.TOTP(secret)
    current = totp.timecode(utcnow())
    for step in (current - 1, current, current + 1):
        if last_step is not None and step <= last_step:
            continue
        if hmac.compare_digest(totp.generate_otp(step), digits):
            return step
    return None


def _hash_recovery_code(code: str) -> str:
    return hashlib.sha256(code.replace("-", "").replace(" ", "").lower().encode()).hexdigest()


def generate_recovery_codes() -> tuple[list[str], list[str]]:
    """Return (codes to show once, hashes to store)."""
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(RECOVERY_CODE_COUNT)]
    return codes, [_hash_recovery_code(code) for code in codes]


def consume_recovery_code(staff: StaffMember, code: str) -> bool:
    """Use up a recovery code if it matches one that hasn't been used (caller commits)."""
    hashed = _hash_recovery_code(code)
    if hashed not in staff.mfa_recovery_codes:
        return False
    staff.mfa_recovery_codes = [h for h in staff.mfa_recovery_codes if h != hashed]
    return True


def verify_second_factor(staff: StaffMember, code: str) -> bool:
    """An unused authenticator code, or else a single-use recovery code (caller commits)."""
    step = verify_totp(staff.mfa_secret, code, last_step=staff.mfa_last_step)
    if step is not None:
        staff.mfa_last_step = step
        return True
    return consume_recovery_code(staff, code)


def clear_mfa(staff: StaffMember) -> None:
    """Turn off two-factor authentication and forget the secret and recovery codes."""
    staff.mfa_enabled = False
    staff.mfa_secret = None
    staff.mfa_recovery_codes = []
    staff.mfa_last_step = None
