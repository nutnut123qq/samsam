import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { maskPii } from '@samsam/core/security/pii';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import DA from './__fixtures__/da_pmo.golden.json' with { type: 'json' };
import HB from './__fixtures__/health_bulletin.golden.json' with { type: 'json' };
import OI from './__fixtures__/ops_incidents.golden.json' with { type: 'json' };
import OM from './__fixtures__/ops_monthly.golden.json' with { type: 'json' };
import * as pmo from './da-pmo.js';
import * as hb from './health-bulletin.js';
import * as oi from './ops-incidents.js';
import * as om from './ops-monthly.js';

// Golden sinh bằng hàm Python THẬT (scratchpad pmo_ops/gen_golden.py) trên đầu vào cố định: bảng tuần
// da_pmo, bộ nạp mốc, payload đổi hạn; SLA sổ sự cố; KPI/tháng/tài sản/convlog/render báo cáo vận hành
// tháng; bản tin sức khỏe (chi phí/job trễ/render/hạn lưu). TS phải ra Y HỆT.
//
// KHÁC Python có chủ đích (TS chặt hơn = fail-closed):
const TS_STRICTER: Record<string, string> = {
  // JSON.parse từ chối NaN/Infinity (Python json.loads nhận) → lỗi đọc file thay vì lỗi cấu trúc.
  '[1, NaN]': 'JSONDecodeError (Python đọc được list rồi trượt TypeError/AttributeError/thiếu muc)',
};

type J = unknown;
/** {"$dt": iso} → Date; {"$d": iso} → 'YYYY-MM-DD'; {"$t": [...]} → mảng. */
function rev(v: J): J {
  if (Array.isArray(v)) return v.map(rev);
  if (v && typeof v === 'object') {
    const o = v as Record<string, J>;
    const ks = Object.keys(o);
    if (ks.length === 1 && ks[0] === '$dt') return new Date(o.$dt as string);
    if (ks.length === 1 && ks[0] === '$d') return o.$d;
    if (ks.length === 1 && ks[0] === '$t') return (o.$t as J[]).map(rev);
    return Object.fromEntries(ks.map((k) => [k, rev(o[k])]));
  }
  return v;
}

let tmp: string;
let n = 0;
/** Tệp tạm trong thư mục riêng (tên tệp giữ nguyên — thông điệp lỗi chứa tên). */
const file = (name: string, body: string | Buffer) => {
  const d = join(tmp, String(n++));
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, body);
  return p;
};
const writeDir = (d: string) => mkdirSync(d, { recursive: true });

const res = <T>(fn: () => T): { ok: J } | { msg: string } => {
  try {
    return { ok: fn() as J };
  } catch (e) {
    return { msg: (e as Error).message };
  }
};
const golden = (r: Record<string, J>) =>
  'error' in r ? { msg: r.msg as string } : { ok: rev(r.ok) };

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pmo-golden-'));
  installFakeDeps({ maskPii });
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetOpsDeps();
});

