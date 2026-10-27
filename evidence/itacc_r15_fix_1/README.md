# Evidence r15-fix1 (26/10/2026) — vá 3 lỗi tiền F1/F2/F3 của r15 (quyết toán API sàn ↔ CSV)

CHƯA commit/merge/push/deploy. Không kết nối DB `samsam`, không gọi API sàn thật. Evidence/manifest `itacc_r15_remaining/` giữ nguyên.

## Provenance
- Nhánh `codex/remaining-docx-code-r15`, HEAD = main = `70ff9f74c3328cf4ecfd7f173d6a0a6a666f6046`, index thật trống.
- fp mã TRƯỚC (r15 chưa vá): `70f54e56b1451a0a010328abca139c8c58f0414a88ab62a773a852415a66c5eb` — khớp trên cây làm việc VÀ snapshot
  ngoài repo `D:\code\samsam_itacc_r15fix1_baseline` (17.082 tệp: tệp tracked + 3 tệp mới r15 + evidence r15; SHA256SUMS ở
  `SNAPSHOT_baseline_r15_chua_va_SHA256SUMS.txt`, bản sao trong snapshot `SHA256SUMS.snapshot.txt` + `FINGERPRINT.txt`).
- fp mã SAU (bản vá): `b30e0aa2d6d11ba5875fff01b947f35a0ee7e87822ebea0f282d65e50670a5ff`.
- fp mã CHỐT (lượt gate, sau sửa câu thông báo — xem mục Gate): `f8033335a4fab10159b4891f3c41634f1dcb306d09e04347c13be8f90fc995e2`
  (fp full `2ff5ce619a5965e27796e24ab3202a0f3281beb8781ec26e9c7abeb2b5e42c99`).
- Cách tính: `bash harness/fp.sh.txt <TREE> code harness/new_files.txt` = `itacc_r15_remaining/harness/fp_r15.sh.txt` chỉ đổi biến SP;
  danh sách tệp mới KHÔNG đổi (bản vá không thêm tệp mã).
- Postgres: container riêng `samsam-itacc-r15fix1` (postgres:17-alpine, label `samsam.itacc=r15fix1`, 127.0.0.1:55461), mật khẩu admin
  sinh vào tệp ngoài repo; mỗi lượt probe một DB mới `samsam_itacc_r15fix1_*`.

## Probe hồi quy (`harness/probe_f123.py.txt`, sha256 a4e9f90ade0be129aaf7b63cd2ab2b3252e4871eea010612d789ce59cb806d14)
`python -I probe_f123.py.txt <TREE> <out.json> <db>` — parser thật, CSV qua `settlement_csv.main()`, API qua `settlement_api._write()`,
login thành viên `svc_loader` (không superuser/owner), dữ liệu giả. Race: barrier chỉ ở ĐẦU; sau SELECT thật của `cross_source`
mỗi bên chờ bên kia ≤4 s (timeout = tiếp tục) → có khóa thì bên sau đang chờ khóa (pg_locks advisory chưa granted), không deadlock giả.
Cùng một tệp probe chạy trên snapshot (trước) và cây vá (sau): **trước 15 PASS / 23 FAIL → sau 38 PASS / 0 FAIL**
(`probes/probe_truoc.*`, `probes/probe_sau.*`).

