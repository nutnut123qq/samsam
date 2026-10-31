import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Queryable } from '../db.js';
import { createGateway } from '../ops/wire.js';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import { AiGateway } from './gateway.js';

// llm_usage THẬT (DB test từ mẫu): chi tiêu tháng theo giờ VN (dòng tháng trước không tính), dòng ghi
// có feature_id, và login dịch vụ `in role svc_webhook` (kế thừa agent_writer — quyền CỘT
// llm_usage + feature_rollout) chạy được gateway. KHÔNG BAO GIỜ DB samsam.

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('AI Gateway + llm_usage (DB)', () => {
  const name = testDbName('ai');
  const login = `t_ai_webhook_${process.pid}`;
  const uiLogin = `t_ai_ui_${process.pid}`;
  let owner: pg.Pool;
  let svc: pg.Pool;
  let ui: pg.Pool;
  let server: Server;
  let base = '';
  const dir = mkdtempSync(join(tmpdir(), 'gwdb-'));
  const warns: string[] = [];

  // Bản tối giản `rollout.mode` (nhóm rollout port thật) — đủ cho cổng 'tat'.
  const mode = async (q: Queryable | null, f: string) => {
    const r = await q
      ?.query('select stage from feature_rollout where feature_id = $1', [f])
      .catch(() => null);
    return (r?.rows[0]?.stage as string | undefined) ?? 'chay_thu';
  };
  const gw = (pool: Queryable) =>
    new AiGateway({
      pool,
      maskPii: (s) => s,
      maskIdentity: (s) => s,
      piiRe: /$^/g,
      rolloutMode: mode,
      env: { OLLAMA_URL: base },
      files: { gateway: join(dir, 'llm_gateway.json') },
      warn: (m) => warns.push(m),
    });
  const MSG = [{ role: 'user' as const, content: 'hi' }];

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 1000, eval_count: 1000 }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(dir, 'llm_gateway.json'),
      JSON.stringify({
        prices_usd_per_1m: { m: { in: 1, out: 1 } },
        monthly_cap_usd: { default: 1.0 },
        feature_caps_usd: { default: 1.0 },
      }),
    );
    const url = await createDbFromTemplate(name);
    owner = createPool(url);
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`create role ${login} login password '${pw}' in role svc_webhook`);
    const u = new URL(url);
    u.username = login;
    u.password = pw;
    svc = createPool(u.toString());
    await adminQuery(`create role ${uiLogin} login password '${pw}' in role svc_ui`);
    u.username = uiLogin;
    ui = createPool(u.toString());
    // Mốc 00:00 ngày 1 GIỜ VN: +1 phút = tháng này, −1 phút = tháng trước (không tính vào trần).
    const start =
      "(date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')";
    await owner.query(
      `insert into llm_usage (agent_id, model, cost_usd, ok, feature_id, ts) values
        ('chatbot', 'm', 0.85, true, 'sales-01', ${start} + interval '1 minute'),
        ('chatbot', 'm', 5.0, true, 'sales-01', ${start} - interval '1 minute'),
        ('content', 'm', 0.999, true, 'marketing-01.1', ${start} + interval '1 minute')`,
    );
  });
  afterAll(async () => {
    await svc?.end();
    await ui?.end();
    await owner?.end();
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`drop role if exists ${uiLogin}`);
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('chi tiêu tháng giờ VN: dòng tháng trước không tính; ≥80% cảnh báo vẫn gọi', async () => {
    const r = await gw(svc).chat('chatbot', MSG, { feature: 'sales-03', model: 'm' });
    expect(r.text).toBe('ok');
    expect(warns.join('\n')).toContain("agent 'chatbot' đã dùng 0.8500/1.00 USD (>=80%)");
  });

  it('dòng llm_usage ghi bằng login dịch vụ, có feature_id + cost', async () => {
    const { rows } = await owner.query(
      "select agent_id, model, tokens_in, tokens_out, cost_usd::float8 as cost, ok, error, feature_id from llm_usage where feature_id = 'sales-03'",
    );
    expect(rows).toEqual([
      {
        agent_id: 'chatbot',
        model: 'm',
        tokens_in: 1000,
        tokens_out: 1000,
        cost: 0.002,
        ok: true,
        error: null,
        feature_id: 'sales-03',
      },
    ]);
  });

  it('trần tính năng đọc theo feature_id; vượt → chặn', async () => {
    await expect(
      gw(svc).chat('other', MSG, { feature: 'marketing-01.1', model: 'm' }),
    ).resolves.toBeTruthy();
    await expect(
      gw(svc).chat('other', MSG, { feature: 'marketing-01.1', model: 'm' }),
    ).rejects.toThrow(/tính năng 'marketing-01.1' vượt trần tháng/);
  });

  it('sổ triển khai TẮT (feature_rollout, login dịch vụ đọc được) → chặn trước khi gọi', async () => {
    await owner.query(
      "insert into feature_rollout (feature_id, stage, updated_by) values ('ceo-02', 'tat', 'test')" +
        " on conflict (feature_id) do update set stage = 'tat'",
    );
    await expect(gw(svc).chat('cockpit', MSG, { feature: 'ceo-02', model: 'm' })).rejects.toThrow(
      /đang TẮT/,
    );
  });

  it('login svc_ui (tiến trình API) + wiring thật (pii, rollout.mode): đọc chi tiêu + ghi llm_usage', async () => {
    // svc_ui kế thừa app_human → agent_writer (docs/roles.sql) — quyền CỘT llm_usage + feature_rollout.
    const g = createGateway(ui, {
      env: { OLLAMA_URL: base },
      files: { gateway: join(dir, 'llm_gateway.json') },
      warn: (m) => warns.push(m),
    });
    expect((await g.chat('ui_studio', MSG, { feature: 'marketing-01.2', model: 'm' })).text).toBe(
      'ok',
    );
    const { rows } = await owner.query(
      "select ok, feature_id from llm_usage where agent_id = 'ui_studio'",
    );
    expect(rows).toEqual([{ ok: true, feature_id: 'marketing-01.2' }]);
    // rollout.mode THẬT đọc feature_rollout bằng svc_ui: ceo-02 đã TẮT ở ca trên → chặn.
    await expect(g.chat('ui_studio', MSG, { feature: 'ceo-02', model: 'm' })).rejects.toThrow(
      /đang TẮT/,
    );
  });
});
