# Runbook deploy — Zalo OA webhook (v1.0)

Chạy `python -m connectors.zalo` trên máy/VPS public, Zalo gọi được
`POST /zalo-webhook` (HTTPS bắt buộc khi đăng ký trên console), bot reply
qua send API. Scope: webhook nhận/reply — đăng bài mới vẫn human-gate
(C2.4).

## Env (`.env` — mẫu đầy đủ ở `env.example` root)

| Biến | Vai trò | Thiếu thì |
|---|---|---|
| `OPENROUTER_API_KEY` | chat + embeddings | `answer()` crash (user nhận ERROR_FALLBACK) |
| `DATABASE_URL` | Postgres `samsam` | `answer()` crash |
| `ZALO_APP_ID` | app id (developers.zalo.me → app) | oauth refresh fail |
| `ZALO_APP_SECRET` | app secret — header `secret_key` khi oauth refresh | oauth refresh fail |
| `ZALO_OA_SECRET` | OA secret key — verify signature webhook | `DEPLOY` bật → **refuse to serve** |
| `ZALO_ACCESS_TOKEN` | seed access token lần đầu | không sao nếu có bộ refresh |
| `ZALO_REFRESH_TOKEN` | seed refresh token | không sao nếu có ACCESS_TOKEN còn hạn |
| `ZALO_WEBHOOK_PORT` | mặc định 8788 | dùng 8788 |

**Hai secret khác nhau — đừng trộn**: `ZALO_OA_SECRET` lấy từ OA console
(dùng verify `sha256(appId+data+timestamp+OAsecretKey)`); `ZALO_APP_SECRET`
lấy từ app console developers.zalo.me (dùng oauth refresh). Tên biến nói
đúng vai trò.

## DEPLOY flag — quan trọng

`DEPLOY` chấp nhận `1` / `true` / `yes` (không phân biệt hoa/thường).
**Mọi giá trị khác = dev mode: signature bị bypass** — KHÔNG được public.

Khi `DEPLOY` bật, process refuse-to-serve (exit 1 trước bind) nếu thiếu
`ZALO_OA_SECRET` (webhook nhận request giả mạo) hoặc không có cách nào
send: thiếu `ZALO_ACCESS_TOKEN` và đồng thời thiếu bộ refresh
(`ZALO_REFRESH_TOKEN` + `ZALO_APP_ID` + `ZALO_APP_SECRET`).

## Chạy dev local (signature bypass)

```
python -m connectors.zalo
# [zalo] webhook :8788/zalo-webhook (oa_secret=MISSING, token=MISSING, refresh=MISSING)
```

Test giả event: `python scripts/zalo_mock.py`.

## Access token — auto-refresh (v1.0)

Access token hết hạn ~25h; refresh token 3 tháng và **rotate mỗi lần
dùng** (token cũ vô hiệu ngay khi có token mới). `connectors.zalo` tự
refresh: `send_text` gặp API error → `refresh_access_token()` → retry 1
lần; boot mà chỉ có bộ refresh cũng tự lấy access token mới.

Source-of-truth token là `data/zalo_tokens.json` (gitignored — chứa
token thật): sau lần refresh đầu tiên env chỉ còn vai trò seed. Xóa file
này = mất refresh token mới nhất → nếu env seed cũng cũ thì phải lấy
token mới trên OA console rồi điền lại `.env`.

Fallback tay (refresh token hết hạn 3 tháng không dùng / mất file):
lấy token mới trên console → sửa `.env` → restart.

## Public nhanh qua tunnel (verify live đầu tiên)

Zalo yêu cầu webhook URL **HTTPS**:

```
cloudflared tunnel --url http://localhost:8788
# hoặc: ngrok http 8788
```

Lấy URL https tunnel → đăng ký webhook trên Zalo OA console:
`https://<subdomain>/zalo-webhook`. Nhớ `DEPLOY=1` + đủ env **trước** khi
mở tunnel — tunnel + dev-mode = endpoint không verify nằm public trên
internet.

## VPS chạy dài

- Cần trên VPS: Python 3.12, Postgres (schema `docs/schema.sql` + đã
  ingest), `.env` đủ biến (copy theo `env.example`).
- Process: `docs/zalo-webhook.service` là systemd unit mẫu
  (Restart=always) — sửa 3 chỗ `<>` rồi `systemctl enable --now`.
- Firewall chỉ mở port webhook; Postgres giữ localhost.

## Go-live checklist

1. Cài deps: `pip install -r requirements.txt`
2. `.env` đủ biến theo `env.example` (DEPLOY=1)
3. **`python scripts/zalo_preflight.py`** — PASS hết mới đi tiếp;
   `--refresh` nếu muốn test rotation thật (rotate token thật — token
   cũ vô hiệu ngay)
4. Start service / mở tunnel HTTPS
5. Đăng ký webhook URL trên OA console
6. Nhắn tin thật vào OA → verify reply + `data/conversations.jsonl`
   có entry `sent:true`

## State trên đĩa (đừng xóa)

- `data/conversations.jsonl` — 1 dòng/event, rotate sang `.1` khi >5MB
  (1 bản backup; `question` đã mask SĐT/email). **Retention**: entry cũ
  hơn 30 ngày bị purge lúc boot + tối đa 1 lần/ngày khi ghi + sau rotate.
- `data/zalo_tokens.json` — access+refresh token hiện hành (gitignored).
  Xóa = mất refresh token mới nhất (xem mục token ở trên).
- `data/zalo_seen.db` — dedup `msg_id` (sqlite, TTL 1h). Xóa = Zalo
  retry có thể gây reply nhân đôi.
- History hội thoại in-memory (`_histories`) mất khi restart — chấp
  nhận được, follow-up sau restart coi như hội thoại mới.
