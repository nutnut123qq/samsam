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
-- v15.5: `products` KHÔNG còn delete-then-insert — upsert theo id + đánh dấu
-- `retired_at` (khối v15.5 p11 cuối file) → đơn thật / row 'manual' trỏ
-- products giữ liên kết. Bảng con managed (claims/assets/mẫu) vẫn xóa-nạp lại.
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
  channel text not null,            -- zalo | messenger (v5.1, key `channel` convlog) | streamlit (msg_id rỗng)
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
-- Đợt hoàn thiện 22/10 (data_platform-04, PL01 "giới hạn chi phí từng tính
-- năng"): mã tính năng danh mục của lời gọi (null = dòng cũ / lời gọi không
-- gắn tính năng). Additive — dòng cũ giữ nguyên.
alter table llm_usage add column if not exists feature_id text;
create index if not exists llm_usage_feature_ts_idx on llm_usage (feature_id, ts);

-- ============================================================================
-- v3.2 golden master (WP04a, F15.2 + F14.2): nguồn sự thật DUY NHẤT cho
-- listing / giá / trạng thái pháp lý của SKU đang bán.
-- Ownership: `products` thuộc `ingest.core_store` (crawl web, upsert v15.5)
-- và chỉ là "giá web" để đối chiếu — golden nằm ở bảng RIÊNG dưới đây, nạp
-- bởi `ingest.golden_store` từ data/golden_skus.json (upsert theo khóa,
-- KHÔNG delete-by-source; row `source='manual'` không bị đè).
-- `sku_map.product_id` cố ý KHÔNG FK tới products (lịch sử: core_store từng
-- xóa-nạp lại products; từ v15.5 upsert + `retired_at`, vẫn giữ không FK).
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
-- r13: engine/model đã tạo text OCR (truy vết; null = không OCR).
alter table documents add column if not exists ocr_engine text;

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
  -- v13.5 c04 (F08): agent/hệ thống KHÔNG BAO GIỜ duyệt (kể cả gọi thẳng
  -- bằng login app_human, bỏ qua pipelines.auth).
  if v_by ~* '^(agent|system|auto_policy)\s*:' then
    raise exception 'người duyệt % không phải người — agent/hệ thống không được duyệt',
      v_by;
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
    -- v13.5 c04 (F08): agent/hệ thống không bao giờ duyệt (từ chối = rút
    -- mục của chính mình vẫn được).
    if v_by ~* '^(agent|system|auto_policy)\s*:' then
      raise exception 'người duyệt % không phải người — agent/hệ thống không được duyệt',
        v_by;
    end if;
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
  if v_by ~* '^(agent|system|auto_policy)\s*:' then   -- v13.5 c04 (F08)
    raise exception 'người override % không phải người — agent/hệ thống không được override',
      v_by;
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
--   * `consents` = đồng ý theo mục đích cskh | marketing | dai_ly | b2b
--     (v8.2: b2b = gửi báo giá cho người liên hệ của TỔ CHỨC — form B2B),
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

-- v8.2 KD-A3 (WP11): mở rộng HẸP CHECK mục đích thêm 'b2b' (form B2B — đồng ý
-- nhận báo giá cho người liên hệ tổ chức). DB cũ giữ CHECK 3 mục đích của
-- create ở trên → drop + add lại (idempotent, validate lại dòng cũ — cả 3 mục
-- đích cũ vẫn hợp lệ). Drift-guard tests/test_lead_store.py cho phép ĐÚNG 2
-- lệnh này (không nới alter khác).
alter table consents drop constraint if exists consents_purpose_check;
alter table consents add constraint consents_purpose_check
  check (purpose in ('cskh', 'marketing', 'dai_ly', 'b2b'));

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
  -- r12 G5-02: danh tính theo login (`human_actor` — chặn agent/system kể cả
  -- owner; login người phải đúng người + khối farming). Trước: chỉ kiểm rỗng.
  v_by text := human_actor(p_by, 'farming');
  v_media text[] := coalesce(p_media, '{}'::text[]);
  v_src text;
  v_id bigint;
  m text;
begin
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
  v_by text := human_actor(p_by, 'farming');   -- r12 G5-02 (như link)
  v_id bigint;
begin
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

-- ============================================================================
-- v5.0 leo thang SLA khối KD (WP07, `agents/sales_director.py`, luồng F03c
-- "Handoff A/B, SLA, escalation"). 1 dòng / mục hàng duyệt bị QUÁ SLA GIỜ LÀM
-- VIỆC (A = 2 giờ, B = 4 giờ — `data/directors/sales.json`). `queue_id`
-- unique → `insert ... on conflict (queue_id) do nothing` = chạy lại không
-- leo thang 2 lần (agent_writer KHÔNG đọc được red_alerts/agent_action_log
-- nên không dò trùng qua đó được). Loại A kèm 1 dòng `red_alerts` (cùng
-- transaction); loại B chỉ dòng này (`escalate_to_role='tgd'`) + mục trong
-- bản tin GĐ KD. Leo thang KHÔNG đổi status mục — quá hạn tuyệt đối vẫn đi
-- `expire_overdue` (không bao giờ tự duyệt).
-- Ai ghi: agent_writer (INSERT cột metadata). Ai đọc: agent GĐ KD (id,
-- queue_id, created_at — làm bản tin), app_human (đủ cột). Append-only:
-- trigger chặn UPDATE/DELETE/TRUNCATE. KHÔNG cột payload/nội dung khách.
-- ============================================================================

create table if not exists sla_escalations (
  id bigint generated always as identity primary key,
  queue_id bigint not null unique references approval_queue (id),
  block text not null,
  handoff_class text not null check (handoff_class in ('A', 'B')),
  assignee_role text not null,
  escalate_to_role text not null,
  business_due_at timestamptz not null,
  red_alert boolean not null,
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now()
);

create or replace trigger sla_escalations_append_only_row
  before update or delete on sla_escalations
  for each row execute function append_only_guard();
create or replace trigger sla_escalations_no_truncate
  before truncate on sla_escalations
  for each statement execute function append_only_guard();

-- ============================================================================
-- v4.3 Pháp chế PC-A1/PC-A4 (WP05): sổ hồ sơ XNQC theo SKU + rà bài đang
-- đăng trên kênh SỞ HỮU (file xuất tay). Agent CHỈ phát hiện + đề xuất:
-- không gỡ/sửa bài, không sửa golden, không tự chuyển hồ sơ sang `da_cap`.
--   * `xnqc_dossiers` — 1 dòng = 1 hồ sơ XNQC (mỗi maket/kịch bản là 1 hồ
--     sơ). `da_cap` CHỈ do NGƯỜI (Pháp chế) xác nhận: DB chặn thiếu số giấy/
--     ngày cấp/scan (`documents`) hoặc `updated_by` dạng 'agent:'/'system:'
--     kể cả khi INSERT/UPDATE thẳng. Lịch sử đổi trạng thái ở
--     `agent_action_log` (action `xnqc_status`).
--   * `channel_posts` — 1 dòng = 1 SNAPSHOT bài theo (url, text). Vi phạm
--     theo "đợt" của URL: `first_detected_at`/`due_at` (24 giờ thật) kế thừa
--     qua snapshot mới khi chưa sạch; đóng `da_sua` (snapshot sạch),
--     `thay_ban_moi` (có snapshot mới), `da_go` (NGƯỜI ghi nhận đã gỡ/ẩn).
--     Trạng thái mục hàng duyệt KHÔNG đóng vi phạm.
-- ============================================================================

create table if not exists xnqc_dossiers (
  id bigint generated always as identity primary key,
  sku_key text not null references sku_master(sku_key),
  loai_ho_so text not null
    check (loai_ho_so in ('maket', 'kich_ban_video', 'kich_ban_livestream',
                          'khac')),
  ten_ho_so text not null check (btrim(ten_ho_so) <> ''),
  status text not null default 'chuan_bi'
    check (status in ('chuan_bi', 'da_nop', 'bo_sung', 'da_cap', 'het_han')),
  so_giay text,
  ngay_nop date,
  ngay_cap date,
  ngay_het_han date,
  document_sha256 text references documents(sha256),
  updated_by text not null check (btrim(updated_by) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'da_cap' or (btrim(coalesce(so_giay, '')) <> ''
         and ngay_cap is not null and document_sha256 is not null
         and updated_by !~* '^\s*(agent|system)\s*:')),
  check (status not in ('da_nop', 'bo_sung', 'da_cap', 'het_han')
         or ngay_nop is not null),
  check (ngay_het_han is null or ngay_cap is null or ngay_het_han > ngay_cap)
);
create index if not exists xnqc_dossiers_sku_idx
  on xnqc_dossiers (sku_key, status);

create table if not exists channel_posts (
  id bigint generated always as identity primary key,
  url text not null,
  channel text not null,
  content_type text not null,
  posted_on date,                   -- null = file xuất không ghi ngày
  is_ai boolean not null,
  is_sponsored boolean not null default false,
  sku text,
  draft_id bigint,                  -- id content_drafts bản đã duyệt — KHÔNG FK
  text text not null,               -- nội dung CÔNG KHAI của công ty
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  guardrail jsonb not null,         -- snapshot check_publish
  codes text[] not null default '{}',
  severity text check (severity in ('S1', 'S2')),  -- null = sạch
  first_detected_at timestamptz,
  due_at timestamptz,
  queue_id bigint references approval_queue(id),
  alert_id bigint,                 -- id red_alerts — KHÔNG FK: FK làm `truncate red_alerts`
                                    -- vấp FK trước trigger append-only (test v4.0 ghim trigger)
  imported_by text not null check (btrim(imported_by) <> ''),
  scanned_at timestamptz not null,
  closed_at timestamptz,
  close_reason text check (close_reason in ('da_sua', 'thay_ban_moi', 'da_go')),
  closed_by text
);
create index if not exists channel_posts_url_idx on channel_posts (url, id);
create index if not exists channel_posts_open_idx on channel_posts (url)
  where closed_at is null and severity is not null;

-- ============================================================================
-- v9.1 FP&A (WP12 — FP-COGS-PnL / FP-OpsCost). Chỉ BÁO CÁO + ĐỀ XUẤT: không
-- lệnh chi, không cài ngân sách ads, không tắt key. P&L / đề xuất ads / dòng
-- tiền tính khi đọc (không lưu bảng); đề xuất + khoản vượt ngưỡng X đi qua
-- `approval_queue` (risk high — auto_policy không áp).
--   * `cogs_versions` — giá vốn theo SKU có ngày hiệu lực, APPEND-ONLY
--     (trigger khuôn `price_list`): ai ghi: người lập (GĐ sản xuất) qua
--     `python -m agents.fp_pnl --cogs-add` (INSERT chưa duyệt); duyệt CHỈ qua
--     function `approve_cogs` (SECURITY DEFINER) — người duyệt ≠ người lập
--     (so không phân biệt hoa thường/khoảng trắng), cùng transaction ghi
--     `approvals` (`object_type='cogs_version'`) + `agent_action_log`. Ai
--     đọc: P&L (`agents.fp_pnl --pnl`) — chỉ dòng ĐÃ duyệt; thiếu → "chưa có
--     giá vốn duyệt", không điền 0. Đổi giá vốn = thêm dòng mới, không sửa.
--   * `opex_entries` — chi phí cloud/SaaS/ads/khác nhập tay từ CSV (`python
--     -m agents.fp_opscost --load`, idempotent theo `file_sha256`), không tên
--     người. Ai đọc: so trần tháng (cảnh báo 80%/100%) + khoản > ngưỡng X.
-- ============================================================================

create table if not exists cogs_versions (
  id bigint generated always as identity primary key,
  sku_key text not null references sku_master(sku_key),
  cost_vnd bigint not null check (cost_vnd > 0),
  valid_from date not null,
  created_by text not null check (btrim(created_by) <> ''),   -- người lập
  approved_by text,                 -- null = chờ duyệt (chỉ approve_cogs ghi)
  approved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  check ((approved_by is null) = (approved_at is null))
);
create index if not exists cogs_versions_sku_idx
  on cogs_versions (sku_key, valid_from);

-- Append-only: chặn DELETE/TRUNCATE; INSERT phải CHƯA duyệt (không INSERT
-- sẵn-duyệt vượt cổng người); UPDATE chỉ đúng 1 chuyển trạng thái
-- approved_by null -> non-blank (+ approved_at), mọi cột khác giữ nguyên.
create or replace function cogs_versions_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.approved_by is not null or new.approved_at is not null then
      raise exception 'cogs_versions append-only: INSERT phải là dòng chưa duyệt (sku %)', new.sku_key;
    end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'cogs_versions append-only: % bị chặn', tg_op;
  end if;
  if (new.id, new.sku_key, new.cost_vnd, new.valid_from, new.created_by,
      new.note, new.created_at)
     is distinct from
     (old.id, old.sku_key, old.cost_vnd, old.valid_from, old.created_by,
      old.note, old.created_at) then
    raise exception 'cogs_versions append-only: chỉ được duyệt dòng (id %)', old.id;
  end if;
  if old.approved_by is null and old.approved_at is null
     and new.approved_by is not null and btrim(new.approved_by) <> ''
     and new.approved_at is not null then
    return new;
  end if;
  raise exception 'cogs_versions append-only: UPDATE không hợp lệ (id %)', old.id;
end $$;

create or replace trigger cogs_versions_append_only_row
  before insert or update or delete on cogs_versions
  for each row execute function cogs_versions_append_only();
create or replace trigger cogs_versions_no_truncate
  before truncate on cogs_versions
  for each statement execute function cogs_versions_append_only();

-- Duyệt giá vốn (khuôn approve_draft): thiếu tên / không thấy / đã duyệt /
-- người duyệt trùng người lập → raise. Hợp lệ → cùng transaction: update +
-- approvals (sha256 của `sku_key|cost_vnd|valid_from`, ngày to_char — không
-- phụ thuộc DateStyle) + log. Trả id approvals.
create or replace function approve_cogs(p_id bigint, p_approver text,
  p_note text default null)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  c cogs_versions%rowtype;
  -- gộp mọi khoảng trắng (tab/xuống dòng/nhiều dấu cách) trước khi so —
  -- "nguyen  a" / "Nguyen\ta" vẫn là cùng người lập.
  v_by text := btrim(regexp_replace(coalesce(p_approver, ''), '\s+', ' ',
                                    'g'));
  v_sha text;
  v_aid bigint;
begin
  if v_by = '' then
    raise exception 'thiếu tên người duyệt';
  end if;
  if v_by ~* '^(agent|system|auto_policy)\s*:' then   -- v13.5 c04 (F08)
    raise exception 'người duyệt % không phải người — agent/hệ thống không được duyệt',
      v_by;
  end if;
  select * into c from cogs_versions g where g.id = p_id for update;
  if not found then
    raise exception 'không tìm thấy giá vốn #%', p_id;
  end if;
  if c.approved_by is not null then
    raise exception 'giá vốn #% đã được duyệt, không duyệt lại', p_id;
  end if;
  if lower(btrim(regexp_replace(c.created_by, '\s+', ' ', 'g')))
     = lower(v_by) then
    raise exception 'người duyệt trùng người lập giá vốn #%, cần người khác duyệt',
      p_id;
  end if;
  v_sha := encode(sha256(convert_to(c.sku_key || '|' || c.cost_vnd::text
    || '|' || to_char(c.valid_from, 'YYYY-MM-DD'), 'UTF8')), 'hex');
  update cogs_versions g set approved_by = v_by, approved_at = now()
   where g.id = p_id;
  insert into approvals (object_type, object_id, content_sha256, decision,
                         approved_by, note)
  values ('cogs_version', p_id::text, v_sha, 'approved', v_by, p_note)
  returning approvals.id into v_aid;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'cogs_approve', 'cogs_version', p_id::text,
          jsonb_build_object('approval_id', v_aid, 'content_sha256', v_sha));
  return v_aid;
end $$;
revoke execute on function approve_cogs(bigint, text, text) from public;

create table if not exists opex_entries (
  id bigint generated always as identity primary key,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text not null,          -- basename, không đường dẫn
  row_no int not null check (row_no >= 2),
  month date not null check (extract(day from month) = 1),
  category text not null check (category in ('cloud', 'saas', 'ads', 'khac')),
  service text not null check (service ~ '^[a-z0-9][a-z0-9_.-]{1,39}$'),
  amount_vnd bigint not null check (amount_vnd > 0),
  doc_ref text,
  imported_at timestamptz not null default now(),
  unique (file_sha256, row_no)
);
create index if not exists opex_entries_month_idx on opex_entries (month);

-- ============================================================================
-- v8.3 phòng Dự án (WP11 DA) — 2 bảng còn lại sau v12.0 (radar chương trình
-- `programs` DA-03 đã gỡ: xúc tiến ngoài phạm vi HĐ), KHÔNG PII.
-- * `org_prospects` — DA-05 tổ chức mua quà Tết: `agents/da_b2b.py --import`
--   ghi từ CSV NHẬP TAY (chỉ thông tin TỔ CHỨC công khai — KHÔNG cột SĐT/
--   email/tên người/địa chỉ/liên hệ). Chỉ đổi `status`/`batch_queue_id`/
--   `handed_at` qua `--submit-batch`/`--handover` (lô phải được NGƯỜI duyệt
--   trong `approval_queue` và khớp sha256). Hệ thống KHÔNG tự liên hệ.
-- * `project_milestones` — DA-01 sổ mốc: `agents/da_pmo.py --seed` từ
--   `data/projects/milestones.json` (`on conflict (code) do nothing` — sửa
--   tay không bị đè); đổi hạn chỉ qua mục `milestone_change` đã duyệt.
--   `owner_role` = vai trò, không tên người.
-- Quyền: `docs/roles.sql` KHÔNG grant 2 bảng này (agent_writer/app_human bị
-- từ chối mặc định) — CLI chạy DSN chủ sở hữu; grant hẹp = someday.
-- ============================================================================

create table if not exists org_prospects (
  id bigint generated always as identity primary key,
  dedup_key text not null unique check (dedup_key ~ '^b2b:[0-9a-f]{64}$'),
  org_name text not null check (char_length(btrim(org_name)) between 2 and 200),
  org_type text not null check (org_type in ('doanh_nghiep', 'khach_san',
    'su_kien_hoi_nghi', 'hiep_hoi', 'co_quan', 'khac')),
  region text not null,
  website text check (website ~ '^https?://'),
  source_url text not null check (source_url ~ '^https?://'),
  fit_reason text check (char_length(fit_reason) <= 300),
  source text not null,
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  status text not null default 'moi'
    check (status in ('moi', 'cho_duyet', 'chuyen_sales')),
  batch_queue_id bigint,
  handed_at timestamptz
);

create table if not exists project_milestones (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_.-]{1,31}$'),
  title text not null,
  wp text,
  owner_role text not null,
  due_date date not null,
  gate text not null check (btrim(gate) <> ''),
  evidence text,
  status text not null default 'chua_bat_dau'
    check (status in ('chua_bat_dau', 'dang_lam', 'xong', 'tam_dung')),
  source text not null,
  updated_by text,
  updated_at timestamptz default now(),
  check (status <> 'xong' or btrim(coalesce(evidence, '')) <> '')
);

-- ============================================================================
-- v5.1 KD-A1 CSKH đa kênh (WP07): đồng ý tư vấn qua chat Zalo/Messenger.
-- Ai ghi: connectors/channels.py (`record_consent`, gọi từ connectors/zalo.py
-- _reply — dùng chung cho Messenger) CHỈ khi khách gõ đồng ý/rút đồng ý TRỌN
-- tin ("Đồng ý" / "Không đồng ý"), hoặc `prompted` khi gửi câu chào + link
-- chính sách ở tin đầu. KHÔNG suy diễn đồng ý từ tin khác. Ai đọc:
-- `consent_state` (cờ `require_consent_for_llm` trong data/channels.json).
-- Vì sao bảng riêng (không dùng `consents` v5.2): `consents` bắt buộc
-- `contact_id` (cần SĐT trong vault) trong khi đồng ý tư vấn chat xảy ra
-- trước khi khách để lại liên hệ. `user_hash` = HMAC-SHA256 có muối
-- (env CHANNEL_HASH_SALT) 32 hex — KHÔNG user_id/psid thô; `evidence_ref` =
-- sha256(msg_id)[:16], không phải nội dung tin. APPEND-ONLY (rút đồng ý =
-- thêm dòng withdrawn); trạng thái hiện hành = dòng granted/withdrawn mới
-- nhất theo `id` (view `v_chat_consent_current`). Sàn (Shopee/TikTok)
-- không có consent — check channel chặn ghi nhầm.
-- ============================================================================

create table if not exists chat_consents (
  id bigint generated always as identity primary key,
  user_hash text not null check (user_hash ~ '^[0-9a-f]{32}$'),
  channel text not null check (channel in ('zalo', 'messenger')),
  purpose text not null default 'tu_van_chat'
    check (purpose = 'tu_van_chat'),
  action text not null check (action in ('prompted', 'granted', 'withdrawn')),
  policy_version text not null check (btrim(policy_version) <> ''),
  evidence_ref text,                -- sha256(msg_id)[:16] — không phải nội dung tin
  ts timestamptz not null default now()
);
create index if not exists chat_consents_user_channel_idx
  on chat_consents (user_hash, channel, id);

create or replace trigger chat_consents_append_only_row
  before update or delete on chat_consents
  for each row execute function append_only_guard();
create or replace trigger chat_consents_no_truncate
  before truncate on chat_consents
  for each statement execute function append_only_guard();

-- Đồng ý chat hiện hành: dòng granted/withdrawn mới nhất theo id (KHÔNG
-- theo ts) mỗi (user_hash, channel); `prompted` không đổi trạng thái.
create or replace view v_chat_consent_current as
select distinct on (user_hash, channel)
  user_hash, channel, action, ts, id as consent_id
from chat_consents
where action in ('granted', 'withdrawn')
order by user_hash, channel, id desc;

-- ============================================================================
-- v6.2 (MKT-03 ảnh AI, WP08): 1 dòng / file ảnh nháp do
-- `pipelines.image_studio` ghép (packshot THẬT dán nguyên khối lên nền tất
-- định hoặc nền do API sinh ảnh tạo). File PNG nằm ngoài DB
-- (`IMAGE_OUT_DIR/<file_sha256>.png` + sidecar `.json`); bảng giữ metadata
-- truy vết + liên kết nháp `content_drafts` (content_type 'image', pending —
-- người duyệt, người đăng tay). Insert-only: agent_writer chỉ SELECT/INSERT
-- (docs/roles.sql), KHÔNG update/delete, không delete-by-source.
--   ai_generated  — nền do provider AI sinh (provider <> 'none'). Ràng buộc
--                   DB: ảnh AI LUÔN có nhãn "Nội dung có sử dụng AI" trong
--                   label_text + model + prompt_sha256 (acceptance WP08
--                   "100% asset AI có nhãn + metadata model/prompt/ngày" —
--                   ngày = created_at). Chuỗi nhãn phải trùng labels.ai[0]
--                   của data/guardrail_rules.json (drift-guard trong test).
--   packshot_sha256 — sha256 file packshot gốc công ty cấp (vùng nhãn bao bì
--                   được kiểm khớp pixel tuyệt đối trước khi ghi) — của
--                   TỪNG dòng (2 SKU có thể dùng 2 file packshot khác bytes
--                   mà cùng pixel -> cùng ảnh).
--   meta          — sidecar JSON đầy đủ (labels, box, background, created_at;
--                   sidecar mô tả FILE: không chứa sku/kênh/format/sha file
--                   packshot gốc — các thứ đó ở cột của dòng; meta MỌI dòng
--                   cùng ảnh == sidecar).
-- Danh tính asset = (file_sha256, sku, channel, format) = đúng 1 mục CLI
-- (SKU × kênh × format) trên 1 ảnh: cùng 1 ảnh cho 2 kênh / 2 SKU (packshot
-- y hệt) / 2 format cùng cỡ = 2 dòng / 2 nháp (chung file PNG + sidecar);
-- chạy lại cùng mục -> skipped (unique chặn cả race 2 process).
create table if not exists image_assets (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  file_sha256 text not null,
  file_name text not null,
  sku text not null,
  channel text not null,
  format text not null,
  ai_generated boolean not null,
  label_text text not null,
  provider text not null,
  model text,
  prompt_sha256 text,
  prompt_version text,
  packshot_sha256 text not null,
  draft_id bigint not null references content_drafts(id),
  meta jsonb not null,
  created_by text not null,
  unique (file_sha256, sku, channel, format),
  check (not ai_generated or (label_text like '%Nội dung có sử dụng AI%'
         and model is not null and prompt_sha256 is not null))
);

-- ============================================================================
-- v10.3 social listening nhà cung cấp (WP16 nền P2) — `ingest/social_vendor.py`.
--   * CỔNG TGĐ: module từ chối nạp (exit 2, không đọc file, không connect)
--     tới khi `data/social_vendor.json` có `vendor_approved_by_tgd: true` +
--     `approval_ref` — CHỈ người thật đổi sau khi TGĐ duyệt hợp đồng + DPA.
--   * Bảng RIÊNG (không chèn vào `social_mentions`): `social_mentions` là kênh
--     SỞ HỮU với check channel/kind cố định; drift-guard cấm `alter ...
--     constraint` → tách bảng, đồng thời báo cáo kênh sở hữu (`intel_weekly`)
--     không bị trộn dữ liệu bên thứ ba.
--   * KHÔNG cột tên/ID/URL/SĐT/email tác giả: `id_tac_gia`/`ma_tin` chỉ vào
--     vật liệu hash dedup (`msg_hash` sha256 CÓ MUỐI `INTEL_HASH_SALT`, cùng
--     hàm v7.2); `excerpt` (đã che, ≤200) CHỈ khi DPIA đã ký và tin không
--     nhạy cảm (cùng luật v7.2). Meta file ở `intel_imports` (kind
--     `social`, channel `vendor`).
-- ============================================================================

create table if not exists social_mentions_vendor (
  id bigint generated always as identity primary key,
  import_id bigint not null references intel_imports(id),
  platform text not null check (platform in
    ('facebook', 'tiktok', 'youtube', 'instagram', 'forum', 'news', 'khac')),
  kind text not null check (kind in ('post', 'comment', 'review')),
  posted_at timestamptz not null,
  msg_hash text not null unique,    -- sha256 có MUỐI (INTEL_HASH_SALT)
  labels text[] not null check (cardinality(labels) > 0),
  sensitive boolean not null,       -- true = hỏi sức khỏe
  excerpt text check (char_length(excerpt) <= 200)
);

create index if not exists social_mentions_vendor_posted_idx on social_mentions_vendor (posted_at);

-- ============================================================================
-- v6.3 (MKT-04 video ngắn AI, WP08): metadata video NHÁP do
-- pipelines/video_studio.py dựng (khung packshot thật qua image_studio +
-- B-roll có license + phụ đề từ kịch bản LLM). File mp4 `<sha>.mp4` + sidecar
-- `.json` nằm ở VIDEO_OUT_DIR (ngoài DB). Bảng RIÊNG, không mở rộng
-- image_assets (cột khác hẳn: thời lượng, model/prompt kịch bản, TTS, nhiều
-- khung; mở rộng phải `alter` ràng buộc cũ). Insert-only (agent_writer chỉ
-- SELECT/INSERT — docs/roles.sql).
--   label_text   — nhãn trên MỌI khung, nối "\n". Kịch bản LUÔN do LLM nên
--                  video LUÔN là nội dung AI: nhãn "Nội dung có sử dụng AI"
--                  là ràng buộc DB VÔ ĐIỀU KIỆN (acceptance WP08). Chuỗi
--                  phải trùng labels.ai[0] của data/guardrail_rules.json
--                  (drift-guard trong test).
--   duration_ms  — 15–45 giây (final_plans MKT-04 acceptance).
--   script_*     — model + sha256 messages gửi LLM + version template.
--   tts_provider — 'none' = video không tiếng (TTS có phí = external-dep).
--   packshot_sha256 — sha256 file packshot gốc của TỪNG dòng.
--   meta         — sidecar JSON (mô tả FILE: không sku/kênh/format/sha
--                  packshot gốc; meta mọi dòng cùng file == sidecar).
-- Danh tính asset = (file_sha256, sku, channel, format) = 1 mục CLI.
create table if not exists video_assets (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  file_sha256 text not null,
  file_name text not null,
  sku text not null,
  channel text not null,
  format text not null,
  duration_ms integer not null check (duration_ms between 15000 and 45000),
  label_text text not null,
  script_model text not null,
  script_prompt_sha256 text not null,
  script_prompt_version text not null,
  tts_provider text not null,
  packshot_sha256 text not null,
  draft_id bigint not null references content_drafts(id),
  meta jsonb not null,
  created_by text not null,
  unique (file_sha256, sku, channel, format),
  check (label_text like '%Nội dung có sử dụng AI%')
);

