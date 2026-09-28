"""Appointment reminders by email and SMS (a worker job).

Reminders are per participant: each client in a session gets their own, once per channel, when
a scheduled appointment enters the practice's reminder window (e.g. 24 hours before), if the
practice and the client both allow that channel. Email reminders also go to the client's
contacts who use the portal for them (such as a minor's parents), under the client's email
consent; texts go only to the client. A client who canceled their place isn't reminded.

Reminders name the clinician and show times in the client's time zone (else the clinician's).
Video reminders carry the client's own join link. Rescheduling re-arms reminders (see
api/appointments.py), and dedupe keys include the participant, recipient, start time and place
so a retried job never double-sends.

To avoid a "reminder" arriving moments after booking, appointments that start within the next
hour are skipped if they were created during the last hour.
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, exists, false, func, not_, or_, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClientContact,
    Practice,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    LocationType,
    StaffStatus,
)
from synari.services.appointment_notices import (
    Addressee,
    addressees,
    appointment_address,
    client_zone,
    format_when,
    format_when_short,
    location_sentence,
)
from synari.services.delivery import normalize_phone
from synari.services.email_templates import EmailContent, render_email
from synari.services.outbox import queue_email, queue_sms
from synari.services.video_links import create_join_url, short_join_url

BATCH_SIZE = 200
SMS_MAX_LENGTH = 320
SMS_OPT_OUT = "Reply STOP to opt out."
FRESH_BOOKING_GRACE = timedelta(hours=1)
HOUR = timedelta(hours=1)


def _dedupe_key(
    channel: str, appointment: Appointment, participant: AppointmentParticipant, recipient: str
) -> str:
    return (
        f"reminder:{channel}:{participant.id}:{recipient}:"
        f"{int(appointment.starts_at.timestamp())}:{appointment.location_type}:"
        f"{appointment.location_id or ''}"
    )


def _join_url(appointment: Appointment, client: Client) -> str | None:
    if appointment.location_type != LocationType.VIDEO or not appointment.has_video:
        return None
    return create_join_url(appointment, client.id)


def email_reminder(
    appointment: Appointment,
    to: Addressee,
    clinician: StaffMember,
    practice: Practice,
    zone: ZoneInfo,
    join_url: str | None,
) -> EmailContent:
    """The reminder email: when, with whom and where (or the client's video link)."""
    paragraphs = [
        f"This is a reminder of {to.your} appointment with {clinician.display_name} on "
        f"{format_when(appointment.starts_at, zone)}."
    ]
    if join_url:
        paragraphs.append(
            "This is a video appointment. Use the button below a few minutes before it starts; "
            f"{clinician.display_name} will let you in from the waiting room."
        )
    else:
        paragraphs.append(location_sentence(appointment, practice))
    phone = practice.phone or clinician.phone
    contact = f" at {phone}" if phone else ""
    paragraphs.append(
        f"If you need to cancel or reschedule, please contact {practice.name}{contact}."
    )
    return render_email(
        subject="Appointment reminder",
        heading=f"Hi {to.first_name},",
        paragraphs=paragraphs,
        sender_name=practice.name,
        button_label="Join video appointment" if join_url else None,
        button_url=join_url,
    )


def sms_reminder(
    appointment: Appointment,
    clinician: StaffMember,
    practice: Practice,
    zone: ZoneInfo,
    join_url: str | None = None,
) -> str:
    """The reminder text: at most 320 characters, ending with the opt-out line.

    Video appointments include the short join link. Long addresses or names fall back to
    shorter wording.
    """
    when = format_when_short(appointment.starts_at, zone)
    lead = f"Reminder: appointment with {clinician.display_name} on {when}."
    address = appointment_address(appointment, practice)
    candidates: list[str] = []
    if appointment.location_type == LocationType.VIDEO:
        if join_url:
            candidates.append(f"{lead} Join video: {join_url} {SMS_OPT_OUT}")
        candidates.append(
            f"{lead} Video appointment: join from your email or client portal. {SMS_OPT_OUT}"
        )
    elif appointment.location_type == LocationType.IN_PERSON and address:
        candidates.append(f"{lead} Location: {address.rstrip('.')}. {SMS_OPT_OUT}")
    candidates.append(f"{lead} {SMS_OPT_OUT}")
    candidates.append(f"Reminder: you have an appointment on {when}. {SMS_OPT_OUT}")
    return next(text for text in candidates if len(text) <= SMS_MAX_LENGTH)


def send_appointment_reminders(db: Session, now: datetime) -> None:
    """Worker job: queue due email and SMS reminders, once per participant and channel."""
    contact_has_email = exists().where(
        ClientContact.client_id == Client.id,
        ClientContact.portal_access,
        func.coalesce(ClientContact.email, "") != "",
    )
    email_due = and_(
        PracticeSettings.reminder_email_enabled,
        Client.email_reminders,
        or_(func.coalesce(Client.email, "") != "", contact_has_email),
        AppointmentParticipant.reminder_email_sent_at.is_(None),
        Appointment.starts_at - PracticeSettings.reminder_email_hours * HOUR <= now,
    )
    sms_due = (
        and_(
            PracticeSettings.reminder_sms_enabled,
            Client.sms_reminders,
            not_(Client.sms_opted_out),
            Client.phone != "",
            AppointmentParticipant.reminder_sms_sent_at.is_(None),
            Appointment.starts_at - PracticeSettings.reminder_sms_hours * HOUR <= now,
        )
        if settings.sms_enabled
        else false()
    )
    fresh_and_imminent = and_(
        Appointment.starts_at < now + FRESH_BOOKING_GRACE,
        Appointment.created_at > now - FRESH_BOOKING_GRACE,
    )
    rows = db.execute(
        select(
            AppointmentParticipant,
            Appointment,
            Client,
            StaffMember,
            Practice,
            email_due.label("email_due"),
            sms_due.label("sms_due"),
        )
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .join(StaffMember, StaffMember.id == Appointment.clinician_id)
        .join(Practice, Practice.id == Appointment.practice_id)
        .join(PracticeSettings, PracticeSettings.practice_id == Appointment.practice_id)
        .where(
            Appointment.status == AppointmentStatus.SCHEDULED,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.source != BookingSource.IMPORT,
            Appointment.starts_at > now,
            AppointmentParticipant.attendance.is_(None),
            StaffMember.status == StaffStatus.ACTIVE,
            not_(fresh_and_imminent),
            or_(email_due, sms_due),
        )
        .order_by(Appointment.starts_at, AppointmentParticipant.id)
        .limit(BATCH_SIZE)
        .with_for_update(of=AppointmentParticipant, skip_locked=True)
    ).all()

    for participant, appointment, client, clinician, practice, is_email_due, is_sms_due in rows:
        zone = client_zone(client, clinician)
        if is_email_due:
            join_url = _join_url(appointment, client)
            for to in addressees(client):
                queue_email(
                    db,
                    to=to.email,
                    content=email_reminder(appointment, to, clinician, practice, zone, join_url),
                    practice_id=practice.id,
                    dedupe_key=_dedupe_key("email", appointment, participant, to.key),
                )
            participant.reminder_email_sent_at = now
        phone = normalize_phone(client.phone) if is_sms_due else None
        if phone:
            join_url = short_join_url(participant) if appointment.has_video else None
            queue_sms(
                db,
                to=phone,
                body=sms_reminder(appointment, clinician, practice, zone, join_url),
                practice_id=practice.id,
                dedupe_key=_dedupe_key("sms", appointment, participant, "client"),
            )
            participant.reminder_sms_sent_at = now
    db.commit()
