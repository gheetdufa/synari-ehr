"""Intake, consent and assessment forms: templates, sharing, completion, scoring and PDFs."""

import re
import zlib
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from synari.api import forms as forms_api
from synari.models import (
    AuditEvent,
    Client,
    ClientContact,
    ClientForm,
    Notification,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, Role, StaffRole
from synari.schemas.forms import TemplateFields
from synari.services import forms as forms_service
from synari.services.form_pdf import format_answer
from synari.services.forms import FieldType, clean_answers, remind_incomplete_forms, score_answers
from synari.services.forms_library import LIBRARY
from synari.services.pdf import pdf_text
from synari.worker import JOBS
from tests.conftest import (
    StaffAccount,
    add_staff,
    create_client_record,
    outbound_to,
    portal_headers,
    register_practice,
)

Event = tuple[list[tuple[str, int]], str, dict[str, Any]]

CUSTOM_FIELDS: list[dict[str, Any]] = [
    {"id": "intro", "type": "heading", "label": "Getting started"},
    {"id": "nickname", "type": "short_text", "label": "Nickname", "maps_to": "preferred_name"},
    {
        "id": "topics",
        "type": "multi_choice",
        "label": "What would you like to work on?",
        "required": True,
        "options": [
            {"label": "Sleep", "value": "sleep"},
            {"label": "Mood", "value": "mood"},
            {"label": "Work", "value": "work"},
        ],
    },
    {"id": "start", "type": "date", "label": "When did this start?"},
    {"id": "ok_to_text", "type": "yes_no", "label": "May we text you?", "required": True},
]


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[Event]:
    captured: list[Event] = []

    def fake_publish(_db: Session, recipients: Any, event_type: str, data: dict[str, Any]) -> None:
        captured.append(([tuple(r) for r in recipients], event_type, data))

    monkeypatch.setattr(forms_service, "publish", fake_publish)
    monkeypatch.setattr(forms_api, "publish", fake_publish)
    return captured


def _templates(api: TestClient, account: StaffAccount) -> dict[str, dict[str, Any]]:
    listed = api.get("/api/forms/templates", headers=account.headers).json()
    return {t["library_key"] or t["name"]: t for t in listed}


def _share(
    api: TestClient, account: StaffAccount, client_id: int, *template_ids: int
) -> list[dict[str, Any]]:
    response = api.post(
        f"/api/clients/{client_id}/forms",
        json={"template_ids": list(template_ids)},
        headers=account.headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _share_library(
    api: TestClient, account: StaffAccount, client: Client, *keys: str
) -> list[dict[str, Any]]:
    templates = _templates(api, account)
    return _share(api, account, client.id, *(templates[key]["id"] for key in keys))


def _submit(api: TestClient, client: Client, form_id: int, **body: Any) -> Any:
    return api.post(
        f"/api/portal/forms/{form_id}/submit",
        json=body,
        headers={**portal_headers(client), "User-Agent": "FormsTest/1.0"},
    )


def _scored(*values: int, difficulty: str | None = None) -> dict[str, Any]:
    answers: dict[str, Any] = {f"q{n}": v for n, v in enumerate(values, start=1)}
    if difficulty:
        answers["difficulty"] = difficulty
    return answers


def _custom_template(api: TestClient, account: StaffAccount, **overrides: Any) -> dict:
    body = {"kind": "intake", "name": "Check-in", "fields": CUSTOM_FIELDS, **overrides}
    response = api.post("/api/forms/templates", json=body, headers=account.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _pdf_content(data: bytes) -> str:
    """Decompressed text of every stream in a PDF, with string escapes undone."""
    parts = []
    for chunk in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            parts.append(zlib.decompress(chunk).decode("latin-1"))
        except zlib.error:
            parts.append(chunk.decode("latin-1"))
    return re.sub(r"\\([()\\])", r"\1", "\n".join(parts))


# --- Library ---------------------------------------------------------------------------------


@pytest.mark.parametrize("key", sorted(LIBRARY))
def test_library_forms_pass_template_validation(key: str) -> None:
    entry = LIBRARY[key]
    TypeAdapter(TemplateFields).validate_python(entry.fields)
    if entry.kind == "consent":
        assert entry.requires_signature
        assert entry.description.startswith("Starting template")


@pytest.mark.parametrize(("key", "item_count", "max_score"), [("phq9", 9, 27), ("gad7", 7, 21)])
def test_assessment_scoring_specs_are_consistent(key: str, item_count: int, max_score: int) -> None:
    entry = LIBRARY[key]
    assert entry.scoring is not None
    fields = {f["id"]: f for f in entry.fields}
    assert entry.scoring["items"] == [f"q{n}" for n in range(1, item_count + 1)]
    for item in entry.scoring["items"]:
        field = fields[item]
        assert field["type"] == "single_choice"
        assert field["required"] is True
        assert [o["value"] for o in field["options"]] == [0, 1, 2, 3]
        assert [o["label"] for o in field["options"]] == [
            "Not at all",
            "Several days",
            "More than half the days",
            "Nearly every day",
        ]
    assert fields["difficulty"]["required"] is False
    assert "difficulty" not in entry.scoring["items"]
    assert entry.scoring["max_score"] == max_score == 3 * item_count
    bands = entry.scoring["bands"]
    assert bands[0]["min"] == 0
    assert bands[-1]["max"] == max_score
    assert all(a["max"] + 1 == b["min"] for a, b in pairwise(bands))
    assert "Spitzer" in entry.description
    assert "Pfizer" in entry.description


def test_new_practice_is_seeded_with_library_forms(
    api: TestClient, clinician: StaffAccount
) -> None:
    templates = _templates(api, clinician)
    assert set(templates) == set(LIBRARY)
    assert templates["phq9"]["read_only"] is True
    assert templates["intake"]["read_only"] is False
    library = api.get("/api/forms/library", headers=clinician.headers).json()
    assert {item["key"] for item in library} == set(LIBRARY)
    assert set(library[0]) == {"key", "name", "kind", "description"}


def test_library_form_can_be_added_again_after_deleting(
    api: TestClient, clinician: StaffAccount
) -> None:
    phq9 = _templates(api, clinician)["phq9"]
    deleted = api.delete(f"/api/forms/templates/{phq9['id']}", headers=clinician.headers)
    assert deleted.status_code == 204
    assert "phq9" not in _templates(api, clinician)
    assert (
        api.get(f"/api/forms/templates/{phq9['id']}", headers=clinician.headers).status_code == 404
    )

    added = api.post("/api/forms/library/phq9", headers=clinician.headers)
    assert added.status_code == 201
    copy = added.json()
    assert copy["library_key"] == "phq9"
    assert copy["id"] != phq9["id"]
    assert copy["scoring"]["max_score"] == 27
    assert len(copy["fields"]) == len(LIBRARY["phq9"].fields)
    missing = api.post("/api/forms/library/nope", headers=clinician.headers)
    assert missing.status_code == 404


# --- Templates -------------------------------------------------------------------------------


def test_custom_template_crud(api: TestClient, clinician: StaffAccount) -> None:
    created = _custom_template(api, clinician, description="For returning clients")
    assert created["library_key"] is None
    assert created["read_only"] is False
    assert [f["id"] for f in created["fields"]] == [f["id"] for f in CUSTOM_FIELDS]
    assert created["fields"][1]["maps_to"] == "preferred_name"

    fetched = api.get(f"/api/forms/templates/{created['id']}", headers=clinician.headers).json()
    assert fetched["fields"] == created["fields"]

    renamed = api.patch(
        f"/api/forms/templates/{created['id']}",
        json={"name": "  Quick check-in ", "requires_signature": True},
        headers=clinician.headers,
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Quick check-in"
    assert renamed.json()["requires_signature"] is True
    assert renamed.json()["fields"] == created["fields"]

    new_fields = [{"id": "only", "type": "long_text", "label": "Anything else?"}]
    refielded = api.patch(
        f"/api/forms/templates/{created['id']}",
        json={"fields": new_fields},
        headers=clinician.headers,
    )
    assert [f["id"] for f in refielded.json()["fields"]] == ["only"]
    null_name = api.patch(
        f"/api/forms/templates/{created['id']}", json={"name": None}, headers=clinician.headers
    )
    assert null_name.status_code == 422

    assert (
        api.delete(f"/api/forms/templates/{created['id']}", headers=clinician.headers).status_code
        == 204
    )
    assert "Quick check-in" not in _templates(api, clinician)


def _field(**overrides: Any) -> dict[str, Any]:
    return {"id": "q1", "type": "short_text", "label": "Question", **overrides}


def _choice(*values: Any, **overrides: Any) -> dict[str, Any]:
    options = [{"label": f"Option {i}", "value": v} for i, v in enumerate(values)]
    return _field(type="single_choice", options=options, **overrides)


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ([], "at least 1"),
        ([_field(), _field(label="Again")], "used more than once"),
        ([_field(id="Bad-Id")], "pattern"),
        ([_field(id="x" * 41)], "pattern"),
        ([_field(type="signature")], "type"),
        ([_field(label="")], "at least 1 character"),
        ([_choice(1)], "at least 2 options"),
        ([_choice(1, 1)], "unique"),
        ([_choice(1, "one")], "all numbers or all text"),
        ([_choice(True, False)], "value"),
        ([_field(options=[{"label": "A", "value": "a"}, {"label": "B", "value": "b"}])], "only"),
        ([_field(maps_to="email")], "maps_to"),
        ([_choice(0, 1, maps_to="phone")], "can't fill in phone"),
        ([_field(maps_to="date_of_birth")], "can't fill in date_of_birth"),
        ([_field(type="date", maps_to="city")], "can't fill in city"),
        ([_field(type="heading", required=True)], "can't be required"),
        ([_field(type="paragraph", maps_to="city")], "can't fill in city"),
        (
            [_field(maps_to="phone"), _field(id="q2", maps_to="phone")],
            "Only one question can fill in phone",
        ),
        ([_field(id=f"q{n}") for n in range(201)], "at most 200"),
    ],
)
def test_template_field_validation(
    api: TestClient, clinician: StaffAccount, fields: list[dict[str, Any]], message: str
) -> None:
    response = api.post(
        "/api/forms/templates",
        json={"kind": "other", "name": "Broken", "fields": fields},
        headers=clinician.headers,
    )
    assert response.status_code == 422
    assert message in response.text


def test_library_assessments_are_read_only(api: TestClient, clinician: StaffAccount) -> None:
    templates = _templates(api, clinician)
    for key in ("phq9", "gad7"):
        response = api.patch(
            f"/api/forms/templates/{templates[key]['id']}",
            json={"name": "My PHQ"},
            headers=clinician.headers,
        )
        assert response.status_code == 409
    intake = api.patch(
        f"/api/forms/templates/{templates['intake']['id']}",
        json={"name": "New Client Intake"},
        headers=clinician.headers,
    )
    assert intake.status_code == 200
    assert intake.json()["library_key"] == "intake"


def test_templates_are_isolated_between_practices(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    mine = _custom_template(api, clinician)
    other = register_practice(api, email="other@example.com")
    url = f"/api/forms/templates/{mine['id']}"
    assert api.get(url, headers=other.headers).status_code == 404
    assert api.patch(url, json={"name": "Stolen"}, headers=other.headers).status_code == 404
    assert api.delete(url, headers=other.headers).status_code == 404
    assert "Check-in" not in _templates(api, other)

    their_client = create_client_record(db, other, email="theirs@example.com")
    shared = api.post(
        f"/api/clients/{their_client.id}/forms",
        json={"template_ids": [mine["id"]]},
        headers=other.headers,
    )
    assert shared.status_code == 404


# --- Sharing ---------------------------------------------------------------------------------


def test_sharing_snapshots_templates_and_sends_one_email(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    template = _custom_template(api, clinician)
    phq9 = _templates(api, clinician)["phq9"]
    shared = _share(api, clinician, client.id, template["id"], phq9["id"], template["id"])
    assert [f["name"] for f in shared] == ["Check-in", "PHQ-9"]
    assert all(f["status"] == "pending" and f["client_id"] == client.id for f in shared)

    [email] = outbound_to(db, "alex@example.com")
    assert email.subject == "Documents to complete for Lee Counseling"
    assert email.practice_id == clinician.practice_id
    assert "Jordan Lee shared documents" in email.body_text
    assert "Complete documents" in email.body_text
    assert "next=%2Fclient%2Fdocuments" in email.body_text
    assert "PHQ" not in email.body_text + (email.body_html or "")
    assert events == [
        (
            [("client", client.id)],
            "client_form.shared",
            {"client_form_ids": [shared[0]["id"], shared[1]["id"]]},
        )
    ]

    api.patch(
        f"/api/forms/templates/{template['id']}",
        json={"name": "Renamed", "fields": [{"id": "x", "type": "short_text", "label": "X"}]},
        headers=clinician.headers,
    )
    detail = api.get(f"/api/client-forms/{shared[0]['id']}", headers=clinician.headers).json()
    assert detail["name"] == "Check-in"
    assert [f["id"] for f in detail["fields"]] == [f["id"] for f in CUSTOM_FIELDS]
    phq = api.get(f"/api/client-forms/{shared[1]['id']}", headers=clinician.headers).json()
    assert phq["scoring"]["items"][0] == "q1"
    assert db.query(AuditEvent).filter_by(action="client_form.share").count() == 1
    assert db.query(AuditEvent).filter_by(action="client_form.view").count() == 2


def test_sharing_requires_portal_access(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    template_id = _templates(api, clinician)["intake"]["id"]
    no_email = create_client_record(db, clinician, email=None)
    disabled = create_client_record(db, clinician, email="off@example.com", portal_enabled=False)
    archived = create_client_record(db, clinician, email="gone@example.com", status="archived")
    for client in (no_email, disabled, archived):
        response = api.post(
            f"/api/clients/{client.id}/forms",
            json={"template_ids": [template_id]},
            headers=clinician.headers,
        )
        assert response.status_code == 409
    assert db.query(ClientForm).count() == 0


def test_share_request_validation(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    url = f"/api/clients/{client.id}/forms"
    assert api.post(url, json={"template_ids": []}, headers=clinician.headers).status_code == 422
    too_many = {"template_ids": list(range(1, 22))}
    assert api.post(url, json=too_many, headers=clinician.headers).status_code == 422
    unknown = api.post(url, json={"template_ids": [99999]}, headers=clinician.headers)
    assert unknown.status_code == 404
    deleted = _custom_template(api, clinician)
    api.delete(f"/api/forms/templates/{deleted['id']}", headers=clinician.headers)
    retired = api.post(url, json={"template_ids": [deleted["id"]]}, headers=clinician.headers)
    assert retired.status_code == 404


# --- Portal ----------------------------------------------------------------------------------


def test_portal_lists_pending_first_and_marks_viewed_once(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    [gad7] = _share_library(api, clinician, client, "gad7")
    [intake] = _share_library(api, clinician, client, "intake")
    submitted = _submit(api, client, gad7["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert submitted.status_code == 200

    headers = portal_headers(client)
    listed = api.get("/api/portal/forms", headers=headers).json()
    assert [(f["id"], f["status"]) for f in listed] == [
        (intake["id"], "pending"),
        (gad7["id"], "completed"),
    ]
    events.clear()
    first = api.get(f"/api/portal/forms/{intake['id']}", headers=headers)
    assert first.status_code == 200
    body = first.json()
    assert body["answers"] is None
    assert "description" not in body
    assert "score" not in body
    assert "scoring" not in body
    db.expire_all()
    viewed_at = db.get(ClientForm, intake["id"]).viewed_at
    assert viewed_at is not None
    api.get(f"/api/portal/forms/{intake['id']}", headers=headers)
    db.expire_all()
    assert db.get(ClientForm, intake["id"]).viewed_at == viewed_at
    assert events == [
        (
            [("staff", clinician.id)],
            "client_form.viewed",
            {"client_form_id": intake["id"], "client_id": client.id},
        )
    ]
    completed = api.get(f"/api/portal/forms/{gad7['id']}", headers=headers).json()
    assert completed["answers"]["q1"] == 0
    assert (
        db.query(AuditEvent).filter_by(action="client_form.view", actor_role="client").count() == 3
    )


def test_portal_forms_are_isolated_between_clients(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    other = create_client_record(db, clinician, email="other@example.com")
    [form] = _share_library(api, clinician, client, "gad7")
    other_headers = portal_headers(other)
    assert api.get("/api/portal/forms", headers=other_headers).json() == []
    assert api.get(f"/api/portal/forms/{form['id']}", headers=other_headers).status_code == 404
    stolen = _submit(api, other, form["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert stolen.status_code == 404
    staff_token = api.get("/api/portal/forms", headers=clinician.headers)
    assert staff_token.status_code == 401
    outsider = register_practice(api, email="outsider@example.com")
    assert api.get(f"/api/client-forms/{form['id']}", headers=outsider.headers).status_code == 404
    assert api.get(f"/api/clients/{client.id}/forms", headers=outsider.headers).status_code == 404


# --- Scoring ---------------------------------------------------------------------------------

PHQ9_SCORING = LIBRARY["phq9"].scoring
GAD7_SCORING = LIBRARY["gad7"].scoring


@pytest.mark.parametrize(
    ("values", "score", "label"),
    [
        ((0, 0, 0, 0, 0, 0, 0, 0, 0), 0, "Minimal"),
        ((1, 1, 1, 1, 0, 0, 0, 0, 0), 4, "Minimal"),
        ((1, 1, 1, 1, 1, 0, 0, 0, 0), 5, "Mild"),
        ((1, 1, 1, 1, 1, 1, 1, 1, 1), 9, "Mild"),
        ((2, 2, 2, 2, 2, 0, 0, 0, 0), 10, "Moderate"),
        ((2, 2, 2, 2, 2, 2, 2, 0, 0), 14, "Moderate"),
        ((3, 3, 3, 3, 3, 0, 0, 0, 0), 15, "Moderately severe"),
        ((3, 3, 3, 3, 3, 3, 1, 0, 0), 19, "Moderately severe"),
        ((3, 3, 3, 3, 3, 3, 2, 0, 0), 20, "Severe"),
        ((3, 3, 3, 3, 3, 3, 3, 3, 3), 27, "Severe"),
    ],
)
def test_phq9_scoring_bands(values: tuple[int, ...], score: int, label: str) -> None:
    result = score_answers(PHQ9_SCORING, _scored(*values, difficulty="somewhat_difficult"))
    assert (result.score, result.label) == (score, label)
    assert result.flagged is (values[8] > 0)


@pytest.mark.parametrize("item9", [1, 2, 3])
def test_phq9_item9_flags_any_endorsement(item9: int) -> None:
    result = score_answers(PHQ9_SCORING, _scored(0, 0, 0, 0, 0, 0, 0, 0, item9))
    assert result.flagged is True
    assert result.flag_reason == "Item 9 (thoughts of self-harm) endorsed"
    assert result.label == "Minimal"


@pytest.mark.parametrize(
    ("values", "score", "label"),
    [
        ((0, 0, 0, 0, 0, 0, 0), 0, "Minimal"),
        ((1, 1, 1, 1, 0, 0, 0), 4, "Minimal"),
        ((1, 1, 1, 1, 1, 0, 0), 5, "Mild"),
        ((2, 2, 2, 2, 1, 0, 0), 9, "Mild"),
        ((2, 2, 2, 2, 2, 0, 0), 10, "Moderate"),
        ((2, 2, 2, 2, 2, 2, 2), 14, "Moderate"),
        ((3, 3, 3, 3, 3, 0, 0), 15, "Severe"),
        ((3, 3, 3, 3, 3, 3, 3), 21, "Severe"),
    ],
)
def test_gad7_scoring_bands(values: tuple[int, ...], score: int, label: str) -> None:
    result = score_answers(GAD7_SCORING, _scored(*values))
    assert (result.score, result.label, result.flagged) == (score, label, False)


def test_scoring_edge_cases() -> None:
    assert score_answers(None, {"q1": 3}).score is None
    incomplete = score_answers(GAD7_SCORING, _scored(1, 1, 1))
    assert incomplete.score is None
    assert incomplete.label == ""
    booleans = score_answers(GAD7_SCORING, _scored(1, 1, 1, 1, 1, 1, 0) | {"q7": True})
    assert booleans.score is None


def test_submitting_phq9_scores_flags_and_alerts_clinician(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    [phq9, _intake] = _share_library(api, clinician, client, "phq9", "intake")
    events.clear()
    response = _submit(
        api,
        client,
        phq9["id"],
        answers=_scored(2, 2, 1, 1, 1, 1, 1, 1, 1, difficulty="very_difficult"),
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert "flagged" not in response.json()

    detail = api.get(f"/api/client-forms/{phq9['id']}", headers=clinician.headers).json()
    assert (detail["score"], detail["score_label"]) == (11, "Moderate")
    assert detail["flagged"] is True
    assert detail["flag_reason"] == "Item 9 (thoughts of self-harm) endorsed"
    assert detail["answers"]["difficulty"] == "very_difficult"
    assert detail["signed_at"] is None

    [alert] = outbound_to(db, clinician.email)
    assert alert.subject == "A completed assessment needs your review"
    assert f"/portal/clients/{client.id}" in alert.body_text
    for secret in ("PHQ", "11", "Moderate", "self-harm", "Alex"):
        assert secret not in alert.body_text
    assert events == [
        (
            [("staff", clinician.id)],
            "client_form.completed",
            {"client_form_id": phq9["id"], "client_id": client.id},
        )
    ]
    listed = api.get(f"/api/clients/{client.id}/forms", headers=clinician.headers).json()
    summary = next(f for f in listed if f["id"] == phq9["id"])
    assert (summary["score"], summary["flagged"]) == (11, True)


def test_flag_alert_is_sent_even_when_form_emails_are_off(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    db.get(StaffMember, clinician.id).notify_email_forms = False
    db.commit()
    client = create_client_record(db, clinician)
    [phq9] = _share_library(api, clinician, client, "phq9")
    _submit(api, client, phq9["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0, 0, 3))
    [alert] = outbound_to(db, clinician.email)
    assert alert.subject == "A completed assessment needs your review"


def test_completion_email_waits_for_the_last_pending_form(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [gad7, custom] = _share(
        api,
        clinician,
        client.id,
        _templates(api, clinician)["gad7"]["id"],
        _custom_template(api, clinician)["id"],
    )
    _submit(api, client, gad7["id"], answers=_scored(3, 3, 3, 3, 3, 3, 3))
    assert outbound_to(db, clinician.email) == []
    detail = api.get(f"/api/client-forms/{gad7['id']}", headers=clinician.headers).json()
    assert (detail["score"], detail["score_label"], detail["flagged"]) == (21, "Severe", False)

    _submit(api, client, custom["id"], answers={"topics": ["mood"], "ok_to_text": False})
    [done] = outbound_to(db, clinician.email)
    assert done.subject == "A client completed their documents"
    assert "Alex" not in done.body_text


def test_completion_email_respects_setting(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    db.get(StaffMember, clinician.id).notify_email_forms = False
    db.commit()
    client = create_client_record(db, clinician)
    [gad7] = _share_library(api, clinician, client, "gad7")
    assert _submit(api, client, gad7["id"], answers=_scored(0, 1, 0, 1, 0, 1, 0)).status_code == 200
    assert outbound_to(db, clinician.email) == []


# --- Answer validation -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answers", "errors"),
    [
        ({"ok_to_text": True}, {"topics": "This question is required"}),
        ({"topics": [], "ok_to_text": True}, {"topics": "This question is required"}),
        ({"topics": ["mood"]}, {"ok_to_text": "This question is required"}),
        ({"topics": ["mood"], "ok_to_text": "yes"}, {"ok_to_text": "Answer yes or no"}),
        ({"topics": ["mood"], "ok_to_text": 1}, {"ok_to_text": "Answer yes or no"}),
        ({"topics": ["cats"], "ok_to_text": True}, {"topics": "Choose from the options"}),
        ({"topics": "mood", "ok_to_text": True}, {"topics": "Choose from the options"}),
        (
            {"topics": ["mood"], "ok_to_text": True, "start": "09/25/2026"},
            {"start": "Enter a date as YYYY-MM-DD"},
        ),
        (
            {"topics": ["mood"], "ok_to_text": True, "start": "2026-02-30"},
            {"start": "Enter a valid date"},
        ),
        ({"topics": ["mood"], "ok_to_text": True, "nickname": 7}, {"nickname": "Enter text"}),
        (
            {"topics": ["mood"], "ok_to_text": True, "nickname": "x" * 101},
            {"nickname": "Keep this to 100 characters or fewer"},
        ),
        (
            {"topics": ["mood"], "ok_to_text": True, "intro": "hi", "extra": "?"},
            {
                "intro": "This question isn't on the form",
                "extra": "This question isn't on the form",
            },
        ),
    ],
)
def test_answer_validation(answers: dict[str, Any], errors: dict[str, str]) -> None:
    _, problems = clean_answers(CUSTOM_FIELDS, answers)
    assert problems == errors


def test_answers_are_normalized() -> None:
    answers, errors = clean_answers(
        CUSTOM_FIELDS,
        {
            "nickname": "  Lex  ",
            "topics": ["work", "sleep", "work"],
            "start": "2026-01-05",
            "ok_to_text": False,
        },
    )
    assert errors == {}
    assert answers == {
        "nickname": "Lex",
        "topics": ["sleep", "work"],
        "start": "2026-01-05",
        "ok_to_text": False,
    }
    blank, _ = clean_answers(
        CUSTOM_FIELDS, {"nickname": "   ", "topics": ["mood"], "ok_to_text": True}
    )
    assert "nickname" not in blank


def test_scored_items_reject_booleans_and_strings() -> None:
    fields = LIBRARY["gad7"].fields
    _, errors = clean_answers(fields, _scored(True, "1", 4, 0, 0, 0, 0))
    assert errors == {
        "q1": "Choose one of the options",
        "q2": "Choose one of the options",
        "q3": "Choose one of the options",
    }


def test_invalid_submission_returns_field_errors(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [form] = _share(api, clinician, client.id, _custom_template(api, clinician)["id"])
    response = _submit(api, client, form["id"], answers={"topics": ["cats"], "bogus": 1})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["message"] == "Some answers need attention"
    assert detail["errors"] == {
        "bogus": "This question isn't on the form",
        "topics": "Choose from the options",
        "ok_to_text": "This question is required",
    }
    assert detail["signature"] is None
    too_long = _submit(
        api, client, form["id"], answers={"topics": ["mood"], "ok_to_text": True, "x": "a" * 5001}
    )
    assert too_long.status_code == 422
    db.expire_all()
    assert db.get(ClientForm, form["id"]).status == "pending"


# --- Signatures, auto-fill and resubmission --------------------------------------------------


def test_consent_requires_and_records_signature(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [consent] = _share_library(api, clinician, client, "informed_consent")
    unsigned = _submit(api, client, consent["id"], answers={})
    assert unsigned.status_code == 422
    assert unsigned.json()["detail"]["signature"] == "Type your full name to sign"
    too_short = _submit(api, client, consent["id"], signature_name=" A ", signature_agreed=True)
    assert too_short.json()["detail"]["signature"] == "Type your full name to sign"
    not_agreed = _submit(api, client, consent["id"], signature_name="Alex Rivera")
    assert not_agreed.json()["detail"]["signature"] == "Agree to sign electronically to continue"
    over_limit = _submit(
        api, client, consent["id"], signature_name="A" * 201, signature_agreed=True
    )
    assert over_limit.status_code == 422

    signed = _submit(
        api, client, consent["id"], signature_name="  Alex Rivera ", signature_agreed=True
    )
    assert signed.status_code == 200
    assert signed.json()["signature_name"] == "Alex Rivera"
    assert signed.json()["signed_at"] is not None

    detail = api.get(f"/api/client-forms/{consent['id']}", headers=clinician.headers).json()
    assert detail["signature_name"] == "Alex Rivera"
    assert detail["signer_ip"] == "testclient"
    assert detail["signer_user_agent"] == "FormsTest/1.0"
    assert detail["signed_at"] == detail["completed_at"]
    assert detail["answers"] == {}

    again = _submit(api, client, consent["id"], signature_name="Alex Rivera", signature_agreed=True)
    assert again.status_code == 409


def test_signature_is_ignored_when_not_required(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [gad7] = _share_library(api, clinician, client, "gad7")
    response = _submit(
        api, client, gad7["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0), signature_name="Alex"
    )
    assert response.status_code == 200
    assert response.json()["signature_name"] == ""
    assert response.json()["signed_at"] is None


def test_intake_autofills_only_empty_client_fields(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, city="Salem")
    [intake] = _share_library(api, clinician, client, "intake")
    answers = {
        "preferred_name": "Lex",
        "pronouns": "they/them",
        "date_of_birth": "1990-04-12",
        "phone": "555-000-0000",
        "city": "Portland",
        "state": "OR",
        "emergency_contact_name": "Sam Rivera",
        "emergency_contact_phone": "555-111-2222",
        "reason": "Feeling stuck at work",
        "prior_therapy": False,
        "safety_thoughts": False,
        "alcohol_use": "monthly_or_less",
    }
    response = _submit(api, client, intake["id"], answers=answers)
    assert response.status_code == 200, response.text
    db.expire_all()
    refreshed = db.get(Client, client.id)
    assert refreshed.preferred_name == "Lex"
    assert refreshed.pronouns == "they/them"
    assert refreshed.date_of_birth == date(1990, 4, 12)
    assert refreshed.state == "OR"
    [emergency] = refreshed.contacts
    assert (emergency.first_name, emergency.last_name, emergency.phone) == (
        "Sam",
        "Rivera",
        "555-111-2222",
    )
    assert emergency.is_emergency_contact
    assert not emergency.portal_access
    assert refreshed.phone == "555-201-3344"
    assert refreshed.city == "Salem"
    assert refreshed.address_line1 == ""
    audit = db.query(AuditEvent).filter_by(action="client_form.submit").one()
    assert set(audit.detail["autofilled"]) == {
        "preferred_name",
        "pronouns",
        "date_of_birth",
        "state",
        "emergency_contact_name",
        "emergency_contact_phone",
    }


EMERGENCY_ANSWERS = {
    "reason": "Stress",
    "prior_therapy": False,
    "safety_thoughts": False,
    "alcohol_use": "never",
    "date_of_birth": "1990-04-12",
    "phone": "555-000-0000",
}


def _emergency_contacts(db: Session, client: Client) -> list[tuple[str, str, str, str]]:
    db.expire_all()
    contacts = db.query(ClientContact).filter_by(client_id=client.id, is_emergency_contact=True)
    return [
        (contact.first_name, contact.last_name, contact.phone, contact.relation)
        for contact in contacts.order_by(ClientContact.id)
    ]


def test_intake_fills_in_the_existing_emergency_contact(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    db.add(
        ClientContact(
            client_id=client.id, first_name="Sam", last_name="Rivera", is_emergency_contact=True
        )
    )
    db.commit()
    [intake] = _share_library(api, clinician, client, "intake")
    answers = {
        **EMERGENCY_ANSWERS,
        "emergency_contact_name": "sam rivera",
        "emergency_contact_phone": "555-111-2222",
        "emergency_contact_relationship": "Brother",
    }
    response = _submit(api, client, intake["id"], answers=answers)
    assert response.status_code == 200, response.text
    assert _emergency_contacts(db, client) == [("Sam", "Rivera", "555-111-2222", "Brother")]
    audit = db.query(AuditEvent).filter_by(action="client_form.submit").one()
    assert {"emergency_contact_phone", "emergency_contact_relationship"} <= set(
        audit.detail["autofilled"]
    )
    assert "emergency_contact_name" not in audit.detail["autofilled"]


def test_intake_naming_someone_else_adds_an_emergency_contact(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    db.add(
        ClientContact(
            client_id=client.id,
            first_name="Sam",
            last_name="Rivera",
            phone="555-999-0000",
            is_emergency_contact=True,
        )
    )
    db.commit()
    [intake] = _share_library(api, clinician, client, "intake")
    answers = {
        **EMERGENCY_ANSWERS,
        "emergency_contact_name": "Mary Ann Lopez",
        "emergency_contact_phone": "555-111-2222",
    }
    response = _submit(api, client, intake["id"], answers=answers)
    assert response.status_code == 200, response.text
    assert _emergency_contacts(db, client) == [
        ("Sam", "Rivera", "555-999-0000", ""),
        ("Mary", "Ann Lopez", "555-111-2222", ""),
    ]


def test_intake_naming_an_existing_contact_makes_them_the_emergency_contact(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician, is_minor=True)
    guardian = ClientContact(
        client_id=client.id, first_name="Pat", last_name="Rivera", relation="Mother"
    )
    db.add(guardian)
    db.commit()
    [intake] = _share_library(api, clinician, client, "intake")
    answers = {
        **EMERGENCY_ANSWERS,
        "emergency_contact_name": "Pat Rivera",
        "emergency_contact_phone": "555-111-2222",
        "emergency_contact_relationship": "Parent",
    }
    assert _submit(api, client, intake["id"], answers=answers).status_code == 200
    assert _emergency_contacts(db, client) == [("Pat", "Rivera", "555-111-2222", "Mother")]
    assert db.query(ClientContact).filter_by(client_id=client.id).count() == 1


def test_emergency_contact_answers_respect_contact_column_lengths(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [intake] = _share_library(api, clinician, client, "intake")
    answers = {"emergency_contact_name": "N" * 101, "emergency_contact_relationship": "R" * 51}
    errors = _submit(api, client, intake["id"], answers=answers).json()["detail"]["errors"]
    assert errors["emergency_contact_name"] == "Keep this to 100 characters or fewer"
    assert errors["emergency_contact_relationship"] == "Keep this to 50 characters or fewer"
    assert _emergency_contacts(db, client) == []


def test_mapped_answers_respect_client_column_lengths(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [intake] = _share_library(api, clinician, client, "intake")
    response = _submit(api, client, intake["id"], answers={"phone": "5" * 31})
    assert response.json()["detail"]["errors"]["phone"] == "Keep this to 30 characters or fewer"


# --- Revoke, remind and PDF ------------------------------------------------------------------


def test_revoke_only_pending_forms(
    api: TestClient, clinician: StaffAccount, db: Session, events: list[Event]
) -> None:
    client = create_client_record(db, clinician)
    [pending, done] = _share_library(api, clinician, client, "intake", "gad7")
    _submit(api, client, done["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    events.clear()
    assert (
        api.delete(f"/api/client-forms/{done['id']}", headers=clinician.headers).status_code == 409
    )
    assert (
        api.delete(f"/api/client-forms/{pending['id']}", headers=clinician.headers).status_code
        == 204
    )
    assert events == [
        ([("client", client.id)], "client_form.revoked", {"client_form_id": pending["id"]})
    ]
    remaining = api.get("/api/portal/forms", headers=portal_headers(client)).json()
    assert [f["id"] for f in remaining] == [done["id"]]
    other = register_practice(api, email="other@example.com")
    assert api.delete(f"/api/client-forms/{done['id']}", headers=other.headers).status_code == 404


def test_manual_reminder(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician)
    [pending, done] = _share_library(api, clinician, client, "intake", "gad7")
    _submit(api, client, done["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert (
        api.post(f"/api/client-forms/{done['id']}/remind", headers=clinician.headers).status_code
        == 409
    )
    response = api.post(f"/api/client-forms/{pending['id']}/remind", headers=clinician.headers)
    assert response.status_code == 200
    emails = outbound_to(db, "alex@example.com")
    assert [e.subject for e in emails] == [
        "Documents to complete for Lee Counseling",
        "Reminder: documents to complete for Lee Counseling",
    ]
    assert "next=%2Fclient%2Fdocuments" in emails[1].body_text
    summary = api.get(f"/api/clients/{client.id}/forms", headers=clinician.headers).json()
    reminded = next(f for f in summary if f["id"] == pending["id"])
    assert reminded["reminder_count"] == 1
    assert reminded["last_reminded_at"] is not None

    client_row = db.get(Client, client.id)
    client_row.portal_enabled = False
    db.commit()
    blocked = api.post(f"/api/client-forms/{pending['id']}/remind", headers=clinician.headers)
    assert blocked.status_code == 409


def test_pdf_of_completed_form(api: TestClient, clinician: StaffAccount, db: Session) -> None:
    client = create_client_record(db, clinician, date_of_birth=date(1990, 4, 12))
    [consent, phq9] = _share_library(api, clinician, client, "informed_consent", "phq9")
    pending = api.get(f"/api/client-forms/{phq9['id']}/pdf", headers=clinician.headers)
    assert pending.status_code == 409

    _submit(
        api,
        client,
        phq9["id"],
        answers=_scored(3, 3, 3, 2, 2, 2, 1, 1, 1, difficulty="extremely_difficult"),
    )
    _submit(api, client, consent["id"], signature_name="Zoë Ríos 😀 “A”", signature_agreed=True)
    row = db.get(ClientForm, consent["id"])
    row.signed_at = datetime(2026, 9, 1, 14, 30, tzinfo=UTC)
    db.commit()

    response = api.get(f"/api/client-forms/{phq9['id']}/pdf", headers=clinician.headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith('attachment; filename="phq-9-')
    assert response.content.startswith(b"%PDF")
    text = _pdf_content(response.content)
    for expected in (
        "Lee Counseling",
        "Clinician: Jordan Lee",
        "Alex Rivera",
        "April 12, 1990",
        "Score: 18 of 27 (Moderately severe)",
        "Flagged for review: Item 9 (thoughts of self-harm) endorsed",
        "Nearly every day",
        "Extremely difficult",
    ):
        assert expected in text, expected

    signed = api.get(f"/api/client-forms/{consent['id']}/pdf", headers=clinician.headers)
    assert signed.status_code == 200
    signed_text = _pdf_content(signed.content)
    assert "Signed by: Zo\xeb R\xedos ? \x93A\x94" in signed_text
    assert "Signed on: September 1, 2026 at 10:30 AM EDT" in signed_text
    assert "IP address: testclient" in signed_text
    assert db.query(AuditEvent).filter_by(action="client_form.download_pdf").count() == 2
    other = register_practice(api, email="other@example.com")
    assert api.get(f"/api/client-forms/{phq9['id']}/pdf", headers=other.headers).status_code == 404


def test_pdf_helpers() -> None:
    assert pdf_text("café “ok” — ő \U0001f600 你") == ("café “ok” — o ? ?")
    yes_no = {"id": "a", "type": FieldType.YES_NO, "label": "A"}
    assert format_answer(yes_no, True) == "Yes"
    assert format_answer(yes_no, None) == "No answer"
    assert format_answer({"id": "d", "type": "date", "label": "D"}, "2026-01-05") == (
        "January 5, 2026"
    )
    multi = CUSTOM_FIELDS[2]
    assert format_answer(multi, ["sleep", "work"]) == "Sleep; Work"


# --- Reminder job ----------------------------------------------------------------------------


def _backdate(db: Session, form_ids: list[int], days: float) -> None:
    for form_id in form_ids:
        db.get(ClientForm, form_id).sent_at = datetime.now(UTC) - timedelta(days=days)
    db.commit()


def _reminders(db: Session, address: str) -> int:
    return sum(1 for e in outbound_to(db, address) if e.subject.startswith("Reminder"))


def test_reminder_job_is_registered() -> None:
    assert remind_incomplete_forms in JOBS


def test_reminder_job_batches_per_client_and_caps_reminders(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    fresh_client = create_client_record(db, clinician, email="fresh@example.com")
    forms = _share_library(api, clinician, client, "intake", "phq9", "gad7")
    [fresh] = _share_library(api, clinician, fresh_client, "intake")
    _submit(api, client, forms[2]["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    _backdate(db, [f["id"] for f in forms], days=4)
    _backdate(db, [fresh["id"]], days=1)

    now = datetime.now(UTC)
    remind_incomplete_forms(db, now)
    assert _reminders(db, "alex@example.com") == 1
    assert _reminders(db, "fresh@example.com") == 0
    reminder = outbound_to(db, "alex@example.com")[-1]
    assert reminder.subject == "Reminder: documents to complete for Lee Counseling"
    assert reminder.practice_id == clinician.practice_id
    remind_incomplete_forms(db, now + timedelta(hours=1))
    assert _reminders(db, "alex@example.com") == 1

    remind_incomplete_forms(db, now + timedelta(days=3, minutes=1))
    assert _reminders(db, "alex@example.com") == 2
    assert _reminders(db, "fresh@example.com") == 1
    for days in (6, 9, 12, 15):
        remind_incomplete_forms(db, now + timedelta(days=days, minutes=days))
    assert _reminders(db, "alex@example.com") == 3
    assert _reminders(db, "fresh@example.com") == 3
    db.expire_all()
    counts = {f["id"]: db.get(ClientForm, f["id"]).reminder_count for f in forms}
    assert counts == {forms[0]["id"]: 3, forms[1]["id"]: 3, forms[2]["id"]: 0}


def test_reminder_job_waits_after_a_manual_reminder_and_skips_portal_less_clients(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    blocked = create_client_record(db, clinician, email="blocked@example.com")
    [form] = _share_library(api, clinician, client, "intake")
    [blocked_form] = _share_library(api, clinician, blocked, "intake")
    _backdate(db, [form["id"], blocked_form["id"]], days=5)
    db.get(Client, blocked.id).portal_enabled = False
    db.commit()

    api.post(f"/api/client-forms/{form['id']}/remind", headers=clinician.headers)
    now = datetime.now(UTC)
    remind_incomplete_forms(db, now + timedelta(days=1))
    assert _reminders(db, "alex@example.com") == 1
    remind_incomplete_forms(db, now + timedelta(days=3, minutes=1))
    assert _reminders(db, "alex@example.com") == 2
    assert _reminders(db, "blocked@example.com") == 0


def test_template_fields_type_rejects_bad_shapes() -> None:
    adapter = TypeAdapter(TemplateFields)
    with pytest.raises(ValidationError):
        adapter.validate_python([{"id": "a", "type": "short_text"}])
    with pytest.raises(ValidationError):
        adapter.validate_python([{"id": "a", "type": "short_text", "label": "A", "maps_to": "ssn"}])


def test_intake_safety_answer_flags_the_form(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    [calm] = _share_library(api, clinician, client, "intake")
    [concerning] = _share_library(api, clinician, client, "intake")
    base = {
        "reason": "Stress",
        "prior_therapy": False,
        "alcohol_use": "never",
        "date_of_birth": "1990-04-12",
        "phone": "555-000-0000",
        "emergency_contact_name": "Sam Rivera",
        "emergency_contact_phone": "555-111-2222",
    }
    ok = _submit(api, client, calm["id"], answers={**base, "safety_thoughts": False})
    assert ok.status_code == 200, ok.text
    flagged = _submit(api, client, concerning["id"], answers={**base, "safety_thoughts": True})
    assert flagged.status_code == 200, flagged.text

    forms = {
        f["id"]: f
        for f in api.get(f"/api/clients/{client.id}/forms", headers=clinician.headers).json()
    }
    assert forms[calm["id"]]["flagged"] is False
    assert forms[concerning["id"]]["flagged"] is True
    assert forms[concerning["id"]]["score"] is None


# --- Group practice access -------------------------------------------------------------------


@pytest.fixture
def team(api: TestClient, clinician: StaffAccount, db: Session) -> dict[str, StaffAccount]:
    """Everyone in a group practice, plus someone from another practice.

    `clinician` (the owner) sees every chart. Clients below are on Casey's care team, and
    Casey is supervised by Morgan.
    """
    practice_id = clinician.practice_id
    supervisor = add_staff(
        db, practice_id, "morgan@example.com", StaffRole.CLINICIAN, first_name="Morgan"
    )
    return {
        "owner": clinician,
        "supervisor": supervisor,
        "care_team": add_staff(
            db,
            practice_id,
            "casey@example.com",
            StaffRole.CLINICIAN,
            supervisor_id=supervisor.id,
            first_name="Casey",
            last_name="Nguyen",
        ),
        "other_clinician": add_staff(db, practice_id, "riley@example.com", StaffRole.CLINICIAN),
        "client_list_clinician": add_staff(
            db,
            practice_id,
            "drew@example.com",
            StaffRole.CLINICIAN,
            clinician_access=ClinicianAccess.CLIENT_LIST,
        ),
        "scheduler": add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER),
        "practice_manager": add_staff(
            db, practice_id, "manager@example.com", StaffRole.PRACTICE_MANAGER
        ),
        "biller": add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER),
        "other_practice": register_practice(api, email="elsewhere@example.com"),
    }


def _staff_notifications(db: Session) -> dict[int, tuple[str, bool]]:
    """Staff notifications by recipient: (kind, urgent)."""
    db.expire_all()
    rows = db.query(Notification).filter_by(recipient_role=Role.STAFF)
    return {row.recipient_id: (row.kind, row.urgent) for row in rows}


@pytest.mark.parametrize(
    ("who", "can_edit"),
    [
        ("owner", True),
        ("care_team", True),
        ("practice_manager", True),
        ("scheduler", False),
        ("biller", False),
    ],
)
def test_templates_are_shared_but_only_clinicians_and_managers_change_them(
    api: TestClient, team: dict[str, StaffAccount], who: str, can_edit: bool
) -> None:
    headers = team[who].headers
    listed = api.get("/api/forms/templates", headers=headers)
    assert listed.status_code == 200
    templates = {t["library_key"]: t for t in listed.json()}
    assert set(templates) == set(LIBRARY)
    intake_url = f"/api/forms/templates/{templates['intake']['id']}"
    assert api.get(intake_url, headers=headers).status_code == 200
    assert api.get("/api/forms/library", headers=headers).status_code == 200

    body = {"kind": "intake", "name": "Check-in", "fields": CUSTOM_FIELDS}
    created = api.post("/api/forms/templates", json=body, headers=headers)
    assert created.status_code == (201 if can_edit else 403)
    added = api.post("/api/forms/library/phq9", headers=headers)
    assert added.status_code == (201 if can_edit else 403)
    renamed = api.patch(intake_url, json={"name": "Intake"}, headers=headers)
    assert renamed.status_code == (200 if can_edit else 403)
    assert api.delete(intake_url, headers=headers).status_code == (204 if can_edit else 403)


@pytest.mark.parametrize(
    ("who", "share", "listing", "sees_results", "answers", "chase"),
    [
        ("care_team", 201, 200, True, 200, 200),
        ("supervisor", 201, 200, True, 200, 403),
        ("owner", 201, 200, True, 200, 200),
        ("other_clinician", 404, 404, False, 404, 404),
        ("client_list_clinician", 201, 200, False, 404, 403),
        ("scheduler", 201, 200, False, 404, 200),
        ("practice_manager", 201, 200, False, 404, 200),
        ("biller", 201, 200, False, 404, 403),
        ("other_practice", 404, 404, False, 404, 404),
    ],
)
def test_client_form_access_by_role(
    api: TestClient,
    db: Session,
    team: dict[str, StaffAccount],
    who: str,
    share: int,
    listing: int,
    sees_results: bool,
    answers: int,
    chase: int,
) -> None:
    """Profile access shares forms and follows their status; answers need clinical access;
    withdrawing and reminding is for the care team and staff who manage every calendar."""
    client = create_client_record(db, team["care_team"])
    [pending, done] = _share_library(api, team["care_team"], client, "intake", "gad7")
    _submit(api, client, done["id"], answers=_scored(3, 3, 3, 3, 3, 3, 3))
    headers = team[who].headers
    intake_id = _templates(api, team["care_team"])["intake"]["id"]
    results = (21, "Severe", False) if sees_results else (None, None, None)

    shared = api.post(
        f"/api/clients/{client.id}/forms", json={"template_ids": [intake_id]}, headers=headers
    )
    assert shared.status_code == share
    listed = api.get(f"/api/clients/{client.id}/forms", headers=headers)
    assert listed.status_code == listing
    if listing == 200:
        summary = next(f for f in listed.json() if f["id"] == done["id"])
        assert (summary["status"], summary["name"]) == ("completed", "GAD-7")
        assert summary["completed_at"] is not None
        assert (summary["score"], summary["score_label"], summary["flagged"]) == results
    assert api.get(f"/api/client-forms/{done['id']}", headers=headers).status_code == answers
    assert api.get(f"/api/client-forms/{done['id']}/pdf", headers=headers).status_code == answers
    reminded = api.post(f"/api/client-forms/{pending['id']}/remind", headers=headers)
    assert reminded.status_code == chase
    withdrawn = api.delete(f"/api/client-forms/{pending['id']}", headers=headers)
    assert withdrawn.status_code == (204 if chase == 200 else chase)


def test_scheduler_shares_forms_in_the_practice_name(
    api: TestClient, db: Session, team: dict[str, StaffAccount]
) -> None:
    client = create_client_record(db, team["care_team"])
    [form] = _share_library(api, team["scheduler"], client, "intake")
    assert (form["score"], form["score_label"], form["flagged"]) == (None, None, None)
    _share_library(api, team["care_team"], client, "gad7")
    first, second = outbound_to(db, "alex@example.com")
    assert "Lee Counseling shared documents" in first.body_text
    assert "Casey Nguyen shared documents" in second.body_text
    audit = db.query(AuditEvent).filter_by(action="client_form.share").first()
    assert audit is not None
    assert audit.actor_id == team["scheduler"].id


def test_completion_notifies_the_care_team_and_supervisors_only(
    api: TestClient, db: Session, team: dict[str, StaffAccount], events: list[Event]
) -> None:
    care_team = team["care_team"]
    client = create_client_record(db, care_team)
    [gad7] = _share_library(api, care_team, client, "gad7")
    events.clear()
    assert _submit(api, client, gad7["id"], answers=_scored(0, 1, 0, 1, 0, 1, 0)).status_code == 200

    reviewers = {care_team.id, team["supervisor"].id}
    assert _staff_notifications(db) == dict.fromkeys(reviewers, ("form_completed", False))
    for who, account in team.items():
        expected = ["A client completed their documents"] if account.id in reviewers else []
        assert [e.subject for e in outbound_to(db, account.email)] == expected, who
    [(recipients, event, data)] = events
    assert event == "client_form.completed"
    assert data == {"client_form_id": gad7["id"], "client_id": client.id}
    profile_staff = set(team) - {"other_clinician", "other_practice"}
    assert set(recipients) == {("staff", team[who].id) for who in profile_staff}


def test_flagged_response_is_urgent_for_the_care_team_whatever_their_email_settings(
    api: TestClient, db: Session, team: dict[str, StaffAccount]
) -> None:
    care_team = team["care_team"]
    for account in (care_team, team["supervisor"]):
        db.get(StaffMember, account.id).notify_email_forms = False
    db.commit()
    client = create_client_record(db, care_team)
    [phq9] = _share_library(api, care_team, client, "phq9")
    _submit(api, client, phq9["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0, 0, 2))

    reviewers = {care_team.id, team["supervisor"].id}
    assert _staff_notifications(db) == dict.fromkeys(reviewers, ("form_flagged", True))
    for who, account in team.items():
        subjects = [e.subject for e in outbound_to(db, account.email)]
        expected = ["A completed assessment needs your review"] if account.id in reviewers else []
        assert subjects == expected, who


def test_completion_email_follows_each_reviewers_preference(
    api: TestClient, db: Session, team: dict[str, StaffAccount]
) -> None:
    db.get(StaffMember, team["care_team"].id).notify_email_forms = False
    db.commit()
    client = create_client_record(db, team["care_team"])
    [gad7] = _share_library(api, team["care_team"], client, "gad7")
    _submit(api, client, gad7["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert outbound_to(db, team["care_team"].email) == []
    [email] = outbound_to(db, team["supervisor"].email)
    assert email.subject == "A client completed their documents"
    assert team["care_team"].id in _staff_notifications(db)


def test_completion_without_a_care_team_reaches_clinical_staff(
    api: TestClient, db: Session, team: dict[str, StaffAccount]
) -> None:
    client = create_client_record(db, team["scheduler"])
    assert client.care_team == []
    [gad7] = _share_library(api, team["scheduler"], client, "gad7")
    _submit(api, client, gad7["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert set(_staff_notifications(db)) == {team["owner"].id}


def test_supervisor_is_not_told_about_other_clinicians_clients(
    api: TestClient, db: Session, team: dict[str, StaffAccount]
) -> None:
    client = create_client_record(db, team["other_clinician"])
    [gad7] = _share_library(api, team["other_clinician"], client, "gad7")
    _submit(api, client, gad7["id"], answers=_scored(0, 0, 0, 0, 0, 0, 0))
    assert set(_staff_notifications(db)) == {team["other_clinician"].id}
