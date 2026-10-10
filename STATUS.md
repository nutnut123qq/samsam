# STATUS — v2.1-garden-log (2026-10-11)

## v2.1 — WS3 thứ 2: agent nhật ký vùng trồng (contract trong DONE.md)

**4/4 mục triển khai xong, gate xanh.** `python -m pytest -q` 159/159;
`tests/test_garden.py` 12/12 ×3; `ruff check .` clean. CLI live trên
DB thật: add KV-A01 → nhật ký #25 (source `manual:garden`, alias
"kiem tra sau benh" → "kiểm tra sâu bệnh"); plot sai/trùng/thiếu-arg
→ exit 2 warn friendly; `--check` in keyword anomalies; dead-host
`10.255.255.1` → check exit 0 "chưa nạp" / add exit 2. Playwright
(`.venv` + python global): live submit → row verify trong DB (canvas
dataframe — gotcha đã ghi), dead-DB → st.info, console 0 lỗi cả hai
nhánh — `v21_garden_tab.png`/`v21_garden_submit.png`/`v21_garden_dead.png`.
Cold-check: **PASS coordinator self-review** đợt 1 — subagent quota
cạn (precedent v0.3/v0.5). E2E bắt bug thật: `with conn.transaction()`
trên conn đã-trong-tx chỉ là savepoint → INSERT rollback ngầm dù
`returning id` trả id; vá `conn.commit()` tường minh + test assert
committed. NIT → someday trong DONE.md.

### Đọc diff cần biết

- **`agents/garden.py`** (mới): `normalize_activity` (vocab 8 +
  ALIASES fold NFD/bỏ-dấu; lạ → nguyên văn + warn, rỗng → "ghi nhận");
  `add_log(conn, plot_id, ts, activity, detail, author, source)` →
  (id|None, warns) — FK → "khoảnh không tồn tại", unique
  `(plot_id,ts,activity)` → "đã có nhật ký trùng", KHÔNG raise;
  **`conn.commit()` bắt buộc sau `with conn.transaction()`** — caller
  có thể đang trong tx ngoài (UI đã SELECT) thì block chỉ là
  savepoint; `flags_for` dùng `report.FLAG_KEYS` (không duplicate);
  `anomaly_check(conn, gap_days=14, now=None)` → no-logs/gap/keyword;
  `active_plots`, `recent_logs(limit=20)`; `_coerce_ts` (date/naive
  →UTC/ISO 'Z'/ISO date). CLI `python -m agents.garden --plot P
  --activity A [--detail --author --ts]` / `--check [--gap-days]`.
  UTF-8 guard cho console cp1258. Không LLM → không cần guardrail
  (invariant chỉ áp text AI sinh).
- **`app/streamlit_app.py`** — tab thứ 6 "Nhật ký vườn": selectbox
  khoảnh `id — location` từ `active_plots`; activity vocab +
  "khác…"→free-text; `date_input` (guard None); submit → `add_log`
  → success `#id` + warning vàng; panel "Cần chú ý" = anomaly_check;
  bảng `recent_logs` (ts UTC string, canvas); `_pg.Error` → info.
- **`tests/test_garden.py`** (mới, 12): fake-conn `_Conn` dispatch
  theo substring+params (pattern `test_report.py`); `_ErrConn` raise
  psycopg.errors.* cho FK/unique; `conn.committed` counter cho
  savepoint-regression; anomaly_check inject `now` cho deterministic.

### Evidence v2.1

| Mục | File |
|---|---|
| CLI live + dead-host | `evidence/v21_garden.log` — #25 ghi thật, toàn bộ exit-code branch |
| UI live + dead-DB | `evidence/v21_streamlit.log` + `v21_garden_tab.png` / `v21_garden_submit.png` / `v21_garden_dead.png` |
| Gate chung | `evidence/v21_pytest.log` — focused 12/12 ×3, full 159/159, ruff clean |

External: plots/nhật ký vườn hiện là **dữ liệu mẫu** (`sample:*`) +
1 row demo `manual:garden` — nhãn mẫu khi demo; khoảnh thật chờ bàn
giao SOW §5.2. Audit bù: `/cold-audit` range `1553e81..HEAD` khi
quota subagent về (cover v2.0+v2.1 self-review).

---

# STATUS — v2.0-report-agent (2026-10-10)

## v2.0 — WS3: agent báo cáo định kỳ ra FILE (contract trong DONE.md)

