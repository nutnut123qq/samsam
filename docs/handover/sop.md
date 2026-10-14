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
| Lịch mùa vụ + brief + bản tin Marketing (v6.0) | sáng thứ Hai: `python -m agents.mkt_director --briefs` rồi `--bulletin` → `data/reports/mkt-week-<thứ Hai>.md` — xem mục 5k |
| Review sàn/UGC + kết quả ads thử nghiệm (v6.4) | thứ Hai: xuất file review Seller Center → `python -m agents.mkt_ugc --reviews FILE.csv --channel shopee --by "<tên>"`; phiếu ads đang chạy → `python -m agents.mkt_ads --results FILE.csv --plan-id N --by "<tên>"` — NHÁP, người duyệt rồi làm tay — xem mục 5n |
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

### Sinh listing hàng loạt (MKT-02, v6.1)

```
python -m pipelines.content --listing --sku all --channel shopee
python -m pipelines.content --listing --sku savina-12v --channel shopee --channel web --no-llm
```

- Sinh NHÁP listing cho mỗi cặp SKU × kênh (`shopee|tiktok|web`) vào hàng
  duyệt (`pending`, `content_type=listing`) — duyệt ở tab **Duyệt &
  Lịch**; sau khi duyệt, NGƯỜI tải lên sàn tay. Agent KHÔNG đăng, KHÔNG
  sửa listing trên sàn.
- Mỗi dòng in 1 cặp: `created #id` (nháp mới), `skipped #id` (đã có nháp
  listing chờ duyệt/đã duyệt cùng SKU/kênh/phiên bản prompt — chạy lại
  không nhân đôi), `refused <code>: <lý do>` (rượu `ruou`, SKU chưa đủ
  readiness kênh `readiness`, SKU lạ `sku_la` — không gọi LLM, không
  ghi), `failed: <codes>` (guardrail không qua — KHÔNG ghi, chạy lại được).
- Exit 0 = không có `failed`; 1 = có `failed`; 2 = sai tham số hoặc DB
  không kết nối được (kiểm DB TRƯỚC khi gọi LLM).
- Thông số/giá lấy từ golden (`python -m ingest.golden_store` nạp trước);
  giá đang chờ GĐ bán hàng duyệt → người duyệt nháp phải soát giá. Muốn
  sinh lại 1 listing: từ chối nháp cũ (`--reject`) rồi chạy lại lệnh.

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
python -m pipelines.director --block <khối>        # bản tin GĐ khối → data/reports/director-<khối>-<ngày>.md (khối finance: dùng `python -m agents.acc_ar --bulletin` — mục 5j; director ghi đè mất mục nợ quá hạn)
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

## 4c. Cockpit TGĐ (v8.0)

Báo cáo tuần cho TGĐ — mọi con số do CODE điền từ bảng `channel_snapshots`
(không ai/không LLM gõ số). Sáng thứ Hai, theo thứ tự:

```
python -m ingest.lead_store                            # 0a. gom lead convlog tới hết Chủ nhật TRƯỚC khi chụp
python -m pipelines.approval_queue --expire            # 0b. đánh expired mục quá hạn TRƯỚC khi chụp
python -m pipelines.cockpit --collect                  # chụp số nội bộ tuần VỪA ĐÓNG (giờ VN)
python -m pipelines.cockpit --collect --period month   # đầu tháng: chụp tháng vừa đóng
python -m pipelines.cockpit --import <file.csv> --by "<người xuất file>"   # số kênh ngoài
python -m agents.ceo_report                            # → data/reports/ceo-<YYYY-Www>.md
python -m agents.ceo_report --submit                   # nộp trang vào hàng chờ khối ceo (TGĐ duyệt)
python -m pipelines.cockpit --metrics                  # xem từ điển chỉ số data/metrics.json
```

- **Bước 0 bắt buộc:** sổ `channel_snapshots` chỉ ghi thêm (insert-only) —
  chụp trước khi gom lead/expire thì `leads.new`/`approvals.ceo_expired`
  của tuần bị thiếu và chụp lại sau đó KHÔNG sửa được (chỉ báo conflict).
- **Chatbot (convlog giữ 30 ngày):** `chatbot.questions`/
  `chatbot.unanswered` chỉ chụp được khi đầu kỳ còn trong 30 ngày gần
  nhất. Kỳ cũ hơn (backfill tuần cũ, và cả THÁNG — chụp ngày 1 tháng sau
  thì ngày đầu tháng trước đã quá 30 ngày) → `[warn] thiếu nguồn ... vượt
  hạn lưu`, báo cáo hiện `[chưa có dữ liệu]` (không ghi số thiếu). Số chat
  theo tháng: cộng các tuần đã chụp.
- **Kỳ:** chỉ chụp/báo cáo kỳ ĐÃ ĐÓNG (tuần ISO thứ Hai 00:00 giờ VN;
  tháng ngày 1). Kỳ đang chạy → exit 2. Thêm `--ref YYYY-MM-DD` để chọn
  kỳ chứa ngày đó; `--collect --dry-run` chỉ in số, không ghi.
- **CSV kênh ngoài** (UTF-8, ≤ 2 MB), header ĐÚNG
  `channel,metric_id,period_kind,period_start,value`; `metric_id` phải là
  metric `external` trong `data/metrics.json` và kênh nằm trong danh sách
  của metric; `period_start` là thứ Hai (tuần) / ngày 1 (tháng); `value`
  số nguyên KHÔNG dấu nghìn (`21585320`, không `21.585.320`). File có
  lỗi → in `dòng N, cột X: <lý do>` (không in giá trị ô), **exit 1, 0
  dòng được nạp**, chưa kết nối DB — sửa file rồi chạy lại. Nạp lại
  cùng file = không thêm dòng (idempotent). `--sample` chỉ dùng cho file
  MẪU (báo cáo gắn `(MẪU)`) và **tên file phải có `MAU`/`sample`** — file
  tên MẪU thiếu `--sample`, hoặc file thật có `--sample` → exit 2. KHÔNG nạp
  file MẪU vào DB vận hành (sổ insert-only: số mẫu sẽ chặn vĩnh viễn file
  thật cùng kỳ) — trên DB thật chỉ chạy thử ở DB dev/test.
- **Role DB (DSN) từng lệnh:** `--import` bằng role `agent_writer` CHỈ
  nạp được file toàn dòng MỚI (role chỉ INSERT sổ, không đọc được số đã
  có). File có BẤT KỲ dòng nào trùng khóa đã nạp — kể cả file y nguyên,
  hay file Seller Center xuất lại đã SỬA số — → hủy cả file, exit 1,
  `[fail] N dòng đã có trong sổ ... số mới KHÔNG được nạp` (agent_writer
  không phân biệt được "y nguyên" với "đã sửa số"; không bao giờ báo
  `[done]` câm). Chạy lại bằng DSN có quyền SELECT `channel_snapshots`
  để biết: y nguyên → exit 0 `unchanged=N`; khác số → conflict (dưới).
  `--collect` cần quyền ĐỌC `leads`/`approvals`/`market_alerts`/`job_runs`/
  `llm_usage` mà `agent_writer` chưa có → hiện chạy bằng DSN chủ sở hữu
  (thiếu quyền → metric vào `[warn] thiếu nguồn`, không thành 0).
  `agents.ceo_report` đọc `channel_snapshots` → cần `app_human` (role này
  có cả quyền duyệt `decide_item`); role chỉ-đọc riêng cho cockpit là việc
  chờ (someday — `docs/roles.sql` không đổi ở v8.0).
- **Conflict** = số mới KHÁC số đã chụp cùng kỳ/kênh/metric. Hệ thống
  KHÔNG sửa đè (chống "lọc số"): CSV → hủy cả file (exit 1, với MỌI
  role — dưới `agent_writer` mọi dòng trùng khóa đều hủy file, xem trên);
  collector nội bộ → giữ bản cũ + `[warn]`. Báo người quản trị DB kiểm tra nguồn
  nào đúng — sửa số đã chụp có người duyệt là việc ngoài phạm vi v8.0.
- **Dòng ĐỎ "chưa có người nhận cảnh báo độc lập"** ở đầu báo cáo = file
  `data/red_alert_routing.json` chưa có người nhận hợp lệ (`phap_che`/
  `bks`). Pháp chế xác nhận người nhận thật rồi dev điền file — trước đó
  dòng ĐỎ luôn hiện (không im lặng).
- **Nhận xét:** mặc định theo luật (không gọi LLM). `--llm` bật nhận xét
  qua gateway agent `cockpit` (trần 0,5 USD/tháng): LLM chỉ được viết
  placeholder `{metric:kỳ}`; văn bản có chữ số/%/trăm-nghìn-triệu-tỷ tự
  viết → bị loại, dùng nhận xét theo luật và ghi "Nhận xét LLM bị loại".
- Báo cáo là BẢN NHÁP: hệ thống không tự gửi; TGĐ duyệt mục
  `weekly_report` trong hàng chờ (`python -m pipelines.approval_queue
  --pending --block ceo`). Số doanh thu thật từ Seller Center/kế toán và
  người nhận cảnh báo đỏ thật là external-dep.

### Sổ quyết định, sổ rủi ro, audit outside-in (v8.1)

Ba phần còn lại của cockpit WP10 — mọi số do CODE tính lại từ dữ liệu thật
mỗi lần chạy (không nhập tay song song), không LLM, không mạng; agent KHÔNG
sửa/gỡ bài, KHÔNG đổi listing/giá. Báo cáo tuần `python -m agents.ceo_report`
tự chèn 3 mục "Tiến độ & Sổ quyết định", "Rủi ro pháp lý mở", "Audit
outside-in (P1)" giữa "Thời gian duyệt" và "Nhận xét" (mục nào lỗi → dòng
"*(không đọc được: …)*", trang vẫn ra).

```
python -m agents.ceo_decisions --propose                # agent ĐỀ XUẤT mục khối ceo đã quyết chưa vào sổ (chỉ đọc)
python -m agents.ceo_decisions --record --basis approval_queue:<id> --topic "<chủ đề>" --decision "<quyết định>" --by "<tên người ghi>" [--due YYYY-MM-DD]
python -m agents.ceo_decisions --record --basis van_ban --decided-by "<người quyết>" --note "<số/ngày văn bản ≥10 ký tự>" --topic ... --decision ... --by "<tên>"
python -m agents.ceo_decisions --follow <id> --status dang_lam|xong|huy --by "<tên>" [--note "<bằng chứng>"]
python -m agents.ceo_decisions --list                   # sổ + quyết định quá hạn + mốc trễ phòng Dự án
python -m agents.ceo_risk --report                      # → data/reports/ceo-risk-<ngày>.md
python -m agents.ceo_audit --report                     # → data/reports/ceo-audit-<ngày>.md
python -m agents.ceo_report --bulletin                  # bản tin GĐ khối ceo + 3 mục → director-ceo-<ngày>.md
```

- **Ai ghi gì:** sổ `decision_log` chỉ NGƯỜI ghi (`--by` tên người; 'agent:'/
  'system:' bị từ chối cả ở CLI lẫn DB). Agent chỉ đề xuất. Sổ append-only:
  không sửa/xóa — theo dõi thực hiện bằng `--follow` (thêm dòng mới; `xong`
  phải có `--note` bằng chứng). Căn cứ hàng duyệt: người quyết + ngày quyết
  lấy từ mục đã duyệt (`--decided-by` khác → từ chối); 1 căn cứ chỉ ghi 1
  lần. Chủ đề/quyết định/ghi chú qua guardrail trước khi ghi (trang TGĐ chép
  chủ đề) và lưu bản đã che SĐT/email.
- **Sổ rủi ro** đọc tracker Pháp chế: hồ sơ XNQC (đếm ngược mốc phí
  T-30/T-14/T-7 tới 31/12/2026), bài kênh vi phạm đang mở/quá 24h, cảnh báo
  đỏ gốc chưa xác nhận, DPIA chưa ký, tuyến cảnh báo đỏ. Mức theo luật
  `data/ceo_risk.json` (BẢN DEV SOẠN — Pháp chế duyệt ngưỡng + URL nguồn
  phí); xu hướng so với 7 ngày trước. Hồ sơ XNQC chưa có lịch sử trạng
  thái → xu hướng hồ sơ tính theo trạng thái hiện tại. Agent không tư vấn
  pháp lý.
- **Audit outside-in P1:** bài đang đăng (file xuất tay nạp qua
  `python -m agents.ra_kenh --file`) + listing sàn (file Seller Center qua
  `python -m ingest.market_csv`) so với bản đã duyệt (sha256 `approvals` /
  dòng đầu listing đã duyệt) → tỷ lệ tuân thủ theo kênh (mẫu số 0 hiện "—",
  không 0%). Bài đã gỡ và bài đăng trước ngày áp dụng quy trình duyệt nằm
  ngoài mẫu số. GIỚI HẠN P1: chỉ so tiêu đề listing (file sàn không có mô
  tả); giá xem cảnh báo `price_mismatch`. Có phát hiện vẫn exit 0 — audit
  là báo, xử lý theo quy trình rà kênh (ticket 24h của Pháp chế).
- **DSN:** `decision_log` chưa grant cho `agent_writer`/`app_human` → chạy
  bằng DSN chủ sở hữu; `ceo_risk`/`ceo_audit` mở kết nối `read_only`.
- `python -m pipelines.director --block ceo` GHI ĐÈ bản tin của
  `ceo_report --bulletin` (in `[warn]`) — dùng lệnh `ceo_report --bulletin`.
- **External-dep:** tracker Pháp chế thật + Pháp chế duyệt ngưỡng/URL
  nguồn phí; quyết định thật của TGĐ (sổ ship rỗng); danh sách bài đang
  đăng + file listing Seller Center thật; DPIA ký; người nhận cảnh báo đỏ
  độc lập; role DB chỉ-đọc cho cockpit; P2: khung giá–voucher, audit
  inside-out, neo hash object-lock.

