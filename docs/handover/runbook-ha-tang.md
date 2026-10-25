# Runbook vận hành hạ tầng AI (v3.10)

**Dành cho ai:** người vận hành hạ tầng AI của Sâm Sâm (không phải dev) —
người giữ cho DB, backup, cổng LLM và lịch đóng băng chạy đúng hằng ngày,
báo lên Quản lý hạ tầng AI khi có sự cố.
**Làm việc gì:** đọc nhật ký backup/diễn tập mỗi ngày, chạy diễn tập theo
lịch, xử lý sự cố theo mức S1/S2/S3, giữ luật đóng băng 21/12–10/02, mở
break-glass khi thật cần, tắt agent LLM bằng kill switch, theo dõi trần chi
phí.
**Cần gì:** máy có Python 3.12 + repo + file `.env` đã điền (người phụ
trách cấp — xem `sop.md` mục 9, KHÔNG ghi giá trị bí mật vào tài liệu);
Docker Desktop đang chạy với image `postgres:17-alpine` có sẵn (cho diễn
tập DR); thư mục backup NGOÀI repo (`BACKUP_DIR`); đường dẫn file log
break-glass NGOÀI repo (`BREAK_GLASS_LOG`, đặt trong `.env`).
Mọi lệnh chạy từ root repo.

**Hạ tầng theo HĐ (v12.6):** hệ thống lõi chạy trên server vật lý của Sâm
Sâm (Postgres tự quản trên server đó, tài khoản quản trị cao nhất do Sâm
Sâm giữ) — cài đặt, phân quyền, bản sao ngoài, giám sát, lịch systemd ở
`deploy/onprem/README.md`. Phương án cloud (`deploy/cloud/README.md`) chỉ
còn là tham khảo.

> Những gì runbook này KHÔNG tự động: khôi phục ĐÈ production, bật lại
> agent trong đóng băng, đổi trần chi phí — đều là thao tác NGƯỜI, có
> phiếu, có người duyệt.

## 1. Lịch việc

### Hằng ngày (≈15 phút, buổi sáng)

| # | Việc | Cách làm | Bình thường | Bất thường → |
|---|---|---|---|---|
| 1 | Backup đêm qua | `python scripts/db_backup.py` (nếu chưa có lịch tự chạy) rồi mở dòng cuối `backup_runs.jsonl` trong `BACKUP_DIR` | `status=ok`, có `file` hôm nay | `fail`/`offsite_fail`/không có dòng hôm nay → S2 |
| 2 | Bản tin sức khỏe | `python scripts/health_bulletin.py` (nhánh khác: v3.7) | không mục đỏ | mục đỏ → xếp mức theo mục 2 |
| 3 | Đóng băng / break-glass | `python scripts/break_glass.py --status` | trong mùa đóng băng: 0 cửa sổ còn hạn, hoặc cửa sổ có lý do rõ | cửa sổ không ai nhận → hỏi người mở, đóng nếu không cần |
| 4 | Chi phí LLM | câu SQL ở mục 6 | mọi agent < 80% trần | ≥ 80% → S2 |

### Hằng tuần (Chủ nhật)

- Diễn tập khôi phục vào DB tạm: `python scripts/db_restore_drill.py` →
  dòng cuối `drill_runs.jsonl` phải `status=ok`, `dropped=true`.
- Kiểm `python scripts/zalo_preflight.py` (token Zalo còn hạn) nếu kênh
  Zalo đang chạy thật.

### Hằng tháng + trước 30/11 và 18/12

- Diễn tập thảm họa (DR) trên server MỚI: `python scripts/dr_drill.py`
  (chi tiết mục 3). Dòng cuối `dr_runs.jsonl` phải `status=ok`,
  `container_removed=true`, `tables_checked=14`.
- Soạn biên bản diễn tập (ngày, bản backup, RTO, RPO, kết quả) để Quản lý
  hạ tầng AI ký — **external-dep**: người ký là người thật của công ty,
  runbook không tự đánh dấu đã ký.
- Rà danh sách người giữ quyền break-glass + người giữ khóa mã hóa backup
  còn đúng người (đổi nhân sự → báo Quản lý hạ tầng AI).
- Trước 18/12: chốt mọi thay đổi tính năng — từ 21/12 chỉ còn hotfix.
- Ngày 1–2 hằng tháng: `python scripts/ops_monthly.py --month <YYYY-MM tháng
  trước>` → `data/reports/van-hanh-<tháng>.md` (KPI vận hành, tiêu chí kỹ
  thuật, danh mục tài sản hợp tác). Đọc lại, người của Bên A gửi Sâm Sâm
  TRƯỚC ngày 05 (PL02 mục 3) — script không tự gửi. Mục ghi "chưa có dữ
  liệu" = thiếu nguồn, không phải số 0.

## 2. Mức sự cố S1 / S2 / S3

| Mức | Ví dụ cụ thể | Phản hồi | Gọi ai | Bước đầu tiên |
|---|---|---|---|---|
| **S1** | Chatbot gửi tới khách câu vi phạm guardrail (công dụng chữa bệnh, từ cấm); DB production mất/hỏng; lộ dữ liệu cá nhân khách (SĐT, đơn hàng) | ≤ 15 phút, mọi giờ | Quản lý hạ tầng AI → TGĐ + Pháp chế (dữ liệu cá nhân: xử lý trong 72 giờ) | Vi phạm tới khách: kill switch agent đó NGAY (mục 5). DB mất: KHÔNG tự khôi phục đè — giữ nguyên hiện trạng, báo TGĐ (mục 3). Lộ dữ liệu: ghi lại thời điểm + phạm vi, không xóa log |
| **S2** | Backup/diễn tập fail (`status` khác `ok`, `[ALERT]`); job định kỳ lỗi; agent chạm 80–100% trần chi phí; container DR còn sót | trong giờ làm việc, ≤ 4 giờ | Quản lý hạ tầng AI | Chạy lại đúng lệnh vừa lỗi 1 lần, đọc thông báo `[err]`; vẫn lỗi → báo kèm dòng jsonl cuối |
| **S3** | Cảnh báo lẻ: `[warn]` chưa mã hóa/chưa offsite, 1 câu bot không trả lời được, cảnh báo 80% lần đầu | ≤ 1 ngày làm việc | ghi vào sổ, báo trong họp tuần | Ghi lại, theo dõi xem có lặp không — lặp 3 ngày → nâng S2 |

Không chắc mức nào → chọn mức CAO hơn.

## 3. Backup, diễn tập, DR, khôi phục

| Việc | Lệnh | Làm gì | Đọc kết quả |
|---|---|---|---|
| Backup | `python scripts/db_backup.py` | `pg_dump` + manifest (sha256, số dòng mọi bảng) vào `BACKUP_DIR`, giữ 7 bản | `backup_runs.jsonl` |
| Diễn tập tuần | `python scripts/db_restore_drill.py` | khôi phục bản mới nhất vào DB TẠM `samsam_drill_...` trên server đang chạy, so số dòng, xóa DB tạm | `drill_runs.jsonl` |
| Diễn tập DR | `python scripts/dr_drill.py` | dựng Postgres MỚI trong container docker tạm `samsam-dr-...` (giả lập mất server), khôi phục, so số dòng, đo RTO/RPO, LUÔN xóa container | `dr_runs.jsonl` |

`dr_drill` — biến trong `.env`: `BACKUP_DIR` (bắt buộc),
`BACKUP_PASSPHRASE_FILE` (khi backup mã hóa), `DR_RPO_MAX_HOURS` (mặc
định 24). Mã thoát: 0 đạt · 1 lệch số dòng / lỗi / RPO vượt mục tiêu /
container chưa dọn · 2 cấu hình sai · 3 thiếu docker hoặc image
(`[external-dep]` — bật Docker Desktop; KHÔNG tự `docker pull`, tải image
mới cần người duyệt).

- Thấy `[ALERT] container DR ... chưa dọn` → S2: chạy đúng lệnh `docker rm
  -f <tên>` mà thông báo in ra, rồi `docker ps -a` kiểm không còn
  `samsam-dr-`. Container đó chứa bản sao dữ liệu khách.
- Thấy `[warn] container DR sót từ lần trước` → kiểm tên đó có phải lần
  diễn tập cũ không, rồi xóa tay như trên (script không tự xóa container
  không phải của nó).

**RPO / RTO mục tiêu và giới hạn:**

- **RTO** (thời gian khôi phục, gồm dựng server mới) mục tiêu ≤ 4 giờ —
  `dr_drill` in `RTO ...s` và ghi `rto_seconds`.
- **RPO** (dữ liệu tối đa có thể mất = tuổi bản backup) với pg_dump hằng
  ngày chỉ đạt ≤ 24 giờ. RPO ≤ 15 phút cho leads/đơn hàng/đồng ý cần PITR
  (lưu WAL liên tục ra ổ/NAS ngoài server của Sâm Sâm) — **external-dep**
  (cấu hình trên server thật; diễn tập 30/11 và 18/12).
- Lịch tự chạy trên server của Sâm Sâm (systemd timer: backup 01:30,
  drill Chủ nhật 03:00, DR hằng tháng, báo cáo vận hành ngày 1–2 — mẫu unit
  ở `deploy/onprem/README.md` mục 7) — **external-dep** (cài khi có server).

**Khôi phục ĐÈ production:** KHÔNG có lệnh tự động. Tầng 2 — người làm
tay theo `sop.md` mục 6: báo TGĐ trước, đối chiếu danh sách phiếu xóa dữ
liệu (để không khôi phục lại dữ liệu khách đã yêu cầu xóa), làm sau khi
diễn tập DR trên đúng bản backup đó đã `status=ok`. Sau khi khôi phục:
`python scripts/apply_schema.py` (idempotent) rồi `python scripts/eval_qa.py`
để kiểm chatbot.

## 4. Đóng băng 21/12–10/02 + break-glass

Lịch nằm ở `data/freeze_calendar.json` (bản dev soạn, CHƯA được công ty
duyệt — **external-dep**). Ngày theo giờ Việt Nam, gồm cả 21/12 và 10/02.

Trong đóng băng chỉ được:

| Loại (`kind`) | Nghĩa |
|---|---|
| `hotfix` | sửa lỗi khẩn, phiếu tầng 2 |
| `disable` | tắt hoặc hạ cấp một agent |
| `restore` | bật lại agent về ĐÚNG trạng thái trước khi bị tắt, có RCA + phiếu hotfix tầng 2 |

Bị chặn: `feature` (tính năng mới), `promote` (nâng Shadow → Pilot → Vận
hành), `config`, `migration`. Lịch hỏng/mất → hệ thống coi như ĐANG đóng
băng (chỉ cho 3 loại trên) — báo dev sửa lịch, không tự sửa cho qua.
Cổng deploy `python scripts/deploy_gate.py` ĐÃ nối luật này (v4.0): gọi
`pipelines.freeze.check()` với lịch `data/freeze_calendar.json` và cửa sổ
break-glass còn hạn (`BREAK_GLASS_LOG`). Trong khung, `feature` bị chặn;
`--hotfix` hoặc break-glass còn hạn được qua NHƯNG cổng in dòng `[warn]`
(kèm "người CHƯA xác minh" khi danh sách người giữ quyền còn trống) — ghi
lại phiếu/lý do.

**Break-glass** — cửa sổ ngoại lệ có hạn, cho MỌI loại thay đổi qua:

- Khi nào: sự cố thật cần thay đổi không thuộc 3 loại trên (vd đổi cấu
  hình gấp để chặn lỗi đang tới khách). Không dùng để "tranh thủ" deploy.