| Nhóm | Ca | Kỳ vọng đúng | Trước | Sau |
|---|---|---|---|---|
| F2 | control_valid | đủ trường hợp lệ → ghi 1 dòng | PASS | PASS |
| F2 | explicit_zero_int | số 0 tường minh (int) hợp lệ → ghi | PASS | PASS |
| F2 | explicit_zero_str | số 0 tường minh ("0") hợp lệ → ghi | PASS | PASS |
| F2 | payout_missing | escrow_amount→payout missing → chặn, 0 dòng | FAIL | PASS |
| F2 | payout_null | escrow_amount→payout null → chặn, 0 dòng | FAIL | PASS |
| F2 | payout_garbage | escrow_amount→payout garbage → chặn, 0 dòng | FAIL | PASS |
| F2 | payout_empty_str | escrow_amount→payout empty_str → chặn, 0 dòng | FAIL | PASS |
| F2 | payout_bool | escrow_amount→payout bool → chặn, 0 dòng | FAIL | PASS |
| F2 | payout_fraction | escrow_amount→payout fraction → chặn, 0 dòng | PASS | PASS |
| F2 | gross_missing | thiếu order_original_price→order_amount → chặn, 0 dòng | FAIL | PASS |
| F2 | fee_missing | thiếu commission_fee (đã ánh xạ, không có quyết định cho phép vắng) → chặn, 0 dòng | FAIL | PASS |
| F2 | fee_garbage | chuỗi rác ở trường phí đã ánh xạ → chặn | FAIL | PASS |
| F2 | unmapped_rate_fraction | trường KHÔNG phải tiền đã quyết bo_qua (exchange_rate lẻ) không làm hỏng lượt → ghi | FAIL | PASS |
| F2 | batch_one_bad | lô 3 đơn, 1 đơn payout null → 0 dòng của CẢ lượt | FAIL | PASS |
| F2 | tt_control_valid | TikTok đủ trường → ghi | PASS | PASS |
| F2 | tt_explicit_zero | TikTok "0" tường minh → ghi | PASS | PASS |
| F2 | tt_payout_empty_str | TikTok settlement_amount "" → chặn | FAIL | PASS |
| F2 | tt_payout_missing | TikTok thiếu settlement_amount → chặn | FAIL | PASS |
| F2 | tt_payout_null | TikTok settlement_amount null → chặn | FAIL | PASS |
| F2 | tt_payout_garbage | TikTok chuỗi rác → chặn | PASS | PASS |
| F2 | tt_gross_missing | TikTok thiếu subtotal_before_discount_amount → chặn | FAIL | PASS |
| F3 | all_vnd | pri=VND, aff=VND, trường thường → ghi; currency không thành thành phần LẠ | PASS | PASS |
| F3 | pri_usd_aff_vnd | pri=USD, aff=VND, chỉ trường thường (đồng tiền shop affiliate) → ghi (không chặn mù pri≠VND) | PASS | PASS |
| F3 | both_usd | pri=USD, aff=USD (repro controller) → chặn, 0 dòng | FAIL | PASS |
| F3 | aff_usd_regular_mapped | aff=USD + trường thường (affiliate) ánh xạ → chặn | FAIL | PASS |
| F3 | pri_vnd_aff_usd_pri_mapped | pri=VND, aff=USD, chỉ trường *_pri ánh xạ → ghi | PASS | PASS |
| F3 | pri_usd_pri_mapped | pri=USD + trường *_pri ánh xạ → chặn | FAIL | PASS |
| F3 | no_currency_no_decision | không có pri/aff_currency, bảng ánh xạ chưa xác nhận đơn vị shop → chặn | FAIL | PASS |
| F3 | aff_missing_pri_present | có pri_currency nhưng thiếu aff_currency cho trường thường → chặn (không xác định) | FAIL | PASS |
| F3 | currency_null | pri/aff_currency null → chặn | FAIL | PASS |
| F1 | csv_then_api | CSV trước (exit 0) → API sau [blocked] exit 2, 1 dòng | PASS | PASS |
| F1 | api_then_csv | API trước (exit 0) → CSV sau [blocked] exit 2, 1 dòng | PASS | PASS |
| F1 | same_source_api_many | nhiều giao dịch API cùng đơn (2 lượt, 3 txn_type) → nhận đủ 3 dòng | PASS | PASS |
| F1 | same_source_csv_two_files | cùng đơn ở 2 file CSV khác nhau (cùng nguồn) → nhận cả hai (overlaps xử lý) | PASS | PASS |
| F1 | concurrent_csv_api_0 | CSV + API đồng thời, 2 kết nối svc_loader thật → đúng 1 bên ghi (exit 0), bên kia [blocked] exit 2; 1 dòng, view 1 khoản 90.000 | FAIL | PASS |
| F1 | concurrent_csv_api_1 | CSV + API đồng thời, 2 kết nối svc_loader thật → đúng 1 bên ghi (exit 0), bên kia [blocked] exit 2; 1 dòng, view 1 khoản 90.000 | FAIL | PASS |
| F1 | concurrent_csv_api_2 | CSV + API đồng thời, 2 kết nối svc_loader thật → đúng 1 bên ghi (exit 0), bên kia [blocked] exit 2; 1 dòng, view 1 khoản 90.000 | FAIL | PASS |
| F1 | concurrent_same_source_overlapping | 2 lượt API cùng nguồn đồng thời, đơn chồng nhau thứ tự ngược → cả hai exit 0 (không deadlock, không cấm nhầm), 4 dòng | PASS | PASS |

