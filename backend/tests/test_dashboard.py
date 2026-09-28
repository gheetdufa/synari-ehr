"""The staff dashboard: today's schedule and personal work counts in a group practice."""

import secrets
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClientForm,
    Conversation,
    Invoice,
    Message,
    Note,
    StaffMember,
    WaitingRoomEntry,
)
from synari.models.enums import (
    AppointmentStatus,
    ClientFormStatus,
    ClinicianAccess,
    InvoiceStatus,
    NoteStatus,
    Role,
    StaffRole,
)
from tests.conftest import StaffAccount, add_staff, create_client_record, register_practice

ZONE = ZoneInfo("America/New_York")
PERSONAL_COUNTS = (
    "pending_requests",
    "unread_messages",
    "draft_notes",
    "appointments_missing_notes",
    "pending_forms",
    "flagged_forms",
    "waiting_room",
)


def _noon_today() -> datetime:
    """Midday today on the practice's wall clock, so 'today' never straddles midnight."""
    return datetime.combine(datetime.now(ZONE).date(), time(12), tzinfo=ZONE)


def _appointment(
    db: Session, clinician: StaffAccount, client: Client, starts_at: datetime, **fields: object
) -> Appointment:
    appointment = Appointment(
        practice_id=clinician.practice_id,
        clinician_id=clinician.id,
        participants=[AppointmentParticipant(client_id=client.id)],
        starts_at=starts_at,
        ends_at=starts_at + timedelta(minutes=50),
        **fields,
    )
    db.add(appointment)
    db.commit()
    return appointment


def _invoice(
    db: Session, client: Client, total_cents: int, paid_cents: int = 0, **fields: object
) -> None:
    today = datetime.now(UTC).date()
    db.add(
        Invoice(
            practice_id=client.practice_id,
            client_id=client.id,
            number=secrets.token_hex(4),
            issued_on=today,
            due_on=today,
            total_cents=total_cents,
            paid_cents=paid_cents,
            **fields,
        )
    )
    db.commit()


def _form(db: Session, client: Client, **fields: object) -> None:
    db.add(
        ClientForm(
            practice_id=client.practice_id,
            client_id=client.id,
            kind="assessment",
            name="PHQ-9",
            fields=[],
            **fields,
        )
    )
    db.commit()


def _workload(db: Session, clinician: StaffAccount, client: Client, size: int) -> list[Appointment]:
    """`size` of everything that waits on a clinician, for one client. Returns today's sessions."""
    now = datetime.now(UTC)
    today = []
    for n in range(size):
        session = _appointment(
            db,
            clinician,
            client,
            _noon_today() + timedelta(hours=n),
            video_room_name=secrets.token_hex(8),
        )
        today.append(session)
        db.add(
            WaitingRoomEntry(
                appointment_id=session.id,
                client_id=client.id,
                display_name=client.first_name,
                secret_hash=secrets.token_hex(32),
            )
        )
        _appointment(
            db, clinician, client, now + timedelta(days=3 + n), status=AppointmentStatus.REQUESTED
        )
        _appointment(
            db,
            clinician,
            client,
            now - timedelta(days=2, hours=n),
            status=AppointmentStatus.ATTENDED,
        )
        drafted = _appointment(
            db,
            clinician,
            client,
            now - timedelta(days=5, hours=n),
            status=AppointmentStatus.ATTENDED,
        )
        db.add(
            Note(
                practice_id=client.practice_id,
                author_id=clinician.id,
                client_id=client.id,
                appointment_id=drafted.id,
            )
        )
        _form(db, client)
        _form(db, client, status=ClientFormStatus.COMPLETED, flagged=True, completed_at=now)
        _invoice(db, client, 10_000, 2_500)
    conversation = Conversation(
        practice_id=client.practice_id, clinician_id=clinician.id, client_id=client.id
    )
    db.add(conversation)
    db.flush()
    db.add_all(
        Message(conversation_id=conversation.id, sender_role=Role.CLIENT, body="Hello")
        for _ in range(size)
    )
    db.commit()
    return today


