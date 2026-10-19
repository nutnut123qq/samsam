# Triển khai hệ thống lõi trên server vật lý của Sâm Sâm (v12.6 — phương án CHÍNH)

Căn cứ: Hợp đồng hợp tác đầu tư TEDO–Sâm Sâm 2026, Điều 2 (địa điểm triển
khai: hệ thống lõi đặt trên server vật lý của Bên B; Bên B bảo đảm hạ tầng,
hệ thống lõi không xây trên nền tảng miễn phí hoặc nền tảng Hai Bên không
kiểm soát được) và Phụ lục 01 mục 8 "Yêu cầu hạ tầng độc lập". Phương án
cloud ở `deploy/cloud/README.md` KHÔNG phải phương án chính theo HĐ — chỉ giữ
làm tham khảo/dự phòng nếu Hai Bên lập phụ lục điều chỉnh.

- **Dành cho ai:** người vận hành của Bên A (cài đặt, vận hành hằng ngày) và
  người quản trị IT của Sâm Sâm (giữ tài khoản cao nhất, máy, mạng, điện).
- **Làm gì:** dựng Postgres + ứng dụng trên server của Sâm Sâm, bật backup
  hằng ngày có bản sao ngoài hệ thống, diễn tập khôi phục theo mốc, giám sát
  phát hiện sự cố trong 15 phút, đăng nhập nội bộ.
- **Cần gì (external-dep — Sâm Sâm cấp, repo KHÔNG giả lập):** server vật lý
  + nơi đặt máy, UPS/nguồn dự phòng, đường truyền (IP tĩnh nếu mở webhook),
  ổ/NAS thứ hai cho bản sao ngoài, tên miền đứng tên Sâm Sâm, người giữ tài
  khoản quản trị cao nhất, người ký biên bản diễn tập.

## 1. Phân quyền tài khoản (PL01 mục 8b, PL04 mục 3)

| Tài khoản | Ai giữ | Bên A được cấp |
|---|---|---|
| Quản trị hệ điều hành server (root/Administrator), BIOS/iDRAC | Sâm Sâm | tài khoản vận hành riêng, quyền sudo giới hạn theo việc |
| Postgres superuser (`postgres`) | Sâm Sâm | role owner của DB `samsam` (chạy `apply_schema.py`) — KHÔNG superuser |
| Tên miền, DNS, router/firewall | Sâm Sâm | yêu cầu mở cổng qua phiếu |
| Tài khoản kênh bán hàng (Zalo OA, Fanpage, Shopee, TikTok Shop) | Sâm Sâm | quyền vận hành/đọc theo từng kênh |
| Khóa mã hóa backup, `CONTACT_VAULT_KEY` | Sâm Sâm (bản gốc), tách khỏi backup DB | dùng trên server, không mang ra ngoài |
| Kho mã nguồn chung | Hai Bên đều có quyền truy cập (HĐ Điều 2) | quản lý mã nguồn |

Bên A đổi nhân sự → Sâm Sâm thu hồi tài khoản vận hành trong ngày. Không
dùng chung tài khoản cá nhân cho máy.

## 2. Cài đặt trên server

1. Hệ điều hành Linux có hỗ trợ dài hạn (đề xuất — GIẢ ĐỊNH, Sâm Sâm chốt cấu
   hình máy: ≥ 8 nhân, ≥ 32 GB RAM, 2 ổ SSD RAID1, UPS đủ tắt máy an toàn).
2. Postgres 17 cài trên CHÍNH server này, chỉ nghe `127.0.0.1`/LAN nội bộ
   (`listen_addresses`), không mở cổng 5432 ra Internet.
3. Python 3.12 + repo + `pip install -r requirements.txt`.
4. `.env` chép từ `env.example`, điền trên server (KHÔNG commit, KHÔNG gửi
   qua chat). `DATABASE_URL` trỏ `127.0.0.1`.
5. Dựng schema + role (chạy 2 lần phải sạch):
   `python scripts/apply_schema.py --roles` → `python -m ingest.core_store`
   → `python -m ingest.golden_store`.
6. Kiểm: `python -m pytest -q` (máy có DB), `python scripts/eval_qa.py`.

## 3. Đăng nhập nội bộ

- UI Streamlit: `AUTH_MODE=local` (user/mật khẩu scrypt ở `data/users.json`,
  tạo hash bằng `python -m pipelines.auth --hash`) cho truy cập trong mạng
  công ty; `AUTH_MODE=proxy` chỉ khi Sâm Sâm tự chọn và quản lý dịch vụ SSO
  đứng tên công ty. KHÔNG dùng `AUTH_MODE=dev` trên server.
