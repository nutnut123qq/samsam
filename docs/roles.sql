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
--                  INSERT draft (6 cột — status
--                  luôn default 'pending'), INSERT log (5 cột — trigger ép
--                  id/ts/db_role/hash). KHÔNG UPDATE/DELETE bảng nào, KHÔNG
--                  approvals, KHÔNG bảng khác, KHÔNG function duyệt.
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
end $$;

-- Revoke sạch trên schema hiện tại rồi grant lại (chạy lại không cộng dồn).
do $$
declare
  s text := quote_ident(current_schema());
begin
  execute format('revoke all on all tables in schema %s from agent_writer, app_human', s);
  execute format('revoke all on all sequences in schema %s from agent_writer, app_human', s);
  execute format('revoke all on all functions in schema %s from agent_writer, app_human', s);
  execute format('revoke all on schema %s from agent_writer, app_human', s);
  execute format('grant usage on schema %s to agent_writer', s);
end $$;

grant select on content_drafts to agent_writer;
-- v4.2: store đọc readiness (guardrail đăng bài) — thiếu grant thì đường
-- DB chết câm dưới DSN role (fallback golden file). app_human kế thừa.
grant select on sku_readiness to agent_writer;
grant insert (brief, channel, text, guardrail, source, created_by)
  on content_drafts to agent_writer;
grant insert (actor, action, object_type, object_id, detail)
  on agent_action_log to agent_writer;

grant agent_writer to app_human;
grant select on approvals, agent_action_log to app_human;
grant execute on function
  approve_draft(bigint, text, text),
  reject_draft(bigint, text, text),
  schedule_draft(bigint, date, text),
  verify_publish(text, text, text),
  verify_action_log()
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
-- payload 11 khối (pháp chế, tài chính, báo giá...) chỉ app_human đọc —
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
