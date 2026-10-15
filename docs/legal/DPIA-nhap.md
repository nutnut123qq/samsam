# DPIA — Đánh giá tác động xử lý dữ liệu cá nhân (NHÁP)

> **BẢN NHÁP — chưa có giá trị pháp lý; chờ Chuyên viên Pháp chế ký, luật sư rà — agent không kết luận tuân thủ.**
> Sinh tự động bởi `python scripts/dpia_draft.py` từ `data/data_flow_map.json` (bản đồ rà từ code ngày 2026-10-14). KHÔNG sửa tay — sửa map rồi chạy lại (`--check` bắt lệch).
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
| Module (code) | `connectors/zalo.py`; `connectors/channels.py` |
| Mục đích | Chăm sóc khách hàng (CSKH) — trả lời câu hỏi sản phẩm qua chatbot |
| Dữ liệu | user_id Zalo thô, nội dung tin nhắn khách (có thể chứa SĐT, tên, địa chỉ, yếu tố sức khỏe), câu trả lời gửi lại |
| Lớp | Đỏ |
| Chủ thể | Khách hàng nhắn Zalo OA của công ty |
| Nơi lưu | RAM `_histories` (deque 8 message = 4 lượt Q&A/user); `data/zalo_seen.db` (khóa dedup msg_id và `follow:<user_id>` thô); `data/zalo_tokens.json` (token OA — secret, không phải DLCN); bảng `chat_consents` (v5.1, append-only: `user_hash` HMAC có muối `CHANNEL_HASH_SALT` 32 hex, kênh, prompted/granted/withdrawn, `policy_version`, `evidence_ref` = sha256(msg_id)[:16] — không nội dung tin); mục `approval_queue` loại `cskh_handoff` (payload cố định: kênh, mã lý do, user_hash có muối, msg_ref, ts — không câu hỏi/câu trả lời/user_id) |
| Thời hạn lưu | `_histories`: RAM, LRU 1000 user (HIST_MAX_USERS), mất khi restart; `zalo_seen.db`: TTL 1 giờ (SEEN_TTL_S) cho msg, 7 ngày (FOLLOW_TTL_S) cho khóa follow; `chat_consents`: lưu lâu dài làm bằng chứng đồng ý (append-only, chưa có hạn — GAP); mục `cskh_handoff`: theo hồ sơ duyệt `approval_queue` |
| Bên nhận | Zalo/VNG — openapi.zalo.me (gửi tin), oauth.zaloapp.com (làm mới token) — Việt Nam |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Xác thực chữ ký webhook (verify_signature) trước khi xử lý; v5.1 `channels.pre_route` TRƯỚC LLM: câu sức khỏe → template + chuyển người (mục `cskh_handoff`), câu về rượu → template cố định — cả hai KHÔNG gọi `answer()`/LLM; Log/stdout chỉ in `_uhash(user_id)` + `_mask_pii` — không in user_id thô; Đồng ý tư vấn chat chỉ ghi khi khách gõ "Đồng ý" tường minh (không suy diễn); rút đồng ý (câu ngắn phủ định/rút/hủy + "đồng ý") = dòng withdrawn + xóa history RAM + DỪNG LLM cho khách đó (bất kể cờ) tới khi nhắn lại "Đồng ý" — CHỈ KHI ghi được dòng withdrawn (có CHANNEL_HASH_SALT + DB lên); ghi lỗi → khách nhận câu "chưa ghi nhận được, gọi hotline" (không hứa dừng) và tin sau vẫn tới LLM khi cờ tắt; Thiếu muối `CHANNEL_HASH_SALT` → không ghi đồng ý/handoff (fail-closed), không dùng hash không muối |
| Căn cứ xử lý | Đồng ý của khách — v5.1 có `chat_consents` ghi đồng ý TƯỜNG MINH qua chat (câu chào + link chính sách ở tin đầu, NHÁP chờ Pháp chế); cờ `require_consent_for_llm` mặc định TẮT = vẫn xử lý tin trước khi khách đồng ý: GAP |
| GAP | `require_consent_for_llm` mặc định tắt — tin nhắn vẫn qua LLM trước khi khách đồng ý; Pháp chế quyết bật; Câu chào + `policy_url` + `policy_version` trong `data/channels.json` là NHÁP — `policy_url` chưa xác minh trang tồn tại; chờ Pháp chế duyệt; `chat_consents` chưa nối `consents` v5.2 khi khách để lại liên hệ; chưa có hạn lưu; `zalo_seen.db` lưu user_id thô trong khóa `follow:<user_id>` tới 7 ngày; CẦN LUẬT SƯ XÁC NHẬN: Zalo/VNG là bên xử lý (cần hợp đồng xử lý) hay bên nhận độc lập |

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
| Module (code) | `connectors/zalo.py`; `connectors/messenger.py`; `app/streamlit_app.py`; `ingest/lead_store.py`; `scripts/kb_gaps.py` |
| Mục đích | Đo chất lượng trả lời, tìm câu chưa trả lời (bổ sung KB), trích lead |
| Dữ liệu | user_hash (sha256 KHÔNG muối của user_id, 16 hex — bút danh, vẫn là dữ liệu cá nhân), câu hỏi ĐÃ `_mask_pii`, câu trả lời, ts, cờ answered/flagged; v5.1: thêm `channel` (zalo/messenger) và `route` (alcohol/health/consent_*) — Messenger ghi CHUNG file qua `zalo._reply` |
| Lớp | Đỏ |
| Chủ thể | Khách hàng chat Zalo/Messenger/web, nhân viên thử trên Streamlit |
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
| Module (code) | `pipelines/content.py`; `pipelines/video_studio.py`; `pipelines/llm_gateway.py`; `pipelines/store.py` |
| Mục đích | Soạn nháp nội dung marketing chờ người duyệt |
| Dữ liệu | Brief do nhân viên nhập (quy trình: không đưa dữ liệu khách), claim đã duyệt, nháp nội dung |
| Lớp | Vàng |
| Chủ thể | Nhân viên MKT (tên người duyệt trong approvals) |
| Nơi lưu | Bảng `content_drafts`, `approvals`, `agent_action_log`; v6.3 video nháp: `video_assets` + file mp4/sidecar ở VIDEO_OUT_DIR (brief chỉ ở prompt gửi LLM, không lưu) |
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
| Module (code) | `ingest/embed_store.py`; `scripts/vector_eval.py` |
| Mục đích | Tạo vector tìm kiếm cho chatbot |
| Dữ liệu | Đoạn văn bản public (sản phẩm, bài viết) đã crawl; v10.3 `scripts/vector_eval.py --questions` embed 10 câu hỏi kiểm thử CỐ ĐỊNH Q1–Q10 (tests/questions.md — không dữ liệu khách) để so backend float8/pgvector |
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
| Biện pháp bảo vệ (có trong code) | Chỉ qua `pipelines.llm_gateway` agent `ci_judge` — không gọi client LLM trực tiếp (test khóa); Model judge phải KHÁC HỌ nhà sản xuất với model agent (allowlist họ; router/alias lạ → từ chối trước mọi lời gọi); CI mỗi push (`--deterministic`) chỉ chạy suite luật (guardrail + kd_a1 — kd_a1 gateway giả) — 0 lời gọi LLM; hiện chưa suite active nào có ca judge |
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

