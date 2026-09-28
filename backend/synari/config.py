"""Application settings loaded from environment variables (and `backend/.env`)."""

import ipaddress
import logging
import secrets
from functools import cached_property
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

logger = logging.getLogger(__name__)

MIN_SECRET_KEY_LENGTH = 32


def is_local_host(host: str) -> bool:
    """Whether traffic to `host` stays on this machine or its Docker network.

    True for loopback addresses, Unix sockets and single-label names (Docker Compose service
    names such as `db` or `mailpit`).
    """
    name = host.strip().strip("[]").lower()
    if not name or name.startswith("/") or name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return "." not in name


class Settings(BaseSettings):
    """All runtime configuration. Optional integrations are disabled when their keys are empty."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"

    # Core
    database_url: str = "postgresql+psycopg://synari:synari@localhost:5432/synari"
    # Database connections per process: kept open, extra ones opened under load, and how long
    # (seconds) a request waits for one before failing. Every API worker and the background
    # worker has its own pool; together they must stay under Postgres' max_connections.
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_pool_timeout: int = 30
    secret_key: str = ""
    # Encrypts sensitive columns and tokens at rest (see synari/crypto.py). Required in
    # production: comma-separated key_id:base64(32 random bytes); the first key encrypts.
    data_encryption_keys: str = ""
    access_token_minutes: int = 30
    frontend_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"
    allow_registration: bool = True
    log_level: str = "INFO"

    # Email (any SMTP provider: SES, Postmark, Resend, Mailgun, Mailpit for local dev)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_security: Literal["starttls", "ssl", "none"] = "starttls"
    email_from: str = "Synari <no-reply@localhost>"

    # SMS reminders (Twilio)
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""

    # Online payments (Stripe)
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_currency: str = "usd"

    # Telehealth (LiveKit, self-hosted or LiveKit Cloud)
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""

    # File storage
    storage_backend: Literal["local", "s3"] = "local"
    storage_local_path: str = "./data/files"
    s3_bucket: str = ""
    s3_region: str = ""
    s3_endpoint_url: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    # Files are always encrypted by Synari first (per-file keys, see services/file_encryption.py);
    # this adds the bucket's own encryption on top. aws:kms uses S3_KMS_KEY_ID (or the bucket's
    # default KMS key when empty).
    s3_sse: Literal["AES256", "aws:kms"] = "AES256"
    s3_kms_key_id: str = ""
    max_upload_bytes: int = 50 * 1024 * 1024
    # Largest file accepted by the SimplePractice importer (exports can be very large).
    import_max_bytes: int = 2 * 1024 * 1024 * 1024

    # Backups (`python -m synari.admin backup`, see deploy/README.md). BACKUP_TARGET is a
    # directory or s3://bucket/prefix (using the S3_* credentials); empty turns backups and
    # their freshness alerts off. Backups are encrypted to the AGE_RECIPIENTS public keys
    # (age1..., comma separated); only the matching private key (AGE_IDENTITY_FILE, kept off
    # this server) can restore them.
    backup_target: str = ""
    backup_retention_count: int = Field(default=14, ge=1)
    age_recipients: str = ""
    age_identity_file: str = ""
    # Server where `admin restore-test` creates its throwaway database (defaults to
    # DATABASE_URL's server; the user needs CREATEDB).
    restore_test_database_url: str = ""

    # AI documentation assistant (optional; only enable with a provider you have a BAA with)
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_model: str = "gpt-4.1"
    openai_transcription_model: str = "whisper-1"

    # Insurance claims clearinghouse (Stedi): claim submission, responses, eligibility checks
    stedi_api_key: str = ""
    stedi_base_url: str = "https://healthcare.us.stedi.com"
    # T sends claims as test data (use with a test API key), P sends them to payers for real.
    stedi_usage: Literal["T", "P"] = "T"

    # Calendar sync with Google Calendar and Microsoft Outlook/365 (each on when its client id
    # and secret are set). OAuth redirect URIs are {PUBLIC_API_URL}/api/calendar-sync/
    # {google|microsoft}/callback; PUBLIC_API_URL defaults to FRONTEND_URL, which is right when
    # the API is served under the app's domain at /api (the Docker/Caddy setup).
    public_api_url: str = ""
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    microsoft_oauth_client_id: str = ""
    microsoft_oauth_client_secret: str = ""
    microsoft_oauth_tenant: str = "common"
    calendar_sync_interval_seconds: int = 300
    # Audit log: sealed events are kept this many years, then purged by the worker. HIPAA
    # requires at least 6 (the database refuses to delete younger events).
    audit_retention_years: int = Field(default=6, ge=6)
    # Sign-in security (see synari/services/sessions.py and synari/services/sign_in.py)
    # Unset: each practice decides whether staff must use two-factor authentication (on by
    # default). true requires it everywhere; false turns the requirement off everywhere.
    require_staff_mfa: bool | None = None
    # Staff sessions end this long after sign-in; idle limits are a practice setting.
    staff_session_hours: int = 12
    # Client-portal sessions end after this much inactivity, and this long after sign-in.
    portal_idle_minutes: int = 30
    portal_session_days: int = 7
    # Check new staff passwords against known breaches (Have I Been Pwned range API; only the
    # first 5 characters of the password's SHA-1 hash leave the server).
    password_breach_check: bool = False
    # Raise a security event when one person opens more than this many clients in an hour.
    security_alert_clients_per_hour: int = 50
    # Where server-wide security alerts (not tied to one practice) are emailed.
    security_alert_email: str = ""

    # Background worker
    worker_interval_seconds: int = 30
    run_worker_in_api: bool = False

    @field_validator("require_staff_mfa", mode="before")
    @classmethod
    def _blank_means_unset(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def _check_secret_key(self) -> "Settings":
        if len(self.secret_key) >= MIN_SECRET_KEY_LENGTH:
            return self
        if self.environment == "production":
            raise ValueError(
                f"SECRET_KEY must be set to at least {MIN_SECRET_KEY_LENGTH} random characters "
                "in production (generate one with: openssl rand -hex 32)"
            )
        self.secret_key = secrets.token_hex(32)
        logger.warning("SECRET_KEY not set; using a random key, so sessions reset on restart.")
        return self

    @model_validator(mode="after")
    def _check_encryption_keys(self) -> "Settings":
        if self.environment == "production" and not self.data_encryption_keys.strip():
            raise ValueError(
                "DATA_ENCRYPTION_KEYS must be set in production, e.g. the output of "
                'echo "k1:$(openssl rand -base64 32)" (see deploy/synari.env.example)'
            )
        return self

    @model_validator(mode="after")
    def _check_production_transport(self) -> "Settings":
        if self.environment != "production":
            return self
        if not self.frontend_url.startswith("https://"):
            raise ValueError(
                "FRONTEND_URL must be an https:// URL in production: sign-in links and the app "
                "must never travel over plain HTTP"
            )
        if (
            self.email_enabled
            and self.smtp_security == "none"
            and not is_local_host(self.smtp_host)
        ):
            raise ValueError(
                f"SMTP_SECURITY=none would send email (with sign-in links) to {self.smtp_host} "
                "unencrypted; use starttls or ssl. none is only allowed for a relay on this "
                "machine or its Docker network."
            )
        database = make_url(self.sqlalchemy_url)
        if not is_local_host(database.host or "") and database.query.get("sslmode") not in (
            "require",
            "verify-ca",
            "verify-full",
        ):
            logger.warning(
                "DATABASE_URL points at a remote server without sslmode=require (or verify-full); "
                "add it so database traffic is encrypted."
            )
        return self

    @property
    def sqlalchemy_url(self) -> str:
        """Database URL normalized to the psycopg 3 driver (accepts postgres:// from hosts)."""
        url = self.database_url
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url

    @property
    def libpq_url(self) -> str:
        """Database URL without the SQLAlchemy driver suffix, for raw psycopg connections."""
        return self.sqlalchemy_url.replace("postgresql+psycopg://", "postgresql://", 1)

    @cached_property
    def allowed_origins(self) -> list[str]:
        """CORS origins: the configured list plus the frontend URL."""
        origins = {o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()}
        origins.add(self.frontend_url.rstrip("/"))
        return sorted(origins)

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host)

    @property
    def sms_enabled(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_from_number)

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_secret_key)

    @property
    def telehealth_enabled(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    @property
    def ai_enabled(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def stedi_enabled(self) -> bool:
        return bool(self.stedi_api_key)

    @property
    def public_api_origin(self) -> str:
        """Where browsers and OAuth providers reach this API (origin, without /api)."""
        return (self.public_api_url or self.frontend_url).rstrip("/")

    @property
    def google_calendar_enabled(self) -> bool:
        return bool(self.google_oauth_client_id and self.google_oauth_client_secret)

    @property
    def microsoft_calendar_enabled(self) -> bool:
        return bool(self.microsoft_oauth_client_id and self.microsoft_oauth_client_secret)


settings = Settings()
