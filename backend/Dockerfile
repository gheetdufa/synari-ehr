FROM ghcr.io/astral-sh/uv:0.12.19@sha256:04d046b13e60d6bcec73cbc5e1cad25d680dea90c8573340950a0ac2d1aef424 AS uv

FROM python:3.12.14-slim-trixie@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

COPY --from=uv /uv /usr/local/bin/uv

# pg_dump/pg_restore (PostgreSQL 17 on trixie) for `python -m synari.admin backup`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# FORWARDED_ALLOW_IPS: the proxies whose X-Forwarded-For/-Proto uvicorn trusts (read by uvicorn
# itself). Only localhost by default; deploy/docker-compose.yml sets Caddy's address. Never
# use * unless nothing but your platform's proxy can reach the container.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PYTHONUNBUFFERED=1 \
    FORWARDED_ALLOW_IPS=127.0.0.1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY migrations ./migrations
COPY synari ./synari

RUN useradd --create-home --uid 10001 synari \
    && mkdir -p /app/data /backups \
    && chown synari /app/data /backups
USER synari

EXPOSE 8000
# Runs pending migrations, then serves the API. The worker uses: python -m synari.worker
# The access log is off: request paths can carry tokens. The API logs route templates instead.
CMD ["sh", "-c", "alembic upgrade head && uvicorn synari.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --no-access-log"]
