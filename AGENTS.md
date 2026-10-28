# samsam — Agent Guide

## Overview
Pilot "chuyển đổi số + AI" cho Công ty TNHH Sâm Sâm (sâm Ngọc Linh, Quảng Nam/Đà Nẵng).
**Căn cứ phạm vi (v12.0): Hợp đồng hợp tác đầu tư TEDO–Sâm Sâm 2026 + PL01–05**
(bản HĐ KHÔNG nằm trong repo — repo public): 89 tính năng / 9 phòng ban
(ceo, sales, marketing, intel, finance, production, farming, legal_hr,
data_platform — trùng `pipelines.director.BLOCKS`); P1 3 tháng 12/10/2026–
11/01/2027, P2 tới hết năm hợp tác thứ 1; hệ thống lõi chạy trên server vật lý
của Sâm Sâm. Loại trừ: cơ khí/chế tạo máy, xúc tiến đầu tư (đã gỡ ở v12.0).
Website bán hàng + chatbot website làm riêng, không ở repo này.
`SOW_SamSam_AI_6-thang.md` chỉ còn là lịch sử, không dùng làm căn cứ.
Luồng: crawl data public → knowledge base
→ chatbot RAG + content studio có guardrail pháp lý TPBVSK. Python 3.12 + Postgres
local (embedding `float8[]`, cosine bằng numpy — chưa cần pgvector) + OpenRouter
(1 key: `openai` client trỏ base_url `https://openrouter.ai/api/v1`, dùng cho cả
chat lẫn embeddings) + Streamlit.

