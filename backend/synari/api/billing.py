"""Staff billing: invoices, payments, refunds, saved cards, balances and superbills.

Everything here needs billing access to the client (see synari/access.py): staff with
practice-wide billing reach every client, clinicians with billing access reach the clients on
their care team. Lists and totals without any billing access are a 403; a record the person
can't reach is a 404.
"""

from collections.abc import Sequence
from datetime import UTC

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session, contains_eager, selectinload

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentAllocation,
    SavedCard,
    Superbill,
)
from synari.models.enums import (
    BILLABLE_APPOINTMENT_STATUSES,
    RECEIVED_PAYMENT_STATUSES,
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    InvoiceItemKind,
    InvoiceStatus,
    PaymentMethod,
    PaymentStatus,
)
from synari.pagination import ListPage, QueuePage, count_rows, paginate
from synari.permissions import Capability
from synari.schemas.appointments import ClientRef
from synari.schemas.billing import (
    BillingOverview,
    ChargeCreate,
    ClientBillingSummary,
    InvoiceCreate,
    InvoiceOut,
    PaymentCreate,
    PaymentOut,
    RefundCreate,
    SavedCardOut,
    SuperbillCreate,
    SuperbillOut,
    UninvoicedSessionOut,
)
from synari.schemas.estimates import EstimateCheckOut
from synari.services import payments
from synari.services.billing import (
    MIN_CARD_CHARGE_CENTS,
    apply_client_credit,
    apply_refund,
    bill_to_contacts,
    billable_statuses,
    billing_changed,
    build_superbill,
    charge_saved_card,
    client_balance_cents,
    client_cards,
    client_credit_cents,
    client_share_cents,
    create_invoice,
    default_card,
    format_money,
    is_on_active_invoice,
    line_appointments,
    line_clinicians,
    local_date,
    local_midnight,
    lock_client,
    lock_practice_settings,
    make_default_card,
    mark_payment_received,
    next_superbill_number,
    notify_new_invoice,
    open_invoices,
    owed_cents_sql,
    remove_card,
    send_payment_receipt,
    service_line,
    uninvoiced_participants,
)
from synari.services.billing_pdf import invoice_pdf, superbill_pdf
from synari.services.estimate_billing import (
    EstimateCheck,
    check_invoice,
    override_required_detail,
    record_overage,
    session_warnings,
)
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/billing", tags=["billing"])

RECENT_PAYMENTS = 10


def require_online_payments() -> None:
    """Card features need Stripe; 503 when it isn't configured."""
    if not settings.stripe_enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Online payments aren't configured"
        )


def pdf_response(content: bytes, number: str) -> Response:
    """A PDF download named after the document number."""
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{number}.pdf"'},
    )


def invoice_views(db: Session, invoices: Sequence[Invoice]) -> list[InvoiceOut]:
    """Invoices as returned by the API.

    Each invoice names the contact it's addressed to; each line names its recorded clinician
    and, for sessions, the appointment.
    """
    clinicians = line_clinicians(db, invoices)
    appointments = line_appointments(db, invoices)
    contacts = bill_to_contacts(db, invoices)
    views = []
    for invoice in invoices:
        view = InvoiceOut.model_validate(invoice)
        if invoice.bill_to_contact_id is not None and invoice.bill_to_contact_id in contacts:
            view.bill_to_name = contacts[invoice.bill_to_contact_id].full_name
        for item in view.items:
            if item.participant_id is not None:
                item.appointment_id = appointments.get(item.participant_id)
            if item.clinician_id is not None and item.clinician_id in clinicians:
                item.clinician_name = clinicians[item.clinician_id].display_name
        views.append(view)
    return views


