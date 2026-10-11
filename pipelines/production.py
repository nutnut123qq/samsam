"""v9.2 Sản xuất P1 (WP13) — SX-A3 phân bổ tồn, SX-A4 BOM combo/hộp quà,
SX-A5 hồ sơ lô + kiểm nhập, SX-A0 bản tin tuần cho GĐ sản xuất.

Agent CHỈ ĐỀ XUẤT: không chuyển kho, không sửa tồn, không đặt mua, không
lệnh sản xuất, không đổi giá/listing, không ghi golden/orders/products,
0 lời gọi LLM. Mọi quyết định của NGƯỜI (duyệt phân bổ, kiểm nhập lô) cần
`--by` và đi qua function DB SECURITY DEFINER `decide_allocation_run` /
`record_lot_intake` (ghi `approvals` + `agent_action_log` hash chain v3.4) —
module KHÔNG insert thẳng `approvals` (không role nào được grant INSERT
approvals: `verify_publish` tin bảng đó).

Nhu cầu = `scenario.project()` (engine kịch bản mùa DÙNG CHUNG v7.3) cộng
theo tuần — module này KHÔNG tự nhân hệ số mùa, không đọc file giả định
trực tiếp. Rượu: phân bổ 0 mọi kênh online (chốt chặn thứ 2, bất kể
nhu cầu), combo có rượu chỉ kênh offline.

Hàm thuần (nhận `today`/`now` làm tham số, không đọc đồng hồ):
  load_config(path=None) -> dict
  demand_for(sku, start, until, assumptions) -> {kênh: {low, base, high, note}}
  allocate(stock, demand, category) -> {"proposed", "unallocated", "flag", ...}
  check_bom(combos, golden_skus) -> [lỗi]
  buildable(items, stock) -> (số combo làm được, [SKU thiếu số tồn])
  validate_lots(lots, golden_skus, today) -> [lỗi]
  qr_payload(lot) -> dict | None      (điểm nối QR truy xuất v9.4)
  render_bulletin(data, now, config) -> str

CLI: python -m pipelines.production
       allocate --cutoff <id> [--start YYYY-MM-DD]
       approve --run <run_id> --by <tên> [--note ..]
       reject  --run <run_id> --by <tên> [--note ..]
       bom --load FILE [--source manual|sample] | bom --check
       lots --load FILE [--source manual|sample]
       intake --lot <mã> --result passed|failed --by <tên> [--note ..]
       bulletin [--date YYYY-MM-DD]
Exit: 0 OK / [skip]; 1 dữ liệu/DB lỗi; 2 sai usage.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest import golden_store, inventory_csv, market_csv
from pipelines import scenario  # engine kịch bản mùa dùng chung (v7.3)
from pipelines.guardrail import check as guardrail_check

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "production_config.json"
GOLDEN_FILE = golden_store.GOLDEN_FILE

TZ_VN = dt.timezone(dt.timedelta(hours=7))
MAX_BY_LEN = golden_store.MAX_BY_LEN
MAX_NOTE_LEN = 500
QTY_MAX = 2 * 10**9
MAX_SLA_HOURS = 24 * 365
MAX_FILE_BYTES = 5 * 1024 * 1024
ONLINE = golden_store.CHANNELS

DISCLAIMER = ("Khoảng thấp/cơ sở/cao — KHÔNG phải doanh số cam kết; ĐỀ XUẤT "
              "chờ GĐ sản xuất duyệt — không tự chuyển kho")
NO_NEW_PRODUCTION = "chỉ phân bổ tồn hiện có — không đề xuất sản xuất mới"
NOTE_NO_STOCK = "chưa có số tồn — không kết luận thiếu"
NOTE_SPARE = "dự phòng chưa phân bổ"
NOTE_ALCOHOL_ONLINE = "rượu: chỉ kênh offline — đề xuất 0"
BUILDABLE_NOTE = "tính trên tồn CHƯA trừ phân bổ — tham khảo"
ALLOC_TABLES = ("inventory_snapshots", "allocation_proposals", "bom_combos",
                "bom_items", "production_lots")

_ID_RE = re.compile(r"^[a-z0-9]+(?:[_-][a-z0-9]+)*$")
_RUN_RE = re.compile(r"^[0-9a-f]{12}$")
LOT_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,31}$")
LOT_KEYS = ("lot_code", "sku_key", "mfg_date", "exp_date", "qty", "note")
COMBO_KEYS = ("combo_key", "name", "channels", "items", "note")
ITEM_KEYS = ("sku_key", "qty")


class ProductionError(ValueError):
    """Config/dữ liệu sản xuất không dùng được — fail-closed."""


def _clean(v, n: int = 80) -> str:
    """Chuỗi từ file/DB trước khi in: bỏ ký tự điều khiển, cắt độ dài."""
    return market_csv._clean(v, n)


def _canon(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str)


def _sha(obj) -> str:
    return hashlib.sha256(_canon(obj).encode("utf-8")).hexdigest()


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _reject_constant(name):
    raise ValueError(f"hằng {name} không hợp lệ")


def _iso(v, where: str) -> dt.date:
    d = inventory_csv._iso_date(v) if isinstance(v, str) else None
    if d is None:
        raise ProductionError(f"{where}: không phải ngày YYYY-MM-DD")
    if not scenario.DATE_MIN <= d <= scenario.DATE_MAX:
        raise ProductionError(f"{where}: phải trong {scenario.DATE_MIN}.."
                              f"{scenario.DATE_MAX}")
    return d


def read_json(path, list_key: str) -> dict:
    """Đọc file JSON nguồn (config/BOM/lô). Mọi biến thể "không có dữ
    liệu" (thiếu / rỗng / JSON hỏng / không phải object / `{}` / chỉ
    `_doc`) → ProductionError; caller dừng TRƯỚC khi connect."""
    p = Path(path)
    try:
        if p.stat().st_size > MAX_FILE_BYTES:
            raise ProductionError(f"{p.name} quá lớn")
        text = p.read_bytes().decode("utf-8-sig")
    except FileNotFoundError as e:
        raise ProductionError(f"thiếu file {p.name}") from e
    except (OSError, UnicodeDecodeError) as e:
        raise ProductionError(f"không đọc được {p.name} "
                              f"({type(e).__name__})") from e
    if not text.strip():
        raise ProductionError(f"{p.name} rỗng")
    try:
        doc = json.loads(text, parse_constant=_reject_constant)
    except ValueError as e:
        raise ProductionError(f"{p.name} JSON hỏng: {type(e).__name__}") from e
    if not isinstance(doc, dict):
        raise ProductionError(f"{p.name}: root phải là object")
    if not (set(doc) - {"_doc"}):
        raise ProductionError(f"{p.name}: không có dữ liệu (0 record)")
    if list_key and (not isinstance(doc.get(list_key), list)
                     or not doc[list_key]):
        raise ProductionError(f"{p.name}: '{list_key}' phải là list không rỗng")
    return doc


# ---------- cấu hình mốc chốt + SLA ----------

def validate_config(doc) -> dict:
    status = doc.get("status")
    if not isinstance(status, str) or not status.strip():
        raise ProductionError("config: thiếu 'status'")
    raw = doc.get("cutoffs")
    if not isinstance(raw, list) or not raw:
        raise ProductionError("config: 'cutoffs' phải là list không rỗng")
    cutoffs, ids = [], set()
    for i, c in enumerate(raw):
        where = f"cutoffs[{i}]"
        if not isinstance(c, dict):
            raise ProductionError(f"{where}: phải là object")
        cid = c.get("id")
        if not isinstance(cid, str) or not _ID_RE.match(cid) or len(cid) > 40:
            raise ProductionError(f"{where}.id: phải là slug a-z0-9_-")
        if cid in ids:
            raise ProductionError(f"{where}.id: trùng")
        ids.add(cid)
        d = _iso(c.get("date"), f"{where}.date")
        until = _iso(c.get("covers_until"), f"{where}.covers_until")
        if until <= d:
            raise ProductionError(f"{where}: covers_until phải sau date")
        label = c.get("label", "")
        if not isinstance(label, str):
            raise ProductionError(f"{where}.label: phải là chuỗi")
        cutoffs.append({"id": cid, "date": d, "covers_until": until,
                        "label": label})
    sla, remind = doc.get("sla_hours"), doc.get("remind_hours")
    if not (_is_int(sla) and _is_int(remind)
            and 0 < remind < sla <= MAX_SLA_HOURS):
        raise ProductionError("config: cần số nguyên 0 < remind_hours < "
                              f"sla_hours <= {MAX_SLA_HOURS}")
    return {"status": status.strip(), "cutoffs": cutoffs, "sla_hours": sla,
            "remind_hours": remind}


def load_config(path=None) -> dict:
    return validate_config(read_json(path or CONFIG_FILE, ""))


# ---------- SX-A3 phân bổ tồn (thuần) ----------

def weeks_between(start: dt.date, until: dt.date) -> int:
    w0, w1 = scenario.week_start(start), scenario.week_start(until)
    n = (w1 - w0).days // 7 + 1
    if n < 1:
        raise ProductionError("start sau covers_until của mốc")
    if n > scenario.MAX_WEEKS:
        raise ProductionError(f"quá {scenario.MAX_WEEKS} tuần từ start tới "
                              "covers_until")
    return n


def demand_for(sku: dict, start: dt.date, until: dt.date,
               assumptions: dict) -> dict:
    """Nhu cầu cộng dồn start..until theo MỖI kênh — gọi scenario.project,
    không công thức riêng. Raise ScenarioError/ProductionError."""
    weeks = weeks_between(start, until)
    out = {}
    for ch in scenario.ALL_CHANNELS:
        rows = scenario.project(sku, ch, start, weeks, assumptions)
        d = {lv: sum(r[lv] for r in rows) for lv in scenario.LEVELS}
        d["note"] = next((r["note"] for r in rows if r.get("note")), None)
        out[ch] = d
    return out


def shortage(stock: int | None, sums: dict) -> tuple[str | None, str | None]:
    """→ (mức, chữ) — mức 'low' | 'base' | 'high' | None. stock None →
    (None, None): chưa có số tồn KHÔNG phải thiếu."""
    if stock is None:
        return None, None
    gap = sums["base"] - stock
    if sums["low"] > stock:
        return "low", f"THIẾU CẢ KỊCH BẢN THẤP (thiếu {gap} so với cơ sở)"
    if gap > 0:
        return "base", f"THIẾU (cơ sở) {gap}"
    if sums["high"] > stock:
        return "high", (f"RỦI RO (kịch bản cao) thiếu {sums['high'] - stock}"
                        " nếu bán theo mức cao")
    return None, None


def allocate(stock: int | None, demand: dict, category: str) -> dict:
    """Hàm thuần, tất định. → {"demand": {kênh: {low, base, high}} (đã áp
    luật rượu), "proposed": {kênh: int}, "notes": {kênh: str|None},
    "unallocated": int|None, "sums", "flag_level", "flag"}."""
    if stock is not None and (not _is_int(stock) or stock < 0):
        raise ProductionError("stock phải là số nguyên >= 0 hoặc None")
    chans = scenario.ALL_CHANNELS
    dem, notes = {}, {}
    for c in chans:
        d = demand.get(c) or {}
        vals = {lv: d.get(lv, 0) for lv in scenario.LEVELS}
        if not all(_is_int(v) and v >= 0 for v in vals.values()):
            raise ProductionError(f"demand {c}: phải là số nguyên >= 0")
        notes[c] = d.get("note")
        # Chốt chặn thứ 2: rượu 0 mọi kênh online BẤT KỂ nhu cầu đưa vào.
        if category == "alcohol" and c != scenario.OFFLINE:
            notes[c] = NOTE_ALCOHOL_ONLINE
            vals = dict.fromkeys(scenario.LEVELS, 0)
        dem[c] = vals
    sums = {lv: sum(dem[c][lv] for c in chans) for lv in scenario.LEVELS}
    base = {c: dem[c]["base"] for c in chans}
    total = sums["base"]
    if stock is None:
        proposed, spare = dict.fromkeys(chans, 0), None
    elif stock >= total:
        proposed, spare = dict(base), stock - total
    else:
        # Chia tỉ lệ cơ sở: floor + phần dư lớn nhất, hòa theo thứ tự kênh.
        proposed = {c: stock * base[c] // total for c in chans}
        left = stock - sum(proposed.values())
        order = sorted(range(len(chans)),
                       key=lambda i: (-(stock * base[chans[i]] % total), i))
        for i in order[:left]:
            proposed[chans[i]] += 1
        spare = 0
    level, text = shortage(stock, sums)
    if stock is None:
        text = NOTE_NO_STOCK
    return {"demand": dem, "proposed": proposed, "notes": notes,
            "unallocated": spare, "sums": sums, "flag_level": level,
            "flag": text}


def plan_rows(skus: list[dict], stock: dict, demands: dict) -> list[dict]:
    """skus golden × kênh → dòng `allocation_proposals` (chưa có run_id).
    stock: kết quả `current_stock`; demands: {sku_key: demand_for(...)}."""
    rows = []
    for s in sorted(skus, key=lambda s: s["sku_key"]):
        key = s["sku_key"]
        st = stock.get(key)
        qty = st["qty"] if st else None
        a = allocate(qty, demands[key], s.get("category"))
        stale = st.get("stale") if st else None
        for c in scenario.ALL_CHANNELS:
            note = [n for n in (a["notes"][c], a["flag"]) if n]
            if stale:
                note.append(f"{inventory_csv.STALE_NOTE} "
                            f"({_clean(', '.join(stale), 200)})")
            if c == scenario.OFFLINE and a["unallocated"]:
                note.append(f"{NOTE_SPARE} {a['unallocated']}")
            rows.append({"sku_key": key, "channel": c, "stock_total": qty,
                         "demand_low": a["demand"][c]["low"],
                         "demand_base": a["demand"][c]["base"],
                         "demand_high": a["demand"][c]["high"],
                         "proposed_qty": a["proposed"][c],
                         "note": "; ".join(note) or None,
                         "flag": a["flag"], "flag_level": a["flag_level"],
                         "stale": list(stale or []),
                         "sample": bool(st and st["sample"])})
    return rows


def run_id_for(cutoff: dict, start_week: dt.date, stock: dict,
               assumptions_status: str, assumptions_bytes: bytes,
               golden_bytes: bytes) -> str:
    used = sorted([k, kho, v["qty"], v["captured_at"]]
                  for k, s in stock.items() for kho, v in s["kho"].items())
    return _sha({"cutoff": cutoff, "start_week": start_week, "stock": used,
                 "status": assumptions_status,
                 "assumptions": hashlib.sha256(assumptions_bytes).hexdigest(),
                 "golden": hashlib.sha256(golden_bytes).hexdigest()})[:12]


# ---------- SX-A4 BOM (thuần) ----------

def check_bom(combos: list, golden_skus: dict) -> list[str]:
    """Luật kênh THEO DỮ LIỆU golden: mỗi kênh online của combo phải có
    trong allowed_channels của MỌI SKU thành phần; combo có rượu chỉ được
    kênh offline (bất kể allowed_channels của SKU rượu). Lỗi chỉ nêu
    combo_key / sku_key / kênh."""
    if not isinstance(combos, list) or not combos:
        return ["combos phải là list không rỗng"]
    errs, seen = [], set()
    for i, c in enumerate(combos):
        if not isinstance(c, dict):
            errs.append(f"combos[{i}]: phải là object")
            continue
        key = c.get("combo_key")
        if not isinstance(key, str) or not golden_store._SLUG_RE.match(key) \
                or len(key) > 64:
            errs.append(f"combos[{i}]: combo_key phải là slug ascii")
            key = f"combos[{i}]"
        elif key in seen:
            errs.append(f"combo {key}: combo_key trùng")
        seen.add(key)
        extra = sorted(set(c) - set(COMBO_KEYS))
        if extra:
            errs.append(f"combo {key}: key lạ "
                        f"{_clean(', '.join(map(str, extra)), 80)}")
        name = c.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            errs.append(f"combo {key}: name rỗng hoặc > 200 ký tự")
        elif not guardrail_check(name).get("ok"):
            errs.append(f"combo {key}: tên vi phạm guardrail")
        if c.get("note") is not None and (not isinstance(c["note"], str)
                                          or len(c["note"]) > MAX_NOTE_LEN):
            errs.append(f"combo {key}: note phải là chuỗi <= {MAX_NOTE_LEN}")
        chans = c.get("channels")
        if (not isinstance(chans, list) or not chans
                or not all(isinstance(x, str) for x in chans)
                or len(set(chans)) != len(chans)
                or not set(chans) <= set(scenario.ALL_CHANNELS)):
            errs.append(f"combo {key}: channels phải là list kênh hợp lệ, "
                        "không rỗng, không trùng")
            chans = []
        items = c.get("items")
        if not isinstance(items, list) or not items:
            errs.append(f"combo {key}: items rỗng")
            items = []
        skus, iseen = [], set()
        for j, it in enumerate(items):
            if not isinstance(it, dict) or set(it) - set(ITEM_KEYS):
                errs.append(f"combo {key}: items[{j}] phải là object "
                            "{sku_key, qty}")
                continue
            sku = it.get("sku_key")
            if not isinstance(sku, str) or sku not in golden_skus:
                errs.append(f"combo {key}: items[{j}] sku_key không có "
                            "trong golden")
            elif sku in iseen:
                errs.append(f"combo {key}: SKU {sku} trùng")
            else:
                iseen.add(sku)
                skus.append(sku)
            q = it.get("qty")
            if not _is_int(q) or not 0 < q <= QTY_MAX:
                errs.append(f"combo {key}: items[{j}] qty phải nguyên > 0")
        online = [ch for ch in chans if ch in ONLINE]
        if online and any(golden_skus[s].get("category") == "alcohol"
                          for s in skus):
            errs.append(f"combo {key}: combo có rượu chỉ được kênh offline "
                        f"(đang có {', '.join(online)})")
        for ch in online:
            for s in skus:
                if ch not in (golden_skus[s].get("allowed_channels") or []):
                    errs.append(f"combo {key} kênh {ch}: SKU {s} không có "
                                f"{ch} trong allowed_channels")
    return errs


def buildable(items: list[dict], stock: dict) -> tuple[int, list[str]]:
    """Số combo làm được = min(tồn[sku] // qty). stock: {sku_key: int}.
    SKU thiếu số tồn → 0 + danh sách SKU thiếu (không đoán)."""
    missing = sorted(it["sku_key"] for it in items
                     if stock.get(it["sku_key"]) is None)
    if missing or not items:
        return 0, missing
    return min(stock[it["sku_key"]] // it["qty"] for it in items), []


# ---------- SX-A5 hồ sơ lô (thuần) ----------

def validate_lots(lots: list, golden_skus: dict, today: dt.date) -> list[str]:
    if not isinstance(lots, list) or not lots:
        return ["lots phải là list không rỗng"]
    errs, seen = [], set()
    for i, lot in enumerate(lots):
        if not isinstance(lot, dict):
            errs.append(f"lots[{i}]: phải là object")
            continue
        code = lot.get("lot_code")
        if not isinstance(code, str) or not LOT_RE.match(code):
            errs.append(f"lots[{i}]: lot_code phải khớp {LOT_RE.pattern}")
            code = f"lots[{i}]"
        elif code in seen:
            errs.append(f"lô {code}: lot_code trùng")
        seen.add(code)
        extra = sorted(map(str, set(lot) - set(LOT_KEYS)))
        if extra:
            errs.append(f"lô {code}: key lạ {_clean(', '.join(extra), 80)}")
        sku = lot.get("sku_key")
        if not isinstance(sku, str) or sku not in golden_skus:
            errs.append(f"lô {code}: sku_key không có trong golden")
        mfg = exp = None
        try:
            mfg = _iso(lot.get("mfg_date"), f"lô {code} mfg_date")
            if mfg > today:
                errs.append(f"lô {code}: mfg_date ở tương lai")
        except ProductionError as e:
            errs.append(str(e))
        try:
            exp = _iso(lot.get("exp_date"), f"lô {code} exp_date")
        except ProductionError as e:
            errs.append(str(e))
        if mfg and exp and exp <= mfg:
            errs.append(f"lô {code}: hạn dùng phải SAU ngày sản xuất")
        q = lot.get("qty")
        if not _is_int(q) or not 0 < q <= QTY_MAX:
            errs.append(f"lô {code}: qty phải nguyên > 0")
        if lot.get("note") is not None and (
                not isinstance(lot["note"], str)
                or len(lot["note"]) > MAX_NOTE_LEN):
            errs.append(f"lô {code}: note phải là chuỗi <= {MAX_NOTE_LEN}")
    return errs


def qr_payload(lot: dict) -> dict | None:
    """Điểm nối QR truy xuất (v9.4 sinh QR/trang từ hàm này). Chỉ lô đã
    kiểm nhập 'passed'; không người kiểm, không PII."""
    if not isinstance(lot, dict) or lot.get("intake_status") != "passed":
        return None
    exp = lot.get("exp_date")
    return {"lot_code": lot.get("lot_code"), "sku_key": lot.get("sku_key"),
            "exp_date": exp.isoformat() if isinstance(exp, dt.date) else exp}


# ---------- SX-A0 bản tin (thuần) ----------

def _age_label(age: dt.timedelta, config: dict) -> str:
    if age >= dt.timedelta(hours=config["sla_hours"]):
        return f"QUÁ SLA {config['sla_hours']}h — đề xuất chuyển TGĐ"
    if age >= dt.timedelta(hours=config["remind_hours"]):
        return "NHẮC"
    return "trong hạn"


def render_bulletin(data: dict, now: dt.datetime, config: dict) -> str:
    """Tất định: cùng data + now → cùng chuỗi. Chỉ chữ — không đổi trạng
    thái, không gửi đi."""
    day = data.get("date") or now.astimezone(TZ_VN).date()
    missing = set(data.get("missing_tables", ()))
    no_table = "chưa có bảng — chạy apply_schema"
    out = [f"# Bản tin Sản xuất tuần — {day.isoformat()}", "",
           f"Cấu hình mốc/SLA: {config['status']}"]
    if data.get("sample"):
        out.append("[MẪU] Có dữ liệu mẫu (source='sample') — số liệu "
                   "chưa phải thật.")
    out += [("KHÔNG phải doanh số cam kết — agent chỉ đề xuất; không "
             "chuyển kho, không đặt mua, không lệnh sản xuất."), ""]

    out += ["## Thiếu hàng theo mốc chốt",
            "Nguồn: `allocation_proposals` (run mới nhất mỗi mốc)."]
    if "allocation_proposals" in missing:
        out.append(no_table)
    else:
        rows = sorted(data.get("shortages", []),
                      key=lambda r: (r["cutoff_date"], r["cutoff_id"],
                                     r["sku_key"]))
        for r in rows:
            left = (r["cutoff_date"] - day).days
            when = (f"còn {left} ngày" if left >= 0
                    else f"đã qua {-left} ngày")
            out.append(f"- {_clean(r['cutoff_id'])} ({r['cutoff_date']}, "
                       f"{when}) · run {_clean(r['run_id'])} [{r['status']}] "
                       f"· {_clean(r['sku_key'])}: "
                       f"tồn {r['stock_total']}, cơ sở {r['base']} "
                       f"(thấp {r['low']}, cao {r['high']}) — {r['flag']}")
        nostock = sorted(data.get("no_stock", []))
        if nostock:
            out.append(f"- {NOTE_NO_STOCK}: "
                       f"{_clean(', '.join(nostock), 2000)}")
        stale = sorted(data.get("stale_stock", []))
        if stale:
            out.append(f"- {inventory_csv.STALE_NOTE} (nguồn "
                       "`inventory_snapshots`): " + _clean(", ".join(
                           f"{k}@{kho}" for k, kho in stale), 2000))
        if not rows and not nostock and not stale:
            out.append("không có")
    out.append("")

    out += ["## Lô chờ kiểm nhập", "Nguồn: `production_lots` (pending)."]
    if "production_lots" in missing:
        out.append(no_table)
    else:
        lots = sorted(data.get("lots_pending", []),
                      key=lambda r: (r["created_at"], r["lot_code"]))
        for r in lots:
            out.append(f"- {_clean(r['lot_code'])} · {_clean(r['sku_key'])} · SX "
                       f"{r['mfg_date']} · HSD {r['exp_date']} · {r['qty']}")
        if not lots:
            out.append("không có")
    out.append("")

    out += ["## BOM lỗi",
            "Nguồn: `bom_combos` + `bom_items` × golden file hiện tại."]
    if missing & {"bom_combos", "bom_items"}:
        out.append(no_table)
    else:
        errs = sorted(data.get("bom_errors", []))
        out += [f"- {_clean(e, 300)}" for e in errs] or ["không có"]
    out.append("")

    out += ["## Mục chờ duyệt & SLA",
            (f"Nguồn: `allocation_proposals` + `production_lots` (nhắc ≥ "
             f"{config['remind_hours']}h, SLA {config['sla_hours']}h — chỉ "
             "là chữ trong bản tin, không tự chuyển/duyệt thay).")]
    if missing & {"allocation_proposals", "production_lots"}:
        out.append(no_table)
    items = sorted(data.get("pending", []),
                   key=lambda r: (-(now - r["created_at"]).total_seconds(),
                                  r["kind"], r["id"]))
    for r in items:
        age = now - r["created_at"]
        hours = max(0, int(age.total_seconds() // 3600))
        out.append(f"- {r['kind']} {_clean(r['id'])} — chờ {hours}h — "
                   f"{_age_label(age, config)}")
    if not items and not missing & {"allocation_proposals", "production_lots"}:
        out.append("không có")
    return "\n".join(out) + "\n"


# ---------- DB ----------

def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def _open():
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return None
    try:
        return _connect(dsn)
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}")
        return None


def save_proposals(conn, run_id: str, cutoff: dict, start_week: dt.date,
                   rows: list[dict]) -> int:
    """Ghi NHÁP pending. Không commit — caller commit."""
    n = 0
    for r in rows:
        n += conn.execute(
            "insert into allocation_proposals (run_id, cutoff_id,"
            " cutoff_date, start_week, sku_key, channel, stock_total,"
            " demand_low, demand_base, demand_high, proposed_qty, note)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " on conflict (run_id, sku_key, channel) do nothing",
            (run_id, cutoff["id"], cutoff["date"], start_week, r["sku_key"],
             r["channel"], r["stock_total"], r["demand_low"],
             r["demand_base"], r["demand_high"], r["proposed_qty"],
             r["note"])).rowcount
    return n


def _decide(conn, sql: str, params: tuple):
    """Gọi function DB SECURITY DEFINER (docs/schema.sql v9.2) trong 1
    savepoint/transaction — client KHÔNG insert thẳng `approvals`. Lỗi
    nghiệp vụ (RAISE) → (None, lý do); không commit — caller commit."""
    try:
        with conn.transaction():
            return conn.execute(sql, params).fetchone(), None
    except psycopg.errors.RaiseException as e:
        return None, _clean(e.diag.message_primary or "bị từ chối", 200)


def decide_run(conn, run_id: str, decision: str, by: str,
               note: str | None = None) -> tuple[bool, str]:
    """NGƯỜI duyệt/từ chối cả 1 run phân bổ qua `decide_allocation_run`.
    Không đụng `inventory_snapshots` (duyệt ≠ chuyển kho)."""
    row, why = _decide(conn, "select out_approval_id, out_rows from"
                       " decide_allocation_run(%s, %s, %s, %s)",
                       (run_id, decision, by, note))
    if row is None:
        return False, why
    return True, (f"run {run_id}: {row[1]} dòng → {decision} "
                  f"(approvals #{row[0]})")


def load_bom(conn, combos: list[dict], source: str) -> tuple[int, int]:
    """Upsert combo + thay toàn bộ items của combo trong file. Bản `manual`
    không bị nạp `sample` đè. Không commit. → (combo ghi, combo bỏ qua)."""
    done = skipped = 0
    for c in combos:
        got = conn.execute(
            "insert into bom_combos (combo_key, name, channels, source, note)"
            " values (%s, %s, %s, %s, %s) on conflict (combo_key) do update"
            " set name = excluded.name, channels = excluded.channels,"
            " source = excluded.source, note = excluded.note,"
            " updated_at = now()"
            " where not (bom_combos.source = 'manual'"
            " and excluded.source = 'sample') returning combo_key",
            (c["combo_key"], c["name"], list(c["channels"]), source,
             c.get("note"))).fetchone()
        if got is None:
            skipped += 1
            continue
        conn.execute("delete from bom_items where combo_key = %s",
                     (c["combo_key"],))
        for it in c["items"]:
            conn.execute("insert into bom_items (combo_key, sku_key, qty)"
                         " values (%s, %s, %s)",
                         (c["combo_key"], it["sku_key"], it["qty"]))
        done += 1
    return done, skipped


def db_combos(conn) -> list[dict]:
    combos = {}
    for key, name, chans, source, note in conn.execute(
            "select combo_key, name, channels, source, note from bom_combos"
            " order by combo_key"):
        combos[key] = {"combo_key": key, "name": name, "channels": chans,
                       "items": [], "_source": source}
        if note is not None:
            combos[key]["note"] = note
    for key, sku, qty in conn.execute(
            "select combo_key, sku_key, qty from bom_items"
            " order by combo_key, sku_key"):
        if key in combos:
            combos[key]["items"].append({"sku_key": sku, "qty": qty})
    return list(combos.values())


def _strip_meta(combos: list[dict]) -> list[dict]:
    return [{k: v for k, v in c.items() if not k.startswith("_")}
            for c in combos]


def load_lots(conn, lots: list[dict], source: str) -> tuple[int, int]:
    """Insert lô mới; lô đã có KHÔNG bị ghi đè. Không commit."""
    new = 0
    for lot in lots:
        new += conn.execute(
            "insert into production_lots (lot_code, sku_key, mfg_date,"
            " exp_date, qty, source, note) values (%s, %s, %s, %s, %s, %s,"
            " %s) on conflict (lot_code) do nothing",
            (lot["lot_code"], lot["sku_key"], lot["mfg_date"],
             lot["exp_date"], lot["qty"], source, lot.get("note"))).rowcount
    return new, len(lots) - new


def intake(conn, lot_code: str, result: str, by: str,
           note: str | None = None) -> tuple[bool, str]:
    """NGƯỜI kiểm nhập 1 lô qua `record_lot_intake`: chỉ từ pending."""
    row, why = _decide(conn, "select record_lot_intake(%s, %s, %s, %s)",
                       (lot_code, result, by, note))
    if row is None:
        return False, why
    return True, f"lô {lot_code} → {result} (approvals #{row[0]})"


def collect(conn, golden_skus: dict | None, golden_why: str | None = None
            ) -> dict:
    """Chỉ SQL (0 LLM) → data cho `render_bulletin`. Không ghi gì."""
    missing = [t for t in ALLOC_TABLES if conn.execute(
        "select to_regclass(%s) is null", (t,)).fetchone()[0]]
    data = {"missing_tables": missing, "shortages": [], "no_stock": [],
            "stale_stock": [], "lots_pending": [], "bom_errors": [],
            "pending": [], "sample": False}
    for t in ("inventory_snapshots", "bom_combos", "production_lots"):
        if t not in missing and conn.execute(
                f"select exists (select 1 from {t} where source = 'sample')"
                ).fetchone()[0]:
            data["sample"] = True
    if "inventory_snapshots" not in missing:
        data["stale_stock"] = sorted(
            (sku, kho) for sku, s in inventory_csv.current_stock(conn).items()
            for kho in s["stale"])
    if "allocation_proposals" not in missing:
        for (cid, cdate, run_id, status, sku, stock, lo, ba, hi) in \
                conn.execute(
                "with latest as (select distinct on (cutoff_id) cutoff_id,"
                " run_id from allocation_proposals"
                " order by cutoff_id, created_at desc, id desc)"
                " select p.cutoff_id, min(p.cutoff_date), p.run_id,"
                " min(p.status), p.sku_key, min(p.stock_total),"
                " sum(p.demand_low), sum(p.demand_base), sum(p.demand_high)"
                " from allocation_proposals p join latest l"
                " on l.run_id = p.run_id and l.cutoff_id = p.cutoff_id"
                " group by p.cutoff_id, p.run_id, p.sku_key"):
            sums = {"low": int(lo), "base": int(ba), "high": int(hi)}
            level, text = shortage(stock, sums)
            if stock is None:
                if sku not in data["no_stock"]:
                    data["no_stock"].append(sku)
            elif level:
                data["shortages"].append({
                    "cutoff_id": cid, "cutoff_date": cdate, "run_id": run_id,
                    "status": status, "sku_key": sku, "stock_total": stock,
                    **sums, "flag": text})
        for run_id, created in conn.execute(
                "select run_id, min(created_at) from allocation_proposals"
                " where status = 'pending' group by run_id"):
            data["pending"].append({"kind": "phân bổ", "id": run_id,
                                    "created_at": created})
    if "production_lots" not in missing:
        for code, sku, mfg, exp, qty, created in conn.execute(
                "select lot_code, sku_key, mfg_date, exp_date, qty,"
                " created_at from production_lots"
                " where intake_status = 'pending'"):
            data["lots_pending"].append({
                "lot_code": code, "sku_key": sku, "mfg_date": mfg,
                "exp_date": exp, "qty": qty, "created_at": created})
            data["pending"].append({"kind": "lô", "id": code,
                                    "created_at": created})
    if not {"bom_combos", "bom_items"} & set(missing):
        combos = db_combos(conn)
        if combos and golden_skus is None:
            data["bom_errors"].append(f"golden không đọc được: {golden_why}")
        elif combos:
            data["bom_errors"] = check_bom(_strip_meta(combos), golden_skus)
    return data


# ---------- CLI ----------

def _today_vn() -> dt.date:
    return dt.datetime.now(TZ_VN).date()


def _date_arg(s: str) -> dt.date:
    d = inventory_csv._iso_date(s)
    if d is None or not scenario.DATE_MIN <= d <= scenario.DATE_MAX:
        raise argparse.ArgumentTypeError(
            f"ngày YYYY-MM-DD trong {scenario.DATE_MIN}..{scenario.DATE_MAX}")
    return d


def _by_arg(s: str) -> str:
    s = s.strip()
    if not s or len(s) > MAX_BY_LEN or not s.isprintable():
        raise argparse.ArgumentTypeError(
            f"tên người không rỗng, tối đa {MAX_BY_LEN} ký tự in được")
    return s


def _note_arg(s: str) -> str:
    s = s.strip()
    if len(s) > MAX_NOTE_LEN or not s.isprintable():
        raise argparse.ArgumentTypeError(
            f"note tối đa {MAX_NOTE_LEN} ký tự in được")
    return s


def _run_arg(s: str) -> str:
    if not _RUN_RE.match(s):
        raise argparse.ArgumentTypeError("run_id là 12 ký tự hex")
    return s


def _lot_arg(s: str) -> str:
    if not LOT_RE.match(s):
        raise argparse.ArgumentTypeError(f"mã lô phải khớp {LOT_RE.pattern}")
    return s


def _err(msg: str) -> int:
    print(f"[err] {msg}", flush=True)
    return 1


def _golden() -> tuple[dict | None, bytes | None, str | None]:
    try:
        raw = Path(GOLDEN_FILE).read_bytes()
    except OSError as e:
        return None, None, f"không đọc được golden ({type(e).__name__})"
    skus, why = inventory_csv.golden_map(GOLDEN_FILE)
    return skus, raw, why


def _db_call(fn):
    """Chạy fn(conn) trong 1 kết nối; lỗi DB → rollback + [err] exit 1."""
    conn = _open()
    if conn is None:
        return 1
    try:
        return fn(conn)
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        return _err("thiếu bảng — chạy `python scripts/apply_schema.py` "
                    "trước.")
    except psycopg.Error as e:
        conn.rollback()
        return _err(f"lỗi DB, đã rollback: {type(e).__name__}")
    finally:
        conn.close()


def cmd_allocate(args) -> int:
    golden, golden_raw, why = _golden()
    if golden is None:
        return _err(f"golden: {why} — không connect.")
    try:
        cfg = load_config()
        cutoff = next((c for c in cfg["cutoffs"] if c["id"] == args.cutoff),
                      None)
        if cutoff is None:
            return _err(f"không có mốc '{args.cutoff}' trong config "
                        f"({', '.join(c['id'] for c in cfg['cutoffs'])})")
        a = scenario.load_assumptions()
        a_raw = Path(scenario.ASSUMPTIONS_FILE).read_bytes()
        start = args.start or _today_vn()
        demands = {k: demand_for(s, start, cutoff["covers_until"], a)
                   for k, s in golden.items()}
    except (ProductionError, scenario.ScenarioError, OSError) as e:
        return _err(f"{e} — không connect.")
    start_week = scenario.week_start(start)

    def run(conn):
        stock = inventory_csv.current_stock(conn)
        rid = run_id_for(cutoff, start_week, stock, a["status"], a_raw,
                         golden_raw)
        rows = plan_rows(list(golden.values()), stock, demands)
        old = conn.execute("select count(*) from allocation_proposals"
                           " where run_id = %s", (rid,)).fetchone()[0]
        n = 0
        if not old:
            n = save_proposals(conn, rid, cutoff, start_week, rows)
            conn.commit()
        _print_plan(rid, cutoff, start_week, rows, a["status"], cfg, old, n)
        return 0
    return _db_call(run)


def _print_plan(rid, cutoff, start_week, rows, a_status, cfg, old, n):
    print(f"Giả định kịch bản: {a_status} · Cấu hình mốc: {cfg['status']}")
    print(DISCLAIMER)
    if any(r["sample"] for r in rows):
        print("[MẪU] tồn kho từ dữ liệu mẫu (source='sample') — chưa phải "
              "số thật")
    print(f"Mốc {cutoff['id']} ({cutoff['date']}, nhu cầu tới "
          f"{cutoff['covers_until']}): {cutoff['label']}")
    print(f"{NO_NEW_PRODUCTION}. Tuần bắt đầu {start_week} · run {rid}")
    if old:
        print(f"[skip] run đã có ({old} dòng) — không ghi thêm.")
    else:
        print(f"[draft] {n} dòng pending trong allocation_proposals — chờ "
              f"duyệt: approve/reject --run {rid} --by <tên>")
    print("SKU | kênh | thấp | cơ sở | cao | đề xuất | ghi chú")
    for r in rows:
        print(f"{r['sku_key']} | {r['channel']} | {r['demand_low']} | "
              f"{r['demand_base']} | {r['demand_high']} | "
              f"{r['proposed_qty']} | {r['note'] or ''}")
    warn = {}
    for r in rows:
        if r["flag"]:
            warn[r["sku_key"]] = (
                "chưa có" if r["stock_total"] is None else r["stock_total"],
                r["flag"])
    print(f"Cảnh báo thiếu ({len(warn)} SKU):")
    for k in sorted(warn):
        print(f"- {k}: tồn {warn[k][0]} — {warn[k][1]}")
    stale = sorted({(r["sku_key"], k) for r in rows for k in r["stale"]})
    if stale:
        print(f"Cảnh báo {inventory_csv.STALE_NOTE} ({len(stale)} SKU×kho"
              " — file kho mới nhất không có dòng này; hết hàng phải ghi qty"
              " 0):")
        for sku, kho in stale:
            print(f"- {sku} @ {_clean(kho)}")


def cmd_decide(args, decision: str) -> int:
    def run(conn):
        ok, msg = decide_run(conn, args.run, decision, args.by, args.note)
        if not ok:
            conn.rollback()
            return _err(f"{msg} — không ghi.")
        conn.commit()
        print(f"[done] {msg} — người quyết định: {args.by}. Không chuyển "
              "kho (thực hiện tay theo quyết định).")
        return 0
    return _db_call(run)


def cmd_bom(args) -> int:
    golden, _raw, why = _golden()
    if golden is None:
        return _err(f"golden: {why} — không connect.")
    if args.load is not None:
        try:
            doc = read_json(args.load, "combos")
        except ProductionError as e:
            return _err(f"{e} — không connect, không nạp gì.")
        errs = check_bom(doc["combos"], golden)
        if errs:
            for e in errs[:inventory_csv.MAX_PRINT_ERRS]:
                print(f"[err] {e}")
            return _err(f"{len(errs)} lỗi BOM — không connect, không nạp gì.")

        def run_load(conn):
            done, skipped = load_bom(conn, doc["combos"], args.source)
            conn.commit()
            tag = " [MẪU]" if args.source == "sample" else ""
            print(f"[load]{tag} {done} combo ghi (items thay toàn bộ)"
                  + (f", {skipped} combo manual giữ nguyên" if skipped else ""))
            return 0
        return _db_call(run_load)

    def run_check(conn):
        combos = db_combos(conn)
        if not combos:
            print("chưa có combo nào trong bom_combos — nạp bằng bom --load")
            return 0
        errs = check_bom(_strip_meta(combos), golden)
        stock = {k: v["qty"] for k, v in
                 inventory_csv.current_stock(conn).items()}
        sample = any(c["_source"] == "sample" for c in combos)
        print(("[MẪU] " if sample else "") + f"{len(combos)} combo — "
              f"số combo làm được {BUILDABLE_NOTE}:")
        for c in combos:
            # Chuỗi đọc từ DB (không CHECK slug) → _clean chặn mã điều khiển.
            n, miss = buildable(c["items"], stock)
            extra = (f" (chưa có số tồn: {_clean(', '.join(miss), 300)})"
                     if miss else "")
            print(f"- {_clean(c['combo_key'])} "
                  f"[{_clean(', '.join(c['channels']), 120)}]: {n}{extra}")
        for e in errs:
            print(f"[err] {_clean(e, 300)}")
        if errs:
            return _err(f"{len(errs)} lỗi BOM theo golden hiện tại.")
        print("[ok] BOM khớp luật kênh golden hiện tại.")
        return 0
    return _db_call(run_check)


def cmd_lots(args) -> int:
    golden, _raw, why = _golden()
    if golden is None:
        return _err(f"golden: {why} — không connect.")
    try:
        doc = read_json(args.load, "lots")
    except ProductionError as e:
        return _err(f"{e} — không connect, không nạp gì.")
    errs = validate_lots(doc["lots"], golden, _today_vn())
    if errs:
        for e in errs[:inventory_csv.MAX_PRINT_ERRS]:
            print(f"[err] {e}")
        return _err(f"{len(errs)} lỗi hồ sơ lô — không connect, không nạp gì.")

    def run(conn):
        new, old = load_lots(conn, doc["lots"], args.source)
        conn.commit()
        tag = " [MẪU]" if args.source == "sample" else ""
        print(f"[load]{tag} {new} lô mới (pending — chờ người kiểm nhập)")
        if old:
            print(f"[skip] {old} lô đã có — không ghi đè.")
        return 0
    return _db_call(run)


def cmd_intake(args) -> int:
    def run(conn):
        ok, msg = intake(conn, args.lot, args.result, args.by, args.note)
        if not ok:
            conn.rollback()
            return _err(f"{msg} — không ghi.")
        conn.commit()
        print(f"[done] {msg} — người kiểm nhập: {args.by}")
        return 0
    return _db_call(run)


def cmd_bulletin(args) -> int:
    try:
        cfg = load_config()
    except ProductionError as e:
        return _err(f"config: {e} — không connect.")
    golden, _raw, why = _golden()
    day = args.date or _today_vn()

    def run(conn):
        data = collect(conn, golden, why)
        data["date"] = day
        print(render_bulletin(data, dt.datetime.now(TZ_VN), cfg), end="")
        return 0
    return _db_call(run)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.production",
        description="Sản xuất P1: phân bổ tồn (đề xuất), BOM, hồ sơ lô, "
                    "bản tin — không chuyển kho, không lệnh sản xuất.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("allocate", help="đề xuất phân bổ tồn theo mốc chốt")
    p.add_argument("--cutoff", required=True, help="id mốc trong config")
    p.add_argument("--start", type=_date_arg,
                   help="ngày bắt đầu (mặc định hôm nay giờ VN)")
    for name, verb in (("approve", "duyệt"), ("reject", "từ chối")):
        p = sub.add_parser(name, help=f"NGƯỜI {verb} 1 run phân bổ")
        p.add_argument("--run", required=True, type=_run_arg)
        p.add_argument("--by", required=True, type=_by_arg,
                       help="tên người quyết định (GĐ sản xuất)")
        p.add_argument("--note", type=_note_arg)
    p = sub.add_parser("bom", help="nạp/kiểm BOM combo-hộp quà")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--load", type=Path, metavar="FILE")
    g.add_argument("--check", action="store_true")
    p.add_argument("--source", choices=("manual", "sample"), default="manual")
    p = sub.add_parser("lots", help="nạp hồ sơ lô (pending)")
    p.add_argument("--load", type=Path, required=True, metavar="FILE")
    p.add_argument("--source", choices=("manual", "sample"), default="manual")
    p = sub.add_parser("intake", help="NGƯỜI ghi kết quả kiểm nhập 1 lô")
    p.add_argument("--lot", required=True, type=_lot_arg)
    p.add_argument("--result", required=True, choices=("passed", "failed"))
    p.add_argument("--by", required=True, type=_by_arg,
                   help="tên người kiểm nhập")
    p.add_argument("--note", type=_note_arg)
    p = sub.add_parser("bulletin", help="bản tin tuần cho GĐ sản xuất")
    p.add_argument("--date", type=_date_arg)
    args = ap.parse_args(argv)
    if args.cmd == "bom" and args.check and args.source != "manual":
        ap.error("--source chỉ dùng với bom --load")

    if args.cmd == "allocate":
        return cmd_allocate(args)
    if args.cmd in ("approve", "reject"):
        return cmd_decide(args, "approved" if args.cmd == "approve"
                          else "rejected")
    if args.cmd == "bom":
        return cmd_bom(args)
    if args.cmd == "lots":
        return cmd_lots(args)
    if args.cmd == "intake":
        return cmd_intake(args)
    return cmd_bulletin(args)


if __name__ == "__main__":
    raise SystemExit(main())
