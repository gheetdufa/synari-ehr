from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import (
    AuditEvent,
    Claim,
    ClaimLine,
    InsurancePolicy,
    Invoice,
    InvoiceItem,
    Payer,
    Payment,
    PaymentAllocation,
)
from synari.models.enums import (
    AppointmentStatus,
    ClaimStatus,
    ClinicianAccess,
    InvoiceItemKind,
    InvoiceStatus,
    PaymentStatus,
    StaffRole,
)
from synari.services.reports import split_pro_rata
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    create_client_record,
    register_practice,
)

# Noon in New York on 2026-03-10, the practice's day.
SESSION_AT = datetime(2026, 3, 10, 16, 0, tzinfo=UTC)
PERIOD = {"start": "2026-03-01", "end": "2026-03-31"}


@pytest.mark.parametrize(
    ("total", "weights", "expected"),
    [
        (100, [1, 1, 1], [34, 33, 33]),
        (10000, [15000, 5000], [7500, 2500]),
        (0, [5, 5], [0, 0]),
        (50, [0, 0], [0, 0]),
        (100, [150, -50], [150, -50]),
    ],
)
def test_split_pro_rata(total: int, weights: list[int], expected: list[int]) -> None:
    parts = split_pro_rata(total, weights)
    assert parts == expected
    if any(weights):
        assert sum(parts) == total


def _invoice(
    db: Session, owner: StaffAccount, client_id: int, lines: list[tuple[int | None, int]]
) -> Invoice:
    invoice = Invoice(
        practice_id=owner.practice_id,
        client_id=client_id,
        number=f"INV-{client_id}-{len(lines)}",
        issued_on=date(2026, 1, 5),
        due_on=date(2026, 1, 5),
        status=InvoiceStatus.OPEN,
        total_cents=sum(amount for _, amount in lines),
        items=[
            InvoiceItem(
                kind=InvoiceItemKind.SERVICE if clinician_id else InvoiceItemKind.CUSTOM,
                clinician_id=clinician_id,
                service_date=date(2026, 1, 5),
                description="Session",
                amount_cents=amount,
            )
            for clinician_id, amount in lines
        ],
    )
    db.add(invoice)
    db.flush()
    return invoice


def _pay(
    db: Session,
    owner: StaffAccount,
    client_id: int,
    amount: int,
    allocations: list[tuple[Invoice, int]],
) -> None:
    db.add(
        Payment(
            practice_id=owner.practice_id,
            client_id=client_id,
            amount_cents=amount,
            method="cash",
            status=PaymentStatus.SUCCEEDED,
            received_at=SESSION_AT,
            allocations=[
                PaymentAllocation(invoice_id=invoice.id, amount_cents=part)
                for invoice, part in allocations
            ],
        )
    )
    for invoice, part in allocations:
        invoice.paid_cents += part


@pytest.fixture
def practice(api: TestClient, clinician: StaffAccount, db: Session) -> dict:
    """Two clinicians' clients with client payments, an insurance payment and an open claim."""
    colleague = add_staff(
        db,
        clinician.practice_id,
        "col@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
        first_name="Casey",
        last_name="Morgan",
    )
    mine = create_client_record(db, clinician, email="mine@example.com")
    theirs = create_client_record(db, colleague, email="theirs@example.com", first_name="Blair")

    # Mine: one invoice with a session (15000) and a custom fee (5000), paid 10000 + 2000 credit.
    invoice = _invoice(db, clinician, mine.id, [(clinician.id, 15000), (None, 5000)])
    _pay(db, clinician, mine.id, 12000, [(invoice, 10000)])
    # Theirs: a 9000 session paid in full.
    other_invoice = _invoice(db, clinician, theirs.id, [(colleague.id, 9000)])
    _pay(db, clinician, theirs.id, 9000, [(other_invoice, 9000)])

    payer = Payer(practice_id=clinician.practice_id, name="Aetna", external_id="60054")
    db.add(payer)
    db.flush()
    appointment = create_appointment(
        db, colleague, [theirs], starts_at=SESSION_AT, status=AppointmentStatus.ATTENDED
    )
    policy = InsurancePolicy(client_id=theirs.id, payer_id=payer.id, member_id="W1")
    db.add(policy)
    db.flush()
    paid = Claim(
        practice_id=clinician.practice_id,
        client_id=theirs.id,
        policy_id=policy.id,
        payer_id=payer.id,
        status=ClaimStatus.PAID,
        patient_control_number="SYN1",
        rendering_clinician_id=colleague.id,
        total_charge_cents=20000,
        paid_cents=8000,
        adjustment_cents=9000,
        patient_responsibility_cents=3000,
        submitted_at=SESSION_AT,
        adjudicated_at=SESSION_AT + timedelta(days=5),
        lines=[
            ClaimLine(
                participant_id=appointment.participants[0].id,
                line_control_number="L1",
                service_date=date(2026, 3, 10),
                procedure_code="90834",
                charge_cents=20000,
                paid_cents=8000,
            )
        ],
    )
    open_claim = Claim(
        practice_id=clinician.practice_id,
        client_id=theirs.id,
        policy_id=policy.id,
        payer_id=payer.id,
        status=ClaimStatus.SUBMITTED,
        patient_control_number="SYN2",
        rendering_clinician_id=colleague.id,
        total_charge_cents=20000,
        submitted_at=datetime(2026, 1, 20, tzinfo=UTC),
    )
    db.add_all([paid, open_claim])
    db.commit()
    return {"colleague": colleague, "mine": mine, "theirs": theirs}