def _require_billing(access: Access) -> None:
    """403 unless the role has billing access to at least some clients."""
    if not (access.can(Capability.BILLING_ALL) or access.can(Capability.BILLING_OWN)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't include billing")


def _billing_client(access: Access, client_id: int, label: str = "Client") -> Client:
    return access.client(client_id, ClientAccess.BILLING, label=label)


def _billable_participant(
    access: Access, client: Client, participant_id: int
) -> AppointmentParticipant:
    """The client's past session (by participant id) that can go on a new invoice."""
    participant = access.db.get(AppointmentParticipant, participant_id)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    appointment = access.get(Appointment, participant.appointment_id, label="Session")
    if appointment.kind != AppointmentKind.APPOINTMENT or participant.client_id != client.id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "That session isn't for this client"
        )
    if not participant.billable:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "This client isn't billed for that session"
        )
    if appointment.source == BookingSource.IMPORT:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "That session was imported; it was billed before it came to Synari",
        )
    if participant.effective_status not in BILLABLE_APPOINTMENT_STATUSES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Only attended, no-show and late-canceled sessions can be invoiced",
        )
    if client_share_cents(access.db, participant) <= 0:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "The client owes nothing for that session"
        )
    if is_on_active_invoice(access.db, participant.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "That session is already invoiced")
    return participant


def _uninvoiced(
    access: Access, client_id: int | None = None
) -> Select[tuple[AppointmentParticipant, int]]:
    """Past billable sessions not on a live invoice, with what each client owes.

    Over the clients whose billing this person sees; sessions a client owes nothing for (a $0
    copay) are left out. Ordered by client, then oldest session first, so each client's
    sessions are together.
    """
    practice = access.staff.practice
    owed = owed_cents_sql(zone_of(practice))
    query = (
        uninvoiced_participants(practice.id, billable_statuses(practice.settings), utcnow())
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(access.client_filter(ClientAccess.BILLING), owed > 0)
        .add_columns(owed)
        .order_by(
            Client.last_name,
            Client.first_name,
            Client.id,
            Appointment.starts_at,
            AppointmentParticipant.id,
        )
    )
    if client_id is not None:
        query = query.where(AppointmentParticipant.client_id == client_id)
    return query


def _uninvoiced_view(
    participant: AppointmentParticipant, amount_cents: int, estimate_warning: str = ""
) -> UninvoicedSessionOut:
    appointment = participant.appointment
    return UninvoicedSessionOut(
        participant_id=participant.id,
        appointment_id=appointment.id,
        client=ClientRef.model_validate(participant.client),
        clinician_id=appointment.clinician_id,
        clinician_name=appointment.clinician.display_name,
        starts_at=appointment.starts_at,
        ends_at=appointment.ends_at,
        service_code=appointment.service_code,
        service_description=appointment.service_description,
        status=AppointmentStatus(participant.effective_status),
        amount_cents=amount_cents,
        estimate_warning=estimate_warning,
    )


def _card(access: Access, card_id: int) -> SavedCard:
    card = access.db.get(SavedCard, card_id)
    if card is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
    _billing_client(access, card.client_id, label="Card")
    return card


# Overview and client summary ---------------------------------------------------------------


@router.get("/overview", response_model=BillingOverview)
def billing_overview(access: CurrentAccess, db: DbSession) -> BillingOverview:
    """Totals for the billing dashboard, over the clients whose billing this person sees."""
    _require_billing(access)
    practice = access.staff.practice
    reachable = access.client_filter(ClientAccess.BILLING)
    zone = zone_of(practice)
    today = local_date(utcnow(), zone)
    month_start = local_midnight(today.replace(day=1), zone)
    outstanding, open_count = db.execute(
        select(
            func.coalesce(func.sum(Invoice.total_cents - Invoice.paid_cents), 0),
            func.count(Invoice.id),
        )
        .join(Client, Client.id == Invoice.client_id)
        .where(Invoice.practice_id == practice.id, reachable, Invoice.status == InvoiceStatus.OPEN)
    ).one()
    collected = db.scalar(
        select(func.coalesce(func.sum(Payment.amount_cents - Payment.refunded_cents), 0))
        .join(Client, Client.id == Payment.client_id)
        .where(
            Payment.practice_id == practice.id,
            reachable,
            Payment.status.in_(RECEIVED_PAYMENT_STATUSES),
            Payment.received_at >= month_start,
        )
    )
    return BillingOverview(
        outstanding_cents=int(outstanding),
        collected_this_month_cents=int(collected or 0),
        open_invoice_count=int(open_count),
        uninvoiced_count=count_rows(db, _uninvoiced(access)),
    )


