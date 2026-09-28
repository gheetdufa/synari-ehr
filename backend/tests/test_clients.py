"""Client records: CRUD, contacts, care teams, field-level access by role, insurance and
record export."""

import io
import json
import zipfile
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import (
    AuditEvent,
    Client,
    ClientContact,
    Conversation,
    Message,
    Note,
    Payer,
    PriorAuthorization,
    SavedCard,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, Role, StaffRole, StaffStatus
from synari.services import storage
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    link_token,
    outbound_to,
    portal_headers,
    register_practice,
)

DIAGNOSES = [{"code": "F41.1", "description": "GAD"}]
EXPORT = {"purpose": "treatment"}
SUBSCRIBER = {
    "subscriber_first_name": "Pat",
    "subscriber_last_name": "Rivera",
    "subscriber_dob": "1980-02-03",
    "subscriber_sex": "F",
}


def _create(api: TestClient, account: StaffAccount, **fields: object) -> dict:
    body = {"first_name": "Alex", "last_name": "Rivera", "email": "alex@example.com", **fields}
    response = api.post("/api/clients", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _payer(db: Session, practice_id: int, name: str = "Aetna", external_id: str = "60054") -> Payer:
    payer = Payer(practice_id=practice_id, name=name, external_id=external_id)
    db.add(payer)
    db.commit()
    return payer


def _contact(db: Session, client: Client, **fields: Any) -> ClientContact:
    contact = ClientContact(client_id=client.id, **{"first_name": "Sam", **fields})
    db.add(contact)
    db.commit()
    return contact


@dataclass
class Team:
    """A group practice: the owner (a clinician) and one of each kind of team member."""

    owner: StaffAccount
    clinician: StaffAccount  # basic access, supervised by `supervisor`
    colleague: StaffAccount  # basic access
    supervisor: StaffAccount
    client_list: StaffAccount  # clinician who sees every client's profile
    manager: StaffAccount
    biller: StaffAccount
    scheduler: StaffAccount


@dataclass
class Caseload:
    """One client for the owner, one for `Team.clinician` and one for `Team.colleague`."""

    owners: Client
    clinicians: Client
    colleagues: Client


@pytest.fixture
def team(clinician: StaffAccount, db: Session) -> Team:
    practice_id = clinician.practice_id
    supervisor = add_staff(
        db, practice_id, "riley@example.com", StaffRole.CLINICIAN, first_name="Riley"
    )
    return Team(
        owner=clinician,
        clinician=add_staff(
            db,
            practice_id,
            "casey@example.com",
            StaffRole.CLINICIAN,
            supervisor_id=supervisor.id,
            first_name="Casey",
        ),
        colleague=add_staff(
            db, practice_id, "morgan@example.com", StaffRole.CLINICIAN, first_name="Morgan"
        ),
        supervisor=supervisor,
        client_list=add_staff(
            db,
            practice_id,
            "lee@example.com",
            StaffRole.CLINICIAN,
            clinician_access=ClinicianAccess.CLIENT_LIST,
        ),
        manager=add_staff(db, practice_id, "manager@example.com", StaffRole.PRACTICE_MANAGER),
        biller=add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER),
        scheduler=add_staff(db, practice_id, "scheduler@example.com", StaffRole.SCHEDULER),
    )


@pytest.fixture
def caseload(team: Team, db: Session) -> Caseload:
    return Caseload(
        owners=create_client_record(db, team.owner),
        clinicians=create_client_record(
            db,
            team.clinician,
            first_name="Blake",
            email="blake@example.com",
            diagnosis_codes=DIAGNOSES,
            internal_notes="Prefers morning sessions",
        ),
        colleagues=create_client_record(
            db, team.colleague, first_name="Drew", email="drew@example.com"
        ),
    )


# --- Basics ----------------------------------------------------------------------------------


def test_create_list_and_search_clients(api: TestClient, clinician: StaffAccount) -> None:
    created = _create(api, clinician)
    assert created["care_team"] == [
        {"staff_id": clinician.id, "name": "Jordan Lee", "is_primary": True}
    ]
    assert created["access"] == {"clinical": True, "billing": True}
    assert (created["is_minor"], created["contacts"]) == (False, [])
    _create(api, clinician, first_name="Sam", last_name="Okafor", email="sam@example.com")
    everyone = api.get("/api/clients", headers=clinician.headers).json()
    assert [c["last_name"] for c in everyone] == ["Okafor", "Rivera"]
    assert everyone[0]["care_team"][0]["staff_id"] == clinician.id
    found = api.get("/api/clients", params={"q": "alex riv"}, headers=clinician.headers)
    assert [c["first_name"] for c in found.json()] == ["Alex"]


@pytest.mark.parametrize(
    ("term", "expected"),
    [
        ("OKA", ["Sam"]),
        ("sammy", ["Sam"]),
        ("sam okafor", ["Sam"]),
        ("@EXAMPLE.org", ["Alex"]),
        ("555-0101", ["Alex"]),
        ("3125550199", ["Sam"]),
        ("(312) 555", ["Alex", "Sam"]),
        ("%", []),
        ("_", []),
    ],
)
def test_client_search(
    api: TestClient, clinician: StaffAccount, term: str, expected: list[str]
) -> None:
    _create(api, clinician, email="alex@example.org", phone="312-555-0101")
    _create(
        api,
        clinician,
        first_name="Sam",
        last_name="Okafor",
        preferred_name="Sammy",
        email="sam@example.com",
        phone="(312) 555 0199",
    )
    found = api.get("/api/clients", params={"q": term}, headers=clinician.headers)
    assert found.status_code == 200
    assert sorted(c["first_name"] for c in found.json()) == expected


