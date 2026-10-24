-- GIẢ LẬP TẤN CÔNG trên DB THỬ (owner/superuser): sửa nội dung 1 dòng nhật ký giữa chuỗi.
-- session_replication_role=replica tắt trigger append-only (đúng GIỚI HẠN đã ghi trong red_alert.py/bks_audit).
set session_replication_role = replica;
update agent_action_log set detail = jsonb_build_object('sua_thu_it', true)
 where id = (select min(id) + 10 from agent_action_log);
set session_replication_role = origin;
