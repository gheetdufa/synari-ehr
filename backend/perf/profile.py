"""Count SQL statements and time every staff GET endpoint, per role, against a seeded database.

Finds N+1 queries and slow endpoints before they reach production:

    DATABASE_URL=postgresql+psycopg://synari:synari@localhost:5432/synari_perf \\
        SECRET_KEY=<the key the database was seeded with> \\
        uv run python -m perf.profile [--max-statements 25] [--max-ms 300]

Runs the app in-process (no server needed). Query parameters come from the OpenAPI schema
(dates for date parameters, this week for datetime ranges, a sample value for required text),
and record pages use a record from the role's own list. Exits non-zero if an endpoint goes
over a budget.
"""

import argparse
import logging
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import event

from synari.db import engine
from synari.main import app
from synari.ratelimit import reset_all_limits

ROLES = {
    "owner": "owner@perf.example.com",
    "clinician": "clinician1@perf.example.com",
    "biller": "biller@perf.example.com",
    "scheduler": "scheduler@perf.example.com",
}
# Downloads of a whole log or record are expected to take longer than a screen.
EXPORT_MAX_MS = 5000
SKIP_PREFIXES = ("/api/portal", "/api/booking", "/api/ws", "/api/webhooks", "/api/auth")
# Record pages, each opened on the first row of a list the role can see.
RECORD_PAGES = {
    "/api/clients/{client_id}": "/api/clients",
    "/api/notes/{note_id}": "/api/notes",
    "/api/conversations/{conversation_id}/messages": "/api/conversations",
    "/api/billing/invoices/{invoice_id}": "/api/billing/invoices",
    "/api/claims/{claim_id}": "/api/claims",
}
SAMPLE_TEXT = "ae"
REPORT_DAYS = 30


class StatementCounter:
    """Counts statements executed on the engine."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(self, *_: Any) -> None:
        self.count += 1


@contextmanager
def counting() -> Iterator[StatementCounter]:
    """Count the SQL statements run inside the block."""
    counter = StatementCounter()
    event.listen(engine, "before_cursor_execute", counter)
    try:
        yield counter
    finally:
        event.remove(engine, "before_cursor_execute", counter)


def _formats(schema: dict[str, Any]) -> set[str]:
    """The string formats a parameter schema allows (e.g. {"date"} for `date | None`)."""
    options = schema.get("anyOf", [schema])
    return {option["format"] for option in options if "format" in option}


def query_params(operation: dict[str, Any]) -> dict[str, str]:
    """Plausible values for an operation's date range and required query parameters.

    Date ranges cover the last 30 days (reports, claims); datetime ranges cover this week
    (calendar).
    """
    now = datetime.now(UTC)
    week_start = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    ranges = {
        "date": {
            "start": (now - timedelta(days=REPORT_DAYS)).date().isoformat(),
            "end": now.date().isoformat(),
        },
        "date-time": {
            "start": week_start.isoformat(),
            "end": (week_start + timedelta(days=7)).isoformat(),
        },
    }
    params: dict[str, str] = {}
    for parameter in operation.get("parameters", []):
        if parameter["in"] != "query":
            continue
        name = parameter["name"]
        formats = _formats(parameter.get("schema", {}))
        kind = next((fmt for fmt in ("date", "date-time") if fmt in formats), None)
        if name in ("start", "end") and kind is not None:
            params[name] = ranges[kind][name]
        elif parameter.get("required"):
            params[name] = SAMPLE_TEXT
    return params


def list_routes() -> dict[str, dict[str, str]]:
    """Staff GET routes without path parameters, with their query parameters."""
    return {
        path: query_params(operations["get"])
        for path, operations in sorted(app.openapi()["paths"].items())
        if "get" in operations and "{" not in path and not path.startswith(SKIP_PREFIXES)
    }


def record_routes(api: TestClient, headers: dict[str, str]) -> dict[str, dict[str, str]]:
    """Record pages opened on the first row of the role's own lists (skipped when empty)."""
    routes: dict[str, dict[str, str]] = {}
    for template, list_path in RECORD_PAGES.items():
        response = api.get(list_path, headers=headers, params={"limit": 1})
        rows = response.json() if response.status_code == 200 else []
        if rows:
            field = template[template.index("{") + 1 : template.index("}")]
            routes[template.replace(f"{{{field}}}", str(rows[0]["id"]))] = {}
    return routes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--password", default="load-test-password")
    parser.add_argument("--max-statements", type=int, default=25)
    parser.add_argument("--max-ms", type=float, default=300)
    args = parser.parse_args()
    for name in ("httpx", "httpx2"):
        logging.getLogger(name).setLevel(logging.WARNING)
    over_budget = []
    with TestClient(app) as api:
        for role, email in ROLES.items():
            reset_all_limits()
            login = api.post("/api/auth/login", json={"email": email, "password": args.password})
            headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
            print(f"\n== {role}")
            routes = {**list_routes(), **record_routes(api, headers)}
            for path, params in routes.items():
                api.get(path, headers=headers, params=params)  # warm caches
                with counting() as counter:
                    started = time.perf_counter()
                    response = api.get(path, headers=headers, params=params)
                    elapsed = (time.perf_counter() - started) * 1000
                flag = ""
                max_ms = EXPORT_MAX_MS if path.endswith("/export") else args.max_ms
                if response.status_code < 400 and (
                    counter.count > args.max_statements or elapsed > max_ms
                ):
                    flag = "  <-- over budget"
                    over_budget.append((role, path, counter.count, elapsed))
                status = response.status_code
                print(f"{status} {counter.count:>4} sql {elapsed:>8.1f} ms  {path}{flag}")
    if over_budget:
        print(f"\n{len(over_budget)} endpoint(s) over budget")
        sys.exit(1)
    print("\nEvery endpoint is within budget")


if __name__ == "__main__":
    main()
