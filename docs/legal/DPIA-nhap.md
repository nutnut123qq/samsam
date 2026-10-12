# DPIA — Đánh giá tác động xử lý dữ liệu cá nhân (NHÁP)

> **BẢN NHÁP — chưa có giá trị pháp lý; chờ Chuyên viên Pháp chế ký, luật sư rà — agent không kết luận tuân thủ.**
> Sinh tự động bởi `python scripts/dpia_draft.py` từ `data/data_flow_map.json` (bản đồ rà từ code ngày 2026-10-12). KHÔNG sửa tay — sửa map rồi chạy lại (`--check` bắt lệch).
> Căn cứ: Luật BVDLCN 91/2025/QH15 + NĐ 356/2025 (hiệu lực 01/01/2026, NĐ 356/2025 thay NĐ 13/2023). Khung mục dựng theo cấu trúc hồ sơ đánh giá tác động xử lý của NĐ 13/2023 Điều 24 — mẫu biểu chính thức theo NĐ 356/2025: CẦN LUẬT SƯ XÁC NHẬN.

## 1. Bên kiểm soát / bên xử lý dữ liệu

- Tên doanh nghiệp: {{ten_cong_ty}}
- Mã số doanh nghiệp: {{ma_so_doanh_nghiep}}
- Người phụ trách bảo vệ dữ liệu cá nhân: {{nguoi_phu_trach_dlcn}}
- Liên hệ đầu mối: {{lien_he_dau_moi}}
- Bên xử lý / bên nhận: theo dòng "Bên nhận" của từng hoạt động ở mục 2.

## 2. Mô tả từng hoạt động xử lý

Phân lớp dữ liệu (plan_data_platform §2):

- **Đỏ** (`do`): Đỏ — orders/đơn sàn, leads, liên hệ đại lý, log hội thoại, mọi tin nhắn có yếu tố sức khỏe, user_id thô. Không được đi ra LLM nước ngoài.
- **Vàng** (`vang`): Vàng — câu hỏi thường SAU `_mask_pii` (che SĐT/email), tài liệu nội bộ. Được gửi LLM qua gateway (mask + provider routing).
- **Xanh** (`xanh`): Xanh — catalog, claims, chunk public, số liệu vận hành tổng hợp không có dữ liệu cá nhân.

### DF-01 — Kênh Zalo OA — nhận tin và trả lời khách

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-01 |
| Module (code) | `connectors/zalo.py` |
| Mục đích | Chăm sóc khách hàng (CSKH) — trả lời câu hỏi sản phẩm qua chatbot |
| Dữ liệu | user_id Zalo thô, nội dung tin nhắn khách (có thể chứa SĐT, tên, địa chỉ, yếu tố sức khỏe), câu trả lời gửi lại |
| Lớp | Đỏ |
| Chủ thể | Khách hàng nhắn Zalo OA của công ty |
| Nơi lưu | RAM `_histories` (deque 8 message = 4 lượt Q&A/user); `data/zalo_seen.db` (khóa dedup msg_id và `follow:<user_id>` thô); `data/zalo_tokens.json` (token OA — secret, không phải DLCN) |
| Thời hạn lưu | `_histories`: RAM, LRU 1000 user (HIST_MAX_USERS), mất khi restart; `zalo_seen.db`: TTL 1 giờ (SEEN_TTL_S) cho msg, 7 ngày (FOLLOW_TTL_S) cho khóa follow |
| Bên nhận | Zalo/VNG — openapi.zalo.me (gửi tin), oauth.zaloapp.com (làm mới token) — Việt Nam |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Xác thực chữ ký webhook (verify_signature) trước khi xử lý; Câu hỏi sức khỏe (`is_health_question`) chuyển người, không gửi LLM; Log/stdout chỉ in `_uhash(user_id)` + `_mask_pii` — không in user_id thô |
| Căn cứ xử lý | Đồng ý của khách — bảng `consents` có (v5.2) nhưng CHƯA gắn kênh chat (tin chào có link chính sách): GAP |
| GAP | Bảng `consents` đã có (v5.2, đồng ý theo mục đích cskh/marketing/dai_ly) nhưng CHƯA gắn kênh chat — chưa ghi nhận đồng ý trước khi xử lý tin nhắn; `zalo_seen.db` lưu user_id thô trong khóa `follow:<user_id>` tới 7 ngày; CẦN LUẬT SƯ XÁC NHẬN: Zalo/VNG là bên xử lý (cần hợp đồng xử lý) hay bên nhận độc lập |

