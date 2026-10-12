# SOP — Vận hành hàng ngày hệ thống Sâm Sâm AI

**Dành cho ai:** AI champion / người vận hành hệ thống tại công ty.
**Làm việc gì:** bật/tắt app, cập nhật knowledge base, gom leads, sinh
báo cáo, backup, và xử lý các sự cố thường gặp (DB chết, hết quota
OpenRouter, token Zalo).
**Cần gì:** máy Windows đã cài Python 3.12 + PostgreSQL local đang chạy,
repo `D:\code\samsam`, file `.env` ở root repo đã điền các biến (xem mục
"Tài khoản & bí mật" cuối doc). Mọi lệnh chạy từ root repo trừ khi ghi
khác.

> **Human-gate (invariant C2.4):** hệ thống KHÔNG tự đăng bài, KHÔNG tự
> gửi báo cáo/tin nhắn chủ động, KHÔNG tự ghi nhật ký. Duyệt bài, đăng
> kênh, gửi lãnh đạo, ghi nhật ký vườn đều là thao tác NGƯỜI. Connector
> Zalo chỉ *trả lời* tin nhắn đến — không đăng nội dung mới.

## 1. Chu trình ngày (15–20 phút)

| # | Việc | Lệnh / chỗ thao tác |
|---|---|---|
| 1 | Mở app demo | `streamlit run app/streamlit_app.py` (hoặc `python demo.py`) → trình duyệt vào địa chỉ streamlit in ra (mặc định :8501) |
| 2 | Rà câu bot không trả lời được | Tab **Chưa trả lời** → giao sales-admin follow-up |
| 3 | Gom lead mới từ convlog | `python -m ingest.lead_store` → đọc `[done] mới=.. trùng=..` |
| 4 | Rà dashboard | Tab **Leads** (metric + bảng leads) |
| 5 | Rà hàng duyệt nội dung | Tab **Duyệt & Lịch** hoặc `python -m pipelines.store --pending` |
| 6 | Rà bất thường vườn | Tab **Nhật ký vườn** mục "Cần chú ý" hoặc `python -m agents.garden --check` |

## 2. Chu trình tuần

| Việc | Lệnh / chỗ thao tác |
|---|---|
| Sinh báo cáo kỳ 7 ngày | `python -m agents.report` (mặc định 7 ngày) → file `data/reports/report-<từ>_<đến>.md` — BẢN NHÁP, người duyệt rồi gửi lãnh đạo |
| Báo cáo kỳ khác / ngày chốt cụ thể | `python -m agents.report --days 30` · `--until 2026-10-31` |
| Xem lịch đăng sắp tới | `python -m pipelines.store --calendar` (mặc định 14 ngày; `--days N`) |
| Backup DB + data | xem mục 6 |
| Đối chiếu danh mục dữ liệu | `python scripts/data_audit.py` → cập nhật `docs/phu-luc-a.md` khi data đổi |
| Bản tin vùng trồng (v9.3) | `python -m agents.garden_director --bulletin` → `data/reports/garden-week-<ngày>.md` — BẢN NHÁP cho GĐ vùng trồng |
| Kiểm hash chain nhật ký vườn | `python -m agents.garden_director --verify` (exit 0 = nguyên vẹn; 1 = có dòng bị sửa/xóa — xem mục 7) |

## 3. Cập nhật knowledge base (KB)

Khi có nội dung public mới (bài báo, sản phẩm mới lên site) hoặc công ty
bàn giao tài liệu cần số hóa:

```
python -m crawler.collect        # crawl lại site public → data/*.jsonl
python -m ingest.embed_store     # chunk + embed → bảng chunks (xóa-nạp lại theo doc_id)
python -m ingest.core_store      # nạp DB lõi (products/plots/orders/assets...) — delete-by-source, không đè row nhập tay
```

Ghi chú vận hành:

- `crawler.collect` tôn trọng delay ≥1s/request, chỉ trang public —
  chạy chậm là bình thường.
- `embed_store` tốn quota OpenRouter (embed toàn bộ jsonl) — chạy khi
  thật sự có data mới.
- `core_store` idempotent: row có `source='manual'` / `'manual:garden'`
  không bị xóa-nạp lại đè; row nhập tay an toàn.
- Lần đầu hoặc sau khi `docs/schema.sql` đổi:
  `python scripts/apply_schema.py` → in "N bảng public: ..." (hiện 9).
- **Bổ sung công dụng đã công bố mới:** sửa
  `data/claims_whitelist.json` (thêm claim vào `approved_claims` của
  SKU) → chạy `python -m ingest.core_store` để đồng bộ bảng
  `claims_approved`. Đây là cách duy nhất "mở" claim cho guardrail —
  KHÔNG sửa guardrail để bỏ chặn.

### Số hóa tài liệu công ty (giấy tiếp nhận, nhãn, hợp đồng, hồ sơ vùng trồng)

Bỏ file PDF/ảnh vào `data/intake/<loai>/` (`giay_tiep_nhan`, `nhan`,
`hop_dong_dai_ly`, `ho_so_vung_trong`) rồi chạy:

```
python -m ingest.doc_intake                                  # intake: hash → bản gốc data/originals/<sha256> → trích text/field → bảng documents
python -m ingest.doc_intake --pending                        # Pháp chế xem tài liệu chờ xác nhận + field trích được
python -m ingest.doc_intake --verify <sha256> --by "<tên>"   # Pháp chế xác nhận field đúng (chỉ khi pending_review)
python -m ingest.doc_intake --reject <sha256> --by "<tên>"   # Pháp chế từ chối
```

- Chạy lại intake an toàn: trùng nội dung (sha256) → `dup`, bản gốc
  không bao giờ bị ghi đè; intake không xoá file trong `data/intake/`.
- PDF scan/ảnh ở trạng thái `cho_ocr` — chưa có provider OCR (FPT.AI
  Reader là external-dep); tài liệu có SĐT/email (`pii` trong
  `--pending`) KHÔNG được gửi LLM.
- Field (số giấy, ngày cấp, tên sản phẩm) trích bằng regex, luôn ở
  trạng thái chưa xác minh tới khi người Pháp chế chạy `--verify` —
  KHÔNG ai xác nhận hộ. Đối chiếu field với bản gốc trước khi verify.

### Vùng trồng: hồ sơ khoảnh, gỡ dữ liệu mẫu, kho ảnh (v9.3)

- `plots`/`plot_logs` hiện còn dữ liệu MẪU (`sample:*`). Kiểm trước (chỉ
  đọc, không ghi gì): `python -m agents.garden_director --precheck` → số
  khoảnh/nhật ký mẫu + **blocker** (nhật ký thật hoặc ảnh đang trỏ khoảnh
  mẫu). Xử lý theo loại:
  - **Nhật ký thật** (vd ghi từ tab garden lên khoảnh mẫu KV-*): nhật ký
    đã vào hash chain, KHÔNG sửa/xóa/chuyển khoảnh được (DB chặn cả đổi
    `plot_id`). Đường duy nhất: GĐ vùng trồng ký **nhận khoảnh mẫu thành
    khoảnh thật** — `python -m agents.garden_director --adopt-plot <mã
    khoảnh> --by "<họ tên GĐ vùng trồng>"` (thiếu `--by` → exit 2; ghi
    `agent_action_log` action `garden_plot_adopt`). Sau khi nhận, vị trí/
    diện tích/số cây của khoảnh VẪN là giá trị mẫu — GĐ cập nhật số thật.
  - **Ảnh** (`garden_media`): nhận khoảnh như trên, hoặc người quản trị DB
    chuyển `garden_media.plot_id` sang khoảnh thật (ghi lý do).
