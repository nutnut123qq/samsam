"""Entry point: `python -m ingest.embed_store` → nạp data/*.jsonl vào Postgres local.

Contract:
  - Đọc OPENROUTER_API_KEY / DATABASE_URL / OR_EMBED_MODEL từ .env.
  - LLM client: `openai.OpenAI(base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY)` — dùng chung cho chat lẫn embeddings.
  - Chunk mỗi record (body/description) ~500-800 ký tự, overlap ~80.
  - Embed bằng OR_EMBED_MODEL (mặc định openai/text-embedding-3-small, 1536 dims).
  - Bảng `chunks` — tạo bởi docs/schema.sql, KHÔNG tạo bảng từ code.
    embedding cột float8[]; similarity tính bằng numpy lúc query.
  - Idempotent: chạy lại không nhân đôi (upsert theo doc_id+chunk_index
    hoặc xóa-nạp lại — chọn 1 cách, ghi vào docstring khi làm).

Cách đã chọn (ghi theo contract): xóa-nạp lại theo doc_id — DELETE các
doc_id có trong batch hiện tại rồi INSERT, nên chạy lại không nhân đôi
và record bị xóa khỏi jsonl cũng biến mất khỏi DB.
Thêm so contract gốc: cột `lang` ('vi'|'en') — audit M1 thấy ngoclinh.com
có bản EN/VI trùng nhau, tag lang để query lọc/ưu tiên. Product giá null
render "Giá: Liên hệ" — RAG không được bịa giá.
"""

import json
import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
JSONL_FILES = ["products.jsonl", "articles.jsonl", "about.jsonl", "news.jsonl"]

CHUNK_SIZE = 700
CHUNK_OVERLAP = 80
EMBED_BATCH = 64


def load_env() -> dict:
    load_dotenv(ROOT / ".env")
    key = os.environ.get("OPENROUTER_API_KEY")
    dsn = os.environ.get("DATABASE_URL")
    if not key or not dsn:
        print("[err] thiếu OPENROUTER_API_KEY hoặc DATABASE_URL trong .env")
        sys.exit(1)
    return {"api_key": key, "dsn": dsn,
            "model": os.environ.get("OR_EMBED_MODEL", "openai/text-embedding-3-small")}


def doc_text(rec: dict) -> str:
    """Record jsonl → text để chunk. Product: kèm dòng Giá verbatim —
    null -> 'Liên hệ' để RAG không bịa giá."""
    if "name" in rec:  # products.jsonl
        price = (f"{rec['price_vnd']:,} đ".replace(",", ".")
                 if rec.get("price_vnd") else "Liên hệ")
        return f"Sản phẩm: {rec['name']}\nGiá: {price}\n{rec.get('description', '')}"
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


def embed_all(client: OpenAI, model: str, texts: list[str]) -> list[list[float]]:
    """Embed theo batch; lỗi API raise — ingest fail sớm còn hơn nạp thiếu."""
    out = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        resp = client.embeddings.create(model=model, input=batch)
        out.extend(d.embedding for d in resp.data)
        print(f"[embed] batch {i // EMBED_BATCH + 1}: {len(batch)} texts", flush=True)
    return out


def main() -> int:
    env = load_env()
    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=env["api_key"])

    # 1. Đọc jsonl -> danh sách (doc_id, title, url, lang, chunks)
    rows = []
    products_vi: list[dict] = []  # gom để dựng doc "danh mục sản phẩm"
    for fn in JSONL_FILES:
        path = DATA_DIR / fn
        if not path.exists():
            print(f"[warn] thiếu {path} — bỏ qua", flush=True)
            continue
        n = 0
        for line in path.open(encoding="utf-8"):
            rec = json.loads(line)
            if "name" in rec and lang_of(rec.get("url", "")) == "vi":
                products_vi.append(rec)
            text = doc_text(rec)
            for idx, chunk in enumerate(chunk_text(text)):
                rows.append({
                    "doc_id": rec["id"], "chunk_index": idx,
                    "source_url": rec.get("url", ""),
                    "title": rec.get("title") or rec.get("name") or "",
                    "lang": lang_of(rec.get("url", "")),
                    "content": chunk,
                })
            n += 1
        print(f"[src] {fn}: {n} records", flush=True)

    # Doc tổng hợp "danh mục sản phẩm" — transform thuần từ products.jsonl
    # (không bịa): câu hỏi dạng "có những sản phẩm nào" cần 1 doc list đủ SKU.
    seen: set[str] = set()
    lines = []
    for p in products_vi:
        key = p["name"].casefold()
        if key in seen:
            continue
        seen.add(key)
        price = (f"{p['price_vnd']:,} đ".replace(",", ".")
                 if p.get("price_vnd") else "Liên hệ")
        lines.append(f"- {p['name']} — Giá: {price}")
    if lines:
        text = ("Danh mục sản phẩm Công ty TNHH Sâm Sâm (kèm giá bán public):\n"
                + "\n".join(lines))
        for idx, chunk in enumerate(chunk_text(text)):
            rows.append({
                "doc_id": "catalog-products", "chunk_index": idx,
                "source_url": "http://samsam.net.vn/vi/shops/",
                "title": "Danh mục sản phẩm Sâm Sâm",
                "lang": "vi", "content": chunk,
            })
        print(f"[src] catalog-products: {len(lines)} dòng SKU", flush=True)

    # 2. Embed toàn bộ chunk
    print(f"[embed] tổng {len(rows)} chunks, model {env['model']}", flush=True)
    vectors = embed_all(client, env["model"], [r["content"] for r in rows])

    # 3. Xóa-nạp lại theo doc_id (idempotent)
    doc_ids = sorted({r["doc_id"] for r in rows})
    with psycopg.connect(env["dsn"]) as conn:
        conn.execute("delete from chunks where doc_id = any(%s)", (doc_ids,))
        with conn.cursor() as cur:
            cur.executemany(
                "insert into chunks (doc_id, chunk_index, source_url, title, lang,"
                " content, embedding) values (%s,%s,%s,%s,%s,%s,%s)",
                [(r["doc_id"], r["chunk_index"], r["source_url"], r["title"],
                  r["lang"], r["content"], v) for r, v in zip(rows, vectors)],
            )
        n_db = conn.execute("select count(*) from chunks").fetchone()[0]
    print(f"[done] {len(rows)} chunks / {len(doc_ids)} docs -> chunks "
          f"(table total: {n_db})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
