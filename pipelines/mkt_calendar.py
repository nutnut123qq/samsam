"""MKT-01 Agent Lịch mùa vụ (v6.0, WP08) — lịch chiến dịch ĐỀ XUẤT.

Hàm THUẦN (không DB, không LLM, không mạng, không đọc đồng hồ ngoài
`main()`): đọc `data/marketing_calendar.json` (GIẢ ĐỊNH — chờ GĐ Marketing
chốt) + golden SKU → mỗi chiến dịch × kênh × định dạng có SKU đủ
readiness, mốc brief/nháp/duyệt/đăng LÙI từ ngày đăng theo SLA (giờ VN, né
T7/CN/ngày nghỉ), nhắc trước 14/7/3 ngày; xuất markdown tuần/tháng + .ics.

Luật:
  - Tết lấy từ `pipelines.scenario.tet_date` (JSON ghi `lunar_new_year`) —
    không có ngày Tết thứ hai ở đây.
  - Rượu (`category == "alcohol"`) KHÔNG BAO GIỜ vào ô nào (mọi kênh golden
    đều online) — luôn vào `blocked`, kể cả khi golden ghi
    `allowed_channels: ["shopee"]` (lệch đã biết v3.2).
  - Readiness = `guardrail._readiness_of` (soi gương view `sku_readiness`):
    `listing` nhận MO_TA|TP_THUONG|QC_DAY_DU; post/ads/koc/livestream chỉ
    TP_THUONG|QC_DAY_DU.
  - Mốc chỉ LÙI (`to_workday`), không bao giờ đẩy muộn hơn. SLA brief đọc
    từ `data/directors/marketing.json` (`campaign_brief.sla_hours`).
  - Config hỏng (thiếu/rỗng/JSON hỏng/`{}`/chỉ `_doc`/sai luật) →
    `CalendarError` — không bao giờ ra lịch rỗng câm.
  - v13.6 `daily_candidates(cal, golden, day, sla)` (THUẦN) — ứng viên chủ
    đề cho "3 bài/ngày" (PL01 Marketing): ô `post` của chiến dịch có mốc
    NHÁP rơi đúng ngày VN `day` đứng trước, rồi trụ thường ngày
    `daily_posts.evergreen` (xoay vòng theo ngày). Trụ gắn SKU mà không SKU
    nào đủ readiness kênh (hoặc chỉ có rượu) → ứng viên mang `reason` (bị
    từ chối, KHÔNG thay bằng SKU khác để đủ số). Thiếu `daily_posts` →
    `CalendarError`.

CLI: python -m pipelines.mkt_calendar [--start YYYY-MM-DD] [--weeks 4]
     [--by week|month] [--ics [PATH]] [--json]
Exit: 0 OK · 1 lịch/golden/cấu hình director hỏng · 2 usage. Không DB.
"""

import argparse
import json
import re
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from agents.report import REPORTS_DIR, write_report
from ingest import golden_store
from pipelines import director, scenario
from pipelines.guardrail import _readiness_of
from pipelines.period import VN_TZ

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CALENDAR_FILE = ROOT / "data" / "marketing_calendar.json"
FORMATS = ("listing", "post", "ads", "koc", "livestream")
KINDS = ("sale", "holiday", "tet", "harvest")
MILESTONES = ("brief", "draft", "approve", "publish")
MILESTONE_VN = {"brief": "brief", "draft": "nháp", "approve": "duyệt",
                "publish": "đăng"}
LISTING_OK = ("MO_TA", "TP_THUONG", "QC_DAY_DU")
CONTENT_OK = ("TP_THUONG", "QC_DAY_DU")
NEED_SKU = ("listing", "ads", "koc")      # không SKU → bỏ ô
BRAND_NOTE = "câu chuyện thương hiệu — không nêu tên SKU"
REASON_ALCOHOL = "rượu: không kênh online"
MAX_WEEKS = 26
DAILY_MAX = 9                              # khóa slot 1 chữ số (content.py)
DAILY_CHANNELS = ("facebook", "zalo", "tiktok", "web")   # kênh bài đăng
_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,39}")
_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class CalendarError(ValueError):
    """Lịch mùa vụ thiếu/hỏng/sai luật — fail-closed."""


# ---------- loader ----------

