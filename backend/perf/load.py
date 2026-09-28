"""Load-test a running API with virtual staff users on a realistic, weighted mix of screens.

Start the API against a database seeded by `perf.seed` (with the same SECRET_KEY or
DATA_ENCRYPTION_KEYS), then:

    uv run python -m perf.load --base-url http://localhost:8031 --users 25 --duration 60

Each virtual user signs in as a seeded staff member (mostly clinicians, plus the owner, the
practice manager, a biller and a scheduler), then keeps opening screens chosen by weight for
their role, making the requests the web app makes for that screen, with a pause between
screens. Prints throughput, the error rate and p50/p95/p99 latency per endpoint; exits
non-zero when the error rate is over --max-error-rate.

Every virtual user sends its own X-Forwarded-For address, as real users come from their own
networks (the sign-in rate limit is per address); uvicorn trusts it from 127.0.0.1 only.

With --realtime-url, checks instead that realtime events cross API processes: a WebSocket
connected to --realtime-url receives the event for a message sent through --base-url.
"""

import argparse
import asyncio
import contextlib
import json
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from websockets.asyncio.client import connect

PASSWORD = "load-test-password"
SEEDED_CLINICIANS = 24
REPORT_DAYS = 30
LIST_PAGES = 10
SEARCH_TERMS = [
    "riv",
    "chen",
    "pat",
    "ngu",
    "gar",
    "smi",
    "oka",
    "kim",
    "sil",
    "coh",
    "alex",
    "sam",
]
# Share of virtual users per role; clinicians are most of a group practice's staff.
ROLE_SHARES = {"clinician": 70, "biller": 10, "scheduler": 10, "owner": 5, "manager": 5}
REALTIME_TIMEOUT_SECONDS = 10
# Sign-ins hash a password each, so only a few run at once.
SIGN_IN_CONCURRENCY = 8


@dataclass
class Stats:
    """Requests, response latencies (ms) and failures (errors or no response) per endpoint."""

    requests: Counter[str] = field(default_factory=Counter)
    latencies: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    errors: Counter[str] = field(default_factory=Counter)
    elapsed: float = 0.0


@dataclass
class VirtualUser:
    """One signed-in staff member clicking through the app."""

    api: httpx.AsyncClient
    headers: dict[str, str]
    staff_id: int
    role: str
    rng: random.Random
    stats: Stats

    async def get(self, endpoint: str, path: str, **params: Any) -> Any:
        """GET a path, recording its latency under `endpoint`; the JSON body, or None."""
        self.stats.requests[endpoint] += 1
        started = time.perf_counter()
        try:
            response = await self.api.get(path, params=params, headers=self.headers)
        except httpx.HTTPError:
            self.stats.errors[endpoint] += 1
            return None
        self.stats.latencies[endpoint].append((time.perf_counter() - started) * 1000)
        if response.status_code >= 400:
            self.stats.errors[endpoint] += 1
            return None
        return response.json()

    def pick(self, rows: Any) -> Any:
        """A random row of a list response, or None when it's empty or failed."""
        return self.rng.choice(rows) if rows else None


def _week(rng: random.Random) -> dict[str, str]:
    """A calendar week between four weeks back and three ahead."""
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=rng.randint(-4, 3))
    return {"start": monday.isoformat(), "end": (monday + timedelta(days=7)).isoformat()}


def _period() -> dict[str, str]:
    today = datetime.now(UTC).date()
    return {"start": (today - timedelta(days=REPORT_DAYS)).isoformat(), "end": today.isoformat()}


# Screens: the requests the web app makes when someone opens it --------------------------------


async def dashboard(user: VirtualUser) -> None:
    await user.get("GET /dashboard", "/api/dashboard")
    await user.get("GET /messages/unread-count", "/api/messages/unread-count")
    await user.get("GET /notifications/unread-count", "/api/notifications/unread-count")


async def own_calendar(user: VirtualUser) -> None:
    week = _week(user.rng)
    await user.get(
        "GET /appointments (own week)", "/api/appointments", **week, clinician_ids=user.staff_id
    )
    await user.get("GET /appointment-requests", "/api/appointment-requests")


async def practice_calendar(user: VirtualUser) -> None:
    await user.get("GET /appointments (practice week)", "/api/appointments", **_week(user.rng))
    await user.get("GET /appointment-requests", "/api/appointment-requests")


async def client_search(user: VirtualUser, access: str = "profile") -> None:
    found = await user.get(
        "GET /clients?q", "/api/clients", q=user.rng.choice(SEARCH_TERMS), access=access, limit=8
    )
    client = user.pick(found)
    if client is not None:
        await user.get("GET /clients/{id}", f"/api/clients/{client['id']}")


async def client_list(user: VirtualUser) -> None:
    offset = user.rng.randrange(LIST_PAGES) * 50
    await user.get("GET /clients (page)", "/api/clients", offset=offset)


async def notes(user: VirtualUser) -> None:
    listed = await user.get("GET /notes", "/api/notes")
    note = user.pick(listed)
    if note is not None:
        await user.get("GET /notes/{id}", f"/api/notes/{note['id']}")


