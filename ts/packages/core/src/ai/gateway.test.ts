import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile } from '../config.js';
import type { Queryable } from '../db.js';
import { dataPath } from '../paths.js';
import { maskIdentity, maskPii, PII_RE } from '../security/pii.js';
import gold from './__fixtures__/gateway.golden.json' with { type: 'json' };
import maskGold from './__fixtures__/mask.golden.json' with { type: 'json' };
import {
  AiGateway,
  type AiPolicy,
  allowAddr,
  allowSet,
  cloudProblem,
  GatewayBlocked,
  type GatewayDeps,
  GatewayError,
  maskText,
  normContact,
  pyFloat,
  vnDate,
} from './gateway.js';
import type { AnthropicFactory } from './providers.js';

// Dịch từ tests/test_llm_gateway.py + test_contract_finalize.py (cổng tính năng) + test_r12_dot2.py
// (rollout tắt). Nhà cung cấp GIẢ: server HTTP kiểu Ollama trên 127.0.0.1 + SDK Anthropic giả.

const PHONE_RE = /0\d{9}|\+84\d{8,}|0\d{3}[ .]\d{3}[ .]\d{3}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.\w+/;
// Che PII GIẢ cho test (bản thật = port pipelines/pii.py của nhóm security, truyền ở tích hợp).
const FAKE_PII = /(?:\+84|0)\d(?:[ .]?\d){8,}|[\w.+-]+@[\w-]+(?:\.\w+)+/g;
const fakeMask = (s: string) => s.replace(FAKE_PII, '***');