## 4d. Agent GĐ Kinh doanh TMĐT (v5.0)

Agent giám đốc đầu tiên cấu hình thật trên hàng duyệt chung (mục 4b): gom
việc khối KD từ nguồn thật vào `approval_queue` (khối `sales`), theo dõi
SLA handoff theo GIỜ LÀM VIỆC, leo thang khi quá hạn, làm bản tin ngày/tuần.
Không LLM, không tự gửi, không tự duyệt.

```
python -m agents.sales_director --run --dry-run --bulletin   # CHỈ ĐỌC: in kế hoạch + bản tin ra màn hình
python -m agents.sales_director --run                        # đẩy việc mới + quét SLA/leo thang (15 phút/lần khi có lịch)
python -m agents.sales_director --bulletin                   # bản tin hôm qua → data/reports/sales-director-day-<ngày>.md
python -m agents.sales_director --bulletin --period week     # bản tin tuần ISO trước
python -m pipelines.approval_queue --pending --block sales   # GĐ xem hàng chờ khối KD
python -m pipelines.approval_queue --approve <ID> --by "<tên GĐ bán hàng>"
```

Loại việc (cấu hình `data/directors/sales.json` — BẢN DEV, chờ GĐ KD/TGĐ
duyệt):

| Loại | Nhãn | Lớp | Rủi ro | Người nhận → leo thang |
|---|---|---|---|---|
| `cskh_handoff` | Câu hỏi chatbot chưa trả lời (chuyển người) | A | medium | Quản lý MXH (`mxh`) → GĐ bán hàng + cảnh báo đỏ |
| `cskh_reply` | Trả lời CSKH cần duyệt | A | medium | `mxh` → GĐ bán hàng + cảnh báo đỏ |
| `market_alert_s1` | Xử lý cảnh báo sàn S1 | A | high | `mxh` → GĐ bán hàng + cảnh báo đỏ |
| `market_alert_s2` | Xử lý cảnh báo sàn S2 | B | medium | GĐ bán hàng → TGĐ |
| `price_review` | Phiếu lệch giá golden chờ duyệt | B | high | GĐ bán hàng → TGĐ |
| `price_change` / `listing_change` / `b2b_quote` / `affiliate_program` | Đổi giá / đổi listing / báo giá B2B / affiliate | B | high | GĐ bán hàng → TGĐ |
| `message_template` | Mẫu tin nhắn | B | medium | GĐ bán hàng → TGĐ |

- **SLA giờ làm việc**: lớp A = 2 giờ, lớp B = 4 giờ (khóa theo WP07). Ca
  ship là GIẢ ĐỊNH 08:00–18:00 thứ Hai–thứ Sáu, chưa có ngày lễ: ngoài ca
  đồng hồ SLA dừng, chạy lại từ đầu ca kế tiếp (tạo thứ Sáu 17:59 → hạn
  thứ Hai 09:59). Sửa ca/ngày lễ ở khóa `business_hours` của
  `sales.json` (`start`/`end` "HH:MM", `workdays` 0 = thứ Hai, `holidays`
  "YYYY-MM-DD") rồi chạy `python -m agents.sales_director --run --dry-run`
  để kiểm — cấu hình sai thì exit 1 kèm lý do.
- **Leo thang**: quá SLA → 1 dòng `sla_escalations` (mỗi mục 1 lần). Lớp A
  kèm cảnh báo đỏ (`red_alerts` — hôm nay chưa có người nhận độc lập,
  xem 4b): S1 mỗi mục 1 cảnh báo; câu hỏi CSKH gom 1 cảnh báo/lần quét kèm
  danh sách mã mục (khách spam không làm ngập kênh cảnh báo đỏ). Lớp B vào
  mục "Leo thang TGĐ" của bản tin. Mục hết hạn tuyệt đối mà chưa leo thang
  (lễ/Tết, cron dừng, hoặc bị expire bởi lệnh khác) vẫn được leo thang với
  lý do "Hết hạn tuyệt đối chưa ai xử lý" (trong 7 ngày). Lead `new` quá 8
  giờ làm việc chỉ được nhắc trong bản tin (không thành mục duyệt).
- **Nguồn**: cảnh báo sàn đóng rồi mở lại (bán lại listing) = mục MỚI, SLA
  mới. Câu chatbot chưa trả lời gom theo khách/ngày: đang có mục chờ thì
  tin mới dồn vào mục đó; mục đã quyết (duyệt/từ chối/hết hạn) mà khách
  hỏi tiếp → mục MỚI, SLA mới. Mỗi lần chạy đẩy tối
  đa `sources.max_cskh_per_run` mục CSKH mới, phần vượt chờ lần sau (bản
  tin có dòng đếm).
- **Hạn tuyệt đối** (`sla_hours`, ≥ 64–66 giờ đồng hồ để luôn kịp leo thang)
  hết → `expired`, KHÔNG BAO GIỜ tự duyệt; việc phải đẩy lại từ đầu. Cảnh
  báo S1 luôn rủi ro high — không vào lane tự duyệt kể cả khi có luật ký.
- Mục trong hàng chỉ chứa mã/loại/kênh/giờ (không câu hỏi khách, không tên
  listing): người duyệt mở tab "Chưa trả lời", file sàn hoặc phiếu golden
  theo mã trong mục. Bản tin chỉ có số đếm + `#id` — không SĐT/email/tên.
- External-dep: người duyệt thật + người trực handoff A + tuyến dự phòng
  (TGĐ chốt — `approvers` rỗng); ca làm việc + lịch lễ/Tết thật; kênh gửi
  bản tin/nhắc (Zalo/email — hôm nay chỉ ghi file + bảng); người nhận cảnh
  báo đỏ độc lập; bảng vùng–đại lý thật (từ khóa tỉnh trong `regions` là
  GIẢ ĐỊNH); lịch cron (chưa đưa vào `EXPECTED_JOBS` của bản tin sức khỏe).

### Sinh ảnh nháp (MKT-03, v6.2)

Chuẩn bị: packshot THẬT do công ty cấp đặt tại
`<PACKSHOT_DIR>/<sku_key>.png` (PNG nền trong suốt; mặc định
`data/packshots/`, gitignored) — ví dụ `data/packshots/mat-ong-sam-300ml.png`.
Ảnh mẫu "MẪU" chỉ dùng cho test, không đăng.

```
python -m pipelines.image_studio --sku mat-ong-sam-300ml --channel facebook --format 1:1 --headline "Quà tặng từ núi rừng"
python -m pipelines.image_studio --sku all --channel facebook --channel shopee --format 1:1 --format 9:16 --headline "..."
```

- Mỗi dòng in 1 ảnh (SKU × kênh × format): `created #id <sha>.png` (nháp
  mới, `content_type=image`, `pending`; cùng 1 ảnh cho 2 kênh, cho 2 SKU
  có packshot y hệt, hay 2 format cùng cỡ = 2 nháp riêng, chung file
  `<sha>.png`), `skipped <sha>.png` (ảnh y hệt đã có nháp CÙNG SKU + kênh
  + format — chạy lại không nhân đôi; kể cả nháp đó đã bị reject: muốn sinh
  lại thì đổi headline/`--scene` để ra ảnh mới; kèm "nháp mồ côi #id" nếu
  2 lần chạy song song cùng mục → người **reject** nháp đó),
  `refused <code>: <lý do>`
  (không gọi provider, không ghi file/DB), `failed: <lý do>` (lỗi ghi
  file/DB — chạy lại được).
- Mã từ chối: `ruou` (rượu — cấm mọi kênh), `maket_xnqc` (MỌI SKU TPBVSK —
  creative TPBVSK phải dùng maket XNQC), `readiness` (SKU chưa đủ điều kiện
  kênh: cần tự công bố đã xác minh / XNQC + kênh trong allowed_channels),
  `kenh_la`/`format_la`/`sku_la`, `headline` (chữ trên ảnh vi phạm
  guardrail / dài quá), `prompt_cam` (mô tả nền `--scene` có người/y tế/chữ/
  nhãn/logo/bao bì/sức khỏe), `font` (thiếu font tiếng Việt),
  `packshot_thieu`/`packshot_loi` (thiếu/hỏng ảnh sản phẩm),
  `packshot_lech` (vùng sản phẩm bị vẽ đè — ảnh bị loại), `provider`,
  `config`.
- Exit 0 = không có `failed`; 1 = có `failed`; 2 = sai tham số,
  `IMAGE_PROVIDER` chưa cắm (chỉ `none`), hoặc DB không kết nối được (kiểm
  TRƯỚC khi dựng ảnh).
- Nháp vào tab **Duyệt & Lịch** (text = chữ trên ảnh + tên file `<sha>.png`
  → sha bản duyệt ràng cả ảnh). Sau khi duyệt, NGƯỜI tải ảnh
  `data/image_assets/<sha>.png` (hoặc `IMAGE_OUT_DIR`) lên kênh tay — agent
  KHÔNG đăng. Sidecar `<sha>.json` cạnh ảnh ghi model/prompt/ngày/sha
  packshot đã thu nhỏ (mô tả FILE, không chứa SKU/kênh/format/sha file
  packshot gốc — các thứ đó ở nháp/bảng `image_assets` từng dòng; `meta`
  của mọi dòng cùng ảnh == sidecar).
- Golden hiện tại: 0 SKU đủ điều kiện sinh ảnh thật (8 TPBVSK cần maket
  XNQC, 3 mật ong chưa xác minh tự công bố, 2 rượu cấm) — lệnh chạy ra toàn
  `refused` là ĐÚNG cho tới khi Pháp chế/Sản xuất cập nhật golden.

### Dựng video nháp (MKT-04, v6.3)

Chuẩn bị: packshot THẬT `<PACKSHOT_DIR>/<sku_key>.png` (như ảnh MKT-03);
B-roll ảnh tĩnh công ty cấp (.png/.jpg — vùng trồng, núi rừng, làm quà) đặt
trong `<BROLL_DIR>` (mặc định `data/broll/`, gitignored) kèm
`licenses.json` dạng `{"ten_file.jpg": "nguồn/giấy phép"}` — ảnh không có
license bị bỏ qua (cảnh B-roll dùng khung packshot); clip video chưa hỗ
trợ. ffmpeg lấy từ gói `imageio-ffmpeg` (requirements) hoặc env
`FFMPEG_BIN`. B-roll/packshot "MẪU" chỉ dùng cho test, không đăng.

```
python -m pipelines.video_studio --sku mat-ong-sam-300ml --channel tiktok --format 9:16 --brief "Quà tặng từ núi rừng Quảng Nam"
python -m pipelines.video_studio --sku all --channel tiktok --channel facebook --brief "..."
```

- Mỗi dòng in 1 video (SKU × kênh × format): `created #id <sha>.mp4` (nháp
  mới `content_type=video`, `pending`), `skipped <sha>.mp4` (video y hệt đã
  có nháp cùng SKU + kênh + format; kèm "nháp mồ côi #id" nếu 2 lần chạy
  song song → người **reject** nháp đó), `refused <code>: <lý do>` (không
  ghi file/DB), `failed: <lý do>` (lỗi LLM/ffmpeg/ghi file/DB — chạy lại
  được).
- Mã từ chối: `ruou`, `maket_xnqc` (MỌI SKU TPBVSK — cần maket/kịch bản
  XNQC), `readiness`, `kenh_la`/`format_la`/`sku_la`, `brief_cam` (brief
  có bác sĩ/chuyên gia/sức khỏe/từ cấm/dài), `tts` (TTS_PROVIDER chưa cắm),
  `packshot_thieu`/`packshot_loi`, `kich_ban` (kịch bản AI vi phạm sau 1
  lượt sửa / sai mẫu / còn < 3 cảnh), `ffmpeg_thieu`, `headline`/`font`
  (phụ đề không vẽ được), `packshot_lech` (khung sản phẩm bị sửa — video bị
  loại), `nhan_ai` (nhãn AI không hiện trên khung), `config`.
- Exit 0 = không có `failed`; 1 = có `failed`; 2 = sai tham số,
  `TTS_PROVIDER`/`IMAGE_PROVIDER` chưa cắm, thiếu ffmpeg, hoặc DB không kết
  nối được (kiểm TRƯỚC mọi lời gọi LLM).
- Nháp vào tab **Duyệt & Lịch** (text = phụ đề + nhãn + tên file
  `<sha>.mp4`). Sau khi duyệt, NGƯỜI tải video
  `data/video_assets/<sha>.mp4` (hoặc `VIDEO_OUT_DIR`) lên kênh tay — agent
  KHÔNG đăng. Sidecar `<sha>.json` ghi model/prompt version kịch bản, nguồn +
  license từng cảnh, sha khung, TTS, kết quả kiểm nhãn khung trích.
- Golden hiện tại: 0 SKU đủ điều kiện (8 TPBVSK `maket_xnqc`, 2 rượu
  `ruou`, 3 mật ong `readiness`) — chạy ra toàn `refused` là ĐÚNG, không tốn
  lời gọi LLM.

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

## 5a. CSKH đa kênh — Messenger, gợi ý sàn, handoff (v5.1)

Lớp kênh chung `connectors/channels.py` (KD-A1) áp CÙNG luật cho Zalo,
Messenger, Shopee, TikTok, chạy TRƯỚC LLM:

- Câu hỏi về **rượu** → template cố định (`data/channels.json`), không
  mời mua online, không gọi LLM — 100% mọi kênh.
- Câu hỏi **sức khỏe** → template "hỏi ý kiến bác sĩ" + chuyển người,
  không gọi LLM.
- Kênh **sàn**: câu trả lời KHÔNG được chứa domain, link, SĐT/hotline,
  Zalo/Facebook, địa chỉ cửa hàng (chính sách sàn) — vi phạm thì thay CẢ
  câu bằng câu cố định "phản hồi trong khung chat này".