-- ============================================================================
-- v8.1 Sổ quyết định TGĐ (WP10 — Agent Tiến độ & Sổ quyết định).
-- * `decision_log` — 1 dòng `quyet_dinh` = 1 quyết định của TGĐ/HĐTV (ngày,
--   chủ đề, quyết định, người quyết, căn cứ: id `approval_queue`/`approvals`/
--   `decisions` hoặc `van_ban` mô tả ≥ 10 ký tự, hạn thực hiện). Theo dõi
--   thực hiện = dòng `cap_nhat` MỚI trỏ `parent_id` (trạng thái hiện tại =
--   dòng mới nhất theo id của chuỗi) — KHÔNG UPDATE. APPEND-ONLY bằng
--   `append_only_guard()` (chặn UPDATE/DELETE/TRUNCATE, kể cả owner khi
--   trigger còn bật).
-- Ai ghi: CLI `python -m agents.ceo_decisions --record|--follow` (DSN chủ sở
-- hữu) do NGƯỜI chạy với `--by` (CHECK chặn 'agent:'/'system:' ở cả người
-- quyết lẫn người ghi); agent CHỈ đề xuất (`--propose`, chỉ đọc). Ai đọc:
-- cockpit TGĐ (`agents.ceo_report`), bản tin GĐ khối ceo. Ship RỖNG — quyết
-- định thật của TGĐ là external-dep. `docs/roles.sql` KHÔNG grant (agent_
-- writer/app_human bị từ chối mặc định) — grant hẹp = someday.
-- ============================================================================

create table if not exists decision_log (
  id bigint generated always as identity primary key,
  entry_kind text not null check (entry_kind in ('quyet_dinh', 'cap_nhat')),
  parent_id bigint references decision_log (id),
  decided_on date,
  topic text check (char_length(topic) between 1 and 200),
  decision text check (char_length(decision) between 1 and 2000),
  decided_by text check (decided_by is null
                         or decided_by !~* '^\s*(agent|system)\s*:'),
  basis_kind text check (basis_kind in ('approval_queue', 'approvals',
                                        'decisions', 'van_ban')),
  basis_id bigint,
  due_date date,
  follow_status text not null default 'mo'
    check (follow_status in ('mo', 'dang_lam', 'xong', 'huy')),
  note text check (char_length(note) <= 500),
  recorded_by text not null check (btrim(recorded_by) <> ''
                                   and recorded_by !~* '^\s*(agent|system)\s*:'),
  recorded_at timestamptz not null default now(),
  db_role text not null default session_user,
  check ((entry_kind = 'quyet_dinh') = (parent_id is null)),
  check (entry_kind <> 'quyet_dinh'
         or (decided_on is not null and topic is not null
             and decision is not null and basis_kind is not null
             and btrim(coalesce(decided_by, '')) <> '')),
  check (entry_kind <> 'cap_nhat' or (basis_kind is null and basis_id is null)),
  check (basis_kind is null or basis_kind = 'van_ban' or basis_id is not null),
  check (due_date is null or decided_on is null or due_date >= decided_on),
  check (entry_kind <> 'cap_nhat' or follow_status <> 'xong'
         or btrim(coalesce(note, '')) <> ''),
  check (basis_kind is distinct from 'van_ban'
         or char_length(btrim(coalesce(note, ''))) >= 10)
);
-- 1 căn cứ hệ thống → đúng 1 mục quyết định (2 người ghi song song cũng chặn).
create unique index if not exists decision_log_basis_uq
  on decision_log (basis_kind, basis_id)
  where entry_kind = 'quyet_dinh' and basis_id is not null;
create index if not exists decision_log_parent_idx
  on decision_log (parent_id, id);

-- recorded_at/db_role do DB đặt (không tin client — không lùi giờ ghi được);
-- `cap_nhat` phải trỏ một dòng `quyet_dinh` (không nối chuỗi cập nhật).
create or replace function decision_log_stamp() returns trigger
language plpgsql as $$
begin
  new.recorded_at := now();
  new.db_role := session_user;
  if new.entry_kind = 'cap_nhat' and not exists (
      select 1 from decision_log p
       where p.id = new.parent_id and p.entry_kind = 'quyet_dinh') then
    raise exception 'decision_log: cap_nhat phải trỏ parent_id là dòng quyet_dinh';
  end if;
  return new;
end $$;
revoke execute on function decision_log_stamp() from public;

create or replace trigger decision_log_stamp_ins
  before insert on decision_log
  for each row execute function decision_log_stamp();
create or replace trigger decision_log_append_only_row
  before update or delete on decision_log
  for each row execute function append_only_guard();
create or replace trigger decision_log_no_truncate
  before truncate on decision_log
  for each statement execute function append_only_guard();

-- ============================================================================
-- v6.4 MKT-05 phiếu thử nghiệm ads (WP08): 1 dòng / phiếu ĐỀ XUẤT thử nghiệm
-- quảng cáo (SKU × kênh ads × giả thuyết × biến thể creative đã duyệt ×
-- ngân sách ≤ trần FP&A v9.1 `agents.fp_ads` × thời gian × chỉ số thành công
-- × điều kiện dừng). Ai ghi: `python -m agents.mkt_ads --plan` (DSN chủ sở
-- hữu — bảng CHƯA grant cho agent_writer/app_human). Ai đọc: `--status`/
-- `--results`. Phiếu chỉ là NHÁP: 2 mục `approval_queue` risk high cùng
-- object_id `adtest-<id>` (marketing/ad_campaign + finance/budget_change) —
-- agent KHÔNG chi tiền, KHÔNG gọi API quảng cáo; Quản lý MXH cài tay sau khi
-- duyệt đủ 2. Insert-only (trigger `append_only_guard`), không PII, không
-- cột tiền đã chi. `readiness` chỉ nhận mức online được quảng cáo — DB tự
-- chặn listing_only (MO_TA) / CAM dù code lỗi.
-- ============================================================================
create table if not exists ad_test_plans (
  id bigint generated always as identity primary key,
  plan_sha256 text not null unique check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  sku_key text not null references sku_master(sku_key),
  channel text not null
    check (channel in ('shopee', 'tiktok', 'web', 'facebook', 'zalo',
                       'chatbot')),
  hypothesis text not null check (char_length(btrim(hypothesis)) between 10 and 500),
  creative_draft_ids bigint[] not null
    check (cardinality(creative_draft_ids) between 1 and 3),
  budget_vnd bigint not null check (budget_vnd > 0),
  cap_vnd bigint not null,
  -- tổng budget_vnd phiếu KHÁC cùng SKU × kênh × tháng (chưa từ chối/hết
  -- hạn) lúc lập — chống chẻ trần FP&A thành nhiều phiếu nhỏ (v6.4 fix)
  allocated_vnd bigint not null default 0 check (allocated_vnd >= 0),
  cap_ref_month date not null check (extract(day from cap_ref_month) = 1),
  start_date date not null,
  end_date date not null,
  success_metric jsonb not null,
  stop_rules jsonb not null
    check (jsonb_typeof(stop_rules) = 'array'
           and jsonb_array_length(stop_rules) >= 1),
  readiness text not null check (readiness in ('TP_THUONG', 'QC_DAY_DU')),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  check (budget_vnd <= cap_vnd),
  check (end_date >= start_date and end_date - start_date <= 30)
);

create or replace trigger ad_test_plans_append_only_row
  before update or delete on ad_test_plans
  for each row execute function append_only_guard();
create or replace trigger ad_test_plans_no_truncate
  before truncate on ad_test_plans
  for each statement execute function append_only_guard();

-- ============================================================================
-- v8.2 KD-A3 báo giá B2B (WP11) — yêu cầu báo giá quà Tết từ form B2B.
--   * `b2b_requests` insert-only (trigger append_only_guard chặn UPDATE/
--     DELETE/TRUNCATE). Ai ghi: `connectors/b2b_form.intake` (1 transaction:
--     contact vault → consent mục đích 'b2b' → dòng này). Ai đọc:
--     `agents.kd_quote` (--requests / --quote). KHÔNG cột PII: tên/SĐT/email
--     người liên hệ CHỈ ở `contacts` (mã hóa Fernet) — bảng giữ `contact_id`
--     + `consent_id`. `org_name` là tên TỔ CHỨC (hộ kinh doanh có thể trùng
--     tên người — gap ghi DPIA DF-31). `request_key` = b2r:sha256(tên tổ chức
--     chuẩn hóa + tỉnh + items canonical + ngày VN) chống gửi trùng.
--     `items` = [{key, qty}] (1..10 dòng; key = SKU/combo của catalog).
-- Quyền: roles.sql KHÔNG grant bảng này cho agent_writer/app_human (mặc định
-- từ chối) — form/CLI chạy DSN chủ sở hữu; grant hẹp = someday.
-- ============================================================================

create table if not exists b2b_requests (
  id bigint generated always as identity primary key,
  request_key text not null unique check (request_key ~ '^b2r:[0-9a-f]{64}$'),
  org_name text not null check (char_length(btrim(org_name)) between 2 and 200),
  org_type text not null check (org_type in ('doanh_nghiep', 'khach_san',
    'su_kien_hoi_nghi', 'hiep_hoi', 'co_quan', 'khac')),
  region text not null,             -- 1 trong 34 tỉnh (ingest.crm.province_of)
  items jsonb not null check (jsonb_typeof(items) = 'array'
    and jsonb_array_length(items) between 1 and 10),
  need_by date,
  contact_id bigint not null references contacts(id),
  consent_id bigint not null references consents(id),
  source text not null check (source ~ '^[a-z0-9_.:-]{1,50}$'),
  created_at timestamptz not null default now()
);

create or replace trigger b2b_requests_append_only_row
  before update or delete on b2b_requests
  for each row execute function append_only_guard();
create or replace trigger b2b_requests_no_truncate
  before truncate on b2b_requests
  for each statement execute function append_only_guard();

-- ============================================================================
-- v10.1 KD-A7 (WP16) — lần mua của khách KÊNH SỞ HỮU (web/Zalo/B2B/showroom)
-- để agent `agents.kd_care` lập NHÁP tin chăm sóc lại / xin đánh giá. Khách
-- sàn (Shopee/TikTok) bị CHẶN Ở DB — khách sàn chỉ chăm sóc bằng công cụ của
-- sàn (điều khoản sàn cấm kéo khách ra ngoài). KHÔNG cột PII: khách chỉ là
-- `contact_id` (PII nằm trong vault `contacts` mã hóa); `order_ref` là MÃ
-- nội bộ. Người ghi (`recorded_by`) là NGƯỜI — agent không tự ghi lần mua.
-- Không FK sang `orders` (core_store xóa `orders` theo source khi nạp lại).
-- Quyền: roles.sql KHÔNG grant cho agent_writer/app_human (mặc định từ chối)
-- — CLI chạy DSN chủ sở hữu; grant hẹp = someday.
-- ============================================================================

create table if not exists care_purchases (
  id bigint generated always as identity primary key,
  contact_id bigint not null references contacts(id),
  channel text not null check (channel in ('web', 'zalo', 'b2b', 'showroom')),
  order_ref text check (order_ref ~ '^[A-Za-z0-9_.:-]{1,40}$'),
  sku_key text not null references sku_master(sku_key),
  purchased_on date not null,
  delivered_on date check (delivered_on >= purchased_on),
  recorded_by text not null check (btrim(recorded_by) <> ''
                                   and recorded_by not like 'agent:%'),
  created_at timestamptz not null default now()
);
create index if not exists care_purchases_contact_idx
  on care_purchases (contact_id, purchased_on);

-- ============================================================================
-- v5.4 KD-A8 affiliate đại lý (WP07) — `agents.kd_affiliate`.
--   * `affiliate_codes` — mã affiliate NGẪU NHIÊN (`secrets`, "SS" + 10 ký
--     tự bảng 32, không 0/O/1/I; không chứa mã đại lý/ngày/số thứ tự) cho
--     đại lý `dealers` active × kênh shopee|tiktok|web. Vòng đời: pending
--     (mục `affiliate_program` khối sales đang chờ) → active (mục approved +
--     verify khớp payload, `--release`) | void (mục rejected/expired);
--     active → revoked (`--revoke`). Mỗi (đại lý, kênh) tối đa 1 mã
--     pending|active (unique partial index). Voucher/coupon THẬT trên sàn/
--     WooCommerce do Quản lý MXH tạo TAY — bảng này không gọi sàn.
--   * `affiliate_attributions` — 1 dòng/(kênh, order_id_hash, line_key) đơn
--     sàn có mã voucher khớp `affiliate_codes` (từ `market_rows.raw`
--     `voucher_code`, snapshot mới nhất). Hoa hồng TẠM TÍNH (BẢN NHÁP, không
--     phải lệnh chi) = `ingest.crm.commission_rate(..., online=True)`; rượu
--     = 0 chốt ở CẢ code lẫn CHECK dưới; đơn hủy = 0. KHÔNG mã đơn gốc/PII
--     người mua (chỉ hash), KHÔNG tên đại lý (chỉ `dealer_code`).
-- Quyền: roles.sql KHÔNG grant 2 bảng này (mặc định từ chối như `dealers`/
-- `settlement_rows`) — CLI chạy DSN chủ sở hữu.
-- ============================================================================

create table if not exists affiliate_codes (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^SS[A-HJ-NP-Z2-9]{10}$'),
  dealer_code text not null references dealers(code),
  channel text not null check (channel in ('shopee', 'tiktok', 'web')),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'void', 'revoked')),
  queue_id bigint unique references approval_queue(id),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by text,
  revoked_at timestamptz,
  revoked_by text,
  check (status not in ('active', 'revoked') or activated_at is not null),
  check (status <> 'revoked' or revoked_at is not null)
);
create unique index if not exists affiliate_codes_open_uq
  on affiliate_codes (dealer_code, channel)
  where status in ('pending', 'active');

create table if not exists affiliate_attributions (
  id bigint generated always as identity primary key,
  code_id bigint not null references affiliate_codes(id),
  dealer_code text not null,
  channel text not null check (channel in ('shopee', 'tiktok')),
  order_id_hash text not null check (order_id_hash ~ '^[0-9a-f]{16}$'),
  line_key text not null check (btrim(line_key) <> ''),
  market_row_id bigint not null references market_rows(id),
  sku_key text,
  category text,
  qty int not null check (qty >= 0),
  amount_vnd bigint not null check (amount_vnd >= 0),
  rate_pct numeric(5,2) not null check (rate_pct between 0 and 100),
  commission_vnd bigint not null check (commission_vnd >= 0),
  status text not null check (status in ('tinh', 'huy')),
  flags text[] not null default '{}',
  settled boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (channel, order_id_hash, line_key),
  -- Chốt chặn rượu ở DB: rượu bán online KHÔNG có hoa hồng (WP07).
  check (category is distinct from 'alcohol' or commission_vnd = 0),
  check (status <> 'huy' or commission_vnd = 0)
);

-- ============================================================================
-- v10.0 HĐTV/BKS (WP16): sổ lần chạy kiểm soát độc lập.
--   * `audit_runs` — 1 dòng / lần chạy `agents.bks_audit --record` (audit
--     inside-out, kind `inside_out`), `agents.bks_recon --record` (đối soát
--     độc lập, `recon`), `agents.hdtv_report --record` (gói HĐTV,
--     `hdtv_pack`). `params` = seed / cỡ mẫu / head chuỗi hash (neo đuôi cho
--     lần audit sau) — KHÔNG PII, KHÔNG mã đơn. `report_sha256` = sha256 file
--     báo cáo đã ghi. `run_by` = agent (`agent:bks_audit`...) — sổ lần chạy
--     MÁY, KHÔNG phải chữ ký người (chữ ký HĐTV/BKS = external-dep).
--     APPEND-ONLY (`append_only_guard()` chặn UPDATE/DELETE/TRUNCATE, kể cả
--     owner khi trigger còn bật). GIỚI HẠN: superuser xóa cả bảng này thì
--     neo nội bộ mất — neo object-lock ngoài = external-dep.
-- Quyền (`docs/roles.sql`): role `bks_reader` (nologin) SELECT các bảng 3
-- module đọc + INSERT 6 cột bảng này; agent_writer/app_human KHÔNG có quyền.
-- ============================================================================

create table if not exists audit_runs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('inside_out', 'recon', 'hdtv_pack')),
  period_label text not null
    check (period_label ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  params jsonb not null default '{}',
  findings int not null check (findings >= 0),
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  run_by text not null check (btrim(run_by) <> ''),
  created_at timestamptz not null default now(),
  db_role text not null default session_user
);
create index if not exists audit_runs_kind_idx on audit_runs (kind, id);

create or replace trigger audit_runs_append_only_row
  before update or delete on audit_runs
  for each row execute function append_only_guard();
create or replace trigger audit_runs_no_truncate
  before truncate on audit_runs
  for each statement execute function append_only_guard();

-- ===== v12.1 B1 =====
-- Sổ triển khai 3 bước theo HĐ TEDO–Sâm Sâm PL02 mục 1 (`pipelines/rollout.py`).
--   * `feature_rollout` — trạng thái HIỆN TẠI 1 dòng / tính năng của
--     `data/contract_features.json`: `chay_thu` → `co_nguoi_duyet` →
--     `van_hanh` (+ `tat`). `stage_since` = lúc vào giai đoạn (mốc đếm ngày
--     làm việc + đầu ra `agent_action_log`). Bảng trạng thái (có UPDATE) —
--     chỉ CLI (owner) ghi, mỗi lần đổi đi kèm 1 dòng sự kiện cùng tx.
--   * `feature_rollout_events` — APPEND-ONLY (`append_only_guard()`): seed /
--     nâng / lỗi nghiêm trọng (tự lùi về `chay_thu`) / tắt. `by_person` =
--     người thật ghi (CHECK chặn 'agent:'/'system:'). `note` đã che PII ở
--     code. Đây là "nhật ký lỗi" của hồ sơ đề nghị nghiệm thu.
-- KHÔNG PII. Quyền (`docs/roles.sql`): app_human chỉ SELECT 2 bảng.
-- ============================================================================

create table if not exists feature_rollout (
  feature_id text primary key check (feature_id ~ '^[a-z_]+-[0-9]{2}$'),
  stage text not null
    check (stage in ('chay_thu', 'co_nguoi_duyet', 'van_hanh', 'tat')),
  stage_since timestamptz not null default now(),
  updated_by text not null check (btrim(updated_by) <> ''),
  updated_at timestamptz not null default now()
);

create table if not exists feature_rollout_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  feature_id text not null references feature_rollout (feature_id),
  kind text not null check (kind in ('seed', 'promote', 'severe', 'disable')),
  from_stage text
    check (from_stage in ('chay_thu', 'co_nguoi_duyet', 'van_hanh', 'tat')),
  to_stage text not null
    check (to_stage in ('chay_thu', 'co_nguoi_duyet', 'van_hanh', 'tat')),
  severe_code text,
  note text,
  evidence jsonb not null default '{}',
  by_person text not null check (btrim(by_person) <> ''
    and lower(btrim(by_person)) not like 'agent:%'
    and lower(btrim(by_person)) not like 'system:%'),
  check ((kind = 'severe') = (severe_code is not null))
);
create index if not exists feature_rollout_events_fid_idx
  on feature_rollout_events (feature_id, ts);

create or replace trigger feature_rollout_events_append_only_row
  before update or delete on feature_rollout_events
  for each row execute function append_only_guard();
create or replace trigger feature_rollout_events_no_truncate
  before truncate on feature_rollout_events
  for each statement execute function append_only_guard();

-- ===== v12.4 B4 =====
-- Nhật ký vườn qua Zalo (`connectors/zalo_garden.py`, HĐ PL01 mục 7): tin
-- chữ của nhân viên vườn ghi thẳng `plot_logs` (source `zalo:garden`, vào hash
-- chain v9.3); ảnh vào `garden_media` (đã gỡ EXIF/GPS). Ghi âm KHÔNG thành
-- nhật ký ngay: file lưu NGOÀI repo (`<GARDEN_MEDIA_DIR>/audio/`, theo
-- sha256) + 1 dòng nháp ở bảng dưới, trạng thái `cho_chep_loi`; người nghe
-- ghi nhật ký (`agents.garden`) rồi đóng nháp (`--done`, trỏ `plot_log_id`).
-- KHÔNG lưu user_id Zalo / tên người — chỉ `staff_code` (mã NV allowlist).
-- Chưa có STT (external-dep) → không cột transcript.
create table if not exists garden_voice_drafts (
  id bigint generated always as identity primary key,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  ext text not null
    check (ext in ('aac', 'm4a', 'mp3', 'amr', 'wav', 'ogg', 'bin')),
  bytes bigint not null check (bytes > 0),
  staff_code text not null check (btrim(staff_code) <> ''),
  plot_id text references plots(id),
  status text not null default 'cho_chep_loi'
    check (status in ('cho_chep_loi', 'da_chep_loi')),
  plot_log_id bigint references plot_logs(id),
  closed_by text check (closed_by is null or btrim(closed_by) <> ''),
  closed_at timestamptz,
  source text not null default 'zalo:garden',
  received_at timestamptz not null default now(),
  check ((status = 'da_chep_loi') = (plot_log_id is not null
    and closed_by is not null and closed_at is not null))
);
create index if not exists garden_voice_drafts_status_idx
  on garden_voice_drafts (status, id);

-- ===== v12.5 B5 doanh thu thuần trực tuyến + đối soát quý =====
-- HĐ hợp tác Điều 7.3 (Bên A xem số liệu doanh thu/đơn trực tuyến; lưu
-- ≥180 ngày, không sửa/xóa khi Bên A không đồng ý), 7.5 + 8.3 (đối soát
-- doanh thu thuần trực tuyến mỗi quý — biên bản 2 bên ký là căn cứ DUY
-- NHẤT tính phí vận hành/thưởng).
--   * `revenue_quarters` — 1 dòng / lần `python -m agents.rev_share
--     --quarter YYYY-Qn --record`: số ĐỀ XUẤT do hệ thống (Bên A vận hành)
--     dựng từ `settlement_rows` + trạng thái đơn `orders` (source
--     `market:%`). Ô tiền NULL = "chưa có dữ liệu" (KHÔNG coi = 0).
--     `fee_rate`/`ops_fee_vnd` NULL = tỷ lệ chưa chốt. `detail` = số theo
--     kênh + nguồn + ghi chú thiếu nguồn (không mã đơn/hash/PII).
--     `report_sha256` = sha256 file biên bản đã ghi. Ghi lại cùng quý →
--     dòng MỚI (lịch sử giữ nguyên; dòng id lớn nhất = đề xuất hiện hành).
--     APPEND-ONLY (`append_only_guard()` chặn UPDATE/DELETE/TRUNCATE).
--   * `v_ben_a_settlement_daily` / `v_ben_a_orders_daily` — số tổng hợp
--     theo ngày × kênh (KHÔNG mã đơn/hash) cho role `ben_a_reader`
--     (`docs/roles.sql`). `orders.ts` của đơn sàn = ngày NẠP file (file
--     xuất sàn chưa có cột ngày đặt — GIẢ ĐỊNH v10.1 `agents.kd_orders`).
-- ============================================================================

create table if not exists revenue_quarters (
  id bigint generated always as identity primary key,
  quarter text not null check (quarter ~ '^[0-9]{4}-Q[1-4]$'),
  period_start date not null,
  period_end date not null,             -- exclusive
  gross_vnd bigint,
  platform_fee_vnd bigint,
  cancel_vnd bigint,
  refund_vnd bigint,
  net_vnd bigint,
  payout_vnd bigint,
  fee_rate numeric check (fee_rate is null or fee_rate between 0 and 1),
  ops_fee_vnd bigint check (ops_fee_vnd is null or ops_fee_vnd >= 0),
  detail jsonb not null default '{}',
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by text not null check (btrim(recorded_by) <> ''),
  recorded_at timestamptz not null default now(),
  check (period_start < period_end),
  check (ops_fee_vnd is null or (fee_rate is not null and net_vnd is not null))
);
create index if not exists revenue_quarters_quarter_idx
  on revenue_quarters (quarter, id);

create or replace trigger revenue_quarters_append_only_row
  before update or delete on revenue_quarters
  for each row execute function append_only_guard();
create or replace trigger revenue_quarters_no_truncate
  before truncate on revenue_quarters
  for each statement execute function append_only_guard();

-- v13.2: định nghĩa lại ở khối `v13.2 c02` (đọc `v_settlement_khoan`).
create or replace view v_ben_a_settlement_daily as
select settled_on, channel, count(*) as n_rows,
       sum(order_amount_vnd) as order_amount_vnd,
       sum(fixed_fee_vnd) as fixed_fee_vnd,
       sum(payment_fee_vnd) as payment_fee_vnd,
       sum(service_fee_vnd) as service_fee_vnd,
       sum(shipping_fee_vnd) as shipping_fee_vnd,
       sum(voucher_seller_vnd) as voucher_seller_vnd,
       sum(affiliate_vnd) as affiliate_vnd,
       sum(refund_vnd) as refund_vnd,
       sum(payout_vnd) as payout_vnd
from settlement_rows
group by settled_on, channel;

create or replace view v_ben_a_orders_daily as
select (ts at time zone 'Asia/Ho_Chi_Minh')::date as day, channel, status,
       count(*) as n_orders, sum(total_vnd) as total_vnd
from orders
where source like 'market:%'
group by 1, 2, 3;

-- ===== v13.0 c00 danh mục yêu cầu (ID mục tách) =====
-- `data/contract_features.json` v13.0 tách nhóm PL01 thành mục `<nhóm>.<n>`
-- (`nhom_goc` = id nhóm v12). Nới CHECK id để nhận mục tách; dòng của id
-- nhóm cũ GIỮ NGUYÊN (không sửa/xóa, events append-only) — mục tách vào sổ
-- với mốc mới (`pipelines.rollout.seed`, evidence.nhom_goc). Idempotent.
alter table feature_rollout
  drop constraint if exists feature_rollout_feature_id_check;
alter table feature_rollout
  add constraint feature_rollout_feature_id_check
  check (feature_id ~ '^[a-z_]+-[0-9]{2}([.][0-9]{1,2})?$');

-- ===== v13.2 c02 đối soát chồng kỳ =====
-- F01: cùng 1 khoản quyết toán có thể bị kế toán xuất lại ở file khác/chồng
-- kỳ (khác sha256 → `unique (file_sha256, row_no)` không chặn). Dữ liệu thô
-- GIỮ NGUYÊN (không xóa/không tự chọn file mới nhất); mọi caller số doanh
-- thu (rev_share, fp_pnl → hdtv_report, bks_recon, fp_cash, ACC-Recon
-- report, view Bên A) đọc `v_settlement_khoan` = 1 dòng / khoản, khoản =
-- trùng NGUYÊN VĂN mọi trường giao dịch có trong file (kênh, mã đơn hash,
-- `txn_type`, ngày quyết toán, mọi cột tiền) → tính 1 lần, `n_ban` = số bản.
-- Cùng (kênh, đơn, txn_type) ở ≥2 file mà số KHÁC → không đoán: giữ cả hai +
-- `ingest.settlement_csv.overlaps()` báo "lệch" → rev_share BẤT THƯỜNG,
-- không tính phí. `txn_type` (loại giao dịch: đơn/điều chỉnh/hoàn...) = cột
-- tùy chọn của mapping — chưa xác minh header file thật thì NULL (1 dòng/đơn).
alter table settlement_rows add column if not exists txn_type text;
alter table settlement_rows
  drop constraint if exists settlement_rows_txn_type_check;
