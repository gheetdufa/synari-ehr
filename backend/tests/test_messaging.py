"""Secure messaging: threads, attachments, read receipts, notices, away replies, crisis alerts,
and who on a practice team can read and reply in which conversation."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import (
    AuditEvent,
    Client,
    ClientClinician,
    ClientContact,
    Conversation,
    Message,
    Notification,
    OutboundMessage,
    StoredFile,
)
from synari.models.enums import (
    ClientStatus,
    FilePurpose,
    OutboundStatus,
    RiskLevel,
    Role,
    StaffRole,
)
from synari.services import messaging, notifications, outbox, storage
from synari.services.crisis import assess_risk
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
from tests.test_portal_auth import contact_headers, guardian_of

PDF = ("plan.pdf", b"%PDF-1.4 plan", "application/pdf")


@dataclass
class Event:
    type: str
    to: list[tuple[str, int]]
    data: dict[str, Any]


@pytest.fixture(autouse=True)
def _local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[Event]:
    recorded: list[Event] = []

    def record(_db: Session, recipients: Any, event_type: str, data: dict[str, Any]) -> None:
        recorded.append(Event(event_type, [(str(role), rid) for role, rid in recipients], data))

    monkeypatch.setattr(messaging, "publish", record)
    monkeypatch.setattr(notifications, "publish", record)
    return recorded


def _open(api: TestClient, account: StaffAccount, client: Client) -> int:
    """Open the staff member's own conversation with a client; returns its id."""
    response = api.post(f"/api/clients/{client.id}/conversations", headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _portal_open(api: TestClient, client: Client, clinician_id: int) -> int:
    response = api.post(
        "/api/portal/conversations",
        json={"clinician_id": clinician_id},
        headers=portal_headers(client),
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _send(
    api: TestClient, account: StaffAccount, conversation_id: int, body: str = "Hi", **extra: Any
) -> dict[str, Any]:
    response = api.post(
        f"/api/conversations/{conversation_id}/messages",
        json={"body": body, **extra},
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _portal_send(
    api: TestClient, client: Client, conversation_id: int, body: str = "Hello", **extra: Any
) -> dict[str, Any]:
    response = api.post(
        f"/api/portal/conversations/{conversation_id}/messages",
        json={"body": body, **extra},
        headers=portal_headers(client),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _thread(
    api: TestClient, account: StaffAccount, conversation_id: int, **params: Any
) -> list[dict[str, Any]]:
    response = api.get(
        f"/api/conversations/{conversation_id}/messages", params=params, headers=account.headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def _portal_thread(
    api: TestClient, client: Client, conversation_id: int, **params: Any
) -> list[dict[str, Any]]:
    response = api.get(
        f"/api/portal/conversations/{conversation_id}/messages",
        params=params,
        headers=portal_headers(client),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _inbox(api: TestClient, account: StaffAccount, **params: Any) -> list[dict[str, Any]]:
    response = api.get("/api/conversations", params=params, headers=account.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _portal_conversations(api: TestClient, client: Client) -> list[dict[str, Any]]:
    response = api.get("/api/portal/conversations", headers=portal_headers(client))
    assert response.status_code == 200, response.text
    return response.json()


def _upload(api: TestClient, url: str, headers: dict[str, str]) -> dict[str, Any]:
    response = api.post(url, files={"file": PDF}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def _read(api: TestClient, account: StaffAccount, conversation_id: int) -> None:
    response = api.post(f"/api/conversations/{conversation_id}/read", headers=account.headers)
    assert response.status_code == 204, response.text


def _unread(api: TestClient, account: StaffAccount) -> int:
    return api.get("/api/messages/unread-count", headers=account.headers).json()["count"]


def _preferences(api: TestClient, account: StaffAccount, **changes: Any) -> None:
    response = api.patch("/api/me/preferences", json=changes, headers=account.headers)
    assert response.status_code == 200, response.text


def _practice_settings(api: TestClient, account: StaffAccount, **changes: Any) -> None:
    response = api.patch("/api/practice/settings", json=changes, headers=account.headers)
    assert response.status_code == 200, response.text


def _colleague(db: Session, practice_id: int, **fields: Any) -> StaffAccount:
    """Sam Patel, a clinician with basic access in the same practice."""
    return add_staff(db, practice_id, "sam@example.com", StaffRole.CLINICIAN, **fields)


# A clinician and their client


def test_clinician_and_client_exchange_messages(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    opened = api.post(f"/api/clients/{client.id}/conversations", headers=clinician.headers)
    conversation_id = opened.json()["id"]
    assert opened.json() == {
        "id": conversation_id,
        "client": {
            "id": client.id,
            "first_name": "Alex",
            "last_name": "Rivera",
            "preferred_name": "",
        },
        "clinician": {"id": clinician.id, "name": "Jordan Lee"},
        "last_message_at": None,
        "unread_count": 0,
        "last_message_preview": "",
        "has_urgent": False,
    }
    assert _thread(api, clinician, conversation_id) == []

    sent = _send(api, clinician, conversation_id, "  How was your week?  ")
    assert sent["body"] == "How was your week?"
    assert sent["sender_role"] == "staff"
    assert sent["sender_staff_id"] == clinician.id
    assert sent["sender_name"] == "Jordan Lee"
    assert sent["risk_level"] == "none"
    assert sent["removed"] is False
    assert sent["is_automatic"] is False
    assert sent["attachments"] == []
    assert sent["read_by_recipient"] is False

    [row] = _portal_conversations(api, client)
    assert row["id"] == conversation_id
    assert row["clinician"] == {"id": clinician.id, "name": "Jordan Lee"}
    assert row["unread_count"] == 1
    reply = _portal_send(api, client, conversation_id, "Better, thanks")
    assert reply["conversation_id"] == conversation_id
    assert reply["sender_name"] is None
    assert reply["crisis_resources"] is False
    assert "risk_level" not in reply
    assert "sender_staff_id" not in reply

    thread = _thread(api, clinician, conversation_id)
    assert [m["body"] for m in thread] == ["How was your week?", "Better, thanks"]
    assert [m["sender_role"] for m in thread] == ["staff", "client"]
    assert [m["sender_staff_id"] for m in thread] == [clinician.id, None]
    portal = _portal_thread(api, client, conversation_id)
    assert [m["id"] for m in portal] == [m["id"] for m in thread]
    assert [m["sender_name"] for m in portal] == ["Jordan Lee", None]
    assert all("risk_level" not in m for m in portal)

    assert _open(api, clinician, client) == conversation_id
    assert _portal_open(api, client, clinician.id) == conversation_id
    conversation = db.scalars(select(Conversation)).one()
    assert conversation.practice_id == clinician.practice_id
    assert conversation.clinician_id == clinician.id


def test_read_receipts_and_unread_counts(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    conversation_id = _open(api, clinician, client)
    _portal_send(api, client, conversation_id, "One")
    _portal_send(api, client, conversation_id, "Two")
    assert _unread(api, clinician) == 2
    [row] = _inbox(api, clinician)
    assert row["unread_count"] == 2

    events.clear()
    _read(api, clinician, conversation_id)
    assert _unread(api, clinician) == 0
    [event] = events
    assert event.type == "conversation.read"
    # The other side gets a read receipt; the reader's other tabs clear their badges.
    assert sorted(event.to) == [("client", client.id), ("staff", clinician.id)]
    assert event.data["conversation_id"] == conversation_id
    assert event.data["client_id"] == client.id
    assert event.data["reader_role"] == "staff"
    assert event.data["read_at"]
    assert all(m["read_by_recipient"] for m in _portal_thread(api, client, conversation_id))

    _send(api, clinician, conversation_id, "Reply")
    assert api.get("/api/portal/messages/unread-count", headers=headers).json() == {"count": 1}
    assert _thread(api, clinician, conversation_id)[-1]["read_by_recipient"] is False
    read = api.post(f"/api/portal/conversations/{conversation_id}/read", headers=headers)
    assert read.status_code == 204
    assert api.get("/api/portal/messages/unread-count", headers=headers).json() == {"count": 0}
    assert _thread(api, clinician, conversation_id)[-1]["read_by_recipient"] is True


def test_thread_pages_backwards(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    ids = [_send(api, clinician, conversation_id, f"Message {n}")["id"] for n in range(5)]

    newest = _thread(api, clinician, conversation_id, limit=2)
    assert [m["id"] for m in newest] == ids[3:]
    older = _thread(api, clinician, conversation_id, limit=2, before_id=newest[0]["id"])
    assert [m["id"] for m in older] == ids[1:3]
    oldest = _portal_thread(api, client, conversation_id, limit=2, before_id=older[0]["id"])
    assert [m["id"] for m in oldest] == ids[:1]
    too_big = api.get(
        f"/api/conversations/{conversation_id}/messages",
        params={"limit": 101},
        headers=clinician.headers,
    )
    assert too_big.status_code == 422


def test_inbox_orders_by_latest_and_previews(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    alex = create_client_record(db, clinician)
    sam = create_client_record(
        db, clinician, first_name="Sam", last_name="Park", email="sam@example.com"
    )
    with_alex = _open(api, clinician, alex)
    with_sam = _open(api, clinician, sam)
    _portal_send(api, alex, with_alex, "x" * 300)
    _send(api, clinician, with_sam, "Checking in")

    inbox = _inbox(api, clinician)
    assert [row["id"] for row in inbox] == [with_sam, with_alex]
    assert inbox[0]["client"]["first_name"] == "Sam"
    assert inbox[0]["unread_count"] == 0
    assert inbox[0]["last_message_preview"] == "Checking in"
    assert inbox[1]["last_message_preview"] == "x" * 120
    assert inbox[1]["unread_count"] == 1
    newest, older = (datetime.fromisoformat(row["last_message_at"]) for row in inbox)
    assert newest > older
    assert [row["id"] for row in _inbox(api, clinician, client_id=alex.id)] == [with_alex]
    assert [row["id"] for row in _inbox(api, clinician, limit=1, offset=1)] == [with_alex]
    paged = api.get("/api/conversations", params={"limit": 1}, headers=clinician.headers)
    assert paged.headers["x-total-count"] == "2"
    assert [row["id"] for row in _inbox(api, clinician, q="PARK")] == [with_sam]
    assert [row["id"] for row in _inbox(api, clinician, q="sam park")] == [with_sam]
    assert _inbox(api, clinician, q="nobody") == []
    one = api.get(f"/api/conversations/{with_alex}", headers=clinician.headers)
    assert one.status_code == 200
    assert one.json() == inbox[1]

    latest = _portal_send(api, alex, with_alex, "Newest")
    assert _inbox(api, clinician)[0]["id"] == with_alex
    api.delete(f"/api/portal/messages/{latest['id']}", headers=portal_headers(alex))
    inbox = _inbox(api, clinician)
    assert inbox[0]["last_message_preview"] == "Message removed"
    assert inbox[0]["unread_count"] == 1


def test_removing_messages(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    conversation_id = _open(api, clinician, client)
    attachment = _upload(
        api, f"/api/conversations/{conversation_id}/attachments", clinician.headers
    )
    mine = _send(api, clinician, conversation_id, "Oops", attachment_ids=[attachment["id"]])
    theirs = _portal_send(api, client, conversation_id, "Hello")

    assert api.delete(f"/api/messages/{theirs['id']}", headers=clinician.headers).status_code == 403
    assert api.delete(f"/api/portal/messages/{mine['id']}", headers=headers).status_code == 403

    events.clear()
    removed = api.delete(f"/api/messages/{mine['id']}", headers=clinician.headers)
    assert removed.status_code == 200
    assert removed.json()["removed"] is True
    assert removed.json()["body"] == ""
    assert removed.json()["attachments"] == []
    assert [e.type for e in events] == ["message.removed"]
    assert events[0].data == {
        "conversation_id": conversation_id,
        "client_id": client.id,
        "message_id": mine["id"],
    }
    again = api.delete(f"/api/messages/{mine['id']}", headers=clinician.headers)
    assert again.status_code == 200

    portal_view = _portal_thread(api, client, conversation_id)
    assert portal_view[0] == {**portal_view[0], "body": "", "removed": True, "attachments": []}
    assert portal_view[1]["removed"] is False

    client_removed = api.delete(f"/api/portal/messages/{theirs['id']}", headers=headers)
    assert client_removed.json()["removed"] is True
    assert "risk_level" not in client_removed.json()
    assert [m["removed"] for m in _thread(api, clinician, conversation_id)] == [True, True]
    assert api.delete("/api/messages/9999", headers=clinician.headers).status_code == 404
    assert api.delete("/api/portal/messages/9999", headers=headers).status_code == 404


def test_attachments_are_validated(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, sam)
    other_client = create_client_record(db, clinician, email="other@example.com")
    headers = portal_headers(client)
    conversation_id = _open(api, clinician, client)
    upload_url = f"/api/conversations/{conversation_id}/attachments"

    attachment = _upload(api, upload_url, clinician.headers)
    assert set(attachment) == {"id", "filename", "content_type", "size_bytes"}
    assert attachment["filename"] == "plan.pdf"
    stored = db.get_one(StoredFile, attachment["id"])
    assert stored.practice_id == clinician.practice_id
    assert stored.uploaded_by_staff_id == clinician.id
    sent = _send(api, clinician, conversation_id, "", attachment_ids=[attachment["id"]])
    assert sent["body"] == ""
    assert sent["attachments"] == [attachment]

    download = api.get(f"/api/portal/files/{attachment['id']}", headers=headers)
    assert download.status_code == 200
    assert download.content == b"%PDF-1.4 plan"
    other_download = api.get(
        f"/api/portal/files/{attachment['id']}", headers=portal_headers(other_client)
    )
    assert other_download.status_code == 404

    def attempt(ids: list[int], body: str = "See attached") -> int:
        return api.post(
            f"/api/conversations/{conversation_id}/messages",
            json={"body": body, "attachment_ids": ids},
            headers=clinician.headers,
        ).status_code

    assert attempt([attachment["id"]]) == 409
    elsewhere = _upload(
        api,
        f"/api/conversations/{_open(api, clinician, other_client)}/attachments",
        clinician.headers,
    )
    assert attempt([elsewhere["id"]]) == 422
    from_colleague = _upload(
        api, f"/api/conversations/{_open(api, sam, client)}/attachments", sam.headers
    )
    assert attempt([from_colleague["id"]]) == 422
    from_client = _upload(api, "/api/portal/messages/attachments", headers)
    assert attempt([from_client["id"]]) == 422
    shared = StoredFile(
        practice_id=clinician.practice_id,
        client_id=client.id,
        purpose=FilePurpose.SHARED_DOCUMENT,
        filename="doc.pdf",
        content_type="application/pdf",
        size_bytes=4,
        storage_key="practices/shared/doc.pdf",
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=clinician.id,
    )
    db.add(shared)
    db.commit()
    assert attempt([shared.id]) == 422
    assert attempt([424242]) == 422
    assert attempt([1, 2, 3, 4, 5, 6]) == 422
    assert attempt([], body="   ") == 422
    assert attempt([], body="x" * 5001) == 422

    client_sent = _portal_send(
        api, client, conversation_id, "", attachment_ids=[from_client["id"], from_client["id"]]
    )
    assert [a["id"] for a in client_sent["attachments"]] == [from_client["id"]]
    with_sam = _portal_open(api, client, sam.id)
    resend = api.post(
        f"/api/portal/conversations/{with_sam}/messages",
        json={"body": "Again", "attachment_ids": [from_client["id"]]},
        headers=headers,
    )
    assert resend.status_code == 409
    bad_type = api.post(
        upload_url, files={"file": ("x.exe", b"MZ", "application/pdf")}, headers=clinician.headers
    )
    assert bad_type.status_code == 415


@pytest.mark.parametrize(
    ("change", "detail"),
    [
        ({"portal_messaging": False}, "Secure messaging is turned off for this client"),
        ({"portal_enabled": False}, "This client doesn't have client portal access"),
        ({"status": ClientStatus.ARCHIVED}, "This client doesn't have client portal access"),
    ],
)
def test_staff_cannot_message_clients_without_messaging(
    api: TestClient,
    clinician: StaffAccount,
    db: Session,
    change: dict[str, Any],
    detail: str,
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _send(api, clinician, conversation_id, "Before")
    for field, value in change.items():
        setattr(client, field, value)
    db.commit()

    blocked = api.post(
        f"/api/conversations/{conversation_id}/messages",
        json={"body": "After"},
        headers=clinician.headers,
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == detail
    upload = api.post(
        f"/api/conversations/{conversation_id}/attachments",
        files={"file": PDF},
        headers=clinician.headers,
    )
    assert upload.status_code == 409
    reopen = api.post(f"/api/clients/{client.id}/conversations", headers=clinician.headers)
    assert reopen.status_code == 409
    assert [m["body"] for m in _thread(api, clinician, conversation_id)] == ["Before"]


def test_practice_messaging_switch(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _practice_settings(api, clinician, messaging_enabled=False)
    blocked = api.post(
        f"/api/conversations/{conversation_id}/messages",
        json={"body": "Hi"},
        headers=clinician.headers,
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "Secure messaging is turned off for this practice"
    assert api.get("/api/portal/conversations", headers=portal_headers(client)).status_code == 403


def test_portal_routes_require_messaging_permission(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    client.portal_messaging = False
    db.commit()
    headers = portal_headers(client)
    base = f"/api/portal/conversations/{conversation_id}"
    requests = [
        ("get", "/api/portal/conversations", {}),
        ("post", "/api/portal/conversations", {"json": {"clinician_id": clinician.id}}),
        ("get", f"{base}/messages", {}),
        ("post", f"{base}/messages", {"json": {"body": "Hi"}}),
        ("post", f"{base}/read", {}),
        ("get", "/api/portal/messages/unread-count", {}),
        ("delete", "/api/portal/messages/1", {}),
        ("post", "/api/portal/messages/attachments", {"files": {"file": PDF}}),
    ]
    for method, url, kwargs in requests:
        response = api.request(method, url, headers=headers, **kwargs)
        assert response.status_code == 403, (method, url)
        assert response.json()["detail"] == "Secure messaging isn't available in your portal"


def test_realtime_events_and_notifications(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    sent = _portal_send(api, client, conversation_id, "Can we move Tuesday?")
    created = next(e for e in events if e.type == "message.created")
    assert sorted(created.to) == [("client", client.id), ("staff", clinician.id)]
    assert created.data == {
        "conversation_id": conversation_id,
        "client_id": client.id,
        "message_id": sent["id"],
    }
    [staff_notice] = db.scalars(select(Notification)).all()
    assert staff_notice.recipient_role == "staff"
    assert staff_notice.recipient_id == clinician.id
    assert staff_notice.kind == "message"
    assert staff_notice.title == "New message from Alex R."
    assert staff_notice.link == f"/portal/messaging?conversation={conversation_id}"
    assert "Tuesday" not in staff_notice.title + staff_notice.body
    notice_event = next(e for e in events if e.type == "notification.created")
    assert notice_event.to == [("staff", clinician.id)]
    assert notice_event.data == {"notification_id": staff_notice.id}

    events.clear()
    _send(api, clinician, conversation_id, "Sure, Wednesday works")
    assert [e.type for e in events] == ["message.created", "notification.created"]
    client_notice = db.scalars(
        select(Notification).where(Notification.recipient_role == "client")
    ).one()
    assert client_notice.recipient_id == client.id
    assert client_notice.title == "New message from Jordan Lee"
    assert client_notice.link == f"/client/messages?conversation={conversation_id}"
    assert events[1].to == [("client", client.id)]

    _read(api, clinician, conversation_id)
    db.refresh(staff_notice)
    assert staff_notice.read_at is not None
    api.post(f"/api/portal/conversations/{conversation_id}/read", headers=portal_headers(client))
    db.refresh(client_notice)
    assert client_notice.read_at is not None


def test_new_messages_reach_open_websockets(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    with api.websocket_connect("/api/ws") as websocket:
        websocket.send_json({"type": "auth", "token": clinician.data["access_token"]})
        assert websocket.receive_json() == {"type": "ready"}
        sent = _portal_send(api, client, conversation_id, "Are you there?")
        received = [websocket.receive_json(), websocket.receive_json()]
    assert {event["type"] for event in received} == {"message.created", "notification.created"}
    message_event = next(e for e in received if e["type"] == "message.created")
    assert message_event["data"]["message_id"] == sent["id"]


def test_client_message_emails_clinician_once_per_unread_cycle(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    first = _portal_send(api, client, conversation_id, "My secret worries")
    _portal_send(api, client, conversation_id, "More secret worries")
    [notice] = outbound_to(db, clinician.email)
    assert notice.practice_id == clinician.practice_id
    assert notice.condition_kind == outbox.CONDITION_CLINICIAN_UNREAD_MESSAGE
    assert notice.condition_ref == first["id"]
    assert abs(notice.send_after - (utcnow() + timedelta(minutes=10))) < timedelta(minutes=1)
    assert f"/portal/messaging?conversation={conversation_id}" in notice.body_text
    for text in (notice.subject, notice.body_text, notice.body_html or ""):
        assert "secret" not in text
        assert "Alex" not in text

    _read(api, clinician, conversation_id)
    _portal_send(api, client, conversation_id, "Following up")
    assert len(outbound_to(db, clinician.email)) == 2


def test_notices_are_dropped_when_read_in_time(
    api: TestClient, clinician: StaffAccount, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []
    monkeypatch.setattr(outbox, "send_email", lambda to, *_: sent.append(to))
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _portal_send(api, client, conversation_id, "Hi")
    _send(api, clinician, conversation_id, "Hello")
    _read(api, clinician, conversation_id)

    outbox.deliver_outbound(db, utcnow())
    assert sent == []
    outbox.deliver_outbound(db, utcnow() + timedelta(minutes=11))
    assert sent == ["alex@example.com"]
    statuses = {m.to_address: m.status for m in db.scalars(select(OutboundMessage))}
    assert statuses[clinician.email] == OutboundStatus.CANCELED


def test_staff_message_emails_client_with_sign_in_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    first = _send(api, clinician, conversation_id, "Your diagnosis notes")
    _send(api, clinician, conversation_id, "Another private detail")
    [notice] = outbound_to(db, "alex@example.com")
    assert notice.practice_id == clinician.practice_id
    assert notice.condition_kind == outbox.CONDITION_CLIENT_UNREAD_MESSAGE
    assert notice.condition_ref == first["id"]
    assert abs(notice.send_after - (utcnow() + timedelta(minutes=10))) < timedelta(minutes=1)
    assert f"next=%2Fclient%2Fmessages%3Fconversation%3D{conversation_id}" in notice.body_text
    assert notice.subject == "New secure message from Lee Counseling"
    assert "Jordan Lee sent you a secure message" in notice.body_text
    for text in (notice.subject, notice.body_text, notice.body_html or ""):
        assert "diagnosis" not in text
        assert "private" not in text

    api.post(f"/api/portal/conversations/{conversation_id}/read", headers=portal_headers(client))
    _send(api, clinician, conversation_id, "One more")
    assert len(outbound_to(db, "alex@example.com")) == 2


def test_clinician_can_turn_off_message_emails(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _preferences(api, clinician, notify_email_messages=False)
    _portal_send(api, client, conversation_id, "Hi")
    assert outbound_to(db, clinician.email) == []
    assert db.scalars(select(Notification)).one().recipient_role == "staff"


def test_away_message_replies_once_a_day(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    away = "I'm out of the office until Monday. If this is an emergency, call 911."
    _preferences(api, clinician, away_message_enabled=True, away_message=away)
    [row] = _portal_conversations(api, client)
    assert row["away_message"] == away
    conversation_id = _portal_open(api, client, clinician.id)

    sent = _portal_send(api, client, conversation_id, "Question about billing")
    assert sent["is_automatic"] is False
    thread = _portal_thread(api, client, conversation_id)
    assert [(m["sender_role"], m["is_automatic"]) for m in thread] == [
        ("client", False),
        ("staff", True),
    ]
    assert thread[1]["body"] == away
    assert thread[1]["sender_name"] == "Jordan Lee"
    assert _thread(api, clinician, conversation_id)[1]["sender_staff_id"] is None
    assert (
        db.scalars(select(Notification).where(Notification.recipient_role == "client")).all() == []
    )
    assert outbound_to(db, "alex@example.com") == []

    _portal_send(api, client, conversation_id, "One more thing")
    assert len(_portal_thread(api, client, conversation_id)) == 3

    conversation = db.scalars(select(Conversation)).one()
    conversation.away_reply_sent_at = utcnow() - timedelta(hours=25)
    db.commit()
    _portal_send(api, client, conversation_id, "Next day")
    assert [m["is_automatic"] for m in _portal_thread(api, client, conversation_id)] == [
        False,
        True,
        False,
        False,
        True,
    ]
    removed = api.delete(
        f"/api/messages/{_thread(api, clinician, conversation_id)[-1]['id']}",
        headers=clinician.headers,
    )
    assert removed.json()["removed"] is True

    _preferences(api, clinician, away_message_enabled=False)
    assert _portal_conversations(api, client)[0]["away_message"] is None
    _preferences(api, clinician, away_message_enabled=True, away_message="   ")
    assert _portal_conversations(api, client)[0]["away_message"] is None


def test_crisis_language_alerts_the_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _preferences(api, clinician, notify_email_messages=False)
    sent = _portal_send(api, client, conversation_id, "I don't want to live anymore")
    assert sent["crisis_resources"] is True
    assert "risk_level" not in sent
    assert all("risk_level" not in m for m in _portal_thread(api, client, conversation_id))
    [flagged] = _thread(api, clinician, conversation_id)
    assert flagged["risk_level"] == "high"

    [alert] = db.scalars(select(Notification)).all()
    assert alert.recipient_id == clinician.id
    assert alert.urgent is True
    assert alert.kind == "message_urgent"
    assert alert.title == "A message from Alex R. may need urgent attention"
    assert "live" not in alert.title + alert.body

    [email] = outbound_to(db, clinician.email)
    assert email.subject == "A client message may need urgent attention"
    assert email.condition_kind is None
    assert email.send_after <= utcnow()
    assert "live" not in email.body_text

    _read(api, clinician, conversation_id)
    db.refresh(alert)
    assert alert.read_at is None

    worried = _portal_send(api, client, conversation_id, "Everything feels hopeless lately")
    assert worried["crisis_resources"] is False
    assert _thread(api, clinician, conversation_id)[-1]["risk_level"] == "moderate"
    staff_sent = _send(
        api, clinician, conversation_id, "If you feel like you want to die, call 988"
    )
    assert staff_sent["risk_level"] == "none"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("I want to kill myself", RiskLevel.HIGH),
        ("i dont want to live anymore", RiskLevel.HIGH),
        ("I’ve been thinking about suicide", RiskLevel.HIGH),
        ("Feeling SUICIDAL tonight", RiskLevel.HIGH),
        ("I keep wanting to hurt myself", RiskLevel.HIGH),
        ("the urge to self-harm is back", RiskLevel.HIGH),
        ("I took all my pills", RiskLevel.HIGH),
        ("I might overdose", RiskLevel.HIGH),
        ("Everyone would be better off without me", RiskLevel.HIGH),
        ("There's no reason to live", RiskLevel.HIGH),
        ("I'm going to kill him", RiskLevel.HIGH),
        ("Im not safe right now", RiskLevel.HIGH),
        ("I feel hopeless", RiskLevel.MODERATE),
        ("I can't take it anymore", RiskLevel.MODERATE),
        ("I feel like a burden, I'm a burden", RiskLevel.MODERATE),
        ("Can we reschedule to Thursday?", RiskLevel.NONE),
        ("I didn't want to hurt her feelings", RiskLevel.NONE),
        ("Starting a new diet this week", RiskLevel.NONE),
        ("Those species are in danger", RiskLevel.NONE),
        ("", RiskLevel.NONE),
    ],
)
def test_assess_risk(text: str, expected: RiskLevel) -> None:
    assert assess_risk(text) == expected


def test_message_access_is_audited(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    sent = _portal_send(api, client, conversation_id, "Hi")
    _portal_thread(api, client, conversation_id)
    _thread(api, clinician, conversation_id)
    _inbox(api, clinician)
    api.delete(f"/api/portal/messages/{sent['id']}", headers=portal_headers(client))

    rows = db.execute(
        select(AuditEvent.actor_role, AuditEvent.action, AuditEvent.practice_id)
        .where(AuditEvent.action != "account.register")
        .order_by(AuditEvent.id)
    ).all()
    practice_id = clinician.practice_id
    assert [tuple(row) for row in rows] == [
        ("staff", "conversation.open", practice_id),
        ("client", "message.send", practice_id),
        ("client", "messages.view", practice_id),
        ("staff", "messages.view", practice_id),
        ("staff", "messages.list", practice_id),
        ("client", "message.remove", practice_id),
    ]


def test_unsent_and_removed_attachments_are_hidden_from_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    conversation_id = _open(api, clinician, client)
    unsent = _upload(api, f"/api/conversations/{conversation_id}/attachments", clinician.headers)
    assert api.get(f"/api/portal/files/{unsent['id']}", headers=headers).status_code == 404

    sent = _send(api, clinician, conversation_id, "see attached", attachment_ids=[unsent["id"]])
    assert api.get(f"/api/portal/files/{unsent['id']}", headers=headers).status_code == 200

    api.delete(f"/api/messages/{sent['id']}", headers=clinician.headers)
    assert api.get(f"/api/portal/files/{unsent['id']}", headers=headers).status_code == 404


def test_inbox_previews_label_removed_and_attachment_only_messages(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    headers = portal_headers(client)
    conversation_id = _open(api, clinician, client)
    file = _upload(api, "/api/portal/messages/attachments", headers)
    _portal_send(api, client, conversation_id, body="", attachment_ids=[file["id"]])
    [row] = _inbox(api, clinician)
    assert row["last_message_preview"] == "Attachment"
    sent = _portal_send(api, client, conversation_id, body="I'll call later")
    api.delete(f"/api/portal/messages/{sent['id']}", headers=headers)
    [row] = _inbox(api, clinician)
    assert row["last_message_preview"] == "Message removed"


def test_inbox_marks_conversations_with_unread_crisis_messages(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    _portal_send(api, client, conversation_id, body="I want to kill myself")
    [row] = _inbox(api, clinician)
    assert row["has_urgent"] is True
    _read(api, clinician, conversation_id)
    [row] = _inbox(api, clinician)
    assert row["has_urgent"] is False


def test_unsent_attachments_can_be_discarded_but_sent_ones_cannot(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    upload_url = f"/api/conversations/{conversation_id}/attachments"
    unsent = _upload(api, upload_url, clinician.headers)
    assert (
        api.delete(f"/api/messages/attachments/{unsent['id']}", headers=sam.headers).status_code
        == 404
    )
    assert (
        api.delete(
            f"/api/messages/attachments/{unsent['id']}", headers=clinician.headers
        ).status_code
        == 204
    )
    assert db.get(StoredFile, unsent["id"]) is None

    kept = _upload(api, upload_url, clinician.headers)
    _send(api, clinician, conversation_id, body="See attached", attachment_ids=[kept["id"]])
    assert (
        api.delete(f"/api/messages/attachments/{kept['id']}", headers=clinician.headers).status_code
        == 404
    )

    headers = portal_headers(client)
    mine = _upload(api, "/api/portal/messages/attachments", headers)
    other = create_client_record(db, clinician, email="other@example.com")
    assert (
        api.delete(
            f"/api/portal/messages/attachments/{mine['id']}", headers=portal_headers(other)
        ).status_code
        == 404
    )
    assert (
        api.delete(f"/api/portal/messages/attachments/{mine['id']}", headers=headers).status_code
        == 204
    )


# Who on the team can read and reply


def _staff_requests(conversation_id: int, message_id: int, client_id: int) -> list[tuple]:
    """Every staff route that touches one conversation."""
    base = f"/api/conversations/{conversation_id}"
    return [
        ("get", base, {}),
        ("get", f"{base}/messages", {}),
        ("post", f"{base}/messages", {"json": {"body": "Hi"}}),
        ("post", f"{base}/read", {}),
        ("post", f"{base}/attachments", {"files": {"file": PDF}}),
        ("delete", f"/api/messages/{message_id}", {}),
        ("post", f"/api/clients/{client_id}/conversations", {}),
    ]


def test_other_practices_see_nothing(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    sibling = create_client_record(db, clinician, email="sibling@example.com")
    conversation_id = _open(api, clinician, client)
    sent = _send(api, clinician, conversation_id, "Private")
    with_sibling = _open(api, clinician, sibling)
    _portal_send(api, sibling, with_sibling, "Sibling note")
    unsent = _upload(api, f"/api/conversations/{conversation_id}/attachments", clinician.headers)
    other = register_practice(api, email="other@example.com")
    outsider = create_client_record(db, other, email="outsider@example.com")

    for method, url, kwargs in _staff_requests(conversation_id, sent["id"], client.id):
        response = api.request(method, url, headers=other.headers, **kwargs)
        assert response.status_code == 404, (method, url)
    discard = api.delete(f"/api/messages/attachments/{unsent['id']}", headers=other.headers)
    assert discard.status_code == 404
    assert _inbox(api, other) == []
    assert _unread(api, other) == 0
    assert _inbox(api, other, clinician_id=clinician.id) == []

    stranger = api.post(
        "/api/portal/conversations",
        json={"clinician_id": clinician.id},
        headers=portal_headers(outsider),
    )
    assert stranger.status_code == 404
    sibling_headers = portal_headers(sibling)
    assert [m["body"] for m in _portal_thread(api, sibling, with_sibling)] == ["Sibling note"]
    for method, url in [
        ("get", f"/api/portal/conversations/{conversation_id}/messages"),
        ("post", f"/api/portal/conversations/{conversation_id}/read"),
        ("delete", f"/api/portal/messages/{sent['id']}"),
    ]:
        assert api.request(method, url, headers=sibling_headers).status_code == 404, url
    assert [row["id"] for row in _portal_conversations(api, sibling)] == [with_sibling]

    assert api.get("/api/portal/conversations", headers=clinician.headers).status_code == 401
    assert (
        api.get(
            f"/api/conversations/{conversation_id}/messages", headers=portal_headers(client)
        ).status_code
        == 401
    )
    assert api.get("/api/conversations", headers=portal_headers(client)).status_code == 401


def test_colleague_cannot_read_my_conversations(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    sent = _send(api, clinician, conversation_id, "Private")
    _portal_send(api, client, conversation_id, "Reply")

    for method, url, kwargs in _staff_requests(conversation_id, sent["id"], client.id):
        response = api.request(method, url, headers=sam.headers, **kwargs)
        assert response.status_code == 404, (method, url)
    assert _inbox(api, sam) == []
    assert _inbox(api, sam, clinician_id=clinician.id) == []
    assert _unread(api, sam) == 0

    # Being on the care team gives Sam their own thread, not access to Jordan's.
    assign_clinician(db, client, sam)
    with_sam = _open(api, sam, client)
    assert [row["id"] for row in _inbox(api, sam)] == [with_sam]
    for method, url, kwargs in _staff_requests(conversation_id, sent["id"], client.id)[:-1]:
        response = api.request(method, url, headers=sam.headers, **kwargs)
        assert response.status_code == 404, (method, url)


def test_owner_can_read_and_reply_in_any_conversation(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, sam)
    conversation_id = _open(api, sam, client)
    _portal_send(api, client, conversation_id, "Hello Sam")

    [row] = _inbox(api, clinician)
    assert row["id"] == conversation_id
    assert row["clinician"] == {"id": sam.id, "name": "Sam Patel"}
    assert row["unread_count"] == 1
    assert _inbox(api, clinician, clinician_id=clinician.id) == []
    assert [r["id"] for r in _inbox(api, clinician, clinician_id=sam.id)] == [conversation_id]
    assert [m["body"] for m in _thread(api, clinician, conversation_id)] == ["Hello Sam"]

    # The read marker is Sam's: the owner reading doesn't clear Sam's unread messages.
    events.clear()
    _read(api, clinician, conversation_id)
    assert events == []
    assert _unread(api, sam) == 1
    assert _unread(api, clinician) == 0
    assert db.scalars(select(Conversation)).one().clinician_read_at is None

    reply = _send(api, clinician, conversation_id, "Sam is out today; I can help")
    assert reply["sender_staff_id"] == clinician.id
    assert reply["sender_name"] == "Jordan Lee"
    seen_by_sam = _thread(api, sam, conversation_id)[-1]
    assert (seen_by_sam["sender_staff_id"], seen_by_sam["sender_name"]) == (
        clinician.id,
        "Jordan Lee",
    )
    assert _portal_thread(api, client, conversation_id)[-1]["sender_name"] == "Jordan Lee"
    client_notice = db.scalars(
        select(Notification).where(Notification.recipient_role == "client")
    ).one()
    assert client_notice.title == "New message from Jordan Lee"
    [email] = outbound_to(db, "alex@example.com")
    assert "Jordan Lee sent you a secure message" in email.body_text

    assert api.delete(f"/api/messages/{reply['id']}", headers=sam.headers).status_code == 403
    assert api.delete(f"/api/messages/{reply['id']}", headers=clinician.headers).status_code == 200

    _read(api, sam, conversation_id)
    assert _unread(api, sam) == 0


def test_owner_can_open_their_own_conversation_with_any_client(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, sam)
    with_owner = _open(api, clinician, client)
    _send(api, clinician, with_owner, "Welcome to the practice")

    rows = _portal_conversations(api, client)
    assert [(row["id"], row["clinician"]["id"]) for row in rows] == [
        (None, sam.id),
        (with_owner, clinician.id),
    ]
    _portal_send(api, client, with_owner, "Thanks!")
    assert _unread(api, clinician) == 1
    assert _unread(api, sam) == 0
    assert _inbox(api, sam) == []


@pytest.mark.parametrize(
    "role", [StaffRole.BILLER, StaffRole.SCHEDULER, StaffRole.PRACTICE_MANAGER]
)
def test_roles_without_clinical_access_cannot_use_messaging(
    api: TestClient, clinician: StaffAccount, db: Session, role: StaffRole
) -> None:
    member = add_staff(db, clinician.practice_id, "team@example.com", role)
    client = create_client_record(db, clinician)
    conversation_id = _open(api, clinician, client)
    sent = _send(api, clinician, conversation_id, "Private")

    listed = api.get("/api/conversations", headers=member.headers)
    assert listed.status_code == 403
    assert listed.json()["detail"] == "Your role doesn't include secure messaging"
    for method, url, kwargs in _staff_requests(conversation_id, sent["id"], client.id):
        response = api.request(method, url, headers=member.headers, **kwargs)
        assert response.status_code == 404, (method, url)
    assert _unread(api, member) == 0


def test_supervisor_reads_supervisees_conversations_and_gets_crisis_alerts(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    supervisor = add_staff(
        db,
        clinician.practice_id,
        "casey@example.com",
        StaffRole.CLINICIAN,
        first_name="Casey",
        last_name="Nguyen",
    )
    sam = _colleague(db, clinician.practice_id, supervisor_id=supervisor.id)
    client = create_client_record(db, sam)
    conversation_id = _open(api, sam, client)
    _portal_send(api, client, conversation_id, "I want to kill myself")

    alerts = db.scalars(select(Notification).where(Notification.urgent)).all()
    assert sorted(alert.recipient_id for alert in alerts) == sorted([sam.id, supervisor.id])
    link = f"/portal/messaging?conversation={conversation_id}"
    assert all(alert.recipient_role == "staff" and alert.link == link for alert in alerts)
    [email] = outbound_to(db, "sam@example.com")
    assert email.subject == "A client message may need urgent attention"
    assert outbound_to(db, "casey@example.com") == []
    assert outbound_to(db, clinician.email) == []

    [row] = _inbox(api, supervisor)
    assert (row["id"], row["has_urgent"]) == (conversation_id, True)
    assert len(_thread(api, supervisor, conversation_id)) == 1
    assert _unread(api, supervisor) == 0
    opened = api.post(f"/api/clients/{client.id}/conversations", headers=supervisor.headers)
    assert opened.status_code == 403

    _read(api, supervisor, conversation_id)
    assert _inbox(api, supervisor)[0]["has_urgent"] is True
    _read(api, sam, conversation_id)
    assert _inbox(api, supervisor)[0]["has_urgent"] is False


def test_realtime_events_go_only_to_staff_who_can_read_the_conversation(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    sam = _colleague(db, clinician.practice_id)
    add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    add_staff(db, clinician.practice_id, "billing@example.com", StaffRole.BILLER)
    client = create_client_record(db, sam)
    conversation_id = _open(api, sam, client)
    readers = sorted([("client", client.id), ("staff", sam.id), ("staff", clinician.id)])

    events.clear()
    sent = _portal_send(api, client, conversation_id, "Hello")
    created = next(e for e in events if e.type == "message.created")
    assert sorted(created.to) == readers
    assert created.data == {
        "conversation_id": conversation_id,
        "client_id": client.id,
        "message_id": sent["id"],
    }
    notices = [e for e in events if e.type == "notification.created"]
    assert [notice.to for notice in notices] == [[("staff", sam.id)]]

    events.clear()
    _read(api, sam, conversation_id)
    [read] = events
    assert sorted(read.to) == readers


def test_client_with_two_care_team_clinicians_has_two_threads(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, sam)

    rows = _portal_conversations(api, client)
    assert rows == [
        {
            "id": None,
            "clinician": {"id": clinician.id, "name": "Jordan Lee"},
            "last_message_at": None,
            "unread_count": 0,
            "away_message": None,
        },
        {
            "id": None,
            "clinician": {"id": sam.id, "name": "Sam Patel"},
            "last_message_at": None,
            "unread_count": 0,
            "away_message": None,
        },
    ]
    with_jordan = _portal_open(api, client, clinician.id)
    with_sam = _portal_open(api, client, sam.id)
    assert with_jordan != with_sam
    _portal_send(api, client, with_jordan, "For Jordan")
    _portal_send(api, client, with_sam, "For Sam")
    assert [m["body"] for m in _portal_thread(api, client, with_sam)] == ["For Sam"]
    assert [m["body"] for m in _portal_thread(api, client, with_jordan)] == ["For Jordan"]

    assert [row["id"] for row in _inbox(api, sam)] == [with_sam]
    assert [row["id"] for row in _inbox(api, clinician, clinician_id=clinician.id)] == [with_jordan]
    assert {row["id"] for row in _inbox(api, clinician)} == {with_jordan, with_sam}
    assert _open(api, sam, client) == with_sam
    assert _unread(api, sam) == 1
    assert _unread(api, clinician) == 1

    _send(api, sam, with_sam, "Hi from Sam")
    rows = _portal_conversations(api, client)
    assert {row["id"]: row["unread_count"] for row in rows} == {with_jordan: 0, with_sam: 1}
    unread = api.get("/api/portal/messages/unread-count", headers=portal_headers(client))
    assert unread.json() == {"count": 1}


def test_unread_email_goes_to_the_conversation_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, sam)
    with_sam = _portal_open(api, client, sam.id)
    _portal_send(api, client, with_sam, "Hi Sam")

    [notice] = outbound_to(db, "sam@example.com")
    assert notice.condition_kind == outbox.CONDITION_CLINICIAN_UNREAD_MESSAGE
    assert f"/portal/messaging?conversation={with_sam}" in notice.body_text
    assert outbound_to(db, clinician.email) == []
    [in_app] = db.scalars(select(Notification)).all()
    assert (in_app.recipient_role, in_app.recipient_id) == ("staff", sam.id)

    # Each clinician's own preference decides their email.
    _preferences(api, clinician, notify_email_messages=False)
    with_jordan = _portal_open(api, client, clinician.id)
    _portal_send(api, client, with_jordan, "Hi Jordan")
    assert outbound_to(db, clinician.email) == []
    _read(api, sam, with_sam)
    _portal_send(api, client, with_sam, "Hi again")
    assert len(outbound_to(db, "sam@example.com")) == 2


def test_away_message_is_per_clinician(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, sam)
    _preferences(api, clinician, away_message_enabled=True, away_message="Jordan is away")

    rows = _portal_conversations(api, client)
    assert {row["clinician"]["id"]: row["away_message"] for row in rows} == {
        clinician.id: "Jordan is away",
        sam.id: None,
    }
    with_sam = _portal_open(api, client, sam.id)
    _portal_send(api, client, with_sam, "Hi Sam")
    assert [m["is_automatic"] for m in _portal_thread(api, client, with_sam)] == [False]

    with_jordan = _portal_open(api, client, clinician.id)
    _portal_send(api, client, with_jordan, "Hi Jordan")
    thread = _portal_thread(api, client, with_jordan)
    assert [(m["is_automatic"], m["body"], m["sender_name"]) for m in thread] == [
        (False, "Hi Jordan", None),
        (True, "Jordan is away", "Jordan Lee"),
    ]


def test_clinician_off_the_care_team_loses_the_conversation(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    client = create_client_record(db, clinician)
    assign_clinician(db, client, sam)
    with_sam = _portal_open(api, client, sam.id)
    sent = _portal_send(api, client, with_sam, "Hi Sam")
    db.execute(delete(ClientClinician).where(ClientClinician.staff_id == sam.id))
    db.commit()

    assert [row["clinician"]["id"] for row in _portal_conversations(api, client)] == [clinician.id]
    headers = portal_headers(client)
    for method, url, kwargs in [
        ("get", f"/api/portal/conversations/{with_sam}/messages", {}),
        ("post", f"/api/portal/conversations/{with_sam}/messages", {"json": {"body": "Hi"}}),
        ("post", "/api/portal/conversations", {"json": {"clinician_id": sam.id}}),
        ("delete", f"/api/portal/messages/{sent['id']}", {}),
    ]:
        assert api.request(method, url, headers=headers, **kwargs).status_code == 404, url
    assert _inbox(api, sam) == []
    assert _unread(api, sam) == 0
    assert (
        api.get(f"/api/conversations/{with_sam}/messages", headers=sam.headers).status_code == 404
    )
    assert [m["body"] for m in _thread(api, clinician, with_sam)] == ["Hi Sam"]


def test_clients_can_only_start_conversations_with_their_care_team(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    sam = _colleague(db, clinician.practice_id)
    biller = add_staff(db, clinician.practice_id, "billing@example.com", StaffRole.BILLER)
    other = register_practice(api, email="other@example.com")
    client = create_client_record(db, clinician)
    for clinician_id in (sam.id, biller.id, other.id, 9999):
        response = api.post(
            "/api/portal/conversations",
            json={"clinician_id": clinician_id},
            headers=portal_headers(client),
        )
        assert response.status_code == 404, clinician_id
        assert response.json()["detail"] == "Clinician not found"
    assert db.scalars(select(Conversation)).all() == []


# --- Guardians writing on a client's behalf --------------------------------------------------


def test_guardian_messages_are_attributed_to_the_guardian(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, is_minor=True)
    guardian = guardian_of(db, minor)
    headers = contact_headers(guardian)
    conversation_id = _open(api, clinician, minor)
    url = f"/api/portal/conversations/{conversation_id}/messages"

    response = api.post(url, json={"body": "Alex is sick today"}, headers=headers)
    assert response.status_code == 201, response.text
    from_guardian = response.json()
    assert (from_guardian["sender_role"], from_guardian["sender_name"]) == (
        "client",
        "Pat Rivera (for Alex)",
    )
    from_minor = _portal_send(api, minor, conversation_id, "I'm fine")
    assert from_minor["sender_name"] is None
    assert db.get(Message, from_guardian["id"]).sender_contact_id == guardian.id

    staff_view = [
        (m["sender_name"], m["sender_contact_id"]) for m in _thread(api, clinician, conversation_id)
    ]
    assert staff_view == [("Pat Rivera (for Alex)", guardian.id), (None, None)]
    portal_view = api.get(url, headers=headers).json()
    assert [m["sender_name"] for m in portal_view] == ["Pat Rivera (for Alex)", None]
    # Each person's own messages are marked as theirs.
    assert [m["sent_by_me"] for m in portal_view] == [True, False]
    minor_view = api.get(url, headers=portal_headers(minor)).json()
    assert [m["sent_by_me"] for m in minor_view] == [False, True]
    sends = db.query(AuditEvent).filter_by(action="message.send").order_by(AuditEvent.id).all()
    assert [event.detail.get("contact_id") for event in sends] == [guardian.id, None]

    # Each person removes only what they wrote.
    remove_minors = api.delete(f"/api/portal/messages/{from_minor['id']}", headers=headers)
    assert remove_minors.status_code == 403
    remove_guardians = api.delete(
        f"/api/portal/messages/{from_guardian['id']}", headers=portal_headers(minor)
    )
    assert remove_guardians.status_code == 403
    removed = api.delete(f"/api/portal/messages/{from_guardian['id']}", headers=headers)
    assert removed.status_code == 200
    assert removed.json()["removed"] is True


def test_staff_messages_email_guardians_with_their_own_sign_in_link(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    minor = create_client_record(db, clinician, email=None, is_minor=True)
    guardian = guardian_of(db, minor)
    db.add(ClientContact(client_id=minor.id, first_name="Lee", email="lee@example.com"))
    db.commit()
    conversation_id = _open(api, clinician, minor)
    first = _send(api, clinician, conversation_id, "Private session detail")
    _send(api, clinician, conversation_id, "Another")

    [notice] = outbound_to(db, "pat@example.com")
    assert notice.condition_kind == outbox.CONDITION_CLIENT_UNREAD_MESSAGE
    assert notice.condition_ref == first["id"]
    assert notice.subject == "New secure message from Lee Counseling"
    for text in (notice.subject, notice.body_text, notice.body_html or ""):
        assert "Private" not in text
    assert outbound_to(db, "lee@example.com") == []
    verified = api.post("/api/portal/auth/verify", json={"token": link_token(notice.body_text)})
    assert verified.json()["client"]["acting_contact"] == {"id": guardian.id, "name": "Pat Rivera"}

    # The guardian reading the thread starts a new unread period, as the client reading does.
    api.post(f"/api/portal/conversations/{conversation_id}/read", headers=contact_headers(guardian))
    _send(api, clinician, conversation_id, "One more")
    assert len(outbound_to(db, "pat@example.com")) == 2
