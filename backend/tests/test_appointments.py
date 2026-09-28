"""The practice calendar: booking, series, conflicts, fees, locations, multi-client sessions and
who may see or change which appointments."""

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClinicianService,
    Invoice,
    InvoiceItem,
    Location,
    Service,
)
from synari.models.enums import (
    ClinicianAccess,
    InvoiceStatus,
    RecurrenceFrequency,
    Role,
    StaffRole,
)
from synari.services.appointment_notices import calendar_recipients
from synari.services.scheduling import Recurrence, expand_occurrences
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    register_practice,
)

NY = ZoneInfo("America/New_York")


def _at(year: int, month: int, day: int, hour: int, minute: int = 0) -> str:
    return datetime(year, month, day, hour, minute, tzinfo=NY).isoformat()


def _with(*clients: Client, **flags: bool) -> list[dict[str, Any]]:
    """Participants for a request body; `billable_<n>=True` marks the nth client billed."""
    entries: list[dict[str, Any]] = [{"client_id": client.id} for client in clients]
    for index, entry in enumerate(entries):
        if f"billable_{index}" in flags:
            entry["billable"] = flags[f"billable_{index}"]
    return entries


def _book(api: TestClient, account: StaffAccount, **fields: object) -> list[dict[str, Any]]:
    response = api.post("/api/appointments", json=fields, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _window(**params: object) -> dict[str, object]:
    return {"start": _at(2026, 10, 1, 0), "end": _at(2026, 10, 31, 0), **params}


def _colleague(db: Session, practice_id: int, email: str = "sam@example.com") -> StaffAccount:
    return add_staff(db, practice_id, email, StaffRole.CLINICIAN, first_name="Sam")


def _service(db: Session, practice_id: int, code: str, rate_cents: int) -> Service:
    service = db.query(Service).filter_by(practice_id=practice_id, code=code).one()
    service.rate_cents = rate_cents
    db.commit()
    return service


def _clients(db: Session, account: StaffAccount, *first_names: str) -> list[Client]:
    return [
        create_client_record(
            db, account, first_name=name, last_name="Rivera", email=f"{name.lower()}@example.com"
        )
        for name in first_names
    ]


def _invoice(
    db: Session,
    account: StaffAccount,
    participant_id: int,
    *,
    status: InvoiceStatus = InvoiceStatus.OPEN,
    number: str = "INV-1",
) -> Invoice:
    """Put a participant's session on an invoice."""
    participant = db.get(AppointmentParticipant, participant_id)
    assert participant is not None
    invoice = Invoice(
        practice_id=account.practice_id,
        client_id=participant.client_id,
        number=number,
        issued_on=date(2026, 10, 5),
        due_on=date(2026, 10, 5),
        total_cents=participant.fee_cents,
        status=status,
    )
    db.add(invoice)
    db.flush()
    db.add(
        InvoiceItem(
            invoice_id=invoice.id,
            participant_id=participant_id,
            service_date=date(2026, 10, 5),
            description="Session",
            amount_cents=participant.fee_cents,
        )
    )
    db.commit()
    return invoice


def _fees(appointment: dict[str, Any]) -> dict[int, tuple[bool, int]]:
    return {p["client"]["id"]: (p["billable"], p["fee_cents"]) for p in appointment["participants"]}


def test_appointment_defaults_come_from_service_and_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    services = api.get("/api/practice/services", headers=clinician.headers).json()
    default = next(s for s in services if s["is_default"])
    api.patch(
        f"/api/practice/services/{default['id']}",
        json={"rate_cents": 14000},
        headers=clinician.headers,
    )
    [appointment] = _book(
        api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 10)
    )
    assert appointment["service_code"] == default["code"]
    assert appointment["duration_minutes"] == default["duration_minutes"]
    [participant] = appointment["participants"]
    assert participant["client"] == {"id": client.id, "name": "Alex Rivera"}
    assert (participant["billable"], participant["fee_cents"]) == (True, 14000)
    assert (participant["attendance"], participant["effective_status"]) == (None, "scheduled")
    assert appointment["title_label"] == "Alex Rivera"
    assert appointment["is_group"] is False
    assert appointment["clinician"] == {"id": clinician.id, "name": "Jordan Lee"}
    assert appointment["location"] is None
    assert appointment["restricted"] is False
    assert appointment["has_video"] is False

    client.rate_override_cents = 9000
    db.commit()
    [discounted] = _book(api, clinician, participants=_with(client), starts_at=_at(2026, 10, 6, 10))
    assert discounted["participants"][0]["fee_cents"] == 9000


