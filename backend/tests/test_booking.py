"""Availability, slot math, public and portal booking, requests, portal appointments,
client notices and Twilio opt-out webhooks."""

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.api.twilio_webhooks import twilio_signature
from synari.config import settings
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AuthToken,
    AvailabilityBlock,
    Client,
    ClientContact,
    ClinicianService,
    Location,
    Notification,
    OutboundMessage,
    PracticeSettings,
    Service,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    AuthTokenPurpose,
    BookingSource,
    ClientStatus,
    LocationType,
    Role,
    StaffRole,
)
from synari.security import hash_opaque_token
from synari.services.availability import SlotRules, available_slots, compute_slots, slot_rules
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    link_token,
    outbound_to,
    portal_headers,
    register_practice,
)

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")
SLUG = "lee-counseling"
HOUR = timedelta(hours=1)


# --- helpers ---------------------------------------------------------------------------------


def _block(weekday: int, start: str, end: str, location: str = "video") -> AvailabilityBlock:
    return AvailabilityBlock(
        weekday=weekday,
        start_time=time.fromisoformat(start),
        end_time=time.fromisoformat(end),
        location_type=location,
    )


def _rules(minutes: int, step: int | None = None, *, last: date) -> SlotRules:
    return SlotRules(
        duration=timedelta(minutes=minutes),
        step=timedelta(minutes=step or minutes),
        earliest_start=datetime(2000, 1, 1, tzinfo=UTC),
        last_date=last,
    )


def _local_times(slots: list[Any], zone: ZoneInfo) -> list[str]:
    return [s.starts_at.astimezone(zone).strftime("%H:%M") for s in slots]


def _colleague(db: Session, practice_id: int, email: str = "riley@example.com") -> StaffAccount:
    return add_staff(
        db, practice_id, email, StaffRole.CLINICIAN, first_name="Riley", last_name="Chen"
    )


def _set_availability(
    api: TestClient,
    account: StaffAccount,
    clinician_id: int | None = None,
    office_id: int | None = None,
) -> None:
    """Video mornings and in-person afternoons every day (for `clinician_id`, else yourself)."""
    blocks = [
        {"weekday": d, "start_time": "09:00", "end_time": "12:00", "location_type": "video"}
        for d in range(7)
    ] + [
        {
            "weekday": d,
            "start_time": "13:00",
            "end_time": "17:00",
            "location_type": "in_person",
            "location_id": office_id,
        }
        for d in range(7)
    ]
    params = {"clinician_id": clinician_id} if clinician_id is not None else {}
    response = api.put(
        "/api/availability", params=params, json={"blocks": blocks}, headers=account.headers
    )
    assert response.status_code == 200, response.text


def _open_booking(api: TestClient, account: StaffAccount, **settings_changes: Any) -> None:
    practice = {"booking_slug": SLUG, "address_line1": "12 Elm St", "city": "Albany"}
    assert api.patch("/api/practice", json=practice, headers=account.headers).is_success
    changes = {"booking_enabled": True, **settings_changes}
    assert api.patch("/api/practice/settings", json=changes, headers=account.headers).is_success
    _set_availability(api, account)


