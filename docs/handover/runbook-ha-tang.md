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

### 9.4 Khi chấm dứt hợp đồng (HĐ 12.3, 13.3d)

| Bước | Hạn | Owner | Bằng chứng |
|---|---|---|---|
| Bàn giao hệ thống, mã nguồn, tài liệu cho Bên B | 15 ngày | Bên A (Quản lý hạ tầng AI) | biên bản bàn giao + commit/tag cuối |
| Xuất bản sao nhật ký cho Bên B (`pg_dump` 3 bảng 9.2) + `--verify-log` sạch | trước khi xóa | Bên A | file dump + sha256 ghi trong biên bản |
| Thu hồi login Bên A (`alter role <login> nologin` / `drop role`), xoay mật khẩu `app_human`/`agent_writer`, đổi `AUTH_MODE` users | ngay khi bàn giao | Bên B (người giữ tài khoản cao nhất) | danh sách login sau thu hồi |
| Xóa MỌI bản sao dữ liệu Bên B do Bên A giữ (máy dev, backup offsite của Bên A, `BACKUP_DIR`/`GARDEN_MEDIA_DIR`/`HR_INBOX_DIR` bản sao, DB test) | 30 ngày | Bên A | biên bản xác nhận xóa có chữ ký hai bên (**external-dep**, mẫu PL05 chưa có) |

Không xóa dữ liệu trên server của Bên B — đó là tài sản Bên B giữ.
