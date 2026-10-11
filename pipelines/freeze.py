"""Lịch đóng băng mùa cao điểm + break-glass (v3.10, luật đóng băng chung
flows_infra.md §5 — áp cho F17.1 deploy và F17.5 bật lại agent).

Hàm thuần: chỉ đọc 2 file (lịch `data/freeze_calendar.json` + log
break-glass theo env `BREAK_GLASS_LOG`), không ghi, không in, không DB.
Thời gian luôn nhận tham số (`now`/`when`) — test không dùng đồng hồ thật.

- `load_calendar(path)` → dict đã validate; hỏng → `FreezeConfigError`.
- `is_frozen(when, calendar=None)` — `when` là `date` (ngày VN) hoặc
  `datetime` CÓ múi giờ (đổi sang +07:00 rồi lấy ngày); naive →
  `ValueError`, kiểu khác → `TypeError`. Khung gồm cả 2 đầu.
- `check(change_kind, now, calendar=None, windows=None)` → (cho_phép, lý
  do). Kind lạ → `ValueError`. Trong đóng băng chỉ cho `allowed_in_freeze`
  (hotfix/disable/restore) hoặc khi có break-glass còn hạn.
  Lịch hỏng → FAIL-CLOSED: coi như đang đóng băng, chỉ cho hotfix/disable/
  restore, KHÔNG xét break-glass (không có trần giờ đáng tin) — không
  crash.
- `load_break_glass(path)` đọc log append-only (bytes + split `\\n`, dòng
  hỏng/thiếu key/giờ naive bị bỏ qua); `active_break_glass(records, now)`
  → cửa sổ còn hạn hoặc None. Hiệu lực khi `opened_at <= now <
  expires_at`, `expires_at` bị CẮT về `opened_at + break_glass_max_hours`
  (log sửa tay ghi 48h vẫn chỉ 4h), có record `close` trong
  [`opened_at`, `now`] → hết hiệu lực.

Điểm nối sau khi gộp nhánh v3.5: `deploy_gate.check()` thay khối
`cfg["freeze"]` bằng `freeze.check("hotfix" if hotfix else "feature",
now=datetime.combine(today, time(12), VN_TZ))`; F17.5 bật lại agent dùng
kind "restore".
"""

import json
import math
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CALENDAR = ROOT / "data" / "freeze_calendar.json"
VN_TZ = timezone(timedelta(hours=7))  # VN không DST — không cần tzdata
# Dùng khi lịch hỏng (fail-closed): vẫn cho sửa khẩn/tắt/khôi phục.
FALLBACK_ALLOWED = ("hotfix", "disable", "restore")
DEFAULT_BG_MAX_HOURS = 4
_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_ALLOWED_TEXT = "chỉ hotfix/tắt agent/khôi phục"


class FreezeConfigError(Exception):
    """Lịch đóng băng mất/hỏng/sai định dạng."""


