# Kế hoạch viết lại samsam sang NestJS + Next.js (29/10/2026)

User chọn (29/10): viết lại toàn bộ hệ thống theo mô hình "server AI nội bộ": Next.js (web) + NestJS
(backend + AI Gateway) + Keycloak + PostgreSQL/pgvector + Redis/BullMQ + Ollama (Qwen3 8B) + BGE-M3 +
Docling/OCR + Claude chỉ khi chính sách cho phép + Docker Compose + WireGuard. Ngôn ngữ: TypeScript cho
web/API/job; Python giữ ở chỗ thư viện AI chỉ có Python (OCR/STT) và công cụ schema/eval.

Ràng buộc không đổi: HĐ TEDO–Sâm Sâm (89 tính năng / 9 khối, P1 tới 11/01/2027, hệ thống lõi chạy trên
server vật lý Sâm Sâm), mọi Invariants trong `AGENTS.md` (guardrail trước nội dung, PII chỉ ở `contacts`
dạng Fernet, người thật mới duyệt, cổng triển khai HĐ 6.7, hash chain, không DB `samsam` khi test).

## 1. Chiến lược: thay dần (strangler), CÙNG một cơ sở dữ liệu

- **Giữ nguyên PostgreSQL schema** (`docs/schema.sql`, `docs/roles.sql`, `docs/schema_pgvector.sql`,
  áp bằng `python scripts/apply_schema.py`). 100 bảng, 94 function, 109 trigger, 98 SECURITY DEFINER —
  phần lớn luật nghiệp vụ quan trọng (hàng duyệt `enqueue_item`/`decide_item`, `*_human`, `human_actor`,
  `person_login_guard`, hash chain `agent_action_log`/`plot_logs`, cổng PL02 `rollout_transition_human`)
  nằm Ở DB và được TS GỌI LẠI, không viết lại.
- Bổ sung schema chỉ thêm (additive): cột `embedding_v2 vector(1024)` (BGE-M3) cho `chunks`/`chunks_internal`
  + HNSW, bảng/cột phục vụ AI Gateway policy. Tệp `docs/schema_ts.sql`, áp sau schema gốc.
- Hệ Python vẫn chạy song song cho tới khi từng module TS đạt tương đương (parity) — nghiệm thu P1 không
  phụ thuộc việc viết lại xong.
- Dữ liệu cấu hình `data/*.json` dùng LẠI nguyên tệp (TS đọc cùng file, cùng ý nghĩa).

## 2. Kiến trúc đích (thư mục `ts/`, npm workspaces)

| Thành phần | Đường dẫn | Vai trò |
|---|---|---|
| `@samsam/core` | `ts/packages/core` | thư viện dùng chung: db (pool theo login dịch vụ + kết nối người), config `data/*.json`, period/freeze, pii, guardrail, auth (authorize/cli_gate/person_connect), AI Gateway, rollout, approval queue, red alert, job_runs, report, store, director |
| API | `ts/apps/api` | NestJS: module theo khối/tính năng (`src/modules/<item>/`), REST cho web, webhook Zalo/Messenger/B2B (HMAC, trả 200 trước, hạn 30 s), lệnh CLI (nest-commander) thay `python -m …` |
| Worker | `ts/apps/api` (entry `worker.ts`) | BullMQ repeatable job thay 34 systemd timer (`deploy/onprem/jobs.json`), giữ khóa chống chạy chồng + ghi `job_runs` |
| Web | `ts/apps/web` | Next.js thay Streamlit (7 tab: Chat, Content Studio, Chưa trả lời, Leads, Báo cáo, Nhật ký vườn, Duyệt & Lịch) |
| AI worker | `ai_worker/` (Python, HTTP nội bộ) | bọc OCR (`ingest/ocr_worker.py` paddle_local, Docling khi cài) + STT (faster-whisper) cho mạng `ai_private` |
| Hạ tầng | `deploy/compose/` | docker-compose: postgres+pgvector, redis, keycloak, ollama (mạng `ai_private` internal, `OLLAMA_NO_CLOUD=1`, 1 request song song), api, worker, web, ai_worker; realm Keycloak; WireGuard ghi trong README |

### Xác thực và quyền (giữ mô hình tin cậy hiện tại)
- Keycloak (OIDC) = đăng nhập web; 6 vai trò hiện có (`pipelines/auth.py`) thành realm role. API xác minh
  JWT bằng JWKS (thư viện `jose`).
