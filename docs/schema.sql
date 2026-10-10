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

-- ============================================================================
-- DB lõi WS1 (SOW): products / claims_approved / plots / plot_logs / orders /
-- assets. Mọi bảng có cột `source` = file/nguồn nạp ('products.jsonl',
-- 'sample:plots.jsonl', 'manual'...) — loader chỉ xóa-nạp lại rows thuộc
-- source của mình nên không đè dữ liệu nhập tay. `created_at` audit thời điểm
-- nạp. Chỉ `create table if not exists`: không sửa/drop `chunks`.
-- Giới hạn delete-then-insert của loader (someday: upsert on conflict):
-- child row 'manual' trỏ cha managed bị set-null/cascade theo FK sau mỗi reload.
-- ============================================================================

create table if not exists products (
  id text primary key,              -- id record products.jsonl (wc-*/nv-*) hoặc SKU nhập tay
  name text not null,
  price_vnd bigint,                 -- null -> "Liên hệ", KHÔNG suy giá
  description text,
  url text,
  lang text,                        -- 'vi' | 'en' — products.jsonl có bản 2 ngữ
  source text not null,             -- file/nguồn nạp (xem ghi chú đầu block)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claims_approved (
  -- Công dụng ĐÃ CÔNG BỐ theo hồ sơ từng SKU — nguồn sự thật cho guardrail.
  -- sku_key = key trong data/claims_whitelist.json. claim = null nghĩa là
  -- SKU "chưa có công bố" (xem note) — KHÔNG suy diễn.
  id bigint generated always as identity primary key,
  sku_key text not null,
  product_id text references products(id) on delete set null,  -- link best-effort, null = chưa map
  claim text,                       -- verbatim công dụng đã công bố
  source_ref text,                  -- hồ sơ/trang SP trích claim (URL + số ĐKSP)
  note text,
  source text not null,             -- file/nguồn nạp
  created_at timestamptz not null default now()
);
create unique index if not exists claims_approved_sku_claim_idx
  on claims_approved (sku_key, claim);

create table if not exists plots (
  -- Khoảnh/tiểu khu vùng trồng (P1). Dữ liệu pilot = mẫu chờ bàn giao.
  id text primary key,              -- mã khoảnh, vd 'KV-A01'
  location text,
  area_m2 numeric,
  variety text,                     -- giống (vd 'Sâm Ngọc Linh')
  tree_count int,
  planted_year int,
  status text not null default 'active',
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists plot_logs (
  -- Nhật ký vùng trồng = "quy trình nhập liệu mới" của WS1; form/chat
  -- chuẩn hóa vào đây (WS3 agent nhật ký đọc bảng này).
  id bigint generated always as identity primary key,
  plot_id text not null references plots(id) on delete cascade,
  ts timestamptz not null,
  activity text not null,           -- tưới / bón / làm cỏ / sâu bệnh / thu hoạch...
  detail text,
  author text,
  source text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists plot_logs_plot_ts_act_idx
  on plot_logs (plot_id, ts, activity);

create table if not exists orders (
  -- Đơn hàng tối thiểu phục vụ báo cáo/dashboard. KHÔNG lưu PII khách
  -- (tên/SĐT/địa chỉ) ở pilot — channel + mã đơn là đủ.
  id text primary key,              -- mã đơn
  ts timestamptz not null,
  channel text not null,            -- zalo | web | showroom | ...
  product_id text references products(id) on delete set null,
  qty int,
  total_vnd bigint,
  status text not null default 'new',
  note text,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists assets (
  -- Tài sản truyền thông: ảnh/video/bài báo (P0). Ảnh sinh từ
  -- products.images[] có id '<product_id>#img<i>'.
  id text primary key,
  kind text not null,               -- image | video | article | doc
  title text,
  url text,
  product_id text references products(id) on delete set null,
  source text not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- DB lõi WS2 (SOW): leads — lead gom từ kênh chat (convlog) phục vụ
-- dashboard/follow-up. KHÁC loader lõi WS1: KHÔNG delete-by-source —
-- convlog là log xoay + purge 30d, lead là fact suy ra một lần nên
-- `ingest.lead_store` chỉ `insert ... on conflict (dedup_key) do
-- nothing`: chạy lại không nhân đôi, leads sống sót khi entry convlog
-- gốc bị purge. `question`/`user_hash` đã mask/hash tại convlog — bảng
-- này không lưu PII thêm. `status` nhân viên cập nhật ngoài UI.
-- ============================================================================

create table if not exists leads (
  id bigint generated always as identity primary key,
  dedup_key text not null unique,   -- 'convlog:<msg_id>' hoặc 'convlog:<hash16>'
  ts timestamptz not null,          -- ts của entry convlog gốc
  channel text not null,            -- zalo | streamlit (msg_id rỗng -> streamlit)
  user_hash text not null,
  question text,                    -- câu hỏi đã mask PII (tại convlog)
  intent text not null,             -- partner | order | price | contact
  status text not null default 'new',  -- new | contacted | won | lost
  source text not null,             -- 'conversations.jsonl' | 'manual'
  created_at timestamptz not null default now()
);
