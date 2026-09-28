# Performance tools

Three tools for checking that Synari stays fast as a group practice's history grows:

- `perf/seed.py` builds a large, fictional group practice in an empty database.
- `perf/profile.py` counts SQL statements and times every staff GET endpoint per role,
  in-process. It fails when an endpoint goes over a budget (25 statements, 300 ms by default).
- `perf/load.py` runs virtual staff users against a running API and reports throughput,
  error rate and p50/p95/p99 latency per endpoint. It can also check that realtime events
  reach browsers connected to a different API process.

## The seeded practice

`python -m perf.seed` (defaults) creates one practice with 28 staff (the owner and 24 other
clinicians, a biller, a scheduler and a practice manager), 5,000 clients (one in ten billed to
insurance), two years of weekly sessions plus four weeks ahead (48,600 appointments, 62,100
participants including groups), 47,872 signed notes, 53,228 invoices, 48,793 payments, 5,236
insurance claims, 5,000 conversations with 50,000 messages and 97,200 audit events. Every staff
password is `load-test-password`; sign in as `owner@`, `clinician1@` to `clinician24@`,
`biller@`, `scheduler@` or `manager@perf.example.com`.

## Reproduce

Use a throwaway database and the same `SECRET_KEY` (or `DATA_ENCRYPTION_KEYS`) for every step:
encrypted columns written by the seed can only be read with the key they were written with.

```bash
docker compose exec db createdb -U synari synari_perf      # from the repo root
cd backend
export DATABASE_URL=postgresql+psycopg://synari:synari@localhost:5432/synari_perf
export SECRET_KEY=$(openssl rand -hex 32) RUN_WORKER_IN_API=false
uv run alembic upgrade head
uv run python -m perf.seed                 # about a minute
docker compose exec db psql -U synari -d synari_perf -c 'VACUUM ANALYZE'

uv run python -m perf.profile              # exit 1 if any endpoint is over budget

uv run uvicorn synari.main:app --port 8031 --workers 4 --no-access-log &
uv run python -m perf.load --base-url http://localhost:8031 --users 25 --duration 60
uv run python -m perf.load --base-url http://localhost:8031 --users 100 --duration 60 --ramp 10

# Realtime across processes: two API processes, a WebSocket on one, the action on the other.
uv run uvicorn synari.main:app --port 8032 --no-access-log &
uv run python -m perf.load --base-url http://localhost:8031 --realtime-url http://localhost:8032
```

`perf.load` options: `--users`, `--duration`, `--ramp` (seconds to start everyone), `--think`
(mean pause between screens, default 1 s; 0 finds the saturation point) and `--base-url`
(several comma-separated URLs spread users round-robin, like a load balancer in front of
separate API processes). Each virtual user signs in as a seeded staff member with its own
connection and client address, then keeps opening screens chosen by weight for its role:

| Role (share of users) | Screens |
|---|---|
| Clinician (70%) | dashboard, own calendar week, client search and chart, notes list and note, inbox and thread, billing overview, reports |
| Biller (10%) | dashboard, billing overview and invoices, payments, uninvoiced sessions, claims queue and claims, client billing, reports |
| Scheduler (10%) | dashboard, practice calendar week, client search, client list |
| Owner (5%), practice manager (5%) | dashboard, practice calendar, reports, billing, client search, inbox (owner) |

## Results

Measured on 2026-09-26 on an Apple M5 Pro laptop (18 cores, 64 GB) running Postgres 17 in
Docker Desktop, with the load generator on the same machine. **The machine was shared**: other
agents' test suites were using the same Postgres container and the load average stayed between
12 and 45 throughout, so treat these numbers as a lower bound and compare runs relative to each
other. Production hardware (a dedicated database, Linux) should do better.

### SQL statements and time per request (profiler, owner and biller)

| Endpoint | Before: SQL | Before: ms | After: SQL | After: ms |
|---|---:|---:|---:|---:|
| `GET /billing/invoices` | 132 | 2,886 / 3,002 | 9 | 14 |
| `GET /billing/payments` | 121 | 1,897 / 1,972 | 7 | 12–14 |
| `GET /billing/uninvoiced` | 2,371 | 1,333 / 1,004 | 7 | 57–63 |
| `GET /billing/overview` | 269 | 229 / 327 | 6 | 31–35 |
| `GET /clients` | 12 | 225 / 254 | 4 | 6–7 |
| `GET /conversations` (owner) | 16 | 433 | 8 | 14 |
| `GET /notes` (owner) | 5 | 71 | 6 | 16 |
| `GET /appointments` (practice week) | 7 | 39–86 | 7 | 34–37 |
| `GET /reports/aging` | 26 | 272 / 298 | 5 | 18–25 |
| `GET /reports/income` | 15 | 181 / 117 | 8 | 23–28 |
| `GET /reports/sessions` | 14 | 246 / 286 | 5 | 8–9 |
| `GET /claims` | 422 (bad params) | – | 9 | 10–14 |
| `GET /claims/unbilled` | 422 (bad params) | – | 9 | 22–23 |