- Streamlit bind `127.0.0.1`, đi qua reverse proxy HTTPS trên chính server
  (chứng chỉ cho tên miền của Sâm Sâm). Firewall không mở cổng 8501.
- Webhook Zalo/Messenger cần HTTPS công khai: reverse proxy + tên miền + IP
  tĩnh của Sâm Sâm. Tunnel miễn phí (`cloudflared --url`, ngrok) CHỈ để thử,
  không phải hạ tầng lõi (HĐ cấm nền tảng miễn phí).

## 4. Backup hằng ngày + bản sao ngoài hệ thống (HĐ Điều 2, PL01 mục 8c)

- `BACKUP_DIR` = thư mục trên server, NGOÀI repo; `BACKUP_KEEP=7`.
- `BACKUP_PASSPHRASE_FILE` = file khóa ngoài repo (Sâm Sâm giữ bản gốc).
- `BACKUP_OFFSITE=dir:<đường dẫn>` trỏ ổ/NAS ở MÁY KHÁC (mount qua mạng
  nội bộ, khác ổ đĩa server) — script chép dump + manifest và kiểm lại
  sha256. Thêm 1 bản xoay vòng mang ra khỏi phòng máy theo lịch của Sâm
  Sâm (ổ rời cất két) = external-dep. `s3://...` hiện chỉ là cổng cấu hình
  (exit 3, không gọi mạng).
- Lệnh: `python scripts/db_backup.py` — exit 0 đạt; 3 = local OK nhưng bản
  sao ngoài chưa xong (vẫn tính KHÔNG đạt ngày đó trong báo cáo nội bộ);
  1 lỗi dump.
- Kết quả từng ngày nằm ở `backup_runs.jsonl`; báo cáo vận hành tháng đếm
  số ngày `status=ok` (tiêu chí PL02: 100% số ngày).

## 5. Diễn tập khôi phục (PL02 mục 2: 30/11/2026, 18/12/2026, sau đó mỗi quý)

- Hằng tuần: `python scripts/db_restore_drill.py` (DB tạm trên chính server,
  tự xóa) → `drill_runs.jsonl`.
- Hằng tháng và trước mỗi mốc: `python scripts/dr_drill.py` (Postgres MỚI
  trong container tạm, giả lập mất server; đo RTO/RPO) → `dr_runs.jsonl`.
  Cần Docker + image `postgres:17-alpine` có sẵn trên máy diễn tập.
- Diễn tập đạt khi `status=ok`; biên bản do người của Sâm Sâm ký
  (external-dep). Khôi phục ĐÈ production không có lệnh tự động — xem
  `docs/handover/sop.md` mục 6.

## 6. Giám sát — phát hiện sự cố trong 15 phút (PL02 mục 2)

- Uptime Kuma theo `deploy/docker-compose.monitoring.yml` (image đã pin
  version). Trên production: đổi `restart: "no"` thành
  `unless-stopped`, giữ bind `127.0.0.1` (xem qua reverse proxy có đăng
  nhập).
- Monitor tối thiểu: Postgres (TCP 5432 nội bộ), Streamlit, webhook Zalo,
  webhook Messenger; chu kỳ 60 giây, báo sau 3 lần lỗi liên tiếp (≈ 3–5
  phút < 15 phút). Kuma chạy trên chính server KHÔNG phát hiện được server
  mất điện — đặt thêm 1 monitor ngoài (máy thứ hai trong LAN hoặc dịch vụ
  heartbeat trả phí của Sâm Sâm) = external-dep.
- Kênh báo (Telegram/SMTP/Zalo) + người nhận ngoài giờ = external-dep.
- Bản tin sức khỏe hằng ngày: `python scripts/health_bulletin.py` — mục Job
  báo KHÔNG CHẠY/TRỄ cho mọi job trong `deploy/onprem/jobs.json` quá
  `max_gap_hours` (v13.7). Bản tin chạy CÙNG máy nên không thay monitor
  ngoài máy.
- Cảnh báo đỏ (v13.7): gửi email qua SMTP của Sâm Sâm — env
  `RED_ALERT_NOTIFY=email`, `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`,
  `SMTP_PASSWORD`, `SMTP_FROM`; người nhận độc lập (Pháp chế/BKS, kể cả người
  trực ngoài giờ) điền `data/red_alert_routing.json` với kênh
  `email:$TEN_BIEN` (địa chỉ để trong `.env` server — repo public). Kiểm:
  `python -m pipelines.red_alert --check-routing` phải exit 0 trước khi tính
  là "có tuyến cảnh báo". Người nhận xác nhận trong 02 giờ (kể cả T7/CN/Tết):
  `python -m pipelines.red_alert --ack <id> --by "<tên>"`.
