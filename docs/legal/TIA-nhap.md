# TIA — Đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài (NHÁP)

> **BẢN NHÁP — chưa có giá trị pháp lý; chờ Chuyên viên Pháp chế ký, luật sư rà — agent không kết luận tuân thủ.**
> Sinh tự động bởi `python scripts/dpia_draft.py` từ `data/data_flow_map.json` (bản đồ rà từ code ngày 2026-10-12). KHÔNG sửa tay — sửa map rồi chạy lại (`--check` bắt lệch).
> Căn cứ: Luật BVDLCN 91/2025/QH15 (chuyển dữ liệu xuyên biên giới phải có hồ sơ đánh giá tác động) + NĐ 356/2025; khung mục theo cấu trúc NĐ 13/2023 Điều 25 — CẦN LUẬT SƯ XÁC NHẬN.

## 1. Bên chuyển dữ liệu

- Tên doanh nghiệp: {{ten_cong_ty}}
- Người phụ trách bảo vệ dữ liệu cá nhân: {{nguoi_phu_trach_dlcn}}

## 2. Đánh giá từng luồng chuyển ra nước ngoài

### DF-06 — Chatbot RAG gửi câu hỏi tới LLM qua gateway (OpenRouter)

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) → nhà cung cấp trong whitelist `provider_only` của data/llm_gateway.json (openai, azure — Mỹ) |
| Dữ liệu gửi đi (sau biện pháp) | Câu hỏi thường SAU `_mask_pii` + history 4 lượt gần nhất (cũng mask) + đoạn KB public làm ngữ cảnh |
| Lớp | Vàng |
| Mục đích | CSKH — sinh câu trả lời có nguồn |
| Biện pháp kỹ thuật | `_mask_pii` ở gateway cho MỌI message (system/history/user) và input embedding; `is_health_question` chặn câu hỏi sức khỏe TRƯỚC LLM (chuyển người); Provider routing data_collection=deny, zdr=true, allow_fallbacks=false, only=whitelist (fail-closed); Kill-switch + trần chi phí theo agent |
| Thời hạn lưu (theo map) | Phía hệ thống: theo nhật ký hội thoại (30 ngày); phía nhà cung cấp: không lưu theo cấu hình zdr — chưa kiểm chứng bằng hợp đồng |
| Rủi ro tồn dư | Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài; Bảng `consents` có (v5.2) nhưng CHƯA gắn kênh chat — chưa có bản ghi đồng ý trước lượt gọi LLM; Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà |
| Căn cứ | Đồng ý cho chuyển dữ liệu ra nước ngoài — CHƯA có cơ chế ghi nhận trong code: GAP; hồ sơ TIA (bản nháp này) — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-07 — Content Studio sinh nháp nội dung qua gateway

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) → whitelist provider (Mỹ) |
| Dữ liệu gửi đi (sau biện pháp) | Brief do nhân viên nhập (quy trình: không đưa dữ liệu khách), claim đã duyệt, nháp nội dung |
| Lớp | Vàng |
| Mục đích | Soạn nháp nội dung marketing chờ người duyệt |
| Biện pháp kỹ thuật | `_mask_pii` ở gateway; `guardrail.check()` trước khi hiển thị/lưu; Duyệt người thật (approve_draft) trước khi đăng |
| Thời hạn lưu (theo map) | Không giới hạn — hồ sơ duyệt append-only (bằng chứng tuân thủ quảng cáo) |
| Rủi ro tồn dư | Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email) |
| Căn cứ | Lợi ích hợp pháp/hợp đồng lao động với nhân viên — CẦN LUẬT SƯ XÁC NHẬN — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-08 — Embedding KB public

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) — embeddings |
| Dữ liệu gửi đi (sau biện pháp) | Đoạn văn bản public (sản phẩm, bài viết) đã crawl |
| Lớp | Xanh |
| Mục đích | Tạo vector tìm kiếm cho chatbot |
| Biện pháp kỹ thuật | Qua gateway (mask + routing); `kb_filter` loại nội dung rượu/phóng đại |
| Thời hạn lưu (theo map) | Thay khi nạp lại |
| Rủi ro tồn dư | (không) |
| Căn cứ | Không xử lý dữ liệu cá nhân — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-09 — KB nội bộ (tài liệu nội bộ đã duyệt)

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) — embeddings qua gateway |
| Dữ liệu gửi đi (sau biện pháp) | Tài liệu nội bộ đã duyệt (quy trình, chính sách) — có thể nhắc tên nhân viên |
| Lớp | Vàng |
| Mục đích | Trợ lý nội bộ tra cứu tài liệu |
| Biện pháp kỹ thuật | Qua gateway (`_mask_pii` input embedding); Bảng riêng, phân quyền theo collection |
| Thời hạn lưu (theo map) | Thay khi nạp bản mới (theo doc_sha256) |
| Rủi ro tồn dư | Tên nhân viên trong tài liệu không bị mask khi embedding |
| Căn cứ | Lợi ích hợp pháp — CẦN LUẬT SƯ XÁC NHẬN — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-12 — Bản tin sức khỏe hệ thống

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | Khi `--notify`: máy chủ SMTP cấu hình (email) hoặc Telegram (api.telegram.org — nước ngoài) |
| Dữ liệu gửi đi (sau biện pháp) | Chỉ số tổng hợp vận hành (job, eval, chi phí, số mục) — không có dữ liệu cá nhân |
| Lớp | Xanh |
| Mục đích | Giám sát vận hành |
| Biện pháp kỹ thuật | Mặc định KHÔNG gửi — cần `--notify` + env kênh; Chỉ số tổng hợp, không nội dung chat |
| Thời hạn lưu (theo map) | Không giới hạn (file báo cáo) |
| Rủi ro tồn dư | (không) |
| Căn cứ | Không xử lý dữ liệu cá nhân — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

## 3. Luồng không thuộc TIA

Không thuộc TIA (không chuyển ra nước ngoài theo code hiện tại): DF-01, DF-02, DF-03, DF-04, DF-05, DF-10, DF-11, DF-13, DF-14, DF-15, DF-18.

## 4. Ký duyệt

Chưa ai ký — ô để trống chờ người thật.

| Vai trò | Họ tên | Chữ ký | Ngày ký |
|---|---|---|---|
| Chuyên viên Pháp chế | {{ho_ten_phap_che}} | {{chu_ky_phap_che}} | {{ngay_ky_phap_che}} |
| Luật sư rà soát | {{ho_ten_luat_su}} | {{chu_ky_luat_su}} | {{ngay_ky_luat_su}} |
| Tổng giám đốc | {{ho_ten_tgd}} | {{chu_ky_tgd}} | {{ngay_ky_tgd}} |
