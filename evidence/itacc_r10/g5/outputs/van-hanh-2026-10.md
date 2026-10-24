> **CHẠY THỬ — KHÔNG GỬI.** Tính năng data_platform-08 đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.

# Báo cáo vận hành tháng 10/2026

_Sinh lúc 23/10/2026 10:54 giờ VN. Hạn gửi Bên B: trước ngày 05/11/2026 (PL02 mục 3). Số do code tính từ bảng/file nêu ở cột Nguồn, không dùng LLM; báo cáo chỉ đọc, không tự gửi._

> **THÁNG CHƯA ĐÓNG** — số tạm tính tới 23/10/2026 10:54.

## 1. KPI vận hành hằng tháng (PL02 mục 3)

| Chỉ tiêu | Yêu cầu | Kết quả | Đánh giá | Bên chịu trách nhiệm | Nguồn |
|---|---|---|---|---|---|
| Câu hỏi khách xử lý trong 2 giờ làm việc | ≥ 90% | — (0/0) | — (không có mục tới hạn) | Bên B | convlog `conversations.jsonl` + `approval_queue` (`cskh_handoff`), ca `data/directors/sales.json` |
| Báo động đỏ xác nhận trong 2 giờ | 100% | — (0/0) | — (không có mục tới hạn) | Bên B | `red_alerts` (bỏ bản leo thang) + `red_alert_acks` |
| Lệnh gỡ bài vi phạm xong trong 24 giờ | 100% | — (0/0) | — (không có mục tới hạn) | Bên B | `channel_posts` (đợt vi phạm, `agents.ra_kenh`) |
| Bài đăng chưa được duyệt | 0 | chưa có dữ liệu (không có lần rà kênh nào trong tháng) | — | Hai Bên | `channel_posts` (rà kênh sở hữu trong tháng) |
| Rượu/TPBVSK chưa đủ giấy lên quảng cáo | 0 | chưa có dữ liệu (không có lần rà kênh nào trong tháng) | — | Hai Bên | `channel_posts` (rà kênh sở hữu trong tháng) |
| Báo cáo vận hành tháng 09/2026 gửi Bên B | Trước ngày 05 | chưa có xác nhận gửi (người gửi chạy `--mark-sent`) | — | Bên A | `agent_action_log` `ops_report_sent` (người gửi xác nhận) |

- Câu hỏi khách: bot trả lời 0, chuyển người 0 (trễ 0, chưa tới hạn 0).
- Báo động đỏ: 0 cảnh báo gốc, đúng hạn 0, trễ/chưa xác nhận 0, chưa tới hạn 0.
- Gỡ/sửa bài: 0 đợt vi phạm phát hiện trong tháng, xong đúng hạn 0, trễ 0, chưa tới hạn 0.
- Quảng cáo trả phí/KOC/livestream ngoài kênh sở hữu: chưa có dữ liệu (chỉ rà file xuất kênh sở hữu) — hai chỉ tiêu bài đăng/quảng cáo KHÔNG được coi là đạt cho phần này.
- Cảnh báo đỏ gốc trong tháng: đều có lần gửi thành công (`red_alert_deliveries`).
- Convlog không tính KPI vận hành: 0 dòng thử nghiệm (mock/replay/demo/mẫu), 45 dòng thiếu provenance (ghi trước bản vá v15 — không suy ngược).

## 2. Tiêu chí kỹ thuật (PL02 mục 2)

| Chỉ tiêu | Yêu cầu | Kết quả | Nguồn |
|---|---|---|---|
| Backup dữ liệu thành công | 100% số ngày | chưa có dữ liệu (chưa cấu hình `BACKUP_DIR` hoặc chưa có nhật ký) | `backup_runs.jsonl` |
| Diễn tập khôi phục | 30/11/2026, 18/12/2026, sau đó mỗi quý | chưa có dữ liệu (chưa có nhật ký diễn tập) | `drill_runs.jsonl`, `dr_runs.jsonl` |
| Phản hồi tự động của chatbot | ≤ 30 giây | chưa đo (không có `reply_ms` trong convlog tháng — bản ghi trước v12.4 không đo) | convlog |
| Chi phí AI tháng | trong trần `data/llm_gateway.json` | 0.0128 USD / 19 lời gọi | `llm_usage` |
| Phát hiện sự cố hệ thống | ≤ 15 phút | sổ sự cố không có sự cố phát hiện trong tháng (không phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi) | `ops_incidents` + `ops_incident_events` |
| Phản hồi lỗi nghiêm trọng | ≤ 03 giờ | sổ sự cố không có sự cố phát hiện trong tháng (không phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi) | `ops_incidents` + `ops_incident_events` |
| Phản hồi lỗi thường | ≤ 03 ngày làm việc | sổ sự cố không có sự cố phát hiện trong tháng (không phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi) | `ops_incidents` + `ops_incident_events` |
| Sửa lỗi phát sinh | ≤ 07 ngày | sổ sự cố không có sự cố phát hiện trong tháng (không phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi) | `ops_incidents` + `ops_incident_events` |

