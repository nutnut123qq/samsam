# Chuyển DB lên Postgres managed trong nước (v3.6, WP02 / F17.4)

- **Dành cho ai:** Quản lý hạ tầng AI (hoặc đội triển khai khi chưa tuyển
  xong), người được TGĐ giao mở tài khoản cloud.
- **Làm gì:** chọn nhà cung cấp Postgres managed trong nước, nối app vào
  bằng TLS, đưa đủ bảng của `docs/schema.sql` lên, bật backup + diễn tập khôi phục.
- **Cần gì (external-dep — công ty cấp, repo này KHÔNG giả lập):** tài
  khoản + thẻ thanh toán nhà cung cấp; bật PITR/WAL; object storage
  S3-compatible + key; khóa mã hóa backup trong secret manager; VM ứng
  dụng + VM diễn tập nhỏ; người ký biên bản diễn tập.

Hiện trạng: DB chạy local (Postgres 17). Mọi lệnh dưới đây đã chạy được
trên local; phần cloud là mẫu lệnh chờ tài khoản.

## 1. Tiêu chí chọn nhà cung cấp (F17.4)

Bắt buộc:

1. Dữ liệu nằm trong nước (máy chủ + bản sao lưu).
2. Có PITR (WAL liên tục) **và** cho khôi phục PITR ra instance tạm (để
   diễn tập không đụng production).
3. Mã hóa at-rest.
4. Kết nối TLS (`sslmode=require`; có CA của nhà cung cấp thì
   `sslmode=verify-full` + `sslrootcert=<file CA>`).

Ưu tiên: object storage có object-lock (chống xóa/ghi đè bản sao lưu);
API bật/tắt VM (VM diễn tập chỉ bật trong khung diễn tập).

Ứng viên: Bizfly Cloud, Viettel IDC, FPT Cloud, VNPT, CMC Cloud,
GreenNode — **tất cả cần xác minh sau báo giá**; README này không khẳng
định nhà nào đạt tiêu chí nào khi chưa kiểm.

## 2. Kết nối

Mẫu biến môi trường: [`env.cloud.example`](env.cloud.example) (chỉ
placeholder `<...>`, chép thành `.env` trên VM rồi điền — KHÔNG commit).
`db_backup.py`/`db_restore_drill.py` nạp `.env` này TRƯỚC khi kiểm cấu
hình (biến đặt sẵn trong env tiến trình/systemd thắng `.env`), nên
`BACKUP_*` để ở `.env` hay `EnvironmentFile` đều có hiệu lực.

```
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/samsam?sslmode=require
```

- Mọi `psycopg.connect` trong code có `connect_timeout` (test
  `tests/test_connect_timeout_guard.py` chặn tái phát) — host cloud
  không tới được thì lỗi sau vài giây, không treo.
- Công cụ `pg_dump`/`pg_restore` nhận `PGSSLMODE` từ `sslmode` trong DSN
  (script tách DSN thành biến `PG*`, mật khẩu không nằm trong argv).

3 role đề xuất (external-dep — tạo trên console/psql khi có tài khoản):

| Role | Quyền | Dùng cho |
|---|---|---|
| `app` | đọc/ghi bảng ứng dụng | chatbot, Streamlit, Zalo, agents |
| `backup` | CHỈ ĐỌC mọi bảng | `scripts/db_backup.py` |
| `loader` | ghi bảng golden (`sku_master`, `sku_map`, `price_list`, `golden_discrepancies`) | `ingest.golden_store` |

## 3. PITR phía nhà cung cấp (external-dep)

Người làm 1 lần trên console: bật PITR/WAL, đặt retention WAL, đọc lại
cấu hình để kiểm, lưu biên bản. Diễn tập PITR ra instance tạm của nhà
cung cấp (mốc 30/11 và 18/12), đo RTO, xóa instance sau khi đo.

## 4. Đưa toàn bộ bảng lên cloud

Chọn 1 trong 2 đường cho từng bảng.

### Đường A — dựng mới từ nguồn trong repo

