"""The whole plan with stand-in TomTom and Open-Meteo clients."""

import math
from datetime import UTC, datetime, timedelta

import pytest

from planner.clients.openmeteo import forecast_horizon
from planner.errors import InvalidInput, NoRoute
from planner.logic.geo import METERS_PER_DEG_LAT, LatLon, haversine_m
from planner.logic.timeutil import end_of_hour, iso_utc, nearest_hour
from planner.logic.weather import HourlyWeather
from planner.services.plan import PlanRequest, plan_trip
from planner.tests.fakes import (
    DALLAS,
    DEPARTURE,
    NOW,
    StubTomTom,
    StubWeather,
    km_east,
    km_north,
    place,
    road,
    three_roads,
    tomtom_route,
)

ROADS = three_roads()
ROUTES = [tomtom_route(points) for points in ROADS]
CALM = HourlyWeather(wind_mph=8.0, gust_mph=15.0, rain_in_hr=0.0, snow_in_hr=0.0)
SEATTLE, MIAMI = (47.6062, -122.3321), (25.7617, -80.1918)
COAST_TO_COAST = tomtom_route(road(SEATTLE, MIAMI, step_km=5.0), speed_mps=20.0)  # about 61 hours
COASTS = {"Seattle, WA": place("Seattle, WA", SEATTLE), "Miami, FL": place("Miami, FL", MIAMI)}


def request(load_lb: float = 20_000, interval_miles: int = 25, **overrides) -> PlanRequest:
    values = {"origin": "Dallas, TX", "destination": "Denver, CO", "departure": DEPARTURE}
    values.update(overrides)
    return PlanRequest(load_lb=load_lb, interval_miles=interval_miles, **values)


def plan(weather=None, tomtom=None, **request_args):
    return plan_trip(request(**request_args), tomtom or StubTomTom(ROUTES), weather or StubWeather(), now=NOW)


def distance_to_line_m(point: LatLon, line: list[LatLon]) -> float:
    kx = METERS_PER_DEG_LAT * math.cos(math.radians(point[0]))
    px, py = point[1] * kx, point[0] * METERS_PER_DEG_LAT
    best = math.inf
    for a, b in zip(line, line[1:]):
        ax, ay, bx, by = a[1] * kx, a[0] * METERS_PER_DEG_LAT, b[1] * kx, b[0] * METERS_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy
        t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
        best = min(best, math.hypot(px - ax - t * dx, py - ay - t * dy))
    return best


def test_a_plan_has_three_ranked_routes_with_checkpoints_and_a_49_hour_heatmap():
    result = plan()
    assert (result["origin"]["name"], result["destination"]["name"]) == ("Dallas, TX", "Denver, CO")
    assert result["origin"]["country_code"] == result["destination"]["country_code"] == "US"
    assert result["departure"] == "2026-10-25T14:20:00Z"
    assert [r["id"] for r in result["routes"]] == ["A", "B", "C"]
    assert sorted(r["rank"] for r in result["routes"]) == [1, 2, 3]
    recommended = [r for r in result["routes"] if r["recommended"]]
    assert len(recommended) == 1 and recommended[0]["rank"] == 1
    assert recommended[0]["id"] == result["recommendation"]["route_id"]
    for route in result["routes"]:
        checkpoints = route["checkpoints"]
        assert checkpoints[0]["mile"] == 0.0 and checkpoints[0]["eta"] == "2026-10-25T14:20:00Z"
        assert checkpoints[-1]["mile"] == route["distance_miles"]
        assert sum(c["covered_miles"] for c in checkpoints) == pytest.approx(route["distance_miles"], abs=0.1)
        assert route["geometry"][0] == [round(DALLAS[1], 5), round(DALLAS[0], 5)]  # [lon, lat]
    heatmap = result["heatmap"]
    assert len(heatmap["hours"]) == 49 and heatmap["hours"][0] == "2026-10-25T14:00:00Z"
    assert len(heatmap["levels"]) == 49
    assert all(len(frame) == len(heatmap["cells"]) for frame in heatmap["levels"])
    assert all(len(cell) == 4 for cell in heatmap["cells"])
    assert result["warnings"] == [] and result["recommendation"]["warnings"] == []


def test_checkpoints_take_the_wind_from_the_forecast_hour_nearest_their_eta():
    storm_from = DEPARTURE.replace(minute=0) + timedelta(hours=5)
    weather = StubWeather(lambda point, hour: HourlyWeather(60.0, 70.0, 0.0, 0.0) if hour >= storm_from else CALM)
    for route in plan(weather)["routes"]:
        for checkpoint in route["checkpoints"]:
            hour = nearest_hour(datetime.fromisoformat(checkpoint["eta"]))
            assert checkpoint["forecast_time"] == iso_utc(hour)
            assert checkpoint["wind_level"] == (4 if hour >= storm_from else 0)


