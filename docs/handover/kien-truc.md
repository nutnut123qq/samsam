# Kiến trúc hệ thống — Sâm Sâm AI (bản pilot)

**Dành cho ai:** người vận hành kỹ thuật, đội dự án bàn giao, kỹ thuật
phía công ty khi tiếp nhận.
**Làm việc gì:** bản đồ toàn hệ thống — luồng dữ liệu, module, bảng DB,
agent, và các điểm NGƯỜI phải duyệt (human-gate).
**Cần gì:** đọc cùng `sop.md` (vận hành) + `AGENTS.md` (chi tiết lệnh,
invariants, gotchas cho dev).

Stack: Python 3.12 · Postgres local (embedding `float8[]`, cosine bằng
numpy — chưa cần pgvector) · OpenRouter (1 key cho chat + embeddings,
qua `openai` client trỏ base_url `https://openrouter.ai/api/v1`) ·
Streamlit demo.

## 1. Luồng dữ liệu tổng

```
┌─ KNOWLEDGE BASE (chatbot RAG) ────────────────────────────────────
│  site public samsam ──> crawler.collect ──> data/*.jsonl
│        (products / articles / about / news; delay ≥1s, public only)
│            │
│            ├─> ingest.embed_store ──> bảng chunks (embed float8[])
│            └─> ingest.core_store ──> DB lõi (products, claims_approved,
│                                        plots, plot_logs, orders, assets)
│
├─ CHAT (2 kênh vào) ────────────────────────────────────────────────
│  tab "Chat Sâm Sâm" (streamlit) ─┐
│  Zalo OA webhook (connectors.zalo :8788) ─┤
│        └─> api.rag.answer(): embed câu hỏi → cosine top-8 chunks
│            (score < 0.25 hoặc không có hit → "Chưa đủ dữ liệu để trả lời.")
│            → LLM trả lời + nguồn URL
│            → pipelines.guardrail.check() trước khi hiển thị/gửi
│        └─> ghi convlog data/conversations.jsonl (mask PII)
│                  └─> ingest.lead_store ──> bảng leads (intent mua hàng)
│                  └─> queue "Chưa trả lời" (answered:false) → nhân viên
│
├─ CONTENT (WS2) ────────────────────────────────────────────────────
│  brief (tab "Content Studio") ──> pipelines.content draft()/draft_multi()
│      (system prompt: brand voice + whitelist claim + CHANNEL_HINT theo
│       kênh facebook/tiktok/zalo/blog; vi phạm → 1 lượt viết lại)
│      ──> guardrail.check() BẮT BUỘC trước khi trả text
│      ──> "Lưu vào hàng duyệt" ──> bảng content_drafts (pending)
│      ──> NGƯỜI duyệt (tab "Duyệt & Lịch" / pipelines.store)
│          approve CHỈ khi guardrail ok ──> approved ──> xếp lịch
│          ──> NGƯỜI đăng tay lên kênh (hệ thống KHÔNG đăng)
│
├─ VƯỜN (WS3) ───────────────────────────────────────────────────────
│  NGƯỜI ghi (tab "Nhật ký vườn" / agents.garden CLI) ──> plot_logs
│      (chuẩn hóa hoạt động + cảnh báo: gap ngày / keyword sâu bệnh)
│
└─ BÁO CÁO (WS3) ────────────────────────────────────────────────────
   agents.report: DB lõi + convlog ──> data/reports/report-*.md
   (BẢN NHÁP — NGƯỜI duyệt + gửi lãnh đạo; DB chết vẫn ra bản degraded)
```

## 2. Module theo thư mục

