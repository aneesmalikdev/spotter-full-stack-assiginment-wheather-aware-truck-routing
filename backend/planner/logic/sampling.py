"""Checkpoints along a route: where they are, how much road each one stands for, and when the
truck gets there.

ETAs come from TomTom's progress data: the cumulative distance and travel time it reports at
points along the route (with historic traffic for the departure time). Between two of those
entries, time is interpolated linearly by distance, as TomTom documents.
"""

from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from .geo import METERS_PER_MILE, LatLon, cumulative_distances_m, interpolate
from .timeutil import require_aware

# A destination this close past the last interval mark replaces that mark instead of adding a
# checkpoint right after it: miles are shown to 0.1 mi, so both would show the same mile.
DUPLICATE_TOLERANCE_M = 0.05 * METERS_PER_MILE  # about 80 m


@dataclass(frozen=True)
class ProgressPoint:
    point_index: int  # index into the route's polyline points
    distance_m: float  # from the start of the route
    time_s: float  # travel time from the start of the route


@dataclass(frozen=True)
class Checkpoint:
    index: int
    distance_m: float
    position: LatLon
    eta: datetime  # UTC
    coverage_m: float  # road this checkpoint stands for: halfway to each neighbour


class RouteTrack:
    """A route's polyline with TomTom's progress entries."""

    def __init__(self, points: Sequence[LatLon], progress: Sequence[ProgressPoint]) -> None:
        if len(points) < 2:
            raise ValueError("a route needs at least two points")
        if not progress or progress[0].point_index != 0 or progress[-1].point_index != len(points) - 1:
            raise ValueError("progress must include the first and last points of the route")
        for a, b in zip(progress, progress[1:]):
            if b.point_index <= a.point_index or b.distance_m < a.distance_m or b.time_s < a.time_s:
                raise ValueError("progress entries must be increasing along the route")
        self.points = list(points)
        self.progress = list(progress)
        self._progress_distances = [p.distance_m for p in self.progress]
        self._cumulative = self._anchored_cumulative()

    @property
    def length_m(self) -> float:
        return self.progress[-1].distance_m

    @property
    def travel_time_s(self) -> float:
        return self.progress[-1].time_s

    def _anchored_cumulative(self) -> list[float]:
        """Each point's distance along the route, matching TomTom's distance at every progress
        entry and spread between entries in proportion to straight-line distance."""
        raw = cumulative_distances_m(self.points)
        anchored = [0.0] * len(self.points)
        for a, b in zip(self.progress, self.progress[1:]):
            raw_span = raw[b.point_index] - raw[a.point_index]
            span = b.distance_m - a.distance_m
            for i in range(a.point_index, b.point_index + 1):
                share = (raw[i] - raw[a.point_index]) / raw_span if raw_span > 0 else 0.0
                anchored[i] = a.distance_m + share * span
        return anchored

    def position_at(self, distance_m: float) -> LatLon:
        return interpolate(self.points, self._cumulative, distance_m)

    def time_at(self, distance_m: float) -> float:
        """Travel time from the start to `distance_m` along the route (clamped to the route)."""
        if distance_m <= self.progress[0].distance_m:
            return self.progress[0].time_s
        i = bisect_right(self._progress_distances, distance_m)
        if i == len(self.progress):
            return self.progress[-1].time_s
        a, b = self.progress[i - 1], self.progress[i]
        return a.time_s + (b.time_s - a.time_s) * (distance_m - a.distance_m) / (b.distance_m - a.distance_m)


def checkpoint_distances_m(length_m: float, interval_m: float) -> list[float]:
    """0, one interval, two intervals, ... and finally the destination."""
    if interval_m <= 0:
        raise ValueError("interval must be positive")
    if length_m <= 0:
        return [0.0]
    distances = [k * interval_m for k in range(int(length_m // interval_m) + 1)]
    if len(distances) > 1 and length_m - distances[-1] <= DUPLICATE_TOLERANCE_M:
        distances[-1] = length_m
    else:
        distances.append(length_m)
    return distances


def coverage_m(distances: Sequence[float]) -> list[float]:
    """Road each checkpoint stands for: from halfway to the previous checkpoint to halfway to the
    next one (the first and last checkpoints stop at the route's ends). Adds up to the route length."""
    last = len(distances) - 1
    covered = []
    for i, d in enumerate(distances):
        start = d if i == 0 else (distances[i - 1] + d) / 2
        end = d if i == last else (d + distances[i + 1]) / 2
        covered.append(end - start)
    return covered


def build_checkpoints(track: RouteTrack, departure: datetime, interval_miles: float) -> list[Checkpoint]:
    start = require_aware(departure)
    distances = checkpoint_distances_m(track.length_m, interval_miles * METERS_PER_MILE)
    return [
        Checkpoint(
            index=i,
            distance_m=d,
            position=track.position_at(d),
            eta=start + timedelta(seconds=track.time_at(d)),
            coverage_m=covered,
        )
        for i, (d, covered) in enumerate(zip(distances, coverage_m(distances)))
    ]
