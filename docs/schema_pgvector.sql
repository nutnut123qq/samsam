-- ============================================================================
-- v10.3 (WP16 nền P2) — migration pgvector TÙY CHỌN cho RAG.
-- TÁCH khỏi schema.sql: Postgres không có extension `vector` sẽ lỗi ở
-- `create extension` → chỉ chạy qua `python scripts/apply_schema.py
-- --pgvector` (kiểm `pg_available_extensions` trước; thiếu → exit 3,
-- external-dep, không đụng gì).
--   * CHỈ THÊM: cột `embedding_v vector(1536)` cạnh `embedding float8[]`.
--     Cột float8[] GIỮ NGUYÊN — rollback = đặt lại RAG_VECTOR_BACKEND=float8,
--     không cần migrate ngược.
--   * Writer (`ingest.embed_store`, `ingest.kb_internal`) KHÔNG đổi: trigger
--     `before insert or update of embedding` đồng bộ embedding_v ở DB. Lệch
--     chiều (≠1536) → lỗi to khi ghi (nhất quán: float8 hiện tại cũng vỡ
--     khi trộn chiều).
--   * Index HNSW cosine cho retrieve backend `pgvector` (api/rag.py).
-- Idempotent: chạy lại sạch (if not exists / create or replace).
-- ============================================================================

create extension if not exists vector;

alter table chunks add column if not exists embedding_v vector(1536);
alter table chunks_internal add column if not exists embedding_v vector(1536);

update chunks set embedding_v = embedding::vector
  where embedding is not null and embedding_v is null;
update chunks_internal set embedding_v = embedding::vector
  where embedding is not null and embedding_v is null;

create or replace function sync_embedding_v() returns trigger
language plpgsql as $$
begin
  if new.embedding is null then
    new.embedding_v := null;
  else
    new.embedding_v := new.embedding::vector;
  end if;
  return new;
end;
$$;

create or replace trigger chunks_embedding_v_sync
  before insert or update of embedding on chunks
  for each row execute function sync_embedding_v();
create or replace trigger chunks_internal_embedding_v_sync
  before insert or update of embedding on chunks_internal
  for each row execute function sync_embedding_v();

create index if not exists chunks_embedding_v_hnsw
  on chunks using hnsw (embedding_v vector_cosine_ops);
create index if not exists chunks_internal_embedding_v_hnsw
  on chunks_internal using hnsw (embedding_v vector_cosine_ops);
