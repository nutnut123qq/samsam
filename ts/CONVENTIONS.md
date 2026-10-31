# ts/ — quy ước cho agent viết lại (đọc cùng `docs/rewrite/KE_HOACH.md`)

Bản Python là CHUẨN: luật/chặn/fail-closed/thông điệp/exit code của Python phải có y hệt ở TS.

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `packages/core/src/<khu>.ts` | `@samsam/core/<khu>` (exports `./*` → `./src/*.ts`, không có index chung) |
| `packages/core/src/db.ts` | `servicePool(service)` (webhook/job/loader/backup/ui — như `auth.bind_service`), `createPool(dsn)` (có listener `'error'`: kết nối rảnh bị đóng không làm sập tiến trình), `connectDatabaseUrl(env) → DbLease \| null` (Python `lead_store.connect`: `DATABASE_URL` + `select 1`; `release()` = `pool.end()`), `privilegedLogin`, `targetDatabase` |
| `packages/core/src/env.ts` | `approvalEnforced`, `authMode`, `truthy`, `pyStrip` (port `pipelines/auth.py`) |
| `packages/core/src/config.ts` | `loadData('directors/sales.json', zodSchema?)` đọc `data/*.json` của repo; thiếu/hỏng → `ConfigError` (fail-closed) |
| `packages/core/src/paths.ts` | `REPO_ROOT`, `dataPath()`, `repoPath()` |
| `packages/core/src/fernet.ts` | Fernet khớp `cryptography` Python (cột `contacts`) |
| `packages/core/src/{security,ai,ops,rollout}/` | API core — xem mục "API core" bên dưới |
| `packages/core/src/testing/db.ts` | `createDbFromTemplate`, `dropDb`, `testDbName` |
| `apps/api/src/modules/<nhóm>/` | module NestJS của nhóm (chỉ ghi ở đây) |
| `apps/api/src/{main,worker,cli}.ts` | entry REST / BullMQ / CLI — bước tích hợp đăng ký module, nhóm KHÔNG sửa |
| `apps/api/src/app.module.ts` | API (svc_ui): health, Content Studio, RagService, webhook Zalo/Messenger (`WebhookWiringModule` — lớp kênh/RAG/vườn trên pool svc_webhook) |
| `apps/api/src/cli.module.ts` | `CliModule`: mọi lệnh (107, gồm `db-ping` + lệnh core ở `cli/red-alert.command.ts`, `cli/core.commands.ts`: rollout/approval-queue/director/store/acceptance/loader-gate/job-runs/report); lệnh con cờ lạ/thiếu → exit 2 (`cliExitOverride`) |
| `apps/api/src/wiring.ts` | nối chéo nhóm: `webhookDeps` (ZALO_WEBHOOK_DEPS cho `zalo-webhook`/`messenger-webhook`), `chatRag`, `RAG_ANSWER` của `channels` |
| `apps/api/src/jobs.ts` | lịch worker: bước Python của `deploy/onprem/jobs.json` → lệnh CLI TS cùng cờ (`TS_STEPS`), giữ Python (`PY_STEPS`), `WORKER_JOBS` |
| `apps/web/` | Next.js App Router |

## Lệnh (Git Bash; mọi lệnh nặng chạy MỘT cái một lúc, đọc output tới khi exit)

```bash
SECRET="<thư mục ngoài repo>/ts_secret/db.env"   # người dựng container test tạo, KHÔNG commit
set -a; . "$SECRET"; set +a          # TS_TEST_ADMIN_URL (DB postgres của container test) — không in ra
cd /d/code/samsam/ts
export npm_config_cache='D:\npm-cache'   # chỉ agent nền được npm install; agent nhóm KHÔNG cài gói

node_modules/.bin/vitest run apps/api/src/modules/<nhóm>     # một thư mục, một luồng (vitest.config.ts)
node_modules/.bin/tsc -p apps/api        # typecheck (lỗi ở thư mục nhóm khác: không phải việc của mình)
node_modules/.bin/tsc -p packages/core
node_modules/.bin/biome check apps/api/src/modules/<nhóm>    # --write để tự sửa format
```

