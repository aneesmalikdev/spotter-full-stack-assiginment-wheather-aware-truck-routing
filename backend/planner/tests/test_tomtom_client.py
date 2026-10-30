"""TomTom client: request format, response parsing and error mapping (HTTP is faked with `responses`)."""

import re
import traceback
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
import requests
import responses

from planner.clients.tomtom import TomTomClient, circle, location, starts_with_typed
from planner.errors import InvalidInput, NoRoute, ServiceBusy, ServiceError, ServiceTimeout
from planner.tests.fakes import DALLAS, DENVER, geocode_json, road, route_json, search_json

ROUTE_URL = re.compile(r"https://api\.tomtom\.com/routing/1/calculateRoute/.*")
GEOCODE_URL = re.compile(r"https://api\.tomtom\.com/search/2/geocode/.*")
SEARCH_URL = re.compile(r"https://api\.tomtom\.com/search/2/search/.*")
LOCATIONS = [location(DALLAS), location(DENVER)]


def client() -> TomTomClient:
    return TomTomClient("test-key", pause_s=0)


def names(places) -> list[str]:
    return [place.name for place in places]


def future() -> datetime:
    return (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)


@responses.activate
def test_geocode_encodes_the_place_name_and_returns_the_best_match():
    responses.get(GEOCODE_URL, json=geocode_json("Saint Louis, MO", (38.6354, -90.2010)))
    result = client().geocode("St. Louis, MO", "origin")
    assert (result.name, result.position, result.country_code) == ("Saint Louis, MO", (38.6354, -90.2010), "US")
    request = responses.calls[0].request
    assert urlsplit(str(request.url)).path == "/search/2/geocode/St.%20Louis%2C%20MO.json"
    assert parse_qs(urlsplit(str(request.url)).query) == {"key": ["test-key"], "limit": ["1"], "countrySet": ["US,CA,MX"]}


@responses.activate
def test_typed_places_are_looked_up_only_in_the_us_canada_and_mexico():
    # Searched worldwide, the Dallas ZIP code 75201 matched Ras Al Khaimah in the UAE.
    responses.get(GEOCODE_URL, json=geocode_json("Dallas, TX 75201", (32.7876, -96.7994)))
    assert client().geocode("75201", "origin").name == "Dallas, TX 75201"
    query = parse_qs(urlsplit(str(responses.calls[0].request.url)).query)
    assert query["countrySet"] == ["US,CA,MX"]  # the same countries as the city suggestions


@pytest.mark.parametrize(
    ("freeform", "country", "code", "expected"),
    [
        ("Paris ON", "Canada", "CA", "Paris, ON, Canada"),  # not Paris, TX
        ("Monterrey, NL", "Mexico", "MX", "Monterrey, NL, Mexico"),
        ("Mexico City, CDMX", "Mexico", "MX", "Mexico City, CDMX"),  # the country is already in the name
        ("Toronto ON", "Canada", "CA", "Toronto, ON, Canada"),  # a comma before the province, as before a state
        ("Dallas, TX", "United States", "US", "Dallas, TX"),
    ],
)
@responses.activate
def test_places_outside_the_us_are_named_with_their_country(freeform, country, code, expected):
    responses.get(GEOCODE_URL, json=geocode_json(freeform, (48.85, 2.35), country=code, country_name=country))
    result = client().geocode(freeform, "origin")
    assert (result.name, result.country_code) == (expected, code)


@responses.activate
def test_an_unknown_place_is_an_input_error_on_its_field():
    responses.get(GEOCODE_URL, json={"summary": {"numResults": 0}, "results": []})
    with pytest.raises(InvalidInput) as error:
        client().geocode("qwxzzy plorb", "destination")
    assert error.value.fields == {"destination": 'Couldn\'t find "qwxzzy plorb" in the US, Canada or Mexico. Try adding a state or province.'}


@responses.activate
def test_route_request_asks_for_a_commercial_truck_route_with_timing_data():
    responses.get(ROUTE_URL, json={"routes": [route_json(road(DALLAS, DENVER))]})
    departure = future()
    client().calculate_route(
        [*LOCATIONS[:1], circle((36.0, -100.0), 30000), *LOCATIONS[1:]],
        departure,
        max_alternatives=0,
        timeout_s=5,
        avoid=["alreadyUsedRoads", "borderCrossings"],
    )
    url = urlsplit(str(responses.calls[0].request.url))
    assert url.path == (
        "/routing/1/calculateRoute/32.778000,-96.796200:circle(36.000000,-100.000000,30000):39.738500,-104.984900/json"
    )
    query = parse_qs(url.query)
    assert query["travelMode"] == ["truck"]
    assert query["vehicleCommercial"] == ["true"]
    assert query["vehicleMaxSpeed"] == ["109"]  # km/h: a truck speed-limited at 68 mph
    assert query["departAt"] == [departure.strftime("%Y-%m-%dT%H:%M:%SZ")]
    assert query["maxAlternatives"] == ["0"]
    assert query["extendedRouteRepresentation"] == ["distance", "travelTime"]
    assert query["avoid"] == ["alreadyUsedRoads", "borderCrossings"]


