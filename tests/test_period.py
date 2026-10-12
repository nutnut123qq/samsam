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


# ---------- v5.0 W50.1 giờ làm việc VN (SLA handoff WP07) ----------

SHIFT = {"start": "08:00", "end": "18:00", "workdays": [0, 1, 2, 3, 4],
         "holidays": []}
# 2026-10-12 là thứ Hai.
MON, TUE, FRI, SAT, SUN = 12, 13, 16, 17, 18


def _t(d, hh, mm=0, month=10):
    return datetime(2026, month, d, hh, mm, tzinfo=VN)


@pytest.mark.parametrize("start, hours, want", [
    (_t(FRI, 17, 59), 2, _t(19, 9, 59)),          # T6 17:59 → T2 09:59
    (_t(MON, 8), 2, _t(MON, 10)),
    (_t(MON, 7, 59), 2, _t(MON, 10)),             # trước ca → đầu ca
    (_t(MON, 18), 2, _t(TUE, 10)),                # 18:00 là ngoài ca
    (_t(MON, 16), 4, _t(TUE, 10)),
    (_t(SAT, 10), 4, _t(19, 12)),
    (_t(SUN, 23), 4, _t(19, 12)),
    (_t(MON, 17, 59), 0, _t(MON, 17, 59)),
    (_t(MON, 16), 2, _t(MON, 18)),                # vừa hết ca
])
def test_business_deadline_boundaries(start, hours, want):
    got = period.business_deadline(start, hours, SHIFT)
    assert got == want and got.utcoffset() == timedelta(hours=7)


def test_business_deadline_holiday_and_utc_input():
    hol = dict(SHIFT, holidays=["2026-10-12"])
    assert period.business_deadline(_t(MON, 8), 2, hol) == _t(TUE, 10)
    utc = datetime(2026, 10, 12, 1, 0, tzinfo=UTC)      # = 08:00 VN
    assert period.business_deadline(utc, 2, SHIFT) == \
        period.business_deadline(_t(MON, 8), 2, SHIFT)


def test_business_minutes():
    assert period.business_minutes(_t(FRI, 17), _t(19, 9), SHIFT) == 120
    assert period.business_minutes(_t(SAT, 9), _t(SUN, 17), SHIFT) == 0
    assert period.business_minutes(_t(MON, 17, 59), _t(MON, 18), SHIFT) == 1
    assert period.business_minutes(_t(MON, 10), _t(MON, 9), SHIFT) == 0
    assert period.business_minutes(_t(MON, 7), _t(MON, 8), SHIFT) == 0
    # 1 tuần đủ = 5 × 600 phút.
    assert period.business_minutes(_t(MON, 0), _t(19, 0), SHIFT) == 3000


def test_business_naive_rejected():
    naive = datetime(2026, 10, 12, 8, 0)  # noqa: DTZ001 — cố ý naive
    with pytest.raises(ValueError):
        period.business_deadline(naive, 2, SHIFT)
    with pytest.raises(ValueError):
        period.business_minutes(naive, _t(MON, 9), SHIFT)
    with pytest.raises(ValueError):
        period.business_minutes(_t(MON, 9), naive, SHIFT)


@pytest.mark.parametrize("mut", [
    {"end": "08:00"}, {"end": "07:00"}, {"workdays": []}, {"workdays": [7]},
    {"workdays": [1, 1]}, {"workdays": [True]}, {"start": "8:00"},
    {"start": "24:00"}, {"holidays": ["12/10/2026"]},
    {"holidays": ["2026-13-01"]}, {"holidays": ["20261012"]},
    {"holidays": [20261012]}, {"holidays": "2026-10-12"},
    {"holidays": ["2026-01-01"] * 367},
])
def test_parse_shift_rejects(mut):
    with pytest.raises(ValueError):
        period.parse_shift(dict(SHIFT, **mut))


def test_parse_shift_ok_and_idempotent():
    s = period.parse_shift(SHIFT)
    assert s["start_min"] == 480 and s["end_min"] == 1080
    assert period.parse_shift(s) is s
    with pytest.raises(ValueError):
        period.parse_shift(None)


def test_all_days_holiday_bounded():
    """Mọi ngày trong 400 ngày là lễ → ValueError (vòng có trần)."""
    import time
    d0 = date(2026, 10, 12)
    allhol = dict(SHIFT, workdays=[0], holidays=[
        (d0 + timedelta(days=7 * i)).isoformat() for i in range(60)])
    t0 = time.perf_counter()
    with pytest.raises(ValueError):
        period.business_deadline(_t(MON, 8), 2, allhol)
    assert time.perf_counter() - t0 < 1.0
