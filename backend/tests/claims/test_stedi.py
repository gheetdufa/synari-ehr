"""Stedi client: request shapes, response parsing and error handling, over httpx.MockTransport."""

import json
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from synari.claims.document import PersonName
from synari.claims.responses import ClaimAcknowledgment
from synari.claims.stedi import (
    ClearinghouseError,
    EligibilityRequest,
    EligibilityResult,
    PayerMatch,
    StediClient,
    SubmissionResult,
    acknowledgments_from_277,
    claim_request,
    remittances_from_835,
)
from synari.claims.x12_parse import parse_277ca, parse_835
from tests.claims.samples import (
    GROUP_PRACTICE,
    corrected_claim,
    group_claim,
    individual_claim,
    secondary_claim,
)

FIXTURES = Path(__file__).parent / "fixtures"
STEDI_277 = json.loads((FIXTURES / "stedi_277.json").read_text())
STEDI_835 = json.loads((FIXTURES / "stedi_835.json").read_text())
STEDI_ELIGIBILITY = json.loads((FIXTURES / "stedi_eligibility.json").read_text())

Handler = Callable[[httpx.Request], httpx.Response]


def _stedi(handler: Handler) -> StediClient:
    return StediClient("test-key", client=httpx.Client(transport=httpx.MockTransport(handler)))


