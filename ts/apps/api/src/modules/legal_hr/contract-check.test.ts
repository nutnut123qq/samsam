import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { featureForReport } from '@samsam/core/rollout/rollout';
import { stripAccents } from '@samsam/core/security/py';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAUSES,
  type ContractCheckOpts,
  contractCheckMain,
  MAX_BYTES,
  missingClauses,
  satisfies,
} from './contract-check.js';

// Dịch tests/test_contract_check.py + tests/test_docx_p2.py::test_p2_contract_check_writes_counted_report:
// mẫu hợp đồng đủ điều khoản, bỏ từng điều khoản → báo đúng id, "cấm"≠"cảm"/"cam kết", nhãn AI≠đại
// từ "ai", bỏ dấu / CRLF, lỗi đầu vào exit 2, KHÔNG echo nội dung file, báo cáo `--out-dir` qua
// writeReport (nhãn CHẠY THỬ, không chép nội dung) và cổng TẮT không ghi.

const TEMPLATES: Record<string, string> = {
  koc: repoPath('docs/legal/mau-hop-dong-koc-NHAP.md'),
  dai_ly: repoPath('docs/legal/mau-hop-dong-dai-ly-NHAP.md'),
};
const CASES = Object.entries(CLAUSES).flatMap(([k, v]) => Object.keys(v).map((c) => [k, c]));
let TMP: string;
let seq = 0;
const file = (data: string | Buffer, name = 'hd.md') => {
  const d = join(TMP, `f${seq++}`);
  mkdirSync(d);
  const p = join(d, name);
  writeFileSync(p, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return p;
};
// Python `read_text` chuẩn hóa CRLF (checkout core.autocrlf=true).
const text = (kind: string) =>
  readFileSync(TEMPLATES[kind] as string, 'utf8').replaceAll('\r\n', '\n');
const run = async (o: ContractCheckOpts) => {
  const out: string[] = [];
  const err: string[] = [];
  const rc = await contractCheckMain(o, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
  });
  return { rc, out: out.join('\n'), err: err.join('\n') };
};

/** Bỏ MỌI đoạn (tách dòng trống) thỏa điều khoản `cid`. */
function dropClause(t: string, kind: string, cid: string): string {
  const paras = t.split(/\n[ \t]*\n/);
  const keep = paras.filter((p) => !satisfies(kind, cid, p));
  expect(keep.length, 'mỗi điều khoản đúng 1 đoạn').toBe(paras.length - 1);
  return keep.join('\n\n');
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'contract-check-'));
  wireCore(null);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  settings.forceMode = null;
});

