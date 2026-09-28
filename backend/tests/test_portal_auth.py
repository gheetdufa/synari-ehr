"""Client-portal sign-in with one-time email links, for clients and their contacts."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import AuditEvent, Client, ClientClinician, ClientContact, StaffMember
from synari.models.enums import ClientStatus, StaffRole
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    link_token,
    outbound_to,
    portal_headers,
    register_practice,
)


def guardian_of(db: Session, client: Client, **fields: Any) -> ClientContact:
    """A parent with portal access to `client`'s portal."""
    values: dict[str, Any] = {
        "first_name": "Pat",
        "last_name": "Rivera",
        "relation": "Mother",
        "email": "pat@example.com",
        "is_guardian": True,
        "portal_access": True,
        **fields,
    }
    contact = ClientContact(client_id=client.id, **values)
    db.add(contact)
    db.commit()
    return contact


def contact_headers(contact: ClientContact) -> dict[str, str]:
    """Portal headers for a contact signed in to their client's portal."""
    return portal_headers(contact.client, contact)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _request_and_verify(api: TestClient, db: Session, email: str) -> dict:
    assert api.post("/api/portal/auth/request-link", json={"email": email}).status_code == 202
    token = link_token(outbound_to(db, email)[-1].body_text)
    response = api.post("/api/portal/auth/verify", json={"token": token})
    assert response.status_code == 200, response.text
    return response.json()


def test_magic_link_sign_in(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician, email="Alex@Example.com")
    data = _request_and_verify(api, db, "alex@example.com")
    assert data["client"]["id"] == client.id
    assert data["client"]["practice_name"] == "Lee Counseling"
    assert data["client"]["clinician_name"] == "Jordan Lee"
    assert data["client"]["time_zone"] == "America/New_York"
    assert data["client"]["acting_contact"] is None

    email = outbound_to(db, "alex@example.com")[0]
    assert email.subject == "Your sign-in link for Lee Counseling"
    assert "— Lee Counseling" in email.body_text
    assert email.practice_id == clinician.practice_id

    headers = {"Authorization": f"Bearer {data['access_token']}"}
    assert api.get("/api/portal/auth/me", headers=headers).json()["id"] == client.id
    # Portal tokens never work on staff endpoints.
    assert api.get("/api/me", headers=headers).status_code == 401


def test_portal_names_the_primary_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    casey = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    member = db.get(StaffMember, casey.id)
    member.credentials = "LCSW"
    member.time_zone = "America/Chicago"
    db.commit()
    client = create_client_record(db, casey)
    assign_clinician(db, client, clinician)

    me = api.get("/api/portal/auth/me", headers=portal_headers(client)).json()
    assert me["clinician_name"] == "Sam Patel, LCSW"
    assert me["practice_name"] == "Lee Counseling"
    assert me["time_zone"] == "America/Chicago"

    client.time_zone = "America/Denver"
    db.commit()
    me = api.get("/api/portal/auth/me", headers=portal_headers(client)).json()
    assert me["time_zone"] == "America/Denver"


