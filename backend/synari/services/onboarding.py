"""Initial setup for a newly registered practice."""

from sqlalchemy.orm import Session

from synari.models import Location, Practice, PracticeSettings, Service, StaffMember
from synari.models.enums import StaffRole
from synari.services.forms_library import LIBRARY, new_template

# Common outpatient psychotherapy CPT codes. Rates start at zero so nothing is billed until the
# practice sets its own fees.
DEFAULT_SERVICES: list[dict[str, object]] = [
    {"code": "90791", "description": "Psychiatric Diagnostic Evaluation", "duration_minutes": 60},
    {
        "code": "90834",
        "description": "Psychotherapy, 45 min",
        "duration_minutes": 45,
        "is_default": True,
    },
    {"code": "90837", "description": "Psychotherapy, 60 min", "duration_minutes": 60},
    {"code": "90847", "description": "Family psychotherapy with patient", "duration_minutes": 50},
    {"code": "90853", "description": "Group psychotherapy", "duration_minutes": 90},
    {
        "code": "00000",
        "description": "Initial Consultation - No Charge",
        "duration_minutes": 15,
        "bookable_online": True,
        "bookable_by_new_clients": True,
    },
]


def create_practice(
    db: Session,
    *,
    practice_name: str,
    time_zone: str,
    owner_email: str,
    owner_password_hash: str,
    owner_first_name: str,
    owner_last_name: str,
    owner_is_clinician: bool,
) -> StaffMember:
    """Create a practice with its owner, default settings, services, video office and library
    forms. Returns the owner (caller commits)."""
    practice = Practice(
        name=practice_name or f"{owner_first_name} {owner_last_name}",
        time_zone=time_zone,
        settings=PracticeSettings(),
    )
    db.add(practice)
    db.flush()
    owner = StaffMember(
        practice_id=practice.id,
        email=owner_email,
        password_hash=owner_password_hash,
        first_name=owner_first_name,
        last_name=owner_last_name,
        role=StaffRole.OWNER,
        is_clinician=owner_is_clinician,
        time_zone=time_zone,
    )
    db.add(owner)
    db.add(
        Location(practice_id=practice.id, name="Video office", is_video=True, place_of_service="10")
    )
    for service in DEFAULT_SERVICES:
        db.add(Service(practice_id=practice.id, **service))
    for entry in LIBRARY.values():
        db.add(new_template(practice.id, entry))
    db.flush()
    return owner
