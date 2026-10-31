import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked, GatewayError } from '@samsam/core/ai/gateway';
import type { Db } from '@samsam/core/ops/deps';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireSecurity } from '@samsam/core/ops/wire';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/ceo_report.golden.json' with { type: 'json' };
import CK from './__fixtures__/cockpit.golden.json' with { type: 'json' };
import MK from './__fixtures__/mkt_metrics.golden.json' with { type: 'json' };
import { fromIsoDate } from './ceo-report.command.js';
import {
  assess,
  build,
  commentaryValues,
  finalize,
  fmtDelta,
  fmtValue,
  ground,
  hasNumber,
  llmPrompt,
  periodLabel,
  pick,
  type Rep,
  render,
  reportName,
  repSample,
  ruleTemplates,
  type SnapIn,
} from './ceo-report.js';
import {
  agentMetricId,
  closed,
  collectChat,
  csvSourceRef,
  fmtNum,
  isSampleName,
  lastClosedRef,
  loadMetrics,
  type Metrics,
  MetricsError,
  metricSpec,
  readCsv,
  summarizeHours,
} from './cockpit.js';
import { dec, decStr, InvalidOperation } from './dec.js';
import { closedWeek, countCodes, rate, reviewSummary } from './mkt-metrics.js';

// Golden sinh bằng hàm Python THẬT (agents/ceo_report.py, pipelines/cockpit.py,
// pipelines/mkt_metrics.py, agents/report.collect_chat) trên đầu vào cố định — script sinh ở
// scratchpad của phiên (gen_golden.py), không trong repo. Guardrail THẬT (security/guardrail) qua
// `wireSecurity(null)`.
//
// KHÁC Python có chủ đích (TS chặt hơn = fail-closed):
//  - TS_STRICTER `fromIsoDate`: chỉ YYYY-MM-DD / YYYYMMDD (Python 3.12 nhận thêm dạng tuần ISO).
//  - TS_STRICTER `loadMetrics`: JSON có NaN/Infinity bị từ chối (JSON.parse) — Python nhận rồi luật
//    kiểu chặn sau; cả hai đều MetricsError.

const NOW = new Date('2026-10-12T09:00:00+07:00');
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ceo-golden-'));
  resetOpsDeps();
  wireSecurity(null); // guardrail + che PII THẬT
});
afterAll(() => {
  resetOpsDeps();
  rmSync(tmp, { recursive: true, force: true });
});

type GSnap = [string, string, string, string, string, string | null, string | null];
const toSnap = ([ch, mid, ps, val, src, ref, cap]: GSnap): SnapIn => ({
  channel: ch,
  metric_id: mid,
  period_start: ps,
  value: val,
  source: src,
  source_ref: ref,
  captured_at: cap === null ? null : new Date(cap),
});

/** Python `_SnapConn`: chỉ trả snapshot cho SELECT channel_snapshots của 2 kỳ. */
function snapDb(snaps: SnapIn[]): Db {
  return {
    query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain('from channel_snapshots');
      const [, cur, prev] = params as string[];
      return { rows: snaps.filter((s) => s.period_start === cur || s.period_start === prev) };
    },
  } as unknown as Db;
}

function routingFile(name: string, text: string | null): string | null {
  if (text === null) return null;
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, text, 'utf8');
  return p;
}

const FULL = (G.variants.full_red.snaps as GSnap[]).map(toSnap);

async function rep(
  snaps: SnapIn[],
  routing: string | null,
  extra: Parameters<typeof build>[3] = {},
  kind = 'week',
  ref = '2026-10-05',
): Promise<Rep> {
  return build(snapDb(snaps), kind, ref, { now: NOW, routing, ...extra });
}

