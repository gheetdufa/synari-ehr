"""FastAPI application: middleware, routers and background tasks."""

import asyncio
import contextlib
import logging
import threading
from collections.abc import AsyncIterator

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from synari.api import (
    ai,
    amendments,
    appointment_requests,
    appointments,
    audit_log,
    auth,
    availability,
    billing,
    booking,
    calendar_feed,
    calendar_sync,
    claims,
    clients,
    dashboard,
    disclosures,
    estimates,
    files,
    forms,
    imports,
    insurance,
    me,
    messages,
    notes,
    notifications,
    portal_appointments,
    portal_auth,
    portal_billing,
    portal_estimates,
    practice,
    realtime,
    record_requests,
    remittances,
    reports,
    retention,
    security,
    stripe_webhooks,
    system,
    team,
    telehealth,
    twilio_webhooks,
)
from synari.config import settings
from synari.logs import configure_logging
from synari.middleware import RequestLogMiddleware, SecurityHeadersMiddleware, route_template
from synari.pagination import TOTAL_COUNT_HEADER
from synari.realtime import hub
from synari.worker import run_forever

logger = logging.getLogger("synari")


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    listener = asyncio.create_task(hub.listen())
    stop_worker = threading.Event()
    if settings.run_worker_in_api:
        threading.Thread(target=run_forever, args=(stop_worker,), daemon=True).start()
    yield
    stop_worker.set()
    listener.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await listener


def create_app() -> FastAPI:
    """Build the API application."""
    configure_logging()
    # The interactive docs map every endpoint; production servers don't publish them.
    docs = settings.environment != "production"
    app = FastAPI(
        title="Synari API",
        description="Open-source practice management for therapists.",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if docs else None,
        openapi_url="/api/openapi.json" if docs else None,
        redoc_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        # So the web app can save downloads (PDFs, 837P files, exports) under their real names
        # and page through long lists.
        expose_headers=["Content-Disposition", TOTAL_COUNT_HEADER],
    )

    docs_paths = frozenset({"/api/docs", "/api/docs/oauth2-redirect"} if docs else ())
    app.add_middleware(SecurityHeadersMiddleware, docs_paths=docs_paths)
    app.add_middleware(RequestLogMiddleware)

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, route_template(request.scope))
        return JSONResponse(status_code=500, content={"detail": "Something went wrong on our end."})

    api = APIRouter(prefix="/api")
    routers = (
        system,
        auth,
        me,
        team,
        dashboard,
        portal_auth,
        realtime,
        practice,
        audit_log,
        clients,
        appointments,
        availability,
        appointment_requests,
        calendar_feed,
        calendar_sync,
        booking,
        portal_appointments,
        files,
        messages,
        notifications,
        telehealth,
        notes,
        record_requests,
        disclosures,
        amendments,
        retention,
        ai,
        forms,
        billing,
        reports,
        insurance,
        claims,
        remittances,
        imports,
        portal_billing,
        security,
        estimates,
        portal_estimates,
        stripe_webhooks,
        twilio_webhooks,
    )
    for module in routers:
        api.include_router(module.router)
    app.include_router(api)
    return app


app = create_app()