**4/4 mục triển khai xong, gate xanh.** `python -m pytest -q` 147/147;
`tests/test_report.py` 16/16 ×3; `ruff check .` clean. CLI ×2
idempotent; dead-DB probe bằng host chết thật (10.255.255.1,
connect_timeout=3) → báo cáo degraded "[chưa nạp]" ×3 + exit 0.
Playwright (`.venv` + global python) kiểm UI thật cả nhánh DB live
(5 tabs, sinh + render report, errors=0) lẫn DB-unavailable (warning
DEGRADED, tab không hang) — `evidence/v20_report_tab.png` /
`v20_report_dead.png`. Cold-check: **PASS coordinator self-review**
(reviewer subagent quota-exhausted — precedent v0.3/v0.5): coordinator
tự chạy lại 147/147 + ruff + live/dead-DB CLI probe khớp evidence;
4 NIT → someday trong DONE.md.

### Đọc diff cần biết

- **`agents/` (package mới)** — nhà cho 3 agent WS3. `agents/report.py`:
  `python -m agents.report [--days N] [--until YYYY-MM-DD]` →
  `data/reports/report-<since>_<end>.md` (atomic tmp+os.replace,
  bytes utf-8; gitignored). Tổng hợp orders/leads/plot_logs/plots/
  products + convlog (file-based — mục 3 luôn có khi DB chết).
  Markdown 6 mục: bán hàng (đơn/doanh thu kỳ vs kỳ trước, kênh, top
  SP "Ngoài catalog"), leads (mới/chờ xử lý/intent/kênh + 5 câu gần
  nhất), kênh chat (in-period + all-time, `answered` strict `is
  True`), vùng trồng (nhật ký + flag keyword sâu-bệnh), social
  "chờ bàn giao", nguồn dữ liệu per-table. Bảng toàn `source
  'sample:*'` → nhãn *(mẫu)* ngay trong báo cáo. Tái dùng
  `lead_store.connect/iter_convlog/_parse_ts/channel_of`
  (connect_timeout=3, BYTES+split `\n`).
- **`app/streamlit_app.py`** — tab thứ 5 "Báo cáo": chọn kỳ 7/14/30
  → "Sinh báo cáo" → `generate()`; list `data/reports/*.md` mới nhất
  trước → xem rendered; degraded → warning vàng; dir trống → info.
- **Human-gate**: báo cáo là BẢN NHÁP — duyệt + gửi lãnh đạo do
  NGƯỜI (C2.4); hệ thống KHÔNG gửi Zalo/email. Không LLM → output
  không cần guardrail check (invariant chỉ áp text AI sinh).
- **Gotcha phát hiện**: `env -u DATABASE_URL` KHÔNG phải nhánh
  degraded — `connect()` tự `load_dotenv(ROOT/.env)` nạp lại DSN;
  nhánh connect→None verify bằng monkeypatch/dead-host.

### Evidence v2.0

|| Mục | File |
|---|---|---|
|| CLI ×2 + --until/--days + dead-DB probe | `evidence/v20_report.log` |
|| Report mẫu sinh ra | `evidence/v20_report.md` |
|| UI live + DB-unavailable | `evidence/v20_streamlit.log` + `v20_report_tab.png` + `v20_report_dead.png` |
|| Gate chung | `evidence/v20_pytest.log` — focused 16/16 ×3, full 147/147, ruff clean |

External: social metrics (FB/TikTok/OA) chờ Phụ lục C — mục 5 báo
cáo là placeholder; gửi báo cáo cho lãnh đạo là bước NGƯỜI. Số liệu
orders/plot_logs/plots đang là DỮ LIỆU MẪU (nhãn *(mẫu)* trong
report). Someday: LLM commentary qua guardrail check, lịch định kỳ
(Task Scheduler/cron), anomaly nhật ký vườn sâu hơn, leads
retention/redaction (v1.9).

---

# STATUS — v1.9-leads (2026-10-10)

## v1.9 — WS2 nền: harvest lead từ convlog + dashboard (contract trong DONE.md)

**4/4 mục triển khai xong, gate xanh.** `python -m pytest -q` 131/131;
`tests/test_lead_store.py` 13/13 ×3; `ruff check .` clean. Playwright
đã kiểm UI thật cả nhánh DB live và DB-unavailable; ảnh
`evidence/v19_dashboard.png`. Cold-check auditor lạ: **PASS** đợt 1 —
2 MINOR + 1 NIT → someday trong DONE.md.

### Đọc diff cần biết

- **`docs/schema.sql`**: +bảng `leads`, chỉ `create table if not exists`
  (8 bảng public); unique `dedup_key`. Bảng lead insert-only, không
  mirror/delete theo convlog vì log gốc rotate + purge 30 ngày.
