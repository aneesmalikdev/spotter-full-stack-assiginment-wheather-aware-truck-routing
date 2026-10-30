"""Route summaries and the recommendation order (README "Assumptions" 9-11)."""

from itertools import permutations

import pytest

from planner.logic.geo import METERS_PER_MILE
from planner.logic.ranking import RouteScore, rank_routes, recommend, summarize
from planner.logic.risk import RiskLevel

MI = METERS_PER_MILE
LOW, MODERATE, HIGH, SEVERE, NO_TRAVEL = list(RiskLevel)


def route(route_id: str, stretches: list[tuple[RiskLevel | None, float]], hours: float = 10.0) -> RouteScore:
    """A route made of (risk level or None, miles) stretches, as its checkpoints would cover it."""
    levels = [level for level, _ in stretches]
    coverage = [miles * MI for _, miles in stretches]
    return RouteScore(route_id=route_id, summary=summarize(levels, coverage), travel_time_s=hours * 3600)


def ids(routes):
    return [r.route_id for r in routes]


def test_summary_counts_miles_per_level_and_a_mile_weighted_average():
    summary = route("A", [(LOW, 10), (MODERATE, 20), (HIGH, 10), (None, 5), (SEVERE, 5)]).summary
    assert (summary.low_mi, summary.moderate_mi, summary.high_mi, summary.severe_mi) == (10.0, 20.0, 10.0, 5.0)
    assert (summary.no_travel_mi, summary.no_data_mi) == (0.0, 5.0)
    # (0*10 + 1*20 + 2*10 + 3*5) / 45 miles with data; the 5 miles without data are left out.
    assert summary.average_risk == 1.22
    assert summary.has_data and not summary.unsafe


def test_any_no_travel_makes_a_route_unsafe_even_when_it_rounds_to_zero():
    summary = route("A", [(LOW, 100), (NO_TRAVEL, 0.02)]).summary
    assert summary.no_travel_mi == 0.1  # never shown as 0.0
    assert summary.unsafe


def test_average_is_unknown_when_no_mile_has_data():
    summary = route("A", [(None, 5), (None, 5)]).summary
    assert summary.average_risk is None and not summary.has_data
    assert summary.no_data_mi == 10.0


def test_summaries_need_one_coverage_per_level():
    with pytest.raises(ValueError):
        summarize([LOW], [1.0, 2.0])


def test_fewest_no_travel_miles_comes_first():
    a = route("A", [(LOW, 100), (NO_TRAVEL, 5)])
    b = route("B", [(LOW, 50), (SEVERE, 50), (HIGH, 80)])
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_then_fewest_severe_miles():
    a = route("A", [(LOW, 100), (SEVERE, 12)])
    b = route("B", [(LOW, 10), (SEVERE, 3), (HIGH, 90)])
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_then_fewest_high_miles():
    a = route("A", [(LOW, 100), (HIGH, 40)])
    b = route("B", [(MODERATE, 10), (HIGH, 20), (SEVERE, 0)])
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_then_lowest_average_risk():
    a = route("A", [(LOW, 50), (MODERATE, 50)], hours=9)
    b = route("B", [(LOW, 80), (MODERATE, 20)], hours=12)
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_then_shortest_travel_time():
    a = route("A", [(LOW, 100)], hours=12.5)
    b = route("B", [(LOW, 100)], hours=11.0)
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_severe_miles_that_show_the_same_on_the_cards_tie():
    # 12.34 and 12.26 Severe miles both show as 12.3, so High miles decide.
    a = route("A", [(LOW, 100), (SEVERE, 12.26), (HIGH, 5)])
    b = route("B", [(LOW, 100), (SEVERE, 12.34), (HIGH, 1)])
    assert (a.summary.severe_mi, b.summary.severe_mi) == (12.3, 12.3)
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_averages_that_show_the_same_on_the_cards_tie():
    # 0.496 and 0.504 both show as 0.50, so travel time decides.
    a = route("A", [(LOW, 50.4), (MODERATE, 49.6)], hours=12)
    b = route("B", [(LOW, 49.6), (MODERATE, 50.4)], hours=11)
    assert a.summary.average_risk == b.summary.average_risk == 0.5
    assert ids(rank_routes([a, b])) == ["B", "A"]


