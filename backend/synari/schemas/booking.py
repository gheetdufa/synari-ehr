"""Availability, online booking, appointment requests and portal appointment schemas."""

import re
from datetime import UTC, date, datetime, time
from itertools import pairwise
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    AliasPath,
    AwareDatetime,
    BeforeValidator,
    Field,
    PlainSerializer,
    WithJsonSchema,
    model_validator,
)

from synari.models.enums import AppointmentStatus, BookingSource, ClientStatus, LocationType
from synari.schemas.appointments import StaffRef
from synari.schemas.common import Email, Schema

MAX_AVAILABILITY_BLOCKS = 100
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _parse_wall_time(value: object) -> object:
    if isinstance(value, time):
        return value
    if isinstance(value, str) and (match := _HHMM.match(value)):
        return time(int(match.group(1)), int(match.group(2)))
    raise ValueError("Use a 24-hour time like 09:30")


def _strip(value: str) -> str:
    return value.strip()


WallTime = Annotated[
    time,
    BeforeValidator(_parse_wall_time),
    PlainSerializer(lambda value: value.strftime("%H:%M"), return_type=str),
    WithJsonSchema({"type": "string", "pattern": _HHMM.pattern, "examples": ["09:30"]}),
]
PersonName = Annotated[str, Field(min_length=1, max_length=100), AfterValidator(_strip)]
Phone = Annotated[str, Field(min_length=7, max_length=30, pattern=r"^[0-9+().\-\s]+$")]
RequestMessage = Annotated[str, Field(max_length=1000)]


class AvailabilityBlockIn(Schema):
    weekday: int = Field(ge=0, le=6, description="0 = Monday ... 6 = Sunday")
    start_time: WallTime
    end_time: WallTime
    location_type: LocationType = LocationType.VIDEO
    location_id: int | None = Field(default=None, description="The office, if any")

    @model_validator(mode="after")
    def _start_before_end(self) -> Self:
        if self.start_time >= self.end_time:
            raise ValueError("Each block must end after it starts")
        return self


class AvailabilityBlockOut(AvailabilityBlockIn):
    id: int
    clinician_id: int


class AvailabilityUpdate(Schema):
    """The clinician's complete weekly availability; replaces whatever was saved before."""

    blocks: list[AvailabilityBlockIn] = Field(max_length=MAX_AVAILABILITY_BLOCKS)

    @model_validator(mode="after")
    def _no_overlaps(self) -> Self:
        ordered = sorted(self.blocks, key=lambda b: (b.weekday, b.start_time))
        for previous, current in pairwise(ordered):
            if previous.weekday == current.weekday and current.start_time < previous.end_time:
                raise ValueError("Availability blocks on the same day can't overlap")
        return self


class SlotOut(Schema):
    starts_at: datetime
    ends_at: datetime
    location_type: LocationType
    location_id: int | None


class BookableService(Schema):
    id: int
    description: str
    duration_minutes: int


class PricedService(BookableService):
    rate_cents: int = Field(description="The clinician's fee for this service")


class BookingLocation(Schema):
    id: int
    name: str
    address: str


class BookingClinician(Schema):
    id: int
    name: str = Field(description="Name with credentials, e.g. 'Jordan Lee, LCSW'")
    time_zone: str = Field(description="Slot dates are in this time zone")


class PublicBookingClinician(BookingClinician):
    services: list[PricedService]


class PortalBookingClinician(BookingClinician):
    services: list[BookableService]


class BookingPage(Schema):
    practice_name: str
    intro: str
    time_zone: str
    clinicians: list[PublicBookingClinician]
    locations: list[BookingLocation]
    # Show the "right to receive a Good Faith Estimate" notice (the practice uses estimates).
    gfe_notice: bool = False


class PortalBookingOptions(Schema):
    """Who on the client's care team they can book with, and where."""

    clinicians: list[PortalBookingClinician]
    locations: list[BookingLocation]


class PublicBookingRequest(Schema):
    clinician_id: int
    service_id: int
    starts_at: AwareDatetime
    location_type: LocationType
    first_name: PersonName
    last_name: PersonName
    date_of_birth: date
    email: Email
    phone: Phone
    message: RequestMessage = ""
    website: str = Field(default="", max_length=500, description="Honeypot; leave empty")

    @model_validator(mode="after")
    def _plausible_birth_date(self) -> Self:
        if not date(1900, 1, 1) <= self.date_of_birth <= datetime.now(UTC).date():
            raise ValueError("Enter a valid date of birth")
        return self


class BookingRequestStatus(Schema):
    status: Literal["requested"] = "requested"


class PortalBookingRequest(Schema):
    clinician_id: int
    service_id: int
    starts_at: AwareDatetime
    location_type: LocationType
    message: RequestMessage = ""


class RequestClient(Schema):
    id: int
    first_name: str
    last_name: str
    preferred_name: str
    status: ClientStatus
    email: str | None
    phone: str
    date_of_birth: date | None


class AppointmentRequestOut(Schema):
    id: int
    clinician: StaffRef
    starts_at: datetime
    ends_at: datetime
    duration_minutes: int
    location_type: LocationType
    location_id: int | None
    service_id: int | None
    service_description: str
    source: BookingSource
    request_message: str
    has_video: bool
    created_at: datetime
    # Requests are always for one client.
    client: RequestClient = Field(validation_alias=AliasPath("participants", 0, "client"))


class DeclineRequest(Schema):
    reason: str = Field(default="", max_length=1000)
    include_reason: bool = Field(
        default=False, description="Show the reason to the client in the decline email"
    )


class PortalAppointmentOut(Schema):
    id: int
    starts_at: datetime
    ends_at: datetime
    status: AppointmentStatus = Field(
        description="The client's own attendance if set (e.g. they canceled their place), else "
        "the session's status"
    )
    location_type: LocationType
    location_details: str
    has_video: bool
    clinician_name: str
    service_description: str
    is_group: bool
    other_participants: list[str] = Field(
        description="First names of the others in a couples or family session; always empty "
        "for group sessions"
    )
    can_cancel: bool
    cancel_is_late: bool = Field(
        description="Canceling now counts as a late cancellation (shared sessions inside the "
        "practice's cancellation window), which may be charged"
    )


class PortalCancelRequest(Schema):
    reason: str = Field(default="", max_length=500)