### DF-02 — Preflight token Zalo trước khi mở public

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-02 |
| Module (code) | `scripts/zalo_preflight.py` |
| Mục đích | Kiểm tra cấu hình kênh trước khi deploy |
| Dữ liệu | Access/refresh token OA, thông tin OA (getoa) — không có dữ liệu khách |
| Lớp | Xanh |
| Chủ thể | Không có chủ thể dữ liệu cá nhân (tài khoản OA của công ty) |
| Nơi lưu | `data/zalo_tokens.json` (secret, gitignore) |
| Thời hạn lưu | Token ghi đè mỗi lần làm mới; không lưu lịch sử |
| Bên nhận | Zalo/VNG — openapi.zalo.me, oauth.zaloapp.com — Việt Nam |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Chỉ chạy tay trên máy deploy; không gọi OpenRouter (chỉ kiểm key non-empty) |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-03 — Mock E2E Zalo (chỉ test)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-03 |
| Module (code) | `scripts/zalo_mock.py` |
| Mục đích | Kiểm thử webhook local — CHỈ dùng cho test |
| Dữ liệu | Sự kiện giả (user_id, tin nhắn tự sinh) — không dữ liệu khách thật |
| Lớp | Xanh |
| Chủ thể | Không có (dữ liệu giả) |
| Nơi lưu | Không lưu ngoài convlog local của tiến trình test |
| Thời hạn lưu | Theo convlog local nếu chạy cùng máy |
| Bên nhận | localhost (127.0.0.1) — không ra Internet |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Chỉ gọi localhost |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân thật |
| GAP | (không) |

### DF-04 — Nhật ký hội thoại (convlog)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-04 |
| Module (code) | `connectors/zalo.py`; `app/streamlit_app.py`; `ingest/lead_store.py`; `scripts/kb_gaps.py` |
| Mục đích | Đo chất lượng trả lời, tìm câu chưa trả lời (bổ sung KB), trích lead |
| Dữ liệu | user_hash (sha256 KHÔNG muối của user_id, 16 hex — bút danh, vẫn là dữ liệu cá nhân), câu hỏi ĐÃ `_mask_pii`, câu trả lời, ts, cờ answered/flagged |
| Lớp | Đỏ |
| Chủ thể | Khách hàng chat Zalo/web, nhân viên thử trên Streamlit |
| Nơi lưu | `data/conversations.jsonl` (+ `.1` khi rotate), máy chủ chạy webhook |
| Thời hạn lưu | 30 ngày (RETAIN_DAYS = 30, purge hằng ngày khi ghi) |
| Bên nhận | Nội bộ (Quản lý hạ tầng AI, MKT xem tab Chưa trả lời) — không gửi ra ngoài |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | `_mask_pii` che SĐT/email trước khi ghi; `_uhash` thay user_id thô; Purge 30 ngày ghi atomic (tmp + os.replace) |
| Căn cứ xử lý | Đồng ý (CSKH) — CHƯA có cơ chế ghi nhận trong code: GAP |
| GAP | Tên người, địa chỉ, mã đơn đứng tự do trong câu hỏi KHÔNG bị `_mask_pii` che (chỉ SĐT/email) — rủi ro tồn dư; Chưa có luồng xóa theo yêu cầu chủ thể (theo user_hash); `_uhash` không muối — user_id Zalo dạng số có thể dò ngược ra hash (bút danh, không phải ẩn danh) |

### DF-05 — Lead store (khách có nhu cầu mua/đại lý)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-05 |
| Module (code) | `ingest/lead_store.py` |
| Mục đích | Bán hàng — chăm sóc lại khách có nhu cầu |
| Dữ liệu | user_hash, câu hỏi đã mask, intent (partner/order/price/contact), trạng thái chăm sóc; v5.2: `contact_id` (tham chiếu kho liên hệ — không PII trong `leads`), tỉnh, mã đại lý gán |
| Lớp | Đỏ |
| Chủ thể | Khách hàng, người hỏi làm đại lý |
| Nơi lưu | Bảng `leads` (Postgres) |
| Thời hạn lưu | Không có hạn lưu trong code — GAP |
| Bên nhận | Nội bộ (Sales/Admin) — không gửi ra ngoài |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Câu hỏi đã mask từ convlog; Chỉ lưu user_hash; v5.2: PII liên hệ KHÔNG nằm trong `leads` — chỉ `contact_id` trỏ `contacts` (mã hóa, DF-18) |
| Căn cứ xử lý | Đồng ý theo mục đích — bảng `consents` (v5.2) cho contact đã gắn; lead từ chat chưa có đồng ý: GAP |
| GAP | Bảng `leads` không có hạn lưu / job xóa — GAP; Lead từ chat chỉ có user_hash — chỉ liên hệ khi người gán contact có consent (`can_contact`); đồng ý chưa thu ở kênh chat |