- Ai: người trong danh sách người giữ quyền break-glass (TGĐ cấp —
  **external-dep**; danh sách đang rỗng nên lệnh vẫn mở nhưng in
  `[CẢNH BÁO]` và ghi `holder_verified=false`).
- Tối đa 4 giờ, tự hết hạn. Lý do ≥ 10 ký tự (SĐT/email trong lý do tự
  bị che), bắt buộc ghi người.

```
python scripts/break_glass.py --open --reason "Lỗi webhook Zalo, đổi cấu hình gấp" --by "Họ Tên" --hours 2
python scripts/break_glass.py --status
python scripts/break_glass.py --close --reason "Đã xử lý xong, đóng sớm" --by "Họ Tên"
```

- Xong việc → đóng sớm bằng `--close`, đừng chờ hết hạn.
- Đọc log: file `BREAK_GLASS_LOG` (1 dòng JSON/lần mở/đóng, chỉ thêm
  không sửa). `--status` liệt kê cửa sổ còn hạn. Log sửa tay ghi hạn dài
  hơn 4 giờ vẫn chỉ có hiệu lực 4 giờ.

## 5. Kill switch LLM

Mọi lời gọi LLM đi qua `pipelines/llm_gateway.py` theo `agent_id`. Agent
hiện có: `chatbot` (trả lời khách web/Zalo), `content` (Content Studio),
`ingest` (embedding knowledge base). Ngoài ra `smoke`: id dành riêng để
tập kill switch (chỉ có trong cấu hình `data/llm_gateway.json`, không có
luồng thật nào gọi). `mkt_video`
(v6.3 MKT-04 — `pipelines/video_studio.py` viết kịch bản video nháp; cap
tháng riêng 2.0 USD; kill `LLM_KILL=mkt_video` → CLI báo `failed: llm`,
không dựng video). `sx_tracuu` (v10.2 SX-A7, khối SX — `agents/sx_tracuu.py`
tra cứu tài liệu khoa học NỘI BỘ: embed câu hỏi luôn qua gateway, `chat`
chỉ khi `--llm` — mặc định TẮT; cap tháng 1.0 USD ƯỚC TÍNH; kill
`LLM_KILL=sx_tracuu` → embed bị chặn, tra cứu trả "chưa có dữ liệu" kèm
lý do, không gọi chat). `kd_livestream` (v10.1 KD-A9 — `agents/kd_live.py`
lời dẫn kịch bản livestream nháp) và `mkt_youtube` (v10.1 MKT-12 —
`agents/mkt_youtube.py` gói video YouTube dài nháp): cap tháng riêng
2.0 USD mỗi id; kill `LLM_KILL=kd_livestream` / `LLM_KILL=mkt_youtube`
→ CLI báo `[error] llm`, không lưu nháp. (v12.0: gỡ id `projects`, `sx_rnd`
và luồng mật cơ khí cùng module ngoài phạm vi HĐ.) Lấy danh sách mới nhất bằng tìm lời gọi `chat("...")` /
`embed("...")` và hằng `AGENT = "..."` trong `api/`, `pipelines/`,
`ingest/`, `agents/`, `connectors/` (nhờ dev nếu cần).

Tắt một agent (S1 vi phạm tới khách — làm NGAY):

1. Cách nhanh, KHÔNG cần restart: thêm agent_id vào danh sách `"kill"`
   trong `data/llm_gateway.json`, vd `"kill": ["chatbot"]`. Gateway đọc
   lại file mỗi lời gọi → có hiệu lực ngay lời gọi kế tiếp.
2. Hoặc env `LLM_KILL=chatbot,content` — chỉ có hiệu lực sau khi
   RESTART tiến trình (streamlit / `python -m connectors.zalo`).
3. Chatbot bị tắt → kênh Zalo trả câu chuyển nhân viên (handoff); báo
   sales-admin trực tay và theo dõi tab **Chưa trả lời**.

Kiểm kill switch có hiệu lực (chạy ở thư mục gốc repo, không gọi LLM,
không tốn tiền — chỉ chạy cổng kiểm của gateway):

```
python -c "from pipelines import llm_gateway as g; g._gate('smoke'); print('OK: smoke NOT blocked')"
```

- Đã thêm `smoke` vào `"kill"` → lệnh dừng với lỗi
  `GatewayBlocked: agent 'smoke' đang bị kill-switch` = kill có hiệu lực.
- Chưa kill → in `OK: smoke NOT blocked`. Thay `smoke` bằng agent thật
  (vd `chatbot`) để kiểm agent vừa tắt.
- Lỗi khác (`provider whitelist rỗng`, `config ... hỏng`) = cấu hình
  gateway sai → S2, báo dev.
- v13.1: `GatewayBlocked: ... không đọc được chi tiêu tháng` = gateway
  không đọc được `llm_usage` (DB down / thiếu `DATABASE_URL` / role thiếu
  quyền) → MỌI lời gọi LLM bị chặn (fail-closed), chatbot trả câu chuyển
  nhân viên. Xử lý như sự cố DB, không phải lỗi kill switch.

Bật lại: xóa agent_id khỏi `"kill"` (và khỏi `LLM_KILL` + restart). Trong
đóng băng, bật lại = loại `restore`: chỉ về đúng trạng thái trước khi tắt,
cần RCA + phiếu hotfix tầng 2.

## 6. Trần chi phí LLM

- `monthly_cap_usd` trong `data/llm_gateway.json`: trần USD/tháng theo
  agent_id (key `default` cho agent không liệt kê). Env
  `LLM_CAP_DEFAULT_USD` ghi đè `default`.
- ≥ 80% trần → cảnh báo nhưng vẫn gọi (S2: báo Quản lý hạ tầng AI); ≥ 100%
  → chặn, 0 lời gọi tới tháng sau. Cap `0` = tắt agent đó.
- Tháng tính theo giờ Việt Nam. Đổi trần là thay đổi `config` — trong
  đóng băng bị chặn (cần break-glass hoặc chờ hết mùa).
- Xem chi tiêu tháng này (chạy trong pgAdmin/psql, bảng `llm_usage`):

```
select agent_id, round(sum(cost_usd), 4) as usd, count(*) as calls
from llm_usage
where ts >= (date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')
             at time zone 'Asia/Ho_Chi_Minh')
group by agent_id order by usd desc;
```

## 7. Bản tin sức khỏe + cổng deploy

- Bản tin sức khỏe hằng ngày: `python scripts/health_bulletin.py` (nhánh khác: v3.7)
  — tổng hợp backup/drill/chi phí/guardrail; kênh gửi n8n/Telegram là
  **external-dep**. Khi chưa gộp nhánh: đọc tay các jsonl ở mục 1.
- Cổng deploy: `python scripts/deploy_gate.py` — kiểm eval PASS, người
  duyệt, luật đóng băng (`pipelines.freeze.check`, đã nối v4.0) trước mỗi
  deploy.

## 7b. Chuyển backend vector sang pgvector + xoay token sàn (v10.3)

**Chuyển float8 → pgvector** (chỉ khi Postgres đã có extension `vector`;
cloud = **external-dep**: cài extension cần quyền superuser/nhà cung cấp):

1. Cài pgvector trên Postgres (cloud: bật extension trong console nhà cung
   cấp; local: gói pgvector khớp major Postgres).
2. `python scripts/apply_schema.py --pgvector` → `[done] pgvector applied`
   (thiếu extension → `[external-dep]`, exit 3, KHÔNG đụng gì). Migration
   chỉ THÊM cột `embedding_v` + trigger đồng bộ + index HNSW; cột
   `embedding float8[]` giữ nguyên; chạy lại an toàn.
3. `python scripts/vector_eval.py --synthetic 200 --questions` → phải
   `[PASS]` (recall@8 ≥ 0.99, Q1–Q10 pgvector không thấp hơn float8,
   checksum float8 không đổi, container `samsam-vec-*` đã dọn). Chạy trên
   máy có Docker + image `pgvector/pgvector:0.8.6-pg17-trixie` sẵn (không
   tự pull).
4. Đặt `RAG_VECTOR_BACKEND=pgvector` trong `.env`, khởi động lại
   streamlit/zalo (module không tự nạp lại env).
5. Kiểm log: KHÔNG được có `[warn] RAG_VECTOR_BACKEND=pgvector nhưng DB
   thiếu cột` — có = DB chưa migration, chatbot đang tự rơi về float8.

**Rollback:** đặt lại `RAG_VECTOR_BACKEND=float8` + khởi động lại — cột
float8 còn nguyên, không cần migrate ngược, không mất dữ liệu.

**Xoay token sàn (connector API chỉ đọc `python -m ingest.market_api`):**
app key/token Shopee/TikTok là **external-dep** (Partner Center, app chỉ
xin quyền ĐỌC). Token hết hạn → lệnh in `[err] ... HTTP 401`/mã lỗi auth,
exit 1, không ghi gì. Người giữ tài khoản Partner Center cấp token mới →
cập nhật `SHOPEE_ACCESS_TOKEN` / `TIKTOK_ACCESS_TOKEN` trong `.env` (KHÔNG
dán vào chat/ticket/log) → chạy lại lệnh. Chưa có refresh tự động (gap).
Nghi lộ key → thu hồi app secret trên Partner Center trước, rồi thay
`SHOPEE_PARTNER_KEY` / `TIKTOK_APP_SECRET`.

## 8. Checklist bàn giao

Người nhận tick từng mục khi làm xong CÓ người kèm:

- [ ] Đọc hết runbook này + `sop.md` mục 6, 7, 9
- [ ] Chạy 1 lần `python scripts/db_backup.py` và đọc `backup_runs.jsonl`
- [ ] Chạy 1 lần `python scripts/db_restore_drill.py` → `status=ok`
- [ ] Chạy 1 lần `python scripts/dr_drill.py` → `status=ok`, `docker ps -a` không còn `samsam-dr-`
- [ ] Thử break-glass trên log TẠM (`BREAK_GLASS_LOG` trỏ file nháp ngoài repo): `--open` → `--status` → `--close`
- [ ] Thử kill switch trên `smoke` (thêm vào `"kill"` → chạy lệnh kiểm mục 5 thấy `GatewayBlocked` → xóa ra → chạy lại thấy `OK: smoke NOT blocked`)
- [ ] Nhận danh sách người giữ quyền break-glass + người giữ khóa mã hóa backup (**external-dep** — công ty cấp)
- [ ] Ký biên bản nhận bàn giao với Quản lý hạ tầng AI (**external-dep**)

## 9. Danh tính người duyệt, nhật ký, Bên A, chấm dứt hợp đồng (v13.5)

Căn cứ: HĐ 6.7 + 7.1–7.3, 12.3, 13.3d; PL01 mục 8 (mỗi phòng ban 1 người
duyệt là nhân sự Bên B). Code: `pipelines/auth.py` (`authorize`),
`pipelines/approval_queue.py`, `pipelines/store.py`, tab **Duyệt & Lịch**.

### 9.1 Bật chế độ thực (đối chiếu người được ủy quyền)

1. Bên B ký văn bản ủy quyền người duyệt từng khối (**external-dep** — dev
   KHÔNG tự điền). Quản trị chép đúng tên đăng nhập (username/email trong
   `data/users.json`) vào `approvers` của `data/directors/<khối>.json`.
   `approvers` rỗng ở chế độ thực = **không ai duyệt được khối đó**
   (fail-closed, thông báo "CHƯA có người được Bên B ủy quyền").
