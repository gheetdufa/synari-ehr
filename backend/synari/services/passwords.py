"""Staff password policy (NIST SP 800-63B style): length, not common, not based on the account,
and optionally not in a known breach. No composition rules and no forced rotation.

- At least 12 characters (enforced by the `Password` schema type and here).
- Not a common or predictable password (bundled list in synari/data/common_passwords.txt,
  keyboard runs, sequences, repeated characters), checked as typed and without the digits and
  symbols people add at the ends.
- Not based on the person's name, email or practice name.
- With PASSWORD_BREACH_CHECK=true, not in Have I Been Pwned's breach corpus. Only the first 5
  characters of the password's SHA-1 hash are sent (k-anonymity, padded responses); if the
  service can't be reached within 2 seconds the check is skipped.
"""

import hashlib
import logging
import re
import string
from collections.abc import Iterable
from functools import cache
from pathlib import Path

import httpx
from fastapi import HTTPException, status

from synari.config import settings

logger = logging.getLogger(__name__)

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256
HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/"
HIBP_TIMEOUT_SECONDS = 2.0

TOO_SHORT = f"Use at least {MIN_PASSWORD_LENGTH} characters."
TOO_COMMON = "This password is too common. Choose something less predictable."
PERSONAL = "Don't base your password on your name, email or practice name."
BREACHED = "This password has appeared in a data breach. Choose a different one."

_COMMON_PASSWORDS_FILE = Path(__file__).resolve().parent.parent / "data" / "common_passwords.txt"
_KEYBOARD_RUNS = (
    "qwertyuiopasdfghjklzxcvbnm",
    "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p",
    "1q2w3e4r5t6y7u8i9o0p",
    "zaq12wsxcde34rfvbgt56yhnmju78ik",
    "01234567890123456789",
    "abcdefghijklmnopqrstuvwxyz",
)
# What's left of a password after removing the person's own words must be at least this long.
_MIN_UNPERSONAL_LETTERS = 6
_EDGE_CHARACTERS = string.digits + string.punctuation + " "


@cache
def common_passwords() -> frozenset[str]:
    """The bundled list of common passwords (lowercase)."""
    lines = _COMMON_PASSWORDS_FILE.read_text(encoding="utf-8").splitlines()
    return frozenset(line.strip() for line in lines if line.strip() and not line.startswith("#"))


def _is_run(text: str) -> bool:
    """Keyboard runs, alphabet or digit sequences (either direction) and repeated patterns."""
    if len(set(text)) <= 3:
        return True
    return any(text in run or text in run[::-1] for run in _KEYBOARD_RUNS)


def _is_common(password: str) -> bool:
    compact = re.sub(r"\s+", "", password.lower())
    base = compact.strip(_EDGE_CHARACTERS)
    candidates = {compact, base} - {""}
    return any(c in common_passwords() or _is_run(c) for c in candidates)


def context_words(*values: str) -> list[str]:
    """Words that identify an account: names, email parts, practice name (3+ letters each)."""
    words: set[str] = {"synari"}
    for value in values:
        for word in re.split(r"[^a-z0-9]+", value.lower()):
            if len(word) >= 3:
                words.add(word)
    return sorted(words, key=len, reverse=True)


def _is_personal(password: str, words: Iterable[str]) -> bool:
    compact = re.sub(r"[^a-z0-9]", "", password.lower())
    found = [word for word in words if word in compact]
    if not found:
        return False
    for word in found:
        compact = compact.replace(word, "")
    letters = re.sub(r"[^a-z]", "", compact)
    return len(letters) < _MIN_UNPERSONAL_LETTERS


def _hibp_client() -> httpx.Client:
    """HTTP client for the breach check (tests swap in an httpx.MockTransport)."""
    return httpx.Client(timeout=HIBP_TIMEOUT_SECONDS)


def is_breached(password: str) -> bool:
    """Whether Have I Been Pwned lists the password; False when the service is unavailable."""
    digest = hashlib.sha1(password.encode(), usedforsecurity=False).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    try:
        with _hibp_client() as client:
            response = client.get(
                HIBP_RANGE_URL + prefix,
                headers={"Add-Padding": "true", "User-Agent": "Synari password check"},
            )
            response.raise_for_status()
    except httpx.HTTPError:
        logger.warning("Breached-password check unavailable; skipping it")
        return False
    for line in response.text.splitlines():
        candidate, _, count = line.partition(":")
        if candidate.strip().upper() == suffix and count.strip() not in ("", "0"):
            return True
    return False


def password_problem(password: str, *, context: Iterable[str] = ()) -> str | None:
    """Why a new staff password isn't acceptable, or None if it is."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return TOO_SHORT
    if _is_common(password):
        return TOO_COMMON
    if _is_personal(password, context):
        return PERSONAL
    if settings.password_breach_check and is_breached(password):
        return BREACHED
    return None


def require_acceptable_password(password: str, *, context: Iterable[str] = ()) -> None:
    """Raise 400 with a clear message when a new staff password breaks the policy."""
    problem = password_problem(password, context=context)
    if problem is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, problem)
