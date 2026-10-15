-- v3.4 role DB tách quyền (WP03). Chạy SAU docs/schema.sql:
--   python scripts/apply_schema.py --roles
-- Idempotent: tạo role nếu chưa có, revoke sạch rồi grant lại.
--
-- Role là NOLOGIN (group role) — không ai đăng nhập trực tiếp bằng 2 role
-- này. Login user + mật khẩu do hạ tầng tạo NGOÀI git, vd:
--   create role <ten_login> login password '<...>' in role app_human;
-- (external-dep: chạy trên Postgres cloud). Role là cluster-global: file
-- này CHỈ tạo/grant đúng 2 role dưới, không đụng/drop role khác.
--
--   agent_writer — agent AI: đọc content_drafts + view sku_readiness (v4.2),
--                  INSERT draft (11 cột, v6.1 — status
--                  luôn default 'pending'), INSERT log (5 cột — trigger ép
--                  id/ts/db_role/hash), v6.2 SELECT + INSERT image_assets
--                  (15 cột — metadata ảnh nháp MKT-03, insert-only),
--                  v6.3 SELECT + INSERT video_assets (15 cột — video nháp
--                  MKT-04, insert-only).
--                  KHÔNG UPDATE/DELETE bảng nào, KHÔNG approvals, KHÔNG
--                  bảng khác, KHÔNG function duyệt.
--   app_human    — người (Streamlit/CLI): kế thừa agent_writer + đọc
--                  approvals/log + execute function duyệt/xếp lịch/kiểm.
--                  KHÔNG UPDATE/DELETE trực tiếp — mọi chuyển trạng thái đi
--                  qua function SECURITY DEFINER (docs/schema.sql).
-- Grant trên schema hiện tại (current_schema()) — chạy được trong schema tạm
-- của test.

do $$
begin
  if not exists (select from pg_roles where rolname = 'agent_writer') then
    create role agent_writer nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'app_human') then
    create role app_human nologin;
  end if;
  -- v10.0 (WP16): Ban kiểm soát / HĐTV đọc độc lập — xem khối cuối file.
  if not exists (select from pg_roles where rolname = 'bks_reader') then
    create role bks_reader nologin;
  end if;
end $$;

-- Revoke sạch trên schema hiện tại rồi grant lại (chạy lại không cộng dồn).
do $$
declare
  s text := quote_ident(current_schema());
begin
  execute format('revoke all on all tables in schema %s from agent_writer, app_human, bks_reader', s);
  execute format('revoke all on all sequences in schema %s from agent_writer, app_human, bks_reader', s);
  execute format('revoke all on all functions in schema %s from agent_writer, app_human, bks_reader', s);
  execute format('revoke all on schema %s from agent_writer, app_human, bks_reader', s);
  execute format('grant usage on schema %s to agent_writer', s);
end $$;

grant select on content_drafts to agent_writer;
-- v4.2: store đọc readiness (guardrail đăng bài) — thiếu grant thì đường
-- DB chết câm dưới DSN role (fallback golden file). app_human kế thừa.
grant select on sku_readiness to agent_writer;
-- v6.1: thêm 5 cột ngữ cảnh draft (content_type/sku/is_ai/prompt_*) —
-- thiếu grant thì save_draft dưới DSN role chết `permission denied`.
-- is_ai do agent ghi được -> CHỈ truy vết: store.set_status duyệt luôn
-- bắt nhãn AI (is_ai cố định true khi kiểm lại), không tin cột này.
grant insert (brief, channel, text, guardrail, source, created_by,
              content_type, sku, is_ai, prompt_version, prompt_sha256)
  on content_drafts to agent_writer;
grant insert (actor, action, object_type, object_id, detail)
  on agent_action_log to agent_writer;
-- v6.2 (MKT-03 ảnh AI): agent ghi metadata ảnh nháp + đọc để idempotent
-- theo (file_sha256, sku, channel, format). KHÔNG UPDATE/DELETE
-- (insert-only; nháp mồ côi do race
-- thì người reject draft, không xóa dòng).
grant select on image_assets to agent_writer;
grant insert (file_sha256, file_name, sku, channel, format, ai_generated,
              label_text, provider, model, prompt_sha256, prompt_version,
              packshot_sha256, draft_id, meta, created_by)
  on image_assets to agent_writer;
-- v6.3 (MKT-04 video AI): như image_assets — SELECT (idempotent theo
-- file_sha256, sku, channel, format) + INSERT 15 cột. KHÔNG UPDATE/DELETE.
grant select on video_assets to agent_writer;
grant insert (file_sha256, file_name, sku, channel, format, duration_ms,
              label_text, script_model, script_prompt_sha256,
              script_prompt_version, tts_provider, packshot_sha256, draft_id,
              meta, created_by)
  on video_assets to agent_writer;