2. Mỗi người duyệt có 1 tài khoản `data/users.json` (vai trò thuộc
   `approver_roles` của khối) và — nếu dùng CLI — 1 login Postgres RIÊNG:
   `create role <login> login password '<...>' in role app_human;` rồi ghi
   `"db_login": "<login>"` vào entry của họ. CLI chế độ thực chỉ nhận `--by`
   khớp login đang kết nối; UI lấy danh tính từ phiên đăng nhập (không ô gõ
   tên). Agent chạy bằng login `in role agent_writer` (không execute hàm
   duyệt, không sửa/xóa log).
3. `.env`: `AUTH_MODE=local|proxy` (hoặc `APPROVAL_ENFORCE=1` cho máy chỉ
   chạy CLI). Thiếu = chế độ dev: chỉ chặn agent/tự duyệt + in cảnh báo
   "CHẾ ĐỘ DEV".
4. Kiểm: `python -m pipelines.approval_queue --approve <id> --by "<tên lạ>"`
   phải exit 1; người đúng khối + đúng login → exit 0.

Mọi lần bị từ chối ghi `agent_action_log` action `authz_denied` (người,
khối, hành động, lý do). Mọi quyết định duyệt ghi `approvals` (sha256 nội
dung, `db_role` = login thật) + `agent_action_log` (hash chain, người, sha,
kết quả). Function duyệt trong DB tự chặn người quyết dạng `agent:`/
`system:`/`auto_policy:` kể cả khi gọi thẳng SQL.

### 9.2 Nhật ký toàn kỳ (HĐ 7.2)

- Bằng chứng dài hạn = bảng `agent_action_log` + `approvals` + `decisions`
  (append-only, trigger chặn UPDATE/DELETE/TRUNCATE kể cả owner). KHÔNG dùng
  `data/conversations.jsonl` (convlog xoay 30 ngày, có nội dung khách) làm
  bằng chứng duyệt.
- Kiểm hằng tuần: `python -m pipelines.store --verify-log` (exit 1 = chuỗi
  hỏng → sự cố S1). Xóa dòng CUỐI chuỗi chỉ lộ khi có neo ngoài
  (`agents.bks_audit` ghi neo đuôi theo tháng).
- Hai Bên truy cập/sao chép: Bên B qua login `in role app_human` /
  `bks_reader`; Bên A (vận hành kỹ thuật) qua login vận hành. Sao chép:
  `pg_dump -t agent_action_log -t approvals -t decisions --data-only`.

### 9.3 Bên A xem số liệu (HĐ 7.3)

- Login thật do hạ tầng Bên B tạo: `create role <login_ben_a> login password
  '<...>' in role ben_a_reader;` — chỉ đọc `v_ben_a_settlement_daily`,
  `v_ben_a_orders_daily`, `revenue_quarters` (không mã đơn, không PII, không
  bảng gốc, không ghi). Test: `tests/test_v13_c04_authz.py::
  test_ben_a_login_reads_numbers_only` (login thật, không superuser).
- Lưu ≥180 ngày: không job nào xóa `settlement_rows`/`orders` nguồn thật/
  `revenue_quarters` (`data/retention.json` không có mục này); backup hằng
  ngày giữ theo mục 3. Bảo trì làm gián đoạn > 24 giờ phải báo trước Bên A.
- v14.2: DB tự chặn — `settlement_rows` APPEND-ONLY (UPDATE/DELETE/TRUNCATE
  bị trigger chặn kể cả owner); `orders` không mẫu không xóa/không đổi mã/
  không chuyển thành mẫu/không TRUNCATE, mọi lần đổi giá trị (trạng thái
  theo snapshot sau) ghi 1 dòng `order_history` (giá trị cũ + mới,
  append-only). File quyết toán sai: nạp file đúng (khoản xuất lại xử lý ở
  `v_settlement_khoan`), KHÔNG xóa dòng cũ.
- `agents.bks_audit` theo dõi quyền `ben_a_reader`: SELECT ngoài 3 bảng/view
  trên hoặc bất kỳ quyền ghi nào → phát hiện `quyen_vuot`.

### 9.4 Khi chấm dứt hợp đồng (HĐ 12.3, 13.3d)

| Bước | Hạn | Owner | Bằng chứng |
|---|---|---|---|
| Bàn giao hệ thống, mã nguồn, tài liệu cho Bên B | 15 ngày | Bên A (Quản lý hạ tầng AI) | biên bản bàn giao + commit/tag cuối |
| Xuất bản sao nhật ký cho Bên B (`pg_dump` 3 bảng 9.2) + `--verify-log` sạch | trước khi xóa | Bên A | file dump + sha256 ghi trong biên bản |
| Thu hồi login Bên A (`alter role <login> nologin` / `drop role`), xoay mật khẩu `app_human`/`agent_writer`, đổi `AUTH_MODE` users | ngay khi bàn giao | Bên B (người giữ tài khoản cao nhất) | danh sách login sau thu hồi |
| Xóa MỌI bản sao dữ liệu Bên B do Bên A giữ (máy dev, backup offsite của Bên A, `BACKUP_DIR`/`GARDEN_MEDIA_DIR`/`HR_INBOX_DIR` bản sao, DB test) | 30 ngày | Bên A | biên bản xác nhận xóa có chữ ký hai bên (**external-dep**, mẫu PL05 chưa có) |

Không xóa dữ liệu trên server của Bên B — đó là tài sản Bên B giữ.

### 9.5 Quyết định người ở CLI ngoài hàng duyệt chung (v14.2)

Mọi CLI `--by` là QUYẾT ĐỊNH (không phải nhập liệu) đi qua
`pipelines.auth.cli_gate` → `authorize` — chế độ thực: người thuộc
`approvers` của ĐÚNG khối (hoặc danh sách riêng của việc đó), có tài khoản
users file, `--by` khớp `db_login` của login Postgres đang dùng; bị chặn →
`authz_denied`. Dev: chỉ chặn `agent:`/`system:` + in "CHẾ ĐỘ DEV".

| CLI | Khối / danh sách | Hành động |
|---|---|---|
| `pipelines.production approve\|reject --run` · `intake --lot` | production | approve/reject · intake |
| `ingest.golden_store --approve-price` | sales | approve_price |
| `pipelines.qr_trace sign` | `data/qr_signers.json` vai đó | sign |
| `pipelines.qr_trace issue` · `revoke` | `data/qr_signers.json` (3 vai) | issue · revoke |
| `agents.xnqc --set` | legal_hr | set_status |
| `pipelines.rollout --promote\|--severe\|--disable` | phòng ban của tính năng | promote/severe/disable |
| `pipelines.red_alert --ack` (+ `intel_alert --ack`) | người nhận độc lập `data/red_alert_routing.json` | ack |
| `ingest.crm --consent\|--assign\|--handoff\|--load-dealers` | sales | consent/assign/handoff/load_dealers |
| `ingest.doc_intake --verify\|--reject` | legal_hr | verify/reject |
| `agents.fp_pnl --cogs-approve` | finance | approve |
| `agents.garden_director --purge-sample\|--adopt-plot` | farming | purge_sample/adopt_plot |
| `ingest.kb_internal --approved-by` (v14 vá review) | data_platform — cổng chạy trên login CỦA NGƯỜI (`DATABASE_URL`) TRƯỚC khi đổi sang `LOADER_DATABASE_URL` để ghi | approve |

KHÔNG qua cổng (nhập liệu/ghi sổ, người chịu trách nhiệm ghi `--by`):
`crm --add-contact\|--status`, `xnqc --add`, `rollout --seed`,
`ops_incidents`, `ops_monthly --mark-sent`, `cockpit --import`,
`garden_media`, `zalo_garden --done`, `channels --suggest`, `ceo_decisions`,
`agent_eval --propose-*` (đề xuất → hàng duyệt), `break_glass` (không có kết
nối DB — danh sách `break_glass_holders`).

v15.4: hở "CLI người ghi bảng TRỰC TIẾP, login `in role app_human` không
có quyền" (giá, hồ sơ XNQC, sổ triển khai, CRM, tài liệu, khoảnh, bài đối
tác) đã đóng bằng function nghiệp vụ SECURITY DEFINER — xem 9.7. Các `--by`
chưa xếp loại trước v15 nay đã xếp ở 9.7 (bảng P10.2).

### 9.6 Login dịch vụ (v14.2)

Mỗi dịch vụ không phải người chạy 1 login RIÊNG (hạ tầng Bên B tạo NGOÀI
git) trong role nhóm của `docs/roles.sql` khối v14.2, trỏ biến DSN riêng:

| Dịch vụ | Role nhóm | Biến DSN | Tiến trình |
|---|---|---|---|
| Webhook Zalo OA / Messenger | `svc_webhook` | `WEBHOOK_DATABASE_URL` | `connectors.zalo`, `connectors.messenger` |
| Job lịch (agent) | `svc_job` | `JOB_DATABASE_URL` | `pipelines.job_runs --run <job>` (mọi job trừ dưới) |
| Nạp file | `svc_loader` | `LOADER_DATABASE_URL` | `ingest.core_store\|golden_store (nạp)\|market_csv\|settlement_csv\|inventory_csv\|intel_import\|embed_store\|kb_internal\|lead_store`, `agents.kd_orders` — golden: KHÔNG duyệt giá/map, KHÔNG quyết/xóa phiếu lệch đã quyết (UPDATE chỉ cột `valid_to`/`sku_key,note`/`detail,updated_at`; v14 vá review) |
| Backup | `svc_backup` (CHỈ ĐỌC bảng; v15 fix P8.7c: + EXECUTE `file_output_evidence_backup`) | `BACKUP_DATABASE_URL` | job `backup` (`scripts/db_backup.py`) — ghi bằng chứng đầu ra backup vào DB |
| Bên A | `ben_a_reader` | (công cụ của Bên A) | không có tiến trình trong repo |

```sql
create role zalo_oa_svc login password '<...>' in role svc_webhook;
create role job_svc     login password '<...>' in role svc_job;
create role loader_svc  login password '<...>' in role svc_loader;
create role backup_svc  login password '<...>' in role svc_backup;
```

- Chế độ thực (`APPROVAL_ENFORCE=1` / `DEPLOY` / `AUTH_MODE=local|proxy`):
  thiếu biến dịch vụ → tiến trình KHÔNG chạy (không rơi về
  `DATABASE_URL`); login là superuser, thành viên role sở hữu bảng, hoặc
  không thuộc đúng role nhóm → từ chối có lý do (webhook exit 1, job exit
  78 không chạy bước nào, loader exit 2). Dev: thiếu biến → dùng
  `DATABASE_URL` như cũ.
- `restore_drill` / `dr_drill` tạo DB tạm (CREATEDB) → chạy bằng login quản
  trị hạ tầng, ngoài login dịch vụ.
- Kiểm: `python -m agents.bks_audit --report` — quyền vượt của 8 role
  (`agent_writer`, `app_human`, `bks_reader`, `ben_a_reader`, 4 `svc_*`).
  Test login thật: `tests/test_v14_p2_service_auth.py`.
- Chạy lại `python scripts/apply_schema.py --roles` mỗi bản phát hành (grant
  theo bảng mới; `svc_backup` đọc MỌI bảng hiện có).