- Không nạp `db.env` → test DB tự `skip` (chế độ unit). Test cần DB: `describe.skipIf(!process.env.TS_TEST_ADMIN_URL)`.
- Container test: `samsam-ts-db` (pgvector/pgvector:0.8.6-pg17-trixie, 127.0.0.1, cổng trong db.env). Tắt thì
  `docker start samsam-ts-db` — KHÔNG tạo lại (mật khẩu ở db.env). DB mẫu `samsam_ts_tpl` (không kết nối
  được — `allow_connections false`) dựng bằng `npm run db:template` = `apply_schema.py --roles` ×2 +
  `ingest.core_store` + `ingest.golden_store` + `--pgvector` + `docs/schema_ts.sql`. Chỉ dựng lại khi
  schema đổi (báo trong kết quả, không tự chạy khi agent khác đang test).
- Python: `PYTHONIOENCODING=utf-8`. Máy không có `psql`: dùng `docker exec samsam-ts-db psql -U postgres …`.

## DB test theo nhóm — KHÔNG BAO GIỜ DB `samsam`

```ts
import { createPool } from '@samsam/core/db';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('approval (DB)', () => {
  const name = testDbName('approval');          // t_approval_<pid>_<rand>
  let pool: Pool;
  beforeAll(async () => { pool = createPool(await createDbFromTemplate(name)); });
  afterAll(async () => { await pool?.end(); await dropDb(name); });
});
```

- `createPool`/`servicePool` từ chối DB `samsam` khi `NODE_ENV=test` (vitest tự đặt) và DSN không có tên DB tường minh.
- DB tạo từ mẫu kết nối bằng superuser. Test quyền (svc_*/app_human) thì tạo login tạm `in role <role>` rồi
  `drop role` ở `afterAll` (mẫu: `packages/core/src/testing/db.test.ts`). Role là của cả cluster — tên có `process.pid`.
- KHÔNG đọc `.env` (repo `.env` trỏ DB samsam thật). Hàm nhận `env: Env = process.env` để test truyền env giả.

## Module NestJS chuẩn

```
apps/api/src/modules/<nhóm>/
  <nhóm>.module.ts      @Module({ providers: [XService, XCommand], controllers: [XController], exports: [XService] })
  <nhóm>.service.ts     logic + SQL
  <nhóm>.controller.ts  REST/webhook (nếu có)
  <nhóm>.command.ts     lệnh CLI nest-commander thay `python -m …` (nếu có)
  <nhóm>.test.ts        vitest (dịch từ tests/test_<python>.py)
  __fixtures__/*.golden.json
```

- **Mọi tham số constructor phải có `@Inject(Token)` tường minh** — runtime (tsx/esbuild) và vitest KHÔNG
  phát `emitDecoratorMetadata`; thiếu `@Inject` = dependency `undefined`.
  `constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(FooService) private readonly foo: FooService) {}`
- Pool: token `PG_POOL` (`apps/api/src/db/db.module.ts`, global — api = login `ui`, worker = `job`). Lệnh CLI
  tự mở `servicePool('loader'|'backup'|'job')` hoặc kết nối người, và `pool.end()` khi xong (mẫu
  `apps/api/src/cli/db-ping.command.ts`). Kiểm tham số CLI trong `run()` (lỗi ném trong hàm parse của
  nest-commander thoát 0); exit code như Python: 2 = sai tham số/bị chặn, 1 = lỗi, 78 = cấu hình job, 75 = đang khóa.
- Test controller: `Test.createTestingModule({ controllers: [X], providers: [{ provide: PG_POOL, useValue: fake }] })`,
  `app.listen(0, '127.0.0.1')` + `fetch` (mẫu `apps/api/src/health/health.controller.test.ts`).
- Kết quả trả về cho bước tích hợp: tên class module, lệnh CLI, job lịch (tên trong `deploy/onprem/jobs.json`),
  biến môi trường mới. Không sửa `app.module.ts`/`cli.ts`/`worker.ts`/`package.json`/core.

## Gọi function DB của Python (không viết lại luật DB)

