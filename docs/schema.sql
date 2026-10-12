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

-- ============================================================================
-- v3.4 duyệt & log (WP03 "Hàng duyệt"): DB chặn tự duyệt bằng QUYỀN chứ không
-- bằng quy ước.
--   * `content_drafts.created_by` — người/agent tạo draft. null = draft trước
--     v3.4 → approve_draft từ chối (fail-closed: không biết ai tạo thì không
--     kiểm được "người duyệt ≠ người tạo").
--   * `approvals` — mỗi quyết định duyệt/từ chối 1 dòng kèm sha256 nội dung
--     ĐÚNG lúc duyệt; bản phát hành phải khớp sha (`verify_publish`). Chỉ
--     function SECURITY DEFINER ghi; app_human đọc. Append-only (trigger).
--   * `agent_action_log` — nhật ký hành động agent/người, append-only + hash
--     chain (prev_hash → row_hash). Ai ghi: agent_writer (INSERT 5 cột) +
--     function duyệt; ai đọc: app_human. Trigger INSERT ép id/ts/db_role/hash
--     (không tin client). `verify_action_log()` phát hiện sửa/xóa GIỮA chuỗi.
--     Giới hạn: xóa dòng CUỐI chuỗi không phát hiện được bằng chuỗi thuần —
--     cần neo hash ra ngoài (object-lock, external-dep WP03 anchor).
--   * Function duyệt: SECURITY DEFINER + search_path ghim `<schema>, pg_temp`
--     (pg_temp CUỐI, chặn bảng tạm giả mạo) + revoke execute khỏi PUBLIC.
--     Quyền role ở `docs/roles.sql` (agent_writer / app_human).
-- Hash canonical KHÔNG phụ thuộc TimeZone/DateStyle của session: ts quy về
-- epoch micro-giây (bigint), không dùng ts::text. sha256 nội dung byte-exact
-- UTF-8 (== Python hashlib.sha256(t.encode('utf-8'))).
-- Ngày "không quá khứ" tính theo giờ VN (bài học date-UTC v2.4).
-- ============================================================================

-- Ghim search_path = <schema hiện tại>, pg_temp cho các function SECURITY
-- DEFINER bên dưới (`set search_path from current`), kể cả khi chạy tay bằng
-- psql với search_path mặc định ("$user", public — pg_temp ngầm ĐỨNG ĐẦU).
do $$
begin
  perform set_config('search_path',
                     quote_ident(current_schema()) || ', pg_temp', false);
end $$;

alter table content_drafts add column if not exists created_by text;

-- v6.1 (MKT-02 content + listing): ngữ cảnh draft theo CỘT — store chạy luật
-- đăng bài (check_publish) đúng loại/SKU của draft lúc lưu và lúc duyệt.
-- Draft cũ tự thành 'post' / is_ai=true (= ngữ cảnh cố định v4.2).
--   content_type  — loại nội dung (key content_types data/guardrail_rules.json:
--                   post | ads | listing | ...)
--   sku           — sku_key golden (null = không gắn SKU)
--   is_ai         — nội dung do AI sinh (mặc định true fail-closed). CHỈ
--                   truy vết: lúc duyệt store luôn bắt nhãn AI (agent_writer
--                   ghi được cột này — không tin để bỏ nhãn)
--   prompt_version / prompt_sha256 — template data/prompts/ dùng để sinh
--                   (manifest.json) — truy vết bản prompt nào ra bài nào
alter table content_drafts add column if not exists content_type text not null default 'post';
alter table content_drafts add column if not exists sku text;
alter table content_drafts add column if not exists is_ai boolean not null default true;
alter table content_drafts add column if not exists prompt_version text;
alter table content_drafts add column if not exists prompt_sha256 text;

-- Batch listing idempotent: 1 nháp listing sống / (sku, kênh, prompt_version)
-- — chặn nhân đôi cả khi 2 batch chạy song song; bản bị reject thì sinh lại
-- được.
create unique index if not exists content_drafts_listing_key_idx
  on content_drafts (sku, channel, prompt_version)
  where content_type = 'listing' and status <> 'rejected';

create table if not exists approvals (
  id bigint generated always as identity primary key,
  object_type text not null,        -- v3.4: 'content_draft'
  object_id text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('approved', 'rejected')),
  approved_by text not null check (btrim(approved_by) <> ''),
  approved_at timestamptz not null default now(),
  db_role text not null default session_user,
  note text
);
create index if not exists approvals_object_idx
  on approvals (object_type, object_id, id);

create table if not exists agent_action_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor text not null check (btrim(actor) <> ''),
  action text not null,             -- draft_create | draft_approve | draft_reject | draft_schedule
  object_type text,
  object_id text,
  detail jsonb not null default '{}',
  db_role text not null default session_user,
  prev_hash text not null,
  row_hash text not null unique
);

-- Chặn UPDATE/DELETE/TRUNCATE cho bảng append-only (approvals, log).
create or replace function append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% append-only: % bị chặn', tg_table_name, tg_op;
end $$;
revoke execute on function append_only_guard() from public;

create or replace trigger approvals_append_only_row
  before update or delete on approvals
  for each row execute function append_only_guard();
create or replace trigger approvals_no_truncate
  before truncate on approvals
  for each statement execute function append_only_guard();
create or replace trigger agent_action_log_append_only_row
  before update or delete on agent_action_log
  for each row execute function append_only_guard();
create or replace trigger agent_action_log_no_truncate
  before truncate on agent_action_log
  for each statement execute function append_only_guard();

-- Hash 1 dòng log (dùng chung cho trigger INSERT và verify).
create or replace function action_log_row_hash(
  p_prev text, p_id bigint, p_actor text, p_action text, p_object_type text,
  p_object_id text, p_detail jsonb, p_db_role text, p_ts timestamptz)
returns text language sql stable as $$
  select encode(sha256(convert_to(p_prev || jsonb_build_array(
    p_id, p_actor, p_action, p_object_type, p_object_id, p_detail, p_db_role,
    (extract(epoch from p_ts) * 1000000)::bigint)::text, 'UTF8')), 'hex')
$$;
revoke execute on function action_log_row_hash(text, bigint, text, text, text,
  text, jsonb, text, timestamptz) from public;

-- INSERT log: khóa advisory theo bảng (tuần tự hóa chuỗi), cấp id SAU khi giữ
-- khóa (id tăng đúng thứ tự chuỗi kể cả khi 2 transaction chèn song song —
-- id lấy từ default trước khi chờ khóa có thể nhỏ hơn dòng tx kia vừa
-- commit), ép ts/db_role/prev_hash/row_hash — giá trị client gửi bị ghi đè.
-- Chỉ READ COMMITTED: snapshot REPEATABLE READ không thấy dòng vừa commit
-- của tx khác → 2 dòng cùng prev_hash (rẽ nhánh chuỗi).
create or replace function agent_action_log_chain() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_prev text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'agent_action_log: chỉ ghi trong READ COMMITTED (hash chain)';
  end if;
  perform pg_advisory_xact_lock(tg_relid::bigint);
  new.id := nextval(pg_get_serial_sequence(
    quote_ident(tg_table_schema) || '.' || quote_ident(tg_table_name), 'id'));
  new.ts := now();
  new.db_role := session_user;
  new.detail := coalesce(new.detail, '{}'::jsonb);
  select l.row_hash into v_prev from agent_action_log l
    order by l.id desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.row_hash := action_log_row_hash(new.prev_hash, new.id, new.actor,
    new.action, new.object_type, new.object_id, new.detail, new.db_role,
    new.ts);
  return new;
end $$;
revoke execute on function agent_action_log_chain() from public;

create or replace trigger agent_action_log_chain_ins
  before insert on agent_action_log
  for each row execute function agent_action_log_chain();

-- Kiểm chuỗi: rỗng = nguyên vẹn. problem 'row_hash' = nội dung dòng bị sửa;
-- 'prev_hash' = dòng ngay trước bị xóa/chèn/sửa hash.
create or replace function verify_action_log()
returns table (id bigint, problem text)
language plpgsql stable security definer set search_path from current as $$
declare
  r record;
  v_prev text := repeat('0', 64);
begin
  for r in select l.* from agent_action_log l order by l.id loop
    if r.prev_hash is distinct from v_prev then
      id := r.id; problem := 'prev_hash'; return next;
    end if;
    if r.row_hash is distinct from action_log_row_hash(r.prev_hash, r.id,
        r.actor, r.action, r.object_type, r.object_id, r.detail, r.db_role,
        r.ts) then
      id := r.id; problem := 'row_hash'; return next;
    end if;
    v_prev := r.row_hash;
  end loop;
end $$;
revoke execute on function verify_action_log() from public;

-- Bản phát hành khớp bản đã duyệt? Quyết định MỚI NHẤT của object phải là
-- 'approved' VÀ sha256(p_content) = content_sha256. Không có quyết định → false.
create or replace function verify_publish(p_object_type text,
  p_object_id text, p_content text)
returns boolean
language sql stable security definer set search_path from current as $$
  select coalesce((
    select a.decision = 'approved'
       and p_content is not null
       and a.content_sha256
           = encode(sha256(convert_to(p_content, 'UTF8')), 'hex')
    from approvals a
    where a.object_type = p_object_type and a.object_id = p_object_id
    order by a.id desc limit 1), false)
$$;
revoke execute on function verify_publish(text, text, text) from public;