grant agent_writer to app_human;
grant select on approvals, agent_action_log to app_human;
grant execute on function
  approve_draft(bigint, text, text),
  reject_draft(bigint, text, text),
  schedule_draft(bigint, date, text),
  verify_publish(text, text, text),
  verify_action_log(),
  decide_allocation_run(text, text, text, text),
  record_lot_intake(text, text, text, text)
  to app_human;

-- v4.0 hàng duyệt dùng chung (WP03): agent đẩy việc + tự duyệt theo luật đã
-- ký (fail-closed nếu không có) + đánh expired; người quyết/override QA.
--   agent_writer — EXECUTE enqueue_item/auto_approve_item/expire_overdue;
--                  SELECT approval_queue (CỘT metadata, KHÔNG payload)/
--                  decisions (agent GĐ làm bản tin);
--                  INSERT red_alerts (5 cột, + SELECT id cho RETURNING),
--                  channel_snapshots (8 cột).
--                  KHÔNG decide_item/override_qa, KHÔNG UPDATE/DELETE.
--   app_human    — thêm SELECT approval_queue (đủ cột, gồm payload)/
--                  auto_policies/channel_snapshots/red_alerts +
--                  EXECUTE decide_item/override_qa. KHÔNG UPDATE/DELETE trực
--                  tiếp (TGĐ/ha_tang là người = app_human → không xóa/sửa
--                  được cảnh báo đỏ). auto_policies: chỉ owner ghi.
-- agent_writer CHỈ đọc metadata hàng duyệt (bản tin GĐ không cần payload);
-- payload 9 khối (pháp chế, tài chính, báo giá...) chỉ app_human đọc —
-- mọi agent kể cả chatbot khách hàng KHÔNG đọc được (least privilege).
grant select (id, object_type, object_id, block, title, risk, qa_status,
  status, created_by, created_at, due_at, decided_by, decided_at, lane)
  on approval_queue to agent_writer;
grant select on decisions to agent_writer;
grant insert (source_agent, title, detail, recipients, route_error)
  on red_alerts to agent_writer;
grant select (id) on red_alerts to agent_writer;  -- insert ... returning id
grant insert (channel, metric_id, period_kind, period_start, value, source,
  source_ref, captured_by)
  on channel_snapshots to agent_writer;
grant execute on function
  enqueue_item(text, text, text, text, text, text, jsonb, text, text, int),
  auto_approve_item(bigint),
  expire_overdue(text)
  to agent_writer;

grant select on approval_queue, auto_policies, channel_snapshots,
  red_alerts to app_human;
grant execute on function
  decide_item(bigint, text, text, text),
  override_qa(bigint, text, text)
  to app_human;

-- v7.1 xác nhận cảnh báo đỏ intel (WP09): CHỈ người (app_human) xác nhận —
-- INSERT 3 cột, `acked_at` do DB đặt (không lùi giờ). agent_writer KHÔNG có
-- quyền gì trên red_alert_acks (agent không tự xác nhận cảnh báo của mình).
grant select on red_alert_acks to app_human;
grant insert (alert_id, acked_by, note) on red_alert_acks to app_human;

-- v4.5 (WP06): agent GĐ khối (pipelines/director.py, chạy bằng agent_writer)
-- đọc eval_runs cho mục "Nghiệm thu QA hôm nay" + submit(qa_suite=) lấy
-- qa_status từ run mới nhất. eval_runs chỉ có metadata (id ca, model, hash,
-- commit) — không text ca/PII. CHỈ SELECT: agent không tự ghi kết quả QA.
grant select on eval_runs to agent_writer;

-- v9.2: duyệt phân bổ / kiểm nhập lô CHỈ qua 2 function trên. TUYỆT ĐỐI
-- không grant INSERT approvals cho role nào (verify_publish tin approvals →
-- chèn được là duyệt giả được content_draft).

-- v9.4 lô + QR truy xuất: app_human (GĐ SX / GĐ vùng trồng / Pháp chế-QA qua
-- CLI) CHỈ EXECUTE 5 function ghi + hàm bản chụp. KHÔNG grant INSERT/UPDATE
-- approvals / lot_origins / qr_signatures / qr_codes cho role nào; agent_writer
-- KHÔNG ký/phát hành/thu hồi.
grant execute on function
  qr_lot_snapshot_sha(text),
  link_lot_origin(text, bigint, text[], text),
  unlink_lot_origin(text, bigint, text),
  sign_qr_lot(text, text, text, text, text),
  issue_qr(text, text, text, text),
  revoke_qr(text, text, text)
  to app_human;
