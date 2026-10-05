# TASKS — Pilot board (M1–M4)

Quy ước: mỗi task có **owner / boundary / gate / evidence**. Junior chỉ đụng file
trong boundary. Xong = gate xanh + evidence file commit vào repo. Controller audit
evidence, không tin lời.

Status: `[ ]` todo · `[~]` doing · `[x]` done (kèm link evidence)

---

## M1 — Data pipeline (crawl → jsonl)

- [x] **T1.1 Crawl samsamngoclinh.com** (WooCommerce — ưu tiên `/wp-json/wp/v2/`, `wc/store/v1/products`)
  - Boundary: `crawler/collect.py`, `crawler/sources.py`, `data/products.jsonl`, `data/articles.jsonl`
  - Gate: `python -m crawler.collect` exit 0; ≥20 products đúng tên+giá; ≥20 articles
  - Evidence: `data/*.jsonl` + `evidence/m1_crawl.log` (stdout) — 27 products (18 wc + 9 shop net.vn; 15 có giá), 90 articles
- [x] **T1.2 Crawl samsam.net.vn** (NukeViet, fallback HTML parse)
  - Boundary: `crawler/sources.py`, `data/about.jsonl`, `data/news.jsonl`
  - Gate: ≥10 records có title+body+url
  - Evidence: jsonl + log — 4 about + 31 news (site chỉ chạy http, sitemap làm entry)
- [x] **T1.3 Claims whitelist** — trích công dụng ĐÃ CÔNG BỐ từng SKU từ text crawl được
  - Boundary: `data/claims_whitelist.json`, `data/banned_words.txt`
  - Gate: mọi SKU trong products.jsonl có entry claims (hoặc "chưa có công bố — không suy diễn")
  - Evidence: 2 file data — 10 SKU: 6 TPBVSK có CÔNG DỤNG+ĐKSP, 4 (rượu/củ) chưa có công bố
- [x] **T1.4 Mở rộng M1b** — thêm hệ thống phân phối (13 điểm) + cẩm nang sâm (10 bài)
  - Boundary: `crawler/`, `data/`, `evidence/` (không đụng ingest/ — gộp articles/news)
  - Gate: collect exit 0, jsonl +23 records, bot trả được địa chỉ showroom kèm nguồn
  - Evidence: `evidence/m1b_crawl.log` — articles 90→103, news 31→41; hỏi "Sâm Sâm có showroom ở đâu" → "425 Phan Bội Châu, phường Bàn Thạch, Thành Phố Đà Nẵng" + nguồn he-thong-phan-phoi
  - Lý do gộp: schema `{id,title,body,url,published_at}` khớp articles; REST `wp/v2/he-thong-phan-phoi` chỉ trả title (acf rỗng, detail page 301 về home) → render listing Bricks AJAX bằng playwright, ghi record `dist-*` vào `articles.jsonl`; camnang = bài nv_article thường → `news.jsonl`. KHÔNG crawl slider-home/videos/phan-hoi.

## M2 — Knowledge base + chatbot RAG

- [x] **T2.1 Postgres local schema + ingest** (`createdb samsam` + chạy `docs/schema.sql`, bảng `chunks`)
  - Boundary: `ingest/`, `docs/schema.sql`
  - Gate: `python -m ingest.embed_store` nạp hết jsonl, `select count(*)` đúng
  - Evidence: `evidence/m2_ingest.log` — 816 chunks / 153 docs; thêm cột `lang` (audit M1: EN/VI dupes) + doc `catalog-products` tổng hợp
- [x] **T2.2 Chat UI** — hỏi/đáp kèm link nguồn
  - Boundary: `app/streamlit_app.py` (tab Chat), `api/rag.py` nếu cần tách
  - Gate: **8/10 câu hỏi test** (`tests/questions.md`) trả đúng + có nguồn
  - Evidence: `evidence/m2_qa.md` ghi 10 Q/A thật, ảnh màn hình `evidence/m2_chat.png` — 10/10 + 2/2 câu bẫy

## M3 — Content Studio + guardrail

- [x] **T3.1 Guardrail** — `check(text) -> {ok, violations[], matched_claims[]}`
  - Boundary: `pipelines/guardrail.py`, `tests/test_guardrail.py`
  - Gate: pytest xanh; chặn đúng case "chữa khỏi tiểu đường" trong test
  - Evidence: `evidence/m3_pytest.log` — 13/13 passed; match có dấu + không dấu, approved claim miễn banned span con ("hỗ trợ hạ đường huyết" pass), "thuộc" không bị bắt nhầm "thuốc"; vá lỗ hổng mệnh đề ghép (claim đúng + claim bịa nối "và" → flag)