## Commands
| Việc | Lệnh |
|---|---|
| Setup | `pip install -r requirements.txt` |
| Crawl | `python -m crawler.collect` |
| Tin thị trường (v7.0, WP09) | `python -m crawler.intel --run --source <id> [--max-requests N]` (RSS/Atom tầng A/B → `intel_items`; robots + ≥1s/host + chặn cứng tầng C/sàn/MXH; nguồn `data/intel_sources.json` chờ duyệt) · `--report` |
| Đối thủ / Trend / MXH (v7.2, WP09) | `python -m ingest.intel_import --competitor F` · `--trend F [--seed KW]` · `--social F --channel fanpage\|zalo_oa\|tiktok` (file NHẬP TAY, kiểm toàn file trước connect, idempotent sha256; social cần `INTEL_HASH_SALT`) · `python scripts/intel_weekly.py [--week YYYY-MM-DD] [--llm]` (báo cáo tuần tất định, chỉ đọc) |
| Ingest | `python -m ingest.embed_store` |
| DB lõi WS1 | `python scripts/apply_schema.py` → `python -m ingest.core_store` |
| Role DB + duyệt (v3.4) | `python scripts/apply_schema.py --roles` (schema + `docs/roles.sql`: `agent_writer`/`app_human`) · `python -m pipelines.store --verify-log` (kiểm hash chain `agent_action_log`) |
| Đăng nhập UI (v3.4) | `AUTH_MODE=proxy\|local\|dev` (trống = chặn) · `python -m pipelines.auth --hash` (tạo hash scrypt cho `data/users.json`, gitignored) |
| Golden master (v3.2) | `python -m ingest.golden_store` (nạp `data/golden_skus.json` + phiếu lệch) · `--report` · `--approve-price <id> --by <tên>` (CHỈ người thật duyệt giá — agent không chạy) |
| File sàn (v3.3, chỉ đọc) | `python -m ingest.market_csv --file <csv/xlsx> --channel shopee\|tiktok --kind listing\|order\|ads` (idempotent theo sha256 file, bỏ cột PII, mở/đóng `market_alerts`) · `--report` — mapping cột `data/market_csv_map.json` chưa xác minh với file thật |
| KB nội bộ (v3.9) | `python -m ingest.kb_internal --file <.md\|.txt> --collection internal:<phong> --approved-by "<trưởng phòng>"` (bảng riêng `chunks_internal`, chatbot khách không đọc; CHỈ người thật duyệt — agent không điền tên; v14 vá review: `agent:`/`system:` exit 2, `auth.cli_gate` khối data_platform/approve bằng login người rồi mới ghi bằng login loader) |
| Câu NO_DATA lặp (v3.9) | `python scripts/kb_gaps.py [--min 2] [--out file.md]` (0 LLM, nhãn sức khỏe/rượu = không bổ sung KB) |
| Backup/diễn tập DB (v3.6) | `python scripts/db_backup.py` (env `BACKUP_DIR` ngoài repo) · `python scripts/db_restore_drill.py` (DB tạm, tự xóa) |
| Kịch bản mùa (v7.3) | `python -m pipelines.scenario --sku <sku_key> --channel <kênh\|offline> --weeks 13 [--start YYYY-MM-DD] [--json]` (khoảng thấp/cơ sở/cao, thuần — giả định `data/scenario_assumptions.json` chờ GĐ KD/TC chốt) |
| Tồn kho (v9.2) | `python -m ingest.inventory_csv --file <csv/xlsx> [--source manual_export\|sample]` (cột `sku_key,kho,qty,captured_at`; idempotent sha256, file lỗi exit 1 không nạp) |
| Sản xuất P1 (v9.2) | `python -m pipelines.production allocate --cutoff <id>` · `approve\|reject --run <id> --by <tên>` · `bom --load <json>\|--check` · `lots --load <json>` · `intake --lot <mã> --result passed\|failed --by <tên>` · `bulletin` (chỉ đề xuất — không chuyển kho/lệnh SX; mốc `data/production_config.json` GIẢ ĐỊNH) |
| Persona giả lập (v7.3) | `python scripts/persona_sim.py --dry-run` (số giả, ghi `sim_runs`); không cờ = exit 2 tới khi DPIA ký (`data/sim_config.json` `dpia_signed`, CHỈ người thật đổi) |
| Vùng trồng (v9.3) | `python -m agents.garden_director --bulletin [--until YYYY-MM-DD]` · `--remind` · `--verify` (hash chain `plot_logs`) · `--precheck` · `--purge-sample --by "<GĐ vùng trồng>"` · `--adopt-plot <id> --by` (nhận khoảnh mẫu có nhật ký đã chain) (CHỈ người thật — agent không chạy) |
| Kho ảnh vườn (v9.3) | `python scripts/garden_media.py --file <ảnh> --plot <khoảnh> --date YYYY-MM-DD --by "<tên>"` (gỡ EXIF/GPS, kho `GARDEN_MEDIA_DIR` ngoài repo) |
| Lô + QR truy xuất (v9.4) | `python -m pipelines.qr_trace link --lot L --log ID [--media SHA ...] --by` · `preview --lot L` · `sign --lot L --role gd_san_xuat\|gd_vung_trong\|phap_che_qa --by` (3 người khác nhau, allowlist `data/qr_signers.json`) · `issue --lot L --by` · `revoke --code C --by` · `site [--out DIR]` (→ `data/qr_site/`, gitignored) · `planb [--date]` |
| Bảng kê Phụ lục A | `python scripts/data_audit.py` (output → `docs/phu-luc-a.md`) |
| Demo UI | `streamlit run app/streamlit_app.py` (hoặc `python demo.py`) |
| Zalo webhook | `python -m connectors.zalo` → :8788/zalo-webhook |
| Mock E2E Zalo | `python scripts/zalo_mock.py` |
| Messenger webhook (v5.1) | `python -m connectors.messenger` → :8789/messenger-webhook (HMAC `X-Hub-Signature-256` bắt buộc; `DEPLOY` tắt = không gửi gì ra Meta) |
| Gợi ý chat sàn (v5.1) | `echo "<tin buyer>" \| python -m connectors.channels --suggest shopee\|tiktok --by "<tên MXH>"` (STDIN, MXH dán tay, không gọi API sàn) |
| Eval KD-A1 CSKH (v5.1) | `python scripts/agent_eval.py --agent kd_a1 --no-record` (tất định, gateway giả, 43 ca) · lần thật nhỏ `python -m connectors.channels --eval-real --limit 8` |
| CRM lead & đại lý (v5.2) | `python -m ingest.crm --load-dealers --by <tên>` · `--add-contact - [--lead ID] --by <tên>` (JSON qua stdin, cần `CONTACT_VAULT_KEY`) · `--consent ID --purpose cskh\|marketing\|dai_ly --grant\|--withdraw --source S [--evidence REF --policy-version V] [--dealer CODE] --by <tên>` · `--assign LEAD --dealer CODE [--province TÊN] --by <tên>` · `--status LEAD STATE --by <tên>` · `--report` · `--handoff LEAD --dealer CODE --by <tên>` (chỉ IN payload cho người chuyển) |
| Số hóa tài liệu (F15.1) | `python -m ingest.doc_intake` (intake `DOC_INTAKE_DIR`) · `--pending` · `--verify <sha256> --by "<tên>"` · `--reject <sha256> --by "<tên>"` |
| Eval RAG | `python scripts/eval_qa.py` (12 câu questions.md, ~90s, exit 0 nếu ≥10/12 + 2 bẫy pass) |
| Eval theo agent | `python scripts/agent_eval.py --agent <suite>` (suite `data/eval/suites/<agent>.json` = ca + ngưỡng + owner, ghi `eval_runs`; `--no-record`/`--allow-dirty`) · `--validate` (mọi suite) · `--deterministic` (CI: validate + suite tất định) · `--print-hash <agent>` (sửa ca = bump `version` + hash mới) · `--propose-threshold|--propose-suite <agent> --by <tên>` (đổi ngưỡng/bộ ca sau run FAIL → override_qa + duyệt) |
| Cổng deploy | `python scripts/deploy_gate.py --sha <SHA> --approved-by "<tên>" [--hotfix]` (chỉ in kế hoạch; cần PASS + người duyệt + luật đóng băng theo lịch `data/freeze_calendar.json` qua `pipelines/freeze.py` — trong 21/12–10/02 chỉ `--hotfix` hoặc break-glass còn hạn) |
| Hàng duyệt chung (v4.0) | `python -m pipelines.approval_queue --pending [--block K]` · `--approve/--reject ID --by "<tên>"` · `--override-qa ID --by "<tên>" --reason ".."` · `--expire` (mọi loại việc trừ content_draft; quá SLA → expired, không tự duyệt) |
| Bản tin GĐ khối (v4.0) | `python -m pipelines.director --block K` · `--all --dry-run` (cấu hình `data/directors/<khối>.json`, 9 khối; bản tin → `data/reports/director-*.md`, không tự gửi; khối finance dùng `python -m agents.acc_ar --bulletin` thay — director ghi đè mất mục nợ quá hạn) |
| B2B báo giá (v8.2, WP11) | `python -m agents.kd_quote --check-matrix` · `--requests` · `--quote ID [--discount P] [--submit\|--dry-run]` · `--export QID --out F.md\|F.html` · `--verify-send QID F` (bản gửi khớp sha256 bản duyệt — GĐ bán hàng tự gửi) · `python -m agents.kd_catalog --build [--bom F]` · `--submit` · `--verify-send` (catalog quà Tết, không rượu/TPBVSK chưa XNQC) · `B2B_FORM_ENABLED=1 python -m connectors.b2b_form` (form :8791/b2b, mặc định TẮT) |
| B2B tổ chức + sổ mốc (v8.3, v12.0 khối sales/ceo) | `python -m agents.da_b2b --import F --by` · `--submit-batch` · `--handover QID --by` (tổ chức mua quà → khối sales, không PII, không tự liên hệ) · `python -m agents.da_pmo --seed` · `--board [--submit]` · `--propose-due/--apply-due` (sổ mốc → khối ceo) — lô/đề xuất cũ khối `projects` (trước v12.0) vẫn `--handover`/`--apply-due` được |
| Bản tin GĐ khối (v4.0) | `python -m pipelines.director --block K` · `--all --dry-run` (cấu hình `data/directors/<khối>.json`, 9 khối; bản tin → `data/reports/director-*.md`, không tự gửi) |
| Cảnh báo đỏ (v4.0) | `python -m pipelines.red_alert --check-routing` (exit 1 = chưa có người nhận độc lập — `data/red_alert_routing.json`, external-dep) |
| Cockpit TGĐ (v8.0) | `python -m pipelines.cockpit --metrics` · `--collect [--period week\|month] [--ref YYYY-MM-DD] [--dry-run]` (chỉ kỳ ĐÃ ĐÓNG giờ VN) · `--import FILE --by "<người xuất>" [--sample]` (CSV `manual_export`, lỗi → exit 1, 0 dòng) — ghi `channel_snapshots` insert-only |
| Báo cáo TGĐ (v8.0) | `python -m agents.ceo_report [--period week\|month] [--ref YYYY-MM-DD] [--llm] [--submit] [--out-dir DIR]` (→ `data/reports/ceo-<kỳ>.md`; số do code điền; `--llm` mặc định tắt; `--submit` vào hàng chờ khối ceo, không tự duyệt/gửi) |
| Audit inside-out BKS (v10.0) | `python -m agents.bks_audit --report [--month YYYY-MM] [--out-dir DIR] [--record \| --dry-run]` (→ `data/reports/bks-audit-<tháng>.md`; hash chain + neo đuôi, duyệt ↔ nội dung ↔ log, override bất thường, quyền role; chỉ đọc, `--record` ghi 1 dòng `audit_runs`; exit 0 kể cả có phát hiện) |
| Đối soát độc lập BKS (v10.0) | `python -m agents.bks_recon --month YYYY-MM [--seed N] [--out-dir DIR] [--record \| --dry-run]` (quyết toán ↔ đơn sàn ↔ P&L ↔ cockpit, khác biệt có nguồn; ≤200 dòng kiểm 100%, vượt → mẫu theo seed) |
| Gói HĐTV (v10.0) | `python -m agents.hdtv_report --month YYYY-MM \| --quarter YYYY-Qn [--out-dir DIR] [--submit] [--record]` (→ `data/reports/hdtv-<kỳ>.md` 7 mục, mọi số có nguồn — số không nguồn → exit 1; `--submit` mục `hdtv_pack` khối ceo, TGĐ duyệt, không tự gửi HĐTV) |
| Cảnh báo đỏ intel (v7.1) | `python -m pipelines.intel_alert --run` (luật GIẢ ĐỊNH `data/intel_alert_rules.json` → `red_alerts`, leo thang sau 2 giờ chưa xác nhận; exit 1 khi thiếu người nhận — fail-closed) · `--open` · `--ack ID --by "<tên>"` (CHỈ người thật) |
| Bản tin intel (v7.1) | `python scripts/intel_bulletin.py --period day\|week [--date YYYY-MM-DD] [--llm] [--suggest]` (→ `data/reports/intel-bulletin-*.md` BẢN NHÁP; LLM chỉ khi `llm.enabled`; `--suggest` → `approval_queue` loại `intel_topic` cho Quản lý MXH duyệt) |
| Catalog/listing KD-A4 (v5.3) | `python -m agents.kd_listing --run --dry-run` (chỉ đọc) · `--run` (lệch listing sàn ↔ bản duyệt/golden → hàng duyệt `listing_sync`/`market_alert_s1`, agent KHÔNG sửa sàn) · `--report` |
| Giá & KM KD-A5 (v5.3) | `python -m agents.kd_price --report --plan <CSV> --as-of <ngày>` · `--run [--dry-run] [--plan CSV]` (floor/biên/lệch niêm yết/trần KM/KM chồng → NHÁP `price_change`/`promo_change`/S1; KHÔNG đổi giá, ngưỡng `data/price_watch.json` GIẢ ĐỊNH) |
| GĐ Kinh doanh TMĐT (v5.0) | `python -m agents.sales_director --run [--dry-run] --bulletin` (dry-run CHỈ ĐỌC, in kế hoạch + bản tin) · `--run` (nguồn thật → hàng duyệt khối sales + quét SLA A 2h/B 4h giờ làm việc → `sla_escalations`/cảnh báo đỏ) · `--bulletin [--period week]` (→ `data/reports/sales-director-*.md`, không PII, không tự gửi) |
| Sổ triển khai + nghiệm thu (v12.1) | `python -m pipelines.rollout --seed --by <tên>` · `--status` · `--promote ID --by <tên>` (cổng PL02, v13.3: chạy thử ≥5 ngày làm việc + ≥50 đầu ra DISTINCT ở `output_sources` của đúng tính năng — hàng duyệt/nháp nội dung, guardrail đạt, không mẫu — rải ≥5 ngày làm việc; có người duyệt ≥10 ngày + ≥1 đầu ra NGƯỜI duyệt từng mục + 0 đầu ra duyệt thiếu người + 0 lỗi nghiêm trọng) · cưỡng chế runtime `rollout.mode()` (HĐ 6.7; chưa vào sổ/DB down = chạy thử; `rollout_config.json` `enforce`): tắt → không sinh/không duyệt; chạy thử/tắt → `approval_queue.verify` (mọi --verify-send/--export/áp dụng), `store --schedule`, chatbot gửi khách bị chặn (câu bot → gợi ý `cskh_reply` chờ người) · `--severe ID --reason <mã> --by` (tự lùi về chạy thử) · `--disable ID --by` · `--dossier --phase P1\|P2 [--out F]` (hồ sơ đề nghị nghiệm thu, chỉ đọc) — `--catalog` (tổng hợp danh mục ↔ số HĐ, không DB) — danh mục `data/contract_features.json` v13.0 (BẢN ĐỀ XUẤT tách nhóm PL01 → mục `<nhóm>.<n>` + `nhom_goc`, `code_status`/`acceptance_status`/`output_sources`/`blocker`; chờ hai bên chốt 89 mục), lịch `data/rollout_config.json` GIẢ ĐỊNH · board v13 `docs/handover/v13-board.md` |
| Nhân sự PC-HR (v12.2) | `python -m agents.pc_hr --jd <vi_tri>` (nháp mô tả công việc `data/hr/jd_templates.json` BẢN DEV SOẠN) · `--screen --jd <vi_tri> [--dir D]` (CV .txt/.md ở `HR_INBOX_DIR` NGOÀI repo; xếp hạng tất định, mã = sha256, không PII, không tự loại) · `--attendance F --month YYYY-MM` (cột `ma_nv,ngay,gio_vao,gio_ra`, kiểm toàn file, luật ca `data/hr/attendance_rules.json` GIẢ ĐỊNH) · `[--dry-run]` → hàng duyệt khối legal_hr |
| Đối soát nhãn + cận hạn (v12.3) | `python -m agents.sx_label --sku <sku_key> --text <file nhãn .txt> \| --image <ảnh\|pdf> [--submit]` (trích tất định tên/ĐKSP/quy cách/NSX-HSD/mã lô/cụm bắt buộc → so golden `sku_master` + `production_lots` + listing mới nhất; `--submit` → 1 mục `label_check` khối production; SKU nhóm hạn chế chỉ ghi mã tra cứu `H-<sha8>`; ảnh cần `OCR_PROVIDER` trong nước của doc_intake, chưa có → exit 2; luật `data/label_rules.json` GIẢ ĐỊNH) · `python -m pipelines.production bulletin` có mục "Hàng cận hạn (FEFO)" (`near_expiry_days` GIẢ ĐỊNH 90) |
| Nhật ký vườn qua Zalo (v12.4) | nhân viên trong `data/garden_staff.json` (gitignored, mẫu `.sample.json`; `user_hash` lấy bằng `python -m connectors.zalo_garden --hash` đọc user_id từ STDIN) nhắn OA: chữ `<mã khoảnh> <hoạt động> <chi tiết>` → `plot_logs` (hash chain), ảnh → `garden_media` (gỡ EXIF/GPS, `GARDEN_MEDIA_DIR`), ghi âm → `garden_voice_drafts` chờ chép lời (STT external-dep, không gửi audio) · `--pending` · `--done ID --log LOG_ID --by "<tên>"` |
| Đối soát doanh thu quý (v12.5) | `python -m agents.rev_share --quarter YYYY-Qn [--record \| --dry-run]` (→ `data/reports/doi-soat-<kỳ>.md`: gộp − phí sàn − hủy − hoàn = thuần từ `settlement_rows` + trạng thái đơn `orders`; thiếu nguồn = "chưa có dữ liệu"; ô ký 2 bên trống — số chỉ là ĐỀ XUẤT, HĐ Điều 7.6) · `--year N` (năm hợp tác tính từ `ngay_ky_hop_dong`, KHÔNG từ ngày vận hành — v13.2) — tỷ lệ phí/mức thưởng/ngày ký/ngày bắt đầu vận hành `data/rev_share.json` null = chưa chốt; khoản quyết toán xuất lại ở ≥2 file (view `v_settlement_khoan`, `settlement_csv.overlaps`) → trùng tính 1 lần, lệch giữ cả hai, BẤT THƯỜNG không tính phí; `--record` ghi `revenue_quarters` append-only; Bên A xem qua role `ben_a_reader` |
| Báo cáo vận hành tháng (v12.6) | `python scripts/ops_monthly.py --month YYYY-MM [--out-dir DIR]` (→ `data/reports/van-hanh-<tháng>.md` gửi Bên B trước ngày 05: KPI vận hành PL02 mục 3, tiêu chí kỹ thuật PL02 mục 2, tài sản hợp tác `data/tai_san_hop_tac.json`; chỉ đọc, không tự gửi; thiếu nguồn = "chưa có dữ liệu"; DB down exit 1) · hạ tầng on-prem `deploy/onprem/README.md` |
| Media vườn / provider / hạn lưu (v13.4) | `python scripts/garden_media.py --file <ảnh\|.mp4\|.m4v\|.mov> ...` (video: magic MP4/MOV, ≤200 MB GIẢ ĐỊNH, remux ffmpeg gỡ metadata/GPS — thiếu ffmpeg → từ chối; Zalo vườn nhận `user_send_video`, ghi âm kiểm magic bytes) · `python -m connectors.zalo_garden --transcribe ID` (registry STT chỉ `none` → exit 2 BLOCKED vendor+DPA+key) · OCR `none` + có scan/ảnh → `doc_intake` exit 2 `[blocked]` · `image_studio --scene` khi `IMAGE_PROVIDER=none` → exit 2 · `python scripts/retention_purge.py [--dry-run]` (`data/retention.json` TTL null = chưa chốt → không xóa, bản tin sức khỏe mục 6 cảnh báo) · đối chiếu 14 hồ sơ ↔ 13 SKU `data/product_dossiers.json` (chua_xac_nhan, chờ Bên B) |
| Ủy quyền người duyệt (v13.5) | chế độ thực `AUTH_MODE=local\|proxy` hoặc `APPROVAL_ENFORCE=1` (hoặc `DEPLOY`): `approval_queue --approve/--reject/--override-qa`, `store --approve/--reject/--schedule` và tab **Duyệt & Lịch** (thêm hàng duyệt chung 9 khối) đi qua `pipelines.auth.authorize` — người phải có tên trong `approvers` của ĐÚNG khối `data/directors/<khối>.json` (rỗng = chặn, CHỈ điền theo văn bản ủy quyền Bên B), vai trò thuộc `approver_roles`, CLI chạy bằng login Postgres riêng khớp `db_login` trong `data/users.json`; `agent:`/`system:` không bao giờ duyệt (cả function DB); lần bị chặn → `agent_action_log` `authz_denied`. Dev = cảnh báo. Quy trình login/Bên A/chấm dứt: `docs/handover/runbook-ha-tang.md` mục 9 |
| 3 nháp bài/ngày + nhắc nợ (v13.6) | `python -m pipelines.content --daily [--date YYYY-MM-DD]` (PL01 Marketing: chủ đề = ô `post` chiến dịch có mốc NHÁP đúng ngày + trụ thường ngày `daily_posts` trong `data/marketing_calendar.json` GIẢ ĐỊNH; lọc readiness DB, trụ gắn SKU không có SKU hợp lệ → báo THIẾU exit 1, không soạn bài vi phạm cho đủ số; khóa `[daily ngày #slot]` + index unique → retry/restart không nhân bản; nháp pending agent:mkt02, người duyệt/đăng tay; tính năng tắt → exit 2, 0 LLM) · `python -m agents.acc_ar --reminders [--as-of] [--dry-run]` (nháp thư nhắc nợ khoản QUÁ HẠN, chỉ đại lý có trong sổ `dealers`; placeholder thay tên/người nhận/người ký, chứng từ FIFO + nguồn file sha256 → mục `ar_reminder` khối finance, idempotent theo trạng thái nợ; agent KHÔNG gửi) |
| Vận hành: lịch/cảnh báo/30s/sự cố/KPI (v13.7) | lịch on-prem `deploy/onprem/jobs.json` + `deploy/onprem/systemd/` (timer → `python -m pipelines.job_runs --run <tên>`: khóa chống chạy chồng, bị khóa exit 75, ghi `job_runs` `job:<tên>`; `--list`; repo KHÔNG tự cài lịch) · cảnh báo đỏ GỬI THẬT qua SMTP (`RED_ALERT_NOTIFY=email` + `SMTP_*`, người nhận `email:<địa chỉ>\|$BIEN`; `raise_alert` True chỉ khi đã gửi được — `red_alert_deliveries`) · `python -m pipelines.red_alert --check-routing` (exit 1 khi thiếu người nhận HOẶC chưa có kênh gửi) · `--deliver` (gửi lại 48 giờ) · `--ack ID --by` (MỌI cảnh báo đỏ, chế độ thực chỉ người nhận độc lập) · `--open` · chatbot hạn chót TỔNG 30 giây từ lúc nhận (`api.rag.DEADLINE`/`CHAT_BUDGET_S`, quá hạn → HANDOFF + `cskh_handoff` lý do `deadline`) · `python -m pipelines.ops_incidents --open --title --severity nghiem_trong\|thuong --source --ben ben_a\|ben_b\|chua_xac_dinh --detected-at [--occurred-at] --by` · `--event ID --kind responded\|fixed\|customer_resolved\|note --by` · `--list [--month]` · `python scripts/ops_monthly.py --snapshot` (KPI chat không PII → `chat_kpi_facts`) · `--month prev` · `--mark-sent YYYY-MM --file van-hanh-YYYY-MM.md --by "<người gửi>"` |
| P2 neo blockchain + VBPL + mốc HĐ (v13.8) | `python -m pipelines.anchor --build [--dry-run]` (gốc Merkle đầu chuỗi `plot_logs` + chữ ký/phát hành/thu hồi QR lô không mẫu → `anchor_batches` append-only; chuỗi hỏng/0 lá → exit 1) · `--submit ID\|latest [--by]` (provider `data/anchor_config.json` mặc định `none` → exit 2 CHƯA NEO, chọn chuỗi/phí = hai bên; `opentimestamps` chỉ gửi digest 32 byte, biên nhận .ots → `anchor_receipts`, lỗi → dòng `loi`, chạy lại = thử lại) · `--verify ID\|latest` (đối chiếu NỘI BỘ lá ↔ DB, không phải bằng chứng bên thứ ba) · `--export ID --out DIR` (bản kê + .ots → bên thứ ba `ots upgrade`/`ots verify`) · `--status` · `python -m pipelines.legal_updates --submit [--limit N] [--dry-run]` (tin PC-A8 luật `legal_doc` → mục `legal_doc_review` khối legal_hr, payload template, không diễn giải/không đổi luật) · `python -m agents.da_pmo --board` có mục "Mốc chưa có ngày" (`moc_chua_co_ngay`, mốc PL01 mục 7 phụ thuộc ngày ký) · sổ nghĩa vụ ngoài code `docs/handover/so-nghia-vu-hop-dong.md` · API sàn/domain QR BLOCKED (Bên B cấp sandbox/key, tên miền) |
| Quyền dịch vụ + quyết định người ở CLI (v14.2) | mọi CLI `--by` là QUYẾT ĐỊNH (production approve/reject/intake, golden `--approve-price`, qr_trace sign/issue/revoke, xnqc `--set`, rollout `--promote/--severe/--disable`, red_alert `--ack`, crm consent/assign/handoff/load-dealers, doc_intake `--verify/--reject`, fp_pnl `--cogs-approve`, garden_director `--purge-sample/--adopt-plot`) đi qua `pipelines.auth.cli_gate` (chế độ thực: approvers đúng khối hoặc danh sách riêng + `--by` khớp `db_login`, bị chặn → `authz_denied`; log từ chối KHÔNG commit việc dở của caller) · login dịch vụ riêng `svc_webhook/svc_job/svc_loader/svc_backup` (`docs/roles.sql` khối v14.2) qua `WEBHOOK_/JOB_/LOADER_/BACKUP_DATABASE_URL` (`auth.bind_service`; chế độ thực thiếu biến/login superuser-owner/sai role → từ chối; job exit 78) · `settlement_rows` append-only, `orders` thật không xóa + `order_history` · runbook mục 9.5–9.6 |
| Rollout phủ đủ biên (v14.3) | bộ đếm đầu ra `pipelines.rollout.output_facts` cho MỌI nguồn bảng/report của danh mục (DISTINCT khóa tự nhiên trong cửa sổ, loại mẫu theo cột provenance — `is_sample` mới trên `approval_queue`/`allocation_proposals`/`audit_runs`; quy ước tên cũ chỉ loại thêm; nguồn `file` còn chưa đếm) · báo cáo file của tính năng → sổ `report_outputs` (`write_report(..., sample=)`) · `echo "<tin buyer>" \| python -m connectors.channels --suggest shopee --by "<MXH>"` ghi `san_suggestions` (không tin buyer) · `python -m connectors.channels --mark-sent ID --by "<MXH>"` (chỉ khi sales-02 cho dùng + gợi ý soạn ngoài chạy thử) · tắt → không sinh ở `production allocate`/approve, `settlement_csv` đối soát, `audit_runs` (bks_audit/bks_recon/hdtv), `persona_sim`, `kd_affiliate --attribute`, `rev_share --record`, `cockpit --collect`, gói HĐTV; `qr_trace site` chưa cho dùng → trang đã công khai thay bằng "tạm ngưng" · nhật ký vườn nhập tay / sổ quyết định TGĐ = người ghi, không qua cổng |
| Kinh doanh còn thiếu (v14.4) | sales-04.1 `python -m ingest.crm --owner LEAD --staff <MÃ NV> --by <tên>` (người phụ trách = MÃ nhân viên, không tên; hạn xử lý theo giờ làm việc; qua `auth.cli_gate` sales/assign) → lead chưa gán/quá hạn: `agents.sales_director --run` đẩy `lead_followup` theo ĐỢT + leo thang SLA lớp B · sales-05 `python -m agents.kd_quote --followups [--dry-run]` (báo giá ĐÃ duyệt chưa có kết quả sau N giờ làm việc từ lần gửi/duyệt → NHÁP nhắc `b2b_followup`, tối đa `max_reminders`/đợt; `--verify-send ... [--by]` ghi mốc `da_gui`; `--outcome QID chot\|khong_chot\|huy --by` NGƯỜI ghi kết quả — bảng `b2b_quote_events` append-only) · sales-06.1 `python -m ingest.dealer_price --file CSV --by <tên> [--sample]` (giá ĐẠI LÝ quan sát tay `kenh,ma_dai_ly,sku_key,gia_vnd,ngay,url_nguon`, kiểm toàn file, idempotent sha256 → `dealer_price_obs` append-only) · `python -m agents.kd_price --dealer-watch [--dry-run] [--as-of]` (dưới giá sàn golden ngày quan sát → `dealer_price_alert`) · sales-06.2 `python -m agents.kd_orders --watch [--dry-run] [--as-of]` (tỷ lệ hủy/hoàn tuần ĐÃ đóng vượt ngưỡng/≥ hệ số × nền → `order_anomaly`, đợt theo số đơn xấu; đơn TRỄ "chưa đo" — file xuất chưa có cột ngày đặt) · ngưỡng `data/sales_watch.json` GIẢ ĐỊNH (GĐ bán hàng chốt); agent KHÔNG liên hệ khách/đại lý, KHÔNG đổi giá/xử lý đơn |
| Marketing/CEO/Intel còn thiếu (v14.5) | marketing-04.2 `python -m agents.ra_kenh --partner-file CSV --by <tên> [--dry-run]` (bài KOC/đại lý ĐÃ đăng `ma_doi_tac,url,kenh,text,ngay_dang[,sku]` — chỉ MÃ đối tác có trong sổ KOC/`dealers`, cột lạ/mã lạ → 0 dòng; guardrail đăng bài `koc`+quảng cáo + đối chiếu kit ĐÃ duyệt `koc_brief`/`affiliate_program` → `marketing/partner_post_review` theo ĐỢT; sổ `partner_post_scans` append-only chỉ sha256 URL/text + tên miền nền tảng) · ceo-04.1 `python -m agents.ceo_promo [--plan CSV] [--running CSV] [--as-of] [--dry-run]` (KM đang chạy = listing sàn `sale_price` < niêm yết + file xuất KM/voucher định dạng `kd_price --plan` ↔ bản duyệt = kế hoạch KM + giá KM golden `promo` đã duyệt → `ceo/promo_deviation`, khóa ĐỢT theo snapshot/sha file) · intel-04.2 `python scripts/intel_weekly.py --suggest-keywords [--import ID] [--dry-run]` (Trends related → loại từ cấm/công dụng/sức khỏe/rượu/PII/chỉ dẫn địa lý chưa xác nhận → `intel/keyword_suggest` mỗi file, không chép từ khóa bị loại) · tắt → exit 2; agent KHÔNG liên hệ đối tác, KHÔNG đổi KM, KHÔNG chạy quảng cáo/SEO |
| Vận hành còn sót (v14.6) | `python -m pipelines.red_alert --escalate` (MỌI cảnh báo đỏ gốc quá 2 giờ ĐỒNG HỒ chưa `--ack`, kể cả T7/CN/Tết → đúng 1 bản leo thang/cảnh báo, cùng nguồn, unique index chung; chưa thông báo được → exit 1; `intel_alert` dùng chung) · lịch mới `deploy/onprem/jobs.json` + timer: `red_alert_escalate` 15 phút, `anchor_build` 02:30, `legal_updates` 07:15 · chatbot Zalo: refresh token/chờ refresh/gửi lại nằm TRONG 30 giây (`zalo._SEND_DEADLINE`; thiếu ngân sách → bỏ bước, tin không tới khách → `cskh_handoff` lý do `deadline`), nhánh giữ câu trả lời gửi TRƯỚC rồi mới ghi gợi ý DB · `ops_monthly` bảng tài sản 8 cột (vị trí/phiên bản/chủ quản/quyền truy cập, thiếu → "chưa xác nhận") · `qr_trace link` + trigger DB từ chối sha video |
| Quyền người ghi qua function (v15.4) | CLI người (golden `--approve-price`, xnqc, rollout `--promote/--severe/--disable`, crm, doc_intake `--verify/--reject`, garden_director `--purge-sample/--adopt-plot`, ra_kenh `--partner-file`) chạy bằng login `in role app_human`: ghi CHỈ qua function SECURITY DEFINER `*_human` — danh tính theo `session_user` ↔ bảng `human_logins` (login ↔ người ↔ khối, CHỈ owner ghi, Bên B điền; repo trống) qua `human_actor()`, `--by` khác người của login / khối ngoài phạm vi / agent → 42501 + `authz_denied` (`auth.call_human`) · `--by` P10.2: quyết định (`da_pmo --set-status`, `ra_kenh --mark-removed`, `anchor --submit --by <người>`) → `auth.cli_gate`; nhập liệu/thực thi (`da_pmo --apply-due`, `da_b2b --handover`, `kd_quote --outcome/--verify-send --by`) → `auth.cli_identity` · bks_reader: SELECT `feature_rollout` + INSERT 4 cột `report_outputs` · vá review v15: `rollout_transition_human` TỰ đếm lại cổng PL02 (ngày làm việc, đầu ra DISTINCT, người duyệt, `output_reviews`) bằng `feature_rollout.count_spec` = chính câu SQL Python, owner ghi qua `rollout --seed` (đổi `output_sources`/bộ đếm/lịch nghỉ → chạy lại `--seed`; chưa có `count_spec` → DB từ chối nâng; nguồn `file` chỉ ngưỡng số lượng theo Python) · `ra_kenh --partner-file` kiểm `human_actor` TRƯỚC mọi ghi · runbook mục 9.7 |
| Đếm đầu ra + duyệt từng đầu ra (v15.2) | `python -m pipelines.rollout --outputs ID` (đầu ra báo cáo/bảng/file không có bước người riêng trong giai đoạn hiện hành: khóa + sha phiên bản + đã/chưa duyệt) · `--review-output ID --key K --sha S --decision approved\|rejected --by <tên> [--note]` (NGƯỜI duyệt đúng phiên bản — `auth.cli_gate` khối của tính năng + function `output_review_human` danh tính theo login; sổ `output_reviews` append-only; sinh ra ≠ đã duyệt, nội dung đổi = duyệt lại; cổng co_nguoi_duyet → van_hanh đòi 0 đầu ra chưa duyệt) · nguồn file đếm được: `data/conversations.jsonl` (+`.1`, câu bot đã gửi khách zalo/messenger; v15 fix P8.1: CHỈ dòng `provenance=live` do sender thật ghi — mock/replay/sample/dòng cũ thiếu provenance KHÔNG tính) — thiếu file = không đếm được · backup (data_platform-07.2, v15 fix P8.7c) đếm/duyệt từ sổ DB `file_output_evidence` (append-only, CHỈ `svc_backup` ghi qua `file_output_evidence_backup` ngay khi `db_backup` thành công; app_human không ghi được) — đổi catalog → owner chạy lại `rollout --seed` · người duyệt (login `app_human`) liệt kê/duyệt bằng `--outputs`/`--review-output` qua `output_pending_human`/`output_review_human` (DB kiểm khóa tồn tại, đúng tính năng/nguồn, sha phiên bản hiện hành, không mẫu) · báo cáo `.md` của tính năng chạy thử/chờ duyệt mang nhãn "CHẠY THỬ — KHÔNG GỬI"/"CHỜ NGƯỜI DUYỆT — CHƯA GỬI" trong nội dung · mọi caller `write_report` truyền `sample=` theo provenance (test AST) · `intel_alert --run` bỏ luật của tính năng TẮT · `mkt_ads` mục ngân sách created_by `agent:mkt05_budget` (marketing-03) · `sales_director --run` báo `lead_deferred` |
| Chính sách chờ quyết (v15.6 p12) | `python -m pipelines.loader_gate --status` (8 loader nạp file — `data/loader_gate.json` `chinh_sach` null = CHƯA CẤU HÌNH: tính năng trong `features` TẮT → loader exit 2 không nạp; `chan_khi_tat`/`nap_ca_khi_tat` + `chot_boi`/`can_cu` CHỈ chủ khối/hai bên điền; file hỏng → mọi loader bị chặn) · `python -m pipelines.red_alert --escalate --dry-run [--after ID]` (xem trước KHÔNG ghi: luồng thường + cấp 2 + cảnh báo TỒN phân trang 50/trang; tồn = gốc quá 2 giờ trước mốc bật `agent_action_log` `red_alert_escalation_start`; routing `backlog.chinh_sach` null = tồn KHÔNG tự leo thang, `leo_thang_dan`/`khong_leo_thang` Bên B quyết; `cap2`/`ngoai_gio` rỗng = không leo thang cấp 2/không gửi người trực, `--check-routing` in rõ) · `intel_weekly --suggest-keywords` lọc thương hiệu/xuất xứ đối thủ theo `data/keyword_competitors.json` (chưa duyệt → nhóm CHỜ QUYẾT, không vào đề xuất) · `ra_kenh --partner-file` mã đối tác lạ theo `data/partner_policy.json` (null = mặc định an toàn `tu_choi_file` + cảnh báo; `ghi_vi_pham` = vi phạm `doi_tac_chua_dang_ky`) |
| Đợt DOCX (19/10/2026) | cổng PL02 DB-only: `rollout --promote` login người dùng số DB đếm lại (`rollout_recount_human`), `rollout_transition_human` bỏ số caller khai, nguồn file → không nâng · sales-01 đếm sổ `file_output_evidence` nguồn conversations (webhook `svc_webhook` ghi qua `file_output_evidence_chat`) · trigger `person_login_guard`: login người (app_human, không `svc_ui`) chỉ ghi quyết định/nhật ký tên CHÍNH mình (`human_logins`, đúng khối) — Streamlit dùng login `in role svc_ui` · `python -m agents.xnqc --draft --sku K --loai L --ten T [--maket F] [--submit]` (nháp hồ sơ XNQC → legal_hr/xnqc_dossier; danh mục `data/xnqc_draft.json` GIẢ ĐỊNH) · `--out-dir DIR` ghi báo cáo đếm được: `scripts/intel_weekly.py` (intel-doithu-/intel-trend-), `pipelines.production bulletin [--period week\|month]` (sx-bantin-/sx-canhan-), `pipelines.scenario` (kich-ban-), `agents.fp_cash --forecast` (dong-tien-), `scripts/contract_check.py` (hd-mau-); `health_bulletin` qua `write_report` · `agents.garden_director --remind --submit` (khoảnh vẫn bỏ trống → farming/plot_log_gap) · 7 job mới `deploy/onprem/jobs.json` (giờ GIẢ ĐỊNH) |
| Đợt DOCX vòng 2 (19/10/2026) | trigger `person_login_guard`: action quyết định của người không bao giờ ghi bằng tên `agent:`/`system:`/`auto_policy:` (mọi login không owner, NFKC); ký/phát hành/thu hồi QR đòi vai QR của login trong `human_qr_roles` (owner ghi, Bên B điền) · `python -m agents.mkt_ads --propose [--month YYYY-MM] [--dry-run]` (agent tự đề xuất phiếu ads từ ô FP&A DE_XUAT + creative đã duyệt + `data/ads_proposal.json` — null = BLOCKED exit 2; mỗi SKU × kênh × tháng ≤ 1 đề xuất agent còn hiệu lực) · KPI chat: `ops_monthly --snapshot` ghi sổ `chat_kpi_live` (chỉ convlog live, khóa qkey + sha nội dung); KPI đọc sổ này + convlog live, `chat_kpi_facts` cũ = UNKNOWN đếm riêng |
| Đợt hợp đồng (20/10/2026) | `python -m agents.bks_audit --chain-alert` (job `chain_watch` 06:20: kiểm chuỗi `agent_action_log`+`plot_logs`+neo đuôi → cảnh báo đỏ, cùng phát hiện không báo lặp, có phát hiện exit 1; svc_job EXECUTE `verify_action_log` + SELECT `audit_runs(id,kind,params)`) · `python -m ingest.doc_intake --reprocess-pending` (OCR lại `cho_ocr` khi `OCR_PROVIDER` trong nước; provider none → exit 2; kết quả vẫn `pending_review`) · guardrail `ngam_y_suc_khoe` (claim ngầm: đối tượng bệnh + lời chứng kết quả, chỉ `check_publish`) · `intel_alert` luật `counterfeit` + `red_alert_sweep` thu RSS mỗi giờ · `intel_weekly` báo độ phủ K5/TRIMICO/KGC · `ceo_weekly` chạy `cockpit --collect` trước · `zalo.send_text` dry-run khi `DEPLOY` tắt · đối chiếu `docs/handover/doi-chieu-docx.md`, quyết định `docs/handover/dau-vao-va-quyet-dinh.md`, staging runbook mục 10 · **test luôn đặt `DATABASE_URL` DB riêng** (conftest/import nạp `.env` → mặc định trỏ `samsam`) |
| Đợt hợp đồng vòng 2 (20/10/2026) | webhook 24/7: `deploy/onprem/systemd/samsam-webhook-{zalo,messenger}.service` + `/readyz` + `python scripts/webhook_probe.py` (job `webhook_health`) · `python -m agents.garden_director --remind --submit` (nhắc người phụ trách khoảnh trước GĐ, sổ `garden_reminders`, kênh `data/garden_remind.json`) · `--reminders` · `--mark-reminded ID --by` · `python -m pipelines.production cert --lot L --file F --cert-no N --by` · `cert-verify [--lot]` (kho `LOT_CERT_DIR` ngoài repo) · `plan-add --code --sku --qty --start --due --by` · `plan-link --plan --lot --by` · `python -m agents.listing_export --sku K --channel shopee|tiktok --out DIR` · `--verify MANIFEST` · `python scripts/garden_media_mkt.py --release|--revoke SHA --by` · `--list` · `--get SHA --out DIR` · `python -m agents.combo_price [--dry-run]` · `python -m agents.ra_kenh --scan-auto [--dry-run]` · `python -m agents.hdtv_report --month prev --submit` · job `channel_scan`/`hdtv_month`/`vt_weather`/`vt_harvest` · **pytest: `tests/_db_guard.py` chặn kết nối DB `samsam` (URI/keyword/kwargs/PG*/dotenv/tiến trình con) + preflight DB test đã dựng** · vá 21/10: kết nối PHẢI có DB đích tường minh (dbname/`PGDATABASE` — không suy từ user/`PGUSER`); `subprocess` kiểm môi trường HIỆU LỰC lúc spawn (kể cả không truyền `env`/`env=None`); hai chế độ: **unit** = không đặt `DATABASE_URL` (test cần DB tự skip — không phải gate), **integration/full** = `DATABASE_URL` tới DB test đã dựng → preflight lỗi kết nối/truy vấn/quyền/thiếu bảng → phiên dừng exit 4 |
| Đợt hoàn thiện theo DOCX (22/10/2026) | danh mục `data/contract_features.json` = 89 AI/9 khối/P1 80–P2 9 theo DOCX; id cũ → `da_thay_the`, mục mới `thay_the` (`rollout --seed` mốc MỚI, chỉ kế thừa TẮT); cảnh báo đỏ đếm theo LUẬT ĐẦU · gateway `chat/embed(..., feature=<mã>)` BẮT BUỘC cho lời gọi mới (test AST): trần `feature_caps_usd` + nút tắt `kill_features`/`LLM_KILL_FEATURES`, `llm_usage.feature_id` · `python -m agents.vt_thoitiet --pests --submit` (job `vt_pests`, `farming/pest_alert`, không chờ nguồn dự báo) · `python -m agents.listing_export --website-feed --out DIR` (nguồn dữ liệu website; giá = `price_list` list kênh web ĐÃ duyệt còn hiệu lực, không fallback JSON — vá F2; rượu ẩn giá + không giỏ) · `api.rag.answer(..., feature=)` chỉ nhận `rag.FEATURES` (sales-01 chatbot, sales-02 gợi ý chat sàn — `channels.respond` chọn theo KÊNH; vá F1) · `python -m ingest.product_dossiers --check` (sổ 14 hồ sơ gốc — exit 2 BLOCKED khi chưa đủ) · `ceo_audit --report` ghi thêm `ceo-gia-<ngày>.md` · `sx_tracuu --llm` đạt guardrail → `sx-tomtat-…` · `mkt_ads` kết quả → `marketing/ad_result` · nhãn social `nghi_hang_gia` · `intel_weekly` chạy được bằng svc_job (quyền CỘT `trends_weekly`/`social_mentions`) · DR Docker: `python -m pytest tests/test_dr_drill.py` cần Docker + `postgres:<major>-alpine` + `pg_dump` cùng major (C:/Program Files/PostgreSQL/<major>/bin) — 3 ca thật phải PASSED, skip = chưa kiểm |
| Đợt an toàn + nghiệm thu (22/10/2026) | S01 `python scripts/db_rotate_password.py --check\|--rotate\|--verify\|--verify-consumers --role R ...` (quản trị viên chạy trên đúng môi trường; mật khẩu mới SINH vào tệp, server chỉ nhận verifier SCRAM, không secret vào argv/log; đóng khi mới ok + sai/cũ 28P01 trên đường TCP kiểm mật khẩu — runbook 10.8; test Docker tạm `tests/test_safety_s01_rotation.py`) · S02 timeline/gói kiểm chỉ đọc `docs/handover/su-co-db-samsam.md` (UNVERIFIED) · S03 `listing_export --sku --channel shopee\|tiktok` giá = `price_list` list ĐÃ duyệt hiệu lực (không JSON), manifest `gia_id` → `--verify` bắt giá đổi/hết hiệu lực · S04 `svc_ui` KHÔNG ghi được tên người (DB 42501); UI chế độ thực mở quyền quyết định bằng login Postgres riêng (`auth.person_connect`, `human_whoami()`), `content_drafts.block` kiểm khối ở DB (runbook 10.9); vá S04b: `created_login` = login tạo (DB ghi), login người không tạo draft nhãn agent/không tự khai khối, login/tên trùng tác giả không tự duyệt/quyết/override; vòng r8: CÙNG NGƯỜI qua login khác (theo `human_logins`) cũng bị chặn, kể cả duyệt giá vốn; `person_connect` ghi `human_login_checks` · A01 `python -m pipelines.acceptance --matrix [--out F] [--db]` / `--summary` (96 mục, READY_FOR_TRIAL chỉ khi đủ môi trường+người+dữ liệu; không `--db`/DB lỗi = CHƯA KIỂM login → không READY; B2 đối chiếu ĐÚNG người duyệt đã cấu hình + login còn dùng được (hạn/LOGIN/connlimit/CONNECT); B3 bằng chứng đăng nhập thật `human_login_checks`) → `docs/handover/ma-tran-nghiem-thu.md` · A02 `docs/handover/ho-so-san-sang-chay-thu.md` · A06 `rollout --dossier` DỰ THẢO + sự cố vận hành + phiên bản bàn giao + ngoại lệ; mẫu `docs/handover/mau-ho-so-nghiem-thu.md` |
| Đợt r13 — 12 mục DOCX bị chặn (24/10/2026) | OCR tại chỗ `OCR_PROVIDER=paddle_local` (doc_intake + `sx_label --image`; model det/rec/cls ở `OCR_PADDLE_MODEL_DIR`, KHÔNG tự tải; `OCR_MAX_PAGES`/`OCR_TIMEOUT_S`; `documents.ocr_engine`; OCR rỗng → `[cho_ocr]` exit 2) · STT `GARDEN_STT_PROVIDER=whisper_local` + `GARDEN_STT_MODEL_DIR` (model faster-whisper tải sẵn; `--transcribe ID` in NHÁP; OCR và STT chạy tiến trình riêng — ctranslate2 xung đột DLL với PaddleOCR) · `IMAGE_PROVIDER=openrouter_images` + `IMAGE_MODEL` (`pipelines/image_provider_openrouter.py`, cổng llm_gateway agent `image`/feature marketing-02.1) · `python -m pipelines.anchor --upgrade ID|latest` (→ `da_nang_cap`, KHÔNG phải xác minh bên thứ ba) · `listing_export --verify <website-feed manifest>` · `python scripts/incident_compare.py` (N22: `INCIDENT_BASELINE_URL`/`INCIDENT_NOW_URL`, chỉ đọc, từ chối DB samsam) · `python scripts/onprem_preflight.py [--out]` (đo tại máy, chỉ env tiến trình) · db_backup `BACKUP_REQUIRE_ENCRYPTION=1` / `BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE=1` · market_api 429/5xx thử lại ≤3 + cổng data_platform-06 · persona_sim lượt thật ≥3 nhà cung cấp · product_dossiers đòi `phien_ban`/`tep_sha256` · r13-fix4 (25/10): OCR đòi đủ `inference.pdmodel`+`inference.pdiparams` cả 3 bộ; ảnh AI HTTP 200 hỏng vẫn ghi chi phí (ok=false); `onprem_preflight` đo dump + offsite thật theo manifest; `anchor --upgrade` qua cổng triển khai · runbook 10.11, chờ bên ngoài `dau-vao-va-quyet-dinh.md` mục G |
| Đợt r14 — code còn thiếu theo DOCX (25/10/2026) | OCR `paddle_local` chạy ở tiến trình con `ingest.ocr_worker` (crash/treo/kết quả hỏng → DocError, `OCR_TIMEOUT_S` bọc cả nạp model) · `python -m pipelines.anchor --upgrade ID|latest --by <người>` (giai đoạn có người duyệt, login riêng + `human_logins` khối farming, ghi qua `anchor_upgrade_human`, 1 `da_nang_cap`/lần gom) · `python -m ingest.market_api --channel shopee|tiktok --refresh` (kho `MARKET_TOKEN_FILE` NGOÀI repo; tự refresh khi < 1 giờ; tài liệu chính thức `evidence/itacc_r14_code_gaps/NGUON_TAI_LIEU.md`) · r14-fix2: lỗi sàn chỉ in mã đúng dạng (không phản chiếu token); chống trùng `da_nang_cap` bằng trigger khóa theo lần gom (lịch sử trùng cũ giữ nguyên), `anchor_upgrade_human` trả `(receipt_id, created)` · quyết toán qua API: xem dòng r15 · runbook 10.12 |
| Đợt r15 — quyết toán API sàn + hạn STT (25/10/2026) | `python -m ingest.market_api --channel shopee\|tiktok --kind settlement --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]` (`ingest/settlement_api.py`; Shopee get_escrow_list/detail, TikTok statements 202309 + statement_transactions 202501 theo tài liệu chính thức — `evidence/itacc_r15_remaining/NGUON_TAI_LIEU.md`) → CÙNG sổ `settlement_rows` (`source_kind` csv\|api_live): ghi CHỈ khi Kế toán chốt `data/settlement_api_map.json` (repo: mọi quyết định null → `[blocked]` exit 2, 0 request) VÀ nguồn là API thật (TikTok cần `TIKTOK_API_ENV=live`); sandbox/server giả chỉ `--dry-run` (liệt kê thành phần CHƯA CHỐT/LẠ, 0 DB); CSV↔API cùng đơn → chặn (`settlement_csv.cross_source`; r15-fix1: dưới `settlement_csv.lock_orders` = advisory xact lock theo (kênh, đơn), câu ĐẦU transaction ghi ở CẢ CSV `main()` lẫn API `_write()` — chạy đồng thời chỉ 1 bên ghi) · r15-fix1: thành phần ĐÃ ánh xạ vào cột mà thiếu/null/"" (TikTok)/sai kiểu = lỗi dữ liệu, 0 dòng cả lượt — vắng = 0 CHỈ khi quyết định có `"khi_vang": "bang_0"` (Kế toán; cấm cho order_amount/payout); `settlement_api.check_rows` chặn cột None trước connect · Shopee đơn vị tiền theo TỪNG trường: `*_pri` ↔ `pri_currency`, trường thường ↔ `aff_currency`, response không mã ↔ `shopee.tien_te_shop` (null ở repo = chặn); chỉ VND, không quy đổi · `zalo_garden --transcribe`: `GARDEN_STT_TIMEOUT_S` bọc cả nạp model · bảng chờ `dau-vao-va-quyet-dinh.md` mục I |
| Fanpage tự thu (r16) | `python -m agents.ra_kenh --scan-auto [--dry-run]` có thêm nguồn Fanpage: `connectors/fanpage.py` Graph API v26.0 `GET /{page-id}/published_posts` (bài do CHÍNH Page đăng, chỉ id/message/created_time/permalink_url; tài liệu chính thức đọc 27/10/2026) — env `FANPAGE_PAGE_ID` + `FANPAGE_READ_TOKEN` (token đọc RIÊNG, không dùng chung Messenger; cả hai trống = chưa quét, vẫn `--file` CSV; thiếu một/sai dạng → exit 2), `FANPAGE_API_BASE` chỉ cho server giả; lỗi nguồn → ghi chú + exit 1 (web/listing vẫn nạp), legal_hr-04 TẮT → 0 request exit 2; không redirect, lỗi chỉ in HTTP + mã số (không URL chứa token); vá cold-check: tự thu (web + Fanpage) KẾ THỪA content_type/posted_on/is_ai/is_sponsored/sku từ snapshot NGƯỜI nạp (`--file`) gần nhất cùng URL; `draft_id` + `verify_publish` chỉ khi chữ CÙNG biểu diễn (cùng sha, hoặc Fanpage `message` = chữ bài — sửa sau duyệt vẫn `lech_ban_duyet`), web (tiêu đề + thân ≠ bản duyệt) MANG phán quyết `thieu_/lech_ban_duyet` của snapshot người — cùng bài thì hai đường cùng mã/mức (giới hạn: vi phạm chỉ ở tiêu đề web, trang sửa sau lần CSV chưa ra lech); Fanpage giữ chữ như CSV (không strip, > 20.000 ký tự bỏ); chưa có snapshot người → bài từ 12/10/2026 mở S2 `thieu_ban_duyet` (GĐ/Bên B quyết trước khi cấp token). CONTRACT_TESTED, CHƯA chạy Page thật |
| Cổng tắt + lỗi mạng còn sót (r17) | `python -m agents.ra_kenh --file F --by <tên>` / `--scan-auto`: legal_hr-04 TẮT → `[rollout]` exit 2 TRƯỚC mọi ghi (0 snapshot `channel_posts`, không đóng `da_sua`, 0 ticket) · `python -m ingest.settlement_csv --file F --channel K` / `market_api --kind settlement`: finance-01 TẮT → dòng quyết toán ĐÃ nạp + commit, KHÔNG đối soát, exit 2 (chặn một phần; chạy lại = `[skip]`, bật rồi `--reconcile`) · `http.client.HTTPException` (BadStatusLine/LineTooLong/quá 100 header) ở `market_api`, `anchor --submit/--upgrade`, `webhook_probe` → lỗi có kiểm soát (`market_api`: ApiError · `anchor --submit`: thử calendar kế, hết → dòng `loi` · `--upgrade`: thử calendar kế, hết → `cho` kèm lỗi, không ghi · `webhook_probe`: không sẵn sàng), không traceback |
| Nguồn hỏng + dry-run khi TẮT (r18) | `python -m agents.ra_kenh --scan-auto`: bài Fanpage / dòng crawl web có NUL hoặc surrogate lẻ (JSON `\u0000`/`\ud800`) ở chữ/URL, permalink có khoảng trắng/ký tự điều khiển → BỎ bài đó + ghi chú "bỏ N bài/dòng", bài khác + listing vẫn nạp (trước: `[err] DataError` exit 2 / traceback) · `--scan-auto --dry-run`, `--file F --by <tên> --dry-run` (legal_hr-04), `--partner-file F --by <tên> --dry-run` (marketing-04.2): tính năng TẮT → `[rollout]` exit 2, KHÔNG in kế hoạch, 0 request Fanpage (dry-run chỉ đọc sổ triển khai) · `python scripts/webhook_probe.py`: thân 200 là JSON không phải object hoặc lồng quá sâu → không sẵn sàng (exit 1 / cảnh báo đỏ như lỗi khác) |
| Ngày/JSON hỏng + cổng TẮT sớm (r19) | `python -m agents.ra_kenh --scan-auto`: dòng crawl web có `published_at` đúng dạng mà ngày không có thật (`2026-13-45`) → `posted_on` trống (coi như bài mới, như Fanpage), dòng JSON lồng quá sâu → "dòng n hỏng — bỏ" (trước: traceback, cả lượt chết) · tính năng TẮT → `[rollout]` exit 2 TRƯỚC connect/đọc nguồn/in/ghi, cả lượt thật lẫn `--dry-run`: `agents.kd_care --run\|--plan` (sales-07.2), `agents.kd_listing --run` (sales-03), `agents.mkt_koc --kit` (marketing-04.1), `agents.mkt_ugc --reviews\|--mentions\|--reuse-request\|--reuse` (marketing-05.2), `agents.seo_san --run` (marketing-07.1), `pipelines.legal_updates --submit` (legal_hr-07) (trước: dry-run in kế hoạch exit 0, lượt thật `[error]` exit 1 / `RolloutBlocked` lọt) |
| CI nghiệm thu chạy được (r20) | `.github/workflows/ci.yml` job `test` (F17.1): `ruff==0.16.10` GHIM trong `requirements.txt` (repo không cấu hình ruff — 0.17 đổi target mặc định 3.10→3.11 → `UP017` ×117 làm đỏ; nâng bản = có chủ đích, kiểm `ruff check --isolated --target-version <bản mới>` trước) · DB CI dựng ĐÚNG `tests/_db_guard._FIX` (`apply_schema.py --roles` ×2 + `ingest.core_store` + `ingest.golden_store`) trước `python -m pytest -q` — đổi preflight thì sửa ci.yml cùng lượt (drift-guard `tests/test_ci_workflow.py`) · `timeout-minutes` 240 (full suite đo local 46–173 phút) · `PyYAML` trong requirements (drift-guard không skip); PyMuPDF (AGPL, engine OCR tùy chọn) KHÔNG — test PDF `importorskip("fitz")` · thêm import ngoài `requirements.txt` vào test/mã CI chạy → CI ModuleNotFoundError: kiểm bằng giả lập môi trường CI (chặn module ngoài bao đóng phụ thuộc của requirements) — cách chạy ở đầu `evidence/cycle_r20_gate/fix1/ci_repro.sh.txt` (`setup` → `run <SP> <OUT> <SHA|work> shards sim` → `teardown`; `sim` = giả lập môi trường runner, đừng bỏ — bản vòng 1 `../ci_repro.sh.txt` không giả lập nên lọt BLOCKER `fitz`; chạy thật trên GitHub Actions cần push) · luật đường dẫn trong cấu hình phải độc lập OS (CI + server on-prem là Linux: `Path("C:/a.md")` không absolute) — dùng `PureWindowsPath` (ổ đĩa/UNC/gốc/`..` cả hai dấu tách) như `agents/mkt_koc.load_kocs` |
| Test/lint | `python -m pytest` · `ruff check .` |