alter table settlement_rows
  add constraint settlement_rows_txn_type_check
  check (txn_type is null or (btrim(txn_type) <> '' and length(txn_type) <= 64));

-- r15 data_platform-06: NGUỒN dòng quyết toán — `csv` (file kế toán xuất tay; mọi
-- dòng trước r15) | `api_live` (`ingest.settlement_api`, CHỈ API sàn thật —
-- sandbox/server giả không bao giờ ghi). Hai nguồn có thể gắn `txn_type` khác
-- nhau cho cùng khoản → đơn đã có dòng từ nguồn kia: caller chặn (cross_source).
alter table settlement_rows
  add column if not exists source_kind text not null default 'csv';
alter table settlement_rows
  drop constraint if exists settlement_rows_source_kind_check;
alter table settlement_rows
  add constraint settlement_rows_source_kind_check
  check (source_kind in ('csv', 'api_live'));

create or replace view v_settlement_khoan as
select id, file_sha256, file_name, channel, row_no, order_id_hash, txn_type,
       order_amount_vnd, fixed_fee_vnd, payment_fee_vnd, service_fee_vnd,
       shipping_fee_vnd, voucher_seller_vnd, affiliate_vnd, refund_vnd,
       payout_vnd, settled_on, imported_at, n_ban
from (select s.*, row_number() over (w order by s.id) as rn,
             count(*) over w as n_ban
      from settlement_rows s
      window w as (partition by s.channel, s.order_id_hash, s.txn_type,
                   s.settled_on, s.order_amount_vnd, s.fixed_fee_vnd,
                   s.payment_fee_vnd, s.service_fee_vnd, s.shipping_fee_vnd,
                   s.voucher_seller_vnd, s.affiliate_vnd, s.refund_vnd,
                   s.payout_vnd)) k
where rn = 1;

-- View Bên A (v12.5) đọc khoản đã khử bản trùng — cùng số với rev_share.
create or replace view v_ben_a_settlement_daily as
select settled_on, channel, count(*) as n_rows,
       sum(order_amount_vnd) as order_amount_vnd,
       sum(fixed_fee_vnd) as fixed_fee_vnd,
       sum(payment_fee_vnd) as payment_fee_vnd,
       sum(service_fee_vnd) as service_fee_vnd,
       sum(shipping_fee_vnd) as shipping_fee_vnd,
       sum(voucher_seller_vnd) as voucher_seller_vnd,
       sum(affiliate_vnd) as affiliate_vnd,
       sum(refund_vnd) as refund_vnd,
       sum(payout_vnd) as payout_vnd
from v_settlement_khoan
group by settled_on, channel;

-- ===== v13.4 c05 media vườn (video) =====
-- PL01 vùng trồng: "Ảnh, video thật từ vườn đã xóa vị trí GPS". Video vào
-- CÙNG kho `garden_media` (khoảnh có video được giữ như khoảnh có ảnh —
-- `ingest.core_store`, gỡ mẫu `garden_director`); `scripts/garden_media.py`
-- gỡ metadata bằng remux ffmpeg trước khi ghi, width/height NULL. Chỉ nới
-- CHECK đuôi (cặp drop+add tên cố định, idempotent) — không đổi cột nào.
-- QR truy xuất (`pipelines.qr_trace`, MEDIA_EXT jpg/png) KHÔNG phát hành
-- video: site từ chối sha có ext ngoài ảnh.
alter table garden_media drop constraint if exists garden_media_ext_check;
alter table garden_media add constraint garden_media_ext_check
  check (ext in ('jpg', 'png', 'mp4', 'mov'));

-- ===== v13.5 c04 danh tính / quyền duyệt =====
-- `docs/roles.sql` v13.5 cấp INSERT llm_usage cho agent_writer (FinOps chạy
-- dưới login agent). Agent ghi được chi phí ÂM thì tự hạ chi tiêu tháng để
-- lách trần → trigger chặn số âm (trigger thay vì thêm CHECK — drift-guard DDL;
-- dòng cũ không bị kiểm lại, không mất dữ liệu khi nâng cấp). ts do DB đặt (agent không có
-- quyền cột ts → không lùi giờ được).
create or replace function llm_usage_nonneg() returns trigger
language plpgsql as $$
begin
  if new.cost_usd < 0 or new.tokens_in < 0 or new.tokens_out < 0 then
    raise exception using errcode = 'check_violation',
      message = 'llm_usage: chi phí/token không được âm';
  end if;
  return new;
end $$;
revoke execute on function llm_usage_nonneg() from public;
create or replace trigger llm_usage_nonneg_ins
  before insert or update on llm_usage
  for each row execute function llm_usage_nonneg();
-- Các function duyệt (approve_draft, decide_item approve, override_qa,
-- approve_cogs) chặn người quyết dạng 'agent:'/'system:'/'auto_policy:' ngay
-- trong định nghĩa ở trên (create or replace — nâng cấp DB cũ tự áp).

-- ===== v13.6 c06 3 nháp bài/ngày =====
-- PL01 Marketing "Soạn 3 bài mỗi ngày theo lịch mùa vụ": `python -m
-- pipelines.content --daily [--date]` ghi nháp `post` qua store.save_draft
-- với brief mở đầu bằng khóa slot "[daily YYYY-MM-DD #N]" (21 ký tự). Index
-- unique trên khóa của nháp SỐNG do agent:mkt02 tạo → retry/restart/chạy
-- song song không nhân bản; slot bị từ chối (rejected) thì soạn lại được
-- (cùng luật content_drafts_listing_key_idx). Không thêm cột.
create unique index if not exists content_drafts_daily_key_idx
  on content_drafts ((left(brief, 21)))
  where content_type = 'post' and created_by = 'agent:mkt02'
    and status <> 'rejected' and brief like '[daily %';

-- ===== v13.7 c07 cảnh báo đỏ gửi thật + sổ sự cố + KPI chat bền =====
-- (1) `red_alert_deliveries`: mỗi lần GỬI cảnh báo đỏ tới 1 người nhận độc
--     lập (`pipelines.red_alert.deliver`, kênh SMTP stdlib) — ok/lỗi. KHÔNG
--     lưu địa chỉ (chỉ tên + vai trò + loại kênh). "Đã thông báo" = có dòng
--     ok; `red_alerts.recipients` chỉ là định tuyến, không phải bằng chứng gửi.
-- (2) `ops_incidents` + `ops_incident_events`: sổ sự cố PL02 mục 2 — phát
--     hiện ≤15 phút (occurred_at → detected_at), phản hồi lỗi nghiêm trọng
--     ≤3 giờ / lỗi thường ≤3 ngày làm việc (sự kiện `responded` = ack KỸ
--     THUẬT), sửa ≤7 ngày (`fixed`). `customer_resolved` (xử lý khách xong)
--     là sự kiện RIÊNG — không thay cho phản hồi/sửa. Append-only.
-- (3) `chat_kpi_facts`: dữ kiện chat KHÔNG PII chụp hằng ngày từ convlog
--     (`scripts/ops_monthly.py --snapshot`) — convlog chỉ giữ 30 ngày, báo
--     cáo tháng 31 ngày / chạy ngày 1–4 không mất đầu tháng. Khóa = sha256
--     của khóa dedup convlog (không msg_id/user_id thô); `group_oid` = khóa
--     nhóm `cskh:<sha1>` như `approval_queue.object_id`. Insert-only.
create table if not exists red_alert_deliveries (
  id bigint generated always as identity primary key,
  alert_id bigint not null references red_alerts (id),
  recipient text not null check (btrim(recipient) <> ''),
  role text not null,
  channel text not null,
  ok boolean not null,
  error text,
  attempted_at timestamptz not null default now()
);
create index if not exists red_alert_deliveries_alert_idx
  on red_alert_deliveries (alert_id);
create or replace trigger red_alert_deliveries_append_only_row
  before update or delete on red_alert_deliveries
  for each row execute function append_only_guard();
create or replace trigger red_alert_deliveries_no_truncate
  before truncate on red_alert_deliveries
  for each statement execute function append_only_guard();

create table if not exists ops_incidents (
  id bigint generated always as identity primary key,
  title text not null check (btrim(title) <> ''),
  severity text not null check (severity in ('nghiem_trong', 'thuong')),
  source text not null check (btrim(source) <> ''),
  ben_trach_nhiem text not null
    check (ben_trach_nhiem in ('ben_a', 'ben_b', 'chua_xac_dinh')),
  occurred_at timestamptz,
  detected_at timestamptz not null,
  created_by text not null check (btrim(created_by) <> ''),
  recorded_at timestamptz not null default now(),
  check (occurred_at is null or occurred_at <= detected_at)
);
create or replace trigger ops_incidents_append_only_row
  before update or delete on ops_incidents
  for each row execute function append_only_guard();
create or replace trigger ops_incidents_no_truncate
  before truncate on ops_incidents
  for each statement execute function append_only_guard();

create table if not exists ops_incident_events (
  id bigint generated always as identity primary key,
  incident_id bigint not null references ops_incidents (id),
  kind text not null
    check (kind in ('responded', 'fixed', 'customer_resolved', 'note')),
  at timestamptz not null,
  by_name text not null check (btrim(by_name) <> ''),
  note text,
  recorded_at timestamptz not null default now()
);
create index if not exists ops_incident_events_inc_idx
  on ops_incident_events (incident_id, kind, at);
create or replace trigger ops_incident_events_append_only_row
  before update or delete on ops_incident_events
  for each row execute function append_only_guard();
create or replace trigger ops_incident_events_no_truncate
  before truncate on ops_incident_events
  for each statement execute function append_only_guard();

create table if not exists chat_kpi_facts (
  qkey text primary key check (qkey ~ '^[0-9a-f]{64}$'),
  ts timestamptz not null,
  channel text,
  is_question boolean not null,
  handled_by_bot boolean,
  group_oid text,
  reply_ms integer check (reply_ms is null or reply_ms >= 0),
  captured_at timestamptz not null default now()
);
create index if not exists chat_kpi_facts_ts_idx on chat_kpi_facts (ts);
create or replace trigger chat_kpi_facts_append_only_row
  before update or delete on chat_kpi_facts
  for each row execute function append_only_guard();
create or replace trigger chat_kpi_facts_no_truncate
  before truncate on chat_kpi_facts
  for each statement execute function append_only_guard();

-- ===== v13.8 c09 neo blockchain =====
-- PL01 mục 4b: "Mã xác thực của chuỗi dữ liệu được neo lên blockchain theo
-- định kỳ để bên thứ ba kiểm chứng được". `python -m pipelines.anchor`:
--   * `anchor_batches` — 1 dòng / lần gom: lá (đầu chuỗi `plot_logs` + chữ
--     ký/phát hành/thu hồi QR của lô KHÔNG mẫu — chỉ mã lô, vai, sha, thời
--     điểm; KHÔNG tên người ký, KHÔNG tọa độ/khoảnh), gốc Merkle, sha256 bản
--     kê (manifest) = digest DUY NHẤT được gửi ra ngoài. APPEND-ONLY.
--   * `anchor_receipts` — mỗi lần gửi digest tới provider: `da_gui` (biên
--     nhận .ots của calendar — CHƯA phải xác nhận Bitcoin, bên thứ ba chạy
--     `ots upgrade` + `ots verify`) hoặc `loi` (lớp lỗi, không URL/token).
--     Provider `none` (mặc định) = không gửi gì, không ghi dòng → "chưa neo".
--     APPEND-ONLY (thử lại = dòng mới).
-- Không grant cho role nào (CLI chạy DSN chủ sở hữu). Hash lưu cùng DB KHÔNG
-- thay được neo ngoài — chỉ phục vụ đối chiếu nội bộ (`--verify`).
create table if not exists anchor_batches (
  id bigint generated always as identity primary key,
  as_of timestamptz not null,
  leaves jsonb not null
    check (jsonb_typeof(leaves) = 'array' and jsonb_array_length(leaves) > 0),
  merkle_root text not null check (merkle_root ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null unique
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now()
);
create or replace trigger anchor_batches_append_only_row
  before update or delete on anchor_batches
  for each row execute function append_only_guard();
create or replace trigger anchor_batches_no_truncate
  before truncate on anchor_batches
  for each statement execute function append_only_guard();

create table if not exists anchor_receipts (
  id bigint generated always as identity primary key,
  batch_id bigint not null references anchor_batches (id),
  provider text not null check (provider in ('opentimestamps')),
  status text not null check (status in ('da_gui', 'loi')),
  calendar text check (calendar ~ '^https://'),
  receipt bytea check (octet_length(receipt) <= 16384),
  error text check (char_length(error) <= 300),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  check ((status = 'da_gui') = (receipt is not null and calendar is not null)),
  check ((status = 'loi') = (error is not null))
);
-- r13: thêm trạng thái `da_nang_cap` (biên nhận đã ghép attestation Bitcoin do
-- calendar trả — `pipelines.anchor --upgrade`; KHÁC xác minh bên thứ ba). Bảng
-- tạo ở trên giữ NGUYÊN văn bản cũ nên DB mới và DB cũ có cùng tên ràng buộc
-- tự đặt: `anchor_receipts_status_check` (cột status) + `anchor_receipts_check`
-- (cặp status/receipt, ràng buộc bảng thứ nhất) → bỏ 2 tên đó, thêm 2 ràng buộc
-- tên cố định (drop-if-exists rồi add: áp lại 2 lần an toàn).
alter table anchor_receipts drop constraint if exists anchor_receipts_status_check;
alter table anchor_receipts drop constraint if exists anchor_receipts_check;
alter table anchor_receipts drop constraint if exists anchor_receipts_status_r13;
alter table anchor_receipts add constraint anchor_receipts_status_r13
  check (status in ('da_gui', 'da_nang_cap', 'loi'));
alter table anchor_receipts drop constraint if exists anchor_receipts_receipt_r13;
alter table anchor_receipts add constraint anchor_receipts_receipt_r13
  check ((status in ('da_gui', 'da_nang_cap')) = (receipt is not null and calendar is not null));
create index if not exists anchor_receipts_batch_idx
  on anchor_receipts (batch_id, id);
create or replace trigger anchor_receipts_append_only_row
  before update or delete on anchor_receipts
  for each row execute function append_only_guard();
create or replace trigger anchor_receipts_no_truncate
  before truncate on anchor_receipts
  for each statement execute function append_only_guard();

-- ===== v14.2 p2 số liệu doanh thu/đơn append-only (HĐ 7.3 iii) =====
-- Số liệu doanh thu/đơn trực tuyến là căn cứ chia doanh thu + quyền xem số
-- liên tục của Bên A → không xóa/sửa mất giá trị cũ.
--   * `settlement_rows` — APPEND-ONLY hoàn toàn (`append_only_guard`, kể cả
--     owner): mọi dòng là file quyết toán THẬT (không có đường nạp mẫu); nạp
--     lại idempotent theo sha256 file + `unique (file_sha256, row_no)` nên
--     không cần xóa. File sai = nạp file đúng (khoản xuất lại xử lý ở
--     `v_settlement_khoan`/`overlaps`), KHÔNG xóa dòng cũ.
--   * `orders` — dòng KHÔNG mẫu (`source` khác 'sample' / 'sample:%') không
--     xóa được, không đổi mã đơn, không chuyển thành mẫu; TRUNCATE bị chặn.
--     UPDATE hợp lệ (`agents.kd_orders` đổi trạng thái theo snapshot sau, FK
--     products `on delete set null`) → 1 dòng `order_history` (toàn bộ dòng
--     cũ + mới, APPEND-ONLY). Dòng mẫu: `ingest.core_store` vẫn xóa/nạp lại.
--     Trigger SECURITY DEFINER: người ghi `orders` không cần quyền
--     `order_history`.
create or replace trigger settlement_rows_append_only_row
  before update or delete on settlement_rows
  for each row execute function append_only_guard();
create or replace trigger settlement_rows_no_truncate
  before truncate on settlement_rows
  for each statement execute function append_only_guard();

create table if not exists order_history (
  id bigint generated always as identity primary key,
  order_id text not null,
  old_row jsonb not null,
  new_row jsonb not null,
  db_role text not null default session_user,
  changed_at timestamptz not null default now()
);
create index if not exists order_history_order_idx
  on order_history (order_id, id);
create or replace trigger order_history_append_only_row
  before update or delete on order_history
  for each row execute function append_only_guard();
create or replace trigger order_history_no_truncate
  before truncate on order_history
  for each statement execute function append_only_guard();

create or replace function orders_guard() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  old_sample boolean := old.source = 'sample' or old.source like 'sample:%';
begin
  if old_sample then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'orders: đơn thật (source %) không xóa được — HĐ 7.3',
      old.source;
  end if;
  if new.id is distinct from old.id then
    raise exception 'orders: không đổi mã đơn thật';
  end if;
  if new.source = 'sample' or new.source like 'sample:%' then
    raise exception 'orders: không chuyển đơn thật thành mẫu';
  end if;
  if to_jsonb(new) is distinct from to_jsonb(old) then
    insert into order_history (order_id, old_row, new_row)
    values (old.id, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;
revoke execute on function orders_guard() from public;
create or replace trigger orders_guard_row
  before update or delete on orders
  for each row execute function orders_guard();
create or replace trigger orders_no_truncate
  before truncate on orders
  for each statement execute function append_only_guard();

-- ===== v14.3 p3 rollout phủ đủ biên =====
-- HĐ 6.7; PL02 mục 1a–c (F03/F04 còn hở sau v13). Idempotent.
--   * Cột cờ mẫu THỐNG NHẤT `is_sample` (provenance ghi lúc tạo, thay quy
--     ước tên 'sample'/'mau'/'MẪU' của bộ đếm đầu ra `pipelines.rollout`)
--     cho bảng chưa có cột nguồn: `approval_queue` (qua `enqueue_item` bản
--     11 tham số — bản 10 tham số cũ gọi lại với false), `allocation_
--     proposals` (tồn kho nguồn là mẫu), `audit_runs` (báo cáo dựng trên
--     số mẫu). Dòng cũ = false (không đoán lại); bộ đếm vẫn loại thêm theo
--     quy ước tên cũ (chỉ loại thêm — fail-closed, không bao giờ biến mẫu
--     thành thật).
--   * `report_outputs` — sổ báo cáo file đã sinh của TÍNH NĂNG (tiền tố
--     `output_sources.report`): `agents.report.write_report` ghi 1 dòng sau
--     khi ghi file (tên, sha256 nội dung, `is_sample`). Bộ đếm đầu ra loại
--     `report` đếm DISTINCT tên trong cửa sổ giai đoạn. APPEND-ONLY.
--   * `san_suggestions` — gợi ý chat sàn (`connectors.channels --suggest`,
--     sales-02): KHÔNG lưu tin buyer (chỉ `msg_ref` = sha256 tin ĐÃ CHE PII),
--     câu gợi ý đã che PII, giai đoạn lúc soạn. `san_suggestion_uses` —
--     NGƯỜI đánh dấu đã dán gửi (`--mark-sent`, chỉ khi giai đoạn cho dùng).
--     Cả hai APPEND-ONLY.
alter table approval_queue
  add column if not exists is_sample boolean not null default false;
alter table allocation_proposals
  add column if not exists is_sample boolean not null default false;
alter table audit_runs
  add column if not exists is_sample boolean not null default false;

create or replace function enqueue_item(p_object_type text, p_object_id text,
  p_block text, p_title text, p_payload text, p_risk text, p_guardrail jsonb,
  p_qa_status text, p_created_by text, p_sla_hours int, p_is_sample boolean)
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
    content_sha256, risk, guardrail, qa_status, created_by, due_at,
    is_sample)
  values (p_object_type, p_object_id, p_block, coalesce(p_title, ''),
    p_payload, repeat('0', 64), p_risk, coalesce(p_guardrail, '{}'::jsonb),
    coalesce(p_qa_status, 'none'), v_by,
    now() + make_interval(hours => p_sla_hours), coalesce(p_is_sample, false))
  returning approval_queue.id, approval_queue.content_sha256
    into v_id, v_sha;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'queue_enqueue', p_object_type, p_object_id,
          jsonb_build_object('queue_id', v_id, 'content_sha256', v_sha,
                             'block', p_block));
  return v_id;
end $$;
revoke execute on function enqueue_item(text, text, text, text, text, text,
  jsonb, text, text, int, boolean) from public;

-- Bản 10 tham số (mọi caller cũ) = không phải mẫu.
create or replace function enqueue_item(p_object_type text, p_object_id text,
  p_block text, p_title text, p_payload text, p_risk text, p_guardrail jsonb,
  p_qa_status text, p_created_by text, p_sla_hours int)
returns bigint
language plpgsql security definer set search_path from current as $$
begin
  return enqueue_item(p_object_type, p_object_id, p_block, p_title,
    p_payload, p_risk, p_guardrail, p_qa_status, p_created_by, p_sla_hours,
    false);
end $$;
revoke execute on function enqueue_item(text, text, text, text, text, text,
  jsonb, text, text, int) from public;

create table if not exists report_outputs (
  id bigint generated always as identity primary key,
  feature_id text not null
    check (feature_id ~ '^[a-z_]+-[0-9]{2}([.][0-9]{1,2})?$'),
  name text not null check (char_length(name) between 1 and 200
    and name !~ '[/\\]'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  db_role text not null default session_user
);
create index if not exists report_outputs_feature_idx
  on report_outputs (feature_id, created_at);
create or replace trigger report_outputs_append_only_row
  before update or delete on report_outputs
  for each row execute function append_only_guard();
create or replace trigger report_outputs_no_truncate
  before truncate on report_outputs
  for each statement execute function append_only_guard();

create table if not exists san_suggestions (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('shopee', 'tiktok')),
  msg_ref text not null check (msg_ref ~ '^[0-9a-f]{32}$'),
  answer text not null check (char_length(answer) between 1 and 4000),
  handoff text check (handoff is null or handoff ~ '^[a-z_]{1,40}$'),
  guardrail_ok boolean not null,
  stage text not null
    check (stage in ('chay_thu', 'co_nguoi_duyet', 'van_hanh')),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  db_role text not null default session_user
);
create index if not exists san_suggestions_created_idx
  on san_suggestions (created_at);
create or replace trigger san_suggestions_append_only_row
  before update or delete on san_suggestions
  for each row execute function append_only_guard();
create or replace trigger san_suggestions_no_truncate
  before truncate on san_suggestions
  for each statement execute function append_only_guard();

create table if not exists san_suggestion_uses (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null unique references san_suggestions (id),
  used_by text not null check (btrim(used_by) <> ''
    and lower(btrim(used_by)) not like 'agent:%'
    and lower(btrim(used_by)) not like 'system:%'),
  stage text not null check (stage in ('co_nguoi_duyet', 'van_hanh')),
  used_at timestamptz not null default now(),
  db_role text not null default session_user
);
create or replace trigger san_suggestion_uses_append_only_row
  before update or delete on san_suggestion_uses
  for each row execute function append_only_guard();
create or replace trigger san_suggestion_uses_no_truncate
  before truncate on san_suggestion_uses
  for each statement execute function append_only_guard();

-- ===== v14.4 p4 kinh doanh: người phụ trách lead, nhắc chốt B2B, giá đại lý =====
-- PL01 mục 2 — Kinh doanh TMĐT (sales-04.1, sales-05, sales-06.1). Cảnh báo
-- đơn trễ/hủy/hoàn (sales-06.2) chỉ đọc `orders` → không cần bảng mới.
--   * `leads` thêm người phụ trách = MÃ nhân viên (không tên) + hạn xử lý
--     theo giờ làm việc (`ingest.crm --owner`, người gán qua `auth.cli_gate`).
--     Quá hạn → `agents.sales_director` đẩy mục `lead_followup`.
--   * `b2b_quote_events` — APPEND-ONLY: báo giá đã gửi (`kd_quote
--     --verify-send` khớp bản duyệt) / kết quả chốt do NGƯỜI ghi. Nhắc chốt
--     đơn (`kd_quote --followups`) đọc bảng này; không lưu người liên hệ.
--   * `dealer_price_obs` — APPEND-ONLY: giá đại lý QUAN SÁT TAY (file nhập
--     tay, kiểm toàn file; idempotent theo sha256 file + số dòng). Không PII:
--     mã đại lý + SKU + giá + ngày + URL nguồn công khai. `source='sample'`
--     = dữ liệu mẫu, không sinh cảnh báo.
-- (CHECK viết không dấu phẩy: drift-guard chỉ cho `add column` 1 hành động.)
alter table leads add column if not exists owner_code text
  check (owner_code ~ '^[A-Z0-9_-][A-Z0-9_-]+$'
         and char_length(owner_code) <= 20);
alter table leads add column if not exists owner_due_at timestamptz;
alter table leads add column if not exists owner_assigned_by text;
alter table leads add column if not exists owner_assigned_at timestamptz;

create table if not exists b2b_quote_events (
  id bigint generated always as identity primary key,
  queue_id bigint not null references approval_queue(id),
  quote_no text not null check (char_length(quote_no) between 1 and 80),
  kind text not null check (kind in ('da_gui', 'chot', 'khong_chot', 'huy')),
  recorded_by text check (recorded_by is null or btrim(recorded_by) <> ''),
  db_role text not null default session_user,
  created_at timestamptz not null default now()
);
create index if not exists b2b_quote_events_queue_idx
  on b2b_quote_events (queue_id, id);
-- 1 kết quả/báo giá (2 người ghi song song → 1 thắng).
create unique index if not exists b2b_quote_events_outcome_idx
  on b2b_quote_events (queue_id) where kind in ('chot', 'khong_chot', 'huy');
create or replace trigger b2b_quote_events_append_only_row
  before update or delete on b2b_quote_events
  for each row execute function append_only_guard();
create or replace trigger b2b_quote_events_no_truncate
  before truncate on b2b_quote_events
  for each statement execute function append_only_guard();

create table if not exists dealer_price_obs (
  id bigint generated always as identity primary key,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_no int not null check (row_no >= 2),
  channel text not null check (channel ~ '^[a-z0-9_]{2,20}$'),
  dealer_code text not null references dealers(code),
  sku_key text not null references sku_master(sku_key),
  price_vnd bigint not null check (price_vnd > 0),
  observed_on date not null,
  source_url text not null check (source_url ~ '^https://[^\s]+$'
                                  and char_length(source_url) <= 500),
  source text not null default 'manual_export'
    check (source in ('manual_export', 'sample')),
  created_by text not null check (btrim(created_by) <> ''),
  created_at timestamptz not null default now(),
  unique (file_sha256, row_no)
);
create index if not exists dealer_price_obs_on_idx
  on dealer_price_obs (observed_on);
create or replace trigger dealer_price_obs_append_only_row
  before update or delete on dealer_price_obs
  for each row execute function append_only_guard();
create or replace trigger dealer_price_obs_no_truncate
  before truncate on dealer_price_obs
  for each statement execute function append_only_guard();

