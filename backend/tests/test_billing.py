"""Invoicing, manual payments, allocation, credit, refunds, balances, superbills and PDFs."""

import re
import zlib
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClientContact,
    InsurancePolicy,
    Invoice,
    InvoiceItem,
    Location,
    Payer,
    Payment,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, Role, StaffRole
from synari.realtime import Recipient
from synari.services import billing
from synari.services.billing_jobs import create_daily_invoices
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")


def _settings(db: Session, practice_id: int, **values: Any) -> None:
    settings = db.get_one(PracticeSettings, practice_id)
    for field, value in values.items():
        setattr(settings, field, value)
    db.commit()


def _appointment(
    db: Session,
    clinician: StaffAccount,
    client: Client,
    starts_at: datetime,
    *,
    fee: int = 15000,
    status: str = "attended",
    minutes: int = 50,
    **fields: Any,
) -> Appointment:
    """An individual session: the client is its one billed participant."""
    values: dict[str, Any] = {
        "service_code": "90834",
        "service_description": "Psychotherapy, 45 min",
        **fields,
    }
    return create_appointment(
        db,
        clinician,
        [client],
        starts_at=starts_at,
        minutes=minutes,
        fee_cents=fee,
        status=status,
        **values,
    )


def _pid(appointment: Appointment, index: int = 0) -> int:
    """The participant id of one client in the appointment."""
    return appointment.participants[index].id


def _invoices(db: Session, client_id: int) -> list[Invoice]:
    db.expire_all()
    return list(
        db.scalars(select(Invoice).where(Invoice.client_id == client_id).order_by(Invoice.id))
    )


