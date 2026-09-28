"""Inbound SMS from Twilio: mirror STOP/START replies onto clients' SMS consent.

Twilio itself blocks messages to numbers that replied STOP; recording the opt-out here keeps
Synari from queueing texts that would fail and shows the practice why reminders stopped.
Point the Twilio number's "A message comes in" webhook at POST /api/webhooks/twilio/sms.
"""

import base64
import hashlib
import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.audit import audit_anonymous
from synari.config import settings
from synari.deps import DbSession
from synari.models import Client
from synari.services.delivery import normalize_phone

router = APIRouter(prefix="/webhooks/twilio", tags=["webhooks"])

OPT_OUT_KEYWORDS = frozenset({"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"})
OPT_IN_KEYWORDS = frozenset({"START", "UNSTOP", "YES"})
EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'
PHONE_SUFFIX_DIGITS = 7

FormParams = list[tuple[str, str]]


async def _form_params(request: Request) -> FormParams:
    form = await request.form()
    return [(key, value) for key, value in form.multi_items() if isinstance(value, str)]


def _first_header_value(request: Request, name: str) -> str | None:
    value = request.headers.get(name)
    return value.split(",")[0].strip() if value else None


def public_url(request: Request) -> str:
    """The URL Twilio called, honoring X-Forwarded-Proto/Host from a reverse proxy."""
    scheme = _first_header_value(request, "x-forwarded-proto") or request.url.scheme
    host = (
        _first_header_value(request, "x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    )
    query = f"?{request.url.query}" if request.url.query else ""
    return f"{scheme}://{host}{request.url.path}{query}"


def twilio_signature(url: str, params: FormParams, auth_token: str) -> str:
    """Base64 HMAC-SHA1 of the URL followed by each POST param's name and value, sorted."""
    payload = url + "".join(key + value for key, value in sorted(params))
    digest = hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def _require_twilio(request: Request, params: FormParams) -> None:
    provided = request.headers.get("x-twilio-signature", "")
    if not settings.sms_enabled or not provided:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signature")
    expected = twilio_signature(public_url(request), params, settings.twilio_auth_token)
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signature")


def _clients_with_phone(db: Session, phone: str) -> list[Client]:
    """Clients (in any practice) whose stored phone normalizes to this E.164 number."""
    digits = phone.lstrip("+")
    candidates = db.scalars(
        select(Client).where(
            func.regexp_replace(Client.phone, r"\D", "", "g").endswith(
                digits[-PHONE_SUFFIX_DIGITS:]
            )
        )
    )
    return [c for c in candidates if normalize_phone(c.phone) == phone]


def _requested_opt_out(keyword: str) -> bool | None:
    """True for an opt-out keyword, False for an opt-in keyword, None for anything else."""
    if keyword in OPT_OUT_KEYWORDS:
        return True
    if keyword in OPT_IN_KEYWORDS:
        return False
    return None


@router.post("/sms")
def receive_sms(
    request: Request, params: Annotated[FormParams, Depends(_form_params)], db: DbSession
) -> Response:
    """Handle an incoming text; opt-out/opt-in keywords update matching clients."""
    _require_twilio(request, params)
    values = dict(params)
    keyword = values.get("Body", "").strip().upper()
    phone = normalize_phone(values.get("From", ""))
    opted_out = _requested_opt_out(keyword)
    if phone is None or opted_out is None:
        return Response(EMPTY_TWIML, media_type="text/xml")
    for client in _clients_with_phone(db, phone):
        if client.sms_opted_out == opted_out:
            continue
        client.sms_opted_out = opted_out
        audit_anonymous(
            db,
            request,
            "client.sms_opt_out" if opted_out else "client.sms_opt_in",
            practice_id=client.practice_id,
            detail={"source": "twilio"},
            client_id=client.id,
        )
    db.commit()
    return Response(EMPTY_TWIML, media_type="text/xml")
