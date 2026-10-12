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
│                        └─> ingest.crm (NGƯỜI chạy, --by): gán tỉnh/đại lý,
│                            trạng thái; PII → contacts (mã hóa), đồng ý →
│                            consents; --handoff in payload cho NGƯỜI chuyển
│                            (PII chỉ khi consent dai_ly đích danh)
│                  └─> queue "Chưa trả lời" (answered:false) → nhân viên
│
├─ CONTENT (WS2) ────────────────────────────────────────────────────
│  brief (tab "Content Studio") ──> pipelines.content draft()/draft_multi()
│      (system prompt: brand voice + whitelist claim + CHANNEL_HINT theo
│       kênh facebook/tiktok/zalo/blog; vi phạm → 1 lượt viết lại)
│      ──> guardrail_llm.check_publish_llm(kênh) BẮT BUỘC trước khi trả
│          text (luật đăng bài + LLM-check phụ chỉ chặn thêm, v4.2)
│      ──> "Lưu vào hàng duyệt" ──> bảng content_drafts (pending)
│      ──> NGƯỜI duyệt (tab "Duyệt & Lịch" / pipelines.store)
│          approve CHỈ khi guardrail ok + chạy LẠI check_publish_llm
│          (kênh draft, readiness view sku_readiness) ──> approved ──> lịch
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
| `ingest/` | `embed_store` (chunk+embed→`chunks`), `core_store` (nạp DB lõi, delete-by-source idempotent), `lead_store` (convlog→`leads`, insert-only), `intel_import` (v7.2 — nạp file NHẬP TAY: giá đối thủ, Google Trends xuất tay, export comment/inbox kênh sở hữu → 5 bảng intel v7.2; không request mạng, chỉ đọc golden), `crm` (v5.2: kho liên hệ mã hóa + đồng ý theo mục đích + gán lead theo tỉnh/đại lý — không gửi gì ra ngoài) |
| `api/` | `rag.py` — `answer()` RAG: retrieve top-8 `chunks` bằng cosine numpy → LLM + nguồn; `NO_DATA` khi score thấp |
| `pipelines/` | `guardrail.py` (banned words + claim whitelist + chặn rượu, chuẩn hóa NFC/casefold/ký tự chèn — `check()` trước mọi output AI; v4.1 `check_publish()` luật đăng bài theo kênh/loại: XNQC/readiness, câu khuyến cáo, nhãn AI/quảng cáo, "Ngọc Linh" — luật trong `data/guardrail_rules.json`, chưa nối luồng duyệt tới v4.2), `content.py` (draft đa kênh), `store.py` (hàng duyệt + lịch `content_drafts` — chuyển trạng thái qua function DB), `auth.py` (đăng nhập + 6 vai trò × tab, v3.4), `llm_gateway.py` (cổng LLM duy nhất: PII mask, privacy routing, kill/cap, `llm_usage`), `pii.py`, `period.py` (kỳ ngày/tuần/tháng giờ VN — nguồn duy nhất, v4.0), `approval_queue.py` (hàng duyệt dùng chung mọi loại việc trừ content_draft, v4.0), `director.py` (mẫu agent GĐ khối: gom việc → bản tin, cấu hình `data/directors/<khối>.json`, v4.0), `red_alert.py` (cảnh báo đỏ tới người nhận độc lập, v4.0), `cockpit.py` (v8.0 — chụp số điều hành kỳ ĐÃ ĐÓNG vào `channel_snapshots`: số nội bộ từ DB/convlog + nạp CSV `manual_export` kênh ngoài; từ điển `data/metrics.json`; insert-only), `scenario.py` (v7.3 — engine kịch bản mùa THUẦN dùng chung cho KD-A10 dự báo mùa / SX-A3 phân bổ tồn / FP-Cash 13 tuần: baseline SKU×kênh×tuần × xu hướng × hệ số 11.11/12.12/Tết 2027 → khoảng thấp/cơ sở/cao; rượu = 0 kênh online; giả định `data/scenario_assumptions.json`), `--ack` ghi `red_alert_acks`; không gửi/liên hệ ai), `readiness` map view DB do caller truyền, vá homoglyph/emoji/khoảng trắng), `guardrail_llm.py` (v4.2: lớp LLM-check phụ `check_publish_llm` — agent `guardrail_llm`, chỉ CHẶN THÊM, lỗi → `llm_check_unavailable` fail-closed) |
| `connectors/` | `zalo.py` — webhook Zalo OA: verify signature, ACK 200 nhanh rồi reply async, dedup msg_id, token store + auto-refresh; **chỉ reply inbox** |
| `agents/` | `report.py` (báo cáo định kỳ → file md), `ceo_report.py` (v8.0 — báo cáo tuần/tháng 1 trang cho TGĐ từ `channel_snapshots`: so kỳ trước, mọi số do code điền, preflight cảnh báo đỏ, nhận xét LLM chỉ placeholder — mặc định tắt; `--submit` vào hàng chờ khối ceo), `garden.py` (nhật ký vùng trồng + cảnh báo), `garden_director.py` (v9.3 — Agent GĐ vùng trồng: bản tin tuần, nhắc lịch/gap, kiểm hash chain, gỡ dữ liệu mẫu có người ký), v9.5 cơ khí: `ck_mat.py` (tra cứu tài liệu kỹ thuật MẬT hoàn toàn local — BM25, không LLM/mạng), `cmms.py` (sổ máy/bảo trì/sự cố + nhắc đến hạn), `co_khi.py` (năng lực đóng gói GIẢ ĐỊNH + checklist điện/mạng điểm live) — không LLM, không tự gửi |
| `app/` | `streamlit_app.py` — UI 7 tab (mục 4) |
| `scripts/` | `apply_schema.py`, `data_audit.py`, `eval_qa.py`, `zalo_mock.py`, `zalo_preflight.py`, `persona_sim.py` (v7.3 — nghiên cứu giả lập persona tổng hợp 3 model × 3 prompt × ≥5 lần qua `llm_gateway` agent `persona_sim`, có đối chứng yếu, ghi `sim_runs`; cổng DPIA `data/sim_config.json`), `garden_media.py` (v9.3 — kho tư liệu vườn, gỡ EXIF/GPS); `intel_bulletin.py` (v7.1 — bản tin thị trường ngày/tuần theo 5 chủ đề + cảnh báo đỏ mở + nguồn lỗi → `data/reports/intel-bulletin-*.md` BẢN NHÁP; tóm tắt LLM chỉ khi `llm.enabled` + guardrail; khối trích nguồn không có đường sang `content_drafts`; `--suggest` đẩy gợi ý chủ đề `intel_topic` vào `approval_queue` cho Quản lý MXH duyệt), `intel_weekly.py` (v7.2 — báo cáo tuần intel Markdown tất định, chỉ đọc), `redteam.py` (v4.2 PC-A9: bộ red-team cố định `data/eval/redteam.jsonl` trong CI + `--generate` biến thể bằng model khác họ qua gateway agent `redteam`) |
| `data/` | jsonl nguồn, `claims_whitelist.json`, `banned_words.txt`, convlog + token/seen (runtime, gitignored) |
| `tests/` | pytest (`python -m pytest`) |

