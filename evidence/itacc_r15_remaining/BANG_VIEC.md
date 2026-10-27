# Bảng việc r15 — phần code còn thiếu của 12 mục DOCX (lập TRƯỚC khi sửa code, 25/10/2026)

Baseline `main` = GitHub `70ff9f74c3328cf4ecfd7f173d6a0a6a666f6046` (“Complete OCR isolation, anchor approval and market
token refresh”), snapshot ngoài repo `D:\code\samsam_r15_baseline` (`git archive`, hash từng tệp ở
`SNAPSHOT_baseline_70ff9f7_SHA256SUMS.txt`). Nhánh `codex/remaining-docx-code-r15`. Các dòng “chưa commit / HEAD 0afa388”
trong checkpoint r14 là trạng thái lúc thu evidence — đã phát hành bằng 70ff9f7.

Không DB `samsam`, không gọi sàn/nhà cung cấp thật, không tải model, không gửi neo, không ký/duyệt thay hai bên.

Loại: **A** code làm được ngay theo đặc tả có sẵn · **B** code cần đặc tả/quyết định cụ thể trước · **C** code đã có, chưa
kiểm với môi trường/dữ liệu thật · **D** hạ tầng/nghĩa vụ/biên bản ngoài phần mềm. Một mục có thể nhiều loại.

## 1. Phát hiện khi đối chiếu tài liệu chính thức (đọc 25/10/2026, trình duyệt)

- **TikTok Shop finance CÓ tài liệu chính thức hiện hành** — r14 ghi “không tìm được trang chính thức bản hiện hành” là
  SAI (đường dẫn đoán). Trang Finance trên Partner Center: Get Statements `GET /finance/202309/statements`, Get Transactions
  by Statement `GET /finance/202501/statements/{statement_id}/statement_transactions`, Get Transactions by Order 202501,
  Get Unsettled Transactions 202507, Get Payments 202605. Chi tiết ở `NGUON_TAI_LIEU.md`.
- Shopee escrow: xác nhận lại 2 endpoint GET, host live `partner.shopeemobile.com`, sandbox
  `openplatform.sandbox.test-stable.shopee.sg`; phân trang `page_no` (≥1) + `page_size` (≤100, mặc định 40) + `more`.
  Mã lỗi nghiệp vụ của nhóm Payment KHÔNG theo dạng `error_*` (vd `income_not_found`, `order_not_found`) → bộ lọc mã lỗi
  r14-fix2 (`error_[a-z0-9_]+`) sẽ ẩn mất các mã này → cần nới theo dạng chữ thường nối `_` (vẫn ẩn mọi giá trị chứa
  credential) để lỗi nghiệp vụ còn chẩn đoán được (dây chuyền của data_platform-06).

## 2. Bảng 12 mục