| Thư mục/file | Vai trò |
|---|---|
| `crawler/` | `collect` — crawl site public → `data/*.jsonl` (delay ≥1s/request); `intel` (v7.0) — thu tin thị trường RSS/Atom tầng A/B → bảng `intel_items` (robots.txt, ≥1s/host, chặn cứng tầng C + sàn/MXH kể cả qua redirect, chỉ tiêu đề + trích ≤300 ký tự) |
| `ingest/` | `embed_store` (chunk+embed→`chunks`), `core_store` (nạp DB lõi, delete-by-source idempotent), `lead_store` (convlog→`leads`, insert-only) |
| `api/` | `rag.py` — `answer()` RAG: retrieve top-8 `chunks` bằng cosine numpy → LLM + nguồn; `NO_DATA` khi score thấp |
| `pipelines/` | `guardrail.py` (banned words + claim whitelist + chặn rượu, chuẩn hóa NFC/casefold/ký tự chèn — `check()` trước mọi output AI; v4.1 `check_publish()` luật đăng bài theo kênh/loại: XNQC/readiness, câu khuyến cáo, nhãn AI/quảng cáo, "Ngọc Linh" — luật trong `data/guardrail_rules.json`, chưa nối luồng duyệt tới v4.2), `content.py` (draft đa kênh), `store.py` (hàng duyệt + lịch `content_drafts` — chuyển trạng thái qua function DB), `auth.py` (đăng nhập + 6 vai trò × tab, v3.4), `llm_gateway.py` (cổng LLM duy nhất: PII mask, privacy routing, kill/cap, `llm_usage`), `pii.py`, `period.py` (kỳ ngày/tuần/tháng giờ VN — nguồn duy nhất, v4.0), `approval_queue.py` (hàng duyệt dùng chung mọi loại việc trừ content_draft, v4.0), `director.py` (mẫu agent GĐ khối: gom việc → bản tin, cấu hình `data/directors/<khối>.json`, v4.0), `red_alert.py` (cảnh báo đỏ tới người nhận độc lập, v4.0), `scenario.py` (v7.3 — engine kịch bản mùa THUẦN dùng chung cho KD-A10 dự báo mùa / SX-A3 phân bổ tồn / FP-Cash 13 tuần: baseline SKU×kênh×tuần × xu hướng × hệ số 11.11/12.12/Tết 2027 → khoảng thấp/cơ sở/cao; rượu = 0 kênh online; giả định `data/scenario_assumptions.json`) |
| `connectors/` | `zalo.py` — webhook Zalo OA: verify signature, ACK 200 nhanh rồi reply async, dedup msg_id, token store + auto-refresh; **chỉ reply inbox** |
| `agents/` | `report.py` (báo cáo định kỳ → file md), `garden.py` (nhật ký vùng trồng + cảnh báo), `garden_director.py` (v9.3 — Agent GĐ vùng trồng: bản tin tuần, nhắc lịch/gap, kiểm hash chain, gỡ dữ liệu mẫu có người ký), v9.5 cơ khí: `ck_mat.py` (tra cứu tài liệu kỹ thuật MẬT hoàn toàn local — BM25, không LLM/mạng), `cmms.py` (sổ máy/bảo trì/sự cố + nhắc đến hạn), `co_khi.py` (năng lực đóng gói GIẢ ĐỊNH + checklist điện/mạng điểm live) — không LLM, không tự gửi |
| `app/` | `streamlit_app.py` — UI 7 tab (mục 4) |
| `scripts/` | `apply_schema.py`, `data_audit.py`, `eval_qa.py`, `zalo_mock.py`, `zalo_preflight.py`, `persona_sim.py` (v7.3 — nghiên cứu giả lập persona tổng hợp 3 model × 3 prompt × ≥5 lần qua `llm_gateway` agent `persona_sim`, có đối chứng yếu, ghi `sim_runs`; cổng DPIA `data/sim_config.json`), `garden_media.py` (v9.3 — kho tư liệu vườn, gỡ EXIF/GPS) |
| `data/` | jsonl nguồn, `claims_whitelist.json`, `banned_words.txt`, convlog + token/seen (runtime, gitignored) |
| `tests/` | pytest (`python -m pytest`) |

## 3. Cơ sở dữ liệu — 35 bảng public (`docs/schema.sql`)