- **Gỡ dữ liệu mẫu CHỈ do GĐ vùng trồng ký**, chạy:
  `python -m agents.garden_director --purge-sample --by "<họ tên GĐ vùng
  trồng>"`. Thiếu `--by` → từ chối (exit 2); còn blocker → KHÔNG gỡ (exit
  1); xong → ghi `agent_action_log` action `garden_sample_purge`, và từ đó
  `python -m ingest.core_store` KHÔNG nạp lại mẫu (DB cũng chặn chèn mẫu).
  Agent/lịch tự động KHÔNG bao giờ chạy lệnh này (cả `--adopt-plot`).
  Người vận hành không tự điền tên người khác.
- Kho ảnh vườn: đặt `GARDEN_MEDIA_DIR` (thư mục NGOÀI repo, có backup)
  rồi `python scripts/garden_media.py --file <ảnh> --plot <khoảnh> --date
  YYYY-MM-DD --by "<tên>"` — ảnh lưu đã gỡ EXIF/GPS, metadata bảng
  `garden_media`.
- Nhật ký đã ghi KHÔNG sửa/xóa được (hash chain) — `core_store` giữ lại
  khoảnh mẫu còn nhật ký thật/ảnh (in `[keep] plots: ...`).

## 4. Hàng duyệt nội dung (MKT)

Ưu tiên thao tác trên tab **Duyệt & Lịch**; CLI tương đương:

```
python -m pipelines.store --pending                  # draft chờ duyệt
python -m pipelines.store --approve 12 --by "Lan"    # duyệt (chỉ khi guardrail ok)
python -m pipelines.store --reject 13 --by "Lan" --note "lý do"
python -m pipelines.store --schedule 12 2026-11-05 --by "Lan"   # xếp lịch bài approved
python -m pipelines.store --calendar                 # lịch 14 ngày
python -m pipelines.store --verify-log               # kiểm nhật ký hash chain
```

- Mỗi lệnh chỉ làm **1 thao tác** (cố gắn gộp flag → báo lỗi usage).
- `--by <tên>` bắt buộc khi approve/reject/schedule (audit). Trên UI
  người duyệt = người đăng nhập (không gõ tên).
- **Người duyệt phải KHÁC người tạo draft** (so không phân biệt hoa
  thường) — DB từ chối nếu trùng. Draft cũ (trước v3.4) không có người
  tạo → không duyệt được: từ chối rồi sinh lại.
- Approve draft vi phạm guardrail → bị từ chối kèm cảnh báo (không có
  override); guardrail được chạy LẠI trên text trước khi duyệt. Status
  chỉ đi một chiều `pending → approved|rejected`.
- Xếp lịch chỉ được trên bài `approved`, ngày không quá khứ (giờ VN) và
  text còn khớp bản đã duyệt (sha256 — sửa text sau duyệt thì không xếp
  lịch được). **Lịch là kế hoạch cho người đăng tay.**
- `--verify-log`: exit 0 `[ok] chuỗi nguyên vẹn (N dòng)`; exit 1 in
  `id=.. problem=row_hash|prev_hash` (xem mục 7); exit 2 = DB không
  kết nối được.

## 4b. Hàng duyệt chung & bản tin GĐ khối (v4.0)

Mọi việc cần người duyệt của agent nhân viên (đổi giá, báo giá B2B, chiến
dịch ads, hồ sơ XNQC...) — TRỪ bài content (vẫn mục 4) — vào một hàng
chung `approval_queue`. SLA và mức rủi ro theo cấu hình khối
`data/directors/<khối>.json` (11 khối; danh sách người duyệt thật đang
rỗng — TGĐ chốt, external-dep).

```
python -m pipelines.approval_queue --pending [--block sales]
python -m pipelines.approval_queue --approve <ID> --by "<tên>" [--note "..."]
python -m pipelines.approval_queue --reject <ID> --by "<tên>" [--note "..."]
python -m pipelines.approval_queue --override-qa <ID> --by "<tên>" --reason "<lý do ≥10 ký tự>"
python -m pipelines.approval_queue --expire
python -m pipelines.director --block <khối>        # bản tin GĐ khối → data/reports/director-<khối>-<ngày>.md
python -m pipelines.director --all --dry-run       # chỉ kiểm 11 file cấu hình, không DB
python -m pipelines.red_alert --check-routing      # exit 1 = chưa có người nhận cảnh báo đỏ độc lập
```

- Người tạo KHÔNG tự duyệt được; mục vi phạm guardrail không duyệt được
  (hệ thống kiểm lại nội dung); quá SLA → `expired` — KHÔNG BAO GIỜ tự
  duyệt, việc đó phải đẩy lại từ đầu. Mục QA FAIL muốn trình vẫn phải
  `--override-qa` (người khác người tạo, có lý do) rồi một người khác
  `--approve`. Bản phát hành phải khớp sha256 bản đã duyệt.
- Tự duyệt (`auto_policy`) mặc định TẮT: bảng `auto_policies` rỗng, chỉ áp
  rủi ro `low` + QA pass khi chủ khối đã ký (external-dep).
- Exit: 0 xong · 1 quyết định bị từ chối (đọc thông báo — vd quá hạn,
  người tạo, guardrail) · 2 sai tham số hoặc DB down (xem mục 7).
- Bản tin GĐ khối là BẢN NHÁP — hệ thống không tự gửi; người vận hành
  chuyển tay. Chạy hằng ngày (Task Scheduler/cron) — mỗi lần chạy cũng
  đánh expired mục quá hạn.
- **Cảnh báo đỏ** (`red_alerts`): người kết nối bằng DSN `app_human` (kể
  cả TGĐ và Quản lý hạ tầng AI) không xóa/sửa được; trigger chặn UPDATE/
  DELETE/TRUNCATE khi còn bật. GIỚI HẠN: owner bảng vẫn `DISABLE TRIGGER`,
  superuser vẫn `session_replication_role = replica` rồi xóa được — nên
  khi chuyển DSN theo role, TGĐ và ha_tang KHÔNG được giữ DSN owner/
  superuser; neo ngoài (object-lock) = external-dep. Hôm nay ha_tang còn
  giữ DSN owner → chưa đạt. `--check-routing` exit 1 nghĩa là cảnh báo vẫn được
  ghi nhưng CHƯA có người nhận độc lập: Pháp chế xác nhận người nhận rồi
  dev điền `data/red_alert_routing.json` (chỉ nhận vai trò `phap_che`/
  `bks`; `tgd`/`ha_tang` và vai trò khác bị loại tự động). Hiện hệ thống chỉ ghi bảng, chưa gửi email/Zalo (external-dep).