def _day(value, field: str) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value  # lịch đã chuẩn hóa (validate_calendar idempotent)
    if not isinstance(value, str) or not _DAY_RE.fullmatch(value):
        raise FreezeConfigError(f"{field} phải dạng YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise FreezeConfigError(f"{field} không phải ngày hợp lệ") from e


def _str_list(cal: dict, key: str, allow_empty: bool) -> list[str]:
    v = cal.get(key)
    if (not isinstance(v, list) or (not v and not allow_empty)
            or not all(isinstance(x, str) and x.strip() for x in v)):
        raise FreezeConfigError(f"'{key}' phải là list chuỗi"
                                + ("" if allow_empty else " không rỗng"))
    return v


def validate_calendar(cal) -> dict:
    """Kiểm cấu trúc lịch; trả bản đã chuẩn hóa (ngày là `date`)."""
    if not isinstance(cal, dict):
        raise FreezeConfigError("lịch không phải object JSON")
    wins = cal.get("windows")
    if not isinstance(wins, list) or not wins:
        raise FreezeConfigError("'windows' thiếu hoặc rỗng")
    windows = []
    for i, w in enumerate(wins):
        if not isinstance(w, dict) or not isinstance(w.get("name"), str):
            raise FreezeConfigError(f"windows[{i}] thiếu name")
        start = _day(w.get("start"), f"windows[{i}].start")
        end = _day(w.get("end"), f"windows[{i}].end")
        if start > end:
            raise FreezeConfigError(f"windows[{i}] start > end")
        windows.append({"name": w["name"], "start": start, "end": end})
    known = _str_list(cal, "known_kinds", allow_empty=False)
    allowed = _str_list(cal, "allowed_in_freeze", allow_empty=False)
    stray = sorted(set(allowed) - set(known))
    if stray:
        raise FreezeConfigError(f"allowed_in_freeze có kind lạ: {stray}")
    holders = _str_list(cal, "break_glass_holders", allow_empty=True)
    hours = cal.get("break_glass_max_hours")
    if (isinstance(hours, bool) or not isinstance(hours, (int, float))
            or not math.isfinite(hours) or not 0 < hours <= 24):
        raise FreezeConfigError("break_glass_max_hours phải trong (0, 24]")
    return {"windows": windows, "known_kinds": list(known),
            "allowed_in_freeze": list(allowed),
            "break_glass_max_hours": hours,
            "break_glass_holders": list(holders)}


def load_calendar(path: Path | str | None = None) -> dict:
    p = Path(path) if path is not None else CALENDAR
    try:
        raw = p.read_bytes()
        cal = json.loads(raw.decode("utf-8"))
    except FileNotFoundError as e:
        raise FreezeConfigError(f"không có file lịch {p.name}") from e
    except (OSError, ValueError) as e:  # gồm JSON hỏng, file rỗng, UTF-8 lỗi
        raise FreezeConfigError(f"lịch {p.name} hỏng: {type(e).__name__}") \
            from e
    return validate_calendar(cal)


def _vn_day(when) -> date:
    if isinstance(when, datetime):
        if when.tzinfo is None or when.utcoffset() is None:
            raise ValueError("datetime phải có múi giờ (aware)")
        return when.astimezone(VN_TZ).date()
    if isinstance(when, date):
        return when
    raise TypeError("when phải là date hoặc datetime có múi giờ")


def _aware(now) -> datetime:
    if not isinstance(now, datetime):
        raise TypeError("now phải là datetime có múi giờ")
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now phải có múi giờ (aware)")
    return now


def frozen_window(when, calendar: dict | None = None) -> dict | None:
    day = _vn_day(when)
    cal = validate_calendar(calendar) if calendar is not None \
        else load_calendar()
    for w in cal["windows"]:
        if w["start"] <= day <= w["end"]:
            return w
    return None


def is_frozen(when, calendar: dict | None = None) -> bool:
    return frozen_window(when, calendar) is not None


# ---------- break-glass (reader; ghi ở scripts/break_glass.py) ----------

def _parse_dt(v) -> datetime | None:
    if not isinstance(v, str):
        return None
    try:
        d = datetime.fromisoformat(v)
    except ValueError:
        return None
    return d if d.tzinfo is not None and d.utcoffset() is not None else None


def _parse_record(obj) -> dict | None:
    if not isinstance(obj, dict):
        return None
    action = obj.get("action")
    by = obj.get("by")
    # `by` không in được (ký tự điều khiển/ANSI — log sửa tay) → bỏ record:
    # bỏ 1 record open chỉ làm GIẢM quyền (fail-closed).
    if not isinstance(by, str) or not by.strip() or not by.isprintable():
        return None
    if action == "open":
        opened, expires = _parse_dt(obj.get("opened_at")), \
            _parse_dt(obj.get("expires_at"))
        if opened is None or expires is None:
            return None
        return {"action": "open", "opened_at": opened, "expires_at": expires,
                "by": by, "reason": obj.get("reason"),
                "holder_verified": obj.get("holder_verified") is True}
    if action == "close":
        ts = _parse_dt(obj.get("ts"))
        if ts is None:
            return None
        return {"action": "close", "ts": ts, "by": by,
                "reason": obj.get("reason")}
    return None


def load_break_glass(path, bad: list | None = None) -> list[dict]:
    """Record hợp lệ trong log (thứ tự file). `bad` (tùy chọn) nhận số dòng
    bị bỏ qua để caller cảnh báo. File không có → []."""
    if not path:
        return []
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        return []
    out = []
    for n, line in enumerate(raw.split(b"\n"), 1):
        if not line.strip():
            continue
        try:
            rec = _parse_record(json.loads(line.decode("utf-8", "replace")))
        except ValueError:
            rec = None
        if rec is None:
            if bad is not None:
                bad.append(n)
            continue
        out.append(rec)
    return out


def active_windows(records: list[dict], now: datetime,
                   max_hours: float = DEFAULT_BG_MAX_HOURS) -> list[dict]:
    """Mọi cửa sổ còn hiệu lực tại `now` (expires đã cắt theo max_hours)."""
    now = _aware(now)
    closes = [r["ts"] for r in records if r["action"] == "close"]
    out = []
    for r in records:
        if r["action"] != "open":
            continue
        opened = r["opened_at"]
        expires = min(r["expires_at"], opened + timedelta(hours=max_hours))
        if not opened <= now < expires:
            continue
        if any(opened <= c <= now for c in closes):
            continue
        out.append({**r, "expires_at": expires})
    return sorted(out, key=lambda r: r["expires_at"])


def active_break_glass(records: list[dict], now: datetime,
                       max_hours: float = DEFAULT_BG_MAX_HOURS) -> dict | None:
    wins = active_windows(records, now, max_hours)
    return wins[-1] if wins else None


# ---------- quyết định ----------

def check(change_kind: str, now: datetime, calendar: dict | None = None,
          windows: list[dict] | None = None) -> tuple[bool, str]:
    """(cho_phép, lý do) cho 1 thay đổi loại `change_kind` tại `now`."""
    now = _aware(now)
    try:
        cal = validate_calendar(calendar) if calendar is not None \
            else load_calendar()
    except FreezeConfigError as e:
        if change_kind in FALLBACK_ALLOWED:
            return True, (f"lịch đóng băng lỗi ({e}) — fail-closed, "
                          f"'{change_kind}' vẫn được phép")
        return False, (f"lịch đóng băng lỗi ({e}) — fail-closed, coi như "
                       f"đang đóng băng: {_ALLOWED_TEXT}")
    if change_kind not in cal["known_kinds"]:
        raise ValueError(f"loại thay đổi lạ '{change_kind}' — dùng một trong "
                         f"{cal['known_kinds']}")
    w = frozen_window(now, cal)
    if w is None:
        return True, "ngoài khung đóng băng"
    span = f"{w['start']:%d/%m/%Y}–{w['end']:%d/%m/%Y} ({w['name']})"
    if change_kind in cal["allowed_in_freeze"]:
        return True, f"đang đóng băng {span} — '{change_kind}' được phép"
    if windows is None:
        windows = load_break_glass(os.environ.get("BREAK_GLASS_LOG"))
    bg = active_break_glass(windows, now, cal["break_glass_max_hours"])
    if bg is not None:
        exp = bg["expires_at"].astimezone(VN_TZ)
        return True, (f"đang đóng băng {span} — BREAK-GLASS mở bởi "
                      f"{bg['by']} tới {exp:%H:%M %d/%m/%Y}")
    return False, (f"đang đóng băng {span}: {_ALLOWED_TEXT} — "
                   f"'{change_kind}' bị chặn")
