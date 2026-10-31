import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import G from './__fixtures__/loader_gate.golden.json' with { type: 'json' };
import { check, decide, LOADERS, loadConfig, status } from './loader-gate.js';
import { installFakeDeps } from './testing.js';

type Out = { ok?: unknown; error?: string; msg?: string };
const DIR = mkdtempSync(join(tmpdir(), 'lgate-'));
const CAT = new Set(G.catalog);

function file(name: string, b64: string | null): string {
  const p = join(DIR, `gate_${name}.json`);
  if (b64 !== null) writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

describe('loader-gate golden (Python)', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('decide: mọi chính sách × giai đoạn', () => {
    for (const c of G.decide) {
      expect(decide(c.policy, c.stages as Record<string, string>)).toEqual([c.ok, c.why]);
    }
  });

  it('loadConfig: file hỏng/thiếu loader/mã lạ/chính sách thiếu người → lỗi y hệt', () => {
    for (const c of G.configs) {
      const p = file(c.name, c.body);
      let got: Out;
      try {
        got = { ok: loadConfig(p, CAT) };
      } catch (e) {
        got = { error: (e as Error).name, msg: (e as Error).message };
      }
      const want = c.out as Out;
      if (want.error) expect(got.msg, c.name).toBe(want.msg);
      else expect(got.ok, c.name).toEqual(want.ok);
    }
  });
});

describe('loader-gate check', () => {
  it('cấu hình repo: mọi loader chưa cấu hình; tính năng TẮT → chặn; DB null → chặn', async () => {
    const st = installFakeDeps({}, { quick: null, catalog: G.catalog.map((id) => ({ id })) });
    const real = loadConfig();
    expect(LOADERS.every((l) => real[l].policy === null)).toBe(true);
    const logs: string[] = [];
    // không có DB → không biết giai đoạn → chặn
    expect(await check('market_csv', null, undefined, (s) => logs.push(s))).toMatch(
      /không kết nối được DB/,
    );
    const db = {} as never; // mode giả không chạm DB
    st.stages = { 'data_platform-05': 'van_hanh', 'sales-06.2': 'tat' };
    expect(await check('market_csv', db, undefined, (s) => logs.push(s))).toMatch(/KHÔNG nạp/);
    st.stages['sales-06.2'] = 'chay_thu';
    expect(await check('market_csv', db, undefined, (s) => logs.push(s))).toBeNull();
    expect(logs.at(-1)).toMatch(/^\[loader-gate\] market_csv: chính sách CHƯA CẤU HÌNH/);
    await expect(check('nope', db)).rejects.toThrow(/loader lạ/);
  });

  it('file hỏng → MỌI loader bị chặn; --status exit 1', async () => {
    installFakeDeps({}, { catalog: G.catalog.map((id) => ({ id })) });
    const p = file('broken', Buffer.from('{').toString('base64'));
    for (const l of LOADERS) expect(await check(l, null, p)).toMatch(/fail-closed/);
    const [lines, rc] = await status(null, p);
    expect(rc).toBe(1);
    expect(lines[0]).toMatch(/mọi loader bị chặn/);
    const [ok, rc0] = await status({} as never);
    expect(rc0).toBe(0);
    expect(ok.at(-1)).toBe('[done] 8 loader, 8 chưa cấu hình chính sách');
  });
});
