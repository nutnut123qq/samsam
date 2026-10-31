-- ============================================================================
-- Viết lại TS (docs/rewrite/KE_HOACH.md mục 1) — CHỈ THÊM, áp SAU schema.sql +
-- roles.sql + schema_pgvector.sql (cần extension `vector`).
--   * `embedding_v2 vector(1024)` = BGE-M3 (Ollama nội bộ) cạnh `embedding`
--     float8[] / `embedding_v` vector(1536) — cột cũ GIỮ NGUYÊN, RAG Python
--     không đổi. RAG TS chỉ dùng cột này SAU khi embed lại toàn bộ chunks
--     (không trộn chiều: 1536 ≠ 1024, không có trigger đồng bộ từ cột cũ).
--   * Grant theo bảng (roles.sql: select chunks cho svc_webhook/svc_ui) phủ
--     luôn cột mới — không thêm grant.
--   * Ghi vườn qua Zalo cho svc_webhook (grant cột + trigger
--     `webhook_garden_guard`) nay ở roles.sql + schema.sql (r22 A2) — dùng
--     chung Python/TS, không còn ở tệp này.
-- Idempotent: chạy lại sạch (if not exists).
-- ============================================================================

create extension if not exists vector;

alter table chunks add column if not exists embedding_v2 vector(1024);
alter table chunks_internal add column if not exists embedding_v2 vector(1024);

create index if not exists chunks_embedding_v2_hnsw
  on chunks using hnsw (embedding_v2 vector_cosine_ops);
create index if not exists chunks_internal_embedding_v2_hnsw
  on chunks_internal using hnsw (embedding_v2 vector_cosine_ops);

