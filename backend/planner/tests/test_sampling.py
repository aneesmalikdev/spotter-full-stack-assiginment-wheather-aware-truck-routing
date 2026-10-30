"""Checkpoints: where they go, how many miles each one covers, and their ETAs."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from planner.logic.geo import METERS_PER_DEG_LAT, METERS_PER_MILE, haversine_m
from planner.logic.sampling import (
    ProgressPoint,
    RouteTrack,
    build_checkpoints,
    checkpoint_distances_m,
    coverage_m,
)

MI = METERS_PER_MILE
DEPARTURE = datetime(2026, 10, 25, 14, 0, tzinfo=UTC)


def miles(values):
    return [v / MI for v in values]


@pytest.mark.parametrize(
    ("length_mi", "interval_mi", "expected_mi"),
    [
        (60, 25, [0, 25, 50, 60]),  # last checkpoint is the destination
        (50, 25, [0, 25, 50]),  # an exact multiple adds no duplicate
        (10, 25, [0, 10]),  # shorter than one interval: origin and destination
        (100, 10, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
        (120.4, 50, [0, 50, 100, 120.4]),
    ],
)
def test_checkpoints_start_at_the_origin_and_end_at_the_destination(length_mi, interval_mi, expected_mi):
    assert miles(checkpoint_distances_m(length_mi * MI, interval_mi * MI)) == pytest.approx(expected_mi)


def test_a_route_of_zero_length_has_one_checkpoint():
    assert checkpoint_distances_m(0.0, 25 * MI) == [0.0]


def test_a_destination_that_would_show_the_same_mile_as_the_last_interval_mark_replaces_it():
    distances = checkpoint_distances_m(50.04 * MI, 25 * MI)  # both would show as mile 50.0
    assert len(distances) == 3
    assert distances[-1] == 50.04 * MI
    assert len(checkpoint_distances_m(50.06 * MI, 25 * MI)) == 4  # mile 50.1 gets its own checkpoint


def test_each_checkpoint_covers_half_the_road_to_its_neighbours():
    distances = [0.0, 25 * MI, 50 * MI, 60 * MI]
    assert miles(coverage_m(distances)) == pytest.approx([12.5, 25.0, 17.5, 5.0])


def test_coverage_always_adds_up_to_the_route_length():
    for length_mi in (0.4, 9.99, 25.0, 333.3, 2802.0):
        for interval_mi in (10, 25, 50):
            distances = checkpoint_distances_m(length_mi * MI, interval_mi * MI)
            assert sum(coverage_m(distances)) == pytest.approx(length_mi * MI)


def test_a_single_checkpoint_covers_nothing():
    assert coverage_m([0.0]) == [0.0]


def straight_track(scale: float = 1.0) -> RouteTrack:
    """Due north along a meridian, 10 points 0.1 degree apart (about 62 miles in total).

    Progress entries exist at points 0, 4 and 9. TomTom's distances are `scale` times the
    straight-line ones. The truck covers the first 4 segments in 3600 s and the last 5 in 1800 s.
    """
    points = [(30.0 + 0.1 * i, -100.0) for i in range(10)]
    seg = haversine_m(points[0], points[1]) * scale
    progress = [
        ProgressPoint(point_index=0, distance_m=0.0, time_s=0.0),
        ProgressPoint(point_index=4, distance_m=4 * seg, time_s=3600.0),
        ProgressPoint(point_index=9, distance_m=9 * seg, time_s=5400.0),
    ]
    return RouteTrack(points, progress)


def test_track_length_and_travel_time_come_from_the_last_progress_entry():
    track = straight_track(scale=1.02)
    assert track.length_m == pytest.approx(9 * 0.1 * METERS_PER_DEG_LAT * 1.02, rel=1e-6)
    assert track.travel_time_s == 5400.0


def test_positions_follow_tomtom_distances_between_progress_entries():
    track = straight_track(scale=1.02)  # TomTom says the road is 2 % longer than the straight line
    entry = track.progress[1]
    assert track.position_at(entry.distance_m) == pytest.approx(track.points[4])
    assert track.position_at(track.length_m) == pytest.approx(track.points[-1])
    assert track.position_at(0.0) == track.points[0]
    halfway_in_first_part = track.position_at(entry.distance_m / 2)
    assert halfway_in_first_part == pytest.approx((30.2, -100.0))


def test_distance_between_progress_entries_is_spread_by_road_length_not_by_point_count():
    # Many points close together at the start (an interchange), then one long straight segment,
    # with progress only at the two ends, as TomTom does on interstates.
    points = [(30.0, -100.0), (30.001, -100.0), (30.002, -100.0), (30.002, -100.0), (30.5, -100.0)]
    length = haversine_m(points[0], points[-1])
    track = RouteTrack(points, [ProgressPoint(0, 0.0, 0.0), ProgressPoint(4, length, 3600.0)])
    assert track.position_at(length / 2) == pytest.approx((30.25, -100.0), abs=1e-6)
    assert track.time_at(length / 2) == pytest.approx(1800.0)
    # The repeated point does not move along the route.
    assert track.position_at(haversine_m(points[0], points[2])) == pytest.approx(points[2], abs=1e-9)


def test_a_progress_span_without_movement_keeps_its_position():
    # Two progress entries on the same spot (for example where two legs meet).
    points = [(30.0, -100.0), (30.0, -100.0), (30.1, -100.0)]
    length = haversine_m(points[0], points[-1])
    progress = [ProgressPoint(0, 0.0, 0.0), ProgressPoint(1, 0.0, 60.0), ProgressPoint(2, length, 660.0)]
    track = RouteTrack(points, progress)
    assert track.position_at(0.0) == points[0]
    assert track.time_at(0.0) == 0.0  # the origin is always at the departure time
    assert track.position_at(length / 2) == pytest.approx((30.05, -100.0))
    assert track.time_at(length / 2) == pytest.approx(360.0)


def test_etas_are_utc_even_across_a_daylight_saving_change():
    # Departing 00:30 Chicago time on the night clocks go back (05:30 UTC); two hours of driving.
    track = RouteTrack([(30.0, -100.0), (31.0, -100.0)], [ProgressPoint(0, 0.0, 0.0), ProgressPoint(1, 110_000.0, 7200.0)])
    departure = datetime(2026, 11, 1, 0, 30, tzinfo=ZoneInfo("America/Chicago"))
    checkpoints = build_checkpoints(track, departure, interval_miles=50)
    assert all(c.eta.tzinfo is UTC for c in checkpoints)
    assert checkpoints[-1].eta == datetime(2026, 11, 1, 7, 30, tzinfo=UTC)


def test_travel_time_is_interpolated_between_progress_entries():
    track = straight_track()
    first_part, total = track.progress[1].distance_m, track.length_m
    assert track.time_at(0.0) == 0.0
    assert track.time_at(first_part / 2) == pytest.approx(1800.0)  # slow part: 3600 s for 4 segments
    assert track.time_at(first_part) == pytest.approx(3600.0)
    assert track.time_at((first_part + total) / 2) == pytest.approx(4500.0)  # fast part
    assert track.time_at(total) == 5400.0
    assert track.time_at(total + 100.0) == 5400.0


def test_checkpoints_get_positions_etas_and_coverage():
    track = straight_track()
    checkpoints = build_checkpoints(track, DEPARTURE, interval_miles=25)
    distances = [c.distance_m for c in checkpoints]
    assert miles(distances) == pytest.approx([0, 25, 50, track.length_m / MI])
    first, last = checkpoints[0], checkpoints[-1]
    assert first.position == track.points[0] and first.eta == DEPARTURE
    assert last.position == pytest.approx(track.points[-1])
    assert last.eta == DEPARTURE + timedelta(seconds=5400)
    assert [c.index for c in checkpoints] == [0, 1, 2, 3]
    assert sum(c.coverage_m for c in checkpoints) == pytest.approx(track.length_m)
    # 25 miles is inside the slow first part (4 segments, about 27.6 miles, in one hour).
    expected_s = 3600.0 * (25 * MI) / track.progress[1].distance_m
    assert checkpoints[1].eta == DEPARTURE + timedelta(seconds=expected_s)


def test_departure_must_be_time_zone_aware():
    with pytest.raises(ValueError):
        build_checkpoints(straight_track(), datetime(2026, 10, 25, 14, 0), interval_miles=25)


def test_progress_must_cover_the_whole_polyline():
    points = [(0.0, 0.0), (0.0, 0.1), (0.0, 0.2)]
    with pytest.raises(ValueError, match="first and last"):
        RouteTrack(points, [ProgressPoint(0, 0.0, 0.0), ProgressPoint(1, 100.0, 10.0)])
    with pytest.raises(ValueError, match="increasing"):
        RouteTrack(points, [ProgressPoint(0, 0.0, 0.0), ProgressPoint(2, 5.0, 10.0), ProgressPoint(2, 6.0, 12.0)])
