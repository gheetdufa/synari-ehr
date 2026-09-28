"""Client records, contacts, care teams, portal invitations and insurance policies.

Anyone who can see a client reads their profile, including their contacts (guardians,
partners, emergency contacts). Internal notes need clinical access, diagnoses clinical or
billing access, and insurance billing access. Changing demographics, contacts, status or
portal settings needs clinical access to the client (their clinicians and supervisors) or a
role that manages every calendar or the practice.
"""

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.audit import audit_staff, audit_staff_list, audit_staff_throttled
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, DbSession
from synari.models import (
    Claim,
    Client,
    ClientClinician,
    ClientContact,
    Disclosure,
    InsurancePolicy,
    Payer,
    SavedCard,
    Service,
    StaffMember,
)
from synari.models.enums import (
    ClientStatus,
    DisclosureSource,
    ExportPurpose,
    SecuritySeverity,
)
from synari.pagination import ListPage, paginate
from synari.permissions import Capability
from synari.schemas.clients import (
    CareTeamUpdate,
    ClientCreate,
    ClientExportRequest,
    ClientOut,
    ClientSummary,
    ClientUpdate,
    ContactFields,
    ContactOut,
    ContactUpdate,
    InsurancePolicyFields,
    InsurancePolicyOut,
    RecordAccess,
)
from synari.schemas.common import Message
from synari.services.client_export import build_client_export
from synari.services.client_search import client_matches
from synari.services.portal_links import send_contact_portal_welcome, send_portal_welcome
from synari.services.scheduling import zone_of
from synari.services.security_events import CLIENT_EXPORTED, record_security_event

router = APIRouter(prefix="/clients", tags=["clients"])

CLINICAL_FIELDS = frozenset({"internal_notes", "diagnosis_codes"})
BILLING_FIELDS = frozenset(
    {"billing_type", "default_service_id", "rate_override_cents", "autopay_enabled"}
)
# Where portal sign-in links go. The portal shows messages and documents, so only people who
# can see those may redirect it.
PORTAL_IDENTITY_FIELDS = frozenset({"email"})


def client_out(access: Access, client: Client) -> ClientOut:
    """The client's record as this person may see it."""
    return ClientOut.build(
        client,
        RecordAccess(
            clinical=access.can_access_client(client, ClientAccess.CLINICAL),
            billing=access.can_access_client(client, ClientAccess.BILLING),
        ),
    )


def _require_profile_editor(access: Access, client: Client) -> None:
    """Raise 403 unless this person may change the client's details or portal access."""
    if (
        access.can(Capability.SCHEDULE_ALL)
        or access.can(Capability.MANAGE_PRACTICE)
        or access.can_access_client(client, ClientAccess.CLINICAL)
    ):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, "Only the client's clinicians or schedulers can change this"
    )


def _require_field_access(access: Access, client: Client, fields: set[str]) -> None:
    """Raise 403 unless this person may set every one of `fields` on the client."""
    if fields & CLINICAL_FIELDS and not access.can_access_client(client, ClientAccess.CLINICAL):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the client's clinicians can change clinical details"
        )
    if fields & PORTAL_IDENTITY_FIELDS and not access.can_access_client(
        client, ClientAccess.CLINICAL
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the client's clinicians can change the email the client portal signs in with",
        )
    if fields & BILLING_FIELDS and not access.can_access_client(client, ClientAccess.BILLING):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Your role doesn't allow changing billing details"
        )
    if fields - CLINICAL_FIELDS - BILLING_FIELDS:
        _require_profile_editor(access, client)


def _ensure_email_available(
    db: Session, practice_id: int, email: str | None, client_id: int | None = None
) -> None:
    if email is None:
        return
    query = select(Client.id).where(
        Client.practice_id == practice_id, func.lower(Client.email) == email
    )
    if client_id is not None:
        query = query.where(Client.id != client_id)
    if db.scalar(query) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Another client already uses this email")


def _ensure_autopay_possible(db: Session, client: Client) -> None:
    if not settings.stripe_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "Online payments aren't configured")
    has_card = db.scalar(
        select(SavedCard.id).where(SavedCard.client_id == client.id, SavedCard.is_default)
    )
    if has_card is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Save a card for this client before turning on AutoPay"
        )