- **`ingest/lead_store.py`**: đọc convlog + `.1` bằng BYTES/split `\n`;
  edge corrupt/missing/0-record/thiếu-field/ts-sai/`_doc` skip+đếm;
  heuristic intent partner/order/price/contact; dedup `msg_id` hoặc
  hash16(ts|user_hash|question); mỗi row `on conflict do nothing`.
  DB connect timeout 3s; convlog stats vẫn đọc được khi DB unavailable.
- **`app/streamlit_app.py`**: tab Leads read-only — convlog channel/answer
  rate luôn hiện, lead metrics + latest 20 rows khi DB lên, info fallback
  khi DB lỗi/thiếu bảng; timestamps UTC, columns sized to fit.
- Lead `question`/`user_hash` persist beyond convlog retention; intent
  heuristic có false-positive — ghi trong DONE Someday, cần retention/
  privacy decision trước go-live (C2.0).

### Evidence v1.9

| Mục | File |
|---|---|
| Schema apply ×2 | `evidence/v19_schema.log` — 8 bảng public |
| Harvester thật ×2 + PostgreSQL rollback probe | `evidence/v19_leads.log` — 30 rows; public table 30→30; temp transaction proves 30 new then 30 dup |
| UI live + DB unavailable | `evidence/v19_streamlit.log` + `evidence/v19_dashboard.png` |
| Gate chung | `evidence/v19_pytest.log` — focused 13/13 ×3, full 131/131, Ruff clean |

External: 30 leads currently visible are mock/replay/UI-test data, not
real customers — label them as sample in demos until OA live/C2.0;
dashboard v1.9 only covers convlog channel + leads, not social metrics.
Content pipeline đa kênh + human-gate/lịch đăng, WS3 agents, WS4
playbook/SOP/Phụ lục D còn ở Someday theo SOW.

---

# STATUS — v1.8-core-db (2026-10-10)

## v1.8 — WS1 nền tảng: DB lõi + Phụ lục A (contract trong DONE.md)

**4/4 mục xong, gate xanh.** `python -m pytest` 114/114, `ruff check .`
clean. Bắt đầu workstream SOW (WS1–WS4 chưa build = việc thật, override
kết luận no-work của loop trước).

### Đọc diff cần biết

- **`docs/schema.sql`**: +6 bảng lõi WS1 (`products`, `claims_approved`,
  `plots`, `plot_logs`, `orders`, `assets`) — chỉ `create if not exists`,
  `chunks` nguyên. Mọi bảng có cột `source` = file/nguồn nạp; `orders`
  KHÔNG có cột PII khách (quyết định pilot).
- **`scripts/apply_schema.py`** (mới): apply schema.sql qua psycopg
  multi-statement — máy không có psql; idempotent.
- **`ingest/core_store.py`** (mới): `python -m ingest.core_store` nạp
  products.jsonl→products+assets(image), articles/news→assets(article),
  claims_whitelist.json→claims_approved (sku "chưa có công bố" → row
  claim=NULL), sample_*.jsonl→plots/plot_logs/orders. Delete-by-source
  2 pha (con trước cha sau) → idempotent + không đè `source='manual'`.
  Claim→product link best-effort qua segment `<slug>.html` (9/10 sku
  link; savitim NULL đúng — source là bài news). Edge ghi trong
  docstring: row manual trỏ product do loader quản mất link sau reload.
- **`data/sample_*.jsonl`** (mới): DỮ LIỆU MẪU chờ bàn giao (SOW §5.2),
  dòng `_doc` đánh dấu + loader skip.
- **`scripts/data_audit.py`** (mới): bảng kê Phụ lục A đếm thật theo
  `source`; `docs/phu-luc-a.md` = draft Phụ lục A + cột "chờ bàn giao".

### Evidence v1.8

| Mục | File |
|---|---|
| Schema apply ×2 | `evidence/v18_schema.log` — 7 bảng public |
| Loader ×2 idempotent | `evidence/v18_core_store.log` — products 27 / claims 22 / plots 3 / plot_logs 6 / orders 5 / assets 219 |
| Phụ lục A | `evidence/v18_audit.log` — 10 dòng domain đếm theo source |
| Gate chung | `evidence/v18_pytest.log` — 114/114 + ruff clean |

### Cycle sau (SOW, đã ghi someday trong DONE.md)

