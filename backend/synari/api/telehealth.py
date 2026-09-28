"""Telehealth on LiveKit: host tokens, join links, the waiting room and consent-gated recording.

Every client in a video appointment has their own join link (and text-message short code), so
a couples, family or group session has one link per client. How a client joins (no account
needed):

1. `GET  /telehealth/join/{token}` says whether the link can be used right now.
2. `POST /telehealth/join/{token}/enter` creates a waiting-room entry and returns its secret.
3. `GET  /telehealth/entries/{id}?secret=...` is polled until the entry is admitted, and then
   also returns a LiveKit token for the room.
4. `POST /telehealth/entries/{id}/leave?secret=...` marks the entry as left.

The appointment's clinician hosts: they get a host token, watch the waiting room (realtime
`waiting_room.updated`), admit or decline each entry, end the session and record it. Staff who
manage the clinician's calendar (schedulers, practice managers) may view and send the join links
but never host. Each person consents to recording when they check in; audio recorded in the
clinician's browser is uploaded afterwards, only if the practice allows recording and everyone
admitted to the session consented.
"""

import hmac
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from synari.access import Access
from synari.api.appointments import audit_appointment
from synari.audit import (
    DEFAULT_THROTTLE_WINDOW,
    audit_anonymous,
    audit_client,
    audit_staff,
    audit_staff_throttled,
)
from synari.config import settings
from synari.db import utcnow
from synari.deps import CurrentAccess, CurrentClient, DbSession
from synari.models import (
    Appointment,
    AppointmentParticipant,
    AuditEvent,
    Client,
    Practice,
    Recording,
    StaffMember,
    WaitingRoomEntry,
)
from synari.models.enums import (
    AppointmentStatus,
    FilePurpose,
    RecordingStatus,
    Role,
    WaitingStatus,
)
from synari.ratelimit import rate_limit
from synari.realtime import publish
from synari.schemas.appointments import ClientRef
from synari.schemas.common import Message
from synari.schemas.telehealth import (
    ConsentParticipant,
    EnterOut,
    EnterRequest,
    EntryStatusOut,
    JoinInfoOut,
    JoinLinkOut,
    JoinStatus,
    ParticipantLinkOut,
    RecordingConsentOut,
    RecordingCreatedOut,
    RecordingOut,
    RoomTokenOut,
    SendLinkOut,
    ShortLinkOut,
    WaitingRoomEntryOut,
)
from synari.security import hash_opaque_token, new_opaque_token
from synari.services.delivery import normalize_phone
from synari.services.email_templates import render_email
from synari.services.livekit import (
    GUEST_TOKEN_TTL,
    RoomAccess,
    end_room,
    mint_room_token,
    remove_participant,
)
from synari.services.notes import present_participants
from synari.services.notifications import notify
from synari.services.outbox import queue_email, queue_sms
from synari.services.storage import store_upload
from synari.services.video_links import (
    LINK_GRACE_AFTER_END,
    create_join_token,
    create_join_url,
    decode_join_token,
    resolve_short_code,
    short_join_url,
)

router = APIRouter(tags=["telehealth"])

EARLY_JOIN = timedelta(minutes=60)
HOST_LATE_JOIN = timedelta(minutes=60)
HOST_TOKEN_TTL = timedelta(hours=4)
ENTRY_TTL = timedelta(hours=4)
CANCELED_STATUSES = (
    AppointmentStatus.CANCELED,
    AppointmentStatus.LATE_CANCELED,
    AppointmentStatus.DECLINED,
)
JOIN_CLOSED_DETAILS: dict[JoinStatus, str] = {
    "too_early": "This appointment opens 60 minutes before it starts. Please come back then.",
    "ended": "This appointment has ended.",
    "canceled": "This appointment was canceled.",
}
INVALID_LINK = "This video link isn't valid or has expired."
ENTRY_GONE = "This waiting room visit has ended. Open your video link again."
NOT_WAITING = "This person is no longer in the waiting room."
CANCELED = "This appointment was canceled."
HOST_ONLY = "Only the appointment's clinician can run this session"


