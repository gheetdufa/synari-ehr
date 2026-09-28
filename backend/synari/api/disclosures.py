"""Accounting of disclosures: staff log disclosures made outside treatment, payment and
operations (exports and third-party record releases add theirs automatically), and clients
can see their six-year accounting in the portal at any time.

Staff need clinical access to the client.
"""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from synari.access import Access, ClientAccess
from synari.audit import audit_client, audit_staff, audit_staff_list
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, DbSession
from synari.models import Disclosure
from synari.models.enums import DisclosureSource
from synari.schemas.records import (
    DisclosureCreate,
    DisclosureOut,
    DisclosureReportOut,
    DisclosureUpdate,
    PortalDisclosureReportOut,
)
from synari.services.disclosures import (
    accounting_csv,
    accounting_pdf,
    accounting_report,
    client_disclosures,
)

router = APIRouter(tags=["disclosures"])

ReportFormat = Literal["json", "pdf", "csv"]


def _editable_disclosure(access: Access, disclosure_id: int) -> Disclosure:
    """A manually entered disclosure (ones recorded by an export or a fulfilled record request
    are kept as recorded)."""
    disclosure = access.client_record(
        Disclosure, disclosure_id, ClientAccess.CLINICAL, label="Disclosure"
    )
    if disclosure.source != DisclosureSource.MANUAL:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This disclosure was recorded automatically and can't be changed",
        )
    return disclosure


def _file(content: bytes | str, media_type: str, filename: str) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/clients/{client_id}/disclosures", response_model=list[DisclosureOut])
def list_disclosures(
    client_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[Disclosure]:
    """Every disclosure recorded for the client, newest first."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    disclosures = client_disclosures(db, client)
    audit_staff_list(db, request, access.staff, "disclosure.list", [client.id])
    db.commit()
    return disclosures


@router.post(
    "/clients/{client_id}/disclosures",
    response_model=DisclosureOut,
    status_code=status.HTTP_201_CREATED,
)
def create_disclosure(
    client_id: int,
    body: DisclosureCreate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> Disclosure:
    """Log a disclosure made outside the app."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    disclosure = Disclosure(
        practice_id=client.practice_id,
        client_id=client.id,
        recorded_by_id=access.staff.id,
        **body.model_dump(),
    )
    db.add(disclosure)
    db.flush()
    audit_staff(
        db,
        request,
        access.staff,
        "disclosure.create",
        "disclosure",
        disclosure.id,
        client_id=client.id,
    )
    db.commit()
    return disclosure


@router.patch("/disclosures/{disclosure_id}", response_model=DisclosureOut)
def update_disclosure(
    disclosure_id: int,
    body: DisclosureUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> Disclosure:
    """Correct a disclosure entered by hand."""
    disclosure = _editable_disclosure(access, disclosure_id)
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(disclosure, field, value)
    audit_staff(
        db,
        request,
        access.staff,
        "disclosure.update",
        "disclosure",
        disclosure.id,
        {"fields": sorted(changes)},
        client_id=disclosure.client_id,
    )
    db.commit()
    return disclosure


@router.delete("/disclosures/{disclosure_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_disclosure(
    disclosure_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> None:
    """Remove a disclosure entered by mistake."""
    disclosure = _editable_disclosure(access, disclosure_id)
    db.delete(disclosure)
    audit_staff(
        db,
        request,
        access.staff,
        "disclosure.delete",
        "disclosure",
        disclosure_id,
        client_id=disclosure.client_id,
    )
    db.commit()


@router.get("/clients/{client_id}/disclosures/report", response_model=None)
def disclosure_report(
    client_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    report_format: ReportFormat = Query(default="json", alias="format"),
) -> DisclosureReportOut | Response:
    """The client's accounting of disclosures for the last six years, as JSON, PDF or CSV."""
    client = access.client(client_id, ClientAccess.CLINICAL)
    report = accounting_report(db, client, utcnow())
    audit_staff(
        db,
        request,
        access.staff,
        "disclosure.report",
        "client",
        client.id,
        {"format": report_format, "count": len(report.disclosures)},
        client_id=client.id,
    )
    db.commit()
    stamp = f"{report.period_end:%Y%m%d}"
    if report_format == "pdf":
        return _file(
            accounting_pdf(report), "application/pdf", f"disclosures-{client.id}-{stamp}.pdf"
        )
    if report_format == "csv":
        return _file(accounting_csv(report), "text/csv", f"disclosures-{client.id}-{stamp}.csv")
    return DisclosureReportOut.model_validate(report)


# Client portal


@router.get("/portal/disclosures", response_model=PortalDisclosureReportOut)
def portal_disclosures(
    client: CurrentClient, db: DbSession, request: Request
) -> PortalDisclosureReportOut:
    """Your accounting of disclosures for the last six years."""
    report = accounting_report(db, client, utcnow())
    audit_client(db, request, client, "disclosure.report", "client", client.id, {"format": "json"})
    db.commit()
    return PortalDisclosureReportOut.model_validate(report)


@router.get("/portal/disclosures/report.pdf")
def portal_disclosure_pdf(client: CurrentClient, db: DbSession, request: Request) -> Response:
    """Your accounting of disclosures as a PDF."""
    report = accounting_report(db, client, utcnow())
    audit_client(db, request, client, "disclosure.report", "client", client.id, {"format": "pdf"})
    db.commit()
    return _file(
        accounting_pdf(report),
        "application/pdf",
        f"accounting-of-disclosures-{report.period_end:%Y%m%d}.pdf",
    )
