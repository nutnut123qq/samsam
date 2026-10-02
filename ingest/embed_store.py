"""Entry point: `python -m ingest.embed_store` → nạp data/*.jsonl vào pgvector.

Contract:
  - Đọc SUPABASE_URL / SUPABASE_KEY / OPENAI_API_KEY từ .env.
  - Chunk mỗi record (body/description) ~500-800 ký tự, overlap ~80.
  - Embed bằng model trong .env (mặc định text-embedding-3-small).
  - Bảng `chunks(id uuid pk, doc_id text, source_url text, title text,
    content text, embedding vector(1536))` — tạo bởi docs/schema.sql,
    KHÔNG tạo bảng từ code (migration sống ở docs/).
  - Idempotent: chạy lại không nhân đôi (upsert theo doc_id+chunk_index
    hoặc xóa-nạp lại — chọn 1 cách, ghi vào docstring khi làm).
"""


def main() -> int:
    raise NotImplementedError("T2.1 — xem TASKS.md")


if __name__ == "__main__":
    raise SystemExit(main())