def test_checkpoints_take_rain_and_snow_from_the_hour_their_eta_falls_in():
    # Open-Meteo stamps an hour's rain at its end, so an ETA of 14:20 (or 14:00) takes the rain stamped 15:00.
    weather = StubWeather(lambda point, hour: HourlyWeather(8.0, 15.0, 1.5 if hour.hour % 2 else 0.0, 0.0))
    checkpoints = [c for route in plan(weather)["routes"] for c in route["checkpoints"]]
    etas = [datetime.fromisoformat(c["eta"]) for c in checkpoints]
    assert any(nearest_hour(eta) != end_of_hour(eta) for eta in etas)  # the two rules disagree somewhere
    for checkpoint, eta in zip(checkpoints, etas):
        assert checkpoint["totals_time"] == iso_utc(end_of_hour(eta))
        assert checkpoint["rain_in_hr"] == (1.5 if end_of_hour(eta).hour % 2 else 0.0)
        assert checkpoint["level"] == (4 if end_of_hour(eta).hour % 2 else 0)


def test_the_load_rules_apply_to_checkpoints_and_the_heatmap():
    windy = StubWeather(lambda point, hour: HourlyWeather(47.0, 60.0, 0.0, 0.0))  # Severe wind
    light, heavy = plan(windy, load_lb=30_000), plan(windy, load_lb=30_001)
    light_levels = {c["level"] for r in light["routes"] for c in r["checkpoints"]}
    heavy_checkpoints = [c for r in heavy["routes"] for c in r["checkpoints"]]
    assert light_levels == {3}
    assert {c["level"] for c in heavy_checkpoints} == {4} and all(c["load_rule_applied"] for c in heavy_checkpoints)
    assert {v for frame in light["heatmap"]["levels"] for v in frame} == {3}
    assert {v for frame in heavy["heatmap"]["levels"] for v in frame} == {4}
    assert all(r["summary"]["unsafe"] for r in heavy["routes"])
    assert heavy["recommendation"]["warnings"][0].startswith("Every route has No Travel conditions.")