Luật ở DB (`enqueue_item`, `decide_item`, `*_human`, `human_actor`, trigger hash chain…) được GỌI, không port.
Port đủ các bước Python làm TRƯỚC lời gọi (vd `approval_queue.enqueue`: kiểm `created_by`/payload rỗng →
`rollout.check_generate` → `guardrail.check`), rồi:

```ts
const { rows } = await pool.query<{ id: string }>(
  'select enqueue_item($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) as id',
  [objectType, String(objectId), block, title ?? '', payload, risk, JSON.stringify(guardrail), qaStatus, createdBy, slaHours],
);
const id = BigInt(rows[0].id);   // int8/numeric về dạng string; timestamptz → Date
```

- Python dùng `with conn.transaction()` + `commit()`: một câu → `pool.query` (tự commit); nhiều câu cùng tx →
  `const c = await pool.connect(); await c.query('begin') … 'commit'/'rollback'; c.release()`.
- Lỗi DB: `e.code === 'P0001'` (raise exception — thông điệp nghiệp vụ ở `e.message`, như `RaiseException`),
  `'42501'` (InsufficientPrivilege → `authz_denied` như `auth.call_human`), `'23505'` (unique). Không đưa
  `e.detail`/DSN vào thông điệp trả người dùng.
- Tham số luôn `$n` — không nối chuỗi SQL (trừ tên DB/role đã kiểm regex như `testDbName`).

## API core (`@samsam/core/<thư mục>/<tệp>` — import đúng tệp, không có index chung)

### Nối core lúc khởi động — `ops/wire`
- `wireCore(pool)` nối MỘT lần cho cả tiến trình: guardrail/PII/auth (security), guardrail LLM (gateway
  trên `pool`), rollout (`opsRollout`; rollout tự đọc sổ bằng `pool`, null → `DATABASE_URL`) → trả
  `AiGateway` dùng chung. Đã gọi sẵn: api/worker trong `DbModule` (token `AI_GATEWAY`), CLI ở `cli.ts`
  với `null` (AI bị chặn) — lệnh mở pool riêng mà cần AI/cổng trên pool đó thì gọi lại `wireCore(pool)` ở `run()`.
- `createGateway(pool, extra?)` = `AiGateway` với `maskPii`/`maskIdentity`/`PII_RE` + `rollout.mode` thật
  (test truyền `extra` = `env`/`files`/`fetch`/`warn` giả). KHÔNG tự `new AiGateway({...})` với deps tự ghép.
- Module NestJS: `constructor(@Inject(AI_GATEWAY) private readonly ai: AiGateway, @Inject(PG_POOL) private readonly pool: Pool)`
  (`AI_GATEWAY`, `PG_POOL` từ `apps/api/src/db/db.module.ts`).
- Test ops/module: `installFakeDeps(over?, state?)` (`ops/testing`) — guardrail giả ("chữa" = vi phạm),
  rollout giả (mặc định `van_hanh`), auth giả nhánh dev; `wireSecurity(null)` khi cần security THẬT.
  Chưa nối mà dùng → `ops: chưa nối '<tên>'` (fail-closed).

