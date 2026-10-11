# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **v2.4-polish** (loop /cycle 10, cycle 7/10)

Nhánh `ai-infra` (M30): v3.3, v3.5, v3.7, v3.8 đã đóng và đã gộp;
đang chạy song song: v3.4, v3.6, v3.9.

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
