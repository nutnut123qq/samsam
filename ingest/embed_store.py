"""Entry point: `python -m ingest.embed_store` → đồng bộ data/*.jsonl vào bảng
`chunks` (corpus CÔNG KHAI duy nhất của chatbot khách) — incremental.

Contract:
  - Đọc OPENROUTER_API_KEY / DATABASE_URL / OR_EMBED_MODEL từ .env.
  - Embedding qua `pipelines.llm_gateway.embed("ingest", ...)` (v3.1 — cổng
    LLM duy nhất: PII mask + privacy routing + ghi llm_usage).
  - Chunk mỗi record (body/description) ~700 ký tự, overlap ~80.
  - Bảng `chunks` — tạo bởi docs/schema.sql, KHÔNG tạo bảng từ code.
    embedding cột float8[]; similarity tính bằng numpy lúc query.
  - Cột `lang` ('vi'|'en') — ngoclinh.com có bản EN/VI trùng nhau.
    Product giá null render "Giá: Liên hệ" — RAG không được bịa giá.

v3.9 (W39.3) — incremental + lọc rượu, logic ở `sync()`:
  1. Đọc từng nguồn (`read_source`). Nguồn TIN CẬY = đọc được + >=1 record.
     missing / 0 byte / chỉ dòng trắng / chỉ `{"_doc":...}` -> KHÔNG tin cậy
     -> KHÔNG xóa chunk của nguồn đó (gotcha delete-trắng v1.8). Dòng JSON
     hỏng -> `SourceError` TRƯỚC embed và TRƯỚC mọi ghi DB.
  2. Lọc rượu (luật quảng cáo rượu >=15 độ): record có name/title nhắc rượu
     -> bỏ cả record; chunk nhắc rượu -> bỏ (chặn thừa bài viết = chấp nhận
     theo F15.3). Doc `catalog-products` dựng SAU khi bỏ SKU rượu.
  3. `doc_sha256` = sha256(model, source, title, url, lang, chunk sau lọc)
     -> đổi model/từ khóa lọc làm hash đổi -> embed lại doc đó.
  4. Chỉ embed chunk của doc mới/đổi hash (embed xong hết mới ghi DB — embed
     lỗi giữa chừng = 0 ghi).
  5. MỘT transaction: delete+insert doc đổi (`doc_version` cũ+1, mới 1,
     `ingested_at` now()); xóa doc không còn trong tập public của nguồn tin
     cậy; row legacy `source is null` không thuộc tập public chỉ xóa khi MỌI
     nguồn tin cậy. `conn.commit()` tường minh (gotcha savepoint v2.1).
  Row có `source` ngoài danh sách nguồn (nạp tay) không bị đụng.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from pipelines.kb_filter import KbFilterError, is_alcohol
from pipelines.llm_gateway import GatewayError, embed

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
JSONL_FILES = ["products.jsonl", "articles.jsonl", "about.jsonl", "news.jsonl"]
CATALOG = "catalog"  # source của doc tổng hợp, phụ thuộc products.jsonl
CATALOG_ID = "catalog-products"
DEFAULT_MODEL = "openai/text-embedding-3-small"
CONNECT_TIMEOUT_S = 10

CHUNK_SIZE = 700
CHUNK_OVERLAP = 80
EMBED_BATCH = 64


class SourceError(RuntimeError):
    """File nguồn có dòng hỏng — abort trước embed/ghi DB."""


def load_env() -> dict:
    load_dotenv(ROOT / ".env")
    key = os.environ.get("OPENROUTER_API_KEY")
    dsn = os.environ.get("DATABASE_URL")
    if not key or not dsn:
        print("[err] thiếu OPENROUTER_API_KEY hoặc DATABASE_URL trong .env")
        sys.exit(1)
    return {"api_key": key, "dsn": dsn,
            "model": os.environ.get("OR_EMBED_MODEL", DEFAULT_MODEL)}


def _price(rec: dict) -> str:
    return (f"{rec['price_vnd']:,} đ".replace(",", ".")
            if rec.get("price_vnd") else "Liên hệ")


def doc_text(rec: dict) -> str:
    """Record jsonl → text để chunk. Product: kèm dòng Giá verbatim —
    null -> 'Liên hệ' để RAG không bịa giá."""
    if "name" in rec:  # products.jsonl
        return f"Sản phẩm: {rec['name']}\nGiá: {_price(rec)}\n{rec.get('description', '')}"
    return f"{rec.get('title', '')}\n{rec.get('body', '')}"


def lang_of(url: str) -> str:
    """ngoclinh.com EN có /en/ trong permalink; còn lại tiếng Việt."""
    return "en" if "/en/" in url else "vi"


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Sliding window ~size ký tự, ưu tiên ngắt ở khoảng trắng."""
    chunks, i, n = [], 0, len(text)
    while i < n:
        j = min(i + size, n)
        if j < n:
            cut = text.rfind(" ", i + size // 2, j)
            if cut != -1:
                j = cut
        chunk = text[i:j].strip()
        if chunk:
            chunks.append(chunk)
        if j >= n:
            break
        i = j - overlap if j - overlap > i else j
    return chunks


def embed_all(client, model: str, texts: list[str]) -> list[list[float]]:
    """Embed theo batch; lỗi API raise — ingest fail sớm còn hơn nạp thiếu.
    `client` giữ trong signature cho tương thích (v3.1 bỏ qua — gọi qua
    gateway agent_id "ingest")."""
    out = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        resp = embed("ingest", batch, model=model)
        out.extend(d.embedding for d in resp.data)
        print(f"[embed] batch {i // EMBED_BATCH + 1}: {len(batch)} texts", flush=True)
    if len(out) != len(texts):
        raise GatewayError("số vector trả về lệch số chunk — không ghi DB")
    return out


def read_source(path: Path) -> list[dict] | None:
    """Record hợp lệ của 1 file jsonl; None = nguồn KHÔNG tin cậy (missing /
    0 byte / chỉ dòng trắng / chỉ `_doc`). Dòng hỏng (JSON lỗi, không phải
    object, thiếu `id`) -> SourceError. Đọc BYTES + split `\\n` tường minh."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    recs = []
    for n, line in enumerate(raw.split(b"\n"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError) as e:
            raise SourceError(f"{path.name}:{n} JSON hỏng ({type(e).__name__})") from e
        if not isinstance(rec, dict):
            raise SourceError(f"{path.name}:{n} không phải object")
        if "_doc" in rec:
            continue
        if not isinstance(rec.get("id"), str) or not rec["id"]:
            raise SourceError(f"{path.name}:{n} thiếu id")
        recs.append(rec)
    return recs or None


def _doc(doc_id, source, url, title, lang, chunks, model) -> dict:
    sha = hashlib.sha256(json.dumps(
        [model, source, title, url, lang, chunks], ensure_ascii=False
    ).encode("utf-8")).hexdigest()
    return {"doc_id": doc_id, "source": source, "source_url": url,
            "title": title, "lang": lang, "chunks": chunks, "sha": sha}


def build_docs(data_dir: Path, model: str) -> tuple[dict, set, dict]:
    """-> (docs public {doc_id: doc}, tập nguồn tin cậy, thống kê lọc)."""
    docs: dict[str, dict] = {}
    seen_ids: set[str] = set()
    trusted: set[str] = set()
    stats = {"records": {}, "alcohol_records": {}, "alcohol_chunks": {}}
    products_vi: list[dict] = []

    def add(doc_id, source, url, title, lang, text):
        chunks = chunk_text(text)
        kept = [c for c in chunks if not is_alcohol(c)]
        stats["alcohol_chunks"][source] = (
            stats["alcohol_chunks"].get(source, 0) + len(chunks) - len(kept))
        if kept:
            docs[doc_id] = _doc(doc_id, source, url, title, lang, kept, model)

    for fn in JSONL_FILES:
        recs = read_source(data_dir / fn)
        if recs is None:
            print(f"[warn] {fn} thiếu/rỗng — KHÔNG xóa chunk của nguồn này", flush=True)
            continue
        trusted.add(fn)
        stats["records"][fn] = len(recs)
        for rec in recs:
            if rec["id"] in seen_ids or rec["id"] == CATALOG_ID:
                raise SourceError(f"{fn}: doc_id trùng '{rec['id']}'")
            seen_ids.add(rec["id"])
            url = rec.get("url") or ""
            title = rec.get("title") or rec.get("name") or ""
            if is_alcohol(title):
                stats["alcohol_records"][fn] = stats["alcohol_records"].get(fn, 0) + 1
                continue
            if "name" in rec and lang_of(url) == "vi":
                products_vi.append(rec)
            add(rec["id"], fn, url, title, lang_of(url), doc_text(rec))

    # Doc tổng hợp "danh mục sản phẩm" — transform thuần từ products.jsonl
    # (không bịa), SAU khi bỏ SKU rượu: câu hỏi "có những sản phẩm nào" cần
    # 1 doc list đủ SKU. Chỉ tin cậy khi products.jsonl tin cậy.
    if "products.jsonl" in trusted:
        trusted.add(CATALOG)
        seen: set[str] = set()
        lines = []
        for p in products_vi:
            if p["name"].casefold() not in seen:
                seen.add(p["name"].casefold())
                lines.append(f"- {p['name']} — Giá: {_price(p)}")
        if lines:
            add(CATALOG_ID, CATALOG, "http://samsam.net.vn/vi/shops/",
                "Danh mục sản phẩm Sâm Sâm", "vi",
                "Danh mục sản phẩm Công ty TNHH Sâm Sâm (kèm giá bán public):\n"
                + "\n".join(lines))
    return docs, trusted, stats


def sync(conn, data_dir: Path = DATA_DIR, model: str = DEFAULT_MODEL) -> dict:
    """Đồng bộ incremental nguồn -> `chunks` (SQL không qualify schema —
    test dùng temp table cùng tên). Trả thống kê."""
    docs, trusted, fstats = build_docs(data_dir, model)
    all_sources = set(JSONL_FILES) | {CATALOG}
    # e = (min sha, max sha, n rows, n rows có sha, max version, min src, max src)
    existing = {r[0]: r[1:] for r in conn.execute(
        "select doc_id, min(doc_sha256), max(doc_sha256), count(*),"
        " count(doc_sha256), max(doc_version), min(source), max(source)"
        " from chunks group by doc_id")}

    def unchanged(d):
        e = existing.get(d["doc_id"])
        return (e is not None and e[0] == e[1] == d["sha"]
                and e[2] == e[3] == len(d["chunks"]) and e[5] == e[6] == d["source"])

    changed = [d for d in docs.values() if not unchanged(d)]
    n_new = sum(d["doc_id"] not in existing for d in changed)
    removed = sorted(
        doc_id for doc_id, e in existing.items() if doc_id not in docs and (
            (e[5] is not None and e[5] == e[6] and e[5] in trusted)
            or (e[5] is None and e[6] is None and trusted == all_sources)))

    texts = [c for d in changed for c in d["chunks"]]
    n_calls = -(-len(texts) // EMBED_BATCH)
    print(f"[plan] doc mới {n_new} / đổi {len(changed) - n_new}"
          f" / giữ {len(docs) - len(changed)} / xóa {len(removed)}"
          f" — embed {len(texts)} chunk ({n_calls} lời gọi)", flush=True)
    vectors = embed_all(None, model, texts) if texts else []

    if changed or removed:
        rows, vi = [], iter(vectors)
        for d in changed:
            e = existing.get(d["doc_id"])
            ver = (e[4] or 0) + 1 if e else 1
            rows += [(d["doc_id"], i, d["source_url"], d["title"], d["lang"], c,
                      next(vi), d["source"], d["sha"], ver)
                     for i, c in enumerate(d["chunks"])]
        with conn.transaction():
            conn.execute("delete from chunks where doc_id = any(%s)",
                         (removed + [d["doc_id"] for d in changed],))
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into chunks (doc_id, chunk_index, source_url, title,"
                    " lang, content, embedding, source, doc_sha256, doc_version,"
                    " ingested_at) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
                    rows)
    conn.commit()
    for fn, n in sorted(fstats["records"].items()):
        print(f"[src] {fn}: {n} records, bỏ {fstats['alcohol_records'].get(fn, 0)}"
              f" record rượu", flush=True)
    for src, n in sorted(fstats["alcohol_chunks"].items()):
        if n:
            print(f"[filter] {src}: bỏ {n} chunk nhắc rượu", flush=True)
    return {"new": n_new, "changed": len(changed) - n_new,
            "kept": len(docs) - len(changed), "deleted": len(removed),
            "embedded_chunks": len(texts), "embed_calls": n_calls,
            "trusted": sorted(trusted), **fstats}


def main() -> int:
    # v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader)
    # — chế độ thực từ chối login superuser/owner/thiếu biến.
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    # v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) —
    # chưa cấu hình + tính năng tắt → không nạp.
    from pipelines import loader_gate
    if why := loader_gate.check("embed_store"):
        print(f"[rollout] {why}", flush=True)
        return 2
    env = load_env()
    try:
        with psycopg.connect(env["dsn"], connect_timeout=CONNECT_TIMEOUT_S) as conn:
            st = sync(conn, DATA_DIR, env["model"])
            n_db = conn.execute("select count(*) from chunks").fetchone()[0]
    except (SourceError, KbFilterError, GatewayError) as e:
        print(f"[err] {type(e).__name__}: {e} — không ghi DB", flush=True)
        return 1
    print(f"[done] mới {st['new']} / đổi {st['changed']} / giữ {st['kept']}"
          f" / xóa {st['deleted']} doc — embed {st['embedded_chunks']} chunk,"
          f" {st['embed_calls']} lời gọi embed (table total: {n_db})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
