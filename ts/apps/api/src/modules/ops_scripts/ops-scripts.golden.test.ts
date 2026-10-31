import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyFixed } from '@samsam/core/ops/py-json';
import { REPO_ROOT } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/ops-scripts.golden.json' with { type: 'json' };
import { checkPassfile, loadManifest, MANIFEST_SUFFIX, readConfig } from './backup.js';
import { printable, whoWhy } from './break-glass.js';
import { fmtG, pgEnv, scrub } from './common.js';
import { positive, rpoSeconds } from './dr-drill.js';
import { capFor, loadQuota, type Quota, render, type Stats } from './review-load.js';

// Golden sinh bằng hàm Python THẬT (scripts/db_backup.py, dr_drill.py, review_load.py, break_glass.py,
// định dạng `:g`/`:.1f` của onprem_preflight) — `gen_golden.py` ở scratchpad, DSN chết. Mọi ca trong
// golden khớp y hệt (0 ngoại lệ). Khác biệt CÓ CHỦ ĐÍCH nằm ngoài golden, có test riêng:
//   - `.env` không được nạp (backup/dr/break-glass: chỉ env tiến trình) — backup.test.ts;
//   - JSON có NaN/Infinity bị coi là hỏng (Python nhận) — manifest/quota/sổ backup: chặt hơn;
//   - `which` không tìm exe trong thư mục hiện hành trên Windows — chặt hơn;
//   - preflight đo thêm login dịch vụ `ui` (UI_DATABASE_URL) — onprem-preflight.test.ts.

const tmp = mkdtempSync(join(tmpdir(), 'ops-golden-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('golden db_backup', () => {
  it('scrub che host/user/mật khẩu/DSN, gộp khoảng trắng, cắt 300', () => {
    for (const c of G.scrub) expect(scrub(c.msg, c.dsn), c.msg.slice(0, 40)).toBe(c.out);
  });

  it('pg_env tách DSN thành biến PG* (URL + key=value, query đè thành phần)', () => {
    for (const c of G.pg_env) {
      const env = pgEnv(c.dsn, c.db, { PATH: '/x', PGPASSWORD: 'cu', PG_BIN: '/pg' });
      const pg = Object.fromEntries(
        Object.entries(env).filter(([k]) => k.startsWith('PG') && k !== 'PG_BIN'),
      );
      expect(pg, c.dsn).toEqual(c.env);
      expect(env.PG_BIN).toBe('/pg'); // PG_BIN giữ lại, PG* thừa kế bị xóa
    }
  });

  it('check_passfile: dòng đầu trống/ngắn/NUL/BOM UTF-16 → UsageError', () => {
    for (const c of G.passfile) {
      const p = join(tmp, 'p.txt');
      writeFileSync(p, Buffer.from(c.hex, 'hex'));
      let err: string | null = null;
      try {
        checkPassfile(p);
      } catch (e) {
        err = (e as Error).message;
      }
      expect(err, c.hex).toBe(c.err);
    }
  });

  it('load_manifest: hợp lệ/không + thời điểm created_at', () => {
    for (const c of G.manifest) {
      const p = join(tmp, c.name);
      writeFileSync(p, 'hex' in c && c.hex ? Buffer.from(c.hex, 'hex') : (c.body as string));
      const m = loadManifest(p);
      expect(m !== null, c.id).toBe(c.valid);
      if (m && c.created_ms !== null) expect(m._created.getTime(), c.id).toBe(c.created_ms);
      rmSync(p);
    }
    expect(MANIFEST_SUFFIX).toBe('.manifest.json');
  });

  it('read_config: thông điệp usage + cảnh báo cùng thiết bị', () => {
    writeFileSync(join(tmp, 'pass.txt'), 'dung-passphrase-test-dai\n');
    for (const c of G.read_config) {
      const env = Object.fromEntries(
        Object.entries(c.env).map(([k, v]) => [k, (v as string).replaceAll('{T}', tmp)]),
      );
      const logs: string[] = [];
      let res: Record<string, unknown>;
      try {
        const cfg = readConfig(env, (s) => logs.push(s));
        res = {
          ok: true,
          keep: cfg.keep,
          passfile: cfg.passfile !== null,
          offsite: cfg.offsite === null ? null : cfg.offsite[0],
        };
      } catch (e) {
        res = { ok: false, err: (e as Error).message };
      }
      expect(res, c.id).toEqual(c.res);
      expect(logs.map((s) => `${s}\n`).join(''), c.id).toBe(c.out);
    }
  });
});

