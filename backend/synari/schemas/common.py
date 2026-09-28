"""Base schema and shared field types."""

from typing import Annotated, ClassVar, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, model_validator


class Schema(BaseModel):
    """Base for API schemas; can be built from ORM objects."""

    model_config = ConfigDict(from_attributes=True)


def _lower(value: str) -> str:
    return value.strip().lower()


def _valid_time_zone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown time zone: {value}") from exc
    return value


Email = Annotated[EmailStr, AfterValidator(_lower)]
TimeZone = Annotated[str, AfterValidator(_valid_time_zone)]
# New staff passwords; synari/services/passwords.py applies the rest of the policy.
Password = Annotated[str, Field(min_length=12, max_length=256)]
ShortText = Annotated[str, Field(max_length=200)]
LongText = Annotated[str, Field(max_length=20_000)]


class PartialUpdate(Schema):
    """Base for PATCH bodies: fields may be left out, but only NULLABLE ones may be set to null."""

    NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def _reject_nulls(self) -> Self:
        cleared = sorted(
            name
            for name in self.model_fields_set
            if getattr(self, name) is None and name not in self.NULLABLE
        )
        if cleared:
            raise ValueError(f"{', '.join(cleared)} can't be empty")
        return self


class TokenResponse(Schema):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class Message(Schema):
    detail: str
