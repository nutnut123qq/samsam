"""v10.1 KD-A6 (WP16) — đơn sàn → bảng lõi `orders` + file đối soát doanh
thu thực nhận. LUẬT tất định, KHÔNG LLM, KHÔNG gọi sàn/mạng, KHÔNG gửi.

Ownership:
  - `sync` CHỈ ĐỌC `market_snapshots`/`market_rows` (export `order` của
    `ingest.market_csv` v3.3) và CHỈ GHI `orders`. Đơn sàn id
    `"<kênh>:<order_id_hash>"`, source `market:<kênh>`. Upsert chỉ đè row
    có source `market:%` (row `manual`/sample/core_store KHÔNG bị đè) và
    KHÔNG đổi `ts`. Không PII: file sàn đã bỏ cột người mua lúc nạp, mã
    đơn chỉ còn hash; `orders` không có cột tên/SĐT/địa chỉ.
  - `recon_rows`/`write_csv` CHỈ ĐỌC `orders`/`settlement_rows`/
    `recon_results` (v9.0) → CSV cho kế toán. Chỉ BÁO CÁO: không ghi DB,
    không bút toán; kế toán duyệt file (external).

GIẢ ĐỊNH (chờ file thật từ Seller Center): file export chưa có cột ngày đặt
→ `orders.ts` = `imported_at` của snapshot ĐẦU TIÊN thấy đơn; sàn không map
`products` → `product_id` null, các `sku_key` đã map ghi vào `note`. Trạng
thái đơn = trạng thái DÒNG ĐẦU của đơn trong snapshot (cùng
`acc_invoice.fetch_orders`); thuộc `cancel_status` của mapping → `cancelled`
(total_vnd vẫn = Σ giá×SL để đối soát; `agents.report` LOẠI `cancelled`
khỏi Đơn hàng/Doanh thu và ghi chú ngày đơn sàn = ngày nạp file).

Chạy:
  python -m agents.kd_orders --sync [--snapshot ID] [--dry-run]
  python -m agents.kd_orders --recon --since 2026-10-01 --until 2026-10-31
      [--out-dir DIR]
Print/log chỉ đếm + `order_id_hash[:8]` — không in hash đủ 16 ký tự.
Exit: 0 ok · 1 cấu hình/DB lỗi · 2 tham số sai / DB không kết nối.
"""

import argparse
import csv
import io
import os
import sys
import unicodedata
from contextlib import suppress
from datetime import date
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR
from ingest.lead_store import connect
from ingest.market_csv import _clean, load_mapping
from pipelines.job_runs import job_run
from pipelines.period import period_bounds
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

JOB = "agents.kd_orders"
SOURCE_PREFIX = "market:"
MAX_NOTE = 200
MAX_STATUS = 40
CSV_FIELDS = ("channel", "order_ref", "status", "total_vnd",
              "order_amount_vnd", "platform_fee_vnd", "shipping_fee_vnd",
              "voucher_seller_vnd", "affiliate_vnd", "refund_vnd",
              "payout_vnd", "label")
MONEY_FIELDS = CSV_FIELDS[3:11]
LABELS = ("khop", "lech", "thieu_chung_tu", "hoan", "chua_quyet_toan",
          "thieu_don")
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _nfc(s) -> str:
    return unicodedata.normalize("NFC", str(s)).strip()


# ------------------------------------------------------------ đơn (THUẦN)

def build_orders(rows, cancel_status) -> list[dict]:
    """THUẦN, tất định. `rows` = dòng `market_rows` export order của 1
    snapshot (dict channel, order_id_hash, status, qty, price_vnd, sku_key),
    theo row_no. `cancel_status` = {kênh: [trạng thái hủy]} (mapping).
    Gom theo (kênh, order_id_hash) → 1 đơn; tổng = Σ price × qty (cùng công
    thức `acc_invoice.fetch_orders`). Dòng thiếu hash bị bỏ (caller đếm)."""
    out: dict = {}
    for r in rows:
        h, ch = r.get("order_id_hash"), r.get("channel")
        if not h or not ch:
            continue
        o = out.get((ch, h))
        if o is None:
            st = r.get("status")
            cancels = {_nfc(s) for s in (cancel_status or {}).get(ch, [])}
            if st is not None and _nfc(st) in cancels:
                status = "cancelled"
            else:
                status = _clean(st, MAX_STATUS).strip() if st else "new"
            o = out[(ch, h)] = {
                "id": f"{ch}:{h}", "channel": ch, "qty": 0, "total_vnd": 0,
                "status": status or "new", "product_id": None, "skus": set(),
                "source": f"{SOURCE_PREFIX}{ch}"}
        o["qty"] += r.get("qty") or 0
        o["total_vnd"] += (r.get("price_vnd") or 0) * (r.get("qty") or 0)
        if r.get("sku_key"):
            o["skus"].add(r["sku_key"])
    res = []
    for o in out.values():
        skus = o.pop("skus")
        o["note"] = ",".join(sorted(skus))[:MAX_NOTE] if skus else None
        res.append(o)
    return res


