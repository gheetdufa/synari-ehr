"""Secure messaging and in-app notification schemas."""

from datetime import datetime
from typing import Self

from pydantic import Field, model_validator

from synari.models.enums import RiskLevel, Role
from synari.schemas.common import Schema

MAX_BODY_LENGTH = 5000
MAX_ATTACHMENTS = 5


class MessageCreate(Schema):
    """A new message: text, attachments uploaded beforehand, or both."""

    body: str = Field(default="", max_length=MAX_BODY_LENGTH)
    attachment_ids: list[int] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)

    @model_validator(mode="after")
    def _has_content(self) -> Self:
        self.body = self.body.strip()
        self.attachment_ids = list(dict.fromkeys(self.attachment_ids))
        if not self.body and not self.attachment_ids:
            raise ValueError("Write a message or attach a file")
        return self


class AttachmentOut(Schema):
    """A file attached to a message; `id` is the file id used by the download endpoints."""

    id: int
    filename: str
    content_type: str
    size_bytes: int


class MessageBase(Schema):
    """A message.

    sender_name is the staff member who wrote it (the conversation's clinician for automatic
    replies), the contact who wrote it on the client's behalf ("Pat Rivera (for Alex)"), or
    null for the client's own messages.
    """

    id: int
    conversation_id: int
    sender_role: Role
    sender_name: str | None
    body: str
    removed: bool
    is_automatic: bool
    attachments: list[AttachmentOut]
    created_at: datetime
    read_by_recipient: bool


class PortalMessageOut(MessageBase):
    """A message as the client (or a contact using their portal) sees it."""

    # Whether the person signed in wrote it: the client, or this particular contact.
    sent_by_me: bool


class MessageOut(MessageBase):
    """A message as staff see it: which team member sent it and its crisis-screening result."""

    sender_staff_id: int | None
    # The client's contact (e.g. a parent) who wrote it on the client's behalf.
    sender_contact_id: int | None
    risk_level: RiskLevel


class PortalSentMessageOut(PortalMessageOut):
    """The client's newly sent message; crisis_resources asks the portal to show 988/911 help."""

    crisis_resources: bool


class ConversationClient(Schema):
    id: int
    first_name: str
    last_name: str
    preferred_name: str


class ConversationClinician(Schema):
    """The clinician a conversation is with; name includes credentials, e.g. 'Jordan Lee, LCSW'."""

    id: int
    name: str


class ConversationOut(Schema):
    """One row of the staff inbox. unread_count is what the conversation's clinician hasn't read."""

    id: int
    client: ConversationClient
    clinician: ConversationClinician
    last_message_at: datetime | None
    unread_count: int
    last_message_preview: str
    has_urgent: bool


class PortalConversationOut(Schema):
    """A clinician the client can message; id is null until either side starts the conversation."""

    id: int | None
    clinician: ConversationClinician
    last_message_at: datetime | None
    unread_count: int
    away_message: str | None


class PortalConversationStart(Schema):
    clinician_id: int


class UnreadCount(Schema):
    count: int


class NotificationOut(Schema):
    id: int
    kind: str
    title: str
    body: str
    link: str
    urgent: bool
    read_at: datetime | None
    created_at: datetime


class MarkedRead(Schema):
    marked_read: int
