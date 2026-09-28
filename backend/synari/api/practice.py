"""Practice details, practice-wide settings, services and locations (the audit log is in
api/audit_log.py)."""

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select, update

from synari.audit import audit_staff
from synari.deps import CurrentAccess, DbSession
from synari.models import Location, Practice, PracticeSettings, Service
from synari.permissions import Capability
from synari.schemas.auth import PracticeOut
from synari.schemas.practice import (
    LocationFields,
    LocationOut,
    LocationUpdate,
    PracticeUpdate,
    ServiceFields,
    ServiceOut,
    ServiceUpdate,
    SettingsOut,
    SettingsUpdate,
)

router = APIRouter(prefix="/practice", tags=["practice"])


@router.get("", response_model=PracticeOut)
def get_practice(access: CurrentAccess) -> Practice:
    return access.staff.practice


@router.patch("", response_model=PracticeOut)
def update_practice(
    body: PracticeUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> Practice:
    """Update the practice's name, address, time zone, billing identity and booking link."""
    access.require(Capability.MANAGE_PRACTICE)
    practice = access.staff.practice
    changes = body.model_dump(exclude_unset=True)
    slug = changes.get("booking_slug")
    if slug:
        taken = db.scalar(
            select(Practice.id).where(Practice.booking_slug == slug, Practice.id != practice.id)
        )
        if taken is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "That booking link is already taken")
    for field, value in changes.items():
        setattr(practice, field, value)
    audit_staff(db, request, access.staff, "practice.update", detail={"fields": sorted(changes)})
    db.commit()
    return practice


@router.get("/settings", response_model=SettingsOut)
def get_settings(access: CurrentAccess) -> PracticeSettings:
    return access.staff.practice.settings


@router.patch("/settings", response_model=SettingsOut)
def update_settings(
    body: SettingsUpdate, access: CurrentAccess, db: DbSession, request: Request
) -> PracticeSettings:
    access.require(Capability.MANAGE_PRACTICE)
    settings = access.staff.practice.settings
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(settings, field, value)
    audit_staff(
        db, request, access.staff, "practice.settings_update", detail={"fields": sorted(changes)}
    )
    db.commit()
    return settings


@router.get("/services", response_model=list[ServiceOut])
def list_services(access: CurrentAccess) -> list[Service]:
    return list(
        access.db.scalars(
            select(Service).where(Service.practice_id == access.practice_id).order_by(Service.code)
        )
    )


def _make_only_default(db: DbSession, practice_id: int, service_id: int) -> None:
    db.execute(
        update(Service)
        .where(Service.practice_id == practice_id, Service.id != service_id)
        .values(is_default=False)
    )


@router.post("/services", response_model=ServiceOut, status_code=status.HTTP_201_CREATED)
def create_service(body: ServiceFields, access: CurrentAccess, db: DbSession) -> Service:
    access.require(Capability.MANAGE_PRACTICE)
    service = Service(practice_id=access.practice_id, **body.model_dump())
    db.add(service)
    db.flush()
    if service.is_default:
        _make_only_default(db, access.practice_id, service.id)
    db.commit()
    return service


@router.patch("/services/{service_id}", response_model=ServiceOut)
def update_service(
    service_id: int, body: ServiceUpdate, access: CurrentAccess, db: DbSession
) -> Service:
    """Edit a service. Existing appointments keep the code and fee they were booked with."""
    access.require(Capability.MANAGE_PRACTICE)
    service = access.get(Service, service_id, label="Service")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(service, field, value)
    if service.is_default:
        _make_only_default(db, access.practice_id, service.id)
    db.commit()
    return service


@router.get("/locations", response_model=list[LocationOut])
def list_locations(access: CurrentAccess) -> list[Location]:
    return list(
        access.db.scalars(
            select(Location)
            .where(Location.practice_id == access.practice_id)
            .order_by(Location.is_video, Location.name)
        )
    )


@router.post("/locations", response_model=LocationOut, status_code=status.HTTP_201_CREATED)
def create_location(
    body: LocationFields, access: CurrentAccess, db: DbSession, request: Request
) -> Location:
    access.require(Capability.MANAGE_PRACTICE)
    location = Location(practice_id=access.practice_id, **body.model_dump())
    db.add(location)
    db.flush()
    audit_staff(db, request, access.staff, "practice.location_create", "location", location.id)
    db.commit()
    return location


@router.patch("/locations/{location_id}", response_model=LocationOut)
def update_location(
    location_id: int,
    body: LocationUpdate,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
) -> Location:
    """Edit an office. Deactivate it (is_active=false) instead of deleting it."""
    access.require(Capability.MANAGE_PRACTICE)
    location = access.get(Location, location_id, label="Location")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(location, field, value)
    audit_staff(db, request, access.staff, "practice.location_update", "location", location.id)
    db.commit()
    return location
