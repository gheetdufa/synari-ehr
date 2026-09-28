"""Appointment reminder job: timing, consent, content, idempotency and re-arming."""

from collections.abc import Sequence
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClientContact,
    Location,
    OutboundMessage,
    Practice,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import (
    AppointmentStatus,
    LocationType,
    OutboundChannel,
    StaffRole,
    StaffStatus,
)
from synari.services.reminders import SMS_OPT_OUT, send_appointment_reminders, sms_reminder
from synari.services.video_links import decode_join_token
from synari.worker import JOBS
from tests.conftest import StaffAccount, add_staff, create_client_record, outbound_to

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")


@pytest.fixture
def twilio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "twilio_account_sid", "AC0000")
    monkeypatch.setattr(settings, "twilio_auth_token", "token")
    monkeypatch.setattr(settings, "twilio_from_number", "+15550001111")


def _practice(db: Session, practice_id: int, **changes: Any) -> PracticeSettings:
    practice = db.get(PracticeSettings, practice_id)
    assert practice is not None
    for field, value in changes.items():
        setattr(practice, field, value)
    db.commit()
    return practice


def _scheduled(
    db: Session,
    staff: StaffAccount,
    client: Client,
    starts_in: timedelta,
    *,
    created_ago: timedelta = timedelta(days=3),
    others: Sequence[Client] = (),
    **fields: Any,
) -> Appointment:
    """A scheduled session with `client` (and `others`) created a while ago."""
    now = utcnow()
    appointment = Appointment(
        practice_id=staff.practice_id,
        clinician_id=staff.id,
        participants=[
            AppointmentParticipant(client_id=member.id, fee_cents=15000)
            for member in (client, *others)
        ],
        starts_at=now + starts_in,
        ends_at=now + starts_in + timedelta(minutes=50),
        service_description="Psychotherapy, 45 min",
        memo="Discussed grief",
        created_at=now - created_ago,
        **fields,
    )
    db.add(appointment)
    db.commit()
    return appointment


def _place(db: Session, appointment: Appointment, client: Client) -> AppointmentParticipant:
    """The client's participant row, freshly loaded."""
    db.expire_all()
    return (
        db.query(AppointmentParticipant)
        .filter_by(appointment_id=appointment.id, client_id=client.id)
        .one()
    )


def _run(db: Session) -> None:
    send_appointment_reminders(db, utcnow())
    db.expire_all()


def _sms(db: Session) -> list[OutboundMessage]:
    db.expire_all()
    return list(db.query(OutboundMessage).filter(OutboundMessage.channel == OutboundChannel.SMS))


def test_reminder_job_is_registered() -> None:
    assert send_appointment_reminders in JOBS


def test_email_reminder_is_sent_once(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    api.patch(
        "/api/practice",
        json={
            "address_line1": "12 Elm St",
            "city": "Albany",
            "state": "NY",
            "phone": "555-100-2000",
        },
        headers=clinician.headers,
    )
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=clinician.headers)
    client = create_client_record(db, clinician)
    appointment = _scheduled(db, clinician, client, timedelta(hours=20))
    _run(db)

    [reminder] = outbound_to(db, "alex@example.com")
    assert reminder.subject == "Appointment reminder"
    assert reminder.practice_id == clinician.practice_id
    local = appointment.starts_at.astimezone(NY)
    assert f"{local:%B} {local.day}, {local.year}" in reminder.body_text
    assert "Jordan Lee, LCSW" in reminder.body_text
    assert "12 Elm St, Albany, NY" in reminder.body_text
    assert "contact Lee Counseling at 555-100-2000" in reminder.body_text
    for private in ("Psychotherapy", "grief"):
        assert private not in reminder.body_text
    place = _place(db, appointment, client)
    assert place.reminder_email_sent_at is not None

    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 1
    # Even if the sent marker were lost, the outbox dedupe key prevents a second email.
    place = _place(db, appointment, client)
    place.reminder_email_sent_at = None
    db.commit()
    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 1