def _ensure_service(access: Access, service_id: int | None) -> None:
    if service_id is not None:
        access.get(Service, service_id, label="Service")


def _primary_for_new_client(access: Access, requested_id: int | None) -> StaffMember:
    """Clinicians add clients to their own caseload; staff who manage every calendar may
    choose any active clinician (and must choose one if they aren't a clinician)."""
    staff = access.staff
    if not staff.is_clinician and not access.can(Capability.SCHEDULE_ALL):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow adding clients")
    if requested_id is None:
        if not staff.is_clinician:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the client's primary clinician"
            )
        requested_id = staff.id
    if requested_id != staff.id:
        access.require(Capability.SCHEDULE_ALL, "You can only add clients to your own caseload")
    return access.clinician(requested_id)


def _replace_care_team(db: Session, client: Client, primary_id: int, team_ids: set[int]) -> None:
    """Make `team_ids` the client's care team with `primary_id` (one of them) as primary."""
    # Only one primary may exist at a time, so clear the old one before setting the new one.
    for member in client.care_team:
        if member.staff_id != primary_id:
            member.is_primary = False
    client.care_team = [member for member in client.care_team if member.staff_id in team_ids]
    db.flush()
    members = {member.staff_id: member for member in client.care_team}
    for staff_id in sorted(team_ids - members.keys()):
        members[staff_id] = ClientClinician(staff_id=staff_id)
        client.care_team.append(members[staff_id])
    members[primary_id].is_primary = True
    db.flush()


@router.get("", response_model=list[ClientSummary])
def list_clients(
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    page: ListPage,
    response: Response,
    status_filter: ClientStatus | None = Query(default=None, alias="status"),
    q: str = Query(default="", max_length=100, description="Name, email or phone"),
    clinician_id: int | None = Query(default=None),
    level: ClientAccess = Query(
        default=ClientAccess.PROFILE,
        alias="access",
        description="Only clients reachable at this level (e.g. billing for billing pickers)",
    ),
) -> list[Client]:
    """A page of the clients this person can see, by name, excluding archived ones unless
    asked for.

    `clinician_id` narrows the list to clients on that clinician's care team.
    """
    query = select(Client).where(access.client_filter(level))
    if status_filter is not None:
        query = query.where(Client.status == status_filter)
    else:
        query = query.where(Client.status != ClientStatus.ARCHIVED)
    if clinician_id is not None:
        on_team = select(ClientClinician.client_id).where(ClientClinician.staff_id == clinician_id)
        query = query.where(Client.id.in_(on_team))
    term = q.strip()
    if term:
        query = query.where(client_matches(term))
    ordered = query.order_by(Client.last_name, Client.first_name, Client.id)
    clients = list(db.scalars(paginate(db, ordered, page, response)))
    audit_staff_list(db, request, access.staff, "client.list", (client.id for client in clients))
    db.commit()
    return clients


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create_client(
    body: ClientCreate, access: CurrentAccess, db: DbSession, request: Request
) -> ClientOut:
    """Add a client with a primary clinician, optionally emailing them a portal invitation."""
    primary = _primary_for_new_client(access, body.primary_clinician_id)
    _ensure_email_available(db, access.practice_id, body.email)
    _ensure_service(access, body.default_service_id)
    client = Client(
        practice_id=access.practice_id,
        care_team=[ClientClinician(staff_id=primary.id, is_primary=True)],
        **body.model_dump(exclude={"send_portal_invite", "primary_clinician_id"}),
    )
    # Fields left at their defaults change nothing, so only the ones filled in are checked.
    _require_field_access(access, client, set(body.model_dump(exclude_defaults=True)))
    db.add(client)
    db.flush()
    if body.send_portal_invite:
        send_portal_welcome(db, client)
    audit_staff(
        db, request, access.staff, "client.create", "client", client.id, client_id=client.id
    )
    db.commit()
    return client_out(access, client)


@router.get("/{client_id}", response_model=ClientOut)
def get_client(client_id: int, access: CurrentAccess, db: DbSession, request: Request) -> ClientOut:
    """A client's record, with the parts outside this person's access left out."""
    client = access.client(client_id)
    audit_staff(db, request, access.staff, "client.view", "client", client.id, client_id=client.id)
    db.commit()
    return client_out(access, client)


