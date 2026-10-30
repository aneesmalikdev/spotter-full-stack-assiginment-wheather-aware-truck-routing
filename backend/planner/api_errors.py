"""DRF hooks that give every API error the same shape, {"error": "..."} (see README "API").

The plan view builds its own error responses; these cover what DRF rejects before the view runs:
bodies that aren't JSON, a wrong method or content type.
"""

from typing import Any

from rest_framework.exceptions import ParseError
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import exception_handler


class StrictJSONParser(JSONParser):
    """DRF's JSON parser, which also refuses JSON nested too deeply for Python to parse."""

    def parse(self, stream: Any, media_type: str | None = None, parser_context: dict | None = None) -> Any:
        try:
            return super().parse(stream, media_type, parser_context)
        except RecursionError:  # DRF only turns ValueError into a 400
            raise ParseError("JSON parse error - the body is nested too deeply.") from None


def error_handler(exc: Exception, context: dict) -> Response | None:
    """DRF's own error responses, with {"detail": "..."} renamed to {"error": "..."}."""
    response = exception_handler(exc, context)
    if response is not None and isinstance(response.data, dict) and "detail" in response.data:
        response.data = {"error": str(response.data["detail"])}
    return response
