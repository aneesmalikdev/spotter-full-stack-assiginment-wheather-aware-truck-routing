"""POST /api/plan/: input validation, error responses, and one full request with faked HTTP."""

import gzip
import json
import re
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
import responses
from rest_framework.test import APIClient

from planner import views
from planner.errors import InvalidInput, NoRoute, ServiceBusy, ServiceError, ServiceTimeout
from planner.tests.fakes import DALLAS, DENVER, answer_open_meteo, geocode_json, route_json, search_json, three_roads

URL = "/api/plan/"


def departure(**delta) -> str:
    return (datetime.now(UTC) + timedelta(**(delta or {"days": 1}))).isoformat()


def valid(**changes) -> dict:
    body = {
        "origin": "Dallas, TX",
        "destination": "Denver, CO",
        "departure": departure(),
        "load_lb": 35000,
        "interval_miles": 25,
    }
    body.update(changes)
    return body


def post(body: dict, **headers) -> Any:  # the test client's response; DRF has no type hints
    return APIClient().post(URL, body, format="json", **headers)


@pytest.fixture
def planned(monkeypatch):
    """Replaces the planning itself; records what the view passed to it."""
    calls = []

    def fake_plan_trip(request, tomtom, weather):
        calls.append(request)
        return {"routes": [], "padding": "x" * 1000}

    monkeypatch.setattr(views, "plan_trip", fake_plan_trip)
    return calls


def test_a_valid_request_is_planned_with_a_utc_departure(planned):
    local = datetime.now(timezone(timedelta(hours=-5))).replace(microsecond=0) + timedelta(days=2)
    response = post(valid(departure=local.isoformat(), load_lb="35000.5", interval_miles="10"))
    assert response.status_code == 200
    request = planned[0]
    assert request.departure == local and request.departure.tzinfo == UTC
    assert (request.origin, request.destination) == ("Dallas, TX", "Denver, CO")
    assert (request.load_lb, request.interval_miles) == (35000.5, 10)


def test_the_interval_defaults_to_25_miles(planned):
    body = valid()
    del body["interval_miles"]
    assert post(body).status_code == 200
    assert planned[0].interval_miles == 25


@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"origin": ""}, "origin", "Enter where the trip starts."),
        ({"destination": "D"}, "destination", "Enter at least 2 characters."),
        ({"departure": "tomorrow"}, "departure", "Enter the departure as a date and time"),
        ({"departure": "2026-13-01T00:00:00Z"}, "departure", "Enter the departure as a date and time"),
        ({"departure": "2026-10-25T14:00"}, "departure", "The departure time needs a time zone offset"),
        ({"departure": departure(hours=-2)}, "departure", "The departure time is in the past."),
        ({"departure": departure(days=13, minutes=1)}, "departure", "Choose a departure within the next 13 days"),
        # The offset moves these past the end of the calendar, so they can't be converted to UTC.
        ({"departure": "9999-12-31T23:59:59-00:01"}, "departure", "Choose a departure within the next 13 days"),
        ({"departure": "0001-01-01T00:00:00+00:01"}, "departure", "The departure time is in the past."),
        ({"load_lb": -1}, "load_lb", "The load weight can't be negative."),
        ({"load_lb": 200_001}, "load_lb", "The load weight must be at most 200,000 lb."),
        ({"load_lb": "heavy"}, "load_lb", "Enter the load weight in pounds."),
        ({"load_lb": True}, "load_lb", "Enter the load weight in pounds."),
        ({"interval_miles": 30}, "interval_miles", "Choose a checkpoint interval of 10, 25 or 50 miles."),
    ],
)
def test_invalid_input_is_reported_per_field(planned, changes, field, message):
    response = post(valid(**changes))
    assert response.status_code == 400
    assert response.json()["error"] == "Please correct the highlighted fields."
    assert response.json()["fields"][field][0].startswith(message)
    assert planned == []


def test_a_departure_up_to_an_hour_ago_is_accepted(planned):
    assert post(valid(departure=departure(minutes=-50))).status_code == 200


def test_a_departure_up_to_13_days_ahead_is_accepted(planned):
    assert post(valid(departure=departure(days=13, minutes=-1))).status_code == 200


@pytest.mark.parametrize(
    ("send", "status", "message"),
    [
        (lambda c: c.post(URL, '{"origin": "Dallas",}', content_type="application/json"), 400, "JSON parse error"),
        (
            lambda c: c.post(URL, "[" * 1_000_000 + "]" * 1_000_000, content_type="application/json"),
            400,
            "JSON parse error - the body is nested too deeply.",
        ),
        (lambda c: c.post(URL, [valid()], format="json"), 400, "Invalid data. Expected a dictionary, but got list."),
        (lambda c: c.post(URL, json.dumps(valid()), content_type="text/plain"), 415, "Unsupported media type"),
        (lambda c: c.get(URL), 405, 'Method "GET" not allowed.'),
    ],
)
def test_requests_the_api_cannot_read_get_a_plain_error(planned, send, status, message):
    response = send(APIClient())
    assert response.status_code == status
    assert list(response.json()) == ["error"]
    assert response.json()["error"].startswith(message)
    assert planned == []


def test_missing_fields_are_all_reported(planned):
    response = post({})
    assert set(response.json()["fields"]) == {"origin", "destination", "departure", "load_lb"}


