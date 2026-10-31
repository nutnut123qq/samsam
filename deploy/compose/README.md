# Docker Compose — hệ thống lõi Sâm Sâm (bản viết lại TS)

Theo `docs/rewrite/KE_HOACH.md` mục 2. Chạy trên **server vật lý của Sâm Sâm** (HĐ TEDO–Sâm Sâm).
Máy dev chỉ kiểm cú pháp: `docker compose --env-file compose.env.example config -q` — KHÔNG `up`/`pull`.

| Service | Vai trò | Mạng |
|---|---|---|
| `postgres` | DB nghiệp vụ `samsam` + pgvector (`pgvector/pgvector:0.8.6-pg17-trixie`) | backend |
| `redis` | hàng đợi BullMQ (có mật khẩu) | backend |
| `keycloak` + `keycloak-db` | đăng nhập OIDC realm `samsam` (DB riêng, tách khỏi DB nghiệp vụ) | edge, backend |
| `ollama` | `qwen3:8b` (chat) + `bge-m3` (embedding 1024 chiều), GPU | **ai_private** |
| `ai_worker` | OCR (paddle_local/Docling) + STT (faster-whisper), Python | **ai_private** |
| `api` | NestJS REST + webhook (`/healthz`, `/readyz`) | edge, backend, ai_private |
| `worker` | BullMQ thay systemd timer (`deploy/onprem/jobs.json`) | edge, backend, ai_private |
| `web` | Next.js | edge |

- `backend`, `ai_private` là `internal: true`: không ra internet. Ollama/ai_worker chỉ thấy api/worker.
- `edge`: cổng 3000 (web), 3001 (api/webhook), 8080 (Keycloak) chỉ mở trên `WG_BIND_IP`.
- Ollama: `OLLAMA_NUM_PARALLEL=1` (1 request song song — chatbot hạn tổng 30 s), `OLLAMA_NO_CLOUD=1`.
  Cloud (Claude) chỉ đi từ api/worker khi `data/ai_policy.json` cho phép đúng tính năng; **không tự
  fallback từ local lên cloud**.

## 1. WireGuard (truy cập nội bộ)

1. Server: `wg0` địa chỉ `10.8.0.1/24` (đặt `WG_BIND_IP` theo IP này), `ListenPort 51820/udp` là cổng
   DUY NHẤT mở ra WAN. Firewall chặn 3000/3001/8080 trên mọi interface khác `wg0`.
2. Mỗi người dùng/thiết bị một peer (khóa riêng, `AllowedIPs = 10.8.0.1/32` phía client). Thu hồi người
   nghỉ việc = xóa peer + khóa tài khoản Keycloak (runbook mục 9 — chấm dứt).
3. Webhook Zalo/Meta cần URL công khai: đặt reverse proxy riêng chỉ chuyển `/zalo-webhook`,
   `/messenger-webhook` tới `api:3001` (HMAC bắt buộc) — CHƯA có trong compose này.

## 2. TLS

Cookie phiên web là `secure` khi `NODE_ENV=production` → cần HTTPS. Dựng reverse proxy nội bộ (CA nội bộ)
cho `WEB_PUBLIC_URL`/`KC_PUBLIC_URL` trên `wg0` — CHƯA có trong compose này (Keycloak chạy
`KC_HTTP_ENABLED=true` + `KC_PROXY_HEADERS=xforwarded` sau proxy).

## 3. Chuẩn bị bí mật

```bash
cd deploy/compose
cp compose.env.example compose.env      # gitignored; thay MỌI CHANGE_ME
chmod 600 compose.env
docker compose --env-file compose.env config -q
```

Login dịch vụ (`UI_/WEBHOOK_/JOB_/LOADER_/BACKUP_DATABASE_URL`) là login Postgres riêng `in role
svc_ui|svc_webhook|svc_job|svc_loader|svc_backup` — Bên B tạo NGOÀI git theo `docs/roles.sql`; không dùng
owner/superuser (api/worker từ chối khi `APPROVAL_ENFORCE=1`).

Bí mật kênh (compose fail ngay khi thiếu biến bắt buộc `:?`):
- api: `ZALO_OA_SECRET` (chế độ thực thiếu → `/zalo-webhook` 503, kể cả `DEPLOY=0`), token Zalo (hoặc token
  store `data/zalo_tokens.json`), `MESSENGER_APP_SECRET`/`MESSENGER_VERIFY_TOKEN`/`MESSENGER_PAGE_TOKEN`,
  `CHANNEL_HASH_SALT` (≥ 32 ký tự, không đổi sau khi chạy thật).