def _require_telehealth() -> None:
    if not settings.telehealth_enabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Telehealth isn't configured")


def _is_canceled(appointment: Appointment) -> bool:
    return appointment.status in CANCELED_STATUSES


def _link_expires_at(appointment: Appointment) -> datetime:
    return appointment.ends_at + LINK_GRACE_AFTER_END


def _entry_expired(entry: WaitingRoomEntry, now: datetime) -> bool:
    return entry.created_at < now - ENTRY_TTL


def _join_status(appointment: Appointment, now: datetime) -> JoinStatus:
    if _is_canceled(appointment):
        return "canceled"
    if now < appointment.starts_at - EARLY_JOIN:
        return "too_early"
    if now > _link_expires_at(appointment):
        return "ended"
    return "open"


def _practice_of(db: Session, appointment: Appointment) -> Practice:
    return db.get_one(Practice, appointment.practice_id)


def _client_time_zone(client: Client, clinician: StaffMember) -> str:
    """Client-facing times use the client's zone when set, else the clinician's."""
    return client.time_zone or clinician.time_zone


def _publish_waiting_room(db: Session, appointment: Appointment) -> None:
    publish(
        db,
        [(Role.STAFF, appointment.clinician_id)],
        "waiting_room.updated",
        {"appointment_id": appointment.id},
    )


def _on_managed_calendar(
    access: Access, appointment: Appointment | None, label: str = "Appointment"
) -> Appointment:
    """The appointment if it's on a calendar this person manages (their own, or anyone's for
    schedulers and managers); 404 otherwise."""
    if (
        appointment is None
        or appointment.practice_id != access.practice_id
        or not access.can_manage_calendar(appointment.clinician_id)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return appointment


def _require_host(access: Access, appointment: Appointment) -> None:
    """Hosting is for the appointment's clinician only; calendar managers get a 403."""
    if appointment.clinician_id != access.staff.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, HOST_ONLY)


def _managed_appointment(access: Access, appointment_id: int) -> Appointment:
    return _on_managed_calendar(access, access.db.get(Appointment, appointment_id))


def _hosted_appointment(access: Access, appointment_id: int) -> Appointment:
    appointment = _managed_appointment(access, appointment_id)
    _require_host(access, appointment)
    return appointment


def _video_room(appointment: Appointment) -> str:
    """The room of an uncanceled video appointment; 409 otherwise."""
    if appointment.video_room_name is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This isn't a video appointment")
    if _is_canceled(appointment):
        raise HTTPException(status.HTTP_409_CONFLICT, CANCELED)
    return appointment.video_room_name


def _find_participant(appointment: Appointment, client_id: int) -> AppointmentParticipant | None:
    return next((p for p in appointment.participants if p.client_id == client_id), None)


def _link_participant(db: Session, token: str) -> tuple[AppointmentParticipant, Appointment]:
    """The participant and video appointment a join token points to; 404 if the token is
    invalid or its client is no longer in the appointment."""
    claims = decode_join_token(token)
    appointment = db.get(Appointment, claims.appointment_id) if claims else None
    if claims is None or appointment is None or not appointment.has_video:
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVALID_LINK)
    participant = _find_participant(appointment, claims.client_id)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVALID_LINK)
    return participant, appointment


def _load_entry(
    db: Session, entry_id: int, *, lock: bool
) -> tuple[WaitingRoomEntry, Appointment] | None:
    query = (
        select(WaitingRoomEntry, Appointment)
        .join(Appointment, Appointment.id == WaitingRoomEntry.appointment_id)
        .where(WaitingRoomEntry.id == entry_id)
    )
    if lock:
        query = query.with_for_update(of=WaitingRoomEntry)
    row = db.execute(query).first()
    return (row[0], row[1]) if row else None


