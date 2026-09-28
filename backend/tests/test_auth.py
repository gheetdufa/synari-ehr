from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import AuditEvent, Location, PracticeSettings, Service, StaffMember
from synari.models.enums import Role
from synari.security import create_token
from tests.conftest import StaffAccount, link_token, outbound_to, register_practice


def test_register_creates_practice_with_owner_and_defaults(
    clinician: StaffAccount, db: Session
) -> None:
    assert clinician.data["practice"]["name"] == "Lee Counseling"
    assert clinician.data["staff"]["role"] == "owner"
    assert clinician.data["staff"]["is_clinician"] is True
    assert "manage_team" in clinician.data["capabilities"]
    assert db.get(PracticeSettings, clinician.practice_id) is not None
    codes = {s.code for s in db.query(Service).filter_by(practice_id=clinician.practice_id)}
    assert {"90791", "90834", "90837", "90853"} <= codes
    video = db.query(Location).filter_by(practice_id=clinician.practice_id).one()
    assert video.is_video and video.place_of_service == "10"


def test_register_owner_who_is_not_a_clinician(api: TestClient, db: Session) -> None:
    owner = register_practice(api, email="admin@example.com", is_clinician=False)
    assert db.get(StaffMember, owner.id).is_clinician is False


def test_register_rejects_duplicate_email_case_insensitively(
    api: TestClient, clinician: StaffAccount
) -> None:
    response = api.post(
        "/api/auth/register",
        json={
            "email": "JORDAN@example.com",
            "password": "another long password",
            "first_name": "J",
            "last_name": "L",
        },
    )
    assert response.status_code == 409


def test_register_validates_password_and_time_zone(api: TestClient) -> None:
    short = api.post(
        "/api/auth/register",
        json={"email": "a@example.com", "password": "short", "first_name": "A", "last_name": "B"},
    )
    assert short.status_code == 422
    bad_zone = api.post(
        "/api/auth/register",
        json={
            "email": "a@example.com",
            "password": "long enough password",
            "first_name": "A",
            "last_name": "B",
            "time_zone": "Mars/Olympus",
        },
    )
    assert bad_zone.status_code == 422


def test_login_success_and_wrong_password(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    ok = api.post(
        "/api/auth/login", json={"email": clinician.email, "password": "correct horse battery"}
    )
    assert ok.status_code == 200
    assert ok.json()["staff"]["email"] == clinician.email

    bad = api.post(
        "/api/auth/login", json={"email": clinician.email, "password": "wrong password!"}
    )
    assert bad.status_code == 401
    unknown = api.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "x" * 12}
    )
    assert unknown.status_code == 401

    actions = [e.action for e in db.query(AuditEvent).order_by(AuditEvent.id)]
    assert actions.count("auth.login_failed") == 2
    assert "auth.login" in actions


def test_me_requires_access_token(api: TestClient, clinician: StaffAccount) -> None:
    assert api.get("/api/me").status_code == 401
    session = api.get("/api/me", headers=clinician.headers).json()
    assert session["staff"]["id"] == clinician.id
    assert session["practice"]["id"] == clinician.practice_id

    refresh = clinician.data["refresh_token"]
    refresh_as_access = api.get("/api/me", headers={"Authorization": f"Bearer {refresh}"})
    assert refresh_as_access.status_code == 401


def test_client_token_cannot_access_staff_routes(api: TestClient, clinician: StaffAccount) -> None:
    client_token = create_token(
        subject_id=clinician.id,
        role=Role.CLIENT,
        token_type="access",
        version=0,
        expires_in=timedelta(minutes=5),
    )
    response = api.get("/api/me", headers={"Authorization": f"Bearer {client_token}"})
    assert response.status_code == 401


def test_refresh_and_logout_end_the_session(api: TestClient, clinician: StaffAccount) -> None:
    refreshed = api.post(
        "/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]}
    )
    assert refreshed.status_code == 200

    assert api.post("/api/auth/logout", headers=clinician.headers).status_code == 200
    assert api.get("/api/me", headers=clinician.headers).status_code == 401
    stale = api.post("/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]})
    assert stale.status_code == 401


def test_password_reset_flow(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    response = api.post("/api/auth/password-reset/request", json={"email": clinician.email})
    assert response.status_code == 202
    unknown = api.post("/api/auth/password-reset/request", json={"email": "ghost@example.com"})
    assert unknown.json() == response.json()

    emails = outbound_to(db, clinician.email)
    assert len(emails) == 1
    token = link_token(emails[0].body_text)

    confirm = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "a brand new password"},
    )
    assert confirm.status_code == 200
    assert api.get("/api/me", headers=clinician.headers).status_code == 401

    reused = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "yet another password"},
    )
    assert reused.status_code == 400
    login = api.post(
        "/api/auth/login", json={"email": clinician.email, "password": "a brand new password"}
    )
    assert login.status_code == 200


def test_change_password_requires_current(api: TestClient, clinician: StaffAccount) -> None:
    wrong = api.post(
        "/api/auth/change-password",
        headers=clinician.headers,
        json={"current_password": "not it at all", "new_password": "fresh password 123"},
    )
    assert wrong.status_code == 400
    ok = api.post(
        "/api/auth/change-password",
        headers=clinician.headers,
        json={"current_password": "correct horse battery", "new_password": "fresh password 123"},
    )
    assert ok.status_code == 200
    new_headers = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    assert api.get("/api/me", headers=new_headers).status_code == 200
    assert api.get("/api/me", headers=clinician.headers).status_code == 401


@pytest.mark.usefixtures("steady_rate_limits")
def test_login_is_rate_limited(api: TestClient) -> None:
    register_practice(api, email="limit@example.com")
    statuses = [
        api.post(
            "/api/auth/login", json={"email": "limit@example.com", "password": "x" * 12}
        ).status_code
        for _ in range(11)
    ]
    assert statuses[-1] == 429