```
python scripts/apply_schema.py      # chạy 2 lần — lần 2 vẫn in đủ số bảng
python -m ingest.core_store         # products, claims_approved, plots, plot_logs, orders, assets
python -m ingest.golden_store       # sku_master, sku_map, price_list, golden_discrepancies
python -m ingest.embed_store        # chunks (gọi API embed — tốn phí)
```

Bảng sinh lúc chạy bắt đầu RỖNG theo đường A: `leads`, `content_drafts`,
`llm_usage`, `golden_discrepancies` (phiếu lệch mở lại khi loader chạy),
`plot_logs` (nhật ký vườn mới — dữ liệu mẫu do core_store nạp).

### Đường B — mang dữ liệu đang có

```
python scripts/db_backup.py         # local, ra file .dump + manifest (row_counts mọi bảng)
pg_restore --no-owner --no-privileges --exit-on-error -d samsam <file .dump>   # vào DB cloud rỗng (PG* env, sslmode=require)
```

Sau `pg_restore`, đếm `count(*)` từng bảng trên cloud và so với
`row_counts` trong manifest (phép đếm giống `db_restore_drill.py`); lệch
bảng nào thì dừng, không bật app.

| Bảng | Đường đề xuất | Ghi chú |
|---|---|---|
| `chunks` | A (embed lại) hoặc B | B tránh phí embed |
| `products` | A | crawl web, `core_store` sở hữu |
| `claims_approved` | A | từ `data/claims_whitelist.json` |
| `plots` | A | |
| `plot_logs` | B | nhật ký vườn thật không có trong repo; hash chain v9.3 — chỉ B giữ nguyên `prev_hash`/`row_hash` (restore xong chạy `python -m agents.garden_director --verify`) |
| `garden_media` | B | metadata ảnh vườn (v9.3); file ảnh nằm ở `GARDEN_MEDIA_DIR` ngoài repo — sao lưu thư mục đó riêng |
| `orders` | A | |
| `assets` | A | |
| `leads` | B | dữ liệu khách — PII, chỉ qua backup mã hóa |
| `contacts` | B | (v5.2) PII đã mã hóa Fernet — vô dụng nếu thiếu `CONTACT_VAULT_KEY`; mang khóa theo đường RIÊNG, không cùng file backup |
| `consents` | B | (v5.2) append-only — bằng chứng đồng ý, dựng lại = mất |
| `chat_consents` | B | (v5.1) append-only — bằng chứng đồng ý tư vấn chat Zalo/Messenger (user_hash có muối — mang `CHANNEL_HASH_SALT` theo đường riêng, đổi muối = mất liên kết), dựng lại = mất |
| `dealers` | A (`ingest.crm --load-dealers`) hoặc B | B giữ dòng `source='manual'` |
| `content_drafts` | B | draft + trạng thái duyệt |
| `llm_usage` | B | chi phí đã dùng (trần tháng) |
| `sku_master` | A | `golden_store` |
| `sku_map` | A | |
| `price_list` | B | append-only, giá ĐÃ DUYỆT bởi người thật — dựng lại sẽ mất lịch sử duyệt |
| `golden_discrepancies` | B | phiếu lệch đã xử lý |
| `market_snapshots` | A (nạp lại file sàn) hoặc B | staging file Seller Center (v3.3) |
| `market_rows` | A hoặc B | không có PII người mua |
| `market_alerts` | B | trạng thái mở/đóng cảnh báo — dựng lại sẽ mất lịch sử |
| `eval_runs` | B | lịch sử nghiệm thu — `deploy_gate` cần dòng mới nhất |
| `job_runs` | B | lịch sử job cho bản tin sức khỏe |
| `documents` | B | metadata hồ sơ đã xác nhận; bản gốc ở kho `originals/` riêng |
| `document_fields` | B | field Pháp chế đã xác nhận |
| `chunks_internal` | B | tài liệu nội bộ đã duyệt (`approved_by` người thật) |
| `approvals` | B | append-only, quyết định duyệt + sha256 — không dựng lại được |
| `agent_action_log` | B | hash chain — CHỈ đường B giữ được chuỗi; sau restore chạy `python -m pipelines.store --verify-log` |
| `approval_queue` | B | (v4.0) hàng duyệt dùng chung — payload + sha256 bất biến, trạng thái đã quyết không dựng lại được |
| `auto_policies` | B | (v4.0) luật tự duyệt đã ký (ship rỗng) |
| `decisions` | B | (v4.0) append-only — override_qa / expired |
| `channel_snapshots` | B | (v4.0) số liệu kênh nhập tay/API theo kỳ |
| `red_alerts` | B | (v4.0) append-only (trigger) — cảnh báo đỏ không được mất |
| `red_alert_acks` | B | (v7.1) append-only — ai xác nhận cảnh báo đỏ intel lúc nào; mất bảng = cảnh báo đã xác nhận lại hiện là "chưa xác nhận" |
| `inventory_snapshots` | A (nạp lại file kho) hoặc B | tồn thành phẩm (v9.2) — repo chỉ có file MẪU, số thật theo đường B |
| `allocation_proposals` | B | đề xuất phân bổ + quyết định GĐ SX — dựng lại sẽ mất lịch sử duyệt |
| `bom_combos` | A (nạp lại file BOM) hoặc B | combo/hộp quà (v9.2) |
| `bom_items` | A hoặc B | thành phần combo |
| `production_lots` | B | hồ sơ lô + trạng thái kiểm nhập — không dựng lại được |
| `lot_origins` | B | ánh xạ lô ↔ nhật ký thu hoạch đã chain (v9.4) — quyết định của GĐ SX, không dựng lại được |
| `qr_signatures` | B | 3 chữ ký tem QR (append-only) — lịch sử ký, không dựng lại được |
| `qr_codes` | B | mã QR đã phát hành/thu hồi — mất bảng = tem đã in trỏ vào mã không còn trang |
| `sla_escalations` | B | (v5.0) append-only — leo thang SLA khối KD (đã leo thang mục nào, lúc nào) không dựng lại được |
| `sim_runs` | B | nghiên cứu giả lập persona (v7.3) — lịch sử chạy model/prompt/seed để kiểm toán, không PII |
| `intel_items` | A (chạy lại `python -m crawler.intel --run`) hoặc B | tin thị trường công khai (v7.0) — chỉ tiêu đề + trích ≤300 ký tự + link; B giữ tin cũ đã trôi khỏi RSS |
| `machines` | B | sổ máy cơ khí (v9.5) — nhập tay, không có nguồn dựng lại |
| `maintenance_plans` | B | lịch bảo trì + người duyệt việc lớn |
| `incidents` | B | sự cố/downtime (view `downtime_log` tự có khi apply schema) |
| `intel_imports` | B (hoặc A: nạp lại file gốc bằng `python -m ingest.intel_import`) | sổ file intel nhập tay đã nạp (v7.2) — giữ để `[skip]` không nạp trùng |
| `competitor_observations` | B | giá đối thủ do người ghi tay — file gốc có thể không còn; không cột định danh |
| `trends_weekly` | A (nạp lại file Google Trends xuất tay) hoặc B | không cột định danh |
| `trends_related` | A hoặc B | không cột định danh |
| `social_mentions` | B | chỉ nhãn + hash có muối (+ trích đã che khi DPIA ký) — không cột định danh; GIỮ đúng `INTEL_HASH_SALT` cũ để dedup tiếp |
| `social_mentions_vendor` | B | (v10.3) social listening nhà cung cấp — chỉ nhãn + hash có muối, không cột định danh tác giả; thường 0 dòng tới khi TGĐ duyệt vendor; cùng `INTEL_HASH_SALT` |
| `settlement_rows` | A (nạp lại file quyết toán) hoặc B | quyết toán sàn (v9.0) — không cột người mua, mã đơn chỉ hash |
| `recon_results` | A (`python -m ingest.settlement_csv --reconcile`) hoặc B | nhãn đối soát dựng lại được từ `settlement_rows` + đơn sàn |
| `invoice_lines` | B | dòng lô hóa đơn NHÁP gắn mục `approval_queue` — dựng lại sẽ lệch lô đã duyệt |
| `dealer_ar` | B | sổ công nợ đại lý nạp tay (v9.0) — chỉ mã đại lý |
| `xnqc_dossiers` | B | (v4.3) sổ hồ sơ XNQC — trạng thái `da_cap` do Pháp chế xác nhận, không có nguồn dựng lại |
| `channel_posts` | B | (v4.3) snapshot bài kênh sở hữu + đợt vi phạm/hạn 24h — B giữ lịch sử đóng đúng hạn/trễ (A: nạp lại file xuất tay chỉ có hiện trạng) |
| `cogs_versions` | B | giá vốn đã duyệt (v9.1) — người lập/duyệt + lịch sử hiệu lực không dựng lại được |
| `opex_entries` | B | chi phí cloud/SaaS nhập tay (v9.1) — không tên người; khoản > X gắn chữ ký TGĐ trong `approval_queue` (đường B) — dựng lại lệch khoản đã ký |
| `programs` | A (chạy lại `python -m agents.da_radar --scan` trên `intel_items`) hoặc B | chương trình xúc tiến (v8.3) — B giữ `first_seen` (ngày phát hiện → nhắc hạn) |
| `org_prospects` | B | tổ chức mua quà (v8.3) nhập tay — trạng thái lô/chuyển sales không dựng lại được; không cột định danh cá nhân |
| `decision_log` | B | sổ quyết định TGĐ (v8.1) — append-only, NGƯỜI ghi; quyết định + chuỗi theo dõi không dựng lại được từ nguồn nào |
| `project_milestones` | B (hoặc A: `python -m agents.da_pmo --seed` — mất trạng thái/evidence/hạn đã duyệt đổi) | sổ mốc phòng Dự án (v8.3) |
| `image_assets` | B | metadata ảnh nháp MKT-03 (v6.2) — file PNG + sidecar ở `IMAGE_OUT_DIR` phải chép theo riêng (không nằm trong dump) |
| `video_assets` | B | metadata video nháp MKT-04 (v6.3) — file mp4 + sidecar ở `VIDEO_OUT_DIR` phải chép theo riêng (không nằm trong dump) |
| `ad_test_plans` | B | (v6.4 MKT-05) phiếu thử nghiệm ads NHÁP — insert-only, gắn 2 mục `approval_queue` `adtest-<id>`; dựng lại sẽ lệch phiếu đã duyệt |