| Bảng | Chứa | Nguồn nạp |
|---|---|---|
| `chunks` | Chunk văn bản + embedding `float8[]` cho RAG (`doc_id`,`chunk_index`,`source_url`,`title`,`lang`,`content`,`embedding`) | `ingest.embed_store` — incremental theo `doc_sha256` (v3.9: chỉ embed doc đổi, `doc_version`/`ingested_at`, xóa doc gỡ khỏi nguồn đọc được, lọc rượu) — corpus CÔNG KHAI duy nhất của chatbot khách |
| `chunks_internal` | Tài liệu NỘI BỘ đã duyệt theo phòng (`collection` `internal:<phong>`, `approved_by` bắt buộc, `doc_sha256`/`doc_version`) — bảng RIÊNG, `answer()` không có đường đọc | `python -m ingest.kb_internal --file ... --collection internal:<phong> --approved-by <trưởng phòng>` (CHỈ người thật duyệt) |
| `products` | Sản phẩm (`id`,`name`,`price_vnd` null→"Liên hệ",`url`,`lang`) | `core_store` từ products.jsonl + nhập tay |
| `claims_approved` | Công dụng ĐÃ CÔNG BỐ theo SKU — nguồn sự thật guardrail (`sku_key`,`claim` null="chưa công bố") | `core_store` từ `claims_whitelist.json` |
| `plots` | Khoảnh vùng trồng (`id` vd 'KV-A01',`location`,`tree_count`,`status`) | `sample_plots.jsonl` (MẪU) + nhập tay |
| `plot_logs` | Nhật ký vùng trồng (`plot_id` FK→plots,`ts`,`activity`,`detail`,`author`) + **hash chain** (v9.3) `prev_hash`→`row_hash` cho mọi dòng KHÔNG mẫu — trigger INSERT tính hash, dòng đã chain không UPDATE/DELETE/TRUNCATE được (kể cả cascade khi xóa khoảnh); dòng `sample:%` ngoài chuỗi. Kiểm: function `verify_plot_logs()` (`python -m agents.garden_director --verify`) | `agents.garden` `source='manual:garden'` + sample (loader giữ khoảnh mẫu còn nhật ký đã chain/ảnh; sau khi gỡ mẫu không nạp lại) |
| `orders` | Đơn hàng tối thiểu (`channel`,`product_id`,`qty`,`total_vnd`,`status`) — không PII | `sample_orders.jsonl` (MẪU) + nhập tay |
| `assets` | Tài sản truyền thông (`kind` image/video/article/doc,`url`,`product_id`) | `core_store` từ products.images + jsonl |
| `leads` | Lead từ convlog (`dedup_key` unique,`channel`,`user_hash`,`question` đã mask,`intent`,`status`) | `ingest.lead_store` — insert-only, không xóa |
| `content_drafts` | Hàng duyệt + lịch đăng (`brief`,`channel`,`text`,`guardrail` jsonb snapshot,`status`,`reviewer`,`scheduled_date`, `created_by` người/agent tạo — v3.4, null = draft cũ không duyệt được) | `pipelines.store` / Studio — INSERT pending; đổi trạng thái CHỈ qua function `approve_draft`/`reject_draft`/`schedule_draft` |
| `llm_usage` | 1 dòng/lời gọi LLM-embedding (`ts`,`agent_id`,`model`,`tokens_in/out`,`cost_usd` ước tính,`ok`,`error` đã mask) — không lưu prompt | `pipelines.llm_gateway` — insert-only; trần chi phí tháng theo agent đọc từ đây |
| `sku_master` | Golden SKU (v3.2) — nguồn sự thật DUY NHẤT listing/pháp lý: `category` tpbvsk/food/alcohol, `pack_spec`, số+ngày giấy tiếp nhận, `xnqc_status`, `self_declaration_ok`, `allowed_channels`, `version` | `ingest.golden_store` từ `data/golden_skus.json` — upsert, giữ row `manual`; Pháp chế xác nhận pháp lý |
| `sku_map` | Map `products.id` (crawl) ↔ `sku_key` golden — KHÔNG FK products; `approved_by` | `golden_store` (đề xuất agent) — Sản xuất duyệt |
| `price_list` | Giá theo SKU × kênh × `kind` floor/list/promo, `valid_from/valid_to`, `approved_by` — **APPEND-ONLY** (trigger chặn UPDATE giá/DELETE/TRUNCATE và INSERT sẵn-duyệt/sẵn-đóng; đổi giá = đóng dòng cũ + dòng mới chờ duyệt) | `golden_store` nạp `approved_by=null`; GĐ bán hàng duyệt bằng CLI |
| `approvals` | (v3.4) Mỗi quyết định duyệt/từ chối 1 dòng: `object_type`,`object_id`,`content_sha256` (sha256 text ĐÚNG lúc duyệt),`decision`,`approved_by`,`approved_at`,`db_role` — **APPEND-ONLY** (trigger chặn UPDATE/DELETE/TRUNCATE) | Chỉ function duyệt (SECURITY DEFINER) ghi; `verify_publish` so bản phát hành với sha đã duyệt |
| `agent_action_log` | (v3.4) Nhật ký hành động agent/người (`actor`,`action`,`object_*`,`detail` jsonb,`db_role`) + **hash chain** `prev_hash`→`row_hash` — APPEND-ONLY; trigger INSERT ép id/ts/db_role/hash | `save_draft` (`draft_create`) + function duyệt/xếp lịch; kiểm: `python -m pipelines.store --verify-log` |
| `approval_queue` | (v4.0) Hàng duyệt DÙNG CHUNG mọi loại việc của agent nhân viên (CẤM `content_draft` — giữ đường v3.4): `object_type`,`object_id`,`block` (khối),`payload` + `content_sha256` (trigger ép = sha payload, BẤT BIẾN),`risk`,`guardrail` snapshot,`qa_status`,`created_by`,`due_at` (SLA),`status` pending→approved/rejected/expired MỘT lần,`lane` auto_policy/per_item,`decided_by` — không DELETE/TRUNCATE | Chỉ function: `enqueue_item` (agent), `decide_item` (người), `auto_approve_item` (luật đã ký), `expire_overdue`; CLI `python -m pipelines.approval_queue` |
| `auto_policies` | (v4.0) Luật tự duyệt theo loại: `max_risk` CHỈ `low` (CHECK), bật phải có `signed_by`+`signed_at` — ship RỖNG (chủ khối ký = external-dep) | Chỉ owner DB ghi |
| `decisions` | (v4.0) `override_qa` (ép trình bản QA FAIL: lý do ≥10 ký tự + người ≠ người tạo) và `expired` (hết SLA, không ai duyệt) — APPEND-ONLY | Function `override_qa` / `expire_overdue` |
| `channel_snapshots` | (v4.0) Số liệu kênh theo kỳ (`channel`,`metric_id`,`period_kind` day/week/month,`period_start`,`value`,`source` manual_export/api,`captured_by`) — unique theo kỳ+nguồn; cho cockpit sau này | agent_writer INSERT (nhập tay từ file xuất / API) |
| `red_alerts` | (v4.0) Cảnh báo đỏ (`source_agent`,`title`/`detail` đã mask PII,`recipients`,`route_error` khi thiếu người nhận độc lập) — APPEND-ONLY: role `app_human` không có quyền sửa/xóa + trigger chặn UPDATE/DELETE/TRUNCATE khi trigger còn bật (owner vẫn `DISABLE TRIGGER`, superuser vẫn `session_replication_role = replica` được); DB đóng dấu `ts`/`db_role` | `pipelines.red_alert.raise_alert` (agent); TGĐ/ha_tang KHÔNG xóa/sửa được CHỈ KHI kết nối bằng DSN `app_human` — không được giữ DSN owner/superuser (xem Giới hạn pilot dưới) |
| `golden_discrepancies` | Phiếu lệch golden ↔ crawl (`kind`, `detail` giá trị theo từng nguồn, `status` pending/resolved/dismissed) — agent không chọn giá | `golden_store` dựng lại mỗi lần nạp; người xử lý cập nhật `status` |
| `market_snapshots` | 1 dòng/file xuất Seller Center đã nạp (v3.3): `channel` shopee/tiktok, `export_kind` listing/order/ads, `file_name` (basename), `file_sha256` UNIQUE (nạp lại cùng file = bỏ qua), `row_count` | `ingest.market_csv --file` — insert-only |
| `market_rows` | Dòng staging từ file sàn: `item_id`,`seller_sku`,`sku_key` (map golden, null = không map),`title`,`price_vnd`,`stock`,`status`,`ads_spend_vnd`,`qty`,`order_id_hash` (sha256, KHÔNG mã đơn gốc), `raw` jsonb CHỈ field allowlist — không cột tên/SĐT/địa chỉ người mua | `market_csv` — cột PII bỏ ngay khi đọc file |
| `market_alerts` | Cảnh báo sàn ↔ golden (`kind` alcohol_listed/tpbvsk_ads_no_xnqc S1, price_mismatch/item_unmapped S2; `detail` giá trị theo từng nguồn; `status` open/closed) — agent không sửa sàn/giá | `market_csv` mở/đóng theo export kế tiếp; `--report` cho người đọc |
| `eval_runs` | 1 dòng/lần nghiệm thu 1 agent tại 1 commit (`commit_sha`,`agent`,`n_total`,`n_pass`,`pass_rate`,`threshold`,`passed`,`model`,`prompt_version`) — `<sha>-dirty` = chạy trên tree bẩn, không mở deploy | `scripts/agent_eval.py` (CI/local) — insert-only; `scripts/deploy_gate.py` đọc row mới nhất |
| `job_runs` | 1 dòng/lần chạy job lịch (`job`,`started_at`,`finished_at`,`ok`,`detail` đã mask cắt 300,`host`) — bản tin sức khỏe đọc để báo job lỗi/không chạy | `pipelines.job_runs.job_run` (bọc `__main__` của `agents.report`, `ingest.lead_store`) — insert-only |
| `documents` | Tài liệu số hóa (`sha256` PK = tên bản gốc bất biến `originals/<sha256>`,`doc_type`,`pages`,`text_source` pdf_text/ocr/none,`pii_flag`,`status` cho_ocr/pending_review/verified/rejected,`verified_by`) — KHÔNG lưu full text | `ingest.doc_intake` — insert-only theo hash; status verified/rejected chỉ do Pháp chế qua CLI `--verify/--reject --by` |
| `garden_media` | (v9.3) Kho tư liệu vườn: `sha256` UNIQUE (tên file trong kho NGOÀI repo `<sha[:2]>/<sha>.<ext>`),`ext` jpg/png,`bytes`,`width`,`height`,`plot_id` FK→plots (no action),`taken_on`,`author`,`exif_removed`,`had_gps` — ảnh đã gỡ TOÀN BỘ EXIF/GPS; KHÔNG cột tọa độ/đường dẫn/tên file gốc | `python scripts/garden_media.py --file .. --plot .. --date .. --by ..` (`GARDEN_MEDIA_DIR` ngoài repo) |
| `document_fields` | Field pháp lý trích bằng regex (`so_giay`,`ngay_cap`,`ten_san_pham`; `confidence`,`verified` mặc định false) | `ingest.doc_intake` — không LLM; `verified=true` khi Pháp chế `--verify` |
| `sim_runs` | (v7.3) Nghiên cứu giả lập persona TỔNG HỢP: 1 dòng = 1 lời gọi LLM (`model`,`provider`,`model_version`,`prompt_id`,`prompt_hash`,`sample_idx`,`temperature`,`seed`,`seed_supported`) × 1 phương án (`option_id`,`is_control` đối chứng yếu,`score` 0..10 hoặc null,`parse_ok`,`guardrail_ok`) + `run_id`,`run_date`,`persona_set`/`persona_set_hash`,`dry_run` — KHÔNG PII, KHÔNG văn bản LLM thô | `scripts/persona_sim.py` — insert-only; chạy thật chỉ sau DPIA ký, `--dry-run` = số giả |
| `intel_items` | (v7.0, WP09) Tin thị trường tầng A/B: `url` chuẩn hóa UNIQUE, `domain`, `source` (id nguồn), `tier` A/B, `title`/`snippet`/`summary` ≤300 ký tự (đã che SĐT/email), `published_at`, `content_sha256` UNIQUE, `topics` (≥1: sam/tpbvsk/gioi_tre/quang_cao/doi_thu), `flags` (`ruou`/`suc_khoe`/`llm_guardrail_fail`) — KHÔNG toàn văn, không cột body | `python -m crawler.intel --run` — insert-only, dedup url + hash nội dung; không ghi bảng khác |
| `machines` | (v9.5 CK-A2) Sổ máy điện–cơ khí (`code` PK dạng `SS-EQ-NN`,`name`,`location`,`maker`,`year`, cờ+hạn kiểm định / hiệu chuẩn phương tiện đo, `ho_so_gmp`,`active`) — không xóa, thôi dùng = `active=false` | `python -m agents.cmms --add-machine` / `--retire` (sổ máy thật = external-dep) |
| `maintenance_plans` | Kế hoạch bảo trì theo chu kỳ (`machine_code` FK,`task`,`interval_days`,`major`,`start_on`,`last_done_on/by`,`last_approved_by`) — hạn kế = `coalesce(last_done_on,start_on)+interval_days` | `agents.cmms --add-plan` / `--done <id> --on --by [--approved-by]` (việc `major`/máy GMP bắt buộc Kỹ sư trưởng duyệt); `--due` nhắc đến hạn |
| `incidents` | Sự cố máy (`started_at`,`ended_at`,`downtime_phut`,`part`,`description` ĐÃ mask PII,`root_cause` mặc định 'chờ xác nhận',`reported_by` MÃ nhân sự) + view `downtime_log` (sự cố đã đóng, cho CK-A5) | `agents.cmms --incident` |