## Structure
- `crawler/` — collect public site data → `data/*.jsonl`; `intel`
  thu tin thị trường RSS/Atom tầng A/B → `intel_items` (chỉ tiêu đề +
  trích ≤300 ký tự + link, không toàn văn; không ghi bảng khác)
- `connectors/` — adapters ra kênh ngoài (Zalo OA webhook, Messenger webhook
  v5.1); chỉ nhận/reply, KHÔNG đăng nội dung mới (human-gate C2.4).
  `channels.py` (v5.1) = lớp kênh THUẦN dùng chung: luật trước LLM (rượu →
  template, sức khỏe → handoff), luật kênh sàn (không domain/SĐT/link),
  đồng ý chat `chat_consents`, handoff `cskh_handoff`; text ở `data/channels.json`
- `ingest/` — chunk + embed + nạp chunks (`embed_store`); `core_store`
  nạp DB lõi WS1 (products/claims_approved/plots/plot_logs/orders/assets,
  delete-by-source idempotent — row `source='manual'` không bị đè; v15.5
  `products` upsert + `retired_at`, KHÔNG xóa → đơn thật giữ `product_id`,
  sự kiện → `product_sync_log`; products.jsonl thiếu/rỗng/hỏng → exit 1);
  `golden_store` nạp golden master (sku_master/sku_map/price_list
  append-only/golden_discrepancies — upsert, không xóa trắng, chỉ đọc
  products); `market_csv` nạp file xuất Seller Center vào staging
  (market_snapshots/market_rows/market_alerts — chỉ đọc golden, không
  ghi sàn/giá, không PII người mua); `intel_import` (v7.2) nạp file
  intel nhập tay (đối thủ/Google Trends/comment kênh sở hữu) vào 5 bảng
  intel v7.2 — không request mạng, chỉ đọc golden, bỏ cột định danh
  ghi sàn/giá, không PII người mua); `crm` (v5.2) kho liên hệ mã hóa
  `contacts` + `consents` append-only + `dealers` + gán lead theo 34 tỉnh
  (`data/vn_provinces_2025.json` GIẢ ĐỊNH, `data/dealer_regions.json` MẪU)
  — không gửi gì ra ngoài