async def inbox(user: VirtualUser) -> None:
    listed = await user.get("GET /conversations", "/api/conversations")
    conversation = user.pick(listed)
    if conversation is not None:
        await user.get(
            "GET /conversations/{id}/messages",
            f"/api/conversations/{conversation['id']}/messages",
        )


async def billing(user: VirtualUser) -> None:
    await user.get("GET /billing/overview", "/api/billing/overview")
    offset = user.rng.randrange(LIST_PAGES) * 50
    await user.get("GET /billing/invoices", "/api/billing/invoices", offset=offset)


async def payments(user: VirtualUser) -> None:
    offset = user.rng.randrange(LIST_PAGES) * 50
    await user.get("GET /billing/payments", "/api/billing/payments", offset=offset)


async def uninvoiced(user: VirtualUser) -> None:
    await user.get("GET /billing/uninvoiced", "/api/billing/uninvoiced")


async def client_billing(user: VirtualUser) -> None:
    found = await user.get(
        "GET /clients?q", "/api/clients", q=user.rng.choice(SEARCH_TERMS), access="billing", limit=8
    )
    client = user.pick(found)
    if client is not None:
        await user.get(
            "GET /billing/clients/{id}/summary", f"/api/billing/clients/{client['id']}/summary"
        )
        await user.get(
            "GET /billing/invoices?client_id", "/api/billing/invoices", client_id=client["id"]
        )


async def claims(user: VirtualUser) -> None:
    await user.get("GET /claims/unbilled", "/api/claims/unbilled")
    await user.get("GET /claims/summary", "/api/claims/summary")
    await user.get("GET /claims", "/api/claims")


async def reports(user: VirtualUser) -> None:
    report = user.rng.choice(["income", "sessions", "aging"])
    params = {} if report == "aging" else _period()
    await user.get(f"GET /reports/{report}", f"/api/reports/{report}", **params)


Screen = Callable[[VirtualUser], Awaitable[None]]


async def billing_client_search(user: VirtualUser) -> None:
    await client_search(user, access="billing")


ROLE_MIX: dict[str, list[tuple[Screen, int]]] = {
    "clinician": [
        (dashboard, 20),
        (own_calendar, 25),
        (client_search, 15),
        (notes, 15),
        (inbox, 15),
        (billing, 5),
        (reports, 5),
    ],
    "biller": [
        (dashboard, 10),
        (billing, 20),
        (payments, 10),
        (uninvoiced, 10),
        (claims, 20),
        (client_billing, 15),
        (reports, 15),
    ],
    "scheduler": [(dashboard, 20), (practice_calendar, 50), (client_search, 20), (client_list, 10)],
    "owner": [
        (dashboard, 20),
        (practice_calendar, 20),
        (reports, 20),
        (billing, 15),
        (client_search, 15),
        (inbox, 10),
    ],
    "manager": [
        (dashboard, 20),
        (practice_calendar, 25),
        (reports, 20),
        (billing, 15),
        (billing_client_search, 10),
        (client_list, 10),
    ],
}


# Running ---------------------------------------------------------------------------------------


def _accounts(users: int) -> list[tuple[str, str]]:
    """(role, email) per virtual user, in the ROLE_SHARES proportions (at least one of each
    other role; clinicians fill the rest)."""
    counts = {
        role: max(1, round(users * share / 100))
        for role, share in ROLE_SHARES.items()
        if role != "clinician"
    }
    accounts = [
        (role, f"{role}@perf.example.com") for role, count in counts.items() for _ in range(count)
    ]
    accounts += [
        ("clinician", f"clinician{index % SEEDED_CLINICIANS + 1}@perf.example.com")
        for index in range(users - len(accounts))
    ]
    return accounts


async def _sign_in(api: httpx.AsyncClient, email: str, password: str, address: str) -> str:
    response = await api.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers={"X-Forwarded-For": address},
    )
    response.raise_for_status()
    return str(response.json()["access_token"])


async def _run_user(user: VirtualUser, deadline: float, think: float) -> None:
    screens, weights = zip(*ROLE_MIX[user.role], strict=True)
    while time.monotonic() < deadline:
        screen = user.rng.choices(screens, weights=weights)[0]
        await screen(user)
        await asyncio.sleep(user.rng.uniform(0.5, 1.5) * think)


