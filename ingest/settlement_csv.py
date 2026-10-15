"""v9.0 ACC-Recon (WP12) — nạp file quyết toán (income/settlement) kế toán
xuất TAY từ Seller Center Shopee / TikTok Shop, đối chiếu từng đơn với đơn
sàn đã nạp (`market_rows` export `order`, v3.3) + biểu phí cấu hình → MỖI
dòng đúng 1 nhãn. Chỉ BÁO CÁO — không ghi sổ, không bút toán, không LLM.

Ownership: ghi DUY NHẤT `settlement_rows` + `recon_results`; chỉ ĐỌC
`market_rows`. Không gọi sàn, không gọi mạng.

Contract nạp (`python -m ingest.settlement_csv --file F --channel K`):
  - Kiểm TOÀN file + mapping (`data/settlement_map.json`, GIẢ ĐỊNH) + biểu
    phí (`data/settlement_fees.json`, GIẢ ĐỊNH) TRƯỚC khi connect — đọc
    bảng/ô/số qua `ingest.market_csv` (`_table`, `_cell`, `_to_int`, trần
    byte/dòng/cột). Lỗi → in số dòng + tên field (KHÔNG giá trị ô), exit 1,
    0 connect, 0 dòng.
  - `file_sha256` đã có → `[skip]` exit 0. Mới → 1 transaction: insert
    rows + đối chiếu → `conn.commit()`.
  - Dấu số tiền: `fees_negative: true` ⇒ cột khấu trừ (phí, ship, voucher,
    affiliate, hoàn) đổi dấu → khoản trừ DƯƠNG; giá trị dương trên file =
    sàn bù (âm sau chuẩn hóa, không đoán). `refund` âm sau chuẩn hóa /
    `order_amount` âm → lỗi dòng. Mã đơn → `order_id_hash` = sha256(
    "kênh:mã")[:16] — CÙNG công thức `market_csv` (test khóa parity).
  - `txn_type` (loại giao dịch — tùy chọn, v13.2): có cột → 1 dòng / (đơn,
    loại) trong 1 file (đơn + điều chỉnh/hoàn cùng mã là hợp lệ); không có
    cột → GIẢ ĐỊNH 1 dòng/đơn như cũ.

Chồng kỳ (v13.2, F01): cùng khoản xuất lại ở file khác (khác sha256) KHÔNG
bị chặn lúc nạp (giữ dữ liệu thô + nguồn) nhưng: số doanh thu mọi caller đọc
view `v_settlement_khoan` (1 dòng / khoản trùng nguyên văn); `overlaps()`
báo nhóm (kênh, đơn, loại) ở ≥2 file — `trung` (nguyên văn, đã tính 1 lần)
/ `lech` (số khác: KHÔNG tự chọn file nào, giữ cả hai) → `agents.rev_share`
gắn BẤT THƯỜNG, không tính phí, tới khi người đối soát giải quyết.

Đối chiếu (`reconcile_row`, thuần): expected = giá trị đơn − mọi khoản trừ
− hoàn. Lý do `{code, expected, actual}`: `thuc_nhan` (|payout − expected|
> tolerance), `phi_co_dinh`/`phi_thanh_toan`/`phi_dich_vu` (phí file lệch
round_half_up(giá trị × pct) quá tolerance — sàn thu sai), `gia_tri_don`
(giá trị file ≠ tổng `price_vnd × qty` của đơn sàn, snapshot MỚI NHẤT chứa
mã đơn). Nhãn ưu tiên: không thấy đơn → `thieu_chung_tu` > hoàn > 0 →
`hoan` > có lý do → `lech` > `khop`.

CLI: `--file F --channel K` | `--reconcile` (tính lại MỌI dòng — khi file
đơn tới sau) | `--report` (theo kênh; trỏ dòng bằng `file dòng N`, không in
mã đơn/hash/người mua). Exit 0 ok · 1 file/cấu hình/DB lỗi · 2 tham số sai.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

from ingest.market_csv import (
    MAX_FILE_BYTES,
    MAX_PRINT_ERRS,
    _clean,
    _nfc,
    _safe,
    _table,
    _TableError,
    _to_int,
)

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAP_FILE = ROOT / "data" / "settlement_map.json"
FEES_FILE = ROOT / "data" / "settlement_fees.json"

CHANNELS = ("shopee", "tiktok")
FIELDS = ("order_id", "order_amount", "fixed_fee", "payment_fee",
          "service_fee", "shipping_fee", "voucher_seller", "affiliate",
          "refund", "payout", "settled_on", "txn_type")
TXN_TYPE_MAX = 64
MUST = ("order_id", "order_amount", "payout")
# Khoản KHẤU TRỪ (đổi dấu khi fees_negative) — thứ tự = cột DB.
DEDUCT = ("fixed_fee", "payment_fee", "service_fee", "shipping_fee",
          "voucher_seller", "affiliate", "refund")
MONEY = ("order_amount", *DEDUCT, "payout")
MONEY_CAP = 10**15
# (mã lý do, field phí, khóa pct trong biểu phí)
FEE_CHECKS = (("phi_co_dinh", "fixed_fee", "fixed_fee_pct"),
              ("phi_thanh_toan", "payment_fee", "payment_fee_pct"),
              ("phi_dich_vu", "service_fee", "service_fee_pct"))
LABELS = ("khop", "lech", "thieu_chung_tu", "hoan")
MAX_REPORT_LINES = 200
_DMY_RE = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})")
_YMD_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]00:00(?::00)?)?")


# ---------- đọc số / ngày / header (dùng chung acc_invoice, acc_ar) ----------

def order_hash(channel: str, order_id: str) -> str:
    """Hash mã đơn — PHẢI giống `market_csv._parse` (test parity)."""
    return hashlib.sha256(f"{channel}:{order_id}".encode()).hexdigest()[:16]


def _to_signed(s: str | None, cap: int = MONEY_CAP) -> int | None:
    """Số nguyên VND có dấu `-` đầu tùy chọn; phần số theo
    `market_csv._to_int` (nhóm nghìn, bỏ ₫/VND). Sai → None."""
    if s is None:
        return None
    s = s.strip()
    neg = s.startswith("-")
    n = _to_int(s[1:] if neg else s, cap)
    if n is None:
        return None
    return -n if neg else n


def _to_date(s: str | None) -> date | None:
    """`YYYY-MM-DD` (xlsx datetime 00:00 cũng nhận) hoặc `DD/MM/YYYY`."""
    if s is None:
        return None
    s = s.strip()
    try:
        m = _YMD_RE.fullmatch(s)
        if m:
            return date(int(m[1]), int(m[2]), int(m[3]))
        m = _DMY_RE.fullmatch(s)
        if m:
            return date(int(m[3]), int(m[2]), int(m[1]))
    except ValueError:
        return None
    return None


def map_header(header: list, required: dict, optional: dict, drop,
               ctx: str) -> tuple[dict, list[str]]:
    """Header file → ({field: chỉ số cột}, lỗi). Header trống/trùng/lạ,
    thiếu cột bắt buộc → lỗi; header lạ in qua `_safe` (che SĐT/email)."""
    header = [None if h is None else _nfc(h) for h in header]
    want = {**{f: _nfc(h) for f, h in optional.items()},
            **{f: _nfc(h) for f, h in required.items()}}
    by_header = {h: f for f, h in want.items()}
    drop = {_nfc(h) for h in drop}
    col_of, errs, seen = {}, [], set()
    for j, h in enumerate(header):
        if h is None:
            errs.append(f"header cột {j + 1} trống")
            continue
        if h in seen:
            errs.append(f"header trùng: '{_safe(h)}'")
            continue
        seen.add(h)
        if h in by_header:
            col_of[by_header[h]] = j
        elif h not in drop:
            errs.append(f"cột lạ '{_safe(h)}' (không thuộc required/optional/"
                        "drop — thêm vào mapping sau khi xác minh)")
    missing = [h for f, h in required.items() if f not in col_of]
    if missing and len(missing) == len(required):
        # dòng đầu nhiều khả năng là DỮ LIỆU — không in ô (có thể là PII)
        return {}, [(f"dòng đầu không khớp header {ctx} ({len(header)} cột,"
                     f" 0/{len(required)} cột bắt buộc) — sai kênh/loại "
                     "file hoặc thiếu dòng header")]
    if missing:
        errs.append("thiếu cột bắt buộc: " + ", ".join(
            f"'{_nfc(h)}'" for h in missing))
    return col_of, errs


def read_table(path: Path):
    """→ (iterator `_table` | None, sha, lỗi | None) — đuôi/trần byte/rỗng."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in (".csv", ".xlsx"):
        return None, None, f"đuôi '{suffix}' không hỗ trợ — chỉ .csv / .xlsx"
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None, None, f"file > {MAX_FILE_BYTES // 2**20}MB — tách file"
        data = path.read_bytes()
    except OSError as e:
        return None, None, f"không đọc được file: {type(e).__name__}"
    sha = hashlib.sha256(data).hexdigest()
    if not data or data.isspace():
        return None, sha, "file rỗng"
    return _table(data, suffix), sha, None