-- Duyệt draft: chỉ pending, guardrail ok, có người tạo, người duyệt ≠ người
-- tạo (so khớp không phân biệt hoa thường/khoảng trắng). Cùng 1 transaction:
-- đổi status + approvals (sha256 text hiện tại) + log. Trả id approvals.
create or replace function approve_draft(p_id bigint, p_approver text,
  p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  d content_drafts%rowtype;
  v_by text := btrim(coalesce(p_approver, ''));
  v_sha text;
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người duyệt';
  end if;
  select * into d from content_drafts c where c.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy draft #%', p_id;
  end if;
  if d.status <> 'pending' then
    raise exception 'draft #% đã ở trạng thái %, chỉ duyệt từ pending',
      p_id, d.status;
  end if;
  if coalesce(d.guardrail->>'ok', '') <> 'true' then
    raise exception 'draft #% vi phạm guardrail (ok != true), không duyệt được',
      p_id;
  end if;
  if btrim(coalesce(d.created_by, '')) = '' then
    raise exception 'draft #% không có người tạo (trước v3.4), không duyệt được',
      p_id;
  end if;
  if lower(btrim(d.created_by)) = lower(v_by) then
    raise exception 'người duyệt trùng người tạo draft #%, cần người khác duyệt',
      p_id;
  end if;
  v_sha := encode(sha256(convert_to(d.text, 'UTF8')), 'hex');
  update content_drafts c set status = 'approved', reviewer = v_by,
         reviewed_at = now(), review_note = p_note
   where c.id = p_id;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('content_draft', p_id::text, v_sha, 'approved', v_by, p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'draft_approve', 'content_draft', p_id::text,
          jsonb_build_object('approval_id', v_aid, 'content_sha256', v_sha));
  return v_aid;
end $$;
revoke execute on function approve_draft(bigint, text, text) from public;

-- Từ chối: pending -> rejected. Người tạo tự rút bài được (không áp luật ≠).
create or replace function reject_draft(p_id bigint, p_reviewer text,
  p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  d content_drafts%rowtype;
  v_by text := btrim(coalesce(p_reviewer, ''));
  v_sha text;
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người duyệt';
  end if;
  select * into d from content_drafts c where c.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy draft #%', p_id;
  end if;
  if d.status <> 'pending' then
    raise exception 'draft #% đã ở trạng thái %, chỉ từ chối từ pending',
      p_id, d.status;
  end if;
  v_sha := encode(sha256(convert_to(d.text, 'UTF8')), 'hex');
  update content_drafts c set status = 'rejected', reviewer = v_by,
         reviewed_at = now(), review_note = p_note
   where c.id = p_id;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('content_draft', p_id::text, v_sha, 'rejected', v_by, p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'draft_reject', 'content_draft', p_id::text,
          jsonb_build_object('approval_id', v_aid, 'content_sha256', v_sha));
  return v_aid;
end $$;
revoke execute on function reject_draft(bigint, text, text) from public;

-- Xếp lịch: chỉ draft approved, ngày ≥ hôm nay (giờ VN), và text hiện tại
-- khớp sha bản đã duyệt (sửa text sau duyệt → không xếp lịch được).
create or replace function schedule_draft(p_id bigint, p_day date,
  p_by text)
returns void
language plpgsql security definer set search_path from current as $$
declare
  d content_drafts%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
begin
  if v_by = '' then
    raise exception 'thiếu tên người xếp lịch';
  end if;
  if p_day is null
     or p_day < (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'ngày % đã qua (giờ VN), chỉ xếp lịch từ hôm nay', p_day;
  end if;
  select * into d from content_drafts c where c.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy draft #%', p_id;
  end if;
  if d.status <> 'approved' then
    raise exception 'draft #% đang %, chỉ xếp lịch bài đã approved',
      p_id, d.status;
  end if;
  if not verify_publish('content_draft', p_id::text, d.text) then
    raise exception 'nội dung draft #% không khớp bản đã duyệt (sha256)', p_id;
  end if;
  update content_drafts c set scheduled_date = p_day where c.id = p_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'draft_schedule', 'content_draft', p_id::text,
          jsonb_build_object('day', to_char(p_day, 'YYYY-MM-DD')));
end $$;
revoke execute on function schedule_draft(bigint, date, text) from public;

-- ============================================================================
-- v4.0 hàng duyệt dùng chung (WP03 "Khung điều phối, duyệt và log dùng chung"
-- cho 11 agent giám đốc). Mở rộng mẫu v3.4 (`approvals` + `agent_action_log`
-- + function SECURITY DEFINER) cho MỌI loại object — TRỪ `content_draft`
-- (giữ đường `approve_draft` v3.4: nếu cho vào hàng chung, 1 approval với
-- object_id = id draft làm `verify_publish`/`schedule_draft` của draft pass
-- mà không qua `approve_draft`).
--   * `approval_queue` — agent nhân viên/GĐ khối đẩy việc (`enqueue_item`),
--     người duyệt từng mục (`decide_item`, lane per_item) hoặc luật tự duyệt
--     đã ký (`auto_approve_item`, lane auto_policy). Nội dung (`payload`) +
--     sha256 BẤT BIẾN (trigger); status chỉ đổi 1 lần pending → approved|
--     rejected|expired; không xóa. Quá SLA (`due_at`) → `expire_overdue` đánh
--     expired, KHÔNG BAO GIỜ tự duyệt. Ai ghi: function; ai đọc: app_human,
--     agent_writer (agent GĐ đọc để làm bản tin).
--   * `auto_policies` — luật tự duyệt theo loại; `max_risk` CHỈ 'low' (cấu
--     trúc cấm tự duyệt medium/high); bật phải có người ký. Ship RỖNG — chủ
--     khối ký phạm vi = external-dep. Chỉ owner ghi.
--   * `decisions` — override_qa (ép trình bản QA FAIL: lý do ≥10 ký tự +
--     người ≠ người tạo) và expired (hết SLA). Append-only.
--   * `channel_snapshots` — số liệu kênh theo kỳ (nhập tay từ file xuất hoặc
--     API) cho cockpit sau này. agent_writer insert, app_human đọc.
--   * `red_alerts` — cảnh báo đỏ append-only (trigger chặn UPDATE/DELETE/
--     TRUNCATE khi còn bật, cả DML của owner/superuser; owner vẫn DISABLE
--     TRIGGER, superuser vẫn replica — neo ngoài object-lock là
--     external-dep; TGĐ/ha_tang không được giữ DSN owner/superuser). Người nhận độc lập
--     (không TGĐ/ha_tang) cấu hình ở `data/red_alert_routing.json`;
--     thiếu người nhận → vẫn ghi dòng + `route_error` (fail-closed).
-- Detail log chỉ id/sha/kind — KHÔNG payload, KHÔNG lý do.
-- ============================================================================

create table if not exists approval_queue (
  id bigint generated always as identity primary key,
  object_type text not null
    check (object_type ~ '^[a-z][a-z0-9_]{1,39}$'
           and object_type <> 'content_draft'),
  object_id text not null check (btrim(object_id) <> ''),
  block text not null check (block ~ '^[a-z][a-z_]{1,31}$'),
  title text not null,
  payload text not null,            -- nội dung sẽ phát hành — đúng bản được hash
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  risk text not null check (risk in ('low', 'medium', 'high')),
  guardrail jsonb not null,
  qa_status text not null default 'none'
    check (qa_status in ('none', 'pass', 'fail')),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  due_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  lane text check (lane in ('auto_policy', 'per_item')),
  decided_by text,
  decided_at timestamptz
);
create unique index if not exists approval_queue_pending_uq
  on approval_queue (object_type, object_id) where status = 'pending';
create index if not exists approval_queue_block_idx
  on approval_queue (block, status, due_at);

-- INSERT: ép sha256 = sha(payload), pending, chưa quyết định, created_at=now
-- (không tin client). UPDATE: chỉ pending → approved|rejected|expired MỘT lần
-- kèm lane/decided_by/decided_at; cột khác bất biến. DELETE → chặn.
create or replace function approval_queue_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.content_sha256 := encode(sha256(convert_to(new.payload, 'UTF8')),
                                 'hex');
    new.status := 'pending';
    new.lane := null;
    new.decided_by := null;
    new.decided_at := null;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'approval_queue: DELETE bị chặn (hàng duyệt không xóa)';
  end if;
  if old.status <> 'pending' then
    raise exception 'approval_queue #%: đã %, không đổi được nữa',
      old.id, old.status;
  end if;
  if new.status not in ('approved', 'rejected', 'expired') then
    raise exception 'approval_queue #%: chỉ chuyển pending → approved|rejected|expired',
      old.id;
  end if;
  if (new.id, new.object_type, new.object_id, new.block, new.title,
      new.payload, new.content_sha256, new.risk, new.guardrail,
      new.qa_status, new.created_by, new.created_at, new.due_at)
     is distinct from
     (old.id, old.object_type, old.object_id, old.block, old.title,
      old.payload, old.content_sha256, old.risk, old.guardrail,
      old.qa_status, old.created_by, old.created_at, old.due_at) then
    raise exception 'approval_queue #%: nội dung/metadata bất biến, chỉ đổi status',
      old.id;
  end if;
  if btrim(coalesce(new.decided_by, '')) = '' then
    raise exception 'approval_queue #%: thiếu người quyết định', old.id;
  end if;
  new.decided_at := now();
  return new;
end $$;
revoke execute on function approval_queue_guard() from public;

create or replace trigger approval_queue_guard_row
  before insert or update or delete on approval_queue
  for each row execute function approval_queue_guard();
create or replace trigger approval_queue_no_truncate
  before truncate on approval_queue
  for each statement execute function append_only_guard();

create table if not exists auto_policies (
  id text primary key check (id ~ '^[a-z0-9_]{1,40}$'),
  object_type text not null,
  max_risk text not null check (max_risk = 'low'),
  enabled boolean not null default false,
  signed_by text,
  signed_at timestamptz,
  note text,
  check (not enabled or (btrim(coalesce(signed_by, '')) <> ''
                         and signed_at is not null))
);

create table if not exists decisions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('override_qa', 'expired')),
  queue_id bigint not null references approval_queue (id),
  decided_by text not null check (btrim(decided_by) <> ''),
  -- >= 10 ký tự KHÔNG tính khoảng trắng (DB cũ giữ CHECK btrim — override_qa là chốt).
  reason text not null
    check (char_length(regexp_replace(reason, '\s', '', 'g')) >= 10),
  created_at timestamptz not null default now(),
  db_role text not null default session_user
);
create index if not exists decisions_queue_idx on decisions (queue_id, kind);

create or replace trigger decisions_append_only_row
  before update or delete on decisions
  for each row execute function append_only_guard();
create or replace trigger decisions_no_truncate
  before truncate on decisions
  for each statement execute function append_only_guard();

create table if not exists channel_snapshots (
  id bigint generated always as identity primary key,
  channel text not null check (channel ~ '^[a-z][a-z0-9_]{1,31}$'),
  metric_id text not null check (metric_id ~ '^[a-z][a-z0-9_.]{1,63}$'),
  period_kind text not null check (period_kind in ('day', 'week', 'month')),
  period_start date not null,
  value numeric not null,
  source text not null check (source in ('manual_export', 'api')),
  source_ref text,
  captured_by text not null check (btrim(captured_by) <> ''),
  captured_at timestamptz not null default now(),
  unique (channel, metric_id, period_kind, period_start, source)
);

create table if not exists red_alerts (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  source_agent text not null check (btrim(source_agent) <> ''),
  title text not null check (btrim(title) <> ''),
  detail jsonb not null default '{}',
  recipients text[] not null default '{}',
  route_error text,
  db_role text not null default session_user
);

-- ts/db_role do DB đặt (không tin client — cảnh báo không lùi giờ được).
create or replace function red_alerts_stamp() returns trigger
language plpgsql as $$
begin
  new.ts := now();
  new.db_role := session_user;
  new.detail := coalesce(new.detail, '{}'::jsonb);
  new.recipients := coalesce(new.recipients, '{}'::text[]);
  return new;
end $$;
revoke execute on function red_alerts_stamp() from public;

create or replace trigger red_alerts_stamp_ins
  before insert on red_alerts
  for each row execute function red_alerts_stamp();
create or replace trigger red_alerts_append_only_row
  before update or delete on red_alerts
  for each row execute function append_only_guard();
create or replace trigger red_alerts_no_truncate
  before truncate on red_alerts
  for each statement execute function append_only_guard();

-- Đẩy 1 mục vào hàng duyệt. SLA 1..720 giờ → due_at = now() + SLA.
-- Guardrail là snapshot do caller tính (pipelines.approval_queue.enqueue TỰ
-- chạy guardrail.check, không nhận từ agent); decide_item kiểm lại snapshot,
-- Python kiểm lại payload lần nữa trước khi gọi.
create or replace function enqueue_item(p_object_type text, p_object_id text,
  p_block text, p_title text, p_payload text, p_risk text, p_guardrail jsonb,
  p_qa_status text, p_created_by text, p_sla_hours int)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := btrim(coalesce(p_created_by, ''));
  v_id bigint;
  v_sha text;
