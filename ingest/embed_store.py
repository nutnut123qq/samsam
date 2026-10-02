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
"""


def main() -> int:
    raise NotImplementedError("T2.1 — xem TASKS.md")


if __name__ == "__main__":
    raise SystemExit(main())
