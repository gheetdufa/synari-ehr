import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models.enums import StaffRole
from tests.conftest import StaffAccount, add_staff, register_practice


def test_practice_details_are_managed_by_owners_and_managers(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    manager = add_staff(db, clinician.practice_id, "pm@example.com", StaffRole.PRACTICE_MANAGER)
    body = {
        "name": "Lee & Partners",
        "tax_id": "12-3456789",
        "npi": "1234567893",
        "taxonomy_code": "261QM0801X",
        "billing_provider": "organization",
        "booking_slug": "lee-partners",
    }
    assert api.patch("/api/practice", json=body, headers=colleague.headers).status_code == 403
    updated = api.patch("/api/practice", json=body, headers=manager.headers)
    assert updated.status_code == 200
    assert updated.json()["billing_provider"] == "organization"
    assert api.get("/api/practice", headers=colleague.headers).json()["name"] == "Lee & Partners"

    other = register_practice(api, email="other@example.com")
    taken = api.patch("/api/practice", json={"booking_slug": "lee-partners"}, headers=other.headers)
    assert taken.status_code == 409


@pytest.mark.parametrize(
    ("field", "value"),
    [("npi", "12345"), ("taxonomy_code", "abc"), ("tax_id", "not-a-tin"), ("tax_id_type", "VAT")],
)
def test_practice_billing_identity_is_validated(
    api: TestClient, clinician: StaffAccount, field: str, value: str
) -> None:
    response = api.patch("/api/practice", json={field: value}, headers=clinician.headers)
    assert response.status_code == 422


def test_practice_settings_read_by_all_changed_by_managers(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    scheduler = add_staff(db, clinician.practice_id, "s@example.com", StaffRole.SCHEDULER)
    assert api.get("/api/practice/settings", headers=scheduler.headers).status_code == 200
    denied = api.patch(
        "/api/practice/settings", json={"booking_enabled": True}, headers=scheduler.headers
    )
    assert denied.status_code == 403
    allowed = api.patch(
        "/api/practice/settings", json={"booking_enabled": True}, headers=clinician.headers
    )
    assert allowed.json()["booking_enabled"] is True


def test_services_are_practice_wide(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    new_service = {
        "code": "90839",
        "description": "Crisis",
        "duration_minutes": 60,
        "rate_cents": 20000,
    }
    assert (
        api.post("/api/practice/services", json=new_service, headers=colleague.headers).status_code
        == 403
    )
    created = api.post("/api/practice/services", json=new_service, headers=clinician.headers)
    assert created.status_code == 201
    codes = [s["code"] for s in api.get("/api/practice/services", headers=colleague.headers).json()]
    assert "90839" in codes

    other = register_practice(api, email="other@example.com")
    foreign = api.patch(
        f"/api/practice/services/{created.json()['id']}",
        json={"rate_cents": 1},
        headers=other.headers,
    )
    assert foreign.status_code == 404


def test_locations(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    office = {
        "name": "Downtown",
        "address_line1": "12 Main St",
        "city": "Springfield",
        "state": "IL",
        "postal_code": "62701",
    }
    created = api.post("/api/practice/locations", json=office, headers=clinician.headers)
    assert created.status_code == 201
    assert created.json()["place_of_service"] == "11"
    location_id = created.json()["id"]

    scheduler = add_staff(db, clinician.practice_id, "s@example.com", StaffRole.SCHEDULER)
    names = [
        loc["name"] for loc in api.get("/api/practice/locations", headers=scheduler.headers).json()
    ]
    assert names == ["Downtown", "Video office"]
    edit = api.patch(
        f"/api/practice/locations/{location_id}",
        json={"is_active": False},
        headers=scheduler.headers,
    )
    assert edit.status_code == 403
    closed = api.patch(
        f"/api/practice/locations/{location_id}",
        json={"is_active": False},
        headers=clinician.headers,
    )
    assert closed.json()["is_active"] is False
    bad_pos = api.post(
        "/api/practice/locations",
        json={"name": "X", "place_of_service": "1"},
        headers=clinician.headers,
    )
    assert bad_pos.status_code == 422


def test_audit_log_names_staff_and_is_restricted(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    api.patch("/api/me", json={"credentials": "LPC"}, headers=colleague.headers)
    assert api.get("/api/practice/audit-log", headers=colleague.headers).status_code == 403
    events = api.get("/api/practice/audit-log", headers=clinician.headers).json()["events"]
    update = next(e for e in events if e["action"] == "account.profile_update")
    assert update["actor_name"] == "Sam Patel"

    other = register_practice(api, email="other@example.com")
    foreign = api.get("/api/practice/audit-log", headers=other.headers).json()["events"]
    assert all(e["actor_id"] != colleague.id for e in foreign)


def test_own_profile_and_preferences(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    profile = api.patch(
        "/api/me",
        json={"credentials": "LCSW", "npi": "1234567893", "time_zone": "America/Chicago"},
        headers=colleague.headers,
    )
    assert profile.status_code == 200
    assert profile.json()["staff"]["display_name"] == "Sam Patel, LCSW"
    assert (
        api.patch(
            "/api/me", json={"time_zone": "Nowhere/Land"}, headers=colleague.headers
        ).status_code
        == 422
    )

    prefs = api.patch(
        "/api/me/preferences",
        json={
            "away_message_enabled": True,
            "away_message": "Back Monday",
            "note_format_default": "DAP",
        },
        headers=colleague.headers,
    )
    assert prefs.status_code == 200
    # Preferences are personal: the owner's are untouched.
    mine = api.get("/api/me/preferences", headers=clinician.headers).json()
    assert mine["away_message_enabled"] is False and mine["note_format_default"] == "SOAP"