# ---------- cấu hình ----------

def _load_json(path: Path):
    try:
        return json.loads(path.read_bytes().decode("utf-8")), None
    except (OSError, ValueError) as e:
        return None, f"không đọc được {path.name}: {type(e).__name__}"


def load_mapping(path: Path = MAP_FILE) -> tuple[dict | None, str | None]:
    m, why = _load_json(path)
    if m is None:
        return None, why
    for ch in CHANNELS:
        spec = m.get(ch) if isinstance(m, dict) else None
        if not isinstance(spec, dict) or not isinstance(
                spec.get("required"), dict):
            return None, f"{path.name}: thiếu kênh {ch}/required"
        fields = [*spec["required"], *spec.get("optional", {})]
        if not set(fields) <= set(FIELDS) or len(fields) != len(set(fields)):
            return None, f"{path.name}/{ch}: field lạ hoặc trùng"
        if not set(MUST) <= set(spec["required"]):
            return None, f"{path.name}/{ch}: required phải có {MUST}"
        if not isinstance(spec.get("fees_negative"), bool):
            return None, f"{path.name}/{ch}: fees_negative phải là bool"
    return m, None


def load_fees(path: Path = FEES_FILE) -> tuple[dict | None, str | None]:
    """→ ({kênh: {pct Decimal..., tolerance_vnd int}}, None) | (None, lỗi)."""
    raw, why = _load_json(path)
    if raw is None:
        return None, why
    out = {}
    for ch in CHANNELS:
        spec = raw.get(ch) if isinstance(raw, dict) else None
        if not isinstance(spec, dict):
            return None, f"{path.name}: thiếu kênh {ch}"
        cfg = {}
        for _code, _f, key in FEE_CHECKS:
            v = spec.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                return None, f"{path.name}/{ch}.{key}: phải là số"
            d = Decimal(str(v))
            if not Decimal(0) <= d <= Decimal("0.5"):
                return None, f"{path.name}/{ch}.{key}: ngoài 0..0.5"
            cfg[key] = d
        t = spec.get("tolerance_vnd")
        if isinstance(t, bool) or not isinstance(t, int) or not 0 <= t <= 100_000:
            return None, f"{path.name}/{ch}.tolerance_vnd: phải int 0..100000"
        cfg["tolerance_vnd"] = t
        out[ch] = cfg
    return out, None