def test_participants_are_validated(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)

    def post(**fields: object) -> int:
        body = {"starts_at": _at(2026, 10, 5, 10), **fields}
        return api.post("/api/appointments", json=body, headers=clinician.headers).status_code

    assert post() == 422  # an appointment needs a client
    assert post(participants=[{"client_id": client.id}, {"client_id": client.id}]) == 422
    others = [create_client_record(db, clinician, email=f"c{i}@example.com") for i in range(15)]
    assert post(participants=_with(client, *others)) == 422  # at most 15
    assert post(kind="event", title="Lunch", participants=_with(client)) == 422
    assert post(participants=_with(client, billable_0=False)) == 422  # individual is billed
    both_unbilled = _with(client, others[0], billable_0=False, billable_1=False)
    assert post(participants=both_unbilled) == 422
    assert post(participants=[{"client_id": 999_999}]) == 404


def test_couples_session_bills_only_the_identified_patient(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    family = _service(db, clinician.practice_id, "90847", 16000)
    colleague = _colleague(db, clinician.practice_id)
    alex, sam = _clients(db, clinician, "Alex", "Sam")
    [couples] = _book(
        api,
        clinician,
        clinician_id=colleague.id,
        participants=_with(alex, sam),
        service_id=family.id,
        starts_at=_at(2026, 10, 5, 10),
    )
    assert _fees(couples) == {alex.id: (True, 16000), sam.id: (False, 0)}
    assert couples["is_group"] is False
    assert couples["title_label"] == "Alex Rivera & Sam Rivera"
    # The clinician joined both clients' care teams.
    for client in (alex, sam):
        db.refresh(client)
        assert colleague.id in {member.staff_id for member in client.care_team}

    # The request can say who the identified patient is.
    [reversed_billing] = _book(
        api,
        clinician,
        participants=_with(alex, sam, billable_1=True),
        service_id=family.id,
        starts_at=_at(2026, 10, 6, 10),
        title="Rivera family",
    )
    assert _fees(reversed_billing) == {alex.id: (False, 0), sam.id: (True, 16000)}
    assert reversed_billing["title_label"] == "Rivera family"


def test_group_session_of_three_with_per_member_attendance(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    group = _service(db, clinician.practice_id, "90853", 6000)
    members = _clients(db, clinician, "Alex", "Sam", "Kim")
    alex, sam, kim = members
    kim.rate_override_cents = 3000
    db.commit()
    [session] = _book(
        api,
        clinician,
        participants=_with(*members),
        service_id=group.id,
        starts_at=_at(2026, 10, 5, 18),
    )
    assert session["is_group"] is True
    assert session["title_label"] == "Group (3)"
    assert session["duration_minutes"] == 90
    assert _fees(session) == {alex.id: (True, 6000), sam.id: (True, 6000), kim.id: (True, 3000)}
    [named] = _book(
        api,
        clinician,
        participants=_with(alex, sam),
        group=True,
        title="Tuesday DBT skills",
        starts_at=_at(2026, 10, 6, 18),
    )
    assert (named["is_group"], named["title_label"]) == (True, "Tuesday DBT skills")
    assert all(billable for billable, _ in _fees(named).values())

    url = f"/api/appointments/{session['id']}"
    attended = api.patch(url, json={"status": "attended"}, headers=clinician.headers)
    assert attended.status_code == 200
    by_client = {p["client"]["id"]: p for p in session["participants"]}

    def set_attendance(client: Client, attendance: str | None) -> Any:
        return api.put(
            f"{url}/participants/{by_client[client.id]['id']}",
            json={"attendance": attendance},
            headers=clinician.headers,
        )

    no_show = set_attendance(sam, "no_show")
    assert no_show.status_code == 200, no_show.text
    canceled = set_attendance(kim, "late_canceled").json()
    statuses = {p["client"]["id"]: p["effective_status"] for p in canceled["participants"]}
    assert statuses == {alex.id: "attended", sam.id: "no_show", kim.id: "late_canceled"}
    assert canceled["status"] == "attended"
    back = set_attendance(kim, None).json()
    assert {p["client"]["id"]: p["attendance"] for p in back["participants"]}[kim.id] is None
    assert set_attendance(kim, "scheduled").status_code == 422
    other = named["participants"][0]["id"]
    wrong = api.put(f"{url}/participants/{other}", json={}, headers=clinician.headers)
    assert wrong.status_code == 404


def test_fees_are_re_resolved_until_invoiced(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    group = _service(db, clinician.practice_id, "90853", 6000)
    colleague = _colleague(db, clinician.practice_id)
    db.add(ClinicianService(staff_id=colleague.id, service_id=group.id, rate_cents=7000))
    db.commit()
    alex, sam = _clients(db, clinician, "Alex", "Sam")
    [session] = _book(
        api,
        clinician,
        participants=_with(alex, sam),
        service_id=group.id,
        starts_at=_at(2026, 10, 5, 18),
    )
    invoiced = next(p for p in session["participants"] if p["client"]["id"] == alex.id)
    invoice = _invoice(db, clinician, invoiced["id"])
    url = f"/api/appointments/{session['id']}"

    moved = api.patch(url, json={"clinician_id": colleague.id}, headers=clinician.headers)
    assert moved.status_code == 200, moved.text
    assert _fees(moved.json()[0]) == {alex.id: (True, 6000), sam.id: (True, 7000)}
    flat_fee = api.patch(url, json={"fee_cents": 2500}, headers=clinician.headers).json()[0]
    assert _fees(flat_fee) == {alex.id: (True, 6000), sam.id: (True, 2500)}

    # Billing can't change once invoiced; it can after the invoice is voided.
    unbill = {"billable": False}
    participant_url = f"{url}/participants/{invoiced['id']}"
    assert api.put(participant_url, json=unbill, headers=clinician.headers).status_code == 409
    invoice.status = InvoiceStatus.VOID
    db.commit()
    unbilled = api.put(participant_url, json=unbill, headers=clinician.headers)
    assert unbilled.status_code == 200, unbilled.text
    assert _fees(unbilled.json())[alex.id] == (False, 0)
    rebilled = api.put(participant_url, json={"billable": True}, headers=clinician.headers)
    assert _fees(rebilled.json())[alex.id] == (True, 7000)

    [individual] = _book(api, clinician, participants=_with(sam), starts_at=_at(2026, 10, 7, 9))
    solo_url = f"/api/appointments/{individual['id']}/participants"
    solo = api.put(
        f"{solo_url}/{individual['participants'][0]['id']}",
        json=unbill,
        headers=clinician.headers,
    )
    assert solo.status_code == 422


def test_participants_change_keeping_existing_rows(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    group = _service(db, clinician.practice_id, "90853", 6000)
    alex, sam, kim, lee = _clients(db, clinician, "Alex", "Sam", "Kim", "Lee")
    [session] = _book(
        api,
        clinician,
        participants=_with(alex, sam, kim),
        service_id=group.id,
        starts_at=_at(2026, 10, 5, 18),
    )
    ids = {p["client"]["id"]: p["id"] for p in session["participants"]}
    url = f"/api/appointments/{session['id']}"
    api.put(
        f"{url}/participants/{ids[alex.id]}",
        json={"attendance": "canceled"},
        headers=clinician.headers,
    )
    _invoice(db, clinician, ids[sam.id])

    without_sam = api.patch(
        url, json={"participants": _with(alex, kim, lee)}, headers=clinician.headers
    )
    assert without_sam.status_code == 409
    assert "invoiced" in without_sam.json()["detail"]

    changed = api.patch(
        url, json={"participants": _with(alex, sam, lee)}, headers=clinician.headers
    )
    assert changed.status_code == 200, changed.text
    rows = {p["client"]["id"]: p for p in changed.json()[0]["participants"]}
    assert set(rows) == {alex.id, sam.id, lee.id}
    assert (rows[alex.id]["id"], rows[alex.id]["attendance"]) == (ids[alex.id], "canceled")
    assert rows[sam.id]["id"] == ids[sam.id]
    assert (rows[lee.id]["billable"], rows[lee.id]["fee_cents"]) == (True, 6000)
    db.expire_all()
    assert db.get(AppointmentParticipant, ids[kim.id]) is None
    db.refresh(lee)
    assert clinician.id in {member.staff_id for member in lee.care_team}


def test_adding_a_partner_to_an_individual_session(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex, sam = _clients(db, clinician, "Alex", "Sam")
    [session] = _book(api, clinician, participants=_with(alex), starts_at=_at(2026, 10, 5, 10))
    url = f"/api/appointments/{session['id']}"
    couples = api.patch(url, json={"participants": _with(sam, alex)}, headers=clinician.headers)
    assert couples.status_code == 200, couples.text
    fee = session["participants"][0]["fee_cents"]
    assert _fees(couples.json()[0]) == {alex.id: (True, fee), sam.id: (False, 0)}
    # Taking the identified patient out bills the remaining client.
    alone = api.patch(url, json={"participants": _with(sam)}, headers=clinician.headers).json()[0]
    assert _fees(alone) == {sam.id: (True, fee)}
    event = _book(api, clinician, kind="event", title="Admin", starts_at=_at(2026, 10, 5, 8))[0]
    to_event = api.patch(
        f"/api/appointments/{event['id']}",
        json={"participants": _with(sam)},
        headers=clinician.headers,
    )
    assert to_event.status_code == 422


def test_clinician_rate_overrides_the_service_rate(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    service = _service(db, clinician.practice_id, "90837", 15000)
    db.add(ClinicianService(staff_id=colleague.id, service_id=service.id, rate_cents=18000))
    db.commit()
    [mine] = _book(
        api,
        clinician,
        participants=_with(client),
        service_id=service.id,
        starts_at=_at(2026, 10, 5, 9),
    )
    [theirs] = _book(
        api,
        clinician,
        clinician_id=colleague.id,
        participants=_with(client),
        service_id=service.id,
        starts_at=_at(2026, 10, 5, 11),
    )
    assert _fees(mine)[client.id] == (True, 15000)
    assert _fees(theirs)[client.id] == (True, 18000)

    # Moving an appointment to another clinician re-prices it at their rate.
    moved = api.patch(
        f"/api/appointments/{mine['id']}",
        json={"clinician_id": colleague.id},
        headers=clinician.headers,
    )
    assert moved.status_code == 200, moved.text
    assert _fees(moved.json()[0])[client.id] == (True, 18000)
    assert moved.json()[0]["clinician"]["id"] == colleague.id


def test_video_appointments_get_a_private_room(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [appointment] = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        location_type="video",
    )
    assert appointment["has_video"] is True
    assert "video_room_name" not in appointment


def test_locations_must_be_active_offices_of_the_practice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    office = api.post(
        "/api/practice/locations",
        json={"name": "Downtown", "address_line1": "12 Elm St"},
        headers=clinician.headers,
    ).json()
    closed = Location(practice_id=clinician.practice_id, name="Old office", is_active=False)
    other = register_practice(api, email="other@example.com")
    foreign = Location(practice_id=other.practice_id, name="Elsewhere")
    db.add_all([closed, foreign])
    db.commit()

    [booked] = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        location_id=office["id"],
    )
    assert booked["location"] == {"id": office["id"], "name": "Downtown", "place_of_service": "11"}

    def book_at(location_id: int) -> int:
        body = {
            "participants": _with(client),
            "starts_at": _at(2026, 10, 6, 10),
            "location_id": location_id,
        }
        return api.post("/api/appointments", json=body, headers=clinician.headers).status_code

    assert book_at(closed.id) == 422
    assert book_at(foreign.id) == 404
    cleared = api.patch(
        f"/api/appointments/{booked['id']}", json={"location_id": None}, headers=clinician.headers
    )
    assert cleared.json()[0]["location"] is None


def test_conflicts_are_rejected_unless_allowed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        duration_minutes=50,
    )
    overlap = api.post(
        "/api/appointments",
        json={"participants": _with(client), "starts_at": _at(2026, 10, 5, 10, 30)},
        headers=clinician.headers,
    )
    assert overlap.status_code == 409
    [conflict] = overlap.json()["detail"]["conflicts"]
    assert conflict["participants"][0]["client"]["id"] == client.id
    # The same appointment isn't repeated as the client's own conflict.
    assert overlap.json()["detail"]["client_conflicts"] == []
    _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10, 30),
        allow_conflicts=True,
    )
    adjacent = api.post(
        "/api/appointments",
        json={"kind": "event", "title": "Lunch", "starts_at": _at(2026, 10, 5, 12)},
        headers=clinician.headers,
    )
    assert adjacent.status_code == 201


def test_client_double_bookings_warn_until_saved_anyway(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    alex, sam = _clients(db, clinician, "Alex", "Sam")
    [with_colleague] = _book(
        api,
        clinician,
        clinician_id=colleague.id,
        participants=_with(alex),
        starts_at=_at(2026, 10, 5, 10),
    )
    # Alex is busy with the colleague: a warning the scheduler can override.
    couples_body = {"participants": _with(sam, alex), "starts_at": _at(2026, 10, 5, 10, 15)}
    warned = api.post("/api/appointments", json=couples_body, headers=clinician.headers)
    assert warned.status_code == 409
    assert warned.json()["detail"]["message"].startswith("A client in this session")
    assert warned.json()["detail"]["conflicts"] == []
    assert [c["id"] for c in warned.json()["detail"]["client_conflicts"]] == [with_colleague["id"]]
    [couples] = _book(api, clinician, allow_conflicts=True, **couples_body)
    overlap = api.post(
        "/api/appointments",
        json={"participants": _with(alex), "starts_at": _at(2026, 10, 5, 10, 30)},
        headers=clinician.headers,
    )
    assert overlap.status_code == 409
    detail = overlap.json()["detail"]
    assert [c["id"] for c in detail["conflicts"]] == [couples["id"]]
    assert [c["id"] for c in detail["client_conflicts"]] == [with_colleague["id"]]


def test_conflicts_are_per_clinician(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    colleague = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    other = create_client_record(db, clinician, email="other@example.com", first_name="Kim")
    _book(api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 10))
    # The colleague's calendar is free at the same time.
    [theirs] = _book(
        api,
        clinician,
        clinician_id=colleague.id,
        participants=_with(other),
        starts_at=_at(2026, 10, 5, 10),
    )
    # An event blocks only its own clinician's calendar.
    _book(api, colleague, kind="event", title="Supervision", starts_at=_at(2026, 10, 5, 14))
    _book(api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 14))
    # Moving an appointment onto a busy calendar conflicts.
    moved = api.patch(
        f"/api/appointments/{theirs['id']}",
        json={"clinician_id": clinician.id},
        headers=clinician.headers,
    )
    assert moved.status_code == 409


def test_weekly_series_keeps_local_time_across_dst() -> None:
    start = datetime(2026, 10, 26, 14, 0, tzinfo=NY)
    starts = expand_occurrences(start, Recurrence(RecurrenceFrequency.WEEKLY, 1, 3, None), NY)
    assert [s.astimezone(NY).hour for s in starts] == [14, 14, 14]
    # DST ends Nov 1 2026, so the UTC hour shifts by one.
    assert [s.hour for s in starts] == [18, 19, 19]


def test_monthly_series_skips_missing_days() -> None:
    start = datetime(2026, 1, 31, 9, tzinfo=NY)
    starts = expand_occurrences(start, Recurrence(RecurrenceFrequency.MONTHLY, 1, 3, None), NY)
    assert [s.astimezone(NY).date() for s in starts] == [
        date(2026, 1, 31),
        date(2026, 3, 31),
        date(2026, 5, 31),
    ]


def test_series_follow_the_clinicians_time_zone(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    pacific = add_staff(db, clinician.practice_id, "west@example.com", StaffRole.CLINICIAN)
    api.patch("/api/me", json={"time_zone": "America/Los_Angeles"}, headers=pacific.headers)
    client = create_client_record(db, pacific)
    la = ZoneInfo("America/Los_Angeles")
    series = _book(
        api,
        pacific,
        participants=_with(client),
        starts_at=datetime(2026, 10, 26, 9, tzinfo=la).isoformat(),
        recurrence={"frequency": "weekly", "count": 2},
    )
    assert [datetime.fromisoformat(a["starts_at"]).astimezone(la).hour for a in series] == [9, 9]


def test_recurring_series_edit_following_and_cancel(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client, partner = _clients(db, clinician, "Alex", "Sam")
    series = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        recurrence={"frequency": "weekly", "count": 6},
    )
    assert len(series) == 6
    assert len({a["series_id"] for a in series}) == 1

    moved = api.patch(
        f"/api/appointments/{series[2]['id']}",
        params={"scope": "following"},
        json={
            "starts_at": _at(2026, 10, 19, 15),
            "location_type": "video",
            "participants": _with(client, partner),
        },
        headers=clinician.headers,
    )
    assert moved.status_code == 200, moved.text
    moved_rows = moved.json()
    assert len(moved_rows) == 4
    assert all(datetime.fromisoformat(a["starts_at"]).astimezone(NY).hour == 15 for a in moved_rows)
    assert all(a["has_video"] for a in moved_rows)
    assert all(a["title_label"] == "Alex Rivera & Sam Rivera" for a in moved_rows)

    canceled = api.post(
        f"/api/appointments/{series[4]['id']}/cancel",
        params={"scope": "following"},
        json={"reason": "Client moving"},
        headers=clinician.headers,
    )
    assert [a["status"] for a in canceled.json()] == ["canceled", "canceled"]
    assert {a["canceled_by"] for a in canceled.json()} == {"staff"}
    first = api.get(f"/api/appointments/{series[0]['id']}", headers=clinician.headers).json()
    assert datetime.fromisoformat(first["starts_at"]).astimezone(NY).hour == 10
    assert len(first["participants"]) == 1


def test_until_date_limits_series(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    series = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        recurrence={"frequency": "weekly", "interval": 2, "until": "2026-11-16"},
    )
    assert len(series) == 4


def test_status_changes_and_listing(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client, partner, stranger = _clients(db, clinician, "Alex", "Sam", "Kim")
    [appointment] = _book(
        api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 10)
    )
    [couples] = _book(
        api, clinician, participants=_with(stranger, partner), starts_at=_at(2026, 10, 6, 10)
    )
    no_show = api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"status": "no_show"},
        headers=clinician.headers,
    )
    assert no_show.json()[0]["status"] == "no_show"
    assert no_show.json()[0]["participants"][0]["effective_status"] == "no_show"
    requested = api.patch(
        f"/api/appointments/{appointment['id']}",
        json={"status": "requested"},
        headers=clinician.headers,
    )
    assert requested.status_code == 422

    def listed(**params: object) -> list[int]:
        response = api.get("/api/appointments", params=_window(**params), headers=clinician.headers)
        return [a["id"] for a in response.json()]

    assert listed() == [appointment["id"], couples["id"]]
    # The client filter matches any participant.
    assert listed(client_id=partner.id) == [couples["id"]]
    assert listed(client_id=client.id) == [appointment["id"]]
    naive = api.get(
        "/api/appointments",
        params={"start": "2026-10-01T00:00:00", "end": "2026-10-31T00:00:00"},
        headers=clinician.headers,
    )
    assert naive.status_code == 422


def test_listing_filters_by_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    [mine] = _book(api, clinician, kind="event", title="Admin", starts_at=_at(2026, 10, 5, 9))
    [theirs] = _book(api, colleague, kind="event", title="Admin", starts_at=_at(2026, 10, 5, 9))
    assert (mine["participants"], mine["title_label"]) == ([], "Admin")

    def ids(**params: object) -> list[int]:
        response = api.get("/api/appointments", params=_window(**params), headers=clinician.headers)
        return [a["id"] for a in response.json()]

    assert sorted(ids()) == sorted([mine["id"], theirs["id"]])
    assert ids(clinician_ids=[colleague.id]) == [theirs["id"]]
    assert sorted(ids(clinician_ids=[clinician.id, colleague.id])) == sorted(
        [mine["id"], theirs["id"]]
    )


def test_delete_blocked_when_invoiced(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [kept, removable] = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        recurrence={"frequency": "weekly", "count": 2},
    )
    _invoice(db, clinician, kept["participants"][0]["id"])
    assert (
        api.delete(f"/api/appointments/{kept['id']}", headers=clinician.headers).status_code == 409
    )
    assert (
        api.delete(f"/api/appointments/{removable['id']}", headers=clinician.headers).status_code
        == 204
    )
    db.expire_all()
    assert db.query(AppointmentParticipant).count() == 1


def test_other_practices_see_nothing(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    other = register_practice(api, email="other@example.com")
    stolen = api.post(
        "/api/appointments",
        json={"participants": _with(client), "starts_at": _at(2026, 10, 5, 10)},
        headers=other.headers,
    )
    assert stolen.status_code == 404
    onto_my_calendar = api.post(
        "/api/appointments",
        json={
            "kind": "event",
            "title": "x",
            "clinician_id": clinician.id,
            "starts_at": _at(2026, 10, 5, 8),
        },
        headers=other.headers,
    )
    assert onto_my_calendar.status_code == 404
    [mine] = _book(api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 10))
    url = f"/api/appointments/{mine['id']}"
    participant_url = f"{url}/participants/{mine['participants'][0]['id']}"
    assert api.get(url, headers=other.headers).status_code == 404
    assert api.patch(url, json={"memo": "x"}, headers=other.headers).status_code == 404
    assert api.post(f"{url}/cancel", json={}, headers=other.headers).status_code == 404
    assert api.put(participant_url, json={}, headers=other.headers).status_code == 404
    assert api.delete(url, headers=other.headers).status_code == 404
    now = datetime.now(UTC)
    window = {
        "start": (now - timedelta(days=180)).isoformat(),
        "end": (now + timedelta(days=180)).isoformat(),
    }
    assert api.get("/api/appointments", params=window, headers=other.headers).json() == []


@pytest.mark.parametrize(
    ("role", "access_level", "expected"),
    [
        (StaffRole.OWNER, ClinicianAccess.BASIC, 201),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, 201),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, 201),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, 201),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, 403),
        (StaffRole.CLINICIAN, ClinicianAccess.BILLING, 403),
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, 403),
        (StaffRole.BILLER, ClinicianAccess.BASIC, 403),
    ],
)
def test_who_may_book_on_a_colleagues_calendar(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    access_level: ClinicianAccess,
    expected: int,
) -> None:
    client = create_client_record(db, clinician)
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=access_level
    )
    response = api.post(
        "/api/appointments",
        json={
            "clinician_id": clinician.id,
            "participants": _with(client),
            "starts_at": _at(2026, 10, 5, 10),
        },
        headers=member.headers,
    )
    assert response.status_code == expected, response.text


