import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Db } from '@samsam/core/ops/deps';
import { setOpsDeps } from '@samsam/core/ops/deps';
import * as director from '@samsam/core/ops/director';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { wireSecurity } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { opsRollout, RolloutBlocked, settings as roSettings } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { setNamesFiles } from '@samsam/core/security/pii';
import { search } from '@samsam/core/security/py';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gold from './__fixtures__/channels.golden.json' with { type: 'json' };
import regexGold from './__fixtures__/regex.golden.json' with { type: 'json' };
import { channelsMain } from './channels.command.js';
import * as ch from './channels.service.js';

// Dịch tests/test_channels.py (+ ca channels của test_v14_p3_rollout_edges, test_v15_p9_chat_safety,
// test_docx_p1, test_v13_review_fix, test_r12_dot2, test_rollout_enforce). Luồng zalo.handle_text
// (gửi/convlog) là việc của nhóm zalo — ở đây kiểm trực tiếp consentGate/recordConsent mà adapter gọi.

const SALT = 'test-salt-0123456789abcdef';
const ENV = { [ch.SALT_ENV]: SALT };
const NO_SALT = {};
// Regex ĐỘC LẬP với sanViolations (không tự-kiểm): domain/url/SĐT/zalo/fb.
const INDEP =
  /https?:\/\/|www\.|[a-z0-9-]+\.(?:com|vn|net|me)\b|zalo|facebook|fanpage|\d{3,4}[ .]?\d{3}[ .]?\d{3,4}/i;
const PII = [
  '0905 123 456',
  'an@gmail.com',
  'Nguyễn Văn An',
  '12 Lê Lợi, phường Hải Châu',
  '1234567890123456',
];
const PAYLOAD_RE =
  /^kênh=(?:zalo|messenger); lý do=[a-z_]+; user_hash=[0-9a-f]{32}; msg_ref=(?:[0-9a-f]{16}|-); ts=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ; sla=\d+h$/;
const TS = new Date(Date.UTC(2026, 9, 12, 3, 4, 5));

type Q = { sql: string; params: unknown[] };
/** chat_consents in-memory + ghi lại tham số enqueue_item (Python FakeConn). */
class FakeDb {
  rows: unknown[][] = [];
  enqueued: unknown[][] = [];
  queries: Q[] = [];
  constructor(public fail: unknown = null) {}
  async query(sql: string, params: unknown[] = []) {
    const s = sql.replace(/\s+/g, ' ');
    this.queries.push({ sql: s, params });
    if (this.fail !== null) throw this.fail;
    if (s.startsWith('insert into chat_consents')) {
      this.rows.push(params);
      return { rows: [{ id: String(this.rows.length) }] };
    }
    if (s.startsWith('select action from chat_consents')) {
      const acts = this.rows
        .filter((r) => r[0] === params[0] && r[1] === params[1])
        .map((r) => r[2]);
      return { rows: acts.length ? [{ action: acts.at(-1) }] : [] };
    }
    if (s.includes('enqueue_item')) {
      this.enqueued.push(params);
      return { rows: [{ id: String(100 + this.enqueued.length) }] };
    }
    if (s.startsWith('insert into san_suggestions')) {
      this.enqueued.push(params);
      return { rows: [{ id: '7' }] };
    }
    throw new Error(`SQL lạ: ${s.slice(0, 80)}`);
  }
}
const asDb = (f: FakeDb) => f as unknown as Db;
const dbErr = (code = '08006') =>
  Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET', sqlstate: code });
const uniqueErr = () => Object.assign(new pg.DatabaseError('trùng', 0, 'error'), { code: '23505' });

let logs: string[] = [];
let tmp: string;
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void logs.push(String(s)));
  installFakeDeps();
  setOpsDeps({ guardrailCheck: (t) => check(t) }); // guardrail THẬT
  ch.resetCache();
  ch.settings.configPath = dataPath('channels.json');
  tmp = mkdtempSync(join(tmpdir(), 'ch-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  ch.resetCache();
});

function cfgFile(over: Record<string, unknown>): void {
  const cfg = JSON.parse(readFileSync(ch.settings.configPath, 'utf8'));
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('tpl_')) {
      if (v === null) delete cfg.templates[k.slice(4)];
      else cfg.templates[k.slice(4)] = v;
    } else cfg[k] = v;
  }
  const p = join(tmp, 'channels.json');
  writeFileSync(p, JSON.stringify(cfg));
  ch.settings.configPath = p;
  ch.resetCache();
}

// ------------------------------------------------------------ golden (hàm Python thật)

describe('golden', () => {
  it('sanViolations', () => {
    for (const [t, want] of gold.san_violations)
      expect([t, ch.sanViolations(t)]).toEqual([t, want]);
  });
  it('parseConsent', () => {
    for (const [t, want] of gold.parse_consent) expect([t, ch.parseConsent(t)]).toEqual([t, want]);
  });
  it('preRoute 4 kênh', () => {
    for (const [c, t, want] of gold.pre_route as [string, string, string[] | null][]) {
      const r = ch.preRoute(ch.normalize(c, 'u1', t, undefined, ENV));
      expect([c, t, r && [r.kind, r.text, r.handoff]]).toEqual([c, t, want]);
    }
  });
  it('normalize / userHash / handoffPayload / isoTs / ref / suggestionRef', () => {
    for (const [t, want] of gold.normalize)
      expect(ch.normalize('zalo', 'u1', t, undefined, ENV).text).toBe(want);
    for (const [c, u, want] of gold.user_hash)
      expect(ch.userHash(c as string, u as string, ENV)).toBe(want);
    for (const [c, reason, msg, sla, want] of gold.handoff_payload as [
      string,
      string,
      string,
      number,
      string,
    ][]) {
      const inb = ch.normalize(c, 'u1', 'x', TS, ENV);
      expect(
        msg === '' ? ch.handoffPayload(inb, reason) : ch.handoffPayload(inb, reason, msg, sla),
      ).toBe(want);
    }
    expect(ch.isoTs(new Date('2026-01-02T03:04:05.999Z'))).toBe(gold.iso[0]?.[1]);
    expect(ch.isoTs(new Date('2026-01-02T03:04:05Z'))).toBe(gold.iso[1]?.[1]);
    for (const [m, want] of gold.ref) expect(ch.ref(m)).toBe(want);
    for (const [t, want] of gold.suggestion_ref) expect(ch.suggestionRef(t as string)).toBe(want);
  });
  it('formatReply (guardrail thật)', () => {
    for (const [c, res, text, meta] of gold.format_reply as [
      string,
      ch.AnswerResult,
      string,
      unknown,
    ][]) {
      expect([c, res, ...ch.formatReply(c, res)]).toEqual([c, res, text, meta]);
    }
  });
  it('scoreCskh', () => {
    for (const [c, out, content, want] of gold.score_cskh as [never, never, boolean, unknown][]) {
      expect([c, out, content, ch.scoreCskh(c, out, content)]).toEqual([c, out, content, want]);
    }
  });
  it('pyRegex khớp re.search của Python trên bộ ca kd_a1', () => {
    for (const [p, s, want] of regexGold as [string, string, boolean][]) {
      expect([p, s, ch.pyRegex(p).test(s)]).toEqual([p, s, want]);
    }
  });
  it('template + hằng giữ nguyên', () => {
    expect(ch.loadConfig().templates).toEqual(gold.templates);
    expect(ch.loadConfig().policy_version).toBe(gold.policy_version);
    expect(ch.NO_DATA).toBe(gold.no_data);
  });
});