def _participant_entry(
    db: Session, entry_id: int, secret: str, now: datetime, *, lock: bool = False
) -> tuple[WaitingRoomEntry, Appointment]:
    """The entry the secret belongs to; 404 for a wrong secret or an expired entry."""
    loaded = _load_entry(db, entry_id, lock=lock)
    if loaded is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ENTRY_GONE)
    entry, appointment = loaded
    wrong_secret = not hmac.compare_digest(entry.secret_hash, hash_opaque_token(secret))
    if wrong_secret or _entry_expired(entry, now):
        raise HTTPException(status.HTTP_404_NOT_FOUND, ENTRY_GONE)
    return entry, appointment


def _hosted_entry(access: Access, entry_id: int) -> tuple[WaitingRoomEntry, Appointment]:
    """A waiting-room entry for a session this person hosts, locked for update."""
    loaded = _load_entry(access.db, entry_id, lock=True)
    label = "Waiting room entry"
    if loaded is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    entry, appointment = loaded
    _require_host(access, _on_managed_calendar(access, appointment, label))
    return entry, appointment


def _ensure_waiting(entry: WaitingRoomEntry, now: datetime) -> None:
    if entry.status != WaitingStatus.WAITING or _entry_expired(entry, now):
        raise HTTPException(status.HTTP_409_CONFLICT, NOT_WAITING)


def _client_ids(appointment: Appointment) -> list[int]:
    return [participant.client_id for participant in appointment.participants]


def _audit_guest_info(
    db: Session, request: Request, appointment: Appointment, client_id: int
) -> None:
    """Record that someone holding a client's join link opened it (once per ten minutes, since
    the join page may be reloaded while waiting)."""
    recent = db.scalar(
        select(
            exists().where(
                AuditEvent.practice_id == appointment.practice_id,
                AuditEvent.actor_role == "anonymous",
                AuditEvent.action == "telehealth.guest_info",
                AuditEvent.client_id == client_id,
                AuditEvent.detail["appointment_id"].as_integer() == appointment.id,
                # The database's clock, which stamps created_at.
                AuditEvent.created_at >= func.now() - DEFAULT_THROTTLE_WINDOW,
            )
        )
    )
    if not recent:
        audit_anonymous(
            db,
            request,
            "telehealth.guest_info",
            appointment.practice_id,
            {"appointment_id": appointment.id},
            client_id=client_id,
        )


def _admitted_entries(db: Session, appointment: Appointment) -> list[WaitingRoomEntry]:
    """Everyone who was admitted to the session, including people who have since left."""
    return list(
        db.scalars(
            select(WaitingRoomEntry)
            .where(
                WaitingRoomEntry.appointment_id == appointment.id,
                WaitingRoomEntry.admitted_at.is_not(None),
            )
            .order_by(WaitingRoomEntry.admitted_at, WaitingRoomEntry.id)
        )
    )


def _format_when(moment: datetime, zone: ZoneInfo) -> str:
    """E.g. 'Monday, October 5 at 10:00 AM EDT'."""
    local = moment.astimezone(zone)
    clock = local.strftime("%I:%M %p").lstrip("0")
    return f"{local:%A, %B} {local.day} at {clock} {local.tzname()}"


def _queue_link_messages(
    db: Session, participant: AppointmentParticipant, appointment: Appointment
) -> SendLinkOut:
    """Queue a client's own join link by email and, with their text consent, by SMS."""
    client = participant.client
    url = create_join_url(appointment, client.id)
    clinician = appointment.clinician
    practice = _practice_of(db, appointment)
    when = _format_when(appointment.starts_at, ZoneInfo(_client_time_zone(client, clinician)))
    email_sent = False
    if client.email:
        waiting_note = (
            f" You'll wait in a virtual waiting room until {clinician.display_name} lets you in."
            if practice.settings.waiting_room_enabled
            else ""
        )
        content = render_email(
            subject=f"Your video appointment with {clinician.display_name}",
            heading="Your video appointment link",
            paragraphs=[
                f"Your video appointment with {clinician.display_name} is on {when}.",
                "Use the button below to join from your phone or computer, starting up to an "
                f"hour before the appointment.{waiting_note}",
            ],
            sender_name=practice.name,
            button_label="Join video appointment",
            button_url=url,
        )
        queue_email(db, to=client.email, content=content, practice_id=practice.id)
        email_sent = True

    phone = normalize_phone(client.phone)
    sms_sent = False
    if client.sms_reminders and not client.sms_opted_out and settings.sms_enabled and phone:
        queue_sms(
            db,
            to=phone,
            body=(
                f"{practice.name}: your video appointment with "
                f"{clinician.display_name} is {when}. Join: {short_join_url(participant)}"
            ),
            practice_id=practice.id,
        )
        sms_sent = True
    return SendLinkOut(client_id=client.id, email_sent=email_sent, sms_sent=sms_sent)


