"""In-app notifications: the notify() service and the staff and portal bell endpoints."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.models import Notification
from synari.models.enums import Role, StaffRole
from synari.services import notifications
from synari.services.notifications import notify
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    portal_headers,
    register_practice,
)


def _notify_many(
    db: Session, role: Role, recipient_id: int, count: int, **fields: Any
) -> list[Notification]:
    created = [
        notify(db, role, recipient_id, kind="test", title=f"Notice {n}", **fields)
        for n in range(count)
    ]
    db.commit()
    return created


def test_notify_adds_row_and_publishes(
    db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[tuple[list[tuple[Role, int]], str, dict[str, Any]]] = []
    monkeypatch.setattr(
        notifications,
        "publish",
        lambda _db, recipients, event, data: published.append((list(recipients), event, data)),
    )
    notification = notify(
        db,
        Role.STAFF,
        clinician.id,
        kind="form",
        title="x" * 250,
        body="A client completed a form.",
        link="/portal/clients/1",
        urgent=True,
    )
    db.commit()
    assert len(notification.title) == 200
    assert notification.urgent is True
    assert notification.read_at is None
    assert published == [
        (
            [(Role.STAFF, clinician.id)],
            "notification.created",
            {"notification_id": notification.id},
        )
    ]


def test_notify_is_delivered_over_websocket(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        assert websocket.receive_json() == {"type": "ready"}
        notification = notify(db, Role.STAFF, clinician.id, kind="test", title="Hello")
        db.commit()
        assert websocket.receive_json() == {
            "type": "notification.created",
            "data": {"notification_id": notification.id},
        }


def test_staff_list_read_and_count(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    created = _notify_many(db, Role.STAFF, clinician.id, 3, link="/portal/calendar")
    headers = clinician.headers

    listed = api.get("/api/notifications", headers=headers).json()
    assert [n["id"] for n in listed] == [n.id for n in reversed(created)]
    assert set(listed[0]) == {
        "id",
        "kind",
        "title",
        "body",
        "link",
        "urgent",
        "read_at",
        "created_at",
    }
    assert listed[0]["link"] == "/portal/calendar"
    assert api.get("/api/notifications/unread-count", headers=headers).json() == {"count": 3}

    page = api.get(
        "/api/notifications", params={"limit": 1, "before_id": created[2].id}, headers=headers
    ).json()
    assert [n["id"] for n in page] == [created[1].id]

    read = api.post(f"/api/notifications/{created[0].id}/read", headers=headers)
    assert read.status_code == 200
    assert read.json()["read_at"] is not None
    again = api.post(f"/api/notifications/{created[0].id}/read", headers=headers)
    assert again.json()["read_at"] == read.json()["read_at"]
    unread = api.get("/api/notifications", params={"unread_only": True}, headers=headers).json()
    assert [n["id"] for n in unread] == [created[2].id, created[1].id]
    assert api.get("/api/notifications/unread-count", headers=headers).json() == {"count": 2}

    marked = api.post("/api/notifications/read-all", headers=headers)
    assert marked.json() == {"marked_read": 2}
    assert api.get("/api/notifications/unread-count", headers=headers).json() == {"count": 0}
    assert api.post("/api/notifications/read-all", headers=headers).json() == {"marked_read": 0}
    assert api.get("/api/notifications", params={"limit": 201}, headers=headers).status_code == 422


def test_portal_lists_reads_and_counts(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    created = _notify_many(db, Role.CLIENT, client.id, 2, link="/client/messages")

    listed = api.get("/api/portal/notifications", headers=headers).json()
    assert [n["id"] for n in listed] == [created[1].id, created[0].id]
    assert api.get("/api/portal/notifications/unread-count", headers=headers).json() == {"count": 2}
    read = api.post(f"/api/portal/notifications/{created[1].id}/read", headers=headers)
    assert read.status_code == 200
    assert read.json()["read_at"] is not None
    assert api.post("/api/portal/notifications/read-all", headers=headers).json() == {
        "marked_read": 1
    }
    unread = api.get(
        "/api/portal/notifications", params={"unread_only": True}, headers=headers
    ).json()
    assert unread == []


def test_notifications_are_isolated_by_role_and_recipient(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    assert client.id == clinician.id  # same numeric id, different roles
    other_practice = register_practice(api, email="other@example.com")
    colleague = add_staff(db, clinician.practice_id, "billing@example.com", StaffRole.BILLER)
    [staff_notice] = _notify_many(db, Role.STAFF, clinician.id, 1)
    [client_notice] = _notify_many(db, Role.CLIENT, client.id, 1)

    assert [n["id"] for n in api.get("/api/notifications", headers=clinician.headers).json()] == [
        staff_notice.id
    ]
    portal = api.get("/api/portal/notifications", headers=portal_headers(client)).json()
    assert [n["id"] for n in portal] == [client_notice.id]

    for notification_id in (client_notice.id, 9999):
        response = api.post(f"/api/notifications/{notification_id}/read", headers=clinician.headers)
        assert response.status_code == 404
    for outsider in (other_practice, colleague):
        headers = outsider.headers
        assert api.get("/api/notifications", headers=headers).json() == []
        assert api.get("/api/notifications/unread-count", headers=headers).json() == {"count": 0}
        read = api.post(f"/api/notifications/{staff_notice.id}/read", headers=headers)
        assert read.status_code == 404
        assert api.post("/api/notifications/read-all", headers=headers).json() == {"marked_read": 0}
    assert (
        api.post(
            f"/api/portal/notifications/{staff_notice.id}/read",
            headers=portal_headers(client),
        ).status_code
        == 404
    )
    db.refresh(staff_notice)
    db.refresh(client_notice)
    assert staff_notice.read_at is None
    assert client_notice.read_at is None

    assert api.get("/api/portal/notifications", headers=clinician.headers).status_code == 401
    assert api.get("/api/notifications", headers=portal_headers(client)).status_code == 401
    assert api.get("/api/notifications").status_code == 401