View (v3.2): `sku_readiness` (SKU × kênh online → `CAM` / `MO_TA` /
`TP_THUONG` / `QC_DAY_DU`; rượu luôn `CAM`, kênh ngoài `allowed_channels`
`CAM`, thiếu dữ liệu `CAM`) và `v_promotable` (readiness `TP_THUONG`/
`QC_DAY_DU` VÀ có giá `list` đã duyệt đang hiệu lực) — rỗng tới khi người
thật duyệt. Lệnh: `python -m ingest.golden_store` (nạp), `--report` (phiếu
lệch + giá chờ duyệt), `--approve-price <id> --by <tên>` (CHỈ người thật).

Quy ước chung: mọi bảng lõi có cột `source` = file/nguồn nạp; loader
`core_store` chỉ delete+insert rows thuộc nguồn của mình → row nhập tay
an toàn. `leads`/`content_drafts` KHÔNG delete-by-source (dữ liệu người
tạo / fact suy ra một lần). Apply: `python scripts/apply_schema.py`
(idempotent, toàn `create ... if not exists` + `create or replace function`;
ngoại lệ duy nhất `alter table content_drafts add column if not exists
created_by`). `--roles` chạy thêm `docs/roles.sql` (mục 6b).

## 4. Giao diện — Streamlit `app/streamlit_app.py` (7 tab)

