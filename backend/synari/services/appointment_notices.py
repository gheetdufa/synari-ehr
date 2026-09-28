"""Appointment emails to clients, request/cancellation alerts to staff, and calendar events.

Client notices go straight to each client's email, and to contacts who use the portal for them
(such as a minor's parents), with no sign-in link. Every client in a couples, family or group
session gets their own email. Like SimplePractice's, notices may include the date and time, the
clinician's name and where the appointment happens, but never the service, the other clients,
diagnoses or anything else clinical. Staff alerts carry no client details beyond a short name in
the app; emails to staff link back into the app.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from synari.access import Access
from synari.db import utcnow
from synari.models import Appointment, Client, Practice, StaffMember
from synari.models.enums import AppointmentStatus, LocationType, Role
from synari.permissions import Capability, capabilities_for
from synari.realtime import Recipient, publish
from synari.services.email_templates import render_email
from synari.services.notifications import notify, short_name
from synari.services.outbox import queue_email
from synari.services.portal_links import portal_contacts, queue_staff_email
from synari.services.recipients import active_staff, as_recipients
from synari.services.scheduling import zone_of

REQUESTS_APP_PATH = "/portal/calendar?requests=1"
CALENDAR_APP_PATH = "/portal/calendar"
VIDEO_NOTICE = (
    "This is a video appointment. You'll get a link to join in your appointment reminder."
)
_OPEN_STATUSES = (AppointmentStatus.REQUESTED, AppointmentStatus.SCHEDULED)

# A client and one appointment they take part in.
Attendee = tuple[Client, Appointment]


class HasAddress(Protocol):
    address_line1: str
    address_line2: str
    city: str
    state: str
    postal_code: str


@dataclass(frozen=True)
class Addressee:
    """Someone who gets a client's appointment emails: the client, or a contact acting for them."""

    email: str
    first_name: str
    # "your", or "Alex's" when writing to Alex's parent.
    your: str
    # Identifies the recipient in outbox dedupe keys without putting an address in them.
    key: str

    @property
    def your_capitalized(self) -> str:
        return self.your[:1].upper() + self.your[1:]


def addressees(client: Client) -> list[Addressee]:
    """The client (if they have an email) and each contact with portal access and an email,
    such as a minor's parents."""
    recipients: list[Addressee] = []
    if client.email:
        recipients.append(Addressee(client.email, client.display_first_name, "your", "client"))
    seen = {client.email.lower()} if client.email else set()
    for contact in portal_contacts(client):
        email = contact.email or ""
        if email.lower() in seen:
            continue
        seen.add(email.lower())
        recipients.append(
            Addressee(
                email, contact.first_name, f"{client.display_first_name}'s", f"contact-{contact.id}"
            )
        )
    return recipients


def attendees(appointments: Iterable[Appointment]) -> list[Attendee]:
    """Each client expected at each appointment (not those who canceled their own attendance)."""
    return [
        (participant.client, appointment)
        for appointment in appointments
        for participant in appointment.participants
        if participant.attendance is None
    ]


def _by_client(pairs: Iterable[Attendee]) -> list[tuple[Client, list[Appointment]]]:
    grouped: dict[int, tuple[Client, list[Appointment]]] = {}
    for client, appointment in pairs:
        grouped.setdefault(client.id, (client, []))[1].append(appointment)
    return list(grouped.values())


def client_zone(client: Client, clinician: StaffMember) -> ZoneInfo:
    """The client's own time zone, falling back to the clinician's."""
    return ZoneInfo(client.time_zone) if client.time_zone else zone_of(clinician)


def _clock(local: datetime) -> str:
    hour = local.hour % 12 or 12
    return f"{hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"


def format_when(moment: datetime, zone: ZoneInfo) -> str:
    """e.g. 'Monday, October 5, 2026 at 10:00 AM EDT'."""
    local = moment.astimezone(zone)
    return f"{local:%A, %B} {local.day}, {local.year} at {_clock(local)} {local:%Z}"


def format_when_short(moment: datetime, zone: ZoneInfo) -> str:
    """e.g. 'Mon, Oct 5 at 10:00 AM EDT' (for SMS)."""
    local = moment.astimezone(zone)
    return f"{local:%a, %b} {local.day} at {_clock(local)} {local:%Z}"


def one_line_address(place: HasAddress) -> str:
    """A street address on one line, or '' if none is set."""
    region = " ".join(p for p in (place.state, place.postal_code) if p)
    parts = (place.address_line1, place.address_line2, place.city, region)
    return ", ".join(p for p in parts if p)


def appointment_address(appointment: Appointment, practice: Practice) -> str:
    """Where an in-person appointment happens: its own details, else its office's address,
    else the practice address."""
    if appointment.location_details:
        return appointment.location_details
    if appointment.location_type != LocationType.IN_PERSON:
        return ""
    office = appointment.location
    if office is not None and not office.is_video and (address := one_line_address(office)):
        return address
    return one_line_address(practice)


