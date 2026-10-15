"""Kỳ báo cáo theo giờ Việt Nam (v4.0, WP03) — nguồn DUY NHẤT cắt kỳ
ngày/tuần/tháng cho báo cáo + bản tin GĐ khối.

- `VN_TZ` = UTC+7 cố định (VN không DST — không cần tzdata).
- `period_bounds(kind, ref)` → `(start, end_excl)` aware +07:00; `kind` ∈
  `day|week|month` (tuần ISO: thứ Hai 00:00 VN). `ref` là `date` (ngày VN)
  hoặc `datetime` CÓ múi giờ (đổi sang VN rồi lấy ngày). Naive datetime →
  `ValueError` (luật "mix date local + giờ UTC" v2.4), kind lạ →
  `ValueError`, kiểu khác → `TypeError`.
- `rolling_bounds(days, until=None)` → `(since, until_excl)` cho kỳ trượt N
  ngày (`agents.report`): `until` date → hết ngày đó giờ VN (00:00 VN hôm
  sau, exclusive); None → now; datetime aware giữ nguyên; naive →
  `ValueError`.
"""

import re
from datetime import date, datetime, timedelta, timezone

VN_TZ = timezone(timedelta(hours=7))
KINDS = ("day", "week", "month")


def vn_date(ref) -> date:
    """Ngày VN của `ref` (date giữ nguyên; datetime aware đổi sang +07)."""
    if isinstance(ref, datetime):
        if ref.tzinfo is None or ref.utcoffset() is None:
            raise ValueError("datetime phải có múi giờ (aware)")
        return ref.astimezone(VN_TZ).date()
    if isinstance(ref, date):
        return ref
    raise TypeError("ref phải là date hoặc datetime có múi giờ")


def _midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=VN_TZ)


def period_bounds(kind: str, ref) -> tuple[datetime, datetime]:
    if kind not in KINDS:
        raise ValueError(f"kind '{kind}' lạ — dùng một trong {KINDS}")
    d = vn_date(ref)
    if kind == "day":
        start = d
        end = d + timedelta(days=1)
    elif kind == "week":
        start = d - timedelta(days=d.weekday())
        end = start + timedelta(days=7)
    else:
        start = d.replace(day=1)
        end = (date(d.year + 1, 1, 1) if d.month == 12
               else date(d.year, d.month + 1, 1))
    return _midnight(start), _midnight(end)


def rolling_bounds(days: int, until=None) -> tuple[datetime, datetime]:
    if until is None:
        until_excl = datetime.now(VN_TZ)
    elif isinstance(until, datetime):
        if until.tzinfo is None or until.utcoffset() is None:
            raise ValueError("until datetime phải có múi giờ (aware)")
        until_excl = until
    elif isinstance(until, date):
        until_excl = _midnight(until + timedelta(days=1))
    else:
        raise TypeError("until phải là date, datetime có múi giờ hoặc None")
    return until_excl - timedelta(days=days), until_excl


# ---------------------------------------------------------------------------
# v5.0 W50.1 — giờ làm việc VN cho SLA handoff (WP07). Ngoài ca đồng hồ SLA
# DỪNG, bắt đầu lại từ đầu ca kế tiếp. Ca cấu hình (`data/directors/
# sales.json` khóa `business_hours`) — bản ship là GIẢ ĐỊNH 08:00–18:00 thứ
# Hai–thứ Sáu, chưa có lịch lễ (GĐ KD chốt = external-dep).
#   shift = {"start": "HH:MM", "end": "HH:MM", "workdays": [0..6],
#            "holidays": ["YYYY-MM-DD", ...]}   (0 = thứ Hai)
# Không hỗ trợ ca qua đêm (start < end cùng ngày). Vòng quét ngày có trần
# MAX_SCAN_DAYS — lịch mà mọi ngày đều nghỉ → ValueError, không lặp vô hạn.
# ---------------------------------------------------------------------------

