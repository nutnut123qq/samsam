import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRECTORS_DIR, DirectorConfigError } from '@samsam/core/ops/director';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { check } from '@samsam/core/security/guardrail';
import { afterEach, describe, expect, it, vi } from 'vitest';
import collectFx from './__fixtures__/collect_fake.golden.json' with { type: 'json' };
import convFx from './__fixtures__/convlog.golden.json' with { type: 'json' };
import nowFx from './__fixtures__/now_arg.golden.json' with { type: 'json' };
import G from './__fixtures__/sales_director.golden.json' with { type: 'json' };
import W from './__fixtures__/sales_watch.golden.json' with { type: 'json' };
import { channelOf, convKind, dedupKey, iterConvlog, parseTs } from './convlog.js';
import {
  type BulletinData,
  bulletinName,
  type Catalog,
  periodOf,
  regionCounts,
  renderBulletin,
} from './sales-director.bulletin.js';
import { parseIsoNow, printRun, salesDirectorMain } from './sales-director.command.js';
import {
  AGENT,
  alertOf,
  alertType,
  batches,
  code,
  collectAll,
  cskhObjectId,
  JOB,
  leadItems,
  loadSalesConfig,
  plan,
  ref,
  route,
  type SalesConfig,
  slaState,
  staleLeads,
  unanswered,
  worstClockHours,
} from './sales-director.service.js';
import { load as loadWatch, section, validate as validateWatch } from './sales-watch.js';

// Dịch tests/test_sales_director.py (phần thuần) + phần sales_watch của tests/test_v14_p4_sales.py
// + lead_deferred của tests/test_v15_p8_outputs.py. Golden sinh từ hàm Python thật
// (__fixtures__/*.golden.json); DB ở sales-director.db.test.ts.

const CFG = loadSalesConfig();
const NAME = 'Nguyễn Văn An';
const PHONE = '0912345678';
const EMAIL = 'an@example.com';
const UHASH = 'uh_5f2c9a7e1b';
const PII = [NAME, PHONE, EMAIL, UHASH];
const D = (s: string) => new Date(s);
/** Giờ VN tháng 10/2026 (12 = thứ Hai). */
const t = (d: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, d, hh - 7, mm, 0, 0));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Đặt `value_json` (chữ JSON thô từ Python — giữ 30.0 là float) vào `path` của bản sao `raw`. */
function mutatedText(raw: unknown, path: (string | number)[], valueJson: string): string {
  const doc = structuredClone(raw) as Record<string | number, unknown>;
  let node = doc;
  for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (valueJson === '"__DEL__"') delete node[last];
  else node[last] = '\u0000V\u0000';
  return JSON.stringify(doc).replace('"\\u0000V\\u0000"', valueJson);
}

