"""Phụ lục A (SOW §11) — bảng kê dữ liệu đã số hóa, đếm THẬT.

Đếm records trong `data/*.jsonl` + `claims_whitelist.json` + các bảng
lõi Postgres (`products`, `claims_approved`, `plots`, `plot_logs`,
`orders`, `assets`, `chunks`). Output markdown — paste vào
`docs/phu-luc-a.md`. DB lỗi/thiếu .env → cột DB in "chưa nạp", vẫn
exit 0 (bảng kê file vẫn có giá trị).

Chạy: `python scripts/data_audit.py`
"""

import json
import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def count_jsonl(path: Path) -> int | None:
    """Số record (bỏ dòng `_doc`/trống); None khi file không tồn tại."""
    if not path.exists():
        return None
    n = 0
    for line in path.open(encoding="utf-8"):
        if not line.strip():
            continue
        if '"_doc"' in line and json.loads(line).get("_doc"):
            continue
        n += 1
    return n


def whitelist_counts(path: Path) -> tuple[int, int] | None:
    """(số SKU, số claim đã công bố); None khi thiếu file."""
    if not path.exists():
        return None
    wl = json.loads(path.read_text(encoding="utf-8"))
    skus = [k for k in wl if not k.startswith("_")]
    claims = sum(len(wl[k].get("approved_claims") or []) for k in skus)
    return len(skus), claims


def db_counts() -> dict | None:
    """{key: số row} — key là `source` của từng domain (đếm đúng phần
    file đó nạp, kể cả khi nhiều file share một bảng). None khi không
    connect/thiếu env."""
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    try:
        with psycopg.connect(dsn) as conn:
            out = {}
            for key, table, source in (
                    ("products.jsonl", "products", "products.jsonl"),
                    ("claims_whitelist.json", "claims_approved",
                     "claims_whitelist.json"),
                    ("sample_plots.jsonl", "plots",
                     "sample:sample_plots.jsonl"),
                    ("sample_plot_logs.jsonl", "plot_logs",
                     "sample:sample_plot_logs.jsonl"),
                    ("sample_orders.jsonl", "orders",
                     "sample:sample_orders.jsonl"),
                    ("articles.jsonl", "assets", "articles.jsonl"),
                    ("news.jsonl", "assets", "news.jsonl"),
                    ("products.images", "assets", "products.jsonl")):
                extra = " and kind='image'" if key == "products.images" else ""
                out[key] = conn.execute(
                    f"select count(*) from {table} where source = %s"
                    + extra, (source,)).fetchone()[0]
            out["chunks"] = conn.execute(
                "select count(*) from chunks").fetchone()[0]
            about = DATA_DIR / "about.jsonl"
            if about.exists():
                ids = [json.loads(l)["id"] for l in
                       about.open(encoding="utf-8") if l.strip()
                       and '"_doc"' not in l]
                out["chunks:about"] = conn.execute(
                    "select count(*) from chunks where doc_id = any(%s)",
                    (ids,)).fetchone()[0]
            return out
    except (psycopg.Error, OSError):
        return None


def _fmt(n) -> str:
    return str(n) if n is not None else "—"


def main() -> int:
    # domain → (file jsonl, key trong db_counts cho số row DB)
    files = {
        "Sản phẩm + bảng giá (P0)": ("products.jsonl", "products.jsonl"),
        "Bài báo/cẩm nang (P0)": ("articles.jsonl", "articles.jsonl"),
        "Tin tức + điểm phân phối (P0)": ("news.jsonl", "news.jsonl"),
        "Giới thiệu công ty (P0)": ("about.jsonl", "chunks:about"),
        "Vùng trồng/khoảnh (P1)": ("sample_plots.jsonl",
                                   "sample_plots.jsonl"),
        "Nhật ký vườn (P1)": ("sample_plot_logs.jsonl",
                              "sample_plot_logs.jsonl"),
        "Bán hàng/đơn (P1)": ("sample_orders.jsonl",
                              "sample_orders.jsonl"),
    }
    db = db_counts()

    print("| Domain (SOW) | File nguồn | Records | DB lõi (theo nguồn) |"
          " Trạng thái |")
    print("|---|---|---|---|---|")
    for domain, (fname, dbkey) in files.items():
        n = count_jsonl(DATA_DIR / fname)
        in_db = db.get(dbkey) if db is not None else None
        status = ("MẪU — chờ bàn giao" if fname.startswith("sample_")
                  else "thật (crawl)")
        if in_db is None:
            status += " · chưa nạp DB"
        print(f"| {domain} | `data/{fname}` | {_fmt(n)} | "
              f"{_fmt(in_db)} | {status} |")

    wl = whitelist_counts(DATA_DIR / "claims_whitelist.json")
    in_db = db.get("claims_whitelist.json") if db is not None else None
    print(f"| Claims đã công bố (P0) | `data/claims_whitelist.json` | "
          f"{_fmt(wl[0] if wl else None)} SKU / "
          f"{_fmt(wl[1] if wl else None)} claim | {_fmt(in_db)} | "
          f"thật (trích tay từ crawl) |")

    assets_img = None
    p = DATA_DIR / "products.jsonl"
    if p.exists():
        assets_img = sum(len(json.loads(l).get("images") or [])
                         for l in p.open(encoding="utf-8")
                         if l.strip() and '"_doc"' not in l)
    in_db = db.get("products.images") if db is not None else None
    print(f"| Ảnh/media sản phẩm (P0) | images[] trong products.jsonl | "
          f"{_fmt(assets_img)} | {_fmt(in_db)} | thật (crawl) |")

    chunks = db.get("chunks") if db is not None else None
    print(f"| Vector index (phục vụ WS2/WS3) | bảng `chunks` | — | "
          f"{_fmt(chunks)} | {'đã embed' if chunks else 'chưa nạp'} |")

    note = ("đọc được" if db is not None else
            "KHÔNG đọc được — cột DB để trống, file counts vẫn đúng")
    print(f"\nDB note: {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
