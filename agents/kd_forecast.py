"""v5.4 KD-A10 (WP07) — dự báo mùa theo SKU × kênh, LUÔN là khoảng thấp–cơ
sở–cao, đối chiếu tồn kho → cảnh báo THIẾU / RỦI RO / THỪA.

KHÔNG engine thứ 2: mỗi SKU × `scenario.ALL_CHANNELS` gọi
`scenario.project()` (engine kịch bản dùng chung v7.3) rồi cộng theo mức;
cảnh báo thiếu = `production.shortage()` (SX-A3 v9.2), thêm THỪA khi tồn >
tổng kịch bản cao. Tồn = `ingest.inventory_csv.current_stock()` (theo SKU,
không theo kênh). SKU không có dòng tồn → "chưa có số tồn" (KHÔNG = 0, không
cảnh báo thiếu); kho cũ → `STALE_NOTE`; tồn nạp từ file mẫu → nhãn (MẪU).

Giả định số bán trong `data/scenario_assumptions.json` vẫn là GIẢ ĐỊNH (số bán
thật = external-dep). Hàm `forecast`/`render` THUẦN; không LLM, không mạng,
không ghi DB.

Chạy: python -m agents.kd_forecast [--start YYYY-MM-DD] [--weeks 1..104]
      [--sku X] [--write]
Exit: 0 ok · 1 lỗi dữ liệu / không đối chiếu được tồn (vẫn in dự báo) ·
2 usage.
"""

import argparse
import datetime as dt
import sys
from contextlib import suppress

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest import golden_store
from ingest.inventory_csv import STALE_NOTE, current_stock
from ingest.lead_store import connect
from pipelines import rollout, scenario
from pipelines.job_runs import job_run
from pipelines.production import NOTE_NO_STOCK, TZ_VN, shortage

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_WEEKS = 13
SEP = "–"   # en dash: ô dự báo luôn "thấp–cơ sở–cao"


def _cell(d: dict) -> str:
    return SEP.join(str(d[lv]) for lv in scenario.LEVELS)


def forecast(skus: list[dict], stock: dict | None, start: dt.date,
             weeks: int, assumptions: dict) -> list[dict]:
    """THUẦN. stock = `current_stock()` | None (chưa đối chiếu được).
    Raise `scenario.ScenarioError` khi giả định thiếu cho SKU × kênh."""
    out = []
    for sku in skus:
        key = sku["sku_key"]
        chans, notes = {}, {}
        sums = dict.fromkeys(scenario.LEVELS, 0)
        for ch in scenario.ALL_CHANNELS:
            rows = scenario.project(sku, ch, start, weeks, assumptions)
            chans[ch] = {lv: sum(r[lv] for r in rows)
                         for lv in scenario.LEVELS}
            note = next((r["note"] for r in rows if r.get("note")), None)
            if note:
                notes[ch] = note
            for lv in scenario.LEVELS:
                sums[lv] += chans[ch][lv]
        st = (stock or {}).get(key)
        qty = st["qty"] if st else None
        level, warn = shortage(qty, sums)
        excess = qty is not None and qty > sums["high"]
        out.append({"sku_key": key, "category": sku.get("category"),
                    "channels": chans, "notes": notes, "sums": sums,
                    "stock": qty, "level": level, "warn": warn,
                    "excess": (qty - sums["high"]) if excess else 0,
                    "stale": list(st["stale"]) if st else [],
                    "sample": bool(st and st["sample"]),
                    "reconciled": stock is not None})
    return out


def render(rows: list[dict], start: dt.date, weeks: int,
           status: str | None = None) -> str:
    end = start + dt.timedelta(weeks=weeks, days=-1)
    L = [(f"# Dự báo mùa SKU × kênh — {start.isoformat()} → "
          f"{end.isoformat()} ({weeks} tuần)"), ""]
    if status:
        L += [status, ""]
    L += [("Khoảng thấp–cơ sở–cao (đơn vị, cộng cả kỳ) — KHÔNG phải doanh số "
           "cam kết; giả định số bán chưa phải số thật."), "",
          "| SKU | " + " | ".join(scenario.ALL_CHANNELS) + " | Tổng |",
          "|---" * (len(scenario.ALL_CHANNELS) + 2) + "|"]
    for r in rows:
        cells = [_cell(r["channels"][ch]) for ch in scenario.ALL_CHANNELS]
        L.append(f"| {r['sku_key']} | " + " | ".join(cells)
                 + f" | {_cell(r['sums'])} |")
    L += ["", "## Đối chiếu tồn", ""]
    for r in rows:
        k = r["sku_key"]
        if not r["reconciled"]:
            L.append(f"- {k}: không đối chiếu được tồn")
            continue
        if r["stock"] is None:
            L.append(f"- {k}: {NOTE_NO_STOCK}")
            continue
        tag = " (MẪU)" if r["sample"] else ""
        msgs = [m for m in (
            r["warn"],
            (f"THỪA: dư {r['excess']} so với kịch bản cao"
             if r["excess"] else None)) if m]
        L.append(f"- {k}: tồn {r['stock']}{tag} — "
                 f"{'; '.join(msgs) or 'đủ cho cả kịch bản cao'}")
        if r["stale"]:
            L.append(f"  - {STALE_NOTE} (kho: {', '.join(r['stale'])})")
    notes = [(r["sku_key"], ch, n) for r in rows
             for ch, n in r["notes"].items()]
    if notes:
        L += ["", "## Ghi chú engine kịch bản", ""]
        L += [f"- {k} × {ch}: {n}" for k, ch, n in notes]
    L.append("")
    return "\n".join(L)


