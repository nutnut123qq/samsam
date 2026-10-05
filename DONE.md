# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **chưa có** — v0.4-live-ready đóng 2026-10-05; version
kế mở khi có chỉ thị (C2.0 owner submit dev app vẫn NEEDS-INPUT).

## Checklist v0.4-live-ready

Khán giả: khách nhắn Zalo OA thật (sau C2.0) + bác Lực xem hội thoại
nhiều lượt tự nhiên. Code-side readiness — external không treo version
(cùng pattern v0.3).

- [x] **D4.1 Multi-turn context** — `answer()`/Zalo nhớ ≤4 lượt gần
  nhất per user; hỏi nối tiếp ("giá Saphraton?" → "còn loại rẻ hơn?")
  trả đúng ngữ cảnh; eval 12 câu không regression
  — *(verify 2026-10-05: `answer(q, history=None)` backward-compat +
    `_standalone()` rewrite chỉ khi có history; live check T2
    "con loai nao re hon?" → đúng Saphraton 20V rẻ hơn; pytest
    test_rag 3 case + test_zalo history/flagged-skip)*
- [x] **D4.2 Signature fail-closed** — `DEPLOY=1` mà thiếu
  `ZALO_APP_SECRET` → refuse to serve (không bind); dev local không
  secret vẫn chạy
  — *(`_startup_error()` + main() exit(1) trước bind; pytest 3 nhánh)*
- [x] **D4.3 Vá mock re-run** — `zalo_mock.py` chạy 2 lần liên tiếp
  <1h đều exit 0 (msg_id unique per run)
  — *(verify: 2 run liên tiếp 3/3 exit 0, `evidence/v04_mock_rerun.log`)*
- [x] **D4.4 Convlog v2** — field `sent` (send-fail ≠ đã xử lý); log cả
  event `answer()` crash (không mất vết câu hỏi); raw text bị guardrail
  flag giữ field riêng (`flagged_text`)
  — *(pytest 3 case mới + log thật sau mock có `sent:true`)*
- [x] **D4.5 Gate chung** — pytest toàn bộ xanh · `ruff check .` clean
  · `eval_qa.py` ≥10/12 + 2 bẫy pass
  — *(38/38 ×2, ruff clean, eval 12/12 `evidence/v04_eval.log`)*

External-dependency (không treo version): C2.0 owner submit → live
verify `evidence/v02_zalo_live.png` · hồ sơ công bố SKU thật thay
whitelist tự trích · quyết VPS/tunnel deploy. Someday giữ nguyên + PII
masking `question` + log rotation (chờ quyết deploy public).

## Checklist v0.3-hardening

Khán giả: buổi gặp bác Lực / OA live khi dev app được duyệt — version này
làm phần agent tự làm được trong lúc chờ external (C2.0 vẫn NEEDS-INPUT).

- [x] **D3.1 Vá gate regression** — `ruff check .` clean; `python
  scripts/zalo_mock.py` + mọi script in tiếng Việt chạy không crash trên
  console Windows thường (xử lý encoding trong code, không bắt `-X utf8`)
  — *(verify 2026-10-04: ruff clean + mock 3/3 exit 0)*
- [x] **D3.2 Eval harness** — `python scripts/eval_qa.py` chạy 12 câu
  `tests/questions.md`, in pass/fail từng câu, exit code theo ngưỡng
  ≥10/12; evidence `evidence/v03_eval.log`
  — *(chạy thật 12/12 PASS, Q11 NO_DATA + Q12 guardrail-clean)*
- [x] **D3.3 Conversation log** — mọi event webhook (question, answer,
  sources, guardrail ok/flag, latency, msg_id) ghi
  `data/conversations.jsonl`; sau mock E2E log đủ 3 hội thoại đúng schema
  — *(3 dòng đúng schema, user_hash sha256[:16], không raw user_id)*
- [x] **D3.4 Unanswered log** — câu `NO_DATA` gắn cờ riêng
  (`answered:false`) để đọc được KB đang thiếu gì
  — *(dòng mock2 `answered:false` + test case riêng)*