- Mọi câu khách thấy (template, câu chào + link chính sách) là **NHÁP chờ
  Pháp chế** trong `data/channels.json` — đổi chữ sửa JSON, không sửa code.

**Messenger (Fanpage) — chưa mở cho khách thật** (cần Meta app review +
page token + webhook HTTPS public + DPIA/TIA ký — external-dep):

```
python -m connectors.messenger   # webhook :8789/messenger-webhook (MESSENGER_WEBHOOK_PORT)
```

- Verify webhook: Meta gọi GET `hub.mode=subscribe` + `hub.verify_token`
  (= `MESSENGER_VERIFY_TOKEN`) → trả `hub.challenge`. Token sai/trống → 403.
- Mọi POST phải có chữ ký `X-Hub-Signature-256` khớp `MESSENGER_APP_SECRET`
  — sai/thiếu → 403, không xử lý (KHÔNG có bypass dev).
- `DEPLOY` tắt → KHÔNG gửi gì ra Meta (log `[dry-run] messenger`). `DEPLOY`
  bật mà thiếu `MESSENGER_APP_SECRET`/`MESSENGER_PAGE_TOKEN`/
  `MESSENGER_VERIFY_TOKEN`/`CHANNEL_HASH_SALT` → từ chối serve (exit 1).
- Messenger dùng CHUNG pipeline Zalo (history, convlog `_uhash`+mask,
  dedup `data/zalo_seen.db` khóa `msgr:`).

**Gợi ý trả lời chat sàn (MXH dán tay — không gọi API sàn):**

```
echo "<tin buyer>" | python -m connectors.channels --suggest shopee --by "<tên MXH>"
```

- Tin buyer đưa qua STDIN (không gõ vào dòng lệnh — lộ lịch sử shell).
- Output là `[GỢI Ý — NHÁP ...]`: MXH ĐỌC/SỬA rồi mới dán trên Seller
  Center. Dòng `handoff=` = câu cần người trả lời (rượu/sức khỏe/thiếu dữ
  liệu); `blocked=` = câu LLM bị chặn vì vi phạm chính sách sàn.
- Không ghi DB, không tạo mục handoff (MXH đang trực tiếp trong chat).

**Đồng ý tư vấn chat (Zalo/Messenger):** tin đầu của khách mới nhận câu
chào + link chính sách (ghi `prompted` vào `chat_consents` — chỉ khi
gửi được); CHỈ khi khách nhắn "Đồng ý" tường minh mới ghi `granted`.
Câu rút ngắn ("Không đồng ý", "ko đồng ý", "rút đồng ý"...) → `withdrawn`
+ xóa ngữ cảnh hội thoại + DỪNG LLM cho khách đó, bất kể cờ, tới khi khách
nhắn lại "Đồng ý" — CHỈ KHI ghi được dòng `withdrawn`. Thiếu
`CHANNEL_HASH_SALT` hoặc DB down lúc khách rút → khách nhận câu "chưa ghi
nhận được, vui lòng gọi hotline" (không hứa dừng) và tin sau vẫn tới LLM
khi cờ tắt: hotline phải ghi nhận tay; Zalo DEPLOY nên có muối. Cờ `require_consent_for_llm` (mặc định `false`
— Pháp chế quyết) bật = chưa đồng ý thì chỉ gửi câu chào, không gọi LLM.
Thiếu `CHANNEL_HASH_SALT` → không ghi đồng ý/handoff (cảnh báo `[warn]`).

**Xử lý handoff `cskh_handoff` (Quản lý MXH / GĐ bán hàng, SLA 2 giờ):**

```
python -m pipelines.approval_queue --pending --block sales
python -m pipelines.approval_queue --approve ID --by "<tên>"   # đã liên hệ/xử lý xong
python -m pipelines.approval_queue --reject ID --by "<tên>"    # không cần xử lý
```

Payload mục chỉ có kênh, mã lý do (`san_pham_han_che` = câu về rượu,
`suc_khoe`, `thieu_du_lieu`, `kiem_duyet`), `user_hash` có muối, mã tin,
giờ — KHÔNG có nội dung tin/SĐT. Tìm hội thoại trong hộp thư Zalo OA /
Fanpage theo kênh + giờ `ts` (convlog dùng `_uhash` không muối, KHÁC
`user_hash` trong mục — chưa nối, someday). Mỗi khách chỉ 1 mục chờ (tin
sau không nhân đôi).

**Eval A1:** `python scripts/agent_eval.py --agent kd_a1 --no-record`
(tất định, gateway giả, 43 ca); lần thật nhỏ `python -m connectors.channels
--eval-real --limit 8` (gọi LLM thật, trần 0,05 USD).

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

## 5e. Cảnh báo đỏ + bản tin thị trường (intel — v7.1)

**Làm gì:** đọc tin đã thu ở mục 5d (`intel_items`) để (1) ghi CẢNH BÁO ĐỎ
khi tin khớp luật — thương hiệu Sâm Sâm/"sâm Ngọc Linh" bị nhắc tiêu cực
(giả mạo, thu hồi, ngộ độc, xử phạt...), quy định mới về TPBVSK/quảng
cáo/rượu, đối thủ bị xử phạt; (2) soạn bản tin ngày/tuần BẢN NHÁP. Hệ
thống KHÔNG gửi ai, KHÔNG liên hệ ai ngoài hệ thống, KHÔNG đăng gì.

```
python -m crawler.intel --run                        # thu tin (mục 5d)
python -m pipelines.intel_alert --run                # quét luật + leo thang
python -m pipelines.intel_alert --open               # cảnh báo chưa xác nhận
python -m pipelines.intel_alert --ack <ID> --by "<họ tên>" [--note ".."]
python scripts/intel_bulletin.py --period day        # bản tin ngày
python scripts/intel_bulletin.py --period week --suggest   # bản tin tuần + gợi ý chủ đề
```

- **Lịch chạy đề xuất** (cron/systemd trên máy chủ = external-dep):
  `crawler.intel --run` mỗi 60 phút 07:00–22:00 (mở mạng tới nguồn
  ngoài); `pipelines.intel_alert --run` mỗi 30 phút SUỐT 24/7 (chỉ
  đọc/ghi DB, không mở mạng, rẻ) — leo thang 2 giờ chỉ chạy bên trong
  `--run`, nên nếu gói `--run` vào khung ban ngày thì cảnh báo phát sinh
  sau ~20:00 phải chờ tới 07:00 hôm sau mới leo thang (trễ 9–11 giờ, vỡ
  tiêu chí WP09 "leo thang 2h"); `intel_bulletin.py --period day` 06:00
  hằng ngày; `--period week` sáng thứ Hai. Người TRỰC nhận bản leo thang
  ban đêm (chuỗi trực MXH → Pháp chế) = external-dep.
- **Luật cảnh báo** ở `data/intel_alert_rules.json` — `status: "gia_dinh"`
  (GIẢ ĐỊNH) tới khi Pháp chế/Quản lý MXH duyệt bộ từ khóa (đổi status là
  việc người thật). File hỏng/thiếu nhóm → exit 1, KHÔNG quét.
- **Leo thang**: cảnh báo gốc quá 2 giờ chưa ai `--ack` → 1 cảnh báo leo
  thang nhãn "CHƯA XÁC NHẬN" (1 cấp, không lặp). Xác nhận đúng id GỐC (id
  bản leo thang bị từ chối, kèm id gốc). Xác nhận ghi bảng
  `red_alert_acks` (không sửa/xóa được).
- **Người nhận**: dùng chung `data/red_alert_routing.json` (v4.0 — chỉ
  Pháp chế/BKS; TGĐ/Quản lý hạ tầng luôn bị loại). Đang rỗng → `--run` in
  `[RED-ALERT][warn] ... thiếu người nhận độc lập` + exit 1 (fail-closed —
  cảnh báo vẫn ghi bảng). Chuỗi trực MXH → Pháp chế → TGĐ = external-dep.
- **Bản tin** → `data/reports/intel-bulletin-<day|week>-<ngày>.md`: 5 chủ
  đề, khối "NỘI BỘ – trích nguồn, KHÔNG dùng làm nội dung" (tiêu đề +
  link báo gốc — KHÔNG chép vào bài đăng), cảnh báo đỏ đang mở, nguồn
  lỗi/robots chặn. `--llm` chỉ tóm tắt khi `llm.enabled = true` trong
  `data/intel_sources.json` (mặc định tắt — chờ Pháp chế); tóm tắt vi phạm
  guardrail bị loại, ghi "[đã loại ...]".
- **Gợi ý chủ đề** (`--suggest`): mỗi chủ đề có ≥2 tin → 1 gợi ý mẫu
  (không trích tin, không tên/giá SKU) vào hàng duyệt chung loại
  `intel_topic` (rủi ro medium — không bao giờ tự duyệt). Quản lý MXH duyệt
  bằng `python -m pipelines.approval_queue --pending --block intel` rồi
  `--approve/--reject ID --by "<tên>"`. Gợi ý KHÔNG phải bản nháp nội dung.

## 5f. Đối thủ / Trend / MXH (v7.2, chỉ nhập tay)

**Làm gì:** Quản lý MXH đưa 3 loại file XUẤT/GHI TAY vào DB, rồi đọc báo
cáo tuần. Agent KHÔNG cào sàn (Shopee/TikTok/Lazada — vẫn chặn cứng như
v7.0), KHÔNG dùng thư viện/API Google Trends không chính thức (cấm
pytrends), KHÔNG trả lời comment/inbox (đó là A1), không đăng, không gửi ai.

```
python -m ingest.intel_import --competitor doi_thu_tuan41.csv
python -m ingest.intel_import --trend multiTimeline.csv
python -m ingest.intel_import --trend relatedQueries.csv --seed "nhân sâm"
python -m ingest.intel_import --social fanpage_export.csv --channel fanpage
python scripts/intel_weekly.py --week 2026-10-08     # mặc định: tuần đủ gần nhất
```

- **Template cột (GIẢ ĐỊNH — chưa xác minh với file thật):**
  - Đối thủ (CSV/XLSX, 1 dòng = 1 lần ghi): bắt buộc `doi_thu, kenh,
    ten_san_pham, gia_vnd, ngay_ghi, nguon`; tùy chọn `sku_tuong_duong,
    gia_km_vnd, khuyen_mai, rating, so_danh_gia, ghi_chu`. `kenh` ∈
    shopee/tiktok/lazada/tiki/web/khac; `ngay_ghi` dạng 2026-10-08; `nguon`
    = link trang hoặc "ảnh chụp <tên file>" (kênh sàn bắt buộc 1 trong 2);
    `sku_tuong_duong` phải có trong golden (`sku_master`), sai → không nạp gì.
  - Google Trends: xuất tay từ trends.google.com, chuỗi TUẦN (khoảng 1–5
    năm), ≤5 từ khóa/file, LUÔN kèm từ khóa neo "quà tết"; mọi từ khóa phải
    có trong `data/trend_keywords.json` (MKT/SEO chốt). File relatedQueries
    cần `--seed`. Truy vấn nhắc rượu được gắn cờ — không dùng cho nhóm giới trẻ.
  - Comment/inbox kênh sở hữu: bắt buộc `thoi_gian, noi_dung`; tùy chọn
    `loai` (comment/inbox/review), `ma_tin`; cột `id_nguoi_dung,
    ten_nguoi_dung, sdt, email, link_profile, avatar` bị BỎ ngay khi đọc;
    cột khác → lỗi (có thể là dữ liệu cá nhân).
- **Kiểm trước, nạp sau:** file lỗi → `[err] dòng N: cột '...'` (không in
  giá trị ô), exit 1, KHÔNG ghi gì. Nạp lại đúng file đó → `[skip]`.
- **Social — dữ liệu cá nhân:** SĐT/email trong nội dung bị che NGAY khi
  đọc; DB chỉ giữ nhãn (khen/che/hoi_gia/hoi_suc_khoe/hoi_ruou/khieu_nai/khac)
  + hash có muối. Cần `INTEL_HASH_SALT` trong `.env` (≥16 ký tự, Quản lý hạ
  tầng AI sinh và giữ cố định). Trích nội dung (`excerpt`) CHỈ lưu khi
  `"dpia_signed": true` trong `data/social_rules.json` — người đổi cờ là
  người thật SAU khi Pháp chế ký DPIA; tin hỏi sức khỏe không bao giờ lưu trích.
- **Báo cáo tuần** 4 mục: đối thủ lệch giá golden (mỗi số kèm `obs#`/nguồn
  và `price_list#`/đã duyệt hay chưa — không có "giá nên đặt"), trend +
  tăng đột biến (so trung vị 8 tuần trước), social chỉ ĐẾM theo nhãn, tin
  `intel_items` mới theo chủ đề. `--llm` chỉ chạy khi `llm.enabled = true`
  trong `data/intel_sources.json` (chờ Pháp chế), không gửi mục social, tóm
  tắt phải qua guardrail.

## 5g. CRM lead & đại lý (v5.2 — `python -m ingest.crm`)

Người chạy: Sales-admin / GĐ bán hàng. Agent KHÔNG tự liên hệ khách hay
đại lý — module không gửi gì ra ngoài; mọi lệnh ghi cần `--by "<tên
người>"` và để lại 1 dòng `agent_action_log` (không chứa PII).

**Khóa mã hóa (làm 1 lần, người phụ trách hạ tầng):**

