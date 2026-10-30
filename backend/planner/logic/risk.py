"""Weather risk levels from the requirements' risk and load rules.

The requirements' table leaves two things open: values that fall in two levels (rain of exactly
0.25 in/hr) and wind between its whole-number ranges (34.6 mph). The thresholds below keep the
table's numbers: a level starts at its lower bound, and where the table gives "A to B" the upper
bound B still belongs to that level. A value in two levels gets the higher one.
"""

import math
from dataclasses import dataclass
from enum import IntEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # TypeIs is new in Python 3.13; at runtime the module also loads on 3.12
    from typing import TypeIs


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4


@dataclass(frozen=True)
class Threshold:
    """The start of a level: `value` itself counts when `inclusive`, otherwise only values above it."""

    value: float
    inclusive: bool = True

    def reached_by(self, x: float) -> bool:
        return x >= self.value if self.inclusive else x > self.value


# Where Moderate, High, Severe and No Travel start.
WIND_MPH = (Threshold(25), Threshold(35), Threshold(45), Threshold(55))
RAIN_IN_HR = (Threshold(0.10), Threshold(0.25), Threshold(0.50), Threshold(1.00, inclusive=False))
SNOW_IN_HR = (Threshold(0.5), Threshold(1.0), Threshold(2.0), Threshold(3.0, inclusive=False))

# Load rules, on top of the wind level.
NO_TRAVEL_LOAD_LB = 30_000  # Severe wind (45 up to 55 mph) with a heavier load -> No Travel
SEVERE_LOAD_LB = 40_000  # High wind (35 up to 45 mph) with a heavier load -> Severe


def _classify(value: float, thresholds: tuple[Threshold, ...]) -> RiskLevel:
    level = RiskLevel.LOW
    for next_level, threshold in zip(list(RiskLevel)[1:], thresholds):
        if threshold.reached_by(value):
            level = next_level
    return level


def classify_wind(mph: float) -> RiskLevel:
    """Sustained wind speed in mph."""
    return _classify(mph, WIND_MPH)


def classify_rain(in_hr: float) -> RiskLevel:
    """Liquid rain rate (rain plus showers) in inches per hour."""
    return _classify(in_hr, RAIN_IN_HR)


def classify_snow(in_hr: float) -> RiskLevel:
    """Snowfall rate in inches per hour."""
    return _classify(in_hr, SNOW_IN_HR)


def combine_rain(rain_in: float | None, showers_in: float | None) -> float | None:
    """Liquid rain including showers, rounded to the forecast's 0.001 inch so the float sum
    cannot land just below a threshold (0.01 + 0.09 would otherwise be 0.0999...).

    With one part missing the total is unknown, unless the known part alone is already above
    the No Travel threshold: the total can only be higher.
    """
    if rain_in is not None and showers_in is not None:
        return round(rain_in + showers_in, 3)
    known = rain_in if showers_in is None else showers_in
    if known is not None and classify_rain(known) is RiskLevel.NO_TRAVEL:
        return known
    return None


def wind_level_with_load(mph: float, load_lb: float) -> tuple[RiskLevel, bool]:
    """Wind level after the load rules, and whether a load rule raised it."""
    level = classify_wind(mph)
    if level is RiskLevel.SEVERE and load_lb > NO_TRAVEL_LOAD_LB:
        return RiskLevel.NO_TRAVEL, True
    if level is RiskLevel.HIGH and load_lb > SEVERE_LOAD_LB:
        return RiskLevel.SEVERE, True
    return level, False


@dataclass(frozen=True)
class RiskAssessment:
    wind: RiskLevel | None  # after the load rules
    rain: RiskLevel | None
    snow: RiskLevel | None
    load_rule_applied: bool
    level: RiskLevel | None  # None means "No data"


def _known(value: float | None) -> "TypeIs[float]":
    return value is not None and math.isfinite(value)


def assess(
    wind_mph: float | None,
    rain_in_hr: float | None,
    snow_in_hr: float | None,
    load_lb: float,
) -> RiskAssessment:
    """Risk for one place and hour: the worst of wind (after the load rules), rain and snow.

    A missing value makes the result "No data" (None), except when a known value is already
    No Travel, because then nothing missing could change the result.
    """
    wind, applied = wind_level_with_load(wind_mph, load_lb) if _known(wind_mph) else (None, False)
    rain = classify_rain(rain_in_hr) if _known(rain_in_hr) else None
    snow = classify_snow(snow_in_hr) if _known(snow_in_hr) else None

    known = [level for level in (wind, rain, snow) if level is not None]
    if RiskLevel.NO_TRAVEL in known:
        level = RiskLevel.NO_TRAVEL
    elif len(known) < 3:
        level = None
    else:
        level = max(known)
    return RiskAssessment(wind=wind, rain=rain, snow=snow, load_rule_applied=applied, level=level)