describe('cấu hình khối KD (W50.2)', () => {
  it('cấu hình ship hợp lệ, không có người thật', () => {
    const raw = JSON.parse(readFileSync(join(DIRECTORS_DIR, 'sales.json'), 'utf8'));
    expect(raw.approvers).toEqual([]);
    expect(raw.digest_recipients).toEqual([]);
    expect(raw.approver_roles).toEqual(['gd_ban_hang']);
    expect(raw._doc).toContain('CHƯA ĐƯỢC TGĐ/GĐ KD DUYỆT');
    expect(raw._doc).toContain('GIẢ ĐỊNH');
    const hc = CFG.handoff_classes;
    expect([hc.A?.business_hours, hc.B?.business_hours]).toEqual([2, 4]);
    expect(hc.A?.red_alert).toBe(true);
    expect(hc.B?.escalate_to_role).toBe('tgd');
    const types = CFG.object_types;
    expect(types.market_alert_s1?.risk).toBe('high');
    const a = Object.entries(types)
      .filter(([, s]) => s.handoff === 'A')
      .map(([k]) => k);
    expect(new Set(a)).toEqual(
      new Set(['cskh_handoff', 'cskh_reply', 'market_alert_s1', 'care_review']),
    );
    const low = Object.entries(types)
      .filter(([, s]) => s.risk === 'low')
      .map(([k]) => k);
    expect(low).toEqual(['b2b_quote_matrix']);
    // v14.4: 4 loại việc mới vào lớp B → GĐ bán hàng, quá hạn leo thang TGĐ.
    for (const ot of ['lead_followup', 'b2b_followup', 'dealer_price_alert', 'order_anomaly']) {
      expect(types[ot]?.handoff).toBe('B');
      expect(['medium', 'high']).toContain(types[ot]?.risk);
    }
    expect(CFG.lead_owner).toEqual(W.lead_owner);
  });

  it('worstClockHours = Python (T6 18:00 → T2 10:00 = 64h)', () => {
    expect(worstClockHours(CFG.business_hours, 2)).toBe(64);
    expect(worstClockHours(CFG.business_hours, 4)).toBe(66);
    for (const c of G.worst)
      expect(worstClockHours(c.shift, c.hours), JSON.stringify(c)).toBe(c.worst);
  });

  it('mọi biến thể cấu hình hỏng → DirectorConfigError, thông điệp = Python', () => {
    const raw = JSON.parse(readFileSync(join(DIRECTORS_DIR, 'sales.json'), 'utf8'));
    for (const c of G.config_errors) {
      const dir = tmp('sd-cfg-');
      writeFileSync(join(dir, 'sales.json'), mutatedText(raw, c.path, c.value_json));
      let msg: string | null = null;
      try {
        loadSalesConfig(dir);
      } catch (e) {
        expect(e, JSON.stringify(c.path)).toBeInstanceOf(DirectorConfigError);
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(c.path)).toBe(c.error);
    }
  });

  it('sales_watch.json lỗi → DirectorConfigError trước khi connect', () => {
    const dir = tmp('sd-w-');
    writeFileSync(join(dir, 'sales_watch.json'), '{broken');
    expect(() => loadSalesConfig(DIRECTORS_DIR, join(dir, 'sales_watch.json'))).toThrow(
      'sales: không đọc được sales_watch.json (JSONDecodeError)',
    );
  });
});