def _recording(response: httpx.Response) -> tuple[StediClient, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return response

    return _stedi(handler), requests


def _body(request: httpx.Request) -> dict[str, Any]:
    return json.loads(request.content)


CLAIM_ACCEPTED = {
    "status": "SUCCESS",
    "controlNumber": "1",
    "tradingPartnerServiceId": "EVRGN",
    "claimReference": {
        "correlationId": "01KHC8Y4HNP0GVQ5NSVTPZBC0F",
        "patientControlNumber": "C1001",
        "timeOfResponse": "2026-09-20T14:05:00.000Z",
        "payerId": "EVRGN",
        "formatVersion": "5010",
        "rhclaimNumber": "01KHC8Y4HNP0GVQ5NSVTPZBC0F",
        "serviceLines": [{"lineItemControlNumber": "C1001-1"}],
    },
    "payer": {"payerName": "Evergreen Health Plan", "payerId": "EVRGN"},
    "httpStatusCode": "200 OK",
}


# Claim submission -----------------------------------------------------------------------


def test_submit_claim_sends_the_837p_json() -> None:
    stedi, requests = _recording(httpx.Response(200, json=CLAIM_ACCEPTED))
    result = stedi.submit_claim(individual_claim(), usage="T")

    assert result == SubmissionResult(
        accepted=True,
        patient_control_number="C1001",
        correlation_id="01KHC8Y4HNP0GVQ5NSVTPZBC0F",
    )
    [request] = requests
    assert request.method == "POST"
    assert str(request.url) == (
        "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/"
        "professionalclaims/v3/submission"
    )
    assert request.headers["Authorization"] == "test-key"
    assert len(request.headers["Idempotency-Key"]) == 64
    assert _body(request) == {
        "tradingPartnerServiceId": "EVRGN",
        "tradingPartnerName": "Evergreen Health Plan",
        "usageIndicator": "T",
        "submitter": {
            "organizationName": "Ana Rivera",
            "contactInformation": {"name": "Ana Rivera", "phoneNumber": "5035550111"},
        },
        "receiver": {"organizationName": "Evergreen Health Plan"},
        "subscriber": {
            "memberId": "EVG123456789",
            "paymentResponsibilityLevelCode": "P",
            "firstName": "Jordan",
            "lastName": "Lee",
            "gender": "F",
            "dateOfBirth": "19900412",
            "groupNumber": "GRP100",
            "address": {
                "address1": "15 Oak Ave",
                "city": "Portland",
                "state": "OR",
                "postalCode": "972091234",
            },
        },
        "billing": {
            "npi": "1234567893",
            "taxonomyCode": "1041C0700X",
            "ssn": "234567891",
            "firstName": "Ana",
            "lastName": "Rivera",
            "address": {
                "address1": "200 Main St",
                "address2": "Suite 4",
                "city": "Portland",
                "state": "OR",
                "postalCode": "972051234",
            },
            "contactInformation": {"name": "Ana Rivera", "phoneNumber": "5035550111"},
        },
        "claimInformation": {
            "claimFilingCode": "CI",
            "patientControlNumber": "C1001",
            "claimChargeAmount": "150",
            "placeOfServiceCode": "10",
            "claimFrequencyCode": "1",
            "signatureIndicator": "Y",
            "planParticipationCode": "A",
            "benefitsAssignmentCertificationIndicator": "Y",
            "releaseInformationCode": "Y",
            "healthCareCodeInformation": [
                {"diagnosisTypeCode": "ABK", "diagnosisCode": "F411"},
                {"diagnosisTypeCode": "ABF", "diagnosisCode": "F331"},
            ],
            "serviceLines": [
                {
                    "serviceDate": "20260915",
                    "providerControlNumber": "C1001-1",
                    "professionalService": {
                        "procedureIdentifier": "HC",
                        "procedureCode": "90837",
                        "procedureModifiers": ["95"],
                        "lineItemChargeAmount": "150",
                        "measurementUnit": "UN",
                        "serviceUnitCount": "1",
                        "compositeDiagnosisCodePointers": {"diagnosisCodePointers": ["1", "2"]},
                    },
                }
            ],
        },
    }


def test_group_claim_with_dependent_and_providers() -> None:
    body = claim_request(group_claim(), "P")
    assert body["usageIndicator"] == "P"
    assert body["billing"]["organizationName"] == "Maple Counseling Group"
    assert body["billing"]["employerId"] == "987654321"
    assert "dateOfBirth" not in body["subscriber"]
    assert body["subscriber"]["suffix"] == "Jr"
    assert body["subscriber"]["subscriberGroupName"] == "Evergreen Family PPO"
    assert body["dependent"] == {
        "firstName": "Riley",
        "lastName": "Smith",
        "gender": "M",
        "dateOfBirth": "20140603",
        "relationshipToSubscriberCode": "19",
        "address": {
            "address1": "88 Pine St",
            "city": "Bellevue",
            "state": "WA",
            "postalCode": "98004",
        },
    }
    assert body["rendering"] == {
        "firstName": "Sam",
        "lastName": "Patel",
        "npi": "1222222220",
        "taxonomyCode": "101YM0800X",
    }
    assert body["supervising"] == {
        "firstName": "Lee",
        "lastName": "Chen",
        "middleName": "A",
        "npi": "1333333338",
    }
    assert body["referring"]["npi"] == "1444444446"
    assert body["payToAddress"]["address1"] == "PO Box 1234"
    claim = body["claimInformation"]
    assert claim["claimSupplementalInformation"] == {"priorAuthorizationNumber": "PA12345"}
    assert claim["serviceFacilityLocation"] == {
        "organizationName": "Maple Counseling Bellevue",
        "npi": "1555555550",
        "address": {
            "address1": "12 Lake Way",
            "city": "Bellevue",
            "state": "WA",
            "postalCode": "980041002",
        },
    }
    first, second = claim["serviceLines"]
    assert "placeOfServiceCode" not in first["professionalService"]
    assert second["professionalService"]["placeOfServiceCode"] == "02"
    assert second["professionalService"]["procedureModifiers"] == ["95", "HO"]
    assert second["professionalService"]["lineItemChargeAmount"] == "140.5"
    assert second["professionalService"]["compositeDiagnosisCodePointers"] == {
        "diagnosisCodePointers": ["1", "3"]
    }


def test_corrected_claim_names_the_original() -> None:
    claim = claim_request(corrected_claim(), "P")["claimInformation"]
    assert claim["claimFrequencyCode"] == "7"
    assert claim["claimSupplementalInformation"] == {"claimControlNumber": "EVG20260915001"}


def test_secondary_claim_carries_the_primary_payers_adjudication() -> None:
    body = claim_request(secondary_claim(), "P")
    assert body["subscriber"]["paymentResponsibilityLevelCode"] == "S"
    assert body["payerAddress"]["address1"] == "PO Box 900"
    claim = body["claimInformation"]
    assert claim["otherSubscriberInformation"] == [
        {
            "paymentResponsibilityLevelCode": "P",
            "individualRelationshipCode": "18",
            "insuranceGroupOrPolicyNumber": "GRP100",
            "claimFilingIndicatorCode": "CI",
            "benefitsAssignmentCertificationIndicator": "Y",
            "releaseOfInformationCode": "Y",
            "payerPaidAmount": "90",
            "otherSubscriberName": {
                "otherInsuredQualifier": "1",
                "otherInsuredLastName": "Lee",
                "otherInsuredFirstName": "Jordan",
                "otherInsuredIdentifierTypeCode": "MI",
                "otherInsuredIdentifier": "EVG123456789",
            },
            "otherPayerName": {
                "otherPayerOrganizationName": "Evergreen Health Plan",
                "otherPayerIdentifierTypeCode": "PI",
                "otherPayerIdentifier": "EVRGN",
                "otherPayerClaimControlNumber": "EVG20260915001",
            },
        }
    ]
    assert claim["serviceLines"][0]["lineAdjudicationInformation"] == [
        {
            "otherPayerPrimaryIdentifier": "EVRGN",
            "serviceLinePaidAmount": "90",
            "serviceIdQualifier": "HC",
            "procedureCode": "90837",
            "procedureModifier": ["95"],
            "paidServiceUnitCount": "1",
            "adjudicationOrPaymentDate": "20260918",
            "claimAdjustmentInformation": [
                {
                    "adjustmentGroupCode": "CO",
                    "adjustmentDetails": [{"adjustmentReasonCode": "45", "adjustmentAmount": "30"}],
                },
                {
                    "adjustmentGroupCode": "PR",
                    "adjustmentDetails": [
                        {"adjustmentReasonCode": "2", "adjustmentAmount": "25"},
                        {"adjustmentReasonCode": "3", "adjustmentAmount": "5"},
                    ],
                },
            ],
        }
    ]


def test_claim_level_cob_sends_the_adjudication_date() -> None:
    document = secondary_claim()
    other = document.claim.other_payer
    assert other is not None
    claim_level = replace(
        other,
        line_adjudications=(),
        claim_adjustments=other.line_adjudications[0].adjustments,
    )
    body = claim_request(
        replace(document, claim=replace(document.claim, other_payer=claim_level)), "P"
    )
    [other_json] = body["claimInformation"]["otherSubscriberInformation"]
    assert other_json["otherPayerName"]["otherPayerAdjudicationOrPaymentDate"] == "20260918"
    assert [group["adjustmentGroupCode"] for group in other_json["claimLevelAdjustments"]] == [
        "CO",
        "PR",
    ]
    assert "lineAdjudicationInformation" not in body["claimInformation"]["serviceLines"][0]


def test_idempotency_key_follows_the_claim_body() -> None:
    stedi, requests = _recording(httpx.Response(200, json=CLAIM_ACCEPTED))
    stedi.submit_claim(individual_claim(), usage="T")
    stedi.submit_claim(individual_claim(), usage="T")
    stedi.submit_claim(corrected_claim(), usage="T")
    keys = [request.headers["Idempotency-Key"] for request in requests]
    assert keys[0] == keys[1] != keys[2]


def test_claim_rejected_by_stedi_edits() -> None:
    rejection = {
        "status": "ERROR",
        "controlNumber": "1",
        "tradingPartnerServiceId": "EVRGN",
        "errors": [
            {
                "code": "33",
                "description": "Total claim charge amount ($130.00) does not equal the sum of all "
                "service line charge amounts ($150.00) for this claim. Correct and resubmit.",
                "followupAction": "Please Correct and Resubmit",
            }
        ],
        "httpStatusCode": "400 BAD_REQUEST",
    }
    stedi, _ = _recording(httpx.Response(400, json=rejection))
    result = stedi.submit_claim(individual_claim(), usage="T")
    assert not result.accepted
    assert result.patient_control_number == "C1001"
    assert result.errors == (rejection["errors"][0]["description"],)


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (
            httpx.Response(403, json={"message": "Forbidden"}),
            "Stedi rejected the API key. Check that it is correct and matches test/live mode "
            "(HTTP 403): Forbidden",
        ),
        (
            httpx.Response(
                429,
                json={
                    "message": "The request can't be submitted because the sender's submission "
                    "has been throttled: CUSTOMER_LIMIT",
                    "code": "TOO_MANY_REQUESTS",
                },
            ),
            "Stedi is limiting requests right now. Try again in a minute (HTTP 429): The request "
            "can't be submitted because the sender's submission has been throttled: "
            "CUSTOMER_LIMIT",
        ),
        (
            httpx.Response(
                400,
                json={
                    "message": "Invalid request",
                    "fieldList": [
                        {"path": "claimInformation.claimChargeAmount", "message": "Bad format"}
                    ],
                },
            ),
            "Stedi couldn't accept the request (HTTP 400): Invalid request; "
            "claimInformation.claimChargeAmount: Bad format",
        ),
        (
            httpx.Response(502, text="<html>Bad gateway</html>"),
            "Stedi had a problem handling the request. Try again later (HTTP 502)",
        ),
    ],
)
def test_http_errors_become_clearinghouse_errors(response: httpx.Response, message: str) -> None:
    stedi, _ = _recording(response)
    with pytest.raises(ClearinghouseError) as caught:
        stedi.submit_claim(individual_claim(), usage="T")
    assert str(caught.value) == message
    assert caught.value.status_code == response.status_code


