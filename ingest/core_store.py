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
    v15.5 (HĐ 7.3): `products` KHÔNG còn delete-by-source — trước đó
    mỗi lần nạp lại FK `on delete set null` cắt `orders.product_id` của
    đơn THẬT. Nay upsert theo `id` (chỉ đè dòng cùng `source`), sản phẩm
    biến mất khỏi nguồn → GIỮ + `retired_at` (claim trỏ trang sản phẩm đó
    vẫn link về id cũ), xuất hiện lại → bỏ `retired_at`; id trùng dòng
    NGUỒN KHÁC (vd 'manual') → không đè. Mọi sự kiện đổi/ngừng/mở lại/mơ
    hồ ghi `product_sync_log` (append-only) + in `[changed]`/`[retired]`/
    `[reactivated]`/`[ambiguous]`. Loader không bao giờ DELETE products.
    `products.jsonl` thiếu / 0 record / hỏng (JSON lỗi, `{}`, thiếu
    `id`/`name`, trùng `id`) và MỌI file nguồn hỏng → exit 1, KHÔNG ghi
    gì (thiếu products thì claim mất map sản phẩm → không nạp domain nào).
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
from psycopg.types.json import Jsonb

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

# v15.5 — products upsert theo id: chỉ đè dòng CÙNG source, chỉ ghi khi dữ
# liệu đổi hoặc đang `retired_at` (nạp lại y nguyên = 0 UPDATE).
_PRODUCT_FIELDS = tuple(c for c in COLS["products"] if c not in ("id",
                                                                 "source"))
PRODUCTS_UPSERT_SQL = (
    f"insert into products ({', '.join(COLS['products'])}) values ("
    + ", ".join(f"%({c})s" for c in COLS["products"]) + ")"
    " on conflict (id) do update set "
    + ", ".join(f"{c} = excluded.{c}" for c in _PRODUCT_FIELDS)
    + ", retired_at = null, updated_at = now()"
    " where products.source = excluded.source and ("
    + ", ".join(f"products.{c}" for c in _PRODUCT_FIELDS)
    + ", products.retired_at) is distinct from ("
    + ", ".join(f"excluded.{c}" for c in _PRODUCT_FIELDS) + ", null)")
# Sản phẩm của nguồn không còn trong file → đánh dấu, KHÔNG xóa; đếm đơn
# thật đang trỏ tới để báo.
PRODUCTS_RETIRE_SQL = (
    "update products p set retired_at = now(), updated_at = now()"
    " where p.source = %s and p.retired_at is null and p.id <> all(%s)"
    " returning p.id, p.name, p.url, (select count(*) from orders o"
    " where o.product_id = p.id and o.source <> 'sample'"
    " and o.source not like 'sample:%%')")


class SourceError(ValueError):
    """File nguồn hỏng (JSON lỗi, record thiếu khóa, trùng id...) — main
    exit 1 TRƯỚC khi kết nối DB, không ghi gì."""