### DF-19 — Lô hóa đơn điện tử NHÁP — ACC-Invoice (v9.0)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-19 |
| Module (code) | `agents/acc_invoice.py` |
| Mục đích | Chuẩn bị danh sách hóa đơn để kế toán nhập tay vào phần mềm HĐĐT sau khi lô được duyệt |
| Dữ liệu | Tên đơn vị mua, MST, địa chỉ, email nhận hóa đơn — CHỈ của đơn có yêu cầu xuất hóa đơn (file yêu cầu kế toán cung cấp); số tiền + tên hàng từ đơn sàn |
| Lớp | Đỏ |
| Chủ thể | Người mua yêu cầu xuất hóa đơn (doanh nghiệp/hộ kinh doanh/cá nhân có MST) |
| Nơi lưu | Thông tin người mua CHỈ trong file nháp gitignored `data/reports/hoa-don-nhap/lo-<batch_key>.csv`; DB (`invoice_lines`, `approval_queue`) chỉ hash + số tiền + cờ; không vào log/stdout/payload |
| Thời hạn lưu | File nháp chưa có hạn xóa tự động — GAP (external-dep: kế toán chốt hạn + quyền thư mục) |
| Bên nhận | Nội bộ — kế toán; agent KHÔNG gửi, KHÔNG gọi API nhà cung cấp HĐĐT, không ký số |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Payload hàng duyệt chỉ có hash rút gọn + số tiền + `csv_sha256`; test quét chuỗi người mua GIẢ; `--verify-draft` chỉ pass khi lô đã duyệt và sha256 file khớp; Module không import thư viện mạng/gateway LLM (test_fin_qa); Ô CSV chống formula injection |
| Căn cứ xử lý | Nghĩa vụ lập hóa đơn theo pháp luật thuế — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Retention file nháp + quyền thư mục `data/reports/hoa-don-nhap/` = external-dep; Nhà cung cấp HĐĐT + format nhập + chữ ký số = external-dep; Mốc `invoice_trigger` chờ tư vấn thuế chốt (hạn 25/10/2026) |

### DF-20 — Công nợ đại lý + hoa hồng — ACC-AR (v9.0)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-20 |
| Module (code) | `agents/acc_ar.py` |
| Mục đích | Tuổi nợ, cảnh báo nợ quá hạn vào bản tin GĐ tài chính, tính hoa hồng NHÁP |
| Dữ liệu | Mã đại lý (`dealer_code`), loại đại lý, chứng từ công nợ, số tiền, SKU, kênh — KHÔNG tên/SĐT đại lý |
| Lớp | Đỏ |
| Chủ thể | Đại lý (doanh nghiệp, hộ kinh doanh, cá nhân) |
| Nơi lưu | Bảng `dealer_ar` (insert-only theo sha256 file); bản tin `data/reports/director-finance-<ngày>.md` (gitignored) |
| Thời hạn lưu | Chưa đặt hạn — theo hạn lưu chứng từ kế toán (cần chốt) |
| Bên nhận | Nội bộ — kế toán / GĐ tài chính; không gửi thư nhắc nợ, không lệnh chi, không LLM |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Chỉ mã đại lý, header cố định — cột lạ (vd tên) chặn cả file; Bản tin chỉ in mã đại lý + số tiền, không chi tiết chứng từ; Hoa hồng là BẢN NHÁP theo chính sách MẪU chưa ký |
| Căn cứ xử lý | Thực hiện hợp đồng đại lý + nghĩa vụ kế toán — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Sổ công nợ thật (MISA) + chính sách hoa hồng đã ký = external-dep; Nối bảng `dealers` CRM v5.2 khi gộp (khóa `dealer_code`) |

### DF-25 — Đối soát quyết toán sàn — ACC-Recon (v9.0)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-25 |
| Module (code) | `ingest/settlement_csv.py`; `agents/kd_orders.py` |
| Mục đích | Đối soát tiền thực nhận + phí sàn với đơn đã nạp, phát hiện thu sai — chỉ báo cáo, không bút toán |
| Dữ liệu | Mã đơn (chỉ lưu hash sha256[:16]) + số tiền đơn/phí sàn/hoàn/thực nhận từ file quyết toán Seller Center; cột tên/SĐT/địa chỉ/username người mua bị bỏ ngay khi đọc |
| Lớp | Đỏ |
| Chủ thể | Người mua trên sàn (gián tiếp qua mã đơn đã hash) |
| Nơi lưu | Bảng `settlement_rows` + `recon_results` (không cột người mua); file nguồn do kế toán giữ ngoài repo. v10.1 KD-A6 (`agents/kd_orders.py`): đơn sàn → bảng lõi `orders` (id `<kênh>:<order_id_hash>`, không PII người mua) + file đối soát `data/reports/doi-soat-*.csv` (gitignored, chỉ 8 ký tự đầu hash). |
| Thời hạn lưu | Chưa đặt hạn — theo hạn lưu chứng từ kế toán (cần kế toán trưởng chốt) |
| Bên nhận | Nội bộ — kế toán / GĐ tài chính đọc `--report`; không gửi ra ngoài, không LLM |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Kiểm toàn file trước khi connect; lỗi chỉ nêu số dòng + tên field, không in giá trị ô; Cột người mua thuộc `drop` bị bỏ khi đọc; mã đơn chỉ lưu hash; Báo cáo trỏ dòng bằng `file dòng N`, không in mã đơn/hash |
| Căn cứ xử lý | Nghĩa vụ kế toán/thuế + thực hiện hợp đồng mua bán — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Mapping cột + biểu phí là GIẢ ĐỊNH — chờ file settlement thật ≥2 tuần mỗi sàn; Hạn lưu `settlement_rows` chưa chốt |

### DF-26 — Rà bài đăng kênh sở hữu từ file xuất tay (v4.3 PC-A4)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-26 |
| Module (code) | `agents/ra_kenh.py` |
| Mục đích | Phát hiện bài đang đăng vi phạm luật quảng cáo/lệch bản đã duyệt để Pháp chế ra lệnh gỡ/sửa trong 24 giờ |
| Dữ liệu | Text bài CÔNG KHAI của công ty trên website/fanpage/sàn (url, kênh, ngày đăng, draft_id) do Quản lý MXH xuất tay; kết quả guardrail, mã vi phạm, hạn 24 giờ |
| Lớp | Xanh |
| Chủ thể | không — chỉ bài của công ty, không bình luận/người tương tác (cột lạ trong file → từ chối cả file) |
| Nơi lưu | Bảng `channel_posts` + `approval_queue` (lệnh gỡ/sửa, không chép đoạn vi phạm) + `red_alerts` (S1) |
| Thời hạn lưu | không giới hạn — GAP (Pháp chế chốt) |
| Bên nhận | nội bộ, không gửi ra ngoài (không LLM, không gọi API kênh) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | File xuất tay kiểm toàn bộ trước khi ghi DB; cột lạ (bình luận, tên người) → từ chối, lỗi không in giá trị ô; Đoạn trích in ra/báo cáo qua `_mask_pii` (hotline, email trong bài); Agent không gỡ/sửa bài, không sửa golden — chỉ đề xuất vào hàng duyệt cho người quyết |
| Căn cứ xử lý | Nội dung công khai của chính công ty, không phải dữ liệu cá nhân — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Thời hạn lưu `channel_posts` chưa chốt; Quyền đọc kênh qua API thật chưa có — chỉ file xuất tay (external-dep) |

