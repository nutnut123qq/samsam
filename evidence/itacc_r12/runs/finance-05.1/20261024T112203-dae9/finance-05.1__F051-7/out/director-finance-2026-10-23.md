> **CHẠY THỬ — KHÔNG GỬI.** Tính năng finance-03.1 đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.

# Bản tin GĐ Giám đốc tài chính + Phòng kế toán + Phòng tài chính–kế hoạch — 23/10/2026

Agent: FIN-Director (CFO agent điều phối) · khối `finance` · giờ VN

## Số liệu trong ngày

| Chỉ số | Số |
|---|---|
| Mới vào hàng | 0 |
| Đang chờ duyệt (tồn) | 0 |
| Đã duyệt | 0 |
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

## Công nợ đại lý quá hạn (tính tới 23/10/2026)

- (không có)

## P&L tháng 10/2026

- Tổng thực nhận: 0đ (0 dòng quyết toán trong tháng)
- Tổng lãi gộp (chỉ ô có giá vốn duyệt): 0đ
- 0 SKU chưa có giá vốn duyệt: (không có)
- BẢN NHÁP — chi tiết: `python -m agents.fp_pnl --pnl --month 2026-10`

## Chi phí vận hành tháng 10/2026

- [CẢNH BÁO 80%] `ai`: 4.200.000đ / trần 5.000.000đ
- [CẢNH BÁO 80%] `cloud`: 3.500.000đ / trần 4.000.000đ
- [VƯỢT TRẦN 100%] `saas`: 7.500.000đ / trần 7.000.000đ
- Khoản > ngưỡng X (5.000.000đ) đang chờ TGĐ ký: 1
- Trần/ngưỡng là GIẢ ĐỊNH (`data/fpa_config.json`) — agent không chi, không tắt key

## Dòng tiền 13 tuần

- Tuần đầu tiên số dư kịch bản thấp < 0đ: (không có)
- Số tuần âm ở kịch bản thấp: 0/13
- Số dư cuối kỳ (tuần 11/01): thấp 338.144.400đ · cơ sở 663.868.900đ · cao 1.036.675.750đ
- chưa có số dư đầu kỳ thật — số dư = dòng tiền ròng lũy kế từ 0
- Khoảng trên GIẢ ĐỊNH — chi tiết: `python -m agents.fp_cash --forecast`

## Đề xuất ngân sách ads

- Mục `budget_change` đang chờ duyệt: 0 — ĐỀ XUẤT, agent không chi tiền; duyệt qua `python -m pipelines.approval_queue`

## Người duyệt

- Vai trò duyệt: tgd
- Người duyệt chưa cấu hình (external-dep)
- Người nhận bản tin chưa cấu hình (external-dep)

---
*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay cho GĐ khối.*
