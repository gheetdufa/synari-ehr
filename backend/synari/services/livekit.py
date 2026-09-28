"""LiveKit access tokens and room controls for telehealth.

Tokens are signed locally with the API secret. A room is created by LiveKit when the first
participant joins. Removing participants and ending rooms calls the LiveKit server API; those
calls are best effort, so a LiveKit outage never blocks the app.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta

from livekit import api

from synari.config import settings

logger = logging.getLogger(__name__)

# Guests get short-lived tokens. LiveKit refreshes tokens for connected participants, so calls
# continue normally, but a token copied after someone leaves or is removed soon stops working.
GUEST_TOKEN_TTL = timedelta(minutes=10)


@dataclass(frozen=True)
class RoomAccess:
    livekit_url: str
    token: str
    room_name: str
    identity: str


def mint_room_token(
    *, room_name: str, identity: str, name: str, ttl: timedelta, admin: bool
) -> RoomAccess:
    """Sign a token that lets one participant join one room and publish audio, video and data.

    `admin` adds room_admin, which lets the holder mute or remove other participants.
    """
    grants = api.VideoGrants(
        room_join=True,
        room=room_name,
        room_admin=admin,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name(name)
        .with_grants(grants)
        .with_ttl(ttl)
        .to_jwt()
    )
    return RoomAccess(
        livekit_url=settings.livekit_url, token=token, room_name=room_name, identity=identity
    )


def _server_url() -> str:
    return settings.livekit_url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)


async def _remove(room_name: str, identity: str) -> None:
    async with api.LiveKitAPI(
        _server_url(), settings.livekit_api_key, settings.livekit_api_secret
    ) as client:
        await client.room.remove_participant(
            api.RoomParticipantIdentity(room=room_name, identity=identity)
        )


async def _delete(room_name: str) -> None:
    async with api.LiveKitAPI(
        _server_url(), settings.livekit_api_key, settings.livekit_api_secret
    ) as client:
        await client.room.delete_room(api.DeleteRoomRequest(room=room_name))


def remove_participant(room_name: str, identity: str) -> None:
    """Disconnect one participant from a room (no-op if they're not connected)."""
    try:
        asyncio.run(_remove(room_name, identity))
    except Exception as exc:
        logger.info("LiveKit remove_participant %s/%s: %s", room_name, identity, exc)


def end_room(room_name: str) -> None:
    """Disconnect everyone and close the room."""
    try:
        asyncio.run(_delete(room_name))
    except Exception as exc:
        logger.info("LiveKit delete_room %s: %s", room_name, exc)