- [x] **D3.5 Dedup persistence** — `_seen` qua restart: webhook restart
  giữa 2 event cùng `msg_id` không reply nhân đôi (test chứng minh)
  — *(sqlite `data/zalo_seen.db` lazy-init; test đọc connection mới chứng
    minh đĩa; 29/29 pytest)*
- [x] **D3.6 Gate chung** — `pytest` toàn bộ xanh (26 case hiện có không
  sửa để qua) + `ruff check .` clean
  — *(29/29 xanh, ruff clean, data gốc không đổi)*

External-dependency (không treo version): C2.0 owner submit dev app · hồ sơ
công bố SKU thật thay whitelist tự trích · quyết VPS/tunnel deploy.
Someday giữ nguyên + multi-turn context (M — cần cho OA live, user duyệt
để ngoài v0.3).

## Checklist v0.2-connector

Quy ước DoD cho phase connector:

- **"CODE xong" ≠ "PLATFORM duyệt"** — duyệt app sàn/OA mất 1–2 tuần, không
  mục nào được treo chờ. Mock test pass + app đã submit = đạt; bot live trên
  OA thật là bonus.
- Mọi text AI outbound phải qua `pipelines.guardrail.check()`: inbox reply
  auto OK sau guardrail; đăng bài/listing mới bắt buộc human-approve.
- ToS: chỉ API chính thức Zalo OA — cấm scraping/simulation.
- Secret sàn chỉ trong `.env` (`ZALO_APP_ID`, `ZALO_OA_SECRET`,
  `ZALO_ACCESS_TOKEN`, `ZALO_VERIFY_TOKEN`); app registration không commit.
- Dataset/sync ops batch ≤500 (máy từng BSOD vì python ăn 30GB).
- Evidence: `evidence/v02_*` — `*.log` bị ignore, nhớ `git add -f`.

- [ ] **C2.0 Platform prep — nền, submit NGÀY 1**
  - Việc: đăng ký Zalo OA webhook app + submit Shopee + TikTok dev app.
    Chạy nền song song code; KHÔNG phải deliverable code của version.
  - Boundary: không file repo — registration ngoài git.
  - DoD: `evidence/v02_platform.md` ghi ngày submit từng app (không secret).
    Bonus nếu OA duyệt kịp: `evidence/v02_zalo_live.png` (chat thật trên OA).

- [x] **C2.1 Zalo webhook server** — HTTP endpoint nhận OA message event
  - Boundary: `connectors/` (package mới), `tests/test_zalo.py`.
    `requirements.txt` ưu tiên stdlib `http.server` + `httpx` có sẵn — chỉ
    thêm dep nếu chứng minh cần.
  - DoD: `pytest -k zalo` pass — parse đúng event format Zalo OA; signature/
    verify-token sai → reject; event không phải tin nhắn → ignore;
    `python -m connectors.zalo` serve được local.
  - Evidence: `evidence/v02_pytest.log`.

- [x] **C2.2 Reply pipeline** — event → `api.rag.answer()` → guardrail → send
  - Boundary: `connectors/zalo*.py`. `api/rag.py` + `pipelines/guardrail.py`
    chỉ reuse — đụng = bug, phải ghi lý do trong commit.
  - DoD: mock test pass — (a) hỏi giá Saphraton → reply đủ 2 giá + URL nguồn;
    (b) câu bẫy → "Chưa đủ dữ liệu để trả lời."; (c) reply text bị
    guardrail flag → gửi fallback an toàn, KHÔNG gửi text vi phạm;
    (d) assert mọi outbound đều đã qua `check()` trước khi gọi send API.
  - Evidence: `evidence/v02_pytest.log`.

- [x] **C2.3 Mock E2E demo** — script replay event vào webhook local
  - Boundary: `scripts/zalo_mock.py`, `evidence/`.
  - DoD: `python scripts/zalo_mock.py` exit 0; log ≥3 hội thoại end-to-end:
    giá Saphraton + nguồn · showroom Đà Nẵng + nguồn · câu bẫy từ chối đúng.
  - Evidence: `evidence/v02_zalo_mock.log`.