- CẢNH BÁO: lịch nghỉ lễ/Tết chưa chốt (`data/rollout_config.json` holidays rỗng) — ngày làm việc đang tính T2–T6 kể cả ngày lễ; chờ Hành chính Sâm Sâm chốt, KHÔNG tự điền.
- AI `it_g5_fixture`: 0.0100 USD, 1 lời gọi, lỗi 0.
- AI `ingest`: 0.0028 USD, 15 lời gọi, lỗi 0.
- AI `smoke`: 0.0000 USD, 3 lời gọi, lỗi 0.

## 3. Danh mục tài sản hợp tác (PL04 mục 3)

_Nguồn: `data/tai_san_hop_tac.json` (cập nhật 15/10/2026; trạng thái kiểm kê: cho_xac_nhan)._

Người giữ quyền cao nhất: Bên B — người do TGĐ Bên B chỉ định (chưa xác nhận); Bên A chỉ được cấp quyền vận hành (PL01 mục 8b).

| Hạng mục | Mô tả | Nơi lưu giữ | Bên quản lý | Vị trí | Phiên bản | Chủ quản | Quyền truy cập |
|---|---|---|---|---|---|---|---|
| Mã nguồn Dự án | Mã nguồn các tính năng AI, nền tảng thương mại điện tử, truy xuất blockchain | Kho mã nguồn chung | Bên A | Kho git hiện hành của Bên A (nhánh main); kho chung mà HAI BÊN đều có quyền (PL01 mục 8c) chưa xác định — chưa xác nhận; mã website bán hàng ở repo riêng chưa xác định | Commit HEAD tại ngày báo cáo (scripts/ops_monthly.py ghi tự động); bản bàn giao chính thức chưa gắn tag | Đại diện dự án Bên A | Bên A: ghi; Bên B: quyền đọc/ghi trên kho chung chưa cấp — chưa xác nhận |
| Cấu hình, quy trình AI | Cấu hình hệ thống, prompt, luồng tự động, bộ kiểm thử | Kho mã nguồn chung | Bên A | Cùng kho mã nguồn (thư mục data/, docs/, tests/, deploy/); bí mật/khóa KHÔNG nằm trong kho — nằm ở .env trên server Bên B | Theo commit của kho mã nguồn | Đại diện dự án Bên A | Như mã nguồn; bí mật trên server do người giữ quyền cao nhất Bên B kiểm soát — chưa xác nhận |
| Tài liệu kỹ thuật | Sơ đồ hệ thống, hướng dẫn vận hành, tài liệu bàn giao | Kho tài liệu chung | Bên A | docs/handover/ trong kho mã nguồn; kho tài liệu chung hai bên chưa xác định — chưa xác nhận | Theo commit của kho mã nguồn | Đại diện dự án Bên A | Như mã nguồn — chưa xác nhận |
| Cơ sở dữ liệu Dự án | Dữ liệu sản phẩm, đơn hàng, nhật ký hệ thống | Server của Bên B | Bên B quản lý, Bên A vận hành | Postgres trên server vật lý Bên B (PL01 mục 8a) — server chưa bàn giao, hiện chạy môi trường dev của Bên A; bản sao ngoài hệ thống chưa xác nhận | Lược đồ docs/schema.sql theo commit; bản sao lưu theo scripts/db_backup.py | Quản trị hạ tầng Bên B (chưa chỉ định) | Owner DB: Bên B; Bên A: login vận hành (agent_writer/app_human); Bên A xem số: ben_a_reader — tạo login thật chưa làm (runbook-ha-tang mục 9) |
| Tài khoản quản trị cao nhất | Tài khoản server, tên miền, kênh bán hàng | Bên B giữ | Bên B | Chưa xác nhận — Bên B lập danh sách tài khoản (server, tên miền, Shopee/TikTok Shop, Zalo OA, Facebook) ngoài kho mã nguồn | Không áp dụng | Người giữ quyền cao nhất Bên B | Bên B giữ quyền cao nhất; Bên A được cấp quyền vận hành theo từng tài khoản — chưa xác nhận |

Không thuộc tài sản hợp tác (tài sản riêng Bên B): Server, thiết bị, Thương hiệu, Sản phẩm, Dữ liệu khách hàng.

Dữ kiện tự động của kho mã nguồn:
- Commit hiện tại: `16b33fc9b4f0e0ff45dbeab78972100909ec0340`
- Số module Python: 130; số file test: 176
- Tài liệu bàn giao `docs/handover/`: ban-giao-M31.md, dau-vao-va-quyet-dinh.md, doi-chieu-docx.md, ho-so-san-sang-chay-thu.md, jd-kpi-van-hanh.md, kien-truc.md, ma-tran-nghiem-thu.md, mau-ho-so-nghiem-thu.md, phu-luc-d.md, playbook-mkt.md, playbook-sales-admin.md, playbook-vuon.md, prompt-library.md, runbook-ha-tang.md, so-nghia-vu-hop-dong.md, sop.md, su-co-db-samsam.md, v13-board.md, workshops.md
