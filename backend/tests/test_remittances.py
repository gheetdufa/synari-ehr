"""Remittances (835 ERAs) and clearinghouse response files: uploads, automatic posting,
reversals, review, 277CA/999 acknowledgments, the Stedi polling job and access rules."""

import json
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.claims.x12 import amount
from synari.db import utcnow
from synari.models import (
    AppointmentParticipant,
    Claim,
    Invoice,
    InvoiceItem,
    Notification,
    Payer,
    Payment,
    PaymentAllocation,
    PracticeSettings,
    Remittance,
)
from synari.models.enums import (
    ClaimStatus,
    ClaimSubmissionMethod,
    ClinicianAccess,
    InvoiceItemKind,
    InvoiceStatus,
    RemittanceStatus,
    Role,
    StaffRole,
)
from synari.services import billing
from synari.services.claims_jobs import poll_clearinghouse
from tests.conftest import StaffAccount, add_staff, register_practice
from tests.insurance_helpers import (
    CLINICIAN_NPI,
    add_payer,
    attended_session,
    configure_practice,
    insured_client,
    no_clearinghouse,  # noqa: F401
    use_stedi,
)

FIXTURES = Path(__file__).parent / "claims" / "fixtures"
POLL_URL = "https://core.us.stedi.com/2023-08-01/polling/transactions"
PAYER_CLAIM_NUMBER = "EVG900001"


# X12 files ----------------------------------------------------------------------------------


def _x12(functional_id: str, transaction: str, body: list[str], control: int = 101) -> str:
    """An interchange with one functional group and one transaction set around `body`."""
    segments = [
        f"ISA*00*          *00*          *ZZ*{'EVERGREEN':<15}*ZZ*{'LEE01':<15}*260925*0930*^*"
        f"00501*{control:09d}*0*T*:",
        f"GS*{functional_id}*EVERGREEN*LEE01*20260925*0930*{control}*X*005010",
        f"ST*{transaction}*0001",
        *body,
        f"SE*{len(body) + 2}*0001",
        f"GE*1*{control}",
        f"IEA*1*{control:09d}",
    ]
    return "".join(f"{segment}~\n" for segment in segments)


def _service(
    line: dict[str, Any], charge: int, paid: int, written_off: int, patient: int
) -> list[str]:
    """An SVC loop for one of our lines: CO 45 written off, PR 2 owed by the client."""
    return [
        f"SVC*HC:90837*{amount(charge)}*{amount(paid)}**1",
        f"DTM*472*{date.fromisoformat(line['service_date']):%Y%m%d}",
        f"CAS*CO*45*{amount(written_off)}",
        f"CAS*PR*2*{amount(patient)}",
        f"REF*6R*{line['line_control_number']}",
        *([f"AMT*B6*{amount(charge - written_off)}"] if paid >= 0 else []),
    ]


def _claim_payment(
    claim: dict[str, Any],
    *,
    status_code: str = "1",
    paid: int = 10000,
    written_off: int = 3000,
    patient: int = 2000,
    control_number: str | None = None,
) -> tuple[list[str], int]:
    """CLP plus its service line for our one-line claim; negative amounts for reversals."""
    sign = -1 if status_code == "22" else 1
    charge = sign * claim["total_charge_cents"]
    paid, written_off, patient = sign * paid, sign * written_off, sign * patient
    segments = [
        f"CLP*{control_number or claim['patient_control_number']}*{status_code}*"
        f"{amount(charge)}*{amount(paid)}*{amount(patient)}*12*{PAYER_CLAIM_NUMBER}*11*1",
        "NM1*QC*1*RIVERA*ALEX****MI*EVG123456789",
        *_service(claim["lines"][0], charge, paid, written_off, patient),
    ]
    return segments, paid


def _era(payments: list[tuple[list[str], int]], trace: str = "EFT1001") -> str:
    """An 835 paying the sum of the claim payments (a debit when that's negative)."""
    total = sum(paid for _, paid in payments)
    credit = "D" if total < 0 else "C"
    body = [
        f"BPR*I*{amount(abs(total))}*{credit}*ACH*CCP*01*999999999*DA*123456*1512345678**01*"
        "888888888*DA*654321*20260926",
        f"TRN*1*{trace}*1512345678",
        "N1*PR*EVERGREEN HEALTH PLAN",
        "REF*2U*EVRGN",
        f"N1*PE*LEE COUNSELING*XX*{CLINICIAN_NPI}",
        "LX*1",
        *(segment for segments, _ in payments for segment in segments),
    ]
    return _x12("HP", "835", body)