### DF-06 — Chatbot RAG gửi câu hỏi tới LLM qua gateway (OpenRouter)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-06 |
| Module (code) | `api/rag.py`; `pipelines/llm_gateway.py`; `app/streamlit_app.py`; `connectors/zalo.py` |
| Mục đích | CSKH — sinh câu trả lời có nguồn |
| Dữ liệu | Câu hỏi thường SAU `_mask_pii` + history 4 lượt gần nhất (cũng mask) + đoạn KB public làm ngữ cảnh |
| Lớp | Vàng |
| Chủ thể | Khách hàng chat Zalo/web |
| Nơi lưu | Không lưu ở hệ thống ngoài nhật ký hội thoại convlog; phía nhà cung cấp: yêu cầu zdr + data_collection=deny (cam kết của nhà cung cấp chưa được rà) |
| Thời hạn lưu | Phía hệ thống: theo nhật ký hội thoại (30 ngày); phía nhà cung cấp: không lưu theo cấu hình zdr — chưa kiểm chứng bằng hợp đồng |
| Bên nhận | OpenRouter (Mỹ) → nhà cung cấp trong whitelist `provider_only` của data/llm_gateway.json (openai, azure — Mỹ) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | `_mask_pii` ở gateway cho MỌI message (system/history/user) và input embedding; `is_health_question` chặn câu hỏi sức khỏe TRƯỚC LLM (chuyển người); Provider routing data_collection=deny, zdr=true, allow_fallbacks=false, only=whitelist (fail-closed); Kill-switch + trần chi phí theo agent |
| Căn cứ xử lý | Đồng ý cho chuyển dữ liệu ra nước ngoài — CHƯA có cơ chế ghi nhận trong code: GAP; hồ sơ TIA (bản nháp này) |
| GAP | Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài; Bảng `consents` có (v5.2) nhưng CHƯA gắn kênh chat — chưa có bản ghi đồng ý trước lượt gọi LLM; Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà |

### DF-07 — Content Studio sinh nháp nội dung qua gateway

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-07 |
| Module (code) | `pipelines/content.py`; `pipelines/llm_gateway.py`; `pipelines/store.py` |
| Mục đích | Soạn nháp nội dung marketing chờ người duyệt |
| Dữ liệu | Brief do nhân viên nhập (quy trình: không đưa dữ liệu khách), claim đã duyệt, nháp nội dung |
| Lớp | Vàng |
| Chủ thể | Nhân viên MKT (tên người duyệt trong approvals) |
| Nơi lưu | Bảng `content_drafts`, `approvals`, `agent_action_log` |
| Thời hạn lưu | Không giới hạn — hồ sơ duyệt append-only (bằng chứng tuân thủ quảng cáo) |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider (Mỹ) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | `_mask_pii` ở gateway; `guardrail.check()` trước khi hiển thị/lưu; Duyệt người thật (approve_draft) trước khi đăng |
| Căn cứ xử lý | Lợi ích hợp pháp/hợp đồng lao động với nhân viên — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email) |

### DF-08 — Embedding KB public

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-08 |
| Module (code) | `ingest/embed_store.py` |
| Mục đích | Tạo vector tìm kiếm cho chatbot |
| Dữ liệu | Đoạn văn bản public (sản phẩm, bài viết) đã crawl |
| Lớp | Xanh |
| Chủ thể | Không có dữ liệu cá nhân |
| Nơi lưu | Bảng `chunks` |
| Thời hạn lưu | Thay khi nạp lại |
| Bên nhận | OpenRouter (Mỹ) — embeddings |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Qua gateway (mask + routing); `kb_filter` loại nội dung rượu/phóng đại |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-09 — KB nội bộ (tài liệu nội bộ đã duyệt)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-09 |
| Module (code) | `ingest/kb_internal.py`; `ingest/embed_store.py` |
| Mục đích | Trợ lý nội bộ tra cứu tài liệu |
| Dữ liệu | Tài liệu nội bộ đã duyệt (quy trình, chính sách) — có thể nhắc tên nhân viên |
| Lớp | Vàng |
| Chủ thể | Nhân viên (nếu tài liệu nhắc tên) |
| Nơi lưu | Bảng `chunks_internal` (chatbot khách không đọc tới) |
| Thời hạn lưu | Thay khi nạp bản mới (theo doc_sha256) |
| Bên nhận | OpenRouter (Mỹ) — embeddings qua gateway |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Qua gateway (`_mask_pii` input embedding); Bảng riêng, phân quyền theo collection |
| Căn cứ xử lý | Lợi ích hợp pháp — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Tên nhân viên trong tài liệu không bị mask khi embedding |