def test_network_failure_becomes_a_clearinghouse_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ClearinghouseError, match="Couldn't reach Stedi: connection refused"):
        _stedi(handler).search_payers("aetna")


# Claim responses ------------------------------------------------------------------------


def _poll_item(transaction_id: str, transaction_set: str, **changes: str) -> dict[str, Any]:
    return {
        "transactionId": transaction_id,
        "fileExecutionId": f"file-{transaction_id}",
        "status": "succeeded",
        "direction": "INBOUND",
        "mode": "test",
        "processedAt": "2026-09-20T15:00:28.354Z",
        "artifacts": [],
        "partnership": {"partnershipId": "stedi", "partnershipType": "x12"},
        "x12": {
            "metadata": {
                "transaction": {"controlNumber": "1", "transactionSetIdentifier": transaction_set}
            }
        },
        **changes,
    }


def test_list_new_reports_polls_pages_and_parses_reports() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(f"{request.url.host}{request.url.path}")
        if request.url.host == "core.us.stedi.com":
            if "pageToken" not in request.url.params:
                assert request.url.params["startDateTime"] == "2026-09-19T00:00:00Z"
                items = [
                    _poll_item("txn-837", "837", direction="OUTBOUND"),
                    _poll_item("txn-277", "277"),
                    _poll_item("txn-835", "835"),
                    _poll_item("txn-old", "835"),
                    _poll_item("txn-failed", "277", status="failed"),
                ]
                return httpx.Response(200, json={"items": items, "nextPageToken": "page-2"})
            assert request.url.params["pageToken"] == "page-2"
            return httpx.Response(200, json={"items": [], "nextPageToken": "page-3"})
        report = STEDI_277 if request.url.path.endswith("/277") else STEDI_835
        return httpx.Response(200, json=report)

    page = _stedi(handler).list_new_reports(
        since=datetime(2026, 9, 19, tzinfo=UTC), skip_transaction_ids={"txn-old"}
    )
    assert page.next_page_token == "page-3"
    assert requested == [
        "core.us.stedi.com/2023-08-01/polling/transactions",
        "healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/txn-277/277",
        "healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/txn-835/835",
        "core.us.stedi.com/2023-08-01/polling/transactions",
    ]
    acknowledgment_report, remittance_report = page.reports
    assert acknowledgment_report.transaction_id == "txn-277"
    assert acknowledgment_report.processed_at == datetime(2026, 9, 20, 15, 0, 28, 354000, UTC)
    assert [ack.accepted for ack in acknowledgment_report.acknowledgments] == [True, False]
    assert remittance_report.transaction_set == "835"
    assert remittance_report.remittances[0].payment_cents == 17650


