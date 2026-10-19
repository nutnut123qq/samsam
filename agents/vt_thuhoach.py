"""v11.0 VT (WP17) — dự báo thu hoạch theo khoảnh + sẵn hàng theo lô, LUÔN là
khoảng thấp–cơ sở–cao kèm giả định và phần dữ liệu thiếu.

Contract:
  - Giả định năng suất `data/harvest_assumptions.json` (GIẢ ĐỊNH — GĐ vùng
    trồng chốt): `load_assumptions(path)` fail-closed (`HarvestError`).
  - `forecast_harvest(plots, logs, assumptions, *, now)` THUẦN: chỉ khoảnh
    `active`; quý thu hoạch = quý đầu tiên trong `quarters` quý tới có
    năm(quý) − planted_year >= min_age_years; khoảnh đã có nhật ký "thu
    hoạch" (activity chuẩn `agents.garden.ACTIVITY_VOCAB`) → không dự báo
    lại; `tree_count`/`planted_year` thiếu → "thiếu dữ liệu" (KHÔNG coi = 0);
    dòng mẫu (`source` 'sample:%') → nhãn (MẪU). kg = cây × gram/cây × tỷ lệ
    sống / 1000, làm tròn bất đối xứng như `pipelines.scenario`.
  - `availability(lots, skus, scen_assumptions, *, now, weeks)` THUẦN: chỉ
    lô `passed` còn hạn tính sẵn; nhu cầu = Σ `scenario.project()` qua
    `scenario.ALL_CHANNELS` (KHÔNG công thức thứ 2); tuần hết hàng dạng
    khoảng (nhu cầu cao → sớm nhất, thấp → muộn nhất); FEFO theo nhu cầu
    thấp → "rủi ro cận hạn"; thiếu baseline → "thiếu giả định". SKU nhóm
    hạn chế quảng bá (rượu) KHÔNG đưa vào bản này (payload phải qua
    guardrail.check của hàng duyệt) — chỉ đếm số SKU bị bỏ.
  - `render` mở đầu khối metadata (model, seed, sha256 2 file giả định,
    as_of, generated = ngày THẬT lập, không theo --date; dữ liệu dùng) —
    cùng input + `now` + `generated` → byte-identical.
  - Không LLM, không mạng, không lấy mẫu ngẫu nhiên. Đầu ra = file
    `data/reports/vt-thu-hoach-<ngày VN>.md` + (`--submit`) mục `pending`
    khối farming `harvest_forecast`. KHÔNG phải cam kết với khách/đại lý.

Chạy: python -m agents.vt_thuhoach [--date YYYY-MM-DD] [--weeks 1..104]
      [--submit]
Exit: 0 ok · 1 lỗi giả định/guardrail · 2 usage / DB down.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
from contextlib import suppress
from pathlib import Path

import psycopg

from agents.garden import ACTIVITY_VOCAB
from agents.report import REPORTS_DIR, write_report
from ingest import golden_store
from ingest.lead_store import connect
from pipelines import director, guardrail, scenario
from pipelines.job_runs import job_run
from pipelines.production import TZ_VN

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
HARVEST_FILE = ROOT / "data" / "harvest_assumptions.json"
SCEN_FILE = scenario.ASSUMPTIONS_FILE
AGENT = "agent:VT"
BLOCK = "farming"
OBJECT_TYPE = "harvest_forecast"
MODEL = "vt_thuhoach-rule-v1 + pipelines.scenario.project"
HARVEST = "thu hoạch"
assert HARVEST in ACTIVITY_VOCAB
LEVELS = scenario.LEVELS
SEP = "–"
DEFAULT_WEEKS = 13
_KEYS = {"version", "min_age_years", "yield_g_per_tree", "survival_rate",
         "quarters"}
FOOTER = ("Khoảng thấp–cơ sở–cao — KHÔNG phải cam kết với khách/đại lý; "
          "GĐ vùng trồng xác nhận trước khi chia sẻ.")


class HarvestError(ValueError):
    """Giả định thu hoạch thiếu/hỏng — fail-closed."""


def _int_in(v, lo, hi) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _levels(row, where: str, lo_open: float, hi: float | None) -> dict:
    if not isinstance(row, dict) or set(row) != set(LEVELS):
        raise HarvestError(f"{where}: phải là object low/base/high")
    out = {}
    for lv in LEVELS:
        v = row[lv]
        if isinstance(v, bool) or not isinstance(v, (int, float)) \
                or not math.isfinite(v) or v <= lo_open \
                or (hi is not None and v > hi):
            raise HarvestError(f"{where}.{lv}: số ngoài khoảng hợp lệ")
        out[lv] = float(v)
    if not out["low"] <= out["base"] <= out["high"]:
        raise HarvestError(f"{where}: phải low <= base <= high")
    return out


def _sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_assumptions(path=None) -> dict:
    p = Path(path) if path else HARVEST_FILE
    try:
        raw = p.read_bytes()
        doc = json.loads(raw.decode("utf-8-sig"),
                         parse_constant=scenario._reject_constant)
    except FileNotFoundError as e:
        raise HarvestError(f"thiếu file {p.name}") from e
    except (OSError, ValueError) as e:
        raise HarvestError(f"{p.name} hỏng ({type(e).__name__})") from e
    if not isinstance(doc, dict) or set(doc) - {"_doc"} != _KEYS:
        raise HarvestError(f"{p.name}: khóa phải đúng {sorted(_KEYS)}")
    if not isinstance(doc["version"], str) or not doc["version"].strip():
        raise HarvestError("version rỗng")
    if not _int_in(doc["min_age_years"], 1, 30):
        raise HarvestError("min_age_years phải int 1..30")
    if not _int_in(doc["quarters"], 1, 8):
        raise HarvestError("quarters phải int 1..8")
    return {"version": doc["version"], "min_age_years": doc["min_age_years"],
            "quarters": doc["quarters"],
            "yield": _levels(doc["yield_g_per_tree"], "yield_g_per_tree",
                             0, None),
            "survival": _levels(doc["survival_rate"], "survival_rate", 0, 1),
            "sha256": hashlib.sha256(raw).hexdigest()}


# ---------- thuần ----------

def _round(x: float, lv: str) -> int:
    x = round(x, 6)
    return (math.floor(x) if lv == "low" else
            math.ceil(x) if lv == "high" else math.floor(x + 0.5))


def _vn_date(ts) -> dt.date:
    if isinstance(ts, dt.datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        return ts.astimezone(TZ_VN).date()
    return ts


def _sample(src) -> bool:
    return isinstance(src, str) and src.startswith("sample:")


def _quarters(today: dt.date, n: int) -> list[tuple[int, int]]:
    y, q = today.year, (today.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        out.append((y, q))
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    return out


def forecast_harvest(plots, logs, assumptions: dict, *,
                     now: dt.datetime) -> list[dict]:
    """→ [{plot_id, quarter, low, base, high, notes, sample}] — số None khi
    không dự báo (đã thu hoạch / thiếu dữ liệu / chưa đủ tuổi)."""
    today = _vn_date(now)
    qs = _quarters(today, assumptions["quarters"])
    done, sample_log = {}, set()
    for lg in logs:
        if lg.get("activity") != HARVEST:
            continue
        d = _vn_date(lg["ts"])
        if d > today:
            continue
        pid = lg["plot_id"]
        done[pid] = max(done.get(pid, d), d)
        if _sample(lg.get("source")):
            sample_log.add(pid)
    out = []
    for p in sorted(plots, key=lambda r: str(r["id"])):
        if p.get("status") != "active":
            continue
        pid = p["id"]
        row = {"plot_id": pid, "quarter": None, "notes": [],
               "sample": _sample(p.get("source")) or pid in sample_log,
               **dict.fromkeys(LEVELS)}
        out.append(row)
        if pid in done:
            row["notes"].append(f"đã thu hoạch {done[pid].isoformat()}")
            continue
        trees, year = p.get("tree_count"), p.get("planted_year")
        miss = [k for k, v in (("tree_count", trees), ("planted_year", year))
                if not _int_in(v, 0 if k == "tree_count" else 1900, 10**7)]
        if miss:
            row["notes"].append(f"thiếu dữ liệu ({', '.join(miss)})")
            continue
        hit = next(((y, q) for y, q in qs
                    if y - year >= assumptions["min_age_years"]), None)
        if hit is None:
            row["notes"].append(f"chưa đủ {assumptions['min_age_years']} năm"
                                f" tuổi trong {len(qs)} quý tới")
            continue
        row["quarter"] = f"{hit[0]}-Q{hit[1]}"
        for lv in LEVELS:
            row[lv] = _round(trees * assumptions["yield"][lv]
                             * assumptions["survival"][lv] / 1000, lv)
    return out


def _first_week(cum: list[int], stock: int) -> int | None:
    return next((i + 1 for i, c in enumerate(cum) if c > 0 and c >= stock),
                None)


def availability(lots, skus, scen_assumptions, *, now: dt.datetime,
                 weeks: int = DEFAULT_WEEKS) -> list[dict]:
    """→ [{sku_key, stock, usable, pending, expired, demand, stockout,
    near_expiry, notes, sample, restricted}]. Nhu cầu = Σ scenario.project
    qua mọi kênh; None khi thiếu giả định."""
    today = _vn_date(now)
    start = scenario.week_start(today)
    idx = {s["sku_key"]: s for s in skus
           if isinstance(s, dict) and s.get("sku_key")}
    by_sku: dict[str, list] = {}
    for lot in lots:
        by_sku.setdefault(lot["sku_key"], []).append(lot)
    out = []
    for key in sorted(by_sku):
        sku = idx.get(key)
        row = {"sku_key": key, "stock": 0, "usable": [], "pending": [],
               "expired": [], "demand": None, "stockout": None,
               "near_expiry": [], "notes": [], "sample": False,
               "restricted": False}
        out.append(row)
        if sku is not None and sku.get("category") == "alcohol":
            row["restricted"] = True
            continue
        group = sorted(by_sku[key], key=lambda r: (r["exp_date"],
                                                   r["lot_code"]))
        for lot in group:
            if lot["intake_status"] == "pending":
                row["pending"].append(lot["lot_code"])
            elif lot["intake_status"] != "passed":
                continue
            elif lot["exp_date"] <= today:
                row["expired"].append(lot["lot_code"])
            else:
                row["usable"].append(lot)
                row["stock"] += lot["qty"]
                row["sample"] |= lot.get("source") == "sample"
        if sku is None:
            row["notes"].append("SKU không có trong golden — không tính nhu "
                                "cầu")
            continue
        weekly = dict.fromkeys(LEVELS)
        try:
            for lv in LEVELS:
                weekly[lv] = [0] * weeks
            for ch in scenario.ALL_CHANNELS:
                for i, r in enumerate(scenario.project(sku, ch, start, weeks,
                                                       scen_assumptions)):
                    for lv in LEVELS:
                        weekly[lv][i] += r[lv]
        except scenario.ScenarioError:
            row["notes"].append("thiếu giả định số bán — không tính nhu cầu")
            continue
        cum = {lv: [sum(weekly[lv][:i + 1]) for i in range(weeks)]
               for lv in LEVELS}
        row["demand"] = {lv: cum[lv][-1] for lv in LEVELS}
        row["stockout"] = {"earliest": _first_week(cum["high"], row["stock"]),
                           "latest": _first_week(cum["low"], row["stock"])}
        acc = 0
        for lot in row["usable"]:       # FEFO: hạn sớm dùng trước
            acc += lot["qty"]
            wk = _first_week(cum["low"], acc)
            used_by = start + dt.timedelta(weeks=wk if wk else weeks, days=-1)
            if lot["exp_date"] <= used_by:
                row["near_expiry"].append(lot)
    return out


def _cell(d: dict) -> str:
    return SEP.join(str(d[lv]) for lv in LEVELS)


def _id(v) -> str:
    """Mã khoảnh/lô/SKU từ DB (nhập tay) → 1 dòng, cắt ngắn: chặn chèn dòng
    giả (vd "seed:") vào payload hàng duyệt."""
    return " ".join(str(v).split())[:64]


def _codes(lots) -> str:
    return ", ".join(_id(x if isinstance(x, str) else x["lot_code"])
                     for x in lots)


def render(harvest: list[dict], avail: list[dict], meta: dict) -> str:
    """THUẦN, tất định. meta: as_of, generated, harvest_sha256,
    scenario_sha256, n_plots, n_logs, n_lots, weeks, start, status."""
    L = [f"# Dự báo thu hoạch & sẵn hàng theo lô — {meta['as_of']}", "",
         "## Metadata", "",
         f"- model: {MODEL}",
         "- seed: 0 (tất định — không lấy mẫu ngẫu nhiên)",
         f"- harvest_assumptions_sha256: {meta['harvest_sha256']}",
         f"- scenario_assumptions_sha256: {meta['scenario_sha256']}",
         f"- as_of: {meta['as_of']}",
         f"- generated: {meta['generated']}",
         (f"- dữ liệu dùng: {meta['n_plots']} khoảnh · {meta['n_logs']} nhật "
         f"ký thu hoạch · {meta['n_lots']} lô"),
         f"- giả định: {meta['status']}", "",
         "## Dự báo thu hoạch theo khoảnh (kg củ tươi, thấp–cơ sở–cao)", ""]
    for r in harvest:
        tag = " (MẪU)" if r["sample"] else ""
        if r["low"] is None:
            L.append(f"- {_id(r['plot_id'])}{tag}: {'; '.join(r['notes'])} — "
                     "không ước lượng")
        else:
            L.append(f"- {_id(r['plot_id'])}{tag}: {r['quarter']} — "
                     f"{_cell(r)} kg")
    if not harvest:
        L.append("- (không có khoảnh active)")
    L += ["", (f"## Sẵn hàng theo lô ({meta['weeks']} tuần từ "
              f"{meta['start']})"), ""]
    shown = [r for r in avail if not r["restricted"]]
    for r in shown:
        tag = " (MẪU)" if r["sample"] else ""
        L.append(f"- {_id(r['sku_key'])}{tag}: tồn sẵn đã kiểm nhập {r['stock']}"
                 + (f" (lô {_codes(r['usable'])})" if r["usable"] else ""))
        L += [f"  - {n}" for n in r["notes"]]
        if r["demand"] is not None:
            L.append(f"  - nhu cầu {meta['weeks']} tuần: {_cell(r['demand'])}"
                     " đơn vị")
            so = r["stockout"]
            if so["earliest"] is None:
                L.append(f"  - hết hàng: đủ qua {meta['weeks']} tuần (cả nhu "
                         "cầu cao)")
            else:
                late = (f"tuần {so['latest']} (nhu cầu thấp)" if so["latest"]
                        else f"sau {meta['weeks']} tuần (nhu cầu thấp)")
                L.append(f"  - hết hàng: tuần {so['earliest']} (nhu cầu cao)"
                         f" → {late}")
        for lot in r["near_expiry"]:
            L.append(f"  - rủi ro cận hạn: lô {_id(lot['lot_code'])} (hạn "
                     f"{lot['exp_date'].isoformat()}) — FEFO theo nhu cầu "
                     "thấp chưa dùng hết trước hạn")
        if r["pending"]:
            L.append(f"  - chưa kiểm nhập — không tính sẵn: lô "
                     f"{_codes(r['pending'])}")
        if r["expired"]:
            L.append(f"  - hết hạn — không tính: lô {_codes(r['expired'])}")
    if not shown:
        L.append("- (không có lô)")
    n_rest = sum(r["restricted"] for r in avail)
    if n_rest:
        L.append(f"- {n_rest} SKU nhóm hạn chế quảng bá không đưa vào bản "
                 "này (xem dự báo kênh offline của KD-A10)")
    L += ["", "---", FOOTER, ""]
    return "\n".join(L)


# ---------- DB ----------

def load_db(conn) -> tuple[list, list, list]:
    plots = [dict(zip(("id", "tree_count", "planted_year", "status",
                       "source"), r)) for r in conn.execute(
        "select id, tree_count, planted_year, status, source from plots"
        " order by id").fetchall()]
    logs = [dict(zip(("plot_id", "ts", "activity", "source"), r))
            for r in conn.execute(
        "select plot_id, ts, activity, source from plot_logs"
        " where activity = %s order by id", (HARVEST,)).fetchall()]
    lots = [dict(zip(("lot_code", "sku_key", "mfg_date", "exp_date", "qty",
                      "intake_status", "source"), r)) for r in conn.execute(
        "select lot_code, sku_key, mfg_date, exp_date, qty, intake_status,"
        " source from production_lots order by lot_code").fetchall()]
    return plots, logs, lots


def submit(conn, as_of: str, text: str) -> tuple[str, int]:
    oid = (f"vt-harvest:{as_of}:"
           f"{hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]}")
    row = conn.execute(
        "select id from approval_queue where block = %s and object_type = %s"
        " and object_id = %s and status = 'pending' order by id limit 1",
        (BLOCK, OBJECT_TYPE, oid)).fetchone()
    if row:
        conn.commit()
        return "skipped", row[0]
    qid = director.submit(conn, BLOCK, OBJECT_TYPE, oid,
                          f"Dự báo thu hoạch & sẵn hàng {as_of}", text,
                          created_by=AGENT)
    conn.commit()
    return "pending", qid


# ---------- CLI ----------

def _date(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from e
    if not scenario.DATE_MIN <= d <= scenario.DATE_MAX:
        raise argparse.ArgumentTypeError("ngày ngoài khoảng hợp lệ")
    return d


def _weeks(s: str) -> int:
    try:
        n = int(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("phải là số nguyên") from e
    if not 1 <= n <= scenario.MAX_WEEKS:
        raise argparse.ArgumentTypeError(f"phải trong 1..{scenario.MAX_WEEKS}")
    return n


def main(argv=None, now: dt.datetime | None = None,
         generated: dt.date | None = None) -> int:
    """`now` = mốc as_of (--date ghi đè); `generated` = ngày THẬT lập bản
    (đồng hồ, test truyền cố định) — tách khỏi as_of để backdate không làm
    sai trường audit."""
    ap = argparse.ArgumentParser(
        prog="python -m agents.vt_thuhoach",
        description="VT dự báo thu hoạch theo khoảnh + sẵn hàng theo lô "
                    "(khoảng thấp–cơ sở–cao, KHÔNG phải cam kết)")
    ap.add_argument("--date", type=_date, help="ngày as_of (giờ VN)")
    ap.add_argument("--weeks", type=_weeks, default=DEFAULT_WEEKS)
    ap.add_argument("--submit", action="store_true",
                    help="đẩy bản dự báo vào hàng duyệt khối farming")
    a = ap.parse_args(argv)
    if a.date:
        now = dt.datetime.combine(a.date, dt.time(12), TZ_VN)
    now = now or dt.datetime.now(TZ_VN)
    generated = generated or dt.datetime.now(TZ_VN).date()
    try:
        ha = load_assumptions()
        sa = scenario.load_assumptions(SCEN_FILE)
        scen_sha = _sha(SCEN_FILE)
    except (HarvestError, scenario.ScenarioError, OSError) as e:
        print(f"[err] giả định: {e}", file=sys.stderr)
        return 1
    doc, why = golden_store.read_golden(golden_store.GOLDEN_FILE)
    if doc is None or golden_store.validate(doc):
        print(f"[err] golden không dùng được ({why or 'không hợp lệ'})",
              file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc "
              "host chết)", file=sys.stderr)
        return 2
    try:
        plots, logs, lots = load_db(conn)
        conn.commit()
        as_of = _vn_date(now).isoformat()
        harvest = forecast_harvest(plots, logs, ha, now=now)
        avail = availability(lots, doc["skus"], sa, now=now, weeks=a.weeks)
        text = render(harvest, avail, {
            "as_of": as_of, "generated": generated.isoformat(),
            "harvest_sha256": ha["sha256"], "scenario_sha256": scen_sha,
            "n_plots": len(plots), "n_logs": len(logs), "n_lots": len(lots),
            "weeks": a.weeks,
            "start": scenario.week_start(_vn_date(now)).isoformat(),
            "status": " ".join(str(sa["status"]).split())[:300]})
        g = guardrail.check(text)
        if g.get("ok") is not True:
            print(f"[err] bản dự báo không qua guardrail "
                  f"({len(g.get('violations') or [])} vi phạm)",
                  file=sys.stderr)
            return 1
        # P8.4: khoảnh/nhật ký/lô MẪU (nhãn (MẪU)) → không đếm.
        path = write_report(text, REPORTS_DIR, f"vt-thu-hoach-{as_of}.md",
                            sample=any(r["sample"] for r in (*harvest,
                                                            *avail)))
        print(text)
        print(f"[write] {path}")
        if a.submit:
            st, qid = submit(conn, as_of, text)
            print(f"[submit] {st} #{qid} ({BLOCK}/{OBJECT_TYPE})")
    except psycopg.Error as e:
        print(f"[warn] lỗi DB ({type(e).__name__})", file=sys.stderr)
        return 2
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[err] không ghi được báo cáo ({type(e).__name__})",
              file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    return 0


if __name__ == "__main__":
    with job_run("agents.vt_thuhoach") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
