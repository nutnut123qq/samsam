import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { settings } from '@samsam/core/rollout/counters';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig as loadPhapChe } from '../ra_kenh/ra-kenh.js';
import { type XnqcDeps, type XnqcOpts, xnqcMain } from './xnqc.command.js';
import * as x from './xnqc.js';

// Dịch phần không DB của tests/test_xnqc.py (reminders biên đợt 2 / sắp hết hạn, golden_target, CLI
// usage exit 2 TRƯỚC connect, DB down exit 2) + tests/test_docx_p2.py::test_p2_xnqc_draft_payload…
// (nháp hồ sơ: số ĐKSP golden, danh mục CHƯA duyệt, guardrail maket, SKU không TPBVSK). Đường DB +
// danh tính theo login + cổng TẮT khi đẩy nháp ở legal-hr.db.test.ts.

const CFG = loadPhapChe();
const TP = ['savina-12v', 'savigout-30v'];
const d = (
  sku: string,
  status: string,
  het: string | null = null,
  id = 1,
  cap: string | null = '2026-09-01',
): x.Dossier => ({
  id,
  sku_key: sku,
  status,
  ngay_cap: cap,
  ngay_het_han: het,
  updated_by: 'Phap Che Gia Lap',
});
let TMP: string;

type Cap = { out: string[]; err: string[]; connects: number; queries: string[] };
const run = async (o: XnqcOpts, extra: Partial<XnqcDeps> = {}): Promise<[number, Cap]> => {
  const c: Cap = { out: [], err: [], connects: 0, queries: [] };
  const rc = await xnqcMain(o, {
    io: { out: (s) => c.out.push(s), err: (s) => c.err.push(s) },
    env: {},
    today: () => '2026-11-20',
    connect: async () => {
      c.connects += 1;
      throw new Error('không được connect DB');
    },
    wire: () => undefined,
    ...extra,
  });
  return [rc, c];
};

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'xnqc-'));
  wireCore(null);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  settings.forceMode = 'van_hanh';
});
afterEach(() => {
  settings.forceMode = null;
});

describe('xnqc — thuần', () => {
  it.each([
    ['2026-11-15', 'CHƯA NỘP', 15],
    ['2026-11-16', 'SẮP HẠN', 14],
    ['2026-11-30', 'SẮP HẠN', 0],
    ['2026-12-01', 'QUÁ HẠN', 1],
  ] as [string, string, number][])('nhắc mốc đợt 2 ở biên %s → %s', (today, prefix, n) => {
    const ms = x.reminders([], TP, CFG, today);
    expect(ms).toHaveLength(2);
    for (const m of ms) {
      expect(m.startsWith(prefix), m).toBe(true);
      expect(m).toContain(prefix !== 'QUÁ HẠN' ? `còn ${n} ngày` : `đã qua ${n} ngày`);
      expect(m).toContain('30/11/2026');
    }
  });

  it('giấy sắp/đã hết hạn; hết hạn → quay về nhắc chưa nộp; đang nộp/bổ sung → không nhắc', () => {
    const rows = [d('savigout-30v', 'da_cap', '2026-12-10', 7)];
    let ms = x.reminders(rows, TP, CFG, '2026-11-12');
    expect(
      ms.some((m) => m.startsWith('SẮP HẾT HẠN') && m.includes('#7') && m.includes('còn 28 ngày')),
    ).toBe(true);
    expect(
      ms.some((m) => /^(CHƯA NỘP|SẮP HẠN|QUÁ HẠN)/.test(m) && m.includes('savigout-30v')),
    ).toBe(false);
    ms = x.reminders(rows, TP, CFG, '2026-12-11');
    expect(
      ms.some((m) => m.startsWith('ĐÃ QUÁ HẠN — Pháp chế chuyển het_han') && m.includes('#7')),
    ).toBe(true);
    expect(ms.some((m) => m.startsWith('QUÁ HẠN đợt 2 — savigout-30v'))).toBe(true);
    expect(
      x.reminders([d('savina-12v', 'bo_sung'), d('savigout-30v', 'da_nop')], TP, CFG, '2026-11-16'),
    ).toEqual([]);
  });

  it('golden_target: approved/pending/none; giấy chưa tới ngày cấp KHÔNG phải approved', () => {
    const t = '2026-11-01';
    expect(x.goldenTarget([d('s', 'da_cap', '2027-01-01')], t)).toBe('approved');
    expect(x.goldenTarget([d('s', 'da_cap', null)], t)).toBe('approved');
    expect(x.goldenTarget([d('s', 'da_cap', '2026-10-01'), d('s', 'da_nop')], t)).toBe('pending');
    expect(x.goldenTarget([d('s', 'bo_sung')], t)).toBe('pending');
    expect(x.goldenTarget([d('s', 'chuan_bi'), d('s', 'het_han')], t)).toBe('none');
    expect(x.goldenTarget([], t)).toBe('none');
    expect(x.goldenTarget([d('s', 'da_cap', null, 1, t)], t)).toBe('approved');
    expect(x.goldenTarget([d('s', 'da_cap', null, 1, '2026-11-02')], t)).toBe('none');
    expect(x.goldenTarget([d('s', 'da_cap', null, 1, '2029-12-31'), d('s', 'da_nop')], t)).toBe(
      'pending',
    );
  });

  it('nháp hồ sơ XNQC (không submit): số ĐKSP golden, danh mục CHƯA duyệt, guardrail maket', async () => {
    const [payload, qid] = await x.draft(
      null,
      'savina-12v',
      'maket',
      'maket fb',
      'Savina tuýp 12 viên ngậm.',
      false,
    );
    expect(qid).toBeNull();
    expect(payload).toContain('8014/2021/ĐKSP');
    expect(payload).toContain('CHƯA được Pháp chế duyệt');
    expect(payload).toContain('Guardrail maket');
    await expect(x.draft(null, 'khong-co', 'maket', 'x', null, false)).rejects.toThrow(
      "SKU 'khong-co' không phải TPBVSK trong golden",
    );
  });
});