```
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Dán giá trị vào `.env` dòng `CONTACT_VAULT_KEY=...` — KHÔNG commit, không
gửi qua chat. **Backup khóa TÁCH khỏi backup DB** (két/password manager
của công ty): mất khóa = mất toàn bộ SĐT/tên/email/địa chỉ trong
`contacts` (không khôi phục được); lộ khóa + lộ backup DB = lộ PII. Thiếu
hoặc sai khóa → lệnh cần khóa dừng `[err]` exit 2, không ghi gì. Khóa thật
do công ty giữ = external-dep (hiện chỉ có khóa test).

**Lệnh hằng ngày:**

```
python -m ingest.crm --load-dealers --by "<tên>"          # nạp đại lý MẪU từ data/dealer_regions.json (dòng manual không bị đè)
python -m ingest.crm --add-contact - --lead 12 --by "<tên>"   # dán JSON vào stdin, Ctrl+Z Enter (Windows) / Ctrl+D
python -m ingest.crm --consent 5 --purpose dai_ly --grant --source form_giay --evidence BB-2026-001 --policy-version v1 --dealer DLM01 --by "<tên>"
python -m ingest.crm --consent 5 --purpose marketing --withdraw --source dien_thoai --by "<tên>"
python -m ingest.crm --assign 12 --dealer DLM01 --by "<tên>" [--province "Quảng Nam"]
python -m ingest.crm --status 12 qualified --by "<tên>"
python -m ingest.crm --report
python -m ingest.crm --handoff 12 --dealer DLM01 --by "<tên>"
```

- **Thêm liên hệ:** JSON `{"phone": "...", "name": "...", "email": "...",
  "address": "...", "province": "...", "source": "manual"}` gõ/dán qua
  stdin (`-`). KHÔNG gõ SĐT/tên trên dòng lệnh (lộ lịch sử shell), KHÔNG
  lưu file JSON liên hệ trong repo (lệnh từ chối file nằm trong repo).
  SĐT trùng (so bằng HMAC) → trả contact cũ, không ghi đè.
- **Đồng ý:** mỗi lần ghi/rút là 1 dòng mới (không sửa/xóa được). Ghi đồng
  ý cần mã biên bản/scan (`--evidence`, KHÔNG phải SĐT/email) + phiên
  bản nội dung đồng ý (`--policy-version` — nội dung do Pháp chế duyệt,
  external-dep). Rút đồng ý không cần evidence. `dai_ly` phải ghi ĐÍCH
  DANH đại lý nhận (`--dealer`). Chưa có đồng ý = KHÔNG liên hệ
  marketing / KHÔNG chuyển PII cho đại lý.
- **Gán đại lý:** tỉnh suy từ câu hỏi lead (34 tỉnh sau sáp nhập, nhận cả
  tên cũ — bảng `data/vn_provinces_2025.json` là GIẢ ĐỊNH chưa đối chiếu
  văn bản chính thức); không suy được → truyền `--province`. Đại lý phải
  active và phụ trách vùng của tỉnh. Lead đã gán đại lý khác → từ chối
  (tranh chấp do GĐ bán hàng quyết, không gán đè).
- **Report:** không cần khóa, không in PII — lead theo tỉnh/đại lý/trạng
  thái + lead chưa gán kèm đại lý gợi ý theo vùng.
- **Handoff:** in JSON để NGƯỜI tự chuyển cho đại lý (hệ thống không
  gửi). Có SĐT/tên CHỈ khi khách đồng ý `dai_ly` đích danh đại lý đó và
  chưa rút; ngược lại payload chỉ có tỉnh/intent/câu hỏi đã che. Đại lý
  ký cam kết xử lý dữ liệu trước khi nhận PII (kiểm tay — chưa có trong
  code).
- Hoa hồng: `commission_default` của đại lý cho TPBVSK/thực phẩm; rượu
  bán online luôn 0.
- Exit: 0 ok · 1 DB không truy cập được / thiếu bảng (chạy
  `python scripts/apply_schema.py`) / vi phạm nghiệp vụ · 2 sai cú pháp,
  thiếu `--by`, thiếu/sai khóa.
## 5h. Sản xuất P1 — tồn, phân bổ, BOM, lô (v9.2)

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

## 5i. Lô + QR truy xuất (v9.4 — thí điểm mật ong)

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
## 5j. Kế toán (v9.0) — đối soát sàn, lô hóa đơn nháp, công nợ đại lý

**Làm gì:** 3 agent kế toán tất định (không LLM, không gọi mạng, không gửi
gì ra ngoài). Hệ thống chỉ BÁO CÁO và lập NHÁP: không bút toán, không ghi
sổ MISA, không phát hành hóa đơn, không lệnh chi, không thư nhắc nợ.

**Đối soát quyết toán sàn (ACC-Recon).** Kế toán xuất TAY file quyết toán
(income/settlement) từ Seller Center rồi nạp; nạp file đơn sàn trước (mục
5b, `--kind order`) — nếu file đơn tới sau thì nạp xong chạy `--reconcile`.

```
python -m ingest.settlement_csv --file <file quyết toán .csv/.xlsx> --channel shopee
python -m ingest.settlement_csv --reconcile
python -m ingest.settlement_csv --report
```

- Mỗi dòng đúng 1 nhãn: `khop` / `lech` (kèm lý do `thuc_nhan`,
  `phi_co_dinh`, `phi_thanh_toan`, `phi_dich_vu`, `gia_tri_don`) /
  `thieu_chung_tu` (chưa thấy đơn sàn) / `hoan` (có hoàn tiền).
- File lỗi (thiếu cột, cột lạ, ô tiền sai, mã đơn trùng) → exit 1, không
  nạp gì; lỗi chỉ nêu số dòng + tên cột. Nạp lại cùng file → `[skip]`.
- `--report` trỏ dòng bằng `tên file dòng N` — mở file gốc để xem; không
  in mã đơn / thông tin người mua.

**Lô hóa đơn NHÁP (ACC-Invoice).** Mỗi ngày gom đơn đạt mốc lập hóa đơn
thành 1 lô vào hàng duyệt chung (`invoice_batch`, khối `finance`).

```
python -m agents.acc_invoice --batch --day 2026-10-12
python -m agents.acc_invoice --batch --yeu-cau <file yêu cầu xuất HĐ> --channel shopee
python -m pipelines.approval_queue --pending --block finance
python -m pipelines.approval_queue --approve <id> --by "<người duyệt>"
python -m agents.acc_invoice --verify-draft <id> --file data/reports/hoa-don-nhap/lo-<batch_key>.csv
```

- File nháp `data/reports/hoa-don-nhap/lo-<batch_key>.csv` chứa tên/MST/
  địa chỉ/email người mua (chỉ đơn có yêu cầu xuất HĐ) — thư mục gitignored,
  KHÔNG gửi qua chat/email; hàng duyệt chỉ có hash rút gọn + số tiền.
- Trước khi nhập tay vào phần mềm HĐĐT: `--verify-draft` PHẢI in `[ok]`
  (lô đã duyệt + file đúng bản đã duyệt). `[fail]` → không nhập.
- Đã có lô chờ duyệt trong ngày → `[skip]`; lô bị từ chối → chạy lại sẽ
  gom lại các đơn đó (lô mới, "Lần lập 2"). Đơn đã thuộc lô duyệt mà trả
  hàng → dòng `dieu_chinh` ở lô sau, ghi lô gốc. Cột người mua của dòng
  điều chỉnh ghi "THEO HĐ GỐC lô …" (gốc là HĐ doanh nghiệp → thêm "gốc
  cần MST"): lấy tên/MST/địa chỉ từ HĐ gốc, KHÔNG dùng "Người mua không
  lấy hóa đơn"; hoặc cấp lại qua `--yeu-cau`. Số tiền điều chỉnh ghi DƯƠNG
  = giá trị giảm (quy ước GIẢ ĐỊNH, chờ mẫu file NCC HĐĐT).

**Công nợ đại lý (ACC-AR).**

```
python -m agents.acc_ar --load <sổ công nợ .csv/.xlsx>
python -m agents.acc_ar --aging --as-of 2026-10-12
python -m agents.acc_ar --commission --from 2026-10-01 --to 2026-10-31
python -m agents.acc_ar --bulletin
```

- File công nợ: header cố định `dealer_code, dealer_type, kind, doc_ref,
  doc_date, due_date, amount_vnd, sku_key, channel` — chỉ MÃ đại lý, không
  tên/SĐT; thanh toán ghi số âm. Nạp lại cùng file → `[skip]`.
- Tuổi nợ 0-30/31-60/61-90/>90 ngày, khoản trả trừ vào nợ cũ nhất trước;
  quá hạn khi qua `due_date` (trống → `term_days` của cấu hình).
- Hoa hồng là BẢN NHÁP — không phải lệnh chi; rượu bán online = 0; cờ
  `thieu_sku` (SKU không có trong golden → 0), `tncn` (hộ kinh doanh/cá
  nhân — kế toán xử lý thuế TNCN).
- `--bulletin` ghi bản tin GĐ tài chính `data/reports/director-finance-
  <ngày>.md` có mục "Công nợ đại lý quá hạn" — người đọc rồi chuyển tay.
  Với khối finance, lệnh này THAY cho `python -m pipelines.director
  --block finance` (cùng file, ghi đè): chạy director (hoặc `--all`) SAU
  `--bulletin` trong cùng ngày sẽ làm MẤT mục nợ quá hạn — nếu lỡ chạy,
  chạy lại `python -m agents.acc_ar --bulletin` (director in `[warn]`).

**GIẢ ĐỊNH (sửa khi có thật):** tên cột `data/settlement_map.json`; biểu
phí `data/settlement_fees.json`; mốc `invoice_trigger` + format CSV
`data/invoice_config.json`; chính sách hoa hồng `data/dealer_commission.json`
(MẪU).

**External-dep (công ty cấp, hệ thống không giả lập):** file quyết toán
thật ≥2 tuần mỗi sàn; biểu phí sàn thật theo ngày hiệu lực; tư vấn thuế chốt
mốc lập hóa đơn (hạn 25/10/2026); nhà cung cấp HĐĐT + mẫu file nhập + chữ
ký số; số dư công nợ thật (MISA) + chính sách hoa hồng đã ký; người duyệt
lô (`data/directors/finance.json` `approvers` đang rỗng); GĐ tài chính ký
biên bản đối soát; hạn lưu + quyền thư mục file nháp hóa đơn.
## 5k. Lịch mùa vụ + điều phối Marketing (v6.0)

**MKT-01 lịch mùa vụ** (không DB, không LLM — chỉ đọc
`data/marketing_calendar.json` + `data/golden_skus.json` +
`data/directors/marketing.json`):

```
python -m pipelines.mkt_calendar --start 2026-10-12 --weeks 4
python -m pipelines.mkt_calendar --start 2026-10-12 --weeks 26 --by month
python -m pipelines.mkt_calendar --start 2026-10-12 --weeks 18 --ics data/reports/mkt-calendar-2026-10-12.ics
```

- Dòng đầu in `status` lịch ("GIẢ ĐỊNH — chờ GĐ Marketing chốt") + "Lịch ĐỀ
  XUẤT — GĐ Marketing duyệt trước khi chạy". Mỗi chiến dịch × kênh ×
  định dạng kèm SKU đủ readiness + 4 mốc giờ VN: brief → nháp → duyệt →
  đăng, LÙI từ ngày đăng (đệm duyệt 24h, nháp 48h, SLA brief 48h từ
  `campaign_brief` trong `marketing.json`), né T7/CN/ngày nghỉ, trong giờ
  8–17. Ngày đăng được rơi cuối tuần (sale sàn T7).
- Tết 2027 lấy từ `pipelines.scenario.tet_date` (không ghi lại ngày Tết
  trong file lịch). Nhắc trước 14/7/3 ngày cho 11.11, 12.12, Tết.
- Rượu KHÔNG BAO GIỜ có ô kênh online (chỉ nằm ở mục "SKU bị chặn kênh").
  TPBVSK chưa XNQC chỉ vào `listing` (mô tả); ads/KOC/livestream/post cần
  `QC_DAY_DU`/`TP_THUONG`. Ô post/livestream không còn SKU → "câu chuyện
  thương hiệu — không nêu tên SKU".
- `.ics` (mặc định `data/reports/`, gitignored) import được vào Google/
  Outlook Calendar — chỉ là lịch nhắc, KHÔNG hẹn đăng bài. `--json` cho
  máy đọc. Exit 1 = lịch/golden/cấu hình hỏng (`[err] ...`); 2 = sai
  tham số.

**MKT-00 điều phối** (tất định, không LLM; không duyệt, không đăng, không
chi tiền):

```
python -m agents.mkt_director --briefs --dry-run
python -m agents.mkt_director --briefs [--today YYYY-MM-DD] [--horizon-days 14]
python -m agents.mkt_director --load --today 2026-11-02 --days 28
python -m agents.mkt_director --bulletin
```

- **Nhịp:** sáng thứ Hai chạy `--briefs` rồi `--bulletin`; trước mùa cao
  điểm chạy thêm `--load`.
- `--briefs`: đẩy "brief chiến dịch" (`campaign_brief`, rủi ro medium, SLA
  48h) có mốc brief trong 14 ngày tới vào hàng duyệt chung — chạy lại
  không đẩy trùng. Mục vào hàng ở `pending`; **GĐ Marketing duyệt**:
  `python -m pipelines.approval_queue --pending --block marketing` rồi
  `python -m pipelines.approval_queue --approve ID --by "<tên GĐ>"` (hoặc
  `--reject ID --by ... --note ...`). Quá SLA → `expired`, không tự duyệt.
  Exit 2 = DB down.
- `--load`: dự báo số mục duyệt/ngày (Pháp chế: 1 mục/ô tại ngày mốc
  duyệt; GĐ Marketing: 1 brief/chiến dịch tại ngày mốc nháp) so với quota
  `data/review_quota.json` + trần GĐ trong file lịch → `VƯỢT QUOTA ...` +
  "ĐỀ XUẤT dời ... — GĐ Marketing quyết". **Lịch không bị dời tự động** —
  GĐ sửa file lịch nếu đồng ý. Quota hỏng → exit 2.
- `--bulletin`: `data/reports/mkt-week-<thứ Hai>.md` — chiến dịch 28 ngày
  tới, việc trễ hạn, tải duyệt 14 ngày vs quota, SKU bị chặn kênh. DB
  down → vẫn sinh, mục trễ hạn ghi "nguồn DB thiếu". BẢN NHÁP — người
  chuyển tay cho GĐ Marketing.
- **External-dep / GIẢ ĐỊNH:** lịch chiến dịch thật (GĐ Marketing chốt rồi
  đổi `status`), mùa thu hoạch thật (GĐ vùng trồng), quota duyệt thật
  (TGĐ), người duyệt thật + SSO (`approvers` đang rỗng), XNQC/channel
  policy per SKU (Pháp chế) — chưa có thì lịch thật ra ít ô kèm SKU.

## 5l. Tài chính–kế hoạch (v9.1) — giá vốn, P&L, ngân sách ads, chi phí vận hành, dòng tiền

**Làm gì:** 5 agent FP&A tất định (không LLM, không gọi mạng, không gửi gì
ra ngoài). Chỉ BÁO CÁO + ĐỀ XUẤT vào hàng duyệt: không lệnh chi, không cài
ngân sách quảng cáo, không bật voucher, không đổi giá, không tắt key. Mọi
file báo cáo là BẢN NHÁP trong `data/reports/` (gitignored) — người đọc rồi
chuyển tay.

**Giá vốn (FP-COGS-PnL) — 2 người khác nhau.** Người lập (GĐ sản xuất) thêm
dòng giá vốn có ngày hiệu lực; người duyệt (GĐ tài chính) duyệt. DB chặn
người duyệt trùng người lập (không phân biệt hoa thường/khoảng trắng). Đổi
giá vốn = thêm dòng mới (bảng append-only), không sửa dòng cũ.

```
python -m agents.fp_pnl --cogs-add --sku savina-12v --cost 50000 --from 2026-10-01 --by "<người lập>"
python -m agents.fp_pnl --cogs-approve <id> --by "<người duyệt khác người lập>"
python -m agents.fp_pnl --cogs-list
python -m agents.fp_pnl --pnl --month 2026-10
```

- `--pnl` ghi `data/reports/pnl-<YYYY-MM>.md`: thực nhận quyết toán sàn
  (mục 5e) phân bổ về SKU × kênh theo dòng đơn, trừ giá vốn ĐÃ duyệt hiệu
  lực tại ngày quyết toán. SKU chưa có giá vốn duyệt → ghi "chưa có giá vốn
  duyệt", KHÔNG điền 0, và bị loại khỏi tổng lãi gộp (dòng "N SKU bị loại").
  Thêm `--channel shopee|tiktok` → file riêng `pnl-<YYYY-MM>-<kênh>.md`, mọi
  số đếm theo đúng kênh; bản toàn kênh để GĐ tài chính ký không bị đè.
- Đơn không thấy trên file đơn sàn → ô "(chưa rõ SKU)" chỉ có thực nhận;
  dòng hoàn vẫn tính giá vốn theo số lượng đơn (GIẢ ĐỊNH thận trọng).

**Đề xuất ngân sách ads (FP-AdsBudget).** Chấm biên gộp P&L tháng tham
chiếu → 1 mục `budget_change` (rủi ro high, khối `finance`) chờ người duyệt.
SKU bị cấm quảng bá (readiness CAM) hoặc TPBVSK chưa XNQC → ngân sách 0.
Sau khi duyệt, Quản lý MXH tự cài trên nền tảng — agent không chi tiền.

```
python -m agents.fp_ads --propose --month 2026-10
python -m pipelines.approval_queue --pending --block finance
python -m pipelines.approval_queue --approve <id> --by "<người duyệt>"
```

**Chi phí vận hành (FP-OpsCost).** Chi phí AI theo agent lấy từ `llm_usage`
(quy VND theo tỷ giá cấu hình) + chi phí cloud/SaaS/ads/khác nạp tay từ CSV
(header `month, category, service, amount_vnd, doc_ref`) → so trần tháng,
cảnh báo 80% và 100%. Khoản > ngưỡng X → mục `opex_over_x` chờ TGĐ ký;
khoản đó chỉ hiện `duoc_chi` khi người có vai trò `tgd` (trong
`data/users.json`) duyệt đúng mục — người vai trò khác duyệt vẫn là
`cho_tgd_ky` (`--status` ghi "đã duyệt bởi vai trò khác — cần TGĐ"; chạy lại
`--submit-over-x` để đẩy mục mới cho TGĐ). Chữ ký gắn với đúng dòng file chi
phí + nội dung khoản (không theo số thứ tự khoản); mục do agent/khối khác tạo
không bao giờ được tính — nếu `--submit-over-x` báo `[chặn]`, người duyệt
reject mục lạ đó rồi chạy lại.

```
python -m agents.fp_opscost --load <file chi phí .csv/.xlsx>
python -m agents.fp_opscost --report --month 2026-10
python -m agents.fp_opscost --submit-over-x --month 2026-10
python -m pipelines.approval_queue --approve <id> --by "<email vai trò tgd>"
python -m agents.fp_opscost --status --month 2026-10
```

**Dòng tiền 13 tuần (FP-Cash).** Dựng trên engine kịch bản chung (mục 5c,
`pipelines.scenario`) → mỗi tuần khoảng thấp/cơ sở/cao; cảnh báo tuần số dư
âm ở kịch bản thấp. Chưa có số dư tiền mặt thật → số dư = dòng tiền ròng lũy
kế từ 0 (`--opening` khi có số thật). DB không kết nối được vẫn chạy với tỷ
lệ thực nhận mặc định (`[warn]`, "chưa xác minh").

```
python -m agents.fp_cash --forecast --start 2026-10-12
python -m agents.fp_cash --forecast --start 2026-10-12 --opening <số dư VND> --json
```

**Bản tin tuần GĐ tài chính (FIN-Director).** Gom công nợ quá hạn (mục 5e)
+ P&L tháng + chi phí vận hành + dòng tiền + số đề xuất ads đang chờ →
`data/reports/director-finance-<ngày>.md`. Cùng tên file với
`python -m agents.acc_ar --bulletin` (bản ngày, chỉ mục công nợ): bản tuần
là SUPERSET — chạy `--weekly` SAU `--bulletin` trong ngày. Mục nào thiếu dữ
liệu ghi "(chưa có dữ liệu: …)", bản tin vẫn ra.

```
python -m agents.fin_director --weekly
python -m agents.fin_director --weekly --as-of 2026-10-12
```

**GIẢ ĐỊNH (sửa khi có thật):** `data/fpa_config.json` (`confirmed_by`
null) — ngưỡng biên gộp tối thiểu + hệ số ngân sách ads, trần chi phí
tháng, ngưỡng X, tỷ giá USD/VND, chi cố định 13 tuần + khoản một lần, độ trễ
tiền sàn về, tỷ lệ giá đại lý, số dư đầu kỳ; kịch bản bán
`data/scenario_assumptions.json`.

**External-dep (công ty cấp, hệ thống không giả lập):** giá vốn thật theo
SKU + GĐ sản xuất lập / GĐ tài chính duyệt (bảng `cogs_versions` trên DB
thật đang trống); hóa đơn cloud/SaaS thật (`tests/fixtures/finance/
opex_MAU.csv` chỉ là MẪU); GĐ tài chính chốt các GIẢ ĐỊNH trên; TGĐ ký khoản
vượt X + danh sách người/vai trò thật (`data/users.json`); người duyệt khối
(`data/directors/finance.json` `approvers` đang rỗng); doanh thu đại lý/B2B
từ MISA cho P&L kênh offline; phiếu phương án voucher/combo của marketing;
management key OpenRouter (`key_usage_master`) cho đối chiếu chi phí key;
Quản lý MXH cài trần ngân sách trên nền tảng ads; GĐ tài chính ký P&L/bản
tin/nghiệm thu WP12.

## 5m. Phòng Dự án (v8.3 — WP11 DA, agent KHÔNG tự nộp/gửi/liên hệ)

**Radar chương trình (DA-03, sáng hằng ngày):**
1. Thu tin: `python -m crawler.intel --run` (chỉ nguồn đã duyệt; nguồn
   `chuong_trinh` ship `cho_duyet` — GĐ dự án/BGĐ duyệt trong
   `data/intel_sources.json`; chạy thử 1 nguồn: `--source <id>`). Radar
   KHÔNG có collector riêng — robots/nhịp ≥1s/chặn tầng C nằm ở collector.
2. `python -m agents.da_radar --scan` → bảng `programs` (bỏ tin rượu, bỏ
   host tầng C; `--dry-run` chỉ đếm).
3. `python -m agents.da_radar --list` → `data/reports/da-radar-<ngày>.md`:
   bảng chương trình + "Nhắc hôm nay" (T-7, T-2, PHÁT HIỆN MUỘN khi còn < 7
   ngày). Hạn chỉ nhận ngày đứng SAU từ khóa hạn ("hạn chế", "giới hạn",
   "thời hạn", "hạn hán"... KHÔNG tính; "từ X đến Y" lấy Y); cột "Trích hạn"
   cho thấy đoạn máy dựa vào — đối chiếu link gốc trước khi chốt; "chưa
   công bố" thì xem link gốc.

**Hồ sơ tham gia (DA-04):**
1. `python -m agents.da_hoso --checklist <program_id> --template hoi_cho|ocop|xuc_tien_tmdt`
   → file NỘI BỘ (checklist giấy tờ + câu hỏi Pháp chế — không gửi ra ngoài).
2. `python -m agents.da_hoso --draft <id> --template T --submit` → nháp
   bản nộp + đẩy hàng duyệt khối `projects` (`program_application`,
   PENDING). Nháp có "CẢNH BÁO" (guardrail/rượu/SKU chưa XNQC/0 sản phẩm)
   → `--submit` bị từ chối exit 1. `--llm` (viết lại thư qua LLM) mặc định
   TẮT.
3. Người duyệt (≠ agent): `python -m pipelines.approval_queue --approve <QID> --by "<tên>"`.
4. `python -m agents.da_hoso --export <QID> --out <file>` (chỉ mục đã duyệt
   khớp sha256).
5. Trước khi nộp: `python -m agents.da_hoso --verify-submit <QID> <file>`
   → exit 0 "KHỚP bản đã duyệt — GĐ dự án tự nộp". Exit 1 **"LỆCH bản
   duyệt"** = file đã bị sửa (kể cả 1 ký tự, xuống dòng, khoảng trắng,
   lưu lại bằng Word/BOM) → KHÔNG nộp; soạn lại (`--draft --submit`) và
   duyệt lại.

**Tổ chức mua quà Tết (DA-05):**
1. CSV nhập tay đúng header `org_name,org_type,region,website,source_url,fit_reason`
   — CHỈ thông tin TỔ CHỨC công khai. CẤM nhập SĐT/email/tên người/địa chỉ
   (file bị từ chối cả file); không dùng link Facebook/Zalo/TikTok/sàn.
   Ô có từ guardrail chặn (từ cấm như "thuốc", "chữa", "ung thư" — xem
   `data/banned_words.txt` — hoặc nhóm rượu) cũng bị từ chối: lô chứa ô đó
   không duyệt được → ghi khác. `data/intel_sources.json` hỏng → từ chối
   cả file (không kiểm được nguồn tầng C).
2. `python -m agents.da_b2b --import <file.csv> --by "<tên>"` (lỗi → exit
   1, 0 dòng nạp; in số dòng + cột, không in giá trị).
3. `python -m agents.da_b2b --submit-batch` → 1 lô PENDING
   (`org_prospect_batch`); GĐ dự án/GĐ bán hàng duyệt qua
   `pipelines.approval_queue`.
4. `python -m agents.da_b2b --handover <QID> --by "<tên>"` → dòng
   `chuyen_sales` (chỉ khi đã duyệt + khớp sha256; lô bị từ chối HOẶC hết
   hạn SLA `expired` → dòng về `moi`, chạy lại `--submit-batch` lập lô mới).
   Exit 1 "LỆCH bản đã duyệt" = dữ liệu tổ chức bị sửa thẳng DB sau khi
   duyệt (chỉ chủ sở hữu DSN làm được) → KHÔNG chuyển, dòng giữ
   `cho_duyet` làm dấu vết; người quản trị DB điều tra, xong thì đặt lại
   các dòng của lô về `moi` (`batch_queue_id` null) để lập lô mới và duyệt
   lại. Hệ thống KHÔNG tự liên hệ — GĐ bán hàng/đại lý liên hệ; kiểm tay
   20 mẫu/lô (tên người trong lý do không bắt được bằng máy).

**PMO thứ Hai (DA-01):** `python -m agents.da_pmo --board --submit`
(bảng tuần, mốc trễ tô **TRỄ**; `--seed` lần đầu từ
`data/projects/milestones.json`). Đổi trạng thái: `--set-status <MÃ>
--status xong --evidence <link> --by "<tên>"` (xong thiếu evidence → exit
1). Đổi hạn: `--propose-due <MÃ> --due YYYY-MM-DD --by` → duyệt →
`--apply-due <QID> --by` (hạn đã bị đổi khác → exit 1, đề xuất lại;
người đề xuất KHÔNG tự duyệt được — cần người khác). `--submit` từ chối
(exit 1) khi bảng trượt guardrail (title/gate/evidence có từ cấm/nhóm rượu
— sửa chữ rồi chạy lại).

**CR (DA-02):** `python -m agents.da_cr --cr "<yêu cầu>" --submit` →
nháp CR (GỢI Ý trong_sow/can_cr/chua_ro + trích nguyên văn SOW, không giá)
vào hàng duyệt `change_request` cho TGĐ. Yêu cầu có từ cấm (vd "chữa lỗi",
"thuốc") → `--submit` exit 1, diễn đạt lại (vd "sửa lỗi"). `--list` = sổ
CR. `--eval` chạy bộ MẪU dev (không phải nghiệm thu).

Exit chung: 0 ok · 1 bị từ chối (chưa duyệt / lệch hash / CSV lỗi /
cảnh báo) · 2 tham số sai hoặc DB down.

## 5n. Đo lường marketing + SEO (v6.5)

WP08 MKT-09/10/11 — mọi số do code tính (0 LLM); agent KHÔNG sửa website,
KHÔNG sửa sàn, KHÔNG đăng bài. Người sửa web/sàn làm TAY sau khi GĐ
Marketing duyệt.

**Đọc mục 5 "Marketing" của báo cáo định kỳ** (`python -m agents.report
--days 7` → `data/reports/report-<kỳ>.md`, topline `tra-lai=<bị trả
lại>/<đã quyết>`):
- **Tỷ lệ trả lại** = nháp bị trả lại / (duyệt + trả lại) trên nháp CÓ quyết
  định trong kỳ (`content_drafts` theo `reviewed_at`; hàng chờ khối
  marketing theo `decided_at`). Nháp còn chờ KHÔNG vào mẫu số (cột "Còn chờ
  cuối kỳ"); mục hết hạn đếm riêng, không phải "trả lại". Mẫu số 0 → "—".
- **Thời gian duyệt** (giờ, tạo → quyết định): trung vị + p90 (nearest-rank:
  9/10 nháp được quyết trong ≤ p90 giờ) + lâu nhất. Không có quyết định →
  `[chưa có dữ liệu]` (không phải 0 giờ); mốc hỏng (duyệt trước lúc tạo)
  bị loại + đếm.
- **Vi phạm guardrail theo code** (chỉ code, không trích câu) + **nháp theo
  agent/người**.
- **Hiệu quả kênh** = tuần ISO đã đóng gần nhất từ `channel_snapshots`
  (số xuất tay nạp bằng `python -m pipelines.cockpit --import FILE --by
  "<người xuất>"`); `(MẪU)` = file mẫu nạp với `--sample`. Search Console/
  GA4 và số kênh thật: **chờ bàn giao (external-dep)**.
- Cockpit chụp thêm `content.drafts_rejected`, `content.review_hours_median`
  / `_p90` (cùng hàm `pipelines/mkt_metrics.py`) khi chạy `python -m
  pipelines.cockpit --collect`.

**Rà SEO website công ty (MKT-10, chỉ đọc):**
1. `python -m agents.seo_web` (mặc định `--from-crawl`, 0 request): đọc dữ
   liệu đã crawl (`python -m crawler.collect`) → `data/reports/seo-web-<ngày
   VN>.md`: tiêu đề nội dung thiếu/trùng/dài, sản phẩm không ảnh, trang/slug
   vi phạm guardrail (chỉ code). Meta/H1/alt/link gãy = "chưa kiểm".
2. `python -m agents.seo_web --fetch --max-requests 40` khi cần kiểm HTML:
   GET qua collector (robots.txt, ≥1s/host, ngân sách 1..200) CHỈ 2 host
   công ty (`data/seo_rules.json` `web.own_hosts`); redirect ra ngoài bị chặn.
3. Thêm `--submit` → 1 mục `seo_web_fix` vào hàng chờ khối marketing (SLA
   168h; payload chỉ URL + code + đề xuất). GĐ Marketing duyệt rồi người
   quản trị web sửa TAY trên CMS. Chạy lại cùng nội dung → `skipped`.

**Gợi ý từ khóa tiêu đề sàn (MKT-11):**
1. Nạp file Seller Center (`python -m ingest.market_csv`) + Google Trends
   xuất tay (`python -m ingest.intel_import`).
2. `python -m agents.seo_san --run --dry-run` → `data/reports/seo-san-<ngày
   VN>.md` xem trước (0 ghi DB). Bỏ `--dry-run` → nháp listing `pending`
   (`prompt_version` `seo-san-v1`, `created_by` `agent:MKT-11`) vào hàng
   duyệt nội dung; chạy lại → `skipped`. Lọc `--sku K` / `--channel shopee`.
3. Từ khóa rượu, "Ngọc Linh" (chờ Pháp chế), từ cấm bị loại kèm code; tiêu
   đề ≤ `title_max` `data/listing_rules.json` (GIẢ ĐỊNH). Người duyệt rồi
   sửa TAY trên Seller Center — agent không gọi API sàn.
4. Bộ ca kiểm: `python scripts/agent_eval.py --agent mkt_seo --no-record`.

**External-dep:** Search Console/GA4; số reach/tương tác/đơn thật; quyền sửa
website; file listing thật; ngưỡng SEO (`data/seo_rules.json` GIẢ ĐỊNH); giới
hạn ký tự sàn thật; GĐ Marketing ký nghiệm thu WP08; người duyệt khối
marketing (`approvers: []`).

## 5o. Catalog/listing đa sàn + giám sát giá & KM (v5.3 — agent KHÔNG đổi giá/listing)

Hai agent LUẬT (không LLM, không gọi sàn) của khối KD. Chỉ ĐỌC file sàn đã
nạp (mục 5b), golden (giá list/floor), bản listing đã duyệt (MKT-02), giá
vốn đã duyệt (mục 5l) — mọi việc là NHÁP trong hàng duyệt khối `sales`
(risk high). Agent KHÔNG ghi `price_list`/golden, KHÔNG sửa sàn.

**A4 — đồng bộ catalog/listing (`agents.kd_listing`):**
1. Nạp file listing mới nhất mỗi kênh (mục 5b — xuất TOÀN BỘ sản phẩm).
2. `python -m agents.kd_listing --run --dry-run` → in phát hiện + số mục sẽ
   đẩy, KHÔNG ghi DB. Loại: listing nhóm CAM đang bán (rượu, SKU ngoài kênh
   cho phép — S1), tiêu đề/giá trên sàn khác bản duyệt, bản duyệt cũ so với
   giá golden (sinh lại bằng `python -m pipelines.content --listing`), listing
   chưa có bản duyệt, SKU đủ điều kiện mà chưa có listing. Kênh chưa có file
   listing → `[warn]`, không báo "thiếu listing".
3. `python -m agents.kd_listing --run` → đẩy mục mới (`listing_sync` /
   `market_alert_s1`; chạy lại không đẩy trùng). `--report [--out-dir D]` →
   `data/reports/catalog-sync-<ngày>.md`.

**A5 — giám sát giá & khuyến mãi (`agents.kd_price`):**
1. Ngưỡng ở `data/price_watch.json` (GIẢ ĐỊNH — GĐ bán hàng chốt, ghi
   `confirmed_by`): lệch niêm yết %, trần chiết khấu %/kênh (≤ 49), số KM chồng
   tối đa, số ngày nhìn trước. Giá sàn/list lấy từ golden `price_list`.
2. Kế hoạch KM = CSV nhập tay (utf-8), header:
   `program_id,kenh,sku_key,loai_km,ngay_bat_dau,ngay_ket_thuc,giam_pct,gia_km_vnd,su_kien`
   — mỗi dòng điền ĐÚNG 1 trong `giam_pct` (1..99) / `gia_km_vnd`; `loai_km`
   ∈ voucher|flash_sale|giam_gia; ngày `YYYY-MM-DD`; `su_kien` (tùy chọn) =
   id trong `data/marketing_calendar.json` (vd `11.11`, `12.12`,
   `tet_2027`). CSV lỗi → exit 1, in số dòng + tên cột (không in giá trị
   ô), KHÔNG connect. Mẫu dev: `tests/fixtures/kd_price/promo_plan_MAU.csv`
   (KHÔNG phải kế hoạch thật).
3. `python -m agents.kd_price --report --plan <CSV> --as-of <ngày>` →
   `data/reports/price-watch-<ngày>.md`: S1 (dưới giá sàn, biên âm, KM cho
   SKU không được quảng bá) trước S2 (lệch niêm yết, vượt trần chiết khấu,
   KM chồng, không kiểm được), sự kiện mùa trong N ngày tới, "Tham khảo đối
   thủ (KHÔNG dùng để đề xuất giá)". Thiếu `--plan` → chỉ kiểm giá đang chạy.
4. `python -m agents.kd_price --run --dry-run --plan <CSV>` (in kế hoạch) →
   `python -m agents.kd_price --run --plan <CSV>` đẩy `market_alert_s1` /
   `price_change` / `promo_change`. `--as-of` chỉ đi với `--report` hoặc
   `--run --dry-run`.

**Ai duyệt:** GĐ bán hàng qua `python -m pipelines.approval_queue --approve
<ID> --by "<tên>"` / `--reject <ID> --by "<tên>"`; sau khi duyệt, Quản lý
MXH sửa TAY trên Seller Center. Agent không bao giờ đề xuất giá theo đối thủ;
giá vốn chưa duyệt → báo "chưa có giá vốn duyệt", không cảnh báo biên.
Bản tin GĐ KD (`agents.sales_director --bulletin`) mục 6 đếm mục A4/A5 chờ
duyệt + lần chạy gần nhất.

External-dep: file listing/KM thật từ Seller Center (header `Giá khuyến
mãi`/`Sale Price` GIẢ ĐỊNH), ngưỡng thật + `confirmed_by`, giá vốn + tỷ lệ
thực nhận thật (GĐ tài chính), kế hoạch KM thật 11.11/12.12/Tết, cột thuộc
tính listing, GĐ bán hàng ký nghiệm thu + gán nhãn suite `kd_a5`.

Exit: 0 ok · 1 cấu hình/CSV lỗi (trước connect) · 2 tham số sai / DB down.

## 5p. Kéo listing/đơn qua API sàn — CHỈ ĐỌC (v10.3, `ingest.market_api`)

**Làm gì:** thay bước xuất file tay ở mục 5b bằng API chính thức của sàn
(Shopee Open Platform / TikTok Shop API) — dữ liệu đổ vào CÙNG staging
`market_snapshots`/`market_rows` nên cảnh báo S1/S2 và `--report` của 5b
chạy y hệt. Module CHỈ có các endpoint ĐỌC (allowlist cứng trong code) —
không đổi giá/listing/tồn/đơn; quảng cáo vẫn nạp bằng FILE (`ingest.market_csv
--kind ads`).

```
python -m ingest.market_api --channel shopee --kind listing
python -m ingest.market_api --channel tiktok --kind order --days 7   # 1..15 ngày
python -m ingest.market_csv --report                                  # đọc cảnh báo như 5b
```

- **Chưa chạy được thật (external-dep):** cần app trên Shopee Partner
  Center / TikTok Shop Partner Center **chỉ xin quyền đọc** + access token
  + sandbox để xác minh chữ ký/field. Thiếu bất kỳ biến
  `SHOPEE_PARTNER_ID/SHOPEE_PARTNER_KEY/SHOPEE_SHOP_ID/SHOPEE_ACCESS_TOKEN`
  (TikTok: `TIKTOK_APP_KEY/TIKTOK_APP_SECRET/TIKTOK_SHOP_CIPHER/
  TIKTOK_ACCESS_TOKEN`) → in `[external-dep] thiếu <TÊN BIẾN>`, **exit 2**,
  0 request, không chạm DB — đây là trạng thái hiện tại, không phải lỗi.
- Key/token CHỈ để trong `.env` (Quản lý hạ tầng AI giữ); không dán vào
  chat/ticket. Token hết hạn → lỗi `HTTP 401`/mã lỗi auth → người xoay
  token (chưa có refresh tự động — xem runbook hạ tầng).
- Dữ liệu không đổi so với lần trước → `[skip] dữ liệu không đổi`. Lỗi
  API/dữ liệu → `[err]` (chỉ mã lỗi, không in nội dung response), exit 1,
  KHÔNG ghi gì.
- Tên/SĐT/địa chỉ người mua trong response đơn bị bỏ ngay trong bộ nhớ;
  DB chỉ giữ field như file xuất tay, mã đơn dạng hash.

## 5q. Social listening nhà cung cấp (v10.3, `ingest.social_vendor` — cổng TGĐ)

**Làm gì:** nạp file export của nhà cung cấp social listening (bài/bình
luận CÔNG KHAI trên MXH/diễn đàn/báo) vào bảng RIÊNG
`social_mentions_vendor` (không trộn với kênh sở hữu ở 5f). **Hiện đang
KHÓA:** `data/social_vendor.json` có `"vendor_approved_by_tgd": false` →

```
python -m ingest.social_vendor --file vendor_export.csv
# → [blocked] nhà cung cấp chưa được TGĐ duyệt — không nạp (exit 2)
```

- **Mở khóa (CHỈ người thật):** sau khi có hợp đồng + DPA với nhà cung cấp,
  Pháp chế xác nhận nguồn thu thập hợp pháp và **TGĐ duyệt**, người phụ
  trách sửa `data/social_vendor.json`: `vendor_approved_by_tgd` = `true`
  (boolean, không phải chuỗi), `approval_ref` = mã biên bản duyệt,
  `vendor_name`. Agent/AI không được sửa file này.
- Template cột (GIẢ ĐỊNH — chưa có file thật): bắt buộc `thoi_gian,
  nen_tang (facebook|tiktok|youtube|instagram|forum|news|khac), noi_dung`;
  tùy chọn `ma_tin, id_tac_gia, loai (post|comment|review)`; cột `ten_tac_gia,
  link_tac_gia, avatar, so_nguoi_theo_doi, email, sdt, url_bai,
  cam_xuc_vendor` bị BỎ ngay khi đọc; cột khác → lỗi cả file.
- Cùng luật dữ liệu cá nhân như 5f: che SĐT/email ngay khi đọc, chỉ lưu
  nhãn + hash có muối (`INTEL_HASH_SALT`), trích nội dung CHỈ khi
  `dpia_signed` true. Nạp lại cùng file → `[skip]`; tin trùng giữa 2 file
  (cùng `ma_tin`) chỉ đếm 1 lần (`new=… dup=…`).

## 5r. Ads thử nghiệm / kit KOC / UGC (v6.4 — agent KHÔNG chi tiền, KHÔNG đăng, KHÔNG liên hệ)

Ba agent MKT-05/06/07 chỉ lập NHÁP vào hàng duyệt chung. Cài chiến dịch
quảng cáo, gửi kit cho KOC, trả lời review/bình luận, nhắn khách xin phép
= NGƯỜI làm tay SAU khi duyệt. Không agent nào gọi API quảng cáo (Meta/
TikTok/Shopee Ads), API sàn hay MXH (tài khoản + API là external-dep).

**Ánh xạ chính sách kênh → readiness** (golden + view `sku_readiness`):
offline_only = rượu (xét TRƯỚC readiness, kể cả golden ghi nhầm kênh) ·
listing_only = `MO_TA` (TPBVSK chưa XNQC — chỉ mô tả, không ads) · CAM =
kênh ngoài `allowed_channels` / thực phẩm chưa tự công bố / SKU lạ ·
online_ok = `TP_THUONG` | `QC_DAY_DU`. Hiện golden thật CHƯA có SKU nào
online_ok → mọi phiếu thật đều bị chặn tới khi hồ sơ (tự công bố/XNQC) đủ.

**Phiếu thử nghiệm ads (MKT-05):**
1. Soạn file JSON (mẫu `tests/fixtures/mkt/ads_plan_mat_ong_MAU.json`):
   SKU, kênh, giả thuyết, 1–3 id bài `content_drafts` ĐÃ DUYỆT loại
   ads/image, ngân sách, ngày bắt đầu/kết thúc (≤ 30 ngày, không trước hôm
   nay), chỉ số thành công (`ctr|cpc|cpa|don_hang`, `>=|<=`), điều kiện dừng.
2. Thử: `python -m agents.mkt_ads --plan FILE.json --by "<tên>" --month
   YYYY-MM --dry-run` (tháng P&L tham chiếu trần — mặc định tháng trước).
3. Lập: bỏ `--dry-run` → 1 dòng `ad_test_plans` + 2 mục risk high cùng
   `adtest-<id>`: `marketing/ad_campaign` (GĐ Marketing) và
   `finance/budget_change` (khối finance — vai trò `tgd` tạm thay GĐ tài
   chính). Chạy lại cùng file → không tạo phiếu thứ 2.
4. Duyệt (người ≠ người lập): `python -m pipelines.approval_queue --approve
   <QID> --by "<tên>"` cho CẢ 2 mục. `python -m agents.mkt_ads --status <ID>`
   → `da_duyet` chỉ khi đủ 2 → Quản lý MXH cài tay đúng ngân sách phiếu.
5. Hết đợt: xuất file kết quả từ trình quản lý quảng cáo (cột GIẢ ĐỊNH
   `ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang` — `bien_the` = id
   draft) → `python -m agents.mkt_ads --results FILE.csv --plan-id N --by
   "<tên>"` → 1 mục ĐỀ XUẤT `dung` | `dat_muc_tieu` | `tiep` |
   `chua_du_lieu` (cờ "CHI VƯỢT PHIẾU" khi chi > ngân sách). Không có nhánh
   nâng ngân sách — muốn chi thêm phải lập phiếu mới qua trần.

| Mã từ chối | Nghĩa | Làm gì |
|---|---|---|
| `ADS_INPUT` | file/field sai, ngày quá khứ, > 30 ngày, metric lạ, giả thuyết vi phạm guardrail | sửa file |
| `ADS_OFFLINE_ONLY` | SKU rượu | không quảng cáo online — không có ngoại lệ |
| `ADS_LISTING_ONLY` | TPBVSK chưa XNQC (`MO_TA`) | chờ Pháp chế có XNQC |
| `ADS_CAM` | kênh chưa mở / thực phẩm chưa tự công bố / SKU lạ | cập nhật golden qua Sản xuất/Pháp chế |
| `ADS_XNQC_DOSSIER` | TPBVSK QC_DAY_DU nhưng sổ `xnqc_dossiers` không có hồ sơ `da_cap` còn hạn | Pháp chế cập nhật sổ (`agents.xnqc`) |
| `ADS_CREATIVE_UNAPPROVED` | bài chưa duyệt / khác SKU / sai loại / lệch bản duyệt / thiếu nhãn quảng cáo-AI | duyệt bài qua hàng nội dung (mục 4) |
| `ADS_NO_CAP` | `agents.fp_ads` không có trần cho SKU × kênh (thiếu giá vốn duyệt, dưới ngưỡng biên, kênh ngoài cấu hình ads) | mục 5l |
| `ADS_OVER_CAP` | ngân sách + đã phân bổ (phiếu khác cùng SKU × kênh, cùng tháng P&L tham chiếu hoặc chạm cùng tháng lịch, chưa từ chối/hết hạn) > trần FP&A — chẻ nhiều phiếu nhỏ không lách được | giảm ngân sách phiếu, hoặc chờ phiếu cũ bị từ chối/hết hạn |
| `ADS_PLAN_NOT_APPROVED` | nạp kết quả khi phiếu chưa duyệt đủ 2 mục | duyệt trước |

**Kit KOC/affiliate (MKT-06):**
1. `python -m agents.mkt_koc --list` — KOC MẪU (`KOC-MAU-xx`, không phải
   người thật) + kết quả kiểm hợp đồng.
2. `python -m agents.mkt_koc --kit --koc KOC-MAU-01 --sku <sku> --draft-ids
   <id,id> --by "<tên>" [--dry-run]` → mục `marketing/koc_brief`. Kit =
   nguyên văn bài đã duyệt + điểm được/không được nói + câu khuyến cáo
   (TPBVSK) + nhãn `#quangcao` (+ nhãn AI) + link/mã affiliate
   PLACEHOLDER (chưa phải link thật) + sha256 hợp đồng. Chặn:
   `KIT_OFFLINE_ONLY`, `KIT_LISTING_ONLY`, `KIT_CAM`,
   `KIT_CREATIVE_UNAPPROVED`, `KIT_CONTRACT` (hợp đồng thiếu điều khoản —
   in mã điều khoản), `KIT_GUARDRAIL`.
