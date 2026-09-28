# Synari API

FastAPI + SQLAlchemy 2 + Postgres. Python 3.12, managed with [uv](https://docs.astral.sh/uv/).

## Run it locally

```bash
docker compose up -d db mailpit livekit   # from the repo root
cp backend/.env.example backend/.env      # then set SECRET_KEY
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn synari.main:app --reload --port 8000 --no-access-log   # docs: /api/docs
uv run python -m synari.worker                        # emails, reminders, invoices, AutoPay
```

Emails sent in development show up in Mailpit at http://localhost:8025.

## Tests and linting

```bash
uv run pytest -q                     # needs the docker Postgres; each run uses a throwaway database
                                     # (backup tests also need pg_dump/pg_restore 17 on PATH)
uv run ruff format synari tests migrations perf
uv run ruff check synari tests migrations perf
uv run alembic check                 # fails if models and migrations have drifted
```

Query counts, timings and load tests against a large seeded practice: `perf/README.md`.

## Layout

```
synari/
  main.py          app factory, middleware, router registration
  config.py        all settings (env vars); integrations switch off when unconfigured
  db.py            engine, session, Base (naming convention), TimestampMixin, utcnow()
  security.py      password hashing, JWTs, opaque tokens
  ratelimit.py     rate limits shared by every process (Postgres buckets)
  admin.py         operator commands: python -m synari.admin reset-mfa|unlock|create-owner|
                   audit-verify|reencrypt|backup|restore-test
  permissions.py   staff roles and the capabilities each one grants
  access.py        Access: which clients, records and calendars a staff member can reach
  deps.py          DbSession, CurrentStaff, CurrentAccess, CurrentClient, CurrentPortalActor
  pagination.py    ListPage / QueuePage (limit, offset) and paginate() (X-Total-Count)
  audit.py         audit_staff / audit_client / audit_anonymous
  crypto.py        EncryptedText / EncryptedJSON columns (DATA_ENCRYPTION_KEYS)
  logs.py          JSON logging with request ids and redaction of identifiers and tokens
  middleware.py    request logging by route template, security headers
  realtime.py      publish() events over Postgres NOTIFY -> WebSocket hub
  worker.py        background job loop (JOBS list)
  admin.py         `python -m synari.admin <command>`: reencrypt, backup, restore-test, ...
  claims/          DB-free claims engine: claim documents, validation, X12 837P/835/277CA/999,
                   Stedi client, CMS-1500 printing
  models/          one module per domain; enums.py holds every status/type
  schemas/         Pydantic request/response models per domain
  api/             routers per domain (staff routes and /portal/* client routes)
  services/        business logic and integrations (outbox, email, storage, scheduling, ...)
migrations/        Alembic
tests/             pytest; conftest.py has fixtures and helpers
perf/              seed a large practice, profile SQL per endpoint, load test (see its README)
```

## The model in one paragraph

A **practice** is the tenant: it owns clients, services, locations, forms, appointments,
records and billing. **Staff members** belong to one practice and have a role (owner,
clinician, practice manager, biller, scheduler); clinicians also have an access level (basic,
billing, client list, practice). A client's **care team** (one primary clinician plus others)
decides which clinicians can open their chart; supervisors also reach their supervisees'
clients. **Appointments** belong to a clinician's calendar and have one or more
**participants** (couples, families and groups), each with their own attendance, fee, amount
owed, reminders and video link. **Contacts** (guardians, emergency contacts, the person
responsible for billing) can sign into the client portal on a client's behalf.

## Conventions

- **Two kinds of users.** Staff use `/api/...` routes; clients (and their portal contacts) use
  `/api/portal/...` routes with `CurrentClient` / `CurrentPortalActor`. Tokens carry a role, so
  one can never call the other's routes.
- **Load everything through `Access`.** Staff routes take `access: CurrentAccess` and use
  `access.get(Model, id)` for practice rows, `access.client(id, level)` and
  `access.client_record(Model, id, level)` for client data, `access.client_filter(level)` in list
  queries, `access.require(Capability.X)` for role gates and `access.require_calendar(id)` for
  calendars. Levels are `ClientAccess.PROFILE` (demographics, schedule), `CLINICAL` (notes,
  diagnoses, documents, messages, form answers) and `BILLING`. Anything out of reach is a 404;
  a missing role permission is a 403. Portal routes must check the row belongs to the client.
  Never query by id alone.
- **Tell the right people.** Realtime events and notifications go only to staff who could open
  the record (`services/recipients.py`); staff emails respect each person's notification
  preferences.
- **Audit PHI access.** Viewing or changing clinical or personal data calls `audit_staff` /
  `audit_client` before `db.commit()`, passing `client_id=` for the client whose record it
  touches (it feeds the client's access history). Lists that name clients call
  `audit_staff_list` once with the ids shown. Events are append-only: the worker seals them into
  per-practice hash chains (`services/audit_chain.py`), the database refuses to change or delete
  them, and `python -m synari.admin audit-verify` recomputes the chains.
- **Signed records are hashed.** Signing or co-signing a note keeps a hashed `NoteRevision`;
  changes after signing are addenda (`services/note_records.py`). Psychotherapy notes are only
  for their author (and co-signing supervisor): filter with `readable_notes(access)` and leave
  them out of anything that leaves the author's hands with `part_of_record()`.
- **Sessions are server-side.** Sign-in creates an `AuthSession` (`services/sessions.py`); access
  tokens name it and every request checks it isn't revoked, idle (the practice's
  `session_idle_minutes`; the portal's `PORTAL_IDLE_MINUTES`) or past its lifetime. Refresh
  tokens are opaque and rotate on each use; reuse revokes the session. Staff who must use 2FA
  and haven't set it up get an enrollment-only session: routes taking `CurrentStaff` /
  `CurrentAccess` answer 403 until they do (`EnrollingStaffSession` routes still work).
- **Security events.** Record anything an owner should review with
  `services/security_events.record_security_event(...)` (ids and counts only); warnings and
  critical events alert the practice's reviewers in the app and by email.
- **Emergency access.** Clinicians can open a chart outside their care team for four hours with
  a stated reason (`services/emergency_access.py`); `Access` honors the grant at the PROFILE and
  CLINICAL levels and audit events about that client carry `emergency: true`.
- **Rate limits** use `rate_limit(name, limit, window_seconds)` as a route dependency (per IP)
  or `enforce_limit(name, key, ...)` inside a handler (per account or email).
- **Handlers are sync `def`** (FastAPI runs them in a thread pool). Commit once at the end of a
  handler. Use `db.flush()` when you need generated ids.
- **Lists grow with the practice, so page them.** A list endpoint takes `page: ListPage` (or
  `QueuePage` for work queues picked in bulk) and `response: Response`, orders by something
  unique last, and runs the query through `paginate()`, which sets `X-Total-Count`. Load what
  each row shows in bulk (selectin/contains_eager or one `IN` query), never per row; totals
  and counts are SQL aggregates. `perf/profile.py` checks every endpoint stays under 25 SQL
  statements on a large seeded practice.
- **Money is integer cents.** Datetimes are timezone-aware UTC in the database and API. Convert
  only for display and wall-clock rules: the practice's zone for billing days and practice-wide
  jobs, a clinician's zone for their calendar, the client's zone (else the clinician's) for
  client-facing times. `services/scheduling.zone_of()` returns either.
- **Files are encrypted at rest** with per-file keys (`services/file_encryption.py`), without
  callers doing anything: use `store_upload()`, or `get_storage().save()` / `.save_stream()`
  (large files) and then add the `StoredFile` row for that key in the same process, which picks
  up the wrapped key when inserted. Read with `file_response(stored)` or
  `get_storage().read()` / `.stream()`.
- **Logs never carry health information.** Log ids and counts, never names, emails, note text
  or request paths (they can hold tokens). Logs are JSON with a request id; `logs.redact()`
  scrubs emails, phone numbers and tokens as a safety net, and SQL errors hide bound values.
- **Status/type values** live in `models/enums.py` as `StrEnum`s and are stored as strings.
- **Email and SMS go through the outbox** (`services/outbox.py`, `services/portal_links.py`),
  never sent inline. Messages never contain clinical content: they say something happened and
  link back to the app. Use `dedupe_key` for anything a job might queue twice.
- **Realtime events** carry ids only: `publish(db, recipients, "thing.changed", {...})` inside
  the same transaction as the change.
- **Calendar sync**: code that creates, changes, cancels or deletes an appointment calls
  `services/calendar_sync/hooks.appointment_changed(db, appointment)` before committing (after
  `db.delete()` for a deletion); the worker pushes the change to connected calendars. Anything
  offering bookable times also subtracts `busy.external_busy_intervals(...)`.
- **Worker jobs** are `def job(db: Session, now: datetime) -> None`, added to `JOBS` in
  `worker.py`. Lock rows with `with_for_update(skip_locked=True)` and make jobs idempotent.
- **Schema changes**: edit models, then `uv run alembic revision --autogenerate -m "..."` and
  review the generated file.
- **Errors**: raise `HTTPException` with a human-readable `detail`. Unexpected exceptions become
  a generic 500 and are logged.
- **Tests** use the `api`, `db` and `clinician` fixtures (the owner-clinician of a new practice)
  plus helpers in `tests/conftest.py`: `register_practice`, `add_staff` (any role),
  `create_client_record`, `assign_clinician`, `create_appointment`, `portal_headers`,
  `outbound_to`, `link_token`. Practice ids start at 501 in tests so mixing them up with staff
  or client ids fails loudly. Cover every role for new endpoints. Mock external services
  (Stripe, Twilio, OpenAI, LiveKit, Stedi) at the module boundary with `monkeypatch`.
