"""v4.0 W40.5 — `pipelines.period`: kỳ ngày/tuần/tháng theo giờ VN (tuần
vắt 2 tháng, vắt năm, ranh giới 00:00 VN) + `rolling_bounds` cho report."""

from datetime import date, datetime, timedelta, timezone

import pytest

from pipelines import period

UTC = timezone.utc
VN = timezone(timedelta(hours=7))


def _vn(y, m, d):
    return datetime(y, m, d, tzinfo=VN)


def test_vn_tz_is_plus7():
    assert period.VN_TZ.utcoffset(None) == timedelta(hours=7)


def test_week_spanning_two_months():
    assert period.period_bounds("week", date(2026, 10, 1)) == (
        _vn(2026, 9, 28), _vn(2026, 10, 5))


def test_week_spanning_year():
    assert period.period_bounds("week", date(2027, 1, 1)) == (
        _vn(2026, 12, 28), _vn(2027, 1, 4))


@pytest.mark.parametrize("ref,start", [
    (datetime(2026, 9, 27, 16, 59, 59, tzinfo=UTC), _vn(2026, 9, 21)),
    (datetime(2026, 9, 27, 17, 0, tzinfo=UTC), _vn(2026, 9, 28)),
])
def test_week_boundary_midnight_vn(ref, start):
    s, e = period.period_bounds("week", ref)
    assert s == start and e - s == timedelta(days=7)
    assert s.utcoffset() == timedelta(hours=7)


def test_month_boundary_new_year_vn():
    # 17:00 UTC 31/12 = 00:00 01/01 VN → tháng 01/2027.
    assert period.period_bounds(
        "month", datetime(2026, 12, 31, 17, 0, tzinfo=UTC)) == (
        _vn(2027, 1, 1), _vn(2027, 2, 1))
    assert period.period_bounds(
        "month", datetime(2026, 12, 31, 16, 59, tzinfo=UTC)) == (
        _vn(2026, 12, 1), _vn(2027, 1, 1))
    assert period.period_bounds("month", date(2027, 2, 15)) == (
        _vn(2027, 2, 1), _vn(2027, 3, 1))


def test_day_of_utc_evening_is_vn_day():
    assert period.period_bounds(
        "day", datetime(2026, 10, 11, 16, 59, tzinfo=UTC)) == (
        _vn(2026, 10, 11), _vn(2026, 10, 12))
    assert period.period_bounds(
        "day", datetime(2026, 10, 11, 17, 0, tzinfo=UTC)) == (
        _vn(2026, 10, 12), _vn(2026, 10, 13))


def test_bad_inputs():
    naive = datetime(2026, 10, 1, 12, 0)  # noqa: DTZ001 — cố ý naive
    with pytest.raises(ValueError):
        period.period_bounds("week", naive)
    with pytest.raises(ValueError):
        period.period_bounds("quarter", date(2026, 10, 1))
    with pytest.raises(TypeError):
        period.period_bounds("day", "2026-10-01")
    with pytest.raises(ValueError):
        period.rolling_bounds(7, naive)
    with pytest.raises(TypeError):
        period.rolling_bounds(7, "2026-10-10")


def test_rolling_bounds():
    assert period.rolling_bounds(7, date(2026, 10, 10)) == (
        _vn(2026, 10, 4), _vn(2026, 10, 11))
    aware = datetime(2026, 10, 11, 5, 30, tzinfo=UTC)
    assert period.rolling_bounds(7, aware) == (
        aware - timedelta(days=7), aware)
    s, e = period.rolling_bounds(1)
    assert e.utcoffset() == timedelta(hours=7)
    assert e - s == timedelta(days=1)
    assert abs((datetime.now(UTC) - e).total_seconds()) < 60