@router.patch("/{client_id}", response_model=ClientOut)
def update_client(
    client_id: int, body: ClientUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> ClientOut:
    """Change any subset of a client's fields (each group needs its own access)."""
    client = access.client(client_id)
    submitted = body.model_dump(exclude_unset=True)
    changes = {
        field: value for field, value in submitted.items() if getattr(client, field) != value
    }
    _require_field_access(access, client, set(changes))
    if "email" in changes:
        _ensure_email_available(db, access.practice_id, changes["email"], client.id)
    if "default_service_id" in changes:
        _ensure_service(access, changes["default_service_id"])
    if changes.get("autopay_enabled") is True:
        _ensure_autopay_possible(db, client)
    revoke_portal = (
        changes.get("portal_enabled") is False or changes.get("status") == ClientStatus.ARCHIVED
    )
    for field, value in changes.items():
        setattr(client, field, value)
    if "email" in changes:
        # Sessions signed in through the old address end with it.
        client.portal_token_version += 1
    if revoke_portal:
        client.portal_token_version += 1
        for contact in client.contacts:
            contact.portal_token_version += 1
    audit_staff(
        db,
        request,
        access.staff,
        "client.update",
        "client",
        client.id,
        {"fields": sorted(changes)},
        client_id=client.id,
    )
    db.commit()
    return client_out(access, client)


@router.put("/{client_id}/care-team", response_model=ClientOut)
def set_care_team(
    client_id: int, body: CareTeamUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> ClientOut:
    """Choose the client's clinicians and primary clinician.

    Allowed for staff who manage every calendar or the practice, and for the client's current
    primary clinician.
    """
    client = access.client(client_id)
    if not access.can_manage_care_team(client):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the primary clinician or a scheduler can change the care team",
        )
    team_ids = {body.primary_clinician_id, *body.clinician_ids}
    for staff_id in team_ids:
        access.clinician(staff_id)
    _replace_care_team(db, client, body.primary_clinician_id, team_ids)
    audit_staff(
        db,
        request,
        access.staff,
        "client.care_team",
        "client",
        client.id,
        {"primary_clinician_id": body.primary_clinician_id, "clinician_ids": sorted(team_ids)},
        client_id=client.id,
    )
    db.commit()
    return client_out(access, client)


@router.post("/{client_id}/portal-invite", response_model=Message)
def invite_to_portal(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Message:
    """Email the client a one-time link into their portal."""
    client = access.client(client_id)
    _require_profile_editor(access, client)
    if not client.email:
        raise HTTPException(status.HTTP_409_CONFLICT, "Add an email address for this client first")
    if not client.can_use_portal:
        raise HTTPException(status.HTTP_409_CONFLICT, "Portal access is turned off for this client")
    send_portal_welcome(db, client)
    audit_staff(
        db, request, access.staff, "client.portal_invite", "client", client.id, client_id=client.id
    )
    db.commit()
    return Message(detail=f"Invitation sent to {client.email}")


@router.post("/{client_id}/export")
def export_client_record(
    client_id: int,
    body: ClientExportRequest,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> Response:
    """Download the client's complete record as a zip (for records requests and transfers).

    Needs clinical access (not through emergency access); billing records are included when
    this person also has billing access to the client. Psychotherapy notes are never included.
    An export for a purpose other than treatment, payment, operations or the client is recorded
    as a disclosure.
    """
    client = access.client(client_id, ClientAccess.CLINICAL)
    if access.only_by_emergency(client):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Emergency access doesn't include exporting the record"
        )
    include_billing = access.can_access_client(client, ClientAccess.BILLING)
    content = build_client_export(access, client, include_billing=include_billing)
    detail: dict[str, Any] = {"billing": include_billing, "purpose": body.purpose}
    if body.purpose == ExportPurpose.OTHER:
        disclosure = Disclosure(
            practice_id=client.practice_id,
            client_id=client.id,
            disclosed_on=utcnow().astimezone(zone_of(client.practice)).date(),
            recipient_name=body.recipient_name.strip(),
            recipient_address=body.recipient_address.strip(),
            description=(
                "Copy of the client's record (profile, appointments, notes, forms, messages and "
                + ("documents, with billing)" if include_billing else "documents)")
            ),
            purpose=body.description.strip(),
            legal_basis=body.legal_basis.strip(),
            source=DisclosureSource.EXPORT,
            recorded_by_id=access.staff.id,
        )
        db.add(disclosure)
        db.flush()
        detail["disclosure_id"] = disclosure.id
    audit_staff(
        db,
        request,
        access.staff,
        "client.export",
        "client",
        client.id,
        detail,
        client_id=client.id,
    )
    record_security_event(
        db,
        practice_id=client.practice_id,
        kind=CLIENT_EXPORTED,
        severity=SecuritySeverity.INFO,
        staff_id=access.staff.id,
        detail={"client_id": client.id, "purpose": body.purpose, "billing": include_billing},
    )
    db.commit()
    filename = f"client-record-{client.id}-{utcnow():%Y%m%d}.zip"
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# Contacts


def _editable_client(access: Access, client_id: int) -> Client:
    """A client whose contacts this person may change (404 if out of reach, else 403)."""
    client = access.client(client_id)
    _require_profile_editor(access, client)
    return client


def _client_contact(client: Client, contact_id: int) -> ClientContact:
    contact = next((contact for contact in client.contacts if contact.id == contact_id), None)
    if contact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Contact not found")
    return contact


def _check_contact(client: Client, contact: ClientContact) -> None:
    """Raise unless the contact's email and portal access fit with the client's other contacts."""
    if contact.portal_access and not contact.email:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Add an email address before giving this contact portal access",
        )
    if contact.email and any(
        other is not contact and other.email == contact.email for other in client.contacts
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Another contact of this client already uses this email"
        )


def _require_portal_grant(access: Access, client: Client) -> None:
    """Giving someone portal access (or changing where their sign-in links go) shows them the
    client's messages and documents, so it takes clinical access to the client."""
    if not access.can_access_client(client, ClientAccess.CLINICAL):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the client's clinicians can give a contact access to the client portal",
        )