MAX_SCAN_DAYS = 400
MAX_HOLIDAYS = 366
_HHMM_RE = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")
_ISO_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _hhmm(v, key: str) -> int:
    m = _HHMM_RE.fullmatch(v) if isinstance(v, str) else None
    if not m:
        raise ValueError(f"ca làm việc: '{key}' phải dạng HH:MM (00:00–23:59)")
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_shift(cfg) -> dict:
    """Kiểm + chuẩn hóa ca → {"start_min", "end_min", "workdays"
    (frozenset), "holidays" (frozenset date)}. Sai → ValueError."""
    if isinstance(cfg, dict) and "start_min" in cfg:
        return cfg                      # đã chuẩn hóa
    if not isinstance(cfg, dict):
        raise ValueError("ca làm việc phải là object JSON")  # noqa: TRY004
    start = _hhmm(cfg.get("start"), "start")
    end = _hhmm(cfg.get("end"), "end")
    if end <= start:
        raise ValueError("ca làm việc: 'end' phải sau 'start' cùng ngày "
                         "(không hỗ trợ ca qua đêm)")
    wd = cfg.get("workdays")
    if (not isinstance(wd, list) or not wd
            or not all(isinstance(d, int) and not isinstance(d, bool)
                       and 0 <= d <= 6 for d in wd)
            or len(set(wd)) != len(wd)):
        raise ValueError("ca làm việc: 'workdays' phải là list ≥1 số 0..6 "
                         "không trùng (0 = thứ Hai)")
    hol = cfg.get("holidays", [])
    if not isinstance(hol, list) or len(hol) > MAX_HOLIDAYS:
        raise ValueError(f"ca làm việc: 'holidays' phải là list ≤ "
                         f"{MAX_HOLIDAYS} ngày")
    days = set()
    for h in hol:
        try:
            if not (isinstance(h, str) and _ISO_DAY_RE.fullmatch(h)):
                raise ValueError
            days.add(date.fromisoformat(h))
        except ValueError:
            raise ValueError(f"ca làm việc: ngày nghỉ {h!r} sai định dạng "
                             "YYYY-MM-DD") from None
    return {"start_min": start, "end_min": end, "workdays": frozenset(wd),
            "holidays": frozenset(days)}


def _aware_vn(ts: datetime, name: str) -> datetime:
    if not isinstance(ts, datetime):
        raise TypeError(f"{name} phải là datetime có múi giờ")
    if ts.tzinfo is None or ts.utcoffset() is None:
        raise ValueError(f"{name} phải có múi giờ (aware) — không trộn giờ "
                         "local naive với UTC")
    return ts.astimezone(VN_TZ)


def _window(d: date, s: dict):
    """(đầu ca, cuối ca) của ngày `d` giờ VN, None nếu ngày nghỉ."""
    if d.weekday() not in s["workdays"] or d in s["holidays"]:
        return None
    base = _midnight(d)
    return (base + timedelta(minutes=s["start_min"]),
            base + timedelta(minutes=s["end_min"]))


def business_deadline(start: datetime, hours, shift) -> datetime:
    """`start` + N giờ LÀM VIỆC (start ngoài ca → đếm từ đầu ca kế tiếp)
    → datetime aware +07:00."""
    s = parse_shift(shift)
    cur = _aware_vn(start, "start")
    if (isinstance(hours, bool) or not isinstance(hours, (int, float))
            or hours < 0):
        raise ValueError("hours phải là số ≥ 0")
    left = timedelta(hours=hours)
    d = cur.date()
    for _ in range(MAX_SCAN_DAYS):
        w = _window(d, s)
        if w is not None:
            begin = max(cur, w[0])
            if begin < w[1]:
                if left <= w[1] - begin:
                    return begin + left
                left -= w[1] - begin
        d += timedelta(days=1)
    raise ValueError(f"không tìm được giờ làm việc trong {MAX_SCAN_DAYS} "
                     "ngày — kiểm tra workdays/holidays")


def business_minutes(a: datetime, b: datetime, shift) -> int:
    """Số phút làm việc trong [a, b) (b <= a → 0). Chi phí O(số ngày của
    khoảng) — so "đã quá N giờ làm việc chưa" thì dùng `business_deadline`
    (quét tiến, có trần), không đếm khoảng dài từ input ngoài."""
    s = parse_shift(shift)
    a, b = _aware_vn(a, "a"), _aware_vn(b, "b")
    if b <= a:
        return 0
    total = timedelta(0)
    d = a.date()
    while d <= b.date():
        w = _window(d, s)
        if w is not None:
            lo, hi = max(a, w[0]), min(b, w[1])
            if hi > lo:
                total += hi - lo
        d += timedelta(days=1)
    return int(total.total_seconds() // 60)
