"""Records retention: which archived clients' records have been kept past the practice's
retention period (PracticeSettings.record_retention_years). A list for the owner to review;
nothing is destroyed here."""

from datetime import date, datetime

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from synari.audit import audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import Appointment, AppointmentParticipant, Client, Note
from synari.models.enums import ClientStatus
from synari.permissions import Capability
from synari.schemas.appointments import ClientRef
from synari.schemas.records import RetentionReportRow
from synari.services.request_deadlines import practice_today
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/practice", tags=["practice"])


def _years_after(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # February 29th
        return day.replace(year=day.year + years, day=28)


@router.get("/retention-report", response_model=list[RetentionReportRow])
def retention_report(
    access: CurrentAccess, db: DbSession, request: Request
) -> list[RetentionReportRow]:
    """Archived clients whose last activity (their latest appointment, note or when they were
    added) is older than the retention period, soonest-expired first.

    State law may require keeping some records longer (minors' records especially).
    """
    access.require(Capability.MANAGE_PRACTICE)
    practice = access.staff.practice
    years = practice.settings.record_retention_years
    last_appointment = (
        select(func.max(Appointment.starts_at))
        .join(AppointmentParticipant, AppointmentParticipant.appointment_id == Appointment.id)
        .where(AppointmentParticipant.client_id == Client.id)
        .scalar_subquery()
    )
    last_note = (
        select(func.max(Note.created_at)).where(Note.client_id == Client.id).scalar_subquery()
    )
    rows = db.execute(
        select(Client, last_appointment, last_note).where(
            Client.practice_id == access.practice_id, Client.status == ClientStatus.ARCHIVED
        )
    ).all()
    today = practice_today(practice, utcnow())
    zone = zone_of(practice)
    report: list[RetentionReportRow] = []
    for client, appointment_at, note_at in rows:
        moments: list[datetime] = [client.created_at]
        moments += [moment for moment in (appointment_at, note_at) if moment is not None]
        last_activity = max(moments)
        ends_on = _years_after(last_activity.astimezone(zone).date(), years)
        if ends_on < today:
            report.append(
                RetentionReportRow(
                    client=ClientRef.model_validate(client),
                    status=client.status,
                    last_activity_at=last_activity,
                    retention_ends_on=ends_on,
                )
            )
    report.sort(key=lambda row: (row.retention_ends_on, row.client.id))
    audit_staff_list(
        db, request, access.staff, "retention.report_view", [row.client.id for row in report]
    )
    db.commit()
    return report