## Nguồn Shopee (F3)
https://open.shopee.com/documents/v2/v2.payment.get_escrow_detail?module=97&type=1 — đọc lại 26/10/2026 qua JSON mô tả tài liệu mà
chính trang tải (trích tối thiểu `probes/shopee_escrow_detail_currency_fields.json`). Trích dẫn:
- `pri_currency`: "The currency of the country or region where the shop that real seller operates. (Only display for cb sip affiliate shop.)"
- `aff_currency`: "The currency of the country or region where shop opened in. (Only display for cb sip affiliate shop.)"
- `exchange_rate`: "Exchange rate from primary shop currency to affiliate shop currency."
- `*_pri` (vd `escrow_amount_pri`, `commission_fee_pri`): "... in the primary currency"; `commission_fee`: "For cb sip affiliate shop:
  commission_fee=commission_fee_pri * exchange_rate" → trường thường = tiền shop affiliate.
- `order_original_price`: "... in the listing currency" — response shop thường KHÔNG có mã tiền → cần quyết định `tien_te_shop`.

## Quyết định thiết kế
- F1: `settlement_csv.lock_orders` — `pg_advisory_xact_lock` khóa 64-bit = sha256("settlement_rows:nguon:<kênh>:<ngăn>")[:8],
  ngăn = int(order_id_hash) mod 256; lấy theo ngăn tăng dần; đòi READ COMMITTED + không autocommit (LockError → exit 1). Câu đầu
  transaction ghi ở CSV `main()` và API `_write()`, trước kiểm file đã nạp → `cross_source` → INSERT; nhánh `[skip]` rollback nhả khóa.
  Không đổi schema/roles.
- F2: `_flatten` giữ giá trị thô; `to_rows` phán theo ánh xạ: thành phần có `cot` mà thiếu/null/("" TikTok) → lỗi, trừ
  `khi_vang: "bang_0"` (cấm cho order_amount/payout, `load_map` kiểm); sai kiểu → lỗi; cột độc = None; `check_rows` trong `_write`
  trước connect. Trường không ánh xạ: chuỗi/null Shopee bỏ qua (không phải tiền), số → LẠ.
- F3: đồng tiền theo trường: `*_pri` ↔ `pri_currency`, thường ↔ `aff_currency` (khi response có mã), không mã ↔ `shopee.tien_te_shop`
  (null|"VND", null ở repo). ≠ "VND" → lỗi; không xác định → chặn. Mã tiền tệ tách khỏi thành phần.

## Gate
- `gate/ruff.txt`: `ruff check . --exclude .agents --exclude founder --exclude output` EXIT 0 (`output/` là thư mục chưa theo dõi
  ngoài phạm vi, có lỗi ruff riêng).
- pytest tập trung (unit DB test riêng `samsam_itacc_r15fix1_unit`): `tests/test_r15_settlement_api.py tests/test_settlement_csv.py
  tests/test_settlement_overlap.py tests/test_market_api.py` → 205 passed (chạy trên console, không lưu log riêng; TRƯỚC khi thêm docstring module r15-fix1 — sau đó chưa chạy lại).
- **Full pytest: CHƯA CÓ KẾT QUẢ** — lần chạy trên fp mã cuối bị dừng vì máy thiếu RAM (`gate/full_bi_dung_thieu_ram.txt`);
  DB `samsam_itacc_r15fix1_full` đã dựng đạt (`runs/`). Chưa chạy lại.

