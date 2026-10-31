import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGolden } from '../garden_director/scenario.js';
import IA from './__fixtures__/intel_alert.golden.json' with { type: 'json' };
import IB from './__fixtures__/intel_bulletin.golden.json' with { type: 'json' };
import LU from './__fixtures__/legal_updates.golden.json' with { type: 'json' };
import PS from './__fixtures__/persona_sim.golden.json' with { type: 'json' };
import * as ia from './intel-alert.js';
import * as ib from './intel-bulletin.js';
import { pyFixed1, pyPct0, pyRound1 } from './io.js';
import * as lu from './legal-updates.js';
import * as ps from './persona-sim.js';
import { PyRandom } from './py-random.js';

// Golden sinh bằng hàm Python THẬT (script ngoài repo: gen_intel_alert_golden.py — chạy với DSN chết,
// không DB/mạng): intel_alert.match/load_rules, intel_bulletin.render/_segment/suggestion/_md/_link,
// legal_updates.payload, persona_sim.validate_inputs/parse_scores/prompt_hash/render/fake_chat/
// run_matrix/summarize/report + định dạng số kiểu Python. Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn):
// NaN/Infinity trong file luật → "JSON hỏng" (Python: lookback lỗi) — fail-closed như nhau.

type Obj = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);
const D = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

describe('intel_alert golden', () => {
  it('match khớp Python cho mọi ca (dương tính, trung tính, PC-A8, không dấu)', () => {
    const rules = ia.loadRules();
    for (const c of IA.match) {
      expect(ia.match(c.item as ia.MatchItem, rules), c.item.title).toEqual(c.rules);
    }
    expect(new Set(IA.match.flatMap((c) => c.rules))).toEqual(new Set(ia.RULES));
  });

  it('file luật repo đọc như Python (GIẢ ĐỊNH, 48 giờ, legal_sources)', () => {
    const r = ia.loadRules();
    expect({ ...r, legal_sources: [...r.legal_sources].sort() }).toEqual(IA.repo_rules);
    expect(r.status).toBe('gia_dinh');
    expect(ia.ESCALATE_AFTER_MS).toBe(2 * 3600_000);
  });

  describe('loadRules fail-closed', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ia-rules-'));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const base = JSON.parse(readFileSync(ia.RULES_FILE, 'utf8')) as Obj;
    const doc = (over: Obj = {}) => ({ ...clone(base), ...over });
    const groups = (over: Obj = {}) => ({ ...(base.groups as Obj), ...over });
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
    const { penalty: _p, ...noPenalty } = base.groups as Obj;
    const { legal_sources: _l, ...noLegal } = base;
    const BAD: Record<string, Buffer | null> = {
      missing: null,
      empty: Buffer.alloc(0),
      bad_json: Buffer.from('{groups: ['),
      bad_utf8: Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      obj_empty: Buffer.from('{}'),
      doc_only: enc({ _doc: 'chỉ ghi chú' }),
      list_root: Buffer.from('[]'),
      no_penalty: enc(doc({ groups: noPenalty })),
      brand_empty: enc(doc({ groups: groups({ brand: [] }) })),
      negative_blank: enc(doc({ groups: groups({ negative: ['  '] }) })),
      regulation_str: enc(doc({ groups: groups({ regulation: 'nghị định' }) })),
      lookback_0: enc(doc({ lookback_hours: 0 })),
      lookback_721: enc(doc({ lookback_hours: 721 })),
      lookback_true: enc(doc({ lookback_hours: true })),
      lookback_str: enc(doc({ lookback_hours: '48' })),
      // 48.0 phải giữ là float như Python (không phải int)
      lookback_float: Buffer.from(
        JSON.stringify(doc({ lookback_hours: 48 })).replace(
          '"lookback_hours":48',
          '"lookback_hours":48.0',
        ),
      ),
      legal_missing: enc(noLegal),
      legal_empty: enc(doc({ legal_sources: [] })),
      legal_blank: enc(doc({ legal_sources: [''] })),
      legal_str: enc(doc({ legal_sources: 'x' })),
      legal_bad_id: enc(doc({ legal_sources: ['Bad Id'] })),
      legal_mixed: enc(doc({ legal_sources: ['ok', 'Bad Id'] })),
      legal_int: enc(doc({ legal_sources: [1] })),
      bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), enc(doc())]),
    };
    it.each(Object.keys(BAD))('%s → IntelAlertConfigError như Python', (k) => {
      const sub = join(dir, k);
      mkdirSync(sub, { recursive: true });
      const path = join(sub, 'rules.json');
      const content = BAD[k] as Buffer | null;
      if (content !== null) writeFileSync(path, content);
      let msg: string | null = null;
      try {
        ia.loadRules(path);
      } catch (e) {
        expect(e).toBeInstanceOf(ia.IntelAlertConfigError);
        msg = (e as Error).message;
      }
      expect(msg).toBe((IA.bad_rules as Record<string, string>)[k]);
    });
    it('ca hợp lệ: status thiếu/số, cụm được strip', () => {
      const cases: Record<string, Buffer> = {
        status_none: enc((({ status: _s, ...x }) => x)(doc())),
        status_num: enc(doc({ status: 3 })),
        strip_phrases: enc(doc({ groups: groups({ brand: ['  sâm sâm ', 'samsam'] }) })),
      };
      for (const [k, content] of Object.entries(cases)) {
        const path = join(dir, `ok-${k}.json`);
        writeFileSync(path, content);
        const r = ia.loadRules(path);
        expect({ ...r, legal_sources: [...r.legal_sources].sort() }).toEqual(
          (IA.good_rules as Record<string, { rules: unknown }>)[k]?.rules,
        );
      }
    });
  });
});