describe('ceo_report — định dạng (golden)', () => {
  it('fmtValue', () => {
    for (const [v, u, want] of G.fmt_value as [string, string, string][]) {
      expect(fmtValue(dec(v), u), `${v} ${u}`).toBe(want);
    }
  });
  it('fmtDelta (vượt độ chính xác → InvalidOperation như Python)', () => {
    for (const [a, b, u, want] of G.fmt_delta as [string, string, string, string][]) {
      if (want.startsWith('!')) {
        expect(() => fmtDelta(dec(a), dec(b), u), `${a} ${b}`).toThrow(InvalidOperation);
      } else expect(fmtDelta(dec(a), dec(b), u), `${a} ${b} ${u}`).toBe(want);
    }
  });
  it('assess', () => {
    for (const [a, b, better, want] of G.assess as [
      string | null,
      string | null,
      string,
      string,
    ][]) {
      expect(assess(a === null ? null : dec(a), b === null ? null : dec(b), better)).toBe(want);
    }
  });
  it('periodLabel', () => {
    for (const [kind, d, want] of G.period_label as [string, string, string][]) {
      expect(periodLabel(kind, d), `${kind} ${d}`).toBe(want);
    }
  });
  it('hasNumber (mọi ký tự số Unicode, % ‰, trăm/nghìn/triệu/tỷ)', () => {
    for (const [t, want] of G.has_number as [string, string[]][]) {
      expect(hasNumber(t), t).toEqual(want);
    }
  });
  it('pick: manual_export thắng api ở mọi thứ tự; NaN/khổng lồ bị bỏ + đếm', () => {
    const [picked, bad] = pick((G.pick.snaps as GSnap[]).map(toSnap));
    expect(bad).toBe(G.pick.bad);
    const got = [...picked]
      .map(([k, v]) => [...k.split('\u0000'), decStr(v.value), v.source])
      .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
    expect(got).toEqual(G.pick.picked);
  });
});

describe('ceo_report — ground (golden)', () => {
  it('commentaryValues + ground: mọi template khớp Python (số CHỈ từ values)', async () => {
    const r = await rep(FULL, routingFile('red', G.variants.full_red.routing));
    const values = commentaryValues(r);
    expect(values).toEqual(G.values);
    const labels = [r.label, r.prev_label];
    for (const [t, text, reasons] of G.ground as [string, string | null, string[]][]) {
      expect(ground(t, values, labels), t.slice(0, 80)).toEqual([text, reasons]);
    }
    for (const [t, text, reasons] of G.ground_extra as [unknown, string | null, string[]][]) {
      expect(ground(t, values, labels)).toEqual([text, reasons]);
    }
  });
});

describe('ceo_report — trang (golden theo biến thể)', () => {
  type V = (typeof G.variants)['full_red'];
  for (const [name, v] of Object.entries(G.variants) as [string, V][]) {
    it(name, async () => {
      const r = await rep(
        (v.snaps as GSnap[]).map(toSnap),
        routingFile(name, v.routing),
        {
          sections: v.sections as string[][] | null,
          metrics: (v.metrics as Metrics | null) ?? null,
        },
        v.kind,
        v.ref,
      );
      expect([r.label, r.prev_label, r.ignored, r.bad_values]).toEqual([
        v.label,
        v.prev_label,
        v.ignored,
        v.bad_values,
      ]);
      expect(r.preflight).toEqual(v.preflight);
      expect(
        r.rows.map((x) => [
          x.metric_id,
          x.channel,
          x.key,
          x.section,
          x.per_agent,
          x.name,
          x.cur ? decStr(x.cur.value) : null,
          x.prev ? decStr(x.prev.value) : null,
        ]),
      ).toEqual(v.rows);
      const [tpls, values] = ruleTemplates(r);
      expect(values).toEqual(v.values);
      expect(tpls).toEqual(v.templates);
      expect(r.commentary).toBe(v.commentary);
      expect(render(r)).toBe(v.page);
      expect(repSample(r)).toBe(v.sample);
      expect(reportName(r)).toBe(v.report_name);
      expect(r.rows.filter((x) => x.cur !== null).length).toBe(v.n_data);
      if (v.prompt) expect(llmPrompt(r)).toEqual(v.prompt);
      expect(finalize(r)).toEqual(v.finalize);
    });
  }

  it('finalize: trang vi phạm guardrail → dòng cảnh báo đầu trang, ok=false', async () => {
    const r = await rep(FULL, routingFile('red', G.variants.full_red.routing));
    (r.rows[0] as { name: string }).name = 'Sâm chữa bệnh';
    const [text, ok] = finalize(r);
    expect([text, ok]).toEqual(G.finalize_violation);
    expect(text.split('\n')[2]).toMatch(/^> \*\*CẢNH BÁO GUARDRAIL/);
  });

  it('llm=false: 0 lời gọi gateway, nhận xét theo luật', async () => {
    const calls: unknown[] = [];
    const ai = { chat: async (...a: unknown[]) => calls.push(a) as never };
    const r = await rep(FULL, routingFile('red', G.variants.full_red.routing), { ai });
    expect(calls).toEqual([]);
    expect(render(r)).toContain('theo luật');
  });
});