| # | Tab | Chức năng |
|---|---|---|
| 1 | Chat Sâm Sâm | Hỏi/đáp RAG trên KB — câu trả lời kèm nguồn; NO_DATA → text handoff + vào queue |
| 2 | Content Studio | Nhập brief → sinh draft đa kênh (guardrail từng kênh) → "Lưu vào hàng duyệt"; ô check text tay |
| 3 | Chưa trả lời | Queue convlog `answered:false` cho nhân viên follow-up |
| 4 | Leads | Dashboard convlog (file-based, hiện cả khi DB chết) + bảng `leads` — read-only |
| 5 | Báo cáo | Sinh/xem báo cáo `data/reports/` — BẢN NHÁP người gửi |
| 6 | Nhật ký vườn | Form ghi `plot_logs` + panel "Cần chú ý" + nhật ký gần nhất |
| 7 | Duyệt & Lịch | Hàng duyệt `content_drafts` — người duyệt = người đăng nhập (không gõ tên); Duyệt disabled khi vi phạm / vai trò không được duyệt / chính mình tạo draft; xếp lịch theo vai trò + calendar 14 ngày |

Tab hiện theo vai trò đăng nhập (mục 6b) — tab không được phép KHÔNG
được tạo (code tab đó không chạy, không query DB).