-- ===== v14.5 p5 marketing/ceo/intel =====
-- marketing-04.2 (PL01 Marketing "kiểm tra bài đăng của đối tác"): sổ rà
-- bài KOC/đại lý ĐÃ đăng từ file xuất tay (`agents.ra_kenh --partner-file`).
-- KHÔNG lưu text bài, URL đầy đủ hay tên/handle đối tác — chỉ MÃ đối tác
-- (có trong sổ KOC/đại lý), sha256 URL/text, tên miền. Mỗi lần rà khác bản
-- trước (text/mã vi phạm) = 1 dòng; đợt vi phạm mới → 1 mục hàng duyệt
-- `marketing/partner_post_review`. Append-only (bằng chứng rà).
create table if not exists partner_post_scans (
  id bigint generated always as identity primary key,
  partner_code text not null check (partner_code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  url_sha256 text not null check (url_sha256 ~ '^[0-9a-f]{64}$'),
  host text not null check (char_length(host) between 1 and 253),
  channel text not null check (channel ~ '^[a-z0-9_]{2,20}$'),
  posted_on date not null,
  sku text,
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  codes text[] not null default '{}',
  severity text check (severity in ('S1', 'S2')),
  kit_ref text check (char_length(kit_ref) <= 200),
  queue_id bigint references approval_queue(id),
  is_sample boolean not null default false,
  scanned_by text not null check (btrim(scanned_by) <> ''),
  scanned_at timestamptz not null default now(),
  check ((severity is null) = (cardinality(codes) = 0))
);
create index if not exists partner_post_scans_key_idx
  on partner_post_scans (partner_code, url_sha256, id);
create or replace trigger partner_post_scans_append_only_row
  before update or delete on partner_post_scans
  for each row execute function append_only_guard();
create or replace trigger partner_post_scans_no_truncate
  before truncate on partner_post_scans
  for each statement execute function append_only_guard();
-- ===== v14.6 p6 vận hành còn sót =====
-- (1) Leo thang 2 giờ CHUNG mọi cảnh báo đỏ (`pipelines.red_alert.escalate`,
--     job `red_alert_escalate`): 1 bản leo thang / cảnh báo gốc, MỌI nguồn
--     (index v7.1 chỉ phủ nguồn intel). Chạy song song → UniqueViolation →
--     đếm dup. Trước v14.6 chỉ intel ghi `escalation_of` (đã unique) nên tạo
--     index không vấp dòng cũ.
create unique index if not exists red_alerts_escalation_all_uq
  on red_alerts ((detail->>'escalation_of'))
  where detail ? 'escalation_of';
-- (2) QR truy xuất chỉ phát hành ẢNH (`qr_trace.MEDIA_EXT`): ánh xạ nguồn lô
--     (`link_lot_origin`, SECURITY DEFINER) không nhận sha của video vườn
--     (v13.4 garden_media nhận mp4/mov) — trước đây chỉ `site` từ chối lúc
--     phát hành, lô đã ký/phát hành trên ánh xạ có video. Trigger INSERT
--     (dòng cũ không bị kiểm lại — không mất dữ liệu khi nâng cấp).
create or replace function lot_origins_image_only() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from garden_media gm
             where gm.sha256 = any(new.media_sha256)
               and gm.ext not in ('jpg', 'png')) then
    raise exception using errcode = 'check_violation',
      message = 'tư liệu QR chỉ nhận ảnh jpg/png — sha là video, không '
                'ánh xạ';
  end if;
  return new;
end $$;
revoke execute on function lot_origins_image_only() from public;
create or replace trigger lot_origins_image_only_ins
  before insert on lot_origins
  for each row execute function lot_origins_image_only();

-- ===== v14 vá review: golden master không cho login nạp tự duyệt =====
-- (1) sku_map: đổi map sang SKU khác → duyệt cũ hết giá trị (trước đây
--     loader tự set `approved_by = case ...` → cần UPDATE cột approved_by =
--     svc_loader ghi được TÊN duyệt). Trigger lo phần xóa duyệt nên loader
--     chỉ cần UPDATE (sku_key, note) (roles.sql khối v14.2).
create or replace function sku_map_remap_clears_approval() returns trigger
language plpgsql as $$
begin
  if new.sku_key is distinct from old.sku_key
     and new.approved_by is not distinct from old.approved_by then
    new.approved_by := null;
  end if;
  return new;
end $$;
revoke execute on function sku_map_remap_clears_approval() from public;
create or replace trigger sku_map_remap_clears_approval_upd
  before update on sku_map
  for each row execute function sku_map_remap_clears_approval();
-- (2) golden_discrepancies: phiếu NGƯỜI đã quyết (resolved/dismissed) là bằng
--     chứng — không xóa (mọi role); loader chỉ dọn phiếu `pending` hết điều
--     kiện. Đổi status/resolved_by: roles.sql chỉ cấp UPDATE (detail,
--     updated_at) cho svc_loader.
create or replace function golden_disc_keep_decided() returns trigger
language plpgsql as $$
begin
  if old.status <> 'pending' then
    raise exception using errcode = 'check_violation',
      message = format('golden_discrepancies: phiếu id %s đã quyết (%s) —'
                       ' không xóa', old.id, old.status);
  end if;
  return old;
end $$;
revoke execute on function golden_disc_keep_decided() from public;
create or replace trigger golden_disc_keep_decided_del
  before delete on golden_discrepancies
  for each row execute function golden_disc_keep_decided();

-- ===== v15.5 p11 dữ liệu đơn =====
-- HĐ 7.3 (số liệu đơn là căn cứ chia doanh thu): `ingest.core_store` KHÔNG
-- còn xóa-nạp lại `products` (trước đây delete-by-source → FK `on delete set
-- null` cắt `orders.product_id` của đơn THẬT, chỉ còn vết ở `order_history`).
--   * `products` upsert theo `id` (chỉ đè dòng cùng `source`); sản phẩm biến
--     mất khỏi nguồn → GIỮ dòng + đặt `retired_at` (đánh dấu ngừng niêm
--     yết), xuất hiện lại → xóa `retired_at`. Loader không bao giờ DELETE
--     `products` → mọi liên kết (đơn thật, claim/asset nhập tay) giữ nguyên.
--   * `product_sync_log` — APPEND-ONLY: mỗi lần nạp ghi sự kiện cần người
--     biết: `changed` (cùng id, đổi tên/giá/url/mô tả — giá trị cũ/mới),
--     `retired`/`reactivated` (chuyển trạng thái), `ambiguous` (id trong
--     nguồn trùng dòng của NGUỒN KHÁC, vd 'manual' — không đè, không xóa).
--     Chỉ dữ liệu sản phẩm công khai — không PII.
--   * `ingest.golden_store` chỉ đối chiếu sản phẩm còn niêm yết
--     (`retired_at is null`).
alter table products add column if not exists retired_at timestamptz;

create table if not exists product_sync_log (
  id bigint generated always as identity primary key,
  kind text not null
    check (kind in ('changed', 'retired', 'reactivated', 'ambiguous')),
  product_id text not null,         -- KHÔNG FK: log giữ cả khi sản phẩm đổi
  source text not null,             -- nguồn đang nạp (vd 'products.jsonl')
  detail jsonb not null default '{}'::jsonb,
  db_role text not null default session_user,
  created_at timestamptz not null default now()
);
create index if not exists product_sync_log_product_idx
  on product_sync_log (product_id, id);
create or replace trigger product_sync_log_append_only_row
  before update or delete on product_sync_log
  for each row execute function append_only_guard();
create or replace trigger product_sync_log_no_truncate
  before truncate on product_sync_log
  for each statement execute function append_only_guard();

-- ===== v15.4 p10 quyền người =====
-- (P10.1, F08) CLI người ghi bảng trực tiếp (golden --approve-price, xnqc,
-- rollout --promote/--severe/--disable, crm, doc_intake --verify/--reject,
-- garden_director --purge-sample/--adopt-plot, ra_kenh --partner-file) chạy
-- bằng login NGƯỜI `in role app_human` qua function nghiệp vụ SECURITY
-- DEFINER THEO VIỆC — không cấp INSERT/UPDATE/DELETE bảng cho app_human.
--   * `human_logins` — ánh xạ login Postgres ↔ NGƯỜI ↔ khối được ủy quyền.
--     CHỈ owner ghi (Bên B điền theo văn bản ủy quyền; repo để TRỐNG). Mỗi
--     lần đổi ghi 1 dòng `agent_action_log` `human_login_change`.
--   * `human_actor(by, khối)` — danh tính lấy từ `session_user` (login thật
--     của kết nối), KHÔNG từ `--by`: login chưa ánh xạ / `--by` khác người
--     của login / khối không thuộc phạm vi → `42501 insufficient_privilege`.
--     `agent:`/`system:`/`auto_policy:` luôn bị chặn. Login superuser/thành
--     viên role sở hữu bảng (owner — vốn đã ghi thẳng được mọi bảng, máy
--     dev) → nhận `--by` như cũ, KHÔNG thêm/bớt quyền gì.
--   * Mỗi function: `set search_path from current` (ghim schema lúc tạo),
--     REVOKE EXECUTE FROM PUBLIC, GRANT EXECUTE cho app_human (roles.sql),
--     tự kiểm lại bất biến nghiệp vụ (chuyển trạng thái, tồn tại, chưa duyệt)
--     — gọi thẳng qua psql cũng không vượt được. Kiểm cần dữ liệu ngoài DB
--     (vùng đại lý theo file, đếm đầu ra PL02 theo danh mục) vẫn ở Python —
--     xem runbook mục 9.7 "rủi ro còn lại".
create table if not exists human_logins (
  db_login text primary key check (db_login ~ '^[a-z_][a-z0-9_$]{0,62}$'),
  person text not null check (char_length(btrim(person)) between 1 and 100
    and btrim(person) !~* '^\s*(agent|system|auto_policy)\s*:'),
  blocks text[] not null default '{}' check (blocks <@ array['ceo', 'sales',
    'marketing', 'intel', 'finance', 'production', 'farming', 'legal_hr',
    'data_platform']::text[]),
  active boolean not null default true,
  granted_by text not null check (btrim(granted_by) <> ''),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function human_logins_audit() returns trigger
language plpgsql security definer set search_path from current as $$
begin
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (coalesce(case when tg_op = 'DELETE' then old.granted_by
                        else new.granted_by end, session_user::text),
          'human_login_change', 'human_login',
          case when tg_op = 'DELETE' then old.db_login else new.db_login end,
          jsonb_build_object('op', tg_op,
            'old', case when tg_op = 'INSERT' then null else jsonb_build_object(
              'person', old.person, 'blocks', old.blocks, 'active', old.active)
              end,
            'new', case when tg_op = 'DELETE' then null else jsonb_build_object(
              'person', new.person, 'blocks', new.blocks, 'active', new.active)
              end));
  return null;
end $$;
revoke execute on function human_logins_audit() from public;
create or replace trigger human_logins_audit_row
  after insert or update or delete on human_logins
  for each row execute function human_logins_audit();

create or replace function p10_norm(p text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(normalize(coalesce(p, ''), NFC)),
                              '\s+', ' ', 'g'))
$$;

-- Login đang dùng là superuser / thành viên role sở hữu bảng (owner)?
create or replace function p10_owner_login() returns boolean
language sql stable security definer set search_path from current as $$
  select coalesce((select r.rolsuper or pg_has_role(session_user,
    (select c.relowner from pg_class c where c.oid = 'human_logins'::regclass),
    'MEMBER') from pg_roles r where r.rolname = session_user), false)
$$;
revoke execute on function p10_owner_login() from public;

create or replace function human_actor(p_by text, p_block text default null)
returns text
language plpgsql stable security definer set search_path from current as $$
declare
  v_by text := btrim(coalesce(p_by, ''));
  r human_logins%rowtype;
begin
  if v_by = '' or v_by ~* '^\s*(agent|system|auto_policy)\s*:' then
    raise exception 'người thực hiện không hợp lệ (%) — agent/hệ thống không ghi thay người',
      left(v_by, 40) using errcode = '42501';
  end if;
  if char_length(v_by) > 100 then
    raise exception 'tên người thực hiện quá 100 ký tự' using errcode = '42501';
  end if;
  if p10_owner_login() then
    return v_by;                     -- owner: ghi thẳng được vốn sẵn (dev)
  end if;
  select * into r from human_logins h
   where h.db_login = session_user and h.active;
  if not found then
    raise exception 'login % chưa được ánh xạ người (human_logins — Bên B điền theo văn bản ủy quyền, không tự điền)',
      session_user using errcode = '42501';
  end if;
  if p10_norm(r.person) <> p10_norm(v_by) then
    raise exception '--by "%" không phải người của login % — không ghi thay người khác',
      left(v_by, 40), session_user using errcode = '42501';
  end if;
  if p_block is not null and not (p_block = any(r.blocks)) then
    raise exception 'người "%" không được ủy quyền khối % (human_logins)',
      r.person, p_block using errcode = '42501';
  end if;
  return btrim(r.person);
end $$;
revoke execute on function human_actor(text, text) from public;

-- Giờ ghi: login không phải owner → đồng hồ DB (không nhận mốc tự khai).
create or replace function p10_now(p_now timestamptz) returns timestamptz
language sql stable security definer set search_path from current as $$
  select case when p10_owner_login() then coalesce(p_now, now()) else now() end
$$;
revoke execute on function p10_now(timestamptz) from public;

create or replace function p10_vn_date(p timestamptz) returns date
language sql immutable as $$
  select ((p at time zone 'UTC') + interval '7 hours')::date
$$;

-- golden --approve-price (khối sales): chỉ dòng chưa duyệt, chưa đóng.
create or replace function approve_price_human(p_id bigint, p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  r price_list%rowtype;
begin
  select * into r from price_list where id = p_id for update;
  if not found then
    raise exception 'không có dòng giá id=%', p_id;
  end if;
  if r.approved_by is not null then
    raise exception 'id=% đã được duyệt trước đó', p_id;
  end if;
  if r.valid_to is not null then
    raise exception 'id=% đã đóng (valid_to=%)', p_id, r.valid_to;
  end if;
  update price_list set approved_by = v_by, approved_at = now()
   where id = p_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'price_approve', 'price_list', p_id::text,
          jsonb_build_object('sku_key', r.sku_key, 'channel', r.channel,
                             'kind', r.kind, 'price_vnd', r.price_vnd));
  return v_by;
end $$;
revoke execute on function approve_price_human(bigint, text) from public;

-- xnqc --add (nhập liệu — chỉ danh tính).
create or replace function xnqc_add_human(p_sku text, p_loai text,
  p_ten text, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  v_id bigint;
begin
  insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so, updated_by)
  values (p_sku, p_loai, btrim(p_ten), v_by) returning id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'xnqc_add', 'xnqc_dossier', v_id::text,
          jsonb_build_object('id', v_id, 'to', 'chuan_bi'));
  return v_id;
end $$;
revoke execute on function xnqc_add_human(text, text, text, text) from public;

-- xnqc --set (khối legal_hr): chuyển trạng thái theo bảng TRANSITIONS
-- (agents/xnqc.py), da_cap cần scan đã `verified`; ngày nộp/cấp không ở
-- tương lai theo ngày VN của DB (login không phải owner).
create or replace function xnqc_set_status_human(p_id bigint, p_from text,
  p_status text, p_by text, p_so_giay text, p_ngay_nop date, p_ngay_cap date,
  p_het_han date, p_doc_sha text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'legal_hr');
  v_cur text;
  v_doc text;
  v_today date := p10_vn_date(now());
begin
  select status into v_cur from xnqc_dossiers where id = p_id for update;
  if not found then
    raise exception 'không tìm thấy hồ sơ #%', p_id;
  end if;
  if v_cur is distinct from p_from then
    raise exception 'hồ sơ #% vừa đổi trạng thái — thử lại', p_id;
  end if;
  if not ((v_cur = 'chuan_bi' and p_status = 'da_nop')
       or (v_cur = 'da_nop' and p_status in ('bo_sung', 'da_cap'))
       or (v_cur = 'bo_sung' and p_status = 'da_nop')
       or (v_cur = 'da_cap' and p_status = 'het_han')) then
    raise exception 'không chuyển được % → %', v_cur, p_status;
  end if;
  if p_status = 'da_nop' and p_ngay_nop is null then
    raise exception 'da_nop cần ngày nộp';
  end if;
  if p_status = 'da_cap' then
    if btrim(coalesce(p_so_giay, '')) = '' or p_ngay_cap is null
       or coalesce(p_doc_sha, '') !~ '^[0-9a-f]{64}$' then
      raise exception 'da_cap cần số giấy, ngày cấp, sha256 scan giấy';
    end if;
    select status into v_doc from documents where sha256 = p_doc_sha;
    if v_doc is distinct from 'verified' then
      raise exception 'scan giấy chưa được Pháp chế đối chiếu (documents.status = %)',
        coalesce(v_doc, 'không có');
    end if;
  end if;
  if not p10_owner_login() and (p_ngay_nop > v_today or p_ngay_cap > v_today)
  then
    raise exception 'ngày nộp/cấp không được ở tương lai (ngày VN %)', v_today;
  end if;
  update xnqc_dossiers set status = p_status,
         so_giay = coalesce(nullif(btrim(p_so_giay), ''), so_giay),
         ngay_nop = coalesce(p_ngay_nop, ngay_nop),
         ngay_cap = coalesce(p_ngay_cap, ngay_cap),
         ngay_het_han = coalesce(p_het_han, ngay_het_han),
         document_sha256 = coalesce(p_doc_sha, document_sha256),
         updated_by = v_by, updated_at = now()
   where id = p_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'xnqc_status', 'xnqc_dossier', p_id::text,
          jsonb_build_object('id', p_id, 'from', v_cur, 'to', p_status));
  return v_by;
end $$;
revoke execute on function xnqc_set_status_human(bigint, text, text, text,
  text, date, date, date, text) from public;

-- rollout --promote/--severe/--disable (khối = tiền tố mã tính năng).
-- Login không phải owner: giờ = đồng hồ DB; nâng giai đoạn chỉ 1 bước, 0 lỗi
-- nghiêm trọng từ mốc, đủ số NGÀY lịch tối thiểu (5 / 10 ngày làm việc ⇒ ≥
-- 5 / 10 ngày lịch), bằng chứng đếm đầu ra đạt ngưỡng PL02. Vá review v15:
-- DB TỰ đếm lại (ngày làm việc + đầu ra DISTINCT + người duyệt) bằng bộ đếm
-- `count_spec` owner ghi — không tin số trong `p_evidence` (khối cuối file).
create or replace function rollout_transition_human(p_fid text, p_kind text,
  p_from text, p_to text, p_by text, p_code text, p_note text,
  p_evidence jsonb, p_now timestamptz)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_block text := regexp_replace(coalesce(p_fid, ''), '-.*$', '');
  v_by text := human_actor(p_by, v_block);
  v_now timestamptz := p10_now(p_now);
  v_stage text;
  v_since timestamptz;
  v_to text;
  v_owner boolean := p10_owner_login();
  v_min int;
  e jsonb := coalesce(p_evidence, '{}'::jsonb);
  -- vá review v15: DB tự đếm lại (không tin số đếm trong p_evidence)
  v_spec jsonb;
  v_file int;
  v_bd int;
  v_n int;
  v_d int;
  v_h int;
  v_u int;
  v_r int;
begin
  select stage, stage_since, count_spec into v_stage, v_since, v_spec
    from feature_rollout where feature_id = p_fid for update;
  if not found then
    raise exception '%: chưa vào sổ triển khai (chạy --seed)', p_fid;
  end if;
  if v_stage is distinct from p_from then
    raise exception '%: giai đoạn vừa đổi (% ≠ %) — thử lại', p_fid, v_stage,
      p_from;
  end if;
  if p_kind = 'promote' then
    -- tắt → bật lại = về chạy thử (đếm lại từ đầu, không điều kiện).
    v_to := case v_stage when 'chay_thu' then 'co_nguoi_duyet'
                         when 'co_nguoi_duyet' then 'van_hanh'
                         when 'tat' then 'chay_thu' end;
    if v_to is null or v_to is distinct from p_to then
      raise exception '%: không nâng được % → %', p_fid, v_stage, p_to;
    end if;
    if not v_owner and v_stage <> 'tat' then
      if exists (select 1 from feature_rollout_events where feature_id = p_fid
                  and kind = 'severe' and ts >= v_since) then
        raise exception '%: có lỗi nghiêm trọng từ mốc giai đoạn — không nâng',
          p_fid;
      end if;
      v_min := case v_stage when 'chay_thu' then 5 else 10 end;
      if p10_vn_date(v_now) - p10_vn_date(v_since) < v_min then
        raise exception '%: chưa đủ số ngày tối thiểu của giai đoạn %', p_fid,
          v_stage;
      end if;
      if v_stage = 'chay_thu' and not (coalesce((e->>'outputs')::int, 0) >= 50
          and coalesce((e->>'out_days')::int, 0) >= 5) then
        raise exception '%: bằng chứng đầu ra chưa đạt PL02 (≥ 50 đầu ra, ≥ 5 ngày)',
          p_fid;
      end if;
      if v_stage = 'co_nguoi_duyet' and not (coalesce((e->>'human')::int, 0) >= 1
          and coalesce((e->>'unapproved')::int, 1) = 0
          -- v15.2 (P8.7): mọi đầu ra báo cáo/bảng/file đã có người duyệt
          -- đúng phiên bản (thiếu khóa = chưa chứng minh → chặn)
          and coalesce((e->>'unreviewed')::int, 1) = 0) then
        raise exception '%: bằng chứng duyệt chưa đạt PL02 (≥ 1 đầu ra người duyệt, 0 thiếu người, 0 chưa duyệt)',
          p_fid;
      end if;
      -- Vá review v15 (P8.7/P10.1): DB TỰ đếm lại bằng bộ đếm `count_spec`
      -- (chính câu SQL Python đếm, owner ghi qua `rollout --seed` — app_human
      -- /svc không ghi được `feature_rollout`): ngày làm việc của giai đoạn,
      -- đầu ra DISTINCT rải trên ngày làm việc, người duyệt từng mục + sổ
      -- `output_reviews`. Ngưỡng PL02 áp lên số DB đếm, KHÔNG lên số tự khai.
      -- Nguồn `file` (nhật ký trên máy ứng dụng, DB không đọc được) → ngưỡng
      -- SỐ LƯỢNG của tính năng đó vẫn theo bằng chứng Python (runbook 9.7);
      -- phần DB đếm được vẫn phải 0 thiếu người / 0 chưa duyệt.
      if v_spec is null or jsonb_typeof(v_spec->'sql') is distinct from 'array'
      then
        raise exception '%: bộ đếm đầu ra chưa đồng bộ vào DB — owner chạy rollout --seed rồi thử lại',
          p_fid;
      end if;
      v_file := coalesce((v_spec->>'file')::int, 0);
      if jsonb_array_length(v_spec->'sql') = 0 and v_file = 0 then
        raise exception '%: DB đếm lại: không có nguồn đầu ra đếm được — không nâng',
          p_fid;
      end if;
      v_bd := rollout_business_days(v_since, v_now, v_spec);
      select count(*),
             count(distinct p10_vn_date(f.ts)) filter (
               where rollout_workday(p10_vn_date(f.ts), v_spec)),
             count(*) filter (where f.human),
             count(*) filter (where f.unapp),
             count(*) filter (where f.unrev)
        into v_n, v_d, v_h, v_u, v_r
        from rollout_db_facts(p_fid, v_spec, v_since, v_now) f;
      e := e || jsonb_build_object('db_recount', jsonb_build_object(
        'days', v_bd, 'outputs', v_n, 'out_days', v_d, 'human', v_h,
        'unapproved', v_u, 'unreviewed', v_r, 'file_sources', v_file));
      if v_bd < v_min then
        raise exception '%: DB đếm lại: mới % / % ngày làm việc của giai đoạn %',
          p_fid, v_bd, v_min, v_stage;
      end if;
      if v_stage = 'chay_thu' and v_file = 0 and not (v_n >= 50 and v_d >= 5)
      then
        raise exception '%: DB đếm lại chưa đạt PL02 (% đầu ra / % ngày làm việc; cần ≥ 50 / ≥ 5)',
          p_fid, v_n, v_d;
      end if;
      if v_stage = 'co_nguoi_duyet' and (v_u > 0 or v_r > 0
          or (v_file = 0 and not (v_n >= 1 and v_h >= 1))) then
        raise exception '%: DB đếm lại chưa đạt PL02 (% đầu ra, % người duyệt, % thiếu người, % chưa duyệt)',
          p_fid, v_n, v_h, v_u, v_r;
      end if;
    end if;
  elsif p_kind = 'severe' then
    if p_code is null or p_code not in ('tu_cam', 'ruou_cong_khai',
        'tpbvsk_chua_xnqc', 'thieu_khuyen_cao', 'thieu_nhan_ai', 'lo_pii',
        'so_lieu_khong_nguon') then
      raise exception 'mã lỗi nghiêm trọng lạ: %', p_code;
    end if;
    v_to := case when v_stage = 'tat' then 'tat' else 'chay_thu' end;
  elsif p_kind = 'disable' then
    if v_stage = 'tat' then
      raise exception '%: đã tắt', p_fid;
    end if;
    v_to := 'tat';
  else
    raise exception 'loại thao tác lạ: %', p_kind;
  end if;
  if p_to is distinct from v_to then
    raise exception '%: đích % không hợp lệ (đúng: %)', p_fid, p_to, v_to;
  end if;
  insert into feature_rollout_events (ts, feature_id, kind, from_stage,
    to_stage, severe_code, note, evidence, by_person)
  values (v_now, p_fid, p_kind, v_stage, v_to,
          case when p_kind = 'severe' then p_code end, p_note, e, v_by);
  if not (p_kind = 'severe' and v_stage = 'tat') then
    update feature_rollout set stage = v_to, stage_since = v_now,
           updated_by = v_by, updated_at = v_now
     where feature_id = p_fid;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'rollout_' || p_kind, 'feature_rollout', p_fid,
          jsonb_build_object('from', v_stage, 'to', v_to, 'code', p_code));
  return v_to;
end $$;
revoke execute on function rollout_transition_human(text, text, text, text,
  text, text, text, jsonb, timestamptz) from public;

-- crm --add-contact (nhập liệu — danh tính). Ciphertext/HMAC do CLI tạo
-- (khóa vault không vào DB); trùng SĐT → id cũ, KHÔNG ghi đè PII cũ.
create or replace function crm_add_contact_human(p_phone_hmac text,
  p_phone_enc text, p_name_enc text, p_email_enc text, p_address_enc text,
  p_province text, p_source text, p_lead bigint, p_by text)
returns table (contact_id bigint, is_new boolean)
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  v_id bigint;
  v_new boolean;
  v_cur bigint;
begin
  insert into contacts (phone_hmac, phone_enc, name_enc, email_enc,
    address_enc, province, source, created_by)
  values (p_phone_hmac, p_phone_enc, p_name_enc, p_email_enc, p_address_enc,
          p_province, p_source, v_by)
  on conflict (phone_hmac) do nothing returning id into v_id;
  v_new := v_id is not null;
  if not v_new then
    select c.id into v_id from contacts c where c.phone_hmac = p_phone_hmac;
  end if;
  if p_lead is not null then
    select l.contact_id into v_cur from leads l where l.id = p_lead for update;
    if not found then
      raise exception 'không có lead #%', p_lead;
    end if;
    if v_cur is not null and v_cur <> v_id then
      raise exception 'lead #% đã gắn contact khác', p_lead;
    end if;
    update leads set contact_id = v_id where id = p_lead;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_contact_add', 'contact', v_id::text,
          jsonb_build_object('new', v_new, 'lead_id', p_lead,
                             'province', p_province));
  return query select v_id, v_new;
end $$;
revoke execute on function crm_add_contact_human(text, text, text, text, text,
  text, text, bigint, text) from public;

-- crm --consent (khối sales).
create or replace function crm_record_consent_human(p_contact bigint,
  p_purpose text, p_granted boolean, p_dealer text, p_source text,
  p_evidence text, p_policy text, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  v_id bigint;
begin
  if not exists (select 1 from contacts where id = p_contact) then
    raise exception 'không có contact #%', p_contact;
  end if;
  if p_dealer is not null
     and not exists (select 1 from dealers where code = p_dealer) then
    raise exception 'không có đại lý %', p_dealer;
  end if;
  insert into consents (contact_id, purpose, granted, recipient_dealer,
    source, evidence_ref, policy_version, recorded_by)
  values (p_contact, p_purpose, p_granted, p_dealer, p_source, p_evidence,
          p_policy, v_by) returning id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_consent', 'contact', p_contact::text,
          jsonb_build_object('consent_id', v_id, 'purpose', p_purpose,
                             'granted', p_granted, 'dealer', p_dealer));
  return v_id;