### DF-10 — Số hóa tài liệu (doc intake)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-10 |
| Module (code) | `ingest/doc_intake.py` |
| Mục đích | Lưu trữ + tra cứu tài liệu nội bộ |
| Dữ liệu | Bản gốc PDF/ảnh tài liệu công ty (có thể chứa SĐT/email/tên đối tác), text trích, cờ pii_flag |
| Lớp | Vàng |
| Chủ thể | Đối tác, nhân viên có tên trong tài liệu |
| Nơi lưu | Thư mục originals (DOC_ORIGINALS_DIR) + bảng `documents`, `document_fields` |
| Thời hạn lưu | Không giới hạn (bản gốc bất biến theo sha256) |
| Bên nhận | Không — OCR provider mặc định `none`; provider OCR nước ngoài bị TỪ CHỐI |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | OCR nước ngoài bị từ chối; pii_flag true/NULL không được gửi LLM |
| Căn cứ xử lý | Lợi ích hợp pháp/hợp đồng — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Chưa có hạn lưu cho bản gốc |

### DF-11 — Nạp file đơn/sản phẩm từ sàn TMĐT

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-11 |
| Module (code) | `ingest/market_csv.py` |
| Mục đích | Đối soát doanh thu, cảnh báo giá/tồn |
| Dữ liệu | Dòng đơn hàng sàn sau khi DROP cột PII (tên/SĐT/địa chỉ người mua, ghi chú); order_id → order_id_hash |
| Lớp | Đỏ |
| Chủ thể | Người mua trên sàn |
| Nơi lưu | Bảng `market_snapshots`, `market_rows`, `market_alerts` |
| Thời hạn lưu | Không giới hạn — GAP |
| Bên nhận | Không gửi ra ngoài (file do người tải từ Seller Center) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Allowlist cột — cột PII bị bỏ ngay khi đọc; `order_id_hash`; Lỗi chỉ nêu số dòng/tên cột, không giá trị ô |
| Căn cứ xử lý | Hợp đồng mua bán (thực hiện đơn) — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Chưa có hạn lưu cho dữ liệu đơn sàn |

### DF-12 — Bản tin sức khỏe hệ thống

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-12 |
| Module (code) | `scripts/health_bulletin.py` |
| Mục đích | Giám sát vận hành |
| Dữ liệu | Chỉ số tổng hợp vận hành (job, eval, chi phí, số mục) — không có dữ liệu cá nhân |
| Lớp | Xanh |
| Chủ thể | Không có |
| Nơi lưu | `data/reports/` |
| Thời hạn lưu | Không giới hạn (file báo cáo) |
| Bên nhận | Khi `--notify`: máy chủ SMTP cấu hình (email) hoặc Telegram (api.telegram.org — nước ngoài) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Mặc định KHÔNG gửi — cần `--notify` + env kênh; Chỉ số tổng hợp, không nội dung chat |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-13 — Crawl website công khai của công ty

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-13 |
| Module (code) | `crawler/collect.py`; `crawler/sources.py` |
| Mục đích | Xây KB public cho chatbot |
| Dữ liệu | Trang public (sản phẩm, bài viết) — không thu dữ liệu cá nhân |
| Lớp | Xanh |
| Chủ thể | Không có |
| Nơi lưu | `data/*.jsonl` |
| Thời hạn lưu | Ghi đè khi crawl lại |
| Bên nhận | Chỉ GET tới samsamngoclinh.com, samsam.net.vn — không gửi dữ liệu cá nhân |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Delay ≥1s/request, chỉ trang public |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-14 — Nhật ký chi phí LLM (llm_usage)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-14 |
| Module (code) | `pipelines/llm_gateway.py` |
| Mục đích | Kiểm soát chi phí, trần tháng |
| Dữ liệu | agent_id, model, số token, chi phí ước tính, lỗi đã mask (≤300 ký tự) — không lưu prompt/response |
| Lớp | Xanh |
| Chủ thể | Không có |
| Nơi lưu | Bảng `llm_usage` |
| Thời hạn lưu | Không giới hạn (metadata) |
| Bên nhận | Nội bộ |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Không lưu nội dung; lỗi qua `_mask_pii` |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-15 — Sao lưu và diễn tập khôi phục DB

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-15 |
| Module (code) | `scripts/db_backup.py`; `scripts/db_restore_drill.py` |
| Mục đích | An toàn dữ liệu, khôi phục sự cố |
| Dữ liệu | Toàn bộ DB (gồm bảng lớp Đỏ: leads, orders...) |
| Lớp | Đỏ |
| Chủ thể | Mọi chủ thể có trong DB |
| Nơi lưu | BACKUP_DIR ngoài repo; offsite `dir:` (ổ local/mạng nội bộ) |
| Thời hạn lưu | Giữ BACKUP_KEEP (mặc định 7) bản mới nhất |
| Bên nhận | Nội bộ; offsite `s3://` chưa bật (external-dep — script exit 3, không gọi mạng) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Mã hóa khi có BACKUP_PASSPHRASE_FILE; sha256 manifest; Diễn tập khôi phục vào DB tạm |
| Căn cứ xử lý | Nghĩa vụ bảo đảm an toàn dữ liệu — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Mã hóa backup là tùy chọn — chưa bắt buộc; Nếu bật offsite cloud nước ngoài phải bổ sung TIA |

