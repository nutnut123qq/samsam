"""v9.2 nạp tồn thành phẩm (SX-A3 đầu vào) — file kho xuất tay (CSV/XLSX).

Nhân sự kho xuất file thứ Sáu; agent CHỈ ĐỌC file, không sửa tồn, không
chuyển kho. Dữ liệu trong repo (`data/sample_inventory.csv`) là MẪU.

Contract nạp (`python -m ingest.inventory_csv --file F [--source
manual_export|sample]`):
  - `read_inventory` (hàm thuần) kiểm TOÀN file TRƯỚC khi connect: đuôi
    .csv/.xlsx (giải mã + trần dòng/cột qua `market_csv._table`), header
    ĐÚNG tập `sku_key, kho, qty, captured_at`, sku_key có trong golden
    file, kho là slug ascii (không chỗ cho tên/SĐT), qty nguyên >= 0,
    captured_at `YYYY-MM-DD` không ở tương lai, không trùng (sku, kho,
    ngày). Lỗi chỉ nêu số dòng / tên cột — KHÔNG in giá trị ô.
  - Có lỗi → `[err]`, exit 1, KHÔNG connect, 0 dòng ghi.
  - `file_sha256` đã có → `[skip]`, exit 0. File mới → 1 transaction.
  - Bảng `inventory_snapshots` append-only bằng code (module không
    update/delete).

Schema dòng ghi: {row_no (số dòng file, header = 1), sku_key, kho, qty,
captured_at (date)}.

Tồn hiện có = `current_stock(conn)`: mỗi (sku, kho) lấy snapshot ngày mới
nhất (hòa → id lớn nhất), cộng qua kho.

YÊU CẦU FILE KHO (vì append-only + "mới nhất mỗi (sku, kho)"): mỗi file
phải liệt kê ĐỦ mọi SKU × kho từng có tồn — SKU hết hàng ghi `qty` 0, kho
ngừng dùng ghi 0 cho mọi SKU của kho đó. SKU bị BỎ khỏi file mới vẫn giữ
qty của snapshot cũ (không đoán = 0) nhưng bị đánh dấu `stale` (không nằm
trong FILE mới nhất của CHÍNH kho đó — cũ hơn ngày mới nhất, HOẶC cùng ngày
nhưng file đính chính nạp sau bỏ SKU) → allocate/bản tin in
"số tồn cũ hơn file kho mới nhất — kiểm lại".
"""