## 5. Kênh Zalo OA (khi chạy thật)

```
python -m connectors.zalo        # webhook :8788/zalo-webhook
python scripts/zalo_mock.py      # mock E2E không cần Zalo thật
python scripts/zalo_preflight.py # kiểm tra env/token trước go-live
```

Runbook đầy đủ: `docs/deploy.md` (DEPLOY flag, tunnel HTTPS, systemd
unit `docs/zalo-webhook.service`). Tóm tắt sự cố thường gặp:

- **Token Zalo hết hạn:** connector tự refresh; nếu send lỗi kéo dài →
  kiểm `data/zalo_tokens.json` còn nguyên + env `ZALO_APP_ID` /
  `ZALO_APP_SECRET` / `ZALO_REFRESH_TOKEN`. Mất cả file lẫn refresh
  token → lấy token mới trên OA console điền lại `.env` (xem
  `deploy.md` mục "Access token").
- **`DEPLOY` bật mà thiếu `ZALO_OA_SECRET`** → process refuse-to-serve
  (đúng — cố ý, không "vá" bằng cách tắt DEPLOY khi đang public).

## 5b. Nạp file sàn (Shopee/TikTok) — chỉ đọc, đối chiếu golden

**Ai xuất:** Quản lý MXH tải tay từ Seller Center 3 loại file (listing,
đơn hàng, báo cáo quảng cáo) — hằng ngày trong mùa cao điểm. Lưu ở
`data/raw/market/` (đã gitignore — KHÔNG copy file thật vào repo, không
gửi qua chat). Tên cột trong `data/market_csv_map.json` là GIẢ ĐỊNH,
**chưa xác minh với file thật** — file thật đầu tiên rất có thể báo lỗi
schema; khi đó gửi danh sách TÊN CỘT (không gửi dữ liệu) cho kỹ thuật để
cập nhật mapping.

```
python -m ingest.market_csv --file data/raw/market/<file>.csv --channel shopee --kind listing
python -m ingest.market_csv --file data/raw/market/<file>.xlsx --channel shopee --kind ads
python -m ingest.market_csv --file data/raw/market/<file>.csv --channel tiktok --kind order
python -m ingest.market_csv --report
```

- Nạp lại cùng file → `[skip]` (khóa = sha256 file), không nhân đôi.
- File lỗi (thiếu cột / cột lạ / số sai / file rỗng) → `[err]` nêu số
  dòng + tên cột, KHÔNG nạp dòng nào. Cột lạ bị chặn cả file (không lặng
  lẽ bỏ qua) — sửa mapping sau khi xác minh, không sửa tay file xuất.
- Cột tên/SĐT/địa chỉ người mua, ghi chú đơn bị bỏ ngay khi đọc; mã đơn
  chỉ lưu dạng hash. Báo cáo không in mã đơn.
- `--report`: cảnh báo đang mở, **S1 trước S2**:
  - S1 `alcohol_listed` — SKU rượu đang bán trên sàn (cấm kênh online).
  - S1 `tpbvsk_ads_no_xnqc` — TPBVSK chưa có giấy XNQC mà có chi phí ads.
  - S2 `price_mismatch` — giá sàn ≠ giá `list` golden (`golden_approved`
    false = so với giá CHƯA được GĐ bán hàng duyệt).
  - S2 `item_unmapped` — item/SKU sàn không map được golden (item chung
    nhiều biến thể mà thiếu SKU phân loại cũng rơi vào đây).
  - `[warn] <kênh>: không đủ dữ liệu quảng cáo` — có listing nhưng chưa
    nạp file ads, chưa kiểm được TPBVSK chạy quảng cáo.
- **Ai sửa trên sàn:** Quản lý MXH, SAU KHI GĐ bán hàng duyệt (giá) hoặc
  Pháp chế duyệt (tuân thủ). Agent KHÔNG sửa sàn, không đổi giá, không
  ghi golden.
- **Xuất listing TOÀN BỘ sản phẩm** (không lọc danh mục/tab, đủ mọi
  trang, gồm cả sản phẩm đã ẩn); báo cáo quảng cáo gồm cả chiến dịch đã
  tạm dừng. Cảnh báo chỉ tự đóng khi file xuất kế tiếp CÓ dòng của item
  đó và dòng đó hết lỗi (rượu đã ẩn/xóa, giá khớp, chi phí ads = 0). Item
  VẮNG mặt trong file → cảnh báo GIỮ MỞ, CLI in `[warn] N cảnh báo ...
  không thấy item trong file — GIỮ MỞ` (vắng ≠ đã sửa).
- Giới hạn file: ≤ 50MB, ≤ 100.000 dòng (tính cả dòng trống), ≤ 200 cột;
  XLSX có ô định dạng/ô lạc ở xa phía dưới/bên phải (vùng dữ liệu vượt
  trần) bị từ chối — xóa dòng/cột thừa hoặc xuất CSV. Ô số XLSX có phần
  lẻ (vd 12,345) là lỗi, không tự đổi thành số nguyên.

## 5c. Kịch bản mùa + nghiên cứu giả lập (v7.3)

**Kịch bản mùa** (engine chung cho dự báo mùa, phân bổ tồn Tết, dòng tiền
13 tuần — không DB, không LLM):

```
python -m pipelines.scenario --sku saphraton-20v --channel shopee --weeks 13 [--start 2026-10-12] [--json]
```

- Mỗi tuần (thứ Hai) in 3 số **thấp / cơ sở / cao** — đây là KHOẢNG, không
  phải doanh số cam kết; lập kế hoạch theo cả khoảng, không lấy riêng cột
  "cơ sở". Cột "sự kiện" = 11.11, 12.12, `tet_2027` (Tết 06/02/2027 — tuần
  01/02 thấp vì nghỉ Tết, 6 tuần trước Tết cao vì mua quà). 11.11/12.12
  chỉ áp kênh online (ngày sale sàn, khóa `channels` trong file giả định);
  kênh `offline` không nhân hệ số sàn. Tết áp mọi kênh.
- Kênh `offline` = đại lý/cửa hàng. Rượu sâm luôn 0 ở mọi kênh online
  (ghi chú "rượu: chỉ kênh offline"); SKU chưa có kênh trong
  `allowed_channels` golden cũng ra 0 kèm ghi chú.
- Giả định ở `data/scenario_assumptions.json` — dòng đầu output in
  `status` "GIẢ ĐỊNH — chờ GĐ KD/Tài chính chốt". Baseline là số MẪU, chưa
  phải số bán thật. **GĐ KD + Tài chính** chốt hệ số/3 mức rồi mới đổi
  `status`; GĐ bán hàng cấp số bán thật để thay baseline.
- Exit 1 = SKU không có trong golden / file giả định hỏng / thiếu baseline
  cho SKU × kênh (báo lỗi, không bao giờ in 0 câm); exit 2 = sai tham số.

**Nghiên cứu giả lập persona** (persona TỔNG HỢP `data/personas.json`,
không dữ liệu khách thật):

