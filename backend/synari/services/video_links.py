"""Signed telehealth join links.

Each client in a video appointment has their own join link, naming the appointment and that
client. It needs no account, like SimplePractice's links, but only gets someone into the
waiting room; the appointment's clinician still admits them. Links expire 30 minutes after the
appointment's scheduled end. Text messages carry a short link with the client's own code.
"""

import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import Appointment, AppointmentParticipant
from synari.security import create_token, decode_token

LINK_GRACE_AFTER_END = timedelta(minutes=30)
VIDEO_JOIN_ROLE = "video_guest"


@dataclass(frozen=True)
class JoinClaims:
    appointment_id: int
    client_id: int


def create_join_token(appointment: Appointment, client_id: int) -> str:
    """A client's token for the appointment's waiting room, valid until 30 minutes after it
    ends. The caller checks the client is a participant."""
    expires_in = max(appointment.ends_at + LINK_GRACE_AFTER_END - utcnow(), timedelta(minutes=1))
    return create_token(
        subject_id=appointment.id,
        role=VIDEO_JOIN_ROLE,
        token_type="video_join",
        version=0,
        expires_in=expires_in,
        extra={"cid": client_id},
    )


def create_join_url(appointment: Appointment, client_id: int) -> str:
    """Public URL of a client's join page for this appointment."""
    token = create_join_token(appointment, client_id)
    return f"{settings.frontend_url.rstrip('/')}/join/{token}"


def short_join_url(participant: AppointmentParticipant) -> str:
    """A participant's short link for text messages (/j/<code>), which resolves to a fresh
    join token for them.

    Assigns the participant's code on first use; the caller commits.
    """
    if participant.video_join_code is None:
        participant.video_join_code = secrets.token_urlsafe(8)
    return f"{settings.frontend_url.rstrip('/')}/j/{participant.video_join_code}"


def resolve_short_code(db: Session, code: str) -> AppointmentParticipant | None:
    """The participant a short code belongs to, while their video link would still be valid."""
    participant = db.scalar(
        select(AppointmentParticipant).where(AppointmentParticipant.video_join_code == code)
    )
    if participant is None:
        return None
    appointment = participant.appointment
    if appointment.video_room_name is None:
        return None
    if utcnow() > appointment.ends_at + LINK_GRACE_AFTER_END:
        return None
    return participant


def decode_join_token(token: str) -> JoinClaims | None:
    """Claims of a valid, unexpired join token, else None."""
    claims = decode_token(token, "video_join")
    if claims is None or claims.get("role") != VIDEO_JOIN_ROLE or claims.get("cid") is None:
        return None
    return JoinClaims(appointment_id=int(claims["sub"]), client_id=int(claims["cid"]))