def test_portal_without_a_primary_clinician_names_the_practice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    scheduler = add_staff(db, clinician.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    client = create_client_record(db, scheduler)
    assert db.query(ClientClinician).filter_by(client_id=client.id).count() == 0
    me = api.get("/api/portal/auth/me", headers=portal_headers(client)).json()
    assert me["clinician_name"] == "Lee Counseling"
    assert me["time_zone"] == "America/New_York"


def test_magic_link_is_single_use(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    create_client_record(db, clinician)
    api.post("/api/portal/auth/request-link", json={"email": "alex@example.com"})
    token = link_token(outbound_to(db, "alex@example.com")[-1].body_text)
    assert api.post("/api/portal/auth/verify", json={"token": token}).status_code == 200
    assert api.post("/api/portal/auth/verify", json={"token": token}).status_code == 400


def test_unknown_or_disabled_email_gets_no_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    create_client_record(db, clinician, email="off@example.com", portal_enabled=False)
    create_client_record(db, clinician, email="gone@example.com", status=ClientStatus.ARCHIVED)
    for email in ("off@example.com", "gone@example.com", "nobody@example.com"):
        assert api.post("/api/portal/auth/request-link", json={"email": email}).status_code == 202
        assert outbound_to(db, email) == []


def test_same_person_in_two_practices_gets_a_link_for_each(api: TestClient, db: Session) -> None:
    first = register_practice(api, email="one@example.com", practice_name="Harbor Therapy")
    second = register_practice(api, email="two@example.com", practice_name="Summit Counseling")
    in_first = create_client_record(db, first, email="shared@example.com")
    in_second = create_client_record(db, second, email="shared@example.com")
    api.post("/api/portal/auth/request-link", json={"email": "shared@example.com"})
    emails = outbound_to(db, "shared@example.com")
    assert sorted(e.subject for e in emails) == [
        "Your sign-in link for Harbor Therapy",
        "Your sign-in link for Summit Counseling",
    ]
    signed_in = set()
    for email in emails:
        verified = api.post("/api/portal/auth/verify", json={"token": link_token(email.body_text)})
        signed_in.add((verified.json()["client"]["id"], verified.json()["client"]["practice_name"]))
    assert signed_in == {(in_first.id, "Harbor Therapy"), (in_second.id, "Summit Counseling")}


def test_disabling_portal_revokes_access(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 200
    stored = db.get(Client, client.id)
    stored.portal_enabled = False
    db.commit()
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401


def test_portal_logout_revokes_tokens(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    create_client_record(db, clinician)
    data = _request_and_verify(api, db, "alex@example.com")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    assert api.post("/api/portal/auth/logout", headers=headers).status_code == 200
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401
    refresh = api.post("/api/portal/auth/refresh", json={"refresh_token": data["refresh_token"]})
    assert refresh.status_code == 401


# --- Contacts signing in to a client's portal -------------------------------------------------


def test_guardian_signs_in_to_the_minors_portal(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None, is_minor=True)
    guardian = guardian_of(db, minor)
    data = _request_and_verify(api, db, "pat@example.com")

    [email] = outbound_to(db, "pat@example.com")
    assert email.subject == "Sign in to view Alex's portal"
    assert email.practice_id == clinician.practice_id
    acting = {"id": guardian.id, "name": "Pat Rivera"}
    assert data["client"]["id"] == minor.id
    assert data["client"]["acting_contact"] == acting
    me = api.get("/api/portal/auth/me", headers=_bearer(data["access_token"])).json()
    assert (me["id"], me["acting_contact"]) == (minor.id, acting)

    db.expire_all()
    assert db.get(ClientContact, guardian.id).portal_last_login_at is not None
    assert db.get(Client, minor.id).portal_last_login_at is None
    login = db.query(AuditEvent).filter_by(action="portal.login").one()
    assert (login.actor_role, login.actor_id, login.detail) == (
        "client",
        minor.id,
        {"contact_id": guardian.id},
    )

    refreshed = api.post("/api/portal/auth/refresh", json={"refresh_token": data["refresh_token"]})
    assert refreshed.status_code == 200
    me = api.get("/api/portal/auth/me", headers=_bearer(refreshed.json()["access_token"])).json()
    assert me["acting_contact"] == acting


def test_only_contacts_with_portal_access_get_links(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None)
    guardian_of(db, minor, email="noaccess@example.com", portal_access=False)
    portal_off = create_client_record(db, clinician, email=None, portal_enabled=False)
    guardian_of(db, portal_off, email="off@example.com")
    for email in ("noaccess@example.com", "off@example.com"):
        assert api.post("/api/portal/auth/request-link", json={"email": email}).status_code == 202
        assert outbound_to(db, email) == []


def test_a_parent_gets_a_link_for_each_portal_they_can_open(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician, email=None)
    sam = create_client_record(db, clinician, first_name="Sam", email=None)
    own_record = create_client_record(db, clinician, first_name="Pat", email="pat@example.com")
    guardian_of(db, alex)
    guardian_of(db, sam, email="PAT@example.com")
    api.post("/api/portal/auth/request-link", json={"email": "pat@example.com"})
    emails = outbound_to(db, "pat@example.com")
    assert sorted(e.subject for e in emails) == [
        "Sign in to view Alex's portal",
        "Sign in to view Sam's portal",
        "Your sign-in link for Lee Counseling",
    ]
    opened = set()
    for email in emails:
        verified = api.post("/api/portal/auth/verify", json={"token": link_token(email.body_text)})
        client = verified.json()["client"]
        opened.add((client["id"], client["acting_contact"] is not None))
    assert opened == {(alex.id, True), (sam.id, True), (own_record.id, False)}


def test_contact_tokens_only_open_their_own_clients_portal(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None)
    other = create_client_record(db, clinician, first_name="Blake", email="blake@example.com")
    guardian = guardian_of(db, minor)
    headers = portal_headers(other, guardian)
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401


REVOCATIONS = {
    "portal_access_off": [("contact", "PATCH", {"portal_access": False})],
    "email_changed": [("contact", "PATCH", {"email": "new@example.com"})],
    "deleted": [("contact", "DELETE", None)],
    # Turning the client's portal back on doesn't bring old sessions back.
    "client_archived": [
        ("client", "PATCH", {"status": "archived"}),
        ("client", "PATCH", {"status": "active"}),
    ],
    "client_portal_off": [
        ("client", "PATCH", {"portal_enabled": False}),
        ("client", "PATCH", {"portal_enabled": True}),
    ],
}


@pytest.mark.parametrize("how", list(REVOCATIONS))
def test_guardian_sessions_end_when_access_is_removed(
    api: TestClient, clinician: StaffAccount, db: Session, how: str
) -> None:
    minor = create_client_record(db, clinician, email=None)
    guardian = guardian_of(db, minor)
    data = _request_and_verify(api, db, "pat@example.com")
    headers = _bearer(data["access_token"])
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 200
    urls = {
        "client": f"/api/clients/{minor.id}",
        "contact": f"/api/clients/{minor.id}/contacts/{guardian.id}",
    }
    for target, method, body in REVOCATIONS[how]:
        response = api.request(method, urls[target], json=body, headers=clinician.headers)
        assert response.status_code in (200, 204), response.text
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401
    refresh = api.post("/api/portal/auth/refresh", json={"refresh_token": data["refresh_token"]})
    assert refresh.status_code == 401


def test_guardian_and_client_sign_out_separately(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    guardian = guardian_of(db, client)
    guardian_session = _request_and_verify(api, db, "pat@example.com")
    client_session = _request_and_verify(api, db, "alex@example.com")
    guardian_headers = _bearer(guardian_session["access_token"])
    client_headers = _bearer(client_session["access_token"])

    assert api.post("/api/portal/auth/logout", headers=guardian_headers).status_code == 200
    assert api.get("/api/portal/auth/me", headers=guardian_headers).status_code == 401
    assert api.get("/api/portal/auth/me", headers=client_headers).status_code == 200
    logout = db.query(AuditEvent).filter_by(action="portal.logout").one()
    assert logout.detail == {"contact_id": guardian.id}

    db.expire_all()
    fresh = contact_headers(db.get(ClientContact, guardian.id))
    assert api.post("/api/portal/auth/logout", headers=client_headers).status_code == 200
    assert api.get("/api/portal/auth/me", headers=fresh).status_code == 200
