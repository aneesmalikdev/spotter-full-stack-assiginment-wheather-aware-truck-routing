"""The API: POST /api/plan/ and GET /api/places/ (see README "API")."""

import logging
from typing import Any, cast

import requests
from django.conf import settings
from django.utils.decorators import method_decorator
from django.views.decorators.gzip import gzip_page
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.settings import api_settings
from rest_framework.views import APIView

from planner.clients.openmeteo import OpenMeteoClient
from planner.clients.tomtom import TomTomClient
from planner.errors import InvalidInput, PlanError, ServiceBusy
from planner.serializers import PlanRequestSerializer
from planner.services.plan import PlanRequest, plan_trip

logger = logging.getLogger(__name__)

SUGGEST_MIN_CHARS = 3  # shorter text matches too many places to be useful
SUGGEST_MAX_CHARS = 200  # as long as a place in a plan request may be

# Shared by all requests, so connections to TomTom and Open-Meteo are reused.
_tomtom_session = requests.Session()
_weather_session = requests.Session()


@method_decorator(gzip_page, name="dispatch")
class PlanView(APIView):
    def post(self, request: Request) -> Response:
        serializer = PlanRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _invalid_response(cast(dict, serializer.errors))  # a dict for a single object
        data = cast(dict[str, Any], serializer.validated_data)  # DRF has no type hints
        plan_request = PlanRequest(
            origin=data["origin"],
            destination=data["destination"],
            departure=data["departure"],
            load_lb=data["load_lb"],
            interval_miles=data["interval_miles"],
        )
        try:
            plan = plan_trip(plan_request, *_clients())
        except PlanError as error:
            return _error_response(error)
        except Exception:
            logger.exception("Planning failed")
            return Response({"error": "Something went wrong while planning the trip. Please try again."}, status=500)
        return Response(plan)


class PlacesView(APIView):
    """City names for the From and To suggestions: GET /api/places/?q=Denv."""

    def get(self, request: Request) -> Response:
        text = " ".join(str(request.query_params.get("q", "")).split())
        if not SUGGEST_MIN_CHARS <= len(text) <= SUGGEST_MAX_CHARS:
            message = f"Type {SUGGEST_MIN_CHARS} to {SUGGEST_MAX_CHARS} characters of a place name."
            return Response({"error": message}, status=400)
        try:
            places = _clients()[0].suggest_places(text)
        except PlanError as error:
            return _error_response(error)
        except Exception:
            logger.exception("Place suggestions failed")
            return Response({"error": "Something went wrong while looking up places."}, status=500)
        return Response({"places": [{"name": place.name, "also": list(place.also)} for place in places]})


def _clients() -> tuple[TomTomClient, OpenMeteoClient]:
    if not settings.TOMTOM_API_KEY:
        raise PlanError("This server has no TomTom API key configured.")
    return TomTomClient(settings.TOMTOM_API_KEY, session=_tomtom_session), OpenMeteoClient(session=_weather_session)


def _invalid_response(errors: dict) -> Response:
    general = errors.get(api_settings.NON_FIELD_ERRORS_KEY)
    if general:  # not about one field, e.g. a JSON list was sent instead of an object
        return Response({"error": " ".join(str(message) for message in general)}, status=400)
    return Response({"error": "Please correct the highlighted fields.", "fields": errors}, status=400)


def _error_response(error: PlanError) -> Response:
    body: dict = {"error": error.message}
    headers = {}
    if isinstance(error, InvalidInput) and error.fields:
        body["fields"] = {field: [message] for field, message in error.fields.items()}
    if isinstance(error, ServiceBusy) and error.retry_after_s:
        body["retry_after_seconds"] = error.retry_after_s
        headers["Retry-After"] = str(error.retry_after_s)
    return Response(body, status=error.status, headers=headers)