describe('ceo_report — LLM grounded (golden, gateway GIẢ)', () => {
  type L = (typeof G.llm)['valid'];
  for (const [name, c] of Object.entries(G.llm) as [string, L][]) {
    it(name, async () => {
      const calls: [string, unknown, unknown][] = [];
      const ai = {
        chat: async (agent: string, messages: unknown, opts: unknown) => {
          calls.push([agent, messages, opts]);
          if (c.exc === 'blocked') throw new GatewayBlocked('cap');
          if (c.exc === 'error') throw new GatewayError('x');
          if (c.exc === 'structure') return undefined as never;
          return { text: c.reply } as never;
        },
      };
      const r = await rep(FULL, routingFile('red', G.variants.full_red.routing), {
        llm: true,
        ai,
      });
      expect([r.commentary, r.llm_used, r.llm_note]).toEqual([
        c.commentary,
        c.llm_used,
        c.llm_note,
      ]);
      if (c.page) expect(render(r)).toBe(c.page);
      expect(calls.length).toBe(1);
      const [agent, messages, opts] = calls[0] as [string, unknown, unknown];
      const [pyAgent, pyMessages, pyKw] = c.calls[0] as [string, unknown, Record<string, unknown>];
      expect(agent).toBe(pyAgent);
      expect(messages).toEqual(pyMessages);
      expect(opts).toEqual(pyKw);
    });
  }

  it('prompt KHÔNG chứa số tuyệt đối của fixture', async () => {
    const r = await rep(FULL, routingFile('red', G.variants.full_red.routing));
    const prompt = JSON.stringify(llmPrompt(r));
    for (const v of [
      '137',
      '120',
      '21585320',
      '21.585.320',
      '18.000.000',
      '7.777',
      '16,0',
      '0,75',
    ]) {
      expect(prompt).not.toContain(v);
    }
    expect(prompt).toContain('{metric:kỳ}');
  });

  it('không có AI Gateway mà bật llm → nhận xét LLM bị loại, rơi về luật (fail-closed)', async () => {
    const r = await rep(FULL, routingFile('red', G.variants.full_red.routing), { llm: true });
    expect(r.llm_used).toBe(false);
    expect(r.llm_note).toBe('Nhận xét LLM bị loại: gateway lỗi (GatewayError)');
  });
});

// ------------------------------------------------------------------ cockpit

/** Cùng phép biến đổi cấu hình như gen_golden.py (tên ca → cấu hình). */
const BAD_CFG: Record<
  string,
  (c: { metrics: Record<string, Record<string, unknown>> }) => unknown
> = {
  'id-hoa': (c) => ({ metrics: { 'Leads.New': c.metrics['leads.new'] } }),
  'better-cao': (c) => set(c, 'leads.new', { better: 'cao' }),
  'kind-x': (c) => set(c, 'leads.new', { kind: 'x' }),
  'ext-thieu-channels': (c) => set(c, 'sales.gmv_vnd', { channels: null }),
  'int-channels-shopee': (c) => set(c, 'leads.new', { channels: ['shopee'] }),
  'unit-rong': (c) => set(c, 'leads.new', { unit: '' }),
  rong: () => ({}),
  'metrics-rong': () => ({ metrics: {} }),
  'metrics-list': () => ({ metrics: [] }),
  'top-list': () => [],
  'khong-object': () => ({ metrics: { 'leads.new': 5 } }),
  'thieu-name': (c) => del(c, 'leads.new', 'name'),
  'name-trang': (c) => set(c, 'leads.new', { name: '  　' }),
  'integer-1': (c) => set(c, 'leads.new', { integer: 1 }),
  'channels-rong': (c) => set(c, 'sales.gmv_vnd', { channels: [] }),
  'channels-hoa': (c) => set(c, 'sales.gmv_vnd', { channels: ['Shopee'] }),
  'channels-so': (c) => set(c, 'sales.gmv_vnd', { channels: [1] }),
  'int-2-kenh': (c) => set(c, 'leads.new', { channels: ['noi_bo', 'shopee'] }),
  'int-source-x': (c) => set(c, 'leads.new', { source: 'x:leads' }),
  'int-source-none': (c) => del(c, 'leads.new', 'source'),
  'ext-noi-bo': (c) => set(c, 'sales.gmv_vnd', { channels: ['shopee', 'noi_bo'] }),
  'ext-source-api': (c) => set(c, 'sales.gmv_vnd', { source: 'api' }),
  'per-agent-1': (c) => set(c, 'ai.cost_usd', { per_agent: 1 }),
  'unit-la': (c) => set(c, 'leads.new', { unit: '%' }),
  'id-ngan': (c) => ({ metrics: { a: c.metrics['leads.new'] } }),
  'id-so': (c) => ({ metrics: { '1abc': c.metrics['leads.new'] } }),
  'id-dai': (c) => ({ metrics: { ['a'.repeat(65)]: c.metrics['leads.new'] } }),
};
type Cfg = { metrics: Record<string, Record<string, unknown>> };
function set(c: Cfg, mid: string, kw: Record<string, unknown>): Cfg {
  Object.assign(c.metrics[mid] as object, kw);
  return c;
}
function del(c: Cfg, mid: string, key: string): Cfg {
  delete (c.metrics[mid] as Record<string, unknown>)[key];
  return c;
}

