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
| Rủi ro tồn dư | Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài; Chưa có bản ghi đồng ý trước lượt gọi LLM; Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà |
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

### DF-16 — Thu tin thị trường tầng A/B (intel — v7.0)

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | Chỉ GET tới nguồn RSS tầng A/B trong `data/intel_sources.json`; tóm tắt LLM (mặc định TẮT) qua gateway → OpenRouter (Mỹ) |
| Dữ liệu gửi đi (sau biện pháp) | Tiêu đề + trích ≤300 ký tự + link tin RSS/Atom công khai (đã che SĐT/email); có thể nhắc tên người trong tin báo chí |
| Lớp | Xanh |
| Mục đích | Tình báo thị trường: tin về sâm, TPBVSK, đồ ăn giới trẻ, quảng cáo, đối thủ |
| Biện pháp kỹ thuật | robots.txt + delay ≥1s/host, chặn cứng sàn/MXH kể cả khi redirect; Chỉ tiêu đề + trích ≤300 ký tự, `_mask_pii` trước khi lưu; LLM tóm tắt chỉ chạy khi `llm.enabled` + `--llm`, qua gateway + guardrail; Bản tin v7.1 (`scripts/intel_bulletin.py --llm`): tóm tắt theo chủ đề CHỈ từ tiêu đề + trích đã lưu (≤300 ký tự/tin, bỏ link, ≤10 tin), cùng cờ `llm.enabled` (mặc định TẮT) + guardrail; bản tin là file nội bộ, không gửi |
| Thời hạn lưu (theo map) | Chưa có hạn lưu/purge — GAP |
| Rủi ro tồn dư | Chưa che họ tên người trong tiêu đề/trích tin (NER); Chưa có hạn lưu/purge `intel_items` |
| Căn cứ | Thông tin công khai; nếu bật LLM thì cần Pháp chế xác nhận — CẦN LUẬT SƯ XÁC NHẬN — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-17 — Nghiên cứu giả lập persona (v7.3)

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `persona_sim`) |
| Dữ liệu gửi đi (sau biện pháp) | Persona TỔNG HỢP (không dữ liệu khách thật), phương án sản phẩm/thông điệp, điểm số model |
| Lớp | Xanh |
| Mục đích | Loại bớt phương án truyền thông yếu trước khi thử thật |
| Biện pháp kỹ thuật | Cổng DPIA: `dpia_signed` false → từ chối chạy thật (exit 2, 0 lời gọi LLM); Validator đầu vào chặn persona <18 tuổi, key ngoài allowlist, PII; Mọi phương án qua guardrail trước khi gửi model |
| Thời hạn lưu (theo map) | Không giới hạn — lịch sử kiểm toán model/prompt/seed |
| Rủi ro tồn dư | (không) |
| Căn cứ | Không xử lý dữ liệu cá nhân thật; chạy sau khi DPIA ký — CẦN LUẬT SƯ XÁC NHẬN — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

### DF-21 — Nhận xét báo cáo TGĐ qua LLM (cockpit — v8.0, chỉ khi --llm)

| Mục | Nội dung |
|---|---|
| Bên nhận / nước | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `cockpit`, trần 0,5 USD/tháng) |
| Dữ liệu gửi đi (sau biện pháp) | metric_id + tên chỉ số + chiều tốt + xu hướng (tăng/giảm/không đổi) + nhãn kỳ — KHÔNG số tuyệt đối, KHÔNG PII |
| Lớp | Xanh |
| Mục đích | Viết phần nhận xét báo cáo tuần/tháng cho TGĐ bằng placeholder; code điền số |
| Biện pháp kỹ thuật | Mặc định TẮT — chỉ chạy khi `python -m agents.ceo_report --llm`; Prompt chỉ có metric_id/tên/chiều tốt/xu hướng, không số tuyệt đối; `ground()`: văn bản LLM còn chữ số/%/trăm-nghìn-triệu-tỷ ngoài placeholder → bị loại, dùng nhận xét theo luật; qua guardrail |
| Thời hạn lưu (theo map) | Theo file báo cáo local — chưa có hạn lưu riêng |
| Rủi ro tồn dư | (không) |
| Căn cứ | Không xử lý dữ liệu cá nhân — CẦN LUẬT SƯ XÁC NHẬN — Luật 91/2025: CẦN LUẬT SƯ XÁC NHẬN |

## 3. Luồng không thuộc TIA

Không thuộc TIA (không chuyển ra nước ngoài theo code hiện tại): DF-01, DF-02, DF-03, DF-04, DF-05, DF-10, DF-11, DF-13, DF-14, DF-15.

## 4. Ký duyệt

Chưa ai ký — ô để trống chờ người thật.

| Vai trò | Họ tên | Chữ ký | Ngày ký |
|---|---|---|---|
| Chuyên viên Pháp chế | {{ho_ten_phap_che}} | {{chu_ky_phap_che}} | {{ngay_ky_phap_che}} |
| Luật sư rà soát | {{ho_ten_luat_su}} | {{chu_ky_luat_su}} | {{ngay_ky_luat_su}} |
| Tổng giám đốc | {{ho_ten_tgd}} | {{chu_ky_tgd}} | {{ngay_ky_tgd}} |