### security — PII, guardrail, quyền
| Tệp | Hàm chính |
|---|---|
| `security/pii` | `maskPii(s)` (Python `_mask_pii`), `maskIdentity(s, allowAddr?)`, `scrubUser(s) → [đã che, còn_dấu_hiệu]` (true → KHÔNG gửi AI, chuyển người), `identityResidual(s)`, `PII_RE` |
| `security/guardrail` | `check(text)` (luật chung), `checkPublish(text, { channel, contentType, sku, isAi, isSponsored, readiness })` (đăng bài), `withViolation(res, code, detail, span, start, end)`, `readiness(sku, kênh)`, `readinessKey` → `{ ok, violations[], skus, … }`, không ném. Hàm "riêng" Python mà module dùng lại (KHÔNG chép): `loadRules(dir?) → [GuardrailRules, null] \| [null, lý do]` (`_load_rules`: golden/families/contentTypes/channels/channelAlias/canonical…, cache theo thư mục), `readinessOf(skuDict, kênh)` (`_readiness_of`), `findTerms(text, terms)`, `fillerHits(text, terms, packed?)`, `compress`, `FILLER_RE`, `fold`, `stripLen` |
| `security/guardrail-llm` | `await checkPublishLlm(text, opts, { gateway })` — chỉ chặn thêm; gateway null/lỗi → `llm_check_unavailable` |
| `security/kb-filter` | `isAlcohol(text)` |
| `security/auth` | `authorize(by, block, action, { createdBy, role, dbLogin, via, env, allow, allowSrc }) → { ok, why }`; `cliGate(db, by, block, action, objectType, objectId, opts) → lý do \| null` (MỌI `--by` quyết định); `cliIdentity(db, by, objectType, objectId, opts)` (nhập liệu/thực thi); `callHuman(db, sql, args, { by, block, action, objectType, objectId })` (function `*_human`: 42501 → `HumanDenied` + `authz_denied`, P0001 → `HumanError`); `personConnect(dsn, login, password)` (phiên NGƯỜI — `client.end()` khi xong); `denyLog`, `sessionLogin`, `isHuman`, `decidableBlocks`, `blockConfig(block)`/`loadBlockConfig(block, dir)`/`validateBlockConfig` (bản DUY NHẤT của `director.validate/load_config`), `ROLES`, `canApprove`, `canSchedule`, `tabsFor`, `verifyAccessToken(token, oidcFromEnv())` (Keycloak) |
| `security/fernet` | `loadVaultKey(env)`, `seal(f, v)`, `unseal(f, token)`, `normalizePhone`, `phoneLookup` (cột `contacts`) |
| `security/py` | chuỗi kiểu Python: `pyStrip`, `pySplit`, `casefold`, `stripAccents`, `cpLen`, `cpHead`, `pyStr`, `pyRepr`, `pyTruthy`, regex `re()`/`search`/`finditer`/`sub` (`\d`/`\w` Unicode) |

Lỗi: `HumanError extends RangeError` (Python ValueError), `HumanDenied extends HumanError` — rollout
re-export CÙNG lớp; bắt `RangeError` = bắt ValueError của Python.

```ts
const why = await cliGate(pool, by, 'production', 'approve', 'allocation_run', String(id));
if (why) { console.error(`[TỪ CHỐI] ${why}`); return 2; }
const g = checkPublish(text, { channel: 'facebook', contentType: 'post', sku, isAi: true });
if (!g.ok) return; // guardrail TRƯỚC mọi hiển thị/đăng
```

### ai — AI Gateway (mặc định Ollama nội bộ, không fallback lên cloud)
- `await ai.chat(agentId, messages, { feature, provider?, dataClass?, model?, temperature?, seed?, maxTokens?, timeoutMs?, deadline? })`
  (`seed` → Ollama `options.seed`; Claude không có seed)
  → `{ text, model, provider, tokensIn, tokensOut }`; `await ai.embed(agentId, input, { feature })` →
  `{ embeddings: number[][], … }` (1024 chiều). `feature` (mã danh mục) BẮT BUỘC.
- Lỗi: `GatewayError` (cấu hình/nhà cung cấp), `GatewayBlocked extends GatewayError` (kill, trần, rollout
  `tat`, cloud không được phép, không đọc được chi tiêu) — chatbot bắt `GatewayBlocked` → chuyển người.
- `provider: 'claude'` chỉ khi `data/ai_policy.json` cho đúng tính năng (người duyệt + hạn + `dataClass`
  + giá); thiếu một điều kiện → `GatewayBlocked`. Repo hiện: chưa tính năng nào được cloud.
- `ai/health`: `isHealthQuestion(text)`; `ai/text`: `casefold`, `stripAccents`, `hasAlpha`.
- `ai/ai-worker` (OCR/STT qua `AI_WORKER_URL`): `ocrViaWorker(bytes)`, `transcribe(bytes)` (nháp đã che PII
  ≤ 1000 ký tự), `workerReady()`, `sttProvider(env)`; lỗi `AiWorkerBlocked` (exit 2), `AiWorkerRejected`/`AiWorkerError` (exit 1).