- `pipelines/` — content draft + guardrail check (claim whitelist + banned words)
- `agents/` — agent báo cáo / GĐ khối; `sales_director` (v5.0) = agent GĐ
  Kinh doanh TMĐT, MẪU cấu hình thật cho 10 khối còn lại: nguồn thật →
  `approval_queue` (template, không nội dung khách), SLA giờ làm việc
  (`pipelines.period`), leo thang `sla_escalations`/`red_alerts`, bản tin
- `app/` — Streamlit demo (3 tab: Chat, Content Studio, Chưa trả lời)
- `data/` — jsonl dump, `claims_whitelist.json`, `banned_words.txt`
- `tests/` — pytest
- `TASKS.md` — task board M1–M5, boundary + gate + evidence từng task
- `SOW_SamSam_AI_6-thang.md` — SOW draft cũ, ĐÃ BỊ THAY THẾ bởi Hợp đồng hợp tác
  TEDO–Sâm Sâm (giữ làm lịch sử)

## Invariants
- **Guardrail trước content**: mọi text AI sinh ra phải qua `pipelines.guardrail.check()` trước khi hiển thị/đăng.
- Chatbot trả lời phải kèm nguồn (URL); không bịa công dụng y tế.
- Từ cấm tuyệt đối trong output: "chữa", "điều trị", "thuốc", "khỏi bệnh" — list đầy đủ ở `data/banned_words.txt`.
- Tài khoản/keys đọc từ `.env`; secret không vào code/git.
- Crawl delay ≥1s/request, chỉ trang public.
- PII khách (SĐT/tên/email/địa chỉ) chỉ nằm trong `contacts` dạng
  ciphertext (Fernet, khóa `CONTACT_VAULT_KEY`); bảng khác tham chiếu
  `contact_id`. Liên hệ marketing / chuyển PII cho đại lý chỉ khi
  `ingest.crm.can_contact()` True (mặc định False; `dai_ly` đích danh).