def _snapshots(conn, snapshot_ids=None) -> list[tuple]:
    sql = ("select id, channel, imported_at from market_snapshots where"
           " export_kind = 'order'")
    params: tuple = ()
    if snapshot_ids is not None:
        sql += " and id = any(%s)"
        params = (list(snapshot_ids),)
    return conn.execute(sql + " order by imported_at, id", params).fetchall()


def _rows(conn, sid: int) -> list[dict]:
    cols = ("channel", "order_id_hash", "status", "qty", "price_vnd",
            "sku_key")
    return [dict(zip(cols, r)) for r in conn.execute(
        "select channel, order_id_hash, status, qty, price_vnd, sku_key"
        " from market_rows where snapshot_id = %s and export_kind = 'order'"
        " order by row_no", (sid,)).fetchall()]


_UPSERT_SQL = (
    "insert into orders (id, ts, channel, product_id, qty, total_vnd,"
    " status, note, source) values (%s, %s, %s, null, %s, %s, %s, %s, %s)"
    " on conflict (id) do update set status = excluded.status,"
    " qty = excluded.qty, total_vnd = excluded.total_vnd,"
    " note = excluded.note where orders.source like 'market:%%'"
    " and (orders.status, orders.qty, orders.total_vnd, orders.note)"
    " is distinct from (excluded.status, excluded.qty, excluded.total_vnd,"
    " excluded.note)")


def sync(conn, snapshot_ids=None, dry_run: bool = False) -> dict:
    """Đơn sàn → `orders` (1 transaction + commit). Snapshot sau thắng;
    `ts` = imported_at snapshot ĐẦU TIÊN thấy đơn (không cập nhật khi
    upsert). → {"inserted", "updated", "unchanged", "protected" (cùng id
    nhưng source không phải market:% — không đè), "skipped" (dòng thiếu
    mã đơn), "snapshots"}."""
    mapping, why = load_mapping()
    if mapping is None:
        raise ValueError(why)
    cancel = {ch: (spec.get("order") or {}).get("cancel_status", [])
              for ch, spec in mapping.items() if isinstance(spec, dict)}
    merged: dict = {}
    first_ts: dict = {}
    skipped = 0
    snaps = _snapshots(conn, snapshot_ids)
    for sid, _ch, imported_at in snaps:
        rows = _rows(conn, sid)
        skipped += sum(1 for r in rows if not r["order_id_hash"])
        for o in build_orders(rows, cancel):
            first_ts.setdefault(o["id"], imported_at)
            merged[o["id"]] = o
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "protected": 0,
              "skipped": skipped, "snapshots": len(snaps)}
    existing = {r[0]: r[1:] for r in conn.execute(
        "select id, source, status, qty, total_vnd, note from orders"
        " where id = any(%s)", (list(merged),)).fetchall()} if merged else {}
    todo = []
    for oid in sorted(merged):
        o = merged[oid]
        cur = existing.get(oid)
        if cur is None:
            counts["inserted"] += 1
        elif not str(cur[0]).startswith(SOURCE_PREFIX):
            counts["protected"] += 1
            continue
        elif tuple(cur[1:]) == (o["status"], o["qty"], o["total_vnd"],
                                o["note"]):
            counts["unchanged"] += 1
            continue
        else:
            counts["updated"] += 1
        todo.append((oid, first_ts[oid], o["channel"], o["qty"],
                     o["total_vnd"], o["status"], o["note"], o["source"]))
    if dry_run:
        conn.rollback()
        return counts
    with conn.transaction(), conn.cursor() as cur:
        if todo:
            cur.executemany(_UPSERT_SQL, todo)
    conn.commit()
    return counts