begin
  if v_by = '' then
    raise exception 'thiếu người/agent tạo mục';
  end if;
  if p_sla_hours is null or p_sla_hours < 1 or p_sla_hours > 720 then
    raise exception 'SLA % giờ ngoài khoảng 1..720', p_sla_hours;
  end if;
  insert into approval_queue (object_type, object_id, block, title, payload,
    content_sha256, risk, guardrail, qa_status, created_by, due_at)
  values (p_object_type, p_object_id, p_block, coalesce(p_title, ''),
    p_payload, repeat('0', 64), p_risk, coalesce(p_guardrail, '{}'::jsonb),
    coalesce(p_qa_status, 'none'), v_by,
    now() + make_interval(hours => p_sla_hours))
  returning approval_queue.id, approval_queue.content_sha256
    into v_id, v_sha;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'queue_enqueue', p_object_type, p_object_id,
          jsonb_build_object('queue_id', v_id, 'content_sha256', v_sha,
                             'block', p_block));
  return v_id;
end $$;
revoke execute on function enqueue_item(text, text, text, text, text, text,
  jsonb, text, text, int) from public;

-- Người quyết định từng mục (lane per_item). Approve: guardrail ok, QA FAIL
-- phải có override_qa, người duyệt ≠ người tạo. Reject: người tạo tự rút
-- được. Quá SLA → không quyết (chờ expire). Cùng transaction: status +
-- approvals (sha bản trong hàng) + log. Trả id approvals.
create or replace function decide_item(p_id bigint, p_decider text,
  p_decision text, p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  q approval_queue%rowtype;
  v_by text := btrim(coalesce(p_decider, ''));
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người duyệt';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'quyết định % không hợp lệ — chỉ approved|rejected',
      p_decision;
  end if;
  select * into q from approval_queue a where a.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy mục #% trong hàng duyệt', p_id;
  end if;
  if q.status <> 'pending' then
    raise exception 'mục #% đã ở trạng thái %, chỉ quyết từ pending',
      p_id, q.status;
  end if;
  if now() >= q.due_at then
    raise exception 'mục #% quá hạn SLA — chờ expire, không duyệt', p_id;
  end if;
  if p_decision = 'approved' then
    if coalesce(q.guardrail->>'ok', '') <> 'true' then
      raise exception 'mục #% vi phạm guardrail (ok != true), không duyệt được',
        p_id;
    end if;
    if q.qa_status = 'fail' and not exists (
        select 1 from decisions d
         where d.queue_id = q.id and d.kind = 'override_qa') then
      raise exception 'mục #% QA FAIL — cần override_qa có lý do trước khi duyệt',
        p_id;
    end if;
    if lower(btrim(q.created_by)) = lower(v_by) then
      raise exception 'người duyệt trùng người tạo mục #%, cần người khác duyệt',
        p_id;
    end if;
  end if;
  update approval_queue a set status = p_decision, lane = 'per_item',
         decided_by = v_by
   where a.id = p_id;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values (q.object_type, q.object_id, q.content_sha256, p_decision, v_by,
          p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, case when p_decision = 'approved' then 'queue_approve'
                     else 'queue_reject' end,
          q.object_type, q.object_id,
          jsonb_build_object('queue_id', q.id, 'approval_id', v_aid,
                             'content_sha256', q.content_sha256));
  return v_aid;
end $$;
revoke execute on function decide_item(bigint, text, text, text) from public;

-- Tự duyệt theo luật đã ký (lane auto_policy) — fail-closed: không policy
-- bật cho đúng loại / risk ≠ low / guardrail không ok / QA ≠ pass (kể cả
-- 'none') / quá hạn → raise. approved_by = 'auto_policy:<id>'.
-- GIỚI HẠN (đọc trước khi bật policy nào): risk/qa_status/guardrail là giá
-- trị caller ghi lúc enqueue_item — agent giữ DSN agent_writer gọi SQL thẳng
-- có thể khai risk 'low' + qa 'pass' + guardrail ok giả. Hôm nay vô hại vì
-- auto_policies RỖNG; trước khi chủ khối ký phải có nguồn tin cậy cho 3 giá
-- trị này (guardrail/QA chạy phía DB hoặc service riêng — someday).
create or replace function auto_approve_item(p_id bigint)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  q approval_queue%rowtype;
  p auto_policies%rowtype;
  v_by text;
  v_aid bigint;
begin
  select * into q from approval_queue a where a.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy mục #% trong hàng duyệt', p_id;
  end if;
  if q.status <> 'pending' then
    raise exception 'mục #% đã ở trạng thái %, chỉ quyết từ pending',
      p_id, q.status;
  end if;
  if now() >= q.due_at then
    raise exception 'mục #% quá hạn SLA — chờ expire, không duyệt', p_id;
  end if;
  select * into p from auto_policies ap
   where ap.object_type = q.object_type and ap.enabled
   order by ap.id limit 1;
  if not found then
    raise exception 'không có auto_policy bật cho loại % — cần người duyệt (fail-closed)',
      q.object_type;
  end if;
  if q.risk <> 'low' then
    raise exception 'mục #% rủi ro %, auto_policy chỉ áp rủi ro low',
      p_id, q.risk;
  end if;
  if coalesce(q.guardrail->>'ok', '') <> 'true' then
    raise exception 'mục #% vi phạm guardrail (ok != true), không duyệt được',
      p_id;
  end if;
  if q.qa_status <> 'pass' then
    raise exception 'mục #% QA % — auto_policy chỉ duyệt mục QA pass',
      p_id, q.qa_status;
  end if;
  v_by := 'auto_policy:' || p.id;
  update approval_queue a set status = 'approved', lane = 'auto_policy',
         decided_by = v_by
   where a.id = p_id;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values (q.object_type, q.object_id, q.content_sha256, 'approved', v_by,
          null)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'queue_auto_approve', q.object_type, q.object_id,
          jsonb_build_object('queue_id', q.id, 'approval_id', v_aid,
                             'content_sha256', q.content_sha256,
                             'policy_id', p.id, 'signed_by', p.signed_by));
  return v_aid;
end $$;
revoke execute on function auto_approve_item(bigint) from public;

-- Ép trình bản QA FAIL: ghi decisions override_qa (lý do + người ≠ người
-- tạo). KHÔNG đổi status — vẫn cần decide_item của người.
create or replace function override_qa(p_id bigint, p_by text,
  p_reason text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  q approval_queue%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
  v_did bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người override';
  end if;
  -- Đếm ký tự KHÔNG phải khoảng trắng: btrim chỉ cắt dấu cách nên lý do
  -- toàn xuống-dòng/tab từng lọt qua. CHECK cũ của bảng decisions không
  -- đổi được bằng `if not exists` nên function là chốt chặn.
  if char_length(regexp_replace(coalesce(p_reason, ''), '\s', '', 'g'))
       < 10 then
    raise exception 'lý do override_qa phải ≥ 10 ký tự (không tính khoảng trắng)';
  end if;
  select * into q from approval_queue a where a.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy mục #% trong hàng duyệt', p_id;
  end if;
  if q.status <> 'pending' then
    raise exception 'mục #% đã ở trạng thái %, chỉ override mục pending',
      p_id, q.status;
  end if;
  if q.qa_status <> 'fail' then
    raise exception 'mục #% QA %, override_qa chỉ cho mục QA FAIL',
      p_id, q.qa_status;
  end if;
  if lower(btrim(q.created_by)) = lower(v_by) then
    raise exception 'người override trùng người tạo mục #%', p_id;
  end if;
  insert into decisions (kind, queue_id, decided_by, reason)
  values ('override_qa', q.id, v_by,
          btrim(p_reason, E' \t\r\n'))
  returning decisions.id into v_did;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'queue_override_qa', q.object_type, q.object_id,
          jsonb_build_object('queue_id', q.id, 'decision_id', v_did,
                             'kind', 'override_qa'));
  return v_did;
end $$;
revoke execute on function override_qa(bigint, text, text) from public;

-- Hết SLA: mọi mục pending có due_at <= now() → expired + decisions expired
-- + log. KHÔNG ghi approvals, KHÔNG BAO GIỜ approved. Trả số mục expire.
create or replace function expire_overdue(p_by text default 'system:sla')
returns int
language plpgsql security definer set search_path from current as $$
declare
  r record;
  v_by text := coalesce(nullif(btrim(coalesce(p_by, '')), ''), 'system:sla');
  v_did bigint;
  n int := 0;
begin
  for r in select a.id, a.object_type, a.object_id, a.due_at
             from approval_queue a
            where a.status = 'pending' and a.due_at <= now()
            order by a.id for update loop
    update approval_queue a set status = 'expired', lane = null,
           decided_by = v_by
     where a.id = r.id;
    insert into decisions (kind, queue_id, decided_by, reason)
    values ('expired', r.id, v_by,
            'quá hạn SLA ' || to_char(r.due_at at time zone 'Asia/Ho_Chi_Minh',
                                      'YYYY-MM-DD HH24:MI') || ' (giờ VN)')
    returning decisions.id into v_did;
    insert into agent_action_log (actor, action, object_type, object_id,
                                  detail)
    values (v_by, 'queue_expire', r.object_type, r.object_id,
            jsonb_build_object('queue_id', r.id, 'decision_id', v_did,
                               'kind', 'expired'));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function expire_overdue(text) from public;

-- ============================================================================
-- ============================================================
-- v7.3 nghiên cứu giả lập (WP09, scripts/persona_sim.py)
-- Persona TỔNG HỢP (data/personas.json) — không PII, không dữ liệu khách
-- thật. KHÔNG lưu văn bản LLM thô: chỉ điểm 0..10 đã parse. Mỗi dòng = 1
-- lời gọi LLM (model × prompt × lần lặp) × 1 phương án; `dry_run` tách số
-- giả (gateway giả) khỏi chạy thật (chỉ sau khi DPIA ký). score null = lời
-- gọi parse lỗi hoặc guardrail chặn. Đủ model/prompt_hash/seed/ngày/đối
-- chứng để tái lập + kiểm toán.
-- ============================================================
create table if not exists sim_runs (
  id bigint generated always as identity primary key,
  run_id text not null,
  dry_run boolean not null,
  run_date date not null,
  created_at timestamptz not null default now(),
  persona_set text not null,
  persona_set_hash text not null,
  model text not null,
  provider text not null,
  model_version text not null,
  prompt_id text not null,
  prompt_hash text not null,
  sample_idx int not null check (sample_idx >= 0),
  temperature numeric not null,
  seed int not null,
  seed_supported boolean not null,
  option_id text not null,
  is_control boolean not null,
  score numeric check (score between 0 and 10),
  parse_ok boolean not null,
  guardrail_ok boolean not null,
  unique (run_id, model, prompt_id, sample_idx, option_id)
);
create index if not exists sim_runs_run_idx on sim_runs (run_id);

