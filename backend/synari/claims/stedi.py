"""Client for Stedi's Healthcare APIs: submit claims, collect responses, check eligibility.

Every request sends `Authorization: <api key>`. Endpoints used (Stedi docs, September 2026):

- Submit a claim: POST {base}/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission
  https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-claims
  Stedi calls this JSON endpoint "legacy" and recommends
  POST https://claims.us.stedi.com/2025-03-07/professional-claim-submissions for new
  integrations, but that endpoint can't send secondary or tertiary (coordination of benefits)
  claims. Stedi says the legacy endpoint is not being deprecated, so one mapping here covers
  every claim a `ClaimDocument` can describe.
- Find new claim responses: GET {core}/2023-08-01/polling/transactions
  https://www.stedi.com/docs/healthcare/api-reference/get-poll-transactions
  keeping succeeded INBOUND transactions whose X12 transaction set is 277 or 835.
- 277CA as JSON: GET {base}/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/277
  https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-277
- 835 ERA as JSON: GET {base}/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835
  https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835
- Eligibility (270/271): POST {base}/2026-06-01/eligibility-check, Stedi's recommended endpoint
  https://www.stedi.com/docs/healthcare/api-reference/post-eligibility-check
- Payer search: GET {base}/2024-04-01/payers/search
  https://www.stedi.com/docs/healthcare/api-reference/get-search-payers

Test mode: use a test API key and `usage="T"`. Claims sent to payer id "STEDI" (the Stedi Test
Payer) come back with a test 277CA and 835; eligibility test keys only accept Stedi's mock
requests.

Not verified from the docs, so kept minimal:
- The claim's onset date isn't sent: Stedi documents no date format for `claimDateInformation`.
- `otherPayerAdjudicationOrPaymentDate` (the earlier payer's claim-level processing date, only
  sent when it gave no line-level results) has no documented format; it is sent as YYYYMMDD
  like every documented date on the claims endpoint.
- The payer search page lists payers.us.stedi.com as its base URL while its examples and
  Stedi's OpenAPI file use healthcare.us.stedi.com; the latter is used here.
- Error bodies vary by endpoint (`message`, plus `code`, `errors` or `fieldList`); they are
  all folded into one readable `ClearinghouseError` message.
"""

import hashlib
import json
from collections.abc import Collection, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal

import httpx

from synari.claims.document import (
    Address,
    Adjustment,
    BillingProvider,
    ClaimDocument,
    ClaimLine,
    Contact,
    OtherPayer,
    PersonName,
    Provider,
)
from synari.claims.responses import (
    CATEGORY_DESCRIPTIONS,
    ClaimAcknowledgment,
    ClaimPayment,
    ClaimStatus,
    ProviderAdjustment,
    Remittance,
    ServicePayment,
)
from synari.claims.x12 import amount, cents, clean, digits, parse_date, units, x12_date

DEFAULT_BASE_URL = "https://healthcare.us.stedi.com"
DEFAULT_CORE_URL = "https://core.us.stedi.com"
TEST_PAYER_ID = "STEDI"

CLAIM_PATH = "/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission"
REPORT_PATH = "/2024-04-01/change/medicalnetwork/reports/v2/{transaction_id}/{report}"
POLLING_PATH = "/2023-08-01/polling/transactions"
ELIGIBILITY_PATH = "/2026-06-01/eligibility-check"
PAYER_SEARCH_PATH = "/2024-04-01/payers/search"

# Service type codes payers use for behavioral health benefits (X12 5010 list).
MENTAL_HEALTH_SERVICE_TYPES = frozenset(
    {"MH", "A4", "A6", "A7", "A8", "AI", "BD", "CE", "CF", "CG", "CH", "22"}
)
_TIMEOUT = 30.0
_ELIGIBILITY_TIMEOUT = 125.0  # Stedi holds eligibility requests open for up to 120 seconds.
_TOTAL_PERIODS = frozenset({"CALENDAR_YEAR", "SERVICE_YEAR", "YEARS", "CONTRACT", "LIFETIME"})
_NETWORK_PREFERENCE = {"IN_NETWORK": 0, "IN_AND_OUT_OF_NETWORK": 1, "OUT_OF_NETWORK": 3}
_DEPENDENT_RELATIONSHIPS = {"01": "SPOUSE", "19": "CHILD"}


