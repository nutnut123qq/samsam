"""v14.4 (sales-06.1, PL01 "Phát hiện lệch giá, đại lý phá giá") — nạp file
giá ĐẠI LÝ quan sát tay → `dealer_price_obs` (append-only).

Nguồn giá đại lý TỰ ĐỘNG (API/crawl gian hàng đại lý) chưa có = blocker
(Bên B cấp nguồn/quyền). Hiện NGƯỜI quan sát ghi CSV UTF-8:
`kenh,ma_dai_ly,sku_key,gia_vnd,ngay,url_nguon`.

Contract (`python -m ingest.dealer_price --file CSV --by <tên> [--sample]`):
  - `read_dealer_file` (THUẦN) kiểm TOÀN file TRƯỚC khi connect: header đúng
    tập cột; kênh ∈ `data/sales_watch.json` dealer_price.channels; mã đại lý
    `[A-Z0-9_-]{2,20}`; sku slug; giá nguyên > 0; ngày `YYYY-MM-DD` không ở
    tương lai; URL https, không khoảng trắng/ký tự điều khiển, ≤ 500 ký tự,
    không SĐT/email; không trùng (kênh, đại lý, SKU, ngày). Lỗi chỉ nêu số
    dòng + tên cột — KHÔNG in giá trị ô. Có lỗi → exit 1, 0 dòng.
  - `load_dealer_obs`: file đã nạp (sha256) → `[skip]`; mã đại lý/SKU không
    có trong sổ `dealers`/`sku_master` → lỗi nêu số dòng, KHÔNG ghi dòng nào;
    còn lại 1 transaction. `--sample` = dữ liệu MẪU (không sinh cảnh báo).
  - Không PII (mã đại lý, không tên người); không request mạng; không đổi
    giá. So giá sàn + đẩy cảnh báo: `python -m agents.kd_price
    --dealer-watch` (job, chỉ đọc bảng này).
Exit: 0 ok/skip · 1 file/sổ lỗi, cấu hình lỗi · 2 tham số sai / DB down.
"""

import argparse
import csv
import hashlib
import io
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from ingest.lead_store import connect
from ingest.market_csv import _clean, _to_int
from pipelines.period import VN_TZ
from pipelines.pii import _PII_RE

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