- [x] **T3.2 Draft pipeline** — ý tưởng → bài FB → qua guardrail → hiển thị violations
  - Boundary: `pipelines/content.py`, tab Content Studio trong `app/`
  - Gate: sinh được bài; bài cố tình vi phạm bị flag đỏ
  - Evidence: `evidence/m3_studio.png` — draft PASS xanh + text "chữa khỏi tiểu đường" flag đỏ 7 violations; `content.draft()` có 1 lượt rewrite-khi-vi phạm rồi check() lại trước khi trả

## M4 — Đóng gói demo

- [x] **T4.1** README chạy 1 lệnh; video quay ≤3 phút demo chat + guardrail
  - Evidence: `evidence/demo.mp4` (38s — chat trả giá kèm nguồn → Studio draft PASS → text vi phạm flag đỏ); `python demo.py` verify chạy được trên máy này (máy sạch cần Python + Postgres + .env — NEEDS-INPUT: chưa có máy sạch để verify)

## M5 — Connector v0.2 (Zalo OA bot)

Checklist/DoD chi tiết: `DONE.md` mục v0.2-connector. Quy ước: "CODE xong"
≠ "PLATFORM duyệt" — không task nào treo chờ sàn.

- [~] **C2.0 Platform prep** — submit Zalo OA webhook app + Shopee/TikTok
  dev app NGÀY 1 (chạy nền, duyệt 1–2 tuần)
  - Evidence: `evidence/v02_platform.md` — NEEDS-INPUT: owner submit trên
    console sàn (agent không tạo tài khoản ngoài)
- [x] **C2.1 Zalo webhook server** — `python -m connectors.zalo` :8788
  - Boundary: `connectors/`, `tests/test_zalo.py` (stdlib http.server +
    httpx có sẵn — 0 dep mới)
  - Gate: verify `X-ZEvent-Signature` (sha256 spec Zalo), dedup msg_id
    chống retry nhân đôi, ACK 200 nhanh + reply async thread
    (answer() ~10s không block webhook)
  - Evidence: `evidence/v02_pytest.log` — 11 case: signature ok/bad,
    dedup, non-text ignore, ACK <1s khi reply sleep 2s
- [x] **C2.2 Reply pipeline** — event → `answer()` → guardrail → send API
  - Boundary: `connectors/zalo.py` (reuse `api/rag.py` + `guardrail.py`
    nguyên trạng — không đụng)
  - Gate: mọi outbound qua `check()`; flag → FALLBACK hotline thay text
    vi phạm; reply kèm "Nguồn: <url>"
  - Evidence: `evidence/v02_pytest.log` — 3 case pipeline mock
- [x] **C2.3 Mock E2E** — `scripts/zalo_mock.py` replay ≥3 hội thoại
  - Evidence: `evidence/v02_zalo_mock.log` — 3/3 đúng end-to-end: giá
    Saphraton 2 quy cách + nguồn · showroom "425 Phan Bội Châu" + nguồn ·
    câu bẫy "Chưa đủ dữ liệu để trả lời."
- [x] **C2.4 Human-gate** — `connectors/` không có endpoint đăng
  bài/listing mới (verify bằng diff: chỉ nhận/reply)
- [x] **C2.5 Gate + docs** — pytest 26/26, ruff clean; `python demo.py`
  verify :8501 HTTP 200; AGENTS.md thêm lệnh webhook + mock

## M6 — Hardening v0.3 (ops: log + eval + gate)

Checklist/DoD chi tiết: `DONE.md` mục v0.3-hardening. Audit gốc:
`audit/2026-10-04.md`. Quy ước: mọi task giữ nguyên contract module —
`api/rag.py` + `guardrail.py` đụng = bug, phải ghi lý do trong commit.

- [x] **D3.1 Vá gate regression** — ruff RUF100 (`scripts/zalo_mock.py:21`)
  + script in tiếng Việt an toàn trên console cp1258
  - Boundary: `scripts/`, `demo.py` nếu cần
  - Gate: `ruff check .` clean; `python scripts/zalo_mock.py` (không
    `-X utf8`, không PYTHONIOENCODING) exit 0
  - Evidence: 2026-10-04 — bỏ noqa thừa + reconfigure UTF-8 stdout/stderr;
    verify: ruff clean + mock 3/3 exit 0 không cần `-X utf8`
