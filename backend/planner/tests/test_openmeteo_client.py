"""Open-Meteo client: batched requests, the per-day cache, units, missing data and rate limits."""

import threading
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

import pytest
import requests
import responses
from django.core.cache import cache
from responses.registries import OrderedRegistry

from planner.clients import openmeteo
from planner.clients.openmeteo import FORECAST_URL, OpenMeteoClient, forecast_horizon
from planner.errors import ServiceBusy, ServiceError
from planner.tests.fakes import NOW, answer_open_meteo, open_meteo_json

POINTS = [(32.78, -96.8), (35.22, -101.84), (39.74, -104.98)]
START = datetime(2026, 10, 25, 14, tzinfo=UTC)
END = datetime(2026, 10, 27, 14, tzinfo=UTC)


def client(now: datetime = NOW, waits: list[float] | None = None) -> OpenMeteoClient:
    """A client at `now` that records its waits in `waits` instead of sleeping."""
    record = waits.append if waits is not None else lambda _seconds: None
    return OpenMeteoClient(now=lambda: now, sleep=record)


def form_of(call) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(call.request.body).items()}


def batch_sizes() -> list[int]:
    return [len(form_of(call)["latitude"].split(",")) for call in responses.calls]


@responses.activate
def test_forecasts_for_many_places_come_from_one_request():
    answer_open_meteo(lambda t: (30.0 if t == int(START.timestamp()) else 8.0, 40.0, 0.01, 0.09, 0.0))
    forecasts = client().forecasts(POINTS, START, END)
    assert len(responses.calls) == 1
    form = form_of(responses.calls[0])
    assert form["latitude"] == "32.78,35.22,39.74"
    assert form["longitude"] == "-96.80,-101.84,-104.98"
    assert form["hourly"] == "wind_speed_10m,wind_gusts_10m,rain,showers,snowfall"
    assert (form["wind_speed_unit"], form["precipitation_unit"]) == ("mph", "inch")
    assert (form["timezone"], form["timeformat"]) == ("GMT", "unixtime")
    assert (form["start_date"], form["end_date"]) == ("2026-10-25", "2026-10-27")
    weather = forecasts[POINTS[1]].at(START)
    assert weather is not None and weather.wind_mph == 30.0 and weather.rain_in_hr == 0.1  # rain + showers
    later = forecasts[POINTS[1]].at(START + timedelta(hours=1))
    assert later is not None and later.wind_mph == 8.0


@responses.activate
def test_a_single_place_is_answered_with_an_object_instead_of_a_list():
    answer_open_meteo()
    forecasts = client().forecasts(POINTS[:1], START, END)
    assert forecasts[POINTS[0]].at(END) is not None


@responses.activate
def test_forecasts_are_cached_per_place_and_day():
    answer_open_meteo()
    client().forecasts(POINTS, START, END)
    client().forecasts(POINTS, START, END)
    assert len(responses.calls) == 1  # the second time everything came from the cache
    new_point = (40.0, -100.0)
    client().forecasts([*POINTS, new_point], START, END)
    assert len(responses.calls) == 2
    assert form_of(responses.calls[1])["latitude"] == "40.00"  # only the place not cached yet


@responses.activate
def test_more_than_1000_places_are_split_into_several_requests_the_smallest_first():
    answer_open_meteo()
    points = [(30 + i * 0.02, -100.0) for i in range(2500)]
    forecasts = client().forecasts(points, START, START)
    assert batch_sizes() == [500, 1000, 1000]
    assert all(forecasts[p].at(START) is not None for p in points)


@pytest.mark.parametrize(("count", "served"), [(1001, True), (1599, True), (1600, False)])
@responses.activate
def test_up_to_1599_places_fit_in_a_fresh_minute(count, served):
    # Open-Meteo refuses a request once 600 places were used that minute. With the small batch first,
    # the full batch of 1,000 is still let through.
    answer_open_meteo(minute_limit=600)
    points = [(30 + i * 0.02, -100.0) for i in range(count)]
    if served:
        assert len(client().forecasts(points, START, START)) == count
    else:
        with pytest.raises(ServiceBusy):
            client().forecasts(points, START, START)


