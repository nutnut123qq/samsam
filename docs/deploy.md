# Runbook deploy — Zalo OA webhook (v0.5)

Chạy `python -m connectors.zalo` trên máy/VPS public, Zalo gọi được
`POST /zalo-webhook`, bot reply qua send API. Scope: webhook nhận/reply —
đăng bài mới vẫn human-gate (C2.4).

## Env bắt buộc (`.env`)

| Biến | Vai trò | Thiếu thì |
|---|---|---|
| `OPENROUTER_API_KEY` | chat + embeddings | `answer()` crash (user nhận ERROR_FALLBACK) |
| `DATABASE_URL` | Postgres `samsam` | `answer()` crash |
| `ZALO_APP_ID` | tính signature | signature verify fail |
| `ZALO_APP_SECRET` | tính signature | `DEPLOY` bật → **refuse to serve** |
| `ZALO_ACCESS_TOKEN` | send API reply | `DEPLOY` bật → **refuse to serve** |
| `ZALO_WEBHOOK_PORT` | mặc định 8788 | dùng 8788 |

## DEPLOY flag — quan trọng

`DEPLOY` chấp nhận `1` / `true` / `yes` (không phân biệt hoa/thường).
**Mọi giá trị khác = dev mode: signature bị bypass** — KHÔNG được public.

Khi `DEPLOY` bật, process refuse-to-serve (exit 1 trước bind) nếu thiếu
`ZALO_APP_SECRET` hoặc `ZALO_ACCESS_TOKEN` — quên env = webhook nhận
request giả mạo hoặc ACK-200-nhưng-không-reply (khó chẩn đoán hơn crash).

## Chạy dev local (signature bypass)

```
python -m connectors.zalo
# [zalo] webhook :8788/zalo-webhook (secret=MISSING, token=MISSING)
```

Test giả event: `python scripts/zalo_mock.py`.

## Public nhanh qua tunnel (verify live đầu tiên)

```
cloudflared tunnel --url http://localhost:8788
# hoặc: ngrok http 8788
```

Lấy URL https tunnel → đăng ký webhook trên Zalo OA console:
`https://<subdomain>/zalo-webhook`. Nhớ `DEPLOY=1` + đủ 3 biến `ZALO_*`
trước khi mở tunnel — tunnel + dev-mode = endpoint không verify nằm
public trên internet.

## VPS chạy dài

- Cần trên VPS: Python 3.12, Postgres (schema `docs/schema.sql` + đã
  ingest), `.env` đủ biến.
- Process: systemd unit hoặc `tmux`/`nohup` đều được — process KHÔNG tự
  restart; crash → start lại tay (pilot).
- Firewall chỉ mở port webhook; Postgres giữ localhost.

## Access token (~25h expiry)

`ZALO_ACCESS_TOKEN` hết hạn khoảng 25h. Hiện chưa auto-refresh — khi hết
hạn: lấy token mới trên Zalo OA console → sửa `.env` → restart process.
Auto-refresh (refresh_token flow) là someday — làm sau khi có credential
thật để test được.

## State trên đĩa (đừng xóa)

- `data/conversations.jsonl` — 1 dòng/event, rotate sang `.1` khi >5MB
  (1 bản backup; `question` đã mask SĐT/email — kể cả SĐT viết cách).
  **Retention**: entry cũ hơn 30 ngày (`RETAIN_DAYS`) bị purge tự động
  lúc process start, khi ghi log mới (tối đa 1 lần/ngày) và ngay sau
  mỗi lần rotate — convlog chứa user_hash + PII-lite nên không để nằm
  lại vô hạn.
- `data/zalo_seen.db` — dedup `msg_id` (sqlite, TTL 1h). Xóa = Zalo
  retry có thể gây reply nhân đôi.
- History hội thoại in-memory (`_histories`) mất khi restart — chấp
  nhận được, follow-up sau restart coi như hội thoại mới.
