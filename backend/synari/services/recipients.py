"""Who in a practice should hear about something: realtime events and in-app notifications.

Events carry ids only, but they still go only to staff who could open the record, using the
same rules as request authorization (synari/access.py).
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import Client, StaffMember
from synari.models.enums import Role, StaffStatus
from synari.realtime import Recipient


def active_staff(db: Session, practice_id: int) -> list[StaffMember]:
    """Everyone currently working in the practice."""
    return list(
        db.scalars(
            select(StaffMember).where(
                StaffMember.practice_id == practice_id,
                StaffMember.status == StaffStatus.ACTIVE,
            )
        )
    )


def staff_with_client_access(
    db: Session, client: Client, level: ClientAccess = ClientAccess.PROFILE
) -> list[StaffMember]:
    """Active staff who may reach `client` at `level`."""
    return [
        member
        for member in active_staff(db, client.practice_id)
        if Access(db, member).can_access_client(client, level)
    ]


def as_recipients(staff: list[StaffMember]) -> list[Recipient]:
    """Realtime/notification recipient keys for staff members."""
    return [(Role.STAFF, member.id) for member in staff]


def client_team_recipients(
    db: Session, client: Client, level: ClientAccess = ClientAccess.PROFILE
) -> list[Recipient]:
    """Recipient keys for everyone who may reach `client` at `level`."""
    return as_recipients(staff_with_client_access(db, client, level))