3. GĐ Marketing duyệt → `python -m agents.mkt_koc --release <QID> --by
   "<tên>"` → `data/reports/koc-kit-<KOC>-<QID>.md` (đúng bản đã duyệt).
   Hợp đồng bị sửa sau khi lập kit → `KIT_CONTRACT_CHANGED`, lập kit lại.
   Người phụ trách gửi file cho KOC TAY. Hợp đồng mẫu đạt `contract_check`
   ≠ đã ký/đã rà luật sư.

**Review/UGC (MKT-07):**
1. Review sàn: `python -m agents.mkt_ugc --reviews FILE.csv --channel
   shopee|tiktok --by "<tên>" [--dry-run]` (cần `INTEL_HASH_SALT`; cột
   người mua/ảnh/mã đơn bị bỏ khi đọc; cột lạ → chặn cả file). Bình luận
   kênh sở hữu: `python -m agents.mkt_ugc --mentions --since YYYY-MM-DD
   --by "<tên>"` (chỉ nhãn v7.2 — DPIA chưa ký nên không có nội dung).
2. Mỗi review được phân lớp khen/chê/khiếu nại/hỏi giá/claim sức khỏe/rượu
   → mục `ugc_reply` (risk medium) chứa câu ĐỀ XUẤT theo template
   (`data/ugc_rules.json` + câu sức khỏe/rượu của `data/channels.json`).
   Câu trả lời KHÔNG lặp lại bệnh/công dụng khách nói (`UGC_ECHO` chặn).
   Duyệt rồi người phụ trách đăng tay trên Seller Center/kênh.
