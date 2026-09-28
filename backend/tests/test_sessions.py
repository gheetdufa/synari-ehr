"""Server-side sessions: idle and absolute expiry, refresh-token rotation and reuse detection,
per-device sign-out, the sessions list, and portal (client and contact) sessions."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.main import create_app
from synari.models import (
    AuthSession,
    ClientContact,
    PracticeSettings,
    SecurityEvent,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, StaffRole
from synari.services.security_events import REFRESH_TOKEN_REUSE
from synari.services.sessions import REUSE_GRACE
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    link_token,
    outbound_to,
    portal_headers,
)

PASSWORD = "correct horse battery"


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(api: TestClient, email: str, password: str = PASSWORD) -> dict:
    response = api.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def _session_of(db: Session, staff_id: int) -> list[AuthSession]:
    db.expire_all()
    return list(
        db.scalars(
            select(AuthSession).where(AuthSession.subject_id == staff_id).order_by(AuthSession.id)
        )
    )


def _age_sessions(db: Session, **values: object) -> None:
    db.execute(update(AuthSession).values(**values))
    db.commit()


def test_sign_in_creates_a_session_named_by_the_access_token(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    [session] = _session_of(db, clinician.id)
    assert session.subject_role == "staff" and session.family_id == session.id
    assert session.expires_at - session.created_at == timedelta(hours=12)
    assert session.refresh_token_hash != clinician.data["refresh_token"]
    assert len(clinician.data["refresh_token"]) >= 40
    assert clinician.data["idle_timeout_minutes"] == 30
    assert clinician.data["mfa_setup_required"] is False


def test_refresh_rotates_the_refresh_token(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    first = clinician.data["refresh_token"]
    rotated = api.post("/api/auth/refresh", json={"refresh_token": first})
    assert rotated.status_code == 200
    second = rotated.json()["refresh_token"]
    assert second != first
    assert api.get("/api/me", headers=_bearer(rotated.json()["access_token"])).status_code == 200
    # The session keeps its id; the old access token is still valid until it expires.
    assert len(_session_of(db, clinician.id)) == 1
    assert api.get("/api/me", headers=clinician.headers).status_code == 200
    # A refresh from another tab moments later is refused without ending the session.
    assert api.post("/api/auth/refresh", json={"refresh_token": first}).status_code == 401
    assert api.post("/api/auth/refresh", json={"refresh_token": second}).status_code == 200
    assert db.scalars(select(SecurityEvent)).all() == []


def test_reusing_a_rotated_refresh_token_revokes_the_family(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    stolen = clinician.data["refresh_token"]
    rotated = api.post("/api/auth/refresh", json={"refresh_token": stolen}).json()
    _age_sessions(db, rotated_at=utcnow() - REUSE_GRACE - timedelta(seconds=1))

    assert api.post("/api/auth/refresh", json={"refresh_token": stolen}).status_code == 401
    [session] = _session_of(db, clinician.id)
    assert session.revoked_reason == "refresh_token_reuse"
    assert api.get("/api/me", headers=_bearer(rotated["access_token"])).status_code == 401
    legit = api.post("/api/auth/refresh", json={"refresh_token": rotated["refresh_token"]})
    assert legit.status_code == 401
    [event] = db.scalars(select(SecurityEvent)).all()
    assert (event.kind, event.severity, event.staff_id) == (
        REFRESH_TOKEN_REUSE,
        "warning",
        clinician.id,
    )
    assert event.detail["session_id"] == session.id
    # Owners are alerted in the app and by email, without details.
    [alert] = outbound_to(db, clinician.email)
    assert "Reused sign-in token" in alert.subject


def test_sessions_end_after_the_practice_idle_limit(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=29))
    assert api.get("/api/me", headers=clinician.headers).status_code == 200
    # That request counted as activity.
    [session] = _session_of(db, clinician.id)
    assert utcnow() - session.last_seen_at < timedelta(minutes=1)

    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=31))
    assert api.get("/api/me", headers=clinician.headers).status_code == 401
    refresh = api.post("/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]})
    assert refresh.status_code == 401


def test_idle_limit_follows_the_practice_setting_within_bounds(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    practice_settings = db.get(PracticeSettings, clinician.practice_id)
    practice_settings.session_idle_minutes = 60
    db.commit()
    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=45))
    me = api.get("/api/me", headers=clinician.headers)
    assert me.status_code == 200 and me.json()["idle_timeout_minutes"] == 60

    practice_settings.session_idle_minutes = 1  # below the minimum: treated as 5
    db.commit()
    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=4))
    assert api.get("/api/me", headers=clinician.headers).json()["idle_timeout_minutes"] == 5
    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=6))
    assert api.get("/api/me", headers=clinician.headers).status_code == 401


def test_sessions_end_at_their_absolute_lifetime(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    _age_sessions(db, expires_at=utcnow() - timedelta(seconds=1))
    assert api.get("/api/me", headers=clinician.headers).status_code == 401
    refresh = api.post("/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]})
    assert refresh.status_code == 401


def test_activity_is_recorded_at_most_once_a_minute(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    seen = utcnow() - timedelta(seconds=30)
    _age_sessions(db, last_seen_at=seen)
    api.get("/api/me", headers=clinician.headers)
    [session] = _session_of(db, clinician.id)
    assert session.last_seen_at == seen


def test_logout_ends_only_this_device(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    laptop = _login(api, clinician.email)
    assert api.post("/api/auth/logout", headers=clinician.headers).status_code == 200
    assert api.get("/api/me", headers=clinician.headers).status_code == 401
    stale = api.post("/api/auth/refresh", json={"refresh_token": clinician.data["refresh_token"]})
    assert stale.status_code == 401
    assert api.get("/api/me", headers=_bearer(laptop["access_token"])).status_code == 200


def test_sign_out_everywhere_ends_every_session(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    laptop = _login(api, clinician.email)
    everywhere = api.post("/api/auth/logout-everywhere", headers=clinician.headers)
    assert everywhere.status_code == 200
    for headers in (clinician.headers, _bearer(laptop["access_token"])):
        assert api.get("/api/me", headers=headers).status_code == 401
    refresh = api.post("/api/auth/refresh", json={"refresh_token": laptop["refresh_token"]})
    assert refresh.status_code == 401
    assert {s.revoked_reason for s in _session_of(db, clinician.id)} == {"signed_out_everywhere"}


def test_changing_the_password_ends_other_sessions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    laptop = _login(api, clinician.email)
    changed = api.post(
        "/api/auth/change-password",
        headers=clinician.headers,
        json={"current_password": PASSWORD, "new_password": "fresh granite meadow"},
    )
    assert changed.status_code == 200
    assert api.get("/api/me", headers=_bearer(laptop["access_token"])).status_code == 401
    assert api.get("/api/me", headers=_bearer(changed.json()["access_token"])).status_code == 200


def test_my_sessions_list_and_revoke(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    phone_ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1"
    phone = api.post(
        "/api/auth/login",
        json={"email": clinician.email, "password": PASSWORD},
        headers={"User-Agent": phone_ua},
    ).json()
    listed = api.get("/api/me/sessions", headers=clinician.headers)
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 2
    current = [row for row in rows if row["current"]]
    assert len(current) == 1
    other = next(row for row in rows if not row["current"])
    assert other["device"] == "Safari on iPhone"
    assert other["ip_address"] == "testclient"

    assert (
        api.delete(f"/api/me/sessions/{other['id']}", headers=clinician.headers).status_code == 204
    )
    assert api.get("/api/me", headers=_bearer(phone["access_token"])).status_code == 401
    assert [row["id"] for row in api.get("/api/me/sessions", headers=clinician.headers).json()] == [
        current[0]["id"]
    ]
    # Already signed out, or someone else's: not found.
    assert (
        api.delete(f"/api/me/sessions/{other['id']}", headers=clinician.headers).status_code == 404
    )
    colleague = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    [theirs] = _session_of(db, colleague.id)
    assert api.delete(f"/api/me/sessions/{theirs.id}", headers=clinician.headers).status_code == 404
    assert api.get("/api/me", headers=colleague.headers).status_code == 200


@pytest.mark.parametrize(
    ("actor_role", "access_level", "target_role", "expected"),
    [
        (StaffRole.OWNER, ClinicianAccess.BASIC, StaffRole.CLINICIAN, 204),
        (StaffRole.OWNER, ClinicianAccess.BASIC, StaffRole.OWNER, 204),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, StaffRole.CLINICIAN, 204),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, StaffRole.OWNER, 403),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, StaffRole.CLINICIAN, 403),
        (StaffRole.BILLER, ClinicianAccess.BASIC, StaffRole.SCHEDULER, 403),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, StaffRole.BILLER, 403),
    ],
)
def test_team_managers_sign_members_out_everywhere(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    actor_role: StaffRole,
    access_level: ClinicianAccess,
    target_role: StaffRole,
    expected: int,
) -> None:
    actor = add_staff(
        db, clinician.practice_id, "actor@example.com", actor_role, clinician_access=access_level
    )
    target = add_staff(db, clinician.practice_id, "target@example.com", target_role)
    response = api.delete(f"/api/team/{target.id}/sessions", headers=actor.headers)
    assert response.status_code == expected
    signed_out = api.get("/api/me", headers=target.headers).status_code == 401
    assert signed_out is (expected == 204)


def test_you_cant_sign_yourself_out_from_the_team_page(
    api: TestClient, clinician: StaffAccount
) -> None:
    response = api.delete(f"/api/team/{clinician.id}/sessions", headers=clinician.headers)
    assert response.status_code == 400


def test_deactivating_a_member_ends_their_sessions(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    member = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    assert (
        api.post(f"/api/team/{member.id}/deactivate", headers=clinician.headers).status_code == 200
    )
    assert {s.revoked_reason for s in _session_of(db, member.id)} == {"deactivated"}
    db.expire_all()
    member_row = db.get(StaffMember, member.id)
    member_row.status = "active"
    db.commit()
    assert api.get("/api/me", headers=member.headers).status_code == 401


def test_websocket_refuses_ended_sessions(api: TestClient, clinician: StaffAccount) -> None:
    token = clinician.data["access_token"]
    api.post("/api/auth/logout", headers=clinician.headers)
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": token})
        with pytest.raises(Exception):  # noqa: B017  (server closes the socket)
            websocket.receive_json()


@pytest.mark.usefixtures("steady_rate_limits")
def test_limits_hold_across_app_instances(api: TestClient) -> None:
    """Rate limits live in Postgres, so a second API process sees the first one's hits."""
    body = {"email": "nobody@example.com", "password": "x" * 12}
    assert all(api.post("/api/auth/login", json=body).status_code == 401 for _ in range(10))
    with TestClient(create_app()) as second_process:
        assert second_process.post("/api/auth/login", json=body).status_code == 429