def test_reminders_name_the_clinician_and_their_office(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    api.patch("/api/practice", json={"address_line1": "12 Elm St"}, headers=clinician.headers)
    riley = add_staff(
        db,
        clinician.practice_id,
        "riley@example.com",
        StaffRole.CLINICIAN,
        first_name="Riley",
        last_name="Chen",
    )
    api.patch("/api/me", json={"time_zone": "America/Los_Angeles"}, headers=riley.headers)
    office = Location(
        practice_id=clinician.practice_id, name="Troy", address_line1="400 Main St", city="Troy"
    )
    db.add(office)
    db.commit()
    client = create_client_record(db, clinician)
    appointment = _scheduled(db, riley, client, timedelta(hours=10), location_id=office.id)
    _run(db)

    [reminder] = outbound_to(db, "alex@example.com")
    assert "appointment with Riley Chen" in reminder.body_text
    assert "400 Main St, Troy" in reminder.body_text
    assert "12 Elm St" not in reminder.body_text
    # The client has no time zone of their own, so the clinician's is used.
    assert appointment.starts_at.astimezone(LA).tzname() in reminder.body_text


def test_deactivated_clinicians_appointments_get_no_reminders(
    clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    _scheduled(db, clinician, client, timedelta(hours=10))
    member = db.get(StaffMember, clinician.id)
    assert member is not None
    member.status = StaffStatus.DEACTIVATED
    db.commit()
    _run(db)
    assert outbound_to(db, "alex@example.com") == []


def test_reminders_wait_for_the_practice_window(clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    _scheduled(db, clinician, client, timedelta(hours=30))
    _run(db)
    assert outbound_to(db, "alex@example.com") == []
    _practice(db, clinician.practice_id, reminder_email_hours=36)
    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 1


@pytest.mark.parametrize(
    ("client_fields", "appointment_fields", "practice_fields", "starts_in"),
    [
        ({"email_reminders": False}, {}, {}, timedelta(hours=5)),
        ({"email": None}, {}, {}, timedelta(hours=5)),
        ({}, {}, {"reminder_email_enabled": False}, timedelta(hours=5)),
        ({}, {"status": AppointmentStatus.CANCELED}, {}, timedelta(hours=5)),
        ({}, {"status": AppointmentStatus.REQUESTED}, {}, timedelta(hours=5)),
        ({}, {"status": AppointmentStatus.ATTENDED}, {}, timedelta(hours=5)),
        ({}, {}, {}, timedelta(hours=-1)),
    ],
    ids=[
        "client-declined",
        "no-email",
        "practice-off",
        "canceled",
        "requested",
        "attended",
        "already-started",
    ],
)
def test_email_reminders_need_consent_and_a_scheduled_visit(
    clinician: StaffAccount,
    db: Session,
    client_fields: dict[str, Any],
    appointment_fields: dict[str, Any],
    practice_fields: dict[str, Any],
    starts_in: timedelta,
) -> None:
    _practice(db, clinician.practice_id, **practice_fields)
    client = create_client_record(db, clinician, **client_fields)
    _scheduled(db, clinician, client, starts_in, **appointment_fields)
    _run(db)
    assert db.query(OutboundMessage).count() == 0


def test_same_day_bookings_skip_the_instant_reminder(clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    appointment = _scheduled(
        db, clinician, client, timedelta(minutes=40), created_ago=timedelta(minutes=5)
    )
    later = _scheduled(db, clinician, client, timedelta(hours=3), created_ago=timedelta(minutes=5))
    _run(db)
    [reminder] = outbound_to(db, "alex@example.com")
    later_place = _place(db, later, client)
    assert reminder.dedupe_key is not None
    assert reminder.dedupe_key.startswith(f"reminder:email:{later_place.id}:client:")

    appointment.created_at = utcnow() - timedelta(hours=2)
    db.commit()
    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 2


def test_reminders_use_the_clients_time_zone(clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician, time_zone="America/Los_Angeles")
    appointment = _scheduled(db, clinician, client, timedelta(hours=10))
    _run(db)
    [reminder] = outbound_to(db, "alex@example.com")
    local = appointment.starts_at.astimezone(LA)
    clock = f"{local.hour % 12 or 12}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"
    assert f"{local:%A, %B} {local.day}, {local.year} at {clock} {local:%Z}" in reminder.body_text
    assert local.tzname() in ("PDT", "PST")


def test_video_reminders_carry_a_join_link(clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    appointment = _scheduled(
        db,
        clinician,
        client,
        timedelta(hours=2),
        location_type=LocationType.VIDEO,
        video_room_name="synari-test-room",
    )
    _run(db)
    [reminder] = outbound_to(db, "alex@example.com")
    assert "Join video appointment: http://app.test/join/" in reminder.body_text
    assert "Jordan Lee will let you in from the waiting room" in reminder.body_text
    token = reminder.body_text.split("/join/")[1].split()[0]
    claims = decode_join_token(token)
    assert claims is not None
    assert (claims.appointment_id, claims.client_id) == (appointment.id, client.id)


@pytest.mark.usefixtures("twilio")
def test_sms_reminder_is_sent_once(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    api.patch("/api/practice", json={"address_line1": "12 Elm St"}, headers=clinician.headers)
    _practice(db, clinician.practice_id, reminder_sms_enabled=True, reminder_sms_hours=48)
    client = create_client_record(db, clinician, sms_reminders=True, phone="(555) 201-3344")
    appointment = _scheduled(db, clinician, client, timedelta(hours=40))
    _run(db)

    [text] = _sms(db)
    assert text.to_address == "+15552013344"
    assert text.practice_id == clinician.practice_id
    assert len(text.body_text) <= 320
    assert text.body_text.endswith(SMS_OPT_OUT)
    assert "Jordan Lee" in text.body_text
    assert "12 Elm St" in text.body_text
    assert "Psychotherapy" not in text.body_text
    # The email window (24h) hasn't opened yet.
    assert outbound_to(db, "alex@example.com") == []
    place = _place(db, appointment, client)
    assert place.reminder_sms_sent_at is not None
    assert place.reminder_email_sent_at is None

    _run(db)
    assert len(_sms(db)) == 1


@pytest.mark.parametrize(
    ("configured", "client_fields", "practice_fields"),
    [
        (False, {}, {}),
        (True, {"sms_opted_out": True}, {}),
        (True, {"sms_reminders": False}, {}),
        (True, {}, {"reminder_sms_enabled": False}),
        (True, {"phone": ""}, {}),
        (True, {"phone": "12345"}, {}),
    ],
    ids=["twilio-off", "opted-out", "client-declined", "practice-off", "no-phone", "bad-phone"],
)
def test_sms_reminders_need_consent_and_configuration(
    clinician: StaffAccount,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    configured: bool,
    client_fields: dict[str, Any],
    practice_fields: dict[str, Any],
) -> None:
    if configured:
        monkeypatch.setattr(settings, "twilio_account_sid", "AC0000")
        monkeypatch.setattr(settings, "twilio_auth_token", "token")
        monkeypatch.setattr(settings, "twilio_from_number", "+15550001111")
    _practice(db, clinician.practice_id, **{"reminder_sms_enabled": True, **practice_fields})
    fields = {"sms_reminders": True, "phone": "555-201-3344", "email": None, **client_fields}
    client = create_client_record(db, clinician, **fields)
    appointment = _scheduled(db, clinician, client, timedelta(hours=5))
    _run(db)
    assert _sms(db) == []
    assert _place(db, appointment, client).reminder_sms_sent_at is None


def test_sms_text_stays_within_the_limit() -> None:
    clinician = StaffMember(first_name="A" * 100, last_name="B" * 100, credentials="C" * 100)
    practice = Practice(name="Practice", address_line1="1 Long Road")
    starts_at = datetime.combine(datetime.now(NY).date() + timedelta(days=1), time(9), tzinfo=NY)
    in_person = Appointment(
        starts_at=starts_at,
        ends_at=starts_at + timedelta(minutes=50),
        location_type=LocationType.IN_PERSON,
        location_details="",
    )
    long_name = sms_reminder(in_person, clinician, practice, NY)
    assert len(long_name) <= 320
    assert long_name.startswith("Reminder: you have an appointment on")
    assert long_name.endswith(SMS_OPT_OUT)

    clinician.first_name, clinician.last_name, clinician.credentials = "Jordan", "Lee", ""
    video = Appointment(
        starts_at=starts_at,
        ends_at=starts_at + timedelta(minutes=50),
        location_type=LocationType.VIDEO,
        location_details="",
    )
    assert "join from your email or client portal" in sms_reminder(video, clinician, practice, NY)
    with_link = sms_reminder(video, clinician, practice, NY, "http://app.test/j/AbCdEfGhIjK")
    assert "Join video: http://app.test/j/AbCdEfGhIjK" in with_link
    assert len(with_link) <= 320
    assert "Location: 1 Long Road." in sms_reminder(in_person, clinician, practice, NY)


def test_rescheduling_rearms_reminders(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _scheduled(db, clinician, client, timedelta(hours=10))
    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 1

    moved = api.patch(
        f"/api/appointments/{appointment.id}",
        json={"starts_at": (appointment.starts_at + timedelta(hours=2)).isoformat()},
        headers=clinician.headers,
    )
    assert moved.status_code == 200
    assert _place(db, appointment, client).reminder_email_sent_at is None
    _run(db)
    assert len(outbound_to(db, "alex@example.com")) == 2

    memo_only = api.patch(
        f"/api/appointments/{appointment.id}", json={"memo": "x"}, headers=clinician.headers
    )
    assert memo_only.status_code == 200
    assert _place(db, appointment, client).reminder_email_sent_at is not None

    office = api.post(
        "/api/practice/locations",
        json={"name": "Troy", "address_line1": "400 Main St"},
        headers=clinician.headers,
    ).json()
    new_office = api.patch(
        f"/api/appointments/{appointment.id}",
        json={"location_id": office["id"]},
        headers=clinician.headers,
    )
    assert new_office.status_code == 200
    assert _place(db, appointment, client).reminder_email_sent_at is None
    _run(db)
    assert "400 Main St" in outbound_to(db, "alex@example.com")[-1].body_text


def _guardian(db: Session, client: Client, email: str, **fields: Any) -> ClientContact:
    """A parent with portal access (unless `fields` say otherwise)."""
    values: dict[str, Any] = {
        "first_name": "Maria",
        "last_name": "Rivera",
        "relation": "Mother",
        "is_guardian": True,
        "portal_access": True,
        **fields,
    }
    contact = ClientContact(client_id=client.id, email=email, **values)
    db.add(contact)
    db.commit()
    return contact


def test_each_participant_and_their_guardians_get_reminders(
    clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(
        db, clinician, first_name="Jamie", email=None, is_minor=True, preferred_name="Jay"
    )
    parent = create_client_record(db, clinician, first_name="Pat", email="pat@example.com")
    guardian = _guardian(db, minor, "maria@example.com")
    _guardian(db, minor, "no-portal@example.com", portal_access=False)
    _guardian(db, minor, "", first_name="No email")
    appointment = _scheduled(
        db,
        clinician,
        minor,
        timedelta(hours=5),
        others=[parent],
        location_type=LocationType.VIDEO,
        video_room_name="synari-family-room",
    )
    _run(db)

    [to_guardian] = outbound_to(db, "maria@example.com")
    assert "Hi Maria," in to_guardian.body_text
    assert "reminder of Jay's appointment with Jordan Lee" in to_guardian.body_text
    [to_parent] = outbound_to(db, "pat@example.com")
    assert "reminder of your appointment" in to_parent.body_text
    assert outbound_to(db, "no-portal@example.com") == []
    assert db.query(OutboundMessage).count() == 2
    # Each client's video link is their own; the guardian gets the minor's.
    for message, client in ((to_guardian, minor), (to_parent, parent)):
        token = message.body_text.split("/join/")[1].split()[0]
        claims = decode_join_token(token)
        assert claims is not None
        assert (claims.appointment_id, claims.client_id) == (appointment.id, client.id)
    minor_place = _place(db, appointment, minor)
    assert to_guardian.dedupe_key == (
        f"reminder:email:{minor_place.id}:contact-{guardian.id}:"
        f"{int(appointment.starts_at.timestamp())}:video:"
    )
    assert minor_place.reminder_email_sent_at is not None
    _run(db)
    assert db.query(OutboundMessage).count() == 2


def test_guardians_follow_the_clients_consent_and_canceled_places_are_skipped(
    clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None, email_reminders=False)
    _guardian(db, minor, "maria@example.com")
    member = create_client_record(db, clinician, first_name="Kim", email="kim@example.com")
    appointment = _scheduled(db, clinician, minor, timedelta(hours=5), others=[member])
    place = _place(db, appointment, member)
    place.attendance = AppointmentStatus.CANCELED
    db.commit()
    _run(db)
    assert db.query(OutboundMessage).count() == 0


@pytest.mark.usefixtures("twilio")
def test_sms_reminders_carry_each_participants_own_short_link(
    clinician: StaffAccount, db: Session
) -> None:
    _practice(db, clinician.practice_id, reminder_sms_enabled=True)
    first = create_client_record(
        db, clinician, email=None, sms_reminders=True, phone="555-201-0001"
    )
    second = create_client_record(
        db, clinician, email=None, sms_reminders=True, phone="555-201-0002"
    )
    appointment = _scheduled(
        db,
        clinician,
        first,
        timedelta(hours=5),
        others=[second],
        location_type=LocationType.VIDEO,
        video_room_name="synari-group-room",
    )
    _run(db)
    texts = {text.to_address: text.body_text for text in _sms(db)}
    places = {client.id: _place(db, appointment, client) for client in (first, second)}
    for client, phone in ((first, "+15552010001"), (second, "+15552010002")):
        code = places[client.id].video_join_code
        assert code is not None
        assert f"http://app.test/j/{code}" in texts[phone]
    assert places[first.id].video_join_code != places[second.id].video_join_code
