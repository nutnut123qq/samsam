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

-- ============================================================================
-- DB lõi WS2 (SOW): content_drafts — hàng duyệt + lịch đăng cho pipeline
-- nội dung đa kênh. Draft do AI sinh (đã qua `pipelines.guardrail.check`
-- lúc tạo — snapshot kết quả trong `guardrail`) chờ NGƯỜI duyệt từng bài.
-- Status one-way: pending -> approved | rejected; approve chỉ hợp lệ khi
-- guardrail->>'ok' = true (double-gate, không override). `scheduled_date`
-- là kế hoạch cho NGƯỜI đăng tay — hệ thống KHÔNG tự đăng (C2.4).
-- KHÁC loader lõi WS1: KHÔNG delete-by-source — draft là tài sản người
-- tạo, chỉ update theo id, không xóa.
-- ============================================================================

create table if not exists content_drafts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  brief text not null,              -- brief người viết nhập ở Studio/CLI
  channel text not null,            -- facebook | tiktok | blog | zalo
  text text not null,               -- nội dung draft (đã qua guardrail)
  guardrail jsonb not null,         -- snapshot check(): {ok, violations[], matched_claims[]}
  status text not null default 'pending',  -- pending | approved | rejected
  reviewer text,
  reviewed_at timestamptz,
  review_note text,
  scheduled_date date,              -- ngày dự kiến đăng (người đăng tay)
  source text not null              -- 'manual:studio' | 'cli'
);

create index if not exists content_drafts_status_idx
  on content_drafts (status);

-- ============================================================================
-- v3.1 LLM gateway (pipelines/llm_gateway.py): 1 dòng / lời gọi LLM/embedding.
-- cost_usd = ước tính theo bảng giá data/llm_gateway.json (giá thật do công ty
-- chốt). Trần chi phí tháng cộng cost theo agent_id từ bảng này. Không lưu
-- prompt/response (chỉ số đếm) — error đã qua _mask_pii, cắt 300 ký tự.
-- ============================================================================

create table if not exists llm_usage (
  id bigserial primary key,
  ts timestamptz not null default now(),
  agent_id text not null,
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  ok boolean not null,
  error text
);

create index if not exists llm_usage_agent_ts_idx on llm_usage (agent_id, ts);

-- ============================================================================
-- v3.2 golden master (WP04a, F15.2 + F14.2): nguồn sự thật DUY NHẤT cho
-- listing / giá / trạng thái pháp lý của SKU đang bán.
-- Ownership: `products` thuộc `ingest.core_store` (crawl web, delete-by-source)
-- và chỉ là "giá web" để đối chiếu — golden nằm ở bảng RIÊNG dưới đây, nạp
-- bởi `ingest.golden_store` từ data/golden_skus.json (upsert theo khóa,
-- KHÔNG delete-by-source; row `source='manual'` không bị đè).
-- `sku_map.product_id` cố ý KHÔNG FK tới products: core_store xóa-nạp lại
-- products mỗi lần chạy → FK sẽ cascade/set-null xóa mapping.
-- `price_list` APPEND-ONLY (trigger): đổi giá = đóng `valid_to` dòng cũ +
-- thêm dòng mới chờ duyệt; chỉ NGƯỜI (GĐ bán hàng) ghi `approved_by` qua
-- `python -m ingest.golden_store --approve-price <id> --by <tên>`.
-- Ngày hiệu lực theo giờ VN: (now() at time zone 'Asia/Ho_Chi_Minh')::date.
-- ============================================================================

