import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { catalog } from '@samsam/core/rollout/rollout';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import G from './__fixtures__/doc_intake.golden.json' with { type: 'json' };
import * as di from './doc-intake.js';
import { MAX_WORK } from './pdf-text.js';
import {
  AbortingDb,
  cap,
  FakeDb,
  makePdf,
  makePdfPages,
  pdfOnePage,
  pdfSelfForm,
  pdfStream,
  RaceDb,
} from './sx-docs.testing.js';

// Dịch tests/test_doc_intake.py (+ phần doc_intake của test_r13_batch_a.py, test_v13_c05_media.py,
// test_r14_code_gaps.py, test_v15_p12_policies.py): PDF fixture VIẾT TAY + Db giả ghi SQL. Không chạm
// DB thật, không mạng (fetch bị chặn — chỉ provider paddle_local gọi AI worker GIẢ trên loopback).

const PHONE = '0901234567';
const GIAY = ['So: 1234/2024/DKSP', 'ngay 05/03/2024', 'Ten san pham: Sam Ngoc Linh X'];
const SHA = 'a'.repeat(64);
const TMP = mkdtempSync(join(tmpdir(), 'sxdocs-di-'));
const ENC_PDF = Buffer.from(
  (G.pdfs.find((p) => p.name === 'encrypted') as { b64: string }).b64,
  'base64',
);
const ENV = { NODE_ENV: 'test' };

let dirs: { intake: string; orig: string; root: string };
let fetchCalls: unknown[];
const saved = { ...di.PROVIDERS };

beforeEach(() => {
  const root = mkdtempSync(join(TMP, 't-'));
  dirs = { root, intake: join(root, 'intake'), orig: join(root, 'originals') };
  mkdirSync(join(dirs.intake, 'giay_tiep_nhan'), { recursive: true });
  fetchCalls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...a) => {
    fetchCalls.push(a);
    throw new Error('không được gọi mạng');
  });
  fake('van_hanh');
});
/** Rollout giả (giai đoạn `quick`/`stages`) + danh mục THẬT (cổng loader kiểm mã tính năng). */
const fake = (quick: string | null, stages: Record<string, string> = {}) =>
  installFakeDeps({}, { quick, stages, catalog: catalog() as { id: string }[] });
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(di.PROVIDERS)) if (!(k in saved)) delete di.PROVIDERS[k];
  Object.assign(di.PROVIDERS, saved);
  resetOpsDeps();
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function put(base: string, rel: string, data: Buffer | string): string {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}
const intake = (db: FakeDb, provider = 'none', log: string[] = []) =>
  di.intake(dirs.intake, dirs.orig, db.db, provider, { env: ENV, log: (s) => log.push(s) });
const insDocs = (db: FakeDb) =>
  db.sql.filter(([s]) => s.startsWith('insert into documents')).map(([, p]) => p);

// ------------------------------------------------------------ golden thuần
describe('golden Python (extract_fields / has_pii / _nonspace_len / doc_type_of)', () => {
  it.each(G.fields as [string, Record<string, [string, number]>][])('fields %#', (t, want) => {
    expect(di.extractFields(t)).toEqual(want);
  });
  it.each(G.pii as [string, boolean][])('has_pii %#', (t, want) => {
    expect(di.hasPii(t)).toBe(want);
  });
  it.each(G.nonspace as [string, number][])('nonspace %#', (t, want) => {
    expect(di.nonspaceLen(t)).toBe(want);
  });
  it.each(G.doc_type as [string, string][])('doc_type %s', (rel, want) => {
    expect(di.docTypeOf(join('I', rel), 'I')).toBe(want);
  });
});