3. Xin phép dùng lại: `python -m agents.mkt_ugc --reuse-request <ugc-REF>
   --by "<tên>"` → nháp tin `xin_phep` (CHƯA GỬI). Khách đồng ý → ghi
   consent `marketing` (`python -m ingest.crm --consent ...`, mục 5g) →
   `python -m agents.mkt_ugc --reuse <ugc-REF> --contact-id N --by "<tên>"`
   → mục `ugc_reuse` (risk high). Không consent/đã rút → `UGC_NO_CONSENT`;
   review sức khỏe/rượu → `UGC_SENSITIVE` (không bao giờ tái sử dụng);
   REF lạ → `UGC_UNKNOWN_REF`.

Exit chung: 0 ok/skip · 1 bị chặn (in mã) / cấu hình / DB lỗi · 2 tham số
sai hoặc DB down.

## 5s. Báo giá B2B quà Tết (v8.2, KD-A3 — WP11; agent KHÔNG tự gửi/liên hệ)

**Ma trận báo giá:** `data/b2b_pricing.json` là bản GIẢ ĐỊNH (bậc số lượng ×
chiết khấu × SKU/combo, ngưỡng biên `min_margin_pct`). Kiểm: `python -m
agents.kd_quote --check-matrix` (exit 0 hợp lệ / 1 lỗi). Khi GĐ bán hàng +
tài chính chốt: sửa số, điền `finance_confirmed`/`sales_confirmed` =
`{"by": "<tên>", "at": "YYYY-MM-DD"}` (NGƯỜI điền — hệ thống không tự điền).
Còn `null` → MỌI báo giá đi per_item (mã `ma_tran_chua_xac_nhan`). Rượu
KHÔNG BAO GIỜ được thêm vào ma trận (`--check-matrix` báo lỗi).