create table if not exists sku_master (
  sku_key text primary key,         -- slug ascii, vd 'savina-12v'
  name text not null,
  category text not null check (category in ('tpbvsk', 'food', 'alcohol')),
  pack_spec text,                   -- quy cách, vd '30 viên (hộp 3 vỉ x 10 viên)'
  receipt_no text,                  -- số giấy tiếp nhận ĐKSP (TPBVSK)
  receipt_date date,
  xnqc_status text not null default 'none'
    check (xnqc_status in ('none', 'pending', 'approved')),
  self_declaration_ok boolean,      -- food: hồ sơ tự công bố; null = chưa xác minh
  allowed_channels text[] not null default '{}',
  shopee_item_id text,              -- biến thể có thể chung item id (không unique)
  note text,
  source text not null,             -- 'golden_skus.json' | 'manual'
  version int not null default 1,   -- +1 mỗi lần nạp làm ĐỔI dữ liệu thật
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sku_map (
  -- Đề xuất map crawl ↔ golden (agent đề xuất, Sản xuất duyệt approved_by).
  product_id text not null unique,  -- products.id — KHÔNG FK (xem đầu block)
  sku_key text not null references sku_master(sku_key),
  approved_by text,
  note text,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists price_list (
  id bigint generated always as identity primary key,
  sku_key text not null references sku_master(sku_key),
  channel text not null,            -- shopee | tiktok | web | facebook | zalo | chatbot
  kind text not null check (kind in ('list', 'promo', 'floor')),
  price_vnd bigint not null check (price_vnd > 0),
  program_id text,                  -- chương trình KM; null = giá thường trực
  valid_from date not null,
  valid_to date,                    -- null = đang mở
  approved_by text,                 -- null = chờ GĐ bán hàng duyệt
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
-- 1 dòng MỞ / (sku, kênh, loại giá, chương trình).
create unique index if not exists price_list_open_idx
  on price_list (sku_key, channel, kind, coalesce(program_id, ''))
  where valid_to is null;

create table if not exists golden_discrepancies (
  -- Phiếu lệch golden ↔ crawl. `detail` = giá trị theo TỪNG nguồn; agent
  -- KHÔNG chọn giá. status do người cập nhật, loader không đụng.
  id bigint generated always as identity primary key,
  kind text not null,               -- price_mismatch | spec_mismatch | product_unmapped | sku_no_product | missing_price | alcohol_online_listing
  sku_key text,
  product_id text,
  detail jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed')),
  resolved_by text,
  source text not null,             -- 'golden_store'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists golden_discrepancies_key_idx
  on golden_discrepancies (kind, coalesce(sku_key, ''), coalesce(product_id, ''));

-- price_list append-only: chặn DELETE/TRUNCATE; INSERT chỉ được dòng MỞ
-- CHƯA duyệt (approved_by/approved_at/valid_to đều null) — duyệt chỉ đi qua
-- UPDATE (a), không INSERT sẵn-duyệt vượt cổng người; UPDATE chỉ cho đúng 2
-- chuyển trạng thái một-lần, mọi cột khác giữ nguyên:
--   (a) duyệt: approved_by null -> non-blank (+ approved_at), dòng còn mở;
--   (b) đóng:  valid_to null -> ngày >= valid_from.
-- Role DB `loader` tách quyền là việc hạ tầng cloud (external-dep).
create or replace function price_list_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.approved_by is not null or new.approved_at is not null
       or new.valid_to is not null then
      raise exception 'price_list append-only: INSERT phải là dòng mở chưa duyệt (sku %)', new.sku_key;
    end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'price_list append-only: % bị chặn', tg_op;
  end if;
  if (new.id, new.sku_key, new.channel, new.kind, new.price_vnd,
      new.program_id, new.valid_from, new.created_at)
     is distinct from
     (old.id, old.sku_key, old.channel, old.kind, old.price_vnd,
      old.program_id, old.valid_from, old.created_at) then
    raise exception 'price_list append-only: chỉ được duyệt hoặc đóng dòng (id %)', old.id;
  end if;
  if old.approved_by is null and old.approved_at is null
     and old.valid_to is null
     and new.approved_by is not null and btrim(new.approved_by) <> ''
     and new.valid_to is null then
    return new;
  end if;
  if old.valid_to is null and new.valid_to is not null
     and new.valid_to >= old.valid_from
     and new.approved_by is not distinct from old.approved_by
     and new.approved_at is not distinct from old.approved_at then
    return new;
  end if;
  raise exception 'price_list append-only: UPDATE không hợp lệ (id %)', old.id;
end $$;

create or replace trigger price_list_append_only_row
  before insert or update or delete on price_list
  for each row execute function price_list_append_only();
create or replace trigger price_list_no_truncate
  before truncate on price_list
  for each statement execute function price_list_append_only();

-- F14.2: mức được phép nói/bán theo SKU × kênh online (fail-closed).
--   CAM       rượu mọi kênh online; kênh ngoài allowed_channels; food chưa
--             xác minh tự công bố; thiếu dữ liệu
--   MO_TA     TPBVSK chưa có XNQC — chỉ mô tả, không quảng cáo
--   TP_THUONG thực phẩm thường đã có hồ sơ tự công bố
--   QC_DAY_DU TPBVSK đã có giấy XNQC
create or replace view sku_readiness as
select m.sku_key, c.channel,
  case
    when m.category = 'alcohol' then 'CAM'
    -- coalesce: phần tử NULL trong mảng làm `= any` ra NULL -> fail-closed.
    when not coalesce(c.channel = any (m.allowed_channels), false) then 'CAM'
    when m.category = 'tpbvsk' and m.xnqc_status = 'approved' then 'QC_DAY_DU'
    when m.category = 'tpbvsk' then 'MO_TA'
    when m.category = 'food' and m.self_declaration_ok is true then 'TP_THUONG'
    else 'CAM'
  end as readiness
from sku_master m
cross join (values ('shopee'), ('tiktok'), ('web'), ('facebook'), ('zalo'),
                   ('chatbot')) as c(channel);

-- SKU × kênh được phép quảng bá: readiness đủ VÀ có giá `list` ĐÃ DUYỆT
-- đang hiệu lực hôm nay (giờ VN).
create or replace view v_promotable as
select r.sku_key, r.channel, r.readiness, p.id as price_id, p.price_vnd,
       p.approved_by
from sku_readiness r
join price_list p
  on p.sku_key = r.sku_key and p.channel = r.channel and p.kind = 'list'
 and p.approved_by is not null
 and p.valid_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
 and (p.valid_to is null
      or p.valid_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
where r.readiness in ('TP_THUONG', 'QC_DAY_DU');

-- ============================================================================
-- v3.3 connector sàn (WP04a, F01b): staging file CSV/XLSX Quản lý MXH xuất
-- tay từ Seller Center Shopee / TikTok Shop, nạp bởi `ingest.market_csv`.
-- CHỈ ĐỌC sàn: agent không gọi sàn, không đổi giá/listing, KHÔNG ghi bảng
-- golden (sku_master/sku_map/price_list) hay products — chỉ ghi 3 bảng dưới.
-- Không PII người mua: cột tên/SĐT/địa chỉ/ghi chú bị bỏ ngay khi đọc file,
-- mã đơn chỉ lưu hash (`order_id_hash`). Idempotent theo `file_sha256`
-- (nạp lại cùng file = bỏ qua). `market_alerts` mở/đóng theo export kế tiếp;
-- `detail` = giá trị theo TỪNG nguồn, không có "giá nên đặt".
-- ============================================================================

create table if not exists market_snapshots (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('shopee', 'tiktok')),
  export_kind text not null check (export_kind in ('listing', 'order', 'ads')),
  file_name text not null,          -- basename, không đường dẫn
  file_sha256 text not null unique,
  row_count int not null,
  imported_at timestamptz not null default now()
);

create table if not exists market_rows (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references market_snapshots(id),
  row_no int not null,              -- số dòng trong file (header = 1)
  channel text not null,
  export_kind text not null,
  item_id text,
  seller_sku text,
  sku_key text,                     -- null = không map được golden; không FK
  title text,
  price_vnd bigint,
  stock int,
  status text,
  ads_spend_vnd bigint,
  qty int,
  order_id_hash text,               -- sha256(channel:order_id)[:16]
  raw jsonb not null,               -- CHỈ field allowlist đã chuẩn hóa
  unique (snapshot_id, row_no)
);

create table if not exists market_alerts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('alcohol_listed', 'price_mismatch',
                                     'tpbvsk_ads_no_xnqc', 'item_unmapped')),
  severity text not null check (severity in ('S1', 'S2')),
  channel text not null,
  export_kind text not null,
  item_id text,
  seller_sku text,
  sku_key text,
  detail jsonb not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  snapshot_id bigint references market_snapshots(id),  -- lần thấy gần nhất
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index if not exists market_alerts_key_idx
  on market_alerts (kind, channel, export_kind, coalesce(item_id, ''),
                    coalesce(seller_sku, ''));

-- ============================================================================
-- v3.5 nghiệm thu (F17.1): 1 dòng / lần chạy scripts/agent_eval.py cho 1 agent
-- tại 1 commit. scripts/deploy_gate.py chỉ cho deploy SHA khi row MỚI NHẤT
-- của mọi agent bắt buộc có passed=true. commit_sha '<sha>-dirty' = chạy trên
-- working tree bẩn — không bao giờ khớp deploy. Bản thật: n8n ghi qua webhook
-- HMAC, role ci không quyền ghi (external-dep).
-- ============================================================================

create table if not exists eval_runs (
  id bigserial primary key,
  ts timestamptz not null default now(),
  commit_sha text not null,
  agent text not null,
  n_total int,
  n_pass int,
  pass_rate numeric not null,
  threshold numeric,
  passed boolean not null,
  model text,
  prompt_version text,
  note text
);

create index if not exists eval_runs_sha_agent_idx
  on eval_runs (commit_sha, agent, ts);

-- ============================================================================
-- v3.7 ops monitoring (pipelines/job_runs.py): 1 dòng / lần chạy job lịch
-- (ghi 1 INSERT lúc job kết thúc — process bị kill cứng thì không có dòng,
-- bản tin sức khỏe báo "không chạy/trễ"). detail đã qua _mask_pii, cắt 300.
-- ============================================================================

create table if not exists job_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  ok boolean,
  detail text,
  host text
);

create index if not exists job_runs_job_started_idx on job_runs (job, started_at);

-- ============================================================================
-- v3.8 WP04b / F15.1 số hóa tài liệu (`ingest/doc_intake.py`): bản gốc bất
-- biến ở kho `originals/<sha256>` (dir local DOC_ORIGINALS_DIR); DB chỉ giữ
-- metadata + field trích TẤT ĐỊNH (regex, không LLM) — KHÔNG lưu full text.
-- Idempotent theo sha256 (on conflict do nothing). status: cho_ocr (chưa có
-- text) | pending_review | verified | rejected — verified/rejected chỉ do
-- người (CLI --verify/--reject --by). pii_flag NULL = chưa quét được text.
-- ============================================================================

create table if not exists documents (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  filename text not null,           -- tên file gốc (có thể chứa tên người — không in stdout)
  doc_type text not null,           -- giay_tiep_nhan | nhan | hop_dong_dai_ly | ho_so_vung_trong | khac
  pages int,
  text_source text not null check (text_source in ('pdf_text', 'ocr', 'none')),
  pii_flag boolean,                 -- true = có SĐT/email -> CẤM gửi LLM; null = chưa quét
  status text not null default 'pending_review'
    check (status in ('cho_ocr', 'pending_review', 'verified', 'rejected')),
  verified_by text,                 -- người Pháp chế xác nhận/từ chối
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists documents_status_idx on documents (status);

create table if not exists document_fields (
  sha256 text references documents(sha256) on delete restrict,
  field text not null,              -- so_giay | ngay_cap | ten_san_pham
  value text not null,
  confidence numeric check (confidence between 0 and 1),
  verified boolean not null default false,
  primary key (sha256, field)
);

-- ============================================================================
-- v3.9 kb-acl (WP04b, F15.3): `chunks` CHỈ chứa corpus CÔNG KHAI cho chatbot
-- khách (Zalo + tab Chat cùng gọi api.rag.answer()). Tài liệu NỘI BỘ nằm ở
-- bảng RIÊNG `chunks_internal` — cách ly bằng cấu trúc: caller mới quên 1
-- mệnh đề WHERE cũng không đọc nhầm được. Chỉ THÊM cột/bảng, không đổi cũ.
-- Cột incremental trên `chunks`: embed_store chỉ embed lại doc đổi hash.
-- ============================================================================

alter table chunks add column if not exists source text;  -- products.jsonl|articles.jsonl|about.jsonl|news.jsonl|catalog
alter table chunks add column if not exists doc_sha256 text;  -- hash (model, source, title, url, lang, chunks sau lọc)
alter table chunks add column if not exists doc_version int not null default 1;
alter table chunks add column if not exists ingested_at timestamptz not null default now();

-- Tài liệu nội bộ ĐÃ DUYỆT theo phòng — nạp bằng `python -m ingest.kb_internal`
-- (bắt buộc --approved-by trưởng phòng). Chatbot khách KHÔNG có đường đọc.
create table if not exists chunks_internal (
  id uuid primary key default gen_random_uuid(),
  collection text not null check (collection ~ '^internal:[a-z0-9_]{1,32}$'),
  doc_id text not null,
  chunk_index int not null,
  title text,
  source_ref text,                 -- tên file gốc, không phải URL public
  content text not null,
  embedding float8[],
  doc_sha256 text not null,
  doc_version int not null default 1,
  approved_by text not null check (btrim(approved_by) <> ''),
  approved_at timestamptz not null default now(),
  ingested_at timestamptz not null default now(),
  unique (collection, doc_id, chunk_index)
);

create index if not exists chunks_internal_collection_idx on chunks_internal (collection);
