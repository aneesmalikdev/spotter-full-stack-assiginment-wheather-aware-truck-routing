"""Route comparison (distinct or not) and the via points used to add missing routes (README 13-14)."""

import math

import pytest

from planner.logic.geo import METERS_PER_DEG_LAT, approx_distance_m, haversine_m
from planner.logic.routes import (
    VIA_FRACTIONS,
    RouteShape,
    has_backtrack,
    is_distinct,
    via_candidates,
    via_offset_m,
)


def km_east(start, km):
    lat, lon = start
    return (lat, lon + km * 1000 / (METERS_PER_DEG_LAT * math.cos(math.radians(lat))))


def km_north(start, km):
    lat, lon = start
    return (lat + km * 1000 / METERS_PER_DEG_LAT, lon)


def line(start, end, steps=200):
    return [
        (start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps)
        for i in range(steps + 1)
    ]


def chain(*points, step_km=0.1):
    """Straight legs through the points, with a vertex every `step_km`."""
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        out += line(a, b, steps=max(1, round(haversine_m(a, b) / (step_km * 1000))))[1:]
    return out


ORIGIN = (35.0, -100.0)
EAST_600 = km_east(ORIGIN, 600)
MIDDLE = km_east(ORIGIN, 300)


def detour_north(start_km, end_km, north_km):
    """The 600 km route east, except that between start_km and end_km it runs north_km further north."""
    a, b = km_east(ORIGIN, start_km), km_east(ORIGIN, end_km)
    return chain(ORIGIN, a, km_north(a, north_km), km_north(b, north_km), b, EAST_600)


# Distinct routes


def test_a_route_is_not_distinct_from_itself_even_with_sparse_vertices():
    dense = line(ORIGIN, EAST_600, steps=600)
    sparse = [ORIGIN, MIDDLE, EAST_600]
    assert not is_distinct(RouteShape(dense), [RouteShape(sparse)])
    assert not is_distinct(RouteShape(sparse), [RouteShape(dense)])


@pytest.mark.parametrize(("gap_km", "distinct"), [(0.8, False), (1.5, True), (20.0, True)])
def test_a_parallel_road_counts_as_shared_within_1_km(gap_km, distinct):
    main = line(ORIGIN, EAST_600)
    parallel = detour_north(0, 600, gap_km)
    assert is_distinct(RouteShape(parallel), [RouteShape(main)]) is distinct


@pytest.mark.parametrize(("replaced_km", "distinct"), [(30, False), (90, True)])
def test_routes_sharing_90_percent_or_more_are_the_same(replaced_km, distinct):
    # Replacing 30 km of a 600 km route with a road 10 km away leaves about 92 % shared; 90 km, about 82 %.
    main = line(ORIGIN, EAST_600)
    variant = detour_north(250, 250 + replaced_km, 10)
    assert is_distinct(RouteShape(variant), [RouteShape(main)]) is distinct


def test_a_route_that_contains_another_plus_a_detour_is_not_distinct():
    main = line(ORIGIN, EAST_600)
    spur_end = km_north(MIDDLE, 150)
    with_spur = chain(ORIGIN, MIDDLE, spur_end, MIDDLE, EAST_600, step_km=2)
    # Under 90 % of the new route is on the main route, but all of the main route is on the new one.
    assert not is_distinct(RouteShape(with_spur), [RouteShape(main)])


def test_a_candidate_must_be_distinct_from_every_accepted_route():
    main = line(ORIGIN, EAST_600)
    north = detour_north(0, 600, 30)
    assert is_distinct(RouteShape(list(north)), [RouteShape(main)])
    assert not is_distinct(RouteShape(list(north)), [RouteShape(main), RouteShape(north)])


def test_empty_routes_are_refused():
    with pytest.raises(ValueError):
        RouteShape([])


# Backtracking

JUNCTION_SHIFTS_M = (0, 30, 60, 90)  # move the junction so the 100 m samples fall differently


def winding_xy(length_m, radius_m, turn_deg, straight_m, step_m=10.0):
    """A road heading north from (0, 0): straights and alternating circular bends, in metres (x east)."""
    x, y, heading, sign = 0.0, 0.0, math.pi / 2, 1
    points = [(x, y)]

    def advance(turn_per_m):
        nonlocal x, y, heading
        heading += turn_per_m * step_m
        x, y = x + step_m * math.cos(heading), y + step_m * math.sin(heading)
        points.append((x, y))

    while (len(points) - 1) * step_m < length_m:
        for _ in range(round(straight_m / step_m)):
            advance(0.0)
        for _ in range(round(radius_m * math.radians(turn_deg) / step_m)):
            advance(sign / radius_m)
        sign = -sign
    return points[: round(length_m / step_m) + 1]