Mọi tab có DB đều degrade nhẹ: DB chết → `st.info` "Chưa nạp", không
crash (mọi connect qua `ingest.lead_store.connect`, `connect_timeout=3`).

## 5. Agents (WS3 — chạy theo lịch, không LLM)

| Agent | Lệnh | Làm gì |
|---|---|---|
| Báo cáo định kỳ | `python -m agents.report [--days N] [--until YYYY-MM-DD]` | Tổng hợp orders/leads/convlog/plot_logs → `data/reports/report-*.md`; gắn nhãn *(mẫu)* khi nguồn toàn `sample:*`; DB chết → bản DEGRADED |
| Nhật ký vùng trồng | `python -m agents.garden --plot .. --activity ..` / `--check [--gap-days N]` | Ghi `plot_logs` (chuẩn hóa hoạt động theo `ACTIVITY_VOCAB` + alias) + cảnh báo no-logs/gap/keyword (`FLAG_KEYS` chung với report) |
| GĐ vùng trồng (v9.3) | `python -m agents.garden_director --bulletin [--until YYYY-MM-DD]` / `--remind` / `--verify` / `--precheck` / `--purge-sample --by "<GĐ vùng trồng>"` / `--adopt-plot <id> --by` | Bản tin tuần tất định `data/reports/garden-week-<until>.md` (toàn vẹn chuỗi, mẫu còn lại, nhắc lịch/gap theo `data/garden_schedule.json` — GIẢ ĐỊNH, nhật ký mới, cảnh báo keyword CHỈ trên detail, ảnh mới; mỗi mục kèm SQL đối chứng). Gỡ mẫu CHỈ người thật qua `--by` → ghi `agent_action_log` |
| Kho tư liệu vườn (v9.3) | `python scripts/garden_media.py --file .. --plot .. --date .. --by ..` | Gỡ EXIF/GPS/XMP (dựng lại ảnh từ pixel), lưu ngoài repo theo sha256, metadata `garden_media` |

Lập lịch định kỳ: Task Scheduler/cron chạy hai lệnh trên — report
idempotent theo kỳ (cùng kỳ → cùng tên file ghi đè).

## 6. Human-gate — các điểm NGƯỜI bắt buộc (invariant C2.4)

