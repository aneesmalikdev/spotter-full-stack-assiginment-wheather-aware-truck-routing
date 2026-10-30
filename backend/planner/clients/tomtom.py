"""TomTom Geocoding, place suggestions (Search API) and Routing (Calculate Route, API version 1).

Version 1 is used because TomTom's newer "Orbis" routing has no truck mode. Results are never
cached: TomTom's terms only allow caching where its responses permit it, and they don't.

Request URLs carry the API key, so `requests` exceptions (whose messages include the URL) are
never chained onto the errors raised here: they would print the key in tracebacks.
"""

import logging
import re
import time
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NoReturn, Protocol
from urllib.parse import quote

import requests

from planner.errors import InvalidInput, NoRoute, ServiceBusy, ServiceError, ServiceTimeout
from planner.logic.geo import LatLon
from planner.logic.sampling import ProgressPoint, RouteTrack

logger = logging.getLogger(__name__)

BASE_URL = "https://api.tomtom.com"
GEOCODE_TIMEOUT_S = 10.0
RATE_LIMIT_PAUSE_S = 1.0  # TomTom's free tier allows 5 requests a second
MIN_RETRY_S = 1.0  # a rate-limited request is retried only if at least this much time is left
TRUCK_MAX_SPEED_KMH = 109  # 68 mph: fleets commonly limit trucks to 66-70 mph (README "Assumptions" 6)
SUGGEST_TIMEOUT_S = 4.0  # suggestions only help while the user is typing
COUNTRIES = "US,CA,MX"  # North American trucking: typed places and suggestions are looked up only here
SUGGEST_LIMIT = 5
SUGGEST_ASK = 10  # results asked of TomTom: those that don't start with what was typed are dropped
# Abbreviations read as their words in a city's own name (not after its comma, where MT is Montana),
# so "St. Lo" finds "Saint Louis, MO".
ABBREVIATIONS = {"st": "saint", "ste": "sainte", "ft": "fort", "mt": "mount"}
APOSTROPHES = "'\u2019\u2018\u02bc\u02bb`"  # dropped, so "O'Fallon", "O\u2019Fallon" and "OFallon" compare equal


@dataclass(frozen=True)
class Place:
    query: str  # what the user typed
    name: str  # TomTom's address for the match, e.g. "Dallas, TX" or "Toronto, ON, Canada"
    position: LatLon
    country_code: str | None


@dataclass(frozen=True)
class PlaceSuggestion:
    name: str  # as geocode() names places, e.g. "Denver, CO"
    also: tuple[str, ...]  # other ways to write it that typing may follow, e.g. "Denver, Colorado"


@dataclass(frozen=True)
class TomTomRoute:
    track: RouteTrack
    length_m: float
    travel_time_s: float

    @property
    def points(self) -> list[LatLon]:
        return self.track.points


class RoutingService(Protocol):
    """What planning needs from TomTom (TomTomClient, or a stand-in in tests)."""

    def geocode(self, query: str, field: str) -> Place: ...

    def calculate_route(
        self,
        locations: Sequence[str],
        departure: datetime,
        max_alternatives: int,
        timeout_s: float,
        avoid: Sequence[str] = (),
    ) -> list[TomTomRoute]: ...


def location(point: LatLon) -> str:
    return f"{point[0]:.6f},{point[1]:.6f}"


def circle(point: LatLon, radius_m: int) -> str:
    """A pass-through waypoint: the route must pass somewhere inside the circle, without stopping."""
    return f"circle({point[0]:.6f},{point[1]:.6f},{radius_m})"


