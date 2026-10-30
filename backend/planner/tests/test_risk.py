"""Risk classification: every boundary in the risk table, the load rules, and how they combine.

Ranges (README "Assumptions"): "A up to B" includes A but not B; "A to B" includes both;
a value that falls in two levels goes to the higher one.
"""

import math

import pytest

from planner.logic.risk import (
    RiskLevel,
    assess,
    classify_rain,
    classify_snow,
    classify_wind,
    combine_rain,
    wind_level_with_load,
)

LOW, MODERATE, HIGH, SEVERE, NO_TRAVEL = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)


@pytest.mark.parametrize(
    ("mph", "expected"),
    [
        (0.0, LOW),
        (24.9, LOW),
        (25.0, MODERATE),  # Moderate 25 up to 35
        (34.9, MODERATE),
        (35.0, HIGH),  # High 35 up to 45
        (44.9, HIGH),
        (45.0, SEVERE),  # Severe 45 up to 55
        (54.9, SEVERE),
        (55.0, NO_TRAVEL),  # No Travel 55 and above
        (80.0, NO_TRAVEL),
    ],
)
def test_wind_levels(mph, expected):
    assert classify_wind(mph) is expected


def test_wind_between_the_tables_whole_number_ranges_goes_to_the_level_it_has_reached():
    # 34.6 mph is in neither 25-34 nor 35-44 in the original table.
    assert classify_wind(34.6) is MODERATE
    assert classify_wind(44.5) is HIGH
    assert classify_wind(54.99) is SEVERE


@pytest.mark.parametrize(
    ("in_hr", "expected"),
    [
        (0.0, LOW),
        (0.099, LOW),
        (0.10, MODERATE),  # Moderate 0.10 up to 0.25
        (0.249, MODERATE),
        (0.25, HIGH),  # in both Moderate and High -> High
        (0.499, HIGH),
        (0.50, SEVERE),  # in both High and Severe -> Severe
        (0.999, SEVERE),
        (1.00, SEVERE),  # Severe 0.50 to 1.00 includes 1.00
        (1.001, NO_TRAVEL),  # No Travel above 1.00
        (2.5, NO_TRAVEL),
    ],
)
def test_rain_levels(in_hr, expected):
    assert classify_rain(in_hr) is expected


@pytest.mark.parametrize(
    ("in_hr", "expected"),
    [
        (0.0, LOW),
        (0.499, LOW),
        (0.5, MODERATE),  # Moderate 0.5 up to 1.0
        (0.999, MODERATE),
        (1.0, HIGH),  # in both Moderate and High -> High
        (1.999, HIGH),
        (2.0, SEVERE),  # in both High and Severe -> Severe
        (2.999, SEVERE),
        (3.0, SEVERE),  # Severe 2.0 to 3.0 includes 3.0
        (3.001, NO_TRAVEL),  # No Travel above 3.0
    ],
)
def test_snow_levels(in_hr, expected):
    assert classify_snow(in_hr) is expected


def test_rain_includes_showers_and_avoids_floating_point_drift():
    drizzle = combine_rain(0.010, 0.090)  # 0.01 + 0.09 is 0.09999... in floats
    assert drizzle is not None and drizzle == 0.1
    assert classify_rain(drizzle) is MODERATE
    downpour = combine_rain(0.600, 0.400)
    assert downpour is not None and classify_rain(downpour) is SEVERE
    assert combine_rain(0.2, 0.0) == 0.2


def test_rain_with_a_missing_part_is_unknown_unless_already_no_travel():
    assert combine_rain(None, 0.1) is None
    assert combine_rain(0.1, None) is None
    assert combine_rain(1.0, None) is None  # exactly 1.00 is Severe; the total could be higher
    assert combine_rain(1.5, None) == 1.5  # above 1.00 alone: No Travel whatever showers adds
    assert combine_rain(None, 1.2) == 1.2
    assert assess(wind_mph=10.0, rain_in_hr=combine_rain(1.5, None), snow_in_hr=0.0, load_lb=0).level is NO_TRAVEL


@pytest.mark.parametrize(
    ("mph", "load_lb", "expected", "applied"),
    [
        # 45 up to 55 mph with a load above 30,000 lb -> No Travel
        (45.0, 30_000, SEVERE, False),
        (45.0, 30_001, NO_TRAVEL, True),
        (54.9, 30_000, SEVERE, False),
        (54.9, 30_001, NO_TRAVEL, True),
        # 35 up to 45 mph with a load above 40,000 lb -> Severe
        (35.0, 40_000, HIGH, False),
        (35.0, 40_001, SEVERE, True),
        (44.9, 40_000, HIGH, False),
        (44.9, 40_001, SEVERE, True),
        (44.9, 35_000, HIGH, False),  # the 30,000 lb rule only covers 45 up to 55 mph
        # Outside those wind ranges the load changes nothing
        (34.9, 80_000, MODERATE, False),
        (20.0, 80_000, LOW, False),
        # 55 mph and above is No Travel for any load
        (55.0, 0, NO_TRAVEL, False),
        (60.0, 80_000, NO_TRAVEL, False),
    ],
)
def test_load_rules(mph, load_lb, expected, applied):
    assert wind_level_with_load(mph, load_lb) == (expected, applied)


def test_checkpoint_risk_is_the_worst_factor_after_the_load_rules():
    result = assess(wind_mph=46.0, rain_in_hr=0.30, snow_in_hr=0.0, load_lb=35_000)
    assert result.wind is NO_TRAVEL and result.load_rule_applied
    assert result.rain is HIGH
    assert result.snow is LOW
    assert result.level is NO_TRAVEL

    result = assess(wind_mph=10.0, rain_in_hr=0.0, snow_in_hr=1.2, load_lb=45_000)
    assert result.level is HIGH
    assert not result.load_rule_applied


def test_all_low_is_low():
    assert assess(wind_mph=5.0, rain_in_hr=0.0, snow_in_hr=0.0, load_lb=10_000).level is LOW


def test_missing_values_mean_no_data():
    result = assess(wind_mph=40.0, rain_in_hr=None, snow_in_hr=0.0, load_lb=0)
    assert result.level is None
    assert result.wind is HIGH
    assert result.rain is None
    assert assess(wind_mph=None, rain_in_hr=None, snow_in_hr=None, load_lb=0).level is None


def test_known_no_travel_is_not_hidden_by_missing_values():
    assert assess(wind_mph=58.0, rain_in_hr=None, snow_in_hr=None, load_lb=0).level is NO_TRAVEL
    assert assess(wind_mph=50.0, rain_in_hr=None, snow_in_hr=0.0, load_lb=35_000).level is NO_TRAVEL
    assert assess(wind_mph=None, rain_in_hr=1.5, snow_in_hr=None, load_lb=0).level is NO_TRAVEL


def test_non_finite_values_count_as_missing():
    assert assess(wind_mph=math.nan, rain_in_hr=0.0, snow_in_hr=0.0, load_lb=0).level is None