@responses.activate
def test_days_past_the_forecast_horizon_are_not_requested():
    answer_open_meteo()
    horizon = forecast_horizon(NOW)
    assert horizon == datetime(2026, 11, 8, 23, tzinfo=UTC)  # today and 15 more days
    forecasts = client().forecasts(POINTS[:2], horizon - timedelta(hours=2), horizon + timedelta(days=2))
    assert form_of(responses.calls[0])["end_date"] == "2026-11-08"
    assert forecasts[POINTS[0]].at(horizon) is not None
    assert forecasts[POINTS[0]].at(horizon + timedelta(hours=1)) is None  # No data
    beyond = client().forecasts(POINTS[:2], horizon + timedelta(days=1), horizon + timedelta(days=3))
    assert len(responses.calls) == 1  # nothing to ask for
    assert beyond[POINTS[0]].at(horizon + timedelta(days=1)) is None


@responses.activate
def test_missing_values_stay_missing():
    answer_open_meteo(lambda t: (None, None, 0.0, None, 0.0))
    weather = client().forecasts(POINTS[:1], START, START)[POINTS[0]].at(START)
    assert weather is not None
    assert (weather.wind_mph, weather.gust_mph, weather.rain_in_hr, weather.snow_in_hr) == (None, None, None, 0.0)


@responses.activate
def test_unexpected_units_are_refused():
    body = open_meteo_json([int(START.timestamp())])
    body["hourly_units"]["wind_speed_10m"] = "km/h"
    responses.post(FORECAST_URL, json=body)
    with pytest.raises(ServiceError):
        client().forecasts(POINTS[:1], START, START)


MINUTELY = "Minutely API request limit exceeded. Please try again in one minute."
HOURLY = "Hourly API request limit exceeded. Please try again in the next hour."
DAILY = "Daily API request limit exceeded. Please try again tomorrow."


@pytest.mark.parametrize(
    ("reason", "now", "retry_after", "phrase", "waited"),
    [
        # Each wait runs 2 s past the moment Open-Meteo resets its count. Only a limit that resets
        # within 15 s is waited out (once) before the plan fails.
        (MINUTELY, (18, 0, 20), 42, "in about 42 seconds.", []),
        (MINUTELY, (18, 0, 50), 12, "in about 12 seconds.", [12]),
        (MINUTELY, (18, 0, 45), 17, "in about 17 seconds.", [17]),  # resets in 15 s: still waited out
        (MINUTELY, (18, 0, 44), 18, "in about 18 seconds.", []),  # resets in 16 s
        (HOURLY, (18, 0, 20), 3600 - 20 + 2, "in about 60 minutes.", []),
        (HOURLY, (18, 0, 0), 3602, "in about 61 minutes.", []),
        (HOURLY, (18, 59, 0), 62, "in about 2 minutes.", []),
        (HOURLY, (18, 59, 50), 12, "in about a minute.", []),  # waits only for the per-minute count
        (DAILY, (18, 0, 20), 6 * 3600 - 20 + 2, "after midnight UTC.", []),
        ("Too many concurrent requests", (18, 0, 20), 5, "in a few seconds.", [5]),
        ("", (18, 0, 20), 42, "in about 42 seconds.", []),  # no reason given: treated as the per-minute limit
    ],
)
@responses.activate
def test_rate_limits_say_when_to_try_again(reason, now, retry_after, phrase, waited):
    responses.post(FORECAST_URL, json={"error": True, "reason": reason}, status=429)
    waits: list[float] = []
    with pytest.raises(ServiceBusy) as error:
        client(now=datetime(2026, 10, 24, *now, tzinfo=UTC), waits=waits).forecasts(POINTS, START, END)
    assert error.value.retry_after_s == retry_after
    assert error.value.message.endswith(phrase)
    assert waits == waited
    assert len(responses.calls) == 1 + len(waited)


@responses.activate(registry=OrderedRegistry)
def test_a_limit_that_resets_within_15_s_is_waited_out_instead_of_failing_the_plan():
    responses.post(FORECAST_URL, json={"error": True, "reason": MINUTELY}, status=429)
    answer_open_meteo()  # after the count resets
    waits: list[float] = []
    forecasts = client(now=datetime(2026, 10, 24, 18, 0, 50, tzinfo=UTC), waits=waits).forecasts(POINTS, START, END)
    assert waits == [12]  # 2 s past the start of the next minute
    assert forecasts[POINTS[0]].at(START) is not None
    assert len(responses.calls) == 2