def _int(v, where: str, lo: int, hi: int) -> int:
    # bool là int trong Python; NaN/float/str bị chặn vì không phải int.
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise CalendarError(f"{where}: phải là số nguyên {lo}..{hi}, nhận"
                            f" {v!r}")
    return v


def _iso(v, where: str) -> date:
    if not isinstance(v, str) or not _ISO_RE.fullmatch(v):
        raise CalendarError(f"{where}: cần ngày YYYY-MM-DD, nhận {v!r}")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise CalendarError(f"{where}: ngày không hợp lệ {v!r}") from None


def _id(v, where: str) -> str:
    if not isinstance(v, str) or not _ID_RE.fullmatch(v):
        raise CalendarError(f"{where}: id phải khớp {_ID_RE.pattern}")
    return v


def event_date(ev: dict) -> date:
    """Ngày dương lịch của sự kiện. Tết qua `scenario.tet_date` — năm ngoài
    `TET_DATES` → `CalendarError` (không đoán)."""
    if not isinstance(ev, dict):
        raise CalendarError("sự kiện phải là object")
    where = f"events[{ev.get('id')!r}]"
    has_d, has_t = "date" in ev, "lunar_new_year" in ev
    if has_d == has_t:
        raise CalendarError(f"{where}: cần đúng 1 trong 'date' /"
                            " 'lunar_new_year'")
    if has_t:
        try:
            d = scenario.tet_date(ev["lunar_new_year"])
        except scenario.ScenarioError as e:
            raise CalendarError(f"{where}: {e}") from None
    else:
        d = _iso(ev["date"], f"{where}.date")
        if not scenario.DATE_MIN <= d <= scenario.DATE_MAX:
            raise CalendarError(f"{where}.date: ngoài {scenario.DATE_MIN}.."
                                f"{scenario.DATE_MAX}")
    off = ev.get("offset_days", 0)
    return d + timedelta(days=_int(off, f"{where}.offset_days", -60, 60))


def validate(cal) -> dict:
    if not isinstance(cal, dict):
        raise CalendarError("lịch phải là object JSON")
    if not isinstance(cal.get("status"), str) or not cal["status"].strip():
        raise CalendarError("thiếu 'status' (GIẢ ĐỊNH / đã chốt)")
    lead = cal.get("lead")
    if not isinstance(lead, dict):
        raise CalendarError("thiếu 'lead'")
    _int(lead.get("publish_hour"), "lead.publish_hour", 0, 23)
    _int(lead.get("approve_buffer_hours"), "lead.approve_buffer_hours", 1,
         720)
    _int(lead.get("draft_review_hours"), "lead.draft_review_hours", 1, 720)
    ws = _int(lead.get("work_start_hour"), "lead.work_start_hour", 0, 23)
    we = _int(lead.get("work_end_hour"), "lead.work_end_hour", 0, 23)
    if ws >= we:
        raise CalendarError("lead: work_start_hour phải < work_end_hour")
    nwd = cal.get("non_working_days", [])
    if not isinstance(nwd, list):
        raise CalendarError("non_working_days phải là list")
    for i, d in enumerate(nwd):
        _iso(d, f"non_working_days[{i}]")
    rd = cal.get("reminder_days")
    if not isinstance(rd, list) or not rd:
        raise CalendarError("reminder_days rỗng")
    for i, n in enumerate(rd):
        _int(n, f"reminder_days[{i}]", 1, 60)
    caps = cal.get("review_caps")
    if not isinstance(caps, dict):
        raise CalendarError("thiếu 'review_caps'")
    _int(caps.get("gd_marketing_daily"), "review_caps.gd_marketing_daily",
         0, 500)

    events = cal.get("events")
    if not isinstance(events, list) or not events:
        raise CalendarError("events rỗng")
    ev_ids = set()
    for i, ev in enumerate(events):
        where = f"events[{i}]"
        if not isinstance(ev, dict):
            raise CalendarError(f"{where}: phải là object")
        eid = _id(ev.get("id"), f"{where}.id")
        if eid in ev_ids:
            raise CalendarError(f"{where}: id sự kiện trùng '{eid}'")
        ev_ids.add(eid)
        if ev.get("kind") not in KINDS:
            raise CalendarError(f"{where}: kind phải {KINDS}")
        if not isinstance(ev.get("remind"), bool):
            raise CalendarError(f"{where}: remind phải true/false")
        if ev["kind"] == "harvest" and (
                not isinstance(ev.get("status"), str)
                or "GIẢ ĐỊNH" not in ev["status"]):
            raise CalendarError(f"{where}: mùa thu hoạch thiếu 'status' GIẢ"
                                " ĐỊNH (chờ GĐ vùng trồng xác nhận)")
        offs = ev.get("off_days", [])
        if not isinstance(offs, list):
            raise CalendarError(f"{where}.off_days phải là list")
        for j, o in enumerate(offs):
            _int(o, f"{where}.off_days[{j}]", -15, 15)
        event_date(ev)

    camps = cal.get("campaigns")
    if not isinstance(camps, list) or not camps:
        raise CalendarError("campaigns rỗng")
    c_ids = set()
    for i, c in enumerate(camps):
        where = f"campaigns[{i}]"
        if not isinstance(c, dict):
            raise CalendarError(f"{where}: phải là object")
        cid = _id(c.get("id"), f"{where}.id")
        if cid in c_ids:
            raise CalendarError(f"{where}: id chiến dịch trùng '{cid}'")
        c_ids.add(cid)
        if c.get("event") not in ev_ids:
            raise CalendarError(f"{where}: event {c.get('event')!r} không"
                                " có trong events")
        _int(c.get("publish_offset_days"), f"{where}.publish_offset_days",
             -60, 0)
        chs = c.get("channels")
        if (not isinstance(chs, list) or not chs
                or any(ch not in golden_store.CHANNELS for ch in chs)):
            raise CalendarError(f"{where}: channels phải ⊆"
                                f" {golden_store.CHANNELS}, không rỗng")
        fmts = c.get("formats")
        if (not isinstance(fmts, list) or not fmts
                or any(f not in FORMATS for f in fmts)):
            raise CalendarError(f"{where}: formats phải ⊆ {FORMATS},"
                                " không rỗng")
        skus = c.get("skus")
        if skus != "auto" and (not isinstance(skus, list) or not all(
                isinstance(s, str) and s for s in skus)):
            raise CalendarError(f"{where}: skus phải 'auto' hoặc list"
                                " sku_key")
        if not isinstance(c.get("pillar"), str) or not c["pillar"].strip():
            raise CalendarError(f"{where}: thiếu 'pillar'")
    _validate_daily(cal.get("daily_posts"))
    return cal


