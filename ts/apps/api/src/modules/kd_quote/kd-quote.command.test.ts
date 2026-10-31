import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceBindError } from '@samsam/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { type KdQuoteOpts, kdQuoteMain } from './kd-quote.command.js';
import { MATRIX_FILE } from './kd-quote.js';

// CLI `kd_quote` không DB: tests/test_kd_quote.py (tham số sai exit 2 TRƯỚC connect, --check-matrix,
// DB down) + tests/test_v14_p4_sales.py (--outcome/--followups tham số).

const tmp = mkdtempSync(join(tmpdir(), 'kdq-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const fail = async () => {
  throw new Error('không được connect');
};

describe('kd_quote CLI', () => {
  it.each<[KdQuoteOpts]>([
    [{ requests: true, quote: '1' }],
    [{ checkMatrix: true, requests: true }],
    [{ quote: '1', export: '2', out: 'x.md' }],
    [{ quote: '1', submit: true, dryRun: true }],
    [{ requests: true, submit: true }],
    [{ export: '1' }],
    [{ quote: '1', discount: '60' }],
    [{ quote: '1', discount: '5.5' }],
    [{ quote: '1', date: '12/10/2026' }],
    [{ quote: 'x' }],
    [{}],
    [{ outcome: ['5', 'chot'] }],
    [{ outcome: ['5', 'thang'], by: 'Lan' }],
    [{ outcome: ['5'], by: 'Lan' }],
    [{ outcome: ['x5', 'chot'], by: 'Lan' }],
    [{ outcome: ['5', 'chot'], by: '  ' }],
    [{ followups: true, by: 'Lan' }],
    [{ requests: true, dryRun: true }],
    [{ verifySend: ['x', 'a.md'] }],
    [{ verifySend: ['1', 'a.md', 'b'] }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await kdQuoteMain(o, { io: s.io, connect: fail, jobConnect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^kd_quote: error: /);
  });

  it('DB down → exit 2 (--requests / --verify-send)', async () => {
    for (const o of [{ requests: true }, { verifySend: ['1', 'x.md'] }]) {
      const s = io();
      expect(await kdQuoteMain(o, { io: s.io, connect: async () => null })).toBe(2);
      expect(s.err[0]).toContain('không kết nối được Postgres');
    }
  });

  it('--followups: login dịch vụ job bị từ chối → [err] exit 2 (auth.bind_service)', async () => {
    const s = io();
    const rc = await kdQuoteMain(
      { followups: true },
      {
        io: s.io,
        jobConnect: async () => {
          throw new ServiceBindError('chế độ thực: thiếu JOB_DATABASE_URL');
        },
      },
    );
    expect(rc).toBe(2);
    expect(s.out).toEqual(['[err] chế độ thực: thiếu JOB_DATABASE_URL']);
  });

  it('--check-matrix: ma trận thật hợp lệ + CHƯA xác nhận; key rượu / thiếu file → exit 1', async () => {
    let s = io();
    expect(await kdQuoteMain({ checkMatrix: true }, { io: s.io, connect: fail })).toBe(0);
    expect(s.out[0]).toContain('tài chính CHƯA xác nhận');
    const doc = JSON.parse(readFileSync(MATRIX_FILE, 'utf8'));
    doc.items['ruou-sam-chai-thuy-tinh-500ml'] = { max_discount_pct: 5 };
    const bad = join(tmp, 'm.json');
    writeFileSync(bad, JSON.stringify(doc));
    s = io();
    expect(await kdQuoteMain({ checkMatrix: bad }, { io: s.io, connect: fail })).toBe(1);
    expect(s.err.join('\n')).toContain('rượu');
    s = io();
    expect(
      await kdQuoteMain({ checkMatrix: join(tmp, 'khong-co.json') }, { io: s.io, connect: fail }),
    ).toBe(1);
    expect(s.err[0]).toBe('[error] thiếu file khong-co.json');
  });
});