## Conventions
- Tiếng Việt trong docstring/comment khi giải thích business; code English.
- JSONL 1 dòng = 1 record, schema định nghĩa trong docstring module sinh ra nó.
- Commit message ngắn, tiếng Việt hoặc Anh đều được, nói "why".
- Vá bug theo idiom: trước khi đóng, grep cùng pattern trong repo — bug
  hay đi theo cụm (v0.5: `.content.strip()` None-crash ở cả `_standalone`
  LẪN `answer`; vá 1 bỏ 1 = nửa bug).
- Vá lớp lỗi điều-kiện-biên (guarding I/O): enumerate TẤT CẢ biến thể
  của điều kiện trước khi claim xong — file `missing` và file
  `0-record` (rỗng/`{}`/chỉ `_doc`) là 2 case khác nhau mà cùng bug
  "delete-trắng" (v1.8 tốn 2 vòng cold-check vì vá missing quên empty;
  còn `corrupt`/`partial-truncate` ở someday). Bonus: biến gán trong
  nhánh `exists()` → `UnboundLocalError` ở caller ngoài nhánh.

## Gotchas
- **`pytest` entry-script fail import** (`No module named 'pipelines'`) —
  không add cwd vào sys.path; luôn chạy `python -m pytest`.
- **Console Windows cp1258**: mọi file .py in tiếng Việt có dấu đều crash
  `UnicodeEncodeError` — KHÔNG chỉ scripts/: `connectors/zalo.py` (module,
  `python -m`) từng crash tại print fatal `DEPLOY=1` (v0.4, cold-audit
  bắt) làm flag-path chết câm. Mọi file mới có print tiếng Việt PHẢI có
  UTF-8 reconfigure guard sau imports (copy `scripts/zalo_mock.py`); khi
  THÊM print có dấu vào file chưa có guard thì thêm luôn guard.
