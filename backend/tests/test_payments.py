"""Stripe payments: portal Checkout, saved cards, card charges, refunds, webhooks and AutoPay.

Stripe itself is never called: the functions in synari.services.payments are replaced by a
fake. Webhook signatures are real, computed here the way Stripe computes them.
"""

import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import SessionLocal
from synari.models import (
    Client,
    ClientContact,
    Invoice,
    Notification,
    Payment,
    PracticeSettings,
    SavedCard,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, Role, StaffRole
from synari.services import payments
from synari.services.billing import record_card_success
from synari.services.billing_jobs import create_daily_invoices, run_autopay
from synari.services.payments import CardDetails, ChargeResult, PaymentError
from synari.worker import JOBS
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
WEBHOOK_SECRET = "whsec_test_secret"
VISA = CardDetails("pm_visa", "visa", "4242", 12, 2030)
MASTERCARD = CardDetails("pm_mc", "mastercard", "4444", 1, 2031)


@dataclass
class FakeStripe:
    """Stands in for synari.services.payments and records every call."""

    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    cards: dict[str, CardDetails] = field(default_factory=dict)
    charge_outcomes: list[ChargeResult | PaymentError] = field(default_factory=list)
    refund_error: PaymentError | None = None

    def named(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for call, kwargs in self.calls if call == name]

    def create_customer(self, **kwargs: Any) -> str:
        self.calls.append(("create_customer", kwargs))
        return f"cus_{len(self.named('create_customer'))}"

    def create_payment_checkout(self, **kwargs: Any) -> str:
        self.calls.append(("create_payment_checkout", kwargs))
        return "https://checkout.stripe.test/pay"

    def create_setup_checkout(self, **kwargs: Any) -> str:
        self.calls.append(("create_setup_checkout", kwargs))
        return "https://checkout.stripe.test/setup"

    def charge_saved_card(self, **kwargs: Any) -> ChargeResult:
        self.calls.append(("charge_saved_card", kwargs))
        outcome = self.charge_outcomes.pop(0)
        if isinstance(outcome, PaymentError):
            raise outcome
        return outcome

    def refund_payment(self, **kwargs: Any) -> None:
        self.calls.append(("refund_payment", kwargs))
        if self.refund_error is not None:
            raise self.refund_error

    def detach_card(self, payment_method_id: str) -> None:
        self.calls.append(("detach_card", {"payment_method_id": payment_method_id}))

    def payment_intent_card(self, payment_intent_id: str) -> CardDetails | None:
        return self.cards.get(payment_intent_id)

    def setup_intent_card(self, setup_intent_id: str) -> CardDetails | None:
        return self.cards.get(setup_intent_id)


@pytest.fixture
def stripe_fake(monkeypatch: pytest.MonkeyPatch) -> FakeStripe:
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_123")
    monkeypatch.setattr(settings, "stripe_webhook_secret", WEBHOOK_SECRET)
    fake = FakeStripe()
    for name in (
        "create_customer",
        "create_payment_checkout",
        "create_setup_checkout",
        "charge_saved_card",
        "refund_payment",
        "detach_card",
        "payment_intent_card",
        "setup_intent_card",
    ):
        monkeypatch.setattr(payments, name, getattr(fake, name))
    return fake


def send_event(
    api: TestClient,
    event_type: str,
    stripe_object: dict[str, Any],
    *,
    secret: str = WEBHOOK_SECRET,
    age_seconds: int = 0,
) -> Response:
    payload = json.dumps(
        {"id": f"evt_{time.time_ns()}", "type": event_type, "data": {"object": stripe_object}}
    )
    timestamp = int(time.time()) - age_seconds
    signature = hmac.new(
        secret.encode(), f"{timestamp}.{payload}".encode(), hashlib.sha256
    ).hexdigest()
    return api.post(
        "/api/webhooks/stripe",
        content=payload,
        headers={"Stripe-Signature": f"t={timestamp},v1={signature}"},
    )


def _metadata(client: Client, **extra: str) -> dict[str, str]:
    return {"practice_id": str(client.practice_id), "client_id": str(client.id), **extra}


def _invoice(api: TestClient, account: StaffAccount, client_id: int, amount: int) -> dict:
    response = api.post(
        "/api/billing/invoices",
        json={
            "client_id": client_id,
            "items": [
                {"service_date": "2026-10-01", "description": "Session", "amount_cents": amount}
            ],
            "notify": False,
        },
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _checkout_paid(
    client: Client, payment_intent_id: str, amount: int, **metadata: str
) -> dict[str, Any]:
    return {
        "id": f"cs_{payment_intent_id}",
        "mode": "payment",
        "payment_status": "paid",
        "payment_intent": payment_intent_id,
        "amount_total": amount,
        "metadata": _metadata(client, purpose="portal_payment", **metadata),
    }


def _card(
    db: Session, client: Client, card: CardDetails = VISA, *, default: bool = True
) -> SavedCard:
    saved = SavedCard(
        client_id=client.id,
        stripe_payment_method_id=card.payment_method_id,
        brand=card.brand,
        last4=card.last4,
        exp_month=card.exp_month,
        exp_year=card.exp_year,
        is_default=default,
    )
    db.add(saved)
    db.get_one(Client, client.id).stripe_customer_id = "cus_existing"
    db.commit()
    return saved


def _payments(db: Session, client_id: int) -> list[Payment]:
    db.expire_all()
    return list(
        db.scalars(select(Payment).where(Payment.client_id == client_id).order_by(Payment.id))
    )


@dataclass
class BillingTeam:
    """Staff who handle a client's billing, and staff who don't."""

    handles: list[StaffAccount]
    others: list[StaffAccount]


def _billing_team(db: Session, owner: StaffAccount, client: Client) -> BillingTeam:
    practice_id = owner.practice_id
    biller = add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, practice_id, "scheduler@example.com", StaffRole.SCHEDULER)
    basic = add_staff(db, practice_id, "basic@example.com", StaffRole.CLINICIAN)
    on_team, elsewhere = (
        add_staff(
            db,
            practice_id,
            email,
            StaffRole.CLINICIAN,
            clinician_access=ClinicianAccess.BILLING,
        )
        for email in ("billing@example.com", "elsewhere@example.com")
    )
    assign_clinician(db, client, basic)
    assign_clinician(db, client, on_team)
    return BillingTeam(handles=[owner, biller, on_team], others=[scheduler, basic, elsewhere])


def _notified(db: Session, kind: str) -> set[int]:
    db.expire_all()
    return set(
        db.scalars(
            select(Notification.recipient_id).where(
                Notification.recipient_role == Role.STAFF, Notification.kind == kind
            )
        )
    )


# Configuration -----------------------------------------------------------------------------


def test_card_features_need_stripe(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    card = _card(db, client)
    headers = portal_headers(client)
    for response in (
        api.post("/api/portal/billing/checkout", json={}, headers=headers),
        api.post("/api/portal/billing/cards/setup", headers=headers),
        api.post(
            f"/api/billing/clients/{client.id}/charge",
            json={"amount_cents": 1000},
            headers=clinician.headers,
        ),
        api.delete(f"/api/billing/cards/{card.id}", headers=clinician.headers),
        api.post("/api/webhooks/stripe", content=b"{}"),
    ):
        assert response.status_code == 503
        assert response.json()["detail"] == "Online payments aren't configured"


# Portal Checkout ---------------------------------------------------------------------------


def test_portal_checkout_amounts_and_metadata(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    assert api.post("/api/portal/billing/checkout", json={}, headers=headers).status_code == 409
    older = _invoice(api, clinician, client.id, 10000)
    newer = _invoice(api, clinician, client.id, 5000)

    whole = api.post("/api/portal/billing/checkout", json={}, headers=headers)
    assert whole.status_code == 200, whole.text
    assert whole.json() == {"url": "https://checkout.stripe.test/pay"}
    one = api.post(
        "/api/portal/billing/checkout", json={"invoice_id": newer["id"]}, headers=headers
    )
    assert one.status_code == 200
    chosen = api.post(
        "/api/portal/billing/checkout",
        json={"amount_cents": 7000, "save_card": True},
        headers=headers,
    )
    assert chosen.status_code == 200

    sessions = stripe_fake.named("create_payment_checkout")
    assert [s["amount_cents"] for s in sessions] == [15000, 5000, 7000]
    assert sessions[0]["metadata"] == _metadata(client, purpose="portal_payment", save_card="0")
    assert sessions[1]["metadata"]["invoice_id"] == str(newer["id"])
    assert (sessions[2]["save_card"], sessions[2]["metadata"]["save_card"]) == (True, "1")
    assert sessions[0]["success_url"] == "http://app.test/client/billing?payment=success"
    assert sessions[0]["cancel_url"] == "http://app.test/client/billing?payment=canceled"
    assert sessions[0]["product_name"] == "Payment to Lee Counseling"
    assert {s["customer_id"] for s in sessions} == {"cus_1"}
    assert len(stripe_fake.named("create_customer")) == 1
    db.expire_all()
    assert db.get_one(Client, client.id).stripe_customer_id == "cus_1"

    too_much = api.post(
        "/api/portal/billing/checkout", json={"amount_cents": 15001}, headers=headers
    )
    assert too_much.status_code == 422
    tiny = api.post("/api/portal/billing/checkout", json={"amount_cents": 10}, headers=headers)
    assert tiny.status_code == 422
    both = {"invoice_id": older["id"], "amount_cents": 100}
    assert api.post("/api/portal/billing/checkout", json=both, headers=headers).status_code == 422
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    sams = _invoice(api, clinician, sam.id, 2000)
    stolen = api.post(
        "/api/portal/billing/checkout", json={"invoice_id": sams["id"]}, headers=headers
    )
    assert stolen.status_code == 404

    setup = api.post("/api/portal/billing/cards/setup", headers=headers)
    assert setup.json() == {"url": "https://checkout.stripe.test/setup"}
    [setup_call] = stripe_fake.named("create_setup_checkout")
    assert setup_call["metadata"] == _metadata(client, purpose="save_card")
    assert setup_call["success_url"] == "http://app.test/client/billing?card=saved"


# Webhooks ----------------------------------------------------------------------------------


def test_webhook_rejects_bad_signatures(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    event = _checkout_paid(client, "pi_1", 5000)
    assert (
        send_event(api, "checkout.session.completed", event, secret="whsec_wrong").status_code
        == 400
    )
    stale = send_event(api, "checkout.session.completed", event, age_seconds=600)
    assert stale.status_code == 400
    unsigned = api.post("/api/webhooks/stripe", content=json.dumps({"type": "x"}))
    assert unsigned.status_code == 400
    assert _payments(db, client.id) == []
    ignored = send_event(api, "customer.created", {"id": "cus_1"})
    assert (ignored.status_code, ignored.json()["detail"]) == (200, "Ignored")


def test_checkout_payment_is_recorded_once(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    older = _invoice(api, clinician, client.id, 10000)
    newer = _invoice(api, clinician, client.id, 5000)
    stripe_fake.cards["pi_1"] = VISA
    event = _checkout_paid(client, "pi_1", 12000, invoice_id=str(newer["id"]), save_card="1")

    for _ in range(2):
        response = send_event(api, "checkout.session.completed", event)
        assert response.status_code == 200, response.text
    succeeded = {"id": "pi_1", "amount_received": 12000, "metadata": event["metadata"]}
    assert send_event(api, "payment_intent.succeeded", succeeded).status_code == 200

    [payment] = _payments(db, client.id)
    assert (payment.status, payment.amount_cents, payment.method) == ("succeeded", 12000, "card")
    assert payment.stripe_payment_intent_id == "pi_1"
    assert payment.reference == "Visa ending 4242"
    assert [(a.invoice_id, a.amount_cents) for a in payment.allocations] == [
        (newer["id"], 5000),
        (older["id"], 7000),
    ]
    [card] = db.scalars(select(SavedCard).where(SavedCard.client_id == client.id)).all()
    assert (card.stripe_payment_method_id, card.is_default) == ("pm_visa", True)
    [receipt] = outbound_to(db, "alex@example.com")
    assert receipt.subject == "We received your payment"
    summary = api.get("/api/portal/billing/summary", headers=portal_headers(client)).json()
    assert summary["balance_cents"] == 3000
    assert summary["default_card"]["last4"] == "4242"
    assert summary["payments_enabled"] is True


def test_payment_intent_can_arrive_before_checkout_completes(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    _invoice(api, clinician, client.id, 4000)
    event = _checkout_paid(client, "pi_2", 4000)
    intent = {"id": "pi_2", "amount_received": 4000, "metadata": event["metadata"]}
    assert send_event(api, "payment_intent.succeeded", intent).status_code == 200
    [payment] = _payments(db, client.id)
    assert (payment.status, payment.reference) == ("succeeded", "")

    stripe_fake.cards["pi_2"] = VISA
    assert send_event(api, "checkout.session.completed", event).status_code == 200
    [payment] = _payments(db, client.id)
    assert payment.reference == "Visa ending 4242"
    assert db.scalars(select(SavedCard)).all() == []


def test_card_payments_notify_staff_who_handle_the_clients_billing(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    team = _billing_team(db, clinician, client)
    _invoice(api, clinician, client.id, 4000)
    event = _checkout_paid(client, "pi_n", 4000)
    assert send_event(api, "checkout.session.completed", event).status_code == 200
    assert _notified(db, "payment_received") == {member.id for member in team.handles}
    [payment] = _payments(db, client.id)
    assert payment.practice_id == clinician.practice_id


def test_webhook_ignores_objects_without_matching_metadata(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    other = register_practice(api, email="other@example.com")
    forged = _checkout_paid(client, "pi_3", 5000)
    forged["metadata"]["practice_id"] = str(other.practice_id)
    assert send_event(api, "checkout.session.completed", forged).status_code == 200
    unrelated = {"id": "pi_4", "amount_received": 100, "metadata": {}}
    assert send_event(api, "payment_intent.succeeded", unrelated).status_code == 200
    assert db.scalars(select(Payment)).all() == []


def test_setup_checkout_saves_cards_and_first_is_default(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    stripe_fake.cards.update({"seti_1": VISA, "seti_2": MASTERCARD})
    for setup_intent in ("seti_1", "seti_2", "seti_2"):
        session = {
            "id": f"cs_{setup_intent}",
            "mode": "setup",
            "setup_intent": setup_intent,
            "metadata": _metadata(client, purpose="save_card"),
        }
        assert send_event(api, "checkout.session.completed", session).status_code == 200

    cards = api.get("/api/portal/billing/cards", headers=headers).json()
    assert [(c["last4"], c["is_default"]) for c in cards] == [("4242", True), ("4444", False)]
    mastercard_id = cards[1]["id"]
    updated = api.post(f"/api/portal/billing/cards/{mastercard_id}/default", headers=headers)
    assert [(c["last4"], c["is_default"]) for c in updated.json()] == [
        ("4444", True),
        ("4242", False),
    ]
    # Clients can't remove cards; there is no such portal route.
    assert (
        api.delete(f"/api/portal/billing/cards/{mastercard_id}", headers=headers).status_code == 404
    )

    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    stolen = api.post(
        f"/api/portal/billing/cards/{mastercard_id}/default", headers=portal_headers(sam)
    )
    assert stolen.status_code == 404
    other = register_practice(api, email="other@example.com")
    assert (
        api.delete(f"/api/billing/cards/{mastercard_id}", headers=other.headers).status_code == 404
    )

    deleted = api.delete(f"/api/billing/cards/{mastercard_id}", headers=clinician.headers)
    assert deleted.status_code == 204
    assert stripe_fake.named("detach_card") == [{"payment_method_id": "pm_mc"}]
    listed = api.get(f"/api/billing/clients/{client.id}/cards", headers=clinician.headers).json()
    assert [(c["last4"], c["is_default"]) for c in listed] == [("4242", True)]


def test_card_routes_need_billing_access_to_the_client(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    card = _card(db, client)
    spare = _card(db, client, MASTERCARD, default=False)
    team = _billing_team(db, clinician, client)
    charge = f"/api/billing/clients/{client.id}/charge"
    for member in team.others:
        headers = member.headers
        assert (
            api.get(f"/api/billing/clients/{client.id}/cards", headers=headers).status_code == 404
        )
        assert (
            api.post(f"/api/billing/cards/{spare.id}/default", headers=headers).status_code == 404
        )
        assert api.delete(f"/api/billing/cards/{card.id}", headers=headers).status_code == 404
        assert api.post(charge, json={"amount_cents": 1000}, headers=headers).status_code == 404
    assert stripe_fake.calls == []

    biller = team.handles[1]
    stripe_fake.charge_outcomes = [ChargeResult("pi_biller", "succeeded")]
    charged = api.post(charge, json={"amount_cents": 1000}, headers=biller.headers)
    assert charged.status_code == 201, charged.text
    [call] = stripe_fake.named("charge_saved_card")
    assert call["metadata"] == _metadata(
        client, payment_id=str(charged.json()["id"]), purpose="staff_charge"
    )
    assert api.post(f"/api/billing/cards/{spare.id}/default", headers=biller.headers).is_success


# Charging saved cards ----------------------------------------------------------------------


def test_staff_charge_a_saved_card(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    url = f"/api/billing/clients/{client.id}/charge"
    assert api.post(url, json={"amount_cents": 1000}, headers=clinician.headers).status_code == 409
    card = _card(db, client)
    invoice = _invoice(api, clinician, client.id, 15000)

    stripe_fake.charge_outcomes = [
        ChargeResult("pi_ok", "succeeded"),
        PaymentError("Your card has insufficient funds.", declined=True),
        PaymentError("The payment processor couldn't complete the request. Please try again."),
    ]
    charged = api.post(url, json={"amount_cents": 15000}, headers=clinician.headers)
    assert charged.status_code == 201, charged.text
    body = charged.json()
    assert (body["status"], body["reference"]) == ("succeeded", "Visa ending 4242")
    assert body["allocations"] == [{"invoice_id": invoice["id"], "amount_cents": 15000}]
    [call] = stripe_fake.named("charge_saved_card")
    assert call["customer_id"] == "cus_existing"
    assert call["payment_method_id"] == "pm_visa"
    assert call["idempotency_key"] == f"synari-payment-{body['id']}"
    assert call["metadata"] == _metadata(client, payment_id=str(body["id"]), purpose="staff_charge")

    declined = api.post(
        url, json={"amount_cents": 2000, "card_id": card.id}, headers=clinician.headers
    )
    assert declined.status_code == 402
    assert declined.json()["detail"] == "Your card has insufficient funds."
    outage = api.post(url, json={"amount_cents": 2000}, headers=clinician.headers)
    assert outage.status_code == 502
    statuses = [(p.status, p.failure_reason[:9]) for p in _payments(db, client.id)]
    assert statuses == [("succeeded", ""), ("failed", "Your card"), ("failed", "The payme")]

    assert api.post(url, json={"amount_cents": 49}, headers=clinician.headers).status_code == 422
    sam = create_client_record(db, clinician, first_name="Sam", email="sam@example.com")
    wrong_card = api.post(
        f"/api/billing/clients/{sam.id}/charge",
        json={"amount_cents": 1000, "card_id": card.id},
        headers=clinician.headers,
    )
    assert wrong_card.status_code == 404


def test_charge_survives_a_webhook_that_beats_the_api_response(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    stripe_fake: FakeStripe,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = create_client_record(db, clinician)
    _card(db, client)
    invoice = _invoice(api, clinician, client.id, 9000)

    def racing_charge(**kwargs: Any) -> ChargeResult:
        with SessionLocal() as webhook_db:
            record_card_success(
                webhook_db,
                payment_intent_id="pi_race",
                amount_cents=kwargs["amount_cents"],
                metadata=kwargs["metadata"],
            )
            webhook_db.commit()
        return ChargeResult("pi_race", "succeeded")

    monkeypatch.setattr(payments, "charge_saved_card", racing_charge)
    response = api.post(
        f"/api/billing/clients/{client.id}/charge",
        json={"amount_cents": 9000},
        headers=clinician.headers,
    )
    assert response.status_code == 201, response.text
    [payment] = _payments(db, client.id)
    assert (payment.status, payment.stripe_payment_intent_id) == ("succeeded", "pi_race")
    assert [a.amount_cents for a in payment.allocations] == [9000]
    stored = db.get_one(Invoice, invoice["id"])
    assert (stored.paid_cents, stored.status) == (9000, "paid")
    assert len(outbound_to(db, "alex@example.com")) == 1


def test_processing_charges_settle_from_webhooks(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    _card(db, client)
    _invoice(api, clinician, client.id, 3000)
    stripe_fake.charge_outcomes = [
        ChargeResult("pi_slow", "processing"),
        ChargeResult("pi_bad", "processing"),
    ]
    url = f"/api/billing/clients/{client.id}/charge"
    first = api.post(url, json={"amount_cents": 3000}, headers=clinician.headers).json()
    second = api.post(url, json={"amount_cents": 1000}, headers=clinician.headers).json()
    assert (first["status"], second["status"]) == ("pending", "pending")

    metadata = _metadata(client, payment_id=str(first["id"]), purpose="staff_charge")
    ok = {"id": "pi_slow", "amount_received": 3000, "metadata": metadata}
    assert send_event(api, "payment_intent.succeeded", ok).status_code == 200
    failure = {
        "id": "pi_bad",
        "metadata": _metadata(client, payment_id=str(second["id"]), purpose="staff_charge"),
        "last_payment_error": {"message": "Your card was declined."},
    }
    for _ in range(2):
        assert send_event(api, "payment_intent.payment_failed", failure).status_code == 200

    settled, failed = _payments(db, client.id)
    assert (settled.status, settled.allocated_cents) == ("succeeded", 3000)
    assert (failed.status, failed.failure_reason) == ("failed", "Your card was declined.")
    late_failure = {"id": "pi_slow", "metadata": metadata}
    send_event(api, "payment_intent.payment_failed", late_failure)
    assert _payments(db, client.id)[0].status == "succeeded"


# Refunds -----------------------------------------------------------------------------------


def test_card_refunds_go_through_stripe_and_sync_idempotently(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = create_client_record(db, clinician)
    first = _invoice(api, clinician, client.id, 6000)
    second = _invoice(api, clinician, client.id, 6000)
    send_event(api, "checkout.session.completed", _checkout_paid(client, "pi_r", 12000))
    [payment] = _payments(db, client.id)
    url = f"/api/billing/payments/{payment.id}/refund"

    stripe_fake.refund_error = PaymentError("Stripe is down")
    failed = api.post(url, json={"amount_cents": 2000}, headers=clinician.headers)
    assert failed.status_code == 502
    assert _payments(db, client.id)[0].refunded_cents == 0

    stripe_fake.refund_error = None
    refunded = api.post(url, json={"amount_cents": 2000}, headers=clinician.headers)
    assert refunded.status_code == 200, refunded.text
    assert refunded.json()["status"] == "partially_refunded"
    assert stripe_fake.named("refund_payment")[-1] == {
        "payment_intent_id": "pi_r",
        "amount_cents": 2000,
        "idempotency_key": f"synari-refund-{payment.id}-0",
    }

    charge = {"id": "ch_1", "payment_intent": "pi_r", "amount_refunded": 2000}
    assert send_event(api, "charge.refunded", charge).status_code == 200
    assert _payments(db, client.id)[0].refunded_cents == 2000

    # A further refund made in the Stripe dashboard is picked up once.
    dashboard = {**charge, "amount_refunded": 5000}
    for _ in range(2):
        assert send_event(api, "charge.refunded", dashboard).status_code == 200
    [payment] = _payments(db, client.id)
    assert (payment.refunded_cents, payment.status) == (5000, "partially_refunded")
    assert [a.amount_cents for a in payment.allocations] == [6000, 1000]
    first_now = db.get_one(Invoice, first["id"])
    second_now = db.get_one(Invoice, second["id"])
    assert (first_now.status, second_now.status, second_now.paid_cents) == ("paid", "open", 1000)

    everything = {**charge, "amount_refunded": 12000}
    send_event(api, "charge.refunded", everything)
    assert _payments(db, client.id)[0].status == "refunded"


# AutoPay -----------------------------------------------------------------------------------


def _autopay_client(api: TestClient, account: StaffAccount, db: Session) -> Client:
    db.get_one(PracticeSettings, account.practice_id).autopay_enabled = True
    db.commit()
    client = create_client_record(db, account, autopay_enabled=True)
    _card(db, client)
    return client


def test_autopay_charges_the_balance_once_per_local_day(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = _autopay_client(api, clinician, db)
    db.get_one(Client, client.id).autopay_failures = 2
    # The day is the practice's (New York), not the clinician's own calendar zone.
    db.get_one(StaffMember, clinician.id).time_zone = "America/Los_Angeles"
    db.commit()
    _invoice(api, clinician, client.id, 15000)
    _invoice(api, clinician, client.id, 2500)
    stripe_fake.charge_outcomes = [
        ChargeResult("pi_a1", "succeeded"),
        ChargeResult("pi_a2", "succeeded"),
    ]

    evening = datetime(2026, 10, 5, 23, tzinfo=NY)
    run_autopay(db, evening)
    run_autopay(db, evening)
    [call] = stripe_fake.named("charge_saved_card")
    assert call["amount_cents"] == 17500
    assert call["metadata"]["purpose"] == "autopay"
    assert call["metadata"]["practice_id"] == str(clinician.practice_id)
    assert call["description"] == "Payment to Lee Counseling"
    stored = db.get_one(Client, client.id)
    db.refresh(stored)
    assert (stored.autopay_failures, stored.last_autopay_attempt_on) == (0, date(2026, 10, 5))
    [payment] = _payments(db, client.id)
    assert (payment.status, payment.allocated_cents) == ("succeeded", 17500)

    _invoice(api, clinician, client.id, 4000)
    run_autopay(db, datetime(2026, 10, 5, 23, 59, tzinfo=NY))
    assert len(stripe_fake.named("charge_saved_card")) == 1
    run_autopay(db, datetime(2026, 10, 6, 0, 1, tzinfo=NY))
    assert stripe_fake.named("charge_saved_card")[-1]["amount_cents"] == 4000


def test_autopay_receipts_go_to_a_minors_billing_contact(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = _autopay_client(api, clinician, db)
    db.get_one(Client, client.id).is_minor = True
    db.add(
        ClientContact(
            client_id=client.id,
            first_name="Maria",
            last_name="Rivera",
            email="maria@example.com",
            is_guardian=True,
            responsible_for_billing=True,
            portal_access=True,
        )
    )
    db.commit()
    _invoice(api, clinician, client.id, 6000)
    stripe_fake.charge_outcomes = [ChargeResult("pi_minor", "succeeded")]

    run_autopay(db, datetime(2026, 10, 5, 23, tzinfo=NY))

    [receipt] = outbound_to(db, "maria@example.com")
    assert receipt.subject == "We received your payment"
    assert "/client/sign-in?next=%2Fclient%2Fbilling" in receipt.body_text
    assert "$60.00" not in receipt.body_text
    assert outbound_to(db, "alex@example.com") == []


def test_autopay_turns_off_after_three_declines(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = _autopay_client(api, clinician, db)
    team = _billing_team(db, clinician, client)
    _invoice(api, clinician, client.id, 8000)
    declined = PaymentError("Your card was declined.", declined=True)
    outage = PaymentError("The payment processor couldn't complete the request.")
    stripe_fake.charge_outcomes = [declined, outage, declined, declined]

    for day in (1, 2, 3):
        run_autopay(db, datetime(2026, 10, day, 1, tzinfo=NY))
        stored = db.get_one(Client, client.id)
        db.refresh(stored)
        assert stored.autopay_enabled is True
    # The outage on day 2 didn't count against the card.
    assert stored.autopay_failures == 2
    assert outbound_to(db, clinician.email) == []

    run_autopay(db, datetime(2026, 10, 4, 1, tzinfo=NY))
    db.refresh(stored)
    assert (stored.autopay_enabled, stored.autopay_failures) == (False, 0)
    [notice] = outbound_to(db, clinician.email)
    assert notice.subject == "AutoPay was turned off for a client"
    assert "Rivera" not in notice.body_text
    assert [p.status for p in _payments(db, client.id)] == ["failed"] * 4
    # Everyone who handles this client's billing hears about it; nobody else does.
    for member in team.handles:
        [email] = outbound_to(db, member.email)
        assert email.subject == "AutoPay was turned off for a client"
    for member in team.others:
        assert outbound_to(db, member.email) == []
    assert _notified(db, "autopay_disabled") == {member.id for member in team.handles}

    run_autopay(db, datetime(2026, 10, 5, 1, tzinfo=NY))
    assert len(stripe_fake.named("charge_saved_card")) == 4


def test_autopay_skips_ineligible_clients(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = _autopay_client(api, clinician, db)
    no_card = create_client_record(
        db, clinician, first_name="Sam", email="sam@example.com", autopay_enabled=True
    )
    opted_out = create_client_record(db, clinician, first_name="Kim", email="kim@example.com")
    _card(db, opted_out, MASTERCARD)
    for someone in (client, no_card, opted_out):
        _invoice(api, clinician, someone.id, 5000)
    db.get_one(PracticeSettings, clinician.practice_id).autopay_enabled = False
    db.commit()
    run_autopay(db, datetime(2026, 10, 5, 1, tzinfo=NY))
    assert stripe_fake.named("charge_saved_card") == []

    db.get_one(PracticeSettings, clinician.practice_id).autopay_enabled = True
    db.commit()
    stripe_fake.charge_outcomes = [ChargeResult("pi_only", "succeeded")]
    run_autopay(db, datetime(2026, 10, 5, 1, tzinfo=NY))
    [call] = stripe_fake.named("charge_saved_card")
    assert call["metadata"]["client_id"] == str(client.id)


def test_autopay_skips_practices_without_an_active_owner(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    client = _autopay_client(api, clinician, db)
    _invoice(api, clinician, client.id, 5000)
    db.get_one(StaffMember, clinician.id).status = "deactivated"
    db.commit()
    run_autopay(db, datetime(2026, 10, 5, 1, tzinfo=NY))
    assert stripe_fake.named("charge_saved_card") == []


def test_autopay_does_nothing_without_stripe(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _autopay_client(api, clinician, db)
    _invoice(api, clinician, client.id, 5000)
    run_autopay(db, datetime.now(UTC))
    assert _payments(db, client.id) == []


def test_worker_invoices_before_autopay(
    api: TestClient, clinician: StaffAccount, db: Session, stripe_fake: FakeStripe
) -> None:
    assert JOBS.index(create_daily_invoices) < JOBS.index(run_autopay)
    client = _autopay_client(api, clinician, db)
    create_appointment(
        db,
        clinician,
        [client],
        starts_at=datetime(2026, 10, 5, 10, tzinfo=NY),
        minutes=60,
        fee_cents=12000,
        status="attended",
    )
    stripe_fake.charge_outcomes = [ChargeResult("pi_night", "succeeded")]
    midnight = datetime(2026, 10, 6, 0, 1, tzinfo=NY)
    for job in (create_daily_invoices, run_autopay):
        job(db, midnight)
    [call] = stripe_fake.named("charge_saved_card")
    assert call["amount_cents"] == 12000
    [invoice] = db.scalars(select(Invoice).where(Invoice.client_id == client.id)).all()
    db.refresh(invoice)
    assert invoice.status == "paid"


def test_staff_choose_default_card_and_see_autopay_failures(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    first = SavedCard(client_id=client.id, stripe_payment_method_id="pm_a", is_default=True)
    second = SavedCard(client_id=client.id, stripe_payment_method_id="pm_b", is_default=False)
    db.add_all([first, second])
    client.autopay_failures = 2
    db.commit()
    response = api.post(f"/api/billing/cards/{second.id}/default", headers=clinician.headers)
    assert response.status_code == 200 and response.json()["is_default"] is True
    db.expire_all()
    assert db.get(SavedCard, first.id).is_default is False
    summary = api.get(f"/api/billing/clients/{client.id}/summary", headers=clinician.headers).json()
    assert summary["autopay_failures"] == 2
    other = register_practice(api, email="other-cards@example.com")
    assert (
        api.post(f"/api/billing/cards/{first.id}/default", headers=other.headers).status_code == 404
    )


def test_manual_payments_cannot_be_dated_in_the_future(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    future = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    response = api.post(
        "/api/billing/payments",
        json={
            "client_id": client.id,
            "amount_cents": 1000,
            "method": "cash",
            "received_at": future,
        },
        headers=clinician.headers,
    )
    assert response.status_code == 422