# Staff: hosting and sharing links


@router.post("/telehealth/appointments/{appointment_id}/host-token", response_model=RoomTokenOut)
def create_host_token(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> RoomAccess:
    """A LiveKit token for the appointment's clinician to host its video room, from 60 minutes
    before it starts until 60 minutes after it ends."""
    _require_telehealth()
    appointment = _hosted_appointment(access, appointment_id)
    room_name = _video_room(appointment)
    now = utcnow()
    if now < appointment.starts_at - EARLY_JOIN or now > appointment.ends_at + HOST_LATE_JOIN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You can start this session from 60 minutes before it begins until "
            "60 minutes after it ends.",
        )
    host = access.staff
    room_access = mint_room_token(
        room_name=room_name,
        identity=f"clinician-{host.id}",
        name=host.display_name,
        ttl=HOST_TOKEN_TTL,
        admin=True,
    )
    audit_appointment(
        db, request, host, "telehealth.host_join", appointment.id, _client_ids(appointment)
    )
    db.commit()
    return room_access


@router.get(
    "/telehealth/appointments/{appointment_id}/join-links",
    response_model=list[ParticipantLinkOut],
)
def list_join_links(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[ParticipantLinkOut]:
    """Each client's own join link for this appointment, to copy and share."""
    appointment = _managed_appointment(access, appointment_id)
    _video_room(appointment)
    links = [
        ParticipantLinkOut(
            client=ClientRef.model_validate(participant.client),
            url=create_join_url(appointment, participant.client_id),
        )
        for participant in appointment.participants
    ]
    for client_id in _client_ids(appointment):
        audit_staff_throttled(
            db,
            request,
            access.staff,
            "telehealth.join_links_view",
            "appointment",
            appointment.id,
            client_id=client_id,
        )
    db.commit()
    return links


@router.post(
    "/telehealth/appointments/{appointment_id}/send-link", response_model=list[SendLinkOut]
)
def send_join_links(
    appointment_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    client_id: int | None = Query(default=None),
) -> list[SendLinkOut]:
    """Email each client their own join link, and text it to those who agreed to texts.

    With `client_id`, only that client's link is sent; otherwise every client not marked
    absent gets theirs. 409 if none of them can be reached.
    """
    appointment = _managed_appointment(access, appointment_id)
    _video_room(appointment)
    if client_id is None:
        recipients = present_participants(appointment)
    else:
        participant = _find_participant(appointment, client_id)
        if participant is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Client not found")
        recipients = [participant]
    if not recipients:
        raise HTTPException(status.HTTP_409_CONFLICT, "This appointment has no clients")
    results = [_queue_link_messages(db, participant, appointment) for participant in recipients]
    if not any(result.email_sent or result.sms_sent for result in results):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No email address or text-message consent to send the link to.",
        )
    for result in results:
        audit_staff(
            db,
            request,
            access.staff,
            "telehealth.link_send",
            "appointment",
            appointment.id,
            {"email_sent": result.email_sent, "sms_sent": result.sms_sent},
            client_id=result.client_id,
        )
    db.commit()
    return results


# Host: waiting room