def test_scheduler_books_for_any_clinician_who_joins_the_care_team(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, clinician)
    no_clinician = api.post(
        "/api/appointments",
        json={"participants": _with(client), "starts_at": _at(2026, 10, 5, 10)},
        headers=scheduler.headers,
    )
    assert no_clinician.status_code == 422
    not_a_clinician = api.post(
        "/api/appointments",
        json={
            "clinician_id": scheduler.id,
            "participants": _with(client),
            "starts_at": _at(2026, 10, 5, 10),
        },
        headers=scheduler.headers,
    )
    assert not_a_clinician.status_code == 404

    [booked] = _book(
        api,
        scheduler,
        clinician_id=colleague.id,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
    )
    assert booked["clinician"]["id"] == colleague.id
    db.refresh(client)
    team = {(member.staff_id, member.is_primary) for member in client.care_team}
    assert team == {(clinician.id, True), (colleague.id, False)}
    # Now on the care team, the colleague sees the client and can manage the appointment.
    detail = api.get(f"/api/appointments/{booked['id']}", headers=colleague.headers).json()
    assert detail["restricted"] is False
    assert detail["participants"][0]["client"]["id"] == client.id
    moved = api.patch(
        f"/api/appointments/{booked['id']}", json={"memo": "Room 2"}, headers=scheduler.headers
    )
    assert moved.status_code == 200