def _claim_acknowledgment(claim: dict[str, Any], *, accepted: bool) -> str:
    status = (
        "STC*A2:20:PR*20260920*WQ*150"
        if accepted
        else "STC*A7:562:85*20260920*U*150********Billing provider NPI not on file"
    )
    body = [
        "BHT*0085*08*277CA0001*20260920*1500*TH",
        "HL*1**20*1",
        "NM1*PR*2*EVERGREEN HEALTH PLAN*****PI*EVRGN",
        "HL*2*1*21*1",
        "NM1*41*2*LEE COUNSELING*****46*LEE01",
        "HL*3*2*19*1",
        f"NM1*85*2*LEE COUNSELING*****XX*{CLINICIAN_NPI}",
        "HL*4*3*PT",
        "NM1*QC*1*RIVERA*ALEX****MI*EVG123456789",
        f"TRN*2*{claim['patient_control_number']}",
        status,
        f"REF*1K*{PAYER_CLAIM_NUMBER}",
    ]
    return _x12("HN", "277", body)


def _file_acknowledgment(group_control_number: str, *, accepted: bool) -> str:
    verdict = "A" if accepted else "R"
    body = [
        f"AK1*HC*{group_control_number}*005010X222A1",
        "AK2*837*0001*005010X222A1",
        "IK3*NM1*17*2010BA*8",
        *([] if accepted else ["IK4*9*67*1"]),
        f"IK5*{verdict}" + ("" if accepted else "*5"),
        f"AK9*{verdict}*1*1*{1 if accepted else 0}",
    ]
    return _x12("FA", "999", body)


# Setup --------------------------------------------------------------------------------------


def _upload(api: TestClient, staff: StaffAccount, text: str, name: str = "era.835") -> Any:
    return api.post(
        "/api/remittances/upload",
        files={"file": (name, text.encode(), "text/plain")},
        headers=staff.headers,
    )


def _evergreen(db: Session, staff: StaffAccount) -> Payer:
    """The practice's Evergreen payer, added the first time it's needed."""
    existing = db.scalars(
        select(Payer).where(Payer.practice_id == staff.practice_id, Payer.external_id == "EVRGN")
    ).first()
    return existing or add_payer(db, staff.practice_id)


def _claim(
    api: TestClient,
    db: Session,
    staff: StaffAccount,
    *,
    method: str = "paper",
    email: str = "alex@example.com",
    sessions: int = 1,
) -> dict[str, Any]:
    """A submitted claim for attended $150 sessions (one line each); returns its detail."""
    client = insured_client(db, staff, _evergreen(db, staff), email=email)
    participant_ids = [
        attended_session(db, staff, [client], days_ago=3 + index)[0].id for index in range(sessions)
    ]
    created = api.post(
        "/api/claims", json={"participant_ids": participant_ids}, headers=staff.headers
    )
    assert created.status_code == 201, created.text
    claim_id = created.json()[0]["id"]
    submitted = api.post(
        "/api/claims/submit",
        json={"claim_ids": [claim_id], "method": method},
        headers=staff.headers,
    )
    assert submitted.status_code == 200, submitted.text
    detail = api.get(f"/api/claims/{claim_id}", headers=staff.headers)
    assert detail.status_code == 200, detail.text
    return detail.json()


@pytest.fixture
def practice(db: Session, clinician: StaffAccount) -> StaffAccount:
    """The owner-clinician of a practice set up for claims."""
    configure_practice(db, clinician)
    return clinician


def _claim_row(db: Session, claim_id: int) -> Claim:
    db.expire_all()
    return db.get_one(Claim, claim_id)


def _participant(db: Session, claim: dict[str, Any]) -> AppointmentParticipant:
    db.expire_all()
    return db.get_one(AppointmentParticipant, claim["lines"][0]["participant_id"])


