import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireCore } from '@samsam/core/ops/wire';
import { REPO_ROOT, repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { check } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PcHrDeps, type PcHrOpts, pcHrMain } from './pc-hr.command.js';
import * as h from './pc-hr.js';

// Dịch tests/test_pc_hr.py (phần không DB) + tests/test_r12_dot2.py::test_pc_hr_off: chọn thao tác,
// exit code, fail-closed TRƯỚC connect (cấu hình hỏng, guardrail, file chấm công lỗi), tính năng TẮT
// chặn trước khi đọc CV/file, không PII trong payload/stdout. Phần DB ở legal-hr.db.test.ts; phần
// thuần đối chiếu golden Python ở legal-hr.golden.test.ts.

const HDR = 'ma_nv,ngay,gio_vao,gio_ra\n';
const TODAY = '2026-11-05'; // tháng 10/2026 đã đóng
const GOOD =
  'NV001,2026-10-01,07:55,17:00\n' +
  'NV001,2026-10-02,08:05,17:00\n' +
  'NV001,2026-10-05,08:20,16:50\n' +
  'NV001,2026-10-06,08:00,\n' +
  'NV001,2026-10-10,08:30:00,11:00\n' +
  'nv-02,06/10/2026,08:00,17:00\n';
const CV_A =
  'Nguyễn Văn An — 0901 234 567 — an.nguyen@mail.test\n' +
  '3 năm vận hành gian hàng Shopee, chạy Shopee Ads, dùng Excel.\n';
const CV_B = 'Trần Thị Bình, 0912345678. Kinh nghiệm TikTok Shop, livestream.\n';
const CV_C = 'Lê C. Thành thạo Google Sheets, quản lý gian hàng Lazada.\n';

let TMP: string;
let seq = 0;
const fresh = () => {
  const d = join(TMP, `t${seq++}`);
  mkdirSync(d);
  return d;
};
const csv = (body: string, name = 'cc.csv') => {
  const p = join(fresh(), name);
  writeFileSync(p, Buffer.from(HDR + body, 'utf8'));
  return p;
};
/** Thư mục CV như tests/test_pc_hr.py `_inbox` (7 file .txt/.md, 1 cặp trùng, .pdf + thư mục con). */
function inbox(base: string): string {
  const d = join(base, 'inbox');
  mkdirSync(d);
  writeFileSync(join(d, 'NguyenVanAn_0901234567.txt'), CV_A);
  writeFileSync(join(d, 'an_copy.md'), CV_A);
  writeFileSync(join(d, 'binh.txt'), CV_B);
  writeFileSync(join(d, 'c.md'), `\ufeff${CV_C}`);
  writeFileSync(join(d, 'rong.txt'), '');
  writeFileSync(join(d, 'bom_only.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x20, 0x20, 0x0a]));
  writeFileSync(join(d, 'cp1258.txt'), Buffer.from([0x54, 0x72, 0xe0, 0x6e, 0x20, 0xff]));
  writeFileSync(join(d, 'cv.pdf'), '%PDF-1.4');
  mkdirSync(join(d, 'sub'));
  return d;
}

type Cap = { out: string[]; err: string[]; connects: number };
const run = async (o: PcHrOpts, extra: Partial<PcHrDeps> = {}): Promise<[number, Cap]> => {
  const c: Cap = { out: [], err: [], connects: 0 };
  const rc = await pcHrMain(o, {
    io: { out: (s) => c.out.push(s), err: (s) => c.err.push(s) },
    env: {},
    today: () => TODAY,
    connect: async () => {
      c.connects += 1;
      throw new Error('không được connect DB');
    },
    wire: () => undefined,
    ...extra,
  });
  return [rc, c];
};
const outOf = (c: Cap) => c.out.join('\n');

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'pc-hr-'));
  wireCore(null);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
});
afterEach(() => {
  settings.forceMode = null;
});

