"""Appointment schemas."""

from collections.abc import Container, Sequence
from datetime import date, datetime
from typing import Literal, Self

from pydantic import AwareDatetime, Field, ModelWrapValidatorHandler, model_validator

from synari.models import Appointment, AppointmentParticipant
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    LocationType,
    RecurrenceFrequency,
)
from synari.schemas.common import LongText, PartialUpdate, Schema, ShortText
from synari.services.scheduling import MAX_PARTICIPANTS, is_group_session

EditScope = Literal["this", "following"]

STAFF_SETTABLE_STATUSES = (
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.ATTENDED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.LATE_CANCELED,
    AppointmentStatus.CANCELED,
)
# What one client's attendance can be set to, overriding the session's status for them.
ATTENDANCE_STATUSES = (
    AppointmentStatus.ATTENDED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.LATE_CANCELED,
    AppointmentStatus.CANCELED,
)

BUSY_TITLE = "Busy"


class RecurrenceIn(Schema):
    frequency: RecurrenceFrequency
    interval: int = Field(default=1, ge=1, le=4)
    count: int | None = Field(default=None, ge=2, le=100)
    until: date | None = None

    @model_validator(mode="after")
    def _one_end_condition(self) -> Self:
        if (self.count is None) == (self.until is None):
            raise ValueError("Set exactly one of count or until")
        return self


class ParticipantIn(Schema):
    client_id: int
    billable: bool | None = Field(
        default=None,
        description=(
            "Bill this client for the session. Leave every participant unset for the default: "
            "an individual client, every member of a group, or the identified patient (first "
            "client) of a couples or family session."
        ),
    )


def _unique_clients(participants: Sequence[ParticipantIn]) -> None:
    client_ids = [participant.client_id for participant in participants]
    if len(set(client_ids)) != len(client_ids):
        raise ValueError("Each client can only be added once")


class AppointmentCreate(Schema):
    kind: AppointmentKind = AppointmentKind.APPOINTMENT
    clinician_id: int | None = Field(
        default=None, description="Whose calendar; defaults to you if you're a clinician"
    )
    participants: list[ParticipantIn] = Field(
        default_factory=list,
        max_length=MAX_PARTICIPANTS,
        description="The clients (1 to 15) for an appointment; none for an event",
    )
    group: bool = Field(
        default=False,
        description="A group session: bill every participant (as for group psychotherapy codes)",
    )
    service_id: int | None = None
    location_id: int | None = None
    title: ShortText = Field(default="", description="An event's title, or a group's name")
    starts_at: AwareDatetime
    duration_minutes: int | None = Field(default=None, ge=5, le=1440)
    location_type: LocationType = LocationType.IN_PERSON
    location_details: str = Field(default="", max_length=300)
    memo: LongText = ""
    fee_cents: int | None = Field(
        default=None, ge=0, description="Charge each billed participant this instead of their rate"
    )
    recurrence: RecurrenceIn | None = None
    allow_conflicts: bool = False
    notify_client: bool = Field(
        default=False, description="Email each client that the appointment(s) were scheduled"
    )

    @model_validator(mode="after")
    def _kind_requirements(self) -> Self:
        if self.kind == AppointmentKind.APPOINTMENT and not self.participants:
            raise ValueError("Appointments need a client")
        if self.kind == AppointmentKind.EVENT:
            if self.participants:
                raise ValueError("Events don't have clients")
            if not self.title.strip():
                raise ValueError("Events need a title")
        _unique_clients(self.participants)
        return self


class AppointmentUpdate(PartialUpdate):
    NULLABLE = frozenset({"service_id", "location_id"})

    clinician_id: int | None = None
    participants: list[ParticipantIn] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_PARTICIPANTS,
        description=(
            "The complete list of clients. Clients already in the appointment keep their "
            "attendance and reminders; removing an invoiced client is refused."
        ),
    )
    starts_at: AwareDatetime | None = None
    duration_minutes: int | None = Field(default=None, ge=5, le=1440)
    service_id: int | None = None
    location_id: int | None = None
    title: ShortText | None = None
    location_type: LocationType | None = None
    location_details: str | None = Field(default=None, max_length=300)
    memo: LongText | None = None
    fee_cents: int | None = Field(
        default=None,
        ge=0,
        description="Charge each billed participant who hasn't been invoiced this amount",
    )
    status: AppointmentStatus | None = None
    allow_conflicts: bool = False
    notify_client: bool = Field(
        default=False,
        description=(
            "Email the clients if the time, place or clinician changed, it was canceled, or "
            "they were added or removed"
        ),
    )

    @model_validator(mode="after")
    def _settable_status(self) -> Self:
        if self.status is not None and self.status not in STAFF_SETTABLE_STATUSES:
            raise ValueError(f"Status can't be set to {self.status} here")
        if self.participants is not None:
            _unique_clients(self.participants)
        return self


class ParticipantUpdate(PartialUpdate):
    NULLABLE = frozenset({"attendance"})

    attendance: AppointmentStatus | None = Field(
        default=None,
        description="This client's attendance (attended, no_show, late_canceled, canceled); "
        "null follows the session's status",
    )
    billable: bool | None = Field(
        default=None, description="Bill this client for the session (only before it's invoiced)"
    )

    @model_validator(mode="after")
    def _settable_attendance(self) -> Self:
        if self.attendance is not None and self.attendance not in ATTENDANCE_STATUSES:
            raise ValueError(f"Attendance can't be set to {self.attendance}")
        return self


