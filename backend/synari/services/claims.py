"""Insurance claims: create, correct, void and submit them, and tell staff what changed.

Claims bill attended, billable appointment participants of one client to one insurance
policy. The claim documents the claims engine validates, sends and prints are built in
claims_document.py; clearinghouse responses and remittances are handled in
claims_responses.py.

Claim numbers (patient control numbers) are "SYN", the practice id in base 36 padded to four
characters, then the practice's claim counter: unique across every practice on the server
(the Stedi account is shared) and at most 17 characters. Line control numbers are the claim
number plus "-<line>", so they are unique too.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import ColumnElement, Select, exists, func, select
from sqlalchemy.orm import Session

from synari.access import Access, ClientAccess
from synari.claims import document as doc
from synari.claims.cms1500 import cms1500_pdf
from synari.claims.document import ClaimDocument
from synari.claims.x12 import Envelope
from synari.claims.x12_837p import build_837p
from synari.db import utcnow
from synari.models import (
    Appointment,
    AppointmentParticipant,
    Claim,
    ClaimEvent,
    ClaimLine,
    Client,
    InsurancePolicy,
    Location,
    Practice,
    PracticeSettings,
    StaffMember,
)
from synari.models.enums import (
    AppointmentKind,
    AppointmentStatus,
    BookingSource,
    ClaimStatus,
    ClaimSubmissionMethod,
    LocationType,
    Role,
    SupervisedBilling,
)
from synari.permissions import Capability
from synari.realtime import publish
from synari.services.billing import local_date, lock_practice_settings
from synari.services.claims_document import (
    claim_document,
    document_snapshot,
    phone_digits,
    policy_active_on,
)
from synari.services.notifications import notify, short_name
from synari.services.recipients import client_team_recipients, staff_with_client_access
from synari.services.scheduling import zone_of

EVENT_CLAIMS_CHANGED = "claims.changed"
MAX_DATES_PER_CLAIM = 6
MAX_DIAGNOSES = 12
MAX_POINTERS = 4
MAX_MODIFIERS = 4
POS_TELEHEALTH_HOME = "10"
POS_TELEHEALTH_ELSEWHERE = "02"
POS_OFFICE = "11"
RESPONSIBILITY_BY_RANK = {"primary": "P", "secondary": "S", "tertiary": "T"}
# Claims that can still be edited and (re)submitted.
EDITABLE_STATUSES = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)
# Claims the payer received, which can be corrected (frequency 7) or voided (frequency 8).
ADJUDICABLE_STATUSES = (
    ClaimStatus.SUBMITTED,
    ClaimStatus.ACCEPTED,
    ClaimStatus.PAID,
    ClaimStatus.DENIED,
)
_BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def require_billing(access: Access) -> None:
    """403 unless the role has billing access to at least some clients."""
    if not (access.can(Capability.BILLING_ALL) or access.can(Capability.BILLING_OWN)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't include billing")


# Numbers, dates and policies ---------------------------------------------------------------


def _base36(number: int) -> str:
    text = ""
    while True:
        number, remainder = divmod(number, 36)
        text = _BASE36[remainder] + text
        if number == 0:
            return text


def patient_control_number(practice_id: int, counter: int) -> str:
    """Our claim number, e.g. "SYN00DX42" for practice 501's 42nd claim."""
    return f"SYN{_base36(practice_id).rjust(4, '0')}{counter}"


def next_patient_control_number(practice_settings: PracticeSettings) -> str:
    """Advance the practice's claim counter. The caller holds the settings row lock."""
    practice_settings.claim_counter += 1
    return patient_control_number(practice_settings.practice_id, practice_settings.claim_counter)


def service_date(appointment: Appointment, practice: Practice) -> date:
    """The date of service, in the practice's time zone."""
    return local_date(appointment.starts_at, zone_of(practice))


def active_policy(client: Client, rank: str, day: date) -> InsurancePolicy | None:
    """The client's policy of `rank` (primary, secondary...) that covered `day`."""
    return next(
        (
            policy
            for policy in client.insurance_policies
            if policy.rank == rank and policy_active_on(policy, day)
        ),
        None,
    )


def authorization_number(policy: InsurancePolicy, day: date) -> str:
    """The prior authorization number valid on `day`, if there is one."""
    return next(
        (auth.number for auth in policy.authorizations if auth.start_date <= day <= auth.end_date),
        "",
    )