- [x] **D3.2 Eval harness** — `scripts/eval_qa.py` parse `tests/questions.md`,
  chạy `answer()` từng câu, in pass/fail + exit code ≥10/12
  - Boundary: `scripts/eval_qa.py`, `tests/` (chỉ thêm)
  - Gate: chạy thật qua OpenRouter, ≥10/12 pass; câu bẫy phải NO_DATA
  - Evidence: `evidence/v03_eval.log` — chạy thật 12/12 PASS (~90s),
    Q11 NO_DATA + Q12 guardrail-clean; exit 0
- [x] **D3.3 Conversation log** — webhook ghi `data/conversations.jsonl`
  per event: {ts, msg_id, user_hash, question, answer, sources[],
  guardrail_ok, latency_ms, answered}
  - Boundary: `connectors/zalo.py` (+ helper mới nếu tách), `data/`
  - Gate: mock E2E → log ≥3 dòng đúng schema; user_id hash (không lưu raw)
  - Evidence: `evidence/v03_convlog.log` — mock 3/3, jsonl 3 dòng đúng
    schema, user_hash sha256[:16] (verify: không có raw "u1/u2/u3")
- [x] **D3.4 Unanswered flag** — `answered:false` khi NO_DATA trong log D3.3
  - Boundary: cùng D3.3 (gộp chung lane)
  - Gate: câu bẫy trong mock → dòng log `answered:false`
  - Evidence: chung `v03_convlog.log` — dòng mock2 (câu bẫy ung thư)
    `answered:false`; test `test_conversation_log_no_data_answered_false`
- [x] **D3.5 Dedup persistence** — `_seen` survive restart (sqlite3 stdlib
  hoặc jsonl append); Zalo retry sau restart không reply nhân đôi
  - Boundary: `connectors/`, `tests/test_zalo.py` (thêm case)
  - Gate: pytest case mới: dedup giữa 2 "restart" (xóa state memory) cùng
    msg_id → True; không phá 11 case cũ
  - Evidence: `evidence/v03_pytest.log` — 29/29 (26 cũ + 3 mới);
    `test_dedup_persists_across_restart` đọc lại bằng connection sqlite
    mới chứng minh state trên đĩa
