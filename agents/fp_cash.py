"""v9.1 FP-Cash (WP12) — dòng tiền 13 tuần × 3 kịch bản thấp/cơ sở/cao, DỰNG
TRÊN engine kịch bản chung `pipelines.scenario.project()` (v7.3) — KHÔNG có
công thức bán hàng thứ 2 ở đây: số đơn vị mỗi tuần lấy nguyên từ engine
(baseline × hệ số mùa, rượu × kênh online = 0 do engine), module này chỉ
nhân đơn giá × tỷ lệ thực nhận, dời theo độ trễ tiền về, trừ chi cố định.
Tất định, KHÔNG LLM/mạng, KHÔNG đề xuất vay/chuyển khoản/dời hạn thanh toán.

Hàm THUẦN `forecast(skus, assumptions, prices, net_ratio, cfg, start,
opening)`:
  - mỗi SKU × kênh có baseline (và có đơn giá) → `scenario.project(sku,
    kênh, start − lag tuần, weeks, assumptions)`: đơn vị bán tuần i − lag →
    tiền về tuần i = đơn vị × đơn giá × tỷ lệ thực nhận (ROUND_HALF_UP).
  - thiếu đơn giá → vào danh sách "thiếu giá — loại khỏi dự báo" (KHÔNG coi
    là 0 im lặng); SKU không có trong golden → "thiếu SKU golden".
  - chi = cố định (`fixed_outflows`) + một lần (`one_off`) theo tuần — giống
    nhau ở 3 kịch bản.
  - mỗi tuần `{week_start, in: {low, base, high}, out, close: {...}}`, luôn
    low ≤ base ≤ high; `opening` None → số dư = dòng tiền ròng lũy kế từ 0 +
    ghi "chưa có số dư đầu kỳ thật"; cảnh báo mọi tuần `close.low <
    min_balance_vnd` ("tuần âm ở kịch bản thấp").
Tỷ lệ thực nhận đo từ DB: Σ payout / Σ giá trị đơn của `settlement_rows` 8
tuần trước tuần bắt đầu theo kênh; không đo được (Σ đơn = 0, DB down, ngoài
0..1) → mặc định cấu hình + "chưa xác minh".

Cấu hình `data/fpa_config.json` mục `cash` (GIẢ ĐỊNH — chờ GĐ tài chính
chốt): weeks, payout_lag_weeks, net_ratio_default, offline_price_ratio,
unit_price_vnd, fixed_outflows, one_off, min_balance_vnd,
opening_balance_vnd (null = chưa có số dư thật).

Chạy:
  python -m agents.fp_cash --forecast [--start YYYY-MM-DD] [--opening N] [--json]
Exit: 0 ok (DB down vẫn chạy với tỷ lệ mặc định + [warn]) · 1 giả định/
golden/cấu hình lỗi · 2 tham số sai.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import psycopg

from agents.fp_pnl import frac, is_int, read_config, vnd
from ingest import golden_store
from ingest.lead_store import connect
from ingest.settlement_csv import _to_signed, round_half_up
from pipelines import scenario
from pipelines.period import VN_TZ, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

LEVELS = scenario.LEVELS
MONEY_CAP = 10**13
MEASURE_WEEKS = 8
MAX_LAG = 8
_NAME_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,39}")
NO_OPENING = "chưa có số dư đầu kỳ thật — số dư = dòng tiền ròng lũy kế từ 0"
UNVERIFIED = "chưa xác minh"


# ---------- cấu hình ----------

def _money(v) -> bool:
    return is_int(v, -MONEY_CAP, MONEY_CAP)


def load_cfg(path: Path | None = None) -> tuple[dict | None, str | None]:
    c, why = read_config("cash", path)
    if c is None:
        return None, why
    chans = scenario.ALL_CHANNELS
    if not is_int(c.get("weeks"), 1, scenario.MAX_WEEKS):
        return None, f"cash.weeks: int 1..{scenario.MAX_WEEKS}"
    lag = c.get("payout_lag_weeks")
    if not isinstance(lag, dict) or not all(
            k in chans and is_int(v, 0, MAX_LAG) for k, v in lag.items()):
        return None, f"cash.payout_lag_weeks: {{kênh: int 0..{MAX_LAG}}}"
    nr = c.get("net_ratio_default")
    if not isinstance(nr, dict) or not all(k in chans for k in nr):
        return None, "cash.net_ratio_default: {kênh: 0..1}"
    ratios = {}
    for k, v in nr.items():
        ratios[k], why = frac(v, f"cash.net_ratio_default.{k}")
        if why:
            return None, why
    opr, why = frac(c.get("offline_price_ratio"), "cash.offline_price_ratio")
    if why:
        return None, why
    up = c.get("unit_price_vnd", {})
    if not isinstance(up, dict) or not all(
            isinstance(m, dict) and all(ch in chans and is_int(p, 1, MONEY_CAP)
                                        for ch, p in m.items())
            for m in up.values()):
        return None, "cash.unit_price_vnd: {sku: {kênh: int > 0}}"
    weeks = c["weeks"]
    fixed = c.get("fixed_outflows", [])
    if not isinstance(fixed, list) or not all(
            isinstance(f, dict) and isinstance(f.get("name"), str)
            and _NAME_RE.fullmatch(f["name"])
            and is_int(f.get("amount_vnd"), 1, MONEY_CAP)
            and is_int(f.get("every_weeks"), 1, 52)
            and is_int(f.get("first_week"), 0, weeks - 1) for f in fixed):
        return None, ("cash.fixed_outflows: [{name, amount_vnd > 0, "
                      "every_weeks 1..52, first_week 0..weeks-1}]")
    one = c.get("one_off", [])
    if not isinstance(one, list):
        return None, "cash.one_off: phải là list"
    one_off = []
    for i, o in enumerate(one):
        try:
            d = date.fromisoformat(o["week_start"])
        except (TypeError, KeyError, ValueError):
            return None, f"cash.one_off[{i}].week_start: phải YYYY-MM-DD"
        if not (isinstance(o.get("name"), str) and _NAME_RE.fullmatch(
                o["name"]) and is_int(o.get("amount_vnd"), 1, MONEY_CAP)):
            return None, f"cash.one_off[{i}]: cần name + amount_vnd > 0"
        one_off.append({"name": o["name"], "amount_vnd": o["amount_vnd"],
                        "week_start": scenario.week_start(d)})
    mb = c.get("min_balance_vnd", 0)
    ob = c.get("opening_balance_vnd")
    if not _money(mb) or not (ob is None or _money(ob)):
        return None, "cash.min_balance_vnd/opening_balance_vnd: số nguyên VND"
    return {"weeks": weeks, "payout_lag_weeks": dict(lag),
            "net_ratio_default": ratios, "offline_price_ratio": opr,
            "unit_price_vnd": up, "fixed_outflows": fixed,
            "one_off": one_off, "min_balance_vnd": mb,
            "opening_balance_vnd": ob}, None


# ---------- hàm thuần ----------

def unit_prices(golden_skus: list[dict], cfg: dict) -> dict:
    """{(sku, kênh): VND} — giá `list` golden cho kênh online; offline =
    list shopee × offline_price_ratio (GIẢ ĐỊNH); `unit_price_vnd` ghi đè."""
    out = {}
    for s in golden_skus:
        k = s.get("sku_key")
        for ch, p in (s.get("prices") or {}).items():
            if isinstance(p, dict) and is_int(p.get("list"), 1, MONEY_CAP):
                out[(k, ch)] = p["list"]
        shp = out.get((k, "shopee"))
        if shp is not None:
            out[(k, scenario.OFFLINE)] = round_half_up(
                Decimal(shp) * cfg["offline_price_ratio"])
    for k, m in cfg["unit_price_vnd"].items():
        for ch, p in m.items():
            out[(k, ch)] = p
    return out


def net_ratios(measured: dict, cfg: dict) -> dict:
    """measured = {kênh: (Σ payout, Σ giá trị đơn, số dòng)} → {kênh:
    {"ratio": Decimal, "note": nguồn}}."""
    out = {}
    for ch, d in cfg["net_ratio_default"].items():
        out[ch] = {"ratio": d, "note": f"mặc định cấu hình — {UNVERIFIED}"}
    for ch, (pay, order, n) in measured.items():
        if not order:
            continue
        r = Decimal(pay) / Decimal(order)
        if Decimal(0) <= r <= Decimal(1):
            out[ch] = {"ratio": r, "note": (f"đo từ settlement {n} dòng "
                                            f"({MEASURE_WEEKS} tuần trước)")}
    return out


def _outflow(i: int, wk: date, cfg: dict) -> int:
    total = sum(f["amount_vnd"] for f in cfg["fixed_outflows"]
                if i >= f["first_week"]
                and (i - f["first_week"]) % f["every_weeks"] == 0)
    return total + sum(o["amount_vnd"] for o in cfg["one_off"]
                       if o["week_start"] == wk)


def forecast(skus: dict, assumptions: dict, prices: dict, net_ratio: dict,
             cfg: dict, start: date, opening: int | None) -> dict:
    """skus = {sku_key: dòng golden}. Raise ValueError/ScenarioError khi
    thiếu độ trễ / tỷ lệ cho kênh có baseline."""
    a = assumptions
    base = a["baseline"] if "baseline" in a else \
        scenario.validate_assumptions(a)["baseline"]
    weeks = cfg["weeks"]
    w0 = scenario.week_start(start)
    ins = [dict.fromkeys(LEVELS, 0) for _ in range(weeks)]
    thieu_gia, thieu_sku, pairs = [], [], 0
    for sku_key in sorted(base):
        for ch in sorted(base[sku_key]):
            if sku_key not in skus:
                thieu_sku.append((sku_key, ch))
                continue
            price = prices.get((sku_key, ch))
            if price is None:
                thieu_gia.append((sku_key, ch))
                continue
            if ch not in cfg["payout_lag_weeks"] or ch not in net_ratio:
                raise ValueError(f"thiếu độ trễ tiền về / tỷ lệ thực nhận "
                                 f"cho kênh {ch}")
            lag = cfg["payout_lag_weeks"][ch]
            ratio = net_ratio[ch]["ratio"]
            units = scenario.project(skus[sku_key], ch,
                                     w0 - timedelta(weeks=lag), weeks, a)
            pairs += 1
            for i, u in enumerate(units):
                for lv in LEVELS:
                    ins[i][lv] += round_half_up(Decimal(u[lv]) * price * ratio)
    bal = dict.fromkeys(LEVELS, opening or 0)
    rows, warn = [], []
    for i in range(weeks):
        wk = w0 + timedelta(weeks=i)
        out = _outflow(i, wk, cfg)
        for lv in LEVELS:
            bal[lv] += ins[i][lv] - out
        rows.append({"week_start": wk, "in": ins[i], "out": out,
                     "close": dict(bal)})
        if bal["low"] < cfg["min_balance_vnd"]:
            warn.append(wk)
    notes = [f"{ch}: tỷ lệ thực nhận {net_ratio[ch]['ratio']:.4f} — "
             f"{net_ratio[ch]['note']}" for ch in sorted(net_ratio)]
    notes += [f"độ trễ tiền về {ch}: {v} tuần — GIẢ ĐỊNH, {UNVERIFIED}"
              for ch, v in sorted(cfg["payout_lag_weeks"].items())]
    notes += [(f"kịch bản bán (đơn vị/tuần): {a.get('status')} — "
               "`data/scenario_assumptions.json`"),
              ("đơn giá: giá `list` golden cho kênh online; offline = list "
               f"shopee × {cfg['offline_price_ratio']} (GIẢ ĐỊNH)"),
              ("chi cố định + một lần, tỷ lệ/độ trễ mặc định: "
               "`data/fpa_config.json` mục cash — GIẢ ĐỊNH, chờ GĐ tài chính "
               "chốt")]
    if opening is None:
        notes.append(NO_OPENING)
    return {"start": w0, "weeks": rows, "warn_weeks": warn,
            "min_balance_vnd": cfg["min_balance_vnd"], "pairs": pairs,
            "thieu_gia": thieu_gia, "thieu_sku": thieu_sku,
            "opening": opening, "notes": notes}


def render(fc: dict) -> str:
    L = [(f"# Dòng tiền {len(fc['weeks'])} tuần từ {fc['start']:%d/%m/%Y} — "
          "khoảng thấp/cơ sở/cao"), "",
         ("**Khoảng ước lượng trên giả định — KHÔNG phải cam kết; agent không"
          " đề xuất vay, chuyển khoản hay dời hạn thanh toán.**"), "",
         ("| Tuần | Thu thấp | Thu cơ sở | Thu cao | Chi | Số dư thấp | Số dư "
          "cơ sở | Số dư cao |"), "|---|---|---|---|---|---|---|---|"]
    for w in fc["weeks"]:
        i, c = w["in"], w["close"]
        flag = " ⚠" if w["week_start"] in fc["warn_weeks"] else ""
        L.append(f"| {w['week_start']:%d/%m}{flag} | {vnd(i['low'])} | "
                 f"{vnd(i['base'])} | {vnd(i['high'])} | {vnd(w['out'])} | "
                 f"{vnd(c['low'])} | {vnd(c['base'])} | {vnd(c['high'])} |")
    ww = fc["warn_weeks"]
    L += ["", (f"Cảnh báo — tuần âm ở kịch bản thấp (số dư < "
               f"{vnd(fc['min_balance_vnd'])}): "
               + (", ".join(f"{w:%d/%m}" for w in ww) if ww
                  else "(không có)"))]
    if fc["thieu_gia"]:
        L.append("Thiếu giá — loại khỏi dự báo: " + ", ".join(
            f"`{k}` × {ch}" for k, ch in fc["thieu_gia"]))
    if fc["thieu_sku"]:
        L.append("Thiếu SKU golden — loại khỏi dự báo: " + ", ".join(
            f"`{k}` × {ch}" for k, ch in fc["thieu_sku"]))
    L += ["", "Giả định:"] + [f"- {n}" for n in fc["notes"]] + [""]
    return "\n".join(L)


def to_json(fc: dict) -> str:
    def conv(o):
        if isinstance(o, date):
            return o.isoformat()
        if isinstance(o, Decimal):
            return str(o)
        raise TypeError(type(o).__name__)
    return json.dumps(fc, default=conv, ensure_ascii=False)


# ---------- DB ----------

def measure(conn, start: date) -> dict:
    w0 = scenario.week_start(start)
    since = w0 - timedelta(weeks=MEASURE_WEEKS)
    return {ch: (int(p), int(o), n) for ch, p, o, n in conn.execute(
        "select channel, coalesce(sum(payout_vnd), 0),"
        " coalesce(sum(order_amount_vnd), 0), count(*) from settlement_rows"
        " where settled_on >= %s and settled_on < %s group by channel",
        (since, w0))}


def load_inputs(cfg_path: Path | None = None):
    """→ (cfg, assumptions, golden skus list) | raise ValueError(lý do)."""
    cfg, why = load_cfg(cfg_path)
    if cfg is None:
        raise ValueError(why)
    try:
        a = scenario.load_assumptions()
    except scenario.ScenarioError as e:
        raise ValueError(f"giả định kịch bản: {e}") from e
    doc, why = golden_store.read_golden(golden_store.GOLDEN_FILE)
    if doc is None:
        raise ValueError(f"golden: {why}")
    errs = golden_store.validate(doc)
    if errs:
        raise ValueError(f"golden không hợp lệ ({len(errs)} lỗi)")
    return cfg, a, [s for s in doc["skus"] if isinstance(s, dict)]


def run(measured: dict, start: date, opening: int | None, cfg, a,
        golden) -> dict:
    """`measured` = kết quả `measure()` ({} khi DB down) → forecast."""
    return forecast({s["sku_key"]: s for s in golden}, a,
                    unit_prices(golden, cfg), net_ratios(measured, cfg), cfg,
                    start, opening)


# ---------- CLI ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.fp_cash",
        description="FP-Cash: dòng tiền 13 tuần × thấp/cơ sở/cao trên "
                    "pipelines.scenario.project()")
    ap.add_argument("--forecast", action="store_true")
    ap.add_argument("--start", help="ngày bắt đầu YYYY-MM-DD (mặc định hôm "
                                    "nay VN; làm tròn về thứ Hai)")
    ap.add_argument("--opening", help="số dư tiền đầu kỳ VND (thật — nếu có)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if not args.forecast:
        ap.error("cần --forecast")
    start = None
    if args.start is not None:
        try:
            start = date.fromisoformat(args.start)
        except ValueError:
            ap.error("--start phải dạng YYYY-MM-DD")
        if not scenario.DATE_MIN <= start <= scenario.DATE_MAX:
            ap.error(f"--start phải trong {scenario.DATE_MIN}.."
                     f"{scenario.DATE_MAX}")
    opening = None
    if args.opening is not None:
        opening = _to_signed(args.opening, MONEY_CAP)
        if opening is None:
            ap.error("--opening phải là số nguyên VND")
    start = start or vn_date(datetime.now(VN_TZ))
    try:
        cfg, a, golden = load_inputs()
    except ValueError as e:
        print(f"[err] {e} — không connect.", flush=True)
        return 1
    if opening is None:
        opening = cfg["opening_balance_vnd"]

    measured = {}
    conn = connect()
    if conn is None:
        print(f"[warn] không kết nối được Postgres — tỷ lệ thực nhận dùng mặc"
              f" định cấu hình ({UNVERIFIED})", file=sys.stderr)
    else:
        try:
            measured = measure(conn, start)
        except psycopg.Error as e:
            print(f"[warn] không đo được tỷ lệ thực nhận từ settlement "
                  f"({_db_msg(e)}) — dùng mặc định ({UNVERIFIED})",
                  file=sys.stderr)
        finally:
            with suppress(Exception):
                conn.close()
    try:
        fc = run(measured, start, opening, cfg, a, golden)
    except (ValueError, scenario.ScenarioError) as e:
        print(f"[err] {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(to_json(fc) if args.json else render(fc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