# ---------- parse (thuần) ----------

def read_settlement(path: Path, channel: str, mapping: dict
                    ) -> tuple[list[dict], list[str], str | None]:
    """Hàm thuần: → (rows, errors, sha256 file). errors ≠ [] → rows = [].
    Mỗi row CHỈ có field chuẩn (trừ order_id) + `row_no` + `order_id_hash`
    (+ `txn_type` str | None)."""
    spec = mapping.get(channel) if isinstance(mapping, dict) else None
    if not isinstance(spec, dict) or not isinstance(spec.get("required"),
                                                    dict):
        return [], [f"mapping thiếu kênh {channel}"], None
    table, sha, err = read_table(path)
    if err:
        return [], [err], sha
    try:
        rows, errs = _parse(table, channel, spec)
    except _TableError as e:
        return [], [str(e)], sha
    return (rows if not errs else []), errs, sha


def _parse(table, channel: str, spec: dict) -> tuple[list[dict], list[str]]:
    first = next(table, None)
    if first is None:
        return [], ["file rỗng"]
    _hdr_no, header = first
    col_of, errs = map_header(header, spec["required"],
                              spec.get("optional", {}), spec.get("drop", []),
                              f"quyết toán {channel}")
    if errs:
        return [], errs
    flip = spec["fees_negative"]
    width = len(header)
    rows, seen = [], {}
    n_body = 0
    for row_no, cells in table:
        n_body += 1
        if any(c is not None for c in cells[width:]):
            errs.append(f"dòng {row_no}: thừa ô ngoài header")
            continue
        rec = {f: (cells[j] if j < len(cells) else None)
               for f, j in col_of.items()}
        out = {"row_no": row_no}
        bad = False
        tt = rec.get("txn_type")
        tt = _nfc(tt).strip() if tt is not None else ""
        tt = tt or None
        if tt is not None and len(tt) > TXN_TYPE_MAX:
            errs.append(f"dòng {row_no}: field 'txn_type' dài quá "
                        f"{TXN_TYPE_MAX} ký tự")
            bad = True
        out["txn_type"] = tt
        oid = rec.get("order_id")
        if oid is None:
            errs.append(f"dòng {row_no}: thiếu mã đơn")
            bad = True
        else:
            h = order_hash(channel, oid)
            if (h, tt) in seen:
                errs.append(f"dòng {row_no}: mã đơn trùng dòng "
                            f"{seen[(h, tt)]} (GIẢ ĐỊNH 1 dòng/"
                            + ("đơn/loại giao dịch)" if "txn_type" in col_of
                               else "đơn)"))
                bad = True
            seen.setdefault((h, tt), row_no)
            out["order_id_hash"] = h
        for f in MONEY:
            v = rec.get(f)
            if v is None and f not in spec["required"]:
                out[f] = 0
                continue
            n = _to_signed(v)
            if n is None:
                errs.append(f"dòng {row_no}: field '{f}' không phải số "
                            "nguyên VND hợp lệ")
                bad = True
                continue
            if flip and f in DEDUCT:
                n = -n
            out[f] = n
        if not bad and out["order_amount"] < 0:
            errs.append(f"dòng {row_no}: field 'order_amount' âm")
            bad = True
        if not bad and out["refund"] < 0:
            errs.append(f"dòng {row_no}: field 'refund' âm sau chuẩn hóa dấu")
            bad = True
        v = rec.get("settled_on")
        out["settled_on"] = _to_date(v)
        if v is not None and out["settled_on"] is None:
            errs.append(f"dòng {row_no}: field 'settled_on' không phải ngày "
                        "YYYY-MM-DD / DD/MM/YYYY")
            bad = True
        if not bad:
            rows.append(out)
    if not n_body:
        return [], ["file chỉ có header, không có dòng dữ liệu"]
    return rows, errs