@responses.activate
def test_a_departure_now_or_in_the_past_is_sent_as_now():
    responses.get(ROUTE_URL, json={"routes": [route_json(road(DALLAS, DENVER))]})
    client().calculate_route(LOCATIONS, datetime.now(UTC) - timedelta(minutes=30), 0, timeout_s=5)
    assert parse_qs(urlsplit(str(responses.calls[0].request.url)).query)["departAt"] == ["now"]


@responses.activate
def test_routes_are_parsed_with_their_legs_joined_and_their_progress():
    points = road(DALLAS, DENVER, step_km=20)
    body = {"routes": [route_json(points), route_json(points[::-1])]}
    responses.get(ROUTE_URL, json=body)
    routes = client().calculate_route(LOCATIONS, future(), max_alternatives=2, timeout_s=5)
    assert len(routes) == 2
    first = routes[0]
    assert len(first.points) == len(points) + 1  # the junction point appears in both legs
    assert first.track.progress[0].point_index == 0
    assert first.track.progress[-1].point_index == len(first.points) - 1
    assert first.length_m == body["routes"][0]["summary"]["lengthInMeters"]
    assert first.travel_time_s == body["routes"][0]["summary"]["travelTimeInSeconds"]


@pytest.mark.parametrize(
    ("status", "body", "expected", "code"),
    [
        (400, {"detailedError": {"code": "BAD_INPUT", "message": "Engine error: MAP_MATCHING_FAILURE: Origin (1, 2)"}}, NoRoute, "MAP_MATCHING_FAILURE"),
        (400, {"detailedError": {"code": "NO_ROUTE_FOUND", "message": "No route found."}}, NoRoute, "NO_ROUTE_FOUND"),
        (400, {"detailedError": {"code": "BAD_INPUT", "message": "Invalid value"}}, ServiceError, None),
        (401, {"detailedError": {"code": "Unauthorized", "message": "You are missing valid authentication"}}, ServiceError, None),
        (403, {"detailedError": {"code": "Forbidden", "message": "Forbidden"}}, ServiceError, None),
        (429, {"detailedError": {"code": "TooManyRequests", "message": "QPS"}}, ServiceBusy, None),
        (500, {"detailedError": {"code": "", "message": "STOPPED: COMPUTE_TIME_LIMIT_EXCEEDED"}}, ServiceTimeout, None),
        (503, {"detailedError": {"code": "", "message": "Unavailable"}}, ServiceError, None),
    ],
)
@responses.activate
def test_route_errors_are_mapped(status, body, expected, code):
    responses.get(ROUTE_URL, json=body, status=status)
    with pytest.raises(expected) as error:
        client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)
    if code:
        assert error.value.code == code


@responses.activate
def test_hitting_the_per_second_limit_once_is_retried():
    responses.get(ROUTE_URL, json={"detailedError": {"code": "TooManyRequests"}}, status=429)
    responses.get(ROUTE_URL, json={"routes": [route_json(road(DALLAS, DENVER))]})
    assert len(client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)) == 1
    assert len(responses.calls) == 2


@responses.activate
def test_the_rate_limit_retry_is_skipped_when_too_little_time_is_left():
    responses.get(ROUTE_URL, json={"detailedError": {"code": "TooManyRequests"}}, status=429)
    with pytest.raises(ServiceBusy):
        TomTomClient("test-key", pause_s=0.5).calculate_route(LOCATIONS, future(), 0, timeout_s=1.2)
    assert len(responses.calls) == 1  # 1.2 s minus the 0.5 s pause leaves under a second for a retry


@responses.activate
def test_the_rate_limit_retry_only_gets_the_time_that_is_left():
    responses.get(ROUTE_URL, json={"detailedError": {"code": "TooManyRequests"}}, status=429)
    responses.get(ROUTE_URL, json={"routes": [route_json(road(DALLAS, DENVER))]})
    client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)
    first, retry = (call.request.req_kwargs["timeout"] for call in responses.calls)  # type: ignore[attr-defined]
    assert first == 5
    assert 4 < retry < 5


