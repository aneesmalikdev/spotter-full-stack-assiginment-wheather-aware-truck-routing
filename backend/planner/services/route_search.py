"""Up to three distinct truck routes: TomTom's own, plus routes through via points beside the fastest
route when TomTom returns fewer than three (README "Assumptions" 12-15).

The via-point search has a time budget: it may run until 14 seconds after the plan request started,
or until 12 seconds after TomTom's first answer, whichever is later. Long trips need the second: coast
to coast, TomTom takes 10 to 17 seconds to answer with alternatives and about 5 seconds per via
request. When time runs out it returns fewer routes, with a warning.
"""

import logging
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime

from planner.clients.tomtom import Place, RoutingService, TomTomRoute, circle, location
from planner.errors import PlanError, ServiceError, ServiceTimeout
from planner.logic.routes import RouteShape, ViaCandidate, has_backtrack, is_distinct, via_candidates

logger = logging.getLogger(__name__)

TARGET_ROUTES = 3
ROUTE_IDS = "ABC"
MAIN_TIMEOUT_S = 15.0  # coast to coast TomTom took 10-17 s, once timing out (a timeout counts the wait for each read)
MAIN_RETRY_TIMEOUT_S = 6.0  # without alternatives TomTom answers in 1.5-5 s
VIA_DEADLINE_S = 14.0  # measured from the start of the plan request
VIA_TIME_AFTER_FIRST_ANSWER_S = 12.0  # two rounds of via requests on long trips, where each takes about 5 s
MIN_ROUND_S = 3.0  # a via request takes 1.5-4 s, about 5 s coast to coast
EVALUATION_RESERVE_S = 1.0  # time kept back from each round to check the routes it returns
MAX_ROUND_SIZE = 4  # TomTom's free tier allows 5 requests a second
PREFERRED_TIME_RATIO = 1.5  # slower via routes are used only when nothing quicker is found


@dataclass
class RouteOption:
    route_id: str
    source: str  # "tomtom" or "via_point"
    route: TomTomRoute
    shape: RouteShape


@dataclass
class RouteSearch:
    options: list[RouteOption]
    warnings: list[str]


def find_routes(
    client: RoutingService,
    origin: Place,
    destination: Place,
    departure: datetime,
    started: float,
    clock: Callable[[], float] = time.monotonic,
) -> RouteSearch:
    """`started` is the `clock()` reading when the plan request started."""
    ends = [location(origin.position), location(destination.position)]
    warnings = []
    try:
        routes = client.calculate_route(ends, departure, max_alternatives=2, timeout_s=MAIN_TIMEOUT_S)
    except ServiceTimeout:
        warnings.append("TomTom could not compute alternative routes in time.")
        routes = client.calculate_route(ends, departure, max_alternatives=0, timeout_s=MAIN_RETRY_TIMEOUT_S)
    # A long trip's first answer can come after the 14 s; its via search then still gets two rounds.
    deadline = max(started + VIA_DEADLINE_S, clock() + VIA_TIME_AFTER_FIRST_ANSWER_S)
    if not routes:
        raise ServiceError("The routing service returned no route.")

    options: list[RouteOption] = []
    for route in routes:  # best first
        shape = RouteShape(route.points)
        if len(options) < TARGET_ROUTES and is_distinct(shape, [o.shape for o in options]):
            options.append(RouteOption(ROUTE_IDS[len(options)], "tomtom", route, shape))
    if len(options) < TARGET_ROUTES:
        warnings += _add_via_routes(client, options, origin, destination, departure, deadline, clock)
    return RouteSearch(options, warnings)


def _add_via_routes(
    client: RoutingService,
    options: list[RouteOption],
    origin: Place,
    destination: Place,
    departure: datetime,
    deadline: float,
    clock: Callable[[], float],
) -> list[str]:
    """Adds routes through via points to `options` until there are three; returns warnings."""
    fastest = options[0]
    candidates = via_candidates(fastest.route.points, [o.route.points for o in options])
    avoid = ["alreadyUsedRoads"]  # TomTom then avoids out-and-back detours to reach a via point
    if origin.country_code and origin.country_code == destination.country_code:
        avoid.append("borderCrossings")
    slow: list[RouteOption] = []  # distinct, but more than 1.5 times the fastest route's travel time
    out_of_time = False
    tried = 0
    while len(options) < TARGET_ROUTES and tried < len(candidates):
        remaining = deadline - clock()
        if remaining < MIN_ROUND_S:
            out_of_time = True
            break
        batch = candidates[tried : tried + min(MAX_ROUND_SIZE, 2 * (TARGET_ROUTES - len(options)))]
        tried += len(batch)
        timeout_s = remaining - EVALUATION_RESERVE_S
        for route in _routes_through(client, batch, origin, destination, departure, timeout_s, avoid):
            if route is None or has_backtrack(route.points):
                continue
            option = RouteOption("", "via_point", route, RouteShape(route.points))
            quick = route.travel_time_s <= PREFERRED_TIME_RATIO * fastest.route.travel_time_s
            if quick and len(options) < TARGET_ROUTES and is_distinct(option.shape, [o.shape for o in options]):
                option.route_id = ROUTE_IDS[len(options)]
                options.append(option)
            elif not quick and is_distinct(option.shape, [o.shape for o in options + slow]):
                slow.append(option)

    warnings = []
    for option in sorted(slow, key=lambda o: o.route.travel_time_s):
        if len(options) < TARGET_ROUTES and is_distinct(option.shape, [o.shape for o in options]):
            option.route_id = ROUTE_IDS[len(options)]
            options.append(option)
            ratio = option.route.travel_time_s / fastest.route.travel_time_s
            warnings.append(
                f"Route {option.route_id} takes {ratio:.1f} times as long as the fastest route; "
                "no quicker distinct route was found."
            )
    if len(options) < TARGET_ROUTES:
        found = f"Only {len(options)} distinct route{'s' if len(options) > 1 else ''} could be found"
        warnings.append(f"{found} within the time limit." if out_of_time else f"{found}.")
    return warnings


def _routes_through(
    client: RoutingService,
    candidates: Sequence[ViaCandidate],
    origin: Place,
    destination: Place,
    departure: datetime,
    timeout_s: float,
    avoid: Sequence[str],
) -> list[TomTomRoute | None]:
    """One route per via point, requested in parallel; None where TomTom failed."""

    def route_through(candidate: ViaCandidate) -> TomTomRoute | None:
        locations = [
            location(origin.position),
            circle(candidate.position, candidate.radius_m),
            location(destination.position),
        ]
        try:
            routes = client.calculate_route(locations, departure, 0, timeout_s=timeout_s, avoid=avoid)
        except PlanError as error:
            logger.info("No route through via point %s: %s", candidate.position, error.message)
            return None
        except Exception:  # one broken via point must not fail the whole plan
            logger.exception("Route through via point %s failed", candidate.position)
            return None
        return routes[0] if routes else None

    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        return list(pool.map(route_through, candidates))
