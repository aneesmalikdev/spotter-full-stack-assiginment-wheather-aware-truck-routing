"""Route risk summaries and the recommendation order.

The order is the requirements' one (fewest Severe miles, then fewest High miles, then lowest
average risk, then shortest travel time), with fewest No Travel miles first because the
requirements do not place No Travel. Values are compared exactly as the route cards show them
(miles to 0.1, average risk to 0.01, travel time to the second), so the order can always be read
off the cards. Routes without any forecast data come last.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .geo import METERS_PER_MILE
from .risk import RiskLevel


def display_miles(miles: float) -> float:
    """Miles at display precision (0.1). Any non-zero amount shows as at least 0.1, so a short
    stretch of bad weather is never hidden as 0.0."""
    if miles <= 0:
        return 0.0
    return max(round(miles, 1), 0.1)


@dataclass(frozen=True)
class RiskSummary:
    """Miles of a route at each risk level, at display precision."""

    low_mi: float
    moderate_mi: float
    high_mi: float
    severe_mi: float
    no_travel_mi: float
    no_data_mi: float
    average_risk: float | None  # mile-weighted, Low=0 ... No Travel=4, to 0.01; None if no mile has data

    @property
    def unsafe(self) -> bool:
        return self.no_travel_mi > 0

    @property
    def has_data(self) -> bool:
        return self.average_risk is not None


def summarize(levels: Sequence[RiskLevel | None], coverage_m: Sequence[float]) -> RiskSummary:
    """Miles per risk level (each checkpoint counts the road it covers) and the average risk.
    Miles without forecast data are counted separately and left out of the average."""
    if len(levels) != len(coverage_m):
        raise ValueError("need one coverage value per checkpoint")
    miles_by_level = [0.0] * len(RiskLevel)
    no_data = 0.0
    for level, covered in zip(levels, coverage_m):
        if level is None:
            no_data += covered / METERS_PER_MILE
        else:
            miles_by_level[level] += covered / METERS_PER_MILE
    with_data = sum(miles_by_level)
    weighted = sum(level * miles for level, miles in zip(RiskLevel, miles_by_level))
    low, moderate, high, severe, no_travel = (display_miles(m) for m in miles_by_level)
    return RiskSummary(
        low_mi=low,
        moderate_mi=moderate,
        high_mi=high,
        severe_mi=severe,
        no_travel_mi=no_travel,
        no_data_mi=display_miles(no_data),
        average_risk=round(weighted / with_data, 2) if with_data > 0 else None,
    )


@dataclass(frozen=True)
class RouteScore:
    route_id: str
    summary: RiskSummary
    travel_time_s: float


def ranking_key(route: RouteScore) -> tuple[bool, float, float, float, float, int, str]:
    summary = route.summary
    return (
        not summary.has_data,
        summary.no_travel_mi,
        summary.severe_mi,
        summary.high_mi,
        math.inf if summary.average_risk is None else summary.average_risk,
        round(route.travel_time_s),
        route.route_id,  # last resort, so the order never depends on input order
    )


def rank_routes(routes: Iterable[RouteScore]) -> list[RouteScore]:
    return sorted(routes, key=ranking_key)


@dataclass(frozen=True)
class Recommendation:
    route_id: str
    warnings: tuple[str, ...]  # shown with the recommendation; empty when there is nothing to flag


def recommend(routes: Sequence[RouteScore]) -> Recommendation:
    """The best route, with warnings when even the best route is unsafe or partly unforecast."""
    if not routes:
        raise ValueError("no routes to recommend")
    best = rank_routes(routes)[0]
    summary = best.summary
    with_data = sum(1 for route in routes if route.summary.has_data)
    warnings = []
    if not summary.has_data:  # then no route has forecast data
        warnings.append("No forecast is available, so the weather risk is unknown.")
    elif summary.unsafe:  # then every route with forecast data is unsafe
        if len(routes) == 1:
            warnings.append(f"Route {best.route_id} has No Travel conditions. Travel is not advised.")
        elif with_data == 1:
            warnings.append(
                f"Route {best.route_id} has No Travel conditions, and there is no forecast for the other "
                "routes. Travel is not advised."
            )
        else:
            subject = "Every route" if with_data == len(routes) else "Every route with forecast data"
            warnings.append(
                f"{subject} has No Travel conditions. Route {best.route_id} is the least bad option, "
                "but travel is not advised."
            )
    if summary.has_data and summary.no_data_mi > 0:
        warnings.append(
            f"No forecast for {summary.no_data_mi:.1f} mi of Route {best.route_id}; the risk there is unknown."
        )
    return Recommendation(route_id=best.route_id, warnings=tuple(warnings))
