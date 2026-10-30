"""Time helpers. All time math in the app is done in UTC."""

from datetime import UTC, datetime, timedelta


def require_aware(moment: datetime) -> datetime:
    """The same instant in UTC; refuses datetimes without a time zone."""
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("datetime must include a time zone")
    return moment.astimezone(UTC)


def floor_hour(moment: datetime) -> datetime:
    return require_aware(moment).replace(minute=0, second=0, microsecond=0)


def nearest_hour(moment: datetime) -> datetime:
    """The forecast hour nearest to `moment`; exactly half past rounds up."""
    start = floor_hour(moment)
    return start + timedelta(hours=1) if require_aware(moment) - start >= timedelta(minutes=30) else start


def end_of_hour(moment: datetime) -> datetime:
    """The end of the hour `moment` falls in. Hours run from :00 up to the next :00, so a moment on
    the hour falls in the hour that starts there."""
    return floor_hour(moment) + timedelta(hours=1)


def iso_utc(moment: datetime) -> str:
    """ISO 8601 in UTC with a Z suffix, to the second."""
    return require_aware(moment).strftime("%Y-%m-%dT%H:%M:%SZ")
