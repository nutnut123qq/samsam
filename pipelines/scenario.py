"""Engine kịch bản mùa DÙNG CHUNG (v7.3, WP09 Season Forecast).

KD-A10 (dự báo mùa), SX-A3 (phân bổ tồn Tết) và FP-Cash (dòng tiền 13
tuần × 3 kịch bản) GỌI LẠI `project()` — không viết lại công thức.

Hàm THUẦN: không DB, không LLM, không mạng, không đọc đồng hồ (ngoài
`main()`). Kết quả luôn là KHOẢNG thấp/cơ sở/cao — không bao giờ 1 con số.

API công khai:
  LEVELS, OFFLINE, TET_DATES
  tet_date(year) -> date            (bảng hằng, năm ngoài bảng -> lỗi)
  week_start(d) -> date             (thứ Hai của tuần chứa d)
  load_assumptions(path=None) -> dict   (validate, raise ScenarioError)
  project(sku, channel, start, weeks, assumptions) -> list[dict]
    mỗi phần tử {"week_start": date, "events": [id...],
                 "low": int, "base": int, "high": int, "note": str|None}

Công thức: baseline[sku][kênh] × trend[mức] × max(hệ số sự kiện[mức] các
sự kiện phủ tuần đó, mặc định 1) — chồng tuần lấy MAX (không nhân chồng),
làm tròn bất đối xứng: thấp = floor, cơ sở = floor(x+0.5), cao = ceil
(đơn điệu -> giữ thấp <= cơ sở <= cao; thấp < cao khi trend thấp < cao, kể
cả baseline nhỏ). Sự kiện có `channels` chỉ áp cho các kênh đó (11.11 /
12.12 = ngày sale sàn -> chỉ kênh online; Tết áp mọi kênh).

Luật kênh (đặt TRƯỚC tra baseline):
  - rượu (`category == "alcohol"`) × kênh online (golden CHANNELS) -> 0,
    BẤT KỂ allowed_channels (golden còn ghi ["shopee"] cho rượu — lệch v3.2).
  - SKU không rượu × kênh online ngoài allowed_channels -> 0 + ghi chú.
  - `offline` (đại lý/cửa hàng) tính cho mọi SKU.
  - Thiếu baseline cho SKU×kênh được phép -> lỗi (không coi = 0).

CLI: python -m pipelines.scenario --sku X --channel Y --weeks 13
     [--start YYYY-MM-DD] [--json]   (exit 0 OK / 1 lỗi dữ liệu / 2 usage)
"""

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

from ingest import golden_store

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ASSUMPTIONS_FILE = ROOT / "data" / "scenario_assumptions.json"
GOLDEN_FILE = golden_store.GOLDEN_FILE

LEVELS = ("low", "base", "high")
OFFLINE = "offline"
ALL_CHANNELS = golden_store.CHANNELS + (OFFLINE,)
MAX_WEEKS = 104
# Khung ngày hợp lệ cho start/ngày sự kiện: ngày sát biên `date` (0001 /
# 9999) cộng offset tuần -> OverflowError ngoài ScenarioError (traceback).
DATE_MIN = dt.date(2000, 1, 1)
DATE_MAX = dt.date(2100, 12, 31)

# Mùng 1 Tết Âm lịch (dương lịch) — lịch âm Việt Nam (UTC+7), đối chiếu
# lịch vạn niên/Viện Vật lý thiên văn: Bính Ngọ 17/02/2026, Đinh Mùi
# 06/02/2027, Mậu Thân 26/01/2028. Năm ngoài bảng -> lỗi rõ, không đoán.
TET_DATES = {
    2026: dt.date(2026, 2, 17),
    2027: dt.date(2027, 2, 6),
    2028: dt.date(2028, 1, 26),
}

NOTE_ALCOHOL = "rượu: chỉ kênh offline"
NOTE_NOT_ALLOWED = "kênh chưa có trong allowed_channels (golden)"


# Dấu "đã validate" — object riêng, JSON không giả được (doc thô ghi
# "_validated": true vẫn bị validate lại).
_VALIDATED = object()


