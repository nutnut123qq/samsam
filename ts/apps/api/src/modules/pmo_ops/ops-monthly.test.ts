import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { type FakeState, installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/counters';
import { maskPii } from '@samsam/core/security/pii';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as om from './ops-monthly.js';

// Dịch phần không DB của tests/test_ops_monthly.py + test_v13_c07_ops.py (báo cáo vận hành tháng):
// tham số/cấu hình sai exit 2 TRƯỚC connect, không ghi file; DB down vẫn ghi báo cáo "chưa có dữ liệu"
// exit 1 và KHÔNG đếm là đầu ra thật (P8.4); đọc BACKUP_DIR; `--month prev`; `--mark-sent` chỉ NGƯỜI
// gửi + đúng tên file + tháng đã đóng; sổ sự cố trống không phải bằng chứng "đạt"; quảng cáo/KOC
// luôn ghi "chưa có dữ liệu". KHÁC Python có chủ đích: data_platform-08 TẮT → `[rollout]` exit 2
// TRƯỚC connect/đọc nguồn (Python đọc DB rồi traceback ở write_report).

const vn = (s: string) => new Date(`${s}+07:00`);
const SHIFT = { start: '00:00', end: '23:59', workdays: [0, 1, 2, 3, 4], holidays: [] };

let tmp: string;
let fake: FakeState;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ops-monthly-'));
  fake = installFakeDeps({ maskPii });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetOpsDeps();
  settings.forceMode = null;
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const noConnect = async () => {
  throw new Error('connect');
};
// Nguồn ngoài DB cố định (không đọc git/cấu hình thật của máy).
const fixed = {
  salesShift: () => ({ start: '08:00', end: '18:00', workdays: [0, 1, 2, 3, 4], holidays: [] }),
  workdays: () => SHIFT,
  holidayWarning: () => null,
  repoFacts: () => ({ head: null, modules: 1, tests: 1, handover: [] }),
};

describe('ops_monthly — main', () => {
  it('tháng sai/tương lai/danh mục tài sản hỏng → [usage] exit 2, KHÔNG connect, KHÔNG ghi file', async () => {
    const s = io();
    const now = () => vn('2026-10-15T00:00:00');
    const d = { io: s.io, now, connect: noConnect, dataDir: tmp, backupDir: null, ...fixed };
    expect(await om.opsMonthlyMain({ month: '2026-13', outDir: tmp }, d)).toBe(2);
    expect(await om.opsMonthlyMain({ month: '2026-11', outDir: tmp }, d)).toBe(2);
    const bad = join(tmp, 'a.json');
    writeFileSync(bad, '{}');
    expect(
      await om.opsMonthlyMain({ month: '2026-10', outDir: tmp }, { ...d, assetsFile: bad }),
    ).toBe(2);
    expect(readdirSync(tmp).filter((f) => f.startsWith('van-hanh-'))).toEqual([]);
    expect(s.out.filter((l) => l.startsWith('[usage]')).length).toBe(3);
    expect(await om.opsMonthlyMain({ month: '0000-10', outDir: tmp }, d)).toBe(2); // TS: năm 0 → usage
    expect(await om.opsMonthlyMain({}, d)).toBe(2);
    expect(await om.opsMonthlyMain({ month: '2026-10', snapshot: true }, d)).toBe(2);
  });

  it('DB down → vẫn ghi báo cáo (LF), exit 1, sổ đầu ra đánh dấu MẪU (không đếm)', async () => {
    const s = io();
    const rc = await om.opsMonthlyMain(
      { month: '2026-10', outDir: tmp },
      {
        io: s.io,
        now: () => vn('2026-11-02T00:00:00'),
        connect: async () => null,
        dataDir: tmp,
        backupDir: null,
        ...fixed,
      },
    );
    expect(rc).toBe(1);
    const md = readFileSync(join(tmp, 'van-hanh-2026-10.md'), 'utf8');
    expect(md).toContain('DB không truy cập được');
    expect(md).not.toContain('\r\n');
    expect(s.out.at(-1)).toBe("[err] DB không truy cập được — mục DB ghi 'chưa có dữ liệu'");
    expect(fake.recorded.map((r) => [r.name, r.sample])).toEqual([['van-hanh-2026-10.md', true]]);
  });

  it('đọc nhật ký BACKUP_DIR (backup + diễn tập)', async () => {
    const bdir = join(tmp, 'bk');
    mkdirSync(bdir);
    const lines = (recs: object[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
    writeFileSync(
      join(bdir, 'backup_runs.jsonl'),
      lines(
        Array.from({ length: 31 }, (_, i) => ({
          ts: `2026-10-${String(i + 1).padStart(2, '0')}T01:30:00+07:00`,
          status: 'ok',
          offsite: 'dir',
        })),
      ),
    );
    writeFileSync(
      join(bdir, 'drill_runs.jsonl'),
      lines([{ ts: '2026-10-11T03:00:00+07:00', status: 'ok' }]),
    );
    await om.opsMonthlyMain(
      { month: '2026-10', outDir: tmp },
      {
        io: io().io,
        now: () => vn('2026-11-02T00:00:00'),
        connect: async () => null,
        dataDir: tmp,
        ...fixed,
        backupDir: bdir,
      },
    );
    const md = readFileSync(join(tmp, 'van-hanh-2026-10.md'), 'utf8');
    expect(md).toContain('31/31 ngày (100.0%); có bản sao ngoài 31 ngày');
    expect(md).toContain('Diễn tập 11/10/2026: ok.');
  });

  it('BACKUP_DIR: thiếu → null; ~ → thư mục nhà', () => {
    expect(om.backupDir({})).toBeNull();
    expect(om.backupDir({ BACKUP_DIR: '' })).toBeNull();
    expect(om.backupDir({ BACKUP_DIR: '~/bk' })).toBe(`${homedir()}/bk`);
    expect(om.backupDir({ BACKUP_DIR: '/srv/bk' })).toBe('/srv/bk');
  });

  it('--month prev (job ngày 1) = tháng trước theo giờ VN', async () => {
    const rc = await om.opsMonthlyMain(
      { month: 'prev', outDir: tmp },
      {
        io: io().io,
        now: () => vn('2026-11-01T08:00:00'),
        connect: async () => null,
        dataDir: tmp,
        backupDir: null,
        ...fixed,
      },
    );
    expect(rc).toBe(1);
    expect(existsSync(join(tmp, 'van-hanh-2026-10.md'))).toBe(true);
  });

  it('data_platform-08 TẮT → [rollout] exit 2 TRƯỚC connect/đọc nguồn/ghi (TS chặt hơn Python)', async () => {
    settings.forceMode = 'tat';
    const s = io();
    let read = false;
    const rc = await om.opsMonthlyMain(
      { month: '2026-10', outDir: tmp },
      {
        io: s.io,
        now: () => vn('2026-11-02T00:00:00'),
        connect: noConnect,
        dataDir: tmp,
        backupDir: null,
        ...fixed,
        repoFacts: () => {
          read = true;
          return fixed.repoFacts();
        },
      },
    );
    expect(rc).toBe(2);
    expect(s.out[0]).toMatch(
      /^\[rollout\] báo cáo van-hanh-2026-10\.md: tính năng data_platform-08 đang tắt/,
    );
    expect(read).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe('ops_monthly — dữ kiện kho mã nguồn', () => {
  it('commit HEAD + số module Python + số file test + tài liệu bàn giao; kho không có → HEAD null', () => {
    const f = om.repoFacts();
    expect(f.modules).toBeGreaterThan(50);
    expect(f.tests).toBeGreaterThan(50);
    expect(f.handover).toContain('runbook-ha-tang.md');
    expect(f.head === null || f.head.length === 40).toBe(true);
    expect(om.repoFacts(join(tmp, 'khong_co_repo_nay')).head).toBeNull();
  });
});

describe('ops_monthly — --mark-sent / --snapshot', () => {
  it('chỉ NGƯỜI gửi, đúng tên file, tháng đã đóng — sai → [usage] exit 2 TRƯỚC connect', async () => {
    const f = join(tmp, 'van-hanh-2026-10.md');
    writeFileSync(f, 'báo cáo');
    const now = () => vn('2026-11-03T09:00:00');
    for (const o of [
      { markSent: '2026-10', file: f, by: 'agent:ops' },
      { markSent: '2026-10', file: f, by: '' },
      { markSent: '2026-10', file: join(tmp, 'x.md'), by: 'Người Gửi' },
      { markSent: '2026-10', file: join(tmp, 'van-hanh-2026-09.md'), by: 'Người Gửi' },
      { markSent: '2026-11', file: f, by: 'Người Gửi' }, // tháng chưa đóng
      { markSent: '10/2026', file: f, by: 'Người Gửi' },
    ]) {
      const s = io();
      expect(
        await om.opsMonthlyMain(o, { io: s.io, now, connect: noConnect }),
        JSON.stringify(o),
      ).toBe(2);
      expect(s.out[0]).toMatch(/^\[usage\] /);
    }
    const s = io();
    expect(
      await om.opsMonthlyMain(
        { markSent: '2026-10', file: f, by: 'Người Gửi' },
        { io: s.io, now, connect: async () => null },
      ),
    ).toBe(1);
    expect(s.out).toEqual(['[err] DB không truy cập được — chưa ghi xác nhận']);
  });

  it('--snapshot DB down → exit 1', async () => {
    const s = io();
    expect(
      await om.opsMonthlyMain(
        { snapshot: true },
        { io: s.io, connect: async () => null, dataDir: tmp },
      ),
    ).toBe(1);
    expect(s.out).toEqual(['[err] DB không truy cập được — chưa chụp KPI chat']);
  });
});

describe('ops_monthly — sổ sự cố + phạm vi rà', () => {
  it('sổ sự cố trống KHÔNG phải bằng chứng "đạt"; thiếu bảng → chưa có dữ liệu', () => {
    const [rows] = om.incidentRows({ incidents: [], events: [] }, SHIFT, vn('2026-11-02T00:00:00'));
    expect(rows.every((r) => r[2]?.includes('không phải bằng chứng'))).toBe(true);
    const [miss] = om.incidentRows(om.MISSING, SHIFT, vn('2026-11-02T00:00:00'));
    expect(miss.every((r) => r[2]?.includes(om.NO_DATA))).toBe(true);
  });

  it('quảng cáo trả phí/KOC/livestream luôn ghi "chưa có dữ liệu" — không coi là đạt', () => {
    const md = om.render({
      start: vn('2026-10-01T00:00:00'),
      end: vn('2026-11-01T00:00:00'),
      now: vn('2026-11-02T00:00:00'),
      assets: om.loadAssets(),
      repo: { head: null, modules: 1, tests: 1, handover: [] },
      conv: { exists: false, earliest: null, questions: [], latencies: [] },
      shift: SHIFT,
      backups: null,
      drills: null,
      db_ok: false,
    });
    expect(md).toContain('KOC/livestream');
    expect(md).toContain('KHÔNG được coi là đạt');
    expect(md).not.toContain('https://');
  });
});