- (v15 fix P8.7c) Bằng chứng đầu ra backup TRONG DB: mỗi lần backup thành
  công, CHÍNH `scripts/db_backup.py` (login `svc_backup` của job `backup`) gọi
  function SECURITY DEFINER `file_output_evidence_backup(<bản ghi
  backup_runs>, false)` → 1 dòng sổ APPEND-ONLY `file_output_evidence` (DB tự
  tính khóa `bk:<sha256 bản dump>` + sha phiên bản = sha256 bản ghi; thời
  điểm = đồng hồ DB; login ghi = `captured_by`). AI ĐƯỢC GHI: chỉ login thành
  viên `svc_backup` (hoặc owner ở dev) và KHÔNG thuộc `app_human`/
  `agent_writer`/`svc_loader`/`svc_job`/`svc_webhook`/`bks_reader`/
  `ben_a_reader` — login người lỡ được cấp vào svc_backup vẫn bị từ chối
  (`42501`); không role nào có INSERT/UPDATE/DELETE trên sổ. Bản ghi phải là
  lần backup `ok` đúng khuôn (sha bản dump, tên dump không đường dẫn, ts có
  múi giờ). Ghi không được (login sai / schema cũ) → backup vẫn giữ, exit 4 +
  `[warn]` (job ghi lỗi) — lần đó KHÔNG thành đầu ra đếm được. Backup chạy
  trước bản vá (chỉ có dòng `backup_runs.jsonl`) không có bằng chứng → không
  đếm/không duyệt (không ghi bù tay — app_human/owner không tạo bằng chứng
  thay dịch vụ ở chế độ thực). `agents.bks_audit` cho phép đúng function này
  với svc_backup; function ghi khác = `quyen_vuot`.

### 9.7 Login NGƯỜI ghi qua function nghiệp vụ (v15.4 — P10.1…P10.4)

**Phương án đội triển khai chọn (ĐỀ XUẤT — Bên B/hạ tầng xác nhận):**
function nghiệp vụ SECURITY DEFINER THEO VIỆC, KHÔNG dùng "role người theo
khối". Lý do:

- Quyền tối thiểu: login `in role app_human` chỉ có EXECUTE đúng các
  function dưới — KHÔNG INSERT/UPDATE/DELETE bảng nghiệp vụ (giá, hồ sơ
  XNQC, sổ triển khai, CRM, tài liệu, khoảnh, bài đối tác). Role theo khối
  (vd `human_sales` có UPDATE `price_list`) cho mọi người trong khối sửa
  thẳng bảng bằng psql, vượt mọi kiểm ở code, và `--by` vẫn là chữ tự khai
  → loại.
- Danh tính trong DB, không tin `--by`: mọi function gọi `human_actor(by,
  khối)` — lấy `session_user` (login thật của kết nối) tra bảng
  `human_logins` (login ↔ người ↔ khối). Login chưa ánh xạ / `--by` khác
  người của login / khối ngoài phạm vi / `agent:`/`system:` → lỗi `42501`
  (CLI ghi `authz_denied`, chế độ thực). Gọi thẳng function qua psql cũng
  bị chặn như vậy.
- Bất biến nghiệp vụ kiểm lại TRONG function (khóa dòng, chuyển trạng thái
  hợp lệ, chưa duyệt/chưa đóng, scan đã đối chiếu, ngày không ở tương lai,
  không đè nguồn `manual`); log `agent_action_log` cùng transaction
  (`db_role` = login thật).
- Khóa function: `set search_path from current` (ghim schema lúc tạo —
  chống chèn bảng giả qua search_path), `REVOKE EXECUTE … FROM PUBLIC`,
  `GRANT EXECUTE` chỉ cho `app_human`; `svc_*`/`bks_reader`/`agent_writer`
  không gọi được (test `test_p10_1_functions_locked_down`; `agents.bks_audit`
  báo `quyen_vuot` nếu role chỉ đọc chạy được function SECURITY DEFINER).

| CLI | Function | Khối (`human_logins.blocks`) |
|---|---|---|
| `ingest.golden_store --approve-price` | `approve_price_human` | sales |
| `agents.xnqc --add` · `--set` | `xnqc_add_human` · `xnqc_set_status_human` | (nhập liệu) · legal_hr |
| `pipelines.rollout --promote\|--severe\|--disable` | `rollout_transition_human` | tiền tố mã tính năng |
| `ingest.crm --add-contact` · `--status` | `crm_add_contact_human` · `crm_set_lead_status_human` | (nhập liệu) |
| `ingest.crm --consent` · `--assign` · `--owner` · `--handoff` · `--load-dealers` | `crm_record_consent_human` · `crm_assign_lead_human` · `crm_assign_owner_human` · `crm_handoff_human` · `crm_load_dealers_human` | sales |
| `ingest.crm --report` | `crm_counts` (chỉ đếm) | — |
| `ingest.doc_intake --verify\|--reject` | `doc_review_human` | legal_hr |
| `agents.garden_director --purge-sample` · `--adopt-plot` | `garden_purge_sample_human` · `garden_adopt_plot_human` | farming |
| `agents.ra_kenh --partner-file` | `record_partner_scan_human` | (nhập liệu) |
| `agents.da_pmo --set-status` (v15 fix P10.2) | `milestone_set_status_human` | ceo |
| `agents.da_pmo --apply-due` (v15 fix P10.2) | `milestone_apply_due_human` | (thực thi mục đã duyệt) |
| `agents.da_b2b --handover` (v15 fix P10.2) | `org_batch_rows_human` (đọc lô) + `org_handover_human` | (thực thi mục đã duyệt) |
| `agents.ra_kenh --mark-removed` (v15 fix P10.2) | `channel_post_mark_removed_human` | legal_hr |
| `pipelines.anchor --submit --by <người>` (v15 fix P10.2) | `human_actor` (TRƯỚC khi gửi) + `anchor_receipt_human` | farming |
| `agents.kd_quote --outcome` · `--verify-send [--by]` (v15 fix P10.2) | `b2b_quote_event_human` | (nhập liệu) |

Đọc cấp thêm cho `app_human` (để CLI kiểm trước khi gọi function; không PII):
`price_list`, `golden_discrepancies`, `xnqc_dossiers`, `leads`, `dealers`,
`partner_post_scans`, `sku_master(sku_key)`, `documents` (cột trạng thái —
không `filename`), `document_fields`, `plots(id, source)`, `plot_logs(id,
plot_id, ts, source)`, `garden_media(id, plot_id)`, `affiliate_codes(id,
dealer_code, queue_id, status)``, `anchor_batches`,
`anchor_receipts` (v15 fix P10.2 — hash + thời điểm); `org_prospects` KHÔNG
grant (v8.3) — `da_b2b --handover` đọc dòng của đúng 1 lô qua
`org_batch_rows_human` (danh tính theo login). v15 fix P10.2 THU HỒI INSERT cột `b2b_quote_events`
(v14.4) — ghi qua `b2b_quote_event_human`. KHÔNG `contacts`/`consents`: ciphertext liên
hệ chỉ trả qua `crm_handoff_human` khi có đồng ý `dai_ly` đích danh; quyền
UPDATE cột người phụ trách `leads` (v14.4) đã THU HỒI — đi qua
`crm_assign_owner_human`.

**Bên B làm (external-dep — dev KHÔNG tự điền, repo để trống):**

```sql
create role <login_nguoi> login password '<...>' in role app_human;
insert into human_logins (db_login, person, blocks, granted_by, note)
values ('<login_nguoi>', '<tên đúng như users.json/approvers>',
        array['sales'], '<người ký văn bản ủy quyền>', '<số văn bản>');
