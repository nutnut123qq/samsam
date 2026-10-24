# Sự cố test chạm DB `samsam` (20/10/2026) — timeline + bằng chứng + phần còn thiếu

Đợt an toàn S02 (22/10/2026). Trạng thái: **UNVERIFIED** — không kết luận
"không ảnh hưởng". Agent không có quyền truy cập DB `samsam` (kể cả đọc) trong
đợt này; mọi dòng dưới lấy từ bằng chứng ngoài DB `samsam`.

Nguồn đã dùng:

- (T) nhật ký phiên Claude Code trên máy dev (lệnh + thời điểm + đầu ra rút
  gọn, đã che DSN) — trích ở scratchpad, không đưa nguyên văn vào repo;
- (E) evidence repo + `docs/handover/doi-chieu-docx.md` mục 2b/A7;
- (C) cấu hình server Postgres dev đọc qua DB TEST `samsam_contract_r6probe`
  (`show …`, `pg_hba_file_rules`, `pg_ls_logdir()` — chỉ tên/kích thước/giờ
  sửa tệp log, KHÔNG đọc nội dung);
- (S) đọc tĩnh mã test tại `dda0089` (bản gần nhất có trong Git — working
  tree hôm đó có thể khác: suy đoán).

## 1. Timeline (giờ UTC; VN = +7)

| Thời điểm | Sự kiện | Nguồn | Loại |
|---|---|---|---|
| 19/10 10:53–17:00 | Phiên trước chạy pytest với `source tools/env.sh` → DB `samsam_docx_*` | T | trực tiếp |
| 20/10 03:03:38 | pytest `-x` test_redteam, test_handover_docs, test_v13_c01_pii_guardrail, test_v14_p1_pii_guardrail, test_guardrail_v2, test_guardrail_llm — shell KHÔNG đặt `DATABASE_URL` → conftest nạp `.env` (DB `samsam`) | T | trực tiếp (lệnh) |
| 20/10 03:04:05 | + test_guardrail, test_content, test_listing (607 passed, 1 failed) | T | trực tiếp |
| 20/10 03:07:10 | test_guardrail_implied (40 passed, không DB) | T | trực tiếp |
| 20/10 03:09:28 / 03:12:46 | test_zalo, test_docx_p1, test_messenger, test_v14_p6_ops, test_v15_fix_p81, test_v15_p7_jobs, test_zalo_garden (2 lượt) | T | trực tiếp |
| 20/10 03:15:51 / 03:16:28 | test_docx_p1; rồi cùng nhóm trên (255 passed) | T | trực tiếp |
| 20/10 03:21:11 | test_intel_alert, test_v13_c07_ops, test_v15_p7_jobs, test_intel, test_rollout (367 passed) | T | trực tiếp |
| 20/10 03:24:45 | test_intel_alert (72 passed) | T | trực tiếp |
| 20/10 03:25:53 | test_intel_weekly, test_v15_p7_jobs, test_intel_import (110 passed) | T | trực tiếp |
| 20/10 03:27:51 | Phát hiện: `.env` DATABASE_URL → `localhost:5432/samsam` | T | trực tiếp |
| 20/10 03:28:30 | test_intel_alert `-k schema_acks` (1 passed) — lượt cuối dùng `.env` | T | trực tiếp |
| 20/10 03:29:01 | Đọc 1 lần bộ đếm `pg_stat_database` của `samsam`: `xact_commit` = 6675 (KHÔNG có số trước sự cố để so); tạo `samsam_contract_g` | T | trực tiếp |
| 20/10 03:29:43 → | Mọi lượt sau dùng `samsam_contract_*` | T, E | trực tiếp |
| 20/10 (sau) | Kiểm chỉ đọc lúc đó: 0 schema `t_*` sót trong `samsam` | E (2b) | trực tiếp |
| 21/10 | Vá cổng `tests/_db_guard.py` G1–G3 | E | trực tiếp |

Khung có thể bị tác động: **20/10/2026 03:03:38 → 03:28:30 UTC (10:03–10:28
giờ VN)**, một tiến trình Python mỗi lượt, login `.env` (role `postgres`,
SUPERUSER — xem mục 3).

## 2. Khả năng ghi (suy đoán từ mã test — S)