def test_the_route_without_severe_weather_is_recommended():
    middle = ROADS[0][len(ROADS[0]) // 2]
    storm = HourlyWeather(50.0, 65.0, 0.0, 0.0)  # Severe at a 20,000 lb load
    weather = StubWeather(lambda point, hour: storm if haversine_m(point, middle) < 40_000 else CALM)
    result = plan(weather)
    by_id = {r["id"]: r for r in result["routes"]}
    assert by_id["A"]["summary"]["miles_by_level"]["severe"] > 0
    assert by_id["A"]["rank"] == 3
    assert result["recommendation"]["route_id"] in ("B", "C")


def test_one_weather_request_covers_every_checkpoint_and_heatmap_cell_for_48_hours():
    weather = StubWeather()
    result = plan(weather)
    assert len(weather.requests) == 1
    points, start, end = weather.requests[0]
    checkpoint_points = {(round(c["lat"], 2), round(c["lon"], 2)) for r in result["routes"] for c in r["checkpoints"]}
    assert len(points) >= len(checkpoint_points)
    assert start == nearest_hour(DEPARTURE)
    assert end >= nearest_hour(DEPARTURE) + timedelta(hours=49)  # the last slider hour's rain is stamped an hour later


def test_a_trip_longer_than_48_hours_has_forecasts_up_to_its_last_checkpoint():
    weather = StubWeather()
    tomtom = StubTomTom([COAST_TO_COAST], places=COASTS)
    result = plan(weather, tomtom=tomtom, origin="Seattle, WA", destination="Miami, FL")
    checkpoints = result["routes"][0]["checkpoints"]
    last_eta = datetime.fromisoformat(checkpoints[-1]["eta"])
    assert last_eta > DEPARTURE + timedelta(hours=58)
    assert weather.requests[0][2] >= end_of_hour(last_eta)  # the last checkpoint's rain is stamped then
    assert all(c["level"] is not None and c["wind_mph"] is not None for c in checkpoints)
    assert result["routes"][0]["summary"]["miles_by_level"]["no_data"] == 0


def test_arrival_is_the_departure_plus_the_travel_time():
    for route, source in zip(plan()["routes"], ROUTES, strict=True):
        expected = iso_utc(DEPARTURE + timedelta(seconds=source.travel_time_s))
        assert route["arrival"] == route["checkpoints"][-1]["eta"] == expected


def test_route_lines_are_simplified_to_within_15_m():
    # A road east from Dallas, a point every 100 m, swaying 25 m to either side every 2 km.
    straight = road(DALLAS, km_east(DALLAS, 50), step_km=0.1)
    swaying = [km_north(p, 0.025 * math.sin(i * math.pi / 10)) for i, p in enumerate(straight)]
    places = {"Dallas, TX": place("Dallas, TX", DALLAS), "Denver, CO": place("East of Dallas", swaying[-1])}
    tomtom = StubTomTom([tomtom_route(swaying)], places=places)
    geometry = [(lat, lon) for lon, lat in plan(tomtom=tomtom)["routes"][0]["geometry"]]
    assert len(geometry) < len(swaying) / 2
    # 15 m, plus up to about 0.7 m from rounding the coordinates to 5 decimals
    assert max(distance_to_line_m(p, geometry) for p in swaying) < 16.0


def test_a_default_plan_stays_within_300_weather_locations():
    weather = StubWeather()
    plan(weather)
    assert len(weather.requests[0][0]) <= 300


def test_the_10_mile_interval_keeps_the_same_heatmap():
    default, fine = plan(), plan(interval_miles=10)
    assert fine["heatmap"]["cells"] == default["heatmap"]["cells"]
    assert len(fine["routes"][0]["checkpoints"]) > len(default["routes"][0]["checkpoints"])


def test_hours_past_the_forecast_horizon_are_no_data_with_a_warning():
    now = DEPARTURE - timedelta(days=15)  # the forecast ends Oct 25, 23:00 UTC, part way through the trip
    horizon = forecast_horizon(now)
    weather = StubWeather(lambda point, hour: CALM if hour <= horizon else None)
    result = plan_trip(request(), StubTomTom(ROUTES), weather, now=now)
    assert result["warnings"] == ["Forecasts end on Oct 25 at 23:00 UTC; from then on the map shows No data."]
    assert result["heatmap"]["levels"][-1][0] is None
    checkpoints = [c for r in result["routes"] for c in r["checkpoints"]]
    late = [c for c in checkpoints if datetime.fromisoformat(c["totals_time"]) > horizon]
    assert late and all(c["level"] is None and c["rain_in_hr"] is None for c in late)
    # Just past the last forecast hour the wind is still forecast, but the rain isn't, so the risk is unknown.
    assert any(c["wind_mph"] is not None for c in late)
    assert all(c["wind_mph"] is None for c in late if datetime.fromisoformat(c["forecast_time"]) > horizon)
    assert all(c["level"] == 0 for c in checkpoints if c not in late)


def test_a_trip_that_outlasts_the_forecast_warns_even_when_the_slider_does_not():
    horizon = forecast_horizon(NOW)  # November 8, 23:00 UTC
    departure = datetime(2026, 11, 6, 12, tzinfo=UTC)  # the slider ends on November 8 at noon
    weather = StubWeather(lambda point, hour: CALM if hour <= horizon else None)
    result = plan_trip(
        request(origin="Seattle, WA", destination="Miami, FL", departure=departure),
        StubTomTom([COAST_TO_COAST], places=COASTS),
        weather,
        now=NOW,
    )
    assert datetime.fromisoformat(result["heatmap"]["hours"][-1]) < horizon
    assert "Forecasts end on Nov 8 at 23:00 UTC; from then on the map shows No data." in result["warnings"]
    assert weather.requests[0][2] == horizon  # nothing past the horizon is asked for
    assert result["routes"][0]["checkpoints"][-1]["level"] is None


def test_the_same_place_twice_is_refused():
    tomtom = StubTomTom(ROUTES, places={"Dallas": place("Dallas, TX", DALLAS), "Dallas TX": place("Dallas, TX", DALLAS)})
    with pytest.raises(InvalidInput) as error:
        plan(tomtom=tomtom, origin="Dallas", destination="Dallas TX")
    assert set(error.value.fields) == {"destination"}


def test_every_unknown_place_is_reported():
    with pytest.raises(InvalidInput) as error:
        plan(origin="Nowhere One", destination="Nowhere Two")
    assert set(error.value.fields) == {"origin", "destination"}


@pytest.mark.parametrize(
    ("code", "message", "expected"),
    [
        ("NO_ROUTE_FOUND", "No route found", "No truck route was found between Dallas, TX and Denver, CO."),
        ("MAP_MATCHING_FAILURE", "MAP_MATCHING_FAILURE: Destination (1, 2)", "Denver, CO is not near a road"),
        ("MAP_MATCHING_FAILURE", "MAP_MATCHING_FAILURE: Origin (1, 2)", "Dallas, TX is not near a road"),
    ],
)
def test_no_route_errors_name_the_places(code, message, expected):
    with pytest.raises(NoRoute) as error:
        plan(tomtom=StubTomTom(ROUTES, main_error=NoRoute(message, code=code)))
    assert error.value.message.startswith(expected)