-- ============================================================================
-- v9.3 vùng trồng (WP13 phần VT): hash chain nhật ký vườn + kho tư liệu ảnh.
--   * `plot_logs.prev_hash/row_hash` — mọi nhật ký KHÔNG phải mẫu
--     (`source not like 'sample:%'`) vào chuỗi băm do trigger tính (không tin
--     client); dòng đã chain KHÔNG sửa/xóa được (kể cả FK cascade từ `delete
--     from plots`, TRUNCATE). Sửa lén (superuser tắt trigger) bị
--     `verify_plot_logs()` phát hiện. Giới hạn như agent_action_log: xóa dòng
--     CUỐI chuỗi không phát hiện được bằng chuỗi thuần (neo ngoài =
--     external-dep).
--   * Dòng MẪU (`sample:%`) KHÔNG vào chuỗi ("genesis không chứa sample") —
--     loader `ingest.core_store` và CLI gỡ mẫu (`agents.garden_director
--     --purge-sample --by`) xóa được. Sau khi GĐ vùng trồng đã gỡ mẫu (có
--     dòng agent_action_log `garden_sample_purge`) → chặn chèn mẫu mới.
--   * Hash canonical theo mẫu `action_log_row_hash`: thời gian quy về epoch
--     micro-giây, KHÔNG `ts::text` (không phụ thuộc TimeZone/DateStyle).
--   * `garden_media` — ảnh vườn đã gỡ EXIF/GPS (`scripts/garden_media.py`),
--     file lưu NGOÀI repo theo sha256. KHÔNG cột tọa độ/đường dẫn/tên file gốc.
-- ============================================================================

alter table plot_logs add column if not exists prev_hash text;
alter table plot_logs add column if not exists row_hash text;
create unique index if not exists plot_logs_row_hash_idx
  on plot_logs (row_hash);

-- Hash 1 nhật ký (dùng chung cho trigger INSERT, backfill và verify).
create or replace function plot_log_row_hash(
  p_prev text, p_id bigint, p_plot_id text, p_ts timestamptz,
  p_activity text, p_detail text, p_author text, p_source text,
  p_created_at timestamptz)
returns text language sql stable as $$
  select encode(sha256(convert_to(p_prev || jsonb_build_array(
    p_id, p_plot_id, (extract(epoch from p_ts) * 1000000)::bigint,
    p_activity, p_detail, p_author, p_source,
    (extract(epoch from p_created_at) * 1000000)::bigint)::text, 'UTF8')),
    'hex')
$$;
revoke execute on function plot_log_row_hash(text, bigint, text, timestamptz,
  text, text, text, text, timestamptz) from public;

-- INSERT nhật ký: dòng mẫu → hash null, không khóa (chặn hẳn sau khi đã gỡ
-- mẫu). Còn lại y hệt agent_action_log_chain: chỉ READ COMMITTED, khóa
-- advisory theo bảng, cấp id SAU khóa, ép created_at/prev_hash/row_hash —
-- giá trị client gửi bị ghi đè.
create or replace function plot_logs_chain() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_prev text;
begin
  if new.source like 'sample:%' then
    if exists (select 1 from agent_action_log a
               where a.action = 'garden_sample_purge') then
      raise exception 'plot_logs: dữ liệu mẫu đã được gỡ '
        '(garden_sample_purge) — không nạp lại mẫu';
    end if;
    new.prev_hash := null;
    new.row_hash := null;
    return new;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'plot_logs: chỉ ghi trong READ COMMITTED (hash chain)';
  end if;
  perform pg_advisory_xact_lock(tg_relid::bigint);
  new.id := nextval(pg_get_serial_sequence(
    quote_ident(tg_table_schema) || '.' || quote_ident(tg_table_name), 'id'));
  new.created_at := now();
  select l.row_hash into v_prev from plot_logs l
    where l.row_hash is not null order by l.id desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.row_hash := plot_log_row_hash(new.prev_hash, new.id, new.plot_id,
    new.ts, new.activity, new.detail, new.author, new.source,
    new.created_at);
  return new;
end $$;
revoke execute on function plot_logs_chain() from public;

create or replace trigger plot_logs_chain_ins
  before insert on plot_logs
  for each row execute function plot_logs_chain();

-- Chặn UPDATE/DELETE dòng ĐÃ chain (gồm DELETE do FK cascade khi xóa khoảnh)
-- và TRUNCATE khi còn dòng đã chain (kể cả `truncate plots cascade`).
-- Dòng mẫu / dòng legacy chưa chain vẫn sửa/xóa được — mẫu do loader quản,
-- legacy được backfill bên dưới (UPDATE prev_hash/row_hash lần đầu).
create or replace function plot_logs_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    if exists (select 1 from plot_logs l where l.row_hash is not null) then
      raise exception 'plot_logs: TRUNCATE bị chặn — có nhật ký đã chain';
    end if;
    return null;
  end if;
  if old.row_hash is not null then
    raise exception 'plot_logs #%: nhật ký đã chain — % bị chặn (ghi dòng '
      'mới kèm lý do)', old.id, tg_op;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- Dòng chưa chain: KHÔNG được đổi mẫu ↔ thật, KHÔNG gán hash tay cho dòng
  -- mẫu — chặn đường lách trigger INSERT (chèn 'sample:x' với created_at
  -- giả rồi đổi source + tự tính hash thành đuôi chuỗi hợp lệ).
  if (old.source like 'sample:%') is distinct from (new.source like 'sample:%')
     or (new.source like 'sample:%'
         and (new.row_hash is not null or new.prev_hash is not null)) then
    raise exception 'plot_logs #%: không đổi dòng mẫu ↔ thật / gán hash tay',
      old.id;
  end if;
  return new;
end $$;
revoke execute on function plot_logs_guard() from public;

create or replace trigger plot_logs_guard_row
  before update or delete on plot_logs
  for each row execute function plot_logs_guard();
create or replace trigger plot_logs_guard_truncate
  before truncate on plot_logs
  for each statement execute function plot_logs_guard();

-- Backfill legacy (idempotent): CHỈ khi chưa dòng nào có row_hash → chain các
-- dòng không-mẫu theo id tăng dần, giữ created_at cũ. Có chain rồi → no-op.
do $$
declare
  r record;
  v_prev text := repeat('0', 64);
begin
  if exists (select 1 from plot_logs l where l.row_hash is not null) then
    return;
  end if;
  perform pg_advisory_xact_lock('plot_logs'::regclass::oid::bigint);
  if exists (select 1 from plot_logs l where l.row_hash is not null) then
    return;
  end if;
  for r in select l.* from plot_logs l
           where l.source not like 'sample:%' order by l.id loop
    update plot_logs l set prev_hash = v_prev,
      row_hash = plot_log_row_hash(v_prev, r.id, r.plot_id, r.ts,
        r.activity, r.detail, r.author, r.source, r.created_at)
      where l.id = r.id
      returning l.row_hash into v_prev;
  end loop;
end $$;

-- Kiểm chuỗi: rỗng = nguyên vẹn. 'row_hash' = nội dung dòng bị sửa;
-- 'prev_hash' = dòng trước bị xóa/chèn/giấu khỏi chuỗi; 'unchained' = dòng
-- không-mẫu thiếu hash (chèn khi trigger bị tắt).
create or replace function verify_plot_logs()
returns table (id bigint, problem text)
language plpgsql stable security definer set search_path from current as $$
declare
  r record;
  v_prev text := repeat('0', 64);
begin
  for r in select l.* from plot_logs l
           where l.row_hash is not null or l.source not like 'sample:%'
           order by l.id loop
    if r.row_hash is null then
      id := r.id; problem := 'unchained'; return next;
      continue;
    end if;
    if r.prev_hash is distinct from v_prev then
      id := r.id; problem := 'prev_hash'; return next;
    end if;
    if r.row_hash is distinct from plot_log_row_hash(r.prev_hash, r.id,
        r.plot_id, r.ts, r.activity, r.detail, r.author, r.source,
        r.created_at) then
      id := r.id; problem := 'row_hash'; return next;
    end if;
    v_prev := r.row_hash;
  end loop;
end $$;
revoke execute on function verify_plot_logs() from public;

create table if not exists garden_media (
  -- Kho tư liệu vườn: ảnh đã gỡ TOÀN BỘ EXIF/GPS, lưu ngoài repo theo
  -- `<store>/<sha[:2]>/<sha>.<ext>`. KHÔNG lưu tọa độ / đường dẫn / tên file
  -- gốc. plot_id no action — khoảnh có ảnh không bị xóa câm.
  id bigint generated always as identity primary key,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  ext text not null check (ext in ('jpg', 'png')),
  bytes bigint not null check (bytes > 0),
  width int,
  height int,
  plot_id text not null references plots(id),
  taken_on date not null,
  author text not null check (btrim(author) <> ''),
  exif_removed int not null default 0,   -- số thẻ EXIF gốc đã gỡ
  had_gps boolean not null default false,
  source text not null default 'cli:garden_media',
  created_at timestamptz not null default now()
);
create index if not exists garden_media_plot_idx
  on garden_media (plot_id, taken_on);

-- ============================================================================
-- v7.0 intel collector (WP09, `crawler/intel.py`): tin thị trường tầng A/B
-- đọc từ RSS/Atom. KHÔNG lưu toàn văn bài báo (bản quyền) — chỉ tiêu đề +
-- trích ≤300 ký tự + link; title/snippet đã che SĐT/email (_mask_pii) —
-- không PII. Tầng C (MXH cá nhân, trang cần đăng nhập, sàn) không bao giờ
-- vào bảng (check tier). Insert-only (on conflict do nothing): dedup theo
-- url chuẩn hóa + sha256(title + snippet chuẩn hóa). summary = LLM tùy
-- chọn (mặc định null), đã qua guardrail. Khối intel không ghi bảng khác.
-- ============================================================================

create table if not exists intel_items (
  id bigint generated always as identity primary key,
  url text not null unique,
  domain text not null,
  source text not null,
  tier text not null check (tier in ('A', 'B')),
  title text not null check (char_length(title) <= 300),
  snippet text check (char_length(snippet) <= 300),
  summary text check (char_length(summary) <= 300),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  content_sha256 text not null unique,
  topics text[] not null check (cardinality(topics) > 0),
  flags text[] not null default '{}'
);

create index if not exists intel_items_fetched_idx on intel_items (fetched_at desc);