def test_income_attributes_payments_to_clinicians(
    api: TestClient, clinician: StaffAccount, practice: dict
) -> None:
    report = api.get("/api/reports/income", params=PERIOD, headers=clinician.headers).json()
    rows = {row["clinician_name"]: row for row in report["rows"]}
    # 10000 applied to a 15000 + 5000 invoice splits 7500 / 2500.
    assert rows["Jordan Lee"]["client_payments_cents"] == 7500
    assert rows["Other"]["client_payments_cents"] == 2500
    assert rows["Casey Morgan"]["client_payments_cents"] == 9000
    assert rows["Casey Morgan"]["insurance_payments_cents"] == 8000
    assert report["unapplied_cents"] == 2000
    assert report["total_cents"] == 7500 + 2500 + 9000 + 8000 + 2000


def test_billing_clinician_sees_only_their_caseload(
    api: TestClient, clinician: StaffAccount, practice: dict
) -> None:
    colleague = practice["colleague"]
    report = api.get("/api/reports/income", params=PERIOD, headers=colleague.headers).json()
    assert [row["clinician_name"] for row in report["rows"]] == ["Casey Morgan"]
    aging = api.get("/api/reports/aging", params={"as_of": "2026-04-01"}, headers=colleague.headers)
    assert [row["label"] for row in aging.json()["clients"]] == []


@pytest.mark.parametrize(
    ("role", "access", "allowed"),
    [
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, False),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, False),
        (StaffRole.BILLER, ClinicianAccess.BASIC, True),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, True),
    ],
)
def test_report_access_by_role(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    access: ClinicianAccess,
    allowed: bool,
) -> None:
    member = add_staff(db, clinician.practice_id, "m@example.com", role, clinician_access=access)
    response = api.get("/api/reports/sessions", params=PERIOD, headers=member.headers)
    assert response.status_code == (200 if allowed else 403)


def test_sessions_count_each_client_in_group_sessions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    clients = [create_client_record(db, clinician, email=f"g{i}@example.com") for i in range(3)]
    group = create_appointment(
        db,
        clinician,
        clients,
        starts_at=SESSION_AT,
        fee_cents=6000,
        status=AppointmentStatus.ATTENDED,
        title="DBT skills",
    )
    group.participants[2].attendance = AppointmentStatus.NO_SHOW
    db.commit()
    rows = api.get("/api/reports/sessions", params=PERIOD, headers=clinician.headers).json()
    assert rows == [
        {
            "clinician_id": clinician.id,
            "clinician_name": "Jordan Lee",
            "sessions": 1,
            "attended": 2,
            "no_show": 1,
            "late_canceled": 0,
            "canceled": 0,
            "upcoming": 0,
            "billed_cents": 12000,
        }
    ]


def test_aging_buckets_clients_and_insurers(
    api: TestClient, clinician: StaffAccount, practice: dict, db: Session
) -> None:
    aging = api.get("/api/reports/aging", params={"as_of": "2026-04-01"}, headers=clinician.headers)
    body = aging.json()
    # The report names clients, so the audit event lists them.
    viewed = db.query(AuditEvent).filter_by(action="report.view").one()
    assert viewed.detail is not None and viewed.detail["report"] == "aging"
    assert viewed.client_id == viewed.detail["client_ids"][0]
    assert viewed.detail["client_count"] == 1
    # Mine: 20000 - 10000 paid, issued 2026-01-05 -> 86 days old.
    assert body["clients"] == [
        {
            "label": "Alex Rivera",
            "buckets": {"0-30": 0, "31-60": 0, "61-90": 10000, "90+": 0},
            "total_cents": 10000,
        }
    ]
    # The paid claim is settled; the open one (submitted 2026-01-20) is 71 days old.
    assert body["insurance"] == [
        {
            "label": "Aetna",
            "buckets": {"0-30": 0, "31-60": 0, "61-90": 20000, "90+": 0},
            "total_cents": 20000,
        }
    ]


def test_claims_summary_and_csv(api: TestClient, clinician: StaffAccount, practice: dict) -> None:
    today = datetime.now(UTC).date().isoformat()
    period = {"start": "2026-01-01", "end": today}
    rows = api.get("/api/reports/claims", params=period, headers=clinician.headers).json()
    assert {(r["status"], r["claims"], r["paid_cents"]) for r in rows} == {
        ("paid", 1, 8000),
        ("submitted", 1, 0),
    }
    csv_response = api.get(
        "/api/reports/income", params={**PERIOD, "format": "csv"}, headers=clinician.headers
    )
    assert csv_response.headers["content-type"].startswith("text/csv")
    lines = csv_response.text.strip().splitlines()
    assert lines[0] == "Clinician,Client payments,Insurance payments,Total"
    assert "Casey Morgan,90.00,80.00,170.00" in lines


def test_reports_are_per_practice_and_validate_periods(
    api: TestClient, clinician: StaffAccount, practice: dict
) -> None:
    other = register_practice(api, email="other@example.com")
    report = api.get("/api/reports/income", params=PERIOD, headers=other.headers).json()
    assert report["rows"] == [] and report["total_cents"] == 0
    backwards = api.get(
        "/api/reports/income",
        params={"start": "2026-03-31", "end": "2026-03-01"},
        headers=clinician.headers,
    )
    assert backwards.status_code == 400