def _notified(db: Session, staff_id: int, kind: str) -> bool:
    return (
        db.scalar(
            select(Notification.id).where(
                Notification.recipient_role == Role.STAFF,
                Notification.recipient_id == staff_id,
                Notification.kind == kind,
            )
        )
        is not None
    )


# Automatic posting --------------------------------------------------------------------------


@pytest.mark.parametrize("invoice_paid", [False, True])
def test_835_upload_posts_payment_and_moves_patient_responsibility(
    api: TestClient, db: Session, practice: StaffAccount, invoice_paid: bool
) -> None:
    claim = _claim(api, db, practice)
    participant = _participant(db, claim)
    service_line = InvoiceItem(
        kind=InvoiceItemKind.SERVICE,
        participant_id=participant.id,
        clinician_id=practice.id,
        service_date=date.fromisoformat(claim["lines"][0]["service_date"]),
        service_code="90837",
        description="Psychotherapy, 60 minutes",
        amount_cents=15000,
    )
    invoice = Invoice(
        practice_id=practice.practice_id,
        client_id=claim["client_id"],
        number="INV-000001",
        issued_on=utcnow().date(),
        due_on=utcnow().date(),
        status=InvoiceStatus.PAID if invoice_paid else InvoiceStatus.OPEN,
        total_cents=15000,
        paid_cents=15000 if invoice_paid else 0,
        items=[service_line],
    )
    db.add(invoice)
    db.flush()
    if invoice_paid:
        db.add(
            Payment(
                practice_id=practice.practice_id,
                client_id=claim["client_id"],
                amount_cents=15000,
                method="cash",
                status="succeeded",
                received_at=utcnow(),
                allocations=[PaymentAllocation(invoice_id=invoice.id, amount_cents=15000)],
            )
        )
    db.commit()

    response = _upload(api, practice, _era([_claim_payment(claim)]))

    assert response.status_code == 201, response.text
    result = response.json()
    assert result["kind"] == "835"
    assert result["claim_ids"] == [claim["id"]]
    [remittance] = result["remittances"]
    assert remittance["status"] == RemittanceStatus.POSTED
    assert remittance["total_paid_cents"] == 10000
    assert remittance["unmatched_count"] == 0

    row = _claim_row(db, claim["id"])
    assert row.status == ClaimStatus.PAID
    assert (row.paid_cents, row.adjustment_cents, row.patient_responsibility_cents) == (
        10000,
        3000,
        2000,
    )
    assert row.insurance_balance_cents == 0
    assert row.payer_claim_number == PAYER_CLAIM_NUMBER
    assert row.adjudicated_at is not None
    [line] = row.lines
    assert (line.paid_cents, line.adjustment_cents, line.patient_responsibility_cents) == (
        10000,
        3000,
        2000,
    )
    assert line.allowed_cents == 12000
    assert row.events[-1].kind == "paid"

    assert _participant(db, claim).client_owes_cents == 2000
    invoice = db.get_one(Invoice, invoice.id)
    adjustments = [item for item in invoice.items if item.kind == InvoiceItemKind.ADJUSTMENT]
    assert [item.amount_cents for item in adjustments] == [-13000]
    assert invoice.total_cents == 2000
    if invoice_paid:
        assert (invoice.paid_cents, invoice.status) == (2000, InvoiceStatus.PAID)
        assert billing.client_credit_cents(db, claim["client_id"]) == 13000
    else:
        assert (invoice.paid_cents, invoice.status) == (0, InvoiceStatus.OPEN)


def test_patient_responsibility_without_an_invoice_only_sets_what_the_client_owes(
    api: TestClient, db: Session, practice: StaffAccount
) -> None:
    claim = _claim(api, db, practice)

    assert _upload(api, practice, _era([_claim_payment(claim)])).status_code == 201

    assert _participant(db, claim).client_owes_cents == 2000
    assert db.scalars(select(Invoice)).all() == []


