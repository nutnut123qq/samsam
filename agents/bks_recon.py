"""v10.0 W100.5 (WP16) — Đối soát ĐỘC LẬP của BKS: doanh thu quyết toán ↔
đơn sàn ↔ P&L ↔ số cockpit báo TGĐ.

Tài chính giữ nghiệp vụ hằng ngày (`ingest.settlement_csv` tự ghi
`recon_results`); BKS HẬU KIỂM — module này KHÔNG tin `recon_results`:
  - `collect(conn, month)` 4 nguồn theo kênh (`shopee`, `tiktok`; cockpit
    `tiktok_shop` ↔ `tiktok` qua `COCKPIT_CHANNEL`):
      Q = `settlement_rows` `settled_on` trong tháng (Σ giá trị đơn, Σ thực
          nhận, số dòng);
      Đ = Σ `price_vnd × qty` của snapshot `order` MỚI NHẤT chứa mã — CÙNG
          `ingest.settlement_csv._ORDER_SQL` (import, không chép);
      P = `agents.fp_pnl.compute` Σ thực nhận/doanh thu các ô P&L;
      C = `channel_snapshots` `sales.settlement_vnd` kỳ tháng (ưu tiên
          `manual_export` như `ceo_report._pick`).
  - `diffs(src)` THUẦN: Q.payout ↔ P (`pnl_lech_quyet_toan`), Q.payout ↔ C
    (`cockpit_lech_quyet_toan`), Q.order_amount ↔ Đ (`don_lech_quyet_toan`);
    thiếu 1 phía → `thieu_nguon` (KHÔNG coi = 0); |Δ| ≤ `tolerance_vnd` của
    kênh → khớp. Mỗi khác biệt có refs (`file dòng N` / `market_snapshots#id
    dòng N` / `channel_snapshots#id` / `pnl:<tháng>/<kênh>`).
  - `recheck_rows(rows, orders, fees)` THUẦN: tính lại TỪNG dòng (mẫu) bằng
    `settlement_csv.reconcile_row` rồi so nhãn/expected đã lưu: khác →
    `nhan_lech`; không có dòng recon → `chua_doi_soat`. Kết quả tính lại
    `lech` → `quyet_toan_lech` (kèm mã lý do), `thieu_chung_tu` →
    `quyet_toan_khong_don` (bản thân dòng lệch — BKS báo độc lập, không chỉ
    khi nhãn đã lưu sai). Đơn trong snapshot order mới nhất không có dòng
    quyết toán nào → `don_chua_quyet_toan`.
  - `pick_sample(ids, seed, limit=200)` THUẦN: ≤ 200 dòng/kỳ → kiểm 100%;
    > 200 → `random.Random(seed).sample` sắp lại. Seed (`--seed` hoặc
    `secrets.randbits(32)`) ghi vào báo cáo + `audit_runs.params`.
CHỈ ĐỌC ngoài `insert into audit_runs` (`--record`). Báo cáo/stdout KHÔNG
chép mã đơn, `order_id_hash`, tên/SĐT người mua — trỏ dòng bằng file + số
dòng. Không LLM, không mạng.

Chạy: python -m agents.bks_recon --month YYYY-MM [--seed N] [--now ISO]
      [--out-dir DIR] [--record | --dry-run]
Exit: 0 ok (kể cả có lệch) · 1 cấu hình phí hỏng · 2 tham số / kỳ chưa
đóng / DB down / lỗi DB.
"""

import argparse
import random
import secrets
import sys
from collections import Counter
from contextlib import suppress
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import psycopg

from agents import fp_pnl
from agents.bks_audit import _why, month_bounds, record_run
from agents.ra_kenh import parse_now, safe
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import _clean
from ingest.settlement_csv import (
    _COLS,
    _ORDER_SQL,
    CHANNELS,
    load_fees,
    reconcile_row,
)
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