def switchbacks_xy(legs, leg_m, gap_m):
    """A dead-end road climbing north by hairpins: legs alternate east and west, gap_m apart."""
    points = [(0.0, 0.0)]
    for i in range(legs):
        x_end = leg_m if i % 2 == 0 else 0.0
        y = i * gap_m
        points += [(points[-1][0] + (x_end - points[-1][0]) * k / 50, y) for k in range(1, 51)]
        points += [(x_end, y + gap_m * k / 5) for k in range(1, 6)]
    return points


def offset_xy(points, d):
    """The road shifted d metres to its right (the other carriageway)."""
    out = []
    for i, (x, y) in enumerate(points):
        (ax, ay), (bx, by) = points[max(i - 1, 0)], points[min(i + 1, len(points) - 1)]
        n = math.hypot(bx - ax, by - ay) or 1.0
        out.append((x + (by - ay) / n * d, y - (bx - ax) / n * d))
    return out


def out_and_back(road_xy, carriageway_gap_m=0.0, shift_m=0):
    """Approach from the west, drive the road out, drive it back, and leave to the east."""
    approach = [(-20_000.0 - shift_m + 100.0 * i, 0.0) for i in range(201)] + [(0.0, 0.0)]
    back = list(reversed(offset_xy(road_xy, carriageway_gap_m) if carriageway_gap_m else road_xy))
    leave = [(100.0 * i, 0.0) for i in range(1, 201)]
    kx = METERS_PER_DEG_LAT * math.cos(math.radians(ORIGIN[0]))
    return [(ORIGIN[0] + y / METERS_PER_DEG_LAT, ORIGIN[1] + x / kx) for x, y in approach + road_xy + back + leave]


@pytest.mark.parametrize(("spur_km", "flagged"), [(4.0, False), (4.5, False), (5.5, True), (6.0, True), (20.0, True)])
def test_driving_back_over_about_5_km_of_the_same_road_is_backtracking(spur_km, flagged):
    road = [(0.0, 100.0 * i) for i in range(round(spur_km * 10) + 1)]
    for shift in JUNCTION_SHIFTS_M:
        assert has_backtrack(out_and_back(road, shift_m=shift)) is flagged


def test_backtracking_on_the_other_carriageway_of_a_divided_highway_counts():
    road = [(0.0, 100.0 * i) for i in range(61)]
    for shift in JUNCTION_SHIFTS_M:
        assert has_backtrack(out_and_back(road, carriageway_gap_m=60.0, shift_m=shift))


@pytest.mark.parametrize(
    ("radius_m", "turn_deg", "straight_m", "carriageway_gap_m"),
    [(80, 90, 150, 0.0), (300, 60, 300, 0.0), (600, 45, 500, 100.0), (1000, 30, 1000, 60.0)],
)
def test_backtracking_on_winding_roads_is_found(radius_m, turn_deg, straight_m, carriageway_gap_m):
    road = winding_xy(8_000, radius_m, turn_deg, straight_m)
    for shift in JUNCTION_SHIFTS_M:
        assert has_backtrack(out_and_back(road, carriageway_gap_m, shift))


def test_driving_up_and_back_down_a_dead_end_switchback_road_is_backtracking():
    road = switchbacks_xy(legs=10, leg_m=500, gap_m=100)  # about 6 km of road
    for shift in JUNCTION_SHIFTS_M:
        assert has_backtrack(out_and_back(road, shift_m=shift))


def test_switchbacks_loops_and_a_road_on_the_other_river_bank_are_not_backtracking():
    assert not has_backtrack(line(ORIGIN, EAST_600))
    # 20 switchback legs of 1 km, 100 m apart.
    zigzag = [ORIGIN, MIDDLE]
    for i in range(20):
        top = 1.0 if i % 2 == 0 else 0.0
        zigzag += [km_north(km_east(MIDDLE, 0.1 * i), top), km_north(km_east(MIDDLE, 0.1 * (i + 1)), top)]
    assert not has_backtrack(chain(*zigzag, km_east(MIDDLE, 2.0), EAST_600, step_km=0.02))
    # Up one bank of a 300 m wide river to a bridge 10 km away, and down the other bank.
    river = chain(ORIGIN, MIDDLE, km_north(MIDDLE, 10), km_north(km_east(MIDDLE, 0.3), 10), km_east(MIDDLE, 0.3), EAST_600)
    assert not has_backtrack(river)
    # A 270-degree loop ramp at an interchange.
    ramp = [km_north(km_east(MIDDLE, 0.15 * math.sin(t / 20)), 0.15 * (1 - math.cos(t / 20))) for t in range(95)]
    assert not has_backtrack(chain(ORIGIN, MIDDLE) + ramp + chain(km_east(km_north(MIDDLE, 0.15), -0.15), EAST_600))