```
python scripts/persona_sim.py --dry-run
```

- **Cổng DPIA:** `data/sim_config.json` `"dpia_signed": false` → chạy
  không cờ in `[refuse] DPIA chưa ký` và **exit 2** (không gọi LLM, không
  ghi DB). Chỉ NGƯỜI thật đổi `dpia_signed` sang `true` sau khi Pháp chế +
  TGĐ ký DPIA/TIA — dev/agent không tự đổi.
- `--dry-run` dùng gateway GIẢ (số giả, nhãn "DRY-RUN — số giả"), ghi
  `sim_runs` với `dry_run=true`. Chạy thật: 3 model × 3 prompt × 5 lần qua
  `llm_gateway` (agent `persona_sim`, trần tháng `monthly_cap_usd`).
- Báo cáo = khoảng p10–p90 + p50 + độ phân tán theo phương án, luôn có
  dòng "**KHÔNG phải dự báo doanh số**" — chỉ dùng để loại bớt phương án
  yếu. Có 1 phương án đối chứng cố tình yếu: nếu nó không thấp nhất ở ≥80%
  lời gọi hợp lệ → cờ `[KHÔNG DÙNG ĐƯỢC]`, không dùng kết quả.
- Đầu vào bị chặn (exit 1, trước khi gọi LLM): persona có key ngoài danh
  sách cho phép (mã đơn, user_hash, SĐT, email...), persona < 18 tuổi,
  MỌI phương án nhắc rượu (guardrail v4.1 chặn rượu — kể cả panel toàn
  người lớn),
  phương án có từ cấm, TPBVSK chưa có XNQC mà làm phương án sản phẩm
  (chỉ được làm chủ đề thương hiệu).
- **Quản lý MXH** duyệt báo cáo; TGĐ/BKS đồng ký biên bản trước khi dùng.

## 5d. Thu tin thị trường (intel — v7.0, chỉ đọc)

**Làm gì:** đọc RSS/Atom của báo chính thống/cơ quan nhà nước (tầng A) và
trang ngành/blog công khai (tầng B) trong `data/intel_sources.json`, lọc
theo chủ đề (sâm, TPBVSK/thực phẩm chức năng, đồ ăn giới trẻ, quảng cáo,
đối thủ) bằng LUẬT, lưu bảng `intel_items`. Không gửi ai, không đăng gì,
không ghi hàng duyệt nội dung.

```
python -m crawler.intel --run --source vnexpress-suc-khoe --source tuoitre-suc-khoe --max-requests 10
python -m crawler.intel --run            # chỉ nguồn status "duyet" (hiện 0)
python -m crawler.intel --report
```

- **Danh sách nguồn là ĐỀ XUẤT**: mọi nguồn `status: "cho_duyet"` tới khi
  BGĐ/Quản lý MXH duyệt (đổi sang `"duyet"` là việc của người thật). Chạy
  THỬ nguồn chưa duyệt bằng `--source <id>` (in `[warn] nguồn chưa duyệt`).
- **Chặn cứng**: tầng C (MXH cá nhân, trang cần đăng nhập) và sàn/MXH
  (Shopee, TikTok, Lazada, Tiki, Sendo, Facebook, Instagram, Threads, X,
  Zalo) KHÔNG bao giờ được request — kể cả khi nguồn A/B redirect sang đó
  hay cấu hình sai. `--source <tầng C>` → `[blocked]`, exit 2.
- **Lịch sự với tòa soạn**: kiểm `robots.txt` TRƯỚC mỗi host (500/429/lỗi
  → bỏ host cả lượt; 401/403 → coi như cấm), cách ≥1 giây giữa 2 request
  cùng host (robots có `Crawl-delay` lớn hơn thì theo robots, tối đa 60s),
  User-Agent `samsam-intel` có email liên hệ (env `INTEL_CONTACT`), gặp
  429 thì dừng host đó, không thử lại. `--max-requests` (mặc định 60, tối
  đa 200) là ngân sách TỔNG kể cả robots.txt và redirect.
- **Không toàn văn (bản quyền)**: chỉ lưu tiêu đề + trích ≤300 ký tự (đã
  che SĐT/email) + link; không bao giờ mở trang bài. Muốn đọc bài → bấm
  link trên báo gốc.
- Chạy lại không nhân đôi: trùng URL (bỏ `utm_*`/`fbclid`...) hoặc trùng
  nội dung → đếm `dup_url`/`dup_content`, không ghi.
- **Đọc log**: `[req] {...}` = 1 request đã gửi (`status`, `robots_ok`,
  `gap_s` giây kể từ request trước cùng host — luôn ≥ 1.0); `[blocked]` =
  bị chặn, KHÔNG có request; `[robots-deny]` = robots cấm, KHÔNG có
  request; `[done] ... new=.. dup_url=.. off_topic=..` = tổng kết. Exit 1
  khi mọi nguồn được thử đều lỗi — xem dòng `[warn]` phía trên.
- LLM tóm tắt (`--llm`) mặc định TẮT: chỉ chạy khi `llm.enabled = true`
  trong file nguồn — chờ Pháp chế xác nhận bằng văn bản.

## 5e. Sản xuất P1 — tồn, phân bổ, BOM, lô (v9.2)

