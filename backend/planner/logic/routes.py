"""Comparing routes, and choosing via points for the extra routes the app builds.

TomTom returns up to three routes. When fewer than three distinct ones come back, the app asks
TomTom for a route through a point beside the main route (a via point). These helpers decide
whether two routes are really different and where via points go.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .geo import (
    METERS_PER_DEG_LAT,
    LatLon,
    PointIndex,
    approx_distance_m,
    cumulative_distances_m,
    haversine_m,
    interpolate,
    resample,
)

SAMPLE_SPACING_M = 500.0
NEAR_M = 1_000.0  # road within this distance of another route counts as shared
MAX_SHARED_FRACTION = 0.9  # two routes are the same when 90 % of either one is shared with the other

# Backtracking: driving back over road the route has already used (an out-and-back detour).
BACKTRACK_SPACING_M = 100.0
BACKTRACK_RADIUS_M = 250.0  # the same road, or the other carriageway of a divided highway
BACKTRACK_LOOKBACK_M = 1_000.0  # road driven this recently is not compared
BACKTRACK_MIN_RUN_M = 1_000.0  # matches must move back this far before a stretch counts
BACKTRACK_MAX_GAP = 3  # samples in a row without a match that a stretch survives
MAX_BACKTRACK_M = 5_000.0

VIA_FRACTIONS = (0.5, 0.35, 0.65)  # where along the main route via points are tried
VIA_OFFSET_SHARE = 0.15  # distance from the route, as a share of its length ...
VIA_MIN_OFFSET_M = 25_000.0  # ... at least this (or 30 % of the route, if shorter) ...
VIA_MAX_OFFSET_M = 150_000.0  # ... and at most this
VIA_MAX_RADIUS_M = 135_000  # TomTom's limit for a circle waypoint's radius
VIA_CLEARANCE = 0.8  # a via point must be at least 0.8 x offset away from every existing route
EXISTING_SAMPLE_SPACING_M = 2_000.0


class RouteShape:
    """A route resampled every 500 m and indexed, to measure how much road two routes share."""

    def __init__(self, points: Sequence[LatLon]) -> None:
        if not points:
            raise ValueError("a route needs at least one point")
        self.samples = resample(points, SAMPLE_SPACING_M)
        self.index = PointIndex(NEAR_M)
        for k, point in enumerate(self.samples):
            self.index.add(point, tag=k * SAMPLE_SPACING_M)

    def shared_fraction(self, other: "RouteShape") -> float:
        """Share of this route that runs within 1 km of the other route."""
        shared = sum(1 for point in self.samples if other.index.any_within(point))
        return shared / len(self.samples)


def is_distinct(candidate: RouteShape, accepted: Sequence[RouteShape]) -> bool:
    """A route is distinct unless 90 % or more of it, or of an accepted route, is shared road.

    Checking both directions catches a route that is an accepted route plus a detour.
    """
    return all(
        candidate.shared_fraction(other) < MAX_SHARED_FRACTION
        and other.shared_fraction(candidate) < MAX_SHARED_FRACTION
        for other in accepted
    )


def retraced_m(points: Sequence[LatLon]) -> float:
    """The longest stretch over which the route drives back along road it has already used.

    Every 100 m the route is matched to the nearest point it passed more than 1 km earlier, if one
    lies within 250 m (the same road, or the other carriageway of a divided highway). While the
    route drives back over earlier road, those matches keep moving backwards; once they have moved
    back at least 1 km, the stretch's length is half the distance driven between the two passes
    of the same spot. Switchback legs and loop ramps only give stretches as long as one leg.
    """
    samples = resample(points, BACKTRACK_SPACING_M)
    lookback = round(BACKTRACK_LOOKBACK_M / BACKTRACK_SPACING_M)
    min_run = BACKTRACK_MIN_RUN_M / BACKTRACK_SPACING_M
    earlier = PointIndex(BACKTRACK_RADIUS_M)
    longest = 0.0
    run_start: float | None = None  # earlier sample matched when the current stretch began
    last_match: float | None = None
    last_k = 0
    for k, point in enumerate(samples):
        if k >= lookback:
            earlier.add(samples[k - lookback], tag=k - lookback)
        match = earlier.nearest_within(point)
        if match is None:
            if k - last_k > BACKTRACK_MAX_GAP:
                run_start = last_match = None
            continue
        steps = k - last_k
        if run_start is not None and last_match is not None and 0 <= last_match - match <= 3 * steps:
            # Still driving back over the same road (curves make the match advance unevenly).
            if match < last_match and run_start - match >= min_run:
                longest = max(longest, (k - match) * BACKTRACK_SPACING_M / 2)
        else:
            run_start = match
        last_match, last_k = match, k
    return longest


def has_backtrack(points: Sequence[LatLon]) -> bool:
    """True when the route drives back over 5 km or more of its own road (an out-and-back detour)."""
    return retraced_m(points) >= MAX_BACKTRACK_M


@dataclass(frozen=True)
class ViaCandidate:
    position: LatLon
    radius_m: int  # TomTom circle waypoint: the route passes somewhere inside this circle
    offset_m: float
    fraction: float  # where along the main route the point sits beside (0-1)
    side: str  # "left" or "right" of the direction of travel
    detour_m: float  # straight-line detour through the point: |O-V| + |V-D| - |O-D|


def via_offset_m(route_length_m: float) -> float:
    lower = min(VIA_MIN_OFFSET_M, 0.3 * route_length_m)
    return max(lower, min(VIA_OFFSET_SHARE * route_length_m, VIA_MAX_OFFSET_M))


def via_candidates(main: Sequence[LatLon], existing: Sequence[Sequence[LatLon]]) -> list[ViaCandidate]:
    """Via points beside the main route, smallest detour first.

    Points too close to any existing route are dropped: TomTom would just return that route again.
    """
    cumulative = cumulative_distances_m(main)
    length = cumulative[-1]
    if length <= 0:
        return []
    offset = via_offset_m(length)
    radius = round(min(VIA_MAX_RADIUS_M, offset / 3))
    window = min(20_000.0, 0.05 * length)  # direction of travel measured over this distance each way
    origin, destination = main[0], main[-1]
    direct = haversine_m(origin, destination)
    spacing = min(EXISTING_SAMPLE_SPACING_M, offset / 10)  # fine enough for short trips' small offsets
    existing_samples = [p for line in existing for p in resample(line, spacing)]

    candidates = []
    for fraction in VIA_FRACTIONS:
        at = fraction * length
        here = interpolate(main, cumulative, at)
        behind = interpolate(main, cumulative, at - window)
        ahead = interpolate(main, cumulative, at + window)
        cos_lat = math.cos(math.radians(here[0]))
        east, north = (ahead[1] - behind[1]) * cos_lat, ahead[0] - behind[0]
        norm = math.hypot(east, north)
        if norm == 0:
            continue
        east, north = east / norm, north / norm
        for side, sign in (("left", 1.0), ("right", -1.0)):
            # Left of the direction of travel is the direction turned 90 degrees anticlockwise.
            normal_east, normal_north = -north * sign, east * sign
            position = (
                here[0] + normal_north * offset / METERS_PER_DEG_LAT,
                here[1] + normal_east * offset / (METERS_PER_DEG_LAT * cos_lat),
            )
            clearance = min((approx_distance_m(position, p) for p in existing_samples), default=math.inf)
            if clearance < VIA_CLEARANCE * offset:
                continue
            detour = haversine_m(origin, position) + haversine_m(position, destination) - direct
            candidates.append(ViaCandidate(position, radius, offset, fraction, side, detour))
    return sorted(candidates, key=lambda c: c.detour_m)