-- thu hồi: update human_logins set active = false where db_login = '...';
```

Hai nguồn phải khớp (lệch → bị chặn, fail-closed): `data/users.json`
(`db_login` — cổng `auth.cli_gate` ở CLI) và `human_logins` (DB). Mỗi lần đổi
`human_logins` ghi `agent_action_log` `human_login_change` (trigger). Chỉ owner
đọc/ghi `human_logins`.

**Rủi ro còn lại (ghi rõ, không che):**

- Login owner/superuser: `human_actor` nhận `--by` như cũ (owner vốn ghi thẳng
  được mọi bảng) — chế độ thực KHÔNG cấp DSN owner cho người.
- `rollout --promote` (vá review v15): DB KHÔNG tin số đếm caller truyền —
  `rollout_transition_human` tự đếm lại bằng bộ đếm `feature_rollout.
  count_spec` (chính câu SQL Python đếm, OWNER ghi qua `rollout --seed`;
  app_human/svc chỉ SELECT sổ): ngày làm việc của giai đoạn theo lịch
  `rollout_config.json`, đầu ra DISTINCT rải trên ngày làm việc (≥ 50 / ≥ 5),
  ≥ 1 đầu ra NGƯỜI duyệt + 0 thiếu người + 0 chưa duyệt qua `output_reviews`
  (≥ 10 ngày), 0 lỗi nghiêm trọng — gọi thẳng psql với bằng chứng khai khống
  bị từ chối; tính năng không có nguồn đếm được → không nâng. Kết quả DB đếm
  ghi `feature_rollout_events.evidence.db_recount`. Còn lại: (a) nguồn `file`
  (`conversations.jsonl` của sales-01, `backup_runs.jsonl` của
  data_platform-07.2 — nhật ký trên máy ứng dụng, DB không đọc được): NGƯỠNG
  SỐ LƯỢNG của 2 tính năng này vẫn theo bằng chứng Python (phần DB đếm được
  vẫn phải 0 thiếu người / 0 chưa duyệt). v15 fix P8.7c: data_platform-07.2
  KHÔNG còn nguồn file — đếm sổ DB `file_output_evidence` (bằng chứng do
  dịch vụ backup ghi, mục 9.6) → DB áp đủ ngưỡng PL02 lên số DB đếm; còn
  sales-01 (convlog) theo Python. v15 fix P8.1: convlog CHỈ tính dòng
  `provenance: "live"` do transport kênh thật (`zalo.send_text`/
  `messenger.send_text`) đặt lúc ghi; mock (`scripts/zalo_mock.py`), replay/
  test (transport giả), Streamlit demo, dòng có `is_sample`/`dry_run`/
  `replay`/`mock`/`test` → không tính. Bản ghi CŨ (trước bản vá) thiếu
  provenance KHÔNG được công nhận là đầu ra thật — bộ đếm (`rollout.
  output_facts`) ghi "dòng thiếu provenance" vào `uncounted` (CLI `--status`
  chưa in mục này); KHÔNG sửa tay convlog để thêm provenance
  (đầu ra sales-01 tính lại từ dòng ghi sau bản vá); (b) đổi danh mục `output_sources` /
  bộ đếm trong code / lịch nghỉ mà CHƯA chạy lại `--seed` → DB đếm theo bộ
  đếm cũ (owner chạy `python -m pipelines.rollout --seed --by <tên>` sau mỗi
  lần đổi; `--seed` giữ giai đoạn + mốc, chỉ đồng bộ `count_spec`); dòng sổ
  chưa có `count_spec` → DB từ chối nâng (fail-closed). ~~Login người không
  đọc được nguồn nào thì nguồn đó "không đếm được" ở Python → không nâng.~~
  **Đợt docx P0 (19/10/2026, đã vá):** (a) login người không SELECT được
  bảng nguồn (16 tính năng co_code: consents, audit_runs, recon_results,
  documents, file_output_evidence...) → CLI đọc SỐ DB đếm lại qua
  `rollout_recount_human` (chỉ đọc, cùng bộ đếm `count_spec`) thay vì báo
  "không đếm được"; DB vẫn là bên quyết. (b) `rollout_transition_human` BỎ
  mọi ngưỡng dựa số caller khai (`p_evidence` chỉ lưu vết) — nguồn `file`
  còn trong `count_spec` → KHÔNG nâng. sales-01 (convlog) nay đếm sổ DB
  `file_output_evidence` nguồn `conversations`: webhook (login `svc_webhook`,
  không thuộc role người/loader/job/backup/BKS/Bên A) ghi qua
  `file_output_evidence_chat` ngay sau khi gửi câu bot `provenance: live`;
  DB tự kiểm bản ghi, chỉ lưu khóa/cờ (không câu khách/câu bot/user_hash).
  Câu bot gửi trước bản vá (chỉ có trong convlog) KHÔNG có bằng chứng DB →
  không đếm. Webhook không ghi được bằng chứng (DB down/từ chối) → chỉ cảnh
  báo, khách vẫn nhận tin, đầu ra đó không được đếm (bảo thủ). Sau triển
  khai bản này owner chạy lại `rollout --seed`. Test:
  `tests/test_docx_p0_rollout_gate.py`.
- `rollout --review-output` (v15.2 P8.7 — duyệt TỪNG đầu ra báo cáo/bảng/
  file không có bước người riêng): DB (`output_review_human`) kiểm danh tính
  theo login + khối, quyết định hợp lệ, tính năng có trong sổ, và (v15 fix
  P8.7) TỰ kiểm khóa + phiên bản bằng bộ đếm `count_spec` của sổ (owner ghi
  qua `--seed`; chính câu đếm của cổng PL02): khóa phải là đầu ra nguồn
  bảng/báo cáo của ĐÚNG tính năng trong cửa sổ giai đoạn hiện hành (không
  mẫu, đúng nguồn/loại), không có bước người duyệt riêng, sha = phiên bản
  hiện hành (báo cáo = bản mới nhất). Khóa không tồn tại / sai tính năng /
  sai sha / phiên bản cũ / mẫu / sổ chưa có `count_spec` → DB từ chối, 0 dòng
  sổ, 0 log — gọi thẳng psql không ghi được dòng rác. Nguồn FILE chưa có bản
  chụp tin cậy trong DB (nguồn `{"file": ...}` của danh mục — convlog `cv:`)
  → DB từ chối duyệt khóa file kèm lý do. (v15 fix P8.7c) Backup (`bk:`,
  data_platform-07.2) CÓ bằng chứng tin cậy trong DB: sổ `file_output_evidence`
  chỉ dịch vụ backup ghi (mục 9.6 — app_human/agent/loader/BKS không tạo được
  bằng chứng rồi tự duyệt); danh mục 07.2 đổi nguồn sang `{"table":
  "file_output_evidence", "source": "backup_runs"}` → `count_spec` chứa câu
  đếm sổ → `--outputs`/`--review-output`/cổng PL02 cùng bộ đếm DB: khóa phải
  có trong sổ, không mẫu, trong cửa sổ giai đoạn, sha = bản ghi MỚI NHẤT của
  khóa; khóa giả / sai sha / mẫu / phiên bản cũ / sai tính năng → từ chối.
  SAU KHI CẬP NHẬT bản này owner PHẢI chạy lại `python -m pipelines.rollout
  --seed --by <tên>` (đồng bộ `count_spec` của 07.2 — chưa chạy thì DB còn
  đếm theo nguồn file cũ và từ chối khóa `bk:`). convlog (sales-01) KHÔNG cần
  sổ: câu bot gửi khách không duyệt qua `output_reviews` (gửi thiếu người =
  `unapp`, tự chặn cổng van_hanh). (v15 fix P8.7b) Login người KHÔNG có SELECT bảng nguồn (vd
  `audit_runs` — không cấp thêm): `--outputs [--by]`/`--review-output` chạy
  bằng login người (không superuser/owner, có EXECUTE) liệt kê + kiểm sớm
  qua function SECURITY DEFINER `output_pending_human(fid, by)` — danh
  tính/khối như `output_review_human` (`by` trống = người của login), CÙNG
  bộ đếm `count_spec`/`rollout_db_outputs` trong cửa sổ giai đoạn hiện hành
  (loại mẫu), trả CHỈ khóa + sha phiên bản hiện hành + loại nguồn
  (bang/bao_cao) + quyết định mới nhất, không nội dung bảng nguồn; nguồn file
  không liệt kê và `--review-output` khóa file báo rõ "nguồn file … không
  duyệt qua sổ này". DB vẫn quyết ở `output_review_human`; chỉ app_human
  EXECUTE (svc_*/agent_writer/bks_reader/PUBLIC không). Owner/dev giữ bộ
  đếm Python. Duyệt lại cùng khóa + sha = thêm 1 dòng (append-only, bản mới
  nhất thắng; cổng đếm DISTINCT khóa). Khối chưa có `approvers` (Bên B chưa
  ủy quyền) → chế độ thực không duyệt được → tính năng không lên vận
  hành.
- `crm --assign`: vùng đại lý ↔ tỉnh kiểm ở CLI theo `data/dealer_regions.json`
  (file, không trong DB).
- `rollout --seed`, nạp file golden/core vẫn chạy bằng login triển khai /
  `svc_loader` (thao tác triển khai/nạp, không phải quyết định người).
- ~~Function duyệt có trước v15 (`decide_item`, `approve_draft`,
  `approve_cogs`, `record_lot_intake`, `sign_qr_lot`…) vẫn nhận tên người
  duyệt làm tham số — gọi thẳng psql bằng login `app_human` thì DB chỉ chặn
  agent/tự duyệt (chưa đối chiếu `human_logins`).~~ **Đợt docx P0c (đã vá):**
  trigger `person_login_guard` (BEFORE INSERT) trên `agent_action_log`
  (mọi function quyết định đều ghi log cùng transaction), `red_alert_acks`,
  `san_suggestion_uses`, `ops_incidents`, `ops_incident_events`,
  `cogs_versions`: login NGƯỜI (`in role app_human`, KHÔNG `svc_ui`, không
  owner) ghi tên người → bắt buộc `human_actor` (tên = người của login trong
  `human_logins`; quyết định hàng duyệt chung → đúng khối của mục; phân bổ/
  kiểm nhập lô → production; duyệt giá vốn → finance). Sai → 42501, cả
  function rollback. Dòng `agent:`/`system:` (luồng agent) và dòng
  `authz_denied` (CLI ghi lần bị từ chối) không bị chặn. Hệ quả triển khai:
  MỌI login người dùng CLI phải có dòng `human_logins` (kể cả cho
  `approval_queue --approve`, `store --approve`, `production approve`,
  `fp_pnl --cogs-approve`, `red_alert --ack`, `ops_incidents`).
- **Vá vòng 2 (R1/R2, controller tái hiện sau P0c):** (R1) trước vá, trigger
  bỏ qua kiểm khi tên truyền vào dạng `agent:`/`system:` → login người gọi
  `record_lot_intake(lô, 'passed', 'agent:x')` vẫn ghi được. Nay action QUYẾT
  ĐỊNH của người (`lot_intake`, `alloc_*`, `queue_approve/reject/override_qa`,
  `cogs_approve`, `draft_*`, `qr_lot_sign`, `qr_issue`, `qr_revoke`,
  `qr_lot_link/unlink`) — MỌI login không owner (kể cả `svc_ui`) không ghi bằng
  tên agent/hệ thống/auto_policy (so sau NFKC); login người luôn qua
  `human_actor`. (R2) ký/phát hành/thu hồi QR đòi vai QR của CHÍNH login trong
  bảng `human_qr_roles` (CHỈ owner ghi, mirror `data/qr_signers.json`, 1 login
  ≤ 1 vai đang hiệu lực, đổi → log `human_qr_role_change`; repo TRỐNG). Bên B
  điền: `insert into human_qr_roles (db_login, role, granted_by, note) values
  ('<login>', 'gd_san_xuat|gd_vung_trong|phap_che_qa', '<người ký văn bản>',
  '<số văn bản>');` — thiếu thì `qr_trace sign/issue/revoke` bằng login người
  bị DB chặn (fail-closed). Test: `tests/test_docx_r12_quyen.py`.
- **Login UI `svc_ui` (mới, docx P0c):** Streamlit dùng 1 login chung cho
  mọi người dùng, xác thực theo phiên ở Python (`AUTH_MODE=local|proxy`,
  `auth.authorize`) → hạ tầng tạo `create role <login_ui> login password
  '<...>' in role svc_ui;` (svc_ui kế thừa app_human) và đặt DSN của tiến
  trình Streamlit bằng login này; DB tin tên người UI truyền như trước.
  KHÔNG cấp `svc_ui` cho login người; Streamlit chạy bằng login người thường
  (app_human) thì mọi lần duyệt trên UI bị DB chặn (fail-closed). Rủi ro còn
  lại: ai có DSN của login UI gọi thẳng psql vẫn ghi được tên tùy ý (như
  trước bản vá) — giữ DSN UI như secret, chỉ trên server.

**Bảng xếp loại `--by` chưa xếp trước v15 (P10.2 — đội triển khai ĐỀ XUẤT,
hai bên xác nhận):**

| Lệnh | Loại | Lý do | Cổng |
|---|---|---|---|
| `da_pmo --set-status` | quyết định | đổi trạng thái mốc tiến độ (`xong` = nghiệm thu mốc, căn cứ báo cáo HĐTV/PL01 mục 7) | `auth.cli_gate` khối ceo `set_status` |
| `da_pmo --apply-due` | thực thi mục đã duyệt | quyết định đổi hạn nằm ở `decide_item` (đã qua cổng); lệnh chỉ áp mục approved + sha khớp + hạn cũ khớp, chạy lại = no-op | `auth.cli_identity` (người của chính login) |
| `da_b2b --handover` | thực thi mục đã duyệt | chỉ chuyển lô approved + sha khớp; rejected/expired trả về `moi` | `auth.cli_identity` |
| `kd_care --verify-send` | kiểm (chỉ đọc) | không có `--by`, không ghi — người gửi tự kiểm trước khi gửi | — (`--by` bị từ chối) |
| `ra_kenh --mark-removed` | quyết định | đóng đợt vi phạm S1/S2 = dừng theo dõi SLA gỡ bài; khai sai = bài vi phạm còn trên kênh mà sổ báo đã gỡ | `auth.cli_gate` khối legal_hr `close_violation` |
| `anchor --submit --by <người>` | quyết định (khi `--by` là người) | ở giai đoạn "có người duyệt", người duyệt cho dùng đầu ra = gửi digest ra ngoài; `--by` mặc định `agent:anchor` = đường job (rollout đòi vận hành) | `auth.cli_gate` khối farming `approve` |
| `kd_quote --outcome` | nhập liệu | ghi kết quả khách báo (chốt/không chốt/hủy) — dừng nhắc, không đổi giá/đơn | `auth.cli_identity` |
| `kd_quote --verify-send --by` | nhập liệu | ghi mốc đã gửi sau khi máy kiểm sha khớp bản duyệt | `auth.cli_identity` |

`auth.cli_identity` (nhập liệu/thực thi): mọi chế độ chặn `agent:`/`system:`;
chế độ thực thêm `--by` phải là tài khoản users file có `db_login` = login
đang dùng (không ghi thay tên người khác) — bị chặn → `authz_denied`.

**v15 fix P10.2 — người được phép HOÀN THÀNH được việc:** trước vá, các lệnh
trên qua cổng xong vẫn ghi bảng trực tiếp → dưới login `app_human` báo
`permission denied` (người được ủy quyền không làm được việc); `kd_quote`
INSERT cột thẳng → psql ghi được `recorded_by` là tên người khác. Nay mỗi
lệnh ghi qua function ở bảng function phía trên (cổng Python giữ nguyên làm
lớp 1; DB là lớp 2 không vượt được bằng psql):

- QUYẾT ĐỊNH (`set-status` ceo, `mark-removed` legal_hr, `anchor --submit
  --by <người>` farming): `human_actor(by, khối)` — login phải ánh xạ người
  có khối đó trong `human_logins` (users file + approvers đúng mà
  `human_logins` thiếu khối/thiếu login → DB chặn, `authz_denied`).
- NHẬP LIỆU / THỰC THI (`apply-due`, `handover`, `outcome`, mốc gửi):
  `human_actor(by, null)` + DB tự kiểm mục hàng duyệt đúng khối/loại, ĐÃ
  duyệt, nội dung khớp sha bản duyệt MỚI NHẤT (`verify_publish`), hạn cũ
  (apply-due), số dòng + mã từng tổ chức của lô (handover), 1 kết quả/báo
  giá (outcome).
- Chạy lại: set-status/apply-due/handover/anchor = no-op (exit 0, không ghi
  dòng/log mới); mark-removed/outcome đã ghi → exit 1, DB không đổi; mốc
  `da_gui` ghi MỖI lần gửi (thiết kế v14.4 — mốc nhắc mới).
- `anchor --submit --by <người>`: DB kiểm danh tính TRƯỚC khi gửi digest ra
  calendar (login sai không làm phát sinh lần gửi); biên nhận phải mang đúng
  digest bản kê; login không owner còn đòi giai đoạn `farming-06` là
  `co_nguoi_duyet|van_hanh` trong sổ. Job `agent:anchor` (DSN owner/dịch vụ)
  ghi thẳng như cũ, vẫn qua cổng rollout ở Python.

Rủi ro còn lại P10.2 (ghi rõ): (a) cổng rollout biên DÙNG (`aq.verify` →
`use_reason`, theo danh mục `data/contract_features.json`) của apply-due/
handover/verify-send vẫn ở Python — gọi thẳng function bằng psql áp được mục
đã duyệt dù tính năng đang chạy thử (DB vẫn đòi người + mục approved + sha);
(b) `anchor_receipt_human` đọc giai đoạn trong sổ DB, KHÔNG đọc
`rollout_config.json` — đặt `"enforce": false` thì Python cho dùng nhưng DB
vẫn đòi sổ ở `co_nguoi_duyet|van_hanh`; (c) handover: DB kiểm bản duyệt +
thành viên lô (số dòng + mã), so từng ô tổ chức dựng lại ở Python (login
người không sửa được `org_prospects`); (d) mốc `da_gui` không `--by` ghi
không tên (như trước) — DB chỉ đòi báo giá đã duyệt + bản gửi khớp sha; so
file gửi với bản duyệt ở Python. Test: `tests/test_v15_fix_p102.py`.

**BKS (P10.3):** login `in role bks_reader` thêm đúng 2 quyền: SELECT
`feature_rollout` (biên sinh báo cáo đọc giai đoạn — trước đây đọc lỗi → coi
như chạy thử → tính năng TẮT vẫn sinh) và INSERT 4 cột `report_outputs` (sổ
đầu ra để báo cáo `bks-audit-*`/`bks-recon-*` được đếm). Không SELECT/UPDATE/
DELETE `report_outputs`, không `feature_rollout_events`.

**Kiểm lại (P10.4, login thật):** `svc_loader` không gọi được function người,
không UPDATE duyệt giá/map/phiếu lệch, không đọc `human_logins`; người tạo
mục hàng duyệt / người lập giá vốn không tự duyệt (DB chặn); log từ chối
không commit việc dở của caller. Test: `tests/test_v15_p10_human_authz.py`.

## 10. Staging tách production + diễn tập (đợt hợp đồng 20/10/2026, G5)

Mục tiêu: cài lặp lại được, thử nâng cấp/khôi phục/sự cố mà KHÔNG chạm DB,
kênh hay khách thật. Chưa có quyền deploy production/bật lịch thật — mục này
là gói chuẩn bị để review; người có quyền thực hiện trên server Bên B.

**10.1 Tách môi trường (bắt buộc trước mọi diễn tập)**

| Thành phần | Staging | Kiểm |
|---|---|---|
| DB | database tên riêng (vd `samsam_staging`), KHÔNG phải `samsam`; login riêng | in `current_database()` trước khi chạy; mọi lệnh có `DATABASE_URL` tường minh — `.env` chỉ là fallback (`load_dotenv` không ghi đè biến đã đặt) |
| Credential | không dùng token Zalo OA/Meta/SMTP/sàn production | `DEPLOY` tắt → Zalo **và** Messenger dry-run (Zalo từ đợt này, `tests/test_zalo.py::test_send_text_dry_run_when_deploy_off`) |
| Cảnh báo | `RED_ALERT_NOTIFY` trống hoặc hộp thư thử | `red_alert --check-routing` |
| Lưu trữ | `BACKUP_DIR`, `GARDEN_MEDIA_DIR`, `DOC_ORIGINALS_DIR`, `HR_INBOX_DIR` riêng | không trỏ thư mục production |
| Webhook / tên miền | URL staging; `B2B_FORM_ENABLED` trống; không triển khai `qr_trace site` lên tên miền thật | — |
| Lịch | KHÔNG bật timer staging trên máy production | `systemctl list-timers` |

**10.2 Nâng cấp (checklist migration)** — đã diễn tập trên DB thử
`samsam_contract_up` từ baseline `dda0089` (evidence
`evidence/contract_g_upgrade.log`):
1. `python scripts/db_backup.py` (backup trước thay đổi) — ghi sha256 bản dump.
2. `python scripts/apply_schema.py --roles` hai lần (idempotent).
3. So bảng/số dòng/đuôi chuỗi `agent_action_log` trước–sau; diff quyền chỉ
   được có phần ghi trong DONE (đợt này: `svc_job` EXECUTE
   `verify_action_log` + SELECT `audit_runs(id, kind, params)`).
4. `python -m pipelines.store --verify-log`, `python -m agents.garden_director
   --verify`.
5. Owner: `python -m pipelines.rollout --seed --by "<owner>"` (catalog đổi →
   `count_spec` mới; giai đoạn/ngày cũ giữ nguyên, không tự công nhận).
6. Probe quyền bằng login thật không owner (R1/R2 + quyền mới).
7. Rollback: dừng dịch vụ → khôi phục bản dump bước 1 theo mục 3 →
   `--verify-log` → mở lại. Quyền mới chỉ là GRANT — gỡ bằng REVOKE tương ứng.

**10.3 Diễn tập và bằng chứng PL02 mục 2** (staging chứng minh CƠ CHẾ; số
đạt/không đạt chỉ tính trên hạ tầng Bên B):

| Chỉ tiêu PL02 | Cơ chế trong repo | Diễn tập staging | Bằng chứng vận hành cần |
|---|---|---|---|
| Backup 100% số ngày | job `backup` 01:30 + `file_output_evidence` | chạy `db_backup.py`, kiểm dòng bằng chứng | log 100% ngày trong tháng trên server |
| Khôi phục 30/11, 18/12, mỗi quý | `db_restore_drill.py`, `dr_drill.py` | restore vào DB tạm, đối chiếu dòng/FK/chuỗi | log diễn tập trên server Bên B đúng ngày |
| Phát hiện sự cố ≤15 phút | bản tin sức khỏe (mục 7), `job_runs` `max_gap_hours`, `red_alert_escalate` 15 phút | dừng 1 job, DB down (DSN host chết) | sổ `ops_incidents` `detected_at` thật |
| Phản hồi nghiêm trọng ≤3 giờ / thường ≤3 ngày LV / sửa ≤7 ngày | `ops_incidents --event responded/fixed` | mở 1 sự cố thử, ghi sự kiện | sổ sự cố tháng + `ops_monthly` |
| Chatbot ≤30 giây | `api.rag.DEADLINE`, `zalo._SEND_DEADLINE` | đồng hồ giả trong test | `chat_kpi_live` reply_ms từ convlog live |
| Cảnh báo đỏ xác nhận ≤2 giờ (KPI mục 3) | `red_alert --escalate` | cảnh báo thử chưa ack | `red_alert_acks` trên server |
| Nhật ký bị sửa → báo (PL01 Ban TGĐ) | job `chain_watch` 06:20 (`bks_audit --chain-alert`) | sửa 1 dòng trên DB thử → 1 cảnh báo, chạy lại không lặp | không cảnh báo giả trên server |

Đồng hồ giả trong test chỉ chứng minh cơ chế; không thay bằng chứng vận hành.
Lệnh nặng (>10 giây) có thể bị đẩy nền — đọc output tới khi process thoát
trước lệnh kế tiếp; không chạy nhiều suite ghi cùng một DB.

**10.4 Bật lịch thật** — chỉ người có quyền triển khai trên server Bên B:
copy `deploy/onprem/systemd/` → `systemctl enable --now` từng timer; job mới
đợt này: `chain_watch`. Job `red_alert_sweep` nay thu RSS mỗi giờ (robots +
≥1s/host vẫn giữ).

**10.5 Vòng 2 (20/10/2026) — thêm cho người vận hành**
- Webhook 24/7 (C01): chép `deploy/onprem/systemd/samsam-webhook-zalo.service`
  + `samsam-webhook-messenger.service`, tạo `/etc/samsam/webhook.env` (chmod
  600, biến theo `deploy/onprem/webhook-env.example`, DB = login `svc_webhook`),
  `systemctl enable --now`; kiểm `curl http://127.0.0.1:8788/readyz` (200 +
  `ready: true`; 503 = cấu hình/DB lỗi). Timer `webhook_health` (5 phút) dò
  `/readyz` → 1 cảnh báo đỏ/đợt.