RUN_BY = "agent:bks_recon"
KIND = "recon"
SAMPLE_LIMIT = 200
METRIC = "sales.settlement_vnd"
# kênh đối soát → kênh cockpit (data/metrics.json)
COCKPIT_CHANNEL = {"shopee": "shopee", "tiktok": "tiktok_shop"}
PAIRS = (("pnl_lech_quyet_toan", ("Q", "payout"), ("P", "thuc_nhan")),
         ("cockpit_lech_quyet_toan", ("Q", "payout"), ("C", "value")),
         ("don_lech_quyet_toan", ("Q", "order_amount"), ("D", "value")))
SRC_NAME = {"Q": "quyết toán (settlement_rows)",
            "D": "đơn sàn (market_rows, snapshot order mới nhất)",
            "P": "P&L (agents.fp_pnl.compute)",
            "C": "cockpit TGĐ (channel_snapshots sales.settlement_vnd)"}
ROW_CODES = ("nhan_lech", "chua_doi_soat", "quyet_toan_lech",
             "quyet_toan_khong_don", "don_chua_quyet_toan")
CODES = tuple(c for c, _a, _b in PAIRS) + ("thieu_nguon",) + ROW_CODES
MAX_LINES = 200
_ROW_SQL = (
    "select id, file_name, row_no, channel, order_id_hash, "
    + ", ".join(f"{c}_vnd" for c in _COLS)
    + " from settlement_rows where settled_on >= %s and settled_on < %s"
    " order by id")
_CS_SQL = (
    "select id, channel, value, source, source_ref from channel_snapshots"
    " where metric_id = %s and period_kind = 'month' and period_start = %s"
    " order by id")
_UNSETTLED_SQL = (
    "with snap as (select distinct on (channel) id, channel from"
    " market_snapshots where export_kind = 'order' order by channel,"
    " imported_at desc, id desc) select s.id, s.channel, min(m.row_no) from"
    " snap s join market_rows m on m.snapshot_id = s.id where"
    " m.order_id_hash is not null and not exists (select 1 from"
    " settlement_rows r where r.channel = m.channel and r.order_id_hash ="
    " m.order_id_hash) group by s.id, s.channel, m.order_id_hash order by"
    " 2, 3")


def _fname(s) -> str:
    return _clean(_mask_pii(safe(s)), 80).replace("`", "'").replace("|", "/")


def _vnd(n) -> str:
    return fp_pnl.vnd(n)


# ------------------------------------------------------------------ thuần

def pick_sample(ids, seed: int, limit: int = SAMPLE_LIMIT) -> list:
    """≤ limit → tất cả (sắp xếp); > limit → mẫu `limit` theo seed (tất
    định: cùng seed + cùng tập → cùng mẫu)."""
    ids = sorted(ids)
    if len(ids) <= limit:
        return ids
    return sorted(random.Random(seed).sample(ids, limit))


def recheck_rows(rows: list[dict], orders: dict, fees: dict) -> list[dict]:
    """rows: {id, ref, channel, order_id_hash, <field chuẩn>, stored: {label,
    expected} | None}; orders: {(kênh, hash): Σ đơn}; fees: `load_fees`."""
    out = []
    for r in rows:
        amt = orders.get((r["channel"], r["order_id_hash"]))
        label, reasons, expected = reconcile_row(r, amt, fees[r["channel"]])
        base = {"channel": r["channel"], "refs": [r["ref"]]}
        st = r.get("stored")
        if st is None:
            out.append(dict(base, code="chua_doi_soat", recomputed=label))
        elif st["label"] != label or st["expected"] != expected:
            out.append(dict(base, code="nhan_lech", stored=st["label"],
                            recomputed=label))
        if label == "lech":
            out.append(dict(base, code="quyet_toan_lech",
                            reasons=[x["code"] for x in reasons]))
        elif label == "thieu_chung_tu":
            out.append(dict(base, code="quyet_toan_khong_don"))
    return out