- Login `svc_ui`/`svc_webhook`/`svc_job` đều đọc/ghi được `llm_usage` (kế thừa `agent_writer`) — có test DB.

```ts
try {
  const r = await this.ai.chat('mkt02', [{ role: 'user', content: prompt }], { feature: 'marketing-01.1' });
} catch (e) {
  if (e instanceof GatewayBlocked) return handoff(e.message);
  throw e;
}
```

### ops — hàng duyệt, cảnh báo đỏ, job, báo cáo, nháp nội dung, GĐ khối
| Tệp | Hàm chính |
|---|---|
| `ops/approval-queue` | `enqueue(db, { objectType, objectId, block, title, payload, risk, createdBy, slaHours, qaStatus?, sample? }) → bigint` (cổng `checkGenerate` + guardrail trước `enqueue_item`); `decide(db, id, by, 'approved'\|'rejected', note?, who?) → [ok, why]`; `override`, `autoApprove`, `expireOverdue`, `pending`, `verify(db, id, text)` (bản gửi khớp bản duyệt + cổng DÙNG), `approvalQueueCli` |
| `ops/director` | `submit(db, { block, objectType, objectId, title, payload, createdBy, qaSuite? })` (SLA/risk theo `data/directors/<khối>.json`), `run`, `digest`, `loadConfig`, `validate`, `BLOCKS`, `directorCli` |
| `ops/red-alert` | `raiseAlert(db, sourceAgent, title, detail?, routing?) → [đã gửi, lý do]`, `ack`, `escalate`, `deliverPending`, `openAlerts`, `checkRouting`, `redAlertCli` |
| `ops/job-runs` | `jobRun(tên, async (run) => …)` (ghi `job_runs`), `loadJobs(path?, stepOk?)` (mặc định kiểm tệp Python như job_runs), `registerJobSchedulers(queue)` (BullMQ, giờ VN), `tryJobLock`/`releaseJobLock`, `runScheduled(tên, { jobs, runner })`, `commandRunner(bin, prefix)`/`pythonRunner`, `EXIT_LOCKED` 75, `EXIT_SERVICE` 78 |
| `ops/report` | `writeReport(text, outDir, name, sample, feature?)` (cổng rollout + nhãn CHẠY THỬ + sổ `report_outputs`; `sample` theo provenance, BẮT BUỘC truyền), `REPORTS_DIR`, `fmtVnd`, `generate` |
| `ops/store` | `saveDraft`, `setStatus`, `schedule`, `verifyPublish`, `publishCheck`, `listDrafts`, `calendar`, `contentSha256`, `oneline`, `pyStr`, `samePerson` (`content_drafts`, function DB `approve/reject/schedule_draft`) |
| `ops/loader-gate` | `check(tênLoader, db) → lý do chặn \| null` (gọi ở đầu mọi loader nạp file; ≠ null → exit 2) |
| `ops/period` | ngày VN dạng chuỗi `'YYYY-MM-DD'`: `vnDate`, `vnFormat(d, '%d/%m %H:%M')`, `periodBounds(kind, ref)`, `rollingBounds`, `businessDeadline`, `businessMinutes`, `addDays`, `weekday`, `parseDay`; `utcMs(y, mo0, d, …)` thay `Date.UTC` (không đổi năm 0–99 thành 1900+ — Python nhận năm 1..9999) |
| `ops/freeze` | `check(...)`, `isFrozen(when)`, `loadCalendar` |
| `ops/tx` | `withTx(db, async (c) => …)` (nhiều câu cùng giao dịch), `isDbError(e)` (Python `psycopg.Error`), `dbMsg(e)`, `pgErrName(e)` (Python `type(e).__name__` của lỗi psycopg khi chạy câu — đủ bảng SQLSTATE sinh từ psycopg `ops/pg-errors`, mã lạ → lớp gốc; không SQLSTATE → `OperationalError`; `rollout/counters` re-export), `connErrName(e)` (lỗi lúc MỞ kết nối → `OperationalError`/`ConnectionTimeout`) |
| `ops/py` | `readJson(file, reviver?)` (lỗi `JsonFileError.pyType` = tên lỗi Python), `isPlainObject`, `isInt`, `pyInt`, `squash`, `cpSlice` |
| `ops/py-json` | `json` + số + đọc tệp kiểu Python: `parsePyJson` (mọi số thực → `PyFloat{v}`), `pyLoads` (chỉ số nguyên viết dạng thực `14.0` → `PyFloat`; `intFloatReviver`), `isDict`, `isPyInt`, `pyNum`, `reprV`, `cpCmp` (so chuỗi theo code point = `sorted`), `pyFloatStr` (`str(float)` đủ dạng mũ), `pyFixed(x, n)` (`f"{x:.nf}"`), `pyRound(x, n)`, `pyFloat(str)`, `pyOsName(e)` (tên OSError), `readUtf8Sig`, `PyReadError` |
| `ops/py-csv` | `CsvReader(text, fieldLimit?)` (`csv.reader` + `lineNum`, trần 131072 → `CsvError`), `csvRows(text)` (không trần), `utf8ErrorStart(bytes)` |
| `ops/py-url` | `urllib.parse`: `urlsplit`/`urlparse`/`urlunsplit`/`urljoin`, `hostname(netloc)`, `port`, `quote`/`unquote`, `parseQsl`/`urlencode`; lỗi `UrlError extends RangeError` (ValueError) |
| `ops/py-date` | `fromIsoformat` / `parsedateToDatetime` → `PyDateTime` (micro giây + offset), `toDate`, `utcMicros`, `pyStr(dt)`, `pyIntStr`, `isoDate(s)` (`date.fromisoformat` 3.12 gồm tuần ISO), `pyIsoUtc(d)`, `VN_US` |

