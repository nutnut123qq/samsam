"""v9.0 ACC-Invoice (WP12) — gom lô đơn sàn đạt mốc xuất hóa đơn của ngày D
→ file CSV NHÁP (format HĐĐT GIẢ ĐỊNH) + 1 mục `invoice_batch` vào hàng
duyệt chung (`approval_queue`, khối `finance`). Agent KHÔNG có chữ ký số,
KHÔNG phát hành, KHÔNG gửi, KHÔNG gọi API/mạng/LLM — kế toán nhập tay vào
phần mềm HĐĐT SAU KHI lô được duyệt và `--verify-draft` pass.

Ownership: ghi `invoice_lines` + 1 mục hàng duyệt (qua
`pipelines.director.submit` → `approval_queue.enqueue`, guardrail do module
đó tự tính); chỉ ĐỌC `market_snapshots`/`market_rows` (v3.3) và
`approval_queue`.

Cấu hình `data/invoice_config.json` (GIẢ ĐỊNH — `invoice_trigger` chờ tư
vấn thuế chốt hạn 25/10/2026, `confirmed_by: null`). Đơn = snapshot `order`
MỚI NHẤT mỗi kênh nạp trước hết ngày D (giờ VN). Phân loại (`build_batch`,
thuần):
  - `thuong`: trạng thái ∈ mốc, chưa thuộc lô pending/approved, không có
    yêu cầu xuất HĐ → người mua "Người mua không lấy hóa đơn".
  - `can_mst`: như trên + có yêu cầu kèm MST (file `--yeu-cau`, MST
    `^\\d{10}(-\\d{3})?$`, sai → lỗi dòng, cả file bị chặn TRƯỚC connect).
  - `dieu_chinh`: đơn đã thuộc lô APPROVED và nay ở `return_status`, chưa
    có dòng điều chỉnh ở lô pending/approved → `ref_batch_key` lô gốc.
  - Lô `rejected`/`expired` và dòng mồ côi (không có mục hàng) KHÔNG chặn
    → chạy lại sau khi bị từ chối sẽ gom lại các đơn đó.
Thông tin người mua (tên/MST/địa chỉ/email) CHỈ nằm trong file nháp
`data/reports/hoa-don-nhap/lo-<batch_key>.csv` (gitignored) — KHÔNG vào DB,
payload hàng duyệt, log hay stdout. Payload chỉ có hash rút gọn, kênh, số
tiền, cờ + `csv_sha256` của file.

`batch_key` = `<D>-<sha256(csv)[:12]>`; cột `lan_lap` (lần lập thứ n trong
ngày D) làm lô lập lại sau từ chối có khóa mới. Dòng lô + mục hàng ghi
CÙNG 1 transaction (enqueue lồng savepoint rồi commit) — không sinh dòng
mồ côi; `pg_try_advisory_lock` chặn 2 lần chạy song song.

Chạy:
  python -m agents.acc_invoice --batch [--day YYYY-MM-DD] [--yeu-cau F --channel K]
  python -m agents.acc_invoice --verify-draft QUEUE_ID --file F
Exit: 0 ok/skip · 1 file/cấu hình lỗi, đang chạy, verify fail · 2 tham số sai / DB down.
"""

import argparse
import csv
import hashlib
import io
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import MAP_FILE as MARKET_MAP_FILE
from ingest.market_csv import MAX_FILE_BYTES, MAX_PRINT_ERRS, _nfc, _TableError
from ingest.settlement_csv import CHANNELS, map_header, order_hash, read_table
from pipelines import approval_queue as aq
from pipelines import director
from pipelines.period import VN_TZ, period_bounds, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "invoice_config.json"
DRAFT_DIR = REPORTS_DIR / "hoa-don-nhap"
TRIGGERS = ("giao_thanh_cong", "ban_giao_van_chuyen")
KINDS = ("thuong", "can_mst", "dieu_chinh")
REQ_FIELDS = ("order_id", "buyer_name", "tax_code", "address", "email")
REQ_REQUIRED = ("order_id", "buyer_name", "tax_code")
REQ_MAXLEN = {"buyer_name": 200, "tax_code": 14, "address": 300,
              "email": 254}
