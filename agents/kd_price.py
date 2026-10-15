"""v5.3 KD-A5 — Agent giám sát giá & khuyến mãi (WP07, khối `sales`). LUẬT
tất định, KHÔNG LLM, KHÔNG gọi sàn. Agent KHÔNG BAO GIỜ đổi giá/KM/listing,
KHÔNG ghi golden/`price_list`/sàn: mọi đề xuất là NHÁP trong hàng duyệt
(risk high, GĐ bán hàng duyệt, Quản lý MXH sửa tay trên Seller Center).

Nguồn (CHỈ SELECT): listing đang chạy (`agents.kd_listing.running_listings`
— giá bán thực = `raw.sale_price` nếu file có cột KM, không thì `price_vnd`),
golden `price_list` (list/floor thường trực hiệu lực ngày `today`),
`sku_readiness`/`v_promotable`, giá vốn ĐÃ DUYỆT (`cogs_versions` qua
`agents.fp_pnl.cogs_at`), tỷ lệ thực nhận sàn (`data/fpa_config.json`
`cash.net_ratio_default` — GIẢ ĐỊNH v9.1), cấu hình ngưỡng
`data/price_watch.json` (GIẢ ĐỊNH — chờ GĐ bán hàng), kế hoạch KM = CSV
nhập tay (`--plan`), lịch mùa `data/marketing_calendar.json` (v6.0).

Luật giá đang chạy (`check_listing_prices`, THUẦN):
  below_floor             S1  giá thực < floor golden (floor chưa duyệt vẫn
                              xét — detail floor_approved false)
  negative_margin         S1  giá thực × tỷ lệ thực nhận − giá vốn đã duyệt
                              < 0 (chưa có giá vốn duyệt → ghi nhãn, KHÔNG
                              suy 0, KHÔNG cảnh báo)
  list_deviation          S2  |giá niêm yết sàn − list| × 100 > list × ngưỡng
  listing_promo_over_cap  S2  giảm từ list xuống giá thực vượt trần KM kênh
Rượu / SKU readiness CAM không xét giá (việc của A4 — S1 listing).

Luật KM dự kiến (`check_promos`, THUẦN; chỉ dòng kết thúc ≥ today và bắt
đầu ≤ today + lookahead_days):
  promo_banned            S1  SKU × kênh không thuộc `v_promotable` (rượu,
                              TPBVSK chưa XNQC, thực phẩm chưa tự công bố,
                              giá list chưa duyệt)
  promo_below_floor       S1  giá sau KM (gộp mọi KM chồng cùng ngày, áp lần
                              lượt trên list golden) < floor
  promo_negative_margin   S1  biên ước tính âm theo giá vốn đã duyệt
  promo_stacked           S2  > max_stacked_promos KM cùng SKU × kênh × ngày
  promo_over_cap          S2  giảm 1 KM hoặc tổng chồng > trần kênh
  promo_unverifiable      S2  thiếu list/floor golden (hoặc kênh ngoài cấu
                              hình) — không kiểm được
Đẩy: S1 → `market_alert_s1`; S2 giá → `price_change`; S2 KM →
`promo_change`. Phát hiện `list_deviation` trùng `market_alerts` OPEN
`price_mismatch` cùng (kênh, item_id, seller_sku) → chỉ báo cáo. Số trong
đề xuất CHỈ lấy từ golden (floor/list) hoặc file sàn. Giá đối thủ
(`competitor_observations`) CHỈ vào mục "Tham khảo đối thủ" của báo cáo —
không là input của luật nào, không bao giờ vào payload.

v14.4 (sales-06.1, PL01 "Phát hiện lệch giá, đại lý phá giá"): giá ĐẠI LÝ
chưa có nguồn tự động (API/crawl sàn của đại lý = blocker) → NGƯỜI quan sát
tay nạp file qua `python -m ingest.dealer_price` → `dealer_price_obs`
(module này KHÔNG ghi bảng đó). `--dealer-watch` (job, CHỈ đọc): quan sát
không mẫu trong `dealer_price.lookback_days` có giá < giá sàn golden hiệu
lực NGÀY quan sát (kênh thuộc bảng giá golden → floor cùng kênh; kênh khác,
vd cửa hàng → floor THẤP NHẤT của SKU) → `dealer_price_alert` khối sales,
khóa `dp:<đại lý>:<sku>:<kênh>:<ngày>` (nhiều file cùng khóa → giá thấp
nhất). Thiếu floor → "không kiểm được" (đếm, không cảnh báo). Payload chỉ mã
đại lý/mã SKU (nhóm rượu ẩn mã)/giá/ngày/tên miền nguồn — agent KHÔNG liên
hệ đại lý, KHÔNG đổi giá.

Chạy:
  python -m agents.kd_price --dealer-watch [--dry-run] [--as-of NGÀY]
  python -m agents.kd_price --run --dry-run [--plan CSV] [--as-of NGÀY]
  python -m agents.kd_price --run [--plan CSV]           # đẩy (job_runs)
  python -m agents.kd_price --report [--plan CSV] [--as-of NGÀY]
Exit: 0 ok · 1 cấu hình/CSV lỗi (trước connect) · 2 DB down / lỗi DB /
tham số sai.
"""

import argparse
import csv
import io
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import ROUND_FLOOR, Decimal
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from agents import kd_listing as kl
from agents.fp_pnl import NO_COGS, cogs_at, fetch_versions, frac, read_config
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import CHANNELS, _clean, _to_int, load_mapping
from pipelines import director, mkt_calendar
from pipelines.director import DirectorConfigError
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WATCH_FILE = ROOT / "data" / "price_watch.json"
BLOCK = "sales"
AGENT = "agent:kd_price"
JOB = "agents.kd_price"
PROMO_KINDS = ("voucher", "flash_sale", "giam_gia")
WATCH_KEYS = {"_doc", "status", "confirmed_by", "channels",
              "list_deviation_pct", "max_discount_pct", "max_stacked_promos",
              "promo_kinds", "lookahead_days"}
SEVERITY = {"below_floor": "S1", "negative_margin": "S1",
            "list_deviation": "S2", "listing_promo_over_cap": "S2",
            "promo_banned": "S1", "promo_below_floor": "S1",
            "promo_negative_margin": "S1", "promo_stacked": "S2",
            "promo_over_cap": "S2", "promo_unverifiable": "S2"}
