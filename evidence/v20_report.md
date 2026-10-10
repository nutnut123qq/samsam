# Báo cáo định kỳ — Sâm Sâm AI

**Kỳ:** 2026-10-03 → 2026-10-10 (7 ngày, UTC) · **Sinh lúc:** 2026-10-10T16:48:10Z · **Nguồn:** `agents/report.py`

> **BẢN NHÁP — người duyệt trước khi gửi lãnh đạo.** Hệ thống KHÔNG tự gửi Zalo/email (human-gate C2.4). Mục *(mẫu)* = dữ liệu mẫu chờ công ty bàn giao (SOW §5.2), không phải số vận hành thật.

## 1. Bán hàng *(mẫu)*

| Chỉ số | Kỳ này | Kỳ trước |
|---|---|---|
| Đơn hàng | 3 | 2 |
| Doanh thu | 6.720.000 ₫ | 2.280.000 ₫ |

- Theo kênh: showroom 2 đơn / 5.540.000 ₫ · zalo 1 đơn / 1.180.000 ₫
- Trạng thái: done=2, new=1
- Top doanh thu: Ngoài catalog (1 sp / 5.000.000 ₫); SAPHRATON (5 sp / 1.180.000 ₫); SAVINA TUÝP 12 VIÊN (3 sp / 540.000 ₫)

## 2. Leads (kênh chat)

- Mới trong kỳ: **30** (kỳ trước: 0) · Tổng: 30 · **Chờ xử lý (new): 30**
- Intent: contact=14, order=2, price=14
- Kênh: streamlit=6, zalo=24
- Câu hỏi mới nhất trong kỳ:
  - `2026-10-08` [zalo/price] Saphraton giá bao nhiêu?
  - `2026-10-08` [zalo/contact] Sâm Sâm có showroom ở đâu?
  - `2026-10-07` [zalo/contact] Sâm Sâm có showroom ở đâu?
  - `2026-10-07` [zalo/price] Saphraton giá bao nhiêu?
  - `2026-10-07` [zalo/contact] Sâm Sâm có showroom ở đâu?

## 3. Kênh chat (convlog)

- Tin nhắn trong kỳ: **45** — tỉ lệ trả lời được: 62% (28/45)
- Toàn thời gian: 45 tin, trả lời 62% — Zalo/Streamlit trong kỳ: 39/6

## 4. Vùng trồng *(mẫu)*

- Đang quản: 3 khoảnh (≈5.300 cây)
- Nhật ký trong kỳ: **6** hoạt động
  - Theo khoảnh: KV-A01=2, KV-A02=2, KV-B01=2
  - Theo hoạt động: bón=1, ghi nhận=1, kiểm tra sâu bệnh=1, làm cỏ=1, trồng=1, tưới=1
- ⚠️ Cần chú ý: `2026-10-07` KV-A01 — kiểm tra sâu bệnh: Phát hiện rệp vùng rìa khoảnh, đã phun thuốc sinh học

## 5. Social metrics

- *Chờ bàn giao:* creds Fanpage/TikTok/Zalo OA (Phụ lục C — điều kiện tiên quyết phía công ty). Mục này tự điền khi có nguồn; hệ thống KHÔNG tự lấy/gửi gì ra ngoài.

## 6. Nguồn dữ liệu

- `orders`: 5 row — sample:sample_orders.jsonl=5 *(mẫu)*
- `leads`: 30 row — conversations.jsonl=30
- `plot_logs`: 6 row — sample:sample_plot_logs.jsonl=6 *(mẫu)*
- `plots`: 3 row — sample:sample_plots.jsonl=3 *(mẫu)*
- `conversations.jsonl`: 45 record (+0 bỏ qua)

---
*Sinh tự động bởi agent báo cáo định kỳ (`python -m agents.report`). Kiểm chứng số liệu trước khi trích dẫn ra ngoài.*