describe('intel_bulletin golden', () => {
  beforeAll(() => {
    installFakeDeps({}, {});
  });

  const toData = (d: Obj): ib.BulletinData => ({
    ...(d as unknown as ib.BulletinData),
    groups: Object.fromEntries(
      Object.entries(d.groups as Record<string, Obj[]>).map(([t, rows]) => [
        t,
        rows.map((r) => ({
          ...(r as unknown as ib.Item),
          published_at: D(r.published_at as string),
          fetched_at: D(r.fetched_at as string),
        })),
      ]),
    ),
    suggested: (d.suggested as [string, number, boolean][]).map((x) => [...x]),
  });

  it.each(IB.render.map((c) => [c.name, c]))('render %s y hệt Python', (_n, c) => {
    const cc = c as (typeof IB.render)[number];
    const text = ib.render(
      toData(cc.data as unknown as Obj),
      new Date(cc.start),
      new Date(cc.end),
      cc.summaries as Record<string, string | null>,
      cc.period,
    );
    expect(text).toBe(cc.text);
  });

  it('render thuần + trần 20 tin/chủ đề + escape markdown/HTML từ nguồn ngoài', () => {
    const cap = IB.render.find((c) => c.name === 'capped') as (typeof IB.render)[number];
    expect(cap.text).toContain('(+5 tin nữa)');
    expect(cap.text).toContain('Tin 19');
    expect(cap.text).not.toContain('Tin 20');
    const esc = IB.render.find((c) => c.name === 'escape') as (typeof IB.render)[number];
    for (const pat of [/(?<!\\)!(?<!\\)\[/, /(?<!\\)<img/, /(?<!\\)\]\(https/]) {
      expect(esc.text).not.toMatch(pat);
    }
    expect(esc.text).toContain('<https://bao.example.vn/a>');
    expect(esc.text).not.toContain('<javascript');
  });

  it('segment/suggestion/md/link y hệt Python', () => {
    for (const [d, want] of IB.segment) {
      expect(ib.segment(d as ib.Item)).toBe(want);
      expect((want as string).includes('http')).toBe(false);
    }
    for (const [t, n, s, e, period, want] of IB.suggestion) {
      expect(
        ib.suggestion(
          t as string,
          n as number,
          new Date(s as string),
          new Date(e as string),
          period as string,
        ),
      ).toEqual(want);
    }
    for (const [s, want] of IB.md) expect(ib.md(s)).toBe(want);
    for (const [s, want] of IB.link) expect(ib.link(s)).toBe(want);
  });
});

describe('legal_updates golden', () => {
  it('payload tất định, không diễn giải', () => {
    for (const [it0, want] of LU.payload) {
      const it1 = it0 as Obj;
      const item = {
        ...(it1 as unknown as lu.LegalItem),
        published_at: D(it1.published_at as string),
        fetched_at: D(it1.fetched_at as string),
      };
      expect(lu.payload(item)).toBe(want);
    }
  });
});

describe('persona_sim golden', () => {
  const CFG = ps.readJsonDoc(ps.CONFIG_FILE)[0] as Obj;
  const PERS = ps.readJsonDoc(ps.PERSONAS_FILE)[0] as Obj;
  const GOLDEN = readGolden(ps.GOLDEN_FILE)[0];
  const pers = (mut: (d: Obj) => void) => {
    const d = clone(PERS);
    mut(d);
    return d;
  };
  const cfg = (mut: (d: Obj) => void) => {
    const d = clone(CFG);
    mut(d);
    return d;
  };
  const P = (d: Obj) => d.personas as Obj[];
  const O = (d: Obj) => d.options as Obj[];
  const addOpt =
    (text: string, kw: Obj = {}) =>
    (d: Obj) => {
      O(d).push({ id: 'x-opt', kind: 'brand_theme', sku_keys: [], text, ...kw });
    };
  // Ca giống hệt VALIDATE_CASES của tests/test_persona_sim.py (+ ca biên thêm ở generator).
  const V: Record<string, [Obj | unknown[] | null, Obj | unknown[] | null]> = {
    repo: [null, null],
    persona_order_id: [null, pers((d) => Object.assign(P(d)[0] as Obj, { order_id: 'DH0001' }))],
    persona_user_hash: [
      null,
      pers((d) => Object.assign(P(d)[1] as Obj, { user_hash: 'ab12cd34' })),
    ],
    persona_phone: [null, pers((d) => Object.assign(P(d)[2] as Obj, { label: 'Gọi 0905123456' }))],
    persona_phone_in_trait: [
      null,
      pers((d) => ((P(d)[2] as Obj).traits as string[]).push('zalo 0905123456')),
    ],
    persona_email_key: [null, pers((d) => Object.assign(P(d)[3] as Obj, { email: 'a@b.vn' }))],
    persona_weird_key: [null, pers((d) => Object.assign(P(d)[3] as Obj, { 'Tên Lạ': 'x', zz: 1 }))],
    persona_17_alcohol: [
      cfg(addOpt('Rượu sâm Ngọc Linh làm quà biếu Tết')),
      pers((d) => Object.assign(P(d)[0] as Obj, { age_min: 17 })),
    ],
    alcohol_gen_z: [cfg(addOpt('Thông điệp rượu sâm cho Gen Z')), null],
    alcohol_sku_youth_panel: [
      cfg((d) =>
        O(d).push({
          id: 'x-opt',
          kind: 'brand_theme',
          sku_keys: ['ruou-sam-binh-su-do-500ml'],
          text: 'Bình sứ đỏ quà Tết',
        }),
      ),
      null,
    ],
    banned_word: [cfg(addOpt('Sâm chữa mệt mỏi')), null],
    tpbvsk_no_xnqc_product: [
      cfg(addOpt('Saphraton 20 viên quà Tết', { kind: 'product', sku_keys: ['saphraton-20v'] })),
      null,
    ],
    tpbvsk_brand_theme_ok: [
      cfg(addOpt('Câu chuyện vườn sâm', { sku_keys: ['saphraton-20v'] })),
      null,
    ],
    unknown_sku: [cfg(addOpt('Quà Tết', { sku_keys: ['khong-co'] })), null],
    repeats_4: [cfg((d) => Object.assign(d, { repeats: 4 })), null],
    repeats_bool: [cfg((d) => Object.assign(d, { repeats: true })), null],
    two_models: [cfg((d) => (d.models as Obj[]).pop()), null],
    two_prompts: [cfg((d) => (d.prompts as Obj[]).pop()), null],
    zero_control: [cfg((d) => delete (O(d)[O(d).length - 1] as Obj).control), null],
    two_control: [cfg((d) => Object.assign(O(d)[0] as Obj, { control: true })), null],
    one_normal_option: [
      cfg((d) => Object.assign(d, { options: [O(d)[0], O(d)[O(d).length - 1]] })),
      null,
    ],
    prompt_no_placeholder: [
      cfg((d) => Object.assign((d.prompts as Obj[])[0] as Obj, { text: 'Chấm điểm đi' })),
      null,
    ],
    prompt_pii: [
      cfg((d) =>
        Object.assign((d.prompts as Obj[])[0] as Obj, {
          text: '{personas} {options} gọi 0905123456',
        }),
      ),
      null,
    ],
    synthetic_false: [null, pers((d) => Object.assign(d, { synthetic: false }))],
    persona_no_source: [null, pers((d) => delete (P(d)[0] as Obj).source)],
    persona_count_5: [null, pers((d) => Object.assign(d, { personas: P(d).slice(0, 5) }))],
    persona_count_11: [
      null,
      pers((d) =>
        Object.assign(d, {
          personas: [
            ...P(d),
            ...P(d)
              .slice(0, 3)
              .map((p) => ({ ...p, id: `${p.id}-b` })),
          ],
        }),
      ),
    ],
    dup_option_id: [cfg((d) => Object.assign(O(d)[1] as Obj, { id: (O(d)[0] as Obj).id })), null],
    model_dup_and_bad: [
      cfg((d) => {
        const ms = d.models as Obj[];
        ms.push(
          { id: 'Bad Model', seed_supported: true },
          { ...(ms[0] as Obj) },
          { id: 'x/y', seed_supported: 'yes' },
        );
      }),
      null,
    ],
    temp_3: [cfg((d) => Object.assign(d, { temperature: 3 })), null],
    temp_str: [cfg((d) => Object.assign(d, { temperature: '0.7' })), null],
    seed_neg: [cfg((d) => Object.assign(d, { base_seed: -1 })), null],
    seed_overflow: [cfg((d) => Object.assign(d, { base_seed: 2 ** 31 - 3 })), null],
    option_not_obj: [cfg((d) => O(d).unshift('x' as unknown as Obj)), null],
    option_bad_kind_control: [cfg(addOpt('Quà Tết đẹp', { kind: 'video', control: 'yes' })), null],
    option_blank_text: [cfg(addOpt('   ')), null],
    option_skus_none: [cfg(addOpt('Quà Tết đẹp', { sku_keys: null })), null],
    persona_not_obj: [null, pers((d) => P(d).splice(0, 1, 'x' as unknown as Obj))],
    persona_bad_ages: [
      null,
      pers((d) =>
        Object.assign(P(d)[0] as Obj, { age_min: 40, age_max: 30, youth: 'no', traits: 'x' }),
      ),
    ],
    persona_dup_id: [null, pers((d) => Object.assign(P(d)[1] as Obj, { id: (P(d)[0] as Obj).id }))],
    persona_bad_set_id: [null, pers((d) => Object.assign(d, { set_id: 'Bad Set' }))],
    cfg_not_obj: [[], null],
    pers_list: [null, []],
    pers_empty_obj: [null, {}],
  };

  it('các ca kiểm đầu vào có trong golden đủ', () => {
    expect(Object.keys(V).sort()).toEqual(Object.keys(PS.validate).sort());
  });
  it.each(Object.keys(V))('validateInputs %s y hệt Python (không lộ giá trị ô)', (k) => {
    const [c, p] = V[k] as [unknown, unknown];
    const errs = ps.validateInputs(c ?? CFG, p ?? PERS, GOLDEN);
    expect(errs).toEqual((PS.validate as Record<string, string[]>)[k]);
    const blob = errs.join('\n');
    for (const secret of [
      '0905123456',
      'DH0001',
      'ab12cd34',
      'a@b.vn',
      'Gen Z',
      'chữa',
      'Rượu sâm',
    ]) {
      expect(blob).not.toContain(secret);
    }
  });

  it('parseScores / promptHash y hệt Python', () => {
    for (const [t, want] of PS.parse) expect(ps.parseScores(t, ['a', 'b'])).toEqual(want);
    for (const [t, want] of PS.prompt_hash) expect(ps.promptHash(t as string)).toBe(want);
  });

  it('render prompt + thứ tự xáo (MT19937) + gateway giả y hệt Python', async () => {
    const order = [...O(CFG)];
    new PyRandom(CFG.base_seed as number).shuffle(order);
    expect(order.map((o) => o.id)).toEqual(PS.render_first.order);
    const text = ps.render(((CFG.prompts as Obj[])[0] as Obj).text as string, P(PERS), order);
    expect(text).toBe(PS.render_first.text);
    const fake = ps.fakeChat(O(CFG));
    const mid = ((CFG.models as Obj[])[0] as Obj).id as string;
    expect(
      await fake(mid, [{ role: 'user', content: text }], 0.7, CFG.base_seed as number),
    ).toEqual(PS.fake_first);
  });

  it('PyRandom khớp CPython (random/uniform/shuffle, seed int/str/lớn)', () => {
    const r = new PyRandom(20261012);
    expect([r.random(), r.random(), r.random()]).toEqual([
      0.4066305459134356, 0.789063133675149, 0.0014227626551327477,
    ]);
    const u = new PyRandom('openai/gpt-4o-mini|20261012|abc123abc123');
    expect([u.uniform(4, 9.5), u.uniform(4, 9.5), u.uniform(4, 9.5)]).toEqual([
      7.4365310215854326, 4.782711912708505, 5.711917373288125,
    ]);
    const x = [0, 1, 2, 3, 4, 5, 6];
    new PyRandom(5).shuffle(x);
    expect(x).toEqual([6, 3, 1, 0, 5, 2, 4]);
    expect(new PyRandom(0).random()).toBe(0.8444218515250481);
    expect(new PyRandom(2n ** 70n + 12345n).random()).toBe(0.9602803546023011);
  });

  const ser = (s: ps.Summary) => {
    const { options, ...rest } = s;
    return { ...rest, options: [...options.entries()] };
  };

  it('runMatrix dry-run 3×3×5 + summarize + report y hệt Python', async () => {
    const [rows, n] = await ps.runMatrix(CFG, PERS, O(CFG), ps.fakeChat(O(CFG)), '2026-10-12', {
      runId: 't-1',
      personaSetHash: 'abc123abc123',
      dryRun: true,
    });
    expect(n).toBe(PS.matrix.n);
    expect(
      rows.map((r) => [
        r.model,
        r.prompt_id,
        r.sample_idx,
        r.option_id,
        r.score,
        r.parse_ok,
        r.guardrail_ok,
        r.model_version,
        r.seed,
        r.prompt_hash,
        r.provider,
        r.is_control,
      ]),
    ).toEqual(PS.matrix.rows);
    const s = ps.summarize(rows);
    expect(ser(s)).toEqual(PS.matrix.summary);
    expect(
      ps.report(s, {
        runId: 't-1',
        personaSet: PERS.set_id as string,
        personaSetHash: 'abc123abc123',
        dryRun: true,
      }),
    ).toBe(PS.matrix.report);
    const opts = [...O(CFG).slice(0, 3), O(CFG)[O(CFG).length - 1] as Obj];
    const [rows2] = await ps.runMatrix(CFG, PERS, opts, ps.fakeChat(O(CFG)), '2026-10-12', {
      runId: 't-2',
    });
    // persona_set_hash mặc định = sha12(json.dumps(personas, sort_keys=True, ensure_ascii=False))
    expect(rows2[0]?.persona_set_hash).toBe(PS.matrix_default_hash);
  });

  it('summarize/report dữ liệu tay (hòa, quá ít hợp lệ, phân số) y hệt Python', () => {
    for (const [k, h] of Object.entries(PS.hand)) {
      const rows = (h.calls as Record<string, number | null>[]).flatMap((sc, i) =>
        Object.entries(sc).map(([oid, v]) => ({
          model: 'm/x',
          prompt_id: 'p',
          sample_idx: i,
          option_id: oid,
          is_control: oid === 'c',
          score: v,
        })),
      );
      const s = ps.summarize(rows);
      expect(ser(s), k).toEqual(h.summary);
      expect(
        ps.report(s, { runId: 't', personaSet: 'v1', personaSetHash: 'h', dryRun: k === 'ties' }),
        k,
      ).toBe(h.report);
    }
  });

  it('định dạng số kiểu Python: .1f, round(x,1), .0%, quantiles inclusive', () => {
    for (const [x, s, r] of PS.fixed1) {
      expect(pyFixed1(x as number), String(x)).toBe(s);
      expect(Object.is(pyRound1(x as number), r) || pyRound1(x as number) === r, String(x)).toBe(
        true,
      );
    }
    for (const [x, s] of PS.pct0) expect(pyPct0(x as number), String(x)).toBe(s);
    for (const [d, q] of PS.quantiles) expect(ps.quantiles10(d as number[])).toEqual(q);
  });
});