- Sổ sự cố (v13.7, PL02 mục 2): người trực ghi `python -m
  pipelines.ops_incidents --open ...` ngay khi phát hiện (kèm `--occurred-at`
  lấy từ monitor/log nếu biết), rồi `--event <id> --kind responded` (ack kỹ
  thuật), `fixed` (sửa xong), `customer_resolved` (khách/đối tác đã xử lý —
  đếm riêng). Báo cáo tháng tính 15 phút / 3 giờ / 3 ngày làm việc / 7 ngày.

## 7. Lịch tự chạy (systemd timer)

**v13.7 — dùng bộ unit có sẵn** `deploy/onprem/systemd/` (sinh từ
`deploy/onprem/jobs.json`, test `tests/test_v13_c07_ops.py` giữ khớp): 1
unit mẫu `samsam-job@.service` (sửa `<...>`) + 1 timer/job. Mọi job chạy qua
`python -m pipelines.job_runs --run <tên>`: khóa file `data/job_locks/<tên>.lock`
(hoặc `JOB_LOCK_DIR`) chống chạy chồng — lần trước chưa xong thì lần sau ghi
`job_runs` "chạy chồng — bỏ lượt" (exit 75), không chạy bước nào; mỗi lần chạy
ghi 1 dòng `job_runs` `job:<tên>`. Cài: chép unit vào `/etc/systemd/system/`,
`systemctl daemon-reload`, `systemctl enable --now samsam-job-<tên>.timer`;
xem `python -m pipelines.job_runs --list`, `systemctl list-timers`.

| Job | Lịch (giờ VN) | Việc |
|---|---|---|
| `intel` | 06:45 hằng ngày | thu tin + bản tin thị trường trước 7h; docx P2: kèm `--suggest` (gợi ý chủ đề → hàng duyệt intel) |
| `red_alert_sweep` | phút 05 mỗi giờ | quét tin thị trường → cảnh báo đỏ intel + gửi lại cảnh báo chưa gửi được (48 giờ); leo thang 2 giờ của MỌI cảnh báo đỏ ở job `red_alert_escalate` (v15.1 sửa mô tả, không đổi hành vi) |
| `red_alert_escalate` | 15 phút/lần, mọi ngày (kể cả T7/CN/Tết) | v14.6: leo thang MỌI cảnh báo đỏ gốc quá 2 giờ đồng hồ chưa `--ack` (1 lần/cảnh báo) |
| `anchor_build` | 02:30 hằng ngày | v14.6: gom gốc Merkle nhật ký vườn + hồ sơ lô (`anchor --build`); CHƯA neo ra chuỗi — `--submit` chờ hai bên chọn provider |
| `legal_updates` | 07:15 hằng ngày | v14.6: văn bản pháp luật mới → hàng duyệt Pháp chế (`legal_updates --submit`) |
| `sales_sla` | phút 10 và 40 mỗi giờ (GIẢ ĐỊNH) | v15.1: `sales_director --run` — đẩy việc khối sales (gồm nhắc lead `lead_followup`) + quét SLA handoff A 2 giờ/B 4 giờ giờ làm việc → leo thang |
| `b2b_followups` | 08:30 hằng ngày (GIẢ ĐỊNH) | v15.1: `kd_quote --followups` — nháp nhắc chốt báo giá B2B đã duyệt chưa có kết quả |
| `order_watch` | 08:40 hằng ngày (GIẢ ĐỊNH) | v15.1: `kd_orders --watch` — tỷ lệ hủy/hoàn tuần đã đóng bất thường (đợt theo tuần, chạy lại không nhân bản) |
| `dealer_price_watch` | 08:50 hằng ngày (GIẢ ĐỊNH) | v15.1: `kd_price --dealer-watch` — giá đại lý quan sát tay dưới giá sàn golden |
| `ceo_promo` | 09:00 hằng ngày (GIẢ ĐỊNH) | v15.1: `agents.ceo_promo` — KM/voucher đang chạy lệch bản đã duyệt → hàng duyệt khối ceo |
| `intel_keywords` | 07:45 thứ Hai (GIẢ ĐỊNH) | v15.1: `intel_weekly --suggest-keywords` — gợi ý từ khóa an toàn pháp lý từ file Trends mới nhất |
| `ceo_weekly` | 08:00 thứ Hai | báo cáo TGĐ tuần → hàng duyệt khối ceo |
| `invoice_batch` | 21:00 hằng ngày | lô hóa đơn nháp → hàng duyệt khối finance |
| `content_daily` | 06:00 hằng ngày | 3 nháp bài/ngày |
| `backup` | 01:30 hằng ngày | backup + bản sao ngoài |
| `restore_drill` | 03:00 Chủ nhật | diễn tập khôi phục vào DB tạm |
| `dr_drill` | 04:00 ngày 1 | diễn tập DR (thêm tay trước 30/11, 18/12) |
| `kpi_snapshot` | 23:50 hằng ngày | chụp KPI chat không PII (`chat_kpi_facts`) |
| `health_bulletin` | 07:30 hằng ngày | bản tin sức khỏe |
| `ops_monthly` | 08:00 ngày 1 | báo cáo vận hành tháng trước (`--month prev`); người gửi Bên B trước ngày 05 rồi `--mark-sent` |
| `garden_remind` | 07:05 hằng ngày (GIẢ ĐỊNH) | docx P2: `garden_director --remind --submit` — khoảnh vẫn bỏ trống nhật ký → báo GĐ vùng trồng |
| `intel_weekly` | 07:40 thứ Hai (GIẢ ĐỊNH) | docx P2: `intel_weekly --out-dir data/reports` — báo cáo tuần đối thủ + Trends (lưu, đếm được) |
| `listing_watch` | 08:20 hằng ngày (GIẢ ĐỊNH) | docx P2: `kd_listing --run` — lệch listing sàn → hàng duyệt sales |
| `price_watch` | 08:25 hằng ngày (GIẢ ĐỊNH) | docx P2: `kd_price --run` — giá/KM lệch → nháp hàng duyệt sales |
| `ceo_audit` | 09:10 hằng ngày (GIẢ ĐỊNH) | docx P2: `ceo_audit --report` — so bài đăng/listing đang chạy với bản duyệt |
| `production_week` | 08:10 thứ Hai (GIẢ ĐỊNH) | docx P2: `production bulletin --period week --out-dir data/reports` — bản tin SX tuần + cận hạn |
| `production_month` | 08:15 ngày 1 (GIẢ ĐỊNH) | docx P2: `production bulletin --period month --out-dir data/reports` — bản tin SX tháng |

