"""Creating what an import plan describes: clinicians, clients, contacts, insurance, past
sessions, documents and opening balances.

Every record made (or found already there) is written down as an ImportRecord keyed by its
source, in the same transaction, so an import can stop at any point (a time slice ending, a
worker restarting) and pick up where it left off, and running the same files again updates
clients rather than duplicating anything.

Clients created by an import are refreshed from the files on a later run; clients who were
already in Synari only have their blank fields filled in, so nothing entered in Synari is
overwritten.
"""

import io
import time as clock
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from functools import partial

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from synari.config import settings
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Client,
    ClientClinician,
    ClientContact,
    ImportJob,
    ImportRecord,
    InsurancePolicy,
    InvoiceItem,
    Location,
    Payer,
    Practice,
    Service,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BillingType,
    BookingSource,
    ClientStatus,
    FilePurpose,
    ImportStatus,
    InvoiceItemKind,
    LocationType,
    Role,
    StaffRole,
    StaffStatus,
)
from synari.realtime import publish
from synari.schemas.imports import ImportOptions, ImportResult, ImportWarning
from synari.services.billing import create_invoice, lock_client, lock_practice_settings
from synari.services.imports import values
from synari.services.imports.archive import PSYCHOTHERAPY_NOTES, ExportArchive
from synari.services.imports.plan import (
    Plan,
    PlannedAppointment,
    PlannedBalance,
    PlannedClient,
    PlannedContact,
    PlannedDocument,
)
from synari.services.scheduling import zone_of
from synari.services.staff import send_invitation
from synari.services.storage import store_upload

BATCH_SIZE = 25
OPENING_BALANCE = "Balance carried over from SimplePractice"
DEMOGRAPHICS_HEADING = "From SimplePractice demographics:"
EVENT = "import.updated"
_VIDEO_WORDS = ("video", "telehealth", "virtual", "online", "zoom")
_CANCELED = (AppointmentStatus.CANCELED, AppointmentStatus.LATE_CANCELED)

Task = tuple[str, str, Callable[[], None]]


def publish_progress(db: Session, job: ImportJob) -> None:
    """Tell the job's creator its status or progress changed (ids and counts only)."""
    result = job.result or {}
    publish(
        db,
        [(Role.STAFF, job.created_by_id)],
        EVENT,
        {
            "import_id": job.id,
            "status": job.status,
            "phase": result.get("phase", ""),
            "processed": result.get("processed", 0),
            "total": result.get("total", 0),
        },
    )