# ---------- CLI ----------

def _weeks(s: str) -> int:
    try:
        n = int(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("phải là số nguyên") from e
    if not 1 <= n <= scenario.MAX_WEEKS:
        raise argparse.ArgumentTypeError(f"phải trong 1..{scenario.MAX_WEEKS}")
    return n


def _start(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from e
    if not scenario.DATE_MIN <= d <= scenario.DATE_MAX:
        raise argparse.ArgumentTypeError("ngày ngoài khoảng hợp lệ")
    return d


def _today_vn() -> dt.date:
    return dt.datetime.now(TZ_VN).date()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_forecast",
        description="KD-A10 dự báo mùa SKU × kênh (khoảng thấp–cơ sở–cao qua"
                    " engine kịch bản chung) + đối chiếu tồn")
    ap.add_argument("--start", type=_start,
                    help="mặc định thứ Hai tuần này (giờ VN)")
    ap.add_argument("--weeks", type=_weeks, default=DEFAULT_WEEKS)
    ap.add_argument("--sku")
    ap.add_argument("--write", action="store_true",
                    help="ghi data/reports/kd-forecast-<start>.md")
    a = ap.parse_args(argv)
    # r12 RB: tắt → không in/ghi dự báo (chặn trước khi đọc dữ liệu).
    why = rollout.blocked(None, "dự báo mùa", fid="sales-07.3")
    if why:
        return rollout.say_blocked(why)
    start = scenario.week_start(a.start or _today_vn())
    doc, why = golden_store.read_golden(scenario.GOLDEN_FILE)
    if doc is None:
        print(f"[err] golden: {why}", file=sys.stderr)
        return 1
    errs = golden_store.validate(doc)
    if errs:
        print(f"[err] golden không hợp lệ ({len(errs)} lỗi), lỗi đầu: "
              f"{errs[0]}", file=sys.stderr)
        return 1
    skus = [s for s in doc["skus"] if isinstance(s, dict)
            and (a.sku is None or s.get("sku_key") == a.sku)]
    if not skus:
        print(f"[err] SKU '{a.sku}' không có trong golden", file=sys.stderr)
        return 1
    try:
        assumptions = scenario.load_assumptions()
    except scenario.ScenarioError as e:
        print(f"[err] giả định: {e}", file=sys.stderr)
        return 1
    stock, rc = None, 0
    conn = connect()
    if conn is None:
        print("[warn] không đối chiếu được tồn (không kết nối được Postgres)",
              file=sys.stderr)
        rc = 1
    else:
        try:
            stock = current_stock(conn)
        except psycopg.Error as e:
            print(f"[warn] không đối chiếu được tồn ({type(e).__name__})",
                  file=sys.stderr)
            rc = 1
        finally:
            with suppress(Exception):
                conn.close()
    try:
        rows = forecast(skus, stock, start, a.weeks, assumptions)
    except scenario.ScenarioError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 1
    text = render(rows, start, a.weeks, assumptions.get("status"))
    print(text)
    if a.write:
        try:
            # P8.4: tồn nạp từ file MẪU → không đếm là đầu ra thật.
            p = write_report(text, REPORTS_DIR,
                             f"kd-forecast-{start.isoformat()}.md",
                             sample=any(r["sample"] for r in rows))
        except OSError as e:
            print(f"[err] không ghi được báo cáo ({type(e).__name__})",
                  file=sys.stderr)
            return 1
        print(f"[write] {p}")
    return rc


main = rollout.cli_entry(main)


if __name__ == "__main__":
    with job_run("agents.kd_forecast") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
