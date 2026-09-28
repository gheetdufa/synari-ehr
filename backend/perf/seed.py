"""Seed a large, realistic group practice for load and query-count testing.

Run against a throwaway database only (it refuses a database that already has practices):

    createdb synari_perf   # e.g. docker compose exec db createdb -U synari synari_perf
    DATABASE_URL=postgresql+psycopg://synari:synari@localhost:5432/synari_perf \\
        uv run alembic upgrade head
    DATABASE_URL=... uv run python -m perf.seed --clinicians 25 --clients 5000 --weeks 104

Every staff member's password is the value of --password. All data is fictional. Encrypted
columns use DATA_ENCRYPTION_KEYS (or a key derived from SECRET_KEY), so run the API against the
seeded database with the same settings.
"""

import argparse
import random
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from synari.db import SessionLocal
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AuditEvent,
    Claim,
    ClaimLine,
    Client,
    ClientClinician,
    Conversation,
    InsurancePolicy,
    Invoice,
    InvoiceItem,
    Message,
    Note,
    Payer,
    Payment,
    PaymentAllocation,
    Practice,
    Service,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BillingType,
    ClaimStatus,
    ClinicianAccess,
    InvoiceItemKind,
    InvoiceStatus,
    LocationType,
    NoteStatus,
    PaymentStatus,
    StaffRole,
)
from synari.security import hash_password
from synari.services.onboarding import create_practice

FIRST = [
    "Alex",
    "Sam",
    "Jordan",
    "Riley",
    "Casey",
    "Morgan",
    "Taylor",
    "Jamie",
    "Avery",
    "Quinn",
    "Drew",
    "Kai",
    "Rowan",
    "Skyler",
    "Emerson",
    "Hayden",
    "Parker",
    "Reese",
    "Sage",
    "Blair",
]
LAST = [
    "Rivera",
    "Chen",
    "Patel",
    "Nguyen",
    "Garcia",
    "Smith",
    "Okafor",
    "Kim",
    "Silva",
    "Cohen",
    "Haddad",
    "Novak",
    "Ibrahim",
    "Larsen",
    "Moreau",
    "Tanaka",
    "Walsh",
    "Singh",
    "Rossi",
    "Brooks",
]
NOTE_TEXT = (
    "Client reported moderate anxiety this week related to work deadlines. Reviewed sleep and "
    "exercise routines. Practiced diaphragmatic breathing and cognitive restructuring of "
    "catastrophic thoughts. Client identified two alternative interpretations. Risk screen "
    "negative. Plan: continue weekly CBT, assign thought record and 10 minutes of breathing "
    "practice daily. "
) * 2
BATCH = 2000


def _insert(db: Session, model: type, rows: list[dict[str, Any]]) -> list[int]:
    """Bulk insert rows and return their ids in order."""
    ids: list[int] = []
    for start in range(0, len(rows), BATCH):
        chunk = rows[start : start + BATCH]
        result = db.execute(insert(model).returning(model.id, sort_by_parameter_order=True), chunk)
        ids.extend(result.scalars().all())
    return ids


