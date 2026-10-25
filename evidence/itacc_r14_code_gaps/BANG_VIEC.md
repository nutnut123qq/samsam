# Bảng việc r14 — phần code còn thiếu bám DOCX (lập TRƯỚC khi sửa code, 25/10/2026)

Baseline `main` `0afa388` (snapshot ngoài repo `D:\code\samsam_r14_baseline`, `git archive`). Nhánh `codex/docx-code-gaps`.
Không DB `samsam`, không gọi nhà cung cấp thật, không tải model, không ký/duyệt thay hai bên.

Phân loại: **A** code làm được ngay · **B** code cần đặc tả/quyết định trước khi viết · **C** code đã có, chưa kiểm tích hợp
thật · **D** nghĩa vụ/hạ tầng/nghiệm thu ngoài phần mềm.

## Phạm vi triển khai

| ID | Loại | Hiện trạng (0afa388) | Phần sửa | Điều kiện PASS | Cách kiểm |
|---|---|---|---|---|---|
| C1 OCR chết tiến trình | A | `_paddle_engine()` khởi tạo PaddleOCR trong tiến trình gọi; model đủ tên/khác rỗng nhưng hỏng → native crash giết intake/sx_label; timeout chỉ bọc suy luận (thread), không bọc khởi tạo, không dừng được engine | import + khởi tạo + render trang + suy luận chạy trong TIẾN TRÌNH CON (`ingest/ocr_worker.py`), cha chỉ kiểm model + đợi có timeout; crash/treo/output hỏng → `DocError` | probe P1: caller sống + lỗi có kiểm soát ở model hỏng, worker crash, worker treo (thu hồi, không kết quả muộn); thiếu/rỗng file vẫn từ chối 0 downloader; model hợp lệ OCR thật ảnh + PDF; scan trắng/ảnh hỏng/quá trang đúng; qua intake + sx_label CLI | probe P1 (PaddleOCR thật + gói `paddleocr` giả trên PYTHONPATH cho crash/treo), pytest |
| C2 nâng cấp neo cho người duyệt | A | `upgrade()` gọi `use_reason(..., False)` → giai đoạn có người duyệt chặn cả người; CLI không truyền `--by`; `anchor_receipt_human` chỉ `da_gui`/`loi` và trả id `da_gui` cũ trước khi xét trạng thái | function `anchor_upgrade_human` (SECURITY DEFINER, search_path cố định, PUBLIC không EXECUTE, chỉ app_human); `upgrade(by=)` kiểm cổng theo người + danh tính DB TRƯỚC HTTP; CLI `cli_gate`; chỉ mục 1 `da_nang_cap`/lần gom (unique) | probe P2 (login Postgres thật): người đúng quyền ở co_nguoi_duyet nâng cấp được; agent/sai khối/giả `--by`/login không ánh xạ/chạy thử → 0 HTTP 0 dòng; job vận hành vẫn chạy; chạy lại không trùng; SQL trực tiếp không vượt quyền | probe P2 trên DB test (baseline schema vs schema mới), pytest DB, nâng cấp schema ×2 |
| C3a refresh token Shopee/TikTok | A | chưa có (lượt trước ghi "tài liệu không truy cập được") | đã đọc tài liệu CHÍNH THỨC (25/10/2026, `NGUON_TAI_LIEU.md`); `--refresh` + tự refresh khi sắp hết hạn, kho token tệp NGOÀI repo `MARKET_TOKEN_FILE` (ghi nguyên tử, khóa tệp), allowlist đúng 2 endpoint auth, 1 lần thử, không theo redirect, không in token | probe P3 (server giả): refresh hợp lệ xoay vòng + lưu trước khi dùng; lỗi/thiếu field → kho không đổi exit 1; redirect không theo; tính năng tắt/thiếu cấu hình → 0 request; không token trong stdout/stderr; đối chứng: kéo listing cũ không đổi | probe P3, pytest server giả — mức CONTRACT_TESTED, UNVERIFIED_LIVE |

## Không triển khai lượt này (có lý do)

| ID | Loại | Lý do | Cần ai |
|---|---|---|---|
| C3b quyết toán Shopee qua API (`/api/v2/payment/get_escrow_list` + `get_escrow_detail`, GET) | B | Endpoint có tài liệu chính thức, nhưng `escrow_amount` gồm ~40 thành phần (gồm thuế khấu trừ VAT/PIT/CIT VN, phí FBS…) — ánh xạ vào 7 cột `settlement_rows` (phí cố định/thanh toán/dịch vụ/vận chuyển/voucher/affiliate/hoàn) là QUYẾT ĐỊNH KẾ TOÁN; tự chọn = đoán số doanh thu chia sẻ (HĐ 7.6) | Kế toán Bên B chốt bảng ánh xạ trường escrow → cột quyết toán + 1 file income thật để đối chiếu; app có quyền Payment |
| C3c quyết toán TikTok qua API | B | Bản `finance/202309` bị liệt là deprecated; không tìm thấy trang chính thức bản hiện hành (Partner Center docv2 trả "No document found" với đường dẫn đoán) — không đoán endpoint | Bên B (tài khoản Partner Center) cung cấp tài liệu chính thức finance hiện hành + quyền app |
| C4 hồ sơ | — | cập nhật bảng 12 mục, kết quả nghiệm thu nội bộ, DONE/board | lượt này |

## 12 mục bị chặn — phân loại đầu lượt (cập nhật cuối lượt ở `docs/handover/dau-vao-va-quyet-dinh.md` mục H)

| ID | Loại hiện trạng |
|---|---|
| production-03, data_platform-02.1 | A (C1 crash tiến trình) + C (engine thật/ảnh thật chờ Bên B/Pháp chế) |
| farming-01 | C (whisper_local MOCK, chưa có model duyệt) |
| marketing-02.1 | C (MOCK, chờ model/DPA/key/trần) |
| production-02 | C/D (14 hồ sơ gốc Bên B) |
| data_platform-06 | A (C3a refresh) + B (C3b/C3c quyết toán) + C (sandbox) |
| intel-05.1 | C/D (DPIA/TIA ký, DPA, ≥3 nhà cung cấp) |
| farming-06 | A (C2 đường người) + C/D (provider/phí hai bên) |
| sales-08, sales-09 | D (repo website riêng — không xây ở đây) |
| ceo-90, data_platform-90 | D (nghĩa vụ/hạ tầng; N22 cần backup trước sự cố) |