def _validate_daily(dp) -> None:
    """`daily_posts` (v13.6) tùy chọn; có thì phải đúng luật."""
    if dp is None:
        return
    if not isinstance(dp, dict):
        raise CalendarError("daily_posts phải là object")
    _int(dp.get("per_day"), "daily_posts.per_day", 1, DAILY_MAX)
    ev = dp.get("evergreen")
    if not isinstance(ev, list) or not ev:
        raise CalendarError("daily_posts.evergreen rỗng")
    ids = set()
    for i, e in enumerate(ev):
        where = f"daily_posts.evergreen[{i}]"
        if not isinstance(e, dict):
            raise CalendarError(f"{where}: phải là object")
        eid = _id(e.get("id"), f"{where}.id")
        if eid in ids:
            raise CalendarError(f"{where}: id trùng '{eid}'")
        ids.add(eid)
        if e.get("channel") not in DAILY_CHANNELS:
            raise CalendarError(f"{where}: channel phải ∈ {DAILY_CHANNELS}")
        if not isinstance(e.get("pillar"), str) or not e["pillar"].strip():
            raise CalendarError(f"{where}: thiếu 'pillar'")
        skus = e.get("skus")
        if skus != "auto" and (not isinstance(skus, list) or not all(
                isinstance(s, str) and s for s in skus)):
            raise CalendarError(f"{where}: skus phải 'auto' hoặc list"
                                " sku_key ([] = không gắn SKU)")


def load_calendar(path=None) -> dict:
    p = Path(path) if path is not None else CALENDAR_FILE
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        raise CalendarError(f"không có file {p.name}") from None
    except OSError as e:
        raise CalendarError(f"{p.name} không đọc được: {type(e).__name__}") \
            from None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CalendarError(f"{p.name} không phải UTF-8") from None
    if not text.strip():
        raise CalendarError(f"{p.name} rỗng")
    try:
        cal = json.loads(text)
    except ValueError as e:
        raise CalendarError(f"{p.name} JSON hỏng: {e}") from None
    return validate(cal)


# ---------- engine ----------