end $$;
revoke execute on function crm_record_consent_human(bigint, text, boolean,
  text, text, text, text, text) from public;

-- crm --load-dealers (khối sales): upsert theo code, dòng 'manual' không đè.
create or replace function crm_load_dealers_human(p_dealers jsonb, p_by text)
returns jsonb
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  d jsonb;
  v_new boolean;
  n_new int := 0;
  n_upd int := 0;
  n_keep int := 0;
  v_res jsonb;
begin
  if jsonb_typeof(p_dealers) is distinct from 'array' then
    raise exception 'danh sách đại lý phải là mảng JSON';
  end if;
  for d in select * from jsonb_array_elements(p_dealers) loop
    insert into dealers (code, name, region, status, commission_default,
      source)
    values (d->>'code', btrim(d->>'name'), d->>'region',
            coalesce(d->>'status', 'active'),
            coalesce((d->>'commission_default')::numeric, 0),
            'dealer_regions.json')
    on conflict (code) do update set name = excluded.name,
       region = excluded.region, status = excluded.status,
       commission_default = excluded.commission_default, updated_at = now()
     where dealers.source <> 'manual' and (dealers.name, dealers.region,
       dealers.status, dealers.commission_default) is distinct from
       (excluded.name, excluded.region, excluded.status,
        excluded.commission_default)
    returning (xmax = 0) into v_new;
    if v_new is null then n_keep := n_keep + 1;
    elsif v_new then n_new := n_new + 1;
    else n_upd := n_upd + 1;
    end if;
    v_new := null;
  end loop;
  v_res := jsonb_build_object('new', n_new, 'updated', n_upd, 'kept', n_keep);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_dealer_load', 'dealer', '*', v_res);
  return v_res;
end $$;
revoke execute on function crm_load_dealers_human(jsonb, text) from public;

-- crm --assign (khối sales): lead chưa gán đại lý khác, đại lý active.
-- Vùng ↔ tỉnh theo data/dealer_regions.json kiểm ở CLI (file, không DB).
create or replace function crm_assign_lead_human(p_lead bigint,
  p_dealer text, p_province text, p_by text)
returns void
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  v_cur text;
  v_st text;
begin
  select dealer_code into v_cur from leads where id = p_lead for update;
  if not found then
    raise exception 'không có lead #%', p_lead;
  end if;
  if v_cur is not null and v_cur <> p_dealer then
    raise exception 'lead #% đã gán % — tranh chấp chuyển người duyệt (không gán đè)',
      p_lead, v_cur;
  end if;
  select status into v_st from dealers where code = p_dealer;
  if not found then
    raise exception 'không có đại lý %', p_dealer;
  end if;
  if v_st <> 'active' then
    raise exception 'đại lý % đang %', p_dealer, v_st;
  end if;
  if btrim(coalesce(p_province, '')) = '' then
    raise exception 'thiếu tỉnh';
  end if;
  update leads set province = p_province, dealer_code = p_dealer,
         assigned_by = v_by, assigned_at = now()
   where id = p_lead;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_assign', 'lead', p_lead::text,
          jsonb_build_object('dealer', p_dealer, 'province', p_province));
end $$;
revoke execute on function crm_assign_lead_human(bigint, text, text, text)
  from public;

-- crm --status (nhập liệu — danh tính): chỉ tiến new → contacted →
-- qualified → won; chưa kết thúc → lost.
create or replace function crm_set_lead_status_human(p_lead bigint,
  p_status text, p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  v_old text;
  flow text[] := array['new', 'contacted', 'qualified', 'won'];
begin
  select status into v_old from leads where id = p_lead for update;
  if not found then
    raise exception 'không có lead #%', p_lead;
  end if;
  if v_old in ('won', 'lost') then
    raise exception 'lead #% đã kết thúc (%)', p_lead, v_old;
  end if;
  if not (v_old = any(flow)) or not (p_status = any(flow || 'lost'::text))
  then
    raise exception 'lead #% trạng thái lạ — sửa tay', p_lead;
  end if;
  if p_status <> 'lost' and array_position(flow, p_status)
       <= array_position(flow, v_old) then
    raise exception 'không lùi/giữ trạng thái % → %', v_old, p_status;
  end if;
  update leads set status = p_status where id = p_lead;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_status', 'lead', p_lead::text,
          jsonb_build_object('from', v_old, 'to', p_status));
  return v_old;
end $$;
revoke execute on function crm_set_lead_status_human(bigint, text, text)
  from public;

-- crm --owner (khối sales): người phụ trách = MÃ nhân viên; hạn do CLI tính
-- theo giờ làm việc (cấu hình file).
create or replace function crm_assign_owner_human(p_lead bigint,
  p_staff text, p_due timestamptz, p_now timestamptz, p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  v_now timestamptz := p10_now(p_now);
  v_st text;
  v_old text;
begin
  if coalesce(p_staff, '') !~ '^[A-Z0-9_-]{2,20}$' then
    raise exception 'mã nhân viên sai mẫu';
  end if;
  select status, owner_code into v_st, v_old from leads where id = p_lead
   for update;
  if not found then
    raise exception 'không có lead #%', p_lead;
  end if;
  if v_st in ('won', 'lost') then
    raise exception 'lead #% đã kết thúc (%)', p_lead, v_st;
  end if;
  if p_due is null or p_due < v_now then
    raise exception 'hạn xử lý không hợp lệ';
  end if;
  update leads set owner_code = p_staff, owner_due_at = p_due,
         owner_assigned_by = v_by, owner_assigned_at = v_now
   where id = p_lead;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_owner', 'lead', p_lead::text,
          jsonb_build_object('from', v_old, 'to', p_staff,
                             'due_at', p_due));
  return v_old;
end $$;
revoke execute on function crm_assign_owner_human(bigint, text, timestamptz,
  timestamptz, text) from public;

-- crm --handoff (khối sales): ciphertext liên hệ CHỈ trả khi đồng ý dai_ly
-- ĐÍCH DANH đại lý còn hiệu lực (giải mã ở CLI bằng khóa vault).
create or replace function crm_handoff_human(p_lead bigint, p_dealer text,
  p_by text)
returns table (province text, intent text, question text,
               pii_included boolean, phone_enc text, name_enc text,
               email_enc text, address_enc text)
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'sales');
  l record;
  v_st text;
  v_ok boolean := false;
  v_p text;
  v_n text;
  v_e text;
  v_a text;
begin
  select ld.dealer_code, ld.province, ld.intent, ld.question, ld.contact_id
    into l from leads ld where ld.id = p_lead;
  if not found then
    raise exception 'không có lead #%', p_lead;
  end if;
  if l.dealer_code is distinct from p_dealer then
    raise exception 'lead #% không gán cho %', p_lead, p_dealer;
  end if;
  select d.status into v_st from dealers d where d.code = p_dealer;
  if v_st is distinct from 'active' then
    raise exception 'đại lý % không active', p_dealer;
  end if;
  if l.contact_id is not null then
    select coalesce(v.granted, false) into v_ok from v_consent_current v
     where v.contact_id = l.contact_id and v.purpose = 'dai_ly'
       and coalesce(v.recipient_dealer, '') = p_dealer;
    v_ok := coalesce(v_ok, false);
  end if;
  if v_ok then
    select ct.phone_enc, ct.name_enc, ct.email_enc, ct.address_enc
      into v_p, v_n, v_e, v_a from contacts ct where ct.id = l.contact_id;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'crm_handoff', 'lead', p_lead::text,
          jsonb_build_object('lead_id', p_lead, 'dealer', p_dealer,
                             'pii_included', v_ok));
  return query select l.province, l.intent, l.question, v_ok, v_p, v_n, v_e,
    v_a;
end $$;
revoke execute on function crm_handoff_human(bigint, text, text) from public;

-- crm --report: số liên hệ + đồng ý hiện hành (đếm, không PII).
create or replace function crm_counts()
returns table (purpose text, n_granted bigint, n_withdrawn bigint)
language sql stable security definer set search_path from current as $$
  select '*'::text, count(*), 0::bigint from contacts
  union all
  select v.purpose, count(*) filter (where v.granted),
         count(*) filter (where not v.granted)
    from v_consent_current v group by v.purpose
$$;
revoke execute on function crm_counts() from public;

-- doc_intake --verify/--reject (khối legal_hr): chỉ từ pending_review.
create or replace function doc_review_human(p_sha text, p_status text,
  p_by text)
returns boolean
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'legal_hr');
  n int;
begin
  if p_status not in ('verified', 'rejected') then
    raise exception 'trạng thái phải là verified|rejected';
  end if;
  update documents set status = p_status, verified_by = v_by,
         verified_at = now()
   where sha256 = p_sha and status = 'pending_review';
  get diagnostics n = row_count;
  if n <> 1 then
    return false;
  end if;
  if p_status = 'verified' then
    update document_fields set verified = true where sha256 = p_sha;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'doc_' || p_status, 'document', left(p_sha, 12),
          jsonb_build_object('sha256', p_sha, 'status', p_status));
  return true;
end $$;
revoke execute on function doc_review_human(text, text, text) from public;

-- garden_director --purge-sample (khối farming): blocker (nhật ký KHÔNG mẫu
-- / ảnh trỏ khoảnh mẫu) → không xóa; số dòng phải khớp precheck của CLI.
create or replace function garden_purge_sample_human(p_by text,
  p_plots bigint, p_logs bigint)
returns jsonb
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  n_block bigint;
  n_plots bigint;
  n_logs bigint;
begin
  select (select count(*) from plot_logs l join plots p on p.id = l.plot_id
           where p.source like 'sample:%' and l.source not like 'sample:%')
       + (select count(*) from garden_media m join plots p on p.id = m.plot_id
           where p.source like 'sample:%')
    into n_block;
  if n_block > 0 then
    return jsonb_build_object('ok', false, 'blockers', n_block);
  end if;
  delete from plot_logs where source like 'sample:%';
  get diagnostics n_logs = row_count;
  delete from plots where source like 'sample:%';
  get diagnostics n_plots = row_count;
  if (n_plots, n_logs) is distinct from (p_plots, p_logs) then
    raise exception 'số dòng xóa lệch precheck (plots %/%, plot_logs %/%) — rollback',
      n_plots, p_plots, n_logs, p_logs;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'garden_sample_purge', 'plots', null,
          jsonb_build_object('plots', n_plots, 'plot_logs', n_logs));
  return jsonb_build_object('ok', true, 'plots', n_plots, 'plot_logs', n_logs);
end $$;
revoke execute on function garden_purge_sample_human(text, bigint, bigint)
  from public;

-- garden_director --adopt-plot (khối farming): khoảnh mẫu → manual:adopted.
create or replace function garden_adopt_plot_human(p_plot text, p_by text)
returns jsonb
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  v_src text;
begin
  select source into v_src from plots where id = p_plot for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason',
      format('khoảnh %L không tồn tại', p_plot));
  end if;
  if v_src not like 'sample:%' then
    return jsonb_build_object('ok', false, 'reason',
      format('khoảnh %s không phải khoảnh mẫu', p_plot));
  end if;
  update plots set source = 'manual:adopted', updated_at = now()
   where id = p_plot;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'garden_plot_adopt', 'plots', p_plot,
          jsonb_build_object('from_source', v_src));
  return jsonb_build_object('ok', true, 'from_source', v_src);
end $$;
revoke execute on function garden_adopt_plot_human(text, text) from public;

-- ra_kenh --partner-file (nhập liệu — danh tính): 1 dòng sổ rà bài đối tác.
create or replace function record_partner_scan_human(p_partner text,
  p_url_sha text, p_host text, p_channel text, p_posted_on date, p_sku text,
  p_text_sha text, p_codes text[], p_severity text, p_kit_ref text,
  p_queue_id bigint, p_is_sample boolean, p_now timestamptz, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  v_id bigint;
begin
  insert into partner_post_scans (partner_code, url_sha256, host, channel,
    posted_on, sku, text_sha256, codes, severity, kit_ref, queue_id,
    is_sample, scanned_by, scanned_at)
  values (p_partner, p_url_sha, p_host, p_channel, p_posted_on, p_sku,
          p_text_sha, coalesce(p_codes, '{}'), p_severity, p_kit_ref,
          p_queue_id, coalesce(p_is_sample, false), v_by, p10_now(p_now))
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function record_partner_scan_human(text, text, text, text,
  date, text, text, text[], text, text, bigint, boolean, timestamptz, text)
  from public;

-- ===== v15.2 p8 đếm đầu ra + duyệt từng đầu ra =====
-- (P8.7, PL02 mục 1b) Đầu ra báo cáo file / bảng không có bước người duyệt
-- riêng / file nhật ký (backup) chỉ có bằng chứng NGƯỜI duyệt qua sổ này:
-- 1 dòng = 1 quyết định của 1 NGƯỜI (danh tính theo login — `human_actor`,
-- khối = tiền tố mã tính năng) trên ĐÚNG 1 phiên bản nội dung (sha256) của
-- 1 đầu ra (khóa DISTINCT của bộ đếm `pipelines.rollout`). APPEND-ONLY (sửa
-- quyết định = dòng mới; bản mới nhất mỗi phiên bản thắng). Sinh báo cáo
-- KHÔNG phải đã duyệt; nội dung đổi → sha đổi → duyệt cũ không áp. Ghi CHỈ
-- qua function `output_review_human` (SECURITY DEFINER): v15 fix P8.7 — DB
-- TỰ kiểm khóa là đầu ra hiện hành của đúng tính năng (bộ đếm `count_spec`
-- owner ghi) cần duyệt qua sổ này + sha = phiên bản hiện hành (khối cuối).
create table if not exists output_reviews (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  feature_id text not null
    check (feature_id ~ '^[a-z_]+-[0-9]{2}([.][0-9]{1,2})?$'),
  output_key text not null check (char_length(output_key) between 4 and 300
    and output_key ~ '^[a-z]{2}:'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('approved', 'rejected')),
  reviewed_by text not null check (char_length(btrim(reviewed_by))
    between 1 and 100 and btrim(reviewed_by)
    !~* '^\s*(agent|system|auto_policy)\s*:'),
  note text check (char_length(note) <= 300),
  db_role text not null default session_user
);
create index if not exists output_reviews_lookup_idx
  on output_reviews (feature_id, output_key, content_sha256, ts desc);
create or replace trigger output_reviews_append_only_row
  before update or delete on output_reviews
  for each row execute function append_only_guard();
create or replace trigger output_reviews_no_truncate
  before truncate on output_reviews
  for each statement execute function append_only_guard();

-- Function ghi `output_review_human`: định nghĩa ở khối `v15 fix P8.7`
-- cuối file (DB tự kiểm khóa + phiên bản bằng bộ đếm `count_spec` —
-- cần `rollout_db_outputs` định nghĩa ở khối vá review v15).

-- ===== v15 vá review (P10.1/P8.7) =====
-- Review v15: `rollout_transition_human` trước đây tin số đếm đầu ra trong
-- `p_evidence` do caller (login người) tự truyền → gọi thẳng bằng psql vượt
-- cổng PL02. Nay DB TỰ đếm lại bằng bộ đếm `count_spec` mà OWNER ghi vào sổ
-- (`rollout --seed`; app_human/svc chỉ SELECT `feature_rollout`):
--   {"sql": [{"q": câu SQL 1 nguồn, "review": cần duyệt qua output_reviews}],
--    "file": số nguồn file, "workdays": [0..6], "holidays": ["YYYY-MM-DD"]}
-- `q` là CHÍNH câu `pipelines.rollout._source_sql` Python chạy (cửa sổ =
-- $1/$2, tham số khác thành literal — `rollout._db_sql`) → Python và DB đếm
-- cùng một câu; phần gộp khóa/sổ duyệt/ngày làm việc bám `output_rows` /
-- `output_facts` / `business_days` (test parity
-- `tests/test_v15_p8_outputs.py`). Đổi danh mục / bộ đếm / lịch nghỉ → owner
-- chạy lại `--seed` (đồng bộ `count_spec`, giữ giai đoạn + mốc). Câu `q` chỉ
-- chạy bên trong function SECURITY DEFINER với quyền owner — nguồn của nó là
-- cột chỉ owner ghi được, KHÔNG phải tham số của caller.
alter table feature_rollout add column if not exists count_spec jsonb;

create or replace function p10_is_person(p text) returns boolean
language sql immutable as $$
  select btrim(coalesce(p, '')) <> ''
     and lower(btrim(p)) not like 'agent:%'
     and lower(btrim(p)) not like 'system:%'
$$;

-- Ngày làm việc theo lịch trong bộ đếm (0 = thứ Hai, như Python weekday()).
create or replace function rollout_workday(p_d date, p_spec jsonb)
returns boolean
language sql stable as $$
  select coalesce((extract(isodow from p_d)::int - 1) in (
           select jsonb_array_elements_text(p_spec->'workdays')::int)
         and not coalesce(p_spec->'holidays' ? to_char(p_d, 'YYYY-MM-DD'),
                          false), false)
$$;
revoke execute on function rollout_workday(date, jsonb) from public;

-- = `rollout.business_days`: số ngày làm việc d, ngày_VN(since) < d ≤
-- ngày_VN(now).
create or replace function rollout_business_days(p_since timestamptz,
  p_now timestamptz, p_spec jsonb)
returns int
language sql stable set search_path from current as $$
  select count(*)::int
    from generate_series(1, p10_vn_date(p_now) - p10_vn_date(p_since)) g(n)
   where rollout_workday(p10_vn_date(p_since) + g.n, p_spec)
$$;
revoke execute on function rollout_business_days(timestamptz, timestamptz,
  jsonb) from public;

-- Từng dòng đầu ra (chưa gộp) của các câu đếm trong [p_a, p_b]; `i` = thứ
-- tự nguồn (gộp sha theo nguồn đầu tiên có sha, như Python).
create or replace function rollout_db_outputs(p_spec jsonb, p_a timestamptz,
  p_b timestamptz)
returns table (i int, k text, ts timestamptz, human boolean, unapp boolean,
               nr boolean, sha text)
language plpgsql stable set search_path from current as $$
declare
  s jsonb;
  n int := 0;
begin
  for s in select x from jsonb_array_elements(
             case when jsonb_typeof(p_spec->'sql') = 'array'
                  then p_spec->'sql' else '[]'::jsonb end) x loop
    n := n + 1;
    return query execute format(
      'select %s, x.k::text, x.ts::timestamptz, coalesce(x.h, false), '
      || 'coalesce(x.u, false), %L::boolean, x.s::text '
      || 'from (%s) x(k, ts, h, u, s)',
      n, coalesce(s->>'review', 'false'), s->>'q') using p_a, p_b;
  end loop;
end $$;
revoke execute on function rollout_db_outputs(jsonb, timestamptz,
  timestamptz) from public;

-- Gộp khóa DISTINCT + quyết định MỚI NHẤT của sổ duyệt trên đúng phiên bản
-- (đầu ra cần duyệt qua sổ) → human / unapp / unrev từng đầu ra.
create or replace function rollout_db_facts(p_fid text, p_spec jsonb,
  p_a timestamptz, p_b timestamptz)
returns table (k text, ts timestamptz, human boolean, unapp boolean,
               unrev boolean)
language sql stable set search_path from current as $$
  with o as (
    select x.k, min(x.ts) as ts, bool_or(x.human) as human,
           bool_or(x.unapp) as unapp, bool_and(x.nr) as nr,
           (array_agg(x.sha order by x.i)
              filter (where x.sha is not null))[1] as sha
      from rollout_db_outputs(p_spec, p_a, p_b) x group by x.k),
  r as (
    select distinct on (v.output_key, v.content_sha256) v.output_key,
           v.content_sha256, v.decision, v.reviewed_by
      from output_reviews v where v.feature_id = p_fid
     order by v.output_key, v.content_sha256, v.ts desc, v.id desc)
  select o.k, o.ts,
         o.human or coalesce(o.nr and r.decision = 'approved'
                             and p10_is_person(r.reviewed_by), false),
         o.unapp, o.nr and r.output_key is null
    from o left join r on o.nr and r.output_key = o.k
                      and r.content_sha256 = o.sha
$$;
revoke execute on function rollout_db_facts(text, jsonb, timestamptz,
  timestamptz) from public;

-- ===== v15 fix P10.2 =====
-- (P10.2, F08) Người ĐƯỢC PHÉP phải HOÀN THÀNH được nghiệp vụ. Trước vá: login
-- người `in role app_human` (human_logins + users file `db_login` + approvers
-- khối) qua được cổng ủy quyền nhưng `da_pmo --set-status/--apply-due`,
-- `da_b2b --handover`, `ra_kenh --mark-removed`, `anchor --submit --by <người>`
-- ghi bảng TRỰC TIẾP → `permission denied`; `kd_quote --outcome/--verify-send
-- --by` INSERT cột trực tiếp → gọi SQL thẳng ghi được tên người khác. Nay mỗi
-- việc ghi qua 1 function nghiệp vụ SECURITY DEFINER (search_path ghim,
-- REVOKE PUBLIC, GRANT EXECUTE CHỈ app_human — roles.sql khối cùng tên):
--   * danh tính = `human_actor` (session_user ↔ human_logins, không tin
--     `--by`); khối theo phân loại runbook 9.7: QUYẾT ĐỊNH (set-status → ceo,
--     mark-removed → legal_hr, anchor --submit → farming) đòi khối trong
--     human_logins; NHẬP LIỆU / THỰC THI mục ĐÃ duyệt (apply-due, handover,
--     outcome, mốc đã gửi) chỉ danh tính.
--   * bất biến nghiệp vụ tự kiểm lại (gọi thẳng psql không vượt): mục hàng
--     duyệt đúng khối/loại, ĐÃ duyệt, nội dung khớp sha bản duyệt MỚI NHẤT
--     (`verify_publish`); hạn cũ (stale); thành viên lô tổ chức khớp bản
--     duyệt; biên nhận neo mang đúng digest bản kê + giai đoạn tính năng cho
--     dùng; 1 kết quả/báo giá. Chạy lại = no-op (không ghi dòng/log mới).
--   * login owner/superuser (máy dev) giữ hành vi cũ (`human_actor`/
--     `p10_now` nhận `--by`/giờ truyền vào) — không thêm quyền gì.
-- Còn ở Python (DB không đọc được — runbook 9.7 "rủi ro còn lại"): giai đoạn
-- rollout biên DÙNG theo danh mục file (`aq.verify`/`use_reason`), so từng ô
-- lô tổ chức dựng lại (DB kiểm bản duyệt + số dòng + mã từng tổ chức), gửi
-- digest ra calendar (DB kiểm danh tính TRƯỚC khi gửi qua `human_actor`).

-- da_pmo --set-status (QUYẾT ĐỊNH khối ceo).
create or replace function milestone_set_status_human(p_code text,
  p_status text, p_evidence text, p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'ceo');
  v_ev text := nullif(btrim(coalesce(p_evidence, '')), '');
  r project_milestones%rowtype;
begin
  if p_status is null or p_status not in ('chua_bat_dau', 'dang_lam', 'xong',
                                          'tam_dung') then
    raise exception 'trạng thái mốc lạ: %', p_status;
  end if;
  if p_status = 'xong' and v_ev is null then
    raise exception 'status xong cần evidence (link/biên bản)';
  end if;
  if char_length(v_ev) > 500 then
    raise exception 'evidence quá 500 ký tự';
  end if;
  select * into r from project_milestones where code = p_code for update;
  if not found then
    raise exception 'không có mốc %', left(coalesce(p_code, ''), 40);
  end if;
  if r.status = p_status
     and r.evidence is not distinct from coalesce(v_ev, r.evidence) then
    return 'noop';
  end if;
  update project_milestones set status = p_status,
         evidence = coalesce(v_ev, evidence), updated_by = v_by,
         updated_at = now()
   where code = p_code;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'milestone_status', 'project_milestone', p_code,
          jsonb_build_object('from', r.status, 'to', p_status,
                             'evidence', v_ev is not null));
  return 'ok';
end $$;
revoke execute on function milestone_set_status_human(text, text, text, text)
  from public;

-- da_pmo --apply-due (THỰC THI mục milestone_change ĐÃ duyệt — danh tính).
-- Payload tất định (`agents.da_pmo.change_payload`) → DB tự tách code/hạn
-- cũ/hạn mới, kiểm sha bản duyệt mới nhất + hạn hiện tại == hạn cũ.
create or replace function milestone_apply_due_human(p_qid bigint,
  p_by text)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  q approval_queue%rowtype;
  m text[];
  v_old date;
  v_new date;
  v_cur date;
begin
  select * into q from approval_queue a where a.id = p_qid;
  if not found or q.block not in ('ceo', 'projects')
     or q.object_type <> 'milestone_change' then
    raise exception 'mục #% không phải milestone_change khối ceo', p_qid;
  end if;
  if q.status <> 'approved' then
    raise exception 'mục #% đang ''%'' — chỉ áp dụng khi đã duyệt',
      p_qid, q.status;
  end if;
  m := regexp_match(coalesce(q.payload, ''),
    '^# Đề xuất đổi hạn mốc (\S+)\n\ncode: (\S+)\nold_due: '
    '(\d{4}-\d{2}-\d{2})\nnew_due: (\d{4}-\d{2}-\d{2})\nby: ([^\n]+)\n\n'
    'Đổi hạn chỉ có hiệu lực sau khi người duyệt \(agent không tự đổi\)\.\n$');
  if m is null or m[1] <> m[2] then
    raise exception 'mục #%: payload sai định dạng — không áp dụng', p_qid;
  end if;
  begin
    v_old := m[3]::date;
    v_new := m[4]::date;
  exception when others then
    raise exception 'mục #%: ngày trong payload sai lịch', p_qid;
  end;
  if q.object_id <> 'milestone:' || m[1]
     or not verify_publish(q.object_type, q.object_id, q.payload) then
    raise exception 'mục #%: LỆCH bản duyệt (sha256) — không áp dụng', p_qid;
  end if;
  select due_date into v_cur from project_milestones where code = m[1]
     for update;
  if not found then
    raise exception 'không có mốc %', m[1];
  end if;
  if v_cur = v_new then
    return 'noop';
  end if;
  if v_cur <> v_old then
    raise exception '%: hạn hiện tại khác old_due % (stale) — đề xuất lại',
      m[1], to_char(v_old, 'DD/MM/YYYY');
  end if;
  update project_milestones set due_date = v_new, updated_by = v_by,
         updated_at = now()
   where code = m[1];
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'milestone_due_apply', 'project_milestone', m[1],
          jsonb_build_object('queue_id', p_qid, 'old_due', v_old,
                             'new_due', v_new));
  return 'ok';
end $$;
revoke execute on function milestone_apply_due_human(bigint, text)
  from public;

-- da_b2b --handover (THỰC THI lô org_prospect_batch đã quyết — danh tính).
-- Từ chối/hết hạn → dòng `cho_duyet` về `moi`; đã duyệt → `p_payload` (bảng
-- dựng lại từ dòng hiện tại, Python) phải khớp sha bản duyệt mới nhất VÀ
-- thành viên lô hiện tại (số dòng + mã từng tổ chức) có trong bản duyệt.
create or replace function org_handover_human(p_qid bigint, p_payload text,
  p_by text)
returns int
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
  q approval_queue%rowtype;
  v_n int;
  v_cnt int;
  v_bad int;