import argparse
import datetime as dt
import hashlib
import os
import re
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest import golden_store, market_csv
from pipelines import scenario

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
HEADER = ("sku_key", "kho", "qty", "captured_at")
SOURCES = ("manual_export", "sample")
QTY_MAX = 2 * 10**9
KHO_MAX_LEN = 64
MAX_PRINT_ERRS = 30
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iso_date(s) -> dt.date | None:
    """Chỉ đúng dạng YYYY-MM-DD (fromisoformat 3.11+ nhận cả '20261012').
    Ô ngày XLSX (`_cell` → 'YYYY-MM-DD 00:00:00') cũng nhận."""
    if isinstance(s, str) and s.endswith(" 00:00:00"):
        s = s[:-9]
    if not isinstance(s, str) or not _ISO_RE.match(s):
        return None
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def read_inventory(path, golden_skus: dict, today: dt.date
                   ) -> tuple[list[dict], list[str], str | None]:
    """Hàm thuần (không DB) → (rows, errors, sha256). errors ≠ [] → rows
    = [] (không nạp nửa vời)."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in (".csv", ".xlsx"):
        return [], [(f"đuôi '{market_csv._clean(suffix, 10)}' không hỗ trợ"
                     " — chỉ .csv / .xlsx")], None
    try:
        if path.stat().st_size > market_csv.MAX_FILE_BYTES:
            return [], ["file quá lớn — tách file"], None
        data = path.read_bytes()
    except OSError as e:
        return [], [f"không đọc được file: {type(e).__name__}"], None
    sha = hashlib.sha256(data).hexdigest()
    if not data or data.isspace():
        return [], ["file rỗng"], sha
    try:
        rows, errs = _parse(market_csv._table(data, suffix), golden_skus,
                            today)
    except market_csv._TableError as e:
        return [], [str(e)], sha
    return ([] if errs else rows), errs, sha


def _parse(table, golden_skus: dict, today: dt.date
           ) -> tuple[list[dict], list[str]]:
    first = next(table, None)
    if first is None:
        return [], ["file rỗng"]
    hdr_no, hdr = first
    errs: list[str] = []
    norm = [market_csv._nfc(c).lower() if c else "" for c in hdr]
    for i, h in enumerate(norm, 1):
        if not h:
            errs.append(f"dòng {hdr_no}: header cột thứ {i} trống")
        elif h not in HEADER:
            # không in tên cột lạ (có thể là dữ liệu dán nhầm vào header)
            errs.append(f"dòng {hdr_no}: cột thứ {i} không thuộc tập "
                        f"{', '.join(HEADER)}")
    dup = sorted({h for h in norm if h and norm.count(h) > 1})
    if dup:
        errs.append(f"dòng {hdr_no}: header trùng {', '.join(dup)}")
    missing = [h for h in HEADER if h not in norm]
    if missing:
        errs.append(f"dòng {hdr_no}: thiếu cột {', '.join(missing)}")
    if errs:
        return [], errs
    idx = {h: norm.index(h) for h in HEADER}
    rows, seen = [], set()
    for no, cells in table:
        if len(cells) > len(HEADER):
            errs.append(f"dòng {no}: có ô ngoài {len(HEADER)} cột")
            continue
        cells = cells + [None] * (len(HEADER) - len(cells))
        v = {h: cells[idx[h]] for h in HEADER}
        bad = []
        if v["sku_key"] not in golden_skus:
            bad.append("sku_key (không có trong golden)")
        kho = v["kho"]
        if (not kho or len(kho) > KHO_MAX_LEN
                or not golden_store._SLUG_RE.match(kho)):
            bad.append("kho (phải là slug ascii a-z0-9-)")
        qty = market_csv._to_int(v["qty"], QTY_MAX)
        if qty is None:
            bad.append(f"qty (số nguyên 0..{QTY_MAX})")
        day = _iso_date(v["captured_at"])
        if day is None:
            bad.append("captured_at (YYYY-MM-DD)")
        elif not scenario.DATE_MIN <= day <= today:
            bad.append(f"captured_at (trong {scenario.DATE_MIN}..hôm nay)")
        if bad:
            errs.append(f"dòng {no}: {'; '.join(bad)}")
            continue
        key = (v["sku_key"], kho, day)
        if key in seen:
            errs.append(f"dòng {no}: trùng (sku_key, kho, captured_at) với "
                        "dòng trước")
            continue
        seen.add(key)
        rows.append({"row_no": no, "sku_key": v["sku_key"], "kho": kho,
                     "qty": qty, "captured_at": day})
    if not rows and not errs:
        errs.append("file chỉ có header — 0 dòng tồn")
    return rows, errs


def golden_map(path=None) -> tuple[dict | None, str | None]:
    """Golden đọc từ FILE (không connect) → ({sku_key: sku}, None) hoặc
    (None, lý do)."""
    doc, why = golden_store.read_golden(Path(path or golden_store.GOLDEN_FILE))
    if doc is None:
        return None, why
    errs = golden_store.validate(doc)
    if errs:
        return None, f"golden không hợp lệ ({len(errs)} lỗi)"
    return {s["sku_key"]: s for s in doc["skus"]}, None


# ---------- DB ----------

def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def load(conn, rows: list[dict], source: str, file_name: str,
         sha: str) -> int:
    """Insert append-only. Không commit — caller commit."""
    with conn.cursor() as cur:
        cur.executemany(
            "insert into inventory_snapshots (sku_key, kho, qty, captured_at,"
            " source, file_name, file_sha256, row_no) values"
            " (%s, %s, %s, %s, %s, %s, %s, %s)",
            [(r["sku_key"], r["kho"], r["qty"], r["captured_at"], source,
              file_name, sha, r["row_no"]) for r in rows])
    return len(rows)


STALE_NOTE = "số tồn cũ hơn file kho mới nhất — kiểm lại"


def current_stock(conn) -> dict:
    """→ {sku_key: {"qty": tổng qua kho, "kho": {kho: {"qty", "captured_at"
    (ISO), "stale": bool}}, "stale": [kho...], "sample": bool}}. Mỗi (sku,
    kho) lấy dòng captured_at mới nhất (hòa → id lớn nhất). `stale` = dòng
    đó KHÔNG thuộc FILE mới nhất của CÙNG kho (file kho mới bỏ sót SKU — có
    thể đã hết hàng), gồm 2 biến thể: (a) captured_at cũ hơn ngày mới nhất
    của kho; (b) cùng ngày nhưng từ file nạp trước — file đính chính cùng
    ngày bỏ SKU (mới nhất của kho = captured_at desc, id desc). Vẫn cộng
    qty cũ (không đoán = 0) nhưng caller PHẢI in cảnh báo `STALE_NOTE`.
    SKU không có dòng nào → không có key (caller coi là "chưa có số tồn",
    KHÔNG = 0)."""
    out: dict = {}
    for sku, kho, qty, day, source, stale in conn.execute(
            "select distinct on (sku_key, kho) sku_key, kho, qty,"
            " captured_at, source,"
            " captured_at < max(captured_at) over w"
            " or file_sha256 <> first_value(file_sha256) over w"
            " from inventory_snapshots"
            " window w as (partition by kho order by captured_at desc,"
            " id desc rows between unbounded preceding and unbounded"
            " following)"
            " order by sku_key, kho, captured_at desc, id desc"):
        s = out.setdefault(sku, {"qty": 0, "kho": {}, "stale": [],
                                 "sample": False})
        s["qty"] += qty
        s["kho"][kho] = {"qty": qty, "captured_at": day.isoformat(),
                         "stale": bool(stale)}
        if stale:
            s["stale"].append(kho)
        s["sample"] = s["sample"] or source == "sample"
    return out


# ---------- CLI ----------

def _today_vn() -> dt.date:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.inventory_csv",
        description="Nạp file tồn kho thành phẩm xuất tay (chỉ đọc file, "
                    "không sửa tồn).")
    ap.add_argument("--file", type=Path, required=True,
                    help="file .csv / .xlsx cột sku_key,kho,qty,captured_at")
    ap.add_argument("--source", choices=SOURCES, default="manual_export",
                    help="'sample' = dữ liệu MẪU trong repo")
    args = ap.parse_args(argv)

    golden, why = golden_map()
    if golden is None:
        print(f"[err] golden: {why} — không connect, không nạp gì.",
              flush=True)
        return 1
    rows, errs, sha = read_inventory(args.file, golden, _today_vn())
    if errs:
        for e in errs[:MAX_PRINT_ERRS]:
            print(f"[err] {e}", flush=True)
        if len(errs) > MAX_PRINT_ERRS:
            print(f"[err] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác")
        print(f"[err] {len(errs)} lỗi — không connect, không nạp gì.",
              flush=True)
        return 1

    # v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader)
    # — chế độ thực từ chối login superuser/owner/thiếu biến.
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
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
    name = market_csv._clean(args.file.name)
    try:
        old = conn.execute(
            "select count(*), min(imported_at) from inventory_snapshots"
            " where file_sha256 = %s", (sha,)).fetchone()
        if old[0]:
            print(f"[skip] file đã nạp ({old[0]} dòng) — không ghi gì.")
            return 0
        n = load(conn, rows, args.source, name, sha)
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
        print("[err] thiếu bảng inventory_snapshots — chạy `python "
              "scripts/apply_schema.py` trước.")
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}")
        return 1
    finally:
        conn.close()
    tag = " [MẪU]" if args.source == "sample" else ""
    print(f"[load]{tag} {name}: {n} dòng tồn ({len({r['kho'] for r in rows})}"
          f" kho, {len({r['sku_key'] for r in rows})} SKU) — chỉ ghi "
          "snapshot, không sửa tồn/chuyển kho.")
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
