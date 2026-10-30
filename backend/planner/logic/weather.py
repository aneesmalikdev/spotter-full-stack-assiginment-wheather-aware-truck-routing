"""Hourly forecasts for one place, looked up by UTC hour.

Open-Meteo stamps each hour H with: the sustained wind at H, the strongest gust in the hour
before H, and the rain, showers and snowfall that fell in the hour before H. Those hourly
amounts are the rates the risk rules use (inches in one hour = in/hr).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from .geo import LatLon
from .risk import combine_rain
from .timeutil import end_of_hour, nearest_hour, require_aware

FORECAST_GRID_DEG = 0.02  # about 2 km; nearby checkpoints share one forecast


@dataclass(frozen=True)
class HourlyWeather:
    wind_mph: float | None
    gust_mph: float | None  # for information only; the risk rules use sustained wind
    rain_in_hr: float | None  # rain plus showers
    snow_in_hr: float | None


class ForecastSeries:
    """One place's hourly forecast, keyed by the hour's Unix time in seconds."""

    def __init__(self, hours: dict[int, HourlyWeather]) -> None:
        self._hours = hours

    @classmethod
    def from_hourly(
        cls,
        times: Sequence[int],
        wind_mph: Sequence[float | None],
        gust_mph: Sequence[float | None],
        rain_in: Sequence[float | None],
        showers_in: Sequence[float | None],
        snow_in: Sequence[float | None],
    ) -> "ForecastSeries":
        hours = {
            int(t): HourlyWeather(wind_mph=w, gust_mph=g, rain_in_hr=combine_rain(r, s), snow_in_hr=sn)
            for t, w, g, r, s, sn in zip(times, wind_mph, gust_mph, rain_in, showers_in, snow_in, strict=True)
        }
        return cls(hours)

    def at(self, hour: datetime) -> HourlyWeather | None:
        """The forecast for this exact UTC hour, or None if the forecast does not cover it."""
        return self._hours.get(int(require_aware(hour).timestamp()))

    def at_eta(self, eta: datetime) -> tuple[datetime, datetime, HourlyWeather]:
        """The weather a truck meets at `eta`, and the two forecast hours it comes from: sustained wind
        at the hour nearest `eta`, and the rain, snow and strongest gust of the hour `eta` falls in
        (from :00 up to the next :00), which are stamped at that hour's end. Anything the forecast
        doesn't cover is None."""
        wind_hour, totals_hour = nearest_hour(eta), end_of_hour(eta)
        wind, totals = self.at(wind_hour), self.at(totals_hour)
        weather = HourlyWeather(
            wind_mph=wind.wind_mph if wind else None,
            gust_mph=totals.gust_mph if totals else None,
            rain_in_hr=totals.rain_in_hr if totals else None,
            snow_in_hr=totals.snow_in_hr if totals else None,
        )
        return wind_hour, totals_hour, weather


def forecast_point(point: LatLon) -> LatLon:
    """Snap a location to the forecast grid. Nearby checkpoints then share a forecast and a cache entry."""

    def snap(value: float) -> float:
        return round(round(value / FORECAST_GRID_DEG) * FORECAST_GRID_DEG, 2) + 0.0  # + 0.0 turns -0.0 into 0.0

    return (snap(point[0]), snap(point[1]))
