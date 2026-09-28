"""Business days for No Surprises Act deadlines: weekdays that aren't US federal holidays.

Holidays are computed (5 U.S.C. 6103), including the observed date when one falls on a
weekend: a Saturday holiday is observed the Friday before (so New Year's Day on a Saturday is
observed on December 31 of the year before), a Sunday holiday the Monday after.
"""

from datetime import date, timedelta
from functools import cache

MONDAY, THURSDAY, SATURDAY, SUNDAY = 0, 3, 5, 6
JUNETEENTH_FIRST_YEAR = 2021


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The n-th `weekday` of a month (n = 1 is the first)."""
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """The last `weekday` of a month."""
    next_month = date(year + month // 12, month % 12 + 1, 1)
    last = next_month - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _observed(day: date) -> date:
    """When a fixed-date holiday is observed if it falls on a weekend."""
    if day.weekday() == SATURDAY:
        return day - timedelta(days=1)
    if day.weekday() == SUNDAY:
        return day + timedelta(days=1)
    return day


def _holidays_of(year: int) -> list[date]:
    """The observed dates of `year`'s federal holidays (one may fall in the year before)."""
    fixed = [date(year, 1, 1), date(year, 7, 4), date(year, 11, 11), date(year, 12, 25)]
    if year >= JUNETEENTH_FIRST_YEAR:
        fixed.append(date(year, 6, 19))
    return [
        *(_observed(day) for day in fixed),
        _nth_weekday(year, 1, MONDAY, 3),  # Birthday of Martin Luther King, Jr.
        _nth_weekday(year, 2, MONDAY, 3),  # Washington's Birthday
        _last_weekday(year, 5, MONDAY),  # Memorial Day
        _nth_weekday(year, 9, MONDAY, 1),  # Labor Day
        _nth_weekday(year, 10, MONDAY, 2),  # Columbus Day
        _nth_weekday(year, 11, THURSDAY, 4),  # Thanksgiving Day
    ]


@cache
def federal_holidays(year: int) -> frozenset[date]:
    """Days in `year` on which a federal holiday is observed."""
    days = [*_holidays_of(year), *_holidays_of(year + 1)]
    return frozenset(day for day in days if day.year == year)


def is_business_day(day: date) -> bool:
    """A weekday that isn't an observed federal holiday."""
    return day.weekday() < SATURDAY and day not in federal_holidays(day.year)


def add_business_days(day: date, count: int) -> date:
    """The business day `count` business days after `day` (before it when negative).

    `day` itself needn't be a business day: one business day after a Saturday is Monday
    (or Tuesday when Monday is a holiday).
    """
    step = timedelta(days=1 if count >= 0 else -1)
    remaining = abs(count)
    current = day
    while remaining:
        current += step
        if is_business_day(current):
            remaining -= 1
    return current


def business_days_between(start: date, end: date) -> int:
    """How many business days fall in [start, end): 0 when end isn't after start."""
    count = 0
    current = start
    while current < end:
        if is_business_day(current):
            count += 1
        current += timedelta(days=1)
    return count
