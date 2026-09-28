"""Insurance claims: building claim documents, the unbilled queue, drafting and editing claims,
validation, submission (Stedi, 837P file, CMS-1500 paper), corrections, voids, secondary claims
and who may do what."""

from datetime import date, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.claims.document import Adjustment, ClaimDocument, PersonName
from synari.claims.document import ClaimLine as DocumentLine
from synari.claims.responses import ClaimPayment, Remittance, ServicePayment
from synari.claims.x12_parse import Segment, tokenize
from synari.db import utcnow
from synari.models import (
    AppointmentParticipant,
    Claim,
    Client,
    Location,
    Note,
    Notification,
    PracticeSettings,
    PriorAuthorization,
    StaffMember,
)
from synari.models.enums import ClinicianAccess, NoteStatus, Role, StaffRole
from synari.realtime import Recipient
from synari.services import claims as claims_service
from synari.services.claims import patient_control_number
from synari.services.claims_document import claim_document
from synari.services.claims_jobs import submit_queued_claims
from synari.services.claims_responses import import_remittance
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_appointment,
    create_client_record,
    register_practice,
)
from tests.insurance_helpers import (
    CLINICIAN_NPI,
    GROUP_NPI,
    SUPERVISEE_NPI,
    add_payer,
    add_policy,
    attended_session,
    configure_practice,
    insured_client,
    json_body,
    no_clearinghouse,  # noqa: F401
    session_at,
    use_stedi,
)

X12_IDS = {
    "x12_submitter_id": "LEE01",
    "x12_receiver_id": "CLEARHOUSE",
    "x12_receiver_name": "Test Clearinghouse",
}
STEDI_ACCEPTED = {
    "status": "SUCCESS",
    "controlNumber": "1",
    "tradingPartnerServiceId": "EVRGN",
    "claimReference": {"correlationId": "01KHC8Y4HNP0GVQ5NSVTPZBC0F"},
}


def _settings(db: Session, practice_id: int, **values: Any) -> None:
    practice_settings = db.get_one(PracticeSettings, practice_id)
    for field, value in values.items():
        setattr(practice_settings, field, value)
    db.commit()


def _staff(db: Session, staff_id: int, **values: Any) -> None:
    member = db.get_one(StaffMember, staff_id)
    for field, value in values.items():
        setattr(member, field, value)
    db.commit()


def _create(api: TestClient, staff: StaffAccount, participant_ids: list[int], **body: Any) -> Any:
    response = api.post(
        "/api/claims", json={"participant_ids": participant_ids, **body}, headers=staff.headers
    )
    assert response.status_code == 201, response.text
    return response.json()