type Req = { path: string; body: Record<string, unknown> };
let server: Server;
let base = '';
let reqs: Req[] = [];
let mode: 'ok' | 'fail' | 'slow' | 'baddim' = 'ok';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
    });
    req.on('end', () => ok(s));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    reqs.push({ path: req.url ?? '', body });
    if (mode === 'fail') {
      res.writeHead(500).end('{"error":"model down"}');
      return;
    }
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/chat') {
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      );
    } else {
      const n = Array.isArray(body.input) ? body.input.length : 1;
      const dim = mode === 'baddim' ? 3 : 1024;
      res.end(
        JSON.stringify({
          embeddings: Array.from({ length: n }, () => Array(dim).fill(0.5)),
          prompt_eval_count: 7,
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const GW_CFG = {
  provider_only: ['azure'],
  prices_usd_per_1m: { m: { in: 1.0, out: 2.0 } },
  monthly_cap_usd: { default: 10.0, chatbot: 1.0 },
  kill: [],
};
const POLICY: AiPolicy = {
  local: { provider: 'ollama', chat_model: 'm', embed_model: 'e', embed_dim: 1024, timeout_s: 30 },
  cloud: {
    provider: 'claude',
    model: 'claude-test',
    max_tokens: 256,
    price_usd_per_1m: { in: 3, out: 15 },
  },
  prices_usd_per_1m: { e: { in: 0, out: 0 } },
  features: {},
};

let dir = '';
let rows: unknown[][] = [];
let spend: Record<string, number> = {};
let featureSpend: Record<string, number> = {};
let stage: Record<string, string> = {};
let warns: string[] = [];
let sdkCalls: { opts: unknown; body: Record<string, unknown> }[] = [];

const asPool = (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
  q as unknown as Queryable;
const pool = asPool({
  async query(sql: string, params: unknown[] = []) {
    if (sql.startsWith('insert')) {
      rows.push(params);
      return { rows: [] };
    }
    const src = sql.includes('feature_id = $1') ? featureSpend : spend;
    const k = params[0] as string;
    return { rows: [{ spend: String(Object.hasOwn(src, k) ? src[k] : 0) }] };
  },
});
const anthropic: AnthropicFactory = (opts) => ({
  messages: {
    async create(body) {
      sdkCalls.push({ opts, body });
      return {
        content: [{ type: 'text', text: 'claude ok' }],
        usage: { input_tokens: 4, output_tokens: 2 },
      };
    },
  },
});

function writeCfg(over: Record<string, unknown> = {}, policy: Partial<AiPolicy> = {}) {
  writeFileSync(join(dir, 'llm_gateway.json'), JSON.stringify({ ...GW_CFG, ...over }));
  writeFileSync(join(dir, 'ai_policy.json'), JSON.stringify({ ...POLICY, ...policy }));
}

function deps(over: Partial<GatewayDeps> = {}, env: Record<string, string> = {}): GatewayDeps {
  return {
    pool,
    maskPii: fakeMask,
    maskIdentity: (s) => s,
    piiRe: FAKE_PII,
    rolloutMode: async (_q, f) => stage[f] ?? 'chay_thu',
    env: { OLLAMA_URL: base, ANTHROPIC_API_KEY: 'test-key', ...env },
    files: { gateway: join(dir, 'llm_gateway.json'), policy: join(dir, 'ai_policy.json') },
    anthropic,
    warn: (m) => warns.push(m),
    ...over,
  };
}
const gw = (over: Partial<GatewayDeps> = {}, env: Record<string, string> = {}) =>
  new AiGateway(deps(over, env));

const MSG = [{ role: 'user' as const, content: 'hi' }];
const F = { feature: 'sales-03' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-'));
  writeCfg();
  [reqs, rows, warns, sdkCalls] = [[], [], [], []];
  [spend, featureSpend, stage] = [{}, {}, {}];
  mode = 'ok';
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('che PII + tham số gửi Ollama', () => {
  it('mọi message (system/history/assistant/parts/user) + embed str/list đều che', async () => {
    const pii = 'gọi 0901234567 hoặc +84901234567, 0901 234 567, mail a.b@x.vn';
    const g = gw();
    await g.chat(
      'chatbot',
      [
        { role: 'system', content: `sys ${pii}` },
        { role: 'user', content: `hist ${pii}` },
        { role: 'assistant', content: `ans ${pii}` },
        { role: 'user', content: [{ type: 'text', text: `part ${pii}` }] },
        { role: 'user', content: `q ${pii}` },
      ],
      { ...F, model: 'm' },
    );
    await g.embed('ingest', `e ${pii}`, F);
    await g.embed('ingest', [`l1 ${pii}`, `l2 ${pii}`], F);
    const out = JSON.stringify(reqs.map((r) => r.body));
    expect(reqs).toHaveLength(3);
    expect(PHONE_RE.test(out), out).toBe(false);
    expect(EMAIL_RE.test(out), out).toBe(false);
    for (const k of ['sys', 'hist', 'part', 'l1', 'l2']) expect(out).toContain(k);
  });

  it('body Ollama đúng: không stream, think=false, model mặc định theo chính sách', async () => {
    const r = await gw().chat('chatbot', MSG, { ...F, temperature: 0, seed: 7, maxTokens: 50 });
    expect(r).toEqual({ text: 'ok', model: 'm', provider: 'ollama', tokensIn: 10, tokensOut: 5 });
    expect(reqs[0]).toEqual({
      path: '/api/chat',
      body: {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        think: false,
        options: { temperature: 0, seed: 7, num_predict: 50 },
      },
    });
    const e = await gw().embed('ingest', ['a', 'b'], F);
    expect(e.embeddings).toHaveLength(2);
    expect(e.embeddings[0]).toHaveLength(1024);
    expect(reqs[1]).toEqual({ path: '/api/embed', body: { model: 'e', input: ['a', 'b'] } });
  });

  it('pii_allow giữ liên hệ công khai, số dài hơn vẫn che, NUL bị bỏ', async () => {
    writeCfg({ pii_allow: ['0235 3699 899', 'vnsamsam@gmail.com'] });
    await gw().chat(
      'chatbot',
      [
        { role: 'system', content: 'Hotline: 0235.3699.899 / VNsamsam@gmail.com' },
        { role: 'user', content: 'tôi 0901234567, a@b.vn, 0235 3699 899 123 \x00j\x00 \x00a\x00' },
      ],
      F,
    );
    const msgs = reqs[0].body.messages as { content: string }[];
    expect(msgs[0].content).toContain('0235.3699.899');
    expect(msgs[0].content).toContain('VNsamsam@gmail.com');
    const u = msgs[1].content;
    expect(u).not.toContain('0901234567');
    expect(u).not.toContain('a@b.vn');
    expect(u).not.toContain('3699'); // số dài hơn allow → vẫn che trọn
    expect(u).not.toContain('\x00');
  });
});

describe('fail-closed cấu hình / nhà cung cấp', () => {
  it('thiếu / hỏng llm_gateway.json hoặc ai_policy.json → GatewayError, 0 lời gọi', async () => {
    rmSync(join(dir, 'llm_gateway.json'));
    await expect(gw().chat('chatbot', MSG, F)).rejects.toThrow(GatewayError);
    writeFileSync(join(dir, 'llm_gateway.json'), '{');
    await expect(gw().chat('chatbot', MSG, F)).rejects.toThrow(GatewayError);
    writeCfg();
    writeFileSync(
      join(dir, 'ai_policy.json'),
      JSON.stringify({ ...POLICY, local: { provider: 'openai' } }),
    );
    await expect(gw().embed('ingest', 'x', F)).rejects.toThrow(/chính sách AI/);
    expect(reqs).toEqual([]);
  });

  it('lỗi nhà cung cấp: đúng 1 lời gọi, 1 dòng llm_usage ok=false đã che PII', async () => {
    mode = 'fail';
    await expect(gw().chat('chatbot', MSG, { ...F, model: 'm' })).rejects.toThrow(
      /LLM provider lỗi \(ProviderError\)/,
    );
    expect(reqs).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 6)).toEqual(['chatbot', 'm', 0, 0, 0, false]);
    expect(rows[0][6]).toBe('ProviderError: HTTP 500');
    expect(rows[0][7]).toBe('sales-03');
  });

  it('OLLAMA_URL thiếu / trỏ máy công cộng → GatewayError, không gửi, không ghi', async () => {
    await expect(gw({}, { OLLAMA_URL: '' }).chat('chatbot', MSG, F)).rejects.toThrow(
      'thiếu OLLAMA_URL',
    );
    await expect(
      gw({}, { OLLAMA_URL: 'https://ollama.com' }).chat('chatbot', MSG, F),
    ).rejects.toThrow(/máy nội bộ/);
    await expect(
      gw({}, { OLLAMA_URL: 'http://8.8.8.8:11434' }).embed('ingest', 'x', F),
    ).rejects.toThrow(/máy nội bộ/);
    expect(reqs).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('model đám mây của Ollama bị chặn', async () => {
    await expect(gw().chat('chatbot', MSG, { ...F, model: 'gpt-oss:120b-cloud' })).rejects.toThrow(
      GatewayBlocked,
    );
    expect(reqs).toEqual([]);
  });

  it('embedding sai số chiều → lỗi có ghi, fail-closed', async () => {
    mode = 'baddim';
    await expect(gw().embed('ingest', 'x', F)).rejects.toThrow(GatewayError);
    expect(rows[0][5]).toBe(false);
  });

  it('hạn (deadline): đã hết → không gọi; quá hạn khi chờ → TimeoutError ghi lỗi', async () => {
    await expect(gw().chat('chatbot', MSG, { ...F, deadline: Date.now() - 1 })).rejects.toThrow(
      /deadline/,
    );
    expect(reqs).toEqual([]);
    mode = 'slow';
    await expect(gw().chat('chatbot', MSG, { ...F, deadline: Date.now() + 200 })).rejects.toThrow(
      /TimeoutError/,
    );
    expect(rows[0][5]).toBe(false);
  });
});

describe('llm_usage + chi phí', () => {
  it('dòng ok: agent, model, token, cost theo giá, feature', async () => {
    await gw().chat('content', MSG, { ...F, model: 'm' });
    expect(rows[0]).toEqual([
      'content',
      'm',
      10,
      5,
      (10 * 1.0 + 5 * 2.0) / 1e6,
      true,
      null,
      'sales-03',
    ]);
  });

  it('model chưa có giá → tính theo giá cao nhất + cảnh báo; model nội bộ giá 0', async () => {
    await gw().chat('content', MSG, { ...F, model: 'unknown' });
    await gw().chat('content', MSG, { ...F, model: 'm' });
    await gw().embed('content', 'x', F);
    expect(rows[0][4]).toBeGreaterThan(0);
    expect(rows[0][4] as number).toBeGreaterThanOrEqual(rows[1][4] as number);
    expect(rows[2][4]).toBe(0);
    expect(warns.join('\n')).toContain('chưa có giá');
  });

  it('DB down / không có pool → GatewayBlocked "không đọc được chi tiêu", 0 lời gọi', async () => {
    const boom = asPool({ query: async () => Promise.reject(new Error('db down')) });
    await expect(gw({ pool: boom }).chat('chatbot', MSG, F)).rejects.toThrow(
      /không đọc được chi tiêu/,
    );
    expect(warns.join('\n')).toContain('chặn lời gọi');
    await expect(gw({ pool: null }).embed('ingest', 'x', F)).rejects.toThrow(GatewayBlocked);
    expect(reqs).toEqual([]);
  });

  it('ghi usage lỗi sau khi đã gọi → kết quả vẫn trả, chỉ cảnh báo', async () => {
    const p = asPool({
      query: async (sql: string) =>
        sql.startsWith('insert') ? Promise.reject(new Error('x')) : { rows: [{ spend: '0' }] },
    });
    const r = await gw({ pool: p }).chat('chatbot', MSG, { ...F, model: 'm' });
    expect(r.text).toBe('ok');
    expect(reqs).toHaveLength(1);
    expect(warns.join('\n')).toContain('ghi llm_usage lỗi');
  });
});

describe('kill-switch + trần agent', () => {
  it('kill theo config và env LLM_KILL; agent khác không ảnh hưởng', async () => {
    writeCfg({ kill: ['content'] });
    await expect(gw().chat('content', MSG, F)).rejects.toThrow(GatewayBlocked);
    const g = gw({}, { LLM_KILL: 'chatbot, ingest' });
    await expect(g.chat('chatbot', MSG, F)).rejects.toThrow(GatewayBlocked);
    await expect(g.embed('ingest', 'x', F)).rejects.toThrow(GatewayBlocked);
    expect(reqs).toEqual([]);
    await g.chat('other', MSG, { ...F, model: 'm' });
    expect(reqs).toHaveLength(1);
  });

  it('trần 100% chặn, 80% cảnh báo vẫn gọi, agent khác OK', async () => {
    spend = { chatbot: 1.0 };
    await expect(gw().chat('chatbot', MSG, F)).rejects.toThrow(/vượt trần tháng 1.0000\/1.00 USD/);
    expect(reqs).toEqual([]);
    await gw().chat('content', MSG, F);
    spend.chatbot = 0.8;
    await gw().chat('chatbot', MSG, F);
    expect(reqs).toHaveLength(2);
    expect(warns.join('\n')).toContain('>=80%');
  });

  it('trần 0 = tắt (trước khi đọc DB); LLM_CAP_DEFAULT_USD sai → GatewayError', async () => {
    writeCfg({ monthly_cap_usd: { default: 10, content: 0 } });
    await expect(gw({ pool: null }).chat('content', MSG, F)).rejects.toThrow(/trần 0 USD/);
    await expect(gw({}, { LLM_CAP_DEFAULT_USD: 'abc' }).chat('x', MSG, F)).rejects.toThrow(
      'LLM_CAP_DEFAULT_USD không phải số',
    );
    writeCfg({ monthly_cap_usd: { default: 10, content: 'nhiều' } });
    await expect(gw().chat('content', MSG, F)).rejects.toThrow(/không phải số/);
  });

  it('agent_id không hợp lệ (gồm __proto__ không đọc nhầm prototype)', async () => {
    for (const bad of ['', 'Chat Bot', 'x'.repeat(65), null, 'chatbot\n']) {
      await expect(gw().chat(bad as string, MSG, F)).rejects.toThrow(GatewayError);
    }
    await gw().chat('__proto__', MSG, F); // dùng trần default
    expect(reqs).toHaveLength(1);
  });
});

describe('cổng theo tính năng (PL01 Cổng AI an toàn)', () => {
  it('trần tính năng chặn đúng tính năng đó', async () => {
    writeCfg({ feature_caps_usd: { default: 5.0, 'intel-01.1': 1.0 } });
    featureSpend = { 'intel-01.1': 1.0 };
    await expect(gw().chat('intel', MSG, { feature: 'intel-01.1' })).rejects.toThrow(/intel-01.1/);
    expect(reqs).toEqual([]);
    await gw().chat('intel', MSG, { feature: 'intel-03' });
    expect(reqs).toHaveLength(1);
  });

  it('nút tắt tính năng theo config và env', async () => {
    writeCfg({ kill_features: ['sales-01'] });
    await expect(gw().chat('chatbot', MSG, { feature: 'sales-01' })).rejects.toThrow(/nút tắt/);
    writeCfg({ kill_features: [] });
    const g = gw({}, { LLM_KILL_FEATURES: 'marketing-01.1' });
    await expect(g.chat('content', MSG, { feature: 'marketing-01.1' })).rejects.toThrow(
      GatewayBlocked,
    );
    await g.chat('content', MSG, { feature: 'sales-03' });
    expect(reqs).toHaveLength(1);
  });

  it.each(['', 'sales', 'SALES-01', 'sales-1', 3, 'sales-01; drop', undefined])(
    'feature sai/thiếu %s → GatewayError',
    async (bad) => {
      await expect(gw().chat('content', MSG, { feature: bad as string })).rejects.toThrow(
        /feature/,
      );
      expect(reqs).toEqual([]);
    },
  );

  it('trần tính năng 0 / không đọc được chi tiêu tính năng → chặn', async () => {
    writeCfg({ feature_caps_usd: { default: 5.0, 'ceo-01': 0 } });
    await expect(gw().chat('cockpit', MSG, { feature: 'ceo-01' })).rejects.toThrow(/trần 0/);
    const p = asPool({
      query: async (sql: string) =>
        sql.includes('feature_id = $1') ? Promise.reject(new Error('x')) : { rows: [{ spend: 0 }] },
    });
    await expect(gw({ pool: p }).chat('cockpit', MSG, { feature: 'intel-03' })).rejects.toThrow(
      /fail-closed/,
    );
    expect(reqs).toEqual([]);
  });

  it('tính năng TẮT ở sổ triển khai → chặn trước khi gọi AI', async () => {
    stage = { 'marketing-02.2': 'tat' };
    await expect(gw().chat('content', MSG, { feature: 'marketing-02.2' })).rejects.toThrow(/TẮT/);
    expect(reqs).toEqual([]);
  });
});

describe('cloud (Claude) chỉ khi ai_policy.json cho phép', () => {
  const ok = {
    cloud: true,
    approved_by: 'Nguyễn Văn A',
    approved_until: '2027-01-11',
    data_classes: ['xanh' as const],
  };
  const now = () => new Date('2026-10-29T03:00:00Z');
  const C = { feature: 'sales-03', provider: 'claude' as const, dataClass: 'xanh' as const };

  it('mặc định: tính năng không có trong chính sách → chặn, SDK không được gọi, không về local', async () => {
    await expect(gw({ now }).chat('chatbot', MSG, C)).rejects.toThrow(/không được phép gọi cloud/);
    expect(sdkCalls).toEqual([]);
    expect(reqs).toEqual([]);
  });

  it('đủ phê duyệt → SDK: model theo chính sách, maxRetries 0, baseURL cố định, system tách riêng', async () => {
    writeCfg({}, { features: { 'sales-03': ok } });
    const r = await gw({ now }).chat(
      'chatbot',
      [{ role: 'system', content: 'sys 0901234567' }, ...MSG],
      { ...C, temperature: 0 },
    );
    expect(r).toEqual({
      text: 'claude ok',
      model: 'claude-test',
      provider: 'claude',
      tokensIn: 4,
      tokensOut: 2,
    });
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0].opts).toMatchObject({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
    });
    expect(sdkCalls[0].body).toEqual({
      model: 'claude-test',
      max_tokens: 256,
      system: 'sys ***',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });
    expect(rows[0]).toEqual([
      'chatbot',
      'claude-test',
      4,
      2,
      (4 * 3 + 2 * 15) / 1e6,
      true,
      null,
      'sales-03',
    ]);
    expect(reqs).toEqual([]);
  });

  it.each([
    ['hết hạn', { ...ok, approved_until: '2026-10-28' }, 'xanh', /hết hạn/],
    ['người duyệt là agent', { ...ok, approved_by: 'agent:mkt02' }, 'xanh', /người phê duyệt/],
    ['thiếu người duyệt', { ...ok, approved_by: '  ' }, 'xanh', /người phê duyệt/],
    ['ngày sai', { ...ok, approved_until: '2027-02-30' }, 'xanh', /approved_until/],
    ['lớp dữ liệu ngoài phê duyệt', ok, 'do', /lớp dữ liệu 'do'/],
    ['không khai lớp dữ liệu', ok, undefined, /lớp dữ liệu/],
    ['cloud=false', { ...ok, cloud: false }, 'xanh', /không được phép/],
  ])('%s → chặn', async (_n, entry, dc, msg) => {
    writeCfg({}, { features: { 'sales-03': entry } });
    await expect(
      gw({ now }).chat('chatbot', MSG, { ...C, dataClass: dc as 'xanh' }),
    ).rejects.toThrow(msg);
    expect(sdkCalls).toEqual([]);
  });

  it('hạn tính theo ngày giờ VN (23:30 UTC ngày 10/01 = 06:30 ngày 11/01 VN)', () => {
    const p: AiPolicy = {
      ...POLICY,
      features: { 'sales-03': { ...ok, approved_until: '2027-01-10' } },
    };
    expect(cloudProblem(p, 'sales-03', 'xanh', '2027-01-10')).toBeNull();
    expect(cloudProblem(p, 'sales-03', 'xanh', '2027-01-11')).toMatch(/hết hạn/);
    expect(vnDate(new Date('2027-01-10T16:59:59Z'))).toBe('2027-01-10');
    expect(vnDate(new Date('2027-01-10T23:30:00Z'))).toBe('2027-01-11');
  });

  it('model cloud chưa có giá / thiếu ANTHROPIC_API_KEY / embed cloud / đổi model → không gọi', async () => {
    writeCfg(
      {},
      { features: { 'sales-03': ok }, cloud: { ...POLICY.cloud, price_usd_per_1m: null } },
    );
    await expect(gw({ now }).chat('chatbot', MSG, C)).rejects.toThrow(/chưa có giá/);
    writeCfg({}, { features: { 'sales-03': ok } });
    await expect(gw({ now }, { ANTHROPIC_API_KEY: '' }).chat('chatbot', MSG, C)).rejects.toThrow(
      'thiếu ANTHROPIC_API_KEY',
    );
    await expect(gw({ now }).embed('ingest', 'x', C)).rejects.toThrow(/embedding/);
    await expect(gw({ now }).chat('chatbot', MSG, { ...C, model: 'claude-opus' })).rejects.toThrow(
      /model cloud/,
    );
    expect(sdkCalls).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('KHÔNG fallback local → cloud: Ollama lỗi thì không gọi Claude dù được phép', async () => {
    writeCfg({}, { features: { 'sales-03': ok } });
    mode = 'fail';
    await expect(gw({ now }).chat('chatbot', MSG, F)).rejects.toThrow(GatewayError);
    expect(sdkCalls).toEqual([]);
  });
});

describe('golden Python + cấu hình thật', () => {
  it('_norm_contact / _allow / _allow_addr / regex agent + feature', () => {
    const cfg = readJsonFile<{ pii_allow: unknown }>(dataPath('llm_gateway.json'));
    expect([...allowSet(cfg.pii_allow)].sort()).toEqual(gold.allow);
    expect(allowAddr(cfg.pii_allow)).toEqual(gold.allow_addr);
    for (const [s, want] of gold.norm_contact) expect(normContact(s), s).toBe(want);
    const agentRe = /^[a-z0-9_-]{1,64}$/;
    for (const [s, want] of gold.agent_ok) expect(agentRe.test(s as string), String(s)).toBe(want);
  });

  it('feature regex = Python fullmatch', async () => {
    for (const [s, want] of gold.feature_ok) {
      const p = gw().chat('content', MSG, { feature: s as string });
      if (want) await expect(p).resolves.toBeTruthy();
      else await expect(p).rejects.toThrow(/feature/);
    }
  });

  it('data/llm_gateway.json + data/ai_policy.json thật nạp được; mặc định không tính năng nào được cloud', () => {
    const g = new AiGateway({ ...deps(), files: {} });
    expect(g.config().monthly_cap_usd.default).toBe(5.0);
    const p = g.policy();
    expect(p.local).toMatchObject({
      provider: 'ollama',
      chat_model: 'qwen3:8b',
      embed_model: 'bge-m3',
      embed_dim: 1024,
    });
    expect(Object.values(p.features).filter((f) => f.cloud)).toEqual([]);
  });

  it('pyFloat như Python float()', () => {
    expect([
      pyFloat(' 5 '),
      pyFloat('1_0'),
      pyFloat('1e3'),
      pyFloat('.5'),
      pyFloat(true),
      pyFloat('-inf'),
    ]).toEqual([5, 10, 1000, 0.5, 1, -Infinity]);
    expect([pyFloat('abc'), pyFloat('1__0'), pyFloat(null), pyFloat('')]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(pyFloat('nan')).toBeNaN();
  });

  it('_mask với bản port pipelines/pii.py (security/pii thật) = Python', () => {
    const allow = new Set(maskGold.allow);
    for (const [t, want] of maskGold.cases) {
      expect(maskText(t, allow, maskGold.addr, { maskPii, maskIdentity, piiRe: PII_RE }), t).toBe(
        want,
      );
    }
  });
});