@pytest.mark.parametrize("body", ["<html>Service Unavailable</html>", '"Bad Gateway"', "null", "[]", ""])
@responses.activate
def test_error_bodies_that_are_not_json_objects_are_handled(body):
    responses.get(ROUTE_URL, body=body, status=502, content_type="application/json")
    with pytest.raises(ServiceError, match=r"routing service failed \(HTTP 502\)"):
        client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)


@pytest.mark.parametrize(
    ("status", "expected", "message"),
    [
        (403, ServiceError, "TomTom refused the place search request: the server's API key is invalid or its quota is used up."),
        (429, ServiceBusy, "The place search service is busy"),
        (504, ServiceTimeout, "The place search service took too long to answer."),
    ],
)
@responses.activate
def test_place_search_errors_are_mapped_and_name_the_place_search(status, expected, message):
    responses.get(GEOCODE_URL, body="<h1>Developer Inactive</h1>", status=status, content_type="text/xml")
    with pytest.raises(expected) as error:
        client().geocode("Dallas, TX", "origin")
    assert error.value.message.startswith(message)


@pytest.mark.parametrize(
    "body",
    [
        "<html>not json</html>",
        '{"results": [{"address": {"freeformAddress": "Dallas, TX"}}]}',  # no position
        '{"results": [null]}',
        '{"results": [{"position": {"lat": "north", "lon": 1}}]}',
        "[]",
    ],
)
@responses.activate
def test_an_unusable_place_search_answer_is_a_service_error(body):
    responses.get(GEOCODE_URL, body=body, content_type="application/json")
    with pytest.raises(ServiceError, match="place search service returned an unusable answer"):
        client().geocode("Dallas, TX", "origin")


@responses.activate
def test_a_place_search_timeout_is_a_service_timeout():
    responses.get(GEOCODE_URL, body=requests.Timeout("too slow"))
    with pytest.raises(ServiceTimeout):
        client().geocode("Dallas, TX", "origin")


@pytest.mark.parametrize("failure", [requests.ConnectTimeout, requests.ConnectionError])
@responses.activate
def test_errors_never_carry_the_api_key_into_tracebacks(failure):
    # requests puts the whole URL, key included, into its exception messages.
    leak = failure("Max retries exceeded with url: /routing/1/calculateRoute/x/json?key=test-key&travelMode=truck")
    responses.get(ROUTE_URL, body=leak)
    responses.get(GEOCODE_URL, body=leak)
    for call in (
        lambda: client().calculate_route(LOCATIONS, future(), 0, timeout_s=5),
        lambda: client().geocode("Dallas, TX", "origin"),
    ):
        with pytest.raises(ServiceError) as error:
            call()
        assert error.value.__cause__ is None
        assert "test-key" not in "".join(traceback.format_exception(error.value))


@responses.activate
def test_a_timeout_is_a_service_timeout_and_a_lost_connection_a_service_error():
    responses.get(ROUTE_URL, body=requests.Timeout("too slow"))
    with pytest.raises(ServiceTimeout):
        client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)
    responses.replace(responses.GET, ROUTE_URL, body=requests.ConnectionError("gone"))
    with pytest.raises(ServiceError):
        client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)


@responses.activate
def test_a_route_without_timing_data_is_a_service_error():
    route = route_json(road(DALLAS, DENVER))
    del route["progress"]
    responses.get(ROUTE_URL, json={"routes": [route]})
    with pytest.raises(ServiceError):
        client().calculate_route(LOCATIONS, future(), 0, timeout_s=5)


@responses.activate
def test_suggestions_ask_for_north_american_cities_while_the_name_is_typed():
    responses.get(SEARCH_URL, json=search_json("Denver, CO", "Denton, TX"))
    assert names(client().suggest_places("Den")) == ["Denver, CO", "Denton, TX"]
    request = responses.calls[0].request
    assert urlsplit(str(request.url)).path == "/search/2/search/Den.json"
    assert parse_qs(urlsplit(str(request.url)).query) == {
        "key": ["test-key"],
        "typeahead": ["true"],  # the last word may be unfinished
        "limit": ["10"],
        "idxSet": ["Geo"],
        "entityTypeSet": ["Municipality"],
        "countrySet": ["US,CA,MX"],
        "language": ["en-US"],
    }


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("Chicago, IL", ["Chicago, IL"]),  # the whole name typed: one suggestion
        ("Chicago", ["Chicago, IL", "Chicago Heights, IL"]),
        ("chicago heights", ["Chicago Heights, IL"]),
    ],
)
@responses.activate
def test_suggestions_start_with_what_was_typed(typed, expected):
    responses.get(SEARCH_URL, json=search_json("Chicago, IL", "West Chicago, IL", "Chicago Heights, IL"))
    assert names(client().suggest_places(typed)) == expected


