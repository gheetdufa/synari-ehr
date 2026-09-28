"""Invoices measured against good faith estimates, and invoice dispute mode."""

from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import (
    AppointmentParticipant,
    AuditEvent,
    Client,
    Invoice,
    Payment,
    PracticeSettings,
    SavedCard,
    SecurityEvent,
)
from synari.models.enums import AppointmentStatus, BillingType, StaffRole
from synari.services import payments
from synari.services.billing_jobs import create_daily_invoices, run_autopay
from synari.services.payments import ChargeResult
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_appointment,
    portal_headers,
)
from tests.estimate_helpers import (
    NY,
    at,
    create_draft,
    issue,
    item,
    notifications,
    practice_fixture,  # noqa: F401
    self_pay_client,
    today,
)
from tests.insurance_helpers import add_payer, insured_client


def _estimate(api: TestClient, account: StaffAccount, client: Client, quantity: int) -> dict:
    """An issued estimate for `quantity` visits of 90834 at $150, from 60 days ago."""
    draft = create_draft(
        api,
        account,
        client.id,
        items=[item(quantity=quantity)],
        period_start=today() - timedelta(days=60),
    )
    return issue(api, account, draft["id"])


def _past_sessions(
    db: Session, account: StaffAccount, client: Client, days_ago: list[int]
) -> list[int]:
    """Attended $150 sessions (90834) this many days ago; returns their participant ids."""
    ids = []
    for days in days_ago:
        appointment = create_appointment(
            db,
            account,
            [client],
            starts_at=at(today() - timedelta(days=days)),
            status=AppointmentStatus.ATTENDED,
            service_code="90834",
            service_description="Psychotherapy, 45 minutes",
        )
        ids.append(appointment.participants[0].id)
    return ids


def _invoice_body(client: Client, participant_ids: list[int], **extra: Any) -> dict[str, Any]:
    return {"client_id": client.id, "participant_ids": participant_ids, "notify": False, **extra}


def test_invoices_warn_near_the_estimate_and_need_a_reason_400_above(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    client = self_pay_client(db, practice)
    _estimate(api, practice, client, quantity=1)  # $150 in all
    first, *rest = _past_sessions(db, practice, client, [40, 33, 26, 19])

    warnings = {
        row["participant_id"]: row["estimate_warning"]
        for row in api.get(
            f"/api/billing/uninvoiced?client_id={client.id}", headers=practice.headers
        ).json()
    }
    assert [warnings[pid] for pid in [first, *rest]] == [
        "100% of the good faith estimate",
        "200% of the good faith estimate",
        "300% of the good faith estimate",
        "$450.00 above the good faith estimate",
    ]

    check = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(client, [first]),
        headers=practice.headers,
    ).json()
    assert check == {
        "warnings": [
            "Charges for Jordan Lee, LCSW reach 100% of the good faith estimate "
            "($150.00 of $150.00)."
        ],
        "override_required": False,
        "over_by_cents": 0,
    }
    created = api.post(
        "/api/billing/invoices", json=_invoice_body(client, [first]), headers=practice.headers
    )
    assert created.status_code == 201
    assert created.json()["estimate_warnings"] == check["warnings"]

    # The rest would bill $600 against a $150 estimate: $450 over, so a reason is needed.
    check = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(client, rest),
        headers=practice.headers,
    ).json()
    assert (check["override_required"], check["over_by_cents"]) == (True, 45000)
    assert (
        "More sessions with Jordan Lee, LCSW than the good faith estimate expected (4 of 1)."
        in check["warnings"]
    )
    blocked = api.post(
        "/api/billing/invoices", json=_invoice_body(client, rest), headers=practice.headers
    )
    assert blocked.status_code == 409
    detail = blocked.json()["detail"]
    assert (detail["code"], detail["over_by_cents"]) == ("estimate_override_required", 45000)
    assert "Enter a reason" in detail["message"]
    assert db.scalar(select(Invoice).where(Invoice.client_id == client.id).offset(1)) is None

    reason = "Client added sessions after the estimate; updated estimate sent."
    created = api.post(
        "/api/billing/invoices",
        json=_invoice_body(client, rest, gfe_override_reason=reason),
        headers=practice.headers,
    )
    assert created.status_code == 201, created.text
    invoice = created.json()
    assert invoice["gfe_override_reason"] == reason
    event = db.scalar(select(SecurityEvent).where(SecurityEvent.kind == "gfe_overage"))
    assert event is not None
    assert (event.staff_id, event.detail["invoice_id"], event.detail["over_by_cents"]) == (
        practice.id,
        invoice["id"],
        45000,
    )
    [alert] = notifications(db, biller.id, "estimate_overage")
    assert alert.title == "An invoice for Alex R. is $450.00 above the good faith estimate"
    assert notifications(db, practice.id, "estimate_overage") == []  # they did it themselves
    audit = db.scalar(
        select(AuditEvent)
        .where(AuditEvent.action == "invoice.create")
        .order_by(AuditEvent.id.desc())
        .limit(1)
    )
    assert audit is not None
    assert (audit.client_id, audit.detail["estimate_override"]) == (client.id, True)

    # The override reason is the practice's note, not the client's.
    portal = api.get("/api/portal/billing/invoices", headers=portal_headers(client)).json()
    assert {row["gfe_override_reason"] for row in portal} == {""}


