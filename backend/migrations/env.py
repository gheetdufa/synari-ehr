"""Alembic environment: uses the app's settings and model metadata."""

from logging.config import fileConfig
from typing import Any

from alembic import context
from alembic.autogenerate.api import AutogenContext
from sqlalchemy import engine_from_config, pool
from sqlalchemy.types import TypeDecorator

import synari.models  # noqa: F401  (registers all tables)
from synari.config import settings
from synari.db import Base

config = context.config
target_metadata = Base.metadata

# From the command line (e.g. the container's `alembic upgrade head`), log each migration as
# alembic.ini says; when the app or tests run migrations in-process, their logging stays.
if config.cmd_opts is not None and config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)


def render_item(kind: str, obj: Any, autogen_context: AutogenContext) -> str | bool:
    """Write app-level column types (e.g. encrypted text) as the database type they store."""
    if kind == "type" and isinstance(obj, TypeDecorator):
        return f"sa.{type(obj.impl).__name__}()"
    return False


def run_migrations_offline() -> None:
    context.configure(
        url=settings.sqlalchemy_url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = settings.sqlalchemy_url
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            render_item=render_item,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