**Form B2B (nhận yêu cầu):** chỉ bật SAU khi DPIA luồng DF-35 được ký:
`B2B_FORM_ENABLED=1 python -m connectors.b2b_form` (đặt biến trong env tiến
trình — .env KHÔNG bật được; thiếu → exit 2; khóa `CONTACT_VAULT_KEY` lỗi →
exit 2) → `http://127.0.0.1:8791/b2b` (`B2B_FORM_HOST`/`B2B_FORM_PORT`;
domain + TLS + reverse proxy = external-dep). Form chỉ liệt kê đúng tập sản
phẩm của catalog. Chặn: > 8 KB (413), không phải form urlencoded (415),
chunked (411), > 5 lượt/IP/giờ hoặc 60 lượt/giờ toàn form (429), honeypot
(trả trang chung, không ghi). Tên/SĐT/email người liên hệ vào `contacts`
(mã hóa) + đồng ý mục đích `b2b` (`policy_version` `b2b-v0-nhap` — NHÁP chờ
Pháp chế); bảng `b2b_requests` chỉ giữ `contact_id`. Log chỉ
`[b2b_form] <mã> ip=<hash> yc=<id>`.

**Báo giá (GĐ bán hàng):**
1. `python -m agents.kd_quote --requests` → danh sách `YC-<id>` (không PII).
2. `python -m agents.kd_quote --quote <ID> [--discount <PCT>] [--date
   YYYY-MM-DD]` → in phân loại + lý do; ghi nháp `data/reports/bao-gia-
   <số>.md` + `.html` + `-noi-bo.md` (bản nội bộ: biên, giá vốn — KHÔNG gửi
   khách). `--dry-run` = chỉ in. Dòng rượu / mã lạ / số lượng sai → exit 1,
   không sinh báo giá (rượu: hệ thống không báo giá — GĐ xử lý NGOÀI hệ
   thống khi Pháp chế xác nhận đủ điều kiện). Cổng chặn (vd tên tổ chức chứa
   từ cấm như "Nhà thuốc ...") → exit 1: GĐ soạn tay.
3. `--quote <ID> --submit` → hàng duyệt: trong ma trận + biên đạt + giá vốn
   ĐÃ duyệt → `b2b_quote_matrix` (risk low — CHỈ tự đạt khi chủ khối đã ký
   `auto_policies` cho loại này + suite `kd_a3` pass; ship → chờ người duyệt);
   ngoài ma trận / TPBVSK chưa XNQC / vượt CK / dưới giá sàn → `b2b_quote`
   (risk high); biên dưới ngưỡng hoặc thiếu giá vốn đã duyệt → thêm mục
   `finance/b2b_margin_review` cho tài chính (cùng 1 transaction). Chạy lại
   cùng số báo giá → `[skip]`.
4. Người duyệt (≠ agent): `python -m pipelines.approval_queue --approve <QID>
   --by "<tên>"` (tài chính duyệt mục `b2b_margin_review` trước khi GĐ bán
   hàng ký báo giá).
5. `python -m agents.kd_quote --export <QID> --out <file>.md|.html` (chỉ mục
   ĐÃ duyệt, khớp sha256). HTML → mở trình duyệt → In → Lưu PDF (A4).
6. Trước khi gửi: `python -m agents.kd_quote --verify-send <QID> <file>` →
   exit 0 "KHỚP bản đã duyệt — GĐ bán hàng tự gửi". Exit 1 "LỆCH" = file bị
   sửa (kể cả 1 ký tự) / chưa duyệt / sai loại → KHÔNG gửi. NGƯỜI tự gửi
   (email/Zalo của GĐ) — hệ thống không có đường gửi.

**Catalog quà Tết:** `python -m agents.kd_catalog --build [--bom
data/sample_bom.json] [--packshot-dir <thư mục ảnh>]` → `data/reports/
catalog-tet-<ngày>.md` + `.html` (loại rượu, TPBVSK chưa XNQC, combo dính
các SKU đó; nhãn "Quảng cáo"; ảnh `<key>.png` đặt cạnh HTML trong thư mục
`packshots/`). `--submit` → mục `b2b_catalog` (risk high) → duyệt →
`--export <QID> --out <file>` → `--verify-send <QID> <file>` KHỚP → người tự
gửi. Dữ liệu thật hiện chỉ còn 3 mã mật ong (mọi TPBVSK chưa XNQC).

| object_type | Khối | Rủi ro | Ai duyệt |
|---|---|---|---|
| `b2b_quote_matrix` | sales | low | GĐ bán hàng (auto_policy chỉ khi chủ khối ký) |
| `b2b_quote` | sales | high | GĐ bán hàng |
| `b2b_catalog` | sales | high | GĐ bán hàng |
| `b2b_margin_review` | finance | high | Tài chính (TGĐ tạm) |