### DF-16 — Thu tin thị trường tầng A/B (intel — v7.0)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-16 |
| Module (code) | `crawler/intel.py`; `scripts/intel_bulletin.py` |
| Mục đích | Tình báo thị trường: tin về sâm, TPBVSK, đồ ăn giới trẻ, quảng cáo, đối thủ |
| Dữ liệu | Tiêu đề + trích ≤300 ký tự + link tin RSS/Atom công khai (đã che SĐT/email); có thể nhắc tên người trong tin báo chí |
| Lớp | Xanh |
| Chủ thể | Người được nhắc tên trong tin báo chí công khai (nếu có) |
| Nơi lưu | Bảng `intel_items` (không lưu toàn văn) |
| Thời hạn lưu | Chưa có hạn lưu/purge — GAP |
| Bên nhận | Chỉ GET tới nguồn RSS tầng A/B trong `data/intel_sources.json`; tóm tắt LLM (mặc định TẮT) qua gateway → OpenRouter (Mỹ) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | robots.txt + delay ≥1s/host, chặn cứng sàn/MXH kể cả khi redirect; Chỉ tiêu đề + trích ≤300 ký tự, `_mask_pii` trước khi lưu; LLM tóm tắt chỉ chạy khi `llm.enabled` + `--llm`, qua gateway + guardrail; Bản tin v7.1 (`scripts/intel_bulletin.py --llm`): tóm tắt theo chủ đề CHỈ từ tiêu đề + trích đã lưu (≤300 ký tự/tin, bỏ link, ≤10 tin), cùng cờ `llm.enabled` (mặc định TẮT) + guardrail; bản tin là file nội bộ, không gửi |
| Căn cứ xử lý | Thông tin công khai; nếu bật LLM thì cần Pháp chế xác nhận — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Chưa che họ tên người trong tiêu đề/trích tin (NER); Chưa có hạn lưu/purge `intel_items` |

### DF-17 — Nghiên cứu giả lập persona (v7.3)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-17 |
| Module (code) | `scripts/persona_sim.py` |
| Mục đích | Loại bớt phương án truyền thông yếu trước khi thử thật |
| Dữ liệu | Persona TỔNG HỢP (không dữ liệu khách thật), phương án sản phẩm/thông điệp, điểm số model |
| Lớp | Xanh |
| Chủ thể | Không có — persona tổng hợp, validator chặn key PII/SĐT/email |
| Nơi lưu | Bảng `sim_runs` (không lưu văn bản LLM thô, không PII) |
| Thời hạn lưu | Không giới hạn — lịch sử kiểm toán model/prompt/seed |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `persona_sim`) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Cổng DPIA: `dpia_signed` false → từ chối chạy thật (exit 2, 0 lời gọi LLM); Validator đầu vào chặn persona <18 tuổi, key ngoài allowlist, PII; Mọi phương án qua guardrail trước khi gửi model |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân thật; chạy sau khi DPIA ký — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | (không) |

### DF-21 — Nhận xét báo cáo TGĐ qua LLM (cockpit — v8.0, chỉ khi --llm)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-21 |
| Module (code) | `agents/ceo_report.py` |
| Mục đích | Viết phần nhận xét báo cáo tuần/tháng cho TGĐ bằng placeholder; code điền số |
| Dữ liệu | metric_id + tên chỉ số + chiều tốt + xu hướng (tăng/giảm/không đổi) + nhãn kỳ — KHÔNG số tuyệt đối, KHÔNG PII |
| Lớp | Xanh |
| Chủ thể | Không có — số liệu vận hành tổng hợp, không dữ liệu cá nhân |
| Nơi lưu | Không lưu prompt/response (llm_usage chỉ đếm token/chi phí); văn bản đã điền nằm trong file data/reports/ceo-<kỳ>.md (gitignored) |
| Thời hạn lưu | Theo file báo cáo local — chưa có hạn lưu riêng |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `cockpit`, trần 0,5 USD/tháng) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Mặc định TẮT — chỉ chạy khi `python -m agents.ceo_report --llm`; Prompt chỉ có metric_id/tên/chiều tốt/xu hướng, không số tuyệt đối; `ground()`: văn bản LLM còn chữ số/%/trăm-nghìn-triệu-tỷ ngoài placeholder → bị loại, dùng nhận xét theo luật; qua guardrail |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | (không) |

