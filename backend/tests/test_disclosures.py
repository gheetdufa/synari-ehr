"""Accounting of disclosures: logging disclosures by hand, the six-year report (JSON, PDF, CSV)
for staff and in the portal, and who may do what."""

import csv
import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import Disclosure
from synari.services.request_deadlines import practice_today
from tests.conftest import StaffAccount, create_client_record, portal_headers
from tests.records_helpers import Practice, audit_events, group_practice

COURT = {
    "disclosed_on": "2026-03-02",
    "recipient_name": "County Court",
    "recipient_address": "1 Justice Way",
    "description": "Treatment dates and attendance",
    "purpose": "Court order",
    "legal_basis": "court order",
}


@pytest.fixture
def practice(api: TestClient, db: Session) -> Practice:
    return group_practice(api, db)


def _today(practice: Practice) -> date:
    return practice_today(practice.client.practice, utcnow())


def _create(api: TestClient, practice: Practice, staff: StaffAccount, body: dict) -> dict:
    response = api.post(
        f"/api/clients/{practice.client.id}/disclosures", json=body, headers=staff.headers
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_log_edit_and_remove_a_disclosure(api: TestClient, db: Session, practice: Practice) -> None:
    created = _create(api, practice, practice.primary, COURT)
    assert created["recorded_by"]["id"] == practice.primary.id
    assert created["client_id"] == practice.client.id
    assert created["record_request_id"] is None

    listed = api.get(
        f"/api/clients/{practice.client.id}/disclosures", headers=practice.primary.headers
    ).json()
    assert [d["id"] for d in listed] == [created["id"]]

    edited = api.patch(
        f"/api/disclosures/{created['id']}",
        json={"purpose": "Subpoena", "recipient_address": ""},
        headers=practice.colleague.headers,
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["purpose"] == "Subpoena"
    assert edited.json()["recipient_address"] == ""
    assert (
        api.patch(
            f"/api/disclosures/{created['id']}",
            json={"recipient_name": None},
            headers=practice.primary.headers,
        ).status_code
        == 422
    )

    removed = api.delete(f"/api/disclosures/{created['id']}", headers=practice.primary.headers)
    assert removed.status_code == 204
    assert db.query(Disclosure).count() == 0

    actions = [(e.action, e.client_id) for e in audit_events(db, "disclosure.")]
    assert actions == [
        ("disclosure.create", practice.client.id),
        ("disclosure.list", practice.client.id),
        ("disclosure.update", practice.client.id),
        ("disclosure.delete", practice.client.id),
    ]


@pytest.mark.parametrize("field", ["recipient_name", "description", "purpose"])
def test_required_fields(api: TestClient, practice: Practice, field: str) -> None:
    response = api.post(
        f"/api/clients/{practice.client.id}/disclosures",
        json={**COURT, field: "  "},
        headers=practice.owner.headers,
    )
    assert response.status_code == 422


def test_report_covers_six_years(api: TestClient, db: Session, practice: Practice) -> None:
    today = _today(practice)
    recent = _create(api, practice, practice.owner, {**COURT, "disclosed_on": today.isoformat()})
    old = _create(
        api,
        practice,
        practice.owner,
        {
            **COURT,
            "recipient_name": "State health department",
            "disclosed_on": (today - timedelta(days=365 * 6 - 5)).isoformat(),
        },
    )
    _create(
        api,
        practice,
        practice.owner,
        {**COURT, "recipient_name": "Too old", "disclosed_on": "2015-01-05"},
    )
    url = f"/api/clients/{practice.client.id}/disclosures/report"
    report = api.get(url, headers=practice.owner.headers).json()
    assert report["client_id"] == practice.client.id
    assert report["client_name"] == "Alex Rivera"
    assert report["practice_name"] == "Lee Counseling"
    assert report["period_end"] == today.isoformat()
    assert report["period_start"] == today.replace(year=today.year - 6).isoformat()
    # Oldest first.
    assert [d["id"] for d in report["disclosures"]] == [old["id"], recent["id"]]

    pdf = api.get(url, params={"format": "pdf"}, headers=practice.owner.headers)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")
    assert "attachment" in pdf.headers["content-disposition"]

    exported = api.get(url, params={"format": "csv"}, headers=practice.owner.headers)
    assert exported.status_code == 200
    rows = list(csv.reader(io.StringIO(exported.text)))
    assert rows[0][:2] == ["date", "recipient"]
    assert [row[1] for row in rows[1:]] == ["State health department", "County Court"]
    assert "Too old" not in exported.text

    formats = [e.detail["format"] for e in audit_events(db, "disclosure.report")]
    assert formats == ["json", "pdf", "csv"]
    assert api.get(url, params={"format": "xml"}, headers=practice.owner.headers).status_code == 422


def test_clients_see_their_accounting_in_the_portal(
    api: TestClient, db: Session, practice: Practice
) -> None:
    _create(api, practice, practice.owner, {**COURT, "disclosed_on": _today(practice).isoformat()})
    headers = portal_headers(practice.client)
    report = api.get("/api/portal/disclosures", headers=headers)
    assert report.status_code == 200, report.text
    body = report.json()
    assert [d["recipient_name"] for d in body["disclosures"]] == ["County Court"]
    assert "recorded_by" not in body["disclosures"][0]
    pdf = api.get("/api/portal/disclosures/report.pdf", headers=headers)
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")
    events = audit_events(db, "disclosure.report")
    assert [(e.actor_role, e.client_id) for e in events] == [
        ("client", practice.client.id),
        ("client", practice.client.id),
    ]

    other = create_client_record(db, practice.primary, email="someone@example.com")
    assert (
        api.get("/api/portal/disclosures", headers=portal_headers(other)).json()["disclosures"]
        == []
    )


def test_empty_accounting_pdf(api: TestClient, practice: Practice) -> None:
    pdf = api.get("/api/portal/disclosures/report.pdf", headers=portal_headers(practice.client))
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")


@pytest.mark.parametrize("member", ["outsider", "manager", "biller", "scheduler", "other_owner"])
def test_disclosures_need_clinical_access(
    api: TestClient, db: Session, practice: Practice, member: str
) -> None:
    created = _create(api, practice, practice.owner, COURT)
    staff: StaffAccount = getattr(practice, member)
    client_url = f"/api/clients/{practice.client.id}/disclosures"
    requests = [
        ("GET", client_url, None),
        ("POST", client_url, COURT),
        ("GET", f"{client_url}/report", None),
        ("PATCH", f"/api/disclosures/{created['id']}", {"purpose": "x"}),
        ("DELETE", f"/api/disclosures/{created['id']}", None),
    ]
    for method, url, body in requests:
        response = api.request(method, url, json=body, headers=staff.headers)
        assert response.status_code == 404, (member, method, url)
    assert db.query(Disclosure).count() == 1