def diffs(src: dict) -> list[dict]:
    """src = {"month": nhãn, "channels": {kênh: {"Q","D","P","C": dict|None,
    "tol": int}}} → khác biệt (THUẦN). Thiếu cả 2 phía → bỏ (kênh không có
    dữ liệu); thiếu 1 phía → `thieu_nguon` (không coi = 0)."""
    out = []
    for ch, s in sorted(src["channels"].items()):
        for code, (ka, fa), (kb, fb) in PAIRS:
            a, b = s.get(ka), s.get(kb)
            if a is None and b is None:
                continue
            side = {"a": {"nguon": SRC_NAME[ka],
                          "gia_tri": None if a is None else a[fa]},
                    "b": {"nguon": SRC_NAME[kb],
                          "gia_tri": None if b is None else b[fb]}}
            refs = ((a or {}).get("refs", []) if code != "don_lech_quyet_toan"
                    else (a or {}).get("row_refs", [])) + (b or {}).get(
                        "refs", [])
            base = {"channel": ch, "month": src["month"], **side,
                    "refs": refs}
            if a is None or b is None:
                out.append(dict(base, code="thieu_nguon", pair=code,
                                missing=SRC_NAME[ka if a is None else kb],
                                delta=None))
                continue
            d = a[fa] - b[fb]
            if abs(d) > s["tol"]:
                out.append(dict(base, code=code, delta=d))
    return out


# ------------------------------------------------------------------ đọc DB

def _cockpit(conn, month: date) -> dict:
    """{kênh đối soát: {value, refs, sample}} — manual_export > api."""
    by: dict = {}
    for sid, ch, val, src, ref in conn.execute(_CS_SQL, (METRIC, month)):
        if ch in by and by[ch]["source"] == "manual_export":
            continue
        by[ch] = {"id": sid, "value": Decimal(val), "source": src,
                  "ref": ref or ""}
    out = {}
    for ours, theirs in COCKPIT_CHANNEL.items():
        c = by.get(theirs)
        if c is None or not c["value"].is_finite():
            continue
        out[ours] = {"value": int(c["value"]),
                     "refs": [f"channel_snapshots#{c['id']}"],
                     "sample": c["ref"].startswith("sample:")}
    return out


def collect(conn, month: date, seed: int, fees: dict) -> dict:
    """CHỈ SELECT → {src, row_findings, n_total, n_checked, sample_flag}."""
    start, end = (d.date() for d in period_bounds("month", month))
    label = f"{month:%Y-%m}"
    cols = ("id", "file_name", "row_no", "channel", "order_id_hash",
            *_COLS)
    rows = [dict(zip(cols, r)) for r in conn.execute(_ROW_SQL, (start, end))]
    hashes = sorted({r["order_id_hash"] for r in rows})
    orders = ({(ch, h): int(t) for ch, h, t in conn.execute(
        _ORDER_SQL, (hashes,))} if hashes else {})
    cockpit = _cockpit(conn, month)
    sample_flag = any("_MAU" in (r["file_name"] or "") for r in rows) or any(
        c["sample"] for c in cockpit.values())
    channels = {}
    for ch in CHANNELS:
        mine = [r for r in rows if r["channel"] == ch]
        q = d = p = None
        if mine:
            files = Counter(r["file_name"] for r in mine)
            q = {"order_amount": sum(r["order_amount"] for r in mine),
                 "payout": sum(r["payout"] for r in mine), "n": len(mine),
                 "refs": [f"{_fname(f)} ({n} dòng)"
                          for f, n in sorted(files.items())],
                 "row_refs": [
                     f"{_fname(r['file_name'])} dòng {r['row_no']}"
                     for r in mine
                     if orders.get((ch, r["order_id_hash"]))
                     != r["order_amount"]]}
            found = [orders[(ch, r["order_id_hash"])] for r in mine
                     if (ch, r["order_id_hash"]) in orders]
            if found:
                d = {"value": sum(found), "refs": []}
            pn = fp_pnl.compute(conn, month, ch)
            if pn["n_rows"]:
                p = {"thuc_nhan": sum(c["thuc_nhan"] for c in pn["cells"]),
                     "doanh_thu": sum(c["doanh_thu"] or 0
                                      for c in pn["cells"]),
                     "refs": [f"pnl:{label}/{ch}"]}
        channels[ch] = {"Q": q, "D": d, "P": p, "C": cockpit.get(ch),
                        "tol": fees[ch]["tolerance_vnd"]}
    # Lấy mẫu dòng để tính lại (≤200 → 100%).
    picked = set(pick_sample([r["id"] for r in rows], seed))
    stored = {}
    if picked:
        stored = {sid: {"label": lb, "expected": ex} for sid, lb, ex in
                  conn.execute(
                      "select settlement_row_id, label, expected_payout_vnd"
                      " from recon_results where settlement_row_id = any(%s)",
                      (sorted(picked),))}
    check = [dict(r, ref=f"{_fname(r['file_name'])} dòng {r['row_no']}",
                  stored=stored.get(r["id"]))
             for r in rows if r["id"] in picked]
    row_f = recheck_rows(check, orders, fees)
    row_f += [{"code": "don_chua_quyet_toan", "channel": ch,
               "refs": [f"market_snapshots#{sid} dòng {rn}"]}
              for sid, ch, rn in conn.execute(_UNSETTLED_SQL)]
    return {"src": {"month": label, "channels": channels},
            "row_findings": row_f, "n_total": len(rows),
            "n_checked": len(picked), "seed": seed,
            "sample_flag": sample_flag}


