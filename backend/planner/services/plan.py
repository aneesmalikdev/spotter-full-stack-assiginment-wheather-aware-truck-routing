"""A trip plan: geocode both ends, find up to three routes, place checkpoints, fetch forecasts, score
the risk at each checkpoint's ETA, rank the routes and build the 49-hour heatmap."""

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from planner.clients.openmeteo import ForecastService, forecast_horizon
from planner.clients.tomtom import Place, RoutingService
from planner.errors import InvalidInput, NoRoute
from planner.logic.geo import METERS_PER_MILE, LatLon, haversine_m, simplify
from planner.logic.heatmap import choose_grid, frame_hours, frame_levels, heat_cell_budget
from planner.logic.ranking import RiskSummary, RouteScore, rank_routes, recommend, summarize
from planner.logic.risk import RiskAssessment, RiskLevel, assess
from planner.logic.sampling import Checkpoint, build_checkpoints
from planner.logic.timeutil import end_of_hour, iso_utc
from planner.logic.weather import ForecastSeries, HourlyWeather, forecast_point
from planner.services.route_search import RouteOption, find_routes

MIN_TRIP_M = 1_000.0
BUDGET_INTERVAL_MILES = 25  # the heatmap is sized against the default interval's checkpoints
GEOMETRY_TOLERANCE_M = 15.0  # route lines sent to the map are simplified to within 15 m


@dataclass(frozen=True)
class PlanRequest:
    origin: str
    destination: str
    departure: datetime  # time-zone aware
    load_lb: float
    interval_miles: int


def plan_trip(
    request: PlanRequest,
    tomtom: RoutingService,
    weather: ForecastService,
    started: float | None = None,
    now: datetime | None = None,
) -> dict:
    """The full plan as a JSON-ready dict (see README "API")."""
    started = time.monotonic() if started is None else started
    now = datetime.now(UTC) if now is None else now
    origin, destination = _geocode(tomtom, request)
    if haversine_m(origin.position, destination.position) < MIN_TRIP_M:
        message = "The origin and destination are the same place."
        raise InvalidInput(message, fields={"destination": message})
    try:
        search = find_routes(tomtom, origin, destination, request.departure, started)
    except NoRoute as error:
        raise NoRoute(_no_route_message(error, origin, destination), error.code) from error
    options = search.options
    warnings = list(search.warnings)

    checkpoints = [build_checkpoints(o.route.track, request.departure, request.interval_miles) for o in options]
    budget_checkpoints = (
        checkpoints
        if request.interval_miles == BUDGET_INTERVAL_MILES
        else [build_checkpoints(o.route.track, request.departure, BUDGET_INTERVAL_MILES) for o in options]
    )
    budget_points = {forecast_point(c.position) for route in budget_checkpoints for c in route}
    grid = choose_grid([o.route.points for o in options], heat_cell_budget(len(budget_points)))

    hours = frame_hours(request.departure)
    # The rain and snow of the last slider hour, and of each route's last checkpoint, are stamped an hour later.
    last_hour = max([end_of_hour(hours[-1]), *(end_of_hour(route[-1].eta) for route in checkpoints)])
    checkpoint_points = [[forecast_point(c.position) for c in route] for route in checkpoints]
    cell_points = [forecast_point(grid.point(i)) for i in range(len(grid.cells))]
    all_points = [p for route in checkpoint_points for p in route] + cell_points
    horizon = forecast_horizon(now)  # also cuts the request, so the warning matches what was fetched
    forecasts = weather.forecasts(all_points, hours[0], min(last_hour, horizon))
    if last_hour > horizon:
        warnings.append(f"Forecasts end on {horizon:%b} {horizon.day} at {horizon:%H:%M} UTC; from then on the map shows No data.")

    routes_json, scores = [], []
    for option, route_checkpoints, points in zip(options, checkpoints, checkpoint_points):
        assessed = [_assess(c, forecasts[p], request.load_lb) for c, p in zip(route_checkpoints, points)]
        summary = summarize([risk.level for *_, risk in assessed], [c.coverage_m for c in route_checkpoints])
        scores.append(RouteScore(option.route_id, summary, option.route.travel_time_s))
        routes_json.append(_route_json(option, request.departure, route_checkpoints, assessed, summary))
    rank = {score.route_id: position for position, score in enumerate(rank_routes(scores), start=1)}
    recommendation = recommend(scores)
    for route in routes_json:
        route["rank"] = rank[route["id"]]
        route["recommended"] = route["id"] == recommendation.route_id

    return {
        "origin": _place_json(origin),
        "destination": _place_json(destination),
        "departure": iso_utc(request.departure),
        "load_lb": request.load_lb,
        "interval_miles": request.interval_miles,
        "routes": routes_json,
        "recommendation": {"route_id": recommendation.route_id, "warnings": list(recommendation.warnings)},
        "warnings": warnings,
        "heatmap": {
            "cell_deg": grid.cell_deg,
            "band_miles": grid.band_miles,
            "cells": [list(grid.bounds(i)) for i in range(len(grid.cells))],  # west, south, east, north
            "hours": [iso_utc(hour) for hour in hours],  # forecast hour shown at slider position h
            "levels": frame_levels([forecasts[p] for p in cell_points], hours, request.load_lb),  # [hour][cell]
        },
    }