class ClearinghouseError(Exception):
    """A request to the clearinghouse failed. The message says why in plain English."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class SubmissionResult:
    """Stedi's answer to a claim submission.

    `accepted` means the claim passed Stedi's edits and is on its way to the payer; the payer's
    own verdict arrives later as a 277CA. `correlation_id` is Stedi's id for the claim.
    """

    accepted: bool
    patient_control_number: str
    correlation_id: str = ""
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClaimReport:
    """One 277CA or 835 transaction Stedi received for us, already parsed."""

    transaction_id: str
    transaction_set: str
    processed_at: datetime | None
    acknowledgments: tuple[ClaimAcknowledgment, ...] = ()
    remittances: tuple[Remittance, ...] = ()


@dataclass(frozen=True)
class ReportPage:
    """New reports plus the page token to resume from next time (store it)."""

    reports: tuple[ClaimReport, ...]
    next_page_token: str


@dataclass(frozen=True)
class EligibilityRequest:
    """Who to check with which payer.

    Fill the `dependent_*` fields only when the client is covered as a dependent and has no
    member id of their own. `dependent_relationship` uses the claim codes (01 spouse,
    19 child; anything else is sent as "other adult"). `service_type_code` defaults to MH
    (mental health); Stedi suggests trying CF, A6, A8, A4, BD, 98 or 30 when a payer ignores it.
    """

    payer_id: str
    provider: BillingProvider
    member_id: str
    subscriber: PersonName
    subscriber_birth_date: date | None = None
    dependent: PersonName | None = None
    dependent_birth_date: date | None = None
    dependent_relationship: str = "19"
    service_date: date | None = None
    service_type_code: str = "MH"


@dataclass(frozen=True)
class EligibilityResult:
    """Coverage and behavioral-health cost sharing, as reported by the payer.

    Amounts come from mental-health benefit entries when the payer sends them, otherwise from
    the plan's general entries, preferring in-network and individual (not family) amounts.
    `None` means the payer didn't say. `coinsurance_percent` is the patient's share (20 = 20%).
    `errors` are the payer's rejection reasons (for example "Subscriber not found") with the
    suggested next step.
    """

    check_id: str
    active: bool
    plan_name: str = ""
    group_number: str = ""
    coverage_start: date | None = None
    coverage_end: date | None = None
    in_network: bool | None = None
    copay_cents: int | None = None
    coinsurance_percent: Decimal | None = None
    deductible_cents: int | None = None
    deductible_remaining_cents: int | None = None
    out_of_pocket_cents: int | None = None
    out_of_pocket_remaining_cents: int | None = None
    prior_authorization_required: bool | None = None
    messages: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class PayerMatch:
    """A payer from Stedi's network. Support values are SUPPORTED, ENROLLMENT_REQUIRED or
    NOT_SUPPORTED; use `primary_payer_id` (or any alias) as the claim's payer id."""

    stedi_id: str
    name: str
    primary_payer_id: str
    aliases: tuple[str, ...]
    professional_claims: str
    eligibility: str
    remittances: str


