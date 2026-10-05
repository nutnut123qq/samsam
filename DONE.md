# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **không có** — v0.6-handoff đóng 2026-10-05.

## Checklist v0.6-handoff

Khán giả: bác Lực xem demo — "bot biết giới hạn, có lối thoát cho
người"; nhân viên đọc queue biết KB thiếu gì. Quy ước: `api/rag.py`
contract `NO_DATA` giữ nguyên (eval + `answered` semantics phụ thuộc);
`guardrail.py` cấm đụng; `HANDOFF_TEXT` hằng viết tay như `FALLBACK`.
Skip `eval_qa` (answer() không đổi — precedent patch).

- [x] **D6.1 Handoff message ở zalo layer** — `NO_DATA in raw` → gửi
  `HANDOFF_TEXT` (chưa đủ dữ liệu + nhân viên phản hồi + hotline
  1800577732) thay câu NO_DATA trần; convlog `answer` = text đã gửi,
  `answered:false` giữ (tính trên `raw`); `[handoff]` warn console.
  Streamlit chat map NO_DATA → cùng hằng.
  Gate: pytest NO_DATA → sent HANDOFF_TEXT + `answered:false`
  — *(câu bẫy mock u3 nhận đúng HANDOFF_TEXT; streamlit verify live:
    chat "có văn phòng tại Hà Nội không" → handoff + caption trỏ queue;
    reviewer vá thêm: history streamlit lưu raw parity zalo, caption
    "đã chuyển nhân viên" chỉ hiện đúng nhánh NO_DATA)*
- [x] **D6.2 Unanswered queue UI** — Streamlit tab "Chưa trả lời":
  đọc `conversations.jsonl` (+`.1`), filter `answered:false`, bảng
  ts/question(đã mask)/user_hash; empty-state khi thiếu/rỗng.
  Gate: UI chạy thật + screenshot bảng + empty-state
  (`evidence/v06_queue.png`)
  — *(`unanswered()` trong connectors/zalo.py — module sở hữu schema;
    đọc bytes + decode `replace` (surrogateescape crash st.dataframe);
    UI verify live: bảng 3 cột có entry streamlit+zalo, empty-state
    `st.info` khi convlog vắng, 0 console error)*
- [x] **D6.3 Mock E2E + gate chung** — `zalo_mock.py` câu bẫy đổi
  expected sang substring HANDOFF_TEXT; mock 3/3 (~3 call OpenRouter);
  pytest + ruff xanh
  — *(evidence `evidence/v06_pytest.log` + `v06_mock.log`;
    ship-pass bắt 1 flake `test_dedup_same_msg_id` sleep-0.3s →
    event-based như precedent v0.4.1)*

External-dependency (không treo version): notify nhân viên qua Zalo
thật cần OA creds (C2.0 chưa submit) → someday.

## Checklist v0.5.1

Khán giả: bot chuẩn bị live public — xóa hết lỗi edge-case audit v0.5 đã
chỉ ra + giảm PII-on-disk. Quy ước: đụng `api/rag.py` được phép (vá
edge-path, ghi lý do commit); `guardrail.py` cấm đụng. Skip eval/mock
theo precedent patch v0.4.1 (edge-path, happy path không đổi, tốn credit).

- [x] **D5.8 Whitespace-only answer → NO_DATA** — LLM trả `" "` →
  `answer()` trả NO_DATA + `sources:[]` (hiện trả `""` + sources → zalo
  gửi message rỗng). Gate: pytest mock content `" "` → NO_DATA, không nguồn
  — *(`(content or "").strip() or NO_DATA`; test_answer_whitespace_returns_no_data)*
- [x] **D5.9 Chunked body reject rõ** — `Transfer-Encoding: chunked` (ko
  Content-Length) → 411 thay vì length=0 → 403/400 mập mờ; hành vi định
  nghĩa trước khi bật keep-alive. Gate: pytest chunked → 411
  — *(check header trước khi đọc Content-Length; test gửi chunked thật
    qua generator, assert không có Content-Length)*
- [x] **D5.10 PII SĐT viết cách** — `_PII_RE` bắt "0901 234 567" /
  "0901-234-567" / "0901.234.567"; không over-match số ngắn/giá tiền.
  Gate: pytest spaced → "***" + regression case không bị ăn
  — *(`(?<!\d)0(?:[ .-]?\d){9,}`: ranh giới trái chặn "10.050.000.000",
    `{9,}` greedy mask hết run dài không lộ đuôi — reviewer bắt 2 bug
    boundary ở bản đầu, test_mask_pii_regex_boundaries 8 case)*
