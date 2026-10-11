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
