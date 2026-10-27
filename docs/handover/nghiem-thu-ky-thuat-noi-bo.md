# Nghiệm thu KỸ THUẬT NỘI BỘ trên máy dev — checkpoint hiện hành r15 (code còn thiếu của 12 mục DOCX, 25/10/2026)

> **Đây KHÔNG phải nghiệm thu hợp đồng.** Kiểm hành vi phần mềm trên máy dev, DB Postgres thử cô lập, dữ liệu fixture giả. Không xác nhận thay hai bên, không đổi `acceptance_status` (vẫn 0/96 `da_nghiem_thu`), không coi máy này là server Bên B, không dùng số ĐẠT nội bộ thay số nghiệm thu hợp đồng. Ma trận nghiệm thu hợp đồng (`ma-tran-nghiem-thu.md`) giữ vai trò riêng.

## 0a. Checkpoint r15-fix1 — vá 3 lỗi tiền F1/F2/F3 của r15 (26/10/2026)

- **Phạm vi:** mã r15 CHƯA vá (fp mã `70f54e56b1451a0a010328abca139c8c58f0414a88ab62a773a852415a66c5eb`, snapshot ngoài repo
  `D:\code\samsam_itacc_r15fix1_baseline` + SHA256SUMS) → bản vá; CHƯA commit/merge/push/deploy; không DB `samsam`;
  container riêng `samsam-itacc-r15fix1` (127.0.0.1:55461). Evidence `evidence/itacc_r15_fix_1/` (README provenance).
- **Probe hồi quy (cùng tệp, PASS/FAIL theo kỳ vọng đúng):** Postgres Docker riêng, login THÀNH VIÊN `svc_loader`, CSV qua
  `settlement_csv.main()`, API qua `settlement_api._write()`, parser thật: **trước 15/23 → sau 38/0**.

| Lỗi | Trước (r15 chưa vá) | Sau | Probe trước → sau |
|---|---|---|---|
| F1 CSV/API đồng thời | kiểm "nguồn khác" rồi mới INSERT, không khóa → 3/3 lượt đua cả hai exit 0, 2 dòng, view 180.000 | `lock_orders` (advisory xact lock theo kênh+đơn, 256 ngăn, thứ tự tăng, đòi READ COMMITTED) đầu transaction ghi ở CẢ HAI đường → [0,2], 1 dòng 90.000, bên sau chờ khóa (pg_locks) rồi `[blocked]`; cùng nguồn nhiều giao dịch + 2 lô chồng ngược thứ tự vẫn nhận | 5/3 → 8/0 |
| F2 trường tiền thiếu/null/sai kiểu | Shopee bỏ qua None/chuỗi/bool; thành phần vắng = 0; TikTok "" = 0 → ghi exit 0 | đã ánh xạ ⇒ phải hợp lệ; vắng = 0 chỉ khi `khi_vang: "bang_0"` (Kế toán; cấm cho order_amount/payout); `check_rows` trong `_write` chặn cột None trước connect; 1 dòng lỗi = 0 dòng cả lượt; 0/"0" vẫn nhận | 7/14 → 21/0 |
| F3 đơn vị tiền Shopee | pri/aff_currency bị bỏ, số USD vào `*_vnd` | `*_pri` ↔ `pri_currency`, trường thường ↔ `aff_currency` (đặc tả get_escrow_detail đọc lại 26/10/2026), không mã ↔ `tien_te_shop` (null = chặn); chỉ VND, không quy đổi; mã tiền tệ không thành LẠ | 3/6 → 9/0 |

- **Tổng nội bộ:** không đổi — 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (data_platform-06 vẫn BỊ CHẶN: bảng ánh xạ Kế toán + API thật).
  Nghiệm thu hợp đồng 0/96. API sàn mới kiểm server giả.
- **Gate (fp mã chốt `f8033335…95e2`):** ruff EXIT 0; pytest tập trung 4 tệp settlement/market_api 205 passed / 0 failed /
  0 skipped EXIT 0 (DB test riêng `samsam_itacc_r15fix1_focus2`). **Full pytest (26/10/2026, DB `samsam_itacc_r15fix1_full2`, RAM
  trống 3.354 MB lúc bắt đầu): 73 failed / 6903 passed / 2 skipped / 6 errors, 2827,95 s, EXIT 1 — KHÔNG PASS.** 66/74 mục lỗi có
  mã tiến trình con 0xC0000142 (DLL init failed — máy cạn bộ nhớ), 7 ca video nhiều khả năng cùng nguyên nhân (chưa xác minh),
  1 ca do `output/` chưa theo dõi; 0 ca thuộc settlement/market_api/r15. Chi tiết
  `evidence/itacc_r15_fix_1/README.md` mục Gate, log `gate/full_chot.txt`.
  **Chạy lại 27/10/2026 (/cycle): full PASS — 6984 passed / 0 skipped / 0 failed**, chia 11 lượt pytest nối tiếp (mỗi lượt một
  tiến trình mới, cùng thứ tự `--collect-only`, cùng DB test riêng `samsam_cycle_r15_full`), 0xC0000142×0, Docker bật (DR + S01
  PASSED), `output/` đã dời ra ngoài repo; cold-check độc lập chạy lại trên DB `samsam_cycle_r15_audit` cũng 6984 passed → PASS.
  Evidence `evidence/cycle_r15_gate/full_shards.txt`.

## 0. Checkpoint r15 — phần code còn thiếu của 12 mục DOCX (25/10/2026)

- **Phạm vi:** baseline đã phát hành `main` = GitHub `70ff9f74c3328cf4ecfd7f173d6a0a6a666f6046` (snapshot ngoài repo
  `D:\code\samsam_r15_baseline`, `git archive`, 16.713 tệp khớp blob). Nhánh `codex/remaining-docx-code-r15`; CHƯA
  commit/merge/push/deploy; không DB `samsam`; container riêng `samsam-itacc-r15` (127.0.0.1:55457). Evidence
  `evidence/itacc_r15_remaining/` (bảng việc 12 mục `BANG_VIEC.md` lập TRƯỚC khi code; nguồn tài liệu `NGUON_TAI_LIEU.md`).
  Các dòng "chưa commit / HEAD 0afa388" ở checkpoint r14/r14-fix2 dưới là trạng thái lúc thu evidence — đã phát hành bằng 70ff9f7.
- **Đính chính r14/r14-fix2:** "TikTok finance chưa có tài liệu chính thức bản hiện hành" SAI — Partner Center có nhóm Finance
  chính thức hiện hành (Get Statements 202309, Get Transactions by Statement 202501, …); r14 đã đoán đường dẫn.

| Việc (ID) | Trước (70ff9f7) | Sau (fp mã `70f54e56b145…`) | Probe trước → sau (PASS/FAIL, cùng sha) | Mức |
|---|---|---|---|---|
| Quyết toán qua API sàn (data_platform-06) | không có — `--kind settlement` bị CLI từ chối; mã lỗi nhóm Payment (`income_not_found`…) bị ẩn | `market_api --kind settlement --from --to [--dry-run]` → `ingest/settlement_api.py`: Shopee escrow list/detail, TikTok statements + transactions (allowlist 4 GET, `{statement_id}` chỉ nhận số), phân trang có trần, 429/5xx thử lại, redirect không theo, refresh trước request; ánh xạ thành phần → cột theo `data/settlement_api_map.json` (chưa chốt/LẠ/null → BLOCKED trước khi ghi; dry-run báo thiếu gì, 0 DB); CHỈ API thật được ghi sổ (`settlement_rows.source_kind` csv\|api_live); CSV ↔ API cùng đơn → chặn; ghi 1 transaction, lỗi → 0 dòng | S 2/21 → 23/0 | CONTRACT_TESTED (server giả + Postgres thật) |
| Hạn STT bọc nạp model (farming-01) | `GARDEN_STT_TIMEOUT_S` chỉ bọc nhận dạng — nạp model treo làm CLI treo (T04 tới trần ngoài 25 s) | nạp model trong luồng có hạn — lỗi trong hạn; thông điệp lỗi nạp model giữ nguyên | T 5/1 → 6/0 | MOCK (gói faster_whisper giả) |

- **Migration (probe M 7/0):** DB lịch sử: schema 0afa388 + 2 `upgrade()` baseline ĐỒNG THỜI (2 `da_nang_cap` hợp lệ) →
  schema 70ff9f7 + core/golden + 1 file quyết toán CSV bằng code 70ff9f7 → áp schema/roles r15 ×2 exit 0: số dòng và nội dung
  MỌI bảng theo cột cũ, `v_settlement_khoan`, biên nhận neo, đuôi hash chain, verify_action_log 0 — giữ nguyên; dòng cũ
  `source_kind='csv'`; quyền chỉ thêm (0 mất, 0 thêm); app_human không INSERT `settlement_rows`/`anchor_receipts`; svc_loader
  INSERT được cột mới; mọi SECURITY DEFINER giữ `search_path`, `*_human` không cấp PUBLIC.