// --- (a) template ------------------------------------------------------------

describe('template', () => {
  it('qua guardrail + luật kênh', () => {
    const tpl = ch.loadConfig().templates;
    expect(new Set(Object.keys(tpl))).toEqual(new Set(ch.TEMPLATE_KEYS));
    for (const [k, t] of Object.entries(tpl)) expect([k, check(t).ok]).toEqual([k, true]);
    for (const k of ['alcohol', 'alcohol_san']) {
      expect(isAlcohol(tpl[k])).toBe(false);
      expect(/mua|đặt hàng|online|http|www/i.test(tpl[k] as string)).toBe(false);
    }
    for (const k of ['alcohol_san', 'health_san', 'san_fallback', 'san_handoff']) {
      expect(ch.sanViolations(tpl[k])).toEqual([]);
      expect(INDEP.test(tpl[k] as string)).toBe(false);
    }
    for (const w of ['chữa', 'điều trị', 'thuốc', 'khỏi bệnh']) {
      expect(tpl.health?.includes(w) || tpl.health_san?.includes(w)).toBe(false);
    }
    expect(tpl.consent_prompt).toContain(ch.loadConfig().policy_url);
    expect(tpl.consent_prompt).not.toContain('{policy_url}');
    const doc = String(ch.loadConfig()._doc);
    expect(doc.includes('NHÁP') && doc.includes('Pháp chế')).toBe(true);
  });

  it('module kênh không có đường mạng/AI trực tiếp', () => {
    const src = readFileSync(join(import.meta.dirname, 'channels.service.ts'), 'utf8');
    const mods = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const bad of [
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      '@samsam/core/ai/gateway',
    ]) {
      expect(mods).not.toContain(bad);
    }
    expect(src).not.toMatch(/\bfetch\(|\.chat\(|\.embed\(/);
    const form = readFileSync(join(import.meta.dirname, 'b2b-form.service.ts'), 'utf8');
    expect(form).not.toMatch(/nodemailer|smtp|\bfetch\(|@samsam\/core\/ai/i);
  });

  it('prompt đồng ý chỉ cách rút', () => {
    const quoted = [...ch.template('consent_prompt').matchAll(/"([^"]+)"/g)].map((m) =>
      ch.parseConsent(m[1]),
    );
    expect(quoted).toEqual(expect.arrayContaining(['granted', 'withdrawn']));
  });
});

// --- (b) sanViolations -------------------------------------------------------

describe('sanViolations', () => {
  it('regex domain tuyến tính (probe DoS v5.1)', () => {
    expect(search(ch.DOMAIN_RE, 'a-b.com', 2)).toBeNull();
    expect(search(ch.DOMAIN_RE, 'a-b.com')?.[0]).toBe('a-b.com');
    const t0 = performance.now();
    for (const s of ['a-'.repeat(32000), '-a'.repeat(32000), 'a.-'.repeat(20000)]) {
      expect(ch.sanViolations(s)).toEqual([]);
    }
    expect(performance.now() - t0).toBeLessThan(20_000); // chạy xong, không treo
  });
});

// --- normalize / userHash / loadConfig ----------------------------------------

describe('normalize, userHash, loadConfig', () => {
  it('normalize', () => {
    expect(() => ch.normalize('sms', 'u', 'x')).toThrow(RangeError);
    const inb = ch.normalize('zalo', 'u', `  Đồng ý  ${'x'.repeat(5000)}`, undefined, NO_SALT);
    expect([...inb.text].length).toBe(ch.MAX_INBOUND);
    expect(inb.text.startsWith('Đồng')).toBe(true);
    expect(ch.normalize('zalo', 'u', 'Đo\u0302\u0300ng y\u0301').text).toBe('Đồng ý');
    expect(inb.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(inb.userHash).toBeNull(); // không muối
  });

  it('userHash: thiếu/ngắn muối → null, đổi muối → đổi hash', () => {
    expect(ch.userHash('zalo', 'u1', NO_SALT)).toBeNull();
    expect(ch.userHash('zalo', 'u1', { [ch.SALT_ENV]: 'ngan' })).toBeNull();
    const h = ch.userHash('zalo', 'u1', ENV) as string;
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toBe(ch.userHash('messenger', 'u1', ENV));
    expect(h).not.toBe(ch.userHash('zalo', 'u2', ENV));
    expect(ch.userHash('zalo', 'u1', { [ch.SALT_ENV]: `${SALT}x` })).not.toBe(h);
  });

  it.each([
    [{ tpl_alcohol_san: null }, 'alcohol_san'],
    [{ tpl_san_fallback: '  ' }, 'san_fallback'],
    [{ tpl_consent_prompt: 'Chào' }, '{policy_url}'],
    [{ require_consent_for_llm: 'false' }, 'require_consent_for_llm'],
    [{ policy_version: '' }, 'policy_version'],
  ])('loadConfig từ chối %j', (over, needle) => {
    cfgFile(over);
    expect(() => ch.loadConfig()).toThrow(ch.ChannelConfigError);
    expect(() => ch.loadConfig()).toThrow(needle);
  });

  it('loadConfig thiếu / hỏng', () => {
    expect(() => ch.loadConfig(join(tmp, 'khong-co.json'))).toThrow(ch.ChannelConfigError);
    const p = join(tmp, 'x.json');
    writeFileSync(p, '{');
    expect(() => ch.loadConfig(p)).toThrow('x.json hỏng: JSONDecodeError');
  });
});

// --- formatReply -------------------------------------------------------------

describe('formatReply', () => {
  it('sàn chặn cả câu, không bao giờ nối nguồn', () => {
    const res = {
      answer: 'Mua tại samsamngoclinh.com nhé',
      sources: ['https://samsamngoclinh.com/x'],
    };
    for (const c of ch.SAN_CHANNELS) {
      const [text, meta] = ch.formatReply(c, res);
      expect(text).toBe(ch.template('san_fallback'));
      expect(meta.blocked).toEqual(['domain']);
    }
    const clean = {
      answer: 'Savina tuýp 12 viên: 159.000 đ.',
      sources: ['https://samsamngoclinh.com/x'],
    };
    expect(ch.formatReply('shopee', clean)).toEqual([
      clean.answer,
      { guardrail_ok: true, handoff: null, blocked: [] },
    ]);
  });

  it('chat y hệt Zalo cũ; guardrail chặn → FALLBACK / san_fallback', () => {
    expect(
      ch.formatReply('zalo', { answer: 'Saphraton: 1.000.000 đ', sources: ['http://x', 'y'] })[0],
    ).toBe('Saphraton: 1.000.000 đ\nNguồn: http://x');
    expect(ch.formatReply('messenger', { answer: 'ok', sources: [] })[0]).toBe('ok');
    let [t, m] = ch.formatReply('zalo', { answer: ch.NO_DATA, sources: [] });
    expect([t, m.handoff]).toEqual([ch.HANDOFF_TEXT, 'no_data']);
    [t] = ch.formatReply('shopee', { answer: ch.NO_DATA, sources: [] });
    expect(t).toBe(ch.template('san_handoff'));
    expect(t).not.toContain('1800');
    setOpsDeps({ guardrailCheck: () => ({ ok: false }) });
    [t, m] = ch.formatReply('zalo', { answer: 'x', sources: [] });
    expect([t, m.handoff]).toEqual([ch.FALLBACK, 'guardrail']);
    expect(ch.formatReply('tiktok', { answer: 'x', sources: [] })[0]).toBe(
      ch.template('san_fallback'),
    );
    expect(() => ch.formatReply('sms', { answer: 'x' })).toThrow(RangeError);
  });

  it('lớp 2: answer() tự trả handoff rượu/sức khỏe → template', () => {
    for (const hand of ['alcohol', 'health']) {
      const res = { answer: ch.NO_DATA, sources: [], handoff: hand };
      expect(ch.formatReply('zalo', res)).toEqual([
        ch.template(hand),
        { guardrail_ok: true, handoff: hand, blocked: [] },
      ]);
      expect(ch.formatReply('shopee', res)[0]).toBe(ch.template(`${hand}_san`));
    }
  });
});

// --- handoff -----------------------------------------------------------------

describe('recordHandoff', () => {
  it('cấu hình khối sales: lớp A, risk ≠ low (không tự duyệt), SLA ≥ 64h', () => {
    const spec = director.loadConfig('sales').object_types.cskh_handoff as Record<string, unknown>;
    expect(spec.handoff).toBe('A');
    expect(['medium', 'high']).toContain(spec.risk);
    expect(spec.sla_hours as number).toBeGreaterThanOrEqual(64);
  });

  it('payload không PII, định dạng cố định, snapshot guardrail ok', async () => {
    const db = new FakeDb();
    const q = `Tôi là ${PII[2]}, ở ${PII[3]}, gọi ${PII[0]} hoặc ${PII[1]} — Saphraton chữa tiểu đường không?`;
    const inb = ch.normalize('messenger', `messenger:${PII[4]}`, q, undefined, ENV);
    expect(await ch.recordHandoff(inb, 'health', 'm.abc', asDb(db))).toBe(101n);
    const [params] = db.enqueued as unknown[][];
    const [otype, oid, block, title, payload, risk, g, qa, by, sla] = params as string[];
    const spec = director.loadConfig('sales').object_types.cskh_handoff;
    expect([otype, block, risk, by, sla, qa]).toEqual([
      'cskh_handoff',
      'sales',
      spec?.risk,
      'agent:kd_a1',
      spec?.sla_hours,
      'none',
    ]);
    const blob = [oid, title, payload].join(' ');
    for (const s of [...PII, 'Saphraton', 'tiểu đường', 'm.abc']) expect(blob).not.toContain(s);
    expect(payload).toMatch(PAYLOAD_RE);
    expect(oid).toBe(`messenger:${inb.userHash}`);
    expect(check(payload).ok).toBe(true); // người duyệt đóng được
    expect(JSON.parse(g as string).ok).toBe(true); // snapshot enqueue
  });

  it.each(Object.keys(ch.HANDOFF_REASONS).sort())(
    'lý do %s: payload qua guardrail, không chữ rượu',
    async (reason) => {
      const db = new FakeDb();
      await ch.recordHandoff(ch.normalize('zalo', 'u1', 'x', undefined, ENV), reason, '', asDb(db));
      const p = db.enqueued.at(-1) as string[];
      expect(p[4]).toMatch(PAYLOAD_RE);
      expect(check(p[4]).ok).toBe(true);
      expect(isAlcohol(p[4]) || isAlcohol(p[3])).toBe(false);
    },
  );

  it('lý do lạ → RangeError, 0 ghi', async () => {
    const db = new FakeDb();
    await expect(
      ch.recordHandoff(ch.normalize('zalo', 'u', 'x', undefined, ENV), 'khac', '', asDb(db)),
    ).rejects.toThrow(RangeError);
    expect(db.enqueued).toEqual([]);
  });

  it('trùng mục chờ / DB down / lỗi DB / sàn / thiếu muối → null, không ném, không lộ user_id', async () => {
    const inb = ch.normalize('zalo', 'u1', 'x', undefined, ENV);
    const dup = new FakeDb(uniqueErr());
    expect(await ch.recordHandoff(inb, 'no_data', '', asDb(dup))).toBeNull();
    expect(logs.join('\n')).toContain('đã có mục chờ');
    expect(dup.queries.at(-1)?.sql).toContain("status = 'pending'");
    expect(await ch.recordHandoff(inb, 'no_data', '', null)).toBeNull(); // DB down
    expect(await ch.recordHandoff(inb, 'health', '', asDb(new FakeDb(dbErr())))).toBeNull();
    const never = { query: () => Promise.reject(new Error('không được connect')) } as unknown as Db;
    expect(
      await ch.recordHandoff(ch.normalize('shopee', 'u', 'x', undefined, ENV), 'health', '', never),
    ).toBeNull();
    expect(
      await ch.recordHandoff(
        ch.normalize('zalo', 'u', 'x', undefined, NO_SALT),
        'health',
        '',
        never,
      ),
    ).toBeNull();
    expect(logs.join('\n')).not.toContain('u1');
  });

  it('r12 L3: tính năng TẮT (RolloutBlocked) → null, không traceback', async () => {
    installFakeDeps();
    setOpsDeps({
      rollout: {
        ...opsRollout,
        featureFor: () => 'sales-01',
        checkGenerate: () => {
          throw new RolloutBlocked('sales-01 tắt');
        },
      },
    });
    const db = new FakeDb();
    expect(
      await ch.recordHandoff(
        ch.normalize('zalo', 'u1', 'xin chào', undefined, ENV),
        'rollout',
        'm1',
        asDb(db),
      ),
    ).toBeNull();
    expect(db.enqueued).toEqual([]);
    expect(logs.join('\n')).toContain('không tạo mục handoff (rollout)');
  });

  it('respond persist: chỉ kênh chat tạo mục, rượu không gọi answer()', async () => {
    const db = new FakeDb();
    const answer = vi.fn(() => Promise.reject(new Error('LLM')));
    const out = await ch.respond('zalo', 'u1', 'rượu sâm còn không', {
      answer,
      persist: true,
      db: asDb(db),
      env: ENV,
    });
    expect(out.route).toBe('alcohol');
    expect(db.enqueued.length).toBe(1);
    await ch.respond('shopee', 'u1', 'rượu sâm còn không', {
      answer,
      persist: true,
      db: asDb(db),
      env: ENV,
    });
    await ch.respond('messenger', 'u1', 'rượu sâm còn không', { answer, db: asDb(db), env: ENV });
    expect(db.enqueued.length).toBe(1);
    expect(answer).not.toHaveBeenCalled();
  });

  it('respond: mã tính năng theo KÊNH (sàn sales-02, chat sales-01), không theo chữ khách', async () => {
    const seen: string[] = [];
    const answer: ch.AnswerFn = async (_q, o) => {
      seen.push(o.feature);
      return { answer: 'Dạ có.', sources: [] };
    };
    await ch.respond('zalo', 'u', 'feature=sales-02 giao hàng không?', { answer, env: ENV });
    await ch.respond('shopee', 'u', 'feature=sales-01 giao hàng không?', { answer, env: ENV });
    await ch.respond('messenger', 'u', 'giao hàng không?', { answer, env: ENV });
    await ch.respond('tiktok', 'u', 'giao hàng không?', { answer, env: ENV });
    expect(seen).toEqual(['sales-01', 'sales-02', 'sales-01', 'sales-02']);
  });
});

// --- consent ------------------------------------------------------------------

describe('consent', () => {
  const inb = (c = 'zalo', env: Record<string, string> = ENV) =>
    ch.normalize(c, 'u1', 'giá?', undefined, env);
  const prompt = () => ch.template('consent_prompt');

  it('sàn: không bao giờ đọc/ghi consent', async () => {
    const never = { query: () => Promise.reject(new Error('DB')) } as unknown as Db;
    for (const c of ch.SAN_CHANNELS) {
      const i = ch.normalize(c, 'u', 'Đồng ý', undefined, ENV);
      expect(ch.preRoute(i)).toBeNull();
      expect(await ch.recordConsent(i, 'granted', '', never)).toBeNull();
      expect(await ch.consentGate(i, never)).toEqual({ prefix: '', block: false, prompted: false });
    }
    await expect(ch.recordConsent(inb(), 'maybe', '', never)).rejects.toThrow(RangeError);
  });

  it('cờ tắt (mặc định): none → câu chào + prompted; prompted/granted → thường; withdrawn → chặn LLM', async () => {
    const db = new FakeDb();
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: prompt(),
      block: false,
      prompted: true,
    });
    await ch.recordConsent(inb(), 'prompted', 'm0', asDb(db));
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: '',
      block: false,
      prompted: false,
    });
    await ch.recordConsent(inb(), 'withdrawn', 'm1', asDb(db));
    // F03a bước 3: khách rút đồng ý → dừng LLM BẤT KỂ cờ, chỉ câu chào, không ghi prompted lại
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: prompt(),
      block: true,
      prompted: false,
    });
    await ch.recordConsent(inb(), 'granted', 'm2', asDb(db));
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: '',
      block: false,
      prompted: false,
    });
    expect(db.rows.map((r) => r[2])).toEqual(['prompted', 'withdrawn', 'granted']);
    const uh = ch.userHash('zalo', 'u1', ENV);
    expect(db.rows.every((r) => r[0] === uh && r[1] === 'zalo' && r[3] === 'nhap-2026-10')).toBe(
      true,
    );
    expect(db.rows[0]?.[4]).toBe(ch.ref('m0'));
  });

  it('cờ tắt + DB down / thiếu muối / lỗi DB → trả lời không tiền tố + [warn]', async () => {
    for (const [i, db] of [
      [inb(), null],
      [inb('zalo', NO_SALT), asDb(new FakeDb())],
      [inb(), asDb(new FakeDb(dbErr()))],
    ] as [ch.Inbound, Db | null][]) {
      expect(await ch.consentGate(i, db)).toEqual({ prefix: '', block: false, prompted: false });
    }
    expect(logs.filter((l) => l.startsWith('[warn]')).length).toBeGreaterThanOrEqual(3);
  });

  it('cờ bật: chưa granted (kể cả không biết) = chặn LLM (fail-closed), prompted chỉ lần đầu', async () => {
    cfgFile({ require_consent_for_llm: true });
    const db = new FakeDb();
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: prompt(),
      block: true,
      prompted: true,
    });
    await ch.recordConsent(inb(), 'prompted', '', asDb(db));
    expect(await ch.consentGate(inb(), asDb(db))).toEqual({
      prefix: prompt(),
      block: true,
      prompted: false,
    });
    await ch.recordConsent(inb(), 'granted', '', asDb(db));
    expect((await ch.consentGate(inb(), asDb(db))).block).toBe(false);
    for (const [i, d] of [
      [inb(), null],
      [inb('zalo', NO_SALT), asDb(new FakeDb())],
      [inb(), asDb(new FakeDb(dbErr()))],
    ] as [ch.Inbound, Db | null][]) {
      expect((await ch.consentGate(i, d)).block).toBe(true);
    }
  });

  it('recordConsent: thiếu muối / DB down / lỗi DB → null + warn (caller không gửi câu cam kết)', async () => {
    expect(
      await ch.recordConsent(inb('zalo', NO_SALT), 'withdrawn', '', asDb(new FakeDb())),
    ).toBeNull();
    expect(await ch.recordConsent(inb(), 'withdrawn', '', null)).toBeNull();
    expect(await ch.recordConsent(inb(), 'withdrawn', '', asDb(new FakeDb(dbErr())))).toBeNull();
    expect(
      logs.filter((l) => l.includes('không ghi đồng ý') || l.includes('ghi chat_consents lỗi'))
        .length,
    ).toBe(3);
  });

  it('chatChannels: gắn pool cho adapter chat (cùng hàm, db cố định)', async () => {
    const db = new FakeDb();
    const port = ch.chatChannels(asDb(db), ENV);
    const i = port.normalize('zalo', 'u1', 'giá?');
    expect(i.userHash).toBe(ch.userHash('zalo', 'u1', ENV));
    expect(await port.consentGate(i)).toEqual({ prefix: prompt(), block: false, prompted: true });
    expect(await port.recordConsent(i, 'prompted', 'm0')).toBe(1n);
    expect(await port.recordHandoff(i, 'health', 'm1')).toBe(101n);
    expect(port.template('san_fallback')).toBe(ch.template('san_fallback'));
  });

  it('chatbotMode: DB down → chay_thu (fail-closed)', async () => {
    setOpsDeps({ rollout: opsRollout });
    expect(await ch.chatbotMode(null)).toBe('chay_thu');
  });
});