@router.get(
    "/telehealth/appointments/{appointment_id}/waiting-room",
    response_model=list[WaitingRoomEntryOut],
)
def list_waiting_room(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[WaitingRoomEntry]:
    """Everyone who opened the link in the last 4 hours, oldest first, with any status."""
    appointment = _hosted_appointment(access, appointment_id)
    entries = list(
        db.scalars(
            select(WaitingRoomEntry)
            .where(
                WaitingRoomEntry.appointment_id == appointment.id,
                WaitingRoomEntry.created_at >= utcnow() - ENTRY_TTL,
            )
            .order_by(WaitingRoomEntry.created_at, WaitingRoomEntry.id)
        )
    )
    # The session screen polls this list, so record the access once per ten minutes.
    for client_id in _client_ids(appointment) or [None]:
        audit_staff_throttled(
            db,
            request,
            access.staff,
            "telehealth.waiting_room_view",
            "appointment",
            appointment.id,
            client_id=client_id,
        )
    db.commit()
    return entries


@router.post("/telehealth/entries/{entry_id}/admit", response_model=WaitingRoomEntryOut)
def admit_entry(
    entry_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> WaitingRoomEntry:
    """Let a waiting participant into the session."""
    entry, appointment = _hosted_entry(access, entry_id)
    if _is_canceled(appointment):
        raise HTTPException(status.HTTP_409_CONFLICT, CANCELED)
    now = utcnow()
    _ensure_waiting(entry, now)
    entry.status = WaitingStatus.ADMITTED
    entry.admitted_at = now
    _publish_waiting_room(db, appointment)
    audit_staff(
        db,
        request,
        access.staff,
        "telehealth.admit",
        "waiting_room_entry",
        entry.id,
        {"appointment_id": appointment.id},
        client_id=entry.client_id,
    )
    db.commit()
    return entry


@router.post("/telehealth/entries/{entry_id}/decline", response_model=WaitingRoomEntryOut)
def decline_entry(
    entry_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> WaitingRoomEntry:
    """Turn away a waiting participant."""
    entry, appointment = _hosted_entry(access, entry_id)
    _ensure_waiting(entry, utcnow())
    entry.status = WaitingStatus.DECLINED
    _publish_waiting_room(db, appointment)
    audit_staff(
        db,
        request,
        access.staff,
        "telehealth.decline",
        "waiting_room_entry",
        entry.id,
        {"appointment_id": appointment.id},
        client_id=entry.client_id,
    )
    db.commit()
    return entry


@router.post("/telehealth/entries/{entry_id}/remove", response_model=WaitingRoomEntryOut)
def remove_entry(
    entry_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> WaitingRoomEntry:
    """Take an admitted participant out of the session (they'd have to rejoin and be admitted)."""
    entry, appointment = _hosted_entry(access, entry_id)
    if entry.status != WaitingStatus.ADMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This person isn't in the session")
    entry.status = WaitingStatus.DECLINED
    _publish_waiting_room(db, appointment)
    audit_staff(
        db,
        request,
        access.staff,
        "telehealth.remove",
        "waiting_room_entry",
        entry.id,
        {"appointment_id": appointment.id},
        client_id=entry.client_id,
    )
    db.commit()
    if appointment.video_room_name:
        remove_participant(appointment.video_room_name, f"guest-{entry.id}")
    return entry


@router.post("/telehealth/appointments/{appointment_id}/end", response_model=Message)
def end_session(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Message:
    """End the video session for everyone and close the waiting room."""
    appointment = _hosted_appointment(access, appointment_id)
    entries = db.scalars(
        select(WaitingRoomEntry)
        .where(
            WaitingRoomEntry.appointment_id == appointment.id,
            WaitingRoomEntry.status.in_((WaitingStatus.WAITING, WaitingStatus.ADMITTED)),
        )
        .with_for_update()
    ).all()
    for entry in entries:
        entry.status = (
            WaitingStatus.LEFT if entry.status == WaitingStatus.ADMITTED else WaitingStatus.DECLINED
        )
    _publish_waiting_room(db, appointment)
    audit_appointment(
        db, request, access.staff, "telehealth.end", appointment.id, _client_ids(appointment)
    )
    db.commit()
    if appointment.video_room_name:
        end_room(appointment.video_room_name)
    return Message(detail="Session ended")


@router.post(
    "/telehealth/appointments/{appointment_id}/admit-all",
    response_model=list[WaitingRoomEntryOut],
)
def admit_everyone(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[WaitingRoomEntry]:
    """Admit everyone currently waiting; returns the entries that were admitted."""
    appointment = _hosted_appointment(access, appointment_id)
    if _is_canceled(appointment):
        raise HTTPException(status.HTTP_409_CONFLICT, CANCELED)
    now = utcnow()
    waiting = list(
        db.scalars(
            select(WaitingRoomEntry)
            .where(
                WaitingRoomEntry.appointment_id == appointment.id,
                WaitingRoomEntry.status == WaitingStatus.WAITING,
                WaitingRoomEntry.created_at >= now - ENTRY_TTL,
            )
            .order_by(WaitingRoomEntry.created_at, WaitingRoomEntry.id)
            .with_for_update()
        )
    )
    for entry in waiting:
        entry.status = WaitingStatus.ADMITTED
        entry.admitted_at = now
    if waiting:
        _publish_waiting_room(db, appointment)
    audit_appointment(
        db,
        request,
        access.staff,
        "telehealth.admit_all",
        appointment.id,
        _client_ids(appointment),
        {"count": len(waiting)},
    )
    db.commit()
    return waiting


# Public join flow (anyone holding the link; rate limited per IP)


@router.get(
    "/telehealth/join/{token}",
    response_model=JoinInfoOut,
    dependencies=[Depends(rate_limit("telehealth-join", limit=60))],
)
def get_join_info(token: str, db: DbSession, request: Request) -> JoinInfoOut:
    """Whether a join link can be used now, and who it's with. Never includes client details."""
    participant, appointment = _link_participant(db, token)
    clinician = appointment.clinician
    practice = _practice_of(db, appointment)
    client = participant.client
    _audit_guest_info(db, request, appointment, client.id)
    db.commit()
    return JoinInfoOut(
        status=_join_status(appointment, utcnow()),
        starts_at=appointment.starts_at,
        ends_at=appointment.ends_at,
        clinician_name=clinician.display_name,
        practice_name=practice.name,
        time_zone=_client_time_zone(client, clinician),
        waiting_room_enabled=practice.settings.waiting_room_enabled,
        recording_enabled=practice.settings.recording_enabled,
    )


@router.post(
    "/telehealth/join/{token}/enter",
    response_model=EnterOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("telehealth-enter", limit=20))],
)
def enter_waiting_room(token: str, body: EnterRequest, db: DbSession, request: Request) -> EnterOut:
    """Check in for the appointment. Admitted at once if the practice has no waiting room."""
    _require_telehealth()
    participant, appointment = _link_participant(db, token)
    client_id = participant.client_id
    now = utcnow()
    join_status = _join_status(appointment, now)
    if join_status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, JOIN_CLOSED_DETAILS[join_status])
    admit_now = not _practice_of(db, appointment).settings.waiting_room_enabled
    secret, secret_hash = new_opaque_token()
    entry = WaitingRoomEntry(
        appointment_id=appointment.id,
        client_id=client_id,
        display_name=body.display_name,
        current_location=body.current_location,
        recording_consent=body.recording_consent,
        secret_hash=secret_hash,
        status=WaitingStatus.ADMITTED if admit_now else WaitingStatus.WAITING,
        admitted_at=now if admit_now else None,
    )
    db.add(entry)
    db.flush()
    _publish_waiting_room(db, appointment)
    notify(
        db,
        Role.STAFF,
        appointment.clinician_id,
        kind="telehealth_arrival",
        title=f"{entry.display_name} joined the video session"
        if admit_now
        else f"{entry.display_name} is in the waiting room",
        link=f"/session/{appointment.id}",
    )
    audit_anonymous(
        db,
        request,
        "telehealth.enter",
        practice_id=appointment.practice_id,
        detail={"appointment_id": appointment.id, "entry_id": entry.id},
        client_id=client_id,
    )
    db.commit()
    return EnterOut(entry_id=entry.id, secret=secret, status=WaitingStatus(entry.status))


@router.get(
    "/telehealth/entries/{entry_id}",
    response_model=EntryStatusOut,
    dependencies=[Depends(rate_limit("telehealth-poll", limit=300))],
)
def poll_entry(
    entry_id: int, db: DbSession, secret: str = Query(min_length=1, max_length=200)
) -> EntryStatusOut:
    """Poll a waiting-room entry; once admitted, the response carries a room token."""
    now = utcnow()
    entry, appointment = _participant_entry(db, entry_id, secret, now)
    room_name = appointment.video_room_name
    if room_name is None or _is_canceled(appointment):
        return EntryStatusOut(status="canceled")
    if now > _link_expires_at(appointment):
        return EntryStatusOut(status="ended")
    if entry.status != WaitingStatus.ADMITTED:
        return EntryStatusOut(status=entry.status)
    _require_telehealth()
    room_access = mint_room_token(
        room_name=room_name,
        identity=f"guest-{entry.id}",
        name=entry.display_name,
        ttl=min(GUEST_TOKEN_TTL, _link_expires_at(appointment) - now),
        admin=False,
    )
    return EntryStatusOut(
        status=entry.status,
        livekit_url=room_access.livekit_url,
        token=room_access.token,
        room_name=room_access.room_name,
    )


@router.post(
    "/telehealth/entries/{entry_id}/leave",
    response_model=EntryStatusOut,
    dependencies=[Depends(rate_limit("telehealth-leave", limit=30))],
)
def leave_session(
    entry_id: int,
    db: DbSession,
    request: Request,
    secret: str = Query(min_length=1, max_length=200),
) -> EntryStatusOut:
    """Leave the waiting room or the session."""
    entry, appointment = _participant_entry(db, entry_id, secret, utcnow(), lock=True)
    if entry.status in (WaitingStatus.WAITING, WaitingStatus.ADMITTED):
        was_admitted = entry.status == WaitingStatus.ADMITTED
        entry.status = WaitingStatus.LEFT
        _publish_waiting_room(db, appointment)
        if was_admitted and appointment.video_room_name:
            remove_participant(appointment.video_room_name, f"guest-{entry.id}")
        audit_anonymous(
            db,
            request,
            "telehealth.leave",
            practice_id=appointment.practice_id,
            detail={"appointment_id": appointment.id, "entry_id": entry.id},
            client_id=entry.client_id,
        )
        db.commit()
    return EntryStatusOut(status=entry.status)


# Client portal


@router.get("/portal/appointments/{appointment_id}/join", response_model=JoinLinkOut)
def portal_join_link(
    appointment_id: int, client: CurrentClient, db: DbSession, request: Request
) -> JoinLinkOut:
    """The signed-in client's own join link for a video appointment they're part of."""
    appointment = db.get(Appointment, appointment_id)
    if (
        appointment is None
        or not appointment.has_video
        or _find_participant(appointment, client.id) is None
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Appointment not found")
    if _is_canceled(appointment):
        raise HTTPException(status.HTTP_409_CONFLICT, CANCELED)
    audit_client(db, request, client, "telehealth.join_link_view", "appointment", appointment.id)
    db.commit()
    return JoinLinkOut(url=create_join_url(appointment, client.id))


# Host: recording


@router.get(
    "/telehealth/appointments/{appointment_id}/recording-consent",
    response_model=RecordingConsentOut,
)
def get_recording_consent(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> RecordingConsentOut:
    """Whether the session may be recorded: the practice setting plus each participant's consent.

    Participants are everyone admitted to the session (each client on their own link, and
    anyone else they let in), including people who have since left.
    """
    appointment = _hosted_appointment(access, appointment_id)
    participants = _admitted_entries(db, appointment)
    audit_appointment(
        db,
        request,
        access.staff,
        "telehealth.recording_consent_view",
        appointment.id,
        _client_ids(appointment),
    )
    db.commit()
    return RecordingConsentOut(
        recording_enabled=access.staff.practice.settings.recording_enabled,
        all_consented=bool(participants) and all(p.recording_consent for p in participants),
        participants=[
            ConsentParticipant(
                entry_id=p.id,
                client_id=p.client_id,
                display_name=p.display_name,
                recording_consent=p.recording_consent,
            )
            for p in participants
        ],
    )


@router.post(
    "/telehealth/appointments/{appointment_id}/recordings",
    response_model=RecordingCreatedOut,
    status_code=status.HTTP_201_CREATED,
)
def upload_recording(
    appointment_id: int,
    access: CurrentAccess,
    db: DbSession,
    request: Request,
    file: UploadFile = File(...),
) -> Recording:
    """Save session audio for transcription. Requires recording to be enabled for the practice
    and consent from everyone admitted to the session."""
    appointment = _hosted_appointment(access, appointment_id)
    if not access.staff.practice.settings.recording_enabled:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Recording is turned off in your practice settings."
        )
    participants = _admitted_entries(db, appointment)
    if not participants:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "No one was admitted to this session, so it can't be saved."
        )
    if not all(p.recording_consent for p in participants):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Everyone in the session must agree to recording before audio can be saved.",
        )
    # A multi-client session's audio belongs to the session, not to one client's documents.
    clients = appointment.participants
    stored = store_upload(
        db,
        file,
        practice_id=appointment.practice_id,
        client_id=clients[0].client_id if len(clients) == 1 else None,
        purpose=FilePurpose.RECORDING,
        uploaded_by=Role.STAFF,
        uploaded_by_staff_id=access.staff.id,
        audio_only=True,
    )
    recording = Recording(
        practice_id=appointment.practice_id,
        appointment_id=appointment.id,
        file_id=stored.id,
        status=RecordingStatus.UPLOADED,
    )
    db.add(recording)
    db.flush()
    for client_id in _client_ids(appointment) or [None]:
        audit_staff(
            db,
            request,
            access.staff,
            "recording.create",
            "recording",
            recording.id,
            {"appointment_id": appointment.id, "file_id": stored.id},
            client_id=client_id,
        )
    db.commit()
    return recording


@router.get("/telehealth/recordings/{recording_id}", response_model=RecordingOut)
def get_recording(
    recording_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> Recording:
    """A recording's transcription status and transcript (for the session's clinician)."""
    recording = access.get(Recording, recording_id, label="Recording")
    appointment = db.get(Appointment, recording.appointment_id)
    _require_host(access, _on_managed_calendar(access, appointment, "Recording"))
    for client_id in _client_ids(appointment) or [None]:
        audit_staff(
            db,
            request,
            access.staff,
            "recording.view",
            "recording",
            recording.id,
            client_id=client_id,
        )
    db.commit()
    return recording


@router.get(
    "/telehealth/appointments/{appointment_id}/recordings", response_model=list[RecordingOut]
)
def list_recordings(
    appointment_id: int, access: CurrentAccess, db: DbSession, request: Request
) -> list[Recording]:
    """Recordings uploaded for an appointment, newest first."""
    appointment = _hosted_appointment(access, appointment_id)
    recordings = list(
        db.scalars(
            select(Recording)
            .where(
                Recording.practice_id == appointment.practice_id,
                Recording.appointment_id == appointment.id,
            )
            .order_by(Recording.id.desc())
        )
    )
    audit_appointment(
        db, request, access.staff, "recording.list", appointment.id, _client_ids(appointment)
    )
    db.commit()
    return recordings


@router.get(
    "/telehealth/short/{code}",
    response_model=ShortLinkOut,
    dependencies=[Depends(rate_limit("telehealth-short", limit=30))],
)
def resolve_short_link(code: str, db: DbSession) -> ShortLinkOut:
    """Exchange a client's text-message short code for their join token (public; 404 once
    expired)."""
    participant = resolve_short_code(db, code)
    if participant is None or _is_canceled(participant.appointment):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This link is invalid or has expired")
    return ShortLinkOut(token=create_join_token(participant.appointment, participant.client_id))
