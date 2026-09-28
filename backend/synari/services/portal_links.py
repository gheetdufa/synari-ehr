"""Client-portal sign-in links and the emails that carry them.

A client's portal can be opened by the client and by their contacts with portal access (a
minor's parents, say). Each gets their own single-use sign-in links.
"""

from datetime import datetime, timedelta
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import AuthToken, Client, ClientContact, OutboundMessage, StaffMember
from synari.models.enums import AuthTokenPurpose
from synari.security import new_opaque_token
from synari.services.email_templates import render_email
from synari.services.outbox import queue_email

SIGN_IN_REQUEST_TTL = timedelta(hours=1)
EMAIL_LINK_TTL = timedelta(hours=72)


def clinician_name_for(client: Client) -> str:
    """Who clients see as their care provider: the primary clinician, else the practice."""
    primary = client.primary_clinician
    return primary.display_name if primary is not None else client.practice.name


def portal_contacts(client: Client) -> list[ClientContact]:
    """The client's contacts who can sign in to the client's portal (they have an email)."""
    return [contact for contact in client.contacts if contact.portal_access and contact.email]


def _sign_in_url(
    db: Session, purpose: AuthTokenPurpose, subject_id: int, ttl: timedelta, next_path: str
) -> str:
    raw, token_hash = new_opaque_token()
    db.add(
        AuthToken(
            purpose=purpose,
            subject_id=subject_id,
            token_hash=token_hash,
            expires_at=utcnow() + ttl,
        )
    )
    query = urlencode({"token": raw, "next": next_path})
    return f"{settings.frontend_url.rstrip('/')}/client/sign-in?{query}"


def create_client_sign_in_url(
    db: Session, client: Client, ttl: timedelta, next_path: str = "/client"
) -> str:
    """Create a single-use sign-in token for the client and return the portal URL for it."""
    return _sign_in_url(db, AuthTokenPurpose.CLIENT_LOGIN, client.id, ttl, next_path)


def create_contact_sign_in_url(
    db: Session, contact: ClientContact, ttl: timedelta, next_path: str = "/client"
) -> str:
    """Create a single-use sign-in token that opens the client's portal as this contact."""
    return _sign_in_url(db, AuthTokenPurpose.CONTACT_LOGIN, contact.id, ttl, next_path)


def _already_queued(db: Session, dedupe_key: str | None) -> bool:
    # Checked before minting a sign-in token for an email the outbox would drop anyway.
    if dedupe_key is None:
        return False
    return (
        db.scalar(select(OutboundMessage.id).where(OutboundMessage.dedupe_key == dedupe_key))
        is not None
    )


def queue_portal_email(
    db: Session,
    client: Client,
    *,
    subject: str,
    heading: str,
    paragraphs: list[str],
    button_label: str,
    next_path: str = "/client",
    dedupe_key: str | None = None,
    send_after: datetime | None = None,
    condition_kind: str | None = None,
    condition_ref: int | None = None,
    include_contacts: bool = True,
) -> bool:
    """Email a content-free notice, from the client's practice, with a portal sign-in button.

    It goes to the client and (unless `include_contacts` is off) to each contact with portal
    access, each with their own sign-in link; a contact's copy is de-duplicated under
    `dedupe_key` plus the contact id. Returns False (and sends nothing) if the client can't
    use the portal or nobody has an email address.
    """
    if not client.can_use_portal:
        return False
    recipients: list[tuple[str | None, ClientContact | None]] = []
    if client.email:
        recipients.append((client.email, None))
    if include_contacts:
        recipients += [(contact.email, contact) for contact in portal_contacts(client)]
    for address, contact in recipients:
        key = dedupe_key
        if contact is not None and dedupe_key is not None:
            key = f"{dedupe_key}:contact-{contact.id}"
        if _already_queued(db, key):
            continue
        url = (
            create_client_sign_in_url(db, client, EMAIL_LINK_TTL, next_path)
            if contact is None
            else create_contact_sign_in_url(db, contact, EMAIL_LINK_TTL, next_path)
        )
        content = render_email(
            subject=subject,
            heading=heading,
            paragraphs=paragraphs,
            sender_name=client.practice.name,
            button_label=button_label,
            button_url=url,
        )
        queue_email(
            db,
            to=address,
            content=content,
            practice_id=client.practice_id,
            dedupe_key=key,
            send_after=send_after,
            condition_kind=condition_kind,
            condition_ref=condition_ref,
        )
    return bool(recipients)


def queue_staff_email(
    db: Session,
    staff: StaffMember,
    *,
    subject: str,
    heading: str,
    paragraphs: list[str],
    button_label: str,
    app_path: str,
    dedupe_key: str | None = None,
    send_after: datetime | None = None,
    condition_kind: str | None = None,
    condition_ref: int | None = None,
) -> None:
    """Email a staff member a content-free notice linking into the app (sign-in required).

    Callers check the recipient's notify_email_* preference where one applies.
    """
    content = render_email(
        subject=subject,
        heading=heading,
        paragraphs=paragraphs,
        sender_name="Synari",
        button_label=button_label,
        button_url=f"{settings.frontend_url.rstrip('/')}{app_path}",
    )
    queue_email(
        db,
        to=staff.email,
        content=content,
        practice_id=staff.practice_id,
        dedupe_key=dedupe_key,
        send_after=send_after,
        condition_kind=condition_kind,
        condition_ref=condition_ref,
    )


def send_portal_welcome(db: Session, client: Client) -> bool:
    """Queue the welcome email that lets a client sign in to the portal for the first time."""
    practice_name = client.practice.name
    return queue_portal_email(
        db,
        client,
        subject=f"Your client portal with {practice_name}",
        heading=f"Welcome, {client.display_first_name}",
        paragraphs=[
            f"{clinician_name_for(client)} has set up a secure client portal for you.",
            "In the portal you can see appointments, message your therapist, complete forms "
            "and pay bills. To sign in later, use your email address on the sign-in page.",
        ],
        button_label="Open your portal",
        include_contacts=False,
    )


def send_contact_portal_welcome(db: Session, contact: ClientContact) -> bool:
    """Queue the email inviting a contact (e.g. a parent) into the client's portal.

    Returns False (and sends nothing) unless the contact has portal access and an email
    address and the client can use the portal.
    """
    client = contact.client
    if not (contact.portal_access and contact.email and client.can_use_portal):
        return False
    practice_name = client.practice.name
    name = client.display_first_name
    content = render_email(
        subject=f"Your access to {name}'s client portal with {practice_name}",
        heading=f"Welcome, {contact.first_name}",
        paragraphs=[
            f"{clinician_name_for(client)} has given you access to {name}'s secure client portal.",
            f"There you can see {name}'s appointments, send secure messages, complete forms "
            "and pay bills. To sign in later, use your email address on the sign-in page.",
        ],
        sender_name=practice_name,
        button_label="Open the portal",
        button_url=create_contact_sign_in_url(db, contact, EMAIL_LINK_TTL),
    )
    queue_email(db, to=contact.email, content=content, practice_id=client.practice_id)
    return True
