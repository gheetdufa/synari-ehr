"""ASGI middleware: request logging by route template, request ids and security headers."""

import logging
import re
import time
import uuid

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from synari.logs import request_id

logger = logging.getLogger("synari.request")

REQUEST_ID_HEADER = "X-Request-ID"
# An incoming id (e.g. set by a proxy) is kept only if it's short and plain, so it can't
# smuggle text into the logs.
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")

# API responses are JSON or downloads, never documents that load anything.
API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
HSTS = "max-age=31536000; includeSubDomains"
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}


def route_template(scope: Scope) -> str:
    """The matched route's path template (e.g. /api/files/{file_id}), never the raw path.

    FastAPI keeps the full template (router prefixes included) in its route context; the
    route's own path (without the prefixes) is the fallback.
    """
    fastapi_scope = scope.get("fastapi")
    context = (
        fastapi_scope.get("effective_route_context") if isinstance(fastapi_scope, dict) else None
    )
    for candidate in (context, scope.get("route")):
        path = getattr(candidate, "path", None)
        if isinstance(path, str) and path:
            return path
    return "<unmatched>"


class RequestLogMiddleware:
    """Assigns each request an id and logs method, route template, status and duration.

    Raw paths and query strings are never logged: some carry sign-in, video or calendar-feed
    tokens. Replaces uvicorn's access log (run uvicorn with --no-access-log).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope["headers"]).get(REQUEST_ID_HEADER.lower().encode(), b"")
        current = incoming.decode("latin-1")
        if not _VALID_REQUEST_ID.fullmatch(current):
            current = uuid.uuid4().hex
        # Each request runs in its own task (and context), so the id isn't reset afterwards:
        # the unhandled-error handler outside this middleware still logs it.
        request_id.set(current)
        status = 500
        started = time.perf_counter()

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = current
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            route = route_template(scope)
            logger.info(
                "%s %s %s",
                scope["method"],
                route,
                status,
                extra={
                    "method": scope["method"],
                    "route": route,
                    "status": status,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )


class SecurityHeadersMiddleware:
    """Adds no-store caching, a deny-everything CSP, HSTS over HTTPS and related headers.

    `docs_paths` (the interactive API docs, development only) keep their own scripts, so the
    CSP is left off them.
    """

    def __init__(self, app: ASGIApp, docs_paths: frozenset[str] = frozenset()) -> None:
        self.app = app
        self.docs_paths = docs_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers[name] = value
                if scope["path"] not in self.docs_paths:
                    headers["Content-Security-Policy"] = API_CSP
                if scope.get("scheme") == "https":
                    headers["Strict-Transport-Security"] = HSTS
            await send(message)

        await self.app(scope, receive, send_with_headers)