# ------------------------------------------------------------------ báo cáo

def _money(v) -> str:
    return "—" if v is None else _vnd(v)


def _diff_line(f: dict) -> str:
    if f["code"] == "thieu_nguon":
        head = (f"[thieu_nguon] kênh {f['channel']} tháng {f['month']} — "
                f"cặp {f['pair']} thiếu nguồn: {f['missing']}")
    else:
        head = (f"[{f['code']}] kênh {f['channel']} tháng {f['month']} — "
                f"{f['a']['nguon']} {_money(f['a']['gia_tri'])} ↔ "
                f"{f['b']['nguon']} {_money(f['b']['gia_tri'])} · Δ "
                f"{_money(f['delta'])}")
    refs = "; ".join(f["refs"][:MAX_LINES]) or "—"
    return f"- {head} · nguồn: {refs}"


def _row_line(f: dict) -> str:
    extra = ""
    if f["code"] == "nhan_lech":
        extra = f" — nhãn đã lưu {f['stored']} ≠ tính lại {f['recomputed']}"
    elif f["code"] == "chua_doi_soat":
        extra = f" — tính lại: {f['recomputed']}"
    elif f.get("reasons"):
        extra = " — lý do: " + ", ".join(f["reasons"])
    return f"- [{f['code']}] kênh {f['channel']}: {'; '.join(f['refs'])}" \
           + extra


def findings_of(data: dict) -> list[dict]:
    return diffs(data["src"]) + data["row_findings"]


