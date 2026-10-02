-- Schema Postgres local cho pilot. Chạy tay: psql -d samsam -f docs/schema.sql
-- Embedding lưu float8[] (không cần pgvector) — cosine tính trong app bằng numpy.
-- Nếu sau này cài pgvector: đổi cột thành vector(1536) + ivfflat index.

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id text not null,            -- id record trong jsonl
  chunk_index int not null,
  source_url text,                 -- bắt buộc: chatbot trích nguồn từ đây
  title text,
  lang text,                       -- 'vi' | 'en' — records ngoclinh.com có bản 2 ngữ
  content text not null,
  embedding float8[],              -- text-embedding-3-small qua OpenRouter, 1536 dims
  unique (doc_id, chunk_index)
);

create index if not exists chunks_doc_id_idx on chunks (doc_id);