describe('xnqc — CLI', () => {
  const USAGE: [string, XnqcOpts][] = [
    ['by-agent', { set: '1', status: 'da_cap', by: 'agent:x' }],
    ['by-system', { set: '1', status: 'da_cap', by: '  System: y' }],
    ['by-trong', { set: '1', status: 'da_nop', by: '   ' }],
    ['by-dieu-khien', { set: '1', status: 'da_nop', by: 'Ten\x1bNguoi' }],
    ['ngay-cap-sai', { set: '1', status: 'da_cap', by: 'A', ngayCap: '2026-13-01' }],
    ['hai-thao-tac', { add: true, list: true }],
    ['today-sai', { remind: true, today: '16/11/2026' }],
    ['khong-thao-tac', {}],
    // --today CHỈ cho --remind/--sync-golden: đẩy "hôm nay" tới trước = ghi ngày cấp/nộp tương lai lọt
    // chặn → golden 'approved' cho giấy chưa cấp
    [
      'today-voi-set-nop',
      { set: '1', status: 'da_nop', by: 'A', ngayNop: '2026-10-01', today: '2030-01-01' },
    ],
    [
      'today-voi-set-cap',
      {
        set: '1',
        status: 'da_cap',
        by: 'A',
        soGiay: '1',
        ngayCap: '2029-12-31',
        docSha: 'a'.repeat(64),
        today: '2030-01-01',
      },
    ],
    [
      'today-voi-add',
      { add: true, sku: 'savigout-30v', loai: 'maket', ten: 'm', by: 'A', today: '2030-01-01' },
    ],
    ['today-voi-list', { list: true, today: '2030-01-01' }],
    ['loai-la', { add: true, sku: 's', loai: 'poster', ten: 'm', by: 'A' }],
    ['status-la', { set: '1', status: 'xong', by: 'A' }],
    ['set-khong-so', { set: 'abc', status: 'da_nop', by: 'A' }],
    ['set-thieu-status', { set: '1', by: 'A' }],
    ['add-thieu-ten', { add: true, sku: 's', loai: 'maket', by: 'A' }],
    ['maket-khong-draft', { list: true, maket: 'x.md' }],
    ['submit-khong-draft', { list: true, submit: true }],
    ['draft-thieu', { draft: true, sku: 'savina-12v' }],
    [
      'draft-maket-khong-doc-duoc',
      { draft: true, sku: 'savina-12v', loai: 'maket', ten: 't', maket: 'khong-co-file.md' },
    ],
  ];
  it.each(USAGE)('tham số sai → exit 2 TRƯỚC connect (%s)', async (_n, o) => {
    const [rc, c] = await run(o);
    expect(rc).toBe(2);
    expect(c.err.join('\n')).toMatch(/^xnqc: error: /);
    expect(c.connects).toBe(0);
  });

  it('DB không truy cập được → exit 2 (không treo)', async () => {
    const [rc, c] = await run({ list: true }, { connect: async () => null });
    expect(rc).toBe(2);
    expect(c.out.join('\n')).toContain('DB không truy cập được');
    const [rc2, c2] = await run(
      { draft: true, sku: 'savina-12v', loai: 'maket', ten: 't', submit: true },
      { connect: async () => null },
    );
    expect(rc2).toBe(2);
    expect(c2.out.join('\n')).toContain('DB không truy cập được');
  });

  it('--draft không --submit: in nháp, không connect; SKU không phải TPBVSK → exit 1', async () => {
    const mk = join(TMP, 'maket.md');
    writeFileSync(mk, 'Savina tuýp 12 viên ngậm.\r\n');
    let [rc, c] = await run({
      draft: true,
      sku: 'savina-12v',
      loai: 'maket',
      ten: 'maket fb',
      maket: mk,
    });
    expect(rc).toBe(0);
    expect(c.out.join('\n')).toContain('## Maket / kịch bản đưa vào');
    expect(c.out.join('\n')).not.toContain('[ok] nháp hồ sơ');
    expect(c.connects).toBe(0);
    [rc, c] = await run({ draft: true, sku: 'ruou-sam', loai: 'maket', ten: 't' });
    expect(rc).toBe(1);
    expect(c.out.join('\n')).toContain("[err] SKU 'ruou-sam' không phải TPBVSK trong golden");
  });

  it('--draft --submit khi legal_hr-02 TẮT → [err] exit 1, KHÔNG câu SQL nào (cổng trước enqueue)', async () => {
    settings.forceMode = 'tat';
    wireCore(null);
    const queries: string[] = [];
    const fake = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    } as unknown as Db;
    const [rc, c] = await run(
      { draft: true, sku: 'savina-12v', loai: 'maket', ten: 'maket fb', submit: true },
      { connect: async () => ({ db: fake, release: async () => {} }) },
    );
    expect(rc).toBe(1);
    expect(c.out.join('\n')).toMatch(/\[err\] .*legal_hr-02.*không sinh đầu ra/);
    expect(queries).toEqual([]);
  });
});
