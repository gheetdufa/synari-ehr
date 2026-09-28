import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import AuditEvent, Service, StaffMember
from synari.models.enums import ClinicianAccess, StaffRole, StaffStatus
from tests.conftest import StaffAccount, add_staff, link_token, outbound_to, register_practice

PASSWORD = "a strong new password"


def _invite(api: TestClient, inviter: StaffAccount, **body: object) -> dict:
    payload = {
        "email": "casey@example.com",
        "first_name": "Casey",
        "last_name": "Morgan",
        "role": "clinician",
        **body,
    }
    response = api.post("/api/team/invitations", json=payload, headers=inviter.headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_invited_clinician_joins_and_signs_in(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    member = _invite(api, clinician, credentials="LMFT")
    assert member["status"] == "invited" and member["is_clinician"] is True
    # Pending members can't sign in yet.
    login = api.post("/api/auth/login", json={"email": "casey@example.com", "password": "x" * 12})
    assert login.status_code == 401

    email = outbound_to(db, "casey@example.com")[-1]
    assert "Lee Counseling" in email.subject
    token = link_token(email.body_text)
    preview = api.get(f"/api/auth/invitations/{token}")
    assert preview.json() == {
        "email": "casey@example.com",
        "first_name": "Casey",
        "last_name": "Morgan",
        "practice_name": "Lee Counseling",
        "role": "clinician",
    }

    joined = api.post("/api/auth/invitations/accept", json={"token": token, "password": PASSWORD})
    assert joined.status_code == 200
    assert joined.json()["staff"]["status"] == "active"
    assert joined.json()["practice"]["id"] == clinician.practice_id
    assert "manage_team" not in joined.json()["capabilities"]

    reused = api.post("/api/auth/invitations/accept", json={"token": token, "password": PASSWORD})
    assert reused.status_code == 400
    login = api.post("/api/auth/login", json={"email": "casey@example.com", "password": PASSWORD})
    assert login.status_code == 200


def test_resending_an_invitation_replaces_the_old_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    member = _invite(api, clinician)
    first = link_token(outbound_to(db, "casey@example.com")[-1].body_text)
    resent = api.post(f"/api/team/{member['id']}/invitation", headers=clinician.headers)
    assert resent.status_code == 200
    second = link_token(outbound_to(db, "casey@example.com")[-1].body_text)
    assert api.get(f"/api/auth/invitations/{first}").status_code == 400
    assert api.get(f"/api/auth/invitations/{second}").status_code == 200


def test_revoking_an_invitation(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    member = _invite(api, clinician)
    token = link_token(outbound_to(db, "casey@example.com")[-1].body_text)
    revoked = api.delete(f"/api/team/{member['id']}/invitation", headers=clinician.headers)
    assert revoked.status_code == 204
    assert db.get(StaffMember, member["id"]) is None
    assert api.get(f"/api/auth/invitations/{token}").status_code == 400


def test_invitation_rules(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    duplicate = api.post(
        "/api/team/invitations",
        json={"email": clinician.email, "first_name": "J", "last_name": "L", "role": "biller"},
        headers=clinician.headers,
    )
    assert duplicate.status_code == 409

    biller = _invite(api, clinician, email="bill@example.com", role="biller", is_clinician=True)
    assert biller["is_clinician"] is False  # billers never see clients as a clinician

    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    owner_by_manager = api.post(
        "/api/team/invitations",
        json={"email": "o2@example.com", "first_name": "O", "last_name": "T", "role": "owner"},
        headers=manager.headers,
    )
    assert owner_by_manager.status_code == 403
    assert _invite(api, manager, email="c2@example.com")["role"] == "clinician"

    bad_supervisor = api.post(
        "/api/team/invitations",
        json={
            "email": "c3@example.com",
            "first_name": "C",
            "last_name": "T",
            "role": "clinician",
            "supervisor_id": manager.id,  # not a clinician
        },
        headers=clinician.headers,
    )
    assert bad_supervisor.status_code == 400


@pytest.mark.parametrize(
    ("role", "access", "can_manage"),
    [
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, False),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, False),
        (StaffRole.BILLER, ClinicianAccess.BASIC, False),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, False),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, True),
    ],
)
def test_only_team_managers_can_invite(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    access: ClinicianAccess,
    can_manage: bool,
) -> None:
    member = add_staff(db, clinician.practice_id, "m@example.com", role, clinician_access=access)
    response = api.post(
        "/api/team/invitations",
        json={"email": "new@example.com", "first_name": "N", "last_name": "P", "role": "clinician"},
        headers=member.headers,
    )
    assert response.status_code == (201 if can_manage else 403)