- [x] **D5.11 Convlog retention theo tuổi** — ngoài bound size D5.4
  (~10MB): purge entry cũ hơn 30d (`RETAIN_DAYS`) lúc startup + tối đa
  1 lần/ngày khi ghi + sau rotate; policy ghi `docs/deploy.md`.
  Gate: pytest purge đúng + deploy.md có mục retention
  — *(`_purge_convlog` đọc/ghi bytes + os.replace atomic — reviewer bắt
    UnicodeDecodeError crash lúc boot + U+2028 cắt đôi record ở bản đầu;
    daily-purge-on-write vá hở "process chạy lâu giữ entry quá hạn")*
- [x] **D5.12 Gate chung** — pytest toàn bộ xanh + ruff clean
  — *(51/51 `evidence/v051_pytest.log` + ruff clean)*

## Checklist v0.5-ops-ready

Khán giả: bot chạy trên VPS/tunnel public thật — deploy quên env phải
fail-closed, log không phình vô hạn, không rò PII khách vào file.

- [x] **D5.1 Deploy config cứng** — `DEPLOY` truthy (`1`/`true`/`yes`);
  `DEPLOY` + thiếu `ZALO_ACCESS_TOKEN` → refuse to serve (hiện chỉ check
  secret); `docs/deploy.md` runbook (env, DEPLOY=1, tunnel option,
  webhook URL, token refresh tay ~25h, log file)
  — *(pytest 7 nhánh; runbook gồm env table, tunnel, refresh tay)*
- [x] **D5.2 `_standalone` content=None → fallback câu gốc** — LLM
  refusal trả content=None → dùng câu gốc cho retrieval thay crash;
  streamlit không hiển thị exception thô (đụng `api/rag.py` — ghi lý do
  trong commit theo quy ước M6/M7)
  — *(vá cả `answer()` cùng lớp lỗi → NO_DATA; pytest 2 case)*
- [x] **D5.3 Convlog PII-lite** — mask SĐT/email trong `question` trước
  khi ghi jsonl (regex; tên người không detect được — ghi chú trong code)
  — *(pytest: "0901234567"+"a@b.com" → "***")*
- [x] **D5.4 Log rotation** — `conversations.jsonl` rotate sang `.1` khi
  vượt size cap (1 bản backup là đủ cho pilot)
  — *(cap 5MB; pytest cap=10B rotate đúng)*
- [x] **D5.5 Per-user serialize** — 2 message concurrent cùng user_id
  append history đúng thứ tự + reply đúng thứ tự (lock per user quanh
  answer+append+send; striping để bounded)
  — *(64-lock striping; `handle_text` wrapper → `_reply`; pytest thread
    case fail-deterministic trên code cũ)*
- [x] **D5.7 Payload cap** (phát sinh ở ship-pass, duyệt gộp vào v0.5) —
  `Content-Length` unbounded = memory DoS khi public; `>1MB` → 413,
  `<0`/malformed → 400
  — *(pytest `test_payload_too_large_rejected`)*
- [x] **D5.6 Gate chung** — pytest xanh · ruff clean · eval ≥10/12+2 bẫy
  · mock 2 lần exit 0
  — *(45/45 + ruff `v05_pytest.log` · 12/12 `v05_eval.log` · 3/3×2
    `v05_mock.log`; reviewer hết quota → coordinator tự review)*

External-dependency (không treo version): OA duyệt → live verify ở
version riêng · token auto-refresh (document manual trong runbook, auto
sau khi có credential thật) · hồ sơ công bố SKU (owner).

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

- PII trong `conversations.jsonl`: `question` đã mask SĐT/email bằng
  regex (v0.5), SĐT viết cách + retention theo tuổi vá ở v0.5.1 — còn
  lọt tên người + SĐT không bắt đầu bằng 0 (+84...) + SĐT 2+ dấu cách
  ("0901  234  567" — sep tối đa 1 ký tự, trade-off chủ đích); dòng
  parse-lỗi được giữ qua purge (PII quá hạn tới rotate kế); production
  cần mask đầy đủ hơn (pilot: local + gitignored)
- Reject-sớm 411/413 không set `close_connection` — nếu sau này bật
  HTTP/1.1 keep-alive, body sót (chunked chưa đọc / phần >1MB chưa đọc)
  nhiễu request kế trên cùng connection. Hôm nay HTTP/1.0 close mặc
  định nên đúng; nhớ `self.close_connection = True` khi bật keep-alive
  (audit v0.5.1 NIT)
- `_purge_convlog` throw (PermissionError/disk full) propagate qua
  `_log_conversation` → giết reply thread SAU khi send thành công (mất
  log); `_last_purge` set trước purge → fail thì 24h mới retry (audit
  v0.5.1 NIT — cùng lớp rủi ro append hiện hữu, chỉ nâng surface)
