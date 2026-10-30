import math

import pytest

from planner.logic.geo import (
    METERS_PER_DEG_LAT,
    PointIndex,
    approx_distance_m,
    cumulative_distances_m,
    haversine_m,
    interpolate,
    resample,
    simplify,
)


def test_one_degree_of_latitude_is_about_111_km():
    assert haversine_m((0.0, 0.0), (1.0, 0.0)) == pytest.approx(111_195, rel=1e-4)
    assert METERS_PER_DEG_LAT == pytest.approx(111_195, rel=1e-4)


def test_one_degree_of_longitude_shrinks_with_latitude():
    assert haversine_m((60.0, 0.0), (60.0, 1.0)) == pytest.approx(111_195 * 0.5, rel=1e-3)


def test_approx_distance_matches_haversine_over_short_distances():
    a = (45.0, -100.0)
    for b in [(45.05, -100.0), (45.0, -100.1), (44.97, -99.93)]:
        assert approx_distance_m(a, b) == pytest.approx(haversine_m(a, b), rel=1e-3)


def test_cumulative_distances_start_at_zero_and_add_up():
    points = [(0.0, 0.0), (0.0, 1.0), (0.0, 3.0)]
    cumulative = cumulative_distances_m(points)
    assert cumulative[0] == 0.0
    assert cumulative[1] == pytest.approx(haversine_m(points[0], points[1]))
    assert cumulative[2] == pytest.approx(3 * cumulative[1], rel=1e-9)


def test_interpolate_returns_the_point_at_a_distance_and_clamps_to_the_ends():
    points = [(0.0, 0.0), (0.0, 2.0)]
    cumulative = cumulative_distances_m(points)
    lat, lon = interpolate(points, cumulative, cumulative[-1] / 2)
    assert lat == pytest.approx(0.0)
    assert lon == pytest.approx(1.0)
    assert interpolate(points, cumulative, -5.0) == points[0]
    assert interpolate(points, cumulative, cumulative[-1] + 5.0) == points[-1]


def test_interpolate_handles_repeated_points():
    points = [(0.0, 0.0), (0.0, 1.0), (0.0, 1.0), (0.0, 2.0)]
    cumulative = cumulative_distances_m(points)
    assert interpolate(points, cumulative, cumulative[1]) == pytest.approx((0.0, 1.0))
    assert interpolate(points, cumulative, cumulative[-1] * 0.75) == pytest.approx((0.0, 1.5))


def test_resample_spaces_points_evenly_and_keeps_the_end():
    points = [(0.0, 0.0), (0.0, 0.1)]  # about 11.1 km
    length = haversine_m(*points)
    samples = resample(points, 3000.0)
    assert len(samples) == math.floor(length / 3000.0) + 2  # 0, 3, 6, 9 km and the end
    assert samples[0] == points[0]
    assert samples[-1] == points[-1]
    gaps = [haversine_m(samples[i], samples[i + 1]) for i in range(len(samples) - 2)]
    assert gaps == pytest.approx([3000.0] * len(gaps), rel=1e-6)


def test_resample_of_a_single_point_is_that_point():
    assert resample([(1.0, 2.0)], 100.0) == [(1.0, 2.0)]


def test_simplify_drops_collinear_points_and_keeps_corners():
    straight = [(0.0, i * 0.001) for i in range(50)]
    assert simplify(straight, 10.0) == [straight[0], straight[-1]]
    corner = [(0.0, 0.0), (0.0, 0.01), (0.0, 0.02), (0.01, 0.02), (0.02, 0.02)]
    assert simplify(corner, 10.0) == [(0.0, 0.0), (0.0, 0.02), (0.02, 0.02)]


def test_simplify_keeps_every_dropped_point_within_tolerance():
    # A gentle zig-zag: deviations of about 5 m and 50 m.
    points = [(0.0, 0.0)]
    for i in range(1, 200):
        wiggle = (0.00045 if i % 20 == 0 else 0.000045) * (1 if i % 2 else -1)
        points.append((wiggle, i * 0.0005))
    kept = simplify(points, 20.0)
    assert len(kept) < len(points)
    assert kept[0] == points[0] and kept[-1] == points[-1]
    dense_kept = resample(kept, 20.0)
    index = PointIndex(25.0)
    for p in dense_kept:
        index.add(p)
    assert all(index.any_within(p) for p in points)


def test_simplify_keeps_its_tolerance_on_long_north_south_lines():
    # 26 to 49 degrees north: a single projection must not shrink east-west distances in the south.
    points = [(25.9 + 23.1 * i / 4000, -97.5) for i in range(4001)]
    bump_m = 55.0
    lat, lon = points[50]
    points[50] = (lat, lon + bump_m / (METERS_PER_DEG_LAT * math.cos(math.radians(lat))))
    kept = simplify(points, 50.0)
    assert points[50] in kept  # 55 m off the line, more than the 50 m tolerance


def test_point_index_finds_points_within_the_radius_only():
    index = PointIndex(1000.0)
    index.add((60.0, 10.0))
    meters_per_deg_lon = METERS_PER_DEG_LAT * math.cos(math.radians(60.0))
    assert index.any_within((60.0, 10.0 + 900 / meters_per_deg_lon))  # 900 m east
    assert not index.any_within((60.0, 10.0 + 1100 / meters_per_deg_lon))  # 1.1 km east
    assert index.any_within((60.0 + 990 / METERS_PER_DEG_LAT, 10.0))  # 990 m north
    assert not index.any_within((60.0 + 1010 / METERS_PER_DEG_LAT, 10.0))


def test_point_index_can_ignore_points_by_tag():
    index = PointIndex(1000.0)
    index.add((0.0, 0.0), tag=5000.0)
    assert index.any_within((0.0, 0.0))
    assert index.any_within((0.0, 0.0), max_tag=5000.0)
    assert not index.any_within((0.0, 0.0), max_tag=4999.0)


def test_point_index_returns_the_tag_of_the_nearest_point():
    index = PointIndex(1000.0)
    index.add((0.0, 0.0), tag=7.0)
    index.add((0.0, 0.005), tag=300.0)  # about 560 m east
    index.add((0.0, 0.5), tag=900.0)  # far away
    assert index.nearest_within((0.0, 0.001)) == 7.0
    assert index.nearest_within((0.0, 0.004)) == 300.0
    assert index.nearest_within((0.0, 0.004), max_tag=299.0) == 7.0
    assert index.nearest_within((0.0, 0.2)) is None
