"""Worker job for good faith estimates: expiry reminders and overdue alerts.

Each estimate is reminded about once: 30 days before an issued estimate's period ends (so a
new one is ready for continuing care), and when a draft passes its due date. Dates are the
practice's. Rows are locked with SKIP LOCKED, so several workers can run it at once.
"""

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from synari.models import Client, GoodFaithEstimate, Practice, PracticeSettings
from synari.models.enums import GoodFaithEstimateStatus
from synari.services.billing import local_date
from synari.services.estimates import needs_estimates, notify_estimate_staff, short_date
from synari.services.notifications import short_name

logger = logging.getLogger(__name__)

EXPIRY_NOTICE_DAYS = 30


def _remind(db: Session, estimate: GoodFaithEstimate, now: datetime, time_zone: str) -> None:
    today = local_date(now, ZoneInfo(time_zone))
    client = db.get_one(Client, estimate.client_id)
    if estimate.status == GoodFaithEstimateStatus.ISSUED:
        if estimate.period_end > today + timedelta(days=EXPIRY_NOTICE_DAYS):
            return
        estimate.expiry_notified_at = now
        if estimate.period_end >= today and needs_estimates(client):
            notify_estimate_staff(
                db,
                client,
                estimate.clinician_id,
                kind="estimate_expiring",
                title=(
                    f"The good faith estimate for {short_name(client)} ends "
                    f"{short_date(estimate.period_end)}"
                ),
            )
        return
    if estimate.due_on is None or estimate.due_on >= today:
        return
    estimate.overdue_notified_at = now
    if needs_estimates(client):
        notify_estimate_staff(
            db,
            client,
            estimate.clinician_id,
            kind="estimate_overdue",
            title=(
                f"The good faith estimate for {short_name(client)} is overdue "
                f"(due {short_date(estimate.due_on)})"
            ),
            urgent=True,
        )


def send_estimate_reminders(db: Session, now: datetime) -> None:
    """Worker job: remind the clinician and billing staff 30 days before an issued estimate
    ends, and alert them when a draft estimate is past its due date."""
    # A day of slack either way; each practice's own date is checked per estimate.
    soon = now.date() + timedelta(days=EXPIRY_NOTICE_DAYS + 1)
    due = or_(
        and_(
            GoodFaithEstimate.status == GoodFaithEstimateStatus.ISSUED,
            GoodFaithEstimate.expiry_notified_at.is_(None),
            GoodFaithEstimate.period_end <= soon,
        ),
        and_(
            GoodFaithEstimate.status == GoodFaithEstimateStatus.DRAFT,
            GoodFaithEstimate.overdue_notified_at.is_(None),
            GoodFaithEstimate.due_on <= now.date(),
        ),
    )
    rows = db.execute(
        select(GoodFaithEstimate, Practice.time_zone)
        .join(Practice, Practice.id == GoodFaithEstimate.practice_id)
        .join(PracticeSettings, PracticeSettings.practice_id == Practice.id)
        .where(PracticeSettings.gfe_enabled, due)
        .order_by(GoodFaithEstimate.id)
        .with_for_update(of=GoodFaithEstimate, skip_locked=True)
    ).all()
    try:
        for estimate, time_zone in rows:
            _remind(db, estimate, now, time_zone)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Good faith estimate reminders failed")