class ScenarioError(ValueError):
    """Config/tham số kịch bản không dùng được — fail-closed."""


def tet_date(year: int) -> dt.date:
    # int thật (không bool/float/list): 2027.0 hash bằng 2027 nên phải chặn
    # kiểu TRƯỚC khi tra bảng; list -> TypeError unhashable.
    if (isinstance(year, bool) or not isinstance(year, int)
            or year not in TET_DATES):
        raise ScenarioError(f"chưa có ngày Tết năm {year} trong TET_DATES")
    return TET_DATES[year]


def week_start(d: dt.date) -> dt.date:
    if isinstance(d, dt.datetime):
        d = d.date()
    return d - dt.timedelta(days=d.weekday())


def _num(v, where: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ScenarioError(f"{where}: phải là số")
    try:
        f = float(v)   # int khổng lồ (10**400) -> OverflowError
    except OverflowError as e:
        raise ScenarioError(f"{where}: số quá lớn") from e
    if not math.isfinite(f) or f < 0:
        raise ScenarioError(f"{where}: phải là số hữu hạn >= 0")
    return f


def _levels(row, where: str) -> dict:
    if not isinstance(row, dict):
        raise ScenarioError(f"{where}: phải là object low/base/high")
    v = {lv: _num(row.get(lv), f"{where}.{lv}") for lv in LEVELS}
    if not v["low"] <= v["base"] <= v["high"]:
        raise ScenarioError(f"{where}: phải low <= base <= high")
    return v


def _event_date(ev: dict, where: str) -> dt.date:
    has_d, has_t = "date" in ev, "lunar_new_year" in ev
    if has_d == has_t:
        raise ScenarioError(f"{where}: cần đúng 1 trong 'date' / 'lunar_new_year'")
    if has_t:
        return tet_date(ev["lunar_new_year"])
    try:
        d = dt.date.fromisoformat(ev["date"])
    except (TypeError, ValueError) as e:
        raise ScenarioError(f"{where}.date: không phải ngày ISO") from e
    if not DATE_MIN <= d <= DATE_MAX:
        raise ScenarioError(f"{where}.date: phải trong {DATE_MIN}..{DATE_MAX}")
    return d


def validate_assumptions(doc) -> dict:
    """Validate + chuẩn hóa. Trả {"_validated", "status", "trend",
    "baseline", "events": [(id, {week_start: levels})]}. Raise
    ScenarioError."""
    if not isinstance(doc, dict):
        raise ScenarioError("giả định: root phải là object")
    if not (set(doc) - {"_doc"}):
        raise ScenarioError("giả định: không có dữ liệu (0 record)")
    status = doc.get("status")
    if not isinstance(status, str) or not status.strip():
        raise ScenarioError("giả định: thiếu 'status'")
    trend = _levels(doc.get("trend"), "trend")
    base = doc.get("baseline_units_per_week")
    if not isinstance(base, dict) or not base:
        raise ScenarioError("giả định: 'baseline_units_per_week' rỗng/thiếu")
    baseline = {}
    for sku, chans in base.items():
        if not isinstance(chans, dict) or not chans:
            raise ScenarioError(f"baseline.{sku}: phải là object kênh -> số")
        for ch, v in chans.items():
            if ch not in ALL_CHANNELS:
                raise ScenarioError(f"baseline.{sku}.{ch}: kênh không hợp lệ")
            baseline.setdefault(sku, {})[ch] = _num(v, f"baseline.{sku}.{ch}")
    events_raw = doc.get("events")
    if not isinstance(events_raw, list):
        raise ScenarioError("giả định: 'events' phải là list")
    events, ids = [], set()
    for i, ev in enumerate(events_raw):
        where = f"events[{i}]"
        if not isinstance(ev, dict):
            raise ScenarioError(f"{where}: phải là object")
        eid = ev.get("id")
        if not isinstance(eid, str) or not eid or eid in ids:
            raise ScenarioError(f"{where}.id: thiếu hoặc trùng")
        ids.add(eid)
        ws = week_start(_event_date(ev, where))
        chans = ev.get("channels")
        if chans is not None:
            # Sự kiện chỉ áp cho 1 số kênh (11.11/12.12 = ngày sale sàn,
            # không đẩy cầu đại lý offline). Thiếu key = mọi kênh.
            if (not isinstance(chans, list) or not chans
                    or not all(isinstance(c, str) for c in chans)
                    or not set(chans) <= set(ALL_CHANNELS)
                    or len(set(chans)) != len(chans)):
                raise ScenarioError(f"{where}.channels: phải là list kênh "
                                    "hợp lệ, không rỗng, không trùng")
            chans = frozenset(chans)
        win = ev.get("window")
        if not isinstance(win, list) or not win:
            raise ScenarioError(f"{where}.window: rỗng/thiếu")
        weeks = {}
        for j, row in enumerate(win):
            off = row.get("offset") if isinstance(row, dict) else None
            if (isinstance(off, bool) or not isinstance(off, int)
                    or abs(off) > MAX_WEEKS):
                raise ScenarioError(f"{where}.window[{j}].offset: phải là int "
                                    f"trong -{MAX_WEEKS}..{MAX_WEEKS}")
            w = ws + dt.timedelta(weeks=off)
            if w in weeks:
                raise ScenarioError(f"{where}.window[{j}].offset: trùng")
            weeks[w] = _levels(row, f"{where}.window[{j}]")
        events.append((eid, weeks, chans))
    return {"_validated": _VALIDATED, "status": status, "trend": trend,
            "baseline": baseline, "events": events}


def load_assumptions(path=None) -> dict:
    """Đọc + validate file giả định. Mọi biến thể 'không có dữ liệu'
    (thiếu / rỗng / JSON hỏng / `{}` / chỉ `_doc`) -> ScenarioError."""
    p = Path(path) if path else ASSUMPTIONS_FILE
    try:
        text = p.read_bytes().decode("utf-8-sig")
    except FileNotFoundError as e:
        raise ScenarioError(f"thiếu file giả định {p.name}") from e
    except (OSError, UnicodeDecodeError) as e:
        raise ScenarioError(f"không đọc được {p.name} ({type(e).__name__})") from e
    if not text.strip():
        raise ScenarioError(f"{p.name} rỗng")
    try:
        # NaN/Infinity: json chấp nhận mặc định -> chặn tường minh.
        doc = json.loads(text, parse_constant=_reject_constant)
    except ValueError as e:
        raise ScenarioError(f"{p.name} JSON hỏng: {e}") from e
    return validate_assumptions(doc)


def _reject_constant(name):
    raise ValueError(f"hằng {name} không hợp lệ")


def _norm(assumptions: dict) -> dict:
    """Nhận bản đã validate (load_assumptions) hoặc doc thô."""
    if (isinstance(assumptions, dict)
            and assumptions.get("_validated") is _VALIDATED):
        return assumptions
    return validate_assumptions(assumptions)


def project(sku: dict, channel: str, start: dt.date, weeks: int,
            assumptions: dict) -> list[dict]:
    if channel not in ALL_CHANNELS:
        raise ScenarioError(f"kênh '{channel}' không hợp lệ")
    if isinstance(weeks, bool) or not isinstance(weeks, int) \
            or not 1 <= weeks <= MAX_WEEKS:
        raise ScenarioError(f"weeks phải trong 1..{MAX_WEEKS}")
    if not isinstance(start, dt.date):
        raise ScenarioError("start phải là date")
    if not isinstance(sku, dict) or not sku.get("sku_key"):
        raise ScenarioError("sku thiếu sku_key")
    a = _norm(assumptions)
    key = sku["sku_key"]
    note = None
    if channel in golden_store.CHANNELS:
        if sku.get("category") == "alcohol":
            note = NOTE_ALCOHOL
        elif channel not in (sku.get("allowed_channels") or []):
            note = NOTE_NOT_ALLOWED
    if note is None:
        b = a["baseline"].get(key, {}).get(channel)
        if b is None:
            raise ScenarioError(f"thiếu baseline cho {key} × {channel}")
    d0 = start.date() if isinstance(start, dt.datetime) else start
    if not DATE_MIN <= d0 <= DATE_MAX:
        raise ScenarioError(f"start phải trong {DATE_MIN}..{DATE_MAX}")
    w0 = week_start(d0)
    out = []
    for i in range(weeks):
        w = w0 + dt.timedelta(weeks=i)
        hits = [(eid, wk[w]) for eid, wk, chans in a["events"]
                if w in wk and (chans is None or channel in chans)]
        row = {"week_start": w, "events": [eid for eid, _ in hits],
               "note": note}
        for lv in LEVELS:
            if note is not None:
                row[lv] = 0
                continue
            f = max((h[lv] for _, h in hits), default=1.0)
            x = b * a["trend"][lv] * f
            if not math.isfinite(x):
                raise ScenarioError(f"{key} × {channel}: kết quả tràn số "
                                    "(giả định quá lớn)")
            # round 6 số lẻ khử nhiễu float (20*1.15=22.999...) trước khi
            # làm tròn bất đối xứng: thấp=floor, cao=ceil, cơ sở=nửa-lên
            # -> vẫn đơn điệu VÀ thấp < cao khi trend.low < trend.high
            # (baseline nhỏ không sập khoảng thành 1 điểm).
            x = round(x, 6)
            row[lv] = (math.floor(x) if lv == "low" else
                       math.ceil(x) if lv == "high" else math.floor(x + 0.5))
        out.append(row)
    return out


# ---------- CLI ----------

def _weeks_arg(s: str) -> int:
    try:
        n = int(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("phải là số nguyên") from e
    if not 1 <= n <= MAX_WEEKS:
        raise argparse.ArgumentTypeError(f"phải trong 1..{MAX_WEEKS}")
    return n


def _date_arg(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from e
    if not DATE_MIN <= d <= DATE_MAX:
        raise argparse.ArgumentTypeError(f"ngày phải trong {DATE_MIN}..{DATE_MAX}")
    return d


def _err(msg: str) -> int:
    print(f"[err] {msg}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.scenario",
        description="Kịch bản mùa thấp/cơ sở/cao theo SKU × kênh × tuần")
    ap.add_argument("--sku", required=True, help="sku_key trong golden")
    ap.add_argument("--channel", required=True, choices=ALL_CHANNELS)
    ap.add_argument("--weeks", type=_weeks_arg, default=13)
    ap.add_argument("--start", type=_date_arg,
                    help="ngày bắt đầu (mặc định thứ Hai tuần này, giờ VN)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    doc, why = golden_store.read_golden(GOLDEN_FILE)
    if doc is None:
        return _err(f"golden: {why}")
    errs = golden_store.validate(doc)
    if errs:
        return _err(f"golden không hợp lệ ({len(errs)} lỗi), lỗi đầu: {errs[0]}")
    sku = next((s for s in doc["skus"]
                if isinstance(s, dict) and s.get("sku_key") == args.sku), None)
    if sku is None:
        return _err(f"SKU '{args.sku}' không có trong golden")
    start = args.start or (
        dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date())
    try:
        a = load_assumptions()
        rows = project(sku, args.channel, start, args.weeks, a)
    except ScenarioError as e:
        return _err(str(e))

    head = (f"{a['status']}\nKhoảng thấp/cơ sở/cao — KHÔNG phải doanh số "
            "cam kết (đơn vị/tuần)")
    if args.json:
        print(head, file=sys.stderr)
        print(json.dumps([{**r, "week_start": r["week_start"].isoformat()}
                          for r in rows], ensure_ascii=False))
        return 0
    print(head)
    print(f"SKU {args.sku} · kênh {args.channel} · {args.weeks} tuần")
    print("tuần | sự kiện | thấp | cơ sở | cao | ghi chú")
    for r in rows:
        print(f"{r['week_start'].isoformat()} | {','.join(r['events']) or '-'}"
              f" | {r['low']} | {r['base']} | {r['high']} | {r['note'] or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
