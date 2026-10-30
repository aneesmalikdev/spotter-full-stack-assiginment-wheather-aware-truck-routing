"""The heatmap: a grid of cells around the routes, and their risk level for each of the slider's
49 hours (0 to 48 hours after departure).

Cells sit on a fixed latitude/longitude lattice, so routes that share road share cells. A cell a
route passes through takes its forecast on that road; one kept for the band, at its centre. The
grid is as fine as the weather budget allows: a plan at the default 25-mile interval should need about 300 forecast
locations in total, half of Open-Meteo's free per-minute limit, so two plans can run back to back.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from .geo import METERS_PER_DEG_LAT, METERS_PER_MILE, LatLon, approx_distance_m, resample
from .risk import assess
from .timeutil import nearest_hour
from .weather import ForecastSeries

WEATHER_LOCATION_TARGET = 300  # forecast locations per plan at the 25-mile interval
MIN_HEAT_CELL_BUDGET = 80  # the heatmap may always use this many cells
FRAME_COUNT = 49  # slider positions 0..48 hours
SAMPLE_SPACING_M = 2 * METERS_PER_MILE

# (cell size in degrees, band in miles), finest first. A cell is kept when a route passes through
# it or its centre is within the band of a route. The coarsest options keep only the cells the
# routes pass through: at that size a 30-mile band adds almost nothing.
GRID_LADDER: tuple[tuple[float, float], ...] = (
    (0.25, 30.0),
    (0.3, 30.0),
    (0.35, 30.0),
    (0.4, 30.0),
    (0.5, 30.0),
    (0.6, 30.0),
    (0.75, 30.0),
    (1.0, 30.0),
    (1.5, 0.0),
    (2.0, 0.0),
)

Cell = tuple[int, int]  # (row, col): latitude [row, row + 1) and longitude [col, col + 1) times the cell size


def heat_cell_budget(checkpoint_locations: int) -> int:
    """Cells the heatmap may use, given the forecast locations the 25-mile checkpoints need."""
    return max(MIN_HEAT_CELL_BUDGET, WEATHER_LOCATION_TARGET - checkpoint_locations)


@dataclass(frozen=True)
class HeatGrid:
    cell_deg: float
    band_miles: float
    cells: tuple[Cell, ...]
    on_route: tuple[LatLon | None, ...] = ()  # per cell: the route sample nearest its centre, if a route crosses it

    def center(self, i: int) -> LatLon:
        row, col = self.cells[i]
        return (round((row + 0.5) * self.cell_deg, 6), round((col + 0.5) * self.cell_deg, 6))

    def point(self, i: int) -> LatLon:
        """Where cell i's forecast is taken: on the road, at the route sample nearest the cell's centre,
        when a route passes through it, so the cell describes the road it holds (a 2-degree cell's
        centre can be 80 miles from it); otherwise, for cells kept for the band, the centre."""
        sample = self.on_route[i] if i < len(self.on_route) else None
        return sample if sample is not None else self.center(i)

    def bounds(self, i: int) -> tuple[float, float, float, float]:
        """(west, south, east, north) of cell i."""
        row, col = self.cells[i]
        size = self.cell_deg
        return (round(col * size, 6), round(row * size, 6), round((col + 1) * size, 6), round((row + 1) * size, 6))


def _cell_of(point: LatLon, cell_deg: float) -> Cell:
    return (math.floor(point[0] / cell_deg), math.floor(point[1] / cell_deg))


def _corner_cell(a: LatLon, b: LatLon, cell_a: Cell, cell_b: Cell, cell_deg: float) -> Cell | None:
    """When a step between two samples moves to a diagonal cell, the cell it cuts through on the way."""
    (row_a, col_a), (row_b, col_b) = cell_a, cell_b
    if row_a == row_b or col_a == col_b:
        return None
    t_row = (max(row_a, row_b) * cell_deg - a[0]) / (b[0] - a[0])  # where it crosses into the new row
    t_col = (max(col_a, col_b) * cell_deg - a[1]) / (b[1] - a[1])  # ... and into the new column
    if t_row < t_col:
        return (row_b, col_a)
    if t_col < t_row:
        return (row_a, col_b)
    return None  # exactly through the corner


def cells_near(
    lines: Sequence[Sequence[LatLon]], cell_deg: float, band_m: float, limit: int | None = None
) -> set[Cell] | None:
    """Cells the lines pass through, plus cells whose centre is within `band_m` of a line.

    Each line is a route sampled at a spacing much smaller than a cell. Returns None as soon as
    more than `limit` cells are needed.
    """
    cells: set[Cell] = set()
    cell_height_m = cell_deg * METERS_PER_DEG_LAT
    row_reach = math.ceil(band_m / cell_height_m) + 1
    for line in lines:
        previous: tuple[LatLon, Cell] | None = None
        for point in line:
            home = _cell_of(point, cell_deg)
            cells.add(home)
            if previous is not None:
                corner = _corner_cell(previous[0], point, previous[1], home, cell_deg)
                if corner is not None:
                    cells.add(corner)
            previous = (point, home)
            if band_m > 0:
                col_reach = math.ceil(band_m / (cell_height_m * max(math.cos(math.radians(point[0])), 0.01))) + 1
                for row in range(home[0] - row_reach, home[0] + row_reach + 1):
                    for col in range(home[1] - col_reach, home[1] + col_reach + 1):
                        if (row, col) not in cells:
                            centre = ((row + 0.5) * cell_deg, (col + 0.5) * cell_deg)
                            if approx_distance_m(point, centre) <= band_m:
                                cells.add((row, col))
            if limit is not None and len(cells) > limit:
                return None
    return cells


def choose_grid(route_lines: Sequence[Sequence[LatLon]], budget: int) -> HeatGrid:
    """The finest grid in GRID_LADDER that needs at most `budget` cells (else the coarsest)."""
    lines = [resample(line, SAMPLE_SPACING_M) for line in route_lines]
    for cell_deg, band_miles in GRID_LADDER:
        cells = cells_near(lines, cell_deg, band_miles * METERS_PER_MILE, limit=budget)
        if cells is not None:
            return _grid(lines, cell_deg, band_miles, cells)
    cell_deg, band_miles = GRID_LADDER[-1]
    cells = cells_near(lines, cell_deg, band_miles * METERS_PER_MILE)
    assert cells is not None  # no limit, so never None
    return _grid(lines, cell_deg, band_miles, cells)


def _grid(lines: Sequence[Sequence[LatLon]], cell_deg: float, band_miles: float, cells: set[Cell]) -> HeatGrid:
    """The grid, with the route sample nearest each crossed cell's centre (see HeatGrid.point)."""
    nearest: dict[Cell, tuple[float, LatLon]] = {}
    for line in lines:
        for point in line:
            cell = _cell_of(point, cell_deg)
            centre = ((cell[0] + 0.5) * cell_deg, (cell[1] + 0.5) * cell_deg)
            distance = approx_distance_m(point, centre)
            if cell not in nearest or distance < nearest[cell][0]:
                nearest[cell] = (distance, point)
    ordered = tuple(sorted(cells))
    return HeatGrid(cell_deg, band_miles, ordered, tuple(nearest[c][1] if c in nearest else None for c in ordered))


def frame_hours(departure: datetime, count: int = FRAME_COUNT) -> list[datetime]:
    """The forecast hour shown at each slider position: the hour nearest departure + h hours (UTC)."""
    first = nearest_hour(departure)
    return [first + timedelta(hours=h) for h in range(count)]


def frame_levels(
    series_by_cell: Sequence[ForecastSeries | None], hours: Sequence[datetime], load_lb: float
) -> list[list[int | None]]:
    """Risk level (0-4, or None for no data) of every cell at every hour, with the same rules, load
    and hours as the checkpoints (ForecastSeries.at_eta): the wind at the hour, and the rain and snow
    of the hour that starts then. A square and a dot at the same moment so read the same forecast.
    Indexed [hour][cell]."""
    frames = []
    for hour in hours:
        frame: list[int | None] = []
        for series in series_by_cell:
            level = None
            if series is not None:
                _, _, weather = series.at_eta(hour)
                level = assess(weather.wind_mph, weather.rain_in_hr, weather.snow_in_hr, load_lb).level
            frame.append(None if level is None else int(level))
        frames.append(frame)
    return frames