@responses.activate
def test_suggestions_are_named_like_geocoded_places_without_repeats_and_at_most_five():
    responses.get(
        SEARCH_URL,
        json=search_json(
            ("Toronto ON", "CA", "Canada"),
            "Toronto, KS",
            "Toronto, KS",
            "Toronto, OH",
            "Toronto, IA",
            "Toronto, SD",
            "Toronto, MO",
        ),
    )
    assert names(client().suggest_places("Toronto")) == ["Toronto, ON, Canada", "Toronto, KS", "Toronto, OH", "Toronto, IA", "Toronto, SD"]


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("Denver, Colorado", ["Denver, CO"]),  # the state in full
        ("Denver, Col", ["Denver, CO"]),
        ("Toronto, Ontario", ["Toronto, ON, Canada"]),
        ("Toronto, Canada", ["Toronto, ON, Canada"]),  # the country without the province
        ("Toronto, ON", ["Toronto, ON, Canada"]),
    ],
)
@responses.activate
def test_suggestions_follow_the_state_or_province_written_in_full(typed, expected):
    responses.get(
        SEARCH_URL,
        json=search_json(("Denver, CO", "US", "United States", "Colorado"), ("Toronto ON", "CA", "Canada", "Ontario"), "Denver, NC"),
    )
    assert names(client().suggest_places(typed)) == expected


@responses.activate
def test_each_suggestion_carries_its_other_spellings():
    responses.get(SEARCH_URL, json=search_json(("Toronto ON", "CA", "Canada", "Ontario"), ("Toronto, OH", "US", "United States", "Ohio")))
    places = client().suggest_places("Toronto")
    assert [(place.name, place.also) for place in places] == [
        ("Toronto, ON, Canada", ("Toronto, Ontario, Canada", "Toronto, Canada")),
        ("Toronto, OH", ("Toronto, Ohio",)),
    ]


@pytest.mark.parametrize(
    ("name", "typed", "expected"),
    [
        ("Saint Louis, MO", "St. Lo", True),  # abbreviations read as words
        ("Fort Worth, TX", "ft worth", True),
        ("Mount Vernon, WA", "Mt. V", True),
        ("Sterling, CO", "St", True),  # an unfinished last word counts as typed too
        ("Saint Paul, MN", "St", True),
        ("Bay Saint Louis, MS", "St. Lo", False),
        ("Montréal, QC, Canada", "montreal", True),  # accents and case don't matter
        ("Coeur d'Alene, ID", "Coeur d Al", True),  # nor punctuation
        ("Denver, NC", "Denver, CO", False),
        ("Denver, CO", "", False),
        ("Denver, CO", "Denver, C", True),  # a typed comma ends the city's name
        ("Denver City, TX", "Denver, C", False),
        ("Denver City, TX", "Denver,", False),
        ("Chicago, IL", "Chicago IL", True),  # without a comma, punctuation still doesn't matter
        ("Toronto, ON, Canada", "Toronto, ON", True),
        ("Saint Louis, MO", "St. Louis, M", True),
        ("Denver, CO", "Denver, CO, US", False),
        ("Washington, DC", "Washington, D.C.", True),  # dotted initials
        ("O'Fallon, MO", "O\u2019Fal", True),  # a curly apostrophe, as phones type it
        ("O'Fallon, MO", "OFal", True),
        ("Billings, MT", "Billings, MO", False),  # MT is Montana here, not "Mount"
        ("Billings, MT", "Billings MO", False),
        ("Helena, MT", "Helena MT", True),
    ],
)
def test_a_name_starts_with_what_was_typed(name, typed, expected):
    assert starts_with_typed(name, typed) is expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [(403, ServiceError), (429, ServiceBusy), (500, ServiceError), (504, ServiceTimeout)],
)
@responses.activate
def test_suggestion_failures_are_mapped_and_never_retried(status, expected):
    responses.get(SEARCH_URL, body="<h1>Developer Inactive</h1>", status=status, content_type="text/xml")
    with pytest.raises(expected):
        client().suggest_places("Denv")
    assert len(responses.calls) == 1  # the user has typed on by the time a retry could answer


@pytest.mark.parametrize("body", ["<html>not json</html>", '{"results": [null]}', "[]"])
@responses.activate
def test_an_unusable_suggestion_answer_is_a_service_error(body):
    responses.get(SEARCH_URL, body=body, content_type="application/json")
    with pytest.raises(ServiceError, match="place search service returned an unusable answer"):
        client().suggest_places("Denv")


@responses.activate
def test_a_slow_suggestion_answer_is_a_service_timeout():
    responses.get(SEARCH_URL, body=requests.Timeout("too slow"))
    with pytest.raises(ServiceTimeout):
        client().suggest_places("Denv")