COLS = ("kenh", "ma_dai_ly", "sku_key", "gia_vnd", "ngay", "url_nguon")
MAX_BYTES = 2 * 1024 * 1024
MAX_URL = 500
MAX_PRINT_ERRS = 30
_DEALER_RE = re.compile(r"[A-Z0-9_-]{2,20}")
_SKU_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _date(s) -> date | None:
    if not isinstance(s, str) or not _ISO_RE.fullmatch(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _url_ok(url: str) -> bool:
    try:
        parts = urlsplit(url)
        host_ok = parts.scheme == "https" and bool(parts.hostname)
    except ValueError:
        return False
    return (host_ok and len(url) <= MAX_URL
            and not any(c.isspace() or not c.isprintable() for c in url)
            and _PII_RE.search(url) is None)


def read_dealer_file(path, channels, max_rows: int, today: date
                     ) -> tuple[list[dict], list[str], str | None]:
    """THUẦN (không DB) → (rows, errs, sha256). errs ≠ [] → rows = []."""
    p = Path(path)
    try:
        if p.stat().st_size > MAX_BYTES:
            return [], [f"file > {MAX_BYTES // 2**20}MB"], None
        data = p.read_bytes()
    except OSError as e:
        return [], [f"không đọc được file: {type(e).__name__}"], None
    sha = hashlib.sha256(data).hexdigest()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        return [], [f"file không phải UTF-8 (byte {e.start})"], sha
    table = []
    try:
        for i, r in enumerate(csv.reader(io.StringIO(text, newline="")), 1):
            if not any(c.strip() for c in r):
                continue
            if len(table) > max_rows:
                return [], [f"file > {max_rows} dòng — tách file"], sha
            table.append((i, r))
    except csv.Error:
        return [], ["CSV hỏng (ngoặc kép/ký tự lạ)"], sha
    if not table:
        return [], ["file rỗng"], sha
    (_, header), body = table[0], table[1:]
    hdr = [(h or "").strip() for h in header]
    if sorted(hdr) != sorted(COLS):
        return [], ["header phải đúng các cột: " + ", ".join(COLS)
                    + " (không thiếu/thừa/trùng)"], sha
    col = {h: j for j, h in enumerate(hdr)}
    if not body:
        return [], ["file chỉ có header, không có dòng dữ liệu"], sha
    rows, keys, errs = [], {}, []
    for no, cells in body:
        if any(c.strip() for c in cells[len(hdr):]):
            errs.append(f"dòng {no}: thừa ô ngoài header")
            continue
        v = {k: (cells[j].strip() if j < len(cells) else "") or None
             for k, j in col.items()}
        bad = []
        if v["kenh"] not in channels:
            bad.append("kenh")
        if not (v["ma_dai_ly"] and _DEALER_RE.fullmatch(v["ma_dai_ly"])):
            bad.append("ma_dai_ly")
        if not (v["sku_key"] and _SKU_RE.fullmatch(v["sku_key"])
                and len(v["sku_key"]) <= 64):
            bad.append("sku_key")
        price = _to_int(v["gia_vnd"], 10**12)
        if not price:
            bad.append("gia_vnd (số nguyên > 0)")
        day = _date(v["ngay"])
        if day is None or day > today:
            bad.append("ngay (YYYY-MM-DD, không ở tương lai)")
        url = v["url_nguon"] or ""
        if not _url_ok(url):
            bad.append("url_nguon (https://, ≤ 500 ký tự, không SĐT/email)")
        if bad:
            errs.append(f"dòng {no}: cột {', '.join(bad)} không hợp lệ")
            continue
        k = (v["kenh"], v["ma_dai_ly"], v["sku_key"], day)
        if k in keys:
            errs.append(f"dòng {no}: trùng (kênh, đại lý, SKU, ngày) với "
                        f"dòng {keys[k]}")
            continue
        keys[k] = no
        rows.append({"row_no": no, "channel": v["kenh"],
                     "dealer_code": v["ma_dai_ly"], "sku_key": v["sku_key"],
                     "price_vnd": price, "observed_on": day,
                     "source_url": url})
    if errs:
        return [], errs, sha
    return rows, [], sha


def load_dealer_obs(conn, rows: list[dict], sha: str, by: str,
                    source: str = "manual_export") -> dict:
    """Ghi quan sát (1 transaction) → {inserted, skipped_file}."""
    who = by.strip() if isinstance(by, str) else ""
    if not who or len(who) > 100 or not who.isprintable() or \
            who.casefold().startswith(("agent:", "system:")):
        raise ValueError("--by phải là tên NGƯỜI quan sát/nhập file")
    if source not in ("manual_export", "sample"):
        raise ValueError("source phải là manual_export|sample")
    if conn.execute("select 1 from dealer_price_obs where file_sha256 = %s"
                    " limit 1", (sha,)).fetchone():
        conn.commit()
        return {"inserted": 0, "skipped_file": True}
    dealers = {c for (c,) in conn.execute(
        "select code from dealers where code = any(%s)",
        (sorted({r["dealer_code"] for r in rows}),)).fetchall()}
    skus = {k for (k,) in conn.execute(
        "select sku_key from sku_master where sku_key = any(%s)",
        (sorted({r["sku_key"] for r in rows}),)).fetchall()}
    bad = [f"dòng {r['row_no']}: " + ", ".join(
        n for n, ok in (("ma_dai_ly không có trong sổ đại lý",
                         r["dealer_code"] in dealers),
                        ("sku_key không có trong golden", r["sku_key"] in skus))
        if not ok)
        for r in rows
        if r["dealer_code"] not in dealers or r["sku_key"] not in skus]
    if bad:
        raise ValueError("; ".join(bad[:MAX_PRINT_ERRS])
                         + (f" … (+{len(bad) - MAX_PRINT_ERRS})"
                            if len(bad) > MAX_PRINT_ERRS else ""))
    n = 0
    with conn.transaction():
        for r in rows:
            n += conn.execute(
                "insert into dealer_price_obs (file_sha256, row_no, channel,"
                " dealer_code, sku_key, price_vnd, observed_on, source_url,"
                " source, created_by) values (%s, %s, %s, %s, %s, %s, %s, %s,"
                " %s, %s) on conflict (file_sha256, row_no) do nothing",
                (sha, r["row_no"], r["channel"], r["dealer_code"],
                 r["sku_key"], r["price_vnd"], r["observed_on"],
                 r["source_url"], source, who)).rowcount
    conn.commit()
    return {"inserted": n, "skipped_file": False}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.dealer_price",
        description="Nạp file giá ĐẠI LÝ quan sát tay (v14.4) — không đổi"
                    " giá, không liên hệ đại lý")
    ap.add_argument("--file", type=Path, required=True, metavar="CSV")
    ap.add_argument("--by", required=True,
                    help="tên NGƯỜI quan sát/nhập file")
    ap.add_argument("--sample", action="store_true",
                    help="đánh dấu dữ liệu MẪU (không sinh cảnh báo)")
    args = ap.parse_args(argv)
    if not args.by.strip():
        ap.error("--by cần tên người quan sát")
    from agents import sales_watch
    try:
        dp = sales_watch.section("dealer_price")
    except ValueError as e:
        print(f"[error] cấu hình lỗi: {e} — không connect", file=sys.stderr)
        return 1
    rows, errs, sha = read_dealer_file(args.file, dp["channels"],
                                       dp["max_rows"],
                                       datetime.now(VN_TZ).date())
    if errs:
        for e in errs[:MAX_PRINT_ERRS]:
            print(f"[error] {e}", file=sys.stderr)
        print(f"[error] {len(errs)} lỗi — không connect, không nạp dòng nào.",
              file=sys.stderr)
        return 1
    # v14.2: loader chạy bằng login dịch vụ nạp file (svc_loader).
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    # v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) —
    # chưa cấu hình + tính năng tắt → không nạp.
    from pipelines import loader_gate
    if why := loader_gate.check("dealer_price"):
        print(f"[rollout] {why}", flush=True)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        r = load_dealer_obs(conn, rows, sha, args.by,
                            "sample" if args.sample else "manual_export")
    except ValueError as e:
        print(f"[error] {e} — không nạp dòng nào", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        prim = getattr(getattr(e, "diag", None), "message_primary", "")
        print(f"[error] lỗi DB: {_clean(prim or type(e).__name__, 300)}",
              file=sys.stderr)
        return 2
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001, S110
            pass
    if r["skipped_file"]:
        print(f"[skip] file đã nạp (sha256 {sha[:12]}) — không ghi thêm")
    else:
        print(f"[ok] nạp {r['inserted']} quan sát giá đại lý"
              + (" (MẪU — không sinh cảnh báo)" if args.sample else "")
              + " — chạy `python -m agents.kd_price --dealer-watch` để so"
              " giá sàn")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
