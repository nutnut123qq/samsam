import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { alert, probeMain, SOURCE } from './webhook-probe.js';
import { ZaloWebhookCommand } from './zalo.command.js';
import { ConvLog } from './zalo.convlog.js';
import type { WebhookDepsFactory } from './zalo.deps.js';
import { ZaloService } from './zalo.service.js';
import { fakeChannels, rig } from './zalo.test-helpers.js';

// DB test (container samsam-ts-db, DB riêng testDbName('zalo') từ mẫu, xóa khi xong — KHÔNG samsam):
// bằng chứng câu bot đã gửi CHỈ qua login svc_webhook (tests/test_docx_p0_rollout_gate.py p0b),
// cảnh báo đỏ probe 1 lần/đợt bằng login svc_job (tests/test_contract_c01_webhook.py), /readyz.

const NAME = testDbName('zalo');
const pid = process.pid;
const WH = `t_zalo_wh_${pid}`;
const JOB = `t_zalo_job_${pid}`;
const PW = `p${Math.random().toString(36).slice(2)}`;

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('zalo (DB)', () => {
  let owner: Pool;
  let wh: Pool;
  let job: Pool;
  const loginUrl = (user: string) => {
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = user;
    u.password = PW;
    u.pathname = `/${NAME}`;
    return u.toString();
  };

  beforeAll(async () => {
    owner = createPool(await createDbFromTemplate(NAME));
    for (const [r, role] of [
      [WH, 'svc_webhook'],
      [JOB, 'svc_job'],
    ]) {
      await adminQuery(`drop role if exists ${r}`);
      await adminQuery(`create role ${r} login password '${PW}' in role ${role}`);
    }
    wh = createPool(loginUrl(WH));
    job = createPool(loginUrl(JOB));
    installFakeDeps();
  });

  afterAll(async () => {
    await Promise.all([wh?.end(), job?.end(), owner?.end()]);
    await dropDb(NAME);
    for (const r of [WH, JOB]) await adminQuery(`drop role if exists ${r}`);
  });

  it('p0b: dòng live đủ điều kiện → 1 bằng chứng (chỉ khóa/cờ); mẫu/gửi lỗi → 0; login khác → từ chối, convlog vẫn ghi', async () => {
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { dir } = rig();
    const log = new ConvLog(join(dir, 'c.jsonl'), () => wh);
    const base = {
      ts: '2026-10-16T03:00:00Z',
      user_hash: 'u'.repeat(16),
      question: 'Hỏi giá sâm',
      answer: 'Giá 1.000.000đ',
      channel: 'messenger',
      answered: true,
      sent: true,
      guardrail_ok: true,
    };
    await log.log({ ...base, msg_id: 'm_live-1', provenance: 'live' });
    await log.log({ ...base, msg_id: 'm_mau-1' });
    await log.log({ ...base, msg_id: 'm_fail-1', sent: false, provenance: 'live' });
    const rows = (
      await owner.query(
        "select output_key, ban_ghi from file_output_evidence where nguon = 'conversations' and output_key like 'cv:messenger/%'",
      )
    ).rows;
    expect(rows.map((r) => r.output_key)).toEqual(['cv:messenger/m_live-1']);
    for (const leak of ['Hỏi', 'Giá', 'user_hash']) expect(rows[0].ban_ghi).not.toContain(leak);
    // login job (không phải svc_webhook) → DB từ chối 42501 → chỉ warn
    const bad = new ConvLog(join(dir, 'c.jsonl'), () => job);
    await bad.log({ ...base, msg_id: 'm_live-2', provenance: 'live' });
    expect(warn.mock.calls.flat().join('\n')).toContain('bị từ chối (InsufficientPrivilege)');
    const n = (
      await owner.query(
        "select count(*)::int n from file_output_evidence where output_key = 'cv:messenger/m_live-2'",
      )
    ).rows[0].n;
    expect(n).toBe(0);
    expect(readFileSync(join(dir, 'c.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
    warn.mockRestore();
  });

  it('cảnh báo đỏ webhook_probe: 1 lần/đợt (svc_job), lần 2 không lặp; xác nhận rồi → đợt mới', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a1 = await alert(job, [['http://x/readyz', 'HTTP 503']], {});
    const a2 = await alert(job, [['http://x/readyz', 'HTTP 503']], {});
    expect(a1).toBeGreaterThan(0);
    expect(a2).toBeNull();
    const cnt = async () =>
      (
        await owner.query('select count(*)::int n from red_alerts where source_agent = $1', [
          SOURCE,
        ])
      ).rows[0].n;
    expect(await cnt()).toBe(1);
    const d = (await owner.query('select detail from red_alerts where id = $1', [a1])).rows[0]
      .detail;
    expect(d).toEqual({ failed: [{ url: 'http://x/readyz', status: 'HTTP 503' }] });
    await owner.query("insert into red_alert_acks (alert_id, acked_by) values ($1, 'Người thật')", [
      a1,
    ]);
    expect(await alert(job, [['http://x/readyz', 'HTTP 503']], {})).toBeGreaterThan(a1 as number);
    vi.restoreAllMocks();
  });

  it('probeMain ghi cảnh báo qua pool login job, đóng pool', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = createPool(loginUrl(JOB));
    const code = await probeMain(
      { url: ['http://127.0.0.1:9/readyz'] },
      { probe: async () => [false, 'URLError'], connect: async () => p },
    );
    expect(code).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toMatch(/\[ALERT\]/);
    vi.restoreAllMocks();
  });

  it('lệnh zalo-webhook: nối core trên pool svc_webhook rồi mới dựng lớp kênh/RAG; DEPLOY bật mà chưa nối → [fatal] exit 1, đóng pool', async () => {
    vi.stubEnv('DEPLOY', '1');
    vi.stubEnv('ZALO_OA_SECRET', 's');
    vi.stubEnv('ZALO_ACCESS_TOKEN', 'tok');
    vi.stubEnv('WEBHOOK_DATABASE_URL', loginUrl(WH));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    const fakeGw = {} as AiGateway;
    const seen: { wired: Pool[]; made: [Pool | null, AiGateway][] } = { wired: [], made: [] };
    const run = async (factory?: WebhookDepsFactory) => {
      const cmd = new ZaloWebhookCommand(factory);
      cmd.wire = (p) => {
        seen.wired.push(p as Pool);
        return fakeGw;
      };
      await cmd.run();
    };
    await run();
    expect(process.exitCode).toBe(1);
    expect(out.mock.calls.flat().join('\n')).toContain(
      '[fatal] zalo: DEPLOY bật nhưng chưa nối lớp kênh/RAG',
    );
    // factory chỉ có lớp kênh (thiếu RAG) → vẫn chưa nối; nhận ĐÚNG pool đã nối core + gateway
    await run((pool, gw) => {
      seen.made.push([pool, gw]);
      return { channels: fakeChannels() };
    });
    expect(process.exitCode).toBe(1);
    expect(seen.wired).toHaveLength(2);
    expect(seen.made).toEqual([[seen.wired[1], fakeGw]]);
    for (const p of seen.wired) expect(p.ended).toBe(true);
    process.exitCode = before;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('readiness: DB login webhook thật → ok; host chết → loi (trong 2 giây)', async () => {
    const env = { ZALO_ACCESS_TOKEN: 'tok' };
    const ok = new ZaloService(wh, undefined, undefined, undefined, {
      env,
      tokenStore: join(rig().dir, 't.json'),
    });
    expect(await ok.readiness(ok.startupError())).toEqual([true, { config: 'ok', db: 'ok' }]);
    const dead = createPool('postgresql://u:p@10.255.255.1:5432/x', {
      connectionTimeoutMillis: 10_000,
    });
    const bad = new ZaloService(dead, undefined, undefined, undefined, {
      env,
      tokenStore: join(rig().dir, 't.json'),
    });
    const t0 = performance.now();
    expect(await bad.readiness(null)).toEqual([false, { config: 'ok', db: 'loi' }]);
    expect(performance.now() - t0).toBeLessThan(5000);
    await dead.end().catch(() => {});
  });
});