describe('pc_hr — thuần', () => {
  it('norm + so khớp theo từ trọn vẹn', () => {
    expect(h.norm('Thương mại ĐIỆN TỬ, e-Commerce!')).toBe('thuong mai dien tu e commerce');
    expect(h.norm('TMĐT')).toBe('tmdt');
    const t = h.norm('Từng làm Samsung; 3 năm ở Shopee-Mall');
    expect(h.hasKw(t, 'shopee')).toBe(true);
    expect(h.hasKw(t, 'sam')).toBe(false); // 'samsung' không chứa từ 'sam'
    expect(h.hasKw(h.norm('Sâm Ngọc Linh'), h.norm('sâm ngọc linh'))).toBe(true);
  });

  it('mọi vị trí trong repo hợp lệ, nháp JD qua guardrail; file BẢN DEV SOẠN', () => {
    const raw = JSON.parse(readFileSync(h.JD_FILE, 'utf8'));
    expect(raw._doc).toContain('BẢN DEV SOẠN');
    for (const key of Object.keys(raw.positions)) {
      const g = check(h.renderJd(h.loadPosition(key)));
      expect(g.ok, `${key} ${JSON.stringify(g.violations)}`).toBe(true);
    }
    expect(JSON.parse(readFileSync(h.RULES_FILE, 'utf8'))._doc).toContain('GIẢ ĐỊNH');
  });

  it('tiêu chí tuổi không nhầm với tưới/tươi (review v12)', () => {
    for (const ok of ['tưới tiêu', 'sâm tươi', 'kinh nghiệm tưới nước', 'tuoi cay']) {
      expect(h.bias(ok), ok).toBe(false);
    }
    for (const bad of [
      'tuổi 25-35',
      'độ tuổi',
      'TUỔI dưới 30',
      'tuoi 25',
      'tuoi tu 22',
      'tuoi duoi 30',
      'giới tính nam',
    ]) {
      expect(h.bias(bad), bad).toBe(true);
    }
  });

  it('payload sàng lọc KHÔNG có tên/SĐT/email/tên file, qua guardrail, không tự loại ai', () => {
    const pos = h.loadPosition('nv_van_hanh_san');
    const [cands, skipped, err] = h.readCvs(inbox(fresh()));
    expect([err, skipped, cands.length]).toEqual([null, 2, 6]); // .pdf + thư mục con; 7 file, 1 cặp trùng
    const ranked = h.rank(pos, cands);
    expect(ranked).toHaveLength(cands.length);
    const text = h.renderScreening(pos, ranked, skipped);
    for (const leak of [
      'Nguyễn',
      'Bình',
      '0901',
      '234 567',
      '0912345678',
      '@mail.test',
      'NguyenVanAn',
      'binh.txt',
      'cp1258',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(text).toContain('không phải UTF-8');
    expect(text).toContain('KHÔNG loại ai');
    expect(text).toContain('| 1 | `');
    expect(text).toContain('2/2');
    expect(text).toContain('THIẾU:');
    expect(check(text).ok).toBe(true);
  });

  it('insideRepo: gốc repo + thư mục con = trong; tmp = ngoài', () => {
    expect(h.insideRepo(REPO_ROOT)).toBe(true);
    expect(h.insideRepo(repoPath('data'))).toBe(true);
    expect(h.insideRepo(TMP)).toBe(false);
    expect(h.insideRepo(join(REPO_ROOT, '..', 'samsam-khac'))).toBe(false);
  });
});

describe('pc_hr — CLI', () => {
  it('--screen --dry-run: bảng mã ↔ tên file che SĐT, không connect', async () => {
    const d = inbox(fresh());
    const [rc, c] = await run(
      { screen: true, jd: 'nv_van_hanh_san', dryRun: true },
      { env: { HR_INBOX_DIR: d } },
    );
    expect(rc).toBe(0);
    const out = outOf(c);
    expect(out).toContain('[map]');
    expect(out).not.toContain('0901234567');
    expect(out).toContain('[dry-run] hr_screening `screen:nv_van_hanh_san:');
    expect(c.connects).toBe(0);
  });

  const USAGE: [string, PcHrOpts][] = [
    ['rong', {}],
    ['screen-thieu-jd', { screen: true }],
    ['dir-trong-repo', { screen: true, jd: 'x', dir: '.' }],
    ['month-voi-jd', { jd: 'nv_cskh', month: '2026-10' }],
    ['dir-voi-jd', { jd: 'nv_cskh', dir: '/tmp' }],
    ['att-voi-jd', { attendance: 'a.csv', jd: 'nv_cskh', month: '2026-10' }],
    ['att-voi-screen', { attendance: 'a.csv', screen: true, month: '2026-10' }],
    ['att-thieu-month', { attendance: 'a.csv' }],
    ['month-sai', { attendance: 'a.csv', month: '10/2026' }],
    ['month-tuong-lai', { attendance: 'a.csv', month: '2026-12' }],
    ['month-13', { attendance: 'a.csv', month: '2026-13' }],
  ];
  it.each(USAGE)('tham số sai → exit 2 trước connect (%s)', async (_n, o) => {
    const [rc, c] = await run(o);
    expect(rc).toBe(2);
    expect(c.err.join('\n')).toMatch(/^pc_hr: error: /);
    expect(c.connects).toBe(0);
  });

  it('--screen cần thư mục CV NGOÀI repo (HR_INBOX_DIR trong repo → exit 2)', async () => {
    expect((await run({ screen: true, jd: 'nv_cskh' }))[0]).toBe(2);
    const [rc, c] = await run(
      { screen: true, jd: 'nv_cskh' },
      { env: { HR_INBOX_DIR: repoPath('data') } },
    );
    expect(rc).toBe(2);
    expect(c.err.join('')).toContain('TRONG repo');
  });

  it('thư mục rỗng / không tồn tại → exit 1, không connect', async () => {
    const e = fresh();
    writeFileSync(join(e, 'x.pdf'), 'x');
    let [rc, c] = await run({ screen: true, jd: 'nv_cskh', dir: e });
    expect(rc).toBe(1);
    expect(outOf(c)).toContain('không có hồ sơ');
    [rc, c] = await run({ screen: true, jd: 'nv_cskh', dir: join(e, 'khong') });
    expect(rc).toBe(1);
    expect(outOf(c)).toContain('thư mục hồ sơ không tồn tại');
    expect(c.connects).toBe(0);
  });

  it('cấu hình lỗi / guardrail trượt → exit 1 fail-closed, không connect', async () => {
    let [rc, c] = await run({ jd: 'ke_toan', dryRun: true });
    expect(rc).toBe(1);
    expect(outOf(c)).toContain('không có vị trí');
    [rc, c] = await run(
      { jd: 'nv_cskh' },
      { guardrail: () => ({ ok: false, violations: [{ type: 'banned_word' }] }) },
    );
    expect(rc).toBe(1);
    expect(outOf(c)).toContain('banned_word');
    expect(outOf(c)).toContain('không đẩy');
    expect(c.connects).toBe(0);
    // thư mục GĐ khối hỏng (director.load_config) cũng là lỗi cấu hình
    [rc, c] = await run({ jd: 'nv_cskh', dryRun: true }, { directorsDir: fresh() });
    expect(rc).toBe(1);
    expect(outOf(c)).toContain('[err] cấu hình: không có file legal_hr.json');
  });

  it('DB down → exit 2', async () => {
    const [rc, c] = await run({ jd: 'nv_cskh' }, { connect: async () => null });
    expect(rc).toBe(2);
    expect(c.err.join('')).toContain('không kết nối được Postgres');
  });

  it('--attendance --dry-run: tổng hợp theo mã NV; file lỗi → exit 1 không connect', async () => {
    let [rc, c] = await run({ attendance: csv(GOOD), month: '2026-10', dryRun: true });
    expect(rc).toBe(0);
    let out = outOf(c);
    expect(out).toContain('| `NV001` | 4 | 1/20 | 1/10 | 1 | 18 | 1 |');
    expect(out).toContain('Kỳ ĐÃ ĐÓNG');
    expect(out).toContain('KHÔNG tính lương');
    expect(out).toMatch(/\[dry-run\] hr_attendance `att:2026-10:[0-9a-f]{12}`/);
    [rc, c] = await run({
      attendance: csv('NV1,2026-10-01,17:00,08:00\n', 'bad.csv'),
      month: '2026-10',
    });
    expect(rc).toBe(1);
    out = outOf(c);
    expect(out).toContain('không connect, không ghi gì');
    expect(c.connects).toBe(0);
  });

  it('--attendance lỗi in tối đa 30 dòng + tổng số lỗi, không in giá trị ô', async () => {
    let body = '';
    for (let i = 0; i < 40; i++)
      body += `0901234${String(i).padStart(3, '0')},2026-10-01,08:00,17:00\n`;
    const [rc, c] = await run({ attendance: csv(body), month: '2026-10' });
    expect(rc).toBe(1);
    expect(c.out.filter((l) => l.startsWith('[err] dòng'))).toHaveLength(30);
    expect(c.out).toContain('[err] ... và 10 lỗi khác');
    expect(c.out).toContain('[err] 40 lỗi — không connect, không ghi gì.');
    expect(outOf(c)).not.toContain('0901234');
  });

  it('--attendance tháng chưa đóng: vắng chỉ tính tới hôm qua', async () => {
    const [rc, c] = await run({
      attendance: csv('NV1,2026-11-02,08:00,17:00\n'),
      month: '2026-11',
      dryRun: true,
    });
    expect(rc).toBe(0);
    const out = outOf(c);
    // hôm nay 05/11 → vắng tính tới 04/11: ngày làm 02,03,04 — chấm 02
    expect(out).toContain('CHƯA ĐÓNG — vắng chỉ tính tới 04/11/2026');
    expect(out).toContain('| `NV1` | 1 | 0/0 | 0/0 | 0 | 2 | 0 |');
  });

  it.each([
    ['jd', { jd: 'nv_van_hanh_san' }, 'legal_hr-06.1'],
    ['screen', { screen: true, jd: 'nv_cskh', dir: 'khong-co-thu-muc' }, 'legal_hr-06.2'],
    ['attendance', { attendance: 'khong-co.csv', month: '2026-10' }, 'legal_hr-06.3'],
  ] as [string, PcHrOpts, string][])(
    'tính năng TẮT (%s) → [rollout] exit 2 TRƯỚC đọc cấu hình/CV/file, không connect',
    async (_n, o0, fid) => {
      settings.forceMode = 'tat';
      // đường dẫn KHÔNG tồn tại, ngoài repo: bị đọc thì đã ra exit 1, không phải [rollout]
      const o = { ...o0 };
      if (o.dir) o.dir = join(TMP, o.dir);
      if (o.attendance) o.attendance = join(TMP, o.attendance);
      const [rc, c] = await run(o, { directorsDir: fresh() });
      expect(rc).toBe(2);
      expect(c.out).toHaveLength(1);
      expect(c.out[0]).toMatch(/^\[rollout\] /);
      expect(c.out[0]).toContain(fid);
      expect(c.connects).toBe(0);
    },
  );

  it('chạy thử vẫn sinh (dry-run in payload)', async () => {
    settings.forceMode = 'chay_thu';
    const [rc, c] = await run({ jd: 'nv_cskh', dryRun: true });
    expect(rc).toBe(0);
    expect(outOf(c)).toMatch(/\[dry-run\] hr_jd `jd:nv_cskh:[0-9a-f]{12}`/);
  });
});