def test_list_new_reports_resumes_from_a_page_token() -> None:
    stedi, requests = _recording(httpx.Response(200, json={"items": []}))
    page = stedi.list_new_reports(page_token="saved-token")
    assert page.reports == ()
    assert page.next_page_token == "saved-token"
    assert requests[0].url.params["pageToken"] == "saved-token"


def test_list_new_reports_needs_a_starting_point() -> None:
    stedi, _ = _recording(httpx.Response(200, json={"items": []}))
    with pytest.raises(ValueError, match="since or page_token"):
        stedi.list_new_reports()


def _without_descriptions(acknowledgments: list[ClaimAcknowledgment]) -> list[ClaimAcknowledgment]:
    return [
        replace(ack, statuses=tuple(replace(status, description="") for status in ack.statuses))
        for ack in acknowledgments
    ]


def test_json_reports_match_the_x12_parsers() -> None:
    """Both submission paths hand posting code identical dataclasses."""
    era = (FIXTURES / "835_era.x12").read_text()
    assert remittances_from_835(STEDI_835) == parse_835(era)[:1]
    acknowledgments = acknowledgments_from_277(STEDI_277)
    x12_acknowledgments = parse_277ca((FIXTURES / "277ca_mixed.x12").read_text())
    assert _without_descriptions(acknowledgments) == _without_descriptions(x12_acknowledgments)
    assert acknowledgments[0].statuses[0].description == "Accepted for processing."