-- ============================================================================
-- ---------------------------------------------------------------------
-- v9.5 CK-A2 — CMMS nhẹ trung tâm điện–cơ khí (agents/cmms.py).
-- Sổ máy thật + biên bản kiểm kê = external-dep (Kỹ sư trưởng); KHÔNG
-- có lệnh xóa máy (thôi dùng = active false). Mô tả sự cố đã _mask_pii;
-- reported_by là MÃ nhân sự, không tên/SĐT.
create table if not exists machines (
  code text primary key check (code ~ '^SS-EQ-[0-9]{2,4}$'),
  name text not null,
  location text,
  maker text,
  year int check (year between 1950 and 2100),
  thuoc_dien_kiem_dinh boolean not null default false,
  han_kiem_dinh date,
  la_phuong_tien_do boolean not null default false,
  han_hieu_chuan date,
  ho_so_gmp boolean not null default false,
  active boolean not null default true,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create table if not exists maintenance_plans (
  id bigint generated always as identity primary key,
  machine_code text not null references machines(code),
  task text not null,
  interval_days int not null check (interval_days between 1 and 3660),
  major boolean not null default false,   -- việc lớn: cần Kỹ sư trưởng duyệt
  start_on date not null default current_date,
  last_done_on date,
  last_done_by text,
  last_approved_by text,
  active boolean not null default true
);

create table if not exists incidents (
  id bigint generated always as identity primary key,
  machine_code text not null references machines(code),
  started_at timestamptz not null,
  ended_at timestamptz check (ended_at is null or ended_at >= started_at),
  downtime_phut int check (downtime_phut >= 0),  -- NULL = sự cố đang mở
  part text,
  description text,                              -- ĐÃ _mask_pii
  root_cause text not null default 'chờ xác nhận',
  reported_by text check (reported_by ~ '^[A-Za-z0-9_-]{1,32}$'),
  created_at timestamptz not null default now()
);
create index if not exists incidents_machine_started_idx
  on incidents (machine_code, started_at);

-- Nhật ký downtime (sự cố đã đóng) cho CK-A5 dự đoán sau này.
create or replace view downtime_log as
  select machine_code, started_at, ended_at, downtime_phut, part, root_cause
  from incidents where ended_at is not null;

-- ============================================================================
-- v7.1 Red Alert intel (WP09, `pipelines/intel_alert.py`): luật tất định quét
-- `intel_items` → cảnh báo đỏ qua `pipelines.red_alert.raise_alert` (người
-- nhận độc lập v4.0) + LEO THANG 1 cấp sau 2 giờ chưa xác nhận.
--   * `red_alert_acks` — người xác nhận đã xử lý cảnh báo gốc (1 lần/cảnh
--     báo, append-only). `acked_at` do DB đặt (không lùi giờ được);
--     `agent_writer` KHÔNG ghi được (agent không tự xác nhận).
--   * 2 unique index partial trên `red_alerts`: 1 cảnh báo / tin intel và
--     1 bản leo thang / cảnh báo gốc — chạy song song không báo trùng.
-- ============================================================================

create table if not exists red_alert_acks (
  id bigint generated always as identity primary key,
  alert_id bigint not null unique references red_alerts (id),
  acked_by text not null check (btrim(acked_by) <> ''),
  acked_at timestamptz not null default now(),
  note text
);

create or replace function red_alert_acks_stamp() returns trigger
language plpgsql as $$
begin
  new.acked_at := now();
  return new;
end $$;
revoke execute on function red_alert_acks_stamp() from public;

create or replace trigger red_alert_acks_stamp_ins
  before insert on red_alert_acks
  for each row execute function red_alert_acks_stamp();
create or replace trigger red_alert_acks_append_only_row
  before update or delete on red_alert_acks
  for each row execute function append_only_guard();
create or replace trigger red_alert_acks_no_truncate
  before truncate on red_alert_acks
  for each statement execute function append_only_guard();

create unique index if not exists red_alerts_intel_item_uq
  on red_alerts ((detail->>'intel_item_id'))
  where source_agent = 'intel_red_alert' and detail ? 'intel_item_id';
create unique index if not exists red_alerts_escalation_uq
  on red_alerts ((detail->>'escalation_of'))
  where source_agent = 'intel_red_alert' and detail ? 'escalation_of';

-- ============================================================================
-- v7.2 đối thủ / trend / social (WP09, `ingest/intel_import.py`): Competitor
-- Tracker, Trend, Social Listening P1. MỌI dữ liệu vào bằng FILE XUẤT TAY
-- (Quản lý MXH ghi giá đối thủ trên sàn; Google Trends xuất tay; export
-- comment/inbox kênh SỞ HỮU) — KHÔNG cào sàn/MXH, không request mạng.
-- KHÔNG có cột tên/ID/SĐT/email/profile người dùng ở bất kỳ bảng nào:
-- cột định danh bị bỏ khi đọc, nội dung đã che SĐT/email, dedup social bằng
-- `msg_hash` sha256 CÓ MUỐI. Mọi con số có nguồn (`source_ref`, `import_id`
-- → file gốc). Idempotent theo `intel_imports.file_sha256`. Insert-only;
-- module chỉ ĐỌC golden (`sku_master`/`price_list`), không ghi bảng khác.
-- ============================================================================

create table if not exists intel_imports (
  id bigint generated always as identity primary key,
  kind text not null
    check (kind in ('competitor', 'trend_timeline', 'trend_related', 'social')),
  channel text,                     -- social: fanpage | zalo_oa | tiktok
  file_name text not null,          -- basename file đã nạp
  file_sha256 text not null unique, -- nạp lại cùng file = [skip]
  row_count int not null,
  imported_at timestamptz not null default now()
);

create table if not exists competitor_observations (
  -- Giá/KM đối thủ do NGƯỜI ghi (CSV nhập tay) — agent không cào sàn.
  id bigint generated always as identity primary key,
  import_id bigint not null references intel_imports(id),
  row_no int not null,
  competitor text not null,
  channel text not null
    check (channel in ('shopee', 'tiktok', 'lazada', 'tiki', 'web', 'khac')),
  product_name text not null,
  sku_key text,                     -- SKU tương đương của mình (không FK — mẫu market_rows)
  price_vnd bigint not null check (price_vnd > 0),
  promo_price_vnd bigint check (promo_price_vnd > 0),
  promo_text text check (char_length(promo_text) <= 200),
  rating numeric(2,1) check (rating between 0 and 5),
  review_count int check (review_count >= 0),
  observed_on date not null,
  source_ref text not null
    check (char_length(source_ref) between 1 and 500), -- URL hoặc "ảnh chụp <tên file>"
  unique (import_id, row_no)
);

create table if not exists trends_weekly (
  -- Google Trends multiTimeline (xuất tay). Thang 0–100 chỉ so được TRONG
  -- cùng 1 file → query_id = sha256 file [:16]; anchor = từ khóa neo.
  id bigint generated always as identity primary key,
  import_id bigint not null references intel_imports(id),
  query_id text not null,
  keyword text not null,
  anchor text not null,
  geo text not null,
  week date not null,
  value smallint not null check (value between 0 and 100),
  unique (query_id, keyword, geo, week)
);

create table if not exists trends_related (
  -- Google Trends relatedQueries (xuất tay) của 1 từ khóa gốc (`seed`).
  id bigint generated always as identity primary key,
  import_id bigint not null references intel_imports(id),
  seed text not null,
  section text not null check (section in ('top', 'rising')),
  query text not null check (char_length(query) <= 200),
  value text not null,              -- "100" | "+250%" | "Breakout"
  flags text[] not null default '{}' -- 'ruou' = không dùng cho nhóm giới trẻ
);

create table if not exists social_mentions (
  -- Comment/inbox/review kênh SỞ HỮU (P1, chỉ đọc — không trả lời tự động).
  -- excerpt (đã che, ≤200) CHỈ lưu khi DPIA đã ký và tin không nhạy cảm.
  id bigint generated always as identity primary key,
  import_id bigint not null references intel_imports(id),
  channel text not null check (channel in ('fanpage', 'zalo_oa', 'tiktok')),
  kind text not null check (kind in ('comment', 'inbox', 'review')),
  posted_at timestamptz not null,
  msg_hash text not null unique,    -- sha256 có MUỐI (INTEL_HASH_SALT)
  labels text[] not null check (cardinality(labels) > 0),
  sensitive boolean not null,       -- true = hỏi sức khỏe
  excerpt text check (char_length(excerpt) <= 200)
);

create index if not exists social_mentions_posted_idx on social_mentions (posted_at);
create index if not exists competitor_observations_on_idx on competitor_observations (observed_on);

-- ============================================================================
-- v5.2 CRM lead & đại lý theo vùng (WP07 agent KD-A2) — contact_vault +
-- đồng ý theo mục đích + đại lý.
--   * `contacts` = kho liên hệ (contact_vault): PII (SĐT/tên/email/địa chỉ)
--     MÃ HÓA Ở TẦNG ỨNG DỤNG (`ingest/crm.py`, Fernet, khóa env
--     `CONTACT_VAULT_KEY` — DB không bao giờ thấy khóa/plaintext). Mọi cột
--     `*_enc` có check chỉ nhận token Fernet (`gAAAAA...`) → plaintext lọt
--     vào là DB từ chối. Tra trùng bằng `phone_hmac` = HMAC-SHA256 có khóa
--     (dẫn xuất HKDF từ cùng khóa) của SĐT chuẩn hóa — không phải sha256
--     trần (SĐT VN chỉ ~10^9 giá trị, sha256 trần dò ngược được). Bảng
--     khác chỉ giữ `contact_id`.
--   * `dealers` = đại lý (mã, vùng, trạng thái, hoa hồng mặc định). Dữ
--     liệu hiện là MẪU (`data/dealer_regions.json`); đại lý thật =
--     external-dep. Người liên hệ của đại lý (nếu có) nằm trong vault.
--   * `consents` = đồng ý theo mục đích cskh | marketing | dai_ly,
--     APPEND-ONLY (rút đồng ý = thêm dòng granted=false, không UPDATE).
--     `dai_ly` phải ĐÍCH DANH đại lý nhận; grant phải có mã biên bản
--     (`evidence_ref`) + phiên bản chính sách. Trạng thái hiện hành =
--     dòng mới nhất theo `id` (view `v_consent_current`).
--   * `leads` mở rộng bằng ALTER (khối create giữ nguyên): `contact_id`,
--     `province` (34 tỉnh sau sáp nhập), `dealer_code`, người/giờ gán.
-- Quyền: roles.sql KHÔNG grant 3 bảng này cho agent_writer/app_human —
-- phân quyền sales thật là external-dep (mặc định từ chối).
-- ============================================================================

create table if not exists contacts (
  id bigint generated always as identity primary key,
  phone_hmac text not null unique check (phone_hmac ~ '^[0-9a-f]{64}$'),
  phone_enc text not null check (phone_enc ~ '^gAAAAA[A-Za-z0-9_=-]+$'),
  name_enc text check (name_enc ~ '^gAAAAA[A-Za-z0-9_=-]+$'),
  email_enc text check (email_enc ~ '^gAAAAA[A-Za-z0-9_=-]+$'),
  address_enc text check (address_enc ~ '^gAAAAA[A-Za-z0-9_=-]+$'),
  province text,                    -- 1 trong 34 tên (data/vn_provinces_2025.json) — không PII
  source text not null,             -- 'manual' | 'form_giay' | ... (nguồn thu thập)
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now()
);

create table if not exists dealers (
  code text primary key check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text not null,
  region text not null,             -- mã vùng trong data/dealer_regions.json
  status text not null default 'active'
    check (status in ('active', 'paused', 'ended')),
  commission_default numeric(5,2) not null default 0
    check (commission_default between 0 and 100),
  contact_id bigint references contacts(id),
  source text not null,             -- 'dealer_regions.json' | 'manual' (manual không bị loader đè)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists consents (
  id bigint generated always as identity primary key,
  contact_id bigint not null references contacts(id),
  purpose text not null check (purpose in ('cskh', 'marketing', 'dai_ly')),
  granted boolean not null,
  recipient_dealer text references dealers(code),
  source text not null check (source in
    ('form_giay', 'zalo', 'web', 'dien_thoai', 'email', 'truc_tiep')),
  evidence_ref text,                -- MÃ biên bản/scan — không phải PII
  policy_version text,
  recorded_by text not null check (btrim(recorded_by) <> ''),
  ts timestamptz not null default now(),
  check ((purpose = 'dai_ly') = (recipient_dealer is not null)),
  check (not granted or (btrim(coalesce(evidence_ref, '')) <> ''
                         and btrim(coalesce(policy_version, '')) <> ''))
);
create index if not exists consents_contact_purpose_idx
  on consents (contact_id, purpose, id);

create or replace trigger consents_append_only_row
  before update or delete on consents
  for each row execute function append_only_guard();
create or replace trigger consents_no_truncate
  before truncate on consents
  for each statement execute function append_only_guard();

-- Đồng ý hiện hành theo (contact, mục đích, đại lý): dòng mới nhất theo id
-- (KHÔNG theo ts — ts ghi lùi không lật được trạng thái).
create or replace view v_consent_current as
select distinct on (contact_id, purpose, coalesce(recipient_dealer, ''))
  contact_id, purpose, recipient_dealer, granted,
  case when granted then ts end as granted_at,
  case when not granted then ts end as withdrawn_at,
  id as consent_id
from consents
order by contact_id, purpose, coalesce(recipient_dealer, ''), id desc;

alter table leads add column if not exists contact_id bigint references contacts(id);
alter table leads add column if not exists province text;
alter table leads add column if not exists dealer_code text references dealers(code);
alter table leads add column if not exists assigned_by text;
alter table leads add column if not exists assigned_at timestamptz;

-- Trạng thái lead (v5.2 thêm 'qualified'): trigger thay vì check
-- constraint — drift-guard tests/test_lead_store.py chỉ cho lệnh ALTER
-- dạng thêm cột (add column if not exists). Raise errcode check_violation (như
-- check). Chỉ kiểm dòng mới/đổi status — DB cũ có status lạ vẫn
-- apply_schema được. Thứ tự chuyển (chỉ tiến) ép ở `ingest.crm`.
create or replace function leads_status_guard() returns trigger
language plpgsql as $$
begin
  if new.status not in ('new', 'contacted', 'qualified', 'won', 'lost') then
    raise exception using errcode = 'check_violation',
      message = format('leads.status không hợp lệ: %s', new.status);
  end if;
  return new;
end $$;
revoke execute on function leads_status_guard() from public;

create or replace trigger leads_status_check
  before insert or update of status on leads
  for each row execute function leads_status_guard();

-- ============================================================================
-- v4.5 harness nghiệm thu chung (WP06): mở rộng eval_runs — KHÔNG bảng mới.
-- Ai ghi: scripts/agent_eval.py (1 row/lần chấm 1 suite data/eval/suites/
-- <agent>.json). Ai đọc: scripts/deploy_gate.py (row mới nhất), agent_eval
-- (chốt version + chốt ngưỡng trước khi chấm), pipelines/director.py (bản tin
-- GĐ khối owner_block — mục "Nghiệm thu QA hôm nay"; submit(qa_suite=) lấy
-- qa_status từ row mới nhất không '-dirty'). Vì sao: mỗi run phải truy được
-- model agent (cột model), model judge, prompt version, suite version + hash
-- bộ ca, hash ngưỡng, ngày (ts), commit (commit_sha) — chống sửa đề/ngưỡng
-- sau khi thấy điểm. Row cũ (v3.5) có cột mới null — không tính khi chốt.
-- failed_cases = list id ca FAIL (cắt 50), không chứa text ca.
-- ============================================================================

alter table eval_runs add column if not exists judge_model text;
alter table eval_runs add column if not exists suite_version int;
alter table eval_runs add column if not exists suite_sha256 text;
alter table eval_runs add column if not exists threshold_sha256 text;
alter table eval_runs add column if not exists owner_block text;
alter table eval_runs add column if not exists failed_cases jsonb;

-- ============================================================================
-- v9.2 Sản xuất P1 (WP13 SX-A3/A4/A5): tồn thành phẩm, đề xuất phân bổ theo
-- mốc chốt, BOM combo/hộp quà, hồ sơ lô + kiểm nhập. Dữ liệu trong repo là
-- MẪU (source='sample') tới khi kho/GĐ sản xuất cấp số thật. Agent CHỈ ĐỀ
-- XUẤT (allocation_proposals 'pending'): không chuyển kho, không sửa tồn,
-- không đặt mua, không lệnh sản xuất. Quyết định của người -> approvals +
-- agent_action_log (hash chain v3.4). Không cột cá nhân/khách hàng.
-- sku_key không FK: golden đọc từ file (như market_rows).
-- ============================================================================
create table if not exists inventory_snapshots (
  id bigint generated always as identity primary key,
  sku_key text not null,
  kho text not null,
  qty int not null check (qty >= 0),
  captured_at date not null,
  source text not null check (source in ('manual_export', 'sample')),
  file_name text not null,
  file_sha256 text not null,
  row_no int not null,
  imported_at timestamptz not null default now(),
  unique (file_sha256, row_no)
);
create index if not exists inventory_snapshots_sku_idx
  on inventory_snapshots (sku_key, kho, captured_at);

create table if not exists allocation_proposals (
  id bigint generated always as identity primary key,
  run_id text not null,
  cutoff_id text not null,
  cutoff_date date not null,
  start_week date not null,
  sku_key text not null,
  channel text not null,
  stock_total int,                  -- null = SKU chưa có số tồn (không coi = 0)
  demand_low int not null,
  demand_base int not null,
  demand_high int not null,
  proposed_qty int not null check (proposed_qty >= 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, sku_key, channel),
  check ((status = 'pending') = (decided_by is null)),
  check (decided_by is null or btrim(decided_by) <> '')
);
create index if not exists allocation_proposals_cutoff_idx
  on allocation_proposals (cutoff_id, created_at);

create table if not exists bom_combos (
  combo_key text primary key,
  name text not null,
  channels text[] not null check (cardinality(channels) > 0),
  source text not null check (source in ('manual', 'sample')),
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists bom_items (
  combo_key text not null references bom_combos (combo_key) on delete cascade,
  sku_key text not null,
  qty int not null check (qty > 0),
  primary key (combo_key, sku_key)
);

create table if not exists production_lots (
  lot_code text primary key,
  sku_key text not null,
  mfg_date date not null,
  exp_date date not null,
  qty int not null check (qty > 0),
  intake_status text not null default 'pending'
    check (intake_status in ('pending', 'passed', 'failed')),
  checked_by text,
  checked_at timestamptz,
  source text not null check (source in ('manual', 'sample')),
  note text,
  created_at timestamptz not null default now(),
  check (exp_date > mfg_date),      -- hạn dùng <= ngày SX bị DB chặn
  check ((intake_status = 'pending') = (checked_by is null)),
  check (checked_by is null or btrim(checked_by) <> '')
);

-- Quyết định của NGƯỜI (duyệt phân bổ, kiểm nhập lô) CHỈ qua 2 function
-- SECURITY DEFINER dưới — client KHÔNG insert thẳng `approvals` (precedent
-- v3.4 approve_draft). TUYỆT ĐỐI không grant INSERT approvals cho role nào:
-- `verify_publish` tin dòng approvals mới nhất → ai chèn được approvals là
-- chèn được duyệt giả cho content_draft. object_type cố định trong function.
-- content_sha256 = sha256(UTF-8 của jsonb::text) tính TRONG DB.

-- Duyệt/từ chối CẢ 1 run phân bổ (mọi dòng pending). Không đụng
-- inventory_snapshots (duyệt ≠ chuyển kho). Trả (id approvals, số dòng).
create or replace function decide_allocation_run(p_run text, p_decision text,
  p_by text, p_note text default null)
returns table (out_approval_id bigint, out_rows integer)
language plpgsql security definer set search_path from current as $$
declare
  v_by text := btrim(coalesce(p_by, ''));
  v_n integer;
  v_sha text;
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người quyết định';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'decision phải là approved|rejected';
  end if;
  perform 1 from allocation_proposals a
    where a.run_id = p_run and a.status = 'pending' for update;
  select count(*), encode(sha256(convert_to(coalesce(jsonb_agg(
           jsonb_build_array(a.sku_key, a.channel, a.proposed_qty)
           order by a.sku_key collate "C", a.channel collate "C"),
           '[]'::jsonb)::text, 'UTF8')), 'hex')
    into v_n, v_sha
    from allocation_proposals a
   where a.run_id = p_run and a.status = 'pending';
  if v_n = 0 then
    if exists (select 1 from allocation_proposals a where a.run_id = p_run)
    then
      raise exception 'run % không còn dòng pending', p_run;
    end if;
    raise exception 'không có run %', p_run;
  end if;
  update allocation_proposals a set status = p_decision, decided_by = v_by,
         decided_at = now()
   where a.run_id = p_run and a.status = 'pending';
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('allocation_run', p_run, v_sha, p_decision, v_by, p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, case p_decision when 'approved' then 'alloc_approve'
                else 'alloc_reject' end, 'allocation_run', p_run,
          jsonb_build_object('approval_id', v_aid, 'content_sha256', v_sha,
                             'rows', v_n));
  out_approval_id := v_aid;
  out_rows := v_n;
  return next;
end $$;
revoke execute on function decide_allocation_run(text, text, text, text)
  from public;

-- Kiểm nhập 1 lô: chỉ từ pending (lô đã kiểm không ghi lại). passed →
-- approvals 'approved', failed → 'rejected'. Trả id approvals.
create or replace function record_lot_intake(p_lot text, p_result text,
  p_by text, p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  l production_lots%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
  v_sha text;
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người kiểm nhập';
  end if;
  if p_result is null or p_result not in ('passed', 'failed') then
    raise exception 'result phải là passed|failed';
  end if;
  select * into l from production_lots p where p.lot_code = p_lot for update;
  if not found then
    raise exception 'không có lô %', p_lot;
  end if;
  if l.intake_status <> 'pending' then
    raise exception 'lô % đã kiểm (%) — không ghi lại', p_lot,
      l.intake_status;
  end if;
  v_sha := encode(sha256(convert_to(jsonb_build_object(
    'lot_code', l.lot_code, 'sku_key', l.sku_key,
    'mfg_date', to_char(l.mfg_date, 'YYYY-MM-DD'),
    'exp_date', to_char(l.exp_date, 'YYYY-MM-DD'),
    'qty', l.qty, 'source', l.source)::text, 'UTF8')), 'hex');
  update production_lots p set intake_status = p_result, checked_by = v_by,
         checked_at = now()
   where p.lot_code = p_lot;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('lot_intake', p_lot, v_sha,
          case p_result when 'passed' then 'approved' else 'rejected' end,
          v_by, p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'lot_intake', 'lot_intake', p_lot,
          jsonb_build_object('approval_id', v_aid, 'content_sha256', v_sha,
                             'result', p_result));
  return v_aid;
end $$;
revoke execute on function record_lot_intake(text, text, text, text)
  from public;

-- ============================================================================
-- v9.4 lô + QR truy xuất (WP13 VT — thí điểm mật ong, 3 chữ ký, phương án B).
--   * `lot_origins` — GĐ Sản xuất ánh xạ lô (`production_lots`) ↔ nhật ký
--     `thu hoạch` ĐÃ CHAIN (`plot_logs.row_hash`, v9.3) + tối đa 3 ảnh tư liệu
--     (`garden_media`, đã gỡ EXIF) của CÙNG khoảnh. KHÔNG cột khoảnh/vị trí/
--     tọa độ: khoảnh + ngày thu hoạch suy từ nhật ký đã chain (bất biến).
--   * `qr_signatures` — 3 vai (GĐ Sản xuất, GĐ vùng trồng, Pháp chế/QA) ký
--     trên CÙNG bản chụp dữ liệu (`qr_lot_snapshot_sha`) + CÙNG lời văn trang
--     (`text_sha256`). 1 người không ký 2 vai trên cùng lô. Append-only.
--     `signer` = danh tính tự khai (`--by`; SSO = external-dep) — chỉ bảng
--     này + approvals giữ tên; trang công khai KHÔNG in tên người ký.
--   * `qr_codes` — mã công khai ngẫu nhiên (Python `secrets.token_urlsafe`,
--     KHÔNG dẫn xuất từ lot_code), 1 mã còn hiệu lực/lô; không xóa; chỉ
--     được đánh dấu thu hồi 1 lần (`revoked_*`).
--   * Ai ghi: CHỈ 5 function SECURITY DEFINER dưới (link/unlink/sign/issue/
--     revoke) — client KHÔNG insert thẳng `approvals`/`qr_*` (không role nào
--     được grant INSERT; `docs/roles.sql` chỉ grant EXECUTE cho app_human).
--     Ai đọc: CLI `python -m pipelines.qr_trace` (owner DB). Không cột PII
--     (KHÔNG SĐT/email/địa chỉ/tọa độ — cột `location` của plots không đọc).
-- ============================================================================

create table if not exists lot_origins (
  id bigint generated always as identity primary key,
  lot_code text not null references production_lots (lot_code),
  plot_log_id bigint not null references plot_logs (id),
  media_sha256 text[] not null default '{}'
    check (cardinality(media_sha256) <= 3),
  linked_by text not null check (btrim(linked_by) <> ''),
  linked_at timestamptz not null default now(),
  unique (lot_code, plot_log_id)
);

create table if not exists qr_signatures (
  id bigint generated always as identity primary key,
  lot_code text not null references production_lots (lot_code),
  role text not null
    check (role in ('gd_san_xuat', 'gd_vung_trong', 'phap_che_qa')),
  signer text not null check (btrim(signer) <> ''),
  signer_norm text not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  approval_id bigint not null references approvals (id),
  signed_at timestamptz not null default now(),
  unique (lot_code, snapshot_sha256, text_sha256, role),
  unique (lot_code, snapshot_sha256, text_sha256, signer_norm)
);

create or replace trigger qr_signatures_append_only_row
  before update or delete on qr_signatures
  for each row execute function append_only_guard();
create or replace trigger qr_signatures_no_truncate
  before truncate on qr_signatures
  for each statement execute function append_only_guard();

create table if not exists qr_codes (
  code text primary key check (code ~ '^[A-Za-z0-9_-]{22,64}$'),
  lot_code text not null references production_lots (lot_code),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  issued_by text not null check (btrim(issued_by) <> ''),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  check ((revoked_at is null) = (revoked_by is null)),
  check (revoked_by is null or btrim(revoked_by) <> '')
);
create unique index if not exists qr_codes_one_active_idx
  on qr_codes (lot_code) where revoked_at is null;

-- qr_codes: không DELETE/TRUNCATE; UPDATE chỉ để thu hồi mã CÒN hiệu lực và
-- chỉ đổi 3 cột revoked_* (mã đã thu hồi không "hồi sinh"/sửa được).
create or replace function qr_codes_guard() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'qr_codes: % bị chặn (chỉ thu hồi qua revoke_qr)', tg_op;
  end if;
  if old.revoked_at is not null then
    raise exception 'qr_codes: mã đã thu hồi — không sửa';
  end if;
  if (new.code, new.lot_code, new.snapshot_sha256, new.text_sha256,
      new.issued_by, new.issued_at)
     is distinct from (old.code, old.lot_code, old.snapshot_sha256,
      old.text_sha256, old.issued_by, old.issued_at) then
    raise exception 'qr_codes: chỉ được đổi cột revoked_*';
  end if;
  return new;
end $$;
revoke execute on function qr_codes_guard() from public;

create or replace trigger qr_codes_guard_row
  before update or delete on qr_codes
  for each row execute function qr_codes_guard();
create or replace trigger qr_codes_guard_truncate
  before truncate on qr_codes
  for each statement execute function qr_codes_guard();

-- Chuẩn hóa danh tính người ký (NFC + gộp khoảng trắng + chữ thường) —
-- issue_qr tự tính lại từ `signer`, KHÔNG tin cột `signer_norm`.
create or replace function qr_signer_norm(p text) returns text
language sql immutable as $$
  select lower(btrim(regexp_replace(normalize(coalesce(p, ''), NFC),
                                    '\s+', ' ', 'g')))
$$;
revoke execute on function qr_signer_norm(text) from public;

-- Bản chụp dữ liệu lô mà 3 vai ký: lô + mọi nguồn (nhật ký đã chain:
-- id, khoảnh, row_hash, ngày thu hoạch giờ VN, ảnh). Đổi ánh xạ/ảnh/ngày lô
-- → sha khác → chữ ký cũ không còn tính. null = không có lô.
create or replace function qr_lot_snapshot_sha(p_lot text) returns text
language sql stable security definer set search_path from current as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'lot_code', l.lot_code, 'sku_key', l.sku_key,
    'mfg_date', to_char(l.mfg_date, 'YYYY-MM-DD'),
    'exp_date', to_char(l.exp_date, 'YYYY-MM-DD'),
    'source', l.source,
    'origins', coalesce((
      select jsonb_agg(jsonb_build_array(o.plot_log_id, g.plot_id, g.row_hash,
               to_char((g.ts at time zone 'Asia/Ho_Chi_Minh')::date,
                       'YYYY-MM-DD'),
               (select coalesce(jsonb_agg(m order by m collate "C"),
                                '[]'::jsonb)
                  from unnest(o.media_sha256) m))
             order by o.plot_log_id)
        from lot_origins o join plot_logs g on g.id = o.plot_log_id
       where o.lot_code = l.lot_code), '[]'::jsonb))::text, 'UTF8')), 'hex')
  from production_lots l where l.lot_code = p_lot
