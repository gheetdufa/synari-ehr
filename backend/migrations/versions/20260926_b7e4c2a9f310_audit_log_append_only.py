"""audit log append-only

Makes the audit trail tamper-evident at the database level (hand-written: triggers aren't part
of the models, so autogenerate never touches them):

- audit_events: UPDATE is refused except to seal an unsealed event (setting only prev_hash, hash
  and sealed_at; see synari/services/audit_chain.py). DELETE is refused except for sealed events
  older than six years (the HIPAA minimum; AUDIT_RETENTION_YEARS may keep them longer) in a
  transaction that set `synari.audit_purge = on` (the worker's retention purge).
- audit_checkpoints: never updated or deleted.
- Both refuse TRUNCATE.

Revision ID: b7e4c2a9f310
Revises: 701ae93f8c7b
Create Date: 2026-09-26 04:10:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b7e4c2a9f310"
down_revision: str | None = "701ae93f8c7b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AUDIT_EVENTS_GUARD = """
CREATE FUNCTION audit_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.sealed_at IS NULL
           AND NEW.sealed_at IS NOT NULL
           AND NEW.prev_hash IS NOT NULL
           AND NEW.hash IS NOT NULL
           AND NEW.id = OLD.id
           AND NEW.practice_id IS NOT DISTINCT FROM OLD.practice_id
           AND NEW.client_id IS NOT DISTINCT FROM OLD.client_id
           AND NEW.actor_role = OLD.actor_role
           AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
           AND NEW.action = OLD.action
           AND NEW.resource_type = OLD.resource_type
           AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
           AND NEW.ip_address = OLD.ip_address
           AND NEW.user_agent = OLD.user_agent
           AND NEW.detail::text IS NOT DISTINCT FROM OLD.detail::text
           AND NEW.created_at = OLD.created_at
        THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'audit events are append-only: only an unsealed event can be sealed';
    END IF;
    IF current_setting('synari.audit_purge', true) = 'on'
       AND OLD.sealed_at IS NOT NULL
       AND OLD.created_at < now() - interval '6 years'
    THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit events are append-only: only sealed events past retention can be purged';
END;
$$;
"""

AUDIT_CHECKPOINTS_GUARD = """
CREATE FUNCTION audit_checkpoints_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit checkpoints are append-only';
END;
$$;
"""

REFUSE_TRUNCATE = """
CREATE FUNCTION audit_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME;
END;
$$;
"""


def upgrade() -> None:
    op.execute(AUDIT_EVENTS_GUARD)
    op.execute(AUDIT_CHECKPOINTS_GUARD)
    op.execute(REFUSE_TRUNCATE)
    op.execute(
        "CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events "
        "FOR EACH ROW EXECUTE FUNCTION audit_events_guard()"
    )
    op.execute(
        "CREATE TRIGGER audit_checkpoints_append_only BEFORE UPDATE OR DELETE ON "
        "audit_checkpoints FOR EACH ROW EXECUTE FUNCTION audit_checkpoints_guard()"
    )
    for table in ("audit_events", "audit_checkpoints"):
        op.execute(
            f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION audit_refuse_truncate()"
        )


def downgrade() -> None:
    for table in ("audit_events", "audit_checkpoints"):
        op.execute(f"DROP TRIGGER {table}_no_truncate ON {table}")
    op.execute("DROP TRIGGER audit_checkpoints_append_only ON audit_checkpoints")
    op.execute("DROP TRIGGER audit_events_append_only ON audit_events")
    op.execute("DROP FUNCTION audit_refuse_truncate()")
    op.execute("DROP FUNCTION audit_checkpoints_guard()")
    op.execute("DROP FUNCTION audit_events_guard()")