-- v5.0 agent GĐ Kinh doanh TMĐT (WP07, agents/sales_director.py): đọc nguồn
-- việc của khối KD theo CỘT (không detail/user_hash/raw/sku_key — payload
-- hàng duyệt dựng từ template mã/loại/kênh, không cần nội dung) + ghi leo
-- thang SLA (append-only).
--   agent_writer — INSERT sla_escalations (8 cột, trừ id/created_at) +
--                  SELECT (id, queue_id, created_at) cho on-conflict/bản tin;
--                  SELECT cột market_alerts / golden_discrepancies / leads.
--   app_human    — SELECT sla_escalations đủ cột.
grant insert (queue_id, block, handoff_class, assignee_role, escalate_to_role,
  business_due_at, red_alert, created_by)
  on sla_escalations to agent_writer;
grant select (id, queue_id, created_at) on sla_escalations to agent_writer;
grant select (id, kind, severity, channel, export_kind, status, opened_at)
  on market_alerts to agent_writer;
grant select (id, kind, status, created_at)
  on golden_discrepancies to agent_writer;
grant select (id, ts, channel, intent, status, question)
  on leads to agent_writer;
grant select on sla_escalations to app_human;

-- v9.1 FP&A (WP12): người lập (GĐ sản xuất) thêm dòng giá vốn chưa duyệt;
-- duyệt CHỈ qua approve_cogs (người duyệt khác người lập — chặn trong
-- function). agent_writer KHÔNG execute approve_cogs, KHÔNG insert giá vốn
-- (agent không tự lập/duyệt giá vốn). opex_entries chỉ owner (CLI nạp).
grant select, insert (sku_key, cost_vnd, valid_from, created_by, note)
  on cogs_versions to app_human;
grant execute on function approve_cogs(bigint, text, text) to app_human;

-- v10.0 HĐTV/BKS (WP16): `bks_reader` — role CHỈ ĐỌC cho audit inside-out
-- (`agents.bks_audit`), đối soát độc lập (`agents.bks_recon`) và gói HĐTV
-- (`agents.hdtv_report`). NOLOGIN — login thật của thành viên BKS/HĐTV do hạ
-- tầng tạo `in role bks_reader` (external-dep). Quyền:
--   * SELECT ĐÚNG các bảng 3 module đọc (liệt kê từ code thật — kể cả bảng
--     section v8.1 `ceo_decisions`/`ceo_risk`/`ceo_audit` và
--     `fp_opscost`/`fp_pnl`/`ceo_report` đọc), KHÔNG `all tables`;
--   * INSERT 6 cột `audit_runs` (id/created_at/db_role do DB đặt) — đường
--     ghi DUY NHẤT của role;
--   * EXECUTE 3 function KIỂM (SECURITY DEFINER, chỉ đọc).
-- KHÔNG UPDATE/DELETE/TRUNCATE bảng nào, KHÔNG execute function ghi
-- (approve_draft, decide_item, override_qa...). agent_writer/app_human KHÔNG
-- có quyền gì trên `audit_runs` (revoke all ở đầu file).
do $$
begin
  execute format('grant usage on schema %s to bks_reader',
                 quote_ident(current_schema()));
end $$;
grant select on agent_action_log, approvals, approval_queue, decisions,
  decision_log, content_drafts, channel_posts, plot_logs, settlement_rows,
  recon_results, market_snapshots, market_rows, market_alerts,
  channel_snapshots, cogs_versions, sku_master, llm_usage, opex_entries,
  project_milestones, red_alerts, red_alert_acks, xnqc_dossiers, audit_runs
  to bks_reader;
grant insert (kind, period_label, params, findings, report_sha256, run_by)
  on audit_runs to bks_reader;
grant execute on function
  verify_action_log(),
  verify_plot_logs(),
  verify_publish(text, text, text)
  to bks_reader;

-- ===== v12.1 B1 =====
-- Sổ triển khai (`pipelines.rollout`): người (Streamlit/CLI đọc) chỉ SELECT.
-- Ghi (seed/nâng/lỗi nghiêm trọng/tắt) CHỈ qua CLI bằng DSN owner — cổng
-- ngày làm việc + đầu ra nằm ở code; cấp quyền sửa cho app_human sẽ cho phép
-- nâng giai đoạn bỏ qua cổng. agent_writer KHÔNG có quyền gì (revoke đầu file).
grant select on feature_rollout, feature_rollout_events to app_human;