async def run_load(args: argparse.Namespace) -> Stats:
    """Sign every virtual user in, then run them all until the duration is up.

    Each virtual user has its own HTTP connection, as each person's browser does.
    """
    rng = random.Random(args.seed)
    stats = Stats()
    signing_in = asyncio.Semaphore(SIGN_IN_CONCURRENCY)

    async def sign_in(index: int, role: str, email: str, api: httpx.AsyncClient) -> VirtualUser:
        address = f"10.{index // 250}.{index % 250}.1"
        async with signing_in:
            token = await _sign_in(api, email, args.password, address)
        headers = {"Authorization": f"Bearer {token}", "X-Forwarded-For": address}
        session = (await api.get("/api/me", headers=headers)).json()
        return VirtualUser(
            api, headers, session["staff"]["id"], role, random.Random(rng.random()), stats
        )

    async with contextlib.AsyncExitStack() as stack:
        accounts = _accounts(args.users)
        urls = args.base_url.split(",")
        clients = [
            await stack.enter_async_context(
                httpx.AsyncClient(base_url=urls[index % len(urls)], timeout=30)
            )
            for index in range(len(accounts))
        ]
        users = await asyncio.gather(
            *(
                sign_in(index, role, email, api)
                for index, ((role, email), api) in enumerate(zip(accounts, clients, strict=True))
            )
        )
        print(f"{len(users)} users signed in: {Counter(user.role for user in users)}")
        started = time.monotonic()
        deadline = started + args.duration

        async def start(user: VirtualUser, delay: float) -> None:
            await asyncio.sleep(delay)
            await _run_user(user, deadline, args.think)

        await asyncio.gather(
            *(start(user, args.ramp * index / len(users)) for index, user in enumerate(users))
        )
        stats.elapsed = time.monotonic() - started
    return stats


def _percentiles(values: list[float]) -> tuple[float, float, float]:
    if len(values) == 1:
        return values[0], values[0], values[0]
    cuts = statistics.quantiles(values, n=100, method="inclusive")
    return cuts[49], cuts[94], cuts[98]


def report(stats: Stats, users: int) -> float:
    """Print the results table; returns the error rate."""
    total = sum(stats.requests.values())
    errors = sum(stats.errors.values())
    error_rate = errors / total if total else 0.0
    every = [ms for values in stats.latencies.values() for ms in values]
    p50, p95, p99 = _percentiles(every) if every else (0.0, 0.0, 0.0)
    print(
        f"\n{users} users, {stats.elapsed:.0f} s: {total} requests, "
        f"{total / stats.elapsed:.1f} req/s, {errors} errors ({error_rate:.2%}); "
        f"p50 {p50:.0f} ms, p95 {p95:.0f} ms, p99 {p99:.0f} ms"
    )
    print(
        f"\n{'endpoint':<36} {'count':>6} {'errors':>6} {'p50':>6} {'p95':>6} {'p99':>6} {'max':>6}"
    )
    for name, count in stats.requests.most_common():
        values = stats.latencies[name] or [0.0]
        p50, p95, p99 = _percentiles(values)
        print(
            f"{name:<36} {count:>6} {stats.errors[name]:>6} {p50:>6.0f} {p95:>6.0f} "
            f"{p99:>6.0f} {max(values):>6.0f}"
        )
    return error_rate


async def check_realtime(base_url: str, realtime_url: str, password: str) -> None:
    """Send a message through one API process and wait for its event on another's WebSocket."""
    async with httpx.AsyncClient(base_url=base_url, timeout=30) as api:
        token = await _sign_in(api, "clinician1@perf.example.com", password, "10.255.0.1")
        headers = {"Authorization": f"Bearer {token}"}
        [conversation] = (
            await api.get("/api/conversations", params={"limit": 1}, headers=headers)
        ).json()
        socket_url = realtime_url.replace("http", "ws", 1).rstrip("/") + "/api/ws"
        async with connect(socket_url) as socket:
            await socket.send(json.dumps({"type": "auth", "token": token}))
            ready = json.loads(await socket.recv())
            if ready.get("type") != "ready":
                raise SystemExit(f"WebSocket on {realtime_url} didn't accept the token: {ready}")
            sent_at = time.perf_counter()
            sent = await api.post(
                f"/api/conversations/{conversation['id']}/messages",
                json={"body": "Load test: realtime check"},
                headers=headers,
            )
            sent.raise_for_status()
            message_id = sent.json()["id"]
            async with asyncio.timeout(REALTIME_TIMEOUT_SECONDS):
                while True:
                    event = json.loads(await socket.recv())
                    data = event.get("data", {})
                    if event.get("type") == "message.created" and (
                        data.get("message_id") == message_id
                    ):
                        break
    elapsed = (time.perf_counter() - sent_at) * 1000
    print(
        f"Realtime OK: message {message_id} sent through {base_url} reached a WebSocket on "
        f"{realtime_url} {elapsed:.0f} ms after the request started"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--base-url",
        default="http://localhost:8031",
        help="API URL; with several (comma-separated) users are spread round-robin, like a "
        "load balancer in front of separate API processes",
    )
    parser.add_argument("--users", type=int, default=25)
    parser.add_argument("--duration", type=float, default=60, help="seconds")
    parser.add_argument("--ramp", type=float, default=5, help="seconds to start every user")
    parser.add_argument("--think", type=float, default=1.0, help="mean pause between screens")
    parser.add_argument("--password", default=PASSWORD)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--max-error-rate", type=float, default=0.01)
    parser.add_argument("--realtime-url", help="check realtime delivery through this server")
    args = parser.parse_args()
    if args.realtime_url:
        asyncio.run(check_realtime(args.base_url.split(",")[0], args.realtime_url, args.password))
        return
    error_rate = report(asyncio.run(run_load(args)), args.users)
    if error_rate > args.max_error_rate:
        sys.exit(1)


if __name__ == "__main__":
    main()