def client_diagnosis_codes(client: Client) -> list[str]:
    """The client's diagnoses as claim codes: capitals, no dot, no repeats, at most 12."""
    codes: list[str] = []
    for entry in client.diagnosis_codes:
        code = str(entry.get("code", "")).strip().upper().replace(".", "")
        if code and code not in codes:
            codes.append(code)
    return codes[:MAX_DIAGNOSES]


def default_pointers(diagnosis_count: int) -> list[int]:
    """Point each line at the first four diagnoses."""
    return list(range(1, min(diagnosis_count, MAX_POINTERS) + 1))


def is_video(appointment: Appointment) -> bool:
    """Whether the session was held by video (a video appointment or the video office)."""
    return appointment.location_type == LocationType.VIDEO or bool(
        appointment.location is not None and appointment.location.is_video
    )


def place_of_service(db: Session, appointment: Appointment) -> str:
    """The location's code, else by how the session was held (video uses the video office's)."""
    if appointment.location is not None and appointment.location.place_of_service:
        return appointment.location.place_of_service
    if appointment.location_type == LocationType.VIDEO:
        video_office = db.scalars(
            select(Location)
            .where(
                Location.practice_id == appointment.practice_id,
                Location.is_video,
                Location.is_active,
            )
            .order_by(Location.id)
        ).first()
        return video_office.place_of_service if video_office else POS_TELEHEALTH_HOME
    if appointment.location_type == LocationType.PHONE:
        return POS_TELEHEALTH_ELSEWHERE
    return POS_OFFICE


def line_modifiers(practice_settings: PracticeSettings, appointment: Appointment) -> list[str]:
    """The telehealth modifier for video sessions, then the clinician's licensure modifier."""
    modifiers = []
    if is_video(appointment) and practice_settings.telehealth_modifier:
        modifiers.append(practice_settings.telehealth_modifier)
    modifiers.append(appointment.clinician.claim_modifier)
    return list(dict.fromkeys(m for m in modifiers if m))[:MAX_MODIFIERS]


def claim_clinicians(
    db: Session, practice_settings: PracticeSettings, clinician: StaffMember
) -> tuple[int, int | None]:
    """Rendering and supervising clinician ids for a session with `clinician`.

    A supervisee's sessions name their supervisor as rendering provider, or (when the practice
    bills under the supervisee) name the supervisor as supervising provider. Licensure
    modifiers such as U5 are not added automatically.
    """
    supervisor = db.get(StaffMember, clinician.supervisor_id) if clinician.supervisor_id else None
    if supervisor is None:
        return clinician.id, None
    if practice_settings.supervised_billing == SupervisedBilling.SUPERVISOR_RENDERS:
        return supervisor.id, None
    return clinician.id, supervisor.id


# Which sessions can be billed --------------------------------------------------------------


def on_live_claim() -> ColumnElement[bool]:
    """SQL: the participant is on a claim that isn't void."""
    return exists().where(
        ClaimLine.participant_id == AppointmentParticipant.id,
        ClaimLine.claim_id == Claim.id,
        Claim.status != ClaimStatus.VOID,
    )


def attended() -> ColumnElement[bool]:
    """SQL: the participant attended (their own attendance, else the session's status)."""
    return (
        func.coalesce(AppointmentParticipant.attendance, Appointment.status)
        == AppointmentStatus.ATTENDED
    )


def unbilled_participants(practice_id: int) -> Select[tuple[AppointmentParticipant]]:
    """Attended, billable sessions of the practice that aren't on a live claim (imported
    history is never claimed)."""
    return (
        select(AppointmentParticipant)
        .join(Appointment, Appointment.id == AppointmentParticipant.appointment_id)
        .join(Client, Client.id == AppointmentParticipant.client_id)
        .where(
            Appointment.practice_id == practice_id,
            Appointment.kind == AppointmentKind.APPOINTMENT,
            Appointment.source != BookingSource.IMPORT,
            AppointmentParticipant.billable,
            attended(),
            ~on_live_claim(),
        )
    )


def claim_blocker(db: Session, participant: AppointmentParticipant) -> str | None:
    """Why this session can't go on a new claim, or None when it can."""
    appointment = participant.appointment
    when = f"{service_date(appointment, participant.client.practice):%m/%d/%Y}"
    if appointment.kind != AppointmentKind.APPOINTMENT or not participant.billable:
        return f"The session on {when} isn't billable."
    if appointment.source == BookingSource.IMPORT:
        return f"The session on {when} was imported and was billed before."
    if participant.effective_status != AppointmentStatus.ATTENDED:
        return f"The session on {when} isn't marked attended."
    db.flush()
    billed = db.scalar(
        select(AppointmentParticipant.id).where(
            AppointmentParticipant.id == participant.id, on_live_claim()
        )
    )
    return f"The session on {when} is already on a claim." if billed else None


