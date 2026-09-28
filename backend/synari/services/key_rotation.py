"""Master key rotation: re-encrypt data at rest under the active DATA_ENCRYPTION_KEYS key.

To rotate: put a new key first in DATA_ENCRYPTION_KEYS (keep the old ones after it), restart
the API and worker, run `python -m synari.admin reencrypt`, and remove an old key only once
the command finds nothing left under it. Encrypted columns are discovered from the models;
stored files only have their small wrapped keys re-encrypted (the files never change). Values
already under the active key are skipped, so the command can be interrupted and run again.
"""

import argparse
import sys
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Column, ColumnElement, Table, Text, and_, bindparam, func, select, update
from sqlalchemy.orm import Session
from sqlalchemy.sql import type_coerce

from synari.crypto import PREFIX, EncryptedJSON, EncryptedText, decrypt, encrypt, keyring
from synari.db import Base, SessionLocal
from synari.models import StoredFile
from synari.services.file_encryption import WRAPPED_KEY_CONTEXT

DEFAULT_BATCH = 500


@dataclass(frozen=True)
class EncryptedColumn:
    """A column holding values produced by synari.crypto.encrypt() for `context`."""

    table: Table
    column: Column[Any]
    context: str

    @property
    def name(self) -> str:
        return f"{self.table.name}.{self.column.name}"

    def raw(self) -> ColumnElement[str]:
        """The stored ciphertext, bypassing the column type's decryption."""
        return type_coerce(self.column, Text)

    def decrypt(self, sealed: str) -> str:
        """The plaintext of one stored value of this column."""
        return decrypt(sealed, self.context)


def encrypted_columns() -> list[EncryptedColumn]:
    """Every encrypted column in the schema, plus the wrapped keys of stored files."""
    found = [
        EncryptedColumn(table, column, column.type.context)
        for table in Base.metadata.sorted_tables
        for column in table.columns
        if isinstance(column.type, EncryptedText | EncryptedJSON)
    ]
    stored_files = StoredFile.__table__
    found.append(EncryptedColumn(stored_files, stored_files.c.wrapped_key, WRAPPED_KEY_CONTEXT))
    return found


def _under_old_key(target: EncryptedColumn, active_key_id: str) -> ColumnElement[bool]:
    raw = target.raw()
    return and_(raw.is_not(None), ~raw.startswith(f"{PREFIX}{active_key_id}:", autoescape=True))


def reencrypt_column(db: Session, target: EncryptedColumn, batch_size: int = DEFAULT_BATCH) -> int:
    """Re-encrypt the column's values that aren't under the active key, a batch per commit.

    Returns how many were re-encrypted. Rows another transaction holds locked are skipped and
    picked up by the next run.
    """
    active_key_id = keyring()[0]
    stale = _under_old_key(target, active_key_id)
    found = db.scalar(select(func.count()).select_from(target.table).where(stale)) or 0
    if not found:
        return 0
    key_columns = list(target.table.primary_key.columns)
    # Re-encrypting isn't an edit, so columns like updated_at keep their values.
    unchanged = {c.name: c for c in target.table.columns if c.onupdate is not None}
    statement = (
        update(target.table)
        .where(*(c == bindparam(f"key_{c.name}") for c in key_columns))
        .values({target.column.name: bindparam("rotated_value", type_=Text), **unchanged})
    )
    done = 0
    while True:
        rows = db.execute(
            select(*key_columns, target.raw().label("sealed"))
            .where(stale)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        if not rows:
            return done
        db.execute(
            statement,
            [
                {
                    **{f"key_{c.name}": row._mapping[c] for c in key_columns},
                    "rotated_value": encrypt(target.decrypt(row.sealed), target.context),
                }
                for row in rows
            ],
        )
        db.commit()
        done += len(rows)
        _say(f"  {target.name}: {done}/{found}")


def reencrypt_all(db: Session, batch_size: int = DEFAULT_BATCH) -> int:
    """Re-encrypt every encrypted column and file key under the active key; returns the count."""
    active_key_id = keyring()[0]
    _say(f"Re-encrypting under key {active_key_id!r}")
    total = 0
    for target in encrypted_columns():
        total += reencrypt_column(db, target, batch_size)
    _say(f"Done: {total} value(s) re-encrypted")
    return total


def _say(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Options for `admin reencrypt`."""
    parser.add_argument(
        "--batch",
        type=int,
        default=DEFAULT_BATCH,
        help=f"rows re-encrypted per transaction (default {DEFAULT_BATCH})",
    )


def run(args: argparse.Namespace) -> int:
    """`admin reencrypt`: re-encrypt everything not under the active key."""
    if args.batch < 1:
        _say("--batch must be at least 1")
        return 2
    with SessionLocal() as db:
        reencrypt_all(db, args.batch)
    return 0