- **Quyết định của người vẫn đi qua login PostgreSQL RIÊNG của người đó** (như `auth.person_connect`):
  web có bước "Mở quyền quyết định" → API mở kết nối bằng login người, kiểm `session_user`, từ chối login
  superuser/owner, đòi `human_whoami()`, ghi `human_login_check()`. DB tiếp tục cưỡng chế danh tính/khối/
  không tự duyệt. Đọc dùng login `svc_ui`; webhook `svc_webhook`; job `svc_job`; loader `svc_loader`.
- `approvers` rỗng trong `data/directors/*.json` = chặn (như cũ).

### AI Gateway (mặc định KHÔNG gọi cloud)
- Port đủ ngữ nghĩa `pipelines/llm_gateway.py`: `feature=` bắt buộc, kill switch agent/feature, trần chi
  phí, ghi `llm_usage`, che PII trước khi gửi, fail-closed, cổng rollout `tat`.
- Nhà cung cấp mặc định: Ollama nội bộ (`qwen3:8b` chat, `bge-m3` embedding 1024 chiều) qua HTTP mạng
  `ai_private`. Cloud (Claude qua Anthropic API) CHỈ khi `data/ai_policy.json` cho phép đúng tính năng,
  có người phê duyệt + hạn + lớp dữ liệu; **không tự fallback từ local lên cloud**.
- Hạn tổng 30 s cho chatbot giữ nguyên (`CHAT_BUDGET_S`).

## 3. Cách làm (workflow subagent, theo đợt)

1. **Nền tảng** (tuần tự rồi song song theo thư mục con của core): scaffold `ts/`, cài gói npm một lần,
   compose + Dockerfile + realm, DB test riêng (container pgvector, DB mẫu dựng bằng `apply_schema.py`),
   chặn kết nối DB `samsam` trong test TS, CI job TS; rồi core: bảo mật (pii/guardrail/auth), AI Gateway +
   RAG hạ tầng, vận hành (approval/red alert/job/report/store/director/loader gate), rollout.
2. **Port module** (~34 nhóm, mỗi nhóm 1 agent viết + test, 1 agent review đối kháng, sửa nếu có lỗi chặn).
   Đơn vị = nhóm file Python liên quan; test TS dịch từ test Python tương ứng; logic thuần so khớp
   "golden" (chạy hàm Python sinh kết quả mẫu → test TS phải ra y hệt).
3. **Tích hợp**: đăng ký module/lệnh, lịch BullMQ từ `jobs.json`, build + test toàn bộ TS.
4. **Web**: các trang Next.js thay 7 tab Streamlit.
5. **Review cuối**: bảo mật (danh tính/quyền, PII, egress AI), đối chiếu độ phủ 96 mục
   `data/contract_features.json` → `docs/rewrite/TIEN_DO.md`.

Giữ ở Python (công cụ, không phải luồng nghiệp vụ): `scripts/apply_schema.py`, `agent_eval.py`, `redteam.py`,
`eval_qa.py`, `dpia_draft.py`, `data_audit.py`, `vector_eval.py`, `deploy_gate.py`, `db_restore_drill.py`,
`db_rotate_password.py`, `incident_compare.py`, `zalo_mock.py`, `record_demo.py`.

## 4. Quy ước cho agent

- Code TS tiếng Anh, giải thích nghiệp vụ bằng comment tiếng Việt (như repo).
- Mỗi nhóm chỉ ghi trong thư mục của nhóm (`ts/apps/api/src/modules/<nhóm>/`); không sửa core, `package.json`,
  `app.module.ts` — cần gì thì báo trong kết quả để bước tích hợp làm.
- Không thêm gói npm; không chạy `npm install`; chỉ chạy test của nhóm mình (vitest một luồng).
- Test DB: tạo DB riêng từ mẫu trong container test (`createdb -T samsam_ts_tpl …`), xóa khi xong; KHÔNG
  BAO GIỜ DB `samsam`. Không ghi bí mật vào repo.
- Không commit, không push, không stage.

## 5. Giới hạn đã biết

- Máy dev: GPU GTX 1650 4 GB, RAM trống ~1 GB → không chạy Ollama Qwen3 8B/Keycloak tại chỗ; test dùng nhà
  cung cấp LLM giả + JWKS sinh tại chỗ; compose chỉ kiểm bằng `docker compose config`. Chạy thật trên
  server đích (RTX 5060 Ti 16 GB, 32 GB RAM — cần xác nhận đây là server vật lý của Sâm Sâm theo HĐ).
- Chất lượng tiếng Việt của Qwen3 8B so với model cloud hiện tại chưa đo — cần bộ eval (`agent_eval`,
  `eval_qa`) chạy trên server đích trước khi chuyển chatbot sang TS.
- Embedding đổi 1536 → 1024 chiều: phải embed lại toàn bộ `chunks` bằng BGE-M3 trước khi RAG TS dùng.