@pytest.mark.parametrize(
    ("second_file", "expected"),
    [
        pytest.param(
            [{"status_code": "22"}],
            (ClaimStatus.ACCEPTED, 0, 0, 0, 2000, "reversed"),
            id="reversal only",
        ),
        pytest.param(
            [
                {"status_code": "22"},
                {"status_code": "1", "paid": 11000, "written_off": 3000, "patient": 1000},
            ],
            (ClaimStatus.PAID, 11000, 3000, 1000, 1000, "paid"),
            id="reversal and new payment",
        ),
    ],
)
def test_reversal_takes_back_the_earlier_payment(
    api: TestClient,
    db: Session,
    practice: StaffAccount,
    second_file: list[dict[str, Any]],
    expected: tuple[str, int, int, int, int, str],
) -> None:
    claim = _claim(api, db, practice)
    assert _upload(api, practice, _era([_claim_payment(claim)])).status_code == 201

    payments = [_claim_payment(claim, **changes) for changes in second_file]
    response = _upload(api, practice, _era(payments, trace="EFT1002"))

    assert response.status_code == 201, response.text
    assert response.json()["remittances"][0]["status"] == RemittanceStatus.POSTED
    row = _claim_row(db, claim["id"])
    status, paid, written_off, patient, owed, last_event = expected
    assert row.status == status
    assert (row.paid_cents, row.adjustment_cents, row.patient_responsibility_cents) == (
        paid,
        written_off,
        patient,
    )
    [line] = row.lines
    assert (line.paid_cents, line.adjustment_cents, line.patient_responsibility_cents) == (
        paid,
        written_off,
        patient,
    )
    assert row.events[-1].kind == last_event
    assert _participant(db, claim).client_owes_cents == owed


# Review -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("changes", "assign"),
    [
        pytest.param({"control_number": "UNKNOWN1"}, True, id="unmatched claim"),
        pytest.param({"written_off": 1000}, False, id="out of balance"),
    ],
)
def test_remittance_needs_review_then_posts_by_hand(
    api: TestClient,
    db: Session,
    practice: StaffAccount,
    changes: dict[str, Any],
    assign: bool,
) -> None:
    biller = add_staff(db, practice.practice_id, "biller@example.com", StaffRole.BILLER)
    basic = add_staff(
        db, practice.practice_id, "basic@example.com", StaffRole.CLINICIAN, first_name="Robin"
    )
    claim = _claim(api, db, practice)

    response = _upload(api, practice, _era([_claim_payment(claim, **changes)]))

    assert response.status_code == 201, response.text
    [remittance] = response.json()["remittances"]
    assert remittance["status"] == RemittanceStatus.NEEDS_REVIEW
    assert remittance["unmatched_count"] == (1 if assign else 0)
    assert _claim_row(db, claim["id"]).status == ClaimStatus.SUBMITTED
    assert _notified(db, practice.id, "remittance_review")
    assert _notified(db, biller.id, "remittance_review")
    assert not _notified(db, basic.id, "remittance_review")

    detail = api.get(f"/api/remittances/{remittance['id']}", headers=biller.headers).json()
    [payment] = detail["claims"]
    assert payment["posted_at"] is None
    assignments = (
        [{"remittance_claim_id": payment["id"], "claim_id": claim["id"]}] if assign else []
    )
    posted = api.post(
        f"/api/remittances/{remittance['id']}/post",
        json={"assignments": assignments},
        headers=biller.headers,
    )

    assert posted.status_code == 200, posted.text
    body = posted.json()
    assert body["status"] == RemittanceStatus.POSTED
    assert body["claims"][0]["claim_id"] == claim["id"]
    assert body["claims"][0]["client_name"] == "Alex Rivera"
    assert body["claims"][0]["posted_at"] is not None
    row = _claim_row(db, claim["id"])
    assert (row.status, row.paid_cents) == (ClaimStatus.PAID, 10000)

    again = api.post(f"/api/remittances/{remittance['id']}/post", json={}, headers=biller.headers)
    assert again.status_code == 409


