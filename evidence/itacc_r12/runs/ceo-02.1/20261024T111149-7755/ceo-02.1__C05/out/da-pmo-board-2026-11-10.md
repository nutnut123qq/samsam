# Bảng tiến độ triển khai — tuần 2026-W46 (ngày 10/11/2026)

| Mã | Việc | Owner | Hạn | Gate | Evidence | Trạng thái |
|---|---|---|---|---|---|---|
| DA-01 | DA-01 PMO tiến độ go-live (sổ mốc + bảng tuần) | tgd | 24/10/2026 | Bảng tuần sinh từ project_milestones, mốc trễ tô TRỄ, nhắc T-7/T-2 | BB-THU-IT-01 | xong |
| MOC-A | Mốc A — dữ liệu chuẩn 100% sản phẩm, kiểm duyệt nội dung, backup hằng ngày | ben_a | 31/10/2026 | Golden master đủ 100% sản phẩm đã được Bên B xác nhận; kiểm duyệt nội dung tự động chạy trên mọi đầu ra; backup hằng ngày có job_runs thành công + bản sao ngoà… | chưa có | **TRỄ** (chua_bat_dau) |
| MOC-B | Mốc B — đăng nhập, phân quyền duyệt, kiểm thử tự động | ben_a | 07/11/2026 | Đăng nhập + phân quyền duyệt theo văn bản ủy quyền của Bên B (approvers 9 khối); bộ kiểm thử tự động chạy trước mỗi thay đổi (deploy_gate) | chưa có | **TRỄ** (chua_bat_dau) |
| DUYET-1111 | Duyệt chạy mùa 11.11 — TGĐ Bên B ký cho phép chạy | ben_b_tgd | 09/11/2026 | Văn bản cho phép chạy có chữ ký TGĐ Bên B — agent không ký thay, không coi bảng tuần là văn bản cho phép | chưa có | **TRỄ** (chua_bat_dau) |
| KD-A3-FORM | Form B2B quà Tết mở (KD-A3) | gd_ban_hang | 16/11/2026 | Form B2B mở trước 16/11; tài liệu chào hàng chỉ gồm SKU được phép theo golden (food, tpbvsk đã XNQC) | chưa có | chua_bat_dau |
| DA-05 | DA-05 danh sách tổ chức mua quà Tết go-live | gd_ban_hang | 21/11/2026 | org_prospects không PII, dedup b2b:hash; không agent nào tự liên hệ tổ chức | chưa có | chua_bat_dau |
| KH-NAM-2027-TRINH | Kế hoạch năm 2027 — Bên A trình kế hoạch + ngân sách | ben_a | 30/11/2026 | Bản kế hoạch + ngân sách năm sau Bên A gửi Bên B (bằng chứng gửi do người gửi xác nhận) | chưa có | chua_bat_dau |
| MOC-C | Mốc C — diễn tập khôi phục dữ liệu lần 1 | ben_a | 30/11/2026 | Biên bản diễn tập khôi phục lần 1 (db_restore_drill/dr_drill) có người Bên B chứng kiến | chưa có | chua_bat_dau |
| MOC-D | Mốc D — sẵn sàng đóng băng, diễn tập khôi phục lần 2 | ben_a | 18/12/2026 | Biên bản diễn tập khôi phục lần 2; danh sách thay đổi đã khóa trước đóng băng | chưa có | chua_bat_dau |
| TT3 | TT3 — nghiệm thu Mốc D (WP11 ký) | tgd | 23/12/2026 | TGĐ và GĐ bán hàng ký nghiệm thu WP11 | chưa có | chua_bat_dau |
| KH-NAM-2027-DUYET | Kế hoạch năm 2027 — Bên B duyệt kế hoạch + ngân sách | ben_b_tgd | 31/12/2026 | Văn bản Bên B duyệt kế hoạch + ngân sách năm sau | chưa có | chua_bat_dau |
| P1-XAY-DUNG | Kết thúc xây dựng P1 (dự kiến, 03 tháng kể từ ngày ký) | ben_a | 11/01/2027 | Ngày DỰ KIẾN theo lịch PL01 mục 6 — ngày thực = ngày ký + 03 tháng (ngày ký chưa chốt). KHÔNG phải nghiệm thu P1 | chưa có | chua_bat_dau |
| DONG-BANG | Đóng băng qua Tết 21/12/2026–10/02/2027 — chỉ sửa lỗi khẩn, trực sự cố | ben_a | 10/02/2027 | Chỉ thay đổi hotfix/break-glass qua deploy_gate (data/freeze_calendar.json); lịch trực sự cố có người | chưa có | chua_bat_dau |
| NGHIEM-THU-P1 | Nghiệm thu P1 11/02–20/02/2027 — hai bên ký biên bản | hai_ben | 20/02/2027 | Biên bản nghiệm thu P1 hai bên ký (mẫu PL05 chưa có); hồ sơ `pipelines.rollout --dossier --phase P1` chỉ là ĐỀ NGHỊ, không tự tính là đã nghiệm thu | chưa có | chua_bat_dau |
| API-SAN | Kết nối API sàn chỉ đọc (tháng 02–03/2027) | ben_a | 31/03/2027 | Thay xuất/nhập file tay; chữ ký/endpoint/field xác minh bằng sandbox chính thức (Bên B cấp app key chỉ đọc) | chưa có | chua_bat_dau |

## Mốc trễ

- **TRỄ** MOC-A — hạn 31/10/2026 (trễ 10 ngày, chua_bat_dau)
- **TRỄ** MOC-B — hạn 07/11/2026 (trễ 3 ngày, chua_bat_dau)
- **TRỄ** DUYET-1111 — hạn 09/11/2026 (trễ 1 ngày, chua_bat_dau)

## Nhắc hạn hôm nay

- (không có)

## Mốc chưa có ngày (chờ ngày ký / hai bên chốt)

| Mã | Việc | Owner | Hạn theo HĐ | Blocker |
|---|---|---|---|---|
| BAN-GIAO-DAU-VAO | Bàn giao hồ sơ, dữ liệu đầu vào (khoản 4 Điều 2 HĐ) | ben_b | Trong 05 ngày kể từ ngày ký | Ngày ký HĐ chưa chốt trong repo — không tính được hạn |
| HA-TANG | Bảo đảm hạ tầng (server, thiết bị, đường truyền) + Bên A cài đặt | hai_ben | Khi bắt đầu triển khai | Ngày bắt đầu triển khai chưa chốt; server Bên B chưa bàn giao |
| BLOCKCHAIN | Truy xuất blockchain — neo mã xác thực nhật ký vườn, hồ sơ lô; tem QR | ben_a | ……/2027 (HĐ để trống) | HĐ chưa ghi tháng; hai bên chọn chuỗi/provider/phí (data/anchor_config.json provider 'none') |
| NGHIEM-THU-P2 | Nghiệm thu P2 — hai bên ký biên bản | hai_ben | Trước khi hết năm hợp tác thứ nhất | Năm hợp tác tính từ ngày ký (data/rev_share.json ngay_ky_hop_dong null) — chưa tính được hạn; mẫu biên bản PL05 chưa có |
| DANH-GIA-NAM | Đánh giá năm — ký biên bản đánh giá kết quả năm (năm 2–5) | hai_ben | Hằng năm, năm thứ 2 đến năm thứ 5 | Phụ thuộc ngày ký HĐ (chưa chốt) |

---
*BẢN NHÁP — agent không tự gửi; TGĐ chốt trạng thái/hạn (đổi hạn qua hàng duyệt).*
