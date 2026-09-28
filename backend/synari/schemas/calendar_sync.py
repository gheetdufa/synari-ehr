"""Calendar sync schemas: providers, connections, busy calendars and busy times."""

from datetime import datetime
from typing import Annotated

from pydantic import Field

from synari.models.enums import CalendarConnectionStatus, CalendarProvider
from synari.schemas.common import Schema


class ProviderOut(Schema):
    provider: CalendarProvider
    label: str
    enabled: bool = Field(description="Whether this server is set up to connect to it")


class CalendarSyncSettingsOut(Schema):
    providers: list[ProviderOut]
    include_initials: bool = Field(
        description="Synced events show client initials (only with a BAA covering every "
        "connected account); otherwise they say only 'Appointment'"
    )


class CalendarSyncSettingsUpdate(Schema):
    include_initials: bool


class ConnectUrl(Schema):
    url: str = Field(description="Send the browser here to grant access")


class ConnectionOut(Schema):
    id: int
    provider: CalendarProvider
    account_email: str
    status: CalendarConnectionStatus
    busy_calendar_ids: list[str] = Field(
        description="Calendars whose busy times block availability ('primary' is the main one)"
    )
    last_busy_sync_at: datetime | None = Field(description="When busy times were last read")
    last_error: str
    last_error_at: datetime | None
    pending_events: int = Field(default=0, description="Appointment changes waiting to sync")
    failed_events: int = Field(default=0, description="Appointments that couldn't be synced")
    created_at: datetime


CalendarId = Annotated[str, Field(min_length=1, max_length=300)]


class ConnectionUpdate(Schema):
    busy_calendar_ids: list[CalendarId] = Field(min_length=1, max_length=10)


class CalendarOut(Schema):
    id: str
    name: str


class BusyBlockOut(Schema):
    """Busy time in a clinician's own calendar: the times only."""

    id: int
    clinician_id: int
    starts_at: datetime
    ends_at: datetime
