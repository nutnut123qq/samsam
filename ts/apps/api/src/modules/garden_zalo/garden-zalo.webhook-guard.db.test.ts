import { readFileSync } from 'node:fs';
import { createPool } from '@samsam/core/db';
import { DOCS_DIR } from '@samsam/core/paths';
import {
  adminQuery,
  createDbFromTemplate,
  dbUrl,
  dropDb,
  testDbName,
} from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addLog } from './garden.js';
import { record } from './garden-media.js';
import { SOURCE } from './garden-zalo.service.js';

// Review cuối (MAJOR): grant cột cho svc_webhook không ràng buộc author/source → webhook bị chiếm ghi
// được nhật ký vườn dưới tên người + nguồn 'manual' vào hash chain. Trigger `webhook_garden_guard`
// chỉ cho dòng của luồng Zalo vườn. r22 A2: grant + trigger nay ở docs/roles.sql + schema.sql (DB mẫu
// dựng bằng `apply_schema.py --roles` — đổi 2 tệp đó thì `npm run db:template` lại); áp LẠI
// schema_ts.sql lên DB test để kiểm tệp TS hiện hành không gỡ/đè quyền vườn.

const NAME = testDbName('gz_guard');
const LOGIN = `t_gzwh_${process.pid}`;
const SHA = (c: string) => c.repeat(64);
const INFO = { width: 1, height: 1, exif_removed: 0, had_gps: false };

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('svc_webhook ghi vườn (DB)', () => {
  let admin: pg.Pool;
  let hook: pg.Pool;

  beforeAll(async () => {
    await dropDb(NAME);
    await adminQuery(`drop role if exists ${LOGIN}`);
    admin = createPool(await createDbFromTemplate(NAME));
    await admin.query(readFileSync(`${DOCS_DIR}/schema_ts.sql`, 'utf8'));
    await admin.query("insert into plots (id, location, source) values ('KV-G1', 'x', 'manual')");
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`create role ${LOGIN} login password '${pw}' in role svc_webhook`);
    const u = new URL(dbUrl(NAME));
    u.username = LOGIN;
    u.password = pw;
    hook = createPool(u.toString());
  });
  afterAll(async () => {
    await hook?.end();
    await admin?.end();
    await dropDb(NAME);
    await adminQuery(`drop role if exists ${LOGIN}`);
  });

  const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });

  it('plot_logs: tên người / nguồn manual → 42501; zalo:<mã> + zalo:garden → ghi được', async () => {
    const ins = (author: string, source: string, act: string) =>
      hook.query(
        'insert into plot_logs (plot_id, ts, activity, author, source) values ($1, now(), $2, $3, $4)',
        ['KV-G1', act, author, source],
      );
    await denied(ins('Nguyễn Văn A', 'manual', 'tưới'));
    await denied(ins('zalo:NV01', 'manual', 'bón'));
    await denied(ins('Nguyễn Văn A', SOURCE, 'làm cỏ'));
    await denied(ins(`zalo:${'x'.repeat(33)}`, SOURCE, 'trồng'));
    const [id, warns] = await addLog(hook, 'KV-G1', new Date(), 'tưới', null, 'zalo:NV01', SOURCE);
    expect([typeof id, warns]).toEqual(['bigint', []]);
    const r = await admin.query("select count(*)::int as n from plot_logs where source = 'manual'");
    expect(r.rows[0].n).toBe(0);
  });

  it('garden_media + garden_voice_drafts: chỉ nguồn zalo:garden', async () => {
    const today = '2026-10-30';
    await denied(record(hook, SHA('a'), 'jpg', 1, INFO, 'KV-G1', today, 'Nguyễn Văn A', SOURCE));
    await denied(record(hook, SHA('b'), 'jpg', 1, INFO, 'KV-G1', today, 'zalo:NV01', 'manual'));
    expect(await record(hook, SHA('c'), 'jpg', 1, INFO, 'KV-G1', today, 'zalo:NV01', SOURCE)).toBe(
      true,
    );
    const voice = (sha: string, code: string, source: string) =>
      hook.query(
        'insert into garden_voice_drafts (sha256, ext, bytes, staff_code, plot_id, source) values ($1, $2, $3, $4, $5, $6)',
        [sha, 'aac', 1, code, 'KV-G1', source],
      );
    await denied(voice(SHA('d'), 'NV01', 'manual'));
    await denied(voice(SHA('e'), 'x'.repeat(33), SOURCE));
    await voice(SHA('f'), 'NV01', SOURCE);
  });

  it('login owner/superuser không bị chặn (nhập tay/loader giữ nguyên)', async () => {
    const [id] = await addLog(admin, 'KV-G1', new Date(), 'thu hoạch', null, 'Nguyễn Văn A');
    expect(typeof id).toBe('bigint');
  });
});
