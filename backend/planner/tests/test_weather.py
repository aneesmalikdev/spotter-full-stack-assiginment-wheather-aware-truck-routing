from datetime import UTC, datetime, timedelta, timezone

from planner.logic.weather import ForecastSeries, HourlyWeather, forecast_point

T0 = 1_792_886_400  # 2026-10-25T00:00Z


def series() -> ForecastSeries:
    return ForecastSeries.from_hourly(
        times=[T0, T0 + 3600],
        wind_mph=[12.0, None],
        gust_mph=[20.0, 25.0],
        rain_in=[0.010, 0.2],
        showers_in=[0.090, 0.0],
        snow_in=[0.0, 0.0],
    )


def test_values_are_looked_up_by_utc_hour_and_rain_includes_showers():
    hour = series().at(datetime(2026, 10, 25, 0, 0, tzinfo=UTC))
    assert hour == HourlyWeather(wind_mph=12.0, gust_mph=20.0, rain_in_hr=0.1, snow_in_hr=0.0)


def test_missing_values_stay_missing():
    hour = series().at(datetime(2026, 10, 25, 1, 0, tzinfo=UTC))
    assert hour is not None and hour.wind_mph is None and hour.rain_in_hr == 0.2


def test_hours_outside_the_forecast_have_no_data():
    assert series().at(datetime(2026, 10, 25, 5, 0, tzinfo=UTC)) is None


def test_at_an_eta_wind_comes_from_the_nearest_hour_and_rain_from_the_hour_it_falls_in():
    # 00:20: wind at 00:00, rain, snow and gusts of 00:00-01:00, stamped 01:00.
    wind_hour, totals_hour, weather = series().at_eta(datetime(2026, 10, 25, 0, 20, tzinfo=UTC))
    assert (wind_hour, totals_hour) == (datetime(2026, 10, 25, 0, tzinfo=UTC), datetime(2026, 10, 25, 1, tzinfo=UTC))
    assert weather == HourlyWeather(wind_mph=12.0, gust_mph=25.0, rain_in_hr=0.2, snow_in_hr=0.0)
    # On the hour: the hour that starts then, so a trip leaving at 00:00 is rated on 00:00-01:00.
    wind_hour, totals_hour, weather = series().at_eta(datetime(2026, 10, 25, 0, 0, tzinfo=UTC))
    assert (wind_hour, totals_hour) == (datetime(2026, 10, 25, 0, tzinfo=UTC), datetime(2026, 10, 25, 1, tzinfo=UTC))
    assert weather == HourlyWeather(wind_mph=12.0, gust_mph=25.0, rain_in_hr=0.2, snow_in_hr=0.0)
    # 23:40 the day before: wind and totals both stamped 00:00 (rain plus showers 0.1, gusts 20).
    wind_hour, totals_hour, weather = series().at_eta(datetime(2026, 10, 24, 23, 40, tzinfo=UTC))
    assert wind_hour == totals_hour == datetime(2026, 10, 25, 0, tzinfo=UTC)
    assert weather == HourlyWeather(wind_mph=12.0, gust_mph=20.0, rain_in_hr=0.1, snow_in_hr=0.0)
    # 00:30 rounds up for the wind too.
    wind_hour, totals_hour, weather = series().at_eta(datetime(2026, 10, 25, 0, 30, tzinfo=UTC))
    assert wind_hour == totals_hour == datetime(2026, 10, 25, 1, tzinfo=UTC)
    assert weather.wind_mph is None and weather.rain_in_hr == 0.2  # the 01:00 wind is missing


def test_an_eta_past_the_forecast_has_no_data():
    _, totals_hour, weather = series().at_eta(datetime(2026, 10, 25, 1, 10, tzinfo=UTC))  # rain stamped 02:00
    assert totals_hour == datetime(2026, 10, 25, 2, tzinfo=UTC)
    assert weather == HourlyWeather(wind_mph=None, gust_mph=None, rain_in_hr=None, snow_in_hr=None)


def test_lookups_work_from_any_time_zone():
    india = timezone(timedelta(hours=5, minutes=30))
    wind_hour, _, weather = series().at_eta(datetime(2026, 10, 25, 6, 20, tzinfo=india))  # 00:50 UTC
    assert wind_hour == datetime(2026, 10, 25, 1, 0, tzinfo=UTC)
    assert weather.gust_mph == 25.0
    assert series().at(datetime(2026, 10, 25, 5, 30, tzinfo=india)) is not None  # exactly 00:00 UTC


def test_forecast_points_are_snapped_to_a_0_02_degree_grid():
    assert forecast_point((32.7779765, -96.7962148)) == (32.78, -96.8)
    assert forecast_point((39.739, -104.989)) == (39.74, -104.98)  # the grid only has even hundredths
    assert forecast_point((-0.009, 0.011)) == (0.0, 0.02)
    assert str(forecast_point((-0.009, 0.011))[0]) == "0.0"  # never "-0.0" in cache keys or JSON
