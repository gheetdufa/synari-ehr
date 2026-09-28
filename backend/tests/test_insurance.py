"""Insurance setup: claim settings, the payer list and payer search, prior authorizations,
eligibility checks (on demand and automatic) and who may do what."""

import json
from datetime import date, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.db import utcnow
from synari.models import (
    Client,
    EligibilityCheck,
    InsurancePolicy,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, StaffRole
from synari.services import claims_eligibility
from synari.services.claims_eligibility import run_eligibility_checks
from tests.conftest import StaffAccount, add_staff, create_client_record, register_practice
from tests.insurance_helpers import (
    CLINICIAN_NPI,
    add_payer,
    add_policy,
    attended_session,
    configure_practice,
    insured_client,
    json_body,
    no_clearinghouse,  # noqa: F401
    use_stedi,
)

FIXTURES = Path(__file__).parent / "claims" / "fixtures"
STEDI_ELIGIBILITY = json.loads((FIXTURES / "stedi_eligibility.json").read_text())


def _eligible(_: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=STEDI_ELIGIBILITY)


def _team(db: Session, practice_id: int) -> dict[str, StaffAccount]:
    return {
        "biller": add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER),
        "manager": add_staff(db, practice_id, "manager@example.com", StaffRole.PRACTICE_MANAGER),
        "scheduler": add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER),
        "basic": add_staff(db, practice_id, "basic@example.com", StaffRole.CLINICIAN),
        "billing_clinician": add_staff(
            db,
            practice_id,
            "billing@example.com",
            StaffRole.CLINICIAN,
            clinician_access=ClinicianAccess.BILLING,
        ),
    }


# Settings ---------------------------------------------------------------------------------


