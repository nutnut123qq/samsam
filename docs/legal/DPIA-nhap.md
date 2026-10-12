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
| Căn cứ xử lý | Đồng ý của khách — CHƯA có cơ chế ghi nhận trong code (bảng consent, tin chào có link chính sách): GAP |
| GAP | Chưa có cơ chế ghi nhận đồng ý (bảng consent) trước khi xử lý tin nhắn; `zalo_seen.db` lưu user_id thô trong khóa `follow:<user_id>` tới 7 ngày; CẦN LUẬT SƯ XÁC NHẬN: Zalo/VNG là bên xử lý (cần hợp đồng xử lý) hay bên nhận độc lập |

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
| Dữ liệu | user_hash, câu hỏi đã mask, intent (partner/order/price/contact), trạng thái chăm sóc |
| Lớp | Đỏ |
| Chủ thể | Khách hàng, người hỏi làm đại lý |
| Nơi lưu | Bảng `leads` (Postgres) |
| Thời hạn lưu | Không có hạn lưu trong code — GAP |
| Bên nhận | Nội bộ (Sales/Admin) — không gửi ra ngoài |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Câu hỏi đã mask từ convlog; Chỉ lưu user_hash |
| Căn cứ xử lý | Đồng ý — CHƯA có cơ chế ghi nhận trong code: GAP |
| GAP | Bảng `leads` không có hạn lưu / job xóa — GAP; Chưa có cơ chế đồng ý riêng cho mục đích liên hệ bán hàng |

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
| GAP | Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài; Chưa có bản ghi đồng ý trước lượt gọi LLM; Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà |

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
| Module (code) | `crawler/intel.py` |
| Mục đích | Tình báo thị trường: tin về sâm, TPBVSK, đồ ăn giới trẻ, quảng cáo, đối thủ |
| Dữ liệu | Tiêu đề + trích ≤300 ký tự + link tin RSS/Atom công khai (đã che SĐT/email); có thể nhắc tên người trong tin báo chí |
| Lớp | Xanh |
| Chủ thể | Người được nhắc tên trong tin báo chí công khai (nếu có) |
| Nơi lưu | Bảng `intel_items` (không lưu toàn văn) |
| Thời hạn lưu | Chưa có hạn lưu/purge — GAP |
| Bên nhận | Chỉ GET tới nguồn RSS tầng A/B trong `data/intel_sources.json`; tóm tắt LLM (mặc định TẮT) qua gateway → OpenRouter (Mỹ) |
| Chuyển ra nước ngoài | CÓ — xem TIA |
| Biện pháp bảo vệ (có trong code) | robots.txt + delay ≥1s/host, chặn cứng sàn/MXH kể cả khi redirect; Chỉ tiêu đề + trích ≤300 ký tự, `_mask_pii` trước khi lưu; LLM tóm tắt chỉ chạy khi `llm.enabled` + `--llm`, qua gateway + guardrail |
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

### DF-18 — Đối soát quyết toán sàn — ACC-Recon (v9.0)