Exit chung: 0 ok · 1 bị chặn (problems / cổng / chưa duyệt / lệch hash /
ma trận lỗi) · 2 tham số sai hoặc DB down.

## 5t. Đơn sàn + đối soát, chăm sóc lại, livestream, YouTube (v10.1 WP16 — KD-A6/A7/A9, MKT-12; hệ thống KHÔNG gửi/đăng)

**Đơn sàn → `orders` (KD-A6):** sau khi nạp file đơn (`python -m
ingest.market_csv --file F --channel K --kind order`), chạy `python -m
agents.kd_orders --sync --dry-run` (chỉ đếm) rồi `python -m agents.kd_orders
--sync [--snapshot ID]`. Idempotent: chạy lại = 0 thêm/0 cập nhật; snapshot
sau đổi trạng thái (vd hủy) → cập nhật `status`, KHÔNG đổi `ts` (GIẢ ĐỊNH:
`ts` = lúc nạp snapshot đầu tiên thấy đơn — file chưa có cột ngày đặt). Row
`orders` không phải `market:%` (nhập tay/mẫu) không bao giờ bị đè.

**File đối soát (kế toán):** `python -m agents.kd_orders --recon --since
2026-10-01 --until 2026-10-31 [--out-dir DIR]` → `data/reports/doi-soat-
<since>-<until>.csv` (UTF-8 BOM, mở được bằng Excel): mỗi đơn sàn trong kỳ 1
dòng (mã 8 ký tự, phí sàn = cố định + thanh toán + dịch vụ, ship, voucher,
affiliate, hoàn, thực nhận, nhãn `khop|lech|thieu_chung_tu|hoan|
chua_quyet_toan`), quyết toán trong kỳ không có đơn → `thieu_don`, hàng
`TONG` mỗi kênh. Chỉ BÁO CÁO — không bút toán; kế toán duyệt file. File
quyết toán/đơn thật từ Seller Center là external-dep (cột GIẢ ĐỊNH).

**Chăm sóc lại / xin đánh giá (KD-A7):**
1. NGƯỜI ghi lần mua kênh sở hữu: `python -m agents.kd_care --record --by
   "<tên người>" < lan_mua.json` (`{"contact_id": N, "channel":
   "web|zalo|b2b|showroom", "sku_key": "...", "purchased_on": "YYYY-MM-DD",
   "delivered_on": "YYYY-MM-DD", "order_ref": "MÃ-NỘI-BỘ"}` — không SĐT/
   tên; khách sàn bị chặn).
2. `python -m agents.kd_care --plan` (chỉ đọc) → `--run --dry-run` → `--run`
   → mục `care_rebuy` (nhắc mua lại — cần đồng ý `marketing`, SKU trong
   `v_promotable` kênh zalo, tối đa 2 tin/khách/tháng) / `care_review` (xin
   đánh giá — cần đồng ý `cskh`) vào hàng duyệt khối sales.
3. GĐ bán hàng duyệt: `python -m pipelines.approval_queue --approve <QID>
   --by "<tên>"`.
4. TRƯỚC KHI GỬI: lưu payload đã duyệt ra file rồi chạy
   `python -m agents.kd_care --verify-send <QID> <file>` → `[ok]` mới gửi (kiểm sha bản duyệt + đồng ý
   CÒN hiệu lực + trong khung 08:00–20:00). `consent` = khách đã rút đồng ý
   → KHÔNG gửi. Người gửi tay phần tin phía trên dòng `---` qua Zalo OA/ZNS
   (external-dep). Mẫu tin/khung giờ/trần trong `data/care_rules.json` là GIẢ
   ĐỊNH chờ GĐ KD/Pháp chế; consent thật của khách là external-dep.

**Kịch bản livestream (KD-A9):** `python -m agents.kd_live --channel
tiktok --cart mat-ong-sam-300ml,mat-ong-sam-120ml-1hu --day 2026-10-20
--brief "Phiên quà quê cuối tuần" [--dry-run]` → nháp `livestream_script`
pending trong `content_drafts` (duyệt qua `python -m pipelines.store
--approve <ID> --by "<tên>"` như nội dung khác). Bị từ chối trước LLM: kênh
ngoài `data/livestream_rules.json`, giỏ có rượu, SKU chưa promotable
(TPBVSK chưa XNQC / giá chưa duyệt), quá 2 phiên/tuần. Giá trong kịch bản do
hệ thống điền từ bảng giá đã duyệt. Tài khoản livestream là external-dep —
người dẫn đọc kịch bản đã duyệt.

**YouTube dài + Shorts (MKT-12):** `python -m agents.mkt_youtube --brief
"Câu chuyện vùng trồng sâm" [--render] [--dry-run]` → nháp `video` kênh
`youtube` pending (tiêu đề, mô tả có chương + nhãn AI/QC, kịch bản theo
chương, phụ đề SRT, danh sách Shorts; chế độ hiển thị luôn `private`).
`--render` dựng Shorts xem trước 9:16 từ B-roll có license trong
`data/broll/` (`licenses.json`) → `data/video_assets/<sha256>.mp4` (thiếu
B-roll → `broll_thieu`, thiếu ffmpeg → `ffmpeg_thieu`). Tư liệu quay thật,
TTS tiếng Việt, kênh YouTube + API là external-dep — người phụ trách kênh
đưa video lên và đổi chế độ hiển thị sau khi duyệt.

| object_type / content_type | Khối | Rủi ro | Ai duyệt |
|---|---|---|---|
| `care_rebuy` | sales | high (lớp B) | GĐ bán hàng |
| `care_review` | sales | medium (lớp A) | MXH/CSKH → GĐ bán hàng |
| `livestream_script` (content_drafts) | marketing | — | GĐ Marketing/Pháp chế |
| `video` kênh `youtube` (content_drafts) | marketing | — | GĐ Marketing/Pháp chế |

Exit chung: 0 ok · 1 bị từ chối/lỗi/verify fail · 2 tham số sai hoặc DB down.

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

## 6c. Backend vector của chatbot — float8 | pgvector (v10.3)

Chatbot tìm đoạn KB bằng `RAG_VECTOR_BACKEND` trong `.env`:
`float8` (mặc định — cosine numpy trên cột `embedding float8[]`) hoặc
`pgvector` (index HNSW trên cột `embedding_v`). Giá trị khác → lỗi ngay
(không đoán). Hiện Postgres local/cloud CHƯA có extension pgvector
(external-dep) → giữ `float8`.

```
python scripts/apply_schema.py --pgvector     # thiếu extension → [external-dep], exit 3, không đụng gì
python scripts/vector_eval.py --synthetic 200 --questions   # PHẢI [PASS] trước khi chuyển
# đặt RAG_VECTOR_BACKEND=pgvector trong .env rồi khởi động lại streamlit/zalo
```

- Chọn `pgvector` mà DB thiếu cột/extension → chatbot KHÔNG sập: in
  `[warn]` 1 lần rồi tự dùng float8.
- Quay lại: đặt `RAG_VECTOR_BACKEND=float8` (cột float8 vẫn còn nguyên,
  không cần migrate ngược). Chi tiết: `runbook-ha-tang.md`.

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
python -m ingest.crm --status 12 contacted --by "<tên>"
```

Status hợp lệ: `new` → `contacted` → `qualified` → `won`; mọi trạng thái
chưa kết thúc → `lost`. Không lùi; `won`/`lost` là kết thúc (lệnh từ
chối, exit 1). Không sửa status bằng SQL tay (mất `agent_action_log`).
Chi tiết CRM: mục 5c.

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
python scripts/agent_eval.py --validate          # kiểm MỌI suite data/eval/suites/*.json (không DB/LLM)
python scripts/agent_eval.py --deterministic     # validate + suite tất định (guardrail + co_khi + kd_a1 + mkt02 + mkt03 + sales_director) — CI chạy mỗi push
python scripts/agent_eval.py --agent guardrail   # suite data/eval/suites/guardrail.json, không cần key — ghi eval_runs
python scripts/agent_eval.py --agent co_khi --no-record   # 23 ca MẪU agent tra cứu cơ khí CK-A1 (luật, local)
python scripts/agent_eval.py --agent chatbot     # 14 ca qua RAG thật (cần OPENROUTER_API_KEY) — tay/nightly
python scripts/agent_eval.py --print-hash guardrail                  # cases_sha256 tính lại
python scripts/agent_eval.py --propose-threshold guardrail --by "<tên>"   # đổi ngưỡng sau run FAIL
python scripts/agent_eval.py --propose-suite guardrail --by "<tên>"       # đổi bộ ca sau run FAIL
python scripts/deploy_gate.py --sha <SHA 40 hex> --approved-by "<tên>" [--hotfix]
```

- **Suite (v4.5)** `data/eval/suites/<agent>.json` = ca + ngưỡng (chốt
  TRƯỚC khi chạy) + `owner_block` (khối nhận báo cáo) + `risk`. 13 suite:
  `guardrail`, `chatbot`, `co_khi` (active) + 10 khung agent QA khối
  (`skeleton` — harness từ chối chạy tới khi có code agent). `co_khi` =
  suite chấm agent tra cứu CK-A1 (`agents/ck_mat.py`); `ck_a6` = khung
  agent QA A6 khối Cơ khí — khác vai trò, giữ cả hai; `co_khi` không nằm
  trong `required_agents`. Mọi suite `frozen: false`,
  ca nhãn `dev_draft`: công ty gán nhãn + đóng băng bộ ca thật
  (`labeled_by`/`frozen_at`) là external-dep.
- **Sửa ca** = tăng `version` + cập nhật `cases_sha256` bằng
  `--print-hash <agent>`. Hash lệch → `[refuse]`; cùng version đã chạy
  với bộ ca khác (DB) → `[refuse]`.
- **Đổi ngưỡng sau khi đã có run FAIL**: `--propose-threshold` tạo mục
  `approval_queue` `eval_threshold` (QA fail) → người khác
  `python -m pipelines.approval_queue --override-qa <id> --by .. --reason
  ..` (≥10 ký tự) → người thứ ba `--approve <id>` → chạy lại eval. Thiếu
  bước nào → `[refuse]`. Chưa có FAIL thì sửa ngưỡng = commit bình thường.
- **Đổi bộ ca sau khi đã có run FAIL** (xóa ca, đổi kind ca bẫy, bỏ
  frozen... kể cả đã bump version): cùng luồng với `--propose-suite`
  (mục `eval_suite`, payload = tóm tắt + `cases_sha256` — người duyệt
  đối chiếu `git diff` của suite theo hash).
- **Giám khảo LLM** (ca `scorer: judge`): chỉ qua gateway `ci_judge`
  (trần 1 USD/tháng), model judge (`judge.model` / env
  `EVAL_JUDGE_MODEL`) phải KHÁC HỌ nhà sản xuất với model agent (allowlist
  họ; `azure/` = openai; router `openrouter/auto`/alias lạ → từ chối);
  output không đúng JSON `{verdict, reason}` (key trùng, reason rỗng...)
  = ca FAIL. Hiện gateway
  `provider_only` chỉ `openai, azure` → judge khác họ chưa gọi được
  (thêm provider = ha_tang + Pháp chế xác nhận ZDR, external-dep).
- **Báo cáo**: FAIL ở suite `risk: high` → `red_alerts` (người nhận độc
  lập BKS/Pháp chế — chưa cấu hình, external-dep); còn lại → mục
  "Nghiệm thu QA hôm nay" trong bản tin GĐ khối owner
  (`python -m pipelines.director`). `director.submit(qa_suite=..)` lấy
  QA từ `eval_runs` — bản QA FAIL chỉ đi tiếp qua override_qa.
- Người duyệt deploy ở `data/eval/config.json` (`required_agents`,
  `approvers` — bản hiện tại dev soạn, chưa được công ty duyệt). Lịch đóng băng ở
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
| `CONTACT_VAULT_KEY` | Khóa Fernet mã hóa PII trong `contacts` (v5.2) — backup TÁCH khỏi backup DB | `ingest.crm --add-contact/--handoff` dừng exit 2, không ghi PII |
| `OR_CHAT_MODEL` / `OR_EMBED_MODEL` | Model chat / embedding (có mặc định) | Dùng mặc định `openai/gpt-4o-mini` / `openai/text-embedding-3-small` |
| `ZALO_APP_ID` / `ZALO_APP_SECRET` | OAuth refresh token Zalo OA | Webhook không send được khi token hết hạn |
| `ZALO_OA_SECRET` | Verify chữ ký webhook Zalo | `DEPLOY` bật → refuse to serve |
| `ZALO_ACCESS_TOKEN` / `ZALO_REFRESH_TOKEN` | Seed token lần đầu | Sau refresh đầu, source-of-truth là `data/zalo_tokens.json` |
| `ZALO_WEBHOOK_PORT` | Port webhook (mặc định 8788) | — |
| `MESSENGER_APP_SECRET` / `MESSENGER_PAGE_TOKEN` / `MESSENGER_VERIFY_TOKEN` | (v5.1) Chữ ký webhook / gửi tin (header Bearer) / verify GET của Messenger — giá trị thật sau Meta app review | Secret trống → mọi POST 403; `DEPLOY` bật thiếu biến → refuse to serve |
| `MESSENGER_WEBHOOK_PORT` | Port webhook Messenger (mặc định 8789) | — |
| `CHANNEL_HASH_SALT` | (v5.1) Muối HMAC `user_hash` cho `chat_consents` + mục `cskh_handoff` (≥16 ký tự, công ty giữ, KHÔNG đổi sau khi chạy) | Zalo: không ghi đồng ý/handoff (`[warn]`); Messenger `DEPLOY` bật → refuse to serve |
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