def _service(api: TestClient, account: StaffAccount, **fields: Any) -> dict[str, Any]:
    body = {
        "code": "INTAKE",
        "description": "Intake call",
        "duration_minutes": 60,
        "rate_cents": 12000,
        "bookable_online": True,
        "bookable_by_new_clients": True,
        **fields,
    }
    response = api.post("/api/practice/services", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _day(offset: int = 3) -> date:
    return datetime.now(NY).date() + timedelta(days=offset)


def _slots(api: TestClient, clinician_id: int, service_id: int, day: date) -> list[dict[str, Any]]:
    response = api.get(
        f"/api/booking/{SLUG}/slots",
        params={
            "clinician_id": clinician_id,
            "service_id": service_id,
            "start_date": str(day),
            "end_date": str(day),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _request_body(
    clinician_id: int, service_id: int, slot: dict[str, Any], **overrides: Any
) -> dict[str, Any]:
    return {
        "clinician_id": clinician_id,
        "service_id": service_id,
        "starts_at": slot["starts_at"],
        "location_type": slot["location_type"],
        "first_name": "Sam",
        "last_name": "Taylor",
        "date_of_birth": "1990-04-02",
        "email": "sam@example.com",
        "phone": "(555) 404-1234",
        "message": "Looking for help with panic attacks.",
        **overrides,
    }


def _public_request(
    api: TestClient, account: StaffAccount, **overrides: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Open booking, request the first video slot three days out with `account`; return
    (service, slot)."""
    _open_booking(api, account)
    service = _service(api, account)
    slot = _slots(api, account.id, service["id"], _day())[0]
    response = api.post(
        f"/api/booking/{SLUG}/requests",
        json=_request_body(account.id, service["id"], slot, **overrides),
    )
    assert response.status_code == 202, response.text
    assert response.json() == {"status": "requested"}
    return service, slot


def _only_request(db: Session) -> Appointment:
    db.expire_all()
    return db.query(Appointment).filter(Appointment.status == AppointmentStatus.REQUESTED).one()


def _requester(appointment: Appointment) -> AppointmentParticipant:
    """The one client of a requested appointment."""
    [participant] = appointment.participants
    return participant


def _appointment(
    db: Session,
    staff: StaffAccount,
    client: Client | None,
    *,
    others: Sequence[Client] = (),
    group: bool = False,
    **fields: Any,
) -> Appointment:
    """An appointment with `client` (and `others`), or an event when `client` is None. Only
    `client` is billed unless it's a group."""
    starts_at = fields.pop("starts_at")
    clients = [client, *others] if client else []
    values: dict[str, Any] = {
        "practice_id": staff.practice_id,
        "clinician_id": staff.id,
        "participants": [
            AppointmentParticipant(
                client_id=member.id,
                billable=member is client or group,
                fee_cents=15000 if member is client or group else 0,
            )
            for member in clients
        ],
        "starts_at": starts_at,
        "ends_at": starts_at + timedelta(minutes=50),
        "service_description": "Psychotherapy, 45 min",
        "memo": "Discussed grief",
        **fields,
    }
    appointment = Appointment(**values)
    db.add(appointment)
    db.commit()
    return appointment


def _guardian(db: Session, client: Client, email: str, first_name: str = "Maria") -> ClientContact:
    """A parent who signs in to the client's portal."""
    contact = ClientContact(
        client_id=client.id,
        first_name=first_name,
        email=email,
        is_guardian=True,
        portal_access=True,
    )
    db.add(contact)
    db.commit()
    return contact


def _guardian_headers(contact: ClientContact) -> dict[str, str]:
    """A guardian's portal session, acting for their client."""
    return portal_headers(contact.client, contact)


def _subjects(db: Session, address: str) -> list[str]:
    return [m.subject for m in outbound_to(db, address)]


def _notified(db: Session, staff_id: int) -> list[str]:
    db.expire_all()
    rows = db.query(Notification).filter(
        Notification.recipient_role == Role.STAFF, Notification.recipient_id == staff_id
    )
    return [n.title for n in rows.order_by(Notification.id)]


# --- slot math -------------------------------------------------------------------------------


def test_slots_step_by_duration_or_interval() -> None:
    monday = date(2026, 10, 5)
    blocks = [_block(0, "09:00", "12:00")]
    hourly = compute_slots(blocks, [], NY, monday, _rules(60, last=monday))
    assert _local_times(hourly, NY) == ["09:00", "10:00", "11:00"]
    assert all(s.location_type == "video" for s in hourly)

    half_hourly = compute_slots(blocks, [], NY, monday, _rules(60, 30, last=monday))
    assert _local_times(half_hourly, NY) == ["09:00", "09:30", "10:00", "10:30", "11:00"]

    fifty = compute_slots(blocks, [], NY, monday, _rules(50, last=monday))
    assert _local_times(fifty, NY) == ["09:00", "09:50", "10:40"]
    assert fifty[-1].ends_at.astimezone(NY).strftime("%H:%M") == "11:30"


def test_slots_keep_local_time_across_dst() -> None:
    blocks = [_block(0, "09:00", "10:00")]
    before, after = date(2026, 10, 26), date(2026, 11, 2)
    slots = compute_slots(blocks, [], NY, before, _rules(60, last=after))
    assert [s.starts_at for s in slots] == [
        datetime(2026, 10, 26, 13, tzinfo=UTC),  # 9:00 EDT
        datetime(2026, 11, 2, 14, tzinfo=UTC),  # 9:00 EST
    ]


def test_spring_forward_gap_is_skipped() -> None:
    sunday = date(2027, 3, 14)  # 2:00-3:00 AM doesn't exist in New York
    slots = compute_slots([_block(6, "01:00", "04:00")], [], NY, sunday, _rules(60, last=sunday))
    assert [s.starts_at for s in slots] == [
        datetime(2027, 3, 14, 6, tzinfo=UTC),  # 1:00 EST
        datetime(2027, 3, 14, 7, tzinfo=UTC),  # 3:00 EDT
    ]
    assert _local_times(slots, NY) == ["01:00", "03:00"]


def test_fall_back_hour_uses_first_occurrence_and_stays_in_block() -> None:
    sunday = date(2026, 11, 1)  # 1:00-2:00 AM happens twice in New York
    slots = compute_slots([_block(6, "01:00", "03:00")], [], NY, sunday, _rules(60, last=sunday))
    assert [(s.starts_at, s.ends_at) for s in slots] == [
        (datetime(2026, 11, 1, 5, tzinfo=UTC), datetime(2026, 11, 1, 6, tzinfo=UTC)),
        (datetime(2026, 11, 1, 7, tzinfo=UTC), datetime(2026, 11, 1, 8, tzinfo=UTC)),
    ]


def test_slots_follow_the_clinicians_time_zone() -> None:
    tuesday = date(2026, 10, 6)
    blocks = [_block(1, "09:00", "10:00", "in_person")]
    slots = compute_slots(blocks, [], LA, tuesday, _rules(60, last=tuesday))
    assert [s.starts_at for s in slots] == [datetime(2026, 10, 6, 16, tzinfo=UTC)]
    assert slots[0].location_type == "in_person"


def test_minimum_notice_and_booking_horizon() -> None:
    practice = PracticeSettings(
        booking_min_notice_hours=2, booking_max_days_ahead=1, booking_slot_interval_minutes=0
    )
    service = Service(duration_minutes=60)
    now = datetime(2026, 10, 5, 8, 30, tzinfo=NY)  # Monday
    rules = slot_rules(practice, NY, service, date(2026, 10, 10), now)
    blocks = [_block(d, "09:00", "12:00") for d in range(7)]
    slots = compute_slots(blocks, [], NY, date(2026, 10, 4), rules)
    assert [s.starts_at.astimezone(NY).strftime("%a %H:%M") for s in slots] == [
        "Mon 11:00",
        "Tue 09:00",
        "Tue 10:00",
        "Tue 11:00",
    ]


def test_busy_times_block_slots_per_clinician(clinician: StaffAccount, db: Session) -> None:
    colleague = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    for block in (_block(0, "09:00", "13:00"), _block(0, "14:00", "15:00")):
        block.clinician_id = clinician.id
        db.add(block)
    db.commit()
    day = date(2026, 10, 5)

    def at(hour: int) -> datetime:
        return datetime(2026, 10, 5, hour, tzinfo=NY)

    _appointment(db, clinician, client, starts_at=at(9), status=AppointmentStatus.CANCELED)
    _appointment(db, clinician, client, starts_at=at(10))
    _appointment(db, clinician, client, starts_at=at(11), status=AppointmentStatus.REQUESTED)
    _appointment(db, clinician, None, starts_at=at(12), kind=AppointmentKind.EVENT, title="Lunch")
    # A colleague's busy time doesn't block this clinician's calendar.
    _appointment(db, colleague, None, starts_at=at(14), kind=AppointmentKind.EVENT, title="X")

    owner = db.get(StaffMember, clinician.id)
    assert owner is not None
    service = Service(duration_minutes=60)
    slots = available_slots(db, owner, service, day, day, datetime(2026, 9, 1, tzinfo=UTC))
    assert _local_times(slots, NY) == ["09:00", "14:00"]


# --- availability ----------------------------------------------------------------------------


def test_availability_replace_and_validation(api: TestClient, clinician: StaffAccount) -> None:
    def put(blocks: list[dict[str, Any]]) -> Any:
        return api.put("/api/availability", json={"blocks": blocks}, headers=clinician.headers)

    first = put(
        [
            {
                "weekday": 2,
                "start_time": "13:00",
                "end_time": "17:00",
                "location_type": "in_person",
            },
            {"weekday": 0, "start_time": "09:00", "end_time": "12:00"},
            {"weekday": 0, "start_time": "12:00", "end_time": "12:30", "location_type": "phone"},
        ]
    )
    assert first.status_code == 200, first.text
    listed = api.get("/api/availability", headers=clinician.headers).json()
    assert [(b["weekday"], b["start_time"], b["end_time"]) for b in listed] == [
        (0, "09:00", "12:00"),
        (0, "12:00", "12:30"),
        (2, "13:00", "17:00"),
    ]
    assert listed[0]["location_type"] == "video"
    assert {b["clinician_id"] for b in listed} == {clinician.id}

    invalid = [
        [{"weekday": 1, "start_time": "10:00", "end_time": "10:00"}],
        [{"weekday": 1, "start_time": "11:00", "end_time": "09:00"}],
        [
            {"weekday": 1, "start_time": "09:00", "end_time": "11:00"},
            {"weekday": 1, "start_time": "10:30", "end_time": "12:00"},
        ],
        [{"weekday": 7, "start_time": "09:00", "end_time": "10:00"}],
        [{"weekday": 1, "start_time": "9am", "end_time": "10:00"}],
        [{"weekday": 1, "start_time": "09:00:30", "end_time": "10:00"}],
        [{"weekday": 1, "start_time": "09:00", "end_time": "10:00", "location_type": "moon"}],
    ]
    for blocks in invalid:
        assert put(blocks).status_code == 422, blocks
    assert len(api.get("/api/availability", headers=clinician.headers).json()) == 3

    assert put([{"weekday": 4, "start_time": "08:00", "end_time": "09:00"}]).status_code == 200
    replaced = api.get("/api/availability", headers=clinician.headers).json()
    assert [(b["weekday"], b["start_time"]) for b in replaced] == [(4, "08:00")]

    other = register_practice(api, email="other@example.com")
    assert api.get("/api/availability", headers=other.headers).json() == []
    assert api.get("/api/availability").status_code == 401


def test_availability_is_per_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    other = register_practice(api, email="other@example.com")
    _set_availability(api, clinician)

    def get(account: StaffAccount, clinician_id: int | None = None) -> Any:
        params = {"clinician_id": clinician_id} if clinician_id is not None else {}
        return api.get("/api/availability", params=params, headers=account.headers)

    assert get(colleague).json() == []
    assert get(colleague, clinician.id).status_code == 403
    colleague_put = api.put(
        "/api/availability",
        params={"clinician_id": clinician.id},
        json={"blocks": []},
        headers=colleague.headers,
    )
    assert colleague_put.status_code == 403

    # Schedulers manage everyone's availability but have none of their own.
    assert len(get(scheduler, clinician.id).json()) == 14
    assert get(scheduler).status_code == 404
    assert get(scheduler, other.id).status_code == 404
    _set_availability(api, scheduler, clinician_id=colleague.id)
    assert {b["clinician_id"] for b in get(colleague).json()} == {colleague.id}
    assert len(get(clinician).json()) == 14


def test_availability_blocks_carry_offices_into_bookings(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician)
    office = api.post(
        "/api/practice/locations",
        json={"name": "Troy office", "address_line1": "400 Main St", "city": "Troy"},
        headers=clinician.headers,
    ).json()
    closed = Location(practice_id=clinician.practice_id, name="Old office", is_active=False)
    other = register_practice(api, email="other@example.com")
    foreign = Location(practice_id=other.practice_id, name="Elsewhere")
    db.add_all([closed, foreign])
    db.commit()

    def put_office(location_id: int) -> int:
        block = {
            "weekday": 0,
            "start_time": "09:00",
            "end_time": "10:00",
            "location_id": location_id,
        }
        response = api.put("/api/availability", json={"blocks": [block]}, headers=clinician.headers)
        return response.status_code

    assert put_office(closed.id) == 422
    assert put_office(foreign.id) == 404

    _set_availability(api, clinician, office_id=office["id"])
    service = _service(api, clinician)
    page = api.get(f"/api/booking/{SLUG}").json()
    assert {"id": office["id"], "name": "Troy office", "address": "400 Main St, Troy"} in page[
        "locations"
    ]
    in_person = [s for s in _slots(api, clinician.id, service["id"], _day()) if s["location_id"]]
    assert in_person and {s["location_id"] for s in in_person} == {office["id"]}
    response = api.post(
        f"/api/booking/{SLUG}/requests",
        json=_request_body(clinician.id, service["id"], in_person[0]),
    )
    assert response.status_code == 202, response.text
    appointment = _only_request(db)
    assert appointment.location_id == office["id"]
    client = _requester(appointment).client
    assert client is not None
    listed = api.get("/api/portal/appointments", headers=portal_headers(client)).json()
    assert listed[0]["location_details"] == "400 Main St, Troy"


# --- public booking page ---------------------------------------------------------------------


def test_booking_page_visibility(api: TestClient, clinician: StaffAccount) -> None:
    assert api.get(f"/api/booking/{SLUG}").status_code == 404
    api.patch("/api/practice", json={"booking_slug": SLUG}, headers=clinician.headers)
    assert api.get(f"/api/booking/{SLUG}").status_code == 404  # booking not enabled

    _open_booking(api, clinician, booking_intro="Welcome!")
    new_clients = _service(api, clinician)
    _service(api, clinician, code="FOLLOW", bookable_by_new_clients=False)
    _service(api, clinician, code="OLD", is_active=False)
    page = api.get(f"/api/booking/{SLUG}")
    assert page.status_code == 200
    data = page.json()
    assert data["practice_name"] == "Lee Counseling"
    assert data["intro"] == "Welcome!"
    assert data["time_zone"] == "America/New_York"
    [listed] = data["clinicians"]
    assert (listed["id"], listed["name"], listed["time_zone"]) == (
        clinician.id,
        "Jordan Lee",
        "America/New_York",
    )
    descriptions = {s["description"] for s in listed["services"]}
    assert descriptions == {"Intake call", "Initial Consultation - No Charge"}
    assert new_clients["id"] in {s["id"] for s in listed["services"]}
    assert all(
        set(s) == {"id", "description", "duration_minutes", "rate_cents"}
        for s in listed["services"]
    )

    api.patch(
        "/api/practice/settings",
        json={"booking_accepts_new_clients": False},
        headers=clinician.headers,
    )
    assert api.get(f"/api/booking/{SLUG}").status_code == 404


def test_booking_page_lists_clinicians_taking_new_clients_and_their_services(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician)
    intake = _service(api, clinician)
    riley = _colleague(db, clinician.practice_id)
    full = _colleague(db, clinician.practice_id, "full@example.com")
    add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    full_member = db.get(StaffMember, full.id)
    assert full_member is not None
    full_member.accepting_new_clients = False
    consultation = (
        db.query(Service).filter_by(practice_id=clinician.practice_id, code="00000").one()
    )
    db.add_all(
        [
            # Riley charges more for intakes; the owner doesn't offer the free consultation.
            ClinicianService(staff_id=riley.id, service_id=intake["id"], rate_cents=15000),
            ClinicianService(staff_id=clinician.id, service_id=consultation.id, offered=False),
        ]
    )
    db.commit()
    _set_availability(api, clinician, clinician_id=riley.id)

    page = api.get(f"/api/booking/{SLUG}").json()
    by_id = {c["id"]: c for c in page["clinicians"]}
    assert set(by_id) == {clinician.id, riley.id}
    assert by_id[riley.id]["name"] == "Riley Chen"
    rates = {s["id"]: s["rate_cents"] for s in by_id[riley.id]["services"]}
    assert rates == {intake["id"]: 15000, consultation.id: 0}
    assert {s["id"] for s in by_id[clinician.id]["services"]} == {intake["id"]}
    assert by_id[clinician.id]["services"][0]["rate_cents"] == 12000

    only_riley = api.get(f"/api/booking/{SLUG}", params={"clinician_id": riley.id}).json()
    assert [c["id"] for c in only_riley["clinicians"]] == [riley.id]

    def slots(clinician_id: int, service_id: int) -> int:
        params = {
            "clinician_id": clinician_id,
            "service_id": service_id,
            "start_date": str(_day()),
            "end_date": str(_day()),
        }
        return api.get(f"/api/booking/{SLUG}/slots", params=params).status_code

    assert slots(riley.id, intake["id"]) == 200
    assert slots(full.id, intake["id"]) == 404  # not taking new clients
    assert slots(clinician.id, consultation.id) == 404  # not offered by this clinician
    other = register_practice(api, email="other@example.com")
    assert slots(other.id, intake["id"]) == 404


def test_public_slots_validate_range_and_service(api: TestClient, clinician: StaffAccount) -> None:
    _open_booking(api, clinician)
    service = _service(api, clinician)
    hidden = _service(api, clinician, code="FOLLOW", bookable_by_new_clients=False)
    start = _day()

    def slots(service_id: int, end: date) -> Any:
        return api.get(
            f"/api/booking/{SLUG}/slots",
            params={
                "clinician_id": clinician.id,
                "service_id": service_id,
                "start_date": str(start),
                "end_date": str(end),
            },
        )

    one_day = slots(service["id"], start).json()
    assert [s["location_type"] for s in one_day] == ["video"] * 3 + ["in_person"] * 4
    assert set(one_day[0]) == {"starts_at", "ends_at", "location_type", "location_id"}
    assert slots(service["id"], start + timedelta(days=30)).status_code == 200
    assert slots(service["id"], start + timedelta(days=31)).status_code == 422
    assert slots(service["id"], start - timedelta(days=1)).status_code == 422
    assert slots(hidden["id"], start).status_code == 404


# --- public requests -------------------------------------------------------------------------


def test_public_request_creates_prospective_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    service, slot = _public_request(api, clinician)
    appointment = _only_request(db)
    requester = _requester(appointment)
    client = requester.client
    assert client.status == ClientStatus.PROSPECTIVE
    assert client.practice_id == clinician.practice_id
    assert (client.first_name, client.last_name) == ("Sam", "Taylor")
    assert client.date_of_birth == date(1990, 4, 2)
    assert client.email == "sam@example.com"
    assert [(m.staff_id, m.is_primary) for m in client.care_team] == [(clinician.id, True)]
    assert (appointment.practice_id, appointment.clinician_id) == (
        clinician.practice_id,
        clinician.id,
    )
    assert appointment.source == BookingSource.PUBLIC
    assert appointment.starts_at == datetime.fromisoformat(slot["starts_at"])
    assert appointment.duration_minutes == 60
    assert appointment.service_id == service["id"]
    assert appointment.service_code == "INTAKE"
    assert (requester.billable, requester.fee_cents) == (True, 12000)
    assert appointment.location_type == LocationType.VIDEO
    assert appointment.has_video
    assert appointment.request_message == "Looking for help with panic attacks."

    [alert] = outbound_to(db, clinician.email)
    assert alert.subject == "New appointment request"
    assert "http://app.test/portal/calendar?requests=1" in alert.body_text
    assert "Sam" not in alert.body_text
    assert _notified(db, clinician.id) == ["New appointment request from Sam T."]

    [receipt] = outbound_to(db, "sam@example.com")
    assert receipt.subject == "We received your request"
    assert receipt.practice_id == clinician.practice_id
    local = appointment.starts_at.astimezone(NY)
    assert f"{local:%B} {local.day}, {local.year}" in receipt.body_text
    assert "Jordan Lee" in receipt.body_text
    for private in ("Intake call", "panic", "INTAKE", "120"):
        assert private not in receipt.body_text

    # The requested time is now taken, for this and any other requester.
    taken = _slots(api, clinician.id, service["id"], _day())
    assert slot["starts_at"] not in {s["starts_at"] for s in taken}
    again = api.post(
        f"/api/booking/{SLUG}/requests",
        json=_request_body(clinician.id, service["id"], slot, email="other@example.com"),
    )
    assert again.status_code == 409


def test_public_request_reuses_existing_client_silently(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    existing = create_client_record(db, clinician, email="sam@example.com", first_name="Samuel")
    _public_request(api, clinician, email="Sam@Example.com", first_name="Sammy")
    db.expire_all()
    assert db.query(Client).count() == 1
    appointment = _only_request(db)
    assert _requester(appointment).client_id == existing.id
    db.refresh(existing)
    assert existing.first_name == "Samuel"
    assert existing.status == ClientStatus.ACTIVE
    [receipt] = outbound_to(db, "sam@example.com")
    assert "Thanks, Sammy" in receipt.body_text


def test_public_request_for_a_colleague_goes_to_them_and_the_schedulers(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    riley = _colleague(db, clinician.practice_id)
    bystander = _colleague(db, clinician.practice_id, "bystander@example.com")
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    existing = create_client_record(db, clinician, email="sam@example.com")
    _open_booking(api, clinician)
    _set_availability(api, clinician, clinician_id=riley.id)
    service = _service(api, clinician)
    slot = _slots(api, riley.id, service["id"], _day())[0]
    response = api.post(
        f"/api/booking/{SLUG}/requests", json=_request_body(riley.id, service["id"], slot)
    )
    assert response.status_code == 202, response.text

    appointment = _only_request(db)
    assert (appointment.clinician_id, _requester(appointment).client_id) == (riley.id, existing.id)
    db.refresh(existing)
    # An anonymous request never widens who can open an existing client's chart.
    assert {(m.staff_id, m.is_primary) for m in existing.care_team} == {(clinician.id, True)}
    assert _subjects(db, riley.email) == ["New appointment request"]
    assert outbound_to(db, clinician.email) == []
    assert "Riley Chen" in outbound_to(db, "sam@example.com")[0].body_text
    assert _notified(db, riley.id) == ["New appointment request from Alex R."]
    for member in (clinician, scheduler):
        assert _notified(db, member.id) == ["New appointment request from Alex R. for Riley Chen"]
    assert _notified(db, bystander.id) == []
    # The owner's own calendar is still open at that time.
    assert slot["starts_at"] in {
        s["starts_at"] for s in _slots(api, clinician.id, service["id"], _day())
    }


def test_honeypot_pretends_success_and_creates_nothing(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician)
    service = _service(api, clinician)
    slot = _slots(api, clinician.id, service["id"], _day())[0]
    response = api.post(
        f"/api/booking/{SLUG}/requests",
        json=_request_body(clinician.id, service["id"], slot, website="http://spam.example"),
    )
    assert response.status_code == 202
    assert response.json() == {"status": "requested"}
    assert db.query(Client).count() == 0
    assert db.query(Appointment).count() == 0
    assert db.query(OutboundMessage).count() == 0


@pytest.mark.usefixtures("steady_rate_limits")
def test_public_requests_are_rate_limited(api: TestClient, clinician: StaffAccount) -> None:
    _open_booking(api, clinician)
    service = _service(api, clinician)
    slot = _slots(api, clinician.id, service["id"], _day())[0]
    body = _request_body(clinician.id, service["id"], slot, website="bot")
    for _ in range(10):
        assert api.post(f"/api/booking/{SLUG}/requests", json=body).status_code == 202
    assert api.post(f"/api/booking/{SLUG}/requests", json=body).status_code == 429


def test_public_request_only_accepts_offered_times(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician, booking_min_notice_hours=24)
    service = _service(api, clinician)
    hidden = _service(api, clinician, code="FOLLOW", bookable_by_new_clients=False)
    riley = _colleague(db, clinician.practice_id)
    slot = _slots(api, clinician.id, service["id"], _day())[0]
    offered = datetime.fromisoformat(slot["starts_at"])
    tomorrow_9 = datetime.combine(_day(0), time(9), tzinfo=NY)

    def post(**overrides: Any) -> int:
        body = {**_request_body(clinician.id, service["id"], slot), **overrides}
        return api.post(f"/api/booking/{SLUG}/requests", json=body).status_code

    assert post(starts_at=(offered + timedelta(minutes=10)).isoformat()) == 409
    assert post(location_type="in_person") == 409
    assert post(starts_at=tomorrow_9.isoformat()) == 409  # inside the minimum notice
    assert post(clinician_id=riley.id) == 409  # no availability set
    assert post(starts_at="2026-01-01T09:00:00") == 422  # no UTC offset
    assert post(service_id=hidden["id"]) == 404
    assert post(clinician_id=999_999) == 404
    assert post(date_of_birth="2999-01-01") == 422
    assert post(message="x" * 1001) == 422
    assert db.query(Appointment).count() == 0


def test_request_alert_respects_email_setting_and_publishes_event(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician)
    preferences = api.patch(
        "/api/me/preferences", json={"notify_email_requests": False}, headers=clinician.headers
    )
    assert preferences.status_code == 200
    service = _service(api, clinician)
    slot = _slots(api, clinician.id, service["id"], _day())[0]
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        assert websocket.receive_json() == {"type": "ready"}
        response = api.post(
            f"/api/booking/{SLUG}/requests",
            json=_request_body(clinician.id, service["id"], slot),
        )
        assert response.status_code == 202
        event = websocket.receive_json()
    assert event == {
        "type": "appointment_request.created",
        "data": {"appointment_id": _only_request(db).id},
    }
    assert outbound_to(db, clinician.email) == []


# --- portal booking --------------------------------------------------------------------------


def test_portal_booking_requires_permission(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    assert api.get("/api/portal/booking", headers=headers).status_code == 403
    _open_booking(api, clinician)
    assert api.get("/api/portal/booking", headers=headers).status_code == 200
    client.portal_booking = False
    db.commit()
    assert api.get("/api/portal/booking", headers=headers).status_code == 403
    assert api.get("/api/portal/booking").status_code == 401
    assert api.get("/api/portal/booking", headers=clinician.headers).status_code == 401


def test_portal_booking_flow(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    _open_booking(api, clinician)
    follow_up = _service(api, clinician, code="FOLLOW", bookable_by_new_clients=False)
    _service(api, clinician, code="NOTONLINE", bookable_online=False)
    other = register_practice(api, email="other@example.com")
    foreign = _service(api, other, code="FOREIGN")
    client = create_client_record(db, clinician, time_zone="America/Los_Angeles")
    headers = portal_headers(client)

    options = api.get("/api/portal/booking", headers=headers).json()
    [listed] = options["clinicians"]
    assert (listed["id"], listed["name"]) == (clinician.id, "Jordan Lee")
    assert {s["description"] for s in listed["services"]} == {
        "Intake call",
        "Initial Consultation - No Charge",
    }
    assert "rate_cents" not in listed["services"][0]
    assert options["locations"][0]["name"] == "Video office"

    params = {
        "clinician_id": clinician.id,
        "service_id": follow_up["id"],
        "start_date": str(_day()),
        "end_date": str(_day()),
    }
    slots = api.get("/api/portal/booking/slots", params=params, headers=headers).json()
    assert len(slots) == 7
    foreign_params = {**params, "service_id": foreign["id"]}
    assert (
        api.get("/api/portal/booking/slots", params=foreign_params, headers=headers).status_code
        == 404
    )

    slot = slots[-1]
    created = api.post(
        "/api/portal/booking/requests",
        json={
            "clinician_id": clinician.id,
            "service_id": follow_up["id"],
            "starts_at": slot["starts_at"],
            "location_type": slot["location_type"],
            "message": "Can we meet in person?",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert view["status"] == "requested"
    assert view["location_type"] == "in_person"
    assert view["location_details"] == "12 Elm St, Albany"
    assert view["clinician_name"] == "Jordan Lee"
    assert view["can_cancel"] is True
    assert "memo" not in view and "fee_cents" not in view

    appointment = _only_request(db)
    assert appointment.source == BookingSource.PORTAL
    assert _requester(appointment).client_id == client.id
    assert appointment.request_message == "Can we meet in person?"
    assert _subjects(db, clinician.email) == ["New appointment request"]
    [receipt] = outbound_to(db, client.email or "")
    assert receipt.subject == "We received your request"
    assert "PDT" in receipt.body_text or "PST" in receipt.body_text

    duplicate = api.post(
        "/api/portal/booking/requests",
        json={
            "clinician_id": clinician.id,
            "service_id": follow_up["id"],
            "starts_at": slot["starts_at"],
            "location_type": slot["location_type"],
        },
        headers=headers,
    )
    assert duplicate.status_code == 409


def test_portal_clients_book_with_clinicians_on_their_care_team(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _open_booking(api, clinician)
    riley = _colleague(db, clinician.practice_id)
    stranger = _colleague(db, clinician.practice_id, "stranger@example.com")
    for member in (riley, stranger):
        _set_availability(api, clinician, clinician_id=member.id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, riley)
    headers = portal_headers(client)
    service = _service(api, clinician, code="FOLLOW", bookable_by_new_clients=False)

    options = api.get("/api/portal/booking", headers=headers).json()
    assert [c["id"] for c in options["clinicians"]] == [clinician.id, riley.id]

    def slots(clinician_id: int) -> Any:
        params = {
            "clinician_id": clinician_id,
            "service_id": service["id"],
            "start_date": str(_day()),
            "end_date": str(_day()),
        }
        return api.get("/api/portal/booking/slots", params=params, headers=headers)

    assert slots(stranger.id).status_code == 404
    slot = slots(riley.id).json()[0]
    body = {
        "service_id": service["id"],
        "starts_at": slot["starts_at"],
        "location_type": slot["location_type"],
    }
    refused = api.post(
        "/api/portal/booking/requests", json={**body, "clinician_id": stranger.id}, headers=headers
    )
    assert refused.status_code == 404
    created = api.post(
        "/api/portal/booking/requests", json={**body, "clinician_id": riley.id}, headers=headers
    )
    assert created.status_code == 201, created.text
    assert created.json()["clinician_name"] == "Riley Chen"
    assert _only_request(db).clinician_id == riley.id
    assert _subjects(db, riley.email) == ["New appointment request"]
    assert outbound_to(db, clinician.email) == []


# --- request handling ------------------------------------------------------------------------


def test_accepting_a_request_activates_and_welcomes_new_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _public_request(api, clinician)
    listed = api.get("/api/appointment-requests", headers=clinician.headers).json()
    assert len(listed) == 1
    request = listed[0]
    assert request["request_message"] == "Looking for help with panic attacks."
    assert request["source"] == "public"
    assert request["clinician"] == {"id": clinician.id, "name": "Jordan Lee"}
    assert request["client"] == {
        "id": request["client"]["id"],
        "first_name": "Sam",
        "last_name": "Taylor",
        "preferred_name": "",
        "status": "prospective",
        "email": "sam@example.com",
        "phone": "(555) 404-1234",
        "date_of_birth": "1990-04-02",
    }

    accepted = api.post(
        f"/api/appointment-requests/{request['id']}/accept", headers=clinician.headers
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "scheduled"
    client = db.get(Client, request["client"]["id"])
    assert client is not None
    db.refresh(client)
    assert client.status == ClientStatus.ACTIVE

    messages = outbound_to(db, "sam@example.com")
    assert [m.subject for m in messages] == [
        "We received your request",
        "Appointment confirmed",
        "Your client portal with Lee Counseling",
    ]
    assert "video appointment" in messages[1].body_text
    assert "Intake call" not in messages[1].body_text
    sign_in = db.scalar(
        select(AuthToken).where(
            AuthToken.token_hash == hash_opaque_token(link_token(messages[2].body_text))
        )
    )
    assert sign_in is not None
    assert (sign_in.purpose, sign_in.subject_id) == (AuthTokenPurpose.CLIENT_LOGIN, client.id)

    assert api.get("/api/appointment-requests", headers=clinician.headers).json() == []
    again = api.post(f"/api/appointment-requests/{request['id']}/accept", headers=clinician.headers)
    assert again.status_code == 409


def test_accepting_fails_when_the_time_is_now_taken(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _, slot = _public_request(api, clinician)
    other_client = create_client_record(db, clinician, email="kim@example.com")
    booked = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": other_client.id}],
            "starts_at": slot["starts_at"],
            "allow_conflicts": True,
        },
        headers=clinician.headers,
    )
    assert booked.status_code == 201
    request_id = _only_request(db).id
    conflict = api.post(f"/api/appointment-requests/{request_id}/accept", headers=clinician.headers)
    assert conflict.status_code == 409
    assert (
        conflict.json()["detail"]["conflicts"][0]["participants"][0]["client"]["id"]
        == other_client.id
    )
    assert _only_request(db).id == request_id


def test_declining_archives_new_client_and_hides_reason_by_default(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _public_request(api, clinician)
    appointment = _only_request(db)
    guardian = _guardian(db, _requester(appointment).client, "parent@example.com")
    signed_in = _guardian_headers(guardian)
    assert api.get("/api/portal/appointments", headers=signed_in).status_code == 200
    declined = api.post(
        f"/api/appointment-requests/{appointment.id}/decline",
        json={"reason": "My caseload is full."},
        headers=clinician.headers,
    )
    assert declined.status_code == 200, declined.text
    assert declined.json()["status"] == "declined"
    assert declined.json()["cancel_reason"] == "My caseload is full."
    assert declined.json()["canceled_by"] == "staff"
    db.expire_all()
    client = db.get(Client, _requester(appointment).client_id)
    assert client is not None and client.status == ClientStatus.ARCHIVED
    notice = outbound_to(db, "sam@example.com")[-1]
    assert notice.subject == "About your appointment request"
    assert "caseload" not in notice.body_text
    # The guardian's session ends too, even if the client is later reactivated.
    client.status = ClientStatus.ACTIVE
    db.commit()
    assert api.get("/api/portal/appointments", headers=signed_in).status_code == 401


def test_declining_with_reason_keeps_existing_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    existing = create_client_record(
        db, clinician, email="sam@example.com", status=ClientStatus.PROSPECTIVE
    )
    _appointment(
        db,
        clinician,
        existing,
        starts_at=datetime.now(UTC) - timedelta(days=30),
        status=AppointmentStatus.ATTENDED,
    )
    _public_request(api, clinician)
    appointment = _only_request(db)
    response = api.post(
        f"/api/appointment-requests/{appointment.id}/decline",
        json={"reason": "I'm away that week.", "include_reason": True},
        headers=clinician.headers,
    )
    assert response.status_code == 200
    db.refresh(existing)
    assert existing.status == ClientStatus.PROSPECTIVE
    assert "I'm away that week." in outbound_to(db, "sam@example.com")[-1].body_text


def test_requests_are_isolated_between_practices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _public_request(api, clinician)
    appointment = _only_request(db)
    other = register_practice(api, email="other@example.com")
    assert api.get("/api/appointment-requests", headers=other.headers).json() == []
    for action in ("accept", "decline"):
        response = api.post(
            f"/api/appointment-requests/{appointment.id}/{action}", json={}, headers=other.headers
        )
        assert response.status_code == 404
    assert _only_request(db).status == AppointmentStatus.REQUESTED


def test_requests_are_handled_on_the_clinicians_calendar(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    riley = _colleague(db, clinician.practice_id)
    bystander = _colleague(db, clinician.practice_id, "bystander@example.com")
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    _open_booking(api, clinician)
    _set_availability(api, clinician, clinician_id=riley.id)
    service = _service(api, clinician)
    slot = _slots(api, riley.id, service["id"], _day())[0]
    posted = api.post(
        f"/api/booking/{SLUG}/requests", json=_request_body(riley.id, service["id"], slot)
    )
    assert posted.status_code == 202
    request_id = _only_request(db).id

    def listed(account: StaffAccount, **params: Any) -> list[int]:
        response = api.get("/api/appointment-requests", params=params, headers=account.headers)
        assert response.status_code == 200, response.text
        return [r["id"] for r in response.json()]

    assert listed(riley) == [request_id]
    assert listed(bystander) == []
    assert listed(clinician) == [request_id]  # the owner schedules for the practice
    assert listed(scheduler, clinician_id=riley.id) == [request_id]
    assert listed(scheduler, clinician_id=clinician.id) == []
    forbidden = api.get(
        "/api/appointment-requests", params={"clinician_id": riley.id}, headers=bystander.headers
    )
    assert forbidden.status_code == 403

    url = f"/api/appointment-requests/{request_id}"
    assert api.post(f"{url}/accept", headers=bystander.headers).status_code == 404
    accepted = api.post(f"{url}/accept", headers=scheduler.headers)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["clinician"]["id"] == riley.id
    [confirmation] = [
        m for m in outbound_to(db, "sam@example.com") if m.subject == "Appointment confirmed"
    ]
    assert "Riley Chen accepted your request" in confirmation.body_text


# --- portal appointments ---------------------------------------------------------------------


def test_portal_appointment_lists_hide_internal_fields(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    api.patch(
        "/api/practice",
        json={"address_line1": "12 Elm St", "city": "Albany"},
        headers=clinician.headers,
    )
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=clinician.headers)
    riley = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    stranger = create_client_record(db, clinician, email="kim@example.com")
    now = datetime.now(UTC)
    upcoming = _appointment(db, clinician, client, starts_at=now + timedelta(days=2))
    requested = _appointment(
        db,
        clinician,
        client,
        starts_at=now + timedelta(days=1),
        status=AppointmentStatus.REQUESTED,
        location_type=LocationType.VIDEO,
        video_room_name="synari-room-1",
    )
    with_riley = _appointment(db, riley, client, starts_at=now + timedelta(days=4))
    _appointment(
        db,
        clinician,
        client,
        starts_at=now + timedelta(days=3),
        status=AppointmentStatus.CANCELED,
    )
    past = _appointment(
        db,
        clinician,
        client,
        starts_at=now - timedelta(days=7),
        status=AppointmentStatus.ATTENDED,
    )
    _appointment(db, clinician, stranger, starts_at=now + timedelta(days=2, hours=2))
    headers = portal_headers(client)

    listed = api.get("/api/portal/appointments", headers=headers).json()
    assert [a["id"] for a in listed] == [requested.id, upcoming.id, with_riley.id]
    assert set(listed[0]) == {
        "id",
        "starts_at",
        "ends_at",
        "status",
        "location_type",
        "location_details",
        "has_video",
        "clinician_name",
        "service_description",
        "is_group",
        "other_participants",
        "can_cancel",
        "cancel_is_late",
    }
    assert listed[0]["has_video"] is True
    assert (listed[0]["is_group"], listed[0]["other_participants"]) == (False, [])
    assert listed[1]["location_details"] == "12 Elm St, Albany"
    assert listed[1]["clinician_name"] == "Jordan Lee, LCSW"
    assert (listed[1]["can_cancel"], listed[1]["cancel_is_late"]) == (True, False)
    assert listed[2]["clinician_name"] == "Riley Chen"

    history = api.get("/api/portal/appointments", params={"when": "past"}, headers=headers)
    assert [a["id"] for a in history.json()] == [past.id]
    assert history.json()[0]["can_cancel"] is False
    assert (
        api.get("/api/portal/appointments", params={"when": "later"}, headers=headers).status_code
        == 422
    )


def test_portal_cancellation_policy(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    stranger = create_client_record(db, clinician, email="kim@example.com")
    headers = portal_headers(client)
    now = datetime.now(UTC)
    far = _appointment(db, clinician, client, starts_at=now + timedelta(hours=48))
    near = _appointment(db, clinician, client, starts_at=now + timedelta(hours=12))
    pending = _appointment(
        db,
        clinician,
        client,
        starts_at=now + timedelta(hours=2),
        status=AppointmentStatus.REQUESTED,
    )
    theirs = _appointment(db, clinician, stranger, starts_at=now + timedelta(hours=72))

    def cancel(appointment: Appointment, reason: str = "") -> Any:
        return api.post(
            f"/api/portal/appointments/{appointment.id}/cancel",
            json={"reason": reason},
            headers=headers,
        )

    listed = {a["id"]: a for a in api.get("/api/portal/appointments", headers=headers).json()}
    assert (listed[far.id]["can_cancel"], listed[near.id]["can_cancel"]) == (True, False)

    too_late = cancel(near)
    assert too_late.status_code == 409
    assert too_late.json()["detail"] == (
        "Please contact your practice to cancel within 24 hours of your appointment"
    )
    assert cancel(theirs).status_code == 404
    assert cancel(far, "x" * 501).status_code == 422

    done = cancel(far, "Work trip")
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "canceled"
    db.refresh(far)
    assert (far.canceled_by, far.cancel_reason) == ("client", "Work trip")
    assert _subjects(db, clinician.email) == ["Appointment canceled"]
    assert "Work trip" not in outbound_to(db, clinician.email)[0].body_text
    assert cancel(far).status_code == 409

    withdrawn = cancel(pending)
    assert withdrawn.status_code == 200
    assert withdrawn.json()["status"] == "canceled"

    practice = db.get(PracticeSettings, clinician.practice_id)
    assert practice is not None
    practice.cancellation_window_hours = 0
    db.commit()
    later = _appointment(db, clinician, client, starts_at=now + timedelta(days=10))
    blocked = cancel(later)
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "Please contact your practice to cancel"


def test_portal_cancellation_alerts_the_appointments_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    riley = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, riley)
    appointment = _appointment(db, riley, client, starts_at=datetime.now(UTC) + timedelta(days=3))
    response = api.post(
        f"/api/portal/appointments/{appointment.id}/cancel",
        json={},
        headers=portal_headers(client),
    )
    assert response.status_code == 200, response.text
    assert _subjects(db, riley.email) == ["Appointment canceled"]
    assert _notified(db, riley.id) == ["Alex R. canceled an appointment"]
    assert outbound_to(db, clinician.email) == []
    assert _notified(db, clinician.id) == []


def _members(db: Session, account: StaffAccount, *first_names: str) -> list[Client]:
    return [
        create_client_record(
            db, account, first_name=name, last_name="Rivera", email=f"{name.lower()}@example.com"
        )
        for name in first_names
    ]


def _portal_list(api: TestClient, client: Client) -> dict[int, dict[str, Any]]:
    response = api.get("/api/portal/appointments", headers=portal_headers(client))
    assert response.status_code == 200, response.text
    return {a["id"]: a for a in response.json()}


def test_portal_shows_partners_but_nothing_about_group_members(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam, kim = _members(db, clinician, "Alex", "Sam", "Kim")
    sam.preferred_name = "Sammy"
    db.commit()
    now = datetime.now(UTC)
    couples = _appointment(
        db, clinician, alex, others=[sam], service_code="90847", starts_at=now + timedelta(days=2)
    )
    group = _appointment(
        db,
        clinician,
        alex,
        others=[sam, kim],
        group=True,
        service_code="90853",
        service_description="Group psychotherapy",
        title="Tuesday group",
        starts_at=now + timedelta(days=3),
    )

    for_alex = _portal_list(api, alex)
    assert (for_alex[couples.id]["is_group"], for_alex[couples.id]["other_participants"]) == (
        False,
        ["Sammy"],
    )
    assert (for_alex[group.id]["is_group"], for_alex[group.id]["other_participants"]) == (True, [])
    # The non-billed partner sees the session too.
    assert _portal_list(api, sam)[couples.id]["other_participants"] == ["Alex"]
    for_kim = _portal_list(api, kim)
    assert set(for_kim) == {group.id}
    for private in ("Alex", "Sam", "Rivera", "Tuesday"):
        assert private not in str(for_kim)
    # A guardian signed in for Kim sees exactly what Kim sees.
    guardian = _guardian(db, kim, "kims-mom@example.com")
    response = api.get("/api/portal/appointments", headers=_guardian_headers(guardian))
    assert response.status_code == 200, response.text
    assert {a["id"]: a for a in response.json()} == for_kim


def test_one_member_cancels_their_place_in_a_group(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam, kim = _members(db, clinician, "Alex", "Sam", "Kim")
    now = datetime.now(UTC)
    session = _appointment(
        db, clinician, alex, others=[sam, kim], group=True, starts_at=now + timedelta(hours=48)
    )
    soon = _appointment(
        db, clinician, alex, others=[sam], group=True, starts_at=now + timedelta(hours=12)
    )
    alex_headers = portal_headers(alex)
    listed = _portal_list(api, alex)
    assert (listed[session.id]["can_cancel"], listed[session.id]["cancel_is_late"]) == (
        True,
        False,
    )
    # Inside the 24-hour window a shared session can still be canceled, as a late cancellation.
    assert (listed[soon.id]["can_cancel"], listed[soon.id]["cancel_is_late"]) == (True, True)

    def cancel(appointment: Appointment) -> Any:
        return api.post(
            f"/api/portal/appointments/{appointment.id}/cancel",
            json={"reason": "Sick"},
            headers=alex_headers,
        )

    done = cancel(session)
    assert done.status_code == 200, done.text
    assert (done.json()["status"], done.json()["can_cancel"]) == ("canceled", False)
    db.expire_all()
    db.refresh(session)
    assert session.status == AppointmentStatus.SCHEDULED
    assert session.cancel_reason == ""
    assert {p.client_id: p.attendance for p in session.participants} == {
        alex.id: "canceled",
        sam.id: None,
        kim.id: None,
    }
    assert _notified(db, clinician.id) == ["Alex R. canceled their attendance"]
    assert _subjects(db, clinician.email) == ["Appointment canceled"]
    assert session.id not in _portal_list(api, alex)
    assert session.id in _portal_list(api, sam)
    assert cancel(session).status_code == 409

    late = cancel(soon)
    assert late.status_code == 200, late.text
    assert late.json()["status"] == "late_canceled"
    staff_view = api.get(f"/api/appointments/{soon.id}", headers=clinician.headers).json()
    assert {p["client"]["id"]: p["effective_status"] for p in staff_view["participants"]} == {
        alex.id: "late_canceled",
        sam.id: "scheduled",
    }


# --- client notices from staff actions -------------------------------------------------------


def test_scheduling_notices_follow_the_notify_flag(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, time_zone="America/Los_Angeles")
    start = datetime.combine(_day(10), time(10), tzinfo=NY)

    quiet = api.post(
        "/api/appointments",
        json={"participants": [{"client_id": client.id}], "starts_at": start.isoformat()},
        headers=clinician.headers,
    )
    assert quiet.status_code == 201
    assert outbound_to(db, "alex@example.com") == []

    single = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": (start + timedelta(days=1)).isoformat(),
            "location_type": "video",
            "notify_client": True,
        },
        headers=clinician.headers,
    )
    assert single.status_code == 201
    [scheduled] = outbound_to(db, "alex@example.com")
    assert scheduled.subject == "Appointment scheduled"
    assert "7:00 AM P" in scheduled.body_text  # shown in the client's Pacific time zone
    assert "video appointment" in scheduled.body_text
    assert "Psychotherapy" not in scheduled.body_text

    series = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": (start + timedelta(days=2)).isoformat(),
            "recurrence": {"frequency": "weekly", "count": 4},
            "notify_client": True,
        },
        headers=clinician.headers,
    )
    assert series.status_code == 201
    messages = outbound_to(db, "alex@example.com")
    assert len(messages) == 2
    assert "and 3 more" in messages[-1].body_text


def test_notices_name_the_appointments_clinician_and_zone(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    riley = _colleague(db, clinician.practice_id)
    api.patch("/api/me", json={"time_zone": "America/Los_Angeles"}, headers=riley.headers)
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, clinician)
    start = datetime.combine(_day(10), time(10), tzinfo=NY)
    [booked] = api.post(
        "/api/appointments",
        json={
            "clinician_id": riley.id,
            "participants": [{"client_id": client.id}],
            "starts_at": start.isoformat(),
            "notify_client": True,
        },
        headers=scheduler.headers,
    ).json()
    [scheduled] = outbound_to(db, "alex@example.com")
    assert "Your appointment with Riley Chen is scheduled for" in scheduled.body_text
    assert "7:00 AM P" in scheduled.body_text  # the client has no zone: the clinician's is used

    moved = api.patch(
        f"/api/appointments/{booked['id']}",
        json={"clinician_id": clinician.id, "notify_client": True},
        headers=scheduler.headers,
    )
    assert moved.status_code == 200, moved.text
    changed = outbound_to(db, "alex@example.com")[-1]
    assert changed.subject == "Appointment changed"
    assert "with Jordan Lee changed" in changed.body_text
    assert "10:00 AM E" in changed.body_text


def test_change_and_cancel_notices(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    start = datetime.combine(_day(10), time(10), tzinfo=NY)
    [created] = api.post(
        "/api/appointments",
        json={"participants": [{"client_id": client.id}], "starts_at": start.isoformat()},
        headers=clinician.headers,
    ).json()
    url = f"/api/appointments/{created['id']}"

    memo_only = api.patch(
        url, json={"memo": "Bring worksheet", "notify_client": True}, headers=clinician.headers
    )
    assert memo_only.status_code == 200
    same_time = api.patch(
        url,
        json={"starts_at": start.isoformat(), "notify_client": True},
        headers=clinician.headers,
    )
    assert same_time.status_code == 200
    silent_move = api.patch(
        url, json={"starts_at": (start + HOUR).isoformat()}, headers=clinician.headers
    )
    assert silent_move.status_code == 200
    assert outbound_to(db, "alex@example.com") == []

    moved = api.patch(
        url,
        json={"starts_at": (start + 2 * HOUR).isoformat(), "notify_client": True},
        headers=clinician.headers,
    )
    assert moved.status_code == 200
    [changed] = outbound_to(db, "alex@example.com")
    assert changed.subject == "Appointment changed"
    assert "12:00 PM E" in changed.body_text
    assert "Bring worksheet" not in changed.body_text

    canceled = api.post(f"{url}/cancel", json={"reason": "Sick"}, headers=clinician.headers)
    assert canceled.status_code == 200
    assert _subjects(db, "alex@example.com") == ["Appointment changed", "Appointment canceled"]
    assert "Sick" not in outbound_to(db, "alex@example.com")[-1].body_text

    [second] = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": (start + timedelta(days=1)).isoformat(),
        },
        headers=clinician.headers,
    ).json()
    api.post(
        f"/api/appointments/{second['id']}/cancel",
        json={"notify_client": False},
        headers=clinician.headers,
    )
    assert len(outbound_to(db, "alex@example.com")) == 2


def test_notices_skip_clients_without_email(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, email=None)
    start = datetime.combine(_day(10), time(10), tzinfo=NY)
    response = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": start.isoformat(),
            "notify_client": True,
        },
        headers=clinician.headers,
    )
    assert response.status_code == 201
    assert db.query(OutboundMessage).count() == 0


def test_notices_go_to_each_client_and_their_guardians(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(
        db, clinician, first_name="Jamie", preferred_name="Jay", email=None, is_minor=True
    )
    _guardian(db, minor, "maria@example.com")
    db.add(
        ClientContact(
            client_id=minor.id,
            first_name="Neighbor",
            email="neighbor@example.com",
            is_emergency_contact=True,
        )
    )
    db.commit()
    parent, sibling = _members(db, clinician, "Pat", "Lou")
    start = datetime.combine(_day(10), time(10), tzinfo=NY)
    created = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": minor.id}, {"client_id": parent.id}],
            "starts_at": start.isoformat(),
            "notify_client": True,
        },
        headers=clinician.headers,
    )
    assert created.status_code == 201, created.text
    url = f"/api/appointments/{created.json()[0]['id']}"
    [to_guardian] = outbound_to(db, "maria@example.com")
    assert to_guardian.subject == "Appointment scheduled"
    assert "Hi Maria," in to_guardian.body_text
    assert "Jay's appointment with Jordan Lee is scheduled for" in to_guardian.body_text
    [to_parent] = outbound_to(db, "pat@example.com")
    assert "Your appointment with Jordan Lee is scheduled for" in to_parent.body_text
    # Nobody is told who else is in the session.
    assert "Pat" not in to_guardian.body_text
    assert "Jay" not in to_parent.body_text and "Jamie" not in to_parent.body_text
    assert outbound_to(db, "neighbor@example.com") == []

    # Swapping one client for another: the newcomer hears it was scheduled, the one taken out
    # that it was canceled, and the others nothing.
    swapped = api.patch(
        url,
        json={
            "participants": [{"client_id": minor.id}, {"client_id": sibling.id}],
            "notify_client": True,
        },
        headers=clinician.headers,
    )
    assert swapped.status_code == 200, swapped.text
    assert _subjects(db, "lou@example.com") == ["Appointment scheduled"]
    assert _subjects(db, "pat@example.com") == ["Appointment scheduled", "Appointment canceled"]
    assert _subjects(db, "maria@example.com") == ["Appointment scheduled"]

    moved = api.patch(
        url,
        json={"starts_at": (start + HOUR).isoformat(), "notify_client": True},
        headers=clinician.headers,
    )
    assert moved.status_code == 200
    assert _subjects(db, "maria@example.com")[-1] == "Appointment changed"
    assert (
        "Jay's appointment with Jordan Lee changed"
        in outbound_to(db, "maria@example.com")[-1].body_text
    )
    assert _subjects(db, "lou@example.com")[-1] == "Appointment changed"
    assert len(outbound_to(db, "pat@example.com")) == 2

    assert api.post(f"{url}/cancel", json={}, headers=clinician.headers).status_code == 200
    for address in ("maria@example.com", "lou@example.com"):
        assert _subjects(db, address)[-1] == "Appointment canceled"
    assert len(outbound_to(db, "pat@example.com")) == 2


# --- Twilio inbound SMS ----------------------------------------------------------------------

TWILIO_TOKEN = "twilio-test-token"
WEBHOOK = "/api/webhooks/twilio/sms"


@pytest.fixture
def twilio(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "twilio_account_sid", "AC0000")
    monkeypatch.setattr(settings, "twilio_auth_token", TWILIO_TOKEN)
    monkeypatch.setattr(settings, "twilio_from_number", "+15550001111")


def _twilio_post(
    api: TestClient,
    params: dict[str, str],
    *,
    url: str = f"http://testserver{WEBHOOK}",
    token: str = TWILIO_TOKEN,
    headers: dict[str, str] | None = None,
) -> Any:
    signature = twilio_signature(url, sorted(params.items()), token)
    return api.post(
        WEBHOOK, data=params, headers={"X-Twilio-Signature": signature, **(headers or {})}
    )


def test_twilio_signature_matches_published_example() -> None:
    params = [
        ("CallSid", "CA1234567890ABCDE"),
        ("Caller", "+14158675310"),
        ("Digits", "1234"),
        ("From", "+14158675310"),
        ("To", "+18005551212"),
    ]
    url = "https://mycompany.com/myapp.php?foo=1&bar=2"
    assert twilio_signature(url, params, "12345") == "GvWf1cFY/Q7PnoempGyD5oXAezc="


def test_twilio_webhook_rejects_unsigned_requests(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = {"From": "+15552013344", "Body": "STOP"}
    assert _twilio_post(api, params).status_code == 403  # SMS isn't configured
    monkeypatch.setattr(settings, "twilio_account_sid", "AC0000")
    monkeypatch.setattr(settings, "twilio_auth_token", TWILIO_TOKEN)
    monkeypatch.setattr(settings, "twilio_from_number", "+15550001111")
    assert _twilio_post(api, params, token="wrong").status_code == 403
    assert api.post(WEBHOOK, data=params).status_code == 403
    tampered = _twilio_post(api, {**params, "Body": "START"}, url="http://evil.test/x")
    assert tampered.status_code == 403
    assert _twilio_post(api, params).status_code == 200


@pytest.mark.usefixtures("twilio")
def test_stop_and_start_update_sms_consent(api: TestClient, db: Session) -> None:
    first = register_practice(api, email="one@example.com")
    second = register_practice(api, email="two@example.com")
    alex = create_client_record(db, first, phone="(555) 201-3344", sms_reminders=True)
    same_phone = create_client_record(
        db, second, email="alex2@example.com", phone="+1 555 201 3344"
    )
    unrelated = create_client_record(db, first, email="kim@example.com", phone="555-201-9999")

    response = _twilio_post(api, {"From": "+15552013344", "Body": " stop ", "To": "+15550001111"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/xml")
    assert response.text.endswith("<Response/>")
    for client in (alex, same_phone, unrelated):
        db.refresh(client)
    assert (alex.sms_opted_out, same_phone.sms_opted_out) == (True, True)
    assert unrelated.sms_opted_out is False
    assert alex.sms_reminders is True

    assert _twilio_post(api, {"From": "+15552013344", "Body": "Thanks!"}).status_code == 200
    db.refresh(alex)
    assert alex.sms_opted_out is True

    forwarded = _twilio_post(
        api,
        {"From": "+15552013344", "Body": "START"},
        url=f"https://api.example.org{WEBHOOK}",
        headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "api.example.org"},
    )
    assert forwarded.status_code == 200
    db.refresh(alex)
    db.refresh(same_phone)
    assert (alex.sms_opted_out, same_phone.sms_opted_out) == (False, False)
