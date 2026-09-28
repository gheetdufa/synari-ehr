"""Client-portal billing: balance, invoices, payments, superbills, online payment and cards.

Every route needs the client's billing permission and only ever returns the client's own
records. A guardian or other contact with portal access signs in on the client's behalf and
gets the same view (CurrentClient resolves their token to the client). Clients can add cards
and pick a default but can't delete cards (practice staff can). Payments go to the client's
practice, under its name and settings.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.api.billing import invoice_views, pdf_response, require_online_payments
from synari.audit import audit_client
from synari.config import settings
from synari.deps import CurrentClient, DbSession
from synari.models import Client, Invoice, Payment, SavedCard, Superbill
from synari.models.enums import InvoiceStatus, PaymentStatus
from synari.schemas.billing import (
    CheckoutCreate,
    CheckoutOut,
    InvoiceOut,
    PaymentOut,
    PortalBillingSummary,
    SavedCardOut,
    SuperbillOut,
)
from synari.services import payments
from synari.services.billing import (
    CLIENT_BILLING_PATH,
    MIN_CARD_CHARGE_CENTS,
    billing_changed,
    client_balance_cents,
    client_cards,
    client_credit_cents,
    default_card,
    ensure_stripe_customer,
    format_money,
    lock_client,
    make_default_card,
)
from synari.services.billing_pdf import invoice_pdf, superbill_pdf

router = APIRouter(prefix="/portal/billing", tags=["portal billing"])


def billing_client(client: CurrentClient) -> Client:
    """The signed-in client, if their practice lets them see billing in the portal."""
    if not client.portal_billing:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Billing isn't available in your portal")
    return client


BillingClient = Annotated[Client, Depends(billing_client)]


def _portal_url(query: str) -> str:
    return f"{settings.frontend_url.rstrip('/')}{CLIENT_BILLING_PATH}?{query}"


def _own_invoice(db: Session, client: Client, invoice_id: int) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.client_id != client.id or invoice.status == InvoiceStatus.VOID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    return invoice


def _own_superbill(db: Session, client: Client, superbill_id: int) -> Superbill:
    superbill = db.get(Superbill, superbill_id)
    if superbill is None or superbill.client_id != client.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Superbill not found")
    return superbill


@router.get("/summary", response_model=PortalBillingSummary)
def portal_summary(client: BillingClient, db: DbSession, request: Request) -> PortalBillingSummary:
    """The client's balance, credit and default card, and whether they can pay online."""
    card = default_card(db, client.id)
    summary = PortalBillingSummary(
        balance_cents=client_balance_cents(db, client.id),
        credit_cents=client_credit_cents(db, client.id),
        payments_enabled=settings.stripe_enabled,
        autopay_enabled=client.autopay_enabled and client.practice.settings.autopay_enabled,
        default_card=SavedCardOut.model_validate(card) if card is not None else None,
    )
    audit_client(db, request, client, "billing.summary_view", "client", client.id)
    db.commit()
    return summary


@router.get("/invoices", response_model=list[InvoiceOut])
def portal_invoices(client: BillingClient, db: DbSession, request: Request) -> list[InvoiceOut]:
    """The client's invoices (voided ones hidden), newest first, naming each line's clinician."""
    invoices = list(
        db.scalars(
            select(Invoice)
            .where(Invoice.client_id == client.id, Invoice.status != InvoiceStatus.VOID)
            .order_by(Invoice.issued_on.desc(), Invoice.id.desc())
        )
    )
    audit_client(db, request, client, "invoice.list", "invoice")
    db.commit()
    views = invoice_views(db, invoices)
    for view in views:
        view.gfe_override_reason = ""  # staff's note, not the client's
    return views


@router.get("/invoices/{invoice_id}/pdf")
def portal_invoice_pdf(
    invoice_id: int, client: BillingClient, db: DbSession, request: Request
) -> Response:
    invoice = _own_invoice(db, client, invoice_id)
    content = invoice_pdf(db, invoice)
    audit_client(db, request, client, "invoice.download", "invoice", invoice.id)
    db.commit()
    return pdf_response(content, invoice.number)


@router.get("/payments", response_model=list[PaymentOut])
def portal_payments(client: BillingClient, db: DbSession, request: Request) -> list[Payment]:
    """The client's payments and refunds (failed attempts hidden), newest first."""
    found = list(
        db.scalars(
            select(Payment)
            .where(Payment.client_id == client.id, Payment.status != PaymentStatus.FAILED)
            .order_by(Payment.created_at.desc(), Payment.id.desc())
        )
    )
    audit_client(db, request, client, "payment.list", "payment")
    db.commit()
    return found


