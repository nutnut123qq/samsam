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
| `crawler/` | `collect` — crawl site public → `data/*.jsonl` (delay ≥1s/request) |
| `ingest/` | `embed_store` (chunk+embed→`chunks`), `core_store` (nạp DB lõi, delete-by-source idempotent), `lead_store` (convlog→`leads`, insert-only) |
| `api/` | `rag.py` — `answer()` RAG: retrieve top-8 `chunks` bằng cosine numpy → LLM + nguồn; `NO_DATA` khi score thấp |
| `pipelines/` | `guardrail.py` (banned words + claim whitelist — check trước mọi output AI), `content.py` (draft đa kênh), `store.py` (hàng duyệt + lịch `content_drafts`), `llm_gateway.py` (cổng LLM duy nhất: PII mask, privacy routing, kill/cap, `llm_usage`), `pii.py` |
| `connectors/` | `zalo.py` — webhook Zalo OA: verify signature, ACK 200 nhanh rồi reply async, dedup msg_id, token store + auto-refresh; **chỉ reply inbox** |
| `agents/` | `report.py` (báo cáo định kỳ → file md), `garden.py` (nhật ký vùng trồng + cảnh báo) — không LLM, không tự gửi |
| `app/` | `streamlit_app.py` — UI 7 tab (mục 4) |
| `scripts/` | `apply_schema.py`, `data_audit.py`, `eval_qa.py`, `zalo_mock.py`, `zalo_preflight.py` |
| `data/` | jsonl nguồn, `claims_whitelist.json`, `banned_words.txt`, convlog + token/seen (runtime, gitignored) |
| `tests/` | pytest (`python -m pytest`) |

## 3. Cơ sở dữ liệu — 11 bảng public (`docs/schema.sql`)

| Bảng | Chứa | Nguồn nạp |
|---|---|---|
| `chunks` | Chunk văn bản + embedding `float8[]` cho RAG (`doc_id`,`chunk_index`,`source_url`,`title`,`lang`,`content`,`embedding`) | `ingest.embed_store` — xóa-nạp lại theo doc_id |
| `products` | Sản phẩm (`id`,`name`,`price_vnd` null→"Liên hệ",`url`,`lang`) | `core_store` từ products.jsonl + nhập tay |
| `claims_approved` | Công dụng ĐÃ CÔNG BỐ theo SKU — nguồn sự thật guardrail (`sku_key`,`claim` null="chưa công bố") | `core_store` từ `claims_whitelist.json` |
| `plots` | Khoảnh vùng trồng (`id` vd 'KV-A01',`location`,`tree_count`,`status`) | `sample_plots.jsonl` (MẪU) + nhập tay |
| `plot_logs` | Nhật ký vùng trồng (`plot_id` FK→plots,`ts`,`activity`,`detail`,`author`) | `agents.garden` `source='manual:garden'` + sample |
| `orders` | Đơn hàng tối thiểu (`channel`,`product_id`,`qty`,`total_vnd`,`status`) — không PII | `sample_orders.jsonl` (MẪU) + nhập tay |
| `assets` | Tài sản truyền thông (`kind` image/video/article/doc,`url`,`product_id`) | `core_store` từ products.images + jsonl |
| `leads` | Lead từ convlog (`dedup_key` unique,`channel`,`user_hash`,`question` đã mask,`intent`,`status`) | `ingest.lead_store` — insert-only, không xóa |
| `content_drafts` | Hàng duyệt + lịch đăng (`brief`,`channel`,`text`,`guardrail` jsonb snapshot,`status`,`reviewer`,`scheduled_date`) | `pipelines.store` / Studio — update theo id |
| `llm_usage` | 1 dòng/lời gọi LLM-embedding (`ts`,`agent_id`,`model`,`tokens_in/out`,`cost_usd` ước tính,`ok`,`error` đã mask) — không lưu prompt | `pipelines.llm_gateway` — insert-only; trần chi phí tháng theo agent đọc từ đây |
| `eval_runs` | 1 dòng/lần nghiệm thu 1 agent tại 1 commit (`commit_sha`,`agent`,`n_total`,`n_pass`,`pass_rate`,`threshold`,`passed`,`model`,`prompt_version`) — `<sha>-dirty` = chạy trên tree bẩn, không mở deploy | `scripts/agent_eval.py` (CI/local) — insert-only; `scripts/deploy_gate.py` đọc row mới nhất |