def _dashboard(api: TestClient, account: StaffAccount, **params: str) -> dict:
    response = api.get("/api/dashboard", params=params, headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_solo_clinician_dashboard(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    [today] = _workload(db, clinician, client, 1)
    _appointment(
        db, clinician, client, _noon_today() + timedelta(hours=3), status=AppointmentStatus.CANCELED
    )

    data = _dashboard(api, clinician)
    assert data["scope"] == "mine"
    assert [a["id"] for a in data["today"]] == [today.id]
    assert {key: data[key] for key in PERSONAL_COUNTS} == dict.fromkeys(PERSONAL_COUNTS, 1)
    assert data["client_count"] == 1
    assert data["outstanding_cents"] == 7_500

    other = register_practice(api, email="other@example.com")
    empty = _dashboard(api, other)
    assert empty["today"] == []
    assert {key: empty[key] for key in PERSONAL_COUNTS} == dict.fromkeys(PERSONAL_COUNTS, 0)
    assert (empty["client_count"], empty["outstanding_cents"]) == (0, 0)


def test_dashboard_is_personal_in_a_group_practice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    casey = add_staff(db, practice_id, "casey@example.com", StaffRole.CLINICIAN)
    riley = add_staff(db, practice_id, "riley@example.com", StaffRole.CLINICIAN)
    scheduler = add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER)
    casey_client = create_client_record(db, casey)
    riley_client = create_client_record(db, riley, email="jamie@example.com", first_name="Jamie")
    casey_today = _workload(db, casey, casey_client, 1)
    riley_today = _workload(db, riley, riley_client, 2)

    for account, today, size in ((casey, casey_today, 1), (riley, riley_today, 2)):
        data = _dashboard(api, account)
        assert [a["id"] for a in data["today"]] == [a.id for a in today]
        assert {key: data[key] for key in PERSONAL_COUNTS} == dict.fromkeys(PERSONAL_COUNTS, size)
        assert data["client_count"] == 1
        assert data["outstanding_cents"] is None

    # The owner sees every chart and request, but the calendar, notes and messages are personal.
    owner = _dashboard(api, clinician)
    assert owner["today"] == []
    assert (owner["pending_requests"], owner["pending_forms"], owner["flagged_forms"]) == (3, 3, 3)
    assert (owner["draft_notes"], owner["appointments_missing_notes"]) == (0, 0)
    assert (owner["unread_messages"], owner["waiting_room"]) == (0, 0)
    assert (owner["client_count"], owner["outstanding_cents"]) == (2, 22_500)

    # Schedulers follow every request and form, but never see clinical flags or balances.
    desk = _dashboard(api, scheduler)
    assert (desk["pending_requests"], desk["pending_forms"], desk["flagged_forms"]) == (3, 3, 0)
    assert (desk["client_count"], desk["outstanding_cents"]) == (2, None)


def test_missing_notes_count_only_my_own_notes(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    client = create_client_record(db, clinician)
    session = _appointment(
        db,
        clinician,
        client,
        datetime.now(UTC) - timedelta(days=1),
        status=AppointmentStatus.ATTENDED,
    )
    db.add(
        Note(
            practice_id=clinician.practice_id,
            author_id=colleague.id,
            client_id=client.id,
            appointment_id=session.id,
            status=NoteStatus.SIGNED,
        )
    )
    db.commit()
    assert _dashboard(api, clinician)["appointments_missing_notes"] == 1
    assert _dashboard(api, colleague)["appointments_missing_notes"] == 0


def test_supervisors_see_notes_awaiting_their_cosignature(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    supervisor = add_staff(db, practice_id, "sup@example.com", StaffRole.CLINICIAN)
    supervisee = add_staff(
        db, practice_id, "trainee@example.com", StaffRole.CLINICIAN, supervisor_id=supervisor.id
    )
    client = create_client_record(db, supervisee)
    waiting_on = [supervisor, supervisor, clinician, supervisor, supervisor]
    statuses = [
        NoteStatus.PENDING_COSIGN,
        NoteStatus.PENDING_COSIGN,
        NoteStatus.PENDING_COSIGN,
        NoteStatus.SIGNED,
        NoteStatus.DRAFT,
    ]
    db.add_all(
        Note(
            practice_id=practice_id,
            author_id=supervisee.id,
            client_id=client.id,
            supervisor_id=account.id,
            status=note_status,
        )
        for account, note_status in zip(waiting_on, statuses, strict=True)
    )
    db.commit()

    assert _dashboard(api, supervisor)["notes_awaiting_cosign"] == 2
    assert _dashboard(api, clinician)["notes_awaiting_cosign"] == 1
    trainee = _dashboard(api, supervisee)
    assert (trainee["notes_awaiting_cosign"], trainee["draft_notes"]) == (0, 1)
    # A supervisor who can no longer open the client's chart has nothing to co-sign.
    db.get_one(StaffMember, supervisee.id).supervisor_id = None
    db.commit()
    assert _dashboard(api, supervisor)["notes_awaiting_cosign"] == 0


def test_outstanding_balance_depends_on_billing_access(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    team = {
        "owner": clinician,
        "billing_clinician": add_staff(
            db,
            practice_id,
            "casey@example.com",
            StaffRole.CLINICIAN,
            clinician_access=ClinicianAccess.BILLING,
        ),
        "basic_clinician": add_staff(db, practice_id, "riley@example.com", StaffRole.CLINICIAN),
        "biller": add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER),
        "scheduler": add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER),
    }
    own = create_client_record(db, team["billing_clinician"])
    other = create_client_record(db, team["basic_clinician"], email="jamie@example.com")
    _invoice(db, own, 10_000, 2_500)
    _invoice(db, own, 4_000, 4_000, status=InvoiceStatus.PAID)
    _invoice(db, other, 5_000)
    _invoice(db, other, 9_000, status=InvoiceStatus.VOID)
    elsewhere = register_practice(api, email="other@example.com")
    _invoice(db, create_client_record(db, elsewhere, email="x@example.com"), 99_000)

    expected = {
        "owner": 12_500,
        "billing_clinician": 7_500,
        "basic_clinician": None,
        "biller": 12_500,
        "scheduler": None,
    }
    for who, cents in expected.items():
        assert _dashboard(api, team[who])["outstanding_cents"] == cents, who


def test_practice_schedule_is_for_staff_who_manage_every_calendar(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_id = clinician.practice_id
    casey = add_staff(db, practice_id, "casey@example.com", StaffRole.CLINICIAN)
    scheduler = add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, casey)
    caseys = _appointment(db, casey, client, _noon_today())
    owners = _appointment(db, clinician, client, _noon_today() + timedelta(hours=1))
    _appointment(db, clinician, client, _noon_today() + timedelta(days=1))
    elsewhere = register_practice(api, email="other@example.com")
    outside = create_client_record(db, elsewhere, email="x@example.com")
    _appointment(db, elsewhere, outside, _noon_today())

    for account in (clinician, scheduler):
        data = _dashboard(api, account, scope="practice")
        assert data["scope"] == "practice"
        assert [a["id"] for a in data["today"]] == [caseys.id, owners.id]
    assert [a["id"] for a in _dashboard(api, casey)["today"]] == [caseys.id]
    assert _dashboard(api, scheduler)["today"] == []
    denied = api.get("/api/dashboard", params={"scope": "practice"}, headers=casey.headers)
    assert denied.status_code == 403
    invalid = api.get("/api/dashboard", params={"scope": "everyone"}, headers=casey.headers)
    assert invalid.status_code == 422


def test_today_leaves_out_clients_i_cant_reach(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    casey = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    theirs = create_client_record(db, casey)
    stranger = create_client_record(db, clinician, email="lee@example.com", first_name="Lee")
    session = _appointment(db, casey, theirs, _noon_today())
    session.participants.append(AppointmentParticipant(client_id=stranger.id))
    db.commit()

    [today] = _dashboard(api, casey)["today"]

    assert [p["client"]["id"] for p in today["participants"]] == [theirs.id]
