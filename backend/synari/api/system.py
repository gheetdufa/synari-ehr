"""Health check and the public feature configuration the web app reads at startup."""

from fastapi import APIRouter
from sqlalchemy import text

from synari.config import settings
from synari.deps import DbSession
from synari.schemas.common import Schema

router = APIRouter(tags=["system"])


class Health(Schema):
    status: str
    database: bool


class PublicConfig(Schema):
    registration_enabled: bool
    email_enabled: bool
    sms_enabled: bool
    payments_enabled: bool
    telehealth_enabled: bool
    ai_enabled: bool
    livekit_url: str
    currency: str
    max_upload_bytes: int
    import_max_bytes: int


@router.get("/health", response_model=Health)
def health(db: DbSession) -> Health:
    """Liveness plus a database round-trip."""
    db.execute(text("SELECT 1"))
    return Health(status="ok", database=True)


@router.get("/config", response_model=PublicConfig)
def public_config() -> PublicConfig:
    """Which optional integrations this server has configured (no secrets)."""
    return PublicConfig(
        registration_enabled=settings.allow_registration,
        email_enabled=settings.email_enabled,
        sms_enabled=settings.sms_enabled,
        payments_enabled=settings.stripe_enabled,
        telehealth_enabled=settings.telehealth_enabled,
        ai_enabled=settings.ai_enabled,
        livekit_url=settings.livekit_url if settings.telehealth_enabled else "",
        currency=settings.stripe_currency.upper(),
        max_upload_bytes=settings.max_upload_bytes,
        import_max_bytes=settings.import_max_bytes,
    )
