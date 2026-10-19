FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv

FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

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