CSV_FIELDS = ("lan_lap", "ma_tham_chieu", "ngay_lap", "kenh", "loai",
              "ten_nguoi_mua", "mst", "dia_chi", "email", "ten_hang",
              "so_luong", "don_gia", "thanh_tien", "lo_goc")
AGENT = "agent:acc_invoice"
LOCK_KEY = 9_000_001   # pg advisory lock — 1 lần --batch tại 1 thời điểm
# [0-9] ASCII + fullmatch: \d nhận chữ số Unicode, $ nhận trước xuống dòng.
_MST_RE = re.compile(r"[0-9]{10}(?:-[0-9]{3})?")
_SHA_LINE_RE = re.compile(r"^csv_sha256: ([0-9a-f]{64})$", re.MULTILINE)
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


# ---------- cấu hình ----------

def _str_list(v) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) and x.strip()
                                       for x in v)


def load_config(path: Path = CONFIG_FILE,
                market_map: Path = MARKET_MAP_FILE
                ) -> tuple[dict | None, str | None]:
    """Đọc + kiểm cấu hình; gộp `cancel_status` từ mapping market_csv."""
    try:
        cfg = json.loads(path.read_bytes().decode("utf-8"))
        mm = json.loads(market_map.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, f"không đọc được cấu hình hóa đơn: {type(e).__name__}"
    if not isinstance(cfg, dict) or cfg.get("invoice_trigger") not in TRIGGERS:
        return None, f"invoice_trigger phải thuộc {TRIGGERS}"
    cb = cfg.get("confirmed_by")
    if cb is not None and not (isinstance(cb, str) and cb.strip()):
        return None, "confirmed_by phải null hoặc tên người chốt"
    cancel = {}
    for ch in CHANNELS:
        ts = (cfg.get("trigger_status") or {}).get(ch)
        if not isinstance(ts, dict) or not all(_str_list(ts.get(t))
                                               for t in TRIGGERS):
            return None, f"trigger_status.{ch} thiếu mốc {TRIGGERS}"
        if not _str_list((cfg.get("return_status") or {}).get(ch)):
            return None, f"return_status.{ch} phải là list chuỗi"
        try:
            cancel[ch] = list(mm[ch]["order"]["cancel_status"])
        except (KeyError, TypeError):
            return None, f"market_csv_map thiếu {ch}/order/cancel_status"
    rc = cfg.get("request_columns")
    if not isinstance(rc, dict) or set(rc) != set(REQ_FIELDS) or not all(
            isinstance(v, str) and v.strip() for v in rc.values()):
        return None, f"request_columns phải đủ {REQ_FIELDS}"
    cols = cfg.get("csv_columns")
    if (not _str_list(cols) or not set(cols) <= set(CSV_FIELDS)
            or len(cols) != len(set(cols)) or "ma_tham_chieu" not in cols):
        return None, f"csv_columns phải ⊂ {CSV_FIELDS}, không trùng"
    if not isinstance(cfg.get("retail_buyer"), str) or not cfg[
            "retail_buyer"].strip():
        return None, "thiếu retail_buyer"
    return {**cfg, "cancel_status": cancel}, None


# ---------- file yêu cầu xuất hóa đơn (thuần) ----------

def read_yeu_cau(path: Path, channel: str, cfg: dict
                  ) -> tuple[dict, list[str]]:
    """→ ({(kênh, hash): {buyer_name, tax_code, address, email}}, lỗi).
    Lỗi chỉ nêu số dòng + tên field — KHÔNG giá trị ô (PII người mua)."""
    table, _sha, err = read_table(path)
    if err:
        return {}, [err]
    rc = cfg["request_columns"]
    try:
        first = next(table, None)
        if first is None:
            return {}, ["file rỗng"]
        col_of, errs = map_header(
            first[1], {f: rc[f] for f in REQ_REQUIRED},
            {f: rc[f] for f in REQ_FIELDS if f not in REQ_REQUIRED}, [],
            "yêu cầu xuất hóa đơn")
        if errs:
            return {}, errs
        width = len(first[1])
        out, seen = {}, {}
        for row_no, cells in table:
            if any(c is not None for c in cells[width:]):
                errs.append(f"dòng {row_no}: thừa ô ngoài header")
                continue
            rec = {f: (cells[j] if j < len(cells) else None)
                   for f, j in col_of.items()}
            bad = False
            for f in REQ_REQUIRED:
                if rec.get(f) is None:
                    errs.append(f"dòng {row_no}: thiếu field '{f}'")
                    bad = True
            for f, n in REQ_MAXLEN.items():
                if rec.get(f) is not None and len(rec[f]) > n:
                    errs.append(f"dòng {row_no}: field '{f}' dài quá {n}")
                    bad = True
            if rec.get("tax_code") is not None and not _MST_RE.fullmatch(
                    rec["tax_code"]):
                errs.append(f"dòng {row_no}: field 'tax_code' không phải MST"
                            " 10 hoặc 10-3 chữ số")
                bad = True
            if bad:
                continue
            key = (channel, order_hash(channel, rec["order_id"]))
            if key in seen:
                errs.append(f"dòng {row_no}: mã đơn trùng dòng {seen[key]}")
                continue
            seen[key] = row_no
            out[key] = {f: rec.get(f) for f in REQ_FIELDS if f != "order_id"}
    except _TableError as e:
        return {}, [str(e)]
    if not seen and not errs:
        return {}, ["file chỉ có header, không có dòng dữ liệu"]
    return ({} if errs else out), errs


# ---------- gom lô (thuần) ----------

def build_batch(orders: list[dict], yeu_cau: dict, invoiced: list[dict],
                cfg: dict, day: date) -> dict:
    """orders: [{channel, order_id_hash, status, amount_vnd, items}] (snapshot
    mới nhất mỗi kênh tới hết ngày D). yeu_cau: {(kênh, hash): buyer}.
    invoiced: dòng `invoice_lines` thuộc lô pending/approved [{channel,
    order_id_hash, kind, batch_key, status, amount_vnd}]. → lô (chưa có
    batch_key)."""
    trig = cfg["invoice_trigger"]
    billed, approved, adjusted = {}, {}, set()
    for r in invoiced:
        key = (r["channel"], r["order_id_hash"])
        if r["kind"] == "dieu_chinh":
            adjusted.add(key)
            continue
        billed[key] = r
        if r["status"] == "approved":
            approved[key] = r
    lines = []
    excluded = {"huy": 0, "chua_dat_moc": 0, "da_lap": 0}
    matched = set()
    for o in orders:
        ch, h = o["channel"], o["order_id_hash"]
        key = (ch, h)
        st = _nfc(o.get("status") or "")
        if key in billed:
            if (key in approved and key not in adjusted and st in
                    {_nfc(s) for s in cfg["return_status"][ch]}):
                # Người mua của HĐ điều chỉnh = người mua HĐ GỐC: không có
                # trong DB (cố ý) → chỉ lấy từ `--yeu-cau` nếu kế toán cấp
                # lại; không thì CSV ghi "THEO HĐ GỐC" (KHÔNG retail_buyer).
                buyer = yeu_cau.get(key)
                if buyer is not None:
                    matched.add(key)
                lines.append({**o, "kind": "dieu_chinh", "buyer": buyer,
                              "orig_kind": approved[key]["kind"],
                              "amount_vnd": approved[key]["amount_vnd"],
                              "ref_batch_key": approved[key]["batch_key"]})
            else:
                excluded["da_lap"] += 1
            continue
        if st in {_nfc(s) for s in cfg["cancel_status"][ch]}:
            excluded["huy"] += 1
            continue
        if st not in {_nfc(s) for s in cfg["trigger_status"][ch][trig]}:
            excluded["chua_dat_moc"] += 1
            continue
        buyer = yeu_cau.get(key)
        if buyer is not None:
            matched.add(key)
        lines.append({**o, "kind": "can_mst" if buyer else "thuong",
                      "buyer": buyer, "orig_kind": None,
                      "ref_batch_key": None})
    lines.sort(key=lambda x: (x["channel"], KINDS.index(x["kind"]),
                              x["order_id_hash"]))
    return {"day": day, "trigger": trig, "lines": lines,
            "excluded": excluded,
            "unmatched_yeu_cau": len(set(yeu_cau) - matched)}


def _cell_safe(v) -> str:
    """Ô CSV mở bằng Excel: chuỗi bắt đầu = + - @ → tiền tố ' (chống
    formula injection — tên hàng/người mua đến từ file ngoài)."""
    s = "" if v is None else str(v)
    return "'" + s if s.startswith(_FORMULA_START) else s


def _orig_marker(ln: dict) -> str:
    """Ô người mua của dòng điều chỉnh khi không có `--yeu-cau`: trỏ về HĐ
    gốc — KHÔNG ghi retail_buyer (gốc có thể là HĐ doanh nghiệp có MST)."""
    s = f"THEO HĐ GỐC lô {ln['ref_batch_key']}"
    if ln.get("orig_kind") == "can_mst":
        s += " — gốc cần MST: lấy tên/MST/địa chỉ từ HĐ gốc"
    return s


def render_csv(batch: dict, cfg: dict, attempt: int) -> bytes:
    """File NHÁP — 1 dòng / mặt hàng. Format GIẢ ĐỊNH (cột `csv_columns`).
    Dòng `dieu_chinh`: số tiền ghi DƯƠNG = giá trị điều chỉnh GIẢM theo HĐ
    gốc (quy ước dấu GIẢ ĐỊNH — chờ mẫu file nhập của NCC HĐĐT)."""
    cols = cfg["csv_columns"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for ln in batch["lines"]:
        b = ln["buyer"] or {}
        name = b.get("buyer_name")
        if name is None:
            name = (_orig_marker(ln) if ln["kind"] == "dieu_chinh"
                    else cfg["retail_buyer"])
        for it in ln["items"] or [{"title": None, "qty": None,
                                   "price_vnd": None}]:
            qty, price = it.get("qty"), it.get("price_vnd")
            rec = {"lan_lap": attempt, "ma_tham_chieu": ln["order_id_hash"],
                   "ngay_lap": batch["day"].isoformat(),
                   "kenh": ln["channel"], "loai": ln["kind"],
                   "ten_nguoi_mua": name,
                   "mst": b.get("tax_code"), "dia_chi": b.get("address"),
                   "email": b.get("email"), "ten_hang": it.get("title"),
                   "so_luong": qty, "don_gia": price,
                   "thanh_tien": (qty * price if qty is not None
                                  and price is not None else None),
                   "lo_goc": ln["ref_batch_key"]}
            w.writerow([_cell_safe(rec[c]) for c in cols])
    return buf.getvalue().encode("utf-8")


def _vnd(n: int) -> str:
    return f"{int(n):,}".replace(",", ".") + "đ"


def render_payload(batch: dict, batch_key: str, csv_sha: str, cfg: dict,
                   attempt: int) -> tuple[str, str]:
    """→ (title, payload markdown) — KHÔNG thông tin người mua."""
    ls = batch["lines"]
    n = {k: sum(1 for x in ls if x["kind"] == k) for k in KINDS}
    ex = batch["excluded"]
    who = cfg.get("confirmed_by")
    L = [f"# Lô hóa đơn NHÁP {batch['day']:%d/%m/%Y} — `{batch_key}`", "",
         f"- Mốc lập hóa đơn: `{batch['trigger']}` — "
         + (f"đã chốt bởi {who}" if who else
            "GIẢ ĐỊNH, chưa tư vấn thuế chốt (hạn 25/10/2026)"),
         f"- Lần lập trong ngày: {attempt}",
         (f"- Số dòng: {len(ls)} (thường {n['thuong']} · cần MST "
          f"{n['can_mst']} · điều chỉnh {n['dieu_chinh']}) — tổng "
          f"{_vnd(sum(x['amount_vnd'] for x in ls))}"),
         (f"- Loại khỏi lô: đơn hủy {ex['huy']} · chưa đạt mốc "
          f"{ex['chua_dat_moc']} · đã lập ở lô khác {ex['da_lap']}"), "",
         "## Dòng (mã tham chiếu rút gọn 8 ký tự)", ""]
    for x in ls:
        flag = {"thuong": "", "can_mst": " — cần MST",
                "dieu_chinh": f" — điều chỉnh — lô gốc `{x['ref_batch_key']}`"
                }[x["kind"]]
        if x["kind"] == "dieu_chinh":
            if x.get("orig_kind") == "can_mst":
                flag += " — gốc cần MST"
            flag += (" — người mua theo file yêu cầu" if x["buyer"]
                     else " — người mua THEO HĐ GỐC")
        L.append(f"- `{x['order_id_hash'][:8]}` {x['channel']} "
                 f"{_vnd(x['amount_vnd'])}{flag}")
    if n["dieu_chinh"]:
        L += ["", ("Dòng điều chỉnh: số tiền ghi DƯƠNG = giá trị điều chỉnh "
                   "GIẢM theo HĐ gốc (quy ước dấu GIẢ ĐỊNH — chờ mẫu file "
                   "nhập của nhà cung cấp HĐĐT); người mua lấy đúng như HĐ "
                   "gốc.")]
    L += ["", f"csv_sha256: {csv_sha}", "",
          ("BẢN NHÁP — agent không ký số, không phát hành, không gửi. Kế "
           "toán chạy `python -m agents.acc_invoice --verify-draft <id> "
           "--file <file nháp>` trước khi nhập tay vào phần mềm HĐĐT."), ""]
    title = f"Lô hóa đơn NHÁP {batch['day']:%Y-%m-%d} ({len(ls)} dòng)"
    return title, "\n".join(L)


# ---------- DB ----------

def fetch_orders(conn, day: date) -> list[dict]:
    """Đơn từ snapshot `order` MỚI NHẤT mỗi kênh nạp trước hết ngày D (VN)."""
    _start, end = period_bounds("day", day)
    snaps = conn.execute(
        "select distinct on (channel) id, channel from market_snapshots"
        " where export_kind = 'order' and imported_at < %s order by"
        " channel, imported_at desc, id desc", (end,)).fetchall()
    out: dict = {}
    for sid, ch in snaps:
        for h, st, title, qty, price in conn.execute(
                "select order_id_hash, status, title, qty, price_vnd from"
                " market_rows where snapshot_id = %s and order_id_hash is not"
                " null order by row_no", (sid,)).fetchall():
            o = out.setdefault((ch, h), {"channel": ch, "order_id_hash": h,
                                         "status": st, "amount_vnd": 0,
                                         "items": []})
            o["amount_vnd"] += (price or 0) * (qty or 0)
            o["items"].append({"title": title, "qty": qty,
                               "price_vnd": price})
    return list(out.values())


def fetch_invoiced(conn) -> list[dict]:
    cols = ("channel", "order_id_hash", "kind", "batch_key", "status",
            "amount_vnd")
    return [dict(zip(cols, r)) for r in conn.execute(
        "select l.channel, l.order_id_hash, l.kind, l.batch_key, q.status,"
        " l.amount_vnd from invoice_lines l join approval_queue q on"
        " q.object_type = 'invoice_batch' and q.object_id = l.batch_key"
        " where q.status in ('pending', 'approved') order by l.id")]


def _day_like(day: date) -> str:
    return f"{day.isoformat()}-%"


def run_batch(conn, day: date, cfg: dict, yeu_cau: dict | None = None,
              out_dir: Path | None = None, dcfg: dict | None = None) -> dict:
    """→ {"status": locked|skip|empty|ok, ...}. Ghi file nháp SAU commit."""
    if not conn.execute("select pg_try_advisory_lock(%s)",
                        (LOCK_KEY,)).fetchone()[0]:
        conn.rollback()
        return {"status": "locked"}
    try:
        return _run_locked(conn, day, cfg, yeu_cau or {},
                           out_dir or DRAFT_DIR, dcfg)
    except BaseException:
        conn.rollback()
        raise
    finally:
        with suppress(psycopg.Error):
            conn.execute("select pg_advisory_unlock(%s)", (LOCK_KEY,))
            conn.commit()


def _run_locked(conn, day, cfg, yeu_cau, out_dir, dcfg) -> dict:
    like = _day_like(day)
    pend = conn.execute(
        "select id from approval_queue where object_type = 'invoice_batch'"
        " and status = 'pending' and object_id like %s order by id limit 1",
        (like,)).fetchone()
    if pend:
        return {"status": "skip", "queue_id": pend[0]}
    batch = build_batch(fetch_orders(conn, day), yeu_cau,
                        fetch_invoiced(conn), cfg, day)
    if not batch["lines"]:
        return {"status": "empty", "batch": batch}
    attempt = 1 + conn.execute(
        "select count(*) from approval_queue where object_type ="
        " 'invoice_batch' and object_id like %s", (like,)).fetchone()[0]
    data = render_csv(batch, cfg, attempt)
    csv_sha = hashlib.sha256(data).hexdigest()
    batch_key = f"{day.isoformat()}-{csv_sha[:12]}"
    with conn.cursor() as cur:
        cur.executemany(
            "insert into invoice_lines (batch_key, batch_date, channel,"
            " order_id_hash, kind, amount_vnd, ref_batch_key) values (%s, %s,"
            " %s, %s, %s, %s, %s)",
            [(batch_key, day, x["channel"], x["order_id_hash"], x["kind"],
              x["amount_vnd"], x["ref_batch_key"]) for x in batch["lines"]])
    title, payload = render_payload(batch, batch_key, csv_sha, cfg, attempt)
    # enqueue: savepoint trong tx đang mở rồi conn.commit() → dòng lô + mục
    # hàng duyệt commit CÙNG lúc (không dòng mồ côi).
    qid = director.submit(conn, "finance", "invoice_batch", batch_key, title,
                          payload, created_by=AGENT, cfg=dcfg)
    # write_report ghi str.encode("utf-8") nguyên byte (không đổi CRLF của
    # csv) → sha file == csv_sha256.
    path = write_report(data.decode("utf-8"), out_dir, f"lo-{batch_key}.csv")
    return {"status": "ok", "queue_id": qid, "batch_key": batch_key,
            "batch": batch, "path": path, "csv_sha256": csv_sha,
            "attempt": attempt}


def verify_draft(conn, queue_id: int, path: Path) -> tuple[bool, str]:
    """Mục `invoice_batch` ĐÃ DUYỆT + payload đúng bản đã duyệt + sha256
    file == `csv_sha256` trong payload → (True, ..). Ngược lại fail-closed."""
    row = conn.execute(
        "select object_type, block, status, payload from approval_queue"
        " where id = %s", (queue_id,)).fetchone()
    if row is None:
        return False, f"không thấy mục #{queue_id}"
    otype, block, status, payload = row
    if otype != "invoice_batch" or block != "finance":
        return False, f"mục #{queue_id} không phải lô hóa đơn khối finance"
    if status != "approved":
        return False, f"mục #{queue_id} đang '{status}' — chưa được duyệt"
    if not aq.verify(conn, queue_id, payload):
        return False, f"mục #{queue_id}: payload lệch bản đã duyệt"
    m = _SHA_LINE_RE.search(payload)
    if not m:
        return False, f"mục #{queue_id}: payload thiếu csv_sha256"
    try:
        if Path(path).stat().st_size > MAX_FILE_BYTES:
            return False, "file quá lớn"
        got = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError as e:
        return False, f"không đọc được file: {type(e).__name__}"
    if got != m[1]:
        return False, "file nháp KHÁC bản đã duyệt (sha256 lệch) — không nhập"
    return True, f"mục #{queue_id} đã duyệt, file khớp csv_sha256"


# ---------- CLI ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.acc_invoice",
        description="ACC-Invoice: lô hóa đơn NHÁP → hàng duyệt (không ký "
                    "số, không phát hành, không gửi)")
    ap.add_argument("--batch", action="store_true",
                    help="gom lô ngày D vào hàng duyệt")
    ap.add_argument("--day", help="ngày lô YYYY-MM-DD (mặc định hôm nay VN)")
    ap.add_argument("--yeu-cau", type=Path,
                    help="file yêu cầu xuất hóa đơn (cần --channel)")
    ap.add_argument("--channel", choices=CHANNELS)
    ap.add_argument("--verify-draft", type=int, metavar="QUEUE_ID")
    ap.add_argument("--file", type=Path, help="file nháp cần kiểm")
    args = ap.parse_args(argv)

    n_ops = int(args.batch) + (args.verify_draft is not None)
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--batch | --verify-draft)")
    if n_ops == 0:
        ap.error("cần --batch hoặc --verify-draft QUEUE_ID --file F")
    if (args.verify_draft is not None) != (args.file is not None):
        ap.error("--verify-draft và --file đi cùng nhau")
    if (args.yeu_cau is not None) != (args.channel is not None):
        ap.error("--yeu-cau và --channel đi cùng nhau")
    if args.verify_draft is not None and (args.day or args.yeu_cau):
        ap.error("--day/--yeu-cau chỉ dùng với --batch")
    day = None
    if args.batch:
        try:
            day = (date.fromisoformat(args.day) if args.day
                   else vn_date(datetime.now(VN_TZ)))
        except ValueError:
            ap.error("--day phải dạng YYYY-MM-DD")

    cfg = yeu_cau = None
    if args.batch:
        cfg, why = load_config()
        if cfg is None:
            print(f"[err] {why} — không connect.", flush=True)
            return 1
        yeu_cau = {}
        if args.yeu_cau is not None:
            yeu_cau, errs = read_yeu_cau(args.yeu_cau, args.channel, cfg)
            if errs:
                for e in errs[:MAX_PRINT_ERRS]:
                    print(f"[err] {e}", flush=True)
                print(f"[err] {len(errs)} lỗi file yêu cầu — không connect,"
                      " không ghi gì.", flush=True)
                return 1

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.verify_draft is not None:
            ok, msg = verify_draft(conn, args.verify_draft, args.file)
            print(f"[{'ok' if ok else 'fail'}] {msg}")
            return 0 if ok else 1
        res = run_batch(conn, day, cfg, yeu_cau)
    except (psycopg.Error, director.DirectorConfigError, ValueError) as e:
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        print(f"[error] {type(e).__name__}: {msg}", file=sys.stderr)
        return 1
    except OSError as e:
        # lô đã vào hàng nhưng ghi file nháp lỗi → không có bản để nhập
        print(f"[error] ghi file nháp lỗi ({type(e).__name__}) — lô đã vào"
              " hàng duyệt: TỪ CHỐI mục đó rồi chạy lại --batch",
              file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    st = res["status"]
    if st == "locked":
        print("[err] đang có 1 lần --batch khác chạy (advisory lock) — thử "
              "lại sau.")
        return 1
    if st == "skip":
        print(f"[skip] ngày {day} đã có lô chờ duyệt #{res['queue_id']} — "
              "duyệt/từ chối xong mới lập lô mới.")
        return 0
    ex = res["batch"]["excluded"]
    if st == "empty":
        print(f"[ok] {day}: không có đơn cần lập hóa đơn (hủy {ex['huy']}, "
              f"chưa đạt mốc {ex['chua_dat_moc']}, đã lập {ex['da_lap']}) "
              "— 0 mục vào hàng.")
        return 0
    ls = res["batch"]["lines"]
    n = {k: sum(1 for x in ls if x["kind"] == k) for k in KINDS}
    print(f"[ok] lô {res['batch_key']}: {len(ls)} dòng (thường {n['thuong']},"
          f" cần MST {n['can_mst']}, điều chỉnh {n['dieu_chinh']}); loại: hủy "
          f"{ex['huy']}, chưa đạt mốc {ex['chua_dat_moc']}, đã lập "
          f"{ex['da_lap']} → hàng duyệt #{res['queue_id']} (finance, chờ "
          "người duyệt)")
    if res["batch"]["unmatched_yeu_cau"]:
        print(f"[warn] {res['batch']['unmatched_yeu_cau']} yêu cầu xuất HĐ "
              "không khớp đơn nào trong lô")
    print(f"[file] nháp: {res['path'].name} (thư mục hoa-don-nhap,"
          " gitignored — chứa thông tin người mua, KHÔNG gửi đi)")
    print("[done] BẢN NHÁP — agent không ký số, không phát hành.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
