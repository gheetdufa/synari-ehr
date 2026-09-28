"""Telehealth schemas: room tokens, join links, the waiting room and session recordings."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from synari.models.enums import RecordingStatus, WaitingStatus
from synari.schemas.appointments import ClientRef
from synari.schemas.common import Schema

# What the public join page shows for a link.
JoinStatus = Literal["open", "too_early", "ended", "canceled"]

# A waiting-room entry's status, or the appointment's state once it can no longer be joined.
EntryState = Literal["waiting", "admitted", "declined", "left", "canceled", "ended"]


class RoomTokenOut(Schema):
    livekit_url: str
    token: str
    room_name: str
    identity: str


class JoinLinkOut(Schema):
    url: str


class ParticipantLinkOut(Schema):
    """One client's own join link for an appointment."""

    client: ClientRef
    url: str


class ShortLinkOut(Schema):
    token: str


class SendLinkOut(Schema):
    """How one client's join link was sent."""

    client_id: int
    email_sent: bool
    sms_sent: bool


class JoinInfoOut(Schema):
    """What anyone holding a join link may see: no client names or other PHI."""

    status: JoinStatus
    starts_at: datetime
    ends_at: datetime
    clinician_name: str
    practice_name: str
    time_zone: str = Field(
        description="Show times in this zone: the client's, else the clinician's"
    )
    waiting_room_enabled: bool
    recording_enabled: bool


class EnterRequest(Schema):
    display_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
    ]
    current_location: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] = (
        Field(default="", description="Where the participant is right now, for emergencies")
    )
    recording_consent: bool = False


class EnterOut(Schema):
    entry_id: int
    secret: str = Field(description="Send back as ?secret= when polling or leaving")
    status: WaitingStatus


class EntryStatusOut(Schema):
    """Poll result; the room fields are set only while the entry is admitted."""

    status: EntryState
    livekit_url: str | None = None
    token: str | None = None
    room_name: str | None = None


class WaitingRoomEntryOut(Schema):
    id: int
    display_name: str
    status: WaitingStatus
    recording_consent: bool
    current_location: str
    client_id: int | None = Field(description="The client whose join link was used")
    created_at: datetime
    admitted_at: datetime | None


class ConsentParticipant(Schema):
    """Someone admitted to the session and whether they agreed to recording."""

    entry_id: int
    client_id: int | None
    display_name: str
    recording_consent: bool


class RecordingConsentOut(Schema):
    recording_enabled: bool
    all_consented: bool
    participants: list[ConsentParticipant]


class RecordingCreatedOut(Schema):
    id: int
    status: RecordingStatus
    created_at: datetime


class RecordingOut(Schema):
    id: int
    appointment_id: int
    status: RecordingStatus
    transcript: str
    error: str
    note_id: int | None
    created_at: datetime
