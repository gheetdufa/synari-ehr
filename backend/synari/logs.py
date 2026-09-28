"""Structured logging that keeps health information and credentials out of log files.

Every process (API, worker, admin commands) calls configure_logging() once. Log records are
written to stderr as one JSON object per line, tagged with the current request id, and
scrubbed by RedactionFilter: email addresses, phone numbers, JWTs, bearer tokens, long opaque
tokens and the row values Postgres puts in constraint errors are replaced before anything is
written. Code should still never log clinical content or identifiers on purpose: redaction is
a safety net, not a license.
"""

import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import UTC, datetime

from synari.config import settings

# The id of the HTTP request being handled, set by RequestLogMiddleware ("" outside requests).
request_id: ContextVar[str] = ContextVar("request_id", default="")

# (pattern, replacement) pairs applied in order. Tokens go first so their pieces aren't
# mistaken for phone numbers.
REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"), "Bearer [redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"), "[jwt]"),
    (re.compile(r"(?i)\b(token|code|key|secret|password|signature)=[^&\s\"']+"), r"\1=[redacted]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
    # Postgres puts row values in constraint violations: "Key (email)=(a@b.c) already exists".
    (
        re.compile(r"Key \(([^)]*)\)=\(.*?\)( already exists| is not present)"),
        r"Key (\1)=([redacted])\2",
    ),
    (re.compile(r"Failing row contains \(.*\)"), "Failing row contains ([redacted])"),
    (re.compile(r"\+\d{8,15}\b"), "[phone]"),
    (
        re.compile(r"(?<![\w.:/-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w.:-])"),
        "[phone]",
    ),
    # Opaque tokens (sign-in links, video links, calendar feeds) are long random strings.
    (re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])"), "[token]"),
]


def redact(text: str) -> str:
    """Replace identifiers and credentials in `text` with placeholders."""
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class RedactionFilter(logging.Filter):
    """Scrubs a record's message and traceback, and tags it with the current request id."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = None
        if record.exc_info:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        record.request_id = request_id.get()
        return True


# Extra fields a log call may attach (extra={...}) that are copied into the JSON line.
EXTRA_FIELDS = ("method", "route", "status", "duration_ms")


class JsonFormatter(logging.Formatter):
    """One JSON object per line: time, level, logger, message, request id and extras."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if getattr(record, "request_id", ""):
            entry["request_id"] = record.request_id
        for field in EXTRA_FIELDS:
            if hasattr(record, field):
                entry[field] = getattr(record, field)
        if record.exc_text:
            entry["exception"] = record.exc_text
        if record.stack_info:
            entry["stack"] = record.stack_info
        return json.dumps(entry, default=str)


def configure_logging() -> None:
    """Send every logger (including uvicorn's) through one redacting JSON handler."""
    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(RedactionFilter())
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level)
    for name in ("uvicorn", "uvicorn.error"):
        server_logger = logging.getLogger(name)
        server_logger.handlers = []
        server_logger.propagate = True
    # Raw request paths can carry tokens; RequestLogMiddleware logs route templates instead.
    logging.getLogger("uvicorn.access").disabled = True
    # Outgoing request URLs (clearinghouse, calendars, the breached-password check) can carry
    # identifiers too: HTTP clients log only warnings and errors.
    # (httpx2 and httpcore2 are the copies the OpenAI SDK ships with.)
    for name in ("httpx", "httpcore", "httpx2", "httpcore2"):
        logging.getLogger(name).setLevel(logging.WARNING)