def _non_working(cal: dict) -> frozenset[date]:
    days = {date.fromisoformat(d) for d in cal.get("non_working_days", [])}
    for ev in cal["events"]:
        if ev.get("off_days"):
            base = event_date(ev)
            days |= {base + timedelta(days=o) for o in ev["off_days"]}
    return frozenset(days)


def _off(d: date, non_working) -> bool:
    return d.weekday() >= 5 or d in non_working


def to_workday(dt: datetime, lead: dict, non_working) -> datetime:
    """Đổi sang giờ VN rồi LÙI về giờ làm việc gần nhất ≤ dt."""
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("to_workday: datetime phải có múi giờ")
    d = dt.astimezone(VN_TZ)
    ws, we = lead["work_start_hour"], lead["work_end_hour"]
    end_of = datetime.combine(d.date(), time(we), VN_TZ)
    if not _off(d.date(), non_working):
        if d.time() >= time(ws) and d <= end_of:
            return d
        if d > end_of:
            return end_of
    day = d.date()
    for _ in range(366):
        day -= timedelta(days=1)
        if not _off(day, non_working):
            return datetime.combine(day, time(we), VN_TZ)
    raise CalendarError("không tìm được ngày làm việc trong 366 ngày trước"
                        f" {d.date()}")


def milestones(publish_day: date, lead: dict, brief_sla_hours: int,
               non_working) -> dict:
    sla = _int(brief_sla_hours, "brief_sla_hours", 1, 720)
    pub = datetime.combine(publish_day, time(lead["publish_hour"]), VN_TZ)
    appr = to_workday(pub - timedelta(hours=lead["approve_buffer_hours"]),
                      lead, non_working)
    draft = to_workday(appr - timedelta(hours=lead["draft_review_hours"]),
                       lead, non_working)
    brief = to_workday(draft - timedelta(hours=sla), lead, non_working)
    return {"publish": pub, "approve": appr, "draft": draft, "brief": brief}


def _cell(c: dict, ch: str, fmt: str, by_key: dict, golden_skus: list):
    """→ (cell | None, blocked[])."""
    keys = [s["sku_key"] for s in golden_skus] if c["skus"] == "auto" \
        else c["skus"]
    ok_set = LISTING_OK if fmt == "listing" else CONTENT_OK
    ok, blocked = [], []
    for k in keys:
        s = by_key[k]
        # Luật rượu đặt TRƯỚC readiness — mọi kênh golden đều online.
        if s.get("category") == "alcohol":
            blocked.append({"sku_key": k, "channel": ch, "format": fmt,
                            "readiness": "CAM", "reason": REASON_ALCOHOL})
            continue
        r = _readiness_of(s, ch)
        if r in ok_set:
            ok.append(k)
            continue
        allowed = s.get("allowed_channels")
        if r == "CAM" and (not isinstance(allowed, list)
                           or ch not in allowed):
            why = "CAM: kênh chưa có trong allowed_channels (golden)"
        elif r == "CAM" and s.get("category") == "food":
            why = "CAM: thực phẩm chưa có tự công bố (self_declaration_ok)"
        elif r == "CAM":
            why = "CAM: chưa đủ điều kiện kênh (golden)"
        elif r == "MO_TA":
            why = "MO_TA: TPBVSK chưa có XNQC — chỉ listing mô tả"
        else:
            why = f"{r}: không đủ cho định dạng {fmt}"
        blocked.append({"sku_key": k, "channel": ch, "format": fmt,
                        "readiness": r, "reason": why})
    if not ok and fmt in NEED_SKU:
        return None, blocked
    note = BRAND_NOTE if not ok else ""
    return {"channel": ch, "format": fmt, "skus": ok, "note": note}, blocked


