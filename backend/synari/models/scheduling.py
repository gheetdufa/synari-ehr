"""Services, appointments, recurring series and weekly availability."""

from datetime import datetime, time
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from synari.crypto import EncryptedText
from synari.db import Base, TimestampMixin
from synari.models.enums import AppointmentKind, AppointmentStatus, BookingSource, LocationType

if TYPE_CHECKING:
    from synari.models.accounts import Location, StaffMember
    from synari.models.clients import Client


class Service(TimestampMixin, Base):
    """A practice-wide billable service (usually a CPT code) with a default duration and rate."""

    __tablename__ = "services"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    code: Mapped[str] = mapped_column(String(20))
    description: Mapped[str] = mapped_column(String(200))
    duration_minutes: Mapped[int] = mapped_column(default=50)
    rate_cents: Mapped[int] = mapped_column(default=0)
    is_default: Mapped[bool] = mapped_column(default=False)
    is_active: Mapped[bool] = mapped_column(default=True)
    bookable_online: Mapped[bool] = mapped_column(default=False)
    bookable_by_new_clients: Mapped[bool] = mapped_column(default=False)


class ClinicianService(Base):
    """A clinician's own rate for a service, or that they don't offer it.

    No row means the clinician offers the service at the practice rate. Rates resolve as
    client override, then clinician rate, then service rate.
    """

    __tablename__ = "clinician_services"
    __table_args__ = (UniqueConstraint("staff_id", "service_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    staff_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id", ondelete="CASCADE"))
    offered: Mapped[bool] = mapped_column(default=True)
    rate_cents: Mapped[int | None]


class AppointmentSeries(TimestampMixin, Base):
    """Groups the materialized occurrences of a recurring appointment."""

    __tablename__ = "appointment_series"

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"), index=True)
    clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    frequency: Mapped[str] = mapped_column(String(20))
    interval: Mapped[int] = mapped_column(default=1)


class Appointment(TimestampMixin, Base):
    """A calendar entry: a session with one or more clients, or an event that blocks time.

    An individual session has one participant; a couples or family session has several with one
    billed identified patient; a group session bills each member. `status` is the session's
    state and the default attendance for every participant (see AppointmentParticipant).
    """

    __tablename__ = "appointments"
    __table_args__ = (
        Index("ix_appointments_practice_starts", "practice_id", "starts_at"),
        # The calendar: entries overlapping a window end after its start.
        Index("ix_appointments_practice_ends", "practice_id", "ends_at"),
        Index("ix_appointments_clinician_starts", "clinician_id", "starts_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    practice_id: Mapped[int] = mapped_column(ForeignKey("practices.id"))
    # The clinician providing the session (or whose calendar an event blocks).
    clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"))
    kind: Mapped[str] = mapped_column(String(20), default=AppointmentKind.APPOINTMENT)
    title: Mapped[str] = mapped_column(String(200), default="")

    service_id: Mapped[int | None] = mapped_column(ForeignKey("services.id", ondelete="SET NULL"))
    service_code: Mapped[str] = mapped_column(String(20), default="")
    service_description: Mapped[str] = mapped_column(String(200), default="")

    starts_at: Mapped[datetime]
    ends_at: Mapped[datetime]
    location_type: Mapped[str] = mapped_column(String(20), default=LocationType.IN_PERSON)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="SET NULL"))
    location_details: Mapped[str] = mapped_column(String(300), default="")

    status: Mapped[str] = mapped_column(String(20), default=AppointmentStatus.SCHEDULED)
    source: Mapped[str] = mapped_column(String(20), default=BookingSource.STAFF)
    memo: Mapped[str] = mapped_column(EncryptedText("appointments.memo"), default="")
    request_message: Mapped[str] = mapped_column(
        EncryptedText("appointments.request_message"), default=""
    )

    series_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointment_series.id", ondelete="SET NULL"), index=True
    )
    video_room_name: Mapped[str | None] = mapped_column(String(64), unique=True)
    canceled_at: Mapped[datetime | None]
    canceled_by: Mapped[str | None] = mapped_column(String(20))
    cancel_reason: Mapped[str] = mapped_column(
        EncryptedText("appointments.cancel_reason"), default=""
    )

    clinician: Mapped["StaffMember"] = relationship()
    participants: Mapped[list["AppointmentParticipant"]] = relationship(
        back_populates="appointment",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="AppointmentParticipant.id",
    )
    service: Mapped[Service | None] = relationship()
    location: Mapped["Location | None"] = relationship()

    @property
    def duration_minutes(self) -> int:
        return int((self.ends_at - self.starts_at).total_seconds() // 60)

    @property
    def has_video(self) -> bool:
        return self.video_room_name is not None


class AppointmentParticipant(Base):
    """One client in an appointment, with their own attendance, fee, reminders and video link."""

    __tablename__ = "appointment_participants"
    __table_args__ = (UniqueConstraint("appointment_id", "client_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    appointment_id: Mapped[int] = mapped_column(
        ForeignKey("appointments.id", ondelete="CASCADE"), index=True
    )
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    # Billed for this session (couples/family sessions bill only the identified patient).
    billable: Mapped[bool] = mapped_column(default=True)
    fee_cents: Mapped[int] = mapped_column(default=0)
    # What the client owes for this session when it differs from the fee: the copay for
    # insurance clients, then the patient responsibility from the insurer's remittance.
    client_owes_cents: Mapped[int | None]
    # Overrides the session status for this client (e.g. one group member didn't show up).
    attendance: Mapped[str | None] = mapped_column(String(20))
    reminder_email_sent_at: Mapped[datetime | None]
    reminder_sms_sent_at: Mapped[datetime | None]
    # Short public code for this client's text-message join link (services/video_links.py).
    video_join_code: Mapped[str | None] = mapped_column(String(16), unique=True)

    appointment: Mapped[Appointment] = relationship(back_populates="participants")
    client: Mapped["Client"] = relationship(lazy="joined")

    @property
    def effective_status(self) -> str:
        """This client's attendance: their own override, else the session's status."""
        return self.attendance or self.appointment.status

    @property
    def amount_due_cents(self) -> int:
        """What to invoice the client for this session."""
        return self.fee_cents if self.client_owes_cents is None else self.client_owes_cents


class AvailabilityBlock(TimestampMixin, Base):
    """A weekly window when clients may request appointments, in the clinician's time zone."""

    __tablename__ = "availability_blocks"

    id: Mapped[int] = mapped_column(primary_key=True)
    clinician_id: Mapped[int] = mapped_column(ForeignKey("staff_members.id"), index=True)
    weekday: Mapped[int]  # 0 = Monday ... 6 = Sunday
    start_time: Mapped[time]
    end_time: Mapped[time]
    location_type: Mapped[str] = mapped_column(String(20), default=LocationType.VIDEO)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="SET NULL"))