def test_client_list_pages(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    for index in range(5):
        create_client_record(db, clinician, last_name=f"Page{index}", email=None)

    def page(**params: int) -> tuple[list[str], str]:
        response = api.get("/api/clients", params=params, headers=clinician.headers)
        assert response.status_code == 200
        return [c["last_name"] for c in response.json()], response.headers["x-total-count"]

    assert page(limit=2) == (["Page0", "Page1"], "5")
    assert page(limit=2, offset=2) == (["Page2", "Page3"], "5")
    assert page(limit=2, offset=4) == (["Page4"], "5")
    assert page(offset=10) == ([], "5")
    too_many = api.get("/api/clients", params={"limit": 201}, headers=clinician.headers)
    assert too_many.status_code == 422


def test_clients_are_isolated_between_practices(api: TestClient, clinician: StaffAccount) -> None:
    client = _create(api, clinician)
    other = register_practice(api, email="other@example.com")
    url = f"/api/clients/{client['id']}"
    assert api.get("/api/clients", headers=other.headers).json() == []
    assert api.get(url, headers=other.headers).status_code == 404
    assert api.patch(url, json={"first_name": "X"}, headers=other.headers).status_code == 404
    assert api.post(f"{url}/portal-invite", headers=other.headers).status_code == 404
    assert api.post(f"{url}/export", json=EXPORT, headers=other.headers).status_code == 404
    assert api.get(f"{url}/insurance", headers=other.headers).status_code == 404
    assert api.get(f"{url}/contacts", headers=other.headers).status_code == 404
    contact = {"first_name": "Pat"}
    assert api.post(f"{url}/contacts", json=contact, headers=other.headers).status_code == 404
    care_team = {"primary_clinician_id": other.id, "clinician_ids": []}
    assert api.put(f"{url}/care-team", json=care_team, headers=other.headers).status_code == 404


def test_duplicate_email_within_practice_conflicts(
    api: TestClient, clinician: StaffAccount
) -> None:
    _create(api, clinician)
    response = api.post(
        "/api/clients",
        json={"first_name": "A", "last_name": "B", "email": "ALEX@example.com"},
        headers=clinician.headers,
    )
    assert response.status_code == 409
    other = register_practice(api, email="other@example.com")
    _create(api, other)


def test_diagnosis_codes_are_validated(api: TestClient, clinician: StaffAccount) -> None:
    ok = _create(api, clinician, diagnosis_codes=[{"code": "f41.1", "description": "GAD"}])
    assert ok["diagnosis_codes"] == DIAGNOSES
    bad = api.post(
        "/api/clients",
        json={"first_name": "A", "last_name": "B", "diagnosis_codes": [{"code": "nope"}]},
        headers=clinician.headers,
    )
    assert bad.status_code == 422


def test_viewing_a_client_is_audited(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = _create(api, clinician)
    api.get(f"/api/clients/{client['id']}", headers=clinician.headers)
    views = db.query(AuditEvent).filter_by(action="client.view", resource_id=client["id"]).count()
    assert views == 1


def test_portal_invite_sends_sign_in_email(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    api.patch("/api/me", json={"credentials": "LCSW"}, headers=clinician.headers)
    client = _create(api, clinician, send_portal_invite=True)
    emails = outbound_to(db, "alex@example.com")
    assert len(emails) == 1
    assert "/client/sign-in?token=" in emails[0].body_text
    assert "Lee Counseling" in emails[0].subject
    assert "Jordan Lee, LCSW has set up" in emails[0].body_text
    assert emails[0].practice_id == clinician.practice_id

    no_email = _create(api, clinician, first_name="No", email=None)
    response = api.post(f"/api/clients/{no_email['id']}/portal-invite", headers=clinician.headers)
    assert response.status_code == 409
    again = api.post(f"/api/clients/{client['id']}/portal-invite", headers=clinician.headers)
    assert again.status_code == 200


def test_archiving_revokes_portal_sessions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    created = _create(api, clinician)
    client = db.get(Client, created["id"])
    headers = portal_headers(client)
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 200
    api.patch(
        f"/api/clients/{created['id']}", json={"status": "archived"}, headers=clinician.headers
    )
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401
    assert api.get("/api/clients", headers=clinician.headers).json() == []
    archived = api.get("/api/clients", params={"status": "archived"}, headers=clinician.headers)
    assert len(archived.json()) == 1


def test_insurance_policies_crud(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = _create(api, clinician)
    aetna = _payer(db, clinician.practice_id)
    base = f"/api/clients/{client['id']}/insurance"
    created = api.post(
        base,
        json={
            "payer_id": aetna.id,
            "member_id": "W123",
            "copay_cents": 2500,
            "coinsurance_percent": 20,
            "claim_filing_indicator": "bl",
            "effective_date": "2025-01-01",
        },
        headers=clinician.headers,
    )
    assert created.status_code == 201, created.text
    policy = created.json()
    assert policy["payer"] == {"id": aetna.id, "name": "Aetna", "external_id": "60054"}
    assert policy["subscriber_relationship"] == "18"
    assert policy["claim_filing_indicator"] == "BL"
    assert (policy["copay_cents"], policy["coinsurance_percent"]) == (2500, 20)
    assert policy["authorizations"] == []
    authorization = PriorAuthorization(
        policy_id=policy["id"],
        number="PA-1",
        start_date=date(2025, 1, 1),
        end_date=date(2025, 6, 30),
        visits_authorized=12,
    )
    db.add(authorization)
    db.commit()

    updated = api.put(
        f"{base}/{policy['id']}",
        json={
            "payer_id": aetna.id,
            "member_id": "W999",
            "rank": "primary",
            "subscriber_relationship": "19",
            **SUBSCRIBER,
        },
        headers=clinician.headers,
    )
    assert updated.status_code == 200, updated.text
    changed = updated.json()
    assert (changed["member_id"], changed["copay_cents"]) == ("W999", None)
    assert changed["subscriber_first_name"] == "Pat"
    assert changed["authorizations"] == [
        {
            "id": authorization.id,
            "number": "PA-1",
            "start_date": "2025-01-01",
            "end_date": "2025-06-30",
            "visits_authorized": 12,
        }
    ]
    assert len(api.get(base, headers=clinician.headers).json()) == 1
    assert api.delete(f"{base}/{policy['id']}", headers=clinician.headers).status_code == 204
    assert api.delete(f"{base}/{policy['id']}", headers=clinician.headers).status_code == 404
    audits = db.query(AuditEvent).filter(AuditEvent.action.like("insurance.%"))
    assert [(e.action, e.client_id) for e in audits.order_by(AuditEvent.id)] == [
        ("insurance.create", client["id"]),
        ("insurance.update", client["id"]),
        # Listing is recorded once per ten minutes, however often the tab reloads.
        ("insurance.list", client["id"]),
        ("insurance.delete", client["id"]),
    ]


def test_insurance_payer_must_belong_to_the_practice(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _create(api, clinician)
    other = register_practice(api, email="other@example.com")
    theirs = _payer(db, other.practice_id)
    ours = _payer(db, clinician.practice_id, name="Cigna")
    base = f"/api/clients/{client['id']}/insurance"
    for payer_id in (theirs.id, theirs.id + 100):
        response = api.post(base, json={"payer_id": payer_id}, headers=clinician.headers)
        assert response.status_code == 404
        assert response.json()["detail"] == "Payer not found"
    created = api.post(base, json={"payer_id": ours.id}, headers=clinician.headers)
    assert created.status_code == 201
    moved = api.put(
        f"{base}/{created.json()['id']}", json={"payer_id": theirs.id}, headers=clinician.headers
    )
    assert moved.status_code == 404


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({}, 201),
        ({"subscriber_relationship": "19"}, 422),
        ({"subscriber_relationship": "19", **SUBSCRIBER}, 201),
        ({"subscriber_relationship": "01", **SUBSCRIBER, "subscriber_dob": None}, 422),
        ({"subscriber_relationship": "53", **SUBSCRIBER, "subscriber_last_name": " "}, 422),
        ({"subscriber_relationship": "G8", **SUBSCRIBER}, 201),
        ({"subscriber_relationship": "self"}, 422),
        ({"subscriber_relationship": "19", **SUBSCRIBER, "subscriber_sex": "X"}, 422),
        ({"coinsurance_percent": 100}, 201),
        ({"coinsurance_percent": 101}, 422),
        ({"copay_cents": -1}, 422),
        ({"claim_filing_indicator": "MBX"}, 422),
        ({"effective_date": "2025-06-01", "termination_date": "2025-01-01"}, 422),
        ({"rank": "tertiary"}, 422),
    ],
)
def test_insurance_policy_validation(
    api: TestClient, clinician: StaffAccount, db: Session, fields: dict[str, Any], expected: int
) -> None:
    client = _create(api, clinician)
    payer = _payer(db, clinician.practice_id)
    response = api.post(
        f"/api/clients/{client['id']}/insurance",
        json={"payer_id": payer.id, **fields},
        headers=clinician.headers,
    )
    assert response.status_code == expected, response.text


def test_practice_settings_and_services(api: TestClient, clinician: StaffAccount) -> None:
    practice = api.patch(
        "/api/practice", json={"booking_slug": "lee-counseling"}, headers=clinician.headers
    )
    assert practice.status_code == 200
    assert practice.json()["booking_slug"] == "lee-counseling"
    other = register_practice(api, email="other@example.com")
    taken = api.patch(
        "/api/practice", json={"booking_slug": "lee-counseling"}, headers=other.headers
    )
    assert taken.status_code == 409

    practice_settings = api.patch(
        "/api/practice/settings",
        json={"booking_enabled": True, "reminder_email_hours": 48},
        headers=clinician.headers,
    ).json()
    assert practice_settings["booking_enabled"] is True
    assert practice_settings["reminder_email_hours"] == 48

    services = api.get("/api/practice/services", headers=clinician.headers).json()
    assert sum(s["is_default"] for s in services) == 1
    new = api.post(
        "/api/practice/services",
        json={
            "code": "90846",
            "description": "Family psychotherapy without patient",
            "duration_minutes": 50,
            "rate_cents": 15000,
            "is_default": True,
        },
        headers=clinician.headers,
    )
    assert new.status_code == 201
    services = api.get("/api/practice/services", headers=clinician.headers).json()
    assert [s["code"] for s in services if s["is_default"]] == ["90846"]


def test_audit_log_lists_practice_activity(api: TestClient, clinician: StaffAccount) -> None:
    _create(api, clinician)
    log = api.get("/api/practice/audit-log", headers=clinician.headers).json()["events"]
    assert [e["action"] for e in log][:2] == ["client.create", "account.register"]


def test_autopay_requires_payments_and_a_saved_card(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _create(api, clinician)
    url = f"/api/clients/{client['id']}"
    body = {"autopay_enabled": True}
    assert api.patch(url, json=body, headers=clinician.headers).status_code == 409
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_x")
    assert api.patch(url, json=body, headers=clinician.headers).status_code == 409
    db.add(SavedCard(client_id=client["id"], stripe_payment_method_id="pm_1", is_default=True))
    db.commit()
    response = api.patch(url, json=body, headers=clinician.headers)
    assert response.status_code == 200
    assert response.json()["autopay_enabled"] is True


def test_required_fields_cannot_be_cleared_with_null(
    api: TestClient, clinician: StaffAccount
) -> None:
    client = _create(api, clinician)
    url = f"/api/clients/{client['id']}"
    for field in ("first_name", "status", "phone", "portal_enabled"):
        response = api.patch(url, json={field: None}, headers=clinician.headers)
        assert response.status_code == 422, field
    cleared = api.patch(url, json={"email": None, "date_of_birth": None}, headers=clinician.headers)
    assert cleared.status_code == 200
    assert cleared.json()["email"] is None
    assert (
        api.patch("/api/me", json={"first_name": None}, headers=clinician.headers).status_code
        == 422
    )
    booking_off = api.patch(
        "/api/practice/settings", json={"booking_enabled": None}, headers=clinician.headers
    )
    assert booking_off.status_code == 422


# --- Who sees which clients ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("member", "expected"),
    [
        ("owner", ["Alex", "Blake", "Drew"]),
        ("clinician", ["Blake"]),
        ("colleague", ["Drew"]),
        ("supervisor", ["Blake"]),
        ("client_list", ["Alex", "Blake", "Drew"]),
        ("manager", ["Alex", "Blake", "Drew"]),
        ("biller", ["Alex", "Blake", "Drew"]),
        ("scheduler", ["Alex", "Blake", "Drew"]),
    ],
)
def test_client_list_depends_on_role(
    api: TestClient, team: Team, caseload: Caseload, member: str, expected: list[str]
) -> None:
    listed = api.get("/api/clients", headers=getattr(team, member).headers).json()
    assert sorted(c["first_name"] for c in listed) == expected


@pytest.mark.parametrize(
    ("member", "level", "expected"),
    [
        ("owner", "billing", ["Alex", "Blake", "Drew"]),
        ("supervisor", "clinical", ["Blake"]),
        ("supervisor", "billing", []),
        ("biller", "clinical", []),
        ("biller", "billing", ["Alex", "Blake", "Drew"]),
        ("client_list", "profile", ["Alex", "Blake", "Drew"]),
        ("client_list", "clinical", []),
        ("scheduler", "billing", []),
    ],
)
def test_client_list_by_access_level(
    api: TestClient, team: Team, caseload: Caseload, member: str, level: str, expected: list[str]
) -> None:
    listed = api.get(
        "/api/clients", params={"access": level}, headers=getattr(team, member).headers
    ).json()
    assert sorted(c["first_name"] for c in listed) == expected


def test_client_list_filters_by_clinician(
    api: TestClient, team: Team, caseload: Caseload, db: Session
) -> None:
    def names(clinician_id: int) -> list[str]:
        response = api.get(
            "/api/clients", params={"clinician_id": clinician_id}, headers=team.scheduler.headers
        )
        return sorted(c["first_name"] for c in response.json())

    assert names(team.clinician.id) == ["Blake"]
    assign_clinician(db, caseload.clinicians, team.colleague)
    assert names(team.colleague.id) == ["Blake", "Drew"]
    assert names(team.scheduler.id) == []


@pytest.mark.parametrize(
    ("member", "clinical", "billing"),
    [
        ("owner", True, True),
        ("clinician", True, False),
        ("supervisor", True, False),
        ("client_list", False, False),
        ("manager", False, True),
        ("biller", False, True),
        ("scheduler", False, False),
    ],
)
def test_restricted_fields_depend_on_access(
    api: TestClient,
    team: Team,
    caseload: Caseload,
    member: str,
    clinical: bool,
    billing: bool,
) -> None:
    response = api.get(
        f"/api/clients/{caseload.clinicians.id}", headers=getattr(team, member).headers
    )
    assert response.status_code == 200
    record = response.json()
    assert record["access"] == {"clinical": clinical, "billing": billing}
    assert record["internal_notes"] == ("Prefers morning sessions" if clinical else None)
    assert record["diagnosis_codes"] == (DIAGNOSES if clinical or billing else None)
    assert record["phone"] == "555-201-3344"


def test_basic_clinician_cannot_reach_a_colleagues_client(
    api: TestClient, team: Team, caseload: Caseload
) -> None:
    url = f"/api/clients/{caseload.clinicians.id}"
    headers = team.colleague.headers
    assert api.get(url, headers=headers).status_code == 404
    assert api.patch(url, json={"phone": "1"}, headers=headers).status_code == 404
    assert api.post(f"{url}/portal-invite", headers=headers).status_code == 404
    assert api.post(f"{url}/export", json=EXPORT, headers=headers).status_code == 404
    assert api.get(f"{url}/insurance", headers=headers).status_code == 404
    care_team = {"primary_clinician_id": team.colleague.id, "clinician_ids": []}
    assert api.put(f"{url}/care-team", json=care_team, headers=headers).status_code == 404


# --- Who changes what ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("member", "changes", "expected"),
    [
        ("clinician", {"internal_notes": "Update"}, 200),
        ("clinician", {"phone": "555-000-1111"}, 200),
        ("clinician", {"billing_type": "insurance"}, 403),
        ("supervisor", {"diagnosis_codes": []}, 200),
        ("biller", {"billing_type": "insurance", "rate_override_cents": 9000}, 200),
        ("biller", {"diagnosis_codes": DIAGNOSES, "billing_type": "insurance"}, 200),
        ("biller", {"internal_notes": "Update"}, 403),
        ("biller", {"diagnosis_codes": []}, 403),
        ("biller", {"first_name": "Blaine"}, 403),
        ("scheduler", {"phone": "555-000-1111", "status": "inactive"}, 200),
        ("scheduler", {"is_minor": True}, 200),
        ("clinician", {"is_minor": True}, 200),
        ("biller", {"is_minor": True}, 403),
        ("scheduler", {"billing_type": "insurance"}, 403),
        ("scheduler", {"diagnosis_codes": []}, 403),
        ("manager", {"portal_booking": False, "billing_type": "insurance"}, 200),
        ("manager", {"internal_notes": "Update"}, 403),
        ("client_list", {"phone": "555-000-1111"}, 403),
    ],
)
def test_field_changes_depend_on_access(
    api: TestClient,
    team: Team,
    caseload: Caseload,
    db: Session,
    member: str,
    changes: dict[str, object],
    expected: int,
) -> None:
    client_id = caseload.clinicians.id
    response = api.patch(
        f"/api/clients/{client_id}", json=changes, headers=getattr(team, member).headers
    )
    assert response.status_code == expected, response.text
    db.expire_all()
    stored = db.get(Client, client_id)
    for field, value in changes.items():
        assert (getattr(stored, field) == value) is (expected == 200), field


@pytest.mark.parametrize(
    ("member", "expected"),
    [("biller", 201), ("manager", 201), ("owner", 201), ("clinician", 404), ("scheduler", 404)],
)
def test_insurance_needs_billing_access(
    api: TestClient, team: Team, caseload: Caseload, db: Session, member: str, expected: int
) -> None:
    aetna = _payer(db, team.owner.practice_id)
    cigna = _payer(db, team.owner.practice_id, name="Cigna", external_id="62308")
    base = f"/api/clients/{caseload.clinicians.id}/insurance"
    headers = getattr(team, member).headers
    created = api.post(base, json={"payer_id": aetna.id}, headers=headers)
    assert created.status_code == expected
    if expected != 201:
        return
    policy = f"{base}/{created.json()['id']}"
    changed = api.put(policy, json={"payer_id": cigna.id}, headers=headers)
    assert changed.json()["payer"]["name"] == "Cigna"
    assert api.delete(policy, headers=headers).status_code == 204


@pytest.mark.parametrize(
    ("member", "expected"),
    [
        ("clinician", 200),
        ("supervisor", 200),
        ("scheduler", 200),
        ("manager", 200),
        ("biller", 403),
        ("client_list", 403),
    ],
)
def test_portal_invite_needs_care_team_or_scheduling(
    api: TestClient, team: Team, caseload: Caseload, member: str, expected: int
) -> None:
    url = f"/api/clients/{caseload.clinicians.id}/portal-invite"
    assert api.post(url, headers=getattr(team, member).headers).status_code == expected


# --- Contacts --------------------------------------------------------------------------------


def test_contacts_crud(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = _create(api, clinician)
    base = f"/api/clients/{client['id']}/contacts"
    created = api.post(
        base,
        json={
            "first_name": " Pat ",
            "last_name": "Rivera",
            "relation": "Mother",
            "email": "Pat@Example.com",
            "is_guardian": True,
            "portal_access": True,
        },
        headers=clinician.headers,
    )
    assert created.status_code == 201, created.text
    contact = created.json()
    assert (contact["first_name"], contact["email"]) == ("Pat", "pat@example.com")
    assert (contact["is_guardian"], contact["portal_access"]) == (True, True)
    assert contact["portal_last_login_at"] is None
    record = api.get(f"/api/clients/{client['id']}", headers=clinician.headers).json()
    assert [c["id"] for c in record["contacts"]] == [contact["id"]]

    url = f"{base}/{contact['id']}"
    updated = api.patch(
        url, json={"phone": "555-111-2222", "is_emergency_contact": True}, headers=clinician.headers
    )
    assert updated.status_code == 200, updated.text
    assert (updated.json()["phone"], updated.json()["is_emergency_contact"]) == (
        "555-111-2222",
        True,
    )
    assert api.patch(url, json={"first_name": None}, headers=clinician.headers).status_code == 422
    listed = api.get(base, headers=clinician.headers).json()
    assert [(c["id"], c["relation"]) for c in listed] == [(contact["id"], "Mother")]

    someone_else = _create(api, clinician, first_name="Blake", email="blake@example.com")
    elsewhere = f"/api/clients/{someone_else['id']}/contacts/{contact['id']}"
    assert api.patch(elsewhere, json={"phone": "1"}, headers=clinician.headers).status_code == 404
    assert api.delete(elsewhere, headers=clinician.headers).status_code == 404

    assert api.delete(url, headers=clinician.headers).status_code == 204
    assert api.delete(url, headers=clinician.headers).status_code == 404
    assert api.get(base, headers=clinician.headers).json() == []
    audits = db.query(AuditEvent).filter(
        AuditEvent.action.like("client_contact.%"), AuditEvent.client_id == client["id"]
    )
    assert [(e.action, e.resource_id) for e in audits.order_by(AuditEvent.id)] == [
        ("client_contact.create", contact["id"]),
        ("client_contact.update", contact["id"]),
        # Listing is recorded once per ten minutes, however often the tab reloads.
        ("client_contact.list", client["id"]),
        ("client_contact.delete", contact["id"]),
    ]


def test_only_one_contact_is_responsible_for_billing(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = _create(api, clinician)
    base = f"/api/clients/{client['id']}/contacts"
    first = api.post(
        base, json={"first_name": "Pat", "responsible_for_billing": True}, headers=clinician.headers
    ).json()
    second = api.post(
        base, json={"first_name": "Sam", "responsible_for_billing": True}, headers=clinician.headers
    ).json()

    def billing_flags() -> dict[int, bool]:
        contacts = api.get(base, headers=clinician.headers).json()
        return {c["id"]: c["responsible_for_billing"] for c in contacts}

    assert billing_flags() == {first["id"]: False, second["id"]: True}
    api.patch(
        f"{base}/{first['id']}", json={"responsible_for_billing": True}, headers=clinician.headers
    )
    assert billing_flags() == {first["id"]: True, second["id"]: False}
    db.expire_all()
    assert db.get(Client, client["id"]).billing_contact.id == first["id"]
    api.patch(
        f"{base}/{first['id']}", json={"responsible_for_billing": False}, headers=clinician.headers
    )
    assert billing_flags() == {first["id"]: False, second["id"]: False}


def test_contact_email_rules(api: TestClient, clinician: StaffAccount) -> None:
    client = _create(api, clinician)
    base = f"/api/clients/{client['id']}/contacts"
    headers = clinician.headers
    no_email = api.post(base, json={"first_name": "Pat", "portal_access": True}, headers=headers)
    assert no_email.status_code == 422
    pat = api.post(
        base,
        json={"first_name": "Pat", "email": "pat@example.com", "portal_access": True},
        headers=headers,
    ).json()
    duplicate = api.post(
        base, json={"first_name": "Sam", "email": "PAT@example.com"}, headers=headers
    )
    assert duplicate.status_code == 409
    sam = api.post(base, json={"first_name": "Sam", "email": "sam@example.com"}, headers=headers)
    taken = api.patch(
        f"{base}/{sam.json()['id']}", json={"email": "pat@example.com"}, headers=headers
    )
    assert taken.status_code == 409
    url = f"{base}/{pat['id']}"
    assert api.patch(url, json={"email": None}, headers=headers).status_code == 422
    cleared = api.patch(url, json={"email": None, "portal_access": False}, headers=headers)
    assert cleared.status_code == 200
    assert cleared.json()["email"] is None
    other_client = _create(api, clinician, first_name="Blake", email="blake@example.com")
    same_email = api.post(
        f"/api/clients/{other_client['id']}/contacts",
        json={"first_name": "Sam", "email": "sam@example.com"},
        headers=headers,
    )
    assert same_email.status_code == 201


@pytest.mark.parametrize(
    ("member", "read", "write"),
    [
        ("owner", 200, 200),
        ("clinician", 200, 200),
        ("supervisor", 200, 200),
        ("scheduler", 200, 200),
        ("manager", 200, 200),
        ("biller", 200, 403),
        ("client_list", 200, 403),
        ("colleague", 404, 404),
    ],
)
def test_contact_permissions(
    api: TestClient,
    team: Team,
    caseload: Caseload,
    db: Session,
    member: str,
    read: int,
    write: int,
) -> None:
    client = caseload.clinicians
    existing = _contact(db, client, email="sam@example.com")
    headers = getattr(team, member).headers
    base = f"/api/clients/{client.id}/contacts"
    url = f"{base}/{existing.id}"
    assert api.get(base, headers=headers).status_code == read
    created = api.post(base, json={"first_name": "Pat"}, headers=headers)
    assert created.status_code == (201 if write == 200 else write)
    assert api.patch(url, json={"phone": "555-1"}, headers=headers).status_code == write
    # Allowed callers get past the permission check to "no portal access yet".
    invite = api.post(f"{url}/portal-invite", headers=headers)
    assert invite.status_code == (409 if write == 200 else write)
    assert api.delete(url, headers=headers).status_code == (204 if write == 200 else write)


def test_contact_portal_invite(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = _create(api, clinician)
    base = f"/api/clients/{client['id']}/contacts"
    guardian = api.post(
        base,
        json={"first_name": "Pat", "email": "pat@example.com", "portal_access": True},
        headers=clinician.headers,
    ).json()
    sam = api.post(
        base, json={"first_name": "Sam", "email": "sam@example.com"}, headers=clinician.headers
    ).json()
    # The client's own welcome email isn't sent to contacts.
    api.post(f"/api/clients/{client['id']}/portal-invite", headers=clinician.headers)
    assert outbound_to(db, "pat@example.com") == []

    invited = api.post(f"{base}/{guardian['id']}/portal-invite", headers=clinician.headers)
    assert invited.status_code == 200
    [email] = outbound_to(db, "pat@example.com")
    assert email.subject == "Your access to Alex's client portal with Lee Counseling"
    assert "Jordan Lee has given you access to Alex's secure client portal" in email.body_text
    verified = api.post("/api/portal/auth/verify", json={"token": link_token(email.body_text)})
    assert verified.json()["client"]["acting_contact"] == {"id": guardian["id"], "name": "Pat"}

    no_access = api.post(f"{base}/{sam['id']}/portal-invite", headers=clinician.headers)
    assert no_access.status_code == 409
    api.patch(
        f"/api/clients/{client['id']}", json={"portal_enabled": False}, headers=clinician.headers
    )
    portal_off = api.post(f"{base}/{guardian['id']}/portal-invite", headers=clinician.headers)
    assert portal_off.status_code == 409


# --- Creating clients ------------------------------------------------------------------------


def test_clinicians_add_clients_to_their_own_caseload(api: TestClient, team: Team) -> None:
    own = _create(api, team.clinician)
    assert [m["staff_id"] for m in own["care_team"]] == [team.clinician.id]
    assert own["access"] == {"clinical": True, "billing": False}
    for_colleague = api.post(
        "/api/clients",
        json={"first_name": "A", "last_name": "B", "primary_clinician_id": team.colleague.id},
        headers=team.clinician.headers,
    )
    assert for_colleague.status_code == 403
    by_owner = _create(
        api, team.owner, email="c@example.com", primary_clinician_id=team.colleague.id
    )
    assert by_owner["care_team"][0] == {
        "staff_id": team.colleague.id,
        "name": "Morgan Patel",
        "is_primary": True,
    }


def test_scheduler_must_choose_a_primary_clinician(api: TestClient, team: Team) -> None:
    body = {"first_name": "Avery", "last_name": "Stone"}
    headers = team.scheduler.headers
    missing = api.post("/api/clients", json=body, headers=headers)
    assert missing.status_code == 422
    not_a_clinician = api.post(
        "/api/clients", json={**body, "primary_clinician_id": team.scheduler.id}, headers=headers
    )
    assert not_a_clinician.status_code == 404
    clinical = api.post(
        "/api/clients",
        json={**body, "primary_clinician_id": team.clinician.id, "internal_notes": "Hi"},
        headers=headers,
    )
    assert clinical.status_code == 403
    created = api.post(
        "/api/clients", json={**body, "primary_clinician_id": team.clinician.id}, headers=headers
    )
    assert created.status_code == 201
    record = created.json()
    assert [m["staff_id"] for m in record["care_team"]] == [team.clinician.id]
    assert record["access"] == {"clinical": False, "billing": False}
    assert record["internal_notes"] is None
    listed = api.get("/api/clients", headers=team.clinician.headers).json()
    assert [c["id"] for c in listed] == [record["id"]]


def test_biller_cannot_add_clients(api: TestClient, team: Team) -> None:
    body = {"first_name": "A", "last_name": "B", "primary_clinician_id": team.clinician.id}
    assert api.post("/api/clients", json=body, headers=team.biller.headers).status_code == 403


# --- Care team -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("member", "expected"),
    [
        ("owner", 200),
        ("manager", 200),
        ("scheduler", 200),
        ("clinician", 200),  # the client's primary clinician
        ("supervisor", 403),
        ("biller", 403),
        ("client_list", 403),
        ("colleague", 404),
    ],
)
def test_care_team_permissions(
    api: TestClient, team: Team, caseload: Caseload, member: str, expected: int
) -> None:
    response = api.put(
        f"/api/clients/{caseload.clinicians.id}/care-team",
        json={"primary_clinician_id": team.clinician.id, "clinician_ids": [team.owner.id]},
        headers=getattr(team, member).headers,
    )
    assert response.status_code == expected


def test_care_team_replaces_members_and_primary(
    api: TestClient, team: Team, caseload: Caseload, db: Session
) -> None:
    url = f"/api/clients/{caseload.clinicians.id}"
    moved = api.put(
        f"{url}/care-team",
        json={"primary_clinician_id": team.colleague.id, "clinician_ids": [team.clinician.id]},
        headers=team.scheduler.headers,
    )
    assert moved.status_code == 200, moved.text
    assert [(m["staff_id"], m["is_primary"]) for m in moved.json()["care_team"]] == [
        (team.colleague.id, True),
        (team.clinician.id, False),
    ]
    assert api.get(url, headers=team.colleague.headers).status_code == 200
    no_longer_primary = api.put(
        f"{url}/care-team",
        json={"primary_clinician_id": team.clinician.id, "clinician_ids": []},
        headers=team.clinician.headers,
    )
    assert no_longer_primary.status_code == 403

    handed_back = api.put(
        f"{url}/care-team",
        json={"primary_clinician_id": team.owner.id, "clinician_ids": []},
        headers=team.colleague.headers,
    )
    assert handed_back.status_code == 200
    assert [m["staff_id"] for m in handed_back.json()["care_team"]] == [team.owner.id]
    for member in (team.clinician, team.colleague, team.supervisor):
        assert api.get(url, headers=member.headers).status_code == 404
    changes = db.query(AuditEvent).filter_by(action="client.care_team").count()
    assert changes == 2


def test_care_team_takes_only_active_clinicians_of_the_practice(
    api: TestClient, team: Team, caseload: Caseload, db: Session
) -> None:
    url = f"/api/clients/{caseload.clinicians.id}/care-team"
    other = register_practice(api, email="other@example.com")
    db.get(StaffMember, team.colleague.id).status = StaffStatus.DEACTIVATED
    db.commit()
    for staff_id in (team.scheduler.id, other.id, team.colleague.id):
        response = api.put(
            url,
            json={"primary_clinician_id": team.clinician.id, "clinician_ids": [staff_id]},
            headers=team.owner.headers,
        )
        assert response.status_code == 404, staff_id


# --- Record export ---------------------------------------------------------------------------


@pytest.fixture
def local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


@pytest.mark.usefixtures("local_storage")
def test_client_record_export(api: TestClient, team: Team, caseload: Caseload, db: Session) -> None:
    client = caseload.clinicians
    url = f"/api/clients/{client.id}"
    appointment = create_appointment(
        db,
        team.clinician,
        [client, caseload.colleagues],
        starts_at=datetime(2025, 6, 2, 14, tzinfo=UTC),
        service_code="90834",
    )
    guardian = _contact(
        db, client, first_name="Pat", last_name="Rivera", email="pat@example.com", is_guardian=True
    )
    db.add(
        Note(
            practice_id=client.practice_id,
            author_id=team.clinician.id,
            client_id=client.id,
            appointment_id=appointment.id,
            format="FREEFORM",
            content="Met.",
        )
    )
    conversation = Conversation(
        practice_id=client.practice_id, clinician_id=team.clinician.id, client_id=client.id
    )
    db.add(conversation)
    db.flush()
    db.add_all(
        [
            Message(
                conversation_id=conversation.id,
                sender_role=Role.STAFF,
                sender_staff_id=team.clinician.id,
                body="Hello",
            ),
            Message(conversation_id=conversation.id, sender_role=Role.CLIENT, body="Hi there"),
            Message(
                conversation_id=conversation.id,
                sender_role=Role.CLIENT,
                sender_contact_id=guardian.id,
                body="Blake is running late",
            ),
        ]
    )
    db.commit()
    payer = _payer(db, client.practice_id)
    api.post(
        f"{url}/insurance",
        json={
            "payer_id": payer.id,
            "member_id": "W1",
            "subscriber_relationship": "19",
            **SUBSCRIBER,
        },
        headers=team.owner.headers,
    )
    api.post(
        f"{url}/files",
        files={"file": ("consent.pdf", b"%PDF-1.4 x", "application/pdf")},
        data={"notify": "false"},
        headers=team.clinician.headers,
    )

    response = api.post(f"{url}/export", json=EXPORT, headers=team.owner.headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    bundle = zipfile.ZipFile(io.BytesIO(response.content))
    names = set(bundle.namelist())
    assert {"client.json", "appointments.csv", "notes.csv", "forms.csv", "README.txt"} <= names
    assert {"billing/payments.csv", "messages.txt"} <= names
    assert any(n.startswith("notes/") and n.endswith(".pdf") for n in names)
    assert any(n.startswith("documents/shared_document/") for n in names)
    profile = json.loads(bundle.read("client.json"))
    [policy] = profile["insurance_policies"]
    assert policy["payer"] == {"id": payer.id, "name": "Aetna", "external_id": "60054"}
    assert (policy["subscriber_relationship"], policy["subscriber_first_name"]) == ("19", "Pat")
    assert [(c["first_name"], c["is_guardian"]) for c in profile["contacts"]] == [("Pat", True)]
    assert profile["internal_notes"] == "Prefers morning sessions"
    assert profile["care_team"][0]["staff_id"] == team.clinician.id
    appointments = bundle.read("appointments.csv").decode()
    assert "Casey Patel" in appointments
    assert "150.00" in appointments
    assert "Drew" not in appointments
    assert "Casey Patel" in bundle.read("notes.csv").decode()
    messages = bundle.read("messages.txt").decode()
    assert "Conversation with Casey Patel" in messages
    assert "| Casey Patel\nHello" in messages
    assert "| Client\nHi there" in messages
    assert "| Pat Rivera (for Blake)\nBlake is running late" in messages
    log = api.get("/api/practice/audit-log", headers=team.owner.headers).json()["events"]
    assert "client.export" in [e["action"] for e in log]


@pytest.mark.usefixtures("local_storage")
@pytest.mark.parametrize(
    ("member", "expected", "has_billing"),
    [
        ("owner", 200, True),
        ("clinician", 200, False),
        ("supervisor", 200, False),
        ("manager", 404, False),
        ("biller", 404, False),
        ("scheduler", 404, False),
        ("client_list", 404, False),
        ("colleague", 404, False),
    ],
)
def test_record_export_needs_clinical_access(
    api: TestClient,
    team: Team,
    caseload: Caseload,
    member: str,
    expected: int,
    has_billing: bool,
) -> None:
    response = api.post(
        f"/api/clients/{caseload.clinicians.id}/export",
        json=EXPORT,
        headers=getattr(team, member).headers,
    )
    assert response.status_code == expected
    if expected != 200:
        return
    bundle = zipfile.ZipFile(io.BytesIO(response.content))
    assert ("billing/payments.csv" in bundle.namelist()) is has_billing
    assert ("insurance_policies" in json.loads(bundle.read("client.json"))) is has_billing