- [x] **C2.4 Human-gate contract** — v0.2 KHÔNG có đường đăng nội dung mới
  - DoD (review diff): không hàm/path nào trong `connectors/` gọi API tạo
    bài/listing mới lên OA/sàn. Reply auto chỉ sau guardrail — xong.
  - Evidence: diff `connectors/` (không endpoint post/create nào).

- [x] **C2.5 Gate chung + docs** — baseline không regression
  - Boundary: `TASKS.md` (thêm block M5), `AGENTS.md` (commands mới nếu có),
    `DONE.md`.
  - DoD: `pytest -q` toàn bộ xanh (13 case cũ không sửa để qua) ·
    `ruff check .` clean · `python demo.py` vẫn lên UI :8501 ·
    `data/*.jsonl` không đổi (175 records — connector không đụng pipeline).
  - Evidence: `evidence/v02_pytest.log` + tick board.

## Checklist v0.1-pilot

- [x] `python -m crawler.collect` exit 0; `data/products.jsonl` ≥20 dòng đúng tên+giá; `data/articles.jsonl` ≥20 dòng — *(evidence: file + `evidence/m1_crawl.log` — 27 products, 90 articles)*
- [x] `python -m ingest.embed_store` nạp hết vào Postgres `samsam.chunks` — *(evidence: `evidence/m2_ingest.log` — 816 chunks/153 docs)*
- [x] Chatbot trả đúng ≥8/10 câu `tests/questions.md` + 2 câu bẫy từ chối đúng, mọi câu kèm URL nguồn — *(evidence: `evidence/m2_qa.md` 10/10+2/2 + `m2_chat.png`)*
- [x] Content Studio sinh được bài FB và guardrail tô đỏ bài cố tình vi phạm — *(evidence: `evidence/m3_studio.png` 2 case + `m3_pytest.log` 13/13)*
- [x] `pytest` + `ruff check .` xanh — *(13/13, clean)*
- [x] Video demo ≤3 phút 1 mạch: chat + guardrail — *(evidence: `evidence/demo.mp4` 38s)*

## Someday (chưa vào version nào)

- `test_ack_fast_while_reply_slow` flaky dưới load — threshold <1s quá
  chặt cho localhost Windows (đo 2026-10-05: handler rỗng cũng 0.7-3.9s
  khi máy nặng; status luôn 200, dispatch async đúng — probe sleep(10)
  POST vẫn <4s). Vá: đổi sang assert event-based (reply-thread chưa set
  event khi POST return) hoặc nới threshold
- `_histories` dict không giới hạn số user — webhook public + user_id
  spam → memory leak chậm (signature chặn user giả nên rủi ro thấp; cap
  ~1000 user evict-oldest là đủ khi deploy thật)
- `DEPLOY` chỉ check `== "1"` — deploy doc phải ghi đúng `DEPLOY=1`;
  cân nhắc truthy check ("true","yes") khi viết deploy runbook
- Convlog crash-path ghi `guardrail_ok: False` dù guardrail chưa chạy —
  đối soát "số violation" sẽ đếm nhầm crash; cân nhắc `guardrail_ok:
  null` cho entry có `error` (cold-audit v0.4 NIT)
- 2 message concurrent cùng user_id có thể append `_histories` sai thứ
  tự (snapshot trước answer, append sau) — bounded bởi deque, chấp nhận
  pilot; nếu live cần per-user serialize (lock per user quanh cả
  answer+append)
- `_standalone` khi LLM trả `content=None` (refusal) → AttributeError —
  zalo đã catch-all + ERROR_FALLBACK; streamlit raise ra UI (hiển thị
  exception thô). Cân nhắc catch trong `_standalone` → fallback câu gốc
- PII trong `conversations.jsonl`: `question` lưu raw — khách gõ SĐT/tên
  vào log; production cần mask/retention policy (pilot: local + gitignored)
- `verify_signature` bypass khi thiếu `ZALO_APP_SECRET` — deploy public
  phải refuse-to-serve khi `DEPLOY=1` mà không có secret