describe('sales_watch (v14.4 p4)', () => {
  const raw = JSON.parse(readFileSync(join(DIRECTORS_DIR, '..', 'sales_watch.json'), 'utf8'));
  it('cấu hình ship hợp lệ, chưa ai chốt, không bịa mã nhân viên', () => {
    const doc = loadWatch();
    expect(doc.confirmed_by).toBeNull();
    expect(String(doc.status)).toContain('GIẢ ĐỊNH');
    expect(doc.lead_owner.staff_codes).toEqual([]);
    expect(section('lead_owner')).toEqual(W.lead_owner);
  });

  it('fail-closed mọi biến thể (thông điệp = Python, float 2.0 ≠ int)', () => {
    for (const c of W.cases) {
      let msg: string | null = null;
      try {
        validateWatch(parsePyJson(mutatedText(raw, c.path, c.value_json)));
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(c.path)).toBe(c.error);
    }
    const roots = [[], 'x', null, 5].map((v) => {
      try {
        validateWatch(v);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(roots).toEqual(W.root);
  });

  it('load: BOM ok, JSON hỏng / không UTF-8 / thiếu file / float → thông điệp = Python', () => {
    const dir = tmp('sw-');
    const text = JSON.stringify(raw);
    const files: Record<string, Buffer> = {
      'bom.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
      'broken.json': Buffer.from('{broken'),
      'bad_utf8.json': Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      'float.json': Buffer.from(text.replace('"max_per_run":30', '"max_per_run":30.0')),
    };
    const got: Record<string, string | null> = {};
    for (const [n, b] of Object.entries(files)) {
      writeFileSync(join(dir, n), b);
      try {
        loadWatch(join(dir, n));
        got[n] = null;
      } catch (e) {
        got[n] = (e as Error).message;
      }
    }
    try {
      loadWatch(join(dir, 'missing.json'));
    } catch (e) {
      got['missing.json'] = (e as Error).message;
    }
    expect(got).toEqual(W.load);
  });
});

describe('SLA thuần', () => {
  it('route + alertType', () => {
    const r = route(CFG, alertType('S1'));
    expect([r.handoff, r.risk, r.assignee_role, r.red_alert, r.auto_eligible]).toEqual([
      'A',
      'high',
      'mxh',
      true,
      false,
    ]);
    const r2 = route(CFG, alertType('S2'));
    expect([r2.handoff, r2.assignee_role, r2.escalate_to_role]).toEqual([
      'B',
      'gd_ban_hang',
      'tgd',
    ]);
    expect(() => alertType('S3')).toThrow(RangeError);
    expect(() => route(CFG, 'ad_campaign')).toThrow("khối sales không có loại việc 'ad_campaign'");
  });

  it('slaState = Python (lớp A/B, cuối tuần không tính)', () => {
    for (const c of G.sla) {
      const st = slaState(
        { object_type: c.object_type, created_at: D(c.created_at) },
        CFG,
        D(c.now),
      );
      expect({ ...st, business_due_at: st.business_due_at.getTime() }, JSON.stringify(c)).toEqual({
        ...c.result,
        business_due_at: D(c.result.business_due_at).getTime(),
      });
    }
    expect(() =>
      slaState({ object_type: 'price_review', created_at: t(12, 16) }, CFG, new Date(Number.NaN)),
    ).toThrow(RangeError);
  });

  it('regionCounts biên từ 2 phía (Huế ≠ Thuế), NFC + casefold', () => {
    expect(regionCounts(CFG, G.regions.questions)).toEqual(G.regions.result);
    const got = Object.fromEntries(
      regionCounts(CFG, [
        'Giao hàng ra Huế được không',
        'Thuế VAT bao nhiêu',
        'ĐÀ NẴNG có đại lý không',
        'Đà Nẵng mua ở đâu'.normalize('NFD'),
        null,
        'giá sỉ ở Sài Gòn',
      ]),
    );
    expect(got['Miền Trung – Tây Nguyên khác']).toBe(1);
    expect(got['Quảng Nam – Đà Nẵng']).toBe(2);
    expect(got['TP.HCM – miền Nam']).toBe(1);
    expect(got['chưa rõ vùng']).toBe(2);
  });

  it('periodOf biên giờ VN', () => {
    for (const p of G.periods) {
      expect(periodOf(p.kind, D(p.now)).map((x) => x.getTime())).toEqual([
        D(p.start).getTime(),
        D(p.end).getTime(),
      ]);
    }
    expect(() => periodOf('month', t(12, 9))).toThrow(RangeError);
  });

  it('code/ref/alertOf/batches = Python', () => {
    for (const [v, want] of Object.entries(G.codes)) expect(code(v), v).toBe(want);
    expect([code(null), code(5)]).toEqual(G.codes_nonstr);
    for (const [s, want] of Object.entries(G.refs)) expect(ref(s)).toBe(want);
    for (const a of G.alerts_of) {
      const fresh = a.batch.map(
        ([p, s]) =>
          [
            { ...(p as object), created_at: new Date(0), due_at: new Date(0) },
            {
              ...(s as object),
              business_due_at: D((s as { business_due_at: string }).business_due_at),
            },
          ] as never,
      );
      expect(alertOf(fresh, CFG)).toEqual([a.title, a.detail]);
    }
  });

  it('agent KHÔNG gọi hàm duyệt (decide/auto_approve/override/decide_item)', () => {
    for (const f of [
      'sales-director.service.ts',
      'sales-director.bulletin.ts',
      'sales-director.command.ts',
    ]) {
      const src = readFileSync(join(import.meta.dirname, f), 'utf8');
      expect(src, f).not.toMatch(/\bdecide\(|autoApprove|auto_approve|override\(|decide_item/);
    }
  });
});

describe('convlog (lead_store) = Python', () => {
  it('parseTs (strptime: 1 chữ số, chữ số Unicode, T/Z thường, ngày không có thật)', () => {
    for (const [s, want] of convFx.parse_ts as [string, string | null][]) {
      const got = parseTs(s);
      expect(got === null ? null : got.getTime(), JSON.stringify(s)).toBe(
        want === null ? null : Date.parse(want),
      );
    }
    expect([parseTs(null), parseTs(5), parseTs(['x'])]).toEqual(convFx.parse_ts_nonstr);
  });

  it('dedupKey/channelOf/convKind', () => {
    for (const c of convFx.misc) {
      expect(dedupKey(c.rec as never)).toBe(c.dedup);
      expect(channelOf(c.rec as never)).toBe(c.channel);
    }
    for (const [r, k] of convFx.kinds as [object, string][])
      expect(convKind(r as never), JSON.stringify(r)).toBe(k);
  });

  it('iterConvlog BYTES + split \\n (BOM/U+2028/byte lỗi/dòng mẫu)', () => {
    const dir = tmp('cv-');
    const p = join(dir, 'c.jsonl');
    writeFileSync(p, Buffer.from(convFx.iter_raw_hex, 'hex'));
    // TS_STRICTER: dòng `{"x": NaN}` — Python json nhận NaN (fixture đã bỏ), JSON.parse từ chối → corrupt.
    for (const [live, key] of [
      [false, 'all'],
      [true, 'live'],
    ] as const) {
      const stats = { corrupt: 0, doc: 0, io_error: 0 };
      const want = convFx.iter[key];
      expect(iterConvlog(p, stats, live)).toEqual(want.recs);
      expect(stats).toEqual({ ...want.stats, corrupt: want.stats.corrupt + 1 });
    }
    const st = { corrupt: 0, doc: 0, io_error: 0 };
    expect(iterConvlog(join(dir, 'missing.jsonl'), st)).toEqual([]);
    expect(st).toEqual(convFx.iter.missing_stats);
  });

  it('cskhObjectId + unanswered (gom khách/ngày VN, chỉ live, cửa sổ, file xoay .1)', () => {
    for (const c of convFx.cskh_ids) expect(cskhObjectId(c.rec as never, D(c.ts))).toBe(c.id);
    const dir = tmp('un-');
    const lines = convFx.unanswered.recs.map((r) => JSON.stringify(r));
    lines.splice(2, 0, '{corrupt json');
    writeFileSync(join(dir, 'conversations.jsonl'), `${lines.join('\n')}\n`);
    writeFileSync(
      join(dir, 'conversations.jsonl.1'),
      `${JSON.stringify({ ts: '2026-10-11T23:00:00Z', msg_id: 'rot', user_hash: 'uh_rot', question: 'file xoay', answer: '', answered: false, provenance: 'live' })}\n`,
    );
    const got = unanswered(D(convFx.unanswered.now), CFG, dir).map((g) => ({
      ...g,
      ts: g.ts.getTime(),
      recs: g.recs.map(([d, ch]) => [d.getTime(), ch]),
    }));
    expect(got).toEqual(
      convFx.unanswered.groups.map((g) => ({
        ...g,
        ts: D(g.ts).getTime(),
        recs: g.recs.map(([d, ch]) => [D(d as string).getTime(), ch]),
      })),
    );
  });
});

// ---------------------------------------------------------------- collect/plan trên Db giả

type Fx = typeof collectFx.fx;
const usKey = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\+00:00$/.exec(iso);
  if (!m) throw new Error(iso);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}${(m[7] ?? '').padEnd(6, '0')}Z`;
};

/** Db giả trả đúng các dòng mà FakeConn Python trả (cùng bộ lọc tham số). */
function fakeDb(fx: Fx) {
  const rows = (sql: string, params: unknown[] = []): Record<string, unknown>[] => {
    if (sql.includes("from market_alerts where status = 'open' order by id"))
      return fx.ma.map(([id, kind, severity, channel, export_kind, o]) => ({
        id: String(id),
        kind,
        severity,
        channel,
        export_kind,
        opened_at: D(o as string),
        opened_key: usKey(o as string),
      }));
    if (sql.includes('from golden_discrepancies'))
      return fx.gd
        .filter(([, k]) => (params[0] as string[]).includes(k as string))
        .map(([id, kind, c]) => ({ id: String(id), kind, created_at: D(c as string) }));
    if (sql.includes("object_type = 'lead_followup'"))
      return fx.lead_seen.map((o) => ({ object_id: o }));
    if (sql.includes('from approval_queue where object_type = any'))
      return fx.seen
        .filter(([ot]) => (params[0] as string[]).includes(ot as string))
        .map(([object_type, object_id]) => ({ object_type, object_id }));
    if (sql.includes('owner_code')) {
      const since = params[0] as Date;
      return fx.leads
        .map(([id, ts, channel, intent, oc, du, asg]) => ({
          id: String(id),
          ts: D(ts as string),
          channel,
          intent,
          owner_code: oc,
          owner_due_at: du ? D(du as string) : null,
          owner_assigned_at: asg ? D(asg as string) : null,
          assigned_key: asg ? usKey(asg as string) : null,
        }))
        .filter(
          (r) => r.ts >= since || (r.owner_assigned_at !== null && r.owner_assigned_at >= since),
        )
        .sort((a, b) => a.ts.getTime() - b.ts.getTime() || Number(a.id) - Number(b.id));
    }
    if (sql.includes("object_type = 'cskh_handoff' and object_id like"))
      return fx.cskh.map(([object_id, status, d]) => ({
        object_id,
        status,
        decided_at: d ? D(d) : null,
      }));
    if (sql.includes("select id, ts from leads where status = 'new'"))
      return fx.stale.map(([id, ts]) => ({ id: String(id), ts: D(ts as string) }));
    if (sql.includes("count(*)::int as n from approval_queue where status = 'pending' and due_at"))
      return [{ n: fx.n_exp }];
    if (sql.includes('not exists') && sql.includes('sla_escalations')) {
      const since = params[1] as Date;
      return fx.cand
        .map(([id, object_type, c, d, status]) => ({
          id: String(id),
          object_type,
          created_at: D(c as string),
          due_at: D(d as string),
          status,
        }))
        .filter((r) => r.status === 'pending' || (r.status === 'expired' && r.due_at >= since));
    }
    throw new Error(sql);
  };
  return {
    query: async (sql: string, params?: unknown[]) => ({ rows: rows(sql, params) }),
  } as never;
}

describe('collect/lead_items/plan = Python (Db giả cùng dòng nguồn)', () => {
  const dir = tmp('fx-');
  writeFileSync(
    join(dir, 'conversations.jsonl'),
    `${collectFx.convlog.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const now = D(collectFx.now);
  const cfgs: Record<string, SalesConfig> = {
    base: CFG,
    cap: {
      ...CFG,
      sources: { ...CFG.sources, max_cskh_per_run: 2 },
      lead_owner: { ...(CFG.lead_owner as NonNullable<SalesConfig['lead_owner']>), max_per_run: 2 },
    },
    no_lead_owner: (({ lead_owner: _, ...rest }) => rest)(CFG) as SalesConfig,
  };
  for (const [label, want] of Object.entries(collectFx.out)) {
    it(label, async () => {
      const cfg = cfgs[label] as SalesConfig;
      const db = fakeDb(collectFx.fx);
      const st = {};
      const [items, deferred] = await collectAll(db, now, cfg, dir, st);
      expect(items).toEqual(want.items);
      expect(deferred).toBe(want.deferred);
      expect(st).toEqual(want.stats);
      expect(await plan(db, now, cfg, dir)).toEqual(want.plan);
      const st2 = {};
      expect(await leadItems(db, now, cfg, st2)).toEqual(want.lead_items);
      expect(st2).toEqual(want.lead_stats);
      expect(await staleLeads(db, now, cfg)).toEqual(want.stale);
      // payload/title: guardrail đạt + không lọt mã thô/PII/tiêu đề listing
      for (const it of items) {
        expect(check(it.payload).ok, it.payload).toBe(true);
        for (const s of [
          ...PII,
          'alcohol',
          'ruou',
          'rượu',
          'zz_new_kind',
          'Web Form',
          'nguyen an',
        ]) {
          expect(it.payload, s).not.toContain(s);
          expect(it.title, s).not.toContain(s);
        }
      }
    });
  }

  it('batches: S1 + lớp B mỗi mục 1 lô, cskh gom 1 lô/loại', async () => {
    const want = collectFx.out.base;
    // overdue nội bộ — kiểm qua plan (escalate/red_alerts) + batches trên dữ liệu Python
    const over = want.overdue.map(
      ([id, s]) =>
        [
          {
            id,
            object_type: (collectFx.fx.cand.find((c) => c[0] === id) as unknown[])[1],
            created_at: new Date(0),
            due_at: new Date(0),
          },
          {
            ...(s as object),
            business_due_at: D((s as { business_due_at: string }).business_due_at),
          },
        ] as never,
    );
    expect(batches(over).map((b) => b.map(([p]) => (p as { id: number }).id))).toEqual(
      want.batches,
    );
  });
});

// ---------------------------------------------------------------- bản tin thuần

function toData(d: Record<string, unknown>): BulletinData {
  const cat = d.catalog as
    | {
        pending: [string, string, number[]][];
        jobs: Record<string, [string | null, boolean | null]> | null;
      }
    | null
    | undefined;
  return {
    ...(d as object),
    start: D(d.start as string),
    end: D(d.end as string),
    queue: (d.queue as Record<string, unknown>[]).map((q) => ({
      ...(q as object),
      business_due_at: D(q.business_due_at as string),
      escalated_at: q.escalated_at ? D(q.escalated_at as string) : null,
    })),
    catalog:
      cat && typeof cat === 'object'
        ? ({
            pending: cat.pending,
            jobs:
              cat.jobs === null
                ? null
                : Object.fromEntries(
                    Object.entries(cat.jobs).map(([j, [ts, ok]]) => [j, [ts ? D(ts) : null, ok]]),
                  ),
          } as Catalog)
        : (cat as null | undefined),
  } as BulletinData;
}

describe('bản tin thuần (W50.6, v5.3 mục 6, P8.6)', () => {
  it('render = Python từng chữ (6 bộ dữ liệu)', () => {
    for (const b of G.bulletins) {
      const cfg = (b as { no_lead_owner?: boolean }).no_lead_owner
        ? ((({ lead_owner: _, ...rest }) => rest)(CFG) as SalesConfig)
        : CFG;
      const text = renderBulletin(cfg, toData(b.data), D(b.now), b.kind);
      expect(text, b.label).toBe(b.text);
      expect(renderBulletin(cfg, toData(b.data), D(b.now), b.kind)).toBe(text); // tất định
    }
    expect([bulletinName('day', t(12, 0)), bulletinName('week', t(5, 0))]).toEqual(
      G.bulletin_names,
    );
  });

  it('không lọt PII/title/payload; BẢN NHÁP + external-dep + GIẢ ĐỊNH', () => {
    const b = G.bulletins[0] as (typeof G.bulletins)[number];
    const text = renderBulletin(CFG, toData(b.data), D(b.now), 'day');
    for (const s of PII) expect(text).not.toContain(s);
    expect(text).toContain('BẢN NHÁP');
    expect(text).toContain('external-dep');
    expect(text).toContain('ngày 12/10/2026');
    const body = text.split('### Leo thang TGĐ')[1]?.split('## 2.')[0] ?? '';
    expect(body).toContain('#9');
    expect(body).not.toContain('#7');
    expect(text).toContain('đã leo thang lúc 12/10/2026 10:05');
    expect(text.indexOf('#7 ·')).toBeLessThan(text.indexOf('#8 ·'));
    expect(text).not.toContain('alcohol');
    const ld = G.bulletins.find((x) => x.label === 'lead_deferred') as (typeof G.bulletins)[number];
    expect(ld.text).toContain(
      'Nhắc lead (`lead_followup`) đến hạn vượt trần 30 mục/lần chạy (chờ lần sau): 4',
    );
  });
});

// ---------------------------------------------------------------- CLI (không DB)

describe('CLI sales-director (không DB)', () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = { log: () => {}, err: () => {} };

  it('--now = datetime.fromisoformat của Python (có múi giờ / naive / sai)', () => {
    for (const [s, want] of nowFx as [string, string][]) {
      const got = parseIsoNow(s);
      const norm = got instanceof Date ? got.getTime() : got === null ? 'error' : got;
      const exp = want === 'error' || want === 'naive' ? want : Math.floor(Date.parse(want));
      expect(norm, s).toBe(exp);
    }
  });

  it('sai tham số → exit 2 TRƯỚC khi connect, không job_runs', async () => {
    const calls = { open: 0, job: 0 };
    const d = {
      ...quiet,
      open: async () => {
        calls.open++;
        throw new Error('không được gọi');
      },
      jobRun: (async () => {
        calls.job++;
        return 0;
      }) as never,
    };
    for (const o of [
      {},
      { dryRun: true },
      { bulletin: true, dryRun: true },
      { run: true, now: '2026-10-12T09:00+07:00' },
      { run: true, dryRun: true, now: '2026-10-12T09:00' },
      { run: true, dryRun: true, now: 'hôm nay' },
      { bulletin: true, period: 'month' },
    ]) {
      expect(await salesDirectorMain(o, d), JSON.stringify(o)).toBe(2);
    }
    expect(calls).toEqual({ open: 0, job: 0 });
  });

  it('cấu hình hỏng → exit 1 trước khi connect', async () => {
    const dir = tmp('sd-bad-');
    writeFileSync(join(dir, 'sales.json'), '{broken');
    let opened = 0;
    const errs: string[] = [];
    const rc = await salesDirectorMain(
      { run: true, dryRun: true },
      {
        log: () => {},
        err: (s) => errs.push(s),
        directorsDir: dir,
        open: async () => {
          opened++;
          throw new Error('x');
        },
      },
    );
    expect([rc, opened]).toEqual([1, 0]);
    expect(errs[0]).toBe('[error] cấu hình lỗi: sales.json hỏng: JSONDecodeError');
  });

  it('DB down → exit 2; job_runs chỉ khi không dry-run, ok=false', async () => {
    const runs: { name: string; ok: boolean }[] = [];
    const fakeJob = (async (
      name: string,
      body: (r: { ok: boolean; detail: null }) => Promise<number>,
    ) => {
      const r = { ok: true, detail: null };
      const rc = await body(r);
      runs.push({ name, ok: r.ok });
      return rc;
    }) as never;
    const errs: string[] = [];
    const d = {
      log: () => {},
      err: (s: string) => errs.push(s),
      env: { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' },
      jobRun: fakeJob,
      wire: null,
    };
    expect(await salesDirectorMain({ run: true }, d)).toBe(2);
    expect(runs).toEqual([{ name: JOB, ok: false }]);
    expect(await salesDirectorMain({ run: true, dryRun: true }, d)).toBe(2);
    expect(runs).toHaveLength(1);
    expect(await salesDirectorMain({ bulletin: true }, d)).toBe(2);
    expect(runs).toEqual([
      { name: JOB, ok: false },
      { name: JOB, ok: false },
    ]);
    expect(errs[0]).toBe('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    // thiếu cả JOB_DATABASE_URL lẫn DATABASE_URL → lý do bind (dev)
    errs.length = 0;
    expect(await salesDirectorMain({ run: true, dryRun: true }, { ...d, env: {} })).toBe(2);
    expect(errs[0]).toMatch(/^\[error\] thiếu JOB_DATABASE_URL/);
  });

  it('dòng kết quả [dry-run]/[run] = Python', () => {
    for (const c of G.print_run) {
      const out: string[] = [];
      printRun(c.res as never, (s) => out.push(s));
      expect(out.map((l) => `${l}\n`).join('')).toBe(c.out);
    }
  });

  it('mã agent/JOB như Python', () => {
    expect([AGENT, JOB]).toEqual(['agent:sales_director', 'agents.sales_director']);
  });
});