| Điểm | Hệ thống làm | NGƯỜI làm |
|---|---|---|
| Duyệt content | Guardrail check lúc sinh + chạy LẠI trên text trước khi duyệt; chuyển trạng thái chỉ qua function DB `approve_draft` (SECURITY DEFINER: guardrail ok, có người tạo, **người duyệt ≠ người tạo**); mỗi quyết định ghi `approvals` kèm sha256 nội dung; `schedule_draft` từ chối nếu text đã sửa sau duyệt; mọi bước ghi `agent_action_log` hash chain | Duyệt/từ chối từng bài (identity đăng nhập) + note |
| Đăng bài | `scheduled_date` + calendar là kế hoạch | Copy text đã duyệt, đăng tay lên kênh |
| Báo cáo lãnh đạo | Sinh file markdown BẢN NHÁP | Đọc/duyệt/sửa rồi gửi Zalo/email tay |
| Nhật ký vườn | Chuẩn hóa + cảnh báo bất thường; hash chain chặn sửa/xóa | Ghi nhật ký tay; báo quản lý khi có cảnh báo; sai thì ghi dòng MỚI kèm lý do |
| Gỡ dữ liệu mẫu vườn | `--precheck` liệt kê blocker; agent KHÔNG tự gỡ | GĐ vùng trồng chạy `--purge-sample --by "<tên>"` (ghi `agent_action_log`); blocker nhật ký đã chain (không chuyển được) → `--adopt-plot <id> --by` nhận khoảnh thành khoảnh thật (`garden_plot_adopt`) |
| Zalo OA | Chỉ TRẢ LỜI tin nhắn đến (reply), không chủ động nhắn, không đăng OA | — |
| Hàng duyệt dùng chung (v4.0) | Agent nhân viên đẩy việc qua `director.submit` (SLA/rủi ro theo cấu hình khối) → `approval_queue`; 2 lớp: `auto_policy` (mặc định TẮT/rỗng, chỉ rủi ro low + QA pass + chủ khối ký) và `per_item` (người, **người duyệt ≠ người tạo**, guardrail ok, kiểm lại payload); quá SLA → `expired` (KHÔNG BAO GIỜ tự duyệt); QA FAIL muốn trình phải `override_qa` có lý do + người; `red_alerts` append-only, người nhận độc lập (không TGĐ/ha_tang), thiếu → ghi `route_error` (fail-closed); bản tin GĐ khối là file BẢN NHÁP | Duyệt/từ chối/override từng mục (`--by`); chủ khối ký auto_policy; Pháp chế xác nhận người nhận cảnh báo đỏ (external-dep) |
| Bổ sung KB/claim | `core_store`/`embed_store` nạp lại khi được chạy | Soạn file nguồn + chạy lệnh nạp |
| Giả định kịch bản mùa (v7.3) | `pipelines.scenario` tính khoảng thấp/cơ sở/cao từ `data/scenario_assumptions.json` (`status` "GIẢ ĐỊNH — chờ GĐ KD/Tài chính chốt"; baseline là fixture) — không phải doanh số cam kết | GĐ KD/Tài chính chốt hệ số + 3 mức, đổi `status`; GĐ bán hàng cấp số bán thật |
| Nghiên cứu giả lập persona (v7.3) | `scripts/persona_sim.py` từ chối chạy thật (exit 2) khi `data/sim_config.json` `dpia_signed` khác `true`; báo cáo khoảng p10/p50/p90 có nhãn "KHÔNG phải dự báo doanh số" | Pháp chế + TGĐ ký DPIA/TIA rồi NGƯỜI đổi `dpia_signed`; Quản lý MXH duyệt báo cáo, TGĐ/BKS đồng ký biên bản |

## 6b. Phân quyền & đăng nhập (v3.4)

**Role DB** (`docs/roles.sql`, NOLOGIN — login user thật do hạ tầng tạo
`in role ...`, external-dep):

| Role | Được | Không được |
|---|---|---|
| `agent_writer` (agent AI) | SELECT `content_drafts`; INSERT draft 6 cột (`brief`,`channel`,`text`,`guardrail`,`source`,`created_by` → luôn `pending`); INSERT log 5 cột | UPDATE/DELETE mọi bảng (không tự duyệt được — `permission denied`), `approvals`, bảng khác, function duyệt |
| `app_human` (người: Streamlit/CLI) | Kế thừa `agent_writer` + SELECT `approvals`/`agent_action_log` + EXECUTE `approve_draft`, `reject_draft`, `schedule_draft`, `verify_publish`, `verify_action_log` | UPDATE/DELETE trực tiếp |
| `agent_writer` — thêm v4.0 | EXECUTE `enqueue_item`, `auto_approve_item` (fail-closed khi không có luật đã ký), `expire_overdue`; SELECT `approval_queue` CHỈ cột metadata (KHÔNG `payload`/`guardrail`/sha — payload 11 khối chỉ người đọc) + `decisions` (bản tin GĐ khối); INSERT `red_alerts` 5 cột (+ SELECT `id` cho RETURNING), `channel_snapshots` 8 cột | `decide_item`, `override_qa`, UPDATE/DELETE mọi bảng, `auto_policies` |
| `app_human` — thêm v4.0 | SELECT `approval_queue` (đủ cột, gồm `payload`)/`auto_policies`/`channel_snapshots`/`red_alerts` + EXECUTE `decide_item`, `override_qa` | UPDATE/DELETE trực tiếp (TGĐ/ha_tang qua `app_human` KHÔNG xóa/sửa được cảnh báo đỏ; trigger chặn DML của owner khi còn bật, KHÔNG chặn owner tắt trigger/superuser replica) |

