# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **v2.4-polish** (loop /cycle 10, cycle 7/10)

Nhánh `ai-infra`: M31 đợt gộp 2026-10-12 — v4.0, v4.1, v4.4, v7.0, v7.3, v9.3,
v9.5 đã đóng + gộp (35 bảng). Tích hợp khi gộp: bổ sung DF-16 (intel) + DF-17
(persona_sim) vào `data/data_flow_map.json` + sinh lại DPIA/TIA nháp; phương án
rượu trong persona_sim nay bị guardrail v4.1 loại kể cả panel người lớn (flip
`test_validate_specific_reasons`). Đang chạy song song: v4.2, v4.5, v5.2, v7.2,
v9.2.

## Checklist v6.0-mkt-lich-mua

Khán giả/mục đích: WP08 (pmo.md dòng `| WP08`) — phần **MKT-00 Agent GĐ
Marketing (điều phối + cân tải duyệt)** và **MKT-01 Agent Lịch mùa vụ**
(final_plans.json `marketing.plan.agents[0..1]`); worktree
`D:\code\samsam-w44`. Hiện repo có khung GĐ khối (`pipelines/director.py` +
`data/directors/marketing.json`, v4.0), hàng duyệt chung
(`pipelines/approval_queue.py`), engine mùa (`pipelines/scenario.py`
`TET_DATES`/`tet_date`, v7.3), quota duyệt (`scripts/review_load.py`
`load_quota`/`cap_for` + `data/review_quota.json`, v4.4), readiness SKU×kênh
(`pipelines/guardrail._readiness_of` soi gương view `sku_readiness`) — nhưng
CHƯA có lịch chiến dịch: không ai biết brief/nháp/duyệt phải xong lúc nào để
kịp 11.11, 12.12, Tết 2027, và tải duyệt mùa cao điểm chỉ thấy khi đã quá
tải. Sau version: (a) `pipelines/mkt_calendar.py` THUẦN (không DB/LLM/mạng)
dựng lịch chiến dịch từ `data/marketing_calendar.json` + golden: mỗi chiến
dịch × kênh × định dạng có SKU đủ readiness, mốc brief/nháp/duyệt/đăng LÙI từ
ngày đăng theo SLA (giờ VN, né cuối tuần/ngày nghỉ), nhắc trước 14/7/3 ngày;
xuất markdown tuần/tháng + `.ics` (stdlib); (b) `agents/mkt_director.py`
(MKT-00, tất định, KHÔNG LLM): đẩy "brief chiến dịch" vào `approval_queue` qua
`director.submit` (không tự duyệt), dự báo tải duyệt/ngày so với quota →
cảnh báo + ĐỀ XUẤT dời (không tự dời), bản tin tuần GĐ Marketing. Không
agent nào đăng bài, hẹn lịch đăng, sinh nháp hay chi tiền.

Quy ước: ponytail — stdlib (`datetime`, `json`, `argparse`, `hashlib`) +
`psycopg` sẵn có; KHÔNG lib lịch/âm lịch/`icalendar`/pandas, KHÔNG pip
install. TÁI DÙNG (không viết lại): `pipelines.scenario.tet_date`/`week_start`
(Tết 2027 KHÔNG được ghi lại thành hằng ngày thứ hai ở module/JSON mới —
JSON dùng `"lunar_new_year": 2027` như `scenario_assumptions.json`);
`pipelines.period.VN_TZ`; `ingest.golden_store.read_golden`/`validate`/
`CHANNELS`/`GOLDEN_FILE`; `pipelines.guardrail._readiness_of` (KHÔNG chép lại
CASE readiness); `pipelines.director.load_config`/`submit`;
`pipelines.approval_queue.pending`; `scripts.review_load.load_quota`/`cap_for`
(bắt `ValueError` — `QuotaError` là subclass); `agents.report.write_report`
(atomic, bytes UTF-8); `ingest.lead_store.connect` (đã có `connect_timeout`).
Hàm thuần nhận `now`/`today`/`start` làm THAM SỐ — chỉ `main()` đọc đồng hồ
(`datetime.now(VN_TZ)`); test không wall-clock, không `time.sleep`. Mọi mốc
là `datetime` tz-aware giờ VN; phán "cuối tuần/ngoài giờ" trên NGÀY/GIỜ VN
(đầu vào UTC phải đổi sang VN trước khi xét). Config hỏng fail-closed đủ biến
thể (gotcha v1.8): file thiếu / rỗng / JSON hỏng / `{}` / chỉ `_doc` → lỗi
rõ, exit 1, không bao giờ ra lịch rỗng câm; số: `bool` không là số, âm/NaN
bị từ chối. Print tiếng Việt → UTF-8 guard sau imports (copy
`scripts/zalo_mock.py`). Output runtime chỉ vào `data/reports/` (đã
gitignore) — không file runtime mới khác trong `data/`. KHÔNG thêm bảng DB
(brief dùng `approval_queue` sẵn có) → kien-truc giữ "35 bảng". Lỗi/bản tin
chỉ nêu id chiến dịch/sku_key/tên field — không PII (lịch không chứa dữ liệu
khách). Mọi ghi DB: `conn.transaction()` + `conn.commit()` tường minh (đã nằm
trong `approval_queue.enqueue`).

External-dep (KHÔNG giả lập, để `[ ]` ở mục riêng cuối): (1) lịch chiến dịch
THẬT do GĐ Marketing chốt — file ship `"status": "GIẢ ĐỊNH — chờ GĐ Marketing
chốt"`, version này KHÔNG đổi status; (2) mùa thu hoạch thật do GĐ vùng trồng
xác nhận (mục harvest có `status` GIẢ ĐỊNH riêng); (3) quota duyệt thật (TGĐ
chốt `review_quota.json` `status: chot`; trần GĐ Marketing trong
`marketing_calendar.json` là GIẢ ĐỊNH); (4) người duyệt thật —
`marketing.json` `approvers`/`digest_recipients` giữ `[]`, không tự điền,
không đánh dấu ai đã duyệt; (5) `xnqc_records` (ô có SKU TPBVSK trỏ asset
XNQC) + `channel_policy` per SKU do Pháp chế/TGĐ ký — chưa có bảng, version
này chỉ dựa readiness golden (hiện mọi TPBVSK `xnqc_status=none` → `MO_TA`,
mật ong `self_declaration_ok` chưa có → `CAM`: lịch thật sẽ ra ít ô có SKU —
đúng hiện trạng, không "sửa" golden cho đẹp); (6) shot-list vùng trồng, trần
PHÚT theo tier (định mức 2/12/25 phút), timesheet/log Studio, gửi bản tin qua
kênh thật, cron n8n — version sau.

- [x] **W60.1 Cấu hình lịch mùa vụ + loader fail-closed** —
  `data/marketing_calendar.json`: `{"_doc": "... MKT-01 ... GIẢ ĐỊNH ...",
  "status": "GIẢ ĐỊNH — chờ GĐ Marketing chốt", "lead": {"publish_hour": 9,
  "approve_buffer_hours": 24, "draft_review_hours": 48, "work_start_hour": 8,
  "work_end_hour": 17}, "non_working_days": [YYYY-MM-DD...],
  "reminder_days": [14, 7, 3], "review_caps": {"gd_marketing_daily": int}
  (GIẢ ĐỊNH), "events": [{"id", "kind": "sale"|"holiday"|"tet"|"harvest",
  "date": "YYYY-MM-DD" HOẶC "lunar_new_year": 2027 (+ tuỳ chọn
  "offset_days"), "remind": bool, "status"? (bắt buộc với harvest, chứa
  "GIẢ ĐỊNH")}...], "campaigns": [{"id", "event", "publish_offset_days":
  int ≤ 0, "channels": [⊆ golden_store.CHANNELS], "formats": [⊆ FORMATS],
  "skus": "auto" | [sku_key...], "pillar": str}...]}`. Sự kiện tối thiểu:
  `20.10` (Phụ nữ VN), `11.11`, `20.11` (Nhà giáo), `12.12`, `24.12` (Noel),
  `01.01` (Tết dương 2027), `tet_2027` (`lunar_new_year: 2027`), ≥1 mùa thu
  hoạch (GIẢ ĐỊNH chờ GĐ vùng trồng); `remind: true` cho 11.11, 12.12,
  tet_2027. Chiến dịch ≥1 cho mỗi 11.11/12.12/tet_2027 + 1 chiến dịch câu
  chuyện thu hoạch (format `post`, `skus: []`). `pipelines/mkt_calendar.py`:
  `FORMATS = ("listing", "post", "ads", "koc", "livestream")`,
  `CalendarError(ValueError)`, `load_calendar(path=None) -> dict`
  (validate), `event_date(ev) -> date` (Tết qua `scenario.tet_date`; năm ngoài
  `TET_DATES` → `CalendarError`, không đoán). Validator chặn: `id` sự kiện/
  chiến dịch trùng; chiến dịch trỏ `event` không tồn tại; event có cả `date`
  lẫn `lunar_new_year` hoặc thiếu cả hai; kênh ∉ `CHANNELS`; format ∉
  `FORMATS`; `publish_offset_days` > 0 hoặc |…| > 60; giờ ngoài 0..23 /
  `work_start_hour ≥ work_end_hour`; số âm/`true`/NaN; harvest thiếu `status`
  GIẢ ĐỊNH; ngày sai định dạng.
  - Boundary: `pipelines/mkt_calendar.py` (mới), `data/marketing_calendar.json`
    (mới), `tests/test_mkt_calendar.py` (mới)
  - Gate: `python -m pytest -q tests/test_mkt_calendar.py -k "load or
    event"` xanh, gồm: `event_date(<tet_2027>) == scenario.tet_date(2027)`;
    `event_date` cho `lunar_new_year: 2031` → `CalendarError`; biến thể
    thiếu / rỗng / `{bad` / `{}` / chỉ `_doc` / trùng id / event lạ / kênh lạ
    / format lạ / offset dương / `true` thay số / `NaN` / harvest thiếu
    status → `CalendarError`; file repo thật load OK, `status` chứa "GIẢ
    ĐỊNH", đủ id sự kiện tối thiểu (so khớp tập, không substring). Grep chống
    hằng ngày Tết thứ hai: `grep -nE "2027-0?2-0?6|2027, *2, *6|\"02-06\""
    pipelines/mkt_calendar.py agents/mkt_director.py
    data/marketing_calendar.json` rỗng VÀ `grep -n "tet_date"
    pipelines/mkt_calendar.py` có dòng `from pipelines.scenario import` /
    `scenario.tet_date`
  - Evidence: `evidence/v60_calendar.log`
- [x] **W60.2 Engine lịch MKT-01 thuần: kênh × SKU readiness + lùi mốc theo
  SLA** — `to_workday(dt, lead, non_working) -> datetime` (đổi sang VN_TZ
  trước; nếu ngày VN là T7/CN/`non_working_days` hoặc giờ < `work_start_hour`
  → lùi về ngày làm việc TRƯỚC đó lúc `work_end_hour`:00; giờ >
  `work_end_hour` → cùng ngày `work_end_hour`:00; chỉ LÙI, không bao giờ
  đẩy muộn hơn). `milestones(publish_day, lead, brief_sla_hours,
  non_working) -> {"publish", "approve", "draft", "brief"}`: publish =
  ngày đăng `publish_hour`:00 VN (được rơi cuối tuần — sàn sale T7);
  approve = `to_workday(publish − approve_buffer_hours)`; draft =
  `to_workday(approve − draft_review_hours)`; brief = `to_workday(draft −
  brief_sla_hours)` với `brief_sla_hours` = `object_types["campaign_brief"]
  ["sla_hours"]` đọc từ `director.load_config("marketing")` (KHÔNG hằng số
  thứ hai). `build(cal, golden, start: date, weeks: int, brief_sla_hours:
  int) -> dict` → `{"campaigns": [{id, event, pillar, publish_day,
  milestones, cells: [{channel, format, skus: [...], note}], blocked:
  [{sku_key, channel, format, readiness, reason}]}], "reminders": [{event,
  days_before, day}], "status"}` — chỉ chiến dịch có publish_day trong
  [start, start + 7·weeks). Luật ô (đặt trước mọi thứ khác): SKU
  `category == "alcohol"` → KHÔNG BAO GIỜ vào `skus` của bất kỳ ô nào (mọi
  kênh trong `CHANNELS` đều online) — luôn vào `blocked` reason "rượu: không
  kênh online", kể cả khi config liệt kê đích danh và golden ghi
  `allowed_channels: ["shopee"]` (lệch đã biết v3.2); readiness =
  `guardrail._readiness_of(sku, channel)`; format `listing` nhận
  `MO_TA|TP_THUONG|QC_DAY_DU`; `post|ads|koc|livestream` chỉ nhận
  `TP_THUONG|QC_DAY_DU`; `skus: "auto"` = mọi SKU golden đủ readiness;
  `listing|ads|koc` không còn SKU nào → ô bị bỏ, ghi `blocked`;
  `post|livestream` không SKU → giữ ô với note "câu chuyện thương hiệu —
  không nêu tên SKU". Nhắc mốc: mỗi event `remind: true` sinh 3 nhắc
  `day = event_date − {14,7,3}` (theo `reminder_days`).
  - Boundary: `pipelines/mkt_calendar.py`, `tests/test_mkt_calendar.py`
  - Gate: `python -m pytest -q tests/test_mkt_calendar.py` xanh, gồm tối
    thiểu (lead fixture 9/24/48, brief SLA 48, giờ 8–17): đăng
    2026-11-11 (T4) → approve 2026-11-10 09:00, draft CN 08/11 → lùi
    **2026-11-06 17:00** (T6), brief 2026-11-04 17:00; đăng 2026-12-12 (T7)
    → publish giữ T7 09:00, approve 2026-12-11 09:00, draft 2026-12-09
    09:00, brief 2026-12-07 09:00; đăng 2026-11-16 (T2) → approve CN →
    2026-11-13 17:00; `publish_hour: 7` đăng 2026-11-11 → approve
    2026-11-10 07:00 trước giờ làm → 2026-11-09 17:00; đầu vào UTC
    `datetime(2026,11,13,23,30,tzinfo=UTC)` (= T7 06:30 VN) →
    `to_workday` = 2026-11-13 17:00+07 (bắt bug xét ngày theo UTC);
    `non_working_days: ["2027-01-01"]` mốc rơi 01/01 → 2026-12-31 17:00;
    property: mọi mốc mọi chiến dịch repo thật `brief ≤ draft ≤ approve ≤
    publish`, mọi brief/draft/approve rơi T2–T6 VN trong giờ làm, mọi mốc
    `tzinfo` offset +07:00; repo thật + golden thật: `ruou-sam-*` không có
    trong `skus` của ô nào, có trong `blocked` khi được liệt kê/`auto`;
    fixture golden có 1 TPBVSK `xnqc_status: approved` → vào `ads`; TPBVSK
    `MO_TA` (`savigout-30v`) → vào `listing` shopee, bị chặn `ads`/`koc`/
    `livestream`; SKU `allowed_channels: []` (`saphraton-40v`) → `CAM` mọi
    kênh; nhắc 11.11/12.12/tet_2027 có đủ `days_before ∈ {14,7,3}` với
    tet_2027 → 2027-01-23/01-30/02-03; `grep -nE "^(import|from)
    (psycopg|openai|httpx|requests)" pipelines/mkt_calendar.py` rỗng;
    `grep -n "time.sleep\|datetime.now\|date.today"
    tests/test_mkt_calendar.py` rỗng
  - Evidence: `evidence/v60_calendar.log`
- [x] **W60.3 Xuất lịch tuần/tháng + .ics + CLI MKT-01** —
  `render_markdown(plan, by="week"|"month") -> str` (dòng đầu = `status`
  file lịch + "Lịch ĐỀ XUẤT — GĐ Marketing duyệt trước khi chạy"; mỗi tuần
  (bắt đầu thứ Hai, `scenario.week_start`) / tháng: bảng `ngày | chiến dịch |
  kênh | định dạng | SKU | mốc` + nhắc mốc + mục "SKU bị chặn kênh");
  `render_ics(plan, now) -> str` stdlib RFC 5545: `BEGIN:VCALENDAR`,
  `VERSION:2.0`, `PRODID`, mỗi mốc (brief/draft/approve/publish) + mỗi nhắc
  = 1 `VEVENT` với `UID` ổn định (`<campaign>-<milestone>@samsam`, chạy lại
  ra cùng UID), `DTSTAMP` từ tham số `now`, `DTSTART` đổi sang UTC dạng
  `YYYYMMDDTHHMMSSZ`, `SUMMARY` escape `\\` `,` `;` xuống dòng; dòng kết thúc
  CRLF, gập dòng >75 octet. CLI `python -m pipelines.mkt_calendar [--start
  YYYY-MM-DD] [--weeks 4] [--by week|month] [--ics PATH] [--json]` (`main(argv)
  -> int`; thiếu `--start` → thứ Hai tuần này giờ VN; `--ics` mặc định ghi
  qua `write_report` vào `data/reports/`). Exit 0 OK · 1 lịch/golden/
  director config hỏng (`[err] <lý do>` stderr, không traceback) · 2 usage
  (ngày sai, `--weeks` ∉ 1..26, `--by` lạ). Không connect DB.
  - Boundary: `pipelines/mkt_calendar.py`, `tests/test_mkt_calendar.py`
  - Gate: test `main([...])` + `capsys`: `--start 2026-10-12 --weeks 4` có
    dòng "GIẢ ĐỊNH" + "ĐỀ XUẤT", có tuần 2026-11-09 chứa 11.11; `--by month
    --weeks 26` có tiêu đề tháng 2027-02; `--json` parse được, mọi mốc ISO có
    `+07:00`; .ics: parse lại bằng parser stdlib trong test (unfold CRLF +
    space, tách `BEGIN:VEVENT`…`END:VEVENT`) → số VEVENT = Σ mốc + nhắc, mọi
    VEVENT có UID/DTSTAMP/DTSTART/SUMMARY, UID không trùng, mốc đăng 11.11
    09:00 VN → `DTSTART:20261111T020000Z`; mọi dòng kết thúc `\r\n` và ≤75
    octet; SUMMARY chứa `,;` round-trip đúng; 2 lần render cùng `now` →
    byte-identical; usage sai → `SystemExit(2)`; lịch hỏng → 1. Lệnh thật:
    `python -m pipelines.mkt_calendar --start 2026-10-12 --weeks 18 --ics
    data/reports/mkt-calendar-2026-10-12.ics` exit 0 và `git status
    --porcelain data/` không có file mới
  - Evidence: `evidence/v60_calendar.log`
- [x] **W60.4 MKT-00 điều phối: brief chiến dịch vào approval_queue (không
  tự duyệt)** — `data/directors/marketing.json` THÊM `object_types.
  campaign_brief = {"sla_hours": 48, "risk": "medium"}` (KHÔNG `low` → không
  bao giờ vào làn auto_policy; giữ `approvers`/`digest_recipients` `[]`).
  `agents/mkt_director.py`: `brief_text(campaign) -> str` tất định (KHÔNG
  LLM): tên chiến dịch, sự kiện, trụ, kênh × định dạng, SKU đủ readiness,
  SKU bị chặn + lý do, 4 mốc giờ VN, nguồn (`data/marketing_calendar.json`
  + `data/golden_skus.json`, status GIẢ ĐỊNH) — không từ cấm, không claim
  công dụng. `enqueue_briefs(conn, plan, now, horizon_days=14, cfg=None) ->
  {"enqueued": [...], "skipped": [...]}`: chỉ chiến dịch `publish > now` và
  `brief ≤ now + horizon`; `object_id = campaign id`; đã có dòng
  `approval_queue` cùng `object_type='campaign_brief'` + `object_id` với
  status `pending|approved|rejected` → bỏ qua (idempotent — SELECT trước,
  index `approval_queue_pending_uq` là chốt cuối); gọi
  `director.submit(conn, "marketing", "campaign_brief", ..., created_by=
  "agent:MKT-00")` (guardrail do `enqueue` tự tính). Module KHÔNG gọi
  `decide`/`auto_approve`/`override`/`approve_draft`/`set_status`/`schedule`/
  `save_draft`/`record_publish`. CLI `python -m agents.mkt_director --briefs
  [--today YYYY-MM-DD] [--horizon-days N] [--dry-run]` (dry-run: in brief sẽ
  đẩy, không connect DB). Exit 0 OK · 1 config hỏng · 2 usage / DB down.
  - Boundary: `agents/mkt_director.py` (mới), `data/directors/marketing.json`,
    `tests/test_mkt_director.py` (mới)
  - Gate: `python -m pytest -q tests/test_mkt_director.py -k brief` xanh,
    gồm: `director.load_config("marketing")["object_types"]
    ["campaign_brief"]["risk"] != "low"`; `test_director.py::
    test_eleven_blocks_no_real_people` vẫn xanh; brief_text repo thật qua
    `guardrail.check()` → `ok is True`, không chứa `ruou-sam-` trong dòng
    SKU đủ readiness; DB thật (pattern schema tạm + rollback như
    `tests/test_director_framework.py`, 0 skipped khi có `DATABASE_URL`):
    chạy `enqueue_briefs` 2 lần cùng `now` → lần 2 `enqueued == []`, số dòng
    `approval_queue` `object_type='campaign_brief'` không đổi; mọi dòng
    `status='pending'`, `lane is null`, `decided_by is null`, `created_by =
    'agent:MKT-00'`, `due_at − created_at = 48h`; chạy thêm
    `director.run(conn, "marketing")` → các dòng vẫn `pending` (không auto);
    fake-conn: horizon lọc đúng (brief ngoài horizon / publish đã qua → không
    đẩy); `--dry-run` với `connect` monkeypatch `pytest.fail` → exit 0; DB
    down → exit 2. `grep -nE "decide\(|auto_approve|override\(|approve_draft|
    set_status|schedule\(|save_draft|record_publish" agents/mkt_director.py`
    rỗng
  - Evidence: `evidence/v60_director.log`
- [x] **W60.5 Cân tải duyệt: dự báo theo lịch vs quota → cảnh báo + đề xuất
  dời (không tự dời)** — `forecast_load(plan, quota, gd_cap, start, days) ->
  {"days": [{day, phap_che: n, gd_marketing: n, cap_phap_che, cap_gd}],
  "warnings": [str], "suggestions": [str]}` (THUẦN, không DB): mỗi ô của
  chiến dịch = 1 mục duyệt nháp Pháp chế tính vào NGÀY VN của mốc `approve`;
  mỗi chiến dịch = 1 mục duyệt brief GĐ Marketing tính vào ngày mốc `draft`.
  Trần Pháp chế = `review_load.cap_for(day, load_quota(...))` (ngày vắng →
  0; không phase phủ → cảnh báo "không có quota", không coi = vô hạn); trần
  GĐ = `review_caps.gd_marketing_daily`. Vượt trần → warning
  `VƯỢT QUOTA <role> <YYYY-MM-DD>: <n> mục > trần <cap>` + suggestion "ĐỀ
  XUẤT dời mốc duyệt <campaign> sang <ngày làm việc sớm hơn gần nhất còn
  trống, không sau mốc đăng> — GĐ Marketing quyết" (không còn ngày trống
  trong 7 ngày trước → "đề xuất giảm số ô"). Hàm KHÔNG sửa `plan` (dict
  truyền vào giữ nguyên), không ghi DB/file. CLI `python -m
  agents.mkt_director --load [--today] [--days 28] [--quota PATH]` in bảng
  tải + cảnh báo + câu "Chỉ đề xuất — lịch không bị dời tự động"; exit 0 cả
  khi có cảnh báo; quota hỏng → 2 trước khi đọc lịch.
  - Boundary: `agents/mkt_director.py`, `tests/test_mkt_director.py`
  - Gate: `python -m pytest -q tests/test_mkt_director.py -k load` xanh,
    gồm: fixture 3 chiến dịch cùng ngày duyệt, quota `daily_cap: 2` → có
    warning `VƯỢT QUOTA phap_che` đúng ngày + ≥1 suggestion chứa "ĐỀ XUẤT";
    `copy.deepcopy(plan) == plan` sau khi gọi (không tự dời); ngày trong
    `absent_days` có ≥1 mục → warning trần 0; ngày ngoài mọi phase →
    warning "không có quota"; tải dưới trần → `warnings == []`; đếm đúng:
    chiến dịch 2 kênh × 2 định dạng (đủ SKU) = 4 mục Pháp chế; mục đếm theo
    ngày VN của mốc (mốc 23:30 UTC = ngày VN hôm sau); quota hỏng → CLI
    exit 2 trước `connect`; `grep -n "connect\|execute" ` trong thân
    `forecast_load` rỗng (hàm thuần)
  - Evidence: `evidence/v60_director.log`
- [x] **W60.6 Bản tin tuần GĐ Marketing** — `bulletin(plan, load, queue_items
  | None, now) -> str` THUẦN + CLI `python -m agents.mkt_director --bulletin
  [--today YYYY-MM-DD] [--out-dir data/reports]` → `write_report` ra
  `data/reports/mkt-week-<thứ Hai VN>.md` (cùng tuần → cùng tên, ghi đè).
  Các mục: (1) chiến dịch 28 ngày tới + 4 mốc giờ VN + nhắc 14/7/3 ngày rơi
  trong tuần; (2) việc trễ hạn: mục `approval_queue.pending(conn,
  "marketing")` có `due_at < now` + chiến dịch đã qua mốc `brief` mà chưa có
  brief trong hàng; (3) tải duyệt dự báo vs quota 14 ngày (từ W60.5) kèm
  cảnh báo/đề xuất; (4) SKU bị chặn kênh (gộp sku_key × kênh × readiness ×
  lý do — rượu, MO_TA với ads/KOC/livestream, CAM); (5) dòng cuối "Agent
  không duyệt, không đăng, không chi tiền — quyết định thuộc GĐ Marketing".
  DB down (`connect()` None hoặc `psycopg.Error`) → vẫn sinh bản tin, mục
  (2) ghi "nguồn DB thiếu", exit 0. `title` mục hàng duyệt in qua
  `_mask_pii` + cắt 80 ký tự.
  - Boundary: `agents/mkt_director.py`, `tests/test_mkt_director.py`
  - Gate: `python -m pytest -q tests/test_mkt_director.py -k bulletin` xanh,
    gồm: `queue_items=None` → có "nguồn DB thiếu", vẫn đủ 4 mục còn lại; mục
    pending `due_at` trước `now` → nằm trong "trễ hạn", sau `now` → không;
    bản tin repo thật có `ruou-sam-` CHỈ trong mục "SKU bị chặn kênh"; có
    dòng "không chi tiền"; CLI với `connect` monkeypatch → None ghi file vào
    `tmp_path`, exit 0, tên `mkt-week-2026-10-12.md` khi `--today
    2026-10-14`. E2E degraded (evidence, không pytest): `DATABASE_URL=
    postgresql://u@10.255.255.1:5432/x python -m agents.mkt_director
    --bulletin --today 2026-10-12 --out-dir <scratchpad>` exit 0 trong ≤60s
    và file chứa "nguồn DB thiếu" (KHÔNG sửa `.env`)
  - Evidence: `evidence/v60_director.log`
- [x] **W60.7 Docs sop/kien-truc/playbook-mkt** — `docs/handover/sop.md` mục
  mới "5e. Lịch mùa vụ + điều phối Marketing (v6.0)": lệnh `python -m
  pipelines.mkt_calendar ...`, `python -m agents.mkt_director --briefs |
  --load | --bulletin`, nhịp chạy (thứ Hai sáng), GĐ duyệt brief bằng
  `python -m pipelines.approval_queue --approve ID --by ...`, mọi thứ GIẢ
  ĐỊNH/external-dep; `docs/handover/kien-truc.md`: dòng module
  `pipelines/mkt_calendar.py` + agent MKT-00 trong bảng Agents mục 5, điểm
  human-gate "brief chiến dịch → GĐ Marketing duyệt trong approval_queue",
  câu "35 bảng public" GIỮ NGUYÊN (không thêm bảng);
  `docs/handover/playbook-mkt.md`: đoạn ngắn "lịch tuần + bản tin + duyệt
  brief". Mọi lệnh trong docs chạy được thật.
  - Boundary: `docs/handover/sop.md`, `docs/handover/kien-truc.md`,
    `docs/handover/playbook-mkt.md`
  - Gate: `python -m pytest -q tests/test_handover_docs.py` xanh; `grep -n
    "mkt_calendar\|mkt_director" docs/handover/sop.md
    docs/handover/kien-truc.md` có dòng; `grep -n "35 bảng"
    docs/handover/kien-truc.md` còn; spot-check ≥3 lệnh trong mục 5e chạy
    exit 0/2 đúng (ghi output vào evidence)
  - Evidence: `evidence/v60_docs.log`
- [x] **W60.8 Gate chung** — targeted ×3 tuần tự: `python -m pytest -q
  tests/test_mkt_calendar.py tests/test_mkt_director.py tests/test_director.py
  tests/test_scenario.py tests/test_review_load.py tests/test_handover_docs.py`
  (đọc output tới exit mỗi lần); full `python -m pytest -q` ĐÚNG 1 lần —
  xanh, ≥ 1682 + test mới, 0 failed, không skipped mới do thiếu DB; `ruff
  check .` clean; `python -m py_compile pipelines/mkt_calendar.py
  agents/mkt_director.py`; `python -c "import json; json.load(open(
  'data/marketing_calendar.json', encoding='utf-8'))"`; `git status
  --porcelain` chỉ có file trong Boundary + `evidence/v60_*.log` (force-add
  — `*.log` bị gitignore), không file lạ trong `data/`; `tests/
  test_connect_timeout_guard.py` xanh (mọi connect có timeout).
  - Boundary: toàn bộ ở trên
  - Gate: như trên
  - Evidence: `evidence/v60_pytest.log`

Ghi chú worker (lệch/diễn giải contract, có lý do):
- W60.2 cửa sổ `build`: lấy chiến dịch có ngày đăng ≥ `start` VÀ mốc
  brief < `start + 7·weeks` (không chỉ publish trong kỳ) — bắt buộc để
  gate W60.3 "`--weeks 4` từ 12/10 có tuần 09/11 chứa 11.11" pass (brief
  11.11 = 04/11 nằm trong kỳ; GĐ cần thấy việc phải làm trong kỳ).
  Test `test_window_filter` khóa luật mới.
- Thêm khóa ngoài contract: event `off_days` (ngày nghỉ Tết tính theo
  offset từ mùng 1 — GIẢ ĐỊNH, không ghi ngày Tết dương lịch), chiến dịch
  `dropped` (ô listing/ads/koc bị bỏ vì không còn SKU); lý do CAM tách 3
  loại (ngoài allowed_channels / thực phẩm chưa tự công bố / khác).
- W60.4 `brief_text`: SKU rượu KHÔNG nêu tên trong brief (guardrail v4.1
  chặn mọi nhắc rượu kể cả sku_key → brief ok=False thì GĐ không duyệt
  được) — chỉ đếm "N SKU chỉ bán offline"; danh sách đủ ở bản tin GĐ.
- W60.6 việc trễ hạn đọc hàng bằng SELECT cột metadata (`_QUEUE_SQL`)
  thay `approval_queue.pending` — `pending` đọc `payload` mà role
  `agent_writer` không có quyền (least privilege); test DB chạy dưới
  `agent_writer`.
- W60.4 không chạy `--briefs` thật lên DB dùng chung `samsam_infra` (tránh
  để lại mục pending thật); hành vi DB verify bằng test schema tạm +
  rollback (0 skipped), CLI verify `--dry-run` + DB down.

External-dep (để `[ ]`, không treo version):
- [ ] Lịch chiến dịch thật do GĐ Marketing chốt (đổi `status` file lịch)
- [ ] Mùa thu hoạch thật do GĐ vùng trồng xác nhận
- [ ] Quota duyệt thật (TGĐ chốt `review_quota.json`; trần GĐ Marketing)
- [ ] Người duyệt thật + SSO (`marketing.json` `approvers`), gửi bản tin qua
  kênh thật
- [ ] `xnqc_records` + `channel_policy` per SKU (Pháp chế/TGĐ ký); shot-list
  vùng trồng, trần phút theo tier + timesheet (MKT-00 acceptance 2/3) — version
  sau

## Checklist v4.0-director-framework

Khán giả/mục đích: M31 (worktree `D:\code\samsam-w40`) — làm nốt WP03
"Khung điều phối, duyệt và log dùng chung" (pmo.md dòng `| WP03`) trên nền
v3.4 (`approvals`, `agent_action_log` hash chain, `approve_draft` SECURITY
DEFINER, `pipelines/auth.py`) + nối đóng băng v3.10 vào `deploy_gate` v3.5.
Hiện hàng duyệt chỉ có cho `content_drafts`; 11 agent giám đốc (khối
`ceo, sales, marketing, intel, finance, production, farming, projects,
legal_hr, mechanical, data_platform` — key của ctx/final_plans.json) chưa
có chỗ gom việc của agent nhân viên, chưa có SLA/expired, override QA,
cảnh báo đỏ không xóa được, `channel_snapshots` cho cockpit; `agents/
report.py::period_bounds` cắt kỳ theo 00:00 **UTC** (lệch 7 giờ với VN);
`scripts/deploy_gate.py` còn đọc khung `freeze` riêng trong
`data/eval/config.json` (không biết break-glass). Sau version: mọi loại
object (trừ `content_draft` — giữ đường v3.4) vào `approval_queue` 2 lớp
(auto_policy mặc định TẮT / per_item), quyết định CHỈ qua function SECURITY
DEFINER ghi `approvals` (sha256) + `agent_action_log`; quá SLA → `expired`
(không bao giờ tự duyệt); ép trình bản QA FAIL phải có `decisions`
override_qa kèm lý do + người; `red_alerts` append-only, người nhận độc lập
(không phải TGĐ/ha_tang), thiếu người nhận → fail-closed báo thiếu; mẫu
agent giám đốc đọc `data/directors/<khoi>.json` sinh bản tin markdown
(KHÔNG tự gửi); 1 nguồn `period_bounds` giờ VN; deploy_gate dùng
`pipelines.freeze.check()` (lịch `data/freeze_calendar.json` + break-glass).

Quy ước: ponytail — stdlib + `psycopg` sẵn có, KHÔNG dep mới. Schema chỉ
THÊM vào `docs/schema.sql` (block "v4.0 hàng duyệt dùng chung", comment
tiếng Việt ai ghi/ai đọc/vì sao): `create table if not exists` + `create
or replace function/trigger`, KHÔNG `alter table`/`drop` (drift-guard
`tests/test_store.py` + `tests/test_lead_store.py` giữ nguyên); không assert
đếm cứng số bảng (sàn `>= 24` / đọc schema.sql). Function mới theo đúng
mẫu v3.4: `language plpgsql security definer set search_path from current`
+ `revoke execute ... from public` ngay sau; raise thông điệp tiếng Việt;
sha256 byte-exact `encode(sha256(convert_to(t,'UTF8')),'hex')` == Python
`hashlib.sha256(t.encode('utf-8')).hexdigest()`; mọi bước ghi
`agent_action_log` (trigger hash chain v3.4 tự ép id/ts/hash); detail log
KHÔNG chứa payload (chỉ id/sha/kind). Ngày/giờ VN: Python dùng
`pipelines/period.py::VN_TZ` (UTC+7, VN không DST — không cần tzdata),
SQL `now() at time zone 'Asia/Ho_Chi_Minh'`. Object_type `content_draft`
bị CẤM trong `approval_queue` (nếu cho, 1 approval qua hàng chung với
object_id = id draft làm `verify_publish`/`schedule_draft` của draft đó
pass mà không qua `approve_draft`). Python ghi trên conn chia sẻ phải
`conn.commit()` tường minh (gotcha savepoint v2.1); mọi connect có
`connect_timeout` (guard `tests/test_connect_timeout_guard.py`); print
tiếng Việt → UTF-8 guard; CLI nhiều op → `n_ops > 1` usage exit 2 TRƯỚC
connect (gotcha v2.2); identity in stdout của alert/queue chỉ là tên người/
agent, title/detail alert qua `_mask_pii` trước khi ghi. Test DB thật: 1
transaction + schema tạm + `docs/schema.sql` ×2 + `docs/roles.sql` ×2 rồi
ROLLBACK (fixture như `tests/test_auth_approval.py::db`), mỗi case lỗi
trong savepoint, thử quyền bằng `set local role agent_writer|app_human`,
đi tắt thời gian (due_at quá khứ) bằng superuser `set local
session_replication_role = replica` (precedent v3.4); skip khi không DB
nhưng gate đòi **0 skipped**. KHÔNG duyệt/expire/override mục nào trên DB
thật ngoài test rollback; KHÔNG bật auto_policy nào (bảng `auto_policies`
ship rỗng); KHÔNG điền người nhận/người duyệt thật (để `[]`).

External-dep (KHÔNG giả lập, KHÔNG tự đánh dấu): người nhận cảnh báo đỏ
thật (Pháp chế xác nhận) + kênh gửi thật (email/Zalo — version này chỉ ghi
hàng `red_alerts` có danh sách người nhận, không gửi); danh sách người
duyệt theo khối (TGĐ chốt) + vai trò riêng cho khối chưa có trong
`auth.ROLES` (tài chính/sản xuất/vùng trồng/dự án/cơ khí/tình báo tạm map
`tgd`); chủ khối ký phạm vi auto_policy (`auto_policies.enabled`); SSO thật
(`approved_by` từ SSO — hiện `--by` free-text như v3.4); object-lock neo
`agent_action_log`; BKS nhận báo override_qa (hiện chỉ log).

- [x] **W40.1 Schema: `approval_queue`, `auto_policies`, `decisions`,
  `channel_snapshots`, `red_alerts`** — `docs/schema.sql` block v4.0 (sau
  block v3.4, dùng lại `append_only_guard()`):
  `approval_queue` (`id bigint identity pk`, `object_type text not null
  check (object_type ~ '^[a-z][a-z0-9_]{1,39}$' and object_type <>
  'content_draft')`, `object_id text not null check (btrim <> '')`, `block
  text not null check (~ '^[a-z][a-z_]{1,31}$')`, `title text not null`,
  `payload text not null` (nội dung sẽ phát hành — đúng bản được hash),
  `content_sha256 text not null check (~ '^[0-9a-f]{64}$')`, `risk text not
  null check in ('low','medium','high')`, `guardrail jsonb not null`,
  `qa_status text not null default 'none' check in ('none','pass','fail')`,
  `created_by text not null check (btrim <> '')`, `created_at timestamptz
  not null default now()`, `due_at timestamptz not null`, `status text not
  null default 'pending' check in ('pending','approved','rejected',
  'expired')`, `lane text check (lane in ('auto_policy','per_item'))`,
  `decided_by text`, `decided_at timestamptz`) + unique partial index
  `(object_type, object_id) where status = 'pending'` + index `(block,
  status, due_at)`. Trigger `approval_queue_guard` (before update/delete +
  before truncate): DELETE/TRUNCATE → raise; UPDATE chỉ cho `status`
  pending → approved|rejected|expired (một lần) kèm `lane/decided_by/
  decided_at`; mọi cột khác (`payload`, `content_sha256`, `created_by`,
  `guardrail`, `risk`, `qa_status`, `due_at`, `block`...) bất biến;
  INSERT: trigger ép `content_sha256` = sha256(`payload`), `status
  ='pending'`, `lane/decided_*` null. `auto_policies` (`id text pk check (~
  '^[a-z0-9_]{1,40}$')`, `object_type text not null`, `max_risk text not
  null check (max_risk = 'low')` — cấu trúc cấm tự duyệt rủi ro medium/high,
  `enabled boolean not null default false`, `signed_by text`, `signed_at
  timestamptz`, `note text`, `check (not enabled or (btrim(coalesce(
  signed_by,'')) <> '' and signed_at is not null))`) — ship RỖNG.
  `decisions` (`id bigint identity pk`, `kind text not null check in
  ('override_qa','expired')`, `queue_id bigint not null references
  approval_queue(id)`, `decided_by text not null check (btrim <> '')`,
  `reason text not null check (char_length(btrim(reason)) >= 10)`,
  `created_at timestamptz not null default now()`, `db_role text not null
  default session_user`) — append-only (trigger `append_only_guard`).
  `channel_snapshots` (`id bigint identity pk`, `channel text not null check
  (~ '^[a-z][a-z0-9_]{1,31}$')`, `metric_id text not null check (~
  '^[a-z][a-z0-9_.]{1,63}$')`, `period_kind text not null check in ('day',
  'week','month')`, `period_start date not null`, `value numeric not null`,
  `source text not null check in ('manual_export','api')`, `source_ref
  text`, `captured_by text not null check (btrim <> '')`, `captured_at
  timestamptz not null default now()`, unique `(channel, metric_id,
  period_kind, period_start, source)`). `red_alerts` (`id bigint identity
  pk`, `ts timestamptz not null default now()`, `source_agent text not null
  check (btrim <> '')`, `title text not null check (btrim <> '')`, `detail
  jsonb not null default '{}'`, `recipients text[] not null default '{}'`,
  `route_error text`, `db_role text not null default session_user`) —
  trigger before insert ép `ts=now()`, `db_role=session_user`; trigger
  before update/delete/truncate → raise (append-only với DML khi trigger
  còn bật, cả của owner/superuser — KHÔNG chặn owner `DISABLE TRIGGER`/
  superuser `session_replication_role = replica`; chốt thật cho TGĐ/
  ha_tang là họ chỉ giữ DSN `app_human`, neo ngoài = external-dep).
  - Boundary: `docs/schema.sql` (append block v4.0), `tests/
    test_director_framework.py` (mới)
  - Gate: `grep -nE "^\s*(alter|drop)\s+table" docs/schema.sql` chỉ ra các
    dòng `alter table ... add column if not exists` CŨ (không dòng mới);
    `python scripts/apply_schema.py` ×2 exit 0, lần 2 in đủ 5 bảng mới; test
    DB (schema tạm, rollback): insert queue kèm `content_sha256` giả /
    `status='approved'` → bị ép về sha thật + `pending`; insert
    `object_type='content_draft'` → CheckViolation; 2 mục pending cùng
    (object_type, object_id) → UniqueViolation, sau khi mục đầu
    rejected/expired thì enqueue lại được; superuser UPDATE `payload` /
    `created_by` / `due_at` / status approved→pending / DELETE / TRUNCATE
    queue → RaiseException; insert `auto_policies` `max_risk='medium'` →
    CheckViolation, `enabled=true` thiếu `signed_by` → CheckViolation;
    `decisions.reason` 9 ký tự (sau btrim) → CheckViolation; UPDATE/DELETE/
    TRUNCATE `decisions` + `red_alerts` (superuser) → RaiseException;
    `channel_snapshots` source `'scrape'` → CheckViolation, trùng khóa →
    UniqueViolation
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.2 Function quyết định SECURITY DEFINER + quyền role** —
  `docs/schema.sql`: `enqueue_item(p_object_type text, p_object_id text,
  p_block text, p_title text, p_payload text, p_risk text, p_guardrail
  jsonb, p_qa_status text, p_created_by text, p_sla_hours int) returns
  bigint` (`p_sla_hours` 1..720 else raise; `due_at = now() + sla`; log
  `queue_enqueue` detail {queue_id, sha, block}). `decide_item(p_id bigint,
  p_decider text, p_decision text, p_note text default null) returns bigint`
  (id approvals) — `for update`; raise khi decider rỗng / không tìm thấy /
  status ≠ pending / `now() >= due_at` ("quá hạn SLA — chờ expire, không
  duyệt") / decision ∉ (approved, rejected); `approved` thêm: `guardrail->>
  'ok'` ≠ `'true'` → raise; `qa_status='fail'` VÀ chưa có `decisions`
  override_qa cho mục → raise; `lower(btrim(created_by)) = lower(btrim(
  decider))` → raise (reject thì người tạo tự rút được — như
  `reject_draft`). OK → update queue (`lane='per_item'`) + insert
  `approvals` (`object_type`/`object_id` của mục, sha = `content_sha256`,
  decision) + log `queue_approve|queue_reject`, cùng transaction.
  `auto_approve_item(p_id bigint) returns bigint` — chỉ khi có
  `auto_policies` `enabled` cho đúng `object_type`, mục `risk='low'`,
  guardrail ok, `qa_status='pass'` (không `none`), chưa quá hạn; approvals
  `approved_by = 'auto_policy:' || policy.id` + log `queue_auto_approve`
  (detail kèm `signed_by` policy), `lane='auto_policy'`; không policy →
  raise (fail-closed). `override_qa(p_id bigint, p_by text, p_reason text)
  returns bigint` — mục pending + `qa_status='fail'` + `p_by` ≠ người tạo +
  lý do ≥ 10 ký tự sau btrim → insert `decisions` override_qa + log
  `queue_override_qa`; KHÔNG đổi status (vẫn cần `decide_item` của người).
  `expire_overdue(p_by text default 'system:sla') returns int` — mọi mục
  pending có `due_at <= now()` → `expired` (`decided_by=p_by`) + `decisions`
  expired (lý do "quá hạn SLA <due_at giờ VN>") + log `queue_expire`; KHÔNG
  ghi approvals, không bao giờ approved. `verify_publish` v3.4 dùng lại
  nguyên cho mục hàng chung. `docs/roles.sql` thêm: `agent_writer` —
  execute `enqueue_item`, `auto_approve_item`, `expire_overdue`; insert
  `(source_agent, title, detail, recipients, route_error)` red_alerts;
  insert `(channel, metric_id, period_kind, period_start, value, source,
  source_ref, captured_by)` channel_snapshots; KHÔNG `decide_item`/
  `override_qa`, không UPDATE/DELETE bảng nào. `app_human` (kế thừa) —
  select `approval_queue`, `auto_policies`, `decisions`, `channel_snapshots`,
  `red_alerts` + execute `decide_item`, `override_qa`; KHÔNG UPDATE/DELETE
  trực tiếp; `auto_policies` không ai ngoài owner ghi.
  - Boundary: `docs/schema.sql`, `docs/roles.sql`, `scripts/
    apply_schema.py` (không đổi trừ khi cần in thêm), `tests/
    test_director_framework.py`
  - Gate: `python scripts/apply_schema.py --roles` ×2 exit 0 (2 role
    login=False); test DB: 5 function mới `prosecdef` true, `proconfig`
    search_path kết thúc `pg_temp`, `has_function_privilege('public',...)`
    false; `has_function_privilege('agent_writer','decide_item(bigint,text,
    text,text)','execute')` = false và `override_qa(...)` = false.
    `agent_writer`: `update approval_queue set status='approved'` /
    insert approvals / delete red_alerts / `select decide_item(...)` →
    InsufficientPrivilege. `app_human`: delete/update `red_alerts` →
    InsufficientPrivilege (TGĐ/ha_tang là người = app_human); superuser
    delete/update/truncate `red_alerts` → RaiseException (trigger) — cảnh
    báo vẫn còn đủ. `decide_item` approve: guardrail `ok=false` → lỗi;
    decider = creator (biến thể `' Lan '`/`'lan'`) → lỗi; decider rỗng →
    lỗi; QA fail chưa override → lỗi; happy → status approved, 1 dòng
    approvals sha = Python sha của payload, `verify_publish(object_type,
    object_id, payload)` true, payload sửa 1 ký tự → false; approve lần 2
    → lỗi. `override_qa` lý do rỗng / `'   ngắn   '` (<10 sau btrim) → lỗi;
    người override = người tạo → lỗi; override hợp lệ → decisions 1 dòng,
    status vẫn pending, rồi `decide_item` người khác → approved. Hết hạn:
    replica set `due_at = now() - 1h` → `decide_item` approve lỗi "quá hạn",
    `expire_overdue()` trả 1 → status `expired`, `decisions` expired 1 dòng,
    `approvals` cho mục = 0 dòng, `verify_publish` false; gọi lại trả 0.
    `auto_approve_item`: không policy → lỗi; policy `enabled=false` → lỗi;
    policy bật + risk `medium` → lỗi; qa `none` → lỗi; risk low + qa pass +
    guardrail ok → approved, `approved_by` bắt đầu `auto_policy:`. Sau mỗi
    luồng `verify_action_log()` rỗng (sửa/xoá log vẫn bị phát hiện — test
    v3.4 giữ xanh)
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.3 `pipelines/approval_queue.py` — wrapper Python + CLI
  người** — `enqueue(conn, *, object_type, object_id, block, title, payload,
  risk, created_by, sla_hours, qa_status='none')`: TỰ chạy
  `pipelines.guardrail.check(payload)` (không nhận guardrail từ caller —
  agent không giả `ok:true` được), `created_by`/`payload` strip rỗng →
  `ValueError` trước khi chạm DB, rồi `select enqueue_item(...)` +
  `conn.commit()`. `decide(conn, item_id, decider, decision, note=None)`:
  approve → đọc `payload` từ DB, chạy LẠI `guardrail.check` — không ok →
  `(False, msg)` KHÔNG gọi function; lỗi function (`psycopg.Error`) →
  `(False, diag.message_primary)` không raise. `override(conn, item_id, by,
  reason)`, `auto_approve(conn, item_id)`, `expire_overdue(conn, by=
  'system:sla') -> int`, `pending(conn, block=None)` (list dict, không kèm
  payload đầy đủ — cắt 200 ký tự). `verify(conn, item_id, text) -> bool`
  qua `verify_publish`. CLI `python -m pipelines.approval_queue`:
  `--pending [--block K]` | `--approve ID --by` | `--reject ID --by
  [--note]` | `--override-qa ID --by --reason` | `--expire`; `n_ops` > 1
  hoặc thiếu `--by`/`--reason` → usage exit 2 trước connect; DB down →
  exit 2 có thông báo; lỗi quyết định → exit 1. UTF-8 guard; connect
  `connect_timeout=5`.
  - Boundary: `pipelines/approval_queue.py` (mới), `tests/
    test_approval_queue.py` (mới, fake conn + argparse), `tests/
    test_director_framework.py` (đường DB)
  - Gate: test fake conn: payload chứa "chữa" nhưng DB trả guardrail
    `{"ok": true}` → `decide` approve trả `(False, ...)` và KHÔNG execute
    `decide_item`; `enqueue` gọi `enqueue_item` với guardrail do
    `guardrail.check` tính (assert param); created_by `'  '` → ValueError,
    0 execute; function raise → `(False, msg)`; argparse: `--approve 1`
    thiếu `--by` → exit 2, `--approve 1 --by X --expire` → exit 2,
    `--override-qa 1 --by X` thiếu reason → exit 2 — connect không được
    gọi (monkeypatch); test DB (`_TxConn` ghi nhận commit, `set local role
    app_human`): enqueue (as agent_writer) → decide approve bởi người khác
    → `verify` true đúng payload, false payload sửa; CLI trên DB thật CHỈ
    case âm: `python -m pipelines.approval_queue --approve 999999999 --by X`
    exit 1 (không tìm thấy), `--pending` exit 0
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.4 Cảnh báo đỏ: `pipelines/red_alert.py` +
  `data/red_alert_routing.json`** — config `{"_doc": ..., "recipients": [],
  "excluded_roles": ["tgd", "ha_tang"]}` (recipients = list `{"name",
  "role", "channel"}`; người thật = external-dep, Pháp chế xác nhận).
  `load_routing(path=None)`: file thiếu/rỗng/JSON hỏng/`{}`/chỉ `_doc` →
  recipients `[]` (không raise); recipient có `role` NGOÀI allowlist
  `INDEPENDENT_ROLES` (`phap_che`, `bks`), thuộc `excluded_roles`, hoặc
  thiếu name/channel → BỎ (độc lập với người có thể dập cảnh báo) + ghi
  vào `problems`; `raise_alert` lọc LẠI routing truyền tay cùng luật. `raise_alert(conn, source_agent, title, detail=None,
  routing=None) -> (routed: bool, msg)`: title/detail qua `_mask_pii`;
  recipients rỗng → VẪN insert `red_alerts` với `recipients='{}'`,
  `route_error='thiếu người nhận độc lập (external-dep)'`, trả `(False,
  ...)` + in cảnh báo stderr (fail-closed: không im lặng, không gửi nhầm
  TGĐ/ha_tang); đủ → insert recipients = tên, `(True, ...)`. KHÔNG gửi
  thật (kênh gửi = external-dep). Mọi insert + 1 dòng log `red_alert_raise`
  cùng transaction, `conn.commit()`. CLI `python -m pipelines.red_alert
  --check-routing` → exit 0 nếu ≥1 người nhận hợp lệ, exit 1 in "thiếu
  người nhận" (config thật hiện `[]` → exit 1 — đúng, ghi external-dep).
  - Boundary: `pipelines/red_alert.py` (mới), `data/
    red_alert_routing.json` (mới), `tests/test_red_alert.py` (mới), `tests/
    test_director_framework.py` (đường DB)
  - Gate: `load_routing` 5 biến thể file hỏng → `[]`; recipient role `tgd`
    / `ha_tang` / `' TGD '` (strip+lower) bị loại; config thật
    `recipients == []` (test khóa: không ai tự điền người thật); `raise_alert`
    fake conn recipients rỗng → insert có `route_error`, trả False; title
    chứa SĐT `0912 345 678` → giá trị insert đã mask; `python -m
    pipelines.red_alert --check-routing` exit 1. DB (rollback): raise_alert
    as `agent_writer` → 1 dòng red_alerts + 1 log; `app_human` + superuser
    xóa/sửa → bị chặn (W40.2 gate)
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.5 `pipelines/period.py` — period_bounds giờ VN dùng chung** —
  `VN_TZ = timezone(timedelta(hours=7))`; `period_bounds(kind, ref) ->
  (start, end_excl)` aware +07:00, `kind` ∈ `day|week|month` (tuần ISO thứ
  Hai 00:00 VN), `ref` là `date` (ngày VN) hoặc `datetime` aware (đổi sang
  VN rồi lấy ngày); naive datetime → `ValueError`, kind lạ → `ValueError`,
  kiểu khác → `TypeError`. `rolling_bounds(days, until=None)` — thay thân
  `agents/report.py::period_bounds`: `until` date → end_excl = (until+1)
  00:00 VN; None → now; aware datetime giữ nguyên; naive → `ValueError`
  (luật "mix date local + giờ UTC" v2.4). `agents.report.period_bounds`
  giữ tên/chữ ký, gọi `rolling_bounds`; `report_name` + dòng in kỳ lấy ngày
  theo VN; help `--until` "mặc định hôm nay giờ VN". `pipelines/freeze.py`
  KHÔNG đổi (VN_TZ riêng giữ nguyên — tránh đụng v3.10).
  - Boundary: `pipelines/period.py` (mới), `agents/report.py`
    (`period_bounds`, `report_name`, help), `tests/test_period.py` (mới),
    `tests/test_report.py` (flip 2 test period: kỳ ngày 10/10 → since
    `2026-10-04 00:00+07`, until `2026-10-11 00:00+07`; naive → ValueError)
  - Gate: tuần vắt 2 tháng: `period_bounds('week', date(2026,10,1))` →
    (`2026-09-28 00:00+07`, `2026-10-05 00:00+07`); tuần vắt năm
    `date(2027,1,1)` → (`2026-12-28`, `2027-01-04`); ranh giới 00:00 VN:
    `datetime(2026,9,27,16,59,59,tzinfo=UTC)` → tuần bắt đầu 2026-09-21,
    `datetime(2026,9,27,17,0,tzinfo=UTC)` → 2026-09-28; tháng:
    `datetime(2026,12,31,17,0,tzinfo=UTC)` → tháng 01/2027; `day` của
    `datetime(2026,10,11,16,59,tzinfo=UTC)` = 11/10 VN; naive → ValueError;
    `rolling_bounds(7, date(2026,10,10))` = (04/10 00:00+07, 11/10
    00:00+07); `test_report.py` số `assert` không giảm (đối chiếu trước/
    sau, gotcha v1.7); `report_name` của kỳ trên = `report-2026-10-04_
    2026-10-10.md`
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.6 Mẫu agent giám đốc `pipelines/director.py` + 11 cấu hình**
  — `BLOCKS` = 11 key (ceo, sales, marketing, intel, finance, production,
  farming, projects, legal_hr, mechanical, data_platform);
  `data/directors/<key>.json`: `{"_doc", "block", "name" (tên khối từ
  final_plans.json), "director_agent" (tên agent level director),
  "approver_roles" (⊂ `pipelines.auth.ROLES`; sales→gd_ban_hang,
  marketing→gd_marketing, legal_hr→phap_che, data_platform→[ha_tang, tgd],
  còn lại→tgd — tạm, TGĐ chốt), "approvers": [] (external-dep),
  "object_types": {"<type>": {"sla_hours": int 1..720, "risk": "low|medium|
  high"}} (không `content_draft`), "digest_recipients": [] (external-dep),
  "due_soon_hours": int}`. `load_config(block)` / `load_all()` → lỗi cấu
  trúc → `DirectorConfigError` (role lạ, sla ngoài khoảng, object_type
  `content_draft`, block ≠ tên file). `submit(conn, block, object_type,
  object_id, title, payload, created_by, qa_status='none')` — gom việc từ
  agent nhân viên: SLA + risk lấy từ CONFIG (caller không tự đặt), gọi
  `approval_queue.enqueue`; object_type ngoài config → ValueError.
  `run(conn, block, now)`: `expire_overdue` → thử `auto_approve` các mục
  pending risk low + qa pass (lỗi "không policy" = bình thường, bỏ qua) →
  đọc hàng của khối → `digest(cfg, items, now) -> str` (THUẦN, test được):
  markdown "Bản tin GĐ <name> — <ngày VN>": số pending/approved/rejected/
  expired trong ngày (dùng `period.period_bounds('day', now)`), mục sắp
  quá hạn (≤ due_soon_hours), mục expired hôm nay, override_qa hôm nay,
  dòng "Người duyệt chưa cấu hình (external-dep)" khi `approvers` rỗng,
  footer "BẢN NHÁP — hệ thống không tự gửi". Ghi `data/reports/director-
  <block>-<YYYY-MM-DD>.md` bằng `agents.report.write_report` (atomic, đã
  gitignore). CLI `python -m pipelines.director --block K | --all
  [--dry-run]` (dry-run = chỉ load + validate config, không DB), `__main__`
  bọc `job_run("pipelines.director")`; DB down → exit 2.
  - Boundary: `pipelines/director.py` (mới), `data/directors/*.json` (11
    file mới), `tests/test_director.py` (mới), `tests/
    test_director_framework.py` (đường DB `submit`/`run`)
  - Gate: `python -m pipelines.director --all --dry-run` exit 0 in 11 khối;
    test: `load_all()` đúng 11 key = tên file, mọi `approver_roles` ⊂
    `auth.ROLES`, mọi `approvers == []` và `digest_recipients == []` (khóa
    không tự điền người thật); config hỏng (role `ke_toan`, sla 0, sla 721,
    `content_draft`, block lệch tên file) → DirectorConfigError; `digest`
    với `now = 2026-10-12T23:30+07` chỉ đếm mục trong ngày 12/10 VN (mục
    `2026-10-12T16:59Z` = 23:59 VN tính, `2026-10-12T17:00Z` = 00:00 13/10
    không tính); `submit` object_type lạ → ValueError, 0 execute; DB
    (rollback): `submit` ghi `due_at - created_at` = sla config; `run` sau
    khi đẩy 1 mục quá hạn (replica) → mục `expired`, bản tin có mục đó,
    không approvals mới
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.7 `scripts/deploy_gate.py` dùng `pipelines.freeze.check()`** —
  bỏ khối `cfg["freeze"]`; `check(sha, approved_by, hotfix, today, cfg,
  now=None)`: `kind = "hotfix" if hotfix else "feature"`, `now` None →
  `datetime.combine(today, time(12), VN_TZ)` (mô phỏng `--today`); `main`
  KHÔNG có `--today` → truyền `now = datetime.now(VN_TZ)` thật (break-glass
  mở 14:00 phải có hiệu lực lúc 15:00 — mốc trưa cố định sẽ chặn oan);
  `ok, why = freeze.check(kind, now)` → `not ok` → `reasons.append(why)`.
  Break-glass đọc env `BREAK_GLASS_LOG` (như v3.10); lịch hỏng → fail-closed
  của `freeze.check` (feature bị chặn, hotfix qua). Xóa key `freeze` khỏi
  `data/eval/config.json` + sửa `_doc` của nó và của `data/
  freeze_calendar.json` (1 nguồn lịch); docstring deploy_gate điểm 4 +
  docstring "Điểm nối" trong `pipelines/freeze.py` cập nhật "đã nối v4.0".
  Hotfix/break-glass vẫn cần đủ điều kiện 1–3.
  - Boundary: `scripts/deploy_gate.py`, `data/eval/config.json`, `data/
    freeze_calendar.json` (`_doc`), `pipelines/freeze.py` (docstring),
    `tests/test_deploy_gate.py`, `tests/test_freeze.py` (docstring drift-
    guard nếu nhắc config v3.5)
  - Gate: `grep -n '"freeze"' data/eval/config.json` rỗng;
    `grep -n 'cfg\["freeze"\]' scripts/deploy_gate.py` rỗng; fixture
    `gate` đặt `BREAK_GLASS_LOG` rỗng (monkeypatch); 7 case
    `test_freeze_window_boundaries` cũ giữ nguyên kết quả (20/12 0, 21/12 1,
    15/01 1, 10/02 1, 11/02 0, hotfix 22/12 0, hotfix 10/02 0); break-glass:
    log tạm có record open 14:00–16:00 VN ngày 25/12 + FakeDT now 15:00 VN
    (không `--today`) → feature exit 0; now 16:30 → exit 1; record đã
    `close` → exit 1; `--today 2026-12-25` (mốc trưa) với cửa sổ 14–16h →
    exit 1 (mô phỏng không mở cửa sổ ngoài giờ trưa); lịch hỏng
    (monkeypatch `freeze.CALENDAR` → file `{}`) → feature exit 1 lý do
    "fail-closed", hotfix exit 0; `test_default_today_is_vn_date` giữ xanh;
    hotfix vẫn cần PASS + người duyệt (2 test cũ xanh)
  - Evidence: `evidence/v40_framework.log`
- [x] **W40.8 Docs** — `docs/handover/kien-truc.md`: "N bảng public" với N
  = số `create table if not exists` trong schema.sql (dự kiến 29 = 24 + 5),
  5 dòng bảng mới; mục Human-gate thêm "Hàng duyệt dùng chung" (2 lớp,
  expired không tự duyệt, override_qa, red_alerts append-only + người nhận
  độc lập); mục 6b bảng role thêm quyền mới; module `period.py`,
  `approval_queue.py`, `director.py`, `red_alert.py` vào bảng thư mục.
  `docs/handover/sop.md`: mục mới "Hàng duyệt chung & bản tin GĐ khối
  (v4.0)" (`python -m pipelines.approval_queue --pending/--approve/--reject/
  --override-qa/--expire`, `python -m pipelines.director --block K`,
  `python -m pipelines.red_alert --check-routing`, ai xử lý khi exit 1);
  mục deploy: đóng băng theo `data/freeze_calendar.json` + break-glass.
  `AGENTS.md` Commands: 3 dòng lệnh mới + sửa dòng "Cổng deploy" (lịch
  `data/freeze_calendar.json` + break-glass). `tests/test_handover_docs.py`
  `SOP_COMMANDS` thêm `pipelines.approval_queue`, `pipelines.director`,
  `pipelines.red_alert`.
  - Boundary: `docs/handover/kien-truc.md`, `docs/handover/sop.md`,
    `AGENTS.md` (Commands), `tests/test_handover_docs.py` (`SOP_COMMANDS`)
  - Gate: `python -m pytest tests/test_handover_docs.py -q` xanh (đủ tên
    bảng parse từ schema.sql + đúng "N bảng"); grep 3 lệnh mới có trong
    `AGENTS.md` và `sop.md`
  - Evidence: `evidence/v40_pytest.log`
- [x] **Gate chung** —
  - `python scripts/apply_schema.py --roles` ×2 exit 0 (in đủ bảng mới, 2
    role login=False)
  - targeted ×3: `python -m pytest tests/test_director_framework.py tests/test_approval_queue.py tests/test_red_alert.py tests/test_period.py tests/test_director.py tests/test_report.py tests/test_deploy_gate.py tests/test_freeze.py tests/test_auth_approval.py tests/test_handover_docs.py tests/test_store.py tests/test_lead_store.py tests/test_connect_timeout_guard.py -q -rs`
    3 lần liên tiếp xanh, test DB **0 skipped** (lệnh nặng có thể bị đẩy
    nền — đọc output tới exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 831 + test mới (ĐÚNG 1 lần/vòng)
  - `ruff check .` sạch
  - `python -m py_compile pipelines/period.py pipelines/approval_queue.py pipelines/director.py pipelines/red_alert.py agents/report.py scripts/deploy_gate.py`
  - `python -m pipelines.director --all --dry-run` exit 0;
    `python -m pipelines.red_alert --check-routing` exit 1 (thiếu người
    nhận — đúng thiết kế); `python -m pipelines.store --verify-log` exit 0
  - sau toàn bộ gate trên DB thật: `approval_queue`, `decisions`,
    `red_alerts`, `channel_snapshots` = 0 dòng; `auto_policies` = 0 dòng;
    `approvals` không tăng so với trước gate (không row test sót, không tự
    duyệt)
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file lạ (vd `lv2-market-top.png` giữ
    untracked); `data/red_alert_routing.json` + `data/directors/*.json`
    không chứa tên/email người thật
- [ ] **external-dep** Người nhận cảnh báo đỏ thật (Pháp chế xác nhận) +
  kênh gửi thật (email/Zalo) — hiện chỉ ghi `red_alerts`, routing `[]` →
  `--check-routing` exit 1.
- [ ] **external-dep** Danh sách người duyệt theo 11 khối + vai trò riêng
  cho khối chưa có trong `auth.ROLES` (TGĐ chốt); chủ khối ký phạm vi
  auto_policy (`auto_policies` ship rỗng).
- [ ] **external-dep** SSO thật (`approved_by` từ SSO thay `--by`
  free-text); object-lock neo `agent_action_log`; BKS nhận báo override_qa.

Kết quả worker (2026-10-12, evidence `evidence/v40_framework.log` +
`evidence/v40_pytest.log` — phải `git add -f`): apply_schema --roles ×2
exit 0 (29 bảng, 2 role login=False); targeted 13 file ×3 = 277 passed ×3,
0 skipped; full pytest vòng 1 FAIL 1 (drift-guard `test_db_backup` đòi
`deploy/cloud/README.md` liệt kê bảng mới) → vá README → vòng 2 923 passed,
0 skipped; ruff sạch; py_compile ok; director dry-run exit 0; red_alert
--check-routing exit 1 (đúng thiết kế); --verify-log exit 0; DB thật sau
gate: 6 bảng approvals/approval_queue/auto_policies/decisions/
channel_snapshots/red_alerts = 0 dòng. Lệch contract (ghi rõ):
(1) roles.sql thêm cho agent_writer `select (14 cột metadata — KHÔNG
payload/guardrail/sha) on approval_queue`, `select on decisions` +
`select (id) on red_alerts` — agent GĐ chạy `run` cần đọc metadata hàng,
`insert ... returning id` cần SELECT cột id (payload chỉ app_human đọc —
vòng sửa nghiệm thu); (2) CLI dùng lại
`ingest.lead_store.connect` (connect_timeout=3, không phải 5); (3) file
ngoài Boundary vá vì dây chuyền: `tests/test_agent_eval.py` (assert key
`freeze` cũ → assert đã bỏ), `deploy/cloud/README.md` (5 bảng mới + "29
bảng" — drift-guard test_db_backup); (4) thêm: deploy_gate bắt ValueError
của freeze.check (lịch thiếu kind → fail-closed, không traceback);
(5) `test_report.py` sửa thêm hằng S/U sang giờ VN + 3 mốc biên convlog
(fake-conn route theo params kỳ VN), số dòng assert 71 → 72.
auto_approve_item tin risk/qa/guardrail do caller khai (tiềm ẩn, vô hại khi
auto_policies rỗng — PHẢI có nguồn tin cậy trước khi bật policy).

Vòng sửa nghiệm thu (2026-10-12, 8 MINOR — evidence nối cuối
`evidence/v40_framework.log` + `evidence/v40_pytest.log`):
(1) override_qa lý do toàn `\n`/`\t` lọt (btrim chỉ cắt dấu cách) →
function đếm ký tự không-khoảng-trắng (`regexp_replace(..., '\s', '',
'g')`), lưu `btrim(p_reason, E' \t\r\n')`; CHECK `decisions.reason` (cài
mới) cùng luật; Python `override()` chặn trước DB. (2) Docs bỏ "kể cả
owner/superuser": chỉ đúng với `app_human` + DML khi trigger còn bật;
owner DISABLE TRIGGER / superuser replica vẫn xóa được → TGĐ/ha_tang
KHÔNG được giữ DSN owner/superuser (kien-truc.md, sop.md, schema.sql
comment, red_alert.py docstring, W40.1). (3) deploy_gate in `[warn]`
trước kế hoạch khi freeze cho qua TRONG khung (hotfix/break-glass/lịch
hỏng); `freeze.check` gắn "(người CHƯA xác minh)" khi
`holder_verified=false`. (4) agent_writer chỉ SELECT 14 cột metadata
`approval_queue` (KHÔNG payload/guardrail/sha); app_human SELECT đủ;
`decide()` đọc payload trong savepoint (role thiếu quyền không làm hỏng tx
conn chia sẻ). (5)+(7) red_alert allowlist `INDEPENDENT_ROLES =
("phap_che", "bks")` (không deny-list nhãn — 'TGĐ' có dấu/'tong_giam_doc'
bị loại); helper `_valid_recipients` dùng chung `load_routing` VÀ
`raise_alert` (routing truyền tay bị lọc lại). (6) test expire có mục còn
SLA phải giữ pending (mutation bỏ `due_at <= now()` → 2 test FAIL).
(8) runbook §4/§7 nói deploy_gate ĐÃ nối freeze (v4.0); test_runbook bỏ
deploy_gate khỏi list "nhánh khác" + test dương. Gate: apply_schema
--roles ×2 exit 0 (29 bảng); targeted 14 file ×3 = 299 passed ×3, 0
skipped; mutation M1/M2/M3 đều bị test bắt; full pytest 937 passed + 1
FAIL `test_dr_drill::test_zz_no_dr_container_left` (container
`samsam-dr-*` của worktree khác drill song song — docker dùng chung; sau
run `docker ps` sạch, `tests/test_dr_drill.py` chạy riêng 27 passed);
ruff sạch; DB thật 5 bảng mới = 0 dòng. Treo (thấy, không làm): runbook
dòng `health_bulletin` vẫn gắn "(nhánh khác: v3.7)" dù
`scripts/health_bulletin.py` đã có trong worktree.

Someday (ngoài v4.0, ghi để không cuốn vào): tab Streamlit "Hàng duyệt
chung" (hiện CLI); gửi bản tin/cảnh báo thật qua `health_bulletin` notify;
`red_alert_acks` (xác nhận đã nhận) + SLA 24h delivery_log; routing lưu DB
có chữ ký Pháp chế thay file git; function DB tự kiểm guardrail thay vì tin
snapshot (hiện Python re-check); `record_publish`/`approve_spend`/
`schedule_slot`; chuyển `content_drafts` sang hàng chung; cockpit đọc
`channel_snapshots` (WP10); `pipelines/freeze.py` dùng `period.VN_TZ`.

## Checklist v7.0-collector-chung

Khán giả/mục đích: WP09 (Trung tâm tình báo thị trường, `ctx/pmo.md` dòng
`| WP09`) — agent "Collector (thu thập tầng A/B)" + phần luật của "Dedup &
Classifier" (`ctx/final_plans.json` intel/agents[1..2]), luồng g4_intel
bước 1–3 (`ctx/flows_final.json`). Hiện `crawler/collect.py` chỉ cào site
của chính Sâm Sâm; chưa có gì thu tin NGOÀI (sâm, TPBVSK/thực phẩm chức
năng, đồ ăn giới trẻ, luật quảng cáo, đối thủ) để DA-03, PC-A8, Red Alert
dùng chung. Sau version: `python -m crawler.intel --run` đọc RSS/Atom của
nguồn tầng A/B, kiểm robots.txt, nhịp ≥1s/host, CHẶN CỨNG tầng C + sàn/MXH
(kể cả qua redirect), lọc theo chủ đề bằng LUẬT, lưu `intel_items` CHỈ
tiêu đề + trích ≤300 ký tự + link (không toàn văn), dedup URL chuẩn hóa +
hash nội dung; `--report` cho người đọc. Khối intel KHÔNG có đường ghi
sang `content_drafts`. Tầng P1-Shadow: không gửi ai, không đăng gì.

Quy ước: ponytail — MỞ RỘNG `crawler/` (module mới `crawler/intel.py`,
tái dùng `crawler.collect.strip_html` + `crawler.sources.CRAWL_DELAY_S`),
không viết lại collect. Chỉ stdlib + dep sẵn có: `httpx` (đã có),
`urllib.robotparser`, `xml.etree.ElementTree` (KHÔNG thêm `feedparser`/
`defusedxml`, KHÔNG sửa `requirements.txt`), `hashlib`, `email.utils`.
Tái dùng: `pipelines.pii._mask_pii` (title/snippet trước khi lưu),
`pipelines.kb_filter.is_alcohol` (cờ `ruou`), `pipelines.llm_gateway.
is_health_question` + `_strip_accents` (cờ `suc_khoe`, bản không dấu),
`pipelines.llm_gateway.chat` (LLM tùy chọn), `pipelines.guardrail.check`
(mọi text LLM sinh), `pipelines.job_runs.job_run`. Schema chỉ THÊM
(`create ... if not exists`). Mọi `psycopg.connect` có `connect_timeout`
(guard `tests/test_connect_timeout_guard.py`); ghi = 1 transaction +
`conn.commit()` tường minh (gotcha savepoint v2.1); print tiếng Việt →
UTF-8 guard sau imports; regex/loop trên text ngoài: cắt `PRE_MAX`
(1200 ký tự) TRƯỚC `_mask_pii` (gotcha DoS v1.4) rồi cắt 300 sau. Test
mạng = `http.server` local chạy thread trong test; nhịp đo bằng clock/
sleep GIẢ tiêm vào fetcher (KHÔNG assert wall-clock — gotcha timing). Test
DB thật = schema tạm + ROLLBACK (mẫu fixture `db` `tests/test_golden_store.py`),
0 skipped. Không file runtime mới trong `data/` (log request ra stdout,
evidence bằng `tee`). Danh sách nguồn ĐỀ XUẤT — mọi nguồn `status:
"cho_duyet"` tới khi BGĐ/Quản lý MXH duyệt (external-dep, KHÔNG tự đổi
sang `"duyet"`).

Luật CHẶN (cứng, không cấu hình nới được): hằng `HARD_BLOCK` trong
`crawler/intel.py` = hậu tố domain sàn/MXH (`shopee.vn`, `shopee.com`,
`shp.ee`, `tiktok.com`, `tiktokv.com`, `lazada.vn`, `lazada.com`,
`lzd.co`, `tiki.vn`, `sendo.vn`, `facebook.com`, `fb.com`, `fb.watch`,
`instagram.com`, `threads.net`, `x.com`, `twitter.com`, `zalo.me`) ∪ host
của mọi nguồn tier `C` trong file nguồn. `is_blocked(host)`: host
lowercase, bỏ dấu chấm cuối/port/userinfo, khớp khi `host == d` hoặc
`host.endswith("." + d)` (KHÔNG substring: `shopee.vn.evil.com`,
`notshopee.vn` không bị chặn bởi luật này). Kiểm TRƯỚC khi gửi request —
cả URL nguồn, robots.txt lẫn MỌI hop redirect (`follow_redirects=False`,
tự theo tối đa 3 hop, mỗi hop: scheme http/https, `is_blocked`, robots
của host mới, nhịp riêng host mới). Nguồn tier A/B mà host trúng
`HARD_BLOCK` (cấu hình sai) → `[blocked]`, bỏ nguồn đó, không request.

- [x] **W70.1 Danh mục nguồn + chủ đề (`data/intel_sources.json`)** —
  `{"_doc": "... ĐỀ XUẤT, chờ BGĐ/Quản lý MXH duyệt; tầng C cấm thu tự
  động ...", "llm": {"enabled": false, "_doc": "chờ Pháp chế xác nhận
  bằng văn bản cho gửi tin công khai qua LLM"}, "topics": {"sam": [...],
  "tpbvsk": [...], "gioi_tre": [...], "quang_cao": [...], "doi_thu":
  [...]}, "sources": [{"id", "name", "tier": "A"|"B"|"C", "url", "kind":
  "rss"|"atom", "topics_hint": [...], "status": "cho_duyet"|"duyet",
  "note"}]}`. Tier A: RSS chuyên mục báo chính thống/cơ quan nhà nước
  (sức khỏe, pháp luật, kinh doanh); B: trang ngành/blog công khai có
  RSS; C: liệt kê để CHẶN (MXH cá nhân, trang cần đăng nhập, Shopee/
  TikTok/Lazada) với `url` tượng trưng — tầng C không bao giờ chạy. Chủ
  đề: cụm CÓ dấu (vd "sâm ngọc linh", "nhân sâm", "thực phẩm chức năng",
  "thực phẩm bảo vệ sức khỏe", "quảng cáo", "xác nhận nội dung quảng
  cáo", "an toàn thực phẩm", "trà sữa", "giới trẻ") + cụm ASCII thuần
  (`XNQC`, `TPBVSK`, `K5`, `KGC`, `Trimico`...). Hàm thuần
  `load_sources(path) -> (cfg, errors)` fail-closed: file thiếu/JSON hỏng/
  `sources` rỗng/`id` trùng/`tier` ngoài A,B,C/`url` không http(s)/
  `kind` lạ/`status` lạ/`topics` rỗng hoặc chủ đề 0 cụm → errors nêu id +
  field (không in giá trị dài).
  - Boundary: `data/intel_sources.json` (mới), `crawler/intel.py` (mới),
    `tests/test_intel.py` (mới), `tests/fixtures/intel/` (mới)
  - Gate: `python -c` đọc file: mọi nguồn A/B `status == "cho_duyet"`,
    có ≥1 nguồn C, `llm.enabled is False`, `_doc` chứa "chờ"; test thuần:
    mỗi lỗi cấu hình ở trên → errors nêu đúng id/field, cfg None; file
    thật `data/intel_sources.json` → 0 errors
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.2 Fetcher an toàn (robots, nhịp, chặn, trần)** — trong
  `crawler/intel.py`: `BlockedDomain(Exception)`; `is_blocked(host,
  extra=()) -> bool` (luật ở đầu checklist); lớp/hàm fetcher tiêm được
  `sleep`/`clock`/`transport` cho test. User-Agent `samsam-intel/0.1
  (+mailto:<INTEL_CONTACT>)` — env `INTEL_CONTACT`, mặc định email công
  khai của công ty trong `data/llm_gateway.json` `pii_allow` (email domain
  công ty = external-dep); token robots `samsam-intel`. Timeout
  `httpx.Timeout(10.0)`. Trần: feed `MAX_BYTES` 2.000.000, robots
  500.000 — `Content-Length` vượt → đóng trước khi đọc body; stream vượt
  giữa chừng → hủy, status log `too_large`, không parse. robots.txt: tải
  1 lần/host/lượt qua CHÍNH fetcher (UA, nhịp, trần, chặn, ≤3 hop) rồi
  `RobotFileParser.parse()`; 2xx → luật file; 404/410 và 4xx khác (trừ
  401/403/429) → cho tất cả; 401/403 → cấm tất cả; 429/5xx/timeout/
  quá lớn/lỗi mạng → BỎ host cả lượt (fail-closed); `crawl_delay` của
  robots > 1 → dùng `min(crawl_delay, 60)`. Nhịp: giữa 2 lần BẮT ĐẦU
  request cùng host ≥ `CRAWL_DELAY_S` (1.0, tái dùng `crawler.sources`)
  — robots.txt và hop redirect cũng tính. Tuần tự, không song song.
  Content trả 429 → không retry, bỏ phần còn lại của host trong lượt.
  `--max-requests` = ngân sách TỔNG (robots + hop + feed), hết → dừng,
  `[warn]`. Mỗi request đã gửi in 1 dòng `[req] {json}` gồm `ts`,
  `source`, `host`, `url`, `status`, `robots_ok`, `bytes`, `ms`, `gap_s`
  (giây kể từ lần bắt đầu request trước cùng host, null nếu đầu tiên);
  bị chặn in `[blocked] {"source","host","reason": "hard"|"tier_c"|"scheme"}`;
  robots cấm in `[robots-deny] {"source","url"}` — 2 loại này KHÔNG có
  request.
  - Boundary: `crawler/intel.py`, `tests/test_intel.py`,
    `tests/fixtures/intel/`
  - Gate: test thuần `is_blocked`: `shopee.vn`, `m.shopee.vn`,
    `SHOPEE.VN`, `shopee.vn.`, `vt.tiktok.com`, `www.facebook.com`,
    `user@shopee.vn:443` (qua URL) → True; `shopee.vn.evil.com`,
    `notshopee.vn`, `vnexpress.net` → False; fetch URL bị chặn → raise
    `BlockedDomain` và spy transport (bọc `handle_request`) 0 lần gọi.
    Test `http.server` local (thread, port 0): (a) robots `Disallow:
    /private/` + 3 URL `/private/a`, `/private/b`, `/public/c` → server
    nhận đúng `/robots.txt` + `/public/c`; (b) robots 500 → 0 request
    nội dung tới host đó; robots 404 → cho phép; robots 403 → cấm hết;
    (c) feed trả 429 → không retry, URL thứ 2 cùng host 0 request; (d)
    redirect 302 sang host tầng C (host thứ 2 cấu hình tier C) và sang
    `https://shopee.vn/x` → spy transport KHÔNG có host bị chặn nào,
    handler host C đếm 0, log có `[blocked]`; redirect vòng/4 hop → dừng
    ở 3; (e) `Content-Length` 5MB → hủy trước body, status `too_large`;
    chunked không Content-Length vượt trần → hủy, không parse; (f) clock
    giả: 20 URL cùng host → mọi `gap_s` ≥ 1.0 và chuỗi sleep giả cộng
    đủ; robots `Crawl-delay: 3` → gap ≥ 3.0; (g) header `User-Agent`
    server nhận chứa `samsam-intel` và `mailto:`; (h) `--max-requests 3`
    → server nhận ≤ 3 request tổng (kể cả robots)
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.3 Parse feed + phân loại luật + trích ngắn** — `parse_feed(
  data: bytes) -> list[dict]` (RSS 2.0 `channel/item`: title, link,
  description, pubDate; Atom `entry`: title, `link[@rel=alternate or
  no rel]/@href`, `summary` (chỉ `content` khi không có summary));
  bytes có `<!DOCTYPE` → từ chối (chặn entity expansion), XML hỏng →
  `[warn]` bỏ nguồn, lượt chạy tiếp; tối đa 200 entry/feed. CHỈ đọc feed
  — KHÔNG bao giờ GET trang bài (`link` chỉ lưu). `published_at`:
  RFC 822 (`email.utils.parsedate_to_datetime`) hoặc ISO 8601; naive →
  gắn Asia/Ho_Chi_Minh; không parse được → null. Text: `strip_html`
  (tái dùng `crawler.collect`) → gom khoảng trắng → cắt `PRE_MAX` →
  `_mask_pii` → bỏ ký tự điều khiển → cắt ≤300 ký tự (title cũng ≤300).
  `classify(title, snippet, topics) -> (topics, flags)`: text NFC
  casefold; cụm có dấu khớp trên text có dấu với biên từ; cụm ASCII khớp
  trên bản `_strip_accents`; bản không dấu TỰ SINH của cụm có dấu CHỈ áp
  khi text hoàn toàn không dấu (cùng luật `is_health_question` — tránh
  "săm lốp"→"sam"); `flags`: `ruou` nếu `kb_filter.is_alcohol`,
  `suc_khoe` nếu `is_health_question`. `KbFilterError` → `[err]` exit 1
  (fail-closed, không lưu tin thiếu cờ). Tin 0 chủ đề → KHÔNG lưu (đếm
  `off_topic`).
  - Boundary: `crawler/intel.py`, `tests/test_intel.py`,
    `tests/fixtures/intel/`
  - Gate: fixture `rss_sample.xml` + `atom_sample.xml` parse đúng số
    entry/title/link/ngày; description 5.000 ký tự → snippet ≤ 300;
    description có "0905 123 456" + "a.b@gmail.com" → snippet không chứa
    2 chuỗi đó; giá "10.050.000.000" giữ nguyên; `<!DOCTYPE` + entity →
    0 entry, không treo; XML hỏng → [] + warn; server test: sau lượt chạy
    request tới path bài báo (`/bai/...`) = 0; classify: "Sâm Ngọc Linh
    giả bị thu giữ" → `sam`; "sam ngoc linh gia re" (không dấu) → `sam`;
    "Săm lốp xe máy tăng giá" → 0 chủ đề; "Cục ATTP xử phạt quảng cáo
    TPBVSK" → `quang_cao` + `tpbvsk`; tin "rượu sâm 40 độ" → flag `ruou`;
    tin nhắc "ung thư" → flag `suc_khoe`; keyword rượu rỗng (monkeypatch
    `kb_filter.KEYWORDS_FILE` + `reset_cache`) → exit 1
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.4 Bảng `intel_items` + lưu dedup idempotent** —
  `docs/schema.sql` append block "v7.0 intel collector (WP09)" (comment
  tiếng Việt: không toàn văn — bản quyền; không PII; tầng C không vào
  bảng; insert-only): `intel_items` (`id bigint identity pk`, `url text
  not null unique` (đã chuẩn hóa), `domain text not null`, `source text
  not null` (id nguồn), `tier text not null check (tier in ('A','B'))`,
  `title text not null check (char_length(title) <= 300)`, `snippet
  text check (char_length(snippet) <= 300)`, `summary text check
  (char_length(summary) <= 300)` (LLM, null mặc định), `published_at
  timestamptz`, `fetched_at timestamptz not null default now()`,
  `content_sha256 text not null unique`, `topics text[] not null check
  (cardinality(topics) > 0)`, `flags text[] not null default '{}'`).
  KHÔNG cột `body`/`content`/`html`/`raw_text`. `normalize_url(url)`:
  scheme/host lowercase, bỏ port mặc định, bỏ fragment, bỏ query `utm_*`/
  `fbclid`/`gclid`/`zarsrc`, sort query còn lại, bỏ `/` cuối path (trừ
  `/`). `content_sha256` = sha256 của title + "\n" + snippet SAU chuẩn hóa
  (NFC, casefold, gom khoảng trắng). `store_items(conn, items) -> dict`
  insert `on conflict do nothing` → đếm `new`/`dup` (dup tách
  `dup_url`/`dup_content` bằng tra trước trong cùng tx), 1 tx +
  `conn.commit()`.
  - Boundary: `docs/schema.sql` (chỉ append), `crawler/intel.py`,
    `tests/test_intel.py`
  - Gate: `python scripts/apply_schema.py` ×2 exit 0 trên samsam_infra;
    `grep -c "^create table if not exists" docs/schema.sql` = số cũ + 1
    (25 tại worktree này); block v7.0 không có
    `grep -niE "\b(body|content|html|raw_text)\b +text"`; test thuần
    `normalize_url`: `HTTPS://Bao.VN:443/a/?utm_source=x&b=2&a=1#c` ==
    `https://bao.vn/a?a=1&b=2`; test DB thật (rollback): chạy `store_items` 2 lần cùng lô →
    lần 2 `new=0`, `count(*)` không đổi; cùng bài khác `utm_` + `/` cuối →
    1 dòng; 2 URL khác nhau cùng title+snippet → 1 dòng (`dup_content=1`);
    insert tay snippet 301 ký tự → `CheckViolation`; insert tier `C` →
    `CheckViolation`
  - Evidence: `evidence/v70_intel.log`, `evidence/v70_pytest.log`
  - Kết quả: apply_schema ×2 exit 0 (25 bảng public); test DB thật (schema tạm + rollback) 0 skipped. Bổ sung dây chuyền: `deploy/cloud/README.md` thêm dòng `intel_items` + "25 bảng" (drift-guard `test_cloud_readme_drift_guard` đòi mọi bảng schema có trong README cloud).
- [x] **W70.5 CLI `python -m crawler.intel`** — `--run [--source ID ...]
  [--max-requests N] [--sources PATH] [--llm]` và `--report`. Thứ tự:
  argparse + `n_ops` (đúng 1 trong `--run`/`--report`, khác → `ap.error`
  exit 2) → `--max-requests` ngoài 1..200 → exit 2 → `load_sources`
  (lỗi → `[err]`, exit 1) → `--source` không tồn tại → exit 2; `--source`
  tier C → `[blocked]` exit 2 → connect DB (`connect_timeout=10`; lỗi/
  thiếu DSN → `[err]` exit 1, 0 request mạng; thiếu bảng → `[err]` gợi ý
  `apply_schema`, exit 1) → mới tới mạng. Mặc định `--max-requests` 60.
  `--run` không `--source`: chỉ nguồn `status == "duyet"` (hiện 0 →
  `[warn] 0 nguồn đã duyệt`, exit 0); `--source X` (lặp được) cho phép
  chạy THỬ nguồn `cho_duyet` kèm `[warn] nguồn chưa duyệt — chạy thử`.
  `--run` bọc `with job_run("crawler.intel")`. Cuối lượt in `[done]
  sources=.. ok=.. requests=.. new=.. dup_url=.. dup_content=..
  off_topic=.. blocked=.. robots_deny=..`. Exit 1 nếu ≥1 nguồn được thử
  mà 0 nguồn thành công (fetch+parse), còn lại exit 0. `--report`: tổng
  tin, theo tier/nguồn/chủ đề, số cờ `ruou`/`suc_khoe`, 10 tin mới nhất
  (ngày, nguồn, chủ đề, title, url — qua `_clean` bỏ ký tự điều khiển);
  0 dòng → "chưa có tin", exit 0. Docstring module tiếng Việt: contract,
  luật chặn/robots/nhịp, schema `intel_items`, quyền sở hữu (chỉ ghi
  `intel_items`; không ghi `content_drafts`, không đăng, không gửi).
  - Boundary: `crawler/intel.py`, `tests/test_intel.py`
  - Gate: test (monkeypatch connect + spy transport): `--run --report`,
    không op, `--max-requests 0`/`201`, `--source khong-co`, `--source
    <tier C>` → exit 2, connect KHÔNG gọi, transport 0; config hỏng →
    exit 1, connect không gọi; connect raise → exit 1, transport 0; E2E
    CLI trên samsam_infra với `--sources` trỏ file nguồn fixture (id
    tiền tố `fx-`) phục vụ bởi `python -m http.server` trên
    `tests/fixtures/intel/site/` (robots + feed + `/private/`): lần 1
    `new>0`, lần 2 `new=0` và `count(*) where source like 'fx-%'` không
    đổi; `--report` exit 0 (log vào evidence); `job_runs` có dòng
    `crawler.intel` ok
  - Evidence: `evidence/v70_intel.log`
- [x] **W70.6 LLM tóm tắt tùy chọn — mặc định TẮT** — chỉ khi `--llm` VÀ
  `cfg["llm"]["enabled"] is True`; thiếu 1 trong 2 → 0 lời gọi (có
  `--llm` mà config tắt → `[warn] LLM tắt — chờ Pháp chế xác nhận`).
  Gọi `llm_gateway.chat("intel", messages)` CHỈ cho tin MỚI (sau dedup),
  tối đa `LLM_MAX_ITEMS` 20/lượt, input = title + snippet ĐÃ che; output
  None/rỗng → không summary; `guardrail.check(summary)["ok"]` không
  True → summary null + flag `llm_guardrail_fail`; cắt ≤300;
  `GatewayBlocked`/`GatewayError` → `[warn]`, tắt LLM phần còn lại của
  lượt, tin vẫn lưu. `data/llm_gateway.json` `monthly_cap_usd` thêm
  `"intel": 1.0` (ước tính, công ty chốt).
  - Boundary: `crawler/intel.py`, `data/llm_gateway.json` (+1 khóa cap),
    `tests/test_intel.py`
  - Gate: test (monkeypatch `llm_gateway.chat` đếm): mặc định → 0 gọi;
    `--llm` + config tắt → 0 gọi + warn; config bật + `--llm` → gọi với
    `agent_id == "intel"`, payload không chứa SĐT/email của fixture;
    summary chứa "chữa" → summary null + flag `llm_guardrail_fail`;
    `chat` raise `GatewayBlocked` → tin vẫn lưu, 1 gọi duy nhất; tin
    trùng → 0 gọi; `grep -nE "^(import|from) +openai" crawler/intel.py`
    rỗng
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.7 Cách ly: intel không có đường sang `content_drafts`** —
  module intel chỉ ghi `intel_items` (+ `job_runs` qua `job_run`).
  - Boundary: `tests/test_intel.py`
  - Gate: `grep -nE "content_drafts|pipelines\.store|pipelines\.content|save_draft|connectors\." crawler/intel.py`
    rỗng; `grep -niE "(insert into|update|delete from) +[a-z_]+" crawler/intel.py`
    chỉ trúng `intel_items`; test AST: tập import của `crawler/intel.py`
    ∩ {`pipelines.store`, `pipelines.content`, `connectors.zalo`,
    `agents.report`} = ∅; test DB thật (rollback): `count(*)
    content_drafts` + `agent_action_log` trước/sau 1 lượt `--run` E2E
    bằng nhau
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.8 Docs + drift-guard** — `docs/handover/kien-truc.md` mục 2
  dòng `crawler/` thêm `intel`; mục 3 thêm dòng `intel_items` + câu "N
  bảng public" = số bảng `docs/schema.sql` (25 tại worktree này);
  `docs/handover/sop.md` mục "Thu tin thị trường (intel)": lệnh `--run
  --source`/`--report`, luật chặn tầng C/sàn, robots, ≥1s, không toàn
  văn, nguồn "chờ duyệt", đọc `[req]`/`[blocked]`; `AGENTS.md` Commands
  + Structure (`crawler/` nhắc `intel`); `tests/test_handover_docs.py`
  `SOP_COMMANDS` thêm `"crawler.intel"` (không xóa assert khác).
  - Boundary: `docs/handover/kien-truc.md`, `docs/handover/sop.md`,
    `AGENTS.md` (Commands + Structure), `tests/test_handover_docs.py`
  - Gate: `python -m pytest tests/test_handover_docs.py -q` xanh;
    `grep -n "crawler.intel" docs/handover/sop.md AGENTS.md` trúng cả 2;
    `grep -n "intel_items" docs/handover/kien-truc.md` có; đối chiếu số
    assert `test_handover_docs.py` trước/sau không giảm
  - Evidence: `evidence/v70_pytest.log`
- [x] **W70.9 Chạy thật nhỏ (≤20 request)** — 2–3 nguồn RSS tier A công
  khai trong `data/intel_sources.json` (worker kiểm robots bằng chính
  CLI, không mở trình duyệt/không đăng nhập): `python -m crawler.intel
  --run --source A --source B [--source C] --max-requests 10 | tee`
  evidence, rồi chạy lại y hệt (lần 2 `new=0` trừ khi feed có bài mới —
  ghi rõ). TỔNG 2 lần ≤ 20 dòng `[req]`. Tin thật để lại trong
  samsam_infra (tiêu đề công khai + link, không toàn văn).
  - Boundary: không sửa code; `evidence/v70_live.log`
  - Gate: `python -c` đọc `evidence/v70_live.log`: số dòng `[req]` ≤ 20;
    mọi host có request nội dung đều có request `/robots.txt` TRƯỚC đó;
    mọi `gap_s` không null ≥ 1.0; 0 host trúng `is_blocked`; `select
    max(char_length(snippet)), max(char_length(title)) from intel_items`
    ≤ 300
  - Evidence: `evidence/v70_live.log`
  - Kết quả: 3 nguồn (vnexpress-suc-khoe, vnexpress-phap-luat, tuoitre-suc-khoe), 2 lần × 5 `[req]` = 10 ≤ 20; robots trước nội dung, gap_s ≥ 1.0, 0 host bị chặn; lần 1 new=5, lần 2 new=0 dup_url=5; max(snippet,title) = (146, 96). Treo: 3 tin tuoitre có `published_at` null (định dạng pubDate chưa rõ — không request thêm để soi); bộ từ khóa còn nhiễu ("livestream" gán `quang_cao` cho tin hình sự) — cần eval phân loại (someday).
- [x] **Gate chung** — vòng 3 (sau 6 finding nghiệm thu): targeted ×3 = 166 passed ×3 (0 skipped); full `python -m pytest -q` = **942 passed, 0 failed** (trước chạy: 0 container `samsam-dr-*`); ruff sạch; py_compile OK. (Vòng 2: 923 passed + 1 fail `test_zz_no_dr_container_left` do container worktree khác — môi trường.) Evidence: `evidence/v70_pytest.log`
  - Vá nghiệm thu vòng 3: `_Llm` clean_text TRƯỚC guardrail, lưu đúng chuỗi đã kiểm (entity `&#99;hữa`); `urljoin` ValueError bắt ở `build_items` (bỏ entry) + `_get` (`[warn] redirect Location hỏng`, None); `parse_date` ngoài [năm 2000, now+2 ngày] → None + `report` bắt OverflowError → '?'; test gzip spy `max_length == cap+1`; test trần tổng `TOTAL_S` (StepClock, server nhỏ giọt). Mỗi vá có mutant tương ứng làm test fail.
  - Vá nghiệm thu vòng 4 (1 MINOR): `parse_date` bắt thêm `OverflowError` (trường số tràn C long/int: năm 2147483648, giờ/giây/ngày 20 chữ số, offset `+99999999999999999999` — `parsedate_to_datetime` raise OverflowError chứ không phải ValueError, lọt ra `build_items` → giết cả lượt run) ở CẢ 2 nhánh (rfc822 + `fromisoformat`) → None. Test: +5 case `test_parse_date_out_of_window_none`, `test_build_items_overflow_pubdate_does_not_kill_run` (entry độc giữ `published_at` None, entry hợp lệ sau vẫn giữ). Mutant bỏ OverflowError → 6 fail. Gate vòng 4: targeted ×3 = 18 passed ×3, `tests/test_intel.py` 117 passed, full = 947 passed + 1 fail `test_zz_no_dr_container_left` (container `samsam-dr-*` của worktree song song, 'Up 6 seconds' lúc probe — môi trường, không phải w70); ruff sạch.
  - `python scripts/apply_schema.py` ×2 exit 0 (bảng mới `intel_items`)
  - E2E fixture W70.5 (http.server local) ×2: lần 2 `new=0`; log có
    `[robots-deny]` cho `/private/`, 0 `[req]` tới host tầng C, mọi
    `gap_s` ≥ 1.0 (log vào `evidence/v70_intel.log`)
  - targeted ×3: `python -m pytest tests/test_intel.py tests/test_kb_filter.py tests/test_handover_docs.py tests/test_connect_timeout_guard.py -q -rs`
    3 lần liên tiếp xanh, test DB thật **0 skipped** (đọc output tới
    exit, không chạy chồng)
  - full: `python -m pytest -q` xanh MỘT lần, ≥ 831 + test mới
  - `ruff check .` sạch
  - `python -m py_compile crawler/intel.py crawler/collect.py crawler/sources.py`
  - W70.9 chạy thật ≤ 20 request có evidence
  - DỌN fixture khỏi samsam_infra: `delete from intel_items where source
    like 'fx-%'` → 0 dòng `fx-%`; tin thật W70.9 giữ
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file runtime mới trong `data/`; file lạ
    không thuộc version (vd `lv2-market-top.png`) → không stage
- [ ] **external-dep** BGĐ/Quản lý MXH duyệt danh sách nguồn + tầng (đổi
  `status` sang `"duyet"` là việc của người thật); Pháp chế xem điều khoản
  sử dụng RSS từng tòa soạn.
- [ ] **external-dep** Pháp chế xác nhận bằng văn bản cho gửi tin công
  khai qua LLM (`llm.enabled`); email liên hệ trên domain công ty cho
  User-Agent (`INTEL_CONTACT`).
- [ ] **external-dep** Nguồn trả phí/API báo chí; social listening nhà
  cung cấp (P2); dữ liệu Shopee/TikTok đối thủ chỉ nhập tay (tầng C, form
  Competitor Tracker — version khác).

Someday (ngoài phạm vi v7.0, ghi để không cuốn vào): ETag/If-None-Match +
304; news-sitemap.xml; bảng `intel_sources`/`intel_fetch_log`/
`host_fetch_state` (nhịp chung đa tiến trình, advisory lock, timer
systemd full/light); hạn lưu 30/90 ngày + purge; NER che họ tên (lớp 2
PII); simhash/cosine gom cụm; eval phân loại ≥200 tin + 6 nhãn rủi ro;
SSRF redirect sang IP nội bộ/link-local; Summarizer & Bulletin, Red Alert.

## Checklist v9.5-co-khi

Khán giả/mục đích: nhánh M31+ (worktree `D:\code\samsam-w95`) — WP14
"Trung tâm điện–cơ khí (P1)" (`ctx/pmo.md` dòng `| WP14`), agent CK-A1..A4
trong `ctx/final_plans.json` → `mechanical`. Người thật duy nhất của phòng:
**Kỹ sư trưởng** (chưa có tài khoản/role trong `pipelines/auth.py` — mọi chỗ
cần người duyệt dùng cờ `--approved-by "<tên người thật>"` như
`ingest.kb_internal`; agent/test KHÔNG tự điền tên Kỹ sư trưởng). Hiện repo
có 0 dòng code về thiết bị/bảo trì/đóng gói. Sau version: (1) tài liệu kỹ
thuật MẬT tra cứu được HOÀN TOÀN local — 0 kết nối mạng, gateway từ chối
agent mật, thiếu dữ liệu → NO_DATA; (2) tài liệu kỹ thuật THƯỜNG nạp vào
`chunks_internal` collection `internal:co_khi` qua `ingest.kb_internal`
(tái dùng v3.9, không đường mới) và tài liệu gắn `confidential: true` bị
CLI đó từ chối trước khi embed; (3) CMMS nhẹ 3 bảng + CLI + nhắc đến hạn
(`now` là tham số); (4) tính năng lực đóng gói hộp quà Tết từ config GIẢ
ĐỊNH; (5) checklist điện/mạng điểm quay live markdown tất định; (6) bộ eval
MẪU 20 + 3 bẫy chạy qua `scripts/agent_eval.py`. Mốc WP14 thật (sổ máy
15/11, downtime 01/12, checklist 05/11, nghiệm thu 23/12) phụ thuộc dữ liệu
công ty → external-dep, version này chỉ dựng máy chạy local.

Quy ước: ponytail — stdlib + `pypdf`/`psycopg` sẵn có; KHÔNG dep mới, KHÔNG
pip install vào Python global. OCR local: máy có `rapidocr-onnxruntime`
1.4.4 (model `ch_PP-OCRv4` ĐÓNG GÓI SẴN trong wheel, không tải mạng; nhận
dạng tiếng Việt có dấu CHƯA XÁC MINH — model Trung/Anh) → import LƯỜI trong
hàm OCR, thiếu → trang scan ở trạng thái `cho_ocr` (không index, có đếm) +
ghi external-dep; KHÔNG thêm vào `requirements.txt` (kéo onnxruntime+
opencv — nặng, optional). `paddleocr` 2.10 có trên máy nhưng tải model qua
mạng lần chạy đầu → CẤM dùng trong luồng mật; tesseract/pytesseract KHÔNG
có. Không có `pipelines/scenario.py` trong worktree này (v7.3 làm song song)
→ CK-A3 chỉ đặt hàm thuần làm điểm nối, KHÔNG import scenario. Module mật
`agents/ck_mat.py` KHÔNG import (trực tiếp hay bắc cầu) `pipelines.
llm_gateway`, `ingest.embed_store`, `api.rag`, `openai`, `httpx`,
`requests`, `urllib3`, `urllib.request`, `google.cloud` (đã đo: `import
ingest.doc_intake` sạch các module này — chỉ kéo `pipelines.pii`/
`job_runs`/`psycopg`, không mở kết nối). Text hiển thị: template tất định,
không LLM → không qua `guardrail.check()` (invariant chỉ áp text AI sinh);
mọi print tiếng Việt có UTF-8 guard; mọi `psycopg.connect` có
`connect_timeout` (`tests/test_connect_timeout_guard.py` quét AST toàn repo);
ghi DB `conn.commit()` tường minh (gotcha v2.1); CLI nhiều op → `ap.error`
exit 2 TRƯỚC connect (gotcha v2.2); ngày từ CLI (str) coerce
`date.fromisoformat` trước khi format (gotcha v2.2); "hôm nay" mặc định theo
UTC+7 bằng `timezone(timedelta(hours=7))` (không `zoneinfo` — Windows thiếu
tzdata). Tài liệu/config mẫu tự tạo ghi rõ **MẪU**/**GIẢ ĐỊNH** trong `_doc`
hoặc dòng đầu. Lệnh gate dưới đây chạy với tiền tố `cd D:/code/samsam-w95
&& set -a && . <scratchpad>/w95.env && set +a &&` (DB riêng `samsam_infra`).
Thêm bảng: KHÔNG assert đếm cứng — sửa `docs/handover/kien-truc.md` (tên
bảng + câu "N bảng public"; drift-guard `test_kien_truc_lists_all_tables`
đọc schema.sql).

- [x] **W95.1 Gateway từ chối agent mật `ck_mat`** — `pipelines/
  llm_gateway.py`: hằng `LOCAL_ONLY_AGENTS = frozenset({"ck_mat"})`; trong
  `_gate()` kiểm NGAY sau validate `_AGENT_RE`, TRƯỚC `_config()` /
  `_month_spend()` → `raise GatewayBlocked("agent 'ck_mat' là luồng MẬT —
  chỉ chạy local, cấm LLM/mạng")`. Không config/env nào gỡ được (không đi
  qua `kill`, `LLM_PROVIDER_ONLY` rỗng hay cap). Cập nhật docstring Contract.
  - Boundary: `pipelines/llm_gateway.py`, `tests/test_llm_gateway.py`
  - Gate: test mới `chat("ck_mat", ...)` và `embed("ck_mat", ...)` đều raise
    `GatewayBlocked`, `_client` (monkeypatch đếm) gọi 0 lần, `_connect`/
    `_month_spend` gọi 0 lần, `_record` 0 lần; config hỏng
    (`CONFIG` trỏ file JSON lỗi) vẫn ra `GatewayBlocked` chứ không
    `GatewayError` cấu hình (chứng minh kiểm trước `_config()`); agent khác
    (`chatbot`) không đổi hành vi — `python -m pytest -q
    tests/test_llm_gateway.py` xanh
  - Evidence: `evidence/v95_pytest.log`
- [x] **W95.2 CK-A1 luồng MẬT chạy local (`agents/ck_mat.py`)** —
  - Thư mục nguồn `CK_MAT_DIR` (env, mặc định `data/co_khi_mat/` →
    THÊM vào `.gitignore` ngay; ghi biến vào `env.example` kèm comment, không
    ghi `.env*`). Đuôi nhận `.pdf` (text từng trang), `.md`/`.txt` (trang tách
    bằng dòng `--- trang N ---`; không có dấu → cả file là trang 1),
    `.jpg/.jpeg/.png` (OCR, trang 1). 0 byte / đuôi lạ / symlink / file >
    `MAX_BYTES` (20 MB) → bỏ qua có đếm. Mọi file trong thư mục này mặc
    định là `confidential=true`.
  - Tái dùng `ingest/doc_intake.py`: tách hàm `pdf_page_texts(path) ->
    list[str]` (NFC, PDF mã hoá/hỏng → `DocError`) ra khỏi `extract_text`,
    `extract_text` gọi lại nó — hành vi v3.8 KHÔNG đổi (test_doc_intake
    xanh nguyên); dùng lại `SCAN_MIN_CHARS`, `_nonspace_len`, `DocError`.
    Trang PDF < `SCAN_MIN_CHARS` → OCR ảnh nhúng trong trang (`page.images`,
    pypdf) bằng OCR local nếu có; không có engine → `cho_ocr` (không index).
  - OCR local: hàm `_ocr_local(image_bytes) -> str` import lười
    `rapidocr_onnxruntime`; `ImportError` → trả `None` (trang `cho_ocr`), in
    1 dòng `[ck-mat] chưa có engine OCR local — trang scan chờ (external-dep)`.
    TUYỆT ĐỐI không fallback provider mạng/`doc_intake.PROVIDERS` nước ngoài.
  - Index trong bộ nhớ dựng mỗi lần chạy (≈300 trang — không persist, không
    DB, không embed): chunk theo trang (cắt đoạn ≤ 800 ký tự giữ `file`,
    `page`); tokenize = NFC casefold + bỏ dấu (hàm `_fold` CHÉP trong module,
    không import `llm_gateway._strip_accents`) + tách `\w+`; BM25 thuần Python
    (k1=1.5, b=0.75).
  - `ask(question, root=None, k=3) -> {"answer", "sources": [{"file",
    "page"}], "high_risk": bool}`. `NO_DATA` = hằng chép đúng chuỗi của
    `api.rag.NO_DATA` (test drift-guard so khớp, module không import rag).
    NO_DATA khi: thư mục thiếu; thư mục rỗng; chỉ có file bị bỏ qua / trang
    `cho_ocr`; câu rỗng/chỉ dấu câu/chỉ stopword; trang tốt nhất phủ < 60%
    term nội dung của câu; câu có mã máy `SS-EQ-\d+` mà không FILE nào
    chứa đúng mã đó (ở trang bất kỳ hoặc trong tên file — lọc theo file,
    mã tính 1 lần lúc index; mã không tính vào điểm BM25/độ phủ). Câu > 500 ký tự cắt trước tokenize. Trả lời = trích đoạn
    nguyên văn (qua `pipelines.pii._mask_pii`) + `file` (tên tương đối) +
    `page` — KHÔNG tổng hợp, không LLM.
  - Chủ đề rủi ro cao (câu HOẶC trang trúng: "đấu nối", "đấu dây", "tủ
    điện", "3 pha", "ba pha", "áp lực", "nồi hơi", "loto", "cao áp" — so sau
    `_fold`, word-boundary): `high_risk=True`, `answer` CHỈ là tham chiếu
    "Xem <file> trang <n> — kiểm tra với Kỹ sư trưởng", không trích đoạn,
    không danh sách bước.
  - CLI `python -m agents.ck_mat --ask "<câu>" [--dir PATH]` · `--stats`
    (đếm file/trang/indexed/cho_ocr/skipped, KHÔNG in nội dung). Exit 0;
    tham số sai 2. UTF-8 guard.
  - Boundary: `agents/ck_mat.py`, `ingest/doc_intake.py` (chỉ tách
    `pdf_page_texts`), `.gitignore`, `env.example`, `tests/test_ck_mat.py`
  - Gate: (a) EGRESS — fixture chặn `socket.socket.connect`, `connect_ex`,
    `socket.create_connection`, `socket.getaddrinfo` (ghi lại + raise):
    dựng index từ tmp dir gồm PDF text 2 trang (helper `make_pdf_pages` như
    `tests/test_doc_intake.py`), `.md` nhiều trang, ảnh `.png` với
    `_ocr_local` monkeypatch trả text → `ask()` trúng / NO_DATA / high-risk
    đều chạy, danh sách kết nối == `[]`; (b) subprocess `python -c "import
    agents.ck_mat, sys; ..."` in danh sách module cấm đã nạp == `[]` (list
    ở Quy ước); (c) `grep -nE "^\s*(import|from)\s+(openai|httpx|requests|
    urllib|google|pipelines\.llm_gateway|ingest\.embed_store|api\.rag)"
    agents/ck_mat.py` → 0 dòng; (d) NO_DATA đủ 6 biến thể biên ở trên (mỗi
    biến thể 1 assert, `sources == []`, answer không chứa chữ số); (e) trúng:
    câu về trang 2 file A trả đúng `file`+`page`; (f) high-risk: answer
    không có trích đoạn trang, không có dòng bắt đầu bằng số thứ tự; (g)
    `_ocr_local` khi `rapidocr_onnxruntime` không import được (monkeypatch
    `sys.modules[...] = None`) → trang `cho_ocr`, không exception; (h) OCR
    thật: `pytest.importorskip("rapidocr_onnxruntime")` + ảnh ASCII
    "SS-EQ-03" vẽ bằng `cv2.putText` (opencv đi kèm rapidocr; skip nếu thiếu)
    OCR ra chứa "SS-EQ-03" dưới fixture chặn socket; (i) `python -m pytest -q
    tests/test_doc_intake.py tests/test_ck_mat.py` xanh; (j) `git
    check-ignore data/co_khi_mat/x.pdf` → khớp
  - Evidence: `evidence/v95_pytest.log`, `evidence/v95_egress.log` (output
    test egress + subprocess module list + `--stats` trên `data/co_khi/mau/`)
  - Kết quả: egress 0 kết nối (index PDF+md+ảnh, OCR rapidocr THẬT dưới chặn socket), subprocess 0 module cấm, grep 0 dòng; NO_DATA 6 biến thể. Rà OWASP thêm: `_chunks` cắt theo chỉ số (bản đầu quadratic — đo 20 MB một dòng ~97 s, nay 0.1 s), dấu `--- trang N ---` lặp gộp 1 trang, mở lại PDF lấy ảnh lỗi → `cho_ocr` thay vì crash. Stopword bỏ dấu KHÔNG chứa từ trùng chuyên môn (máy/bảo/co/độ/tủ/dầu/vệ/cân/hơi/bản/chứa).
- [x] **W95.3 CK-A1 luồng THƯỜNG qua `chunks_internal` + chặn tài liệu mật**
  — tài liệu MẪU `data/co_khi/mau/` (dòng đầu "MẪU — tài liệu giả định do
  dev soạn, không phải manual thật"): `may-co-mang-ss-eq-03.md` (thường, ≥3
  trang, chu kỳ bảo trì/nhiệt độ/thao tác vận hành giả định),
  `may-dan-nhan-ss-eq-05.md` (thường), `ban-ve-tu-dien-xuong-mau.md` (dòng
  front-matter `confidential: true`, có nội dung "tủ điện", "3 pha"),
  `so-tay-dong-goi-hop-qua-mau.md` (thường). `ingest/kb_internal.py`
  `parse_args`: TRƯỚC connect/embed, `ap.error` (exit 2) khi (a) 20 dòng đầu
  file có khóa `confidential` + `:`/`=` mà giá trị KHÔNG tường minh là
  false/no/0/off/không (FAIL-CLOSED — chịu ngoặc kép, `#comment`, tiền tố
  `- `/`**`, `"confidential":`, `confidential=true`; casefold), hoặc
  (b) `--file` resolve nằm trong `CK_MAT_DIR` (resolve cả 2 phía). Nạp
  thường: `python -m ingest.kb_internal --file data/co_khi/mau/may-co-mang-
  ss-eq-03.md --collection internal:co_khi --approved-by "<Kỹ sư trưởng>"`
  (collection khớp `COLLECTION_RE` sẵn có — không sửa regex/bảng). Tra cứu
  luồng thường dùng `api.rag.retrieve(q, collection="internal:co_khi")` sẵn
  có (v3.9) — KHÔNG thêm đường đọc mới, `answer()` khách không đổi.
  - Boundary: `ingest/kb_internal.py` (thêm check trong `parse_args`),
    `data/co_khi/mau/*.md`, `tests/test_kb_internal.py`
  - Gate: test: file có `confidential: true` → `SystemExit(2)`, `connect`
    và `embed_all` (monkeypatch đếm) gọi 0 lần; biến thể `Confidential:
    TRUE`, có khoảng trắng đầu dòng → vẫn chặn; `confidential: false` → qua;
    file nằm trong tmp `CK_MAT_DIR` (monkeypatch env) không front-matter →
    exit 2; file thường MẪU → `ingest_doc` với fake conn + `embed_all`
    monkeypatch nạp `collection == "internal:co_khi"`, `approved_by` = giá trị
    truyền vào; test cũ `tests/test_kb_internal.py` xanh nguyên (đối chiếu
    số assert trước/sau — gotcha v1.7) — `python -m pytest -q
    tests/test_kb_internal.py tests/test_kb_acl.py` xanh
  - Evidence: `evidence/v95_pytest.log`
  - Kết quả: chặn cả dòng có BOM đầu file; `..` trỏ vào CK_MAT_DIR vẫn chặn; 21 assert cũ giữ nguyên (chỉ append test). Còn hở (ghi nhận): file mật bị COPY ra ngoài CK_MAT_DIR và gỡ front-matter thì không nhận ra được — quy trình người.
- [x] **W95.4 CK-A2 CMMS nhẹ — schema + `agents/cmms.py`** — `docs/
  schema.sql` THÊM (chỉ `create ... if not exists`, không đổi bảng cũ):
  - `machines` (`code` text PK check `^SS-EQ-[0-9]{2,4}$`, `name` not null,
    `location`, `maker`, `year` int check 1950–2100, `thuoc_dien_kiem_dinh`
    bool default false, `han_kiem_dinh` date, `la_phuong_tien_do` bool
    default false, `han_hieu_chuan` date, `ho_so_gmp` bool default false,
    `active` bool default true, `source` text default 'manual',
    `created_at` timestamptz default now());
  - `maintenance_plans` (`id` identity PK, `machine_code` FK→machines,
    `task` not null, `interval_days` int check 1–3660, `major` bool default
    false, `start_on` date not null default current_date, `last_done_on`
    date, `last_done_by` text, `last_approved_by` text, `active` bool
    default true);
  - `incidents` (`id` identity PK, `machine_code` FK, `started_at`
    timestamptz not null, `ended_at` timestamptz check `ended_at is null or
    ended_at >= started_at`, `downtime_phut` int check `>= 0`, `part` text,
    `description` text (ĐÃ `_mask_pii`), `root_cause` text not null default
    'chờ xác nhận', `reported_by` text check `^[A-Za-z0-9_-]{1,32}$` (MÃ
    nhân sự, không tên/SĐT), `created_at`);
  - view `downtime_log` (`create or replace view`: incidents đã đóng —
    `machine_code, started_at, ended_at, downtime_phut, part, root_cause`)
    cho CK-A5 sau này.
  `agents/cmms.py`: hàm thuần `due_items(plans, machines, today, horizon_days
  =7, cert_days=30) -> list[dict]` (`next_due = coalesce(last_done_on,
  start_on) + interval_days`; `overdue` khi `next_due < today`, `due` khi
  `<= today + horizon`; `han_kiem_dinh`/`han_hieu_chuan` nhắc khi `han - today
  <= cert_days` kể cả đã quá hạn; chỉ máy/plan `active`), `incomplete
  (machines)` (thiếu `maker`/`year`/`location`, hoặc cờ kiểm định/phương tiện
  đo bật mà thiếu hạn), `downtime_minutes(start, end)`. CLI `python -m
  agents.cmms`: `--add-machine --code --name [--location --maker --year
  --kiem-dinh --kiem-dinh-han --phuong-tien-do --hieu-chuan-han --gmp]`
  (cờ kiểm định/phương tiện đo = cờ tường minh HOẶC có hạn) · `--add-plan --code --task
  --every-days N [--major]` · `--done <plan_id> --on YYYY-MM-DD --by <mã_nv>
  [--approved-by "<Kỹ sư trưởng>"]` (plan `major` HOẶC máy `ho_so_gmp` mà
  thiếu `--approved-by` → exit 2, KHÔNG ghi; `--on` tương lai so với hôm nay
  → exit 2) · `--incident --code --start ISO --end ISO --by <mã_nv> [--part
  --desc]` (naive → +07:00; end<start → exit 2; thiếu end = sự cố đang mở,
  `downtime_phut` NULL) · `--due [--now YYYY-MM-DD] [--horizon N]`
  (`--now` CHỈ với `--due`; op ghi kèm `--now` → exit 2) ·
  `--incomplete` · `--retire <code>` (`active=false`). KHÔNG có op xóa máy
  (không `delete from machines` trong module). >1 op → `ap.error` trước
  connect. Print chỉ mã máy/plan id/số đếm/ngày — không in `description`.
  - Boundary: `docs/schema.sql`, `agents/cmms.py`, `tests/test_cmms.py`,
    `docs/handover/kien-truc.md` (3 bảng mới + view + câu "N bảng public"
    24 → 27 trên nền hiện tại)
  - Gate: unit (không DB): plan hạn hôm qua → `overdue`; hạn hôm nay+7 →
    `due`, +8 → không; `han_kiem_dinh` = today+25 và cân `han_hieu_chuan` =
    today+10 → cả 2 nhắc; +30 nhắc, +31 không, -1 (quá hạn) nhắc; plan
    `last_done_on` NULL tính từ `start_on`; máy `active=false` không nhắc;
    `--now 2026-12-20` (str) chạy được, `--now 2026-13-01` exit 2;
    sự cố 09:00→10:15 → 75 phút; 12 máy 1 thiếu `maker` → `incomplete` đúng
    1; `--done` plan major thiếu `--approved-by` exit 2 và fake conn 0
    execute ghi; `--due --incomplete` cùng lúc exit 2 trước connect; DB
    (fixture skip khi không có DB, mã `SS-EQ-99xx`, cleanup incidents→
    plans→machines): `python scripts/apply_schema.py` chạy 2 lần không lỗi;
    add-machine/add-plan/incident/due vòng đầy đủ đọc lại đúng từ DB, view
    `downtime_log` trả 75; insert `reported_by` có dấu cách bị check
    constraint chặn; `grep -n "delete from machines" agents/cmms.py` → 0;
    `python -m pytest -q tests/test_cmms.py tests/test_handover_docs.py`
    xanh
  - Evidence: `evidence/v95_pytest.log`, `evidence/v95_cmms.log` (CLI chạy
    thật trên DB `samsam_infra` với máy MẪU `SS-EQ-9901` rồi `--retire`)
  - Kết quả: evidence chạy trên DB riêng worktree (`w95.env` trỏ `samsam_w95`, không phải `samsam_infra` như ghi ở trên); máy MẪU SS-EQ-9901/9902 + plan #1 + 2 sự cố MẪU còn lại trong DB đó ở trạng thái `active=false` (không có op xóa — đúng thiết kế). `--part` cũng qua `_mask_pii`. Ngoài boundary (buộc phải sửa để full pytest xanh): `deploy/cloud/README.md` (3 dòng bảng mới + bỏ số đếm cứng '24 bảng') và `docs/handover/runbook-ha-tang.md` (agent_id `ck_mat`, drift-guard `test_runbook_lists_real_agent_ids`).
- [x] **W95.5 CK-A3 năng lực đóng gói hộp quà Tết** — config `data/co_khi/
  nang_luc.json` (`_doc`: "GIẢ ĐỊNH — số liệu dev đặt, chờ Kỹ sư trưởng đo
  thực và ký"; `gia_cong` false; `stations` vd `dan_nhan` 200 hộp/ca × 1
  máy, `co_mang`, `dong_hop_tay` 80 hộp/người/ca × N người — mỗi station có
  `label` `"gia_dinh"`|`"do_thuc"`; `skus` hộp quà MẪU → danh sách station).
  `agents/co_khi.py`: hàm thuần `capacity_for(cfg, sku, boxes) -> dict`
  (`shifts_needed` mỗi station = `ceil(boxes / (rate × units))`, `bottleneck`
  = station nhiều ca nhất, mỗi số kèm `label`, `status` = "chờ Kỹ sư trưởng
  ký") — ĐÂY là điểm nối cho `pipelines.scenario` (v7.3): scenario gọi
  `capacity_for`, module này không import scenario (ghi trong docstring).
  `boxes` ≤0/không phải int, sku lạ, rate ≤0 → `ValueError`; `gia_cong`
  true → `ValueError` "đóng gói gia công ngoài — CK-A3 không chạy".
  CLI `python -m agents.co_khi nang-luc --sku <SKU> --boxes 500,1500,3000
  [--config PATH]` → markdown 3 kịch bản; lỗi → exit 1 kèm lý do.
  - Boundary: `agents/co_khi.py`, `data/co_khi/nang_luc.json`,
    `tests/test_co_khi.py`
  - Gate: 500/1500/3000 hộp với dán nhãn 200/ca → 3/8/15 ca dán nhãn; đóng
    tay 80/người/ca × 4 người → 2/5/10 ca; bottleneck đúng station; mọi
    số trong markdown có nhãn "giả định"/"đo thực"; output không chứa "cam
    kết", "đảm bảo giao", "ngày giao" (casefold); `gia_cong=true` → không
    tính, exit 1, có lý do; boxes `0`, `-5`, `"abc"` → lỗi; chạy 2 lần cùng
    input → byte-identical — `python -m pytest -q tests/test_co_khi.py`
    xanh
  - Evidence: `evidence/v95_pytest.log`
- [x] **W95.6 CK-A4 checklist điện/mạng điểm quay live** — config
  `data/co_khi/live.json` (`_doc`: "ĐỀ XUẤT — ngưỡng chưa đối chiếu yêu cầu
  TikTok/Shopee/FB Live; Kỹ sư trưởng + Quản lý MXH chốt"; `upload_mbps_min`
  6, `loss_pct_max` 1, `sustain_min` 5; `sites` `da_nang`, `tra_linh` (tên
  ghi GIẢ ĐỊNH); `items.do_duoc` (UPS, upload, mất gói, router 4G/5G dự
  phòng — Quản lý MXH ký) và `items.dien` (tổng tải, aptomat, tiếp địa, dây
  nối/ổ cắm — Kỹ sư trưởng duyệt qua ảnh)). `agents/co_khi.py`
  `render_live_checklist(cfg, site, day, upload=None, loss=None) -> str`
  markdown TẤT ĐỊNH (không `now()`, `day` bắt buộc). Phần mạng: đủ 2 số đo →
  ĐẠT (`upload >= min` và `loss <= max`) / KHÔNG ĐẠT (+ dòng "bật router dự
  phòng và đo lại"); thiếu số → CHƯA ĐO. Phần điện luôn "CHỜ KỸ SƯ TRƯỞNG
  DUYỆT ẢNH"; tổng trạng thái tool KHÔNG BAO GIỜ in "SẴN SÀNG" (chỉ người
  thật ký trên checklist). CLI `python -m agents.co_khi checklist-live
  --site da_nang --day 2026-11-05 [--upload 6.5 --loss 0.5] [--config PATH]
  [--out FILE]`; site lạ / day sai / số âm → exit 2.
  - Boundary: `agents/co_khi.py`, `data/co_khi/live.json`,
    `tests/test_co_khi.py`
  - Gate: 1.5 Mbps → KHÔNG ĐẠT + dòng router dự phòng; 6.5/0.5 → ĐẠT phần
    mạng; cfg `upload_mbps_min=8` → 6.5 KHÔNG ĐẠT (ngưỡng đọc từ config);
    biên đúng 6.0/1.0 → ĐẠT; thiếu `--loss` → CHƯA ĐO; output không chứa
    "SẴN SÀNG" đứng riêng (word-boundary — "CHƯA SẴN SÀNG" được phép);
    đủ cả mục `do_duoc` lẫn `dien` của config; 2 lần render → byte-identical
    — `python -m pytest -q tests/test_co_khi.py` xanh
  - Evidence: `evidence/v95_pytest.log`, `evidence/v95_checklist_da_nang.md`
  - Evidence `v95_checklist_da_nang.md` sinh KHÔNG có số đo (CHƯA ĐO) — chưa có buổi đo thật, không điền số giả.
- [x] **W95.7 Bộ eval MẪU 20 + 3 bẫy qua `agent_eval`** — `data/eval/
  co_khi.jsonl`: dòng `_doc` "Bộ ca MẪU do dev soạn trên tài liệu MẪU
  `data/co_khi/mau/` — CHỜ KỸ SƯ TRƯỞNG SỬA (≥5 câu tự viết từ trang viết
  tay/bản vẽ), không phải nghiệm thu WP14"; 17 ca `fact` (`expect_file`,
  `expect_page`), 3 ca `high_risk` (đấu dây 3 pha, tủ điện…: kỳ vọng
  `high_risk` true + đúng file/trang + không trích đoạn), 3 ca
  `trap_no_data` (máy/mã không có trong tài liệu, vd `SS-EQ-99` — kỳ vọng
  NO_DATA, `sources` rỗng, không chữ số). Mỗi ca có `source: "MẪU"`.
  `scripts/agent_eval.py`: runner `run_co_khi` gọi `agents.ck_mat.ask(text,
  root=ROOT/"data/co_khi/mau")` (luồng mật engine — không key, không LLM,
  không mạng); thêm vào `RUNNERS`; `model = "rules"` cho `co_khi` như
  guardrail. `data/eval/config.json`: agent `co_khi` (`cases`,
  `min_pass_rate` 0.9 ⇔ ≥21/23 ⇔ ≥18/20 khi 3 bẫy pass,
  `must_pass_kinds: ["trap_no_data"]`, `prompt_files`: `agents/ck_mat.py`,
  `data/eval/co_khi.jsonl`, 4 file `data/co_khi/mau/*.md`) — KHÔNG thêm vào
  `required_agents` (test hiện khóa `["guardrail","chatbot"]`; bộ MẪU chưa
  duyệt không được chặn deploy). Cập nhật docstring harness.
  - Boundary: `data/eval/co_khi.jsonl`, `data/eval/config.json`,
    `scripts/agent_eval.py`, `tests/test_agent_eval.py`
  - Gate: `python scripts/agent_eval.py --agent co_khi --no-record` exit 0,
    in `PASS n/23`, chạy 2 lần output giống hệt (tất định); test: đúng 23
    ca, 3 `trap_no_data`, id duy nhất; mỗi ca `fact`/`high_risk` có
    `expect_file` tồn tại trong `data/co_khi/mau/`; bẫy fail → `score`
    `passed False` (ca giả lập); `test_config_thresholds_and_trap_kinds` xanh
    (traps == must_pass_kinds, prompt_files tồn tại) — `python -m pytest -q
    tests/test_agent_eval.py` xanh
  - Evidence: `evidence/v95_eval.log` (2 lần chạy `--no-record`)
  - Kết quả: PASS 21/23 (0.913, sát ngưỡng 0.9) — 3 bẫy + 3 high_risk pass; 2 fact FAIL thật (ck-f01 nhiệt độ buồng co, ck-f02 tốc độ băng tải: BM25 chọn trang 4 'xử lý sự cố' vì trang đó cũng nhắc 'nhiệt độ buồng co'/'tốc độ băng tải'). KHÔNG chỉnh tài liệu/câu cho vừa — để Kỹ sư trưởng sửa bộ ca; cải thiện xếp hạng = someday.
- [x] **W95.8 Gate chung** — targeted ×3 tuần tự: `python -m pytest -q
  tests/test_llm_gateway.py tests/test_ck_mat.py tests/test_doc_intake.py
  tests/test_kb_internal.py tests/test_kb_acl.py tests/test_cmms.py
  tests/test_co_khi.py tests/test_agent_eval.py tests/test_handover_docs.py
  tests/test_connect_timeout_guard.py` (lần 2–3 chỉ chạy khi lần trước đã
  exit — gate nặng có thể bị đẩy nền, đọc output tới khi process exit,
  không chạy chồng); full `python -m pytest -q` đúng 1 lần (baseline 831 →
  ≥831 + test mới, 0 fail); `ruff check .` clean; `python -m py_compile
  agents/ck_mat.py agents/cmms.py agents/co_khi.py ingest/doc_intake.py
  ingest/kb_internal.py pipelines/llm_gateway.py scripts/agent_eval.py`;
  `git status --short` chỉ chứa file trong Boundary các mục trên (không file
  lạc, `lv2-market-top.png` không stage); `git check-ignore
  data/co_khi_mat/` khớp.
  - Boundary: (không file mới)
  - Gate: như trên, mọi lệnh exit 0
  - Evidence: `evidence/v95_pytest.log` (`git add -f` — `*.log` bị ignore)
  - Kết quả: targeted ×3 = 274 passed ×3 (2 lượt ×3: trước và sau đổi BOM literal → escape); full vòng 1 = 2 FAIL drift-guard (runbook thiếu `ck_mat`, cloud README thiếu 3 bảng) → vá .md → full vòng 2 = 932 passed (baseline 831); ruff sạch; py_compile exit 0; check-ignore khớp. Full KHÔNG chạy lại sau đổi BOM (đổi literal→escape cùng nghĩa; targeted ×3 + ruff đã chạy lại).

- [x] **W95.F1 Sửa phát hiện nghiệm thu (cold-check v9.5, 1 MAJOR + 8 MINOR)**
  - MAJOR A04 DoS `ck_mat.ask`: mã máy từng trang tính MỘT lần trong
    `build_index` (`idx["file_codes"]`), `ask` lọc theo tập file — không
    `EQ_RE.findall` lại trang cho mỗi chunk. Test
    `test_machine_code_question_no_per_chunk_page_rescan` (trang đơn ≥1 MB,
    >1000 chunk, đếm findall == 1/câu — không wall-clock). Mutation trả lại
    lọc theo trang-mỗi-chunk: test đỏ (chạy 90 s — chính là lỗi quadratic).
  - MINOR lọc mã theo TRANG → theo FILE (trang bất kỳ + tên file); mã không
    vào điểm BM25/độ phủ. Test `test_machine_code_only_on_first_page_found`
    (mã chỉ ở trang 1 / chỉ ở tên file; mã lạ / mã file khác → NO_DATA).
    Tài liệu MẪU `may-co-mang-ss-eq-03.md` bỏ mã khỏi trang 2–4 (eval vẫn
    21/23 — 2 ca fail ck-f01/f02 là xếp hạng BM25 chọn trang 4, có từ
    trước sửa, không liên quan lọc mã).
  - MINOR ×2 confidential fail-open → `kb_internal.is_confidential_line`
    fail-closed; test thêm 10 biến thể chặn + 8 biến thể qua (false/no/0/
    không/`Confidentiality:`/văn xuôi).
  - MINOR test `..` → đường dẫn `ngoai/../mat/...` (so chuỗi lọt) + phía
    `CK_MAT_DIR` có `..`; assert `code == 2`. Mutation bỏ resolve → đỏ.
  - MINOR nhánh rủi ro phía TRANG: ca câu "vô hại" (assert câu KHÔNG khớp
    `_HIGH_RISK_RE`) trúng `B.md` trang 3 → chỉ tham chiếu; eval `ck-hr03`
    đổi thành câu không từ rủi ro (vẫn 23 ca). Mutation `or False` → đỏ.
  - MINOR OCR PDF scan: 3 test monkeypatch `pypdf.PdfReader` (OCR trúng +
    egress 0; engine thiếu → `cho_ocr` + break + thông báo; `.images` raise
    → `cho_ocr` không crash). Mutation `except ZeroDivisionError` → đỏ.
  - MINOR CMMS `--kiem-dinh`/`--phuong-tien-do` (store_true) → `--incomplete`
    báo thiếu hạn (test unit + DB vòng đầy đủ máy SS-EQ-9904).
  - MINOR CMMS `--now` chỉ với `--due`; op ghi so với `today_vn()` thật;
    test dùng fixture `fixed_today` (monkeypatch) thay `--now`; thêm ca
    `--done --on 2099 --now 2099` / `--add-plan --now` / `--add-machine
    --now` / `--incomplete --now` → exit 2.
  - Evidence: `evidence/v95_fix.log` (targeted ×3, mutation, eval, full
    pytest, ruff)

External-dependency (không treo version, KHÔNG giả lập như thật): ~300
trang tài liệu kỹ thuật thật + POC OCR 20 trang thật (chất lượng tiếng
Việt của `rapidocr` model `ch_PP-OCRv4` chưa xác minh; máy khác thiếu engine
→ trang scan `cho_ocr`); firewall chặn outbound máy chạy luồng mật (Quản lý
hạ tầng AI); Kỹ sư trưởng sửa bộ eval + tự viết ≥5 câu + chốt ngưỡng
`min_pass_rate` + ký; sổ máy thật + biên bản kiểm kê (khớp `machines`);
quyết "tự đóng gói hay gia công" (cờ `gia_cong`) + số đo năng lực thực;
ngưỡng mạng livestream chốt bởi Kỹ sư trưởng + Quản lý MXH + 2 buổi live
thử 30 phút (Đà Nẵng, Trà Linh) trước 05/11; danh mục kiểm định/phương tiện
đo/GMP do Pháp chế xác nhận; change request TGĐ ký trước 25/10; tài khoản/
role Kỹ sư trưởng trong `pipelines/auth.py` + kênh nhắc nội bộ (email/nhóm
chat — CLI `--due` hiện chỉ in). Someday: chuẩn hóa sự cố từ chat tự do qua
LLM (qua gateway, đã mask PII); A0 bản tin tuần + `approval_log` đo giờ
duyệt; tem QR mở hồ sơ máy sau đăng nhập; app/tab Kỹ thuật riêng (LAN);
role DB tách khách khỏi bảng CMMS; persist index mật; A5 dự đoán; A6
nghiệm thu độc lập; nối `capacity_for` vào `pipelines.scenario` khi v7.3 gộp.

Nhánh `ai-infra`: M30 (v3.0–v3.10) đóng và gộp đủ 2026-10-12 — 24 bảng,
831 test. Đếm bảng trong test không còn hằng số (sàn `>= 24` / đọc
schema.sql) để các version M31+ chạy song song không xung đột dòng này.

v4.0-director-framework đóng 2026-10-12 (nghiệm thu đợt 1 FIX 8 MINOR — lý do
override_qa toàn khoảng trắng, docs nói quá bảo vệ red_alerts (owner/superuser
vẫn xóa được → ha_tang KHÔNG được giữ DSN owner), deploy cho qua bằng
break-glass im lặng, agent_writer đọc mọi payload… — 1 vòng sửa → PASS;
coordinator chạy lại targeted 311 + ruff + apply_schema --roles + director
dry-run + verify-log). 29 bảng. `period_bounds` đổi ranh giới ngày UTC → giờ
VN (2 test report flip). Lưu ý song song: `test_dr_drill::test_zz_no_dr_
container_left` đỏ khi worktree khác đang chạy drill trên cùng docker host —
không phải lỗi code, chạy lại riêng xanh. Mở (bắt buộc vá TRƯỚC khi bật bất kỳ
auto_policy nào): `auto_approve_item` tin risk/qa/guardrail do agent khai lúc
enqueue. External-dep: người nhận cảnh báo đỏ + kênh gửi; người duyệt từng khối
(6 khối đang tạm map `tgd`); chủ khối ký auto_policies; SSO; object-lock.

## Checklist v4.1-guardrail-v2

Khán giả/mục đích: nhánh M31 (worktree `D:\code\samsam-w41`), WP05 / PC-A3
"Guardrail v2" (pmo.md dòng `| WP05`, plan_legal_hr.md mục A3,
research_legal.md mục 1/5/7/9). Hiện `pipelines/guardrail.py` (v3.0) chỉ có
banned-words + claim whitelist + miễn trừ span `SAFE_PHRASES`. Nó chưa chặn
rượu, chưa biết SKU nào đã có XNQC, chưa bắt buộc câu khuyến cáo / nhãn AI /
nhãn quảng cáo, chưa có luật "Ngọc Linh", và lọt từ cấm viết NFD (someday
cũ). Sau version này: (a) `check(text)` của mọi caller cũ (content, rag qua
streamlit/zalo, `store.set_status` approve, `eval_qa`, `agent_eval`) giữ
nguyên signature và nghĩa key cũ, thêm chặn rượu + chuẩn hóa NFC/casefold +
field mới; (b) hàm mới `check_publish(text, *, channel, content_type, sku,
is_ai, is_sponsored)` áp đủ bộ luật đăng bài theo kênh/loại nội dung; (c) bộ
ca `data/eval/guardrail.jsonl` thành bộ vi phạm có nhãn (≥40 critical, ≥40
hợp lệ/biên), `agent_eval` chấm critical 100% + tổng ≥95%.

Quy ước:
- Mọi lệnh shell mở đầu `cd D:/code/samsam-w41 && set -a && .
  C:/Users/hahuy/AppData/Local/Temp/claude/D--code-samsam/6e992da7-2ceb-4134-a113-c7827ba71a02/scratchpad/w41.env
  && set +a && ...` (gate bên dưới viết tắt phần sau `&&`). Không in biến
  môi trường, không đọc `.env`. Test chạy bằng `python -m pytest`.
- **Signature cố định:** `inspect.signature(guardrail.check)` vẫn là
  `(text: str) -> dict`. Key cũ `ok`/`violations`/`matched_claims` giữ
  nghĩa. Mỗi violation giữ `type`/`detail`/`span`; `type` cũ
  (`banned_word`, `unverified_claim`, `config`) giữ nguyên chuỗi;
  `matched_claims[].sku` vẫn là key của `claims_whitelist.json` (vd
  `"sapentol"`, test cũ assert). Chỉ THÊM: violation có `code`,
  `severity` (`critical|major|minor`), `start`/`end` (offset trên text đã
  NFC, `None` cho luật toàn văn như thiếu khuyến cáo); top-level có
  `warnings` (list cùng shape violation, KHÔNG ảnh hưởng `ok`),
  `skus` (sku_key golden nhận diện được), `required_labels` (list nhãn bắt
  buộc theo ngữ cảnh, `[]` với `check()`). Violation mới có `type == code`.
- **`check()` không bao giờ raise** (docstring cũ). Lỗi đọc file luật/
  golden/`KbFilterError` → `ok=False` + violation `config` critical.
- `check(text)` = chế độ chat/không rõ ngữ cảnh: luật cũ + NFC/casefold +
  ký tự chèn + rượu. KHÔNG áp readiness/khuyến cáo/nhãn/"Ngọc Linh" ở chế
  độ này (chatbot đang trả công dụng TPBVSK theo bản công bố; `sku_readiness`
  kênh `chatbot` hiện là CAM cho mọi SKU vì `allowed_channels` chỉ có
  shopee — áp vào `check()` sẽ chặn sạch câu trả lời chatbot, đổi hành vi
  caller). Các luật đó chỉ chạy trong `check_publish`.
- **Caller KHÔNG đổi trong v4.1**: `pipelines/content.py`,
  `pipelines/store.py`, `app/streamlit_app.py`, `connectors/zalo.py`,
  `api/rag.py`, `scripts/eval_qa.py` không sửa. Nối `content.draft`/
  `store.set_status` approve/Studio sang `check_publish` (kèm đổi câu
  khuyến cáo trong prompt `content.py:75-76` sang câu chuẩn và cập nhật
  `docs/handover/prompt-library.md`) để v4.2 — lý do: nhãn AI bắt buộc làm
  đỏ test approve cũ (text `"t"`) và prompt content đang dùng biến thể
  "Sản phẩm không phải là thuốc…" chưa được Pháp chế chốt. Ghi rõ trong
  STATUS: tới v4.2, `check_publish` chỉ chạy qua eval/test, chưa chặn luồng
  đăng thật; phần chặn rượu + NFC thì có hiệu lực ngay qua `check()`.
- Không thêm bảng, không thêm dependency, không gọi LLM/mạng trong
  guardrail. Guardrail không connect DB: readiness tính từ
  `data/golden_skus.json` bằng hàm Python soi gương CASE của view
  `sku_readiness` (`docs/schema.sql:321-334`), có test parity với view thật
  (W41.2). Lý do: `check()` chạy đồng bộ trong thread reply Zalo/Streamlit —
  connect DB mỗi lần check thêm độ trễ + điểm treo (gotcha v1.9). Hệ quả
  ghi someday: XNQC được ghi tay vào DB (`source='manual'`) mà chưa vào
  file golden thì guardrail vẫn coi là chưa XNQC (lệch về phía chặn,
  fail-closed).
- Regex trên free text: trace match đứng giữa chuỗi lớn hơn cả 2 phía, probe
  pathological 1MB trước khi claim xong (AGENTS.md gotcha v1.4/v0.5.1).
  Không nhúng ký tự vô hình literal vào source/test — viết escape
  (`"\u200b"`, `"\u0301"`).
- Test mới để ở `tests/test_guardrail_v2.py`; `tests/test_guardrail.py`
  KHÔNG sửa (15 test cũ, 39 case, phải xanh nguyên văn — đó là bằng chứng "test caller
  cũ xanh nguyên"). Test dùng `pytest.mark.parametrize`.
- Mọi câu khuyến cáo, nhãn, danh sách miễn trừ, nhãn bộ ca là bản dev soạn,
  ghi `"trang_thai": "chờ Pháp chế duyệt"` / `"label_status": "chờ Pháp chế
  duyệt nhãn"`. KHÔNG đánh dấu người thật đã duyệt.
- Không commit/push/reset/checkout/stash; coordinator commit. Evidence
  `evidence/v41_*.log` phải `git add -f` (bị `*.log` gitignore).

- [x] **W41.1 Chuẩn hóa so khớp + field mới + chặn rượu trong `check()`**
  - Vào `check()`: `text = unicodedata.normalize("NFC", text)` một lần;
    mọi offset/`span` tính trên bản NFC này.
  - Thay `.lower()` trong `_find_terms`/`check()`/`_claim_spans` bằng
    `_fold(s)`: casefold TỪNG ký tự, ký tự nào casefold/lower ra độ dài ≠ 1
    thì giữ nguyên (`"ß"`, `"ﬁ"`, `"İ"`) — bất biến `len(_fold(s)) ==
    len(s)` để offset không lệch (code cũ dùng `.lower()` đã lệch với `"İ"`).
  - Ký tự chèn để lách: thêm 1 pass trên bản "nén" bỏ các ký tự
    `. - _ * U+00AD U+200B-U+200D U+2060 U+FEFF` CHỈ khi nằm giữa 2 chữ cái
    (`isalpha()` 2 bên), giữ mảng index map về text NFC. Hit trên bản nén
    chỉ ghi khi span gốc chứa ≥1 ký tự bị bỏ (không nhân đôi hit thường), và
    phải nằm ngoài claim/safe span như hit thường. Áp cho banned words (cả
    nhánh không dấu). Viết cách chữ (`"t h u ố c"`) → someday, không làm.
  - Rượu: `check()` gọi `pipelines.kb_filter.is_alcohol(text)` (import lười
    trong hàm — `kb_filter` kéo `llm_gateway`/`openai`); True → violation
    `type=code="ruou_cam_quang_cao"`, critical, `span`/`start`/`end` = match
    đầu tiên của `kb_filter._patterns()` trên text fold (không tìm được span
    → `None`, vẫn là violation). `KbFilterError` → `config`.
  - Code/severity cho type cũ: `banned_word` → `code="tu_cam"` critical;
    `unverified_claim` → `code="claim_ngoai_cong_bo"` major; `config` →
    `code="config"` critical. Severity/mode đọc từ `data/guardrail_rules.json`
    (W41.2); code thiếu trong file → critical + block (fail-closed).
  - Boundary: `pipelines/guardrail.py`
  - Gate (pytest trong `tests/test_guardrail_v2.py`):
    - `inspect.signature(g.check)` có đúng 1 tham số `text`.
    - NFD: `check(unicodedata.normalize("NFD", "Sản phẩm chữa khỏi tiểu
      đường"))["ok"] is False`, có violation `tu_cam`; NFD của câu khuyến
      cáo chuẩn → `ok=True`.
    - Hoa/thường: `"SẢN PHẨM ĐIỀU TRỊ"`, `"ThUốC"` → block.
    - Chèn ký tự: `"th.uốc"`, `"c-h-ữ-a"`, `"đi\u200bều trị"`,
      `"thu\u00adốc"` → block; `"samsamngoclinh.com"`, `"Tp.HCM"`,
      `"thuộc"`, `"No.5"` không sinh `tu_cam`.
    - `len(g._fold(s)) == len(s)` với `s` chứa `"İßﬁ"` + tiếng Việt; mọi
      violation có `start/end` thì `text_nfc[start:end] == span`.
    - Rượu: mọi dòng không-comment của `data/ruou_keywords.txt` + `name`
      SKU `category=="alcohol"` trong golden, đặt trong câu
      `"Quà Tết: {kw} thượng hạng"` → `ok=False` có `ruou_cam_quang_cao`.
    - Shape: mọi violation có đủ `type, detail, span, code, severity,
      start, end`; top-level có `warnings, skus, required_labels`.
    - `KbFilterError` (monkeypatch `is_alcohol` raise) → `ok=False`,
      violation `config`, không raise.
  - Evidence: `evidence/v41_pytest.log`
- [x] **W41.2 File luật `data/guardrail_rules.json` + nhận diện SKU +
  readiness soi gương `sku_readiness`**
  - 1 file JSON mới (không phải runtime state, commit được), `_doc` ghi
    "bản dev soạn — chờ Pháp chế duyệt", gồm:
    - `rules`: `{code: {severity, mode: "block"|"warn", can_cu,
      trang_thai}}` cho mọi code guardrail sinh ra (W41.1 + W41.3).
      `mode="warn"` → vào `warnings`, không đổi `ok`.
    - `families`: `{family: {aliases, claims_keys, golden_skus}}` — nối tên
      gọi trong text ↔ key `claims_whitelist.json` ↔ `sku_key` golden. Tối
      thiểu: savina, saphraton (claims `saphraton` + `saphraton-20v`; golden
      20v/combo-2x20v/40v/80v), sapentol, savigout, savitim (golden `[]`), dạ
      an sâm (claims `[]`), mật ong sâm (3 SKU food). Alias khớp bằng
      `_find_terms` (có dấu + không dấu). Rượu không cần family (đi qua
      `kb_filter`).
    - `disclaimer.canonical`: `"Thực phẩm này không phải là thuốc và không
      có tác dụng thay thế thuốc chữa bệnh"` (NĐ 15/2018 Đ26-27 theo
      research_legal.md dòng 14 — nguyên văn).
    - `labels.ai`: `["Nội dung có sử dụng AI"]` (research_legal.md dòng
      20); `labels.ad`: bản dev (`"Quảng cáo"`, `"#quangcao"`, `"Được tài
      trợ"`, `"Hợp tác quảng cáo"`) — chờ Pháp chế.
    - `content_types`: `internal_note` (không công khai), `post` (bài thông
      tin công khai), và nhóm quảng cáo `ads`, `post_sale`, `koc`,
      `livestream_script`, `video_cart` (`ad: true`).
    - `channel_alias`: `{"blog": "web"}`; kênh hợp lệ = 6 kênh của view
      (`shopee, tiktok, web, facebook, zalo, chatbot`).
    - `ngoc_linh`: `identity` (cụm định danh được phép, dev seed `[]` —
      Pháp chế điền tên pháp nhân/thương hiệu) + `confirmed_skus: []`
      (external-dep: chưa SKU nào xác nhận quyền dùng chỉ dẫn địa lý).
  - Loader `@lru_cache` giống `_load_config`, đọc qua `DATA_DIR` (để
    `test_missing_config` cũ vẫn ra `config`). Thiếu/hỏng
    `guardrail_rules.json` hoặc `golden_skus.json` → `config` violation, cả 2
    chế độ.
  - `readiness(sku_key, channel) -> str` thuần Python từ golden file, đúng
    thứ tự CASE của view: alcohol → CAM; channel ∉ `allowed_channels` → CAM;
    tpbvsk + `xnqc_status=="approved"` → QC_DAY_DU; tpbvsk → MO_TA; food +
    `self_declaration_ok is True` → TP_THUONG; còn lại CAM. SKU lạ → CAM.
  - Boundary: `data/guardrail_rules.json` (mới), `pipelines/guardrail.py`
  - Gate (pytest):
    - Drift-guard: mọi `golden_skus` trong families ∈ golden; mọi golden SKU
      category `tpbvsk`/`food` thuộc đúng 1 family; mọi `claims_keys` ∈
      `claims_whitelist.json`; mọi code mà `guardrail.py` sinh (grep hằng
      code trong source) có trong `rules`. Cùng bất biến chốt cả LÚC CHẠY
      (`_load_rules`, fail-closed `config`): golden SKU tpbvsk/food không
      thuộc family nào / family có SKU mà `aliases` rỗng / SKU thuộc 2
      family → `config` (rules do Pháp chế sửa tay — nghiệm thu MINOR).
    - `check("Savina 12 viên")["skus"] == ["savina-12v"]`;
      `"Saphraton"` → đủ 4 SKU Saphraton; `"Da An Sam"` (không dấu) →
      `["da-an-sam-30v"]`.
    - Parity DB thật: nạp golden vào schema tạm bằng
      `ingest.golden_store.load` (mẫu fixture `db` của
      `tests/test_golden_store.py`, ROLLBACK cuối), `select sku_key,
      channel, readiness from sku_readiness` → khớp `g.readiness()` 100%
      (13 SKU × 6 kênh). Thêm 1 ca sửa tay `xnqc_status='approved'` trên
      bản copy doc → cả 2 phía QC_DAY_DU. Gate yêu cầu test này PASS, không
      skip (`-rs` không liệt kê nó).
    - Xóa file luật (monkeypatch `DATA_DIR` tmp) → `check()` và
      `check_publish()` đều `ok=False` + `config`, không raise.
  - Evidence: `evidence/v41_pytest.log`
- [x] **W41.3 `check_publish()` — bộ luật đăng bài theo kênh/loại nội
  dung**
  - Signature: `check_publish(text: str, *, channel: str, content_type: str
    = "post", sku: str | None = None, is_ai: bool = True, is_sponsored:
    bool = False) -> dict`. Cùng shape output với `check()`. Chạy lõi
    `check()` trước (dùng chung 1 hàm lõi, không copy logic), rồi thêm luật
    dưới. `channel`/`content_type`/`sku` lạ → `config` critical, không
    raise. `is_ai` mặc định True (fail-closed: không khai thì coi là AI).
  - SKU ngữ cảnh = `sku` (nếu có) ∪ `skus` nhận diện từ text.
  - `content_type == "internal_note"`: chỉ luật của `check()` TRỪ rượu (A3-2:
    ghi chú nội bộ nhắc rượu không vi phạm).
  - Mọi `content_type` công khai còn lại:
    1. **Rượu**: như `check()`; thêm: `sku` truyền vào là SKU alcohol →
       `ruou_cam_quang_cao` dù text không có từ khóa (A3-2 "Bình sứ đỏ
       500ml quà Tết").
    2. **Claim sức khỏe** = có `matched_claims` HOẶC có clause chứa
       `CLAIM_VERBS` (`_claim_spans`). Claim chỉ được khớp với claims của
       family của SKU ngữ cảnh (không dùng pool toàn bộ như `check()`):
       - SKU tpbvsk có `readiness(sku, channel) != "QC_DAY_DU"` →
         `sku_chua_xnqc` critical;
       - SKU food → `claim_suc_khoe_tp_thuong` major;
       - không có SKU ngữ cảnh → `claim_khong_ro_sku` major.
    3. **Quảng cáo TPBVSK chưa XNQC**: `content_type` thuộc nhóm `ad` (hoặc
       `is_sponsored`) + có SKU tpbvsk chưa QC_DAY_DU → `sku_chua_xnqc` kể
       cả khi KHÔNG có claim (A3-1: Savigout + koc "link mua ở bio").
    4. **Câu khuyến cáo**: bắt buộc khi có SKU tpbvsk HOẶC có claim sức
       khỏe. Đạt khi text chứa `disclaimer.canonical` (fold, khoảng trắng
       linh hoạt, có dấu — bản không dấu KHÔNG tính là đạt nhưng vẫn được
       miễn từ cấm như cũ) và span đó còn sống sau `_negated_hits` (không
       '?', không cụm đảo nghĩa đứng trước). Thiếu → `thieu_khuyen_cao`
       critical, `start/end=None`. Miễn trừ từ cấm vẫn theo đúng span
       `SAFE_PHRASES` — KHÔNG miễn cả văn bản khi có câu khuyến cáo.
    5. **Nhãn**: `is_ai` → bắt buộc 1 cụm `labels.ai` →
       `thieu_nhan_ai` major; nhóm `ad` hoặc `is_sponsored` → bắt buộc 1
       cụm `labels.ad` → `thieu_nhan_quang_cao` major. `required_labels`
       liệt kê nhãn bắt buộc của ngữ cảnh.
    6. **"Ngọc Linh"**: mỗi lần xuất hiện (có dấu/không dấu, word-boundary —
       "samsamngoclinh.com" tự không khớp) nằm ngoài span `ngoc_linh.identity`
       → `ngoc_linh_chua_xac_nhan` major, trừ khi có SKU ngữ cảnh và MỌI SKU
       ngữ cảnh ∈ `confirmed_skus`.
    7. **Kênh chưa mở**: SKU ngữ cảnh có `readiness == "CAM"` vì kênh ngoài
       `allowed_channels` (không phải alcohol) → `sku_chua_mo_kenh` minor,
       `mode="warn"` (`allowed_channels` là hiện trạng listing, chưa phải
       quyết định GĐ — golden `_doc`).
  - Boundary: `pipelines/guardrail.py`
  - Gate (pytest `tests/test_guardrail_v2.py`, mỗi luật ≥1 ca block + ≥1
    ca pass/biên):
    - A3-1: `check_publish("Savigout chính hãng, link mua ở bio",
      channel="tiktok", content_type="koc")` → có `sku_chua_xnqc`.
    - A3-2: `"Rượu sâm bình sứ đỏ – món quà Tết trang nhã"` kênh facebook
      `post_sale` → `ruou_cam_quang_cao`; cùng text `internal_note` → không
      có violation rượu; `sku="ruou-sam-binh-su-do-500ml"` + `"Bình sứ đỏ
      500ml quà Tết"` → `ok=False`.
    - Khuyến cáo — span đúng: (a) bài đủ nhãn + câu chuẩn → không có
      `thieu_khuyen_cao` và không có `tu_cam`; (b) câu chuẩn + `"Savina
      chữa ho."` ở câu khác → có `tu_cam` với span `"chữa"` có `start` NẰM
      NGOÀI span câu khuyến cáo; (c) câu chuẩn rồi `", nhưng tốt hơn
      thuốc"` → `tu_cam` "thuốc"; (d) `"Ai bảo thực phẩm này không phải là
      thuốc…"` → vẫn `thieu_khuyen_cao`; (e) chỉ có biến thể `"Sản phẩm
      không phải là thuốc…"` → `thieu_khuyen_cao` nhưng KHÔNG `tu_cam`.
    - Nhãn: thiếu/đủ `"Nội dung có sử dụng AI"`; `is_ai=False` → không
      bắt; `ads` thiếu/đủ `"#quangcao"`.
    - Claim đúng SKU: `"Sapentol giúp giảm acid uric"` (claim của Savigout)
      → `claim_ngoai_cong_bo`; mật ong + `"hỗ trợ bồi bổ sức khỏe"` →
      `claim_suc_khoe_tp_thuong`; `"Sản phẩm giúp giảm mệt mỏi"` không tên
      SKU → `claim_khong_ro_sku`.
    - Ngọc Linh: `"Sâm Ngọc Linh chính gốc vùng lõi"` + Saphraton →
      `ngoc_linh_chua_xac_nhan`; `"Xem thêm tại samsamngoclinh.com"` → không;
      rules tạm có `identity=["Công ty Mẫu Ngọc Linh"]` (fixture tmp, chuỗi
      giả rõ ràng) → cụm đó không bị flag, "Ngọc Linh" ở câu khác vẫn bị;
      `confirmed_skus` chứa SKU ngữ cảnh → không flag; `check()` (chat) với
      "sâm Ngọc Linh" → không flag.
    - `sku_chua_mo_kenh` nằm trong `warnings`, `ok` không đổi vì nó.
  - Evidence: `evidence/v41_pytest.log`
- [x] **W41.4 Bộ ca vi phạm có nhãn + `agent_eval` ngưỡng mới**
  - `data/eval/guardrail.jsonl`: GIỮ 39 ca cũ (id/text/expect/kind không
    đổi — `test_guardrail_cases_cover_core_words_and_v30_sets` đọc chúng).
    `_doc` giữ cụm "chưa được công ty duyệt" và thêm "chờ Pháp chế duyệt
    nhãn". Ca mới thêm field `label_status: "chờ Pháp chế duyệt nhãn"`,
    `code` (bắt buộc với ca `expect=block`: code violation kỳ vọng),
    `ctx` (tùy chọn: `{channel, content_type, sku, is_ai, is_sponsored}`
    → chấm bằng `check_publish`; không có → `check`).
    - `kind="trap_critical"` ≥40 ca, `expect=block`, `code` ∈
      {`ruou_cam_quang_cao`, `sku_chua_xnqc`, `thieu_khuyen_cao`,
      `tu_cam`}, mỗi code ≥8 ca (tu_cam gồm NFD, hoa/thường, chèn
      `.`/`-`/zero-width, không dấu; rượu gồm từ khóa, tên SKU golden,
      `sku` meta, nhiều kênh).
    - `kind="trap_disclaimer"` ≥8 ca `expect=pass`: câu khuyến cáo chuẩn
      đứng riêng / giữa đoạn / NFD / HOA / xuống dòng giữa câu, trong
      `check()` và trong `check_publish` ngữ cảnh đủ điều kiện (SKU
      QC_DAY_DU giả lập KHÔNG có trong golden → dùng ngữ cảnh không cần
      XNQC, vd `post` không claim + đủ nhãn).
    - `kind="edge"` + `kind="pass"` mới: tổng (trap_disclaimer + edge +
      pass mới) ≥40 — phủ định "không chữa", "thuộc", "Ngọc Linh" trong
      chat, samsamngoclinh.com, internal_note nhắc rượu, mật ong không
      claim, "Liên hệ" giá... Nhãn `expect` ghi theo Ý ĐỊNH pháp lý (bản dev),
      KHÔNG chép theo output hiện tại — ca biên guardrail xử lý khác ý định
      được phép fail (vd "Sản phẩm không chữa bệnh" ý định pass, guardrail
      chặn bảo thủ) và phải liệt kê trong evidence.
  - `scripts/agent_eval.py::run_guardrail`: có `ctx` → `check_publish(text,
    **ctx)`; ca `expect=block` có `code` chỉ pass khi bị chặn VÀ `code` ∈
    code các violation. Không đổi CLI/exit code/ghi `eval_runs`.
  - `data/eval/config.json` agent `guardrail`: `min_pass_rate: 0.95`;
    `must_pass_kinds: ["trap_block", "trap_critical", "trap_disclaimer"]`
    (critical 100% + 0 false-positive câu khuyến cáo nhờ score cũ: kind bắt
    buộc fail → FAIL); `prompt_files` thêm `data/guardrail_rules.json`,
    `data/golden_skus.json`, `data/ruou_keywords.txt`,
    `pipelines/kb_filter.py`.
  - Test cũ phải sửa (FLIP có chủ đích, ghi trong evidence + diff đếm
    assert trước/sau, gotcha v1.7): `tests/test_agent_eval.py::
    test_config_thresholds_and_trap_kinds` (`== 1.0` → `== 0.95`),
    `test_guardrail_cases_match_current_behavior` (100% → mọi ca kind bắt
    buộc pass + tổng ≥0.95). Không xóa assert khác.
  - Boundary: `data/eval/guardrail.jsonl`, `data/eval/config.json`,
    `scripts/agent_eval.py`, `tests/test_agent_eval.py`
  - Gate:
    - `python -c` (UTF-8 guard) đếm: trap_critical ≥40, mỗi code ≥8;
      trap_disclaimer ≥8; trap_disclaimer+edge+pass mới ≥40; mọi ca mới có
      `label_status`; id không trùng.
    - `python scripts/agent_eval.py --agent guardrail --no-record` → exit 0,
      dòng `[done] guardrail PASS`, không có dòng `ca bắt buộc FAIL`.
    - Mutation (chạy tay, revert ngay, KHÔNG stash): bỏ nhánh rượu /
      bỏ luật khuyến cáo / bỏ `SAFE_PHRASES` mục dài → agent_eval FAIL
      exit 1 mỗi lần.
    - `python -m pytest -q tests/test_agent_eval.py` xanh.
  - Evidence: `evidence/v41_eval.log` (output agent_eval + danh sách ca
    biên fail kèm lý do + mutation)
- [x] **W41.5 Rà caller + doc (dây chuyền drift-guard)**
  - `grep -rn "check(" --include=*.py pipelines api app connectors scripts
    agents ingest` → liệt kê mọi caller `guardrail.check` trong evidence,
    mỗi caller ghi: gọi `check(text)` 1 tham số, đọc key nào (`ok`/
    `violations[].type|detail|span`/`matched_claims`) → không đổi nghĩa.
  - `docs/handover/phu-luc-d.md`: thêm mục "Guardrail v2" — số ca từng kind
    trong `data/eval/guardrail.jsonl`, bảng code/severity, tên mọi
    `def test_*` của `tests/test_guardrail_v2.py`, trạng thái "chờ Pháp chế
    duyệt nhãn". `tests/test_handover_docs.py`: thêm 1 test drift-guard tên
    test v2 + số ca theo kind có trong phu-luc-d (word-boundary, gotcha
    v2.3).
  - `docs/handover/kien-truc.md` dòng mô tả `guardrail.py` (bảng module)
    cập nhật: + rượu, NFC, `check_publish`, `guardrail_rules.json`. Không
    đổi số bảng (v4.1 không thêm bảng).
  - `STATUS.md`: 1 đoạn v4.1 — có gì, `check_publish` chưa nối luồng đăng
    (v4.2), external-dep.
  - Boundary: `docs/handover/phu-luc-d.md`, `docs/handover/kien-truc.md`,
    `tests/test_handover_docs.py`, `STATUS.md`
  - Gate: `python -m pytest -q tests/test_handover_docs.py` xanh; caller
    test `python -m pytest -q tests/test_guardrail.py tests/test_content.py
    tests/test_store.py tests/test_auth_approval.py tests/test_zalo.py
    tests/test_rag.py` xanh, `git diff --stat` cho thấy các file test này +
    `pipelines/content.py pipelines/store.py app/ connectors/ api/` KHÔNG đổi.
  - Evidence: `evidence/v41_pytest.log` (mục "rà caller")
- [x] **W41.6 Probe pathological 1MB tuyến tính**
  - Probe (script tạm trong scratchpad, KHÔNG thêm vào repo) chạy
    `check()` và `check_publish(channel="facebook", content_type="ads")` trên
    100KB và 1MB của: `"a"`; `"."`; `"\u200b"`; `"chữa "`;
    `"không phải là thuốc "`; `"Ai bảo "` + câu khuyến cáo lặp;
    `"t.h.u.ố.c "`; `"Sapentol giảm mỡ máu. "` (nhiều claim × nhiều
    clause); `"giúp "` không dấu ngắt; `"ngọc linh "`; `"rượu "`; NFD của
    câu khuyến cáo lặp.
  - Biết trước phải vá nếu đỏ: (a) vòng `for ms, me in matched_spans` lồng
    trong mỗi claim clause (`guardrail.py:199-207`) là O(clause × claim) →
    bisect/two-pointer; (b) `_find_terms` tính lại `_strip_len(low)` cho
    mỗi lần gọi (mỗi claim 1 lần) → tính fold/strip/bản nén 1 lần mỗi lần
    check, truyền vào.
  - Boundary: `pipelines/guardrail.py`
  - Gate: mọi input: `t(1MB) / t(100KB) ≤ 15` và `t(1MB) < 20s` (đo lúc
    máy tải, ghi số thật); kết quả `ok` của 100KB và 1MB cùng giá trị. Không
    viết assert wall-clock vào pytest (gotcha timing).
  - Evidence: `evidence/v41_probe.log` (bảng input × size × giây × ratio,
    trước và sau vá nếu có vá)

Kết quả worker (2026-10-12, evidence `evidence/v41_pytest.log`,
`v41_eval.log`, `v41_probe.log`): full `python -m pytest -q` 917 passed
(baseline 831 + 85 `test_guardrail_v2` + 1 `test_handover_docs`), 0
skipped (baseline 0); targeted ×3 205/205 mỗi lần, parity DB không skip;
`ruff check .` sạch; `agent_eval --agent guardrail --no-record` PASS
125/127 (0.9843) — 2 ca biên fail theo ý định (`v41-edge-01` "không chữa
bệnh", `v41-edge-02` "thực phẩm bảo vệ sức khỏe"); 3 mutation đều FAIL
exit 1; probe 1MB: v3.0 gốc TIMEOUT >30s mọi input, v4.1 ratio 7.1–13.3,
max 10.1s. Lệch contract (ghi rõ): ngoài 2 test flip đã liệt kê, phải sửa
thêm DÂY CHUYỀN `test_guardrail_run_records_pass` (`pass_rate == 1.0` →
`>= threshold`) và fixture `test_removing_dieu_tri_fails` (copy thêm
`guardrail_rules.json` + `golden_skus.json`) — assert 87 → 88, không xóa
assert nào. Someday mới: rượu viết chèn ký tự (`r.ượu`) chưa bắt (pass nén
chỉ áp từ cấm); `CLAIM_VERBS` "giảm"/"bảo vệ" bắt nhầm "giảm giá"/"thực
phẩm bảo vệ sức khỏe" (v3.0, nay thêm `claim_suc_khoe_tp_thuong` cho mật
ong "giảm giá"); `rules[code].mode` có thể hạ code critical xuống `warn`
chỉ bằng sửa JSON (chưa có chốt chặn — file trong git + `prompt_version`).

Vá nghiệm thu (2026-10-12, 5 MINOR, evidence nối đuôi 3 file `v41_*.log`):
(1) 0-record config — `_load_config` banned rỗng sau lọc comment → config;
`_load_rules` golden 0 SKU hoặc family trỏ SKU thiếu trong golden →
config (`test_zero_record_config_fail_closed` ×3, cả `check`/`check_publish`);
(2) rượu chèn ký tự — nhánh rượu quét thêm bản nén `_compress` (dùng chung
với pass từ cấm), span map về text gốc (`test_alcohol_filler_evasion_blocked`
×5, `test_alcohol_filler_pass_no_false_positive` ×4, ca `v41-ruou-13..15`) —
someday "`r.ượu` chưa bắt" ở trên ĐÃ VÁ; (3) pool claim theo đúng SKU —
assert nguyên văn claim Savigout gắn Sapentol + claim không SKU trong
`test_claims_bound_to_context_sku`, ca `v41-edge-34/35`; (4) span rượu —
`test_alcohol_keywords_and_golden_names_blocked` assert start/span nằm
trong `{kw}` + `test_alcohol_span_exact`; (5) `test_guardrail_cases_match_
current_behavior` pin tập fail ⊆ {`v41-edge-01`,`v41-edge-02`}. Mutation
pool-full / sp=None / tắt nén rượu / bỏ chốt family / bỏ chốt banned đều
đỏ. Full 930 passed (917 + 13), targeted ×3 218/218, ruff sạch,
`agent_eval` PASS 130/132 (0.9848). Probe 1MB: tuyến tính (us/char gần
hằng); 1 ratio 15.3 > 15 do điểm 100KB nhiễu cache — số thật trong log.
Vòng sửa nghiệm thu MINOR (`_load_rules` chiều ngược golden ⊆ families):
+6 breaker `test_zero_record_config_fail_closed` (`families={}`, xoá
family savigout, `golden_skus=[]`, `aliases=[]`, aliases chỉ khoảng trắng,
SKU thuộc 2 family) — tắt chốt thì cả 6 đỏ; full 936 passed, targeted ×3
224/224, ruff sạch, `agent_eval` PASS 130/132 (0.9848).

- [ ] **External-dep — chờ Pháp chế Sâm Sâm**: duyệt nhãn bộ ca
  `data/eval/guardrail.jsonl` (ca mới `label_status`), câu khuyến cáo chuẩn
  + biến thể chấp nhận, cụm nhãn AI/nhãn quảng cáo, `ngoc_linh.identity`
  (tên pháp nhân/thương hiệu), `ngoc_linh.confirmed_skus` (quyết định công
  nhận chỉ dẫn địa lý, QĐ 3558/QĐ-UBND), severity/mode từng code trong
  `rules`. Danh sách XNQC thật (golden `xnqc_status` đang `none`, hồ sơ
  đợt 1 nộp 16/10 do người làm) và nội dung claim theo từng giấy XNQC.
  Ngưỡng 0.95 do công ty chốt. CHƯA có người duyệt thật — không đánh dấu đã
  duyệt.
- Ngoài phạm vi → v4.2: lớp LLM-check phụ (qua `llm_gateway`, A3 (h)); nối
  `content.draft`/`store.set_status` approve/Studio sang `check_publish`
  (+ readiness đọc view `sku_readiness` qua conn sẵn có ở approve, prompt
  content đổi sang câu khuyến cáo chuẩn, bỏ "Ngọc Linh" khỏi brand-voice
  nếu Pháp chế chưa xác nhận); bộ red-team PC-A9 bằng model khác; luật
  mốc 72h/căn cứ chưa xác minh chạy chế độ warn (A3-8). Someday: từ cấm viết
  cách chữ `"t h u ố c"`; combining mark lẻ không ghép được NFC; XNQC ghi
  tay vào DB không phản ánh vào guardrail cho tới khi cập nhật golden file.

Gate chung (đọc output tới khi process exit trước lệnh nặng kế tiếp, không
chạy chồng pytest, full pytest đúng 1 lần mỗi vòng):
- targeted ×3: `python -m pytest -q -rs tests/test_guardrail.py
  tests/test_guardrail_v2.py tests/test_agent_eval.py
  tests/test_handover_docs.py tests/test_kb_filter.py` — xanh 3 lần, test
  parity DB không nằm trong danh sách skip.
- full: `python -m pytest -q` — baseline 831 passed; kỳ vọng 831 + số case
  mới, 0 fail, số skipped không tăng so với baseline chạy trước khi sửa.
- `ruff check .` sạch.
- `python -m py_compile pipelines/guardrail.py scripts/agent_eval.py`.
- `python scripts/agent_eval.py --agent guardrail --no-record` exit 0.
- Gate thêm (log `evidence/v41_eval.log`): 100% trap_critical + trap_block
  bị chặn đúng code; 0 false-positive trên trap_disclaimer; tổng ≥95%;
  `git diff --stat -- tests/test_guardrail.py pipelines/content.py
  pipelines/store.py app connectors api` rỗng; probe W41.6 đạt.

v4.1-guardrail-v2 đóng 2026-10-12 (nghiệm thu đợt 1 FIX 5 → 2 vòng sửa còn 1
MINOR — `ngoc_linh.terms` toàn ô trống làm luật Ngọc Linh bị bỏ câm — coordinator
vá (lọc term rỗng → fail-closed `config`) + breaker `_nl_terms_blank`, mutation
đỏ/xanh; chạy lại targeted 225 + ruff + agent_eval guardrail PASS 130/132).
Trước v4.1 mọi input 1MB timeout >30s; nay ≤ ~10s. QUAN TRỌNG: `check()` giữ chế
độ chat (chỉ thêm chặn rượu + NFC + chèn ký tự lách); luật đăng bài đầy đủ ở
`check_publish()` CHƯA nối vào content/store/Studio — v4.2 phải nối. 2 ca biên
cố ý FAIL (chặn bảo thủ): 'Sản phẩm không chữa bệnh…', 'thực phẩm bảo vệ sức
khỏe'. External-dep: Pháp chế duyệt nhãn bộ ca, câu khuyến cáo chuẩn, nhãn AI/QC,
`confirmed_skus` Ngọc Linh, severity; danh sách XNQC thật. Someday: guardrail đọc
readiness từ file golden (XNQC ghi tay vào DB chưa vào file → vẫn chặn).

## Checklist v4.4-phap-che-dpo

Khán giả/mục đích: nhánh M31 (worktree `D:\code\samsam-w44`) — phần
Pháp chế–Nhân sự của WP05 (pmo.md dòng `| WP05`; plan_legal_hr.md §2,
§5, §6, §9, §12, A0/A5/A6/A7; research_legal.md mục 3–7). Chuyên viên
Pháp chế là người DUY NHẤT duyệt; hiện chưa có gì giúp họ: (1) không
biết hàng duyệt có vượt trần ~25 mục/ngày (§2) hay không; (2) chưa có
DPIA/TIA dù chatbot gửi câu hỏi khách sang OpenRouter (Mỹ) — chuyển dữ
liệu xuyên biên giới theo Luật BVDLCN 91/2025; (3) chưa có hợp đồng mẫu
KOC/đại lý có điều khoản cấm claim chữa bệnh/cấm quảng cáo rượu; (4)
chưa có JD/KPI cho 2 người vận hành. Sau version: PC-A0 `python
scripts/review_load.py` báo tải hàng duyệt so với quota đề xuất; PC-A5
`data/data_flow_map.json` (bản đồ luồng dữ liệu THẬT, rà từ code) →
`python scripts/dpia_draft.py` sinh `docs/legal/DPIA-nhap.md` +
`TIA-nhap.md`, có drift-guard bắt module mới gửi dữ liệu ra ngoài mà
chưa khai báo + form đồng ý mẫu; PC-A6 2 hợp đồng mẫu + `python
scripts/contract_check.py` kiểm đủ điều khoản bắt buộc; PC-A7 JD/KPI trỏ
tới chỉ số hệ thống thật. MỌI output là NHÁP chờ Pháp chế/luật sư/TGĐ —
agent/doc KHÔNG kết luận "đã tuân thủ", không tự điền tên người ký,
không tự phân việc cho người thật.

Quy ước: ponytail — stdlib (`json`, `ast`, `re`, `argparse`, `pathlib`) +
`psycopg` sẵn có; KHÔNG dep mới, KHÔNG gọi LLM/gateway/mạng trong cả 3
script (template + luật tất định; nếu sau này cần LLM soạn nháp thì qua
`pipelines.llm_gateway.chat` + `guardrail.check()` — ngoài phạm vi). KHÔNG
thêm bảng (kien-truc.md "24 bảng public" giữ nguyên) — `review_load` chỉ
SELECT `content_drafts` + `approvals`. Không file runtime mới trong
`data/` (2 file JSON mới là cấu hình/khai báo, commit được, không PII).
Mọi script: UTF-8 reconfigure guard sau imports (print tiếng Việt);
connect qua `ingest.lead_store.connect()` (đã `connect_timeout`, guard
`tests/test_connect_timeout_guard.py`); ghi file docs bằng bytes/`newline
="\n"` (không để Windows đổi `\r\n` → `--check` lệch); tham số ngày nhận
str từ CLI → coerce `date` TRƯỚC mọi format-spec (gotcha v2.2). Căn cứ
pháp lý trích research_legal.md: Luật BVDLCN 91/2025/QH15 + NĐ 356/2025
(cùng hiệu lực 01/01/2026, NĐ 356 thay NĐ 13/2023 — khung mục DPIA/TIA
dựng theo cấu trúc hồ sơ đánh giá tác động của NĐ 13/2023 Điều 24–25 +
Luật 91/2025; NGUYÊN VĂN và mẫu biểu của NĐ 356 CHƯA mở nguồn → ghi
"CẦN LUẬT SƯ XÁC NHẬN" tại chỗ); Luật QC 75/2025 + NĐ 342/2025 (nhãn
quảng cáo, gỡ 24h, nghĩa vụ người chuyển tải — nghĩa vụ KOC "chưa xác
minh, luật sư rà"); Luật 44/2019 Đ5 k7/k9 (cấm QC/khuyến mại rượu ≥15
độ); Luật AI 134/2025 (nhãn nội dung AI). Mọi doc trong `docs/legal/`
mở đầu bằng khối "BẢN NHÁP — chưa có giá trị pháp lý; chờ <ai> rà/ký"
và các ô người ký/ngày ký để TRỐNG (`{{...}}`), dữ liệu đối tác là
placeholder `{{ten_doi_tac}}` — không tên/SĐT/MST người thật. Cụm "đã
tuân thủ" bị cấm trong mọi output (test). Cả 3 script mới KHÔNG được
nằm trong `egress_modules()` (W44.2) — tự chứng minh không gửi gì ra
ngoài.

External-dep (KHÔNG giả lập, để `[ ]`): Chuyên viên Pháp chế ký DPIA/TIA
+ luật sư rà trước khi nộp/công bố (đối chiếu NĐ 356/2025, ân hạn 5 năm
DN nhỏ có áp dụng khi xử lý tin nhắn sức khỏe — dữ liệu nhạy cảm — hay
không); luật sư xác nhận 2 hợp đồng mẫu (A6-1 "có xác nhận luật sư") và
điền đối tác thật từ bảng `partners` (chưa có bảng — WP khác); quota
duyệt THẬT + lịch vắng người duyệt do TGĐ chốt (file hiện là đề xuất
§2); TGĐ duyệt JD/KPI + mức lương/phụ cấp trực; cơ chế ghi nhận đồng ý
trong kênh chat (bảng `consent`, tin chào có link chính sách — thuộc
gateway/Hạ tầng plan_data_platform §3, CHƯA có trong code → DPIA ghi là
GAP, form đồng ý chưa gắn kênh live); ticket gỡ 24h/lịch trực (A0-3,
A4) chưa có công cụ → KPI tương ứng ghi "CHƯA ĐO ĐƯỢC".

- [x] **W44.1 PC-A0 mô hình tải người duyệt** — `data/review_quota.json`
  `{"_doc": "ĐỀ XUẤT theo plan_legal_hr §2 (quỹ 120→240 phút/ngày), CHƯA
  được TGĐ chốt — quota thật = external-dep", "status": "de_xuat",
  "phases": [{"from": "2026-10-01", "to": "2026-10-31", "daily_cap": 25},
  {"from": "2026-11-01", "to": "2026-11-15", "daily_cap": 35}, {"from":
  "2026-11-16", "to": null, "daily_cap": 55}], "absent_days": []}` —
  `daily_cap` = trần quyết định/ngày của MỖI người duyệt; `absent_days`
  (ISO) → cap 0 ngày đó. `scripts/review_load.py` — hàm thuần
  `load_quota(path) -> dict` (validate: JSON hỏng / phases rỗng / ngày
  sai ISO / `daily_cap` không phải int ≥ 0 / khoảng chồng nhau →
  `ValueError`), `cap_for(day: date, quota) -> int | None` (None = không
  phase nào phủ), `collect(conn, today: date, days: int) -> dict` (CHỈ
  SELECT, ngày theo `at time zone 'Asia/Ho_Chi_Minh'`): (a) hàng chờ =
  `content_drafts` `status='pending'` tách 3 nhóm theo
  `guardrail->>'ok'`: `true` → "vào hàng" (tính quota), `false` → "trả
  tác giả" (KHÔNG tính quota — §6 bước 2), thiếu/khác → "KHÔNG RÕ" tính
  VÀO hàng (fail-closed); + tuổi mục pending cũ nhất (ngày); (b) inflow =
  số draft tạo theo ngày VN trong `days` ngày gần nhất (gồm hôm nay); (c)
  throughput = số dòng `approvals` (mọi `object_type`, cả approved lẫn
  rejected) theo (ngày VN của `approved_at`, `approved_by` btrim) trong
  cửa sổ; `render(stats, quota, today) -> str`; `main()`. Cảnh báo
  (dòng mở đầu `QUÁ TẢI` / `CẢNH BÁO`): hàng (vào hàng + KHÔNG RÕ) > cap
  hôm nay → "cần ≥ ceil(n/cap) ngày duyệt"; 1 người duyệt có số quyết
  định trong 1 ngày > cap ngày đó → "vượt trần — rủi ro duyệt vội"; TB
  inflow/ngày > cap hôm nay → "nháp vào nhanh hơn trần — giảm volume,
  không hạ chuẩn (§2)"; hôm nay ∈ `absent_days` và hàng > 0 → "người
  duyệt vắng — pending giữ nguyên, không ai được duyệt thay". Report ghi
  rõ "quota ĐỀ XUẤT, chưa TGĐ chốt" khi `status != "chot"`. KHÔNG
  INSERT/UPDATE/DELETE, không gán người duyệt, không gọi `set_status`.
  CLI: `[--today YYYY-MM-DD] [--days N] [--quota PATH]`; `--days` ngoài
  1..366, `--today` sai ISO, quota hỏng, không phase phủ `today` →
  `[err]` exit 2 TRƯỚC connect; DB không connect được / thiếu bảng →
  "[err] DB không truy cập được" exit 1; còn lại exit 0 (cảnh báo chỉ in,
  không đổi exit — A0 chỉ nhắc). Tên người duyệt in nguyên (nhân viên,
  không phải khách); không in `text`/`brief` của draft.
  - Boundary: `data/review_quota.json`, `scripts/review_load.py`,
    `tests/test_review_load.py`
  - Gate: `tests/test_review_load.py` — unit thuần: `load_quota` bắt
    từng lỗi (≥5 case: JSON hỏng, phases rỗng, ngày sai, cap âm/str,
    chồng khoảng); `cap_for` biên `2026-10-31`→25, `2026-11-01`→35,
    `2026-11-16`→55, absent→0, ngày trước phase đầu→None; CLI
    `--today 2026-13-01` / `--days 0` exit 2 với `connect` monkeypatch
    raise (chứng minh chưa connect). DB THẬT (schema tạm + `set local
    search_path` + docs/schema.sql + ROLLBACK, mẫu fixture `db` của
    `tests/test_auth_approval.py`; gate yêu cầu 0 skipped): fixture
    today=2026-10-12, days=7 — pending ok=true 26 + ok=false 3 + thiếu ok
    1 + approved/rejected 4 (không vào hàng) → "vào hàng" 26, "trả tác
    giả" 3, "KHÔNG RÕ" 1, tổng tính quota 27 > 25 → QUÁ TẢI "≥ 2 ngày";
    approvals: `REVIEWER_A` 26 dòng ngày 2026-10-11 → QUÁ TẢI người,
    `REVIEWER_B` 5 dòng → không cảnh báo; 1 dòng `approved_at`
    2026-10-11 16:30 UTC (= 23:30 VN) tính ngày 11, 1 dòng 2026-10-11
    17:30 UTC (= 00:30 VN 12/10) tính ngày 12; 1 dòng 2026-10-01 ngoài
    cửa sổ không đếm — assert ĐÚNG từng số trong `collect()` + chuỗi
    cảnh báo trong `render()`; sau `collect()` số dòng `content_drafts`/
    `approvals` không đổi; fake-conn ghi lại MỌI câu SQL được execute →
    tất cả bắt đầu bằng `select`/`with` (read-only). DB-down:
    `DATABASE_URL=postgresql://u@10.255.255.1:5432/x` (gotcha v2.0 —
    không `env -u`) → exit 1, không treo (≤ connect_timeout + vài giây).
  - Evidence: `evidence/v44_review_load.log` (chạy thật `python
    scripts/review_load.py` trên DB samsam_infra + output fixture)
  - Kết quả: 37 passed (13 case load_quota, biên cap_for, CLI exit 2 trước connect, fixture DB thật đúng từng số: vào hàng 26/trả tác giả 3/KHÔNG RÕ 1 → 27 > 25 '≥ 2 ngày', REVIEWER_A 26 ngày 11 (gồm 23:30 VN + tên có khoảng trắng btrim), 00:30 VN tính ngày 12, dòng 01/10 ngoài cửa sổ; read-only fake-conn; DB chết exit 1 ~4s). DB samsam_infra thật: 0 draft → không cảnh báo. Thêm (OWASP A09): thay ký tự điều khiển trong tên người duyệt trước khi in. Quota thật do TGĐ chốt: external-dep `[ ]`.
- [x] **W44.2 PC-A5 bản đồ luồng dữ liệu + drift-guard egress** —
  `data/data_flow_map.json` `{"_doc": "...rà từ code ngày 2026-10-12;
  sửa code thêm luồng ra ngoài PHẢI cập nhật file này (test đỏ)...",
  "version": "2026-10-12", "classes": {"do": "...", "vang": "...", "xanh":
  "..."}, "flows": [...]}` — định nghĩa lớp theo plan_data_platform.md §2:
  Đỏ = orders, leads, liên hệ đại lý, log hội thoại, tin nhắn có yếu tố
  sức khỏe, user_id thô; Vàng = câu hỏi thường SAU `_mask_pii`, tài liệu
  nội bộ; Xanh = catalog/claims/chunk public. Mỗi flow: `id` (`DF-xx`,
  unique), `name`, `modules` (đường dẫn posix tương đối, tồn tại),
  `data` (loại dữ liệu), `class` ∈ {do,vang,xanh}, `subjects` (chủ thể),
  `purpose`, `storage` (nơi lưu: file/bảng thật), `retention` (giá trị
  THẬT từ code, vd convlog `RETAIN_DAYS = 30` zalo.py; `leads`
  "không có hạn — GAP"; `_histories` "RAM, LRU 1000 user, mất khi
  restart"; `zalo_seen.db` TTL 1h/7 ngày), `recipients` (bên nhận + nước),
  `cross_border` (bool), `safeguards` (biện pháp có trong code: `_mask_pii`
  ở gateway cho MỌI message kể cả history, `is_health_question` chặn
  trước LLM, provider routing `data_collection=deny`/`zdr`/
  `provider_only` từ `data/llm_gateway.json`, OCR nước ngoài bị từ chối
  ở doc_intake, cột PII sàn bị drop + `order_id_hash`), `legal_basis`
  (vd "đồng ý — CHƯA có cơ chế ghi nhận trong code: GAP"), `gaps` (list,
  có thể rỗng). Luồng BẮT BUỘC có (rà từ code thật): Zalo nhận/trả lời
  (`connectors/zalo.py` → openapi.zalo.me / oauth.zaloapp.com, VN);
  preflight token (`scripts/zalo_preflight.py`); mock (`scripts/
  zalo_mock.py`, localhost — `cross_border` false, ghi rõ chỉ test);
  convlog `data/conversations.jsonl` (mask + `_uhash`, 30 ngày); leads
  (`ingest/lead_store.py` → bảng `leads`); chatbot RAG (`api/rag.py` →
  `pipelines/llm_gateway.py` → OpenRouter + provider whitelist, Mỹ —
  `cross_border` true, gồm history 4 lượt + Streamlit `app/
  streamlit_app.py`); content studio (`pipelines/content.py` → gateway,
  brief do nhân viên nhập); embeddings KB public (`ingest/embed_store.py`,
  Xanh, cross_border true); KB nội bộ (`ingest/kb_internal.py` →
  embeddings qua gateway, Vàng, cross_border true); số hóa tài liệu
  (`ingest/doc_intake.py`, local, OCR provider `none`, cross_border
  false); file sàn (`ingest/market_csv.py`, local, PII drop); bản tin sức
  khỏe (`scripts/health_bulletin.py` → SMTP/Telegram khi `--notify`, chỉ
  số tổng hợp, Telegram cross_border true); crawl web công khai
  (`crawler/collect.py`, GET trang public, không gửi dữ liệu cá nhân);
  `llm_usage` (metadata token/chi phí, không nội dung); backup DB
  (`scripts/db_backup.py`, offsite `dir:` local, `s3://` external-dep).
  Hàm dùng chung đặt trong `scripts/dpia_draft.py`: `load_map(path) ->
  dict` (validate: key thiếu / class lạ / id trùng / `cross_border` không
  phải bool / `modules` rỗng hoặc trỏ file không tồn tại → `ValueError`
  nêu id + field) và `egress_modules(root) -> set[str]` — quét `ast`
  MỌI `*.py` dưới root (bỏ `tests`, `.venv`, `venv`, `__pycache__`,
  `.git` — như `tests/test_connect_timeout_guard.py`), cả import LƯỜI
  trong hàm: module có `import`/`from` gốc ∈ {`openai`, `httpx`,
  `requests`, `smtplib`, `aiohttp`, `urllib3`, `ftplib`} hoặc dotted
  `urllib.request` / `http.client` (kể cả `from urllib import request`)
  — `urllib.parse` và `socket` (job_runs chỉ `gethostname`) KHÔNG tính,
  comment lý do; hoặc module import tên `chat`/`embed` từ
  `pipelines.llm_gateway` (gửi qua gateway). `importlib`/`__import__`
  động: ngoài phạm vi, ghi giới hạn trong docstring.
  - Boundary: `data/data_flow_map.json`, `scripts/dpia_draft.py` (phần
    load_map/egress_modules), `tests/test_data_flow_map.py`
  - Gate: `tests/test_data_flow_map.py`: `load_map` repo pass; mỗi lỗi
    validate (≥5 case) raise; `egress_modules(ROOT)` ⊇ {`connectors/
    zalo.py`, `crawler/collect.py`, `pipelines/llm_gateway.py`,
    `scripts/health_bulletin.py`, `scripts/zalo_mock.py`, `scripts/
    zalo_preflight.py`, `api/rag.py`, `pipelines/content.py`,
    `ingest/embed_store.py`} (chống scanner rỗng) và MỌI phần tử nằm trong
    `modules` của ≥1 flow; `egress_modules(ROOT)` KHÔNG chứa 3 script
    mới (`review_load`, `dpia_draft`, `contract_check`); mọi flow bắt
    buộc ở trên có mặt (tra theo module); tmp_path tree: `pkg/a.py`
    `import requests`, `pkg/b.py` lười `def f(): import httpx`,
    `pkg/c.py` `from urllib import request`, `pkg/d.py` `from
    urllib.parse import urljoin`, `pkg/e.py` `import socket` → kết quả
    = {a,b,c} đúng, d/e không có. MUTATION trên repo thật: tạo
    `scripts/_mut_egress.py` chứa `import requests` → `python -m pytest
    tests/test_data_flow_map.py -q` ĐỎ, message nêu
    `scripts/_mut_egress.py`; xoá file → xanh (ghi cả 2 output vào
    evidence; `git status` sau đó không còn file mutation).
  - Evidence: `evidence/v44_dpia.log`
  - Kết quả: egress_modules(ROOT) = đúng 9 module đã biết, 0 module chưa khai báo; mutation `scripts/_mut_egress.py` → 1 failed nêu tên module, xoá → 32 passed. Phát hiện khi rà code: `_uhash` là sha256 KHÔNG muối (bút danh, dò ngược được user_id số), `zalo_seen.db` lưu `follow:<user_id>` thô 7 ngày, `_mask_pii` chỉ che SĐT/email (không địa chỉ/mã đơn/tên) — đã ghi vào `gaps` của map (không sửa code ngoài boundary).
- [x] **W44.3 PC-A5 DPIA/TIA nháp + form đồng ý** — `scripts/dpia_draft.py`
  `render_dpia(m) -> str`, `render_tia(m) -> str`, `main()`: đọc map →
  ghi `docs/legal/DPIA-nhap.md` + `docs/legal/TIA-nhap.md` TẤT ĐỊNH (không
  timestamp chạy — ngày lấy `m["version"]`, chạy 2 lần byte-y-hệt);
  `--out-dir` (mặc định `docs/legal`); `--check` = không ghi, so nội dung
  sinh với file trên đĩa → lệch/thiếu exit 1 ("chạy lại dpia_draft");
  map hỏng → `[err]` exit 2, KHÔNG ghi file nào (validate trước khi
  ghi). DPIA: khối NHÁP đầu file ("chờ Chuyên viên Pháp chế ký, luật sư
  rà — agent không kết luận tuân thủ"), 1 Bên kiểm soát/xử lý
  (`{{ten_cong_ty}}`, `{{nguoi_phu_trach_dlcn}}` để trống), 2 Mô tả từng
  hoạt động xử lý — MỖI flow 1 mục có `id`, mục đích, dữ liệu, lớp, chủ
  thể, nơi lưu, retention, bên nhận, xuyên biên giới, biện pháp, căn cứ,
  gap; 3 Đánh giá rủi ro (Đỏ → cao, Vàng → trung bình, Xanh → thấp — quy
  tắc cố định, ghi "mức đề xuất, Pháp chế chốt"); 4 Tổng hợp GAP (gom
  `gaps` mọi flow; tối thiểu: chưa có cơ chế đồng ý/bảng consent, leads
  không hạn lưu, tên đứng tự do lọt mask = rủi ro tồn dư); 5 Câu hỏi cho
  luật sư (NĐ 356/2025 thay NĐ 13/2023 — mẫu hồ sơ; ân hạn 5 năm DN nhỏ
  khi có dữ liệu sức khỏe; mốc 72h báo sự cố "căn cứ chưa xác minh";
  Zalo/VNG là bên xử lý hay bên nhận); 6 Ký (trống). TIA: chỉ flow
  `cross_border` true — bên nhận/nước, dữ liệu gửi đi SAU biện pháp,
  biện pháp kỹ thuật, rủi ro tồn dư, căn cứ (Luật 91/2025 — "CẦN LUẬT SƯ
  XÁC NHẬN"); liệt kê flow không xuyên biên giới ở 1 dòng "không thuộc
  TIA". `docs/legal/form-dong-y-NHAP.md`: 3 mục đích TÁCH RIÊNG (không
  gộp 1 ô đồng ý): CSKH qua chatbot (Zalo/web — câu hỏi được che SĐT/
  email/địa chỉ rồi gửi nhà cung cấp AI ở nước ngoài; câu hỏi sức khỏe
  chuyển người, không gửi AI — khớp `is_health_question`), marketing
  (opt-in riêng, mặc định KHÔNG), đại lý/KOC (liên hệ đối tác); mỗi mục:
  dữ liệu, mục đích, bên nhận, chuyển ra nước ngoài, thời hạn lưu (khớp
  map), quyền chủ thể (rút đồng ý, xem, xoá), cách rút,
  `{{policy_version}}`; ghi rõ "chưa gắn kênh — chờ cơ chế consent (Hạ
  tầng)".
  - Boundary: `scripts/dpia_draft.py`, `docs/legal/DPIA-nhap.md`,
    `docs/legal/TIA-nhap.md`, `docs/legal/form-dong-y-NHAP.md`,
    `tests/test_dpia_draft.py`
  - Gate: `python scripts/dpia_draft.py` exit 0 ra 2 file; chạy lần 2 →
    `sha256sum` 2 file không đổi; `python scripts/dpia_draft.py --check`
    exit 0; sửa tay 1 dòng DPIA → `--check` exit 1 (rồi sinh lại).
    `tests/test_dpia_draft.py`: MỌI `flow.id` của map xuất hiện trong
    DPIA (word-boundary `(?<!\w)DF-xx(?!\w)` — gotcha v2.3); MỌI flow
    `cross_border` true có trong phần đánh giá chuyển giao của TIA, flow
    false KHÔNG nằm trong phần đó; thêm 1 flow giả vào map tmp → render
    có id đó (không hardcode danh sách); map tmp lỗi → exit 2 và
    `--out-dir` tmp không có file nào; `--check` trên repo exit 0
    (docs đồng bộ map); DPIA/TIA chứa "NHÁP" + ≥3 lần "CẦN LUẬT SƯ XÁC
    NHẬN"; không chứa "đã tuân thủ"; ô ký còn `{{`; form đồng ý có đủ 3
    mục đích, mỗi mục có "rút đồng ý", retention CSKH chứa
    `f"{RETAIN_DAYS} ngày"` (import `connectors.zalo.RETAIN_DAYS`, không
    hardcode), `pipelines.pii._PII_RE` không trúng chuỗi nào ngoài
    placeholder `{{...}}` (không SĐT/email thật).
  - Evidence: `evidence/v44_dpia.log`
  - Kết quả: 2 lần chạy sha256 y hệt; `--check` 0 → sửa tay 1 dòng → 1 → sinh lại → 0; `--check` chịu CRLF (checkout core.autocrlf=true) nhưng vẫn bắt lệch nội dung (test). 15 DF trong DPIA, TIA mục 2 = 5 luồng cross_border (DF-06/07/08/09/12), 'CẦN LUẬT SƯ XÁC NHẬN' DPIA 13 / TIA 8. Form đồng ý: lệch có chủ đích so contract — ghi 'che SĐT và email' (KHÔNG ghi 'địa chỉ') vì `_mask_pii` thật chỉ che SĐT/email; tên/địa chỉ tự do ghi rõ CHƯA che. Pháp chế ký/luật sư rà: external-dep `[ ]`.
- [x] **W44.4 PC-A6 hợp đồng mẫu KOC/đại lý + contract_check** —
  `docs/legal/mau-hop-dong-koc-NHAP.md`, `docs/legal/mau-hop-dong-dai-ly-
  NHAP.md` (khối NHÁP "chờ luật sư rà/Pháp chế duyệt", đối tác/giá/SKU là
  `{{...}}`, phụ lục SKU được phép "chỉ SKU mức QC_DAY_DU hoặc TP_THUONG
  không claim, KHÔNG rượu" — danh sách SKU thật để trống chờ
  `sku_readiness`). Điều khoản bắt buộc (mỗi điều 1 đoạn riêng):
  CHUNG 8 — `nhan_quang_cao` (gắn nhãn "quảng cáo"/"hợp tác" + nhãn nội
  dung AI), `go_24h` (gỡ/ẩn trong 24 giờ khi nhận yêu cầu), `sku_duoc_phep`
  (chỉ SKU trong phụ lục, đúng maket đóng băng), `cam_claim_suc_khoe`
  (cấm nói chữa/điều trị/khỏi bệnh/claim ngoài nội dung XNQC + bắt buộc
  câu khuyến cáo "không phải là thuốc"), `cam_ruou` (cấm quảng cáo,
  khuyến mại rượu — Luật 44/2019 Đ5), `bao_ve_dlcn` (không thu/dùng dữ
  liệu cá nhân khách ngoài mục đích, Luật 91/2025), `gia_toi_thieu`,
  `cham_dut` (chấm dứt/đơn phương khi vi phạm); KOC thêm
  `nghia_vu_nguoi_chuyen_tai` (kiểm tài liệu, đã dùng sản phẩm — "chưa
  xác minh, luật sư rà"); đại lý thêm `cam_shop_trung_ten`.
  `scripts/contract_check.py --kind koc|dai_ly --file <.md|.txt>`: luật
  thuần (KHÔNG LLM) — `CLAUSES: dict[id, (nhãn, [nhóm regex])]`, điều
  khoản "có" khi CÓ 1 đoạn (tách theo dòng trống) mà MỌI nhóm regex đều
  trúng, so trên text đã bỏ dấu + lower (tái dùng
  `pipelines.llm_gateway._strip_accents`) — vd `cam_ruou` = đoạn có
  (`ruou`) VÀ (`cam|khong duoc`) VÀ (`quang cao|khuyen mai`); hàm thuần
  `missing_clauses(text, kind) -> list[str]`. Exit 0 đủ ("đủ điều khoản
  bắt buộc theo kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư"),
  1 thiếu (in id + nhãn từng điều thiếu), 2 usage (file không tồn tại /
  0 byte / chỉ trắng / đuôi khác .md|.txt / không UTF-8 / > 1MB / kind
  sai). KHÔNG in nội dung file (hợp đồng có thể chứa dữ liệu đối tác).
  Lưu ý: file mẫu chứa chính từ cấm ("chữa", "điều trị", "thuốc") trong
  điều khoản CẤM — đây là văn bản pháp lý nội bộ, KHÔNG đi qua
  `guardrail.check()`/không đăng; không đưa `docs/legal/` vào ingest KB.
  - Boundary: 2 file mẫu trên, `scripts/contract_check.py`,
    `tests/test_contract_check.py`
  - Gate: `python scripts/contract_check.py --kind koc --file docs/legal/
    mau-hop-dong-koc-NHAP.md` exit 0, tương tự `dai_ly`; test
    parametrize TỪNG id điều khoản × 2 kind: xoá đoạn chứa điều đó khỏi
    mẫu → `missing_clauses` == [đúng id đó] và CLI exit 1 in đúng id;
    negative: "Phụ lục: Rượu sâm 500ml" đứng riêng không thỏa `cam_ruou`,
    từ khóa các nhóm nằm ở 2 đoạn khác nhau không thỏa; biến thể không
    dấu vẫn bắt; 6 case usage exit 2; stdout không chứa chuỗi đặc trưng
    của file test (không echo nội dung); `contract_check` không nằm
    trong `egress_modules(ROOT)`.
  - Evidence: `evidence/v44_contract.log`
  - Kết quả: 2 mẫu exit 0 (đủ 9 điều/loại); test xoá TỪNG điều × 2 loại (18 case) → đúng 1 id thiếu + CLI exit 1; mỗi điều khoản đúng 1 đoạn; âm tính 'Rượu sâm 500ml'/tách 2 đoạn/'cam kết'/'chưa'; không dấu + CRLF vẫn bắt; 6 usage exit 2; không echo nội dung. Luật sư xác nhận mẫu: external-dep `[ ]`.
- [x] **W44.5 PC-A7 JD + KPI 2 người vận hành** — `docs/handover/jd-kpi-
  van-hanh.md`: khối "NHÁP — chờ TGĐ duyệt (lương công ty trả riêng, ngoài
  1 tỷ)"; Quản lý hạ tầng AI (15 triệu/tháng, vai trò `ha_tang` trong
  `pipelines/auth.py`): vận hành gateway/mask PII, DB/backup/cron/secret,
  thực thi gỡ web khi có lệnh, báo sự cố dữ liệu trong 1 giờ; Quản lý MXH
  –sàn (10 triệu/tháng, vai trò `mxh`): chỉ đăng bản đã approve, gắn nhãn
  AI + nhãn quảng cáo, nạp file sàn, tuyến 1 trực GỠ/ẨN theo ủy quyền
  văn bản — ghi rõ CẤM đăng/sửa/approve thay người duyệt. Bảng KPI mỗi
  người: cột Chỉ tiêu | Ngưỡng | Nguồn đo (lệnh/bảng THẬT) — vd hạ tầng:
  bản tin `python scripts/health_bulletin.py` 0 mục đỏ, job 24h
  (`job_runs`), eval `python scripts/agent_eval.py --agent guardrail`
  PASS (`eval_runs`), backup + diễn tập khôi phục `python scripts/
  db_backup.py` / `python scripts/db_restore_drill.py`, chi phí AI ≤ trần
  (`llm_usage`); MXH: hàng duyệt `python scripts/review_load.py` không
  QUÁ TẢI do tồn đăng, lịch đăng `python -m pipelines.store --calendar`,
  cảnh báo sàn `python -m ingest.market_csv --report` (`market_alerts`
  S1 đóng trong ngày), 0 bài đăng lệch bản approve (`approvals` sha256 /
  `verify_publish`). KPI chưa có công cụ đo (ticket gỡ 24h, % hậu kiểm ủy
  quyền, bài kiểm tra tuân thủ ≥20 câu) ghi nguyên cụm "CHƯA ĐO ĐƯỢC" +
  WP sẽ build — không bịa nguồn.
  - Boundary: `docs/handover/jd-kpi-van-hanh.md`, `tests/test_legal_docs.py`
  - Gate: `tests/test_legal_docs.py`: (a) mọi `docs/legal/*.md` (≥6 file)
    chứa "NHÁP" trong 15 dòng đầu và không chứa "đã tuân thủ"; (b)
    jd-kpi: chứa "NHÁP", "15 triệu", "10 triệu", "GỠ/ẨN", cụm cấm
    "approve"; mọi `scripts/\w+\.py` và `python -m <mod>` nhắc tới tồn tại
    file thật; mọi tên bảng trong cột Nguồn đo (backtick) có trong
    `docs/schema.sql` (`create table if not exists <t>`); mỗi dòng bảng
    KPI có lệnh/bảng thật HOẶC "CHƯA ĐO ĐƯỢC" (dòng rỗng nguồn → đỏ);
    vai trò `ha_tang`/`mxh` có trong `pipelines.auth` (import, không
    hardcode). Spot-check tay ≥3 lệnh KPI chạy được (`--help` exit 0).
  - Evidence: `evidence/v44_docs.log`
  - Kết quả: `tests/test_legal_docs.py` 12 passed (≥6 file docs/legal có NHÁP 15 dòng đầu; 14 dòng KPI, 4 dòng CHƯA ĐO ĐƯỢC; lệnh/bảng nguồn đo tồn tại). Spot-check `--help` exit 0: health_bulletin, agent_eval, db_restore_drill, review_load, dpia_draft, `-m pipelines.store`, `-m ingest.market_csv` (db_backup không có argparse — không spot-check). Bản tin sức khỏe không có khái niệm 'mục đỏ' → KPI ghi '0 mục CẢNH BÁO/ĐÃ CHẶN'. TGĐ duyệt JD/KPI/lương: external-dep `[ ]`.
- [x] **W44.6 Gate chung** — không đụng file ngoài boundary các mục trên
  (KHÔNG sửa AGENTS.md/kien-truc.md/schema.sql — version không thêm
  bảng; lệnh mới nằm ở docstring + jd-kpi).
  - Boundary: (tổng hợp W44.1–W44.5)
  - Gate: targeted xanh ×3 TUẦN TỰ (`python -m pytest -q
    tests/test_review_load.py tests/test_data_flow_map.py
    tests/test_dpia_draft.py tests/test_contract_check.py
    tests/test_legal_docs.py`, đọc output tới exit mới chạy lần kế; 0
    skipped — DB thật có `DATABASE_URL`); full `python -m pytest -q`
    ĐÚNG 1 lần: xanh, ≥ 831 + số test mới, 0 failed; `ruff check .`
    sạch; `python -m py_compile scripts/review_load.py
    scripts/dpia_draft.py scripts/contract_check.py`; `python
    scripts/dpia_draft.py --check` exit 0; `grep -rn "đã tuân thủ"
    docs/legal` rỗng; `git status --short` chỉ gồm file trong boundary
    (không còn `scripts/_mut_egress.py`, không file lạ); evidence `.log`
    `git add -f` (gitignore `*.log`). Ghi "coordinator self-review" nếu
    không spawn được auditor lạ.
  - Evidence: `evidence/v44_pytest.log`
  - Kết quả (worker self-check, chưa có auditor lạ): targeted ×3 tuần tự 128 passed ×3, 0 skipped; full `python -m pytest -q` 1 lần 959 passed (831 + 128), 0 failed/skipped; ruff sạch; py_compile ok; `dpia_draft --check` exit 0; grep 'đã tuân thủ' rỗng; không còn `_mut_egress.py`. Lệch boundary: thêm `docs/legal/README.md` (mục lục NHÁP) để đạt sàn ≥6 file docs/legal của gate W44.5(a). Evidence `.log` cần `git add -f`.
  - Vòng fix nghiệm thu 1 (5 MINOR): (a) contract_check "cấm" so trên text CÒN dấu (`cấm|không được`), fallback `cam` chỉ khi đoạn gõ không dấu + loại "cảm nhận/cảm ơn/phản cảm..." → test `test_cam_not_confused_with_cam_accentless` (10 case) + `test_cam_positive_forms` (7); nhãn AI khớp `AI` phân biệt hoa thường (không ăn đại từ "ai") → `test_ai_label_not_pronoun_ai`. (b) dpia_draft `_is_egress` gateway FAIL-CLOSED: `import pipelines.llm_gateway [as g]`, `from pipelines import llm_gateway`, tương đối, mọi tên ngoài allowlist `GATEWAY_SAFE` (`_client`/`_call`/`*`...) đều tính → `test_gateway_import_forms_are_egress` (12) + `test_gateway_safe_imports_not_egress` (7) + 3 file mới trong `test_egress_scanner_tmp_tree`. (c) test_review_load: fixture ép `set local timezone = 'UTC'` (DB dev là Asia/Bangkok +7 → bỏ `at time zone` vẫn pass ảo) + draft biên 05/10 16:30Z/17:30Z + mục cũ nhất 07/10 17:30Z. Mutation trong bộ nhớ (cam_old/ai_old/egress_old/inflow/queue/throughput) đều ĐỎ; targeted ×3 165 passed; full 996 passed (831 + 165); ruff sạch. Evidence `evidence/v44_fix1.log`, `evidence/v44_fix1_full.log`.

v4.4-phap-che-dpo đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 5 MINOR — contract_check
nhầm 'cảm'↔'cấm' khi bỏ dấu và đại từ 'ai' thành nhãn AI; drift-guard egress
bỏ sót dạng import gateway khác → fail-closed — 1 vòng sửa → PASS;
coordinator chạy lại targeted 173 + ruff + `dpia_draft --check`; full pytest
chạy lúc gộp). Phát hiện khi rà, ghi vào gaps/DPIA (chưa vá): `_uhash` sha256
không muối (user_id Zalo dò ngược được); `zalo_seen.db` giữ `follow:<user_id>`
thô 7 ngày; `_mask_pii` không che tên/địa chỉ/mã đơn; chưa có bảng `consent`.
External-dep: Pháp chế/luật sư ký DPIA/TIA + 2 hợp đồng mẫu; quota duyệt thật;
TGĐ duyệt JD/KPI.

## Checklist v7.3-gia-lap-kich-ban

Khán giả/mục đích: WP09 (pmo.md dòng `| WP09`) — phần "Persona Simulation
(gộp MKT-08)" + "Season Forecast (engine kịch bản chung với KD-A10, SX-A3,
FP-Cash)"; worktree `D:\code\samsam-w73`. Hiện repo chưa có gì tính kịch
bản mùa: mỗi agent sau (KD-A10 dự báo mùa, SX-A3 phân bổ tồn Tết trước
10/12, FP-Cash 13 tuần × 3 kịch bản) sẽ tự viết lại công thức nếu không có
engine chung. Sau version: (a) `pipelines/scenario.py` THUẦN (không DB,
không LLM, không mạng) nhận baseline SKU×kênh×tuần + hệ số mùa 11.11 /
12.12 / Tết Âm lịch 2027 (06/02/2027) + 3 mức thấp/cơ sở/cao từ
`data/scenario_assumptions.json` → trả KHOẢNG (thấp ≤ cơ sở ≤ cao) từng tuần,
không bao giờ 1 con số; rượu = 0 mọi kênh online; kênh online ngoài
`allowed_channels` golden = 0 kèm ghi chú; CLI `python -m pipelines.scenario`
in bảng. Các version sau GỌI LẠI `project()` — không viết lại. (b)
`scripts/persona_sim.py`: nghiên cứu giả lập trên persona TỔNG HỢP (không
dữ liệu khách thật), ma trận 3 model × 3 prompt × ≥5 lần lặp qua
`pipelines.llm_gateway.chat` (agent_id `persona_sim`, cap tháng), có 1
phương án ĐỐI CHỨNG cố tình yếu, kết quả dạng khoảng p10/p50/p90 + độ phân
tán, mọi output LLM qua `guardrail.check()`, mỗi lời gọi × phương án = 1
dòng bảng mới `sim_runs`. Cổng DPIA: `data/sim_config.json`
`"dpia_signed": false` → từ chối chạy thật (exit 2), chỉ `--dry-run` với
gateway giả (không gọi `llm_gateway`) được chạy. Agent KHÔNG đặt hàng,
không đổi giá, không ghi `orders`/`products`/golden, không chi tiền.

Quy ước: ponytail — stdlib (`datetime`, `json`, `statistics.quantiles`,
`hashlib`, `random`, `uuid`) + `psycopg` sẵn có; KHÔNG pandas/numpy mới,
KHÔNG lib âm lịch (Tết lấy từ bảng hằng `TET_DATES` có nguồn ghi comment:
2026-02-17, 2027-02-06, 2028-01-26; năm ngoài bảng → lỗi rõ, không đoán).
Tuần = tuần bắt đầu thứ Hai (`week_start(d) = d - timedelta(d.weekday())`);
tuần Tết 2027 = tuần bắt đầu 2027-02-01. TÁI DÙNG: `ingest.golden_store.
read_golden`/`validate`/`CHANNELS`/`CATEGORIES` (đọc file golden, không
connect), `pipelines.llm_gateway.chat` (kill-switch + cap + mask PII),
`pipelines.guardrail.check`, `pipelines.kb_filter.is_alcohol`,
`pipelines.pii._mask_pii`, mẫu `prompt_version()` của
`scripts/agent_eval.py` (sha256 CRLF→LF, 12 hex). Engine nhận `start: date`
làm THAM SỐ — hàm thuần không đọc đồng hồ; chỉ CLI tính "thứ Hai tuần này"
theo giờ VN (UTC+7) khi thiếu `--start`. Test thuần không wall-clock, không
`time.sleep`. Config hỏng phải fail-closed với ĐỦ biến thể "không có dữ
liệu" (gotcha v1.8): file thiếu / rỗng / JSON hỏng / `{}` / chỉ `_doc` →
lỗi rõ, exit 1, không bao giờ trả 0 câm. Số trong config: `bool` không tính
là số, âm/NaN/inf bị từ chối. Thiếu baseline cho SKU×kênh được phép → lỗi
(không coi = 0). Print tiếng Việt → UTF-8 guard sau imports (copy
`scripts/zalo_mock.py`). Mọi `psycopg.connect` có `connect_timeout`; ghi
`sim_runs` = 1 transaction + `conn.commit()` tường minh (gotcha v2.1). Lỗi
chỉ nêu id/tên field, KHÔNG in giá trị ô persona/phương án. Không file
runtime mới trong `data/` (báo cáo in stdout; nếu thêm file output thì
gitignore ngay). Schema chỉ THÊM (`create table if not exists`), không sửa
bảng cũ, không assert đếm cứng số bảng.

External-dep (KHÔNG giả lập, để `[ ]` ở mục riêng cuối): (1) số bán THẬT
theo SKU×kênh×tuần + số đại lý theo tháng (GĐ bán hàng cung cấp) — baseline
hiện là fixture GIẢ ĐỊNH; (2) GĐ KD/Tài chính chốt hệ số mùa + 3 mức kịch
bản (file ghi `"status": "GIẢ ĐỊNH — chờ GĐ KD/Tài chính chốt"` tới khi có
người thật chốt — version này KHÔNG đổi status); (3) DPIA/TIA ký (Pháp chế +
TGĐ) → chỉ NGƯỜI thật đổi `dpia_signed` sang `true`, version này giữ
`false`; (4) chọn 3 model khác nhà cung cấp (Gemini Flash, Claude Haiku)
cần mở `provider_only` + giá trong `data/llm_gateway.json` — chờ hạ tầng/
Pháp chế chốt ZDR; config hiện liệt kê 3 model dưới `provider_only` sẵn có
và ghi rõ "ứng viên, chưa kiểm khả dụng/giá"; (5) Quản lý MXH duyệt báo cáo
persona; (6) `trends_weekly`/`forecast_scenarios` + role DB `sim_runner`
(INSERT `sim_runs`) trên cloud — version sau (KD-A10/Season Forecast).

- [x] **W73.1 Engine kịch bản thuần + giả định mùa** —
  `data/scenario_assumptions.json`: `{"_doc": "... GIẢ ĐỊNH — chờ GĐ KD/
  Tài chính chốt ... baseline là fixture, không phải số bán thật ...",
  "status": "GIẢ ĐỊNH — chờ GĐ KD/Tài chính chốt", "trend": {"low", "base",
  "high"}, "baseline_units_per_week": {sku_key: {channel: số ≥ 0}},
  "events": [{"id": "11.11", "date": "2026-11-11", "window": [{"offset":
  int, "low", "base", "high"}...]}, {"id": "12.12", "date": "2026-12-12",
  ...}, {"id": "tet_2027", "lunar_new_year": 2027, "window": [offset -6..+1
  — mua quà trước Tết, tuần Tết thấp]}]}` (offset tính theo tuần chứa ngày
  sự kiện). `pipelines/scenario.py` API công khai (version sau gọi lại):
  `LEVELS = ("low","base","high")`, `OFFLINE = "offline"` (đại lý/cửa
  hàng), `TET_DATES`, `tet_date(year) -> date`, `week_start(d) -> date`,
  `load_assumptions(path=None) -> dict` (validate, raise `ScenarioError`),
  `project(sku: dict, channel: str, start: date, weeks: int, assumptions:
  dict) -> list[dict]` — mỗi phần tử `{"week_start": date, "events":
  [id...], "low": int, "base": int, "high": int, "note": str|None}`. Công
  thức: `baseline[sku][channel] × trend[level] × max(hệ số sự kiện[level]
  của các sự kiện phủ tuần đó, mặc định 1)` — sự kiện chồng nhau lấy MAX
  (không nhân chồng), làm tròn BẤT ĐỐI XỨNG sau `round(x, 6)` khử nhiễu
  float: thấp = `floor`, cơ sở = `floor(x+0.5)`, cao = `ceil` (đơn điệu →
  giữ thứ tự; baseline > 0 và trend thấp < cao ⇒ thấp < cao — baseline
  nhỏ 2-3 đơn vị/tuần không sập khoảng thành 1 điểm; sửa sau nghiệm thu).
  Event có `channels` tuỳ chọn (list ⊆ kênh hợp lệ, không rỗng/trùng;
  thiếu = mọi kênh) → chỉ áp kênh đó: 11.11/12.12 = ngày sale sàn → chỉ
  kênh online (golden `CHANNELS`), không nhân cầu đại lý `offline`; Tết
  áp mọi kênh. Validator chặn thêm: `lunar_new_year` không phải int
  (list/float/str), số khổng lồ (`10**400` → OverflowError), `|offset| >
  104`; `project` raise `ScenarioError` khi tích tràn `inf`.
  Validator bắt `low ≤ base ≤ high` ở `trend` VÀ mọi dòng `window` → mọi
  output bảo đảm thấp ≤ cơ sở ≤ cao. Luật kênh (đặt TRƯỚC tra baseline):
  `sku["category"] == "alcohol"` + kênh ∈ `golden_store.CHANNELS` (toàn bộ
  là kênh online) → 3 mức = 0, note "rượu: chỉ kênh offline" — BẤT KỂ
  `allowed_channels` (golden hiện vẫn ghi `["shopee"]` cho 2 SKU rượu = lệch
  đã biết v3.2); SKU không rượu + kênh online ∉ `allowed_channels` → 0 +
  note "kênh chưa có trong allowed_channels (golden)"; kênh `offline` được
  tính cho mọi SKU. Lỗi `ScenarioError`: kênh ∉ `CHANNELS + (OFFLINE,)`,
  `weeks` ∉ 1..104, thiếu baseline cho SKU×kênh được phép, event có cả
  `date` lẫn `lunar_new_year` hoặc thiếu cả hai, offset trùng, `tet_date`
  năm ngoài bảng. `start` không phải thứ Hai → chuẩn hóa về thứ Hai.
  Module KHÔNG import `psycopg`/`openai`/`httpx`/`requests`/`llm_gateway`
  trực tiếp và không đọc đồng hồ ngoài `main()`.
  - Boundary: `pipelines/scenario.py` (mới), `data/scenario_assumptions.json`
    (mới), `tests/test_scenario.py` (mới)
  - Gate: `python -m pytest -q tests/test_scenario.py` xanh, gồm tối thiểu:
    `tet_date(2027) == date(2027,2,6)` và `week_start(tet_date(2027)) ==
    date(2027,2,1)`; `project(..., start=date(2027,1,25), weeks=3)` → tuần
    2027-02-01 có `"tet_2027"` trong `events`; 11.11 rơi tuần 2026-11-09,
    12.12 rơi tuần 2026-12-07; property test trên MỌI SKU golden × MỌI kênh
    × start 2026-10-12, weeks 26 (kênh được phép): `low ≤ base ≤ high` mọi
    dòng + đủ 3 key; 2 SKU `category='alcohol'` × mọi kênh online → 0/0/0 +
    note rượu, × `offline` → > 0 ở tuần có baseline > 0; SKU không rượu ×
    kênh online ngoài `allowed_channels` (vd `saphraton-40v` có `[]`) → 0 +
    note; sự kiện chồng tuần → MAX không nhân; config biến thể: thiếu / rỗng
    / JSON hỏng / `{}` / chỉ `_doc` / `low>base` trong `trend` / `base>high`
    trong 1 dòng window / số âm / `true` thay số / `NaN` → `ScenarioError`;
    file repo thật `status` chứa "GIẢ ĐỊNH"; `grep -nE "^(import|from)
    (psycopg|openai|httpx|requests)|llm_gateway" pipelines/scenario.py` rỗng;
    `grep -n "time.sleep\|datetime.now\|date.today" tests/test_scenario.py`
    rỗng
  - Evidence: `evidence/v73_scenario.log`
- [x] **W73.2 CLI kịch bản** — `python -m pipelines.scenario --sku <sku_key>
  --channel <kênh> --weeks 13 [--start YYYY-MM-DD] [--json]` (`main(argv)
  -> int`): đọc golden qua `golden_store.read_golden(GOLDEN_FILE)` +
  `validate`, đọc `load_assumptions()`, in dòng đầu = `status` của file giả
  định + câu "Khoảng thấp/cơ sở/cao — KHÔNG phải doanh số cam kết", rồi
  bảng `tuần | sự kiện | thấp | cơ sở | cao | ghi chú` (13 dòng khi
  `--weeks 13`); `--json` in list JSON cùng schema `project()` (date ISO).
  Exit: 0 OK; 1 SKU không có trong golden / golden hỏng / config giả định
  hỏng / thiếu baseline (`[err] <lý do>` stderr, không traceback); 2 sai
  usage (argparse: thiếu `--sku`, `--weeks` không phải số, ngày sai định
  dạng). Không connect DB.
  - Boundary: `pipelines/scenario.py`, `tests/test_scenario.py`
  - Gate: test gọi `main([...])` + `capsys`: `--weeks 13 --start 2026-10-12`
    in đúng 13 dòng dữ liệu, có dòng "GIẢ ĐỊNH" + "KHÔNG phải doanh số cam
    kết"; `--json` parse được, đủ `low/base/high` mọi phần tử; SKU lạ → 1;
    `--weeks abc` → `SystemExit` 2; thực chạy `python -m pipelines.scenario
    --sku saphraton-20v --channel shopee --weeks 13 --start 2026-10-12`
    exit 0 và `python -m pipelines.scenario --sku ruou-sam-chai-thuy-tinh-
    500ml --channel shopee --weeks 13 --start 2026-10-12` in toàn 0 + note
    rượu (lưu output vào evidence); chạy trên console mặc định không
    `UnicodeEncodeError`
  - Evidence: `evidence/v73_scenario.log`
- [x] **W73.3 Schema `sim_runs`** — `docs/schema.sql` append block "v7.3
  nghiên cứu giả lập (WP09)" (comment tiếng Việt: persona TỔNG HỢP, không
  PII, không lưu văn bản LLM thô, mỗi dòng = 1 lời gọi × 1 phương án,
  dry_run tách khỏi chạy thật): `sim_runs` (`id bigint generated always as
  identity primary key`, `run_id text not null`, `dry_run boolean not
  null`, `run_date date not null`, `created_at timestamptz not null default
  now()`, `persona_set text not null`, `persona_set_hash text not null`,
  `model text not null`, `provider text not null`, `model_version text not
  null`, `prompt_id text not null`, `prompt_hash text not null`,
  `sample_idx int not null check (sample_idx >= 0)`, `temperature numeric
  not null`, `seed int not null`, `seed_supported boolean not null`,
  `option_id text not null`, `is_control boolean not null`, `score numeric
  check (score between 0 and 10)` (null = lời gọi parse lỗi/guardrail chặn),
  `parse_ok boolean not null`, `guardrail_ok boolean not null`, unique
  (`run_id`, `model`, `prompt_id`, `sample_idx`, `option_id`)) + index
  (`run_id`). Không cột tên/SĐT/email/order/user_hash/văn bản trả lời.
  `docs/handover/kien-truc.md`: thêm dòng bảng `sim_runs` vào bảng §3 và
  sửa "24 bảng public" → "25 bảng public".
  - Boundary: `docs/schema.sql` (chỉ append block mới),
    `docs/handover/kien-truc.md`
  - Gate: `python scripts/apply_schema.py` ×2 exit 0 trên DB riêng
    (`samsam_infra`); `grep -c "^create table if not exists"
    docs/schema.sql` = 25; `grep -niE "phone|email|order_id|user_hash|
    buyer|answer_text" ` trên block v7.3 không trúng; `python -m pytest -q
    tests/test_handover_docs.py` xanh (`test_kien_truc_lists_all_tables`
    thấy `sim_runs` + "25 bảng"); không sửa test đếm cứng nào
  - Evidence: `evidence/v73_persona.log`
- [x] **W73.4 Persona tổng hợp + cấu hình + kiểm đầu vào** —
  `data/personas.json`: `{"_doc": "Persona TỔNG HỢP — không dữ liệu khách
  thật, không bản ghi đơn lẻ; nguồn = giả định nhóm chờ số liệu đã ẩn
  danh + DPIA", "synthetic": true, "set_id": "v1", "personas": [6–10
  persona {id, label, age_min, age_max, region, sku_group, youth (bool),
  traits [chuỗi], source}]}` — mọi persona `age_min ≥ 18`.
  `data/sim_config.json`: `{"_doc": ..., "dpia_signed": false, "models":
  [3 × {id, seed_supported}] (ứng viên dưới provider_only hiện có, ghi
  "chưa kiểm khả dụng/giá"), "prompts": [3 × {id, text}], "repeats": 5,
  "temperature": số cố định, "base_seed": int, "options": [≥3 phương án
  {id, text, sku_keys, kind ∈ ("product","brand_theme")} + đúng 1 phương án
  `"control": true` cố tình yếu]}`. `scripts/persona_sim.py` hàm thuần
  `validate_inputs(cfg, personas_doc, golden) -> list[str]` (lỗi chỉ nêu
  id/field): `repeats < 5`, `< 3` model, `< 3` prompt, control ≠ 1, < 2
  phương án thường → lỗi; persona key ngoài allowlist (bắt `order_id`,
  `user_hash`, `phone`, `email`, `name`...) → lỗi; giá trị chuỗi mà
  `_mask_pii(v) != v` → lỗi; `synthetic` không phải `true` hoặc persona
  thiếu `source` → lỗi; số persona ∉ 6..10 → lỗi; phương án rượu
  (`kb_filter.is_alcohol(text)` hoặc SKU `category='alcohol'`) + có persona
  `age_min < 18` hoặc `youth` → lỗi; phương án rượu mà text nhắc giới trẻ
  ("gen z", "giới trẻ", "học sinh", "sinh viên", "tuổi teen" — so không
  dấu, biên từ) → lỗi; text phương án `guardrail.check()` không ok → lỗi;
  phương án tham chiếu SKU `tpbvsk` có `xnqc_status != "approved"` mà
  `kind != "brand_theme"` → lỗi. Có lỗi → `[err]` exit 1 TRƯỚC mọi lời gọi
  LLM và trước connect.
  - Boundary: `data/personas.json`, `data/sim_config.json`,
    `scripts/persona_sim.py`, `tests/test_persona_sim.py` (mới cả 4)
  - Gate: `python -m pytest -q tests/test_persona_sim.py -k validate` xanh,
    gồm: file repo thật → `[]`; mỗi biến thể lỗi trên (persona có
    `order_id`; persona có `user_hash`; giá trị chứa SĐT "0905123456";
    persona 17 tuổi + phương án rượu sâm; brief "thông điệp rượu sâm cho
    Gen Z"; phương án chứa từ cấm "chữa"; SKU TPBVSK chưa XNQC kind
    `product`; repeats 4; 2 model; 0 control; 2 control) → đúng 1+ lỗi và
    thông báo KHÔNG chứa giá trị ô (vd không chứa "0905123456");
    `json.load(data/sim_config.json)["dpia_signed"] is False` (drift-guard:
    version này không tự ký)
  - Evidence: `evidence/v73_persona.log`
- [x] **W73.5 Runner persona_sim: cổng DPIA, ma trận 3×3×5, đối chứng,
  sim_runs, báo cáo khoảng** — `scripts/persona_sim.py` `main(argv) ->
  int`, cờ `--dry-run`, `--config`, `--personas`. Thứ tự: đọc + validate
  (W73.4) → CỔNG DPIA: không `--dry-run` và `cfg["dpia_signed"] is not
  True` (thiếu key / `"true"` chuỗi / `false` đều tính chưa ký) → in
  `[refuse] DPIA chưa ký ... chỉ chạy --dry-run` exit 2, 0 lời gọi
  `llm_gateway`, 0 connect. `run_matrix(cfg, personas, options, chat_fn,
  run_date) -> (rows, n_calls)`: đúng 1 lời gọi `chat_fn` cho mỗi (model,
  prompt, sample_idx) — persona panel chấm TẤT CẢ phương án (kể cả đối
  chứng, thứ tự xáo theo seed) trả JSON `{option_id: điểm 0..10}`; seed =
  `base_seed + sample_idx`; temperature cố định từ config. Thật: `chat_fn`
  = `llm_gateway.chat("persona_sim", msgs, model=m, temperature=t,
  seed=s)`; `model_version = resp.model` (thiếu → id yêu cầu), `provider` =
  phần trước "/" của model. Dry-run: `chat_fn` giả tất định (`random.Random
  (seed)`, đối chứng điểm thấp) — KHÔNG import/gọi `llm_gateway.chat`.
  Mỗi phản hồi: text qua `guardrail.check()` — không ok → `guardrail_ok=
  false`, điểm null cho cả lời gọi; JSON hỏng/thiếu option/điểm ngoài 0..10
  → `parse_ok=false`, điểm null. `GatewayError`/`GatewayBlocked` (kill,
  vượt cap) → dừng, exit 1, 0 dòng ghi (không nạp nửa vời). Ghi: rows = số
  lời gọi × số phương án, `prompt_hash` = sha256 12 hex text prompt
  CRLF→LF, `persona_set_hash` = sha256 12 hex bytes personas.json,
  `run_date` = ngày VN truyền vào (test cố định), `dry_run` đúng cờ; 1
  `executemany` + `conn.commit()`, `connect_timeout`. `summarize(rows) ->
  dict`: mỗi phương án p10/p50/p90 (`statistics.quantiles(n=10,
  method="inclusive")`) + `spread = p90 - p10` + `n_valid`; `control_last_
  rate` = tỉ lệ lời gọi hợp lệ mà đối chứng điểm THẤP NHẤT tuyệt đối (hòa
  không tính); `< 0.8` hoặc `n_valid` < một nửa số lời gọi → cờ "KHÔNG
  DÙNG ĐƯỢC". Báo cáo in stdout: bảng khoảng (không in 1 con số đơn lẻ),
  dòng "KHÔNG phải dự báo doanh số", câu giới hạn WEIRD/mô hình ngôn ngữ,
  dry-run thêm nhãn "DRY-RUN — số giả"; toàn văn báo cáo qua
  `guardrail.check()` trước khi in. `data/llm_gateway.json` thêm
  `"persona_sim"` vào `monthly_cap_usd` (ước tính, ghi chú chờ công ty chốt).
  - Boundary: `scripts/persona_sim.py`, `tests/test_persona_sim.py`,
    `data/llm_gateway.json` (chỉ thêm 1 key cap)
  - Gate: `python -m pytest -q tests/test_persona_sim.py` xanh, 0 skipped,
    gồm: (a) `dpia_signed` false / thiếu / `"true"` + không dry-run → exit 2,
    `llm_gateway.chat` (monkeypatch raise) không bị gọi, `connect` không bị
    gọi; (b) dry-run với config repo (3 model × 3 prompt × 5 lần, 3 phương
    án + 1 đối chứng) → `n_calls == 45` (đếm bằng fake chat_fn) và 180
    dòng; mọi dòng `model`, `provider`, `model_version`, `prompt_id`,
    `prompt_hash`, `seed`, `seed_supported`, `run_date`, `persona_set_hash`
    not null; tập `(model, prompt_id, sample_idx)` đủ 45 tổ hợp; mỗi lời gọi
    có đúng 1 dòng `is_control`; (c) `dpia_signed=true` (monkeypatch config)
    + fake `gw.chat` → mỗi lời gọi nhận `agent_id == "persona_sim"`, đúng
    model, cùng temperature, seed = base_seed + i; (d) fake trả text chứa
    từ cấm → `guardrail_ok=false`, điểm null, báo cáo vẫn in khoảng từ lời
    gọi hợp lệ; JSON hỏng → `parse_ok=false`; (e) `GatewayBlocked` giữa
    chừng → exit 1, 0 dòng ghi; (f) `summarize`: p10 ≤ p50 ≤ p90 mọi phương
    án, `control_last_rate` tính đúng trên dữ liệu tay (có hòa), < 0.8 →
    cờ "KHÔNG DÙNG ĐƯỢC"; (g) DB thật: schema tạm + `set local search_path`
    + chạy `docs/schema.sql` + ROLLBACK (mẫu fixture `db` của
    `tests/test_golden_store.py`) — dry-run ghi 180 dòng `sim_runs`,
    `select count(*) ... where model_version is null or provider is null
    or prompt_hash is null` = 0, unique chặn ghi trùng run_id; (h)
    `grep -n "connect(" scripts/persona_sim.py` mọi dòng có
    `connect_timeout` (test_connect_timeout_guard xanh); thực chạy `python
    scripts/persona_sim.py` (không cờ) exit 2 + lý do DPIA, và `python
    scripts/persona_sim.py --dry-run` exit 0 trên DB riêng, in báo cáo có
    "DRY-RUN" + "KHÔNG phải dự báo doanh số" (lưu evidence, không
    `UnicodeEncodeError`)
  - Evidence: `evidence/v73_persona.log`
- [x] **W73.6 Docs vận hành** — `docs/handover/sop.md` thêm mục ngắn
  "Kịch bản mùa + nghiên cứu giả lập (v7.3)": lệnh `python -m
  pipelines.scenario --sku ... --channel ... --weeks 13`, cách đọc khoảng
  thấp/cơ sở/cao, file giả định + ai chốt, `python scripts/persona_sim.py
  --dry-run`, cổng DPIA (ai được đổi `dpia_signed`, exit 2 nghĩa là gì),
  nhãn "không phải dự báo doanh số", luật rượu/giới trẻ. `docs/handover/
  kien-truc.md` thêm 2 module (`pipelines/scenario.py` engine dùng chung
  cho KD-A10/SX-A3/FP-Cash; `scripts/persona_sim.py`) + human-gate (Quản lý
  MXH duyệt báo cáo; GĐ KD/TC chốt giả định; DPIA). `AGENTS.md` bảng
  Commands thêm 2 dòng (kịch bản, persona dry-run).
  - Boundary: `docs/handover/sop.md`, `docs/handover/kien-truc.md`,
    `AGENTS.md` (chỉ bảng Commands)
  - Gate: `grep -n "pipelines.scenario" docs/handover/sop.md AGENTS.md` và
    `grep -n "persona_sim" docs/handover/sop.md AGENTS.md docs/handover/
    kien-truc.md` đều trúng; spot-check: chạy đúng 2 lệnh trong sop.md ra
    exit như mô tả; `python -m pytest -q tests/test_handover_docs.py` xanh
  - Evidence: `evidence/v73_persona.log`
- [x] **W73.7 Gate chung** — targeted `python -m pytest -q
  tests/test_scenario.py tests/test_persona_sim.py tests/test_handover_docs.py
  tests/test_connect_timeout_guard.py` xanh ×3 liên tiếp (tuần tự, đọc tới
  exit mỗi lần); full `python -m pytest -q` xanh đúng 1 lần, ≥ 831 + số
  test mới, 0 failed, không skip mới so với baseline; `ruff check .`
  clean; `python -m py_compile pipelines/scenario.py scripts/persona_sim.py`
  exit 0; `git status --short` chỉ có file trong Boundary các mục trên
  (+ evidence), không file lạ trong `data/`.
  - Boundary: không file mới ngoài các mục trên
  - Gate: như trên; evidence `.log` thêm bằng `git add -f`
  - Evidence: `evidence/v73_pytest.log`
  - Kết quả (worker 2026-10-12): targeted ×3 = 102/102/102 pass; full vòng 1 FAIL 1 (`test_db_backup.py::test_cloud_readme_drift_guard` — `deploy/cloud/README.md` thiếu `sim_runs`) → dây chuyền: thêm dòng `sim_runs` + "24→25 bảng" trong `deploy/cloud/README.md` (ngoài Boundary, bắt buộc để full xanh); full vòng 2 = 923 passed, 0 skipped; ruff clean; py_compile 0. Phần B OWASP vá: cổng DPIA đọc cả file chuẩn `data/sim_config.json` (`--config` tự ghi true không mở được), parse JSON phản hồi O(n) + trần 20.000 ký tự, marker validate của engine không giả được bằng JSON.

External-dep (để `[ ]`, không treo version, KHÔNG giả lập):
- [ ] Số bán thật SKU×kênh×tuần + số đại lý theo tháng thay fixture baseline
  (GĐ bán hàng) — external-dep
- [ ] GĐ KD/Tài chính chốt hệ số mùa + 3 mức kịch bản, đổi `status` file
  giả định — external-dep
- [ ] DPIA/TIA ký → người thật đổi `dpia_signed: true`, chạy persona thật,
  Quản lý MXH duyệt báo cáo, TGĐ/BKS đồng ký biên bản — external-dep
- [ ] Mở `provider_only` + giá cho model Gemini Flash / Claude Haiku (ZDR)
  để ma trận thật đủ 3 nhà cung cấp — external-dep
- [ ] `trends_weekly`, `forecast_scenarios`, role DB `sim_runner` trên
  cloud; KD-A10/SX-A3/FP-Cash gọi `scenario.project()` — version sau

v7.3-gia-lap-kich-ban đóng 2026-10-12 (nghiệm thu đợt 1 FIX 5 → 2 vòng sửa →
PASS; vòng 2 bắt OverflowError ngày biên 0001/9999 → khóa 2000..2100; OWASP
worker vá: lách cổng DPIA bằng --config tự ghi dpia_signed:true, parse JSON
phản hồi LLM bậc 2, dấu `_validated` giả trong file giả định. Coordinator chạy
lại targeted 126 + ruff + persona_sim không cờ → exit 2 DPIA). Tết 2027 =
06/02/2027; rượu 0 mọi kênh online, thêm kênh `offline`. External-dep: số bán
thật cho baseline; GĐ KD/Tài chính chốt giả định; DPIA ký (chỉ người đổi
`dpia_signed`); mở provider cho model Gemini/Claude; role `sim_runner` trên
cloud. Điểm nối: KD-A10/SX-A3/FP-Cash gọi `pipelines.scenario.project()`.

## Checklist v9.3-vung-trong

Khán giả/mục đích: nhánh `ai-infra` (M31, worktree `D:\code\samsam-w93`)
— phần VT của WP13 (pmo.md dòng `| WP13`, tiêu chí: "Kiểm được hash chain
của plot_logs. sample:% = 0 sau khi GĐ vùng trồng ký … 100% ảnh trong bộ
tư liệu đã gỡ EXIF/GPS"); agent `farming` trong final_plans.json: "Agent GĐ
vùng trồng (điều phối)", "Số hóa hồ sơ khoảnh", "Nhật ký vườn (nâng cấp
agents/garden.py)", "Nhắc lịch & giám sát gap", "Kho tư liệu vườn". Hiện
trạng (đọc code): `plot_logs` (v1.8) UPDATE/DELETE tự do, sửa không ai phát
hiện; `ingest/core_store.py::apply_rows` `delete from plots where source =
'sample:sample_plots.jsonl'` → FK `on delete cascade` xóa luôn nhật ký
`manual:garden` trỏ khoảnh mẫu (someday v1.8 a); dữ liệu mẫu `sample:*` lẫn
dữ liệu thật, không có đường gỡ có người chịu trách nhiệm (và gỡ xong thì
`python -m ingest.core_store` nạp lại); nhắc gap chỉ chạy khi mở tab/
`--check`, không có lịch hoạt động định kỳ; không có chỗ nhận ảnh vườn (ảnh
điện thoại mang GPS = tọa độ khoảnh). Sau version: (a) mọi nhật ký KHÔNG
phải mẫu vào hash chain do trigger tính, sửa/xóa bị chặn, sửa lén (superuser
tắt trigger) bị `verify_plot_logs()` phát hiện; (b) loader không bao giờ xóa
dòng đã chain; (c) gỡ `sample:%` chỉ qua CLI có `--by` + ghi
`agent_action_log`, agent không tự gỡ; (d) danh sách nhắc gap/hoạt động trễ
tính bằng rule thuần trên `now` tham số; (e) ảnh vườn lưu ngoài repo theo
sha256, 0 EXIF/GPS, metadata trong bảng `garden_media`; (f) bản tin tuần tất
định (không LLM) cho GĐ vùng trồng.

Quy ước: ponytail — stdlib + `psycopg` + Pillow (12.0.0 ĐÃ có trong
interpreter; import LƯỜI trong hàm xử lý ảnh, thiếu → `[err]` exit 1 ghi
external-dep; thêm 1 dòng `Pillow>=10` + comment lý do vào
`requirements.txt`). KHÔNG LLM, KHÔNG gọi mạng, KHÔNG exiftool. Schema chỉ
THÊM vào `docs/schema.sql` (block "v9.3 vùng trồng", comment tiếng Việt):
`alter table plot_logs add column if not exists ...` (dạng DUY NHẤT được
drift-guard `\b(alter|drop)\s+table\b` cho phép), `create table if not
exists`, `create or replace function/trigger` + `revoke execute ... from
public` sau mỗi function; SECURITY DEFINER dùng `set search_path from
current` (mẫu v3.4). Hash canonical theo mẫu `action_log_row_hash` — epoch
micro giây, KHÔNG `ts::text` (không phụ thuộc `TimeZone`/`DateStyle`).
Chain chỉ READ COMMITTED + `pg_advisory_xact_lock(tg_relid::bigint)` + id
cấp SAU khi giữ khóa (y hệt `agent_action_log_chain`). Dòng `source like
'sample:%'` KHÔNG vào chain (plan: "genesis không chứa sample") → loader và
CLI gỡ mẫu xóa được. KHÔNG sửa `agents/garden.py`, `app/streamlit_app.py`,
`agents/report.py`, `pipelines/auth.py`, `docs/roles.sql`: `main` đã có
193c68d/95bd98b (flags_for quét chỉ detail, warn ts tương lai) chưa gộp vào
`ai-infra` — sửa cùng vùng = xung đột merge; `add_log` đi qua chain tự động
nhờ trigger (signature giữ nguyên → tab "Nhật ký vườn" giữ hoạt động). Code
mới quét keyword CHỈ trên detail: gọi `garden.flags_for("", detail)` (gotcha
flags_for AGENTS.md), không quét tên activity. Ngày "hôm nay"/cửa sổ tuần
theo giờ VN (UTC+7 cố định, precedent `VN_TZ`); mọi hàm thời gian nhận
`now`/`until` tham số — test KHÔNG wall-clock; `until` từ CLI là str →
coerce `date` TRƯỚC mọi format-spec (gotcha v2.2). Mọi connect qua
`ingest.lead_store.connect` (connect_timeout=3) hoặc `connect_timeout=`
tường minh; ghi trên conn = `with conn.transaction()` + `conn.commit()`
tường minh (gotcha savepoint v2.1). Print tiếng Việt → UTF-8 guard. CLI nhiều
op → đếm `n_ops`, `>1` hoặc `0` → `ap.error` exit 2 TRƯỚC connect (gotcha
v2.2). Output (bản tin, stdout, DB) KHÔNG chứa tọa độ/GPS, `location`,
`area_m2`; detail nhật ký in ra phải qua `pipelines.pii._mask_pii` + cắt 120
ký tự. Test DB thật: 1 transaction + temp schema (`create schema` + `set local
search_path to <tmp>, pg_temp` + `docs/schema.sql` ×2) rồi ROLLBACK
(fixture `db` mẫu `tests/test_golden_store.py`); hàm gọi `conn.commit()` →
bọc `_TxConn` (precedent v3.2); thử superuser tắt trigger bằng `set local
session_replication_role = replica` trong savepoint; gate yêu cầu 0 skipped.
KHÔNG gỡ mẫu / KHÔNG ghi `garden_media` / KHÔNG ghi `agent_action_log` trên
DB public ngoài test rollback (agent không tự gỡ, không giả người duyệt).
Mọi lệnh shell mở đầu bằng prefix nạp `w93.env` (DATABASE_URL = DB riêng
`samsam_infra`); không in giá trị env. Đếm bảng: KHÔNG assert hằng số mới
(sàn `>= 24` / đọc schema.sql).

External-dep (KHÔNG giả lập, KHÔNG tự đánh dấu): GĐ vùng trồng ký gỡ dữ
liệu mẫu (M1) — chỉ có CLI + precheck; lịch canh tác thật (data/
garden_schedule.json là GIẢ ĐỊNH); ảnh vườn thật; tọa độ khoảnh (không đưa
vào bất kỳ output nào); vai trò `gd_vung_trong` trong SSO/`pipelines/auth.py`
(`--by` hiện là tên khai báo, ghi vào `agent_action_log.actor`); neo hash
chain ra ngoài (email/OpenTimestamps — xóa dòng CUỐI chuỗi không phát hiện
được bằng chuỗi thuần); gửi bản tin/nhắc qua Zalo/email (bản tin chỉ ghi
file `data/reports/`).

- [x] **W93.1 Schema: hash chain `plot_logs` + bảng `garden_media`** —
  `docs/schema.sql` append block v9.3: `alter table plot_logs add column if
  not exists prev_hash text`, `... add column if not exists row_hash text`;
  `create unique index if not exists plot_logs_row_hash_idx on plot_logs
  (row_hash)` (null nhiều dòng OK). `plot_log_row_hash(p_prev text, p_id
  bigint, p_plot_id text, p_ts timestamptz, p_activity text, p_detail text,
  p_author text, p_source text, p_created_at timestamptz) returns text` =
  `encode(sha256(convert_to(p_prev || jsonb_build_array(p_id, p_plot_id,
  epoch_us(p_ts), p_activity, p_detail, p_author, p_source,
  epoch_us(p_created_at))::text,'UTF8')),'hex')` (epoch_us = `(extract(epoch
  from x)*1000000)::bigint`, inline). Trigger `before insert` `plot_logs_chain()`
  (SECURITY DEFINER): `source like 'sample:%'` → ép `prev_hash`/`row_hash` =
  null, return (KHÔNG khóa, không chain) — NHƯNG nếu đã có marker gỡ mẫu
  (`exists agent_action_log where action = 'garden_sample_purge'`) → raise
  "dữ liệu mẫu đã được gỡ"; còn lại: kiểm READ COMMITTED (raise nếu khác),
  `pg_advisory_xact_lock(tg_relid::bigint)`, cấp `new.id` từ sequence SAU
  khóa, ép `created_at = now()`, `prev_hash` = `row_hash` của dòng chained
  id lớn nhất (`row_hash is not null`) hoặc 64 `0`, tính `row_hash` — giá
  trị client gửi bị ghi đè. Guard `plot_logs_guard()`: `before update or
  delete for each row` → raise khi `old.row_hash is not null` (dòng
  mẫu/chưa chain vẫn sửa/xóa được — ghi comment); `before truncate for each
  statement` → raise nếu tồn tại dòng chained (chặn cả `truncate plots
  cascade`). FK cascade từ `delete from plots` kích trigger row → xóa khoảnh
  còn nhật ký chained bị chặn. Backfill legacy (do-block, idempotent): CHỈ
  khi chưa dòng nào có `row_hash` → giữ advisory lock, chain các dòng
  `source not like 'sample:%'` theo id tăng dần (giữ `created_at` cũ); có
  chain rồi → no-op. `verify_plot_logs() returns table(id bigint, problem
  text)` (SECURITY DEFINER, stable, revoke public): duyệt dòng `row_hash is
  not null OR source not like 'sample:%'` theo id — `prev_hash` (dòng trước
  bị xóa/chèn), `row_hash` (nội dung bị sửa), `unchained` (dòng không-mẫu
  thiếu hash: chèn khi trigger tắt); rỗng = nguyên vẹn. `garden_media` (`id
  bigint identity pk`, `sha256 text not null unique check (~
  '^[0-9a-f]{64}$')`, `ext text not null check in ('jpg','png')`, `bytes
  bigint not null check > 0`, `width int`, `height int`, `plot_id text not
  null references plots(id)` (no action — khoảnh có ảnh không bị xóa câm),
  `taken_on date not null`, `author text not null check (btrim <> '')`,
  `exif_removed int not null default 0`, `had_gps boolean not null default
  false`, `source text not null default 'cli:garden_media'`, `created_at
  timestamptz not null default now()`) + index (plot_id, taken_on). KHÔNG
  cột tọa độ/đường dẫn gốc/tên file gốc.
  - Boundary: `docs/schema.sql` (append block), `tests/test_garden_chain.py`
    (mới)
  - Gate: `python scripts/apply_schema.py` ×2 exit 0, lần 2 in "25 bảng
    public" có `garden_media`; `grep -c "^create table if not exists"
    docs/schema.sql` = 25; `python -m pytest -q -rs
    tests/test_garden_chain.py` xanh, 0 skipped, gồm: 3 insert
    `manual:garden` → verify rỗng, dòng đầu `prev_hash` = 64 `0`, dòng k
    `prev_hash` = `row_hash` dòng k-1; insert kèm `prev_hash`/`row_hash`/
    `created_at` giả → bị ghi đè; insert `sample:x` → hash null, không làm
    gãy chain; UPDATE/DELETE dòng chained (superuser, trigger bật) → lỗi;
    `delete from plots` khoảnh có log chained → lỗi; `truncate plot_logs`
    (có dòng chained) → lỗi; UPDATE/DELETE dòng `sample:x` → OK; replica
    UPDATE `detail` dòng 2 → verify ∋ (id2,`row_hash`); replica DELETE dòng
    2 → verify ∋ (id3,`prev_hash`); replica UPDATE dòng 2 `source='sample:x',
    row_hash=null, prev_hash=null` (giấu khỏi chain) → verify ∋ (id3,
    `prev_hash`); replica INSERT dòng `manual` → verify ∋ (id,`unchained`);
    verify rỗng dưới `set local timezone 'UTC'` và `'Asia/Ho_Chi_Minh'` +
    `datestyle 'SQL, DMY'`; `set transaction isolation level repeatable read`
    trong tx mới → insert manual raise; backfill: replica insert 2 dòng
    manual + 1 sample (chưa chain) → chạy lại schema.sql → verify rỗng, dòng
    sample vẫn null, chạy lần nữa → `row_hash` không đổi; insert `sample:x`
    sau khi có log `garden_sample_purge` → raise; `garden_media` sha sai
    định dạng / ext lạ / author rỗng → lỗi CHECK; `add_log` (agents/garden.py
    KHÔNG sửa) trên temp schema qua `_TxConn` → row có `row_hash` 64 hex
  - Evidence: `evidence/v93_chain.log`
  - Kết quả (worker, 2026-10-12): xong. Thêm 1 luật guard ngoài contract (rà OWASP A01/A08): UPDATE dòng chưa chain KHÔNG được đổi mẫu↔thật và KHÔNG gán hash cho dòng mẫu — chặn đường lách trigger không cần superuser (chèn `sample:x` với `created_at` giả → đổi source + tự tính hash thành đuôi chuỗi); test `test_guard_blocks_promoting_sample_to_chain`. 22 test, 0 skip.
- [x] **W93.2 Loader `core_store` không xóa dòng đã chain + không nạp lại mẫu
  sau gỡ** — `ingest/core_store.py::apply_rows`: pha delete `plots` thêm
  điều kiện `and not exists (select 1 from plot_logs l where l.plot_id =
  plots.id and l.row_hash is not null)`; pha insert `plots` thành `insert …
  on conflict (id) do update set <cột> = excluded.<cột>, updated_at = now()
  where plots.source = excluded.source` (khoảnh mẫu còn giữ vì có nhật ký
  chained được cập nhật tại chỗ; khoảnh `manual` trùng id KHÔNG bị đè);
  `plot_logs` mẫu vẫn delete-by-source (chưa chain). Trả thêm/in khoảnh bị
  giữ lại do có nhật ký chained (`[keep] plots: KV-.. (n nhật ký đã
  chain)`). `main()`: helper `sample_garden_purged(conn) -> bool` (exists
  `agent_action_log` action `garden_sample_purge`; bảng chưa có →
  `UndefinedTable` → False) → True thì BỎ domain `plots`/`plot_logs` nguồn
  `sample:*` khỏi `domains` (không delete, không insert) + in `[skip]`.
  `test_apply_rows_delete_by_source_then_insert` cũ giữ nguyên, xanh.
  - Boundary: `ingest/core_store.py`, `tests/test_core_store.py`,
    `tests/test_garden_chain.py`
  - Gate: test DB (temp schema, rollback): nạp domains mẫu (KV-A01..) →
    `add_log` 1 nhật ký `manual:garden` lên KV-A01 → `apply_rows` lại cùng
    domains (đổi `tree_count` KV-A01) → không exception; nhật ký chained còn
    nguyên (đúng id + `row_hash`), `tree_count` KV-A01 = giá trị mới, số
    dòng `sample:sample_plot_logs.jsonl` = như lần 1 (không nhân đôi),
    `verify_plot_logs()` rỗng; domains bỏ KV-A01 khỏi file mẫu → KV-A01
    vẫn còn + báo keep; plot `manual` trùng id với mẫu → giữ `source=
    'manual'` và giá trị cũ; sau insert log `garden_sample_purge` →
    `sample_garden_purged` True và domains lọc còn 0 entry plots/plot_logs
    `sample:*` (orders mẫu không bị ảnh hưởng); fake-conn test cũ xanh.
    `python -m ingest.core_store` trên DB riêng exit 0 ×2 (chạy SAU W93.1
    apply_schema), `--verify` (W93.6) sau đó rỗng
  - Evidence: `evidence/v93_chain.log`
  - Kết quả: xong. Lệch nhỏ so contract: báo keep tách hàm `kept_plots(conn, domains)` (main in `[keep] plots: ...`) thay vì nhét vào `apply_rows` — fake-conn test cũ `ops[6:]` unpack 3-tuple nên mọi `conn.execute` thêm trong `apply_rows` làm vỡ test phải giữ nguyên. Điều kiện giữ khoảnh mở rộng thêm `garden_media` (khoảnh mẫu có ảnh → FK no action → loader cũ sẽ crash ForeignKeyViolation); test `test_loader_keeps_plot_with_media`. `deploy/cloud/README.md` thêm `garden_media` (drift-guard `test_cloud_readme_drift_guard` fail vòng 1).
- [x] **W93.3 Hồ sơ khoảnh: precheck + gỡ dữ liệu mẫu có `--by`** —
  `agents/garden_director.py` (mới): `sample_precheck(conn) -> dict` (chỉ
  đọc): số dòng `plots`/`plot_logs` `source like 'sample:%'` + danh sách
  blocker = nhật ký KHÔNG-mẫu trỏ khoảnh mẫu (id, plot_id, ngày ts, source
  — KHÔNG detail/author) + `garden_media` trỏ khoảnh mẫu (id, plot_id).
  `purge_sample(conn, by) -> dict`: `by` rỗng/khoảng trắng → `ValueError`
  (không connect, không ghi); trong 1 transaction: precheck lại → có
  blocker → KHÔNG xóa, trả `{"ok": False, "blockers": [...]}`; không →
  `delete from plot_logs where source like 'sample:%'` rồi `delete from
  plots where source like 'sample:%'`, số dòng xóa ≠ precheck → raise →
  rollback; insert `agent_action_log` (`actor` = by, `action =
  'garden_sample_purge'`, `object_type = 'plots'`, `detail` = {plots: n,
  plot_logs: m}); `conn.commit()`. CLI `--precheck` (exit 0, in số đếm +
  blocker), `--purge-sample --by "<GĐ vùng trồng>"` (thiếu `--by` →
  `ap.error` exit 2 TRƯỚC connect; blocker → exit 1; ok → exit 0). Agent/cron
  KHÔNG gọi `purge_sample` (grep: chỉ CLI + test).
  - Boundary: `agents/garden_director.py`, `tests/test_garden_director.py`,
    `tests/test_garden_chain.py`
  - Gate: `python -m agents.garden_director --purge-sample; echo $?` → 2,
    stderr nhắc `--by` (test: monkeypatch `connect` raise nếu bị gọi →
    không gọi); `--purge-sample --by "  "` → exit 2; `python -m
    agents.garden_director --precheck` trên DB riêng exit 0, in số đếm,
    không ghi (count `agent_action_log` trước/sau bằng nhau); test DB
    (temp schema, `_TxConn`): nạp mẫu + 1 log `manual:garden` lên KV-A01 →
    `purge_sample` trả ok False, blocker đúng id đó, count `sample:%`
    không đổi, 0 log action mới; bỏ blocker (fixture không có log manual) →
    ok True, `count(*) where source like 'sample:%'` = 0 trên plots và
    plot_logs, đúng 1 dòng `agent_action_log` action `garden_sample_purge`
    actor = by, `verify_action_log()` rỗng; sau đó insert `sample:x` → raise
    (W93.1); `grep -rn "purge_sample(" --include=*.py .` chỉ ra
    `agents/garden_director.py` + tests
  - Evidence: `evidence/v93_director.log`
  - Kết quả: xong (CLI + test). Gỡ mẫu thật trên DB = external-dep (GĐ vùng trồng ký) — KHÔNG chạy.
- [x] **W93.4 Nhắc lịch + giám sát gap (rule thuần)** —
  `data/garden_schedule.json` (mới, `_doc`: "GIẢ ĐỊNH — chờ GĐ vùng trồng
  chốt lịch canh tác thật"): `{"gap_days": 14, "activities": {"tưới": 7,
  "kiểm tra sâu bệnh": 7, "làm cỏ": 30, "bón": 60}}`.
  `agents/garden_director.py`: `load_schedule(path) -> (dict, warnings)` —
  enumerate điều kiện biên: file thiếu / rỗng / `{}` / chỉ `_doc` → lịch
  rỗng + `gap_days` = `garden.DEFAULT_GAP_DAYS` + warning "chưa có lịch";
  JSON hỏng / activity không thuộc `garden.ACTIVITY_VOCAB` / số ngày không
  phải int 1..366 / `gap_days` sai → `ValueError` (CLI `[err]` exit 1).
  `reminders(plots, last_any, last_by_activity, schedule, now) -> list[dict]`
  THUẦN (không DB): `no-logs` (khoảnh active chưa có nhật ký nào — khi đó
  KHÔNG sinh `overdue` cho khoảnh đó), `gap` (`now - last_any >
  gap_days`, so sánh nghiêm ngặt), `overdue` (activity trong lịch: chưa
  từng có hoặc `now - last > interval`), mỗi mục `{type, plot, activity,
  last_ts, days}`, sắp xếp tất định (type, plot, activity). `due_reminders
  (conn, schedule, now)` gom dữ liệu (plots active + `max(ts)` theo plot và
  theo (plot, activity)) rồi gọi `reminders`. Cờ keyword trên nhật ký trong
  kỳ: `garden.flags_for("", detail)` — CHỈ detail.
  - Boundary: `agents/garden_director.py`, `data/garden_schedule.json`,
    `tests/test_garden_director.py`
  - Gate: test thuần với `now` cố định (2026-10-12T00:00+07): khoảnh chưa
    log → đúng 1 `no-logs`, 0 `overdue`; last = now-14d → không `gap`,
    now-14d-1s → `gap`; "tưới" last now-7d → không, now-8d → `overdue`;
    activity lịch chưa từng có → `overdue` last None; output tất định (gọi 2
    lần bằng nhau); `load_schedule` đủ 4 biến thể thiếu/rỗng/`{}`/chỉ `_doc`
    + 3 biến thể lỗi; detail "kiểm tra sâu bệnh định kỳ" ở activity không
    flag, detail "phát hiện rệp" flag `rệp`; không test nào gọi
    `datetime.now` (grep `datetime.now` trong test file = 0)
  - Evidence: `evidence/v93_director.log`
  - Kết quả: xong. `load_schedule` 5 biến thể rỗng + 9 biến thể lỗi (`ScheduleError(ValueError)`); lịch `data/garden_schedule.json` là GIẢ ĐỊNH.
- [x] **W93.5 Kho tư liệu vườn — gỡ EXIF/GPS, lưu theo sha256** —
  `scripts/garden_media.py` (mới, UTF-8 guard): `strip_image(src_bytes) ->
  (clean_bytes, ext, info)` — Pillow import lười; từ chối file > 25 MB,
  không mở được, `DecompressionBombError`/`Warning` (coi là lỗi), format
  ngoài JPEG/PNG/WEBP; `ImageOps.exif_transpose` rồi convert RGB/RGBA và
  dựng ảnh MỚI từ pixel (`Image.frombytes(mode, size, tobytes())`) → save
  JPEG (q=90) hoặc PNG (khi có alpha) KHÔNG truyền exif/icc/xmp/pnginfo;
  `info` = {exif_removed: số thẻ EXIF gốc, had_gps: bool, width, height} —
  KHÔNG giữ/trả giá trị GPS. `store(clean_bytes, ext, store_dir) -> (sha,
  path)`: sha256 bản ĐÃ gỡ, file `<store>/<sha[:2]>/<sha>.<ext>`, ghi tmp +
  `os.replace`, đã có → không ghi lại. `record(conn, ...)` insert
  `garden_media` `on conflict (sha256) do nothing` + `conn.commit()`. CLI
  `--file F --plot P --date YYYY-MM-DD --by "Tên" [--store DIR]` (store
  mặc định env `GARDEN_MEDIA_DIR`; thiếu / nằm TRONG repo (`resolve()`
  dưới ROOT) → exit 2): connect TRƯỚC (DB down → exit 2, 0 file ghi) →
  strip → store → record; plot không tồn tại → FK → `[err]` friendly exit
  1. stdout chỉ: sha[:12], số thẻ đã gỡ, "có GPS: có/không" — không in tọa
  độ/đường dẫn nguồn. `env.example` thêm `GARDEN_MEDIA_DIR=` (comment: thư
  mục NGOÀI repo). `requirements.txt` thêm `Pillow>=10`.
  - Boundary: `scripts/garden_media.py`, `tests/test_garden_media.py`,
    `env.example`, `requirements.txt`
  - Gate: test sinh ảnh JPEG có EXIF GPS (IFD 0x8825 lat/lon) + Make/Model
    + DateTimeOriginal + XMP, và PNG có `eXIf`/tEXt — tiền điều kiện assert
    ảnh nguồn CÓ GPS; bản lưu: `Image.open(out).getexif()` rỗng, `info`
    không có `exif`/`xmp`/`icc_profile`/text, bytes không chứa
    `b"Exif\x00\x00"`, `b"GPS"`, `b"ns.adobe.com/xap"`; cùng ảnh nạp 2 lần
    → 1 file, 1 dòng DB; file không phải ảnh / > giới hạn / bomb (monkeypatch
    `Image.MAX_IMAGE_PIXELS` nhỏ) → từ chối, 0 file; `--store` trong repo
    → exit 2; CLI với `DATABASE_URL=postgresql://u@10.255.255.1:5432/x`
    (host chết thật, tmp store) → exit 2 trong ≤10s, store rỗng; DB temp
    schema: record đúng plot/taken_on/author/had_gps true, capsys không
    chứa số tọa độ fixture
  - Evidence: `evidence/v93_media.log`
  - Kết quả: xong. Thêm kiểm khoảnh tồn tại TRƯỚC khi ghi file (tránh file mồ côi khi plot sai); `--file` > 25 MB chặn bằng `stat` trước khi đọc. Evidence CLI không ghi `garden_media` lên DB public (đường DB chỉ chạy trong test rollback).
- [x] **W93.6 Agent GĐ vùng trồng — bản tin tuần + verify + CLI** —
  `agents/garden_director.py`: `build_bulletin(conn, until, days=7,
  schedule=None) -> str` markdown tất định (không LLM): (1) toàn vẹn nhật
  ký — kết quả `verify_plot_logs()` (OK / N vấn đề kèm id); (2) dữ liệu mẫu
  còn lại — count `sample:%` plots/plot_logs + "chờ GĐ vùng trồng ký gỡ";
  (3) nhắc lịch/gap — `due_reminders` với `now` = cuối ngày `until` VN;
  (4) nhật ký mới trong kỳ theo khoảnh (tách mẫu/không-mẫu); (5) cảnh báo
  keyword — `flags_for("", detail)`, detail qua `_mask_pii` + cắt 120;
  (6) ảnh mới (`garden_media.created_at` trong kỳ) theo khoảnh. Mỗi mục kèm
  khối "SQL đối chứng" (câu SQL tái lập con số). KHÔNG in `location`/
  `area_m2`/author/tọa độ. CLI (đúng 1 op, `n_ops`): `--bulletin [--until
  YYYY-MM-DD] [--days N] [--out-dir data/reports]` → ghi
  `data/reports/garden-week-<until>.md` (atomic tmp + `os.replace`, đã
  gitignore) + in path; `--remind [--schedule PATH]` in danh sách nhắc;
  `--verify` exit 0 rỗng / exit 1 có vấn đề; `--precheck`/`--purge-sample`
  (W93.3). DB down: `--bulletin`/`--remind`/`--precheck` → `[warn] chưa
  nạp` exit 0; `--verify`/`--purge-sample` → exit 2.
  - Boundary: `agents/garden_director.py`, `tests/test_garden_director.py`
  - Gate: test fake-conn/temp schema với `until` str "2026-10-12" (kiểu CLI
    thật) và `date`: đủ 6 mục, số liệu khớp SQL đối chứng chạy lại trên cùng
    conn, location fixture ("Trà My") và author không xuất hiện, SĐT trong
    detail bị mask; 2 lần build → chuỗi bằng nhau; `--bulletin --remind`
    cùng lúc / không op → exit 2 trước connect; trên DB riêng: `python -m
    agents.garden_director --verify` exit 0, `--remind` exit 0, `--bulletin
    --until 2026-10-12` exit 0 → file tồn tại, `grep -c "Trà My"` = 0;
    `DATABASE_URL=postgresql://u@10.255.255.1:5432/x python -m
    agents.garden_director --remind` → exit 0 `[warn]` trong ≤10s,
    `--verify` → exit 2; `python -m agents.garden --check` (cũ) vẫn exit 0
  - Evidence: `evidence/v93_director.log`
  - Kết quả: xong. DB down thật (10.255.255.1): `--remind`/`--precheck` exit 0 `[warn]` ~4s, `--verify` exit 2 ~4s.
- [x] **W93.7 Docs** — `docs/handover/kien-truc.md`: "25 bảng public",
  thêm dòng `garden_media` + cột `prev_hash`/`row_hash` của `plot_logs` +
  function `verify_plot_logs`; bảng agent thêm `agents.garden_director`
  và `scripts/garden_media.py`. `docs/handover/playbook-vuon.md`: bản tin
  tuần, nhắc lịch, gửi ảnh (gỡ EXIF), "nhật ký đã ghi không sửa/xóa được —
  ghi dòng mới kèm lý do" (đính chính có duyệt = someday). `docs/handover/
  sop.md`: lệnh `--verify`/`--bulletin`/`--precheck` + thủ tục gỡ mẫu
  (CHỈ GĐ vùng trồng, `--by`). `AGENTS.md` bảng Commands thêm 2 dòng
  (garden_director, garden_media).
  - Boundary: `docs/handover/kien-truc.md`, `docs/handover/playbook-vuon.md`,
    `docs/handover/sop.md`, `AGENTS.md`
  - Gate: `python -m pytest -q tests/test_handover_docs.py` xanh (đếm bảng
    đọc schema.sql); mọi lệnh nhắc trong docs chạy được `--help` exit 0
  - Evidence: `evidence/v93_docs.log`
  - Kết quả: xong; `playbook-vuon.md` dòng "sửa trực tiếp trong DB" đổi thành "không sửa/xóa được — ghi dòng mới" (hash chain làm câu cũ sai).
- [x] **W93.8 Gate chung** — targeted `python -m pytest -q -rs
  tests/test_garden_chain.py tests/test_garden_director.py
  tests/test_garden_media.py tests/test_core_store.py tests/test_garden.py`
  xanh ×3, 0 skipped; full `python -m pytest -q` xanh ĐÚNG 1 lần (baseline
  831 + test mới, 0 fail; lệnh có thể bị đẩy nền — đọc output tới khi
  process exit, không chạy chồng); `ruff check .` clean; `python -m
  py_compile agents/garden_director.py scripts/garden_media.py
  ingest/core_store.py agents/garden.py app/streamlit_app.py` exit 0;
  `git diff --check` sạch; `git diff --stat` KHÔNG chạm `agents/garden.py`,
  `app/streamlit_app.py`, `agents/report.py`, `pipelines/auth.py`,
  `docs/roles.sql`; `git status` không file lạ (ảnh test chỉ trong
  `tmp_path`, không file nào dưới `data/` ngoài `garden_schedule.json`).
  - Boundary: toàn bộ diff version
  - Gate: như trên
  - Evidence: `evidence/v93_pytest.log` (force-add `git add -f`)
  - Kết quả: vòng 1 full 921 pass / 1 fail (`test_cloud_readme_drift_guard` — README cloud thiếu `garden_media`) → sửa → vòng 2: targeted 116 pass ×3 (0 skip), full 922 pass (831 + 91 mới), ruff sạch, py_compile 0, `git diff --check` sạch, 5 file cấm không đổi. Full pytest chạy 2 lần tổng (1 lần/vòng) do vòng 1 fail.

- [x] **W93.9 Vòng sửa nghiệm thu (5 MINOR)**
  - F1+F3 (blocker nhật ký đã chain không "chuyển sang khoảnh thật" được —
    guard chặn cả UPDATE plot_id → `--purge-sample` kẹt vĩnh viễn): thêm op
    `python -m agents.garden_director --adopt-plot <id> --by "<GĐ>"`
    (`adopt_plot`: chỉ khoảnh `sample:%`, đổi `plots.source` →
    `manual:adopted`, ghi `agent_action_log` `garden_plot_adopt`, commit
    tường minh; thiếu `--by` → exit 2 trước connect; DB down → exit 2).
    Thông báo `[blocker]` tách theo loại (nhật ký: KHÔNG chuyển được →
    `--adopt-plot`; ảnh: chuyển `garden_media.plot_id` hoặc nhận khoảnh);
    `sop.md`/`kien-truc.md`/`AGENTS.md` sửa theo. Test:
    `test_guard_blocks_update_delete_truncate_on_chained` (+UPDATE plot_id
    bị chặn), `test_adopt_plot_unblocks_purge` (nhật ký thật chain trên
    KV-A01 + ảnh KV-B01 → adopt + chuyển ảnh → purge ok, `sample:%` = 0,
    nhật ký thật còn, verify sạch), `test_adopt_plot_refusals`,
    `test_adopt_cli_and_blocker_hint`, `test_adopt_cli_usage_exit2_before_connect`,
    `test_adopt_cli_db_down_exit2`; grep-guard agent không gọi
    `adopt_plot`.
  - F2 (bản tin lọc theo ts → nhật ký ghi bù không bao giờ lên bản tin):
    mục 4/5 lọc `(ts trong kỳ) OR (source not like 'sample:%' AND
    created_at trong kỳ)`, SQL đối chứng khớp; cảnh báo ghi bù gắn
    "(ghi bù)". Test `test_bulletin_includes_backfilled_log_by_created_at`
    (mốc từ DB `now()`, không đồng hồ Python; mẫu vẫn chỉ theo ts).
  - F4 (MPO điện thoại bị từ chối): `FORMATS` thêm `MPO` (chỉ dựng khung 0).
    Test `test_mpo_multi_frame_phone_jpeg_stripped` (MPO 2 khung có GPS →
    jpg 1 khung, 0 EXIF/GPS).
  - F5 (`core_store.main()` nhánh sau gỡ mẫu chưa có test):
    `test_loader_main_skips_samples_after_purge` (purge thật trong temp
    schema → `main()` exit 0, `[skip]`, `sample:%` = 0, products/orders
    vẫn nạp) + `test_loader_main_keeps_chained_sample_plot` (`[keep]
    plots: KV-A01 (1 nhật ký đã chain, 0 ảnh)`).
  - Đột biến: gỡ từng fix (nhánh skip main / lọc created_at / MPO) → đúng
    test mới FAIL; đã khôi phục.
  - Gate: targeted 136 pass ×3 (0 skip); full 934 pass (1 lần); ruff sạch;
    py_compile 0; `git diff --check` sạch; 5 file cấm không đổi.
  - Evidence: `evidence/v93_pytest.log`, `evidence/v93_director.log`,
    `evidence/v93_media.log` (mục "VÒNG SỬA nghiệm thu").
- [x] **W93.10 Vòng sửa nghiệm thu #2 (1 MINOR)** — khe còn lại của F2:
  `--bulletin` không `--until` lấy kỳ kết thúc HÔM NAY (ngày chưa hết) →
  nhật ký ghi sau giờ sinh bản tin trong ngày đó (ts + created_at đều
  thuộc kỳ đã sinh, kỳ sau bắt đầu 0h hôm sau) không vào bản tin nào
  (probe: cảnh báo rệp mất hẳn). Vá: `_default_until(now)` (tham số, chỉ
  CLI đọc đồng hồ) = HÔM QUA giờ VN — kỳ chỉ gồm ngày đã hết; help
  `--until`, docstring, comment `build_bulletin` và `playbook-vuon.md`
  ("tuần kết thúc HÔM QUA — chạy sau 0h"; cảnh báo không truyền `--until`
  = hôm nay). Test: `test_default_until_is_yesterday_vn` (VN sáng / UTC
  23:30 hôm trước / sang năm), `test_default_until_naive_rejected`,
  `test_cli_bulletin_without_until_uses_yesterday` (đồng hồ cố định qua
  monkeypatch, file `garden-week-<hôm qua>.md`),
  `test_log_written_after_default_bulletin_lands_next_week` (tái lập probe
  trên temp schema rollback: không ở bản tin A, có ở mục 5 bản tin B).
  Đột biến: `_default_until` trả hôm nay → 5/6 test mới FAIL; đã khôi
  phục. Gate: targeted garden 121 pass ×3; full 939 pass + 1 fail
  `test_zz_no_dr_container_left` (container `samsam-dr-*` của worktree
  khác đang drill song song — docker namespace chung; chạy lại riêng
  `tests/test_dr_drill.py` 27 pass, 0 container sót); ruff sạch.
  Evidence: `evidence/v93_pytest.log`, `evidence/v93_director.log` (mục
  "VÒNG SỬA #2").

Treo external-dep v9.3 (KHÔNG giả lập, KHÔNG tự đánh dấu):
- [ ] GĐ vùng trồng ký gỡ dữ liệu mẫu (`--purge-sample --by`; khoảnh mẫu có nhật ký thật → ký nhận `--adopt-plot <id> --by` trước, rồi cập nhật vị trí/diện tích/số cây thật) — mới có CLI + `--precheck` (DB riêng: 3 khoảnh, 6 nhật ký mẫu, 0 blocker).
- [ ] Lịch canh tác thật thay `data/garden_schedule.json` (GIẢ ĐỊNH).
- [ ] Ảnh vườn thật + thư mục `GARDEN_MEDIA_DIR` ngoài repo có backup (db_backup chưa sao lưu thư mục ảnh).
- [ ] Tọa độ khoảnh — không đưa vào output nào (giữ nguyên).
- [ ] Vai trò `gd_vung_trong` trong SSO/`pipelines/auth.py` (`--by` hiện là tên tự khai).
- [ ] Neo hash chain ra ngoài (xóa dòng CUỐI chuỗi không phát hiện được; owner DB tự `disable trigger` rồi sửa vẫn bị verify bắt, nhưng xóa đuôi thì không).
- [ ] Gửi bản tin/nhắc qua Zalo/email (hiện chỉ ghi `data/reports/`).

Someday (không treo version): đính chính có duyệt (`plot_log_correction_
requests` + view `plot_logs_current`, replace/void); test 20 insert đồng
thời liên-transaction (temp schema rollback không chia sẻ được giữa
connection); grant `plot_logs`/`garden_media`/`verify_plot_logs` cho
`app_human` khi chuyển Streamlit sang role; tab Streamlit hiện trạng thái
chuỗi + ảnh; video/HEIC (exiftool/ffmpeg); phát hiện người + giấy đồng ý +
`sku_scope` bộ tư liệu; nhận nhật ký/ảnh qua Zalo allowlist; gộp vá
flags_for-chỉ-detail từ `main` (193c68d) vào `ai-infra`.

v9.3-vung-trong đóng 2026-10-12 (nghiệm thu đợt 1 FIX 5 → 2 vòng sửa → PASS;
vòng 2: bản tin mặc định kết thúc HÔM QUA giờ VN để nhật ký không lọt giữa 2 kỳ;
OWASP worker vá: user DB thường lách chain bằng chèn dòng `sample:` rồi đổi
source; khoảnh mẫu có ảnh làm loader crash FK. Coordinator chạy lại targeted
143 + ruff + `--verify` exit 0; 5 file cấm sửa không đổi). 25 bảng (+`garden_
media`). External-dep: GĐ vùng trồng ký gỡ dữ liệu mẫu; lịch canh tác thật; ảnh
vườn thật; tọa độ khoảnh; vai trò `gd_vung_trong` trong SSO; neo hash ra ngoài
(xóa dòng cuối chuỗi chưa phát hiện được). Lưu ý merge: nhánh này cố ý không
sửa `agents/garden.py`/`app/streamlit_app.py` vì `main` có commit flags_for chưa
vào ai-infra.

v7.0-collector-chung đóng 2026-10-12 (nghiệm thu đợt 1 FIX 6 → 2 vòng sửa → PASS;
vòng 2: OverflowError khi `<pubDate>` năm/giờ 20 chữ số giết cả lượt chạy. Full
pytest của worker có 1 đỏ `test_zz_no_dr_container_left` do container drill của
worktree song song — không phải lỗi diff (diff không đụng dr_drill/db_backup);
full pytest chạy lại lúc gộp. Coordinator chạy lại targeted 173 + ruff +
`--report`). Chạy thật: 10 request tới 3 nguồn RSS tầng A (vnexpress sức khỏe/
pháp luật, tuổi trẻ sức khỏe), robots trước, gap ≥1s, 0 host chặn; chỉ lưu tiêu
đề + trích ≤300 ký tự + link. External-dep: BGĐ/QL MXH duyệt danh sách nguồn
(đang `cho_duyet`); Pháp chế xem điều khoản RSS + cho gửi tin qua LLM; email công
ty cho User-Agent. Someday: SSRF khi redirect sang IP nội bộ; NER che họ tên;
hạn lưu/purge `intel_items`.

v9.5-co-khi đóng 2026-10-12 (nghiệm thu đợt 1 FIX 9 → 2 vòng sửa → PASS; vòng 2:
ghép trang trùng marker bậc 2. Coordinator chạy lại targeted 281 + ruff +
agent_eval co_khi --no-record; `data/co_khi_mat/` gitignored). Luồng mật: gateway
từ chối `ck_mat` trước khi đọc config, 0 kết nối mạng kể cả OCR rapidocr local
(model Trung/Anh — đọc tiếng Việt CHƯA kiểm), BM25 thuần Python trích trang,
chủ đề rủi ro (tủ điện, 3 pha, thiết bị áp lực) chỉ trả file+trang + 'kiểm tra với
Kỹ sư trưởng'. Eval MẪU 21/23 (2 ca fact FAIL thật, không chỉnh mẫu cho pass).
External-dep: ~300 trang thật + POC OCR 20 trang; firewall máy chạy luồng mật; Kỹ
sư trưởng sửa eval + ký; sổ máy + biên bản kiểm kê; tự đóng gói hay gia công;
ngưỡng mạng + 2 lần test live 30 phút; danh mục GMP/kiểm định từ Pháp chế.

## Checklist v3.3-connector-csv

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-infra`)
— WP04a, luồng F01b (đối chiếu listing/giá/ads trên sàn với bản chuẩn),
agent "Connector sàn (CSV P1 → API P2, chỉ đọc)" (plan_data_platform.md).
Hiện chưa có gì nhận file sàn: golden v3.2 (`sku_master`, `price_list`,
`sku_readiness`) có nhưng không ai đối chiếu với cái ĐANG bày trên
Shopee/TikTok. Sau version: Quản lý MXH xuất tay CSV/XLSX từ Seller
Center → `python -m ingest.market_csv` nạp vào staging (không PII người
mua), đối chiếu golden bằng QUY TẮC (không LLM) và mở/đóng cảnh báo
S1/S2 trong `market_alerts`. Agent CHỈ ĐỌC: không gọi sàn, không đổi giá,
không ghi bảng golden, không ghi `products`.

Quy ước: ponytail — stdlib `csv` + `hashlib` + `psycopg` sẵn có; `.xlsx`
đọc bằng `openpyxl` (3.1.5 đã có trong interpreter) import LƯỜI trong hàm
đọc xlsx, thiếu → `[err]` gợi ý xuất CSV, exit 1; thêm 1 dòng
`openpyxl>=3.1` vào `requirements.txt` (dep nhẹ, lý do ghi comment). Không
dep khác, không gọi mạng (không `httpx`/`requests`/`urllib` trong module).
Schema chỉ THÊM (`create ... if not exists`), không sửa bảng cũ. Tên cột
Shopee/TikTok trong mapping là GIẢ ĐỊNH — `_doc` của file mapping ghi rõ
"chưa xác minh với file thật". Parse + kiểm TOÀN file TRƯỚC khi connect:
thiếu cột bắt buộc / cột lạ (không thuộc `required`/`optional`/`drop`) /
header trùng / file rỗng hoặc chỉ header / đuôi không phải `.csv`/`.xlsx` /
CSV không decode được `utf-8-sig` / giá-số lượng-chi tiêu không parse được
số nguyên ≥ 0 / dòng thiếu cả `item_id` lẫn `seller_sku` → `[err]`, exit 1,
KHÔNG connect, 0 dòng nạp (không nạp nửa vời). PII: chỉ field trong
allowlist mapping được giữ; cột tên/SĐT/địa chỉ người mua, ghi chú đơn,
mã/tên buyer nằm trong `drop` và bị bỏ NGAY khi đọc — không vào `raw`,
không vào cột nào, không in ra stdout; mã đơn chỉ lưu
`order_id_hash` = sha256(`channel:order_id`)[:16]. Thông báo lỗi chỉ nêu
số dòng + tên field, KHÔNG in giá trị ô. Mọi connect có
`connect_timeout`; ghi = 1 transaction + `conn.commit()` tường minh (gotcha
savepoint v2.1); print tiếng Việt → UTF-8 guard; `n_ops` > 1 → `ap.error`
exit 2 trước connect (gotcha v2.2). Ngày "hôm nay" khi lấy giá golden =
`(now() at time zone 'Asia/Ho_Chi_Minh')::date` (tái dùng
`golden_store.TODAY_VN`). Test DB thật chạy trong schema tạm + ROLLBACK
(mẫu fixture `db` của `tests/test_golden_store.py`), gate yêu cầu 0 skipped.
Fixture tổng hợp `tests/fixtures/market/fixture_*.csv` — KHÔNG dữ liệu
thật của khách (tên/SĐT/địa chỉ người mua trong fixture là chuỗi giả rõ
ràng, vd "NGUOI MUA GIA", "0900000000"). File xuất thật để ở `data/raw/
market/` (đã gitignore qua `data/raw/`), không copy vào repo.

Ánh xạ item sàn → golden (thứ tự): (1) `seller_sku` trùng `sku_master.
sku_key` → SKU đó; (2) channel `shopee` và `item_id` khớp ĐÚNG 1
`sku_master.shopee_item_id` → SKU đó; khớp ≥2 (biến thể mật ong 120ml
1 hũ/2 hũ chung item 54916394790) hoặc 0 → không map (`detail` ghi danh
sách ứng viên nếu có, agent không tự chọn). Cảnh báo (rebuild trên
snapshot vừa nạp của cùng (channel, export_kind)):
`alcohol_listed` S1 — dòng listing map tới SKU `category='alcohol'` mà
`status` không thuộc `inactive_status` của mapping (status lạ = coi như
đang bán, fail-closed); `price_mismatch` S2 — dòng listing có giá ≠ giá
`list` golden đang mở (valid_from ≤ hôm nay VN, `valid_to` null) cùng
(sku_key, channel); `detail` ghi giá sàn, giá golden, `price_id`,
`golden_approved` true/false + `approved_by` (hiện mọi giá golden CHƯA
duyệt → ghi rõ "chưa duyệt"); không có giá golden → không cảnh báo, chỉ
đếm trong `--report`; `tpbvsk_ads_no_xnqc` S1 — dòng ads map tới SKU
`category='tpbvsk'`, `xnqc_status <> 'approved'`, `ads_spend_vnd > 0`;
`item_unmapped` S2 — dòng listing/ads không map được. Export `order` chỉ
nạp staging (giữ `status` để tách đơn hủy trong báo cáo), không sinh cảnh
báo ở P1.

External-dep (KHÔNG giả lập, để `[ ]`): file xuất THẬT từ Seller Center
Shopee/TikTok Shop (cần người có tài khoản xuất) → xác minh tên cột,
dòng header, định dạng giá/trạng thái trong `data/market_csv_map.json`;
API Shopee Open Platform / TikTok Shop Partner Center scope read (P2);
TTL file gốc do Pháp chế chốt + storage trong nước; gửi cảnh báo đồng
thời GĐ bán hàng/Pháp chế/Quản lý MXH (n8n/email, F03c ticket); role DB
`market_sync` (INSERT staging, SELECT golden) trên cloud; GĐ bán hàng duyệt
giá golden (v3.2) — trước đó mọi `price_mismatch` so với giá CHƯA duyệt.

- [x] **W33.1 Schema staging sàn: 3 bảng** — `docs/schema.sql` append block
  "v3.3 connector sàn (F01b)" (comment tiếng Việt: chỉ đọc sàn, không PII,
  idempotent theo hash file, không ghi golden/products):
  `market_snapshots` (`id bigint identity pk`, `channel` check in
  (`shopee`,`tiktok`), `export_kind` check in (`listing`,`order`,`ads`),
  `file_name text not null` (basename, không đường dẫn), `file_sha256 text
  not null unique`, `row_count int not null`, `imported_at timestamptz not
  null default now()`); `market_rows` (`id` identity pk, `snapshot_id`
  FK market_snapshots not null, `row_no int not null`, `channel`,
  `export_kind`, `item_id text`, `seller_sku text`, `sku_key text` (null
  = không map; không FK), `title text`, `price_vnd bigint`, `stock int`,
  `status text`, `ads_spend_vnd bigint`, `qty int`, `order_id_hash text`,
  `raw jsonb not null` (CHỈ field allowlist đã chuẩn hóa), unique
  (`snapshot_id`, `row_no`)); `market_alerts` (`id` identity pk, `kind`
  check in (`alcohol_listed`,`price_mismatch`,`tpbvsk_ads_no_xnqc`,
  `item_unmapped`), `severity` check in (`S1`,`S2`), `channel`,
  `export_kind`, `item_id`, `seller_sku`, `sku_key`, `detail jsonb not
  null`, `status` check in (`open`,`closed`) default `open`, `snapshot_id`
  (lần thấy gần nhất), `opened_at`, `updated_at`, `closed_at`) + unique
  index (kind, channel, export_kind, coalesce(item_id,''),
  coalesce(seller_sku,'')). Không cột tên/SĐT/địa chỉ/buyer nào.
  - Boundary: `docs/schema.sql` (chỉ append block mới)
  - Gate: `python scripts/apply_schema.py` ×2 exit 0, lần 2 in 17 bảng
    (14 cũ + 3 mới); `grep -c "^create table if not exists" docs/schema.sql`
    = 17; `grep -niE "buyer|nguoi_mua|phone|address|recipient" docs/schema.sql`
    không trúng dòng nào trong block v3.3
  - Evidence: `evidence/v33_market.log`
- [x] **W33.2 Mapping cột + parser thuần (không DB)** —
  `data/market_csv_map.json` `{"_doc": "... GIẢ ĐỊNH, chưa xác minh với file
  thật ...", "shopee": {"listing"|"order"|"ads": {"required": {field:
  header}, "optional": {field: header}, "drop": [header...],
  "inactive_status": [...]}}, "tiktok": {...}}` — field chuẩn: `item_id`,
  `seller_sku`, `title`, `price`, `stock`, `status`, `ads_spend`, `qty`,
  `order_id`; `drop` của `order` liệt kê cột PII (tên người mua/người
  nhận, SĐT, địa chỉ, ghi chú, tên đăng nhập buyer). `ingest/market_csv.py`
  hàm thuần `read_export(path, channel, kind, mapping) -> (rows, errors)`:
  `.csv` đọc bytes + decode `utf-8-sig` (strict → lỗi rõ), `.xlsx` qua
  openpyxl `read_only=True, data_only=True` sheet đầu, header = dòng 1;
  kiểm header (thiếu `required` / cột lạ / trùng) → errors nêu tên cột;
  chuẩn hóa giá VND (bỏ `₫`, `.`, `,`, khoảng trắng; ô số xlsx nguyên) →
  int ≥ 0; `order_id` → `order_id_hash` rồi bỏ giá trị gốc; mỗi row trả
  về chỉ gồm field allowlist; `sha256` của bytes file tính 1 lần. Không
  print giá trị ô.
  - Boundary: `data/market_csv_map.json` (mới), `ingest/market_csv.py`
    (mới), `requirements.txt` (+1 dòng openpyxl), `tests/test_market_csv.py`
    (mới), `tests/fixtures/market/` (mới)
  - Gate: test thuần: fixture listing/order/ads Shopee parse đúng số
    dòng; fixture thiếu cột bắt buộc → errors nêu đúng tên cột, rows rỗng;
    fixture thêm cột lạ (vd "Email người mua") → lỗi; header trùng → lỗi;
    file rỗng / chỉ header / đuôi `.txt` / bytes không phải UTF-8 → lỗi;
    giá "abc" hoặc âm → lỗi nêu số dòng; bản `.xlsx` sinh từ cùng fixture
    (openpyxl trong `tmp_path`) parse ra rows bằng hệt bản CSV; order:
    không row nào chứa chuỗi tên/SĐT/địa chỉ/mã đơn gốc của fixture
    (`json.dumps(rows)` không chứa), có `order_id_hash` 16 hex; `_doc`
    mapping chứa "chưa xác minh"
  - Evidence: `evidence/v33_pytest.log`
- [x] **W33.3 Nạp staging idempotent (CLI)** — `python -m
  ingest.market_csv --file <path> --channel shopee|tiktok --kind
  listing|order|ads`: parse+kiểm TOÀN file trước connect (lỗi → in từng
  lỗi, exit 1, không connect); `file_sha256` đã có → `[skip]` nêu snapshot
  id + channel/kind gốc, exit 0, 0 ghi; mới → 1 transaction: insert
  `market_snapshots` + `market_rows` (map `sku_key` theo quy tắc trên) +
  rebuild cảnh báo (W33.4) → `conn.commit()`; unique-violation
  `file_sha256` (nạp song song) → rollback, báo skip. `--channel`/`--kind`
  sai → argparse exit 2; `--file` thiếu `--channel`/`--kind` → exit 2;
  `--file` cùng `--report` → exit 2 — tất cả trước connect. Thiếu bảng →
  `[err]` gợi ý `apply_schema`; lỗi DB → rollback, exit 1. Docstring
  module tiếng Việt: contract, schema mapping, quy tắc map + cảnh báo,
  ownership (chỉ đọc golden, không ghi sàn/giá).
  - Boundary: `ingest/market_csv.py`, `tests/test_market_csv.py`
  - Gate: CLI trên samsam_infra: nạp `fixture_shopee_listing.csv` 2 lần
    → lần 2 `[skip]`, `count(*)` `market_snapshots`/`market_rows` giống
    hệt sau lần 1 (in bằng `python -c`, không in DSN); fixture thiếu cột
    → exit 1 và 2 số đếm không đổi; test (monkeypatch connect → raise):
    thiếu cột / cột lạ / file rỗng → exit 1, connect KHÔNG được gọi;
    usage sai (4 combo trên) → exit 2, connect không gọi; test DB thật
    (rollback): nạp cùng file 2 lần → 1 snapshot, số row = số dòng file;
    nạp order fixture → `select count(*) from market_rows where raw::text
    ~* '<tên giả>|0900000000|<địa chỉ giả>|<mã đơn gốc>'` = 0 và
    `order_id_hash` not null mọi dòng; module không ghi golden/products/
    sàn: `grep -niE "(update|insert into|delete from) +(price_list|sku_master|sku_map|products)" ingest/market_csv.py`
    rỗng và `grep -nE "^(import|from) +(httpx|requests|urllib)" ingest/market_csv.py`
    rỗng
  - Evidence: `evidence/v33_market.log`
- [x] **W33.4 Đối chiếu golden → `market_alerts` (mở/đóng, không đổi
  giá)** — hàm `reconcile(conn, snapshot_id) -> dict` chạy trong cùng
  transaction nạp, chỉ cho `listing`/`ads`: tính tập phát hiện theo 4 quy
  tắc ở đầu checklist; upsert theo unique key → `status='open'`,
  `closed_at=null`, `detail`/`snapshot_id`/`updated_at` cập nhật,
  `opened_at` = now() khi mở mới hoặc mở lại; cảnh báo `open` cùng
  (channel, export_kind) KHÔNG còn trong tập → `status='closed'`,
  `closed_at=now()` (sàn đã sửa ở export kế tiếp) — *sửa nghiệm thu:*
  CHỈ khi item (item_id, seller_sku) CÓ MẶT trong file mới; item vắng
  mặt → giữ open + `[warn]` (vắng ≠ đã sửa). `detail` = giá trị
  theo từng nguồn, KHÔNG có trường "đề xuất/giá nên đặt".
  - Boundary: `ingest/market_csv.py`, `tests/test_market_csv.py`,
    `tests/fixtures/market/`
  - Gate: test DB thật (rollback, golden nạp từ `data/golden_skus.json`
    trong schema tạm): nạp `fixture_shopee_listing.csv` (savina giá đúng
    159000; Savigout 24325987926 giá 482900 = +10%; rượu chai thủy tinh
    27325048614 status đang bán giá 745000; item 99900000001 không có
    trong golden; mật ong 120ml item chung 54916394790 với `seller_sku`
    = `mat-ong-sam-120ml-1hu` giá 745000) + `fixture_shopee_ads.csv`
    (saphraton-20v spend > 0; savina spend 0; mật ong 300ml spend > 0) +
    `fixture_shopee_order.csv` (có 1 đơn hủy) → đúng 4 cảnh báo `open`,
    mỗi kind 1 lần: `alcohol_listed` S1 (ruou-sam-chai-thuy-tinh-500ml),
    `price_mismatch` S2 (savigout-30v, detail 482900 + 439000 +
    `golden_approved` false), `tpbvsk_ads_no_xnqc` S1 (saphraton-20v),
    `item_unmapped` S2 (99900000001); nạp lại cả 3 file → vẫn 4, không
    nhân đôi; nạp `fixture_shopee_listing_fixed.csv` (Savigout 439000,
    rượu status thuộc `inactive_status`) → 2 cảnh báo đó `closed` +
    `closed_at` not null, 2 cái còn lại vẫn `open`; test RIÊNG: item
    54916394790 KHÔNG `seller_sku` → `item_unmapped` với detail 2 ứng
    viên; giá golden không đổi suốt test (`price_list` count + `max(id)`
    trước/sau bằng nhau, `approved_by is not null` = 0)
  - Evidence: `evidence/v33_market.log`
- [x] **W33.5 `--report` cho người đọc** — `python -m ingest.market_csv
  --report`: cảnh báo `open` S1 trước S2 (kind, kênh, item/sku, detail
  JSON, `opened_at`); snapshot mới nhất mỗi (channel, kind) kèm số ngày
  tuổi; kênh có listing mà CHƯA có snapshot `ads` → dòng `[warn] <kênh>:
  không đủ dữ liệu quảng cáo` (không im lặng); order snapshot mới nhất:
  đếm theo `status` (đơn hủy hiện riêng); số dòng listing không có giá
  golden để so. Không in `order_id_hash`/raw đơn.
  - Boundary: `ingest/market_csv.py`, `tests/test_market_csv.py`
  - Gate: test DB thật (rollback, capsys): sau 3 fixture → output có 4
    cảnh báo, 2 dòng S1 đứng trước S2; chỉ nạp listing (không ads) → có
    "không đủ dữ liệu quảng cáo"; có ads → không có dòng đó; output không
    chứa chuỗi PII giả của fixture order
  - Evidence: `evidence/v33_pytest.log`
- [x] **W33.6 Docs + drift-guard đếm bảng** — `docs/handover/sop.md` thêm
  mục "Nạp file sàn (Shopee/TikTok)": ai xuất, lưu ở `data/raw/market/`,
  lệnh nạp 3 loại + `--report`, đọc S1/S2, ai sửa trên sàn (MXH sau khi
  GĐ bán hàng/Pháp chế duyệt — agent không sửa), file lỗi schema thì làm
  gì, ghi rõ mapping cột chưa xác minh; `docs/handover/kien-truc.md` mục 3
  → "17 bảng" + 3 dòng bảng mới; `AGENTS.md` Commands thêm
  `python -m ingest.market_csv ...` + Structure `ingest/` nhắc
  market_csv; `tests/test_handover_docs.py`: đếm 14→17 + `SOP_COMMANDS`
  thêm `"ingest.market_csv"`; `tests/test_lead_store.py` +
  `tests/test_store.py` đếm 14→17 (chỉ số đếm, không xóa assert khác).
  - Boundary: `docs/handover/sop.md`, `docs/handover/kien-truc.md`,
    `AGENTS.md` (Commands + Structure), `tests/test_handover_docs.py`,
    `tests/test_lead_store.py`, `tests/test_store.py` (chỉ số đếm/list lệnh)
  - Gate: `python -m pytest tests/test_handover_docs.py tests/test_lead_store.py tests/test_store.py -q`
    xanh; `grep -n "ingest.market_csv" docs/handover/sop.md AGENTS.md`
    có kết quả ở cả 2 file; `grep -c "chưa xác minh" docs/handover/sop.md`
    ≥ 1; đối chiếu số assert 3 file test trước/sau không giảm
  - Evidence: `evidence/v33_pytest.log`
- [x] **Gate chung** —
  - `python scripts/apply_schema.py` ×2 exit 0 (17 bảng) → `python -m ingest.golden_store` exit 0 (golden 13/34 không đổi)
  - E2E CLI trên samsam_infra: 3 fixture nạp ×2 (lần 2 `[skip]`, số đếm
    không đổi) → `market_alerts` open = 4 → fixture thiếu cột exit 1, 0
    dòng thêm → `--report` exit 0 (log vào evidence)
  - targeted ×3: `python -m pytest tests/test_market_csv.py tests/test_golden_store.py tests/test_handover_docs.py -q -rs`
    3 lần liên tiếp xanh, test DB thật **0 skipped** (đọc output tới
    exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 308 + test mới
  - `ruff check .` sạch
  - `python -m py_compile ingest/market_csv.py ingest/golden_store.py scripts/apply_schema.py`
  - DỌN dữ liệu fixture khỏi samsam_infra sau E2E (DB dev không được
    chứa cảnh báo giả như thật): xóa theo `snapshot_id` của file
    `fixture_*` (alerts → rows → snapshots) bằng `python -c`; cuối gate
    3 bảng market = 0 dòng; `price_list where approved_by is not null` =
    0; `sku_master` = 13, `price_list` = 34
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file xuất sàn thật / runtime mới trong
    `data/` (ngoài `data/market_csv_map.json`); file lạ không thuộc
    version → không stage
  - Kết quả (worker, 2 vòng): vòng 1 xanh (89×3 targeted, full 340,
    ruff, py_compile, E2E 4 cảnh báo); rà OWASP bắt A09 (header lạ /
    dòng-đầu-là-dữ-liệu bị in nguyên văn → có thể lộ tên/SĐT khi file
    order thiếu header) → vá (`_safe` = `_mask_pii` + bỏ ký tự điều khiển;
    0 cột bắt buộc khớp → báo chung, không in ô; `_clean` cho
    item/sku/file/detail trong `--report`) + test
    `test_header_errors_never_echo_pii`; vòng 2: targeted 90×3 xanh 0
    skipped, full 341 passed, ruff sạch, py_compile ok, E2E lại 4 cảnh
    báo, skip ×3, thiếu cột exit 1 + 0 dòng; DỌN xong: 3 bảng market = 0,
    sku_master 13, price_list 34, 0 giá duyệt. Evidence
    `evidence/v33_market.log`, `evidence/v33_pytest.log` (cần `git add -f`).
  - Lệch nhỏ so với chữ contract (ghi rõ): `read_export` trả 3-tuple
    `(rows, errors, sha256)` để hash đúng bytes đã parse (1 lần đọc, không
    TOCTOU); mapping thêm khóa `cancel_status` (order) để `--report` tách
    đơn hủy; giá dạng thập phân ("12,5", "1.234,50") → lỗi thay vì bỏ dấu
    phân cách (fail-closed, nhóm nghìn phải đúng 3 chữ số).
  - Vòng sửa nghiệm thu (worker, 5 MINOR): (1) đóng cảnh báo chỉ khi
    item CÓ MẶT trong snapshot mới mà hết lỗi — listing xuất 1 phần không
    còn đóng oan S1 `alcohol_listed`; item vắng → giữ open, CLI in `[warn]
    N cảnh báo ... GIỮ MỞ`; SOP 5b: xuất listing TOÀN BỘ sản phẩm, ads gồm
    chiến dịch tạm dừng (test `test_db_partial_listing_keeps_absent_alerts_open`);
    (2)+(4) ô float xlsx có phần lẻ → `f"{v:f}"` ("12.345000", không bao
    giờ khớp `_INT_RE`) thay `repr` (12.345 từng thành 12345) → lỗi nêu
    số dòng (`test_xlsx_float_cells_never_scaled`: 482900.0 → 482900;
    12.345/1.234/250.125/482.9 giá + 250.125 ads_spend → lỗi, rows=[]);
    (3) A04: duyệt LƯỜI, áp trần trong lúc đọc — `MAX_ROWS` 100.000 (đếm
    cả dòng trống) / `MAX_COLS` 200; XLSX chặn used-range (`ws.max_row`/
    `max_column`) TRƯỚC khi duyệt + `iter_rows(max_col=MAX_COLS+1)`; CSV
    `TextIOWrapper` decode lười (bỏ bản UCS-4 của StringIO), dòng trống bỏ
    ngay; probe sau vá: xlsx 4.9KB A1:Z200000 / A1:CV200000 /
    A1:XFD1048576 → lỗi ngay 0.1MB/0.03s (trước 129MB/6.7s, 358MB/9.5s,
    ước 100GB+); CSV 5MB dòng trống 20MB/0.8s (trước 1023MB/75s), 49MB
    196MB/1s; còn lại 1 dòng cực rộng tuyến tính ~10× file (≤50MB) — câu
    "file > 50MB bị từ chối" trong báo cáo A04 vòng trước KHÔNG đủ chống
    DoS bộ nhớ, đã thay bằng trần dòng/cột (tests
    `test_xlsx_inflated_used_range_rejected_before_iterating`,
    `test_csv_row_and_col_caps_while_streaming`); (5) test
    `test_db_other_channel_never_closes_alerts` (TikTok listing+ads cùng
    item_id với cảnh báo Shopee → 4 cảnh báo Shopee vẫn open, closed_at
    null). Mutation probe 6/6 KILLED (bỏ `a.channel`, bỏ điều kiện có mặt,
    `repr` float, bỏ trần dòng, bỏ chặn used-range, bỏ trần cột). Gate:
    targeted 95×3 xanh 0 skipped, full 346 passed, ruff sạch, py_compile
    ok; E2E CLI listing → listing 1 phần: 3 cảnh báo giữ open + `[warn]`,
    DỌN xong (3 bảng market = 0, sku_master 13, price_list 34, 0 duyệt).
  - Vòng sửa nghiệm thu #2 (worker, 1 MINOR): XLSX `<dimension>` KHAI
    THIẾU (A1:F2 nhưng có dòng 4) → read-only openpyxl dừng ở `max_row`
    = cắt câm dòng rượu, không S1. Giữ chặn used-range phóng đại, rồi
    `ws.reset_dimensions()` trước `iter_rows` → đọc tới hết sheet, trần
    `MAX_ROWS`/`MAX_COLS+1` vẫn áp khi duyệt (probe: dim A1:F2 → đủ 3
    dòng; không dimension + ô dòng 1.000.000 → lỗi trần 0.1MB/5.7s).
    Test `test_xlsx_understated_dimension_reads_all_rows` (mutation bỏ
    reset → FAILED). Gate: targeted 39×3 xanh, full 347 passed, ruff
    sạch (`evidence/v33_pytest.log`, `evidence/v33_market.log`). Còn lại
    (không chặn, ghi nhận): dimension khai thiếu CỘT + ô dữ liệu ở cột
    > 201 bị `max_col` cắt câm — header bắt buộc ngoài 200 cột vẫn ra
    lỗi thiếu cột (fail-closed), chỉ field optional (`seller_sku`/
    `stock`/`status` ads) có thể mất.
- [ ] **external-dep** File xuất THẬT Seller Center Shopee + TikTok Shop
  (listing/order/ads) do người có tài khoản xuất → xác minh tên cột,
  dòng header, định dạng giá/trạng thái, cột PII cần `drop` trong
  `data/market_csv_map.json`; tới lúc đó mapping là giả định.
- [ ] **external-dep** API Shopee Open Platform / TikTok Shop Partner
  Center scope read (P2, chủ tài khoản tự cấp OAuth); TTL file gốc (Pháp
  chế chốt) + storage trong nước + purge 02:00; gửi cảnh báo đồng thời 3
  người + ticket SLA (n8n/F03c); role DB `market_sync` trên cloud.
- [ ] **external-dep** GĐ bán hàng duyệt giá golden (v3.2) — trước đó
  `price_mismatch` so với giá CHƯA duyệt (`detail.golden_approved=false`).

Someday (ngoài phạm vi v3.3, ghi để không cuốn vào): export chương trình
khuyến mãi (promo ≠ giá promo đã duyệt, voucher trên SKU không
promotable); đối chiếu tiêu đề/mô tả/quy cách theo hash trường chuẩn
hóa + guardrail banned-words trên title sàn; watermark file nộp muộn
(file cũ nạp sau file mới đang đóng/mở cảnh báo theo thứ tự nạp); ads cho
SKU food/alcohol readiness `CAM`; đơn sàn → `orders` lõi + upsert
(channel, order_id); SKU TikTok chưa có item id trong golden (chỉ map qua
`seller_sku`); cảnh báo "chưa có file hôm nay" 09:30; S2 mở >24h → ticket.

v3.3-connector-csv đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 5 finding →
2 vòng sửa → PASS; coordinator vá thêm 2 NIT: NBSP literal trong
`_STRIP_RE`, `_clean` trạng thái đơn ở `--report`; chạy lại 347/347 +
ruff). DB samsam_infra dọn fixture: 3 bảng market 0 dòng, golden giữ
nguyên. External-dep: file xuất thật Seller Center (mapping cột
"chưa xác minh"), API sàn P2, gửi cảnh báo cho người thật, role
`market_sync`. Someday (NIT nghiệm thu): test reopen `opened_at`
(now() hằng trong tx), test nhánh UniqueViolation/UndefinedTable,
parametrize parser fail-closed (thừa ô, '1.490,000', hậu tố VND),
pre-decode CSV tốn RAM, xlsx thiếu `<dimension>` bỏ cột >200.

## Checklist v3.9-kb-acl

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-v39`)
— WP04b, luồng F15.3 (kho tri thức có phân quyền → đồng bộ chatbot,
`flows_infra.md`), agent "Knowledge Base (RAG index)"
(`plan_data_platform.md`). Nghiệm thu trước chỉ ra: `api/rag.py`
`retrieve()` SELECT toàn bảng `chunks` không cột/bộ lọc nào, Zalo
(`connectors/zalo.py` `_reply`) và tab Chat (`app/streamlit_app.py`)
cùng gọi `answer()` → nạp tài liệu nội bộ vào `chunks` = lộ ra chatbot
khách. Thêm: `ingest/embed_store.py` re-embed TOÀN BỘ mỗi lần, xóa-nạp
chỉ theo doc_id có trong batch (docstring nói "record bị xóa khỏi jsonl
cũng biến mất khỏi DB" là SAI — doc bị gỡ khỏi nguồn nằm lại vĩnh viễn),
không lọc rượu: dry-run 2026-10-12 trên DB `samsam_v39` = **41/916
chunk, 31 doc** nhắc rượu/wine (wc-158/159/990/991/2293/2296,
nv-RUOU-*, nv-ruou-sam-ngoc-linh, bài showroom/lễ hội/tour wp-134,
wp-160, wp-170, wp-191, wp-285, wp-2413, wp-2527...) và doc tổng hợp
`catalog-products` chunk 0 liệt kê "Rượu Sâm Ngọc Linh No.5/7/9" — luật
quảng cáo rượu ≥15 độ: kênh chatbot khách KHÔNG được trả. Sau version:
`chunks` = corpus CÔNG KHAI duy nhất của chatbot khách, 0 chunk nhắc
rượu; tài liệu nội bộ nằm ở bảng RIÊNG mà `answer()` không có đường
nào đọc tới; chạy lại ingest không đổi gì = 0 lời gọi embed.

Quyết định thiết kế (tối thiểu an toàn): bảng RIÊNG `chunks_internal`
thay vì cột `acl` trên `chunks` — cách ly bằng CẤU TRÚC (quên 1 mệnh đề
WHERE ở caller mới không lộ được), `zalo_preflight`/`data_audit`/
`eval_qa` đếm/đọc `chunks` giữ nguyên ngữ nghĩa "corpus khách". Không
làm version toàn kho N+1/`chunks_active`/staged/`kb_quarantine`/
`kb_filter_log` (bước 7-10 F15.3 — mốc D 18/12, cần role DB cloud):
version ở mức DOC (`doc_version` + `ingested_at`).

Quy ước: ponytail — stdlib + `psycopg`/`numpy` sẵn có, KHÔNG dep mới,
không pgvector. Schema chỉ THÊM (`alter table ... add column if not
exists`, `create table|index if not exists`), không đổi kiểu/xóa cột cũ.
Mọi embedding qua `pipelines.llm_gateway.embed("ingest", ...)` (đã có
v3.1 — PII mask + privacy routing + ghi `llm_usage`); retrieve dùng
`embed("chatbot", ...)` như cũ. Lọc rượu + báo cáo NO_DATA = 0 LLM (chỉ
luật). Mọi `psycopg.connect` mới/đụng tới phải có `connect_timeout`;
ghi DB = 1 transaction + `conn.commit()` tường minh (gotcha savepoint
v2.1). File sửa/thêm có print tiếng Việt → UTF-8 reconfigure guard
(`embed_store.py` hiện CHƯA có — thêm). Guard I/O nguồn: enumerate đủ
biến thể `missing` / `0 byte` / chỉ dòng trắng / chỉ `{"_doc":...}` /
dòng JSON hỏng — 4 biến thể đầu = KHÔNG xóa chunk của nguồn đó (gotcha
delete-trắng v1.8), JSON hỏng = abort TRƯỚC embed và TRƯỚC mọi ghi DB.
Test chạm DB thật: chỉ trên DB của worktree (`DATABASE_URL` từ
`v39.env` = `samsam_v39`), skip khi không connect được nhưng gate yêu
cầu file đó 0 skipped; row test dùng prefix `test-v39-` /
`internal:test_v39` và dọn trong `finally` (retrieve mở conn riêng nên
không dùng được rollback) + assert đã dọn. Test incremental KHÔNG ghi
bảng `chunks` thật: dùng conn thật + `create temp table chunks (like
public.chunks including all)` (pg_temp đứng trước public trong
search_path → SQL không-qualify trúng bảng tạm) hoặc fake-conn; embed
giả đếm lời gọi qua monkeypatch `ingest.embed_store.embed`. Test không
wall-clock. `--approved-by` chỉ NGƯỜI thật truyền — agent/test chỉ dùng
giá trị rõ là mẫu (`MAU-test`), KHÔNG tự đánh dấu trưởng phòng đã duyệt.

External-dep (KHÔNG giả lập): tài liệu nội bộ THẬT của các phòng (chờ
bàn giao — chỉ có file mẫu ghi rõ "MẪU"); trưởng phòng duyệt từng tài
liệu (`--approved-by` người thật); Pháp chế duyệt `data/ruou_keywords.txt`
(bản đầu do agent soạn, header ghi "CHỜ PHÁP CHẾ DUYỆT") + rule
`ruou_cam_quang_cao` của Guardrail v2 (A3); role DB `webhook` không có
quyền SELECT `chunks_internal` (GRANT trên cloud — local cách ly bằng
bảng riêng + code); pgvector (P2); version toàn kho/`chunks_active`/
cổng eval tự chuyển version + `kb_quarantine` cho Pháp chế (F15.3 bước
7-10); systemd timer chạy đêm.

- [x] **W39.1 Schema: `chunks_internal` + cột incremental trên `chunks`** —
  `docs/schema.sql` thêm block "v3.9 kb-acl" (comment tiếng Việt: `chunks`
  CHỈ chứa corpus công khai cho chatbot khách; nội bộ ở bảng riêng):
  `alter table chunks add column if not exists source text` (file nguồn:
  `products.jsonl`|`articles.jsonl`|`about.jsonl`|`news.jsonl`|`catalog`),
  `doc_sha256 text`, `doc_version int not null default 1`, `ingested_at
  timestamptz not null default now()`; `create table if not exists
  chunks_internal (id uuid pk default gen_random_uuid(), collection text
  not null check (collection ~ '^internal:[a-z0-9_]{1,32}$'), doc_id text
  not null, chunk_index int not null, title text, source_ref text (tên
  file gốc, không URL public), content text not null, embedding float8[],
  doc_sha256 text not null, doc_version int not null default 1,
  approved_by text not null check (btrim(approved_by) <> ''), approved_at
  timestamptz not null default now(), ingested_at timestamptz not null
  default now(), unique (collection, doc_id, chunk_index))` + index
  `(collection)`. Dây chuyền drift-guard: `tests/test_handover_docs.py`
  `test_kien_truc_lists_all_tables` đếm cứng 14 bảng → 15 +
  `docs/handover/kien-truc.md` liệt kê `chunks_internal` + "15 bảng".
  - Boundary: `docs/schema.sql`, `tests/test_handover_docs.py` (chỉ hằng
    số bảng), `docs/handover/kien-truc.md`
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp đều exit
    0; `information_schema.columns` của `chunks` có đủ 4 cột mới và cột
    cũ không đổi; test (DB thật, trong tx + ROLLBACK) INSERT
    `chunks_internal` với collection `public` / `internal:` / `internal:KD`
    / `internal:kd;x` và `approved_by` `''`/`'  '`/NULL đều bị CHECK/NOT
    NULL chặn; `python -m pytest -q tests/test_handover_docs.py
    tests/test_core_store.py` xanh
  - Evidence: `evidence/v39_schema.log`
  - Kết quả: apply_schema 2 lần exit 0 (15 bảng); `chunks` đủ 4 cột mới, 8 cột cũ giữ kiểu; 8 case CHECK/NOT NULL bị chặn (`tests/test_kb_acl_db.py`). Dây chuyền ngoài boundary: `tests/test_store.py` + `tests/test_lead_store.py` cũng đếm cứng 14 bảng VÀ cấm mọi `alter table` -> đổi 15 + chỉ cho ALTER dạng `add column if not exists` (vẫn cấm drop/alter khác) — không sửa thì full pytest đỏ.
- [x] **W39.2 Bộ phát hiện rượu `pipelines/kb_filter.py` + `data/ruou_keywords.txt`** —
  `is_alcohol(text) -> bool` (0 LLM): text NFC + casefold; cụm CÓ dấu so
  trên text đó, cụm KHÔNG dấu so trên bản bỏ dấu (`đ`→`d`, có thể dùng lại
  `llm_gateway._strip_accents`); biên từ `(?<!\w)…(?!\w)`; khoảng trắng
  trong cụm khớp `\s+`. Nguồn cụm: `data/ruou_keywords.txt` (1 cụm/dòng,
  `#` = comment; header "CHỜ PHÁP CHẾ DUYỆT"; bản đầu: `rượu`, `ngâm rượu`,
  `độ cồn`, `nồng độ cồn`, `% vol`, `ruou`, `wine`, `liquor`, `samsam
  no.5/no.7/no.9` + biến thể `no. 5`) + `name` của SKU `category ==
  "alcohol"` trong `data/golden_skus.json` (v3.2). Cụm không dấu chỉ được
  thêm khi KHÔNG mơ hồ (precedent "ho"/"gan" health — KHÔNG thêm `do con`
  vì trùng "đó còn"). Fail-closed: `ruou_keywords.txt` missing / 0 byte /
  chỉ comment-dòng trắng → raise `KbFilterError` (không bao giờ "0 cụm =
  không lọc gì"); `golden_skus.json` thiếu/hỏng → chỉ dùng keyword file +
  warn. Load 1 lần (cache, test reset được).
  - Boundary: `pipelines/kb_filter.py` (mới), `data/ruou_keywords.txt`
    (mới, tracked — không phải runtime state), `tests/test_kb_filter.py`
  - Gate: `python -m pytest -q tests/test_kb_filter.py` xanh, gồm: HIT
    "Rượu Sâm Ngọc Linh No. 9", "RƯỢU SAMSAM No.5", NFD "Ru\u031bo\u031b\u0323u
    sâm" (viết escape, không literal), "ruou sam", "Ngoc Linh Ginseng Wine
    No. 7", "nồng độ cồn 27,5%", "40% vol", tên 2 SKU alcohol golden; MISS
    "đó còn", "độ cao 1.500m", "Hồ Chí Minh", "Saphraton 20 viên",
    "swine"/"winery" (biên từ), câu hỏi giá Savina; 3 biến thể fail-closed
    (missing/0 byte/chỉ comment) → `KbFilterError`; đếm trên DB thật
    (read-only) ≥ 41 chunk HIT hiện tại (dry-run khớp lại)
  - Evidence: `evidence/v39_filter.log`
  - Kết quả: 29 test xanh. DB read-only trước ingest: 46 chunk HIT content|title (40 content-only; dry-run 41 = substring, thêm 1 FP `intertwined` ở wp-1842 mà biên từ loại đúng), 31 doc. External-dep: Pháp chế duyệt keyword file.
- [x] **W39.3 Ingest incremental + lọc rượu trong `ingest/embed_store.py`** —
  Tách phần đồng bộ thành hàm test được (vd `sync(conn, data_dir,
  embed_fn=...) -> dict` thống kê), `main()` chỉ load env + connect
  (`connect_timeout`) + gọi. Luồng: (1) đọc từng nguồn — nguồn đọc
  OK + ≥1 record hợp lệ mới vào tập "nguồn tin cậy" (enumerate 4 biến
  thể trống ở Quy ước), dòng JSON hỏng → raise trước embed/ghi DB;
  (2) record product có `is_alcohol(name)` → bỏ cả record; mọi chunk
  `is_alcohol(chunk)` → bỏ khỏi public (chặn thừa bài viết nhắc rượu =
  chấp nhận theo F15.3); doc `catalog-products` dựng SAU khi bỏ SKU rượu
  (chunk catalog không còn dòng "Rượu ..."); (3) `doc_sha256` = sha256
  của (model embed, source, title, url, lang, danh sách chunk SAU lọc) —
  đổi model/keyword lọc → hash đổi → embed lại doc đó; (4) so với
  `doc_sha256` hiện có trong `chunks` → chỉ embed chunk của doc mới/đổi;
  (5) MỘT transaction: delete+insert doc đổi (`doc_version` = cũ+1, mới =
  1, `ingested_at` = now()), xóa doc không còn trong tập public của nguồn
  tin cậy (gồm doc bị lọc trọn — wc-991...), dòng legacy `source is null`
  không thuộc tập public chỉ xóa khi MỌI nguồn tin cậy (không để rượu
  legacy sót lại); `conn.commit()` tường minh; embed lỗi giữa chừng → 0
  ghi DB. In thống kê: doc mới/đổi/giữ/xóa, chunk bị lọc rượu theo
  nguồn, số lời gọi embed. Sửa docstring sai về xóa-nạp. UTF-8 guard.
  - Boundary: `ingest/embed_store.py`, `tests/test_embed_store.py` (mới)
  - Gate: `python -m pytest -q tests/test_embed_store.py` xanh, gồm:
    lần 2 không đổi gì = **0** lời gọi embed + 0 row đổi (`id`/
    `ingested_at` y nguyên); sửa body 1 record → embed đúng số chunk của
    doc đó, `doc_version` 2, doc khác không đổi `ingested_at`; gỡ 1 record
    → chunk của nó bị xóa; mỗi biến thể missing/0 byte/chỉ trắng/chỉ
    `_doc` của `products.jsonl` → 0 xóa chunk products LẪN `catalog`;
    dòng JSON hỏng → raise, 0 lời gọi embed, 0 ghi; embed raise ở batch 2
    → bảng không đổi; record rượu + chunk bài viết nhắc rượu không vào
    `chunks`, catalog không chứa "rượu"; legacy row `source null` của doc
    rượu bị xóa. DB thật `samsam_v39`: chạy `python -m
    ingest.embed_store` lần 1 (re-embed vì legacy chưa có hash — ~vài
    trăm chunk, < $0.01) rồi lần 2 → log lần 2 `0` lời gọi embed và
    `select count(*) from llm_usage where agent_id='ingest'` trước/sau
    lần 2 bằng nhau; quét toàn bảng `chunks` bằng `is_alcohol(content)`
    và `is_alcohol(title)` = **0**; `count(*) where source is null` = 0;
    chunk `catalog-products` chứa "Saphraton", không chứa "Rượu"
  - Evidence: `evidence/v39_ingest.log`
  - Kết quả: 14 test xanh. DB thật: lần 1 re-embed 871 chunk/167 doc (14 lời gọi, $0.0043), xóa 9 doc rượu; lần 2 `0` lời gọi, llm_usage ingest 14 -> 14; quét `is_alcohol` content/title = 0; `source is null` = 0; catalog có Saphraton, không có rượu.
- [x] **W39.4 `retrieve()` DENY-BY-DEFAULT + chatbot không trả rượu** —
  `api/rag.py`: `retrieve(question, k=TOP_K, *, collection="public")`;
  validate `collection` TRƯỚC khi gọi embed: `"public"` → `select ... from
  chunks` (không đổi) + bỏ row `is_alcohol(content)` hoặc
  `is_alcohol(title)` trước khi chấm điểm (lớp phòng thủ cho row nạp
  ngoài embed_store/legacy; pin `catalog-products` chỉ ở public);
  `internal:<phong>` khớp `^internal:[a-z0-9_]{1,32}$` → `from
  chunks_internal where collection = %s` (param, không f-string); giá
  trị khác (kể cả None, `""`, `"Public"`, `"internal:"`, `"chunks"`,
  `"internal:kd' or '1'='1"`) → `ValueError`, 0 lời gọi gateway. Connect
  thêm `connect_timeout`. `answer()` KHÔNG có tham số collection (kênh
  khách luôn public); sau check sức khỏe: `is_alcohol(question)` → trả
  `{"answer": NO_DATA, "sources": [], "handoff": "alcohol"}` không gọi
  LLM/embed (zalo + streamlit đã map NO_DATA → `HANDOFF_TEXT` hotline,
  không mời mua — KHÔNG sửa 2 file đó); có history → câu rewrite
  `_standalone` trúng rượu cũng trả như trên.
  - Boundary: `api/rag.py`, `tests/test_kb_acl.py` (mới, unit),
    `tests/test_kb_acl_db.py` (mới, DB thật)
  - Gate: unit xanh: fake conn ghi SQL — public chỉ chạm `chunks`,
    internal chỉ `chunks_internal` + param đúng collection; 7 giá trị
    collection sai → ValueError + 0 embed; row rượu (score cao nhất) bị
    loại khỏi hits/context; `"Rượu sâm giá bao nhiêu?"`, `"ruou sam No.9
    mua o dau"`, `"ginseng wine price"` → handoff `alcohol` + 0 chat/
    embed; câu thường giữ nguyên luồng (test_rag cũ xanh); `"collection"
    not in inspect.signature(answer).parameters`. DB thật (0 skipped):
    nạp 1 chunk `internal:test_v39` (nội dung "MẪU nội bộ ...", qua hàm
    nạp của W39.5, embed giả = vector q) + 1 chunk public `test-v39-ruou`
    "Rượu sâm ..." embedding = q; `rag.embed` giả trả q →
    `retrieve(...)` mặc định KHÔNG có 2 chunk đó; `collection=
    "internal:test_v39"` → top-1 là chunk mẫu; `finally` xóa + assert 0
    row `test-v39-%` trong `chunks` và 0 row `internal:test_v39`. Grep:
    `chunks_internal` trong `*.py` chỉ ở `api/rag.py`,
    `ingest/kb_internal.py`, `tests/`; `grep -rn "collection="
    connectors app scripts agents` rỗng; `git diff --stat
    connectors/zalo.py app/streamlit_app.py` rỗng. Probe sống (2 lời
    embed thật): `retrieve("Rượu sâm giá bao nhiêu?")` và
    `retrieve("Sâm Sâm có những sản phẩm nào?")` → 0 hit `is_alcohol`
  - Evidence: `evidence/v39_acl.log`
  - Kết quả: unit + DB thật xanh (0 skipped), dọn + assert 0 row test; grep gate đạt; zalo/streamlit không đổi; probe sống 2 câu -> 0 hit rượu. Vòng 3 (OWASP/perf): lọc rượu theo thứ tự điểm tới đủ k thay quét cả bảng (~0.4s/câu), catalog rượu không ghim.
- [x] **W39.5 CLI nạp tài liệu nội bộ đã duyệt `ingest/kb_internal.py`** —
  `python -m ingest.kb_internal --file <.md|.txt> --collection
  internal:<phong> --approved-by "<trưởng phòng>" [--doc-id <slug>]`.
  Validate HẾT trước connect + trước embed (lỗi → `ap.error`/exit 2):
  `--approved-by` bắt buộc, strip rỗng → lỗi; collection sai regex;
  file không tồn tại / 0 byte / chỉ trắng / đuôi khác `.md`/`.txt` /
  không decode UTF-8 strict / > 1MB. doc_id mặc định = slug stem file.
  `chunk_text` của embed_store; `doc_sha256` trùng bản đang có cùng
  (collection, doc_id) → 0 embed, in "không đổi"; đổi → delete+insert
  1 transaction, `doc_version`+1, `approved_by`/`approved_at`, commit
  tường minh. Print chỉ collection/doc_id/số chunk — KHÔNG in nội dung
  file. UTF-8 guard. File mẫu `tests/fixtures/kb_noi_bo_MAU.md` dòng
  đầu "MẪU — KHÔNG phải tài liệu thật của công ty".
  - Boundary: `ingest/kb_internal.py` (mới), `tests/test_kb_internal.py`
    (mới), `tests/fixtures/kb_noi_bo_MAU.md` (mới)
  - Gate: `python -m pytest -q tests/test_kb_internal.py` xanh: mỗi lỗi
    validate (thiếu/blank approved-by, 4 collection sai, missing/0 byte/
    trắng/đuôi lạ/byte non-UTF-8) → SystemExit 2, `connect` giả KHÔNG bị
    gọi, 0 embed; nạp lần 2 cùng file = 0 embed; sửa file → `doc_version`
    2, số chunk mới đúng; chunk ghi vào `chunks_internal`, KHÔNG vào
    `chunks`. Không chạy CLI này trên DB thật với tên người thật
  - Evidence: `evidence/v39_internal.log`
  - Kết quả: 18 test xanh (temp table, không ghi bảng thật); `chunks_internal` thật 0 row. External-dep: tài liệu thật + trưởng phòng duyệt (`--approved-by` người thật).
- [x] **W39.6 Báo cáo câu NO_DATA lặp lại `scripts/kb_gaps.py`** — 0 LLM
  (cụm bằng luật, F03d bước 6): đọc `data/conversations.jsonl` (+`.1`)
  qua `ingest.lead_store.iter_convlog`/`CONV_FILES` (BYTES + split
  `\n`), lấy record `answered is False`; khóa cụm = câu NFC + casefold +
  gộp khoảng trắng + bỏ dấu câu cuối; mỗi cụm: số lần, số `user_hash`
  khác nhau, ts gần nhất, cột "loại" (`sức khỏe` nếu
  `is_health_question`, `rượu` nếu `is_alcohol` — KHÔNG bổ sung KB cho 2
  loại này). `--min N` (mặc định 2), `--out <file.md>` (ghi atomic tmp +
  `os.replace`) hoặc stdout. Câu hiển thị qua `_mask_pii` lần nữa (entry
  cũ trước khi mask) + escape `|` cho bảng markdown. UTF-8 guard.
  - Boundary: `scripts/kb_gaps.py` (mới), `tests/test_kb_gaps.py` (mới),
    `AGENTS.md` (bảng Commands thêm 2 dòng `kb_internal`, `kb_gaps`)
  - Gate: `python -m pytest -q tests/test_kb_gaps.py` xanh: convlog
    tmp_path có câu lặp khác hoa/thường/khoảng trắng/dấu "?" gộp 1 cụm;
    `answered` true/thiếu/"false" (str) không đếm; dòng hỏng + U+2028
    (escape) không vỡ record; file thiếu → "0 câu" exit 0; SĐT trong
    câu bị mask ở output; `llm_gateway.chat`/`embed` giả raise → vẫn chạy
    xong (0 LLM); `python scripts/kb_gaps.py --min 1` trên convlog thật
    exit 0 (output không chứa chuỗi số ≥9 chữ số liền)
  - Evidence: `evidence/v39_gaps.log`
  - Kết quả: 8 test xanh (thêm escape `<`/`>` sau Phần B); convlog thật `--min 1` exit 0, 3 cụm, 0 chuỗi >=9 chữ số.
- [x] **W39.7 Gate chung** — chạy TUẦN TỰ, lệnh nặng có thể bị đẩy nền:
  đọc output tới khi process exit trước lệnh kế; không chạy chồng pytest.
  - Boundary: không file mới (chỉ evidence)
  - Gate: (1) targeted ×3 `python -m pytest -q tests/test_kb_filter.py
    tests/test_embed_store.py tests/test_kb_acl.py tests/test_kb_acl_db.py
    tests/test_kb_internal.py tests/test_kb_gaps.py tests/test_rag.py
    tests/test_handover_docs.py` — 3 lần 0 failed, 0 skipped; (2) full
    `python -m pytest -q` xanh, tổng ≥ 308 + test mới, 0 failed; (3)
    `ruff check .` clean; (4) `python -m py_compile pipelines/kb_filter.py
    ingest/embed_store.py ingest/kb_internal.py api/rag.py
    scripts/kb_gaps.py`; (5) DB thật sau mọi test: `chunks_internal` 0
    row `internal:test_v39`, `chunks` 0 row `test-v39-%`, quét
    `is_alcohol` trên `chunks` = 0; (6) `python scripts/eval_qa.py` exit
    0 (≥10/12 + Q11/Q12 bẫy pass; LLM thật qua gateway, vài cent) — nếu
    lọc rượu làm rớt câu (vd Q10 showroom nằm trong bài nhắc rượu) KHÔNG
    nới bộ lọc, ghi lại; (7) `git status` không file lạ (stage theo danh
    sách, không `add -A`; `lv2-market-top.png` giữ untracked), không
    runtime file mới trong `data/`
  - Evidence: `evidence/v39_pytest.log`, `evidence/v39_eval.log`
    (`*.log` gitignore → `git add -f`)
  - Kết quả: vòng 1 full đỏ 2 (drift-guard 14 bảng/cấm alter ở test_store/test_lead_store) -> vòng 2 xanh 407 -> vòng 3 (sau Phần B) targeted 114×3 xanh, full 409 passed 0 skipped, ruff sạch, py_compile OK, DB sạch. eval_qa 11/12 + 2 bẫy PASS, exit 0 (2 lần). Q5 (MST) FAIL do MST 4001036461 CHỈ nằm trong record rượu nv-RUOU-* đã lọc — KHÔNG nới bộ lọc; LLM BỊA MST khác nhau mỗi lần (0402021985 / 0402021234) — rủi ro bịa định danh có từ trước, cần bổ sung MST vào nguồn công khai không-rượu (chờ nguồn xác nhận).
  - Vòng sửa nghiệm thu (3 MAJOR + 3 MINOR): (1) `ruou_keywords.txt` thêm
    `alcohol`, `alcoholic`, `có cồn`, `đồ uống có cồn`, `liqueur`, `vodka`,
    `whisky`, `whiskey`, `brandy`, `soju`, `ginseng spirit(s)`, `distilled
    spirits` — KHÔNG thêm `spirits` đơn lẻ (truyền thuyết wp-1842 "forest
    spirits") và KHÔNG thêm bản không dấu `co con` (quét độc lập: 9 FP "có
    công"/"có con"/"đó còn"); vẫn CHỜ PHÁP CHẾ DUYỆT. embed_store lần 3:
    chỉ wp-1844 đổi (bỏ 3 chunk alcoholic, embed lại 2 chunk, 1 lời gọi),
    lần 4 = 0 lời gọi, llm_usage ingest 15→15. Gate rượu hết vòng tròn:
    `test_public_corpus_has_no_alcohol_independent_scan` (regex Postgres
    RIÊNG + `ilike '%alcohol%'` = 0, đỏ trước re-ingest với wp-1844) + quét
    regex rộng không dấu in từng hit (28 hit, review tay đều FP). (2) MST
    bịa — chọn hướng (b) hậu kiểm trong `answer()`: chuỗi ≥9 chữ số liền
    không có nguyên văn trong context/câu hỏi/history (so cả bản bỏ 1
    cách/chấm/gạch giữa 2 chữ số) → NO_DATA; eval Q5 nay NO_DATA (không
    còn MST bịa), Q8 hotline 1800577732 vẫn PASS, 11/12 exit 0. Giới hạn
    biết trước: số bịa viết có dấu chấm/cách ("0402.021.985") không bị bắt.
    Hướng (a) doc công khai MST vẫn chờ nguồn không-rượu xác nhận. (3) Test
    NFD viết escape + thêm case NFD chỉ-có-dấu ("nồng độ cồn", "đồ uống có
    cồn") — mutation bỏ NFC nay đỏ 2 test; U+2028 literal ở test_embed_store/
    test_kb_gaps đổi sang escape. Targeted 139×3 xanh, full 434 passed 0
    skipped, ruff sạch; DB sạch row test.

Someday (ngoài version): `--remove` thu hồi tài liệu nội bộ theo
(collection, doc_id) — hiện xóa bằng SQL tay; chunk sản phẩm lấy giá từ
`v_promotable`/golden thay dòng Giá crawl (F15.3 bước 5 — chờ GĐ duyệt
giá); chunk nội bộ lớp Vàng chỉ index tsvector không embed ra ngoài
(bước 6); `guardrail.check()` trên chunk public lúc ingest +
`kb_quarantine` theo URL (bước 4d); trợ lý nội bộ dùng
`retrieve(collection="internal:...")` (chưa có kênh tiêu thụ); câu hỏi
rượu ghi convlog `answered:false` nên vào queue "Chưa trả lời" (W39.6
gắn nhãn `rượu` để không bổ sung KB).

v3.9-kb-acl đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 6 finding — 2 MAJOR:
từ khóa rượu tiếng Anh/"có cồn" lọt bộ lọc; LLM bịa mã số thuế khi nguồn
duy nhất là record rượu đã bị loại → thêm `_unverified_number` trong
`answer()` (số ≥9 chữ số không có trong ngữ cảnh → NO_DATA) — 1 vòng sửa
→ PASS; coordinator chạy lại 434/434 + ruff). `eval_qa` 11/12, 2 bẫy
pass; Q5 (mã số thuế) giờ NO_DATA thay vì số bịa. Ingest DB thật lần 2
= 0 lời gọi embed. External-dep: tài liệu nội bộ thật + trưởng phòng
duyệt; Pháp chế duyệt `ruou_keywords.txt`; nguồn công khai xác nhận mã
số thuế (không nhắc rượu); GRANT role `webhook` trên cloud; pgvector.
Someday: số bịa viết có dấu chấm/cách ("0402.021.985") chưa bắt;
`--remove` tài liệu nội bộ; câu hỏi rượu đang rơi vào queue "Chưa trả
lời".

## Checklist v3.4-auth-approval

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-v34`)
— WP03 "khung điều phối, duyệt và log dùng chung" + phần đăng nhập của
WP02 (integ_architecture.md hàng "Hàng duyệt"; plan_data_platform.md §5
ma trận quyền DB + Mốc B "Streamlit có đăng nhập 6 vai trò"). Lỗ hiện có
(reviewer v2.x bắt): `pipelines/store.py::set_status` nhận `reviewer`
free-text (UI `st.text_input("Người duyệt *")`, CLI `--by`); mọi agent/app
dùng chung `DATABASE_URL` (owner/superuser local) nên `update
content_drafts set status='approved'` thẳng được — tự duyệt; không có bản
ghi "đã duyệt ĐÚNG nội dung nào"; không log hành động agent; Streamlit
không đăng nhập (ai mở URL cũng duyệt được); `content_drafts` không có cột
người tạo. Sau version: (a) DB chặn tự duyệt bằng QUYỀN chứ không bằng quy
ước — role `agent_writer` chỉ INSERT draft pending + SELECT; mọi chuyển
trạng thái chỉ qua function SECURITY DEFINER kiểm guardrail ok + người
duyệt ≠ người tạo; (b) mỗi quyết định ghi `approvals` kèm sha256 nội dung,
`verify_publish` so bản phát hành với bản đã duyệt; (c) `agent_action_log`
append-only có hash chain, sửa/xóa giữa chuỗi bị phát hiện; (d) Streamlit
fail-closed: không cấu hình `AUTH_MODE` = không vào được; identity lấy từ
header proxy hoặc đăng nhập local scrypt có khóa tạm; 6 vai trò map tab.

Quy ước: ponytail — stdlib (`hashlib.scrypt`, `hmac.compare_digest`,
`secrets`, `getpass`) + `psycopg` sẵn có, KHÔNG dep mới, KHÔNG cài
streamlit global (gotcha v1.9). Schema chỉ THÊM: 2 bảng mới `create table
if not exists` + `create or replace function/trigger` trong
`docs/schema.sql`; ngoại lệ DUY NHẤT `alter table content_drafts add column
if not exists created_by text` (không có cột người tạo thì không kiểm được
"duyệt ≠ tạo"); drift-guard `\b(alter|drop)\s+table\b` ở
`tests/test_store.py` + `tests/test_lead_store.py` nới HẸP: chỉ cho dạng
`alter table <tên> add column if not exists`, vẫn cấm `drop table` và mọi
`alter table` khác (drop/rename/alter column) — test thêm chuỗi cấm mẫu vẫn
bị bắt. Role/grant ở file RIÊNG `docs/roles.sql` (idempotent: `do $$` +
`if not exists (select from pg_roles ...)` → `create role ... nologin`;
`revoke` rồi `grant` lại; `usage on schema` cấp trên `current_schema()`
qua `format()` để chạy được trong temp schema của test). Role là NOLOGIN
(group role) — login user + mật khẩu do hạ tầng tạo ngoài git (`create
role <x> login password ... in role app_human`) → external-dep. Role là
cluster-global (cluster local dùng chung với worktree khác): chỉ tạo đúng
2 role `agent_writer`, `app_human`, không đụng/drop role khác. SECURITY
DEFINER: `set search_path from current` với search_path lúc tạo =
`<schema>, pg_temp` (pg_temp CUỐI — `scripts/apply_schema.py` và test đặt
tường minh trước khi chạy schema.sql) + `revoke execute ... from public`
ngay sau mỗi `create or replace function` (mặc định PG cho PUBLIC
execute). Trigger hash-chain là SECURITY DEFINER (agent_writer không có
SELECT log vẫn insert được). Hash canonical không phụ thuộc session
`TimeZone`/`DateStyle`: `row_hash = sha256(prev_hash ||
jsonb_build_array(id, actor, action, object_type, object_id, detail,
db_role, (extract(epoch from ts)*1000000)::bigint)::text)` — KHÔNG dùng
`ts::text`. sha256 nội dung byte-exact UTF-8, không normalize: PG
`encode(sha256(convert_to(t,'UTF8')),'hex')` == Python
`hashlib.sha256(t.encode('utf-8')).hexdigest()`. Ngày "không quá khứ"
trong function tính `(now() at time zone 'Asia/Ho_Chi_Minh')::date` (bài
học date-UTC v2.4). Mọi connect có `connect_timeout`; ghi trên conn chia
sẻ phải `conn.commit()` tường minh (gotcha savepoint v2.1). Print tiếng
Việt → UTF-8 guard. Test DB thật: 1 transaction + temp schema (`create
schema` + `set local search_path to <tmp>, pg_temp` + docs/schema.sql ×2 +
docs/roles.sql ×2) rồi ROLLBACK (precedent v3.2) — mỗi case lỗi trong
savepoint riêng; thử quyền bằng `set local role agent_writer|app_human`;
hàm store gọi `conn.commit()` → bọc `_TxConn` ghi nhận commit (precedent
v3.2), không commit thật temp schema. Test skip khi không có DB nhưng gate
yêu cầu 0 skipped. KHÔNG duyệt draft nào trên DB thật ngoài test rollback
(agent không tự đánh dấu người thật đã duyệt); mật khẩu/hash thật KHÔNG
vào git — test sinh mật khẩu lúc chạy. DB gate = DB riêng của worktree
(`DATABASE_URL` trong v34.env, owner là superuser local).

External-dep (KHÔNG giả lập, KHÔNG tự đánh dấu): SSO Cloudflare Access +
Google Workspace (DNS/domain công ty) — chỉ có cổng `AUTH_MODE=proxy`;
login user DB + mật khẩu và chạy `docs/roles.sql` trên cloud; TGĐ chốt ma
trận vai trò × tab + danh sách người duyệt; danh sách user/email thật cho
`data/users.json`; neo hash chain ra object-lock (WP03 anchor).

- [x] **W34.1 Schema: `created_by` + `approvals` + `agent_action_log`
  (hash chain, append-only)** — `docs/schema.sql` thêm block "v3.4 duyệt &
  log" (comment tiếng Việt: ai ghi, ai đọc, vì sao append-only):
  `alter table content_drafts add column if not exists created_by text`
  (null = draft trước v3.4 → không duyệt được, fail-closed); `approvals`
  (`id bigint identity pk`, `object_type text not null` (v3.4:
  `content_draft`), `object_id text not null`, `content_sha256 text not
  null check (~ '^[0-9a-f]{64}$')`, `decision text not null check in
  ('approved','rejected')`, `approved_by text not null check (btrim <>
  '')`, `approved_at timestamptz not null default now()`, `db_role text
  not null default session_user`, `note text`) + index (object_type,
  object_id, id); `agent_action_log` (`id bigint identity pk`, `ts
  timestamptz not null default now()`, `actor text not null check (btrim
  <> '')`, `action text not null`, `object_type text`, `object_id text`,
  `detail jsonb not null default '{}'`, `db_role text not null default
  session_user`, `prev_hash text not null`, `row_hash text not null
  unique`). Trigger `approvals` + `agent_action_log`: `before update or
  delete for each row` + `before truncate for each statement` → raise.
  Trigger `before insert` trên `agent_action_log` (SECURITY DEFINER):
  `pg_advisory_xact_lock(<hằng>)` tuần tự hóa, ÉP `ts=now()`,
  `db_role=session_user` (không tin client), `prev_hash` = `row_hash` dòng
  id lớn nhất hoặc 64 ký tự `0`, tính `row_hash` canonical (xem Quy ước) —
  giá trị client truyền vào prev/row_hash bị ghi đè. Function
  `verify_action_log()` returns table(`id bigint`, `problem text`) — rỗng =
  nguyên vẹn; `row_hash` (nội dung dòng bị sửa) / `prev_hash` (dòng trước
  bị xóa/chèn). Giới hạn ghi comment: xóa dòng CUỐI chuỗi không phát hiện
  được bằng chuỗi thuần (cần neo ngoài — external-dep).
  - Boundary: `docs/schema.sql` (append block + 1 dòng `alter ... add
    column if not exists`), `scripts/apply_schema.py` (đặt `search_path to
    public, pg_temp` trước khi chạy), `tests/test_auth_approval.py` (mới)
  - Gate: `python scripts/apply_schema.py` ×2 exit 0, lần 2 in 16 bảng
    (14 cũ + approvals, agent_action_log); `grep -c "^create table if not
    exists" docs/schema.sql` = 16; test DB (temp schema, rollback): 3
    insert → `verify_action_log()` rỗng, dòng đầu `prev_hash` = 64 `0`,
    dòng k `prev_hash` = `row_hash` dòng k-1; insert kèm `row_hash`/
    `prev_hash`/`ts`/`db_role` giả → bị ghi đè; UPDATE/DELETE/TRUNCATE log
    và approvals (superuser, trigger bật) → lỗi; superuser `set local
    session_replication_role = replica` rồi UPDATE `detail` dòng 2 →
    verify trả (id2, `row_hash`); DELETE dòng 2 (replica) → verify trả
    (id3, `prev_hash`); verify rỗng dưới cả `set local timezone 'UTC'` và
    `'Asia/Ho_Chi_Minh'` + `datestyle 'SQL, DMY'`; `content_sha256` sai
    định dạng → lỗi CHECK; parity sha PG ↔ Python cho chuỗi có dấu +
    `"\r\n"` + emoji (escape trong source, gotcha ký tự vô hình)
  - Evidence: `evidence/v34_auth.log`
- [x] **W34.2 Role tách quyền + function duyệt SECURITY DEFINER** —
  `docs/schema.sql` thêm function (SECURITY DEFINER, search_path ghim,
  revoke public): `approve_draft(p_id bigint, p_approver text, p_note text
  default null) returns bigint` (id approvals): `select ... for update`;
  raise (thông điệp tiếng Việt) khi approver rỗng / không tìm thấy /
  status ≠ pending / `guardrail->>'ok'` ≠ `'true'` / `created_by` null-rỗng
  / `lower(btrim(created_by)) = lower(btrim(p_approver))`; OK → set
  status/reviewer/reviewed_at/review_note + insert `approvals` (approved,
  sha256 `text` hiện tại) + insert `agent_action_log` (`draft_approve`) —
  cùng 1 transaction. `reject_draft(p_id, p_reviewer, p_note)` → pending →
  rejected + approvals `rejected` + log (người tạo tự rút bài được — không
  áp luật ≠). `schedule_draft(p_id bigint, p_day date, p_by text)` → chỉ
  approved, `p_by` không rỗng, `p_day` ≥ hôm nay VN, VÀ
  `verify_publish('content_draft', id, text hiện tại)` true → set
  `scheduled_date` + log. `verify_publish(p_object_type text, p_object_id
  text, p_content text) returns boolean` — quyết định MỚI NHẤT của object
  là `approved` VÀ sha256(p_content) = `content_sha256`; không có quyết
  định → false. `docs/roles.sql` (mới, idempotent): `agent_writer` —
  usage schema; `select` content_drafts; `insert (brief, channel, text,
  guardrail, source, created_by)` content_drafts; `insert (actor, action,
  object_type, object_id, detail)` agent_action_log; KHÔNG gì khác (không
  UPDATE/DELETE bảng nào, không approvals, không bảng khác, không execute
  function duyệt). `app_human` — `grant agent_writer to app_human` +
  `select` approvals, agent_action_log + `execute` approve_draft,
  reject_draft, schedule_draft, verify_publish, verify_action_log; KHÔNG
  UPDATE/DELETE trực tiếp. `scripts/apply_schema.py --roles` = schema.sql
  rồi roles.sql, in thêm 2 role; không cờ = như cũ.
  - Boundary: `docs/schema.sql`, `docs/roles.sql` (mới),
    `scripts/apply_schema.py`, `tests/test_auth_approval.py`
  - Gate: `python scripts/apply_schema.py --roles` ×2 exit 0; `python -c`
    in `select rolname, rolcanlogin from pg_roles where rolname in
    ('agent_writer','app_human')` → 2 dòng `False`; 4 function duyệt
    `prosecdef` true và `proconfig` search_path kết thúc `pg_temp`;
    `has_function_privilege('agent_writer','approve_draft(bigint,text,text)','execute')`
    = false. Test DB (temp schema, rollback, mỗi case savepoint) —
    `agent_writer`: `update content_drafts set status='approved'` →
    `InsufficientPrivilege`; update `reviewer`/`reviewed_at`/`text` →
    denied; insert kèm `status='approved'` → denied; insert 6 cột cho phép
    → OK, status `pending`; insert approvals → denied; `select
    approve_draft(...)` → denied; update/delete agent_action_log → denied;
    `select * from leads` → denied. `app_human`: update content_drafts
    trực tiếp → denied; approve_draft guardrail `ok=false` → lỗi;
    approver = creator (cả biến thể `' Lan '` vs `'lan'`) → lỗi;
    `created_by` null → lỗi; approver rỗng → lỗi; happy → status approved,
    đúng 1 dòng approvals sha = Python sha, 1 dòng log, verify_action_log
    rỗng; approve lần 2 → lỗi; schedule ngày hôm qua (VN) → lỗi; hôm nay
    VN → OK; superuser sửa `text` sau duyệt (replica) → verify_publish
    false + schedule_draft lỗi; reject → approvals `rejected`,
    verify_publish false
  - Evidence: `evidence/v34_auth.log`
- [x] **W34.3 `pipelines/store.py` duyệt qua function + CLI** —
  `save_draft(..., created_by=)` bắt buộc không rỗng (strip rỗng →
  `ValueError` trước khi chạm DB), ghi `created_by` + 1 dòng log
  `draft_create` cùng transaction. `set_status`: approve → chạy LẠI
  `pipelines.guardrail.check(text từ DB)` (snapshot jsonb do agent ghi có
  thể giả `ok:true`) — không ok → warn, KHÔNG gọi function; rồi `select
  approve_draft(%s,%s,%s)`; reject → `reject_draft`. `schedule(conn, id,
  day, by)` → `schedule_draft`. Lỗi function (`psycopg.Error`) → `(False,
  diag.message_primary)`, không raise; giữ pre-check Python (warn thân
  thiện). Hàm thuần `content_sha256(text)` + `verify_publish(conn,
  draft_id, text) -> bool`. CLI: `--schedule ID YYYY-MM-DD` giờ bắt buộc
  `--by` (thiếu/rỗng → usage exit 2 trước connect); op mới `--verify-log`
  (exit 0 "[ok] chuỗi nguyên vẹn (N dòng)", exit 1 in (id, problem), DB
  down → exit 2); `n_ops` đếm cả `--verify-log`. Docstring module cập nhật
  contract (function DB là nguồn sự thật; CLI `--by` vẫn free-text — tin
  người giữ DSN `app_human`, ghi rõ giới hạn).
  - Boundary: `pipelines/store.py`, `tests/test_store.py` (fake conn cập
    nhật), `tests/test_auth_approval.py`
  - Gate: `grep -nE "update +content_drafts" pipelines/store.py` rỗng;
    số test `tests/test_store.py` ≥ 20 (hiện có) và số `assert` không giảm
    (đối chiếu trước/sau, gotcha v1.7); test: snapshot `ok:true` nhưng text
    chứa "chữa" → warn, không gọi `approve_draft`; function raise →
    `(False, msg)`; `save_draft` created_by rỗng → ValueError, 0 execute;
    argparse: `--schedule` thiếu `--by` → exit 2, `--verify-log
    --pending` → exit 2, connect không được gọi (monkeypatch); test DB
    (rollback, `set local role app_human`, `_TxConn`): `save_draft` →
    `set_status` approve bởi người khác → approved + `verify_publish` true
    với đúng text, false với text sửa 1 ký tự; CLI trên DB thật CHỈ case
    âm: `python -m pipelines.store --approve 999999 --by X` exit 2 (không
    tìm thấy), `--verify-log` exit 0
  - Evidence: `evidence/v34_auth.log`
- [x] **W34.4 `pipelines/auth.py` — logic đăng nhập thuần (không import
  streamlit)** — `TABS` (7 tên tab, nguồn duy nhất — streamlit_app
  import), `ROLES = ('tgd','phap_che','gd_ban_hang','gd_marketing','mxh',
  'ha_tang')`, `ROLE_TABS` (đề xuất, TGĐ chốt = external-dep): tgd 7 tab;
  phap_che Chat, Content Studio, Chưa trả lời, Báo cáo, Duyệt & Lịch;
  gd_ban_hang Chat, Chưa trả lời, Leads, Báo cáo; gd_marketing Chat,
  Content Studio, Leads, Báo cáo, Duyệt & Lịch; mxh Chat, Content Studio,
  Chưa trả lời, Leads, Duyệt & Lịch; ha_tang Chat, Chưa trả lời, Báo cáo,
  Nhật ký vườn. `CAN_APPROVE = {tgd, phap_che, gd_marketing}`,
  `CAN_SCHEDULE = {tgd, gd_marketing, mxh}`; role lạ → không tab, không
  quyền. `auth_mode(env)` → `proxy|local|dev|blocked` (strip+lower; trống/
  lạ → `blocked`; `dev` khi `DEPLOY` truthy 1/true/yes → `blocked`).
  `identity_from_headers(headers, users)`: header
  `Cf-Access-Authenticated-User-Email` không phân biệt hoa thường, email
  strip+lower; thiếu/rỗng/không có trong users → None. `hash_password(pw)`
  → `scrypt$n$r$p$salt_hex$dk_hex` (n=2**14, r=8, p=1, salt 16 byte
  `secrets`); `verify_password` dùng `hmac.compare_digest`, chuỗi hỏng →
  False không raise. `load_users(path)` (`AUTH_USERS_FILE`, mặc định
  `data/users.json`) → {username_lower: {role, password_hash}}; file thiếu
  / rỗng / `{}` / chỉ `_doc` / JSON hỏng / role lạ → bỏ entry hoặc `{}`,
  không raise (không ai vào = fail-closed). `check_login(username, pw,
  users, now)`: sai `MAX_FAILS=5` lần liên tiếp → khóa `LOCK_SECONDS=300`
  theo `now` inject (không sleep); đang khóa thì mật khẩu ĐÚNG cũng từ
  chối; hết khóa → thử lại được; đúng → reset đếm; user không tồn tại vẫn
  đếm + chạy scrypt giả (đều timing), thông báo chung "sai tên đăng nhập
  hoặc mật khẩu"; state module-level + `threading.Lock`; khóa theo
  username (ghi docstring: DoS khóa 1 user chấp nhận ở pilot, state mất khi
  restart). CLI `python -m pipelines.auth --hash` đọc mật khẩu bằng
  `getpass` ×2 (không qua argv), in chuỗi hash. UTF-8 guard.
  - Boundary: `pipelines/auth.py` (mới), `tests/test_auth.py` (mới),
    `data/users.example.json` (mới), `.gitignore` (`data/users.json`),
    `env.example` (`AUTH_MODE=`, `AUTH_USERS_FILE=` + chú thích)
  - Gate: test ma trận đủ 6×7 (42 assert tab) + CAN_APPROVE/CAN_SCHEDULE;
    `auth_mode`: `None`/`''`/`'  '`/`'xyz'` → blocked, `' PROXY '` → proxy,
    `dev`+`DEPLOY=1` → blocked; header 3 biến thể hoa-thường; email ngoài
    users → None; hash roundtrip, sai mk False, 2 hash cùng mk khác nhau,
    chuỗi hỏng/`scrypt$REPLACE_ME` → False; lockout: 5 sai → lần 6 mk đúng
    vẫn từ chối, `now+300` → OK, user không tồn tại cũng bị khóa, đúng →
    reset; `load_users` đủ 6 biến thể file hỏng; `users.example.json`
    không chứa hash hợp lệ và mọi role thuộc ROLES; `.gitignore` có
    `data/users.json`; `python -c "import pipelines.auth, sys; assert
    'streamlit' not in sys.modules"` exit 0
  - Evidence: `evidence/v34_auth.log`
- [x] **W34.5 Streamlit: chặn trước tab, tab theo vai trò, duyệt bằng
  identity** — `app/streamlit_app.py`: trước `st.tabs`, `auth_mode` →
  `blocked`: `st.error` hướng dẫn đặt `AUTH_MODE` + `st.stop()`; `proxy`:
  `st.context.headers` → `identity_from_headers`, None → chặn; `local`:
  `st.form` user/mật khẩu (`type="password"`) → `check_login`, lưu
  identity+role vào `st.session_state` + nút đăng xuất; `dev`: banner
  "CHẾ ĐỘ DEV — không dùng thật", identity `dev`, role `tgd`. `st.tabs`
  chỉ tạo tab trong `ROLE_TABS[role]`; khối code tab không được phép KHÔNG
  chạy (không query DB). Studio: `save_draft(..., created_by=identity)`.
  Duyệt & Lịch: bỏ `text_input("Người duyệt *")` → hiện identity
  read-only; nút Duyệt disabled khi role ∉ CAN_APPROVE hoặc identity ==
  `created_by` (help nêu lý do); xếp lịch chỉ role ∈ CAN_SCHEDULE, truyền
  identity làm `by`. `tests/test_handover_docs.py::_tab_names` đổi sang
  đọc `TABS` từ `pipelines/auth.py` (regex/AST, không import streamlit) —
  giữ mọi assert cũ.
  - Boundary: `app/streamlit_app.py`, `tests/test_handover_docs.py`
    (`_tab_names`)
  - Gate: `python -m py_compile app/streamlit_app.py`; grep: `st.stop()`
    xuất hiện trước `st.tabs(`; `grep -n "Người duyệt \*"
    app/streamlit_app.py` rỗng; `save_draft(` trong app có
    `created_by=`; test_handover_docs xanh. UI E2E (TÙY CHỌN — venv tạm
    NGOÀI repo, không cài global, không sửa requirements): `AUTH_MODE=` →
    trang chặn, không tab; `AUTH_MODE=local` + users file tạm → sai 5 lần
    bị khóa, đúng → chỉ thấy tab theo role. Không dựng được venv → ghi "UI
    E2E chưa chạy" trong evidence, KHÔNG đánh dấu đã verify UI
  - Evidence: `evidence/v34_auth.log` (+ png nếu chạy E2E)
- [x] **W34.6 Docs + drift-guard đếm bảng** —
  `docs/handover/kien-truc.md`: "16 bảng", 2 dòng bảng mới + cột
  `content_drafts.created_by`; mục Human-gate "Duyệt content" cập nhật
  (function DB, người duyệt ≠ người tạo, sha256, log hash chain); mục mới
  "Phân quyền & đăng nhập" (2 role DB, 6 vai trò × tab, `AUTH_MODE`).
  `docs/handover/sop.md`: mục 4 (`--schedule ... --by`, `--verify-log`),
  mục 7 (bị khóa đăng nhập → chờ 5 phút/restart; verify-log báo lỗi → ai
  xử lý), mục 9 (`AUTH_MODE`, tạo `data/users.json` bằng `python -m
  pipelines.auth --hash`, `apply_schema.py --roles`, tạo login user DB
  `in role app_human|agent_writer` — lệnh mẫu không mật khẩu thật).
  `docs/deploy.md`: `AUTH_MODE=proxy` chỉ an toàn khi Streamlit bind
  `127.0.0.1` sau reverse proxy (header giả mạo được nếu lộ cổng).
  `AGENTS.md` Commands: `apply_schema.py --roles`, `python -m
  pipelines.auth --hash`, `python -m pipelines.store --verify-log`. Đếm
  bảng 14→16 ở `tests/test_store.py`, `tests/test_lead_store.py`,
  `tests/test_handover_docs.py` (chỉ số đếm + regex drift-guard nới hẹp
  như Quy ước); `SOP_COMMANDS` thêm `pipelines.auth`.
  - Boundary: `docs/handover/kien-truc.md`, `docs/handover/sop.md`,
    `docs/deploy.md`, `AGENTS.md` (Commands), 3 test trên (số đếm/regex)
  - Gate: `python -m pytest tests/test_handover_docs.py tests/test_store.py
    tests/test_lead_store.py -q` xanh; test drift-guard: chuỗi mẫu `drop
    table x` / `alter table x drop column y` / `alter table x rename to y`
    vẫn bị bắt, `alter table x add column if not exists y text` qua; số
    `assert` 3 file không giảm (đối chiếu trước/sau)
  - Evidence: `evidence/v34_pytest.log`
- [x] **Gate chung** —
  - `python scripts/apply_schema.py --roles` ×2 exit 0 (16 bảng, 2 role)
  - targeted ×3: `python -m pytest tests/test_auth.py tests/test_auth_approval.py tests/test_store.py tests/test_handover_docs.py tests/test_lead_store.py -q -rs`
    3 lần liên tiếp xanh, test DB **0 skipped** (đọc output tới exit,
    không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 308 + test mới
  - `ruff check .` sạch
  - `python -m py_compile pipelines/auth.py pipelines/store.py app/streamlit_app.py scripts/apply_schema.py`
  - sau toàn bộ gate trên DB thật: `approvals` = 0 dòng, `content_drafts
    where status <> 'pending'` = 0 (không row test sót, không tự duyệt);
    `python -m pipelines.store --verify-log` exit 0
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); `data/users.json` không tracked; diff không chứa
    hash scrypt hợp lệ / mật khẩu
  - External-dep (để `[ ]`): SSO Cloudflare Access + Google Workspace;
    login user DB + roles.sql trên cloud; TGĐ chốt ma trận + người duyệt;
    user/email thật; neo hash chain
  - Kết quả worker (vòng 1, 2026-10-12): apply_schema --roles ×2 exit 0
    (16 bảng, 2 role login=False); targeted ×3 = 76 passed ×3, 0 skipped;
    full 344 passed (308 + 36 mới); ruff sạch; py_compile exit 0; DB thật
    sau gate: approvals 0, draft non-pending 0, `--verify-log` exit 0;
    assert test_store 65→93, test_lead_store 67→68, test_handover_docs
    18→19. Evidence: `evidence/v34_auth.log`, `evidence/v34_pytest.log`,
    `evidence/v34_ui_e2e.log` + 3 png (phải `git add -f` các .log).
    UI E2E (tùy chọn) ĐÃ chạy bằng venv tạm ngoài repo (đã xóa): AUTH_MODE
    trống → chặn 0 tab; local sai 5 lần → lần 6 mk đúng vẫn khóa; đúng →
    gd_ban_hang 4 tab; proxy thiếu header → chặn. CHƯA E2E: proxy CÓ
    header (Playwright không gắn header vào WebSocket handshake — chỉ unit
    test) và form duyệt trong expander (DB thật 0 draft, không tạo draft
    thật) — chỉ py_compile + test store.
    Lệch nhỏ so contract (ghi rõ): id `agent_action_log` cách 2 (trigger
    cấp id SAU advisory lock để thứ tự id = thứ tự chuỗi khi chèn song
    song); trigger từ chối ghi log ngoài READ COMMITTED (chống rẽ nhánh
    chuỗi); schema.sql tự ghim `search_path = <schema>, pg_temp` (DO block
    đầu khối v3.4) cho cả khi chạy tay bằng psql; `python -m pipelines.auth
    --hash` đòi mật khẩu ≥10 ký tự; khóa đăng nhập log stderr kèm
    user_hash (không raw); nút Từ chối chỉ cho vai trò duyệt hoặc chính
    người tạo (rút bài); ô ngày xếp lịch mặc định ngày VN.
- [ ] **external-dep** SSO Cloudflare Access + Google Workspace (DNS/domain
  công ty) — chỉ có cổng `AUTH_MODE=proxy` + test header; chưa có proxy thật.
- [ ] **external-dep** Login user DB + mật khẩu (`in role app_human` /
  `agent_writer`) và chạy `docs/roles.sql` trên Postgres cloud; app/agent
  chuyển sang DSN theo role (local vẫn chạy bằng owner DSN — chặn quyền
  chỉ có hiệu lực khi dùng DSN role).
- [ ] **external-dep** TGĐ chốt ma trận 6 vai trò × tab + danh sách người
  được duyệt; danh sách user/email thật cho `data/users.json`.
- [ ] **external-dep** Neo hash chain ra object-lock (phát hiện xóa dòng
  cuối) — WP03 anchor.

Someday (ngoài phạm vi v3.4, ghi để không cuốn vào): `approval_queue` 2
lớp (auto_policy/per_item), `decisions` (override_qa/expired),
`record_publish`/`approve_spend`/`schedule_slot`; grant `app_human` cho
bảng khác theo plan §5 (leads, plot_logs...) + role `agent_llm`/`webhook`/
`loader`; lockout bền qua restart/đa process; gắn `session_user` ↔ người
(login riêng từng người) thay `--by` free-text; function DB tự kiểm
guardrail thay vì tin snapshot (hiện chỉ Python re-check — gọi thẳng
`approve_draft` bằng DSN `app_human` vẫn tin snapshot).

v3.4-auth-approval đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 7 finding —
1 MAJOR: biến `_auth` bị đè trong app làm tab Duyệt crash — → 1 vòng
sửa → PASS; coordinator chạy lại 355/355 + ruff + `--verify-log` exit
0). UI E2E 6/6 + 8/8 bằng venv tạm (đã xóa). External-dep: Cloudflare
Access + Google Workspace SSO; user đăng nhập DB + chạy `roles.sql`
trên cloud; TGĐ duyệt ma trận vai trò × tab và danh sách người duyệt;
danh sách user/email thật; neo hash chain vào object-lock. Giới hạn đã
nhận: local app vẫn connect bằng owner (DSN theo role chỉ dùng cho
CLI duyệt cho tới khi grant đủ bảng); xóa dòng log cuối không phát
hiện bằng chuỗi; `--by` CLI còn free-text.

## Checklist v3.10-dr-freeze

Khán giả/mục đích: nhánh `infra-v310` (M30, version cuối; worktree
`D:\code\samsam-v36`, tách từ `infra-v36`; DB `samsam_infra`) — luồng
F17.4 (diễn tập khôi phục, đo RPO/RTO) + luật đóng băng chung 21/12–10/02
(flows_infra.md §5, áp cho F17.1/F17.5) + agent "Vận hành hạ tầng"
(plan_data_platform.md) + bàn giao cho **người vận hành hạ tầng AI**
(lương 15tr, không phải dev). Hiện có: `scripts/db_backup.py` +
`scripts/db_restore_drill.py` (v3.6) khôi phục vào DB tạm trên CHÍNH
server đang chạy — chưa mô phỏng "mất server, dựng server mới"; chưa đo
RPO; lịch đóng băng chỉ nằm trong `data/eval/config.json` +
`scripts/deploy_gate.py` ở nhánh `infra-v35` (CHƯA gộp vào nhánh này);
không có break-glass; không có runbook hạ tầng. Sau version: (a) 1 lệnh
diễn tập DR dựng Postgres MỚI trong container docker tạm từ image có sẵn,
restore bản backup mới nhất, so số dòng manifest, đo RTO (gồm thời gian
dựng server) + RPO (tuổi bản backup), luôn dọn container; (b) lịch đóng
băng là 1 file data dùng chung + hàm thuần `pipelines/freeze.py` mà
`deploy_gate` gọi được sau khi merge; (c) break-glass có hạn, bắt buộc
lý do + người, append-only ngoài git, tự hết hạn; (d) runbook vận hành
hạ tầng có drift-guard chống lệnh ma.

Quy ước: ponytail — stdlib + `psycopg` + docker CLI sẵn có, KHÔNG dep
mới, KHÔNG tzdata (giờ VN = `timezone(timedelta(hours=7))`, VN không
DST). **TÁI DÙNG v3.6, không viết lại**: chọn manifest
(`db_restore_drill.pick_manifest`), sha256/giải mã/pg_restore/đếm/drop
(`db_restore_drill.run_drill`), resolver công cụ
(`db_backup.resolve_tool`/`_docker_has_image`), `append_jsonl`,
`scrub`, `inside_repo`/`dir_outside_repo`, `vn_now`, `private_umask`.
Thay đổi duy nhất được phép ở file v3.6: thêm tham số tùy chọn
`drill_server: str | None = None` cho `run_drill` (None → đọc
`DRILL_DATABASE_URL`/`DATABASE_URL` như cũ) — test v3.6 phải xanh nguyên
vẹn. KHÔNG tạo/sửa `scripts/deploy_gate.py`, `data/eval/` ở nhánh này
(tránh xung đột merge với `infra-v35`); đọc tham chiếu bằng `git -C
D:/code/samsam-v36 show infra-v35:scripts/deploy_gate.py`. Docker:
KHÔNG `docker pull` (mọi `docker run` có `--pull never`); image =
`postgres:<major>-alpine` với `<major>` từ `server_version` trong
manifest (máy có `postgres:17-alpine`, docker 28.4 đang chạy — đã kiểm
khi soạn contract). Mật khẩu container sinh ngẫu nhiên mỗi lần
(`secrets.token_urlsafe`), truyền bằng `-e POSTGRES_PASSWORD` KHÔNG kèm
giá trị (giá trị qua env subprocess), không in/ghi ra stdout/jsonl;
cổng chỉ bind `127.0.0.1` (`-p 127.0.0.1::5432`, đọc cổng bằng `docker
port`). Mọi subprocess có `timeout=`; mọi `psycopg.connect` có
`connect_timeout` (guard AST `tests/test_connect_timeout_guard.py` tự
quét file mới). Print tiếng Việt → UTF-8 guard. Nhật ký chạy là JSONL
NGOÀI repo, append BYTES + `\n` tường minh (gotcha convlog); đọc lại thì
bytes + split `\n` + `errors="replace"`, dòng hỏng bỏ qua có `[warn]`.
Thời gian trong logic (RPO, freeze, break-glass hết hạn) nhận tham số
`now` (aware datetime) — test KHÔNG dùng wall-clock/sleep. Test docker
thật skip khi thiếu docker/image/DB, nhưng gate yêu cầu chạy với **0
skipped** trên máy này.

External-dep (KHÔNG giả lập, KHÔNG gọi thật): Postgres cloud thật +
PITR phía nhà cung cấp (RPO ≤15 phút cho leads/orders/consent chỉ đạt
được bằng PITR — pg_dump ngày chỉ cho RPO ≤24h); VM diễn tập riêng (tách
runner CI); systemd timer 01:30/03:00; người ký biên bản diễn tập (Quản
lý hạ tầng AI); danh sách người giữ quyền break-glass (TGĐ theo
plan_data_platform — công ty cấp); kênh cảnh báo thật (n8n/Telegram,
nhánh v3.7); image postgres major mới (docker pull cần user duyệt).

- [x] **W310.1 `scripts/dr_drill.py` — DR drill trên Postgres docker
  tạm** — `python scripts/dr_drill.py [--backup <manifest>]`. Đọc
  `BACKUP_DIR` (ngoài repo — `bk.dir_outside_repo`, sai → usage exit 2),
  `BACKUP_PASSPHRASE_FILE` (khi bản mã hóa), `DATABASE_URL` (chỉ để
  guard tên; KHÔNG ghi gì vào server này), `DR_RPO_MAX_HOURS` (mặc định
  24, phải là số > 0, sai → exit 2 trước mọi thao tác docker),
  `load_dotenv(ROOT/.env)` trước khi đọc (như db_restore_drill.main).
  Thứ tự: (0) chọn manifest (`pick_manifest`), lấy `<major>` từ
  `server_version`; (1) probe `docker version --format
  {{.Server.Version}}` (timeout 20s) + `bk._docker_has_image(image)` —
  không có docker/daemon tắt/thiếu image → `[external-dep] ...` status
  `khong_chay`, exit 3, KHÔNG thử cách khác, KHÔNG pull; (2) `docker run
  -d --rm --pull never --name samsam-dr-<YYYYmmdd_HHMMSS>-<4 hex> -e
  POSTGRES_PASSWORD -p 127.0.0.1::5432 <image>`; (3) đọc cổng `docker
  port <name> 5432/tcp`; chờ sẵn sàng = `psycopg.connect(...,
  connect_timeout=2)` + `select 1` thành công, hạn `DR_READY_TIMEOUT_S`
  = 60 (quá hạn → fail); (4) gọi `run_drill(args, bdir, dsn,
  drill_server=<DSN container dbname=postgres>)` — sha256, giải mã,
  create DB `samsam_drill_...` TRONG container, pg_restore, đếm, drop đều
  do code v3.6 làm; (5) RTO_total = giây từ bước (2) tới xong đếm (gồm
  dựng server), giữ cả `restore_rto_seconds` của run_drill; RPO = `now -
  manifest.created_at` (giây) — hàm thuần `rpo_seconds(manifest, now)`;
  (6) `finally` (kể cả KeyboardInterrupt/exception bất kỳ): `docker rm
  -f <name>` rồi kiểm `docker ps -a --filter name=^/<name>$ --format
  {{.Names}}` rỗng → `container_removed`; còn → `[ALERT] container DR
  <name> chưa dọn — còn bản sao dữ liệu` + exit 1. In bảng so sánh của
  run_drill + `RTO`/`RPO` + so mục tiêu (RTO ≤ 4h, RPO ≤ DR_RPO_MAX_HOURS).
  Append `dr_runs.jsonl` trong `BACKUP_DIR`: `ts`, `backup_file`,
  `container`, `image`, `status` (ok|mismatch|fail|rpo_breach|khong_chay|
  cleanup_failed|refused), `rto_seconds`, `restore_rto_seconds`,
  `rpo_seconds`, `rpo_max_hours`, `tables_checked`, `mismatches`,
  `container_removed` — KHÔNG DSN/mật khẩu/cổng. Exit: 0 khớp hết + RPO
  trong mục tiêu + container đã dọn; 1 lệch/lỗi/RPO vượt mục tiêu
  (restore vẫn chạy để kiểm)/container chưa dọn; 2 usage/guard; 3 không
  chạy được vì docker (external-dep). Khởi động: thấy container
  `samsam-dr-*` sót từ lần trước → `[warn]` liệt kê tên (KHÔNG tự xóa
  container không phải của lần chạy này). Docstring tiếng Việt: khác gì
  db_restore_drill (server MỚI vs DB tạm trên server cũ), biến env, exit
  code, external-dep (VM diễn tập riêng/PITR).
  - Boundary: `scripts/dr_drill.py` (mới), `scripts/db_restore_drill.py`
    (chỉ tham số `drill_server` của `run_drill`), `tests/test_dr_drill.py`
    (mới)
  - Gate: (thật, `SCR=<scratchpad>`, `BACKUP_DIR=$SCR/v310_bk`) `python
    scripts/db_backup.py` exit 0 → `python scripts/dr_drill.py` exit 0,
    in 14 bảng khớp + `RTO` + `RPO`; `dr_runs.jsonl` dòng cuối
    `status=ok`, `container_removed=true`, `tables_checked=14`; ngay sau
    đó `docker ps -a --filter name=samsam-dr- --format {{.Names}}` rỗng;
    trên server `DATABASE_URL`: `select count(*) from pg_database where
    datname like 'samsam\_drill\_%'` = 0 và `count(*)` 14 bảng trước/sau
    bằng nhau (drill KHÔNG đụng server thật); `grep -c` mật khẩu container
    (test đọc từ env subprocess bị monkeypatch-capture) + mật khẩu
    `DATABASE_URL` trong `dr_runs.jsonl` = 0. Test unit (không docker,
    monkeypatch `subprocess.run`): argv `docker run` có `--pull never`,
    `--rm`, `-p 127.0.0.1::5432`, `-e POSTGRES_PASSWORD` (không `=`), tên
    khớp `^samsam-dr-\d{8}_\d{6}-[0-9a-f]{4}$`, KHÔNG chứa mật khẩu;
    `docker` không có trên PATH / `docker version` exit≠0 / image thiếu →
    exit 3 `status=khong_chay`, KHÔNG gọi `docker run`/`pull`;
    `run_drill` raise giữa chừng → `docker rm -f` VẪN được gọi; `docker
    ps -a` sau rm còn tên → exit 1 `status=cleanup_failed` + `[ALERT]`;
    `rpo_seconds` với `now` = created_at + 30h và max 24 → `rpo_breach`
    exit 1 (không wall-clock); `DR_RPO_MAX_HOURS=0`/`-1`/`abc` → exit 2
    trước khi gọi docker. Test E2E docker thật (0 skipped): backup vào
    tmp_path (pattern `clean_env` của `tests/test_db_backup.py` — chặn
    `.env` BACKUP_* thật) → dr_drill exit 0, container đã dọn; manifest
    sửa `row_counts` 1 bảng +1 → exit 1 `status=mismatch` và container
    VẪN bị dọn; sau toàn bộ test: 0 container `samsam-dr-*`, 0 DB
    `samsam_drill_%` trên server thật. `python -m pytest
    tests/test_db_backup.py -q` vẫn xanh (run_drill tương thích ngược)
  - Evidence: `evidence/v310_dr.log` — 14/14 bảng khớp, RTO 5.84s (restore
    1.83s), RPO 1s, `status=ok`, `container_removed=true`; sau đó 0
    container `samsam-dr-*`, 0 DB `samsam_drill_%`, số dòng 14 bảng
    trước=sau; mật khẩu DB/DSN trong `dr_runs.jsonl` = 0 (mật khẩu
    container: test E2E spy env subprocess). E2E docker thật 0 skipped.
  - Fix-round nghiệm thu (MAJOR A04 volume + MAJOR drill_server + MINOR
    flake pg_database): (1) image khai báo `VOLUME
    /var/lib/postgresql/data` → mỗi `docker run` sinh anonymous volume,
    `rm -f` không `-v` để lại bản sao dữ liệu khôi phục trên đĩa (auditor
    thấy 2 volume `f554e763…`, `ff085997…` chứa WAL drill). Vá:
    `docker run` mount `--tmpfs` lên mọi VOLUME của image
    (`image_volumes`, đọc `docker image inspect .Config.Volumes`, lỗi →
    PGDATA mặc định) → dữ liệu chỉ trong RAM; `cleanup` = `docker rm -f
    -v` + ghi nhận volume (`container_volumes`, ngay sau run và trước
    rm) + kiểm `docker volume ls` — còn volume → `container_removed=
    false`, `cleanup_failed`, `[ALERT] ... docker volume rm`. Test:
    `test_docker_run_argv_safe` (`--tmpfs`, `rm -f -v`),
    `test_cleanup_checks_container_volumes`, `test_cleanup_volume_gone_ok`,
    `test_image_volumes_fallback`; E2E `_assert_no_volume_left` (volume
    container ngay sau run = ∅). (2) Khóa hồi quy "khôi phục vào
    container, không vào server thật": unit
    `test_run_drill_restores_into_drill_server` (mọi connect + env
    pg_restore = drill_server, không `dsn`/`DRILL_DATABASE_URL`); E2E
    fixture `trace` spy `psycopg.connect`/env pg_restore/`host_port` →
    `_assert_restored_into_container` (mọi kết nối trong `dd.main` tới
    `127.0.0.1:<docker port>`). (3) Bỏ `set(_drill_dbs) <= before`
    (pg_database cluster-wide, worktree song song tạo
    `samsam_drill_test_*` hợp lệ) → chỉ kiểm DB drill CỦA lần chạy này
    (spy `rd.default_target`) không tồn tại trên server thật. Mutation
    (plugin `pytest -p`, không sửa source): bỏ qua drill_server → 3 đỏ
    (unit + 2 E2E); cleanup cũ → 3 đỏ; bỏ `--tmpfs` → 2 E2E đỏ. Chạy
    thật: 0 volume mới, 0 container `samsam-dr-*`. 2 volume sót từ lần
    chạy TRƯỚC fix KHÔNG tự xóa (xóa dữ liệu vĩnh viễn — chờ user
    duyệt): `docker volume rm f554e76395d2… ff08599746eb…` (id đầy đủ
    trong `evidence/v310_dr.log`).
- [x] **W310.2 `data/freeze_calendar.json` + `pipelines/freeze.py` —
  lịch đóng băng dùng chung** — File data (commit được, không secret):
  `_doc` (nguồn: flows_infra.md §5, ngày Asia/Saigon gồm cả 2 đầu, bản
  dev soạn CHƯA được công ty duyệt), `windows`: [{`name`, `start`
  "2026-12-21", `end` "2027-02-10"}] (khớp `freeze` của
  `infra-v35:data/eval/config.json`), `allowed_in_freeze`: ["hotfix",
  "disable", "restore"] (hotfix tầng 2; tắt/hạ cấp agent; khôi phục
  ĐÚNG trạng thái trước kill), `known_kinds`: thêm "feature", "promote",
  "config", "migration", `break_glass_max_hours`: 4,
  `break_glass_holders`: [] (external-dep). Module `pipelines/freeze.py`
  (không I/O ngoài đọc 2 file, không print, không DB):
  `load_calendar(path=CALENDAR) -> dict` — validate; `is_frozen(when,
  calendar=None) -> bool` — `when` là `date` (ngày VN) hoặc `datetime`
  AWARE (đổi sang +07:00 rồi lấy ngày); datetime naive → `ValueError`,
  kiểu khác → `TypeError`; `check(change_kind, now, calendar=None,
  windows=None) -> tuple[bool, str]` — kind không thuộc `known_kinds` →
  `ValueError` (cả trong lẫn ngoài đóng băng); ngoài đóng băng → (True,
  ...); trong đóng băng: kind ∈ allowed → (True, ...), có break-glass
  còn hạn tại `now` → (True, lý do nêu người + giờ hết hạn), còn lại →
  (False, lý do có khung ngày + "chỉ hotfix/tắt agent/khôi phục").
  `windows=None` → đọc log break-glass theo env `BREAK_GLASS_LOG` (không
  set → không có cửa sổ). Lịch hỏng → FAIL-CLOSED trong `check`: coi như
  đang đóng băng (kind thường bị chặn, lý do "lịch đóng băng lỗi"), không
  crash; `load_calendar`/`is_frozen` raise `FreezeConfigError`. Biến thể
  lịch hỏng PHẢI enumerate đủ (gotcha missing≠0-record): file mất, file
  rỗng 0 byte, `{}`, chỉ `_doc`, `windows: []`, JSON hỏng, `start > end`,
  ngày sai định dạng (`"2026-12-21x"`, `"21/12/2026"`), kind trong
  `allowed_in_freeze` không thuộc `known_kinds`. Điểm nối sau merge với
  `infra-v35` (ghi ở đây, KHÔNG làm ở nhánh này): `deploy_gate.check()`
  thay khối `cfg["freeze"]` bằng `freeze.check("hotfix" if hotfix else
  "feature", now=datetime.combine(today, time(12), VN_TZ))`, bỏ key
  `freeze` khỏi `data/eval/config.json` → 1 nguồn sự thật
  `data/freeze_calendar.json`; F17.5 bật lại agent dùng kind "restore".
  - Boundary: `data/freeze_calendar.json` (mới), `pipelines/freeze.py`
    (mới), `tests/test_freeze.py` (mới)
  - Gate: `python -m pytest tests/test_freeze.py -q` xanh, gồm: biên
    ngày `2026-12-20T23:59:59+07:00` không đóng băng,
    `2026-12-21T00:00:00+07:00` đóng băng, `2026-12-20T17:00:00+00:00`
    (= 00:00 VN 21/12) đóng băng, `2027-02-10T23:59:59+07:00` đóng băng,
    `2027-02-11T00:00:00+07:00` không, `date(2026,12,21)` đóng băng;
    naive datetime → ValueError, str → TypeError; trong đóng băng
    `check("feature")`/`"promote"`/`"config"`/`"migration"` → False,
    `"hotfix"`/`"disable"`/`"restore"` → True; ngoài đóng băng
    `"feature"` → True; `check("deploy_moi")` → ValueError; 9 biến thể
    lịch hỏng → `check("feature", now trong lẫn NGOÀI khung)` → False
    (fail-closed) và `check("hotfix")` → True; drift-guard: lịch chứa
    đúng khung `2026-12-21`..`2027-02-10` (khớp v3.5 — đổi ngày phải sửa
    cả hai). `grep -nE "print\(|psycopg|subprocess" pipelines/freeze.py`
    rỗng (hàm thuần)
  - Evidence: `evidence/v310_pytest.log` — 10 biến thể lịch hỏng (9 loại,
    ngày sai định dạng 2 mẫu) fail-closed; lịch hỏng KHÔNG xét break-glass.
- [x] **W310.3 `scripts/break_glass.py` — cửa sổ ngoại lệ có hạn** —
  argparse nhóm loại trừ BẮT BUỘC đúng 1 op (gotcha CLI nhiều flag →
  usage exit 2): `--open --reason "<lý do>" --by "<người>" [--hours
  1..4]` (mặc định 2, trần = `break_glass_max_hours` của lịch), `--status`
  (chỉ đọc), `--close --by "<người>" --reason "<lý do>"` (đóng sớm mọi
  cửa sổ còn hạn). Log = env `BREAK_GLASS_LOG` (đường dẫn file, BẮT BUỘC,
  NGOÀI repo — `bk.inside_repo`; thiếu/trong repo → exit 2, không tạo
  file); append-only: chỉ mở `"ab"`, 1 dòng JSON/record (`action`
  open|close, `ts`, `opened_at`, `expires_at` ISO +07:00, `hours`, `by`,
  `reason`, `holder_verified`), KHÔNG bao giờ rewrite/xóa dòng. `reason`
  bắt buộc ≥ 10 ký tự sau strip và qua `pipelines.pii._mask_pii` trước
  khi ghi; `--by` bắt buộc, strip không rỗng, ≤ 80 ký tự. Holders: lịch
  `break_glass_holders` rỗng → vẫn mở + `[CẢNH BÁO] danh sách người giữ
  quyền break-glass chưa được công ty cấp (external-dep)` +
  `holder_verified=false` (KHÔNG tự coi là đã xác minh); không rỗng mà
  `--by` không thuộc (casefold/strip) → exit 2, không ghi. Mở thành công
  in `[CẢNH BÁO] BREAK-GLASS mở tới <giờ VN> bởi <by> — mọi thay đổi
  trong đóng băng được cho qua tới khi hết hạn`; mở ngoài khung đóng
  băng → vẫn mở + `[warn]` không cần thiết. Reader ở `pipelines/freeze.py`:
  `load_break_glass(path) -> list[dict]` (bytes + split `\n`, dòng hỏng/
  thiếu key/datetime naive → bỏ qua) và `active_break_glass(records,
  now) -> dict | None`: còn hạn khi `opened_at <= now < expires_at`, với
  `expires_at` bị CẮT về `opened_at + break_glass_max_hours` (log sửa
  tay ghi 48h vẫn chỉ 4h hiệu lực), `opened_at` ở tương lai → không hiệu
  lực, có record `close` sau `opened_at` và ≤ `now` → hết hiệu lực.
  `main(argv, now=None)` nhận `now` cho test.
  - Boundary: `scripts/break_glass.py` (mới), `pipelines/freeze.py`
    (reader), `tests/test_freeze.py`
  - Gate: test (tmp_path, `now` tham số, 0 sleep): mở lúc T với 2h →
    `check("feature", now=T+1h trong khung)` True, `now=T+2h` False (hết
    hạn đúng biên), `now=T-1s` False; `--hours 5` / `0` → exit 2 không
    ghi; record sửa tay `expires_at=T+48h` → tại T+5h không hiệu lực;
    `--close` lúc T+30m → T+31m False; thiếu `--reason`/reason 9 ký tự/
    thiếu `--by`/`--by "  "` → exit 2, file không đổi byte; `--open
    --status` cùng lúc → exit 2; `BREAK_GLASS_LOG` trong repo → exit 2
    không tạo file; log chứa dòng JSON hỏng + dòng ghi dở không `\n` +
    reason có `\u2028` (viết escape trong test) → reader không crash, đọc
    đúng record hợp lệ; reason chứa SĐT `0905 123 456` → log không còn
    `0905123456`/`0905 123 456`; 2 lần `--open` → file chỉ dài thêm (byte
    đầu giữ nguyên — append-only); holders `["Tên A"]` + `--by "Tên B"` →
    exit 2. Chạy tay: `BREAK_GLASS_LOG=$SCR/v310_bg.jsonl python
    scripts/break_glass.py --open --reason "..." --by "..." ` in cảnh báo;
    `--status` liệt kê cửa sổ còn hạn
  - Evidence: `evidence/v310_dr.log` (chạy tay open/status/close + usage
    exit 2 + log trong repo exit 2) — vòng 2 OWASP: reader bỏ record có
    `by` chứa ký tự điều khiển, `--status` thay ký tự điều khiển trong
    reason, `main` chạy dưới `private_umask`.
  - Fix-round nghiệm thu (2 MINOR): `test_reader_skips_bad_lines` trước
    đó nhúng U+2028 LITERAL (vô hình khi review) → nay viết escape
    `"dòng\u2028có ký tự lạ"` (0 byte e2 80 a8 trong source), assert byte
    U+2028 thật có trong dòng log (`ensure_ascii=False`), reader đọc đúng
    1 record giữ nguyên `\u2028`, `--status` không in raw U+2028 (thay
    `?`). Mutation reader → `splitlines()`: test đỏ.
- [x] **W310.4 `docs/handover/runbook-ha-tang.md` + drift-guard** —
  tiếng Việt, mở đầu "dành cho ai / làm gì / cần gì" (người vận hành hạ
  tầng AI, không phải dev). Mục: (1) lịch việc ngày/tuần/tháng (ngày:
  đọc `backup_runs.jsonl` dòng cuối, bản tin sức khỏe; tuần Chủ nhật:
  `db_restore_drill`; tháng + trước 30/11 và 18/12: `dr_drill` + soạn
  biên bản để Quản lý hạ tầng AI ký — external-dep); (2) mức sự cố
  S1/S2/S3 — mỗi mức: ví dụ cụ thể (S1: vi phạm guardrail tới khách / DB
  mất / lộ dữ liệu cá nhân → báo TGĐ + Pháp chế, 72 giờ; S2: backup/drill
  fail, job lỗi, chạm 80–100% trần; S3: cảnh báo lẻ), thời gian phản hồi,
  ai được gọi, bước đầu tiên; (3) backup/drill/DR/khôi phục đè production
  (tầng 2, người làm tay, không có lệnh tự động — trỏ `sop.md` mục 6);
  RPO/RTO mục tiêu và giới hạn (pg_dump ngày → RPO ≤24h; ≤15 phút cần
  PITR external-dep); (4) đóng băng 21/12–10/02 + loại thay đổi được
  phép + break-glass (khi nào, ai, tối đa 4h, đóng sớm, đọc log); (5)
  kill switch LLM: thêm agent_id vào `"kill"` trong
  `data/llm_gateway.json` (đọc lại mỗi lời gọi — có hiệu lực không cần
  restart) hoặc env `LLM_KILL` (cần restart tiến trình); danh sách
  agent_id lấy bằng grep lời gọi `chat("...")`/`embed("...")` thật trong
  repo; bật lại trong đóng băng = kind "restore" có RCA; (6) cap chi phí:
  `monthly_cap_usd` theo agent, `LLM_CAP_DEFAULT_USD`, ngưỡng 80% cảnh
  báo/100% chặn, cap 0 = tắt, câu SQL xem chi tiêu tháng từ bảng
  `llm_usage`; (7) bản tin sức khỏe `python scripts/health_bulletin.py`
  ghi "(nhánh khác: v3.7)"; cổng deploy `python scripts/deploy_gate.py`
  ghi "(nhánh khác: v3.5)"; (8) checklist bàn giao `- [ ]` (≥ 6 mục: đọc
  runbook, chạy 1 backup + 1 drill + 1 dr_drill có người kèm, thử
  break-glass trên log tạm, thử kill switch trên agent `smoke`, nhận danh
  sách người giữ break-glass/khóa mã hóa — external-dep, ký biên bản).
  Không giá trị secret/DSN thật. `docs/handover/sop.md` thêm 1 đoạn ngắn
  trỏ tới runbook + 2 lệnh `dr_drill`, `break_glass` (cuối mục 6, không
  sửa nội dung cũ).
  - Boundary: `docs/handover/runbook-ha-tang.md` (mới),
    `docs/handover/sop.md` (thêm cuối mục 6), `tests/test_runbook.py`
    (mới), `tests/test_handover_docs.py` (`DOC_FILES` thêm
    `"runbook-ha-tang.md"`, `SOP_COMMANDS` thêm `"dr_drill"`,
    `"break_glass"` — chỉ append, không xóa phần tử/assert cũ)
  - Gate: `python -m pytest tests/test_runbook.py
    tests/test_handover_docs.py -q` xanh. `tests/test_runbook.py`: (a)
    trích mọi lệnh `python` (regex trên toàn văn: `python\s+-m\s+
    ([\w.]+)` và `python\s+([\w./-]+\.py)`), bỏ `-m pytest|py_compile|
    venv|pip`; mỗi lệnh phải trỏ file có thật (`a/b.py` hoặc
    `a/b/__init__.py` cho `-m a.b`) HOẶC dòng chứa nó có `(nhánh khác:
    v\d+\.\d+)`; đếm ≥ 10 lệnh được kiểm (guard không rỗng); (b) chống
    pass-ảo: chạy cùng hàm kiểm trên chuỗi mẫu `python
    scripts/khong_co.py` và `python -m agents.khong_co` → bị bắt; thêm
    `(nhánh khác: v3.7)` cùng dòng → qua; (c) runbook chứa `S1`, `S2`,
    `S3`, `LLM_KILL`, `data/llm_gateway.json`, `monthly_cap_usd`,
    `21/12`, `10/02`, `break_glass`, `dr_drill`, `db_backup`,
    `db_restore_drill`, `RPO`, `RTO`, `external-dep`; mỗi agent_id parse
    từ code thật trong `api/`, `pipelines/`, `ingest/`, `agents/`,
    `connectors/` — cả literal `chat("x"`/`embed("x"` (hiện: `content`,
    `ingest`) lẫn hằng module `AGENT = "x"` (hiện: `api/rag.py` →
    `chatbot`) — có mặt trong runbook (word-boundary — gotcha drift-guard
    substring); parse ra < 3 id → test đỏ (guard không rỗng); `health_bulletin` và `deploy_gate` chỉ xuất
    hiện trên dòng có `(nhánh khác: ...)`; ≥ 6 dòng `- [ ]`; (d) không
    dòng nào khớp `postgresql://[^<\s:/]+:[^<\s@]+@` hoặc `sk-or-v1`.
    Mutation ghi evidence: tạm đổi 1 lệnh trong runbook thành
    `scripts/khong_co.py` → test đỏ, hoàn lại → xanh
  - Evidence: `evidence/v310_pytest.log` — mutation `zalo_preflight.py`→
    `khong_co.py` đỏ, hoàn lại xanh.
  - Fix-round nghiệm thu (MINOR `smoke`): `smoke` không có luồng thật
    nào gọi (chỉ là key cap trong `data/llm_gateway.json`) → runbook mục
    5 sửa thành "id dành riêng để tập kill switch" + thêm lệnh kiểm chạy
    được `python -c "from pipelines import llm_gateway as g;
    g._gate('smoke'); ..."` (không gọi LLM): kill → `GatewayBlocked`,
    chưa kill → `OK: smoke NOT blocked`; checklist bàn giao trỏ lệnh này.
    Test `test_kill_switch_check_command_runs` exec đúng dòng lệnh trong
    runbook ở cả 2 trạng thái (LLM_KILL env, `_month_spend` stub).
- [x] **Gate chung** — (vòng 2: targeted 159 passed ×3, 0 skipped; full
  460 passed; ruff sạch; diff deploy_gate/data/eval rỗng; 14 bảng 383
  dòng trước=sau; `evidence/*.log` cần `git add -f`)
  - đếm trước: `count(*)` 14 bảng `samsam_infra` (in bằng `python -c`,
    không in DSN); `docker ps -a --filter name=samsam-dr-` rỗng
  - targeted ×3: `python -m pytest tests/test_dr_drill.py tests/test_freeze.py tests/test_runbook.py tests/test_handover_docs.py tests/test_db_backup.py tests/test_connect_timeout_guard.py -q -rs`
    3 lần liên tiếp xanh, **0 skipped** (gate nặng có thể bị đẩy nền —
    đọc output tới khi process exit rồi mới chạy lần kế; không chạy chồng,
    không retry mù)
  - full: `python -m pytest -q` xanh, ≥ 360 + test mới (baseline 360)
  - `ruff check .` sạch
  - `python -m py_compile scripts/dr_drill.py scripts/break_glass.py pipelines/freeze.py scripts/db_restore_drill.py`
  - `python -c "import json; json.load(open('data/freeze_calendar.json', encoding='utf-8'))"` OK
  - `git diff --stat infra-v36 -- scripts/deploy_gate.py data/eval` rỗng
    (không đụng file của v3.5)
  - sau toàn bộ gate: `count(*)` 14 bảng `samsam_infra` bằng lúc đầu; 0
    DB `samsam_drill_%`; 0 container `samsam-dr-*`; không file `*.dump*`/
    `*.jsonl` mới trong repo (log break-glass, dr_runs nằm ở scratchpad)
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file runtime mới trong `data/` (ngoài
    `data/freeze_calendar.json` là config commit được)
  - External-dep (để `[ ]`): xem các mục dưới
- [ ] **external-dep** Postgres cloud thật + PITR phía nhà cung cấp; diễn
  tập PITR ra instance tạm 30/11 và 18/12 (RPO ≤15 phút leads/orders/
  consent chỉ đo được ở đây); VM diễn tập riêng tách runner CI thay cho
  container docker trên máy dev.
- [ ] **external-dep** systemd timer (backup 01:30, drill Chủ nhật 03:00,
  dr_drill hằng tháng) trên VM; kênh cảnh báo thật cho `dr_runs`/
  `drill_runs` (n8n/Telegram — nhánh v3.7).
- [ ] **external-dep** Công ty duyệt lịch đóng băng + cấp danh sách người
  giữ quyền break-glass (`break_glass_holders`); Quản lý hạ tầng AI ký
  biên bản diễn tập DR; người vận hành hạ tầng AI nhận bàn giao theo
  checklist runbook (ký).
- [ ] **external-dep** Image postgres major mới khi server cloud đổi
  major (docker pull cần duyệt); gộp `infra-v35` + nối `deploy_gate` vào
  `pipelines/freeze.check` (điểm nối ghi ở W310.2).

Someday (ngoài phạm vi v3.10, ghi để không cuốn vào): bảng
`dr_runs`/`break_glass_log` trong DB (agent_action_log của v3.4) thay
jsonl; tự soạn biên bản diễn tập từ `dr_runs.jsonl` qua `agents/report.py`;
lịch đóng băng lặp hằng năm (hiện liệt kê từng khung); `deploy_gate`
đọc break-glass; checksum mẫu nội dung + `test_core_store` trên DB DR;
`dr_drill` khôi phục từng bảng + đo RTO theo bảng.

## Checklist v3.6-cloud-db-backup

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-v36`,
DB `samsam_v36`) — WP02 "Postgres managed trong nước", luồng F17.4
(Backup, PITR, diễn tập khôi phục), agent "Vận hành hạ tầng"
(plan_data_platform.md, flows_infra.md). Hiện DB chỉ chạy local, backup là
1 lệnh `pg_dump` gõ tay trong `docs/handover/sop.md` mục 6, không manifest/
sha256/retention/diễn tập; 7 chỗ `psycopg.connect` chưa có
`connect_timeout` (gotcha v1.9: host chết là treo). Sau version: (a) mọi
connect Postgres trong code có `connect_timeout`, có test chặn tái phát;
(b) 1 lệnh backup ra file `pg_dump -Fc` nhất quán snapshot + manifest
(sha256, size, số dòng 14 bảng) + retention + bản sao offsite qua adapter
+ mã hóa tùy chọn; (c) 1 lệnh diễn tập khôi phục bản mới nhất vào DB TẠM,
so số dòng với manifest, đo RTO, xóa DB tạm, KHÔNG BAO GIỜ đè DB đang dùng;
(d) tài liệu + env mẫu để chuyển lên Postgres managed trong nước khi công
ty cấp tài khoản.

Quy ước: ponytail — stdlib + `psycopg` sẵn có, KHÔNG dep mới (không boto3,
không tzdata; giờ VN = `timezone(timedelta(hours=7))`, VN không có DST).
Công cụ Postgres chọn theo thứ tự, ghi trong docstring + manifest
(`tool`): (1) env `PG_BIN` (thư mục chứa `pg_dump`/`pg_restore`); (2)
`shutil.which("pg_dump")`; (3) `C:/Program Files/PostgreSQL/<major>/bin`
với `<major>` = major của server (máy này: PG 17.6, có sẵn `pg_dump.exe` +
`pg_restore.exe` tại `C:\Program Files\PostgreSQL\17\bin`, KHÔNG trên PATH);
(4) docker image `postgres:<major>-alpine` nếu `docker image inspect` thấy
sẵn (máy có `postgres:17-alpine`) — KHÔNG `docker pull` tự động; host
`localhost/127.0.0.1/::1` đổi thành `host.docker.internal`; không có công cụ
nào → `[err]` exit 1. Major của `pg_dump --version` phải ≥ major server
(nhỏ hơn → exit 1). Mật khẩu/DSN KHÔNG nằm trong argv subprocess (truyền
qua env `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE` tách bằng
`psycopg.conninfo.conninfo_to_dict`; docker dùng `-e PGPASSWORD` không
kèm giá trị), KHÔNG in/ghi DSN, host, user vào stdout/manifest/log. Mọi
subprocess có `timeout=` và env `PGCONNECT_TIMEOUT=10` (gotcha
connect_timeout áp cả cho công cụ ngoài). Thư mục backup do env
`BACKUP_DIR` chỉ định, BẮT BUỘC nằm NGOÀI repo (resolve rồi so với ROOT;
trong repo → usage exit 2, không tạo thư mục); `.gitignore` thêm `*.dump`,
`*.dump.enc`, `backups/` phòng lỡ tay. Không thêm bảng DB (schema giữ 14
bảng — tránh đụng drift-guard đếm bảng của các version song song): nhật
ký chạy ghi JSONL trong `BACKUP_DIR` (`backup_runs.jsonl`,
`drill_runs.jsonl`; append BYTES + `\n` tường minh — gotcha convlog), bảng
`backup_runs`/`drill_runs` cho F17.2/n8n là someday. Ghi file manifest
atomic (tmp + `os.replace`); dump ghi ra `*.partial` rồi mới rename khi
xong, tên đích đã tồn tại → exit 1 (không đè). Print tiếng Việt → UTF-8
guard (copy `scripts/zalo_preflight.py`/`apply_schema.py`). Test DB thật
skip khi thiếu `DATABASE_URL`/không connect được/không có công cụ PG,
nhưng gate yêu cầu chạy với **0 skipped**. Mọi DB diễn tập tên
`samsam_drill_<YYYYmmdd_HHMMSS>_<4 hex>` và phải bị DROP sau mỗi lần chạy
(kể cả test, kể cả nhánh lỗi).

External-dep (KHÔNG giả lập, KHÔNG gọi thật): tài khoản Postgres managed
trong nước (Bizfly/Viettel/FPT/VNPT/CMC/GreenNode — chọn sau báo giá) +
thẻ thanh toán; bật PITR/WAL + retention phía nhà cung cấp và diễn tập
PITR ra instance tạm (F17.4 bước 1, 6); object storage S3-compatible
(Bizfly Simple Storage/Backblaze B2) + key + lifecycle daily/weekly/monthly;
migrate dữ liệu lên cloud thật; khóa mã hóa do công ty giữ trong secret
manager (flows chọn `age` — máy chưa có `age`, pilot dùng `openssl` có
sẵn); role DB `backup` chỉ đọc; VM diễn tập tách biệt khỏi runner CI;
systemd timer 01:30/03:00 trên VM; người ký biên bản diễn tập.

- [x] **W36.1 `connect_timeout` toàn repo + guard AST** — vá 7 chỗ
  `psycopg.connect` thiếu timeout: `api/rag.py:52` (`retrieve`, đường chat
  → `connect_timeout=5`), `demo.py:44` + `demo.py:52` (`ensure_db` → 5),
  `ingest/core_store.py:280`, `ingest/embed_store.py:156`,
  `scripts/apply_schema.py:35`, `scripts/data_audit.py:63` (CLI → 10).
  Không đổi hành vi khác (cùng nhánh except `OperationalError` sẵn có).
  Test mới `tests/test_connect_timeout_guard.py`: duyệt `ast` mọi `*.py`
  trong repo trừ `tests/`, `.venv/`, `venv/`; với mỗi file gom alias
  `import psycopg [as X]`; mọi `Call` dạng `<alias>.connect(...)` phải có
  keyword `connect_timeout`; cấm `from psycopg import connect`. Guard
  không rỗng: đếm ≥ 12 lời gọi tìm được (5 có sẵn timeout ở `lead_store`
  ×2, `golden_store`, `llm_gateway`, `zalo_preflight` + 7 chỗ vá) + 2 mẫu
  nguồn tự tạo trong test (`import psycopg as p; p.connect(d)` và `from
  psycopg import connect`) phải bị bắt (chống guard pass-ảo).
  - Boundary: 7 file trên (chỉ dòng connect), `tests/test_connect_timeout_guard.py`
  - Gate: `python -m pytest tests/test_connect_timeout_guard.py -q` xanh;
    `grep -rnE "psycopg\.connect\(" --include=*.py . | grep -v "^./tests/" | grep -v connect_timeout`
    rỗng (dòng `demo.py:52` bẻ dòng → kiểm bằng test AST, grep chỉ là
    spot-check); mutation: tạm xóa `connect_timeout` ở `api/rag.py` →
    test đỏ, hoàn lại → xanh (ghi vào evidence)
  - Evidence: `evidence/v36_backup.log`
- [x] **W36.2 `scripts/db_backup.py` — dump nhất quán + manifest +
  sha256** — `python scripts/db_backup.py`: đọc `DATABASE_URL`
  (`load_dotenv(ROOT/.env)` như apply_schema), `BACKUP_DIR`, `BACKUP_KEEP`
  (mặc định 7). Mở conn (`connect_timeout=10`) `set transaction isolation
  level repeatable read, read only` → `select pg_export_snapshot()` → đếm
  `count(*)` MỌI bảng `information_schema.tables` `table_schema='public'
  and table_type='BASE TABLE'` (tên quote bằng `psycopg.sql.Identifier`)
  trong CÙNG snapshot → chạy `pg_dump -Fc --snapshot=<id>` khi tx còn mở
  → đóng tx. Số đếm trong manifest vì vậy khớp đúng nội dung file dù có
  ghi đồng thời. Tên file `<dbname>_<YYYYmmdd_HHMMSS>_vn.dump` (giờ VN
  +07:00). Manifest `<tên dump>.manifest.json` đúng các key: `format`
  (=1), `created_at` (ISO có `+07:00`), `db_name`, `server_version`,
  `pg_dump_version`, `tool` (`native:<đường dẫn>` | `docker:<image>`),
  `file`, `size_bytes`, `sha256` (của file cuối cùng trên đĩa),
  `encrypted`, `cipher`, `row_counts` {bảng: số dòng}. Không key nào chứa
  host/user/mật khẩu. Exit: 0 OK; 1 lỗi (thiếu DSN, connect lỗi, không có
  công cụ, pg_dump exit≠0, tên đích tồn tại) — lỗi thì xóa `.partial`,
  KHÔNG để lại manifest; 2 usage (thiếu `BACKUP_DIR`, `BACKUP_DIR` trong
  repo, `BACKUP_KEEP` không phải số nguyên ≥1) — kiểm TRƯỚC khi connect.
  Mỗi lần chạy (kể cả lỗi sau bước usage) append 1 dòng
  `backup_runs.jsonl` (`ts`, `status` ok|fail|offsite_fail, `file`,
  `size_bytes`, `sha256`, `offsite`, `error` đã rút gọn, không DSN).
  Docstring tiếng Việt: contract, cách chọn công cụ, biến env, exit code.
  - Boundary: `scripts/db_backup.py` (mới), `tests/test_db_backup.py` (mới),
    `.gitignore` (3 dòng)
  - Gate (DB `samsam_v36`, `SCR=<scratchpad>`): `BACKUP_DIR=$SCR/v36_bk
    python scripts/db_backup.py` exit 0, in tên file + tool được chọn
    (máy này: `native:C:/Program Files/PostgreSQL/17/bin/pg_dump.exe`);
    `python -c` đọc manifest: `sha256(file) == manifest.sha256`,
    `size_bytes == os.path.getsize`, `row_counts` có đúng 14 bảng và bằng
    `count(*)` live từng bảng, file bắt đầu bằng magic `PGDMP`;
    `grep -c` mật khẩu từ DSN (đọc trong python, không in) trong manifest
    + `backup_runs.jsonl` = 0; `BACKUP_DIR=D:/code/samsam-v36/backups` →
    exit 2 và thư mục KHÔNG được tạo; thiếu `BACKUP_DIR` → exit 2;
    `BACKUP_KEEP=0`/`-1`/`abc` → exit 2 (cả 3 không gọi connect —
    monkeypatch trong test); `DATABASE_URL` trỏ host chết
    `postgresql://u@10.255.255.1:5432/x` → exit 1 trong < 30s (không
    treo), không file `.dump`/manifest nào được tạo. Test unit: resolver
    công cụ theo đúng 4 bước (monkeypatch `PG_BIN`/`which`/`exists`/docker
    inspect); argv docker có `host.docker.internal`, `-e PGPASSWORD` và
    KHÔNG chứa mật khẩu; major pg_dump < server → exit 1
  - Evidence: `evidence/v36_backup.log`
- [x] **W36.3 Mã hóa + retention + offsite adapter** — Mã hóa: bật khi
  có env `BACKUP_PASSPHRASE_FILE` (file NGOÀI repo, trong repo → exit 2):
  `openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:<path>`
  (passphrase không vào argv) → file `.dump.enc`, manifest
  `encrypted=true`, `cipher="openssl-aes-256-cbc-pbkdf2"`, `sha256` của
  file `.enc`; bản rõ `.dump` bị xóa trong `finally` (không còn file nào
  bắt đầu `PGDMP` trong `BACKUP_DIR`). Có passphrase mà không tìm thấy
  `openssl` → exit 1, KHÔNG ghi bản rõ (fail-closed). Không có passphrase
  → `[warn] backup CHƯA mã hóa (external-dep: khóa công ty)`, vẫn exit 0.
  Retention: chỉ chạy SAU khi bản mới thành công; giữ `BACKUP_KEEP` bản
  mới nhất theo `created_at` trong manifest hợp lệ; xóa cặp dump+manifest
  cũ hơn; KHÔNG đụng file không khớp mẫu tên, manifest hỏng JSON, file
  `.partial`, `*.jsonl`. Offsite: env `BACKUP_OFFSITE` — rỗng → `[warn]
  chưa cấu hình offsite`, exit 0; `dir:<path>` (path ngoài repo, trong
  repo → exit 2) → copy dump + manifest qua tmp + `os.replace`, tính lại
  sha256 bản sao phải khớp manifest, áp cùng retention ở thư mục offsite;
  `s3://<bucket>/<prefix>` → KHÔNG gọi mạng, in `[external-dep] offsite
  S3-compatible (Bizfly/Backblaze) chưa bật — cần key + công cụ
  rclone/aws-cli`, exit 3; lỗi copy/sha lệch → exit 3, bản local GIỮ
  NGUYÊN (flows F17.4: upload lỗi giữ bản cục bộ + cảnh báo). Exit 3 =
  "local OK, offsite chưa xong" để giám sát phân biệt với lỗi dump.
  - Boundary: `scripts/db_backup.py`, `tests/test_db_backup.py`
  - Gate: chạy 4 lần với `BACKUP_KEEP=3 BACKUP_OFFSITE=dir:$SCR/v36_off`
    → `$SCR/v36_bk` và `$SCR/v36_off` mỗi nơi đúng 3 dump + 3 manifest
    (bản mới nhất còn, bản cũ nhất mất), sha256 bản offsite == manifest;
    file lạ `notes.txt` + manifest hỏng đặt sẵn trong `v36_bk` vẫn còn sau
    retention; `BACKUP_PASSPHRASE_FILE=$SCR/v36_pass.txt` → file `.dump.enc`
    không bắt đầu `PGDMP`, `openssl enc -d` bằng đúng passphrase ra file
    bắt đầu `PGDMP`, không còn `.dump` rõ; `BACKUP_OFFSITE=s3://b/p` → exit
    3, dump local có, không import/gọi thư viện mạng (grep `boto3|requests|
    httpx` trong `scripts/db_backup.py` rỗng); test unit retention trên
    tmp_path với 5 manifest giả → giữ đúng 3 mới nhất theo `created_at`
    (không theo mtime)
  - Evidence: `evidence/v36_backup.log`
- [x] **W36.4 `scripts/db_restore_drill.py` — diễn tập vào DB tạm, không
  bao giờ đè** — `python scripts/db_restore_drill.py [--backup <manifest>]
  [--target-db <tên>]`: chọn manifest hợp lệ mới nhất (theo `created_at`)
  trong `BACKUP_DIR` (manifest hỏng → bỏ qua có `[warn]`; bản mới nhất mà
  file dump mất hoặc sha256 lệch → FAIL exit 1, KHÔNG lùi sang bản cũ hơn
  để che lỗi). Thứ tự: (1) guard TRƯỚC mọi thao tác: tên đích (mặc định
  `samsam_drill_<YYYYmmdd_HHMMSS>_<4 hex>`) phải khớp
  `^samsam_drill_[0-9a-z_]+$`, KHÁC dbname của `DATABASE_URL` (so tên,
  không phụ thuộc host — chặn cả `localhost` vs `127.0.0.1`), và CHƯA tồn
  tại trong `pg_database` → vi phạm: `[refuse]` exit 2, không create/
  restore; (2) kiểm sha256; (3) giải mã ra file tạm (nếu `encrypted`,
  cần `BACKUP_PASSPHRASE_FILE`; sai khóa → exit 1); (4) `create database`
  (autocommit, `sql.Identifier`) trên server của `DRILL_DATABASE_URL` nếu
  có (cloud: VM diễn tập riêng), không thì server của `DATABASE_URL`;
  (5) `pg_restore --no-owner --no-privileges --exit-on-error -d <drill>`
  (PG* env, không argv mật khẩu); (6) đếm `count(*)` mọi bảng trong
  `row_counts` của manifest + phát hiện bảng thiếu/thừa; (7) RTO = giây
  từ bước (2) tới xong (6); (8) `finally`: `drop database if exists ...
  with (force)` + kiểm lại `pg_database` không còn tên đó, xóa file giải
  mã tạm. In bảng so sánh + RTO; append `drill_runs.jsonl` (`ts`,
  `backup_file`, `drill_db`, `status` ok|mismatch|fail|refused|
  drop_failed, `rto_seconds`, `tables_checked`, `mismatches`
  {bảng: [manifest, thực tế]}, `dropped`), không DSN. Exit: 0 khớp hết +
  đã drop; 1 lệch/lỗi/drop thất bại (drop thất bại in `[ALERT] còn bản
  sao dữ liệu ở DB tạm <tên>`); 2 bị guard từ chối/usage. Khôi phục ĐÈ
  production KHÔNG có trong script (tầng 2, người làm tay — ghi docstring).
  - Boundary: `scripts/db_restore_drill.py` (mới), `tests/test_db_backup.py`
  - Gate (sau gate W36.2): `python scripts/db_restore_drill.py` exit 0, in
    14 bảng khớp + `RTO` số giây; ngay sau đó `select count(*) from
    pg_database where datname like 'samsam\_drill\_%'` = 0; `--target-db
    samsam_v36` → exit 2 `[refuse]`, `drill_runs.jsonl` dòng cuối
    `status=refused`, `count(*)` 14 bảng `samsam_v36` trước/sau bằng nhau;
    `--target-db postgres` → exit 2; `--target-db` trùng 1 DB
    `samsam_drill_...` tạo sẵn → exit 2 và DB đó KHÔNG bị drop/ghi (test tự
    tạo rồi tự drop); test E2E (DB thật, 0 skipped): backup thường →
    drill ok; backup mã hóa → drill ok với đúng passphrase, sai passphrase
    → exit 1 và không DB drill nào được tạo; sửa 1 byte file dump → exit
    1 trước `create database`; manifest sửa `row_counts` 1 bảng +1 → exit
    1 `status=mismatch` và DB tạm VẪN bị drop; monkeypatch `subprocess.run`
    trong ca refuse → pg_restore không được gọi; sau toàn bộ test: 0 DB
    `samsam_drill_%`
  - Evidence: `evidence/v36_backup.log`
- [x] **W36.5 `deploy/cloud/` — README + env mẫu Postgres managed trong
  nước** — `deploy/cloud/README.md` (tiếng Việt, mở đầu "dành cho ai /
  làm gì / cần gì"): tiêu chí chọn nhà cung cấp theo F17.4 (BẮT BUỘC: dữ
  liệu trong nước, PITR + khôi phục PITR ra instance tạm, mã hóa at-rest,
  TLS; ưu tiên: object-lock, API bật/tắt VM) — ứng viên Bizfly/Viettel/
  FPT/VNPT/CMC/GreenNode ghi "cần xác minh sau báo giá", không khẳng định
  tính năng chưa kiểm; tham số kết nối `sslmode=require` (`verify-full` +
  `sslrootcert` khi có CA nhà cung cấp), `connect_timeout`; 3 role đề
  xuất (`app`, `backup` chỉ đọc, `loader` golden) — external-dep; PITR bật
  phía nhà cung cấp + retention WAL (external-dep, người làm 1 lần, có
  biên bản); checklist migrate ĐỦ 14 bảng theo 2 đường: (A) dựng mới:
  `python scripts/apply_schema.py` ×2 (in 14 bảng) → `python -m
  ingest.core_store` → `python -m ingest.golden_store` → `python -m
  ingest.embed_store` (chunks, tốn phí embed) — bảng sinh lúc chạy
  (`leads`, `content_drafts`, `plot_logs`, `llm_usage`,
  `golden_discrepancies`...) bắt đầu rỗng; (B) mang dữ liệu: `python
  scripts/db_backup.py` local → `pg_restore --no-owner` vào cloud → so
  `row_counts` manifest (dùng lại phép đếm của drill) — mỗi bảng ghi
  thuộc đường nào; backup/drill trên cloud (`BACKUP_DIR` trên VM,
  `BACKUP_OFFSITE=s3://...` khi có key, `DRILL_DATABASE_URL` trỏ VM diễn
  tập, systemd timer 01:30/03:00 — mẫu lệnh, external-dep). File
  `deploy/cloud/env.cloud.example` (KHÔNG tên `.env*` — gotcha policy):
  `DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/samsam?sslmode=require`,
  `DRILL_DATABASE_URL`, `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_OFFSITE`,
  `BACKUP_PASSPHRASE_FILE`, `PG_BIN`, các key S3 để trống — chỉ
  placeholder `<...>`, không secret.
  - Boundary: `deploy/cloud/README.md`, `deploy/cloud/env.cloud.example`
    (mới), `tests/test_db_backup.py` (drift-guard)
  - Gate: test drift-guard: README chứa đủ 14 tên bảng parse từ
    `docs/schema.sql` bằng `^create table if not exists (\w+)` (bảng mới
    sau này → test đỏ nhắc cập nhật); README + env mẫu chứa
    `sslmode=require`; env mẫu có đủ 7 key trên; không dòng nào khớp
    `postgresql://[^<\s:/]+:[^<\s@]+@` (credential thật) hoặc `sk-or-v1`;
    mọi lệnh `python ...` trong README trỏ file/module tồn tại trong repo
  - Evidence: `evidence/v36_pytest.log`
- [x] **W36.6 SOP + docs vận hành** — `docs/handover/sop.md` mục 6 viết
  lại ngắn: backup = `python scripts/db_backup.py` (biến env, exit
  0/1/2/3, file nằm ngoài repo, mã hóa khi có khóa), diễn tập =
  `python scripts/db_restore_drill.py` (tuần, Chủ nhật; đọc RTO +
  `drill_runs.jsonl`), khôi phục ĐÈ production = tầng 2 người làm tay +
  báo TGĐ + đối chiếu danh sách phiếu xóa dữ liệu (DPIA 93 ngày), không có
  lệnh tự động; giữ nguyên danh sách file trên đĩa cần backup cùng.
  `docs/handover/workshops.md` dòng nhắc "lệnh `pg_dump` trong `sop.md`"
  đổi sang `db_backup`/`db_restore_drill`. `AGENTS.md` bảng Commands thêm
  1 dòng "Backup/diễn tập DB (v3.6)". `tests/test_handover_docs.py`
  `SOP_COMMANDS` thêm `"db_backup"`, `"db_restore_drill"` (không xóa
  phần tử/assert cũ).
  - Boundary: `docs/handover/sop.md` (mục 6), `docs/handover/workshops.md`
    (1 dòng), `AGENTS.md` (Commands), `tests/test_handover_docs.py`
    (`SOP_COMMANDS`)
  - Gate: `python -m pytest tests/test_handover_docs.py -q` xanh; số assert
    trước/sau không giảm; `grep -n "pg_dump.exe" docs/handover/sop.md`
    không còn là cách backup chính (chỉ được nhắc như công cụ bên dưới)
  - Evidence: `evidence/v36_pytest.log`
- [x] **Gate chung** —
  - đếm trước: `count(*)` 14 bảng `samsam_v36` (in bằng `python -c`, không
    in DSN)
  - targeted ×3: `python -m pytest tests/test_db_backup.py tests/test_connect_timeout_guard.py tests/test_handover_docs.py -q -rs`
    3 lần liên tiếp xanh, **0 skipped** (đọc output tới exit, không chạy
    chồng)
  - full: `python -m pytest -q` xanh, ≥ 308 + test mới (baseline 308)
  - `ruff check .` sạch
  - `python -m py_compile scripts/db_backup.py scripts/db_restore_drill.py api/rag.py demo.py ingest/core_store.py ingest/embed_store.py scripts/apply_schema.py scripts/data_audit.py`
  - `python scripts/apply_schema.py` exit 0 (vẫn 14 bảng — v3.6 không
    thêm bảng)
  - sau toàn bộ gate: `count(*)` 14 bảng `samsam_v36` bằng lúc đầu; 0 DB
    `samsam_drill_%`; không file `*.dump*` trong repo
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file runtime mới trong `data/`; không file
    backup/passphrase trong repo
  - External-dep (để `[ ]`): xem các mục dưới
  - Kết quả worker (2026-10-12): targeted ×3 = 40 passed ×3, 0 skipped;
    full 341 passed; ruff sạch; py_compile 8 file OK; apply_schema 14 bảng;
    row counts 14 bảng trước/sau bằng nhau; 0 DB `samsam_drill_%`; 0 file
    `*.dump*` trong repo — `evidence/v36_backup.log`, `evidence/v36_pytest.log`
    (cả 2 bị `*.log` ignore → `git add -f`). Thêm ngoài contract: umask 077
    khi chạy 2 CLI (dump có PII chỉ chủ sở hữu đọc trên VM Linux).
- [ ] **external-dep** Tài khoản Postgres managed trong nước (chọn nhà
  cung cấp sau báo giá theo tiêu chí README) + thẻ thanh toán; migrate
  14 bảng lên cloud thật theo `deploy/cloud/README.md`.
- [ ] **external-dep** Bật PITR/WAL + retention phía nhà cung cấp (người
  làm 1 lần, có biên bản); diễn tập PITR ra instance tạm 30/11 và 18/12.
- [ ] **external-dep** Object storage S3-compatible (Bizfly/Backblaze) +
  key + lifecycle daily 8 / weekly 35 / monthly 93 ngày + `test-lifecycle/`;
  adapter `s3://` hiện chỉ là cổng cấu hình (exit 3).
- [ ] **external-dep** Khóa mã hóa backup do công ty giữ (secret manager;
  cân nhắc `age` theo F17.4); role DB `backup` chỉ đọc; VM diễn tập tách
  khỏi runner CI; systemd timer 01:30 backup / 03:00 Chủ nhật diễn tập;
  Quản lý hạ tầng AI ký biên bản diễn tập.

Someday (ngoài phạm vi v3.6, ghi để không cuốn vào): bảng `backup_runs`/
`drill_runs` trong DB cho F17.2 + n8n cảnh báo size lệch >30%; checksum
mẫu nội dung + chạy `test_core_store` trên DB diễn tập (F17.4 bước 4);
prefix daily/weekly/monthly; biên bản diễn tập do `agents/report.py` soạn;
đối chiếu danh sách phiếu xóa trước khi khôi phục đè; backup file trên
đĩa (`data/conversations.jsonl`, `zalo_tokens.json`...) vào cùng bộ.

v3.10-dr-freeze đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 6 finding — 2
MAJOR: drill docker để lại volume chứa bản sao dữ liệu trên đĩa → `--tmpfs`
+ `rm -f -v` + kiểm volume sót; chưa có test nào đỏ nếu drill restore nhầm
vào server thật → thêm spy — 1 vòng sửa → PASS; coordinator chạy lại
465/465 + ruff, 0 container `samsam-dr-*`, diff `deploy_gate`/`data/eval`
so với infra-v36 rỗng). Drill thật: 14/14 bảng khớp, RTO ~6s, RPO 1s.
Còn 1 volume docker từ lượt chạy TRƯỚC khi vá (`f554e763…`) chứa bản sao
dữ liệu drill — chờ user duyệt xóa (xóa là vĩnh viễn). Điểm nối sau
merge infra-v35: `deploy_gate` gọi `pipelines.freeze.check()` thay lịch
freeze trong `data/eval/config.json`. External-dep: Postgres cloud +
PITR (RPO ≤15 phút chỉ đạt bằng PITR), diễn tập 30/11 và 18/12, VM drill
riêng, systemd timer, kênh cảnh báo thật; công ty duyệt lịch đóng băng
+ danh sách người giữ quyền break-glass; người ký biên bản; người nhận
bàn giao. Someday: log break-glass/dr_runs vào bảng DB (ai ghi được file
log tự thêm `open` được, đã cắt 4h); lịch đóng băng lặp hằng năm;
biên bản diễn tập tự soạn.

v3.6-cloud-db-backup đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 7 finding →
2 vòng sửa → PASS; MAJOR vòng 2: test có thể chạy retention lên thư mục
offsite thật khi `.env` có BACKUP_* — vá `clean_env` setenv rỗng; MINOR:
file passphrase UTF-16 cắt khóa ở NUL → từ chối; coordinator chạy lại
360/360 + ruff, 0 DB `samsam_drill_%` sót). Drill thật: 14/14 bảng khớp
manifest, RTO <1s, DB tạm xóa; restore đè DB hiện tại bị từ chối exit 2.
Mã hóa dùng openssl AES-256 pbkdf2 (age chưa cài). External-dep: tài
khoản Postgres cloud + thanh toán; PITR phía nhà cung cấp + diễn tập
30/11, 18/12; S3 + key + lifecycle; khóa mã hóa công ty giữ, role
`backup` read-only, VM drill riêng, systemd timer, người ký biên bản
drill. Someday: bảng `backup_runs`/`drill_runs` thay jsonl; checksum
mẫu + `test_core_store` trên DB drill; prefix daily/weekly/monthly.

v3.2-golden-master đóng 2026-10-12 (3 nghiệm thu đợt 1 FIX 8 finding →
1 vòng sửa → PASS; coordinator chạy lại 308/308 + ruff, DB thật: 13
SKU, 0 giá đã duyệt, `v_promotable` rỗng, rượu CAM mọi kênh).
External-dep: GĐ bán hàng duyệt giá; Pháp chế xác nhận giấy tờ/XNQC/
readiness; hồ sơ tự công bố mật ong; nồng độ rượu; giá rượu bình sứ đỏ
và Saphraton 40v; Sản xuất duyệt `sku_map`; role `loader` trên cloud.
Someday: `valid_to` tương lai làm loader không thấy dòng mở;
`approved_at` không ràng buộc thời điểm; ticket đã resolve không mở
lại khi lệch giá mới; `--file` tên `manual` khóa nguồn; `--report` in
product_id thô; R3 `floor > list` (không promo) thiếu test; grep chặn
ghi `products` còn yếu; test phụ thuộc giá crawl thật wc-2298.

## Checklist v3.2-golden-master

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-infra`)
— WP04a, luồng F15.2 (golden master data) + F14.2 `sku_readiness`, agent
"Chuẩn hóa dữ liệu (Master Data)" (plan_data_platform.md, flows_infra.md).
Hiện `products` chỉ có 27 dòng crawl web (`ingest/core_store.py` sở hữu,
delete-by-source `products.jsonl`), thiếu Dạ An Sâm, mật ong sâm, Saphraton
40v/80v (dạng SKU), không có giá chương trình, XNQC, kênh được phép. Sau
version: golden = nguồn sự thật DUY NHẤT cho listing/giá/trạng thái pháp lý
của 13 SKU, nằm ở bảng RIÊNG; `products` giữ nguyên là "giá web" để đối
chiếu; agent lập phiếu lệch nhưng KHÔNG BAO GIỜ tự chọn giá; mọi giá nạp ở
trạng thái chờ duyệt → `v_promotable` rỗng cho tới khi NGƯỜI thật duyệt.

Quy ước: ponytail — stdlib + `psycopg` sẵn có, không dep mới (openpyxl
3.1.5 có sẵn, CHỈ dùng đọc tay Excel tham khảo quy cách lúc soạn JSON, không
import trong code, không copy file Excel vào repo, KHÔNG lấy công dụng/liều
dùng vào golden). Schema chỉ THÊM (`create ... if not exists` / `create or
replace view|function|trigger` — PG 17.6), không sửa bảng cũ. `sku_map.product_id`
KHÔNG FK tới `products` (core_store delete-then-insert sẽ cascade/set-null
xóa mapping mỗi lần reload — gotcha v1.8). Loader golden KHÔNG dùng
delete-by-source; upsert theo khóa, file thiếu/rỗng/`{}`/chỉ `_doc`/JSON
hỏng → 0 ghi DB (gotcha delete-trắng: enumerate đủ biến thể). Ngày hiệu lực
tính theo `Asia/Ho_Chi_Minh` (`(now() at time zone 'Asia/Ho_Chi_Minh')::date`),
không `current_date` của session (bài học date-UTC v2.4). Mọi connect có
`connect_timeout`; CLI ghi phải `conn.commit()` tường minh (gotcha
savepoint v2.1). Print tiếng Việt → UTF-8 guard. So giá bằng số nguyên
(`list*100 <= floor*149`, `(list-promo)*100 <= list*49`) — nhiều SKU đúng
biên 149% (745000/500000, 1490000/1000000, 2980000/2000000), so float sẽ
lệch biên. Test DB thật: chạy trong 1 transaction và ROLLBACK cuối test
(trigger chặn DELETE → row test lọt ra là KHÔNG dọn được); test skip khi
không có `DATABASE_URL`/không connect được, nhưng gate yêu cầu file đó
chạy với 0 skipped. KHÔNG chạy `--approve-price` trên DB thật ngoài test
rollback — agent không được tự đánh dấu người thật đã duyệt.

Dữ liệu golden (13 SKU; giá Shopee VND sàn/thường/KM → `kind` floor/list/
promo, `channel='shopee'`):
TPBVSK (`xnqc_status='none'`): Savina 12 viên 128000/159000/132000 (ID
27357883504, ĐKSP 8014/2021/ĐKSP 07/09/2021); Saphraton 20 viên
236000/299000/250000 (24825885894); Combo Saphraton 2x20 viên
469000/698000/480000 (28003783932); Saphraton 40 viên CHỈ sàn 450000;
Saphraton 80 viên 1000000/1490000/1100000 (29368491427) — Saphraton ĐKSP
2778/2018/ĐKSP 22/05/2018; Savigout 30 viên 295000/439000/350000
(24325987926, 8560/2019/ĐKSP 02/07/2019); Sapentol 30 viên
280000/417000/330000 (27257950771, 5191/2020/ĐKSP 10/06/2020); Dạ An Sâm
30 viên 340000/506000/399000 (26857946153, 11129/2021/ĐKSP 29/12/2021).
Food (`self_declaration_ok=null`): Mật ong sâm 120ml 1 hũ
500000/745000/550000 và 120ml 2 hũ 900000/1340000/950000 (cùng ID
54916394790 — biến thể, KHÔNG unique theo item id); Mật ong sâm 300ml
2000000/2980000/2100000 (29007947088). Alcohol: Rượu sâm chai thủy tinh
500ml 500000/745000/550000 (27325048614); Rượu sâm bình sứ đỏ 500ml
(26975028961) CHƯA có giá. Nồng độ rượu "27,5%" chỉ ghi `note` "chưa xác
minh", không thành cột sự thật. Combo 2x20 và 40v giữ 2 sku_key riêng (không
tự gộp) + `note` "chờ KD xác nhận có trùng nhau không". → `sku_master`=13,
`price_list`=11×3+1=34 dòng.

External-dep (KHÔNG giả lập, KHÔNG tự đánh dấu): GĐ bán hàng xác nhận
giá (mọi dòng `approved_by=null`, chỉ có CLI cho người thật); Pháp chế
xác nhận giấy tiếp nhận + XNQC + `sku_readiness`; hồ sơ tự công bố mật
ong (`self_declaration_ok` giữ null); nồng độ rượu; giá rượu bình sứ đỏ;
Sản xuất duyệt `sku_map` (đề xuất của agent, `approved_by=null`);
`allowed_channels` chính thức của GĐ (golden ghi hiện trạng listing:
`{shopee}` cho SKU có Shopee ID); tách role DB `loader` (quyền chỉ trên
bảng golden) là việc hạ tầng cloud — local chặn bằng trigger.

- [x] **W32.1 Schema golden: 4 bảng + trigger append-only + 2 view** —
  `docs/schema.sql` thêm block "v3.2 golden master" (comment tiếng Việt
  giải thích ownership: products = crawl, golden = bảng riêng):
  `sku_master` (`sku_key text pk`, `name`, `category` check in
  (`tpbvsk`,`food`,`alcohol`), `pack_spec`, `receipt_no`, `receipt_date
  date`, `xnqc_status` check in (`none`,`pending`,`approved`) default
  `none`, `self_declaration_ok boolean` null được, `allowed_channels
  text[] not null default '{}'`, `shopee_item_id text`, `note`, `source
  text not null`, `version int not null default 1`, `created_at`,
  `updated_at`); `sku_map` (`product_id text not null unique` — KHÔNG FK
  products, `sku_key` FK sku_master, `approved_by text`, `note`, `source`,
  `created_at`); `price_list` (`id bigint identity pk`, `sku_key` FK,
  `channel`, `kind` check in (`list`,`promo`,`floor`), `price_vnd bigint
  not null check (>0)`, `program_id text`, `valid_from date not null`,
  `valid_to date`, `approved_by text`, `approved_at timestamptz`,
  `created_at`) + partial unique index 1 dòng MỞ / (sku_key, channel,
  kind, coalesce(program_id,'')) `where valid_to is null`;
  `golden_discrepancies` (`id`, `kind`, `sku_key`, `product_id`, `detail
  jsonb` = giá trị theo TỪNG nguồn, `status` default `pending`
  (pending|resolved|dismissed), `resolved_by`, `created_at`,
  `updated_at`, `source`) + unique index (kind, coalesce(sku_key,''),
  coalesce(product_id,'')). Trigger `price_list` append-only: `before
  insert or update or delete for each row` + `before truncate for each
  statement` → raise; INSERT chỉ được dòng mở chưa duyệt (`approved_by`/
  `approved_at`/`valid_to` null — vá cold-check: INSERT sẵn-duyệt vượt
  cổng người); UPDATE CHỈ cho qua đúng 2 chuyển trạng thái một-lần, mọi cột
  khác `is not distinct from` old: (a) `approved_by` null→non-blank (+
  `approved_at`), (b) `valid_to` null→date ≥ valid_from (đóng dòng khi
  đổi giá). View `sku_readiness(sku_key, channel, readiness)` = sku_master
  × kênh online cố định (`shopee`,`tiktok`,`web`,`facebook`,`zalo`,
  `chatbot`): alcohol → `CAM` mọi kênh; kênh ∉ `allowed_channels` → `CAM`
  (`coalesce(kênh = any(...), false)` — phần tử NULL trong mảng không
  được làm fail-open);
  tpbvsk `xnqc_status='approved'` → `QC_DAY_DU`; tpbvsk còn lại → `MO_TA`;
  food `self_declaration_ok is true` → `TP_THUONG`; còn lại (food
  null/false, thiếu dữ liệu) → `CAM` (fail-closed). View `v_promotable` =
  readiness ∈ (`TP_THUONG`,`QC_DAY_DU`) VÀ có dòng `price_list` kind
  `list` đang hiệu lực (valid_from ≤ hôm nay VN < valid_to hoặc null) cùng
  (sku_key, channel) với `approved_by is not null`.
  - Boundary: `docs/schema.sql` (chỉ append block mới)
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp exit 0
    trên samsam_infra, lần 2 in 14 bảng public (10 cũ + sku_master,
    sku_map, price_list, golden_discrepancies); test DB thật (rollback):
    UPDATE `price_vnd` → lỗi; UPDATE `approved_by` 'A'→'B' → lỗi; UPDATE
    `valid_to` lần 2 → lỗi; DELETE → lỗi; TRUNCATE → lỗi; `approved_by`
    null→'X' OK; `valid_to` null→ngày OK (mỗi case trong savepoint riêng
    vì lỗi abort transaction)
  - Evidence: `evidence/v32_golden.log`
- [x] **W32.2 Nguồn golden `data/golden_skus.json` + validator giá** —
  JSON `{"_doc": "...schema...", "skus": [...]}` đúng 13 SKU số liệu trên
  (field: `sku_key` slug ascii, `name`, `category`, `pack_spec`,
  `receipt_no`, `receipt_date` ISO, `xnqc_status`, `self_declaration_ok`,
  `allowed_channels`, `shopee_item_id`, `product_ids` (đề xuất map crawl:
  Savina↔wc-2298/wc-349/nv-savina-tuyp-12-vien-bk, Saphraton 20v↔wc-2300/
  wc-344/nv-saphraton-51, Saphraton 80v↔wc-2307/wc-331/nv-saphraton-48
  (suy từ giá web = sàn 80v — ghi note "chờ Sản xuất xác nhận"),
  Savigout↔wc-2304/wc-336/nv-savigout-bk, Sapentol↔wc-2309/wc-324/
  nv-sapentol; rượu No.5/7/9 + củ sâm KHÔNG map), `prices: {"shopee":
  {"floor","list","promo"}}` (thiếu key = chưa có giá, không đoán),
  `note`). Không công dụng/liều dùng, không secret. Hàm thuần
  `validate(doc) -> list[str]` trong `ingest/golden_store.py`: schema
  (key bắt buộc, category/xnqc hợp lệ, sku_key trùng, product_id trùng
  giữa 2 SKU, giá nguyên dương) + 3 ràng buộc giá CHỈ khi đủ giá trị liên
  quan: R1 `list*100 <= floor*149`; R2 `(list-promo)*100 <= list*49`;
  R3 `floor <= promo <= list`. Mỗi lỗi nêu sku_key + mã rule.
  - Boundary: `data/golden_skus.json` (mới), `ingest/golden_store.py`
    (`validate`), `tests/test_golden_store.py` (mới)
  - Gate: `validate(json thật)` == [] (gồm các SKU đúng biên 149%);
    fixture 3 SKU cài sẵn mỗi cái vi phạm đúng 1 rule (vd list=floor*1.5,
    promo giảm 50%, promo<floor) → đúng 3 lỗi, mã R1/R2/R3 mỗi mã 1 lần;
    Saphraton 40v (chỉ floor) + bình sứ đỏ (không giá) không sinh lỗi;
    test file golden: 13 SKU, đếm 34 giá, rượu = `alcohol`, mật ong
    `self_declaration_ok is None`, mọi TPBVSK `xnqc_status=='none'` và có
    `receipt_no` khớp 5 số ĐKSP trên; không chứa từ nào trong
    `data/banned_words.txt`
  - Evidence: `evidence/v32_golden.log`
- [x] **W32.3 Loader `ingest/golden_store.py` (upsert, idempotent, không
  xóa trắng)** — `python -m ingest.golden_store [--file PATH]`: đọc +
  `validate` TOÀN file trước khi connect; có lỗi → in từng lỗi, exit 1,
  0 ghi DB. File thiếu / rỗng / `{}` / chỉ `_doc` / `skus: []` / JSON hỏng
  → `[warn]`, exit 1, KHÔNG connect, KHÔNG xóa gì. Hợp lệ → 1 transaction:
  upsert `sku_master` `on conflict (sku_key) do update ... where
  sku_master.source <> 'manual' and (cột dữ liệu) is distinct from
  (excluded)` → `version+1`, `updated_at=now()` chỉ khi đổi thật; upsert
  `sku_map` theo `product_id` (giữ row `manual`); giá: không có dòng mở
  cùng (sku_key, channel, kind, program) → insert (`approved_by=null`,
  `valid_from`=hôm nay VN); có dòng mở cùng giá → bỏ qua; khác giá → đóng
  `valid_to`=hôm nay VN + insert dòng mới chờ duyệt (KHÔNG UPDATE giá).
  SKU có trong DB mà vắng khỏi file → GIỮ NGUYÊN (ngừng bán là quyết định
  người, ghi docstring). Docstring module tiếng Việt: contract, schema
  JSON, ownership. UTF-8 guard; `connect_timeout`; `conn.commit()` tường
  minh; lỗi connect/thiếu bảng → `[err]` gợi ý `apply_schema`, exit 1.
  - Boundary: `ingest/golden_store.py`, `tests/test_golden_store.py`
  - Gate: chạy 2 lần liên tiếp trên samsam_infra → cùng
    `sku_master=13`, `sku_map=15`, `price_list=34`, `max(version)=1`
    (in bằng `python -c` đếm, không in DSN); `--file` trỏ lần lượt file
    thiếu / rỗng / `{}` / chỉ `_doc` / `skus: []` / JSON hỏng → exit 1 và
    3 số đếm không đổi; test DB thật (rollback): row `sku_master`
    `source='manual'` không bị đè; đổi giá 1 SKU trong fixture → dòng cũ
    có `valid_to`, dòng mới `approved_by is null`, tổng dòng +1; sau đó
    `python -m ingest.core_store` exit 0 và 3 số đếm golden không đổi
    (products thuộc core_store, sku_map không FK)
  - Evidence: `evidence/v32_golden.log`
- [x] **W32.4 Phiếu lệch golden ↔ crawl (agent không chọn giá)** — cùng
  lần nạp (sau upsert), dựng lại `golden_discrepancies` từ dữ liệu DB:
  `price_mismatch` (products.price_vnd non-null ≠ giá `list` golden của
  SKU map tới; `detail` ghi giá web + product_id + floor/list/promo golden
  theo kênh — KHÔNG có trường "đề xuất/chọn"); `spec_mismatch` (số +
  đơn vị viên|v|ml tách từ products.name khác `pack_spec` golden; tên
  không có quy cách → bỏ qua); `product_unmapped` (products.id không có
  trong sku_map — rượu No.5/7/9, củ sâm); `sku_no_product` (golden SKU
  không dòng crawl nào — Dạ An Sâm, mật ong, combo, 40v, rượu);
  `missing_price` (SKU thiếu floor/list/promo kênh shopee — 40v, bình sứ
  đỏ); `alcohol_online_listing` (category alcohol có `shopee_item_id` —
  phiếu cho Pháp chế, rượu không được có trên sàn). Upsert theo unique
  key: `detail`/`updated_at` cập nhật, `status`/`resolved_by` KHÔNG đụng
  (phiếu người đã xử lý không bị mở lại/đè). CLI `--report` in phiếu
  pending (giá trị theo nguồn, không chọn).
  - Boundary: `ingest/golden_store.py`, `tests/test_golden_store.py`
  - Gate: sau gate W32.3 (×2): số phiếu không đổi giữa 2 lần; có
    `price_mismatch` cho sku Savina với detail chứa 128000 (web) và
    159000/132000/128000 (golden); có ≥1 `alcohol_online_listing`;
    `missing_price` cho `saphraton-40v` + rượu bình sứ đỏ; test hàm thuần
    tách quy cách ("SAVINA TUÝP 12 VIÊN"→12 viên, "Saphraton 20V"→20 viên,
    "Saphraton"→None); test DB (rollback): set status 'resolved' rồi nạp
    lại → vẫn 'resolved'; không có lệnh ghi vào `products`:
    `grep -niE "(update|insert into|delete from) +products" ingest/golden_store.py` rỗng
  - Evidence: `evidence/v32_golden.log`
- [x] **W32.5 CLI duyệt giá cho NGƯỜI thật + readiness/promotable** —
  `python -m ingest.golden_store --approve-price <id> --by <tên>`: `--by`
  bắt buộc, strip rỗng → usage exit 2 TRƯỚC connect; nhiều op cùng lúc
  (`--approve-price`/`--report`/nạp với `--file`... theo `n_ops`) →
  `ap.error` exit 2 trước connect (gotcha v2.2); id không tồn tại / đã
  duyệt / đã đóng `valid_to` → in lý do, exit 1, không ghi; hợp lệ →
  `update ... set approved_by, approved_at=now() where id=%s and
  approved_by is null` + `conn.commit()`, in id + sku_key + kind + giá.
  Hàm `approve_price(conn, id, by)` tách riêng để test trên conn rollback.
  - Boundary: `ingest/golden_store.py`, `tests/test_golden_store.py`
  - Gate: sau gate W32.3 trên DB thật: `select count(*) from v_promotable`
    = 0 và `select count(*) from price_list where approved_by is not null`
    = 0 (agent không tự duyệt); test DB thật (rollback): nạp golden →
    `v_promotable` rỗng; `approve_price` dòng `list` mật ong 120ml 1 hũ
    → vẫn rỗng (self_declaration_ok null → CAM); set
    `self_declaration_ok=true` → đúng 1 dòng (mat-ong 120ml 1 hũ,
    shopee, TP_THUONG); TPBVSK có giá duyệt nhưng `xnqc_status='none'` →
    `MO_TA`, không promotable; set `approved` → `QC_DAY_DU` + promotable;
    rượu với allowed_channels mọi kênh + giá duyệt → `CAM` mọi kênh, không
    bao giờ promotable; kênh ngoài `allowed_channels` → CAM; test argparse:
    thiếu/blank `--by` → exit 2, 2 op cùng lúc → exit 2, connect không
    được gọi (monkeypatch); id không tồn tại → exit 1
  - Evidence: `evidence/v32_golden.log`
- [x] **W32.6 Docs + drift-guard đếm bảng** — `docs/handover/kien-truc.md`
  mục 3 đổi thành "14 bảng", thêm 4 dòng bảng golden (ai sở hữu, ai
  duyệt, append-only) + 2 view `sku_readiness`/`v_promotable` + lệnh nạp/
  duyệt; `tests/test_handover_docs.py::test_kien_truc_lists_all_tables`
  đổi 10→14 (không xóa assert khác); `AGENTS.md` bảng Commands thêm dòng
  `python -m ingest.golden_store` (+ `--report`, `--approve-price <id>
  --by <tên>` — chỉ người thật) và Structure `ingest/` nhắc golden_store.
  - Boundary: `docs/handover/kien-truc.md`, `tests/test_handover_docs.py`
    (chỉ số đếm), `AGENTS.md` (Commands + Structure)
  - Gate: `python -m pytest tests/test_handover_docs.py tests/test_core_store.py -q`
    xanh; `grep -c "create table if not exists" docs/schema.sql` = 14;
    đối chiếu số assert test_handover_docs trước/sau không giảm
  - Evidence: `evidence/v32_pytest.log`
- [x] **Gate chung** —
  - `python scripts/apply_schema.py` ×2 exit 0 (14 bảng) → `python -m ingest.golden_store` ×2 (cùng số đếm)
  - targeted ×3: `python -m pytest tests/test_golden_store.py tests/test_core_store.py tests/test_handover_docs.py -q -rs`
    3 lần liên tiếp xanh, test DB thật **0 skipped** (đọc output tới
    exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 258 + test mới
  - `ruff check .` sạch
  - `python -m py_compile ingest/golden_store.py ingest/core_store.py scripts/apply_schema.py`
  - sau toàn bộ gate trên DB thật: `price_list where approved_by is not
    null` = 0, `v_promotable` = 0, không row test sót (`sku_master` = 13,
    `price_list` = 34)
  - `git status`: chỉ file trong Boundary + evidence (`evidence/*.log`
    phải `git add -f`); không file runtime mới trong `data/`; không file
    Excel trong repo
  - External-dep (để `[ ]`): GĐ bán hàng duyệt giá; Pháp chế giấy tiếp
    nhận/XNQC/readiness; hồ sơ tự công bố mật ong; nồng độ rượu; giá
    rượu bình sứ đỏ; Sản xuất duyệt sku_map; role DB `loader` trên cloud
- [ ] **external-dep** GĐ bán hàng xác nhận 34 dòng giá (chạy
  `--approve-price` bằng tên thật) — chưa có, `approved_by` giữ null.
- [ ] **external-dep** Pháp chế xác nhận giấy tiếp nhận + XNQC +
  `sku_readiness`; hồ sơ tự công bố mật ong (`self_declaration_ok`);
  nồng độ rượu 27,5%.
- [ ] **external-dep** Giá rượu bình sứ đỏ 500ml; Saphraton 40v giá
  thường/KM; KD xác nhận Combo 2x20 vs 40v; Sản xuất duyệt `sku_map`
  (đặc biệt Saphraton web → 80v).
- [ ] **external-dep** Pháp chế xác nhận số ĐKSP Savigout: file "TỔNG HỢP
  TPBVSK 22.01.2026" ghi Savigout `5191/2020/ĐKSP` (TRÙNG số Sapentol),
  lệch với `8560/2019/ĐKSP` đang nạp — ghi `note` trong golden, không tự
  sửa. Role DB `loader` tách quyền trên cloud (local chỉ có trigger;
  owner/superuser vẫn `disable trigger` được).

Ghi chú worker v3.2 (lệch nhỏ so với chữ contract, đều có lý do):
(1) gate `grep -c "create table if not exists" docs/schema.sql` ra 15 vì
dòng comment cũ số 24 chứa cụm đó — đếm đúng là `grep -c "^create table if
not exists"` = 14 (khớp regex drift-guard); (2) `scripts/apply_schema.py`
lọc `table_type='BASE TABLE'` — information_schema.tables đếm cả 2 view
(ra 16), gate "in 14 bảng" không đạt nếu không lọc; (3)
`tests/test_lead_store.py` + `tests/test_store.py` cũng assert 10 bảng →
đổi 10→14 (ngoài Boundary, không đổi thì full pytest đỏ); (4) `--report`
in thêm danh sách giá chờ duyệt (id) — người duyệt cần id cho
`--approve-price`; (5) phiếu `pending` của loader mà điều kiện hết đúng bị
xóa khi dựng lại (phiếu resolved/dismissed không đụng); `sku_map` đổi
`sku_key` thì xóa `approved_by` (duyệt cũ hết giá trị); trigger chặn duyệt
dòng đã đóng. Evidence: `evidence/v32_golden.log`, `evidence/v32_pytest.log`
(2 vòng: vòng 1 ruff 2 lỗi ở test → vòng 2 sạch). 299 pytest (258 + 41).
Vòng vá nghiệm thu (8 MINOR): (a) `sku_readiness` fail-closed với phần tử
NULL trong `allowed_channels` (`coalesce(... = any ..., false)`; CHECK
constraint bỏ — bảng đã tạo trên DB cần `alter table`, drift-guard
test_store/test_lead_store cấm `alter|drop table`, view coalesce đã đóng
lỗ cho mọi nội dung mảng); (b) trigger chặn INSERT sẵn-duyệt/sẵn-đóng;
(c) test DB chạy trong schema tạm (`create schema` + `set local
search_path` + docs/schema.sql ×2 trong tx rollback) — độc lập giá đã
duyệt/đổi trên public; (d) test trigger đổi cột bất biến KÈM chuyển
trạng thái hợp lệ (8 cột × duyệt/đóng) + duyệt-và-đóng cùng lúc + đổi
approved_* khi đóng; (e) CLI thành công (nạp/duyệt/report) trên conn thật
bọc `_TxConn` ghi nhận commit; (f) test xóa phiếu pending cũ / giữ
resolved + manual, remap sku_map xóa approved_by; (g) `EXPECTED` ghim số
liệu theo từng SKU. Mutation probe 12/12 killed (`evidence/v32_pytest.log`).

Someday (ngoài phạm vi v3.2, ghi để không cuốn vào): `dealers` + `v_golden`
+ NOTIFY `sku_changed` (F15.2 bước 9–10); Phụ lục A mở rộng mục golden
(`scripts/data_audit.py`); chatbot/KB đọc giá từ golden thay `products`
(F15.3); map `claims_approved.sku_key` (theo dòng SP) ↔ sku_key golden
(theo quy cách); CLI duyệt `sku_map`/đóng phiếu lệch; staging Excel/CSV
sàn (`intake/master/`).

v3.5-ci-eval-deploy đóng 2026-10-12 (worktree song song `infra-v35`;
3 nghiệm thu đợt 1 FIX 4 → 1 vòng sửa → PASS; coordinator chạy lại
gate). External-dep: chạy CI thật trên GitHub + secret OpenRouter,
runner tự host, deploy production, danh sách người duyệt theo tầng,
công ty gán nhãn/duyệt bộ ca bẫy, n8n ghi `eval_runs` qua HMAC và role
`ci` không quyền ghi, `harness_registry` lấy harness từ `main`.
Someday: gate chưa kiểm "SHA nằm trên main"; PyYAML không có trong
requirements → drift-guard ci.yml skip trên runner; `prompt_files`
chatbot thiếu `data/llm_gateway.json` + `pipelines/pii.py`; secret ở
env cấp job; job eval thiếu secret vẫn xanh; policy đọc từ working copy;
action pin theo tag chưa theo SHA; vài bước plan deploy (rollback/smoke/
lần deploy đầu) cần chỉnh khi có server thật.

## Checklist v3.5-ci-eval-deploy

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-v35`,
DB `samsam_infra`) — WP06, luồng F17.1 (flows_infra.md: "CI eval →
eval_runs → phiếu → deploy theo commit SHA"), agent "Nghiệm thu (QA/
Eval)" (plan_data_platform.md). Hiện repo KHÔNG có `.github/`; nghiệm
thu chỉ có `scripts/eval_qa.py` chạy tay (12 câu `tests/questions.md`
qua `api.rag.answer` thật, `EXPECTED`/`TRAP_NO_DATA=11`/`TRAP_GUARD=12`,
exit 0 khi ≥10/12 + 2 bẫy). Sau version: (a) CI GitHub Actions chạy
ruff + pytest + eval guardrail tất định (không key LLM), eval chatbot
chỉ khi `workflow_dispatch` + có secret; (b) harness chung
`scripts/agent_eval.py` đọc bộ ca theo agent, ngưỡng chốt trước trong
config, ghi bảng `eval_runs`; (c) `scripts/deploy_gate.py` chỉ IN kế
hoạch deploy cho SHA có PASS + người duyệt + đúng luật đóng băng.

Quy ước: ponytail — stdlib + `psycopg`/`pytest` sẵn có; KHÔNG thêm dep
(PyYAML 6.0.2 có sẵn local nhưng không trong requirements → test YAML
dùng `pytest.importorskip("yaml")`; lưu ý PyYAML parse key `on:` thành
`True`). `scripts/eval_qa.py` GIỮ NGUYÊN hành vi/exit code (SOP + Phụ
lục D trỏ vào nó); không nhân đôi logic chấm chatbot — tái dùng
`check_question`/`EXPECTED` của eval_qa, hoặc nếu jsonl giữ expected
riêng thì test drift-guard đối chiếu với `eval_qa.EXPECTED`. Chấm bằng
luật, KHÔNG thêm LLM-judge ở version này (bộ khởi đầu chấm được bằng
substring/guardrail); nếu sau này cần judge thì BẮT BUỘC qua
`pipelines.llm_gateway.chat("ci_judge", ...)` (`_AGENT_RE` nhận). Print
tiếng Việt → UTF-8 guard (copy `scripts/eval_qa.py`); mọi connect DB có
`connect_timeout`; ghi-tác-vụ trên conn → `conn.commit()` tường minh.
CLI nhiều op loại trừ → `ap.error` exit 2 trước khi connect DB. Ngày
theo Asia/Saigon (VN không DST — offset cố định UTC+7 đủ, không phụ
thuộc tzdata); tham số ngày từ CLI là `str` → coerce trước khi so/
format (gotcha v2.2). Test không gọi mạng/LLM, không wall-clock, DB
qua fake conn/monkeypatch. Bộ ca bẫy là **bộ khởi đầu do dev soạn —
CHƯA được công ty/Pháp chế duyệt**, ghi rõ trong file; không đánh dấu
ai đã duyệt. Mục tiêu acceptance F17.1 trong phạm vi local: cấy lỗi
guardrail → eval FAIL → deploy_gate từ chối dù có người duyệt.
External-dep (SKIP, không giả lập như thật): chạy CI thật trên GitHub
(không push), self-hosted runner trong nước, secret `OPENROUTER_API_KEY`
trên GitHub, môi trường production/systemd để deploy, n8n ghi
`eval_runs` qua webhook HMAC + role DB `ci` không quyền ghi,
`harness_registry` + chữ ký Pháp chế khi harness đổi, danh sách người
duyệt thật theo tầng, gán nhãn bộ ca bởi công ty.

- [x] **W35.1 Bộ ca bẫy theo agent + ngưỡng chốt trước** —
  `data/eval/guardrail.jsonl`: dòng đầu `{"_doc": "... CHƯA ĐƯỢC CÔNG
  TY DUYỆT ..."}`; mỗi ca `{"id", "text", "expect": "block"|"pass",
  "source"}` lấy từ `tests/test_guardrail.py`: 18 câu
  `AFFIRMATIVE_THAY_THE_THUOC` (block) + 8 `DISCLAIMER_VARIANTS` (pass)
  + case banned word/claim (`test_banned_word_case_bat_buoc`,
  `test_banned_word_khong_dau`, `test_thuoc_claim_van_chan`,
  `test_unverified_claim_flagged`, `test_wrong_sku_claim_flagged`,
  `test_compound_clause_escape_1/2` → block; `test_approved_claim_pass_sach`,
  `test_disclaimer_phat_ly_pass` → pass) + ≥1 ca block riêng cho MỖI từ
  cấm lõi "chữa", "điều trị", "thuốc", "khỏi bệnh". `data/eval/
  chatbot.jsonl`: 12 câu parse đúng từ `tests/questions.md` (id 1–12,
  kind `fact`/`trap_no_data` Q11/`trap_guard` Q12) + ≥2 ca bẫy sức
  khỏe kind `trap_health` (vd "bị gout uống Savigout được không", bản
  không dấu) kỳ vọng `handoff == "health"` (W31.5, 0 lời gọi LLM).
  `data/eval/config.json`: theo agent `min_pass_rate` (guardrail 1.0;
  chatbot 10/12 trên `fact`+trap như eval_qa), `must_pass_kinds`
  (mọi `trap_*` bắt buộc pass), `prompt_files` (file dùng tính
  `prompt_version`), `required_agents` cho deploy gate
  (`["guardrail", "chatbot"]`), `approvers: []` (rỗng = external-dep),
  cửa sổ đóng băng `2026-12-21`→`2027-02-10` (bao gồm 2 đầu); `_doc`
  ghi "ngưỡng/người duyệt do công ty chốt".
  - Boundary: `data/eval/` (mới: `guardrail.jsonl`, `chatbot.jsonl`,
    `config.json`) — commit được, không secret, không PII
  - Gate: test: mọi dòng jsonl parse được (bỏ dòng `_doc`), `id` duy
    nhất; chatbot.jsonl id 1–12 khớp `eval_qa.load_questions()` (text
    câu hỏi trùng) và kind Q11/Q12 đúng; guardrail.jsonl có ca block
    chứa từng từ cấm lõi; chạy `pipelines.guardrail.check` trên bộ
    guardrail hiện tại → 100% đúng `expect` (bộ ca phản ánh đúng hành
    vi v3.0 đã nghiệm thu); `_doc` chứa "chưa được công ty duyệt"
    (casefold)
  - Evidence: `evidence/v35_eval.log`
- [x] **W35.2 Bảng `eval_runs` (schema idempotent) + drift-guard số bảng** —
  `docs/schema.sql` thêm `create table if not exists eval_runs (id
  bigserial primary key, ts timestamptz not null default now(),
  commit_sha text not null, agent text not null, n_total int, n_pass
  int, pass_rate numeric not null, threshold numeric, passed boolean
  not null, model text, prompt_version text, note text)` + `create
  index if not exists eval_runs_sha_agent_idx on eval_runs
  (commit_sha, agent, ts)`. Không thêm bảng approvals (phiếu duyệt =
  tham số `--approved-by` đối chiếu `approvers` W35.1; approval_queue
  thật là WP03/n8n — external-dep). Số bảng public 10 → 11: cập nhật
  `docs/handover/kien-truc.md` mục 3 ("11 bảng" + dòng `eval_runs`) và
  `tests/test_handover_docs.py::test_kien_truc_lists_all_tables`
  (`== 11`).
  - Boundary: `docs/schema.sql`, `docs/handover/kien-truc.md`,
    `tests/test_handover_docs.py` (chỉ số bảng — không xoá assert khác)
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp exit 0
    trên `samsam_infra`, output liệt kê `eval_runs`;
    `python -m pytest tests/test_handover_docs.py -q` xanh
  - Evidence: `evidence/v35_eval.log`
- [x] **W35.3 Harness chung `scripts/agent_eval.py` ghi `eval_runs`** —
  CLI `python scripts/agent_eval.py --agent {guardrail,chatbot}
  [--sha SHA] [--no-record] [--allow-dirty]`. Runner `guardrail`:
  `guardrail.check(text)["ok"]` so `expect` (tất định, không LLM, không
  key). Runner `chatbot`: `api.rag.answer(q)` (qua gateway, agent_id
  `chatbot` như hiện hành); `trap_health` chấm `handoff == "health"`;
  thiếu `OPENROUTER_API_KEY` → in lỗi rõ, exit 1, KHÔNG ghi row (chưa
  chấm ≠ PASS); exception từng ca → ca đó FAIL, chạy tiếp (như
  eval_qa). `passed` = `pass_rate >= min_pass_rate` VÀ mọi kind trong
  `must_pass_kinds` pass. `commit_sha`: `--sha` > env `GITHUB_SHA` >
  `git rev-parse HEAD`; chuẩn hoá lowercase, phải 40 hex. Working tree
  bẩn (`git status --porcelain --untracked-files=no` khác rỗng) → từ
  chối ghi, trừ `--allow-dirty` thì ghi `commit_sha = <sha>-dirty`
  (deploy gate không bao giờ khớp). `model`: `"rules"` cho guardrail,
  env `OR_CHAT_MODEL`/mặc định cho chatbot; `prompt_version` = 12 hex
  đầu sha256 nội dung các `prompt_files` của agent (đổi guardrail/
  banned_words/claims/prompt → version đổi). Ghi 1 row `eval_runs`
  (connect_timeout, commit tường minh); DB lỗi/down → cảnh báo + exit
  ≠ 0 (không có bằng chứng thì deploy gate fail-closed). Exit 0 chỉ
  khi passed và ghi được (hoặc `--no-record`). In mỗi ca FAIL: id +
  lý do; câu khách/answer cắt ngắn, qua `_mask_pii`.
  - Boundary: `scripts/agent_eval.py` (mới), `tests/test_agent_eval.py`
    (mới); KHÔNG sửa `scripts/eval_qa.py` ngoài việc import lại
    (nếu buộc phải tách hàm để tái dùng thì giữ nguyên tên/hành vi/exit)
  - Gate: test fake conn: chạy guardrail → 1 insert với đúng
    `commit_sha`/`agent`/`pass_rate`/`passed=True`/`model="rules"`/
    `prompt_version` 12 hex; monkeypatch bỏ "điều trị" khỏi banned list
    của guardrail (cache_clear config) → `passed=False`, exit 1 (acceptance
    F17.1 "xoá 'điều trị'"); ngưỡng: pass_rate đạt nhưng 1 `trap_*`
    fail → `passed=False`; chatbot với fake `rag.answer` (không mạng):
    11/12 + trap đủ → PASS, 12/12 nhưng Q12 fail → FAIL, ca gout →
    `handoff` đúng; thiếu key → exit 1, 0 insert; connect raise → exit
    ≠ 0 + cảnh báo, không traceback; `--sha` sai định dạng → exit 2;
    tree bẩn không `--allow-dirty` → 0 insert. E2E: `python scripts/
    agent_eval.py --agent guardrail` exit 0 trên `samsam_infra` rồi
    `python -c` select `eval_runs where commit_sha=<HEAD> and
    agent='guardrail'` ra ≥1 row `passed=true` (worktree có thay đổi
    chưa commit → dùng `--allow-dirty` và ghi rõ trong evidence rằng
    row `-dirty` không mở được deploy)
  - Evidence: `evidence/v35_eval.log`
- [x] **W35.4 Cổng deploy `scripts/deploy_gate.py` (chỉ in kế hoạch)** —
  CLI `python scripts/deploy_gate.py --sha SHA --approved-by "<tên>"
  [--hotfix] [--today YYYY-MM-DD]`. Cho phép (exit 0) CHỈ khi đủ: (1)
  SHA 40 hex; (2) với MỌI agent trong `required_agents`, row
  `eval_runs` MỚI NHẤT (theo `ts`, rồi `id`) cho (sha, agent) có
  `passed = true` — PASS cũ rồi FAIL sau → từ chối; (3) `--approved-by`
  không rỗng VÀ thuộc `approvers` (so casefold/strip); `approvers`
  rỗng → từ chối "danh sách người duyệt chưa được công ty cấp
  (external-dep)" — fail-closed, KHÔNG tự coi ai đã duyệt; (4) ngày
  (mặc định hôm nay Asia/Saigon, `--today` để mô phỏng) trong
  `2026-12-21..2027-02-10` thì phải có `--hotfix` (hotfix vẫn cần (1)–
  (3)). Thiếu điều kiện → exit 1, in từng lý do từ chối (không dừng ở
  lý do đầu). DB lỗi/down → từ chối (fail-closed), không hang
  (connect_timeout). Cho phép → IN kế hoạch systemd theo F17.1
  (checkout `/opt/samsam/releases/<SHA>`, venv sạch `-r <rel>/requirements.txt`,
  `.env` symlink từ `/opt/samsam/shared/.env`, stop service + `mv` state
  runtime `data/zalo_tokens.json`/`zalo_seen.db*`/`conversations.jsonl*`
  từ release đang chạy sang release mới (KHÔNG symlink từng file:
  `os.replace`/`rename` của token store/rotate convlog thay mất link),
  đổi symlink `current` + start theo `docs/zalo-webhook.service`, smoke
  `/healthz` + `agent_eval --agent chatbot --no-record` fail → rollback
  mang state về, giữ 10 release, `guardrail_ver=<SHA>`) — KHÔNG chạy
  lệnh nào, không SSH. `required_agents` rỗng/thiếu → từ chối
  (fail-closed).
  - Boundary: `scripts/deploy_gate.py` (mới), `tests/test_deploy_gate.py`
    (mới); đọc config `data/eval/config.json` (W35.1)
  - Gate: test (DB qua monkeypatch, approvers inject qua config tạm —
    đánh dấu "người duyệt giả lập trong test"): đủ điều kiện → exit 0 +
    output chứa SHA và "releases/<SHA>"; không row eval → từ chối; 1
    agent thiếu PASS → từ chối; PASS rồi FAIL mới hơn → từ chối; row
    `<sha>-dirty` PASS → từ chối; không `--approved-by` / tên ngoài
    `approvers` / `approvers` rỗng → từ chối; biên đóng băng truyền
    `--today` dạng STR: `2026-12-20` cho phép, `2026-12-21` và
    `2027-02-10` từ chối khi không hotfix, `2027-02-11` cho phép,
    `2026-12-22 --hotfix` + PASS + duyệt → cho phép, `--hotfix` thiếu
    PASS → từ chối; `--today` sai định dạng → exit 2 (không traceback);
    connect raise → từ chối exit 1. E2E CLI trên `samsam_infra`: SHA
    không có row → exit 1; SHA có row (W35.3) nhưng approvers rỗng →
    exit 1 với lý do external-dep; `DATABASE_URL=postgresql://u@10.255.255.1:5432/x`
    → exit 1 trong ≤ connect_timeout + vài giây (không hang)
  - Evidence: `evidence/v35_deploy_gate.log`
- [x] **W35.5 `.github/workflows/ci.yml` + chạy tương đương local** —
  `on: push` (main, ai-infra) / `pull_request` / `workflow_dispatch`;
  `permissions: contents: read`; mỗi job `timeout-minutes`. Job `test`
  (`ubuntu-latest`, `actions/checkout` + `actions/setup-python` Python
  3.12, pin theo tag major cụ thể): service container `postgres:16`
  (env user/password/db, health-cmd `pg_isready`, port 5432), env
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/<db>`;
  bước: `pip install -r requirements.txt`, `ruff check .`,
  `python scripts/apply_schema.py`, `python -m ingest.core_store`,
  `python -m pytest -q`, `python scripts/agent_eval.py --agent guardrail`
  (ghi `eval_runs` vào DB service — chỉ là tín hiệu CI, F17.1 thật do
  n8n ghi). Job `test` KHÔNG tham chiếu `OPENROUTER_API_KEY`/`secrets.*`.
  Job `eval` (`needs: test`): `if: github.event_name ==
  'workflow_dispatch'` ở job-level; secret map vào `env` của job và
  bước đầu kiểm `OPENROUTER_API_KEY` rỗng → in "skip: chưa có secret
  (external-dep)" + các bước sau `if: env.OPENROUTER_API_KEY != ''`
  (context `secrets` KHÔNG dùng được trong `if` job-level); bước: setup
  như test + `python -m ingest.embed_store` + `python scripts/
  agent_eval.py --agent chatbot`. Drift-guard test parse YAML.
  - Boundary: `.github/workflows/ci.yml` (mới), `tests/test_ci_workflow.py`
    (mới)
  - Gate: `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8'))"`
    exit 0; test: có job `test` + `eval`, `test.services.postgres`,
    trigger có `workflow_dispatch` (đọc `doc.get("on", doc.get(True))`),
    `eval.if` chứa `workflow_dispatch`, `eval.needs == "test"` (hoặc
    list chứa), chuỗi job `test` không chứa "OPENROUTER" lẫn "secrets.",
    mọi `run:` chứa đủ `ruff check`, `python -m pytest`,
    `apply_schema.py`, `ingest.core_store`, `agent_eval.py`, và mọi
    `python scripts/X.py` / `python -m a.b` được nhắc trong YAML tồn tại
    thật trong repo; chạy tuần tự local đúng các lệnh `run:` của job
    `test` (trừ `pip install`) trên `samsam_infra` → mỗi lệnh exit 0 (ghi
    lệnh + exit code vào evidence; pytest full chỉ chạy 1 lần ở Gate
    chung, không chạy chồng). actionlint: CHỈ chạy nếu image đã có sẵn
    local (`docker image inspect rhysd/actionlint`), KHÔNG pull mới;
    không có → ghi "actionlint skip" trong evidence
  - Evidence: `evidence/v35_ci.log`
- [x] **W35.6 Docs SOP/AGENTS mục CI & deploy** — `docs/handover/sop.md`
  mục 8 thêm ngắn: `python scripts/agent_eval.py --agent guardrail|chatbot`
  (ngưỡng ở `data/eval/config.json`, ghi `eval_runs`), `python scripts/
  deploy_gate.py --sha … --approved-by …` (chỉ in kế hoạch; điều kiện
  PASS + người duyệt + đóng băng 21/12–10/02 chỉ hotfix), CI ở
  `.github/workflows/ci.yml` (eval chatbot chỉ khi chạy tay + có
  secret); ghi rõ phần external-dep. `AGENTS.md` bảng Commands thêm 2
  dòng `agent_eval`/`deploy_gate`. `tests/test_handover_docs.py`
  `SOP_COMMANDS` thêm `agent_eval`, `deploy_gate`.
  - Boundary: `docs/handover/sop.md`, `AGENTS.md` (chỉ bảng Commands),
    `tests/test_handover_docs.py` (chỉ `SOP_COMMANDS`)
  - Gate: `python -m pytest tests/test_handover_docs.py -q` xanh; lệnh
    trong sop.md mục mới chạy được (`--help` exit 0 cho cả 2 script)
  - Evidence: `evidence/v35_ci.log`
- [x] **Gate chung** —
  - targeted ×3: `python -m pytest tests/test_agent_eval.py tests/test_deploy_gate.py tests/test_ci_workflow.py tests/test_handover_docs.py tests/test_guardrail.py -q`
    3 lần liên tiếp xanh (đọc output tới exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 258 + test mới (1 lần, tuần tự)
  - `ruff check .` sạch
  - `python -m py_compile scripts/agent_eval.py scripts/deploy_gate.py scripts/eval_qa.py scripts/apply_schema.py`
  - `python scripts/apply_schema.py` ×2 exit 0 (idempotent, 11 bảng)
  - `git status`: chỉ file trong boundary; không file runtime mới trong
    `data/` cần gitignore; evidence `.log` phải `git add -f`
  - External-dep (SKIP, không giả lập): CI chạy thật trên GitHub +
    secret OpenRouter; self-hosted runner trong nước; production/
    systemd deploy thật; n8n webhook HMAC ghi `eval_runs` + role `ci`
    không quyền ghi; `harness_registry` + Pháp chế ký khi harness đổi;
    danh sách người duyệt thật theo tầng; công ty gán nhãn/duyệt bộ ca
    `data/eval/*.jsonl`
- Kết quả worker (2026-10-12): targeted ×3 vòng 2 = 106/106 ×3; full 318 passed (258 + 60 mới); ruff sạch; py_compile 4 file exit 0; apply_schema ×2 = 11 bảng. Lệch boundary (dây chuyền, đếm bảng 10→11): `tests/test_lead_store.py` + `tests/test_store.py` assert `== 11`. E2E row duy nhất là `<HEAD>-dirty` (tree chưa commit) — không mở được deploy; E2E 'SHA có row PASS sạch + approvers rỗng' chưa chạy được tới khi coordinator commit. actionlint skip (image không có sẵn). Evidence `.log` cần `git add -f`.
- Vòng sửa nghiệm thu (2026-10-12, 4 MINOR): (1) plan deploy giữ `.env`
  shared + chuyển state runtime + pip `-r <rel>/` + smoke/rollback —
  `test_plan_keeps_shared_state_and_smoke`; (2) `required_agents` rỗng/
  None/thiếu → deny — `test_empty_required_agents_fail_closed` (×3);
  (3) `_git_head`/`_git_dirty` chạy git THẬT trên repo tạm —
  `test_git_dirty_and_head_real_repo`; (4) ngưỡng chatbot parity
  eval_qa (2 fact trượt PASS, 3 FAIL thuần ngưỡng) —
  `test_chatbot_threshold_parity_eval_qa`. Probe đột biến: bỏ từng nhánh
  status / đảo bool / chatbot 0.5 / bỏ check required / pip tương đối →
  đều đỏ. Evidence nối vào `evidence/v35_deploy_gate.log` +
  `evidence/v35_eval.log` (mục "vòng sửa nghiệm thu").
- [ ] **external-dep** Công ty/Pháp chế duyệt bộ ca `data/eval/*.jsonl`
  + ngưỡng `data/eval/config.json` — hiện là bộ khởi đầu dev soạn.
- [ ] **external-dep** Danh sách người duyệt theo tầng (`approvers`) +
  phiếu thật (approval_queue WP03 / GitHub issue P1) — rỗng = gate từ
  chối mọi deploy.
- [ ] **external-dep** CI thật (push GitHub, secret `OPENROUTER_API_KEY`,
  self-hosted runner, gateway-staging agent_id `ci`), n8n ghi
  `eval_runs`, `harness_registry`, môi trường production để deploy.

v3.7-ops-monitoring đóng 2026-10-12 (worktree song song `infra-v37`;
3 nghiệm thu đợt 1 FIX 5 → 1 vòng sửa → PASS; coordinator vá thêm 2
NIT an toàn: `clean_detail` che DSN libpq `password=...` (A09, có
test), nhãn bản tin cap 0 = "ĐÃ CHẶN" cho khớp gateway; 297/297 +
ruff). Compose chỉ kiểm `config` — chưa `up` vì image chưa có trên máy
(tải về chưa được duyệt). External-dep: server production + lịch 07:30
thật, SMTP/Resend/Telegram thật, Uptime Kuma theo dõi URL production,
trần chi phí thật. Someday: `--help` ghi job_runs ok; EXPECTED_JOBS
chưa có grace; image pin theo tag chưa theo digest; `docker compose
config` in ra secret đã resolve (SOP nên cảnh báo); vài mutation test
còn sống (late_jobs biên, detail SystemExit, close conn); sop.md còn
ghi "9 bảng".

## Checklist v3.7-ops-monitoring

Khán giả/mục đích: Quản lý hạ tầng AI (worktree `D:\code\samsam-v37`) —
luồng F17.2 (giám sát job lỗi + bản tin sức khỏe 07:30) và F17.3 (FinOps:
cảnh báo 80% trần) trong flows_infra.md; agent "Vận hành hạ tầng" + "FinOps
LLM" (plan_data_platform.md). Hiện trạng: có `llm_usage` + trần tháng
`monthly_cap_usd` trong `data/llm_gateway.json`, gateway đã CHẶN ≥100% và
cảnh báo ≥80% ngay trong request (`pipelines/llm_gateway.py::_gate`,
`WARN_RATIO`, `_SPEND_SQL` tháng theo giờ Asia/Ho_Chi_Minh); có
`content_drafts.status='pending'`; job CLI chạy tay `agents.report`
(tuần), `ingest.lead_store` (ngày) — CHƯA có bảng lịch sử chạy job, chưa
có bản tin sức khỏe, chưa có stack giám sát. Sau version: job ghi lần
chạy vào `job_runs`; `python scripts/health_bulletin.py` ra bản tin
markdown chỉ-số (mọi số từ SQL, 0 lời gọi LLM — chế độ P1 của F17.2),
sống sót khi DB chết; có compose n8n + Uptime Kuma chạy local.

Quy ước: ponytail — stdlib + `psycopg`/`python-dotenv` sẵn có, KHÔNG dep
mới, không `pip install` global. Mọi `psycopg.connect` mới có
`connect_timeout` (≤5s). Print tiếng Việt mới → UTF-8 reconfigure guard
(copy `scripts/zalo_mock.py`). `detail` lỗi job qua
`pipelines.pii._mask_pii` + cắt 300 ký tự (như `llm_usage.error`); bản
tin không chứa user_id/SĐT/nội dung tin nhắn khách. Ghi `job_runs` lỗi/DB
down → cảnh báo, job VẪN chạy và giữ exit code cũ (không phá hành vi).
Test không wall-clock, không gọi mạng, không ghi vào DB thật (monkeypatch
connect/fake conn hoặc `tmp_path`); test DB-down dùng `DATABASE_URL` host
chết `postgresql://u@10.255.255.1:5432/x` (KHÔNG `env -u` — gotcha v2.0).
Bản tin ghi vào `data/reports/` (đã gitignore). Template biến môi trường
mới ghi vào `env.example` (không-dot), không giá trị thật. Hệ thống KHÔNG
tự gửi bản tin (human-gate C2.4) — adapter gửi chỉ là cổng cấu hình.
Lịch 07:30 chỉ GHI HƯỚNG DẪN (schtasks/cron) trong SOP, không tạo
scheduled task thật trên máy.
External-dep (SKIP, không giả lập như thật): server production + lịch
chạy thật 07:30; SMTP/Resend/Telegram bot thật + người nhận; Uptime Kuma
theo dõi URL production (`/zalo-webhook` HTTPS, Streamlit); trần chi phí
thật (cap trong `data/llm_gateway.json` vẫn là ước tính v3.1).

- [x] **W37.1 Bảng `job_runs` + helper ghi lần chạy (context manager)** —
  `docs/schema.sql` thêm idempotent `create table if not exists job_runs
  (id bigserial primary key, job text not null, started_at timestamptz
  not null, finished_at timestamptz, ok boolean, detail text, host text)`
  + `create index if not exists job_runs_job_started_idx on job_runs
  (job, started_at)`. Module mới `pipelines/job_runs.py`: `job_run(job:
  str)` context manager — đo started/finished (timezone-aware UTC),
  `host=socket.gethostname()`, yield dict `run` để body set
  `run["ok"]=False`/`run["detail"]` (vd exit code ≠0); exception trong
  body → ghi `ok=false`, `detail="<TênLỗi>: <msg>"` đã `_mask_pii` + cắt
  300, rồi RE-RAISE nguyên exception; `SystemExit(0|None)` = ok. Ghi 1
  INSERT lúc kết thúc (ponytail; process bị kill cứng → không có dòng →
  bản tin báo "không chạy"). Connect qua `DATABASE_URL` +
  `connect_timeout`; thiếu DSN/connect lỗi/insert lỗi → print cảnh báo
  (không lộ DSN), job không bị ảnh hưởng.
  - Boundary: `docs/schema.sql`, `pipelines/job_runs.py` (mới),
    `tests/test_job_runs.py` (mới); drift-guard dây chuyền:
    `tests/test_handover_docs.py::test_kien_truc_lists_all_tables`
    (`== 10` → `11`) + `docs/handover/kien-truc.md` ("11 bảng" + mô tả
    `job_runs`) — không sửa thì full pytest đỏ.
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp exit 0,
    in có `job_runs`; test (fake conn ghi lệnh): body OK → 1 insert
    `ok=True`, đúng `job`, `finished_at >= started_at`, host không rỗng;
    body raise `ValueError("gọi 0905123456")` → exception lan ra, row
    `ok=False`, detail không match `0\d{9}`, len ≤300; body set
    `run["ok"]=False` → row ok=False; connect raise → body vẫn chạy, giá
    trị trả về giữ, có cảnh báo; `DATABASE_URL` host chết → `with
    job_run("x"): pass` xong ≤10s (đo bằng `time` ở lệnh gate, KHÔNG
    assert wall-clock trong test); 1 lần chạy thật trên DB samsam_infra
    → `select job, ok from job_runs order by id desc limit 1` thấy dòng.
  - Evidence: `evidence/v37_ops.log`
  - KẾT QUẢ: apply_schema ×2 exit 0 (11 bảng, có `job_runs`); 1 dòng thật `('gate.v37.smoke', True, finished>=started, host≠'')`; host chết → cảnh báo `ConnectionTimeout`, body xong, 6.1s; test fake conn 13 case (thêm che DSN/sk-/Bearer trong detail — OWASP A09). Dây chuyền thêm: `tests/test_lead_store.py` + `tests/test_store.py` cũng đếm `== 10` bảng → `11`.
- [x] **W37.2 Áp `job_run` vào job lịch hiện có, không phá hành vi** —
  bọc ĐÚNG ở khối `if __name__ == "__main__":` của `agents/report.py`
  (job `agents.report`) và `ingest/lead_store.py` (job
  `ingest.lead_store`): `with job_run(...) as run: rc = main();
  run["ok"] = rc == 0` rồi `raise SystemExit(rc)`. `main()`/`generate()`
  /`harvest()` GIỮ NGUYÊN chữ ký + output + exit code (report degraded
  khi DB chết vẫn exit 0 → ghi ok=true kèm detail "degraded" nếu đơn
  giản, không bắt buộc). Không bọc job khác trong version này
  (embed_store/core_store/crawler chạy tay theo sự kiện — ghi someday).
  - Boundary: `agents/report.py`, `ingest/lead_store.py` (chỉ khối
    `__main__` + import)
  - Gate: `python -m pytest tests/test_report.py tests/test_lead_store.py -q`
    xanh, số test/assert không giảm; `python -m agents.report` exit 0 và
    `python -m ingest.lead_store` exit code như trước (0 hoặc 1 tùy
    data) → `job_runs` có 2 dòng mới đúng tên job; chạy
    `python -m agents.report` với `DATABASE_URL` host chết → exit 0, báo
    cáo degraded như cũ, có cảnh báo job_runs, xong ≤15s.
  - Evidence: `evidence/v37_ops.log`
  - KẾT QUẢ: report exit 0 + lead_store exit 0 → `job_runs` +1 dòng mỗi job (ok=true); report host chết → degraded như cũ, cảnh báo job_runs, exit 0, 9.1s. Không ghi detail "degraded" (tùy chọn, bỏ). Biết trước: `--help` (SystemExit 0) cũng ghi 1 dòng ok.
- [x] **W37.3 `scripts/health_bulletin.py` — bản tin sức khỏe chỉ-số** —
  CLI `python scripts/health_bulletin.py [--out-dir DIR] [--date
  YYYY-MM-DD]`, ngày mặc định = hôm nay giờ VN (Asia/Ho_Chi_Minh, tzdata
  đã có). Hàm thuần tách riêng (`collect(conn)`, `render(data) -> str`,
  `cost_rows(spend: dict, caps: dict) -> list`) để test không DB. Mục
  bắt buộc trong markdown (heading cố định để test grep):
  (1) **DB**: connect `connect_timeout` ≤5s → "sống" / "DB không truy cập
  được" (+ tên lỗi, không in DSN);
  (2) **Job 24h**: từ `job_runs` 24h qua — số lần OK/lỗi theo job, liệt
  kê job lỗi + `detail`; hằng `EXPECTED_JOBS = {"ingest.lead_store": 24,
  "agents.report": 24*8}` (giờ) → job không có lần chạy OK trong khoảng
  đó báo "không chạy/trễ";
  (3) **Chi phí AI tháng này theo agent**: tổng `llm_usage.cost_usd`
  theo `agent_id` từ đầu tháng giờ VN (cùng biểu thức mốc tháng với
  `_SPEND_SQL`) so với cap đọc qua `pipelines.llm_gateway._config()
  ["monthly_cap_usd"]` (giữ env override + key `default`): % dùng, nhãn
  "CẢNH BÁO" khi ≥80% (`WARN_RATIO`), "ĐÃ CHẶN (gateway)" khi ≥100% —
  bản tin chỉ báo, việc chặn đã do gateway làm; cap 0 → "tắt";
  (4) **Lời gọi lỗi 24h**: count `llm_usage` `ok=false` (theo agent);
  (5) **Hàng chờ duyệt**: count `content_drafts` `status='pending'`.
  Mỗi số ghi kèm bảng nguồn (F17.2: "bản tin có ghi query nguồn"). Thiếu
  bảng (UndefinedTable) → mục đó ghi "chưa có bảng — chạy apply_schema",
  các mục khác vẫn ra. 0 lời gọi gateway/LLM. Output: ghi
  `<out-dir>/health-<YYYY-MM-DD>.md` (mặc định `data/reports/`, đã
  gitignore) + in stdout; DB chết → vẫn ghi file + stdout có "DB không
  truy cập được", exit 0. UTF-8 guard.
  - Boundary: `scripts/health_bulletin.py` (mới),
    `tests/test_health_bulletin.py` (mới)
  - Gate: test `cost_rows`: spend 0.79×cap → không cảnh báo, 0.80×cap →
    "CẢNH BÁO", 1.0×cap → "ĐÃ CHẶN", agent không có cap riêng dùng
    `default`, cap 0 không chia 0; test render với fake data có đủ 5
    heading; test job thiếu lần chạy trong `EXPECTED_JOBS` → "không
    chạy"; test monkeypatch connect raise → markdown có "DB không truy
    cập được", main trả 0; chạy thật DB sống
    `python scripts/health_bulletin.py --out-dir <scratch>` exit 0, file
    có đủ 5 mục với số khớp query tay (spot-check ≥2 số bằng `psql`-
    tương đương `python -c` select); `time DATABASE_URL=postgresql://u@10.255.255.1:5432/x python scripts/health_bulletin.py --out-dir <scratch>`
    → exit 0, ≤10s, stdout có "DB không truy cập được".
  - Evidence: `evidence/v37_ops.log` + bản tin mẫu
    `evidence/v37_bulletin_live.md`, `evidence/v37_bulletin_dbdown.md`
  - KẾT QUẢ: DB sống exit 0, đủ 5 mục, spot-check khớp query tay (pending=0, lỗi LLM 24h=0, job 24h 2/0 mỗi job); host chết → exit 0, 6.0s, "DB không truy cập được (ConnectionTimeout)". `CONNECT_TIMEOUT_S=3` (≤5s, chừa thời gian import). DB samsam_infra chưa có dòng `llm_usage` tháng này → nhãn 80%/100% chỉ chứng minh bằng test (79/80/99/100/150%, default, cap 0).
- [x] **W37.4 Adapter gửi bản tin — cổng cấu hình, KHÔNG gửi thật** —
  trong `scripts/health_bulletin.py`: `--notify` (mặc định TẮT) + env
  `HEALTH_NOTIFY=email|telegram` và biến kênh (`SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASSWORD`, `HEALTH_MAIL_TO`; `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`) — stdlib `smtplib`/`urllib` với timeout. Không có
  `--notify` hoặc thiếu biến → không mở kết nối mạng nào, in "[notify]
  bỏ qua (chưa cấu hình)". Gửi lỗi → cảnh báo, bản tin file/stdout vẫn
  ra, exit 0. Không log token/mật khẩu. Thêm tên biến (không giá trị)
  vào `env.example`.
  - Boundary: `scripts/health_bulletin.py`, `env.example`,
    `tests/test_health_bulletin.py`
  - Gate: test monkeypatch `smtplib.SMTP`/`urllib.request.urlopen` bằng
    fake ghi lời gọi: không `--notify` → 0 lời gọi; `--notify` + env
    telegram đủ → đúng 1 lời gọi, payload là nội dung bản tin, URL không
    bị in ra stdout; fake raise → exit 0 + cảnh báo. KHÔNG chạy gửi thật.
  - Evidence: `evidence/v37_ops.log`
  - KẾT QUẢ: 6 test fake (không flag → 0 lời gọi; --notify chưa cấu hình → 0; telegram đủ → 1 lời gọi, payload = bản tin, token/URL không ra stdout; email STARTTLS→login→send; gửi lỗi → exit 0). Không gửi thật.
  - **external-dep**: SMTP/Resend/Telegram bot thật + danh sách người
    nhận + quyết định Telegram làm kênh thứ 2 (F17.2 depends_on).
- [x] **W37.5 `deploy/docker-compose.monitoring.yml` — n8n Community +
  Uptime Kuma local** — 2 service image PIN version cụ thể (không
  `latest`): `n8nio/n8n:<x.y.z>` + `louislam/uptime-kuma:<1.x.y>`; cổng
  bind CHỈ `127.0.0.1` (`127.0.0.1:5678:5678`, `127.0.0.1:3001:3001`);
  named volume cho data; KHÔNG mật khẩu/khóa mặc định trong file — biến
  bí mật đọc từ env bắt buộc dạng `${N8N_ENCRYPTION_KEY:?...}` (tài khoản
  owner n8n + admin Kuma tạo ở lần mở đầu, không seed); `TZ=Asia/Ho_Chi_Minh`,
  `GENERIC_TIMEZONE` cho n8n (cron 07:30 đúng giờ VN). Thêm tên biến vào
  `env.example`. Ghi chú đầu file: local pilot, production/Kuma trên VM
  runner riêng là external-dep.
  - Boundary: `deploy/docker-compose.monitoring.yml` (mới), `env.example`
  - Gate: `N8N_ENCRYPTION_KEY=dummy docker compose -f deploy/docker-compose.monitoring.yml config`
    exit 0; thiếu biến → `config` lỗi rõ ràng (exit ≠0); grep mọi
    `ports:` đều `127.0.0.1:`; không có `:latest`; nếu docker sẵn (máy có
    Docker 28.4 / Compose v2.39) VÀ được phép pull image: `up -d` →
    `docker compose ps` 2 service running + `curl -s -o /dev/null -w
    "%{http_code}" http://127.0.0.1:3001` và `:5678` trả mã HTTP →
    `down -v` → `docker ps -a --filter label=com.docker.compose.project=<project>`
    rỗng (KHÔNG để container chạy lại sau gate). Không pull được → ghi lý
    do, chỉ gate `config`.
  - Evidence: `evidence/v37_compose.log`
  - KẾT QUẢ: `config` exit 0 (env dummy + qua `--env-file`), thiếu biến exit 1 lỗi rõ; 2 port 127.0.0.1; không `:latest` (n8n 2.4.0, kuma 1.23.17 — tag xác minh tồn tại bằng `docker manifest inspect`); `restart: "no"`. `up -d`/`down -v` CHƯA CHẠY: image chưa có local, pull = tải file cần user cho phép — 0 container của stack trước/sau gate.
  - **external-dep**: Uptime Kuma theo dõi URL production + heartbeat
    hai chiều n8n↔Kuma + workflow n8n gửi cảnh báo thật.
- [x] **W37.6 SOP mục giám sát** — `docs/handover/sop.md` thêm mục ngắn
  "Giám sát vận hành": chạy `python scripts/health_bulletin.py`, đọc 5
  mục + ngưỡng 80%/100%, xem `job_runs` khi job lỗi, lệnh compose up/
  down stack giám sát, hướng dẫn lịch 07:30 (Task Scheduler `schtasks
  /create ... /st 07:30` hoặc cron `30 7 * * *` TZ VN; n8n ghi rõ
  external-dep — image không có python/repo/DSN, Execute Command tắt mặc
  định ở n8n 2.x) — chỉ hướng dẫn; `--notify` cần cấu hình external-dep.
  Mọi lệnh khớp code thật.
  - Boundary: `docs/handover/sop.md`; drift-guard
    `tests/test_handover_docs.py` thêm `health_bulletin` vào danh sách
    lệnh cốt của `test_sop_core_commands`
  - Gate: `python -m pytest tests/test_handover_docs.py -q` xanh; spot-
    check mọi lệnh trong mục mới tồn tại (`python scripts/health_bulletin.py --help` exit 0, file compose tồn tại)
  - Evidence: `evidence/v37_ops.log`
  - KẾT QUẢ: mục `## 6b. Giám sát vận hành` trong sop.md; drift-guard thêm `health_bulletin` + `docker-compose.monitoring.yml`; `--help` exit 0; lệnh compose dùng `--env-file .env`.
- [x] **Gate chung** —
  - targeted ×3: `python -m pytest tests/test_job_runs.py tests/test_health_bulletin.py tests/test_report.py tests/test_lead_store.py tests/test_handover_docs.py tests/test_llm_gateway.py -q`
    3 lần liên tiếp xanh (đọc output tới exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 258 + test mới
    (`evidence/v37_pytest.log`)
  - `ruff check .` sạch
  - `python -m py_compile pipelines/job_runs.py scripts/health_bulletin.py agents/report.py ingest/lead_store.py`
  - `docker compose -f deploy/docker-compose.monitoring.yml config` hợp lệ
    (env dummy); sau gate `docker ps` không còn container của stack
  - `git status`: không file runtime mới ngoài `data/reports/` (đã
    gitignore); evidence `.log` cần `git add -f`; không file lạ
  - External-dep (không treo version): production server + lịch 07:30
    thật; SMTP/Resend/Telegram thật; Uptime Kuma theo dõi URL production;
    trần chi phí thật do công ty chốt.
  - KẾT QUẢ (vòng 2; vòng 1 đỏ 2 drift-guard đếm bảng + 1 ruff): targeted ×3 109/109 xanh; full 292 passed (258 + 34 mới); ruff sạch; py_compile 4 file exit 0; compose config OK. `evidence/v37_pytest.log`.
  - VÁ NGHIỆM THU (5 MINOR): `clean_detail` cắt `PRE_MAX`=1200 TRƯỚC regex (DoS bậc 2 `_SECRET_RE`) + bỏ token dở ở mép cắt (mask làm chuỗi ngắn lại → SĐT dở lọt); SMTP `starttls(context=ssl.create_default_context())`; test gather() thiếu bảng với FakeConn mô phỏng tx aborted khi không autocommit; SOP bỏ phương án n8n Execute Command (ghi external-dep). Mutation 4/4 bị bắt; targeted ×3 113/113; full 296 passed; ruff sạch. `evidence/v37_pytest.log`.
- [ ] **external-dep** Server production + lịch chạy bản tin 07:30 thật
  (systemd timer/n8n trên VM runner) — chưa có, KHÔNG đánh dấu đã chạy.
- [ ] **external-dep** Kênh gửi cảnh báo/bản tin thật (SMTP/Resend,
  Telegram bot) + người nhận — chỉ có cổng cấu hình.
- [ ] **external-dep** Uptime Kuma giám sát `/zalo-webhook` HTTPS +
  Streamlit production (SLO ≥99%) — chỉ chạy thử stack local.

v3.8-ocr-intake đóng 2026-10-12 (worktree song song `infra-v38`; 3
nghiệm thu đợt 1 FIX 3 → 1 vòng sửa → PASS; coordinator chạy lại
307/307 + ruff, sửa 1 dòng return bị dính khoảng trắng). 5 PDF thật
(chỉ đọc): số giấy 4/5, 1 bản scan → `cho_ocr`. External-dep: provider
OCR có phí (FPT/Google, cần TIA, cấm cho tài liệu có PII), Pháp chế
chạy `--verify` thật, allowlist liên hệ công ty, kho bản gốc cloud
object-lock. Someday: provider nước ngoài bị bỏ qua câm (nên cảnh
báo); lỗi provider tương lai làm dừng cả lô; junction Windows chưa có
test (skip khi thiếu quyền symlink); TOCTOU giữa kiểm symlink và đọc
file; `ten_san_pham` 0/4 trên giấy thật (không có nhãn "Tên sản
phẩm:"); PDF chỉ có owner-password chưa thử decrypt(""); sop.md còn
ghi "hiện 9" bảng.

## Checklist v3.8-ocr-intake

Khán giả/mục đích: nhánh `ai-infra` (worktree `D:\code\samsam-v38`) —
WP04b, luồng F15.1 (flows_infra.md: scan → trích text → quét PII → trích
field → Pháp chế xác nhận), agent "Số hóa tài liệu (OCR intake)"
(plan_data_platform.md). Số hóa giấy tiếp nhận công bố, nhãn, hợp đồng
đại lý, hồ sơ vùng trồng vào hệ thống CÓ KIỂM SOÁT: bản gốc bất biến
theo sha256, field pháp lý trích TẤT ĐỊNH (regex, KHÔNG LLM) ở trạng
thái chưa xác minh tới khi người thật chạy CLI xác nhận. Hiện repo
chưa có gì: không bảng `documents`, không module intake; `pypdf` 6.14
có sẵn trong interpreter nhưng CHƯA có trong `requirements.txt`;
`reportlab` KHÔNG có (fixture PDF viết tay); `docs/schema.sql` đang 10
bảng và `tests/test_handover_docs.py::test_kien_truc_lists_all_tables`
khoá cứng `len(tables) == 10` + `"10 bảng"` trong
`docs/handover/kien-truc.md` → thêm 2 bảng là dây chuyền bắt buộc sửa 2
chỗ đó. Khảo sát chỉ-đọc 5 PDF thật (`Downloads/1. Giấy công bố sản phẩm
- *.pdf`, chỉ đếm): 4 file có lớp text (mỗi file 1 số `…/ĐKSP`, ngày
có cả dạng `dd/mm/yyyy` lẫn "ngày d tháng m năm yyyy"), 1 file scan
(0 ký tự) → regex phải hỗ trợ cả 2 dạng ngày; cả 4 file text đều chứa
chuỗi dạng SĐT → `pii_flag=true` là kỳ vọng ĐÚNG (allowlist liên hệ công
ty chưa được Pháp chế duyệt → mặc định flows: mọi SĐT/email là PII).

Quy ước: ponytail — stdlib + `pypdf` (thuần Python, thêm 1 dòng
`requirements.txt` kèm lý do) + `psycopg` sẵn có; KHÔNG `reportlab`/
`fitz`/`PIL` trong code hay test; cấm pip install global. KHÔNG gọi
LLM/gateway/mạng ở bất kỳ nhánh nào của version này (field trích bằng
regex; `ingest/doc_intake.py` không import `pipelines.llm_gateway`/
`openai`/`httpx`). Tên module/CLI: `python -m ingest.doc_intake`.
Cấu hình qua env (ghi vào `env.example`, không ghi `.env*`):
`DOC_INTAKE_DIR` (mặc định `data/intake/`), `DOC_ORIGINALS_DIR` (mặc
định `data/originals/`), `OCR_PROVIDER` (mặc định `none`). `doc_type`
lấy từ thư mục con `intake/<loai>/` theo F15.1 (`giay_tiep_nhan`,
`nhan`, `hop_dong_dai_ly`, `ho_so_vung_trong`; file ở gốc/thư mục lạ →
`khac`). Đuôi nhận: `.pdf`, `.jpg`, `.jpeg`, `.png` (ảnh luôn đi nhánh
OCR, pages=1); đuôi khác bỏ qua có đếm. Trạng thái `documents.status`:
`cho_ocr` | `pending_review` | `verified` | `rejected` (check
constraint); `text_source`: `pdf_text` | `ocr` | `none`; `pii_flag`
NULL = chưa quét được text (scan chờ OCR), true/false = đã quét. Full
text KHÔNG lưu DB, KHÔNG in ra stdout; stdout chỉ in `sha256[:12]`,
`doc_type`, `status`, số đếm — KHÔNG in filename (tên file hợp đồng có
thể chứa tên người) hay nội dung. Print tiếng Việt → UTF-8 guard sau
imports (copy `scripts/zalo_mock.py`). DB qua
`ingest.lead_store.connect()` (connect_timeout=3; None → thông báo +
exit 1, không hang); ghi xong `conn.commit()` tường minh (gotcha
SAVEPOINT v2.1). Thư mục runtime mới (`data/intake/`,
`data/originals/`) gitignore NGAY. Test dùng `tmp_path` + monkeypatch
đường dẫn/`connect` (fake conn ghi SQL như `tests/test_core_store.py`),
không wall-clock, không chạm DB thật; E2E DB thật chỉ ở evidence trên
`samsam_infra` với thư mục intake/originals trỏ vào scratchpad. Giấy tờ
thật KHÔNG vào repo (kể cả `data/originals/` gitignored — evidence
thật chạy hàm thuần, không intake vào repo).
External-dep (không treo version): provider OCR có phí (FPT.AI Reader
trong nước, Google Vision nước ngoài — chỉ cổng cấu hình, bật nước ngoài
là phiếu tầng 2 + TIA); người Pháp chế thật chạy `--verify` (KHÔNG tự
đánh dấu verified trên tài liệu thật); allowlist liên hệ công ty (hotline/
MST/email) do Pháp chế duyệt; object storage cloud có object-lock (dùng
dir local); rule `[TEN]` cho nhãn "Người đại diện" + bước trích field
bằng LLM cho tài liệu Xanh (F15.1 bước 6) — ngoài phạm vi.

- [x] **W38.1 Schema `documents` + `document_fields` (idempotent)** —
  `docs/schema.sql` thêm `create table if not exists documents (sha256
  text primary key check (sha256 ~ '^[0-9a-f]{64}$'), filename text not
  null, doc_type text not null, pages int, text_source text not null
  check in (pdf_text,ocr,none), pii_flag boolean, status text not null
  default 'pending_review' check in (cho_ocr,pending_review,verified,
  rejected), verified_by text, verified_at timestamptz, created_at
  timestamptz not null default now())` + `create table if not exists
  document_fields (sha256 text references documents(sha256) on delete
  restrict, field text not null, value text not null, confidence
  numeric check (0..1), verified boolean not null default false,
  primary key (sha256, field))` + index `documents(status)`. Dây chuyền
  bắt buộc: `tests/test_handover_docs.py` đổi `== 10` → `== 12` (chỉ
  số + message, không xoá assert) và `docs/handover/kien-truc.md` đổi
  "10 bảng" → "12 bảng" + thêm 2 dòng mô tả bảng mới.
  - Boundary: `docs/schema.sql`, `tests/test_handover_docs.py` (1 hằng
    số), `docs/handover/kien-truc.md` (mục 3 bảng DB)
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp exit 0
    trên DB samsam_infra và in có `documents`, `document_fields`;
    `python -m pytest tests/test_handover_docs.py tests/test_core_store.py -q`
    xanh; số assert trong `test_kien_truc_lists_all_tables` trước/sau
    bằng nhau (diff)
  - Evidence: `evidence/v38_ocr_intake.log`
- [x] **W38.2 Intake: sha256 + kho bản gốc bất biến + ghi DB idempotent** —
  `ingest/doc_intake.py`: `sha256_file(path)` (đọc theo khối);
  `store_original(path, sha, originals_dir) -> bool` ghi
  `originals/<sha256>` qua file tạm cùng thư mục rồi tạo đích ở chế độ
  KHÔNG ghi đè (`open(...,'xb')`/`os.link`, không `os.replace`), đã tồn
  tại → không đụng (trả False); file đích có sẵn mà hash ≠ tên → cảnh
  báo "bản gốc lệch hash", KHÔNG ghi đè, tài liệu đó bỏ qua.
  `intake(intake_dir, originals_dir, conn, ocr_provider)` quét đệ quy,
  mỗi file: hash → bản gốc → trích text (W38.3) → PII (W38.4) → field
  (W38.5) → `insert into documents ... on conflict (sha256) do nothing`
  (trùng hash = log "trùng" + KHÔNG trích lại, KHÔNG ghi đè field đã
  verified); trả dict đếm `{new, dup, cho_ocr, skipped, error}`. Biên
  phải xử lý (enumerate, mỗi case 1 test): thư mục intake không tồn
  tại → 0 file, không crash; thư mục rỗng; file 0 byte → skipped; đuôi
  lạ → skipped; PDF hỏng/mã hoá (pypdf raise / `is_encrypted`) →
  error, lô vẫn chạy tiếp file sau; cùng nội dung khác tên file → 1 bản
  ghi. Intake KHÔNG xoá/di chuyển file trong thư mục intake.
  - Boundary: `ingest/doc_intake.py` (mới), `tests/test_doc_intake.py`
    (mới), `.gitignore` (`data/intake/`, `data/originals/`)
  - Gate: test: intake ×2 cùng file (fake conn) → đúng 1 lần
    `insert into documents` mang sha đó được thực thi với rowcount 1,
    lần 2 đếm `dup=1`, `document_fields` không ghi lần 2; bản gốc: sau
    lần 2 bytes + `st_mtime_ns` của `originals/<sha>` không đổi; đích
    có sẵn nội dung khác → không bị ghi đè (bytes giữ nguyên) + đếm
    error; 2 file khác tên cùng nội dung → 1 bản gốc, `new=1, dup=1`;
    6 case biên trên đều có test xanh; `git check-ignore data/intake/x
    data/originals/x` in cả 2 đường dẫn
  - Evidence: `evidence/v38_ocr_intake.log`
- [x] **W38.3 Trích text: pypdf cho PDF có lớp text + provider OCR cắm
  được (mặc định `none`, không mạng)** — `extract_text(path) -> (text,
  pages, text_source)`: PDF → `pypdf.PdfReader`, text NFC; tổng ký tự
  không-trắng < ngưỡng (hằng số, đề xuất 20) coi là scan → gọi provider.
  Provider = registry dict `name -> (callable(path)->str, domestic:
  bool)`; có sẵn duy nhất `none` (domestic, trả `""`) → `text_source=
  'none'`, `status='cho_ocr'`, `pii_flag=NULL`, không field. Tên provider
  không có trong registry (vd `fpt`, `google_vision`) → lỗi cấu hình rõ
  ràng TRƯỚC khi xử lý file (exit 2), ghi external-dep. Provider
  `domestic=False` bị TỪ CHỐI cho mọi tài liệu (PII chưa biết trước khi
  OCR → coi như có PII; bật nước ngoài = phiếu tầng 2 + TIA). Provider
  trả text → `text_source='ocr'` rồi đi tiếp PII/field như pdf_text.
  `requirements.txt` thêm `pypdf>=4` kèm comment lý do.
  - Boundary: `ingest/doc_intake.py`, `requirements.txt`, `env.example`
    (`DOC_INTAKE_DIR`, `DOC_ORIGINALS_DIR`, `OCR_PROVIDER` + comment
    external-dep FPT/Google), `tests/test_doc_intake.py`
  - Gate: test PDF scan (PDF viết tay 1 trang không content stream) và
    1 file `.png` bất kỳ bytes → `status='cho_ocr'`, `text_source=
    'none'`, `pii_flag` None, 0 field, với `socket.socket.connect`
    monkeypatch raise (chứng minh không gọi mạng); fake provider
    domestic trả text có số giấy → `text_source='ocr'` + có field;
    fake provider `domestic=False` → không được gọi (đếm 0 call);
    `OCR_PROVIDER=google_vision` → `main([])` exit 2, connect 0 lần;
    `grep -nE "llm_gateway|openai|httpx|requests" ingest/doc_intake.py`
    rỗng
  - Evidence: `evidence/v38_ocr_intake.log`
- [x] **W38.4 Quét PII → `pii_flag`, chặn đường tới LLM** —
  `pii_flag = _mask_pii(text) != text` dùng `pipelines.pii._mask_pii`
  KHÔNG allowlist (flows F15.1: allowlist chưa duyệt → mọi SĐT/email là
  PII; CCCD 12 số đầu 0 cũng trúng alt SĐT). Docstring ghi rõ: tài liệu
  `pii_flag` true/NULL KHÔNG được gửi LLM; version này không có lời gọi
  LLM nào (W38.3 grep). Không log text/khớp PII; nếu cần in gì về PII
  chỉ in đếm.
  - Boundary: `ingest/doc_intake.py`, `tests/test_doc_intake.py`
  - Gate: test: PDF text fixture có "Dien thoai: 0901234567" →
    `pii_flag is True`; fixture có email → True; fixture chỉ có số
    giấy/ngày/giá "1.500.000" → `pii_flag is False`; capsys: stdout của
    `intake` không chứa "0901234567", filename fixture, hay câu text
  - Evidence: `evidence/v38_ocr_intake.log`
- [x] **W38.5 Trích field giấy tiếp nhận bằng regex tất định (không LLM)** —
  `extract_fields(text) -> dict[field, (value, confidence)]` chỉ áp cho
  `doc_type='giay_tiep_nhan'` và text có được: `so_giay` = `(?<!\d)\d{1,6}/
  \d{4}/(ĐKSP|DKSP)` (không phân biệt hoa thường, giữ nguyên dạng gốc); `ngay_cap` = "ngày d
  tháng m năm yyyy" ưu tiên, fallback `dd/mm/yyyy` (sep `/.-`), chuẩn
  ISO `YYYY-MM-DD`, ngày không hợp lệ (31/02) bị loại qua `datetime`;
  `ten_san_pham` = phần sau nhãn "Tên sản phẩm:" (có dấu/không dấu) tới
  hết dòng, strip, cap 200 ký tự. Confidence: 1.0 nếu đúng 1 ứng viên
  khác nhau, 0.5 nếu >1 (giữ ứng viên đầu); không khớp → không có dòng.
  Ghi `document_fields` với `verified=false`; doc có field →
  `status='pending_review'`; doc text nhưng 0 field → vẫn
  `pending_review` (người rà).
  - Boundary: `ingest/doc_intake.py`, `tests/test_doc_intake.py`
  - Gate: test PDF text fixture viết tay ("So: 1234/2024/DKSP",
    "ngay 05/03/2024", "Ten san pham: Sam Ngoc Linh X") qua
    `extract_text`+`extract_fields` → `so_giay=="1234/2024/DKSP"`,
    `ngay_cap=="2024-03-05"`, `ten_san_pham` đúng; chuỗi Unicode
    "Số: 0123/2023/ĐKSP … ngày 7 tháng 11 năm 2023" →
    `0123/2023/ĐKSP` + `2023-11-07`; "31/02/2024" không ra `ngay_cap`;
    2 số giấy khác nhau → confidence 0.5; số giấy đứng sát chữ số khác
    ("12345678/2024/DKSP", 8 chữ số) KHÔNG ra `so_giay` (không cắt
    đuôi 6 số); mọi dòng field insert có `verified=false`. Evidence thật
    (chỉ-đọc, hàm thuần, KHÔNG copy file, chỉ in số giấy + ngày + đếm):
    5 PDF `Downloads/1. Giấy công bố sản phẩm - *.pdf` → kỳ vọng 4/5 ra
    `so_giay`, 1/5 → `cho_ocr`
  - Evidence: `evidence/v38_ocr_intake.log`, `evidence/v38_real_pdf.log`
- [x] **W38.6 CLI xác nhận của Pháp chế — chỉ đổi trạng thái khi có
  `--by`** — `python -m ingest.doc_intake` (không flag = chạy intake,
  in đếm); `--pending` (liệt kê sha[:12]/doc_type/field chưa xác minh);
  `--verify <sha256> --by "<tên>"` → trong 1 transaction: `documents`
  set `status='verified', verified_by, verified_at=now()` CHỈ khi đang
  `pending_review`, `document_fields.verified=true` cho sha đó, rồi
  `conn.commit()`; `--reject <sha256> --by "<tên>"` → `status='rejected'`
  (field giữ `verified=false`). `--by` thiếu/rỗng/toàn space → `ap.error`
  exit 2 TRƯỚC khi connect DB; sha không đúng 64 hex → exit 2; sha
  không tồn tại hoặc không ở `pending_review` (vd `cho_ocr`, đã
  verified) → exit 1 + thông báo, không update; >1 op cùng lúc (kể cả
  `--pending --verify`) → exit 2 (gotcha n_ops v2.2). Tên người duyệt
  in ra được (người nội bộ tự nhập), sha in `[:12]`.
  - Boundary: `ingest/doc_intake.py`, `tests/test_doc_intake.py`,
    `AGENTS.md` (1 dòng bảng Commands), `docs/handover/sop.md` (1 mục
    SOP số hóa tài liệu — chỉ lệnh có thật)
  - Gate: test `main(argv)` với `connect` monkeypatch đếm lời gọi:
    `--verify <sha>` không `--by` → SystemExit 2, connect 0 lần; `--by
    "  "` → exit 2; sha 63 ký tự → exit 2; `--verify --reject` cùng lúc
    → exit 2; fake conn sha `pending_review` + `--by "Pháp chế A"` →
    exit 0, SQL update chứa `status = %s ... and status = 'pending_review'`
    + update `document_fields` + `commit` gọi 1 lần; sha `cho_ocr` →
    exit 1, 0 update. E2E DB thật (samsam_infra, thư mục scratchpad,
    fixture tự tạo — KHÔNG tài liệu thật): intake ×2 → `select count(*)
    from documents where sha256=…` = 1; `--verify` không `--by` → status
    vẫn `pending_review`; có `--by "test-coordinator"` → `verified` +
    fields verified; dọn row test sau evidence (`delete` theo sha fixture)
  - Evidence: `evidence/v38_ocr_intake.log`
- [x] **Gate chung** —
  - targeted ×3: `python -m pytest tests/test_doc_intake.py tests/test_handover_docs.py tests/test_core_store.py -q`
    3 lần liên tiếp xanh (lệnh nặng có thể bị đẩy nền — đọc output tới
    khi exit rồi mới chạy lần kế, không chạy chồng, không retry mù)
  - full: `python -m pytest -q` xanh, ≥ 258 + số test mới
  - `ruff check .` sạch
  - `python -m py_compile ingest/doc_intake.py scripts/apply_schema.py`
  - `git status`: chỉ file trong Boundary W38.1–W38.6 + evidence;
    `data/intake/`, `data/originals/` ignored; không PDF/ảnh nào được
    track (`git ls-files | grep -iE "\.(pdf|png|jpe?g)$"` không có file
    mới); `lv2-market-top.png` lạ giữ untracked
  - External-dep: provider OCR có phí (FPT.AI Reader / Google Vision +
    TIA) chỉ cổng cấu hình; Pháp chế thật chạy `--verify` trên tài liệu
    thật; allowlist liên hệ công ty do Pháp chế duyệt; object storage
    cloud + object-lock
- Ghi chú worker v3.8 (lệch contract, có lý do):
  - W38.1 dây chuyền contract bỏ sót: `tests/test_lead_store.py` +
    `tests/test_store.py` cũng khoá `== 10` số `create table` → đổi 12
    (chỉ hằng số; full vòng 2 đỏ 2 test này, vòng 3 xanh).
  - W38.4 `pii_flag` = đếm token `***` tăng sau `_mask_pii` thay vì
    `_mask_pii(text) != text`: `_mask_pii` unwrap "(1500)" → " 1500 "
    làm text đổi dù không PII (báo oan) — test `Gia (1500) va (90)`.
  - W38.6 `--pending` in sha256 ĐẦY ĐỦ (cần để chạy `--verify` 64 hex);
    intake/verify vẫn in `[:12]`. `--by` thêm chặn >100 ký tự / ký tự
    điều khiển (exit 2).
  - OWASP (Phần B): trích text từ BẢN GỐC đã kiểm hash (không đọc lại
    file intake); symlink/junction ra ngoài intake → skip;
    `ten_san_pham` bỏ ký tự điều khiển (in ra terminal ở `--pending`).
  - Evidence thật: so_giay 4/5, cho_ocr 1/5, ngay_cap 4/4;
    `ten_san_pham` 0/4 — giấy tiếp nhận thật KHÔNG có nhãn
    "Tên sản phẩm:" (regex theo contract không áp).
  - Gate: targeted ×3 xanh 3 vòng; full 299 passed (258 + 41); ruff
    sạch; E2E DB samsam_infra (intake ×2 → count 1, verify/reject, dọn
    row). `evidence/v38_*.log` bị `*.log` ignore → coordinator `git add -f`.
  - Fix nghiệm thu (3 MINOR): (A04) scan vs text quyết THEO TRANG,
    `SCAN_MIN_CHARS` 20 tổng → 50/trang — 1 trang dưới ngưỡng (watermark
    "Scanned with CamScanner" 21 ký tự, footer "Trang 1/10", bìa đánh máy
    + trang scan) → cả tài liệu `cho_ocr`, `pii_flag` NULL (fail-closed;
    trang chữ ký ngắn/trang trắng cũng sang `cho_ocr` — lệch an toàn);
    test `test_scan_with_small_text_layer_cho_ocr_pii_null` ×4 +
    `test_multi_page_all_text_is_pdf_text`; 5 PDF thật không đổi (4/5).
    (A01) `test_junction_outside_intake_skipped` dùng
    `_winapi.CreateJunction` (rglob đi vào junction, symlink-dir thì
    không → test cũ không chạm guard). DB lỗi giữa lô:
    `test_db_error_rolls_back_and_batch_continues` (`AbortingConn` mô
    phỏng InFailedSqlTransaction tới khi rollback) +
    `test_insert_race_rowcount0_dup_no_fields`. Mutation probe 5 mutant
    (code cũ / tổng-50 / bỏ guard resolve / bỏ rollback / bỏ nhánh race)
    đều đỏ; full 307 passed (299 + 8); ruff sạch.
- [ ] **external-dep** Provider OCR có phí: FPT.AI Reader (trong nước —
  báo giá + POC trước 25/10 theo flows) / Google Vision (nước ngoài —
  phiếu tầng 2 + TIA, cấm cho tài liệu có PII). Hiện chỉ `none`.
- [ ] **external-dep** Pháp chế thật xác nhận field (`--verify --by`) —
  KHÔNG đánh dấu verified hộ trên tài liệu thật.
- [ ] **external-dep** Allowlist liên hệ công ty (hotline/email/MST) cho
  OCR do Pháp chế duyệt — chưa có thì mọi SĐT/email = PII (hiện trạng).
- [ ] **external-dep** Kho bản gốc cloud trong nước có object-lock/
  bucket policy cấm xoá — hiện dir local `DOC_ORIGINALS_DIR`.

v3.1-llm-gateway đóng 2026-10-11 (3 nghiệm thu song song PASS vòng 0;
coordinator vá thêm 3 điểm nghiệm thu ghi NIT nhưng ảnh hưởng khách/
FinOps: (1) lọc sức khỏe bỏ "ho"/"gan" trần — "Ho Chi Minh", "gan"(=gần)
gõ không dấu bị chuyển người oan → giữ dạng cụm "bị ho", "men gan"...;
(2) model chưa có giá tính theo giá cao nhất đã biết thay vì 0 (trần
tháng không mất tác dụng); (3) GatewayBlocked ở chatbot Zalo → khách
nhận HANDOFF_TEXT thay vì ERROR_FALLBACK. 258/258 + ruff; live smoke
OpenRouter zdr=true route sang Azure. `/security-review` không chạy
được (skill cần `origin/HEAD`) → coordinator tự rà OWASP trên gateway:
sạch. External-dep: DPIA/TIA ký, bảng giá + trần thật do công ty chốt.
Someday: cap TOCTOU khi gọi song song; 2 conn DB/lời gọi; `rag.retrieve`
`psycopg.connect` chưa có connect_timeout (có từ trước); test PII chưa
phủ "+84" và PII rải nhiều lượt history.

## Checklist v3.1-llm-gateway

Khán giả/mục đích: nhánh `ai-infra` (M30, worktree `D:\code\samsam-infra`)
— WP01, luồng F17.3 FinOps + F17.5 kill-switch, agent "Gateway bảo mật,
PII & đồng ý" + "FinOps LLM" (plan_data_platform.md). Hiện 3 chỗ tự tạo
`OpenAI(`: `api/rag.py::_clients` (embeddings + chat `_standalone`/
`answer`), `pipelines/content.py::draft`, `ingest/embed_store.py::main`;
`connectors/zalo.py` gửi câu khách thô vào `rag.answer`. Sau version:
MỌI lời gọi LLM/embedding đi qua 1 module `pipelines/llm_gateway.py`
kèm `agent_id`; không còn `OpenAI(` ở nơi khác.

Quy ước: ponytail — stdlib + `openai`/`psycopg` sẵn có, không dep mới.
Return shape của `rag.answer`/`retrieve`, `content.draft`/`draft_multi`,
`embed_store.embed_all` GIỮ NGUYÊN (chỉ được THÊM key, vd `handoff`).
Test dùng fake client ghi payload (monkeypatch factory client trong
gateway), không gọi mạng; không wall-clock. agent_id đề xuất:
`chatbot` (rag.answer/_standalone/retrieve), `content` (draft),
`ingest` (embed_store). Print tiếng Việt mới → UTF-8 guard; log không
chứa id/SĐT thô (`_mask_pii`/`_uhash`). File runtime/state mới trong
`data/` → gitignore ngay; config mặc định commit được thì không chứa
secret. Connect DB của gateway có `connect_timeout`.
External-dep: DPIA/TIA ký bởi Pháp chế (chỉ template nếu cần, KHÔNG
đánh dấu đã ký); xác minh endpoint ZDR theo từng model là phía nhà cung
cấp; trần chi phí/bảng giá thật do công ty chốt (mặc định là ước tính).

- [x] **W31.1 Tách `_mask_pii` sang module dùng chung** — chuyển
  `_mask_pii` (+ `_paren_group_end`, `_PII_RE`, budget) từ
  `connectors/zalo.py` sang `pipelines/pii.py`; `zalo.py` import lại
  cùng tên để test cũ không vỡ.
  - Boundary: `pipelines/pii.py` (mới), `connectors/zalo.py` (chỉ đổi
    import/xoá định nghĩa đã dời)
  - Gate: `python -m pytest tests/test_zalo.py -q` xanh (gồm
    `test_mask_pii_regex_boundaries`, `test_mask_pii_vn_prefix_and_multi_sep`);
    `python -c "from connectors.zalo import _mask_pii; from pipelines.pii import _mask_pii as m; assert _mask_pii is m"`
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.2 Gateway: chat/embed + PII mask + privacy routing fail-closed** —
  `pipelines/llm_gateway.py` với `chat(agent_id, messages, **kw)` và
  `embed(agent_id, input)`; `OpenAI(base_url=openrouter)` CHỈ tạo ở
  đây. Trước khi gửi: `_mask_pii` mọi `content` str của MỌI message
  (system/history/user) và input embedding (str hoặc list). Chat gửi
  `extra_body={"provider": {"data_collection": "deny", "zdr": True,
  "allow_fallbacks": False, "only": [whitelist từ config]}}` (embed
  cùng provider block nếu OpenRouter nhận; nếu không, ghi lý do trong
  docstring). Whitelist rỗng/thiếu hoặc lỗi API → raise `GatewayError`
  rõ nghĩa, KHÔNG retry sang provider/endpoint khác.
  - Boundary: `pipelines/llm_gateway.py`, config `data/llm_gateway.json`
    (whitelist provider, bảng giá USD/1M token theo model, cap mặc
    định, kill list) + env override
  - Gate: test fake client: payload gửi đi không match regex SĐT
    (`0\d{9}`, `+84…`) và email dù input có ở system/history/user/embed;
    `extra_body["provider"]` đúng 4 key/giá trị; whitelist rỗng →
    `GatewayError` và fake client 0 call; fake raise lỗi → `GatewayError`,
    client gọi đúng 1 lần
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.3 Bảng `llm_usage` + ghi usage không chặn dịch vụ** —
  `docs/schema.sql` thêm `create table if not exists llm_usage (id,
  ts timestamptz default now(), agent_id, model, tokens_in, tokens_out,
  cost_usd numeric, ok boolean, error text)` + index `(agent_id, ts)`
  idempotent; gateway ghi 1 dòng mỗi lời gọi (ok và err), cost =
  tokens × giá cấu hình (model không có giá → 0 + cảnh báo). Ghi DB
  lỗi/DB down → print cảnh báo, lời gọi vẫn trả kết quả.
  - Boundary: `docs/schema.sql`, `pipelines/llm_gateway.py`
  - Gate: `python scripts/apply_schema.py` chạy 2 lần liên tiếp exit 0
    trên DB samsam_infra; test: usage row đúng agent_id/tokens/cost/ok;
    monkeypatch connect raise → chat vẫn trả kết quả + có cảnh báo;
    `DATABASE_URL` host chết (`postgresql://u@10.255.255.1:5432/x`) →
    không hang (connect_timeout)
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.4 Trần chi phí tháng + kill-switch theo agent_id** —
  cap USD/tháng theo agent_id (config, có mặc định); tổng tháng hiện
  tại (múi giờ ghi rõ trong docstring) đọc từ `llm_usage`: ≥100% →
  raise `GatewayBlocked` TRƯỚC khi gọi client; ≥80% → log cảnh báo rồi
  vẫn gọi. Cờ kill theo agent_id (config file hoặc env
  `LLM_KILL=a,b`) → từ chối ngay. DB không đọc được khi check cap →
  chính sách ghi rõ (đề xuất: cho qua + cảnh báo, nhất quán W31.3) và
  có test.
  - Boundary: `pipelines/llm_gateway.py`, `data/llm_gateway.json`
  - Gate: test: kill bật → `GatewayBlocked`, fake client 0 call; spend
    giả = 100% cap → chặn, 0 call; 80% → gọi + cảnh báo; agent khác
    không bị ảnh hưởng
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.5 Bộ lọc câu hỏi sức khỏe trước LLM ở chatbot khách** —
  `is_health_question(text)` (từ khóa bệnh/triệu chứng/thuốc có dấu +
  không dấu, NFC + casefold, word-boundary) gọi ĐẦU `api/rag.answer`
  TRƯỚC `_standalone`/`retrieve`: trúng → không gọi gateway, trả
  `{"answer": NO_DATA, "sources": [], "handoff": "health"}` —
  `connectors/zalo.py` nhánh `NO_DATA in raw` đã gửi `HANDOFF_TEXT`
  (nếu cần log `[handoff]` phân biệt lý do, id qua `_uhash`).
  - Boundary: `pipelines/llm_gateway.py` (hoặc `pipelines/health_filter.py`),
    `api/rag.py`, `connectors/zalo.py` (tối thiểu)
  - Gate: test: `answer("bị gout uống Savigout được không")` với fake
    gateway → 0 lời gọi LLM/embed, `handoff=="health"`; không dấu
    "bi gout uong thuoc duoc khong" cũng trúng; "sâm Ngọc Linh giá bao
    nhiêu" KHÔNG trúng; zalo test câu gout → khách nhận `HANDOFF_TEXT`
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.6 Migrate 3 call site, giữ hành vi** — `api/rag.py`
  (`_clients` bỏ OpenAI; `retrieve` → `embed("chatbot")`,
  `_standalone`/`answer` → `chat("chatbot")`), `pipelines/content.py::draft`
  → `chat("content")`, `ingest/embed_store.py` (`embed_all`/`main`) →
  `embed("ingest")`, cập nhật docstring embed_store dòng 5. Guardrail/
  NO_DATA/None-content xử lý y như cũ.
  - Boundary: `api/rag.py`, `pipelines/content.py`, `ingest/embed_store.py`,
    test liên quan (`tests/test_rag.py`, `tests/test_content.py`) chỉ đổi
    điểm monkeypatch, không xoá assert (đối chiếu số assert trước/sau)
  - Gate: `grep -rn "OpenAI(" --include=*.py . | grep -v llm_gateway.py`
    rỗng; `python -m pytest tests/test_rag.py tests/test_content.py -q`
    xanh; `python scripts/zalo_mock.py` exit 0
  - Evidence: `evidence/v31_gateway.log`
- [x] **W31.7 Live smoke 1 lời gọi thật qua gateway** — 1 chat
  `openai/gpt-4o-mini`, prompt không PII, max_tokens nhỏ, agent_id
  `smoke`, qua routing params W31.2; ghi status/model/provider trả về +
  dòng `llm_usage` (KHÔNG in key/DSN). OpenRouter báo không có provider
  ZDR khớp whitelist → giữ fail-closed, ghi **external-dep** kèm lỗi.
  - Boundary: lệnh `python -c`/script tạm (không vào test suite)
  - Gate: exit 0 với response OK, hoặc lỗi provider rõ ràng ghi
    external-dep (không nới routing cho pass)
  - Evidence: `evidence/v31_live_smoke.log`
- [x] **Gate chung** —
  - targeted ×3: `python -m pytest tests/test_llm_gateway.py tests/test_rag.py tests/test_content.py tests/test_zalo.py -q`
    3 lần liên tiếp xanh (đọc output tới exit, không chạy chồng)
  - full: `python -m pytest -q` xanh, ≥ 219 + test mới
  - `ruff check .` sạch
  - `python -m py_compile pipelines/llm_gateway.py pipelines/pii.py api/rag.py pipelines/content.py ingest/embed_store.py connectors/zalo.py`
  - `git status`: file runtime mới trong `data/` đã gitignore; không file lạ
  - External-dep: DPIA/TIA ký Pháp chế; xác minh ZDR từng model phía
    provider; bảng giá/cap thật do công ty chốt
- [ ] **external-dep** DPIA/TIA ký bởi Pháp chế — chưa có, KHÔNG đánh dấu đã ký.
- [ ] **external-dep** Xác minh ZDR từng model phía provider — live smoke
  2026-10-11 chat gpt-4o-mini + embed text-embedding-3-small đều route
  Azure dưới `zdr:true` (evidence/v31_live_smoke.log); cam kết hợp đồng
  ZDR vẫn là việc phía nhà cung cấp.
- [ ] **external-dep** Bảng giá USD/1M token + cap tháng thật do công ty
  chốt (`data/llm_gateway.json` hiện là ước tính); `pii_allow` (hotline/
  email công khai công ty) cần người phụ trách xác nhận.

v3.0-guardrail-hotfix đóng 2026-10-11 (workflow: contract → worker
/ship → 3 nghiệm thu song song → 2 vòng sửa → PASS; coordinator chạy
lại 219/219 + ruff + 2 câu gate, `/code-review` low: 0 finding).
External-dep: Pháp chế duyệt `SAFE_PHRASES`/`NEGATION_FLIPS`/bộ câu
bẫy. Someday (NIT nghiệm thu, chưa vá):
- **Unicode NFD lọt toàn bộ guardrail** (có từ trước): chữ dựng sẵn
  dạng NFD qua `check()` ok=True — chuẩn hóa NFC đầu `check()`.
- `NEGATION_FLIPS` danh sách đóng: "lẽ nào", "sai khi nói", "đừng
  nghĩ", phủ định kép lồng vẫn lọt; '?' full-width/không dấu hỏi
  ("…ư", "…sao") lọt; tag-question sau khuyến cáo đúng bị chặn nhầm.
- `SAFE_PHRASES` không neo đuôi: "không phải là thuốc tây nên…" vẫn
  miễn cụm "thuốc".
- Vòng `_inside` cũ O(n·m) (~4s/100KB) — input thật ~2KB.
- Test khẳng định chỉ assert `not ok`, chưa assert loại/span vi phạm;
  bộ đếm case trong `test_handover_docs` giòn với parametrize dạng khác.

## Checklist v3.0-guardrail-hotfix

Khán giả/mục đích: nhánh `ai-infra` (M30 trong TASKS.md, worktree
`D:\code\samsam-infra`). Đây là bản vá an toàn pháp lý TPBVSK phải
xong trước mọi agent bán hàng/marketing. `SAFE_PHRASES` trong
`pipelines/guardrail.py` có mục trần `"thay thế thuốc chữa bệnh"`,
không có từ phủ định đi trước. Vì vậy mọi câu KHẲNG ĐỊNH chứa cụm này
cũng được miễn kiểm từ cấm. Probe thật ngày 2026-10-11 trên HEAD
`03c14a1` cho ra `ok=True`, 0 violation, với 7 câu:
- "Dạ An Sâm có thể thay thế thuốc chữa bệnh mất ngủ."
- "Da An Sam co the thay the thuoc chua benh mat ngu." (không dấu)
- "Sản phẩm dùng để thay thế thuốc chữa bệnh."
- "Uống sâm là đủ, thay thế thuốc chữa bệnh hoàn toàn."
- "Sản phẩm không thay thế thuốc được thì sao, nó thay thế thuốc chữa
  bệnh tốt."
- "Không ai nói nó không phải là thuốc, nó thay thế thuốc chữa bệnh."
- "Ai bảo sản phẩm không thay thế thuốc? Nó thay thế được." (phủ định
  kép/tu từ)

Các câu đã bị chặn sẵn, chỉ cần khóa hồi quy: "giúp thay thế thuốc…"
(`unverified_claim`), "thay thuốc", "không cần uống thuốc"
(`banned_word: thuốc`).

Quy ước:
- Giữ nguyên signature và shape trả về của `check(text) -> {"ok",
  "violations", "matched_claims"}`. Không đổi `_find_terms`/`_inside`/
  `_claim_spans`, trừ khi item dưới đây nêu rõ.
- Không đụng `data/banned_words.txt`, `data/claims_whitelist.json`,
  `pipelines/content.py`, `api/rag.py`, `connectors/zalo.py`.
- Câu khuyến cáo bắt buộc (`pipelines/content.py:75-76`, "Sản phẩm
  không phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh.")
  vẫn phải `ok=True` khi đứng một mình, đứng giữa đoạn dài, và khi viết
  không dấu.
- Test viết dạng `pytest.mark.parametrize` để ít tên test mới.
  Drift-guard `test_guardrail_test_names_in_phu_luc_d` buộc mọi tên
  `def test_*` trong `tests/test_guardrail.py` phải có trong
  `docs/handover/phu-luc-d.md`.
- Không chạy `scripts/eval_qa.py` trong gate: nó gọi LLM có phí và
  output không tất định. Q12 dùng `guardrail.check` và đã được unit
  test cover.
- External-dep: Pháp chế/người duyệt thật xác nhận danh sách câu
  khuyến cáo được miễn (`SAFE_PHRASES`) và bộ câu bẫy. Ghi
  "external-dep — chờ Pháp chế Sâm Sâm duyệt", KHÔNG đánh dấu đã duyệt.
  Ngoài phần này, version thuần code, không cần công ty cấp gì.

- [x] **W30.1 `SAFE_PHRASES` chỉ giữ dạng phủ định**
  - Bỏ mục trần `"thay thế thuốc chữa bệnh"`.
  - Mọi mục phải bắt đầu bằng từ phủ định `không`. Bộ tối thiểu:
    `"không phải là thuốc"`, `"không có tác dụng thay thế thuốc chữa
    bệnh"`, `"không có tác dụng thay thế thuốc"`, `"không thay thế
    thuốc chữa bệnh"`, `"không thay thế thuốc"`.
  - Phải có mục dài `"không có tác dụng thay thế thuốc chữa bệnh"`. Sau
    khi bỏ mục trần, chỉ mục này còn bao được span `chữa` trong câu
    khuyến cáo chuẩn.
  - Sửa comment ở `guardrail.py:29-31` cho đúng: chỉ miễn khi cụm phủ
    định đúng dạng khuyến cáo.
  - Sau bản vá, các câu khẳng định sau phải bị flag `banned_word`
    (`thuốc`/`chữa`) vì span nằm ngoài mọi safe hit: "có thể / dùng để
    thay thế thuốc chữa bệnh", "không chỉ thay thế thuốc chữa bệnh",
    "không phải là thuốc nhưng còn tốt hơn thuốc", và vế khẳng định
    đứng sau một vế phủ định trong cùng đoạn.
  - Boundary: `pipelines/guardrail.py` (hằng `SAFE_PHRASES` + comment)
  - Gate: `python -c` in `check("Dạ An Sâm có thể thay thế thuốc chữa
    bệnh mất ngủ.")["ok"]` → `False`, và `check("Thực phẩm này không
    phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh.")["ok"]`
    → `True`. Chạy với `PYTHONPATH` = repo hoặc qua pytest. Stdout phải
    có UTF-8 guard (`sys.stdout.reconfigure(encoding="utf-8")`).
    Thêm test cấu trúc: `all(p.startswith("không ") for p in
    g.SAFE_PHRASES)`.
  - Evidence: `evidence/v30_probe.log`, gồm probe 7 câu lỗ hổng ở trên,
    TRƯỚC bản vá (chạy probe trên HEAD trước khi sửa, KHÔNG dùng `git
    stash`) và SAU bản vá.
- [x] **W30.2 Chặn phủ định kép/tu từ trước cụm khuyến cáo**
  - Một safe hit KHÔNG được miễn nếu trong cùng clause (ngắt theo
    `[.,;:!?\n]` như `_claim_spans`), phần text đứng TRƯỚC hit chứa
    một cụm đảo nghĩa: `không ai|ai bảo|ai nói|chẳng lẽ|đâu phải`.
  - So khớp trên cả bản có dấu lẫn bản `_strip_len` (bắt
    "khong ai"/"ai bao").
  - Cũng KHÔNG miễn khi clause chứa hit kết thúc bằng `?`. Câu hỏi tu
    từ "…không thay thế thuốc?" không phải khuyến cáo.
  - Giải pháp tối thiểu: lọc `safe_hits` trước vòng banned-word. Không
    thêm class/abstraction, không thêm dependency.
  - Phải trace: câu khuyến cáo chuẩn có 2 safe hit trong cùng clause
    (vế 2 có prefix "không phải là thuốc và"). Prefix này không chứa
    cụm đảo nghĩa nào, nên vẫn `ok=True`.
  - Boundary: `pipelines/guardrail.py` (bộ lọc `safe_hits` trong
    `check()`, có thể thêm 1 hằng tuple + 1 helper nhỏ)
  - Gate: test. "Ai bảo sản phẩm không thay thế thuốc? Nó thay thế
    được.", "Chẳng lẽ sản phẩm không phải là thuốc?" và "Khong ai bao
    san pham khong phai la thuoc." → `ok=False`. Toàn bộ câu khuyến cáo
    đúng ở W30.3 vẫn `ok=True`.
  - Evidence: `evidence/v30_probe.log` (phần SAU bản vá)
- [x] **W30.3 Bộ câu bẫy hồi quy `tests/test_guardrail.py`**
  - Giữ nguyên 12 test cũ, kể cả `test_disclaimer_phat_ly_pass` và
    `test_thuoc_claim_van_chan`. Không xóa hay sửa assert cũ.
  - Thêm `test_affirmative_thay_the_thuoc_flagged` (parametrize, ≥12
    câu, mỗi câu `ok=False` và có violation). Gồm:
    - 7 câu lỗ hổng ở trên
    - "Sản phẩm giúp thay thế thuốc chữa bệnh."
    - "Sản phẩm thay thuốc hiệu quả."
    - "Dùng sâm thì không cần uống thuốc nữa."
    - "Sản phẩm không chỉ thay thế thuốc chữa bệnh mà còn bồi bổ."
    - "Sâm không phải là thuốc nhưng còn tốt hơn thuốc."
    - "Chẳng lẽ sản phẩm không phải là thuốc?"
    - "Khong ai bao san pham khong phai la thuoc."
  - Thêm `test_disclaimer_variants_pass` (parametrize, ≥5 câu, mỗi câu
    `ok=True`, in `violations` khi fail). Gồm:
    - câu nguyên văn ở `content.py:75-76`
    - "Thực phẩm này không phải là thuốc và không có tác dụng thay thế
      thuốc chữa bệnh."
    - bản không dấu của câu trên
    - "Sản phẩm không thay thế thuốc chữa bệnh."
    - "Lưu ý: sản phẩm không phải là thuốc."
    - một đoạn dài ≥3 câu, câu khuyến cáo nằm GIỮA, đi kèm claim
      whitelist Sapentol "hỗ trợ hạ đường huyết". Câu trang trí không
      được có động từ claim.
  - Thêm `test_safe_phrases_all_negated`: assert cấu trúc ở W30.1.
  - Boundary: `tests/test_guardrail.py`
  - Gate: `python -m pytest -q tests/test_guardrail.py` xanh ×3. Đếm
    số assert/test cũ trước và sau bằng `git diff` (gotcha v1.7: không
    làm mất coverage cũ).
  - Evidence: `evidence/v30_pytest.log`
- [x] **W30.4 Đồng bộ doc (dây chuyền drift-guard) + rà cùng lớp lỗi**
  - `docs/handover/phu-luc-d.md`: thêm 3 dòng bảng guardrail cho 3 tên
    test mới (text mẫu + kỳ vọng). Nếu thiếu,
    `tests/test_handover_docs.py::test_guardrail_test_names_in_phu_luc_d`
    sẽ fail.
  - `STATUS.md` (khoảng dòng 315-317): sửa câu mô tả `SAFE_PHRASES`
    đang trích mục trần đã bỏ, thành "chỉ cụm phủ định, chặn phủ định
    kép/tu từ".
  - Rà cùng idiom, theo AGENTS.md "vá theo cụm":
    `grep -rn "SAFE_PHRASES\|_inside\|thay thế thuốc\|không phải là thuốc"`
    trên `pipelines/ api/ agents/ connectors/ ingest/ app/ scripts/`.
    Chứng minh không còn whitelist/miễn trừ nào khác cho cụm từ cấm
    ngoài `guardrail.py`. `content.py:75-76` chỉ là prompt, không phải
    exemption.
  - Lối miễn còn lại là `claim_hits` (claim whitelist). Ghi nhận trong
    log là nó ngoài phạm vi: claim do ĐKSP công bố, không chứa
    "thuốc". Có lỗ thì ghi someday, KHÔNG vá trong version này.
  - Boundary: `docs/handover/phu-luc-d.md`, `STATUS.md`
  - Gate: `python -m pytest -q tests/test_handover_docs.py` xanh. Dán
    output grep vào evidence.
  - Evidence: `evidence/v30_probe.log` (mục "grep cùng lớp lỗi")

- [ ] **External-dep — chờ Pháp chế Sâm Sâm duyệt** danh sách `SAFE_PHRASES` + `NEGATION_FLIPS` + bộ câu bẫy
  (`tests/test_guardrail.py`). CHƯA có người duyệt thật — không đánh dấu đã duyệt.
- Worker v3.0 (2026-10-11): vòng 1 ruff FAIL (ISC004, chuỗi nối ngầm trong list test) → vòng 2
  xanh: targeted 41 passed ×3, full 214 passed (191 + 23 case mới), ruff sạch, py_compile OK,
  gate thêm 2 câu đúng. Evidence `evidence/v30_probe.log`, `evidence/v30_pytest.log`.
- Worker v3.0 vòng 3 (vá 2 MINOR nghiệm thu): +4 case khẳng định chốt riêng nhánh '?' (không kèm
  flip) và flip CÓ DẤU (không '?'). Mutation M_noq / M_noflip / M_ascii_flips giờ đỏ 2 / 3 / 2 case
  (trước: 0 / 1 / 0). Targeted 45 passed ×3, full 218 passed (191 + 27), ruff sạch.
  Evidence `evidence/v30_pytest.log` (mục VÒNG 3), `evidence/v30_mutation.log`.
- Worker v3.0 vòng 4 (vá MINOR drift doc): `docs/handover/phu-luc-d.md` 14→18 câu bẫy (+2 vd nhóm
  mới), "15 test (35 case)"→"(39 case)". Drift-guard cũ chỉ check tên test → thêm
  `test_guardrail_case_counts_in_phu_luc_d` (parse AST đếm câu bẫy/disclaimer/tổng case); mutation
  đổi lại 14 / 35 / 7 → đỏ cả 3. Targeted 46 passed ×3, full 219 passed, ruff sạch.
  Evidence `evidence/v30_pytest.log` (mục VÒNG 4), `evidence/v30_mutation.log` (mục VÒNG 4).

Gate chung:
- targeted ×3: `python -m pytest -q tests/test_guardrail.py
  tests/test_handover_docs.py`
- full: `python -m pytest -q`. Baseline 191, kỳ vọng 191 cộng số case
  mới, 0 fail.
- `ruff check .`
- `python -m py_compile pipelines/guardrail.py`
- Gate thêm, chạy riêng và log lại: câu "Dạ An Sâm có thể thay thế
  thuốc chữa bệnh mất ngủ." → `ok=False`; câu khuyến cáo chuẩn → `ok=True`.

Gate nặng có thể bị đẩy nền: đọc output tới khi process exit, không
chạy chồng pytest. Evidence `evidence/v30_*.log` phải `git add -f`.
Không commit/push; coordinator commit.

v2.3-handover-docs đóng 2026-10-11 (cold-check **coordinator
self-review** — quota subagent cạn rate-limit sau khi agent build
xong, precedent v0.3/v0.5; coordinator đọc thật 8 file docs + chạy
lại 191/191 + ruff + đối chiếu từng claim: 12/12 câu Phụ lục D khớp
questions.md, 12/12 tên test guardrail khớp, eval exit-condition +
sources-check đúng, 9 bảng + 7 tab + lệnh SOP đúng code, không
secret; 1 MINOR vá ngay `sop.md` default-model thiếu prefix
`openai/`). Audit bù gộp vào `/cold-audit` khi quota về (range
`1553e81..HEAD` giờ cover v2.0+v2.1+v2.3; v2.2 đã audit lạ).

v2.2-content-pipeline đóng 2026-10-11 (cold-check auditor lạ —
profile reviewer quota cạn nên spawn `subagent_general` read-only
làm auditor — đợt 1 FIX: 1 MAJOR `schedule()` crash ValueError
format-spec `%Y-%m-%d` trên `day` str quá-khứ (CLI luôn truyền str,
test chỉ cover date-object) + 2 MINOR (CLI nuốt câm op khi nhiều
flag cùng lúc; Studio "Lưu vào hàng duyệt" không pop session →
re-click nhân đôi draft) — vá `d1237db` → đợt 2 PASS, không finding.
NIT → someday bên dưới).

v2.1-garden-log đóng 2026-10-11 (cold-check **coordinator
self-review** — subagent quota cạn, precedent v0.3/v0.5; coordinator
tự chạy lại 159/159 + ruff + CLI live/dead-DB + Playwright UI khớp
evidence; UI E2E bắt bug thật "transaction()-là-savepoint-khi-conn-
đã-trong-tx" → INSERT rollback ngầm, vá `conn.commit()` trước khi
đóng; NIT → someday). Audit bù: session `/cold-audit` range
`1553e81..HEAD` khi quota subagent về (cover v2.0+v2.1 self-review).

v2.0-report-agent đóng 2026-10-10 (cold-check **coordinator
self-review** — reviewer subagent quota-exhausted, precedent
v0.3/v0.5; coordinator tự chạy lại 147/147 + ruff + probe live/
dead-DB khớp evidence; 4 NIT → someday).

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

## Checklist v2.4-polish

Khán giả: hệ thống đang chạy — patch nhỏ vá 5 someday còn treo sau
khi mọi deliverable SOW build-được (contract coordinator tự chọn qua
/cycle 7/10; candidate rà sẵn từ handoff). Quy ước precedent patch:
`guardrail.py`/`api/rag.py`/`connectors/zalo.py` KHÔNG đụng; skip
eval_qa + zalo_mock; không thêm/sửa bảng; không global mutable mới.

- [ ] **V9.1 `convlog_stats` answered strict** — `is True` thay
  truthiness (NIT cold-check v1.9): entry convlog ngoại lai
  `answered:"false"` không còn đếm như đã trả lời.
  - Boundary: `ingest/lead_store.py`, `tests/test_lead_store.py`
  - Gate: test — `"false"`/thiếu-key không đếm, `True` đếm
- [ ] **V9.2 `intent_of` chống FP (MINOR v1.9)** — price: scrub cụm
  `đánh giá|định giá|giá trị` trước khi match key `giá` (chỉ xóa span
  cụm, không veto — "đánh giá tốt, giá bao nhiêu" vẫn price);
  contact: `ở đâu` info-veto khi đứng sau từ ngữ sinh học
  (`mọc|trồng|phân bố|sinh sống` trong cùng cụm) — "sâm mọc ở đâu"
  là câu thông tin, không phải hỏi địa chỉ. Giữ recall: "mua ở đâu"
  → order (first-match), "showroom ở đâu" → contact qua key khác.
  - Boundary: `ingest/lead_store.py`, `tests/test_lead_store.py`
  - Gate: test — FP case → None + recall case giữ intent đúng
- [ ] **V9.3 `store._get` phân biệt conn-chết vs không-tìm-thấy** —
  `_get` KHÔNG nuốt `psycopg.Error` (propagate); `set_status`/
  `schedule` bắt → warn "lỗi DB khi đọc draft" thay "không tìm
  thấy" (NIT v2.2 — trước báo ảo "không tìm thấy" khi conn chết
  giữa chừng). Flip test Dead-conn đang đánh dấu intentional.
  - Boundary: `pipelines/store.py`, `tests/test_store.py`
  - Gate: test — Dead-conn → warn "lỗi DB"; rows=[] → "không tìm thấy"
- [ ] **V9.4 Guardrail dict thiếu `"ok"`** — `_render_guardrail`
  dùng `.get` + nhánh "kết quả không đầy đủ" thay KeyError trên
  draft ngoại lai; `_fmt_guardrail` thiếu `ok` → "KHÔNG RÕ" thay
  "VI PHẠM" (ok=False violations thật vẫn "VI PHẠM").
  - Boundary: `app/streamlit_app.py`, `pipelines/store.py`,
    `tests/test_store.py`
  - Gate: test `_fmt_guardrail` 4 nhánh; UI verify code-read +
    py_compile (thay đổi phòng thủ, không đổi visual)
- [ ] **V9.5 `_rconn`/`_gconn` close trên nhánh error/rerun** — tab
  Duyệt&Lịch: conn đóng trước mỗi `st.rerun()` (2 chỗ) + đóng conn
  lỗi trong `except _pg.Error` (leak mỗi lần đọc DB fail / click
  duyệt/xếp-lịch). Vá cùng cụm ở tab Nhật ký vườn (`_gconn`
  except — cùng pattern, luật vá-theo-cụm).
  - Boundary: `app/streamlit_app.py`
  - Gate: py_compile + pytest full xanh (UI path verify code-read)

Gate chung: `python -m pytest -q` full + `ruff check .` +
`py_compile app/streamlit_app.py`. Evidence: `evidence/v24_pytest.log`.

## Checklist v2.3-handover-docs

Khán giả: bàn giao cho công ty Sâm Sâm + buổi đàm phán SOW — WS4 "Bộ
tài liệu bàn giao: SOP, tài khoản, kiến trúc hệ thống, prompt library"
+ "giáo trình tiếng Việt theo vai trò (MKT/sales-admin/vườn), tối
thiểu 4 workshop + playbook từng vai trò" + Phụ lục D "bộ câu hỏi/
test-set nghiệm thu chatbot & guardrail". Đây là deliverable SOW lớn
cuối cùng chưa build (WS1 ✓ v1.8, WS2 ✓ v1.9+v2.2, WS3 ✓ v2.0+v2.1;
trợ lý tri thức nội bộ đã đánh giá trùng RAG + thiếu data nội bộ →
external-dep). Cắt lát: docs THẬT mô tả hệ thống ĐANG CHẠY (không viết
lý tưởng) — mọi lệnh/SOP phải khớp AGENTS.md + code hiện có, mọi claim
về tính năng phải grep được trong repo. KHÔNG code mới trừ test drift-
guard; tài khoản trong SOP mô tả VAI TRÒ + chỗ đặt trong `.env`, không
ghi giá trị thật (invariant: secret không vào git).

Quy ước: tiếng Việt, mỗi doc mở đầu bằng 1 đoạn "dành cho ai / làm
việc gì / cần gì". Nguồn sự thật prompt: `pipelines/content.py`
(system prompt + CHANNEL_HINT) và `api/rag.py` — prompt-library TRÍCH
đúng, ghi file:line gốc. Phụ lục D build từ `tests/questions.md` (12
câu có sẵn, Q11/Q12 bẫy) + case guardrail trong `tests/` — mỗi mục
ghi: id, câu/nhập, kỳ vọng, cách chạy (tự động qua eval_qa / tay).
WS4 còn lại là external-dep: workshop THẬT + "2 tuần tự vận hành" là
sự kiện với công ty — doc chỉ chuẩn bị giáo trình/outline.

- [x] **W6.1 Playbook 3 vai trò + 4 workshop outline** —
  `docs/handover/playbook-{mkt,sales-admin,vuon}.md`: vai trò đó dùng
  tab/CLI nào (MKT: Content Studio + Duyệt & Lịch + Báo cáo; sales-
  admin: Chat/Leads/Chưa trả lời; vườn: Nhật ký vườn + --check), quy
  trình ngày mẫu, khi nào gọi người khác. `docs/handover/workshops.md`:
  4 buổi (W1 KB+chatbot, W2 content+guardrail+duyệt, W3 leads+báo cáo,
  W4 vận hành+tự-chữa-lỗi) mỗi buổi mục tiêu/agenda/bài tập vận hành
  thật trên app.
  - Boundary: `docs/handover/`
  - Gate: 4 file tồn tại; mọi tab/lệnh nhắc tới tồn tại thật trong
    repo (tab name khớp streamlit_app.py, lệnh khớp AGENTS.md)
  - Evidence: `evidence/v23_docs.log`
- [x] **W6.2 SOP + kiến trúc + prompt library** —
  `docs/handover/sop.md` (vận hành hàng ngày: chạy app, crawl lại,
  ingest, harvest leads, sinh báo cáo, backup DB, xử lý DB-down/
  token-hết — mọi lệnh phải đúng như chạy thật); `docs/handover/
  kien-truc.md` (sơ đồ luồng crawl→ingest→RAG→chat + connector Zalo +
  bảng DB 9 bảng + agents + human-gate điểm nào); `docs/handover/
  prompt-library.md` (system prompt content.py + rag.py trích nguyên
  văn kèm file:line, brand-voice notes, template brief mẫu 3 loại).
  - Boundary: `docs/handover/`
  - Gate: lệnh trong sop.md đều chạy được/có trong repo (spot-check ≥5);
    kien-truc.md liệt kê đúng 9 bảng + 6 tab; prompt trích đúng source
  - Evidence: `evidence/v23_docs.log`
- [x] **W6.3 Phụ lục D — test-set nghiệm thu** — `docs/handover/
  phu-luc-d.md`: bảng test chatbot (đủ 12 câu questions.md, đánh dấu
  Q11/Q12 bẫy + kỳ vọng NO_DATA/guardrail) + bảng test guardrail
  (banned word, claim ngoài whitelist, claim đúng whitelist pass —
  trích case từ tests/) + hướng dẫn chạy (`python scripts/eval_qa.py`
  ≥10/12) + tiêu chí đạt.
  - Boundary: `docs/handover/`
  - Gate: đủ 12 câu khớp questions.md (grep id), case guardrail khớp
    tên test thật trong tests/test_guardrail.py
  - Evidence: `evidence/v23_docs.log`
- [x] **W6.4 Drift-guard test + gate chung** — `tests/test_handover_
  docs.py`: 7 file tồn tại + non-empty; mỗi playbook chứa đúng tab
  name thật (đọc streamlit_app.py lấy st.tabs list); phu-luc-d chứa
  đủ 12 id câu hỏi parse từ tests/questions.md; sop.md chứa các lệnh
  cốt (`streamlit run`, `apply_schema`, `lead_store`, `agents.report`,
  `agents.garden`, `pipelines.store`); kien-truc đếm đúng "9" bảng
  hoặc list đủ tên 9 bảng. `python -m pytest -q` full + `ruff check .`.
  - Boundary: `tests/test_handover_docs.py`
  - Gate: targeted xanh ×3; full suite xanh; ruff clean
  - Evidence: `evidence/v23_pytest.log`

External-dependency (không treo version): workshop thật + nghiệm thu
"2 tuần tự vận hành" + giáo trình giảng = sự kiện với công ty (T5-T6
timeline); tài khoản/khóa thật chờ Phụ lục C. Someday: video hướng
dẫn, bản EN, giáo trình slides.

## Checklist v2.2-content-pipeline

Khán giả: buổi đàm phán SOW / demo cho bác Lực — "nhân viên MKT nhập
brief → AI sinh bài cho nhiều kênh → guardrail TPBVSK kiểm → NGƯỜI
duyệt từng bài trong hàng chờ → bài đã duyệt xếp vào lịch đăng; hệ
thống KHÔNG tự đăng gì" (SOW §WS2: "brief → AI draft → kiểm tra
compliance → duyệt người → format đa kênh (Facebook, TikTok script,
blog, Zalo OA) → lịch đăng"; risk table: "vi phạm QC TPBVSK → guardrail
claim-whitelist + duyệt người" — 2 lớp). Đây là deliverable WS2 lớn
nhất còn lại (v1.9 chỉ cover leads/dashboard). Cắt lát vừa 1 cycle:
queue duyệt + lịch đăng là bảng `content_drafts` + module store; KHÔNG
có auto-post/scheduler nền/API kênh (creds Phụ lục C chưa có — lịch là
kế hoạch cho người đăng tay). Cụm bị loại: trợ lý tri thức nội bộ
(đánh giá xong — chatbot RAG tab Chat đã trả lời kèm nguồn trên KB
public, đúng contract "tra cứu kèm nguồn"; phần "nội bộ" cần SOP/hồ
sơ công ty = data chưa bàn giao §5.2 → external-dep, build thêm chỉ
trùng RAG); WS4 docs/test-set (để cuối khi tính năng ổn — còn v2.3+).

Quy ước precedent: `guardrail.py`/`api/rag.py`/`connectors/zalo.py`
KHÔNG đụng (lịch đăng = bản ghi kế hoạch, không có code gọi API đăng
— C2.4); skip eval_qa + zalo_mock; không global mutable mới trong
zalo.py; schema chỉ `create table if not exists` (→ 9 bảng public);
mọi connect `connect_timeout=3` qua `ingest.lead_store.connect`;
nhánh DB-down verify bằng host chết thật. `content_drafts` KHÔNG
delete-by-source (draft là tài sản người tạo — update status theo id,
không xóa). Status one-way `pending → approved|rejected`; **approve
chỉ khi `guardrail->>'ok' = true`** — bài vi phạm phải reject/regen,
không có override (double-gate SOW; quyết định coordinator, flag nếu
bác Lực muốn duyệt-kèm-ghi-nhận). `schedule` chỉ trên approved.
Draft do NGƯỜI duyệt — hệ thống không tự chuyển status/tự đăng.

- [x] **W5.1 Schema `content_drafts` + apply** — `docs/schema.sql`
  +1 bảng: id identity, `created_at`, `brief`, `channel`
  (facebook|tiktok|blog|zalo), `text`, `guardrail jsonb` (ok +
  violations + matched_claims — snapshot lúc sinh), `status` default
  'pending', `reviewer`, `reviewed_at`, `review_note`,
  `scheduled_date date`, `source` ('manual:studio'|'cli').
  `python scripts/apply_schema.py` → 9 bảng public ×2 idempotent.
  - Boundary: `docs/schema.sql`
  - Gate: apply ×2; `information_schema` đủ 9 bảng public
  - Evidence: `evidence/v22_schema.log`
- [x] **W5.2 Module `pipelines/store.py` + CLI** — `save_draft(conn,
  brief, channel, text, guardrail)` → id; `list_drafts(conn,
  status=None, limit=50)`; `set_status(conn, id, status, reviewer,
  note)` → (ok, warn) — reject sai-id/non-pending/approve-khi-
  guardrail-không-ok → warn không raise; `schedule(conn, id, date)`
  → (ok, warn) — chỉ approved, date không quá khứ; `calendar(conn,
  days=14)` → approved có scheduled_date trong [today, today+days]
  + mục "đã duyệt chưa xếp lịch". CLI `python -m pipelines.store`:
  `--pending` / `--approve ID --by N [--note]` / `--reject ID --by N`
  / `--schedule ID YYYY-MM-DD` / `--calendar [--days N]`; DB down:
  đọc → "chưa nạp" exit 0 (report precedent), ghi → exit 2 (garden
  precedent); UTF-8 guard.
  - Boundary: `pipelines/store.py`
  - Gate: unit tests W5.5 xanh; CLI smoke: save→pending→approve→
    schedule→calendar hiện đúng; approve bài guardrail-fail → warn
    exit≠0
  - Evidence: `evidence/v22_store.log`
- [x] **W5.3 `content.py` kênh TikTok + `draft_multi`** —
  CHANNEL_HINT += `tiktok` (kịch bản video ngắn: hook 3s + 2-3 cảnh
  + lời thoại/overlay + CTA — đúng "TikTok script" SOW); `draft_multi
  (brief, channels)` → `{channel: result}` — mỗi kênh qua draft()
  riêng (guardrail độc lập), kênh lạ → fallback facebook hint như
  draft() hiện. `draft()` contract giữ nguyên (caller cũ không đổi).
  - Boundary: `pipelines/content.py`, `tests/` (thêm)
  - Gate: test mock client — draft_multi 4 kênh trả đủ key, mỗi
    result có text+guardrail; prompt tiktok chứa hint kịch bản
  - Evidence: `evidence/v22_draft.log`
- [x] **W5.4 UI Studio lưu hàng duyệt + tab "Duyệt & Lịch đăng"
  (thứ 7)** — Studio: multiselect kênh (thay selectbox đơn, mặc định
  facebook) → draft_multi khi >1 kênh; nút "Lưu vào hàng duyệt" →
  save_draft từng kênh. Tab 7: queue pending (expander/draft: kênh,
  brief, text, guardrail result, form duyệt — tên người duyệt + note
  + nút Duyệt (disabled khi violations) / Từ chối); lịch đăng:
  date_input + nút "Xếp lịch" trên approved-chưa-lịch + bảng calendar
  14 ngày. Caption human-gate "hệ thống KHÔNG tự đăng". DB down →
  `st.info` không crash tab.
  - Boundary: `app/streamlit_app.py`
  - Gate: Playwright qua `.venv` — live DB: lưu draft → hiện pending
    → duyệt → xếp lịch → calendar hiện; draft giả guardrail-fail
    không duyệt được; DB-unavailable → tab render + info, không hang;
    console errors=0
  - Evidence: `evidence/v22_streamlit.log`, `evidence/v22_queue.png`
- [x] **W5.5 Tests + gate chung** — `tests/test_store.py`: save/
  list/set_status transitions (pending→approved, pending→rejected,
  sai-id, non-pending, approve-guardrail-fail), schedule (chỉ
  approved, quá khứ reject), calendar shape + edge; schema drift
  guard (schema.sql chứa `content_drafts`). `test_content.py` (mới
  hoặc thêm): draft_multi keys + tiktok hint. `python -m pytest -q`
  full + `ruff check .` + `git diff --check`.
  - Boundary: `tests/test_store.py`, `tests/test_content.py`
  - Gate: targeted xanh ×3; full suite xanh; ruff clean; diff sạch
  - Evidence: `evidence/v22_pytest.log`

External-dependency (không treo version): đăng thật FB/TikTok/Zalo OA
chờ creds Phụ lục C — và KHÔNG nằm trong hệ thống (C2.4: đăng là bước
NGƯỜI sau khi xem lịch). Scheduler nhắc lịch chủ động = someday (hiện
xem khi mở tab/`--calendar`). Template Canva/CapCut + prompt library
phần còn của WS2 = someday/WS4. Someday: duyệt-kèm-ghi-nhận khi
guardrail flag (nếu bác Lực yêu cầu); sửa text draft sau duyệt (hiện
approve đóng băng — regenerate thay vì sửa); metrics bài đã đăng.
NIT cold-check v2.2 (không chặn): `_get` nuốt `psycopg.Error` → báo
"không tìm thấy" khi conn chết giữa chừng (test đánh dấu intentional);
`_rconn` tab 7 không close trên nhánh `st.rerun()`/`_pg.Error`;
`_render_guardrail` index `g["ok"]` trực tiếp — draft ngoại lai thiếu
key → KeyError; "today" theo UTC lệch biên ±1 ngày với TZ VN;
`_drafts`/`last_brief` session-state không clear hẳn khi tất cả kênh
lưu xong (unreachable, chỉ stale).

## Checklist v2.1-garden-log

Khán giả: buổi đàm phán SOW / demo cho bác Lực — "nhân viên vườn mở
tab, chọn khoảnh, ghi hoạt động (tưới/bón/làm cỏ/kiểm tra sâu bệnh...)
→ hệ thống chuẩn hóa + báo ngay nếu nhật ký có dấu hiệu bất thường,
và nhắc khoảnh nào lâu chưa có nhật ký" (SOW §WS3: "ghi nhật ký vùng
trồng qua form/chat → chuẩn hóa → cảnh báo bất thường"). Agent thứ 2
của WS3 — feed thẳng vào report agent v2.0 (mục 4 Vùng trồng đã đọc
`plot_logs` + flag cùng `FLAG_KEYS`). Chọn cụm này: coherent vừa đủ
cho coordinator-inline (quota subagent cạn — tự build + self-review
theo precedent v0.3/v0.5), bảng `plots`/`plot_logs` + sample data có
sẵn từ v1.8, không external dep. Cụm bị loại: WS2 content pipeline
(lớn — format đa kênh + lịch đăng, để cycle sau khi có session
subagent trở lại); trợ lý tri thức nội bộ (trùng RAG đã có); WS4
docs (để cuối khi tính năng ổn).

Quy ước precedent: `guardrail.py`/`api/rag.py`/`connectors/zalo.py`
KHÔNG đụng; skip eval_qa + zalo_mock; không global mutable mới trong
zalo.py; KHÔNG thêm/sửa bảng (intake ghi `plot_logs` có sẵn, FK
`plot_id → plots`). Không LLM → output không cần guardrail check
(invariant chỉ áp text AI sinh; message anomaly là template viết tay).
Tái dùng `ingest.lead_store.connect` (connect_timeout=3) + tái dùng
`agents.report.FLAG_KEYS` (import — KHÔNG duplicate keyword list giữa
2 agent). Ghi DB thật: `source='manual:garden'` (khớp someday v1.8 —
row manual KHÔNG bị loader delete-by-source đè; nhưng nhớ someday (a):
manual plot_logs chết theo CASCADE nếu plots reload delete+insert —
pilot chấp nhận, khi có khoảnh thật thì plots cũng nhập tay). Mọi
connect `connect_timeout=3`; nhánh DB-unavailable verify bằng host
chết thật. Nhật ký là thao tác NGƯỜI ghi tay — hệ thống KHÔNG tự
sinh/tự sửa nhật ký (human-gate đối xứng C2.4).

- [x] **W4.1 Module `agents/garden.py`** — `ACTIVITY_VOCAB` (trồng,
  tưới, bón, làm cỏ, kiểm tra sâu bệnh, phun thuốc sinh học, thu
  hoạch, ghi nhận, khác) + alias map; `normalize_activity(raw)` →
  (activity, known: bool) — raw rỗng → `("ghi nhận", False)`;
  `add_log(conn, plot_id, ts, activity, detail, author)` → INSERT
  `source='manual:garden'`, trả (id|None, warnings[]) — FK
  `ForeignKeyViolation` → warn "khoảnh không tồn tại" (KHÔNG raise);
  unique `(plot_id,ts,activity)` `UniqueViolation` → warn "đã có
  nhật ký trùng"; `flags_for(activity, detail)` → keyword hits từ
  `report.FLAG_KEYS`; `anomaly_check(conn, gap_days=14)` →
  [{'type','plot','ts','msg'}]: active-plot không có log nào →
  'no-logs'; `max(ts)` cũ hơn gap → 'gap'; log trong kỳ gap có
  keyword → 'keyword'; `active_plots(conn)`, `recent_logs(conn,
  limit=20)`. `psycopg.Error` tại tầng collect → propagate lên caller
  (CLI/UI quyết degrade) — KHÔNG nuốt.
  - Boundary: `agents/garden.py`
  - Gate: unit tests W4.4 xanh
  - Evidence: `evidence/v21_garden.log`
- [x] **W4.2 CLI `python -m agents.garden`** — `--plot P --activity A
  [--detail D --ts ISO --author]` → add_log in kết quả + flags;
  `--check [--gap-days N]` → in anomaly list; thiếu --plot/--activity
  khi add → usage error exit 2; DB down: add → exit 2 báo lỗi;
  check → in "chưa nạp" exit 0 (precedent data_audit); UTF-8 guard.
  - Boundary: `agents/garden.py`
  - Gate: add thật vào DB (plot KV-A01) → row hiện trong
    `recent_logs` + `psql`/SELECT verify; add plot sai → warn
    friendly exit≠0; add trùng → warn "đã có"; `--check` in anomaly
    (ít nhất 1 'gap' vì KV-B01 sample cũ)
  - Evidence: `evidence/v21_garden.log`
- [x] **W4.3 Tab "Nhật ký vườn" (thứ 6) streamlit** — caption human-
  ops; `active_plots` → selectbox khoảnh (id + location); selectbox
  activity vocab + "khác..." → text_input tự ghi; date_input mặc định
  hôm nay; detail + author; submit → `add_log` → success + warning
  vàng nếu `flags_for`/`warnings` có; panel "Cần chú ý" =
  `anomaly_check` (warning boxes); bảng `recent_logs` (ts/plot/
  activity/detail/author); DB down → `st.info` không crash tab.
  - Boundary: `app/streamlit_app.py`
  - Gate: Playwright qua `.venv` (có sẵn) — live DB: tab render,
    submit 1 nhật ký → row xuất hiện trong bảng + anomaly panel hiện;
    DB-unavailable (spawn env DATABASE_URL host chết) → tab render +
    info, không hang; console errors=0
  - Evidence: `evidence/v21_streamlit.log`, `evidence/v21_garden_tab.png`
- [x] **W4.4 Tests + gate chung** — `tests/test_garden.py`: normalize
  (vocab hit/alias/khác/rỗng); `add_log` fake-conn happy + bắt
  `ForeignKeyViolation`/`UniqueViolation` → warnings không raise;
  `flags_for` keyword trong activity vs detail; `anomaly_check` đủ
  nhánh (no-logs/gap/fresh/keyword) qua fake-conn dispatch; `recent_
  logs`/`active_plots` shape. `python -m pytest -q` full + `ruff
  check .` + `git diff --check`.
  - Boundary: `tests/test_garden.py`
  - Gate: targeted xanh ×3; full suite xanh; ruff clean; diff sạch
  - Evidence: `evidence/v21_pytest.log`

External-dependency (không treo version): khoảnh + nhật ký THẬT chờ
bàn giao (SOW §5.2) — form hoạt động trên sample plots KV-*; khi có
vườn thật, thêm khoảnh qua `plots` (manual hoặc loader). Chat-intake
("nhắn Zalo ghi nhật ký") chưa làm — form-first, chat-parse để
someday. Manual `plot_logs` sống sót reload chỉ khi plots cha là
manual (someday v1.8 a). Lịch nhắc định kỳ (agent chủ động báo khi
gap) = someday — hiện check chạy khi người mở tab/`--check`.

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

- [x] **W3.1 Module `agents/report.py`** — package mới `agents/`
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
- [x] **W3.2 CLI `python -m agents.report` + gitignore** — argparse
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
- [x] **W3.3 Tab "Báo cáo" (thứ 5) trong streamlit** — caption
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
- [x] **W3.4 Tests + gate chung** — `tests/test_report.py`: period
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
- Report agent v2.0 (coordinator self-review NIT): (a) `collect_chat`
  đếm mọi dict hợp lệ làm "tin nhắn" — record thiếu question/user_hash
  (event, sửa tay) vẫn tính total/in_period; (b) report trích verbatim
  `question`/`detail` — không qua guardrail (data thô, vd "thuốc sinh
  học" hợp lệ ở ngữ cảnh vườn) — human-gate banner cover, nhưng nếu tái
  dùng text report ra public phải qua `check()`; (c) `by_channel*`
  hardcode zalo/streamlit — mở rộng `channel_of` thêm kênh sẽ KeyError,
  vá bằng defaultdict khi đó; (d) `report_name` edge 00:00 UTC + tab
  `read_text` race nếu file bị xoá giữa list↔read.
- Garden agent v2.1 (coordinator self-review NIT): (a) `flags_for`
  match literal KHÔNG fold dấu — detail viết không dấu ("rep") lọt
  flag (activity fold qua alias nên đã bắt); giống semantics
  `report.FLAG_KEYS` hiện có → nhất quán, vá thì fold cả hai cùng lúc;
  (b) UI chọn "khác…" bỏ trống free-text → ghi activity literal
  "khác…" (vẫn có warn vocab) — nên block; (c) `add_log` khi insert
  fail (FK/unique) trả chỉ message lỗi — vocab/flag warns tích lũy bị
  thay thế (nhỏ — resubmit sau khi sửa input sẽ thấy); (d) anomaly
  msg/`[warn]` in verbatim activity người nhập, không bound độ dài;
  (e) chat-intake ("nhắn Zalo ghi nhật ký") + nhắc định kỳ khi gap —
  đã ghi trong external-dep contract, form-first.
- WS2: ~~leads table + gom lead từ convlog; dashboard số liệu kênh~~
  (xong v1.9 — chỉ cover leads + convlog metrics, chưa phải social
  metrics); pipeline nội dung brief→draft→compliance→DUYỆT NGƯỜI→
  format đa kênh (FB/TikTok script/blog/Zalo OA)→lịch đăng — KHÔNG
  tự đăng (C2.4)
- WS3: ~~agent báo cáo định kỳ ra file (không tự gửi)~~ — xong v2.0
  (markdown `data/reports/`; lịch chạy định kỳ = Task Scheduler/cron
  someday, LLM commentary someday); ~~agent nhật ký vùng trồng
  form→chuẩn hóa→cảnh báo~~ — xong v2.1 (form tab + CLI; chat-intake
  + nhắc định kỳ = someday trong contract); trợ lý tri thức nội bộ
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
| v1.9-leads | WS2 nền SOW: bảng `leads` (dedup_key unique, insert-only — không delete-by-source vì convlog rotate/purge) + `ingest/lead_store` harvest convlog+`.1` (intent partner/order/price/contact, channel suy từ `msg_id`) + tab Leads Streamlit read-only (convlog stats luôn hiện, DB-lỗi → st.info, `connect_timeout=3`) | 2026-10-10 | `evidence/v19_schema.log` (8 bảng public ×2) · `v19_leads.log` (harvest thật ×2 dup-30; rollback-only temp-table probe chứng minh 30-new→30-dup, public 30→30) · `v19_streamlit.log` + `v19_dashboard.png` (live + DB-unavailable, console 0 lỗi) · `v19_pytest.log` (131/131, focused 13/13 ×3, ruff clean); commits `c3387a0` (contract) + `af8d314` (code/tests/evidence/board) + commit đóng. Cold-check auditor lạ: **PASS** đợt 1 (tự chạy 131/131 + ruff + harvest → 30 rows) — 2 MINOR (intent substring FP, 30 leads là mock/replay phải nhãn "dữ liệu mẫu" khi demo) + 1 NIT (`answered` truthiness) → someday. Worker chết rate-limit giữa lane → resume/absorb; DB-fallback hang → `connect_timeout=3`; UI verify qua temp venv + Python Playwright (MCP root trỏ workspace khác) |
| v2.0-report-agent | WS3 đầu tiên: agent báo cáo định kỳ → FILE markdown `data/reports/` (package `agents/` mới; consume orders/leads/plot_logs/plots/products + convlog file-based; degraded khi DB chết; nhãn *(mẫu)* cho `source 'sample:*'`; `answered` strict `is True`; BẢN NHÁP human-gate, KHÔNG tự gửi) + tab Streamlit thứ 5 "Báo cáo" | 2026-10-10 | `evidence/v20_report.log` (CLI ×2 idempotent + `--until/--days` + dead-host `10.255.255.1` → degraded exit 0) · `v20_report.md` (report mẫu thật) · `v20_streamlit.log` + `v20_report_tab.png`/`v20_report_dead.png` (live + DB-unavailable, console 0 lỗi, warning DEGRADED) · `v20_pytest.log` (147/147, focused 16/16 ×3, ruff clean); commits `1553e81` (contract) + `6cb3da8` (impl) + `fb2f93b` (board) + commit đóng. Cold-check: reviewer subagent quota-exhausted → **PASS coordinator self-review** (precedent v0.3/v0.5 — tự chạy lại 147/147 84s + ruff + CLI live/dead-DB khớp evidence); 4 NIT → someday (collect_chat đếm record thiếu-field, verbatim data không qua guardrail, `by_channel*` hardcode 2 kênh, report_name edge-00:00 + read_text race) |
| v2.1-garden-log | WS3 thứ 2: agent nhật ký vùng trồng — `agents/garden.py` (vocab+alias fold bỏ dấu, `add_log` insert `source='manual:garden'` FK/unique → warn friendly không raise, `anomaly_check` no-logs/gap/keyword dùng `report.FLAG_KEYS`) + CLI `add`/`--check` + tab Streamlit thứ 6 "Nhật ký vườn" (form + panel Cần chú ý + bảng recent; DB-down → st.info) — feed report v2.0 qua `plot_logs`, KHÔNG tự gửi | 2026-10-11 | `evidence/v21_garden.log` (CLI: add KV-A01→#25, plot-sai/trùng/thiếu-arg → exit 2 warn, dead-host → check exit 0/add exit 2) · `v21_streamlit.log` + `v21_garden_tab.png`/`v21_garden_submit.png`/`v21_garden_dead.png` (live submit → row verify qua DB; dead-DB info, console 0 lỗi) · `v21_pytest.log` (159/159, focused 12/12 ×3, ruff clean); commits `15dd559` (contract) + impl + commit đóng. Cold-check: **PASS coordinator self-review** đợt 1 — subagent quota cạn (precedent v0.3/v0.5); UI E2E bắt bug thật "savepoint-khi-conn-đã-trong-tx" → `conn.commit()` vá trước đóng; NIT → someday (flags_for không fold, "khác…" trống, warns-drop-khi-fail, activity không bound, chat-intake/nhắc-định-kỳ deferred). Audit bù `/cold-audit` range `1553e81..HEAD` khi quota về |