# Eligibility and payer search -----------------------------------------------------------

DEPENDENT_CHECK = EligibilityRequest(
    payer_id="EVRGN",
    provider=GROUP_PRACTICE,
    member_id="EVG555000111",
    subscriber=PersonName(first="Morgan", last="Smith"),
    dependent=PersonName(first="Riley", last="Smith"),
    dependent_birth_date=date(2014, 6, 3),
    service_date=date(2026, 9, 20),
)


def test_check_eligibility_request_and_benefits() -> None:
    stedi, requests = _recording(httpx.Response(200, json=STEDI_ELIGIBILITY))
    result = stedi.check_eligibility(DEPENDENT_CHECK)

    [request] = requests
    assert str(request.url) == "https://healthcare.us.stedi.com/2026-06-01/eligibility-check"
    assert request.extensions["timeout"]["read"] == 125.0
    assert _body(request) == {
        "payerId": "EVRGN",
        "provider": {"name": {"organization": "Maple Counseling Group"}, "npi": "1111111112"},
        "subscriber": {
            "memberId": "EVG555000111",
            "name": {"person": {"firstName": "Morgan", "lastName": "Smith"}},
        },
        "dependent": {
            "name": {"person": {"firstName": "Riley", "lastName": "Smith"}},
            "dateOfBirth": "2014-06-03",
            "relationToSubscriber": "CHILD",
        },
        "encounter": {
            "services": [{"system": "STC", "value": "MH"}],
            "dates": {"service": {"start": "2026-09-20"}},
        },
    }
    assert result == EligibilityResult(
        check_id="ec_5f4a1c9e-0000-4000-8000-000000000001",
        active=True,
        plan_name="EVERGREEN FAMILY PPO",
        group_number="GRP100",
        coverage_start=date(2026, 2, 1),
        coverage_end=date(2026, 12, 31),
        in_network=True,
        copay_cents=2000,
        coinsurance_percent=Decimal("20"),
        deductible_cents=150000,
        deductible_remaining_cents=50000,
        out_of_pocket_cents=600000,
        out_of_pocket_remaining_cents=420075,
        prior_authorization_required=False,
        messages=("Telehealth visits use the office cost share",),
    )


