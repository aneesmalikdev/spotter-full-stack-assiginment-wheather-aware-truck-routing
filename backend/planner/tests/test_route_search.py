"""Finding three distinct routes: TomTom's own, then via points within the time budget."""

import pytest

from planner.errors import ServiceError, ServiceTimeout
from planner.logic.geo import haversine_m
from planner.logic.routes import via_candidates
from planner.services.route_search import MAIN_TIMEOUT_S, find_routes
from planner.tests.fakes import (
    DALLAS,
    DENVER,
    DEPARTURE,
    FakeClock,
    StubTomTom,
    km_north,
    place,
    road,
    three_roads,
    tomtom_route,
)

DIRECT, NORTH, SOUTH = (tomtom_route(points) for points in three_roads())
ORIGIN, DESTINATION = place("Dallas, TX", DALLAS), place("Denver, CO", DENVER)


def search(stub: StubTomTom, clock: FakeClock | None = None, origin=ORIGIN, destination=DESTINATION):
    clock = clock if clock is not None else FakeClock()
    return find_routes(stub, origin, destination, DEPARTURE, started=clock(), clock=clock)


def via_calls(stub: StubTomTom) -> list[dict]:
    return [call for call in stub.calls if any(loc.startswith("circle(") for loc in call["locations"])]


def test_three_distinct_tomtom_routes_need_no_via_points():
    stub = StubTomTom([DIRECT, NORTH, SOUTH])
    result = search(stub)
    assert [(o.route_id, o.source) for o in result.options] == [("A", "tomtom"), ("B", "tomtom"), ("C", "tomtom")]
    assert [(call["max_alternatives"], call["avoid"]) for call in stub.calls] == [(2, [])]  # one request
    assert result.warnings == []


def test_a_missing_route_is_added_through_a_via_point():
    stub = StubTomTom([DIRECT, DIRECT, NORTH], via=lambda _: SOUTH)
    result = search(stub)
    assert [(o.route_id, o.source) for o in result.options] == [("A", "tomtom"), ("B", "tomtom"), ("C", "via_point")]
    assert result.options[2].route is SOUTH
    call = via_calls(stub)[0]
    assert call["max_alternatives"] == 0
    assert call["avoid"] == ["alreadyUsedRoads", "borderCrossings"]  # both ends are in the US
    assert result.warnings == []


def test_border_crossings_are_allowed_when_the_trip_crosses_a_border():
    stub = StubTomTom([DIRECT, NORTH], via=lambda _: SOUTH)
    search(stub, destination=place("Monterrey, NL", DENVER, country="MX"))
    assert via_calls(stub)[0]["avoid"] == ["alreadyUsedRoads"]


def test_via_routes_that_copy_an_existing_route_are_not_used():
    stub = StubTomTom([DIRECT, NORTH], via=lambda _: NORTH)
    result = search(stub)
    assert len(result.options) == 2
    assert result.warnings == ["Only 2 distinct routes could be found."]
    candidates = via_candidates(DIRECT.points, [DIRECT.points, NORTH.points])
    assert 0 < len(via_calls(stub)) == len(candidates)  # every via point was tried


def test_failed_via_requests_only_drop_that_via_point():
    answers = iter([ServiceError("no route"), AttributeError("unexpected"), SOUTH])

    def via(_):
        answer = next(answers, SOUTH)
        if isinstance(answer, Exception):
            raise answer
        return answer

    result = search(StubTomTom([DIRECT, NORTH], via=via))
    assert [o.route_id for o in result.options] == ["A", "B", "C"]


def test_via_routes_that_double_back_are_not_used():
    middle = ((DALLAS[0] + DENVER[0]) / 2 - 0.9, (DALLAS[1] + DENVER[1]) / 2 + 0.9)
    with_detour = tomtom_route(road(DALLAS, middle, km_north(middle, 20), middle, DENVER))
    result = search(StubTomTom([DIRECT, NORTH], via=lambda _: with_detour))
    assert len(result.options) == 2