// ------------------------------------------------------------ W38.5 trích field
describe('trích chữ + field', () => {
  it('PDF ascii → pdf_text + 3 field', async () => {
    const p = put(dirs.root, 'g.pdf', makePdf(GIAY));
    const [text, pages, src] = await di.extractText(p);
    expect([pages, src]).toEqual([1, 'pdf_text']);
    const f = di.extractFields(text);
    expect(f.so_giay).toEqual(['1234/2024/DKSP', 1.0]);
    expect(f.ngay_cap).toEqual(['2024-03-05', 1.0]);
    expect(f.ten_san_pham).toEqual(['Sam Ngoc Linh X', 1.0]);
  });

  it('nhiều trang đủ chữ → pdf_text, có PII', async () => {
    const p = put(dirs.root, 'm.pdf', makePdfPages([GIAY, [...GIAY, `Dien thoai: ${PHONE}`]]));
    const [text, pages, src] = await di.extractText(p);
    expect([pages, src]).toEqual([2, 'pdf_text']);
    expect(di.hasPii(text)).toBe(true);
  });

  it('PDF mã hoá / hỏng → DocError', () => {
    expect(() => di.pdfPageTexts(put(dirs.root, 'e.pdf', ENC_PDF))).toThrow('PDF mã hoá');
    expect(() => di.pdfPageTexts(put(dirs.root, 'x.pdf', '%PDF-1.4\ngarbage'))).toThrow(
      /^PDF hỏng: /,
    );
  });
});

// ------------------------------------------------------------ W38.4 PII
it('pii_flag đúng từng tài liệu; stdout không lộ SĐT/tên tệp/nội dung', async () => {
  const name = 'hop dong Nguyen Van A.pdf';
  put(dirs.intake, `giay_tiep_nhan/${name}`, makePdf([...GIAY, `Dien thoai: ${PHONE}`]));
  put(dirs.intake, 'giay_tiep_nhan/b.pdf', makePdf([...GIAY, 'gia 1.500.000']));
  const db = new FakeDb();
  const log: string[] = [];
  const c = await intake(db, 'none', log);
  expect([c.new, c.error]).toEqual([2, 0]);
  expect(
    insDocs(db)
      .map((p) => p[5])
      .sort(),
  ).toEqual([false, true]);
  const out = log.join('\n');
  for (const leak of [PHONE, name, 'Nguyen Van A', 'Sam Ngoc Linh', 'Dien thoai']) {
    expect(out).not.toContain(leak);
  }
});

// ------------------------------------------------------------ W38.2 idempotent + bản gốc
describe('intake idempotent + bản gốc bất biến', () => {
  it('chạy 2 lần → 1 bản ghi, bản gốc không đổi, không sót tệp tạm, không xóa tệp nguồn', async () => {
    const p = put(dirs.intake, 'giay_tiep_nhan/g.pdf', makePdf(GIAY));
    const sha = di.sha256File(p);
    const db = new FakeDb();
    expect(await intake(db)).toEqual({ new: 1, dup: 0, cho_ocr: 0, skipped: 0, error: 0 });
    const o = join(dirs.orig, sha);
    const before = [readFileSync(o), statSync(o).mtimeMs];
    const nFields = db.count('insert into document_fields');
    const c2 = await intake(db);
    expect([c2.dup, c2.new]).toEqual([1, 0]);
    const ins = db.sql.filter(([s, p0]) => s.startsWith('insert into documents') && p0[0] === sha);
    expect(ins.map(([, , rc]) => rc)).toEqual([1]); // đúng 1 lần, rowCount 1
    expect(db.count('insert into document_fields')).toBe(nFields);
    expect(nFields).toBe(3);
    expect([...db.fields.values()].every((v) => v[2] === false)).toBe(true);
    expect([readFileSync(o), statSync(o).mtimeMs]).toEqual(before);
    expect(readFileSync(o)).toEqual(readFileSync(p));
    expect(existsSync(p)).toBe(true);
    expect(readdirSync(dirs.orig)).toEqual([sha]);
  });

  it('bản gốc có sẵn mà lệch hash → không ghi đè, lỗi 1 tệp, lô chạy tiếp', async () => {
    const p = put(dirs.intake, 'giay_tiep_nhan/g.pdf', makePdf(GIAY));
    const sha = di.sha256File(p);
    mkdirSync(dirs.orig);
    writeFileSync(join(dirs.orig, sha), 'khac noi dung');
    const nxt = put(dirs.intake, 'nhan/z.pdf', makePdf(['Nhan san pham abc xyz 123']));
    const db = new FakeDb();
    const c = await intake(db);
    expect(readFileSync(join(dirs.orig, sha), 'utf8')).toBe('khac noi dung');
    expect([c.error, c.new]).toEqual([1, 1]);
    expect(db.docs.has(sha)).toBe(false);
    expect(db.docs.has(di.sha256File(nxt))).toBe(true);
    expect(() => di.storeOriginal(p, sha, dirs.orig)).toThrow(di.DocError);
    expect(() => di.storeOriginal(p, 'x', dirs.orig)).toThrow('sha256 không hợp lệ');
  });

  it('cùng nội dung 2 tên → 1 bản ghi, 1 bản gốc', async () => {
    const data = makePdf(GIAY);
    put(dirs.intake, 'giay_tiep_nhan/a.pdf', data);
    put(dirs.intake, 'giay_tiep_nhan/b.pdf', data);
    const db = new FakeDb();
    const c = await intake(db);
    expect([c.new, c.dup]).toEqual([1, 1]);
    expect(db.docs.size).toBe(1);
    expect(readdirSync(dirs.orig)).toHaveLength(1);
  });
});

