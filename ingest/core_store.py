"""WS1 — nạp DB lõi từ `data/` vào Postgres local.

Contract:
  - Chỉ cần `DATABASE_URL` trong .env (không gọi OpenRouter).
  - Bảng lõi tạo bởi `docs/schema.sql`, KHÔNG tạo bảng từ code —
    chạy `python scripts/apply_schema.py` trước.
  - Idempotent 2 pha: xóa `where source = <file nguồn>` cho TẤT CẢ domain
    (con trước, cha sau) rồi insert lại (cha trước, con sau) → chạy n lần
    không nhân đôi, FK không bị `on delete set null` cắt link của row
    managed, và KHÔNG đè row nhập tay (`source` khác, vd 'manual').
    File nguồn thiếu HOẶC 0 record → domain đó KHÔNG được trả ra
    (v1.8.1): nếu vẫn append với rows=[] thì pha delete chạy rồi
    insert 0 = xóa trắng bảng đang có — `claims_approved` là nguồn sự
    thật guardrail. 0 record = file cắt cụt/crawl lỗi → giữ thống nhất
    hành vi "không xóa rows đang có".
    Edge chấp nhận (ghi ở đây, someday): row `source='manual'` trỏ
    `product_id` tới row do loader quản sẽ mất link (`set null`) sau
    mỗi reload — vá dài hạn = upsert `on conflict`.
    v9.3: `plots` KHÔNG còn delete+insert mù — khoảnh mẫu còn nhật ký
    ĐÃ CHAIN (hash chain `plot_logs`, trigger chặn xóa) hoặc còn ảnh
    `garden_media` được GIỮ và upsert tại chỗ; khoảnh trùng id nhưng
    `source` khác (vd 'manual') KHÔNG bị đè. Sau khi GĐ vùng trồng gỡ
    mẫu (`agent_action_log` action `garden_sample_purge`) loader bỏ hẳn
    domain `plots`/`plot_logs` mẫu — không nạp lại.
    Domain `multi` (assets) chỉ dọn `source` có row trong lần chạy →
    file nguồn rút hẳn thì asset cũ tồn đọng.
  - Dòng `{"_doc": "..."}` trong jsonl là comment — skip.
  - `sample_*.jsonl` nạp với source 'sample:*' — DỮ LIỆU MẪU chờ công ty
    bàn giao (SOW §5.2); phải phân biệt rõ với data crawl thật.
  - `orders` KHÔNG lưu PII khách (schema không có cột tên/SĐT).

Chạy: `python -m ingest.core_store` → in số row nạp + tổng từng bảng.
"""

import json
import os
import re
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

COLS = {
    "products": ("id", "name", "price_vnd", "description", "url", "lang",
                 "source"),
    "claims_approved": ("sku_key", "product_id", "claim", "source_ref",
                        "note", "source"),
    "plots": ("id", "location", "area_m2", "variety", "tree_count",
              "planted_year", "status", "source"),
    "plot_logs": ("plot_id", "ts", "activity", "detail", "author",
                  "source"),
    "orders": ("id", "ts", "channel", "product_id", "qty", "total_vnd",
               "status", "note", "source"),
    "assets": ("id", "kind", "title", "url", "product_id", "source"),
}

# Thứ tự insert: cha trước con sau (FK). Delete duyệt ngược lại.
DOMAIN_ORDER = ["products", "claims_approved", "plots", "plot_logs",
                "orders", "assets"]

_URL_RE = re.compile(r"https?://\S+")

# v9.3 — điều kiện "khoảnh bị giữ": còn nhật ký đã chain hoặc còn ảnh.
_PLOT_PINNED = ("exists (select 1 from plot_logs l where l.plot_id = p.id"
                " and l.row_hash is not null) or exists (select 1 from"
                " garden_media m where m.plot_id = p.id)")
PLOTS_DELETE_SQL = ("delete from plots p where source = %s"
                    f" and not ({_PLOT_PINNED})")