// --- gợi ý cskh_reply / san_suggestions (P9.4, docx P1) -----------------------

const BOT_PII =
  'Dạ chị Nguyễn Thị Hoa ơi, shop giao tới 12 Lê Lợi, Hải Châu; chị gọi 0905123456 hoặc mail hoa.nguyen@example.com nhé.';
const LEAKS = ['Nguyễn', 'Hoa ơi', '12 Lê Lợi', '0905123456', 'hoa.nguyen'];
const inbP = (): ch.Inbound => ({
  channel: 'zalo',
  userHash: 'ab'.repeat(16),
  text: 'giá?',
  ts: '2026-10-16T08:00',
});

describe('gợi ý', () => {
  afterEach(() => setNamesFiles({ names: dataPath('vn_names.json') }));

  it('P9.4 recordSuggestion: payload che tên/địa chỉ/SĐT/email, raw khi câu có nguồn bị bắt', async () => {
    const db = new FakeDb();
    expect(await ch.recordSuggestion(inbP(), BOT_PII, 'm1', asDb(db))).toBe(101n);
    let payload = (db.enqueued[0] as string[])[4] as string;
    for (const l of LEAKS) expect(payload).not.toContain(l);
    expect(payload).toContain('***');
    expect(payload).toContain('Hải Châu'); // địa bàn thô giữ
    expect(
      await ch.recordSuggestion(
        inbP(),
        `${BOT_PII}\nNguồn: https://x/sam-chua-benh`,
        'm2',
        asDb(db),
        BOT_PII,
      ),
    ).toBe(102n);
    payload = (db.enqueued[1] as string[])[4] as string;
    expect(payload).not.toContain('Nguồn');
    for (const l of LEAKS) expect(payload).not.toContain(l);
    const [, oid, , title] = db.enqueued[0] as string[];
    expect([oid, title].join(' ')).not.toMatch(/giá\?/);
    expect(
      await ch.recordSuggestion({ ...inbP(), channel: 'shopee' }, 'x', 'm', asDb(db)),
    ).toBeNull();
    expect(await ch.recordSuggestion({ ...inbP(), userHash: null }, 'x', 'm', asDb(db))).toBeNull();
    expect(await ch.recordSuggestion(inbP(), 'Dạ hộp quà 6 năm ạ.', 'm3', null)).toBeNull();
  });

  it('P9.4 / docx P1: từ điển tên hỏng → KHÔNG ghi gợi ý (fail-closed)', async () => {
    setNamesFiles({ names: join(tmp, 'khong_co.json') });
    const db = new FakeDb();
    expect(await ch.recordSuggestion(inbP(), 'Dạ hộp quà 6 năm ạ.', 'm1', asDb(db))).toBeNull();
    expect(
      await ch.recordSanSuggestion(
        asDb(db),
        'shopee',
        'tin buyer',
        { answer: 'Dạ hộp quà ạ.' },
        'co_nguoi_duyet',
        'MXH Giả',
      ),
    ).toBeNull();
    expect(db.enqueued).toEqual([]);
  });

  it('docx P1 recordSanSuggestion: câu gợi ý đã che, không lưu tin buyer, luật kênh/giai đoạn', async () => {
    const db = new FakeDb();
    const buyer = 'giá hộp 6 năm bao nhiêu, gọi 0912345678 nhé';
    expect(
      await ch.recordSanSuggestion(
        asDb(db),
        'shopee',
        buyer,
        { answer: BOT_PII, handoff: 'no_data' },
        'co_nguoi_duyet',
        ' MXH Giả ',
      ),
    ).toBe(7n);
    const [chan, msgRef, answer, ho, ok, stage, by] = db.enqueued[0] as unknown[];
    for (const l of LEAKS) expect(answer).not.toContain(l);
    expect([chan, msgRef, ho, stage, by]).toEqual([
      'shopee',
      ch.suggestionRef(buyer),
      'no_data',
      'co_nguoi_duyet',
      'MXH Giả',
    ]);
    expect(typeof ok).toBe('boolean'); // guardrail/luật sàn chấm trên câu ĐÃ che
    expect(JSON.stringify(db.enqueued)).not.toContain('0912345678');
    // guardrail không đạt → ghi guardrail_ok=false (không dùng được)
    await ch.recordSanSuggestion(
      asDb(db),
      'tiktok',
      'x',
      { answer: 'Dạ sản phẩm chữa khỏi bệnh ạ' },
      'van_hanh',
      'Lan',
    );
    expect((db.enqueued[1] as unknown[])[4]).toBe(false);
    await ch.recordSanSuggestion(
      asDb(db),
      'tiktok',
      'x',
      { answer: 'Dạ còn hàng ạ', handoff: 'Bad-Code' },
      'van_hanh',
      'Lan',
    );
    expect((db.enqueued[2] as unknown[]).slice(3, 5)).toEqual([null, true]);
    expect(
      await ch.recordSanSuggestion(asDb(db), 'zalo', 'x', { answer: 'ok' }, 'van_hanh', 'Lan'),
    ).toBeNull();
    expect(
      await ch.recordSanSuggestion(asDb(db), 'shopee', 'x', { answer: 'ok' }, 'tat', 'Lan'),
    ).toBeNull();
    expect(
      await ch.recordSanSuggestion(asDb(db), 'shopee', 'x', { answer: '   ' }, 'van_hanh', 'Lan'),
    ).toBeNull();
    expect(
      await ch.recordSanSuggestion(null, 'shopee', 'x', { answer: 'ok' }, 'van_hanh', 'Lan'),
    ).toBeNull();
    expect(
      await ch.recordSanSuggestion(
        asDb(new FakeDb(dbErr())),
        'shopee',
        'x',
        { answer: 'ok' },
        'van_hanh',
        'Lan',
      ),
    ).toBeNull();
    expect(db.enqueued.length).toBe(3);
  });

  it('suggestionRef: cùng câu (khoảng trắng/hoa thường) = 1 khóa, không chứa tin', () => {
    expect(ch.suggestionRef('còn  hàng KHÔNG')).toBe(ch.suggestionRef('còn hàng không'));
    expect(ch.suggestionRef('gọi 0905 123 456')).toBe(ch.suggestionRef('gọi 0912 999 888'));
    expect(ch.suggestionRef('x')).toMatch(/^[0-9a-f]{32}$/);
  });
});

