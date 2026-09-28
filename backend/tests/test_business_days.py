"""Business days (weekends and observed US federal holidays) and No Surprises Act deadlines."""

from datetime import date

import pytest

from synari.services.business_days import (
    add_business_days,
    business_days_between,
    federal_holidays,
    is_business_day,
)
from synari.services.estimates import (
    max_period_end,
    request_due_date,
    scheduling_due_date,
    update_due_date,
)


def test_2026_federal_holidays() -> None:
    assert sorted(federal_holidays(2026)) == [
        date(2026, 1, 1),  # New Year's Day
        date(2026, 1, 19),  # Martin Luther King, Jr. Day: third Monday of January
        date(2026, 2, 16),  # Washington's Birthday: third Monday of February
        date(2026, 5, 25),  # Memorial Day: last Monday of May
        date(2026, 6, 19),  # Juneteenth
        date(2026, 7, 3),  # Independence Day falls on a Saturday: observed Friday
        date(2026, 9, 7),  # Labor Day: first Monday of September
        date(2026, 10, 12),  # Columbus Day: second Monday of October
        date(2026, 11, 11),  # Veterans Day
        date(2026, 11, 26),  # Thanksgiving: fourth Thursday of November
        date(2026, 12, 25),  # Christmas Day
    ]


@pytest.mark.parametrize(
    ("observed", "year", "why"),
    [
        (date(2021, 12, 31), 2021, "New Year's Day 2022 is a Saturday"),
        (date(2021, 6, 18), 2021, "Juneteenth 2021 is a Saturday"),
        (date(2021, 7, 5), 2021, "Independence Day 2021 is a Sunday"),
        (date(2022, 6, 20), 2022, "Juneteenth 2022 is a Sunday"),
        (date(2022, 12, 26), 2022, "Christmas 2022 is a Sunday"),
        (date(2027, 12, 24), 2027, "Christmas 2027 is a Saturday"),
        (date(2027, 12, 31), 2027, "New Year's Day 2028 is a Saturday"),
    ],
)
def test_weekend_holidays_are_observed_on_the_nearest_weekday(
    observed: date, year: int, why: str
) -> None:
    assert observed in federal_holidays(year), why
    assert not is_business_day(observed)


def test_holidays_belong_to_the_year_they_are_observed_in() -> None:
    # New Year's Day 2022 (a Saturday) was observed in 2021, so 2022 has no January 1st day off.
    assert date(2021, 12, 31) not in federal_holidays(2022)
    assert date(2022, 1, 1) not in federal_holidays(2022)
    # Juneteenth became a federal holiday in 2021.
    assert date(2020, 6, 19) not in federal_holidays(2020)


@pytest.mark.parametrize(
    ("start", "count", "expected"),
    [
        (date(2026, 10, 2), 1, date(2026, 10, 5)),  # Friday -> Monday
        (date(2026, 10, 3), 1, date(2026, 10, 5)),  # Saturday -> Monday
        (date(2026, 10, 9), 1, date(2026, 10, 13)),  # over Columbus Day
        (date(2026, 7, 2), 1, date(2026, 7, 6)),  # over the observed Independence Day
        (date(2026, 11, 25), 1, date(2026, 11, 27)),  # over Thanksgiving
        (date(2026, 10, 5), 3, date(2026, 10, 8)),
        (date(2026, 10, 13), -1, date(2026, 10, 9)),  # back over Columbus Day
        (date(2026, 10, 5), -1, date(2026, 10, 2)),  # Monday -> Friday
        (date(2026, 10, 5), 0, date(2026, 10, 5)),
    ],
)
def test_add_business_days(start: date, count: int, expected: date) -> None:
    assert add_business_days(start, count) == expected


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (date(2026, 10, 5), date(2026, 10, 8), 3),
        (date(2026, 10, 5), date(2026, 10, 19), 9),  # Columbus Day doesn't count
        (date(2026, 10, 3), date(2026, 10, 7), 2),  # the weekend doesn't count
        (date(2026, 10, 8), date(2026, 10, 5), 0),
    ],
)
def test_business_days_between(start: date, end: date, expected: int) -> None:
    assert business_days_between(start, end) == expected


@pytest.mark.parametrize(
    ("scheduled_on", "service_on", "due"),
    [
        # Scheduled at least 3 business days ahead: due 1 business day after scheduling.
        (date(2026, 10, 5), date(2026, 10, 8), date(2026, 10, 6)),
        (date(2026, 10, 5), date(2026, 10, 19), date(2026, 10, 6)),
        (date(2026, 7, 2), date(2026, 7, 9), date(2026, 7, 6)),
        (date(2026, 10, 3), date(2026, 10, 10), date(2026, 10, 5)),  # scheduled on a Saturday
        # At least 10 business days ahead: due 3 business days after scheduling.
        (date(2026, 10, 5), date(2026, 10, 20), date(2026, 10, 8)),
        (date(2026, 11, 20), date(2027, 1, 4), date(2026, 11, 25)),
        # Fewer than 3 business days ahead: no estimate is triggered.
        (date(2026, 10, 5), date(2026, 10, 7), None),
        (date(2026, 10, 3), date(2026, 10, 7), None),
        (date(2026, 10, 5), date(2026, 10, 5), None),
    ],
)
def test_scheduling_due_date(scheduled_on: date, service_on: date, due: date | None) -> None:
    assert scheduling_due_date(scheduled_on, service_on) == due


@pytest.mark.parametrize(
    ("requested_on", "due"),
    [
        (date(2026, 11, 20), date(2026, 11, 25)),
        (date(2026, 11, 24), date(2026, 11, 30)),  # over Thanksgiving
        (date(2026, 10, 3), date(2026, 10, 7)),  # asked on a Saturday
    ],
)
def test_requested_estimates_are_due_in_3_business_days(requested_on: date, due: date) -> None:
    assert request_due_date(requested_on) == due


@pytest.mark.parametrize(
    ("next_session", "due"),
    [
        (date(2026, 10, 13), date(2026, 10, 9)),  # Tuesday after Columbus Day -> Friday
        (date(2026, 7, 6), date(2026, 7, 2)),  # Monday after the observed July 4th
        (date(2026, 10, 8), date(2026, 10, 7)),
    ],
)
def test_updates_are_due_1_business_day_before_the_next_session(
    next_session: date, due: date
) -> None:
    assert update_due_date(next_session) == due


@pytest.mark.parametrize(
    ("start", "last_day"),
    [
        (date(2026, 1, 15), date(2027, 1, 14)),
        (date(2026, 10, 1), date(2027, 9, 30)),
        (date(2028, 2, 29), date(2029, 2, 28)),
    ],
)
def test_estimates_cover_at_most_12_months(start: date, last_day: date) -> None:
    assert max_period_end(start) == last_day