def test_manual_post_refuses_a_claim_whose_lines_dont_match(
    api: TestClient, db: Session, practice: StaffAccount
) -> None:
    claim = _claim(api, db, practice)
    two_lines = _claim(api, db, practice, email="sam@example.com", sessions=2)
    segments, paid = _claim_payment(claim, control_number="UNKNOWN1")
    segments = [
        "DTM*472*19990101"
        if segment.startswith("DTM*472*")
        else segment.replace(claim["lines"][0]["line_control_number"], "NOT-OURS")
        for segment in segments
    ]
    remittance = _upload(api, practice, _era([(segments, paid)])).json()["remittances"][0]
    detail = api.get(f"/api/remittances/{remittance['id']}", headers=practice.headers).json()
    assignment = {"remittance_claim_id": detail["claims"][0]["id"], "claim_id": two_lines["id"]}

    response = api.post(
        f"/api/remittances/{remittance['id']}/post",
        json={"assignments": [assignment]},
        headers=practice.headers,
    )

    assert response.status_code == 422
    assert _claim_row(db, two_lines["id"]).status == ClaimStatus.SUBMITTED
    db.expire_all()
    assert db.get_one(Remittance, remittance["id"]).status == RemittanceStatus.NEEDS_REVIEW


# Uploads ------------------------------------------------------------------------------------


def test_duplicate_upload_is_refused_and_the_file_is_kept(
    api: TestClient, db: Session, practice: StaffAccount
) -> None:
    claim = _claim(api, db, practice)
    era = _era([_claim_payment(claim)])

    first = _upload(api, practice, era)
    second = _upload(api, practice, era)

    assert first.status_code == 201
    assert second.status_code == 409
    assert db.scalars(select(Remittance)).all()[0].id == first.json()["remittances"][0]["id"]
    remittance_id = first.json()["remittances"][0]["id"]
    download = api.get(f"/api/remittances/{remittance_id}/file", headers=practice.headers)
    assert download.status_code == 200
    assert download.text == era
    assert 'filename="era.835"' in download.headers["content-disposition"]
    listed = api.get("/api/remittances", headers=practice.headers)
    assert [r["id"] for r in listed.json()] == [remittance_id]
    assert listed.json()[0]["source"] == "upload"
    assert listed.headers["x-total-count"] == "1"
    past_end = api.get("/api/remittances", params={"offset": 1}, headers=practice.headers)
    assert past_end.json() == []


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("PATIENT,AMOUNT\nAlex,150\n", id="not x12"),
        pytest.param(_x12("HC", "837", ["BHT*0019*00*1*20260925*0930*CH"]), id="an 837"),
    ],
)
def test_upload_refuses_files_it_cannot_import(
    api: TestClient, practice: StaffAccount, text: str
) -> None:
    response = _upload(api, practice, text, name="upload.txt")
    assert response.status_code == 422


# Acknowledgments ----------------------------------------------------------------------------


@pytest.mark.parametrize("accepted", [True, False])
def test_277ca_upload_accepts_or_rejects_claims(
    api: TestClient, db: Session, practice: StaffAccount, accepted: bool
) -> None:
    claim = _claim(api, db, practice)

    response = _upload(api, practice, _claim_acknowledgment(claim, accepted=accepted), "ack.277")

    assert response.status_code == 201, response.text
    assert response.json()["kind"] == "277"
    assert response.json()["claim_ids"] == [claim["id"]]
    row = _claim_row(db, claim["id"])
    assert row.payer_claim_number == PAYER_CLAIM_NUMBER
    if accepted:
        assert row.status == ClaimStatus.ACCEPTED
        assert row.events[-1].kind == "accepted"
        assert not _notified(db, practice.id, "claim_rejected")
    else:
        assert row.status == ClaimStatus.REJECTED
        assert row.last_error == "Billing provider NPI not on file"
        assert _notified(db, practice.id, "claim_rejected")


@pytest.mark.parametrize("accepted", [True, False])
def test_999_upload_answers_for_the_exported_837p_file(
    api: TestClient, db: Session, practice: StaffAccount, accepted: bool
) -> None:
    settings = db.get_one(PracticeSettings, practice.practice_id)
    settings.x12_submitter_id = "LEE01"
    settings.x12_receiver_id = "CLEARHOUSE"
    db.commit()
    claim = _claim(api, db, practice, method="x12_file")
    assert claim["submission_method"] == ClaimSubmissionMethod.X12_FILE

    response = _upload(
        api,
        practice,
        _file_acknowledgment(claim["clearinghouse_ref"], accepted=accepted),
        "ack.999",
    )

    assert response.status_code == 201, response.text
    assert response.json()["kind"] == "999"
    row = _claim_row(db, claim["id"])
    if accepted:
        assert row.status == ClaimStatus.SUBMITTED
        assert row.events[-1].kind == "file_accepted"
    else:
        assert row.status == ClaimStatus.REJECTED
        assert row.last_error.startswith("The clearinghouse rejected the 837P file")


