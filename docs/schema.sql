-- Supabase/Postgres schema cho pilot. Chạy tay trong SQL Editor trước ingest.
-- pgvector extension phải bật: Database → Extensions → vector

create extension if not exists vector;

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id text not null,            -- id record trong jsonl
  chunk_index int not null,
  source_url text,                 -- bắt buộc: chatbot trích nguồn từ đây
  title text,
  content text not null,
  embedding vector(1536),          -- text-embedding-3-small
  unique (doc_id, chunk_index)
);

-- Tìm kiếm cosine: match theo embedding
create index if not exists chunks_embedding_idx
  on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