@router.get("/superbills", response_model=list[SuperbillOut])
def portal_superbills(client: BillingClient, db: DbSession, request: Request) -> list[Superbill]:
    found = list(
        db.scalars(
            select(Superbill)
            .where(Superbill.client_id == client.id)
            .order_by(Superbill.period_end.desc(), Superbill.id.desc())
        )
    )
    audit_client(db, request, client, "superbill.list", "superbill")
    db.commit()
    return found


@router.get("/superbills/{superbill_id}/pdf")
def portal_superbill_pdf(
    superbill_id: int, client: BillingClient, db: DbSession, request: Request
) -> Response:
    superbill = _own_superbill(db, client, superbill_id)
    content = superbill_pdf(superbill)
    audit_client(db, request, client, "superbill.download", "superbill", superbill.id)
    db.commit()
    return pdf_response(content, superbill.number)


@router.post("/checkout", response_model=CheckoutOut)
def start_checkout(
    body: CheckoutCreate, client: BillingClient, db: DbSession, request: Request
) -> CheckoutOut:
    """Open a Stripe Checkout page for one invoice, a chosen amount, or the whole balance."""
    require_online_payments()
    balance = client_balance_cents(db, client.id)
    if body.invoice_id is not None:
        invoice = _own_invoice(db, client, body.invoice_id)
        amount = invoice.balance_cents
    elif body.amount_cents is not None:
        if body.amount_cents > balance:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"You can pay up to your balance of {format_money(balance)}",
            )
        amount = body.amount_cents
    else:
        amount = balance
    if amount <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "There's nothing to pay right now")
    if amount < MIN_CARD_CHARGE_CENTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Online payments must be at least {format_money(MIN_CARD_CHARGE_CENTS)}",
        )
    metadata = {
        "practice_id": str(client.practice_id),
        "client_id": str(client.id),
        "purpose": "portal_payment",
        "save_card": "1" if body.save_card else "0",
    }
    if body.invoice_id is not None:
        metadata["invoice_id"] = str(body.invoice_id)
    try:
        customer_id = ensure_stripe_customer(db, client)
        url = payments.create_payment_checkout(
            customer_id=customer_id,
            amount_cents=amount,
            product_name=f"Payment to {client.practice.name}",
            metadata=metadata,
            save_card=body.save_card,
            success_url=_portal_url("payment=success"),
            cancel_url=_portal_url("payment=canceled"),
        )
    except payments.PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    audit_client(
        db, request, client, "payment.checkout", "client", client.id, {"amount_cents": amount}
    )
    db.commit()
    return CheckoutOut(url=url)


@router.post("/cards/setup", response_model=CheckoutOut)
def start_card_setup(client: BillingClient, db: DbSession, request: Request) -> CheckoutOut:
    """Open a Stripe Checkout page that saves a card for future payments and AutoPay."""
    require_online_payments()
    try:
        customer_id = ensure_stripe_customer(db, client)
        url = payments.create_setup_checkout(
            customer_id=customer_id,
            metadata={
                "practice_id": str(client.practice_id),
                "client_id": str(client.id),
                "purpose": "save_card",
            },
            success_url=_portal_url("card=saved"),
            cancel_url=_portal_url("card=canceled"),
        )
    except payments.PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    audit_client(db, request, client, "card.setup", "client", client.id)
    db.commit()
    return CheckoutOut(url=url)


@router.get("/cards", response_model=list[SavedCardOut])
def portal_cards(client: BillingClient, db: DbSession, request: Request) -> list[SavedCard]:
    cards = client_cards(db, client.id)
    audit_client(db, request, client, "card.list", "client", client.id)
    db.commit()
    return cards


@router.post("/cards/{card_id}/default", response_model=list[SavedCardOut])
def portal_set_default_card(
    card_id: int, client: BillingClient, db: DbSession, request: Request
) -> list[SavedCard]:
    """Choose the card used for AutoPay and quick charges; returns the updated card list."""
    card = db.get(SavedCard, card_id)
    if card is None or card.client_id != client.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
    lock_client(db, client.id)
    make_default_card(db, card)
    billing_changed(db, client)
    audit_client(db, request, client, "card.set_default", "saved_card", card.id)
    db.commit()
    return client_cards(db, client.id)
