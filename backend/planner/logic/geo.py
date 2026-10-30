"""Geometry helpers for (latitude, longitude) points in degrees.

Distances use the haversine formula on a spherical Earth: within about 0.5 % of the true
ellipsoidal distance, and within 0.1 mile of TomTom's own length on an 883-mile route.
`approx_distance_m` uses a local flat-Earth approximation that is accurate to well under
1 % over the few tens of miles it is used for.
"""

import math
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterator, Sequence

LatLon = tuple[float, float]

EARTH_RADIUS_M = 6_371_008.8
METERS_PER_MILE = 1609.344
METERS_PER_DEG_LAT = math.pi * EARTH_RADIUS_M / 180  # about 111.2 km


def haversine_m(a: LatLon, b: LatLon) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, h)))


def approx_distance_m(a: LatLon, b: LatLon) -> float:
    """Fast equirectangular distance; use only for short distances."""
    dy = (b[0] - a[0]) * METERS_PER_DEG_LAT
    dx = (b[1] - a[1]) * METERS_PER_DEG_LAT * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dx, dy)


def cumulative_distances_m(points: Sequence[LatLon]) -> list[float]:
    """Distance from the first point to each point along the line."""
    cumulative = [0.0]
    for a, b in zip(points, points[1:]):
        cumulative.append(cumulative[-1] + haversine_m(a, b))
    return cumulative


def interpolate(points: Sequence[LatLon], cumulative: Sequence[float], distance_m: float) -> LatLon:
    """The point `distance_m` along the line (clamped to its ends).

    `cumulative` is the distance of each point along the line, as from `cumulative_distances_m`.
    """
    if distance_m <= cumulative[0]:
        return points[0]
    if distance_m >= cumulative[-1]:
        return points[-1]
    i = bisect_right(cumulative, distance_m) - 1  # cumulative[i] <= distance_m < cumulative[i + 1]
    span = cumulative[i + 1] - cumulative[i]
    t = (distance_m - cumulative[i]) / span
    (lat_a, lon_a), (lat_b, lon_b) = points[i], points[i + 1]
    return (lat_a + t * (lat_b - lat_a), lon_a + t * (lon_b - lon_a))


def resample(points: Sequence[LatLon], step_m: float) -> list[LatLon]:
    """Points every `step_m` along the line, starting at its first point and ending at its last."""
    if len(points) < 2:
        return list(points)
    cumulative = cumulative_distances_m(points)
    count = int(cumulative[-1] // step_m)
    samples = [interpolate(points, cumulative, k * step_m) for k in range(count + 1)]
    if cumulative[-1] - count * step_m > 1e-6:
        samples.append(points[-1])
    return samples


def simplify(points: Sequence[LatLon], tolerance_m: float) -> list[LatLon]:
    """Douglas-Peucker simplification: every dropped point lies within `tolerance_m` of the result."""
    if len(points) < 3:
        return list(points)
    # Project once, scaling longitude by the widest latitude (the one nearest the equator).
    # Projected distances are then never shorter than true ones, so the tolerance always holds;
    # elsewhere a little more detail than necessary is kept.
    kx = METERS_PER_DEG_LAT * max(math.cos(math.radians(p[0])) for p in points)
    xs = [p[1] * kx for p in points]
    ys = [p[0] * METERS_PER_DEG_LAT for p in points]

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tolerance_sq = tolerance_m * tolerance_m
    while stack:
        first, last = stack.pop()
        ax, ay, bx, by = xs[first], ys[first], xs[last], ys[last]
        dx, dy = bx - ax, by - ay
        seg_sq = dx * dx + dy * dy
        worst_sq, worst = -1.0, -1
        for i in range(first + 1, last):
            px, py = xs[i] - ax, ys[i] - ay
            if seg_sq == 0.0:
                d_sq = px * px + py * py
            else:
                t = max(0.0, min(1.0, (px * dx + py * dy) / seg_sq))
                ex, ey = px - t * dx, py - t * dy
                d_sq = ex * ex + ey * ey
            if d_sq > worst_sq:
                worst_sq, worst = d_sq, i
        if worst_sq > tolerance_sq:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [p for p, k in zip(points, keep) if k]


class PointIndex:
    """Grid hash answering "is an indexed point within `radius_m` of this point?".

    Each point can carry a numeric tag (for example its distance along a route), and a query
    can ignore points whose tag is above `max_tag`.
    """

    def __init__(self, radius_m: float) -> None:
        self.radius_m = radius_m
        self._cell_deg = radius_m / METERS_PER_DEG_LAT
        self._cells: dict[tuple[int, int], list[tuple[LatLon, float]]] = defaultdict(list)

    def _key(self, point: LatLon) -> tuple[int, int]:
        return (math.floor(point[0] / self._cell_deg), math.floor(point[1] / self._cell_deg))

    def add(self, point: LatLon, tag: float = 0.0) -> None:
        self._cells[self._key(point)].append((point, tag))

    def _nearby(self, point: LatLon, max_tag: float) -> Iterator[tuple[float, float]]:
        """(distance, tag) of indexed points within radius_m of `point` whose tag is at most `max_tag`."""
        row, col = self._key(point)
        # A cell is radius_m tall but only radius_m * cos(lat) wide, so look further east and west.
        cos_lat = max(math.cos(math.radians(point[0])), 0.01)
        col_reach = math.ceil(1 / cos_lat)
        for r in (row - 1, row, row + 1):
            for c in range(col - col_reach, col + col_reach + 1):
                for other, tag in self._cells.get((r, c), ()):
                    if tag <= max_tag:
                        distance = approx_distance_m(point, other)
                        if distance <= self.radius_m:
                            yield distance, tag

    def any_within(self, point: LatLon, max_tag: float = math.inf) -> bool:
        return next(self._nearby(point, max_tag), None) is not None

    def nearest_within(self, point: LatLon, max_tag: float = math.inf) -> float | None:
        """Tag of the indexed point nearest to `point`, if one lies within radius_m."""
        nearest = min(self._nearby(point, max_tag), default=None)
        return None if nearest is None else nearest[1]
