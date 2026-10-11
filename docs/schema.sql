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