@router.get("/uninvoiced", response_model=list[UninvoicedSessionOut])
def list_uninvoiced(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: QueuePage,
    response: Response,
    client_id: int | None = Query(default=None),
) -> list[UninvoicedSessionOut]:
    """A page of clients' past billable sessions that aren't on an invoice yet (voided ones
    included), by client and then date.

    One row per billed participant: a group session lists each member. Self-pay clients'
    sessions note when no good faith estimate covers them or they near or pass it.
    """
    _require_billing(access)
    query = _uninvoiced(access, client_id).options(
        contains_eager(AppointmentParticipant.appointment).joinedload(Appointment.clinician),
        contains_eager(AppointmentParticipant.client),
    )
    rows = db.execute(paginate(db, query, page, response)).all()
    # Estimate warnings add up each client's sessions in order, so they're worked out over all
    # uninvoiced sessions of the clients on this page, not just the page's rows.
    page_clients = {participant.client_id for participant, _ in rows}
    warnings = (
        session_warnings(
            db,
            db.execute(query.where(AppointmentParticipant.client_id.in_(page_clients))).all(),
        )
        if page_clients
        else {}
    )
    sessions = [
        _uninvoiced_view(participant, amount, warnings.get(participant.id, ""))
        for participant, amount in rows
    ]
    audit_staff_list(
        db,
        request,
        access.staff,
        "billing.uninvoiced_list",
        (participant.client_id for participant, _ in rows),
        detail={"client_id": client_id},
    )
    db.commit()
    return sessions