- **Hồi quy (mã cuối):** r14_p1_ocr_isolation 11/0, r14_p2_anchor_human 13/0, r14_p3_market_refresh 10/0, r14fix2_q1_refresh_leak 14/0, r14fix2_q2_anchor_migration 10/0, r13_g_anchor 5/0, r13_e_market_v2 5/0, fix4_n_anchor_gate 9/0.
- **Kiểm lại 2 mục** (tiêu chí `criteria/r15_items_v1.json` = tiêu chí hiện hành chỉ đổi tên DB/thư mục): data_platform-06 BỊ CHẶN 9/0/0, farming-01 BỊ CHẶN 28/0/3.
- **Tổng nội bộ (code sinh `tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (r14-fix2: 84/0/12). Nguồn: r10 29, r11 4, r12 42, r12fix 4, r13 9, r13fix4 3, r14 2, r14fix2 1, r15 2; 5408 tham
  chiếu evidence khớp, 0 vi phạm nhất quán. Nghiệm thu hợp đồng 0/96.
- **Full/gate (fp mã `70f54e56b1451a0a010328abca139c8c58f0414a88ab62a773a852415a66c5eb`):** full pytest **6944 passed in 3537.24s (0:58:57), EXIT 0** (`gate/full_chot_f2.txt`, DB mới `samsam_itacc_r15_full2`; lần 1 trên fp v1 `gate/full_chot_f1.txt` 6940 passed / 4 failed — test drift-guard schema chưa cho phép CHECK `source_kind` mới → sửa test, khóa fp v2, chạy lại probe + full); ruff
  EXIT 0; eval `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0; red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret `gate/secret_scan.txt`.
- **Code còn thiếu (B — cần đặc tả trước):** (1) BẢNG ÁNH XẠ quyết toán của Kế toán (thành phần → cột/dấu/bỏ qua, loại giao
  dịch TikTok → mã đơn + nhãn `txn_type`, thuế khấu trừ) — code chỉ áp bảng, không tự quyết; (2) website + chatbot website ở
  REPO RIÊNG (chưa có repo/owner/hợp đồng giao tiếp đơn, đặc tả kênh chat).
- **Còn chờ bên ngoài:** `dau-vao-va-quyet-dinh.md` mục I.

## 0-r14fix2. Checkpoint r14-fix2 (LỊCH SỬ — đính chính TikTok finance ở mục 0) — vá 2 lỗi controller của r14 (25/10/2026)

- **Phạm vi:** nhánh `codex/docx-code-gaps` (HEAD `0afa388`, r14 chưa commit). Snapshot r14 CHƯA vá ngoài repo
  `D:\code\samsam_r14fix_snapshot` (khớp fp mã `ed6a3551…`); lịch sử neo hợp lệ dựng bằng code baseline `0afa388`
  (`D:\code\samsam_r14_baseline`). CHƯA commit/merge/push/deploy; không DB `samsam`; container riêng `samsam-itacc-r14fix2`
  (127.0.0.1:55456). Evidence `evidence/itacc_r14_fix_2/`.
- **Đính chính r14:** (1) "refresh không in token" chưa đúng — trường lỗi của sàn (`error` Shopee / `code` TikTok) được in
  nguyên văn qua `mc._safe` (chỉ che PII), nên phản hồi phản chiếu token/khóa lộ ra stdout và chuỗi exception; cùng cụm ở
  `_request` (đường dữ liệu). (2) "nâng cấp schema ×2 PASS" chỉ đúng với lịch sử không trùng — lịch sử HỢP LỆ có 2
  `da_nang_cap` cùng lần gom (2 upgrade baseline chạy đồng thời) làm `create unique index anchor_receipts_upgrade_once` lỗi
  23505; và r14 báo `new: True` cho cả 2 caller đua dù chỉ 1 dòng được ghi.

| Lỗi | Trước (snapshot r14) | Sau (fp mã `10c77bd2fb44…`) | Probe trước → sau (PASS/FAIL, cùng sha) | Mức |
|---|---|---|---|---|
| F1 credential lọt log lỗi refresh | `{"error": <refresh token>}` / `{"code": <app_secret>}` / dict/list chứa token → in nguyên văn ở `[err]` + exception; đường dữ liệu cũng vậy | `market_api._err_code`: chỉ in mã đúng dạng (Shopee `error_[a-z0-9_]`, TikTok số nguyên), loại mọi mã chứa credential đã biết, khác → "đã ẩn"; áp cả refresh lẫn `_request`; HTTP/mạng/JSON vẫn chỉ status/loại lỗi | Q1 6/8 → 14/0 | CONTRACT_TESTED (server giả) |
| F2 migration lỗi với lịch sử trùng hợp lệ | áp schema r14 lên DB có 2 `da_nang_cap` hợp lệ cùng lần gom → 23505, schema không nâng cấp được; 2 caller đua đều báo `new: True` | bỏ chỉ mục unique; trigger `anchor_receipts_upgrade_once` (BEFORE INSERT `da_nang_cap`: khóa advisory theo lần gom + kiểm lại dưới khóa → 23505 cho dòng MỚI, lịch sử không đụng); function `anchor_upgrade_human` trả `(receipt_id, created)`; đường job ghi dưới cùng khóa; `new` = có thật tạo dòng; lịch sử > 1 dòng → báo `so_dong_nang_cap`, CLI in "N biên nhận da_nang_cap (lịch sử)" | Q2 5/5 → 10/0 | LOCAL, login Postgres THẬT, calendar giả |

- **Migration (Q2 + `runs/upgrade_tu_schema_r14.txt`):** lịch sử dựng bằng 2 lời gọi `upgrade()` baseline đồng thời (barrier ở
  calendar giả, cây OTS hợp lệ) → áp schema/roles mới ×2 exit 0; số dòng mọi bảng, từng dòng biên nhận (id/status/sha256/
  created_by), đuôi hash chain, verify_action_log 0, quyền chỉ thêm — giữ nguyên. Nâng cấp từ DB đã có schema r14 cũ (chỉ mục
  + function kiểu bigint) ×2: chỉ mục bỏ, trigger có, function trả TABLE, app_human EXECUTE, PUBLIC không, app_human không
  INSERT, dòng giữ nguyên. Đồng thời sau nâng cấp: job+job, người+người, người+job → đúng 1 dòng mới, 1 `new` True + 1 False;
  ca chặn (job ở có người duyệt, sai `--by`, chạy thử) 0 GET 0 dòng.
- **Hồi quy (mã cuối):** r14_p1_ocr_isolation 11/0, r14_p2_anchor_human 13/0, r14_p3_market_refresh 10/0, r13_g_anchor 5/0, r13_e_market_v2 5/0, fix4_n_anchor_gate 9/0.
- **Kiểm lại 2 mục** (tiêu chí `criteria/r14fix2_v1.json` = r14_v1 chỉ đổi tên DB/thư mục): farming-06 BỊ CHẶN 27/0/1, data_platform-06 BỊ CHẶN 9/0/0.
- **Tổng nội bộ (code sinh `tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (r14: 84/0/12). Nguồn: r10 29, r11 4, r12 42, r12fix 4, r13 10, r13fix4 3, r14 2, r14fix2 2; 5392 tham chiếu
  evidence khớp, 0 vi phạm nhất quán. Nghiệm thu hợp đồng 0/96.
- **Full/gate (fp mã `10c77bd2fb44271e063e1724d318bb81297ae57a8e9665b66bd995ccb5c89866`):** full pytest **6893 passed in 4066.75s (1:07:46)**, EXIT 0, 0 failed / 0 skipped (`gate/full_chot_f1.txt`, DB mới
  `samsam_itacc_r14fix2_full1`); ruff EXIT 0; eval `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0; red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret
  `gate/secret_scan.txt`.
- **Còn chờ (không đổi):** quyết toán API sàn (Kế toán chốt ánh xạ escrow Shopee + tài liệu finance TikTok); website/chatbot
  repo riêng; vendor/dữ liệu thật/hạ tầng/biên bản hai bên — `dau-vao-va-quyet-dinh.md` mục H.

## 0-r14. Checkpoint r14 (LỊCH SỬ — 2 đính chính F1/F2 ở mục 0) — phần code còn thiếu bám DOCX: C1 OCR, C2 neo cho người duyệt, C3a refresh token (25/10/2026)

- **Phạm vi:** nhánh `codex/docx-code-gaps` từ `main` `0afa388` (snapshot `D:\code\samsam_r14_baseline`, `git archive`), CHƯA
  commit/merge/push/deploy. Không DB `samsam`; container riêng `samsam-itacc-r14` (127.0.0.1:55455). Bảng việc A/B/C/D lập
  TRƯỚC khi code: `evidence/itacc_r14_code_gaps/BANG_VIEC.md`; nguồn tài liệu API sàn: `NGUON_TAI_LIEU.md`.
- **Đính chính:** checkpoint r13/r13-fix4 ghi "bảng chờ CHỈ còn đầu vào ngoài code" và "tài liệu chính thức sàn không truy
  cập được" — CHƯA đúng: còn code chưa viết (3 việc dưới + quyết toán qua API), tài liệu Shopee/TikTok mở được bằng trình
  duyệt (công cụ tải trang bị chặn domain). Bảng chờ hiện hành: `dau-vao-va-quyet-dinh.md` mục H.

| Việc | Trước (0afa388) | Sau (fp mã `ed6a35516235…`) | Probe trước → sau (PASS/FAIL, cùng sha) | Mức |
|---|---|---|---|---|
| C1 OCR chết/treo tiến trình gọi | model đủ tên + khác rỗng nhưng hỏng → PaddleOCR native crash giết intake/reprocess/sx_label (0xC0000005); engine abort giết caller; treo khi khởi tạo không có timeout (kết quả muộn ghi được) | `ingest/ocr_worker.py`: nạp model + render + nhận dạng ở TIẾN TRÌNH CON; cha kiểm model rồi đợi có timeout (bọc cả nạp model), crash/treo/kết quả hỏng → `DocError`; con không nhận DSN | P1 4/7 → 11/0 | LOCAL (PaddleOCR thật + gói giả crash/treo) |
| C2 nâng cấp neo cho người duyệt | `upgrade()` chặn mọi người ở giai đoạn có người duyệt; CLI không truyền `--by` | `upgrade(by=)`: cổng theo người + `human_actor` TRƯỚC HTTP; ghi qua function `anchor_upgrade_human` (SECURITY DEFINER, search_path cố định, chỉ app_human EXECUTE); 1 `da_nang_cap`/lần gom (unique) | P2 10/3 → 13/0 | MOCK calendar, login Postgres THẬT |
| C3a refresh token sàn | không có | `--refresh` + tự refresh khi < 1 giờ theo tài liệu chính thức (Shopee POST `/api/v2/auth/access_token/get`, TikTok GET `/api/v2/token/refresh`); kho `MARKET_TOKEN_FILE` ngoài repo, ghi nguyên tử, khóa tệp, 1 lần thử, không redirect, không in token; `AUTH_ALLOWED` cứng | P3 3/7 → 10/0 | CONTRACT_TESTED (server giả) — UNVERIFIED_LIVE |

- **Không làm (B — cần quyết định/tài liệu):** quyết toán qua API — Shopee escrow có tài liệu nhưng ánh xạ ~40 thành phần
  (gồm thuế khấu trừ VAT/PIT/CIT) vào 7 cột `settlement_rows` là quyết định Kế toán; TikTok finance chưa có tài liệu chính thức
  bản hiện hành. Tạm dùng `ingest.settlement_csv`.
- **Probe:** khóa trước khi sửa (`KHOA_PROBE_truoc_sua.txt`). Ca P3 `kho_trong_repo`/`doi_chung_tat` cũng PASS ở baseline do
  `--refresh` không tồn tại (argparse exit 2, 0 request) — chỉ là đối chứng. P1 lượt `sau_chot2` FAIL 2 ca intake/reprocess
  do dùng lại DB đã có tài liệu (intake báo trùng) — chạy lại trên DB mới dựng từ cây cuối (`sau_chot3`), probe không đổi.
  Hồi quy r13/r13-fix4 trên mã cuối: a_ocr 10/0, b_stt 8/0, c_image_v2 13/0, d_dossier 5/0, e_market_v2 5/0, f_persona 4/0, g_anchor 5/0, h_feed 4/0, i_incident 5/0, l_image_cost 9/0, m_backup_files 14/0, n_anchor_gate 9/0, j_onprem_v3 5/0; `k_ocr_models_v2` 6/1 (ca đòi PaddleOCR khởi tạo TRONG tiến trình
  gọi — đúng điều C1 cố ý đổi) → v3 bỏ đúng điều kiện đó: 7/0.
- **Kiểm lại 4 mục** (tiêu chí `criteria/r14_v1.json` kế thừa nguyên ca nguồn hiện hành + ca R14 mới, khóa trước): production-03 BỊ CHẶN 12/0/0, data_platform-02.1 BỊ CHẶN 14/0/0, farming-06 BỊ CHẶN 27/0/1, data_platform-06 BỊ CHẶN 9/0/0.
  Lô k1 dừng có chủ đích (sửa blocker catalog sai trước khi chốt fingerprint); lô k2: farming-06 FAIL vì harness r13
  `anchor_ots_run` thay `upgrade.__defaults__` mà chữ ký mới thêm `by` ở vị trí → đổi `by` thành keyword-only (giữ nguyên chữ
  ký vị trí cũ) → fingerprint chốt v2, chạy lại cả 4 mục (k3).
- **Schema/roles:** function `anchor_upgrade_human` + chỉ mục unique `anchor_receipts_upgrade_once` + EXECUTE cho app_human;
  nâng cấp từ DB baseline CÓ DỮ LIỆU ×2: PASS (dòng mọi bảng, đuôi hash chain, verify_action_log 0, quyền chỉ thêm —
  `runs/upgrade_up1.txt`).
- **Tổng nội bộ (code sinh `tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (r13-fix4: 84/0/12). Nguồn: r10 29, r11 4, r12 42, r12fix 4, r13 10, r13fix4 3, r14 4; 5392 tham chiếu
  evidence khớp file/hash, 0 vi phạm nhất quán. 12 mục vẫn BỊ CHẶN; data_platform-06 nguyên nhân cập nhật (refresh đã có, quyết
  toán chưa). Nghiệm thu hợp đồng 0/96.
- **Full/gate (fp mã `ed6a3551623569aae681df676cb1a4e41dee382f482a1ecc48cc7a8a27e23fca`):** full pytest **6882 passed in 4687.76s (1:18:07)**, EXIT 0, 0 failed / 0 skipped (`gate/full_chot_f1.txt`, DB mới
  `samsam_itacc_r14_full1`); ruff EXIT 0; eval `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0; red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret
  `gate/secret_scan.txt`.
- **Giới hạn:** OCR mỗi tài liệu 1 tiến trình (nạp model ~10 s); refresh chưa chạy sandbox; nơi lưu credential cuối cùng chưa
  chốt; neo vẫn calendar giả. KHÔNG phải tích hợp thật/nghiệm thu hợp đồng.

## 0-r13fix4. Checkpoint r13-fix4 (LỊCH SỬ — xem đính chính ở mục 0) — vá 4 lỗi controller phát hiện ở r13 (25/10/2026)

- **Bối cảnh:** controller rà r13 (fp mã `1975775d…`) tái hiện 4 lỗi nên chưa duyệt đóng r13. Lượt này chỉ vá 4 lỗi +
  test/probe + hồ sơ; CHƯA commit/merge/push/deploy, không DB `samsam`, không đổi `acceptance_status` (0/96), không gỡ
  blocker. Snapshot r13 CHƯA vá ngoài repo `D:\code\samsam_r13fix_baseline` (khớp fp mã `1975775d…`, full `bf041789…`).
  Container riêng `samsam-itacc-r13fix4` (127.0.0.1:55454). Evidence `evidence/itacc_r13_fix_4/`.
- **Đính chính r13:** các claim r13 "model OCR cục bộ, không tự tải", "chi phí ảnh ghi từ usage.cost", "preflight đo bản
  backup gần nhất" và "`--upgrade` an toàn như submit" CHƯA đúng ở 4 điểm dưới (đúng sau bản vá này). Tiêu chí r13 đã khóa có
  ca mã hóa chính lỗi (farming-06 R03/R05/R06/R08 chạy `--upgrade` ở chạy thử; probe `j_onprem` ca 4 chấp nhận manifest
  giả) — thay bằng phiên bản mới có lý do, bản r13 giữ nguyên làm lịch sử.

| Lỗi | Tái hiện trên snapshot r13 (trước) | Sau vá (fp mã `38c4852b68bd…`) | Probe trước → sau (PASS/FAIL, cùng sha) | Mức |
|---|---|---|---|---|
| F1 OCR tự tải model | 3 bộ det/rec/cls có `inference.pdmodel`, thiếu `inference.pdiparams` → cổng cho qua, PaddleOCR THẬT gọi trình tải mạng (bị chặn trong probe); pdiparams rỗng → PaddleOCR nạp model giả, tiến trình chết 0xC0000005 | `ingest/doc_intake.py`: đòi đủ pdmodel + pdiparams không rỗng cho cả 3 bộ, thiếu → `DocError` nêu bộ thiếu TRƯỚC khi khởi tạo PaddleOCR; 0 downloader, 0 mạng; OCR thật ảnh + PDF với model đủ vẫn chạy | k_ocr_models_v2 2/5 → 7/0 | LOCAL (PaddleOCR thật, model cục bộ) |
| F2 mất chi phí ảnh hỏng | HTTP 200 `b64_json` hỏng + `usage.cost` 0.40 → ghi `cost_usd=0.0`; byte không phải ảnh → ghi `ok=true` | `pipelines/image_provider_openrouter.py`: HTTP 200 = ghi ĐÚNG 1 dòng chi phí đã báo trước khi kiểm ảnh, `ok=false` khi ảnh hỏng; không đọc được cost hợp lệ → mức dự phòng hiện có; 502 vẫn 0; cổng trước request giữ nguyên | l_image_cost 3/6 → 9/0 | MOCK (HTTP giả; sổ llm_usage + `_month_spend` thật ở pytest DB và mục marketing-02.1) |
| F3 preflight tin sổ | sổ `backup_runs` ok + manifest `{"encrypted":true}`, KHÔNG dump, offsite rỗng → `sao_luu:ban_gan_nhat` DAT; thời điểm tương lai cũng DAT | `scripts/onprem_preflight.py`: manifest hợp lệ (`db_backup.load_manifest`) + mã hóa, tệp dump THẬT khớp size/sha256 ở `BACKUP_DIR` VÀ offsite `dir:` (dump + manifest), không ở tương lai (>5 phút), chưa cấu hình offsite dir → CHUA_DAT | m_backup_files 4/10 → 14/0 | LOCAL (+ backup pg_dump THẬT ở mục data_platform-90/07.2; "khác thiết bị" chỉ GIẢ LẬP trong probe) |
| F4 `--upgrade` bỏ cổng | tính năng TẮT: submit bị chặn nhưng upgrade vẫn GET calendar | `pipelines/anchor.py`: `upgrade` gọi `rollout.use_reason` TRƯỚC mọi HTTP/INSERT (chạy thử/tắt/không xác định/có người duyệt với job agent → `AnchorError`, CLI exit 1); vận hành: 404 → chờ, attestation → `da_nang_cap` append-only, calendar ngoài cấu hình 0 GET | n_anchor_gate 4/5 → 9/0 | MOCK (calendar giả) |

- **Probe:** khóa sha trước khi vá (`KHOA_PROBE_truoc_va.txt`); probe K v1 chết cả tiến trình ở snapshot (ca pdiparams rỗng)
  → v2 cô lập từng ca (log v1 giữ). Hồi quy 10 probe r13 trên mã cuối: a_ocr 10/0, b_stt 8/0, c_image_v2 13/0, d_dossier 5/0, e_market_v2 5/0, f_persona 4/0, g_anchor 5/0, h_feed 4/0, i_incident 5/0; `j_onprem` v1
  3/1 (ca 4 mã hóa lỗi F3) → v3 (v2 lỗi cú pháp heredoc, log giữ): snapshot
  4/1 → mã cuối 5/0.
- **Kiểm lại 6 mục ảnh hưởng trực tiếp** (tiêu chí `criteria/r13fix4_v1.json` kế thừa nguyên ca r13 + ca FIX4 mới, khóa
  trước khi chạy; `r13fix4_v2.json` cho 2 mục backup — lô k1 FAIL ca FIX4 do LỖI TIÊU CHÍ placeholder `{sql:…}` ghép chuỗi,
  sản phẩm từ chối đúng "nằm trong repo"; log k1 giữ): production-03 BỊ CHẶN 11/0/0, data_platform-02.1 BỊ CHẶN 13/0/0, marketing-02.1 BỊ CHẶN 11/0/0, data_platform-90 BỊ CHẶN 9/0/1, data_platform-07.2 ĐẠT 12/0/0, farming-06 BỊ CHẶN 24/0/1. NOT_RUN chỉ ca cần thật (neo thật; hạ tầng Bên B).
- **Không đổi schema/roles** (docs/schema.sql, docs/roles.sql trùng snapshot) → không phát sinh migration.
- **Tổng nội bộ (code sinh `tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (r13: 84/0/12). Nguồn: r10 29, r11 4, r12 42, r12fix 4, r13 11, r13fix4 6; 5329
  tham chiếu evidence khớp file/hash, 0 vi phạm nhất quán. 12 mục vẫn BỊ CHẶN đúng nguyên nhân r13; nghiệm thu hợp đồng 0/96.
- **Full/gate (fp mã `38c4852b68bd8fc04646f543bc6ad46fcc327550510ea0112f50453ab333a19b`):** full pytest **6855 passed, 103 warnings in 3124.71s (0:52:04)**, EXIT 0, 0 failed / 0 skipped (`gate/full_chot_f1.txt`, DB mới
  `samsam_itacc_r13fix4_full1`, dừng nếu dựng DB/preflight lỗi); ruff EXIT 0; eval `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0;
  red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret `gate/secret_scan.txt`.
- **Giới hạn:** "khác thiết bị" offsite không đo được trên máy dev; tệp model OCR có mặt nhưng HỎNG nội dung vẫn làm PaddleOCR
  chết tiến trình (không tải/không mạng — ngoài phạm vi 4 lỗi, ghi lại); `--upgrade` ở giai đoạn có người duyệt chưa có đường
  cho người (fail-closed). KHÔNG phải tích hợp thật/nghiệm thu hợp đồng.

## 0-r13. Checkpoint r13 (LỊCH SỬ — 4 lỗi F1–F4 đính chính ở mục 0) — 12 mục DOCX còn BỊ CHẶN: làm PHẦN CODE CÓ THỂ LÀM (24/10/2026)

- **Phạm vi:** đúng 12 mục BỊ CHẶN + 5 mục ảnh hưởng trực tiếp qua mã dùng chung. Baseline `main` `1ad90df` (snapshot
  `D:\code\samsam_r13_baseline`), nhánh `codex/remaining-docx-12`, CHƯA commit. Không DB `samsam`. Container
  `samsam-itacc-r13` (127.0.0.1:55453). Bảng việc trước khi code: `evidence/itacc_r13_docx12/BANG_VIEC.md`.
- **Ba lớp tách riêng:** A. CODE (đã triển khai + kiểm môi trường thử); B. TÍCH HỢP THẬT (chưa kiểm — không key/vendor/
  sandbox/model thật nào được dùng); C. NGHIỆM THU (nội bộ dưới đây; hợp đồng vẫn 0/96, không đổi `acceptance_status`).
  MOCK = biên được giả (HTTP/model) — không chứng minh dịch vụ/dữ liệu/server thật.

| ID | Code trước | Code sau (r13) | Probe trước → sau (PASS/FAIL) | Mức | Ca P/F/N | Trạng thái nội bộ | Còn chặn bởi |
|---|---|---|---|---|---|---|---|
| production-03 | ảnh nhãn: OCR registry chỉ `none` (exit 2) | OCR tại chỗ `paddle_local` dùng chung doc_intake | a_ocr 2/8 → 10/0 | LOCAL | 10/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| data_platform-02.1 | scan → `cho_ocr` (provider none) | `paddle_local` + reprocess + `ocr_engine`, OCR rỗng không im lặng | a_ocr 2/8 → 10/0 | LOCAL | 12/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| farming-01 | STT registry `none` | `whisper_local` (faster-whisper cục bộ, PyAV, trần, timeout) | b_stt 1/7 → 8/0 | MOCK | 28/0/3 | **BỊ CHẶN** | EXTERNAL_INPUT |
| marketing-02.1 | nền ảnh `none` (gradient) | `openrouter_images` qua cổng llm_gateway | c_image_v2 10/3 → 13/0 | MOCK | 9/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| production-02 | `--check` chỉ số đếm | nêu đích danh SKU thiếu; bắt buộc phiên bản + sha tệp; hồ sơ mẫu không tính | d_dossier 1/4 → 5/0 | LOCAL | 11/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| data_platform-06 | không xử lý 429/5xx, không cổng tính năng | thử lại giới hạn + Retry-After; cổng data_platform-06 trước request | e_market_v2 2/3 → 5/0 | MOCK | 7/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| intel-05.1 | chỉ kiểm ≥3 model | lượt thật đòi ≥3 nhà cung cấp, chặn trước lời gọi | f_persona 3/1 → 4/0 | LOCAL | 7/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| farming-06 | biên nhận chỉ so tiền tố; không upgrade | phân tích cây .ots; submit bỏ phản hồi sai; `--upgrade` → `da_nang_cap` | g_anchor 0/5 → 5/0 | MOCK | 21/0/1 | **BỊ CHẶN** | EXTERNAL_INPUT |
| sales-08 | feed không có verify | `--verify` feed (sha + giá web đã duyệt + mô tả) | h_feed 1/3 → 4/0 | LOCAL | 7/0/1 | **BỊ CHẶN** | SEPARATE_REPO |
| sales-09 | không kênh chat website (repo riêng) | không đổi (không có hợp đồng giao tiếp) | — | LOCAL | 2/0/1 | **BỊ CHẶN** | SEPARATE_REPO |
| ceo-90 | gói kiểm N22 làm tay | `scripts/incident_compare.py` chỉ đọc, từ chối DB samsam | i_incident 0/5 → 5/0 | LOCAL | 7/0/1 | **BỊ CHẶN** | NON_SOFTWARE |
| data_platform-90 | không đo máy chủ; mã hóa/offsite tùy chọn | `scripts/onprem_preflight.py`; bắt buộc mã hóa; offsite khác thiết bị | j_onprem 0/4 → 4/0 | LOCAL | 5/0/1 | **BỊ CHẶN** | NON_SOFTWARE |

- **Ảnh hưởng trực tiếp (chạy lại toàn bộ ca, tiêu chí khóa):** sales-03 ĐẠT 12/0/0, farming-02.1 ĐẠT 11/0/0, farming-02.2 ĐẠT 10/0/0, data_platform-02.2 ĐẠT 11/0/0, data_platform-07.2 ĐẠT 10/0/0.
- **Tiêu chí:** `criteria/r13_v1.json` (17 mục, 188 ca, khóa sha trước khi chạy; nháp 4 agent chỉ-đọc, điều phối viên rà
  + khóa) + `criteria/r13_v2.json` (2 mục — lỗi TIÊU CHÍ/FIXTURE ở lô lo1: regex trước bản vá cls; giá fixture vi phạm luật
  golden R1; lượt v1 giữ ở `luot_bi_thay_the`). Tiêu chí khóa ở fp mã `2be3eb72…`; sau khóa chỉ đổi chuỗi `blocker`
  trong `data/contract_features.json` (văn bản) và — sau full #1 (`gate/full_chot_f1.txt`: 6 failed, 6810 passed, 103 warnings in 3759.53s (1:02:39), EXIT 1; 6 fail
  đều do thay đổi r13: drift-guard DDL schema, luồng egress mới chưa khai `data/data_flow_map.json`, chuỗi blocker
  data_platform-06 phải mở đầu 'BLOCKED') — DDL `anchor_receipts` chuyển sang lệnh tường minh tên cố định + allowlist
  drift-guard, khai DF-48 + sinh lại DPIA/TIA, sửa chuỗi blocker → fp mã cuối `1975775dab1b…`. Chạy lại TRÊN fp cuối: 17 mục
  (lô `lo3`, cùng tiêu chí — lo1/lo2 ghi `luot_bi_thay_the`), 10 probe (`probes/*_sau_fp2`), nâng cấp schema
  (`runs/upgrade_up4.txt`), full #2.
- **Nâng cấp schema/roles** (`documents.ocr_engine`, ràng buộc `anchor_receipts` `da_nang_cap`, `svc_job` INSERT
  anchor_receipts) từ baseline có dữ liệu ×2: 12/12 PASS trên schema cuối (`runs/upgrade_up4.txt`; `upgrade_up3.txt` trên
  DDL khối DO trước đó cũng PASS; v1/v2 hỏng harness giữ).
- **Tổng nội bộ (code sinh `tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN (r12-fix: 84/0/12). Nguồn: r10 29, r11 4, r12 42, r12fix 4, r13 17; 5216
  tham chiếu evidence khớp file/hash, 0 vi phạm nhất quán. BỊ CHẶN: EXTERNAL_INPUT 8, NON_SOFTWARE 2, SEPARATE_REPO 2 — 4 mục
  MISSING_ADAPTER cũ nay EXTERNAL_INPUT (adapter đã có, chờ quyết định vendor/model/DPA/dữ liệu). Không mục nào được gỡ
  chặn vì có adapter hoặc mock pass.
- **Full/gate (fp mã `1975775dab1bdca0e76e43f8458ca0c31847406dc3fd057119b272ffa187db0a`):** full pytest **6816 passed, 103 warnings in 3185.96s (0:53:05)**, EXIT 0 (`gate/full_chot_f2.txt`, DB mới, script dừng khi dựng DB/preflight lỗi, che DSN + libpq password=); ruff (`--exclude .agents --exclude founder`) EXIT 0; eval tất định --no-record `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0; red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret `giá trị bí mật kiểm: 68 · tệp quét: 4127 · tệp khớp GIÁ TRỊ THẬT: 0` EXIT 0.
- **Chờ bên ngoài:** bảng đầy đủ `docs/handover/dau-vao-va-quyet-dinh.md` mục G (ai → cần gì → ảnh hưởng → cấu hình → bằng
  chứng → lệnh kiểm). Chưa làm vì thiếu đặc tả chính thức: refresh token + quyết toán Shopee/TikTok.
- **Giới hạn:** OCR tại chỗ là lựa chọn kỹ thuật THỬ (chữ Việt mất dấu thanh một phần, trường tên SP không trích được);
  STT không chạy thật (không có model, không tự tải); ảnh AI/anchor/API sàn chỉ MOCK; preflight chỉ có giá trị trên
  server Bên B. KHÔNG phải nghiệm thu hợp đồng.

## 0a. Checkpoint r12-fix (LỊCH SỬ) — vá ĐÚNG hai lỗi controller bác ở r12: D2, L3 (24/10/2026)

- **Kết luận r12 "20/20 FIXED" là kết luận LỊCH SỬ** — controller bác cho D2 (SĐT dạng ngoặc lọt guardrail đăng bài) và L3
  (nhánh quá 30 giây vẫn hứa "nhân viên sẽ phản hồi" trước khi có bằng chứng đã ghi handoff). Lượt này chỉ vá hai lỗi đó;
  18 lỗi còn lại giữ kết luận r12. Evidence controller lưu tại `evidence/itacc_r12_fix_d2_l3/controller/` (SHA256SUMS).
- **Vá D2** (`pipelines/pii.py`, `pipelines/guardrail.py`): tách bước phẳng hóa ngoặc của `_mask_pii` thành
  `_flatten_paren` (cùng luật chống nối khoảng giá, ngân sách tuyến tính; đầu ra `_mask_pii` không đổi — test đông cứng
  giá trị baseline); luật 8 `pii_ca_nhan` quét thêm bản phẳng, cạn ngân sách (đuôi ngoặc không kiểm hết) → chặn
  (fail-closed); khóa so `pii_allow` chuẩn hóa đầu 84 → 0. Giữ: pii_allow, hotline, giá, ngày, mã SP; `check()` chat và
  `internal_note` giữ phạm vi. **Luật D2 vẫn CHỜ PHÁP CHẾ xác nhận phạm vi** — không coi là Pháp chế đã duyệt.
- **Vá L3** (`connectors/zalo.py`): quá 30 giây → gửi NGAY câu hotline không hứa (`NO_HANDOFF_TEXT`), rồi ghi `cskh_handoff`
  lý do `deadline` đúng 1 lần SAU khi gửi (DB lỗi/rollout chặn → `record_handoff` trả None, không crash); ngân sách 30 s +
  phần dự trữ gửi giữ nguyên, không đưa việc DB chậm lên trước khi gửi. Messenger đi chung `zalo._reply_turn`. Các template
  khác (NO_DATA, gateway chặn, sức khỏe, rượu, chạy thử) giữ hành vi r12 (ghi trước rồi mới chọn câu).
- **Probe trước/sau** (cùng mã, input, assertion, đồng hồ điều khiển; baseline = snapshot working tree r12
  `D:\code\samsam_itacc_r12fix_baseline`, fp code 57538e8935d0…, KHÔNG phải bản trước r12):

| Probe | sha256 | Baseline | Bản sửa |
|---|---|---|---|
| D2 (SĐT ngoặc ×4 kênh, bệnh lý, đối chứng giữ/chặn, phạm vi) | `6f94fdb285c0700a…` | 16 PASS / 4 FAIL · exit 1 · fp code 57538e8935d0… (`probes/d2_truoc/`) | 20 PASS / 0 FAIL · exit 0 · fp code 8f9188ade140… (`probes/d2_sau/`) |
| L3 (quá hạn Zalo/Messenger × DB down/lỗi/rollout/ghi được + đối chứng) | `ececd01c08221ddd…` | 11 PASS / 9 FAIL · exit 1 · fp code 57538e8935d0… (`probes/l3_truoc/`) | 20 PASS / 0 FAIL · exit 0 · fp code 8f9188ade140… (`probes/l3_sau/`) |

  Baseline FAIL đúng lỗi nghiệp vụ: D2 `chan_ngoac_vung, chan_ngoac_84, chan_ngoac_ba_nhom, chan_ngoac_benh_ly_nhanh` (ok=True, không mã); L3 mọi ca quá hạn gửi câu
  hứa nhân viên (`hua: true`) — không lỗi thư viện/DB/cấu hình. Test hồi quy bền: `tests/test_r12fix_d2_l3.py`; 2 test hạn
  chót cũ (`tests/test_v13_c07_ops.py`) đổi kỳ vọng HANDOFF_TEXT → NO_HANDOFF_TEXT, giữ assertion handoff/convlog/kết quả muộn.
- **Kiểm lại 5 mục** (tiêu chí MỚI `criteria/r12fix_v1.json` khóa sha `559aa67d5715…` TRƯỚC
  khi chạy; chép nguyên ca r12 + ca mới; tiêu chí/evidence r12 giữ nguyên — sha evidence r12 trước/sau lượt khớp). Chỉ một
  kỳ vọng cũ đổi: sales-01 C07 `sent_last_is_handoff_text=true` (chính là hành vi L3 bị bác) → không hứa + hotline + handoff
  đúng 1 mục + transport giả không provenance live (siết, không nới). Container mới `samsam-itacc-r12fix` (127.0.0.1:55452),
  DB mới mỗi mục.

| Mục | Mức | Lý do kiểm lại | Ca P/F/N | Kết quả | Bản ghi |
|---|---|---|---|---|---|
| legal_hr-01 | MOCK | D2 — sửa luật pii_ca_nhan ở pipelines/guardrail.py (entry point của mục) + pipelines/pii.py | 6/0/0 | **ĐẠT** | `items/legal_hr-01.json` (thay `evidence/itacc_r12/items/legal_hr-01.json`) |
| marketing-01.1 | MOCK | D2 — nháp bài/ngày đi qua check_publish_llm → check_publish (luật 8 đổi) | 9/0/0 | **ĐẠT** | `items/marketing-01.1.json` (thay `evidence/itacc_r12/items/marketing-01.1.json`) |
| sales-01 | MOCK | L3 — sửa nhánh quá 30 giây ở connectors/zalo.py (Zalo + Messenger dùng chung _reply_turn) | 21/0/0 | **ĐẠT** | `items/sales-01.json` (thay `evidence/itacc_r12/items/sales-01.json`) |
| sales-03 | LOCAL | D2 — nháp listing đi qua check_publish (luật 8 đổi) | 12/0/0 | **ĐẠT** | `items/sales-03.json` (thay `evidence/itacc_r12/items/sales-03.json`) |
| sales-07.1 | MOCK | D2 — kịch bản livestream đi qua check_publish (luật 8 đổi); câu có chữ số bị kd_live bỏ TRƯỚC guardrail (content._spec_like) nên không thêm ca SĐT ngoặc — chỉ kiểm hồi quy | 8/0/0 | **ĐẠT** | `items/sales-07.1.json` (thay `evidence/itacc_r12/items/sales-07.1.json`) |

  Lô `runs/batch/lo1` (marketing-01.1 dựng DB lỗi: 3 `apply_schema --roles` song song trên cluster mới tranh `create role` —
  lỗi môi trường harness, không ca nào chạy, giữ log) → chạy lại tuần tự `lo2`. Mức: LOCAL/MOCK như r12; KHÔNG chạy lại UI
  (app không đổi) — ca UI02 của sales-01 kế thừa lượt UI thật r12. Mục khác: kế thừa nguồn hiện hành r12 (không chạy lại).
- **Tổng hiện hành (code sinh `evidence/itacc_r12_fix_d2_l3/tong_hop.json`):** 84 ĐẠT /
  0 CHƯA KIỂM / 12 BỊ CHẶN trên 96 (r12: 84/
  0/12 — tổng không đổi; khác ở chỗ legal_hr-01 và
  sales-01 nay ĐẠT theo tiêu chí phủ đúng D2/L3). Nguồn: r10 44, r11 4, r12 43, r12fix 5;
  4516 tham chiếu evidence khớp file/hash, 0 vi phạm nhất quán. 12 BỊ CHẶN
  ngoài code giữ nguyên: EXTERNAL_INPUT 4, MISSING_ADAPTER 4, NON_SOFTWARE 2, SEPARATE_REPO 2.
- **Full/gate trên mã cuối** (fp code `8f9188ade140c8aea64162400a772ae3f41c2780f788edb40fc9b254ae82aed3`, fp đầy đủ lúc full `6ba43cc44a995b3f…`): full pytest DB mới
  `samsam_itacc_r12fix_full1` — **6773 passed in 6570.33s (1:49:30)**, EXIT 0 — 0 failed, 0 skipped; gồm 3 ca DR Docker (`tests/test_dr_drill.py`) chạy thật, không skip (`gate/full_chot_f1.txt`; script mới dừng khi dựng
  DB/preflight lỗi, exit truyền qua ống log, che URL DSN + libpq `password=`); ruff (phạm vi gate r12, loại `.agents`/`founder`)
  EXIT 0 (`gate/ruff_v2.txt`; lượt `gate/ruff.txt` không exclude EXIT 1 — 115 lỗi đều trong `.agents/` của user, giữ); eval tất định --no-record
  `[done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=bc378178b239 model=rules judge=None` EXIT 0; DPIA --check EXIT 0; red-team `tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0)` EXIT 0; quét secret `giá trị bí mật kiểm: 20 · tệp quét: 10414 · tệp khớp GIÁ TRỊ THẬT: 0` EXIT 0.
- **Kiểm tài liệu sau cập nhật** (`gate/doc_tests_sau_ho_so.txt`, 17 tệp test, DB full1 đã dùng): 741 passed, 1 failed, EXIT 1 — `test_v15_fix_p102::test_p102_authorized_person_completes[anchor-submit-by-person]` lỗi `[err] DB không kết nối được` ở tiến trình con (module anchor không đổi lượt này, ca này PASS trong full); chạy lại 3 lần × 7 ca đều PASS (`gate/doc_tests_chay_lai_p102.txt`) → ghi là lỗi kết nối chập chờn khi máy tải nặng, không phải lỗi D2/L3.
- **Giới hạn:** LOCAL/MOCK trên máy dev, fixture giả, AI/transport giả ở biên; không chạy UI lượt này; không gửi tin thật,
  không provider, không lịch. Đây là **nghiệm thu kỹ thuật nội bộ, KHÔNG phải nghiệm thu hợp đồng**; không đổi
  `acceptance_status` (vẫn 0/96). CHƯA commit/merge/push/deploy.

## 0b. Checkpoint r12 (LỊCH SỬ) — vá 20 lỗi r10, kiểm lại 48 mục (24/10/2026)

> r12-fix: các verdict "FIXED"/"20/20 FIXED" dưới đây giữ nguyên văn làm lịch sử; controller BÁC kết luận đó cho D2 và L3 — trạng thái hiện hành của hai lỗi ở mục 0.

- **Tổng hiện hành (sinh bằng code `evidence/itacc_r12/tong_hop.json`):** 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN trên 96 — trước r12 (checkpoint r11): 60/0/36. Nguồn: r10 44, r11 4, r12 48 bản ghi; kiểm nhất quán 0 vi phạm, 4497 tham chiếu evidence khớp file/hash. BỊ CHẶN còn lại đều NGOÀI code: EXTERNAL_INPUT 4, MISSING_ADAPTER 4, NON_SOFTWARE 2, SEPARATE_REPO 2.
- **Mã kiểm:** nhánh `codex/safety-acceptance`, HEAD `16b33fc9b4f0e0ff45dbeab78972100909ec0340`, CHƯA commit. Baseline `97051e55c1191625638de98047c896b6b2bc893e63e90e6695915b580c388001`. Bản cuối: fingerprint MÃ (loại *.md) `57538e8935d0ab71e7b1cd8d803aab397be27cd1ab47516b75a1d437c7435c18` (`harness/fp_code_r12.sh.txt`; giữ nguyên từ lô kiểm 48 mục tới full chốt); fingerprint đầy đủ lúc full chốt `116fc4a9b4a9010664ee2dcee2d4d09ad96feabebe3e7e1704bd2a5f3a9f9838` (`harness/fp_r12.sh.txt`, cùng phương pháp baseline + 3 test mới).
- **Môi trường:** container Docker `samsam-itacc-r12` (`postgres:17-alpine`, chỉ `127.0.0.1:55451`, credential mới ở scratchpad — không vào repo/argv/log); mỗi probe/mục 1 DB mới `samsam_itacc_r12_*` (schema/roles ×2 + core + golden, `harness/mkdb_r12.sh.txt`); KHÔNG dùng DB `samsam`; AI giả ở biên `llm_gateway._client` (đếm lời gọi), mạng ngoài localhost bị chặn.
- **Sự cố hạ tầng (ghi `runs/su_co_snapshot_baseline.md`):** máy khởi động lại → Docker Desktop không lên (socket cũ, đổi tên thư mục `run`, không reset), snapshot baseline trong Temp bị dọn một phần → dựng lại, fingerprint khớp `97051e55…`.

**Probe trước/sau (cùng input/assertion; tiêu chí đóng viết trước khi vá)**

| Nhóm | Baseline (snapshot trước vá) | Bản cuối | Ghi chú |
|---|---|---|---|
| Đợt 1 — P-01, UI-01, UI-02, G5-01, G5-02 | 11 PASS / 11 FAIL (`probes/dot1_truoc/20261023T161724-41d8`, probe dd1fc1291647…) | 22 PASS / 0 FAIL / 0 lỗi harness (`probes/dot1_cuoi_ngay/20261024T114505-7bbe`, probe 485834cb0f23…) | bản cuối dùng probe sửa NGÀY fixture (mk_probe_ngay_v.py.txt) — lượt `dot*_cuoi` 24/10 FAIL đối chứng dương do ngày cố định 23/10, giữ nguyên |
| Đợt 2 — D1/P052/L5, G1-L1, RB, GATE-OUT, L3 | 6 PASS / 25 FAIL (`probes/dot2_truoc/20261023T163151-a0f9`, probe 574199acda30…) | 31 PASS / 0 FAIL / 0 lỗi harness (`probes/dot2_cuoi_ngay/20261024T114544-995e`, probe 3f121cbb6b8a…) | bản cuối dùng probe sửa NGÀY fixture (mk_probe_ngay_v.py.txt) — lượt `dot*_cuoi` 24/10 FAIL đối chứng dương do ngày cố định 23/10, giữ nguyên |
| Đợt 3 — L2 (+RB kd_quote), L1, F06-6, F031-6, G1-L3, G1-L4 | 1 PASS / 16 FAIL (`probes/dot3_truoc/20261023T174125-e4b2`, probe 71ac09e16596…) | 17 PASS / 0 FAIL / 0 lỗi harness (`probes/dot3_cuoi_ngay/20261024T114801-8c38`, probe 4dce4f17ccf2…) | bản cuối dùng probe sửa NGÀY fixture (mk_probe_ngay_v.py.txt) — lượt `dot*_cuoi` 24/10 FAIL đối chứng dương do ngày cố định 23/10, giữ nguyên · đợt 3 v2 bỏ assertion định dạng `[rollout]` cho hdtv (không thuộc RB, giao diện v14.3 `[blocked]`) |
| Đợt 4 — G1-L5, G1-L6, D4, D2 | 4 PASS / 4 FAIL (`probes/dot4_truoc/20261024T080601-0a77`, probe 1194cb81ae62…) | 8 PASS / 0 FAIL / 0 lỗi harness (`probes/dot4_cuoi/20261024T114154-8e05`, probe 1194cb81ae62…) |  |

**Bảng 20 lỗi — verdict trên bản cuối**

| Mã | Mức | Vá | Kiểm trên bản cuối | Verdict |
|---|---|---|---|---|
| P-01 | CAO | `pipelines/production.py`: biến vòng lặp không đè dict tồn kho (`run_stock`) | đợt 1 · production-01/04.3 ĐẠT | **FIXED** |
| UI-01 | TB | svc_ui SELECT cột plots/plot_logs; ghi nhật ký qua `plot_log_add_human` bằng login người khối farming | đợt 1 · UI 28/28 · farming-01 ca chạy được PASS | **FIXED** |
| UI-02 | TB | svc_ui SELECT chunks (KB công khai); lỗi chat → câu thân thiện, không traceback | đợt 1 · UI 28/28 · sales-01 ĐẠT | **FIXED** |
| G5-01 | TB | `auth.ACTIONS` thêm `media_cap`/`media_thu_hoi` | đợt 1 · farming-04 ĐẠT | **FIXED** |
| G1-L1 | TB | mỗi đầu ra của lệnh nhiều đầu ra kiểm cổng RIÊNG (ceo_audit, intel_weekly, intel_bulletin, production bulletin) | đợt 2 · ceo-04.3/04.4, intel-01.1/01.2/03/04.1, production-01/04.3 ĐẠT | **FIXED** |
| G1-L3 | TB | HĐTV: phạm vi chi 0 dòng nguồn → `[chưa có dữ liệu]` (`fp_opscost.summary` co_nguon) | đợt 3 · ceo-05 ĐẠT | **FIXED** |
| D1/P052/L5 | TB | cổng tắt sớm ở caller + cổng rollout trong `llm_gateway._gate_feature` (0 lời gọi AI) | đợt 2 · marketing-02.2/07.2, production-05.2, sales-07.1 ĐẠT | **FIXED** |
| L3 | TB | chỉ hứa 'nhân viên sẽ phản hồi' khi ĐÃ ghi được cskh_handoff; không → câu hotline; record_handoff bắt RolloutBlocked | đợt 2 · sales-01 ĐẠT (tiêu chí v2 C12/X1) | **FIXED** |
| L1 | TB | bộ đếm sales-04.2 chỉ tính crm_handoff có `pii_included=true`; quyết định tiêu chí v3 (chuyển yêu cầu không PII ≠ bàn giao PII) | đợt 3 · sales-04.2 ĐẠT (tiêu chí v3) | **FIXED** |
| L2 | TB | kd_quote/kd_catalog: giá = price_list ĐÃ duyệt hiệu lực ngày lập (`approved_golden`); catalog loại readiness CAM (view DB); cổng sales-05 trước khi ghi file | đợt 3 · sales-05 ĐẠT | **FIXED** |
| F06-6 | THẤP–TB | `rev_share --record` sha = byte tệp đã ghi (có nhãn) | đợt 3 · finance-06 ĐẠT | **FIXED** |
| D2 | THẤP–TB | guardrail đăng bài luật `pii_ca_nhan` (critical/block, CHỜ PHÁP CHẾ DUYỆT — mặc định an toàn), trừ pii_allow + hotline | đợt 4 · legal_hr-01 ĐẠT | **FIXED** |
| RB | THẤP | CLI bị cổng tắt: exit 2 + `[rollout] … <mã>`, không traceback, chặn trước side effect (da_pmo, ceo_audit, ceo_risk, intel_bulletin, mkt_director, seo_web, pc_hr, mkt_ads, content --listing, kd_quote, kd_forecast, vt_thuhoach, fp_pnl, sx_tracuu) | đợt 2/3 · các mục ảnh hưởng ĐẠT | **FIXED** |
| G1-L4 | THẤP | `write_report(..., feature=)` — ceo-<kỳ>.md (ceo-01), hdtv-<kỳ>.md (ceo-05) qua cổng/nhãn/report_outputs | đợt 3 · ceo-01/05 ĐẠT | **FIXED** |
| F031-6 | THẤP | bản tin công nợ có cột 0-30; cột tuổi = tuổi phần quá hạn, cộng khớp | đợt 3 · finance-03.1 ĐẠT | **FIXED** |
| G1-L5 | THẤP | `ceo_decisions --list` in chờ quyết/chờ ký | đợt 4 · ceo-02.2 ĐẠT | **FIXED** |
| G1-L6 | THẤP | combo_price xét readiness qua `sku_readiness` (không v_promotable) → nhánh thieu_du_lieu tới được | đợt 4 · intel-05.2 ĐẠT | **FIXED** |
| D4 | THẤP | xnqc --draft --submit lặp → [skip] + mục cũ, không lỗi DB | đợt 4 · legal_hr-02 ĐẠT | **FIXED** |
| G5-02 | THẤP | qr_trace link/unlink qua `auth.cli_gate` farming; function dùng `human_actor` | đợt 1 · farming-03.1 ĐẠT | **FIXED** |
| GATE-OUT | THẤP | tắt → không in nội dung nghiệp vụ ra stdout (fp_cash, sx_tracuu 05.1, production bulletin) | đợt 2 · finance-05.2, production-05.1 ĐẠT | **FIXED** |

- 20/20 FIXED trên bản cuối (probe + flow nghiệm thu của mục). D2 FIXED với mặc định an toàn — phạm vi luật `pii_ca_nhan` chờ Pháp chế xác nhận (mục 9). L1: bộ đếm + quyết định tiêu chí sales-04.2 v3 (mục 9).
- **Hai test fail của full sơ bộ** (`gate/full_so_bo_fs1.txt` — 6664 passed, 2 failed, EXIT 1, GIỮ làm lượt fail thăm dò): (1) `test_qr_trace::test_link_ok_and_refusals` khóa thông báo cũ 'thiếu tên' — sau G5-02 tên rỗng vẫn bị chặn nhưng qua `human_actor` (42501 'người thực hiện không hợp lệ'); test cập nhật + THÊM ca âm tên rỗng/agent:/system: cho cả link và unlink, 0 dòng mang tên agent/system; (2) `test_v14_p3_rollout_edges::test_hdtv_off_no_pack` khóa giao diện v14.3 `[blocked]` stderr — bản r12 đã đổi hdtv_report sang `[rollout]` stdout (ngoài phạm vi RB) → TRẢ VỀ giao diện đã cam kết; test giữ nguyên mọi assertion (exit 2, 0 file, 0 audit_runs, 0 approval_queue).

**Kiểm lại 48 mục** (`tap_muc_kiem_lai.json`: 24 CODE_FAIL + 24 ảnh hưởng trực tiếp — module của mục đổi ở r12)

- Tiêu chí thực thi, khóa sha256 TRƯỚC khi chạy (`criteria/r12_*.json` + `.lock.txt`; quy tắc `criteria/HUONG_DAN.md`); mỗi ca cũ ↔ đúng 1 ca r12 (`nguon_r10`), ca mới `MOI`; runner `harness/runner_r12.py.txt` từ chối hash ≠ khóa / DB ≠ DB của mục; log gốc mở 'x' dưới `runs/<id>/<run_id>/`. Lô: `runs/batch/lo3_thu`, `lo3`, `lo4` (lô `lo1`, `lo2_thu` HỎNG HARNESS — bash WSL, giữ).
- Phiên bản tiêu chí mới (khóa TRƯỚC khi chạy bản đó, giữ bản cũ + kỳ vọng cũ trong bản ghi): `r12_ceo_v2` (X05 hdtv: thông báo chặn stdout|stderr), `r12_sales_a_v2` (C12/X1 theo tiêu chí đóng L3), `r12_sales_a_v3` (sales-04.2 — mục 9), `r12_sales_a_v4` (C07: đo câu khách nhận ở biên send_text — lỗi harness), `r12_prod_legal_v2` (06.2-C1 regex PII bắt nhầm nhãn 'Mã ứng viên'), `r12_farming_v2/v3` (glob `*` ở thư mục; CRLF). Script sinh: `harness/mk_*_v*.py.txt` (docstring = lý do).
- Kết quả: 47 ĐẠT, farming-01 BỊ CHẶN (MISSING_ADAPTER — STT; mọi ca chạy được PASS, C11 không dựng được do farming-01 `mot_phan`). 4 mục chạy lại vì lỗi harness/tiêu chí (sales-01, legal_hr-06.2, farming-03.2, farming-04) — lượt cũ ghi ở `luot_bi_thay_the` của bản ghi. Bản ghi `items/<id>.json`: supersedes đúng nguồn hiện hành r11 (path + sha256).

**UI thật** (Streamlit 1.66.1 venv ngoài repo, AUTH_MODE=local, login UI = `svc_ui` thật, quyết định/ghi bằng login Postgres riêng không owner, Chromium Playwright, DB thử mới): lượt hoàn chỉnh `ui/ui_sau_full_v3_20261024T110553` 28 PASS / 0 FAIL / 0 NOT_RUN (fingerprint đầy đủ lúc chạy 3fda9aa9…, mã runtime không đổi tới bản cuối). Ánh xạ 26 bước r10 → r12: `ui/anh_xa_buoc_r10_r12.json` (26/26 PASS + 2 bước mới UI01_login_nguoi_khac_bi_chan, UI02_loi_doc_kb_khong_lo_traceback; 3 bước vườn r10 đổi tên theo giao diện mới). Baseline UI tái hiện lỗi: `ui/ui_truoc_20261024T081507` (UI-01 'Lỗi đọc DB', UI-02 traceback/InsufficientPrivilege). Lượt hỏng harness giữ: `ui_sau_full_*_HONG_HARNESS_*` (DB timeout khi quá tải; expander bấm lúc rerun; logout trùng).

**Kỳ trước (lịch sử — giữ nguyên văn)**

### 0. Checkpoint r11 — kiểm lại 6 mục bằng evidence gốc mới (23/10/2026)

- **Vì sao:** controller chưa chấp nhận chốt r10 vì (a) 5 mục marketing dựa trên 20 file log bị ca legal_hr trùng mã ghi đè rồi TÁI TẠO từ transcript; (b) legal_hr-07 được chấm PASS "theo ý định" dù ca đã khóa yêu cầu 2 dòng `intel_items` (thực tế 1).
- **Tiêu chí khóa TRƯỚC khi chạy:** `evidence/itacc_r11/criteria/r11.json` sha256 `601f16a149d825ea76f94ccc3a805cad5f8ac23f10f1aaa3f96eb2a3f7c6cd34` (2026-10-23T14:25:52+07:00); `r11_v2_marketing-03.2.json` sha256 `5dad880992c025b0a5529427e6a373ce17936401a720eead0c6a4c604fe65a87` (2026-10-23T14:38:13+07:00). Tiêu chí khóa r10 (`criteria/g3.json`, sha256 `4de39b8b…581e`) GIỮ NGUYÊN.
- **Môi trường:** Postgres Docker riêng `samsam-itacc-r11` (`postgres:17-alpine`, chỉ `127.0.0.1:55441`, credential mới không lưu repo); mỗi mục 1 DB mới `samsam_itacc_r11_*` (schema/roles ×2 + core + golden — log `runs/_dung_db/`); mạng ngoài localhost bị chặn trong harness; RSS giả `127.0.0.1:18793`; không LLM/provider thật.
- **Evidence gốc:** runner `harness/runner.py.txt` — mỗi lần chạy 1 thư mục `runs/<id>/<run_id>/<id>__Cn/`, stdout/stderr gốc + `stepNN.cmd.json` (argv, giờ VN, exit lấy từ tiến trình, sha256), assertion SQL/file máy kiểm `asserts.json`; file mở chế độ không ghi đè; bộ lọc secret tự động (mật khẩu DSN, muối, khóa vault) — không sửa nội dung nghiệp vụ.

| ID | Trạng thái r11 | Mức | Ca PASS/FAIL/NOT_RUN | Lần chạy hiện hành | Thay bản ghi r10 |
|---|---|---|---|---|---|
| marketing-03.2 | **ĐẠT** | LOCAL | 10/0/0 | `runs/marketing-03.2/20261023T143832-6f49` | `evidence/itacc_r10/items/marketing-03.2.json` (sha256 `b6ba9e0865f1…`) |
| marketing-05.1 | **ĐẠT** | LOCAL | 6/0/0 | `runs/marketing-05.1/20261023T143116-fa63` | `evidence/itacc_r10/items/marketing-05.1.json` (sha256 `dabf12075add…`) |
| marketing-05.2 | **ĐẠT** | LOCAL | 8/0/0 | `runs/marketing-05.2/20261023T143241-897d` | `evidence/itacc_r10/items/marketing-05.2.json` (sha256 `11c26e2d7fe7…`) |
| marketing-06.1 | **ĐẠT** | LOCAL | 4/0/0 | `runs/marketing-06.1/20261023T143332-24ae` | `evidence/itacc_r10/items/marketing-06.1.json` (sha256 `370bfb591549…`) |
| marketing-06.2 | **ĐẠT** | LOCAL | 6/0/0 | `runs/marketing-06.2/20261023T143654-f67e` | `evidence/itacc_r10/items/marketing-06.2.json` (sha256 `383540029c9d…`) |
| legal_hr-07 | **ĐẠT** | MOCK | 6/0/0 | `runs/legal_hr-07/20261023T144012-9ab4` | `evidence/itacc_r10/items/legal_hr-07.json` (sha256 `2fca6cfdc223…`) |

- **Đính chính legal_hr-07 (lỗi KỲ VỌNG của harness, không phải evidence cũ đã đạt ca khóa):** `crawler/intel.py` `build_items()` loại tin 0 chủ đề TRƯỚC khi lưu (`off += 1; continue`). Fixture `rss_it.xml` = 1 tin nghị định quảng cáo TPBVSK + 1 tin không liên quan ⇒ kỳ vọng đúng: CHÍNH XÁC 1 dòng `intel_items` (đúng url/nguồn/tiêu đề/chủ đề tpbvsk), 0 dòng tin lạc, stdout `2 tin, 1 đúng chủ đề, mới 1` + `off_topic=1`. Chạy lại đủ flow: thu RSS → cảnh báo (`legal_doc`, exit 1 fail-closed thiếu người nhận, 0 lần gửi) → `legal_doc_review` pending payload template (link, sha256 tiêu đề, "KHÔNG diễn giải") → chạy lại 0 mục mới → tắt `legal_hr-07`: tin mới chỉ có luật `regulation`, `legal_updates` báo tắt, 0 mục mới; `llm_usage` 0 dòng; log http.server chỉ 127.0.0.1.
- **Đính chính marketing-06.2-C3:** r10 khóa `--ref 2026-10-19` (tuần HIỆN TẠI, chưa đóng → sản phẩm từ chối đúng). r11 khóa tuần đã đóng gần nhất giờ VN 2026-10-12; assertion so 5 chỉ số nội bộ với đếm SQL ĐỘC LẬP cùng khung giờ VN, không median/p90 khi 0 quyết định, chạy lại `inserted=0` (C3b). Giới hạn khóa trước: DB mới, không lùi timestamp → số của kỳ đóng đều 0.
- **Lỗi harness lượt r11 (đã thay thế):** marketing-03.2 lượt `runs/marketing-03.2/20261023T143204-6665` (tiêu chí v1) — fixture kết quả còn `bien_the=4` (id creative DB r10) trong khi creative phiếu r11 là #1 → sản phẩm từ chối ĐÚNG, C1/C3/C4 FAIL do fixture. Mở tiêu chí v2 chỉ đổi fixture `*_r11.csv` (4→1), expected giữ nguyên, chạy lại toàn bộ trên DB mới `…m032b` → 10/10 PASS. Lượt hỏng giữ nguyên, không tính.
- **Khác tiêu chí r10 (ghi ở `khac_r10` từng ca):** 03.2-C2 dùng chính phiếu #1 trước khi duyệt (r10 dùng phiếu --propose); bổ sung 05.2-C4b (có đồng ý → 1 `ugc_reuse`), 05.2-C4c (lớp nhạy cảm → UGC_SENSITIVE), 06.2-C3b (insert-only); 05.2-C5 đặt DB host chết để chứng minh thoát trước kết nối.
- **Evidence r10 yếu GIỮ NGUYÊN làm lịch sử:** `evidence/itacc_r10/g3/out/` (log tái tạo có header), `g3/harness_fixes.tsv`, 6 bản ghi `evidence/itacc_r10/items/`, `evidence/itacc_r10/tong_hop.json` (checkpoint r10). Nguồn hiện hành từng id: `evidence/itacc_r11/source_map.json`; tổng hợp hiện hành: `evidence/itacc_r11/tong_hop.json`.
- **Kế thừa r10 (KHÔNG chạy lại ở r11):** 90 mục còn lại; full pytest 6619/0/0, UI thật 22/2/2, ruff/eval/DPIA/red-team/DR — chạy ở r10 trên CÙNG fingerprint mã `97051e55…8001` (xác minh lại ở r11: không đổi). Lượt r11 không chạy full pytest (chỉ chạy harness + cập nhật evidence/tài liệu).
- **Tổng hiện hành (sinh bằng code):** 60 ĐẠT / 0 CHƯA KIỂM / 36 BỊ CHẶN trên 96 — checkpoint r10: 60/0/36. Kiểm nhất quán: 0 vi phạm, 2159 tham chiếu evidence khớp file/hash.

## 1. Baseline và môi trường

- r12: như mục 0. Biến môi trường mỗi lệnh: `DATABASE_URL` tường minh tới DB thử, xóa PG*/…DATABASE_URL khác, `OPENROUTER_API_KEY` rỗng, `DEPLOY`/`AUTH_MODE`/`RED_ALERT_NOTIFY` tắt trừ phép thử chế độ thực; `tests/_db_guard.py` không bị tắt.
- r10/r11 (lịch sử): container `samsam-itacc-r10`/`r11`, fingerprint `97051e55…8001`.

## 2. Phương pháp

- Như r10/r11 (tiêu chí khóa trước, entry point thật, assertion máy kiểm, evidence gốc không ghi đè) + r12: probe trước/sau cho từng nhóm lỗi, tiêu chí kiểm lại 48 mục thực thi được, phiên bản tiêu chí mới khi phát hiện lỗi harness/tiêu chí (không sửa tệp đã khóa), tổng hợp 96 bằng code (`harness/aggregate_r12.py.txt`).
- Phân loại: ĐẠT = mọi ca bắt buộc PASS; CHƯA KIỂM = có NOT_RUN/lỗi harness; BỊ CHẶN = lỗi sản phẩm đã xác minh hoặc lý do ngoài code (giữ nguyên dù ca chạy được PASS). FIXTURE (golden giả, ép van_hanh, lùi ngày hiệu lực giá bằng tắt trigger trong DB thử, setval sequence) chỉ dựng tình huống — không là bằng chứng quyền/append-only/ngày chạy thử hợp đồng.

## 3. Kết quả tổng HIỆN HÀNH (r15) — mẫu số 96 (89 tính năng AI + 7 hạng mục)

| Nhóm | Số mục |
|---|---|
| ĐẠT | 84 |
| CHƯA KIỂM | 0 |
| BỊ CHẶN | 12 |
| **Tổng** | **96** |

**Theo khối**

| Khối | ĐẠT | CHƯA KIỂM | BỊ CHẶN | Tổng |
|---|---|---|---|---|
| ceo | 9 | 0 | 1 | 10 |
| sales | 11 | 0 | 2 | 13 |
| marketing | 13 | 0 | 1 | 14 |
| intel | 10 | 0 | 1 | 11 |
| finance | 10 | 0 | 0 | 10 |
| production | 4 | 0 | 2 | 6 |
| farming | 8 | 0 | 2 | 10 |
| legal_hr | 10 | 0 | 0 | 10 |
| data_platform | 9 | 0 | 3 | 12 |

**Theo phạm vi**

| Phạm vi | ĐẠT | CHƯA KIỂM | BỊ CHẶN | Tổng |
|---|---|---|---|---|
| AI P1 | 73 | 0 | 7 | 80 |
| AI P2 | 9 | 0 | 0 | 9 |
| 7 hạng mục khác | 2 | 0 | 5 | 7 |

## 4. Bảng 96 mục

Mức: LOCAL = entry point thật + DB thử; MOCK = fake ở biên (AI/transport). Lượt = nguồn bản ghi hiện hành (`evidence/itacc_r15_remaining/source_map.json`; r15/r14fix2/r14 = kiểm lại lượt r15/vá/r14, r13fix4/r13 = lượt trước, còn lại kế thừa). Chi tiết: bản ghi theo đường dẫn trong source_map.

| ID | Khối | GĐ | Tên | Lượt | Trạng thái | Mức | Ca P/F/N | Nguyên nhân / ghi chú |
|---|---|---|---|---|---|---|---|---|
| ceo-01 | ceo | P1 | Báo cáo tuần tự động | r12 | **ĐẠT** | LOCAL | 13/0/0 |  |
| ceo-02.1 | ceo | P1 | Theo dõi tiến độ (sổ mốc) | r12 | **ĐẠT** | LOCAL | 12/0/0 |  |
| ceo-02.2 | ceo | P1 | Sổ quyết định TGĐ | r12 | **ĐẠT** | LOCAL | 12/0/0 |  |
| ceo-03 | ceo | P1 | Sổ rủi ro pháp lý | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| ceo-04.3 | ceo | P1 | So bài đăng/listing đang chạy với bản đã duyệt | r12 | **ĐẠT** | LOCAL | 7/0/0 |  |
| ceo-04.4 | ceo | P1 | So giá (và mô tả) listing đang chạy với bản đã duyệt | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| ceo-04.5 | ceo | P1 | So voucher/khuyến mãi đang chạy với bản đã duyệt | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| ceo-04.6 | ceo | P1 | Báo khi nhật ký bị sửa + đối soát độc lập BKS | r10 | **ĐẠT** | LOCAL | 8/0/0 |  |
| ceo-05 | ceo | P2 | Báo cáo HĐTV | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| sales-01 | sales | P1 | Chatbot chăm sóc khách (Zalo, Messenger) | r12fix | **ĐẠT** | MOCK | 21/0/0 |  |
| sales-09 | sales | P1 | Chatbot trên website | r13 | **BỊ CHẶN** | LOCAL | 2/0/1 | SEPARATE_REPO |
| sales-02 | sales | P1 | Gợi ý trả lời chat sàn | r12 | **ĐẠT** | MOCK | 10/0/0 |  |
| sales-03 | sales | P1 | Listing đa sàn | r13 | **ĐẠT** | LOCAL | 12/0/0 |  |
| sales-04.1 | sales | P1 | Người phụ trách khách trong ngày | r10 | **ĐẠT** | LOCAL | 6/0/0 |  |
| sales-04.2 | sales | P1 | Chuyển khách về đại lý gần nhất | r12 | **ĐẠT** | LOCAL | 12/0/0 |  |
| sales-05 | sales | P1 | Báo giá B2B quà Tết | r12 | **ĐẠT** | LOCAL | 16/0/0 |  |
| sales-06.1 | sales | P1 | Giám sát giá và phá giá | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| sales-06.2 | sales | P1 | Cảnh báo đơn trễ, hủy, hoàn bất thường | r10 | **ĐẠT** | LOCAL | 6/0/0 |  |
| sales-07.1 | sales | P1 | Kịch bản và giỏ hàng livestream | r12fix | **ĐẠT** | MOCK | 8/0/0 |  |
| sales-07.2 | sales | P1 | Sau bán: xin đánh giá | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| sales-07.3 | sales | P1 | Kịch bản bán mùa 11.11, 12.12, Tết | r12 | **ĐẠT** | LOCAL | 7/0/0 |  |
| marketing-01.1 | marketing | P1 | Soạn 3 bài mỗi ngày | r12fix | **ĐẠT** | MOCK | 9/0/0 |  |
| marketing-01.2 | marketing | P1 | Lịch mùa vụ (brief chiến dịch) | r12 | **ĐẠT** | LOCAL | 6/0/0 |  |
| marketing-02.1 | marketing | P1 | Ảnh bối cảnh AI quanh ảnh sản phẩm thật | r13fix4 | **BỊ CHẶN** | MOCK | 11/0/0 | EXTERNAL_INPUT |
| marketing-02.2 | marketing | P1 | Video 15–45 giây từ tư liệu thật | r12 | **ĐẠT** | MOCK | 6/0/0 |  |
| marketing-03.1 | marketing | P1 | Đề xuất quảng cáo thử nghiệm | r12 | **ĐẠT** | LOCAL | 10/0/0 |  |
| marketing-03.2 | marketing | P1 | Theo dõi chi phí mỗi đơn, đề xuất giữ hay tắt | r12 | **ĐẠT** | LOCAL | 11/0/0 |  |
| marketing-04.1 | marketing | P1 | Bộ tài liệu chuẩn cho KOC/đại lý affiliate | r10 | **ĐẠT** | LOCAL | 6/0/0 |  |
| marketing-04.2 | marketing | P1 | Kiểm tra bài đăng của đối tác | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| marketing-05.1 | marketing | P1 | Phân loại bình luận | r11 | **ĐẠT** | LOCAL | 6/0/0 |  |
| marketing-05.2 | marketing | P1 | Soạn nháp trả lời bình luận, đánh giá | r11 | **ĐẠT** | LOCAL | 8/0/0 |  |
| marketing-06.1 | marketing | P1 | Chuẩn hóa trang sản phẩm trên web | r12 | **ĐẠT** | LOCAL | 4/0/0 |  |
| marketing-06.2 | marketing | P1 | Báo cáo kênh | r11 | **ĐẠT** | LOCAL | 6/0/0 |  |
| marketing-07.1 | marketing | P2 | SEO sàn | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| marketing-07.2 | marketing | P2 | YouTube dài | r12 | **ĐẠT** | MOCK | 7/0/0 |  |
| intel-01.1 | intel | P1 | Bản tin thị trường 7h | r12 | **ĐẠT** | LOCAL | 9/0/0 |  |
| intel-01.2 | intel | P1 | Gợi ý chủ đề cho Marketing | r12 | **ĐẠT** | LOCAL | 5/0/0 |  |
| intel-02.1 | intel | P1 | Báo động sâm giả, mạo danh Ngọc Linh | r10 | **ĐẠT** | MOCK | 8/0/0 |  |
| intel-02.2 | intel | P1 | Báo động quy định mới | r10 | **ĐẠT** | MOCK | 8/0/0 |  |
| intel-02.3 | intel | P1 | Báo động tin xấu về Sâm Sâm | r10 | **ĐẠT** | MOCK | 8/0/0 |  |
| intel-03 | intel | P1 | Theo dõi đối thủ | r12 | **ĐẠT** | LOCAL | 7/0/0 |  |
| intel-04.1 | intel | P1 | Xu hướng Google Trends theo tuần | r12 | **ĐẠT** | LOCAL | 7/0/0 |  |
| intel-04.2 | intel | P1 | Gợi ý từ khóa an toàn pháp lý | r12 | **ĐẠT** | LOCAL | 6/0/0 |  |
| intel-05.1 | intel | P1 | Thử thông điệp trên khách hàng giả lập | r13 | **BỊ CHẶN** | LOCAL | 7/0/0 | EXTERNAL_INPUT |
| intel-05.2 | intel | P1 | Thử giá combo | r12 | **ĐẠT** | LOCAL | 7/0/0 |  |
| intel-06 | intel | P1 | Kịch bản mùa | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| finance-01 | finance | P1 | Đối soát tiền sàn | r10 | **ĐẠT** | LOCAL | 8/0/0 |  |
| finance-02 | finance | P1 | Hóa đơn điện tử | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| finance-03.1 | finance | P1 | Bảng tuổi nợ đại lý | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| finance-03.2 | finance | P1 | Hoa hồng affiliate | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| finance-03.3 | finance | P1 | Nháp thư nhắc nợ | r12 | **ĐẠT** | LOCAL | 6/0/0 |  |
| finance-04.1 | finance | P1 | Biên lợi nhuận từng sản phẩm, từng kênh | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| finance-04.2 | finance | P1 | Chặn khuyến mãi bị lỗ | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| finance-05.1 | finance | P1 | So chi phí AI, quảng cáo với ngân sách | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| finance-05.2 | finance | P1 | Dự báo dòng tiền 13 tuần | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| production-01 | production | P1 | Báo cáo sản xuất | r12 | **ĐẠT** | LOCAL | 12/0/0 |  |
| production-02 | production | P1 | Hồ sơ sản phẩm | r13 | **BỊ CHẶN** | LOCAL | 11/0/0 | EXTERNAL_INPUT |
| production-03 | production | P1 | Đối soát nhãn | r14 | **BỊ CHẶN** | LOCAL | 12/0/0 | EXTERNAL_INPUT |
| production-04.3 | production | P1 | Hồ sơ lô, cảnh báo cận hạn | r12 | **ĐẠT** | LOCAL | 13/0/0 |  |
| production-05.1 | production | P2 | Tra cứu tài liệu R&D | r12 | **ĐẠT** | MOCK | 7/0/0 |  |
| production-05.2 | production | P2 | Tóm tắt tài liệu R&D | r12 | **ĐẠT** | MOCK | 8/0/0 |  |
| farming-01 | farming | P1 | Nhật ký vườn qua Zalo | r15 | **BỊ CHẶN** | MOCK | 28/0/3 | EXTERNAL_INPUT |
| farming-02.1 | farming | P1 | Nhắc người phụ trách khoảnh | r13 | **ĐẠT** | LOCAL | 11/0/0 |  |
| farming-02.2 | farming | P1 | Báo giám đốc khi vẫn bỏ trống | r13 | **ĐẠT** | LOCAL | 10/0/0 |  |
| farming-03.1 | farming | P1 | Nối lô thu hoạch với lô sản xuất | r12 | **ĐẠT** | LOCAL | 20/0/0 |  |
| farming-03.2 | farming | P1 | Trang và tem QR cho khách quét | r12 | **ĐẠT** | LOCAL | 17/0/0 |  |
| farming-04 | farming | P1 | Kho tư liệu vườn | r12 | **ĐẠT** | LOCAL | 16/0/0 |  |
| farming-05.3 | farming | P2 | Cảnh báo thời tiết | r10 | **ĐẠT** | LOCAL | 4/0/0 |  |
| farming-05.4 | farming | P2 | Cảnh báo sâu bệnh | r10 | **ĐẠT** | LOCAL | 8/0/0 |  |
| farming-05.2 | farming | P2 | Dự báo sản lượng thu hoạch | r12 | **ĐẠT** | LOCAL | 9/0/0 |  |
| legal_hr-01 | legal_hr | P1 | Kiểm duyệt nội dung tự động | r12fix | **ĐẠT** | MOCK | 6/0/0 |  |
| legal_hr-02 | legal_hr | P1 | Hồ sơ xác nhận quảng cáo | r12 | **ĐẠT** | LOCAL | 5/0/0 |  |
| legal_hr-03.2 | legal_hr | P1 | Xếp mức được phép quảng bá | r12 | **ĐẠT** | LOCAL | 8/0/0 |  |
| legal_hr-04 | legal_hr | P1 | Quét kênh, gỡ bài | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| legal_hr-05.1 | legal_hr | P1 | Hợp đồng mẫu KOC, đại lý | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| legal_hr-05.2 | legal_hr | P1 | Mẫu xin đồng ý của khách | r10 | **ĐẠT** | LOCAL | 6/0/0 |  |
| legal_hr-06.1 | legal_hr | P1 | Mô tả công việc | r12 | **ĐẠT** | LOCAL | 5/0/0 |  |
| legal_hr-06.2 | legal_hr | P1 | Sàng lọc hồ sơ | r12 | **ĐẠT** | LOCAL | 6/0/0 |  |
| legal_hr-06.3 | legal_hr | P1 | Chấm công | r12 | **ĐẠT** | LOCAL | 5/0/0 |  |
| legal_hr-07 | legal_hr | P2 | Cập nhật văn bản pháp luật mới | r11 | **ĐẠT** | MOCK | 6/0/0 |  |
| data_platform-01 | data_platform | P1 | Kho dữ liệu chung | r10 | **ĐẠT** | LOCAL | 11/0/0 |  |
| data_platform-02.1 | data_platform | P1 | Đọc chữ tự động từ giấy tờ | r14 | **BỊ CHẶN** | LOCAL | 14/0/0 | EXTERNAL_INPUT |
| data_platform-02.2 | data_platform | P1 | Lưu bản gốc kèm mã kiểm tra | r13 | **ĐẠT** | LOCAL | 11/0/0 |  |
| data_platform-03 | data_platform | P1 | Kho tri thức cho chatbot | r10 | **ĐẠT** | MOCK | 7/0/0 |  |
| data_platform-04 | data_platform | P1 | Cổng AI an toàn | r10 | **ĐẠT** | MOCK | 1/0/0 |  |
| data_platform-05 | data_platform | P1 | Kết nối dữ liệu sàn (nhập file) | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| data_platform-07.1 | data_platform | P1 | Giám sát lỗi | r10 | **ĐẠT** | LOCAL | 5/0/0 |  |
| data_platform-07.2 | data_platform | P1 | Backup hằng ngày | r13fix4 | **ĐẠT** | LOCAL | 12/0/0 |  |
| data_platform-07.3 | data_platform | P1 | Kiểm thử trước khi đưa thay đổi lên | r10 | **ĐẠT** | LOCAL | 7/0/0 |  |
| sales-08 | sales | P1 | Website bán hàng | r13 | **BỊ CHẶN** | LOCAL | 7/0/1 | SEPARATE_REPO |
| data_platform-06 | data_platform | P2 | Kết nối API sàn chỉ đọc | r15 | **BỊ CHẶN** | MOCK | 9/0/0 | EXTERNAL_INPUT |
| farming-06 | farming | P2 | Neo mã xác thực lên blockchain | r14fix2 | **BỊ CHẶN** | MOCK | 27/0/1 | EXTERNAL_INPUT |
| finance-06 | finance | P1 | Doanh thu thuần trực tuyến + biên bản đối soát quý | r12 | **ĐẠT** | LOCAL | 12/0/0 |  |
| data_platform-08 | data_platform | P1 | Sổ triển khai 3 bước + hồ sơ nghiệm thu + báo cáo vận hành tháng | r10 | **ĐẠT** | LOCAL | 10/0/0 |  |
| ceo-90 | ceo | P1 | Nghĩa vụ hợp đồng ngoài phần mềm | r13 | **BỊ CHẶN** | LOCAL | 7/0/1 | NON_SOFTWARE |
| data_platform-90 | data_platform | P1 | Hạ tầng độc lập trên server Bên B | r13fix4 | **BỊ CHẶN** | LOCAL | 9/0/1 | NON_SOFTWARE |

## 5. Lỗi sản phẩm r10 — trạng thái r12

Xem bảng 20 lỗi ở mục 0 (20/20 FIXED trên bản cuối). Không phát hiện lỗi sản phẩm mới trong phạm vi khi kiểm lại 48 mục; các FAIL trong lô đều là lỗi harness/tiêu chí (mục 0). Quan sát ngoài danh sách 20 lỗi của r10 KHÔNG xử lý ở r12 (giữ ghi nhận r10).

## 6. Kiểm xuyên suốt r12 (bản cuối)

| Phép kiểm | Kết quả | Evidence |
|---|---|---|
| probe S04 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 17 PASS / 0 FAIL | `xuyen_suot/probe_s04_cuoi.txt` |
| probe S04B (hồi quy danh tính/quyền/giá/chat sàn/feed) | 17 PASS / 0 FAIL | `xuyen_suot/probe_s04b_cuoi.txt` |
| probe R8 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 13 PASS / 0 FAIL | `xuyen_suot/probe_r8_cuoi.txt` |
| probe B3 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 7 PASS / 0 FAIL | `xuyen_suot/probe_b3_cuoi.txt` |
| probe S03 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 14 PASS / 0 FAIL | `xuyen_suot/probe_s03_cuoi.txt` |
| probe F1 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 28 PASS / 0 FAIL | `xuyen_suot/probe_f1_cuoi.txt` |
| probe F2 (hồi quy danh tính/quyền/giá/chat sàn/feed) | 12 PASS / 0 FAIL | `xuyen_suot/probe_f2_cuoi.txt` |
| Nâng cấp schema/roles baseline → bản vá ×2 (dữ liệu, đuôi hash chain, quyền thêm đúng tập r12 / không bớt, SECURITY DEFINER + search_path + không PUBLIC EXECUTE, hành vi login thật) | UPGRADE OK — schema/roles không đổi sau lần kiểm (mtime 23/10 16:11 < 24/10 08:09) | `runs/upgrade_up1.txt` |

## 7. Gate chốt r12 (bản cuối)

- Full pytest (DB mới `samsam_itacc_r12_fchot`, gồm DR Docker): **6666 passed, 0 failed, 0 skipped in 2994.46s (0:49:54)**, EXIT 0 — `gate/full_chot_fchot.txt`.
- Ruff: EXIT 0 — `gate/ruff.txt`.
- Agent eval tất định --no-record: [done] guardrail v2 PASS 130/132 pass_rate=0.9848 (ngưỡng 0.95) prompt_version=aecc24c91beb model=rules judge=None · EXIT 0 — `gate/eval.txt`.
- DPIA --check: EXIT 0 — `gate/dpia.txt`.
- Red-team: tỷ lệ lọt: 0/50 = 0.0% (known-gap 0, lọt chưa xử lý 0) · EXIT 0 — `gate/redteam.txt`.
- Quét secret evidence/repo thay đổi: giá trị bí mật kiểm: 303 · tệp quét: 11082 · tệp khớp GIÁ TRỊ THẬT: 0 · EXIT 0 — `gate/secret_scan.txt`.
- Lượt fail/hỏng giữ nguyên: `gate/full_so_bo_fs1.txt` (2 failed, EXIT 1), `gate/probe_cuoi.txt` (đối chứng dương lệch ngày).

## 8. Phụ thuộc ngoài máy / đầu vào cần để kiểm tiếp (r10, cập nhật r12)

> r12: dòng 'Sửa 20 lỗi sản phẩm' ĐÃ XỬ LÝ (mục 0). Các dòng còn lại giữ nguyên.

| Cần | Ai | Gỡ cho |
|---|---|---|
| Chọn vendor + đặc tả API + DPA + credential cho OCR / STT / ảnh AI; dev viết adapter + contract test + sandbox | QL AI + Pháp chế; dev | production-03, data_platform-02.1, farming-01, marketing-02.1 |
| App key/sandbox Shopee/TikTok; chọn chuỗi/provider/phí neo blockchain | Bên B; hai bên | data_platform-06, farming-06 |
| 14 hồ sơ sản phẩm gốc; DPIA ký + nhà cung cấp LLM cho persona giả lập | GĐ sản xuất; Pháp chế | production-02, intel-05.1 |
| Repo + owner website/chatbot website | Bên B / owner | sales-08, sales-09 |
| Server Bên B, UPS/offsite/máy giám sát ngoài, xác nhận nghĩa vụ hợp đồng | Bên B; hai bên | data_platform-90, ceo-90, và mọi kiểm trên môi trường thật |
| Người duyệt/login thật, người nhận cảnh báo + SMTP, dữ liệu vận hành thật | TGĐ/Pháp chế Bên B | chạy thử/nghiệm thu hợp đồng (ma trận riêng) |

## 9. Điểm cần người xác nhận (r12)

- **sales-04.2 (tiêu chí v3):** chuyển YÊU CẦU không kèm dữ liệu cá nhân khi chưa đồng ý `dai_ly` là thiết kế có căn cứ (playbook bán hàng, SOP 5c, runbook 9.7, test nghiệm thu `test_handoff_acceptance_1`) — CHỈ bàn giao SĐT/tên/email/địa chỉ khi có đồng ý đích danh; chỉ lần bàn giao có đồng ý được tính đầu ra. Nếu Bên B/Pháp chế muốn CHẶN HẲN chuyển yêu cầu khi chưa đồng ý thì sửa nhất quán CLI + `crm_handoff_human` (đổi nghiệp vụ, không phải lỗi r12). Căn cứ: `evidence/itacc_r12/harness/mk_sales_a_v3.py.txt`.
- **D2:** luật `pii_ca_nhan` chặn SĐT/email cá nhân trong nội dung công khai — mặc định an toàn, `trang_thai: chờ Pháp chế duyệt`. r12-fix: phủ thêm SĐT dạng ngoặc (cùng chuẩn hóa `pipelines.pii`) — phạm vi luật VẪN chờ Pháp chế.
- **L3 (r12-fix):** quá 30 giây → câu hotline không hứa + mục handoff ghi sau khi gửi (khách không nhận lời hẹn nhân viên ở nhánh này dù mục ghi được) — nếu Bên B muốn câu hứa khi đã ghi được thì cần đổi thứ tự (ghi trước, ăn vào ngân sách gửi) — quyết định nghiệp vụ.
- **L3:** khi chatbot TẮT, khách nhận câu hotline (không hứa người phản hồi, không tạo mục — HĐ 6.7 cấm sinh đầu ra của tính năng tắt). Nếu muốn vẫn chuyển người khi tắt thì cần quyết định cho phép mục handoff ngoài cổng giai đoạn.
- Các điểm r10 còn lại (intel-06, marketing-01.1) giữ ghi nhận r10.

## 10. Giới hạn và tài nguyên (r12)

- r12-fix: container `samsam-itacc-r12fix` + DB `samsam_itacc_r12fix_*`, scratchpad r12fix, snapshot `D:\code\samsam_itacc_r12fix_baseline` — dọn khi kết thúc lượt (ghi ở DONE.md).

- Một máy dev; DB thử chế độ dev cho phần lớn ca, danh tính chế độ thực kiểm bằng probe + UI + ca login thật trong tiêu chí.
- MOCK: chất lượng AI/embedding thật chưa kiểm; mapping/biểu phí/ngưỡng GIẢ ĐỊNH — ĐẠT chỉ là đạt kỹ thuật trên fixture.
- Tiêu chí 48 mục do 8 agent viết từ ca r10/r11 (điều phối viên duyệt + khóa); 4 phiên bản sửa lỗi harness/tiêu chí ghi lý do; ca phụ thuộc ngày (ceo-01 C07 trước 26/10, marketing_b start 26/10, probe theo ngày chạy).
- Tài nguyên lượt: container `samsam-itacc-r12` + DB `samsam_itacc_r12_*`, login thử `r12*`, scratchpad r12 — dọn khi kết thúc.