-- ===== v12.5 B5 doanh thu thuần trực tuyến + đối soát quý =====
-- `ben_a_reader` — tài khoản XEM số liệu doanh thu/đơn trực tuyến của Bên A
-- (HĐ hợp tác Điều 7.3). NOLOGIN — login thật do hạ tầng Sâm Sâm tạo
-- `in role ben_a_reader` (external-dep). Quyền: SELECT ĐÚNG 2 view tổng hợp
-- theo ngày × kênh (không mã đơn/hash) + `revenue_quarters`. KHÔNG bảng gốc
-- (`settlement_rows`/`orders`/`market_rows`), KHÔNG `contacts`/PII, KHÔNG
-- INSERT/UPDATE/DELETE gì. Revoke sạch rồi grant lại (chạy lại không cộng
-- dồn).
do $$
begin
  if not exists (select from pg_roles where rolname = 'ben_a_reader') then
    create role ben_a_reader nologin;
  end if;
end $$;
do $$
declare
  s text := quote_ident(current_schema());
begin
  execute format('revoke all on all tables in schema %s from ben_a_reader', s);
  execute format('revoke all on all sequences in schema %s from ben_a_reader', s);
  execute format('revoke all on all functions in schema %s from ben_a_reader', s);
  execute format('revoke all on schema %s from ben_a_reader', s);
  execute format('grant usage on schema %s to ben_a_reader', s);
end $$;
grant select on revenue_quarters, v_ben_a_settlement_daily,
  v_ben_a_orders_daily to ben_a_reader;

-- ===== v13.2 c02 đối soát chồng kỳ =====
-- `bks_recon`/`hdtv_report` (role bks_reader) đọc số quyết toán qua view
-- `v_settlement_khoan` (1 dòng / khoản, khử bản xuất lại). ben_a_reader vẫn
-- CHỈ 2 view tổng hợp (view này có order_id_hash → không cấp).
grant select on v_settlement_khoan to bks_reader;

-- ===== v13.3 c03 cưỡng chế giai đoạn =====
-- `pipelines.rollout.mode()` đọc giai đoạn hiện hành ở MỌI biên sinh/duyệt/dùng
-- (HĐ 6.7). Agent chạy bằng agent_writer phải đọc được `feature_rollout` —
-- không đọc được thì mode() fail-closed về chạy thử, mà chạy thử KHÔNG chặn
-- sinh → tính năng đã TẮT vẫn sinh được. Chỉ SELECT bảng trạng thái (không
-- PII, không `feature_rollout_events`); ghi vẫn chỉ CLI owner.
grant select on feature_rollout to agent_writer;

-- ===== v13.5 c04 danh tính / quyền duyệt / least privilege =====
-- FinOps dưới login agent: `pipelines.llm_gateway` đọc chi tiêu tháng
-- (agent_id, ts, cost_usd) + ghi 1 dòng/lời gọi. Thiếu grant thì dưới login
-- `agent_writer` MỌI lời gọi LLM bị chặn (v13.1 fail-closed khi không đọc được
-- chi tiêu) — tức không chuyển được agent sang login riêng. KHÔNG UPDATE/DELETE
-- (agent không tự xóa/sửa chi tiêu để lách trần). app_human kế thừa.
grant select (agent_id, ts, cost_usd) on llm_usage to agent_writer;
grant insert (agent_id, model, tokens_in, tokens_out, cost_usd, ok, error)
  on llm_usage to agent_writer;
grant usage on sequence llm_usage_id_seq to agent_writer;
-- Danh tính người duyệt: mỗi người duyệt 1 login Postgres riêng `in role
-- app_human` (hạ tầng tạo NGOÀI git), khai `db_login` trong users file — CLI
-- chế độ thực (`pipelines.auth.authorize`) chỉ nhận `--by` khớp login đang dùng;
-- `approvals.db_role` + `agent_action_log.db_role` ghi login thật. Agent chạy
-- login `in role agent_writer` (không execute decide_item/approve_draft/
-- override_qa; không UPDATE/DELETE log — trigger append-only chặn cả owner).

-- ===== v13.7 c07 cảnh báo đỏ gửi thật / sổ sự cố / KPI chat =====
-- `red_alert.raise_alert` (gọi từ agent dưới agent_writer) gửi ngay rồi ghi
-- 1 dòng/người nhận vào `red_alert_deliveries` — chỉ INSERT (không đọc lại,
-- không sửa/xóa: trigger append-only). Quét gửi lại `--deliver`, sổ sự cố
-- (`pipelines.ops_incidents`, người thật) và chụp KPI chat chạy DSN vận hành.
grant insert (alert_id, recipient, role, channel, ok, error)
  on red_alert_deliveries to agent_writer;
grant select, insert on red_alert_deliveries to app_human;
grant select, insert on ops_incidents, ops_incident_events to app_human;
grant select on chat_kpi_facts to app_human;
