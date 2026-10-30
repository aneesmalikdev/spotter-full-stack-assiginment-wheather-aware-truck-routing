"""Synthetic routes, forecasts and TomTom / Open-Meteo responses for tests.

Everything here is generated; no real TomTom results are stored (TomTom's terms forbid it).
"""

import json
import math
import threading
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs

import responses

from planner.clients.openmeteo import FORECAST_URL
from planner.clients.tomtom import Place, TomTomRoute
from planner.errors import InvalidInput, PlanError, ServiceTimeout
from planner.logic.geo import METERS_PER_DEG_LAT, LatLon, cumulative_distances_m, haversine_m
from planner.logic.sampling import ProgressPoint, RouteTrack
from planner.logic.weather import ForecastSeries, HourlyWeather

SPEED_MPS = 25.0  # about 56 mph
DALLAS = (32.7780, -96.7962)
DENVER = (39.7385, -104.9849)
DEPARTURE = datetime(2026, 10, 25, 14, 20, tzinfo=UTC)
NOW = datetime(2026, 10, 24, 18, 0, tzinfo=UTC)


def km_east(start: LatLon, km: float) -> LatLon:
    return (start[0], start[1] + km * 1000 / (METERS_PER_DEG_LAT * math.cos(math.radians(start[0]))))


def km_north(start: LatLon, km: float) -> LatLon:
    return (start[0] + km * 1000 / METERS_PER_DEG_LAT, start[1])


