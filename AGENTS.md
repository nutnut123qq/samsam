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
| Ingest | `python -m ingest.embed_store` |
| Demo UI | `streamlit run app/streamlit_app.py` (hoặc `python demo.py`) |
| Zalo webhook | `python -m connectors.zalo` → :8788/zalo-webhook |
| Mock E2E Zalo | `python scripts/zalo_mock.py` |
| Eval RAG | `python scripts/eval_qa.py` (12 câu questions.md, ~90s, exit 0 nếu ≥10/12 + 2 bẫy pass) |
| Test/lint | `python -m pytest` · `ruff check .` |

## Structure
- `crawler/` — collect public site data → `data/*.jsonl`
- `connectors/` — adapters ra kênh ngoài (Zalo OA webhook); chỉ nhận/reply,
  KHÔNG đăng nội dung mới (human-gate C2.4)
- `ingest/` — chunk + embed + nạp pgvector
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
- `samsam.net.vn` là NukeViet (HTML render phức tạp); `samsamngoclinh.com` là
  WooCommerce — **thử WP REST API `/wp-json/wp/v2/...` trước**, dễ hơn parse HTML.
- Embedding lưu `float8[]` — nếu sau này cài được pgvector thì đổi cột + index,
  code retrieve tách hàm riêng để swap dễ.
- Nội dung sâm hay bị phóng đại trên web — guardrail phải filter cả data ingest.