- [x] **D3.6 Gate chung** — pytest ≥26 xanh + ruff clean; data/*.jsonl
  nguồn không đổi (conversations.jsonl là file mới, không đụng 4 file gốc)
  - Evidence: `evidence/v03_pytest.log` — pytest 29/29, ruff clean,
    `git status data/` trống + tick board

## M7 — Live-ready v0.4 (bot sẵn sàng live OA thật)

Checklist/DoD chi tiết: `DONE.md` mục v0.4-live-ready. Quy ước: D4.1 được
phép mở rộng signature `answer()` — bắt buộc backward-compatible (caller
cũ `answer(q)` không đổi hành vi); mọi đụng `guardrail.py` vẫn = bug,
phải ghi lý do trong commit.

- [x] **D4.1 Multi-turn context** — `answer(q, history=None)` + per-user
  history ≤4 lượt trong zalo + streamlit truyền session history
  - Boundary: `api/rag.py`, `connectors/zalo.py`, `app/streamlit_app.py`,
    `tests/` (thêm case — file mới `tests/test_rag.py` nếu cần)
  - Gate: pytest case chứng minh history vào prompt + follow-up resolve
    ngữ cảnh; eval ≥10/12 không regression (chạy ở D4.5)
  - Evidence: `evidence/v04_pytest.log` (38/38) + live check trong
    `v04_eval.log` — `_standalone()` rewrite chỉ khi có history
- [x] **D4.2 Signature fail-closed** — `DEPLOY=1` thiếu `ZALO_APP_SECRET`
  → refuse to serve
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case deploy-no-secret → startup error trước khi bind;
    dev local không secret vẫn serve (giữ `test_signature_skip_when_no_secret`)
  - Evidence: `test_startup_error_fail_closed` (3 nhánh)
- [x] **D4.3 Vá mock re-run** — msg_id unique per run trong mock
  - Boundary: `scripts/zalo_mock.py` (chỉ file này)
  - Gate: `python scripts/zalo_mock.py` chạy 2 lần liên tiếp <1h đều
    exit 0 (verify ở D4.5 — mock đụng zalo.py của lane A)
  - Evidence: `evidence/v04_mock_rerun.log` — 2 run liên tiếp 3/3
- [x] **D4.4 Convlog v2** — `sent`, crash-log, `flagged_text`
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case mới cho cả 3 thay đổi; mọi field schema cũ giữ nguyên
  - Evidence: 3 test mới + log thật sau mock có `sent:true`
- [x] **D4.5 Gate chung** — pytest xanh + ruff clean + eval ≥10/12+2 bẫy
  + mock 2 lần exit 0
  - Evidence: `evidence/v04_pytest.log` (38/38 + ruff) · `v04_eval.log`
    (12/12) · `v04_mock_rerun.log` (3/3 ×2)

## M8 — Ops-ready v0.5 (vá lỗ hổng trước khi webhook public)

Checklist/DoD chi tiết: `DONE.md` mục v0.5-ops-ready. Quy ước: D5.2 đụng
`api/rag.py` được phép — fix crash-path, ghi lý do trong commit; mọi đụng
`guardrail.py` vẫn = bug.

- [x] **D5.1 Deploy config cứng** — `DEPLOY` truthy (1/true/yes) +
  thiếu `ZALO_ACCESS_TOKEN` lúc DEPLOY → refuse to serve; `docs/deploy.md`
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`, `docs/`
  - Gate: pytest case DEPLOY variants (truthy + thiếu token + dev ok)
  - Evidence: `test_startup_error_fail_closed` 7 nhánh; `docs/deploy.md`
- [x] **D5.2 `_standalone` content=None fallback** — refusal → retrieval
  dùng câu gốc, không AttributeError qua streamlit/zalo
  - Boundary: `api/rag.py`, `tests/test_rag.py`
  - Gate: pytest case mock LLM trả content=None
  - Evidence: 2 case (rewrite refusal → câu gốc; answer refusal →
    NO_DATA — vá cả `answer()` cùng lớp lỗi)
- [x] **D5.3 Convlog PII mask** — regex mask SĐT/email trong `question`
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case question chứa SĐT → log không có số thật
  - Evidence: `test_convlog_question_masks_pii` — "0901234567"/"a@b.com"
    → "***" (SĐT viết cách chưa mask — regex lite, someday đã ghi)
- [x] **D5.4 Log rotation** — `conversations.jsonl` > cap → rotate `.1`
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case file vượt cap → `.1` tồn tại + file mới ghi tiếp
  - Evidence: `test_convlog_rotates_when_over_cap` (cap=10B)
- [x] **D5.5 Per-user serialize** — lock striping per user quanh
  answer+append+send
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case 2 thread cùng user → history đúng thứ tự append
  - Evidence: `test_same_user_messages_serialize` — 64-lock striping,
    `handle_text` → `_ulock` → `_reply`; sleep 0.2s chứng minh code cũ
    fail deterministic
- [x] **D5.7 Payload cap** (phát sinh ở ship-pass, user duyệt gộp) —
  `Content-Length` không cap = memory DoS khi public; guard `>MAX_BODY`
  → 413, `<0`/malformed → 400 (read(-1) đọc tới EOF)
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: `test_payload_too_large_rejected` (MAX_BODY=10B → 413)
- [x] **D5.6 Gate chung** — pytest + ruff + eval ≥10/12+2 bẫy + mock ×2
  - Evidence: `evidence/v05_pytest.log` 45/45 + ruff clean ·
    `v05_eval.log` 12/12 · `v05_mock.log` 3/3 ×2 liên tiếp.
    Reviewer độc lập không chạy được (hết quota) — coordinator tự
    adversarial-review diff; /cold-audit session lạ là cửa cuối

## M8b — Patch v0.5.1 (vá NIT audit v0.5 + convlog hygiene)

Checklist/DoD chi tiết: `DONE.md` mục v0.5.1 (contract user duyệt
2026-10-05). Đụng `api/rag.py` được phép — vá edge-path, ghi lý do trong
commit; `guardrail.py` cấm đụng.

- [x] **D5.8 Whitespace-only answer → NO_DATA** — `api/rag.py`
  - Boundary: `api/rag.py`, `tests/test_rag.py`
  - Gate: pytest mock LLM trả `" "` → NO_DATA + `sources:[]` (không gửi
    message rỗng)
  - Evidence: `test_answer_whitespace_returns_no_data`
- [x] **D5.9 Chunked body reject** — `do_POST` thiếu Content-Length mà
  có `Transfer-Encoding: chunked` → 411 (hành vi định nghĩa trước
  keep-alive)
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest chunked POST → 411
  - Evidence: `test_chunked_post_rejected_411` (generator content →
    chunked thật, không Content-Length)
- [x] **D5.10 PII SĐT viết cách** — `_PII_RE` bắt "0901 234 567" /
  dash / dot; regression số ngắn + giá "1.500.000" không bị ăn
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest masked "***" + case không over-match
  - Evidence: `test_convlog_masks_spaced_phone` +
    `test_mask_pii_regex_boundaries` (8 case biên từ reviewer findings)
- [x] **D5.11 Convlog retention theo tuổi** — purge entry/backup cũ hơn
  30 ngày (startup + daily-on-write + sau rotate) + retention policy
  trong `docs/deploy.md`
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`, `docs/deploy.md`
  - Gate: pytest purge đúng + deploy.md có mục retention
  - Evidence: `test_convlog_purges_entries_older_than_retain_days`
    (byte lỗi + U+2028) + `test_log_write_triggers_daily_purge`
- [x] **D5.12 Gate chung** — pytest xanh + ruff clean
  - Evidence: `evidence/v051_pytest.log` — 51/51 + ruff clean.
    Reviewer độc lập: verdict FIX đợt 1 (blocker regex boundary + 2
    major purge + test yếu), vá xong → pass; eval/mock skip theo
    precedent patch (edge-path, không đụng happy path).

## M9 — Handoff v0.6 (NO_DATA → lối thoát cho người + queue)

Checklist/DoD chi tiết: `DONE.md` mục v0.6-handoff (contract user duyệt
2026-10-05). `api/rag.py` contract `NO_DATA` giữ nguyên; `guardrail.py`
cấm đụng.

- [x] **D6.1 Handoff message** — zalo: `NO_DATA in raw` → gửi
  `HANDOFF_TEXT` (hằng viết tay, có hotline); convlog `answer`=text
  gửi, `answered:false` trên raw; streamlit chat cùng map
  - Boundary: `connectors/zalo.py`, `app/streamlit_app.py`,
    `tests/test_zalo.py`
  - Gate: pytest NO_DATA → sent HANDOFF_TEXT + answered:false
- [x] **D6.2 Unanswered queue UI** — tab "Chưa trả lời" đọc convlog
  (+`.1`), filter answered:false → bảng ts/question/user_hash +
  empty-state; loader tách module để test được
  - Boundary: `connectors/zalo.py` (loader — module sở hữu schema
    convlog), `app/`, `tests/`
  - Gate: UI thật + screenshot `evidence/v06_queue.png` (bảng + empty)
- [x] **D6.3 Mock E2E + gate** — `zalo_mock.py` câu bẫy expect substring
  HANDOFF_TEXT; mock 3/3; pytest + ruff
  - Boundary: `scripts/zalo_mock.py`, `evidence/`
  - Evidence: `evidence/v06_pytest.log` + `evidence/v06_mock.log`

## M10 — Patch v0.6.2 (convlog/PII hygiene — vá NIT audit)

Checklist/DoD chi tiết: `DONE.md` mục v0.6.2 (contract user duyệt
2026-10-06). `guardrail.py` cấm đụng; `api/rag.py` không cần đụng.

- [ ] **D6.8 `sent: null` kênh UI** — streamlit convlog `False` → `null`
  - Boundary: `app/streamlit_app.py`, `tests/`
  - Gate: entry streamlit `sent is None`; pytest xanh
- [ ] **D6.9 Purge không giết reply + retry đúng** — `_purge_convlog`
  throw → warn không propagate; `_last_purge` set sau purge thành công
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest purge-throw → reply vẫn log/send + `_last_purge` không set
- [ ] **D6.10 User hash per UI session** — `streamlit:{session_id}`
  - Boundary: `app/streamlit_app.py`, `connectors/zalo.py` (helper),
    `tests/test_zalo.py`
  - Gate: 2 session → 2 hash; 1 session ổn định (helper pure test được)
- [ ] **D6.11 PII: +84 + sep lặp** — `_PII_RE` bắt `+84`/`84` prefix và
  sep ≥2 ký tự; không over-match giá/ngày/số ngắn
  - Boundary: `connectors/zalo.py`, `tests/test_zalo.py`
  - Gate: pytest case mới + regression biên
- [ ] **D6.12 Gate chung** — pytest xanh + ruff clean

---

## Lề (không đụng trong pilot)
Messenger integration, agent vườn, dashboard, training, deploy public, auth.
