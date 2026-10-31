# Bàn giao: viết lại samsam sang NestJS/Next.js

- **Task ID:** `rewrite-nestjs`. Cập nhật lúc 30/10/2026 (chiều) +07.
- **State:** `completed` — đã đạt "thế nào là xong" bên dưới, **chưa commit**. Không còn workflow/agent nào chạy.
  Owner cuối: session `eb2cb09e-84ff-4778-82f3-a13c04b3511d`.
- **Yêu cầu của user** (chat 29–30/10): viết lại toàn bộ hệ thống theo mô hình server AI nội bộ, theo
  [KE_HOACH.md](KE_HOACH.md), triển khai bằng workflow subagent; 30/10 "kế thừa làm tiếp" từ claude4 và
  "xong thì triển khai bên này luôn" (= kiểm và sửa nốt ở session này, KHÔNG phải dựng compose thật).
- **Độ phủ và việc còn lại:** [TIEN_DO.md](TIEN_DO.md) — 96 mục: 83 Đủ, 8 Một phần, 1 Giữ Python, 4 không phải
  code; việc còn lại xếp mức A/B/C ở mục "Việc còn lại".

## Thế nào là xong — kết quả

| Tiêu chí | Kết quả |
|---|---|
| 34 nhóm module đã port + review đối kháng, BLOCKER/MAJOR đã sửa | Đạt: 19 PASS, 15 FIX đã sửa (0 lỗi sửa hỏng) |
| Tích hợp: đăng ký module/lệnh + lịch BullMQ 34 job | Đạt: 107 lệnh CLI, 34 job (`WORKER_JOBS` trống → exit 78) |
| Web thay 7 tab Streamlit | Đạt: `/chat`, `/content`, `/unanswered`, `/leads`, `/reports`, `/garden`, `/review` (chưa E2E trình duyệt) |
| Review cuối 3 lăng kính | Đạt: 5 MAJOR đã sửa (grant/trigger webhook vườn, secret compose, khai egress TS, 8 lệnh CLI core, `WORKER_JOBS` fail-closed) |
| `biome ci`, `tsc` core/api/web, `vitest` toàn bộ xanh | Đạt (coordinator chạy lại 30/10 chiều, xem dưới) |
| Không commit | Đạt: không stage/commit gì |

Kiểm cuối do coordinator tự chạy, tuần tự, sau khi workflow `wf_8a934e65-a90` kết thúc (27/27 agent, 0 lỗi):
- `biome ci .` exit 0 (534 tệp, 36 cảnh báo); `tsc -p packages/core|apps/api|apps/web` exit 0 cả ba.
- `vitest` 38 nhóm thư mục, 1 luồng, DB test: 195 tệp, **5941 pass, 0 fail, 9 skip** (6 cần ffmpeg, 3 dr-drill
  Docker thật). Không sót DB test (chỉ còn `samsam_ts_tpl`).
- Đã sửa 2 test flaky (chỉ test): `rollout.db.test.ts` (đồng hồ DB nhanh hơn host → `until` lấy `now()` của DB),
  `job-runs.test.ts` (khóa advisory nhả bất đồng bộ → chờ theo điều kiện). Mỗi tệp chạy riêng 3 lần xanh; cả
  nhóm `packages/core` chạy lại 292/292.
- Python: `ruff check . --extend-exclude .agents --extend-exclude founder` sạch; pytest unit
  `test_data_flow_map`, `test_ci_workflow`, `test_dpia_draft`, `test_legal_docs`: 111 pass.
- Evidence (Temp, có thể bị dọn): scratchpad `eb2cb09e…\scratchpad\v_full\` (JSON/log từng nhóm),
  `v_biome.txt`, `v_tsc_*.txt`, `v_rollout_*.log`, `v_jobruns_*.log`. Kết quả từng agent: journal
  `C:\Users\hahuy\.claude\projects\D--code-samsam\eb2cb09e-84ff-4778-82f3-a13c04b3511d\subagents\workflows\wf_8a934e65-a90\journal.jsonl`.

## Workspace

- **Repo:** `D:\code\samsam`, branch `codex/remaining-docx-code-r15`, HEAD `43263c5`. Chưa commit gì cho việc viết lại.
- **Tệp của việc viết lại** (chưa theo dõi): `ts/`, `ai_worker/`, `deploy/compose/`, `docs/rewrite/`,
  `docs/schema_ts.sql`, `data/ai_policy.json`, `.dockerignore`.
- **Tệp tracked do việc viết lại sửa:** `.github/workflows/ci.yml` (job `ts`), `.gitignore`,
  `data/data_flow_map.json` (đường TS + luồng DF-49 "AI Gateway bản TS"), `docs/legal/DPIA-nhap.md`,
  `docs/legal/TIA-nhap.md` (sinh lại bằng `scripts/dpia_draft.py`).
- **KHÔNG ĐỤNG — việc của phiên khác:**
  - `.agents/`, `founder/`, `lv2-market-top.png`
  - r21 đang tạm dừng: `evidence/cycle_r21_gate/`, `tests/test_b2b_form.py`, `tests/test_ceo_decisions.py`,
    `tests/test_docx_p0_rollout_gate.py`, `DONE.md`, `CYCLE_LOOP.md`
  - Dọn Docker: `scripts/ci_repro.sh`, `tests/test_docker_test_cleanup.py`,
    `evidence/docker_volume_cleanup_fix_20261029/`, `tests/test_safety_s01_rotation.py`, phần mới trong `AGENTS.md`
  - Đã kiểm 30/10: mtime các tệp trên đều trước 30/10, workflow không sửa.
- **Khi commit** (chỉ khi user bảo): stage theo danh sách tường minh ở hai gạch đầu mục này, không `add -A`;
  grep evidence `postgres(ql)?://[^ ]*:[^*@]+@` và `sk-or` trước `git add -f`.