def test_a_slow_via_route_is_used_only_when_nothing_quicker_is_found():
    slow_south = tomtom_route(SOUTH.points, speed_mps=10.0)  # more than 1.5 times the fastest route's time
    result = search(StubTomTom([DIRECT, NORTH], via=lambda _: slow_south))
    assert [o.route_id for o in result.options] == ["A", "B", "C"]
    ratio = slow_south.travel_time_s / DIRECT.travel_time_s
    assert result.warnings == [
        f"Route C takes {ratio:.1f} times as long as the fastest route; no quicker distinct route was found."
    ]


def test_the_via_search_stops_at_the_time_limit():
    clock = FakeClock()
    stub = StubTomTom([DIRECT, NORTH], via=lambda _: NORTH, clock=clock, seconds_per_call=5.0)
    result = search(stub, clock)
    # TomTom answered after 5 s, so the search may run until 12 s later. Its first round only found a
    # copy, and the 2 s left are too few for another.
    assert len(result.options) == 2
    assert [call["timeout_s"] for call in via_calls(stub)] == [11.0, 11.0]
    assert result.warnings == ["Only 2 distinct routes could be found within the time limit."]


def test_a_late_first_answer_still_leaves_time_for_via_routes():
    clock = FakeClock()
    stub = StubTomTom([DIRECT, NORTH], via=lambda _: SOUTH, clock=clock, seconds_per_call=12.0)
    result = search(stub, clock)
    # A long trip: TomTom's first answer comes 12 s after the start, near the 14 s limit, so the via
    # search runs until 12 s after that answer instead.
    assert [o.source for o in result.options] == ["tomtom", "tomtom", "via_point"]
    assert {call["timeout_s"] for call in via_calls(stub)} == {11.0}
    assert result.warnings == []


def test_the_via_search_uses_the_time_left_for_another_round():
    clock = FakeClock()
    answers = iter([NORTH] * 4 + [SOUTH] * 4)  # the first round only finds copies
    stub = StubTomTom([DIRECT], via=lambda _: next(answers), clock=clock, seconds_per_call=1.0)
    result = search(stub, clock)
    assert [o.route_id for o in result.options] == ["A", "B", "C"]
    # A round of four with 13 s left, then the remaining two with 9 s left; each request gets the
    # time left minus a second for checking the routes it returns.
    assert [call["timeout_s"] for call in via_calls(stub)] == [12.0] * 4 + [8.0] * 2


def test_when_alternatives_time_out_tomtom_is_asked_for_one_route_and_via_points_add_the_rest():
    clock = FakeClock()
    answers = iter([NORTH, SOUTH])
    stub = StubTomTom(
        [DIRECT], via=lambda _: next(answers, SOUTH), clock=clock, seconds_per_call=1.0, main_error=ServiceTimeout("slow")
    )
    result = search(stub, clock)
    assert [call["max_alternatives"] for call in stub.calls[:2]] == [2, 0]
    # The timed-out request used up its 15 s and the retry took 1 s more; the via search still gets
    # 12 s after that first answer, so each via request gets 11 s.
    assert stub.calls[0]["timeout_s"] == MAIN_TIMEOUT_S
    assert {call["timeout_s"] for call in via_calls(stub)} == {11.0}
    assert [o.source for o in result.options] == ["tomtom", "via_point", "via_point"]
    assert result.warnings == ["TomTom could not compute alternative routes in time."]


def test_via_circles_sit_150_km_beside_the_fastest_route():
    stub = StubTomTom([DIRECT, NORTH], via=lambda _: SOUTH)
    search(stub)
    circle = next(loc for loc in via_calls(stub)[0]["locations"] if loc.startswith("circle("))
    lat, lon, radius = (float(v) for v in circle[len("circle(") : -1].split(","))
    # The direct road is about 1,100 km long: 15 % of that is capped at 150 km, the radius is a third.
    assert min(haversine_m((lat, lon), p) for p in DIRECT.points) == pytest.approx(150_000, rel=0.02)
    assert radius == 50_000