# ------------------------------------------------------------ đối soát

def recon_rows(conn, since: date, until: date) -> list[dict]:
    """Đơn sàn (`orders` source market:%, `ts` ∈ [since, until] giờ VN) →
    1 dòng/đơn kèm settlement MỚI NHẤT của đơn (theo imported_at, id) +
    nhãn `recon_results` (chưa có settlement → `chua_quyet_toan`).
    Settlement có `settled_on` trong kỳ mà không có đơn trong `orders` →
    dòng `thieu_don`. CHỈ SELECT. Sắp tất định theo (kênh, mã, nhãn)."""
    start = period_bounds("day", since)[0]
    end = period_bounds("day", until)[1]
    sett = {}
    for (ch, h, amount, fixed, pay, svc, ship, voucher, aff, refund, payout,
         settled_on, label) in conn.execute(
            "select distinct on (s.channel, s.order_id_hash) s.channel,"
            " s.order_id_hash, s.order_amount_vnd, s.fixed_fee_vnd,"
            " s.payment_fee_vnd, s.service_fee_vnd, s.shipping_fee_vnd,"
            " s.voucher_seller_vnd, s.affiliate_vnd, s.refund_vnd,"
            " s.payout_vnd, s.settled_on, r.label from settlement_rows s"
            " left join recon_results r on r.settlement_row_id = s.id"
            " order by s.channel, s.order_id_hash, s.imported_at desc,"
            " s.id desc").fetchall():
        sett[(ch, h)] = {
            "order_amount_vnd": amount,
            "platform_fee_vnd": fixed + pay + svc,
            "shipping_fee_vnd": ship, "voucher_seller_vnd": voucher,
            "affiliate_vnd": aff, "refund_vnd": refund,
            "payout_vnd": payout, "settled_on": settled_on, "label": label}
    known = set()
    for (oid,) in conn.execute(
            "select id from orders where source like 'market:%'"):
        ch, _, h = oid.partition(":")
        known.add((ch, h))
    out = []
    for oid, ch, status, total in conn.execute(
            "select id, channel, status, total_vnd from orders where source"
            " like 'market:%%' and ts >= %s and ts < %s", (start, end)):
        h = oid.partition(":")[2]
        s = sett.get((ch, h))
        row = {"channel": ch, "order_ref": h[:8], "status": status,
               "total_vnd": total}
        if s is None:
            row.update({k: None for k in MONEY_FIELDS[1:]})
            row["label"] = "chua_quyet_toan"
        else:
            row.update({k: s[k] for k in MONEY_FIELDS[1:]})
            # settlement chưa được đối chiếu (thiếu recon_results) → coi
            # như chưa quyết toán xong (không đoán nhãn).
            row["label"] = s["label"] or "chua_quyet_toan"
        out.append(row)
    for (ch, h), s in sett.items():
        if (ch, h) in known or s["settled_on"] is None \
                or not since <= s["settled_on"] <= until:
            continue
        row = {"channel": ch, "order_ref": h[:8], "status": "",
               "total_vnd": None}
        row.update({k: s[k] for k in MONEY_FIELDS[1:]})
        row["label"] = "thieu_don"
        out.append(row)
    out.sort(key=lambda r: (r["channel"], r["order_ref"], r["label"]))
    return out


def _cell(v) -> str:
    """Ô CSV: số giữ nguyên; chuỗi (trạng thái từ file sàn) chặn công thức
    bảng tính (=, +, -, @ đầu ô) bằng tiền tố '."""
    if v is None:
        return ""
    if isinstance(v, int):
        return str(v)
    s = _clean(v, 120)
    return "'" + s if s.startswith(_FORMULA_START) else s


def totals(rows: list[dict]) -> list[dict]:
    """Hàng TỔNG theo kênh — CODE cộng (ô rỗng = 0)."""
    by: dict = {}
    for r in rows:
        t = by.setdefault(r["channel"], {
            "channel": r["channel"], "order_ref": "TONG", "status": "",
            **{k: 0 for k in MONEY_FIELDS}, "label": ""})
        for k in MONEY_FIELDS:
            t[k] += r.get(k) or 0
    return [by[k] for k in sorted(by)]


