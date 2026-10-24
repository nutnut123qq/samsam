# Bản tin GĐ Tổng giám đốc + Hội đồng thành viên + Ban kiểm soát nội bộ — 23/10/2026

Agent: Agent Điều hành (Chief of Staff AI) · khối `ceo` · giờ VN

## Số liệu trong ngày

| Chỉ số | Số |
|---|---|
| Mới vào hàng | 3 |
| Đang chờ duyệt (tồn) | 1 |
| Đã duyệt | 2 |
| Từ chối | 0 |
| Hết hạn SLA (expired) | 0 |

## Sắp quá hạn (≤ 8 giờ)

- (không có)

## Hết hạn hôm nay (không ai duyệt — KHÔNG tự duyệt)

- (không có)

## Override QA hôm nay (ép trình bản QA FAIL)

- (không có)

## Nghiệm thu QA hôm nay

- (không có)

## Tiến độ & Sổ quyết định

Quyết định đang theo dõi (mở/đang làm): 2 · quá hạn thực hiện: 0 · ghi trong 7 ngày: 3

### Quyết định quá hạn thực hiện

- (không có)

### Mốc trễ (sổ mốc tiến độ)

- (không có)

### Việc chờ TGĐ quyết định / chờ ký

Chờ quyết định (hàng duyệt khối ceo — nguồn `approval_queue`):
- #3 weekly_board · Bảng tiến độ triển khai 2026-W46 — hạn 25/10/2026
Chờ ký (mốc cần văn bản ký, chưa xong kèm bằng chứng — nguồn `project_milestones`):
- DUYET-1111 · Duyệt chạy mùa 11.11 — TGĐ Bên B ký cho phép chạy — hạn 09/11/2026, phụ trách ben_b_tgd, chua_bat_dau
- MOC-C · Mốc C — diễn tập khôi phục dữ liệu lần 1 — hạn 30/11/2026, phụ trách ben_a, chua_bat_dau
- MOC-D · Mốc D — sẵn sàng đóng băng, diễn tập khôi phục lần 2 — hạn 18/12/2026, phụ trách ben_a, chua_bat_dau
- TT3 · TT3 — nghiệm thu Mốc D (WP11 ký) — hạn 23/12/2026, phụ trách tgd, chua_bat_dau
- NGHIEM-THU-P1 · Nghiệm thu P1 11/02–20/02/2027 — hai bên ký biên bản — hạn 20/02/2027, phụ trách hai_ben, chua_bat_dau
Chờ ký biên bản đối soát quý (số đề xuất đã ghi; sổ KHÔNG lưu chữ ký — nguồn `revenue_quarters`):
- (không có)

*Sổ quyết định do NGƯỜI ghi (`python -m agents.ceo_decisions --record --by`); agent chỉ đề xuất. Mốc trễ từ `project_milestones` (cùng luật bảng tiến độ DA-01).*

## Rủi ro pháp lý mở

Đỏ 2 · Vàng 11 · Xanh 0 · đã hết trong tuần: 0 (so với 16/10/2026)

| Mức | Mã | Rủi ro | Owner (vai trò) | Hạn | Xu hướng |
|---|---|---|---|---|---|
| ĐỎ | DPIA | DPIA/TIA chưa ký — 88 rủi ro tồn dư trong bản đồ luồng dữ liệu | phap_che | — | = |
| ĐỎ | TUYEN-CANH-BAO | Chưa có người nhận cảnh báo đỏ độc lập (data/red_alert_routing.json) | phap_che | — | = |
| VÀNG | XNQC-CHO-NOP:da-an-sam-30v | SKU TPBVSK da-an-sam-30v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |
| VÀNG | XNQC-CHO-NOP:sapentol-30v | SKU TPBVSK sapentol-30v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |
| VÀNG | XNQC-CHO-NOP:saphraton-20v | SKU TPBVSK saphraton-20v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |
| VÀNG | XNQC-CHO-NOP:saphraton-40v | SKU TPBVSK saphraton-40v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |
| VÀNG | XNQC-CHO-NOP:saphraton-80v | SKU TPBVSK saphraton-80v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |
| VÀNG | XNQC-CHO-NOP:saphraton-combo-2x20v | SKU TPBVSK saphraton-combo-2x20v chưa nộp hồ sơ XNQC — hạn đợt 2 30/11/2026, mốc phí 31/12/2026: 550.000 đồng/hồ sơ đến hết 31/12/2026, 1.100.000 đồng/hồ sơ từ 01/01/2027 (nguồn: https://cdn.haiphong.gov.vn/gov-hpg/6853/tintuc/2026/6/noi-dung639183431659039750.docx) | phap_che | 30/11/2026 | = |

…và 5 rủi ro khác (xem `python -m agents.ceo_risk --report`)

*Tính lại mỗi lần từ tracker Pháp chế (hồ sơ XNQC, bài kênh vi phạm, cảnh báo đỏ, DPIA, tuyến cảnh báo) — không nhập tay song song. Hồ sơ XNQC chưa có lịch sử trạng thái: xu hướng hồ sơ theo trạng thái hiện tại. Mức theo luật data/ceo_risk.json (BẢN DEV SOẠN, chờ Pháp chế duyệt) — agent không tư vấn pháp lý.*

## Audit outside-in (P1)

Bài/listing đang chạy so với bản đã duyệt: khớp 0/0 (—) · đã gỡ (ngoài mẫu số): 0 · đăng trước quy trình duyệt (ngoài mẫu số): 0 · cảnh báo giá sàn đang mở (price_mismatch): 0

| Kênh | Mẫu số | Khớp | Tỷ lệ tuân thủ | lech_ban_duyet | thieu_ban_duyet | khong_xac_dinh_sku | Ghi chú |
|---|---|---|---|---|---|---|---|
| shopee | 0 | 0 | — | 0 | 0 | 0 | chưa có dữ liệu quan sát (chỉ file xuất tay) |
| tiktok | 0 | 0 | — | 0 | 0 | 0 | chưa có dữ liệu quan sát (chỉ file xuất tay) |

Phát hiện theo mã: lech_ban_duyet 0 · thieu_ban_duyet 0 · khong_xac_dinh_sku 0

- (không có phát hiện)

### Giá & mô tả listing đang chạy so bản đã duyệt

- chưa có dữ liệu quan sát (file listing sàn chưa nạp)

*Tính lại tại lúc audit từ bài đang đăng (file xuất tay) + listing sàn (file Seller Center) so với bản duyệt (sha256 `approvals` / dòng đầu listing đã duyệt); giá so giá list ĐÃ DUYỆT còn hiệu lực ngày chụp file. GIỚI HẠN P1: mô tả chỉ so khi file xuất có cột mô tả (chưa có → không so được). Agent chỉ báo — không sửa/gỡ bài, không đổi listing/giá/voucher.*

## Người duyệt

- Vai trò duyệt: tgd
- Người duyệt chưa cấu hình (external-dep)
- Người nhận bản tin chưa cấu hình (external-dep)

---
*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay cho GĐ khối.*