- Streamlit convlog ghi `"sent": False` — semantics D4.4 `sent:false`
  = send-FAIL; kênh UI không send gì → đối soát sau này đếm nhầm.
  Nên đổi `sent: null` (audit v0.6 NIT)
- `_uhash("streamlit")` cố định → mọi UI session gộp chung 1 user_hash
  trong queue; demo 1 user OK, multi-user không phân biệt được (audit
  v0.6 NIT — cân nhắc session_id khi cần)
- 2 process cùng ghi convlog (zalo + streamlit) → rotate race xuyên
  process (`_log_lock` chỉ trong-process) có thể mất file `.1`, cực
  hiếm ở pilot; nếu deploy 2 writer thật cần file-lock hoặc tách log
  (audit v0.6 NIT)
- Retention 30d purge cả entry `answered:false` → queue "Chưa trả lời"
  có horizon 30 ngày — câu nhân viên không follow-up kịp tự rơi khỏi
  queue. Consistent với intent retention; đáng nêu khi demo (audit
  v0.6 NOTE)

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
| v0.4.1 (patch) | Vá 3 NIT cold-audit v0.4: convlog `guardrail_ok:null` khi crash (trước False = đếm nhầm violation), `_histories` LRU cap 1000 user, ack-test event-based hết flake | 2026-10-05 | `evidence/v041_pytest.log` 39/39 + ruff clean; commits `1ef151a` + `a6d8ee3` (DONE). Verdict supervisor PASS; xoá thêm someday entry stale (`verify_signature` bypass — đã vá ở D4.2 `_startup_error`) |
| v0.5-ops-ready | Vá lỗ hổng vận hành trước khi webhook public: DEPLOY truthy+token fail-closed, `content=None` fallback, PII mask, log rotation, per-user serialize, payload cap | 2026-10-05 | `evidence/v05_pytest.log` 45/45 + ruff clean · `v05_eval.log` 12/12 · `v05_mock.log` 3/3 ×2; commits `589925f` (contract) + `62b27ab` + `1b0d2e4` (DONE+D5.7). Reviewer in-cycle hết quota → coordinator tự review; audit session lạ sau đó: verdict **PASS** 7/7 (pytest/eval tự chạy lại khớp), 2 NIT → someday (whitespace-only answer, chunked-body discard) |
| v0.5.1 (patch) | Vá NIT audit v0.5 + convlog hygiene: whitespace answer → NO_DATA, chunked → 411, PII SĐT viết cách, retention 30d | 2026-10-05 | `evidence/v051_pytest.log` 51/51 ×5 + ruff clean; commits `524e171` + `0cbc025` (FIX chunked test raw socket — httpx ReadError race) + `30f7395` (board) + post-audit `gitignore`+test-escape fix. Reviewer độc lập verdict FIX: blocker `_PII_RE` thiếu `(?<!\d)` (ăn giá "10.050.000.000") + `{9,}` lộ đuôi số, purge UnicodeDecodeError/U+2028/không-atomic + hở contract "file active chỉ purge lúc startup" — vá hết. eval/mock skip theo precedent patch. Cold-audit session lạ: verdict **PASS** 5/5 claims (tự chạy lại pytest 51/51 + trace regex tay), 1 minor vá ngay (`.gitignore` thiếu `conversations.jsonl*` — file runtime PII-lite), 3 NIT → someday (close_connection khi keep-alive, purge throw giết reply thread, SĐT 2+ spaces) |
| v0.6-handoff | NO_DATA → lối thoát cho người (HANDOFF_TEXT có hotline) + tab "Chưa trả lời" cho nhân viên đọc queue | 2026-10-05 | `evidence/v06_pytest.log` 54/54 (×29 runs ship-pass) · `v06_mock.log` 3/3 (câu bẫy → handoff đúng) · `v06_queue.png` bảng 3 cột + empty-state verify live; commits `658d704` + `120c4df`. Reviewer verdict FIX → vá: print raw `user_id` → `_uhash()` (3 chỗ, kể cả bug cũ), streamlit history lưu raw parity zalo (flagged không vào), caption gắn đúng nhánh, `unanswered()` decode `replace`, test loader edge. Ship-pass bắt flake `test_dedup_same_msg_id` (sleep-0.3s dưới load) → event-based. Vá kèm invariant gap: streamlit chat trước đây hiển thị answer() không qua `check()`. eval_qa skip (answer() không đổi). OWASP diff sạch. User duyệt đóng + push. Cold-audit session lạ: verdict **PASS** 3/3 claims (auditor tự chạy pytest 54/54 + đối chiếu screenshot/mock log), 4 NIT → someday (`sent:null` kênh UI, user_hash cố định, rotate race xuyên process, queue horizon 30d) |
