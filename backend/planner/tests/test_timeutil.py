from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from planner.logic.timeutil import end_of_hour, floor_hour, iso_utc, nearest_hour, require_aware

CDT = timezone(timedelta(hours=-5))
INDIA = timezone(timedelta(hours=5, minutes=30))
NEPAL = timezone(timedelta(hours=5, minutes=45))
CHICAGO = ZoneInfo("America/Chicago")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (datetime(2026, 10, 25, 8, 0, tzinfo=UTC), datetime(2026, 10, 25, 8, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 8, 29, 59, tzinfo=UTC), datetime(2026, 10, 25, 8, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 8, 30, tzinfo=UTC), datetime(2026, 10, 25, 9, 0, tzinfo=UTC)),  # half rounds up
        (datetime(2026, 10, 25, 23, 45, tzinfo=UTC), datetime(2026, 10, 26, 0, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 3, 40, tzinfo=CDT), datetime(2026, 10, 25, 9, 0, tzinfo=UTC)),  # 08:40 UTC
        # Rounding happens in UTC, not on the local clock: these offsets are not whole hours.
        (datetime(2026, 10, 25, 8, 0, tzinfo=INDIA), datetime(2026, 10, 25, 3, 0, tzinfo=UTC)),  # 02:30 UTC
        (datetime(2026, 10, 25, 8, 0, tzinfo=NEPAL), datetime(2026, 10, 25, 2, 0, tzinfo=UTC)),  # 02:15 UTC
        # The repeated hour when daylight saving time ends.
        (datetime(2026, 11, 1, 1, 30, tzinfo=CHICAGO, fold=0), datetime(2026, 11, 1, 7, 0, tzinfo=UTC)),
        (datetime(2026, 11, 1, 1, 30, tzinfo=CHICAGO, fold=1), datetime(2026, 11, 1, 8, 0, tzinfo=UTC)),
    ],
)
def test_nearest_hour(value, expected):
    result = nearest_hour(value)
    assert result == expected
    assert result.tzinfo is UTC


def test_floor_hour():
    assert floor_hour(datetime(2026, 10, 25, 8, 59, 59, tzinfo=UTC)) == datetime(2026, 10, 25, 8, tzinfo=UTC)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        # On the hour: the hour that starts there, as in the README's "A up to B" ranges.
        (datetime(2026, 10, 25, 8, 0, tzinfo=UTC), datetime(2026, 10, 25, 9, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 8, 20, tzinfo=UTC), datetime(2026, 10, 25, 9, 0, tzinfo=UTC)),  # nearest is 08:00
        (datetime(2026, 10, 25, 8, 59, 59, 999_999, tzinfo=UTC), datetime(2026, 10, 25, 9, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 23, 45, tzinfo=UTC), datetime(2026, 10, 26, 0, 0, tzinfo=UTC)),
        (datetime(2026, 10, 25, 8, 0, tzinfo=INDIA), datetime(2026, 10, 25, 3, 0, tzinfo=UTC)),  # 02:30 UTC
    ],
)
def test_end_of_hour_ends_the_hour_a_moment_falls_in(value, expected):
    result = end_of_hour(value)
    assert result == expected
    assert result.tzinfo is UTC


def test_naive_datetimes_are_rejected():
    with pytest.raises(ValueError, match="time zone"):
        require_aware(datetime(2026, 10, 25, 8, 0))
    with pytest.raises(ValueError):
        nearest_hour(datetime(2026, 10, 25, 8, 0))


def test_iso_utc():
    moment = datetime(2026, 10, 25, 14, 0, 30, 999, tzinfo=CDT)
    assert iso_utc(moment) == "2026-10-25T19:00:30Z"