@pytest.mark.parametrize(
    ("error", "status", "body"),
    [
        (
            InvalidInput("Couldn't find it.", fields={"origin": "Couldn't find it."}),
            400,
            {"error": "Couldn't find it.", "fields": {"origin": ["Couldn't find it."]}},
        ),
        (NoRoute("No truck route was found."), 400, {"error": "No truck route was found."}),
        (ServiceError("The weather service failed."), 502, {"error": "The weather service failed."}),
        (ServiceTimeout("Too slow."), 504, {"error": "Too slow."}),
        (ServiceBusy("Try again in 42 seconds.", retry_after_s=42), 503, {"error": "Try again in 42 seconds.", "retry_after_seconds": 42}),
        (RuntimeError("bug"), 500, {"error": "Something went wrong while planning the trip. Please try again."}),
    ],
)
def test_planning_failures_become_clear_error_responses(monkeypatch, error, status, body):
    def failing_plan_trip(request, tomtom, weather):
        raise error

    monkeypatch.setattr(views, "plan_trip", failing_plan_trip)
    response = post(valid())
    assert response.status_code == status
    assert response.json() == body
    if isinstance(error, ServiceBusy):
        assert response["Retry-After"] == "42"


def test_a_missing_tomtom_key_is_reported(planned, settings):
    settings.TOMTOM_API_KEY = ""
    response = post(valid())
    assert response.status_code == 500
    assert response.json() == {"error": "This server has no TomTom API key configured."}


def test_responses_are_gzipped_for_clients_that_accept_it(planned):
    response = post(valid(), HTTP_ACCEPT_ENCODING="gzip")
    assert response["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(response.content))["padding"] == "x" * 1000


@responses.activate
def test_a_full_plan_request_with_tomtom_and_open_meteo_faked():
    def geocode(request):
        query = unquote(urlsplit(str(request.url)).path.rsplit("/", 1)[-1])
        found = {"Dallas, TX.json": ("Dallas, TX", DALLAS), "Denver, CO.json": ("Denver, CO", DENVER)}[query]
        return 200, {}, json.dumps(geocode_json(*found))

    responses.add_callback(responses.GET, re.compile(r"https://api\.tomtom\.com/search/2/geocode/.*"), callback=geocode)
    responses.get(
        re.compile(r"https://api\.tomtom\.com/routing/1/calculateRoute/.*"),
        json={"routes": [route_json(points) for points in three_roads()]},
    )
    answer_open_meteo(lambda t: (48.0, 60.0, 0.0, 0.0, 0.0))  # Severe wind everywhere

    response = post(valid(load_lb=35_000))  # over 30,000 lb: the load rule makes it No Travel

    assert response.status_code == 200, response.json()
    plan = response.json()
    assert [r["id"] for r in plan["routes"]] == ["A", "B", "C"]
    assert {c["level"] for r in plan["routes"] for c in r["checkpoints"]} == {4}
    assert all(c["load_rule_applied"] for c in plan["routes"][0]["checkpoints"])
    assert plan["recommendation"]["warnings"][0].startswith("Every route has No Travel conditions.")
    assert len(plan["heatmap"]["levels"]) == 49
    assert {v for frame in plan["heatmap"]["levels"] for v in frame} == {4}
    tomtom_calls = [call for call in responses.calls if "tomtom" in str(call.request.url)]
    assert len(tomtom_calls) == 3  # two place searches and one route request with alternatives
    route_url = next(str(call.request.url) for call in tomtom_calls if "calculateRoute" in str(call.request.url))
    query = parse_qs(urlsplit(route_url).query)
    assert query["maxAlternatives"] == ["2"]
    assert (query["travelMode"], query["vehicleCommercial"], query["vehicleMaxSpeed"]) == (["truck"], ["true"], ["109"])


PLACES_URL = "/api/places/"
SEARCH_URL = re.compile(r"https://api\.tomtom\.com/search/2/search/.*")


def places(typed: str) -> Any:  # the test client's response; DRF has no type hints
    return APIClient().get(PLACES_URL, {"q": typed})


@responses.activate
def test_place_suggestions_for_what_was_typed():
    responses.get(SEARCH_URL, json=search_json(("Denver, CO", "US", "United States", "Colorado"), "Denver, NC"))
    response = places("  Denver  ")
    assert response.status_code == 200
    assert response.json() == {
        "places": [{"name": "Denver, CO", "also": ["Denver, Colorado"]}, {"name": "Denver, NC", "also": []}]
    }
    assert urlsplit(str(responses.calls[0].request.url)).path == "/search/2/search/Denver.json"  # spaces trimmed


@pytest.mark.parametrize("typed", ["", "De", " De ", "x" * 201])
def test_place_suggestions_need_3_to_200_characters(typed):
    response = places(typed)
    assert response.status_code == 400
    assert response.json() == {"error": "Type 3 to 200 characters of a place name."}


@pytest.mark.parametrize(
    ("error", "status", "body"),
    [
        (ServiceBusy("Busy.", retry_after_s=10), 503, {"error": "Busy.", "retry_after_seconds": 10}),
        (ServiceError("Refused."), 502, {"error": "Refused."}),
        (RuntimeError("bug"), 500, {"error": "Something went wrong while looking up places."}),
    ],
)
def test_place_suggestion_failures_become_clear_error_responses(monkeypatch, error, status, body):
    def failing(self, text):
        raise error

    monkeypatch.setattr(views.TomTomClient, "suggest_places", failing)
    response = places("Denv")
    assert (response.status_code, response.json()) == (status, body)


def test_place_suggestions_without_a_tomtom_key_are_refused(settings):
    settings.TOMTOM_API_KEY = ""
    response = places("Denv")
    assert (response.status_code, response.json()) == (500, {"error": "This server has no TomTom API key configured."})
