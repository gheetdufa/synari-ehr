"""Private per-person calendar subscription feeds (ICS)."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import StaffMember
from synari.models.enums import StaffRole, StaffStatus
from synari.services.ics import _fold
from tests.conftest import StaffAccount, add_staff, create_client_record


def _feed_path(api: TestClient, account: StaffAccount) -> str:
    created = api.post("/api/me/calendar-feed", headers=account.headers)
    assert created.status_code == 200, created.text
    return created.json()["url"].split("testserver", 1)[1]


def test_feed_lists_times_without_client_details(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, first_name="Zelda", last_name="Quinn")
    partner = create_client_record(db, clinician, first_name="Yuri", email="yuri@example.com")
    start = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
    individual = api.post(
        "/api/appointments",
        json={
            "participants": [{"client_id": client.id}],
            "starts_at": start.isoformat(),
            "location_type": "video",
        },
        headers=clinician.headers,
    )
    assert individual.status_code == 201, individual.text
    for offset, group in ((1, False), (2, True)):
        shared = api.post(
            "/api/appointments",
            json={
                "participants": [{"client_id": client.id}, {"client_id": partner.id}],
                "group": group,
                "title": "Zelda's group" if group else "",
                "starts_at": (start + timedelta(days=offset)).isoformat(),
            },
            headers=clinician.headers,
        )
        assert shared.status_code == 201, shared.text
    api.post(
        "/api/appointments",
        json={
            "kind": "event",
            "title": "Supervision, weekly",
            "starts_at": (start + timedelta(hours=3)).isoformat(),
        },
        headers=clinician.headers,
    )
    assert api.get("/api/me/calendar-feed", headers=clinician.headers).json() == {"enabled": False}
    path = _feed_path(api, clinician)
    assert api.get("/api/me/calendar-feed", headers=clinician.headers).json() == {"enabled": True}

    feed = api.get(path)
    assert feed.status_code == 200
    assert feed.headers["content-type"].startswith("text/calendar")
    body = feed.text
    assert body.startswith("BEGIN:VCALENDAR\r\n") and body.endswith("END:VCALENDAR\r\n")
    assert "SUMMARY:Client appointment" in body
    assert "SUMMARY:Couples/family session" in body
    assert "SUMMARY:Group session" in body
    assert "LOCATION:Video session" in body
    assert "SUMMARY:Supervision\\, weekly" in body
    for name in ("Zelda", "Quinn", "Yuri"):
        assert name not in body
    assert f"DTSTART:{start:%Y%m%dT%H%M%SZ}" in body

    regenerated = _feed_path(api, clinician)
    assert api.get(path).status_code == 404
    assert api.get(regenerated).status_code == 200
    api.delete("/api/me/calendar-feed", headers=clinician.headers)
    assert api.get(regenerated).status_code == 404


def test_each_person_gets_only_their_own_calendar(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    colleague = add_staff(db, clinician.practice_id, "sam@example.com", StaffRole.CLINICIAN)
    start = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
    for account, title in ((clinician, "Owner meeting"), (colleague, "Colleague meeting")):
        response = api.post(
            "/api/appointments",
            json={"kind": "event", "title": title, "starts_at": start.isoformat()},
            headers=account.headers,
        )
        assert response.status_code == 201, response.text

    mine, theirs = _feed_path(api, clinician), _feed_path(api, colleague)
    assert "Owner meeting" in api.get(mine).text
    assert "Colleague meeting" not in api.get(mine).text
    assert "Colleague meeting" in api.get(theirs).text
    assert "Owner meeting" not in api.get(theirs).text

    # A deactivated person's feed stops working.
    member = db.get(StaffMember, colleague.id)
    assert member is not None
    member.status = StaffStatus.DEACTIVATED
    db.commit()
    assert api.get(theirs).status_code == 404


def test_long_lines_are_folded_on_character_boundaries() -> None:
    line = "SUMMARY:" + "é" * 80
    folded = _fold(line)
    assert all(len(part.encode()) <= 75 for part in folded.split("\r\n"))
    assert folded.replace("\r\n ", "") == line
