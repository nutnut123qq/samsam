import http from 'node:http';
import https from 'node:https';
import { servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { isPlainObject } from '@samsam/core/ops/py';
import { raiseAlert } from '@samsam/core/ops/red-alert';
import { isDbError } from '@samsam/core/ops/tx';
import type { Pool } from 'pg';

// Port scripts/webhook_probe.py (đợt hợp đồng C01, job `webhook_health` 5 phút; PL02 mục 2 "phát
// hiện sự cố trong 15 phút"): dò `/readyz` của webhook Zalo/Messenger. Mọi URL 200 + `ready: true`
// → 0; có URL không sẵn sàng → 1 cảnh báo đỏ `webhook_probe` cho ĐỢT sự cố (đã có cảnh báo cùng
// nguồn chưa xác nhận trong 24 giờ → không báo lặp) + exit 1. Không theo redirect, timeout 5 giây,
// không in nội dung trả về ngoài mã trạng thái. `--dry-run` không ghi DB.

export const SOURCE = 'webhook_probe';
export const TIMEOUT_S = 5;
const MAX_HEADERS = 100; // http.client._MAXHEADERS của Python

export function defaultUrls(env: Env = process.env): string[] {
  return (
    [
      ['ZALO_WEBHOOK_PORT', '8788'],
      ['MESSENGER_WEBHOOK_PORT', '8789'],
    ] as const
  ).map(([k, d]) => `http://127.0.0.1:${env[k] || d}/readyz`);
}

/** Tên lỗi theo Python (urllib/http.client) — chỉ tên, không chi tiết/URL. */
function label(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  if (code === 'HPE_HEADER_OVERFLOW') return 'LineTooLong';
  if (
    code === 'HPE_INVALID_CONSTANT' ||
    code === 'HPE_INVALID_STATUS' ||
    code === 'HPE_INVALID_VERSION'
  )
    return 'BadStatusLine';
  if (typeof code === 'string' && code.startsWith('HPE_')) return 'HTTPException';
  if (code === 'ECONNRESET') return 'RemoteDisconnected';
  return 'URLError';
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Thân 200: JSON object có `ready === true` (r18: `[1]`/null/"x" = không sẵn sàng). */
function judge(status: number, raw: Buffer): [boolean, string] {
  let s: string;
  try {
    s = UTF8.decode(raw.length ? raw : Buffer.from('{}'));
  } catch {
    return [false, 'UnicodeDecodeError'];
  }
  let body: unknown;
  try {
    body = JSON.parse(s.startsWith('\uFEFF') ? s.slice(1) : s);
  } catch {
    return [false, 'JSONDecodeError'];
  }
  return [status === 200 && isPlainObject(body) && body.ready === true, `HTTP ${status}`];
}

export function probe(url: string, timeoutS: number = TIMEOUT_S): Promise<[boolean, string]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve([false, 'ValueError']);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return Promise.resolve([false, 'URLError']);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: [boolean, string]) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(v);
    };
    const req = mod.get(u, { timeout: timeoutS * 1000 }, (res) => {
      if (res.rawHeaders.length / 2 > MAX_HEADERS) return done([false, 'HTTPException']);
      const st = res.statusCode ?? 0;
      // urllib: 3xx (không theo redirect) / 4xx / 5xx → HTTPError, không đọc thân.
      if (st < 200 || st >= 300) return done([false, `HTTP ${st}`]);
      const chunks: Buffer[] = [];
      let n = 0;
      const finish = () => done(judge(st, Buffer.concat(chunks).subarray(0, 4096)));
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        n += c.length;
        if (n >= 4096) finish(); // r.read(4096)
      });
      res.on('end', finish);
      res.on('error', (e) => done([false, label(e)]));
    });
    req.on('timeout', () => done([false, 'TimeoutError']));
    req.on('error', (e) => done([false, label(e)]));
  });
}

/** 1 cảnh báo đỏ / đợt; đã có cảnh báo `webhook_probe` chưa xác nhận trong 24 giờ → null. */
export async function alert(
  db: Db,
  failed: [string, string][],
  routing: unknown = null,
): Promise<number | null> {
  const dup = await db.query(
    "select 1 from red_alerts r where r.source_agent = $1 and r.ts > now() - interval '24 hours'" +
      ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id) limit 1',
    [SOURCE],
  );
  if (dup.rows.length) return null;
  await raiseAlert(
    db,
    SOURCE,
    `Webhook chatbot KHÔNG sẵn sàng (${failed.length} điểm)`,
    { failed: failed.map(([url, status]) => ({ url, status })) },
    routing,
  );
  const r = await db.query<{ id: string | null }>(
    'select max(id) as id from red_alerts where source_agent = $1',
    [SOURCE],
  );
  return r.rows[0]?.id == null ? null : Number(r.rows[0].id);
}

export type ProbeDeps = {
  env?: Env;
  probe?: (url: string) => Promise<[boolean, string]>;
  /** Pool login job (`webhook_health` chạy bằng svc_job). */
  connect?: () => Promise<Pool>;
};

export async function probeMain(
  o: { url?: string[]; dryRun?: boolean },
  deps: ProbeDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const urls = o.url?.length ? o.url : defaultUrls(env);
  const failed: [string, string][] = [];
  for (const u of urls) {
    const [ok, st] = await (deps.probe ?? probe)(u);
    console.log(`[${ok ? 'ok' : 'LỖI'}] ${u} — ${st}`);
    if (!ok) failed.push([u, st]);
  }
  if (!failed.length) return 0;
  if (o.dryRun) return 1;
  let pool: Pool | undefined;
  try {
    pool = await (deps.connect ?? (() => servicePool('job', env)))();
    await pool.query('select 1');
  } catch {
    console.error('[error] không kết nối được DB — chưa ghi cảnh báo đỏ');
    await pool?.end().catch(() => {});
    return 1;
  }
  try {
    const aid = await alert(pool, failed);
    console.error(
      aid
        ? `[ALERT] cảnh báo đỏ #${aid}`
        : '[ALERT] đã có cảnh báo cùng đợt chưa xác nhận — không báo lặp',
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(`[error] ghi cảnh báo đỏ lỗi (${(e as Error).name})`);
  } finally {
    await pool.end();
  }
  return 1;
}