@pytest.mark.parametrize("body", ["Too Many Requests", '["?"]', "null"])
@responses.activate
def test_a_rate_limit_answer_without_a_reason_is_handled(body):
    responses.post(FORECAST_URL, body=body, status=429, content_type="application/json")
    with pytest.raises(ServiceBusy, match="per-minute limit"):
        client().forecasts(POINTS, START, END)


@responses.activate
def test_batches_fetched_before_a_rate_limit_stay_cached():
    answer_open_meteo(minute_limit=100)  # the first batch of 200 is served, the next is refused
    points = [(30 + i * 0.02, -100.0) for i in range(1200)]
    with pytest.raises(ServiceBusy):
        client().forecasts(points, START, START)
    assert batch_sizes() == [200, 1000]
    answer_open_meteo()  # a minute later
    client().forecasts(points, START, START)
    assert batch_sizes()[-1] == 1000  # only the rest is fetched again


@responses.activate
def test_plans_with_everything_cached_do_not_wait_for_another_plans_fetch(monkeypatch):
    answer_open_meteo()
    client().forecasts(POINTS, START, END)
    monkeypatch.setattr(openmeteo, "FETCH_WAIT_S", 0.05)
    with openmeteo._fetch_lock:  # another plan is fetching
        assert client().forecasts(POINTS, START, END)[POINTS[0]].at(START) is not None
        with pytest.raises(ServiceBusy) as error:
            client().forecasts([(40.0, -100.0)], START, END)  # not cached: it has to wait, and gives up
    assert error.value.retry_after_s == 5
    assert len(responses.calls) == 1


@responses.activate
def test_places_another_plan_fetched_meanwhile_are_not_fetched_again(monkeypatch):
    answer_open_meteo()
    client().forecasts(POINTS, START, END)
    keys = [openmeteo._key(p, START.date() + timedelta(days=d)) for p in POINTS for d in range(3)]
    entries = cache.get_many(keys)
    assert len(entries) == 9
    cache.clear()

    class OtherPlanFetches:
        """The fetch lock, with another plan filling the cache while this plan waits for it."""

        lock = threading.Lock()

        def acquire(self, timeout: float) -> bool:
            cache.set_many(entries)
            return self.lock.acquire(timeout=timeout)

        def release(self) -> None:
            self.lock.release()

    monkeypatch.setattr(openmeteo, "_fetch_lock", OtherPlanFetches())
    assert client().forecasts(POINTS, START, END)[POINTS[2]].at(END) is not None
    assert len(responses.calls) == 1


@responses.activate
def test_days_missing_from_the_answer_are_no_data():
    first_day = [int(datetime(2026, 10, 25, tzinfo=UTC).timestamp()) + h * 3600 for h in range(24)]
    responses.post(FORECAST_URL, json=[open_meteo_json(first_day), open_meteo_json([]), open_meteo_json(first_day)])
    forecasts = client().forecasts(POINTS, START, END)  # October 25 to 27
    assert forecasts[POINTS[0]].at(START) is not None
    assert forecasts[POINTS[0]].at(END) is None
    assert forecasts[POINTS[1]].at(START) is None
    client().forecasts(POINTS, START, END)
    assert len(responses.calls) == 1  # what came back empty is not asked for again within the hour


@pytest.mark.parametrize(
    "answer",
    [
        {"json": {"error": True, "reason": "Invalid value"}, "status": 400},
        {"body": "<html>414 Request-URI Too Large</html>", "status": 414},
        {"body": requests.Timeout("too slow")},
        {"body": "Unexpected error while streaming data", "status": 200},
        {"json": [open_meteo_json([0])], "status": 200},  # one result for three places
        {"json": [None, None, None], "status": 200},
        {"json": [{**open_meteo_json([0]), "hourly_units": None}] * 3, "status": 200},
        {"json": [{**open_meteo_json([0]), "hourly": None}] * 3, "status": 200},
    ],
)
@responses.activate
def test_other_failures_are_service_errors(answer):
    responses.post(FORECAST_URL, **answer)
    with pytest.raises(ServiceError):
        client().forecasts(POINTS, START, END)