## 3. Cơ sở dữ liệu — 44 bảng public (`docs/schema.sql`)

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
| `leads` | Lead từ convlog (`dedup_key` unique,`channel`,`user_hash`,`question` đã mask,`intent`,`status` new/contacted/qualified/won/lost; v5.2 thêm `contact_id`,`province`,`dealer_code`,`assigned_by/at`) | `ingest.lead_store` — insert-only, không xóa; gán/trạng thái qua `python -m ingest.crm --assign/--status ... --by <tên>` |
| `contacts` | (v5.2) Kho liên hệ (contact_vault): `phone_enc`/`name_enc`/`email_enc`/`address_enc` = ciphertext Fernet (DB check chặn plaintext), `phone_hmac` HMAC có khóa để tra trùng, `province` — bảng khác chỉ giữ `contact_id` | `python -m ingest.crm --add-contact - --by <tên>` (JSON qua stdin, cần `CONTACT_VAULT_KEY`) |
| `dealers` | (v5.2) Đại lý: `code`,`name`,`region`,`status` active/paused/ended,`commission_default` (rượu online luôn 0 ở code) — hiện là dữ liệu MẪU | `python -m ingest.crm --load-dealers --by <tên>` từ `data/dealer_regions.json` (dòng `source='manual'` không bị đè) |
| `consents` | (v5.2) Đồng ý theo mục đích `cskh`/`marketing`/`dai_ly` (dai_ly ĐÍCH DANH `recipient_dealer`), grant cần `evidence_ref`+`policy_version` — **APPEND-ONLY** (rút = dòng mới) | `python -m ingest.crm --consent <id> --purpose P --grant\|--withdraw --source S --by <tên>`; view `v_consent_current` (dòng mới nhất theo `id`) |
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
| `channel_snapshots` | (v4.0) Số liệu kênh theo kỳ (`channel`,`metric_id`,`period_kind` day/week/month,`period_start`,`value`,`source` manual_export/api,`captured_by`) — unique theo kỳ+nguồn. v8.0 cockpit: `pipelines/cockpit.py` ghi INSERT-ONLY (INSERT thường, trùng khóa → giữ bản cũ, số đã chụp không bị ghi đè; role đọc được sổ thì khác giá trị = conflict). Số nội bộ: `channel='noi_bo'`, `source='api'` (= máy đọc; CHECK chỉ cho manual_export/api), nguồn thật ở `source_ref` (`db:<bảng>` / `file:conversations.jsonl`); số kênh ngoài: `source='manual_export'`, `source_ref` = `<file>#sha256:<12 hex>` (`sample:` = số MẪU). Từ điển metric `data/metrics.json`; `agents/ceo_report.py` đọc. Chatbot (convlog giữ 30 ngày): kỳ có đầu kỳ quá 30 ngày → không chụp (thiếu ≠ 0) | agent_writer INSERT 8 cột — `store()` INSERT thường + savepoint từng dòng (không ON CONFLICT/RETURNING vì 2 thứ đó đòi SELECT): `--import` bằng agent_writer chỉ nạp được file toàn dòng mới (trùng khóa → `unverified`, không so được giá trị → CSV fail-closed hủy cả file exit 1, kể cả file y nguyên); `--collect` cần đọc leads/approvals/market_alerts/job_runs/llm_usage → hiện chạy DSN chủ sở hữu; `agents/ceo_report.py` đọc → app_human (SELECT; role chỉ-đọc riêng = someday) |
| `red_alerts` | (v4.0) Cảnh báo đỏ (`source_agent`,`title`/`detail` đã mask PII,`recipients`,`route_error` khi thiếu người nhận độc lập) — APPEND-ONLY: role `app_human` không có quyền sửa/xóa + trigger chặn UPDATE/DELETE/TRUNCATE khi trigger còn bật (owner vẫn `DISABLE TRIGGER`, superuser vẫn `session_replication_role = replica` được); DB đóng dấu `ts`/`db_role` | `pipelines.red_alert.raise_alert` (agent); TGĐ/ha_tang KHÔNG xóa/sửa được CHỈ KHI kết nối bằng DSN `app_human` — không được giữ DSN owner/superuser (xem Giới hạn pilot dưới) |
| `red_alert_acks` | (v7.1, WP09) Người xác nhận cảnh báo đỏ intel gốc (`alert_id` UNIQUE → `red_alerts`, `acked_by`, `acked_at` do DB đặt, `note`) — APPEND-ONLY (trigger chặn UPDATE/DELETE/TRUNCATE); chưa có dòng sau 2 giờ → leo thang 1 cấp. `red_alerts` thêm 2 unique index partial (1 cảnh báo/tin, 1 leo thang/cảnh báo) | `python -m pipelines.intel_alert --ack ID --by "Tên"` — CHỈ `app_human` INSERT 3 cột; `agent_writer` không có quyền (agent không tự xác nhận) |
| `golden_discrepancies` | Phiếu lệch golden ↔ crawl (`kind`, `detail` giá trị theo từng nguồn, `status` pending/resolved/dismissed) — agent không chọn giá | `golden_store` dựng lại mỗi lần nạp; người xử lý cập nhật `status` |
| `market_snapshots` | 1 dòng/file xuất Seller Center đã nạp (v3.3): `channel` shopee/tiktok, `export_kind` listing/order/ads, `file_name` (basename), `file_sha256` UNIQUE (nạp lại cùng file = bỏ qua), `row_count` | `ingest.market_csv --file` — insert-only |
| `market_rows` | Dòng staging từ file sàn: `item_id`,`seller_sku`,`sku_key` (map golden, null = không map),`title`,`price_vnd`,`stock`,`status`,`ads_spend_vnd`,`qty`,`order_id_hash` (sha256, KHÔNG mã đơn gốc), `raw` jsonb CHỈ field allowlist — không cột tên/SĐT/địa chỉ người mua | `market_csv` — cột PII bỏ ngay khi đọc file |
| `market_alerts` | Cảnh báo sàn ↔ golden (`kind` alcohol_listed/tpbvsk_ads_no_xnqc S1, price_mismatch/item_unmapped S2; `detail` giá trị theo từng nguồn; `status` open/closed) — agent không sửa sàn/giá | `market_csv` mở/đóng theo export kế tiếp; `--report` cho người đọc |
| `eval_runs` | 1 dòng/lần nghiệm thu 1 suite (`data/eval/suites/<agent>.json`) tại 1 commit (`commit_sha`,`agent`,`n_total`,`n_pass`,`pass_rate`,`threshold`,`passed`,`model` = model agent thật,`prompt_version`; v4.5 thêm `judge_model`,`suite_version`,`suite_sha256`,`threshold_sha256`,`owner_block`,`failed_cases`) — `<sha>-dirty` = chạy trên tree bẩn, không mở deploy | `scripts/agent_eval.py` (CI/local) — insert-only, chốt version/ngưỡng trước khi chấm; `scripts/deploy_gate.py` đọc row mới nhất; `pipelines/director.py` đọc theo `owner_block` (bản tin GĐ) + `qa_status_latest` (agent_writer chỉ SELECT) |
| `job_runs` | 1 dòng/lần chạy job lịch (`job`,`started_at`,`finished_at`,`ok`,`detail` đã mask cắt 300,`host`) — bản tin sức khỏe đọc để báo job lỗi/không chạy | `pipelines.job_runs.job_run` (bọc `__main__` của `agents.report`, `ingest.lead_store`) — insert-only |
| `documents` | Tài liệu số hóa (`sha256` PK = tên bản gốc bất biến `originals/<sha256>`,`doc_type`,`pages`,`text_source` pdf_text/ocr/none,`pii_flag`,`status` cho_ocr/pending_review/verified/rejected,`verified_by`) — KHÔNG lưu full text | `ingest.doc_intake` — insert-only theo hash; status verified/rejected chỉ do Pháp chế qua CLI `--verify/--reject --by` |
| `garden_media` | (v9.3) Kho tư liệu vườn: `sha256` UNIQUE (tên file trong kho NGOÀI repo `<sha[:2]>/<sha>.<ext>`),`ext` jpg/png,`bytes`,`width`,`height`,`plot_id` FK→plots (no action),`taken_on`,`author`,`exif_removed`,`had_gps` — ảnh đã gỡ TOÀN BỘ EXIF/GPS; KHÔNG cột tọa độ/đường dẫn/tên file gốc | `python scripts/garden_media.py --file .. --plot .. --date .. --by ..` (`GARDEN_MEDIA_DIR` ngoài repo) |
| `document_fields` | Field pháp lý trích bằng regex (`so_giay`,`ngay_cap`,`ten_san_pham`; `confidence`,`verified` mặc định false) | `ingest.doc_intake` — không LLM; `verified=true` khi Pháp chế `--verify` |
| `sim_runs` | (v7.3) Nghiên cứu giả lập persona TỔNG HỢP: 1 dòng = 1 lời gọi LLM (`model`,`provider`,`model_version`,`prompt_id`,`prompt_hash`,`sample_idx`,`temperature`,`seed`,`seed_supported`) × 1 phương án (`option_id`,`is_control` đối chứng yếu,`score` 0..10 hoặc null,`parse_ok`,`guardrail_ok`) + `run_id`,`run_date`,`persona_set`/`persona_set_hash`,`dry_run` — KHÔNG PII, KHÔNG văn bản LLM thô | `scripts/persona_sim.py` — insert-only; chạy thật chỉ sau DPIA ký, `--dry-run` = số giả |
| `intel_items` | (v7.0, WP09) Tin thị trường tầng A/B: `url` chuẩn hóa UNIQUE, `domain`, `source` (id nguồn), `tier` A/B, `title`/`snippet`/`summary` ≤300 ký tự (đã che SĐT/email), `published_at`, `content_sha256` UNIQUE, `topics` (≥1: sam/tpbvsk/gioi_tre/quang_cao/doi_thu), `flags` (`ruou`/`suc_khoe`/`llm_guardrail_fail`) — KHÔNG toàn văn, không cột body | `python -m crawler.intel --run` — insert-only, dedup url + hash nội dung; không ghi bảng khác |
| `machines` | (v9.5 CK-A2) Sổ máy điện–cơ khí (`code` PK dạng `SS-EQ-NN`,`name`,`location`,`maker`,`year`, cờ+hạn kiểm định / hiệu chuẩn phương tiện đo, `ho_so_gmp`,`active`) — không xóa, thôi dùng = `active=false` | `python -m agents.cmms --add-machine` / `--retire` (sổ máy thật = external-dep) |
| `maintenance_plans` | Kế hoạch bảo trì theo chu kỳ (`machine_code` FK,`task`,`interval_days`,`major`,`start_on`,`last_done_on/by`,`last_approved_by`) — hạn kế = `coalesce(last_done_on,start_on)+interval_days` | `agents.cmms --add-plan` / `--done <id> --on --by [--approved-by]` (việc `major`/máy GMP bắt buộc Kỹ sư trưởng duyệt); `--due` nhắc đến hạn |
| `incidents` | Sự cố máy (`started_at`,`ended_at`,`downtime_phut`,`part`,`description` ĐÃ mask PII,`root_cause` mặc định 'chờ xác nhận',`reported_by` MÃ nhân sự) + view `downtime_log` (sự cố đã đóng, cho CK-A5) | `agents.cmms --incident` |
| `intel_imports` | (v7.2, WP09) 1 dòng/file intel nhập tay đã nạp: `kind` competitor/trend_timeline/trend_related/social, `channel` (social), `file_name` (basename), `file_sha256` UNIQUE (nạp lại cùng file = `[skip]`), `row_count` | `python -m ingest.intel_import` — insert-only |
| `competitor_observations` | (v7.2) Giá/KM đối thủ do NGƯỜI ghi tay: `competitor`, `channel` shopee/tiktok/lazada/tiki/web/khac, `product_name`, `sku_key` (SKU tương đương của mình, không FK), `price_vnd`, `promo_price_vnd`, `promo_text`, `rating`, `review_count`, `observed_on`, `source_ref` (URL / "ảnh chụp ...") — agent KHÔNG cào sàn | `ingest.intel_import --competitor F` — so golden bằng `competitor_gaps` (chỉ đọc) |
| `trends_weekly` | (v7.2) Google Trends multiTimeline xuất tay: `query_id` (= sha256 file[:16] — thang 0–100 chỉ so trong cùng file), `keyword`, `anchor` (từ khóa neo), `geo`, `week`, `value` 0–100 | `ingest.intel_import --trend F` — cấm thư viện/API Trends không chính thức |
| `trends_related` | (v7.2) Google Trends relatedQueries: `seed`, `section` top/rising, `query` ≤200, `value` ("100"/"+250%"/"Breakout"), `flags` (`ruou`) | `ingest.intel_import --trend F --seed KW` |
| `social_mentions` | (v7.2) Comment/inbox/review kênh SỞ HỮU (P1): `channel` fanpage/zalo_oa/tiktok, `kind`, `posted_at`, `msg_hash` UNIQUE (sha256 CÓ MUỐI `INTEL_HASH_SALT`), `labels` (khen/che/hoi_gia/hoi_suc_khoe/hoi_ruou/khieu_nai/khac), `sensitive`, `excerpt` (đã che, CHỈ khi DPIA đã ký) — KHÔNG cột tên/ID/SĐT/email người dùng | `ingest.intel_import --social F --channel C` — không trả lời tự động; báo cáo chỉ đếm |

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
| Duyệt content | Guardrail check lúc sinh + chạy LẠI trên text trước khi duyệt (v4.2: re-check = `check_publish` theo kênh draft + readiness view `sku_readiness` + LLM-check phụ nếu cấu hình `GUARDRAIL_LLM_MODEL`); chuyển trạng thái chỉ qua function DB `approve_draft` (SECURITY DEFINER: guardrail ok, có người tạo, **người duyệt ≠ người tạo**); mỗi quyết định ghi `approvals` kèm sha256 nội dung; `schedule_draft` từ chối nếu text đã sửa sau duyệt; mọi bước ghi `agent_action_log` hash chain | Duyệt/từ chối từng bài (identity đăng nhập) + note |
| Đăng bài | `scheduled_date` + calendar là kế hoạch | Copy text đã duyệt, đăng tay lên kênh |
| Báo cáo lãnh đạo | Sinh file markdown BẢN NHÁP | Đọc/duyệt/sửa rồi gửi Zalo/email tay |
| Nhật ký vườn | Chuẩn hóa + cảnh báo bất thường; hash chain chặn sửa/xóa | Ghi nhật ký tay; báo quản lý khi có cảnh báo; sai thì ghi dòng MỚI kèm lý do |
| Gỡ dữ liệu mẫu vườn | `--precheck` liệt kê blocker; agent KHÔNG tự gỡ | GĐ vùng trồng chạy `--purge-sample --by "<tên>"` (ghi `agent_action_log`); blocker nhật ký đã chain (không chuyển được) → `--adopt-plot <id> --by` nhận khoảnh thành khoảnh thật (`garden_plot_adopt`) |
| Zalo OA | Chỉ TRẢ LỜI tin nhắn đến (reply), không chủ động nhắn, không đăng OA | — |
| Hàng duyệt dùng chung (v4.0) | Agent nhân viên đẩy việc qua `director.submit` (SLA/rủi ro theo cấu hình khối) → `approval_queue`; 2 lớp: `auto_policy` (mặc định TẮT/rỗng, chỉ rủi ro low + QA pass + chủ khối ký) và `per_item` (người, **người duyệt ≠ người tạo**, guardrail ok, kiểm lại payload); quá SLA → `expired` (KHÔNG BAO GIỜ tự duyệt); QA FAIL muốn trình phải `override_qa` có lý do + người; `red_alerts` append-only, người nhận độc lập (không TGĐ/ha_tang), thiếu → ghi `route_error` (fail-closed); bản tin GĐ khối là file BẢN NHÁP | Duyệt/từ chối/override từng mục (`--by`); chủ khối ký auto_policy; Pháp chế xác nhận người nhận cảnh báo đỏ (external-dep) |
| Cảnh báo đỏ + bản tin intel (v7.1) | `pipelines.intel_alert --run` ghi cảnh báo đỏ theo luật (GIẢ ĐỊNH) + leo thang sau 2 giờ chưa xác nhận; bản tin `scripts/intel_bulletin.py` là file BẢN NHÁP; gợi ý chủ đề đi `approval_queue` loại `intel_topic` (risk medium — không tự duyệt); hệ thống KHÔNG gửi/liên hệ ai | Người nhận độc lập xác nhận bằng `python -m pipelines.intel_alert --ack ID --by "Tên"`; Quản lý MXH duyệt gợi ý chủ đề (`approval_queue --approve/--reject`); Pháp chế/Quản lý MXH duyệt bộ từ khóa (external-dep) |
| Bổ sung KB/claim | `core_store`/`embed_store` nạp lại khi được chạy | Soạn file nguồn + chạy lệnh nạp |
| Giả định kịch bản mùa (v7.3) | `pipelines.scenario` tính khoảng thấp/cơ sở/cao từ `data/scenario_assumptions.json` (`status` "GIẢ ĐỊNH — chờ GĐ KD/Tài chính chốt"; baseline là fixture) — không phải doanh số cam kết | GĐ KD/Tài chính chốt hệ số + 3 mức, đổi `status`; GĐ bán hàng cấp số bán thật |
| Nghiên cứu giả lập persona (v7.3) | `scripts/persona_sim.py` từ chối chạy thật (exit 2) khi `data/sim_config.json` `dpia_signed` khác `true`; báo cáo khoảng p10/p50/p90 có nhãn "KHÔNG phải dự báo doanh số" | Pháp chế + TGĐ ký DPIA/TIA rồi NGƯỜI đổi `dpia_signed`; Quản lý MXH duyệt báo cáo, TGĐ/BKS đồng ký biên bản |

