"""Email (SMTP) and SMS (Twilio) senders used by the outbox worker."""

import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import make_msgid

import httpx

from synari.config import settings


class DeliveryError(Exception):
    """A message could not be delivered; the outbox will retry it.

    The message is stored on the outbox row and logged, so it carries error codes and types
    only: provider responses and SMTP replies can echo addresses, phone numbers and content.
    """


def send_email(to: str, subject: str, text: str, html: str | None) -> None:
    """Send one email through the configured SMTP server."""
    if not settings.email_enabled:
        raise DeliveryError("Email is not configured (set SMTP_HOST)")
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message["Message-ID"] = make_msgid(domain="synari")
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    try:
        if settings.smtp_security == "ssl":
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=20,
                context=ssl.create_default_context(),
            )
        else:
            smtp = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
        with smtp:
            if settings.smtp_security == "starttls":
                smtp.starttls(context=ssl.create_default_context())
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        code = getattr(exc, "smtp_code", None)
        raise DeliveryError(
            f"SMTP error: {type(exc).__name__}" + (f" ({code})" if code else "")
        ) from None


def normalize_phone(phone: str, default_country_code: str = "1") -> str | None:
    """Return an E.164 phone number, or None if it can't be interpreted."""
    digits = re.sub(r"\D", "", phone)
    if phone.strip().startswith("+") and 8 <= len(digits) <= 15:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+{default_country_code}{digits}"
    if len(digits) == 11 and digits.startswith(default_country_code):
        return f"+{digits}"
    return None


def send_sms(to: str, body: str) -> None:
    """Send one SMS through Twilio's REST API."""
    if not settings.sms_enabled:
        raise DeliveryError("SMS is not configured (set TWILIO_* variables)")
    url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json"
    try:
        response = httpx.post(
            url,
            data={"To": to, "From": settings.twilio_from_number, "Body": body},
            auth=(settings.twilio_account_sid, settings.twilio_auth_token),
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise DeliveryError(f"Twilio request failed: {type(exc).__name__}") from None
    if response.status_code >= 400:
        raise DeliveryError(f"Twilio error {response.status_code}{_twilio_code(response)}")


def _twilio_code(response: httpx.Response) -> str:
    """Twilio's numeric error code (its message text can quote the phone number)."""
    try:
        body = response.json()
    except ValueError:
        return ""
    code = body.get("code") if isinstance(body, dict) else None
    return f" (code {code})" if isinstance(code, int) else ""