def test_a_short_stretch_of_severe_or_high_still_counts():
    # 0.03 miles shows as 0.1, so the clean route wins even though it is slower.
    clean = route("A", [(LOW, 100.03)], hours=11)
    severe = route("B", [(LOW, 100), (SEVERE, 0.03)], hours=10)
    high = route("C", [(LOW, 100), (HIGH, 0.03)], hours=10)
    assert severe.summary.severe_mi == 0.1 and high.summary.high_mi == 0.1
    assert ids(rank_routes([severe, high, clean])) == ["A", "C", "B"]


def test_travel_time_is_compared_to_the_second():
    a = route("A", [(LOW, 100)], hours=36000.4 / 3600)
    b = route("B", [(LOW, 100)], hours=36000.2 / 3600)
    assert ids(rank_routes([b, a])) == ["A", "B"]  # both 36,000 s, so the route letter decides


def test_a_route_without_any_forecast_ranks_after_routes_with_data():
    unknown = route("A", [(None, 200)], hours=4)
    with_high = route("B", [(LOW, 199), (HIGH, 1)], hours=5)
    unsafe = route("C", [(LOW, 100), (NO_TRAVEL, 10)], hours=5)
    assert ids(rank_routes([unknown, with_high, unsafe])) == ["B", "C", "A"]


def test_order_does_not_depend_on_input_order():
    routes = [
        route("A", [(LOW, 50), (MODERATE, 50)], hours=12),
        route("B", [(LOW, 50), (MODERATE, 50)], hours=11),
        route("C", [(LOW, 51), (MODERATE, 49)], hours=13),
    ]
    orders = {tuple(ids(rank_routes(list(p)))) for p in permutations(routes)}
    assert orders == {("C", "B", "A")}


def test_recommendation_without_warnings_when_the_best_route_is_safe_and_forecast():
    result = recommend([route("A", [(LOW, 90), (NO_TRAVEL, 3)]), route("B", [(LOW, 90), (SEVERE, 7)])])
    assert result.route_id == "B"
    assert result.warnings == ()


def test_when_every_route_has_no_travel_miles_the_least_bad_is_recommended_with_a_warning():
    routes = [route(name, [(LOW, 100), (NO_TRAVEL, miles)]) for name, miles in (("A", 30), ("B", 4), ("C", 9))]
    result = recommend(routes)
    assert result.route_id == "B"
    assert result.warnings == (
        "Every route has No Travel conditions. Route B is the least bad option, but travel is not advised.",
    )


def test_a_single_unsafe_route_gets_its_own_warning():
    result = recommend([route("A", [(LOW, 100), (NO_TRAVEL, 5)])])
    assert result.warnings == ("Route A has No Travel conditions. Travel is not advised.",)


def test_missing_forecast_miles_on_the_recommended_route_are_flagged():
    result = recommend([route("A", [(LOW, 400), (None, 187.5)]), route("B", [(LOW, 500), (NO_TRAVEL, 20)])])
    assert result.route_id == "A"
    assert result.warnings == ("No forecast for 187.5 mi of Route A; the risk there is unknown.",)


def test_no_forecast_for_any_route_is_flagged():
    result = recommend([route("A", [(None, 100)], hours=3), route("B", [(None, 100)], hours=2)])
    assert result.route_id == "B"
    assert result.warnings == ("No forecast is available, so the weather risk is unknown.",)
    assert recommend([route("A", [(None, 100)])]).warnings == result.warnings


def test_an_unsafe_route_that_is_the_only_one_with_a_forecast_says_so():
    result = recommend([route("A", [(LOW, 100), (NO_TRAVEL, 5)]), route("B", [(None, 100)])])
    assert result.route_id == "A"
    assert result.warnings == (
        "Route A has No Travel conditions, and there is no forecast for the other routes. Travel is not advised.",
    )


def test_unsafe_warning_is_limited_to_routes_with_a_forecast():
    routes = [route("A", [(LOW, 100), (NO_TRAVEL, 5)]), route("B", [(LOW, 100), (NO_TRAVEL, 9)]), route("C", [(None, 100)])]
    assert recommend(routes).warnings == (
        "Every route with forecast data has No Travel conditions. Route A is the least bad option, "
        "but travel is not advised.",
    )