// --- CLI gợi ý sàn -------------------------------------------------------------

async function cli(
  argv: Record<string, unknown>,
  stdin: string,
  deps: Partial<Parameters<typeof channelsMain>[1]> = {},
): Promise<{ rc: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const rc = await channelsMain(argv as never, {
    answer: null,
    connect: async () => null,
    stdin: async () => stdin,
    env: ENV,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    ...deps,
  });
  return { rc, out: [...out, ...logs].join('\n'), err: err.join('\n') };
}

describe('CLI channels', () => {
  it.each([
    'Mua tại samsamngoclinh.com nhé',
    'Nhắn zalo.me/x để được tư vấn',
    'Gọi 0905123456 nhé',
    'Gọi 0905 123 456 nhé',
    'Theo dõi facebook.com/samsam',
    'Ghé cửa hàng tại 12 Lê Lợi',
  ])('--suggest: câu MXH dán sạch luật sàn (%s)', async (bad) => {
    const calls: [string, string][] = [];
    const answer: ch.AnswerFn = async (q, o) => {
      calls.push([q, o.feature]);
      return { answer: bad, sources: ['https://samsamngoclinh.com/x'] };
    };
    for (const c of ch.SAN_CHANNELS) {
      logs = [];
      const { rc, out } = await cli({ suggest: c, by: 'MXH probe' }, 'shop có Zalo không', {
        answer,
      });
      expect(rc).toBe(0);
      const lines = out.split('\n');
      const start = lines.findIndex((l) => l.startsWith('[GỢI Ý — NHÁP'));
      const body = lines
        .slice(start + 1)
        .filter(
          (l) => !l.startsWith('handoff=') && !l.startsWith('blocked=') && !l.startsWith('[warn]'),
        )
        .join('\n');
      expect(ch.sanViolations(body)).toEqual([]);
      expect(INDEP.test(body)).toBe(false);
      expect(out).toContain('[GỢI Ý — NHÁP');
      expect(
        body.includes(ch.template('san_fallback')) || body.includes(ch.template('san_handoff')),
      ).toBe(true);
    }
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c) => c[1]))).toEqual(new Set(['sales-02']));
  });

  it('--suggest rượu: template, không gọi answer()', async () => {
    const answer = vi.fn();
    const { rc, out } = await cli(
      { suggest: 'tiktok', by: 'probe' },
      'Shop có bán rượu sâm không?',
      { answer },
    );
    expect(rc).toBe(0);
    expect(out).toContain(ch.template('alcohol_san'));
    expect(out).toContain('handoff=alcohol');
    expect(answer).not.toHaveBeenCalled();
  });

  it('--suggest: SĐT/email buyer không bị in lại', async () => {
    const answer: ch.AnswerFn = async () => ({
      answer: 'Savina tuýp 12 viên: 159.000 đ.',
      sources: [],
    });
    const { rc, out } = await cli(
      { suggest: 'shopee', by: 'probe' },
      'Savina giá? gọi tôi 0905 123 456, an@gmail.com',
      {
        answer,
      },
    );
    expect(rc).toBe(0);
    expect(out).toContain('159.000');
    expect(out).not.toContain('0905');
    expect(out).not.toContain('an@gmail.com');
  });

  it('--suggest: answer() lỗi → câu chuyển nhân viên, chỉ tên lớp lỗi', async () => {
    class RuntimeError extends Error {}
    const answer: ch.AnswerFn = async () => {
      throw new RuntimeError('gateway chặn 0905123456');
    };
    const { rc, out } = await cli({ suggest: 'shopee', by: 'probe' }, 'giá Savina?', { answer });
    expect(rc).toBe(0);
    expect(out).toContain(ch.template('san_handoff'));
    expect(out).not.toContain('0905123456');
    expect(out).toContain('RuntimeError');
  });

  it('--suggest: chưa nối RAG (answer null) → vẫn có câu dán (chuyển nhân viên)', async () => {
    const { rc, out } = await cli({ suggest: 'shopee', by: 'probe' }, 'giá Savina?');
    expect(rc).toBe(0);
    expect(out).toContain(ch.template('san_handoff'));
  });

  it.each([
    [{ suggest: 'shopee' }, 'giá?'],
    [{ suggest: 'shopee', by: '  ' }, 'giá?'],
    [{ suggest: 'shopee', by: 'x'.repeat(101) }, 'giá?'],
    [{ suggest: 'shopee', by: 'a\nb' }, 'giá?'],
    [{ suggest: 'shopee', by: 'probe' }, '   \n'],
    [{ suggest: 'shopee', by: 'p', evalReal: true }, 'giá?'],
    [{}, 'giá?'],
    [{ suggest: 'zalo', by: 'p' }, 'giá?'],
    [{ evalReal: true, limit: '0' }, 'giá?'],
    [{ evalReal: true, limit: 'x' }, 'giá?'],
    [{ markSent: '1' }, ''],
    [{ markSent: '1', suggest: 'shopee', by: 'A' }, ''],
    [{ markSent: 'abc', by: 'A' }, ''],
    [{ markSent: '0', by: 'A' }, ''],
  ])('sai tham số %j → exit 2, không gọi answer()', async (argv, stdin) => {
    const answer = vi.fn();
    const connect = vi.fn(async () => null);
    const { rc, err } = await cli(argv, stdin, { answer, connect });
    expect(rc).toBe(2);
    expect(err).toContain('channels: error:');
    expect(answer).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('v13 F03: sales-02 TẮT → exit 2, không gọi AI; chạy thử → nhãn KHÔNG dán', async () => {
    const st = installFakeDeps({}, { quick: null, stages: { 'sales-02': 'tat' } });
    setOpsDeps({ guardrailCheck: (t) => check(t) });
    const respondFn = vi.fn(async () => ({
      answer: 'Dạ 1.000.000đ',
      route: null,
      handoff: null,
      blocked: [],
    }));
    let r = await cli({ suggest: 'shopee', by: 'Lan' }, 'giá bao nhiêu', { respondFn });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('[blocked] tính năng sales-02');
    expect(respondFn).not.toHaveBeenCalled();
    st.stages['sales-02'] = 'chay_thu';
    r = await cli({ suggest: 'shopee', by: 'Lan' }, 'giá bao nhiêu', { respondFn });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('CHẠY THỬ');
    expect(r.out).toContain('KHÔNG dán');
    expect(r.out).not.toContain('--mark-sent');
  });

  it('--mark-sent: DB down → exit 2', async () => {
    const r = await cli({ markSent: '5', by: 'Lan' }, '');
    expect(r.rc).toBe(2);
    expect(r.err).toContain('[FAIL] DB không kết nối được');
  });

  it('scoreCskh', () => {
    const c = {
      channel: 'shopee',
      expect: {
        route: null,
        handoff: null,
        text_regex: '^ok$',
        forbid_regex: 'xx',
        max_llm_calls: 1,
      },
    };
    const good = { answer: 'ok', route: null, handoff: null, llm_calls: 1 };
    expect(ch.scoreCskh(c, good)).toEqual([true, '']);
    expect(ch.scoreCskh(c, { ...good, llm_calls: 2 })[0]).toBe(false);
    expect(ch.scoreCskh(c, { ...good, handoff: 'no_data' })[0]).toBe(false);
    expect(ch.scoreCskh({ ...c, expect: { route: null } }, { ...good, answer: 'zalo.me' })[0]).toBe(
      false,
    );
    expect(ch.scoreCskh(c, { ...good, answer: 'khác', llm_calls: 9, handoff: 'x' }, false)).toEqual(
      [true, ''],
    );
  });

  it('--eval-real: thiếu answer() → exit 1 [external-dep]; xen kẽ loại; vượt trần chi phí → exit 1', async () => {
    const respondFn = vi.fn();
    let r = await cli({ evalReal: true, limit: '8' }, '', { respondFn });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('[external-dep]');
    expect(respondFn).not.toHaveBeenCalled();
    const seen: string[] = [];
    const fake = async (c: string) => {
      seen.push(c);
      return { answer: 'Dạ có.', route: null, handoff: null, blocked: [] };
    };
    const answer: ch.AnswerFn = async () => ({ answer: 'x' });
    r = await cli({ evalReal: true }, '', { answer, respondFn: fake as never });
    expect(r.rc).toBe(0);
    expect(seen.length).toBe(8);
    expect(seen.filter((c) => ch.SAN_CHANNELS.includes(c)).length).toBeGreaterThanOrEqual(4);
    const costly = {
      query: async (sql: string) =>
        sql.includes('llm_usage')
          ? { rows: [{ cost: '0.06', n: '3' }] }
          : { rows: [{ now: new Date() }] },
    } as unknown as Db;
    r = await cli({ evalReal: true, limit: '2' }, '', {
      answer,
      respondFn: fake as never,
      connect: async () => ({ db: costly, release: async () => {} }),
    });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('VƯỢT TRẦN');
  });
});