### Lượt gate chốt (26/10/2026)
- Thay đổi mã DUY NHẤT của lượt: câu `[blocked]` F3 trong `ingest/settlement_api.py` `to_rows` — đơn CÓ mã tiền nhưng thiếu/null
  mã của đúng trường giờ ghi "response có mã tiền nhưng thiếu/null mã tiền affiliate|primary" (trước ghi sai "response không có
  mã; tien_te_shop chưa xác nhận"). Hành vi chặn GIỮ NGUYÊN; `test_fix1_f3_currency_per_mapped_field` thêm 1 assert lý do.
  `.gitattributes` thêm `evidence/itacc_r15_fix_1/** -text`.
- fp mã chốt `f8033335a4fab10159b4891f3c41634f1dcb306d09e04347c13be8f90fc995e2` (cùng `harness/fp.sh.txt` + `new_files.txt`, alternate
  index; index thật trống).
- `gate/ruff_chot.txt`: `ruff check . --exclude .agents --exclude founder --exclude output` → EXIT 0 trên fp chốt.
- `gate/pytest_taptrung_chot.txt`: `python -m pytest -q -ra -p no:cacheprovider tests/test_r15_settlement_api.py
  tests/test_settlement_csv.py tests/test_settlement_overlap.py tests/test_market_api.py` → **205 passed, 0 failed, 0 skipped,
  EXIT 0** trên fp chốt. DB test MỚI `samsam_itacc_r15fix1_focus2` (dựng `runs/dung_db_samsam_itacc_r15fix1_focus2.txt`:
  apply_schema --roles ×2 + core_store + golden_store, đều exit 0; preflight đạt) trên container riêng của lượt
  `samsam-itacc-r15fix1-gate` (postgres:17-alpine, label `samsam.itacc=r15fix1gate`, 127.0.0.1:55463 — mật khẩu admin sinh
  vào tệp ngoài repo; harness mkdb/preflight dùng bản sao chỉ đổi cổng 55461 → 55463).
- Lượt đầu: RAM trống 2.943 MB rồi 2.105 MB / 16.221 MB (< ngưỡng ~6 GB lúc đó) → không chạy full.
- **Full pytest (người dùng hạ ngưỡng xuống ≥3 GB, cho stop container cũ `samsam-itacc-r15fix1` — chỉ stop, không rm):**
  `gate/full_chot.txt` (154.429 byte). `harness/run_full.sh.txt` một lần (bản sao chỉ đổi cổng 55461→55463 và thêm 1 dòng in RAM),
  DB test MỚI `samsam_itacc_r15fix1_full2` trên container `samsam-itacc-r15fix1-gate` (dựng `runs/dung_db_samsam_itacc_r15fix1_full2.txt`
  exit 0; preflight OK), fp code trong log `f8033335…95e2`, Docker 28.4.0, RAM trống trước dựng DB 3.354 MB.
  `python -m pytest -q -ra -p no:cacheprovider` bắt đầu 19:59:27, xong 20:46:42 (2827,95 s):
  **73 failed, 6903 passed, 2 skipped, 6 errors — EXIT 1. KHÔNG PASS.**
  - Trong lúc chạy, Claude Code dừng lớp shell bao ngoài vì máy thiếu RAM (RAM trống tụt còn ~1,4–1,7 GB); script harness, nhánh
    `main` và pytest KHÔNG bị dừng và chạy tới hết; dòng `EXIT 1` do `main` ghi ngay sau pytest. Không chạy lại.
  - 66/74 mục lỗi (gồm 6 ERROR `test_v13_c05_media`) có mã tiến trình con 3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED (98 lần
    trong log): tiến trình con (python CLI, worker OCR, ffmpeg) không khởi tạo được — dấu hiệu cạn bộ nhớ/desktop heap Windows,
    KHÔNG phải assert logic. 7 ca `test_video_studio` không mang mã này nhưng hỏng theo chuỗi `make_video` → None/không có file,
    cùng tệp với các ca ffmpeg rc=0xC0000142 — NHIỀU KHẢ NĂNG cùng nguyên nhân, CHƯA xác minh từng ca.
  - 1 ca môi trường khác: `test_data_flow_map::test_every_egress_module_declared` quét thấy
    `output/so-tay-song-khoe-ban-moi/workflow/review/check.py` (thư mục `output/` chưa theo dõi, việc KHÁC, không thuộc r15).
  - 0 ca lỗi thuộc tệp settlement/market_api/r15. 2 skip: `test_safety_s01_rotation` thiếu image `postgres:16-alpine`.
  - Chưa kết luận được gate full; cần chạy lại khi đủ RAM (người giao việc quyết). Không sửa code/test.
