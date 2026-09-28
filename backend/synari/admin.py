"""Server administration commands: `python -m synari.admin <command> [options]`.

For operators with shell access to the server. Changes are audited with the "system" actor.

  reset-mfa EMAIL    turn off someone's two-factor authentication (e.g. a lost phone) and
                     sign them out everywhere; they set it up again at their next sign-in
  unlock EMAIL       clear sign-in throttling after repeated failed attempts
  create-owner       add an owner to a practice (e.g. when its only owner has left)
  audit-verify       recompute the audit log's hash chains and checkpoints; exits 1 if any
                     chain fails (prints ids and counts only)
  reencrypt          re-encrypt encrypted columns and stored-file keys under the active key
                     (after adding a key to DATA_ENCRYPTION_KEYS); safe to rerun
  backup             encrypted backup (age) of the database and local files to BACKUP_TARGET
  restore-test       restore the latest backup into a throwaway database and check it reads

Commands use the same settings as the API (environment variables and backend/.env) and the
same redacted logging; their progress goes to stdout.

Adding a command: keep the logic in services/ so tests can call it without the CLI, and
register a runner here with `@command(name, help, add_arguments)`. Each gets its own argparse
subparser and a database session.
"""

import argparse
import getpass
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.audit import audit_system
from synari.db import SessionLocal, utcnow
from synari.logs import configure_logging
from synari.models import Practice, StaffMember
from synari.models.enums import SecuritySeverity, StaffRole, StaffStatus
from synari.schemas.common import Email
from synari.security import hash_password
from synari.services import backups, key_rotation
from synari.services.audit_chain import ChainReport, verify_all, verify_chain
from synari.services.passwords import context_words, password_problem
from synari.services.security_events import (
    ACCOUNT_UNLOCKED,
    OWNER_CREATED,
    record_security_event,
)
from synari.services.sign_in import clear_throttle, reset_mfa

Runner = Callable[[Session, argparse.Namespace], int]


@dataclass(frozen=True)
class Command:
    """A subcommand: its help text, how it adds its arguments and what it runs."""

    help: str
    arguments: Callable[[argparse.ArgumentParser], None]
    run: Runner


COMMANDS: dict[str, Command] = {}


def command(
    name: str, help_text: str, arguments: Callable[[argparse.ArgumentParser], None]
) -> Callable[[Runner], Runner]:
    """Register a subcommand."""

    def register(run: Runner) -> Runner:
        COMMANDS[name] = Command(help_text, arguments, run)
        return run

    return register


def _say(message: str) -> None:
    sys.stdout.write(message + "\n")


def _fail(message: str) -> int:
    sys.stderr.write(message + "\n")
    return 1


def _email_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("email", help="the staff member's email address")


def _staff_by_email(db: Session, email: str) -> StaffMember | None:
    return db.scalar(select(StaffMember).where(StaffMember.email == email.strip().lower()))


@command("reset-mfa", "turn off a staff member's two-factor authentication", _email_argument)
def reset_mfa_command(db: Session, args: argparse.Namespace) -> int:
    """Reset 2FA for the staff member with this email."""
    staff = _staff_by_email(db, args.email)
    if staff is None:
        return _fail(f"No staff account with the email {args.email}")
    if not staff.mfa_enabled:
        _say("Two-factor authentication is already off for this account.")
        return 0
    reset_mfa(db, staff, reset_by_id=None)
    audit_system(
        db,
        "admin.mfa_reset",
        practice_id=staff.practice_id,
        resource_type="staff",
        resource_id=staff.id,
    )
    db.commit()
    _say(f"Two-factor authentication was reset for {staff.email}; they were signed out.")
    return 0


@command("unlock", "clear sign-in throttling for a staff member", _email_argument)
def unlock_command(db: Session, args: argparse.Namespace) -> int:
    """Let the staff member with this email sign in again right away."""
    staff = _staff_by_email(db, args.email)
    if staff is None:
        return _fail(f"No staff account with the email {args.email}")
    clear_throttle(staff)
    audit_system(
        db,
        "admin.unlock",
        practice_id=staff.practice_id,
        resource_type="staff",
        resource_id=staff.id,
    )
    record_security_event(
        db,
        practice_id=staff.practice_id,
        kind=ACCOUNT_UNLOCKED,
        severity=SecuritySeverity.INFO,
        staff_id=staff.id,
    )
    db.commit()
    _say(f"Sign-in unlocked for {staff.email}.")
    return 0