| ID | Yêu cầu / căn cứ | Entry point hiện có (70ff9f7) | Phần thực sự còn thiếu | Loại | Phép kiểm + điều kiện xong | Đầu vào thiếu — ai — ở đâu |
|---|---|---|---|---|---|---|
| data_platform-06 | PL01 mục 3b + 6: “từ P2 kết nối API chỉ đọc”; dữ liệu quyết toán đi vào đối soát (finance-01/06) | `ingest/market_api.py` (listing/đơn, allowlist, refresh, 429/5xx, cổng tính năng); quyết toán chỉ qua `ingest/settlement_csv.py` | (1) transport + phân trang + kiểm phản hồi quyết toán Shopee escrow (A); (2) transport + kiểm phản hồi TikTok statements/transactions theo tài liệu 202309/202501 (A — đính chính r14); (3) cơ chế ánh xạ thành phần → cột `settlement_rows` có cổng: cấu hình chưa chốt/thiếu người chốt/thành phần lạ → BLOCKED trước khi ghi, dry-run báo thiếu gì, 0 thay đổi sổ (A); (4) provenance nguồn (CSV/API thật; sandbox/server giả không bao giờ vào sổ) + chống cộng trùng CSV↔API (A); (5) BẢNG ÁNH XẠ THẬT (thành phần nào vào cột nào, dấu, loại giao dịch TikTok nào ghi đơn nào, thuế khấu trừ) (B — Kế toán) ; (6) chạy sandbox/live (C) | probe S (server giả + Postgres thật, cùng tệp trên baseline/sau): phân trang đủ + trần trang, `page_size`≤100, HTTP lỗi/429/5xx/JSON hỏng/thiếu trường, redirect không theo, refresh trước khi kéo, không token/PII trong lỗi, ánh xạ chưa chốt → BLOCKED 0 request 0 dòng, thành phần lạ → BLOCKED 0 dòng, payload sai → 0 dòng ghi dở, phát lại không cộng trùng, mâu thuẫn trong lượt → lỗi không chọn bản, CSV↔API cùng đơn → chặn, provenance, tính năng tắt → 0 request | Kế toán Bên B: bảng ánh xạ ký (tệp `data/settlement_api_map.json` điền `da_chot` + người/căn cứ) + 1 file income thật để đối chiếu; chủ shop: app chỉ đọc có quyền Payment/Finance, sandbox, credential ngoài repo; quyết định nơi lưu credential |
| production-03 | PL01 SX: đối soát nhãn từ ảnh | `agents/sx_label --image` → OCR tiến trình con `ingest/ocr_worker` → so hồ sơ → `label_check` | không (với engine tại chỗ) — vendor khác chỉ viết khi có đặc tả | C + D | hồi quy P1 r14 (crash/treo/model hỏng → lỗi có kiểm soát; không tải ngầm) | engine dùng thật + ảnh nhãn thật + `label_rules.json` duyệt — GĐ SX + Pháp chế |
| data_platform-02.1 | PL01 nền tảng: số hóa tài liệu | `ingest/doc_intake` intake/`--reprocess-pending`/`--verify`, `documents.ocr_engine` | không | C + D | hồi quy P1 r14 + test doc_intake | tài liệu thật được phép xử lý, engine, `loader_gate.json` — Bên B + Pháp chế/DPO |
| farming-01 | PL01 vùng trồng: nhật ký vườn qua giọng nói | `connectors/zalo_garden --transcribe` (`whisper_local`) | **kiểm tra đầu lượt:** `GARDEN_STT_TIMEOUT_S` chỉ bọc bước nhận dạng, KHÔNG bọc bước nạp model (khác chuẩn OCR r14) → nạp model treo = CLI treo vô hạn (A nếu probe xác nhận); model/vendor thật (C/D) | A? + C + D | probe T: thiếu model/cấu hình → exit 2 trước đọc audio, 0 tải; ghi âm hỏng/rỗng/quá dài → lỗi có kiểm soát; nạp model treo → hết `GARDEN_STT_TIMEOUT_S` trả lỗi; nháp giữ `cho_chep_loi` | model Whisper duyệt tải sẵn hoặc STT trong nước + DPA, payload OA thật, danh sách nhân viên, chính sách lưu — GĐ vùng trồng + Pháp chế/DPO |
| marketing-02.1 | PL01 MKT: ảnh AI | `pipelines/image_provider_openrouter.py` qua `llm_gateway` | không | C + D | hồi quy r13-fix4 (ảnh HTTP 200 hỏng vẫn ghi chi phí, trần, người duyệt) | model, điều khoản/DPA, key, trần, packshot — GĐ MKT + Pháp chế + TGĐ |
| production-02 | PL01 SX: 14 hồ sơ gốc ↔ 13 SKU | `ingest/product_dossiers --check` | không (không tạo hồ sơ giả) | D | hồi quy `--check` exit 2 khi thiếu | 14 hồ sơ gốc + ánh xạ — GĐ SX |
| intel-05.1 | PL01 intel: persona giả lập | `scripts/persona_sim.py` | không | C + D | hồi quy: lượt thật bị chặn khi thiếu DPIA/≥3 NCC/key; dry-run không tính chạy thật | DPIA/TIA ký, DPA, NCC duyệt, key, ngân sách — Pháp chế + TGĐ + DPO |
| farming-06 | PL01 P2: neo blockchain | `pipelines/anchor` build/submit/verify/export/upgrade + `anchor_upgrade_human` + trigger chống trùng | không | C + D | hồi quy Q2 r14-fix2 + P2 r14 + `g_anchor`/`n_anchor_gate` | provider/phí/người ủy quyền + xác minh bên thứ ba — Hai bên |
| sales-08 | PL01 3a: website bán hàng | repo này: `listing_export --website-feed` + `--verify` | **website (trang SP/giỏ/thanh toán/đơn) = code còn thiếu ở REPO RIÊNG** (chưa có repo/owner/hợp đồng giao tiếp) | B (repo riêng) + C | hồi quy feed/verify (giá web đã duyệt, kiểm phiên bản) | repo + owner + domain + hợp đồng giao tiếp đơn — Bên B/owner website |
| sales-09 | PL01 3a: chatbot website | không (ngoài repo) | **chatbot website = code còn thiếu ở REPO RIÊNG**; chưa có đặc tả kênh để viết giao tiếp phía repo này | B (repo riêng) | — (không tạo endpoint phỏng đoán) | repo + owner + đặc tả kênh — Bên B/owner website |
| ceo-90 | HĐ: nghĩa vụ N01–N22, PL05 | `scripts/incident_compare.py`, sổ nghĩa vụ | không | D | hồi quy incident_compare (từ chối DB samsam, không kết luận khi thiếu baseline) | thực hiện/ký N01–N22, PL05; backup TRƯỚC sự cố cho N22 — Hai bên + DBA |
| data_platform-90 | PL01 mục 8, PL02 mục 2: hạ tầng on-prem | `scripts/onprem_preflight.py`, backup mã hóa/offsite | không | D | hồi quy preflight (dump + offsite thật theo manifest; Docker/fixture ≠ server Bên B) | server vật lý, UPS, offsite máy khác, giám sát, khóa backup — Bên B |

## 3. Ranh giới

- Không tự quyết hạch toán: repo giao `data/settlement_api_map.json` với MỌI quyết định để trống (`chua_chot`, người/căn
  cứ null). Fixture của probe ghi rõ “GIẢ” và chỉ kiểm cơ chế, không xác nhận cách hạch toán thật.
- Sandbox/server giả: chỉ `--dry-run`, KHÔNG ghi `settlement_rows` (8 agent đọc thẳng bảng này để tính doanh thu/phí; bảng
  không có cột mẫu) — dữ liệu không phải API thật không bao giờ vào sổ.
- Website/chatbot website không xây trong repo này.
