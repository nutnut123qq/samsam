import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import G from './__fixtures__/doc_intake.golden.json' with { type: 'json' };
import { MAX_TEXT, MAX_WORK, PdfEncrypted, PdfError, pdfPageTexts } from './pdf-text.js';
import { makePdf, pdfFromObjects, pdfOnePage, pdfSelfForm, pdfStream } from './sx-docs.testing.js';

// Golden: `pypdf.PdfReader(...).pages[i].extract_text()` (pypdf 6.14.2) trên PDF viết tay (dịch
// `make_pdf`/`make_pdf_pages` của tests/test_doc_intake.py + các toán tử chữ/mã hóa/nén thường gặp).
// KHÁC pypdf có chủ đích (TS chặt hơn = fail-closed — trang coi như KHÔNG có chữ → nhánh OCR):
const TS_STRICTER: Record<string, string[]> = {
  // font Type0 không ToUnicode: pypdf giải mã CID như UTF-16 → chữ rác "\x01\x02\x03" vẫn tính là lớp
  // chữ (pii_flag=False sai). TS: không biết chữ → trang rỗng.
  type0_no_tounicode: [''],
};

type Pdf = {
  name: string;
  b64: string;
  texts: string[] | null;
  encrypted: boolean | null;
  err: string | null;
};
const PDFS = G.pdfs as Pdf[];
const bytes = (p: Pdf) => Uint8Array.from(Buffer.from(p.b64, 'base64'));

describe('pdfPageTexts ↔ pypdf extract_text (golden)', () => {
  for (const p of PDFS) {
    it(p.name, () => {
      if (p.err) {
        expect(() => pdfPageTexts(bytes(p))).toThrow(PdfError);
        try {
          pdfPageTexts(bytes(p));
        } catch (e) {
          expect((e as PdfError).pyType).toBe(p.err);
        }
      } else if (p.encrypted) {
        expect(() => pdfPageTexts(bytes(p))).toThrow(PdfEncrypted);
      } else {
        expect(pdfPageTexts(bytes(p))).toEqual(TS_STRICTER[p.name] ?? p.texts);
      }
    });
  }

  it('dữ liệu cụt / lồng ngoặc không kết thúc → lỗi có kiểm soát, không treo', () => {
    const good = bytes(PDFS.find((p) => p.name === 'giay') as Pdf);
    for (const n of [10, 50, 200, good.length - 40]) {
      try {
        pdfPageTexts(good.subarray(0, n));
      } catch (e) {
        expect(e).toBeInstanceOf(PdfError);
      }
    }
    const deep = Buffer.from(`%PDF-1.4\n1 0 obj\n${'['.repeat(5000)}\nendobj\n`, 'latin1');
    expect(() => pdfPageTexts(deep)).toThrow(PdfError);
  });
});

// ------------------------------------------------------------ PDF độc (review đối kháng — DoS)
// Kỳ vọng = pypdf 6.14.2 trên CÙNG cấu trúc (đã chạy Python, mỗi ca ≤ 1 s). Trước bản vá TS (đo tsx):
// Form tự gọi 5 lần → 195.312 ký tự (pypdf "a\n"), 2000 lần → treo; 20k `9 0 obj <` → > 40 s;
// 20k `trailer <<(` → 38 s; 20k BI → 6 s; TJ 200k chèn khoảng trắng → 21 s; ObjStm 20k offset → 7,5 s;
// CMap 80k `beginbfchar` thiếu end → 10,6 s. Sau vá: mỗi ca < 1 s → trần 10 s rộng ≥ 10 lần.
const GIAY = ['So: 1234/2024/DKSP', 'ngay 05/03/2024', 'Ten san pham: Sam Ngoc Linh X'];
const GIAY_TEXT = 'So: 1234/2024/DKSP\nngay 05/03/2024\nTen san pham: Sam Ngoc Linh X\n';
const GIAY_OPS =
  'BT /F1 12 Tf 14 TL 72 720 Td (So: 1234/2024/DKSP) Tj T* (ngay 05/03/2024) Tj T*' +
  ' (Ten san pham: Sam Ngoc Linh X) Tj T* ET';
const L = (s: string) => Buffer.from(s, 'latin1');

function fast<T>(f: () => T): T {
  const t = performance.now();
  const r = f();
  expect(performance.now() - t).toBeLessThan(10_000);
  return r;
}
const limit = (pdf: Buffer) => {
  try {
    fast(() => pdfPageTexts(pdf));
  } catch (e) {
    return (e as PdfError).pyType;
  }
  return 'không lỗi';
};