$$;
revoke execute on function qr_lot_snapshot_sha(text) from public;

-- GĐ Sản xuất ánh xạ 1 nhật ký thu hoạch ĐÃ CHAIN vào lô. Từ chối: nhật ký
-- mẫu/chưa chain/không phải thu hoạch/khoảnh mẫu/thu hoạch sau ngày SX; chuỗi
-- nhật ký có vấn đề (verify_plot_logs không rỗng → không dùng dòng nào);
-- ảnh không thuộc kho của CÙNG khoảnh; lô failed/đang có mã còn hiệu lực.
create or replace function link_lot_origin(p_lot text, p_plot_log_id bigint,
  p_media text[], p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  l production_lots%rowtype;
  g plot_logs%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
  v_media text[] := coalesce(p_media, '{}'::text[]);
  v_src text;
  v_id bigint;
  m text;
begin
  if v_by = '' then
    raise exception 'thiếu tên người ánh xạ (--by)';
  end if;
  select * into l from production_lots p where p.lot_code = p_lot for update;
  if not found then
    raise exception 'không có lô %', p_lot;
  end if;
  if l.intake_status = 'failed' then
    raise exception 'lô % kiểm nhập failed — không ánh xạ nguồn', p_lot;
  end if;
  if exists (select 1 from qr_codes c
             where c.lot_code = p_lot and c.revoked_at is null) then
    raise exception 'lô % đang có mã QR còn hiệu lực — thu hồi trước khi '
      'đổi ánh xạ', p_lot;
  end if;
  select * into g from plot_logs pl where pl.id = p_plot_log_id;
  if not found then
    raise exception 'không có nhật ký #%', p_plot_log_id;
  end if;
  if g.source like 'sample:%' or g.row_hash is null then
    raise exception 'nhật ký #% là dữ liệu mẫu / chưa chain — không dùng '
      'làm nguồn', p_plot_log_id;
  end if;
  if g.activity <> 'thu hoạch' then
    raise exception 'nhật ký #% không phải "thu hoạch"', p_plot_log_id;
  end if;
  select p.source into v_src from plots p where p.id = g.plot_id;
  if v_src is null or v_src like 'sample:%' then
    raise exception 'khoảnh của nhật ký #% là dữ liệu mẫu', p_plot_log_id;
  end if;
  if (g.ts at time zone 'Asia/Ho_Chi_Minh')::date > l.mfg_date then
    raise exception 'nhật ký #%: ngày thu hoạch sau ngày sản xuất lô',
      p_plot_log_id;
  end if;
  if exists (select 1 from verify_plot_logs()) then
    raise exception 'chuỗi nhật ký vườn có vấn đề (verify_plot_logs) — '
      'không dùng dòng nào làm nguồn';
  end if;
  if cardinality(v_media) > 3 then
    raise exception 'tối đa 3 ảnh tư liệu / nguồn';
  end if;
  if (select count(distinct x) from unnest(v_media) x)
     <> cardinality(v_media) then
    raise exception 'ảnh tư liệu bị trùng';
  end if;
  foreach m in array v_media loop
    if m is null or m !~ '^[0-9a-f]{64}$' then
      raise exception 'sha256 ảnh sai định dạng';
    end if;
    if not exists (select 1 from garden_media gm
                   where gm.sha256 = m and gm.plot_id = g.plot_id) then
      raise exception 'ảnh % không có trong kho tư liệu của khoảnh nguồn',
        left(m, 12);
    end if;
  end loop;
  if exists (select 1 from lot_origins o
             where o.lot_code = p_lot and o.plot_log_id = p_plot_log_id) then
    raise exception 'nhật ký #% đã ánh xạ vào lô %', p_plot_log_id, p_lot;
  end if;
  insert into lot_origins (lot_code, plot_log_id, media_sha256, linked_by)
  values (p_lot, p_plot_log_id, v_media, v_by)
  returning lot_origins.id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'qr_lot_link', 'production_lot', p_lot,
          jsonb_build_object('plot_log_id', p_plot_log_id,
                             'media', cardinality(v_media)));
  return v_id;
