"""Heatmap grid around the routes, its weather-location budget, and the 49 hourly frames."""

import math
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from planner.logic.geo import (
    METERS_PER_DEG_LAT,
    METERS_PER_MILE,
    approx_distance_m,
    cumulative_distances_m,
    interpolate,
    resample,
)
from planner.logic.heatmap import (
    GRID_LADDER,
    MIN_HEAT_CELL_BUDGET,
    SAMPLE_SPACING_M,
    WEATHER_LOCATION_TARGET,
    HeatGrid,
    cells_near,
    choose_grid,
    frame_hours,
    frame_levels,
    heat_cell_budget,
)
from planner.logic.risk import assess
from planner.logic.sampling import checkpoint_distances_m
from planner.logic.weather import ForecastSeries, forecast_point

MI = METERS_PER_MILE


def east_west_route(miles_long: float, lat: float = 36.0, wiggle_mi: float = 0.0) -> list[tuple[float, float]]:
    deg = miles_long * MI / (METERS_PER_DEG_LAT * math.cos(math.radians(lat)))
    wiggle_deg = wiggle_mi * MI / METERS_PER_DEG_LAT
    return [(lat + wiggle_deg * math.sin(i / 20), -100.0 + deg * i / 400) for i in range(401)]


def samples(line):
    return resample(line, SAMPLE_SPACING_M)


def test_budget_keeps_a_default_plan_near_300_weather_locations():
    assert WEATHER_LOCATION_TARGET == 300
    assert heat_cell_budget(110) == 190
    assert heat_cell_budget(299) == MIN_HEAT_CELL_BUDGET  # the heatmap may always use this many
    assert heat_cell_budget(1000) == MIN_HEAT_CELL_BUDGET


def test_ladder_goes_from_fine_to_coarse():
    sizes = [size for size, _ in GRID_LADDER]
    assert sizes == sorted(sizes)
    assert GRID_LADDER[0] == (0.25, 30.0)
    assert GRID_LADDER[-1][1] == 0  # last resort: only the cells the routes pass through


def test_cells_near_includes_every_cell_a_route_passes_through():
    cells = cells_near([[(36.05, -99.95), (36.95, -98.05)]], cell_deg=0.5, band_m=0.0)
    assert cells is not None
    assert {(72, -200), (73, -197)} <= cells


def test_a_route_that_cuts_a_cells_corner_keeps_that_cell():
    # Between two 2-mile samples the route clips the corner of cell (36, -101).
    line = [(35.965, -100.06), (36.025, -99.96)]
    assert cells_near([samples(line)], cell_deg=1.0, band_m=0.0) == {(35, -101), (36, -101), (36, -100)}


@pytest.mark.parametrize("sample", [(36.0, -100.0), (36.13, -99.91), (47.2, -122.3), (-33.9, 151.2)])
def test_cells_near_keeps_exactly_the_cells_whose_centre_is_within_the_band(sample):
    size, band = 0.25, 30 * MI
    cells = cells_near([[sample]], cell_deg=size, band_m=band)
    assert cells is not None
    home = (math.floor(sample[0] / size), math.floor(sample[1] / size))
    for row in range(home[0] - 6, home[0] + 7):
        for col in range(home[1] - 9, home[1] + 10):
            centre = ((row + 0.5) * size, (col + 0.5) * size)
            expected = (row, col) == home or approx_distance_m(sample, centre) <= band
            assert ((row, col) in cells) == expected


def test_cells_near_gives_up_when_over_the_limit():
    line = [(36.0, -100.0 + i * 0.01) for i in range(500)]
    assert cells_near([line], cell_deg=0.25, band_m=30 * MI, limit=10) is None