- Timing test trên localhost Windows: wall-clock assert flake dưới load
  (đo 0.7–3.9s/POST lúc máy nặng) — assert event-based. Precedent:
  `test_ack_fast_while_reply_slow` vá ở v0.4.1 (reply block trên event,
  assert POST 200 trong khi reply còn block).
- Test server REJECT-sớm/đóng connection giữa client stream body
  (vd 411 chunked): httpx flake `ReadError` race client-side — dùng raw
  socket (precedent `test_chunked_post_rejected_411` v0.5.1).
- Regex match trên free text (`_PII_RE`, banned-words): phải trace case
  match-đứng-giữa-chuỗi-lớn-hơn cả 2 phía trước khi viết test —
  `0(?:[ .-]?\d){9,10}` bản đầu ăn giá "10.050.000.000" (thiếu `(?<!\d)`)
  và lộ đuôi số run dài (thiếu `{9,}` greedy). Reviewer bắt ở v0.5.1;
  test biên mẫu: `test_mask_pii_regex_boundaries`.
  - **Nới sep/lặp trong regex → trace case sep-run NỐI 2 token khác
    nhau** (range "A - B"), không chỉ single-token: v0.6.2 worker nới
    `[ .-]?`→`[ .-]*` → " - " (space+dash+space) nối "50.000.000" +
    "100.000.000" thành run ≥9 → mất cả khoảng giá/ngày (reviewer M1).
    Fix pattern: sep lặp phải CÙNG-ký-tự `(?:([ .-])\1*)?\d` — sep
    trộn không nối được. Vá cùng lớp lỗi ở MỌI alternative: reviewer
    chỉ flag alt `0...`, alt `+84/84` cũng bridging y hệt — vá cả 2
    + test "84 - 100.000.000". Test biên mẫu:
    `test_mask_pii_vn_prefix_and_multi_sep` (19 assert).
  - **Preprocess TRƯỚC regex cũng mở bridging** (v1.2, reviewer F1):
    `_mask_pii` normalize `(`/`)`→space để bắt SĐT ngoặc — space LÀ
    sep-class char nên `)(` thành space-run → "(1.500.000)(2.000.000)"
    nối thành run ≥9 → ăn cả 2 giá. Quy tắc: ký tự thay thế trong
    preprocess KHÔNG được thuộc sep class; vá đúng = unwrap chỉ nhóm
    toàn-digit `re.sub(r"\((\+?\d+)\)", r" \1 ", ...)` — ngoặc bọc
    non-digit giữ nguyên, `)` tự chặn bridge. Case phải test: giá/
    số đứng LIỀN nhau qua ngoặc `(X)(Y)`, không chỉ `(X) - (Y)`
    (sep trộn vốn đã chặn → test đó không bắt được lỗi).
  - **Vòng lặp re-regex toàn-văn mỗi vòng = quadratic DoS** (v1.4,
    cold-check MAJOR): fixpoint merge+unwrap trong `_mask_pii` chạy
    lại regex trên cả text mỗi iteration → `"("*5000 đốt >10s TRONG
    `_log_lock` (mọi reply thread xếp hàng). Inbound question tới
    1MB (MAX_BODY) không cap — `MAX_TEXT` chỉ áp outbound. Vá đúng:
    scanner 1-pass depth-counting (`_paren_group_end`) + rescan-budget
    `4n`, KHÔNG cap-vòng (cap → tail emit raw = vẫn leak, trái comment
    "không sai" — reviewer bắt). Vá DoS phải grep cùng cụm: email-alt
    `[\w.+-]+@` trong cùng `_PII_RE` cũng quadratic → bound RFC
    `{1,64}`/`{1,63}`. Khi thêm regex/loop trên input attacker-
    controlled: probe pathological (nest-N, char-run, budget-abort)
    trước khi claim xong.
- Đọc/ghi file log do user ảnh hưởng nội dung (convlog/jsonl): dùng
  BYTES + split `\n` tường minh — `splitlines()` cắt U+2028/\x85/\x1c
  làm đôi record, `read_text` strict crash trên byte lỗi (dòng ghi dở),
  `write_text` trên Windows đổi `\n`→`\r\n`. Rewrite phải atomic:
  tmp + `os.replace` (precedent `_purge_convlog` v0.5.1).
- Retention/expiry impl chỉ gắn vào event hiếm (startup/rotate) → process
  chạy lâu giữ data quá hạn vô hạn — không đạt intent "không nằm lại
  >N ngày". Cần trigger định kỳ rẻ (precedent: purge daily-on-write trong
  `_log_conversation`, `_last_purge` throttle).
- Test data chứa ký tự vô hình (U+2028, ZWSP...) → viết escape
  (`"a\u2028b"` + `ensure_ascii=False` khi cần raw char trong output);
  KHÔNG nhúng literal vào source — vô hình khó review + edit tool fail
  match (vấp v0.5.1).
- Print/log chứa identifier (user_id, SĐT...) phải qua `_uhash()`/
  `_mask_pii()` ngay tại chỗ print — kể cả sửa code cũ. Reviewer v0.6
  bắt: `[handoff]` print mới + `send_text`/guardrail warn cũ cùng lộ
  raw user_id ra stdout (invariant "không log id thật" áp cho CẢ
  stdout, không chỉ convlog).
- Hai kênh share semantics (zalo `_histories` ↔ streamlit history cho
  `answer()`) phải parity cấu trúc: cùng lưu raw answer, cùng bỏ lượt
  flagged. Streamlit v0.6 lưu display text (HANDOFF_TEXT) vào history —
  lệch hành vi follow-up. Render-model (`messages`) tách khỏi
  history-model.
- Decode file jsonl/log: chỉ REWRITE round-trip (purge) mới dùng
  `surrogateescape`; READER hiển thị (`unanswered()`) phải
  `errors="replace"` — lone surrogate `\udcXX` crash
  `st.dataframe`/pyarrow UTF-8 encode.
- Vá 1 flaky test theo class (wall-clock → event): grep `time.sleep`
  toàn suite vá cùng pattern — `test_dedup_same_msg_id` sót lại sau
  v0.4.1, flake thật ở v0.6 ship-pass (sleep-0.3s trước assert
  `got==["u1"]` — thread dispatch chậm dưới load → `[]`).
- Runtime/state file mới trong `data/` (`conversations.jsonl`,
  `zalo_seen.db`, `zalo_tokens.json`...) — gitignore NGAY khi thêm
  (có user_hash/PII-adjacent/secret).
- **`.env*` file write bị policy chặn** (kể cả `.env.example`/
  `.env.sample`, scope grant cũng deny) — template env dùng
  `env.example` không-dot (v1.0).
- **Module-global mutable mới trong `zalo.py`** (`_last_refresh`,
  `_last_purge`...) phải reset trong fixture `_isolated_files` —
  state sót lại theo thứ tự test (v1.0: `_last_refresh` từ test
  refresh trước làm test sau thấy "fresh" giả, retry không refresh).
  Khi thêm global mới vào cùng nhóm, rà luôn global CŨ cùng vùng có
  đang leak không — `_last_purge` tồn tại từ v0.5.1 nhưng chưa từng
  reset, leak câm tới v1.3 mới lộ (worker vá kèm V4.1).
- **Subagent chạy gate nặng trên máy này**: lệnh >~10s bị tool exec tự
  đẩy xuống background — subagent có thể chạy chồng nhiều pytest nếu
  không poll tới exit (cold-check v1.3: auditor chạy chồng 2-3 pytest,
  may không BSOD). Prompt cho worker/reviewer chạy gate phải ghi rõ:
  "lệnh nặng có thể bị đẩy nền — PHẢI đọc output tới khi process exit
  trước khi chạy lệnh nặng kế tiếp; không retry mù khi chưa lấy được
  output".
  Test cho state-on-disk: isolate bằng monkeypatch đường dẫn → `tmp_path`
  (xem `_isolated_files` trong `tests/test_zalo.py`), KHÔNG `clear()`
  structure in-memory như khi state còn là dict.
- DONE.md someday có thể chứa entry ĐÃ VÁ ở version trước (stale — ví dụ
  "verify_signature bypass" sót lại sau D4.2, supervisor v0.4.1 bắt):
  trước khi pick someday item làm, grep code chứng minh nó còn hỏng;
  khi đóng version, rà someday xem mục nào thực ra version này đã vá.
- **Nhánh CHỦ ĐỘNG thêm vào flow đã có throttle** (proactive refresh/
  purge/retry): phải gate bằng cùng attempt-throttle của nhánh reactive
  (`_last_refresh`) — không throttle = oauth sập thì MỌI send đều gọi
  API 15s-timeout (reviewer v1.1 F1). Field từ API ngoài thiếu/≤0
  (`expires_in`) → ghi sentinel "không biết" (`expires_at=0`), KHÔNG
  ghi giá trị suy ra (`now()+0` làm `_token_expiring_soon` luôn đúng →
  mọi send đều rotate). Race "đang refresh song song vs vừa fail" →
  phân biệt bằng `with _token_lock: pass` (chờ in-flight xong) rồi đọc
  lại `_last_refresh_ok`.
- **Fallback in-memory cho state-on-disk** (vd `_mem_tokens`): chỉ tồn
  tại trong cửa sổ persist-FAIL, xoá ngay khi persist OK — giữ mem sau
  persist-ok sẽ đè ghi của process khác (preflight --refresh, operator
  sửa tay) = regression "store không còn source-of-truth" (cold-check
  v1.1 F1). Rebind nguyên tử `_mem = tokens`, không `clear()+update()`
  (reader không qua lock thấy dict rỗng giữa chừng).
- **Background worker chết giữa lane** (connection-error, không phải
  tool-deny): verify `git diff` — nếu phần đã viết sạch (chỉ khai báo)
  thì coordinator absorb phần còn lại theo spec, đừng respawn mù
  (v1.1: worker viết được consts+docstring rồi chết; absorb + reviewer
  vẫn bắt 2 MAJOR concurrency).
- **Viết test/source chứa escape `
` qua exec heredoc/`python -c`**
  — escape bị xử lý 2 lần, `