Helper ngữ nghĩa Python dùng chung nằm ở core (`ops/py-*`) — module KHÔNG chép lại và KHÔNG import chéo
từ module khác cho các tiện ích này (đã gom từ `sales_director/py-json`, `garden_director/py`,
`kd_quote/py` (CSV), `intel_crawl/py-url|py-date`, `messenger_fanpage` urlsplit, các bản
`connectDatabaseUrl`/`pgErrName`/`readinessOf`/`FILLER_RE`/`findTerms` của nhóm).

Khóa job TS = advisory lock Postgres, KHÔNG loại trừ khóa file của Python `job_runs` → **không bật cùng
một job ở cả systemd timer lẫn BullMQ**. Worker (`worker.ts`) chỉ lập lịch các job trong `WORKER_JOBS`
(phẩy; TRỐNG = worker exit 78, `all` = cả lịch trừ `restore_drill`/`dr_drill`) — chuyển job nào thì tắt timer `samsam-job-<tên>.timer` của nó trước
(`deploy/compose/README.md` mục 7). Mỗi bước chạy tiến trình con `node --import tsx apps/api/src/cli.ts
<lệnh> <cờ Python>` (cwd = gốc repo, `TSX_TSCONFIG_PATH` = tsconfig của api — thiếu thì decorator Nest
hỏng); thêm/đổi job trong `jobs.json` → cập nhật `TS_STEPS` + bảng `jobs.test.ts`.

Egress: tệp .ts (không phải test) có `fetch`/node:http(s)/nodemailer/@anthropic-ai/sdk hoặc gọi
`.chat(`/`.embed(` của gateway phải nằm trong `modules` của một flow ở `data/data_flow_map.json` (drift-guard
`apps/api/src/data-flow-map.test.ts`); sửa map xong chạy `python scripts/dpia_draft.py` (docs/legal phải khớp).

### rollout — cổng triển khai HĐ 6.7 / PL02
- `mode(db, fid)` → `'chay_thu'|'co_nguoi_duyet'|'van_hanh'|'tat'` (DB lỗi/chưa vào sổ → `chay_thu`).
- Biên SINH: `await checkGenerate(db, fid, what)` (tắt → `RolloutBlocked`); CLI: `const why = await blocked(db, what, fid)`
  TRƯỚC mọi connect/đọc nguồn/ghi → `sayBlocked(why)` (exit `EXIT_BLOCKED` = 2); bọc main bằng `cliEntry(main)`.
