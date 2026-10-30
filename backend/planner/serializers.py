"""Validation of the plan request (README "Assumptions" 21-23)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers

PAST_GRACE = timedelta(hours=1)
# Open-Meteo forecasts up to 23:00 UTC 15 days after today, so a departure up to 13 days ahead keeps
# the 48 hours after it inside the forecast (all but the last slider hour when planning after 22:30 UTC,
# and the last two after 23:30 UTC, as a slider hour's rain and snow are stamped an hour later).
MAX_DAYS_AHEAD = 13
MAX_LOAD_LB = 200_000
INTERVALS_MILES = (10, 25, 50)
IN_THE_PAST = "The departure time is in the past."
TOO_FAR_AHEAD = f"Choose a departure within the next {MAX_DAYS_AHEAD} days, so the forecast covers the 48 hours after it."


def _place_field(missing: str) -> serializers.CharField:
    return serializers.CharField(
        min_length=2,
        max_length=200,
        error_messages={
            "required": missing,
            "blank": missing,
            "min_length": "Enter at least 2 characters.",
            "max_length": "Enter at most 200 characters.",
        },
    )


class LoadField(serializers.FloatField):
    """A FloatField that refuses JSON true and false, which Python would read as 1 and 0."""

    def to_internal_value(self, data: Any) -> float:
        if isinstance(data, bool):
            self.fail("invalid")
        return super().to_internal_value(data)


class PlanRequestSerializer(serializers.Serializer):
    origin = _place_field("Enter where the trip starts.")
    destination = _place_field("Enter where the trip ends.")
    departure = serializers.CharField(
        error_messages={"required": "Enter the departure date and time.", "blank": "Enter the departure date and time."}
    )
    load_lb = LoadField(
        min_value=0,
        max_value=MAX_LOAD_LB,
        error_messages={
            "required": "Enter the load weight in pounds.",
            "invalid": "Enter the load weight in pounds.",
            "min_value": "The load weight can't be negative.",
            "max_value": f"The load weight must be at most {MAX_LOAD_LB:,} lb.",
        },
    )
    interval_miles = serializers.ChoiceField(
        choices=INTERVALS_MILES,
        default=25,
        error_messages={"invalid_choice": "Choose a checkpoint interval of 10, 25 or 50 miles."},
    )

    def validate_departure(self, value: str) -> datetime:
        try:
            parsed = parse_datetime(value)
        except ValueError:  # well formed but impossible, e.g. month 13
            parsed = None
        if parsed is None:
            raise serializers.ValidationError("Enter the departure as a date and time, e.g. 2026-10-25T14:00:00Z.")
        if parsed.tzinfo is None:
            raise serializers.ValidationError(
                "The departure time needs a time zone offset, e.g. 2026-10-25T14:00:00-05:00."
            )
        try:
            departure = parsed.astimezone(UTC)
        except OverflowError:  # the offset moves it past the end of year 9999 or before year 1
            raise serializers.ValidationError(TOO_FAR_AHEAD if parsed.year > 1 else IN_THE_PAST) from None
        now = timezone.now()
        if departure < now - PAST_GRACE:
            raise serializers.ValidationError(IN_THE_PAST)
        if departure > now + timedelta(days=MAX_DAYS_AHEAD):
            raise serializers.ValidationError(TOO_FAR_AHEAD)
        return departure