class AppointmentCancel(Schema):
    reason: str = Field(default="", max_length=1000)
    late: bool = False
    notify_client: bool = Field(
        default=True, description="Email the clients about the cancellation"
    )


class ClientRef(Schema):
    id: int
    first_name: str
    last_name: str
    preferred_name: str


class ParticipantClient(Schema):
    id: int
    name: str = Field(validation_alias="full_name")


class StaffRef(Schema):
    id: int
    name: str = Field(validation_alias="full_name")


class LocationRef(Schema):
    id: int
    name: str
    place_of_service: str


class ParticipantOut(Schema):
    id: int
    client: ParticipantClient
    billable: bool
    fee_cents: int
    attendance: AppointmentStatus | None
    effective_status: AppointmentStatus = Field(
        description="The client's own attendance, else the session's status"
    )


def _names(names: Sequence[str]) -> str:
    """'A', 'A & B' or 'A, B & C'."""
    if len(names) < 2:
        return "".join(names)
    return f"{', '.join(names[:-1])} & {names[-1]}"


def title_label(appointment: Appointment, participants: Sequence[AppointmentParticipant]) -> str:
    """What a calendar shows for an entry: an event's title, a group's name (or 'Group (n)'),
    else the session's title when every client is visible, else the visible clients' names."""
    if appointment.kind == AppointmentKind.EVENT:
        return appointment.title
    if is_group_session(appointment):
        return appointment.title or f"Group ({len(appointment.participants)})"
    everyone = len(participants) == len(appointment.participants)
    if everyone and len(participants) > 1 and appointment.title:
        return appointment.title
    return _names([participant.client.full_name for participant in participants])


class ExternalBusyTime(Schema):
    """Busy time in the clinician's connected personal calendar (times only)."""

    starts_at: datetime
    ends_at: datetime


class AppointmentOut(Schema):
    id: int
    kind: AppointmentKind
    title: str
    title_label: str = Field(
        default="",
        description="The client's name, 'A & B', the group's name or 'Group (n)', an event's "
        "title, or 'Busy'",
    )
    clinician: StaffRef
    participants: list[ParticipantOut] = Field(
        description="Clients in the session (only those you can see); empty for events"
    )
    is_group: bool = Field(default=False, description="A group session: every member is billed")
    service_id: int | None
    service_code: str
    service_description: str
    starts_at: datetime
    ends_at: datetime
    duration_minutes: int
    location_type: LocationType
    location: LocationRef | None
    location_details: str
    status: AppointmentStatus
    source: BookingSource
    memo: str
    request_message: str
    series_id: int | None
    has_video: bool
    canceled_at: datetime | None
    canceled_by: str | None
    cancel_reason: str
    created_at: datetime
    restricted: bool = Field(
        default=False,
        description="True when you can't see its clients: only the time, clinician and room show",
    )
    external_conflicts: list[ExternalBusyTime] = Field(
        default_factory=list,
        description="A warning, filled only in create and update responses: busy times in the "
        "clinician's connected Google or Microsoft calendar that this entry overlaps. The save "
        "went through regardless.",
    )

    @model_validator(mode="wrap")
    @classmethod
    def _labels(cls, data: object, handler: ModelWrapValidatorHandler[Self]) -> Self:
        """Built from an Appointment, the view includes every participant and its label."""
        view = handler(data)
        if isinstance(data, Appointment):
            view.is_group = is_group_session(data)
            view.title_label = title_label(data, data.participants)
        return view

    @classmethod
    def for_viewer(cls, appointment: Appointment, reachable_client_ids: Container[int]) -> Self:
        """The appointment as someone who can reach only `reachable_client_ids` sees it: other
        clients are left out (with a couples or family session's title, which may name them),
        and with none left it's just busy time."""
        view = cls.model_validate(appointment)
        visible = [p for p in appointment.participants if p.client_id in reachable_client_ids]
        if len(visible) == len(appointment.participants):
            return view
        if not visible:
            return view.busy()
        return view.model_copy(
            update={
                "participants": [ParticipantOut.model_validate(p) for p in visible],
                "title": view.title if view.is_group else "",
                "title_label": title_label(appointment, visible),
            }
        )

    def busy(self) -> Self:
        """A colleague's appointment with clients you can't see: just busy time."""
        return self.model_copy(
            update={
                "title": BUSY_TITLE,
                "title_label": BUSY_TITLE,
                "participants": [],
                "is_group": False,
                "service_id": None,
                "service_code": "",
                "service_description": "",
                "location_details": "",
                "memo": "",
                "request_message": "",
                "cancel_reason": "",
                "restricted": True,
            }
        )


class ConflictDetail(Schema):
    message: str
    conflicts: list[AppointmentOut] = Field(description="The clinician's overlapping entries")
    client_conflicts: list[AppointmentOut] = Field(
        default_factory=list,
        description="Other appointments the clients attend at the same time (a warning only)",
    )