# Khoảnh còn giữ (cùng source) → cập nhật tại chỗ; khoảnh trùng id khác
# source (vd 'manual') → điều kiện where false → KHÔNG đè.
PLOTS_UPSERT_SUFFIX = (
    " on conflict (id) do update set "
    + ", ".join(f"{c} = excluded.{c}" for c in COLS["plots"]
                if c not in ("id", "source"))
    + ", updated_at = now() where plots.source = excluded.source")


def iter_jsonl(path: Path):
    """Yield record dict từ file jsonl; skip dòng `{"_doc": ...}` (comment
    theo convention repo) và dòng trống."""
    for line in path.open(encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if "_doc" in rec:
            continue
        yield rec


def lang_of(url: str) -> str:
    """ngoclinh.com EN có /en/ trong permalink; còn lại tiếng Việt."""
    return "en" if "/en/" in url else "vi"


def url_segment(url: str) -> str:
    """Segment path cuối bỏ '.html' — 'a/b/saphraton-48.html' →
    'saphraton-48'. Dùng link claims_whitelist.source → products.url."""
    return url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".html")


def product_row(rec: dict) -> dict:
    return {"id": rec["id"], "name": rec["name"],
            "price_vnd": rec.get("price_vnd"),
            "description": rec.get("description"), "url": rec.get("url"),
            "lang": lang_of(rec.get("url", "")), "source": "products.jsonl"}


def image_asset_rows(rec: dict) -> list[dict]:
    """Mỗi ảnh trong products.images[] → 1 asset '<product_id>#img<i>'."""
    return [{"id": f"{rec['id']}#img{i}", "kind": "image",
             "title": rec.get("name"), "url": img,
             "product_id": rec["id"], "source": "products.jsonl"}
            for i, img in enumerate(rec.get("images") or [])]


def article_asset_row(rec: dict, source: str) -> dict:
    """Bài báo/cẩm nang = tài sản truyền thông (SOW P0)."""
    return {"id": rec["id"], "kind": "article",
            "title": rec.get("title"), "url": rec.get("url"),
            "product_id": None, "source": source}


def claim_rows(sku_key: str, entry: dict, seg_to_pid: dict) -> list[dict]:
    """1 SKU trong claims_whitelist → n rows (mỗi approved_claim 1 row).
    SKU `approved_claims` rỗng → 1 row claim=None + note 'chưa có công
    bố' để audit coverage. `product_id` link best-effort qua segment URL
    cuối trong `source` (khớp products.url của net.vn shop)."""
    src = entry.get("source")
    product_id = None
    m = _URL_RE.search(src or "")
    if m:
        product_id = seg_to_pid.get(url_segment(m.group(0)))
    base = {"sku_key": sku_key, "product_id": product_id,
            "source_ref": src, "source": "claims_whitelist.json"}
    claims = entry.get("approved_claims") or []
    if not claims:
        return [{**base, "claim": None,
                 "note": "Chưa có công bố — không suy diễn"}]
    return [{**base, "claim": c, "note": None} for c in claims]


def plot_row(rec: dict, source: str) -> dict:
    return {"id": rec["id"], "location": rec.get("location"),
            "area_m2": rec.get("area_m2"), "variety": rec.get("variety"),
            "tree_count": rec.get("tree_count"),
            "planted_year": rec.get("planted_year"),
            "status": rec.get("status", "active"), "source": source}


def plot_log_row(rec: dict, source: str) -> dict:
    return {"plot_id": rec["plot_id"], "ts": rec["ts"],
            "activity": rec["activity"], "detail": rec.get("detail"),
            "author": rec.get("author"), "source": source}


def order_row(rec: dict, source: str) -> dict:
    """orders không lưu PII khách — record mẫu nào có field khách sẽ bị
    rớt khi map (chỉ lấy field trong COLS)."""
    return {"id": rec["id"], "ts": rec["ts"], "channel": rec["channel"],
            "product_id": rec.get("product_id"), "qty": rec.get("qty"),
            "total_vnd": rec.get("total_vnd"),
            "status": rec.get("status", "new"), "note": rec.get("note"),
            "source": source}