WS2: leads từ convlog + dashboard số liệu kênh; pipeline brief→draft→
compliance→DUYỆT NGƯỜI→format đa kênh→lịch đăng (KHÔNG tự đăng). WS3:
agent báo cáo định kỳ ra file + nhật ký vườn form/chat→chuẩn hóa→cảnh
báo. WS4: playbook/SOP + Phụ lục D test-set.

---

# STATUS — v1.0-live-prep (2026-10-07)

## v1.0 — plug-and-play khi có OA creds (contract trong DONE.md)

**6/6 mục xong, gate xanh.** `python -m pytest` 77/77, `ruff check .`
clean, `zalo_mock.py` 3/3 exit 0, `zalo_preflight.py` exit 1 báo đúng
mục thiếu trên dev. Reviewer FIX→PASS; cold-check auditor lạ chạy lại
toàn bộ gate: UNVERIFIED **chỉ** ở live Zalo contract (oauth refresh
v4, getoa, mã lỗi token, OA-secret signature) — theo thiết kế chờ creds
C2.0, verify lúc go-live bằng `scripts/zalo_preflight.py`.

### Đọc diff cần biết

- **`connectors/zalo.py`**: tách 2 secret — `OA_SECRET` (signature
  webhook) vs `APP_SECRET` (oauth refresh header `secret_key`).
  Token store `data/zalo_tokens.json` (gitignored, atomic write,
  chmod 600 POSIX) là source-of-truth sau refresh đầu; env chỉ seed.
  `refresh_access_token()` dưới `_token_lock` (rotation serialize);
  send-fail → refresh (throttle 60s — reviewer M3) → retry 1 lần;
  transport error không retry (tránh reply đôi). Non-text
  `user_send_*` → `NON_TEXT_TEXT` + convlog `answered:false`
  (`question=[non-text:<event[:50]>]`).
- **`scripts/zalo_preflight.py`** (mới): 5 check env/db/openrouter/
  token(getoa)/signature round-trip; `--refresh` ép rotation thật
  (reviewer M1); `check_env` mirror `_startup_error` đọc store.
- **`scripts/zalo_mock.py`**: `APP_SECRET`→`OA_SECRET` — mock verify
  signature thật lại.
- **`env.example`** (mới, tên không-dot — `.env*` bị write-policy
  chặn), **`docs/zalo-webhook.service`** (systemd mẫu — comment tách
  dòng riêng, systemd không hỗ trợ inline), **`docs/deploy.md`**
  rewrite: auto-refresh, HTTPS bắt buộc, go-live checklist.

### Evidence v1.0

| Mục | File |
|---|---|
| Gate chung | `evidence/v10_pytest.log` — 77/77 + ruff clean |
| Mock E2E | `evidence/v10_mock.log` — 3/3 |

---

# STATUS — v0.3-hardening (2026-10-04) + ca đêm M1→M4

## v0.3 — ops: log + eval + gate (contract trong DONE.md)

**6/6 mục xong, gate xanh.** `pytest` 29/29 (×3 lần, không flaky),
`ruff check .` clean, `eval_qa` 12/12 ×2 lần chạy thật, mock E2E 3/3.

```
(uncommitted) — chờ duyệt đóng version ở cửa người 2
```

### Đọc diff cần biết

- **`connectors/zalo.py`**: `_seen` dict → sqlite `data/zalo_seen.db`
  (lazy init — file chỉ sinh ở dedup đầu, không phải lúc import);
  `handle_text(u, q, msg_id="")` ghi `data/conversations.jsonl`
  {ts,msg_id,user_hash,question,answer[:500],sources,guardrail_ok,
  latency_ms,answered}. Dedup/non-text → không log. `answered` dùng
  `NO_DATA not in answer` — khớp semantics rag.py.
- **`scripts/eval_qa.py`** (mới): eval 12 câu questions.md — exit 0 iff
  ≥10/12 VÀ 2 bẫy pass. EXPECTED hardcode theo số câu; sanity check
  parse-vs-map bắt lệch file.
- **`scripts/zalo_mock.py`**: UTF-8 stdout guard — console Windows
  cp1258 crash khi in tiếng Việt; bỏ noqa E402 thừa (RUF100).
- **`tests/test_zalo.py`**: autouse fixture trỏ SEEN_DB/CONV_LOG →
  tmp_path; +3 case (persist-qua-restart, log schema, answered:false).
- **`.gitignore`**: +`data/conversations.jsonl`, +`data/zalo_seen.db`
  (runtime, có user_hash — không commit).
