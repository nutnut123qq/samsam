# Board v13 — khép phát hiện audit hợp đồng (C00–C11)

Căn cứ: Hợp đồng hợp tác TEDO–Sâm Sâm 2026 + PL01–04 (bản gốc KHÔNG nằm
trong repo; PL05 chưa được cung cấp). Nhánh `v13-hop-dong`, không merge
`main`, không push/deploy. Hai loại kết quả báo riêng: **CODE VERIFIED**
(code + test/E2E trong repo) ≠ **OPERATIONALLY ACCEPTED** (dữ liệu thật, chạy
thử ≥5 ngày làm việc + ≥50 đầu ra/tính năng, có người duyệt ≥10 ngày, 0 lỗi
nghiêm trọng, biên bản hai bên). Mọi mục dưới đây `acceptance_status =
chua_nghiem_thu` cho tới khi có biên bản — agent không tự đổi.

Lane sau cập nhật đúng dòng của mình (cột Test/Evidence/Blocker/Trạng thái).

| ID | Ver / lane | Điều khoản nguồn | Phát hiện | Phụ thuộc | File boundary | Test | Evidence | Blocker | code_status / acceptance_status |
|---|---|---|---|---|---|---|---|---|---|
| C00 | v13.0 / c00 | HĐ 2.1; PL01 mục 1–4, 6; PL02 mục 1 | F04, F10, F11 (danh mục) | — | `data/contract_features.json`, `pipelines/rollout.py` (reader + `--catalog`), `docs/schema.sql` khối v13.0 c00, `tests/test_rollout.py`, board này | `python -m pytest tests/test_rollout.py` (122 passed) | `evidence/v13_0_c00_pytest.log`, `evidence/v13_0_c00_e2e.log`, DONE.md v13.0 | Hai bên chốt 89 mục + P1 80/P2 9 (đề xuất hiện 79 mục AI: 72 P1/7 P2) | co_code / chua_nghiem_thu |
| C01 | v13.1 / c01 | HĐ 12.1; PL02 mục 2 | F02, F07, probe zero_cap | C00 | `pipelines/pii.py`, `llm_gateway.py`, `guardrail.py`, `api/rag.py`, `data/llm_gateway.json` (`pii_allow` địa chỉ showroom), `data/banned_words.txt`, `data/eval/redteam.jsonl` (gỡ 7 `known_gap` đã chặn), `tests/conftest.py` (gateway giả đọc được chi tiêu 0) | `tests/test_v13_c01_pii_guardrail.py` (72; trên code cũ 54 FAIL) + 36 file liên quan: 1645 passed; `agent_eval --deterministic` PASS; `redteam.py` lọt 20/50 → 13/50, ca 0 violation 18 → 13 (critical 14 → 9) | `evidence/v13_1_c01_pytest.log`, `evidence/v13_1_c01_e2e.log` | Pháp chế chốt bộ ca red-team + 13 known-gap (tiếng Anh, 'UT', sai dấu thanh, rượu/ẩn ý nói vòng) và có bật lớp LLM-check; DPA/TIA nhà cung cấp LLM; che tên không theo mẫu cần NER (chưa có) | co_code / chua_nghiem_thu |
| C02 | v13.2 / c02 | HĐ 3.1, 7.5, 8.1–8.3, 9.3; PL02 mục 4–5 | F01, F09 | C00 | `ingest/settlement_csv.py` (`txn_type`, `overlaps()`), `agents/rev_share.py`, caller `fp_pnl`/`bks_recon`/`fp_cash` (+`hdtv_report` qua fp_pnl), view `v_settlement_khoan` + `v_ben_a_settlement_daily` (khối schema/roles v13.2 c02), `data/rev_share.json` (`ngay_ky_hop_dong`) | `tests/test_settlement_overlap.py` (17, FAIL 15/17 trên code cũ — 2 còn lại là test biên) + 13 file liên quan: 371 passed | `evidence/v13_2_c02_pytest.log`, `evidence/v13_2_c02_e2e.log`, `evidence/v13_2_c02_oldcode_fail.log` | Hai bên chốt: ngày ký thực tế + ngày vận hành (null), tỷ lệ phí/ngưỡng thưởng/cách cộng bậc/cột phí sàn (null/GIẢ ĐỊNH); kế toán xuất 1 file quyết toán thật mỗi sàn để xác minh header + cột loại giao dịch (`txn_type` chưa map) | co_code / chua_nghiem_thu |
| C03 | v13.3 / c03 | HĐ 6.7; PL02 mục 1a–c | F03, F04 (đếm đầu ra) | C00 (`output_sources`) | `pipelines/rollout.py` (`mode()`, `output_facts`, cổng mới), biên: `approval_queue` enqueue/decide/verify (mọi --verify-send/--export/áp dụng), `store` save/approve/schedule, `agents/report.write_report`, `connectors/zalo`+`channels` (chatbot → gợi ý `cskh_reply`), `data/rollout_config.json` (`enforce`), `data/contract_features.json` (sales-01 + `cskh_reply`), `docs/roles.sql` khối v13.3 (agent_writer SELECT `feature_rollout`), `tests/conftest.py` (ép van_hanh cho test cũ) | `tests/test_rollout_enforce.py` (27; trên code cũ 22 FAIL + 5 ERROR) + `test_rollout.py` (128, flip ca evaluate F03) + 67 file liên quan 2953 passed (4 FAIL fake-conn đã vá → chạy lại 194 + 749 passed; 1 FAIL môi trường worktree `.claude/` có sẵn ở code cũ) | `evidence/v13_3_c03_pytest.log`, `evidence/v13_3_c03_e2e.log`, `evidence/v13_3_c03_oldcode_fail.log` | Lịch nghỉ `rollout_config.json` chưa chốt (Hành chính Sâm Sâm); người duyệt được ủy quyền (C04); nguồn report/file/bảng riêng chưa có bộ đếm đầu ra → tính năng đó không nâng được tới khi có bản ghi đầu ra | co_code / chua_nghiem_thu |
| C04 | v13.5 / c04 | HĐ 2.2, 5.4, 7.2–7.3, 12.3, 13.3d; PL01 mục 8; PL04 mục 3 | F08 | C00, C03 | `pipelines/auth.py`, `approval_queue.py`, `store.py`, UI tab duyệt, `docs/roles.sql` | chưa chạy | — | Bên B ủy quyền người duyệt (approvers 9 khối đang rỗng) | chưa làm / chua_nghiem_thu |
| C05 | v13.4 / c05 | PL01 mục 2 (SX, Vùng trồng, Hạ tầng) | F05 (media/OCR/STT/14 hồ sơ) | C01, C03, C04 | `scripts/garden_media.py` (video MP4/MOV remux ffmpeg gỡ metadata/GPS), `connectors/zalo_garden.py` (`user_send_video`, magic bytes ghi âm, registry STT + `--transcribe`), `ingest/doc_intake.py` (OCR none + scan → exit 2 `[blocked]`, provider nước ngoài từ chối ngay), `pipelines/image_studio.py` (`--scene` khi provider none → exit 2), `scripts/retention_purge.py` + `data/retention.json` + `scripts/health_bulletin.py` mục 6, `data/product_dossiers.json`, schema khối v13.4 c05 (CHECK `garden_media.ext` + mp4/mov), `data/data_flow_map.json` DF-42/44 + DPIA/TIA | `tests/test_v13_c05_media.py` (45; trên code cũ 29 FAIL — 16 còn lại là test cấu hình/dữ liệu mới) + 17 file liên quan (18 file): 864 passed, 2 FAIL môi trường worktree có sẵn (`test_garden_director::test_purge_sample_only…` vì đường dẫn worktree chứa `.claude`; `test_lead_store::test_harvest_real_convlog_smoke` thiếu convlog gitignored) — cũng FAIL trên code cũ | `evidence/v13_4_c05_pytest.log`, `evidence/v13_4_c05_oldcode_fail.log`, `evidence/v13_4_c05_e2e.log` (E2E CLI DB lane; OCR/STT chỉ có nhánh blocked + mock — CHƯA verify vendor thật) | Vendor OCR + STT + API sinh ảnh nền (trong nước, hợp đồng/DPA/TIA, key, trần chi phí) — Bên B/Pháp chế chọn; Bên B cấp danh mục 14 hồ sơ gốc; owner + Pháp chế chốt TTL 4 mục `data/retention.json`; host/event video Zalo OA GIẢ ĐỊNH chờ đối chiếu event thật | mot_phan / chua_nghiem_thu |
| C06 | v13.6 / c06 | PL01 mục 2 (Marketing, Tài chính) | F05 (nội dung, công nợ) | C01, C02, C03 | `pipelines/content.py`, `mkt_calendar.py`, `agents/mkt_director.py`, `agents/acc_ar.py` | chưa chạy | — | Sản phẩm/tư liệu hợp lệ để soạn đủ 3 bài | chưa làm / chua_nghiem_thu |
| C07 | v13.7 / c07 | PL01 mục 2, 8; PL02 mục 2–3 | F06 | C01–C04 | `scripts/ops_monthly.py`, `health_bulletin.py`, `pipelines/red_alert.py`, `intel_alert.py`, `job_runs.py`, `db_backup.py`, `deploy/onprem/` | chưa chạy | — | Người nhận cảnh báo đỏ/trực; server + offsite Bên B | chưa làm / chua_nghiem_thu |
| C08 | — (làm riêng) | PL01 mục 3a, 3d; PL03 mục 1 | F10 (website) | C00–C04 | KHÔNG xây ở repo này — chỉ hợp đồng giao tiếp trong danh mục (`sales-08`, `sales-09`) | — | — | Repo/owner website + chatbot web chưa xác định | lam_rieng / chua_nghiem_thu |
| C09 | v13.8 / c09 | PL01 mục 3b, 4, 6 | F10 (P2) | C00, C03, C04, C05 | `pipelines/qr_trace.py` (đọc), module neo tối thiểu, PC-A8 → hàng duyệt Pháp chế, `ingest/market_api.py` (blocker) | chưa chạy | — | Chọn chuỗi/phí blockchain (hai bên); key/sandbox API sàn; domain QR | chưa làm / chua_nghiem_thu |
| C10 | v13.8 / c09 | HĐ 2.4, 4, 6, 9, 13; PL01 mục 7; PL02–04 | F09, F11 | C00 | `data/projects/milestones.json`, `data/tai_san_hop_tac.json`, `docs/handover/so-nghia-vu-hop-dong.md` | chưa chạy | — | PL05; ngày ký, phí/thưởng, lịch hoàn trả, tiêu chuẩn quy đổi | chưa làm / chua_nghiem_thu |
| C11 | tích hợp | toàn bộ | F01–F11 | C00–C10 | merge + review read-only | full gate | — | các blocker trên | chưa làm / chua_nghiem_thu |

