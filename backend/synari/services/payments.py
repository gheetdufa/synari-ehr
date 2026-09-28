"""The Stripe boundary: every call to Stripe goes through this module.

Functions take and return plain values so the rest of the app (and the tests, which replace
these functions) never touch Stripe objects. Stripe failures surface as `PaymentError`.
"""

import json
import logging
from dataclasses import dataclass
from functools import cache
from typing import Any

import stripe
from stripe.params import CustomerCreateParams, PaymentIntentCreateParams
from stripe.params.checkout import SessionCreateParams, SessionCreateParamsPaymentIntentData

from synari.config import settings

logger = logging.getLogger(__name__)

WEBHOOK_TOLERANCE_SECONDS = 300


class PaymentError(Exception):
    """A Stripe request failed. `declined` means the card was refused (the client must act)."""

    def __init__(self, message: str, *, declined: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.declined = declined


@dataclass(frozen=True)
class CardDetails:
    """The display details of a card saved in Stripe."""

    payment_method_id: str
    brand: str
    last4: str
    exp_month: int
    exp_year: int


@dataclass(frozen=True)
class ChargeResult:
    """The outcome of an off-session charge: Stripe's PaymentIntent id and status."""

    payment_intent_id: str
    status: str


@cache
def _client_for(api_key: str) -> stripe.StripeClient:
    return stripe.StripeClient(api_key, max_network_retries=2)


def _stripe() -> stripe.StripeClient:
    return _client_for(settings.stripe_secret_key)


def _translate(exc: stripe.StripeError) -> PaymentError:
    if isinstance(exc, stripe.CardError):
        return PaymentError(exc.user_message or "The card was declined.", declined=True)
    logger.warning("Stripe request failed: %s", exc)
    return PaymentError("The payment processor couldn't complete the request. Please try again.")


def _card_details(payment_method: stripe.PaymentMethod | str | None) -> CardDetails | None:
    if not isinstance(payment_method, stripe.PaymentMethod) or payment_method.card is None:
        return None
    card = payment_method.card
    return CardDetails(
        payment_method_id=payment_method.id,
        brand=card.brand,
        last4=card.last4,
        exp_month=card.exp_month,
        exp_year=card.exp_year,
    )


def create_customer(*, name: str, email: str | None, metadata: dict[str, str]) -> str:
    """Create a Stripe Customer and return its id."""
    params: CustomerCreateParams = {"name": name, "metadata": metadata}
    if email:
        params["email"] = email
    try:
        customer = _stripe().v1.customers.create(params=params)
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    return customer.id


def create_payment_checkout(
    *,
    customer_id: str,
    amount_cents: int,
    product_name: str,
    metadata: dict[str, str],
    save_card: bool,
    success_url: str,
    cancel_url: str,
) -> str:
    """Create a hosted Checkout page for a one-off card payment and return its URL."""
    intent_data: SessionCreateParamsPaymentIntentData = {"metadata": metadata}
    if save_card:
        intent_data["setup_future_usage"] = "off_session"
    params: SessionCreateParams = {
        "mode": "payment",
        "customer": customer_id,
        "payment_method_types": ["card"],
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": settings.stripe_currency,
                    "unit_amount": amount_cents,
                    "product_data": {"name": product_name},
                },
            }
        ],
        "payment_intent_data": intent_data,
        "metadata": metadata,
        "success_url": success_url,
        "cancel_url": cancel_url,
    }
    try:
        session = _stripe().v1.checkout.sessions.create(params=params)
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    if not session.url:
        raise PaymentError("The payment page couldn't be created. Please try again.")
    return session.url


def create_setup_checkout(
    *, customer_id: str, metadata: dict[str, str], success_url: str, cancel_url: str
) -> str:
    """Create a hosted Checkout page that saves a card for later and return its URL."""
    params: SessionCreateParams = {
        "mode": "setup",
        "customer": customer_id,
        "payment_method_types": ["card"],
        "setup_intent_data": {"metadata": metadata},
        "metadata": metadata,
        "success_url": success_url,
        "cancel_url": cancel_url,
    }
    try:
        session = _stripe().v1.checkout.sessions.create(params=params)
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    if not session.url:
        raise PaymentError("The card page couldn't be created. Please try again.")
    return session.url


def charge_saved_card(
    *,
    customer_id: str,
    payment_method_id: str,
    amount_cents: int,
    description: str,
    metadata: dict[str, str],
    idempotency_key: str,
) -> ChargeResult:
    """Charge a saved card without the client present (confirmed immediately)."""
    params: PaymentIntentCreateParams = {
        "amount": amount_cents,
        "currency": settings.stripe_currency,
        "customer": customer_id,
        "payment_method": payment_method_id,
        "off_session": True,
        "confirm": True,
        "description": description,
        "metadata": metadata,
    }
    try:
        intent = _stripe().v1.payment_intents.create(
            params=params, options={"idempotency_key": idempotency_key}
        )
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    return ChargeResult(payment_intent_id=intent.id, status=intent.status)


def refund_payment(*, payment_intent_id: str, amount_cents: int, idempotency_key: str) -> None:
    """Refund part or all of a card payment to the original card."""
    try:
        _stripe().v1.refunds.create(
            params={"payment_intent": payment_intent_id, "amount": amount_cents},
            options={"idempotency_key": idempotency_key},
        )
    except stripe.StripeError as exc:
        raise _translate(exc) from exc


def detach_card(payment_method_id: str) -> None:
    """Remove a saved card from its Stripe Customer (already-detached cards are fine)."""
    try:
        _stripe().v1.payment_methods.detach(payment_method_id)
    except stripe.InvalidRequestError as exc:
        logger.warning("Stripe could not detach %s: %s", payment_method_id, exc)
    except stripe.StripeError as exc:
        raise _translate(exc) from exc


def payment_intent_card(payment_intent_id: str) -> CardDetails | None:
    """The card used for a PaymentIntent, if it was a card."""
    try:
        intent = _stripe().v1.payment_intents.retrieve(
            payment_intent_id, params={"expand": ["payment_method"]}
        )
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    return _card_details(intent.payment_method)


def setup_intent_card(setup_intent_id: str) -> CardDetails | None:
    """The card a completed SetupIntent saved, if it was a card."""
    try:
        intent = _stripe().v1.setup_intents.retrieve(
            setup_intent_id, params={"expand": ["payment_method"]}
        )
    except stripe.StripeError as exc:
        raise _translate(exc) from exc
    return _card_details(intent.payment_method)


def parse_webhook(payload: bytes, signature: str) -> dict[str, Any] | None:
    """Verify a webhook's Stripe-Signature header and return the event, or None if invalid."""
    try:
        text = payload.decode("utf-8")
        stripe.WebhookSignature.verify_header(
            text, signature, settings.stripe_webhook_secret, WEBHOOK_TOLERANCE_SECONDS
        )
        event = json.loads(text)
    except (stripe.SignatureVerificationError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return event if isinstance(event, dict) else None
