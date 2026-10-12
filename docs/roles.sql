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
--                  (15 cột — metadata ảnh nháp MKT-03, insert-only).
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

grant agent_writer to app_human;
grant select on approvals, agent_action_log to app_human;
grant execute on function
  approve_draft(bigint, text, text),
  reject_draft(bigint, text, text),
  schedule_draft(bigint, date, text),
  verify_publish(text, text, text),
  verify_action_log()
  to app_human;