def build(cal: dict, golden: dict, start: date, weeks: int,
          brief_sla_hours: int) -> dict:
    """Lịch chiến dịch có việc trong [start, start + 7·weeks): ngày đăng
    ≥ start và mốc brief < end (ngày VN)."""
    _int(weeks, "weeks", 1, MAX_WEEKS)
    end = start + timedelta(days=7 * weeks)
    golden_skus = (golden or {}).get("skus") or []
    by_key = {s.get("sku_key"): s for s in golden_skus if isinstance(s, dict)}
    if not by_key:
        raise CalendarError("golden không có SKU nào")
    lead = cal["lead"]
    nw = _non_working(cal)
    events = {ev["id"]: ev for ev in cal["events"]}
    out = []
    for c in cal["campaigns"]:
        if c["skus"] != "auto":
            unknown = [k for k in c["skus"] if k not in by_key]
            if unknown:
                raise CalendarError(f"chiến dịch {c['id']}: SKU không có"
                                    f" trong golden {unknown}")
        ev = events[c["event"]]
        pday = event_date(ev) + timedelta(days=c["publish_offset_days"])
        ms = milestones(pday, lead, brief_sla_hours, nw)
        # Có việc trong kỳ: đăng chưa qua start VÀ mốc brief rơi trước end
        # (11.11 có brief 04/11 → hiện trong lịch 4 tuần từ 12/10).
        if pday < start or ms["brief"].date() >= end:
            continue
        cells, blocked, dropped = [], [], []
        for ch in c["channels"]:
            for fmt in c["formats"]:
                cell, bl = _cell(c, ch, fmt, by_key, golden_skus)
                blocked += bl
                if cell is None:
                    dropped.append({"channel": ch, "format": fmt,
                                    "reason": "không SKU đủ readiness — bỏ ô"})
                else:
                    cells.append(cell)
        out.append({"id": c["id"], "event": c["event"],
                    "pillar": c["pillar"], "publish_day": pday,
                    "milestones": ms,
                    "cells": cells, "blocked": blocked, "dropped": dropped})
    out.sort(key=lambda x: (x["publish_day"], x["id"]))
    reminders = []
    for ev in cal["events"]:
        if not ev["remind"]:
            continue
        ed = event_date(ev)
        for n in sorted(set(cal["reminder_days"]), reverse=True):
            day = ed - timedelta(days=n)
            if start <= day < end:
                reminders.append({
                    "event": ev["id"], "days_before": n, "day": day,
                    "at": datetime.combine(day, time(lead["work_start_hour"]),
                                           VN_TZ)})
    reminders.sort(key=lambda r: (r["day"], r["event"]))
    return {"status": cal["status"], "start": start, "end": end,
            "campaigns": out, "reminders": reminders,
            "non_working_days": sorted(nw)}


REASON_NO_SKU = ("thiếu SKU đủ điều kiện kênh {ch} cho bài đăng (cần readiness"
                 " TP_THUONG/QC_DAY_DU; rượu không kênh online)")


def daily_candidates(cal: dict, golden: dict, day: date,
                     brief_sla_hours: int) -> dict:
    """THUẦN → {"status", "per_day", "candidates": [...]}. Mỗi ứng viên:
    {"kind": campaign|evergreen, "ref", "channel", "sku" (None = không gắn
    SKU), "pillar", "publish_day" (date|None), "note", "reason" (None = hợp
    lệ theo golden; chuỗi = bị từ chối)}. Thứ tự tất định: chiến dịch (ngày
    đăng, id, kênh) rồi trụ thường ngày xoay theo `day.toordinal()`. SKU
    chọn xoay vòng trong danh sách SKU hợp lệ — không bao giờ rượu."""
    dp = cal.get("daily_posts")
    if not isinstance(dp, dict):
        raise CalendarError("thiếu 'daily_posts' trong lịch mùa vụ — chưa có"
                            " cấu hình bài hằng ngày (GĐ Marketing chốt)")
    golden_skus = (golden or {}).get("skus") or []
    by_key = {s.get("sku_key"): s for s in golden_skus if isinstance(s, dict)}
    rot = day.toordinal()
    out = []
    plan = build(cal, golden, day, 4, brief_sla_hours)
    for c in plan["campaigns"]:
        if c["milestones"]["draft"].astimezone(VN_TZ).date() != day:
            continue
        for cell in c["cells"]:
            if cell["format"] != "post":
                continue
            ok = cell["skus"]
            out.append({"kind": "campaign", "ref": c["id"],
                        "channel": cell["channel"],
                        "sku": ok[rot % len(ok)] if ok else None,
                        "pillar": c["pillar"], "publish_day": c["publish_day"],
                        "note": cell["note"], "reason": None})
    ev = dp["evergreen"]
    k = rot % len(ev)
    for e in ev[k:] + ev[:k]:
        ch = e["channel"]
        keys = list(by_key) if e["skus"] == "auto" else e["skus"]
        unknown = [s for s in keys if s not in by_key]
        if unknown:
            raise CalendarError(f"daily_posts {e['id']}: SKU không có trong"
                                f" golden {unknown}")
        sku, reason = None, None
        if keys:
            ok = [s for s in keys if by_key[s].get("category") != "alcohol"
                  and _readiness_of(by_key[s], ch) in CONTENT_OK]
            if ok:
                sku = ok[rot % len(ok)]
            else:
                reason = REASON_NO_SKU.format(ch=ch)
        out.append({"kind": "evergreen", "ref": e["id"], "channel": ch,
                    "sku": sku, "pillar": e["pillar"], "publish_day": None,
                    "note": "" if keys else BRAND_NOTE, "reason": reason})
    return {"status": cal["status"], "per_day": dp["per_day"],
            "candidates": out}