def _manual_invoice(
    api: TestClient, account: StaffAccount, client_id: int, *amounts: int, **extra: Any
) -> dict:
    body = {
        "client_id": client_id,
        "items": [
            {"service_date": "2026-10-01", "description": f"Session {n}", "amount_cents": amount}
            for n, amount in enumerate(amounts, start=1)
        ],
        "notify": False,
        **extra,
    }
    response = api.post("/api/billing/invoices", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _pay(api: TestClient, account: StaffAccount, client_id: int, amount: int, **extra: Any):
    body = {"client_id": client_id, "amount_cents": amount, "method": "cash", **extra}
    response = api.post("/api/billing/payments", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _summary(api: TestClient, account: StaffAccount, client_id: int) -> dict:
    response = api.get(f"/api/billing/clients/{client_id}/summary", headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _invoice(api: TestClient, account: StaffAccount, invoice_id: int) -> dict:
    return api.get(f"/api/billing/invoices/{invoice_id}", headers=account.headers).json()


def _profile(api: TestClient, account: StaffAccount, **fields: str) -> None:
    response = api.patch("/api/me", json=fields, headers=account.headers)
    assert response.status_code == 200, response.text


def _payer(db: Session, account: StaffAccount, name: str = "Aetna", **fields: Any) -> Payer:
    payer = Payer(practice_id=account.practice_id, name=name, **fields)
    db.add(payer)
    db.commit()
    return payer


def _policy(db: Session, client: Client, payer: Payer, **fields: Any) -> InsurancePolicy:
    policy = InsurancePolicy(client_id=client.id, payer_id=payer.id, member_id="W123", **fields)
    db.add(policy)
    db.commit()
    return policy


def _insured_client(
    db: Session, account: StaffAccount, copay_cents: int | None = 2500, **fields: Any
) -> Client:
    client = create_client_record(db, account, billing_type="insurance", **fields)
    _policy(db, client, _payer(db, account), copay_cents=copay_cents)
    return client


def _by_id(items: list[InvoiceItem]) -> list[InvoiceItem]:
    """Invoice lines in the order they were added (a session and its adjustments share a date)."""
    return sorted(items, key=lambda item: item.id)


def _participant(db: Session, participant_id: int) -> AppointmentParticipant:
    db.expire_all()
    return db.get_one(AppointmentParticipant, participant_id)


def _pdf_text(data: bytes) -> str:
    """Decompressed text of every stream in a PDF, with string escapes undone."""
    parts = []
    for chunk in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            parts.append(zlib.decompress(chunk).decode("latin-1"))
        except zlib.error:
            parts.append(chunk.decode("latin-1"))
    return re.sub(r"\\([()\\])", r"\1", "\n".join(parts))


# Daily invoicing ---------------------------------------------------------------------------


def test_invoicing_follows_the_practices_local_day(api: TestClient, db: Session) -> None:
    account = register_practice(api, email="pat@example.com", time_zone="America/Los_Angeles")
    # The clinician's own calendar zone doesn't matter: billing days are the practice's.
    db.get_one(StaffMember, account.id).time_zone = "America/New_York"
    db.commit()
    _settings(db, account.practice_id, invoice_due_days=14)
    client = create_client_record(db, account)
    # Ends 22:50 in Los Angeles on Oct 5, which is already Oct 6 in New York and UTC.
    late = _appointment(
        db, account, client, datetime(2026, 10, 5, 22, tzinfo=LA), status="scheduled"
    )

    create_daily_invoices(db, datetime(2026, 10, 5, 23, 59, tzinfo=LA))
    db.refresh(late)
    assert late.status == "attended"
    assert _invoices(db, client.id) == []

    create_daily_invoices(db, datetime(2026, 10, 6, 0, 5, tzinfo=LA))
    [invoice] = _invoices(db, client.id)
    assert invoice.number == "INV-000001"
    assert invoice.practice_id == account.practice_id
    assert invoice.bill_to_contact_id is None
    assert (invoice.issued_on, invoice.due_on) == (date(2026, 10, 6), date(2026, 10, 20))
    assert invoice.status == "open"
    assert invoice.total_cents == 15000
    [item] = invoice.items
    assert (item.kind, item.participant_id, item.clinician_id) == (
        "service",
        _pid(late),
        account.id,
    )
    assert item.service_date == date(2026, 10, 5)
    assert (item.service_code, item.description) == ("90834", "Psychotherapy, 45 min")

    [email] = outbound_to(db, "alex@example.com")
    assert email.subject == "New invoice from Lee Counseling"
    assert email.practice_id == account.practice_id
    assert "next=%2Fclient%2Fbilling" in email.body_text
    assert "Psychotherapy" not in email.body_text + (email.body_html or "")


@pytest.mark.parametrize("bill_missed", [True, False])
def test_invoicing_bills_statuses_per_practice_settings(
    api: TestClient, clinician: StaffAccount, db: Session, bill_missed: bool
) -> None:
    _settings(db, clinician.practice_id, bill_missed_appointments=bill_missed)
    client = create_client_record(db, clinician)
    start = datetime(2026, 10, 5, 8, tzinfo=NY)
    statuses = ["attended", "no_show", "late_canceled", "canceled", "scheduled"]
    for hour, status in enumerate(statuses):
        _appointment(db, clinician, client, start + timedelta(hours=hour), status=status)
    _appointment(db, clinician, client, start + timedelta(hours=6), fee=0)
    create_appointment(
        db, clinician, [], starts_at=start + timedelta(hours=7), kind="event", title="Lunch"
    )

    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))

    [invoice] = _invoices(db, client.id)
    descriptions = sorted(item.description for item in invoice.items)
    expected = ["Psychotherapy, 45 min", "Psychotherapy, 45 min"]
    if bill_missed:
        expected += ["Late cancellation fee", "Missed appointment fee"]
    assert descriptions == sorted(expected)
    assert invoice.total_cents == 15000 * len(expected)


def test_invoicing_is_idempotent_and_groups_by_client_and_day(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    _appointment(db, clinician, alex, datetime(2026, 10, 5, 10, tzinfo=NY))
    _appointment(db, clinician, alex, datetime(2026, 10, 5, 14, tzinfo=NY), fee=5000)
    _appointment(db, clinician, alex, datetime(2026, 10, 6, 10, tzinfo=NY))
    _appointment(db, clinician, sam, datetime(2026, 10, 5, 11, tzinfo=NY))

    for hour in (1, 2, 20):
        create_daily_invoices(db, datetime(2026, 10, 7, hour, tzinfo=NY))

    alex_invoices = _invoices(db, alex.id)
    assert [i.total_cents for i in alex_invoices] == [20000, 15000]
    assert [len(i.items) for i in alex_invoices] == [2, 1]
    assert len(_invoices(db, sam.id)) == 1
    numbers = sorted(i.number for i in [*alex_invoices, *_invoices(db, sam.id)])
    assert numbers == ["INV-000001", "INV-000002", "INV-000003"]
    assert len(outbound_to(db, "alex@example.com")) == 1
    assert len(outbound_to(db, "sam@example.com")) == 1


def test_couples_session_invoices_only_the_identified_patient(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    patient = create_client_record(db, clinician)
    partner = create_client_record(db, clinician, first_name="Jamie", email="jamie@example.com")
    couples = _appointment(db, clinician, patient, datetime(2025, 10, 5, 10, tzinfo=NY), fee=18000)
    couples.participants.append(
        AppointmentParticipant(client_id=partner.id, billable=False, fee_cents=0)
    )
    db.commit()

    uninvoiced = api.get("/api/billing/uninvoiced", headers=clinician.headers).json()
    assert [(s["participant_id"], s["client"]["id"]) for s in uninvoiced] == [
        (_pid(couples), patient.id)
    ]
    create_daily_invoices(db, datetime(2025, 10, 6, 1, tzinfo=NY))

    [invoice] = _invoices(db, patient.id)
    [item] = invoice.items
    assert (item.participant_id, item.amount_cents) == (_pid(couples), 18000)
    assert _invoices(db, partner.id) == []
    assert outbound_to(db, "jamie@example.com") == []
    partner_line = {"client_id": partner.id, "participant_ids": [_pid(couples, 1)]}
    refused = api.post("/api/billing/invoices", json=partner_line, headers=clinician.headers)
    assert refused.status_code == 422


def test_group_session_invoices_each_member_separately(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _settings(db, clinician.practice_id, bill_missed_appointments=False)
    members = [
        create_client_record(db, clinician, first_name=name, email=f"{name.lower()}@example.com")
        for name in ("Ana", "Ben", "Cy")
    ]
    group = create_appointment(
        db,
        clinician,
        members,
        starts_at=datetime(2025, 10, 5, 18, tzinfo=NY),
        minutes=90,
        fee_cents=6000,
        status="attended",
        service_code="90853",
        service_description="Group psychotherapy",
    )
    # Cy didn't come; with missed sessions not billed, only Ana and Ben are invoiced.
    group.participants[2].attendance = "no_show"
    db.commit()

    uninvoiced = api.get("/api/billing/uninvoiced", headers=clinician.headers).json()
    assert [(s["client"]["id"], s["amount_cents"], s["status"]) for s in uninvoiced] == [
        (members[0].id, 6000, "attended"),
        (members[1].id, 6000, "attended"),
    ]
    assert uninvoiced[0]["appointment_id"] == group.id
    assert uninvoiced[0]["clinician_name"] == "Jordan Lee"
    create_daily_invoices(db, datetime(2025, 10, 6, 1, tzinfo=NY))

    for index, member in enumerate(members[:2]):
        [invoice] = _invoices(db, member.id)
        [item] = invoice.items
        assert (item.participant_id, item.amount_cents) == (_pid(group, index), 6000)
        assert item.description == "Group psychotherapy"
        assert len(outbound_to(db, member.email or "")) == 1
    assert _invoices(db, members[2].id) == []

    # Billing missed sessions, staff can still invoice Cy's no-show by hand.
    manual = api.post(
        "/api/billing/invoices",
        json={"client_id": members[2].id, "participant_ids": [_pid(group, 2)], "notify": False},
        headers=clinician.headers,
    )
    assert manual.status_code == 201, manual.text
    [line] = manual.json()["items"]
    assert (line["description"], line["amount_cents"]) == ("Missed appointment fee", 6000)
    assert (line["appointment_id"], line["kind"]) == (group.id, "service")


def test_insurance_client_is_invoiced_the_copay(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _insured_client(db, clinician, copay_cents=2500)
    no_copay = _insured_client(
        db, clinician, copay_cents=0, first_name="Sam", email="sam@example.com"
    )
    session = _appointment(db, clinician, client, datetime(2025, 10, 5, 10, tzinfo=NY))
    covered = _appointment(db, clinician, no_copay, datetime(2025, 10, 5, 12, tzinfo=NY))

    uninvoiced = api.get("/api/billing/uninvoiced", headers=clinician.headers).json()
    assert [(s["participant_id"], s["amount_cents"]) for s in uninvoiced] == [(_pid(session), 2500)]
    assert _participant(db, _pid(session)).client_owes_cents is None
    # The session with a $0 copay isn't counted either.
    overview = api.get("/api/billing/overview", headers=clinician.headers).json()
    assert overview["uninvoiced_count"] == 1
    create_daily_invoices(db, datetime(2025, 10, 6, 1, tzinfo=NY))

    [invoice] = _invoices(db, client.id)
    assert [(i.participant_id, i.amount_cents) for i in invoice.items] == [(_pid(session), 2500)]
    # The copay is recorded, so a later change to the policy doesn't change this session.
    assert _participant(db, _pid(session)).client_owes_cents == 2500
    # A $0 copay leaves nothing to invoice.
    assert _invoices(db, no_copay.id) == []
    assert _participant(db, _pid(covered)).client_owes_cents == 0
    overview = api.get("/api/billing/overview", headers=clinician.headers).json()
    assert overview["uninvoiced_count"] == 0


def test_one_invoice_holds_lines_from_several_clinicians(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    riley = add_staff(
        db,
        clinician.practice_id,
        "riley@example.com",
        StaffRole.CLINICIAN,
        first_name="Riley",
        last_name="Chen",
    )
    db.get_one(StaffMember, riley.id).credentials = "LMFT"
    db.commit()
    client = create_client_record(db, clinician)
    assign_clinician(db, client, riley)
    individual = _appointment(db, clinician, client, datetime(2026, 10, 5, 10, tzinfo=NY))
    couples = _appointment(
        db, riley, client, datetime(2026, 10, 5, 15, tzinfo=NY), fee=18000, service_code="90847"
    )

    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))

    def by_line(items: list[dict]) -> dict[int | None, tuple[Any, ...]]:
        return {
            i["participant_id"]: (
                i["kind"],
                i["appointment_id"],
                i["clinician_id"],
                i["clinician_name"],
            )
            for i in items
        }

    expected: dict[int | None, tuple[Any, ...]] = {
        _pid(individual): ("service", individual.id, clinician.id, "Jordan Lee"),
        _pid(couples): ("service", couples.id, riley.id, "Riley Chen, LMFT"),
    }
    [stored] = _invoices(db, client.id)
    invoice = _invoice(api, clinician, stored.id)
    assert invoice["total_cents"] == 33000
    assert (invoice["bill_to_contact_id"], invoice["bill_to_name"]) == (None, "")
    assert by_line(invoice["items"]) == expected
    [listed] = api.get("/api/billing/invoices", headers=clinician.headers).json()
    assert by_line(listed["items"]) == expected
    [portal] = api.get("/api/portal/billing/invoices", headers=portal_headers(client)).json()
    assert by_line(portal["items"]) == expected
    pdf = api.get(f"/api/billing/invoices/{stored.id}/pdf", headers=clinician.headers)
    assert pdf.status_code == 200
    assert "Riley Chen, LMFT" in _pdf_text(pdf.content)

    # The line keeps the clinician recorded when it was created.
    db.get_one(Appointment, couples.id).clinician_id = clinician.id
    db.commit()
    assert by_line(_invoice(api, clinician, stored.id)["items"]) == expected

    # Manual invoices can mix clinicians' sessions and custom lines too.
    api.post(f"/api/billing/invoices/{stored.id}/void", headers=clinician.headers)
    manual = api.post(
        "/api/billing/invoices",
        json={
            "client_id": client.id,
            "participant_ids": [_pid(individual)],
            "items": [{"service_date": "2026-10-06", "description": "Letter", "amount_cents": 500}],
            "notify": False,
        },
        headers=clinician.headers,
    )
    assert manual.status_code == 201, manual.text
    assert by_line(manual.json()["items"]) == {
        _pid(individual): expected[_pid(individual)],
        None: ("custom", None, None, ""),
    }


def test_invoice_email_respects_portal_billing(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, portal_billing=False)
    _appointment(db, clinician, client, datetime(2026, 10, 5, 10, tzinfo=NY))
    create_daily_invoices(db, datetime(2026, 10, 6, 9, tzinfo=NY))
    assert len(_invoices(db, client.id)) == 1
    assert outbound_to(db, "alex@example.com") == []


def test_invoicing_skips_practices_without_an_active_owner(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _appointment(
        db, clinician, client, datetime(2026, 10, 5, 10, tzinfo=NY), status="scheduled"
    )
    db.get_one(StaffMember, clinician.id).status = "deactivated"
    db.commit()
    create_daily_invoices(db, datetime(2026, 10, 6, 9, tzinfo=NY))
    db.refresh(appointment)
    assert appointment.status == "scheduled"
    assert _invoices(db, client.id) == []


def test_voided_invoices_free_sessions_for_manual_invoicing_only(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    appointment = _appointment(db, clinician, client, datetime(2025, 3, 3, 10, tzinfo=NY))
    create_daily_invoices(db, datetime(2025, 3, 4, 1, tzinfo=NY))
    [invoice] = _invoices(db, client.id)

    voided = api.post(f"/api/billing/invoices/{invoice.id}/void", headers=clinician.headers)
    assert voided.status_code == 200
    assert voided.json()["status"] == "void"
    assert voided.json()["balance_cents"] == 0
    again = api.post(f"/api/billing/invoices/{invoice.id}/void", headers=clinician.headers)
    assert again.status_code == 409

    create_daily_invoices(db, datetime(2025, 3, 6, 1, tzinfo=NY))
    assert len(_invoices(db, client.id)) == 1
    overview = api.get("/api/billing/overview", headers=clinician.headers).json()
    assert overview["uninvoiced_count"] == 1
    uninvoiced = api.get(
        "/api/billing/uninvoiced", params={"client_id": client.id}, headers=clinician.headers
    ).json()
    assert [s["participant_id"] for s in uninvoiced] == [_pid(appointment)]

    body = {"client_id": client.id, "participant_ids": [_pid(appointment)], "notify": False}
    reissued = api.post("/api/billing/invoices", json=body, headers=clinician.headers)
    assert reissued.status_code == 201
    assert reissued.json()["number"] == "INV-000002"
    duplicate = api.post("/api/billing/invoices", json=body, headers=clinician.headers)
    assert duplicate.status_code == 409


def test_void_is_blocked_once_payments_are_applied(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    invoice = _manual_invoice(api, clinician, client.id, 10000)
    _pay(api, clinician, client.id, 2500)
    blocked = api.post(f"/api/billing/invoices/{invoice['id']}/void", headers=clinician.headers)
    assert blocked.status_code == 409
    assert "Refund" in blocked.json()["detail"]


def test_new_invoices_use_existing_credit(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    prepaid = _pay(api, clinician, client.id, 20000, reference="Check #1041")
    assert prepaid["status"] == "succeeded"
    assert prepaid["unapplied_cents"] == 20000
    assert _summary(api, clinician, client.id)["credit_cents"] == 20000

    _appointment(db, clinician, client, datetime(2026, 10, 5, 10, tzinfo=NY))
    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))

    [invoice] = _invoices(db, client.id)
    assert (invoice.status, invoice.paid_cents) == ("paid", 15000)
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (0, 5000)
    assert summary["open_invoices"] == []


def test_invoice_and_superbill_numbers_are_per_practice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    other = register_practice(api, email="other@example.com")
    for account in (clinician, other):
        client = create_client_record(db, account, email=f"client-{account.id}@example.com")
        assert _manual_invoice(api, account, client.id, 1000)["number"] == "INV-000001"
        _appointment(db, account, client, datetime(2026, 10, 2, 10, tzinfo=NY))
        superbill = api.post(
            "/api/billing/superbills",
            json={"client_id": client.id, "period_start": "2026-10-01", "period_end": "2026-10-31"},
            headers=account.headers,
        )
        assert superbill.json()["number"] == "SB-000001"
    second = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    assert _manual_invoice(api, clinician, second.id, 1000)["number"] == "INV-000002"
    counters = db.get_one(PracticeSettings, other.practice_id)
    db.refresh(counters)
    assert (counters.invoice_counter, counters.superbill_counter) == (1, 1)


# Bill-to contacts --------------------------------------------------------------------------


def _billing_contact(db: Session, client: Client, **fields: Any) -> ClientContact:
    values: dict[str, Any] = {
        "first_name": "Maria",
        "last_name": "Rivera",
        "relation": "Mother",
        "email": "maria@example.com",
        "is_guardian": True,
        "responsible_for_billing": True,
        "portal_access": True,
        **fields,
    }
    contact = ClientContact(client_id=client.id, **values)
    db.add(contact)
    db.commit()
    return contact


def test_a_minors_invoices_go_to_their_billing_contact(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, is_minor=True, address_line1="9 Elm St")
    _billing_contact(db, client, first_name="Pat", last_name="Doe", responsible_for_billing=False)
    contact = _billing_contact(db, client)
    _appointment(db, clinician, client, datetime(2026, 10, 5, 10, tzinfo=NY))

    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))

    [invoice] = _invoices(db, client.id)
    assert invoice.bill_to_contact_id == contact.id
    fetched = _invoice(api, clinician, invoice.id)
    assert (fetched["bill_to_contact_id"], fetched["bill_to_name"]) == (contact.id, "Maria Rivera")
    pdf = api.get(f"/api/billing/invoices/{invoice.id}/pdf", headers=clinician.headers)
    text = _pdf_text(pdf.content)
    assert "Bill to" in text
    assert "Maria Rivera" in text
    assert "For: Alex Rivera" in text
    assert "Pat Doe" not in text

    [email] = outbound_to(db, "maria@example.com")
    assert email.subject == "New invoice from Lee Counseling"
    assert "/client/sign-in?next=%2Fclient%2Fbilling" in email.body_text
    assert "token=" not in email.body_text
    assert "Psychotherapy" not in email.body_text + (email.body_html or "")
    # Minors don't get billing emails themselves.
    assert outbound_to(db, "alex@example.com") == []

    _pay(api, clinician, client.id, 15000)
    receipts = outbound_to(db, "maria@example.com")
    assert [e.subject for e in receipts] == [email.subject, "We received your payment"]
    assert outbound_to(db, "alex@example.com") == []


def test_an_adults_billing_contact_and_the_client_both_get_billing_emails(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    _billing_contact(db, client, first_name="Robin", relation="Partner", portal_access=False)

    invoice = _manual_invoice(api, clinician, client.id, 9000, notify=True)

    assert invoice["bill_to_name"] == "Robin Rivera"
    [to_client] = outbound_to(db, "alex@example.com")
    assert "token=" in to_client.body_text
    # Without portal access the contact is told to ask the practice instead of signing in.
    [to_contact] = outbound_to(db, "maria@example.com")
    assert to_contact.subject == to_client.subject
    assert "Contact Lee Counseling for a copy." in to_contact.body_text
    assert "sign-in" not in to_contact.body_text


# What clients owe for a session ------------------------------------------------------------


SESSION_DAY = datetime(2026, 10, 5, 10, tzinfo=NY)


@pytest.mark.parametrize(
    ("billing_type", "policy", "recorded", "expected", "persisted"),
    [
        ("self_pay", None, None, 15000, None),
        ("self_pay", {"copay_cents": 2500}, None, 15000, None),
        ("insurance", None, None, 15000, None),
        ("insurance", {"copay_cents": 2500}, None, 2500, 2500),
        ("insurance", {"copay_cents": 0}, None, 0, 0),
        ("insurance", {"copay_cents": None}, None, 15000, None),
        ("insurance", {"copay_cents": 2500, "rank": "secondary"}, None, 15000, None),
        (
            "insurance",
            {"copay_cents": 2500, "termination_date": date(2026, 10, 4)},
            None,
            15000,
            None,
        ),
        (
            "insurance",
            {"copay_cents": 2500, "effective_date": date(2026, 10, 6)},
            None,
            15000,
            None,
        ),
        (
            "insurance",
            {
                "copay_cents": 2500,
                "effective_date": date(2026, 10, 5),
                "termination_date": date(2026, 10, 5),
            },
            None,
            2500,
            2500,
        ),
        ("insurance", {"copay_cents": 2500}, 4000, 4000, 4000),
        ("self_pay", None, 0, 0, 0),
    ],
)
def test_invoice_amount_for(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    billing_type: str,
    policy: dict[str, Any] | None,
    recorded: int | None,
    expected: int,
    persisted: int | None,
) -> None:
    client = create_client_record(db, clinician, billing_type=billing_type)
    if policy is not None:
        _policy(db, client, _payer(db, clinician), **policy)
    session = _appointment(db, clinician, client, SESSION_DAY)
    participant = session.participants[0]
    participant.client_owes_cents = recorded
    db.commit()

    assert billing.client_share_cents(db, participant) == expected
    assert billing.invoice_amount_for(db, participant) == expected
    db.commit()
    assert _participant(db, participant.id).client_owes_cents == persisted


@pytest.mark.parametrize("status", ["no_show", "late_canceled"])
def test_missed_sessions_bill_the_fee_not_the_copay(
    api: TestClient, clinician: StaffAccount, db: Session, status: str
) -> None:
    # Insurance doesn't pay for missed sessions, so the client owes the missed-session fee.
    client = create_client_record(db, clinician, billing_type="insurance")
    _policy(db, client, _payer(db, clinician), copay_cents=2500)
    participant = _appointment(db, clinician, client, SESSION_DAY, status=status).participants[0]

    assert billing.invoice_amount_for(db, participant) == 15000


def _invoiced_session(
    api: TestClient, account: StaffAccount, db: Session, client: Client, **fields: Any
) -> tuple[AppointmentParticipant, Invoice]:
    """A session of the client invoiced overnight, with the invoice holding it."""
    session = _appointment(db, account, client, SESSION_DAY, **fields)
    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))
    invoice = next(
        i
        for i in _invoices(db, client.id)
        if any(item.participant_id == _pid(session) for item in i.items)
    )
    return _participant(db, _pid(session)), invoice


def _record(db: Session, participant: AppointmentParticipant, amount_cents: int) -> None:
    billing.record_patient_responsibility(
        db, participant, amount_cents, description="Insurance adjustment"
    )
    db.commit()


def test_patient_responsibility_before_invoicing_is_what_gets_billed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _insured_client(db, clinician, copay_cents=2500)
    session = _appointment(db, clinician, client, SESSION_DAY)

    _record(db, session.participants[0], 3100)

    assert _participant(db, _pid(session)).client_owes_cents == 3100
    assert _invoices(db, client.id) == []
    create_daily_invoices(db, datetime(2026, 10, 6, 1, tzinfo=NY))
    [invoice] = _invoices(db, client.id)
    assert [(i.kind, i.amount_cents) for i in invoice.items] == [("service", 3100)]


def test_patient_responsibility_above_what_was_billed_goes_on_a_new_invoice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _insured_client(db, clinician, copay_cents=2500)
    participant, original = _invoiced_session(api, clinician, db, client)

    _record(db, participant, 4000)

    first, extra = _invoices(db, client.id)
    assert first.id == original.id
    assert (first.total_cents, len(first.items)) == (2500, 1)
    assert (extra.number, extra.status, extra.total_cents) == ("INV-000002", "open", 1500)
    [adjustment] = extra.items
    assert (adjustment.kind, adjustment.participant_id) == ("adjustment", participant.id)
    assert (adjustment.clinician_id, adjustment.service_date) == (clinician.id, date(2026, 10, 5))
    assert (adjustment.description, adjustment.amount_cents) == ("Insurance adjustment", 1500)
    assert _participant(db, participant.id).client_owes_cents == 4000
    assert [e.subject for e in outbound_to(db, "alex@example.com")] == [
        "New invoice from Lee Counseling"
    ] * 2
    # Hearing the same amount again changes nothing.
    _record(db, _participant(db, participant.id), 4000)
    assert len(_invoices(db, client.id)) == 2
    assert _summary(api, clinician, client.id)["balance_cents"] == 4000


def test_patient_responsibility_below_what_was_billed_reduces_the_original_invoice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, billing_type="insurance")
    participant, original = _invoiced_session(api, clinician, db, client)
    assert original.total_cents == 15000

    _record(db, participant, 4000)

    [invoice] = _invoices(db, client.id)
    assert (invoice.status, invoice.total_cents, invoice.paid_cents) == ("open", 4000, 0)
    assert [(i.kind, i.amount_cents) for i in _by_id(invoice.items)] == [
        ("service", 15000),
        ("adjustment", -11000),
    ]
    api_items = _invoice(api, clinician, invoice.id)["items"]
    assert api_items[1]["appointment_id"] == api_items[0]["appointment_id"]
    assert _summary(api, clinician, client.id)["balance_cents"] == 4000


def test_a_paid_invoice_that_becomes_overpaid_yields_credit(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, billing_type="insurance")
    participant, original = _invoiced_session(api, clinician, db, client)
    first = _pay(api, clinician, client.id, 10000, send_receipt=False)
    second = _pay(api, clinician, client.id, 5000, send_receipt=False)
    assert _invoice(api, clinician, original.id)["status"] == "paid"

    _record(db, participant, 3000)

    invoice = _invoice(api, clinician, original.id)
    assert (invoice["status"], invoice["total_cents"], invoice["paid_cents"]) == (
        "paid",
        3000,
        3000,
    )
    # The newest payment's allocation is released first.
    payments = {p["id"]: p for p in _summary(api, clinician, client.id)["recent_payments"]}
    assert payments[second["id"]]["allocations"] == []
    assert payments[second["id"]]["unapplied_cents"] == 5000
    assert payments[first["id"]]["allocations"] == [
        {"invoice_id": original.id, "amount_cents": 3000}
    ]
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (0, 12000)

    # The credit pays the client's next invoice.
    later = _manual_invoice(api, clinician, client.id, 2000)
    assert later["status"] == "paid"
    assert _summary(api, clinician, client.id)["credit_cents"] == 10000


def test_released_credit_pays_other_open_invoices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, billing_type="insurance")
    participant, original = _invoiced_session(api, clinician, db, client)
    _pay(api, clinician, client.id, 15000, send_receipt=False)
    other = _manual_invoice(api, clinician, client.id, 7000)

    _record(db, participant, 5000)

    assert _invoice(api, clinician, original.id)["paid_cents"] == 5000
    assert _invoice(api, clinician, other["id"])["status"] == "paid"
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (0, 3000)


def test_a_later_decrease_also_reverses_earlier_adjustment_invoices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _insured_client(db, clinician, copay_cents=2500)
    participant, original = _invoiced_session(api, clinician, db, client)
    _record(db, participant, 4000)

    _record(db, _participant(db, participant.id), 1000)

    first, extra = _invoices(db, client.id)
    assert first.id == original.id
    assert [(i.kind, i.amount_cents) for i in _by_id(first.items)] == [
        ("service", 2500),
        ("adjustment", -2500),
    ]
    assert (first.total_cents, first.status) == (0, "paid")
    assert [i.amount_cents for i in _by_id(extra.items)] == [1500, -500]
    assert (extra.total_cents, extra.status) == (1000, "open")
    assert _summary(api, clinician, client.id)["balance_cents"] == 1000


def test_voided_invoices_dont_count_as_billed(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _insured_client(db, clinician, copay_cents=2500)
    participant, original = _invoiced_session(api, clinician, db, client)
    api.post(f"/api/billing/invoices/{original.id}/void", headers=clinician.headers)

    _record(db, participant, 4000)

    assert len(_invoices(db, client.id)) == 1
    assert _participant(db, participant.id).client_owes_cents == 4000


# Manual invoices ---------------------------------------------------------------------------


def test_manual_invoice_validation(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    other_client = create_client_record(db, clinician, first_name="Sam", email="sam@x.com")
    past = datetime(2026, 9, 1, 10, tzinfo=NY)
    mine = _appointment(db, clinician, client, past)
    theirs = _appointment(db, clinician, other_client, past + timedelta(hours=2))
    upcoming = _appointment(db, clinician, client, utcnow() + timedelta(days=3), status="scheduled")
    free = _appointment(db, clinician, client, past + timedelta(hours=4), fee=0)
    excused = _appointment(db, clinician, client, past + timedelta(hours=6))
    excused.participants[0].attendance = "canceled"
    db.commit()
    stranger = register_practice(api, email="other@example.com")
    foreign_client = create_client_record(db, stranger, email="f@example.com")
    foreign = _appointment(db, stranger, foreign_client, past)

    def create(**body: Any) -> Any:
        return api.post(
            "/api/billing/invoices",
            json={"client_id": client.id, **body},
            headers=clinician.headers,
        )

    assert create().status_code == 422
    assert create(participant_ids=[_pid(theirs)]).status_code == 422
    assert create(participant_ids=[_pid(upcoming)]).status_code == 422
    assert create(participant_ids=[_pid(free)]).status_code == 422
    assert create(participant_ids=[_pid(excused)]).status_code == 422
    assert create(participant_ids=[_pid(mine), _pid(mine)]).status_code == 422
    assert create(participant_ids=[_pid(foreign)]).status_code == 404
    assert create(participant_ids=[999_999]).status_code == 404
    line = {"service_date": "2026-09-02", "description": "Report", "amount_cents": 4000}
    foreign_body = {"client_id": foreign_client.id, "items": [line]}
    assert (
        api.post("/api/billing/invoices", json=foreign_body, headers=clinician.headers).status_code
        == 404
    )

    created = create(
        participant_ids=[_pid(mine)],
        items=[{"service_date": "2026-09-02", "description": "Report", "amount_cents": 4000}],
        notes="Thank you!",
    )
    assert created.status_code == 201, created.text
    invoice = created.json()
    assert invoice["total_cents"] == 19000
    assert invoice["balance_cents"] == 19000
    assert invoice["client"]["id"] == client.id
    assert [(i["kind"], i["description"]) for i in invoice["items"]] == [
        ("service", "Psychotherapy, 45 min"),
        ("custom", "Report"),
    ]
    assert invoice["notes"] == "Thank you!"
    [email] = outbound_to(db, "alex@example.com")
    assert email.subject.startswith("New invoice")


# Payments, allocation, credit and refunds --------------------------------------------------


def test_payments_apply_to_chosen_invoice_then_oldest(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    first = _manual_invoice(api, clinician, client.id, 10000)
    second = _manual_invoice(api, clinician, client.id, 8000)
    third = _manual_invoice(api, clinician, client.id, 6000)

    partial = _pay(api, clinician, client.id, 5000)
    assert partial["allocations"] == [{"invoice_id": first["id"], "amount_cents": 5000}]
    first_now = _invoice(api, clinician, first["id"])
    assert (first_now["status"], first_now["balance_cents"]) == ("open", 5000)

    big = _pay(api, clinician, client.id, 20000, invoice_id=third["id"])
    assert big["allocations"] == [
        {"invoice_id": third["id"], "amount_cents": 6000},
        {"invoice_id": first["id"], "amount_cents": 5000},
        {"invoice_id": second["id"], "amount_cents": 8000},
    ]
    assert big["unapplied_cents"] == 1000
    assert all(
        _invoice(api, clinician, i["id"])["status"] == "paid" for i in (first, second, third)
    )
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (0, 1000)
    assert [p["id"] for p in summary["recent_payments"]] == [big["id"], partial["id"]]
    assert db.get_one(Payment, big["id"]).practice_id == clinician.practice_id

    other = create_client_record(db, clinician, first_name="Sam", email="sam@x.com")
    wrong_invoice = api.post(
        "/api/billing/payments",
        json={
            "client_id": other.id,
            "amount_cents": 100,
            "method": "cash",
            "invoice_id": first["id"],
        },
        headers=clinician.headers,
    )
    assert wrong_invoice.status_code == 422
    card = api.post(
        "/api/billing/payments",
        json={"client_id": client.id, "amount_cents": 100, "method": "card"},
        headers=clinician.headers,
    )
    assert card.status_code == 422


def test_refunds_take_credit_first_then_reopen_newest_invoices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    older = _manual_invoice(api, clinician, client.id, 10000)
    newer = _manual_invoice(api, clinician, client.id, 8000)
    main = _pay(api, clinician, client.id, 20000, send_receipt=False)
    spare = _pay(api, clinician, client.id, 3000, send_receipt=False)
    assert _summary(api, clinician, client.id)["credit_cents"] == 5000

    refund = f"/api/billing/payments/{main['id']}/refund"
    first = api.post(refund, json={"amount_cents": 3000}, headers=clinician.headers)
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["status"], body["refunded_cents"], body["refundable_cents"]) == (
        "partially_refunded",
        3000,
        17000,
    )
    # 2000 came out of credit, 1000 out of the newer invoice, which the spare credit then paid.
    assert body["allocations"] == [
        {"invoice_id": older["id"], "amount_cents": 10000},
        {"invoice_id": newer["id"], "amount_cents": 7000},
    ]
    assert _invoice(api, clinician, newer["id"])["status"] == "paid"
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (0, 2000)

    too_much = api.post(refund, json={"amount_cents": 17001}, headers=clinician.headers)
    assert too_much.status_code == 422
    assert "$170.00" in too_much.json()["detail"]

    rest = api.post(refund, json={"amount_cents": 17000}, headers=clinician.headers).json()
    assert (rest["status"], rest["allocations"], rest["refundable_cents"]) == ("refunded", [], 0)
    older_now = _invoice(api, clinician, older["id"])
    newer_now = _invoice(api, clinician, newer["id"])
    assert (older_now["status"], older_now["paid_cents"]) == ("open", 2000)
    assert (newer_now["status"], newer_now["paid_cents"]) == ("open", 1000)
    summary = _summary(api, clinician, client.id)
    assert (summary["balance_cents"], summary["credit_cents"]) == (15000, 0)
    spare_now = next(p for p in summary["recent_payments"] if p["id"] == spare["id"])
    assert spare_now["unapplied_cents"] == 0

    again = api.post(refund, json={"amount_cents": 100}, headers=clinician.headers)
    assert again.status_code == 409


def test_overview_totals(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    _manual_invoice(api, clinician, client.id, 10000)
    _manual_invoice(api, clinician, client.id, 4000)
    now = utcnow()
    paid = _pay(api, clinician, client.id, 3000, received_at=now.isoformat())
    _pay(api, clinician, client.id, 500, received_at=(now - timedelta(days=45)).isoformat())
    api.post(
        f"/api/billing/payments/{paid['id']}/refund",
        json={"amount_cents": 1000},
        headers=clinician.headers,
    )
    past = now - timedelta(days=2)
    _appointment(db, clinician, client, past)
    _appointment(db, clinician, client, past + timedelta(hours=2), status="no_show")
    _appointment(db, clinician, client, past + timedelta(hours=4), status="canceled")
    _appointment(db, clinician, client, now + timedelta(days=2), status="scheduled")

    overview = api.get("/api/billing/overview", headers=clinician.headers).json()
    # 14000 invoiced - 3500 paid + 1000 refunded back onto the open invoice.
    assert overview == {
        "outstanding_cents": 11500,
        "collected_this_month_cents": 2000,
        "open_invoice_count": 2,
        "uninvoiced_count": 2,
    }


def test_billing_lists_are_paged(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    ana, ben = (
        create_client_record(db, clinician, first_name=name, email=f"{name.lower()}@example.com")
        for name in ("Ana", "Ben")
    )
    first = _manual_invoice(api, clinician, ana.id, 1000)
    second = _manual_invoice(api, clinician, ben.id, 2000)
    paid = [_pay(api, clinician, client.id, 500) for client in (ana, ben)]
    past = utcnow() - timedelta(days=2)
    sessions = [
        _appointment(db, clinician, client, past + timedelta(hours=hours))
        for hours, client in ((0, ben), (2, ana), (4, ben))
    ]

    def page(path: str, **params: int) -> tuple[list[int], str]:
        response = api.get(path, params=params, headers=clinician.headers)
        assert response.status_code == 200, response.text
        key = "participant_id" if path.endswith("uninvoiced") else "id"
        return [row[key] for row in response.json()], response.headers["x-total-count"]

    assert page("/api/billing/invoices", limit=1) == ([second["id"]], "2")
    assert page("/api/billing/invoices", limit=1, offset=1) == ([first["id"]], "2")
    assert page("/api/billing/payments", limit=1, offset=1) == ([paid[0]["id"]], "2")
    assert page("/api/billing/payments", invoice_id=second["id"]) == ([paid[1]["id"]], "1")
    # By client name (Ana, then Ben), then oldest session first.
    expected = [_pid(sessions[1]), _pid(sessions[0]), _pid(sessions[2])]
    assert page("/api/billing/uninvoiced") == (expected, "3")
    assert page("/api/billing/uninvoiced", limit=2, offset=1) == (expected[1:], "3")
    assert page("/api/billing/superbills") == ([], "0")
    too_many = api.get("/api/billing/invoices", params={"limit": 201}, headers=clinician.headers)
    assert too_many.status_code == 422


def test_billing_changes_are_pushed_to_staff(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        assert websocket.receive_json() == {"type": "ready"}
        _pay(api, clinician, client.id, 1000)
        assert websocket.receive_json() == {
            "type": "billing.changed",
            "data": {"client_id": client.id},
        }


def test_billing_events_go_only_to_staff_who_see_the_clients_billing(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    practice_id = clinician.practice_id
    biller = add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, practice_id, "scheduler@example.com", StaffRole.SCHEDULER)
    basic = add_staff(db, practice_id, "basic@example.com", StaffRole.CLINICIAN)
    with_billing = add_staff(
        db,
        practice_id,
        "billing@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
    )
    elsewhere = add_staff(
        db,
        practice_id,
        "elsewhere@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
    )
    client = create_client_record(db, clinician)
    assign_clinician(db, client, basic)
    assign_clinician(db, client, with_billing)
    events: list[tuple[list[Recipient], str, dict[str, Any]]] = []
    monkeypatch.setattr(
        billing,
        "publish",
        lambda _db, recipients, event_type, data: events.append(
            (list(recipients), event_type, data)
        ),
    )

    _pay(api, biller, client.id, 1000)

    [(recipients, event_type, data)] = events
    assert (event_type, data) == ("billing.changed", {"client_id": client.id})
    assert sorted(recipients) == sorted(
        [
            (Role.STAFF, clinician.id),
            (Role.STAFF, biller.id),
            (Role.STAFF, with_billing.id),
            (Role.CLIENT, client.id),
        ]
    )
    assert (Role.STAFF, scheduler.id) not in recipients
    assert (Role.STAFF, basic.id) not in recipients
    assert (Role.STAFF, elsewhere.id) not in recipients


# Superbills and PDFs -----------------------------------------------------------------------


def test_superbill_snapshot_and_pdf(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    practice = api.patch(
        "/api/practice",
        json={
            "tax_id": "12-3456789",
            "npi": "1999999984",
            "taxonomy_code": "261QM0801X",
            "billing_provider": "organization",
            "phone": "555-100-2000",
            "address_line1": "1 Main St",
            "city": "Albany",
            "state": "NY",
            "postal_code": "12207",
        },
        headers=clinician.headers,
    )
    assert practice.status_code == 200, practice.text
    _profile(
        api,
        clinician,
        credentials="LCSW",
        npi="1234567890",
        taxonomy_code="1041C0700X",
        license_number="LCSW-998",
        license_state="NY",
    )
    client = create_client_record(
        db,
        clinician,
        first_name="José",
        last_name="Núñez—Smith 中",
        date_of_birth=date(1990, 4, 2),
        address_line1="9 Elm St",
        city="Troy",
        state="NY",
        postal_code="12180",
        diagnosis_codes=[{"code": "F41.1", "description": "Generalized anxiety disorder"}],
    )
    payer = _payer(db, clinician, name="Aetna “Choice”", external_id="60054")
    # A policy that ended before the period doesn't count.
    _policy(db, client, _payer(db, clinician, name="Old Co"), termination_date=date(2025, 9, 1))
    _policy(
        db,
        client,
        payer,
        group_number="G9",
        plan_name="Open Access",
        subscriber_relationship="19",
        subscriber_first_name="María",
        subscriber_last_name="Núñez",
        subscriber_dob=date(1962, 1, 5),
    )
    video_office = db.scalars(
        select(Location).where(
            Location.practice_id == clinician.practice_id, Location.is_video.is_(True)
        )
    ).one()
    _appointment(db, clinician, client, datetime(2025, 10, 2, 10, tzinfo=NY))
    _appointment(db, clinician, client, datetime(2025, 10, 9, 10, tzinfo=NY), location_type="video")
    _appointment(
        db, clinician, client, datetime(2025, 10, 16, 10, tzinfo=NY), location_type="phone"
    )
    _appointment(
        db,
        clinician,
        client,
        datetime(2025, 10, 23, 10, tzinfo=NY),
        location_type="video",
        location_id=video_office.id,
    )
    # 11pm on the last day is still inside the period locally (it's November in UTC).
    _appointment(db, clinician, client, datetime(2025, 10, 31, 23, tzinfo=NY), minutes=45)
    _appointment(db, clinician, client, datetime(2025, 10, 20, 10, tzinfo=NY), status="no_show")
    _appointment(db, clinician, client, datetime(2025, 10, 21, 10, tzinfo=NY), fee=0)
    _appointment(db, clinician, client, datetime(2025, 11, 1, 0, 30, tzinfo=NY))
    # A session the session status says was attended but this client missed.
    missed = _appointment(db, clinician, client, datetime(2025, 10, 22, 10, tzinfo=NY))
    missed.participants[0].attendance = "no_show"
    # A couples session where the client came along but wasn't the one billed.
    partner = create_client_record(db, clinician, first_name="Kim", email="kim@example.com")
    couples = _appointment(db, clinician, partner, datetime(2025, 10, 24, 10, tzinfo=NY))
    couples.participants.append(
        AppointmentParticipant(client_id=client.id, billable=False, fee_cents=0)
    )
    db.commit()
    cid = client.id
    _pay(api, clinician, cid, 5000, received_at=datetime(2025, 10, 3, 9, tzinfo=NY).isoformat())
    _pay(api, clinician, cid, 7000, received_at=datetime(2025, 11, 3, 9, tzinfo=NY).isoformat())

    period = {"client_id": cid, "period_start": "2025-10-01", "period_end": "2025-10-31"}
    response = api.post("/api/billing/superbills", json=period, headers=clinician.headers)
    assert response.status_code == 201, response.text
    superbill = response.json()
    assert superbill["number"] == "SB-000001"
    assert (superbill["total_cents"], superbill["paid_cents"]) == (75000, 5000)
    data = superbill["data"]
    assert data["practice"] == {
        "name": "Lee Counseling",
        "address_lines": ["1 Main St", "Albany, NY 12207"],
        "phone": "555-100-2000",
        "tax_id": "12-3456789",
        "tax_id_type": "EIN",
        "npi": "1999999984",
        "taxonomy_code": "261QM0801X",
        "billing_provider": "organization",
    }
    provider = {
        "name": "Jordan Lee",
        "credentials": "LCSW",
        "npi": "1234567890",
        "taxonomy_code": "1041C0700X",
        "license": "LCSW-998 (NY)",
    }
    assert data["provider"] == provider
    assert data["client"]["date_of_birth"] == "1990-04-02"
    assert data["insurance"] == {
        "payer_name": "Aetna “Choice”",
        "payer_id": "60054",
        "member_id": "W123",
        "group_number": "G9",
        "plan_name": "Open Access",
        "subscriber_name": "María Núñez",
        "subscriber_relationship": "Child",
        "subscriber_dob": "1962-01-05",
    }
    assert data["diagnosis_codes"] == [
        {"code": "F41.1", "description": "Generalized anxiety disorder"}
    ]
    assert [(line["date"], line["place_of_service"]) for line in data["lines"]] == [
        ("2025-10-02", "11"),
        ("2025-10-09", "02"),
        ("2025-10-16", "02"),
        ("2025-10-23", "10"),
        ("2025-10-31", "11"),
    ]
    assert data["lines"][0] == {
        "date": "2025-10-02",
        "cpt": "90834",
        "description": "Psychotherapy, 45 min",
        "place_of_service": "11",
        "units": 1,
        "fee_cents": 15000,
        "provider": provider,
    }
    assert data["payments"] == [{"date": "2025-10-03", "method": "Cash", "amount_cents": 5000}]

    second = api.post("/api/billing/superbills", json=period, headers=clinician.headers)
    assert second.json()["number"] == "SB-000002"
    empty = {"client_id": cid, "period_start": "2025-12-01", "period_end": "2025-12-31"}
    assert (
        api.post("/api/billing/superbills", json=empty, headers=clinician.headers).status_code
        == 422
    )
    backwards = {"client_id": cid, "period_start": "2025-10-31", "period_end": "2025-10-01"}
    assert (
        api.post("/api/billing/superbills", json=backwards, headers=clinician.headers).status_code
        == 422
    )

    listed = api.get(
        "/api/billing/superbills", params={"client_id": cid}, headers=clinician.headers
    ).json()
    assert len(listed) == 2
    fetched = api.get(f"/api/billing/superbills/{superbill['id']}", headers=clinician.headers)
    assert fetched.json()["data"] == data
    pdf = api.get(f"/api/billing/superbills/{superbill['id']}/pdf", headers=clinician.headers)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"] == 'attachment; filename="SB-000001.pdf"'
    text = _pdf_text(pdf.content)
    assert "Policyholder: María Núñez" in text
    assert "Client's relationship to policyholder: Child" in text


def test_superbill_insurance_for_a_self_subscriber(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, date_of_birth=date(1990, 4, 2))
    _policy(db, client, _payer(db, clinician), subscriber_first_name="Ignored")
    _appointment(db, clinician, client, datetime(2026, 10, 2, 10, tzinfo=NY))
    period = {"client_id": client.id, "period_start": "2026-10-01", "period_end": "2026-10-31"}
    response = api.post("/api/billing/superbills", json=period, headers=clinician.headers)
    insurance = response.json()["data"]["insurance"]
    assert (insurance["payer_name"], insurance["payer_id"]) == ("Aetna", "")
    assert (
        insurance["subscriber_name"],
        insurance["subscriber_relationship"],
        insurance["subscriber_dob"],
    ) == ("Alex Rivera", "Self", "1990-04-02")


def test_superbill_names_each_clinician_on_their_lines(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _profile(api, clinician, credentials="LCSW", npi="1234567893")
    riley = add_staff(
        db,
        clinician.practice_id,
        "riley@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
        first_name="Riley",
        last_name="Chen",
    )
    _profile(
        api, riley, credentials="LMFT", npi="1987654321", license_number="MFT-7", license_state="CA"
    )
    client = create_client_record(db, clinician)
    assign_clinician(db, client, riley)
    _appointment(db, clinician, client, datetime(2025, 10, 2, 10, tzinfo=NY))
    _appointment(
        db, riley, client, datetime(2025, 10, 9, 10, tzinfo=NY), fee=18000, service_code="90847"
    )

    period = {"client_id": client.id, "period_start": "2025-10-01", "period_end": "2025-10-31"}
    # A clinician with billing access can create it for a client on their care team.
    response = api.post("/api/billing/superbills", json=period, headers=riley.headers)
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["provider"] is None
    assert data["insurance"] is None
    assert [
        (line["cpt"], line["provider"]["name"], line["provider"]["npi"]) for line in data["lines"]
    ] == [("90834", "Jordan Lee", "1234567893"), ("90847", "Riley Chen", "1987654321")]
    assert data["lines"][1]["provider"]["license"] == "MFT-7 (CA)"
    assert response.json()["total_cents"] == 33000
    pdf = api.get(f"/api/billing/superbills/{response.json()['id']}/pdf", headers=riley.headers)
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")


def test_invoice_pdf_handles_any_text(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, first_name="Zoë", last_name="O’Brien 李")
    invoice = api.post(
        "/api/billing/invoices",
        json={
            "client_id": client.id,
            "items": [
                {
                    "service_date": "2026-10-01",
                    "description": "Séance “intake” — 中文 🙂",
                    "amount_cents": 12345,
                }
            ],
            "notes": "Merci…\nPay by the 15th • thanks",
            "notify": False,
        },
        headers=clinician.headers,
    ).json()
    pdf = api.get(f"/api/billing/invoices/{invoice['id']}/pdf", headers=clinician.headers)
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")
    assert pdf.headers["content-disposition"] == 'attachment; filename="INV-000001.pdf"'


# Isolation and roles -----------------------------------------------------------------------


def test_billing_is_isolated_between_practices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    invoice = _manual_invoice(api, clinician, client.id, 10000)
    payment = _pay(api, clinician, client.id, 4000)
    _appointment(db, clinician, client, datetime(2026, 10, 2, 10, tzinfo=NY))
    superbill = api.post(
        "/api/billing/superbills",
        json={"client_id": client.id, "period_start": "2026-10-01", "period_end": "2026-10-31"},
        headers=clinician.headers,
    ).json()
    other = register_practice(api, email="other@example.com")
    headers = other.headers

    for path in (
        f"/api/billing/invoices/{invoice['id']}",
        f"/api/billing/invoices/{invoice['id']}/pdf",
        f"/api/billing/clients/{client.id}/summary",
        f"/api/billing/clients/{client.id}/cards",
        f"/api/billing/superbills/{superbill['id']}",
        f"/api/billing/superbills/{superbill['id']}/pdf",
    ):
        assert api.get(path, headers=headers).status_code == 404, path
    line = {"service_date": "2026-10-01", "description": "Session", "amount_cents": 100}
    for path, body in (
        (f"/api/billing/invoices/{invoice['id']}/void", {}),
        (f"/api/billing/payments/{payment['id']}/refund", {"amount_cents": 100}),
        ("/api/billing/payments", {"client_id": client.id, "amount_cents": 1, "method": "cash"}),
        ("/api/billing/invoices", {"client_id": client.id, "items": [line]}),
        (
            "/api/billing/superbills",
            {"client_id": client.id, "period_start": "2026-10-01", "period_end": "2026-10-31"},
        ),
    ):
        assert api.post(path, json=body, headers=headers).status_code == 404, path
    for path in (
        "/api/billing/invoices",
        "/api/billing/payments",
        "/api/billing/superbills",
        "/api/billing/uninvoiced",
    ):
        assert api.get(path, headers=headers).json() == [], path
        assert api.get(path, params={"client_id": client.id}, headers=headers).json() == []
    overview = api.get("/api/billing/overview", headers=headers).json()
    assert overview["outstanding_cents"] == 0
    assert overview["collected_this_month_cents"] == 0
    assert overview["uninvoiced_count"] == 0
    assert api.get("/api/billing/overview").status_code == 401


LIST_PATHS = (
    "/api/billing/overview",
    "/api/billing/invoices",
    "/api/billing/payments",
    "/api/billing/superbills",
    "/api/billing/uninvoiced",
)


@pytest.mark.parametrize(
    ("role", "clinician_access", "sees"),
    [
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, None),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, None),
        (StaffRole.CLINICIAN, ClinicianAccess.BILLING, "own"),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, "own"),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, "all"),
        (StaffRole.BILLER, ClinicianAccess.BASIC, "all"),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, "all"),
    ],
)
def test_billing_access_by_role(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    clinician_access: ClinicianAccess,
    sees: str | None,
) -> None:
    member = add_staff(
        db, clinician.practice_id, "member@example.com", role, clinician_access=clinician_access
    )
    theirs = create_client_record(db, clinician, email="theirs@example.com")
    own = create_client_record(db, clinician, first_name="Kim", email="own@example.com")
    assign_clinician(db, own, member)
    # Midday yesterday in the practice's zone: "two hours earlier" stays on the same day, so the
    # daily run leaves that session uninvoiced whatever the time now.
    now = datetime.combine(datetime.now(NY).date() - timedelta(days=1), time(12), tzinfo=NY)
    invoices = {}
    for key, client in (("theirs", theirs), ("own", own)):
        invoices[key] = _manual_invoice(api, clinician, client.id, 10000)
        _pay(api, clinician, client.id, 2500, send_receipt=False)
        _appointment(db, clinician, client, now - timedelta(days=2), fee=7000)
        _appointment(db, clinician, client, now - timedelta(days=4), fee=9000)
        # Not yet invoiced: shows up in the uninvoiced list of whoever sees the client.
        _appointment(db, clinician, client, now - timedelta(hours=2), fee=4000)
    create_daily_invoices(db, now)
    headers = member.headers

    if sees is None:
        for path in LIST_PATHS:
            assert api.get(path, headers=headers).status_code == 403, path
        for client_key in ("own", "theirs"):
            invoice_id = invoices[client_key]["id"]
            client_id = own.id if client_key == "own" else theirs.id
            assert (
                api.get(f"/api/billing/invoices/{invoice_id}", headers=headers).status_code == 404
            )
            assert (
                api.get(f"/api/billing/clients/{client_id}/summary", headers=headers).status_code
                == 404
            )
            paid = {"client_id": client_id, "amount_cents": 100, "method": "cash"}
            assert api.post("/api/billing/payments", json=paid, headers=headers).status_code == 404
        return

    visible = {own.id} if sees == "own" else {own.id, theirs.id}
    listed = api.get("/api/billing/invoices", headers=headers).json()
    assert {i["client"]["id"] for i in listed} == visible
    payments = api.get("/api/billing/payments", headers=headers).json()
    assert {p["client"]["id"] for p in payments} == visible
    uninvoiced = api.get("/api/billing/uninvoiced", headers=headers).json()
    assert {s["client"]["id"] for s in uninvoiced} == visible
    overview = api.get("/api/billing/overview", headers=headers).json()
    # Per client: a 10000 manual invoice plus two 7000/9000 sessions invoiced overnight,
    # less 2500 paid.
    assert overview["outstanding_cents"] == 23500 * len(visible)
    assert overview["open_invoice_count"] == 3 * len(visible)
    assert overview["uninvoiced_count"] == len(visible)
    own_invoice = api.get(f"/api/billing/invoices/{invoices['own']['id']}", headers=headers)
    assert own_invoice.status_code == 200
    theirs_invoice = api.get(f"/api/billing/invoices/{invoices['theirs']['id']}", headers=headers)
    assert theirs_invoice.status_code == (404 if sees == "own" else 200)
    theirs_summary = api.get(f"/api/billing/clients/{theirs.id}/summary", headers=headers)
    assert theirs_summary.status_code == (404 if sees == "own" else 200)
    created = api.post(
        "/api/billing/invoices",
        json={
            "client_id": own.id,
            "items": [{"service_date": "2026-10-01", "description": "Letter", "amount_cents": 500}],
            "notify": False,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text


# Client portal -----------------------------------------------------------------------------


def test_portal_shows_only_the_clients_own_billing(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    alex_invoice = _manual_invoice(api, clinician, alex.id, 10000)
    voided = _manual_invoice(api, clinician, alex.id, 500)
    api.post(f"/api/billing/invoices/{voided['id']}/void", headers=clinician.headers)
    sam_invoice = _manual_invoice(api, clinician, sam.id, 7000)
    _pay(api, clinician, alex.id, 12500)
    _pay(api, clinician, sam.id, 1000)
    _appointment(db, clinician, sam, datetime(2026, 10, 2, 10, tzinfo=NY))
    sam_superbill = api.post(
        "/api/billing/superbills",
        json={"client_id": sam.id, "period_start": "2026-10-01", "period_end": "2026-10-31"},
        headers=clinician.headers,
    ).json()
    headers = portal_headers(alex)

    summary = api.get("/api/portal/billing/summary", headers=headers).json()
    assert summary == {
        "balance_cents": 0,
        "credit_cents": 2500,
        "payments_enabled": False,
        "autopay_enabled": False,
        "default_card": None,
    }
    invoices = api.get("/api/portal/billing/invoices", headers=headers).json()
    assert [i["id"] for i in invoices] == [alex_invoice["id"]]
    assert [
        p["client"]["id"] for p in api.get("/api/portal/billing/payments", headers=headers).json()
    ] == [alex.id]
    assert api.get("/api/portal/billing/superbills", headers=headers).json() == []
    own_pdf = api.get(f"/api/portal/billing/invoices/{alex_invoice['id']}/pdf", headers=headers)
    assert own_pdf.status_code == 200
    for path in (
        f"/api/portal/billing/invoices/{sam_invoice['id']}/pdf",
        f"/api/portal/billing/invoices/{voided['id']}/pdf",
        f"/api/portal/billing/superbills/{sam_superbill['id']}/pdf",
    ):
        assert api.get(path, headers=headers).status_code == 404, path

    sam_headers = portal_headers(sam)
    sam_bills = api.get("/api/portal/billing/superbills", headers=sam_headers).json()
    assert [s["id"] for s in sam_bills] == [sam_superbill["id"]]
    sam_pdf = api.get(
        f"/api/portal/billing/superbills/{sam_superbill['id']}/pdf", headers=sam_headers
    )
    assert sam_pdf.content.startswith(b"%PDF")
    assert api.get("/api/billing/overview", headers=headers).status_code == 401

    alex_row = db.get_one(Client, alex.id)
    alex_row.portal_billing = False
    db.commit()
    assert api.get("/api/portal/billing/summary", headers=headers).status_code == 403
    assert api.get("/api/portal/billing/invoices", headers=headers).status_code == 403


def test_payments_record_received_at_in_utc(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    local = datetime(2025, 10, 3, 9, tzinfo=NY)
    payment = _pay(api, clinician, client.id, 100, received_at=local.isoformat())
    stored = db.get_one(Payment, payment["id"])
    assert stored.received_at == local.astimezone(UTC)
    [receipt] = outbound_to(db, "alex@example.com")
    assert receipt.subject == "We received your payment"
    assert "Lee Counseling received your payment" in receipt.body_text
    assert "$1.00" not in receipt.body_text
