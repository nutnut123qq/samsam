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

## 4. Hàng duyệt nội dung (MKT)

Ưu tiên thao tác trên tab **Duyệt & Lịch**; CLI tương đương:

```
python -m pipelines.store --pending                  # draft chờ duyệt
python -m pipelines.store --approve 12 --by "Lan"    # duyệt (chỉ khi guardrail ok)
python -m pipelines.store --reject 13 --by "Lan" --note "lý do"
python -m pipelines.store --schedule 12 2026-11-05   # xếp lịch bài approved
python -m pipelines.store --calendar                 # lịch 14 ngày
```

- Mỗi lệnh chỉ làm **1 thao tác** (cố gắn gộp flag → báo lỗi usage).
- `--by <tên người duyệt>` bắt buộc khi approve/reject (audit).
- Approve draft vi phạm guardrail → bị từ chối kèm cảnh báo (không có
  override). Status chỉ đi một chiều `pending → approved|rejected`.
- Xếp lịch chỉ được trên bài `approved` và ngày không quá khứ. **Lịch
  là kế hoạch cho người đăng tay.**

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

**Quy tắc:** không ai được ghi giá trị secret vào code/docs/git;
`.env` nằm ngoài git; khi bàn giao chuyển `.env` + `data/zalo_tokens.json`
cho công ty qua kênh an toàn (không email rõ).