# Via points


@pytest.mark.parametrize(
    ("route_km", "offset_km"),
    [(20, 6), (100, 25), (120, 25), (500, 75), (1000, 150), (2000, 150)],
)
def test_via_offset_is_15_percent_of_the_route_between_25_and_150_km(route_km, offset_km):
    # Short routes use 30 % of their length instead of the 25 km minimum.
    assert via_offset_m(route_km * 1000) == pytest.approx(offset_km * 1000)


def test_via_candidates_sit_beside_the_route_on_both_sides():
    main = line(ORIGIN, EAST_600)
    candidates = via_candidates(main, [main])
    assert len(candidates) == 6  # 3 places along the route x 2 sides
    assert {c.fraction for c in candidates} == set(VIA_FRACTIONS) == {0.35, 0.5, 0.65}
    assert {c.side for c in candidates} == {"left", "right"}
    for c in candidates:
        assert c.offset_m == pytest.approx(90_000)  # 15 % of 600 km
        assert c.radius_m == 30_000
        assert approx_distance_m(c.position, (ORIGIN[0], c.position[1])) == pytest.approx(90_000, rel=0.01)
        assert approx_distance_m(c.position, km_east(ORIGIN, 600 * c.fraction)) == pytest.approx(90_000, rel=0.01)
    left = [c for c in candidates if c.side == "left"]
    assert all(c.position[0] > ORIGIN[0] for c in left)  # heading east, left is north


def test_via_candidates_are_ordered_by_detour():
    main = line(ORIGIN, EAST_600)
    candidates = via_candidates(main, [main])
    detours = [c.detour_m for c in candidates]
    assert detours == sorted(detours)
    assert candidates[0].fraction == 0.5
    # On each side, the point beside the middle of the route is the smallest detour. (The two
    # sides differ: between two points at the same latitude the shortest path bows north.)
    for side in ("left", "right"):
        same_side = [c for c in candidates if c.side == side]
        assert same_side[0].fraction == 0.5


def test_candidates_near_any_existing_route_are_dropped():
    # An L-shaped route (east, then north): a point left of its midpoint lands close to its own
    # northbound leg, so it would just reproduce the same route.
    l_shape = line(ORIGIN, MIDDLE) + line(MIDDLE, km_north(MIDDLE, 300))[1:]
    candidates = via_candidates(l_shape, [l_shape])
    length = sum(haversine_m(a, b) for a, b in zip(l_shape, l_shape[1:]))
    offset = min(0.15 * length, 150_000)
    for c in candidates:
        nearest = min(approx_distance_m(c.position, p) for p in l_shape)
        assert nearest >= 0.8 * offset
    assert len(candidates) < 6


def test_candidates_also_avoid_other_existing_routes():
    main = line(ORIGIN, EAST_600)
    north_alternative = detour_north(0, 600, 90)
    candidates = via_candidates(main, [main, north_alternative])
    assert all(c.side == "right" for c in candidates)


def test_clearance_is_measured_precisely_on_short_trips():
    # A 3 km trip: via points sit 0.9 km away. A road passing 100 m from one must rule it out.
    end = km_east(ORIGIN, 3)
    main = chain(ORIGIN, end, step_km=0.05)
    beside = km_north(km_east(ORIGIN, 1.5), 0.8)  # 100 m short of the left candidate at the middle
    other = chain(ORIGIN, km_north(ORIGIN, 0.8), km_east(km_north(ORIGIN, 0.8), 1.5), beside, km_north(end, 0.8), end)
    candidates = via_candidates(main, [main, other])
    assert not any(c.side == "left" and c.fraction == 0.5 for c in candidates)


def test_via_candidates_work_without_existing_routes():
    main = line(ORIGIN, EAST_600)
    assert len(via_candidates(main, [])) == 6


def test_a_route_of_zero_length_has_no_via_candidates():
    assert via_candidates([ORIGIN, ORIGIN], [[ORIGIN, ORIGIN]]) == []