@pytest.mark.parametrize("budget", [10_000, 400, 200, 120, 60, 30, 12, 5])
def test_choose_grid_picks_the_finest_grid_that_fits_the_budget(budget):
    lines = [east_west_route(600, wiggle_mi=10)]
    grid = choose_grid(lines, budget)
    counts = [
        len(cells_near([samples(line) for line in lines], size, band * MI) or ()) for size, band in GRID_LADDER
    ]
    fitting = [i for i, count in enumerate(counts) if count <= budget]
    expected = GRID_LADDER[fitting[0]] if fitting else GRID_LADDER[-1]
    assert (grid.cell_deg, grid.band_miles) == expected
    if fitting:
        assert len(grid.cells) <= budget


def test_a_three_route_trip_of_900_miles_stays_within_300_weather_locations():
    lines = [east_west_route(900, lat) for lat in (35.0, 36.2, 37.4)]
    checkpoint_locations = set()
    for line in lines:
        cumulative = cumulative_distances_m(line)
        for d in checkpoint_distances_m(cumulative[-1], 25 * MI):
            checkpoint_locations.add(forecast_point(interpolate(line, cumulative, d)))
    grid = choose_grid(lines, heat_cell_budget(len(checkpoint_locations)))
    assert len(checkpoint_locations) + len(grid.cells) <= WEATHER_LOCATION_TARGET


def test_choose_grid_falls_back_to_the_coarsest_option():
    lines = [east_west_route(2800, lat=lat) for lat in (34.0, 37.0, 40.0)]
    grid = choose_grid(lines, budget=5)
    assert (grid.cell_deg, grid.band_miles) == GRID_LADDER[-1]
    assert len(grid.cells) > 5


@pytest.mark.parametrize(("lat", "budget"), [(25.0, 40), (36.0, 40), (47.5, 40), (36.0, 3)])
def test_every_route_sample_lies_in_a_kept_cell(lat, budget):
    line = east_west_route(300, lat=lat, wiggle_mi=15)
    grid = choose_grid([line], budget=budget)
    kept = set(grid.cells)
    for point in samples(line):
        cell = (math.floor(point[0] / grid.cell_deg), math.floor(point[1] / grid.cell_deg))
        assert cell in kept


def test_grid_cell_geometry():
    grid = HeatGrid(cell_deg=0.5, band_miles=30, cells=((72, -200),))
    assert grid.center(0) == (36.25, -99.75)
    assert grid.bounds(0) == (-100.0, 36.0, -99.5, 36.5)  # west, south, east, north


def test_a_cell_a_route_crosses_takes_its_forecast_on_the_road_nearest_its_centre():
    # On 2-degree cells (long trips) a route along a cell's southern edge runs about 55 miles from its centre.
    line = east_west_route(900, lat=34.2)
    grid = choose_grid([line], budget=5)
    assert grid.cell_deg == 2.0
    road = samples(line)
    for i, (row, col) in enumerate(grid.cells):
        point = grid.point(i)
        assert point in road  # a route sample, on the road
        assert (math.floor(point[0] / 2.0), math.floor(point[1] / 2.0)) == (row, col)  # inside the cell
        inside = [p for p in road if (math.floor(p[0] / 2.0), math.floor(p[1] / 2.0)) == (row, col)]
        nearest = min(approx_distance_m(p, grid.center(i)) for p in inside)
        assert approx_distance_m(point, grid.center(i)) == nearest
        assert approx_distance_m(point, grid.center(i)) > 50 * MI  # the centre is far off the road


def test_a_cell_kept_for_the_band_takes_its_forecast_at_its_centre():
    line = east_west_route(60, lat=36.0)
    grid = choose_grid([line], budget=1_000)
    crossed = {(math.floor(p[0] / grid.cell_deg), math.floor(p[1] / grid.cell_deg)) for p in samples(line)}
    band_only = [i for i, cell in enumerate(grid.cells) if cell not in crossed]
    assert band_only
    assert all(grid.point(i) == grid.center(i) for i in band_only)