def render(data: dict, now: datetime) -> str:
    src = data["src"]
    allf = findings_of(data)
    cnt = Counter(f["code"] for f in allf)
    vn = now.astimezone(VN_TZ)
    mau = " (MẪU)" if data["sample_flag"] else ""
    L = [f"# Đối soát độc lập BKS — tháng {src['month']}{mau}", "",
         (f"Sinh lúc {vn:%d/%m/%Y %H:%M} giờ VN bởi `{RUN_BY}` (sổ lần chạy "
          "MÁY — KHÔNG phải chữ ký BKS). Chỉ đọc; không bút toán, không sửa "
          "đối soát của Tài chính."), ""]
    if data["sample_flag"]:
        L += [("*(MẪU) — có nguồn là file/fixture MẪU, không phải số vận "
               "hành thật.*"), ""]
    L += ["## Bốn nguồn theo kênh", "",
          ("| Kênh | Quyết toán: giá trị đơn | Quyết toán: thực nhận | Số "
           "dòng | Đơn sàn | P&L thực nhận | Cockpit TGĐ |"),
          "|---|---|---|---|---|---|---|"]
    for ch, s in sorted(src["channels"].items()):
        q = s["Q"] or {}
        L.append(f"| {ch} | {_money(q.get('order_amount'))} | "
                 f"{_money(q.get('payout'))} | {q.get('n', 0)} | "
                 f"{_money((s['D'] or {}).get('value'))} | "
                 f"{_money((s['P'] or {}).get('thuc_nhan'))} | "
                 f"{_money((s['C'] or {}).get('value'))} |")
    L += ["", "## Tổng theo mã", "", "| Mã | Số |", "|---|---|"]
    L += [f"| {c} | {cnt.get(c, 0)} |" for c in CODES]
    L += ["", "## Khác biệt 4 nguồn", ""]
    L += [_diff_line(f) for f in diffs(src)] or ["- (khớp trong dung sai)"]
    L += ["", "## Tính lại từng dòng + đơn chưa quyết toán", "",
          (f"Lấy mẫu: seed {data['seed']} · {data['n_checked']}/"
           f"{data['n_total']} dòng quyết toán trong tháng được tính lại "
           f"({'100%' if data['n_checked'] == data['n_total'] else 'mẫu'};"
           f" ngưỡng kiểm 100% = {SAMPLE_LIMIT} dòng)."), ""]
    rows = data["row_findings"]
    L += [_row_line(f) for f in rows[:MAX_LINES]] or ["- (không có)"]
    if len(rows) > MAX_LINES:
        L.append(f"- …còn {len(rows) - MAX_LINES} dòng")
    L += ["", "---", ("*BẢN NHÁP — chờ BKS ký (external-dep). Số liệu thật "
                      "Seller Center/kế toán là external-dep.*"), ""]
    return "\n".join(L)


# ------------------------------------------------------------------ CLI

def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.bks_recon",
        description="Đối soát độc lập BKS (CHỈ ĐỌC; ghi duy nhất audit_runs"
                    " khi --record)")
    ap.add_argument("--month", required=True, help="YYYY-MM")
    ap.add_argument("--seed", type=int, default=None,
                    help="seed lấy mẫu (mặc định ngẫu nhiên, ghi báo cáo)")
    ap.add_argument("--now", help="ISO; thiếu múi giờ = giờ VN")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.record and a.dry_run:
        ap.error("--record và --dry-run loại trừ nhau")
    if a.seed is not None and not 0 <= a.seed < 2**63:
        ap.error("--seed phải ≥ 0")
    try:
        now = parse_now(a.now) if a.now else (now or datetime.now(VN_TZ))
    except ValueError:
        ap.error("--now sai định dạng ISO")
    try:
        label, start, _end = month_bounds(a.month, now)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    fees, why = load_fees()
    if fees is None:
        print(f"[error] {why} — không connect.", file=sys.stderr)
        return 1
    seed = a.seed if a.seed is not None else secrets.randbits(32)
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if not a.record:
            conn.read_only = True
        data = collect(conn, start.date(), seed, fees)
        text = render(data, now)
        n = len(findings_of(data))
        if a.dry_run:
            print(text)
            return 0
        path = write_report(text, a.out_dir, f"bks-recon-{label}.md")
        rid = None
        if a.record:
            rid = record_run(conn, KIND, label, {
                "seed": seed, "n_total": data["n_total"],
                "n_checked": data["n_checked"]}, n, text, RUN_BY)
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_why(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.rollback()
        with suppress(Exception):
            conn.close()
    print(f"[done] {path} — tháng {label}, {n} khác biệt/phát hiện, seed "
          f"{seed}, kiểm {data['n_checked']}/{data['n_total']} dòng"
          + (f" · audit_runs #{rid}" if rid else " · không ghi sổ"))
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.bks_recon") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