def _seed_claims(
    db: Session,
    practice_id: int,
    attended: list[tuple[int, dict[str, Any], dict[str, Any]]],
    policy_of: dict[int, tuple[int, int]],
    now: datetime,
    rng: random.Random,
) -> int:
    """One-line claims for insurance clients' attended sessions older than a week.

    Sessions over a month old are mostly paid (some denied, rejected or still pending); newer
    ones are drafts or in flight. The last week stays in the unbilled queue. Returns the count.
    """
    claim_rows, line_rows = [], []
    for participant_id, row, appointment in attended:
        started = appointment["starts_at"]
        if row["client_id"] not in policy_of or started > now - timedelta(days=7):
            continue
        policy_id, payer_id = policy_of[row["client_id"]]
        if started < now - timedelta(days=30):
            status = rng.choices(
                [
                    ClaimStatus.PAID,
                    ClaimStatus.DENIED,
                    ClaimStatus.REJECTED,
                    ClaimStatus.ACCEPTED,
                    ClaimStatus.SUBMITTED,
                ],
                weights=[82, 4, 4, 5, 5],
            )[0]
        else:
            status = rng.choice([ClaimStatus.DRAFT, ClaimStatus.SUBMITTED, ClaimStatus.ACCEPTED])
        paid = status == ClaimStatus.PAID
        amounts = {
            "paid_cents": 12000 if paid else 0,
            "adjustment_cents": 500 if paid else 0,
            "patient_responsibility_cents": 2500 if paid else 0,
        }
        number = len(claim_rows) + 1
        pos = "02" if appointment["location_type"] == LocationType.VIDEO else "11"
        claim_rows.append(
            {
                "practice_id": practice_id,
                "client_id": row["client_id"],
                "policy_id": policy_id,
                "payer_id": payer_id,
                "status": status,
                "patient_control_number": f"SYNPERF{number}",
                "rendering_clinician_id": appointment["clinician_id"],
                "place_of_service": pos,
                "diagnosis_codes": ["F411"],
                "total_charge_cents": 15000,
                **amounts,
                "submitted_at": None
                if status == ClaimStatus.DRAFT
                else started + timedelta(days=2),
                "adjudicated_at": started + timedelta(days=21)
                if status in (ClaimStatus.PAID, ClaimStatus.DENIED)
                else None,
                "created_at": started + timedelta(days=1),
            }
        )
        line_rows.append(
            {
                "participant_id": participant_id,
                "line_control_number": f"SYNPERF{number}-1",
                "service_date": started.date(),
                "procedure_code": appointment["service_code"],
                "charge_cents": 15000,
                "place_of_service": pos,
                "diagnosis_pointers": [1],
                "allowed_cents": 14500 if paid else None,
                **amounts,
            }
        )
    claim_ids = _insert(db, Claim, claim_rows)
    for claim_id, line in zip(claim_ids, line_rows, strict=True):
        line["claim_id"] = claim_id
    _insert(db, ClaimLine, line_rows)
    return len(claim_ids)