def test_frames_start_at_departure_and_step_one_hour_to_48_hours():
    departure = datetime(2026, 10, 25, 14, 20, tzinfo=UTC)
    hours = frame_hours(departure)
    assert len(hours) == 49
    assert hours[0] == datetime(2026, 10, 25, 14, 0, tzinfo=UTC)  # nearest forecast hour
    assert hours[48] == datetime(2026, 10, 27, 14, 0, tzinfo=UTC)
    assert all(b - a == timedelta(hours=1) for a, b in zip(hours, hours[1:]))
    assert frame_hours(datetime(2026, 10, 25, 14, 30, tzinfo=UTC))[0].hour == 15  # half past rounds up


def test_frames_step_in_utc_across_a_daylight_saving_change():
    departure = datetime(2026, 10, 31, 12, 0, tzinfo=ZoneInfo("America/New_York"))  # 16:00 UTC
    hours = frame_hours(departure)
    assert all(b - a == timedelta(hours=1) for a, b in zip(hours, hours[1:]))
    assert hours[0] == datetime(2026, 10, 31, 16, 0, tzinfo=UTC)
    assert hours[48] == datetime(2026, 11, 2, 16, 0, tzinfo=UTC)


def test_frame_levels_apply_the_same_rules_and_load_as_checkpoints():
    t0 = int(datetime(2026, 10, 25, 14, 0, tzinfo=UTC).timestamp())
    # Wind at 14:00 and 15:00; the rain and snow of 14:00-15:00 are stamped 15:00, those of 15:00-16:00 16:00.
    windy = ForecastSeries.from_hourly(
        times=[t0, t0 + 3600, t0 + 7200],
        wind_mph=[47.0, 10.0, 10.0],
        gust_mph=[60.0, 15.0, 15.0],
        rain_in=[0.0, 0.0, 0.3],
        showers_in=[0.0, 0.0, 0.0],
        snow_in=[0.0, 0.0, None],
    )
    hours = [datetime(2026, 10, 25, 14, tzinfo=UTC), datetime(2026, 10, 25, 15, tzinfo=UTC)]
    light_load = frame_levels([windy, None], hours, load_lb=20_000)
    heavy_load = frame_levels([windy, None], hours, load_lb=35_000)
    assert light_load == [[3, None], [None, None]]  # Severe wind; then snow is missing -> No data
    assert heavy_load == [[4, None], [None, None]]  # load rule: 45-55 mph and > 30,000 lb -> No Travel


def test_frame_levels_are_no_data_past_the_end_of_the_forecast():
    t0 = int(datetime(2026, 10, 25, 14, 0, tzinfo=UTC).timestamp())
    series = ForecastSeries.from_hourly([t0, t0 + 3600], [5.0, 5.0], [8.0, 8.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0])
    hours = [datetime(2026, 10, 25, 14, tzinfo=UTC), datetime(2026, 10, 25, 15, tzinfo=UTC)]
    assert frame_levels([series], hours, load_lb=0) == [[0], [None]]  # 15:00 needs the rain stamped 16:00


def test_a_square_reads_the_same_forecast_hours_as_a_dot_at_that_moment():
    # Heavy rain from 14:00 to 15:00 (stamped 15:00), none in the hour before (stamped 14:00).
    t0 = int(datetime(2026, 10, 25, 14, 0, tzinfo=UTC).timestamp())
    series = ForecastSeries.from_hourly([t0, t0 + 3600], [5.0, 5.0], [8.0, 8.0], [0.0, 1.5], [0.0, 0.0], [0.0, 0.0])
    moment = datetime(2026, 10, 25, 14, tzinfo=UTC)  # a trip leaving at 14:00: the slider's +0 h
    _, _, at_dot = series.at_eta(moment)
    dot_level = assess(at_dot.wind_mph, at_dot.rain_in_hr, at_dot.snow_in_hr, 0).level
    assert dot_level is not None
    assert frame_levels([series], [moment], load_lb=0) == [[int(dot_level)]] == [[4]]  # No Travel rain, as the dot