def road(*waypoints: LatLon, step_km: float = 1.0) -> list[LatLon]:
    """Straight legs through the waypoints, with a point every `step_km`."""
    points = [waypoints[0]]
    for a, b in zip(waypoints, waypoints[1:]):
        steps = max(1, round(haversine_m(a, b) / (step_km * 1000)))
        points += [(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(1, steps + 1)]
    return points


def three_roads(start: LatLon = DALLAS, end: LatLon = DENVER, bow_km: float = 100.0) -> list[list[LatLon]]:
    """A direct road and two roads bowing `bow_km` to either side of it at the middle."""
    middle = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
    east = (end[1] - start[1]) * math.cos(math.radians(middle[0]))
    north = end[0] - start[0]
    length = math.hypot(east, north)
    side_east, side_north = north / length, -east / length  # perpendicular to the direction of travel
    return [
        road(start, end),
        road(start, km_north(km_east(middle, bow_km * side_east), bow_km * side_north), end),
        road(start, km_north(km_east(middle, -bow_km * side_east), -bow_km * side_north), end),
    ]


def tomtom_route(points: Sequence[LatLon], speed_mps: float = SPEED_MPS, progress_every: int = 10) -> TomTomRoute:
    cumulative = cumulative_distances_m(points)
    indices = sorted(set(range(0, len(points), progress_every)) | {len(points) - 1})
    progress = [ProgressPoint(i, cumulative[i], cumulative[i] / speed_mps) for i in indices]
    return TomTomRoute(RouteTrack(points, progress), cumulative[-1], cumulative[-1] / speed_mps)


def route_json(points: Sequence[LatLon], speed_mps: float = SPEED_MPS, progress_every: int = 10) -> dict:
    """One entry of a TomTom Calculate Route response's "routes". It has two legs that share their
    junction point, as around a waypoint; progress indexes count the points of the joined legs."""
    split = len(points) // 2
    legs = [list(points[: split + 1]), list(points[split:])]
    route = tomtom_route(legs[0] + legs[1], speed_mps, progress_every)
    return {
        "summary": {"lengthInMeters": round(route.length_m), "travelTimeInSeconds": round(route.travel_time_s)},
        "legs": [{"points": [{"latitude": lat, "longitude": lon} for lat, lon in leg]} for leg in legs],
        "sections": [],
        "progress": [
            {"pointIndex": e.point_index, "distanceInMeters": e.distance_m, "travelTimeInSeconds": e.time_s}
            for e in route.track.progress
        ],
    }


def geocode_json(name: str, position: LatLon, country: str = "US", country_name: str = "United States") -> dict:
    return {
        "summary": {"numResults": 1},
        "results": [
            {
                "type": "Geography",
                "position": {"lat": position[0], "lon": position[1]},
                "address": {"freeformAddress": name, "countryCode": country, "country": country_name},
            }
        ],
    }


def search_json(*places: str | tuple[str, ...]) -> dict:
    """A Search API answer listing cities: a US name ("Denver, CO") or (name, country code, country),
    plus optionally the state or province in full: ("Toronto ON", "CA", "Canada", "Ontario")."""
    results = []
    for place in places:
        name, code, country, *full = (place, "US", "United States") if isinstance(place, str) else place
        address = {"freeformAddress": name, "countryCode": code, "country": country}
        if full:  # TomTom gives the code and, for the US and Canada, the full name
            address["countrySubdivision"] = name.replace(",", " ").split()[-1]
            address["countrySubdivisionName"] = full[0]
        results.append({"type": "Geography", "entityType": "Municipality", "position": {"lat": 0.0, "lon": 0.0}, "address": address})
    return {"summary": {"numResults": len(results)}, "results": results}


def open_meteo_json(times: Sequence[int], weather: Callable[[int], tuple] | None = None) -> dict:
    """One location of an Open-Meteo response; `weather(t)` gives (wind, gust, rain, showers, snow)."""
    rows = [weather(t) if weather else (8.0, 15.0, 0.0, 0.0, 0.0) for t in times]
    columns = list(zip(*rows)) if rows else [(), (), (), (), ()]
    return {
        "latitude": 0.0,
        "longitude": 0.0,
        "hourly_units": {
            "time": "unixtime",
            "wind_speed_10m": "mp/h",
            "wind_gusts_10m": "mp/h",
            "rain": "inch",
            "showers": "inch",
            "snowfall": "inch",
        },
        "hourly": {
            "time": list(times),
            "wind_speed_10m": list(columns[0]),
            "wind_gusts_10m": list(columns[1]),
            "rain": list(columns[2]),
            "showers": list(columns[3]),
            "snowfall": list(columns[4]),
        },
    }


def answer_open_meteo(weather: Callable[[int], tuple] | None = None, minute_limit: int | None = None) -> None:
    """Makes `responses` answer every Open-Meteo request with one forecast per requested place for
    every hour of the requested days. With `minute_limit`, it limits like Open-Meteo within one
    minute: a request is refused once that many places were used, otherwise it is served in full."""
    used = 0

    def callback(request):
        nonlocal used
        form = {key: values[0] for key, values in parse_qs(request.body).items()}
        latitudes = form["latitude"].split(",")
        if minute_limit is not None:
            if used >= minute_limit:
                return 429, {}, json.dumps({"error": True, "reason": "Minutely API request limit exceeded."})
            used += len(latitudes)
        first, last = date.fromisoformat(form["start_date"]), date.fromisoformat(form["end_date"])
        start = datetime(first.year, first.month, first.day, tzinfo=UTC)
        times = [int((start + timedelta(hours=h)).timestamp()) for h in range(24 * ((last - first).days + 1))]
        places = [open_meteo_json(times, weather) for _ in latitudes]
        return 200, {}, json.dumps(places[0] if len(places) == 1 else places)

    responses.add_callback(responses.POST, FORECAST_URL, callback=callback)


def place(name: str, position: LatLon, country: str = "US") -> Place:
    return Place(query=name, name=name, position=position, country_code=country)


class FakeClock:
    """A monotonic clock that only moves when told to."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


class StubTomTom:
    """Answers like TomTomClient. Main requests return `routes`; via requests (with a circle)
    are answered by `via(locations)`, which returns a route or raises."""

    def __init__(
        self,
        routes: Sequence[TomTomRoute],
        places: dict[str, Place] | None = None,
        via: Callable[[Sequence[str]], TomTomRoute] | None = None,
        clock: FakeClock | None = None,
        seconds_per_call: float = 0.0,
        main_error: PlanError | None = None,
    ) -> None:
        self.routes = list(routes)
        self.places = places or {"Dallas, TX": place("Dallas, TX", DALLAS), "Denver, CO": place("Denver, CO", DENVER)}
        self.via = via
        self.clock = clock
        self.seconds_per_call = seconds_per_call
        self.main_error = main_error
        self.calls: list[dict] = []
        self._clock_lock = threading.Lock()  # via requests arrive from several threads at once

    def geocode(self, query: str, field: str) -> Place:
        if query not in self.places:
            message = f'Couldn\'t find "{query}" in the US, Canada or Mexico. Try adding a state or province.'
            raise InvalidInput(message, fields={field: message})
        return self.places[query]

    def calculate_route(self, locations, departure, max_alternatives, timeout_s, avoid=()):
        self.calls.append(
            {"locations": list(locations), "max_alternatives": max_alternatives, "avoid": list(avoid), "timeout_s": timeout_s}
        )
        if self.clock is not None:
            with self._clock_lock:
                self.clock.now += self.seconds_per_call
        if any(loc.startswith("circle(") for loc in locations):
            if self.via is None:
                raise PlanError("no via routes in this test")
            return [self.via(locations)]
        if self.main_error is not None:
            error, self.main_error = self.main_error, None  # fail once
            if isinstance(error, ServiceTimeout) and self.clock is not None:
                self.clock.now += timeout_s  # a timeout means the whole timeout went by
            raise error
        return self.routes[: max_alternatives + 1]


class StubWeather:
    """Answers like OpenMeteoClient, with `weather(point, hour)` for every hour asked for."""

    def __init__(self, weather: Callable[[LatLon, datetime], HourlyWeather | None] | None = None) -> None:
        self.weather = weather or (lambda _point, _hour: HourlyWeather(8.0, 15.0, 0.0, 0.0))
        self.requests: list[tuple[list[LatLon], datetime, datetime]] = []

    def forecasts(self, points, start, end):
        points = list(dict.fromkeys(points))
        self.requests.append((points, start, end))
        hours = []
        hour = start.replace(minute=0, second=0, microsecond=0)
        while hour <= end:
            hours.append(hour)
            hour += timedelta(hours=1)
        result = {}
        for point in points:
            values = {}
            for hour in hours:
                weather = self.weather(point, hour)
                if weather is not None:
                    values[int(hour.timestamp())] = weather
            result[point] = ForecastSeries(values)
        return result