class TomTomClient:
    def __init__(
        self,
        api_key: str,
        session: requests.Session | None = None,
        base_url: str = BASE_URL,
        pause_s: float = RATE_LIMIT_PAUSE_S,
    ) -> None:
        self._key = api_key
        self._session = session or requests.Session()
        self._base_url = base_url
        self._pause_s = pause_s

    def geocode(self, query: str, field: str) -> Place:
        """TomTom's best match for a place name in the US, Canada or Mexico (searched worldwide, the Dallas
        ZIP code 75201 matched Ras Al Khaimah in the UAE). `field` names the form field, for error messages."""
        url = f"{self._base_url}/search/2/geocode/{quote(query, safe='')}.json"
        try:
            response = self._get(url, {"key": self._key, "limit": 1, "countrySet": COUNTRIES}, GEOCODE_TIMEOUT_S)
        except requests.Timeout:
            raise ServiceTimeout("The place search service took too long to answer.") from None
        except requests.RequestException:
            raise ServiceError("The place search service could not be reached. Please try again.") from None
        if response.status_code != 200:
            _raise_for(response, "place search")
        try:
            results = response.json().get("results") or []
            if not results:
                message = f'Couldn\'t find "{query}" in the US, Canada or Mexico. Try adding a state or province.'
                raise InvalidInput(message, fields={field: message})
            best = results[0]
            address = best.get("address") or {}
            position = (float(best["position"]["lat"]), float(best["position"]["lon"]))
        except (AttributeError, KeyError, TypeError, ValueError):
            logger.error("Unusable TomTom place search response")
            raise ServiceError("The place search service returned an unusable answer.") from None
        return Place(query=query, name=_place_name(address, query), position=position, country_code=address.get("countryCode"))

    def suggest_places(self, text: str) -> list[PlaceSuggestion]:
        """Up to SUGGEST_LIMIT cities in the US, Canada or Mexico whose names start with `text` (which
        may end mid-word), best match first, named the way geocode() names places. For suggestions
        while typing, so a rate-limited request isn't retried: by then the user has typed on."""
        url = f"{self._base_url}/search/2/search/{quote(text, safe='')}.json"
        params = {
            "key": self._key,
            "typeahead": "true",
            "limit": SUGGEST_ASK,
            "idxSet": "Geo",
            "entityTypeSet": "Municipality",
            "countrySet": COUNTRIES,
            "language": "en-US",
        }
        try:
            response = self._session.get(url, params=params, timeout=SUGGEST_TIMEOUT_S)
        except requests.Timeout:
            raise ServiceTimeout("The place search service took too long to answer.") from None
        except requests.RequestException:
            raise ServiceError("The place search service could not be reached. Please try again.") from None
        if response.status_code != 200:
            _raise_for(response, "place search")
        try:
            addresses = [result.get("address") or {} for result in response.json().get("results") or []]
            places = [PlaceSuggestion(name, _spellings(address, name)) for address in addresses if (name := _place_name(address, ""))]
        except (AttributeError, TypeError, ValueError):
            logger.error("Unusable TomTom place suggestions")
            raise ServiceError("The place search service returned an unusable answer.") from None
        found: list[PlaceSuggestion] = []
        for place in places:
            if all(place.name != seen.name for seen in found) and matches_typed(place, text):
                found.append(place)
        return found[:SUGGEST_LIMIT]

    def calculate_route(
        self,
        locations: Sequence[str],
        departure: datetime,
        max_alternatives: int,
        timeout_s: float,
        avoid: Sequence[str] = (),
    ) -> list[TomTomRoute]:
        """Truck routes through `locations` (see `location` and `circle`), best first."""
        url = f"{self._base_url}/routing/1/calculateRoute/{':'.join(locations)}/json"
        params = [
            ("key", self._key),
            ("travelMode", "truck"),
            ("vehicleCommercial", "true"),
            ("vehicleMaxSpeed", str(TRUCK_MAX_SPEED_KMH)),
            ("departAt", _depart_at(departure)),
            ("maxAlternatives", str(max_alternatives)),
            # Cumulative distance and travel time along each route, used for checkpoint ETAs.
            ("extendedRouteRepresentation", "distance"),
            ("extendedRouteRepresentation", "travelTime"),
        ]
        params += [("avoid", value) for value in avoid]
        try:
            response = self._get(url, params, timeout_s)
        except requests.Timeout:
            raise ServiceTimeout("The routing service took too long to answer.") from None
        except requests.RequestException:
            raise ServiceError("The routing service could not be reached. Please try again.") from None
        if response.status_code != 200:
            _raise_for(response, "routing")
        try:
            return [_parse_route(route) for route in response.json()["routes"]]
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            logger.error("Unusable TomTom route response: %s", error)
            raise ServiceError("The routing service returned an unusable route.") from None

    def _get(self, url: str, params: dict | list, timeout_s: float) -> requests.Response:
        """GET. If TomTom's per-second limit is hit, it is retried once after a short pause, but only
        while time is left: the whole call stays within about `timeout_s`."""
        started = time.monotonic()
        response = self._session.get(url, params=params, timeout=timeout_s)
        if response.status_code == 429:
            left = timeout_s - (time.monotonic() - started) - self._pause_s
            if left >= MIN_RETRY_S:
                time.sleep(self._pause_s)
                response = self._session.get(url, params=params, timeout=left)
        return response


def matches_typed(place: PlaceSuggestion, typed: str) -> bool:
    """Whether what was typed is the start of the place's name, or of another way to write it."""
    return any(starts_with_typed(name, typed) for name in (place.name, *place.also))


def starts_with_typed(name: str, typed: str) -> bool:
    """Whether a place name starts with what was typed, ignoring case, accents and punctuation ("D.C."
    is "DC"; an apostrophe may be left out or typed as a space), and reading "St.", "Ste.", "Ft." and
    "Mt." in the city's name as words. The last typed word may be unfinished, so it also counts as
    typed ("St" may become "Sterling"). A typed comma ends a part of the name: "Denver, C" is Denver
    in a state starting with C, so not Denver City, TX; without a comma, "Chicago IL" works too. The
    frontend has the same rule (frontend/src/lib/placeMatch.ts)."""
    spaced = re.sub(f"[{APOSTROPHES}]", " ", name)
    return _name_starts_with(name, typed) or (spaced != name and _name_starts_with(spaced, typed))