def location_sentence(appointment: Appointment, practice: Practice) -> str:
    """One line telling the client where the appointment takes place."""
    details = appointment_address(appointment, practice)
    if appointment.location_type == LocationType.VIDEO:
        return VIDEO_NOTICE
    if appointment.location_type == LocationType.PHONE:
        return f"This appointment is by phone. {details}".strip()
    return f"Location: {details}" if details else "This appointment is in person."


def _upcoming(appointments: Sequence[Appointment], *, open_only: bool) -> list[Appointment]:
    now = utcnow()
    return sorted(
        (
            a
            for a in appointments
            if a.starts_at > now and (not open_only or a.status in _OPEN_STATUSES)
        ),
        key=lambda a: a.starts_at,
    )


def _when_summary(appointments: Sequence[Appointment], zone: ZoneInfo) -> str:
    first = format_when(appointments[0].starts_at, zone)
    extra = len(appointments) - 1
    return f"{first} and {extra} more" if extra else first


def send_client_email(
    db: Session,
    practice: Practice,
    to: Addressee,
    *,
    subject: str,
    paragraphs: list[str],
    heading: str | None = None,
) -> None:
    """Queue a plain notice to one addressee, signed by the practice ("Hi <name>," unless
    another heading is given)."""
    content = render_email(
        subject=subject,
        heading=heading or f"Hi {to.first_name},",
        paragraphs=paragraphs,
        sender_name=practice.name,
    )
    queue_email(db, to=to.email, content=content, practice_id=practice.id)


def notify_scheduled(db: Session, pairs: Iterable[Attendee]) -> None:
    """'Appointment scheduled' to each client (and their portal contacts): one email per client
    for a single appointment or a whole series."""
    for client, appointments in _by_client(pairs):
        upcoming = _upcoming(appointments, open_only=True)
        if not upcoming:
            continue
        clinician = upcoming[0].clinician
        when = _when_summary(upcoming, client_zone(client, clinician))
        several = len(upcoming) > 1
        for to in addressees(client):
            send_client_email(
                db,
                clinician.practice,
                to,
                subject="Appointment scheduled",
                paragraphs=[
                    f"{to.your_capitalized} {'appointments' if several else 'appointment'} with "
                    f"{clinician.display_name} {'are' if several else 'is'} scheduled for {when}.",
                    location_sentence(upcoming[0], clinician.practice),
                ],
            )


def notify_changed(db: Session, pairs: Iterable[Attendee]) -> None:
    """'Appointment changed': the new time, place and clinician of changed appointments."""
    for client, appointments in _by_client(pairs):
        upcoming = _upcoming(appointments, open_only=True)
        if not upcoming:
            continue
        clinician = upcoming[0].clinician
        when = _when_summary(upcoming, client_zone(client, clinician))
        noun = "appointments" if len(upcoming) > 1 else "appointment"
        for to in addressees(client):
            send_client_email(
                db,
                clinician.practice,
                to,
                subject="Appointment changed",
                paragraphs=[
                    f"{to.your_capitalized} {noun} with {clinician.display_name} changed.",
                    f"New time: {when}.",
                    location_sentence(upcoming[0], clinician.practice),
                ],
            )


def notify_canceled(db: Session, pairs: Iterable[Attendee]) -> None:
    """'Appointment canceled' for upcoming appointments the practice canceled (or took the
    client out of)."""
    for client, appointments in _by_client(pairs):
        upcoming = _upcoming(appointments, open_only=False)
        if not upcoming:
            continue
        clinician = upcoming[0].clinician
        when = _when_summary(upcoming, client_zone(client, clinician))
        several = len(upcoming) > 1
        for to in addressees(client):
            send_client_email(
                db,
                clinician.practice,
                to,
                subject="Appointment canceled",
                paragraphs=[
                    f"{to.your_capitalized} {'appointments' if several else 'appointment'} with "
                    f"{clinician.display_name} on {when} {'were' if several else 'was'} canceled.",
                    f"If you have questions, please contact {clinician.practice.name}.",
                ],
            )


def notify_request_received(
    db: Session,
    appointment: Appointment,
    clinician: StaffMember,
    recipients: Sequence[Addressee],
    zone: ZoneInfo,
) -> None:
    """Tell whoever asked for an appointment that the request arrived."""
    when = format_when(appointment.starts_at, zone)
    for to in recipients:
        send_client_email(
            db,
            clinician.practice,
            to,
            subject="We received your request",
            heading=f"Thanks, {to.first_name}",
            paragraphs=[
                f"{clinician.display_name} received {to.your} request for an appointment on "
                f"{when}.",
                "This time isn't confirmed yet. You'll get another email when the request is "
                "accepted.",
            ],
        )