# ---------- xuất ----------

def _fmt(ts: datetime) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m %H:%M")


def _md(s) -> str:
    return " ".join(str(s).split()).replace("|", "\\|")


def _group(d: date, by: str) -> str:
    return (f"Tuần {scenario.week_start(d).isoformat()}" if by == "week"
            else f"Tháng {d:%Y-%m}")


def render_markdown(plan: dict, by: str = "week") -> str:
    if by not in ("week", "month"):
        raise ValueError("by phải week|month")
    last = plan["end"] - timedelta(days=1)
    L = [(f"> {_md(plan['status'])} · Lịch ĐỀ XUẤT — GĐ Marketing duyệt"
          " trước khi chạy"), "",
         (f"# Lịch mùa vụ marketing {plan['start']:%d/%m/%Y} →"
          f" {last:%d/%m/%Y} (giờ VN)"), ""]
    groups: dict[str, dict] = {}
    for c in plan["campaigns"]:
        g = groups.setdefault(_group(c["publish_day"], by),
                              {"c": [], "r": []})
        g["c"].append(c)
    for r in plan["reminders"]:
        groups.setdefault(_group(r["day"], by), {"c": [], "r": []})["r"]\
            .append(r)
    if not groups:
        L += ["(Không có chiến dịch hay nhắc mốc trong kỳ.)", ""]
    for key in sorted(groups):
        g = groups[key]
        L += [f"## {key}", ""]
        if g["c"]:
            L += ["| ngày | chiến dịch | kênh | định dạng | SKU | mốc |",
                  "|---|---|---|---|---|---|"]
            for c in g["c"]:
                m = c["milestones"]
                moc = " · ".join(f"{MILESTONE_VN[k]} {_fmt(m[k])}"
                                 for k in MILESTONES)
                for cell in c["cells"] or [None]:
                    if cell is None:
                        L.append(f"| {c['publish_day']:%d/%m} | {_md(c['id'])}"
                                 " | — | — | (mọi ô bị bỏ) | " + moc + " |")
                        continue
                    sku = ", ".join(cell["skus"]) or _md(cell["note"])
                    L.append(f"| {c['publish_day']:%d/%m} | {_md(c['id'])}"
                             f" ({_md(c['pillar'])}) | {cell['channel']} |"
                             f" {cell['format']} | {sku} | {moc} |")
            L.append("")
        for r in g["r"]:
            L.append(f"- Nhắc: còn {r['days_before']} ngày tới"
                     f" `{r['event']}` ({r['day']:%d/%m/%Y})")
        if g["r"]:
            L.append("")
    L += ["## SKU bị chặn kênh", ""]
    agg: dict[tuple, set] = {}
    for c in plan["campaigns"]:
        for b in c["blocked"]:
            key = (b["sku_key"], b["channel"], b["readiness"], b["reason"])
            agg.setdefault(key, set()).add(b["format"])
    if agg:
        L += ["| SKU | kênh | readiness | lý do | định dạng |",
              "|---|---|---|---|---|"]
        for (k, ch, r, why), fm in sorted(agg.items()):
            L.append(f"| {k} | {ch} | {r} | {_md(why)} |"
                     f" {', '.join(sorted(fm))} |")
    else:
        L.append("- (không có)")
    L.append("")
    return "\n".join(L)


def _ics_text(s: str) -> str:
    s = str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return s.replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n")


