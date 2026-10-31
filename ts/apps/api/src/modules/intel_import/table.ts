import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { isPrintable } from '@samsam/core/ops/py';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { pyOsName } from '@samsam/core/ops/py-json';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, END, pyStr, pyStrip, re, S, sub } from '@samsam/core/security/py';

// Phần `ingest/market_csv.py` mà intel_import/social_vendor dùng (`_clean/_safe/_nfc/_cell/_to_int/
// _table/_TableError` + hằng trần). Đọc CSV/XLSX LƯỜI, kiểm trần dòng/cột TRONG lúc duyệt; lỗi cấu
// trúc file → TableError (thông điệp KHÔNG chứa nội dung ô).
// shortcut: bản sao của market_csv (nhóm market chưa có bản TS) — khi có thì dùng chung (core_requests).

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;
export const MAX_PRINT_ERRS = 30;

export type Cell = string | null;
export type TableRow = [number, Cell[]];

/** Lỗi cấu trúc file — message không chứa nội dung ô. */
export class TableError extends Error {
  override name = 'TableError';
}

/** `_clean`: chuỗi từ file trước khi in — ký tự không in được → '?', cắt `n` code point. */
export function clean(s: unknown, n = 120): string {
  let out = '';
  let i = 0;
  for (const c of pyStr(s)) {
    if (i++ >= n) break;
    out += isPrintable(c) ? c : '?';
  }
  return out;
}

/** `_safe`: header lạ trước khi in — che SĐT/email rồi `clean`. */
export const safe = (s: unknown, n = 60): string => clean(maskPii(pyStr(s)), n);

/** `_nfc`: NFC + strip. */
export const nfc = (s: string): string => pyStrip(s.normalize('NFC'));