### DF-27 — FP&A tài chính–kế hoạch — giá vốn, P&L, ngân sách ads, chi phí vận hành, dòng tiền (v9.1)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-27 |
| Module (code) | `agents/fp_pnl.py`; `agents/fp_ads.py`; `agents/fp_opscost.py`; `agents/fp_cash.py`; `agents/fin_director.py` |
| Mục đích | P&L theo SKU/kênh, đề xuất ngân sách quảng cáo theo biên gộp, cảnh báo chi phí vận hành so trần, dòng tiền 13 tuần, bản tin tuần GĐ tài chính |
| Dữ liệu | Số liệu tổng hợp theo SKU × kênh × tháng (thực nhận quyết toán, giá vốn, lãi gộp), chi phí AI theo agent (`llm_usage`), chi phí dịch vụ cloud/SaaS nhập tay (mã dịch vụ + số tiền), dự báo dòng tiền theo tuần; tên người lập/duyệt giá vốn (nhân viên) — KHÔNG dữ liệu người mua, KHÔNG tên/SĐT đại lý cá nhân |
| Lớp | Vàng |
| Chủ thể | Nhân viên lập/duyệt giá vốn (GĐ sản xuất, GĐ tài chính); không có chủ thể là khách hàng |
| Nơi lưu | Bảng `cogs_versions` (append-only, duyệt qua function), `opex_entries` (insert-only theo sha256 file); báo cáo `data/reports/pnl-<tháng>.md` + `data/reports/director-finance-<ngày>.md` (gitignored); đề xuất/khoản vượt X trong `approval_queue` |
| Thời hạn lưu | Chưa đặt hạn — theo hạn lưu chứng từ kế toán (cần chốt) |
| Bên nhận | Nội bộ — GĐ tài chính / TGĐ; không gửi tự động, không LLM, không gọi API quảng cáo/nhà cung cấp |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | 0 import mạng/LLM (test FIN-QA subprocess `python -I`); mọi text FP&A qua `_mask_pii` không đổi; Giá vốn: người duyệt ≠ người lập chặn ở DB (function SECURITY DEFINER), bảng append-only; Đề xuất ads + khoản vượt ngưỡng X là mục chờ NGƯỜI duyệt (risk high, auto_policy không áp); khoản > X chỉ 'được chi' khi vai trò tgd duyệt; Báo cáo chỉ sku_key/kênh/số tiền — không mã đơn/hash, không tên người lập/duyệt |
| Căn cứ xử lý | Nghĩa vụ kế toán + lợi ích hợp pháp quản trị nội bộ — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Giá vốn thật + người lập/duyệt thật = external-dep (bảng `cogs_versions` trên DB thật để trống); Hóa đơn cloud/SaaS thật (thay `opex_MAU.csv`) = external-dep; Ngưỡng biên, hệ số ngân sách, trần chi phí, ngưỡng X, tỷ giá, chi cố định, độ trễ tiền sàn, số dư đầu kỳ (`data/fpa_config.json`) — GĐ tài chính chốt; TGĐ ký khoản vượt X + danh sách người/vai trò thật (`data/users.json`); Doanh thu đại lý/B2B từ MISA cho P&L kênh offline |

### DF-29 — Kênh Messenger (Facebook Page) — nhận tin và trả lời khách (v5.1)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-29 |
| Module (code) | `connectors/messenger.py`; `connectors/zalo.py`; `connectors/channels.py` |
| Mục đích | Chăm sóc khách hàng (CSKH) — trả lời câu hỏi sản phẩm qua chatbot, dùng chung pipeline Zalo |
| Dữ liệu | PSID Messenger thô (trong RAM/khóa lock), nội dung tin nhắn khách (có thể chứa SĐT, tên, địa chỉ, yếu tố sức khỏe), câu trả lời gửi lại |
| Lớp | Đỏ |
| Chủ thể | Khách hàng nhắn Fanpage Messenger của công ty |
| Nơi lưu | RAM `_histories` chung Zalo (khóa `messenger:<psid>`); `data/zalo_seen.db` (khóa dedup `msgr:<mid>`); convlog `data/conversations.jsonl` (`_uhash` + `_mask_pii`); `chat_consents` + mục `cskh_handoff` (user_hash có muối, chung Zalo) |
| Thời hạn lưu | `_histories`: RAM, LRU, mất khi restart; `zalo_seen.db`: TTL 1 giờ (SEEN_TTL_S) cho mid; convlog 30 ngày (RETAIN_DAYS) |
| Bên nhận | Meta Platforms — graph.facebook.com (Send API, header Bearer page token) — Meta nhận tin khách trực tiếp từ Messenger và câu trả lời từ hệ thống (máy chủ ngoài Việt Nam) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Chữ ký HMAC `X-Hub-Signature-256` (app secret) bắt buộc — sai/thiếu → 403, không parse; KHÔNG có bypass dev; DEPLOY tắt → `send_text` không gọi Graph API (chỉ [dry-run]); DEPLOY bật thiếu secret/token/muối → không serve; `channels.pre_route` trước LLM: rượu → template cố định, sức khỏe → template + chuyển người (không gọi LLM); Convlog/stdout chỉ `_uhash` + `_mask_pii` — không in PSID thô; page token ở header, không vào URL/log |
| Căn cứ xử lý | Đồng ý của khách — `chat_consents` (kênh messenger) ghi đồng ý tường minh; cờ `require_consent_for_llm` mặc định TẮT: GAP |
| GAP | Chưa có Meta app review + page token thật + webhook HTTPS public (external-dep) — kênh CHƯA mở cho khách thật; DPIA/TIA CHƯA KÝ — phải ký trước khi bật Messenger cho khách thật; CẦN LUẬT SƯ XÁC NHẬN: vai trò Meta (bên xử lý hay bên nhận độc lập) và căn cứ chuyển dữ liệu ra nước ngoài; Câu chào + chính sách NHÁP chờ Pháp chế (chung Zalo) |

### DF-30 — Gợi ý trả lời chat sàn Shopee/TikTok — MXH dán tay (v5.1)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-30 |
| Module (code) | `connectors/channels.py` |
| Mục đích | Gợi ý câu trả lời CSKH để nhân viên đọc/sửa rồi DÁN TAY trên Seller Center (không gọi API sàn) |
| Dữ liệu | Tin nhắn buyer sàn do Quản lý MXH dán vào CLI qua STDIN (có thể chứa SĐT/tên/địa chỉ), câu gợi ý trả lời |
| Lớp | Đỏ |
| Chủ thể | Người mua trên Shopee/TikTok Shop nhắn shop |
| Nơi lưu | Không lưu — CLI in ra màn hình, không ghi DB/convlog; câu hỏi đi gateway ghi `llm_usage` (số liệu, không nội dung) |
| Thời hạn lưu | Không lưu nội dung |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider qua gateway (agent `chatbot`, `_mask_pii` + ZDR) — chỉ khi câu không bị chặn trước LLM; sàn KHÔNG nhận gì từ hệ thống (người dán) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | `pre_route`: rượu/sức khỏe → template kênh sàn, không gọi LLM; Lọc chính sách sàn `san_violations` (url/domain/SĐT/zalo/facebook/địa chỉ cửa hàng) — vi phạm → thay CẢ câu bằng câu cố định; Tin buyer nhận qua STDIN (không argv/shell history), không in lại tin thô; Không gọi API sàn, không ghi DB — nhân viên đọc/sửa trước khi dán |
| Căn cứ xử lý | Chưa có căn cứ `staff_assist_dpia_v1` cho gợi ý LLM trên tin buyer sàn: GAP |
| GAP | Chưa có căn cứ xử lý `staff_assist_dpia_v1` (F03b bước 3) — CẦN LUẬT SƯ XÁC NHẬN trước khi dùng thường xuyên; Chưa có trần lượt dán/ngày + thống kê (someday) |