def notify_request_accepted(
    db: Session, appointment: Appointment, client: Client, clinician: StaffMember
) -> None:
    """Confirm an accepted request to the client (and their portal contacts)."""
    when = format_when(appointment.starts_at, client_zone(client, clinician))
    for to in addressees(client):
        send_client_email(
            db,
            clinician.practice,
            to,
            subject="Appointment confirmed",
            paragraphs=[
                f"{clinician.display_name} accepted {to.your} request. "
                f"{to.your_capitalized} appointment is confirmed for {when}.",
                location_sentence(appointment, clinician.practice),
            ],
        )


def notify_request_declined(
    db: Session, appointment: Appointment, client: Client, clinician: StaffMember, reason: str
) -> None:
    """Tell the client their request was declined, with the reason only if one is given."""
    when = format_when(appointment.starts_at, client_zone(client, clinician))
    for to in addressees(client):
        paragraphs = [
            f"{clinician.display_name} isn't able to accept {to.your} request for {when}."
        ]
        if reason:
            paragraphs.append(f"Message from {clinician.practice.name}: {reason}")
        send_client_email(
            db,
            clinician.practice,
            to,
            subject="About your appointment request",
            paragraphs=paragraphs,
        )


def _schedules_for_practice(member: StaffMember) -> bool:
    return Capability.SCHEDULE_ALL in capabilities_for(member)


def calendar_recipients(
    db: Session,
    appointments: Sequence[Appointment],
    extra_staff_ids: Iterable[int] = (),
    extra_clients: Iterable[Client] = (),
) -> list[Recipient]:
    """Who refreshes after a calendar change: the appointments' clinicians (and anyone in
    `extra_staff_ids`), staff who schedule for the whole practice, staff who can see any of the
    clients (including `extra_clients`, e.g. ones just removed), and the clients' own portals."""
    clinician_ids = {a.clinician_id for a in appointments} | set(extra_staff_ids)
    clients = {p.client_id: p.client for a in appointments for p in a.participants}
    clients.update((client.id, client) for client in extra_clients)
    staff = [
        member
        for member in active_staff(db, appointments[0].practice_id)
        if member.id in clinician_ids
        or _schedules_for_practice(member)
        or any(Access(db, member).can_access_client(c) for c in clients.values())
    ]
    return as_recipients(staff) + [(Role.CLIENT, client_id) for client_id in sorted(clients)]


def publish_calendar_change(
    db: Session,
    appointments: Sequence[Appointment],
    event: str,
    extra_staff_ids: Iterable[int] = (),
    extra_clients: Iterable[Client] = (),
) -> None:
    """Realtime event (ids only) telling everyone concerned to refresh these appointments."""
    ids = [a.id for a in appointments]
    publish(
        db,
        calendar_recipients(db, appointments, extra_staff_ids, extra_clients),
        event,
        {"appointment_id": ids[0], "appointment_ids": ids},
    )


def alert_staff_of_request(
    db: Session, appointment: Appointment, client: Client, clinician: StaffMember
) -> None:
    """A realtime event and in-app notifications for the clinician and the practice's
    schedulers, plus (if the clinician wants it) a content-free email."""
    publish(
        db,
        calendar_recipients(db, [appointment]),
        "appointment_request.created",
        {"appointment_id": appointment.id},
    )
    title = f"New appointment request from {short_name(client)}"
    schedulers = [
        member
        for member in active_staff(db, clinician.practice_id)
        if member.id != clinician.id and _schedules_for_practice(member)
    ]
    for member in (clinician, *schedulers):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="appointment_request",
            title=title if member.id == clinician.id else f"{title} for {clinician.full_name}",
            link=REQUESTS_APP_PATH,
        )
    if not clinician.notify_email_requests:
        return
    queue_staff_email(
        db,
        clinician,
        subject="New appointment request",
        heading="You have a new appointment request",
        paragraphs=["Someone requested an appointment. Review it and accept or decline in Synari."],
        button_label="Review request",
        app_path=REQUESTS_APP_PATH,
    )


def alert_clinician_of_cancellation(
    db: Session, appointment: Appointment, client: Client, *, whole_session: bool
) -> None:
    """A realtime event, an in-app notification and a content-free email to the clinician when
    a client cancels an appointment (or their place in a shared session) or withdraws a
    request."""
    clinician = appointment.clinician
    event = "appointment.canceled" if whole_session else "appointment.updated"
    publish_calendar_change(db, [appointment], event)
    action = "canceled an appointment" if whole_session else "canceled their attendance"
    notify(
        db,
        Role.STAFF,
        clinician.id,
        kind="appointment_canceled",
        title=f"{short_name(client)} {action}",
        link=CALENDAR_APP_PATH,
    )
    queue_staff_email(
        db,
        clinician,
        subject="Appointment canceled",
        heading="A client canceled an appointment",
        paragraphs=[
            "A client canceled an appointment, their place in a session, or a request in the "
            "portal."
        ],
        button_label="Open calendar",
        app_path=CALENDAR_APP_PATH,
    )
