import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { checkPublish } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { msgHash } from '../intel_import/intel-import.js';
import G from './__fixtures__/mkt_ugc.golden.json' with { type: 'json' };
import { type CliDeps, mktUgcMain, sinceArg } from './mkt-koc-ugc-seo.command.js';
import * as mu from './mkt-ugc.js';

// Dịch phần THUẦN + CLI không DB của tests/test_mkt_ugc.py, lớp nghi_hang_gia (tests/test_docx_p2.py,
// test_contract_finalize.py), cổng TẮT sớm (tests/test_r19_ngay_cong_som.py M2). Kết quả so khớp
// golden sinh từ hàm Python thật (__fixtures__/mkt_ugc.golden.json). Phần DB ở *.db.test.ts.

const rules = mu.loadRules();
const REVIEWS = repoPath('tests/fixtures/mkt/review_shopee_MAU.csv');
const SALT = G.salt;
// Không được lọt ra stdout/payload: PII giả + nội dung khách.
export const LEAK = [
  '0901234567',
  'nguoimuagia@example.com',
  'NGUOI MUA GIA',
  'FAKEREV',
  'đau khớp',
  'gout',
  'thất vọng',
  'Giao chậm',
  'Rượu sâm biếu',
  'báo giá sỉ',
  'thơm ngon',
];
const tmp = mkdtempSync(join(tmpdir(), 'mkt-ugc-'));
afterEach(() => {
  settings.forceMode = null;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('mkt_ugc — luật + template (golden Python)', () => {
  it('mọi template qua check_publish mọi kênh; câu sức khỏe/rượu TÁI DÙNG channels.json', () => {
    for (const ch of ['shopee', 'tiktok', 'facebook', 'zalo']) {
      for (const [k, t] of Object.entries(rules.templates)) {
        const g = checkPublish(t, { channel: ch, contentType: 'post', isAi: false });
        expect([ch, k, g.ok]).toEqual([ch, k, true]);
      }
    }
    const raw = JSON.parse(readFileSync(repoPath('data/ugc_rules.json'), 'utf8'));
    const ch = JSON.parse(readFileSync(repoPath('data/channels.json'), 'utf8')).templates;
    expect(rules.templates.health_san).toBe(ch.health_san);
    for (const k of ['health', 'alcohol', 'health_san', 'alcohol_san']) {
      expect(raw.templates).not.toHaveProperty(k);
    }
    expect(raw._doc).toContain('NHÁP');
    expect(raw._doc).toContain('Pháp chế');
    expect(rules.counterfeit_terms).toEqual(G.counterfeit);
  });

  it('load_rules fail-closed khớp Python', () => {
    const raw = JSON.parse(readFileSync(repoPath('data/ugc_rules.json'), 'utf8'));
    const p = join(tmp, 'u.json');
    for (const c of G.load_err) {
      if (c.mut === '{') writeFileSync(p, '{');
      else if (c.mut === 'no_counterfeit') {
        const { counterfeit_terms: _x, ...d2 } = raw;
        writeFileSync(p, JSON.stringify(d2));
      } else writeFileSync(p, JSON.stringify({ ...raw, ...(c.mut as object) }));
      if (c.err === null) {
        const r = mu.loadRules(p);
        if ('counterfeit' in c) expect(r.counterfeit_terms).toEqual(c.counterfeit);
      } else {
        expect(() => mu.loadRules(p)).toThrow(mu.UgcConfigError);
        expect(() => mu.loadRules(p)).toThrow((c.err as string).replace('UgcConfigError: ', ''));
      }
    }
  });

  it('classify mọi lớp (kể cả chỉ nhãn — DPIA chưa ký, nghi hàng giả)', () => {
    for (const c of G.classify) {
      const [text, stars, labels] = c.in as [string | null, number | null, string[]];
      const r = 'empty_rules' in c ? {} : rules;
      expect([c.in, mu.classify(text, stars, r, labels)]).toEqual([c.in, c.out]);
    }
    expect(mu.draftReply('nghi_hang_gia', rules, false)).toBe(rules.templates.khieu_nai);
  });

  it('propose: câu trả lời không lặp claim sức khỏe của khách, qua guardrail đăng bài', () => {
    for (const c of G.propose) {
      const [text, stars, ch, san, labels] = c.in as [
        string | null,
        number | null,
        string,
        boolean,
        string[],
      ];
      expect([c.in, mu.propose(text, stars, ch, rules, { san, labels })]).toEqual([c.in, c.out]);
    }
    const echo = 'Dạ, Sâm Sâm mừng vì Quý khách đỡ mệt mỏi ạ';
    const bad = {
      ...rules,
      templates: { ...rules.templates, khen: echo, health: echo, health_san: echo },
    };
    for (const c of G.propose_bad) {
      const [text, stars, ch, san] = c.in as [string, number, string, boolean];
      expect(mu.propose(text, stars, ch, bad, { san })).toEqual(c.out);
    }
  });

  it('no_claim_echo khớp Python (có dấu / không dấu / span guardrail)', () => {
    for (const c of G.echo) {
      const [r, cu] = c.in as [string, string];
      expect([c.in, mu.noClaimEcho(r, cu, rules.health_terms)]).toEqual([c.in, [c.ok, c.hits]]);
    }
  });

  it('read_reviews: che PII khi đọc, bỏ cột người mua, lỗi theo dòng/cột không in giá trị ô', () => {
    G.reviews.forEach((c, i) => {
      const p = join(tmp, `r${i}.csv`);
      if ('raw_hex' in c) writeFileSync(p, Buffer.from(c.raw_hex as string, 'hex'));
      else if (c.text === null) {
        const H = 'Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá';
        writeFileSync(p, `${H}\nA,5,"${'a'.repeat(200_000)}",t\n`);
      } else writeFileSync(p, c.text as string);
      const got = mu.readReviews(p, c.channel, rules);
      expect([i, got]).toEqual([i, [c.rows, c.errs, c.sha]]);
    });
    const [rows] = mu.readReviews(REVIEWS, 'shopee', rules);
    const blob = JSON.stringify(rows);
    for (const s of ['0901234567', 'nguoimuagia@example.com', 'NGUOI MUA GIA']) {
      expect(blob).not.toContain(s);
    }
    expect(rows.map((r) => mu.classify(r.text, r.stars, rules))).toEqual([
      'khen',
      'che',
      'khieu_nai',
      'claim_suc_khoe',
      'hoi_gia',
      'ruou',
      'khac',
    ]);
  });

  it('process dry-run: object_id = ugc-<16 hex sha256 muối>, payload không chép lời khách', async () => {
    const [rows, , sha] = mu.readReviews(REVIEWS, 'shopee', rules);
    const items = rows.map((r) => ({
      key: r.ma,
      text: r.text,
      stars: r.stars,
      source: `file review sha256 \`${(sha as string).slice(0, 12)}\` dòng ${r.row_no}`,
    }));
    expect(await mu.processItems(items, 'shopee', rules, { salt: SALT, san: true })).toEqual(
      G.process,
    );
    for (const [ch, want] of Object.entries(G.process_mentions)) {
      const its = [1, 2, 3]
        .map((n) => ({
          key: `social_mentions#${n}`,
          channel: ['facebook', 'zalo', 'tiktok'][n - 1] as string,
          labels: [['khen'], ['hoi_suc_khoe'], ['khac']][n - 1] as string[],
          text: null,
          stars: null,
          source: `\`social_mentions#${n}\``,
        }))
        .filter((x) => x.channel === ch);
      expect(await mu.processItems(its, ch, rules, { salt: SALT, san: false })).toEqual(want);
    }
    expect(msgHash(SALT, 'shopee', 'FAKEREV001')).toBe(G.msg_hash[0]);
    expect(msgHash(SALT, 'zalo', 'social_mentions#2')).toBe(G.msg_hash[1]);
  });

  it('lớp rượu hiện bằng mã trung tính trong title/payload (qua guardrail, không chữ "ruou")', () => {
    expect(
      mu.renderReply(
        mu.propose('Rượu sâm biếu sếp', 5, 'shopee', rules, { san: true }),
        'shopee',
        'x',
      ),
    ).toBe(G.renders.reply);
    expect(mu.title('ruou', 'shopee')).toBe(G.renders.title_ruou);
    expect(mu.title('khen', 'zalo')).toBe(G.renders.title_khen);
    expect(mu.title('xin_phep', 'facebook', 'Nháp xin phép dùng lại UGC')).toBe(G.renders.title_xp);
    expect(G.renders.reply).not.toContain('ruou');
  });

  it('process PHẢI gọi no_claim_echo: template lặp cụm sức khỏe → UGC_ECHO, 0 mục hàng duyệt', async () => {
    installFakeDeps();
    const calls: string[] = [];
    const fake = {
      query: async (sql: string) => {
        calls.push(sql);
        return sql.includes('exists') ? { rows: [{ e: false }] } : { rows: [{ id: '1' }] };
      },
    } as unknown as Db;
    const echo = 'Dạ, Sâm Sâm mừng vì Quý khách đỡ mệt mỏi ạ';
    const bad = {
      ...rules,
      templates: { ...rules.templates, khen: echo, health: echo, health_san: echo },
    };
    const items = [
      { key: 'r1', source: '`review#1`', text: 'Uống thấy đỡ mệt mỏi, thơm ngon', stars: 5 },
    ];
    let st = await mu.processItems(items, 'shopee', bad, {
      salt: SALT,
      san: true,
      db: fake,
      by: 'mkt',
    });
    expect(st.chan).toEqual([['`review#1`', 'UGC_ECHO']]);
    expect(st.moi).toEqual([]);
    expect(calls.filter((s) => s.includes('enqueue_item'))).toEqual([]);
    st = await mu.processItems(items, 'shopee', rules, {
      salt: SALT,
      san: true,
      db: fake,
      by: 'mkt',
    });
    expect(st.chan).toEqual([]);
    expect(calls.filter((s) => s.includes('enqueue_item')).length).toBe(1);
  });

  it('_since khớp Python', () => {
    for (const [s, want] of G.since) expect([s, sinceArg(s)]).toEqual([s, want]);
  });
});

describe('mkt_ugc — CLI không DB', () => {
  const env = { INTEL_HASH_SALT: SALT };
  const deps = (
    c: ReturnType<typeof cap>,
    calls: number[],
    extra: Partial<CliDeps> = {},
  ): CliDeps => ({
    io: c.io,
    env,
    connect: async () => {
      calls.push(1);
      return null;
    },
    ...extra,
  });

  it.each([
    [{}],
    [{ mentions: true, by: 'a' }],
    [{ reviews: 'x.csv', by: 'a' }],
    [{ reuse: 'ugc-0000000000000000', by: 'a' }],
    [{ reviews: 'x.csv', channel: 'shopee' }],
    [{ mentions: true, since: '2026-13-01', by: 'a' }],
    [{ mentions: true, since: '2026-10-01', reuse: 'x', by: 'a' }],
    [{ reviews: 'x.csv', channel: 'lazada', by: 'a' }],
    [{ reuse: 'x', contactId: 'abc', by: 'a' }],
    [{ reuse: 'x', contactId: '0', by: 'a' }],
  ])('usage sai → exit 2 TRƯỚC connect: %j', async (o) => {
    const c = cap();
    const calls: number[] = [];
    expect(await mktUgcMain(o, deps(c, calls))).toBe(2);
    expect(calls).toEqual([]);
  });

  it('thiếu muối → exit 1 trước connect; --dry-run không DB, không lộ PII/nội dung khách', async () => {
    const c = cap();
    const calls: number[] = [];
    const o = { reviews: REVIEWS, channel: 'shopee', by: 'a', dryRun: true };
    expect(await mktUgcMain(o, deps(c, calls, { env: {} }))).toBe(1);
    expect(c.out.join('\n')).toContain('INTEL_HASH_SALT');
    const c2 = cap();
    expect(await mktUgcMain(o, deps(c2, calls))).toBe(0);
    const out = c2.out.join('\n');
    expect(calls).toEqual([]);
    expect(out).toContain('6 đề xuất');
    expect(out).toContain('khac 1');
    for (const s of LEAK) expect(out).not.toContain(s);
  });

  it('file review lỗi → chặn cả file, exit 1, không in giá trị ô', async () => {
    const p = join(tmp, 'bad.csv');
    writeFileSync(
      p,
      'Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá,SĐT người mua\nA,5,x,t,0909999999\n',
    );
    const c = cap();
    const calls: number[] = [];
    expect(await mktUgcMain({ reviews: p, channel: 'shopee', by: 'a' }, deps(c, calls))).toBe(1);
    expect(c.out[0]).toBe('[err] file review lỗi (1) — chặn cả file, không ghi:');
    expect(c.out.join('\n')).not.toContain('0909999999');
    expect(calls).toEqual([]);
  });

  const CASES: [string, mu.Item | object][] = [
    ['reviews-dry', { reviews: REVIEWS, channel: 'shopee', by: 'Lan', dryRun: true }],
    ['reviews', { reviews: REVIEWS, channel: 'shopee', by: 'Lan' }],
    ['mentions-dry', { mentions: true, since: '2026-10-01', by: 'Lan', dryRun: true }],
    ['reuse-request', { reuseRequest: 'ugc-0000000000000000', by: 'Lan' }],
    ['reuse', { reuse: 'ugc-0000000000000000', contactId: '1', by: 'Lan' }],
  ];
  it.each(CASES)(
    'marketing-05.2 TẮT → đúng 1 dòng [rollout] exit 2, không connect: %s',
    async (_n, o) => {
      settings.forceMode = 'tat';
      const c = cap();
      const calls: number[] = [];
      expect(await mktUgcMain(o as never, deps(c, calls))).toBe(2);
      expect(c.out.length).toBe(1);
      expect(c.out[0]).toMatch(/^\[rollout\] .*marketing-05\.2/);
      expect(calls).toEqual([]);
    },
  );

  it.each(['chay_thu', 'van_hanh'].flatMap((st) => CASES.map(([n, o]) => [st, n, o] as const)))(
    'giai đoạn %s: cổng không chặn (%s)',
    async (st, n, o) => {
      settings.forceMode = st;
      const c = cap();
      const calls: number[] = [];
      const rc = await mktUgcMain(o as never, deps(c, calls));
      expect(c.out.join('\n')).not.toContain('[rollout]');
      if (n === 'reviews-dry') {
        expect(rc).toBe(0);
        expect(calls).toEqual([]);
        expect(c.out.join('\n')).toContain('đề xuất');
      } else {
        expect(calls).toEqual([1]);
        expect(rc).not.toBe(0);
      }
    },
  );
});

describe('mkt_ugc — lỗi trong thao tác như Python', () => {
  it.each([
    ['RangeError', new RangeError('chi tiết 0901234567'), 'ValueError'],
    ['RolloutBlocked', new RolloutBlocked('marketing-05.2 đang tắt'), 'RolloutBlocked'],
    [
      'fs EACCES',
      Object.assign(new Error('EACCES: permission denied, open C:/x'), {
        code: 'EACCES',
        syscall: 'open',
        path: 'C:/x',
      }),
      'PermissionError',
    ],
  ])('%s → "[error] <tên>: <tên>" (không in thông điệp), exit 1', async (_n, err, name) => {
    settings.forceMode = 'van_hanh';
    const out: string[] = [];
    const errs: string[] = [];
    const db = {
      query: async () => {
        throw err;
      },
    } as unknown as Db;
    const rc = await mktUgcMain(
      { mentions: true, since: '2026-10-01', by: 'Lan' },
      {
        io: { out: (s) => out.push(s), err: (s) => errs.push(s) },
        env: { INTEL_HASH_SALT: SALT },
        connect: async () => ({ db, release: async () => {} }),
        wire: () => undefined,
      },
    );
    expect(rc).toBe(1);
    expect(errs).toEqual([`[error] ${name}: ${name}`]);
  });
});