def _name_starts_with(name: str, typed: str) -> bool:
    city, *rest = [_words(part) for part in name.split(",")]
    parts = [_expand(city), *rest]
    if "," not in typed:
        return _starts_with(" ".join(word for part in parts for word in part), _words(typed), expand=True)
    first, *done, last = [_words(part) for part in typed.split(",")]
    if 1 + len(done) >= len(parts) or _expand(first) != parts[0] or any(t != p for t, p in zip(done, parts[1:])):
        return False
    return not last or _starts_with(" ".join(parts[1 + len(done)]), last, expand=False)


def _starts_with(full: str, typed: list[str], expand: bool) -> bool:
    if not typed:
        return False
    if not expand:
        return full.startswith(" ".join(typed))
    expanded = " ".join(_expand(typed))
    as_typed = " ".join(_expand(typed[:-1]) + typed[-1:])
    return full.startswith(expanded) or full.startswith(as_typed)


def _expand(words: list[str]) -> list[str]:
    return [ABBREVIATIONS.get(word, word) for word in words]


def _words(text: str) -> list[str]:
    plain = re.sub("[\u0300-\u036f]", "", unicodedata.normalize("NFKD", text)).lower()
    plain = re.sub(f"[{APOSTROPHES}]", "", plain)
    plain = re.sub(r"\b([a-z])\.(?=[a-z]\b)", r"\1", plain, flags=re.ASCII)  # "d.c." is "dc"
    return [word for word in re.split(r"[^a-z0-9]+", plain) if word]


def _spellings(address: dict, name: str) -> tuple[str, ...]:
    """Other ways to write a suggested place: with the state or province in full, from TomTom's own
    names ("Denver, Colorado"), and outside the US without it ("Toronto, Canada")."""
    parts = [part.strip() for part in name.split(",")]
    code, full = address.get("countrySubdivision"), address.get("countrySubdivisionName")
    also = []
    if code and full and code != full and len(parts) >= 2 and parts[1] == code:
        also.append(", ".join([parts[0], full, *parts[2:]]))
    country = address.get("country")
    if country and len(parts) >= 3 and parts[-1] == country:
        also.append(f"{parts[0]}, {country}")
    return tuple(also)


def _place_name(address: dict, fallback: str) -> str:
    """TomTom's address for a place, with the country added outside the US: TomTom leaves it out, so a
    Canadian or Mexican place could pass for a US one ("Paris, ON, Canada", not Paris, TX). Canadian
    cities get a comma before the province, as US ones have before the state ("Toronto ON" becomes
    "Toronto, ON, Canada")."""
    name = address.get("freeformAddress") or fallback
    if address.get("countryCode") == "CA":
        name = re.sub(r"^([^,]*\S) ([A-Z]{2})$", r"\1, \2", name)
    country = address.get("country")
    if country and address.get("countryCode") not in ("US", "USA") and country not in name:
        name = f"{name}, {country}"
    return name


def _raise_for(response: requests.Response, service: str) -> NoReturn:
    code, message = _error_details(response)
    logger.warning("TomTom %s failed: HTTP %s %s %s", service, response.status_code, code, message)
    status = response.status_code
    if status == 400 and code in ("MAP_MATCHING_FAILURE", "NO_ROUTE_FOUND"):
        raise NoRoute(message, code=code)
    if status == 429:
        raise ServiceBusy(
            f"The {service} service is busy, or this server's free TomTom quota is used up. Please try again shortly.",
            retry_after_s=10,
        )
    if status in (401, 403):
        raise ServiceError(f"TomTom refused the {service} request: the server's API key is invalid or its quota is used up.")
    if code == "COMPUTE_TIME_LIMIT_EXCEEDED" or status == 504:
        raise ServiceTimeout(f"The {service} service took too long to answer.")
    raise ServiceError(f"The {service} service failed (HTTP {status}). Please try again.")


def _depart_at(departure: datetime) -> str:
    """TomTom wants departure times in the future; anything up to a minute from now is sent as "now"."""
    moment = departure.astimezone(UTC)
    if moment <= datetime.now(UTC) + timedelta(minutes=1):
        return "now"
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_route(route: dict) -> TomTomRoute:
    points = [(float(p["latitude"]), float(p["longitude"])) for leg in route["legs"] for p in leg["points"]]
    progress = [
        ProgressPoint(int(entry["pointIndex"]), float(entry["distanceInMeters"]), float(entry["travelTimeInSeconds"]))
        for entry in route["progress"]
    ]
    summary = route["summary"]
    return TomTomRoute(
        track=RouteTrack(points, progress),
        length_m=float(summary["lengthInMeters"]),
        travel_time_s=float(summary["travelTimeInSeconds"]),
    )


def _error_details(response: requests.Response) -> tuple[str, str]:
    """TomTom's error code and message. Errors usually come as a JSON object, sometimes as text or XML."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        detail = body.get("detailedError")
        detail = detail if isinstance(detail, dict) else {}
        code, message = str(detail.get("code", "")), str(detail.get("message", ""))
    else:
        code, message = "", response.text[:300]
    # Routing errors put the code inside the message, e.g. "...: MAP_MATCHING_FAILURE: Origin (...)".
    for known in ("MAP_MATCHING_FAILURE", "NO_ROUTE_FOUND", "COMPUTE_TIME_LIMIT_EXCEEDED"):
        if known in message:
            code = known
    return code, message