describe('golden dr_drill', () => {
  it('rpo_seconds làm tròn 2 số như Python round()', () => {
    for (const c of G.rpo) {
      expect(rpoSeconds({ created_at: c.created }, new Date(c.now_ms)), String(c.now_ms)).toBe(
        c.out,
      );
    }
  });

  it('_positive: số > 0 hữu hạn (Unicode digit, gạch dưới, inf/nan)', () => {
    for (const c of G.positive) {
      let res: Record<string, unknown>;
      try {
        res = { ok: positive(c.raw, '24', 'DR_RPO_MAX_HOURS') };
      } catch (e) {
        res = { err: (e as Error).message };
      }
      expect(res, String(c.raw)).toEqual(c.res);
    }
  });
});

const toQuota = (q: {
  status: string;
  phases: (string | number | null)[][];
  absent: string[];
}): Quota => ({
  status: q.status,
  phases: q.phases.map((p) => [p[0] as string, p[1] as string | null, p[2] as number] as const),
  absent: new Set(q.absent),
});

describe('golden review_load', () => {
  it('load_quota: lỗi/kết quả khớp Python', () => {
    for (const c of G.quota) {
      const p = join(tmp, 'q.json');
      writeFileSync(p, Buffer.from(c.hex, 'hex'));
      let res: Record<string, unknown>;
      try {
        const q = loadQuota(p);
        res = {
          status: q.status,
          phases: q.phases.map((x) => [...x]),
          absent: [...q.absent].sort(),
        };
      } catch (e) {
        res = { err: (e as Error).message };
      }
      expect(res, c.id).toEqual(c.res);
    }
  });

  it('cap_for theo phase của quota repo', () => {
    const q = loadQuota(join(REPO_ROOT, 'data', 'review_quota.json'));
    for (const c of G.cap_for) expect(capFor(c.day, q), c.day).toBe(c.cap);
  });

  it('render: báo cáo y hệt Python', () => {
    for (const c of G.render) {
      const s = c.stats;
      const stats: Stats = {
        today: '2026-10-12',
        days: s.days,
        start: new Date(Date.UTC(2026, 9, 12 - (s.days - 1))).toISOString().slice(0, 10),
        queue: s.queue,
        queue_total: s.queue_total,
        oldest_age_days: s.oldest_age_days,
        inflow: s.inflow as Record<string, number>,
        throughput: s.throughput as Record<string, Record<string, number>>,
      };
      expect(render(stats, toQuota(c.quota), '2026-10-12'), c.id).toBe(c.out);
    }
  });
});

describe('golden break_glass + định dạng số', () => {
  it('_who_why: --by/--reason + che PII lý do', () => {
    for (const c of G.who_why) {
      let res: Record<string, unknown>;
      try {
        res = { ok: whoWhy(c.by, c.reason) };
      } catch (e) {
        res = { err: (e as Error).message };
      }
      expect(res, String(c.by)).toEqual(c.res);
    }
  });

  it('_printable thay ký tự điều khiển bằng ?', () => {
    for (const c of G.printable) expect(printable(c.v), String(c.v)).toBe(c.out);
  });

  it(':g và :.1f (onprem_preflight/dr_drill)', () => {
    for (const c of G.fmt_g) {
      expect(fmtG(c.x), String(c.x)).toBe(c.g);
      expect(pyFixed(c.x, 1), String(c.x)).toBe(c.f1);
    }
  });
});