end $$;
revoke execute on function link_lot_origin(text, bigint, text[], text)
  from public;

-- Gỡ 1 ánh xạ — chỉ khi lô không có mã còn hiệu lực. Trả id dòng đã gỡ.
create or replace function unlink_lot_origin(p_lot text, p_plot_log_id bigint,
  p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := btrim(coalesce(p_by, ''));
  v_id bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người gỡ ánh xạ (--by)';
  end if;
  perform 1 from production_lots p where p.lot_code = p_lot for update;
  if exists (select 1 from qr_codes c
             where c.lot_code = p_lot and c.revoked_at is null) then
    raise exception 'lô % đang có mã QR còn hiệu lực — thu hồi trước khi '
      'đổi ánh xạ', p_lot;
  end if;
  delete from lot_origins o
   where o.lot_code = p_lot and o.plot_log_id = p_plot_log_id
  returning o.id into v_id;
  if v_id is null then
    raise exception 'lô % không có ánh xạ nhật ký #%', p_lot, p_plot_log_id;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'qr_lot_unlink', 'production_lot', p_lot,
          jsonb_build_object('plot_log_id', p_plot_log_id));
  return v_id;
end $$;
revoke execute on function unlink_lot_origin(text, bigint, text) from public;

-- 1 vai ký lô trên bản chụp HIỆN TẠI + lời văn p_text_sha. Từ chối: vai lạ,
-- lô chưa passed, 0 nguồn, vai đã ký bản này, CÙNG người đã ký vai KHÁC trên
-- lô này (bất kể bản chụp nào). Ghi approvals + qr_signatures + log.
create or replace function sign_qr_lot(p_lot text, p_role text, p_by text,
  p_text_sha text, p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  l production_lots%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
  v_norm text := qr_signer_norm(p_by);
  v_snap text;
  v_aid bigint;
begin
  if v_by = '' or v_norm = '' then
    raise exception 'thiếu tên người ký (--by)';
  end if;
  if p_role is null
     or p_role not in ('gd_san_xuat', 'gd_vung_trong', 'phap_che_qa') then
    raise exception 'vai trò ký không hợp lệ';
  end if;
  if p_text_sha is null or p_text_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'text_sha256 sai định dạng';
  end if;
  select * into l from production_lots p where p.lot_code = p_lot for update;
  if not found then
    raise exception 'không có lô %', p_lot;
  end if;
  if l.intake_status <> 'passed' then
    raise exception 'lô % chưa kiểm nhập passed (%) — không ký', p_lot,
      l.intake_status;
  end if;
  if not exists (select 1 from lot_origins o where o.lot_code = p_lot) then
    raise exception 'lô % chưa có nguồn vùng trồng đã chain — không ký',
      p_lot;
  end if;
  v_snap := qr_lot_snapshot_sha(p_lot);
  if exists (select 1 from qr_signatures s
             where s.lot_code = p_lot and s.snapshot_sha256 = v_snap
               and s.text_sha256 = p_text_sha and s.role = p_role) then
    raise exception 'vai % đã ký bản này của lô %', p_role, p_lot;
  end if;
  if exists (select 1 from qr_signatures s
             where s.lot_code = p_lot and s.role <> p_role
               and qr_signer_norm(s.signer) = v_norm) then
    raise exception 'một người không được ký hai vai trên cùng lô %', p_lot;
  end if;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('qr_lot_sign', p_lot,
          encode(sha256(convert_to(v_snap || ':' || p_text_sha, 'UTF8')),
                 'hex'),
          'approved', v_by,
          p_role || coalesce(' | ' || nullif(btrim(p_note), ''), ''))
  returning approvals.id into v_aid;
  insert into qr_signatures (lot_code, role, signer, signer_norm,
                             snapshot_sha256, text_sha256, approval_id)
  values (p_lot, p_role, v_by, v_norm, v_snap, p_text_sha, v_aid);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'qr_lot_sign', 'production_lot', p_lot,
          jsonb_build_object('approval_id', v_aid, 'role', p_role,
                             'snapshot_sha256', v_snap,
                             'text_sha256', p_text_sha));
  return v_aid;