@router.get("/clients/{client_id}/summary", response_model=ClientBillingSummary)
def client_summary(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> ClientBillingSummary:
    """A client's balance, credit, open invoices, recent payments and saved cards."""
    client = _billing_client(access, client_id)
    recent = db.scalars(
        select(Payment)
        .where(Payment.client_id == client.id)
        .order_by(Payment.created_at.desc(), Payment.id.desc())
        .limit(RECENT_PAYMENTS)
    ).all()
    summary = ClientBillingSummary(
        client_id=client.id,
        balance_cents=client_balance_cents(db, client.id),
        credit_cents=client_credit_cents(db, client.id),
        open_invoices=invoice_views(db, open_invoices(db, client.id)),
        recent_payments=[PaymentOut.model_validate(p) for p in recent],
        saved_cards=[SavedCardOut.model_validate(c) for c in client_cards(db, client.id)],
        autopay_enabled=client.autopay_enabled,
        autopay_failures=client.autopay_failures,
        payments_enabled=settings.stripe_enabled,
    )
    audit_staff(
        db, request, access.staff, "billing.summary_view", "client", client.id, client_id=client.id
    )
    db.commit()
    return summary


# Invoices ----------------------------------------------------------------------------------


@router.get("/invoices", response_model=list[InvoiceOut])
def list_invoices(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    client_id: int | None = Query(default=None),
    status_filter: InvoiceStatus | None = Query(default=None, alias="status"),
) -> list[InvoiceOut]:
    """A page of the invoices of the clients whose billing this person sees, newest first."""
    _require_billing(access)
    query = (
        select(Invoice)
        .join(Client, Client.id == Invoice.client_id)
        .where(
            Invoice.practice_id == access.practice_id,
            access.client_filter(ClientAccess.BILLING),
        )
        .options(selectinload(Invoice.client))
    )
    if client_id is not None:
        query = query.where(Invoice.client_id == client_id)
    if status_filter is not None:
        query = query.where(Invoice.status == status_filter)
    ordered = query.order_by(Invoice.issued_on.desc(), Invoice.id.desc())
    invoices = list(db.scalars(paginate(db, ordered, page, response)))
    audit_staff_list(
        db,
        request,
        access.staff,
        "invoice.list",
        (i.client_id for i in invoices),
        detail={"client_id": client_id, "status": status_filter},
    )
    db.commit()
    return invoice_views(db, invoices)


def _invoice_lines(access: Access, client: Client, body: InvoiceCreate) -> list[InvoiceItem]:
    """The lines a manual invoice would have: the chosen sessions, then custom lines."""
    zone = zone_of(client.practice)
    sessions = [
        _billable_participant(access, client, participant_id)
        for participant_id in body.participant_ids
    ]
    items = [service_line(access.db, participant, zone) for participant in sessions]
    items += [
        InvoiceItem(
            kind=InvoiceItemKind.CUSTOM,
            service_date=line.service_date,
            service_code=line.service_code.strip(),
            description=line.description.strip(),
            amount_cents=line.amount_cents,
        )
        for line in body.items
    ]
    return items


def _check_out(check: EstimateCheck) -> EstimateCheckOut:
    return EstimateCheckOut(
        warnings=check.warnings,
        override_required=check.override_required,
        over_by_cents=check.over_by_cents,
    )


@router.post("/invoices/estimate-check", response_model=EstimateCheckOut)
def check_invoice_estimates(
    body: InvoiceCreate, access: CurrentAccess, db: DbSession, request: Request
) -> EstimateCheckOut:
    """How an invoice would compare with a self-pay client's good faith estimates (nothing is
    saved): warnings, and whether a reason is needed to bill $400 or more above one."""
    client = _billing_client(access, body.client_id)
    check = check_invoice(db, client, _invoice_lines(access, client, body))
    db.rollback()
    audit_staff(
        db,
        request,
        access.staff,
        "invoice.estimate_check",
        "client",
        client.id,
        client_id=client.id,
    )
    db.commit()
    return _check_out(check)


@router.post("/invoices", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
def create_manual_invoice(
    body: InvoiceCreate, access: CurrentAccess, db: DbSession, request: Request
) -> InvoiceOut:
    """Invoice chosen sessions of the client (with any clinicians) and/or custom lines.

    Sessions are billed what the client owes for them (e.g. an insurance copay). For a
    self-pay client, billing $400 or more above a good faith estimate needs
    `gfe_override_reason` (409 with code estimate_override_required otherwise); the response's
    estimate_warnings say how the invoice compares with the estimates.
    """
    client = _billing_client(access, body.client_id)
    practice_settings = lock_practice_settings(db, client.practice_id)
    zone = zone_of(client.practice)
    items = _invoice_lines(access, client, body)
    client = lock_client(db, client.id)
    check = check_invoice(db, client, items)
    override_reason = body.gfe_override_reason.strip()
    if check.override_required and not override_reason:
        raise HTTPException(status.HTTP_409_CONFLICT, override_required_detail(check))
    invoice = create_invoice(
        db, practice_settings, client, items, local_date(utcnow(), zone), body.notes.strip()
    )
    if check.override_required:
        invoice.gfe_override_reason = override_reason
        record_overage(db, client, invoice.id, check, staff_id=access.staff.id)
    apply_client_credit(db, client.id)
    if body.notify:
        notify_new_invoice(db, client, invoice.id)
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "invoice.create",
        "invoice",
        invoice.id,
        {"estimate_override": check.override_required},
        client_id=client.id,
    )
    db.commit()
    db.refresh(invoice)
    view = invoice_views(db, [invoice])[0]
    view.estimate_warnings = check.warnings
    return view


@router.get("/invoices/{invoice_id}", response_model=InvoiceOut)
def get_invoice(
    invoice_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> InvoiceOut:
    invoice = access.client_record(Invoice, invoice_id, ClientAccess.BILLING, label="Invoice")
    audit_staff(
        db,
        request,
        access.staff,
        "invoice.view",
        "invoice",
        invoice.id,
        client_id=invoice.client_id,
    )
    db.commit()
    return invoice_views(db, [invoice])[0]


@router.post("/invoices/{invoice_id}/void", response_model=InvoiceOut)
def void_invoice(
    invoice_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> InvoiceOut:
    """Void an invoice with no payments applied; its sessions can be invoiced again."""
    invoice = access.client_record(Invoice, invoice_id, ClientAccess.BILLING, label="Invoice")
    client = lock_client(db, invoice.client_id)
    db.refresh(invoice)
    if invoice.status == InvoiceStatus.VOID:
        raise HTTPException(status.HTTP_409_CONFLICT, "This invoice is already void")
    if invoice.paid_cents > 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This invoice has payments applied. Refund them before voiding it.",
        )
    invoice.status = InvoiceStatus.VOID
    invoice.voided_at = utcnow()
    billing_changed(db, client)
    audit_staff(
        db, request, access.staff, "invoice.void", "invoice", invoice.id, client_id=client.id
    )
    db.commit()
    return invoice_views(db, [invoice])[0]


def _set_dispute(
    access: Access, db: Session, request: Request, invoice_id: int, *, disputed: bool
) -> InvoiceOut:
    invoice = access.client_record(Invoice, invoice_id, ClientAccess.BILLING, label="Invoice")
    client = lock_client(db, invoice.client_id)
    db.refresh(invoice)
    if invoice.status == InvoiceStatus.VOID:
        raise HTTPException(status.HTTP_409_CONFLICT, "This invoice is void")
    if (invoice.disputed_at is not None) == disputed:
        state = "already disputed" if disputed else "not disputed"
        raise HTTPException(status.HTTP_409_CONFLICT, f"This invoice is {state}")
    invoice.disputed_at = utcnow() if disputed else None
    if not disputed:
        apply_client_credit(db, client.id)
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "invoice.dispute" if disputed else "invoice.dispute_resolve",
        "invoice",
        invoice.id,
        client_id=client.id,
    )
    db.commit()
    db.refresh(invoice)
    return invoice_views(db, [invoice])[0]


@router.post("/invoices/{invoice_id}/dispute", response_model=InvoiceOut)
def dispute_invoice(
    invoice_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> InvoiceOut:
    """The client is disputing this bill (e.g. patient-provider dispute resolution): pause
    AutoPay, and credit or payments aren't applied to it automatically, until it's resolved."""
    return _set_dispute(access, db, request, invoice_id, disputed=True)


@router.post("/invoices/{invoice_id}/resolve", response_model=InvoiceOut)
def resolve_invoice_dispute(
    invoice_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> InvoiceOut:
    """The dispute is over: the invoice is collected as usual again (any credit applies)."""
    return _set_dispute(access, db, request, invoice_id, disputed=False)


@router.get("/invoices/{invoice_id}/pdf")
def download_invoice_pdf(
    invoice_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    invoice = access.client_record(Invoice, invoice_id, ClientAccess.BILLING, label="Invoice")
    content = invoice_pdf(db, invoice)
    audit_staff(
        db,
        request,
        access.staff,
        "invoice.download",
        "invoice",
        invoice.id,
        client_id=invoice.client_id,
    )
    db.commit()
    return pdf_response(content, invoice.number)


# Payments and refunds ----------------------------------------------------------------------


@router.get("/payments", response_model=list[PaymentOut])
def list_payments(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    client_id: int | None = Query(default=None),
    invoice_id: int | None = Query(default=None, description="Only payments applied to it"),
) -> list[Payment]:
    """A page of the payments of the clients whose billing this person sees, newest first."""
    _require_billing(access)
    query = (
        select(Payment)
        .join(Client, Client.id == Payment.client_id)
        .where(
            Payment.practice_id == access.practice_id,
            access.client_filter(ClientAccess.BILLING),
        )
        .options(selectinload(Payment.client))
    )
    if client_id is not None:
        query = query.where(Payment.client_id == client_id)
    if invoice_id is not None:
        query = query.where(Payment.allocations.any(PaymentAllocation.invoice_id == invoice_id))
    ordered = query.order_by(Payment.created_at.desc(), Payment.id.desc())
    found = list(db.scalars(paginate(db, ordered, page, response)))
    audit_staff_list(
        db,
        request,
        access.staff,
        "payment.list",
        (p.client_id for p in found),
        detail={"client_id": client_id, "invoice_id": invoice_id},
    )
    db.commit()
    return found


@router.post("/payments", response_model=PaymentOut, status_code=status.HTTP_201_CREATED)
def record_payment(
    body: PaymentCreate, access: CurrentAccess, db: DbSession, request: Request
) -> Payment:
    """Record money received outside Synari and apply it: the chosen invoice, then oldest."""
    client = _billing_client(access, body.client_id)
    if body.invoice_id is not None:
        invoice = access.client_record(
            Invoice, body.invoice_id, ClientAccess.BILLING, label="Invoice"
        )
        if invoice.client_id != client.id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "That invoice belongs to another client"
            )
    lock_client(db, client.id)
    payment = Payment(
        practice_id=client.practice_id,
        client_id=client.id,
        amount_cents=body.amount_cents,
        method=body.method,
        status=PaymentStatus.PENDING,
        refunded_cents=0,
        reference=body.reference.strip(),
        received_at=(body.received_at or utcnow()).astimezone(UTC),
    )
    db.add(payment)
    mark_payment_received(db, payment, body.invoice_id)
    db.flush()
    if body.send_receipt:
        send_payment_receipt(db, client, payment.id)
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "payment.create",
        "payment",
        payment.id,
        {"amount_cents": payment.amount_cents},
        client_id=client.id,
    )
    db.commit()
    return payment


@router.post("/payments/{payment_id}/refund", response_model=PaymentOut)
def refund_payment(
    payment_id: int, body: RefundCreate, access: CurrentAccess, db: DbSession, request: Request
) -> Payment:
    """Refund part or all of a payment. Card payments are refunded to the card through Stripe."""
    payment = access.client_record(Payment, payment_id, ClientAccess.BILLING, label="Payment")
    client = lock_client(db, payment.client_id)
    db.refresh(payment)
    if payment.refundable_cents <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "This payment can't be refunded")
    if body.amount_cents > payment.refundable_cents:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"You can refund up to {format_money(payment.refundable_cents)}",
        )
    if payment.method == PaymentMethod.CARD:
        require_online_payments()
        if payment.stripe_payment_intent_id is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "This card payment can't be refunded")
        try:
            payments.refund_payment(
                payment_intent_id=payment.stripe_payment_intent_id,
                amount_cents=body.amount_cents,
                idempotency_key=f"synari-refund-{payment.id}-{payment.refunded_cents}",
            )
        except payments.PaymentError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    apply_refund(db, payment, body.amount_cents)
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "payment.refund",
        "payment",
        payment.id,
        {"amount_cents": body.amount_cents},
        client_id=client.id,
    )
    db.commit()
    return payment


