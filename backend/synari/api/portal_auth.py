"""Client-portal sign-in with one-time email links (no passwords).

Clients sign in to their own portal. Contacts with portal access (a minor's parents, a
partner) sign in to the client's portal as themselves: their sessions name the client as the
subject and carry the contact's id, and they can do whatever the client's portal allows.
Sessions are server-side like staff sessions (synari/services/sessions.py), with a fixed idle
limit (PORTAL_IDLE_MINUTES) and lifetime (PORTAL_SESSION_DAYS).
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.audit import audit_anonymous, audit_client
from synari.db import utcnow
from synari.deps import (
    CurrentPortalActor,
    CurrentPortalSession,
    DbSession,
    PortalActor,
    load_portal_actor,
)
from synari.models import AuthToken, Client, ClientContact
from synari.models.enums import AuthTokenPurpose, Role
from synari.ratelimit import enforce_limit, rate_limit
from synari.schemas.auth import (
    ActingContact,
    MagicLinkRequest,
    MagicLinkVerify,
    PortalAuthResponse,
    PortalClientOut,
    PortalPermissions,
    RefreshRequest,
)
from synari.schemas.common import Message, TokenResponse
from synari.security import hash_opaque_token
from synari.services import sessions
from synari.services.email_templates import render_email
from synari.services.outbox import queue_email
from synari.services.portal_links import (
    SIGN_IN_REQUEST_TTL,
    clinician_name_for,
    create_client_sign_in_url,
    create_contact_sign_in_url,
)

router = APIRouter(prefix="/portal/auth", tags=["portal auth"])

_INVALID_LINK = HTTPException(
    status.HTTP_400_BAD_REQUEST, "This sign-in link is invalid or has expired"
)


def portal_client_out(actor: PortalActor) -> PortalClientOut:
    """Summary of the client whose portal is open, who signed in, and what the portal allows.

    Times show in the client's zone if set, else their primary clinician's, else the practice's.
    """
    client, contact = actor.client, actor.contact
    practice = client.practice
    primary = client.primary_clinician
    default_zone = primary.time_zone if primary is not None else practice.time_zone
    return PortalClientOut(
        id=client.id,
        first_name=client.first_name,
        last_name=client.last_name,
        preferred_name=client.preferred_name,
        email=client.email,
        clinician_name=clinician_name_for(client),
        practice_name=practice.name,
        time_zone=client.time_zone or default_zone,
        permissions=PortalPermissions(
            messaging=client.portal_messaging and practice.settings.messaging_enabled,
            booking=client.portal_booking and practice.settings.booking_enabled,
            billing=client.portal_billing,
        ),
        acting_contact=(
            ActingContact(id=contact.id, name=contact.full_name) if contact is not None else None
        ),
        idle_timeout_minutes=sessions.portal_idle_minutes(),
    )


def start_portal_actor_session(
    db: Session, actor: PortalActor, request: Request | None
) -> sessions.IssuedTokens:
    """Sign the client, or their contact, in to the client's portal (caller commits)."""
    client, contact = actor.client, actor.contact
    if contact is None:
        return sessions.start_portal_session(db, client, None, client.portal_token_version, request)
    return sessions.start_portal_session(
        db, client, contact.id, contact.portal_token_version, request
    )


def _queue_sign_in_email(
    db: Session, to: str, client: Client, url: str, *, subject: str, heading: str
) -> None:
    practice_name = client.practice.name
    queue_email(
        db,
        to=to,
        practice_id=client.practice_id,
        content=render_email(
            subject=subject,
            heading=heading,
            paragraphs=[
                "Use the button below to sign in. The link works once and expires in one hour.",
                "If you didn't request this, you can ignore this email.",
            ],
            sender_name=practice_name,
            button_label="Sign in",
            button_url=url,
        ),
    )


@router.post(
    "/request-link",
    response_model=Message,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(rate_limit("portal-link", limit=5))],
)
def request_sign_in_link(body: MagicLinkRequest, db: DbSession, request: Request) -> Message:
    """Email a one-time sign-in link for each portal this email can open.

    That's each portal-enabled client record with this email (one per practice) and each
    client whose contact with this email has portal access (e.g. a parent of two children
    gets a link for each child). Each link sent is audited against its client; a request that
    matches nothing is audited without one. The response never says which happened.
    """
    enforce_limit("portal-link-account", f"email:{body.email}", limit=5, window_seconds=3600)
    sent = 0
    clients = db.scalars(select(Client).where(func.lower(Client.email) == body.email)).all()
    for client in clients:
        if not client.can_use_portal:
            continue
        _queue_sign_in_email(
            db,
            body.email,
            client,
            create_client_sign_in_url(db, client, SIGN_IN_REQUEST_TTL),
            subject=f"Your sign-in link for {client.practice.name}",
            heading="Sign in to your client portal",
        )
        audit_anonymous(db, request, "portal.request_link", client.practice_id, client_id=client.id)
        sent += 1
    contacts = db.scalars(
        select(ClientContact)
        .where(func.lower(ClientContact.email) == body.email, ClientContact.portal_access)
        .order_by(ClientContact.id)
    ).all()
    for contact in contacts:
        client = contact.client
        if not client.can_use_portal:
            continue
        name = client.display_first_name
        _queue_sign_in_email(
            db,
            body.email,
            client,
            create_contact_sign_in_url(db, contact, SIGN_IN_REQUEST_TTL),
            subject=f"Sign in to view {name}'s portal",
            heading=f"Sign in to {name}'s client portal",
        )
        audit_anonymous(
            db,
            request,
            "portal.request_link",
            client.practice_id,
            {"contact_id": contact.id},
            client_id=client.id,
        )
        sent += 1
    if not sent:
        audit_anonymous(db, request, "portal.request_link", detail={"matched": False})
    db.commit()
    return Message(detail="If that email is registered, a sign-in link is on its way.")