Quy ước chung: mọi bảng lõi có cột `source` = file/nguồn nạp; loader
`core_store` chỉ delete+insert rows thuộc nguồn của mình → row nhập tay
an toàn. `leads`/`content_drafts` KHÔNG delete-by-source (dữ liệu người
tạo / fact suy ra một lần). Apply: `python scripts/apply_schema.py`
(idempotent, toàn `create ... if not exists`).

## 4. Giao diện — Streamlit `app/streamlit_app.py` (7 tab)

| # | Tab | Chức năng |
|---|---|---|
| 1 | Chat Sâm Sâm | Hỏi/đáp RAG trên KB — câu trả lời kèm nguồn; NO_DATA → text handoff + vào queue |
| 2 | Content Studio | Nhập brief → sinh draft đa kênh (guardrail từng kênh) → "Lưu vào hàng duyệt"; ô check text tay |
| 3 | Chưa trả lời | Queue convlog `answered:false` cho nhân viên follow-up |
| 4 | Leads | Dashboard convlog (file-based, hiện cả khi DB chết) + bảng `leads` — read-only |
| 5 | Báo cáo | Sinh/xem báo cáo `data/reports/` — BẢN NHÁP người gửi |
| 6 | Nhật ký vườn | Form ghi `plot_logs` + panel "Cần chú ý" + nhật ký gần nhất |
| 7 | Duyệt & Lịch | Hàng duyệt `content_drafts` (Duyệt disabled khi vi phạm) + xếp lịch + calendar 14 ngày |

Mọi tab có DB đều degrade nhẹ: DB chết → `st.info` "Chưa nạp", không
crash (mọi connect qua `ingest.lead_store.connect`, `connect_timeout=3`).

## 5. Agents (WS3 — chạy theo lịch, không LLM)

| Agent | Lệnh | Làm gì |
|---|---|---|
| Báo cáo định kỳ | `python -m agents.report [--days N] [--until YYYY-MM-DD]` | Tổng hợp orders/leads/convlog/plot_logs → `data/reports/report-*.md`; gắn nhãn *(mẫu)* khi nguồn toàn `sample:*`; DB chết → bản DEGRADED |
| Nhật ký vùng trồng | `python -m agents.garden --plot .. --activity ..` / `--check [--gap-days N]` | Ghi `plot_logs` (chuẩn hóa hoạt động theo `ACTIVITY_VOCAB` + alias) + cảnh báo no-logs/gap/keyword (`FLAG_KEYS` chung với report) |

Lập lịch định kỳ: Task Scheduler/cron chạy hai lệnh trên — report
idempotent theo kỳ (cùng kỳ → cùng tên file ghi đè).

## 6. Human-gate — các điểm NGƯỜI bắt buộc (invariant C2.4)

| Điểm | Hệ thống làm | NGƯỜI làm |
|---|---|---|
| Duyệt content | Guardrail check lúc sinh; `set_status` chặn approve khi vi phạm (cả Python lẫn SQL) | Duyệt/từ chối từng bài, ghi tên + note |
| Đăng bài | `scheduled_date` + calendar là kế hoạch | Copy text đã duyệt, đăng tay lên kênh |
| Báo cáo lãnh đạo | Sinh file markdown BẢN NHÁP | Đọc/duyệt/sửa rồi gửi Zalo/email tay |
| Nhật ký vườn | Chuẩn hóa + cảnh báo bất thường | Ghi nhật ký tay; báo quản lý khi có cảnh báo |
| Zalo OA | Chỉ TRẢ LỜI tin nhắn đến (reply), không chủ động nhắn, không đăng OA | — |
| Bổ sung KB/claim | `core_store`/`embed_store` nạp lại khi được chạy | Soạn file nguồn + chạy lệnh nạp |

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
