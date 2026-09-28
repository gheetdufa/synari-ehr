"""Background worker: delivers email/SMS, sends reminders, creates invoices, runs AutoPay,
sends insurance claims, collects clearinghouse responses, re-checks eligibility, syncs
connected calendars, imports practices from SimplePractice, seals the audit log, flags unusual
access, and purges ended sessions and old rate-limit counters.

Run it as its own process (`python -m synari.worker`) or set RUN_WORKER_IN_API=true to run it
in a thread inside the API. Jobs lock the rows they process (SKIP LOCKED), so several workers
can run safely at once.
"""

import logging
import signal
import threading
from collections.abc import Callable
from datetime import datetime

from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import SessionLocal, utcnow
from synari.logs import configure_logging
from synari.ratelimit import purge_rate_limit_buckets
from synari.services.audit_chain import (
    checkpoint_audit_chains,
    purge_expired_audit_events,
    seal_audit_events,
    verify_audit_chains,
)
from synari.services.backups import check_backup_health
from synari.services.billing_jobs import create_daily_invoices, run_autopay
from synari.services.calendar_sync.busy import poll_external_busy
from synari.services.calendar_sync.push import sync_calendar_events
from synari.services.claims_eligibility import run_eligibility_checks
from synari.services.claims_jobs import poll_clearinghouse, submit_queued_claims
from synari.services.estimate_jobs import send_estimate_reminders
from synari.services.forms import remind_incomplete_forms
from synari.services.imports.jobs import analyze_imports, run_imports
from synari.services.outbox import deliver_outbound, purge_outbound_content
from synari.services.record_requests import run_record_request_deadlines
from synari.services.reminders import send_appointment_reminders
from synari.services.security_events import detect_security_events
from synari.services.sessions import purge_ended_sessions
from synari.services.transcription_jobs import process_recordings

logger = logging.getLogger(__name__)

Job = Callable[[Session, datetime], None]

# Order matters: AutoPay charges the invoices the invoicing run just created, and the outbox
# runs last so emails queued by earlier jobs go out in the same pass.
JOBS: list[Job] = [
    create_daily_invoices,
    run_autopay,
    send_appointment_reminders,
    remind_incomplete_forms,
    process_recordings,
    submit_queued_claims,
    poll_clearinghouse,
    run_eligibility_checks,
    sync_calendar_events,
    poll_external_busy,
    run_record_request_deadlines,
    detect_security_events,
    purge_ended_sessions,
    purge_rate_limit_buckets,
    check_backup_health,
    send_estimate_reminders,
    analyze_imports,
    run_imports,
    deliver_outbound,
    purge_outbound_content,
    # Audit log upkeep last, so events written by the jobs above are sealed in the same pass.
    seal_audit_events,
    checkpoint_audit_chains,
    verify_audit_chains,
    purge_expired_audit_events,
]


def run_once(now: datetime | None = None) -> None:
    """Run every job once, each in its own session so one failure doesn't block the rest."""
    for job in JOBS:
        with SessionLocal() as db:
            try:
                job(db, now or utcnow())
            except Exception:
                db.rollback()
                logger.exception("Worker job %s failed", job.__name__)


def run_forever(stop: threading.Event) -> None:
    """Run jobs every WORKER_INTERVAL_SECONDS until `stop` is set."""
    logger.info("Worker started (interval %ss)", settings.worker_interval_seconds)
    while not stop.is_set():
        run_once()
        stop.wait(settings.worker_interval_seconds)
    logger.info("Worker stopped")


def main() -> None:
    configure_logging()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    run_forever(stop)


if __name__ == "__main__":
    main()