def _actor_for_token(db: Session, token: AuthToken) -> PortalActor | None:
    """The portal a sign-in token opens, if its client (and contact) may still use it."""
    if token.purpose == AuthTokenPurpose.CLIENT_LOGIN:
        client = db.get(Client, token.subject_id)
        if client is None or not client.can_use_portal:
            return None
        return PortalActor(client, None)
    contact = db.get(ClientContact, token.subject_id)
    if contact is None or not contact.portal_access or not contact.client.can_use_portal:
        return None
    return PortalActor(contact.client, contact)


@router.post(
    "/verify",
    response_model=PortalAuthResponse,
    dependencies=[Depends(rate_limit("portal-verify", limit=20))],
)
def verify_sign_in_link(
    body: MagicLinkVerify, db: DbSession, request: Request
) -> PortalAuthResponse:
    """Exchange a one-time sign-in token for portal tokens.

    A contact's link opens the client's portal: `client` is the client and
    `client.acting_contact` names the contact.
    """
    token = db.scalar(
        select(AuthToken)
        .where(
            AuthToken.token_hash == hash_opaque_token(body.token),
            AuthToken.purpose.in_((AuthTokenPurpose.CLIENT_LOGIN, AuthTokenPurpose.CONTACT_LOGIN)),
        )
        .with_for_update()
    )
    if token is None or token.used_at is not None or token.expires_at < utcnow():
        raise _INVALID_LINK
    actor = _actor_for_token(db, token)
    if actor is None:
        raise _INVALID_LINK
    token.used_at = utcnow()
    detail = None
    if actor.contact is None:
        actor.client.portal_last_login_at = utcnow()
    else:
        actor.contact.portal_last_login_at = utcnow()
        detail = {"contact_id": actor.contact.id}
    audit_client(db, request, actor.client, "portal.login", detail=detail)
    tokens = start_portal_actor_session(db, actor, request)
    db.commit()
    return PortalAuthResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
        client=portal_client_out(actor),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, db: DbSession, request: Request) -> TokenResponse:
    """Exchange a portal refresh token for new tokens. The refresh token rotates: the old one
    stops working, and presenting it again ends the session."""
    session = sessions.find_refresh_session(db, body.refresh_token, Role.CLIENT)
    actor = (
        load_portal_actor(db, session.subject_id, session.contact_id, session.token_version)
        if session
        else None
    )
    if (
        session is None
        or actor is None
        or not sessions.is_live(session, sessions.portal_idle_minutes())
    ):
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please sign in again")
    tokens = sessions.rotate(db, session, request)
    detail = {"contact_id": actor.contact.id} if actor.contact is not None else None
    audit_client(db, request, actor.client, "portal.refresh", detail=detail)
    db.commit()
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
    )


@router.post("/logout", response_model=Message)
def logout(current: CurrentPortalSession, db: DbSession, request: Request) -> Message:
    """Sign out on this device."""
    sessions.revoke(current.session, sessions.REVOKED_SIGNED_OUT)
    audit_client(db, request, current.actor.client, "portal.logout")
    db.commit()
    return Message(detail="Signed out")


@router.post("/logout-everywhere", response_model=Message)
def logout_everywhere(current: CurrentPortalSession, db: DbSession, request: Request) -> Message:
    """Sign out on every device (a contact signs out only themselves)."""
    client, contact = current.actor.client, current.actor.contact
    if contact is None:
        client.portal_token_version += 1
    else:
        contact.portal_token_version += 1
    sessions.revoke_all(
        db,
        Role.CLIENT,
        client.id,
        sessions.REVOKED_EVERYWHERE,
        contact_id=contact.id if contact is not None else None,
    )
    audit_client(db, request, client, "portal.logout_everywhere")
    db.commit()
    return Message(detail="Signed out everywhere")


@router.get("/me", response_model=PortalClientOut)
def me(actor: CurrentPortalActor) -> PortalClientOut:
    """The client whose portal is open, and the contact acting for them if one signed in."""
    return portal_client_out(actor)