# ---------- đối chiếu (thuần) ----------

def round_half_up(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def reconcile_row(row: dict, order_amount: int | None, fees: dict
                  ) -> tuple[str, list[dict], int]:
    """→ (nhãn, lý do, thực nhận tính lại). `row` theo field chuẩn (đã
    chuẩn hóa dấu), `order_amount` = tổng đơn sàn (None = không thấy đơn),
    `fees` = biểu phí 1 kênh từ `load_fees`."""
    tol = fees["tolerance_vnd"]
    amt = row["order_amount"]
    expected = amt - sum(row[f] for f in DEDUCT)
    reasons = []
    if abs(row["payout"] - expected) > tol:
        reasons.append({"code": "thuc_nhan", "expected": expected,
                        "actual": row["payout"]})
    for code, f, key in FEE_CHECKS:
        exp_fee = round_half_up(Decimal(amt) * fees[key])
        if abs(row[f] - exp_fee) > tol:
            reasons.append({"code": code, "expected": exp_fee,
                            "actual": row[f]})
    if order_amount is not None and amt != order_amount:
        reasons.append({"code": "gia_tri_don", "expected": order_amount,
                        "actual": amt})
    if order_amount is None:
        label = "thieu_chung_tu"
    elif row["refund"] > 0:
        label = "hoan"
    elif reasons:
        label = "lech"
    else:
        label = "khop"
    return label, reasons, expected


# ---------- DB ----------

_COLS = ("order_amount", "fixed_fee", "payment_fee", "service_fee",
         "shipping_fee", "voucher_seller", "affiliate", "refund", "payout")


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def load(conn, rows: list[dict], channel: str, file_name: str,
         sha: str) -> int:
    """Insert `settlement_rows` (không commit) → số dòng."""
    with conn.cursor() as cur:
        cur.executemany(
            "insert into settlement_rows (file_sha256, file_name, channel,"
            " row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd,"
            " payment_fee_vnd, service_fee_vnd, shipping_fee_vnd,"
            " voucher_seller_vnd, affiliate_vnd, refund_vnd, payout_vnd,"
            " settled_on, txn_type) values (%s, %s, %s, %s, %s, %s, %s, %s,"
            " %s, %s, %s, %s, %s, %s, %s, %s)",
            [(sha, file_name, channel, r["row_no"], r["order_id_hash"],
              *(r[c] for c in _COLS), r["settled_on"], r.get("txn_type"))
             for r in rows])
    return len(rows)


# Nhóm (kênh, đơn, loại giao dịch) có dòng ở ≥2 file quyết toán. Số bộ giá
# trị khác nhau = 1 → trùng nguyên văn. Khung kỳ: nhóm có ÍT NHẤT 1 dòng
# `settled_on` trong [start, end) — start NULL = mọi kỳ.
_OVERLAP_SQL = (
    "select channel, count(distinct (settled_on, "
    + ", ".join(f"{c}_vnd" for c in _COLS)
    + ")), array_agg(distinct file_name) from settlement_rows where channel"
    " = any(%(ch)s) group by channel, order_id_hash, txn_type having"
    " count(distinct file_sha256) >= 2 and (%(s)s::date is null or"
    " bool_or(settled_on >= %(s)s::date and settled_on < %(e)s::date))"
    " order by 1")


def overlaps(conn, channels, start: date | None = None,
             end: date | None = None) -> dict:
    """Khoản quyết toán xuất lại ở ≥2 file → {kênh: {"trung": số nhóm
    trùng nguyên văn (view `v_settlement_khoan` đã tính 1 lần), "lech": số
    nhóm có số khác nhau (giữ cả hai — người đối soát quyết), "files": [tên
    file]}}; kênh không có → vắng. CHỈ SELECT, không mã đơn/hash."""
    out: dict = {}
    for ch, n_var, files in conn.execute(
            _OVERLAP_SQL, {"ch": list(channels), "s": start, "e": end}):
        o = out.setdefault(ch, {"trung": 0, "lech": 0, "files": set()})
        o["trung" if n_var <= 1 else "lech"] += 1
        o["files"].update(files)
    for o in out.values():
        o["files"] = sorted(o["files"])
    return out


# Tổng đơn sàn theo (kênh, hash): snapshot `order` MỚI NHẤT có chứa hash.
_ORDER_SQL = (
    "with latest as (select distinct on (channel, order_id_hash) channel,"
    " order_id_hash, snapshot_id from market_rows where export_kind ="
    " 'order' and order_id_hash = any(%s) order by channel, order_id_hash,"
    " snapshot_id desc) select l.channel, l.order_id_hash,"
    " sum(coalesce(m.price_vnd, 0) * coalesce(m.qty, 0)) from latest l"
    " join market_rows m on m.snapshot_id = l.snapshot_id and m.channel ="
    " l.channel and m.order_id_hash = l.order_id_hash and m.export_kind ="
    " 'order' group by 1, 2")


def reconcile(conn, fees: dict, sha: str | None = None) -> dict:
    """Đối chiếu (upsert `recon_results`, không commit) các dòng của file
    `sha` — None = MỌI dòng. → {nhãn: số dòng}."""
    sql = ("select id, channel, order_id_hash, " + ", ".join(
        f"{c}_vnd" for c in _COLS) + " from settlement_rows")
    rows = conn.execute(sql + (" where file_sha256 = %s" if sha else "")
                        + " order by id", (sha,) if sha else ()).fetchall()
    counts = dict.fromkeys(LABELS, 0)
    if not rows:
        return counts
    hashes = sorted({r[2] for r in rows})
    orders = {(ch, h): int(t) for ch, h, t in conn.execute(
        _ORDER_SQL, (hashes,)).fetchall()}
    params = []
    for sid, ch, h, *money in rows:
        rec = dict(zip(_COLS, money))
        amt = orders.get((ch, h))
        label, reasons, expected = reconcile_row(rec, amt, fees[ch])
        counts[label] += 1
        params.append((sid, label, Jsonb(reasons), expected, amt))
    with conn.cursor() as cur:
        cur.executemany(
            "insert into recon_results (settlement_row_id, label, reasons,"
            " expected_payout_vnd, order_amount_vnd) values (%s, %s, %s, %s,"
            " %s) on conflict (settlement_row_id) do update set label ="
            " excluded.label, reasons = excluded.reasons,"
            " expected_payout_vnd = excluded.expected_payout_vnd,"
            " order_amount_vnd = excluded.order_amount_vnd,"
            " reconciled_at = now()", params)
    return counts


def _vnd(n) -> str:
    return f"{int(n):,}".replace(",", ".") + "đ"


def report(conn) -> None:
    """Theo kênh: số dòng mỗi nhãn, tổng thực nhận file / tính lại / chênh,
    affiliate sàn khấu trừ, đơn ở ≥2 file; liệt kê dòng lệch/thiếu/hoàn
    bằng `file dòng N` (không mã đơn/hash/người mua)."""
    print("[report] đối soát quyết toán sàn — CHỈ BÁO CÁO, không bút toán:")
    for ch in CHANNELS:
        by = dict(conn.execute(
            "select r.label, count(*) from settlement_rows s join"
            " recon_results r on r.settlement_row_id = s.id where s.channel"
            " = %s group by 1", (ch,)).fetchall())
        # Tổng tiền đọc view 1 dòng/khoản (bản xuất lại tính 1 lần) — cùng
        # số với rev_share/P&L/BKS; số dòng theo nhãn vẫn là dòng thô.
        n_rows, payout, expected, aff, n_unrec = conn.execute(
            "select count(*), coalesce(sum(s.payout_vnd), 0),"
            " coalesce(sum(r.expected_payout_vnd), 0),"
            " coalesce(sum(s.affiliate_vnd), 0), count(*) filter (where"
            " r.id is null) from v_settlement_khoan s left join"
            " recon_results r on r.settlement_row_id = s.id where s.channel"
            " = %s", (ch,)).fetchone()
        if not n_rows:
            print(f"  {ch}: chưa có file quyết toán")
            continue
        multi = conn.execute(
            "select count(*) from (select order_id_hash from settlement_rows"
            " where channel = %s group by 1 having count(distinct"
            " file_sha256) >= 2) x", (ch,)).fetchone()[0]
        n_raw = conn.execute("select count(*) from settlement_rows where"
                             " channel = %s", (ch,)).fetchone()[0]
        print(f"  {ch}: {n_raw} dòng — " + ", ".join(
            f"{lb}={by.get(lb, 0)}" for lb in LABELS)
            + (f", CHƯA đối chiếu={n_unrec}" if n_unrec else ""))
        print(f"    thực nhận theo file {_vnd(payout)}; tính lại "
              f"{_vnd(expected)}; chênh {_vnd(payout - expected)}; "
              f"affiliate sàn khấu trừ {_vnd(aff)}; đơn ở ≥2 file "
              f"quyết toán: {multi}")
        ov = overlaps(conn, [ch]).get(ch, {"trung": 0, "lech": 0,
                                           "files": []})
        print(f"    khoản xuất lại ở ≥2 file: trùng {ov['trung']}, lệch "
              f"{ov['lech']} — tổng tiền tính {n_rows} khoản (trùng nguyên"
              " văn tính 1 lần; lệch giữ cả hai, chờ người đối soát)"
              + (": " + ", ".join(_safe(f, 80) for f in ov["files"][:20])
                 if ov["files"] else ""))
        bad = conn.execute(
            "select s.file_name, s.row_no, r.label, r.reasons from"
            " settlement_rows s join recon_results r on r.settlement_row_id"
            " = s.id where s.channel = %s and r.label <> 'khop' order by"
            " r.label, s.file_name, s.row_no limit %s",
            (ch, MAX_REPORT_LINES + 1)).fetchall()
        for fname, row_no, label, reasons in bad[:MAX_REPORT_LINES]:
            why = "; ".join(
                f"{x['code']} chênh {_vnd(x['actual'] - x['expected'])}"
                for x in reasons) or "-"
            print(f"    [{label}] {_clean(fname, 80)} dòng {row_no}: {why}")
        if len(bad) > MAX_REPORT_LINES:
            print(f"    ... còn nữa — chỉ in {MAX_REPORT_LINES} dòng đầu")


# ---------- CLI ----------

def _print_errs(errs: list[str]) -> None:
    for e in errs[:MAX_PRINT_ERRS]:
        print(f"[err] {e}", flush=True)
    if len(errs) > MAX_PRINT_ERRS:
        print(f"[err] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác")
    print(f"[err] {len(errs)} lỗi — không connect, không nạp gì.", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.settlement_csv",
        description="ACC-Recon: nạp file quyết toán sàn + đối soát (chỉ báo "
                    "cáo, không bút toán).")
    ap.add_argument("--file", type=Path, help="file .csv / .xlsx quyết toán")
    ap.add_argument("--channel", choices=CHANNELS)
    ap.add_argument("--reconcile", action="store_true",
                    help="đối chiếu lại MỌI dòng đã nạp (file đơn tới sau)")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args(argv)

    n_ops = sum([args.file is not None, args.reconcile, args.report])
    if n_ops > 1:
        ap.error("chỉ được 1 thao tác mỗi lần (--file | --reconcile | "
                 "--report)")
    if n_ops == 0:
        ap.error("cần --file ... | --reconcile | --report")
    if (args.file is not None) != (args.channel is not None):
        ap.error("--channel chỉ dùng và bắt buộc với --file")

    fees = rows = sha = None
    if not args.report:
        fees, why = load_fees()
        if fees is None:
            print(f"[err] {why} — không connect.", flush=True)
            return 1
    if args.file is not None:
        mapping, why = load_mapping()
        if mapping is None:
            print(f"[err] {why} — không connect.", flush=True)
            return 1
        rows, errs, sha = read_settlement(args.file, args.channel, mapping)
        if errs:
            _print_errs(errs)
            return 1

    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}")
        return 1
    try:
        if args.report:
            report(conn)
            return 0
        if args.reconcile:
            counts = reconcile(conn, fees)
            conn.commit()
            print("[reconcile] " + ", ".join(f"{k}={v}" for k, v in
                                             counts.items()))
            return 0
        if conn.execute("select 1 from settlement_rows where file_sha256 ="
                        " %s limit 1", (sha,)).fetchone():
            print("[skip] file quyết toán đã nạp — không ghi gì.")
            return 0
        n = load(conn, rows, args.channel, args.file.name, sha)
        counts = reconcile(conn, fees, sha)
        ov = overlaps(conn, [args.channel]).get(args.channel)
        conn.commit()
    except psycopg.errors.UniqueViolation as e:
        conn.rollback()
        if "file_sha256" in (e.diag.constraint_name or ""):
            print("[skip] file vừa được nạp song song — không ghi gì.")
            return 0
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}")
        return 1
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        print("[err] thiếu bảng settlement_rows/recon_results/market_rows — "
              "chạy `python scripts/apply_schema.py` trước.")
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}")
        return 1
    finally:
        conn.close()
    print(f"[load] quyết toán {args.channel} {_clean(args.file.name, 80)}: "
          f"{n} dòng; đối chiếu: " + ", ".join(
              f"{k}={v}" for k, v in counts.items()))
    if ov:
        print(f"[warn] khoản xuất lại ở ≥2 file (chồng kỳ): trùng "
              f"{ov['trung']}, lệch {ov['lech']} — "
              + ", ".join(_safe(f, 80) for f in ov["files"][:20])
              + ". Trùng nguyên văn tính 1 lần; lệch giữ cả hai → đối soát"
              " quý BẤT THƯỜNG, không tính phí tới khi người đối soát xử"
              " lý.")
    if counts["thieu_chung_tu"]:
        print(f"[warn] {counts['thieu_chung_tu']} dòng chưa thấy đơn sàn — "
              "nạp file đơn (`python -m ingest.market_csv --kind order`) rồi"
              " chạy `--reconcile`.")
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