# Polling Stedi ------------------------------------------------------------------------------


def _poll_item(transaction_id: str, transaction_set: str) -> dict[str, Any]:
    return {
        "transactionId": transaction_id,
        "status": "succeeded",
        "direction": "INBOUND",
        "processedAt": "2026-09-25T15:00:28.354Z",
        "x12": {
            "metadata": {
                "transaction": {"controlNumber": "1", "transactionSetIdentifier": transaction_set}
            }
        },
    }


def _stedi_277(claim: dict[str, Any]) -> dict[str, Any]:
    """Stedi's 277CA fixture with our claim in place of its accepted claim C1001."""
    text = (FIXTURES / "stedi_277.json").read_text()
    return json.loads(text.replace("C1001", claim["patient_control_number"]))


def _stedi_835(claim: dict[str, Any]) -> dict[str, Any]:
    """An 835 report in Stedi's JSON shape paying our one-line claim $100 (PR $20, CO $30)."""
    line = claim["lines"][0]
    return {
        "transactions": [
            {
                "financialInformation": {
                    "totalActualProviderPaymentAmount": "100",
                    "creditOrDebitFlagCode": "C",
                    "paymentMethodCode": "ACH",
                    "checkIssueOrEFTEffectiveDate": "20260926",
                },
                "paymentAndRemitReassociationDetails": {"checkOrEFTTraceNumber": "EFT777"},
                "payer": {"name": "EVERGREEN HEALTH PLAN", "payerIdentificationNumber": "EVRGN"},
                "payee": {"name": "LEE COUNSELING", "npi": CLINICIAN_NPI},
                "detailInfo": [
                    {
                        "paymentInfo": [
                            {
                                "claimPaymentInfo": {
                                    "patientControlNumber": claim["patient_control_number"],
                                    "claimStatusCode": "1",
                                    "totalClaimChargeAmount": "150",
                                    "claimPaymentAmount": "100",
                                    "patientResponsibilityAmount": "20",
                                    "payerClaimControlNumber": PAYER_CLAIM_NUMBER,
                                },
                                "serviceLines": [
                                    {
                                        "serviceDate": line["service_date"].replace("-", ""),
                                        "lineItemControlNumber": line["line_control_number"],
                                        "servicePaymentInformation": {
                                            "adjudicatedProcedureCode": "90837",
                                            "lineItemChargeAmount": "150",
                                            "lineItemProviderPaymentAmount": "100",
                                            "unitsOfServicePaidCount": "1",
                                        },
                                        "serviceAdjustments": [
                                            {
                                                "claimAdjustmentGroupCode": "CO",
                                                "adjustmentReasonCode1": "45",
                                                "adjustmentAmount1": "30",
                                            },
                                            {
                                                "claimAdjustmentGroupCode": "PR",
                                                "adjustmentReasonCode1": "2",
                                                "adjustmentAmount1": "20",
                                            },
                                        ],
                                        "serviceSupplementalAmounts": {"allowedActual": "120"},
                                    }
                                ],
                            }
                        ]
                    }
                ],
            }
        ]
    }


def _send_through_stedi(db: Session, claim: dict[str, Any]) -> None:
    row = _claim_row(db, claim["id"])
    row.submission_method = ClaimSubmissionMethod.STEDI
    row.clearinghouse_ref = f"stedi-{row.id}"
    db.commit()