// ------------------------------------------------------------ biên intake
describe('biên intake', () => {
  it('thư mục không tồn tại → toàn 0', async () => {
    const c = await di.intake(join(dirs.root, 'khong-co'), join(dirs.root, 'o'), new FakeDb().db);
    expect(c).toEqual({ new: 0, dup: 0, cho_ocr: 0, skipped: 0, error: 0 });
  });
  it('thư mục rỗng → 0 SQL', async () => {
    const db = new FakeDb();
    const c = await intake(db);
    expect(Object.values(c).reduce((a, b) => a + b)).toBe(0);
    expect(db.sql).toEqual([]);
  });
  it('tệp 0 byte → skipped, không SQL, không tạo kho bản gốc', async () => {
    put(dirs.intake, 'giay_tiep_nhan/rong.pdf', '');
    const db = new FakeDb();
    expect((await intake(db)).skipped).toBe(1);
    expect(db.sql).toEqual([]);
    expect(existsSync(dirs.orig)).toBe(false);
  });
  it('đuôi lạ / không đuôi → skipped', async () => {
    put(dirs.intake, 'giay_tiep_nhan/a.docx', 'PK..');
    put(dirs.intake, 'giay_tiep_nhan/noext', 'x');
    put(dirs.intake, 'giay_tiep_nhan/.pdf', 'x'); // tệp ẩn tên ".pdf" — Python suffix '' → không nhận
    const c = await intake(new FakeDb());
    expect([c.skipped, c.new]).toEqual([3, 0]);
  });
  it('PDF hỏng + PDF mã hoá → error, lô chạy tiếp', async () => {
    put(dirs.intake, 'giay_tiep_nhan/1.pdf', '%PDF-1.4\ngarbage');
    put(dirs.intake, 'giay_tiep_nhan/2.pdf', ENC_PDF);
    const ok = put(dirs.intake, 'giay_tiep_nhan/3.pdf', makePdf(GIAY));
    const db = new FakeDb();
    const log: string[] = [];
    const c = await intake(db, 'none', log);
    expect([c.error, c.new]).toEqual([2, 1]);
    expect([...db.docs.keys()]).toEqual([di.sha256File(ok)]);
    expect(log.join('\n')).toContain('[err] #2 PDF mã hoá');
  });
  it('PDF vượt trần công việc (Form lồng gọi lặp) → error "PDF hỏng: LimitReachedError", lô chạy tiếp', async () => {
    const res = '/Resources << /Font << /F1 3 0 R >> /XObject << /Y 7 0 R >> >>';
    put(
      dirs.intake,
      'giay_tiep_nhan/1.pdf',
      pdfOnePage('/X Do', '/XObject << /X 6 0 R >>', [
        pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 1 1] ${res}`, '/Y Do '.repeat(100)),
        pdfStream(
          `/Type /XObject /Subtype /Form /BBox [0 0 1 1] ${res} /Filter /FlateDecode`,
          deflateSync(Buffer.alloc(MAX_WORK / 64, 0x20)),
        ),
      ]),
    );
    put(dirs.intake, 'giay_tiep_nhan/2.pdf', makePdf(GIAY));
    const log: string[] = [];
    const c = await intake(new FakeDb(), 'none', log);
    expect([c.error, c.new]).toEqual([1, 1]);
    expect(log.join('\n')).toContain('[err] #1 PDF hỏng: LimitReachedError');
  });
  it('Form tự tham chiếu + watermark ngắn → cho_ocr, pii NULL như pypdf (không nhân bản chữ)', async () => {
    put(dirs.intake, 'giay_tiep_nhan/w.pdf', pdfSelfForm('Scanned with CamScanner', 5));
    const db = new FakeDb();
    const c = await intake(db);
    expect([c.new, c.cho_ocr, c.error]).toEqual([1, 1, 0]);
    expect(insDocs(db)[0].slice(4)).toEqual(['none', null, 'cho_ocr']);
  });
  it('field chỉ trích cho giay_tiep_nhan', async () => {
    put(dirs.intake, 'hop_dong_dai_ly/h.pdf', makePdf(GIAY));
    const db = new FakeDb();
    await intake(db);
    expect(db.fields.size).toBe(0);
    expect([...db.docs.values()]).toEqual(['pending_review']);
  });
});

// ------------------------------------------------------------ W38.3 OCR provider, không mạng
describe('OCR provider', () => {
  it('PDF scan + ảnh → cho_ocr, pii NULL, 0 mạng', async () => {
    put(dirs.intake, 'giay_tiep_nhan/scan.pdf', makePdf(null));
    put(dirs.intake, 'ho_so_vung_trong/anh.png', Buffer.from('\x89PNG\r\n\x1a\nbytes', 'latin1'));
    const db = new FakeDb();
    const c = await intake(db);
    expect([c.new, c.cho_ocr, c.error]).toEqual([2, 2, 0]);
    for (const p of insDocs(db)) expect(p.slice(3)).toEqual([1, 'none', null, 'cho_ocr']);
    expect(db.fields.size).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  it('provider trong nước (giả) → nguồn ocr, field từ chữ OCR; OCR đọc BẢN GỐC', async () => {
    const p = put(dirs.intake, 'giay_tiep_nhan/scan.pdf', makePdf(null));
    const calls: string[] = [];
    di.PROVIDERS.fake_vn = [
      async (path) => {
        calls.push(path);
        return 'So 77/2025/ĐKSP ngày 2 tháng 1 năm 2025';
      },
      true,
    ];
    const db = new FakeDb();
    const c = await intake(db, 'fake_vn');
    expect([c.new, c.cho_ocr]).toEqual([1, 0]);
    expect(calls).toEqual([join(dirs.orig, di.sha256File(p))]);
    const ins = insDocs(db)[0];
    expect(ins.slice(4)).toEqual(['ocr', false, 'pending_review']);
    expect(db.fields.get(`${ins[0]}|so_giay`)?.[0]).toBe('77/2025/ĐKSP');
    expect(db.fields.get(`${ins[0]}|ngay_cap`)?.[0]).toBe('2025-01-02');
    expect(db.count('update documents set ocr_engine')).toBe(0); // engine chỉ cho provider đã đăng ký
  });

  it('provider nước ngoài → từ chối NGAY, 0 tài liệu ghi, provider không được gọi', async () => {
    put(dirs.intake, 'giay_tiep_nhan/scan.pdf', makePdf(null));
    put(dirs.intake, 'nhan/a.jpg', Buffer.from('\xff\xd8\xff jpeg', 'latin1'));
    const calls: string[] = [];
    di.PROVIDERS.fake_us = [
      async (p) => {
        calls.push(p);
        return 'text';
      },
      false,
    ];
    const db = new FakeDb();
    await expect(intake(db, 'fake_us')).rejects.toThrow('nước ngoài');
    expect(calls).toEqual([]);
    expect(db.docs.size).toBe(0);
    expect(existsSync(dirs.orig)).toBe(false);
    await expect(intake(db, 'fpt')).rejects.toThrow(RangeError);
  });

  it.each([
    ['camscanner', [['Scanned with CamScanner']]],
    ['footer', [['Trang 1/10']]],
    ['cover+footer', [GIAY, ['Trang 2/2']]],
    ['cover+blank', [GIAY, null]],
  ] as [string, (string[] | null)[]][])(
    'A04 lớp chữ nhỏ trên trang scan (%s) → cho_ocr, pii NULL',
    async (_n, pages) => {
      const p = put(dirs.intake, 'giay_tiep_nhan/s.pdf', makePdfPages(pages));
      expect((await di.extractText(p)).slice(1)).toEqual([pages.length, 'none']);
      const db = new FakeDb();
      const c = await intake(db);
      expect([c.new, c.cho_ocr, c.error]).toEqual([1, 1, 0]);
      expect(insDocs(db)[0].slice(3)).toEqual([pages.length, 'none', null, 'cho_ocr']);
      expect(db.fields.size).toBe(0);
      expect(fetchCalls).toEqual([]);
    },
  );

  it('r13: OCR ghi documents.ocr_engine CÙNG giao dịch, sau insert', async () => {
    put(dirs.intake, 'giay_tiep_nhan/scan.pdf', makePdf(null));
    di.PROVIDERS.paddle_local = [async () => 'So 77/2025/ĐKSP', true];
    const db = new FakeDb();
    const c = await intake(db, 'paddle_local');
    const stmts = db.sql.map(([s]) => s);
    const iUpd = stmts.findIndex((s) => s.startsWith('update documents set ocr_engine'));
    const iIns = stmts.findIndex((s) => s.startsWith('insert into documents'));
    expect(c.new).toBe(1);
    expect(db.sql[iUpd][1][0]).toBe(di.OCR_ENGINES.paddle_local);
    expect(iUpd).toBeGreaterThan(iIns);
    expect(stmts.lastIndexOf('commit')).toBeGreaterThan(iUpd);
    expect(stmts.slice(iIns, iUpd)).not.toContain('commit');
  });
});

// ------------------------------------------------------------ paddle_local qua AI worker GIẢ
describe('paddle_local qua AI worker nội bộ (server giả loopback)', () => {
  let srv: Server;
  let reply: [number, unknown];
  let bodies: Buffer[];
  const env = () => ({
    NODE_ENV: 'test',
    AI_WORKER_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); // fetch thật — chỉ tới server giả loopback
    bodies = [];
    srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        res.writeHead(reply[0], { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply[1]));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('có chữ → ocr + ocr_engine; gửi đúng byte BẢN GỐC', async () => {
    reply = [200, { ok: true, text: 'So 77/2025/ĐKSP ngày 2 tháng 1 năm 2025' }];
    const data = makePdf(null);
    put(dirs.intake, 'giay_tiep_nhan/scan.pdf', data);
    const db = new FakeDb();
    const c = await di.intake(dirs.intake, dirs.orig, db.db, 'paddle_local', {
      env: env(),
      log: () => {},
    });
    expect([c.new, c.error]).toEqual([1, 0]);
    expect(bodies).toEqual([data]);
    expect(db.count('update documents set ocr_engine')).toBe(1);
  });

  it('worker chặn (model thiếu) / lỗi tài liệu / hỏng → lỗi có kiểm soát từng tài liệu', async () => {
    put(dirs.intake, 'nhan/a.png', Buffer.from('\x89PNG\r\n\x1a\nx', 'latin1'));
    const db = new FakeDb();
    for (const r of [
      [
        503,
        { ok: false, blocked: true, error: 'thiếu model OCR cục bộ (det) ở OCR_PADDLE_MODEL_DIR' },
      ],
      [200, { ok: false, error: 'OCR lỗi (RuntimeError)' }],
      [500, 'x'],
    ] as [number, unknown][]) {
      reply = r;
      const log: string[] = [];
      const c = await di.intake(dirs.intake, dirs.orig, db.db, 'paddle_local', {
        env: env(),
        log: (s) => log.push(s),
      });
      expect(c.error).toBe(1);
      expect(log.join('\n')).toMatch(/\[err\] #1 /);
    }
    expect(db.docs.size).toBe(0);
  });

  it('thiếu AI_WORKER_URL → lỗi tài liệu, không gửi gì', async () => {
    put(dirs.intake, 'nhan/a.png', Buffer.from('\x89PNG\r\n\x1a\nx', 'latin1'));
    reply = [200, { ok: true, text: 'x' }];
    const db = new FakeDb();
    const c = await di.intake(dirs.intake, dirs.orig, db.db, 'paddle_local', {
      env: ENV,
      log: () => {},
    });
    expect(c.error).toBe(1);
    expect(bodies).toEqual([]);
  });
});

// ------------------------------------------------------------ OWASP / symlink / lỗi DB
describe('an toàn', () => {
  it('module không gọi LLM/gateway/HTTP trực tiếp (chỉ OCR qua AI worker nội bộ)', () => {
    const src = readFileSync(new URL('./doc-intake.ts', import.meta.url), 'utf8');
    for (const bad of ['ai/gateway', 'openai', 'anthropic', 'fetch(', 'http.request', 'undici']) {
      expect(src).not.toContain(bad);
    }
  });

  it('symlink/junction trỏ ra ngoài intake → không đọc', async () => {
    const outside = join(dirs.root, 'secret');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.pdf'), makePdf(GIAY));
    try {
      symlinkSync(outside, join(dirs.intake, 'nhan'), 'junction');
    } catch {
      return; // không tạo được liên kết trên máy này
    }
    expect(existsSync(join(dirs.intake, 'nhan', 'x.pdf'))).toBe(true); // đọc xuyên được
    const db = new FakeDb();
    const c = await intake(db);
    expect(c.new).toBe(0);
    expect(c.skipped).toBeGreaterThanOrEqual(1);
    expect(db.docs.size).toBe(0);
    expect(!existsSync(dirs.orig) || readdirSync(dirs.orig).length === 0).toBe(true);
    expect(existsSync(join(outside, 'x.pdf'))).toBe(true);
  });

  it('lỗi DB giữa lô → rollback, lô chạy tiếp', async () => {
    put(dirs.intake, 'giay_tiep_nhan/a.pdf', makePdf(GIAY));
    const b = put(dirs.intake, 'giay_tiep_nhan/b.pdf', makePdf([...GIAY, 'ban 2']));
    const db = new AbortingDb('insert into documents');
    const c = await intake(db);
    expect([c.error, c.new]).toEqual([1, 1]);
    expect(db.rollbacks).toBeGreaterThanOrEqual(1);
    expect([...db.docs.keys()]).toEqual([di.sha256File(b)]);
    expect(db.fields.size).toBe(3);
  });

  it('race insert rowCount 0 → dup, không field, rollback 1 commit 0', async () => {
    put(dirs.intake, 'giay_tiep_nhan/g.pdf', makePdf(GIAY));
    const db = new RaceDb();
    const c = await intake(db);
    expect([c.dup, c.new, c.error]).toEqual([1, 0, 0]);
    expect(db.count('insert into document_fields')).toBe(0);
    expect([db.rollbacks, db.commits]).toEqual([1, 0]);
  });

  it('reprocess: provider none/nước ngoài/lạ → từ chối TRƯỚC mọi truy vấn', async () => {
    const db = new FakeDb();
    await expect(di.reprocessPending(db.db, dirs.orig, 'none')).rejects.toThrow('BLOCKED');
    di.PROVIDERS.fake_us = [async () => 'x', false];
    await expect(di.reprocessPending(db.db, dirs.orig, 'fake_us')).rejects.toThrow('nước ngoài');
    await expect(di.reprocessPending(db.db, dirs.orig, 'gvision')).rejects.toThrow('BLOCKED');
    expect(db.sql).toEqual([]);
  });
});

// ------------------------------------------------------------ W38.6 CLI
describe('CLI doc-intake', () => {
  const run = async (o: di.DocIntakeOpts, db: FakeDb | null, env: Record<string, string> = {}) => {
    const t = cap();
    let connects = 0;
    const rc = await di.docIntakeMain(o, {
      io: t.io,
      env: {
        NODE_ENV: 'test',
        OCR_PROVIDER: 'none',
        DOC_INTAKE_DIR: join(dirs.root, 'in'),
        DOC_ORIGINALS_DIR: join(dirs.root, 'orig'),
        ...env,
      },
      connect: async () => {
        connects++;
        return db ? db.lease()() : null;
      },
      wire: () => {},
    });
    return { rc, connects, ...t };
  };

  it.each([
    [{ verify: SHA }],
    [{ verify: SHA, by: '   ' }],
    [{ reject: SHA, by: '' }],
    [{ verify: SHA.slice(0, -1), by: 'A' }],
    [{ verify: 'g'.repeat(64), by: 'A' }],
    [{ verify: SHA, reject: SHA, by: 'A' }],
    [{ pending: true, verify: SHA, by: 'A' }],
    [{ pending: true, by: 'A' }],
    [{ verify: SHA, by: 'A\x1b[2J' }],
    [{ verify: SHA, by: 'x'.repeat(101) }],
  ] as [di.DocIntakeOpts][])('sai tham số → exit 2 TRƯỚC connect %#', async (o) => {
    const r = await run(o, new FakeDb());
    expect(r.rc).toBe(2);
    expect(r.connects).toBe(0);
  });

  it('--verify pending_review: qua function doc_review_human, không UPDATE thẳng; in sha12', async () => {
    const db = new FakeDb({ [SHA]: 'pending_review' });
    db.fields.set(`${SHA}|so_giay`, ['1/2024/DKSP', 1.0, false]);
    const r = await run({ verify: SHA.toUpperCase(), by: 'Pháp chế A' }, db);
    expect(r.rc, r.all()).toBe(0);
    const calls = db.sql.filter(([s]) => s.startsWith('select doc_review_human'));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([SHA, 'verified', 'Pháp chế A']);
    expect(db.count('update documents')).toBe(0);
    expect(db.count('update document_fields')).toBe(0);
    expect(db.released).toBe(1);
    expect(db.docs.get(SHA)).toBe('verified');
    expect(db.fields.get(`${SHA}|so_giay`)?.[2]).toBe(true);
    const out = r.out.join('\n');
    expect(out).toContain(SHA.slice(0, 12));
    expect(out).not.toContain(SHA);
    expect(r.err.join('\n')).toContain('CHẾ ĐỘ DEV'); // cliGate dev cảnh báo
  });

  it('--reject giữ field chưa xác minh', async () => {
    const db = new FakeDb({ [SHA]: 'pending_review' });
    db.fields.set(`${SHA}|so_giay`, ['1/2024/DKSP', 1.0, false]);
    expect((await run({ reject: SHA, by: 'B' }, db)).rc).toBe(0);
    expect(db.docs.get(SHA)).toBe('rejected');
    expect(db.count('select doc_review_human')).toBe(1);
    expect(db.fields.get(`${SHA}|so_giay`)?.[2]).toBe(false);
  });

  it.each([[{ [SHA]: 'cho_ocr' }], [{ [SHA]: 'verified' }], [{}]] as [Record<string, string>][])(
    '--verify không ở pending_review → exit 1, không đổi gì %#',
    async (docs) => {
      const db = new FakeDb(docs);
      const r = await run({ verify: SHA, by: 'A' }, db);
      expect(r.rc).toBe(1);
      expect(Object.fromEntries(db.docs)).toEqual(docs);
      expect(db.commits).toBe(0);
      expect(r.out.join('\n')).toContain('không tồn tại hoặc không ở pending_review');
    },
  );

  it('--verify --by agent: → cliGate chặn, không gọi function', async () => {
    const db = new FakeDb({ [SHA]: 'pending_review' });
    const r = await run({ verify: SHA, by: 'agent:x' }, db);
    expect(r.rc).toBe(1);
    expect(db.count('select doc_review_human')).toBe(0);
    expect(db.docs.get(SHA)).toBe('pending_review');
  });

  it('--pending + DB down', async () => {
    const db = new FakeDb({ [SHA]: 'pending_review', ['b'.repeat(64)]: 'verified' });
    const r = await run({ pending: true }, db);
    expect(r.rc).toBe(0);
    const out = r.out.join('\n');
    expect(out).toContain(SHA);
    expect(out).not.toContain('b'.repeat(64));
    expect(out).toContain('1 tài liệu');
    expect((await run({ pending: true }, null)).rc).toBe(1);
  });

  it('intake chạy + đóng kết nối', async () => {
    put(join(dirs.root, 'in'), 'giay_tiep_nhan/g.pdf', makePdf(GIAY));
    const db = new FakeDb();
    const r = await run({}, db);
    expect(r.rc, r.all()).toBe(0);
    expect(db.released).toBe(1);
    expect(db.docs.size).toBe(1);
    expect(r.out.join('\n')).toContain('new=1');
  });

  it('OCR_PROVIDER lạ / nước ngoài → exit 2, không connect', async () => {
    expect(await run({}, new FakeDb(), { OCR_PROVIDER: 'google_vision' })).toMatchObject({
      rc: 2,
      connects: 0,
    });
    di.PROVIDERS.gvision = [async () => 'x', false];
    expect(await run({}, new FakeDb(), { OCR_PROVIDER: 'gvision' })).toMatchObject({
      rc: 2,
      connects: 0,
    });
  });

  it('v13.4: ảnh vào cho_ocr khi OCR chưa cấu hình → [blocked] exit 2 (không báo thành công câm)', async () => {
    put(join(dirs.root, 'in'), 'nhan/nhan.jpg', Buffer.from('\xff\xd8\xff\xe0 anh nhan', 'latin1'));
    const db = new FakeDb();
    const r = await run({}, db, { OCR_PROVIDER: '' });
    expect(r.rc).toBe(2);
    const out = r.out.join('\n');
    expect(out).toContain('cho_ocr=1');
    expect(out).toContain('[blocked]');
    expect(out).toContain('DPA');
    expect([...db.docs.values()]).toEqual(['cho_ocr']);
  });

  it('r13: provider có mà OCR không ra chữ → [cho_ocr] exit 2', async () => {
    put(join(dirs.root, 'in'), 'nhan/trang.png', Buffer.from('\x89PNG\r\n\x1a\nwhite', 'latin1'));
    di.PROVIDERS.paddle_local = [async () => '', true];
    const r = await run({}, new FakeDb(), { OCR_PROVIDER: 'paddle_local' });
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('[cho_ocr] 1 tài liệu OCR (paddle_local) không ra chữ');
  });

  it('--reprocess-pending không có provider → [blocked] exit 2, không connect', async () => {
    const r = await run({ reprocessPending: true }, new FakeDb(), { OCR_PROVIDER: '' });
    expect(r.rc).toBe(2);
    expect(r.connects).toBe(0);
    expect(r.out.join('\n')).toContain('[blocked]');
  });

  it('v15 P12.1: tính năng TẮT + chính sách chưa cấu hình → [rollout] exit 2, không nạp', async () => {
    fake(null, { 'data_platform-02.1': 'tat', 'data_platform-02.2': 'van_hanh' });
    put(join(dirs.root, 'in'), 'giay_tiep_nhan/g.pdf', makePdf(GIAY));
    const db = new FakeDb();
    const r = await run({}, db);
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('[rollout]');
    expect(db.docs.size).toBe(0);
    expect(existsSync(join(dirs.root, 'orig'))).toBe(false);
  });
});
