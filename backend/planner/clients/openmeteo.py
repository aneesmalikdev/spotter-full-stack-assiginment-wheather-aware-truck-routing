"""Open-Meteo hourly forecasts for many places at once, cached per place and UTC day.

Each place in a request counts as one call against the free API's limits (600 a minute, 5,000 an
hour, 10,000 a day per IP address), so places are cached for an hour and only missing ones are
fetched. When a limit is hit the plan fails with a message saying when to try again, unless the
limit resets within 15 seconds (the per-minute count near the end of a minute, or Open-Meteo's
one-request-at-a-time rule): the server then waits it out once and asks again.
"""

import logging
import math
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Protocol

import requests
from django.core.cache import cache

from planner.errors import ServiceBusy, ServiceError
from planner.logic.geo import LatLon
from planner.logic.weather import ForecastSeries

logger = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HOURLY_VARIABLES = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall")
EXPECTED_UNITS = {"wind_speed_10m": "mp/h", "wind_gusts_10m": "mp/h", "rain": "inch", "showers": "inch", "snowfall": "inch"}
MAX_LOCATIONS_PER_REQUEST = 1000
FORECAST_DAYS = 16  # today and the next 15 days (UTC)
TIMEOUT_S = 10.0
CACHE_TTL_S = 3600
FETCH_WAIT_S = 10.0  # how long a plan waits for another plan's fetch before giving up
RESET_MARGIN_S = 2  # Open-Meteo resets its counts on the minute, hour and day; retry just after
SHORT_WAIT_S = 15  # a limit that resets this soon is waited out once (plus the margin) instead of failing the plan

# One fetch at a time per process: concurrent plans for the same area then share the result instead
# of each spending the rate limit on it (Open-Meteo also serves one request per IP at a time).
# Plans whose forecasts are all cached never wait for it.
_fetch_lock = threading.Lock()

# One UTC day of one place's forecast: times, wind, gusts, rain, showers, snowfall.
DayForecast = tuple[tuple, tuple, tuple, tuple, tuple, tuple]
NO_DAY: DayForecast = ((), (), (), (), (), ())


class _ShortLimit(ServiceBusy):
    """A limit that resets within a minute: the per-minute count, or one request at a time."""


class ForecastService(Protocol):
    """What planning needs from Open-Meteo (OpenMeteoClient, or a stand-in in tests)."""

    def forecasts(self, points: Iterable[LatLon], start: datetime, end: datetime) -> dict[LatLon, ForecastSeries]: ...


def forecast_horizon(now: datetime) -> datetime:
    """The last hour Open-Meteo forecasts (23:00 UTC of the last forecast day)."""
    last_day = now.astimezone(UTC).date() + timedelta(days=FORECAST_DAYS - 1)
    return datetime(last_day.year, last_day.month, last_day.day, 23, tzinfo=UTC)