end $$;
revoke execute on function sign_qr_lot(text, text, text, text, text)
  from public;

-- Phát hành mã: lô passed, còn hạn (giờ VN), có nguồn, chuỗi nhật ký nguyên
-- vẹn, đủ 3 vai do 3 NGƯỜI khác nhau ký đúng bản chụp hiện tại + lời văn
-- p_text_sha (tính lại chuẩn hóa từ `signer`), chưa có mã còn hiệu lực. Mã
-- do client sinh ngẫu nhiên; DB chặn mã chứa lot_code.
create or replace function issue_qr(p_lot text, p_code text,
  p_text_sha text, p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  l production_lots%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
  v_snap text;
  v_roles integer;
  v_people integer;
begin
  if v_by = '' then
    raise exception 'thiếu tên người phát hành (--by)';
  end if;
  if p_code is null or p_code !~ '^[A-Za-z0-9_-]{22,64}$' then
    raise exception 'mã QR sai định dạng';
  end if;
  if p_text_sha is null or p_text_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'text_sha256 sai định dạng';
  end if;
  select * into l from production_lots p where p.lot_code = p_lot for update;
  if not found then
    raise exception 'không có lô %', p_lot;
  end if;
  if position(lower(l.lot_code) in lower(p_code)) > 0 then
    raise exception 'mã QR không được chứa mã lô';
  end if;
  if l.intake_status <> 'passed' then
    raise exception 'lô % chưa kiểm nhập passed (%) — không phát hành',
      p_lot, l.intake_status;
  end if;
  if l.exp_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'lô % đã hết hạn sử dụng — không phát hành', p_lot;
  end if;
  if not exists (select 1 from lot_origins o where o.lot_code = p_lot) then
    raise exception 'lô % chưa có nguồn vùng trồng đã chain', p_lot;
  end if;
  if exists (select 1 from verify_plot_logs()) then
    raise exception 'chuỗi nhật ký vườn có vấn đề (verify_plot_logs) — '
      'không phát hành';
  end if;
  v_snap := qr_lot_snapshot_sha(p_lot);
  select count(distinct s.role), count(distinct qr_signer_norm(s.signer))
    into v_roles, v_people
    from qr_signatures s
   where s.lot_code = p_lot and s.snapshot_sha256 = v_snap
     and s.text_sha256 = p_text_sha;
  if v_roles < 3 or v_people < 3 then
    raise exception 'lô % chưa đủ 3 chữ ký của 3 người khác nhau trên bản '
      'hiện tại (% vai, % người)', p_lot, v_roles, v_people;
  end if;
  if exists (select 1 from qr_codes c
             where c.lot_code = p_lot and c.revoked_at is null) then
    raise exception 'lô % đã có mã QR còn hiệu lực', p_lot;
  end if;
  insert into qr_codes (code, lot_code, snapshot_sha256, text_sha256,
                        issued_by)
  values (p_code, p_lot, v_snap, p_text_sha, v_by);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'qr_issue', 'qr_code', p_code,
          jsonb_build_object('lot_code', p_lot, 'snapshot_sha256', v_snap,
                             'text_sha256', p_text_sha));
  return p_code;
end $$;
revoke execute on function issue_qr(text, text, text, text) from public;

-- Thu hồi mã còn hiệu lực (trang công khai chuyển "đã thu hồi").
create or replace function revoke_qr(p_code text, p_by text,
  p_reason text default null)
returns timestamptz
language plpgsql security definer set search_path from current as $$
declare
  c qr_codes%rowtype;
  v_by text := btrim(coalesce(p_by, ''));
begin
  if v_by = '' then
    raise exception 'thiếu tên người thu hồi (--by)';
  end if;
  select * into c from qr_codes q where q.code = p_code for update;
  if not found then
    raise exception 'không có mã QR này';
  end if;
  if c.revoked_at is not null then
    raise exception 'mã QR đã thu hồi trước đó';
  end if;
  update qr_codes q set revoked_at = now(), revoked_by = v_by,
         revoke_reason = nullif(btrim(p_reason), '')
   where q.code = p_code;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'qr_revoke', 'qr_code', p_code,
          jsonb_build_object('lot_code', c.lot_code));
  return now();
end $$;
revoke execute on function revoke_qr(text, text, text) from public;

-- ============================================================================
-- v9.0 kế toán (WP12 — ACC-Recon / ACC-Invoice / ACC-AR). Chỉ BÁO CÁO + NHÁP:
-- không bút toán, không ghi sổ MISA, không phát hành hóa đơn, không lệnh chi.
--   * `settlement_rows` — ai ghi: `python -m ingest.settlement_csv --file`
--     (file quyết toán kế toán xuất TAY từ Seller Center, idempotent theo
--     `file_sha256`); ai đọc: đối soát + `--report`. Số tiền đã chuẩn hóa
--     dấu: cột khấu trừ DƯƠNG = sàn trừ, ÂM = sàn bù. KHÔNG cột người mua
--     (tên/SĐT/địa chỉ bị bỏ ngay khi đọc), mã đơn chỉ lưu hash như
--     `market_rows`.
--   * `recon_results` — đúng 1 nhãn/dòng settlement (khop/lech/
--     thieu_chung_tu/hoan) + lý do; `--reconcile` tính lại (upsert) khi file
--     đơn tới sau file quyết toán.
--   * `invoice_lines` — dòng lô hóa đơn NHÁP (`agents.acc_invoice --batch`):
--     `batch_key` = object_id mục `invoice_batch` trong `approval_queue`
--     (KHÔNG FK). KHÔNG thông tin người mua — tên/MST/địa chỉ/email chỉ nằm
--     trong file CSV nháp gitignored `data/reports/hoa-don-nhap/`.
--   * `dealer_ar` — sổ công nợ đại lý nạp tay (`agents.acc_ar --load`), dấu
--     số tiền theo loại; KHÔNG tên/SĐT đại lý (khóa nối CRM = `dealer_code`).
-- ============================================================================

create table if not exists settlement_rows (
  id bigint generated always as identity primary key,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text not null,          -- basename, không đường dẫn
  channel text not null check (channel in ('shopee', 'tiktok')),
  row_no int not null check (row_no >= 2),   -- số dòng trong file (header = 1)
  order_id_hash text not null check (order_id_hash ~ '^[0-9a-f]{16}$'),
  order_amount_vnd bigint not null check (order_amount_vnd >= 0),
  fixed_fee_vnd bigint not null default 0,
  payment_fee_vnd bigint not null default 0,
  service_fee_vnd bigint not null default 0,
  shipping_fee_vnd bigint not null default 0,
  voucher_seller_vnd bigint not null default 0,
  affiliate_vnd bigint not null default 0,
  refund_vnd bigint not null default 0 check (refund_vnd >= 0),
  payout_vnd bigint not null,       -- thực nhận trên file, có thể âm
  settled_on date,
  imported_at timestamptz not null default now(),
  unique (file_sha256, row_no)
);

create table if not exists recon_results (
  id bigint generated always as identity primary key,
  settlement_row_id bigint not null unique references settlement_rows(id),
  label text not null
    check (label in ('khop', 'lech', 'thieu_chung_tu', 'hoan')),
  reasons jsonb not null default '[]',      -- [{code, expected, actual}]
  expected_payout_vnd bigint not null,
  order_amount_vnd bigint,                  -- tổng từ đơn sàn; null = không thấy đơn
  reconciled_at timestamptz not null default now(),
  check ((label <> 'khop' or reasons = '[]'::jsonb)
         and (label <> 'lech' or reasons <> '[]'::jsonb))
);

create table if not exists invoice_lines (
  id bigint generated always as identity primary key,
  batch_key text not null
    check (batch_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{12}$'),
  batch_date date not null,
  channel text not null check (channel in ('shopee', 'tiktok')),
  order_id_hash text not null check (order_id_hash ~ '^[0-9a-f]{16}$'),
  kind text not null check (kind in ('thuong', 'can_mst', 'dieu_chinh')),
  amount_vnd bigint not null check (amount_vnd >= 0),
  ref_batch_key text,               -- điều chỉnh: lô gốc đã duyệt
  created_at timestamptz not null default now(),
  check ((kind = 'dieu_chinh') = (ref_batch_key is not null)),
  unique (batch_key, order_id_hash, kind)
);

create table if not exists dealer_ar (
  id bigint generated always as identity primary key,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text not null,
  row_no int not null,
  dealer_code text not null check (dealer_code ~ '^[A-Z0-9_-]{2,32}$'),
  dealer_type text not null
    check (dealer_type in ('doanh_nghiep', 'ho_kinh_doanh', 'ca_nhan')),
  kind text not null
    check (kind in ('so_du_dau', 'phat_sinh', 'thanh_toan', 'dieu_chinh')),
  doc_ref text,
  doc_date date not null,
  due_date date check (due_date is null or due_date >= doc_date),
  amount_vnd bigint not null,
  sku_key text,                     -- không FK (như market_rows)
  channel text check (channel is null or channel in ('offline', 'online')),
  imported_at timestamptz not null default now(),
  unique (file_sha256, row_no),
  check (case kind when 'so_du_dau' then amount_vnd > 0
                   when 'phat_sinh' then amount_vnd > 0
                   when 'thanh_toan' then amount_vnd < 0
                   else amount_vnd <> 0 end)
);