### DF-18 — CRM contact_vault / đồng ý / đại lý (KD-A2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-18 |
| Module (code) | `ingest/crm.py` |
| Mục đích | Bán hàng — chăm sóc lead, chuyển lead cho đại lý phụ trách vùng khi khách đồng ý đích danh |
| Dữ liệu | Tên, SĐT, email, địa chỉ khách (nhập tay qua stdin) + người liên hệ của đại lý + bản ghi đồng ý theo mục đích (cskh/marketing/dai_ly, mã biên bản, phiên bản chính sách) + gán lead theo tỉnh/đại lý |
| Lớp | Đỏ |
| Chủ thể | Khách hàng để lại liên hệ, người liên hệ của đại lý |
| Nơi lưu | Bảng `contacts` (PII mã hóa Fernet), `consents` (append-only), `dealers`, `leads` (contact_id/province/dealer_code) — Postgres |
| Thời hạn lưu | Không có hạn lưu trong code — GAP (TTL theo mục đích chưa build) |
| Bên nhận | Nội bộ (Sales/Admin); đại lý ĐÍCH DANH khi có consent dai_ly hiện hành — NGƯỜI chuyển tay payload `--handoff`, hệ thống không gửi |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Mã hóa tầng ứng dụng (Fernet) — khóa `CONTACT_VAULT_KEY` chỉ ở env, DB không thấy khóa/plaintext; thiếu khóa → không ghi PII; Tra trùng SĐT bằng HMAC-SHA256 có khóa (HKDF), không sha256 trần; DB check chặn plaintext lọt vào cột `*_enc`; `consents` append-only (trigger) — rút đồng ý = thêm dòng mới; `can_contact` mặc định False; dai_ly phải đích danh đại lý; Report không giải mã, không in PII; `agent_action_log` không chứa PII; Module không có đường gửi ra ngoài (drift-guard egress) |
| Căn cứ xử lý | Đồng ý theo mục đích (bảng `consents`) — nội dung đồng ý CHỜ Pháp chế duyệt |
| GAP | Chưa có TTL/xóa theo mục đích và theo yêu cầu chủ thể (quyền xóa/truy cập); Khóa mã hóa do công ty giữ + quy trình backup khóa tách khỏi backup DB chưa có (mất khóa = mất PII); Đồng ý chưa gắn kênh chat (Zalo/web) — chỉ ghi tay qua CLI; Đại lý ký cam kết xử lý dữ liệu chưa được kiểm trong code (chỉ kiểm consent đích danh); Phân quyền DB cho bảng CRM (role sales) chưa cấp — external-dep |

### DF-22 — Nghiệm thu QA — giám khảo LLM của harness (agent_eval, v4.5)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-22 |
| Module (code) | `scripts/agent_eval.py` |
| Mục đích | Chấm ca lớp mềm khi nghiệm thu agent theo commit (cổng deploy F17.1) |
| Dữ liệu | Ca kiểm thử (đề + rubric do dev/công ty soạn) và output của agent bị chấm (vd câu trả lời chatbot trên KB public) — chỉ ca có scorer judge |
| Lớp | Xanh |
| Chủ thể | Không có — ca kiểm thử tổng hợp, không dữ liệu khách thật; log FAIL qua `_mask_pii` |
| Nơi lưu | Bảng `eval_runs` (số liệu + id ca FAIL; không lưu văn bản output/judge) |
| Thời hạn lưu | Không giới hạn — lịch sử nghiệm thu theo commit (kiểm toán deploy) |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `ci_judge`, trần 1 USD/tháng) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Chỉ qua `pipelines.llm_gateway` agent `ci_judge` — không gọi client LLM trực tiếp (test khóa); Model judge phải KHÁC HỌ nhà sản xuất với model agent (allowlist họ; router/alias lạ → từ chối trước mọi lời gọi); CI mỗi push (`--deterministic`) chỉ chạy suite luật (guardrail + co_khi) — 0 lời gọi LLM; hiện chưa suite active nào có ca judge |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân thật (ca kiểm thử tổng hợp) — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Provider whitelist + ZDR cho `ci_judge` và judge LLM thật chưa cấu hình (external-dep) |

### DF-23 — Đối thủ / Google Trends / MXH kênh sở hữu nhập tay + báo cáo tuần (v7.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-23 |
| Module (code) | `ingest/intel_import.py`; `scripts/intel_weekly.py` |
| Mục đích | Nghiên cứu đối thủ, xu hướng, lắng nghe MXH cho báo cáo tuần |
| Dữ liệu | Giá/khuyến mãi đối thủ ghi tay, file Google Trends xuất tay, export comment/inbox kênh sở hữu (đã bỏ cột tên/ID, che SĐT/email khi đọc) |
| Lớp | Vàng |
| Chủ thể | Người bình luận/nhắn tin trên kênh sở hữu của công ty |
| Nơi lưu | Bảng `intel_imports`, `competitor_observations`, `trends_weekly`, `trends_related`, `social_mentions` (không trích comment tới khi DPIA ký) |
| Thời hạn lưu | Chưa có hạn lưu/purge — GAP |
| Bên nhận | Không gửi ra ngoài mặc định; tóm tắt LLM (`--llm`, mặc định TẮT, không gửi text social) qua gateway → OpenRouter (Mỹ) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Bỏ cột tên/ID người dùng ngay khi đọc; Dedup bằng hash có muối `INTEL_HASH_SALT`; Không lưu trích comment khi `dpia_signed` false; Tóm tắt qua guardrail |
| Căn cứ xử lý | Lợi ích hợp pháp (kênh sở hữu) — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Chưa có hạn lưu `social_mentions`; Mapping cột export thật chưa xác minh |