def seed(
    db: Session, *, clinicians: int, clients: int, weeks: int, password: str, rng: random.Random
) -> dict[str, int]:
    """Create one large practice; returns row counts."""
    if db.scalar(select(func.count()).select_from(Practice)):
        raise SystemExit("This database already has practices; use an empty one.")
    password_hash = hash_password(password)
    owner = create_practice(
        db,
        practice_name="Load Test Counseling Group",
        time_zone="America/Chicago",
        owner_email="owner@perf.example.com",
        owner_password_hash=password_hash,
        owner_first_name="Olivia",
        owner_last_name="Owner",
        owner_is_clinician=True,
    )
    practice_id = owner.practice_id
    staff_rows = [
        {
            "practice_id": practice_id,
            "email": f"clinician{i}@perf.example.com",
            "password_hash": password_hash,
            "first_name": rng.choice(FIRST),
            "last_name": rng.choice(LAST),
            "role": StaffRole.CLINICIAN,
            "clinician_access": ClinicianAccess.BILLING,
            "is_clinician": True,
            "credentials": rng.choice(["LCSW", "LPC", "LMFT", "PsyD"]),
            "npi": "1234567893",
            "time_zone": "America/Chicago",
        }
        for i in range(1, clinicians)
    ]
    for email, role in (
        ("scheduler@perf.example.com", StaffRole.SCHEDULER),
        ("biller@perf.example.com", StaffRole.BILLER),
        ("manager@perf.example.com", StaffRole.PRACTICE_MANAGER),
    ):
        staff_rows.append(
            {
                "practice_id": practice_id,
                "email": email,
                "password_hash": password_hash,
                "first_name": role.value.title(),
                "last_name": "Staff",
                "role": role,
                "is_clinician": False,
                "time_zone": "America/Chicago",
            }
        )
    clinician_ids = [owner.id, *_insert(db, StaffMember, staff_rows)[: clinicians - 1]]
    service = db.scalar(
        select(Service).where(Service.practice_id == practice_id, Service.code == "90834")
    )
    service.rate_cents = 15000
    payer_ids = _insert(
        db,
        Payer,
        [
            {"practice_id": practice_id, "name": name, "external_id": external_id}
            for name, external_id in (("Aetna", "60054"), ("Cigna", "62308"), ("UHC", "87726"))
        ],
    )

    client_rows = [
        {
            "practice_id": practice_id,
            "first_name": rng.choice(FIRST),
            "last_name": rng.choice(LAST),
            "email": f"client{i}@perf.example.com",
            "phone": f"312-555-{i % 10000:04d}",
            "date_of_birth": date(1960, 1, 1) + timedelta(days=rng.randrange(20000)),
            "sex": rng.choice(["F", "M"]),
            "billing_type": BillingType.INSURANCE if i % 10 == 0 else BillingType.SELF_PAY,
            "diagnosis_codes": [{"code": "F41.1", "description": "Generalized anxiety disorder"}],
        }
        for i in range(clients)
    ]
    client_ids = _insert(db, Client, client_rows)
    caseload: dict[int, list[int]] = {cid: [] for cid in clinician_ids}
    team_rows = []
    for index, client_id in enumerate(client_ids):
        clinician_id = clinician_ids[index % len(clinician_ids)]
        caseload[clinician_id].append(client_id)
        team_rows.append({"client_id": client_id, "staff_id": clinician_id, "is_primary": True})
    _insert(db, ClientClinician, team_rows)
    policy_rows = [
        {
            "client_id": client_id,
            "payer_id": rng.choice(payer_ids),
            "member_id": f"M{client_id:08d}",
            "rank": "primary",
            "copay_cents": 2500,
        }
        for index, client_id in enumerate(client_ids)
        if index % 10 == 0
    ]
    policy_ids = _insert(db, InsurancePolicy, policy_rows)
    policy_of = {
        row["client_id"]: (policy_id, row["payer_id"])
        for policy_id, row in zip(policy_ids, policy_rows, strict=True)
    }

    # Appointments: ~18 sessions a week per clinician, some groups, over `weeks` weeks back and
    # four weeks ahead.
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    appointment_rows: list[dict[str, Any]] = []
    participant_plan: list[list[int]] = []
    for clinician_id in clinician_ids:
        own = caseload[clinician_id]
        for week in range(-weeks, 4):
            for slot in range(18):
                day = slot % 5
                start = now + timedelta(weeks=week, days=day - now.weekday(), hours=slot % 8 - 4)
                group = slot == 17
                members = rng.sample(own, k=min(6, len(own))) if group else [rng.choice(own)]
                past = start < now
                status = (
                    rng.choices(
                        [
                            AppointmentStatus.ATTENDED,
                            AppointmentStatus.NO_SHOW,
                            AppointmentStatus.CANCELED,
                        ],
                        weights=[88, 5, 7],
                    )[0]
                    if past
                    else AppointmentStatus.SCHEDULED
                )
                appointment_rows.append(
                    {
                        "practice_id": practice_id,
                        "clinician_id": clinician_id,
                        "kind": AppointmentKind.APPOINTMENT,
                        "title": "Skills group" if group else "",
                        "service_id": service.id,
                        "service_code": "90853" if group else "90834",
                        "service_description": "Group" if group else service.description,
                        "starts_at": start,
                        "ends_at": start + timedelta(minutes=90 if group else 50),
                        "location_type": rng.choice([LocationType.VIDEO, LocationType.IN_PERSON]),
                        "status": status,
                    }
                )
                participant_plan.append(members)
    appointment_ids = _insert(db, Appointment, appointment_rows)
    participant_rows = [
        {"appointment_id": appointment_id, "client_id": client_id, "fee_cents": 15000}
        for appointment_id, members in zip(appointment_ids, participant_plan, strict=True)
        for client_id in members
    ]
    participant_ids = _insert(db, AppointmentParticipant, participant_rows)

    # Notes for most attended sessions, invoices and payments for attended participants.
    note_rows, invoice_rows, attended = [], [], []
    by_appointment = dict(zip(appointment_ids, appointment_rows, strict=True))
    for participant_id, row in zip(participant_ids, participant_rows, strict=True):
        appointment = by_appointment[row["appointment_id"]]
        if appointment["status"] != AppointmentStatus.ATTENDED:
            continue
        attended.append((participant_id, row, appointment))
        if rng.random() < 0.9:
            note_rows.append(
                {
                    "practice_id": practice_id,
                    "author_id": appointment["clinician_id"],
                    "client_id": row["client_id"],
                    "appointment_id": row["appointment_id"],
                    "format": "FREEFORM",
                    "content": NOTE_TEXT,
                    "status": NoteStatus.SIGNED,
                    "signed_at": appointment["ends_at"],
                    "was_signed": True,
                    "created_at": appointment["ends_at"],
                    "updated_at": appointment["ends_at"],
                }
            )
    _insert(db, Note, note_rows)
    for number, (_participant_id, row, appointment) in enumerate(attended, start=1):
        issued = appointment["starts_at"].date()
        invoice_rows.append(
            {
                "practice_id": practice_id,
                "client_id": row["client_id"],
                "number": f"INV-{number:07d}",
                "issued_on": issued,
                "due_on": issued,
                "status": InvoiceStatus.PAID if number % 12 else InvoiceStatus.OPEN,
                "total_cents": 15000,
                "paid_cents": 15000 if number % 12 else 0,
                "created_at": appointment["ends_at"] + timedelta(hours=12),
                "updated_at": appointment["ends_at"] + timedelta(hours=12),
            }
        )
    invoice_ids = _insert(db, Invoice, invoice_rows)
    _insert(
        db,
        InvoiceItem,
        [
            {
                "invoice_id": invoice_id,
                "kind": InvoiceItemKind.SERVICE,
                "participant_id": participant_id,
                "clinician_id": appointment["clinician_id"],
                "service_date": appointment["starts_at"].date(),
                "service_code": appointment["service_code"],
                "description": appointment["service_description"],
                "amount_cents": 15000,
            }
            for invoice_id, (participant_id, _row, appointment) in zip(
                invoice_ids, attended, strict=True
            )
        ],
    )
    paid = [
        (invoice_id, invoice)
        for invoice_id, invoice in zip(invoice_ids, invoice_rows, strict=True)
        if invoice["status"] == InvoiceStatus.PAID
    ]
    payment_ids = _insert(
        db,
        Payment,
        [
            {
                "practice_id": practice_id,
                "client_id": invoice["client_id"],
                "amount_cents": 15000,
                "method": "card",
                "status": PaymentStatus.SUCCEEDED,
                "received_at": datetime.combine(invoice["issued_on"], datetime.min.time(), UTC),
                "created_at": datetime.combine(invoice["issued_on"], datetime.min.time(), UTC),
            }
            for _invoice_id, invoice in paid
        ],
    )
    _insert(
        db,
        PaymentAllocation,
        [
            {"payment_id": payment_id, "invoice_id": invoice_id, "amount_cents": 15000}
            for payment_id, (invoice_id, _invoice) in zip(payment_ids, paid, strict=True)
        ],
    )

    claim_count = _seed_claims(db, practice_id, attended, policy_of, now, rng)

    # A conversation per client with ten messages each.
    conversation_ids = _insert(
        db,
        Conversation,
        [
            {
                "practice_id": practice_id,
                "clinician_id": clinician_ids[index % len(clinician_ids)],
                "client_id": client_id,
                "last_message_at": now - timedelta(hours=index % 500),
                "clinician_read_at": now - timedelta(hours=index % 500),
            }
            for index, client_id in enumerate(client_ids)
        ],
    )
    message_rows = [
        {
            "conversation_id": conversation_id,
            "sender_role": "client" if m % 2 else "staff",
            "sender_staff_id": None if m % 2 else clinician_ids[index % len(clinician_ids)],
            "body": "Checking in about next week's session and the homework.",
            "created_at": now - timedelta(days=m, hours=index % 500),
        }
        for index, conversation_id in enumerate(conversation_ids)
        for m in range(10)
    ]
    _insert(db, Message, message_rows)
    audit_rows = [
        {
            "practice_id": practice_id,
            "actor_role": "staff",
            "actor_id": rng.choice(clinician_ids),
            "action": rng.choice(["client.view", "note.view", "appointments.list", "auth.login"]),
            "resource_type": "client",
            "resource_id": rng.choice(client_ids),
        }
        for _ in range(len(appointment_ids) * 2)
    ]
    _insert(db, AuditEvent, audit_rows)
    db.commit()
    return {
        "staff": len(clinician_ids) + 3,
        "clients": len(client_ids),
        "appointments": len(appointment_ids),
        "participants": len(participant_ids),
        "notes": len(note_rows),
        "invoices": len(invoice_ids),
        "payments": len(payment_ids),
        "claims": claim_count,
        "messages": len(message_rows),
        "audit_events": len(audit_rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clinicians", type=int, default=25)
    parser.add_argument("--clients", type=int, default=5000)
    parser.add_argument("--weeks", type=int, default=104)
    parser.add_argument("--password", default="load-test-password")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    with SessionLocal() as db:
        counts = seed(
            db,
            clinicians=args.clinicians,
            clients=args.clients,
            weeks=args.weeks,
            password=args.password,
            rng=random.Random(args.seed),
        )
    for name, count in counts.items():
        print(f"{name:>14}: {count:,}")


if __name__ == "__main__":
    main()