## Danh mục yêu cầu (C00) — tóm tắt

Nguồn số: `python -m pipelines.rollout --catalog` (đọc
`data/contract_features.json`, không cần DB). Luật tách nhóm PL01 mục 2 (ĐỀ
XUẤT): chỉ tách khi chữ gốc liệt kê các đầu ra phân biệt; không chia vụn cho
đủ số.

| Khối | HĐ | Đề xuất | Trạng thái |
|---|---|---|---|
| ceo | 9 | 7 | chưa xác định — chờ hai bên chốt |
| sales | 12 | 12 | khớp số lượng — nội dung chờ hai bên chốt |
| marketing | 14 | 11 | chưa xác định — chờ hai bên chốt |
| intel | 11 | 8 | chưa xác định — chờ hai bên chốt |
| finance | 9 | 9 | khớp số lượng — nội dung chờ hai bên chốt |
| production | 6 | 6 | khớp số lượng — nội dung chờ hai bên chốt |
| farming | 9 | 7 | chưa xác định — chờ hai bên chốt |
| legal_hr | 10 | 11 | chưa xác định — chờ hai bên chốt |
| data_platform | 9 | 8 | chưa xác định — chờ hai bên chốt |
| P1 / P2 | 80 / 9 | 72 / 7 | chưa xác định — chờ hai bên chốt |
| Tổng | 89 | 79 | chưa xác định — chờ hai bên chốt |

Ngoài 89: nền tảng TMĐT 2 (`sales-08` website — làm riêng, `data_platform-06`
API sàn), truy xuất blockchain 1 (`farming-06`), nghĩa vụ HĐ 4 (`finance-06`,
`data_platform-08`, `ceo-90`, `data_platform-90`).

Migration ID: 21 nhóm v12 được tách (`<nhóm>.<n>` + `nhom_goc`); dòng
`feature_rollout`/`feature_rollout_events` của id nhóm cũ giữ nguyên; mục
tách vào sổ với mốc mới (không kế thừa ngày), nhóm cũ đang `tat` → mục tách
vào `tat`. `--status` và hồ sơ nghiệm thu liệt kê id nhóm cũ → mục tách.
