"""Minimal iCalendar (RFC 5545) rendering for the private calendar subscription feed."""

from collections.abc import Iterable
from datetime import datetime

from synari.models import Appointment
from synari.models.enums import AppointmentKind, AppointmentStatus, LocationType
from synari.services.scheduling import is_group_session

LOCATION_LABELS = {
    LocationType.VIDEO: "Video session",
    LocationType.PHONE: "Phone session",
    LocationType.IN_PERSON: "In person",
}


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", r"\;").replace(",", "\\,").replace("\n", "\\n")


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y%m%dT%H%M%SZ")


def _fold(line: str) -> str:
    """Wrap lines at 75 octets as the spec requires."""
    encoded = line.encode()
    if len(encoded) <= 75:
        return line
    parts: list[str] = []
    while encoded:
        cut = 75 if not parts else 74
        chunk = encoded[:cut]
        while True:  # never split a multi-byte character
            try:
                parts.append(chunk.decode())
                break
            except UnicodeDecodeError:
                chunk = chunk[:-1]
        encoded = encoded[len(chunk) :]
    return "\r\n ".join(parts)


def _session_summary(appointment: Appointment) -> str:
    """What kind of session it is, without saying who it's with."""
    if is_group_session(appointment):
        return "Group session"
    if len(appointment.participants) > 1:
        return "Couples/family session"
    return "Client appointment"


def render_calendar(appointments: Iterable[Appointment], *, host: str, now: datetime) -> str:
    """A VCALENDAR with one VEVENT per appointment. Client names and group titles are never
    included."""
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Synari//Practice calendar//EN",
        "CALSCALE:GREGORIAN",
        "X-WR-CALNAME:Synari",
        "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    ]
    for appointment in appointments:
        is_event = appointment.kind == AppointmentKind.EVENT
        summary = appointment.title if is_event else _session_summary(appointment)
        if appointment.status == AppointmentStatus.REQUESTED:
            summary = "Requested appointment (pending)"
        lines += [
            "BEGIN:VEVENT",
            f"UID:synari-appointment-{appointment.id}@{host}",
            f"DTSTAMP:{_stamp(now)}",
            f"DTSTART:{_stamp(appointment.starts_at)}",
            f"DTEND:{_stamp(appointment.ends_at)}",
            f"SUMMARY:{_escape(summary)}",
        ]
        if not is_event:
            lines.append(
                f"LOCATION:{_escape(LOCATION_LABELS[LocationType(appointment.location_type)])}"
            )
        lines.append(
            "STATUS:TENTATIVE"
            if appointment.status == AppointmentStatus.REQUESTED
            else "STATUS:CONFIRMED"
        )
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