def test_invoicing_self_pay_clients_without_an_estimate_warns(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    [session] = _past_sessions(db, practice, client, [5])
    day = today() - timedelta(days=5)
    check = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(client, [session]),
        headers=practice.headers,
    ).json()
    assert check["warnings"] == [
        f"No good faith estimate covers Jordan Lee, LCSW's services on {day:%b} {day.day} "
        f"for this self-pay client."
    ]
    [row] = api.get("/api/billing/uninvoiced", headers=practice.headers).json()
    assert row["estimate_warning"] == "No good faith estimate"

    insured = self_pay_client(
        db, practice, first_name="Ins", email="ins@example.com", billing_type=BillingType.INSURANCE
    )
    [covered] = _past_sessions(db, practice, insured, [5])
    check = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(insured, [covered]),
        headers=practice.headers,
    ).json()
    assert check["warnings"] == []

    db.get_one(PracticeSettings, practice.practice_id).gfe_enabled = False
    db.commit()
    check = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(client, [session]),
        headers=practice.headers,
    ).json()
    assert check["warnings"] == []


def test_estimate_check_needs_billing_access(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    scheduler = add_staff(db, practice.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    client = self_pay_client(db, practice)
    [session] = _past_sessions(db, practice, client, [5])
    response = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(client, [session]),
        headers=scheduler.headers,
    )
    assert response.status_code == 404


def test_estimate_check_saves_nothing(api: TestClient, practice: StaffAccount, db: Session) -> None:
    insured = insured_client(
        db, practice, add_payer(db, practice.practice_id), email="ins@example.com", copay_cents=2500
    )
    [session] = _past_sessions(db, practice, insured, [5])
    response = api.post(
        "/api/billing/invoices/estimate-check",
        json=_invoice_body(insured, [session]),
        headers=practice.headers,
    )
    assert response.json() == {"warnings": [], "override_required": False, "over_by_cents": 0}
    # Pricing the line resolves the copay, but only creating the invoice records it.
    db.expire_all()
    assert db.get_one(AppointmentParticipant, session).client_owes_cents is None


def test_nightly_invoicing_flags_overages_without_holding_invoices(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    _estimate(api, practice, client, quantity=1)
    _past_sessions(db, practice, client, [4, 3, 2])
    create_daily_invoices(db, utcnow())
    invoices = db.scalars(select(Invoice).where(Invoice.client_id == client.id)).all()
    assert len(invoices) == 3  # one per day of service
    # $150, $300 and $450 billed against a $150 estimate: at most $300 over, no alert yet.
    assert db.scalars(select(SecurityEvent).where(SecurityEvent.kind == "gfe_overage")).all() == []

    # A fourth day brings it to $450 over: invoiced anyway, and flagged for staff.
    _past_sessions(db, practice, client, [1])
    create_daily_invoices(db, utcnow())
    assert len(db.scalars(select(Invoice).where(Invoice.client_id == client.id)).all()) == 4
    [event] = db.scalars(select(SecurityEvent).where(SecurityEvent.kind == "gfe_overage")).all()
    assert (event.staff_id, event.detail["over_by_cents"]) == (None, 45000)
    [alert] = notifications(db, practice.id, "estimate_overage")
    assert alert.urgent


# Dispute mode ------------------------------------------------------------------------------


@pytest.fixture
def charges(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Stripe on, with card charges recorded and succeeding."""
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_123")
    made: list[dict[str, Any]] = []

    def charge(**kwargs: Any) -> ChargeResult:
        made.append(kwargs)
        return ChargeResult(f"pi_{len(made)}", "succeeded")

    monkeypatch.setattr(payments, "charge_saved_card", charge)
    return made


def _custom_invoice(api: TestClient, account: StaffAccount, client: Client, amount: int) -> dict:
    response = api.post(
        "/api/billing/invoices",
        json={
            "client_id": client.id,
            "items": [
                {
                    "service_date": today().isoformat(),
                    "description": "Session",
                    "amount_cents": amount,
                }
            ],
            "notify": False,
        },
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_disputed_invoices_pause_autopay_and_automatic_payments(
    api: TestClient, practice: StaffAccount, db: Session, charges: list[dict[str, Any]]
) -> None:
    db.get_one(PracticeSettings, practice.practice_id).autopay_enabled = True
    client = self_pay_client(db, practice, autopay_enabled=True, stripe_customer_id="cus_1")
    db.add(
        SavedCard(
            client_id=client.id,
            stripe_payment_method_id="pm_visa",
            brand="visa",
            last4="4242",
            exp_month=12,
            exp_year=2030,
            is_default=True,
        )
    )
    db.commit()
    disputed = _custom_invoice(api, practice, client, 15000)
    other = _custom_invoice(api, practice, client, 2500)

    response = api.post(f"/api/billing/invoices/{disputed['id']}/dispute", headers=practice.headers)
    assert response.status_code == 200
    assert response.json()["disputed_at"] is not None
    again = api.post(f"/api/billing/invoices/{disputed['id']}/dispute", headers=practice.headers)
    assert again.status_code == 409

    run_autopay(db, datetime.combine(today(), datetime.min.time(), tzinfo=NY) + timedelta(hours=23))
    [charge] = charges
    assert charge["amount_cents"] == 2500
    db.expire_all()
    assert db.get_one(Invoice, other["id"]).status == "paid"
    assert db.get_one(Invoice, disputed["id"]).paid_cents == 0

    # Money received while disputed isn't applied to the disputed invoice automatically...
    paid = api.post(
        "/api/billing/payments",
        json={
            "client_id": client.id,
            "amount_cents": 15000,
            "method": "check",
            "send_receipt": False,
        },
        headers=practice.headers,
    )
    assert paid.status_code == 201
    db.expire_all()
    assert db.get_one(Invoice, disputed["id"]).paid_cents == 0
    assert db.get_one(Payment, paid.json()["id"]).unapplied_cents == 15000

    # ...until the dispute is resolved.
    resolved = api.post(f"/api/billing/invoices/{disputed['id']}/resolve", headers=practice.headers)
    assert resolved.status_code == 200
    assert (resolved.json()["disputed_at"], resolved.json()["status"]) == (None, "paid")
    assert (
        api.post(
            f"/api/billing/invoices/{disputed['id']}/resolve", headers=practice.headers
        ).status_code
        == 409
    )
    actions = {
        e.action: e.client_id
        for e in db.scalars(select(AuditEvent).where(AuditEvent.action.like("invoice.dispute%")))
    }
    assert actions == {"invoice.dispute": client.id, "invoice.dispute_resolve": client.id}


def test_paying_a_disputed_invoice_directly_still_works(
    api: TestClient, practice: StaffAccount, db: Session
) -> None:
    client = self_pay_client(db, practice)
    invoice = _custom_invoice(api, practice, client, 15000)
    api.post(f"/api/billing/invoices/{invoice['id']}/dispute", headers=practice.headers)
    paid = api.post(
        "/api/billing/payments",
        json={
            "client_id": client.id,
            "amount_cents": 15000,
            "method": "cash",
            "invoice_id": invoice["id"],
            "send_receipt": False,
        },
        headers=practice.headers,
    )
    assert paid.status_code == 201
    db.expire_all()
    assert db.get_one(Invoice, invoice["id"]).status == "paid"


def test_disputes_need_billing_access(api: TestClient, practice: StaffAccount, db: Session) -> None:
    client = self_pay_client(db, practice)
    invoice = _custom_invoice(api, practice, client, 15000)
    scheduler = add_staff(db, practice.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    clinician = add_staff(db, practice.practice_id, "c@example.com", StaffRole.CLINICIAN)
    biller = add_staff(db, practice.practice_id, "bill@example.com", StaffRole.BILLER)
    for member in (scheduler, clinician):
        response = api.post(
            f"/api/billing/invoices/{invoice['id']}/dispute", headers=member.headers
        )
        assert response.status_code == 404
    assert (
        api.post(
            f"/api/billing/invoices/{invoice['id']}/dispute", headers=biller.headers
        ).status_code
        == 200
    )
    voided = _custom_invoice(api, practice, client, 1000)
    api.post(f"/api/billing/invoices/{voided['id']}/void", headers=practice.headers)
    assert (
        api.post(
            f"/api/billing/invoices/{voided['id']}/dispute", headers=practice.headers
        ).status_code
        == 409
    )
    portal = api.get("/api/portal/billing/invoices", headers=portal_headers(client)).json()
    assert [row["disputed_at"] is not None for row in portal] == [True]