- Job mới (giờ GIẢ ĐỊNH, người có quyền bật): `channel_scan` 07:00 (crawl
  công khai + `ra_kenh --scan-auto`), `hdtv_month` ngày 03 08:30, `vt_weather`
  06:30 (exit 2 BLOCKED tới khi chọn nguồn dự báo), `vt_harvest` thứ Hai
  08:20, `webhook_health` 5 phút. Cùng wrapper `job_runs` (khóa chống chạy
  chồng; chạy lại không nhân bản — đã chạy thử 2 lần trên DB test).
- Kho phiếu kiểm nghiệm (C03): `LOT_CERT_DIR` NGOÀI repo (trong repo → từ
  chối), backup cùng lịch với kho ảnh vườn; `python -m pipelines.production
  cert-verify` (exit 1 khi thiếu phiếu/thiếu tệp/lệch hash).
- Test trên máy dev/staging: `tests/_db_guard.py` chặn mọi kết nối tới DB
  `samsam` (và dbname trong `.env`); đặt `DATABASE_URL` tới DB test đã dựng
  (`apply_schema --roles` ×2 + `core_store` + `golden_store`), thiếu dựng →
  phiên pytest dừng với hướng dẫn.
  - Hai chế độ (vá 21/10): **unit** — KHÔNG đặt `DATABASE_URL`: test thuần
    chạy, test cần DB tự skip; KHÔNG dùng làm gate. **integration/full** —
    `DATABASE_URL` tới DB test đã dựng: preflight bắt buộc; DB không kết nối
    được, lỗi truy vấn/quyền, thiếu bảng/role/golden → phiên dừng exit 4
    (không thành loạt skip). Preflight chỉ SELECT trên phiên read-only.
  - DSN test phải ghi rõ tên DB (`.../samsam_contract_x` hoặc `PGDATABASE`);
    DSN thiếu tên DB bị chặn (libpq sẽ lấy tên user). `postgres` chỉ dùng khi
    ghi tường minh cho thao tác quản trị tạo/xóa DB test.