class StediClient:
    """Talks to Stedi. Pass `client` (for example with an httpx.MockTransport) in tests."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        *,
        core_url: str = DEFAULT_CORE_URL,
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._core_url = core_url.rstrip("/")
        self._client = client or httpx.Client()

    def close(self) -> None:
        """Close the underlying HTTP connections."""
        self._client.close()

    def __enter__(self) -> "StediClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # Claims ----------------------------------------------------------------------------

    def submit_claim(self, document: ClaimDocument, usage: Literal["T", "P"]) -> SubmissionResult:
        """Send one claim as test ("T") or production ("P") data.

        Claims that fail Stedi's edits come back with `accepted=False` and the reasons.
        """
        body = claim_request(document, usage)
        # The same claim body always gets the same key, so a retry after a timeout can't
        # create a duplicate claim; any change to the claim gets a new key.
        key = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        response = self._send(
            "POST", self._base_url + CLAIM_PATH, body=body, headers={"Idempotency-Key": key}
        )
        data = _json(response)
        # Claims failing Stedi's edits come back as HTTP 400 with status "ERROR".
        rejected = data.get("status") == "ERROR"
        if not (response.status_code == 400 and rejected):
            _raise_for_status(response, data)
        errors = tuple(
            error.get("description") or error.get("message") or error.get("code") or "Unknown"
            for error in data.get("errors") or []
        )
        reference = data.get("claimReference") or {}
        return SubmissionResult(
            accepted=not (rejected or errors),
            patient_control_number=reference.get("patientControlNumber")
            or document.claim.patient_control_number,
            correlation_id=reference.get("correlationId", ""),
            errors=errors,
        )

    def list_new_reports(
        self,
        *,
        since: datetime | None = None,
        page_token: str = "",
        skip_transaction_ids: Collection[str] = (),
    ) -> ReportPage:
        """277CA and 835 reports processed after `since`, or after the stored `page_token`.

        Stedi recommends overlapping windows; pass the transaction ids already handled as
        `skip_transaction_ids` so they aren't fetched again.
        """
        if not page_token and since is None:
            raise ValueError("Pass since or page_token.")
        params = (
            {"pageToken": page_token}
            if page_token
            else {"startDateTime": since.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
        )
        reports: list[ClaimReport] = []
        while True:
            data = self._get(self._core_url + POLLING_PATH, params)
            items = data.get("items") or []
            for item in items:
                report = self._report(item, skip_transaction_ids)
                if report is not None:
                    reports.append(report)
            page_token = data.get("nextPageToken") or page_token
            if not items or not data.get("nextPageToken"):
                return ReportPage(reports=tuple(reports), next_page_token=page_token)
            params = {"pageToken": page_token}

    def _report(self, item: dict[str, Any], skip: Collection[str]) -> ClaimReport | None:
        transaction_id = item.get("transactionId", "")
        metadata = (item.get("x12") or {}).get("metadata") or {}
        transaction_set = (metadata.get("transaction") or {}).get("transactionSetIdentifier")
        if (
            item.get("direction") != "INBOUND"
            or item.get("status") == "failed"
            or transaction_set not in ("277", "835")
            or transaction_id in skip
        ):
            return None
        url = self._base_url + REPORT_PATH.format(
            transaction_id=transaction_id, report=transaction_set
        )
        data = self._get(url)
        processed_at = item.get("processedAt")
        is_277 = transaction_set == "277"
        return ClaimReport(
            transaction_id=transaction_id,
            transaction_set=transaction_set,
            processed_at=datetime.fromisoformat(processed_at) if processed_at else None,
            acknowledgments=tuple(acknowledgments_from_277(data)) if is_277 else (),
            remittances=() if is_277 else tuple(remittances_from_835(data)),
        )

    # Eligibility and payers ------------------------------------------------------------

    def check_eligibility(self, request: EligibilityRequest) -> EligibilityResult:
        """Ask the payer about the client's coverage and behavioral-health benefits."""
        response = self._send(
            "POST",
            self._base_url + ELIGIBILITY_PATH,
            body=eligibility_request(request),
            timeout=_ELIGIBILITY_TIMEOUT,
        )
        data = _json(response)
        # Payer rejections (AAA errors such as "subscriber not found") can arrive as HTTP 400
        # with a full eligibility response; those are answers, not failures.
        if not (response.status_code == 400 and data.get("id") and data.get("errors")):
            _raise_for_status(response, data)
        return eligibility_result(data)

    def search_payers(self, query: str, limit: int = 20) -> list[PayerMatch]:
        """Payers whose name, id or alias matches `query`, best match first."""
        data = self._get(
            self._base_url + PAYER_SEARCH_PATH, {"query": query, "pageSize": str(limit)}
        )
        return [_payer_match(item.get("payer") or {}) for item in data.get("items") or []]

    # HTTP ------------------------------------------------------------------------------

    def _send(
        self,
        method: str,
        url: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = _TIMEOUT,
    ) -> httpx.Response:
        try:
            return self._client.request(
                method,
                url,
                json=body,
                params=params,
                headers={"Authorization": self._api_key, **(headers or {})},
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise ClearinghouseError(f"Couldn't reach Stedi: {exc}") from exc

    def _get(self, url: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        response = self._send("GET", url, params=params)
        data = _json(response)
        _raise_for_status(response, data)
        return data


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _raise_for_status(response: httpx.Response, data: dict[str, Any]) -> None:
    """Raise a ClearinghouseError describing any non-2xx response."""
    if response.is_success:
        return
    status = response.status_code
    details = [str(data["message"])] if data.get("message") else []
    for error in data.get("errors") or []:
        detail = error.get("description") or error.get("message")
        location = error.get("location") or error.get("path")
        if detail:
            details.append(f"{location}: {detail}" if location else detail)
    for field in data.get("fieldList") or []:
        details.append(f"{field.get('path')}: {field.get('message')}")
    if status in (401, 403):
        summary = "Stedi rejected the API key. Check that it is correct and matches test/live mode"
    elif status == 429:
        summary = "Stedi is limiting requests right now. Try again in a minute"
    elif status >= 500:
        summary = "Stedi had a problem handling the request. Try again later"
    else:
        summary = "Stedi couldn't accept the request"
    message = f"{summary} (HTTP {status})"
    if details:
        message += ": " + "; ".join(details)
    raise ClearinghouseError(message, status)


def _compact(values: dict[str, Any]) -> dict[str, Any]:
    """Drop empty values so requests only carry what we know."""
    return {key: value for key, value in values.items() if value not in ("", None, [], {})}


# Claim request ---------------------------------------------------------------------------


def _address(address: Address) -> dict[str, Any]:
    return _compact(
        {
            "address1": clean(address.line1),
            "address2": clean(address.line2),
            "city": clean(address.city),
            "state": address.state,
            "postalCode": address.postal_code,
        }
    )


def _contact(contact: Contact) -> dict[str, Any]:
    return _compact(
        {"name": clean(contact.name), "phoneNumber": digits(contact.phone), "email": contact.email}
    )


def _person(name: PersonName) -> dict[str, Any]:
    return _compact(
        {
            "firstName": clean(name.first),
            "lastName": clean(name.last),
            "middleName": clean(name.middle),
            "suffix": clean(name.suffix),
        }
    )


def _provider(provider: Provider) -> dict[str, Any]:
    return _compact(
        {**_person(provider.name), "npi": provider.npi, "taxonomyCode": provider.taxonomy}
    )


def _adjustment_groups(adjustments: tuple[Adjustment, ...]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for adjustment in adjustments:
        groups.setdefault(adjustment.group_code, []).append(
            _compact(
                {
                    "adjustmentReasonCode": adjustment.reason_code,
                    "adjustmentAmount": amount(adjustment.amount_cents),
                    "adjustmentQuantity": str(adjustment.quantity) if adjustment.quantity else "",
                }
            )
        )
    return [
        {"adjustmentGroupCode": group_code, "adjustmentDetails": details}
        for group_code, details in groups.items()
    ]


def _billing(provider: BillingProvider) -> dict[str, Any]:
    if provider.entity_type == "organization" or provider.person is None:
        name = {"organizationName": clean(provider.organization_name)}
    else:
        name = _person(provider.person)
    tax_key = "employerId" if provider.tax_id_type == "EIN" else "ssn"
    return {
        "npi": provider.npi,
        "taxonomyCode": provider.taxonomy,
        tax_key: digits(provider.tax_id),
        **name,
        "address": _address(provider.address),
        "contactInformation": _contact(provider.contact),
    }


def _other_subscriber(document: ClaimDocument, other: OtherPayer) -> dict[str, Any]:
    subscriber = other.subscriber
    name = _person(subscriber.name)
    return _compact(
        {
            "paymentResponsibilityLevelCode": other.payer_responsibility,
            "individualRelationshipCode": subscriber.patient_relationship,
            "insuranceGroupOrPolicyNumber": subscriber.group_number,
            "otherInsuredGroupName": clean(subscriber.plan_name),
            "claimFilingIndicatorCode": subscriber.claim_filing_indicator,
            "benefitsAssignmentCertificationIndicator": document.claim.benefits_assignment,
            "releaseOfInformationCode": document.claim.release_of_information,
            "payerPaidAmount": amount(other.paid_cents),
            "claimLevelAdjustments": _adjustment_groups(other.claim_adjustments),
            "otherSubscriberName": _compact(
                {
                    "otherInsuredQualifier": "1",
                    "otherInsuredLastName": name.get("lastName", ""),
                    "otherInsuredFirstName": name.get("firstName", ""),
                    "otherInsuredMiddleName": name.get("middleName", ""),
                    "otherInsuredNameSuffix": name.get("suffix", ""),
                    "otherInsuredIdentifierTypeCode": "MI",
                    "otherInsuredIdentifier": subscriber.member_id,
                    "otherInsuredAddress": _address(subscriber.address)
                    if subscriber.address
                    else None,
                }
            ),
            "otherPayerName": _compact(
                {
                    "otherPayerOrganizationName": clean(other.payer.name),
                    "otherPayerIdentifierTypeCode": "PI",
                    "otherPayerIdentifier": other.payer.payer_id,
                    "otherPayerClaimControlNumber": other.payer_claim_number,
                    "otherPayerAdjudicationOrPaymentDate": ""
                    if other.line_adjudications
                    else x12_date(other.adjudication_date),
                    "otherPayerAddress": _address(other.payer.address)
                    if other.payer.address
                    else None,
                }
            ),
        }
    )


def _line_adjudications(other: OtherPayer | None, line: ClaimLine) -> list[dict[str, Any]]:
    """The earlier payer's results for this line (COB)."""
    if other is None:
        return []
    return [
        _compact(
            {
                "otherPayerPrimaryIdentifier": other.payer.payer_id,
                "serviceLinePaidAmount": amount(adjudication.paid_cents),
                "serviceIdQualifier": "HC",
                "procedureCode": adjudication.procedure_code,
                "procedureModifier": list(adjudication.modifiers),
                "paidServiceUnitCount": str(adjudication.units),
                "adjudicationOrPaymentDate": x12_date(adjudication.adjudication_date),
                "claimAdjustmentInformation": _adjustment_groups(adjudication.adjustments),
            }
        )
        for adjudication in other.line_adjudications
        if adjudication.line_control_number == line.line_control_number
    ]


def _service_line(document: ClaimDocument, line: ClaimLine) -> dict[str, Any]:
    claim = document.claim
    rendering = line.rendering_provider
    claim_rendering_npi = (
        claim.rendering_provider.npi if claim.rendering_provider else document.billing_provider.npi
    )
    service = _compact(
        {
            "procedureIdentifier": "HC",
            "procedureCode": line.procedure_code,
            "procedureModifiers": list(line.modifiers),
            "lineItemChargeAmount": amount(line.charge_cents),
            "measurementUnit": "UN",
            "serviceUnitCount": str(line.units),
            "placeOfServiceCode": line.place_of_service
            if line.place_of_service != claim.place_of_service
            else "",
            "compositeDiagnosisCodePointers": {
                "diagnosisCodePointers": [str(pointer) for pointer in line.diagnosis_pointers]
            },
        }
    )
    return _compact(
        {
            "serviceDate": x12_date(line.service_date),
            "providerControlNumber": line.line_control_number,
            "professionalService": service,
            "renderingProvider": _provider(rendering)
            if rendering is not None and rendering.npi != claim_rendering_npi
            else None,
            "lineAdjudicationInformation": _line_adjudications(claim.other_payer, line),
        }
    )


def claim_request(document: ClaimDocument, usage: Literal["T", "P"]) -> dict[str, Any]:
    """The JSON body for Stedi's professional claims (837P) endpoint.

    The billing provider doubles as the submitter; Stedi fills in its own submitter id.
    """
    billing = document.billing_provider
    subscriber = document.subscriber
    claim = document.claim
    patient = document.patient
    body: dict[str, Any] = {
        "tradingPartnerServiceId": document.payer.payer_id,
        "tradingPartnerName": clean(document.payer.name),
        "usageIndicator": usage,
        "submitter": {
            "organizationName": clean(billing.display_name),
            "contactInformation": _contact(billing.contact),
        },
        "receiver": {"organizationName": clean(document.payer.name)},
        "subscriber": _compact(
            {
                "memberId": subscriber.member_id,
                "paymentResponsibilityLevelCode": subscriber.payer_responsibility,
                **_person(subscriber.name),
                "gender": subscriber.sex,
                "dateOfBirth": x12_date(subscriber.birth_date) if subscriber.birth_date else "",
                "groupNumber": subscriber.group_number,
                "subscriberGroupName": ""
                if subscriber.group_number
                else clean(subscriber.plan_name),
                "address": _address(subscriber.address) if subscriber.address else None,
            }
        ),
        "billing": _billing(billing),
    }
    if patient is not None:
        body["dependent"] = {
            **_person(patient.name),
            "gender": patient.sex,
            "dateOfBirth": x12_date(patient.birth_date),
            "relationshipToSubscriberCode": subscriber.patient_relationship,
            "address": _address(patient.address),
        }
    if billing.pay_to_address is not None:
        body["payToAddress"] = _address(billing.pay_to_address)
    if document.payer.address is not None:
        body["payerAddress"] = _address(document.payer.address)
    if claim.rendering_provider is not None and claim.rendering_provider.npi != billing.npi:
        body["rendering"] = _provider(claim.rendering_provider)
    if claim.supervising_provider is not None:
        body["supervising"] = _provider(claim.supervising_provider)
    if claim.referring_provider is not None:
        body["referring"] = _provider(claim.referring_provider)
    facility = claim.service_facility
    body["claimInformation"] = _compact(
        {
            "claimFilingCode": subscriber.claim_filing_indicator,
            "patientControlNumber": claim.patient_control_number,
            "claimChargeAmount": amount(claim.total_charge_cents),
            "placeOfServiceCode": claim.place_of_service,
            "claimFrequencyCode": claim.frequency_code,
            "signatureIndicator": "Y" if claim.provider_signature_on_file else "N",
            "planParticipationCode": claim.assignment_code,
            "benefitsAssignmentCertificationIndicator": claim.benefits_assignment,
            "releaseInformationCode": claim.release_of_information,
            "healthCareCodeInformation": [
                {"diagnosisTypeCode": "ABK" if index == 0 else "ABF", "diagnosisCode": code}
                for index, code in enumerate(claim.diagnoses)
            ],
            "claimSupplementalInformation": _compact(
                {
                    "priorAuthorizationNumber": claim.prior_authorization_number,
                    "claimControlNumber": claim.payer_claim_number
                    if claim.frequency_code in ("7", "8")
                    else "",
                }
            ),
            "serviceFacilityLocation": _compact(
                {
                    "organizationName": clean(facility.name),
                    "npi": facility.npi,
                    "address": _address(facility.address),
                }
            )
            if facility
            else None,
            "serviceLines": [_service_line(document, line) for line in claim.lines],
            "otherSubscriberInformation": [_other_subscriber(document, claim.other_payer)]
            if claim.other_payer
            else [],
        }
    )
    return body


# 277CA and 835 reports -----------------------------------------------------------------


def _walk(data: dict[str, Any], *path: str) -> Iterator[dict[str, Any]]:
    """Every object reached by following `path` through nested lists of objects."""
    if not path:
        yield data
        return
    for child in data.get(path[0]) or []:
        yield from _walk(child, *path[1:])


def acknowledgments_from_277(data: dict[str, Any]) -> list[ClaimAcknowledgment]:
    """Claim verdicts from Stedi's 277CA report JSON."""
    found = []
    for payer in _walk(data, "transactions", "payers"):
        source = payer.get("organizationName", "")
        for claim in _walk(
            payer,
            "claimStatusTransactions",
            "claimStatusDetails",
            "patientClaimStatusDetails",
            "claims",
        ):
            status_info = claim.get("claimStatus") or {}
            statuses: list[ClaimStatus] = []
            messages: list[str] = []
            rejected_by_action = False
            charge: int | None = None
            status_date: date | None = None
            for info in status_info.get("informationClaimStatuses") or []:
                rejected_by_action |= info.get("statusInformationActionCode") == "U"
                if info.get("statusMessage"):
                    messages.append(info["statusMessage"])
                if info.get("totalClaimChargeAmount"):
                    charge = cents(info["totalClaimChargeAmount"])
                status_date = status_date or parse_date(
                    info.get("statusInformationEffectiveDate", "")
                )
                for status in info.get("informationStatuses") or []:
                    category = status.get("healthCareClaimStatusCategoryCode", "")
                    description = status.get("statusCodeValue") or status.get(
                        "healthCareClaimStatusCategoryCodeValue"
                    )
                    statuses.append(
                        ClaimStatus(
                            category_code=category,
                            status_code=status.get("statusCode", ""),
                            entity_code=status.get("entityIdentifierCode", ""),
                            description=description or CATEGORY_DESCRIPTIONS.get(category, ""),
                        )
                    )
            for line in claim.get("serviceLines") or []:
                messages += [
                    status["statusMessage"]
                    for status in line.get("serviceClaimStatuses") or []
                    if status.get("statusMessage")
                ]
            rejected = rejected_by_action or any(status.rejected for status in statuses)
            found.append(
                ClaimAcknowledgment(
                    patient_control_number=status_info.get("referencedTransactionTraceNumber")
                    or status_info.get("patientAccountNumber", ""),
                    accepted=not rejected,
                    statuses=tuple(statuses),
                    messages=tuple(messages),
                    payer_claim_number=status_info.get("tradingPartnerClaimNumber", ""),
                    clearinghouse_trace_number=status_info.get("clearinghouseTraceNumber", ""),
                    charge_cents=charge,
                    status_date=status_date,
                    source=source,
                )
            )
    return found


def _numbered_adjustments(groups: list[dict[str, Any]]) -> tuple[Adjustment, ...]:
    """Stedi's CAS groups: adjustmentReasonCode1..6 with matching amounts and quantities."""
    found = []
    for group in groups:
        for number in range(1, 7):
            reason = group.get(f"adjustmentReasonCode{number}")
            if reason:
                found.append(
                    Adjustment(
                        group_code=group.get("claimAdjustmentGroupCode", ""),
                        reason_code=reason,
                        amount_cents=cents(group.get(f"adjustmentAmount{number}", "")),
                        quantity=units(group.get(f"adjustmentQuantity{number}", ""), default=0),
                    )
                )
    return tuple(found)


def _service_payment(line: dict[str, Any]) -> ServicePayment:
    payment = line.get("servicePaymentInformation") or {}
    allowed = (line.get("serviceSupplementalAmounts") or {}).get("allowedActual")
    return ServicePayment(
        procedure_code=payment.get("adjudicatedProcedureCode", ""),
        modifiers=tuple(payment.get("adjudicatedProcedureModifierCodes") or ()),
        charge_cents=cents(payment.get("lineItemChargeAmount", "")),
        paid_cents=cents(payment.get("lineItemProviderPaymentAmount", "")),
        units=units(payment.get("unitsOfServicePaidCount", "")),
        line_control_number=line.get("lineItemControlNumber", ""),
        service_date=parse_date(line.get("serviceDate") or line.get("serviceStartDate") or ""),
        allowed_cents=cents(allowed) if allowed else None,
        adjustments=_numbered_adjustments(line.get("serviceAdjustments") or []),
        remark_codes=tuple(
            remark["remarkCode"]
            for remark in line.get("healthCareCheckRemarkCodes") or []
            if remark.get("remarkCode")
        ),
    )


def remittances_from_835(data: dict[str, Any]) -> list[Remittance]:
    """Remittances from Stedi's 835 report JSON."""
    found = []
    for transaction in data.get("transactions") or []:
        financial = transaction.get("financialInformation") or {}
        payer = transaction.get("payer") or {}
        payee = transaction.get("payee") or {}
        payment = cents(financial.get("totalActualProviderPaymentAmount", ""))
        claims = []
        for info in _walk(transaction, "detailInfo", "paymentInfo"):
            claim = info.get("claimPaymentInfo") or {}
            claims.append(
                ClaimPayment(
                    patient_control_number=claim.get("patientControlNumber", ""),
                    status_code=claim.get("claimStatusCode", ""),
                    charge_cents=cents(claim.get("totalClaimChargeAmount", "")),
                    paid_cents=cents(claim.get("claimPaymentAmount", "")),
                    patient_responsibility_cents=cents(
                        claim.get("patientResponsibilityAmount", "")
                    ),
                    payer_claim_number=claim.get("payerClaimControlNumber", ""),
                    adjustments=_numbered_adjustments(info.get("claimAdjustments") or []),
                    lines=tuple(_service_payment(line) for line in info.get("serviceLines") or []),
                )
            )
        provider_adjustments = [
            ProviderAdjustment(
                provider_id=group.get("providerIdentifier", ""),
                fiscal_period_date=parse_date(group.get("fiscalPeriodDate", "")),
                reason_code=adjustment.get("adjustmentReasonCode", ""),
                reference=adjustment.get("providerAdjustmentIdentifier", ""),
                amount_cents=cents(adjustment.get("providerAdjustmentAmount", "")),
            )
            for group in transaction.get("providerAdjustments") or []
            for adjustment in group.get("adjustments") or []
        ]
        found.append(
            Remittance(
                payer_name=payer.get("name", ""),
                payer_id=payer.get("payerIdentificationNumber", ""),
                payee_name=payee.get("name", ""),
                payee_npi=payee.get("npi", ""),
                payee_tax_id=payee.get("taxId")
                or payee.get("federalTaxPayersIdentificationNumber", ""),
                payment_cents=-payment
                if financial.get("creditOrDebitFlagCode") == "D"
                else payment,
                payment_method=financial.get("paymentMethodCode", ""),
                payment_date=parse_date(financial.get("checkIssueOrEFTEffectiveDate", "")),
                trace_number=(transaction.get("paymentAndRemitReassociationDetails") or {}).get(
                    "checkOrEFTTraceNumber", ""
                ),
                claims=tuple(claims),
                provider_adjustments=tuple(provider_adjustments),
            )
        )
    return found


# Eligibility -----------------------------------------------------------------------------


def _name_json(name: PersonName) -> dict[str, Any]:
    return {"person": _person(name)}


def eligibility_request(request: EligibilityRequest) -> dict[str, Any]:
    """The JSON body for Stedi's eligibility check endpoint."""
    provider = request.provider
    if provider.entity_type == "organization" or provider.person is None:
        provider_name: dict[str, Any] = {"organization": clean(provider.organization_name)}
    else:
        provider_name = _name_json(provider.person)
    encounter: dict[str, Any] = {
        "services": [{"system": "STC", "value": request.service_type_code}]
    }
    if request.service_date is not None:
        encounter["dates"] = {"service": {"start": request.service_date.isoformat()}}
    body: dict[str, Any] = {
        "payerId": request.payer_id,
        "provider": {"name": provider_name, "npi": provider.npi},
        "subscriber": _compact(
            {
                "memberId": request.member_id,
                "name": _name_json(request.subscriber),
                "dateOfBirth": request.subscriber_birth_date.isoformat()
                if request.subscriber_birth_date
                else "",
            }
        ),
        "encounter": encounter,
    }
    if request.dependent is not None:
        body["dependent"] = _compact(
            {
                "name": _name_json(request.dependent),
                "dateOfBirth": request.dependent_birth_date.isoformat()
                if request.dependent_birth_date
                else "",
                "relationToSubscriber": _DEPENDENT_RELATIONSHIPS.get(
                    request.dependent_relationship, "OTHER_ADULT"
                ),
            }
        )
    return body


def _is_mental_health(entry: dict[str, Any]) -> bool:
    service = entry.get("service") or {}
    return service.get("system") == "STC" and service.get("value") in MENTAL_HEALTH_SERVICE_TYPES


def _is_general(entry: dict[str, Any]) -> bool:
    service = entry.get("service") or {}
    return not service or (service.get("system") == "STC" and service.get("value") == "30")


def _relevant(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mental-health entries when there are any, otherwise the plan-wide ones."""
    return [entry for entry in entries if _is_mental_health(entry)] or [
        entry for entry in entries if _is_general(entry)
    ]


def _best(entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The in-network, individual-level entry when there is one."""
    if not entries:
        return None

    def preference(entry: dict[str, Any]) -> tuple[int, int]:
        network = (entry.get("network") or {}).get("indicator", "")
        individual = entry.get("coverageLevel") == "INDIVIDUAL"
        return (_NETWORK_PREFERENCE.get(network, 2), 0 if individual else 1)

    return min(entries, key=preference)


def _money(entry: dict[str, Any] | None) -> int | None:
    return cents(entry["amount"]) if entry and entry.get("amount") else None


class _Benefits:
    """The benefit entries of every plan in an eligibility response, by kind."""

    def __init__(self, plans: list[dict[str, Any]]) -> None:
        self.plans = plans

    def all(self, kind: str) -> list[dict[str, Any]]:
        return [
            entry for plan in self.plans for entry in (plan.get("benefits") or {}).get(kind) or []
        ]

    def relevant(self, kind: str) -> list[dict[str, Any]]:
        return _relevant(self.all(kind))

    def total(self, kind: str) -> dict[str, Any] | None:
        """The yearly (or contract/lifetime) amount."""
        return _best(
            [
                entry
                for entry in self.relevant(kind)
                if entry.get("timePeriod") in _TOTAL_PERIODS or not entry.get("timePeriod")
            ]
        )

    def remaining(self, kind: str) -> dict[str, Any] | None:
        """What is left of the amount this year."""
        return _best(
            [entry for entry in self.relevant(kind) if entry.get("timePeriod") == "REMAINING"]
        )


def eligibility_result(data: dict[str, Any]) -> EligibilityResult:
    """Coverage and behavioral-health cost sharing from Stedi's eligibility response."""
    plans = data.get("plans") or []
    benefits = _Benefits(plans)
    copay = _best(benefits.relevant("coPayment"))
    coinsurance = _best(benefits.relevant("coInsurance"))
    deductible = benefits.total("deductible")

    networks = [
        (entry.get("network") or {}).get("indicator")
        for entry in (copay, coinsurance, deductible)
        if entry
    ]
    network = next((indicator for indicator in networks if indicator), "")
    authorization = {
        entry.get("priorAuthIndicator")
        for kind in ("statuses", "coPayment", "coInsurance")
        for entry in benefits.relevant(kind)
    }
    person = data.get("dependent") or data.get("subscriber") or {}
    dates = person.get("dates") or {}
    coverage = dates.get("plan") or dates.get("eligibility") or {}
    group = ((data.get("subscriber") or {}).get("additionalInformation") or {}).get("group") or {}
    messages = dict.fromkeys(
        message
        for kind in ("statuses", "coPayment", "coInsurance", "deductible", "outOfPocket")
        for entry in benefits.relevant(kind)
        for message in entry.get("messages") or []
    )
    errors = tuple(
        " — ".join(part for part in (error.get("description"), error.get("followupAction")) if part)
        for error in data.get("errors") or []
    )
    plan_names = [plan["name"] for plan in plans if plan.get("name")]
    percent = coinsurance.get("percent") if coinsurance else None
    return EligibilityResult(
        check_id=data.get("id", ""),
        active=any(
            status.get("status", "").startswith("ACTIVE") for status in benefits.all("statuses")
        ),
        plan_name=plan_names[0] if plan_names else group.get("name", ""),
        group_number=group.get("number", ""),
        coverage_start=parse_date(coverage.get("start", "")),
        coverage_end=parse_date(coverage.get("end", "")),
        in_network={"IN_NETWORK": True, "OUT_OF_NETWORK": False}.get(network),
        copay_cents=_money(copay),
        coinsurance_percent=Decimal(percent) * 100 if percent else None,
        deductible_cents=_money(deductible),
        deductible_remaining_cents=_money(benefits.remaining("deductible")),
        out_of_pocket_cents=_money(benefits.total("outOfPocket")),
        out_of_pocket_remaining_cents=_money(benefits.remaining("outOfPocket")),
        prior_authorization_required=_prior_authorization(authorization),
        messages=tuple(messages),
        errors=errors,
    )


def _prior_authorization(indicators: set[str | None]) -> bool | None:
    if "REQUIRED" in indicators:
        return True
    if "NOT_REQUIRED" in indicators:
        return False
    return None


def _payer_match(payer: dict[str, Any]) -> PayerMatch:
    support = payer.get("transactionSupport") or {}
    return PayerMatch(
        stedi_id=payer.get("stediId", ""),
        name=payer.get("displayName", ""),
        primary_payer_id=payer.get("primaryPayerId", ""),
        aliases=tuple(payer.get("aliases") or ()),
        professional_claims=support.get("professionalClaimSubmission", ""),
        eligibility=support.get("eligibilityCheck", ""),
        remittances=support.get("claimPayment", ""),
    )