def collect_rows(data_dir: Path = DATA_DIR) -> list[tuple[str, str, list]]:
    """Đọc data dir → [(table, source, rows)] theo DOMAIN_ORDER (cha
    trước). File thiếu HOẶC 0 record → domain bị skip (warn), KHÔNG
    xóa rows đang có — giữ invariant "không xoá trắng bảng"."""
    domains: list[tuple[str, str, list]] = []

    products = (data_dir / "products.jsonl")
    prod_rows, seg_to_pid = [], {}
    if products.exists():
        for rec in iter_jsonl(products):
            prod_rows.append(product_row(rec))
            # Chỉ map URL kiểu net.vn '<slug>.html' — whitelist.source trỏ
            # trang net.vn; url wc (không .html) cùng slug sẽ chen nhầm.
            url = rec.get("url") or ""
            if url.rstrip("/").endswith(".html"):
                seg_to_pid[url_segment(url)] = rec["id"]
        if prod_rows:
            domains.append(("products", "products.jsonl", prod_rows))
        else:
            print(f"[warn] {products} 0 record — bỏ qua như file thiếu",
                  flush=True)
    else:
        print(f"[warn] thiếu {products} — bỏ qua", flush=True)

    wl_path = data_dir / "claims_whitelist.json"
    if wl_path.exists():
        wl = json.loads(wl_path.read_text(encoding="utf-8"))
        claim_rows_all = []
        for key, entry in wl.items():
            if key.startswith("_"):
                continue
            claim_rows_all.extend(claim_rows(key, entry, seg_to_pid))
        if claim_rows_all:
            domains.append(("claims_approved", "claims_whitelist.json",
                            claim_rows_all))
        else:
            print(f"[warn] {wl_path} 0 SKU/claim — bỏ qua như file "
                  f"thiếu", flush=True)
    else:
        print(f"[warn] thiếu {wl_path} — bỏ qua", flush=True)

    for table, fname in (("plots", "sample_plots.jsonl"),
                         ("plot_logs", "sample_plot_logs.jsonl"),
                         ("orders", "sample_orders.jsonl")):
        path = data_dir / fname
        src = f"sample:{fname}"
        row_fn = {"plots": plot_row, "plot_logs": plot_log_row,
                  "orders": order_row}[table]
        if path.exists():
            rows = [row_fn(r, src) for r in iter_jsonl(path)]
            if rows:
                domains.append((table, src, rows))
            else:
                print(f"[warn] {path} 0 record — bỏ qua như file thiếu",
                      flush=True)
        else:
            print(f"[warn] thiếu {path} — bỏ qua domain {table}",
                  flush=True)

    asset_rows = []
    if prod_rows:
        for rec in iter_jsonl(products):
            asset_rows.extend(image_asset_rows(rec))
    for fname in ("articles.jsonl", "news.jsonl"):
        path = data_dir / fname
        if path.exists():
            asset_rows.extend(article_asset_row(r, fname)
                              for r in iter_jsonl(path))
        else:
            print(f"[warn] thiếu {path} — bỏ qua", flush=True)
    if asset_rows:
        # Không file nào đóng góp → skip luôn domain (đừng delete-noop).
        domains.append(("assets", "multi", asset_rows))
    return domains