describe('PDF độc → không treo, chữ như pypdf', () => {
  it('Form tự gọi chính nó → bỏ lần gọi lặp như pypdf, không nhân bản chữ', () => {
    expect(fast(() => pdfPageTexts(pdfSelfForm('a', 5)))).toEqual(['a\n']);
    expect(fast(() => pdfPageTexts(pdfSelfForm('a', 2000)))).toEqual(['a\n']);
    expect(fast(() => pdfPageTexts(pdfSelfForm('Scanned with CamScanner', 5)))).toEqual([
      'Scanned with CamScanner\n',
    ]);
  });

  it.each([
    ['9 0 obj <', 20000],
    ['9 0 obj (', 20000],
    ['9 0 obj <<>> stream\n', 50000],
    ['trailer <<(', 20000],
  ])('quét đối tượng: %j × %i sau PDF hợp lệ → tuyến tính', (tail, n) => {
    const pdf = Buffer.concat([makePdf(GIAY), L(tail.repeat(n))]);
    expect(fast(() => pdfPageTexts(pdf))).toEqual([GIAY_TEXT]);
  });

  it('ảnh nội tuyến BI hàng vạn → tuyến tính', () => {
    const bi = 'BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI\n';
    expect(fast(() => pdfPageTexts(pdfOnePage(`${GIAY_OPS}\n${bi.repeat(50000)}`)))).toEqual([
      GIAY_TEXT,
    ]);
  });

  it('TJ dài chèn khoảng trắng mỗi phần tử → tuyến tính', () => {
    const pdf = pdfOnePage(`BT /F1 12 Tf 72 720 Td [${'(a) -500 '.repeat(200000)}] TJ ET`);
    expect(fast(() => pdfPageTexts(pdf))).toEqual(['a '.repeat(200000)]);
  });

  it('ObjStm: vạn offset chồng lên một chuỗi dài → mỗi offset parse một lần', () => {
    const n = 40000;
    const hdr = `${Array.from({ length: n }, (_, i) => `${100 + i} ${i * 2 + 1}`).join(' ')} `;
    const data = `${hdr}(${'x'.repeat(n * 2)})`;
    const stm = pdfStream(`/Type /ObjStm /N ${n} /First ${hdr.length}`, data);
    expect(fast(() => pdfPageTexts(pdfOnePage(GIAY_OPS, '', [stm])))).toEqual([GIAY_TEXT]);
  });

  it.each([
    ['begincmap ', 'beginbfchar <01> <0041> ', 80000, 'endcmap'],
    ['begincmap beginbfrange ', '<01> <02> [', 50000, ' endbfrange endcmap'],
  ])('ToUnicode CMap %s%j × %i (thiếu end / mảng không đóng) → tuyến tính', (a, unit, n, z) => {
    const pdf = pdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      pdfStream('', GIAY_OPS),
      pdfStream('', `${a}${unit.repeat(n)}${z}`),
    ]);
    expect(fast(() => pdfPageTexts(pdf))).toEqual([GIAY_TEXT]);
  });
});

// KHÁC pypdf có chủ đích (TS chặt hơn): vượt trần công việc/chữ một tài liệu → PdfError
// 'LimitReachedError' (doc-intake: "PDF hỏng: LimitReachedError", lô chạy tiếp). pypdf không trần: Form
// lồng bùng nổ k^độ sâu → treo cả lô; tài liệu cần > MAX_WORK (64 MB nội dung) → pypdf mất hàng phút.
describe('trần công việc / chữ ra (TS chặt hơn pypdf)', () => {
  it('Form lồng gọi lặp (X gọi Y 100 lần, Y = 1 MB) → LimitReachedError nhanh', () => {
    const res = '/Resources << /Font << /F1 3 0 R >> /XObject << /Y 7 0 R >> >>';
    const pdf = pdfOnePage('/X Do', '/XObject << /X 6 0 R >>', [
      pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 1 1] ${res}`, '/Y Do '.repeat(100)),
      pdfStream(
        `/Type /XObject /Subtype /Form /BBox [0 0 1 1] ${res} /Filter /FlateDecode`,
        deflateSync(Buffer.alloc(MAX_WORK / 64, 0x20)),
      ),
    ]);
    expect(limit(pdf)).toBe('LimitReachedError');
  });

  it('CMap 1 mã → 4096 ký tự, 10.000 mã → vượt MAX_TEXT → LimitReachedError', () => {
    const pdf = pdfFromObjects([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      pdfStream('', `BT /F1 12 Tf 72 720 Td <${'01'.repeat(10000)}> Tj ET`),
      pdfStream('', `beginbfchar <01> <${'0041'.repeat(4096)}> endbfchar`),
    ]);
    expect(4096 * 10000).toBeGreaterThan(MAX_TEXT);
    expect(limit(pdf)).toBe('LimitReachedError');
  });
});