**10.6 Đợt hoàn thiện 22/10/2026 — giám sát ngoài máy, lịch mới, DR dev**

- Giám sát NGOÀI server (PL01 Hạ tầng "giám sát lỗi"; data_platform-07.1):
  máy riêng (không phải server Bên B, không cần DSN/khóa) chạy theo lịch
  `python scripts/webhook_probe.py --url <địa chỉ công khai /readyz webhook
  Zalo> --url <địa chỉ /readyz webhook Messenger> --dry-run` (chỉ stdlib, không theo
  redirect, timeout 5 giây; exit ≠ 0 = server/DB/webhook không sẵn sàng) và
  báo qua kênh của CHÍNH máy đó (email/nhắn tin) — server sập thì cảnh báo đỏ
  trong server không gửi được. Thiếu máy giám sát + người nhận = BLOCKED_INFRA
  (Bên B chọn máy/kênh). Job `webhook_health` trong server vẫn giữ.
- Lịch mới `vt_pests` 06:35 (GIẢ ĐỊNH): cảnh báo sâu bệnh từ nhật ký nội bộ
  (`python -m agents.vt_thoitiet --pests --submit`) — không chờ nguồn dự báo
  thời tiết (`vt_weather` vẫn BLOCKED tới khi chọn nguồn).
- Trần chi phí AI theo TÍNH NĂNG: `data/llm_gateway.json` `feature_caps_usd`
  (GIẢ ĐỊNH = trần agent mặc định) + `kill_features`; nút tắt khẩn nhanh:
  biến môi trường `LLM_KILL_FEATURES=<mã>,<mã>` cho tiến trình/timer cần tắt.
- DR trên máy dev đã chạy THẬT bằng Docker (3 ca + CLI, `evidence/contract_g4_dr.log`)
  — chỉ chứng minh CƠ CHẾ trên DB test nhỏ, backup chưa mã hóa/offsite; diễn tập
  Mốc C/D trên server Bên B vẫn phải làm (người có quyền + backup thật + đo
  RTO/RPO thật, ghi `ops_incidents`/sổ nghĩa vụ).

**10.7 Checklist rotation credential từng lộ (quản trị viên — agent KHÔNG làm)**

Hiện trạng (kiểm boolean 22/10/2026, không in giá trị): mật khẩu DB trong
`.env` máy dev TRÙNG giá trị đã lộ trong lịch sử Git của repo public
(`60d9acf^:evidence/v82_pytest.log`, `…_vong1.log`). Release sạch không xóa rủi
ro lịch sử. Thứ tự đề xuất:

1. Liệt kê mọi nơi dùng mật khẩu đó: role Postgres tương ứng trên MỌI máy (dev,
   staging, server Bên B nếu cùng giá trị), `.env`, `/etc/samsam/*.env`, biến
   môi trường timer/systemd, máy CI, máy cá nhân, backup script.
2. Tạo mật khẩu mới (trình quản lý mật khẩu của Bên B), `ALTER ROLE <role>
   PASSWORD '<mới>'` bằng tài khoản quản trị, cập nhật nơi dùng ở bước 1, khởi
   động lại dịch vụ/timer.
3. Thu hồi: kiểm đăng nhập bằng mật khẩu CŨ bị từ chối (từ máy khác); rà
   `pg_hba.conf` (chỉ mạng nội bộ, không mở 0.0.0.0/0); xem log đăng nhập
   Postgres khoảng thời gian từ lần lộ tới lúc đổi (đăng nhập lạ → xử lý sự cố).
4. `OPENROUTER_API_KEY` và token kênh (Zalo/Meta) — nếu từng xuất hiện trong
   log/evidence: thu hồi + cấp mới ở trang nhà cung cấp.
5. Lịch sử Git: quyết định có viết lại lịch sử repo public hay không là của
   chủ repo (ảnh hưởng mọi bản clone; bản đã bị sao chép không thu hồi được) —
   rotation (bước 2–3) là bắt buộc dù có viết lại hay không.
6. Ghi bằng chứng: ngày đổi, role, người đổi, kết quả kiểm bước 3 (không ghi
   giá trị mật khẩu) vào sổ nghĩa vụ/biên bản vận hành.

**10.8 Gói rotation có công cụ (đợt an toàn S01, 22/10/2026)** — quản trị viên
chạy trên ĐÚNG môi trường được giao; mỗi môi trường đóng riêng (đổi ở dev
không đóng server/CI/máy khác). Agent không chạy trên môi trường thật.

| Bước | Lệnh (`scripts/db_rotate_password.py`) | Đạt khi |
|---|---|---|
| 0. Hiện trạng | `--check --role <role> --leaked-git '60d9acf^:evidence/v82_pytest.log' --leaked-git '60d9acf^:evidence/v82_pytest_vong1.log' [--env-file /etc/samsam/<dịch vụ>.env …] [--probe-db <DB thử>]` | in tên biến/tệp dùng role (không in giá trị), `trùng giá trị lộ=True/False`, đường TCP kiểm mật khẩu |
| 1. Đổi | `--rotate --role <role> --admin-env ADMIN_DATABASE_URL --new-password-file <tệp mới, ngoài repo>` | sinh mật khẩu ngẫu nhiên vào tệp (tạo mới, chỉ chủ đọc); server chỉ nhận VERIFIER SCRAM (log câu lệnh không có mật khẩu rõ); thuộc tính role/thành viên không đổi |
| 2. Cập nhật nơi dùng | quản trị viên sửa EnvironmentFile/`.env`/CI theo danh sách bước 0, khởi động lại dịch vụ | — |
| 3. Kiểm nơi dùng | `--verify-consumers --role <role> --env-file …` | mọi biến DSN của role kết nối được (exit 0) |
| 4. Kiểm thu hồi | `--verify --role <role> --dsn-env <biến DSN TCP> --new-password-file … --leaked-git …` | mới `ok`; mật khẩu SAI ngẫu nhiên `28P01` (chứng minh đường kiểm mật khẩu, không trust/peer); cũ `28P01` → exit 0. Đường không kiểm mật khẩu → exit 3 KHÔNG KẾT LUẬN (kiểm từ máy/đường có scram) |
| 5. Ghi bằng chứng | ngày, môi trường, role, người thực hiện, exit bước 3–4 (KHÔNG giá trị) → sổ nghĩa vụ | — |

Không có "khôi phục mật khẩu cũ": nơi dùng lệch → sửa nơi dùng bằng mật khẩu
MỚI hoặc chạy `--rotate` lần nữa với mật khẩu mới khác. Không mở rộng
`pg_hba`/`listen_addresses`, không cấp thêm quyền để chữa lỗi kết nối. Kiểm
cơ chế: `tests/test_safety_s01_rotation.py` (Postgres Docker tạm). Hiện trạng
22/10/2026: dev `.env` (role `postgres`, localhost TCP scram) CÒN trùng giá trị
lộ — `evidence/safety_s01_check.log`; dev listen chỉ `localhost`, `pg_hba`
scram cho local/127.0.0.1/::1. Server Bên B/CI/máy khác: CHƯA kiểm.

**10.9 Quyết định ở UI bằng login người (đợt an toàn S04, 22/10/2026 — bổ sung mục 9.1/9.7)**

- Từ bản này login UI dùng chung (`in role svc_ui`) KHÔNG ghi được quyết định/
  nhật ký mang tên người (DB 42501) — chỉ đọc và ghi dòng của agent.
- Chế độ thực (`AUTH_MODE=local|proxy` hoặc `APPROVAL_ENFORCE=1`): tab "Duyệt &
  Lịch" hiện form "Mở quyền quyết định" — người dùng nhập MẬT KHẨU POSTGRES
  CỦA CHÍNH HỌ cho login `db_login` ghi trong `data/users.json`; UI mở kết nối
  bằng login đó (`pipelines.auth.person_connect`), không lưu mật khẩu; DB đối
  chiếu `human_logins` (người + khối) ở mọi quyết định. Người khác khối, tự
  duyệt, tên agent → bị chặn ở DB kể cả gọi thẳng SQL.
- Draft nội dung mang khối sở hữu (`content_drafts.block`, code ghi lúc tạo);
  draft cũ không có khối → `marketing`.
- (Vá controller S04b, 22/10/2026) `created_login` = login tạo (DB ghi, caller
  không khai được) trên `content_drafts`/`approval_queue`; login người tạo draft
  phải mang tên CHÍNH mình (nhãn `agent:`/`system:`/`auto_policy:` bị 42501) và
  khối do hệ thống xác định (draft của người → `marketing`); mục hàng duyệt
  nhãn agent do CLI người khởi chạy (vd `ra_kenh --partner-file`) giữ nhãn,
  tác giả thật = login. Duyệt/quyết/override: login = login tạo hoặc tên trùng
  tác giả (chuẩn hóa) → 42501. Agent CHẠY bằng login dịch vụ (`svc_job`), không
  bằng login người — chạy agent bằng login người không còn tạo được draft
  nhãn agent.
- (Vòng r8) Một NGƯỜI nhiều login: duyệt/quyết/override/duyệt giá vốn bị chặn
  khi login tạo và login quyết cùng ánh xạ MỘT người trong `human_logins` (kể
  cả login cũ đã khóa). Giá vốn (`cogs_versions`) cũng ghi `created_login`,
  login người không lập giá vốn bằng nhãn agent.
- (Vòng r8) Mỗi lần "Mở quyền quyết định" thành công ghi `human_login_checks`
  (login, người, thời điểm DB — không mật khẩu); ma trận nghiệm thu đòi bằng
  chứng này (B3) + login còn dùng được lúc kiểm (B2: LOGIN, chưa hết hạn VALID
  UNTIL, giới hạn kết nối ≠ 0, CONNECT, app_human, không superuser). Sau khi
  cấp login, mỗi người duyệt mở phiên UI một lần để có bằng chứng.
- (Vòng r9) Bằng chứng B3 chỉ tính cho ĐÚNG login VÀ ĐÚNG người ánh xạ hiện
  hành (chuẩn hóa `p10_norm`): đổi `human_logins` của một login sang người
  khác → người mới phải tự mở phiên một lần; lịch sử đăng nhập của người cũ
  giữ nguyên (append-only) nhưng không tính.
- Quản trị chuẩn bị cho từng người duyệt: login Postgres riêng (`in role
  app_human`, KHÔNG svc_ui/superuser), dòng `human_logins` (CHỈ owner ghi,
  theo văn bản ủy quyền), `db_login` trong `data/users.json`.
- Proxy/SSO: định danh SSO chưa nối với danh tính DB — người dùng vẫn phải mở
  quyền bằng login Postgres riêng; nối SSO ↔ DB (vd chứng chỉ/GSS) là quyết
  định kiến trúc của Bên B, chưa làm.

**10.10 Thay đổi giao diện/quyền đợt r12 (24/10/2026 — kiểm kỹ thuật nội bộ, chưa nghiệm thu hợp đồng)**