` thành CR/LF literal -> source
  "unterminated string literal". Cách an toàn đã verify (v1.6/v1.7):
  viết đoạn code vào FILE TẠM bằng write tool rồi `cat tmp >> file`
  hoặc python ghép theo index — không nhúng raw-socket test vào
  heredoc.
- **Đổi key/format trong test cũ** (vd dedup `u1:follow` -> `follow:u1`
  v1.7): block replace dễ làm MẤT assert coverage cuối test (v1.7
  cold-check MINOR — `age("u1:m1")`+assert cleanup bị xoá kèm). Sau
  khi sửa test cũ, diff lại đối chiếu số assert trước/sau.
- `samsam.net.vn` là NukeViet (HTML render phức tạp); `samsamngoclinh.com` là
  WooCommerce — **thử WP REST API `/wp-json/wp/v2/...` trước**, dễ hơn parse HTML.
- Embedding lưu `float8[]` — nếu sau này cài được pgvector thì đổi cột + index,
  code retrieve tách hàm riêng để swap dễ.
- Nội dung sâm hay bị phóng đại trên web — guardrail phải filter cả data ingest.
- **psycopg `connect()` không timeout mặc định** (v1.9): UI có nhánh
  "DB unavailable → st.info" vẫn HANG cả tab khi host unreachable —
  browser test timeout mãi dù code có fallback. Mọi connect cho
  dashboard/CLI phải truyền `connect_timeout=<giây>`; nhánh fallback
  phải verify E2E bằng host chết thật (spawn server với env
  `DATABASE_URL` giả, KHÔNG sửa `.env`) — test mock `connect()→None`
  không bắt được hang chờ TCP.
- **Playwright MCP ghi file theo root workspace KHÁC repo** (v1.9: root
  = `D:\code\btc`, evidence png suýt rơi nhầm repo). Chụp evidence →
  dùng Python Playwright trực tiếp với path tuyệt đối vào repo, hoặc
  verify allowed-root trước; sau đó `git status` kiểm không có file lạc.
- **Streamlit/deps nặng KHÔNG cài global khi interpreter dùng chung
  thiếu** (v1.9): `pip install streamlit` kéo protobuf 7.x phá env
  (conflict google-*/paddle) — verify UI bằng venv tạm (`python -m venv`
  + install tối thiểu), xong bỏ; không sửa `requirements.txt` vì mục
  đích test. `st.dataframe` render canvas → `page.inner_text()` không
  chứa cell values: assert UI bằng screenshot/data-state, không grep
  text DOM; print page-text về console cũng crash cp1258.
- **File lạ trong `git status`** (vd `lv2-market-top.png` ở v1.9 — ảnh
  project khác): xác minh nguồn trước khi stage; artifact không liên
  quan giữ untracked, stage file theo danh sách tường minh không `add -A`.
- **Hàm tự `conn.commit()` bên trong (`red_alert.raise_alert`,
  `aq.enqueue`) KHÔNG bọc được trong `with conn.transaction()`** (psycopg
  cấm commit trong transaction block) — ghi nhiều bảng "cùng tx" thì để
  câu trước chạy trên implicit tx rồi hàm đó commit cả cụm, lỗi →
  `conn.rollback()` (v5.0 `sweep`). Fake conn test có `rollback()` no-op
  KHÔNG chứng minh được nhánh rollback — `_TxConn(sp=...)` rollback về
  savepoint (`tests/test_sales_director.py`).
- **Khóa idempotent "đã đẩy ở bất kỳ status" theo id dòng nguồn** (v5.0
  nghiệm thu MAJOR): nguồn REOPEN cùng dòng (`market_alerts` upsert
  status→open + `opened_at` mới) → đợt tái phát bị nuốt câm. Khóa phải
  theo ĐỢT (`ma:<id>:<opened_at UTC>`). Cùng lớp: hành động "cuối đời"
  (leo thang trước expire) chỉ gắn vào trạng thái pending → mục bị
  expire bởi đường khác/lễ/cron chết thoát leo thang — chọn ứng viên theo
  "chưa có dòng leo thang" kể cả đã expired (có cửa sổ). Nguồn do KHÁCH
  điều khiển (convlog, sticker) → gom theo khách/ngày + trần mỗi lần chạy
  + gộp cảnh báo đỏ/lần quét — 1 tin ≠ 1 cảnh báo. Nhưng gom vẫn phải
  theo ĐỢT (vòng 3 nghiệm thu MINOR): nhóm đã có mục ĐÃ QUYẾT thì câu hỏi
  SAU `decided_at` mở đợt mới (`cskh:<nhóm>:<ts đầu đợt>`), chỉ mục
  PENDING mới nuốt tin dồn — 'seen ở mọi status' = câu chiều bị câm SLA.
- **`env -u DATABASE_URL` KHÔNG phải nhánh "DB down"** (v2.0):
  `lead_store.connect()` tự `load_dotenv(ROOT/.env)` nạp lại DSN thật
  (load_dotenv không override biến đang có, nhưng biến đã -u thì trống
  → .env lấp vào). Muốn nhánh connect→None: set `DATABASE_URL` trỏ
  host chết (vd `postgresql://u@10.255.255.1:5432/x`) khi spawn
  process, hoặc monkeypatch `connect` trong test.
