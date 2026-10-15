# JD + KPI 2 người vận hành hệ thống AI (NHÁP)

> **NHÁP — chờ TGĐ duyệt (lương công ty trả riêng, ngoài 1 tỷ).** Mức lương, phụ cấp trực, ngưỡng
> KPI là ĐỀ XUẤT theo plan_data_platform §2/§7 và plan_legal_hr §5 — TGĐ chốt. Chưa điền tên người.
> Mọi KPI trỏ tới lệnh/bảng CÓ THẬT trong repo; KPI chưa có công cụ đo ghi "CHƯA ĐO ĐƯỢC" + WP sẽ build.

Người phụ trách: {{ho_ten_quan_ly_ha_tang}} · {{ho_ten_quan_ly_mxh}} · Ngày hiệu lực: {{ngay_hieu_luc}}

## 1. Quản lý hạ tầng AI — 15 triệu/tháng (vai trò `ha_tang` trong `pipelines/auth.py`)

**Mục tiêu vị trí:** giữ hệ thống AI chạy ổn định, an toàn dữ liệu, trong trần chi phí.

**Việc chính:**

- Vận hành LLM gateway (`pipelines/llm_gateway.py`): mask PII, kill-switch, trần chi phí, whitelist nhà cung cấp.
- Vận hành DB, backup + diễn tập khôi phục, lịch chạy job (cron), quản lý secret ngoài repo.
- Thực thi gỡ nội dung trên web khi có lệnh bằng văn bản của Pháp chế/TGĐ (không tự quyết nội dung).
- Báo sự cố dữ liệu cho Pháp chế/TGĐ trong 1 giờ kể từ khi phát hiện (mốc báo cơ quan nhà nước do Pháp chế quyết).
- Cập nhật `data/data_flow_map.json` khi thêm luồng dữ liệu mới, chạy lại `python scripts/dpia_draft.py`.

**Không được:** duyệt nội dung marketing, sửa bản đã approve, đọc log hội thoại ngoài mục đích vận hành.

| Chỉ tiêu | Ngưỡng | Nguồn đo |
|---|---|---|
| Bản tin sức khỏe hằng ngày sạch | 0 mục "CẢNH BÁO"/"ĐÃ CHẶN", không "DB không truy cập được" | `python scripts/health_bulletin.py` |
| Job định kỳ 24h chạy thành công | 100% job có `ok` true | `job_runs` |
| Eval guardrail đạt | PASS mỗi lần đổi code guardrail | `python scripts/agent_eval.py --agent guardrail` · `eval_runs` |
| Backup + diễn tập khôi phục | Backup hằng ngày; diễn tập ≥1 lần/tháng thành công | `python scripts/db_backup.py` · `python scripts/db_restore_drill.py` |
| Chi phí AI trong trần | Không agent nào ≥100% trần tháng | `llm_usage` |
| Bản đồ luồng dữ liệu khớp code | Test drift-guard xanh, DPIA/TIA đồng bộ | `python scripts/dpia_draft.py --check` |
| Báo sự cố dữ liệu trong 1 giờ | 100% sự cố | CHƯA ĐO ĐƯỢC — chưa có sổ sự cố (WP05/WP hạ tầng sẽ build) |

## 2. Quản lý mạng xã hội – sàn — 10 triệu/tháng (vai trò `mxh` trong `pipelines/auth.py`)

**Mục tiêu vị trí:** đăng đúng bản đã duyệt, đúng lịch, xử lý nhanh nội dung vi phạm.

**Việc chính:**

- Chỉ đăng bản đã approve (đúng nội dung, đúng mã băm); gắn nhãn "Nội dung có sử dụng AI" + nhãn "Quảng cáo"/"Hợp tác" khi cần.
- Xếp lịch đăng, nạp file xuất từ sàn (Seller Center) vào hệ thống, theo dõi cảnh báo sàn.
- Tuyến 1 trực GỠ/ẨN bài, bình luận vi phạm theo ủy quyền bằng văn bản của Pháp chế; báo lại Pháp chế trong ngày.

**CẤM:** đăng bản chưa duyệt; sửa nội dung sau khi đã approve; approve thay người duyệt (Chuyên viên Pháp chế) dưới mọi hình thức, kể cả khi người duyệt vắng — pending giữ nguyên.

| Chỉ tiêu | Ngưỡng | Nguồn đo |
|---|---|---|
| Hàng duyệt không quá tải do tồn đăng | Không cảnh báo "QUÁ TẢI" kéo dài >2 ngày | `python scripts/review_load.py` |
| Lịch đăng đầy đủ | Không ngày trống trong lịch tuần | `python -m pipelines.store --calendar` |
| Cảnh báo sàn S1 đóng trong ngày | 100% cảnh báo S1 đóng trong ngày phát sinh | `python -m ingest.market_csv --report` · `market_alerts` |
| 0 bài đăng lệch bản approve | 0 bài lệch mã băm | `approvals` (hàm SQL verify_publish) · `channel_posts` (mã lech_ban_duyet, rà từ file xuất tay v4.3) |
| Ticket gỡ/ẩn trong 24 giờ | 100% ticket | `python -m agents.ra_kenh --report` (ticket gỡ 24h: khối QUÁ 24H + số đóng đúng hạn/trễ) · `channel_posts` — kết quả quét chưa được Pháp chế xác nhận; leo thang S2 sau 2 giờ (A0-3) chưa build |
| Tỷ lệ hậu kiểm việc gỡ theo ủy quyền | 100% được Pháp chế hậu kiểm | CHƯA ĐO ĐƯỢC — chưa có sổ hậu kiểm ủy quyền (WP05 sẽ build) |
| Bài kiểm tra tuân thủ quảng cáo | Đạt ≥ 80% trên bộ ≥20 câu | CHƯA ĐO ĐƯỢC — chưa có bộ câu hỏi (WP05 đào tạo sẽ build) |

## 3. Ký duyệt (để trống)

| Vai trò | Họ tên | Chữ ký | Ngày |
|---|---|---|---|
| Tổng giám đốc | {{ho_ten_tgd}} | {{chu_ky_tgd}} | {{ngay_ky_tgd}} |