begin
  select * into q from approval_queue a where a.id = p_qid;
  if not found or q.block not in ('sales', 'projects')
     or q.object_type <> 'org_prospect_batch' then
    raise exception 'mục #% không phải lô org_prospect_batch', p_qid;
  end if;
  if q.status in ('rejected', 'expired') then
    update org_prospects set status = 'moi', batch_queue_id = null
     where batch_queue_id = p_qid and status = 'cho_duyet';
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into agent_action_log (actor, action, object_type, object_id,
                                    detail)
      values (v_by, 'org_batch_return', 'approval_queue', p_qid::text,
              jsonb_build_object('n', v_n, 'status', q.status));
    end if;
    return v_n;
  end if;
  if q.status <> 'approved' then
    raise exception 'lô #% đang ''%'' — chỉ chuyển khi NGƯỜI đã duyệt',
      p_qid, q.status;
  end if;
  if p_payload is null
     or not verify_publish(q.object_type, q.object_id, p_payload) then
    raise exception 'lô #%: dữ liệu LỆCH bản đã duyệt (sha256) — KHÔNG chuyển',
      p_qid;
  end if;
  select count(*), count(*) filter (where position(
           '| ' || substr(o.dedup_key, 5, 12) || ' |' in p_payload) = 0)
    into v_cnt, v_bad
    from org_prospects o where o.batch_queue_id = p_qid;
  if v_cnt = 0 or v_bad > 0 or position(
       '# Lô tổ chức tiềm năng mua quà Tết — ' || v_cnt || ' tổ chức'
       || chr(10) in p_payload) <> 1 then
    raise exception 'lô #%: thành viên lô LỆCH bản đã duyệt — KHÔNG chuyển',
      p_qid;
  end if;
  update org_prospects set status = 'chuyen_sales', handed_at = now()
   where batch_queue_id = p_qid and status = 'cho_duyet';
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into agent_action_log (actor, action, object_type, object_id,
                                  detail)
    values (v_by, 'org_batch_handover', 'approval_queue', p_qid::text,
            jsonb_build_object('n', v_n));
  end if;
  return v_n;
end $$;
revoke execute on function org_handover_human(bigint, text, text)
  from public;

-- Dòng của ĐÚNG 1 lô (để CLI dựng lại bảng so sha bản duyệt) — app_human
-- KHÔNG có SELECT `org_prospects` (v8.3: bảng chỉ owner đọc); đọc qua đây
-- cần danh tính theo login + mục là lô org_prospect_batch.
create or replace function org_batch_rows_human(p_qid bigint, p_by text)
returns table (id bigint, dedup_key text, org_name text, org_type text,
               region text, website text, source_url text, fit_reason text)
language plpgsql stable security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, null);
begin
  if not exists (select 1 from approval_queue a where a.id = p_qid
                   and a.block in ('sales', 'projects')
                   and a.object_type = 'org_prospect_batch') then
    raise exception 'mục #% không phải lô org_prospect_batch', p_qid;
  end if;
  return query
    select o.id, o.dedup_key, o.org_name, o.org_type, o.region, o.website,
           o.source_url, o.fit_reason
      from org_prospects o where o.batch_queue_id = p_qid order by o.id;
end $$;
revoke execute on function org_batch_rows_human(bigint, text) from public;

-- ra_kenh --mark-removed (QUYẾT ĐỊNH khối legal_hr): đóng đợt vi phạm đang
-- mở của URL (`da_go`) + 1 dòng log; không có đợt mở → 0 (không ghi gì).
create or replace function channel_post_mark_removed_human(p_url text,
  p_now timestamptz, p_by text)
returns int
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'legal_hr');
  v_ids bigint[];
begin
  with u as (
    update channel_posts set closed_at = p10_now(p_now),
           close_reason = 'da_go', closed_by = v_by
     where url = btrim(coalesce(p_url, '')) and closed_at is null
       and severity is not null
    returning id)
  select array_agg(id order by id) into v_ids from u;
  if v_ids is null then
    return 0;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'channel_post_removed', 'channel_post', v_ids[1]::text,
          jsonb_build_object('ids', to_jsonb(v_ids)));
  return cardinality(v_ids);
end $$;
revoke execute on function channel_post_mark_removed_human(text, timestamptz,
  text) from public;

-- anchor --submit --by <người> (QUYẾT ĐỊNH khối farming, tính năng
-- farming-06): ghi biên nhận gửi digest. Login không owner: giai đoạn phải
-- cho dùng (co_nguoi_duyet | van_hanh); `da_gui` phải mang đúng digest bản kê
-- (OTS header ‖ sha256 bản kê); đã có `da_gui` → no-op (trả id cũ).
create or replace function anchor_receipt_human(p_batch bigint,
  p_status text, p_calendar text, p_receipt bytea, p_error text, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  b anchor_batches%rowtype;
  v_stage text;
  v_id bigint;
begin
  select * into b from anchor_batches where id = p_batch;
  if not found then
    raise exception 'không có lần gom #%', p_batch;
  end if;
  if not p10_owner_login() then
    select stage into v_stage from feature_rollout
     where feature_id = 'farming-06';
    if v_stage is null or v_stage not in ('co_nguoi_duyet', 'van_hanh') then
      raise exception 'farming-06 đang % — chưa cho dùng, không ghi biên nhận (HĐ 6.7/PL02)',
        coalesce(v_stage, 'chưa vào sổ');
    end if;
  end if;
  select id into v_id from anchor_receipts
   where batch_id = p_batch and status = 'da_gui' order by id limit 1;
  if found then
    return v_id;
  end if;
  if p_status = 'da_gui' then
    if coalesce(p_calendar, '') !~ '^https://' or p_receipt is null
       or substring(p_receipt from 1 for 65) <> (
         '\x004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108'::bytea
         || decode(b.manifest_sha256, 'hex')) then
      raise exception 'lần gom #%: biên nhận không mang đúng digest bản kê — không ghi',
        p_batch;
    end if;
  elsif p_status = 'loi' then
    if btrim(coalesce(p_error, '')) = '' then
      raise exception 'biên nhận lỗi cần lớp lỗi';
    end if;
  else
    raise exception 'trạng thái biên nhận lạ: %', p_status;
  end if;
  insert into anchor_receipts (batch_id, provider, status, calendar, receipt,
    error, created_by)
  values (p_batch, 'opentimestamps', p_status,
          case when p_status = 'da_gui' then p_calendar end,
          case when p_status = 'da_gui' then p_receipt end,
          case when p_status = 'loi' then left(p_error, 300) end, v_by)
  returning id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'anchor_submit', 'anchor_batch', p_batch::text,
          jsonb_build_object('receipt_id', v_id, 'status', p_status));
  return v_id;
end $$;
revoke execute on function anchor_receipt_human(bigint, text, text, bytea,
  text, text) from public;

-- r14-fix2 F2: chống trùng `da_nang_cap` cho dòng MỚI bằng trigger tuần tự hóa
-- theo lần gom (khóa advisory trong transaction, kiểm lại dưới khóa) thay chỉ
-- mục unique r14 — chỉ mục không tạo được khi lịch sử HỢP LỆ đã có 2 dòng cùng
-- lần gom (2 upgrade baseline 0afa388 chạy đồng thời). Lịch sử giữ nguyên (không
-- UPDATE/DELETE); mọi INSERT `da_nang_cap` (job, function người, owner) vào lần
-- gom đã có ≥1 dòng → 23505. Hàm ghi gọi cùng khóa TRƯỚC để trả "đã có" thay lỗi.
drop index if exists anchor_receipts_upgrade_once;
create or replace function anchor_receipt_upgrade_once() returns trigger
language plpgsql set search_path from current as $$
begin
  if new.status = 'da_nang_cap' then
    perform pg_advisory_xact_lock(
      hashtextextended('anchor_receipts_upgrade:' || new.batch_id, 0));
    if exists (select 1 from anchor_receipts where batch_id = new.batch_id
                 and status = 'da_nang_cap') then
      raise exception 'lần gom #% đã có biên nhận da_nang_cap — không ghi thêm',
        new.batch_id using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
revoke execute on function anchor_receipt_upgrade_once() from public;
create or replace trigger anchor_receipts_upgrade_once
  before insert on anchor_receipts
  for each row execute function anchor_receipt_upgrade_once();

-- anchor --upgrade --by <người> (QUYẾT ĐỊNH khối farming, tính năng
-- farming-06) ở giai đoạn có người duyệt: ghi biên nhận `da_nang_cap` (calendar
-- trả attestation — KHÔNG phải xác minh blockchain bên thứ ba). Login không
-- owner: giai đoạn cho dùng (co_nguoi_duyet | van_hanh); phải có biên nhận
-- `da_gui` cùng calendar của lần gom; biên nhận mới mang đúng digest bản kê
-- (cây OTS kiểm ở ứng dụng). Đã có `da_nang_cap` → no-op (trả id mới nhất,
-- created = false). r14-fix2: trả (receipt_id, created) — bản r14 trả bigint chỉ
-- tồn tại ở DB thử chưa phát hành, đổi kiểu trả về phải drop đúng bản đó.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'anchor_upgrade_human'
               and pronamespace = current_schema()::regnamespace
               and prorettype = 'bigint'::regtype) then
    drop function anchor_upgrade_human(bigint, text, bytea, text);
  end if;
end $$;
create or replace function anchor_upgrade_human(p_batch bigint,
  p_calendar text, p_receipt bytea, p_by text)
returns table (receipt_id bigint, created boolean)
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  b anchor_batches%rowtype;
  v_stage text;
  v_id bigint;
begin
  select * into b from anchor_batches where id = p_batch;
  if not found then
    raise exception 'không có lần gom #%', p_batch;
  end if;
  if not p10_owner_login() then
    select stage into v_stage from feature_rollout
     where feature_id = 'farming-06';
    if v_stage is null or v_stage not in ('co_nguoi_duyet', 'van_hanh') then
      raise exception 'farming-06 đang % — chưa cho dùng, không ghi biên nhận nâng cấp (HĐ 6.7/PL02)',
        coalesce(v_stage, 'chưa vào sổ');
    end if;
  end if;
  if not exists (select 1 from anchor_receipts where batch_id = p_batch
                  and status = 'da_gui' and calendar = p_calendar) then
    raise exception 'lần gom #%: không có biên nhận đã gửi tới calendar này — không nâng cấp',
      p_batch;
  end if;
  if p_receipt is null or substring(p_receipt from 1 for 65) <> (
       '\x004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108'::bytea
       || decode(b.manifest_sha256, 'hex')) then
    raise exception 'lần gom #%: biên nhận nâng cấp không mang đúng digest bản kê — không ghi',
      p_batch;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('anchor_receipts_upgrade:' || p_batch, 0));
  select id into v_id from anchor_receipts
   where batch_id = p_batch and status = 'da_nang_cap' order by id desc limit 1;
  if found then
    return query select v_id, false;
    return;
  end if;
  insert into anchor_receipts (batch_id, provider, status, calendar, receipt,
    created_by)
  values (p_batch, 'opentimestamps', 'da_nang_cap', p_calendar, p_receipt,
          v_by)
  returning id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'anchor_upgrade', 'anchor_batch', p_batch::text,
          jsonb_build_object('receipt_id', v_id));
  return query select v_id, true;
end $$;
revoke execute on function anchor_upgrade_human(bigint, text, bytea, text)
  from public;

