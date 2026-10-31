// Dựng lại DB mẫu `samsam_ts_tpl` trong container test (xóa + tạo mới), đúng như
// tests/_db_guard._FIX của Python + pgvector + docs/schema_ts.sql. Chạy:
//   npm run db:template   (cần TS_TEST_ADMIN_URL — ts/CONVENTIONS.md)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CONNECT_TIMEOUT_MS } from '../db.js';
import { DOCS_DIR, REPO_ROOT } from '../paths.js';
import { adminQuery, dbUrl, TEMPLATE_DB } from './db.js';

const STEPS: string[][] = [
  ['scripts/apply_schema.py', '--roles'],
  ['scripts/apply_schema.py', '--roles'],
  ['-m', 'ingest.core_store'],
  ['-m', 'ingest.golden_store'],
  ['scripts/apply_schema.py', '--pgvector'],
];

const tplUrl = dbUrl(TEMPLATE_DB);
await adminQuery(
  `do $$ begin if exists (select from pg_database where datname = '${TEMPLATE_DB}') then
     alter database "${TEMPLATE_DB}" with is_template false allow_connections true; end if; end $$`,
);
await adminQuery(`drop database if exists "${TEMPLATE_DB}" with (force)`);
await adminQuery(`create database "${TEMPLATE_DB}"`);

// Python nạp `.env` (trỏ DB samsam) nhưng KHÔNG đè biến đã có → đặt tường minh, và xóa trắng các
// biến làm Python đổi DSN/chế độ (LOADER_DATABASE_URL của bind_service, AUTH_MODE/DEPLOY...).
const env = {
  ...process.env,
  DATABASE_URL: tplUrl,
  LOADER_DATABASE_URL: '',
  AUTH_MODE: '',
  APPROVAL_ENFORCE: '',
  DEPLOY: '',
  OPENROUTER_API_KEY: '',
  PYTHONIOENCODING: 'utf-8',
};
for (const args of STEPS) {
  const r = spawnSync(process.env.PYTHON ?? 'python', args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join('\n');
  console.log(`[${r.status}] python ${args.join(' ')}\n${tail.slice(0, 400)}`);
  if (r.status !== 0) {
    console.error(`[err] bước lỗi — DB mẫu ${TEMPLATE_DB} KHÔNG dùng được`);
    process.exit(1);
  }
}

const c = new pg.Client({ connectionString: tplUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
await c.connect();
try {
  await c.query(readFileSync(`${DOCS_DIR}/schema_ts.sql`, 'utf8'));
} finally {
  await c.end();
}
console.log('[done] docs/schema_ts.sql');
// Chặn kết nối nhầm vào DB mẫu (phiên mở → `create database ... template` lỗi 55006).
await adminQuery(`alter database "${TEMPLATE_DB}" with is_template true allow_connections false`);
console.log(`[done] DB mẫu ${TEMPLATE_DB} sẵn sàng`);