class Runner:
    """Works through a plan's records until done, the deadline passes or the job is canceled."""

    def __init__(
        self,
        db: Session,
        job: ImportJob,
        plan: Plan,
        archive: ExportArchive | None,
        options: ImportOptions,
        deadline: float,
    ) -> None:
        self.db = db
        self.job = job
        self.plan = plan
        self.archive = archive
        self.options = options
        self.deadline = deadline
        self.practice = db.get_one(Practice, job.practice_id)
        self.creator = db.get_one(StaffMember, job.created_by_id)
        self.result = ImportResult.model_validate(job.result or {})
        self.pending = 0
        records = db.scalars(
            select(ImportRecord)
            .where(ImportRecord.practice_id == job.practice_id)
            .order_by(ImportRecord.id)
        ).all()
        self.done = {(r.kind, r.source_key) for r in records if r.job_id == job.id}
        # The latest record for each source (this job's or an earlier import's).
        self.previous = {(r.kind, r.source_key): r for r in records}
        self.client_ids = {
            key: record.target_id
            for (kind, key), record in self.previous.items()
            if kind == "client" and record.target_id is not None
        }
        self.default_clinician_id = self._valid_clinician(options.default_clinician_id)
        self.payers: dict[str, Payer] = {}
        self.services = {
            s.code: s
            for s in db.scalars(
                select(Service).where(Service.practice_id == job.practice_id, Service.is_active)
            )
        }
        self.locations = {
            loc.name.strip().lower(): loc
            for loc in db.scalars(
                select(Location).where(Location.practice_id == job.practice_id, Location.is_active)
            )
        }
        self.today = today_in(self.practice)

    # Bookkeeping --------------------------------------------------------------------------------

    def _valid_clinician(self, staff_id: int | None) -> int | None:
        if staff_id is None:
            return None
        staff = self.db.get(StaffMember, staff_id)
        usable = (
            staff is not None
            and staff.practice_id == self.job.practice_id
            and staff.is_clinician
            and staff.status in (StaffStatus.ACTIVE, StaffStatus.INVITED)
        )
        return staff_id if usable else None

    def _staff_for(self, clinician_key: str) -> int | None:
        target = self.plan.choices.get(clinician_key)
        if target is None:
            return self.default_clinician_id
        if target.invite is not None:
            record = self.previous.get(("clinician", clinician_key))
            if record is not None and record.target_id is not None:
                return record.target_id
        return self._valid_clinician(target.staff_id) or self.default_clinician_id

    def _record(self, kind: str, key: str, target_id: int | None, outcome: str) -> None:
        record = ImportRecord(
            job_id=self.job.id,
            practice_id=self.job.practice_id,
            kind=kind,
            source_key=key[:300],
            target_id=target_id,
            outcome=outcome,
        )
        self.db.add(record)
        self.previous[(kind, key)] = record
        counts = {
            "created": self.result.created,
            "updated": self.result.updated,
            "skipped": self.result.skipped,
        }.get(outcome, self.result.skipped)
        counts[kind] = counts.get(kind, 0) + 1

    def warn(self, code: str, message: str) -> None:
        """Count a warning; `message` is a values.counted() template."""
        found = next((w for w in self.result.warnings if w.code == code), None)
        if found is None:
            found = ImportWarning(code=code, message="", count=0)
            self.result.warnings.append(found)
        found.count += 1
        found.message = values.counted(message, found.count)

    def save_progress(self) -> None:
        """Store the counts on the job and tell its creator (caller commits)."""
        self.job.result = self.result.model_dump(mode="json")
        publish_progress(self.db, self.job)

    def _checkpoint(self) -> bool:
        """Commit the batch; False when the slice should stop (time's up or canceled)."""
        self.save_progress()
        self.db.commit()
        self.pending = 0
        self.db.refresh(self.job, attribute_names=["status"])
        return self.job.status == ImportStatus.IMPORTING and clock.monotonic() < self.deadline

    # The work -----------------------------------------------------------------------------------

    def tasks(self) -> list[Task]:
        plan, options = self.plan, self.options
        tasks: list[Task] = [
            ("clinician", key, partial(self._invite, key))
            for key, target in plan.choices.items()
            if target.invite is not None
        ]
        tasks += [("client", c.key, partial(self._client, c)) for c in plan.clients]
        if options.import_contacts:
            tasks += [
                ("contact", f"{c.key}|{contact.key}", partial(self._contact, c, contact))
                for c in plan.clients
                for contact in c.contacts.values()
            ]
        if options.import_insurance:
            tasks += [
                ("policy", f"{c.key}|primary", partial(self._policy, c))
                for c in plan.clients
                if c.policy is not None
            ]
        if options.import_appointments:
            tasks += [
                ("appointment", a.key, partial(self._appointment, a)) for a in plan.appointments
            ]
        if options.import_documents and self.archive is not None:
            tasks += [("document", d.key, partial(self._document, d)) for d in plan.documents]
        if options.import_balances:
            tasks += [("balance", b.key, partial(self._balance, b)) for b in plan.balances]
        return tasks

    def run(self) -> bool:
        """Process records until finished (True) or until the slice must stop (False)."""
        tasks = self.tasks()
        self.result.total = len(tasks)
        self.result.processed = sum(1 for kind, key, _ in tasks if (kind, key) in self.done)
        for kind, key, action in tasks:
            if (kind, key) in self.done:
                continue
            self.result.phase = f"{kind}s" if kind != "policy" else "policies"
            action()
            self.done.add((kind, key))
            self.result.processed += 1
            self.pending += 1
            if self.pending >= BATCH_SIZE and not self._checkpoint():
                return False
        self.result.processed = self.result.total
        return True

    def _invite(self, key: str) -> None:
        invite = self.plan.choices[key].invite
        if invite is None:
            return
        staff = self.db.scalar(select(StaffMember).where(StaffMember.email == invite.email))
        if staff is not None:
            if staff.practice_id == self.job.practice_id and staff.is_clinician:
                self._record("clinician", key, staff.id, "updated")
                return
            self.warn(
                "invite_email_taken",
                "{n} clinician{s} couldn't be invited because the email already has an "
                "account; their clients and sessions went to the default clinician",
            )
            self._record("clinician", key, None, "skipped")
            return
        staff = StaffMember(
            practice_id=self.job.practice_id,
            email=invite.email,
            first_name=invite.first_name.strip(),
            last_name=invite.last_name.strip(),
            status=StaffStatus.INVITED,
            role=StaffRole.CLINICIAN,
            is_clinician=True,
            time_zone=self.practice.time_zone,
        )
        self.db.add(staff)
        self.db.flush()
        send_invitation(self.db, staff, self.creator)
        self._record("clinician", key, staff.id, "created")

    def _email_available(self, email: str, client_id: int | None) -> bool:
        taken = self.db.scalar(
            select(Client.id).where(
                Client.practice_id == self.job.practice_id,
                func.lower(Client.email) == email,
                Client.id != (client_id or 0),
            )
        )
        return taken is None

    def _client(self, planned: PlannedClient) -> None:
        client = None
        if planned.existing_id is not None:
            client = self.db.get(Client, planned.existing_id)
            if client is not None and client.practice_id != self.job.practice_id:
                client = None
        created = client is None
        overwrite = created or planned.created_by_import
        if client is None:
            client = Client(
                practice_id=self.job.practice_id,
                first_name=planned.first_name,
                last_name=planned.last_name,
                status=ClientStatus.ACTIVE,
                billing_type=BillingType.SELF_PAY,
            )
            self.db.add(client)
        self._fill(client, planned, overwrite=overwrite)
        self.db.flush()
        self._care_team(client, planned)
        self.client_ids[planned.key] = client.id
        self._record("client", planned.key, client.id, "created" if created else "updated")

    def _fill(self, client: Client, planned: PlannedClient, *, overwrite: bool) -> None:
        texts = {
            "first_name": planned.first_name,
            "last_name": planned.last_name,
            "preferred_name": planned.preferred_name,
            "sex": planned.sex,
            "gender_identity": planned.gender_identity,
            "phone": planned.phones[0] if planned.phones else "",
            "address_line1": planned.address_line1,
            "address_line2": planned.address_line2,
            "city": planned.city,
            "state": planned.state,
            "postal_code": planned.postal_code,
        }
        for name, value in texts.items():
            if value and (overwrite or not getattr(client, name)):
                setattr(client, name, value)
        if planned.birth and (overwrite or client.date_of_birth is None):
            client.date_of_birth = planned.birth
        email = next((e for e in planned.emails), "")
        if email and (overwrite or not client.email) and email != (client.email or "").lower():
            if self._email_available(email, client.id):
                client.email = email
            else:
                self.warn(
                    "shared_email",
                    "{n} client{s} share{v} an email address with another client, so it was "
                    "left off (Synari needs a different email per client)",
                )
        if overwrite:
            client.status = planned.status or ClientStatus.ACTIVE
            client.is_minor = bool(planned.is_minor)
            client.billing_type = planned.billing_type or BillingType.SELF_PAY
        codes = list(client.diagnosis_codes or [])
        for code in planned.diagnoses:
            if all(existing.get("code") != code["code"] for existing in codes):
                codes.append(code)
        if codes != (client.diagnosis_codes or []):
            client.diagnosis_codes = codes
        if planned.demographics and DEMOGRAPHICS_HEADING not in (client.internal_notes or ""):
            block = "\n".join([DEMOGRAPHICS_HEADING, *planned.demographics])
            client.internal_notes = "\n\n".join(p for p in (client.internal_notes, block) if p)

    def _care_team(self, client: Client, planned: PlannedClient) -> None:
        primary_id = self._staff_for(planned.clinician_key)
        others = [self._staff_for(key) for key in planned.session_clinicians]
        members = {member.staff_id: member for member in client.care_team}
        has_primary = any(member.is_primary for member in client.care_team)
        for staff_id in dict.fromkeys([primary_id, *others]):
            if staff_id is None or staff_id in members:
                continue
            is_primary = not has_primary and staff_id == primary_id
            member = ClientClinician(staff_id=staff_id, is_primary=is_primary)
            client.care_team.append(member)
            members[staff_id] = member
            has_primary = has_primary or is_primary
        self.db.flush()

    def _client_row(self, planned: PlannedClient) -> Client | None:
        client_id = self.client_ids.get(planned.key)
        client = self.db.get(Client, client_id) if client_id is not None else None
        if client is None or client.practice_id != self.job.practice_id:
            return None
        return client

    def _contact(self, planned: PlannedClient, contact: PlannedContact) -> None:
        key = f"{planned.key}|{contact.key}"
        client = self._client_row(planned)
        if client is None:
            self._record("contact", key, None, "skipped")
            return
        found = next(
            (c for c in client.contacts if values.name_key(c.full_name) == contact.key), None
        )
        if found is None:
            found = ClientContact(
                first_name=contact.first_name,
                last_name=contact.last_name,
                relation=contact.relation,
                email=contact.email or None,
                phone=contact.phone,
                is_emergency_contact=contact.is_emergency_contact,
                is_guardian=contact.is_guardian,
            )
            client.contacts.append(found)
            self.db.flush()
            self._record("contact", key, found.id, "created")
            return
        found.relation = found.relation or contact.relation
        found.email = found.email or contact.email or None
        found.phone = found.phone or contact.phone
        found.is_emergency_contact = found.is_emergency_contact or contact.is_emergency_contact
        found.is_guardian = found.is_guardian or contact.is_guardian
        self._record("contact", key, found.id, "updated")

    def _payer(self, name: str, external_id: str) -> Payer:
        cache_key = external_id.lower() or name.strip().lower()
        if cache_key in self.payers:
            return self.payers[cache_key]
        query = select(Payer).where(Payer.practice_id == self.job.practice_id)
        payer = None
        if external_id:
            payer = self.db.scalars(query.where(Payer.external_id == external_id)).first()
        if payer is None:
            payer = self.db.scalars(
                query.where(func.lower(Payer.name) == name.strip().lower())
            ).first()
        if payer is None:
            payer = Payer(
                practice_id=self.job.practice_id, name=name.strip(), external_id=external_id
            )
            self.db.add(payer)
            self.db.flush()
            self.result.created["payer"] = self.result.created.get("payer", 0) + 1
        self.payers[cache_key] = payer
        return payer

    def _policy(self, planned: PlannedClient) -> None:
        key = f"{planned.key}|primary"
        policy = planned.policy
        client = self._client_row(planned)
        if client is None or policy is None:
            self._record("policy", key, None, "skipped")
            return
        payer = self._payer(policy.payer_name, policy.payer_external_id)
        previous = self.previous.get(("policy", key))
        ours = next(
            (p for p in client.insurance_policies if previous and p.id == previous.target_id), None
        )
        current = ours or next((p for p in client.insurance_policies if p.rank == "primary"), None)
        if current is not None and ours is None and current.payer_id != payer.id:
            self.warn(
                "had_insurance",
                "{n} client{s} already had other primary insurance in Synari, so the policy "
                "from SimplePractice wasn't added",
            )
            self._record("policy", key, current.id, "skipped")
            return
        created = current is None
        if current is None:
            current = InsurancePolicy(payer_id=payer.id, rank="primary")
            client.insurance_policies.append(current)
        overwrite = created or ours is not None
        fields = {
            "member_id": policy.member_id,
            "group_number": policy.group_number,
            "subscriber_first_name": policy.subscriber_first_name,
            "subscriber_last_name": policy.subscriber_last_name,
            "subscriber_sex": policy.subscriber_sex,
            "subscriber_address_line1": policy.subscriber_address_line1,
            "subscriber_city": policy.subscriber_city,
            "subscriber_state": policy.subscriber_state,
            "subscriber_postal_code": policy.subscriber_postal_code,
        }
        for name, value in fields.items():
            if value and (overwrite or not getattr(current, name)):
                setattr(current, name, value)
        if overwrite:
            current.payer_id = payer.id
            current.subscriber_relationship = policy.subscriber_relationship
        if policy.subscriber_dob and (overwrite or current.subscriber_dob is None):
            current.subscriber_dob = policy.subscriber_dob
        if policy.copay_cents is not None and (overwrite or current.copay_cents is None):
            current.copay_cents = policy.copay_cents
        self.db.flush()
        self._record("policy", key, current.id, "created" if created else "updated")

    def _location(self, text: str) -> tuple[str, int | None, str]:
        """(location type, location id, details) for an attendance report's location."""
        if not text:
            return LocationType.IN_PERSON, None, ""
        location = self.locations.get(text.strip().lower())
        if location is not None:
            kind = LocationType.VIDEO if location.is_video else LocationType.IN_PERSON
            return kind, location.id, ""
        lowered = text.lower()
        if any(word in lowered for word in _VIDEO_WORDS):
            return LocationType.VIDEO, None, text
        if "phone" in lowered:
            return LocationType.PHONE, None, text
        return LocationType.IN_PERSON, None, text

    def _appointment(self, planned: PlannedAppointment) -> None:
        previous = self.previous.get(("appointment", planned.key))
        if previous is not None and previous.target_id is not None:
            self._record("appointment", planned.key, previous.target_id, "skipped")
            return
        client_plan = self.plan.client(planned.client_key)
        client = self._client_row(client_plan)
        clinician_id = self._staff_for(planned.clinician_key) if planned.clinician_key else None
        clinician_id = clinician_id or self._staff_for(client_plan.clinician_key)
        clinician = self.db.get(StaffMember, clinician_id) if clinician_id else None
        if client is None or clinician is None:
            self.warn(
                "session_without_clinician",
                "{n} session{s} had no clinician to go on and {were} skipped",
            )
            self._record("appointment", planned.key, None, "skipped")
            return
        starts_at = datetime.combine(planned.day, planned.start, tzinfo=zone_of(clinician))
        service = self.services.get(planned.cpt)
        location_type, location_id, details = self._location(planned.location)
        appointment = Appointment(
            practice_id=self.job.practice_id,
            clinician_id=clinician.id,
            kind=AppointmentKind.APPOINTMENT,
            service_id=service.id if service else None,
            service_code=planned.cpt,
            service_description=(
                service.description
                if service
                else (f"Imported session ({planned.cpt})" if planned.cpt else "Imported session")
            ),
            starts_at=starts_at.astimezone(UTC),
            ends_at=(starts_at + timedelta(minutes=planned.minutes)).astimezone(UTC),
            location_type=location_type,
            location_id=location_id,
            location_details=details,
            status=planned.status,
            source=BookingSource.IMPORT,
            canceled_at=starts_at.astimezone(UTC) if planned.status in _CANCELED else None,
            participants=[
                AppointmentParticipant(client_id=client.id, fee_cents=planned.fee_cents or 0)
            ],
        )
        self.db.add(appointment)
        self.db.flush()
        self._record("appointment", planned.key, appointment.id, "created")

    def _document(self, planned: PlannedDocument) -> None:
        previous = self.previous.get(("document", planned.key))
        if previous is not None and previous.target_id is not None:
            self._record("document", planned.key, previous.target_id, "skipped")
            return
        client_plan = self.plan.client(planned.client_key)
        client = self._client_row(client_plan)
        data = (
            self.archive.read(planned.entry, settings.max_upload_bytes)
            if client is not None and self.archive is not None
            else None
        )
        if client is None or data is None:
            self.warn(
                "unreadable_document",
                "{n} document{s} couldn't be read from the export (damaged or too large) and "
                "{were} skipped",
            )
            self._record("document", planned.key, None, "failed")
            return
        author: int | None = self.creator.id
        if planned.entry.category == PSYCHOTHERAPY_NOTES:
            # Psychotherapy notes are for their author only: the primary clinician. Without
            # one they stay closed to everyone (not the importer) until one is assigned.
            primary = client.primary_clinician
            author = primary.id if primary is not None else None
            if primary is None:
                self.warn(
                    "psychotherapy_notes_without_clinician",
                    "{n} psychotherapy note{s} {were} for clients without a primary clinician "
                    "and can't be opened until one is assigned",
                )
        try:
            stored = store_upload(
                self.db,
                UploadFile(file=io.BytesIO(data), filename=planned.entry.filename),
                practice_id=self.job.practice_id,
                client_id=client.id,
                purpose=FilePurpose.IMPORTED_DOCUMENT,
                uploaded_by=Role.STAFF,
                uploaded_by_staff_id=author,
            )
        except HTTPException:
            self.warn(
                "rejected_document",
                "{n} document{s} {were} empty or of a type Synari doesn't store and {were} skipped",
            )
            self._record("document", planned.key, None, "skipped")
            return
        stored.category = planned.entry.category[:80]
        self._record("document", planned.key, stored.id, "created")

    def _balance(self, planned: PlannedBalance) -> None:
        previous = self.previous.get(("balance", planned.key))
        if previous is not None and previous.target_id is not None:
            self._record("balance", planned.key, previous.target_id, "skipped")
            return
        client_plan = self.plan.client(planned.client_key)
        found = self._client_row(client_plan)
        if found is None:
            self._record("balance", planned.key, None, "skipped")
            return
        practice_settings = lock_practice_settings(self.db, self.job.practice_id)
        client = lock_client(self.db, found.id)
        item = InvoiceItem(
            kind=InvoiceItemKind.CUSTOM,
            service_date=self.today,
            description=OPENING_BALANCE,
            amount_cents=planned.amount_cents,
        )
        invoice = create_invoice(self.db, practice_settings, client, [item], self.today)
        self._record("balance", planned.key, invoice.id, "created")


def today_in(practice: Practice) -> date:
    """The practice's calendar date."""
    return datetime.now(zone_of(practice)).date()