Every staff GET endpoint now runs at most 18 statements (the claim detail) regardless of how
much data the practice has, and `perf.profile` exits 0 with the default budgets. "Before" is
the original unpaginated API on the same seed without claims; "after" includes the 5,236 claims.

What changed: long lists are paged (`limit`/`offset` with `X-Total-Count`) and clients are
searched on the server; what clients owe (copays under the primary policy in effect that day) is
computed in SQL instead of one policy lookup per session; the uninvoiced count is a SQL count
whose filters Postgres can estimate (so it plans an anti-join instead of 56,000 index probes);
aging, sessions and income aggregate in SQL; and indexes back the lists' sort orders and the
calendar's date range.

### Indexes (EXPLAIN ANALYZE on the seeded practice)

| Index | Query | Before | After |
|---|---|---:|---:|
| `notes (practice_id, created_at, id)` | notes list page, newest first | 22 ms (sort of 47,872 rows) | 0.2 ms |
| `notes (practice_id, client_id)` | notes list count | 136 ms (heap scan of note text) | 7 ms (index only) |
| `invoices (practice_id, issued_on, id)` | invoices list page | 19 ms | 0.5 ms |
| `payments (practice_id, created_at, id)` | payments list page | 16 ms | 0.2 ms |
| `payments (practice_id, received_at)` | collected this month, income report | 4.9 ms | 1.7 ms |
| `appointments (practice_id, ends_at)` | calendar week (entries overlapping the week) | 15 ms (seq scan) | 0.4 ms |

The single-column `practice_id` indexes on notes, invoices and payments were dropped: the new
indexes (or the invoice number constraint) start with `practice_id`. Indexes that measured no
difference on this data were left out: audit log `(practice_id, id)` (the primary key already
serves the newest-first keyset), messages `(conversation_id, created_at)` (threads are short)
and `lower(last_name)` (client search matches anywhere in a name, which a b-tree can't serve;
5,000 clients scan in a few milliseconds).

### Load test: uvicorn with 4 workers, 60 s, think time 0.5–1.5 s

| Users | Requests | Throughput | Errors | p50 | p95 | p99 |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | 2,926 | 47.8 req/s | 0 | 13 ms | 52 ms | 119 ms |
| 100 | 10,917 | 177.4 req/s | 0 | 18 ms | 143 ms | 251 ms |
| 100, no think time (30 s) | 10,708 | 350.6 req/s | 0 | 160 ms | 766 ms | 1,143 ms |

With think time the throughput is what the users ask for (it scales with the number of users);
the no-think run is the saturation point. At 100 users the slowest screens were the practice
calendar week (p95 236 ms), the uninvoiced list (p95 275 ms) and the dashboard (p95 179 ms).

`uvicorn --workers` shares one listening socket, and on macOS the workers took the connections
very unevenly (for example 58, 31, 9 and 2 of 100), so one worker saturated while others idled;
that is what the tail above measures. Spreading users round-robin over four single-process
servers (`--base-url` with four URLs) instead reached 383 req/s at saturation with a p99 of
564 ms, although the machine was busier during that run. How evenly workers share a socket
depends on the operating system, so measure on your own hardware; for an even spread, run
several API containers behind Caddy's `reverse_proxy` (round-robin) and size the database pool
as in `deploy/README.md`.

### After the security, estimates and import work (2026-09-26, same seed)

Every request now also checks its server-side session, clinical columns and files are
encrypted, and the audit log checks for emergency access. Re-measured with 2FA off for the
virtual users (`REQUIRE_STAFF_MFA=false`); the machine was shared with a browser test run.

| Users | Requests | Throughput | Errors | p50 | p95 | p99 |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | 2,918 | 47.7 req/s | 0 | 17 ms | 58 ms | 130 ms |
| 100 | 10,668 | 173.3 req/s | 0 | 25 ms | 183 ms | 321 ms |

The profiler found the good faith estimates queue checking each client separately (9,148
statements, 3.3 s for the owner on 5,000 clients) and the uninvoiced list's estimate warnings
adding a few statements per client (73 to 88). Both now load in bulk: the queue runs 25
statements (170 to 250 ms, 30 ms for a clinician) and the uninvoiced list 11, and every staff
GET endpoint is within the default budgets again. Downloads that export a whole log have their
own 5 s budget (`EXPORT_MAX_MS`); the activity log export took 0.8 s for 97,200 events.

### Realtime across processes

Two single-worker API processes on ports 8031 and 8032: a message sent through one reached the
clinician's WebSocket on the other 33 ms after the request started, and 29 ms the other way.
Events travel through Postgres `NOTIFY`, so every API process delivers them to its own sockets.