-- kd_quote --outcome / --verify-send (NHẬP LIỆU — danh tính): 1 dòng
-- b2b_quote_events cho báo giá sales ĐÃ duyệt. Kết quả (chot|khong_chot|huy)
-- cần người (login của chính họ), 1 lần/báo giá; mốc `da_gui` cần bản gửi
-- khớp sha bản duyệt mới nhất (`p_text`), `p_by` null = mốc không ghi tên.
create or replace function b2b_quote_event_human(p_qid bigint, p_kind text,
  p_text text, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text;
  q approval_queue%rowtype;
  v_done text;
  v_id bigint;
begin
  if p_kind is null or p_kind not in ('da_gui', 'chot', 'khong_chot', 'huy')
  then
    raise exception 'loại sự kiện báo giá lạ: %', p_kind;
  end if;
  if p_by is null and p_kind = 'da_gui' then
    v_by := null;
  else
    v_by := human_actor(p_by, null);
  end if;
  select * into q from approval_queue a where a.id = p_qid for update;
  if not found or q.block <> 'sales'
     or q.object_type not in ('b2b_quote', 'b2b_quote_matrix')
     or q.status <> 'approved' then
    raise exception 'mục #% không phải báo giá B2B ĐÃ duyệt', p_qid;
  end if;
  if p_kind = 'da_gui' then
    if p_text is null
       or not verify_publish(q.object_type, q.object_id, p_text) then
      raise exception 'mục #%: bản gửi LỆCH bản đã duyệt — không ghi mốc gửi',
        p_qid;
    end if;
  else
    select e.kind into v_done from b2b_quote_events e
     where e.queue_id = p_qid and e.kind in ('chot', 'khong_chot', 'huy')
     order by e.id limit 1;
    if found then
      raise exception 'mục #% đã ghi kết quả ''%'' — không ghi đè',
        p_qid, v_done;
    end if;
  end if;
  insert into b2b_quote_events (queue_id, quote_no, kind, recorded_by)
  values (p_qid, q.object_id, p_kind, v_by)
  returning id into v_id;
  if p_kind <> 'da_gui' then
    insert into agent_action_log (actor, action, object_type, object_id,
                                  detail)
    values (v_by, 'b2b_quote_outcome', 'b2b_quote', p_qid::text,
            jsonb_build_object('kind', p_kind, 'event_id', v_id));
  end if;
  return v_id;
end $$;
revoke execute on function b2b_quote_event_human(bigint, text, text, text)
  from public;

-- ===== v15 fix P8.7 =====
-- (P8.7, PL02 mục 1b) Trước vá: `output_review_human` chỉ kiểm đầy đủ khóa
-- báo cáo `rp:` — login người gọi thẳng ghi được duyệt cho khóa bảng/file
-- KHÔNG tồn tại (`ar:does-not-exist`), khóa của tính năng khác, sha tùy ý,
-- dòng mẫu, nguồn file... (dòng rác append-only + log `output_review`). Nay
-- DB TỰ kiểm ở biên, không tin key/sha caller truyền (kể cả đã qua Python):
--   * sổ triển khai phải có bộ đếm `count_spec` (owner ghi qua `rollout
--     --seed`; app_human không ghi được `feature_rollout`) — chưa có → từ
--     chối;
--   * khóa phải là đầu ra của ĐÚNG tính năng trong cửa sổ giai đoạn hiện
--     hành [stage_since, now()] theo CHÍNH câu đếm các nguồn bảng/báo cáo
--     (`rollout_db_outputs` — cùng bộ đếm cổng PL02 `rollout_db_facts`; câu
--     đếm đã loại mẫu, lọc nguồn/loại/khối) → khóa không tồn tại / sai tính
--     năng / sai nguồn / mẫu / sai tiền tố / ngoài cửa sổ → từ chối;
--   * đầu ra phải thuộc cơ chế duyệt này (mọi nguồn chứa khóa đều `review`
--     — không có bước người riêng); có bước riêng (hàng duyệt/nháp/người
--     ghi) → từ chối;
--   * sha = phiên bản HIỆN HÀNH (gộp như `rollout_db_facts`: sha của nguồn
--     đầu tiên có sha; báo cáo = bản mới nhất) → phiên bản cũ / sha tùy ý →
--     từ chối;
--   * nguồn FILE (convlog/backup_runs trên máy ứng dụng) DB không đọc được
--     và CHƯA có bản chụp tin cậy trong DB → khóa file bị từ chối kèm lý do
--     (app_human không tự tạo bằng chứng rồi tự duyệt); nguồn bảng/báo cáo
--     của cùng tính năng vẫn duyệt được.
-- Từ chối = `raise` → không dòng `output_reviews`, không log. Danh tính theo
-- login (`human_actor`, khối = tiền tố mã tính năng) + append-only giữ nguyên.
create or replace function output_review_human(p_fid text, p_key text,
  p_sha text, p_decision text, p_by text, p_note text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_block text := regexp_replace(coalesce(p_fid, ''), '-.*$', '');
  v_by text := human_actor(p_by, v_block);
  v_spec jsonb;
  v_since timestamptz;
  v_n int;
  v_nr boolean;
  v_cur text;
  v_file boolean;
  v_id bigint;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'quyết định lạ: % (approved|rejected)', p_decision;
  end if;
  if coalesce(p_sha, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 nội dung sai khuôn';
  end if;
  select count_spec, stage_since into v_spec, v_since
    from feature_rollout where feature_id = p_fid for share;
  if not found then
    raise exception '%: chưa vào sổ triển khai', p_fid;
  end if;
  if v_spec is null or jsonb_typeof(v_spec->'sql') is distinct from 'array'
  then
    raise exception '%: sổ chưa có bộ đếm đầu ra (count_spec) — owner chạy rollout --seed; DB không duyệt khóa không kiểm được',
      p_fid;
  end if;
  select count(*), bool_and(x.nr),
         (array_agg(x.sha order by x.i) filter (where x.sha is not null))[1]
    into v_n, v_nr, v_cur
    from rollout_db_outputs(v_spec, v_since, now()) x
   where x.k = p_key;
  if v_n = 0 then
    v_file := jsonb_typeof(v_spec->'file') = 'number'
              and (v_spec->>'file')::numeric > 0;
    raise exception '%: % không phải đầu ra nguồn bảng/báo cáo của tính năng trong giai đoạn hiện hành (khóa không tồn tại / sai tính năng hoặc nguồn / mẫu / ngoài cửa sổ)%',
      p_fid, left(coalesce(p_key, ''), 80),
      case when v_file then ' — nguồn file của tính năng (nhật ký máy chủ'
        || ' ứng dụng) DB không đọc được, CHƯA có bản chụp tin cậy trong DB:'
        || ' không duyệt nguồn file qua sổ này' else '' end;
  end if;
  if not v_nr then
    raise exception '%: đầu ra % có bước duyệt riêng (hàng duyệt/nháp/người ghi) — duyệt ở đó, không qua sổ này',
      p_fid, left(p_key, 80);
  end if;
  if v_cur is null or v_cur <> p_sha then
    raise exception 'sha không phải phiên bản MỚI NHẤT (hiện hành) của đầu ra % — đọc lại bản hiện hành rồi duyệt',
      left(p_key, 80);
  end if;
  insert into output_reviews (feature_id, output_key, content_sha256,
    decision, reviewed_by, note)
  values (p_fid, p_key, p_sha, p_decision, v_by, p_note)
  returning id into v_id;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'output_review', 'output', p_fid || ':' || left(p_key, 200),
          jsonb_build_object('review_id', v_id, 'sha256', p_sha,
                             'decision', p_decision));
  return v_id;
end $$;
revoke execute on function output_review_human(text, text, text, text, text,
  text) from public;

-- ===== v15 fix P8.7b =====
-- (P8.7, PL02 mục 1b) Sau vá P8.7, người được ủy quyền (login `in role
-- app_human`, không owner, `human_logins` đúng khối) vẫn KHÔNG duyệt được
-- đầu ra nguồn BẢNG qua CLI: `rollout --outputs/--review-output` đọc thẳng
-- bảng nguồn (vd `audit_runs`) mà app_human không có SELECT → "nguồn chưa
-- đọc được". KHÔNG cấp SELECT bảng nguồn cho app_human; thay vào đó function
-- SECURITY DEFINER này liệt kê đầu ra CẦN DUYỆT qua sổ `output_reviews` của
-- 1 tính năng cho login người:
--   * danh tính/khối như `output_review_human`: `human_actor` (login ↔
--     `human_logins`, khối = tiền tố mã tính năng); `p_by` null → người của
--     chính login; owner (dev) không kiểm (vốn đọc được mọi bảng);
--   * CÙNG bộ đếm DB với `output_review_human`/cổng PL02: `count_spec`
--     (owner ghi qua `--seed`) + `rollout_db_outputs` trong cửa sổ giai đoạn
--     hiện hành [stage_since, now()] — câu đếm đã loại mẫu, lọc nguồn/loại;
--     gộp sha như `rollout_db_facts` (sha nguồn đầu tiên có sha = phiên bản
--     hiện hành); chỉ đầu ra mọi nguồn đều cần duyệt qua sổ (không có bước
--     người riêng);
--   * trả CHỈ khóa + thời điểm + sha + loại nguồn (bang|bao_cao) + quyết định
--     mới nhất trên đúng phiên bản (người duyệt — sổ app_human vốn đọc được):
--     không cột/nội dung bảng nguồn;
--   * nguồn FILE không liệt kê (DB không đọc được — `output_review_human` từ
--     chối kèm lý do). Chỉ đọc; DB vẫn là bên quyết ở `output_review_human`.
create or replace function output_pending_human(p_fid text,
  p_by text default null)
returns table (o_key text, o_ts timestamptz, o_sha text, o_nguon text,
               o_quyet_dinh text, o_nguoi_duyet text)
language plpgsql stable security definer set search_path from current as $$
declare
  v_block text := regexp_replace(coalesce(p_fid, ''), '-.*$', '');
  v_person text;
  v_spec jsonb;
  v_since timestamptz;
begin
  if not p10_owner_login() then
    if p_by is null then
      select h.person into v_person from human_logins h
       where h.db_login = session_user and h.active;
      if not found then
        raise exception 'login % chưa được ánh xạ người (human_logins — Bên B điền theo văn bản ủy quyền, không tự điền)',
          session_user using errcode = '42501';
      end if;
    end if;
    perform human_actor(coalesce(p_by, v_person), v_block);
  end if;
  select f.count_spec, f.stage_since into v_spec, v_since
    from feature_rollout f where f.feature_id = p_fid;
  if not found then
    raise exception '%: chưa vào sổ triển khai', p_fid;
  end if;
  if v_spec is null or jsonb_typeof(v_spec->'sql') is distinct from 'array'
  then
    raise exception '%: sổ chưa có bộ đếm đầu ra (count_spec) — owner chạy rollout --seed',
      p_fid;
  end if;
  return query
    with o as (
      select x.k, min(x.ts) as ts, bool_and(x.nr) as nr,
             (array_agg(x.sha order by x.i)
                filter (where x.sha is not null))[1] as sha
        from rollout_db_outputs(v_spec, v_since, now()) x group by x.k),
    r as (
      select distinct on (v.output_key, v.content_sha256) v.output_key,
             v.content_sha256, v.decision, v.reviewed_by
        from output_reviews v where v.feature_id = p_fid
       order by v.output_key, v.content_sha256, v.ts desc, v.id desc)
    select o.k, o.ts, o.sha,
           case when o.k like 'rp:%' then 'bao_cao' else 'bang' end,
           r.decision, r.reviewed_by
      from o left join r on r.output_key = o.k and r.content_sha256 = o.sha
     where o.nr
     order by o.ts, o.k;
end $$;
revoke execute on function output_pending_human(text, text) from public;

-- ===== v15 fix P8.7c =====
-- (P8.7, PL02 mục 1b) Bằng chứng TIN CẬY trong DB cho đầu ra nguồn FILE cần
-- người duyệt từng mục. Trước vá: backup hằng ngày (data_platform-07.2) chỉ
-- có nhật ký `$BACKUP_DIR/backup_runs.jsonl` trên máy ứng dụng — DB không
-- đọc được → `output_review_human` từ chối mọi khóa `bk:` (không duyệt được
-- backup hợp lệ) và cổng PL02 DB bỏ ngưỡng số lượng của tính năng có nguồn
-- file (tin bằng chứng Python). Nay:
--   * sổ APPEND-ONLY `file_output_evidence` (`append_only_guard`): 1 dòng = 1
--     PHIÊN BẢN bản ghi đầu ra nguồn file do ĐƯỜNG DỊCH VỤ ghi lúc tạo ra nó
--     (backup → chính tiến trình `scripts/db_backup.py`, login `svc_backup`,
--     ngay khi backup thành công). Khóa + sha phiên bản do DB TỰ TÍNH từ bản
--     ghi (khóa `bk:<sha256 bản dump>` — như bộ đếm Python `_backup_row`; sha
--     = sha256 của chính chuỗi bản ghi, = `rollout._rec_sha` dòng
--     backup_runs.jsonl). Bộ đếm đọc sổ: thời điểm = `captured_at` (đồng hồ
--     DB, không nhận mốc tự khai), phiên bản hiện hành = bản ghi MỚI NHẤT của
--     khóa, `is_sample` không đếm;
--   * ghi CHỈ qua function SECURITY DEFINER `file_output_evidence_backup`:
--     login phải là owner (dev) hoặc thành viên `svc_backup` và KHÔNG thuộc
--     role người/agent/loader/BKS (login người lỡ được cấp vào svc_backup vẫn
--     không tự tạo bằng chứng rồi tự duyệt); bản ghi phải là lần backup `ok`
--     đúng khuôn (sha256 bản dump, tên file dump không đường dẫn, ts có múi
--     giờ); trùng khóa + phiên bản → id cũ (idempotent). GRANT EXECUTE chỉ
--     `svc_backup` (roles.sql khối cùng tên) — app_human/agent_writer/
--     svc_loader/bks_reader không INSERT/UPDATE/DELETE, không EXECUTE;
--   * data_platform-07.2 đếm nguồn bảng `file_output_evidence` (source
--     backup_runs) thay nguồn file → `count_spec` (owner `rollout --seed`)
--     chứa câu đếm sổ: `output_pending_human`/`output_review_human`/cổng PL02
--     dùng CÙNG bộ đếm (khóa giả / sai sha / mẫu / phiên bản cũ / sai tính
--     năng → từ chối; ngưỡng số lượng áp lên số DB đếm). Backup trước bản vá
--     (chỉ có dòng jsonl) KHÔNG có bằng chứng → không đếm, không duyệt.
--   * convlog (sales-01, `cv:`) KHÔNG cần sổ này: câu bot gửi khách không
--     duyệt qua `output_reviews` (review=False — gửi thiếu người = `unapp`,
--     tự chặn cổng van_hanh); ngưỡng số lượng của sales-01 vẫn theo Python
--     (runbook 9.7). Nguồn file chưa có bằng chứng DB vẫn bị từ chối rõ ràng.
create table if not exists file_output_evidence (
  id bigint generated always as identity primary key,
  nguon text not null check (nguon in ('backup_runs')),
  output_key text not null check (output_key ~ '^bk:[0-9a-f]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ban_ghi text not null check (char_length(ban_ghi) between 2 and 4000),
  run_ts timestamptz not null,
  is_sample boolean not null default false,
  captured_at timestamptz not null default now(),
  captured_by text not null default session_user
);
create unique index if not exists file_output_evidence_version_uq
  on file_output_evidence (nguon, output_key, content_sha256);
create index if not exists file_output_evidence_ts_idx
  on file_output_evidence (nguon, captured_at);
create or replace trigger file_output_evidence_append_only_row
  before update or delete on file_output_evidence
  for each row execute function append_only_guard();
create or replace trigger file_output_evidence_no_truncate
  before truncate on file_output_evidence
  for each statement execute function append_only_guard();

create or replace function file_output_evidence_backup(p_rec text,
  p_is_sample boolean default false)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  j jsonb;
  v_ts timestamptz;
  v_key text;
  v_sha text;
  v_id bigint;
begin
  if not p10_owner_login() then
    if not exists (select 1 from pg_roles r where r.rolname = 'svc_backup'
                    and pg_has_role(session_user, r.oid, 'MEMBER')) then
      raise exception 'login % không phải dịch vụ backup (svc_backup) — chỉ tiến trình backup ghi bằng chứng đầu ra nguồn file',
        session_user using errcode = '42501';
    end if;
    if exists (select 1 from pg_roles r where r.rolname in ('app_human',
                 'agent_writer', 'svc_loader', 'svc_job', 'svc_webhook',
                 'bks_reader', 'ben_a_reader')
                 and pg_has_role(session_user, r.oid, 'MEMBER')) then
      raise exception 'login % thuộc role người/agent/loader/BKS — không tự tạo bằng chứng đầu ra (tách login dịch vụ backup riêng)',
        session_user using errcode = '42501';
    end if;
  end if;
  if p_rec is null or char_length(p_rec) not between 2 and 4000 then
    raise exception 'bản ghi backup rỗng hoặc quá dài';
  end if;
  begin
    j := p_rec::jsonb;
  exception when others then
    raise exception 'bản ghi backup không phải JSON';
  end;
  if jsonb_typeof(j) is distinct from 'object' then
    raise exception 'bản ghi backup phải là JSON object';
  end if;
  if j->>'status' is distinct from 'ok' then
    raise exception 'chỉ lần backup thành công (status ok) là đầu ra';
  end if;
  if coalesce(j->>'sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 bản dump sai khuôn';
  end if;
  if coalesce(j->>'file', '')
       !~ '^[A-Za-z0-9_-]+_[0-9]{8}_[0-9]{6}_vn\.dump(\.enc)?$' then
    raise exception 'tên file dump sai khuôn (không đường dẫn, không .partial)';
  end if;
  if coalesce(j->>'ts', '') !~ ('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
       || ':[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$') then
    raise exception 'ts bản ghi backup phải ISO 8601 có múi giờ';
  end if;
  begin
    v_ts := (j->>'ts')::timestamptz;
  exception when others then
    raise exception 'ts bản ghi backup không hợp lệ';
  end;
  v_key := 'bk:' || (j->>'sha256');
  v_sha := encode(sha256(convert_to(p_rec, 'UTF8')), 'hex');
  insert into file_output_evidence (nguon, output_key, content_sha256,
    ban_ghi, run_ts, is_sample)
  values ('backup_runs', v_key, v_sha, p_rec, v_ts,
          coalesce(p_is_sample, false))
  on conflict (nguon, output_key, content_sha256) do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from file_output_evidence e
     where e.nguon = 'backup_runs' and e.output_key = v_key
       and e.content_sha256 = v_sha;
  end if;
  return v_id;
end $$;
revoke execute on function file_output_evidence_backup(text, boolean)
  from public;

-- ===== docx P0 — cổng PL02 đếm lại trong DB, không tin số caller =====
-- (PL02 mục 1a–c; HĐ 6.3, 6.7, 7.2) Trước vá (nền 667f763):
--   (a) `rollout --promote` dưới login NGƯỜI (`in role app_human`) đếm đầu ra
--       bằng bộ đếm Python → 16 tính năng co_code có nguồn login người không
--       SELECT được (consents, audit_runs, recon_results, documents,
--       file_output_evidence...) → "không đếm được" → CLI chặn trước khi tới
--       function DB: người được ủy quyền không nâng được tính năng đủ cổng;
--   (b) `rollout_transition_human`: tính năng có nguồn `file` (sales-01 —
--       convlog chatbot) lấy ngưỡng ≥ 50 đầu ra / ≥ 5 ngày TỪ `p_evidence`
--       caller truyền → gọi thẳng SQL khai số là vượt cổng chạy thử.
-- Nay:
--   * `rollout_db_recount` = MỘT bộ đếm lại DB (ngày làm việc, đầu ra
--     DISTINCT, ngày có đầu ra, người duyệt, thiếu người, chưa duyệt, lỗi
--     nghiêm trọng) dùng chung cho function chuyển giai đoạn và
--     `rollout_recount_human` (CHỈ ĐỌC số đếm — CLI người hiển thị/kiểm cổng
--     khi login không đọc được bảng nguồn; DB vẫn là bên quyết);
--   * `rollout_transition_human` BỎ mọi ngưỡng dựa số caller khai — chỉ số DB
--     đếm lại; còn nguồn `file` trong `count_spec` (DB không đọc được) →
--     KHÔNG nâng (cần bằng chứng DB);
--   * sales-01: câu bot ĐÃ gửi khách thật có bằng chứng DB trong
--     `file_output_evidence` nguồn `conversations` (khóa `cv:<kênh>/<msg_id>`
--     — như bộ đếm Python `_conv_row`), ghi CHỈ qua
--     `file_output_evidence_chat` bởi login dịch vụ webhook (`svc_webhook`,
--     KHÔNG thuộc role người/loader/job/backup/BKS/Bên A) ngay sau khi gửi;
--     DB tự kiểm bản ghi (kênh zalo/messenger, đã trả lời + đã gửi +
--     guardrail đạt, provenance `live`, không cờ mẫu, msg_id, ts có múi giờ)
--     và chỉ lưu các trường đó (không câu khách/câu bot/user_hash).
alter table file_output_evidence
  drop constraint if exists file_output_evidence_nguon_check;
alter table file_output_evidence add constraint file_output_evidence_nguon_check
  check (nguon in ('backup_runs', 'conversations'));
alter table file_output_evidence
  drop constraint if exists file_output_evidence_output_key_check;
alter table file_output_evidence
  add constraint file_output_evidence_output_key_check
  check (output_key ~ '^bk:[0-9a-f]{64}$'
         or output_key ~ '^cv:(zalo|messenger)/[A-Za-z0-9._:-]{1,200}$');

create or replace function file_output_evidence_chat(p_rec text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  j jsonb;
  v_ts timestamptz;
  v_mid text;
  v_min text;
  v_key text;
  v_sha text;
  v_id bigint;
  k text;
begin
  if not p10_owner_login() then
    if not exists (select 1 from pg_roles r where r.rolname = 'svc_webhook'
                    and pg_has_role(session_user, r.oid, 'MEMBER')) then
      raise exception 'login % không phải dịch vụ webhook (svc_webhook) — chỉ tiến trình chatbot ghi bằng chứng câu bot đã gửi',
        session_user using errcode = '42501';
    end if;
    if exists (select 1 from pg_roles r where r.rolname in ('app_human',
                 'svc_loader', 'svc_job', 'svc_backup', 'bks_reader',
                 'ben_a_reader')
                 and pg_has_role(session_user, r.oid, 'MEMBER')) then
      raise exception 'login % thuộc role người/loader/job/backup/BKS — không tự tạo bằng chứng đầu ra chatbot',
        session_user using errcode = '42501';
    end if;
  end if;
  if p_rec is null or char_length(p_rec) not between 2 and 4000 then
    raise exception 'bản ghi chatbot rỗng hoặc quá dài';
  end if;
  begin
    j := p_rec::jsonb;
  exception when others then
    raise exception 'bản ghi chatbot không phải JSON';
  end;
  if jsonb_typeof(j) is distinct from 'object' then
    raise exception 'bản ghi chatbot phải là JSON object';
  end if;
  if j->>'channel' is null or j->>'channel' not in ('zalo', 'messenger') then
    raise exception 'kênh phải là zalo/messenger';
  end if;
  if j->'answered' is distinct from 'true'::jsonb
     or j->'sent' is distinct from 'true'::jsonb
     or j->'guardrail_ok' is distinct from 'true'::jsonb then
    raise exception 'chỉ câu bot đã trả lời + đã gửi + guardrail đạt là đầu ra';
  end if;
  if j->>'provenance' is distinct from 'live' then
    raise exception 'chỉ provenance live (transport kênh thật) là đầu ra';
  end if;
  foreach k in array array['is_sample', 'dry_run', 'replay', 'mock', 'test']
  loop
    if j ? k and j->k not in ('null'::jsonb, 'false'::jsonb) then
      raise exception 'bản ghi mang cờ mẫu % — không phải đầu ra thật', k;
    end if;
  end loop;
  v_mid := btrim(coalesce(j->>'msg_id', ''));
  if v_mid !~ '^[A-Za-z0-9._:-]{1,200}$' then
    raise exception 'msg_id rỗng hoặc sai khuôn';
  end if;
  if coalesce(j->>'ts', '') !~ ('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
       || ':[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$') then
    raise exception 'ts bản ghi chatbot phải ISO 8601 có múi giờ';
  end if;
  begin
    v_ts := (j->>'ts')::timestamptz;
  exception when others then
    raise exception 'ts bản ghi chatbot không hợp lệ';
  end;
  -- lưu TỐI THIỂU (không câu khách/câu bot/user_hash) — đủ để truy vết khóa.
  v_min := jsonb_build_object('channel', j->>'channel', 'msg_id', v_mid,
    'ts', j->>'ts', 'answered', true, 'sent', true, 'guardrail_ok', true,
    'provenance', 'live')::text;
  v_key := 'cv:' || (j->>'channel') || '/' || v_mid;
  v_sha := encode(sha256(convert_to(v_min, 'UTF8')), 'hex');
  insert into file_output_evidence (nguon, output_key, content_sha256,
    ban_ghi, run_ts, is_sample)
  values ('conversations', v_key, v_sha, v_min, v_ts, false)
  on conflict (nguon, output_key, content_sha256) do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from file_output_evidence e
     where e.nguon = 'conversations' and e.output_key = v_key
       and e.content_sha256 = v_sha;
  end if;
  return v_id;
end $$;
revoke execute on function file_output_evidence_chat(text) from public;

-- Bộ đếm lại DB của 1 tính năng trong [p_since, p_now] (cùng nguồn số với
-- `rollout_db_facts`) — KHÔNG grant (chỉ chạy trong function SECURITY DEFINER).
create or replace function rollout_db_recount(p_fid text, p_spec jsonb,
  p_since timestamptz, p_now timestamptz)
returns jsonb
language sql stable set search_path from current as $$
  select jsonb_build_object(
    'days', rollout_business_days(p_since, p_now, p_spec),
    'outputs', count(*),
    'out_days', count(distinct p10_vn_date(f.ts)) filter (
                  where rollout_workday(p10_vn_date(f.ts), p_spec)),
    'human', count(*) filter (where f.human),
    'unapproved', count(*) filter (where f.unapp),
    'unreviewed', count(*) filter (where f.unrev),
    'file_sources', coalesce((p_spec->>'file')::int, 0),
    'severe', (select count(*) from feature_rollout_events e
                where e.feature_id = p_fid and e.kind = 'severe'
                  and e.ts >= p_since))
    from rollout_db_facts(p_fid, p_spec, p_since, p_now) f
$$;
revoke execute on function rollout_db_recount(text, jsonb, timestamptz,
  timestamptz) from public;

-- CHỈ ĐỌC số đếm của giai đoạn hiện hành cho CLI người (`rollout
-- --promote/--status` khi login không SELECT được bảng nguồn). Không ghi gì;
-- quyết định vẫn ở `rollout_transition_human`.
create or replace function rollout_recount_human(p_fid text)
returns jsonb
language plpgsql stable security definer set search_path from current as $$
declare
  r feature_rollout%rowtype;
begin
  select * into r from feature_rollout where feature_id = p_fid;
  if not found then
    return null;
  end if;
  if r.count_spec is null
     or jsonb_typeof(r.count_spec->'sql') is distinct from 'array' then
    return jsonb_build_object('stage', r.stage, 'has_spec', false);
  end if;
  return rollout_db_recount(p_fid, r.count_spec, r.stage_since, now())
         || jsonb_build_object('stage', r.stage, 'has_spec', true,
              'sql_sources', jsonb_array_length(r.count_spec->'sql'));
end $$;
revoke execute on function rollout_recount_human(text) from public;

create or replace function rollout_transition_human(p_fid text, p_kind text,
  p_from text, p_to text, p_by text, p_code text, p_note text,
  p_evidence jsonb, p_now timestamptz)
returns text
language plpgsql security definer set search_path from current as $$
declare
  v_block text := regexp_replace(coalesce(p_fid, ''), '-.*$', '');
  v_by text := human_actor(p_by, v_block);
  v_now timestamptz := p10_now(p_now);
  v_stage text;
  v_since timestamptz;
  v_to text;
  v_owner boolean := p10_owner_login();
  v_min int;
  e jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_spec jsonb;
  c jsonb;
begin
  select stage, stage_since, count_spec into v_stage, v_since, v_spec
    from feature_rollout where feature_id = p_fid for update;
  if not found then
    raise exception '%: chưa vào sổ triển khai (chạy --seed)', p_fid;
  end if;
  if v_stage is distinct from p_from then
    raise exception '%: giai đoạn vừa đổi (% ≠ %) — thử lại', p_fid, v_stage,
      p_from;
  end if;
  if p_kind = 'promote' then
    -- tắt → bật lại = về chạy thử (đếm lại từ đầu, không điều kiện).
    v_to := case v_stage when 'chay_thu' then 'co_nguoi_duyet'
                         when 'co_nguoi_duyet' then 'van_hanh'
                         when 'tat' then 'chay_thu' end;
    if v_to is null or v_to is distinct from p_to then
      raise exception '%: không nâng được % → %', p_fid, v_stage, p_to;
    end if;
    if not v_owner and v_stage <> 'tat' then
      -- docx P0: CHỈ số DB đếm lại; `p_evidence` của caller chỉ để lưu vết.
      v_min := case v_stage when 'chay_thu' then 5 else 10 end;
      if p10_vn_date(v_now) - p10_vn_date(v_since) < v_min then
        raise exception '%: chưa đủ số ngày tối thiểu của giai đoạn %', p_fid,
          v_stage;
      end if;
      if v_spec is null or jsonb_typeof(v_spec->'sql') is distinct from 'array'
      then
        raise exception '%: bộ đếm đầu ra chưa đồng bộ vào DB — owner chạy rollout --seed rồi thử lại',
          p_fid;
      end if;
      c := rollout_db_recount(p_fid, v_spec, v_since, v_now);
      e := e || jsonb_build_object('db_recount', c);
      if (c->>'severe')::int > 0 then
        raise exception '%: có lỗi nghiêm trọng từ mốc giai đoạn — không nâng',
          p_fid;
      end if;
      if (c->>'file_sources')::int > 0 then
        raise exception '%: nguồn file chưa có bằng chứng DB — không nâng (đổi nguồn sang sổ DB rồi owner chạy rollout --seed)',
          p_fid;
      end if;
      if jsonb_array_length(v_spec->'sql') = 0 then
        raise exception '%: DB đếm lại: không có nguồn đầu ra đếm được — không nâng',
          p_fid;
      end if;
      if (c->>'days')::int < v_min then
        raise exception '%: DB đếm lại: mới % / % ngày làm việc của giai đoạn %',
          p_fid, c->>'days', v_min, v_stage;
      end if;
      if v_stage = 'chay_thu' and not ((c->>'outputs')::int >= 50
          and (c->>'out_days')::int >= 5) then
        raise exception '%: DB đếm lại chưa đạt PL02 (% đầu ra / % ngày làm việc; cần ≥ 50 / ≥ 5)',
          p_fid, c->>'outputs', c->>'out_days';
      end if;
      if v_stage = 'co_nguoi_duyet' and ((c->>'unapproved')::int > 0
          or (c->>'unreviewed')::int > 0 or (c->>'outputs')::int < 1
          or (c->>'human')::int < 1) then
        raise exception '%: DB đếm lại chưa đạt PL02 (% đầu ra, % người duyệt, % thiếu người, % chưa duyệt)',
          p_fid, c->>'outputs', c->>'human', c->>'unapproved',
          c->>'unreviewed';
      end if;
    end if;
  elsif p_kind = 'severe' then
    if p_code is null or p_code not in ('tu_cam', 'ruou_cong_khai',
        'tpbvsk_chua_xnqc', 'thieu_khuyen_cao', 'thieu_nhan_ai', 'lo_pii',
        'so_lieu_khong_nguon') then
      raise exception 'mã lỗi nghiêm trọng lạ: %', p_code;
    end if;
    v_to := case when v_stage = 'tat' then 'tat' else 'chay_thu' end;
  elsif p_kind = 'disable' then
    if v_stage = 'tat' then
      raise exception '%: đã tắt', p_fid;
    end if;
    v_to := 'tat';
  else
    raise exception 'loại thao tác lạ: %', p_kind;
  end if;
  if p_to is distinct from v_to then
    raise exception '%: đích % không hợp lệ (đúng: %)', p_fid, p_to, v_to;
  end if;
  insert into feature_rollout_events (ts, feature_id, kind, from_stage,
    to_stage, severe_code, note, evidence, by_person)
  values (v_now, p_fid, p_kind, v_stage, v_to,
          case when p_kind = 'severe' then p_code end, p_note, e, v_by);
  if not (p_kind = 'severe' and v_stage = 'tat') then
    update feature_rollout set stage = v_to, stage_since = v_now,
           updated_by = v_by, updated_at = v_now
     where feature_id = p_fid;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'rollout_' || p_kind, 'feature_rollout', p_fid,
          jsonb_build_object('from', v_stage, 'to', v_to, 'code', p_code));
  return v_to;
end $$;
revoke execute on function rollout_transition_human(text, text, text, text,
  text, text, text, jsonb, timestamptz) from public;

-- ===== docx P0c — danh tính NGƯỜI theo login ở mọi dòng ghi tên người =====
-- (HĐ 6.7, 7.2, 7.6; PL01 mục 8; PL02 mục 1b) Trước vá: function quyết định
-- có trước v15 (`decide_item`, `override_qa`, `approve_draft`/`reject_draft`/
-- `schedule_draft`, `approve_cogs`, `decide_allocation_run`,
-- `record_lot_intake`, `sign_qr_lot`, `issue_qr`/`revoke_qr`,
-- `link_lot_origin`/`unlink_lot_origin`) nhận TÊN người làm tham số, và
-- `app_human` INSERT thẳng cột tên người ở `red_alert_acks.acked_by`,
-- `san_suggestion_uses.used_by`, `ops_incidents.created_by`,
-- `ops_incident_events.by_name`, `cogs_versions.created_by` (+ kế thừa INSERT
-- `agent_action_log` từ agent_writer) → login của người A gọi thẳng psql ghi
-- được quyết định/nhật ký mang tên người B (runbook 9.7 "rủi ro còn lại").
-- Nay trigger `person_login_guard` (BEFORE INSERT) trên các bảng đó: khi
-- login là NGƯỜI (thành viên `app_human`, KHÔNG thuộc `svc_ui`, không owner)
-- và cột tên là người (không `agent:`/`system:`/`auto_policy:` — dòng của
-- luồng agent giữ nguyên) → bắt buộc `human_actor(tên, khối)`: login phải ánh
-- xạ đúng người trong `human_logins`; quyết định hàng duyệt chung kiểm thêm
-- khối của mục (`approval_queue.block`), phân bổ/kiểm nhập lô → production,
-- duyệt giá vốn → finance. Sai → 42501, cả function rollback (không ghi dở).
-- Ngoại lệ: dòng `authz_denied` (CLI ghi lần BỊ từ chối kèm tên tự khai — là
-- bằng chứng lần thử, không phải quyết định).
-- `svc_ui` (roles.sql): role của tiến trình Streamlit ĐÃ xác thực người dùng
-- theo phiên (AUTH_MODE local/proxy, `auth.authorize` ở Python) — DB tin tên
-- UI truyền (như trước). Login người KHÔNG được cấp `svc_ui`.
create or replace function person_login() returns boolean
language sql stable security definer set search_path from current as $$
  select exists (select 1 from pg_roles r where r.rolname = 'app_human'
                   and pg_has_role(session_user, r.oid, 'MEMBER'))
     and not coalesce((select pg_has_role(session_user, r.oid, 'MEMBER')
                         from pg_roles r where r.rolname = 'svc_ui'), false)
     and not p10_owner_login()
$$;
revoke execute on function person_login() from public;

create or replace function person_login_guard() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_who text := to_jsonb(new)->>tg_argv[0];
  v_block text;
begin
  if not person_login() or not p10_is_person(v_who) then
    return new;
  end if;
  if tg_table_name = 'agent_action_log' then
    if new.action = 'authz_denied' then
      return new;
    end if;
    v_block := case
      when new.action in ('queue_approve', 'queue_reject', 'queue_override_qa')
        then (select a.block from approval_queue a
               where a.id = (new.detail->>'queue_id')::bigint)
      when new.action in ('alloc_approve', 'alloc_reject', 'lot_intake')
        then 'production'
      when new.action = 'cogs_approve' then 'finance' end;
  end if;
  perform human_actor(v_who, v_block);
  return new;
end $$;
revoke execute on function person_login_guard() from public;

create or replace trigger agent_action_log_person_login
  before insert on agent_action_log
  for each row execute function person_login_guard('actor');
create or replace trigger red_alert_acks_person_login
  before insert on red_alert_acks
  for each row execute function person_login_guard('acked_by');
create or replace trigger san_suggestion_uses_person_login
  before insert on san_suggestion_uses
  for each row execute function person_login_guard('used_by');
create or replace trigger ops_incidents_person_login
  before insert on ops_incidents
  for each row execute function person_login_guard('created_by');
create or replace trigger ops_incident_events_person_login
  before insert on ops_incident_events
  for each row execute function person_login_guard('by_name');
create or replace trigger cogs_versions_person_login
  before insert on cogs_versions
  for each row execute function person_login_guard('created_by');

-- ===== docx R1/R2 — quyết định người không ghi bằng tên agent; quyền QR =====
-- (HĐ 6.7, 7.2) Controller tái hiện trên working tree đợt DOCX:
--   R1: login NGƯỜI (app_human, chỉ khối sales) gọi thẳng
--       `record_lot_intake(lô, 'passed', 'agent:controller', null)` → lô
--       passed, `checked_by` tên giả: `person_login_guard` bỏ qua kiểm khi
--       tên không phải "người" (ngoại lệ luồng agent thành đường thoát).
--   R2: cùng login gọi `revoke_qr` bằng tên CHÍNH mình → mã QR bị thu hồi:
--       trigger chỉ kiểm danh tính, không kiểm quyền QR.
-- Nay:
--   * action QUYẾT ĐỊNH của người (DECISION — kiểm nhập lô, phân bổ, hàng duyệt
--     chung, giá vốn, nháp nội dung, ký/phát hành/thu hồi/ánh xạ QR): MỌI
--     login không owner (gồm `svc_ui`) không ghi bằng tên agent/hệ thống/
--     auto_policy (so sau NFKC: 'AGENT :', 'agent：' cũng chặn); login người
--     LUÔN qua `human_actor` (đúng người + khối) — không còn ngoại lệ;
--   * ký QR (`qr_lot_sign`) đòi login có ĐÚNG vai ký, phát hành/thu hồi QR
--     (`qr_issue`/`qr_revoke`) đòi login có một vai QR — sổ `human_qr_roles`
--     (login ↔ vai, CHỈ owner ghi, mirror `data/qr_signers.json`, 1 login ≤ 1
--     vai đang hiệu lực, mỗi lần đổi ghi `human_qr_role_change`; repo TRỐNG
--     — Bên B điền theo văn bản ủy quyền). Ánh xạ lô ↔ nhật ký (link/unlink)
--     = nhập liệu: danh tính theo login (như trước, không đòi vai);
--   * dòng không phải quyết định của luồng agent (`queue_enqueue`, ghi chú…)
--     giữ nguyên; `authz_denied` vẫn ghi được (bằng chứng lần thử, không
--     đổi nghiệp vụ). `svc_ui` vẫn được tin tên NGƯỜI do UI truyền (phiên đã
--     xác thực ở Python) — DB KHÔNG ràng buộc tên đó với login người.
create table if not exists human_qr_roles (
  db_login text not null check (db_login ~ '^[a-z_][a-z0-9_$]{0,62}$'),
  role text not null check (role in ('gd_san_xuat', 'gd_vung_trong',
                                     'phap_che_qa')),
  active boolean not null default true,
  granted_by text not null check (btrim(granted_by) <> ''),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (db_login, role)
);
create unique index if not exists human_qr_roles_one_active_uq
  on human_qr_roles (db_login) where active;

create or replace function human_qr_roles_audit() returns trigger
language plpgsql security definer set search_path from current as $$
begin
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (coalesce(case when tg_op = 'DELETE' then old.granted_by
                        else new.granted_by end, session_user::text),
          'human_qr_role_change', 'human_login',
          case when tg_op = 'DELETE' then old.db_login else new.db_login end,
          jsonb_build_object('op', tg_op,
            'old', case when tg_op = 'INSERT' then null else jsonb_build_object(
              'role', old.role, 'active', old.active) end,
            'new', case when tg_op = 'DELETE' then null else jsonb_build_object(
              'role', new.role, 'active', new.active) end));
  return null;
end $$;
revoke execute on function human_qr_roles_audit() from public;
create or replace trigger human_qr_roles_audit_row
  after insert or update or delete on human_qr_roles
  for each row execute function human_qr_roles_audit();

create or replace function person_login_guard() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_who text := to_jsonb(new)->>tg_argv[0];
  v_decision boolean := false;
  v_block text;
  v_role text;
begin
  if tg_table_name = 'agent_action_log' then
    if new.action = 'authz_denied' then
      return new;
    end if;
    v_decision := new.action = any(array['lot_intake', 'alloc_approve',
      'alloc_reject', 'queue_approve', 'queue_reject', 'queue_override_qa',
      'cogs_approve', 'draft_approve', 'draft_reject', 'draft_schedule',
      'qr_lot_sign', 'qr_issue', 'qr_revoke', 'qr_lot_link',
      'qr_lot_unlink']);
  end if;
  if p10_owner_login() then
    return new;
  end if;
  if v_decision and (btrim(coalesce(v_who, '')) = ''
      or normalize(v_who, NFKC) ~* '^\s*(agent|system|auto_policy)\s*:') then
    raise exception 'quyết định của người không ghi bằng tên agent/hệ thống (%)',
      left(coalesce(v_who, ''), 40) using errcode = '42501';
  end if;
  if not person_login() or (not v_decision and not p10_is_person(v_who)) then
    return new;
  end if;
  if tg_table_name = 'agent_action_log' then
    v_block := case
      when new.action in ('queue_approve', 'queue_reject', 'queue_override_qa')
        then (select a.block from approval_queue a
               where a.id = (new.detail->>'queue_id')::bigint)
      when new.action in ('alloc_approve', 'alloc_reject', 'lot_intake')
        then 'production'
      when new.action = 'cogs_approve' then 'finance' end;
  end if;
  perform human_actor(v_who, v_block);
  if v_decision then         -- (lồng: bảng khác không có cột action)
    if new.action in ('qr_lot_sign', 'qr_issue', 'qr_revoke') then
      v_role := case when new.action = 'qr_lot_sign'
                     then coalesce(new.detail->>'role', '?') end;
      if not exists (select 1 from human_qr_roles r
                      where r.db_login = session_user and r.active
                        and (v_role is null or r.role = v_role)) then
        raise exception 'login % không có vai QR % (human_qr_roles — Bên B điền theo văn bản ủy quyền)',
          session_user, coalesce(v_role, '(bất kỳ)') using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function person_login_guard() from public;

-- ===== docx vòng 2 — provenance dữ kiện KPI chat =====
-- (PL02 mục 3, HĐ 7.3) `chat_kpi_facts` (v13.7) chụp convlog KHÔNG kèm
-- provenance → dòng chụp trước bản lọc live (đợt DOCX) có thể là mock/demo/
-- dòng cũ; `ops_monthly.merge_chat` vẫn gộp vào KPI vận hành. Không sửa/xóa
-- dòng cũ (append-only, không mặc định chúng là live): sổ MỚI append-only
-- `chat_kpi_live` = dữ kiện CÓ bằng chứng — chỉ ghi từ dòng convlog
-- `provenance: live` (transport kênh thật, `lead_store.conv_kind`), khóa
-- `qkey` + sha256 nội dung dữ kiện (`fact_sha256`) nên dòng cũ cùng `qkey`
-- không che dòng live. KPI vận hành CHỈ đọc sổ này (+ convlog live đang có);
-- `chat_kpi_facts` cũ không có bản live tương ứng = UNKNOWN/chưa xác minh,
-- báo riêng. Tái xác minh dòng cũ = convlog live còn giữ CÙNG khóa → lần
-- `--snapshot` sau ghi bản live (từ chính dòng convlog, không suy từ ngày/id).
create table if not exists chat_kpi_live (
  qkey text not null check (qkey ~ '^[0-9a-f]{64}$'),
  fact_sha256 text not null check (fact_sha256 ~ '^[0-9a-f]{64}$'),
  ts timestamptz not null,
  channel text,
  is_question boolean not null,
  handled_by_bot boolean,
  group_oid text,
  reply_ms integer check (reply_ms is null or reply_ms >= 0),
  evidence text not null check (evidence = 'convlog_live'),
  captured_at timestamptz not null default now(),
  captured_by text not null default session_user,
  primary key (qkey, fact_sha256)
);
create index if not exists chat_kpi_live_ts_idx on chat_kpi_live (ts);
create or replace trigger chat_kpi_live_append_only_row
  before update or delete on chat_kpi_live
  for each row execute function append_only_guard();
create or replace trigger chat_kpi_live_no_truncate
  before truncate on chat_kpi_live
  for each statement execute function append_only_guard();

-- Đợt hợp đồng C02 (farming-02, PL01 Vùng trồng "nhắc khoảnh lâu không có
-- nhật ký; báo giám đốc nếu vẫn bỏ trống"): sổ NHẮC theo đợt — 1 dòng /
-- khoảnh / đợt (`dot_key` = mốc nhật ký gần nhất UTC | 'none'). Người phụ
-- trách = MÃ nhân viên (không tên). `status` lúc tạo: khong_nguoi_nhan (khoảnh
-- chưa gán người) | cho_kenh (chưa chọn kênh nhắc — data/garden_remind.json)
-- | cho_gui (kênh thủ công: người nhắc theo danh sách). "Đã nhắc" CHỈ ghi qua
-- `garden_reminder_done_human` (người thật, khối farming) — agent không bao
-- giờ ghi đã nhắc; job chỉ chèn + đóng đợt (`closed_at`) khi có nhật ký mới.
create table if not exists garden_reminders (
  id bigint generated always as identity primary key,
  plot_id text not null,
  dot_key text not null check (dot_key ~ '^(none|[0-9]{8}T[0-9]{6})$'),
  kind text not null check (kind in ('no-logs', 'gap')),
  ma_nv text check (ma_nv is null or ma_nv ~ '^[A-Za-z0-9._-]{1,32}$'),
  status text not null
    check (status in ('khong_nguoi_nhan', 'cho_kenh', 'cho_gui')),
  kenh text,
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  reminded_at timestamptz,
  reminded_by text,
  closed_at timestamptz,
  unique (plot_id, dot_key),
  check ((status = 'khong_nguoi_nhan') = (ma_nv is null)),
  check ((reminded_at is null) = (reminded_by is null))
);

create or replace function garden_reminder_done_human(p_id bigint,
  p_by text)
returns boolean
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  n int;
begin
  update garden_reminders set reminded_at = now(), reminded_by = v_by
   where id = p_id and status = 'cho_gui' and reminded_at is null
     and closed_at is null;
  get diagnostics n = row_count;
  if n <> 1 then
    return false;
  end if;
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'garden_reminder_done', 'garden_reminder', p_id::text,
          jsonb_build_object('reminder_id', p_id));
  return true;
end $$;
revoke execute on function garden_reminder_done_human(bigint, text)
  from public;

-- Đợt hợp đồng C03 (production-04.1, PL01 Sản xuất "hồ sơ lô: mã lô, hạn
-- dùng, PHIẾU KIỂM NGHIỆM"): sổ phiếu kiểm nghiệm gắn ĐÚNG lô — số phiếu,
-- nơi cấp, ngày cấp, sha256 + đuôi tệp (tệp ở kho LOT_CERT_DIR NGOÀI repo,
-- lưu theo hash, không ghi đè). Append-only; đổi phiếu = PHIÊN BẢN mới (bản
-- cũ giữ). Ghi CHỈ qua `lot_cert_record_human` (người khối production, danh
-- tính theo login). Lô cũ không có dòng = THIẾU phiếu (không tự tạo).
create table if not exists lot_test_certificates (
  id bigint generated always as identity primary key,
  lot_code text not null references production_lots (lot_code),
  version int not null check (version >= 1),
  cert_no text not null check (btrim(cert_no) <> '' and length(cert_no) <= 64),
  lab text check (lab is null or length(lab) <= 120),
  issued_on date,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_ext text not null check (file_ext in ('pdf', 'jpg', 'png')),
  recorded_by text not null check (btrim(recorded_by) <> ''),
  recorded_at timestamptz not null default now(),
  is_sample boolean not null default false,
  note text check (note is null or length(note) <= 500),
  unique (lot_code, version),
  unique (lot_code, file_sha256)
);
create or replace trigger lot_test_certificates_append_only_row
  before update or delete on lot_test_certificates
  for each row execute function append_only_guard();
create or replace trigger lot_test_certificates_no_truncate
  before truncate on lot_test_certificates
  for each statement execute function append_only_guard();

create or replace function lot_cert_record_human(p_lot text, p_cert_no text,
  p_lab text, p_issued date, p_sha text, p_ext text, p_note text, p_by text)
returns integer
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'production');
  v_src text;
  v_ver int;
begin
  select source into v_src from production_lots where lot_code = p_lot
    for update;
  if not found then
    raise exception 'lô % không tồn tại', p_lot;
  end if;
  if exists (select 1 from lot_test_certificates where lot_code = p_lot
              and file_sha256 = p_sha) then
    raise exception 'tệp phiếu này đã ghi cho lô %', p_lot;
  end if;
  select coalesce(max(version), 0) + 1 into v_ver
    from lot_test_certificates where lot_code = p_lot;
  insert into lot_test_certificates (lot_code, version, cert_no, lab,
    issued_on, file_sha256, file_ext, recorded_by, is_sample, note)
  values (p_lot, v_ver, btrim(p_cert_no), nullif(btrim(p_lab), ''), p_issued,
          p_sha, p_ext, v_by, v_src = 'sample', p_note);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'lot_cert_record', 'production_lot', p_lot,
          jsonb_build_object('version', v_ver, 'file_sha256', p_sha));
  return v_ver;
end $$;
revoke execute on function lot_cert_record_human(text, text, text, date,
  text, text, text, text) from public;

-- Đợt hợp đồng C10 (production-01, PL01 Sản xuất "báo cáo tuần, tháng về
-- tồn kho, lô, TIẾN ĐỘ"): nguồn tiến độ trước đây không có. Kế hoạch sản
-- xuất (SKU, số lượng, khung ngày) do NGƯỜI khối production ghi; lô gắn vào
-- kế hoạch TƯỜNG MINH (1 lô ≤ 1 kế hoạch). Tiến độ = Σ số lượng lô đã gắn
-- (đạt kiểm nhập / chờ) so với kế hoạch — không suy từ số lô/pass-fail khi
-- chưa có kế hoạch. Append-only; sửa kế hoạch = mã mới + ghi chú.
create table if not exists production_plans (
  plan_code text primary key check (plan_code ~ '^[A-Za-z0-9._-]{1,40}$'),
  sku_key text not null,
  qty_plan int not null check (qty_plan > 0),
  start_date date not null,
  due_date date not null,
  note text check (note is null or length(note) <= 500),
  recorded_by text not null check (btrim(recorded_by) <> ''),
  recorded_at timestamptz not null default now(),
  is_sample boolean not null default false,
  check (due_date >= start_date)
);
create table if not exists production_plan_lots (
  lot_code text primary key references production_lots (lot_code),
  plan_code text not null references production_plans (plan_code),
  linked_by text not null check (btrim(linked_by) <> ''),
  linked_at timestamptz not null default now()
);
create or replace trigger production_plans_append_only_row
  before update or delete on production_plans
  for each row execute function append_only_guard();
create or replace trigger production_plans_no_truncate
  before truncate on production_plans
  for each statement execute function append_only_guard();
create or replace trigger production_plan_lots_append_only_row
  before update or delete on production_plan_lots
  for each row execute function append_only_guard();
create or replace trigger production_plan_lots_no_truncate
  before truncate on production_plan_lots
  for each statement execute function append_only_guard();

create or replace function production_plan_add_human(p_code text,
  p_sku text, p_qty int, p_start date, p_due date, p_note text,
  p_sample boolean, p_by text)
returns boolean
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'production');
begin
  insert into production_plans (plan_code, sku_key, qty_plan, start_date,
    due_date, note, recorded_by, is_sample)
  values (p_code, p_sku, p_qty, p_start, p_due, p_note, v_by,
          coalesce(p_sample, false));
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'production_plan_add', 'production_plan', p_code,
          jsonb_build_object('sku', p_sku, 'qty', p_qty));
  return true;
end $$;
revoke execute on function production_plan_add_human(text, text, int, date,
  date, text, boolean, text) from public;

create or replace function production_plan_link_human(p_plan text,
  p_lot text, p_by text)
returns boolean
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'production');
  v_plan_sku text;
  v_lot_sku text;
begin
  select sku_key into v_plan_sku from production_plans where plan_code = p_plan;
  if not found then
    raise exception 'kế hoạch % không tồn tại', p_plan;
  end if;
  select sku_key into v_lot_sku from production_lots where lot_code = p_lot;
  if not found then
    raise exception 'lô % không tồn tại', p_lot;
  end if;
  if v_lot_sku <> v_plan_sku then
    raise exception 'lô % (%) khác SKU kế hoạch % (%)', p_lot, v_lot_sku,
      p_plan, v_plan_sku;
  end if;
  insert into production_plan_lots (lot_code, plan_code, linked_by)
  values (p_lot, p_plan, v_by);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'production_plan_link', 'production_plan', p_plan,
          jsonb_build_object('lot', p_lot));
  return true;