Khung giờ 6 job v15.1 (`sales_sla` … `intel_keywords`) là GIẢ ĐỊNH của đội
triển khai — chủ khối chỉnh trong `jobs.json` rồi sửa `OnCalendar` timer cùng
tên (test `tests/test_v15_p7_jobs.py` giữ khớp). Cả 6 chạy bằng login
`svc_job` (`JOB_DATABASE_URL`), đã chạy thử qua wrapper trong DB test.

Chưa xác minh trên server thật (external-dep): timer chạy, giờ hệ thống
Asia/Ho_Chi_Minh, monitor ngoài máy báo khi cả server/timer chết.

Mẫu unit cũ (sửa `<>`; `User` là tài khoản vận hành, KHÔNG root):

```
# /etc/systemd/system/samsam-backup.service
[Service]
Type=oneshot
User=<tai_khoan_van_hanh>
WorkingDirectory=<duong_dan_repo>
ExecStart=<duong_dan_python> scripts/db_backup.py

# /etc/systemd/system/samsam-backup.timer
[Timer]
OnCalendar=*-*-* 01:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

| Việc | Lệnh | Lịch đề xuất |
|---|---|---|
| Backup | `python scripts/db_backup.py` | 01:30 hằng ngày |
| Diễn tập tuần | `python scripts/db_restore_drill.py` | 03:00 Chủ nhật |
| Diễn tập DR | `python scripts/dr_drill.py` | ngày 1 hằng tháng + trước 30/11, 18/12 |
| Bản tin sức khỏe | `python scripts/health_bulletin.py` | 07:30 hằng ngày |
| Báo cáo vận hành tháng | `python scripts/ops_monthly.py --month <tháng trước>` | 08:00 ngày 1–2 hằng tháng (hạn gửi Bên B trước ngày 05) |

Bật: `systemctl enable --now samsam-backup.timer`; xem lần chạy:
`systemctl list-timers` và `journalctl -u samsam-backup.service`.

## 8. Dịch vụ bên thứ ba và phương án khi bị ngắt (PL01 mục 8d)

| Dịch vụ | Vai trò | Khi bị ngắt |
|---|---|---|
| Cổng LLM (OpenRouter) | chatbot, soạn nháp | kill switch `data/llm_gateway.json`; chatbot chuyển người (handoff), CSKH trực tay tab "Chưa trả lời" |
| Sàn Shopee/TikTok Shop | dữ liệu đơn, listing | nhập file xuất tay (`python -m ingest.market_csv`) |
| Zalo OA/Messenger | kênh chat | khách vẫn nhắn được; nhân viên trả lời trực tiếp trên công cụ của kênh |

Dữ liệu, cấu hình và lịch sử nằm trên server của Sâm Sâm — ngắt dịch vụ
ngoài không làm mất dữ liệu lõi.