def test_colleagues_see_unreachable_clients_as_busy_time(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    supervisor = add_staff(
        db, clinician.practice_id, "sup@example.com", StaffRole.CLINICIAN, first_name="Pat"
    )
    supervisee = add_staff(
        db,
        clinician.practice_id,
        "trainee@example.com",
        StaffRole.CLINICIAN,
        supervisor_id=supervisor.id,
    )
    client = create_client_record(db, clinician, first_name="Zelda")
    trainee_client = create_client_record(db, supervisee, email="kim@example.com")
    [private] = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=_at(2026, 10, 5, 10),
        memo="Discussed grief",
        location_details="Room 4",
    )
    [supervised] = _book(
        api, supervisee, participants=_with(trainee_client), starts_at=_at(2026, 10, 6, 10)
    )

    listed = {
        a["id"]: a
        for a in api.get("/api/appointments", params=_window(), headers=colleague.headers).json()
    }
    busy = listed[private["id"]]
    assert busy["restricted"] is True
    assert busy["participants"] == []
    assert (busy["title"], busy["title_label"]) == ("Busy", "Busy")
    assert (busy["memo"], busy["location_details"], busy["service_code"]) == ("", "", "")
    assert busy["clinician"] == {"id": clinician.id, "name": "Jordan Lee"}
    assert busy["starts_at"] == private["starts_at"]
    assert "Zelda" not in str(listed)
    detail = api.get(f"/api/appointments/{private['id']}", headers=colleague.headers).json()
    assert detail["restricted"] is True and detail["participants"] == []

    # Changing it needs the client (404) and the calendar (403).
    url = f"/api/appointments/{private['id']}"
    assert api.patch(url, json={"memo": "x"}, headers=colleague.headers).status_code == 404
    assert api.post(f"{url}/cancel", json={}, headers=colleague.headers).status_code == 404
    assert api.delete(url, headers=colleague.headers).status_code == 404
    filtered = api.get(
        "/api/appointments", params=_window(client_id=client.id), headers=colleague.headers
    )
    assert filtered.status_code == 404

    # Supervisors see their supervisees' clients.
    seen = {
        a["id"]: a
        for a in api.get("/api/appointments", params=_window(), headers=supervisor.headers).json()
    }
    assert seen[supervised["id"]]["restricted"] is False
    assert seen[private["id"]]["restricted"] is True