### DF-24 — Guardrail LLM-check phụ + red-team sinh biến thể (v4.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-24 |
| Module (code) | `pipelines/guardrail_llm.py`; `scripts/redteam.py` |
| Mục đích | Bắt claim sức khỏe ẩn ý mà luật không bắt; kiểm thử red-team guardrail |
| Dữ liệu | Nội dung nháp marketing do agent/nhân viên soạn (đã qua `_mask_pii`), câu tấn công tổng hợp |
| Lớp | Vàng |
| Chủ thể | Không có dữ liệu khách — nháp nội dung marketing |
| Nơi lưu | Không lưu text LLM; kết quả vào guardrail snapshot của `content_drafts` |
| Thời hạn lưu | Theo `content_drafts` (hồ sơ duyệt) |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `guardrail_llm`, `redteam`) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Chỉ chặn THÊM, lỗi → `llm_check_unavailable` chặn; Mặc định TẮT (env trống); Red-team chỉ chạy tay, ≤20 lời gọi, model khác họ |
| Căn cứ xử lý | Lợi ích hợp pháp — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | (không) |

## 3. Đánh giá rủi ro

Mức đề xuất, Pháp chế chốt. Quy tắc cố định: lớp Đỏ → cao, Vàng → trung bình, Xanh → thấp; luồng chuyển ra nước ngoài đánh giá thêm ở TIA.

| Mã | Hoạt động | Lớp | Mức rủi ro đề xuất | Ra nước ngoài | Số GAP |
|---|---|---|---|---|---|
| DF-01 | Kênh Zalo OA — nhận tin và trả lời khách | Đỏ | cao | không | 3 |
| DF-02 | Preflight token Zalo trước khi mở public | Xanh | thấp | không | 0 |
| DF-03 | Mock E2E Zalo (chỉ test) | Xanh | thấp | không | 0 |
| DF-04 | Nhật ký hội thoại (convlog) | Đỏ | cao | không | 3 |
| DF-05 | Lead store (khách có nhu cầu mua/đại lý) | Đỏ | cao | không | 2 |
| DF-06 | Chatbot RAG gửi câu hỏi tới LLM qua gateway (OpenRouter) | Vàng | trung bình | có | 3 |
| DF-07 | Content Studio sinh nháp nội dung qua gateway | Vàng | trung bình | có | 1 |
| DF-08 | Embedding KB public | Xanh | thấp | có | 0 |
| DF-09 | KB nội bộ (tài liệu nội bộ đã duyệt) | Vàng | trung bình | có | 1 |
| DF-10 | Số hóa tài liệu (doc intake) | Vàng | trung bình | không | 1 |
| DF-11 | Nạp file đơn/sản phẩm từ sàn TMĐT | Đỏ | cao | không | 1 |
| DF-12 | Bản tin sức khỏe hệ thống | Xanh | thấp | có | 0 |
| DF-13 | Crawl website công khai của công ty | Xanh | thấp | không | 0 |
| DF-14 | Nhật ký chi phí LLM (llm_usage) | Xanh | thấp | không | 0 |
| DF-15 | Sao lưu và diễn tập khôi phục DB | Đỏ | cao | không | 2 |
| DF-16 | Thu tin thị trường tầng A/B (intel — v7.0) | Xanh | thấp | có | 2 |
| DF-17 | Nghiên cứu giả lập persona (v7.3) | Xanh | thấp | có | 0 |
| DF-21 | Nhận xét báo cáo TGĐ qua LLM (cockpit — v8.0, chỉ khi --llm) | Xanh | thấp | có | 0 |
| DF-18 | CRM contact_vault / đồng ý / đại lý (KD-A2) | Đỏ | cao | không | 5 |
| DF-22 | Nghiệm thu QA — giám khảo LLM của harness (agent_eval, v4.5) | Xanh | thấp | có | 1 |
| DF-23 | Đối thủ / Google Trends / MXH kênh sở hữu nhập tay + báo cáo tuần (v7.2) | Vàng | trung bình | có | 2 |
| DF-24 | Guardrail LLM-check phụ + red-team sinh biến thể (v4.2) | Vàng | trung bình | có | 0 |