KIND_LABELS = {
    "below_floor": "giá bán thực trên sàn dưới giá sàn golden",
    "negative_margin": "biên ước tính âm theo giá vốn đã duyệt",
    "list_deviation": "giá niêm yết trên sàn lệch giá list golden quá ngưỡng",
    "listing_promo_over_cap": "mức chiết khấu trên sàn vượt trần khuyến mãi",
    "promo_banned": "khuyến mãi cho SKU không được quảng bá trên kênh",
    "promo_below_floor": "khuyến mãi dự kiến làm giá dưới giá sàn golden",
    "promo_negative_margin": "khuyến mãi dự kiến làm biên ước tính âm",
    "promo_stacked": "khuyến mãi chồng nhau vượt số cho phép",
    "promo_over_cap": "khuyến mãi dự kiến vượt trần chiết khấu",
    "promo_unverifiable": "khuyến mãi không kiểm được (thiếu giá golden)"}
PROMO_FINDINGS = frozenset(k for k in SEVERITY if k.startswith("promo_"))
V33_DUP = {"list_deviation": "price_mismatch"}
NO_AUTO = ("Agent KHÔNG tự đổi giá/khuyến mãi — GĐ bán hàng duyệt, MXH"
           " sửa tay trên Seller Center.")
# CSV kế hoạch KM (nhập tay).
PLAN_REQUIRED = ("program_id", "kenh", "sku_key", "loai_km", "ngay_bat_dau",
                 "ngay_ket_thuc")
PLAN_OPTIONAL = ("giam_pct", "gia_km_vnd", "su_kien")
PLAN_MAX_ROWS = 5000
PLAN_MAX_BYTES = 2 * 1024 * 1024
MAX_PRINT_ERRS = 30
_PID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}")
_SKU_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_PCT_RE = re.compile(r"[0-9]{1,2}")


# ---------------------------------------------------------------- cấu hình