def test_colleagues_see_only_the_clients_they_can_reach(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    alex, zelda = _clients(db, clinician, "Alex", "Zelda")
    assign_clinician(db, alex, colleague)
    [couples] = _book(
        api,
        clinician,
        participants=_with(alex, zelda),
        title="Alex and Zelda",
        starts_at=_at(2026, 10, 5, 10),
    )
    [group] = _book(
        api,
        clinician,
        participants=_with(alex, zelda),
        group=True,
        title="Grief group",
        starts_at=_at(2026, 10, 6, 10),
    )
    seen = api.get(f"/api/appointments/{couples['id']}", headers=colleague.headers).json()
    assert seen["restricted"] is False
    assert [p["client"]["id"] for p in seen["participants"]] == [alex.id]
    assert (seen["title"], seen["title_label"]) == ("", "Alex Rivera")
    assert "Zelda" not in str(seen)
    seen_group = api.get(f"/api/appointments/{group['id']}", headers=colleague.headers).json()
    assert [p["client"]["id"] for p in seen_group["participants"]] == [alex.id]
    assert (seen_group["title_label"], seen_group["is_group"]) == ("Grief group", True)
    assert "Zelda" not in str(seen_group)
    # Changing it needs every client, even for someone who manages every calendar.
    scheduler_like = add_staff(
        db,
        clinician.practice_id,
        "lead@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.PRACTICE,
    )
    assert (
        api.patch(
            f"/api/appointments/{couples['id']}", json={"memo": "x"}, headers=colleague.headers
        ).status_code
        == 403
    )
    assert (
        api.patch(
            f"/api/appointments/{couples['id']}",
            json={"memo": "x"},
            headers=scheduler_like.headers,
        ).status_code
        == 200
    )


def test_basic_clinicians_manage_only_their_own_calendar(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    [own] = _book(api, colleague, kind="event", title="Admin", starts_at=_at(2026, 10, 5, 9))
    [shared] = _book(api, clinician, participants=_with(client), starts_at=_at(2026, 10, 5, 10))
    # The owner hands the appointment to the colleague, who joins the client's care team but
    # still can't put it on anyone else's calendar.
    assert (
        api.patch(
            f"/api/appointments/{shared['id']}",
            json={"clinician_id": colleague.id},
            headers=clinician.headers,
        ).status_code
        == 200
    )
    handed_back = api.patch(
        f"/api/appointments/{shared['id']}",
        json={"clinician_id": clinician.id},
        headers=colleague.headers,
    )
    assert handed_back.status_code == 403
    [owner_event] = _book(
        api, clinician, kind="event", title="Admin", starts_at=_at(2026, 10, 7, 9)
    )
    assert (
        api.patch(
            f"/api/appointments/{owner_event['id']}", json={"title": "x"}, headers=colleague.headers
        ).status_code
        == 403
    )
    assert (
        api.patch(
            f"/api/appointments/{own['id']}", json={"title": "Notes"}, headers=colleague.headers
        ).status_code
        == 200
    )


def test_calendar_events_go_to_clinician_schedulers_and_the_care_teams(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = _colleague(db, clinician.practice_id)
    outsider = _colleague(db, clinician.practice_id, "outsider@example.com")
    partners_clinician = _colleague(db, clinician.practice_id, "partner-team@example.com")
    scheduler = add_staff(db, clinician.practice_id, "desk@example.com", StaffRole.SCHEDULER)
    biller = add_staff(db, clinician.practice_id, "bills@example.com", StaffRole.BILLER)
    client = create_client_record(db, clinician)
    partner = create_client_record(db, partners_clinician, email="partner@example.com")
    [booked] = _book(
        api,
        scheduler,
        clinician_id=colleague.id,
        participants=_with(client, partner),
        starts_at=_at(2026, 10, 5, 10),
    )
    appointment = db.get(Appointment, booked["id"])
    assert appointment is not None
    recipients = set(calendar_recipients(db, [appointment]))
    staff_ids = {recipient_id for role, recipient_id in recipients if role == Role.STAFF}
    # Billers can see the clients' profiles; the outsider can't.
    assert staff_ids == {
        clinician.id,
        colleague.id,
        partners_clinician.id,
        scheduler.id,
        biller.id,
    }
    assert outsider.id not in staff_ids
    assert {(Role.CLIENT, client.id), (Role.CLIENT, partner.id)} <= recipients


def test_video_join_tokens_round_trip_and_expire(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    from synari.services.video_links import create_join_url, decode_join_token

    client = create_client_record(db, clinician)
    [created] = _book(
        api,
        clinician,
        participants=_with(client),
        starts_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        location_type="video",
    )
    appointment = db.get(Appointment, created["id"])
    assert appointment is not None
    url = create_join_url(appointment, client.id)
    assert url.startswith("http://app.test/join/")
    claims = decode_join_token(url.rsplit("/", 1)[1])
    assert claims is not None
    assert (claims.appointment_id, claims.client_id) == (appointment.id, client.id)
    assert decode_join_token("not-a-token") is None
    assert decode_join_token(clinician.data["access_token"]) is None
