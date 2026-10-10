# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **v2.0-report-agent** (cycle 3/10 — WS3)

v1.9-leads đóng 2026-10-10 (cold-check PASS đợt 1; 2 MINOR + 1 NIT
→ someday: intent substring ăn "đánh giá"/"ship"/"ở đâu", `convlog_stats`
đếm `answered` bằng truthiness; retention/redaction leads quyết trước
khi nạp khách thật C2.0).

v1.8-core-db đóng 2026-10-10 (cold-check PASS đợt 3 — đợt 1+2 FIX cùng
lớp lỗi "delete-trắng": file nguồn thiếu vá ở `6d9b6b5`, file rỗng/
0-record vá ở `d120185`; 3 MINOR + 1 NIT → someday nhóm loader).

v1.7-edge-hardening đóng 2026-10-09 (cold-check PASS đợt 1; 2 MINOR
vá ngay — khôi phục assert msg-key cleanup + thêm case CL `abc`/`0`
vào test; 1 MINOR → someday: domain `b..c`/`@@b.com` dạng-lạ không
mask).

## Checklist v2.0-report-agent

Khán giả: buổi đàm phán SOW / demo cho bác Lực — "agent báo cáo định
kỳ" là agent thứ 2 trong WS3 (SOW §WS3: "tổng hợp sales + social
metrics → Zalo/email lãnh đạo"; bản pilot ra FILE markdown trong
`data/reports/`, duyệt + gửi do NGƯỜI — human-gate C2.4, KHÔNG tự
gửi). Chọn cụm này (gợi ý coordinator, xác nhận sau khảo sát) vì rẻ
nhất + mạch tự nhiên: consume đúng DB lõi v1.8 (orders/plot_logs/
plots/products) + leads/convlog v1.9 vừa build, ra file là evidence
demo trực tiếp, KHÔNG phụ thuộc data/creds ngoài (social metrics =
mục "chờ bàn giao" trong chính báo cáo). Cụm bị loại: pipeline nội
dung đa kênh WS2 (lớn — format FB/TikTok/blog/Zalo OA + lịch đăng +
flow duyệt, để cycle sau); agent nhật ký vườn WS3 (cần form/chat →
chuẩn hóa — cụm riêng); trợ lý tri thức nội bộ (trùng chatbot RAG đã
có — ít giá trị thêm).

Quy ước precedent: `guardrail.py`/`api/rag.py`/`connectors/zalo.py`
KHÔNG đụng; skip eval_qa + zalo_mock (answer/reply path không đổi);
không global mutable mới trong zalo.py. KHÔNG thêm/sửa bảng — báo cáo
là FILE runtime (`data/reports/`, gitignored, atomic tmp+`os.replace`,
ghi bytes UTF-8 tránh `\n`→`\r\n` trên Windows). Không dùng LLM →
output không cần guardrail check (invariant chỉ áp text AI sinh; LLM
commentary để someday). Tái dùng từ `ingest.lead_store`: `connect`
(DSN + `connect_timeout=3`), `iter_convlog` (BYTES + split `\n`,
corrupt/`_doc`/io-error skip+đếm), `channel_of`, `_parse_ts`. Mọi
connect `connect_timeout=3`; nhánh DB-unavailable verify bằng host
chết thật (env `DATABASE_URL` giả khi spawn — KHÔNG mock
`connect()→None`). `answered` convlog đếm STRICT `is True` — khác
`convlog_stats` truthiness (NIT cold-check v1.9; fix-forward ở code
mới, không vá lead_store trong version này). Bảng toàn `source like
'sample:%'` → section gắn nhãn *(mẫu)* ngay trong báo cáo — demo
KHÔNG được để người xem tưởng số vận hành thật (orders/plots/
plot_logs hiện đều mẫu chờ bàn giao).

- [ ] **W3.1 Module `agents/report.py`** — package mới `agents/`
  (nhà cho 3 agent WS3): `period_bounds(days, until)` → (since,
  until_excl) aware UTC; `collect_db(conn, since, until)` → sales
  (đơn/doanh thu kỳ + kỳ trước, theo kênh/trạng thái/top sản phẩm
  left-join products "Ngoài catalog" khi product_id null) + leads
  (mới kỳ + kỳ trước, tổng, chờ xử lý, intent/channel, 5 câu hỏi
  mới nhất) + farm (plot_logs kỳ, theo khoảnh/hoạt động, flag
  bất-thường keyword sâu-bệnh, plots/cây đang quản) + `sources`
  per-table + `sample` flag; `psycopg.Error` → `db_ok=False`.
  `collect_chat(data_dir, since, until)` → convlog theo kỳ + toàn
  thời gian (file-based, luôn có; ts hỏng/ngoài kỳ đếm riêng).
  `render(rep)` → markdown tiếng Việt đủ section: bán hàng, leads,
  kênh chat, vùng trồng, social "chờ bàn giao", nguồn dữ liệu +
  DB status; degraded → phần DB "[chưa nạp — <err>]"; footer
  human-gate "BẢN NHÁP — người duyệt, hệ thống KHÔNG tự gửi".
  `report_name(since, until)` → `report-<since>_<end>.md`;
  `write_report` atomic; `generate(days, until, out_dir, conn)`
  → (path, rep); `list_reports`. Edge enumerate: DB down →
  degraded; bảng thiếu (UndefinedTable) → degraded; kỳ 0-row →
  số 0 không crash; convlog thiếu → zeros; `total_vnd`/`qty`/
  `product_id` null → coalesce; out_dir chưa có → mkdir; viết
  lại cùng kỳ → ghi đè idempotent.
  - Boundary: `agents/__init__.py`, `agents/report.py`
  - Gate: unit tests W3.4 xanh
  - Evidence: `evidence/v20_report.log`