def test_poll_clearinghouse_applies_acknowledgments_and_posts_remittances(
    api: TestClient, db: Session, practice: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    claim = _claim(api, db, practice)
    still_waiting = _claim(api, db, practice, email="sam@example.com")
    _send_through_stedi(db, claim)
    _send_through_stedi(db, still_waiting)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(POLL_URL):
            items = [_poll_item("txn-277", "277"), _poll_item("txn-835", "835")]
            return httpx.Response(200, json={"items": items})
        if request.url.path.endswith("/txn-277/277"):
            return httpx.Response(200, json=_stedi_277(claim))
        assert request.url.path.endswith("/txn-835/835")
        return httpx.Response(200, json=_stedi_835(claim))

    requests = use_stedi(monkeypatch, handler)

    poll_clearinghouse(db, utcnow())

    row = _claim_row(db, claim["id"])
    assert row.status == ClaimStatus.PAID
    assert [event.kind for event in row.events][-2:] == ["accepted", "paid"]
    assert row.events[-2].data["transaction_id"] == "txn-277"
    assert _participant(db, claim).client_owes_cents == 2000
    [remittance] = db.scalars(select(Remittance)).all()
    assert (remittance.source, remittance.clearinghouse_ref) == ("stedi", "txn-835")
    assert remittance.status == RemittanceStatus.POSTED
    assert remittance.practice_id == practice.practice_id
    assert _claim_row(db, still_waiting["id"]).status == ClaimStatus.SUBMITTED
    report_fetches = [r for r in requests if "/reports/" in r.url.path]
    assert len(report_fetches) == 2

    poll_clearinghouse(db, utcnow())

    assert len([r for r in requests if "/reports/" in r.url.path]) == 2
    assert len(db.scalars(select(Remittance)).all()) == 1
    assert len([r for r in requests if str(r.url).startswith(POLL_URL)]) == 2


def test_poll_clearinghouse_waits_until_claims_are_in_flight(
    api: TestClient, db: Session, practice: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    _claim(api, db, practice)  # submitted on paper, so nothing to hear back from Stedi

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected request to {request.url}")

    requests = use_stedi(monkeypatch, handler)

    poll_clearinghouse(db, utcnow())

    assert requests == []


def test_poll_clearinghouse_is_off_without_stedi(
    api: TestClient, db: Session, practice: StaffAccount
) -> None:
    claim = _claim(api, db, practice)
    _send_through_stedi(db, claim)

    poll_clearinghouse(db, utcnow())

    assert _claim_row(db, claim["id"]).status == ClaimStatus.SUBMITTED


# Access -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "clinician_access", "allowed"),
    [
        (StaffRole.BILLER, ClinicianAccess.BASIC, True),
        (StaffRole.PRACTICE_MANAGER, ClinicianAccess.BASIC, True),
        (StaffRole.CLINICIAN, ClinicianAccess.PRACTICE, True),
        (StaffRole.CLINICIAN, ClinicianAccess.BILLING, False),
        (StaffRole.CLINICIAN, ClinicianAccess.CLIENT_LIST, False),
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, False),
        (StaffRole.SCHEDULER, ClinicianAccess.BASIC, False),
    ],
)
def test_remittances_need_practice_wide_billing(
    api: TestClient,
    db: Session,
    practice: StaffAccount,
    role: StaffRole,
    clinician_access: ClinicianAccess,
    allowed: bool,
) -> None:
    claim = _claim(api, db, practice)
    remittance_id = _upload(api, practice, _era([_claim_payment(claim)])).json()["remittances"][0][
        "id"
    ]
    member = add_staff(
        db, practice.practice_id, "member@example.com", role, clinician_access=clinician_access
    )

    listed = api.get("/api/remittances", headers=member.headers)
    detail = api.get(f"/api/remittances/{remittance_id}", headers=member.headers)
    upload = _upload(api, member, _era([_claim_payment(claim)], trace="EFT2002"))

    if allowed:
        assert (listed.status_code, detail.status_code) == (200, 200)
        assert [r["id"] for r in listed.json()] == [remittance_id]
        assert upload.status_code == 201
    else:
        assert (listed.status_code, detail.status_code, upload.status_code) == (403, 403, 403)


def test_other_practices_cannot_see_a_remittance(
    api: TestClient, db: Session, practice: StaffAccount
) -> None:
    claim = _claim(api, db, practice)
    remittance_id = _upload(api, practice, _era([_claim_payment(claim)])).json()["remittances"][0][
        "id"
    ]
    other = register_practice(api, "other@example.com")

    assert api.get(f"/api/remittances/{remittance_id}", headers=other.headers).status_code == 404
    assert api.get(f"/api/remittances/{remittance_id}/file", headers=other.headers).status_code == (
        404
    )
    posted = api.post(f"/api/remittances/{remittance_id}/post", json={}, headers=other.headers)
    assert posted.status_code == 404
    assert api.get("/api/remittances", headers=other.headers).json() == []