def test_eligibility_uses_plan_wide_benefits_without_mental_health_entries() -> None:
    general = json.loads(json.dumps(STEDI_ELIGIBILITY))
    benefits = general["plans"][0]["benefits"]
    benefits["coPayment"] = [
        {
            "coverageLevel": "INDIVIDUAL",
            "amount": "30",
            "service": {"system": "STC", "value": "30"},
            "network": {"indicator": "IN_AND_OUT_OF_NETWORK"},
        }
    ]
    benefits["coInsurance"] = []
    benefits["statuses"] = [{"status": "INACTIVE", "coverageLevel": "FAMILY"}]
    stedi, _ = _recording(httpx.Response(200, json=general))
    result = stedi.check_eligibility(DEPENDENT_CHECK)
    assert (result.active, result.copay_cents, result.coinsurance_percent) == (False, 3000, None)
    assert result.in_network is None
    assert result.prior_authorization_required is None


def test_eligibility_payer_rejection_is_an_answer() -> None:
    rejection = {
        "id": "ec_5f4a1c9e-0000-4000-8000-000000000002",
        "payer": {"name": {"organization": "EVERGREEN HEALTH PLAN"}, "type": "PAYER"},
        "errors": [
            {
                "code": "75",
                "description": "Subscriber/Insured Not Found",
                "followupAction": "Please Correct and Resubmit",
                "location": "SUBSCRIBER",
            }
        ],
        "x12": "ISA*00*~",
    }
    stedi, _ = _recording(httpx.Response(400, json=rejection))
    result = stedi.check_eligibility(DEPENDENT_CHECK)
    assert not result.active
    assert result.errors == ("Subscriber/Insured Not Found — Please Correct and Resubmit",)


def test_eligibility_request_errors_raise() -> None:
    stedi, _ = _recording(
        httpx.Response(400, json={"message": "Payer NOTAPAYER is not configured."})
    )
    with pytest.raises(ClearinghouseError, match="Payer NOTAPAYER is not configured"):
        stedi.check_eligibility(replace(DEPENDENT_CHECK, payer_id="NOTAPAYER"))


def test_search_payers() -> None:
    response = {
        "items": [
            {
                "payer": {
                    "stediId": "EVRGN1",
                    "displayName": "Evergreen Health Plan",
                    "primaryPayerId": "EVRGN",
                    "aliases": ["EVG01", "99901"],
                    "names": ["Evergreen Health Plan"],
                    "programs": [],
                    "transactionSupport": {
                        "eligibilityCheck": "SUPPORTED",
                        "claimStatus": "SUPPORTED",
                        "professionalClaimSubmission": "SUPPORTED",
                        "claimPayment": "ENROLLMENT_REQUIRED",
                    },
                },
                "score": 42.5,
            }
        ],
        "stats": {"total": 1},
    }
    stedi, requests = _recording(httpx.Response(200, json=response))
    assert stedi.search_payers("evergreen", limit=5) == [
        PayerMatch(
            stedi_id="EVRGN1",
            name="Evergreen Health Plan",
            primary_payer_id="EVRGN",
            aliases=("EVG01", "99901"),
            professional_claims="SUPPORTED",
            eligibility="SUPPORTED",
            remittances="ENROLLMENT_REQUIRED",
        )
    ]
    [request] = requests
    assert request.url.path == "/2024-04-01/payers/search"
    assert dict(request.url.params) == {"query": "evergreen", "pageSize": "5"}