// Số nguyên VND: "159000" | nhóm 3 chữ số cùng 1 ký tự phân cách ("482.900", "1,490,000").
// "12,5" / "1.234,50" (phần thập phân) → lỗi, không đoán.
const INT_RE = /^(?:[0-9]+|[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*)$/; // \s đã bị STRIP_RE xóa
const STRIP_RE = re(`[${S}₫]|(?:VND|vnđ|đ)${END}`, 'gi');

/** `_to_int` → số | null (sai dạng / vượt `cap`). */
export function toInt(s: string | null | undefined, cap: number): number | null {
  if (s === null || s === undefined) return null;
  const t = sub(STRIP_RE, '', s);
  // chặn chuỗi số dài (Python giới hạn chữ số int())
  if (cpLen(t) > 25 || !INT_RE.test(t)) return null;
  const n = BigInt(t.replace(/[.,]/g, ''));
  return n <= BigInt(cap) ? Number(n) : null;
}

/** Python `str(datetime)` của ô ngày XLSX (exceljs trả Date theo giờ UTC = giờ "naive" của Excel). */
function naiveStr(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base =
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${p(ms * 1000, 6)}` : base;
}

/** Giá trị ô XLSX → giá trị Python mà openpyxl `data_only=True` trả (rich text/hyperlink → chữ,
 * công thức → kết quả đã lưu, lỗi → mã lỗi). */
function xlsxValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || v instanceof Date) return v;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText)) {
    return (o.richText as { text?: unknown }[]).map((r) => String(r.text ?? '')).join('');
  }
  if ('formula' in o || 'sharedFormula' in o) return xlsxValue(o.result);
  if ('error' in o) return o.error;
  if ('text' in o) return xlsxValue(o.text);
  return null;
}

/**
 * `_cell`: ô CSV/XLSX → chuỗi đã strip, ô rỗng → null. Số nguyên XLSX → chữ số thuần; số CÓ phần lẻ
 * → dạng `f` 6 chữ số thập phân ("12.345000" — không bao giờ khớp nhóm nghìn của `toInt`).
 * shortcut: số > 2^53 trong ô XLSX mất chính xác (openpyxl giữ int lớn) — chỉ lệch chữ của ô số rất
 * dài, các cột số vẫn bị trần 25 chữ số/`cap` chặn như Python; nâng khi gặp file như vậy.
 */
export function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  let s: string;
  if (typeof v === 'number') {
    s = Number.isInteger(v) ? BigInt(v).toString() : v.toFixed(6);
  } else if (typeof v === 'boolean') s = v ? 'True' : 'False';
  else if (v instanceof Date) s = naiveStr(v);
  else s = String(v);
  s = pyStrip(s);
  return s || null;
}

/** Python 3.12 `Path(p).suffix.lower()`. */
export function suffixOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : '';
}

/** `_read_bytes` → [data | null, sha256 | null, lỗi]. Đuôi .csv/.xlsx, ≤ MAX_FILE_BYTES, khác rỗng. */
export function readBytes(path: string): [Buffer | null, string | null, string[]] {
  const suffix = suffixOf(path);
  if (suffix !== '.csv' && suffix !== '.xlsx') {
    return [null, null, [`đuôi '${clean(suffix, 20)}' không hỗ trợ — chỉ .csv / .xlsx`]];
  }
  let data: Buffer;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) {
      return [null, null, [`file > ${Math.floor(MAX_FILE_BYTES / 2 ** 20)}MB — tách file`]];
    }
    data = readFileSync(path);
  } catch (e) {
    return [null, null, [`không đọc được file: ${pyOsName(e)}`]];
  }
  const sha = createHash('sha256').update(data).digest('hex');
  // bytes.isspace(): chỉ khoảng trắng ASCII
  if (!data.length || data.every((b) => b === 0x20 || (b >= 0x09 && b <= 0x0d))) {
    return [null, sha, ['file rỗng']];
  }
  return [data, sha, []];
}

/** Dòng thô CSV (Python `csv.reader` trên text `utf-8-sig`, newline=""). */
function* csvRows(data: Buffer): Generator<unknown[]> {
  const body = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  // utf-8-sig: vị trí byte lỗi tính SAU BOM (như Python)
  const bad = utf8ErrorStart(body);
  if (bad >= 0) throw new TableError(`file CSV không phải UTF-8 (byte ${bad})`);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  try {
    yield* new CsvReader(text);
  } catch (e) {
    // thông báo csv.Error không chứa nội dung ô (vd field limit)
    if (e instanceof CsvError) throw new TableError(`CSV hỏng: ${e.message}`.slice(0, 160));
    throw e;
  }
}

/** Dòng thô XLSX (openpyxl read-only, sheet đầu, `max_col = MAX_COLS + 1`). shortcut: thông điệp lỗi
 * đọc XLSX mang tên lỗi của exceljs/JS (Python: tên lỗi zip/xml của openpyxl) — chỉ khác chữ. */
async function xlsxRows(data: Buffer): Promise<Iterable<unknown[]>> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch (e) {
    throw new TableError(`không đọc được XLSX: ${(e as Error)?.name ?? 'Error'}`);
  }
  const ws = wb.worksheets[0];
  if (ws === undefined) throw new TableError('không đọc được XLSX: IndexError');
  // vùng dữ liệu phóng đại (ô định dạng xa phía dưới/bên phải) → chặn TRƯỚC khi duyệt
  if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) {
    throw new TableError(
      `vùng dữ liệu sheet ${ws.rowCount} dòng × ${ws.columnCount} cột vượt trần ${MAX_ROWS} × ${MAX_COLS} — xóa dòng/cột thừa (ô định dạng xa phía dưới/bên phải) hoặc xuất CSV`,
    );
  }
  const last = ws.rowCount;
  return (function* () {
    for (let r = 1; r <= last; r++) {
      const cells: unknown[] = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        if (col > MAX_COLS + 1) return;
        while (cells.length < col - 1) cells.push(null);
        // ô bị gộp (không phải ô gốc) → openpyxl trả None
        cells.push(cell.type === ExcelJS.ValueType.Merge ? null : xlsxValue(cell.value));
      });
      yield cells;
    }
  })();
}

/**
 * `_table` → iterator (số dòng file, ô đã `cellOf`, bỏ null cuối) — bỏ dòng trống, trần MAX_ROWS
 * (đếm cả dòng trống) / MAX_COLS áp trong lúc duyệt. Lỗi đọc → TableError (có thể ném khi duyệt).
 */
export async function table(data: Buffer, suffix: string): Promise<Iterator<TableRow>> {
  const raw = suffix === '.csv' ? csvRows(data) : await xlsxRows(data);
  return (function* () {
    let i = 0;
    for (const r of raw) {
      i++;
      if (i > MAX_ROWS) throw new TableError(`file > ${MAX_ROWS} dòng — tách file`);
      if (r.length > MAX_COLS && r.slice(MAX_COLS).some((c) => c !== null && c !== '')) {
        throw new TableError(`dòng ${i}: có ô ngoài ${MAX_COLS} cột`);
      }
      const cells = r.slice(0, MAX_COLS).map(cellOf);
      while (cells.length && cells[cells.length - 1] === null) cells.pop();
      if (cells.length) yield [i, cells] as TableRow;
    }
  })();
}