| Nhóm | Cơ chế | Có thể để lại gì ở `samsam` | Loại |
|---|---|---|---|
| Fixture schema tạm + ROLLBACK (`ceo_db`, `db` của nhiều file) | schema/roles chạy trong 1 transaction rồi rollback | không (nếu rollback chạy) | suy đoán |
| Fixture `live` ĐÃ COMMIT (vd `test_v15_p7_jobs`) | tạo schema `t_*` + login Postgres tạm, COMMIT, dọn cuối module | schema đã dọn (kiểm 0 `t_*`); role cluster tạm; giao dịch đã commit | suy đoán (dọn đã thấy, nội dung không kiểm được) |
| Tiến trình con CLI (`subprocess`): test_intel (9), test_intel_import (7), test_intel_alert (6), test_v15_p7_jobs (1), test_v13_c07_ops (1, `job_runs --list`), test_listing (1, DSN chết) | nhiều ca đặt DSN giả/chết; ca kế thừa `os.environ` nhận DSN `.env` | dòng commit vào `public` của `samsam` (`job_runs`, `red_alerts`, `red_alert_deliveries`, `agent_action_log`, `intel_items`, `approval_queue`, `channel_posts`) | suy đoán — chưa chứng minh có/không |
| Đổi quyền/role | `roles.sql` chạy trong fixture | grant trong `samsam` nếu fixture không rollback | suy đoán |

## 3. Cấu hình server dev (C — đọc qua DB test, 22/10/2026)

- Postgres 17.6; `listen_addresses = localhost`; `ssl = off`; `pg_hba`:
  `local`/`host 127.0.0.1`/`::1` đều `scram-sha-256` (không mở mạng ngoài).
- Role `.env` = `postgres` (SUPERUSER) — mật khẩu TRÙNG giá trị lộ (S01).
- `log_statement = none`, `log_connections/disconnections = off`,
  `log_line_prefix = '%t '` (không có tên DB/user), không có `pgaudit`.
- Tệp log server có: `postgresql-2026-10-18_000000.log` (sửa tới 20/10
  23:20 +07), `postgresql-2026-10-20_000000.log` (217 KB), `…-10-21_…` —
  CHỈ ghi lỗi/cảnh báo, không ghi câu lệnh thành công, không ghi tên DB →
  không chứng minh được có/không ghi vào `samsam`.

## 4. Còn thiếu để kết luận (chính xác)

1. Bản backup/dump `samsam` có trước 20/10/2026 03:03 UTC (baseline) — chưa
   có trong evidence; DBA/quản trị viên cung cấp nếu tồn tại.
2. Dữ liệu `samsam` hiện tại (đọc trên BẢN SAO restore cô lập, không trên DB
   thật) để so với (1).
3. Log câu lệnh phiên 20/10 — KHÔNG tồn tại (`log_statement=none`); tệp log
   lỗi 20/10 có thể chứa lỗi kèm giờ (không tên DB) — đọc nội dung cần quản
   trị viên cho phép.
4. Dấu vết riêng của `samsam` chưa đọc: `agent_action_log` + `verify_action_log()`,
   `job_runs`, `red_alerts`… theo `ts` trong khung mục 1 — cần quyền đọc (bản sao).

## 5. Gói kiểm chỉ đọc (quản trị viên/DBA chạy trên BẢN SAO cô lập)

Không chạy lại test gây sự cố trên DB thật; không sửa/xóa dữ liệu để đối chiếu.

1. Restore bản backup trước sự cố → `samsam_baseline_copy`; dump hiện tại →
   `samsam_now_copy` (DB riêng, không mở cho ứng dụng).
2. Mỗi bảng `public`: so `count(*)`, `max(id)`, `max(ts|created_at)` hai bản;
   liệt kê dòng `ts` ∈ [2026-10-20 03:03:38, 03:28:30] UTC ở bản hiện tại:
   `job_runs`, `red_alerts`, `red_alert_deliveries`, `red_alert_acks`,
   `agent_action_log`, `approval_queue`, `intel_items`, `channel_posts`,
   `llm_usage`, `san_suggestions`, `chat_kpi_live`, `file_output_evidence`.
3. `select * from verify_action_log()` trên cả hai bản (chuỗi hash).
4. So quyền: `information_schema.role_table_grants`/`column_privileges`/
   `routine_privileges` + `pg_roles` (thuộc tính, thành viên) hai bản.
5. So schema: `pg_dump --schema-only` hai bản (diff).
6. Kết quả ghi vào sổ nghĩa vụ/biên bản (không chép dữ liệu khách). Có dòng lạ
   → DBA Bên B quyết xử lý; agent không tự xóa.

Không có (1) → trạng thái giữ **UNVERIFIED** vĩnh viễn cho khung này; ghi rõ
trong hồ sơ nghiệm thu là ngoại lệ đã biết.