describe('contract_check', () => {
  it('bộ điều khoản theo loại hợp đồng', () => {
    const common = [
      'nhan_quang_cao',
      'go_24h',
      'sku_duoc_phep',
      'cam_claim_suc_khoe',
      'cam_ruou',
      'bao_ve_dlcn',
      'gia_toi_thieu',
      'cham_dut',
    ];
    expect(Object.keys(CLAUSES.koc ?? {}).sort()).toEqual(
      [...common, 'nghia_vu_nguoi_chuyen_tai'].sort(),
    );
    expect(Object.keys(CLAUSES.dai_ly ?? {}).sort()).toEqual(
      [...common, 'cam_shop_trung_ten'].sort(),
    );
  });

  it.each(['dai_ly', 'koc'])('mẫu %s đủ điều khoản → exit 0', async (kind) => {
    expect(missingClauses(text(kind), kind)).toEqual([]);
    const r = await run({ kind, file: TEMPLATES[kind] });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('KHÔNG thay rà soát');
  });

  it.each(CASES)('bỏ điều khoản %s/%s → báo đúng id, exit 1', async (kind, cid) => {
    const t = dropClause(text(kind as string), kind as string, cid as string);
    expect(missingClauses(t, kind as string)).toEqual([cid]);
    const r = await run({ kind, file: file(t) });
    expect(r.rc).toBe(1);
    const lines = r.out.split('\n').filter((l) => l.startsWith('  - '));
    expect(lines).toEqual([`  - ${cid}: ${CLAUSES[kind as string]?.[cid as string]?.[0]}`]);
  });

  it('từ khóa phủ định đứng riêng / tách đoạn không đủ; "cam kết" ≠ "cấm", "chưa" ≠ "chữa"', () => {
    expect(missingClauses('Phụ lục: Rượu sâm 500ml', 'koc')).toContain('cam_ruou');
    const split = 'Bên B không được làm điều sau.\n\nQuảng cáo, khuyến mại sản phẩm rượu.';
    expect(missingClauses(split, 'koc')).toContain('cam_ruou');
    expect(missingClauses(split.replace('\n\n', ' '), 'koc')).not.toContain('cam_ruou');
    expect(missingClauses('Bên B cam kết quảng cáo rượu đúng luật.', 'koc')).toContain('cam_ruou');
    expect(
      missingClauses(
        'Bên B không được nói điều chưa kiểm chứng; câu khuyến cáo: không phải là thuốc.',
        'koc',
      ),
    ).toContain('cam_claim_suc_khoe');
  });

  // "cảm" (cảm nhận/cảm ơn/phản cảm) bỏ dấu cũng → "cam": KHÔNG được đếm là "cấm" — điều khoản CHO
  // PHÉP mà báo đủ là lỗi nặng nhất của công cụ này.
  it.each([
    ['koc', 'cam_ruou', 'KOC được quảng cáo rượu sâm và chia sẻ cảm nhận về sản phẩm.'],
    ['koc', 'cam_ruou', 'Được quảng cáo rượu sâm, cảm ơn Bên B.'],
    ['koc', 'cam_ruou', 'Quảng cáo rượu sâm, tránh hình ảnh phản cảm.'],
    [
      'koc',
      'cam_claim_suc_khoe',
      'KOC được nói sâm chữa bệnh, điều trị ung thư. Cảm ơn. Lưu ý: không phải là thuốc.',
    ],
    ['dai_ly', 'cam_shop_trung_ten', 'Đại lý được mở gian hàng trùng tên, cảm ơn.'],
    ['koc', 'cam_ruou', 'KOC duoc quang cao ruou sam va chia se cam nhan ve san pham.'],
    ['koc', 'cam_ruou', 'Quang cao ruou sam, tranh noi dung phan cam.'],
    ['dai_ly', 'cam_shop_trung_ten', 'Dai ly duoc mo gian hang trung ten, cam on.'],
    // \b Unicode như Python: "cấm" dính chữ Hán không phải từ "cấm" (JS \b ASCII sẽ khớp nhầm)
    ['koc', 'cam_ruou', 'cấm漢 quảng cáo rượu'],
  ])('"cảm"/"cam kết" không bị đếm là "cấm" (%s/%s)', (kind, cid, t) => {
    expect(missingClauses(t, kind)).toContain(cid);
  });

  it.each([
    ['koc', 'cam_ruou', 'Cấm quảng cáo rượu sâm.'],
    ['koc', 'cam_ruou', 'Bên B không được quảng cáo rượu sâm.'],
    ['koc', 'cam_ruou', 'Cam quang cao ruou sam.'],
    ['koc', 'cam_ruou', 'Ben B khong duoc quang cao ruou sam.'],
    ['koc', 'cam_claim_suc_khoe', 'Cấm nói chữa bệnh; khuyến cáo: không phải là thuốc.'],
    ['dai_ly', 'cam_shop_trung_ten', 'Cấm mở gian hàng trùng tên.'],
    ['dai_ly', 'cam_shop_trung_ten', 'Cam mo gian hang trung ten.'],
  ])('dạng "cấm" hợp lệ (%s/%s)', (kind, cid, t) => {
    expect(missingClauses(t, kind)).not.toContain(cid);
  });

  it('nhãn AI ≠ đại từ "ai"', () => {
    expect(missingClauses('Gắn nhãn hợp tác cho bất kỳ ai.', 'koc')).toContain('nhan_quang_cao');
    expect(missingClauses('Gắn nhãn quảng cáo, ai đăng thì người đó chịu.', 'koc')).toContain(
      'nhan_quang_cao',
    );
    expect(
      missingClauses('Gắn nhãn quảng cáo; nội dung có dùng AI gắn nhãn AI.', 'koc'),
    ).not.toContain('nhan_quang_cao');
    expect(
      missingClauses('Gắn nhãn quảng cáo; nội dung dùng trí tuệ nhân tạo phải ghi rõ.', 'koc'),
    ).not.toContain('nhan_quang_cao');
  });

  it('bản bỏ dấu / viết hoa / CRLF vẫn đủ', () => {
    const t = stripAccents(text('dai_ly'));
    expect(missingClauses(t, 'dai_ly')).toEqual([]);
    expect(missingClauses(t.toUpperCase(), 'dai_ly')).toEqual([]);
    expect(missingClauses(text('koc').replaceAll('\n', '\r\n'), 'koc')).toEqual([]);
  });

  it.each([
    ['missing', null, 'khong-co.md'],
    ['empty', Buffer.alloc(0), 'rong.md'],
    ['blank', ' \n\t\n', 'trang.txt'],
    ['ext', 'abc', 'hd.docx'],
    ['utf16', Buffer.from('﻿Điều', 'utf16le'), 'l1.txt'],
    ['big', Buffer.alloc(MAX_BYTES + 1, 0x61), 'lon.md'],
  ] as [string, string | Buffer | null, string][])(
    'đầu vào lỗi (%s) → exit 2, [err] ở stderr',
    async (_n, data, name) => {
      const p = data === null ? join(TMP, `nope${seq++}`, name) : file(data, name);
      const r = await run({ kind: 'koc', file: p });
      expect(r.rc).toBe(2);
      expect(r.err).toContain('[err]');
      expect(r.out).toBe('');
    },
  );

  it('kind sai / thiếu tham số → exit 2 (argparse)', async () => {
    let r = await run({ kind: 'ncc', file: TEMPLATES.koc });
    expect(r.rc).toBe(2);
    expect(r.err).toContain("invalid choice: 'ncc' (choose from 'dai_ly', 'koc')");
    r = await run({ kind: 'koc' });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('the following arguments are required: --file');
  });

  it('KHÔNG echo nội dung file (hợp đồng có dữ liệu đối tác)', async () => {
    const secret = 'DOI_TAC_BI_MAT_0123';
    const r = await run({
      kind: 'dai_ly',
      file: file(`${secret}\n\nĐiều 1. Không có gì.\n`, 'hd.txt'),
    });
    expect(r.rc).toBe(1);
    expect(r.out + r.err).not.toContain(secret);
  });

  it('--out-dir (chạy thử): báo cáo hd-mau- có nhãn CHẠY THỬ, chỉ mã điều khoản + sha, đếm được', async () => {
    expect(featureForReport('hd-mau-x.md')).toBe('legal_hr-05.1');
    settings.forceMode = 'chay_thu';
    const out = join(TMP, `rep${seq++}`);
    const r = await run({
      kind: 'koc',
      file: file('Hợp đồng KOC mẫu — điều khoản chung.', 'hd.txt'),
      outDir: out,
    });
    expect(r.rc).toBe(1); // thiếu điều khoản → exit 1
    const files = readdirSync(out).filter((f) => /^hd-mau-koc-[0-9a-f]{8}\.md$/.test(f));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(out, files[0] as string), 'utf8');
    expect(body.startsWith('> **CHẠY THỬ')).toBe(true);
    expect(body).not.toContain('Hợp đồng KOC mẫu');
    expect(body).toMatch(/File sha256 `[0-9a-f]{64}`/);
    expect(r.out).toContain('[done] ');
  });

  it('--out-dir khi tính năng TẮT → [rollout] exit 2, không ghi file', async () => {
    settings.forceMode = 'tat';
    const out = join(TMP, `rep${seq++}`);
    const r = await run({ kind: 'koc', file: TEMPLATES.koc, outDir: out });
    expect(r.rc).toBe(2);
    expect(r.err).toMatch(/^\[rollout\] .*legal_hr-05\.1/);
    expect(() => readdirSync(out)).toThrow();
  });

  it('không có đường ra mạng (không phải module egress)', () => {
    const src = readFileSync(new URL('./contract-check.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/node:(https?|net|tls|dgram)|fetch\(|undici/);
  });
});