- Reviewer độc lập KHÔNG chạy được (hết quota subagent) — coordinator
  tự review: không blocker, 3 NIT đã ghi someday (convlog `sent`/
  crash-log/raw-flag, PII trong question, signature-bypass-khi-deploy).

### Evidence v0.3

| Mục | File |
|---|---|
| D3.2 eval | `evidence/v03_eval.log` — 12/12 |
| D3.3+D3.4 log | `evidence/v03_convlog.log` — mock + 3 dòng jsonl |
| D3.5+D3.6 gate | `evidence/v03_pytest.log` — 29/29 + ruff clean |

---

## Ca đêm M1→M4 (viết cho người đọc diff)

## Kết quả

**M1–M4 hoàn tất, 4 commit mới, gate xanh.** `pytest` 11/11, `ruff check .` clean.

```
f035812 T4.1: demo.py 1-lenh (env+deps+db+streamlit) + video demo.mp4 38s + script quay
54bc05f T3.2: content.draft() qua OpenRouter + Content Studio tab; guardrail them claim-core match + disclaimer TPBVSK exemption
85ae7b7 T3.1: guardrail 2 lop — banned words (co dau + viet tran) + claim whitelist theo SKU
a6f28fe M2: ingest 816 chunks vao Postgres + chat RAG kem nguon   (ca truoc)
eb5fab7 M1: crawl 2 site public -> jsonl + claims whitelist        (ca truoc)
```

## Đọc diff đêm nay cần biết

**`pipelines/guardrail.py`** (T3.1 + 2 vá trong T3.2):
- Match banned words cả có dấu lẫn viết trần; span không dấu chỉ flag khi
  text gốc cũng viết trần → "thuộc" (belong) không bị bắt nhầm "thuốc".
- Approved claim là "vùng an toàn": banned span con trong claim đã công bố
  (vd "hỗ trợ hạ đường huyết" ⊃ "hạ đường huyết") không flag.
- `SAFE_PHRASES`: disclaimer pháp lý bắt buộc TPBVSK ("không phải là
  thuốc", "thay thế thuốc chữa bệnh") chứa từ cấm theo nghĩa phủ định →
  miễn. Nếu không có exemption này, mọi bài hợp lệ đều bị flag.
- Claim match theo SKU được nhắc trong text; không nhắc → pool tất cả SKU.
  Claim "cùng ý" (khác động từ dẫn hỗ trợ/giúp) match qua claim-core;
  substance phải nguyên văn → "tăng cường trí nhớ" vẫn flag.
- Clause có claim-verb mà không khớp whitelist → `unverified_claim`.

**`pipelines/content.py`**: draft() gọi OpenRouter (OR_CHAT_MODEL), system
prompt nhét whitelist + luật TPBVSK; vi phạm → 1 lượt rewrite có feedback
rồi check() lại; trả {"text","guardrail"} — text luôn đã qua check().

**`app/streamlit_app.py`**: tab Content Studio = brief + kênh → draft →
hiển thị text + guardrail (violations đỏ, matched_claims caption) + ô
"check text có sẵn" chạy guardrail trực tiếp. Draft persist trong
session_state để còn nhìn khi rerun.

**`demo.py`** (T4.1): 1 lệnh = check .env → pip deps thiếu → tạo schema +
ingest nếu `chunks` trống → `streamlit run`. Verify thật trên máy này:
DB 816 chunks sẵn → skip ingest → UI lên :8501 HTTP 200.

**`requirements.txt`**: thêm playwright + imageio-ffmpeg dưới comment
"chi can khi quay lai video demo".

## Evidence

| Task | File | Nội dung |
|---|---|---|
| T3.1 | `evidence/m3_pytest.log` | 11/11 pass gồm case "chữa khỏi tiểu đường" |
| T3.2 | `evidence/m3_studio.png` | Draft PASS xanh + text vi phạm flag đỏ 7 violation |
| T4.1 | `evidence/demo.mp4` | 38s: chat trả giá Saphraton kèm nguồn → Studio draft PASS → "chữa khỏi tiểu đường" flag đỏ |

## NEEDS-INPUT / lưu ý review

- **"README verify trên máy sạch"** — chỉ verify được trên máy này
  (`.venv` + Postgres + `.env` có sẵn). Máy sạch cần: Python 3.12,
  PostgreSQL local, `.env` 2 key. Chưa test được path cài mới 100%.
- Guardrail heuristic ở lớp claim — đủ cho demo; sản xuất cần review bằng
  người/LLM-check nếu dùng thật.
- `git push` chưa chạy (theo luật). DB chỉ ghi vào `samsam` local.