- **`with conn.transaction()` trên conn ĐÃ trong tx chỉ là SAVEPOINT**
  (v2.1, UI E2E bắt): conn đã chạy SELECT (implicit tx mở) → block
  transaction() release savepoint, KHÔNG commit — `conn.close()`
  rollback tx ngoài → INSERT mất khỏi DB dù `returning id` vẫn trả
  id (UI hiện "đã ghi" ảo). CLI conn mới thì transaction() là
  outermost → commit đúng — fake-conn unit test KHÔNG bắt được, chỉ
  E2E lộ. Ghi-tác-vụ trên conn chia sẻ phải `conn.commit()` tường
  minh sau block (no-op khi conn mới). Dấu hiệu phụ: sequence id
  nhảy cách (id đốt bởi insert rollback).
- **Streamlit KHÔNG reload imported module** (v2.1): rerun chỉ chạy
  lại file script; module đã import (`agents/garden.py`) giữ bản cũ
  trong `sys.modules` — sửa module import phải RESTART streamlit
  server mới verify được (probe fail "fix không tác động" vì server
  đang chạy code cũ). `st.date_input` có thể trả None khi user xoá
  ngày → guard trước `datetime.combine`.
- **Reviewer/subagent quota-exhausted giữa cycle** (v2.0): cold-check
  không spawn được → coordinator tự audit adversarial (đọc diff + chạy
  lại gate + probe claim) và ghi rõ "coordinator self-review" trong
  DONE/STATUS/ledger — precedent v0.3/v0.5; không giả vờ có auditor lạ.
  Profile `reviewer` cạn nhưng `subagent_general` còn → spawn general
  với prompt audit + "READ-ONLY" tường minh vẫn là auditor lạ hợp lệ
  (v2.2 — đợt 1 bắt được MAJOR thật).
- **f-string format-spec trên biến CHƯA coerce** (v2.2 cold-check
  MAJOR): `f"{day:%Y-%m-%d}"` crash `ValueError` khi `day` là str —
  CLI luôn truyền str còn test chỉ cover `date` object → lọt. Luật:
  format-spec chỉ đặt trên biến ĐÃ coerce (output `_coerce_*`), và
  test boundary phải cover đúng kiểu caller thật truyền (CLI = str).
- **CLI nhiều flag cùng lúc → op sau nuốt câm** (v2.2 MINOR): chuỗi
  if/elif `--approve`/`--reject`/`--schedule` chỉ chạy op đầu. Luật:
  đếm `n_ops` toàn cục, `>1` → `ap.error` usage-exit-2 TRƯỚC khi
  connect DB — kể cả combo đọc+đọc (`--pending --calendar`).
- **Nút "lưu" đọc từ session_state trong Streamlit** (v2.2 MINOR):
  không pop kênh đã lưu khỏi `st.session_state.last_drafts` →
  re-click nhân đôi draft trong DB. Luật: sau save thành công phải
  mutate session-state (pop từng kênh `_saved`, giữ kênh lỗi để
  retry) — bản ghi DB là side-effect không tự rollback theo rerun.
- **`evidence/*.log` bị `*.log` gitignore**: file evidence .log phải
  `git add -f` mới vào commit (quy ước "evidence commit vào repo" —
  file m2_*/v0*.log cũ đều tracked qua force-add).
- **Regex veto/filter trên text tự do**: (a) span greedy nuốt cả
  occurrence SAU → lazy `{0,n}?` + chặn qua dấu câu cụm `[^.?!,;]`;
  (b) quyết veto theo "key còn sót sau `re.sub`" thay `search()` —
  "trồng ở đâu bán ở đâu" phải giữ 'ở đâu' hỏi-địa-điểm (v2.4
  cold-check MINOR, `_WHERE_INFO_RE`).
- **Keyword-flag KHÔNG quét tên-vocab** — vocab chứa chính keyword:
  `flags_for(activity, detail)` quét `activity` → 'kiểm tra sâu bệnh'
  ∋ 'sâu bệnh' flag MỌI routine pest-check, nhiễu cảnh báo thật
  (audit-bù v2.1 MAJOR). Flag chỉ quét `detail`; giữ param cho
  caller-compat. Cùng lớp: test khóa hành-vi-xấu → vá phải FLIP test.
- **Mix date local + giờ UTC** (date_input local + `now(UTC)`) sinh
  ts tương-lai giả cho user VN+7 vào buổi sáng → default `date_input`
  ngày UTC + warn dung sai 1 ngày (re-audit v2.4 MINOR).
- **Drift-guard test assert substring id ngắn** (`"Q1" in body`) ăn ké
  id dài ('Q10') — mất Q1 test vẫn xanh. Dùng word-boundary
  `re.search(rf"\bQ{n}\b")` / `(?<!\w)name(?!\w)` cho tên thực thể
  (v2.3 audit-bù MINOR).

- **Traceback pytest in DSN có mật khẩu** (v4.5 reviewer MAJOR: fixture
  `live` fail → DSN `postgresql://postgres:<pass>@...` lọt vào
  `v45_pytest.log`). Output pytest ghi evidence phải pipe qua
  `sed -E 's#(postgres(ql)?://[^:]+:)[^@]+@#\1***@#g'`; trước `git add -f`
  grep evidence `postgres(ql)?://[^ ]*:[^*@]+@` và `sk-or` phải rỗng.
- **Full pytest 1 tiến trình ~47 phút trên máy RAM trống thấp → tiến trình con
  0xC0000142** (26/10: 73 failed giả, 0 thuộc code). Chạy CHIA LƯỢT: mỗi lượt
  một `python -m pytest` mới, cùng thứ tự file `--collect-only`, cùng DB test,
  cộng tổng = số collect (27/10: 11 lượt × ~600 ca → 6984/6984, 0×0xC0000142;
  runner `evidence/cycle_r15_gate/run_shards.sh.txt`). Không bắt phụ thuộc thứ
  tự chéo lượt. Thư mục lạ chưa theo dõi ở gốc repo (vd `output/`) làm đỏ
  `test_data_flow_map::test_every_egress_module_declared` — dời ra ngoài trước gate.
- **Hai đường nạp CÙNG một thực thể (CSV người ↔ tự thu) — test bằng ĐÚNG biểu diễn mỗi đường sinh ra**
  (r16, 2 vòng cold-check FIX): vá "tự thu kế thừa cột từ snapshot người" test với CSV và tự thu CÙNG chữ →
  xanh, trong khi `web_rows` luôn ghép tiêu đề + thân → `draft_id` kế thừa đem so byte (`verify_publish`) luôn
  lệch → `lech_ban_duyet` giả, đúng triệu chứng bản vá tuyên bố đã hết. Luật: cột nào phụ thuộc biểu diễn (so
  byte/sha) chỉ kế thừa khi cùng biểu diễn, còn lại mang PHÁN QUYẾT của đường người; ca kiểm = chạy xen kẽ ≥4
  lượt với chữ đúng như hàm dựng dòng thật → 0 ticket / 0 `channel_post_fixed` / hạn không đặt lại. Kèm: ghi
  `\r\n` vào tài liệu .md qua script Python thành xuống dòng THẬT (DONE.md r16) — Gotcha escape áp cả tài liệu.
- **Ngưỡng phụ thuộc OS/interpreter trong test** (r18 cold-check BLOCKER): ca `b"[" * 4096` chờ `RecursionError`
  chỉ đúng trên Windows (giới hạn đệ quy decoder JSON CPython 3.12: Windows 3000, Linux 10000 → Linux ra
  `JSONDecodeError`). Test giới hạn tài nguyên/độ sâu phải chấp nhận MỌI kết cục hợp lệ của các hệ, và ép nhánh
  lỗi hiếm bằng monkeypatch (vd hàm parse ném `RecursionError`) thay vì trông vào ngưỡng của máy. CI Linux là nơi
  duy nhất bắt được — mà CI `main` đang dừng ở bước `ruff check .` nên pytest Linux chưa chạy (DONE r18 someday 5;
  r20 vá ở local, chờ push mới có lượt runner đầu).
- **Tái hiện CI phải khớp CẢ tập gói LẪN ngữ nghĩa OS của runner** (r20, 3 vòng cold-check, mỗi vòng 1 lỗi chỉ-runner):
  vòng 1 tái hiện bằng môi trường dev (~250 gói ngoài `requirements.txt`) che `import fitz` không guard trong test;
  vòng 2 giả lập gói (`ci_env_sim`) vẫn chạy Windows nên `Path("C:/a.md").is_absolute()` (False trên Linux) lọt.
  Luật: test import gói ngoài requirements → `importorskip`; kiểm đường dẫn cấu hình/đầu vào → `PureWindowsPath`
  (chặt nhất) cho MỌI OS; tái hiện CI dùng `fix1/ci_repro.sh.txt ... sim`, không bỏ `sim`. Kèm (vận hành máy chung):
  dọn tiến trình theo PID mình tạo, KHÔNG lọc theo chuỗi dòng lệnh — `-match 'ci_repro'` (không phân biệt hoa thường)
  đã dừng nhầm `grep.exe` của session khác.