# Saved cards and card charges --------------------------------------------------------------


@router.get("/clients/{client_id}/cards", response_model=list[SavedCardOut])
def list_client_cards(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[SavedCard]:
    client = _billing_client(access, client_id)
    cards = client_cards(db, client.id)
    audit_staff(db, request, access.staff, "card.list", "client", client.id, client_id=client.id)
    db.commit()
    return cards


@router.post("/cards/{card_id}/default", response_model=SavedCardOut)
def set_default_card(
    card_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> SavedCard:
    """Choose which saved card AutoPay and card charges use."""
    card = _card(access, card_id)
    client = lock_client(db, card.client_id)
    make_default_card(db, card)
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "card.default",
        "saved_card",
        card.id,
        client_id=card.client_id,
    )
    db.commit()
    return card


@router.delete("/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(card_id: int, access: CurrentAccess, db: DbSession, request: Request) -> None:
    """Remove a client's saved card (in Stripe too). The newest other card becomes default."""
    require_online_payments()
    card = _card(access, card_id)
    client = lock_client(db, card.client_id)
    try:
        remove_card(db, card)
    except payments.PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    billing_changed(db, client)
    audit_staff(
        db, request, access.staff, "card.delete", "saved_card", card_id, client_id=client.id
    )
    db.commit()


@router.post(
    "/clients/{client_id}/charge", response_model=PaymentOut, status_code=status.HTTP_201_CREATED
)
def charge_client_card(
    client_id: int, body: ChargeCreate, access: CurrentAccess, db: DbSession, request: Request
) -> Payment:
    """Charge a saved card now. Declines return 402 with the card issuer's message."""
    require_online_payments()
    client = _billing_client(access, client_id)
    if body.card_id is not None:
        card = _card(access, body.card_id)
        if card.client_id != client.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found")
    else:
        default = default_card(db, client.id)
        if default is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "This client doesn't have a saved card")
        card = default
    if body.amount_cents < MIN_CARD_CHARGE_CENTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Card charges must be at least {format_money(MIN_CARD_CHARGE_CENTS)}",
        )
    audit_staff(
        db,
        request,
        access.staff,
        "payment.charge",
        "client",
        client.id,
        {"amount_cents": body.amount_cents, "card_id": card.id},
        client_id=client.id,
    )
    try:
        return charge_saved_card(db, client, card, body.amount_cents, purpose="staff_charge")
    except payments.PaymentError as exc:
        code = status.HTTP_402_PAYMENT_REQUIRED if exc.declined else status.HTTP_502_BAD_GATEWAY
        raise HTTPException(code, exc.message) from exc