## 4. Tổng hợp GAP

- [DF-01] Bảng `consents` đã có (v5.2, đồng ý theo mục đích cskh/marketing/dai_ly) nhưng CHƯA gắn kênh chat — chưa ghi nhận đồng ý trước khi xử lý tin nhắn
- [DF-01] `zalo_seen.db` lưu user_id thô trong khóa `follow:<user_id>` tới 7 ngày
- [DF-01] CẦN LUẬT SƯ XÁC NHẬN: Zalo/VNG là bên xử lý (cần hợp đồng xử lý) hay bên nhận độc lập
- [DF-04] Tên người, địa chỉ, mã đơn đứng tự do trong câu hỏi KHÔNG bị `_mask_pii` che (chỉ SĐT/email) — rủi ro tồn dư
- [DF-04] Chưa có luồng xóa theo yêu cầu chủ thể (theo user_hash)
- [DF-04] `_uhash` không muối — user_id Zalo dạng số có thể dò ngược ra hash (bút danh, không phải ẩn danh)
- [DF-05] Bảng `leads` không có hạn lưu / job xóa — GAP
- [DF-05] Lead từ chat chỉ có user_hash — chỉ liên hệ khi người gán contact có consent (`can_contact`); đồng ý chưa thu ở kênh chat
- [DF-06] Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài
- [DF-06] Bảng `consents` có (v5.2) nhưng CHƯA gắn kênh chat — chưa có bản ghi đồng ý trước lượt gọi LLM
- [DF-06] Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà
- [DF-07] Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email)
- [DF-09] Tên nhân viên trong tài liệu không bị mask khi embedding
- [DF-10] Chưa có hạn lưu cho bản gốc
- [DF-11] Chưa có hạn lưu cho dữ liệu đơn sàn
- [DF-15] Mã hóa backup là tùy chọn — chưa bắt buộc
- [DF-15] Nếu bật offsite cloud nước ngoài phải bổ sung TIA
- [DF-16] Chưa che họ tên người trong tiêu đề/trích tin (NER)
- [DF-16] Chưa có hạn lưu/purge `intel_items`
- [DF-18] Chưa có TTL/xóa theo mục đích và theo yêu cầu chủ thể (quyền xóa/truy cập)
- [DF-18] Khóa mã hóa do công ty giữ + quy trình backup khóa tách khỏi backup DB chưa có (mất khóa = mất PII)
- [DF-18] Đồng ý chưa gắn kênh chat (Zalo/web) — chỉ ghi tay qua CLI
- [DF-18] Đại lý ký cam kết xử lý dữ liệu chưa được kiểm trong code (chỉ kiểm consent đích danh)
- [DF-18] Phân quyền DB cho bảng CRM (role sales) chưa cấp — external-dep
- [DF-22] Provider whitelist + ZDR cho `ci_judge` và judge LLM thật chưa cấu hình (external-dep)
- [DF-23] Chưa có hạn lưu `social_mentions`
- [DF-23] Mapping cột export thật chưa xác minh

## 5. Câu hỏi cho luật sư

1. NĐ 356/2025 thay NĐ 13/2023: mẫu hồ sơ đánh giá tác động xử lý và thời hạn nộp — CẦN LUẬT SƯ XÁC NHẬN.
2. Ân hạn 5 năm cho doanh nghiệp nhỏ (nghĩa vụ DPIA, nhân sự bảo vệ dữ liệu) có còn áp dụng khi chatbot nhận tin nhắn có yếu tố sức khỏe (dữ liệu nhạy cảm) hay không — CẦN LUẬT SƯ XÁC NHẬN.
3. Mốc 72 giờ báo cáo sự cố dữ liệu: căn cứ chưa xác minh nguyên văn — CẦN LUẬT SƯ XÁC NHẬN.
4. Zalo/VNG (kênh OA) là bên xử lý dữ liệu (cần hợp đồng xử lý) hay bên nhận độc lập — CẦN LUẬT SƯ XÁC NHẬN.
5. `user_hash` (sha256 không muối của user_id) là dữ liệu bút danh — vẫn là dữ liệu cá nhân, biện pháp đủ chưa — CẦN LUẬT SƯ XÁC NHẬN.

## 6. Ký duyệt

Chưa ai ký — ô để trống chờ người thật.

| Vai trò | Họ tên | Chữ ký | Ngày ký |
|---|---|---|---|
| Chuyên viên Pháp chế | {{ho_ten_phap_che}} | {{chu_ky_phap_che}} | {{ngay_ky_phap_che}} |
| Luật sư rà soát | {{ho_ten_luat_su}} | {{chu_ky_luat_su}} | {{ngay_ky_luat_su}} |
| Tổng giám đốc | {{ho_ten_tgd}} | {{chu_ky_tgd}} | {{ngay_ky_tgd}} |