## Quyết định đã có

- **Strangler:** giữ nguyên DB, schema và luật trong DB; TypeScript gọi lại function DB. Hệ Python vẫn chạy song song.
- **Quyết định của người:** đi qua login PostgreSQL riêng của người đó; Keycloak chỉ dùng cho đăng nhập web.
- **AI Gateway:** Ollama là mặc định; Claude chỉ được gọi khi `data/ai_policy.json` cho phép; không tự fallback lên cloud.
- **Phiên bản gói:** NestJS 11.2.8 (do nest-commander), TypeScript 6.0.3. Gói npm: `npm_decisions.json`
  (`…\65ba0df6-…\scratchpad\`) — `sharp` 0.35.5 cho phép (user 29/10), `htmlparser2`/`parse5` không.
- **Giữ ở systemd:** `restore_drill` (Python), `dr_drill` (cần docker CLI + admin DSN).

## Quyền và môi trường

- **Có quyền:** implement, chạy test, spawn subagent/workflow cho việc viết lại (user, 29/10).
- **Không có quyền:** commit/push/stage (chỉ khi user bảo); kết nối DB `samsam`; kéo image Docker hay tải
  model; gọi LLM/API thật; cài gói npm chưa có trong `npm_decisions.json`.
- **DB test:** container `samsam-ts-db` (`pgvector/pgvector:0.8.6-pg17-trixie`, 127.0.0.1:63198), DB mẫu
  `samsam_ts_tpl` (dựng lại 31/10/2026 sau r22 A2: grant vườn + trigger `webhook_garden_guard` nay ở `roles.sql`/`schema.sql`).
  Biến (tên): `TS_TEST_ADMIN_URL`, `TS_TEST_PG_PORT`, `TS_TEST_TEMPLATE` trong
  `C:\Users\hahuy\AppData\Local\Temp\claude\D--code-samsam\eb2cb09e-84ff-4778-82f3-a13c04b3511d\scratchpad\ts_secret\db.env`
  (Temp — mất thì `docker exec samsam-ts-db psql -U postgres -c "alter user postgres password '<mới>'"` rồi ghi
  db.env mới ngoài repo).
- **Máy dev:** ~0,9–2,7 GB RAM trống, GPU 4 GB → không chạy được Ollama/Keycloak/compose ở đây.

## Còn mở (chi tiết ở TIEN_DO.md "Việc còn lại")

- **Chờ user/Bên B quyết lúc áp lên DB thật — đổi schema DB dùng chung:** r22 A2 (31/10/2026) đưa grant
  `svc_webhook` INSERT theo cột trên `plot_logs`/`garden_media`/`garden_voice_drafts` (Zalo vườn, dùng chung
  Python + TS) vào `docs/roles.sql` + trigger `webhook_garden_guard` (login `svc_webhook` chỉ ghi
  `source='zalo:garden'`, `author='zalo:<mã NV>'`) vào `docs/schema.sql` — đi cùng `apply_schema.py --roles`,
  không còn ở `schema_ts.sql`. Chưa áp lên DB thật.
- Cần quyết khác: cổng ảnh cloud (`imageGate`, schema `ai_policy.json` cho ảnh); intel-05.1 (≥3 nhà cung cấp vs
  "không cloud"); gói `exceljs`/`jose` chưa có quyết định; quyền `svc_ui` đọc `orders`; cách cutover
  (không chạy webhook TS + Python cùng `data/`, tắt timer systemd trước khi chuyển job sang BullMQ).
- Một agent ops từng in DSN DB test có mật khẩu ra terminal của nó (không vào repo). Đổi mật khẩu `samsam-ts-db` là việc user quyết.
- Chưa kiểm được trên máy này: Ollama/Qwen3 (chất lượng tiếng Việt), BGE-M3 + embed lại `chunks`, Keycloak thật,
  web trong trình duyệt, `docker compose up`/build image, Redis/BullMQ thật, CI job `ts` trên GitHub (`gh auth` 401),
  máy RTX 5060 Ti có phải server vật lý của Sâm Sâm theo HĐ.

## Lịch sử ngắn

- 29/10: kế hoạch, F1 (monorepo, compose, CI), core; run `wf_4e923514-436` port 15 nhóm, dừng ở cổng kiểm core.
  Session claude4 (`65ba0df6…`, thư mục `D:\claude-acc4\`) port tiếp; hai session chạy chồng 15:04–15:16, không ghi trùng tệp.
- 30/10 05:41 run `wf_81a160b0-337` (claude4) chết giữa pha port/review; 07:30 resume cùng run làm chạy lại port
  (cache khớp theo tiền tố thứ tự gọi agent) → chuyển sang trích trạng thái từ journal (`extract_state.py`);
  run `wf_f536ac0f-58e` dừng 08:46 vì claude4 hết mức dùng.
- 30/10 09:12 run `wf_8a934e65-a90` (session này, script r3c = r3b đổi tên): review 2 nhóm cuối, sửa 15 nhóm FIX,
  tích hợp 3 bước, web 2 phần, review cuối, sửa 5 MAJOR, TIEN_DO.md — 27/27 agent xong. Chiều 30/10 coordinator
  kiểm lại toàn bộ và sửa 2 test flaky.
