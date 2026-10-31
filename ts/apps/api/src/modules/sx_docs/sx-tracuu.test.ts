import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hit } from '../rag/rag.service.js';
import G from './__fixtures__/sx_tracuu.golden.json' with { type: 'json' };
import { cap } from './sx-docs.testing.js';
import * as st from './sx-tracuu.js';

// Dịch tests/test_sx_tracuu.py (phần không DB; cách ly collection trên DB thật ở sx-docs.db.test.ts)
// + test_contract_finalize.py (tên báo cáo tra cứu/tóm tắt). Embed/chat là bản GIẢ đếm lời gọi — 0
// mạng. Tên người duyệt trong fixture là tên GIẢ.

const TMP = mkdtempSync(join(tmpdir(), 'sxdocs-tc-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const Q = [1, 0, 0, 0];
const DOI = '10.1234/sam.2026.001';
const TITLE_A = 'Saponin trong sâm Ngọc Linh trồng dưới tán rừng (MẪU)';
const HEAD_A = `# ${TITLE_A}\nTác giả: Nhóm MẪU\nDOI: ${DOI}\n\nHàm lượng saponin tổng được đo bằng HPLC trên 30 mẫu củ.`;
const HITS: Hit[] = [
  {
    doc_id: 'sx-saponin-a',
    title: TITLE_A,
    url: 'saponin_a.md',
    lang: null,
    content: HEAD_A,
    score: 1,
  },
  {
    doc_id: 'sx-saponin-b',
    title: 'Nhiệt độ sấy (MẪU)',
    url: 'say_cu_mau.md',
    lang: null,
    content: 'Ghi chép thí nghiệm nhiệt độ sấy củ sâm (MẪU, chưa có DOI).',
    score: 0.95,
  },
  {
    doc_id: 'sx-saponin-a',
    title: TITLE_A,
    url: 'saponin_a.md',
    lang: null,
    content: 'Kết quả: mẫu dưới tán rừng có hàm lượng cao hơn mẫu đối chứng.',
    score: 0.9,
  },
];

type Calls = {
  embed: [string, string, unknown][];
  chat: [string, unknown[], unknown][];
  retrieve: unknown[];
};
let calls: Calls;
let reply: () => Promise<{ text: unknown }>;
let hits: Hit[];
const HEADS: Record<string, string> = {
  'sx-saponin-a': HEAD_A,
  'sx-saponin-b': 'Ghi chép thí nghiệm nhiệt độ sấy củ sâm (MẪU, chưa có DOI).',
};
/** Giai đoạn sổ triển khai mà DB giả trả (`rollout.mode` đọc `feature_rollout`); thiếu = van_hanh. */
let stages: Record<string, string> = {};
const fakeDb = {
  query: async (q: string | { text: string; values: unknown[] }, p0: unknown[] = []) => {
    const sql = typeof q === 'string' ? q : q.text;
    const p = typeof q === 'string' ? p0 : q.values;
    if (sql.startsWith('savepoint')) throw Object.assign(new Error('no tx'), { code: '25P01' });
    if (sql.startsWith('select stage from feature_rollout')) {
      return { rows: [[stages[p[0] as string] ?? 'van_hanh']] };
    }
    if (!sql.startsWith('select doc_id, content from chunks_internal')) throw new Error(sql);
    expect(p[0]).toBe('internal:sx');
    return {
      rows: (p[1] as string[])
        .filter((d) => d in HEADS)
        .map((d) => ({ doc_id: d, content: HEADS[d] })),
    };
  },
};
const ai = {
  embed: async (agent: string, input: string, o: unknown) => {
    calls.embed.push([agent, input, o]);
    return { embeddings: [Q], model: 'm', provider: 'ollama' as const, tokensIn: 0 };
  },
  chat: async (agent: string, msgs: unknown[], o: unknown) => {
    calls.chat.push([agent, msgs, o]);
    const r = await reply();
    return { ...r, model: 'm', provider: 'ollama' as const, tokensIn: 0, tokensOut: 0 } as never;
  },
};
const deps = () => ({
  ai: ai as never,
  db: fakeDb as never,
  retrieve: async (qv: number[], k: number, o: { collection: string }) => {
    calls.retrieve.push([qv, k, o]);
    return hits;
  },
});
const ask = (q: unknown, o: { k?: number; llm?: boolean } = {}) => st.ask(q, o, deps());

beforeEach(() => {
  calls = { embed: [], chat: [], retrieve: [] };
  hits = HITS;
  reply = async () => ({ text: 'Tài liệu [1] mô tả cách đo mẫu củ bằng HPLC.' });
  stages = {};
  installFakeDeps();
});
afterEach(() => resetOpsDeps());

// ------------------------------------------------------------ golden
describe('golden Python', () => {
  it('hằng: nhãn, NO_DATA, system prompt', () => {
    expect(st.LABEL).toBe(G.label);
    expect(st.NO_DATA).toBe(G.no_data);
    expect(st.SYSTEM).toBe(G.system);
  });
  it.each(G.cites as [string, string | null, string | null, string][])(
    '_cite %#',
    (d, r, h, want) => {
      expect(st.cite(d, r, h)).toBe(want);
    },
  );
  it.each(G.renders as [st.Result, string, string][])('render %#', (res, q, want) => {
    expect(st.render(res, q)).toBe(want);
  });
  it.each(G.report_names as [string, string, string][])('report_name %#', (q, m, want) => {
    expect(st.reportName(q, new Date(G.now), m)).toBe(want);
  });
  it('_extract', () => {
    const [h, want] = G.extract as [{ doc_id: string; content: string | null }[], string];
    expect(
      st.extractHits(
        h,
        new Map([
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ]),
      ),
    ).toBe(want);
  });
  it.each(G.viol as [Record<string, unknown>, string][])('_violation_codes %#', (g, want) => {
    expect(st.violationCodes(g)).toBe(want);
  });
  it.each(G.norm_q as [string | null, string][])('_norm_q %#', (q, want) => {
    expect(st.normQ(q)).toBe(want);
  });
});

// ------------------------------------------------------------ ask
describe('ask', () => {
  it('nguồn + cite + chỉ collection internal:sx; trích nguyên văn; mặc định 0 LLM', async () => {
    const r = await ask('hàm lượng saponin dưới tán rừng', { k: 5 });
    expect(r.mode).toBe('extract');
    expect(r.label).toBe(st.LABEL);
    expect(calls.retrieve).toEqual([[Q, 5, { collection: 'internal:sx' }]]);
    expect(calls.embed.map(([a, , o]) => [a, o])).toEqual([
      ['sx_tracuu', { feature: 'production-05.1' }],
    ]);
    const cites = Object.fromEntries(r.sources.map((s) => [s.doc_id, s.cite]));
    expect(Object.keys(cites)).toEqual(['sx-saponin-a', 'sx-saponin-b']);
    expect(cites['sx-saponin-a']).toBe(`DOI: ${DOI}`);
    expect(cites['sx-saponin-b']).toContain('chưa có DOI/URL');
    expect(cites['sx-saponin-b']).toContain('say_cu_mau.md');
    const paras = r.answer.split('\n\n');
    expect(paras.length).toBeGreaterThanOrEqual(1);
    expect(paras.length).toBeLessThanOrEqual(st.MAX_EXTRACTS);
    for (const p of paras) {
      expect(p).toMatch(/^\[\d\] "/);
      expect(p.length).toBeLessThanOrEqual(st.EXTRACT_MAX + 10);
    }
    expect(r.answer).toContain('Hàm lượng saponin tổng được đo bằng HPLC');
    expect(calls.chat).toEqual([]);
  });

  it('nhãn nội bộ ở MỌI đầu ra (extract / no_data / rượu / llm)', async () => {
    const outs = [await ask('saponin'), await ask('   ?!  '), await ask('rượu sâm ngâm bao lâu')];
    outs.push(await ask('saponin', { llm: true }));
    expect(outs.map((o) => o.mode)).toEqual(['extract', 'no_data', 'no_data', 'llm']);
    for (const o of outs) {
      expect(o.label).toBe(st.LABEL);
      expect(st.render(o, 'câu').startsWith(`**${st.LABEL}**`)).toBe(true);
    }
  });

  it('LLM trả từ cấm → về trích đoạn, lý do chỉ mã vi phạm; prompt đúng ràng buộc', async () => {
    reply = async () => ({ text: 'sản phẩm chữa ung thư' });
    expect(guardrailCheck('sản phẩm chữa ung thư').ok).toBe(false);
    const r = await ask('saponin', { llm: true });
    expect(r.mode).toBe('extract');
    expect(r.reason).toContain('banned_word');
    expect(r.answer).not.toContain('chữa');
    expect(r.reason).not.toContain('chữa');
    expect(calls.chat).toHaveLength(1);
    const [agent, msgs, o] = calls.chat[0];
    expect(agent).toBe('sx_tracuu');
    expect(o).toEqual({ feature: 'production-05.2', temperature: 0, maxTokens: 600 });
    const sys = (msgs[0] as { content: string }).content;
    expect(sys).toContain('Chỉ dựa vào NGỮ CẢNH');
    expect(sys).toContain('[n]');
    expect(sys).toContain('Không kết luận công dụng');
  });

  it.each([
    ['null', async () => ({ text: null })],
    ['blank', async () => ({ text: '   ' })],
    [
      'gateway',
      async () => {
        throw new GatewayBlocked('cap');
      },
    ],
  ] as [string, () => Promise<{ text: unknown }>][])(
    'LLM rỗng/lỗi (%s) → trích đoạn',
    async (_n, f) => {
      reply = f;
      const r = await ask('saponin', { llm: true });
      expect(r.mode).toBe('extract');
      expect(r.reason.startsWith('LLM bị loại')).toBe(true);
    },
  );

  it('LLM có SĐT → che trước khi trả', async () => {
    reply = async () => ({ text: 'Liên hệ 0912345678 theo tài liệu [1].' });
    const r = await ask('saponin', { llm: true });
    expect(r.mode).toBe('llm');
    expect(r.answer).not.toContain('0912345678');
  });

  it('NO_DATA: rỗng/dấu câu/rượu → 0 embed; điểm thấp → no_data; embed lỗi → no_data', async () => {
    for (const q of ['', '   ', '?!...', 'rượu sâm 40 độ', 'Ruou sam ngam']) {
      const r = await ask(q);
      expect(r.answer).toBe(st.NO_DATA);
      expect(r.sources).toEqual([]);
    }
    expect(calls.embed).toEqual([]);
    hits = [{ ...HITS[0], score: 0.1 }];
    expect((await ask('chủ đề khác hẳn')).mode).toBe('no_data');
    const bad = {
      ...deps(),
      ai: { ...ai, embed: async () => Promise.reject(new GatewayBlocked('x')) },
    };
    const r = await st.ask('saponin', {}, bad as never);
    expect(r.reason).toBe('embed lỗi (GatewayBlocked)');
  });

  it('câu quá dài → RangeError; k bị kẹp 1..20', async () => {
    await expect(ask('x'.repeat(2001))).rejects.toThrow(RangeError);
    await ask('saponin', { k: 99 });
    await ask('saponin', { k: 0 });
    expect(calls.retrieve.map((c) => (c as unknown[])[1])).toEqual([20, 1]);
  });
});

// ------------------------------------------------------------ CLI
describe('CLI sx-tracuu', () => {
  const run = async (o: st.SxTracuuOpts, conn: 'ok' | 'down' = 'ok') => {
    const t = cap();
    let connects = 0;
    const rc = await st.sxTracuuMain(o, {
      io: t.io,
      env: { NODE_ENV: 'test' },
      connect: async () => {
        connects++;
        return conn === 'ok' ? { db: fakeDb as never, release: async () => {} } : null;
      },
      wire: () => ai as never,
      retrieve: deps().retrieve,
      now: () => new Date('2026-10-12T03:00:00Z'),
      reportsDir: join(TMP, 'reports'),
    });
    return { rc, connects, ...t };
  };

  it('--out: in nhãn ở dòng đầu, ghi sx-tracuu-<ngày>-<sha8>.md (sample=false)', async () => {
    const fake = installFakeDeps();
    const r = await run({ ask: 'saponin', out: true });
    expect(r.rc, r.all()).toBe(0);
    expect(r.out[0].startsWith(`**${st.LABEL}**`)).toBe(true);
    const files = readdirSync(join(TMP, 'reports')).filter((f) => f.startsWith('sx-tracuu-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^sx-tracuu-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/);
    expect(readFileSync(join(TMP, 'reports', files[0]), 'utf8').startsWith(`**${st.LABEL}**`)).toBe(
      true,
    );
    expect(fake.recorded.map((x) => [x.name, x.sample])).toEqual([[files[0], false]]);
    expect(r.out.at(-1)).toContain('[done]');
  });

  it('--llm --out đạt guardrail → sx-tomtat-…', async () => {
    const r = await run({ ask: 'saponin', llm: true, out: true });
    expect(r.rc).toBe(0);
    expect(
      readdirSync(join(TMP, 'reports')).some((f) => f.startsWith('sx-tomtat-2026-10-12-')),
    ).toBe(true);
  });

  it.each([[{ ask: 'x'.repeat(2001) }], [{ ask: 'a', k: '0' }], [{ ask: 'a', k: 'abc' }], [{}]] as [
    st.SxTracuuOpts,
  ][])('sai tham số → exit 2 TRƯỚC connect %#', async (o) => {
    const r = await run(o);
    expect(r.rc).toBe(2);
    expect(r.connects).toBe(0);
  });

  it('DB down → exit 2 [warn]', async () => {
    const r = await run({ ask: 'saponin' }, 'down');
    expect(r.rc).toBe(2);
    expect(r.err.join('\n')).toContain('[warn]');
  });

  it('r12 GATE-OUT: tra cứu TẮT → exit 2 trước embed/in/ghi; tóm tắt TẮT chặn --llm', async () => {
    stages = { 'production-05.1': 'tat' };
    let r = await run({ ask: 'saponin', out: true });
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('[rollout]');
    expect(r.out.join('\n')).not.toContain(st.LABEL);
    expect(calls.embed).toEqual([]);
    stages = { 'production-05.2': 'tat' };
    r = await run({ ask: 'saponin', llm: true });
    expect(r.rc).toBe(2);
    expect(calls.embed).toEqual([]);
    expect(calls.chat).toEqual([]);
    r = await run({ ask: 'saponin' }); // không --llm → chỉ cổng 05.1
    expect(r.rc).toBe(0);
  });
});

// ------------------------------------------------------------ cách ly
describe('cách ly module', () => {
  const SRC = readFileSync(new URL('./sx-tracuu.ts', import.meta.url), 'utf8');
  it('không đường sang hàng duyệt/nháp nội dung/ghi DB/HTTP', () => {
    expect(SRC).not.toMatch(
      /director|saveDraft|content_drafts|approval_queue|insert into|update \w+ set|from 'node:http'|undici/i,
    );
    expect(SRC).toContain("export const COLLECTION = 'internal:sx'");
    expect(SRC).toContain('collection: COLLECTION');
  });
  it('không module nào khác (api/web) import sx-tracuu (chatbot khách không đọc được)', () => {
    const roots = [repoPath('ts', 'apps', 'api', 'src'), repoPath('ts', 'apps', 'web')];
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === 'sx_docs') continue;
        // Sổ lệnh CLI (= `python -m agents.sx_tracuu`, Python không quét agents/) được nêu tên lệnh.
        if (/^cli\.module(\.test)?\.ts$/.test(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /sx[-_]tracuu/.test(readFileSync(p, 'utf8'))) {
          bad.push(relative(repoPath(), p));
        }
      }
    };
    for (const r of roots) {
      try {
        walk(r);
      } catch {
        // thư mục chưa có
      }
    }
    expect(bad).toEqual([]);
  });
  it('trần chi phí agent sx_tracuu có cấu hình', () => {
    const cfg = JSON.parse(readFileSync(repoPath('data', 'llm_gateway.json'), 'utf8'));
    expect(cfg.monthly_cap_usd.sx_tracuu).toBe(1.0);
  });
});