def _owner_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--practice-id", type=int, required=True, help="the practice's id")
    parser.add_argument("--email", required=True)
    parser.add_argument("--first-name", required=True)
    parser.add_argument("--last-name", required=True)
    parser.add_argument(
        "--password",
        help="the new owner's password (prompted for when left out, which keeps it out of "
        "shell history)",
    )
    parser.add_argument(
        "--clinician", action="store_true", help="the owner also sees clients as a clinician"
    )


def _prompt_password() -> str | None:
    first = getpass.getpass("Password: ")
    if getpass.getpass("Repeat password: ") != first:
        return None
    return first


@command("create-owner", "add an owner to a practice", _owner_arguments)
def create_owner_command(db: Session, args: argparse.Namespace) -> int:
    """Create an active owner account in an existing practice."""
    practice = db.get(Practice, args.practice_id)
    if practice is None:
        return _fail(f"No practice with id {args.practice_id}")
    try:
        email = TypeAdapter(Email).validate_python(args.email)
    except ValidationError:
        return _fail(f"{args.email} isn't a valid email address")
    if _staff_by_email(db, email) is not None:
        return _fail(f"Someone with the email {email} already has an account")
    password = args.password if args.password is not None else _prompt_password()
    if password is None:
        return _fail("The passwords don't match")
    problem = password_problem(
        password, context=context_words(email, args.first_name, args.last_name, practice.name)
    )
    if problem is not None:
        return _fail(problem)
    owner = StaffMember(
        practice_id=practice.id,
        email=email,
        password_hash=hash_password(password),
        password_changed_at=utcnow(),
        first_name=args.first_name.strip(),
        last_name=args.last_name.strip(),
        role=StaffRole.OWNER,
        status=StaffStatus.ACTIVE,
        is_clinician=args.clinician,
        time_zone=practice.time_zone,
    )
    db.add(owner)
    db.flush()
    audit_system(
        db,
        "admin.create_owner",
        practice_id=practice.id,
        resource_type="staff",
        resource_id=owner.id,
    )
    record_security_event(
        db,
        practice_id=practice.id,
        kind=OWNER_CREATED,
        severity=SecuritySeverity.WARNING,
        staff_id=owner.id,
    )
    db.commit()
    _say(f"Created owner {email} (staff id {owner.id}) in {practice.name}.")
    return 0


def _practice_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--practice", type=int, help="only this practice's chain")


def _describe(report: ChainReport) -> str:
    chain = f"practice {report.practice_id}" if report.practice_id else "no practice"
    if report.verified:
        head = f", head event {report.head_event_id}" if report.head_event_id else ""
        return f"OK      {chain}: {report.sealed_events} sealed events{head}"
    return f"FAILED  {chain}: {report.problem}"


@command("audit-verify", "verify the audit log's hash chains", _practice_argument)
def audit_verify_command(db: Session, args: argparse.Namespace) -> int:
    """Verify one practice's audit chain, or every chain."""
    reports = [verify_chain(db, args.practice)] if args.practice else verify_all(db)
    for report in reports:
        _say(_describe(report))
    return 0 if all(report.verified for report in reports) else 1


def _no_arguments(parser: argparse.ArgumentParser) -> None:
    del parser


@command(
    "reencrypt",
    "re-encrypt encrypted columns and stored-file keys under the active key",
    key_rotation.add_arguments,
)
def reencrypt_command(db: Session, args: argparse.Namespace) -> int:
    """Rewrite encrypted data under the active key (uses its own sessions)."""
    del db
    return key_rotation.run(args)


@command("backup", "encrypted backup of the database and local files", _no_arguments)
def backup_command(db: Session, args: argparse.Namespace) -> int:
    """Back up to BACKUP_TARGET, encrypted to AGE_RECIPIENTS."""
    del db
    return backups.run_backup(args)


@command(
    "restore-test",
    "restore the latest backup into a throwaway database and check it",
    backups.add_restore_test_arguments,
)
def restore_test_command(db: Session, args: argparse.Namespace) -> int:
    """Prove the latest backup restores and decrypts."""
    del db
    return backups.run_restore_test(args)


def build_parser() -> argparse.ArgumentParser:
    """The command-line parser with every registered subcommand."""
    parser = argparse.ArgumentParser(
        prog="python -m synari.admin", description=__doc__.split("\n")[0]
    )
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name, registered in COMMANDS.items():
        registered.arguments(subcommands.add_parser(name, help=registered.help))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run one admin command; returns the process exit code."""
    args = build_parser().parse_args(argv)
    configure_logging()
    with SessionLocal() as db:
        return COMMANDS[args.command].run(db, args)


if __name__ == "__main__":
    sys.exit(main())
