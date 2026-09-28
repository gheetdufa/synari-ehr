"""Accounting of disclosures (HIPAA 164.528): the client's right to know who received their
information outside treatment, payment and health care operations in the last six years."""

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from synari.models import Client, Disclosure
from synari.services.pdf import ACCENT, MUTED, BaseDocument
from synari.services.request_deadlines import format_day, practice_today

ACCOUNTING_YEARS = 6


def _years_before(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # February 29th
        return day.replace(year=day.year - years, day=28)


@dataclass(frozen=True)
class DisclosureReport:
    """A client's disclosures from `period_start` through `period_end`, oldest first."""

    client: Client
    period_start: date
    period_end: date
    generated_at: datetime
    disclosures: list[Disclosure]

    @property
    def client_id(self) -> int:
        return self.client.id

    @property
    def client_name(self) -> str:
        return self.client.full_name

    @property
    def practice_name(self) -> str:
        return self.client.practice.name


def client_disclosures(db: Session, client: Client) -> list[Disclosure]:
    """Every disclosure recorded for the client, newest first."""
    return list(
        db.scalars(
            select(Disclosure)
            .where(Disclosure.client_id == client.id)
            .order_by(Disclosure.disclosed_on.desc(), Disclosure.id.desc())
        )
    )


def accounting_report(db: Session, client: Client, now: datetime) -> DisclosureReport:
    """The accounting for the six years up to today (practice time zone)."""
    today = practice_today(client.practice, now)
    start = _years_before(today, ACCOUNTING_YEARS)
    disclosures = db.scalars(
        select(Disclosure)
        .where(
            Disclosure.client_id == client.id,
            Disclosure.disclosed_on >= start,
            Disclosure.disclosed_on <= today,
        )
        .order_by(Disclosure.disclosed_on, Disclosure.id)
    ).all()
    return DisclosureReport(client, start, today, now, list(disclosures))


def accounting_csv(report: DisclosureReport) -> str:
    """The accounting as CSV, one row per disclosure."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["date", "recipient", "recipient_address", "description", "purpose", "legal_basis"]
    )
    for disclosure in report.disclosures:
        writer.writerow(
            [
                disclosure.disclosed_on.isoformat(),
                disclosure.recipient_name,
                disclosure.recipient_address,
                disclosure.description,
                disclosure.purpose,
                disclosure.legal_basis,
            ]
        )
    return buffer.getvalue()


def accounting_pdf(report: DisclosureReport) -> bytes:
    """The accounting as a printable letter-size PDF."""
    document = BaseDocument(
        "Accounting of disclosures", footer_text=f"Confidential | {report.client_name}"
    )
    document.write_block(report.practice_name, size=14, style="B", color=ACCENT)
    document.write_block(
        "Accounting of disclosures", size=16, style="B", line_height=7, space_after=2
    )
    for line in (
        f"Client: {report.client_name}",
        f"Period: {format_day(report.period_start)} to {format_day(report.period_end)}",
        f"Prepared: {format_day(report.period_end)}",
    ):
        document.write_block(line, color=MUTED)
    document.rule(6)
    document.write_block(
        "This lists disclosures of your health information made outside treatment, payment "
        "and health care operations during the period above, as HIPAA requires "
        "(45 CFR 164.528).",
        color=MUTED,
        space_after=4,
    )
    if not report.disclosures:
        document.write_block("No disclosures were made during this period.")
        return document.output_bytes()
    for disclosure in report.disclosures:
        document.keep_together(30)
        document.write_block(
            f"{format_day(disclosure.disclosed_on)}: {disclosure.recipient_name}", style="B"
        )
        if disclosure.recipient_address:
            document.write_block(disclosure.recipient_address, color=MUTED)
        document.write_block(f"What was disclosed: {disclosure.description}")
        document.write_block(f"Purpose: {disclosure.purpose}")
        if disclosure.legal_basis:
            document.write_block(f"Basis: {disclosure.legal_basis}", color=MUTED)
        document.rule(5)
    return document.output_bytes()
