-- GIẢ LẬP xóa DÒNG CUỐI nhật ký (sau khi đã có neo đuôi audit_runs) trên DB THỬ.
set session_replication_role = replica;
delete from agent_action_log where id = (select max(id) from agent_action_log);
set session_replication_role = origin;