// =============================================================== da_pmo
describe('da_pmo golden', () => {
  const real = pmo.loadMilestones();
  const und = pmo.loadUndated();

  it('nạp mốc thật + mốc chưa có ngày khớp Python', () => {
    expect(real).toEqual(rev(DA.milestones));
    expect(und).toEqual(DA.undated);
  });

  it('bảng tuần (TRỄ, nhắc T-7/T-2, PII che, | thoát, mốc chưa có ngày) khớp Python', () => {
    const extra = rev(DA.extra) as pmo.BoardRow[];
    expect(DA.boards.length).toBeGreaterThan(20);
    for (const b of DA.boards) {
      const rows: pmo.BoardRow[] = real.map((m) => ({
        code: m.code,
        title: m.title,
        wp: m.wp ?? null,
        owner_role: m.owner_role,
        due_date: m.due_date,
        gate: m.gate,
        evidence: (b.evidence as Record<string, string>)[m.code] ?? null,
        status: (b.status as Record<string, string>)[m.code] ?? 'chua_bat_dau',
      }));
      const all = b.extra ? [...rows, ...extra] : rows;
      expect(pmo.renderBoard(all, b.today, b.undated ? und : []), b.today).toBe(b.md);
    }
  });

  it('bộ nạp từ chối file sai (thông điệp như Python)', () => {
    for (const c of DA.bad_milestones) {
      const p = file('m.json', JSON.stringify(c.doc));
      expect(
        res(() => pmo.loadMilestones(p)),
        JSON.stringify(c.doc),
      ).toEqual(golden(c.res as Record<string, J>));
    }
    for (const c of DA.bad_undated) {
      const p = file('m.json', JSON.stringify(c.doc));
      expect(
        res(() => pmo.loadUndated(p)),
        JSON.stringify(c.doc),
      ).toEqual(golden(c.res as Record<string, J>));
    }
    for (const [cases, fn] of [
      [DA.raw_milestones, pmo.loadMilestones],
      [DA.raw_undated, pmo.loadUndated],
    ] as const) {
      for (const c of cases) {
        const p = file('m.json', Buffer.from(c.raw, 'latin1'));
        const got = res(() => fn(p));
        if (TS_STRICTER[c.raw]) {
          expect(got).toEqual({ msg: 'm.json: không đọc được (JSONDecodeError)' });
          continue;
        }
        expect(got, c.raw).toEqual(golden(c.res as Record<string, J>));
      }
    }
  });

  it('payload đổi hạn + mã tuần ISO', () => {
    for (const p of DA.payloads) {
      const [code, a, b, by] = p.args as [string, string, string, string];
      const s = pmo.changePayload(code, a, b, by);
      expect(s).toBe(p.p);
      const m = pmo.PAYLOAD_RE.exec(s);
      expect(m?.groups).toEqual({ c: code, old: a, new: b, by });
    }
    for (const [d, w] of Object.entries(DA.week_ids)) expect(pmo.weekId(d)).toBe(w);
  });
});

// =============================================================== ops_incidents
describe('ops_incidents golden', () => {
  it('parse_ts: ISO 8601, naive = giờ VN, sai → IncidentError', () => {
    for (const c of OI.parse) {
      expect(
        res(() => oi.parseTs(c.in, '--at')),
        c.in,
      ).toEqual(golden(c.res as Record<string, J>));
    }
  });

  it('evaluate/summarize: phát hiện 15 phút, phản hồi 3 giờ / 3 ngày làm việc, sửa 7 ngày', () => {
    const incs = rev(
      OI.incidents.map((r) => [
        ...r.slice(0, 5),
        r[5] === null ? null : { $dt: r[5] },
        { $dt: r[6] },
      ]),
    ) as oi.IncidentRow[];
    const evs = rev(OI.events.map((r) => [r[0], r[1], { $dt: r[2] }])) as oi.EventRow[];
    for (const e of OI.evals) {
      const rows = oi.evaluate(incs, evs, OI.shift, new Date(e.now));
      expect(rows, e.now).toEqual(rev(e.rows));
      for (const [k, v] of Object.entries(e.sum)) {
        const [key, sev] = k.split('|') as ['detect' | 'respond' | 'fix', string];
        expect(oi.summarize(rows, key, sev === 'None' ? null : sev), k).toEqual(v);
      }
    }
  });

  it('_text (che PII, cắt) và --by (người thật, che PII)', () => {
    for (const c of OI.texts) {
      expect(res(() => oi.cleanText(c.in, '--title', c.n, false))).toEqual(
        golden(c.res as Record<string, J>),
      );
    }
    for (const c of OI.bys) {
      expect(
        res(() => oi.checkBy(c.in)),
        String(c.in),
      ).toEqual(golden(c.res as Record<string, J>));
    }
  });
});