def _ics_ts(ts: datetime) -> str:
    if ts.tzinfo is None or ts.utcoffset() is None:
        raise ValueError("ics: datetime phải có múi giờ")
    return ts.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _fold(line: str) -> str:
    """RFC 5545 §3.1: dòng > 75 octet gập bằng CRLF + 1 space; không cắt
    giữa ký tự UTF-8 nhiều byte."""
    parts, cur, n = [], "", 0
    for ch in line:
        b = len(ch.encode("utf-8"))
        if n + b > 75:
            parts.append(cur)
            cur, n = " ", 1
        cur += ch
        n += b
    parts.append(cur)
    return "\r\n".join(parts)


def render_ics(plan: dict, now: datetime) -> str:
    stamp = _ics_ts(now)
    L = ["BEGIN:VCALENDAR", "VERSION:2.0",
         "PRODID:-//SamSam//MKT-01 lich mua vu//VI", "CALSCALE:GREGORIAN"]

    def ev(uid: str, start: datetime, summary: str, desc: str):
        L.extend(["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}",
                  f"DTSTART:{_ics_ts(start)}",
                  f"SUMMARY:{_ics_text(summary)}",
                  f"DESCRIPTION:{_ics_text(desc)}", "END:VEVENT"])

    for c in plan["campaigns"]:
        for k in MILESTONES:
            ev(f"{c['id']}-{k}@samsam", c["milestones"][k],
               f"[MKT] {MILESTONE_VN[k]}: {c['id']} ({c['event']})",
               f"{c['pillar']}; {plan['status']}; lịch ĐỀ XUẤT")
    for r in plan["reminders"]:
        ev(f"{r['event']}-nhac-{r['days_before']}@samsam", r["at"],
           f"[MKT] nhắc: còn {r['days_before']} ngày tới {r['event']}",
           plan["status"])
    L.append("END:VCALENDAR")
    return "".join(_fold(x) + "\r\n" for x in L)


def _json_default(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    raise TypeError(type(o).__name__)


def load_inputs(cal_path=None):
    """→ (cal, golden, brief_sla_hours). Lỗi → CalendarError."""
    cal = load_calendar(cal_path)
    golden, err = golden_store.read_golden(golden_store.GOLDEN_FILE)
    if err:
        raise CalendarError(f"golden: {err}")
    errs = golden_store.validate(golden)
    if errs:
        raise CalendarError(f"golden sai luật: {errs[0]}")
    try:
        cfg = director.load_config("marketing")
    except director.DirectorConfigError as e:
        raise CalendarError(f"director marketing: {e}") from None
    spec = cfg["object_types"].get("campaign_brief")
    if spec is None:
        raise CalendarError("director marketing: thiếu object_types."
                            "campaign_brief")
    return cal, golden, spec["sla_hours"]


# ---------- CLI ----------

def _date_arg(s: str) -> date:
    if not _ISO_RE.fullmatch(s or ""):
        raise argparse.ArgumentTypeError(f"ngày phải YYYY-MM-DD: {s!r}")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"ngày không hợp lệ: {s!r}") \
            from None


def _weeks_arg(s: str) -> int:
    try:
        n = int(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"--weeks phải số: {s!r}") from None
    if not 1 <= n <= MAX_WEEKS:
        raise argparse.ArgumentTypeError(f"--weeks phải 1..{MAX_WEEKS}")
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.mkt_calendar",
        description="MKT-01 lịch mùa vụ ĐỀ XUẤT (không DB, không đăng bài)")
    ap.add_argument("--start", type=_date_arg,
                    help="YYYY-MM-DD (mặc định thứ Hai tuần này, giờ VN)")
    ap.add_argument("--weeks", type=_weeks_arg, default=4)
    ap.add_argument("--by", choices=("week", "month"), default="week")
    ap.add_argument("--ics", nargs="?", const="", default=None,
                    metavar="PATH", help="ghi .ics (mặc định data/reports/)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    now = datetime.now(VN_TZ)
    start = args.start or scenario.week_start(now.date())
    try:
        cal, golden, sla = load_inputs()
        plan = build(cal, golden, start, args.weeks, sla)
    except CalendarError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(plan, ensure_ascii=False, indent=1,
                         default=_json_default))
    else:
        print(render_markdown(plan, args.by))
    if args.ics is not None:
        p = Path(args.ics) if args.ics else \
            REPORTS_DIR / f"mkt-calendar-{start.isoformat()}.ics"
        # P8.4: lịch .ics dựng từ kế hoạch GIẢ ĐỊNH (không phải đầu ra đếm).
        path = write_report(render_ics(plan, now), p.parent, p.name,
                            sample=False)
        print(f"[ok] .ics: {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