## 6b. Phân quyền & đăng nhập (v3.4)

**Role DB** (`docs/roles.sql`, NOLOGIN — login user thật do hạ tầng tạo
`in role ...`, external-dep):

| Role | Được | Không được |
|---|---|---|
| `agent_writer` (agent AI) | SELECT `content_drafts` + view `sku_readiness` (v4.2); INSERT draft 6 cột (`brief`,`channel`,`text`,`guardrail`,`source`,`created_by` → luôn `pending`); INSERT log 5 cột | UPDATE/DELETE mọi bảng (không tự duyệt được — `permission denied`), `approvals`, bảng khác, function duyệt |
| `app_human` (người: Streamlit/CLI) | Kế thừa `agent_writer` + SELECT `approvals`/`agent_action_log` + EXECUTE `approve_draft`, `reject_draft`, `schedule_draft`, `verify_publish`, `verify_action_log` | UPDATE/DELETE trực tiếp |
| `agent_writer` — thêm v4.0 | EXECUTE `enqueue_item`, `auto_approve_item` (fail-closed khi không có luật đã ký), `expire_overdue`; SELECT `approval_queue` CHỈ cột metadata (KHÔNG `payload`/`guardrail`/sha — payload 11 khối chỉ người đọc) + `decisions` (bản tin GĐ khối); INSERT `red_alerts` 5 cột (+ SELECT `id` cho RETURNING), `channel_snapshots` 8 cột | `decide_item`, `override_qa`, UPDATE/DELETE mọi bảng, `auto_policies` |
| `app_human` — thêm v4.0 | SELECT `approval_queue` (đủ cột, gồm `payload`)/`auto_policies`/`channel_snapshots`/`red_alerts` + EXECUTE `decide_item`, `override_qa` | UPDATE/DELETE trực tiếp (TGĐ/ha_tang qua `app_human` KHÔNG xóa/sửa được cảnh báo đỏ; trigger chặn DML của owner khi còn bật, KHÔNG chặn owner tắt trigger/superuser replica) |
| `app_human` — thêm v7.1 | SELECT `red_alert_acks` + INSERT CHỈ 3 cột (`alert_id`,`acked_by`,`note`) — `acked_at` do DB đặt | UPDATE/DELETE `red_alert_acks`; `agent_writer` KHÔNG có quyền gì trên bảng này |

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
output (trước hiển thị/gửi), connector Zalo (trước send). v4.2: luồng
ĐĂNG BÀI (`pipelines.content` lúc sinh, `pipelines.store` lúc lưu
snapshot + lúc duyệt, ô check tay Studio) dùng `check_publish` (+ lớp
`guardrail_llm` ở sinh/duyệt) — phụ lục D mục 2c.

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