// =============================================================== ops_monthly
describe('ops_monthly golden', () => {
  const assets = om.loadAssets();

  it('render báo cáo vận hành tháng khớp Python (mọi nhánh nguồn/thiếu nguồn)', () => {
    for (const [k, r] of Object.entries(OM.renders)) {
      const f = { ...(rev(r.facts) as Record<string, J>), assets } as unknown as om.Facts;
      expect(om.render(f), k).toBe(r.md);
    }
  });

  it('KPI CSKH/báo động đỏ/p95/backup/diễn tập', () => {
    for (const c of OM.kpis.cskh) {
      const cc = rev(c.case) as { qs: om.Question[]; dec: om.CskhRow[]; now: Date };
      expect(
        om.kpiCskh(
          cc.qs,
          cc.dec,
          { start: '08:00', end: '18:00', workdays: [0, 1, 2, 3, 4] },
          cc.now,
        ),
      ).toEqual(c.res);
    }
    const t = new Date('2026-10-10T22:00:00+07:00');
    const now = new Date('2026-10-11T01:00:00+07:00');
    const h = 3600_000;
    const rows: om.AlertRow[] = [
      [1, t, new Date(t.getTime() + 2 * h)],
      [2, t, new Date(t.getTime() + 2 * h + 1000)],
      [3, new Date(t.getTime() - 5 * h), null],
      [4, new Date(now.getTime() - 30 * 60_000), null],
      [5, new Date(now.getTime() - 2 * h), null],
    ];
    expect(om.kpiAlerts(rows, now)).toEqual(OM.kpis.alerts);
    for (const [k, v] of Object.entries(OM.p95)) expect(om.p95(JSON.parse(k)), k).toBe(v);
    for (const c of OM.backup) {
      const x = rev(c) as { s: Date; e: Date; now: Date; runs: om.Run[]; res: unknown };
      expect(om.backupDays(x.runs, x.s, x.e, x.now)).toEqual(x.res);
    }
    for (const c of OM.drill) {
      const x = rev(c) as { s: Date; e: Date; now: Date; runs: om.Run[]; res: unknown };
      expect(om.drillStatus(x.runs, x.s, x.e, x.now), JSON.stringify(c.now)).toEqual(x.res);
    }
  });

  it('month_bounds (\\d Unicode, strip, tương lai) + danh mục tài sản', () => {
    for (const c of OM.month_bounds) {
      const r = rev(c) as { m: string | null; now: Date; res: Record<string, J> };
      expect(
        res(() => om.monthBounds(r.m, r.now)),
        String(c.m),
      ).toEqual('error' in r.res ? { msg: r.res.msg } : { ok: r.res.ok });
    }
    for (const c of OM.assets) {
      const got =
        c.doc === '__real__'
          ? res(() => om.loadAssets())
          : res(() => om.loadAssets(file('a.json', JSON.stringify(c.doc))));
      expect(got, JSON.stringify(c.doc)).toEqual(golden(c.res as Record<string, J>));
    }
    for (const c of OM.assets_raw) {
      const got = res(() => om.loadAssets(file('m.json', Buffer.from(c.raw, 'latin1'))));
      if (TS_STRICTER[c.raw]) continue; // không có ca NaN ở đây — giữ khuôn
      expect(got, c.raw).toEqual(golden(c.res as Record<string, J>));
    }
  });

  it('convlog → dữ kiện KPI không PII (live, dedup, sha) + gộp sổ chat_kpi_live', () => {
    const d = join(tmp, 'conv');
    writeDir(d);
    const lines = (recs: J[]) =>
      `${recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
    writeFileSync(join(d, 'conversations.jsonl'), lines(OM.conv_input));
    writeFileSync(join(d, 'conversations.jsonl.1'), lines(OM.conv1_input));
    const start = new Date('2026-10-01T00:00:00+07:00');
    const end = new Date('2026-11-01T00:00:00+07:00');
    const conv = om.readConvlog(d, start, end);
    const { facts, ...read } = conv;
    expect(read).toEqual(rev(OM.conv.read));
    const byKey = (a: om.Fact, b: om.Fact) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    expect([...(facts ?? new Map()).values()].sort(byKey)).toEqual(rev(OM.conv.facts));
    const all = rev(OM.conv.all_facts) as om.Fact[];
    for (const f of all)
      expect(om.factSha(f), f[0]).toBe((OM.conv.shas as Record<string, string>)[f[0]]);
    const strip = (c: om.Conv) => {
      const { facts: _f, ...rest } = c;
      return rest;
    };
    expect(strip(om.mergeChat(conv, rev(OM.conv.db_facts)))).toEqual(rev(OM.conv.merged));
    expect(strip(om.mergeChat(conv, []))).toEqual(rev(OM.conv.merged_empty));
    expect(strip(om.mergeChat(conv, 'missing'))).toEqual(rev(OM.conv.merged_missing));
  });

  it('nhật ký backup: chỉ mốc CÓ múi giờ, dòng hỏng/không phải chuỗi bỏ qua', () => {
    const d = join(tmp, 'runs');
    writeDir(d);
    writeFileSync(
      join(d, 'backup_runs.jsonl'),
      `${OM.runs_input.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`,
    );
    expect(om.readRuns(d, 'backup_runs.jsonl')).toEqual(rev(OM.runs));
    expect(om.readRuns(null, 'backup_runs.jsonl')).toBeNull();
    expect(om.readRuns(d, 'khong_co.jsonl')).toBeNull();
  });

  it('dòng "gửi Bên B trước ngày 05" (xác nhận người gửi; thiếu/lỗi → không chấm)', () => {
    const start = new Date('2026-11-01T00:00:00+07:00');
    for (const c of OM.sent.rows) {
      expect(om.sentRow(rev(c.sent), start), JSON.stringify(c.sent)).toEqual(c.res);
    }
  });
});

// =============================================================== health_bulletin
describe('health_bulletin golden', () => {
  it('chi phí (ngưỡng 80%/100%, cap 0, default) + job trễ', () => {
    for (const c of HB.cost) {
      expect(
        hb.costRows(
          c.spend as unknown as Record<string, number>,
          c.caps as unknown as Record<string, number>,
        ),
      ).toEqual(c.rows);
    }
    for (const c of HB.late) {
      expect(
        hb.lateJobs(
          c.h as unknown as Record<string, number>,
          c.exp as unknown as Record<string, number>,
        ),
      ).toEqual(c.res);
    }
    expect(hb.expectedJobs()).toEqual(HB.expected_jobs);
  });

  it('render 6 mục khớp Python (DB chết / thiếu bảng / lỗi trần / không có job)', () => {
    const now = new Date('2026-10-11T07:30:00Z');
    const data = rev(HB.data) as hb.Data;
    const R = HB.renders;
    const caps = HB.caps as Record<string, number>;
    const ret = HB.retention_real;
    expect(hb.render(data, '2026-10-11', { caps, retention: ret, now })).toBe(R.full);
    expect(
      hb.render(
        {
          ...data,
          jobs: 'missing',
          pending: { error: 'InsufficientPrivilege' },
          llm_errors: { error: 'X' },
        },
        '2026-10-11',
        { caps, retention: ['- r'], now },
      ),
    ).toBe(R.states);
    expect(
      hb.render(data, '2026-10-11', { caps: null, capError: 'GatewayError', retention: [], now }),
    ).toBe(R.cap_error);
    expect(
      hb.render({ db_ok: false, db_error: 'OperationalError' }, '2026-10-11', {
        caps,
        retention: ret,
        now,
      }),
    ).toBe(R.down);
    expect(
      hb.render(
        {
          ...data,
          jobs: { counts: [], failed: [], last_ok_hours: {} },
          spend: 'missing',
          llm_errors: [],
        },
        '2026-01-02',
        { caps, retention: ret, now },
      ),
    ).toBe(R.no_jobs);
  });

  it('hạn lưu dữ liệu cá nhân: TTL null = CẢNH BÁO; cấu hình hỏng = LỖI (job không xóa)', () => {
    expect(hb.retentionLines()).toEqual(HB.retention_real);
    for (const c of HB.retention) {
      // `text` = chữ JSON Python ghi (giữ `1.0` là float).
      const raw = 'raw' in c ? Buffer.from(c.raw as string, 'latin1') : (c.text as string);
      const got = hb.retentionLines(file('retention.json', raw));
      if ('raw' in c && TS_STRICTER[c.raw as string]) {
        expect(got).toEqual([
          '- LỖI cấu hình hạn lưu (không đọc được retention.json (JSONDecodeError)) — job xóa không chạy',
        ]);
        continue;
      }
      expect(got, JSON.stringify(c.doc ?? c.raw)).toEqual(c.lines);
    }
  });
});
