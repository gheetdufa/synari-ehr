"""Practice reports, as JSON or CSV (`?format=csv`)."""

import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response

from synari.access import ClientAccess
from synari.audit import audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess
from synari.permissions import Capability
from synari.schemas.reports import (
    AgingReportOut,
    AgingRowOut,
    ClaimSummaryRowOut,
    IncomeReportOut,
    IncomeRowOut,
    SessionRowOut,
)
from synari.services import reports
from synari.services.scheduling import zone_of

router = APIRouter(prefix="/reports", tags=["reports"])

Format = Literal["json", "csv"]
MAX_PERIOD = timedelta(days=366 * 3)


def _scope(access: CurrentAccess) -> reports.ReportScope:
    """Practice-wide for roles with reports; own caseload for clinicians with billing access."""
    if not (access.can(Capability.VIEW_REPORTS) or access.can(Capability.BILLING_OWN)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't include reports")
    return reports.ReportScope(
        practice_id=access.practice_id,
        zone=zone_of(access.staff.practice),
        client_filter=access.client_filter(ClientAccess.BILLING),
    )


def _period(start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The end date is before the start date")
    if end - start > MAX_PERIOD:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a period of three years or less")


def _csv(filename: str, header: list[str], rows: list[list[object]]) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _money(cents: int) -> str:
    return f"{cents / 100:.2f}"


def _audit(access: CurrentAccess, request: Request, report: str) -> None:
    audit_staff(access.db, request, access.staff, "report.view", detail={"report": report})
    access.db.commit()


@router.get("/income", response_model=IncomeReportOut)
def income_report(
    access: CurrentAccess,
    request: Request,
    start: date = Query(),
    end: date = Query(),
    format: Format = "json",
) -> IncomeReportOut | Response:
    """Payments received in the period by clinician: client payments and insurance payments."""
    scope = _scope(access)
    _period(start, end)
    report = reports.income(access.db, scope, start, end)
    _audit(access, request, "income")
    if format == "csv":
        rows = [
            [
                row.clinician_name,
                _money(row.client_payments_cents),
                _money(row.insurance_payments_cents),
                _money(row.total_cents),
            ]
            for row in report.rows
        ]
        rows.append(["Unapplied client credit", _money(report.unapplied_cents), "", ""])
        return _csv(
            f"income-{start}-{end}.csv",
            ["Clinician", "Client payments", "Insurance payments", "Total"],
            rows,
        )
    return IncomeReportOut(
        start=report.start,
        end=report.end,
        rows=[
            IncomeRowOut(
                clinician_id=row.clinician_id,
                clinician_name=row.clinician_name,
                client_payments_cents=row.client_payments_cents,
                insurance_payments_cents=row.insurance_payments_cents,
                total_cents=row.total_cents,
            )
            for row in report.rows
        ],
        unapplied_cents=report.unapplied_cents,
        total_cents=report.total_cents,
    )


@router.get("/sessions", response_model=list[SessionRowOut])
def sessions_report(
    access: CurrentAccess,
    request: Request,
    start: date = Query(),
    end: date = Query(),
    format: Format = "json",
) -> list[SessionRowOut] | Response:
    """Sessions held and client attendance outcomes by clinician."""
    scope = _scope(access)
    _period(start, end)
    rows = reports.sessions(access.db, scope, start, end)
    _audit(access, request, "sessions")
    if format == "csv":
        return _csv(
            f"sessions-{start}-{end}.csv",
            [
                "Clinician",
                "Sessions",
                "Attended",
                "No-show",
                "Late canceled",
                "Canceled",
                "Upcoming",
                "Billed",
            ],
            [
                [
                    r.clinician_name,
                    r.sessions,
                    r.attended,
                    r.no_show,
                    r.late_canceled,
                    r.canceled,
                    r.upcoming,
                    _money(r.billed_cents),
                ]
                for r in rows
            ],
        )
    return [SessionRowOut.model_validate(row) for row in rows]


@router.get("/aging", response_model=AgingReportOut)
def aging_report(
    access: CurrentAccess,
    request: Request,
    as_of: date | None = Query(default=None),
    format: Format = "json",
) -> AgingReportOut | Response:
    """Outstanding client and insurance balances by age."""
    scope = _scope(access)
    day = as_of or utcnow().astimezone(scope.zone).date()
    report = reports.aging(access.db, scope, day)
    client_ids = [row.client_id for row in report.clients if row.client_id is not None]
    if client_ids:
        # The report names clients, so the event lists them (see audit_staff_list).
        audit_staff_list(
            access.db, request, access.staff, "report.view", client_ids, detail={"report": "aging"}
        )
        access.db.commit()
    else:
        _audit(access, request, "aging")
    if format == "csv":
        rows = [
            [
                "Client",
                row.label,
                *(_money(row.buckets[b]) for b in reports.AGING_BUCKETS),
                _money(row.total_cents),
            ]
            for row in report.clients
        ] + [
            [
                "Insurance",
                row.label,
                *(_money(row.buckets[b]) for b in reports.AGING_BUCKETS),
                _money(row.total_cents),
            ]
            for row in report.insurance
        ]
        return _csv(
            f"aging-{day}.csv",
            ["Owed by", "Name", *(f"{b} days" for b in reports.AGING_BUCKETS), "Total"],
            rows,
        )

    def out(rows: list[reports.AgingRow]) -> list[AgingRowOut]:
        return [
            AgingRowOut(label=row.label, buckets=row.buckets, total_cents=row.total_cents)
            for row in rows
        ]

    return AgingReportOut(as_of=day, clients=out(report.clients), insurance=out(report.insurance))


@router.get("/claims", response_model=list[ClaimSummaryRowOut])
def claims_report(
    access: CurrentAccess,
    request: Request,
    start: date = Query(),
    end: date = Query(),
    format: Format = "json",
) -> list[ClaimSummaryRowOut] | Response:
    """Claims created in the period by payer and status."""
    scope = _scope(access)
    _period(start, end)
    rows = reports.claims_summary(access.db, scope, start, end)
    _audit(access, request, "claims")
    if format == "csv":
        return _csv(
            f"claims-{start}-{end}.csv",
            ["Payer", "Status", "Claims", "Charged", "Paid", "Adjusted", "Patient responsibility"],
            [
                [
                    r.payer_name,
                    r.status,
                    r.claims,
                    _money(r.charged_cents),
                    _money(r.paid_cents),
                    _money(r.adjustment_cents),
                    _money(r.patient_responsibility_cents),
                ]
                for r in rows
            ],
        )
    return [ClaimSummaryRowOut.model_validate(row) for row in rows]