def apply_rows(conn, domains: list[tuple[str, str, list]]) -> dict:
    """2 pha: delete by-source (con trước cha sau) → insert (cha trước).
    Domain có source='multi' (assets gom nhiều file) xóa theo tập source
    thành phần để không sót row của file đã nạp trước đó."""
    # Pha 1 — delete con → cha
    by_table = {t: (src, rows) for t, src, rows in domains}
    for table in reversed(DOMAIN_ORDER):
        if table not in by_table:
            continue
        src, _ = by_table[table]
        if src == "multi":
            sources = sorted({r["source"] for r in by_table[table][1]})
            conn.execute(f"delete from {table} where source = any(%s)",
                         (sources,))
        elif table == "plots":
            # Khoảnh còn nhật ký đã chain (trigger chặn cascade) hoặc còn
            # ảnh (FK no action) → giữ lại, pha 2 upsert tại chỗ.
            conn.execute(PLOTS_DELETE_SQL, (src,))
        else:
            conn.execute(f"delete from {table} where source = %s", (src,))
    # Pha 2 — insert cha → con
    counts = {}
    for table in DOMAIN_ORDER:
        if table not in by_table:
            continue
        _, rows = by_table[table]
        if rows:
            cols = COLS[table]
            sql = (f"insert into {table} ({', '.join(cols)}) values ("
                   + ", ".join(f"%({c})s" for c in cols) + ")")
            if table == "plots":
                sql += PLOTS_UPSERT_SUFFIX
            with conn.cursor() as cur:
                cur.executemany(sql, rows)
        counts[table] = len(rows)
    return counts


def sample_garden_purged(conn) -> bool:
    """GĐ vùng trồng đã gỡ dữ liệu mẫu vườn chưa (có log
    `garden_sample_purge`)? Bảng `agent_action_log` chưa có → False
    (savepoint giữ conn sống sau UndefinedTable)."""
    try:
        with conn.transaction():
            return bool(conn.execute(
                "select exists (select 1 from agent_action_log"
                " where action = 'garden_sample_purge')").fetchone()[0])
    except psycopg.errors.UndefinedTable:
        return False


def drop_sample_garden(domains: list) -> list:
    """Bỏ domain plots/plot_logs nguồn `sample:*` (không delete, không
    insert) — domain khác (orders mẫu...) giữ nguyên."""
    return [d for d in domains
            if not (d[0] in ("plots", "plot_logs")
                    and d[1].startswith("sample:"))]


def kept_plots(conn, domains: list) -> list[tuple[str, int, int]]:
    """Khoảnh thuộc source plots đang nạp mà loader GIỮ lại (còn nhật ký
    đã chain / ảnh) → [(id, số nhật ký chain, số ảnh)] theo id."""
    srcs = [src for t, src, _ in domains if t == "plots"]
    if not srcs:
        return []
    return [tuple(r) for r in conn.execute(
        "select p.id,"
        " (select count(*) from plot_logs l where l.plot_id = p.id"
        "  and l.row_hash is not null),"
        " (select count(*) from garden_media m where m.plot_id = p.id)"
        f" from plots p where p.source = any(%s) and ({_PLOT_PINNED})"
        " order by p.id", (srcs,)).fetchall()]


def main() -> int:
    load_dotenv(ROOT / ".env")
    # v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader)
    # — chế độ thực từ chối login superuser/owner/thiếu biến.
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1

    domains = collect_rows()
    loaded = {t: len(r) for t, _, r in domains}
    for table in DOMAIN_ORDER:
        if table in loaded:
            print(f"[load] {table}: {loaded[table]} rows", flush=True)

    try:
        with psycopg.connect(dsn, connect_timeout=10) as conn:
            if sample_garden_purged(conn):
                print("[skip] plots/plot_logs mẫu: GĐ vùng trồng đã gỡ dữ"
                      " liệu mẫu (garden_sample_purge) — không nạp lại",
                      flush=True)
                domains = drop_sample_garden(domains)
            apply_rows(conn, domains)
            for pid, n_logs, n_media in kept_plots(conn, domains):
                print(f"[keep] plots: {pid} ({n_logs} nhật ký đã chain,"
                      f" {n_media} ảnh) — không xóa", flush=True)
            present = {t for t, _, _ in domains}
            totals = {t: conn.execute(f"select count(*) from {t}")
                      .fetchone()[0] for t in DOMAIN_ORDER
                      if t in present}
    except psycopg.errors.UndefinedTable as e:
        print(f"[err] thiếu bảng lõi — chạy `python "
              f"scripts/apply_schema.py` trước: {e}")
        return 1
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {e}")
        return 1
    print("[done] totals: "
          + ", ".join(f"{t}={n}" for t, n in totals.items()), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
