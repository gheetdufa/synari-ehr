"""FastAPI dependencies: database session, the signed-in staff member or client, and access.

Every authenticated request carries an access token naming a live server-side session
(synari/services/sessions.py). Staff who must use two-factor authentication but haven't set it
up get an enrollment-only session: only the routes that take `EnrollingStaffSession` accept
it (GET /me, 2FA setup, sign-out); everything else answers 403.
"""

from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from synari.access import Access
from synari.db import get_db
from synari.models import AuthSession, Client, ClientContact, StaffMember
from synari.models.enums import Role
from synari.security import decode_token
from synari.services.sessions import (
    live_session_for_claims,
    portal_idle_minutes,
    staff_idle_minutes,
)
from synari.services.sign_in import needs_mfa_setup

DbSession = Annotated[Session, Depends(get_db)]

MFA_SETUP_REQUIRED = "Set up two-factor authentication to continue."

_bearer = HTTPBearer(auto_error=False)
_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def _access_claims(credentials: HTTPAuthorizationCredentials | None, role: Role) -> dict[str, Any]:
    if credentials is None:
        raise _UNAUTHORIZED
    claims = decode_token(credentials.credentials, "access")
    if claims is None or claims.get("role") != role:
        raise _UNAUTHORIZED
    return claims


def load_staff(db: Session, staff_id: int, version: object) -> StaffMember | None:
    """An active staff member whose token version is still `version`."""
    staff = db.get(StaffMember, staff_id)
    if staff is None or not staff.is_active or version != staff.token_version:
        return None
    return staff


def load_staff_from_claims(db: Session, claims: dict[str, Any]) -> StaffMember | None:
    """Resolve token claims to an active staff member whose token version still matches."""
    return load_staff(db, int(claims["sub"]), claims.get("ver"))


@dataclass(frozen=True)
class PortalActor:
    """Who is using a client's portal: the client, or a contact (e.g. a minor's parent) acting
    on the client's behalf. Portal routes always work with `client`'s records."""

    client: Client
    contact: ClientContact | None


def load_portal_actor(
    db: Session, client_id: int, contact_id: object, version: object
) -> PortalActor | None:
    """The client (and, for a contact's session, the contact) a portal session belongs to.

    The client must still use the portal and the version must match the client's portal token
    version, or for a contact the contact's; the contact must still belong to the client and
    have portal access.
    """
    client = db.get(Client, client_id)
    if client is None or not client.can_use_portal:
        return None
    if contact_id is None:
        if version != client.portal_token_version:
            return None
        return PortalActor(client, None)
    contact = db.get(ClientContact, int(str(contact_id)))
    if (
        contact is None
        or contact.client_id != client.id
        or not contact.portal_access
        or version != contact.portal_token_version
    ):
        return None
    return PortalActor(client, contact)


def load_portal_actor_from_claims(db: Session, claims: dict[str, Any]) -> PortalActor | None:
    """Resolve portal token claims to the client and, for a contact's token, the contact.

    A contact's token carries the client id as `sub` and the contact id as `contact`.
    """
    return load_portal_actor(db, int(claims["sub"]), claims.get("contact"), claims.get("ver"))


@dataclass(frozen=True)
class StaffSession:
    """The signed-in staff member and the session their access token names."""

    staff: StaffMember
    session: AuthSession


def get_enrolling_staff_session(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> StaffSession:
    """Require a live staff session, including an enrollment-only one."""
    claims = _access_claims(credentials, Role.STAFF)
    staff = load_staff_from_claims(db, claims)
    session = (
        live_session_for_claims(db, claims, role=Role.STAFF, idle_minutes=staff_idle_minutes(staff))
        if staff is not None
        else None
    )
    if staff is None or session is None:
        raise _UNAUTHORIZED
    return StaffSession(staff, session)


EnrollingStaffSession = Annotated[StaffSession, Depends(get_enrolling_staff_session)]


def get_current_staff_session(current: EnrollingStaffSession) -> StaffSession:
    """Require a live staff session with full access (2FA set up where it's required)."""
    if needs_mfa_setup(current.staff):
        raise HTTPException(status.HTTP_403_FORBIDDEN, MFA_SETUP_REQUIRED)
    return current


CurrentStaffSession = Annotated[StaffSession, Depends(get_current_staff_session)]


def get_current_staff(current: CurrentStaffSession) -> StaffMember:
    """Require a signed-in staff member with full access."""
    return current.staff


CurrentStaff = Annotated[StaffMember, Depends(get_current_staff)]


@dataclass(frozen=True)
class PortalSession:
    """Who is using the portal and the session their access token names."""

    actor: PortalActor
    session: AuthSession


def get_portal_session(
    db: DbSession,
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> PortalSession:
    """Require a live client-portal session (the client's or a contact's).

    A signed-in contact is noted on the request so audit_client records them.
    """
    claims = _access_claims(credentials, Role.CLIENT)
    actor = load_portal_actor_from_claims(db, claims)
    session = (
        live_session_for_claims(db, claims, role=Role.CLIENT, idle_minutes=portal_idle_minutes())
        if actor is not None
        else None
    )
    if actor is None or session is None:
        raise _UNAUTHORIZED
    if actor.contact is not None:
        request.state.portal_contact_id = actor.contact.id
    return PortalSession(actor, session)


CurrentPortalSession = Annotated[PortalSession, Depends(get_portal_session)]


def get_current_portal_actor(current: CurrentPortalSession) -> PortalActor:
    """The client, or their contact, signed in to the portal."""
    return current.actor


CurrentPortalActor = Annotated[PortalActor, Depends(get_current_portal_actor)]


def get_current_client(actor: CurrentPortalActor) -> Client:
    """The client whose portal is open, whether they or one of their contacts signed in."""
    return actor.client


CurrentClient = Annotated[Client, Depends(get_current_client)]


def get_access(staff: CurrentStaff, db: DbSession) -> Access:
    """What the signed-in staff member may reach (see synari/access.py)."""
    return Access(db, staff)


CurrentAccess = Annotated[Access, Depends(get_access)]