# Creating claims ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _PlannedLine:
    participant: AppointmentParticipant
    service_date: date
    rendering_id: int
    supervising_id: int | None
    authorization: str


def _by_service_dates(lines: list[_PlannedLine]) -> list[list[_PlannedLine]]:
    """Split lines (sorted by date) into claims of at most MAX_DATES_PER_CLAIM dates each."""
    chunks: list[list[_PlannedLine]] = []
    dates: set[date] = set()
    for line in lines:
        if not chunks or (line.service_date not in dates and len(dates) == MAX_DATES_PER_CLAIM):
            chunks.append([])
            dates = set()
        chunks[-1].append(line)
        dates.add(line.service_date)
    return chunks


def add_event(
    claim: Claim,
    kind: str,
    message: str,
    *,
    staff_id: int | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Record something that happened to the claim."""
    claim.events.append(ClaimEvent(kind=kind, message=message, staff_id=staff_id, data=data))


def create_claims(
    db: Session,
    client: Client,
    participants: Sequence[AppointmentParticipant],
    policy: InsurancePolicy,
    payer_responsibility: str,
    staff_id: int | None,
) -> list[Claim]:
    """Draft claims for these sessions of one client.

    Sessions are grouped by rendering/supervising clinician and prior authorization, then
    split so no claim has more than six dates of service.
    """
    practice = client.practice
    practice_settings = lock_practice_settings(db, practice.id)
    groups: dict[tuple[int, int | None, str], list[_PlannedLine]] = {}
    ordered = sorted(participants, key=lambda p: (p.appointment.starts_at, p.id))
    for participant in ordered:
        appointment = participant.appointment
        day = service_date(appointment, practice)
        rendering_id, supervising_id = claim_clinicians(
            db, practice_settings, appointment.clinician
        )
        authorization = authorization_number(policy, day)
        line = _PlannedLine(participant, day, rendering_id, supervising_id, authorization)
        groups.setdefault((rendering_id, supervising_id, authorization), []).append(line)

    diagnoses = client_diagnosis_codes(client)
    claims = []
    for (rendering_id, supervising_id, authorization), planned in groups.items():
        for chunk in _by_service_dates(planned):
            number = next_patient_control_number(practice_settings)
            lines = [
                ClaimLine(
                    participant_id=line.participant.id,
                    line_control_number=f"{number}-{index}",
                    service_date=line.service_date,
                    procedure_code=line.participant.appointment.service_code.strip().upper(),
                    modifiers=line_modifiers(practice_settings, line.participant.appointment),
                    units=1,
                    charge_cents=line.participant.fee_cents,
                    place_of_service=place_of_service(db, line.participant.appointment),
                    diagnosis_pointers=default_pointers(len(diagnoses)),
                )
                for index, line in enumerate(chunk, start=1)
            ]
            claim = Claim(
                practice_id=practice.id,
                client_id=client.id,
                policy_id=policy.id,
                payer_id=policy.payer_id,
                payer_responsibility=payer_responsibility,
                status=ClaimStatus.DRAFT,
                patient_control_number=number,
                frequency_code="1",
                rendering_clinician_id=rendering_id,
                supervising_clinician_id=supervising_id,
                place_of_service=lines[0].place_of_service,
                prior_authorization_number=authorization,
                diagnosis_codes=list(diagnoses),
                total_charge_cents=sum(line.charge_cents for line in lines),
                created_by_id=staff_id,
                lines=lines,
            )
            add_event(claim, "created", "Claim created", staff_id=staff_id)
            db.add(claim)
            claims.append(claim)
    db.flush()
    return claims


def successor_claim(db: Session, claim: Claim) -> Claim | None:
    """A live correction or void that already replaces this claim."""
    return db.scalars(
        select(Claim)
        .where(Claim.original_claim_id == claim.id, Claim.status != ClaimStatus.VOID)
        .order_by(Claim.id)
    ).first()


def _clone(
    db: Session,
    source: Claim,
    *,
    policy: InsurancePolicy,
    payer_responsibility: str,
    frequency_code: str,
    staff_id: int | None,
    original_claim_id: int | None = None,
    primary_claim_id: int | None = None,
    payer_claim_number: str = "",
) -> Claim:
    """A new draft claim with the same services as `source` and its own numbers."""
    practice_settings = lock_practice_settings(db, source.practice_id)
    number = next_patient_control_number(practice_settings)
    claim = Claim(
        practice_id=source.practice_id,
        client_id=source.client_id,
        policy_id=policy.id,
        payer_id=policy.payer_id,
        payer_responsibility=payer_responsibility,
        status=ClaimStatus.DRAFT,
        submission_method=source.submission_method,
        patient_control_number=number,
        frequency_code=frequency_code,
        original_claim_id=original_claim_id,
        primary_claim_id=primary_claim_id,
        payer_claim_number=payer_claim_number,
        rendering_clinician_id=source.rendering_clinician_id,
        supervising_clinician_id=source.supervising_clinician_id,
        place_of_service=source.place_of_service,
        prior_authorization_number=source.prior_authorization_number,
        diagnosis_codes=list(source.diagnosis_codes),
        total_charge_cents=source.total_charge_cents,
        created_by_id=staff_id,
        lines=[
            ClaimLine(
                participant_id=line.participant_id,
                line_control_number=f"{number}-{index}",
                service_date=line.service_date,
                procedure_code=line.procedure_code,
                modifiers=list(line.modifiers),
                units=line.units,
                charge_cents=line.charge_cents,
                place_of_service=line.place_of_service,
                diagnosis_pointers=list(line.diagnosis_pointers),
            )
            for index, line in enumerate(source.lines, start=1)
        ],
    )
    db.add(claim)
    return claim


def correct_claim(db: Session, claim: Claim, staff_id: int | None) -> Claim:
    """A draft replacement (frequency 7) for a claim the payer already has."""
    replacement = _clone(
        db,
        claim,
        policy=claim.policy,
        payer_responsibility=claim.payer_responsibility,
        frequency_code="7",
        staff_id=staff_id,
        original_claim_id=claim.id,
        payer_claim_number=claim.payer_claim_number,
    )
    add_event(
        replacement,
        "created",
        f"Correction of claim {claim.patient_control_number}",
        staff_id=staff_id,
    )
    db.flush()
    add_event(
        claim,
        "corrected",
        f"Replaced by corrected claim {replacement.patient_control_number}",
        staff_id=staff_id,
        data={"claim_id": replacement.id},
    )
    return replacement


def void_claim(db: Session, claim: Claim, staff_id: int | None) -> Claim:
    """Void a claim: directly if the payer never got it, else via a frequency 8 claim to send."""
    if claim.status not in ADJUDICABLE_STATUSES:
        claim.status = ClaimStatus.VOID
        add_event(claim, "voided", "Claim voided", staff_id=staff_id)
        return claim
    void = _clone(
        db,
        claim,
        policy=claim.policy,
        payer_responsibility=claim.payer_responsibility,
        frequency_code="8",
        staff_id=staff_id,
        original_claim_id=claim.id,
        payer_claim_number=claim.payer_claim_number,
    )
    add_event(void, "created", f"Void of claim {claim.patient_control_number}", staff_id=staff_id)
    db.flush()
    add_event(
        claim,
        "void_requested",
        f"Void claim {void.patient_control_number} created; submit it to cancel this claim",
        staff_id=staff_id,
        data={"claim_id": void.id},
    )
    return void


def secondary_claim(
    db: Session, claim: Claim, policy: InsurancePolicy, staff_id: int | None
) -> Claim:
    """A draft claim to the client's secondary policy for what the primary claim left over."""
    secondary = _clone(
        db,
        claim,
        policy=policy,
        payer_responsibility=RESPONSIBILITY_BY_RANK.get(policy.rank, "S"),
        frequency_code="1",
        staff_id=staff_id,
        primary_claim_id=claim.id,
    )
    add_event(
        secondary,
        "created",
        f"Secondary claim after {claim.patient_control_number}",
        staff_id=staff_id,
    )
    db.flush()
    add_event(
        claim,
        "secondary_created",
        f"Secondary claim {secondary.patient_control_number} created",
        staff_id=staff_id,
        data={"claim_id": secondary.id},
    )
    return secondary


# Submission --------------------------------------------------------------------------------


def mark_submitted(
    claim: Claim,
    method: ClaimSubmissionMethod,
    document: ClaimDocument,
    *,
    message: str,
    staff_id: int | None = None,
    reference: str = "",
) -> None:
    """Record a submission and snapshot exactly what was sent."""
    claim.status = ClaimStatus.SUBMITTED
    claim.submission_method = method
    claim.submitted_at = utcnow()
    claim.snapshot = document_snapshot(document)
    claim.clearinghouse_ref = reference
    claim.last_error = ""
    add_event(claim, "submitted", message, staff_id=staff_id, data={"method": method})


def queue_for_stedi(claim: Claim, staff_id: int | None) -> None:
    """Hand the claim to the worker, which sends it to Stedi."""
    claim.status = ClaimStatus.QUEUED
    claim.submission_method = ClaimSubmissionMethod.STEDI
    claim.last_error = ""
    add_event(claim, "queued", "Queued for electronic submission", staff_id=staff_id)


def export_837p(
    db: Session, practice: Practice, claims: Sequence[Claim], staff_id: int | None
) -> tuple[str, int]:
    """One 837P file for `claims` (marked submitted) and its interchange control number."""
    practice_settings = lock_practice_settings(db, practice.id)
    practice_settings.interchange_counter += 1
    control_number = practice_settings.interchange_counter
    envelope = Envelope(
        sender_id=practice_settings.x12_submitter_id,
        receiver_id=practice_settings.x12_receiver_id,
        interchange_control_number=control_number,
        group_control_number=control_number,
        created_at=utcnow(),
        usage="P",
    )
    submitter = doc.Submitter(
        name=practice.name,
        identifier=practice_settings.x12_submitter_id,
        contact=doc.Contact(name=practice.name, phone=phone_digits(practice.phone)),
    )
    receiver = doc.Receiver(
        name=practice_settings.x12_receiver_name or "CLEARINGHOUSE",
        identifier=practice_settings.x12_receiver_id,
    )
    documents = [claim_document(db, claim) for claim in claims]
    content = build_837p(documents, envelope, submitter, receiver)
    for claim, document in zip(claims, documents, strict=True):
        mark_submitted(
            claim,
            ClaimSubmissionMethod.X12_FILE,
            document,
            message=f"Exported in 837P file {control_number}",
            staff_id=staff_id,
            reference=str(control_number),
        )
    return content, control_number


def cms1500_for(db: Session, practice: Practice, claims: Sequence[Claim]) -> bytes:
    """CMS-1500 forms for `claims`, signed today in the practice's time zone."""
    documents = [claim_document(db, claim) for claim in claims]
    return cms1500_pdf(documents, signed_on=local_date(utcnow(), zone_of(practice)))


def print_on_paper(
    db: Session, practice: Practice, claims: Sequence[Claim], staff_id: int | None
) -> bytes:
    """CMS-1500 forms for `claims`, marked submitted on paper."""
    documents = [claim_document(db, claim) for claim in claims]
    content = cms1500_pdf(documents, signed_on=local_date(utcnow(), zone_of(practice)))
    for claim, document in zip(claims, documents, strict=True):
        mark_submitted(
            claim,
            ClaimSubmissionMethod.PAPER,
            document,
            message="Printed on a CMS-1500 form",
            staff_id=staff_id,
        )
    return content


def reject(db: Session, claim: Claim, message: str, *, data: dict[str, Any] | None = None) -> None:
    """Mark the claim rejected (fix and resubmit) and tell the staff who handle its billing."""
    claim.status = ClaimStatus.REJECTED
    claim.last_error = message
    add_event(claim, "rejected", message, data=data)
    notify_claim_rejected(db, claim)


# Events and notifications ------------------------------------------------------------------


def claim_link(claim_id: int) -> str:
    """Where staff open a claim in the app."""
    return f"/portal/billing/claims/{claim_id}"


def claims_changed(db: Session, claims: Iterable[Claim]) -> None:
    """Tell staff who see each client's billing to refetch these claims (ids only)."""
    by_client: dict[int, list[int]] = {}
    for claim in claims:
        by_client.setdefault(claim.client_id, []).append(claim.id)
    for client_id, claim_ids in by_client.items():
        client = db.get_one(Client, client_id)
        publish(
            db,
            client_team_recipients(db, client, ClientAccess.BILLING),
            EVENT_CLAIMS_CHANGED,
            {"claim_ids": sorted(set(claim_ids)), "client_id": client_id},
        )


def notify_claim_rejected(db: Session, claim: Claim) -> None:
    """In-app notification (no clinical content) to staff who handle the client's billing."""
    client = claim.client
    for member in staff_with_client_access(db, client, ClientAccess.BILLING):
        notify(
            db,
            Role.STAFF,
            member.id,
            kind="claim_rejected",
            title=f"Claim {claim.patient_control_number} was rejected",
            body=f"{short_name(client)}'s claim to {claim.payer.name} needs attention.",
            link=claim_link(claim.id),
        )