Agent SX-A0/A3/A4/A5 **chỉ đề xuất**: không tự chuyển kho, không đặt
mua, không lệnh sản xuất, không gọi LLM. Dữ liệu trong repo
(`data/sample_inventory.csv`, `data/sample_bom.json`,
`data/sample_lots.json`) là **MẪU** — output in `[MẪU]`. Mốc chốt + SLA ở
`data/production_config.json` (`status` "GIẢ ĐỊNH — chờ GĐ sản xuất
chốt"; GĐ SX chốt rồi NGƯỜI đổi `status`).

1. **Thứ Sáu — nạp tồn** (nhân sự kho xuất file cột `sku_key,kho,qty,
   captured_at`; `kho` là slug như `kho-da-nang`):
   ```
   python -m ingest.inventory_csv --file <file.csv|.xlsx>
   ```
   File lỗi (cột lạ/thiếu, SKU ngoài golden, qty âm/lẻ, ngày tương lai,
   trùng dòng) → `[err]` exit 1, **không nạp gì**; nạp lại cùng file →
   `[skip]`. Tồn hiện có = snapshot mới nhất mỗi (SKU, kho).
   **File phải liệt kê ĐỦ mọi SKU × kho từng có tồn — SKU hết hàng ghi
   `qty` 0** (đừng bỏ dòng); kho ngừng dùng → ghi 0 cho mọi SKU của kho
   đó. SKU bị bỏ khỏi file mới vẫn giữ số cũ (agent không đoán = 0) và
   `allocate`/`bulletin` in "số tồn cũ hơn file kho mới nhất — kiểm lại"
   — thấy dòng này thì bổ sung file với `qty` 0 rồi nạp lại. File đính
   chính gửi lại CÙNG ngày cũng phải đủ mọi SKU của kho: agent so theo
   FILE mới nhất của kho, SKU vắng trong file đó bị cảnh báo y như trên.
2. **Đề xuất phân bổ theo 4 mốc** (`chot_11_11` 25/10, `ke_hoach_tet`
   01/11, `chot_12_12` 15/11, `chot_tet` 10/12):
   ```
   python -m pipelines.production allocate --cutoff chot_11_11 [--start YYYY-MM-DD]
   ```
   Nhu cầu thấp/cơ sở/cao lấy từ `pipelines.scenario` (mục 5c) — KHÔNG
   phải doanh số cam kết. Ghi NHÁP `pending` vào `allocation_proposals`
   (cùng input → cùng `run_id`, chạy lại `[skip]`). SKU chưa có số tồn →
   đề xuất 0 + "chưa có số tồn — không kết luận thiếu".
3. **GĐ sản xuất duyệt** cả run (bắt buộc `--by`; ghi `approvals` + hash
   chain CHỈ qua function DB `decide_allocation_run` — `intake` tương tự
   qua `record_lot_intake`; khi tạo role cloud cho SX: grant EXECUTE 2
   function này, **TUYỆT ĐỐI không grant INSERT `approvals`** cho role nào —
   `verify_publish` tin bảng đó, chèn được là duyệt giả được nội dung;
   duyệt KHÔNG chuyển kho — chuyển tay theo quyết định):
   ```
   python -m pipelines.production approve --run <run_id> --by "<tên GĐ SX>"
   python -m pipelines.production reject --run <run_id> --by "<tên>" --note "<lý do>"
   ```
4. **BOM combo/hộp quà**:
   ```
   python -m pipelines.production bom --load <bom.json> [--source manual|sample]
   python -m pipelines.production bom --check
   ```
   Kiểm luật kênh theo golden: kênh online của combo phải có trong
   `allowed_channels` của MỌI SKU thành phần; tên combo qua guardrail.
   `--check` chạy lại luật trên golden hiện tại (golden đổi → BOM cũ có
   thể lỗi, exit 1) + số combo làm được (tính trên tồn CHƯA trừ phân bổ).
5. **Hồ sơ lô + kiểm nhập** (người kiểm nhập ghi kết quả, bắt buộc
   `--by`; lô đã kiểm không ghi lại):
   ```
   python -m pipelines.production lots --load <lots.json> [--source manual|sample]
   python -m pipelines.production intake --lot <mã lô> --result passed|failed --by "<người kiểm nhập>"
   ```
   Hạn dùng ≤ ngày sản xuất bị chặn (Python + DB). Lô `passed` là đầu vào
   QR truy xuất (v9.4).
6. **Bản tin tuần cho GĐ sản xuất** (in stdout, không gửi — người gửi):
   ```
   python -m pipelines.production bulletin [--date YYYY-MM-DD]
   ```
   4 mục: thiếu hàng theo mốc, lô chờ kiểm nhập, BOM lỗi, mục chờ duyệt &
   SLA (≥ 24h "NHẮC", ≥ 48h "QUÁ SLA 48h — đề xuất chuyển TGĐ" — chỉ là
   chữ, không tự chuyển/duyệt thay).

**Luật rượu:** phân bổ rượu = 0 mọi kênh online (bất kể golden còn ghi
`shopee`); combo có rượu chỉ được kênh `offline`. Câu hỏi mở: rượu có được
đóng hộp quà OFFLINE không (luồng B2B ghi "không đóng trong hộp quà") —
chờ Pháp chế/GĐ SX chốt; tới lúc đó không đưa rượu vào hộp quà mẫu.

## 5f. Lô + QR truy xuất (v9.4 — thí điểm mật ong)

Chỉ SKU trong `pilot_skus` của `data/qr_config.json` (nhãn **GIẢ ĐỊNH** —
chờ GĐ vùng trồng + Pháp chế chốt `region_text`, mốc phương án B). Lô
trong repo là **MẪU** (`[MẪU]` — không dùng in tem). Danh tính `--by` hiện
tự khai + allowlist `data/qr_signers.json` (ship RỖNG — SSO thật là
external-dep: chưa điền thì `sign` từ chối).

Thứ tự (mọi bước ghi cần `--by`, ghi `approvals`/`agent_action_log`):

```bash
# 1. GĐ Sản xuất ánh xạ lô ↔ nhật ký "thu hoạch" ĐÃ CHAIN (+ ≤3 ảnh kho tư liệu cùng khoảnh)
python -m pipelines.qr_trace link --lot <mã lô> --log <id nhật ký> [--media <sha256> ...] --by "<tên>"
python -m pipelines.qr_trace unlink --lot <mã lô> --log <id> --by "<tên>"   # gỡ khi ánh xạ nhầm
# 2. Xem lời văn trang + sha + guardrail kênh qr + vai đã ký/còn thiếu (chỉ đọc, exit 0)
python -m pipelines.qr_trace preview --lot <mã lô>
# 3. Ba NGƯỜI KHÁC NHAU ký cùng bản (GĐ SX, GĐ vùng trồng, Pháp chế/QA)
python -m pipelines.qr_trace sign --lot <mã lô> --role gd_san_xuat --by "<tên>"
python -m pipelines.qr_trace sign --lot <mã lô> --role gd_vung_trong --by "<tên>"
python -m pipelines.qr_trace sign --lot <mã lô> --role phap_che_qa --by "<tên>"
# 4. Phát hành mã (DB kiểm đủ 3 chữ ký trên bản HIỆN TẠI, lô passed còn hạn)
python -m pipelines.qr_trace issue --lot <mã lô> --by "<tên>"
# 5. Sinh trang tĩnh data/qr_site/<code>/index.html (gitignored) — cần env GARDEN_MEDIA_DIR nếu có ảnh
python -m pipelines.qr_trace site [--out <thư mục>]
# 6. Thu hồi mã (trang chuyển "đã thu hồi" sau khi chạy lại site)
python -m pipelines.qr_trace revoke --code <mã> --by "<tên>" [--reason "..."]
# Bản tin phương án B (in stdout, không ghi DB) — chạy mỗi ngày từ 20/11
python -m pipelines.qr_trace planb [--date YYYY-MM-DD]
```

- **Đổi ánh xạ / ảnh / ngày lô / lời văn (`region_text`) sau khi ký = ký
  lại**: chữ ký gắn với `snapshot_sha256` + `text_sha256`; `preview` sẽ báo
  thiếu cả 3 vai. Lô đang có mã còn hiệu lực → `link`/`unlink` bị chặn
  (thu hồi trước). `site` thấy nội dung lệch bản đã ký → KHÔNG ghi trang
  đó, exit 1 ("cần thu hồi + ký lại").
- Trang KHÔNG có tọa độ, mã/vị trí khoảnh, tên/SĐT/email người (nhật ký, ảnh,
  người ký); text fail guardrail kênh `qr` → không ký/phát hành/ghi trang.
- **Không sinh ảnh QR** (lib QR không có trong interpreter): `issue` in URL
  (`public_base_url` rỗng = chưa có domain — external-dep); nhà in tạo QR từ
  URL. Đưa `data/qr_site/` lên hosting tĩnh = việc Hạ tầng (external-dep);
  KHÔNG có trang liệt kê mã (chống dò mã).
- `planb`: trước mốc → "còn N ngày"; từ mốc → "ĐỀ XUẤT phương án B" + lời
  văn tem KHÔNG QR cho lô đã passed. GĐ vùng trồng quyết, báo Sales + Hạ
  tầng — agent KHÔNG tự đổi tem.

## 6. Backup + diễn tập khôi phục (v3.6)

**Backup** (hằng ngày, hoặc trước khi đụng schema/data):

```
python scripts/db_backup.py
```

- Biến env (đặt trong `.env` hoặc env tiến trình): `BACKUP_DIR` (BẮT
  BUỘC, thư mục NGOÀI repo), `BACKUP_KEEP` (mặc định 7 bản),
  `BACKUP_PASSPHRASE_FILE` (có khóa → file `.dump.enc` mã hóa; dòng
  đầu ≥16 ký tự; chưa có → `[warn]` bản chưa mã hóa), `BACKUP_OFFSITE`
  (`dir:<thư mục 2>`; `s3://...` chờ key — external-dep).
- Ra 1 file `pg_dump -Fc` + `*.manifest.json` (sha256, size, số dòng 14
  bảng); nhật ký `backup_runs.jsonl` trong `BACKUP_DIR`.
- Exit: 0 OK · 1 lỗi (DB/công cụ/dump) · 2 cấu hình sai · 3 local OK
  nhưng offsite chưa xong (vẫn phải xử lý).
- `pg_dump.exe` (`C:\Program Files\PostgreSQL\17\bin`) chỉ là công cụ
  bên dưới — script tự tìm, không gõ tay.

**Diễn tập khôi phục** (tuần, Chủ nhật):

```
python scripts/db_restore_drill.py
```

Khôi phục bản mới nhất vào DB TẠM `samsam_drill_...`, so số dòng với
manifest, in `RTO`, rồi xóa DB tạm. Đọc kết quả ở dòng cuối
`drill_runs.jsonl` (`status=ok`, `rto_seconds`). Script từ chối (exit 2)
nếu tên đích trùng DB đang dùng.

**Khôi phục ĐÈ production**: KHÔNG có lệnh tự động. Tầng 2 — người làm
tay, báo TGĐ trước, đối chiếu danh sách phiếu xóa dữ liệu (DPIA, 93 ngày)
để không khôi phục lại dữ liệu đã xóa theo yêu cầu.

File trên đĩa cần backup cùng (copy sang chỗ an toàn, đừng xóa bản
gốc):

- `data/*.jsonl` (products/articles/about/news + sample_*)
- `data/conversations.jsonl` (+ `.1` nếu có — convlog tự rotate >5MB
  và tự purge >30 ngày, KHÔNG cần dọn tay)
- `data/zalo_tokens.json` (token Zalo hiện hành — mất = lấy lại token
  trên OA console)
- `data/zalo_seen.db` (dedup msg_id — mất = reply nhân đôi khi Zalo retry)
- `data/reports/` (báo cáo đã sinh)
- `data/claims_whitelist.json` + `data/banned_words.txt` (nguồn sự
  thật guardrail — đã trong git, nhưng backup cùng cho chắc)

**Diễn tập thảm họa (DR) + đóng băng (v3.10):** quy trình đầy đủ cho
người vận hành hạ tầng AI ở [`runbook-ha-tang.md`](runbook-ha-tang.md)
(lịch việc, mức sự cố S1/S2/S3, kill switch, trần chi phí, bàn giao).
Hai lệnh chính:

```
python scripts/dr_drill.py
python scripts/break_glass.py --status
```

`dr_drill` dựng Postgres mới trong container docker tạm, khôi phục bản
backup mới nhất, đo RTO/RPO rồi luôn xóa container (hằng tháng + trước
30/11, 18/12). `break_glass` mở/đóng/xem cửa sổ ngoại lệ tối đa 4 giờ
trong đóng băng 21/12–10/02 (`--open --reason ... --by ...`).

## 6b. Giám sát vận hành (Quản lý hạ tầng AI — v3.7)

**Bản tin sức khỏe hằng ngày** (chỉ số SQL, không dùng LLM, không tự gửi):

```
python scripts/health_bulletin.py                  # in stdout + ghi data/reports/health-<ngày>.md
python scripts/health_bulletin.py --out-dir <thư mục> --date 2026-10-11
python scripts/health_bulletin.py --help
```

Đọc 5 mục theo thứ tự:

1. **DB** — "sống" hoặc "DB không truy cập được" (bản tin vẫn ra, exit 0
   → xử lý theo mục 7 "Chưa nạp — không kết nối được Postgres").
2. **Job 24h** — số lần OK/lỗi theo job từ bảng `job_runs`; dòng "LỖI"
   kèm `detail` (đã che SĐT/email/URL); "KHÔNG CHẠY/TRỄ" khi
   `ingest.lead_store` quá 24 giờ hoặc `agents.report` quá 8 ngày chưa có
   lần OK. Chỉ 2 job này ghi `job_runs` (khi chạy bằng `python -m`).
3. **Chi phí AI tháng này theo agent** — so với trần `monthly_cap_usd` trong
   `data/llm_gateway.json`: ≥80% "CẢNH BÁO" (xem lại lưu lượng/model,
   cân nhắc nâng trần — trần thật do công ty chốt); ≥100% "ĐÃ CHẶN
   (gateway)" — gateway đã tự chặn agent đó tới đầu tháng sau hoặc khi
   nâng trần. Bản tin chỉ báo, không tự chặn/mở.
4. **Lời gọi LLM lỗi 24h** — đếm `llm_usage` `ok = false` theo agent;
   tăng đột biến → xem mục 7 "Chatbot / Content Studio không trả lời".
5. **Hàng chờ duyệt** — số `content_drafts` `pending` (MKT duyệt ở tab
   "Duyệt & Lịch").

Job lỗi → xem chi tiết:

```
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -U <user> -d samsam -c "select job, started_at, ok, detail, host from job_runs order by id desc limit 20;"
```

**Lịch 07:30 giờ VN** (chỉ hướng dẫn — máy pilot KHÔNG tạo sẵn lịch;
server production + lịch thật là external-dep). Chọn MỘT trong hai:

- Windows Task Scheduler (chạy trong thư mục repo):
  `schtasks /create /tn "SamSam health bulletin" /sc daily /st 07:30 /tr "cmd /c cd /d <repo> && python scripts/health_bulletin.py"`
- cron (Linux, máy giờ VN hoặc khai `CRON_TZ=Asia/Ho_Chi_Minh`):
  `30 7 * * * cd <repo> && python scripts/health_bulletin.py`

n8n trong stack giám sát dưới đây KHÔNG chạy được bản tin (image không có
python, không mount repo/DSN; n8n 2.x tắt node Execute Command mặc định).
Lịch qua n8n chỉ khả thi khi n8n chạy trên VM runner có repo + python +
env, hoặc gọi sang host qua SSH/HTTP — external-dep, chưa dựng.

**Gửi bản tin**: mặc định không gửi. `--notify` + `HEALTH_NOTIFY=email|telegram`
và biến kênh trong `.env` (xem `env.example`) mới gửi; SMTP/Telegram bot
thật + người nhận do công ty cấp (external-dep). Gửi lỗi không làm mất bản
tin (vẫn có file/stdout).

**Stack giám sát local** (n8n + Uptime Kuma, cổng chỉ 127.0.0.1 — bắt buộc
đặt `N8N_ENCRYPTION_KEY` trong `.env`; tài khoản owner n8n/admin Kuma tạo ở
lần mở UI đầu):

```
docker compose --env-file .env -f deploy/docker-compose.monitoring.yml config   # kiểm cấu hình
docker compose --env-file .env -f deploy/docker-compose.monitoring.yml up -d    # n8n http://127.0.0.1:5678 · Kuma http://127.0.0.1:3001
docker compose --env-file .env -f deploy/docker-compose.monitoring.yml down     # dừng (thêm -v = xóa dữ liệu)
```

Uptime Kuma theo dõi URL production (`/zalo-webhook` HTTPS, Streamlit) là
external-dep — cần server production.

## 7. Xử lý sự cố thường gặp

### "Chưa nạp — không kết nối được Postgres" trên UI

Tab Leads / Nhật ký vườn / Duyệt & Lịch hiện dòng này khi `connect()`
trả None. Checklist:

1. Postgres service có đang chạy không (Services → postgresql-x64-17).
2. `DATABASE_URL` trong `.env` đúng `postgresql://<user>:<pass>@localhost:5432/samsam`.
3. Chạy `python scripts/apply_schema.py` — in được "9 bảng public" là
   DB sống; lỗi "không kết nối được" → kiểm service/port/firewall.
4. Hành vi chuẩn khi DB chết (không phải bug): CLI đọc
   (`pipelines.store --pending/--calendar`, `agents.garden --check`)
   in "chưa nạp" exit 0; CLI ghi (`--approve`, ghi nhật ký) báo lỗi
   exit 2; `agents.report` vẫn sinh báo cáo DEGRADED (phần DB ghi
   "[chưa nạp]", phần convlog vẫn đủ).

### Chatbot / Content Studio không trả lời, lỗi API

1. `OPENROUTER_API_KEY` trong `.env` còn đúng + tài khoản OpenRouter
   còn credit (dashboard openrouter.ai).
2. Đổi model nếu model mặc định ngừng phục vụ: `OR_CHAT_MODEL` /
   `OR_EMBED_MODEL` trong `.env`.
3. `answer()` crash → user nhận `ERROR_FALLBACK` (Zalo) — đọc console
   log để biết lỗi gốc.

### "Không tìm thấy draft/khoảnh/bảng"

- `python scripts/apply_schema.py` trước — thiếu bảng là chưa apply.
- Khoảnh không có trong tab Nhật ký vườn → thêm row `plots`
  `status='active'` (SQL qua psql, `source='manual'`).
- Draft không hiện trong `--pending` → có thể đã duyệt/từ chối; status
  một chiều không quay lại.

### Bị khóa đăng nhập ("tạm khóa đăng nhập do sai nhiều lần")

Sai mật khẩu 5 lần liên tiếp (`AUTH_MODE=local`) → khóa 5 phút theo
tên đăng nhập. Chờ hết 5 phút, hoặc quản trị restart Streamlit (khóa
nằm trong RAM — restart xóa). Quên mật khẩu → quản trị tạo hash mới
(`python -m pipelines.auth --hash`) và thay trong `data/users.json`.
"Truy cập bị chặn: chưa cấu hình đăng nhập" = `AUTH_MODE` trống/sai
(mục 9).

### `--verify-log` báo lỗi (exit 1)

Nhật ký `agent_action_log` bị sửa (`row_hash`) hoặc xóa/chèn
(`prev_hash`) ngoài luồng — chỉ superuser DB làm được (bảng chặn
UPDATE/DELETE bằng trigger). KHÔNG tự "sửa cho khớp". Người phụ trách
hạ tầng (vai trò `ha_tang`) lưu output + backup DB hiện tại, báo TGĐ;
đối chiếu với backup gần nhất (mục 6) để xác định dòng bị đụng.

### `--verify` vùng trồng báo lỗi (exit 1)

`python -m agents.garden_director --verify` in `#id: row_hash` (nội dung
nhật ký bị sửa), `prev_hash` (dòng trước bị xóa/chèn/giấu thành "mẫu")
hoặc `unchained` (nhật ký thật chèn khi trigger bị tắt) — chỉ superuser DB
làm được. KHÔNG "sửa cho khớp". Lưu output + backup DB hiện tại, báo GĐ
vùng trồng + TGĐ; đối chiếu backup gần nhất (mục 6). Giới hạn: xóa dòng
CUỐI chuỗi không phát hiện được bằng chuỗi thuần (neo hash ra ngoài =
external-dep).

### Cập nhật status lead (pilot chưa có nút trên UI)

```
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -U <user> -d samsam -c "update leads set status='contacted' where id=12;"
```

Status hợp lệ: `new` | `contacted` | `won` | `lost`.

### Báo cáo in "(mẫu)" khắp nơi

Đúng thiết kế — `orders`/`plots`/`plot_logs` hiện là dữ liệu MẪU
(`sample:*.jsonl`) chờ công ty bàn giao (SOW §5.2). Khi có data thật:
nạp file thật qua `core_store` hoặc nhập tay `source='manual'`.

## 8. Kiểm thử & chất lượng (trước demo/nghiệm thu)

```
python -m pytest        # toàn bộ test (LUÔN chạy dạng -m, entry pytest trần lỗi import)
ruff check .            # lint
python scripts/eval_qa.py   # 12 câu hỏi questions.md qua RAG thật — exit 0 khi ≥10/12 + 2 bẫy pass (xem phu-luc-d.md)
```

**Nghiệm thu theo commit & cổng deploy (v3.5, F17.1):**

```
python scripts/agent_eval.py --agent guardrail   # bộ ca data/eval/guardrail.jsonl, không cần key — ghi eval_runs
python scripts/agent_eval.py --agent chatbot     # 14 ca qua RAG thật (cần OPENROUTER_API_KEY)
python scripts/deploy_gate.py --sha <SHA 40 hex> --approved-by "<tên>" [--hotfix]
```

- Ngưỡng + người duyệt ở `data/eval/config.json` (chốt TRƯỚC khi chạy;
  bản hiện tại dev soạn, chưa được công ty duyệt). Lịch đóng băng ở
  `data/freeze_calendar.json` (v4.0 — 1 nguồn, `pipelines/freeze.py`) +
  break-glass còn hạn (`python scripts/break_glass.py --open ...`, env
  `BREAK_GLASS_LOG`); lịch hỏng → coi như đang đóng băng (chỉ hotfix).
- `agent_eval` chỉ ghi khi working tree sạch và SHA = HEAD; `--allow-dirty`
  ghi `<sha>-dirty` (không bao giờ mở deploy); `--no-record` chỉ chấm.
- `deploy_gate` CHỈ IN kế hoạch (release `/opt/samsam/releases/<SHA>`,
  `.env` symlink từ `/opt/samsam/shared/.env`, dừng service rồi `mv`
  state `data/zalo_tokens.json`/`zalo_seen.db*`/`conversations.jsonl*`
  sang release mới, đổi symlink `current`, smoke `/healthz` + eval
  chatbot `--no-record`, fail → rollback mang state về, giữ 10 release)
  khi: row `eval_runs` mới nhất của MỌI agent bắt buộc là PASS + người
  duyệt thuộc `approvers` + ngoài đóng băng 21/12–10/02 (trong đó chỉ
  `--hotfix` hoặc khi break-glass đang mở — tính theo giờ THẬT lúc chạy;
  `--today` chỉ mô phỏng 12:00 ngày đó). DB lỗi hoặc `required_agents`
  rỗng → từ chối.
- CI: `.github/workflows/ci.yml` — mỗi push/PR chạy ruff + pytest + eval
  guardrail trên Postgres service; eval chatbot chỉ khi chạy tay
  (workflow_dispatch) và có secret.
- **External-dep (chưa có):** danh sách `approvers` thật (đang rỗng →
  gate từ chối mọi deploy), secret `OPENROUTER_API_KEY` trên GitHub,
  runner tự host, môi trường production, n8n ghi `eval_runs` qua webhook
  HMAC, công ty/Pháp chế duyệt bộ ca.

## 9. Tài khoản & bí mật (vai trò — KHÔNG ghi giá trị)

Tất cả nằm trong file `.env` ở root repo (`.env` đã gitignore; mẫu
không-dot ở `env.example`). Tài khoản đứng tên công ty theo Phụ lục C
SOW.

| Biến trong `.env` | Vai trò | Thiếu thì |
|---|---|---|
| `DATABASE_URL` | Postgres local db `samsam` | RAG/draft/leads/agents không kết nối được |
| `OPENROUTER_API_KEY` | 1 key cho cả chat + embeddings | Chatbot & Content Studio chết |
| `OR_CHAT_MODEL` / `OR_EMBED_MODEL` | Model chat / embedding (có mặc định) | Dùng mặc định `openai/gpt-4o-mini` / `openai/text-embedding-3-small` |
| `ZALO_APP_ID` / `ZALO_APP_SECRET` | OAuth refresh token Zalo OA | Webhook không send được khi token hết hạn |
| `ZALO_OA_SECRET` | Verify chữ ký webhook Zalo | `DEPLOY` bật → refuse to serve |
| `ZALO_ACCESS_TOKEN` / `ZALO_REFRESH_TOKEN` | Seed token lần đầu | Sau refresh đầu, source-of-truth là `data/zalo_tokens.json` |
| `ZALO_WEBHOOK_PORT` | Port webhook (mặc định 8788) | — |
| `DEPLOY` | `1/true/yes` = production, verify signature bắt buộc | Mọi giá trị khác = dev, signature bypass — KHÔNG public |
| `AUTH_MODE` | Đăng nhập Streamlit: `proxy` (header Cloudflare Access) / `local` (user+mật khẩu) / `dev` (máy dev, cấm khi `DEPLOY=1`) | Trống/sai = **chặn mọi truy cập** (fail-closed) |
| `AUTH_USERS_FILE` | File users (mặc định `data/users.json`, gitignored) | File thiếu/hỏng = không ai đăng nhập được |

**Đăng nhập Streamlit (v3.4):**

1. Copy `data/users.example.json` → `data/users.json` (KHÔNG commit);
   mỗi người 1 entry `{"role": ..., "password_hash": ...}`, role thuộc
   `tgd | phap_che | gd_ban_hang | gd_marketing | mxh | ha_tang` (danh
   sách người + vai trò do TGĐ chốt).
2. Tạo hash mật khẩu: `python -m pipelines.auth --hash` (nhập ẩn 2 lần,
   ≥10 ký tự) → dán chuỗi `scrypt$...` vào `password_hash`.
3. `.env`: `AUTH_MODE=local` (hoặc `proxy` khi đã có Cloudflare Access —
   Streamlit phải bind `127.0.0.1`, xem `docs/deploy.md`). `pipelines/auth.py`
   tự đọc `.env` (biến môi trường process ưu tiên hơn) — `AUTH_MODE`,
   `AUTH_USERS_FILE`, `DEPLOY` đặt trong `.env` có hiệu lực ngay lần chạy
   đầu; `DEPLOY=1` trong `.env` ép `dev` → chặn.

**Role DB (v3.4):** `python scripts/apply_schema.py --roles` tạo 2 role
NOLOGIN `agent_writer` (agent: chỉ INSERT draft pending + log) và
`app_human` (người: duyệt qua function). Login thật do hạ tầng tạo, mật
khẩu đặt NGOÀI git, ví dụ (psql, thay `<...>`):

```
create role <ten_agent> login password '<mat-khau>' in role agent_writer;
create role <ten_nguoi> login password '<mat-khau>' in role app_human;
```

**CHƯA đổi `DATABASE_URL` của Streamlit / agent / webhook sang DSN role.**
`roles.sql` hiện CHỈ cấp quyền trên `content_drafts`, `approvals`,
`agent_action_log` (+ function duyệt). Chuyển DSN bây giờ sẽ làm gãy:

| Tiến trình dưới role | Bảng thiếu quyền | Hậu quả |
|---|---|---|
| Streamlit dưới `app_human` | `chunks`, `leads`, `plot_logs`/`plots`, `products`/`claims_approved`, `llm_usage`... | Tab Chat, Leads, Báo cáo, Nhật ký vườn lỗi DB |
| Agent dưới `agent_writer` (qua `pipelines/llm_gateway.py`) | `llm_usage` (SELECT + INSERT) | **Trần chi phí LLM tháng TẮT CÂM** — `_month_spend` lỗi đọc thì "cho qua"; usage không còn được ghi |
| Agent/ingest khác | `chunks`, `leads`, `plot_logs`, `sku_*`, `price_list`, `orders`... | Ghi/đọc lỗi |

Hiện tại DSN role CHỈ dùng cho tiến trình duyệt/ghi draft riêng, ví dụ
CLI `python -m pipelines.store` (login `in role app_human` duyệt/xếp
lịch; login `in role agent_writer` lưu draft). Máy pilot vẫn chạy app/
agent bằng DSN owner → chặn tự-duyệt ở tầng DB CHƯA có hiệu lực cho
chúng (UI vẫn đi qua `approve_draft`). Chuyển hẳn sang role = grant đủ
bảng theo plan §5 (external-dep/someday trong `DONE.md`), kiểm lại trần
chi phí LLM dưới role agent trước khi đổi DSN.

**Quy tắc:** không ai được ghi giá trị secret vào code/docs/git;
`.env` nằm ngoài git; khi bàn giao chuyển `.env` + `data/zalo_tokens.json`
cho công ty qua kênh an toàn (không email rõ).