- worker: `RED_ALERT_NOTIFY=email` + `SMTP_*` (cảnh báo đỏ), tùy chọn `HEALTH_*`/`TELEGRAM_*`. Người nhận
  `email:$BIEN` trong `data/red_alert_routing.json` → thêm `BIEN` vào environment của worker.
- `CONTACT_VAULT_KEY` KHÔNG nằm trong api/worker (tiến trình chạy nền không đọc; api mở ra internet qua
  webhook) — lệnh người chạy cần khóa (`crm`, `channels`) truyền riêng:
  `docker compose run --rm -e CONTACT_VAULT_KEY api node_modules/.bin/tsx apps/api/src/cli.ts crm …`.

## 4. Tải model TRƯỚC khi chạy mạng internal

`ollama` nằm trong `ai_private` (internal) nên không tự tải được. Tải một lần qua container tạm có mạng,
cùng volume `samsam_ollama`:

```bash
docker volume create samsam_ollama
docker run -d --rm --name ollama-pull -v samsam_ollama:/root/.ollama ollama/ollama:0.12.6
docker exec ollama-pull ollama pull qwen3:8b
docker exec ollama-pull ollama pull bge-m3
docker exec ollama-pull ollama list      # ghi lại digest model vào sổ tài sản
docker stop ollama-pull
```

Model OCR/STT (paddle det/rec/cls `inference.pdmodel`+`inference.pdiparams`, faster-whisper) chép sẵn vào
`AI_MODELS_DIR` (chỉ đọc trong container) — runbook 10.11. ai_worker không tải model.

## 5. Dựng DB và chạy

```bash
docker compose --env-file compose.env up -d postgres
# schema giữ nguyên bản Python (owner, một lần + mỗi lần nâng cấp):
DATABASE_URL=postgresql://<owner>:<pass>@<postgres>/samsam python scripts/apply_schema.py --roles
DATABASE_URL=... python scripts/apply_schema.py --pgvector
# rồi áp docs/schema_ts.sql (owner, sau --pgvector; idempotent): thêm cột embedding_v2 vector(1024) + HNSW
#   cho chunks/chunks_internal. Quyền svc_webhook ghi nhật ký/ảnh/ghi âm vườn qua Zalo + trigger
#   webhook_garden_guard (chỉ nguồn zalo:garden, tác giả zalo:<mã NV>) nay ở roles.sql/schema.sql (r22 A2)
#   — `apply_schema.py --roles` ở trên đã áp, dùng chung Python/TS, không còn bước riêng.
docker compose --env-file compose.env up -d
curl -s http://10.8.0.1:3001/readyz     # {"ready":true,...}
```

## 6. Ghi chú phiên bản

Tag image ghim ở `docker-compose.yml`; lần kéo đầu trên server, chốt digest (`image@sha256:…`) và ghi vào sổ
tài sản (`data/tai_san_hop_tac.json`). Đổi tag = có chủ đích, kiểm lại `/readyz` + eval trước khi bật.

## 7. Worker BullMQ thay systemd timer

- `worker` đăng ký 34 job của `deploy/onprem/jobs.json` thành job scheduler BullMQ, giờ
  `Asia/Ho_Chi_Minh`, cùng lịch `on_calendar`. Mỗi lượt: khóa advisory chống chạy chồng (bị khóa → exit 75)
  + 1 dòng `job_runs` `job:<tên>` + login dịch vụ theo job (svc_job; `backup` = svc_backup; `restore_drill`/
  `dr_drill` = `DATABASE_URL` quản trị) như `python -m pipelines.job_runs --run <tên>`.
- Bước = lệnh CLI TS cùng cờ (`ts/apps/api/src/jobs.ts`, test `jobs.test.ts` khóa đủ 34 job). `restore_drill`
  (`scripts/db_restore_drill.py`) GIỮ Python — image worker không có Python nên bước đó exit 127 (ghi
  `job_runs` lỗi): giữ job này ở systemd tới khi có Python cạnh worker.
- **KHÔNG bật cùng một job ở cả systemd lẫn BullMQ**: khóa advisory của TS không loại trừ khóa tệp của
  Python → chạy chồng. Chuyển dần: tắt timer `samsam-job-<tên>.timer` rồi thêm `<tên>` vào `WORKER_JOBS`.
  `WORKER_JOBS` TRỐNG = worker exit 78, không lập lịch gì (fail-closed). `all` = cả lịch TRỪ
  `restore_drill`/`dr_drill` (cần Python/docker) — chỉ khi KHÔNG còn timer nào. Worker tự gỡ scheduler của
  job bị bỏ khỏi `WORKER_JOBS`. Chạy tay một job: `cli.ts job-runs --run <tên>` (`--list` xem lịch).
- `dr_drill` cần `DATABASE_URL` quản trị + docker CLI trong worker (compose hiện không cấp) — giữ systemd.