- Biên DUYỆT: `decideReason(db, fid, what)`; biên DÙNG (gửi/xuất/áp dụng): `useReason(db, fid, what, humanReviewed)`.
- `featureFor(attrs)`, `featureForReport(name)`, `catalog()`, `quickMode()`; báo cáo: `gateReport`/`labelReport`/`recordReport`
  (đã gói trong `ops/report.writeReport`).
- Sổ: `seed`, `promote`, `recordSevere`, `disable`, `pendingOutputs`, `reviewOutput`, `dossier`, `rolloutCli`;
  `rollout/acceptance`: `acceptanceCli`. Lỗi: `RolloutError` (bị từ chối — chưa đủ cổng/không có trong sổ, exit 1), `HumanDenied` (từ security/auth).
- `rollout.callHuman` là bản NỘI BỘ của sổ triển khai (savepoint, trả mảng) — module gọi function `*_human`
  dùng `security/auth.callHuman`. Tương tự `ops/approval-queue.useReason(db, meta)` ≠ `rollout.useReason(db, fid, what, humanReviewed)`.
- Test: `settings.forceMode = 'van_hanh'` hoặc `installFakeDeps(..., { quick, stages })` (rollout giả ném
  `RolloutBlocked` THẬT khi tính năng tắt — như bản thật); `setConnector(fn|null)`.
- `RolloutBlocked.name === 'RolloutBlocked'` (Python `type(e).__name__`; vẫn `instanceof RangeError`).

```ts
const why = await blocked(null, 'phân bổ sản xuất', 'production-01');
if (why) return sayBlocked(why);
```

## Golden từ Python (logic thuần)

1. Script tạm ở scratchpad của session (thư mục tạm ngoài repo),
   KHÔNG trong repo: `sys.path.insert(0, r"D:\code\samsam")`, import hàm Python thật, chạy trên đầu vào cố định
   (gồm ca biên: rỗng, Unicode, khoảng trắng lạ, giá trị sai kiểu).
2. Chạy: `PYTHONIOENCODING=utf-8 DATABASE_URL=postgresql://golden@127.0.0.1:9/golden_none python <script>`
   (DSN chết: lỡ có đường chạm DB thì lỗi, không chạm samsam).
3. Ghi `__fixtures__/<tên>.golden.json` (`json.dumps(..., ensure_ascii=True, indent=1)`, LF); test import
   `with { type: 'json' }` và so khớp y hệt. Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn = fail-closed) phải liệt kê
   tên ca + lý do trong test (mẫu `packages/core/src/fernet.test.ts` `TS_STRICTER`).
4. Bẫy Python ↔ JS: `str.strip()` ≠ `trim()` (dùng `pyStrip`), `lower()`/`casefold()`, `\d`/`\w` Unicode
   (Python) vs ASCII (JS — dùng `/u` + `\p{Nd}` khi Python dùng `\d`), `json.loads` nhận NaN, số nguyên lớn
   (JS mất chính xác > 2^53 — dùng BigInt/string), `round()` (Python làm tròn về số chẵn), `sorted` ổn định
   theo code point (JS `sort()` mặc định theo UTF-16), chia `//` và `%` với số âm.

## Quy ước tên/mã

- Code tiếng Anh, comment nghiệp vụ tiếng Việt; thông điệp cho người dùng giữ NGUYÊN câu tiếng Việt của Python.
- File kebab-case (`approval-queue.ts`), class PascalCase, hàm/biến camelCase: `service_dsn` → `serviceDsn`.
  Cột DB, khóa JSON `data/*.json`, giá trị enum DB giữ snake_case.
- ESM: import tương đối có đuôi `.js` (`./x.js` → `x.ts`), `import type` cho kiểu (`verbatimModuleSyntax`),
  built-in `node:` (`node:crypto`). Không thêm gói npm; cần gói mới → báo trong kết quả.
- Shortcut có giới hạn: comment `shortcut: <giới hạn>, <khi nào nâng>`.
- Không log/print định danh (SĐT, user_id, email) thô — dùng hàm che PII của core khi có.