- Log rotation cho `conversations.jsonl` (append vô hạn, rất chậm)

- Chatbot production trên Fanpage (Messenger API, Pancake hook) — Zalo OA
  đang ở v0.2; live OA thật cũng nằm đây nếu duyệt không kịp version
- Shopee/TikTok connector (inbox + listing sync) — dev app đã submit từ
  C2.0, chờ duyệt; catalog sync batch ≤500
- Đăng bài/listing mới lên OA/sàn — BẮT BUỘC human-approve step trong flow
  (guardrail chỉ là lưới heuristic, không thay người duyệt pháp lý)
- Zalo OA product catalog sync (27 SKU, batch ≤500)
- Zalo access_token refresh tự động (~25h expiry — hiện gán tay trong .env)
- Deploy webhook public (tunnel/VPS) + verify signature trên endpoint thật
- Agent vận hành vườn + agent báo cáo định kỳ
- Dashboard số liệu kênh
- Hồ sơ công bố SKU thật thay claims_whitelist tự trích
- TikTok pipeline, media generation (ảnh/video/avatar)
- Training package + playbook nhân viên
- Deploy public + auth
- pgvector (hiện float8[] + numpy)

## Lịch sử version

| Version | Đích | Đóng lúc | Evidence |
|---|---|---|---|
| v0.1-pilot | Demo cho bác Lực: "team làm được" | 2026-10-03 | `evidence/` — m1_crawl.log, m2_qa.md + m2_chat.png, m3_studio.png + m3_pytest.log, e2e_verify.png, demo.mp4; commits `eb5fab7`→`3ac5ef5`. Guardrail FIX (`3ac5ef5`) đã vá lỗ hổng mệnh đề ghép. Còn lại: video chưa xem thử trên máy khác; README chưa verify máy sạch |
| v0.1.1 (patch) | Mở rộng coverage: +13 điểm phân phối +10 cẩm nang sâm | 2026-10-03 | `evidence/m1b_crawl.log` — jsonl 152→175, chunks 816→916; commits `62e9a11` + FIX `17504e3` (playwright error không giết job) |
| v0.2-connector | Kênh CSKH số đầu tiên (Zalo OA bot, mock-verified) | 2026-10-04 | `evidence/v02_pytest.log` 26/26 · `v02_zalo_mock.log` 3/3 hội thoại (giá Saphraton + nguồn, showroom Đà Nẵng + nguồn, câu bẫy từ chối) · `v02_platform.md` NEEDS-INPUT chờ owner submit dev app; commits `17a1848` + `404e0d9` (check() trước khi append nguồn, sig timestamp number) + `7bc3266` |
| v0.3-hardening | Ops: đo được chất lượng + sẵn sàng live (convlog + dedup persist + eval harness) | 2026-10-04 | `evidence/v03_pytest.log` 29/29 ×3 · `v03_eval.log` 12/12 ×2 (eval harness mới `scripts/eval_qa.py`) · `v03_convlog.log` mock 3/3 + jsonl đúng schema (`answered:false` câu bẫy) · audit `audit/2026-10-04.md` (~7.4/10); commit `7f44506`. Reviewer độc lập skip (hết quota) — coordinator tự review, 3 NIT → someday: convlog `sent`/crash-log/raw-flag, PII question, signature-bypass-khi-deploy |
| v0.4-live-ready | Bot code-side sẵn sàng live OA thật: multi-turn + fail-closed deploy + convlog v2 | 2026-10-05 | `evidence/v04_pytest.log` 38/38 · `v04_eval.log` 12/12 + live multi-turn (follow-up resolve đúng Saphraton) · `v04_mock_rerun.log` 3/3 ×2 liên tiếp; commits `edfb2c6` + FIX `5013dba` (UTF-8 guard `connectors/zalo.py` — cold-audit blocker) + `c03307d` (retro). Cold-audit session lạ: verdict FIX → vá xong, 3 NIT → someday (guardrail_ok null khi crash, history order concurrent, `_standalone` content=None) |
