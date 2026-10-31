import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { PII_RE } from '@samsam/core/security/pii';
import { afterAll, describe, expect, it } from 'vitest';
import CAT from './__fixtures__/catalog.golden.json' with { type: 'json' };
import DAB from './__fixtures__/da_b2b.golden.json' with { type: 'json' };
import SRC from './__fixtures__/intel_sources.golden.json' with { type: 'json' };
import * as da from './da-b2b.js';
import * as kc from './kd-catalog.js';
import { daB2bMain, kdCatalogMain } from './kd-quote.command.js';
import * as kq from './kd-quote.js';

// Dịch phần THUẦN của tests/test_da_b2b.py + tests/test_kd_catalog.py; golden sinh từ hàm Python thật
// (agents/da_b2b.py read_csv/dedup_key/render_batch, crawler/intel.py nguồn tầng C, kd_catalog).

const tmp = mkdtempSync(join(tmpdir(), 'kdq-pure-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const w = (body: string | Buffer, name = 'x.csv') => {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
};
const HDR = 'org_name,org_type,region,website,source_url,fit_reason\n';
const OK_ROW =
  'Công ty MẪU X,doanh_nghiep,Đà Nẵng,https://x.example.com/,https://x.example.com/gt,MẪU — tặng quà Tết đối tác\n';
const MAU = repoPath('tests/fixtures/du_an/to_chuc_MAU.csv');
const LOI = repoPath('tests/fixtures/du_an/to_chuc_loi.csv');
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const noConnect = async () => {
  throw new Error('không được connect');
};

describe('da_b2b thuần', () => {
  it('dedup_key chuẩn hóa hoa/dấu/ký tự lạ (golden)', () => {
    for (const [k, v] of Object.entries(DAB.dedup)) {
      const [a, b] = k.split('|');
      expect(da.dedupKey(a, b), k).toBe(v);
    }
    const k = da.dedupKey('Khách sạn MẪU A', 'Đà Nẵng');
    expect(k).toMatch(/^b2b:[0-9a-f]{64}$/);
    expect(da.dedupKey('KHÁCH SẠN MẪU  A!', 'đà nẵng')).toBe(k);
    expect(da.dedupKey('Khách sạn MẪU A', 'Hà Nội')).not.toBe(k);
    for (const [s, v] of Object.entries(DAB.norm)) expect(da.norm(s), s).toBe(v);
  });

  it.each(Object.entries(DAB.csv))(
    'read_csv golden %s (lỗi có số dòng, KHÔNG giá trị ô)',
    (name, c) => {
      const body =
        c.body ??
        `${HDR}Công ty MẪU X,doanh_nghiep,Đà Nẵng,,https://x.example.com/,"${'a'.repeat(131073)}"\n`;
      const [rows, errs] = da.readCsv(w(body));
      expect([rows, errs], name).toEqual([c.rows, c.errs]);
    },
  );

  it('read_csv: byte lỗi / BOM / fixture MẪU + lỗi / thiếu file (golden)', () => {
    const bad = Buffer.concat([
      Buffer.from(HDR + OK_ROW),
      Buffer.from([0x43, 0x6f, 0x6e, 0x67, 0xff]),
      Buffer.from(',khac,Hue,,'),
    ]);
    expect(da.readCsv(w(bad))).toEqual(DAB.csv_bytes['bad-byte']);
    expect(
      da.readCsv(w(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HDR + OK_ROW)]))),
    ).toEqual(DAB.csv_bytes.bom);
    expect(da.readCsv(MAU)).toEqual(DAB.csv_bytes.mau);
    expect(da.readCsv(LOI)).toEqual(DAB.csv_bytes.loi);
    expect(da.readCsv(join(tmp, 'khong-co.csv'))).toEqual(DAB.csv_bytes.missing);
    const [, big] = da.readCsv(w(Buffer.alloc(da.MAX_BYTES + 1, 0x61)));
    expect(big[0]).toContain('1 MB');
  });

  it('fixture MẪU: ≥15 tổ chức, không PII, khóa không trùng', () => {
    const [rows, errs] = da.readCsv(MAU);
    expect(errs).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(new Set(rows.map((r) => r.dedup_key)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.org_name).toContain('MẪU');
      for (const k of ['org_name', 'region', 'website', 'source_url', 'fit_reason'] as const) {
        expect(PII_RE.test(r[k] ?? ''), k).toBe(false);
      }
    }
  });

  it('render_batch golden + footer KHÔNG tự liên hệ + escape |', () => {
    expect(da.renderBatch(DAB.rows_mau as da.OrgRow[])).toBe(DAB.render_batch);
    const md = da.renderBatch([
      {
        id: 1,
        dedup_key: `b2b:${'a'.repeat(64)}`,
        org_name: 'Tổ chức A|B',
        org_type: 'khac',
        region: 'Đà Nẵng',
        website: null,
        source_url: 'https://a.example.org/',
        fit_reason: null,
      },
    ]);
    expect(md).toBe(DAB.render_batch_escape);
    expect(md).toContain(da.FOOTER);
    expect(md).toContain('Tổ chức A\\|B');
    expect(md).toContain('KHÔNG tự liên hệ');
  });

  it('nguồn tầng C (crawler.intel): cấu hình thật + biến thể hỏng fail-closed (golden)', () => {
    const [cfg, errs] = da.loadSources(da.SOURCES_FILE);
    expect([cfg ? da.tierCHosts(cfg) : null, errs]).toEqual(SRC.ok);
    for (const [h, v] of Object.entries(SRC.blocked)) {
      expect(da.isBlocked(h, SRC.ok[0] as string[]), h).toBe(v);
    }
    const bodies: Record<string, string> = {
      hong: '{ hong',
      'khong-object': '[1]',
      'sources-rong': '{"topics":{"a":["x"]},"sources":[]}',
      'src-sai': JSON.stringify({
        topics: { a: ['x'] },
        llm: { enabled: 'x' },
        sources: [
          { id: 'A B', tier: 'D', url: 'ftp://x', kind: 'html', status: 'z' },
          'x',
          { id: 'ok', tier: 'C', url: 'https://www.Bad.com/x', kind: 'rss', status: 'duyet' },
          { id: 'ok', tier: 'C', url: 'https://c.com/', kind: 'rss', status: 'duyet' },
        ],
      }),
      'hop-le': JSON.stringify({
        topics: { a: ['x'] },
        sources: [
          { id: 'c1', tier: 'C', url: 'https://www.Bad.com/x', kind: 'rss', status: 'duyet' },
          { id: 'a1', tier: 'A', url: 'https://good.com/x', kind: 'atom', status: 'cho_duyet' },
        ],
      }),
    };
    for (const [k, b] of Object.entries(bodies)) {
      const [c2, e2] = da.loadSources(w(b, 'src.json'));
      expect([c2 ? da.tierCHosts(c2) : null, e2], k).toEqual((SRC as Record<string, unknown>)[k]);
    }
  });

  it('intel_sources.json hỏng → cả file bị từ chối (kể cả file sạch), CLI exit 1 không connect', async () => {
    const csvp = w(
      HDR + OK_ROW.replace('https://x.example.com/gt', 'https://www.linkedin.com/in/nguyen-van-a'),
    );
    const [rows, errs] = da.readCsv(csvp);
    expect(rows).toEqual([]);
    expect(errs.some((e) => e.includes('cột source_url') && e.includes('tầng C'))).toBe(true);
    const broken = w('{ hong', 'src.json');
    expect(da.readCsv(csvp, broken)[1][0]).toContain('intel_sources.json hỏng');
    expect(da.readCsv(w(HDR + OK_ROW, 'ok.csv'), broken)[0]).toEqual([]);
    const s = io();
    expect(
      await daB2bMain(
        { import: csvp, by: 'X' },
        { io: s.io, connect: noConnect, sourcesFile: broken },
      ),
    ).toBe(1);
    expect(s.err.join('\n')).toContain('KHÔNG nạp dòng nào');
    expect(s.err.join('\n')).not.toContain('nguyen-van-a');
  });

  it('fixture lỗi: CLI exit 1 không connect, không in giá trị ô', async () => {
    const s = io();
    expect(await daB2bMain({ import: LOI, by: 'X' }, { io: s.io, connect: noConnect })).toBe(1);
    const err = s.err.join('\n');
    expect(err).toContain('KHÔNG nạp dòng nào');
    for (const x of [
      '0905 123 456',
      'abc@gmail.com',
      'facebook.com/mau-l3',
      'zalo.me',
      'rượu sâm',
    ]) {
      expect(err).not.toContain(x);
    }
  });

  it.each([
    [{ import: 'a.csv', list: true, by: 'X' }],
    [{ submitBatch: true, list: true }],
    [{}],
    [{ import: 'a.csv' }],
    [{ handover: '1' }],
    [{ handover: '1', by: '  ' }],
    [{ submitBatch: true, limit: '0' }],
    [{ list: true, status: 'la' }],
    [{ handover: 'x', by: 'X' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await daB2bMain(o, { io: s.io, connect: noConnect })).toBe(2);
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(await daB2bMain({ import: MAU, by: 'X' }, { io: s.io, connect: async () => null })).toBe(
      2,
    );
    expect(s.err[0]).toContain('không kết nối được Postgres');
  });

  it('không có đường liên hệ (grep nguồn)', () => {
    const src = readFileSync(new URL('./da-b2b.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/nodemailer|smtp|node:https?|fetch\(|AiGateway|ai\/gateway/i);
  });
});

// ---------------------------------------------------------------- kd_catalog
const j = (p: string) => JSON.parse(readFileSync(repoPath(p), 'utf8'));
const GOLD = j('tests/fixtures/b2b/golden_MAU.json');
const MX = j('tests/fixtures/b2b/matrix_MAU.json');
const BOM = j('tests/fixtures/b2b/bom_MAU.json').combos;
const MX_REAL = j('data/b2b_pricing.json');
const SAMPLE_BOM = j('data/sample_bom.json').combos;
const GOLD_REAL = kq.readGolden(kq.GOLDEN_FILE)[0] as kq.Dict;
const DAY = '2026-10-12';
const PNG = Buffer.concat([kc.PNG_MAGIC, Buffer.alloc(64)]);
const ready = (golden: kq.Dict) =>
  new Map(
    (golden.skus as kq.Dict[]).flatMap((s) =>
      ['shopee', 'web'].map((ch) => [`${s.sku_key}\u0000${ch}`, 'QC_DAY_DU'] as [string, string]),
    ),
  );
const noMx300 = () => {
  const m = structuredClone(MX_REAL);
  delete m.items['mat-ong-sam-300ml'];
  return m;
};

describe('kd_catalog thuần', () => {
  it('eligible: loại rượu (mọi phần) + TPBVSK chưa XNQC + combo dính; không tên (golden)', () => {
    const [items, excl] = kc.eligible(GOLD, BOM);
    expect({ items, excluded: excl }).toEqual(CAT.eligible_none);
    expect(
      Object.fromEntries(
        ['items', 'excluded'].map((k, i) => [
          k,
          kc.eligible(GOLD, BOM, new Map([['savina-12v\u0000shopee', 'QC_DAY_DU']]), [
            'shopee',
            'web',
          ])[i],
        ]),
      ),
    ).toEqual(CAT.eligible_map);
    expect(
      Object.fromEntries(
        ['items', 'excluded'].map((k, i) => [
          k,
          kc.eligible(GOLD_REAL, SAMPLE_BOM, null, ['shopee', 'web'])[i],
        ]),
      ),
    ).toEqual(CAT.eligible_mirror);
    const codes = Object.fromEntries(excl.map((e) => [e.key, e.code]));
    expect(codes['hop-qua-cao-cap-mau']).toBe('ruou');
    expect(codes['hop-sum-vay-mau']).toBe('ruou');
    expect(codes['saphraton-80v']).toBe('tpbvsk_chua_xnqc');
    expect(excl.every((e) => Object.keys(e).sort().join() === 'code,key')).toBe(true);
  });

  it('build golden: MẪU / thật / bỏ 1 mã khỏi ma trận / ma trận lỗi / 0 mục / readiness gương golden', () => {
    expect(kc.build(GOLD, BOM, MX, { day: DAY, readiness: ready(GOLD) })).toEqual(CAT.build_mau);
    expect(
      kc.build(GOLD_REAL, SAMPLE_BOM, MX_REAL, { day: DAY, readiness: ready(GOLD_REAL) }),
    ).toEqual(CAT.build_real);
    expect(
      kc.build(GOLD_REAL, SAMPLE_BOM, noMx300(), { day: DAY, readiness: ready(GOLD_REAL) }),
    ).toEqual(CAT.build_real_no_300);
    expect(
      kc.build(GOLD, BOM, { ...MX, version: 0 }, { day: DAY, readiness: ready(GOLD) }),
    ).toEqual(CAT.build_mx_loi);
    expect(
      kc.build({ skus: [GOLD.skus.at(-1)] }, [], MX, { day: DAY, readiness: ready(GOLD) }),
    ).toEqual(CAT.build_none);
    expect(kc.build(GOLD, BOM, MX, { day: DAY, readiness: null })).toEqual(
      CAT.build_readiness_none,
    );
    expect(kc.excludedNames(GOLD, BOM, CAT.eligible_none.excluded)).toEqual(CAT.excluded_names);
    expect(kc.objectId(DAY, 'abc')).toBe(CAT.object_id);
    const md = CAT.build_mau.payload;
    expect(md).toContain('Quảng cáo');
    expect(md).toContain(kq.disclaimer());
    expect(md).toContain('| 10–49 | 5% | 707.000đ |');
    expect(md).not.toMatch(/rượu|ruou/i);
    expect(CAT.build_real.payload.split(kc.NO_PHOTO).length - 1).toBe(3);
  });

  it('packshot: chỉ PNG thật ≤ 10 MB, key không phải slug không đọc ngoài thư mục (golden)', () => {
    const d = join(tmp, 'pk');
    rmSync(d, { recursive: true, force: true });
    writeFileSync(w(PNG, 'x.png'), PNG);
    mkdirSync(d);
    writeFileSync(join(d, 'mat-ong-sam-120ml-1hu.png'), PNG);
    writeFileSync(join(d, 'mat-ong-sam-300ml.png'), 'GIF89a not png');
    const b = kc.build(GOLD_REAL, SAMPLE_BOM, MX_REAL, {
      day: DAY,
      packshotDir: d,
      readiness: ready(GOLD_REAL),
    });
    expect(b).toEqual(CAT.build_pk);
    expect(kq.renderHtml(b.payload)).toBe(CAT.build_pk_html);
    expect(kq.renderHtml(b.payload)).not.toContain('data:');
    expect(kc.packshot(d, '../x')).toBeNull();
    expect(kc.packshot(d, 'mat-ong-sam-120ml-1hu')).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(join(d, 'big.png'), Buffer.concat([PNG, Buffer.alloc(kc.MAX_PNG)]));
    expect(kc.packshot(d, 'big')).toBeNull();
    expect(kc.packshot(null, 'big')).toBeNull();
  });

  it('cổng chặn payload bị sửa: thêm tên rượu / bỏ nhãn "Quảng cáo"', () => {
    const b = kc.build(GOLD, BOM, MX, { day: DAY, readiness: ready(GOLD) });
    const names = kc.excludedNames(GOLD, BOM, b.excluded);
    expect(names).toContain('Rượu sâm chai thủy tinh 500ml');
    const o = { contentType: 'ads', readiness: kq.readinessMap(GOLD) };
    expect(kq.gateText(`${b.payload}\nRượu sâm chai thủy tinh 500ml\n`, names, o)).toContain(
      'ruou',
    );
    expect(kq.gateText(b.payload.replace('Quảng cáo\n', ''), names, o)).toContain(
      'guardrail:thieu_nhan_quang_cao',
    );
  });

  it('readBom: file BOM rỗng/hỏng/thiếu combos → ProductionError (production.read_json)', () => {
    expect(() => kc.readBom(w('{}', 'b.json'))).toThrow('b.json: không có dữ liệu (0 record)');
    expect(() => kc.readBom(w('{"_doc": "x"}', 'b.json'))).toThrow('không có dữ liệu');
    expect(() => kc.readBom(w('  ', 'b.json'))).toThrow('b.json rỗng');
    expect(() => kc.readBom(w('{x', 'b.json'))).toThrow('b.json JSON hỏng: JSONDecodeError');
    expect(() => kc.readBom(w('[1]', 'b.json'))).toThrow('b.json: root phải là object');
    expect(() => kc.readBom(w('{"combos": []}', 'b.json'))).toThrow(
      "'combos' phải là list không rỗng",
    );
    expect(() => kc.readBom(join(tmp, 'khong.json'))).toThrow('thiếu file khong.json');
    expect(kc.readBom(repoPath('data/sample_bom.json')).combos).toEqual(SAMPLE_BOM);
  });

  it.each([
    [{ build: true, submit: true }],
    [{ build: true, export: '1', out: 'x.md' }],
    [{ export: '1' }],
    [{ verifySend: ['1', 'x'], bom: 'y.json' }],
    [{}],
    [{ verifySend: ['x', 'y'] }],
    [{ build: true, date: '12/10/2026' }],
  ])('CLI tham số sai → exit 2 trước connect %j', async (o) => {
    const s = io();
    expect(await kdCatalogMain(o, { io: s.io, connect: noConnect })).toBe(2);
  });

  it('CLI BOM hỏng → exit 1 trước connect', async () => {
    const s = io();
    expect(
      await kdCatalogMain(
        { build: true, bom: w('{}', 'b.json'), outDir: tmp },
        { io: s.io, connect: noConnect },
      ),
    ).toBe(1);
    expect(s.err[0]).toContain('[error] BOM:');
  });

  it('CLI --build dùng giá đã duyệt + readiness DB (giả), không rượu trong file', async () => {
    const out = join(tmp, 'o');
    const prices = (golden: kq.Dict) => {
      const rows: {
        sku_key: string;
        channel: string;
        kind: string;
        price: string;
        id: string;
        approved_by: string;
      }[] = [];
      for (const s of golden.skus as kq.Dict[]) {
        for (const [ch, kinds] of Object.entries((s.prices ?? {}) as kq.Dict)) {
          for (const [k, v] of Object.entries(kinds as kq.Dict)) {
            if (k === 'list' || k === 'floor') {
              rows.push({
                sku_key: s.sku_key as string,
                channel: ch,
                kind: k,
                price: String(v),
                id: '0',
                approved_by: 'x',
              });
            }
          }
        }
      }
      return rows;
    };
    const readyRows = (GOLD_REAL.skus as kq.Dict[]).flatMap((s) =>
      ['shopee', 'web'].map((ch) => ({ sku_key: s.sku_key, channel: ch, readiness: 'QC_DAY_DU' })),
    );
    const fake = {
      query: async (sql: string) => {
        if (sql.includes('from price_list')) return { rows: prices(GOLD_REAL) };
        if (sql.includes('sku_readiness')) return { rows: readyRows };
        throw new Error(`SQL lạ: ${sql}`);
      },
    };
    const s = io();
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    const rc = await kdCatalogMain(
      { build: true, bom: repoPath('data/sample_bom.json'), outDir: out, date: '2026-10-12' },
      { io: s.io, connect: async () => ({ db: fake as never, release: async () => {} }) },
    ).finally(() => {
      settings.forceMode = null;
    });
    expect(rc, s.err.join('\n')).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toEqual(['catalog-tet-2026-10-12.html', 'catalog-tet-2026-10-12.md']);
    for (const f of files) expect(readFileSync(join(out, f), 'utf8')).not.toMatch(/rượu|ruou/i);
    expect(s.out.join('\n')).toContain('rượu loại 2');
  });
});