# Superbills --------------------------------------------------------------------------------


@router.post("/superbills", response_model=SuperbillOut, status_code=status.HTTP_201_CREATED)
def create_superbill(
    body: SuperbillCreate, access: CurrentAccess, db: DbSession, request: Request
) -> Superbill:
    """Snapshot a client's attended sessions, diagnoses, insurance and payments for a period."""
    client = _billing_client(access, body.client_id)
    data = build_superbill(db, client, body.period_start, body.period_end)
    if not data.lines:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "There are no attended sessions with a fee in this period",
        )
    practice_settings = lock_practice_settings(db, client.practice_id)
    superbill = Superbill(
        practice_id=client.practice_id,
        client_id=client.id,
        number=next_superbill_number(practice_settings),
        period_start=body.period_start,
        period_end=body.period_end,
        total_cents=data.total_cents,
        paid_cents=data.paid_cents,
        data=data.model_dump(mode="json"),
    )
    db.add(superbill)
    db.flush()
    billing_changed(db, client)
    audit_staff(
        db,
        request,
        access.staff,
        "superbill.create",
        "superbill",
        superbill.id,
        client_id=client.id,
    )
    db.commit()
    db.refresh(superbill)
    return superbill


@router.get("/superbills", response_model=list[SuperbillOut])
def list_superbills(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    client_id: int | None = Query(default=None),
) -> list[Superbill]:
    """A page of the superbills of the clients whose billing this person sees, newest period
    first."""
    _require_billing(access)
    query = (
        select(Superbill)
        .join(Client, Client.id == Superbill.client_id)
        .where(access.client_filter(ClientAccess.BILLING))
    )
    if client_id is not None:
        query = query.where(Superbill.client_id == client_id)
    ordered = query.order_by(Superbill.period_end.desc(), Superbill.id.desc())
    found = list(db.scalars(paginate(db, ordered, page, response)))
    audit_staff_list(
        db,
        request,
        access.staff,
        "superbill.list",
        (b.client_id for b in found),
        detail={"client_id": client_id},
    )
    db.commit()
    return found


@router.get("/superbills/{superbill_id}", response_model=SuperbillOut)
def get_superbill(
    superbill_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Superbill:
    superbill = access.client_record(
        Superbill, superbill_id, ClientAccess.BILLING, label="Superbill"
    )
    audit_staff(
        db,
        request,
        access.staff,
        "superbill.view",
        "superbill",
        superbill.id,
        client_id=superbill.client_id,
    )
    db.commit()
    return superbill


@router.get("/superbills/{superbill_id}/pdf")
def download_superbill_pdf(
    superbill_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Response:
    superbill = access.client_record(
        Superbill, superbill_id, ClientAccess.BILLING, label="Superbill"
    )
    content = superbill_pdf(superbill)
    audit_staff(
        db,
        request,
        access.staff,
        "superbill.download",
        "superbill",
        superbill.id,
        client_id=superbill.client_id,
    )
    db.commit()
    return pdf_response(content, superbill.number)