### DF-31 — Rà SEO website công ty (v6.5)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-31 |
| Module (code) | `agents/seo_web.py` |
| Mục đích | Phát hiện lỗi SEO/nội dung vi phạm trên website công ty để người quản trị web sửa TAY sau khi GĐ Marketing duyệt |
| Dữ liệu | HTML công khai các trang của chính website công ty (title, meta description, H1, thẻ img/alt, link nội bộ, mã HTTP) + dữ liệu đã crawl data/*.jsonl; không có dữ liệu cá nhân |
| Lớp | Xanh |
| Chủ thể | Không có chủ thể dữ liệu cá nhân (nội dung website của công ty) |
| Nơi lưu | `data/reports/seo-web-<ngày>.md` (gitignore) + 1 mục `approval_queue` khối marketing (`seo_web_fix`, payload chỉ URL + code + đề xuất) |
| Thời hạn lưu | Báo cáo ghi đè theo ngày; mục hàng duyệt theo vòng đời approval_queue |
| Bên nhận | website của chính công ty (GET qua collector, robots + ≥1s) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Mặc định `--from-crawl` 0 request; `--fetch` chỉ GET qua `crawler.intel.Fetcher` (robots.txt, ≥1s/host, ngân sách ≤200, chặn host ngoài `web.own_hosts` kể cả hop redirect); Không có đường ghi website (không POST/PUT, không WP REST ghi); không gọi LLM; Payload hàng duyệt không trích text vi phạm; URL có slug bị guardrail chặn → mã băm |
| Căn cứ xử lý | Không xử lý dữ liệu cá nhân |
| GAP | (không) |

### DF-32 — Connector API sàn chỉ đọc (ingest/market_api.py)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-32 |
| Module (code) | `ingest/market_api.py` |
| Mục đích | Đối soát listing/giá với golden + cảnh báo rượu/giá lệch (v3.3) mà không cần MXH xuất file tay |
| Dữ liệu | Gửi đi: thông tin xác thực app (partner_id/app_key, access token, chữ ký HMAC) + tham số truy vấn (offset/cursor, khoảng thời gian, danh sách mã sản phẩm/mã đơn) — không dữ liệu cá nhân. Nhận về: listing (mã/tên sản phẩm, SKU, giá, tồn, trạng thái) và đơn (mã đơn, trạng thái, dòng hàng) — response đơn CÓ THỂ chứa PII người mua (tên/SĐT/địa chỉ người nhận) chỉ nằm trong RAM của lời gọi và bị bỏ NGAY: chỉ trích field allowlist như market_csv, mã đơn → order_id_hash |
| Lớp | Đỏ |
| Chủ thể | Người mua trên Shopee/TikTok Shop (dữ liệu đơn) |
| Nơi lưu | Bảng `market_snapshots` (file_name `api:<kênh>:<loại>:<giờ>`), `market_rows` (chỉ field allowlist, `order_id_hash`), `market_alerts` — cùng staging v3.3 |
| Thời hạn lưu | Không giới hạn — GAP (cùng luồng nạp file sàn v3.3) |
| Bên nhận | Shopee Open Platform (partner.shopeemobile.com) / TikTok Shop API (open-api.tiktokglobalshop.com) — chỉ endpoint ĐỌC; hệ thống chỉ GỬI thông tin xác thực + tham số truy vấn, KHÔNG gửi dữ liệu cá nhân ra ngoài (dữ liệu đơn đi CHIỀU VỀ từ sàn, sàn vốn đang giữ) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Allowlist cứng (kênh, method, path) endpoint đọc — ngoài allowlist từ chối TRƯỚC khi request (test server giả đếm 0); Không theo redirect (3xx = lỗi), base URL chỉ https hoặc localhost (server giả), trần response 10MB + MAX_PAGES; Key/token chỉ ở env — thiếu → exit 2, 0 request; lỗi không in body/URL/token; PII người mua bỏ ngay trong RAM — row chỉ field allowlist, mã đơn hash; đơn shopee chỉ xin item_list |
| Căn cứ xử lý | Hợp đồng mua bán (thực hiện đơn) — CẦN LUẬT SƯ XÁC NHẬN (cùng luồng nạp file sàn v3.3) |
| GAP | Chữ ký/endpoint/field theo tài liệu công khai — CHƯA xác minh với sandbox sàn (external-dep: app key + sandbox); Chưa có cơ chế refresh token sàn (token hết hạn → exit lỗi, người xoay token); Chưa có hạn lưu cho dữ liệu đơn sàn (cùng luồng nạp file sàn v3.3) |

### DF-33 — Social listening nhà cung cấp (ingest/social_vendor.py)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-33 |
| Module (code) | `ingest/social_vendor.py` |
| Mục đích | Theo dõi thảo luận thị trường về sâm/thương hiệu (nhãn khen/chê/hỏi giá/hỏi sức khỏe/rượu) — chỉ đếm, không liên hệ người đăng |
| Dữ liệu | File export của nhà cung cấp social listening: thời gian, nền tảng, nội dung bài/bình luận CÔNG KHAI (che SĐT/email ngay khi đọc); cột định danh tác giả (tên, link profile, avatar, email, SĐT, URL bài, số follower) bị BỎ ngay khi đọc; mã tin/ID tác giả chỉ vào hash dedup có muối |
| Lớp | Vàng |
| Chủ thể | Người đăng công khai trên MXH/diễn đàn/báo (bên thứ ba, không phải khách đã đồng ý) |
| Nơi lưu | Bảng `social_mentions_vendor` (không cột định danh tác giả; `excerpt` CHỈ khi DPIA đã ký và tin không nhạy cảm) + meta file ở `intel_imports` (channel `vendor`) |
| Thời hạn lưu | Chưa có hạn lưu — GAP |
| Bên nhận | Không gửi ra ngoài (file do nhà cung cấp bàn giao, nạp tay; module không request mạng) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Cổng TGĐ fail-closed: `vendor_approved_by_tgd` phải đúng true + `approval_ref` — chưa duyệt → exit 2, không đọc file, không connect; Bỏ cột định danh tác giả ngay khi đọc; cột lạ → chặn cả file; `msg_hash` sha256 có muối `INTEL_HASH_SALT`; nhãn theo luật (không LLM); Bảng riêng — không trộn vào `social_mentions` kênh sở hữu |
| Căn cứ xử lý | Lợi ích hợp pháp (nghiên cứu thị trường trên dữ liệu công khai) — CẦN LUẬT SƯ XÁC NHẬN; chưa có DPA với nhà cung cấp: GAP |
| GAP | Chưa có hợp đồng + DPA với nhà cung cấp và quyết định TGĐ duyệt (external-dep); Chưa xác minh nguồn thu thập hợp pháp của vendor (điều khoản nền tảng, thông báo chủ thể); Chưa có hạn lưu `social_mentions_vendor`; DPIA chưa ký — `excerpt` đang tắt |

### DF-34 — Review sàn + bình luận kênh sở hữu → nháp trả lời UGC + xin phép/tái sử dụng UGC (MKT-07, v6.4)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-34 |
| Module (code) | `agents/mkt_ugc.py` |
| Mục đích | Soạn ĐỀ XUẤT trả lời review/bình luận (template, không LLM) và nháp tin xin phép dùng lại UGC để người phụ trách duyệt rồi đăng/gửi TAY |
| Dữ liệu | File review sàn Shopee/TikTok xuất tay (mã đánh giá, số sao, nội dung đánh giá — có thể chứa SĐT/email/tên/yếu tố sức khỏe; cột người mua/ảnh/mã đơn bỏ NGAY khi đọc); nhãn `social_mentions` v7.2 (không text khi DPIA chưa ký); contact_id + trạng thái consent `marketing` khi đề nghị tái sử dụng |
| Lớp | Đỏ |
| Chủ thể | Người mua để lại đánh giá trên sàn; khách bình luận/nhắn Fanpage/Zalo OA/TikTok của công ty; liên hệ trong `contacts` đồng ý cho dùng lại UGC |
| Nơi lưu | Nội dung review chỉ trong RAM lúc chạy (đã `_mask_pii`) — KHÔNG ghi DB/không in; `approval_queue` mục `ugc_reply`/`ugc_reuse`: lớp, kênh, nguồn (sha12 file + số dòng / `social_mentions#id`), câu đề xuất, contact_id — object_id `ugc-<sha256 có muối INTEL_HASH_SALT>` (không chép nội dung khách) |
| Thời hạn lưu | Mục hàng duyệt: theo `approval_queue` (không xóa — append-only trạng thái); nội dung review không lưu |
| Bên nhận | Không gửi ra ngoài — agent không gọi API sàn/MXH, không LLM; người phụ trách đăng/gửi tay trên Seller Center/kênh sở hữu sau duyệt |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Không LLM/mạng (AST test `test_no_ads_api_no_spend`, không thuộc `egress_modules`); Cột người mua/ảnh/mã đơn bỏ khi đọc, cột lạ → chặn cả file; `noi_dung` qua `_mask_pii` ngay khi đọc; lỗi chỉ in 'dòng N cột X'; `no_claim_echo`: câu trả lời không lặp claim/từ khóa sức khỏe khách nói; câu trả lời qua `check_publish`; Tái sử dụng UGC chỉ khi `crm.can_contact(contact_id, 'marketing')` = granted hiện hành; lớp sức khỏe/rượu luôn chặn (UGC_SENSITIVE) |
| Căn cứ xử lý | Đồng ý `marketing` (v5.2) cho tái sử dụng UGC — phạm vi mục đích chưa được Pháp chế xác nhận: GAP; trả lời review = lợi ích hợp pháp CSKH: CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Pháp chế xác nhận template trả lời UGC (`data/ugc_rules.json` + câu health/alcohol của `data/channels.json`) — CẦN LUẬT SƯ XÁC NHẬN; Pháp chế xác nhận mục đích consent `marketing` có bao gồm tái sử dụng UGC (ảnh/lời đánh giá) hay cần mục đích riêng; Tên cột file review là GIẢ ĐỊNH — đối chiếu 1 file xuất thật từ Seller Center (external-dep); DPIA chưa ký → `social_mentions` không có text, đề xuất trả lời chỉ theo nhãn |

### DF-35 — Form B2B yêu cầu báo giá + báo giá KD-A3 (v8.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-35 |
| Module (code) | `connectors/b2b_form.py`; `agents/kd_quote.py`; `ingest/crm.py` |
| Mục đích | Nhận yêu cầu báo giá quà Tết B2B; lập báo giá NHÁP cho GĐ bán hàng duyệt rồi NGƯỜI tự gửi (đồng ý mục đích `b2b`) |
| Dữ liệu | Tên + loại + tỉnh của TỔ CHỨC, tên/SĐT/email NGƯỜI LIÊN HỆ của tổ chức (vault Fernet), sản phẩm/số lượng/ngày cần hàng, IP người gửi (chỉ băm sha256 in-memory cho rate-limit, không ghi đĩa) |
| Lớp | Đỏ |
| Chủ thể | Người liên hệ của doanh nghiệp/khách sạn/đơn vị sự kiện/hiệp hội/cơ quan đặt quà Tết |
| Nơi lưu | Postgres: `contacts` (tên/SĐT/email MÃ HÓA Fernet, tra trùng HMAC), `consents` (mục đích `b2b`, nguồn `web`, `policy_version` b2b-v0-nhap), `b2b_requests` (insert-only — chỉ `contact_id`/`consent_id`, không PII người); báo giá trong `approval_queue` (KHÔNG tên/SĐT/email người liên hệ) + nháp `data/reports/bao-gia-*` (gitignored) |
| Thời hạn lưu | GIẢ ĐỊNH — Pháp chế chốt thời hạn giữ yêu cầu báo giá/người liên hệ; chưa có job xóa theo hạn: GAP |
| Bên nhận | Không — hệ thống không gửi; GĐ bán hàng tự gửi báo giá đã duyệt (`--verify-send` KHỚP sha256) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Endpoint mặc định TẮT (`B2B_FORM_ENABLED` env tiến trình, .env không bật được), bind 127.0.0.1 mặc định; Rate-limit 5 lượt/IP/giờ + 60 lượt/giờ toàn form, body ≤ 8 KB, chặn chunked/Content-Type lạ, honeypot — kiểm TRƯỚC khi đọc body/DB; Không echo input ở trang lỗi; log stdout chỉ mã + hash IP + mã YC; lỗi kết nối/ngoại lệ bất ngờ → stderr chỉ hash IP + tên lớp lỗi (không IP thô/traceback); Đồng ý mục đích `b2b` bắt buộc (append-only), PII chỉ trong vault mã hóa; Báo giá do template + code tính (0 LLM, 0 egress), qua `check_publish` + quét PII/rượu trước khi vào hàng duyệt; Rượu không bao giờ vào form/báo giá/catalog |
| Căn cứ xử lý | Đồng ý của người liên hệ (mục đích `b2b`, câu đồng ý NHÁP b2b-v0-nhap chờ Pháp chế): GAP tới khi Pháp chế chốt câu đồng ý + `policy_version` |
| GAP | `policy_version` b2b-v0-nhap + câu đồng ý là NHÁP — Pháp chế chốt; Tên hộ kinh doanh có thể là tên người (cột `org_name` không mã hóa) — kiểm mẫu tay; Chưa grant role DB hẹp cho form public (chạy DSN chủ sở hữu) — external-dep; DPIA luồng form chưa ký — KHÔNG bật endpoint trước khi ký; Chưa có job xóa theo thời hạn lưu (retention); Consent web KHÔNG xác minh SĐT (OTP/double opt-in = external-dep): người lạ gõ SĐT người khác tạo được yêu cầu + đồng ý b2b; SĐT trùng contact đã RÚT b2b → bỏ qua 0 ghi (code chặn), contact cũ giữ tên/email trong vault — GĐ bán hàng gọi xác minh danh tính trước khi gửi báo giá |

### DF-36 — Tra cứu khoa học nội bộ SX-A7 (v10.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-36 |
| Module (code) | `agents/sx_tracuu.py` |
| Mục đích | Tra cứu nội bộ tài liệu khoa học có trích nguồn DOI/URL cho bộ phận sản xuất — KHÔNG dùng cho truyền thông, không claim công dụng ra ngoài |
| Dữ liệu | Câu hỏi tra cứu của nhân viên sản xuất (≤2000 ký tự) + đoạn tài liệu khoa học NỘI BỘ đã được GĐ SX duyệt nạp (`chunks_internal` collection `internal:sx`); không dữ liệu cá nhân (đoạn trích qua `_mask_pii`) |
| Lớp | Vàng |
| Chủ thể | Không có chủ thể dữ liệu cá nhân (tài liệu khoa học/kỹ thuật); người hỏi là nhân viên nội bộ — không ghi tên |
| Nơi lưu | Tài liệu: Postgres `chunks_internal` (nạp qua `ingest.kb_internal --collection internal:sx --approved-by`); câu trả lời chỉ in stdout / file `data/reports/sx-tracuu-*.md` (gitignored) khi `--out`; module KHÔNG ghi bảng nào |
| Thời hạn lưu | Theo vòng đời tài liệu nội bộ trong `chunks_internal` (nạp lại theo doc_sha256); file báo cáo cục bộ — GIẢ ĐỊNH, chủ khối SX chốt |
| Bên nhận | Nhà cung cấp embedding/LLM qua `pipelines.llm_gateway` (agent `sx_tracuu`, cap tháng riêng; LLM chỉ khi `--llm`, mặc định tắt) — không gửi tới khách/kênh ngoài |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Collection `internal:sx` là HẰNG trong module; chatbot khách (`api.rag.answer`) không có tham số collection — test DB `test_public_retrieve_and_answer_never_return_sx`; Mọi đầu ra mở đầu nhãn "NỘI BỘ – không dùng cho truyền thông"; mặc định trích nguyên văn, LLM chỉ khi `--llm` + `guardrail.check` ok; Không có đường sang bản nháp nội dung/hàng duyệt/chatbot (grep test); câu về rượu → không tra, 0 embed; Gateway: PII mask + provider routing + kill/cap theo agent |
| Căn cứ xử lý | Lợi ích hợp pháp (nghiên cứu nội bộ, không dữ liệu cá nhân); bản quyền tài liệu khoa học bên ngoài: CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Tài liệu khoa học thật + GĐ SX duyệt nạp (`--approved-by` người thật) — external-dep; Bản quyền bài báo (PubMed/Semantic Scholar/tạp chí): chỉ nạp tài liệu được phép lưu nội bộ — Pháp chế xác nhận; Gửi đoạn tài liệu nội bộ qua nhà cung cấp embedding nước ngoài — TIA chưa ký |

### DF-37 — Dự báo thời tiết VT (v10.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-37 |
| Module (code) | `agents/vt_thoitiet.py` |
| Mục đích | Cảnh báo mưa lớn/rét và dấu hiệu sâu bệnh theo khoảnh → gợi ý "cần đi kiểm tra" cho GĐ vùng trồng |
| Dữ liệu | Tọa độ VÙNG trồng đã làm tròn 0,1° (~11 km, không phải tọa độ khoảnh) + số ngày dự báo gửi nhà cung cấp dự báo; dự báo mưa/nhiệt trả về; nhật ký `plot_logs` (chỉ mã khoảnh, ngày, cờ từ `detail`) đọc nội bộ |
| Lớp | Xanh |
| Chủ thể | Không có chủ thể dữ liệu cá nhân (tọa độ vùng làm tròn; digest không chứa người ghi nhật ký) |
| Nơi lưu | Digest `data/reports/vt-canh-bao-*.md` (gitignored) + mục `approval_queue` `weather_digest` khối farming khi `--submit`; dự báo không lưu DB |
| Thời hạn lưu | Mục hàng duyệt theo `approval_queue` (append-only trạng thái); file digest cục bộ — GIẢ ĐỊNH, GĐ vùng trồng chốt |
| Bên nhận | Nhà cung cấp dự báo (Open-Meteo hoặc API có phí) — CHỈ khi `fetch.enabled = true` (mặc định false), GET qua `crawler.intel.Fetcher` (robots, ≥1s/host, chặn sàn/MXH/tầng C); mặc định nhập tay CSV, không gửi gì |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | Tọa độ cấu hình bắt buộc đã làm tròn 0,1° (sai → exit 1); `[req]` chỉ chứa tọa độ vùng làm tròn (test parse query); Digest không chứa lat/lon/`location`/`area_m2`/người ghi; không chẩn đoán/liều lượng/hoạt chất; qua `guardrail.check` trước khi ghi; Cờ sâu bệnh CHỈ quét `detail` (`garden_director.log_flags`); 0 LLM; không gửi/đăng gì; GĐ duyệt mục = đã xem |
| Căn cứ xử lý | Lợi ích hợp pháp (vận hành vùng trồng, không dữ liệu cá nhân); điều khoản thương mại nhà cung cấp dự báo: CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Điều khoản thương mại Open-Meteo / API thời tiết có phí chưa xác minh — giữ `fetch.enabled=false`; Ngưỡng mưa/nhiệt + gán khoảnh→vùng GIẢ ĐỊNH — GĐ vùng trồng chốt; Người duyệt thật khối farming (`approvers: []`) — external-dep |

### DF-38 — Chăm sóc lại + xin đánh giá khách kênh sở hữu → nháp tin vào hàng duyệt (KD-A7, v10.1)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-38 |
| Module (code) | `agents/kd_care.py`; `ingest/crm.py` |
| Mục đích | Lập NHÁP tin nhắc mua lại / xin đánh giá CHỈ cho khách có đồng ý đúng mục đích để GĐ bán hàng duyệt rồi NGƯỜI gửi tay |
| Dữ liệu | contact_id + trạng thái đồng ý theo mục đích (`marketing` nhắc mua lại, `cskh` xin đánh giá) + lần mua kênh sở hữu do NGƯỜI ghi (`care_purchases`: kênh web/zalo/b2b/showroom, SKU, ngày mua/giao, mã nội bộ) — KHÔNG SĐT/tên/email/địa chỉ (PII chỉ trong vault `contacts` mã hóa, agent không giải mã) |
| Lớp | Đỏ |
| Chủ thể | Khách mua qua kênh sở hữu (web/Zalo/B2B/showroom) có trong `contacts` |
| Nơi lưu | Postgres: `care_purchases` (không cột PII), `approval_queue` mục `care_rebuy`/`care_review` (payload = tin template + `contact_id`/`muc_dich`/`gui_luc` — không PII/ciphertext/HMAC), `agent_action_log` (`care_purchase_record`) |
| Thời hạn lưu | GIẢ ĐỊNH — Pháp chế chốt thời hạn giữ lần mua/thời hạn liên hệ; chưa có job xóa theo hạn: GAP |
| Bên nhận | Không — hệ thống không gửi (không LLM, không mạng); người gửi tay qua Zalo OA/ZNS sau khi duyệt + `--verify-send` (sha bản duyệt + đồng ý còn hiệu lực + khung giờ) |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Khách sàn bị CHẶN ở DB (CHECK channel) — chỉ chăm sóc bằng công cụ của sàn; `crm.can_contact` mặc định False; rút đồng ý → lần chạy kế 0 mục, `--verify-send` trả `consent`; Trần 2 tin marketing/khách/tháng + khung giờ 08:00–20:00 (GIẢ ĐỊNH `data/care_rules.json`); Tin = template cố định (0 LLM), qua `check_publish` (nhãn QC, rượu, XNQC, khuyến cáo); chỉ SKU trong `v_promotable`; Module không đọc vault (không `load_vault_key`/`unseal`), không thuộc `egress_modules` |
| Căn cứ xử lý | Đồng ý của khách theo mục đích (`marketing`/`cskh`, v5.2) — câu đồng ý + thời hạn liên hệ chưa được Pháp chế chốt: GAP |
| GAP | Consent thật của khách + thời hạn liên hệ do Pháp chế chốt (test dùng consent fixture); Mẫu tin, khung giờ, trần tin/tháng là GIẢ ĐỊNH — GĐ KD/Pháp chế chốt; Chưa grant role DB hẹp cho `care_purchases` (CLI chạy DSN chủ sở hữu) — someday; Chưa có job xóa lần mua/liên hệ theo thời hạn (retention) |

### DF-39 — Kịch bản livestream (KD-A9) + gói video YouTube dài (MKT-12) qua LLM gateway (v10.1)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-39 |
| Module (code) | `agents/kd_live.py`; `agents/mkt_youtube.py`; `pipelines/llm_gateway.py` |
| Mục đích | Soạn NHÁP lời dẫn livestream + hỏi-đáp bình luận, gói video YouTube dài (tiêu đề/mô tả/chương/phụ đề) chờ người duyệt |
| Dữ liệu | Brief do nhân viên nhập (quy trình: không đưa dữ liệu khách), tên SKU golden + mã SKU trong giỏ (KHÔNG giá — giá do code điền sau), lời dẫn/kịch bản nháp; KHÔNG dữ liệu khách |
| Lớp | Vàng |
| Chủ thể | Nhân viên KD/MKT lập brief; người duyệt (tên trong approvals) |
| Nơi lưu | `content_drafts` (pending, `livestream_script`/`video`, kênh `youtube`), `agent_action_log` (`draft_create`, `youtube_short_render`); Shorts xem trước mp4 + sidecar ở VIDEO_OUT_DIR (`data/video_assets/`, gitignored, không metadata/không âm thanh) |
| Thời hạn lưu | Không giới hạn — hồ sơ duyệt append-only (bằng chứng tuân thủ quảng cáo); file Shorts xem trước xóa tay |
| Bên nhận | OpenRouter (Mỹ) → whitelist provider (Mỹ) — chỉ brief + tên SKU, qua `_mask_pii` của gateway |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | `_mask_pii` + kill-switch + trần chi phí tháng (`kd_livestream`, `mkt_youtube`) ở gateway; Từ chối TRƯỚC LLM: rượu, SKU không promotable, quá trần phiên/tuần, brief có từ cấm; Câu LLM chạm số/giá/rượu bị bỏ; giá do code từ `v_promotable`; câu hỏi sức khỏe → câu trả lời mẫu; `check_publish` toàn văn + 1 lượt sửa → vi phạm thì không lưu; YouTube `privacyStatus` cố định private, không có đường đăng |
| Căn cứ xử lý | Lợi ích hợp pháp/hợp đồng lao động với nhân viên — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email); Tài khoản livestream/kênh YouTube + API là external-dep; hậu kiểm transcript live chưa có (someday) |

### DF-42 — Nhân sự: xếp hạng hồ sơ ứng viên + tổng hợp chấm công theo mã NV (PC-HR, v12.2)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-42 |
| Module (code) | `agents/pc_hr.py` |
| Mục đích | Lập NHÁP xếp hạng hồ sơ (không tự loại) và tổng hợp ngày công/đi trễ/về sớm/thiếu chấm để Chuyên viên pháp chế–nhân sự duyệt |
| Dữ liệu | CV ứng viên .txt/.md (có tên/SĐT/email/kinh nghiệm) đọc TẠI MÁY từ `HR_INBOX_DIR` ngoài repo; file chấm công `ma_nv,ngay,gio_vao,gio_ra` (mã NV, không tên). Hàng duyệt chỉ nhận mã ứng viên = 12 ký tự đầu sha256 nội dung CV + số tiêu chí đạt/điểm/lý do theo tiêu chí JD, và số tổng hợp theo mã NV — KHÔNG tên/SĐT/email/tên file/nội dung CV |
| Lớp | Đỏ |
| Chủ thể | Ứng viên nộp hồ sơ; nhân viên Sâm Sâm chấm công |
| Nơi lưu | CV ở `HR_INBOX_DIR` (ngoài repo, module từ chối thư mục trong repo); Postgres `approval_queue` mục `hr_screening`/`hr_attendance`/`hr_jd` (append-only) + `agent_action_log` (`queue_enqueue`); bảng mã ↔ tên file chỉ in ra console người chạy (tên file qua `_mask_pii`) |
| Thời hạn lưu | GIẢ ĐỊNH — Pháp chế chốt thời hạn giữ CV/hồ sơ tuyển dụng và dữ liệu chấm công; hàng duyệt append-only giữ vĩnh viễn mã băm + số tổng hợp; chưa có job xóa CV trong `HR_INBOX_DIR`: GAP |
| Bên nhận | Không — không LLM, không mạng; người duyệt đọc trong hàng duyệt nội bộ |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Chấm tất định theo từ khóa JD, không gửi CV cho LLM; không tự loại ứng viên — mọi hồ sơ có trong danh sách + lý do; Cấu hình JD có tiêu chí phân biệt đối xử (giới tính/tuổi/hôn nhân/tôn giáo/dân tộc/quê quán/ngoại hình) → từ chối; File chấm công kiểm toàn file trước connect; mã NV giống SĐT/email hoặc có dấu cách (tên) → lỗi, 0 dòng; thông báo lỗi không in giá trị ô; Risk medium cho cả 3 loại mục — không auto_policy; agent không tính lương/kỷ luật |
| Căn cứ xử lý | Ứng viên: đồng ý khi nộp hồ sơ / thực hiện thủ tục trước giao kết hợp đồng lao động; nhân viên: hợp đồng lao động + nội quy — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Câu thông báo xử lý dữ liệu cho ứng viên + thời hạn giữ CV chưa được Pháp chế chốt; Tiêu chí JD và luật ca (`data/hr/*.json`) là BẢN DEV SOẠN/GIẢ ĐỊNH; chưa có lịch nghỉ lễ; Mã băm CV vẫn liên kết lại được với người khi giữ file gốc (dữ liệu bút danh hóa, không ẩn danh) |

## 3. Đánh giá rủi ro

Mức đề xuất, Pháp chế chốt. Quy tắc cố định: lớp Đỏ → cao, Vàng → trung bình, Xanh → thấp; luồng chuyển ra nước ngoài đánh giá thêm ở TIA.

| Mã | Hoạt động | Lớp | Mức rủi ro đề xuất | Ra nước ngoài | Số GAP |
|---|---|---|---|---|---|
| DF-01 | Kênh Zalo OA — nhận tin và trả lời khách | Đỏ | cao | không | 5 |
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
| DF-19 | Lô hóa đơn điện tử NHÁP — ACC-Invoice (v9.0) | Đỏ | cao | không | 3 |
| DF-20 | Công nợ đại lý + hoa hồng — ACC-AR (v9.0) | Đỏ | cao | không | 2 |
| DF-25 | Đối soát quyết toán sàn — ACC-Recon (v9.0) | Đỏ | cao | không | 2 |
| DF-26 | Rà bài đăng kênh sở hữu từ file xuất tay (v4.3 PC-A4) | Xanh | thấp | không | 2 |
| DF-27 | FP&A tài chính–kế hoạch — giá vốn, P&L, ngân sách ads, chi phí vận hành, dòng tiền (v9.1) | Vàng | trung bình | không | 5 |
| DF-29 | Kênh Messenger (Facebook Page) — nhận tin và trả lời khách (v5.1) | Đỏ | cao | có | 4 |
| DF-30 | Gợi ý trả lời chat sàn Shopee/TikTok — MXH dán tay (v5.1) | Đỏ | cao | có | 2 |
| DF-31 | Rà SEO website công ty (v6.5) | Xanh | thấp | không | 0 |
| DF-32 | Connector API sàn chỉ đọc (ingest/market_api.py) | Đỏ | cao | không | 3 |
| DF-33 | Social listening nhà cung cấp (ingest/social_vendor.py) | Vàng | trung bình | không | 4 |
| DF-34 | Review sàn + bình luận kênh sở hữu → nháp trả lời UGC + xin phép/tái sử dụng UGC (MKT-07, v6.4) | Đỏ | cao | không | 4 |
| DF-35 | Form B2B yêu cầu báo giá + báo giá KD-A3 (v8.2) | Đỏ | cao | không | 6 |
| DF-36 | Tra cứu khoa học nội bộ SX-A7 (v10.2) | Vàng | trung bình | có | 3 |
| DF-37 | Dự báo thời tiết VT (v10.2) | Xanh | thấp | có | 3 |
| DF-38 | Chăm sóc lại + xin đánh giá khách kênh sở hữu → nháp tin vào hàng duyệt (KD-A7, v10.1) | Đỏ | cao | không | 4 |
| DF-39 | Kịch bản livestream (KD-A9) + gói video YouTube dài (MKT-12) qua LLM gateway (v10.1) | Vàng | trung bình | có | 2 |
| DF-42 | Nhân sự: xếp hạng hồ sơ ứng viên + tổng hợp chấm công theo mã NV (PC-HR, v12.2) | Đỏ | cao | không | 3 |

## 4. Tổng hợp GAP

- [DF-01] `require_consent_for_llm` mặc định tắt — tin nhắn vẫn qua LLM trước khi khách đồng ý; Pháp chế quyết bật
- [DF-01] Câu chào + `policy_url` + `policy_version` trong `data/channels.json` là NHÁP — `policy_url` chưa xác minh trang tồn tại; chờ Pháp chế duyệt
- [DF-01] `chat_consents` chưa nối `consents` v5.2 khi khách để lại liên hệ; chưa có hạn lưu
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
- [DF-19] Retention file nháp + quyền thư mục `data/reports/hoa-don-nhap/` = external-dep
- [DF-19] Nhà cung cấp HĐĐT + format nhập + chữ ký số = external-dep
- [DF-19] Mốc `invoice_trigger` chờ tư vấn thuế chốt (hạn 25/10/2026)
- [DF-20] Sổ công nợ thật (MISA) + chính sách hoa hồng đã ký = external-dep
- [DF-20] Nối bảng `dealers` CRM v5.2 khi gộp (khóa `dealer_code`)
- [DF-25] Mapping cột + biểu phí là GIẢ ĐỊNH — chờ file settlement thật ≥2 tuần mỗi sàn
- [DF-25] Hạn lưu `settlement_rows` chưa chốt
- [DF-26] Thời hạn lưu `channel_posts` chưa chốt
- [DF-26] Quyền đọc kênh qua API thật chưa có — chỉ file xuất tay (external-dep)
- [DF-27] Giá vốn thật + người lập/duyệt thật = external-dep (bảng `cogs_versions` trên DB thật để trống)
- [DF-27] Hóa đơn cloud/SaaS thật (thay `opex_MAU.csv`) = external-dep
- [DF-27] Ngưỡng biên, hệ số ngân sách, trần chi phí, ngưỡng X, tỷ giá, chi cố định, độ trễ tiền sàn, số dư đầu kỳ (`data/fpa_config.json`) — GĐ tài chính chốt
- [DF-27] TGĐ ký khoản vượt X + danh sách người/vai trò thật (`data/users.json`)
- [DF-27] Doanh thu đại lý/B2B từ MISA cho P&L kênh offline
- [DF-29] Chưa có Meta app review + page token thật + webhook HTTPS public (external-dep) — kênh CHƯA mở cho khách thật
- [DF-29] DPIA/TIA CHƯA KÝ — phải ký trước khi bật Messenger cho khách thật
- [DF-29] CẦN LUẬT SƯ XÁC NHẬN: vai trò Meta (bên xử lý hay bên nhận độc lập) và căn cứ chuyển dữ liệu ra nước ngoài
- [DF-29] Câu chào + chính sách NHÁP chờ Pháp chế (chung Zalo)
- [DF-30] Chưa có căn cứ xử lý `staff_assist_dpia_v1` (F03b bước 3) — CẦN LUẬT SƯ XÁC NHẬN trước khi dùng thường xuyên
- [DF-30] Chưa có trần lượt dán/ngày + thống kê (someday)
- [DF-32] Chữ ký/endpoint/field theo tài liệu công khai — CHƯA xác minh với sandbox sàn (external-dep: app key + sandbox)
- [DF-32] Chưa có cơ chế refresh token sàn (token hết hạn → exit lỗi, người xoay token)
- [DF-32] Chưa có hạn lưu cho dữ liệu đơn sàn (cùng luồng nạp file sàn v3.3)
- [DF-33] Chưa có hợp đồng + DPA với nhà cung cấp và quyết định TGĐ duyệt (external-dep)
- [DF-33] Chưa xác minh nguồn thu thập hợp pháp của vendor (điều khoản nền tảng, thông báo chủ thể)
- [DF-33] Chưa có hạn lưu `social_mentions_vendor`
- [DF-33] DPIA chưa ký — `excerpt` đang tắt
- [DF-34] Pháp chế xác nhận template trả lời UGC (`data/ugc_rules.json` + câu health/alcohol của `data/channels.json`) — CẦN LUẬT SƯ XÁC NHẬN
- [DF-34] Pháp chế xác nhận mục đích consent `marketing` có bao gồm tái sử dụng UGC (ảnh/lời đánh giá) hay cần mục đích riêng
- [DF-34] Tên cột file review là GIẢ ĐỊNH — đối chiếu 1 file xuất thật từ Seller Center (external-dep)
- [DF-34] DPIA chưa ký → `social_mentions` không có text, đề xuất trả lời chỉ theo nhãn
- [DF-35] `policy_version` b2b-v0-nhap + câu đồng ý là NHÁP — Pháp chế chốt
- [DF-35] Tên hộ kinh doanh có thể là tên người (cột `org_name` không mã hóa) — kiểm mẫu tay
- [DF-35] Chưa grant role DB hẹp cho form public (chạy DSN chủ sở hữu) — external-dep
- [DF-35] DPIA luồng form chưa ký — KHÔNG bật endpoint trước khi ký
- [DF-35] Chưa có job xóa theo thời hạn lưu (retention)
- [DF-35] Consent web KHÔNG xác minh SĐT (OTP/double opt-in = external-dep): người lạ gõ SĐT người khác tạo được yêu cầu + đồng ý b2b; SĐT trùng contact đã RÚT b2b → bỏ qua 0 ghi (code chặn), contact cũ giữ tên/email trong vault — GĐ bán hàng gọi xác minh danh tính trước khi gửi báo giá
- [DF-36] Tài liệu khoa học thật + GĐ SX duyệt nạp (`--approved-by` người thật) — external-dep
- [DF-36] Bản quyền bài báo (PubMed/Semantic Scholar/tạp chí): chỉ nạp tài liệu được phép lưu nội bộ — Pháp chế xác nhận
- [DF-36] Gửi đoạn tài liệu nội bộ qua nhà cung cấp embedding nước ngoài — TIA chưa ký
- [DF-37] Điều khoản thương mại Open-Meteo / API thời tiết có phí chưa xác minh — giữ `fetch.enabled=false`
- [DF-37] Ngưỡng mưa/nhiệt + gán khoảnh→vùng GIẢ ĐỊNH — GĐ vùng trồng chốt
- [DF-37] Người duyệt thật khối farming (`approvers: []`) — external-dep
- [DF-38] Consent thật của khách + thời hạn liên hệ do Pháp chế chốt (test dùng consent fixture)
- [DF-38] Mẫu tin, khung giờ, trần tin/tháng là GIẢ ĐỊNH — GĐ KD/Pháp chế chốt
- [DF-38] Chưa grant role DB hẹp cho `care_purchases` (CLI chạy DSN chủ sở hữu) — someday
- [DF-38] Chưa có job xóa lần mua/liên hệ theo thời hạn (retention)
- [DF-39] Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email)
- [DF-39] Tài khoản livestream/kênh YouTube + API là external-dep; hậu kiểm transcript live chưa có (someday)
- [DF-42] Câu thông báo xử lý dữ liệu cho ứng viên + thời hạn giữ CV chưa được Pháp chế chốt
- [DF-42] Tiêu chí JD và luật ca (`data/hr/*.json`) là BẢN DEV SOẠN/GIẢ ĐỊNH; chưa có lịch nghỉ lễ
- [DF-42] Mã băm CV vẫn liên kết lại được với người khi giữ file gốc (dữ liệu bút danh hóa, không ẩn danh)

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
