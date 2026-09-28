"""Deadlines and notices shared by record requests (30 days, HIPAA 164.524) and amendment
requests (60 days, 164.526): due dates on the practice's calendar, who handles a request, and
the in-app reminders as a deadline approaches.

Notices say that something needs attention and link to it; they never repeat what the client
asked for.
"""

from datetime import date, datetime, timedelta

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from synari.access import ClientAccess
from synari.models import Client, Notification, Practice, StaffMember
from synari.models.enums import Role, StaffRole
from synari.services.notifications import notify, short_name
from synari.services.portal_links import queue_staff_email
from synari.services.recipients import staff_with_client_access
from synari.services.scheduling import zone_of

# Reminders go out when this many days (or fewer) remain, then once the request is overdue.
NUDGE_DAYS = (10, 2)
CLIENT_RECORDS_PATH = "/client/records"


def practice_today(practice: Practice, now: datetime) -> date:
    """Today's date on the practice's wall clock."""
    return now.astimezone(zone_of(practice)).date()


def due_date(practice: Practice, received_at: datetime, days: int) -> date:
    """The day a response is due: `days` after the day the request arrived (practice zone)."""
    return practice_today(practice, received_at) + timedelta(days=days)


def days_until(due_on: date, today: date) -> int:
    """Days left before the due date; negative once it has passed."""
    return (due_on - today).days


def format_day(day: date) -> str:
    """'Oct 26, 2026'."""
    return f"{day:%b} {day.day}, {day.year}"


def request_handlers(db: Session, client: Client) -> list[StaffMember]:
    """Who answers a client's privacy requests: their primary clinician and the owners, among
    staff who can open the chart; everyone with clinical access when neither can."""
    clinical = staff_with_client_access(db, client, ClientAccess.CLINICAL)
    primary = client.primary_clinician
    handlers = [
        member
        for member in clinical
        if member.role == StaffRole.OWNER or (primary is not None and member.id == primary.id)
    ]
    return handlers or clinical


def notify_handlers(
    db: Session,
    client: Client,
    *,
    kind: str,
    title: str,
    link: str,
    body: str = "",
    email_subject: str | None = None,
) -> None:
    """Tell the request's handlers in the app, and by (content-free) email when
    `email_subject` is given and they want request emails."""
    for member in request_handlers(db, client):
        notify(db, Role.STAFF, member.id, kind=kind, title=title, body=body, link=link)
        if email_subject is not None and member.notify_email_forms:
            queue_staff_email(
                db,
                member,
                subject=email_subject,
                heading=email_subject,
                paragraphs=[
                    "A client made a request about their record. Sign in to review it; the "
                    "practice must respond by the deadline shown in Synari."
                ],
                button_label="Open Synari",
                app_path=link,
            )


def send_deadline_nudge(
    db: Session,
    client: Client,
    *,
    kind_prefix: str,
    label: str,
    link: str,
    due_on: date,
    today: date,
) -> bool:
    """Remind the handlers of an open request when 10 and 2 days remain and once overdue.

    Each stage is sent once per due date (an extension moves the due date, so its reminders
    come again). Returns whether a reminder was sent.
    """
    remaining = days_until(due_on, today)
    if remaining < 0:
        stage, title = "overdue", f"{label} for {short_name(client)} is overdue"
    elif remaining <= NUDGE_DAYS[1]:
        stage, title = f"{NUDGE_DAYS[1]}d", f"{label} for {short_name(client)} is due soon"
    elif remaining <= NUDGE_DAYS[0]:
        stage, title = f"{NUDGE_DAYS[0]}d", f"{label} for {short_name(client)} is due soon"
    else:
        return False
    kind = f"{kind_prefix}_due_{stage}"
    body = f"Due by {format_day(due_on)}."
    already = db.scalar(
        select(
            exists().where(
                Notification.recipient_role == Role.STAFF,
                Notification.kind == kind,
                Notification.link == link,
                Notification.body == body,
            )
        )
    )
    if already:
        return False
    notify_handlers(db, client, kind=kind, title=title, body=body, link=link)
    return True