def render_csv(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(CSV_FIELDS)
    for r in [*rows, *totals(rows)]:
        w.writerow([_cell(r.get(k)) for k in CSV_FIELDS])
    return buf.getvalue().encode("utf-8-sig")


def write_csv(rows: list[dict], out_dir: Path, since: date,
              until: date) -> Path:
    """`doi-soat-<since>-<until>.csv` atomic (tmp + os.replace, BYTES,
    `\\n`, utf-8-sig) — cùng dữ liệu → byte-giống nhau."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"doi-soat-{since.isoformat()}-{until.isoformat()}.csv"
    tmp = final.with_name(final.name + ".tmp")
    tmp.write_bytes(render_csv(rows))
    os.replace(tmp, final)
    return final


# ------------------------------------------------------------------ CLI

def _date(ap, v: str, name: str) -> date:
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        ap.error(f"{name} phải dạng YYYY-MM-DD")


def _main(args, since, until) -> int:
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.sync:
            res = sync(conn, [args.snapshot] if args.snapshot else None,
                       dry_run=args.dry_run)
            tag = "dry-run" if args.dry_run else "sync"
            print(f"[{tag}] {res['snapshots']} snapshot đơn: thêm"
                  f" {res['inserted']}, cập nhật {res['updated']}, không đổi"
                  f" {res['unchanged']}, giữ nguyên row không phải sàn"
                  f" {res['protected']}, bỏ dòng thiếu mã đơn"
                  f" {res['skipped']}"
                  + (" — KHÔNG ghi DB" if args.dry_run else ""))
            return 0
        rows = recon_rows(conn, since, until)
        conn.rollback()
        path = write_csv(rows, args.out_dir, since, until)
        n = {k: sum(1 for r in rows if r["label"] == k) for k in LABELS}
        print(f"[recon] {len(rows)} dòng ({', '.join(f'{k} {v}' for k, v in n.items())})"
              f" → {path.name} (BÁO CÁO cho kế toán — không bút toán)")
        return 0
    except (psycopg.Error, ValueError) as e:
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        print(f"[error] {type(e).__name__}: {_clean(msg, 300)}",
              file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[error] ghi file đối soát lỗi ({type(e).__name__})",
              file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_orders",
        description="KD-A6 — đơn sàn → orders lõi + file đối soát (không "
                    "gửi, không bút toán)")
    ap.add_argument("--sync", action="store_true",
                    help="đưa đơn sàn (market_rows) vào orders")
    ap.add_argument("--snapshot", type=int, help="chỉ snapshot ID này")
    ap.add_argument("--dry-run", action="store_true",
                    help="với --sync: chỉ đếm, không ghi")
    ap.add_argument("--recon", action="store_true",
                    help="xuất file đối soát doi-soat-<since>-<until>.csv")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--report", action="store_true",
                    help="(không hỗ trợ — dùng --recon)")
    args = ap.parse_args(argv)
    n_ops = sum([args.sync, args.recon, args.report])
    # v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader)
    # — chế độ thực từ chối login superuser/owner/thiếu biến.
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    if n_ops > 1:
        ap.error("chỉ được 1 thao tác mỗi lần (--sync | --recon)")
    if n_ops == 0 or args.report:
        ap.error("cần --sync hoặc --recon --since D --until D")
    if (args.snapshot is not None or args.dry_run) and not args.sync:
        ap.error("--snapshot/--dry-run chỉ đi với --sync")
    if args.snapshot is not None and args.snapshot <= 0:
        ap.error("--snapshot phải là số dương")
    since = until = None
    if args.recon:
        if not (args.since and args.until):
            ap.error("--recon cần --since và --until")
        since = _date(ap, args.since, "--since")
        until = _date(ap, args.until, "--until")
        if since > until:
            ap.error("--since phải ≤ --until")
    elif args.since or args.until:
        ap.error("--since/--until chỉ đi với --recon")
    if not args.sync or args.dry_run:
        return _main(args, since, until)
    with job_run(JOB) as r:
        rc = _main(args, since, until)
        r["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
