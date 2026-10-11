"""CLI nạp 1 tài liệu NỘI BỘ ĐÃ DUYỆT vào `chunks_internal` (v3.9 W39.5).

  python -m ingest.kb_internal --file <.md|.txt> --collection internal:<phong> \\
      --approved-by "<trưởng phòng>" [--doc-id <slug>]

Contract:
  - CHỈ chạy sau khi trưởng phòng duyệt tài liệu — `--approved-by` là tên
    NGƯỜI THẬT đã duyệt; agent/test không tự điền tên người thật.
  - Validate HẾT trước khi connect DB và trước khi embed (lỗi -> exit 2):
    approved-by trống; collection sai `^internal:[a-z0-9_]{1,32}$`; file
    không tồn tại / 0 byte / chỉ trắng / đuôi khác .md|.txt / không phải
    UTF-8 / > 1MB; doc-id sai slug.
  - Bảng RIÊNG `chunks_internal` (chatbot khách `answer()` không đọc tới).
  - `doc_sha256` trùng bản đang có cùng (collection, doc_id) -> 0 embed,
    "không đổi"; đổi -> embed (qua gateway, `embed_store.embed_all`) xong
    mới delete+insert trong 1 transaction, `doc_version`+1, commit tường minh.
  - Print chỉ collection/doc_id/số chunk — KHÔNG in nội dung file.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest.embed_store import CONNECT_TIMEOUT_S, DEFAULT_MODEL, chunk_text, embed_all
from pipelines.llm_gateway import _strip_accents

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
COLLECTION_RE = re.compile(r"internal:[a-z0-9_]{1,32}")
DOC_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
MAX_BYTES = 1_000_000
SUFFIXES = {".md", ".txt"}


def slug(stem: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", _strip_accents(stem).casefold())
    return s.strip("-")[:64]


def parse_args(argv=None) -> tuple[argparse.Namespace, str]:
    """Validate toàn bộ input -> (args, text). Lỗi -> ap.error (exit 2)."""
    ap = argparse.ArgumentParser(prog="python -m ingest.kb_internal",
                                 description="Nạp tài liệu nội bộ ĐÃ DUYỆT")
    ap.add_argument("--file", required=True)
    ap.add_argument("--collection", required=True)
    ap.add_argument("--approved-by", required=True)
    ap.add_argument("--doc-id")
    a = ap.parse_args(argv)
    a.approved_by = a.approved_by.strip()
    if not a.approved_by or len(a.approved_by) > 200:
        ap.error("--approved-by phải là tên người duyệt (1-200 ký tự)")
    if not COLLECTION_RE.fullmatch(a.collection):
        ap.error("--collection phải dạng internal:<phong> ([a-z0-9_]{1,32})")
    path = Path(a.file)
    if path.suffix.lower() not in SUFFIXES:
        ap.error("--file chỉ nhận .md hoặc .txt")
    if not path.is_file():
        ap.error("--file không tồn tại")
    size = path.stat().st_size
    if size == 0 or size > MAX_BYTES:
        ap.error(f"--file rỗng hoặc > {MAX_BYTES} byte")
    try:
        text = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        ap.error("--file không đọc được dạng UTF-8")
    if not text.strip():
        ap.error("--file chỉ có khoảng trắng")
    a.doc_id = a.doc_id if a.doc_id is not None else slug(path.stem)
    if not DOC_ID_RE.fullmatch(a.doc_id):
        ap.error("--doc-id phải là slug [a-z0-9_-] (<=64)")
    a.path = path
    return a, text


def ingest_doc(conn, *, collection: str, doc_id: str, title: str,
               source_ref: str, text: str, approved_by: str,
               model: str = DEFAULT_MODEL) -> dict:
    """Nạp/cập nhật 1 doc vào `chunks_internal`. -> {status, chunks, version}."""
    chunks = chunk_text(text)
    sha = hashlib.sha256(json.dumps(
        [model, collection, doc_id, title, source_ref, chunks],
        ensure_ascii=False).encode("utf-8")).hexdigest()
    mn, mx, n, ver = conn.execute(
        "select min(doc_sha256), max(doc_sha256), count(*), max(doc_version)"
        " from chunks_internal where collection = %s and doc_id = %s",
        (collection, doc_id)).fetchone()
    if n and mn == mx == sha and n == len(chunks):
        conn.commit()
        return {"status": "unchanged", "chunks": n, "version": ver}
    vectors = embed_all(None, model, chunks)
    ver = (ver or 0) + 1
    with conn.transaction():
        conn.execute("delete from chunks_internal where collection = %s"
                     " and doc_id = %s", (collection, doc_id))
        with conn.cursor() as cur:
            cur.executemany(
                "insert into chunks_internal (collection, doc_id, chunk_index,"
                " title, source_ref, content, embedding, doc_sha256,"
                " doc_version, approved_by, approved_at, ingested_at)"
                " values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),now())",
                [(collection, doc_id, i, title, source_ref, c, v, sha, ver,
                  approved_by) for i, (c, v) in enumerate(zip(chunks, vectors))])
    conn.commit()
    return {"status": "loaded", "chunks": len(chunks), "version": ver}


def connect():
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env", flush=True)
        raise SystemExit(1)
    return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)


def main(argv=None) -> int:
    a, text = parse_args(argv)
    conn = connect()
    try:
        r = ingest_doc(conn, collection=a.collection, doc_id=a.doc_id,
                       title=a.path.stem, source_ref=a.path.name, text=text,
                       approved_by=a.approved_by,
                       model=os.environ.get("OR_EMBED_MODEL", DEFAULT_MODEL))
    finally:
        conn.close()
    state = "không đổi (0 embed)" if r["status"] == "unchanged" else "đã nạp"
    print(f"[kb-internal] {a.collection} / {a.doc_id}: {state} — "
          f"{r['chunks']} chunk, version {r['version']}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