- [ ] **W3.2 CLI `python -m agents.report` + gitignore** — argparse
  `--days N` (default 7, ≥1), `--until YYYY-MM-DD` (mặc định hôm nay
  UTC, = ngày cuối kỳ inclusive), `--out-dir` (default
  `data/reports`); in kỳ + path + topline; DB down → `[warn]` + vẫn
  ghi file degraded + **exit 0** (precedent `data_audit.py` "chưa
  nạp, exit 0"). `.gitignore` += `data/reports/` (runtime artifact).
  - Boundary: `agents/report.py`, `.gitignore`
  - Gate: run ×2 → cùng filename ghi đè (idempotent); run với
    `DATABASE_URL` trỏ host chết → file degraded vẫn ghi, exit 0
  - Evidence: `evidence/v20_report.log` + report .md copy thành
    `evidence/v20_report.md`
- [ ] **W3.3 Tab "Báo cáo" (thứ 5) trong streamlit** — caption
  human-gate; selectbox kỳ 7/14/30 + nút "Sinh báo cáo" →
  `generate()` → success path (warn vàng khi degraded); list
  `data/reports/*.md` mới nhất trước → selectbox → `st.markdown`
  nội dung; dir trống → `st.info` không crash; DB down → tab vẫn
  render + sinh được file degraded.
  - Boundary: `app/streamlit_app.py`
  - Gate: Playwright qua `.venv` (path tuyệt đối vào evidence/) —
    DB live: tab render + sinh report + nội dung hiện, console
    errors=0; DB-unavailable (spawn streamlit env `DATABASE_URL`
    giả — host chết thật): tab vẫn render + sinh được file degraded
  - Evidence: `evidence/v20_streamlit.log`,
    `evidence/v20_report_tab.png`
- [ ] **W3.4 Tests + gate chung** — `tests/test_report.py`: period
  math (default now / `--until` → end-exclusive + since=-days);
  `_fmt_vnd`; `collect_db` fake-conn dispatch theo (substr, params)
  — period params đúng, prev-period query, `db_ok` flag, sample
  detect `sample:%`; `collect_db` raise `psycopg.Error` →
  `db_ok=False`; `collect_chat` period filter + edge (file thiếu/
  corrupt/`_doc`/ts sai/ts ngoài kỳ/`answered` strict); `render`
  đủ section + nhãn *(mẫu)* + degraded "[chưa nạp]" + footer
  human-gate; `report_name` deterministic; `write_report` atomic +
  ghi đè + không sót `.tmp`; `generate` end-to-end tmp_path — conn
  giả → file có số liệu, `connect()→None` → file degraded.
  `python -m pytest -q` full + `ruff check .` + `git diff --check`.
  - Boundary: `tests/test_report.py`
  - Gate: targeted xanh ×3; full suite xanh; ruff clean; diff sạch
  - Evidence: `evidence/v20_pytest.log`

External-dependency (không treo version): social metrics (Fanpage/
TikTok/Zalo OA API) chờ creds Phụ lục C — báo cáo có mục "chờ bàn
giao", tự điền khi có nguồn. Gửi báo cáo Zalo/email lãnh đạo là
bước NGƯỜI (C2.4) — hệ thống chỉ ra file. Someday: LLM commentary
(qua `guardrail.check()` theo invariant); chart/delta dài kỳ;
schedule helper (Task Scheduler/cron snippet trong docstring);
anomaly nhật ký vườn sâu hơn (thuộc agent nhật ký — cụm khác).

## Checklist v1.9-leads

Khán giả: buổi đàm phán SOW / demo cho bác Lực — "mỗi khách nhắn hỏi
giá/mua/địa-chỉ qua Zalo OA hay UI đều tự thành lead trong DB, nhân
viên mở tab Leads thấy danh sách + số liệu kênh" (SOW §WS2: "chatbot
gom lead" + "dashboard số liệu kênh + leads"). Phần còn của WS2 —
pipeline nội dung đa kênh + lịch đăng có human-gate — là cụm lớn hơn,
để cycle sau. Quy ước precedent patch: `guardrail.py`/`api/rag.py`/
`connectors/zalo.py` KHÔNG đụng (leads chỉ ĐỌC convlog — không đụng
reply path, không đăng nội dung mới); skip eval_qa + zalo_mock; không
global mutable mới trong zalo.py → `_isolated_files` giữ nguyên;
schema chỉ `create table if not exists` (→ 8 bảng public, không
sửa/drop 7 bảng cũ); convlog là file user-influenced → đọc BYTES +
split `\n` tường minh (AGENTS.md). **leads KHÔNG dùng delete-by-
source** của core_store: convlog là log xoay + purge 30d — lead là
fact suy ra một lần, insert-only + `on conflict do nothing` theo
`dedup_key` (mất khỏi convlog ≠ mất lead). Module `ingest/
lead_store.py` riêng — không đụng `core_store.py` nên invariant
"skip khi file thiếu/0-record" của loader lõi giữ nguyên. Channel
suy ra: `msg_id` rỗng → streamlit (writer ghi `msg_id:""`), còn lại
→ zalo (trước era `sent`, đáng tin hơn `sent` key). Intent heuristic
keyword — false-positive nhẹ chấp nhận ở pilot (ghi someday).

- [x] **W2.1 Schema `leads` + apply** — `docs/schema.sql` +1 bảng:
  identity id, `dedup_key text not null unique`, `ts timestamptz`,
  `channel` (zalo|streamlit), `user_hash`, `question`, `intent`
  (partner|order|price|contact), `status` default 'new', `source`,
  `created_at`. `python scripts/apply_schema.py` → 8 bảng public ×2.
  - Boundary: `docs/schema.sql`
  - Gate: apply ×2 idempotent; `information_schema` đủ 8 bảng public
  - Evidence: `evidence/v19_schema.log`
- [x] **W2.2 Harvester `ingest/lead_store.py`** — `python -m
  ingest.lead_store` đọc `data/conversations.jsonl` (+`.1` nếu có)
  bằng BYTES + split `\n`; skip `_doc`/dòng corrupt/thiếu
  ts-question-user_hash/ts sai format → đếm skipped; question không
  khớp intent → không phải lead; dedup_key = `convlog:<msg_id>` hoặc
  `convlog:<hash16(ts|user_hash|question)>` khi msg_id rỗng; `insert
  ... on conflict (dedup_key) do nothing` per-row → in "mới N /
  trùng M"; file thiếu/0-record → warn + exit 0, KHÔNG xóa leads
  đang có. `connect()`/CLI connection bounded 3s.
  - Boundary: `ingest/lead_store.py`
  - Gate: harvest thật ×2, totals khớp; table đã có 30 lead nên public
    runs ra new=0/dup=30 — không xóa existing rows để dựng fresh state.
    Fresh insert được kiểm bằng cùng 30 harvest rows trong rollback-only
    PostgreSQL temp-table transaction: run1 new=30, run2 dup=30; public
    count 30→30 sau rollback.
  - Evidence: `evidence/v19_leads.log`
- [x] **W2.3 Tab "Leads" trong streamlit** — tab thứ 4: `convlog_
  stats` luôn hiện (file-based, không cần DB): số tin theo kênh +
  %answered; `lead_store.connect()` → `lead_stats` → metric cards
  (tổng leads, mới 7d, theo channel/intent/status) + bảng leads mới
  nhất (ts/channel/intent/question/user_hash/status); DB lỗi/thiếu
  bảng → `st.info` "chưa nạp" không crash tab. Read-only — KHÔNG
  sửa status từ UI (pilot). Timestamps UTC; widths fit đủ 6 cột.
  - Boundary: `app/streamlit_app.py`, `ingest/lead_store.py`
  - Gate: live DB + DB-unavailable UI qua Playwright; cả hai HTTP 200,
    convlog stats vẫn hiện khi DB connection lỗi, console errors=0.
  - Evidence: `evidence/v19_streamlit.log`, `evidence/v19_dashboard.png`
- [x] **W2.4 Tests + gate chung** — `tests/test_lead_store.py`:
  classify từng intent + non-intent; channel/dedup_key 2 nhánh;
  harvest edge (missing/empty/corrupt-giữa-file/`.1`/`_doc`/thiếu
  field/ts sai); fake-conn insert on-conflict + KHÔNG có delete;
  schema drift guard `leads`; convlog_stats zeros-khi-thiếu; DB
  unavailable returns None; connection timeout.
  - Boundary: `tests/test_lead_store.py`
  - Gate: targeted 13/13 ×3; `python -m pytest` full 131/131;
    `ruff check .` clean.
  - Evidence: `evidence/v19_pytest.log`

External-dependency (không treo version): lead THẬT cần OA live
(C2.0) — hiện harvest từ convlog mock/UI có sẵn; 30 rows đang hiển thị
là replay/mock/UI-test, KHÔNG phải khách hàng thật — phải nói rõ là dữ
liệu mẫu khi demo. Intent heuristic substring → refine khi có data thật
(ghi someday). Số liệu kênh đầy đủ (message/order volume, social metrics)
thuộc báo cáo WS3/cycle sau — dashboard v1.9 chỉ cover leads + convlog.
Someday trước go-live: bảng leads insert-only giữ `question`/`user_hash`
quá horizon convlog 30 ngày; quyết retention/redaction cho tên và dữ
liệu user-influenced trước khi dùng dữ liệu khách thật (C2.0). NIT
cold-check: `convlog_stats` dùng truthiness cho `answered`, nên chuỗi
`"false"` bị đếm như đã trả lời; writer hiện ghi bool, malformed/manual
convlog mới gặp case này.

## Checklist v1.8-core-db

Khán giả: buổi đàm phán SOW — chứng minh nền dữ liệu lõi WS1 đứng được
trên Postgres thật (SOW §WS1: bảng `products`, `claims_approved`,
`plots`, `orders`, `assets` + quy trình nhập liệu mới cho nhật ký vườn
→ bảng `plot_logs`), và bảng kê Phụ lục A được đếm từ dữ liệu thật thay
vì ghi tay. Đây là nền cho WS2 (leads/đơn/dashboard) và WS3 (agent báo
cáo + agent nhật ký vùng trồng) ở các cycle sau. Quy ước precedent
patch: `guardrail.py`/`api/rag.py`/`connectors/zalo.py` không đụng;
skip eval_qa + zalo_mock (answer/reply path không đổi); không global
mutable mới trong zalo.py → `_isolated_files` giữ nguyên. Dữ liệu
plots/plot_logs/orders là **MẪU** — công ty chưa bàn giao (SOW §5.2),
đánh dấu `_doc` "DỮ LIỆU MẪU" trong từng file + cột "chờ bàn giao" của
Phụ lục A; products/claims/assets nạp từ crawl + whitelist THẬT hiện
có. Schema chỉ `create table if not exists` — không sửa/drop `chunks`,
revert gọn. `orders` KHÔNG lưu PII khách (tên/SĐT) ở pilot.

- [x] **W1.1 Schema lõi + apply script** — `docs/schema.sql` +6 bảng;
  `scripts/apply_schema.py` apply schema.sql qua psycopg (máy không có
  psql — precedent `demo.py:52` execute multi-statement; UTF-8 guard),
  in danh sách bảng public.
  - Boundary: `docs/schema.sql`, `scripts/apply_schema.py`
  - Gate: apply ×2 idempotent; `information_schema` đủ 7 bảng public
  - Evidence: `evidence/v18_schema.log` — ×2 đều "7 bảng public"
- [x] **W1.2 Loader `ingest/core_store.py` + sample jsonl** —
  `python -m ingest.core_store`: `products.jsonl`→products (+`images[]`
  →assets kind=image), `articles.jsonl`/`news.jsonl`→assets
  kind=article, `claims_whitelist.json`→claims_approved (`sku_key` =
  key whitelist; `product_id` best-effort qua segment URL cuối trong
  `source`; claim NULL + note khi SKU "chưa có công bố"),
  `data/sample_{plots,plot_logs,orders}.jsonl`→3 bảng (dòng `_doc` skip).
  Idempotent: delete `where source = <file>` rồi insert — chạy lại
  không nhân đôi, không đè row nguồn khác (nhập tay).
  - Boundary: `ingest/core_store.py`, `data/sample_*.jsonl`
  - Gate: chạy ×2 count giữ — products 27 · claims sku 10 · assets
    ≥140 · plots 3 · plot_logs ≥5 · orders ≥5
  - Evidence: `evidence/v18_core_store.log` — ×2 giống hệt:
    products=27, claims=22 (18 claim + 4 marker claim=NULL), plots=3,
    plot_logs=6, orders=5, assets=219; claims product_id link
    deterministic qua URL `.html` (9/10 sku; savitim NULL đúng — source
    trỏ bài news)
  — *(cold-check MAJOR vá: `collect_rows` trước append `products`/
    `claims_approved` kèm source cố định DÙ FILE THIẾU → delete-by-
    source + insert-0 xoá trắng bảng đang có (trái docstring "thiếu →
    KHÔNG xóa"; `claims_approved` là nguồn sự thật guardrail). Vá: chỉ
    append domain khi file tồn tại, assets cũng skip khi không file
    nào đóng góp; +3 test file-thiếu/partial/no-ops. 2 MINOR →
    someday: manual-child mất link/cascade + assets 'multi' nguồn-rút-
    hẳn tồn đọng)*
  — *(cold-check đợt 2 MAJOR vá: file TỒN TẠI nhưng 0 record (cắt
    cụt/crawl lỗi) vẫn append domain → delete+insert-0 xoá trắng bảng
    (probe `claims_whitelist.json`={} tái hiện). Vá: 0 record → skip
    + warn như file thiếu; +1 test file-rỗng/`{}`/`_doc`-only. Mechanism
    partial-reload + data_audit/updated_at/fake-conn e2e → someday)*
- [x] **W1.3 Phụ lục A draft** — `scripts/data_audit.py` in bảng kê
  domain × số-lượng × nguồn × trạng-thái (jsonl + whitelist + bảng lõi
  + chunks; DB lỗi → in "chưa nạp", vẫn exit 0); `docs/phu-luc-a.md` =
  draft Phụ lục A (SOW §11): bảng kê từ script + domain "chờ bàn giao"
  (hồ sơ pháp lý/ĐKSP gốc, sổ bán hàng, bản đồ khoảnh, media assets
  trong drive công ty).
  - Boundary: `scripts/data_audit.py`, `docs/phu-luc-a.md`
  - Gate: script exit 0 in đủ domain; số trong doc khớp log
  - Evidence: `evidence/v18_audit.log` — 10 dòng domain, đếm theo
    `source` (không nhầm khi nhiều file share bảng assets)
- [x] **W1.4 Tests + gate chung** — `tests/test_core_store.py`:
  transforms thuần (product/asset/claim/log/order rows), `_doc` skip,
  link product qua URL segment, fake-conn chứng minh delete-by-source
  trước insert + không đụng `chunks`, schema.sql chứa đủ 6 `create
  table` (drift guard), sample files parse đủ field. `python -m pytest`
  full xanh + `ruff check .` clean.
  - Evidence: `evidence/v18_pytest.log` — 114/114 (105 cũ + 9 mới) +
    ruff clean; test mới ×3 ổn định

External-dependency (không treo version): data thật plots/orders/hồ sơ
SKU chờ công ty bàn giao (SOW §5.2); vector index P0/P1 mới chỉ cover
jsonl crawl qua `chunks` — core tables phục vụ agent/dashboard cycle
sau, chưa embed; ingest chunks hiện đọc data/*.jsonl theo glob tên cố
định — sample_* không lọt vào chunks (đúng ý).

Someday mới: leads table + gom lead từ convlog (WS2), pipeline nội dung
đa kênh + lịch đăng có human-gate (WS2), agent báo cáo định kỳ ra file
(WS3), form/chat nhật ký vườn + cảnh báo bất thường (WS3), playbook/
SOP + Phụ lục D test-set (WS4).

## Checklist v1.7-edge-hardening

Khán giả: bot live public — 3 defect còn hỏng đã probe-verify
2026-10-09 (không phải entry someday stale): (a) `do_GET` không đọc
body — GET kèm `Content-Length>0`/chunked để sót byte trên wire;
dưới HTTP/1.1 keep-alive sót đó parse thành request rác kế (probe
raw socket: `GET /healthz` + body `JUNK` + request kế → `501
Unsupported method ('JUNKGET')`; cold-check v1.6 flag riêng 404
nhưng `/healthz` cùng lớp lỗi — vá cả); (b) `_dedup` CASE
`'%:follow'` — msg `mid=="follow"` cho eid `uid:follow` trùng hẳn
key follow → tin BỊ NUỐT không dispatch, và mid kết `:follow`
hưởng TTL 7d thay 1h (probe: `_dedup("u1:follow")` sau follow →
msg đó dedup True; `u1:x:follow` age 3700s vẫn sống); (c) email
bound residual — local>256 trượt match → lộ 44 ký tự đầu
(`x*300@gmail.com` → `x*44***`), label>253 KHÔNG mask gì → lộ toàn
bộ (cold-check v1.5 MINOR + someday "thiếu test biên 257/254").
Quy ước precedent patch: `guardrail.py` cấm đụng, `api/rag.py`
không đụng, skip eval_qa + zalo_mock. Không global mutable mới →
`_isolated_files` không đổi. GIỮ someday: tên người trong PII,
unwrap distortion non-SĐT, bare-run "0901 - 234.567" (chấp định —
sửa phá luật chống bridging khoảng giá), neo-ngoặc over-mask giá
≥10 digit (chấp định, che thừa convlog), rotate race xuyên process
(file-lock overkill pilot), queue horizon 30d (nêu khi demo), mọi
external.

- [x] **V8.1 `do_GET` đóng connection khi framing báo body chưa
  đọc** — `/healthz` lẫn 404 đều return mà không đọc body: TE
  chunked / `Content-Length` ≠0 / CL không-parse →
  `self.close_connection = True` (cùng pattern V7.1 — HTTP/1.0
  default-close nên hôm nay chỉ latent). GET sạch (CL=0/vắng)
  giữ keep-alive.
  Gate: `test_get_with_body_closes_connection` — monkeypatch
  `protocol_version=HTTP/1.1`, raw socket + `Connection:
  keep-alive` explicit (tránh pass-ảo default-close): GET+body
  `/healthz` → 200→EOF; GET+body `/nope` → 404→EOF; control 2 GET
  sạch pipelined cùng socket → 2×200 (keep-alive còn dùng được —
  code hỏng sẽ trả 501 'JUNKGET' hay đóng oan)
- [x] **V8.2 Namespace key follow `follow:{uid}`** — nhánh follow
  đổi `_dedup(f"{uid}:follow")` → `f"follow:{uid}"`, CASE
  `'%:follow'` → `'follow:%'`: eid msg `uid:mid` không bao giờ
  khớp (uid Zalo numeric → không thể là "follow"; `mid=="follow"`
  hay mid kết ":follow" đều rơi TTL thường, không đụng key
  welcome). Artifact migrate: key `uid:follow` cũ trên DB đang
  chạy decay theo SEEN_TTL (CASE mới không match) — refollow trong
  cửa sổ ~1h sau deploy welcome lại 1 lần (pilot chấp nhận, ghi
  trong comment).
  Gate: `test_dedup_follow_key_namespace` (follow:u1 giữ 7d;
  `u1:follow`/`u1:x:follow` TTL 1h, không nuốt msg) +
  `test_msg_id_follow_not_swallowed` (e2e do_POST: follow rồi
  msg mid "follow" vẫn dispatch) + update key mới trong
  `test_follow_dedup_longer_ttl` (đổi key, KHÔNG nới assert)
- [x] **V8.3 Email oversize → mask trọn run** — `_PII_RE` alt
  email thêm lookbehind `(?<![\w.+-])` chặn slide partial-local
  (local>256 giờ fail hẳn thay vì mask đuôi lộ đầu) + post-pass
  `_mask_email_oversize` sau `_PII_RE.sub`: mỗi `@` còn sót
  (email đã mask → `@` mất) scan left-run `[\w.+-]` + right-run
  label `[\w-]+(\.[\w-]+)*` O(n) tổng; trông email-like (left≥1
  VÀ có `.label`) mà local>256 hoặc label>253 → cả run `***`
  (che thừa). `@` không email-like (`a@b` không dot, mention
  `@samsam`, `tag@`) giữ nguyên — không over-mask mới.
  Gate: `test_mask_pii_email_oversize` — biên local 256 (regex)/
  257 (post-pass) đều `***`; label 253/254 đều `***`; "a@b",
  "@samsam" giữ nguyên; probe pathological trong evidence
- [x] **V8.4 Gate chung** — `python -m pytest` full xanh +
  `ruff check .` clean (coordinator)
  — *(105/105 `evidence/v17_pytest.log` 26.6s + ruff clean; worker
    chết connection-error giữa lane → coordinator absorb: V8.2 code
    + V8.3 (`_PII_RE` lookbehind + `_mask_email_oversize`) + 4 test
    mới; key test cũ `u1:follow` → `follow:u1` KHÔNG nới assert)*

## Checklist v1.6-ops-hardening

Khán giả: bot live public — 3 defect ops còn hỏng đã probe-verify
2026-10-09 (không phải entry someday stale): (a) `do_POST` reject-sớm
411/400/413 không set `close_connection` — body sót chưa đọc sẽ đầu
độc request kế nếu ai bật keep-alive (HTTP/1.0 close mặc định nên hôm
nay đúng, nhưng someday note yêu cầu set sẵn); (b) stamp đo interval
trong-process (`_last_refresh`, `_last_refresh_ok`, `_last_purge`,
`_last_purge_attempt`) dùng `time.time()` — clock lùi (NTP/sửa giờ)
đóng băng purge/refresh-throttle (probe: stamp tương lai → purge khoá,
entry 40d sống sót); (c) `_dedup` cleanup dùng SEEN_TTL_S chung → key
`:follow` quên sau 1h → unfollow/refollow spam welcome (probe: age
3700s → refollow không dedup). Quy ước precedent patch: `guardrail.py`
cấm đụng, `api/rag.py` không đụng, skip eval_qa + zalo_mock (không
đụng answer/reply semantics). Không global mutable mới (FOLLOW_TTL_S
là const; stamp init đổi 0.0 → `float("-inf")` vẫn reset trong
`_isolated_files`). GIỮ someday: email label>253, test biên 257/254,
neo-ngoặc over-mask giá ≥10 digit, bare-run "0901 - 234.567", unwrap
distortion non-SĐT, tên người trong PII, rotate race xuyên process
(file-lock overkill pilot), queue horizon 30d, mọi external.

- [x] **V7.1 `close_connection = True` trên reject body-chưa-đọc** —
  `do_POST`: 411 chunked, 400 bad/negative Content-Length, 413
  >MAX_BODY return mà không đọc body → set `self.close_connection =
  True` để lỡ bật HTTP/1.1 keep-alive sau này không nhiễu request kế.
  KHÔNG set ở 404/403/400-json (body đã đọc — keep-alive an toàn).
  Gate: `test_early_reject_closes_connection` — monkeypatch
  `Handler.protocol_version` = HTTP/1.1, raw socket: chunked → 411 →
  EOF; CL>MAX_BODY → 413 → EOF; CL không-parse → 400 → EOF (code cũ:
  connection sống, sót body parse thành request rác)
- [x] **V7.2 `time.monotonic()` cho stamp interval trong-process** —
  `_last_refresh`/`_last_refresh_ok`/`_last_purge`/`_last_purge_attempt`
  init `float("-inf")` (0.0 dưới monotonic = boot-time chứ không phải
  "chưa từng" — uptime < interval thì 0.0 thành "vừa xảy ra" → flake
  theo uptime máy), mọi đọc đổi sang `time.monotonic()`; latency `t0`
  trong zalo.py (×3) + `app/streamlit_app.py` (×1) cùng đổi (skew làm
  sai latency_ms). GIỮ `time.time()`: `_dedup` ts (persist đĩa qua
  restart — monotonic vô nghĩa xuyên process), `expires_at` (epoch API),
  `_purge_convlog` cutoff/horizon (so ts ISO tuyệt đối), convlog `ts`.
  Test seed `time.monotonic()`/`float("-inf")` tương ứng.
  Gate: `test_purge_failure_still_logs_and_retries` (seed monotonic) +
  `test_stamps_use_monotonic` (sau write: `abs(_last_purge -
  time.monotonic()) < 5`; skew probe: `_last_purge` set xa tương lai
  dưới monotonic vẫn chặn — semantics giữ)
- [x] **V7.3 Per-key TTL follow dedup** — `_dedup` cleanup phân nhánh:
  `event_id LIKE '%:follow'` sống `FOLLOW_TTL_S = 7*86400` (chặn
  welcome-spam unfollow/refollow 7 ngày thay 1h — giá trị tự chọn:
  refollow trong tuần = cùng engagement cycle, sau 7d = re-engagement
  xứng welcome; flag TO), key khác giữ SEEN_TTL_S (3600). Không đổi
  schema — CASE trong DELETE. Comment: msg eid `uid:mid|ts` không thể
  kết `:follow` (Zalo id numeric).
  Gate: `test_follow_dedup_longer_ttl` — follow → welcome; UPDATE row
  ts -3700s → refollow vẫn dedup (1 welcome); ts -8d → welcome lại;
  msg key ts -3700s → vẫn re-process (TTL msg không đổi)
- [x] **V7.4 Gate chung** — `python -m pytest` full xanh +
  `ruff check .` clean (coordinator)
  — *(101/101 `evidence/v16_pytest.log` 24-25s + ruff clean; worker
    chết connection-error giữa lane → coordinator absorb viết 3 test
    mới + gate; bắt kèm: control-case bị MAX_BODY=10 → 413 trước 403
    (test phải gửi body ≤cap), `except socket.timeout` → TimeoutError
    (ruff UP041), reject-test cần `Connection: keep-alive` explicit
    nếu không stdlib default-close = "pass ảo" trên code cũ)*

## Checklist v1.5-pii-hardening

Khán giả: bot live public — convlog plaintext trên đĩa, vá hết các
lớp LEAK còn lại trong `_mask_pii` mà probe 2026-10-09 chứng minh còn
hỏng (không phải entry someday stale): (a) budget-abort bypass —
`"("*26 + "x" + "(0901) - (234) - (567)"` đốt budget 4n giữa chừng →
đuôi emit raw → SĐT ngoặc lọt (cold-check v1.4 MINOR); (b) SĐT lẫn
ngoặc+bare qua sep TRỘN — `"(0901) - 234.567"`, `"0901 - (234) -
(567)"` lọt (group unwrap nhưng joint trộn không nối bare-run, `.` cắt
run → mỗi cụm <10 số); (c) email local/label quá bound RFC
(`{1,64}`/`{1,63}`) mask một phần → lộ đầu local (cold-check v1.4
MINOR, hướng che-thừa). Quy ước precedent patch: `guardrail.py` cấm
đụng, `api/rag.py` không đụng, skip eval_qa + zalo_mock. Không global
mutable mới → `_isolated_files` không đổi. GIỮ someday: distortion
non-SĐT ("đơn (12345)"), over-mask "giá 500.000 (10) 0901234567"
(nay "giá 500 ***" — hướng che-thừa), bare-run "0901 - 234.567"
không ngoặc (sửa = phá luật chống bridging khoảng giá — chấp định),
email local >256 (residual RFC-invalid), group ngoặc chứa '.'
("(0901.234.567)" đã mask qua regex; bare+invalid-group là lớp khác).

- [x] **V6.1 `_mask_pii` budget-abort → đuôi '***'** — budget cạn
  (`4n`) trước đây emit đuôi raw → SĐT ngoặc trong đuôi lọt. Vá: đuôi
  còn `(` → `***` (hướng không-rò); đuôi không ngoặc emit raw như cũ
  (bare digit đã bị `_PII_RE` bắt).
  Gate: `test_mask_pii_budget_abort_masks_tail` — 3 case pathological
  → `***` có + "0901" không còn
  — *(probe: `"("*26+"x"+"(0901) - (234) - (567)"` → `(((…***`;
    `"("*5000+"0901234567"` → `((((***`)*
- [x] **V6.2 Bridge group↔bare-run khi blob ≥10 digit** — chain merge
  mở rộng: group ngoặc-digit là "mỏ neo", nối bare-run digit kề
  trước/sau qua joint `[ .-]*` trộn vào blob sep ' ' CHỈ khi tổng
  digit ≥10 (đủ hình SĐT); <10 emit như cũ (không normalize
  "05.10 (2)"). 2 bare-run trần không có group vẫn không nối —
  "50.000.000 - 100.000.000" an toàn. Run-scan + left-run scan-back
  (chặn bởi `)` group trước) trừ budget → giữ O(n).
  Gate: `test_mask_pii_paren_bare_mixed_bridge` — 9 leak-case → "***"
  + biên <10 digit/2-bare-run/group non-digit không đổi
  — *(emit blob giữ format cũ: trailing ' ' chỉ khi part cuối là
    group — `test_mask_pii_paren_merge_overmask_accepted` +
    `(01)-(02)-(2026) 0123`==" ***" giữ nguyên; pathological probe:
    chain-270k 0.118s, "(1) 9 - "×20k 0.090s)*
- [x] **V6.3 Email bound nới `{1,256}`/`{1,253}`** — local >64 hay
  label >63 (RFC-invalid) trước mask một phần → lộ đầu. Bound cứng
  giữ O(n) worst-case (probe 'x'×900k = 2.7s, trước unbounded 77.8s/
  100k); residual local >256 chấp nhận.
  Gate: `test_mask_pii_email_rfc_bound_edge` — biên 64/256/label-70
  → "***" trọn + residual >256 ghi nhận
- [x] **V6.4 Gate chung** — `python -m pytest` full xanh +
  `ruff check .` clean (coordinator)
  — *(98/98 ×2 `evidence/v15_pytest.log` + ruff clean)*

## Checklist v1.4-pii-evasion

Khán giả: bot live public — convlog nằm plaintext trên đĩa, không được
rò SĐT khách qua 2 lớp lách còn lại mà cold-check v1.2 đã flag (MINOR
trên đĩa, verify lại 2026-10-09 bằng probe `_mask_pii`): (a) SĐT chia
qua nhiều nhóm ngoặc nối sep TRỘN — "(0901) - (234) - (567)",
"(0901)-(234)-(567)" lọt vì joint `) - (`/`)-(` không phải sep-run
cùng-ký-tự; (b) ngoặc lồng/ngoặc có space bên trong — "((0901))234567",
"( 0901 ) 234 567" lọt vì unwrap strict `\+?\d+` không bắt và `)` chặn
bridge. Quy ước precedent patch: `guardrail.py` cấm đụng, `api/rag.py`
không đụng, skip eval_qa + zalo_mock. Không global mutable mới → fixture
`_isolated_files` không đổi. GIỮ someday: distortion text non-SĐT
("đơn (12345)"), over-mask "giá 500.000 (10) 0901234567", SĐT lẫn
paren+bare "(0901) - 234.567" (chưa flag, diminishing returns).

- [x] **V5.1 `_mask_pii` — merge nhóm ngoặc-digit kề nhau + unwrap
  lặp** — fixpoint luân phiên (cap 32 vòng, parens giảm đơn điệu):
  (1) merge `\(\s*(\+?[\d (][\d ()]*?)\s*\)[ .-]*\(\s*(?=\+?\d)` →
  `(\1 ` — gộp 2 nhóm ngoặc-toàn-digit kề nhau qua sep-run BẤT KỲ (kể
  cả `)(` dính và " - " trộn); content group trái cho phép ngoặc lồng
  (`[\d ()]`) — strict-digit-only để nhóm phải merge+unwrap thành bare
  digits trước khi nhóm nested trái kịp gộp ("((0901)) - (234) -
  (567)" vẫn lọt); ngoặc non-digit (giá có '.') không merge → `)` vẫn
  chặn bridge như V3.1; (2) unwrap space-tolerant lặp
  `\(\s*(\+?\d[\d ]*?)\s*\)` → ` \1 ` — mở nesting + space-trong-ngoặc.
  `_PII_RE` giữ nguyên (sep cùng-ký-tự — KHÔNG nới sep class).
  Gate: pytest 65/65 — `test_mask_pii_paren_mixed_sep_and_nested`:
  16 leak-case → "***" (mixed-sep joints, `)(` dính, nested `(( ))`,
  space-trong-ngoặc, group "0" đơn, +84) + regression biên KHÔNG
  over-match (giá ngoặc, khoảng giá/ngày, <9 số, non-digit group)
  — *(cold-check FIX: bản đầu fixpoint regex = O(n·depth) — "("*5000
    đốt >10s trong _log_lock; vá thành scanner 1-pass depth-counting
    + budget-rescan 4n ("(((…x" abort → emit raw). Số đo sau vá:
    n=800 0.000s (trước 1.03s), n=5000 0.004s (trước >10s kill),
    n=20000 0.015s, chain-100k 0.372s, opens-100k 0.068s, merge-30k
    0.122s. MINOR-1 cap-32-leak tự hết (không còn cap). MINOR-2
    over-mask "(500) - (0) - (000)…" → ACCEPT + test biên
    `test_mask_pii_paren_merge_overmask_accepted` (vá rẻ loại vì phá
    "(90)" giữa chuỗi). Vá kèm cùng-cụm: email alt `[\w.+-]+@` cũng
    quadratic trên text dài không-'@' ('x'×50K=18.9s, ×100K=77.8s) —
    bound RFC `{1,64}`/`{1,63}` → 900KB 'x' 1.27s)*
- [x] **V5.2 Gate chung** — `python -m pytest` full xanh +
  `ruff check .` clean (coordinator)
  — *(95/95 `evidence/v14_pytest.log` + ruff clean; cold-check đợt 2
    auditor lạ tự chạy lại 95/95 18.6s + perf probe 8 case đều <0.1s)*

## Checklist v1.3-ops-polish

Khán giả: bot live public chịu được đĩa hỏng/đầy — purge fail dai dẳng
không được kéo mọi reply thread xếp hàng O(file) trong `_log_lock`.
Someday duy nhất còn là defect-vá-được (đã grep verify); phần còn lại
là external-dep hoặc chấp-định có chủ đích. Quy ước precedent patch:
`guardrail.py` cấm đụng, `api/rag.py` không đụng, skip eval_qa +
zalo_mock. Global mutable mới (`_last_purge_attempt`) PHẢI reset trong
`_isolated_files` — kèm fix latent leak `_last_purge` (chưa từng reset).

- [x] **V4.1 Purge-fail backoff** — `_log_conversation`: daily purge
  hiện retry MỌI lần ghi khi purge throw (đĩa hỏng/đầy → O(file) dưới
  lock chung, mọi reply thread chậm theo — audit v0.6.2 NIT). Vá theo
  precedent `_last_refresh`/`_last_refresh_ok` (V2.2): thêm global
  `_last_purge_attempt` — attempt purge chỉ khi
  `now - _last_purge > 86400` VÀ `now - _last_purge_attempt >=
  PURGE_RETRY_S` (const 3600); set attempt-stamp TRƯỚC try (attempt
  throttled kể cả khi fail — đây là điểm vá); `_last_purge` vẫn chỉ
  set khi purge thành công (D6.9 giữ). Rotate-purge (`.1`) không cần
  throttle — chỉ chạy khi file >cap, tự bounded. Gate: pytest —
  `test_purge_failure_still_logs_and_retries` flip contract chủ đích
  (ghi "ĐỔI CONTRACT v1.3"): throw → append + attempt set; trong
  window → không retry; lùi stamp quá window → retry; success →
  `_last_purge` set + daily gate chặn
- [x] **V4.2 Gate chung** — `python -m pytest` xanh + `ruff check .`
  clean (coordinator)
  — *(92/92 `evidence/v13_pytest.log` + ruff clean; `_isolated_files`
    giờ reset cả `_last_purge` (latent leak — trước chưa từng reset) +
    `_last_purge_attempt`)*

## Checklist v1.2-convlog-hygiene

Khán giả: bot chuẩn bị live public — 3 someday đã grep-verify còn hỏng,
cùng chủ đề privacy/hygiene convlog + dedup. Quy ước precedent patch:
`guardrail.py` cấm đụng, `api/rag.py` không đụng, skip eval_qa +
zalo_mock (answer/reply path không đổi — tiết kiệm credit).

- [x] **V3.1 PII SĐT dạng ngoặc** — `_PII_RE` sep class `[ .-]` không
  chứa `(`/`)` → "+84 (90) 123 4567", "(+84) 901234567",
  "(0901) 234 567" lọt mask. Vá: `_mask_pii` unwrap nhóm ngoặc
  TOÀN-digit `\((\+?\d+)\)` → ` \1 ` TRƯỚC `_PII_RE` (regex giữ
  nguyên — KHÔNG nới sep class). Ngoặc bọc non-digit (giá có ".")
  giữ nguyên → `)` tự chặn bridging.
  Gate: `test_mask_pii_parenthesized_phone` — 4 SĐT ngoặc → "***" +
  7 regression biên không over-match
  — *(reviewer FIX đợt 1: bản đầu normalize MỌI ngoặc → space tạo
    bridging mới — ")(" → space-run cùng-ký-tự nối
    "(1.500.000)(2.000.000)" thành run ≥9 → ăn cả 2 giá. Vá sang
    unwrap-digit-group, re-audit PASS)*
- [x] **V3.2 Refollow → welcome lặp** — dedup key
  `f"{uid}:follow:{ts}"`: refollow ts khác → gửi lại WELCOME_TEXT.
  Vá: key `f"{uid}:follow"` (bỏ ts) → welcome tối đa 1 lần/SEEN_TTL_S
  (1h)/user; refollow sau TTL = re-engagement, chủ đích vẫn welcome
  (someday: per-key TTL nếu muốn chặn lâu hơn). Retry cùng event vẫn
  chặn (mạnh hơn key cũ). Gate: `test_follow_refollow_dedup_within_ttl`
  — 2 follow khác ts cùng uid → 1 welcome; uid khác → 2 welcome
- [x] **V3.3 Purge drop dòng không-đọc-được-ts** — `_purge_convlog`
  giữ dòng parse-lỗi/thiếu ts → PII quá hạn không bao giờ bị purge
  (trái intent retention 30d; reader `unanswered()` vốn skip dòng
  lỗi → giữ chỉ để rò PII). ĐỔI POLICY "thà giữ thừa" → "không chứng
  minh được tuổi = không được nằm lại": keep iff `strptime(ts,
  "%Y-%m-%dT%H:%M:%SZ")` parse được và `cutoff <= ts <= now+1d`
  (slack clock-skew); corrupt/ts-missing/ts-malformed/ts-tương-lai-xa
  → drop.
  Gate: `test_convlog_purges_entries_older_than_retain_days` flip
  contract (corrupt/byte-lỗi/thiếu-ts/malformed/"9999-99-99"/future+2d
  drop; mới + skew+1h giữ)
  — *(reviewer FIX đợt 1: `len(ts)==20` không đủ — "9999-99-99T99:99:99Z"
    và ts tương lai xa vẫn nằm mãi; vá strptime + horizon +1d)*
- [x] **V3.4 Gate chung** — `python -m pytest` xanh + `ruff check .`
  clean (coordinator)
  — *(92/92 `evidence/v12_pytest.log` + ruff clean)*

## Checklist v1.1-oa-resilience

Khán giả: OA bot live trên creds thật — token không chết giữa ngày
(refresh chủ động), reply không đảo thứ tự, khách follow nhận welcome;
vá 5 someday đã grep chứng minh còn hỏng. Quy ước precedent patch:
`guardrail.py` cấm đụng, `api/rag.py` không đụng, skip eval_qa +
zalo_mock (answer/reply path không đổi — tiết kiệm credit). Module
global mutable mới (`_last_refresh_ok`, `_mem_tokens`) PHẢI reset
trong fixture `_isolated_files` (gotcha v1.0).

- [x] **V2.1 Refresh chủ động theo `expires_at`** — store ghi
  `expires_at` nhưng không ai đọc: token hết hạn chỉ phát hiện khi
  send fail (reply khách đầu tiên sau expiry chậm 1 oauth round-trip
  hoặc mất nếu refresh lỗi). `send_text`: store có `expires_at` +
  `now > expires_at - REFRESH_AHEAD_S` (300s) + `_can_refresh()` →
  refresh TRƯỚC khi send; refresh fail vẫn send thử token hiện tại
  (best-effort). Store thiếu/`expires_at` không parse → hành vi cũ.
  Gate: pytest 3 nhánh — sắp hết hạn → refresh (mock httpx) rồi send
  token mới; còn hạn xa → không gọi oauth; refresh fail → vẫn send
  token cũ
  — *(reviewer F1: throttle proactive trên `_last_refresh` — oauth sập
    mà không throttle = mỗi send một call 15s-timeout; `expires_in<=0`
    → `expires_at=0` "không biết" (ghi now() = mọi send đều rotate);
    in-flight refresh → chờ `_token_lock` đọc lại token mới)*
- [x] **V2.2 `_last_refresh_ok` tách khỏi attempt** — `_last_refresh`
  ghi cả attempt-fail → send-fail trong 60s sau refresh-fail retry với
  token hỏng (waste — cold-check v1.0 minor). Thêm `_last_refresh_ok`
  (set khi refresh ra token dùng được — kể cả nhánh mem-fallback V2.3).
  Retry path `send_text`: recent-success (<60s) → retry token hiện
  hành; không có attempt gần → refresh → retry nếu True; recent-failed-
  attempt → return False KHÔNG retry stale. Throttle oauth giữ nguyên
  (`_last_refresh` vẫn ghi mọi attempt).
  Gate: pytest — refresh-fail rồi send-fail <60s → chỉ 1 `_send_once`
  (không retry); recent-success → retry cùng token
  — *(reviewer F2: nhánh "attempt gần đây" chờ `_token_lock` phân biệt
    refresh đang chạy song song vs đã fail — in-flight xong mà thành
    công thì retry token MỚI, không mất reply)*
- [x] **V2.3 `_mem_tokens` — persist-fail không mất rotated token** —
  `_write_token_store` OSError → token đã rotate server-side mất hẳn,
  store giữ refresh_token cũ đã vô hiệu → mọi refresh sau fail vĩnh
  viễn. Vá: `_mem_tokens` giữ bản rotate khi persist fail; readers
  (`_current_access_token`, `_current_refresh_token`, `_current_expires_at`
  cho V2.1) đọc mem → store → env. Persist-fail → warn "rotate OK,
  persist lỗi — chỉ sống trong-process" + return True (token dùng
  được). Restart vẫn mất (chấp nhận — comment rõ). Preflight cố tình
  đọc store on-disk (báo đúng trạng thái persist).
  Gate: pytest — `_write_token_store` throw → refresh True,
  `_current_*_token` trả token mới, send sau dùng token mới, refresh
  sau dùng rotated refresh_token
  — *(cold-check F1 major: bản đầu set mem mọi refresh OK → mem đè
    store ghi bởi process khác (preflight --refresh/operator) → refresh
    bằng token đã rotate chết, fail tới restart = regression v1.0. Vá:
    persist OK → `_mem_tokens = {}`, mem chỉ tồn tại trong cửa sổ
    persist-fail; test `test_mem_tokens_cleared_after_successful_persist`
    chứng minh store ngoài được tôn trọng. Rebind nguyên tử (không
    clear+update) — reviewer F5)*
- [x] **V2.4 Non-text dispatch qua `_ulock`** — `_reply_non_text`
  dispatch thẳng không lock (zalo.py ~L676 vs :506) → ảnh+text cùng
  user reply đảo thứ tự (ordering/UX — cold-audit v1.0 minor). Thêm
  `handle_non_text()` wrapper `with _ulock(user_id)` như `handle_text`.
  Gate: pytest ordering event-based (mô phỏng
  `test_same_user_messages_serialize`, không sleep)
  — *(reviewer F3: spy `handle_non_text` trong test HTTP chứng minh
    dispatch qua wrapper, không chỉ gọi thẳng hàm)*
- [x] **V2.5 Welcome khi follow** — `event_name == "follow"` hiện
  ignore → khách follow OA không biết bot làm gì. Gửi `WELCOME_TEXT`
  (hằng viết tay kiểu HANDOFF/NON_TEXT: cảm ơn + Sâm Sâm sâm Ngọc
  Linh + hotline 1800577732). uid = `follower.id` fallback `sender.id`;
  dispatch qua `_ulock`; convlog `question:"[event:follow]"`,
  `answered:null` (không phải câu hỏi — ra khỏi queue, precedent
  `guardrail_ok:null`), `guardrail_ok:null`, `sent`. Dedup
  `f"{uid}:follow:{ts}"`; unfollow vẫn ignore. Mỗi follow đều welcome
  (dedup chỉ chặn retry cùng ts — comment + someday note refollow
  spam). Gate: pytest follow → sent WELCOME + convlog đúng schema;
  unfollow/thiếu id → ignore
  — *(đổi contract có chủ đích: `test_other_events_still_ignored` cũ
    assert follow bị ignore → sửa thành unfollow/`user_gets_feedback`;
    thiếu timestamp → dedup key trùng chặn refollow 1h — hiếm, comment
    ghi (reviewer F4))*
- [x] **V2.6 Gate chung** — `python -m pytest` xanh + `ruff check .`
  clean (coordinator)
  — *(90/90 `evidence/v11_pytest.log` + ruff clean `evidence/v11_ruff.log`;
    mock/eval skip theo precedent patch)*

External-dependency (không treo version): live-verify proactive
refresh thật + payload shape `follower.id` của event follow — chờ creds
C2.0 như mọi live-Zalo contract. Someday mới: welcome không dedup
theo user (refollow → welcome lặp); retry-sau-refresh-ok áp cho mọi
send-error kể cả lỗi không-liên-quan-token (waste 1 call — cold-check
F2, liên quan someday whitelist error-code v1.0); PII SĐT dạng ngoặc
vẫn mở.

## Checklist v1.0-live-prep

Khán giả: ngày C2.0 có creds → cắm vào `.env`, chạy preflight, mở
endpoint → bot live KHÔNG cần vá code. Quy ước theo precedent patch:
`guardrail.py` cấm đụng, `api/rag.py` không cần đụng, skip `eval_qa`
(answer path không đổi — tiết kiệm credit), `zalo_mock` giữ.
Token persist vào `data/zalo_tokens.json` (gitignore — secret-động tách
khỏi `.env` config-tĩnh do user quản lý).

- [x] **V1.1 Token store + auto-refresh** — `data/zalo_tokens.json`
  {access_token, refresh_token, expires_at} làm source-of-truth, seed
  từ `ZALO_ACCESS_TOKEN`+`ZALO_REFRESH_TOKEN` lần đầu. Refresh:
  `POST oauth.zaloapp.com/v4/oa/access_token` header `secret_key:
  $ZALO_APP_SECRET`, form `app_id`+`grant_type=refresh_token`+
  `refresh_token` → response `{access_token, refresh_token,
  expires_in}` — refresh_token ROTATE (dùng 1 lần) → persist cả hai.
  `send_text` dùng token từ store; send fail → refresh → retry 1 lần;
  refresh fail → False+warn, không crash reply path. `_startup_error`
  DEPLOY: cần OA_SECRET + (ACCESS_TOKEN ∨ REFRESH_TOKEN+APP_ID+
  APP_SECRET). Expose `refresh_access_token() -> bool` cho preflight.
  Gate: pytest mock httpx — send-fail→refresh→retry ok; rotation
  persist file; refresh-fail→send False; startup nhánh mới.
  `.gitignore` +`data/zalo_tokens.json`
  — *(+throttle ≤1 refresh/60s trên send-fail — reviewer M3: lỗi
    không-liên-quan-token không burn rotation; chmod 0600 store POSIX;
    `test_send_fail_refresh_throttled_within_interval`)*
- [x] **V1.2 Tách 2 secret đúng contract** — webhook signature dùng
  `ZALO_OA_SECRET` (OA secret key — spec `sha256(appId+data+timestamp+
  OAsecretKey)`); oauth refresh header `secret_key` dùng
  `ZALO_APP_SECRET` (app). `.env` chưa có ZALO_* → đổi sạch, không
  backward-compat. Cập nhật `verify_signature`, `_startup_error`,
  docstring, test nhánh env (7 nhánh hiện có viết lại)
  Gate: pytest nhánh mới; deploy doc nêu nguồn lấy từng secret
  — *(10 nhánh `_startup_error`; mock vá `APP_SECRET`→`OA_SECRET` để
    signature verify chạy thật lại)*
- [x] **V1.3 Preflight script** — `scripts/zalo_preflight.py` chạy
  trên máy deploy trước khi mở public, in PASS/FAIL/SKIP từng mục +
  exit code: env đủ cho DEPLOY · DB connect + `chunks` count ·
  OpenRouter key set (không gọi API — tiết kiệm credit) · token sống
  (`GET openapi.zalo.me/v2.0/oa/getoa` header access_token) · signature
  round-trip tự ký · `--refresh` ép chạy refresh flow thật (test
  rotate — qua `connectors.zalo.refresh_access_token()`). UTF-8 guard.
  Gate: chạy dev thiếu ZALO_* → báo đúng mục thiếu + exit 1; pytest
  mock nhánh
  — *(11 test; reviewer M1: `--refresh` ép rotation kể cả khi token còn
    sống; check_env mirror `_startup_error` đọc token store — reviewer
    minor)*
- [x] **V1.4 Non-text event → lối thoát** — `user_send_*` không phải
  `text` (ảnh/file/sticker/gif/doodle/link/location/audio/video/
  business_card) hiện rơi vào ignore → khách live gửi ảnh bị câm.
  Reply hằng viết tay `NON_TEXT_TEXT` ("chỉ hỗ trợ tin nhắn văn bản +
  hotline"), vẫn dedup + convlog `answered:false` (question log dạng
  `[non-text:user_send_image]`). Event khác (follow…) vẫn ignore.
  Gate: pytest event image → reply đúng + log
  — *(+cap `event[:50]` — event_name client-controlled khi signature
    bypass dev; reviewer minor)*
- [x] **V1.5 Deploy artifacts + docs** — `env.example` đủ biến kèm
  comment nguồn lấy từng secret *(đổi tên không-dot: `.env*` bị write-
  policy chặn)*; `docs/zalo-webhook.service` systemd mẫu
  (EnvironmentFile + Restart=always); `deploy.md` rewrite: token
  auto-refresh (xóa hướng dẫn manual 25h), HTTPS bắt buộc khi đăng ký
  webhook, phân biệt OA_SECRET vs APP_SECRET, preflight = bước go-live.
  Gate: `env.example` khớp mọi `os.environ.get` trong code
  — *(reviewer M2: systemd comment cuối dòng trong EnvironmentFile=
    làm unit fail → tách ra dòng riêng)*
- [x] **V1.6 Gate chung** — `python -m pytest` xanh + `ruff check .`
  clean + `python scripts/zalo_mock.py` exit 0
  — *(77/77 ×2 `evidence/v10_pytest.log` + ruff clean + mock 3/3
    `evidence/v10_mock.log`; reviewer FIX→PASS rồi cold-check auditor
    lạ chạy lại toàn bộ gate: UNVERIFIED chỉ ở live Zalo contract =
    external-dependency theo thiết kế)*

External-dependency (không treo version): OA creds thật → preflight
thật → đăng ký webhook HTTPS → live-verify signature + reply. C2.0 vẫn
NEEDS-INPUT. Someday giữ nguyên +5: refresh chủ động trước hết hạn
(hiện lazy-on-fail), welcome message khi user follow OA, `_last_refresh`
ghi cả attempt-fail → send-fail trong 60s sau retry với token hỏng
(waste-only — cold-check v1.0 minor), `os.replace` fail mất token đã
rotate (warn rõ, không recovery — Windows file-lock hiếm), non-text
dispatch không qua `_ulock` (ảnh+text cùng user có thể reply đảo thứ
tự — ordering/UX only, cold-audit v1.0 minor: zalo.py:676-680 vs :506).

## Checklist v0.6.2 (patch)

Khán giả: bot vận hành thật 2 writer (zalo + streamlit) — `sent` đếm
đúng, purge không giết reply, phân biệt user UI, PII chặt hơn trước
khi live. Nguồn: 4 NIT còn hỏng thật từ audit v0.5.1 + v0.6 (đã grep
code chứng minh). Quy ước theo precedent patch: `guardrail.py` cấm
đụng, `api/rag.py` không cần đụng, skip eval/mock (edge-path, tốn
credit).

- [x] **D6.8 `sent: null` kênh UI** — streamlit convlog ghi `null`
  thay `False` (D4.4: `sent:false` = send-FAIL; kênh UI không send
  gì → đếm nhầm khi đối soát). Gate: entry streamlit `sent is None`;
  pytest xanh
  — *(`"sent": None` + comment; grep toàn repo không ai đọc field
    `sent` để quyết định → đổi semantics an toàn)*
- [x] **D6.9 Purge không giết reply + retry đúng** — `_purge_convlog`
  throw (PermissionError/disk full) hiện propagate qua
  `_log_conversation` → giết reply thread SAU khi send thành công;
  `_last_purge` set trước purge → fail kẹt 24h mới retry. Vá: purge
  throw → warn, reply vẫn log/send; `_last_purge` chỉ set sau purge
  thành công. Gate: pytest purge-throw → reply vẫn xong +
  `_last_purge` không set
  — *(wrap try/except warn-only cả 3 chỗ gọi: daily-purge, purge(bak)
    sau rotate, purge boot trong main(); test
    `test_purge_failure_still_logs_and_retries` +
    `test_rotate_purge_failure_still_appends`)*
- [x] **D6.10 User hash per UI session** — `_uhash("streamlit")` cố
  định gộp mọi UI user thành 1 trong queue. Vá: per-session id (uuid
  trong session_state) → `streamlit:{id}`. Gate: 2 session → 2 hash;
  1 session gọi lại → hash ổn định (helper pure test được)
  — *(`_ui_hash(session)` trong zalo.py — module sở hữu convlog
    schema, streamlit_app.py không import được trong pytest;
    `test_ui_hash_per_session_stable`)*
- [x] **D6.11 PII: +84 prefix + sep lặp** — `_PII_RE` hiện lọt SĐT
  dạng `+84...`/`84...` và sep ≥2 ký tự ("0901  234  567"). Gate:
  case mới masked + regression biên KHÔNG over-match (giá
  "1.500.000"/"8.400.000"/"10.050.000.000", ngày "05.10.2026", số
  ngắn)
  — *(reviewer verdict FIX đợt 1: `[ .-]*` nuốt sep TRỘN " - " nối 2
    số thành run ≥9 → mất khoảng giá/ngày ("50.000.000 - 100.000.000"
    → "50.***"); vá bằng sep lặp CÙNG-ký-tự `(?:([ .-])\N*)?\d` ở cả
    2 alternative; `test_mask_pii_vn_prefix_and_multi_sep` 19 assert
    gồm 6 case khoảng)*
- [x] **D6.12 Gate chung** — `python -m pytest` xanh + `ruff check .`
  clean
  — *(58/58 ×2 lần sau vá + ruff clean — coordinator tự chạy)*

Giữ someday (không vào version này): rotate race xuyên process (vá
đúng = file-lock Windows — overkill pilot), close_connection khi
keep-alive (chưa bật), tên người trong PII (regex không detect được),
queue horizon 30d (intent retention — nêu khi demo), mọi mục external
(C2.0/deploy/token/SKU).

## Checklist v0.6.1 (patch)

Phát sinh từ cold-audit dry-run demo: caption/nhãn phụ ("Nguồn:", "đã
chuyển nhân viên") chỉ render lượt live — Streamlit rerun (đổi tab, gửi
câu mới) làm mất. Cosmetic nhưng đụng đúng điểm demo. Đụng
`app/streamlit_app.py` render-model only; `history`/`answer()` không đổi.

- [x] **D6.6 Caption persist qua rerun** — `messages[]` lưu thêm field
  `caption`; replay render lại đúng nhánh (handoff caption /
  "Nguồn:" + link), lượt flagged vẫn trần.
  Gate: live — hỏi câu bẫy → đổi tab → caption còn; câu thường →
  "Nguồn:" còn (`evidence/dryrun_caption_persist.png`); pytest 54/54
  (`python -m pytest` — entry script `pytest` không add cwd) + ruff clean
- [x] **D6.7 Dry-run demo walkthrough** — 4 flow live trên app thật:
  chat kèm nguồn (`dryrun_answer_sources.png`), ngoài KB → handoff +
  hotline (`dryrun_handoff.png`), queue `answered:false`
  (`dryrun_queue.png`), guardrail flag "chữa" (`dryrun_guardrail.png`);
  0 console error; convlog entry latency thật (không fixture)

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

- Loader `ingest/core_store` delete-then-insert: child row
  `source='manual'` trỏ cha managed (products/plots) bị `on delete set
  null`/cascade sau mỗi reload — `plot_logs` nhập tay mất row cùng plot,
  orders/assets mất product link. Vá dài hạn: upsert `on conflict` thay
  delete+insert (cold-check v1.8 MINOR; đã ghi 1 dòng giới hạn trong
  `docs/schema.sql` + docstring loader). Cùng nhóm (đợt 2):
  (a) **partial-reload cắt link ngầm** — `products.jsonl` có mà
  `claims_whitelist.json` thiếu → products delete+insert lại, mọi
  `claims_approved.product_id` bị `set null` trong khi claims không
  reload để nối lại; tương tự plots có/logs thiếu → cascade xoá
  `plot_logs` kể cả `source='manual'`; (b) assets `source='multi'`:
  nguồn rút hẳn row → asset cũ tồn đọng + `product_id=NULL` sau reload
  products; (c) `data_audit.py` check `_doc` bằng `get("_doc")` truthy
  vs loader `"_doc" in rec` → lệch đếm trên `{"_doc":""}`; và
  `json.loads(l)["id"]` ở nhánh about-ids nằm NGOÀI except → file lỗi
  crash script thay vì "chưa nạp"; (d) `updated_at` trong schema không
  trigger/upsert → không bao giờ đổi; `apply_schema.py` chỉ bắt
  `OperationalError` (lỗi SQL trong schema.sql sẽ propagate); (e) gate
  test: `apply_rows` chưa chạy trên DB thật (fake-conn) → FK
  cascade/set-null chưa verify end-to-end. Đợt 3 (cold-check PASS
  kèm): (f) domain con bị skip trong khi domain cha reload vẫn mất
  dữ liệu con qua cascade/set-null — hướng vá ngoài upsert: skip
  luôn domain cha khi domain con phụ thuộc bị skip; (g) file cha bị
  cắt cụt MỘT PHẦN (products còn 1 record) vẫn xoá 26 record kia —
  skip-khi-0 không bắt được, cần ngưỡng tụt bất thường; (h) `main()`
  khi mọi domain đều skip vẫn exit 0 + in "[done] totals:" rỗng —
  nên exit ≠0 hoặc warn rõ; (i) products bị skip → `seg_to_pid` rỗng
  → claims nạp `product_id=NULL` (suy giảm link, không mất data).
- Lead store v1.9 (cold-check MINOR/NIT): intent substring heuristic
  false-positive — "giá" ăn "đánh giá", "ship" ăn từ chứa nó, "ở đâu"
  gán contact cho câu hỏi thông tin thuần; refine khi có OA data thật.
  `convlog_stats` đếm `answered` bằng truthiness — chuỗi `"false"`
  tính như đã trả lời (writer hiện ghi bool, chỉ malformed/manual
  convlog mới gặp). 30 leads hiện có là replay/mock/UI-test — demo
  phải gọi rõ "dữ liệu mẫu". Bảng leads insert-only giữ `question`/
  `user_hash` quá retention convlog 30d → quyết retention/redaction
  trước khi nạp khách thật (C2.0).
- WS2: ~~leads table + gom lead từ convlog; dashboard số liệu kênh~~
  (xong v1.9 — chỉ cover leads + convlog metrics, chưa phải social
  metrics); pipeline nội dung brief→draft→compliance→DUYỆT NGƯỜI→
  format đa kênh (FB/TikTok script/blog/Zalo OA)→lịch đăng — KHÔNG
  tự đăng (C2.4)
- WS3: agent báo cáo định kỳ ra file (không tự gửi); agent nhật ký
  vùng trồng form/chat→chuẩn hóa→cảnh báo bất thường (đã có bảng
  plot_logs); trợ lý tri thức nội bộ
- WS4: playbook/SOP/kiến trúc hệ thống/Phụ lục D test-set nghiệm thu

- PII trong `conversations.jsonl`: `question` đã mask SĐT/email bằng
  regex (v0.5), SĐT viết cách + retention theo tuổi vá ở v0.5.1,
  `+84`/`84` prefix + sep lặp cùng-ký-tự vá ở v0.6.2, SĐT dạng ngoặc
  vá ở v1.2 (unwrap digit-group), purge drop dòng không-ts cũng ở
  v1.2, ngoặc trộn-sep + nested vá ở v1.4, budget-abort tail +
  ngoặc↔bare + email bound vá ở v1.5 — còn lọt tên người; unwrap
  digit-group làm biến dạng text non-SĐT trong convlog ("đơn
  (12345)" → "đơn  12345") và over-mask "giá 500.000 (10) 0901234567"
  → "giá 500 ***" (che thừa, không rò); bare-run không ngoặc
  "0901 - 234.567" vẫn lọt (sửa = phá luật chống bridging khoảng
  giá — chấp định); ~~email local >256 lộ đầu và label >253 KHÔNG
  mask gì cả~~ — vá ở v1.7 (V8.3: lookbehind chặn slide + post-pass
  `_mask_email_oversize`; residual domain `b..c`/`@@b.com` ghi mục
  riêng dưới);
  neo-ngoặc V6.2 over-mask giá hợp lệ khi tổng digit ≥10
  ("50.000.000 - (1) - 2.000.000 - 3.000.000" → "50 ***" — che
  thừa convlog only, chấp định, ~~thiếu test biên 257/label-254~~
  — test biên đã có ở v1.7);
  over-mask nhẹ chấp nhận được ("abc84901234567" → "abc***",
  "2.000.000.000.000" → "2.***", "06.10.2026 09:30" → "***:30" —
  pre-existing); production cần mask đầy đủ hơn (pilot: local +
  gitignored)
- ~~Reject-sớm 411/413 không set `close_connection`~~ — vá ở v1.6
  (V7.1) cho do_POST + ~~`do_GET`~~ vá ở v1.7 (V8.1: framing báo
  body — chunked/CL≠0/CL-bad — đóng connection cả `/healthz` lẫn 404)
- ~~`_purge_convlog`/`_last_purge*` dùng `time.time()`~~ — vá ở v1.6
  (V7.2): mọi stamp interval trong-process đổi `time.monotonic()` +
  init `-inf`; wall-clock chỉ giữ cho ts-persist/`expires_at`/ts ISO
- ~~`_dedup` CASE `%:follow` giả định msg_id Zalo numeric~~ — vá ở
  v1.7 (V8.2): key `follow:{uid}` namespace prefix, eid msg `uid:mid`
  không bao giờ khớp kể cả mid=="follow"/kết ":follow"
- Email domain dạng-lạ quá bound còn lọt post-pass V8.3 — `x*300@b..c`,
  `x*300@@b.com` (domain không hợp lệ → không "email-like" → giữ
  nguyên); cùng class RFC-invalid, rò rất thấp (cold-check v1.7 MINOR)
- 2 process cùng ghi convlog (zalo + streamlit) → rotate race xuyên
  process (`_log_lock` chỉ trong-process) có thể mất file `.1`, cực
  hiếm ở pilot; nếu deploy 2 writer thật cần file-lock hoặc tách log
  (audit v0.6 NIT)
- Retention 30d purge cả entry `answered:false` → queue "Chưa trả lời"
  có horizon 30 ngày — câu nhân viên không follow-up kịp tự rơi khỏi
  queue. Consistent với intent retention; đáng nêu khi demo (audit
  v0.6 NOTE)

- ~~`_mask_pii` budget-abort bypass~~ — vá ở v1.5 (V6.1): đuôi còn
  `(` khi budget cạn → `***` thay emit raw
- ~~`_PII_RE` email bound edge~~ — vá ở v1.5 (V6.3): nới
  `{1,256}`/`{1,253}`; residual local >256 lộ đầu (RFC-invalid, chấp
  nhận); ~~SĐT lẫn ngoặc+bare "(0901) - 234.567"~~ — vá ở v1.5 (V6.2):
  bridge khi blob ≥10 digit
- Chatbot production trên Fanpage (Messenger API, Pancake hook) — Zalo OA
  đang ở v0.2; live OA thật cũng nằm đây nếu duyệt không kịp version
- Shopee/TikTok connector (inbox + listing sync) — dev app đã submit từ
  C2.0, chờ duyệt; catalog sync batch ≤500
- Đăng bài/listing mới lên OA/sàn — BẮT BUỘC human-approve step trong flow
  (guardrail chỉ là lưới heuristic, không thay người duyệt pháp lý)
- Zalo OA product catalog sync (27 SKU, batch ≤500)
- ~~Welcome follow dedup per-key TTL~~ — vá ở v1.6 (V7.3): key
  `:follow` sống FOLLOW_TTL_S 7d, refollow sau 7d vẫn welcome lại
  (re-engagement, chủ đích)
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
| v0.6.1 (patch) | Dry-run demo + caption persist: nhãn "Nguồn:"/"đã chuyển nhân viên" không còn mất khi Streamlit rerun | 2026-10-06 | `evidence/dryrun_*.png` 5 ảnh (answer+sources, handoff+hotline, queue, guardrail flag, caption sau rerun) · pytest 54/54 + ruff clean. Supervisor verdict **PASS** ×2 (dry-run + fix). Dọn repo root: xóa 2 `v5-dossier-*.png` ngoại (md5 trùng nhau, project khác) + 3 `dryrun_*.png` lạc do relative-path screenshot |
| v0.6.2 (patch) | Vá 4 NIT audit còn lại (convlog/PII hygiene): `sent:null` kênh UI, purge không giết reply + retry đúng, `_ui_hash` per-session, `_PII_RE` bắt `+84`/`84` + sep lặp cùng-ký-tự | 2026-10-06 | pytest 58/58 ×3 + ruff clean; commits `16dff2c` (contract) + `cee33f4` (code). Reviewer độc lập verdict FIX đợt 1 — major: `[ .-]*` nuốt sep TRỘN " - " nối 2 số → mất khoảng giá/ngày; vá `([ .-])\1*` cả 2 alternative. 3 NIT pre-existing → someday (SĐT dạng ngoặc, over-mask nhẹ abc84.../date+time). eval/mock skip theo precedent patch. Cold-audit session lạ: verdict **PASS** 5/5 claims (auditor tự chạy pytest 58/58 + trace regex + probe 12 case thêm), 1 NIT → someday (purge retry-per-write trong `_log_lock` khi fail dai dẳng); dọn 3 someday entry stale đã vá |
| v1.0-live-prep | OA connector plug-and-play khi có creds: token store + auto-refresh + rotate persist, tách 2 secret đúng contract (OA_SECRET signature / APP_SECRET oauth), preflight script, non-text reply, deploy artifacts | 2026-10-07 | `evidence/v10_pytest.log` 77/77 ×2 + ruff clean · `v10_mock.log` 3/3 · preflight dev exit 1 báo đúng mục thiếu; commits `e6e2cf2` + `ba90c19` (retro) + `4039c11` (DONE). Reviewer bắt 3 MAJOR vá hết (throttle refresh, cap event_name, systemd comment). Cold-check auditor lạ: mọi claim repo verify được PASS; live-Zalo UNVERIFIED = external chờ C2.0. Someday +5 |
| v1.1-oa-resilience (patch) | Vá 5 someday đã verify còn hỏng: proactive refresh theo `expires_at` (throttled), `_last_refresh_ok` tách attempt/success (chờ `_token_lock` khi refresh in-flight), `_mem_tokens` chỉ cover cửa sổ persist-fail, non-text qua `_ulock`, welcome `WELCOME_TEXT` khi `follow` | 2026-10-08 | `evidence/v11_pytest.log` 90/90 + `v11_ruff.log` clean; commits `5fe926f` (contract) + code. Lane worker chết connection-error giữa chừng → coordinator absorb. Reviewer FIX đợt 1: throttle proactive + `expires_in≤0`→expires_at=0 + chờ lock khi refresh in-flight + spy dispatch `handle_non_text`. Cold-check: FIX F1 major (mem đè store ghi bởi process khác → refresh token chết tới restart) → vá mem-chỉ-khi-persist-fail + test; re-audit **PASS**. F2/F3 minor → someday. eval/mock skip precedent patch |
| v1.2-convlog-hygiene (patch) | Vá 3 someday còn hỏng: `_mask_pii` unwrap nhóm ngoặc toàn-digit (SĐT "+84 (90)..."/"(+84)..." mask được, giá ngoặc không bị bridging), dedup follow bỏ ts (welcome ≤1 lần/SEEN_TTL_S/user), `_purge_convlog` drop dòng strptime-fail/ts-outlier (đổi policy "giữ thừa" → retention 30d đóng hở PII quá hạn) | 2026-10-09 | `evidence/v12_pytest.log` 92/92 (auditor tự chạy lại 151.7s) + ruff clean; commits `a30762b` (contract) + `6ebece4` (code) + `b07a367` (board). Reviewer FIX đợt 1: normalize ngoặc→space tạo bridging mới "(1.500.000)(2.000.000)" → vá unwrap-digit-group; `len(ts)==20` không đủ → strptime + horizon +1d. Re-audit PASS. Cold-check auditor lạ: **PASS** — tự xác định diff-range, chạy lại pytest 92/92 + ruff, 3 MINOR/NIT → someday (unwrap biến dạng text non-SĐT, over-mask "500.000 (10) 0901234567", ngoặc-trộn-sep lọt). eval/mock skip precedent patch. Dọn someday stale: "token refresh tự động" đã xong từ v1.0 |
| v1.5-pii-hardening (patch) | Vá 3 lớp leak còn lại trong `_mask_pii`/`_PII_RE` (cold-check v1.4 MINOR): budget-abort → đuôi còn `(` mask `***`; group ngoặc làm neo nối bare-run kề khi blob ≥10 digit ("(0901) - 234.567" mask được, "50.000.000 - 100.000.000" vẫn không bridge); email bound `{1,256}`/`{1,253}` | 2026-10-09 | `evidence/v15_pytest.log` 98/98 ×2 + ruff clean; commits `2249ad4` (contract) + `b2fd76d` (code) + `e3b9ffc` (board). Cold-check auditor lạ: **PASS** đợt 1 (tự chạy 98/98 17.6s, probe bridging/tail/email/budget sạch, perf linear 200K→0.68s) — 3 MINOR → someday (label>253 lộ hẳn, neo-ngoặc over-mask giá ≥10 digit, thiếu test biên 257/254) |
| v1.6-ops-hardening (patch) | Vá 3 someday defect probe-verify còn hỏng: `close_connection=True` trên reject body-chưa-đọc (411/400-CL/413 — keep-alive HTTP/1.1 không bị sót body nhiễu request kế), stamp interval → `time.monotonic()` + init `-inf` (clock lùi không đóng băng purge/refresh-throttle), `_dedup` per-key TTL — `:follow` sống 7d chặn welcome-spam unfollow/refollow | 2026-10-09 | `evidence/v16_pytest.log` 101/101 + ruff clean; commits `287dfe8` (contract) + `9952020` (code/tests/board). Worker chết connection-error giữa lane → coordinator absorb 3 test mới; Cold-check auditor lạ: **PASS** đợt 1 (tự chạy 101/101 26s + trace -inf/close_connection/SQL-CASE, 3 test không pass-ảo) — 2 MINOR → someday (msg_id `:follow` suffix TTL 7d, do_GET 404 không đọc body) + 1 NIT test-key-format vá ngay |
| v1.7-edge-hardening (patch) | Vá 3 someday defect probe-verify còn hỏng: `do_GET` `close_connection` khi framing báo body chưa đọc (chunked/CL≠0/CL-bad — cover `/healthz` lẫn 404, GET sạch giữ keep-alive); dedup namespace `follow:{uid}` (mid=="follow" không còn nuốt tin/hưởng nhầm TTL 7d); email oversize — `_PII_RE` + lookbehind chặn slide-partial + post-pass `_mask_email_oversize` mask run local>256/label>253 | 2026-10-09 | `evidence/v17_pytest.log` 105/105 (auditor tự chạy lại 30.9s) + ruff clean; commits `89f6460` (contract) + `6550049` (code/tests/board). Worker chết connection-error giữa lane → coordinator absorb V8.2 code + V8.3 + 4 test mới. Cold-check auditor lạ: **PASS** đợt 1 (probe tay email-bound/CL-lạ/perf-1MB sạch, không quadratic) — 2 MINOR vá ngay (khôi phục assert msg-key cleanup bị mất trong diff, thêm case CL `abc`/`0`), 1 MINOR → someday (domain `b..c`/`@@b.com` dạng-lạ không mask) |
| v1.4-pii-evasion (patch) | Vá 2 lớp leak SĐT cold-check v1.2: `_mask_pii` scanner 1-pass `_paren_group_end` depth-counting (merge nhóm ngoặc-digit kề qua sep bất kỳ + unwrap ngoặc lồng/space-trong-ngoặc) thay fixpoint regex; bound email-alt `{1,64}`/`{1,63}` | 2026-10-09 | `evidence/v14_pytest.log` 95/95 + ruff clean; commits `205784c` (contract) + `d7b3a72` (code) + `d72ce2b` (board) + `cd9ab65`+`41be08d` (FIX). Cold-check đợt 1 FIX: MAJOR fixpoint O(n·depth) — "("*5000 đốt >10s trong `_log_lock`, inbound 1MB không cap → scanner 1-pass O(n) + budget-rescan 4n (n=20000→0.015s); MINOR cap-32-leak tự hết; MINOR over-mask nhóm ngoặc toàn-digit ACCEPT+test. Đợt 2 auditor lạ: **PASS** (tự chạy 95/95, perf 8 case <0.1s, không scope creep) — 2 MINOR mới → someday (budget-abort bypass, email RFC-bound edge) + NIT số stale |
| v1.3-ops-polish (patch) | Purge-fail backoff: `_last_purge_attempt` throttle daily-purge retry (PURGE_RETRY_S=3600 — đĩa hỏng dai dẳng không còn kéo mọi reply thread xếp hàng O(file) trong `_log_lock`); `_isolated_files` vá latent leak `_last_purge` | 2026-10-09 | `evidence/v13_pytest.log` 92/92 (auditor tự chạy lại 17.7s) + ruff clean; commits `b8ed6e5` (contract) + `f48364a` (code) + `a27647c` (NIT reviewer). Reviewer PASS đợt 1, 2 NIT vá ngay (comment throttle, setattr thừa). Cold-check auditor lạ: **PASS** — tự định diff-range + chạy lại pytest 92/92 + ruff; 2 NIT: boot-purge-không-set-`_last_purge` vá ngay (global + set sau purge boot OK), clock-skew `time.time()` → someday |
| v1.8-core-db | WS1 nền tảng SOW: schema 6 bảng lõi (products/claims_approved/plots/plot_logs/orders/assets) + `ingest/core_store` loader idempotent delete-by-source + Phụ lục A đếm thật (`scripts/data_audit.py`, `docs/phu-luc-a.md`) + sample data plots/orders "chờ bàn giao" | 2026-10-10 | `evidence/v18_schema.log` (apply ×2 → 7 bảng public) · `v18_core_store.log` (×2 giống hệt: 27/22/3/6/5/219, 9/10 sku link) · `v18_audit.log` (10 domain) · `v18_pytest.log` 118/118 (coordinator tự chạy lại 29.8s) + ruff clean; commits `2bbfe5a` (contract) + `06ee856` (code) + `df0fc7d` (board) + `6d9b6b5` + `d120185` (FIX). Cold-check đợt 1+2 FIX cùng lớp lỗi "delete-trắng" (file thiếu → skip; file rỗng/0-record → skip+warn) — vá hết; đợt 3 auditor lạ **PASS** (probe corrupt-JSON crash-không-xoá, atomic txn, không nới assert) — 3 MINOR + 1 NIT → someday |
|| v1.9-leads | WS2 nền SOW: bảng `leads` (dedup_key unique, insert-only — không delete-by-source vì convlog rotate/purge) + `ingest/lead_store` harvest convlog+`.1` (intent partner/order/price/contact, channel suy từ `msg_id`) + tab Leads Streamlit read-only (convlog stats luôn hiện, DB-lỗi → st.info, `connect_timeout=3`) | 2026-10-10 | `evidence/v19_schema.log` (8 bảng public ×2) · `v19_leads.log` (harvest thật ×2 dup-30; rollback-only temp-table probe chứng minh 30-new→30-dup, public 30→30) · `v19_streamlit.log` + `v19_dashboard.png` (live + DB-unavailable, console 0 lỗi) · `v19_pytest.log` (131/131, focused 13/13 ×3, ruff clean); commits `c3387a0` (contract) + `af8d314` (code/tests/evidence/board) + commit đóng. Cold-check auditor lạ: **PASS** đợt 1 (tự chạy 131/131 + ruff + harvest → 30 rows) — 2 MINOR (intent substring FP, 30 leads là mock/replay phải nhãn "dữ liệu mẫu" khi demo) + 1 NIT (`answered` truthiness) → someday. Worker chết rate-limit giữa lane → resume/absorb; DB-fallback hang → `connect_timeout=3`; UI verify qua temp venv + Python Playwright (MCP root trỏ workspace khác) |
