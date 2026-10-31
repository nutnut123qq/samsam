import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/counters';
import { check } from '@samsam/core/security/guardrail';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pmo from './da-pmo.js';

// Dịch phần thuần + CLI không DB của tests/test_da_pmo.py (render_board, mốc thật, tham số sai exit 2
// TRƯỚC connect, `xong` thiếu evidence exit 1, DB down exit 2, không có đường gửi) + cổng TẮT của
// bảng tuần (r12 RB) trước mọi đọc/ghi.

const REAL = pmo.loadMilestones();

function rows(status: Record<string, string> = {}): pmo.BoardRow[] {
  return REAL.map((m) => ({
    code: m.code,
    title: m.title,
    wp: m.wp,
    owner_role: m.owner_role,
    due_date: m.due_date,
    gate: m.gate,
    status: status[m.code] ?? 'chua_bat_dau',
    evidence: status[m.code] === 'xong' ? 'bb-01' : null,
  }));
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const noConnect = async () => {
  throw new Error('connect'); // tham số sai phải exit TRƯỚC connect
};

describe('da_pmo — thuần', () => {
  it('file mốc thật: mốc HĐ đúng ngày, không còn mốc phòng Dự án, BẢN DEV SOẠN', () => {
    const by = Object.fromEntries(REAL.map((m) => [m.code, m.due_date]));
    expect(REAL.length).toBeGreaterThanOrEqual(6);
    for (const c of ['DA-00', 'DA-02', 'DA-03', 'DA-04', 'DA-QA']) expect(by[c]).toBeUndefined();
    expect({
      'DA-01': by['DA-01'],
      'KD-A3-FORM': by['KD-A3-FORM'],
      'DA-05': by['DA-05'],
      'MOC-C': by['MOC-C'],
      'MOC-D': by['MOC-D'],
      TT3: by.TT3,
    }).toEqual({
      'DA-01': '2026-10-24',
      'KD-A3-FORM': '2026-11-16',
      'DA-05': '2026-11-21',
      'MOC-C': '2026-11-30',
      'MOC-D': '2026-12-18',
      TT3: '2026-12-23',
    });
    for (const m of REAL) {
      expect(m.title && m.wp && m.gate, m.code).toBeTruthy();
      expect(m.owner_role, m.code).toMatch(/^[a-z_]+$/);
      expect(m.owner_role).not.toBe('gd_du_an');
    }
    const doc = JSON.parse(readFileSync(pmo.MILESTONES_FILE, 'utf8'));
    expect(doc._doc).toContain('BẢN DEV SOẠN');
    expect(doc._doc).toContain('CHỜ TGĐ chốt');
  });

  it('bảng tuần: TRỄ + mốc trễ, hạn dd/mm/yyyy, BẢN NHÁP', () => {
    const md = pmo.renderBoard(rows({ 'DA-05': 'xong' }), '2026-10-25');
    const late = md.split('## Mốc trễ')[1]?.split('## Nhắc')[0] ?? '';
    expect(late).toMatch(/\*\*TRỄ\*\* DA-01 — hạn 24\/10\/2026/);
    expect(late).not.toContain('DA-05');
    expect(late).not.toContain('KD-A3-FORM');
    const da05 = md.split('\n').find((l) => l.startsWith('| DA-05 |')) ?? '';
    expect(da05).not.toContain('TRỄ');
    expect(da05).toContain('bb-01');
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(md).toContain('tuần 2026-W43');
    expect(md).toContain('chưa có');
    expect(md).toContain('BẢN NHÁP');
  });

  it('nhắc T-7/T-2 ĐÚNG ngày (không nhắc lại hôm sau, mốc xong không nhắc)', () => {
    const rem = (md: string) => md.split('## Nhắc hạn hôm nay')[1] ?? '';
    expect(rem(pmo.renderBoard(rows(), '2026-11-09'))).toContain(
      'T-7: KD-A3-FORM — hạn 16/11/2026',
    );
    expect(rem(pmo.renderBoard(rows(), '2026-11-10'))).not.toContain('KD-A3-FORM');
    expect(rem(pmo.renderBoard(rows({ 'DA-05': 'xong' }), '2026-11-19'))).not.toContain('DA-05');
    expect(rem(pmo.renderBoard(rows(), '2026-11-19'))).toContain('T-2: DA-05 — hạn 21/11/2026');
  });

  it('bảng tuần từ mốc THẬT qua guardrail THẬT mọi ngày (decide kiểm lại — trượt thì không duyệt được)', () => {
    for (const m of REAL) {
      for (const k of ['title', 'gate'] as const) {
        expect(check(m[k]).ok, `${m.code}.${k}`).toBe(true);
      }
    }
    for (let t = Date.UTC(2026, 9, 1); t <= Date.UTC(2027, 0, 10); t += 3 * 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      for (const st of [{}, { 'DA-05': 'xong', 'MOC-C': 'xong' }] as Record<string, string>[]) {
        expect(check(pmo.renderBoard(rows(st), day)).ok, day).toBe(true);
      }
    }
  });

  it('payload đổi hạn tất định ↔ regex (cả DB tách lại)', () => {
    const p = pmo.changePayload('DA-05', '2026-11-21', '2026-11-28', 'TGĐ MẪU');
    const m = pmo.PAYLOAD_RE.exec(p);
    expect(m?.groups?.c).toBe('DA-05');
    expect(m?.groups?.new).toBe('2026-11-28');
    expect(pmo.PAYLOAD_RE.exec(p.replace('code: DA-05', 'code: DA-06'))).toBeNull();
  });

  it('không có đường gửi/mạng/LLM trong mã nguồn', () => {
    const src = readFileSync(new URL('./da-pmo.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/nodemailer|smtp|fetch\(|node:https?|node:net|AiGateway|\.chat\(/i);
  });
});

describe('da_pmo — CLI không DB', () => {
  beforeEach(() => {
    installFakeDeps();
  });
  afterEach(() => {
    resetOpsDeps();
    settings.forceMode = null;
  });

  it.each<[string, pmo.DaPmoOpts]>([
    ['--seed --board', { seed: true, board: true }],
    ['không thao tác', {}],
    ['--set-status thiếu --by', { setStatus: 'DA-05', status: 'xong' }],
    ['--set-status thiếu --status', { setStatus: 'DA-05', by: 'X' }],
    ['--board --dry-run', { board: true, dryRun: true }],
    ['--seed --submit', { seed: true, submit: true }],
    ['--propose-due thiếu --due', { proposeDue: 'DA-05', by: 'X' }],
    ['--due sai dạng', { proposeDue: 'DA-05', due: '21/11/2026', by: 'X' }],
    ['--apply-due thiếu --by', { applyDue: '1' }],
    ['--evidence không có --set-status', { board: true, evidence: 'x' }],
    ['--status lạ', { setStatus: 'DA-05', status: 'la', by: 'X' }],
    ['--apply-due không phải số', { applyDue: 'abc', by: 'X' }],
    ['--date sai', { board: true, date: '2026-13-01' }],
  ])('%s → exit 2 TRƯỚC connect', async (_n, o) => {
    const s = io();
    expect(await pmo.daPmoMain(o, { io: s.io, connect: noConnect })).toBe(2);
    expect(s.err.join('\n')).toContain('da_pmo: error:');
  });

  it("status 'xong' thiếu evidence → exit 1 TRƯỚC connect", async () => {
    for (const ev of [undefined, '  ']) {
      const s = io();
      expect(
        await pmo.daPmoMain(
          { setStatus: 'DA-05', status: 'xong', by: 'X', evidence: ev },
          { io: s.io, connect: noConnect },
        ),
      ).toBe(1);
      expect(s.err[0]).toContain("status 'xong' cần --evidence");
    }
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(
      await pmo.daPmoMain({ seed: true, dryRun: true }, { io: s.io, connect: async () => null }),
    ).toBe(2);
    expect(s.err[0]).toContain('không kết nối được Postgres');
  });

  it('file mốc hỏng → --seed exit 1 TRƯỚC connect', async () => {
    const s = io();
    expect(
      await pmo.daPmoMain(
        { seed: true },
        { io: s.io, connect: noConnect, milestonesFile: join(tmpdir(), 'khong-co-moc.json') },
      ),
    ).toBe(1);
    expect(s.err[0]).toBe('[error] khong-co-moc.json: không đọc được (FileNotFoundError)');
  });

  it('ceo-02.1 TẮT → --board `[rollout]` exit 2 TRƯỚC mọi đọc DB/ghi file/đẩy hàng duyệt', async () => {
    settings.forceMode = 'tat';
    const out = mkdtempSync(join(tmpdir(), 'pmo-board-'));
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        throw new Error('không được đọc DB');
      },
    };
    const jobs: [string, boolean][] = [];
    const s = io();
    try {
      const rc = await pmo.daPmoMain(
        { board: true, submit: true, date: '2026-10-25', outDir: out },
        {
          io: s.io,
          wire: () => {},
          connect: async () => ({ db: db as never, release: async () => {} }),
          jobRun: (async (name: string, body: (r: { ok: boolean; detail: null }) => unknown) => {
            const r = { ok: true, detail: null };
            const v = await body(r);
            jobs.push([name, r.ok]);
            return v;
          }) as never,
        },
      );
      expect(rc).toBe(2);
      expect(s.out.join('\n')).toMatch(
        /^\[rollout\] bảng tiến độ tuần: tính năng ceo-02\.1 đang tắt/,
      );
      expect(queries).toEqual([]);
      expect(existsSync(join(out, 'da-pmo-board-2026-10-25.md'))).toBe(false);
      expect(jobs).toEqual([['agents.da_pmo', false]]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