def iter_jsonl(path: Path):
    """Yield record dict từ file jsonl; skip dòng `{"_doc": ...}` (comment
    theo convention repo) và dòng trống. Dòng không phải JSON object →
    `SourceError` (file hỏng, không nạp nửa vời)."""
    for no, line in enumerate(path.open(encoding="utf-8"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            raise SourceError(f"{path.name}:{no} JSON hỏng ({e.msg})") from e
        if not isinstance(rec, dict):
            raise SourceError(f"{path.name}:{no} không phải JSON object")
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


def _rows(path: Path, fn, *args) -> list[dict]:
    """Map record jsonl → row; record thiếu khóa bắt buộc (vd dòng `{}`)
    → `SourceError` thay vì KeyError giữa chừng."""
    out = []
    for rec in iter_jsonl(path):
        try:
            out.append(fn(rec, *args))
        except (KeyError, TypeError, AttributeError) as e:
            raise SourceError(f"{path.name}: record thiếu/sai khóa {e}"
                              f" — file hỏng") from e
    return out


def product_rows(path: Path) -> list[dict]:
    """products.jsonl → rows; `id`/`name` rỗng hoặc trùng `id` → file hỏng
    (trùng id = ánh xạ không rõ dòng nào đúng — không tự chọn)."""
    rows = _rows(path, product_row)
    seen: set = set()
    for r in rows:
        if not (isinstance(r["id"], str) and r["id"].strip()
                and isinstance(r["name"], str) and r["name"].strip()):
            raise SourceError(f"{path.name}: record thiếu id/name — file"
                              " hỏng")
        if r["id"] in seen:
            raise SourceError(f"{path.name}: trùng id {r['id']!r} — ánh xạ"
                              " không rõ, file hỏng")
        seen.add(r["id"])
    return rows


def collect_rows(data_dir: Path = DATA_DIR) -> list[tuple[str, str, list]]:
    """Đọc data dir → [(table, source, rows)] theo DOMAIN_ORDER (cha
    trước). File thiếu HOẶC 0 record → domain bị skip (warn), KHÔNG
    xóa rows đang có — giữ invariant "không xoá trắng bảng". Ngoại lệ
    v15.5: `products.jsonl` thiếu/0 record và file hỏng (bất kỳ) →
    `SourceError` (caller không ghi gì)."""
    domains: list[tuple[str, str, list]] = []

    products = (data_dir / "products.jsonl")
    seg_to_pid: dict = {}
    # v15.5: products.jsonl thiếu / 0 record → SourceError (không nạp domain
    # nào): claim map sản phẩm qua file này — nạp claim khi thiếu nó = cắt
    # `claims_approved.product_id` hàng loạt.
    if not products.exists():
        raise SourceError(f"thiếu {products.name}")
    prod_rows = product_rows(products)
    if not prod_rows:
        raise SourceError(f"{products.name} 0 record (rỗng/chỉ _doc)")
    for r in prod_rows:
        # Chỉ map URL kiểu net.vn '<slug>.html' — whitelist.source trỏ
        # trang net.vn; url wc (không .html) cùng slug sẽ chen nhầm.
        url = r["url"] or ""
        if url.rstrip("/").endswith(".html"):
            seg_to_pid[url_segment(url)] = r["id"]
    domains.append(("products", "products.jsonl", prod_rows))

    wl_path = data_dir / "claims_whitelist.json"
    if wl_path.exists():
        try:
            wl = json.loads(wl_path.read_text(encoding="utf-8"))
            claim_rows_all = []
            for key, entry in wl.items():
                if key.startswith("_"):
                    continue
                claim_rows_all.extend(claim_rows(key, entry, seg_to_pid))
        except (json.JSONDecodeError, AttributeError, TypeError) as e:
            raise SourceError(f"{wl_path.name} hỏng ({e})") from e
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
            rows = _rows(path, row_fn, src)
            if rows:
                domains.append((table, src, rows))
            else:
                print(f"[warn] {path} 0 record — bỏ qua như file thiếu",
                      flush=True)
        else:
            print(f"[warn] thiếu {path} — bỏ qua domain {table}",
                  flush=True)

    asset_rows = [a for rows in _rows(products, image_asset_rows)
                  for a in rows]
    for fname in ("articles.jsonl", "news.jsonl"):
        path = data_dir / fname
        if path.exists():
            asset_rows.extend(_rows(path, article_asset_row, fname))
        else:
            print(f"[warn] thiếu {path} — bỏ qua", flush=True)
    if asset_rows:
        # Không file nào đóng góp → skip luôn domain (đừng delete-noop).
        domains.append(("assets", "multi", asset_rows))
    return domains


def sync_products(conn, src: str, rows: list[dict]) -> list[tuple]:
    """v15.5 — đồng bộ `products` của nguồn `src` GIỮ định danh: upsert theo
    id (không DELETE → FK `on delete set null` không cắt đơn thật), sản
    phẩm vắng khỏi nguồn → `retired_at`. Trả [(kind, product_id, detail)]
    đã ghi `product_sync_log` (append-only):
      changed     — cùng id, đổi trường (giá trị cũ/mới; mô tả chỉ báo đổi)
      retired     — vừa biến mất khỏi nguồn (số đơn thật đang trỏ + id mới
                    trùng url/tên làm ỨNG VIÊN — KHÔNG tự chuyển liên kết)
      reactivated — đang retired, xuất hiện lại
      ambiguous   — id trong nguồn đã thuộc NGUỒN KHÁC (vd 'manual') →
                    không đè, không xóa (ghi 1 lần cho cùng tình trạng)."""
    ids = [r["id"] for r in rows]
    existing = {r[0]: r[1:] for r in conn.execute(
        "select id, source, retired_at, " + ", ".join(_PRODUCT_FIELDS)
        + " from products where id = any(%s)", (ids,)).fetchall()}
    events: list[tuple] = []
    upsert = []
    for r in rows:
        old = existing.get(r["id"])
        if old is None:
            upsert.append(r)
            continue
        source, retired_at, *vals = old
        if source != src:
            events.append(("ambiguous", r["id"], {
                "ly_do": "id_thuoc_nguon_khac", "nguon_hien_tai": source}))
            continue
        diff = {c: ({"doi": True} if c == "description"
                    else {"cu": v, "moi": r[c]})
                for c, v in zip(_PRODUCT_FIELDS, vals) if v != r[c]}
        if diff:
            events.append(("changed", r["id"], diff))
        if retired_at is not None:
            events.append(("reactivated", r["id"],
                           {"retired_at": retired_at.isoformat()}))
        upsert.append(r)
    if upsert:
        with conn.cursor() as cur:
            cur.executemany(PRODUCTS_UPSERT_SQL, upsert)
    for pid, name, url, n_real in conn.execute(
            PRODUCTS_RETIRE_SQL, (src, ids)).fetchall():
        cands = sorted(r["id"] for r in rows if r["id"] not in existing
                       and ((url and r["url"] == url) or r["name"] == name))
        events.append(("retired", pid, {"don_that": n_real,
                                        "ung_vien_thay_the": cands}))
    for kind, pid, detail in events:
        conn.execute(
            "insert into product_sync_log (kind, product_id, source, detail)"
            " select %(k)s, %(p)s, %(s)s, %(d)s where %(k)s <> 'ambiguous'"
            " or not exists (select 1 from product_sync_log l where"
            " l.kind = %(k)s and l.product_id = %(p)s and l.source = %(s)s"
            " and l.detail = %(d)s)",
            {"k": kind, "p": pid, "s": src, "d": Jsonb(detail)})
    return events


def relink_retired_claims(conn, src: str, rows: list[dict]) -> None:
    """Claim trỏ trang sản phẩm đã `retired` (vắng khỏi file hiện tại nên
    `collect_rows` không map được) → giữ link về id cũ thay vì null."""
    seg = {url_segment(u): pid for pid, u in conn.execute(
        "select id, url from products where source = %s and retired_at is"
        " not null and url is not null", (src,)).fetchall()
        if u.rstrip("/").endswith(".html")}
    for r in rows:
        m = _URL_RE.search(r["source_ref"] or "")
        if r["product_id"] is None and m:
            r["product_id"] = seg.get(url_segment(m.group(0)))


def apply_rows(conn, domains: list[tuple[str, str, list]]) -> dict:
    """2 pha: delete by-source bảng CON (con trước cha sau) → ghi (cha
    trước). `products` KHÔNG xóa — `sync_products` upsert + retired (v15.5);
    sự kiện ở `counts["product_events"]`. Domain có source='multi' (assets
    gom nhiều file) xóa theo tập source thành phần để không sót row của
    file đã nạp trước đó."""
    # Pha 1 — delete con → cha (trừ products)
    by_table = {t: (src, rows) for t, src, rows in domains}
    for table in reversed(DOMAIN_ORDER):
        if table not in by_table or table == "products":
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
    # Pha 2 — ghi cha → con
    counts: dict = {}
    for table in DOMAIN_ORDER:
        if table not in by_table:
            continue
        src, rows = by_table[table]
        if table == "products":
            counts["product_events"] = sync_products(conn, src, rows)
            counts[table] = len(rows)
            continue
        if table == "claims_approved" and "products" in by_table:
            relink_retired_claims(conn, by_table["products"][0], rows)
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

    try:
        domains = collect_rows(DATA_DIR)
    except SourceError as e:
        print(f"[err] file nguồn hỏng — không nạp gì: {e}", flush=True)
        return 1
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
            counts = apply_rows(conn, domains)
            for kind, pid, detail in counts.get("product_events", []):
                print(f"[{kind}] products: {pid} "
                      + json.dumps(detail, ensure_ascii=False,
                                   sort_keys=True, default=str)
                      + (" — giữ, không xóa" if kind == "retired" else ""),
                      flush=True)
            for pid, n_logs, n_media in kept_plots(conn, domains):
                print(f"[keep] plots: {pid} ({n_logs} nhật ký đã chain,"
                      f" {n_media} ảnh) — không xóa", flush=True)
            present = {t for t, _, _ in domains}
            totals = {t: conn.execute(f"select count(*) from {t}")
                      .fetchone()[0] for t in DOMAIN_ORDER
                      if t in present}
    except (psycopg.errors.UndefinedTable,
            psycopg.errors.UndefinedColumn) as e:
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
