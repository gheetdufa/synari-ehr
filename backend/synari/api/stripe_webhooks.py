"""Stripe webhook receiver.

Configure an endpoint in the Stripe dashboard pointing at POST /api/webhooks/stripe, subscribed
to the events in HANDLERS, and put its signing secret in STRIPE_WEBHOOK_SECRET. Every handler
is idempotent, so Stripe's retries and replays never double-count a payment or refund.
"""

import logging
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from synari.config import settings
from synari.deps import DbSession
from synari.schemas.common import Message
from synari.services import payments
from synari.services.billing import (
    card_label,
    client_from_metadata,
    record_card_failure,
    record_card_success,
    save_card,
    sync_card_refund,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])


async def raw_body(request: Request) -> bytes:
    """The exact request bytes, which the signature is computed over."""
    return await request.body()


def _metadata(stripe_object: Mapping[str, Any]) -> Mapping[str, object]:
    metadata = stripe_object.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _checkout_completed(db: Session, session: Mapping[str, Any]) -> None:
    metadata = _metadata(session)
    if session.get("mode") == "setup":
        setup_intent_id = session.get("setup_intent")
        client = client_from_metadata(db, metadata)
        if not isinstance(setup_intent_id, str) or client is None:
            return
        card = payments.setup_intent_card(setup_intent_id)
        if card is not None:
            save_card(db, client, card)
        return
    payment_intent_id = session.get("payment_intent")
    amount = session.get("amount_total")
    if session.get("mode") != "payment" or session.get("payment_status") != "paid":
        return
    if not isinstance(payment_intent_id, str) or not isinstance(amount, int):
        return
    payment = record_card_success(
        db, payment_intent_id=payment_intent_id, amount_cents=amount, metadata=metadata
    )
    if payment is None:
        return
    card = payments.payment_intent_card(payment_intent_id)
    if card is None:
        return
    if not payment.reference:
        payment.reference = card_label(card.brand, card.last4)
    if metadata.get("save_card") == "1":
        save_card(db, payment.client, card)


def _payment_intent_succeeded(db: Session, intent: Mapping[str, Any]) -> None:
    payment_intent_id = intent.get("id")
    amount = intent.get("amount_received")
    if not isinstance(payment_intent_id, str) or not isinstance(amount, int):
        return
    record_card_success(
        db, payment_intent_id=payment_intent_id, amount_cents=amount, metadata=_metadata(intent)
    )


def _payment_intent_failed(db: Session, intent: Mapping[str, Any]) -> None:
    payment_intent_id = intent.get("id")
    if not isinstance(payment_intent_id, str):
        return
    error = intent.get("last_payment_error")
    reason = error.get("message", "") if isinstance(error, dict) else ""
    record_card_failure(
        db,
        payment_intent_id=payment_intent_id,
        metadata=_metadata(intent),
        reason=reason if isinstance(reason, str) else "",
    )


def _charge_refunded(db: Session, charge: Mapping[str, Any]) -> None:
    payment_intent_id = charge.get("payment_intent")
    amount_refunded = charge.get("amount_refunded")
    if not isinstance(payment_intent_id, str) or not isinstance(amount_refunded, int):
        return
    sync_card_refund(db, payment_intent_id=payment_intent_id, amount_refunded=amount_refunded)


HANDLERS: dict[str, Callable[[Session, Mapping[str, Any]], None]] = {
    "checkout.session.completed": _checkout_completed,
    "payment_intent.succeeded": _payment_intent_succeeded,
    "payment_intent.payment_failed": _payment_intent_failed,
    "charge.refunded": _charge_refunded,
}


@router.post("/webhooks/stripe", response_model=Message)
def stripe_webhook(
    db: DbSession,
    payload: bytes = Depends(raw_body),
    stripe_signature: str = Header(default=""),
) -> Message:
    """Verify and apply one Stripe event. Unknown events are acknowledged and ignored."""
    if not settings.stripe_enabled or not settings.stripe_webhook_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Online payments aren't configured"
        )
    event = payments.parse_webhook(payload, stripe_signature)
    if event is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Stripe signature")
    data = event.get("data")
    stripe_object = data.get("object") if isinstance(data, dict) else None
    handler = HANDLERS.get(str(event.get("type")))
    if handler is None or not isinstance(stripe_object, dict):
        return Message(detail="Ignored")
    try:
        handler(db, stripe_object)
    except payments.PaymentError as exc:
        # Looking up card details failed; Stripe retries the event later.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
    db.commit()
    return Message(detail="Processed")