def _detail(api: TestClient, staff: StaffAccount, claim_id: int) -> Any:
    response = api.get(f"/api/claims/{claim_id}", headers=staff.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _document(db: Session, claim_id: int) -> ClaimDocument:
    db.expire_all()
    return claim_document(db, db.get_one(Claim, claim_id))


def _submit(api: TestClient, staff: StaffAccount, claim_ids: list[int], method: str) -> Any:
    return api.post(
        "/api/claims/submit",
        json={"claim_ids": claim_ids, "method": method},
        headers=staff.headers,
    )


def _ready(db: Session, staff: StaffAccount, **practice: Any) -> tuple[Any, Any]:
    """A configured practice with an insured client; returns (payer, client)."""
    configure_practice(db, staff, **practice)
    payer = add_payer(db, staff.practice_id)
    return payer, insured_client(db, staff, payer)


def _one_claim(
    api: TestClient, db: Session, staff: StaffAccount, **practice: Any
) -> tuple[Any, Any]:
    """A draft claim for one attended session; returns (claim, client)."""
    _, client = _ready(db, staff, **practice)
    [participant] = attended_session(db, staff, [client])
    [claim] = _create(api, staff, [participant.id])
    return claim, client


def _segments(text: str, tag: str) -> list[Segment]:
    return [segment for segment in tokenize(text) if segment.tag == tag]


def _era(claim: Claim, *, paid: int, contractual: int, patient: int) -> Remittance:
    """The primary payer's 835 for a one-line claim."""
    [line] = claim.lines
    return Remittance(
        payer_name="EVERGREEN HEALTH PLAN",
        payer_id="EVRGN",
        payment_cents=paid,
        payment_method="ACH",
        trace_number=f"EFT-{claim.patient_control_number}",
        payment_date=utcnow().date(),
        claims=(
            ClaimPayment(
                patient_control_number=claim.patient_control_number,
                status_code="1",
                charge_cents=claim.total_charge_cents,
                paid_cents=paid,
                patient_responsibility_cents=patient,
                payer_claim_number="EVG20260915001",
                lines=(
                    ServicePayment(
                        procedure_code=line.procedure_code,
                        charge_cents=line.charge_cents,
                        paid_cents=paid,
                        line_control_number=line.line_control_number,
                        service_date=line.service_date,
                        allowed_cents=paid + patient,
                        adjustments=(
                            Adjustment("CO", "45", contractual),
                            Adjustment("PR", "2", patient),
                        ),
                    ),
                ),
            ),
        ),
    )


def _mark_paid(db: Session, claim_id: int) -> Claim:
    """Submit (on paper) and post the primary payer's payment: $90 paid, $20 owed by the client."""
    claim = db.get_one(Claim, claim_id)
    claim.status = "submitted"
    db.commit()
    import_remittance(
        db,
        claim.practice_id,
        _era(claim, paid=9000, contractual=4000, patient=2000),
        source="upload",
        now=utcnow(),
    )
    db.commit()
    db.refresh(claim)
    return claim


# Claim numbers and documents ---------------------------------------------------------------


def test_claim_numbers_are_unique_across_practices() -> None:
    assert patient_control_number(501, 1) == "SYN00DX1"
    assert patient_control_number(502, 1) == "SYN00DY1"
    assert patient_control_number(36**4 - 1, 99999999) == "SYNZZZZ99999999"
    assert len(patient_control_number(36**4 - 1, 10**9)) <= 17


def test_individual_billing_document(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)

    assert claim["patient_control_number"] == "SYN00DX1"
    assert claim["status"] == "draft"
    assert claim["total_charge_cents"] == 15000
    assert claim["rendering_clinician_name"] == "Jordan Lee, LCSW"
    document = _document(db, claim["id"])
    provider = document.billing_provider
    assert provider.entity_type == "individual"
    assert provider.person == PersonName(first="Jordan", last="Lee")
    assert (provider.npi, provider.taxonomy) == (CLINICIAN_NPI, "1041C0700X")
    assert (provider.tax_id, provider.tax_id_type) == ("987654321", "EIN")
    assert provider.address.postal_code == "972051234"
    assert provider.contact.phone == "5035550111"
    assert document.claim.rendering_provider is None
    assert document.subscriber.is_patient
    assert document.patient is None
    assert document.subscriber.name == PersonName(first="Alex", last="Rivera")
    assert (document.subscriber.sex, document.subscriber.birth_date) == ("F", date(1990, 4, 12))
    assert document.subscriber.claim_filing_indicator == "CI"
    assert document.payer.payer_id == "EVRGN"
    assert document.claim.diagnoses == ("F411", "F331")
    assert document.claim.lines == (
        DocumentLine(
            line_control_number="SYN00DX1-1",
            service_date=session_at(3).date(),
            procedure_code="90837",
            charge_cents=15000,
            diagnosis_pointers=(1, 2),
            place_of_service="11",
        ),
    )
    detail = _detail(api, clinician, claim["id"])
    assert detail["issues"] == []
    assert detail["diagnoses"][0] == {"code": "F411", "description": "Generalized anxiety disorder"}
    assert [event["kind"] for event in detail["events"]] == ["created"]


def test_organization_billing_names_the_rendering_clinician(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    claim, _ = _one_claim(api, db, clinician, organization=True)

    document = _document(db, claim["id"])
    assert document.billing_provider.entity_type == "organization"
    assert document.billing_provider.organization_name == "Lee Counseling"
    assert document.billing_provider.npi == GROUP_NPI
    assert document.claim.rendering_provider is not None
    assert document.claim.rendering_provider.npi == CLINICIAN_NPI
    assert document.claim.rendering_provider.taxonomy == "1041C0700X"
    assert _detail(api, clinician, claim["id"])["issues"] == []


@pytest.mark.parametrize(
    ("mode", "rendering", "supervising"),
    [
        ("supervisor_renders", "supervisor", None),
        ("supervisee_renders", "supervisee", "supervisor"),
    ],
)
def test_supervisee_sessions(
    api: TestClient,
    db: Session,
    clinician: StaffAccount,
    mode: str,
    rendering: str,
    supervising: str | None,
) -> None:
    configure_practice(db, clinician, organization=True)
    _settings(db, clinician.practice_id, supervised_billing=mode)
    associate = add_staff(
        db,
        clinician.practice_id,
        "associate@example.com",
        StaffRole.CLINICIAN,
        supervisor_id=clinician.id,
    )
    _staff(db, associate.id, npi=SUPERVISEE_NPI, taxonomy_code="101YM0800X", claim_modifier="HO")
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(db, associate, payer)
    [participant] = attended_session(db, associate, [client])

    [claim] = _create(api, clinician, [participant.id])

    ids = {"supervisor": clinician.id, "supervisee": associate.id}
    npis = {"supervisor": CLINICIAN_NPI, "supervisee": SUPERVISEE_NPI}
    assert claim["rendering_clinician_id"] == ids[rendering]
    assert claim["supervising_clinician_id"] == (ids[supervising] if supervising else None)
    document = _document(db, claim["id"])
    assert document.claim.rendering_provider is not None
    assert document.claim.rendering_provider.npi == npis[rendering]
    supervisor = document.claim.supervising_provider
    assert (supervisor.npi if supervisor else None) == (npis[supervising] if supervising else None)
    # The licensure modifier of the clinician who saw the client; U5 is never added for us.
    assert document.claim.lines[0].modifiers == ("HO",)
    assert _detail(api, clinician, claim["id"])["issues"] == []


@pytest.mark.parametrize(
    ("location_type", "location", "telehealth_modifier", "claim_modifier", "pos", "modifiers"),
    [
        ("in_person", None, "95", "", "11", []),
        ("in_person", ("Annex", "22", False), "95", "", "22", []),
        ("video", None, "95", "", "10", ["95"]),
        ("video", ("Video office", "02", True), "95", "", "02", ["95"]),
        ("video", None, "GT", "HO", "10", ["GT", "HO"]),
        ("video", None, "", "", "10", []),
        ("phone", None, "95", "", "02", []),
    ],
)
def test_place_of_service_and_modifiers(
    api: TestClient,
    db: Session,
    clinician: StaffAccount,
    location_type: str,
    location: tuple[str, str, bool] | None,
    telehealth_modifier: str,
    claim_modifier: str,
    pos: str,
    modifiers: list[str],
) -> None:
    _, client = _ready(db, clinician)
    _settings(db, clinician.practice_id, telehealth_modifier=telehealth_modifier)
    _staff(db, clinician.id, claim_modifier=claim_modifier)
    fields: dict[str, Any] = {"location_type": location_type}
    if location is not None:
        name, code, is_video = location
        if is_video:
            # Every practice starts with a video office; its code applies to video sessions.
            video_office = db.scalars(
                select(Location).where(
                    Location.practice_id == clinician.practice_id, Location.is_video
                )
            ).one()
            video_office.place_of_service = code
        else:
            office = Location(practice_id=clinician.practice_id, name=name, place_of_service=code)
            db.add(office)
            db.flush()
            fields["location_id"] = office.id
        db.commit()
    [participant] = attended_session(db, clinician, [client], **fields)

    [claim] = _create(api, clinician, [participant.id])

    [line] = _detail(api, clinician, claim["id"])["lines"]
    assert (claim["place_of_service"], line["place_of_service"]) == (pos, pos)
    assert line["modifiers"] == modifiers


def test_patient_who_is_not_the_subscriber(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    client = insured_client(
        db,
        clinician,
        payer,
        subscriber_relationship="19",
        subscriber_first_name="Morgan",
        subscriber_last_name="Rivera",
        subscriber_dob=date(1968, 2, 3),
        subscriber_sex="F",
        subscriber_address_line1="15 Oak Ave",
        subscriber_city="Portland",
        subscriber_state="or",
        subscriber_postal_code="97209",
        claim_filing_indicator="BL",
    )
    [participant] = attended_session(db, clinician, [client])

    [claim] = _create(api, clinician, [participant.id])

    document = _document(db, claim["id"])
    assert document.subscriber.name == PersonName(first="Morgan", last="Rivera")
    assert document.subscriber.patient_relationship == "19"
    assert document.subscriber.claim_filing_indicator == "BL"
    assert document.subscriber.address is not None
    assert document.subscriber.address.state == "OR"
    assert document.patient is not None
    assert document.patient.name == PersonName(first="Alex", last="Rivera")
    assert document.patient.birth_date == date(1990, 4, 12)
    assert _detail(api, clinician, claim["id"])["issues"] == []

    db.get_one(Client, client.id).date_of_birth = None
    db.commit()
    issues = _detail(api, clinician, claim["id"])["issues"]
    assert [(i["code"], i["field"]) for i in issues] == [("birth_date_missing", "patient")]


def test_claims_split_at_six_dates_of_service(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    _, client = _ready(db, clinician)
    participants = [
        participant
        for days_ago in range(20, 13, -1)
        for participant in attended_session(db, clinician, [client], days_ago=days_ago)
    ]
    # A second session on the earliest date: still one date of service.
    second = create_appointment(
        db,
        clinician,
        [client],
        starts_at=session_at(20, hour=19),
        status="attended",
        service_code="90834",
    )
    participants.append(second.participants[0])

    first, rest = _create(api, clinician, [p.id for p in participants])

    assert (first["patient_control_number"], rest["patient_control_number"]) == (
        "SYN00DX1",
        "SYN00DX2",
    )
    first_lines = _detail(api, clinician, first["id"])["lines"]
    assert len(first_lines) == 7
    assert len({line["service_date"] for line in first_lines}) == 6
    assert [line["line_control_number"] for line in first_lines][:2] == [
        "SYN00DX1-1",
        "SYN00DX1-2",
    ]
    assert first["total_charge_cents"] == 7 * 15000
    [last_line] = _detail(api, clinician, rest["id"])["lines"]
    assert last_line["service_date"] == session_at(14).date().isoformat()


def test_prior_authorization_for_the_dates_of_service(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    _, client = _ready(db, clinician)
    policy = client.insurance_policies[0]
    db.add(
        PriorAuthorization(
            policy_id=policy.id,
            number="PA-12345",
            start_date=session_at(10).date(),
            end_date=session_at(1).date(),
            visits_authorized=12,
        )
    )
    db.commit()
    [authorized] = attended_session(db, clinician, [client], days_ago=3)
    [before] = attended_session(db, clinician, [client], days_ago=30)

    claims = _create(api, clinician, [authorized.id, before.id])

    by_number = {claim["prior_authorization_number"]: claim for claim in claims}
    assert set(by_number) == {"PA-12345", ""}
    assert by_number["PA-12345"]["first_service_date"] == session_at(3).date().isoformat()
    document = _document(db, by_number["PA-12345"]["id"])
    assert document.claim.prior_authorization_number == "PA-12345"


# Validation --------------------------------------------------------------------------------


def test_validation_issues_point_to_the_records(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    configure_practice(db, clinician, address_line1="")
    _staff(db, clinician.id, npi="")
    payer = add_payer(db, clinician.practice_id, external_id="")
    client = insured_client(db, clinician, payer, member_id="")
    [participant] = attended_session(db, clinician, [client])
    [claim] = _create(api, clinician, [participant.id])

    issues = _detail(api, clinician, claim["id"])["issues"]
    assert {(i["code"], i["field"]) for i in issues} == {
        ("npi_missing", "billing_provider.npi"),
        ("address_missing", "billing_provider.address.line1"),
        ("payer_id_missing", "payer.payer_id"),
        ("member_id_missing", "subscriber.member_id"),
    }
    assert "Jordan Lee's NPI" in next(i["message"] for i in issues if i["code"] == "npi_missing")
    validated = api.post(f"/api/claims/{claim['id']}/validate", headers=clinician.headers)
    assert validated.json()["issues"] == issues

    rejected = _submit(api, clinician, [claim["id"]], "paper")
    assert rejected.status_code == 422
    detail = rejected.json()["detail"]
    assert detail["message"] == "Fix these claims before submitting them."
    [problem] = detail["claims"]
    assert problem["claim_id"] == claim["id"]
    # Paper claims don't need an electronic payer ID.
    assert "payer_id_missing" not in {i["code"] for i in problem["issues"]}
    assert _detail(api, clinician, claim["id"])["status"] == "draft"


def test_paper_claims_skip_the_payer_id(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id, external_id="")
    client = insured_client(db, clinician, payer)
    [participant] = attended_session(db, clinician, [client])
    [claim] = _create(api, clinician, [participant.id])
    _settings(db, clinician.practice_id, **X12_IDS)

    assert _submit(api, clinician, [claim["id"]], "x12_file").status_code == 422
    printed = _submit(api, clinician, [claim["id"]], "paper")

    assert printed.status_code == 200, printed.text
    assert printed.headers["content-type"] == "application/pdf"
    assert printed.content.startswith(b"%PDF")
    detail = _detail(api, clinician, claim["id"])
    assert (detail["status"], detail["submission_method"]) == ("submitted", "paper")
    assert detail["submitted_at"] is not None


def test_sessions_no_longer_attended_are_flagged(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    claim, _ = _one_claim(api, db, clinician)
    participant = db.scalars(select(AppointmentParticipant)).one()
    participant.attendance = "no_show"
    db.commit()

    issues = _detail(api, clinician, claim["id"])["issues"]

    assert [(i["code"], i["field"]) for i in issues] == [("session_not_billable", "claim.lines[0]")]


# The unbilled queue ------------------------------------------------------------------------


def test_unbilled_queue_and_filters(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    configure_practice(db, clinician)
    evergreen = add_payer(db, clinician.practice_id)
    cascade = add_payer(db, clinician.practice_id, "Cascade Mutual", "CSCDM")
    colleague = add_staff(db, clinician.practice_id, "casey@example.com", StaffRole.CLINICIAN)
    alex = insured_client(db, clinician, evergreen)
    blake = insured_client(db, colleague, cascade, email="blake@example.com")
    self_pay = create_client_record(db, clinician, email="sam@example.com")
    no_policy = create_client_record(
        db, clinician, email="noa@example.com", billing_type="insurance"
    )
    partner = create_client_record(db, clinician, email="partner@example.com")

    [alex_session] = attended_session(db, clinician, [alex], days_ago=3)
    attended_session(db, clinician, [alex], days_ago=4, status="no_show")
    [blake_session] = attended_session(db, colleague, [blake], days_ago=10)
    attended_session(db, clinician, [self_pay], days_ago=3)
    attended_session(db, clinician, [no_policy], days_ago=3)
    couple = attended_session(db, clinician, [alex, partner], days_ago=5)
    couple[1].billable = False
    couple[1].fee_cents = 0
    [claimed] = attended_session(db, clinician, [alex], days_ago=6)
    db.add(
        Note(
            practice_id=clinician.practice_id,
            author_id=clinician.id,
            client_id=alex.id,
            appointment_id=alex_session.appointment_id,
            status=NoteStatus.SIGNED,
        )
    )
    db.commit()
    _create(api, clinician, [claimed.id])

    def queue(**params: Any) -> list[int]:
        response = api.get("/api/claims/unbilled", params=params, headers=clinician.headers)
        assert response.status_code == 200, response.text
        return [row["participant_id"] for row in response.json()]

    # By client (both are Alex Rivera, so the older client first), then oldest session first.
    everything = api.get("/api/claims/unbilled", headers=clinician.headers).json()
    assert [row["participant_id"] for row in everything] == [
        couple[0].id,
        alex_session.id,
        blake_session.id,
    ]
    second = api.get(
        "/api/claims/unbilled", params={"limit": 1, "offset": 1}, headers=clinician.headers
    )
    assert [row["participant_id"] for row in second.json()] == [alex_session.id]
    assert second.headers["x-total-count"] == "3"
    by_id = {row["participant_id"]: row for row in everything}
    assert by_id[alex_session.id]["note_signed"] is True
    assert by_id[blake_session.id]["note_signed"] is False
    assert by_id[blake_session.id]["payer_name"] == "Cascade Mutual"
    assert by_id[blake_session.id]["clinician_name"] == "Sam Patel"
    assert queue(clinician_id=colleague.id) == [blake_session.id]
    assert queue(payer_id=cascade.id) == [blake_session.id]
    assert queue(client_id=alex.id) == [couple[0].id, alex_session.id]
    four_days_ago = session_at(4).date().isoformat()
    assert queue(start=four_days_ago) == [alex_session.id]
    assert queue(end=four_days_ago) == [couple[0].id, blake_session.id]


def test_voiding_a_draft_returns_its_sessions_to_the_queue(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    claim, _ = _one_claim(api, db, clinician)
    assert api.get("/api/claims/unbilled", headers=clinician.headers).json() == []

    voided = api.post(f"/api/claims/{claim['id']}/void", headers=clinician.headers)

    assert voided.status_code == 200, voided.text
    assert voided.json()["status"] == "void"
    assert len(api.get("/api/claims/unbilled", headers=clinician.headers).json()) == 1
    again = api.post(f"/api/claims/{claim['id']}/void", headers=clinician.headers)
    assert again.status_code == 409


# Creating and editing ----------------------------------------------------------------------


def test_create_rejects_sessions_that_cannot_be_claimed(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    payer, alex = _ready(db, clinician)
    blake = insured_client(db, clinician, payer, email="blake@example.com")
    no_primary = create_client_record(
        db, clinician, email="noa@example.com", billing_type="insurance"
    )
    [alex_session] = attended_session(db, clinician, [alex])
    [blake_session] = attended_session(db, clinician, [blake])
    [missed] = attended_session(db, clinician, [alex], days_ago=5, status="no_show")
    [uninsured] = attended_session(db, clinician, [no_primary])
    other = register_practice(api, "other@example.com")
    other_client = create_client_record(db, other)
    [elsewhere] = attended_session(db, other, [other_client])

    def create(participant_ids: list[int], **body: Any) -> httpx.Response:
        return api.post(
            "/api/claims",
            json={"participant_ids": participant_ids, **body},
            headers=clinician.headers,
        )

    assert create([alex_session.id, blake_session.id]).status_code == 422
    assert create([missed.id]).status_code == 409
    assert create([elsewhere.id]).status_code == 404
    assert create([uninsured.id]).status_code == 422
    assert create([alex_session.id], policy_id=blake.insurance_policies[0].id).status_code == 404
    assert create([alex_session.id]).status_code == 201
    assert create([alex_session.id]).status_code == 409


def test_edit_a_draft_claim(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)
    [line] = _detail(api, clinician, claim["id"])["lines"]
    supervisor = add_staff(
        db, clinician.practice_id, "lee@example.com", StaffRole.CLINICIAN, first_name="Lee"
    )
    scheduler = add_staff(db, clinician.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    url = f"/api/claims/{claim['id']}"

    edited = api.patch(
        url,
        json={
            "diagnosis_codes": ["F33.1", "f41.1", "Z63.0"],
            "place_of_service": "02",
            "prior_authorization_number": " PA9 ",
            "supervising_clinician_id": supervisor.id,
            "lines": [
                {
                    "id": line["id"],
                    "diagnosis_pointers": [3, 1],
                    "modifiers": ["95", "ho"],
                    "units": 2,
                    "place_of_service": "02",
                }
            ],
        },
        headers=clinician.headers,
    )

    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert body["diagnosis_codes"] == ["F331", "F411", "Z630"]
    assert body["diagnoses"][1] == {"code": "F411", "description": "Generalized anxiety disorder"}
    assert (body["place_of_service"], body["prior_authorization_number"]) == ("02", "PA9")
    assert body["supervising_clinician_name"] == "Lee Patel"
    [edited_line] = body["lines"]
    assert edited_line["diagnosis_pointers"] == [3, 1]
    assert edited_line["modifiers"] == ["95", "HO"]
    assert edited_line["units"] == 2
    assert body["events"][-1]["kind"] == "updated"

    fewer = api.patch(url, json={"diagnosis_codes": ["F43.23"]}, headers=clinician.headers)
    assert fewer.json()["lines"][0]["diagnosis_pointers"] == [1]
    cleared = api.patch(url, json={"supervising_clinician_id": None}, headers=clinician.headers)
    assert cleared.json()["supervising_clinician_id"] is None

    for bad, expected in [
        ({"diagnosis_codes": ["hello"]}, 422),
        ({"diagnosis_codes": ["F41.1", "F411"]}, 422),
        ({"rendering_clinician_id": scheduler.id}, 422),
        ({"rendering_clinician_id": None}, 422),
        ({"lines": [{"id": 999_999, "units": 1}]}, 404),
        ({"lines": [{"id": line["id"], "units": None}]}, 422),
    ]:
        assert api.patch(url, json=bad, headers=clinician.headers).status_code == expected, bad

    assert _submit(api, clinician, [claim["id"]], "paper").status_code == 200
    locked = api.patch(url, json={"place_of_service": "11"}, headers=clinician.headers)
    assert locked.status_code == 409


def test_claim_list_filters(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    payer, alex = _ready(db, clinician)
    blake = insured_client(db, clinician, payer, email="blake@example.com")
    [alex_session] = attended_session(db, clinician, [alex], days_ago=3)
    [blake_session] = attended_session(db, clinician, [blake], days_ago=12)
    [alex_claim] = _create(api, clinician, [alex_session.id])
    [blake_claim] = _create(api, clinician, [blake_session.id])
    _submit(api, clinician, [blake_claim["id"]], "paper")

    def ids(**params: Any) -> list[int]:
        response = api.get("/api/claims", params=params, headers=clinician.headers)
        assert response.status_code == 200, response.text
        return [claim["id"] for claim in response.json()]

    assert ids() == [blake_claim["id"], alex_claim["id"]]
    assert ids(status="draft") == [alex_claim["id"]]
    assert ids(client_id=blake.id) == [blake_claim["id"]]
    assert ids(payer_id=payer.id, clinician_id=clinician.id) == [
        blake_claim["id"],
        alex_claim["id"],
    ]
    assert ids(start=session_at(5).date().isoformat()) == [alex_claim["id"]]
    assert ids(end=session_at(5).date().isoformat()) == [blake_claim["id"]]
    assert ids(limit=1, offset=1) == [alex_claim["id"]]
    paged = api.get("/api/claims", params={"limit": 1}, headers=clinician.headers)
    assert paged.headers["x-total-count"] == "2"


def test_claims_summary_totals_by_status(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    payer, alex = _ready(db, clinician)
    blake = insured_client(db, clinician, payer, email="blake@example.com")
    sessions = [
        attended_session(db, clinician, [client], days_ago=days)[0]
        for client, days in ((alex, 3), (alex, 4), (blake, 12))
    ]
    claims = [_create(api, clinician, [session.id])[0] for session in sessions]
    _submit(api, clinician, [claims[2]["id"]], "paper")
    api.post(f"/api/claims/{claims[1]['id']}/void", headers=clinician.headers)

    def summary(**params: Any) -> dict[str, dict[str, int]]:
        response = api.get("/api/claims/summary", params=params, headers=clinician.headers)
        assert response.status_code == 200, response.text
        return {row.pop("status"): row for row in response.json()}

    charge = claims[0]["total_charge_cents"]
    open_totals = {
        "claims": 1,
        "charged_cents": charge,
        "paid_cents": 0,
        "patient_responsibility_cents": 0,
        "insurance_balance_cents": charge,
    }
    assert summary() == {
        "draft": open_totals,
        "submitted": open_totals,
        "void": {**open_totals, "insurance_balance_cents": 0},
    }
    assert summary(client_id=blake.id) == {"submitted": open_totals}
    assert summary(end=session_at(5).date().isoformat()) == {"submitted": open_totals}
    biller = add_staff(db, clinician.practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, clinician.practice_id, "sched@example.com", StaffRole.SCHEDULER)
    assert api.get("/api/claims/summary", headers=biller.headers).status_code == 200
    assert api.get("/api/claims/summary", headers=scheduler.headers).status_code == 403


# Submission --------------------------------------------------------------------------------


def test_electronic_submission_through_stedi(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    claim, _ = _one_claim(api, db, clinician)
    assert _submit(api, clinician, [claim["id"]], "stedi").status_code == 409
    requests = use_stedi(monkeypatch, lambda _: httpx.Response(200, json=STEDI_ACCEPTED))

    queued = _submit(api, clinician, [claim["id"]], "stedi")

    assert queued.status_code == 200, queued.text
    assert [c["status"] for c in queued.json()] == ["queued"]
    assert requests == []
    submit_queued_claims(db, utcnow())

    [request] = requests
    body = json_body(request)
    assert body["usageIndicator"] == "T"
    assert body["tradingPartnerServiceId"] == "EVRGN"
    assert body["claimInformation"]["patientControlNumber"] == "SYN00DX1"
    detail = _detail(api, clinician, claim["id"])
    assert detail["status"] == "submitted"
    assert detail["submission_method"] == "stedi"
    assert detail["clearinghouse_ref"] == "01KHC8Y4HNP0GVQ5NSVTPZBC0F"
    assert [event["kind"] for event in detail["events"]] == ["created", "queued", "submitted"]
    db.expire_all()
    snapshot = db.get_one(Claim, claim["id"]).snapshot
    assert snapshot is not None
    assert snapshot["claim"]["patient_control_number"] == "SYN00DX1"
    submit_queued_claims(db, utcnow())
    assert len(requests) == 1


def test_stedi_rejection_and_temporary_failure(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, client = _ready(db, clinician)
    [first] = attended_session(db, clinician, [client], days_ago=3)
    [second] = attended_session(db, clinician, [client], days_ago=10)
    [claim] = _create(api, clinician, [first.id])
    [later] = _create(api, clinician, [second.id])
    rejection = {
        "status": "ERROR",
        "errors": [{"code": "33", "description": "Subscriber member ID is invalid."}],
    }
    answers = iter([httpx.Response(400, json=rejection), httpx.Response(503, json={})])
    use_stedi(monkeypatch, lambda _: next(answers))
    assert _submit(api, clinician, [claim["id"], later["id"]], "stedi").status_code == 200

    submit_queued_claims(db, utcnow())

    rejected = _detail(api, clinician, claim["id"])
    assert rejected["status"] == "rejected"
    assert rejected["last_error"] == "Subscriber member ID is invalid."
    assert rejected["events"][-1]["kind"] == "rejected"
    [notification] = db.scalars(select(Notification)).all()
    assert (notification.recipient_id, notification.kind) == (clinician.id, "claim_rejected")
    assert notification.link == f"/portal/billing/claims/{claim['id']}"
    assert "Alex R." in notification.body
    waiting = _detail(api, clinician, later["id"])
    assert waiting["status"] == "queued"
    assert "Try again later" in waiting["last_error"]
    # Rejected claims are fixed and submitted again.
    assert _submit(api, clinician, [claim["id"]], "stedi").json()[0]["status"] == "queued"


def test_837p_file_export(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)
    no_ids = _submit(api, clinician, [claim["id"]], "x12_file")
    assert no_ids.status_code == 409
    assert api.patch("/api/insurance/settings", json=X12_IDS, headers=clinician.headers).is_success

    exported = _submit(api, clinician, [claim["id"]], "x12_file")

    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith("application/edi-x12")
    assert 'filename="claims-837p-000000001.txt"' in exported.headers["content-disposition"]
    text = exported.text
    [isa] = _segments(text, "ISA")
    assert (isa.get(6).strip(), isa.get(8).strip(), isa.get(13)) == (
        "LEE01",
        "CLEARHOUSE",
        "000000001",
    )
    assert _segments(text, "ST")[0].get(1) == "837"
    [billing_name] = [s for s in _segments(text, "NM1") if s.get(1) == "85"]
    assert (billing_name.get(3), billing_name.get(9)) == ("LEE", CLINICIAN_NPI)
    [clm] = _segments(text, "CLM")
    assert (clm.get(1), clm.get(2), clm.components(5)) == ("SYN00DX1", "150", ["11", "B", "1"])
    [hi] = _segments(text, "HI")
    assert hi.elements == ("ABK:F411", "ABF:F331")
    [sv1] = _segments(text, "SV1")
    assert sv1.components(1) == ["HC", "90837"]
    assert [s.get(2) for s in _segments(text, "REF") if s.get(1) == "6R"] == ["SYN00DX1-1"]
    [se] = _segments(text, "SE")
    segments = [s.tag for s in tokenize(text)]
    assert int(se.get(1)) == segments.index("SE") - segments.index("ST") + 1

    detail = _detail(api, clinician, claim["id"])
    assert (detail["status"], detail["submission_method"]) == ("submitted", "x12_file")
    assert detail["clearinghouse_ref"] == "1"
    assert _submit(api, clinician, [claim["id"]], "x12_file").status_code == 409


def test_cms1500_download(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)

    response = api.get(f"/api/claims/{claim['id']}/cms1500.pdf", headers=clinician.headers)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")
    assert "cms1500-SYN00DX1.pdf" in response.headers["content-disposition"]
    assert _detail(api, clinician, claim["id"])["status"] == "draft"


# Corrections, voids and secondary claims ---------------------------------------------------


def test_correct_a_submitted_claim(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)
    url = f"/api/claims/{claim['id']}/correct"
    assert api.post(url, headers=clinician.headers).status_code == 409
    _submit(api, clinician, [claim["id"]], "paper")
    original = db.get_one(Claim, claim["id"])
    original.payer_claim_number = "EVG20260915001"
    db.commit()

    corrected = api.post(url, headers=clinician.headers)

    assert corrected.status_code == 201, corrected.text
    replacement = corrected.json()
    assert replacement["status"] == "draft"
    assert replacement["frequency_code"] == "7"
    assert replacement["original_claim_id"] == claim["id"]
    assert replacement["payer_claim_number"] == "EVG20260915001"
    assert replacement["patient_control_number"] == "SYN00DX2"
    assert replacement["lines"][0]["line_control_number"] == "SYN00DX2-1"
    assert replacement["issues"] == []
    assert _detail(api, clinician, claim["id"])["events"][-1]["kind"] == "corrected"
    assert api.post(url, headers=clinician.headers).status_code == 409

    _settings(db, clinician.practice_id, **X12_IDS)
    exported = _submit(api, clinician, [replacement["id"]], "x12_file")
    [clm] = _segments(exported.text, "CLM")
    assert clm.components(5) == ["11", "B", "7"]
    assert [s.get(2) for s in _segments(exported.text, "REF") if s.get(1) == "F8"] == [
        "EVG20260915001"
    ]


def test_void_a_submitted_claim(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    claim, _ = _one_claim(api, db, clinician)
    _submit(api, clinician, [claim["id"]], "paper")
    db.get_one(Claim, claim["id"]).payer_claim_number = "EVG1"
    db.commit()

    voided = api.post(f"/api/claims/{claim['id']}/void", headers=clinician.headers)

    assert voided.status_code == 200, voided.text
    void_claim = voided.json()
    assert (void_claim["frequency_code"], void_claim["status"]) == ("8", "draft")
    assert void_claim["original_claim_id"] == claim["id"]
    assert void_claim["issues"] == []
    original = _detail(api, clinician, claim["id"])
    assert original["status"] == "submitted"
    assert original["events"][-1]["kind"] == "void_requested"
    assert api.post(f"/api/claims/{claim['id']}/void", headers=clinician.headers).status_code == 409
    # The session stays billed while the payer processes the void.
    assert api.get("/api/claims/unbilled", headers=clinician.headers).json() == []


def test_secondary_claim_carries_the_primary_payment(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    claim, client = _one_claim(api, db, clinician)
    url = f"/api/claims/{claim['id']}/secondary"
    assert api.post(url, headers=clinician.headers).status_code == 409
    primary = _mark_paid(db, claim["id"])
    assert (primary.status, primary.paid_cents) == ("paid", 9000)
    assert api.post(url, headers=clinician.headers).status_code == 422
    cascade = add_payer(db, clinician.practice_id, "Cascade Mutual", "CSCDM")
    add_policy(db, client, cascade, rank="secondary", member_id="CM7788", group_number="")

    created = api.post(url, headers=clinician.headers)

    assert created.status_code == 201, created.text
    secondary = created.json()
    assert secondary["payer_responsibility"] == "S"
    assert secondary["primary_claim_id"] == claim["id"]
    assert secondary["payer_name"] == "Cascade Mutual"
    assert secondary["issues"] == []
    document = _document(db, secondary["id"])
    assert document.subscriber.payer_responsibility == "S"
    other = document.claim.other_payer
    assert other is not None
    assert (other.payer.payer_id, other.paid_cents) == ("EVRGN", 9000)
    assert other.payer_claim_number == "EVG20260915001"
    [adjudication] = other.line_adjudications
    assert adjudication.line_control_number == secondary["lines"][0]["line_control_number"]
    assert adjudication.adjustments == (Adjustment("CO", "45", 4000), Adjustment("PR", "2", 2000))
    assert api.post(url, headers=clinician.headers).status_code == 409


# Access ------------------------------------------------------------------------------------


def test_access_to_claims(api: TestClient, db: Session, clinician: StaffAccount) -> None:
    configure_practice(db, clinician)
    payer = add_payer(db, clinician.practice_id)
    practice_id = clinician.practice_id
    basic = add_staff(db, practice_id, "basic@example.com", StaffRole.CLINICIAN)
    billing_clinician = add_staff(
        db,
        practice_id,
        "billing@example.com",
        StaffRole.CLINICIAN,
        clinician_access=ClinicianAccess.BILLING,
    )
    biller = add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER)
    theirs = insured_client(db, billing_clinician, payer, email="theirs@example.com")
    mine = insured_client(db, clinician, payer)
    assign_clinician(db, mine, basic)
    [their_session] = attended_session(db, billing_clinician, [theirs])
    [my_session] = attended_session(db, clinician, [mine])
    [my_claim] = _create(api, clinician, [my_session.id])
    other = register_practice(api, "other@example.com")

    def unbilled(staff: StaffAccount) -> list[int] | int:
        response = api.get("/api/claims/unbilled", headers=staff.headers)
        if response.status_code != 200:
            return response.status_code
        return [row["participant_id"] for row in response.json()]

    assert unbilled(clinician) == [their_session.id]
    assert unbilled(biller) == [their_session.id]
    assert unbilled(billing_clinician) == [their_session.id]
    assert unbilled(basic) == 403
    assert unbilled(scheduler) == 403

    claim_url = f"/api/claims/{my_claim['id']}"
    for staff, expected in [
        (clinician, 200),
        (biller, 200),
        (billing_clinician, 404),
        (basic, 404),
        (scheduler, 404),
        (other, 404),
    ]:
        assert api.get(claim_url, headers=staff.headers).status_code == expected
    assert api.get("/api/claims", headers=basic.headers).status_code == 403
    assert api.get("/api/claims", headers=other.headers).json() == []
    assert [c["id"] for c in api.get("/api/claims", headers=biller.headers).json()] == [
        my_claim["id"]
    ]
    assert api.get("/api/claims", headers=billing_clinician.headers).json() == []
    # A billing clinician can bill their own clients but not someone else's.
    own = api.post(
        "/api/claims",
        json={"participant_ids": [their_session.id]},
        headers=billing_clinician.headers,
    )
    assert own.status_code == 201, own.text
    [second_session] = attended_session(db, clinician, [mine], days_ago=8)
    not_theirs = api.post(
        "/api/claims",
        json={"participant_ids": [second_session.id]},
        headers=billing_clinician.headers,
    )
    assert not_theirs.status_code == 404
    assert _submit(api, basic, [my_claim["id"]], "paper").status_code == 403
    assert _submit(api, biller, [my_claim["id"]], "paper").status_code == 200


def test_claim_changes_reach_billing_staff_only(
    api: TestClient, db: Session, clinician: StaffAccount, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, client = _ready(db, clinician)
    practice_id = clinician.practice_id
    basic = add_staff(db, practice_id, "basic@example.com", StaffRole.CLINICIAN)
    biller = add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, practice_id, "sched@example.com", StaffRole.SCHEDULER)
    assign_clinician(db, client, basic)
    [participant] = attended_session(db, clinician, [client])
    events: list[tuple[list[Recipient], str, dict[str, Any]]] = []
    monkeypatch.setattr(
        claims_service,
        "publish",
        lambda _db, recipients, event_type, data: events.append(
            (list(recipients), event_type, data)
        ),
    )

    [claim] = _create(api, biller, [participant.id])

    [(recipients, event_type, data)] = events
    assert (event_type, data) == (
        "claims.changed",
        {"claim_ids": [claim["id"]], "client_id": client.id},
    )
    assert sorted(recipients) == sorted([(Role.STAFF, clinician.id), (Role.STAFF, biller.id)])
    assert (Role.STAFF, basic.id) not in recipients
    assert (Role.STAFF, scheduler.id) not in recipients


def test_claims_of_past_sessions_use_the_practice_date(
    api: TestClient, db: Session, clinician: StaffAccount
) -> None:
    """A session late in the evening in New York is dated by the practice's calendar day."""
    _, client = _ready(db, clinician)
    day = utcnow().date() - timedelta(days=4)
    late_evening = session_at(3, hour=2)  # 10 pm the day before in New York
    [participant] = create_appointment(
        db, clinician, [client], starts_at=late_evening, status="attended", service_code="90834"
    ).participants

    [claim] = _create(api, clinician, [participant.id])

    assert claim["first_service_date"] == day.isoformat()
