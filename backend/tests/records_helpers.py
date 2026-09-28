"""Shared setup for the patients' rights tests (record requests, disclosures, amendments)."""

from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.db import utcnow
from synari.models import AuditEvent, Client, Note, Notification
from synari.models.enums import ClinicianAccess, NoteStatus, NoteType, Role, StaffRole
from synari.services import storage
from tests.conftest import (
    StaffAccount,
    add_staff,
    assign_clinician,
    create_client_record,
    register_practice,
)


def use_local_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Store files under a temporary directory (call from an autouse fixture)."""
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    storage.get_storage.cache_clear()


@dataclass
class Practice:
    """A group practice: the owner-clinician, the client's primary clinician, a colleague on the
    care team, someone off it, and staff without clinical access."""

    owner: StaffAccount
    primary: StaffAccount
    colleague: StaffAccount
    outsider: StaffAccount
    manager: StaffAccount
    biller: StaffAccount
    scheduler: StaffAccount
    other_owner: StaffAccount
    client: Client


def group_practice(api: TestClient, db: Session) -> Practice:
    """Build the group practice and a client whose primary clinician isn't the owner."""
    owner = register_practice(api)
    practice_id = owner.practice_id
    primary = add_staff(db, practice_id, "primary@example.com", StaffRole.CLINICIAN)
    colleague = add_staff(db, practice_id, "colleague@example.com", StaffRole.CLINICIAN)
    outsider = add_staff(db, practice_id, "outsider@example.com", StaffRole.CLINICIAN)
    manager = add_staff(db, practice_id, "manager@example.com", StaffRole.PRACTICE_MANAGER)
    biller = add_staff(db, practice_id, "biller@example.com", StaffRole.BILLER)
    scheduler = add_staff(db, practice_id, "scheduler@example.com", StaffRole.SCHEDULER)
    other_owner = register_practice(api, email="other@example.com", practice_name="Elsewhere")
    client = create_client_record(db, primary)
    assign_clinician(db, client, colleague)
    return Practice(
        owner, primary, colleague, outsider, manager, biller, scheduler, other_owner, client
    )


def clinician_with_billing(db: Session, practice_id: int, email: str) -> StaffAccount:
    """A clinician who can also see their own clients' billing."""
    return add_staff(
        db, practice_id, email, StaffRole.CLINICIAN, clinician_access=ClinicianAccess.BILLING
    )


def signed_note(
    db: Session,
    author: StaffAccount,
    client: Client,
    *,
    title: str = "Progress note",
    note_type: NoteType = NoteType.PROGRESS,
    status: NoteStatus = NoteStatus.SIGNED,
) -> Note:
    """A note written (and, unless `status` says otherwise, signed) by `author`."""
    signed = status != NoteStatus.DRAFT
    note = Note(
        practice_id=client.practice_id,
        author_id=author.id,
        client_id=client.id,
        note_type=note_type,
        format="FREEFORM",
        title=title,
        content="Session content.",
        status=status,
        signed_at=utcnow() - timedelta(hours=1) if signed else None,
        was_signed=signed,
    )
    db.add(note)
    db.flush()
    if signed:
        note.content_sha256 = note.compute_content_sha256()
    db.commit()
    return note


def staff_notifications(
    db: Session, staff: StaffAccount, kind_prefix: str = ""
) -> list[Notification]:
    """A staff member's notifications (optionally only kinds starting with `kind_prefix`)."""
    db.expire_all()
    return list(
        db.scalars(
            select(Notification)
            .where(
                Notification.recipient_role == Role.STAFF,
                Notification.recipient_id == staff.id,
                Notification.kind.startswith(kind_prefix),
            )
            .order_by(Notification.id)
        )
    )


def client_notifications(db: Session, client: Client) -> list[Notification]:
    """The client's in-app notifications, oldest first."""
    db.expire_all()
    return list(
        db.scalars(
            select(Notification)
            .where(
                Notification.recipient_role == Role.CLIENT,
                Notification.recipient_id == client.id,
            )
            .order_by(Notification.id)
        )
    )


def audit_events(db: Session, action_prefix: str) -> list[AuditEvent]:
    """Audit events whose action starts with `action_prefix`, oldest first."""
    db.expire_all()
    return list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.action.startswith(action_prefix))
            .order_by(AuditEvent.id)
        )
    )