def _geocode(client: RoutingService, request: PlanRequest) -> tuple[Place, Place]:
    """Both ends at once; reports every place that can't be found, not just the first."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            "origin": pool.submit(client.geocode, request.origin, "origin"),
            "destination": pool.submit(client.geocode, request.destination, "destination"),
        }
        places, problems = {}, {}
        for field, future in futures.items():
            try:
                places[field] = future.result()
            except InvalidInput as error:
                problems.update(error.fields)
    if problems:
        raise InvalidInput(" ".join(problems.values()), fields=problems)
    return places["origin"], places["destination"]


def _no_route_message(error: NoRoute, origin: Place, destination: Place) -> str:
    if error.code == "MAP_MATCHING_FAILURE":
        place = destination if "Destination" in error.message else origin
        return f"{place.name} is not near a road a truck can use. Try a nearby town or address."
    return (
        f"No truck route was found between {origin.name} and {destination.name}. "
        "Check that these are the places you meant."
    )


Assessed = tuple[datetime, datetime, HourlyWeather, RiskAssessment]  # wind hour, totals hour, weather, risk


def _assess(checkpoint: Checkpoint, series: ForecastSeries, load_lb: float) -> Assessed:
    """The weather at the checkpoint's ETA (ForecastSeries.at_eta), its two forecast hours, and the risk."""
    wind_hour, totals_hour, weather = series.at_eta(checkpoint.eta)
    return wind_hour, totals_hour, weather, assess(weather.wind_mph, weather.rain_in_hr, weather.snow_in_hr, load_lb)


def _level(level: RiskLevel | None) -> int | None:
    return None if level is None else int(level)


def _route_json(
    option: RouteOption,
    departure: datetime,
    checkpoints: list[Checkpoint],
    assessed: list[Assessed],
    summary: RiskSummary,
) -> dict:
    route = option.route
    return {
        "id": option.route_id,
        "source": option.source,
        "distance_miles": round(route.length_m / METERS_PER_MILE, 1),
        "travel_time_s": round(route.travel_time_s),
        "arrival": iso_utc(departure + timedelta(seconds=route.travel_time_s)),
        "geometry": [_lon_lat(p) for p in simplify(route.points, GEOMETRY_TOLERANCE_M)],
        "checkpoints": [
            {
                "mile": round(c.distance_m / METERS_PER_MILE, 1),
                "lat": round(c.position[0], 5),
                "lon": round(c.position[1], 5),
                "eta": iso_utc(c.eta),
                "forecast_time": iso_utc(wind_hour),  # sustained wind, at the hour nearest the ETA
                "totals_time": iso_utc(totals_hour),  # rain, snow and gusts of the hour ending then
                "wind_mph": weather.wind_mph,
                "gust_mph": weather.gust_mph,
                "rain_in_hr": weather.rain_in_hr,
                "snow_in_hr": weather.snow_in_hr,
                "wind_level": _level(risk.wind),
                "rain_level": _level(risk.rain),
                "snow_level": _level(risk.snow),
                "load_rule_applied": risk.load_rule_applied,
                "level": _level(risk.level),
                "covered_miles": round(c.coverage_m / METERS_PER_MILE, 2),
            }
            for c, (wind_hour, totals_hour, weather, risk) in zip(checkpoints, assessed)
        ],
        "summary": {
            "miles_by_level": {
                "low": summary.low_mi,
                "moderate": summary.moderate_mi,
                "high": summary.high_mi,
                "severe": summary.severe_mi,
                "no_travel": summary.no_travel_mi,
                "no_data": summary.no_data_mi,
            },
            "average_risk": summary.average_risk,
            "unsafe": summary.unsafe,
        },
    }


def _lon_lat(point: LatLon) -> list[float]:
    return [round(point[1], 5), round(point[0], 5)]


def _place_json(place: Place) -> dict:
    return {
        "query": place.query,
        "name": place.name,
        "country_code": place.country_code,
        "lat": place.position[0],
        "lon": place.position[1],
    }
