"""Report responses."""

from datetime import date

from synari.schemas.common import Schema


class IncomeRowOut(Schema):
    clinician_id: int | None
    clinician_name: str
    client_payments_cents: int
    insurance_payments_cents: int
    total_cents: int


class IncomeReportOut(Schema):
    start: date
    end: date
    rows: list[IncomeRowOut]
    unapplied_cents: int
    total_cents: int


class SessionRowOut(Schema):
    clinician_id: int
    clinician_name: str
    sessions: int
    attended: int
    no_show: int
    late_canceled: int
    canceled: int
    upcoming: int
    billed_cents: int


class AgingRowOut(Schema):
    label: str
    buckets: dict[str, int]
    total_cents: int


class AgingReportOut(Schema):
    as_of: date
    clients: list[AgingRowOut]
    insurance: list[AgingRowOut]


class ClaimSummaryRowOut(Schema):
    payer_name: str
    status: str
    claims: int
    charged_cents: int
    paid_cents: int
    adjustment_cents: int
    patient_responsibility_cents: int