- Tab **Nhật ký vườn** chế độ thực: `svc_ui` được ĐỌC cột `plots(id, location,
  status)` + `plot_logs(id, plot_id, ts, activity, detail, author, source)`
  (không ghi). GHI nhật ký chỉ bằng login Postgres RIÊNG của người (mở ở tab
  "Duyệt & Lịch") qua function `plot_log_add_human` (SECURITY DEFINER,
  `human_actor(..., 'farming')`): người ghi = người của login, khối `farming`
  trong `human_logins`; không còn ô "Người ghi" tự gõ. Chưa mở quyền → không
  ghi; login của người khác/khối khác/tên agent → 42501, 0 dòng. Người ghi nhật
  ký vườn cần: login `in role app_human` + dòng `human_logins` khối `farming`
  + `db_login` trong `data/users.json` (vai trò UI có tab vườn: `tgd`,
  `ha_tang`). Chế độ dev giữ ô người ghi như cũ.
- Tab **Chat Sâm Sâm**: `svc_ui` được `SELECT chunks` (KB CÔNG KHAI — như
  `svc_webhook`); lỗi đọc KB/LLM → câu thân thiện, KHÔNG hiện traceback/đường
  dẫn mã (lỗi ghi stderr dạng `[warn]` chỉ tên ngoại lệ).
- Chatbot Zalo/Messenger: câu hứa "nhân viên sẽ phản hồi" chỉ gửi khi ĐÃ ghi
  được mục `cskh_handoff` (hoặc đã có mục chờ của khách); không ghi được
  (tính năng tắt — HĐ 6.7 cấm sinh đầu ra, DB lỗi, thiếu muối) → câu có hotline
  1800577732, không hứa. Nhánh quá 30 giây giữ thứ tự cũ (gửi ngay, ghi sau).
- `qr_trace link/unlink` qua `auth.cli_gate` khối `farming` (hành động
  `link_origin`/`unlink_origin`); function `link_lot_origin`/`unlink_lot_origin`
  dùng `human_actor` — tên rỗng/`agent:`/`system:` bị 42501 kể cả login owner.
- `garden_media_mkt --release/--revoke` dùng hành động `media_cap`/`media_thu_hoi`
  (đã thêm vào `auth.ACTIONS`) — chế độ thực theo `approvers` khối farming.
- Guardrail đăng bài: luật mới `pii_ca_nhan` (critical, block — "chờ Pháp chế
  duyệt", mặc định an toàn) chặn SĐT/email cá nhân trong nội dung công khai;
  liên hệ công khai của công ty = `pii_allow` trong `data/llm_gateway.json` +
  hotline 1800577732. Chế độ chat `check()` không đổi.
- CLI bị cổng tắt (nhóm RB/GATE-OUT r12): exit 2 + dòng `[rollout] … <mã tính
  năng>` trên stdout, không traceback, không in nội dung nghiệp vụ, không ghi
  file/DB. CLI đã có giao diện `[blocked] …` trên stderr từ v14.3 (vd
  `hdtv_report`, `acc_ar`, `rev_share`) giữ nguyên.

**10.11 Adapter + công cụ đợt r13 (24/10/2026 — kiểm kỹ thuật nội bộ; mặc định vẫn TẮT, bật = quyết định Bên B/Pháp chế)**

- OCR tại chỗ (production-03, data_platform-02.1): `OCR_PROVIDER=paddle_local`; model PaddleOCR 2.x đặt sẵn ở
  `OCR_PADDLE_MODEL_DIR` (mặc định `~/.paddleocr/whl`, cần đủ `det/en/en_PP-OCRv3_det_infer`,
  `rec/latin/latin_PP-OCRv3_rec_infer`, `cls/ch_ppocr_mobile_v2.0_cls_infer`), MỖI bộ phải có cả `inference.pdmodel`
  lẫn `inference.pdiparams` (không rỗng) — thiếu/rỗng tệp nào → lỗi trước khi khởi tạo PaddleOCR, KHÔNG tự tải
  (r13-fix4 F1: bản r13 chỉ kiểm pdmodel nên thiếu pdiparams vẫn để PaddleOCR gọi trình tải mạng). Tệp có mặt nhưng hỏng
  nội dung không phát hiện được trước khi nạp — chép model từ nguồn đã kiểm sha.
  Trần `OCR_MAX_PAGES` (30) + `OCR_TIMEOUT_S` (300). Kết quả luôn `pending_review` (Pháp chế `--verify`); engine ghi
  `documents.ocr_engine`. Có provider mà OCR không ra chữ → `[cho_ocr]` exit 2 (người đọc bản gốc). Chữ Việt mất một
  phần dấu thanh — đối chiếu người là bắt buộc.
- STT tại chỗ (farming-01): `GARDEN_STT_PROVIDER=whisper_local` + `GARDEN_STT_MODEL_DIR` (thư mục model faster-whisper
  có `model.bin`, tải sẵn, `local_files_only`). Trần `GARDEN_STT_MAX_SECONDS` (600) / `GARDEN_STT_TIMEOUT_S` (300).
  `python -m connectors.zalo_garden --transcribe ID` chỉ IN NHÁP đã che PII; người nghe ghi nhật ký + `--done`. Chạy
  OCR và STT ở TIẾN TRÌNH riêng (ctranslate2 không nạp được sau PaddleOCR trong cùng tiến trình trên Windows).
- Ảnh nền AI (marketing-02.1): `IMAGE_PROVIDER=openrouter_images` + `IMAGE_MODEL` + `OPENROUTER_API_KEY`; trước mỗi
  request qua cổng `llm_gateway` (agent `image`, tính năng `marketing-02.1`: kill, trần tháng, rollout, whitelist);
  tối đa 1 lần thử lại 429/502/503; chi phí ghi `llm_usage` từ `usage.cost`. Packshot không rời máy. HTTP 200 mà ảnh
  hỏng/thiếu/không phải ảnh vẫn ghi ĐÚNG 1 dòng chi phí đã báo (`ok=false`), thiếu `usage.cost` hợp lệ → mức dự phòng
  `image_cost_fallback_usd` (mặc định 0.25) — trần tháng tính cả khoản này (r13-fix4 F2).
- Neo (farming-06): sau `--submit`, chạy `python -m pipelines.anchor --upgrade latest` (≥1 khối Bitcoin sau) → dòng
  `da_nang_cap` khi calendar trả attestation; trạng thái này CHƯA là xác minh bên thứ ba (`--export` + `ots verify`).
  `--upgrade` qua cổng triển khai như `--submit` (r13-fix4 F4): farming-06 chưa vào sổ / chạy thử / tắt → exit 1, 0
  HTTP, 0 dòng; job `agent:anchor` không phải người nên giai đoạn có người duyệt cũng chặn — chỉ chạy ở vận hành.
- API sàn (data_platform-06): 429/5xx thử lại ≤3 lần theo `Retry-After` (trần 30 s); tính năng tắt → `[rollout]` exit 2,
  0 request.
- Sao lưu (data_platform-90/07.2): trên server đặt `BACKUP_REQUIRE_ENCRYPTION=1` (thiếu khóa → exit 2, không ghi bản rõ)
  và `BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE=1` (offsite cùng thiết bị → exit 2). `python scripts/onprem_preflight.py --out
  <tệp>` đo tại máy: DB + pg_dump, 4 login dịch vụ (riêng, không superuser, đúng role), sao lưu (thư mục, mã hóa bắt
  buộc, offsite khác thiết bị, bản gần nhất ≤26 giờ), timer systemd; chỉ đọc biến môi trường tiến trình. Bản gần
  nhất chỉ ĐẠT khi tệp dump THẬT + manifest hợp lệ (mã hóa) có ở CẢ `BACKUP_DIR` lẫn offsite `dir:` và khớp
  size/sha256 manifest, thời điểm trong sổ không ở tương lai (r13-fix4 F3; offsite `s3://` chưa kiểm được → CHUA_DAT).
  Preflight băm toàn bộ tệp dump — chạy ngoài giờ cao điểm nếu dump lớn.
- N22 (ceo-90): DBA dựng 2 bản sao cô lập (backup TRƯỚC sự cố + dump hiện tại) rồi `INCIDENT_BASELINE_URL=…
  INCIDENT_NOW_URL=… python scripts/incident_compare.py --out <tệp>` — chỉ đọc, từ chối dbname `samsam`, báo cáo chỉ số
  đếm/tên; thiếu bản trước = UNVERIFIED.
- Nguồn dữ liệu website (sales-08): trước khi bên website nạp, `python -m agents.listing_export --verify
  <website-feed-….manifest.json>` (sha tệp + giá web ĐÃ duyệt còn hiệu lực + mô tả đã duyệt).

**10.12 Đợt r14 (25/10/2026 — kiểm kỹ thuật nội bộ; evidence `evidence/itacc_r14_code_gaps/`)**

- OCR `paddle_local`: nạp model + render trang + nhận dạng chạy ở TIẾN TRÌNH CON `python -m ingest.ocr_worker` — model
  hỏng (crash native), engine treo hay kết quả hỏng chỉ làm tài liệu đó lỗi (`[err]`, giữ `cho_ocr` khi reprocess), intake /
  `sx_label` chạy tiếp. `OCR_TIMEOUT_S` (300) giờ bọc CẢ nạp model; hết hạn → giết tiến trình con, không ghi kết quả muộn.
  Mỗi tài liệu 1 tiến trình (nạp model ~10 s) — lô scan lớn chạy chậm hơn; tiến trình con không nhận biến DSN/`PG*`.
- Neo (farming-06) giai đoạn có người duyệt: người được Bên B ủy quyền khối farming chạy
  `python -m pipelines.anchor --upgrade latest --by "<người>"` bằng LOGIN Postgres RIÊNG của mình (`in role app_human`, có
  dòng `human_logins`). Kiểm `auth.cli_gate` + `human_actor` TRƯỚC khi hỏi calendar; ghi chỉ qua function
  `anchor_upgrade_human` (app_human không INSERT bảng). Job `agent:anchor` vẫn chỉ chạy ở vận hành. Mỗi lần gom thêm tối đa 1
  dòng `da_nang_cap` MỚI (r14-fix2: trigger `anchor_receipts_upgrade_once` khóa theo lần gom; lịch sử trước đó có thể đã
  có > 1 dòng do 2 upgrade baseline chạy đồng thời — giữ nguyên, CLI báo "N biên nhận da_nang_cap (lịch sử)") — vẫn CHƯA là
  xác minh bên thứ ba.
- API sàn (data_platform-06): kho token JSON NGOÀI repo `MARKET_TOKEN_FILE` (`{kênh: {access_token, refresh_token,
  expire_at}}`, ghi nguyên tử, khóa tệp `<kho>.lock`). Lần đầu: đặt `SHOPEE_REFRESH_TOKEN`/`TIKTOK_REFRESH_TOKEN` từ kết quả ủy
  quyền của chủ shop rồi `python -m ingest.market_api --channel shopee --refresh`; sau đó `--kind listing|order` tự refresh khi
  còn < 1 giờ. refresh_token Shopee DÙNG 1 LẦN — mất kho = chủ shop ủy quyền lại; KHÔNG chạy 2 máy cùng một kho. TikTok
  refresh gửi app_secret trong URL theo tài liệu → không bật log URL ở proxy. Nơi lưu credential cuối cùng (tệp vs kho bí mật)
  là quyết định Bên B. Quyết toán qua API CHƯA có — dùng `ingest.settlement_csv`.
  Lỗi từ sàn chỉ in mã đúng dạng (`error_*` Shopee / số TikTok) — mã khác (có thể phản chiếu token) in "đã ẩn" (r14-fix2).