class OpenMeteoClient:
    def __init__(
        self,
        session: requests.Session | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._session = session or requests.Session()
        self._now = now
        self._sleep = sleep

    def forecasts(self, points: Iterable[LatLon], start: datetime, end: datetime) -> dict[LatLon, ForecastSeries]:
        """Hourly forecasts from `start` to `end` (UTC) for each point. Hours the forecast doesn't
        cover are simply missing from the series ("No data")."""
        points = list(dict.fromkeys(points))
        days = self._days(start, end)
        if not days:
            return {point: ForecastSeries({}) for point in points}
        keys = {point: [_key(point, day) for day in days] for point in points}
        stored = cache.get_many([key for point in points for key in keys[point]])
        missing = [point for point in points if any(key not in stored for key in keys[point])]
        if missing:
            stored.update(self._fetch_missing(missing, days, keys))
        return {point: _series([stored[key] for key in keys[point]]) for point in points}

    def _fetch_missing(
        self, points: Sequence[LatLon], days: Sequence[date], keys: dict[LatLon, list[str]]
    ) -> dict[str, DayForecast]:
        """Forecasts for places that were not cached, fetched one plan at a time. Places another
        plan fetched while this one waited come from the cache."""
        if not _fetch_lock.acquire(timeout=FETCH_WAIT_S):
            raise ServiceBusy("The weather service is busy with other plans. Please try again in a few seconds.", retry_after_s=5)
        try:
            stored = cache.get_many([key for point in points for key in keys[point]])
            missing = [point for point in points if any(key not in stored for key in keys[point])]
            for batch in _batches(missing):
                fetched = self._fetch(batch, days)
                cache.set_many(fetched, timeout=CACHE_TTL_S)  # stored per batch, so a retry only fetches the rest
                stored.update(fetched)
            return stored
        finally:
            _fetch_lock.release()

    def _days(self, start: datetime, end: datetime) -> list[date]:
        """UTC days from start to end, cut to the days Open-Meteo forecasts."""
        today = self._now().astimezone(UTC).date()
        first = max(start.astimezone(UTC).date(), today - timedelta(days=1))
        last = min(end.astimezone(UTC).date(), today + timedelta(days=FORECAST_DAYS - 1))
        return [first + timedelta(days=n) for n in range((last - first).days + 1)]

    def _fetch(self, points: Sequence[LatLon], days: Sequence[date]) -> dict[str, DayForecast]:
        """One request, asked once more after the wait if a limit that resets within 15 s refused it."""
        try:
            return self._request(points, days)
        except _ShortLimit as limit:
            if limit.retry_after_s is None or limit.retry_after_s > SHORT_WAIT_S + RESET_MARGIN_S:
                raise
            logger.info("Open-Meteo limit resets in %s s; waiting once", limit.retry_after_s)
            self._sleep(limit.retry_after_s)
            return self._request(points, days)

    def _request(self, points: Sequence[LatLon], days: Sequence[date]) -> dict[str, DayForecast]:
        """Every requested day of every place; a day the answer leaves out is stored empty (No data)."""
        form = {
            "latitude": ",".join(f"{lat:.2f}" for lat, _ in points),
            "longitude": ",".join(f"{lon:.2f}" for _, lon in points),
            "hourly": ",".join(HOURLY_VARIABLES),
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",  # snowfall comes in inches too
            "timezone": "GMT",
            "timeformat": "unixtime",
            "start_date": days[0].isoformat(),
            "end_date": days[-1].isoformat(),
        }
        try:
            response = self._session.post(FORECAST_URL, data=form, timeout=TIMEOUT_S)
        except requests.Timeout as error:
            raise ServiceError("The weather service did not answer in time. Please try again.") from error
        except requests.RequestException as error:
            raise ServiceError("The weather service could not be reached. Please try again.") from error
        if response.status_code == 429:
            raise self._rate_limited(response)
        if response.status_code != 200:
            logger.warning("Open-Meteo failed: HTTP %s %s", response.status_code, response.text[:300])
            raise ServiceError(f"The weather service failed (HTTP {response.status_code}). Please try again.")
        try:
            body = response.json()
            results = body if isinstance(body, list) else [body]
            if len(results) != len(points):
                raise ValueError(f"{len(results)} results for {len(points)} places")
            fetched = {key: day for point, result in zip(points, results) for key, day in _split_days(point, result)}
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            logger.error("Unusable Open-Meteo response: %s", error)
            raise ServiceError("The weather service returned an unusable forecast.") from error
        for point in points:
            for day in days:
                fetched.setdefault(_key(point, day), NO_DAY)
        return fetched

    def _rate_limited(self, response: requests.Response) -> ServiceBusy:
        try:
            body = response.json()
        except ValueError:
            body = None
        reason = str(body.get("reason", "")) if isinstance(body, dict) else ""
        logger.warning("Open-Meteo rate limit: %s", reason)
        now = self._now().astimezone(UTC)
        if reason.startswith("Hourly"):
            wait = 3600 - (now.minute * 60 + now.second) + RESET_MARGIN_S
            return ServiceBusy(
                f"The free weather service's hourly limit was reached. Please try again in {_minutes(wait)}.",
                retry_after_s=wait,
            )
        if reason.startswith("Daily"):
            wait = 86400 - (now.hour * 3600 + now.minute * 60 + now.second) + RESET_MARGIN_S
            return ServiceBusy(
                "The free weather service's daily limit was reached. Please try again after midnight UTC.",
                retry_after_s=wait,
            )
        if "concurrent" in reason.lower():
            return _ShortLimit("The weather service is busy. Please try again in a few seconds.", retry_after_s=5)
        wait = 60 - now.second + RESET_MARGIN_S
        return _ShortLimit(
            f"The free weather service's per-minute limit was reached. Please try again in about {wait} seconds.",
            retry_after_s=wait,
        )


def _minutes(seconds: int) -> str:
    minutes = math.ceil(seconds / 60)
    return "about a minute" if minutes == 1 else f"about {minutes} minutes"


def _batches(points: Sequence[LatLon]) -> list[Sequence[LatLon]]:
    """Batches of at most 1,000 places, the smallest first. Open-Meteo refuses a request only once
    600 places were used in the current minute, so in a fresh minute 1,001 to 1,599 places all get
    through when the small batch goes first."""
    size = MAX_LOCATIONS_PER_REQUEST
    head = len(points) % size
    return ([points[:head]] if head else []) + [points[i : i + size] for i in range(head, len(points), size)]


def _key(point: LatLon, day: date) -> str:
    return f"open-meteo:{point[0]:.2f},{point[1]:.2f}:{day.isoformat()}"


def _split_days(point: LatLon, result: object) -> Iterable[tuple[str, DayForecast]]:
    """One location's response, split into cache entries of one UTC day each."""
    if not isinstance(result, dict):
        raise ValueError("a place's forecast is not an object")
    units = result.get("hourly_units")
    if not isinstance(units, dict):
        raise ValueError("a place's forecast has no units")
    for variable, unit in EXPECTED_UNITS.items():
        if units.get(variable) != unit:
            raise ValueError(f"{variable} in {units.get(variable)!r}, expected {unit!r}")
    hourly = result["hourly"]
    columns = [hourly["time"], *(hourly[name] for name in HOURLY_VARIABLES)]
    by_day: dict[date, list[list]] = {}
    for row in zip(*columns, strict=True):
        day = datetime.fromtimestamp(row[0], tz=UTC).date()
        by_day.setdefault(day, []).append(list(row))
    for day, rows in by_day.items():
        times, wind, gusts, rain, showers, snow = (tuple(column) for column in zip(*rows))
        yield _key(point, day), (times, wind, gusts, rain, showers, snow)


def _series(days: Sequence[DayForecast]) -> ForecastSeries:
    times, wind, gusts, rain, showers, snow = ([value for day in days for value in day[i]] for i in range(6))
    return ForecastSeries.from_hourly(times, wind, gusts, rain, showers, snow)