Giới hạn pilot: máy local vẫn chạy bằng DSN owner — chặn quyền chỉ có
hiệu lực khi app/agent dùng DSN theo role. CHƯA chuyển DSN Streamlit/agent
sang role: `roles.sql` chỉ cấp 3 bảng trên → dưới role, Streamlit mất
`chunks`/`leads`/`plot_logs`... (tab Chat/Leads/Báo cáo/Nhật ký vườn gãy)
và agent mất `llm_usage` (trần chi phí LLM tắt câm vì `_month_spend` lỗi =
cho qua). DSN role hiện chỉ dùng cho tiến trình duyệt/ghi draft riêng (CLI
`pipelines.store`); grant đủ bảng theo plan §5 = external-dep/someday
(SOP mục 9). `--by` CLI vẫn free-text (tin người giữ DSN `app_human`);
xóa dòng CUỐI log không phát hiện được bằng chuỗi thuần (cần neo ngoài).
Cảnh báo đỏ (`red_alerts`) cũng vậy: "TGĐ/ha_tang không xóa được" chỉ đúng
khi họ dùng DSN `app_human`; owner bảng `ALTER TABLE red_alerts DISABLE
TRIGGER ...` rồi DELETE, superuser `set session_replication_role = replica`
— hôm nay Quản lý hạ tầng AI giữ DSN owner. Yêu cầu khi chuyển DSN theo
role: TGĐ và ha_tang KHÔNG giữ DSN owner/superuser (người khác giữ, vd
Pháp chế/BKS); neo ngoài chống xóa (object-lock/WORM) = external-dep.

**Đăng nhập Streamlit** (`pipelines/auth.py`, biến `AUTH_MODE`) — fail-closed:
trống/lạ = chặn; `proxy` = email từ header
`Cf-Access-Authenticated-User-Email` (Cloudflare Access — chỉ an toàn khi
bind 127.0.0.1 sau proxy); `local` = user/mật khẩu scrypt trong
`data/users.json` (gitignored), sai 5 lần khóa 5 phút; `dev` = không đăng
nhập, cấm khi `DEPLOY=1`.

6 vai trò × tab (ĐỀ XUẤT — TGĐ chốt):

| Vai trò | Tab | Duyệt | Xếp lịch |
|---|---|---|---|
| `tgd` | cả 7 tab | có | có |
| `phap_che` | Chat Sâm Sâm, Content Studio, Chưa trả lời, Báo cáo, Duyệt & Lịch | có | — |
| `gd_ban_hang` | Chat Sâm Sâm, Chưa trả lời, Leads, Báo cáo | — | — |
| `gd_marketing` | Chat Sâm Sâm, Content Studio, Leads, Báo cáo, Duyệt & Lịch | có | có |
| `mxh` | Chat Sâm Sâm, Content Studio, Chưa trả lời, Leads, Duyệt & Lịch | — | có |
| `ha_tang` | Chat Sâm Sâm, Chưa trả lời, Báo cáo, Nhật ký vườn | — | — |

## 7. Guardrail — 2 lớp (áp cho MỌI text AI sinh)

1. **Banned words** (`data/banned_words.txt`): match có dấu/không dấu,
   case-insensitive; miễn span nằm trong claim đã duyệt hoặc disclaimer
   pháp lý ("không phải là thuốc...").
2. **Claim whitelist** (`data/claims_whitelist.json`): clause chứa động
   từ claim (giúp/hỗ trợ/giảm/bồi bổ...) mà không khớp claim đã công
   bố của SKU đang nhắc → `unverified_claim`. Claim của SKU A gán cho
   SKU B vẫn vi phạm (pool theo SKU).

`check(text) → {"ok","violations","matched_claims"}` — không raise;
thiếu file config → `ok=False` violation "config". Áp ở: `api.rag`
output (trước hiển thị/gửi), `pipelines.content` (lúc sinh + snapshot
vào `content_drafts.guardrail`), connector Zalo (trước send).

## 8. File state trên đĩa (đừng xóa — chi tiết `sop.md` mục 6)

`data/conversations.jsonl` (rotate `.1` >5MB, purge >30d) ·
`data/zalo_tokens.json` (token hiện hành, gitignored) ·
`data/zalo_seen.db` (dedup msg_id TTL) · `data/reports/` ·
`_histories` in-memory (mất khi restart — chấp nhận).

## 9. Giới hạn pilot (đọc trước khi hứa thêm)

- KB chỉ data public; "trợ lý tri thức nội bộ" cần data công ty bàn giao
  (SOW §5.2) — hiện là external-dependency.
- `orders`/`plots`/`plot_logs` = dữ liệu MẪU `sample:*` — báo cáo gắn
  nhãn *(mẫu)* rõ ràng.
- Social metrics (Fanpage/TikTok/Zalo OA insights) = mục "chờ bàn giao"
  trong báo cáo — creds thuộc Phụ lục C.
- Leads UI read-only (update status bằng SQL); intent là heuristic
  keyword — sẽ refine khi có data thật.
- Embedding `float8[]` + cosine numpy: đủ cho KB hiện tại (~nghìn
  chunk); khi data lớn → pgvector (điểm đổi đã ghi trong `schema.sql`).
