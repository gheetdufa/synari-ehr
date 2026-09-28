"""The authorization rules in synari/permissions.py and synari/access.py."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.models import Client, StaffMember
from synari.models.enums import ClinicianAccess, StaffRole, StaffStatus
from synari.permissions import ALL_CAPABILITIES, Capability, capabilities_for
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    register_practice,
)

PROFILE, CLINICAL, BILLING = ClientAccess.PROFILE, ClientAccess.CLINICAL, ClientAccess.BILLING


@pytest.mark.parametrize(
    ("role", "access", "expected"),
    [
        (StaffRole.OWNER, ClinicianAccess.BASIC, ALL_CAPABILITIES),
        (StaffRole.CLINICIAN, ClinicianAccess.BASIC, frozenset()),
        (StaffRole.CLINICIAN, ClinicianAccess.BILLING, {Capability.BILLING_OWN}),
        (
            StaffRole.CLINICIAN,
            ClinicianAccess.CLIENT_LIST,
            {Capability.VIEW_ALL_CLIENTS, Capability.BILLING_OWN},
        ),
        (
            StaffRole.CLINICIAN,
            ClinicianAccess.PRACTICE,
            ALL_CAPABILITIES - {Capability.MANAGE_TEAM},
        ),
        (
            StaffRole.BILLER,
            ClinicianAccess.BASIC,
            {Capability.VIEW_ALL_CLIENTS, Capability.BILLING_ALL, Capability.VIEW_REPORTS},
        ),
        (
            StaffRole.SCHEDULER,
            ClinicianAccess.BASIC,
            {Capability.VIEW_ALL_CLIENTS, Capability.SCHEDULE_ALL},
        ),
    ],
)
def test_role_capabilities(role: StaffRole, access: ClinicianAccess, expected: frozenset) -> None:
    member = StaffMember(role=role, clinician_access=access)
    assert capabilities_for(member) == frozenset(expected)


def test_no_non_clinical_role_gets_clinical_access() -> None:
    for role in (StaffRole.PRACTICE_MANAGER, StaffRole.BILLER, StaffRole.SCHEDULER):
        assert Capability.CLINICAL_ALL not in capabilities_for(StaffMember(role=role))


def _access(db: Session, account: StaffAccount) -> Access:
    return Access(db, db.get(StaffMember, account.id))


# (role, clinician_access, is_clinician, on care team) -> reachable levels
CASES = [
    (
        "basic clinician, own client",
        StaffRole.CLINICIAN,
        ClinicianAccess.BASIC,
        True,
        {PROFILE, CLINICAL},
    ),
    (
        "basic clinician, colleague's client",
        StaffRole.CLINICIAN,
        ClinicianAccess.BASIC,
        False,
        set(),
    ),
    (
        "billing clinician, own client",
        StaffRole.CLINICIAN,
        ClinicianAccess.BILLING,
        True,
        {PROFILE, CLINICAL, BILLING},
    ),
    ("billing clinician, colleague's", StaffRole.CLINICIAN, ClinicianAccess.BILLING, False, set()),
    (
        "client-list clinician, colleague's",
        StaffRole.CLINICIAN,
        ClinicianAccess.CLIENT_LIST,
        False,
        {PROFILE},
    ),
    (
        "practice clinician, colleague's",
        StaffRole.CLINICIAN,
        ClinicianAccess.PRACTICE,
        False,
        {PROFILE, CLINICAL, BILLING},
    ),
    (
        "practice manager",
        StaffRole.PRACTICE_MANAGER,
        ClinicianAccess.BASIC,
        False,
        {PROFILE, BILLING},
    ),
    ("biller", StaffRole.BILLER, ClinicianAccess.BASIC, False, {PROFILE, BILLING}),
    ("scheduler", StaffRole.SCHEDULER, ClinicianAccess.BASIC, False, {PROFILE}),
]


@pytest.mark.parametrize(
    ("role", "clinician_access", "on_team", "reachable"),
    [case[1:] for case in CASES],
    ids=[case[0] for case in CASES],
)
def test_client_access_levels(
    clinician: StaffAccount,
    db: Session,
    role: StaffRole,
    clinician_access: ClinicianAccess,
    on_team: bool,
    reachable: set[ClientAccess],
) -> None:
    client = create_client_record(db, clinician)
    member = add_staff(
        db, clinician.practice_id, "m@example.com", role, clinician_access=clinician_access
    )
    if on_team:
        assign_clinician(db, client, member)
    access = _access(db, member)
    for level in ClientAccess:
        assert access.can_access_client(client, level) == (level in reachable), level
        in_list = db.scalars(select(Client.id).where(access.client_filter(level))).all()
        assert (client.id in in_list) == (level in reachable), level
        if level not in reachable:
            with pytest.raises(HTTPException) as denied:
                access.client(client.id, level)
            assert denied.value.status_code == 404


def test_supervisor_reaches_active_supervisees_clients(
    clinician: StaffAccount, db: Session
) -> None:
    supervisor = add_staff(db, clinician.practice_id, "sup@example.com", StaffRole.CLINICIAN)
    supervisee = add_staff(
        db,
        clinician.practice_id,
        "intern@example.com",
        StaffRole.CLINICIAN,
        supervisor_id=supervisor.id,
    )
    client = create_client_record(db, supervisee)
    access = _access(db, supervisor)
    assert access.can_access_client(client, CLINICAL)
    assert access.can_access_client(client, PROFILE)
    assert not access.can_access_client(client, BILLING)

    db.get(StaffMember, supervisee.id).status = StaffStatus.DEACTIVATED
    db.commit()
    assert not _access(db, supervisor).can_access_client(client, CLINICAL)


def test_non_clinician_owner_still_reaches_everything(api: TestClient, db: Session) -> None:
    owner = register_practice(api, email="admin@example.com", is_clinician=False)
    colleague = add_staff(db, owner.practice_id, "c@example.com", StaffRole.CLINICIAN)
    client = create_client_record(db, colleague)
    access = _access(db, owner)
    assert all(access.can_access_client(client, level) for level in ClientAccess)
    # They aren't a clinician, so creating a client doesn't put them on its care team.
    assert create_client_record(db, owner, email="x@example.com").care_team == []


def test_other_practices_are_invisible(
    api: TestClient, clinician: StaffAccount, db: Session
) -> None:
    client = create_client_record(db, clinician)
    stranger = register_practice(api, email="other@example.com")
    access = _access(db, stranger)
    for level in ClientAccess:
        assert not access.can_access_client(client, level)
        assert (
            client.id not in db.scalars(select(Client.id).where(access.client_filter(level))).all()
        )
    with pytest.raises(HTTPException) as missing:
        access.get(Client, client.id)
    assert missing.value.status_code == 404


def test_calendar_management(clinician: StaffAccount, db: Session) -> None:
    colleague = add_staff(db, clinician.practice_id, "c@example.com", StaffRole.CLINICIAN)
    scheduler = add_staff(db, clinician.practice_id, "s@example.com", StaffRole.SCHEDULER)
    assert _access(db, colleague).can_manage_calendar(colleague.id)
    assert not _access(db, colleague).can_manage_calendar(clinician.id)
    assert _access(db, scheduler).can_manage_calendar(colleague.id)
    with pytest.raises(HTTPException) as denied:
        _access(db, colleague).require_calendar(clinician.id)
    assert denied.value.status_code == 403
    with pytest.raises(HTTPException):
        _access(db, colleague).clinician(scheduler.id)  # not a clinician
