"""Rate limits shared by every API process, counted in Postgres in fixed windows.

`rate_limit(name, limit, window_seconds)` builds a FastAPI dependency that limits requests per
client IP. `enforce_limit(name, key, limit, window_seconds)` limits by any other key (an account,
an email address, a sign-in challenge) from inside a handler.

Keys are stored as keyed hashes, so the table never holds IP or email addresses. Each hit is
counted in its own transaction, so it counts even when the request then fails.
"""

import hashlib
import hmac
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import engine, utcnow
from synari.models import RateLimitBucket

# Buckets are purged after this long, so no window may be longer.
MAX_WINDOW = timedelta(days=1)

TOO_MANY_REQUESTS = "Too many requests. Please wait a minute and try again."


def _window_start(now: datetime, window_seconds: int) -> datetime:
    epoch = int(now.timestamp())
    return datetime.fromtimestamp(epoch - epoch % window_seconds, UTC)


def _hashed(key: str) -> str:
    return hmac.new(settings.secret_key.encode(), key.encode(), hashlib.sha256).hexdigest()


def hit(name: str, key: str, window_seconds: int, *, window_start: datetime | None = None) -> int:
    """Count one hit for `key` in bucket `name`; returns the hits in the window so far.

    Windows are aligned to the clock unless `window_start` pins one (e.g. a challenge's issue
    time, so its attempts are counted over its whole life).
    """
    if window_seconds > MAX_WINDOW.total_seconds():
        raise ValueError(f"Rate-limit windows can't be longer than {MAX_WINDOW}")
    statement = (
        insert(RateLimitBucket)
        .values(
            bucket=name,
            key=_hashed(key),
            window_start=window_start or _window_start(utcnow(), window_seconds),
            hits=1,
        )
        .on_conflict_do_update(
            index_elements=["bucket", "key", "window_start"],
            set_={"hits": RateLimitBucket.hits + 1},
        )
        .returning(RateLimitBucket.hits)
    )
    with engine.begin() as connection:
        return connection.execute(statement).scalar_one()


def enforce_limit(
    name: str,
    key: str,
    limit: int,
    window_seconds: int = 60,
    *,
    detail: str = TOO_MANY_REQUESTS,
) -> None:
    """Count a hit and raise 429 once `key` has more than `limit` hits in the window."""
    if hit(name, key, window_seconds) > limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail)


def client_ip(request: Request) -> str:
    """The caller's address (behind a proxy, as forwarded by the ASGI server)."""
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, limit: int, window_seconds: int = 60) -> Callable[[Request], None]:
    """Build a dependency that limits requests per client IP for the named bucket."""

    def dependency(request: Request) -> None:
        enforce_limit(name, f"ip:{client_ip(request)}", limit, window_seconds)

    return dependency


def reset_all_limits() -> None:
    """Forget every hit (used by tests)."""
    with engine.begin() as connection:
        connection.execute(delete(RateLimitBucket))


def purge_rate_limit_buckets(db: Session, now: datetime) -> None:
    """Worker job: delete buckets whose windows ended long ago."""
    db.execute(delete(RateLimitBucket).where(RateLimitBucket.window_start < now - MAX_WINDOW))
    db.commit()