def test_team_list_hides_pending_members_from_non_managers(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _invite(api, clinician)
    colleague = add_staff(db, clinician.practice_id, "col@example.com", StaffRole.CLINICIAN)
    other_practice = register_practice(api, email="other@example.com")

    everyone = api.get("/api/team", headers=clinician.headers).json()
    assert {m["status"] for m in everyone} == {"active", "invited"}
    active_only = api.get("/api/team", headers=colleague.headers).json()
    assert {m["email"] for m in active_only} == {clinician.email, "col@example.com"}
    assert {m["email"] for m in api.get("/api/team", headers=other_practice.headers).json()} == {
        "other@example.com"
    }


def test_changing_roles(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    member = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    promoted = api.patch(
        f"/api/team/{member.id}",
        json={"clinician_access": "practice", "npi": "1234567893", "claim_modifier": "HO"},
        headers=clinician.headers,
    )
    assert promoted.status_code == 200
    assert promoted.json()["claim_modifier"] == "HO"
    bad_modifier = api.patch(
        f"/api/team/{member.id}", json={"claim_modifier": "HOO"}, headers=clinician.headers
    )
    assert bad_modifier.status_code == 422
    session = api.get("/api/me", headers=member.headers).json()
    assert "clinical_all" in session["capabilities"]

    to_biller = api.patch(
        f"/api/team/{member.id}", json={"role": "biller"}, headers=clinician.headers
    )
    assert to_biller.json()["is_clinician"] is False

    own_role = api.patch(
        f"/api/team/{clinician.id}", json={"role": "clinician"}, headers=clinician.headers
    )
    assert own_role.status_code == 400
    audit = db.query(AuditEvent).filter_by(action="team.update").count()
    assert audit == 2


def test_practice_keeps_an_owner(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    second_owner = add_staff(db, clinician.practice_id, "o2@example.com", StaffRole.OWNER)
    demote = api.patch(
        f"/api/team/{clinician.id}", json={"role": "clinician"}, headers=second_owner.headers
    )
    assert demote.status_code == 200
    last = api.patch(
        f"/api/team/{second_owner.id}", json={"role": "clinician"}, headers=second_owner.headers
    )
    assert last.status_code == 400  # own role, and the last owner
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    by_manager = api.post(f"/api/team/{second_owner.id}/deactivate", headers=manager.headers)
    assert by_manager.status_code == 403


def test_deactivation_revokes_access_until_reactivated(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    member = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    assert api.get("/api/me", headers=member.headers).status_code == 200
    self_off = api.post(f"/api/team/{clinician.id}/deactivate", headers=clinician.headers)
    assert self_off.status_code == 400

    off = api.post(f"/api/team/{member.id}/deactivate", headers=clinician.headers)
    assert off.json()["status"] == "deactivated"
    assert api.get("/api/me", headers=member.headers).status_code == 401

    on = api.post(f"/api/team/{member.id}/reactivate", headers=clinician.headers)
    assert on.json()["status"] == "active"
    db.expire_all()
    assert db.get(StaffMember, member.id).status == StaffStatus.ACTIVE


def test_clinician_service_rates(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    member = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    services = {
        s.code: s.id for s in db.query(Service).filter_by(practice_id=clinician.practice_id)
    }
    rates = [
        {"service_id": services["90834"], "offered": True, "rate_cents": 15000},
        {"service_id": services["90791"], "offered": False, "rate_cents": None},
    ]
    saved = api.put(f"/api/team/{member.id}/services", json=rates, headers=clinician.headers)
    assert saved.status_code == 200
    by_service = {entry["service_id"]: entry for entry in saved.json()}
    assert by_service[services["90834"]]["rate_cents"] == 15000
    assert by_service[services["90791"]]["offered"] is False
    assert by_service[services["90837"]] == {
        "service_id": services["90837"],
        "offered": True,
        "rate_cents": None,
    }

    # Clinicians can see their own rates but not set them; colleagues can't see them.
    mine = api.get(f"/api/team/{member.id}/services", headers=member.headers)
    assert mine.status_code == 200
    assert (
        api.put(f"/api/team/{member.id}/services", json=[], headers=member.headers).status_code
        == 403
    )
    colleague = add_staff(db, clinician.practice_id, "c2@example.com", StaffRole.CLINICIAN)
    assert api.get(f"/api/team/{member.id}/services", headers=colleague.headers).status_code == 403

    other = register_practice(api, email="other@example.com")
    foreign = api.get(f"/api/team/{member.id}/services", headers=other.headers)
    assert foreign.status_code == 404
