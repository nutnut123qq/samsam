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
grant select (agent_id, ts, cost_usd, feature_id) on llm_usage to agent_writer;
grant insert (agent_id, model, tokens_in, tokens_out, cost_usd, ok, error,
  feature_id) on llm_usage to agent_writer;
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

-- ===== v14.2 p2 login dịch vụ (quyền tối thiểu theo bảng code dùng) =====
-- Mỗi dịch vụ KHÔNG phải người chạy bằng 1 login riêng `in role <svc_*>` (hạ
-- tầng Bên B tạo NGOÀI git, vd `create role zalo_oa login password '...'
-- in role svc_webhook;`) và trỏ biến `<DỊCH VỤ>_DATABASE_URL`
-- (`pipelines.auth.SERVICES`). Chế độ thực (`APPROVAL_ENFORCE`/`DEPLOY`/
-- AUTH_MODE local|proxy) từ chối login superuser/owner hoặc không thuộc
-- đúng role dịch vụ. Danh sách bảng lấy từ SQL thật của module (rà tĩnh
-- `tests/test_v14_p2_service_auth.py` + chạy flow dưới login thật):
--   svc_webhook — webhook Zalo OA / Messenger (`connectors.zalo|messenger`
--     → channels/api.rag/llm_gateway/rollout/director.submit): kế thừa
--     agent_writer (hàng duyệt cskh_handoff/cskh_reply qua enqueue_item,
--     llm_usage, feature_rollout, action log) + SELECT `chunks` (KB công
--     khai — KHÔNG `chunks_internal`) + SELECT/INSERT `chat_consents`
--     (append-only). KHÔNG leads/contacts/orders/payload hàng duyệt.
--   svc_job — job lịch (`pipelines.job_runs --run`, deploy/onprem/jobs.json)
--     trừ backup/diễn tập: kế thừa agent_writer + đọc/ghi đúng bảng các bước
--     dùng (dưới). KHÔNG contacts/consents (PII), KHÔNG UPDATE/DELETE bảng
--     log/bằng chứng, KHÔNG function duyệt.
--   svc_loader — nạp file (`ingest.*` loader, `agents.kd_orders --sync`):
--     ghi staging/golden/KB/đơn theo đúng loader; KHÔNG contacts/consents,
--     KHÔNG hàng duyệt/approvals, KHÔNG xóa settlement_rows/đơn thật (trigger
--     v14.2 chặn cả khi có quyền).
--   svc_backup — `scripts/db_backup.py` (pg_dump): CHỈ SELECT mọi bảng +
--     sequence của schema (bản sao đầy đủ; `contacts` vốn là ciphertext).
--     KHÔNG ghi bảng nào (v15 fix P8.7c: + EXECUTE function ghi bằng chứng
--     đầu ra backup `file_output_evidence_backup` — khối cuối file).
-- `restore_drill`/`dr_drill` tạo DB tạm → cần login quản trị hạ tầng
-- (CREATEDB) — ngoài phạm vi login dịch vụ, ghi rõ ở runbook mục 9.
-- Bên A: `ben_a_reader` (khối v12.5 B5) — login của Bên A `in role
-- ben_a_reader`, không có tiến trình trong repo.
do $$
declare
  r text;
