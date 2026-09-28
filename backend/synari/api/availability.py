"""Each clinician's weekly availability for online appointment requests."""

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import delete, select

from synari.access import Access
from synari.audit import audit_staff
from synari.deps import CurrentAccess, DbSession
from synari.models import AvailabilityBlock, Location, StaffMember
from synari.schemas.booking import AvailabilityBlockOut, AvailabilityUpdate

router = APIRouter(prefix="/availability", tags=["availability"])

ClinicianQuery = Query(default=None, description="Whose availability (default: yours)")


def _clinician(access: Access, clinician_id: int | None) -> StaffMember:
    """The clinician whose availability to show or change; others' need schedule-all."""
    target_id = access.staff.id if clinician_id is None else clinician_id
    access.require_calendar(target_id)
    return access.clinician(target_id)


def _check_locations(access: Access, body: AvailabilityUpdate) -> None:
    for location_id in {b.location_id for b in body.blocks if b.location_id is not None}:
        location = access.get(Location, location_id, label="Location")
        if not location.is_active:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{location.name} is no longer in use"
            )


def _blocks(access: Access, clinician_id: int) -> list[AvailabilityBlock]:
    return list(
        access.db.scalars(
            select(AvailabilityBlock)
            .where(AvailabilityBlock.clinician_id == clinician_id)
            .order_by(AvailabilityBlock.weekday, AvailabilityBlock.start_time)
        )
    )


@router.get("", response_model=list[AvailabilityBlockOut])
def get_availability(
    access: CurrentAccess, clinician_id: int | None = ClinicianQuery
) -> list[AvailabilityBlock]:
    """Weekly blocks, in the clinician's time zone, ordered by day and start time."""
    return _blocks(access, _clinician(access, clinician_id).id)


@router.put("", response_model=list[AvailabilityBlockOut])
def replace_availability(
    body: AvailabilityUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    clinician_id: int | None = ClinicianQuery,
) -> list[AvailabilityBlock]:
    """Replace the clinician's whole weekly set of blocks."""
    clinician = _clinician(access, clinician_id)
    _check_locations(access, body)
    db.execute(delete(AvailabilityBlock).where(AvailabilityBlock.clinician_id == clinician.id))
    db.add_all(
        AvailabilityBlock(clinician_id=clinician.id, **block.model_dump()) for block in body.blocks
    )
    audit_staff(
        db,
        request,
        access.staff,
        "availability.update",
        "staff",
        clinician.id,
        {"blocks": len(body.blocks)},
    )
    db.commit()
    return _blocks(access, clinician.id)