describe('cockpit — từ điển chỉ số (golden)', () => {
  const M = loadMetrics();
  it('loadMetrics từ chối cấu hình sai — cùng thông điệp Python', async () => {
    const { readFileSync } = await import('node:fs');
    const { METRICS_PATH } = await import('./cockpit.js');
    const base = JSON.parse(readFileSync(METRICS_PATH, 'utf8'));
    for (const [name, want, b64] of CK.load_metrics_bad as [string, string, string?][]) {
      const p = join(tmp, 'metrics.json');
      if (name.endsWith(':b64')) {
        // [tên, b64, lỗi]
        writeFileSync(p, Buffer.from(want, 'base64'));
        expect(() => loadMetrics(p), name).toThrow(new MetricsError(b64 as string));
        continue;
      }
      const fn = BAD_CFG[name];
      expect(fn, name).toBeDefined();
      writeFileSync(p, JSON.stringify((fn as (c: Cfg) => unknown)(structuredClone(base))), 'utf8');
      expect(() => loadMetrics(p), name).toThrow(new MetricsError(want));
    }
    expect(() => loadMetrics(join(tmp, 'khong_co.json'))).toThrow(
      new MetricsError(CK.load_metrics_missing),
    );
  });
  it('metricSpec / agentMetricId', () => {
    for (const [mid, key] of CK.metric_spec as [unknown, string | null][]) {
      expect(metricSpec(M, mid), String(mid)).toBe(key === null ? null : M[key]);
    }
    for (const [a, want] of CK.agent_metric_id as [unknown, string][]) {
      expect(agentMetricId(a), String(a)).toBe(want);
    }
  });
  it('summarizeHours (round nửa-chẵn trên giá trị nhị phân như Python)', () => {
    for (const [h, want] of CK.summarize_hours as [number[], unknown][]) {
      expect(summarizeHours(h), JSON.stringify(h)).toEqual(want);
    }
  });
  it('fmtNum (_fmt)', () => {
    for (const [v, want] of CK.fmt as [string, string][]) expect(fmtNum(dec(v)), v).toBe(want);
  });
  it('closed / lastClosedRef / fromIsoDate', () => {
    for (const [kind, ref, now, s, e, err] of CK.closed as (string | null)[][]) {
      const f = () => closed(kind as string, ref as string, new Date(now as string));
      if (err) expect(f, `${kind} ${ref}`).toThrow(new RangeError(err));
      else {
        const [a, b] = f();
        expect([a.getTime(), b.getTime()]).toEqual([
          new Date(s as string).getTime(),
          new Date(e as string).getTime(),
        ]);
      }
    }
    for (const [kind, now, want] of CK.last_closed_ref as string[][]) {
      expect(lastClosedRef(kind as string, new Date(now as string)), `${kind} ${now}`).toBe(want);
    }
    for (const [s, want, err] of CK.fromisoformat as (string | null)[][]) {
      if (err) expect(() => fromIsoDate(s as string), s as string).toThrow(new RangeError(err));
      else expect(fromIsoDate(s as string)).toBe(want);
    }
    // TS_STRICTER: dạng tuần ISO (Python 3.12 nhận) → từ chối.
    expect(() => fromIsoDate('2026-W41-1')).toThrow(RangeError);
  });
});