begin
  foreach r in array array['svc_webhook', 'svc_job', 'svc_loader',
                           'svc_backup'] loop
    if not exists (select from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
do $$
declare
  s text := quote_ident(current_schema());
begin
  execute format('revoke all on all tables in schema %s from svc_webhook, svc_job, svc_loader, svc_backup', s);
  execute format('revoke all on all sequences in schema %s from svc_webhook, svc_job, svc_loader, svc_backup', s);
  execute format('revoke all on all functions in schema %s from svc_webhook, svc_job, svc_loader, svc_backup', s);
  execute format('revoke all on schema %s from svc_webhook, svc_job, svc_loader, svc_backup', s);
  execute format('grant usage on schema %s to svc_loader, svc_backup', s);
end $$;

grant agent_writer to svc_webhook;
grant select on chunks to svc_webhook;
grant select, insert on chat_consents to svc_webhook;

-- svc_job theo bước lịch: intel (crawler.intel + intel_bulletin), quét cảnh
-- báo đỏ (intel_alert --run, red_alert --deliver), báo cáo TGĐ (ceo_report:
-- cockpit + ceo_audit/decisions/risk), lô hóa đơn (acc_invoice --batch),
-- nháp bài (content --daily), KPI/bản tin sức khỏe/báo cáo tháng
-- (ops_monthly, health_bulletin), neo + văn bản pháp luật (anchor --build,
-- legal_updates --submit), wrapper job_runs.
grant agent_writer to svc_job;
grant select, insert on job_runs to svc_job;
grant usage on sequence job_runs_id_seq to svc_job;
grant select, insert on intel_items to svc_job;
grant select on approval_queue, approvals, decisions, decision_log,
  red_alerts, red_alert_acks, red_alert_deliveries, channel_snapshots,
  channel_posts, content_drafts, market_alerts, market_rows,
  market_snapshots, project_milestones, xnqc_dossiers, leads, llm_usage,
  sla_escalations, golden_discrepancies, ops_incidents, ops_incident_events,
  plot_logs, qr_codes, qr_signatures, production_lots, anchor_batches,
  anchor_receipts, sku_master, orders, settlement_rows, agent_action_log
  to svc_job;
grant select, insert on invoice_lines, chat_kpi_facts, anchor_batches
  to svc_job;
-- r13: `pipelines.anchor --upgrade` (job, agent:anchor) ghi dòng `da_nang_cap`
-- append-only (trigger chặn sửa/xóa).
grant insert on anchor_receipts to svc_job;
grant execute on function qr_lot_snapshot_sha(text), verify_plot_logs()
  to svc_job;
-- Đợt hợp đồng (PL01 Ban TGĐ "báo khi nhật ký bị sửa"): job `chain_watch`
-- (`agents.bks_audit --chain-alert`) kiểm cả chuỗi agent_action_log + đọc neo
-- đuôi của audit inside-out (chỉ 3 cột, không báo cáo/sha).
grant execute on function verify_action_log() to svc_job;
grant select (id, kind, params) on audit_runs to svc_job;

-- svc_loader theo loader: market_csv, settlement_csv (+ đối soát
-- recon_results), inventory_csv, intel_import, core_store (delete-by-source
-- dữ liệu nạp — trigger v14.2 vẫn chặn xóa đơn thật), golden_store (nạp),
-- embed_store/kb_internal (KB + chi phí embedding), kd_orders --sync.
grant select, insert, update on market_snapshots, market_rows, market_alerts,
  inventory_snapshots, intel_imports, competitor_observations, sku_master,
  orders to svc_loader;
-- Golden (v14 vá review): loader KHÔNG duyệt giá/map, KHÔNG quyết phiếu lệch
-- — chỉ cột loader thật ghi. Duyệt = `golden_store --approve-price` (người,
-- auth.cli_gate) bằng login của người. Đổi map → trigger
-- `sku_map_remap_clears_approval` xóa duyệt cũ (schema.sql khối vá review).
grant select, insert on price_list, golden_discrepancies to svc_loader;
-- sku_map: INSERT theo CỘT, không có approved_by → loader không chèn được map
-- "đã duyệt" sẵn (price_list có trigger chặn INSERT sẵn-duyệt; sku_map không).
grant select on sku_map to svc_loader;
grant insert (product_id, sku_key, note, source) on sku_map to svc_loader;
grant update (sku_key, note) on sku_map to svc_loader;
grant update (valid_to) on price_list to svc_loader;
grant update (detail, updated_at) on golden_discrepancies to svc_loader;
-- xóa phiếu `pending` hết điều kiện; phiếu đã quyết bị trigger
-- `golden_disc_keep_decided` chặn với mọi role.
grant delete on golden_discrepancies to svc_loader;
grant select, insert on settlement_rows, social_mentions, trends_related,
  trends_weekly to svc_loader;
grant select, insert, update on recon_results to svc_loader;
-- `ingest.lead_store` gom lead từ convlog (đã che/hash) — insert-only.
grant select, insert on leads to svc_loader;
grant select, insert, update, delete on products, claims_approved, plots,
  assets, chunks, chunks_internal
  to svc_loader;
-- plot_logs: nạp lại nhật ký MẪU chưa chain (delete-by-source) — trigger
-- `plot_logs_guard` chặn sửa/xóa dòng đã chain kể cả owner; KHÔNG UPDATE.
grant select, insert, delete on plot_logs to svc_loader;
grant delete on orders to svc_loader;
grant select on v_settlement_khoan, garden_media, agent_action_log
  to svc_loader;
grant select (agent_id, ts, cost_usd, feature_id) on llm_usage to svc_loader;
grant insert (agent_id, model, tokens_in, tokens_out, cost_usd, ok, error,
  feature_id) on llm_usage to svc_loader;
grant usage on sequence llm_usage_id_seq to svc_loader;
grant insert on job_runs to svc_loader;
grant usage on sequence job_runs_id_seq to svc_loader;

-- svc_backup: đọc toàn bộ (pg_dump + đếm dòng cùng snapshot).
do $$
begin
  execute format('grant select on all tables in schema %s to svc_backup',
                 quote_ident(current_schema()));
  execute format('grant select on all sequences in schema %s to svc_backup',
                 quote_ident(current_schema()));
end $$;

-- ===== v14.3 p3 rollout phủ đủ biên =====
-- * `enqueue_item` bản 11 tham số (cờ mẫu) — cùng người được gọi bản 10.
-- * `report_outputs`: mọi tiến trình ghi báo cáo qua `write_report` (agent
--   / job / người — đều kế thừa agent_writer) INSERT được, không UPDATE/
--   DELETE (append-only). bks_reader KHÔNG (đường ghi duy nhất của role là
--   audit_runs) → báo cáo BKS chạy bằng login bks_reader không vào sổ đếm
--   (cảnh báo, không chặn báo cáo); `audit_runs` vẫn đếm.
-- * `san_suggestions`: CLI `channels --suggest` (người MXH, kế thừa
--   agent_writer) ghi gợi ý; `san_suggestion_uses` chỉ NGƯỜI (app_human).
-- * svc_loader đọc `feature_rollout` để cổng tính năng của loader có đầu ra
--   (đối soát `recon_results`, gom lead) thấy được giai đoạn `tat` — không
--   đọc được thì `rollout.mode` rơi về chạy thử, tắt không chặn được.
-- * `audit_runs.is_sample`: bks_reader ghi thêm cột cờ mẫu.
grant execute on function
  enqueue_item(text, text, text, text, text, text, jsonb, text, text, int,
               boolean)
  to agent_writer;
grant insert (feature_id, name, sha256, is_sample) on report_outputs
  to agent_writer;
grant select on report_outputs, san_suggestions, san_suggestion_uses
  to app_human;
grant select, insert (channel, msg_ref, answer, handoff, guardrail_ok, stage,
  created_by) on san_suggestions to agent_writer;
grant insert (suggestion_id, used_by, stage) on san_suggestion_uses
  to app_human;
grant select on feature_rollout to svc_loader;
grant insert (is_sample) on audit_runs to bks_reader;

-- ===== v14.4 p4 kinh doanh =====
-- Đọc theo SQL thật của module (least privilege):
--   agent_writer — `agents.sales_director` đọc người phụ trách/hạn lead
--     (mục `lead_followup`); job nhắc chốt B2B đọc sự kiện báo giá (không
--     người liên hệ). KHÔNG ghi leads/sự kiện/giá đại lý.
--   app_human    — người gán phụ trách (`ingest.crm --owner`, SELECT … FOR
--     UPDATE cần quyền UPDATE cột) + ghi sự kiện báo giá (`kd_quote
--     --verify-send/--outcome`, append-only).
--   svc_loader   — nạp file giá đại lý quan sát tay (`ingest.dealer_price
--     --file`): INSERT `dealer_price_obs`, đọc sổ đại lý/SKU.
--   svc_job      — `kd_price --dealer-watch`, `kd_quote --followups`,
--     `kd_orders --watch`: CHỈ đọc nguồn + đẩy hàng duyệt (kế thừa
--     agent_writer).
grant select (owner_code, owner_due_at, owner_assigned_at)
  on leads to agent_writer;
grant select (id, queue_id, quote_no, kind, created_at)
  on b2b_quote_events to agent_writer;
grant update (owner_code, owner_due_at, owner_assigned_by, owner_assigned_at)
  on leads to app_human;
grant select on b2b_quote_events to app_human;
grant insert (queue_id, quote_no, kind, recorded_by)
  on b2b_quote_events to app_human;
grant usage on sequence b2b_quote_events_id_seq to app_human;
grant select, insert on dealer_price_obs to svc_loader;
grant usage on sequence dealer_price_obs_id_seq to svc_loader;
grant select on dealers to svc_loader;
grant select on dealer_price_obs, dealers, price_list to svc_job;

-- ===== v14.5 p5 marketing/ceo/intel =====
-- * `partner_post_scans` (ra_kenh --partner-file): CLI người MXH/marketing
--   ghi bằng login chạy ra_kenh (như `channel_posts` — hiện DSN owner);
--   agent_writer/app_human KHÔNG ghi.
-- * svc_job đọc nguồn của `intel_weekly --suggest-keywords` (intel-04.2)
--   và `agents.ceo_promo` (ceo-04.1: listing sàn, giá golden đã có).
grant select on trends_related, intel_imports to svc_job;

-- ===== v15.5 p11 dữ liệu đơn =====
-- `ingest.core_store` (svc_loader) ghi sổ sự kiện đồng bộ sản phẩm — chỉ
-- INSERT (append-only); `products` đã có quyền (upsert + `retired_at`).
grant select, insert on product_sync_log to svc_loader;
grant usage on sequence product_sync_log_id_seq to svc_loader;

-- ===== v15.4 p10 quyền người =====
-- (P10.1) CLI người chạy bằng login NGƯỜI `in role app_human`: GHI chỉ qua
-- function nghiệp vụ SECURITY DEFINER theo việc (docs/schema.sql khối
-- v15.4 — danh tính theo `session_user` ↔ `human_logins`, không tin
-- `--by`). KHÔNG cấp INSERT/UPDATE/DELETE bảng nghiệp vụ cho app_human.
-- `human_logins`: chỉ owner ghi/đọc (Bên B điền) — không grant role nào.
-- v14.4 cột người phụ trách lead (`crm --owner`) chuyển sang function →
-- thu hồi quyền UPDATE cột (khối v14.4 ở trên vẫn grant, revoke ở đây).
revoke update (owner_code, owner_due_at, owner_assigned_by, owner_assigned_at)
  on leads from app_human;
grant execute on function
  approve_price_human(bigint, text),
  xnqc_add_human(text, text, text, text),
  xnqc_set_status_human(bigint, text, text, text, text, date, date, date,
                        text),
  rollout_transition_human(text, text, text, text, text, text, text, jsonb,
                           timestamptz),
  crm_add_contact_human(text, text, text, text, text, text, text, bigint,
                        text),
  crm_record_consent_human(bigint, text, boolean, text, text, text, text,
                           text),
  crm_load_dealers_human(jsonb, text),
  crm_assign_lead_human(bigint, text, text, text),
  crm_set_lead_status_human(bigint, text, text),
  crm_assign_owner_human(bigint, text, timestamptz, timestamptz, text),
  crm_handoff_human(bigint, text, text),
  crm_counts(),
  doc_review_human(text, text, text),
  garden_purge_sample_human(text, bigint, bigint),
  garden_adopt_plot_human(text, text),
  record_partner_scan_human(text, text, text, text, date, text, text, text[],
                            text, text, bigint, boolean, timestamptz, text)
  to app_human;
-- ĐỌC cần thiết để CLI kiểm trước khi gọi function (không PII; KHÔNG
-- `contacts`/`consents` — đếm qua `crm_counts()`, ciphertext chỉ qua
-- `crm_handoff_human` khi có đồng ý đích danh):
--   golden --approve-price/--report: price_list, golden_discrepancies;
--   xnqc: xnqc_dossiers, sku_master (sku_key), documents (cột trạng thái,
--     không filename) + document_fields (doc_intake --pending);
--   crm: leads, dealers; garden --precheck: plots/plot_logs/garden_media
--     theo CỘT (không detail/author/vị trí); ra_kenh --partner-file:
--     partner_post_scans (sha256, không URL/text) + affiliate_codes (cột
--     mã đại lý/mục duyệt — kit đại lý đã duyệt).
grant select on price_list, golden_discrepancies, xnqc_dossiers, leads,
  dealers, partner_post_scans to app_human;
grant select (sku_key) on sku_master to app_human;
grant select (sha256, doc_type, status, pii_flag, created_at)
  on documents to app_human;
grant select (sha256, field, value, verified) on document_fields
  to app_human;
grant select (id, source) on plots to app_human;
grant select (id, plot_id, ts, source) on plot_logs to app_human;
grant select (id, plot_id) on garden_media to app_human;
-- ra_kenh --partner-file đối chiếu kit đại lý ĐÃ duyệt (mã đại lý ↔ mục duyệt).
grant select (id, dealer_code, queue_id, status) on affiliate_codes
  to app_human;

-- (P10.3) BKS: báo cáo file `bks-audit-*`/`bks-recon-*` (tính năng ceo-04.x)
-- chạy bằng login `in role bks_reader` → `write_report` (a) đọc giai đoạn
-- tính năng (`feature_rollout`, biên sinh HĐ 6.7 — không đọc được thì tính
-- năng TẮT vẫn sinh) và (b) ghi 1 dòng sổ đầu ra để được ĐẾM. Chỉ đúng vậy:
-- SELECT feature_rollout (không `feature_rollout_events`), INSERT 4 cột
-- `report_outputs` (id/created_at/db_role do DB đặt; append-only — không
-- SELECT/UPDATE/DELETE, không đọc sổ của tính năng khác).
grant select on feature_rollout to bks_reader;
grant insert (feature_id, name, sha256, is_sample) on report_outputs
  to bks_reader;

-- ===== v15.2 p8 đếm đầu ra + duyệt từng đầu ra =====
-- (P8.7) `output_reviews`: ghi CHỈ qua `output_review_human` (người —
-- app_human; danh tính theo login trong function). Đọc sổ duyệt để đếm cổng
-- PL02: app_human (`--promote`/`--outputs`) + agent_writer (`--status`/hồ
-- sơ chạy bằng login dịch vụ/agent). Không ai UPDATE/DELETE (append-only).
grant execute on function
  output_review_human(text, text, text, text, text, text)
  to app_human;
grant select on output_reviews to app_human, agent_writer;
-- (P8.4) báo cáo/bản tin agent đọc cờ provenance `is_sample` của hàng duyệt
-- (metadata, không payload) để truyền `sample=` cho sổ đầu ra.
grant select (is_sample) on approval_queue to agent_writer;

-- ===== v15 vá review (P10.1/P8.7) =====
-- `ra_kenh --partner-file` kiểm danh tính login ↔ `--by` TRƯỚC khi đẩy mục
-- hàng duyệt (đẩy mục tự commit — kiểm muộn thì `--by` giả vẫn để lại mục):
-- app_human gọi `human_actor` (chỉ đọc `human_logins` của CHÍNH login đang
-- dùng qua SECURITY DEFINER, trả tên người hoặc 42501 — không ghi gì).
-- Bộ đếm lại trong DB (`rollout_db_outputs`/`rollout_db_facts`/
-- `rollout_business_days`/`rollout_workday`) KHÔNG grant cho ai — chỉ chạy
-- bên trong `rollout_transition_human` (quyền owner); `count_spec` của
-- `feature_rollout` vẫn chỉ owner ghi (app_human/svc chỉ SELECT).
grant execute on function human_actor(text, text) to app_human;

-- ===== v15 fix P10.2 =====
-- (P10.2) Người được phép hoàn thành nghiệp vụ qua function nghiệp vụ
-- SECURITY DEFINER (docs/schema.sql khối cùng tên — danh tính theo login,
-- khối theo phân loại runbook 9.7, bất biến tự kiểm). KHÔNG cấp
-- UPDATE/INSERT bảng cho app_human; svc_*/agent_writer/bks_reader không gọi.
grant execute on function
  milestone_set_status_human(text, text, text, text),
  milestone_apply_due_human(bigint, text),
  org_handover_human(bigint, text, text),
  org_batch_rows_human(bigint, text),
  channel_post_mark_removed_human(text, timestamptz, text),
  anchor_receipt_human(bigint, text, text, bytea, text, text),
  b2b_quote_event_human(bigint, text, text, text)
  to app_human;
-- ĐỌC cần để CLI kiểm trước khi gọi function (không PII): lần gom + biên
-- nhận neo (`anchor --submit` dựng lại bản kê, no-op khi đã gửi — chỉ
-- hash/thời điểm). `org_prospects` KHÔNG grant (v8.3 — chỉ owner đọc):
-- `da_b2b --handover` đọc dòng của ĐÚNG lô qua `org_batch_rows_human`.
grant select on anchor_batches, anchor_receipts to app_human;
-- r14 C2: `anchor --upgrade --by <người>` ghi `da_nang_cap` CHỈ qua function
-- (không INSERT bảng cho app_human).
grant execute on function anchor_upgrade_human(bigint, text, bytea, text)
  to app_human;
-- `kd_quote --outcome/--verify-send`: thu hồi INSERT cột trực tiếp (v14.4) —
-- ghi chỉ qua `b2b_quote_event_human` (trước vá: login người INSERT thẳng
-- được dòng với `recorded_by` là tên người khác / báo giá chưa duyệt).
revoke insert (queue_id, quote_no, kind, recorded_by)
  on b2b_quote_events from app_human;
revoke usage on sequence b2b_quote_events_id_seq from app_human;

-- ===== v15 fix P8.7b =====
-- (P8.7) Người được ủy quyền duyệt đầu ra nguồn BẢNG qua CLI
-- (`rollout --outputs/--review-output`) mà KHÔNG cấp SELECT bảng nguồn:
-- liệt kê đầu ra cần duyệt (khóa + sha + loại nguồn + quyết định) qua
-- function SECURITY DEFINER `output_pending_human` (danh tính/khối theo
-- login như `output_review_human`). svc_*/agent_writer/bks_reader/PUBLIC
-- không gọi.
grant execute on function output_pending_human(text, text) to app_human;

-- ===== v15 fix P8.7c =====
-- (P8.7) Bằng chứng đầu ra nguồn FILE trong DB: CHỈ đường dịch vụ backup
-- (`scripts/db_backup.py`, login `in role svc_backup` qua BACKUP_DATABASE_URL)
-- ghi sổ `file_output_evidence` qua function SECURITY DEFINER (DB tự tính
-- khóa + sha từ bản ghi, từ chối login thuộc role người/agent/loader/BKS).
-- svc_backup vẫn KHÔNG INSERT/UPDATE/DELETE bảng nào (SELECT mọi bảng ở khối
-- v14.2 — gồm sổ này). app_human/agent_writer/svc_loader/bks_reader/PUBLIC:
-- không quyền trên sổ, không EXECUTE — người duyệt đọc khóa/sha qua
-- `output_pending_human` (bộ đếm `count_spec`, quyền owner).
grant execute on function file_output_evidence_backup(text, boolean)
  to svc_backup;

-- ===== docx P0 — cổng PL02 đếm lại trong DB, không tin số caller =====
-- Bằng chứng câu bot ĐÃ gửi khách thật (sales-01): CHỈ login dịch vụ webhook
-- ghi qua function SECURITY DEFINER (DB tự kiểm bản ghi, từ chối login thuộc
-- role người/loader/job/backup/BKS/Bên A) — không ai INSERT thẳng sổ.
grant execute on function file_output_evidence_chat(text) to svc_webhook;
-- CLI người (`rollout --promote/--status`) đọc SỐ ĐẾM DB của giai đoạn hiện
-- hành khi login không SELECT được bảng nguồn — chỉ đọc, không ghi.
grant execute on function rollout_recount_human(text) to app_human;

-- ===== docx P0c — danh tính NGƯỜI theo login ở mọi dòng ghi tên người =====
-- `svc_ui`: tiến trình Streamlit ĐÃ xác thực người dùng theo phiên (AUTH_MODE
-- local/proxy) dùng 1 login chung `in role svc_ui` (kế thừa app_human) — DB
-- tin tên người UI truyền vào function duyệt (UI kiểm `auth.authorize`). Login
-- NGƯỜI dùng CLI (`in role app_human`, KHÔNG svc_ui) bị trigger
-- `person_login_guard` buộc tên = người của login trong `human_logins`.
-- Hạ tầng Bên B tạo: `create role <login_ui> login password '<...>' in role
-- svc_ui;` — KHÔNG cấp svc_ui cho login người.
do $$
begin
  if not exists (select from pg_roles where rolname = 'svc_ui') then
    create role svc_ui nologin;
  end if;
end $$;
grant app_human to svc_ui;

-- ===== docx vòng 2 — provenance dữ kiện KPI chat =====
-- `chat_kpi_live` (dữ kiện có bằng chứng convlog live): job `kpi_snapshot`
-- (svc_job) ghi + đọc; người (app_human) đọc như `chat_kpi_facts`.
grant select, insert on chat_kpi_live to svc_job;
grant select on chat_kpi_live to app_human;

-- Đợt hợp đồng C02: sổ nhắc vườn — agent (job garden_remind) chèn + đóng
-- đợt; người (khối farming) đánh dấu đã nhắc CHỈ qua function.
grant select on garden_reminders to agent_writer, app_human;
grant insert (plot_id, dot_key, kind, ma_nv, status, kenh, is_sample)
  on garden_reminders to agent_writer;
grant update (closed_at) on garden_reminders to agent_writer;
-- Job `garden_remind` chạy bằng svc_job: đọc danh sách khoảnh (vá vòng 2 —
-- từ dda0089 job này thiếu quyền `plots` dưới login dịch vụ, chỉ lộ khi chạy
-- bằng login thật). Chỉ 3 cột cần, không tọa độ/diện tích.
grant select (id, status, source) on plots to svc_job;
-- Job `vt_harvest` (C11, vt_thuhoach): thêm số cây + năm trồng (dự báo
-- thu hoạch), vẫn không tọa độ/diện tích.
grant select (tree_count, planted_year) on plots to svc_job;
grant execute on function garden_reminder_done_human(bigint, text)
  to app_human;

-- Đợt hợp đồng C03: phiếu kiểm nghiệm lô — đọc (bản tin sản xuất/QR), ghi
-- CHỈ qua function người khối production.
grant select on lot_test_certificates to agent_writer, app_human;
-- `production cert-verify` bằng login người: chỉ mã lô + trạng thái nhập.
grant select (lot_code, intake_status) on production_lots to app_human;
grant execute on function lot_cert_record_human(text, text, text, date, text,
  text, text, text) to app_human;

-- Đợt hợp đồng vòng 2 — job dưới login dịch vụ (svc_job) thiếu quyền đọc, có
-- từ trước (dda0089), chỉ lộ khi chạy job bằng login THẬT (phép thử nâng cấp):
-- * `production_week/_month` render bản tin sản xuất (mục phiếu C03 + tiến
--   độ C10): đề xuất phân bổ/BOM/tồn kho.
-- * `price_watch` (kd_price --run: KM lỗ C08) + combo_price (C09): SKU×kênh
--   được quảng bá + giá vốn đã duyệt + giá đối thủ quan sát.
grant select on allocation_proposals, bom_combos, bom_items,
  inventory_snapshots, v_promotable, cogs_versions, competitor_observations
  to svc_job;
-- Đợt hoàn thiện 22/10: job `intel_weekly` (báo cáo tuần đối thủ/Trends/
-- social) dưới svc_job thiếu quyền đọc Trends + social (InsufficientPrivilege,
-- tái hiện bằng login thật qua wrapper). Chỉ CỘT báo cáo đếm: KHÔNG
-- `social_mentions.msg_hash` (băm có muối) / `excerpt` (trích nội dung, cổng
-- DPIA), KHÔNG `trends_weekly.anchor`; chỉ SELECT.
grant select (import_id, query_id, keyword, geo, week, value)
  on trends_weekly to svc_job;
grant select (channel, labels, sensitive, posted_at) on social_mentions
  to svc_job;

-- Đợt hợp đồng C10: kế hoạch + gắn lô (tiến độ sản xuất) — đọc cho bản tin,
-- ghi CHỈ qua function người khối production.
grant select on production_plans, production_plan_lots to agent_writer,
  app_human;
grant execute on function production_plan_add_human(text, text, int, date,
  date, text, boolean, text), production_plan_link_human(text, text, text)
  to app_human;

-- Đợt hợp đồng C05: báo cáo TGĐ (job svc_job) liệt kê đối soát quý đã ghi
-- số chờ ký — chỉ 3 cột định danh, không số tiền.
grant select (id, quarter, recorded_at) on revenue_quarters to svc_job,
  bks_reader;

-- Đợt hợp đồng C07: Marketing (người, app_human) chỉ đọc VIEW tư liệu đã cấp
-- — không bảng garden_media đủ cột; cấp/thu hồi CHỈ qua function farming.
grant select on v_garden_media_marketing to app_human;
grant select on garden_media_releases to app_human;
grant execute on function garden_media_release_human(text, text, text, text)
  to app_human;

-- Đợt hợp đồng C12: job `channel_scan` (`ra_kenh --scan-auto`, svc_job) ghi
-- snapshot bài/listing + mở/đóng đợt vi phạm (không xóa, không đổi nội dung
-- snapshot cũ — chỉ cột đóng đợt / liên kết hàng duyệt-cảnh báo).
grant insert (url, channel, content_type, posted_on, is_ai, is_sponsored, sku,
  draft_id, text, text_sha256, guardrail, codes, severity, first_detected_at,
  due_at, queue_id, alert_id, imported_by, scanned_at) on channel_posts
  to svc_job;
grant update (closed_at, close_reason, closed_by, queue_id, alert_id)
  on channel_posts to svc_job;

-- Đợt an toàn S04 (22/10/2026): `svc_ui` KHÔNG còn được tin tên người
-- (schema.sql `person_login()` bỏ miễn trừ) — login UI dùng chung chỉ đọc/ghi
-- dòng không mang tên người; quyết định ở UI chế độ thực đi bằng login
-- Postgres RIÊNG của người (`auth.person_connect`). Không thêm quyền nào cho
-- `svc_ui`/dịch vụ. Agent ghi cột `block` của draft lúc tạo (không UPDATE).
grant insert (block) on content_drafts to agent_writer;
grant execute on function human_whoami() to app_human;

-- Vòng r8: phiên người ghi bằng chứng đăng nhập thật (không mật khẩu).
grant execute on function human_login_check() to app_human;

-- ===== Vòng r12 (UI-01/UI-02): login UI dùng chung `svc_ui` — ít quyền nhất =====
-- Tab "Nhật ký vườn": ĐỌC đúng các cột module agents.garden đọc (khoảnh active,
-- nhật ký gần nhất, bất thường) — KHÔNG SELECT mọi cột plots, KHÔNG INSERT
-- plot_logs; GHI đi bằng login người qua `plot_log_add_human` (app_human — svc_ui
-- kế thừa nhưng không ánh xạ người nên DB từ chối).
grant select (id, location, status) on plots to svc_ui;
grant select (id, plot_id, ts, activity, detail, author, source) on plot_logs
  to svc_ui;
grant execute on function plot_log_add_human(text, timestamptz, text, text, text)
  to app_human;
-- Tab "Chat Sâm Sâm": KB CÔNG KHAI `chunks` (như svc_webhook) — KHÔNG
-- `chunks_internal`.
grant select on chunks to svc_ui;