def test_insurance_settings(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    team = _team(db, clinician.practice_id)

    defaults = api.get("/api/insurance/settings", headers=clinician.headers)
    assert defaults.json() == {
        "telehealth_modifier": "95",
        "supervised_billing": "supervisor_renders",
        "x12_submitter_id": "",
        "x12_receiver_id": "",
        "x12_receiver_name": "",
        "eligibility_auto_check": False,
        "clearinghouse_enabled": False,
        "clearinghouse_usage": "T",
    }
    changed = api.patch(
        "/api/insurance/settings",
        json={
            "telehealth_modifier": "gt",
            "supervised_billing": "supervisee_renders",
            "x12_submitter_id": "LEE01",
            "eligibility_auto_check": True,
        },
        headers=clinician.headers,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["telehealth_modifier"] == "GT"
    assert changed.json()["supervised_billing"] == "supervisee_renders"
    practice_settings = db.get_one(PracticeSettings, clinician.practice_id)
    assert (practice_settings.x12_submitter_id, practice_settings.eligibility_auto_check) == (
        "LEE01",
        True,
    )

    for bad in (
        {"telehealth_modifier": "955"},
        {"supervised_billing": "nobody"},
        {"x12_submitter_id": "X" * 16},
        {"eligibility_auto_check": None},
    ):
        response = api.patch("/api/insurance/settings", json=bad, headers=clinician.headers)
        assert response.status_code == 422, bad

    for role, read, write in [
        ("biller", 200, 403),
        ("manager", 200, 200),
        ("billing_clinician", 200, 403),
        ("basic", 403, 403),
        ("scheduler", 403, 403),
    ]:
        headers = team[role].headers
        assert api.get("/api/insurance/settings", headers=headers).status_code == read, role
        patched = api.patch(
            "/api/insurance/settings", json={"telehealth_modifier": ""}, headers=headers
        )
        assert patched.status_code == write, role

    use_stedi(monkeypatch, _eligible)
    assert api.get("/api/insurance/settings", headers=clinician.headers).json()[
        "clearinghouse_enabled"
    ]


# Payers -----------------------------------------------------------------------------------


def test_payer_list(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    team = _team(db, clinician.practice_id)
    created = api.post(
        "/api/insurance/payers",
        json={
            "name": "Evergreen Health Plan",
            "external_id": "EVRGN",
            "claim_filing_indicator": "bl",
            "era_enrolled": True,
        },
        headers=clinician.headers,
    )
    assert created.status_code == 201, created.text
    payer = created.json()
    assert payer["claim_filing_indicator"] == "BL"
    assert payer["is_active"] is True
    medicaid = api.post(
        "/api/insurance/payers",
        json={"name": "Apple Health", "external_id": "WAMCD", "claim_filing_indicator": "MC"},
        headers=team["biller"].headers,
    )
    assert medicaid.status_code == 201
    deactivated = api.patch(
        f"/api/insurance/payers/{medicaid.json()['id']}",
        json={"is_active": False},
        headers=team["manager"].headers,
    )
    assert deactivated.json()["is_active"] is False

    names = [p["name"] for p in api.get("/api/insurance/payers", headers=clinician.headers).json()]
    assert names == ["Evergreen Health Plan"]
    everything = api.get(
        "/api/insurance/payers", params={"include_inactive": True}, headers=clinician.headers
    )
    assert [p["name"] for p in everything.json()] == ["Apple Health", "Evergreen Health Plan"]

    for bad in (
        {"name": ""},
        {"name": "Bad", "external_id": "EVR GN"},
        {"name": "Bad", "claim_filing_indicator": "XX"},
    ):
        response = api.post("/api/insurance/payers", json=bad, headers=clinician.headers)
        assert response.status_code == 422, bad

    for role, read, write in [
        ("biller", 200, 201),
        ("manager", 200, 201),
        ("billing_clinician", 200, 403),
        ("basic", 403, 403),
        ("scheduler", 403, 403),
    ]:
        headers = team[role].headers
        assert api.get("/api/insurance/payers", headers=headers).status_code == read, role
        response = api.post("/api/insurance/payers", json={"name": role}, headers=headers)
        assert response.status_code == write, role

    other = register_practice(api, "other@example.com")
    assert api.get("/api/insurance/payers", headers=other.headers).json() == []
    elsewhere = api.patch(
        f"/api/insurance/payers/{payer['id']}", json={"name": "Mine"}, headers=other.headers
    )
    assert elsewhere.status_code == 404


def test_payer_search(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    basic = add_staff(db, clinician.practice_id, "basic@example.com", StaffRole.CLINICIAN)
    not_configured = api.get(
        "/api/insurance/payers/search", params={"q": "evergreen"}, headers=clinician.headers
    )
    assert not_configured.status_code == 409
    assert "STEDI_API_KEY" in not_configured.json()["detail"]
    found = {
        "items": [
            {
                "payer": {
                    "stediId": "EVRGN1",
                    "displayName": "Evergreen Health Plan",
                    "primaryPayerId": "EVRGN",
                    "aliases": ["EVG01"],
                    "transactionSupport": {
                        "eligibilityCheck": "SUPPORTED",
                        "professionalClaimSubmission": "SUPPORTED",
                        "claimPayment": "ENROLLMENT_REQUIRED",
                    },
                }
            }
        ]
    }
    answers = iter([httpx.Response(200, json=found), httpx.Response(500, json={})])
    requests = use_stedi(monkeypatch, lambda _: next(answers))

    response = api.get(
        "/api/insurance/payers/search", params={"q": " evergreen "}, headers=clinician.headers
    )

    assert response.status_code == 200, response.text
    assert response.json() == [
        {
            "stedi_id": "EVRGN1",
            "name": "Evergreen Health Plan",
            "payer_id": "EVRGN",
            "aliases": ["EVG01"],
            "professional_claims": "SUPPORTED",
            "eligibility": "SUPPORTED",
            "remittances": "ENROLLMENT_REQUIRED",
        }
    ]
    assert requests[0].url.params["query"] == "evergreen"
    failed = api.get(
        "/api/insurance/payers/search", params={"q": "evergreen"}, headers=clinician.headers
    )
    assert failed.status_code == 502
    denied = api.get("/api/insurance/payers/search", params={"q": "ev"}, headers=basic.headers)
    assert denied.status_code == 403


# Prior authorizations ---------------------------------------------------------------------


def test_prior_authorizations(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(db, clinician, payer)
    policy = client.insurance_policies[0]
    url = f"/api/insurance/policies/{policy.id}/authorizations"
    today = utcnow().date()
    start, end = today - timedelta(days=30), today + timedelta(days=60)

    created = api.post(
        url,
        json={
            "number": "PA-12345",
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "visits_authorized": 12,
        },
        headers=clinician.headers,
    )

    assert created.status_code == 201, created.text
    authorization = created.json()
    assert (authorization["policy_id"], authorization["visits_used"]) == (policy.id, 0)
    [participant] = attended_session(db, clinician, [client])
    claimed = api.post(
        "/api/claims", json={"participant_ids": [participant.id]}, headers=clinician.headers
    )
    assert claimed.json()[0]["prior_authorization_number"] == "PA-12345"
    [listed] = api.get(url, headers=clinician.headers).json()
    assert listed["visits_used"] == 1

    item_url = f"{url}/{authorization['id']}"
    edited = api.patch(item_url, json={"visits_authorized": None}, headers=clinician.headers)
    assert edited.json()["visits_authorized"] is None
    backwards = api.patch(
        item_url,
        json={"end_date": (start - timedelta(days=1)).isoformat()},
        headers=clinician.headers,
    )
    assert backwards.status_code == 422
    reversed_dates = api.post(
        url,
        json={"number": "X", "start_date": end.isoformat(), "end_date": start.isoformat()},
        headers=clinician.headers,
    )
    assert reversed_dates.status_code == 422
    assert api.delete(item_url, headers=clinician.headers).status_code == 204
    assert api.get(url, headers=clinician.headers).json() == []
    assert api.delete(item_url, headers=clinician.headers).status_code == 404


def test_authorization_access(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    payer = add_payer(db, clinician.practice_id)
    team = _team(db, clinician.practice_id)
    mine = insured_client(db, clinician, payer)
    theirs = insured_client(db, team["billing_clinician"], payer, email="theirs@example.com")
    other = register_practice(api, "other@example.com")

    def status_of(staff: StaffAccount, client: Client) -> int:
        url = f"/api/insurance/policies/{client.insurance_policies[0].id}/authorizations"
        return api.get(url, headers=staff.headers).status_code

    for staff, client, expected in [
        (clinician, mine, 200),
        (team["biller"], mine, 200),
        (team["billing_clinician"], theirs, 200),
        (team["billing_clinician"], mine, 404),
        (team["basic"], mine, 404),
        (team["scheduler"], mine, 404),
        (other, mine, 404),
    ]:
        assert status_of(staff, client) == expected
    missing = api.get("/api/insurance/policies/999999/authorizations", headers=clinician.headers)
    assert missing.status_code == 404


# Eligibility ------------------------------------------------------------------------------


def test_eligibility_check(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(db, clinician, payer)
    url = f"/api/insurance/policies/{client.insurance_policies[0].id}/eligibility"
    assert api.post(url, headers=clinician.headers).status_code == 409
    requests = use_stedi(monkeypatch, _eligible)

    response = api.post(url, headers=clinician.headers)

    assert response.status_code == 201, response.text
    check = response.json()
    assert check["status"] == "active"
    assert check["checked_by_id"] == clinician.id
    assert check["error"] == ""
    assert check["result"] == {
        "check_id": "ec_5f4a1c9e-0000-4000-8000-000000000001",
        "plan_name": "EVERGREEN FAMILY PPO",
        "group_number": "GRP100",
        "coverage_start": "2026-02-01",
        "coverage_end": "2026-12-31",
        "in_network": True,
        "copay_cents": 2000,
        "coinsurance_percent": 20.0,
        "deductible_cents": 150000,
        "deductible_remaining_cents": 50000,
        "out_of_pocket_cents": 600000,
        "out_of_pocket_remaining_cents": 420075,
        "prior_authorization_required": False,
        "messages": ["Telehealth visits use the office cost share"],
        "errors": [],
    }
    [request] = requests
    body = json_body(request)
    assert body["payerId"] == "EVRGN"
    assert body["provider"] == {
        "name": {"person": {"firstName": "Jordan", "lastName": "Lee"}},
        "npi": CLINICIAN_NPI,
    }
    assert body["subscriber"] == {
        "memberId": "EVG123456789",
        "name": {"person": {"firstName": "Alex", "lastName": "Rivera"}},
        "dateOfBirth": "1990-04-12",
    }
    assert "dependent" not in body
    assert body["encounter"]["services"] == [{"system": "STC", "value": "MH"}]

    [listed] = api.get(url, headers=clinician.headers).json()
    assert listed == check
    [participant] = attended_session(db, clinician, [client])
    [row] = api.get("/api/claims/unbilled", headers=clinician.headers).json()
    assert (row["participant_id"], row["eligibility_status"]) == (participant.id, "active")


def test_eligibility_for_a_dependent(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_practice(db, clinician, organization=True)
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(
        db,
        clinician,
        payer,
        subscriber_relationship="19",
        subscriber_first_name="Morgan",
        subscriber_last_name="Rivera",
        subscriber_dob=date(1968, 2, 3),
    )
    requests = use_stedi(monkeypatch, _eligible)

    url = f"/api/insurance/policies/{client.insurance_policies[0].id}/eligibility"
    assert api.post(url, headers=clinician.headers).status_code == 201

    body = json_body(requests[0])
    assert body["provider"] == {"name": {"organization": "Lee Counseling"}, "npi": "1111111112"}
    assert body["subscriber"]["name"] == {"person": {"firstName": "Morgan", "lastName": "Rivera"}}
    assert body["dependent"] == {
        "name": {"person": {"firstName": "Alex", "lastName": "Rivera"}},
        "dateOfBirth": "1990-04-12",
        "relationToSubscriber": "CHILD",
    }


@pytest.mark.parametrize(
    ("response", "status", "summary_errors", "error"),
    [
        (
            httpx.Response(
                400,
                json={
                    "id": "ec_2",
                    "errors": [
                        {
                            "description": "Subscriber/Insured Not Found",
                            "followupAction": "Please Correct and Resubmit",
                        }
                    ],
                },
            ),
            "review",
            ["Subscriber/Insured Not Found — Please Correct and Resubmit"],
            "",
        ),
        (
            httpx.Response(503, json={}),
            "error",
            [],
            "Stedi had a problem handling the request. Try again later (HTTP 503)",
        ),
    ],
)
def test_eligibility_problems_are_stored(
    api: TestClient,
    db: Session,
    clinician: StaffAccount,
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
    status: str,
    summary_errors: list[str],
    error: str,
) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(db, clinician, payer)
    use_stedi(monkeypatch, lambda _: response)

    url = f"/api/insurance/policies/{client.insurance_policies[0].id}/eligibility"
    check = api.post(url, headers=clinician.headers)

    assert check.status_code == 201, check.text
    assert check.json()["status"] == status
    assert check.json()["result"]["errors"] == summary_errors
    assert check.json()["error"] == error


def test_eligibility_needs_a_payer_id_and_an_npi(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_practice(db, clinician)
    no_id = add_payer(db, clinician.practice_id, "Paper Only", "")
    payer = add_payer(db, clinician.practice_id)
    paper_client = insured_client(db, clinician, no_id)
    client = insured_client(db, clinician, payer, email="blake@example.com")
    requests = use_stedi(monkeypatch, _eligible)

    def check(policy_client: Client, staff: StaffAccount = clinician) -> httpx.Response:
        url = f"/api/insurance/policies/{policy_client.insurance_policies[0].id}/eligibility"
        return api.post(url, headers=staff.headers)

    missing_id = check(paper_client)
    assert missing_id.status_code == 422
    assert "Paper Only's payer ID" in missing_id.json()["detail"]
    db.get_one(StaffMember, clinician.id).npi = ""
    db.commit()
    missing_npi = check(client)
    assert missing_npi.status_code == 422
    assert requests == []
    basic = add_staff(db, clinician.practice_id, "basic@example.com", StaffRole.CLINICIAN)
    assert check(client, basic).status_code == 404


# Automatic eligibility checks -------------------------------------------------------------


def _checked(db: Session, policy: InsurancePolicy, days_ago: float, status: str) -> None:
    db.add(
        EligibilityCheck(
            practice_id=policy.client.practice_id,
            policy_id=policy.id,
            status=status,
            result={},
            created_at=utcnow() - timedelta(days=days_ago),
        )
    )
    db.commit()


def test_automatic_eligibility_checks(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    clients = {
        name: insured_client(db, clinician, payer, email=f"{name}@example.com")
        for name in ("new", "recent", "stale", "changed", "erroring", "inactive", "ended")
    }
    self_pay = create_client_record(db, clinician, email="selfpay@example.com")
    add_policy(db, self_pay, payer)
    policies = {name: client.insurance_policies[0] for name, client in clients.items()}
    long_ago = utcnow() - timedelta(days=60)
    for policy in policies.values():
        policy.updated_at = long_ago
    db.commit()
    _checked(db, policies["recent"], 10, "active")
    _checked(db, policies["stale"], 40, "active")
    _checked(db, policies["changed"], 5, "active")
    _checked(db, policies["erroring"], 0.1, "error")
    policies["changed"].updated_at = utcnow() - timedelta(days=1)
    clients["inactive"].status = "inactive"
    policies["ended"].termination_date = utcnow().date() - timedelta(days=5)
    policies["ended"].updated_at = long_ago
    db.commit()
    requests = use_stedi(monkeypatch, _eligible)

    run_eligibility_checks(db, utcnow())
    assert requests == []  # automatic checks are off for this practice

    db.get_one(PracticeSettings, clinician.practice_id).eligibility_auto_check = True
    db.commit()
    monkeypatch.setattr(claims_eligibility, "MAX_AUTO_CHECKS_PER_RUN", 2)
    run_eligibility_checks(db, utcnow())
    assert len(requests) == 2
    run_eligibility_checks(db, utcnow())

    checked_now = db.scalars(
        select(EligibilityCheck.policy_id).where(
            EligibilityCheck.created_at >= utcnow() - timedelta(minutes=5),
            EligibilityCheck.status == "active",
            EligibilityCheck.checked_by_id.is_(None),
        )
    ).all()
    assert sorted(checked_now) == sorted(
        [policies["new"].id, policies["stale"].id, policies["changed"].id]
    )
    requests.clear()
    run_eligibility_checks(db, utcnow())
    assert requests == []


def test_automatic_checks_need_a_clearinghouse(db: Session, clinician: StaffAccount) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    insured_client(db, clinician, payer)
    db.get_one(PracticeSettings, clinician.practice_id).eligibility_auto_check = True
    db.commit()

    run_eligibility_checks(db, utcnow())

    assert db.scalars(select(EligibilityCheck)).all() == []