end $$;
revoke execute on function production_plan_link_human(text, text, text)
  from public;

-- Đợt hợp đồng C05 (ceo-02, PL01 Ban TGĐ "việc nào chờ ký"): mốc cần VĂN
-- BẢN có chữ ký (từ data/projects/milestones.json `can_ky`). Chưa `xong`
-- (xong đòi `evidence` — CHECK sẵn có) = chờ ký; không suy "đã ký".
alter table project_milestones
  add column if not exists sign_required boolean not null default false;

-- Đợt hợp đồng C07 (farming-04, PL01 Vùng trồng "kho tư liệu vườn: ảnh,
-- video thật đã xóa GPS, CẤP CHO MARKETING"): NGƯỜI khối farming cấp/thu hồi
-- từng tư liệu cho Marketing (append-only; trạng thái = sự kiện mới nhất).
-- Marketing chỉ đọc view `v_garden_media_marketing` (sha, loại, kích thước,
-- ngày chụp, ngày cấp) — KHÔNG khoảnh/tác giả/nguồn; tệp lấy qua CLI kiểm
-- hash + kiểm lại không EXIF/GPS (scripts/garden_media_mkt.py).
create table if not exists garden_media_releases (
  id bigint generated always as identity primary key,
  sha256 text not null references garden_media (sha256),
  action text not null check (action in ('cap', 'thu_hoi')),
  purpose text not null default 'marketing' check (purpose = 'marketing'),
  by_person text not null check (btrim(by_person) <> ''),
  at timestamptz not null default now(),
  note text check (note is null or length(note) <= 300)
);
create index if not exists garden_media_releases_sha_idx
  on garden_media_releases (sha256, id);
create or replace trigger garden_media_releases_append_only_row
  before update or delete on garden_media_releases
  for each row execute function append_only_guard();
create or replace trigger garden_media_releases_no_truncate
  before truncate on garden_media_releases
  for each statement execute function append_only_guard();

create or replace function garden_media_release_human(p_sha text,
  p_action text, p_by text, p_note text)
returns boolean
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  v_cur text;
begin
  if p_action not in ('cap', 'thu_hoi') then
    raise exception 'action phải cap|thu_hoi';
  end if;
  if not exists (select 1 from garden_media where sha256 = p_sha) then
    raise exception 'tư liệu % không có trong kho', left(p_sha, 12);
  end if;
  select action into v_cur from garden_media_releases where sha256 = p_sha
    order by id desc limit 1;
  if coalesce(v_cur, 'thu_hoi') = p_action then
    return false;            -- đã ở trạng thái đó — không ghi lặp
  end if;
  insert into garden_media_releases (sha256, action, by_person, note)
  values (p_sha, p_action, v_by, p_note);
  insert into agent_action_log (actor, action, object_type, object_id, detail)
  values (v_by, 'garden_media_' || p_action, 'garden_media', left(p_sha, 12),
          jsonb_build_object('sha256', p_sha));
  return true;
end $$;
revoke execute on function garden_media_release_human(text, text, text, text)
  from public;

create or replace view v_garden_media_marketing as
  select m.sha256, m.ext, m.bytes, m.width, m.height, m.taken_on,
         r.at as released_at
    from garden_media m
    join lateral (select action, at from garden_media_releases g
                   where g.sha256 = m.sha256 order by g.id desc limit 1) r
      on r.action = 'cap'
   where m.source not like 'sample:%';

-- ===== Đợt an toàn S04 (22/10/2026): danh tính quyết định gắn LOGIN =====
-- (HĐ 6.7, 7.2) Trước: `person_login()` MIỄN kiểm cho `svc_ui` — login UI
-- DÙNG CHUNG gọi thẳng `decide_item`/`approve_draft`/`schedule_draft` hoặc
-- INSERT log quyết định mang tên BẤT KỲ người nào (DB tin tên UI truyền); DB
-- cũng không kiểm KHỐI khi duyệt draft nội dung (khối chỉ kiểm ở Python).
-- Nay:
--   * `svc_ui` KHÔNG còn được miễn: mọi login không owner thuộc `app_human`
--     (gồm `svc_ui`) ghi tên người → `human_actor` (login phải ánh xạ đúng
--     người trong `human_logins`). Login UI dùng chung không ánh xạ người →
--     KHÔNG ghi được quyết định/nhật ký mang tên người. UI chế độ thực ghi
--     quyết định bằng login Postgres RIÊNG của người dùng
--     (`pipelines.auth.person_connect` — Postgres xác thực mật khẩu của
--     chính người đó; UI không giữ mật khẩu);
--   * draft nội dung có cột `block` (khối sở hữu — code tính từ danh mục lúc
--     tạo, `store._draft_block`; không ai UPDATE được sau khi tạo — không có
--     grant UPDATE); duyệt/từ chối/xếp lịch draft kiểm khối ở DB. Draft cũ
--     `block` null → 'marketing' (đúng mặc định Python). Người tạo tự rút
--     (từ chối draft của chính mình) không kiểm khối;
--   * `human_whoami()` — người + khối của login đang dùng (UI hiển thị/đối
--     chiếu phiên; chỉ đọc dòng của chính login).
-- (không CHECK: drift-guard chỉ cho add column 1 hành động; giá trị lạ → không
-- người nào có khối đó trong `human_logins` → duyệt bị chặn = fail-closed)
alter table content_drafts add column if not exists block text;

create or replace function person_login() returns boolean
language sql stable security definer set search_path from current as $$
  select exists (select 1 from pg_roles r where r.rolname = 'app_human'
                   and pg_has_role(session_user, r.oid, 'MEMBER'))
     and not p10_owner_login()
$$;
revoke execute on function person_login() from public;

create or replace function human_whoami()
returns table (person text, blocks text[])
language sql stable security definer set search_path from current as $$
  select btrim(h.person), h.blocks from human_logins h
   where h.db_login = session_user and h.active
$$;
revoke execute on function human_whoami() from public;

create or replace function person_login_guard() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_who text := to_jsonb(new)->>tg_argv[0];
  v_decision boolean := false;
  v_block text;
  v_role text;
begin
  if tg_table_name = 'agent_action_log' then
    if new.action = 'authz_denied' then
      return new;
    end if;
    v_decision := new.action = any(array['lot_intake', 'alloc_approve',
      'alloc_reject', 'queue_approve', 'queue_reject', 'queue_override_qa',
      'cogs_approve', 'draft_approve', 'draft_reject', 'draft_schedule',
      'qr_lot_sign', 'qr_issue', 'qr_revoke', 'qr_lot_link',
      'qr_lot_unlink']);
  end if;
  if p10_owner_login() then
    return new;
  end if;
  if v_decision and (btrim(coalesce(v_who, '')) = ''
      or normalize(v_who, NFKC) ~* '^\s*(agent|system|auto_policy)\s*:') then
    raise exception 'quyết định của người không ghi bằng tên agent/hệ thống (%)',
      left(coalesce(v_who, ''), 40) using errcode = '42501';
  end if;
  if not person_login() or (not v_decision and not p10_is_person(v_who)) then
    return new;
  end if;
  if tg_table_name = 'agent_action_log' then
    v_block := case
      when new.action in ('queue_approve', 'queue_reject', 'queue_override_qa')
        then (select a.block from approval_queue a
               where a.id = (new.detail->>'queue_id')::bigint)
      when new.action in ('alloc_approve', 'alloc_reject', 'lot_intake')
        then 'production'
      when new.action = 'cogs_approve' then 'finance'
      when new.action in ('draft_approve', 'draft_reject', 'draft_schedule')
        then (select case when new.action = 'draft_reject'
                           and lower(btrim(c.created_by)) = lower(btrim(v_who))
                          then null else coalesce(c.block, 'marketing') end
                from content_drafts c
               where new.object_type = 'content_draft'
                 and c.id::text = new.object_id) end;
  end if;
  perform human_actor(v_who, v_block);
  if v_decision then         -- (lồng: bảng khác không có cột action)
    if new.action in ('qr_lot_sign', 'qr_issue', 'qr_revoke') then
      v_role := case when new.action = 'qr_lot_sign'
                     then coalesce(new.detail->>'role', '?') end;
      if not exists (select 1 from human_qr_roles r
                      where r.db_login = session_user and r.active
                        and (v_role is null or r.role = v_role)) then
        raise exception 'login % không có vai QR % (human_qr_roles — Bên B điền theo văn bản ủy quyền)',
          session_user, coalesce(v_role, '(bất kỳ)') using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function person_login_guard() from public;

-- ===== Đợt an toàn S04b (22/10/2026): tác giả thật theo LOGIN, chặn tự duyệt =====
-- (HĐ 6.7, 7.2) Controller tái hiện: login NGƯỜI (app_human, có human_logins)
-- INSERT draft `created_by = 'agent:controller'` + tự chọn `block` (quyền INSERT
-- kế thừa agent_writer), rồi `approve_draft` bằng tên chính mình → duyệt được
-- (kiểm "người duyệt ≠ người tạo" so tên, tác giả thật bị che bằng nhãn agent).
-- Cùng lớp: `enqueue_item` (SECURITY DEFINER, agent_writer → app_human) nhãn
-- agent rồi `decide_item` tự quyết; tên biến thể khoảng trắng/hoa thường qua mặt
-- so `lower(btrim())`.
-- Nay:
--   * `created_login` (content_drafts, approval_queue) = `session_user` do
--     trigger ghi — caller không khai được (không có grant cột);
--   * login người (app_human, kể cả svc_ui, không owner) tạo draft/mục: tác giả
--     BẮT BUỘC là chính người của login (`human_actor` — chặn nhãn agent/
--     system/auto_policy và tên người khác); khối draft KHÔNG do người tự khai:
--     danh mục chỉ có nguồn content_drafts cho tác giả agent → draft của người
--     thuộc khối mặc định 'marketing' (cùng quy tắc `store._draft_block`);
--   * duyệt draft / quyết mục / override QA: người có login = login tạo, hoặc
--     tên trùng tác giả theo `p10_norm`, → 42501 (cả function rollback).
-- Luồng agent/dịch vụ (agent_writer, svc_job…) giữ nguyên: tác giả nhãn agent,
-- người có quyền khác duyệt. Dòng cũ `created_login` null: chỉ còn so tên.
alter table content_drafts add column if not exists created_login text;
alter table approval_queue add column if not exists created_login text;
-- (vòng r8) giá vốn: người lập qua login (app_human được INSERT bảng này)
alter table cogs_versions add column if not exists created_login text;

create or replace function creator_login_guard() returns trigger
language plpgsql security definer set search_path from current as $$
begin
  new.created_login := session_user;
  if p10_owner_login() or not person_login() then
    return new;
  end if;
  if tg_table_name = 'approval_queue' and not p10_is_person(new.created_by) then
    -- mục nhãn agent do CLI người khởi chạy (vd ra_kenh --partner-file —
    -- nhập liệu, khối do code của agent chọn): giữ nhãn làm nguồn gốc, tác
    -- giả thật = created_login (login phải ánh xạ người); tự quyết bị chặn
    -- theo login (person_login_guard).
    perform human_actor((select h.person from human_logins h
                          where h.db_login = session_user and h.active), null);
    return new;
  end if;
  new.created_by := human_actor(new.created_by, null);
  if tg_table_name = 'content_drafts' then
    -- shortcut: khối draft của người cố định 'marketing' vì danh mục chưa có
    -- nguồn content_drafts cho tác giả người; thêm nguồn đó → đổi quy tắc ở đây.
    if coalesce(new.block, 'marketing') <> 'marketing' then
      raise exception 'khối draft do hệ thống xác định (draft của người → marketing), không tự khai %',
        new.block using errcode = '42501';
    end if;
    new.block := 'marketing';
  end if;
  return new;
end $$;
revoke execute on function creator_login_guard() from public;

create or replace trigger content_drafts_creator_login
  before insert on content_drafts
  for each row execute function creator_login_guard();
create or replace trigger approval_queue_creator_login
  before insert on approval_queue
  for each row execute function creator_login_guard();
create or replace trigger cogs_versions_creator_login
  before insert on cogs_versions
  for each row execute function creator_login_guard();

create or replace function person_login_guard() returns trigger
language plpgsql security definer set search_path from current as $$
declare
  v_who text := to_jsonb(new)->>tg_argv[0];
  v_decision boolean := false;
  v_block text;
  v_role text;
  v_cl text;
  v_cb text;
begin
  if tg_table_name = 'agent_action_log' then
    if new.action = 'authz_denied' then
      return new;
    end if;
    v_decision := new.action = any(array['lot_intake', 'alloc_approve',
      'alloc_reject', 'queue_approve', 'queue_reject', 'queue_override_qa',
      'cogs_approve', 'draft_approve', 'draft_reject', 'draft_schedule',
      'qr_lot_sign', 'qr_issue', 'qr_revoke', 'qr_lot_link',
      'qr_lot_unlink']);
  end if;
  if p10_owner_login() then
    return new;
  end if;
  if v_decision and (btrim(coalesce(v_who, '')) = ''
      or normalize(v_who, NFKC) ~* '^\s*(agent|system|auto_policy)\s*:') then
    raise exception 'quyết định của người không ghi bằng tên agent/hệ thống (%)',
      left(coalesce(v_who, ''), 40) using errcode = '42501';
  end if;
  if not person_login() or (not v_decision and not p10_is_person(v_who)) then
    return new;
  end if;
  if tg_table_name = 'agent_action_log' then
    v_block := case
      when new.action in ('queue_approve', 'queue_reject', 'queue_override_qa')
        then (select a.block from approval_queue a
               where a.id = (new.detail->>'queue_id')::bigint)
      when new.action in ('alloc_approve', 'alloc_reject', 'lot_intake')
        then 'production'
      when new.action = 'cogs_approve' then 'finance'
      when new.action in ('draft_approve', 'draft_reject', 'draft_schedule')
        then (select case when new.action = 'draft_reject'
                           and lower(btrim(c.created_by)) = lower(btrim(v_who))
                          then null else coalesce(c.block, 'marketing') end
                from content_drafts c
               where new.object_type = 'content_draft'
                 and c.id::text = new.object_id) end;
  end if;
  perform human_actor(v_who, v_block);
  if v_decision then         -- (lồng: bảng khác không có cột action)
    if new.action = 'draft_approve' then
      select c.created_login, c.created_by into v_cl, v_cb
        from content_drafts c
       where new.object_type = 'content_draft' and c.id::text = new.object_id;
    elsif new.action in ('queue_approve', 'queue_override_qa') then
      select a.created_login, a.created_by into v_cl, v_cb
        from approval_queue a where a.id = (new.detail->>'queue_id')::bigint;
    elsif new.action = 'cogs_approve' then
      select g.created_login, g.created_by into v_cl, v_cb
        from cogs_versions g
       where new.object_type = 'cogs_version' and g.id::text = new.object_id;
    end if;
    -- (vòng r8) cùng NGƯỜI qua login khác: so người của login tạo và login
    -- hiện tại theo human_logins (mọi trạng thái — login cũ đã khóa vẫn tính)
    if v_cl = session_user::text or p10_norm(v_cb) = p10_norm(v_who)
       or exists (select 1 from human_logins h1 join human_logins h2
                    on p10_norm(h1.person) = p10_norm(h2.person)
                   where h1.db_login = v_cl and h2.db_login = session_user) then
      raise exception 'người tạo không tự duyệt (login/tên trùng tác giả) — cần người khác duyệt'
        using errcode = '42501';
    end if;
    if new.action in ('qr_lot_sign', 'qr_issue', 'qr_revoke') then
      v_role := case when new.action = 'qr_lot_sign'
                     then coalesce(new.detail->>'role', '?') end;
      if not exists (select 1 from human_qr_roles r
                      where r.db_login = session_user and r.active
                        and (v_role is null or r.role = v_role)) then
        raise exception 'login % không có vai QR % (human_qr_roles — Bên B điền theo văn bản ủy quyền)',
          session_user, coalesce(v_role, '(bất kỳ)') using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function person_login_guard() from public;

-- ===== Vòng r8 (22/10/2026): bằng chứng ĐĂNG NHẬP THẬT của người duyệt =====
-- Ma trận nghiệm thu (pipelines.acceptance) tách "cấu hình login dùng được"
-- (pg_roles: LOGIN, hạn VALID UNTIL, giới hạn kết nối, CONNECT, app_human, không
-- superuser) khỏi "đã đăng nhập thật": mỗi lần `auth.person_connect` mở phiên
-- người thành công (Postgres đã xác thực mật khẩu) ghi 1 dòng — login, người,
-- thời điểm DB; KHÔNG lưu mật khẩu. Append-only.
create table if not exists human_login_checks (
  id bigint generated always as identity primary key,
  db_login text not null,
  person text not null,
  checked_at timestamptz not null default now()
);
create or replace trigger human_login_checks_append_only_row
  before update or delete on human_login_checks
  for each row execute function append_only_guard();

create or replace function human_login_check() returns timestamptz
language plpgsql security definer set search_path from current as $$
declare
  v_person text;
begin
  select btrim(h.person) into v_person from human_logins h
   where h.db_login = session_user and h.active;
  if v_person is null then
    raise exception 'login % chưa được ánh xạ người (human_logins)',
      session_user using errcode = '42501';
  end if;
  insert into human_login_checks (db_login, person) values (session_user, v_person);
  return now();
end $$;
revoke execute on function human_login_check() from public;

-- ===== Vòng r12 (UI-01): ghi nhật ký vườn NHẬP TAY từ UI chế độ thực =====
-- Tab "Nhật ký vườn" đọc bằng login UI dùng chung (`svc_ui`, SELECT theo cột —
-- roles.sql khối r12) nhưng GHI bằng login Postgres RIÊNG của người (phiên "Mở
-- quyền quyết định", `auth.person_connect`) qua function này: `human_actor`
-- buộc --by = người của login + khối farming (svc_ui/dịch vụ không ánh xạ
-- người → 42501; agent/system → 42501). `author` = người của login, nguồn
-- `manual`; chuỗi băm do trigger `plot_logs` hiện có. Không cấp INSERT
-- plot_logs cho role nào.
create or replace function plot_log_add_human(p_plot text, p_ts timestamptz,
  p_activity text, p_detail text, p_by text)
returns bigint
language plpgsql security definer set search_path from current as $$
declare
  v_by text := human_actor(p_by, 'farming');
  v_id bigint;
begin
  if not exists (select 1 from plots where id = p_plot and status = 'active') then
    raise exception 'khoảnh % không tồn tại hoặc không active', left(coalesce(p_plot, ''), 40);
  end if;
  if btrim(coalesce(p_activity, '')) = '' then
    raise exception 'thiếu hoạt động';
  end if;
  insert into plot_logs (plot_id, ts, activity, detail, author, source)
  values (p_plot, p_ts, btrim(p_activity), nullif(btrim(coalesce(p_detail, '')), ''),
          v_by, 'manual')
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function plot_log_add_human(text, timestamptz, text, text, text)
  from public;