describe('cockpit — CSV manual_export (golden)', () => {
  const M = loadMetrics();
  it('readCsv: mọi ca khớp Python; lỗi KHÔNG chứa giá trị ô', () => {
    for (const [name, data, rows, errors] of CK.read_csv as [
      string,
      string,
      string[][],
      string[],
    ][]) {
      const raw =
        data === 'gen:field-limit'
          ? Buffer.from(
              'channel,metric_id,period_kind,period_start,value\nshopee,sales.gmv_vnd,week,2026-10-05,' +
                '1'.repeat(131073) +
                '\n',
              'utf8',
            )
          : Buffer.from(data, 'base64');
      const p = join(tmp, 'case.csv');
      writeFileSync(p, raw);
      const [r, e] = readCsv(p, M, { now: NOW });
      expect(
        r.map((x) => [x.channel, x.metric_id, x.period_kind, x.period_start, decStr(x.value)]),
        name,
      ).toEqual(rows);
      expect(e, name).toEqual(errors);
      expect(
        e.every((x) => x.startsWith('dòng ')),
        name,
      ).toBe(true);
    }
    for (const needle of ['21.585.320', 'lazada', '１２', 'sales.bogus_x']) {
      const all = (CK.read_csv as [string, string, unknown, string[]][]).flatMap((c) => c[3]);
      expect(
        all.some((x) => x.includes(needle)),
        needle,
      ).toBe(false);
    }
  });
  it('file quá lớn / không có file', () => {
    const p = join(tmp, 'big.csv');
    writeFileSync(p, 'channel,metric_id,period_kind,period_start,value\n');
    expect(readCsv(p, M, { now: NOW, maxBytes: 10 })).toEqual(CK.read_csv_big);
    expect(readCsv(join(tmp, 'khong_co.csv'), M, { now: NOW })[1]).toEqual(CK.read_csv_missing);
  });
  it('isSampleName / csvSourceRef', () => {
    for (const [n, want] of CK.is_sample_name as [string, boolean][]) {
      expect(isSampleName(n), n).toBe(want);
    }
    for (const [name, content, sample, want] of CK.csv_source_ref as [
      string,
      string,
      boolean,
      string,
    ][]) {
      const d = join(tmp, `ref-${Math.random().toString(36).slice(2)}`);
      mkdirSync(d);
      const p = join(d, name);
      writeFileSync(p, content, 'utf8');
      expect(csvSourceRef(p, sample), name).toBe(want);
    }
  });
});

describe('mkt_metrics + collect_chat (golden)', () => {
  it('reviewSummary / rate / closedWeek / countCodes', () => {
    for (const [h, want] of MK.review_summary as [number[], unknown][]) {
      expect(reviewSummary(h), JSON.stringify(h)).toEqual(want);
    }
    for (const [a, b, want] of MK.rate as [number, number, number | null][]) {
      expect(rate(a, b), `${a}/${b}`).toBe(want);
    }
    for (const [until, start, label] of MK.closed_week as string[][]) {
      const [s, l] = closedWeek(new Date(until as string));
      expect([s.getTime(), l]).toEqual([new Date(start as string).getTime(), label]);
    }
    for (const [snap, want] of MK.codes as [unknown, Record<string, number>][]) {
      const out = new Map<string, number>();
      countCodes(snap, out);
      expect(Object.fromEntries(out), JSON.stringify(snap)).toEqual(want);
    }
  });
  it('collectChat: chỉ dòng live, bỏ câu đồng ý, ts hỏng → bad_ts, dòng hỏng → skipped', () => {
    const d = join(tmp, 'chat');
    mkdirSync(d);
    for (const [n, b64] of Object.entries(MK.collect_chat.files)) {
      writeFileSync(join(d, n), Buffer.from(b64, 'base64'));
    }
    expect(
      collectChat(d, new Date(MK.collect_chat.since), new Date(MK.collect_chat.until)),
    ).toEqual(MK.collect_chat.stats);
  });
});
