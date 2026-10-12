# samsam — Agent Guide

## Overview
Pilot "chuyển đổi số + AI" cho Công ty TNHH Sâm Sâm (sâm Ngọc Linh, Quảng Nam/Đà Nẵng).
Bản thu nhỏ của SOW (`SOW_SamSam_AI_6-thang.md`): crawl data public → knowledge base
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
| Ingest | `python -m ingest.embed_store` |
| DB lõi WS1 | `python scripts/apply_schema.py` → `python -m ingest.core_store` |
| Role DB + duyệt (v3.4) | `python scripts/apply_schema.py --roles` (schema + `docs/roles.sql`: `agent_writer`/`app_human`) · `python -m pipelines.store --verify-log` (kiểm hash chain `agent_action_log`) |
| Đăng nhập UI (v3.4) | `AUTH_MODE=proxy\|local\|dev` (trống = chặn) · `python -m pipelines.auth --hash` (tạo hash scrypt cho `data/users.json`, gitignored) |
| Golden master (v3.2) | `python -m ingest.golden_store` (nạp `data/golden_skus.json` + phiếu lệch) · `--report` · `--approve-price <id> --by <tên>` (CHỈ người thật duyệt giá — agent không chạy) |
| File sàn (v3.3, chỉ đọc) | `python -m ingest.market_csv --file <csv/xlsx> --channel shopee\|tiktok --kind listing\|order\|ads` (idempotent theo sha256 file, bỏ cột PII, mở/đóng `market_alerts`) · `--report` — mapping cột `data/market_csv_map.json` chưa xác minh với file thật |
| KB nội bộ (v3.9) | `python -m ingest.kb_internal --file <.md\|.txt> --collection internal:<phong> --approved-by "<trưởng phòng>"` (bảng riêng `chunks_internal`, chatbot khách không đọc; CHỈ người thật duyệt — agent không điền tên) |
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
| Số hóa tài liệu (F15.1) | `python -m ingest.doc_intake` (intake `DOC_INTAKE_DIR`) · `--pending` · `--verify <sha256> --by "<tên>"` · `--reject <sha256> --by "<tên>"` |
| Eval RAG | `python scripts/eval_qa.py` (12 câu questions.md, ~90s, exit 0 nếu ≥10/12 + 2 bẫy pass) |
| Eval theo agent | `python scripts/agent_eval.py --agent guardrail\|chatbot` (ca `data/eval/`, ngưỡng `config.json`, ghi `eval_runs`; `--no-record`/`--allow-dirty`) |
| Cổng deploy | `python scripts/deploy_gate.py --sha <SHA> --approved-by "<tên>" [--hotfix]` (chỉ in kế hoạch; cần PASS + người duyệt + luật đóng băng theo lịch `data/freeze_calendar.json` qua `pipelines/freeze.py` — trong 21/12–10/02 chỉ `--hotfix` hoặc break-glass còn hạn) |
| Hàng duyệt chung (v4.0) | `python -m pipelines.approval_queue --pending [--block K]` · `--approve/--reject ID --by "<tên>"` · `--override-qa ID --by "<tên>" --reason ".."` · `--expire` (mọi loại việc trừ content_draft; quá SLA → expired, không tự duyệt) |
| Bản tin GĐ khối (v4.0) | `python -m pipelines.director --block K` · `--all --dry-run` (cấu hình `data/directors/<khối>.json`, 11 khối; bản tin → `data/reports/director-*.md`, không tự gửi) |
| Cảnh báo đỏ (v4.0) | `python -m pipelines.red_alert --check-routing` (exit 1 = chưa có người nhận độc lập — `data/red_alert_routing.json`, external-dep) |
| Test/lint | `python -m pytest` · `ruff check .` |

## Structure
- `crawler/` — collect public site data → `data/*.jsonl`; `intel`
  thu tin thị trường RSS/Atom tầng A/B → `intel_items` (chỉ tiêu đề +
  trích ≤300 ký tự + link, không toàn văn; không ghi bảng khác)
- `connectors/` — adapters ra kênh ngoài (Zalo OA webhook); chỉ nhận/reply,
  KHÔNG đăng nội dung mới (human-gate C2.4)
- `ingest/` — chunk + embed + nạp chunks (`embed_store`); `core_store`
  nạp DB lõi WS1 (products/claims_approved/plots/plot_logs/orders/assets,
  delete-by-source idempotent — row `source='manual'` không bị đè);
  `golden_store` nạp golden master (sku_master/sku_map/price_list
  append-only/golden_discrepancies — upsert, không xóa trắng, chỉ đọc
  products); `market_csv` nạp file xuất Seller Center vào staging
  (market_snapshots/market_rows/market_alerts — chỉ đọc golden, không
  ghi sàn/giá, không PII người mua)
- `pipelines/` — content draft + guardrail check (claim whitelist + banned words)
- `app/` — Streamlit demo (3 tab: Chat, Content Studio, Chưa trả lời)
- `data/` — jsonl dump, `claims_whitelist.json`, `banned_words.txt`
- `tests/` — pytest
- `TASKS.md` — task board M1–M5, boundary + gate + evidence từng task
- `SOW_SamSam_AI_6-thang.md` — hợp đồng draft là context gốc

## Invariants
- **Guardrail trước content**: mọi text AI sinh ra phải qua `pipelines.guardrail.check()` trước khi hiển thị/đăng.
- Chatbot trả lời phải kèm nguồn (URL); không bịa công dụng y tế.
- Từ cấm tuyệt đối trong output: "chữa", "điều trị", "thuốc", "khỏi bệnh" — list đầy đủ ở `data/banned_words.txt`.
- Tài khoản/keys đọc từ `.env`; secret không vào code/git.
- Crawl delay ≥1s/request, chỉ trang public.

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