def _int_in(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def validate_watch(d) -> str | None:
    """→ lý do lỗi | None. Fail-closed: không bao giờ 'cấu hình rỗng'."""
    if not isinstance(d, dict):
        return "phải là object JSON"
    if not set(d) - {"_doc"}:
        return "rỗng / chỉ có _doc"
    stray = sorted(set(d) - WATCH_KEYS)
    if stray:
        return f"key lạ {stray}"
    if not isinstance(d.get("status"), str) or not d["status"].strip():
        return "thiếu 'status'"
    if "confirmed_by" not in d or not (
            d["confirmed_by"] is None or (isinstance(d["confirmed_by"], str)
                                          and d["confirmed_by"].strip())):
        return "'confirmed_by' phải null hoặc tên người chốt"
    ch = d.get("channels")
    if not (isinstance(ch, list) and ch and all(c in CHANNELS for c in ch)
            and len(set(ch)) == len(ch)):
        return f"'channels' phải list không trùng ⊂ {CHANNELS}"
    if not _int_in(d.get("list_deviation_pct"), 1, 50):
        return "'list_deviation_pct' phải số nguyên 1..50"
    cap = d.get("max_discount_pct")
    if not (isinstance(cap, dict) and set(cap) == set(ch)
            and all(_int_in(v, 1, 49) for v in cap.values())):
        return ("'max_discount_pct' phải {kênh: số nguyên 1..49} đủ đúng"
                " các kênh trong 'channels' (≤ 49 khớp R2 golden)")
    if not _int_in(d.get("max_stacked_promos"), 1, 10):
        return "'max_stacked_promos' phải số nguyên 1..10"
    pk = d.get("promo_kinds")
    if not (isinstance(pk, list) and pk and all(k in PROMO_KINDS for k in pk)
            and len(set(pk)) == len(pk)):
        return f"'promo_kinds' phải list không trùng ⊂ {PROMO_KINDS}"
    if not _int_in(d.get("lookahead_days"), 1, 120):
        return "'lookahead_days' phải số nguyên 1..120"
    return None


def load_watch(path: Path | None = None) -> tuple[dict | None, str | None]:
    p = Path(path) if path is not None else WATCH_FILE
    try:
        raw = p.read_bytes()
    except OSError as e:
        return None, f"không đọc được {p.name}: {type(e).__name__}"
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None, f"{p.name} không phải UTF-8"
    if not text.strip():
        return None, f"{p.name} rỗng"
    try:
        d = json.loads(text)
    except ValueError as e:
        return None, f"{p.name} JSON hỏng: {type(e).__name__}"
    why = validate_watch(d)
    return (None, f"{p.name}: {why}") if why else (d, None)


def load_net_ratio(channels, path: Path | None = None
                   ) -> tuple[dict | None, str | None]:
    """{kênh: Decimal} từ `fpa_config.cash.net_ratio_default` (v9.1)."""
    cash, why = read_config("cash", path)
    if cash is None:
        return None, why
    src = cash.get("net_ratio_default")
    if not isinstance(src, dict):
        return None, "fpa_config: thiếu cash.net_ratio_default"
    out = {}
    for ch in channels:
        d, why = frac(src.get(ch), f"cash.net_ratio_default.{ch}")
        if d is None or d == 0:
            return None, why or f"cash.net_ratio_default.{ch} = 0"
        out[ch] = d
    return out, None


# ---------------------------------------------------------------- tiện ích

def vnd(n) -> str:
    return kl.vnd(n)


def _int_price(x: Fraction) -> int:
    """Giá phân số → VND nguyên (làm tròn xuống — biên tính bảo thủ)."""
    return x.numerator // x.denominator


def _margin(price: int, ratio: Decimal, cost: int) -> int:
    """Biên ước tính VND (làm tròn xuống) = giá × tỷ lệ thực nhận − giá vốn."""
    return int((Decimal(price) * ratio).to_integral_value(ROUND_FLOOR)) - cost


def _oid(kind: str, ch: str, key: str, ev: dict) -> str:
    return f"a5:{kind}:{ch}:{kl.ref_code(key)}:{kl.evidence_sha(ev)}"


def _f(kind, ch, *, item_id=None, seller_sku=None, sku=None, key=None,
       ev=None, **extra) -> dict:
    ev = ev or {}
    return {"kind": kind, "severity": SEVERITY[kind], "channel": ch,
            "item_id": item_id, "seller_sku": seller_sku, "sku_key": sku,
            "evidence": ev,
            "object_id": _oid(kind, ch, key or item_id or sku or "-",
                              {"sku": sku, **ev}), **extra}


# ---------------------------------------------------------------- luật giá đang chạy

def check_listing_prices(listings: list[dict], golden_prices: dict,
                         cogs: list[dict], net_ratio: dict, watch: dict,
                         today: date, readiness: dict) -> list[dict]:
    """THUẦN, tất định → [finding] (+ mục `severity: INFO` nhãn chưa có giá
    vốn duyệt — không đẩy). `golden_prices` = {(sku, kênh): {list|floor:
    {price, id, approved}}}; `readiness` thiếu key = CAM (không xét giá)."""
    today = coerce_day(today)
    out: list[dict] = []
    for r in listings:
        sku, ch = r.get("sku_key"), r["channel"]
        if sku is None or ch not in watch["channels"]:
            continue
        if readiness.get((sku, ch), "CAM") == "CAM":
            continue                     # A4 S1 — không xét giá
        listed = r.get("price_vnd")
        eff = r.get("sale_price") if r.get("sale_price") is not None \
            else listed
        if eff is None:
            continue
        g = golden_prices.get((sku, ch), {})
        fl, lp = g.get("floor"), g.get("list")
        base = {"item_id": r.get("item_id"), "seller_sku": r.get("seller_sku"),
                "sku": sku}
        if fl is not None and eff < fl["price"]:
            out.append(_f("below_floor", ch, **base, ev={
                "price_san": listed, "price_eff": eff,
                "floor": fl["price"], "floor_approved": fl["approved"]}))
        cost = cogs_at(cogs, sku, today)
        if cost is None:
            out.append({"kind": "no_cogs", "severity": "INFO",
                        "channel": ch, "item_id": r.get("item_id"),
                        "sku_key": sku, "note": NO_COGS})
        elif _margin(eff, net_ratio[ch], cost) < 0:
            out.append(_f("negative_margin", ch, **base, ev={
                "price_eff": eff, "cogs": cost,
                "net_ratio": str(net_ratio[ch]),
                "margin": _margin(eff, net_ratio[ch], cost)}))
        if lp is not None:
            lst = lp["price"]
            if listed is not None and abs(listed - lst) * 100 > \
                    lst * watch["list_deviation_pct"]:
                out.append(_f("list_deviation", ch, **base, ev={
                    "price_san": listed, "list": lst,
                    "list_approved": lp["approved"],
                    "pct": watch["list_deviation_pct"]}))
            cap = watch["max_discount_pct"][ch]
            if eff < lst and (lst - eff) * 100 > lst * cap:
                out.append(_f("listing_promo_over_cap", ch, **base, ev={
                    "price_eff": eff, "list": lst, "cap_pct": cap}))
    return _sorted(out)


def _sorted(fs: list[dict]) -> list[dict]:
    order = {"S1": 0, "S2": 1, "INFO": 2}
    return sorted(fs, key=lambda f: (order[f["severity"]], f["kind"],
                                     f["channel"], f.get("item_id") or "",
                                     f.get("sku_key") or "",
                                     f.get("object_id", "")))


# ---------------------------------------------------------------- kế hoạch KM

def read_plan(path, promo_kinds=PROMO_KINDS, calendar: dict | None = None
              ) -> tuple[list[dict], list[str]]:
    """THUẦN (không DB): CSV kế hoạch KM → (rows, errs). errs ≠ [] → rows
    = []. Lỗi chỉ nêu số dòng + tên cột, KHÔNG giá trị ô. `su_kien` ∈ id
    sự kiện lịch mùa (ngày qua `mkt_calendar.event_date`)."""
    p = Path(path)
    try:
        if p.stat().st_size > PLAN_MAX_BYTES:
            return [], [f"file > {PLAN_MAX_BYTES // 2**20}MB"]
        data = p.read_bytes()
    except OSError as e:
        return [], [f"không đọc được file kế hoạch: {type(e).__name__}"]
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        return [], [f"file không phải UTF-8 (byte {e.start})"]
    if not text.strip():
        return [], ["file rỗng"]
    events = {}
    if calendar is not None:
        events = {ev["id"]: mkt_calendar.event_date(ev)
                  for ev in calendar["events"]}
    try:
        table = list(_rows(text))
    except (csv.Error, _PlanError) as e:
        return [], [str(e)[:160]]
    (_, header), body = table[0], table[1:]
    errs = []
    seen, col = set(), {}
    for j, h in enumerate(header):
        h = (h or "").strip()
        if not h:
            errs.append(f"header cột {j + 1} trống")
        elif h in seen:
            errs.append(f"header trùng: cột {j + 1}")
        elif h not in PLAN_REQUIRED + PLAN_OPTIONAL:
            errs.append(f"cột lạ ở vị trí {j + 1} (chỉ nhận"
                        f" {', '.join(PLAN_REQUIRED + PLAN_OPTIONAL)})")
        else:
            seen.add(h)
            col[h] = j
    miss = [c for c in PLAN_REQUIRED if c not in col]
    if miss:
        errs.append("thiếu cột bắt buộc: " + ", ".join(miss))
    if "giam_pct" not in col and "gia_km_vnd" not in col:
        errs.append("cần cột giam_pct hoặc gia_km_vnd")
    if errs:
        return [], errs
    if not body:
        return [], ["file chỉ có header, không có dòng dữ liệu"]
    rows = []
    for no, cells in body:
        if any(c.strip() for c in cells[len(header):]):
            errs.append(f"dòng {no}: thừa ô ngoài header")
            continue
        v = {k: (cells[j].strip() if j < len(cells) else "") or None
             for k, j in col.items()}
        bad = []
        if not (v["program_id"] and _PID_RE.fullmatch(v["program_id"])):
            bad.append("program_id")
        if v["kenh"] not in CHANNELS:
            bad.append("kenh")
        if not (v["sku_key"] and _SKU_RE.fullmatch(v["sku_key"])
                and len(v["sku_key"]) <= 64):
            bad.append("sku_key")
        if v["loai_km"] not in promo_kinds:
            bad.append("loai_km")
        start = _date(v["ngay_bat_dau"])
        end = _date(v["ngay_ket_thuc"])
        if start is None:
            bad.append("ngay_bat_dau")
        if end is None:
            bad.append("ngay_ket_thuc")
        if start and end and end < start:
            bad.append("ngay_ket_thuc (trước ngày bắt đầu)")
        pct, gia = v.get("giam_pct"), v.get("gia_km_vnd")
        if (pct is None) == (gia is None):
            bad.append("giam_pct/gia_km_vnd (cần đúng 1)")
        elif pct is not None:
            if not _PCT_RE.fullmatch(pct) or not 1 <= int(pct) <= 99:
                bad.append("giam_pct (số nguyên 1..99)")
        else:
            g = _to_int(gia, 10**15)
            if not g:
                bad.append("gia_km_vnd (số nguyên > 0)")
        ev = v.get("su_kien")
        if ev is not None and ev not in events:
            bad.append("su_kien (không có trong lịch mùa)")
        if bad:
            errs.append(f"dòng {no}: cột {', '.join(bad)} không hợp lệ")
            continue
        rows.append({"row_no": no, "program_id": v["program_id"],
                     "channel": v["kenh"], "sku_key": v["sku_key"],
                     "kind": v["loai_km"], "start": start, "end": end,
                     "pct": int(pct) if pct is not None else None,
                     "price": _to_int(gia, 10**15) if gia is not None
                     else None,
                     "event": ev,
                     "event_date": events.get(ev) if ev else None})
    if errs:
        return [], errs
    return rows, []


class _PlanError(Exception):
    """Lỗi cấu trúc CSV kế hoạch — message không chứa nội dung ô."""


def _rows(text: str):
    """→ (số dòng, ô) bỏ dòng trống; trần PLAN_MAX_ROWS áp trong lúc đọc."""
    n = 0
    for i, r in enumerate(csv.reader(io.StringIO(text, newline="")), 1):
        if i > PLAN_MAX_ROWS + 1:
            raise _PlanError(f"file > {PLAN_MAX_ROWS} dòng — tách file")
        if any(c.strip() for c in r):
            n += 1
            yield i, r
    if n == 0:
        raise _PlanError("file rỗng")


def _date(s) -> date | None:
    if not isinstance(s, str) or not _ISO_RE.fullmatch(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def coerce_day(v) -> date:
    """str 'YYYY-MM-DD' | date → date (CLI truyền str) — TRƯỚC format-spec."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    d = _date(v)
    if d is None:
        raise ValueError("ngày phải dạng YYYY-MM-DD")
    return d


# ---------------------------------------------------------------- luật KM (THUẦN)

def _after(lst: int, promos: list[dict]) -> Fraction:
    """Giá sau KM gộp, áp LẦN LƯỢT trên list golden: KM giá cố định (thấp
    nhất) trước, rồi các KM % theo program_id. Phân số — không float."""
    fixed = [p["price"] for p in promos if p["price"] is not None]
    price = Fraction(min([lst, *fixed]))
    for p in sorted(promos, key=lambda p: p["program_id"]):
        if p["pct"] is not None:
            price = price * (100 - p["pct"]) / 100
    return price


def _off_pct(lst: int, price: Fraction) -> Fraction:
    return (lst - price) * 100 / lst


def window_label(start: date, today: date) -> str:
    return "đang chạy" if start <= today else f"dự kiến T-{(start - today).days}"


def check_promos(rows: list[dict], golden_prices: dict, readiness: dict,
                 promotable: set, cogs: list[dict], net_ratio: dict,
                 watch: dict, today: date) -> list[dict]:
    """THUẦN, tất định → [finding]. Chỉ dòng kết thúc ≥ today và bắt đầu ≤
    today + lookahead_days. Gộp KM chồng theo NGÀY (cùng SKU × kênh)."""
    today = coerce_day(today)
    horizon = today + timedelta(days=watch["lookahead_days"])
    live = [r for r in rows if r["end"] >= today and r["start"] <= horizon]
    out: list[dict] = []
    ok: dict = {}
    for r in sorted(live, key=lambda r: (r["channel"], r["sku_key"],
                                         r["start"], r["program_id"])):
        sku, ch = r["sku_key"], r["channel"]
        lbl = window_label(r["start"], today)
        meta = {"program_ids": [r["program_id"]], "start": r["start"],
                "end": r["end"], "label": lbl,
                "cam": readiness.get((sku, ch), "CAM") == "CAM"}
        if (sku, ch) not in promotable:
            out.append(_f("promo_banned", ch, sku=sku, key=r["program_id"],
                          ev={"program_id": r["program_id"],
                              "start": str(r["start"]), "end": str(r["end"]),
                              "readiness": readiness.get((sku, ch), "CAM")},
                          **meta))
            continue
        g = golden_prices.get((sku, ch), {})
        if ch not in watch["channels"] or "list" not in g or \
                "floor" not in g:
            out.append(_f("promo_unverifiable", ch, sku=sku,
                          key=r["program_id"],
                          ev={"program_id": r["program_id"],
                              "start": str(r["start"]),
                              "has_list": "list" in g,
                              "has_floor": "floor" in g}, **meta))
            continue
        lst, cap = g["list"]["price"], watch["max_discount_pct"][ch]
        price = _after(lst, [r])
        if _off_pct(lst, price) > cap:
            out.append(_f("promo_over_cap", ch, sku=sku, key=r["program_id"],
                          ev={"program_ids": [r["program_id"]], "list": lst,
                              "after": _int_price(price), "cap_pct": cap},
                          **meta))
        ok.setdefault((sku, ch), []).append(r)
    # Theo ngày: KM chồng + giá sau KM gộp (1 phát hiện / tổ hợp KM).
    done: set = set()
    for (sku, ch), rs in sorted(ok.items()):
        g = golden_prices[(sku, ch)]
        lst, floor = g["list"]["price"], g["floor"]["price"]
        cap = watch["max_discount_pct"][ch]
        cost = cogs_at(cogs, sku, today)
        lo = max(today, min(r["start"] for r in rs))
        hi = min(horizon, max(r["end"] for r in rs))
        d = lo
        while d <= hi:
            act = [r for r in rs if r["start"] <= d <= r["end"]]
            d += timedelta(days=1)
            if not act:
                continue
            pids = sorted(r["program_id"] for r in act)
            first = min(act, key=lambda r: (r["start"], r["program_id"]))
            meta = {"program_ids": pids,
                    "start": max(r["start"] for r in act),
                    "end": min(r["end"] for r in act),
                    "label": window_label(max(r["start"] for r in act),
                                          today),
                    "cam": False}
            price = _after(lst, act)
            after = _int_price(price)
            ev = {"program_ids": pids, "list": lst, "floor": floor,
                  "after": after}

            def add(kind, extra, _ev=ev, _meta=meta, _first=first, _ch=ch,
                    _sku=sku, _pids=pids):
                key = (kind, _sku, _ch, tuple(_pids))
                if key in done:
                    return
                done.add(key)
                out.append(_f(kind, _ch, sku=_sku, key=_first["program_id"],
                              ev={**_ev, **extra}, **_meta))

            if len(act) > watch["max_stacked_promos"]:
                add("promo_stacked", {"max": watch["max_stacked_promos"]})
            if len(act) > 1 and _off_pct(lst, price) > cap:
                add("promo_over_cap", {"cap_pct": cap})
            if price < floor:
                add("promo_below_floor", {
                    "floor_approved": g["floor"]["approved"]})
            if cost is not None and _margin(after, net_ratio[ch], cost) < 0:
                add("promo_negative_margin", {
                    "cogs": cost, "net_ratio": str(net_ratio[ch]),
                    "margin": _margin(after, net_ratio[ch], cost)})
    return _sorted(out)


# ---------------------------------------------------------------- payload

def mark_dups(findings: list[dict], v33: dict) -> None:
    for f in findings:
        k = V33_DUP.get(f["kind"])
        if k:
            aid = v33.get((k, f["channel"], f.get("item_id") or "",
                           f.get("seller_sku") or ""))
            if aid is not None:
                f["dup_alert"] = aid


def object_type(f: dict) -> str:
    if f["severity"] == "S1":
        return "market_alert_s1"
    return "promo_change" if f["kind"] in PROMO_FINDINGS else "price_change"


def _where(f: dict) -> str:
    parts = [f"kênh {f['channel']}"]
    if f.get("item_id"):
        parts.append(f"mã sản phẩm sàn {kl.ref_code(f['item_id'])}")
    if f.get("program_ids"):
        parts.append("chương trình " + ", ".join(
            kl.ref_code(p) for p in f["program_ids"]))
    # SKU nhóm CAM (rượu...) KHÔNG in sku_key (từ khóa → guardrail chặn).
    if f.get("sku_key") and not f.get("cam"):
        parts.append(f"SKU {kl.ref_code(f['sku_key'])}")
    return ", ".join(parts)


def _days(f: dict) -> str:
    return (f"{f['label']}, {f['start']:%d/%m/%Y}–{f['end']:%d/%m/%Y}"
            if f.get("start") else "")


def _by(f: dict) -> str:
    """Hạn xử lý: KM đang chạy → 'ngay'; dự kiến → trước ngày bắt đầu."""
    if f.get("label") == "đang chạy":
        return "ngay (đang chạy)"
    return f"trước {f['start']:%d/%m/%Y}"


def payload_of(f: dict) -> tuple[str, str]:
    """(title, payload) từ TEMPLATE. Số CHỈ từ golden/file sàn/kế hoạch —
    không bao giờ giá đối thủ, không tự tính 'giá nên đặt'."""
    ev, kind = f["evidence"], f["kind"]
    label, where = KIND_LABELS[kind], _where(f)
    if kind == "below_floor":
        num = (f"giá niêm yết {vnd(ev['price_san'])}, giá bán thực"
               f" {vnd(ev['price_eff'])}, giá sàn golden {vnd(ev['floor'])}"
               + ("" if ev["floor_approved"] else " (giá sàn CHƯA duyệt)"))
        todo = f"đưa giá bán về ≥ giá sàn {vnd(ev['floor'])}"
    elif kind == "negative_margin":
        num = (f"giá bán thực {vnd(ev['price_eff'])}, giá vốn đã duyệt"
               f" {vnd(ev['cogs'])}, tỷ lệ thực nhận GIẢ ĐỊNH"
               f" {ev['net_ratio']}, biên ước tính {vnd(ev['margin'])}")
        todo = ("GĐ bán hàng xem lại giá bán/khuyến mãi (agent không tính"
                " giá nên đặt)")
    elif kind == "list_deviation":
        num = (f"giá niêm yết trên sàn {vnd(ev['price_san'])}, giá list"
               f" golden {vnd(ev['list'])}"
               + ("" if ev["list_approved"] else " (CHƯA duyệt)")
               + f", ngưỡng lệch {ev['pct']}%")
        todo = f"đưa về giá niêm yết {vnd(ev['list'])}"
    elif kind == "listing_promo_over_cap":
        num = (f"giá bán thực {vnd(ev['price_eff'])}, giá list golden"
               f" {vnd(ev['list'])}, trần chiết khấu {ev['cap_pct']}%")
        todo = "GĐ bán hàng xem lại mức chiết khấu trên sàn"
    elif kind == "promo_banned":
        num = f"mức sẵn sàng golden {ev['readiness']}"
        todo = (f"hủy khuyến mãi {_by(f)} — SKU không"
                " được quảng bá trên kênh này")
    elif kind == "promo_unverifiable":
        num = ("thiếu " + ", ".join(
            n for n, ok in (("giá list golden", ev["has_list"]),
                            ("giá sàn golden", ev["has_floor"])) if not ok)
               if not (ev["has_list"] and ev["has_floor"])
               else "kênh ngoài cấu hình giám sát")
        todo = (f"xem lại/hoãn khuyến mãi {_by(f)} tới"
                " khi có giá golden đã duyệt")
    else:   # promo_below_floor / promo_negative_margin / stacked / over_cap
        num = (f"giá list golden {vnd(ev['list'])}, giá sàn golden"
               f" {vnd(ev['floor'])}" if "floor" in ev else
               f"giá list golden {vnd(ev['list'])}")
        num += f", giá sau khuyến mãi gộp {vnd(ev['after'])}"
        if "cap_pct" in ev:
            num += f", trần chiết khấu {ev['cap_pct']}%"
        if "max" in ev:
            num += f", tối đa {ev['max']} khuyến mãi cùng lúc"
        if "cogs" in ev:
            num += (f", giá vốn đã duyệt {vnd(ev['cogs'])}, biên ước tính"
                    f" {vnd(ev['margin'])}")
        todo = ("xem lại/hủy khuyến mãi "
                + ", ".join(kl.ref_code(p) for p in f["program_ids"])
                + f" {_by(f)}")
    head = ("Cảnh báo sàn S1 (A5 giá & khuyến mãi)" if f["severity"] == "S1"
            else ("Khuyến mãi dự kiến cần xem lại (A5, NHÁP)"
                  if kind in PROMO_FINDINGS else "Đề xuất giá (A5, NHÁP)"))
    days = _days(f)
    payload = (f"{head}: {label} — {where}"
               + (f" ({days})" if days else "") + f". Số liệu: {num}."
               f" Đề xuất NHÁP: {todo}. {NO_AUTO}")
    return f"{label} — {where}", payload


def to_items(findings: list[dict], cfg: dict) -> list[dict]:
    types = cfg["object_types"]
    out = []
    for f in findings:
        if f["severity"] == "INFO" or f.get("dup_alert") is not None:
            continue
        ot = object_type(f)
        title, payload = payload_of(f)
        out.append({"object_type": ot, "object_id": f["object_id"],
                    "title": f"{types[ot]['label']} — {title}",
                    "payload": payload})
    return out


# ---------------------------------------------------------------- đọc DB (SELECT)

def promotable_set(conn) -> set:
    return {(k, ch) for k, ch in conn.execute(
        "select sku_key, channel from v_promotable")}


def competitor_latest(conn) -> list[tuple]:
    """Giá đối thủ mới nhất mỗi (sku_key, kênh) — CHỈ cho báo cáo."""
    return [tuple(r) for r in conn.execute(
        "select distinct on (sku_key, channel) sku_key, channel, competitor,"
        " price_vnd, promo_price_vnd, observed_on from competitor_observations"
        " where sku_key is not null"
        " order by sku_key, channel, observed_on desc, id desc").fetchall()]


def analyze(conn, mapping: dict, watch: dict, net_ratio: dict, today: date,
            plan_rows: list[dict] | None) -> dict:
    """CHỈ SELECT → {listing, promo, competitor}."""
    rows, chans = kl.running_listings(conn, mapping)
    prices = kl.golden_prices(conn, today)
    readiness = kl.readiness_map(conn)
    cogs = fetch_versions(conn)
    fl = check_listing_prices(rows, prices, cogs, net_ratio, watch, today,
                              readiness)
    fp = check_promos(plan_rows or [], prices, readiness,
                      promotable_set(conn), cogs, net_ratio, watch, today)
    v33 = kl.open_v33_alerts(conn, tuple(V33_DUP.values()))
    mark_dups(fl, v33)
    return {"listing": fl, "promo": fp, "channels": sorted(chans),
            # SKU nhóm CAM (rượu...) KHÔNG in sku_key — như _where.
            "competitor": [(None if readiness.get((r[0], r[1]), "CAM") == "CAM"
                            else r[0], *r[1:])
                           for r in competitor_latest(conn)]}


# ---------------------------------------------------------------- báo cáo

def _cell(s, n: int) -> str:
    """Chữ người nhập (tên đối thủ) vào ô bảng markdown: bỏ ký tự điều
    khiển, cắt độ dài, '|' không phá cột."""
    return _clean(s, n).replace("|", "/")


def season_events(calendar: dict | None, today: date, days: int) -> list:
    """[(id, ngày)] sự kiện lịch mùa trong [today, today + days]."""
    if calendar is None:
        return []
    out = []
    for ev in calendar["events"]:
        d = mkt_calendar.event_date(ev)
        if today <= d <= today + timedelta(days=days):
            out.append((ev["id"], d))
    return sorted(out, key=lambda e: (e[1], e[0]))


def render_report(res: dict, watch: dict, today: date,
                  plan_rows: list[dict] | None, calendar: dict | None,
                  plan_info: dict | None = None) -> str:
    """THUẦN, tất định. S1 trước S2; nhóm CAM không in SKU."""
    today = coerce_day(today)
    fs = [f for f in res["listing"] + res["promo"] if f["severity"] != "INFO"]
    info = [f for f in res["listing"] if f["severity"] == "INFO"]
    L = [f"# Giám sát giá & khuyến mãi (A5) — {today:%d/%m/%Y}", "",
         (f"Cấu hình `data/price_watch.json`: {watch['status']} · người chốt:"
          f" {watch['confirmed_by'] or 'chưa có (external-dep)'} · ngưỡng"
          f" lệch niêm yết {watch['list_deviation_pct']}% · trần chiết khấu "
          + ", ".join(f"{k} {v}%" for k, v in
                      sorted(watch["max_discount_pct"].items()))
          + f" · tối đa {watch['max_stacked_promos']} KM chồng · nhìn trước"
          f" {watch['lookahead_days']} ngày."),
         ("Agent CHỈ ĐỌC — mọi đề xuất là NHÁP trong hàng duyệt; agent KHÔNG"
          " đổi giá/khuyến mãi/listing."), ""]
    if plan_rows is None:
        L.append("- [info] chưa có kế hoạch KM (--plan) — chỉ kiểm giá đang"
                 " chạy trên sàn")
    else:
        L.append(f"- Kế hoạch KM: {len(plan_rows)} dòng")
    if plan_info is not None:
        L.append(f"- Sẽ đẩy mục mới: {plan_info['new']} · đã có trong hàng"
                 f" duyệt: {plan_info['seen']} · trùng cảnh báo sàn:"
                 f" {plan_info['dup']}")
    for sev in ("S1", "S2"):
        part = [f for f in fs if f["severity"] == sev]
        L += ["", f"## {sev} ({len(part)})", ""]
        for f in part:
            dup = (f" (đã có cảnh báo sàn #{f['dup_alert']})"
                   if f.get("dup_alert") is not None else "")
            days = _days(f)
            L.append(f"- {KIND_LABELS[f['kind']]} — {_where(f)}"
                     + (f" ({days})" if days else "") + dup)
        if not part:
            L.append("- (không có)")
    L += ["", f"## Giá vốn ({len(info)} listing {NO_COGS})", ""]
    L += [f"- kênh {f['channel']}, SKU {kl.ref_code(f['sku_key'])}: {NO_COGS}"
          for f in info] or ["- (không có)"]
    ev_days = season_events(calendar, today, watch["lookahead_days"])
    L += ["", f"## Sự kiện mùa trong {watch['lookahead_days']} ngày tới", "",
          "| Sự kiện | Ngày | Dòng KM gắn | Phát hiện |", "|---|---|---|---|"]
    for eid, d in ev_days:
        rows = [r for r in plan_rows or [] if r.get("event") == eid]
        pids = {r["program_id"] for r in rows}
        n_f = sum(1 for f in res["promo"]
                  if set(f.get("program_ids") or ()) & pids)
        L.append(f"| {eid} | {d:%d/%m/%Y} | {len(rows)} | {n_f} |")
    if not ev_days:
        L.append("| — | — | 0 | 0 |")
    L += ["", "## Tham khảo đối thủ (KHÔNG dùng để đề xuất giá)", "",
          ("Giá đối thủ do người ghi tay (v7.2) — chỉ để GĐ bán hàng tham"
           " khảo; agent KHÔNG đua giá, không đưa vào đề xuất."), "",
          "| SKU tương đương | Kênh | Đối thủ | Giá | Giá KM | Ngày ghi |",
          "|---|---|---|---|---|---|"]
    L += [f"| {kl.ref_code(s) if s else '(nhóm CAM)'} | {_cell(ch, 20)} | {_cell(c, 60)} |"
          f" {vnd(p)} | {vnd(pp)} | {d:%d/%m/%Y} |"
          for s, ch, c, p, pp, d in res.get("competitor", [])] or [
        "| — | — | — | — | — | — |"]
    L += ["", "---", "*BẢN NHÁP — hệ thống không tự gửi, không tự đổi giá.*",
          ""]
    return "\n".join(L)


# ---------------------------------------------------- v14.4 giá đại lý (06.1)

FEATURE_DEALER = "sales-06.1"
OT_DEALER = "dealer_price_alert"
_HOST_RE = re.compile(r"[a-z0-9.-]{1,100}")
GOLDEN_CHANNELS = ("shopee", "tiktok", "web", "facebook", "zalo", "chatbot")


def _host(url) -> str:
    try:
        h = (urlsplit(url).hostname or "").lower()
    except ValueError:
        h = ""
    return h if _HOST_RE.fullmatch(h) else "(trang lạ)"


def dealer_findings(conn, today: date, dp: dict) -> dict:
    """CHỈ SELECT → {findings: [...], unverifiable: n, checked: n}."""
    today = coerce_day(today)
    since = today - timedelta(days=dp["lookback_days"])
    obs = conn.execute(
        "select o.id, o.channel, o.dealer_code, o.sku_key, o.price_vnd,"
        " o.observed_on, o.source_url, m.category from dealer_price_obs o"
        " join sku_master m on m.sku_key = o.sku_key where o.source <>"
        " 'sample' and o.observed_on >= %s and o.observed_on <= %s"
        " order by o.observed_on, o.id", (since, today)).fetchall()
    if not obs:
        return {"findings": [], "unverifiable": 0, "checked": 0}
    floors: dict = {}
    for sku, ch, price, vf, vt, by in conn.execute(
            "select sku_key, channel, price_vnd, valid_from, valid_to,"
            " approved_by from price_list where kind = 'floor' and"
            " program_id is null and sku_key = any(%s) order by valid_from,"
            " id", (sorted({o[3] for o in obs}),)).fetchall():
        floors.setdefault(sku, []).append((ch, price, vf, vt, by is not None))
    best: dict = {}
    unver = 0
    for oid, ch, dealer, sku, price, day, url, cat in obs:
        live = [(c, pr, ok) for c, pr, vf, vt, ok in floors.get(sku, [])
                if vf <= day and (vt is None or vt > day)]
        if ch in GOLDEN_CHANNELS:
            cand = [x for x in live if x[0] == ch]
            ref = "cùng kênh"
        else:
            cand = live
            ref = "thấp nhất các kênh"
        if not cand:
            unver += 1
            continue
        fl = min(cand, key=lambda x: x[1])
        if price >= fl[1]:
            continue
        key = f"dp:{dealer}:{sku}:{ch}:{day.isoformat()}"
        cur = best.get(key)
        if cur is None or price < cur["price"]:
            best[key] = {"object_id": key, "obs_id": oid, "channel": ch,
                         "dealer": dealer, "sku": sku, "cam": cat ==
                         "alcohol", "price": price, "day": day,
                         "floor": fl[1], "floor_channel": fl[0],
                         "floor_approved": fl[2], "ref": ref,
                         "host": _host(url)}
    fs = sorted(best.values(), key=lambda f: (f["day"], f["object_id"]))
    return {"findings": fs, "unverifiable": unver, "checked": len(obs)}


def dealer_item(f: dict, cfg: dict) -> dict:
    sku = "nhóm hạn chế" if f["cam"] else kl.ref_code(f["sku"])
    label = cfg["object_types"][OT_DEALER]["label"]
    where = (f"đại lý {f['dealer']}, SKU {sku}, kênh {f['channel']}, ngày"
             f" {f['day']:%d/%m/%Y}")
    return {"object_type": OT_DEALER, "object_id": f["object_id"],
            "title": f"{label} — {where}",
            "payload": (
                f"Giá đại lý quan sát tay dưới giá sàn (A5, NHÁP): {where}."
                f" Số liệu: giá quan sát {vnd(f['price'])}, giá sàn golden"
                f" {vnd(f['floor'])} ({f['ref']}, kênh {f['floor_channel']})"
                + ("" if f["floor_approved"] else " (giá sàn CHƯA duyệt)")
                + f". Nguồn: quan sát #{f['obs_id']}, trang {f['host']}."
                " Việc cần làm: GĐ bán hàng xác minh lại trang nguồn và làm"
                " việc với đại lý theo hợp đồng đại lý. Agent KHÔNG liên hệ"
                " đại lý, KHÔNG đổi giá.")}


def dealer_watch(conn, today: date, cfg: dict, dp: dict,
                 dry_run: bool = False) -> dict:
    from pipelines import rollout

    rollout.check_generate(conn, FEATURE_DEALER, "cảnh báo giá đại lý")
    res = dealer_findings(conn, today, dp)
    items = [dealer_item(f, cfg) for f in res["findings"]]
    seen = {(t, o) for t, o in conn.execute(
        "select object_type, object_id from approval_queue where"
        " object_type = %s", (OT_DEALER,)).fetchall()}
    new = [it for it in items if (it["object_type"], it["object_id"])
           not in seen]
    n = 0 if dry_run else kl.enqueue_new(conn, new, cfg, seen, AGENT)
    conn.commit()
    return {**res, "new": len(new), "enqueued": n}


def _dealer_main(args) -> int:
    from agents import sales_watch
    from pipelines import auth
    from pipelines.rollout import RolloutBlocked

    try:
        dp = sales_watch.section("dealer_price")
        cfg = director.load_config(BLOCK)
        if OT_DEALER not in cfg["object_types"]:
            raise DirectorConfigError(f"sales.json thiếu loại việc"
                                      f" {OT_DEALER}")
    except (ValueError, DirectorConfigError) as e:
        print(f"[error] cấu hình lỗi: {e} — không connect", file=sys.stderr)
        return 1
    today = args.as_of or vn_date(datetime.now(VN_TZ))
    if why := auth.bind_service("job"):
        print(f"[err] {why}", flush=True)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        try:
            r = dealer_watch(conn, today, cfg, dp, args.dry_run)
        except RolloutBlocked as e:
            print(f"[rollout] {e}", file=sys.stderr)
            return 2
        tag = "dry-run" if args.dry_run else "dealer-watch"
        print(f"[{tag}] ngày {today:%Y-%m-%d}: {r['checked']} quan sát,"
              f" dưới giá sàn {len(r['findings'])} (mới {r['new']}), không"
              f" kiểm được (thiếu giá sàn) {r['unverifiable']} · đẩy"
              f" {r['enqueued']} mục" + (" — KHÔNG ghi DB" if args.dry_run
                                          else ""))
        return 0
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[error] lỗi DB: {_clean(_db_msg(e), 300)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


# ---------------------------------------------------------------- CLI

def _main(args, ctx: dict) -> int:
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        today = ctx["today"] or vn_date(datetime.now(VN_TZ))
        res = analyze(conn, ctx["mapping"], ctx["watch"], ctx["net_ratio"],
                      today, ctx["plan"])
        fs = res["listing"] + res["promo"]
        items = to_items(fs, ctx["cfg"])
        seen = kl.seen_ids(conn, "a5")
        plan = kl.plan_of(items, fs, seen)
        if ctx["plan"] is None:
            print("[info] chưa có kế hoạch KM (--plan) — chỉ kiểm giá đang"
                  " chạy")
        n1 = sum(f["severity"] == "S1" for f in fs)
        n2 = sum(f["severity"] == "S2" for f in fs)
        print(f"[A5] ngày {today:%Y-%m-%d}: S1 {n1} · S2 {n2} · kênh có file"
              f" listing: {', '.join(res['channels']) or 'chưa có'}")
        if args.report:
            text = render_report(res, ctx["watch"], today, ctx["plan"],
                                 ctx["calendar"], plan)
            path = write_report(text, args.out_dir,
                                f"price-watch-{today:%Y-%m-%d}.md")
            print(f"[report] {path}")
        elif args.dry_run:
            for f in fs:
                if f["severity"] != "INFO":
                    print(f"  [{f['severity']}] {KIND_LABELS[f['kind']]} —"
                          f" {_where(f)}")
            print(f"[dry-run] sẽ đẩy {plan['new']} mục mới · đã có"
                  f" {plan['seen']} · trùng cảnh báo sàn {plan['dup']}"
                  " — KHÔNG ghi DB")
        else:
            n = kl.enqueue_new(conn, items, ctx["cfg"], seen, AGENT)
            conn.commit()     # đóng tx đọc (conn chia sẻ)
            print(f"[run] đẩy {n} mục mới vào hàng duyệt khối {BLOCK}")
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_clean(_db_msg(e), 300)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    return 0


def _load(args) -> tuple[dict | None, list[str]]:
    """Mọi cấu hình + CSV đọc TRƯỚC connect → (ctx, lỗi)."""
    mapping, why = load_mapping()
    if mapping is None:
        return None, [why]
    watch, why = load_watch()
    if watch is None:
        return None, [why]
    net, why = load_net_ratio(watch["channels"])
    if net is None:
        return None, [why]
    try:
        cfg = director.load_config(BLOCK)
        need = {"market_alert_s1", "price_change", "promo_change"}
        if not need <= set(cfg["object_types"]):
            raise DirectorConfigError(f"sales.json thiếu loại việc {need}")
    except DirectorConfigError as e:
        return None, [f"cấu hình lỗi: {e}"]
    try:
        cal = mkt_calendar.load_calendar()
    except mkt_calendar.CalendarError as e:
        return None, [f"lịch mùa lỗi: {e}"]
    plan = None
    if args.plan is not None:
        plan, errs = read_plan(args.plan, watch["promo_kinds"], cal)
        if errs:
            return None, errs
    return {"mapping": mapping, "watch": watch, "net_ratio": net, "cfg": cfg,
            "calendar": cal, "plan": plan, "today": args.as_of}, []


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_price",
        description="KD-A5 — giám sát giá + khuyến mãi theo giá sàn/list "
                    "golden, biên, trần KM → NHÁP hàng duyệt (agent KHÔNG "
                    "đổi giá)")
    ap.add_argument("--run", action="store_true",
                    help="đẩy phát hiện mới vào hàng duyệt khối KD")
    ap.add_argument("--report", action="store_true",
                    help="báo cáo price-watch-<ngày>.md → data/reports/")
    ap.add_argument("--dry-run", action="store_true",
                    help="với --run: chỉ đọc, in kế hoạch")
    ap.add_argument("--plan", type=Path,
                    help="CSV kế hoạch khuyến mãi (nhập tay, utf-8)")
    ap.add_argument("--as-of", help="ngày kiểm YYYY-MM-DD (giờ VN) — chỉ với"
                                    " --report hoặc --run --dry-run")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--dealer-watch", action="store_true",
                    help="so giá đại lý quan sát tay (nạp bằng"
                         " `ingest.dealer_price`) với giá sàn golden → hàng"
                         " duyệt (v14.4)")
    args = ap.parse_args(argv)
    n_ops = sum([args.run, args.report, args.dealer_watch])
    if n_ops > 1:
        ap.error("chỉ được 1 thao tác mỗi lần (--run | --report |"
                 " --dealer-watch)")
    if n_ops == 0:
        ap.error("cần --run, --report hoặc --dealer-watch")
    if args.dry_run and not (args.run or args.dealer_watch):
        ap.error("--dry-run chỉ đi với --run / --dealer-watch")
    if args.dealer_watch and args.plan is not None:
        ap.error("--plan không dùng với --dealer-watch")
    if args.as_of is not None:
        if (args.run or args.dealer_watch) and not args.dry_run:
            ap.error("--as-of chỉ dùng với --report hoặc --run/--dealer-watch"
                     " --dry-run (không ghi hàng duyệt theo ngày giả)")
        try:
            args.as_of = coerce_day(args.as_of)
        except ValueError:
            ap.error("--as-of phải dạng YYYY-MM-DD")
    if args.dealer_watch:
        return _dealer_main(args)
    ctx, errs = _load(args)
    if ctx is None:
        for e in errs[:MAX_PRINT_ERRS]:
            print(f"[error] {e}", file=sys.stderr)
        if len(errs) > MAX_PRINT_ERRS:
            print(f"[error] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác",
                  file=sys.stderr)
        print(f"[error] {len(errs)} lỗi — không connect, không ghi gì.",
              file=sys.stderr)
        return 1
    if not args.run or args.dry_run:
        return _main(args, ctx)
    # Ghi lần chạy vào job_runs (bản tin GĐ KD mục 6 + sức khỏe F17.2).
    with job_run(JOB) as r:
        rc = _main(args, ctx)
        r["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