# --- Client portal ------------------------------------------------------------------------


def _portal_sign_in(api: TestClient, db: Session, email: str) -> dict:
    api.post("/api/portal/auth/request-link", json={"email": email})
    token = link_token(outbound_to(db, email)[-1].body_text)
    response = api.post("/api/portal/auth/verify", json={"token": token})
    assert response.status_code == 200, response.text
    return response.json()


def test_portal_sessions_rotate_and_expire(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    create_client_record(db, clinician)
    signed_in = _portal_sign_in(api, db, "alex@example.com")
    assert signed_in["client"]["idle_timeout_minutes"] == 30
    session = db.scalar(select(AuthSession).where(AuthSession.subject_role == "client"))
    assert session.expires_at - session.created_at == timedelta(days=7)

    rotated = api.post(
        "/api/portal/auth/refresh", json={"refresh_token": signed_in["refresh_token"]}
    ).json()
    headers = _bearer(rotated["access_token"])
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 200
    _age_sessions(db, last_seen_at=utcnow() - timedelta(minutes=31))
    assert api.get("/api/portal/auth/me", headers=headers).status_code == 401
    refresh = api.post("/api/portal/auth/refresh", json={"refresh_token": rotated["refresh_token"]})
    assert refresh.status_code == 401


def test_portal_refresh_token_reuse_revokes_the_session(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    signed_in = _portal_sign_in(api, db, "alex@example.com")
    api.post("/api/portal/auth/refresh", json={"refresh_token": signed_in["refresh_token"]})
    _age_sessions(db, rotated_at=utcnow() - REUSE_GRACE - timedelta(seconds=1))
    reuse = api.post("/api/portal/auth/refresh", json={"refresh_token": signed_in["refresh_token"]})
    assert reuse.status_code == 401
    [event] = db.scalars(select(SecurityEvent)).all()
    assert event.kind == REFRESH_TOKEN_REUSE and event.staff_id is None
    assert event.practice_id == client.practice_id
    assert event.detail["subject_id"] == client.id


def test_contact_sessions_are_separate_from_the_clients(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    guardian = ClientContact(
        client_id=client.id,
        first_name="Pat",
        last_name="Rivera",
        email="pat@example.com",
        is_guardian=True,
        portal_access=True,
    )
    db.add(guardian)
    db.commit()
    guardian_signed_in = _portal_sign_in(api, db, "pat@example.com")
    guardian_session = db.scalar(select(AuthSession).where(AuthSession.contact_id == guardian.id))
    assert guardian_session.subject_id == client.id
    client_headers = portal_headers(client)

    rotated = api.post(
        "/api/portal/auth/refresh", json={"refresh_token": guardian_signed_in["refresh_token"]}
    ).json()
    guardian_headers = _bearer(rotated["access_token"])
    me = api.get("/api/portal/auth/me", headers=guardian_headers).json()
    assert me["acting_contact"]["id"] == guardian.id

    everywhere = api.post("/api/portal/auth/logout-everywhere", headers=guardian_headers)
    assert everywhere.status_code == 200
    assert api.get("/api/portal/auth/me", headers=guardian_headers).status_code == 401
    assert api.get("/api/portal/auth/me", headers=client_headers).status_code == 200


def test_staff_and_portal_tokens_dont_cross(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    assert api.get("/api/me", headers=portal_headers(client)).status_code == 401
    staff_refresh = {"refresh_token": clinician.data["refresh_token"]}
    assert api.post("/api/portal/auth/refresh", json=staff_refresh).status_code == 401
    assert api.get("/api/portal/auth/me", headers=clinician.headers).status_code == 401
