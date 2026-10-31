import type { Db } from '@samsam/core/ops/deps';
import pg from 'pg';
import type { Io } from './shared.js';

// Hỗ trợ test của nhóm sx_docs (không phải test): PDF viết tay (dịch `make_pdf`/`make_pdf_pages` của
// tests/test_doc_intake.py) + Db GIẢ ghi SQL (dịch `FakeConn`/`AbortingConn`/`RaceConn`).

const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

/** PDF nhiều trang; mỗi phần tử: dòng chữ (Helvetica, latin-1) | null = trang KHÔNG content stream
 * (mô phỏng bản scan: lớp chữ rỗng). */
export function makePdfPages(pages: (string[] | null)[]): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (const lines of pages) {
    kids.push(`${objs.length + 1} 0 R`);
    if (lines === null) {
      objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
      continue;
    }
    const ops = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((ln) => `(${esc(ln)}) Tj T*`).join(' ')} ET`;
    objs.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
        ` /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length + 2} 0 R >>`,
    );
    objs.push(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  return pdfFromObjects(objs);
}

/** Stream PDF: `<< dict /Length n >> stream … endstream` (dữ liệu latin1/byte). */
export const pdfStream = (dict: string, data: string | Buffer): Buffer => {
  const b = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${b.length} >>\nstream\n`, 'latin1'),
    b,
    Buffer.from('\nendstream', 'latin1'),
  ]);
};

/** PDF 1 trang: obj 3 = font F1 Helvetica, obj 5 = nội dung trang, `extra` từ obj 6; `res` thêm vào
 * /Resources (vd `/XObject << /X 6 0 R >>`). */
export const pdfOnePage = (
  content: string | Buffer,
  res = '',
  extra: (string | Buffer)[] = [],
): Buffer =>
  pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
      ` /Resources << /Font << /F1 3 0 R >> ${res} >> /Contents 5 0 R >>`,
    pdfStream('', content),
    ...extra,
  ]);

/** Form XObject obj 6 (font F1, /X = chính nó) in `text` rồi tự gọi `/X Do` `calls` lần; trang gọi /X. */
export const pdfSelfForm = (text: string, calls: number): Buffer =>
  pdfOnePage('/X Do', '/XObject << /X 6 0 R >>', [
    pdfStream(
      '/Type /XObject /Subtype /Form /BBox [0 0 612 792]' +
        ' /Resources << /Font << /F1 3 0 R >> /XObject << /X 6 0 R >> >>',
      `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET ${'/X Do '.repeat(calls)}`,
    ),
  ]);

/** PDF hợp lệ (bảng xref đúng) từ thân đối tượng 1..n — obj 1 là Catalog. */
export function pdfFromObjects(objs: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let len = parts[0].length;
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(len);
    const b = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof o === 'string' ? Buffer.from(o, 'latin1') : o,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(b);
    len += b.length;
  });
  const out = Buffer.concat(parts);
  const xref = out.length;
  const tail =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail, 'latin1')]);
}

export const makePdf = (lines: string[] | null): Buffer => makePdfPages([lines]);

type Res = { rows: Record<string, unknown>[]; rowCount: number };

/** Ghi SQL; mô phỏng tối thiểu documents/document_fields (Python `FakeConn`). Là "client" (không
 * Pool) → `withTx` chạy begin/commit/rollback ngay trên nó. */
export class FakeDb {
  readonly docs: Map<string, string>;
  readonly fields = new Map<string, [string, number, boolean]>(); // `${sha}|${field}`
  readonly sql: [string, unknown[], number][] = [];
  released = 0;

  constructor(docs: Record<string, string> = {}) {
    this.docs = new Map(Object.entries(docs));
  }

  get commits(): number {
    return this.count('commit');
  }
  get rollbacks(): number {
    return this.count('rollback');
  }

  count(prefix: string): number {
    return this.sql.filter(([s]) => s.startsWith(prefix)).length;
  }

  protected run(s: string, p: unknown[]): Res {
    let rc = 0;
    let rows: Record<string, unknown>[] = [];
    if (s.startsWith('select status from documents')) {
      const st = this.docs.get(p[0] as string);
      rows = st ? [{ status: st }] : [];
    } else if (s.startsWith('insert into documents')) {
      if (!this.docs.has(p[0] as string)) {
        this.docs.set(p[0] as string, p[6] as string);
        rc = 1;
      }
    } else if (s.startsWith('insert into document_fields')) {
      if (!s.includes('false)')) throw new Error('verified phải false lúc insert');
      const k = `${p[0]}|${p[1]}`;
      if (!this.fields.has(k)) {
        this.fields.set(k, [p[2] as string, p[3] as number, false]);
        rc = 1;
      }
    } else if (s.startsWith('select doc_review_human')) {
      // mô phỏng function SECURITY DEFINER — chỉ từ pending_review; verified kéo field verified.
      const [sha, status] = p as string[];
      const ok = this.docs.get(sha) === 'pending_review';
      if (ok) {
        this.docs.set(sha, status);
        if (status === 'verified') {
          for (const [k, v] of this.fields) if (k.startsWith(`${sha}|`)) v[2] = true;
        }
      }
      rows = [{ ok }];
    } else if (s.startsWith('select d.sha256')) {
      rows = [...this.docs]
        .filter(([, v]) => v === 'pending_review' || v === 'cho_ocr')
        .map(([k, v]) => ({
          sha256: k,
          doc_type: 'giay_tiep_nhan',
          status: v,
          pii_flag: true,
          fields: 'so_giay=1/2024/DKSP',
        }));
    }
    return { rows, rowCount: rc };
  }

  async query(sql: string, params: unknown[] = []): Promise<Res> {
    const s = sql.split(/\s+/).join(' ').trim();
    const r = this.run(s, params);
    this.sql.push([s, params, r.rowCount]);
    return r;
  }

  get db(): Db {
    return this as unknown as Db;
  }

  lease() {
    return async () => ({
      db: this.db,
      release: async () => {
        this.released++;
      },
    });
  }
}

/** Như Postgres: 1 lệnh lỗi → các lệnh sau lỗi tới khi rollback (Python `AbortingConn`). */
export class AbortingDb extends FakeDb {
  private aborted = false;
  constructor(private failOn: string | null) {
    super();
  }
  protected override run(s: string, p: unknown[]): Res {
    if (s === 'rollback') {
      this.aborted = false;
      return super.run(s, p);
    }
    if (this.aborted) throw new pg.DatabaseError('current transaction is aborted', 0, 'error');
    if (this.failOn && s.startsWith(this.failOn)) {
      this.failOn = null;
      this.aborted = true;
      throw new pg.DatabaseError('boom', 0, 'error');
    }
    return super.run(s, p);
  }
}

/** `insert ... on conflict do nothing` trả rowCount 0 (tiến trình khác vừa insert cùng sha). */
export class RaceDb extends FakeDb {
  protected override run(s: string, p: unknown[]): Res {
    if (s.startsWith('insert into documents')) return { rows: [], rowCount: 0 };
    return super.run(s, p);
  }
}

export function cap(): { io: Io; out: string[]; err: string[]; all: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out,
    err,
    all: () => [...out, ...err].join('\n'),
  };
}