// --- DB THẬT (container test, DB riêng samsam_ts_channels) ---------------------

const DB_NAME = 'samsam_ts_channels';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('DB thật', () => {
  let pool: pg.Pool;
  beforeEach(async () => {
    await dropDb(DB_NAME);
    pool = createPool(await createDbFromTemplate(DB_NAME));
    wireSecurity(null);
    setOpsDeps({ rollout: opsRollout });
    roSettings.forceMode = null;
  });
  afterEach(async () => {
    await pool?.end();
    await dropDb(DB_NAME);
  });
  afterAll(() => {
    roSettings.forceMode = null;
  });

  const stage = (fid: string, st: string) =>
    pool.query(
      "insert into feature_rollout (feature_id, stage, updated_by) values ($1, $2, 'Test')" +
        ' on conflict (feature_id) do update set stage = excluded.stage',
      [fid, st],
    );
  const n = async (t: string) =>
    Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n);

  it('chat_consents: append-only, dòng mới nhất theo id, view, CHECK', async () => {
    const inb = ch.normalize('zalo', 'u-db', 'x', undefined, ENV);
    const other = ch.normalize('messenger', 'u-db', 'x', undefined, ENV);
    const acts = ['prompted', 'granted', 'withdrawn'];
    for (const [i, a] of acts.entries()) {
      expect(typeof (await ch.recordConsent(inb, a, `m${i}`, pool))).toBe('bigint');
    }
    await ch.recordConsent(other, 'granted', '', pool);
    // Dòng MỚI NHẤT theo id — order by asc sẽ ra 'prompted' (rút không ăn).
    expect(await ch.consentState(pool, 'zalo', inb.userHash as string)).toBe('withdrawn');
    expect(await ch.consentState(pool, 'messenger', other.userHash as string)).toBe('granted');
    expect(await ch.consentState(pool, 'messenger', inb.userHash as string)).toBe('none');
    expect(await ch.consentState(pool, 'zalo', 'f'.repeat(32))).toBe('none');
    const view = await pool.query(
      'select user_hash, channel, action from v_chat_consent_current order by channel',
    );
    expect(view.rows).toEqual([
      { user_hash: other.userHash, channel: 'messenger', action: 'granted' },
      { user_hash: inb.userHash, channel: 'zalo', action: 'withdrawn' },
    ]);
    const row = await pool.query(
      "select policy_version, evidence_ref, purpose from chat_consents where action = 'prompted'",
    );
    expect(row.rows[0]).toEqual({
      policy_version: 'nhap-2026-10',
      evidence_ref: ch.ref('m0'),
      purpose: 'tu_van_chat',
    });
    for (const sql of [
      "update chat_consents set action = 'granted'",
      'delete from chat_consents',
      'truncate chat_consents',
    ]) {
      await expect(pool.query(sql)).rejects.toThrow(/append-only/);
    }
    const ins =
      'insert into chat_consents (user_hash, channel, action, policy_version) values ($1, $2, $3, $4)';
    for (const bad of [
      ['abc', 'zalo', 'granted', 'v1'],
      [inb.userHash, 'shopee', 'granted', 'v1'],
      [inb.userHash, 'zalo', 'granted', ' '],
      [inb.userHash, 'zalo', 'maybe', 'v1'],
    ]) {
      await expect(pool.query(ins, bad)).rejects.toMatchObject({ code: '23514' });
    }
    expect(await n('chat_consents')).toBe(4);
  });

  it('handoff + gợi ý cskh_reply ghi THẬT vào hàng duyệt khối sales, không PII; trùng mục chờ → id cũ', async () => {
    const inb = ch.normalize('zalo', 'u1', 'giá?', undefined, ENV);
    const id = await ch.recordHandoff(inb, 'health', 'm1', pool);
    expect(id).not.toBeNull();
    const again = await ch.recordHandoff(inb, 'no_data', 'm2', pool);
    expect(again).toBe(id);
    const sid = await ch.recordSuggestion(inbP(), BOT_PII, 'm1', pool);
    const r = await pool.query(
      "select block, object_type, created_by, payload, title, object_id, coalesce(guardrail->>'ok', '') as ok from approval_queue where id = $1",
      [String(sid)],
    );
    const row = r.rows[0];
    expect([row.block, row.object_type, row.created_by, row.ok]).toEqual([
      'sales',
      'cskh_reply',
      'agent:kd_a1',
      'true',
    ]);
    for (const l of LEAKS) {
      expect(row.payload).not.toContain(l);
      expect(row.title).not.toContain(l);
      expect(row.object_id).not.toContain(l);
    }
  });

  it('sales-02: ghi đầu ra theo giai đoạn, đánh dấu đã gửi chỉ khi cho dùng + người thật', async () => {
    const respondFn = async () => ({
      answer: 'Dạ hộp quà sâm 6 năm có sẵn ạ, shop gửi ngay.',
      route: null,
      handoff: null,
      blocked: [],
    });
    const run = (argv: Record<string, unknown>, stdin = '') =>
      cli(argv, stdin, { respondFn, connect: async () => ({ db: pool, release: async () => {} }) });
    const msg = 'giá hộp 6 năm bao nhiêu, gọi 0912345678 nhé';
    await stage('sales-02', 'chay_thu');
    let r = await run({ suggest: 'shopee', by: 'Lan MXH' }, msg);
    expect(r.rc).toBe(0);
    expect(r.out).toContain('chưa được dùng');
    expect(r.out).not.toContain('--mark-sent');
    const s1 = (
      await pool.query(
        'select id, msg_ref, stage, created_by, to_jsonb(s) as j from san_suggestions s',
      )
    ).rows[0];
    expect([s1.stage, s1.created_by, s1.msg_ref]).toEqual([
      'chay_thu',
      'Lan MXH',
      ch.suggestionRef(msg),
    ]);
    expect(JSON.stringify(s1.j)).not.toMatch(/0912345678|hộp 6 năm bao/);
    // chạy thử: không đánh dấu đã gửi được — kể cả sau khi lên vận hành
    expect((await run({ markSent: String(s1.id), by: 'Lan MXH' })).rc).toBe(1);
    await stage('sales-02', 'van_hanh');
    r = await run({ markSent: String(s1.id), by: 'Lan MXH' });
    expect(r.rc).toBe(1);
    expect(r.err).toContain('CHẠY THỬ');
    // vận hành: soạn mới → đánh dấu được (1 lần), agent không đánh dấu
    r = await run({ suggest: 'tiktok', by: 'Lan MXH' }, 'còn hàng không');
    expect(r.out).toContain('--mark-sent');
    const sid2 = String((await pool.query('select max(id) as m from san_suggestions')).rows[0].m);
    expect((await run({ markSent: sid2, by: 'agent:kd_a1' })).rc).toBe(1);
    expect((await run({ markSent: sid2, by: 'Lan MXH' })).rc).toBe(0);
    r = await run({ markSent: sid2, by: 'Lan MXH' });
    expect([r.rc, r.err.includes('[skip]')]).toEqual([0, true]);
    expect(await n('san_suggestion_uses')).toBe(1);
    // tắt: không gọi AI, không ghi, không đánh dấu
    await stage('sales-02', 'tat');
    const before = await n('san_suggestions');
    expect((await run({ suggest: 'shopee', by: 'Lan MXH' }, 'x')).rc).toBe(2);
    expect(await n('san_suggestions')).toBe(before);
    expect((await run({ markSent: sid2, by: 'Lan MXH' })).rc).toBe(1);
    await expect(pool.query("update san_suggestions set answer = 'x'")).rejects.toThrow();
  });

  it('sales-02: guardrail không đạt / id không có → từ chối đánh dấu', async () => {
    await stage('sales-02', 'van_hanh');
    const respondFn = async () => ({
      answer: 'Dạ sản phẩm chữa khỏi bệnh ạ',
      route: null,
      handoff: null,
      blocked: [],
    });
    const deps = { respondFn, connect: async () => ({ db: pool, release: async () => {} }) };
    expect((await cli({ suggest: 'shopee', by: 'Lan MXH' }, 'có tốt không', deps)).rc).toBe(0);
    const bad = (await pool.query('select id, guardrail_ok from san_suggestions')).rows[0];
    expect(bad.guardrail_ok).toBe(false);
    expect((await cli({ markSent: String(bad.id), by: 'Lan MXH' }, '', deps)).rc).toBe(1);
    expect((await cli({ markSent: '999999', by: 'Lan MXH' }, '', deps)).rc).toBe(1);
    expect(await n('san_suggestion_uses')).toBe(0);
  });
});

// --- module NestJS ---------------------------------------------------------------

describe('ChannelsModule', () => {
  it('đăng ký 2 lệnh; RAG_ANSWER tùy chọn (thiếu → null, có → tiêm)', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ChannelsModule } = await import('./channels.module.js');
    const { B2bFormCommand, ChannelsCommand, RAG_ANSWER } = await import('./channels.command.js');
    const mod = await Test.createTestingModule({ imports: [ChannelsModule] }).compile();
    expect(mod.get(B2bFormCommand)).toBeInstanceOf(B2bFormCommand);
    expect((mod.get(ChannelsCommand) as unknown as { answer: unknown }).answer).toBeNull();
    const answer: ch.AnswerFn = async () => ({ answer: 'x' });
    const withRag = await Test.createTestingModule({
      providers: [ChannelsCommand, { provide: RAG_ANSWER, useValue: answer }],
    }).compile();
    expect((withRag.get(ChannelsCommand) as unknown as { answer: unknown }).answer).toBe(answer);
  });
});