## 5. Backup + diễn tập trên cloud (mẫu — external-dep)

Trên VM ứng dụng (không phải runner CI):

- `BACKUP_DIR` = thư mục trên VM (ngoài repo), `BACKUP_KEEP=7`.
- `BACKUP_PASSPHRASE_FILE` = file khóa lấy từ secret manager (mã hóa
  `openssl` AES-256 + pbkdf2; F17.4 gợi ý `age` khi công ty chốt khóa).
  openssl chỉ dùng DÒNG ĐẦU của file: dòng đầu trống/ngắn hơn 16 ký tự
  → script từ chối (exit 2), không mã hóa bằng khóa rỗng.
- `BACKUP_OFFSITE=s3://<bucket>/<prefix>` khi có key — hiện là cổng cấu
  hình: script KHÔNG gọi mạng, exit 3 + `[external-dep]`.
- `DRILL_DATABASE_URL` trỏ Postgres trên VM diễn tập riêng.
- systemd timer: 01:30 hằng ngày `python scripts/db_backup.py`; 03:00 Chủ
  nhật `python scripts/db_restore_drill.py`. Exit 3 = local OK nhưng
  offsite chưa xong → cảnh báo, khác exit 1 (dump lỗi).

Khôi phục ĐÈ production không có lệnh tự động: tầng 2, người làm tay, báo
TGĐ — xem `docs/handover/sop.md` mục 6.