| Mục | Nội dung |
|---|---|
| Mã luồng | DF-18 |
| Module (code) | `ingest/settlement_csv.py` |
| Mục đích | Đối soát tiền thực nhận + phí sàn với đơn đã nạp, phát hiện thu sai — chỉ báo cáo, không bút toán |
| Dữ liệu | Mã đơn (chỉ lưu hash sha256[:16]) + số tiền đơn/phí sàn/hoàn/thực nhận từ file quyết toán Seller Center; cột tên/SĐT/địa chỉ/username người mua bị bỏ ngay khi đọc |
| Lớp | Đỏ |
| Chủ thể | Người mua trên sàn (gián tiếp qua mã đơn đã hash) |
| Nơi lưu | Bảng `settlement_rows` + `recon_results` (không cột người mua); file nguồn do kế toán giữ ngoài repo |
| Thời hạn lưu | Chưa đặt hạn — theo hạn lưu chứng từ kế toán (cần kế toán trưởng chốt) |
| Bên nhận | Nội bộ — kế toán / GĐ tài chính đọc `--report`; không gửi ra ngoài, không LLM |
| Chuyển ra nước ngoài | Không |
| Biện pháp bảo vệ (có trong code) | Kiểm toàn file trước khi connect; lỗi chỉ nêu số dòng + tên field, không in giá trị ô; Cột người mua thuộc `drop` bị bỏ khi đọc; mã đơn chỉ lưu hash; Báo cáo trỏ dòng bằng `file dòng N`, không in mã đơn/hash |
| Căn cứ xử lý | Nghĩa vụ kế toán/thuế + thực hiện hợp đồng mua bán — CẦN LUẬT SƯ XÁC NHẬN |
| GAP | Mapping cột + biểu phí là GIẢ ĐỊNH — chờ file settlement thật ≥2 tuần mỗi sàn; Hạn lưu `settlement_rows` chưa chốt |

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
| DF-18 | Đối soát quyết toán sàn — ACC-Recon (v9.0) | Đỏ | cao | không | 2 |
| DF-19 | Lô hóa đơn điện tử NHÁP — ACC-Invoice (v9.0) | Đỏ | cao | không | 3 |
| DF-20 | Công nợ đại lý + hoa hồng — ACC-AR (v9.0) | Đỏ | cao | không | 2 |

## 4. Tổng hợp GAP

- [DF-01] Chưa có cơ chế ghi nhận đồng ý (bảng consent) trước khi xử lý tin nhắn
- [DF-01] `zalo_seen.db` lưu user_id thô trong khóa `follow:<user_id>` tới 7 ngày
- [DF-01] CẦN LUẬT SƯ XÁC NHẬN: Zalo/VNG là bên xử lý (cần hợp đồng xử lý) hay bên nhận độc lập
- [DF-04] Tên người, địa chỉ, mã đơn đứng tự do trong câu hỏi KHÔNG bị `_mask_pii` che (chỉ SĐT/email) — rủi ro tồn dư
- [DF-04] Chưa có luồng xóa theo yêu cầu chủ thể (theo user_hash)
- [DF-04] `_uhash` không muối — user_id Zalo dạng số có thể dò ngược ra hash (bút danh, không phải ẩn danh)
- [DF-05] Bảng `leads` không có hạn lưu / job xóa — GAP
- [DF-05] Chưa có cơ chế đồng ý riêng cho mục đích liên hệ bán hàng
- [DF-06] Tên người/địa chỉ đứng tự do lọt mask — rủi ro tồn dư khi chuyển ra nước ngoài
- [DF-06] Chưa có bản ghi đồng ý trước lượt gọi LLM
- [DF-06] Điều khoản xử lý dữ liệu (DPA) với OpenRouter/nhà cung cấp chưa được Pháp chế rà
- [DF-07] Không có kiểm tra tự động chặn dữ liệu khách bị dán vào brief (ngoài mask SĐT/email)
- [DF-09] Tên nhân viên trong tài liệu không bị mask khi embedding
- [DF-10] Chưa có hạn lưu cho bản gốc
- [DF-11] Chưa có hạn lưu cho dữ liệu đơn sàn
- [DF-15] Mã hóa backup là tùy chọn — chưa bắt buộc
- [DF-15] Nếu bật offsite cloud nước ngoài phải bổ sung TIA
- [DF-16] Chưa che họ tên người trong tiêu đề/trích tin (NER)
- [DF-16] Chưa có hạn lưu/purge `intel_items`
- [DF-18] Mapping cột + biểu phí là GIẢ ĐỊNH — chờ file settlement thật ≥2 tuần mỗi sàn
- [DF-18] Hạn lưu `settlement_rows` chưa chốt
- [DF-19] Retention file nháp + quyền thư mục `data/reports/hoa-don-nhap/` = external-dep
- [DF-19] Nhà cung cấp HĐĐT + format nhập + chữ ký số = external-dep
- [DF-19] Mốc `invoice_trigger` chờ tư vấn thuế chốt (hạn 25/10/2026)
- [DF-20] Sổ công nợ thật (MISA) + chính sách hoa hồng đã ký = external-dep
- [DF-20] Nối bảng `dealers` CRM v5.2 khi gộp (khóa `dealer_code`)

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