def _make_billing_contact(client: Client, contact: ClientContact) -> None:
    """Make `contact` the only one responsible for the client's bills."""
    for other in client.contacts:
        other.responsible_for_billing = other is contact


@router.get("/{client_id}/contacts", response_model=list[ContactOut])
def list_contacts(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[ClientContact]:
    """The client's contacts: guardians, partners, emergency and billing contacts."""
    client = access.client(client_id)
    audit_staff_throttled(
        db, request, access.staff, "client_contact.list", "client", client.id, client_id=client.id
    )
    db.commit()
    return client.contacts


@router.post(
    "/{client_id}/contacts", response_model=ContactOut, status_code=status.HTTP_201_CREATED
)
def add_contact(
    client_id: int, body: ContactFields, access: CurrentAccess, db: DbSession, request: Request
) -> ClientContact:
    """Add a contact; marking them responsible for billing takes it from any other contact."""
    client = _editable_client(access, client_id)
    if body.portal_access:
        _require_portal_grant(access, client)
    contact = ClientContact(**body.model_dump())
    client.contacts.append(contact)
    _check_contact(client, contact)
    if contact.responsible_for_billing:
        _make_billing_contact(client, contact)
    db.flush()
    audit_staff(
        db,
        request,
        access.staff,
        "client_contact.create",
        "client_contact",
        contact.id,
        client_id=client.id,
    )
    db.commit()
    return contact


@router.patch("/{client_id}/contacts/{contact_id}", response_model=ContactOut)
def update_contact(
    client_id: int,
    contact_id: int,
    body: ContactUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> ClientContact:
    """Change a contact. Removing portal access or changing the email ends their portal sessions."""
    client = _editable_client(access, client_id)
    contact = _client_contact(client, contact_id)
    submitted = body.model_dump(exclude_unset=True)
    changes = {
        field: value for field, value in submitted.items() if getattr(contact, field) != value
    }
    grants_portal = changes.get("portal_access") is True
    redirects_portal = "email" in changes and changes.get("portal_access", contact.portal_access)
    if grants_portal or redirects_portal:
        _require_portal_grant(access, client)
    for field, value in changes.items():
        setattr(contact, field, value)
    _check_contact(client, contact)
    if changes.get("responsible_for_billing"):
        _make_billing_contact(client, contact)
    if changes.get("portal_access") is False or "email" in changes:
        contact.portal_token_version += 1
    audit_staff(
        db,
        request,
        access.staff,
        "client_contact.update",
        "client_contact",
        contact.id,
        {"fields": sorted(changes)},
        client_id=client.id,
    )
    db.commit()
    return contact


@router.delete("/{client_id}/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(
    client_id: int, contact_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Remove a contact; their portal sessions stop working."""
    client = _editable_client(access, client_id)
    contact = _client_contact(client, contact_id)
    client.contacts.remove(contact)
    audit_staff(
        db,
        request,
        access.staff,
        "client_contact.delete",
        "client_contact",
        contact_id,
        client_id=client.id,
    )
    db.commit()


@router.post("/{client_id}/contacts/{contact_id}/portal-invite", response_model=Message)
def invite_contact_to_portal(
    client_id: int, contact_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Message:
    """Email a contact with portal access a one-time link into the client's portal."""
    client = _editable_client(access, client_id)
    contact = _client_contact(client, contact_id)
    if not contact.portal_access:
        raise HTTPException(status.HTTP_409_CONFLICT, "Give this contact portal access first")
    if not send_contact_portal_welcome(db, contact):
        raise HTTPException(status.HTTP_409_CONFLICT, "Portal access is turned off for this client")
    audit_staff(
        db,
        request,
        access.staff,
        "client_contact.portal_invite",
        "client_contact",
        contact.id,
        client_id=client.id,
    )
    db.commit()
    return Message(detail=f"Invitation sent to {contact.email}")


# Insurance


@router.get("/{client_id}/insurance", response_model=list[InsurancePolicyOut])
def list_insurance(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[InsurancePolicy]:
    """The client's insurance policies with payers and prior authorizations (billing access)."""
    client = access.client(client_id, ClientAccess.BILLING)
    audit_staff_throttled(
        db, request, access.staff, "insurance.list", "client", client.id, client_id=client.id
    )
    db.commit()
    return client.insurance_policies


@router.post(
    "/{client_id}/insurance", response_model=InsurancePolicyOut, status_code=status.HTTP_201_CREATED
)
def add_insurance(
    client_id: int,
    body: InsurancePolicyFields,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> InsurancePolicy:
    """Add an insurance policy with one of the practice's payers (billing access)."""
    client = access.client(client_id, ClientAccess.BILLING)
    payer = access.get(Payer, body.payer_id, label="Payer")
    policy = InsurancePolicy(
        client_id=client.id, payer=payer, **body.model_dump(exclude={"payer_id"})
    )
    db.add(policy)
    db.flush()
    audit_staff(
        db,
        request,
        access.staff,
        "insurance.create",
        "insurance_policy",
        policy.id,
        client_id=client.id,
    )
    db.commit()
    return policy


def _policy(access: Access, client_id: int, policy_id: int) -> InsurancePolicy:
    client = access.client(client_id, ClientAccess.BILLING)
    policy = access.db.get(InsurancePolicy, policy_id)
    if policy is None or policy.client_id != client.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Insurance policy not found")
    return policy


@router.put("/{client_id}/insurance/{policy_id}", response_model=InsurancePolicyOut)
def update_insurance(
    client_id: int,
    policy_id: int,
    body: InsurancePolicyFields,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> InsurancePolicy:
    """Replace an insurance policy's details (billing access). Authorizations are kept."""
    policy = _policy(access, client_id, policy_id)
    policy.payer = access.get(Payer, body.payer_id, label="Payer")
    for field, value in body.model_dump(exclude={"payer_id"}).items():
        setattr(policy, field, value)
    audit_staff(
        db,
        request,
        access.staff,
        "insurance.update",
        "insurance_policy",
        policy.id,
        client_id=policy.client_id,
    )
    db.commit()
    return policy


@router.delete("/{client_id}/insurance/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_insurance(
    client_id: int, policy_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Remove an insurance policy (billing access). Policies with claims are kept for the
    record; end their coverage with a termination date instead."""
    policy = _policy(access, client_id, policy_id)
    if db.scalar(select(exists().where(Claim.policy_id == policy.id))):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This policy has claims, so it can't be deleted. Set a termination date instead.",
        )
    db.delete(policy)
    audit_staff(
        db,
        request,
        access.staff,
        "insurance.delete",
        "insurance_policy",
        policy_id,
        client_id=policy.client_id,
    )
    db.commit()
