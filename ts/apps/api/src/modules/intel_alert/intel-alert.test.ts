import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import type { Db } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/counters';
import { catalog, EXIT_BLOCKED } from '@samsam/core/rollout/rollout';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as ia from './intel-alert.js';
import * as ib from './intel-bulletin.js';
import * as lu from './legal-updates.js';
import * as ps from './persona-sim.js';

// Phần KHÔNG DB của tests/test_intel_alert.py, test_intel_bulletin.py, test_pc_a8.py,
// test_v13_c09_anchor_legal.py, test_r19_ngay_cong_som.py (M2: cổng TẮT trước mọi connect),
// test_persona_sim.py: tham số sai exit 2 TRƯỚC connect, luật hỏng exit 1 TRƯỚC connect, DB down,
// cổng triển khai TẮT, luật tính năng tắt (P8.3), cổng DPIA + ≥3 nhà cung cấp, gateway giả/thật,
// cách ly (không đường sang content_drafts/kênh gửi). Không gọi LLM/mạng thật.

type Obj = Record<string, unknown>;
const det = (r: unknown): Obj => ((r ?? {}) as Obj).detail as Obj;
const tmp = mkdtempSync(join(tmpdir(), 'ia-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const noConnect = async (): Promise<never> => {
  throw new Error('không được connect');
};
beforeEach(() => {
  installFakeDeps();
  settings.forceMode = null;
});
afterEach(() => {
  settings.forceMode = null;
});

// ---------------------------------------------------------------- intel_alert CLI

describe('intel_alert CLI', () => {
  it.each<[ia.IntelAlertOpts]>([
    [{}],
    [{ run: true, open: true }],
    [{ run: true, ack: '1', by: 'Hoa' }],
    [{ ack: '1' }],
    [{ ack: 'x', by: 'Hoa' }],
    [{ run: true, by: 'Hoa' }],
    [{ open: true, note: 'x' }],
    [{ ack: '1', by: '   ' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await ia.intelAlertMain(o, { io: s.io, connect: noConnect })).toBe(2);
    expect(s.err[0]).toMatch(/^intel_alert: error: /);
  });

  it('luật hỏng / legal_sources rỗng → exit 1 TRƯỚC connect', async () => {
    const base = JSON.parse(readFileSync(ia.RULES_FILE, 'utf8')) as Obj;
    for (const [name, content, want] of [
      ['r1.json', '{}', 'luật cảnh báo hỏng'],
      ['r2.json', JSON.stringify({ ...base, legal_sources: [] }), 'legal_sources'],
    ] as const) {
      const p = join(tmp, name);
      writeFileSync(p, content);
      const s = io();
      expect(
        await ia.intelAlertMain({ run: true }, { io: s.io, connect: noConnect, rulesFile: p }),
      ).toBe(1);
      expect(s.out.join('\n')).toContain(want);
    }
  });

  it('DB down → exit 1 "không kết nối được"', async () => {
    const s = io();
    let n = 0;
    const connect = async () => {
      n++;
      return null;
    };
    expect(await ia.intelAlertMain({ open: true }, { io: s.io, connect })).toBe(1);
    expect(n).toBe(1);
    expect(s.out[0]).toContain('không kết nối được');
  });

  it('ack: đầu vào lỗi → (false, lý do) KHÔNG chạm DB', async () => {
    const db = {
      query: () => {
        throw new Error('không được truy vấn');
      },
    } as unknown as Db;
    const cases: [unknown, unknown, string][] = [
      [5, '', 'thiếu tên'],
      [5, '   ', 'thiếu tên'],
      [5, 'x'.repeat(101), 'dài quá'],
      ['abc', 'Hoa', 'không hợp lệ'],
      [2n ** 63n, 'Hoa', 'không hợp lệ'],
      [-1, 'Hoa', 'không hợp lệ'],
      [0, 'Hoa', 'không hợp lệ'],
    ];
    for (const [id, by, want] of cases) {
      const [ok, msg] = await ia.ack(db, id, by);
      expect(ok).toBe(false);
      expect(msg).toContain(want);
    }
    expect((await ia.ack(db, 2n ** 63n, 'Hoa'))[1]).toBe("id '9223372036854775808' không hợp lệ");
  });
});

// ---------------------------------------------------------------- luật tính năng TẮT (P8.3)

describe('offRules + scan (HĐ 6.7, không DB)', () => {
  const feats = [
    {
      id: 'intel-02.1',
      output_sources: [
        { table: 'red_alerts', source_agent: ia.SOURCE_AGENT, rules_any: ['counterfeit'] },
      ],
    },
    {
      id: 'intel-02.3',
      output_sources: [
        { table: 'red_alerts', source_agent: ia.SOURCE_AGENT, rules_any: ['brand_negative'] },
      ],
    },
    {
      id: 'legal_hr-07',
      output_sources: [
        { table: 'red_alerts', source_agent: ia.SOURCE_AGENT, rules_any: ['legal_doc'] },
      ],
    },
    { id: 'khac-01', output_sources: [{ table: 'red_alerts', source_agent: 'agent:khac' }] },
  ];
  const deps = (stages: Record<string, string>) => ({
    catalog: () => feats,
    mode: async (_db: Db | null, fid: string) => stages[fid] ?? 'chay_thu',
  });

  it('luật của tính năng tắt; luật không thuộc tính năng nào không chặn; rules_any rỗng = mọi luật', async () => {
    expect(await ia.offRules(null, deps({}))).toEqual(new Set());
    expect(await ia.offRules(null, deps({ 'intel-02.3': 'tat' }))).toEqual(
      new Set(['brand_negative']),
    );
    expect(
      await ia.offRules(null, deps({ 'legal_hr-07': 'tat', 'intel-02.1': 'van_hanh' })),
    ).toEqual(new Set(['legal_doc']));
    expect(await ia.offRules(null, deps({ 'khac-01': 'tat' }))).toEqual(new Set());
    const all = {
      catalog: () => [
        {
          id: 'f-01',
          output_sources: [{ table: 'red_alerts', source_agent: ia.SOURCE_AGENT, rules_any: [] }],
        },
      ],
      mode: async () => 'tat',
    };
    expect(await ia.offRules(null, all)).toEqual(new Set(ia.RULES));
  });

  it('danh mục THẬT: intel-02.1/02.2/02.3 + legal_hr-07 phủ đủ 5 luật', async () => {
    const owned = new Map<string, string>();
    for (const f of catalog() ?? []) {
      for (const s of f.output_sources) {
        if (s.table === 'red_alerts' && s.source_agent === ia.SOURCE_AGENT) {
          for (const r of (s.rules_any as string[]) ?? []) owned.set(r, f.id);
        }
      }
    }
    expect(Object.fromEntries(owned)).toEqual({
      counterfeit: 'intel-02.1',
      regulation: 'intel-02.2',
      competitor_penalty: 'intel-02.2',
      brand_negative: 'intel-02.3',
      legal_doc: 'legal_hr-07',
    });
    const real = {
      catalog: () => catalog() ?? [],
      mode: async (_d: Db | null, f: string) => (f === 'intel-02.3' ? 'tat' : 'chay_thu'),
    };
    expect(await ia.offRules(null, real)).toEqual(new Set(['brand_negative']));
  });

  it('scan: tin chỉ khớp luật tắt → off, KHÔNG ghi; tin 2 luật → bỏ luật tắt; trùng (23505) → dup', async () => {
    const items = [
      {
        id: '1',
        title: 'Thu hồi lô sâm Sâm Sâm nghi giả mạo',
        snippet: '',
        topics: ['sam'],
        flags: [],
        url: 'https://a/1',
        source: 'fx',
        published_iso: null,
        fetched_iso: '2026-10-12T08:00:00+07:00',
      },
      {
        id: '2',
        title: 'Dự thảo nghị định về quảng cáo thực phẩm bảo vệ sức khỏe',
        snippet: '',
        topics: ['phap_ly', 'tpbvsk', 'quang_cao'],
        flags: [],
        url: 'https://a/2',
        source: 'cuc-attp-van-ban',
        published_iso: null,
        fetched_iso: null,
      },
      {
        id: '3',
        title: 'Sâm giả tràn lan chợ Tết',
        snippet: '',
        topics: ['sam'],
        flags: [],
        url: 'https://a/3',
        source: 'fx',
        published_iso: null,
        fetched_iso: null,
      },
      {
        id: '4',
        title: 'Sâm Sâm ra mắt hộp quà Tết',
        snippet: '',
        topics: ['sam'],
        flags: [],
        url: 'https://a/4',
        source: 'fx',
        published_iso: null,
        fetched_iso: null,
      },
    ];
    const db = {
      query: async (sql: string, p: unknown[]) => {
        if (sql.startsWith('select i.id')) return { rows: items };
        if (sql.startsWith('select id from red_alerts')) return { rows: [{ id: `9${p[1]}` }] };
        throw new Error(sql);
      },
    } as unknown as Db;
    const raised: Obj[] = [];
    const raise = (async (_db: Db, agent: string, title: string, detail: unknown) => {
      raised.push({ agent, title, detail });
      if ((detail as Obj).intel_item_id === 3)
        throw Object.assign(new Error('dup'), { code: '23505' });
      return [false, 'thiếu người nhận'];
    }) as unknown as NonNullable<Parameters<typeof ia.scan>[2]>['raise'];
    const st = await ia.scan(db, new Date('2026-10-12T09:00:00+07:00'), {
      rules: ia.loadRules(),
      raise,
      offDeps: deps({ 'intel-02.3': 'tat' }),
    });
    expect(st).toEqual({ scanned: 4, alerts: 1, dup: 1, unrouted: 1, ids: [92], off: 1 });
    expect(raised.map((r) => (r.detail as Obj).intel_item_id)).toEqual([2, 3]);
    expect(det(raised[0]).rules).toEqual(['regulation', 'legal_doc']);
    expect(raised[0]?.agent).toBe(ia.SOURCE_AGENT);
    expect(raised[0]?.title).toBe(
      `${ia.ALERT_PREFIX}Dự thảo nghị định về quảng cáo thực phẩm bảo vệ sức khỏe`,
    );
    expect(raised[0]?.detail).toEqual({
      intel_item_id: 2,
      rules: ['regulation', 'legal_doc'],
      url: 'https://a/2',
      source: 'cuc-attp-van-ban',
      published_at: null,
      fetched_at: null,
    });
  });
});

// ---------------------------------------------------------------- intel_bulletin CLI

describe('intel_bulletin CLI', () => {
  it.each<[ib.BulletinOpts]>([
    [{ date: '2026-13-01' }],
    [{ period: 'month' }],
    [{ date: '12/10/2026' }],
    [{ period: 'week', date: '9999-12-31' }],
    [{ period: 'day', date: '9999-12-31' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await ib.intelBulletinMain(o, { io: s.io, connect: noConnect })).toBe(2);
    expect(s.err[0]).toMatch(/^intel_bulletin\.py: error: /);
  });

  it('ngày ISO tuần/YYYYMMDD như Python 3.12 date.fromisoformat (không chặn)', async () => {
    for (const date of ['20261012', '2026-W42-1', '9999-12-30']) {
      const s = io();
      expect(await ib.intelBulletinMain({ date }, { io: s.io, connect: async () => null })).toBe(1);
      expect(s.out[0]).toContain('không kết nối được');
    }
  });

  it('DB down → exit 1', async () => {
    const s = io();
    expect(
      await ib.intelBulletinMain({ period: 'day' }, { io: s.io, connect: async () => null }),
    ).toBe(1);
    expect(s.out[0]).toContain('không kết nối được');
  });

  it('cổng TẮT (cả bản tin lẫn gợi ý) → [rollout] exit 2, KHÔNG connect, không ghi file', async () => {
    settings.forceMode = 'tat';
    const outDir = join(tmp, 'rep-off');
    for (const o of [{}, { suggest: true }, { llm: true }]) {
      const s = io();
      expect(await ib.intelBulletinMain(o, { io: s.io, connect: noConnect, outDir })).toBe(
        EXIT_BLOCKED,
      );
      const lines = s.out;
      expect(lines.length).toBe(o.suggest ? 2 : 1);
      expect(lines[0]).toMatch(/^\[rollout\] .*intel-01\.1/);
      if (o.suggest) expect(lines[1]).toMatch(/^\[rollout\] .*intel-01\.2/);
    }
    expect(() => readdirSync(outDir)).toThrow();
  });
});

// ---------------------------------------------------------------- legal_updates CLI

describe('legal_updates CLI', () => {
  it.each<[lu.LegalUpdatesOpts]>([
    [{}],
    [{ dryRun: true }],
    [{ submit: true, limit: '0' }],
    [{ submit: true, limit: '201' }],
    [{ submit: true, limit: 'x' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await lu.legalUpdatesMain(o, { io: s.io, connect: noConnect })).toBe(2);
    expect(s.err[0]).toMatch(/^legal_updates: error: /);
  });

  it.each([[{ submit: true, dryRun: true }], [{ submit: true }]])(
    'r19 M2: TẮT → đúng 1 dòng [rollout] legal_hr-07, exit 2, KHÔNG connect %j',
    async (o) => {
      settings.forceMode = 'tat';
      const s = io();
      expect(await lu.legalUpdatesMain(o, { io: s.io, connect: noConnect })).toBe(EXIT_BLOCKED);
      expect(s.out.length).toBe(1);
      expect(s.out[0]).toMatch(/^\[rollout\] .*legal_hr-07/);
    },
  );

  it.each(['chay_thu', 'van_hanh'])(
    'bật (%s) → qua cổng tới connect (None → exit 2)',
    async (st) => {
      settings.forceMode = st;
      const s = io();
      let n = 0;
      const connect = async () => {
        n++;
        return null;
      };
      expect(await lu.legalUpdatesMain({ submit: true }, { io: s.io, connect })).toBe(2);
      expect(n).toBe(1);
      expect(s.out.join('')).not.toContain('[rollout]');
      expect(s.err[0]).toBe('[err] DB không kết nối được');
    },
  );

  it('luật hỏng → exit 1 (stderr) TRƯỚC connect', async () => {
    const p = join(tmp, 'lu-bad.json');
    writeFileSync(p, '[]');
    const s = io();
    expect(
      await lu.legalUpdatesMain({ submit: true }, { io: s.io, connect: noConnect, rulesFile: p }),
    ).toBe(1);
    expect(s.err[0]).toContain('gốc phải là object');
  });
});

// ---------------------------------------------------------------- persona_sim

describe('persona_sim', () => {
  const CFG = ps.readJsonDoc(ps.CONFIG_FILE)[0] as Obj;
  const MULTI = ['openai/gpt-4o-mini', 'anthropic/model-gia-thu', 'google/model-gia-thu'];
  const signedMulti = (d: Obj) => {
    d.dpia_signed = true;
    (d.models as Obj[]).forEach((m, i) => {
      m.id = MULTI[i];
    });
  };
  let n = 0;
  const writeCfg = (mut: (d: Obj) => void): string => {
    const d = structuredClone(CFG);
    mut(d);
    const p = join(tmp, `sim_config_${n++}.json`);
    writeFileSync(p, JSON.stringify(d));
    return p;
  };
  const boom = () => {
    throw new Error('không được gọi');
  };
  type FakeDb = { sql: string[]; params: unknown[][] };
  const fakeLease = (rec: FakeDb) => async () => ({
    db: {
      query: async (sql: string, p?: unknown[]) => {
        rec.sql.push(sql);
        if (p) rec.params.push(p);
        return { rows: [] };
      },
    } as unknown as Db,
    release: async () => {},
  });

  it('file repo hợp lệ + drift-guard (không tự ký DPIA)', () => {
    expect(CFG.dpia_signed).toBe(false);
    expect((CFG.models as Obj[]).length).toBe(3);
    expect((CFG.options as Obj[]).filter((o) => o.control === true).length).toBe(1);
  });

  it.each<[string, (d: Obj) => void]>([
    ['false', () => {}],
    ['missing', (d) => delete d.dpia_signed],
    ['str_true', (d) => Object.assign(d, { dpia_signed: 'true' })],
    ['int_1', (d) => Object.assign(d, { dpia_signed: 1 })],
  ])('cổng DPIA từ chối (%s) — so khớp `=== true` nghiêm ngặt, 0 AI 0 DB', async (_k, mut) => {
    const p = writeCfg(mut);
    const s = io();
    expect(
      await ps.personaSimMain(
        { config: p },
        { io: s.io, connect: noConnect, chat: boom, canonicalConfig: p },
      ),
    ).toBe(2);
    expect(s.err.join('\n')).toMatch(/\[refuse\].*DPIA/);
  });

  it('cổng DPIA chỉ mở khi CẢ 2 phía true (chạm lời gọi thật)', async () => {
    const p = writeCfg(signedMulti);
    settings.forceMode = 'van_hanh';
    class Opened extends Error {}
    await expect(
      ps.personaSimMain(
        { config: p },
        {
          io: io().io,
          connect: noConnect,
          chat: () => {
            throw new Opened();
          },
          canonicalConfig: p,
        },
      ),
    ).rejects.toBeInstanceOf(Opened);
  });

  it('--config tự ghi true KHÔNG mở cổng khi file CHUẨN false/thiếu', async () => {
    const p = writeCfg((d) => Object.assign(d, { dpia_signed: true }));
    for (const canon of [ps.CONFIG_FILE, join(tmp, 'khong-co.json')]) {
      const s = io();
      expect(
        await ps.personaSimMain(
          { config: p },
          { io: s.io, connect: noConnect, chat: boom, canonicalConfig: canon },
        ),
      ).toBe(2);
      expect(s.err.join('')).toContain('[refuse]');
    }
  });

  it('đầu vào sai → exit 1 TRƯỚC AI/DB', async () => {
    const p = writeCfg((d) => Object.assign(d, { repeats: 4, dpia_signed: true }));
    let s = io();
    expect(
      await ps.personaSimMain({ config: p }, { io: s.io, connect: noConnect, chat: boom }),
    ).toBe(1);
    expect(s.err[0]).toContain('[err]');
    for (const content of ['', '{bad', '[]']) {
      writeFileSync(p, content);
      s = io();
      expect(
        await ps.personaSimMain(
          { config: p, dryRun: true },
          { io: s.io, connect: noConnect, chat: boom },
        ),
      ).toBe(1);
    }
    s = io();
    expect(
      await ps.personaSimMain(
        { config: join(tmp, 'missing.json') },
        { io: s.io, connect: noConnect, chat: boom },
      ),
    ).toBe(1);
  });

  it('r13: DPIA đã ký nhưng 3 model cùng 1 nhà cung cấp → [refuse] exit 2, 0 lời gọi', async () => {
    const p = writeCfg((d) => Object.assign(d, { dpia_signed: true }));
    const s = io();
    expect(
      await ps.personaSimMain(
        { config: p },
        { io: s.io, connect: noConnect, chat: boom, canonicalConfig: p },
      ),
    ).toBe(2);
    expect(s.err.join('')).toContain('nhà cung cấp');
  });

  it('intel-05.1 TẮT → [blocked] exit 2, 0 lời gọi, 0 ghi', async () => {
    settings.forceMode = 'tat';
    const s = io();
    const rec: FakeDb = { sql: [], params: [] };
    expect(
      await ps.personaSimMain({ dryRun: true }, { io: s.io, connect: fakeLease(rec), chat: boom }),
    ).toBe(2);
    expect(s.err[0]).toMatch(/^\[blocked\] /);
    expect(rec.sql).toEqual([]);
  });

  it('--dry-run: 180 dòng sim_runs trong 1 giao dịch, báo cáo khoảng, KHÔNG gọi AI', async () => {
    settings.forceMode = 'van_hanh';
    const s = io();
    const rec: FakeDb = { sql: [], params: [] };
    expect(
      await ps.personaSimMain(
        { dryRun: true },
        { io: s.io, connect: fakeLease(rec), chat: boom, wire: boom },
      ),
    ).toBe(0);
    expect(rec.sql[0]).toBe('begin');
    expect(rec.sql.at(-1)).toBe('commit');
    const ins = rec.sql.filter((q) => q.startsWith('insert into sim_runs'));
    expect(ins.length).toBe(1);
    const flat = rec.params[0] as unknown[];
    expect(flat.length).toBe(180 * ps.SIM_COLS.length);
    const iDry = ps.SIM_COLS.indexOf('dry_run');
    for (let r = 0; r < 180; r++) expect(flat[r * ps.SIM_COLS.length + iDry]).toBe(true);
    const out = s.out.join('\n');
    expect(out).toContain('DRY-RUN');
    expect(out).toContain('KHÔNG phải dự báo doanh số');
    expect(out).toContain('WEIRD');
    expect(out).toContain('p10');
    expect(s.out.at(-1)).toMatch(
      /^\[ok\] 180 dòng sim_runs \(45 lời gọi\) run_id=dry-\d{8}-[0-9a-f]{8}$/,
    );
  });

  it('lượt thật: chỉ qua AI Gateway (agent persona_sim, feature intel-05.1, model + temperature)', async () => {
    settings.forceMode = 'van_hanh';
    const p = writeCfg(signedMulti);
    const ids = (CFG.options as Obj[]).map((o) => o.id as string);
    const seen: [string, Obj][] = [];
    const gw = {
      chat: async (agent: string, _m: unknown, opts: Obj) => {
        seen.push([agent, opts]);
        return {
          text: JSON.stringify(
            Object.fromEntries(ids.map((i) => [i, i === 'doi-chung-yeu' ? 1 : 7])),
          ),
          model: 'openai/gpt-4o-mini-2024-07-18',
        };
      },
    };
    const rec: FakeDb = { sql: [], params: [] };
    const s = io();
    expect(
      await ps.personaSimMain(
        { config: p },
        { io: s.io, connect: fakeLease(rec), wire: () => gw, canonicalConfig: p },
      ),
    ).toBe(0);
    expect(s.out.join('\n')).not.toContain('DRY-RUN');
    expect(seen.length).toBe(45);
    expect(new Set(seen.map(([a]) => a))).toEqual(new Set(['persona_sim']));
    expect(new Set(seen.map(([, o]) => o.model))).toEqual(new Set(MULTI));
    expect(new Set(seen.map(([, o]) => o.feature))).toEqual(new Set(['intel-05.1']));
    expect(new Set(seen.map(([, o]) => o.temperature))).toEqual(new Set([CFG.temperature]));
    const flat = rec.params[0] as unknown[];
    const iVer = ps.SIM_COLS.indexOf('model_version');
    const iSeed = ps.SIM_COLS.indexOf('seed');
    const W = ps.SIM_COLS.length;
    for (let r = 0; r < flat.length / W; r++) {
      expect(flat[r * W + iVer]).toBe('openai/gpt-4o-mini-2024-07-18');
    }
    const base = CFG.base_seed as number;
    expect(
      [...new Set(Array.from({ length: flat.length / W }, (_, r) => flat[r * W + iSeed]))].sort(),
    ).toEqual([0, 1, 2, 3, 4].map((i) => base + i));
  });

  it('gateway chặn giữa chừng → exit 1, 0 dòng ghi, không in báo cáo', async () => {
    settings.forceMode = 'van_hanh';
    const p = writeCfg(signedMulti);
    let k = 0;
    const gw = {
      chat: async () => {
        k++;
        if (k === 10) throw new GatewayBlocked("agent 'persona_sim' vượt trần");
        return { text: '{}', model: 'x' };
      },
    };
    const rec: FakeDb = { sql: [], params: [] };
    const s = io();
    expect(
      await ps.personaSimMain(
        { config: p },
        { io: s.io, connect: fakeLease(rec), wire: () => gw, canonicalConfig: p },
      ),
    ).toBe(1);
    expect(k).toBe(10);
    expect(rec.sql).toEqual([]);
    expect(s.err.join('')).toContain('GatewayBlocked');
    expect(s.err.join('')).toContain('0 dòng');
    expect(s.out.join('')).not.toContain('p10');
  });

  it('DB hỏng lúc ghi → exit 1, KHÔNG in báo cáo (kết quả phải truy vết được)', async () => {
    settings.forceMode = 'van_hanh';
    const s = io();
    expect(await ps.personaSimMain({ dryRun: true }, { io: s.io, connect: noConnect })).toBe(1);
    expect(s.err[0]).toMatch(/^\[err\] ghi sim_runs lỗi/);
    expect(s.out).toEqual([]);
  });

  it('phản hồi vi phạm guardrail / không phải JSON / ngoài 0..10 → điểm null', async () => {
    const CFGd = structuredClone(CFG);
    const PERS = ps.readJsonDoc(ps.PERSONAS_FILE)[0] as Obj;
    const ids = (CFGd.options as Obj[]).map((o) => o.id as string);
    const good = JSON.stringify(
      Object.fromEntries(ids.map((i) => [i, i === 'doi-chung-yeu' ? 1 : 7])),
    );
    let i = 0;
    const chat: ps.ChatFn = (model) => {
      i++;
      if (i === 1) return [`${good} sản phẩm này là thuốc`, model];
      if (i === 2) return ['{không phải json', model];
      if (i === 3) return [JSON.stringify({ [ids[0] as string]: 11 }), model];
      return [good, model];
    };
    const [rows, calls] = await ps.runMatrix(CFGd, PERS, CFGd.options as Obj[], chat, '2026-10-12');
    const by = new Map<string, ps.SimRow[]>();
    for (const r of rows) {
      const k = `${r.model}|${r.prompt_id}|${r.sample_idx}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    const [first, second, third] = [...by.values()] as ps.SimRow[][];
    expect(first?.every((r) => !r.guardrail_ok && r.score === null && r.parse_ok)).toBe(true);
    expect(second?.every((r) => !r.parse_ok && r.score === null && r.guardrail_ok)).toBe(true);
    expect(third?.every((r) => !r.parse_ok)).toBe(true);
    const s = ps.summarize(rows);
    expect(s.n_valid_calls).toBe(calls - 3);
    const text = ps.report(s, { runId: 't', personaSet: 'v1', personaSetHash: 'h', dryRun: false });
    expect(text).toContain('7.0 – 7.0');
    expect(text).toContain('KHÔNG phải dự báo doanh số');
  });
});

// ---------------------------------------------------------------- cách ly

describe('cách ly (không đường sang nội dung/kênh gửi)', () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const FORBIDDEN =
    /content_drafts|ops\/store'.*saveDraft|saveDraft|connectors|nodemailer|smtp|fetch\(|https?\.request/i;
  const WRITE = /(?:insert into|update|delete from) +([a-z_]+)/gi;

  it('intel-alert/intel-bulletin/legal-updates: 0 câu ghi trực tiếp, không mạng/kênh gửi', () => {
    for (const f of ['./intel-alert.ts', './intel-bulletin.ts', './legal-updates.ts']) {
      const s = src(f);
      expect(s, f).not.toMatch(FORBIDDEN);
      expect(
        [...s.matchAll(WRITE)].map((m) => m[1]),
        f,
      ).toEqual([]);
    }
    expect(src('./intel-alert.ts')).toContain('redAlertAck(');
    expect(src('./intel-bulletin.ts')).toContain('directorSubmit(');
    expect(src('./legal-updates.ts')).toContain('directorSubmit(');
  });

  it('persona-sim: chỉ ghi sim_runs; lời gọi thật chỉ qua AI Gateway', () => {
    const s = src('./persona-sim.ts');
    expect(s).not.toMatch(FORBIDDEN);
    expect([...s.matchAll(WRITE)].map((m) => m[1])).toEqual(['sim_runs']);
    expect(s).toContain('ai.chat(AGENT_ID');
  });

  it('mutant chèn content_drafts bị bắt', () => {
    const m = `${src('./intel-bulletin.ts')}\nconst X = "insert into content_drafts (text) values (1)";`;
    expect(m).toMatch(FORBIDDEN);
    expect([...m.matchAll(WRITE)].map((x) => x[1])).toEqual(['content_drafts']);
  });
});
