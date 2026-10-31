import { isPrintable } from '@samsam/core/ops/py';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, END, pyStr, pyStrip, re, S, sub } from '@samsam/core/security/py';

// Phần thuần của `ingest/market_csv.py` mà nhiều loader/agent khác gọi lại (`_clean/_safe/_nfc/_cell/
// _to_int/_table/_TableError` + hằng trần). CSV đọc LƯỜI theo dòng, kiểm trần dòng/cột TRONG lúc
// duyệt; XLSX nạp cả workbook rồi mới kiểm trần (xem `xlsxRows`); lỗi cấu trúc file → TableError
// (thông điệp KHÔNG chứa nội dung ô).
// Bản gốc của nhóm market — intel_import/table.ts, kd_price/deps.ts đang giữ bản sao (core_requests).

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
// Trần duyệt (áp TRONG lúc đọc): MAX_FILE_BYTES chỉ chặn byte trên đĩa — CSV toàn dòng trống hay XLSX
// có vùng dữ liệu phóng đại vẫn nở ra rất lớn. Dòng đếm cả dòng trống.
export const MAX_ROWS = 100_000;
export const MAX_COLS = 200;
export const MAX_PRINT_ERRS = 30;

export type Cell = string | null;
export type TableRow = [number, Cell[]];

/** `_TableError`: lỗi cấu trúc file — message không chứa nội dung ô. */
export class TableError extends Error {
  override name = 'TableError';
}

/** `_nfc`: NFC + strip (khoảng trắng Unicode của Python). */
export const nfc = (s: string): string => pyStrip(s.normalize('NFC'));

/** `_clean`: chuỗi từ file sàn trước khi in — ký tự không in được (escape terminal) → '?', cắt `n`
 * code point. Giá trị không phải chuỗi đi qua `str()` của Python (None → "None"). */
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

// Số nguyên VND: "159000" | nhóm 3 chữ số cùng 1 ký tự phân cách ("482.900", "1,490,000").
// "12,5" / "1.234,50" (phần thập phân) → lỗi, không đoán. `[0-9]` = ASCII như `re` Python.
const INT_RE = /^(?:[0-9]+|[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*)$/;
const STRIP_RE = re(`[${S}₫]|(?:VND|vnđ|đ)${END}`, 'gi');

/** `_to_int` → số | null (sai dạng / vượt `cap`). */
export function toInt(s: string | null | undefined, cap: number): number | null {
  if (s === null || s === undefined) return null;
  const t = sub(STRIP_RE, '', s);
  // chặn chuỗi số dài trước khi đổi số (Python giới hạn 4300 chữ số int())
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

/** Giá trị ô exceljs → giá trị openpyxl `data_only=True` (rich text/hyperlink → chữ, công thức → kết
 * quả đã lưu, lỗi → mã lỗi). */
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
 * `_cell`: ô CSV/XLSX → chuỗi đã strip, ô rỗng → null. Số nguyên XLSX → chữ số thuần (item id, giá);
 * số CÓ phần lẻ → dạng `f` 6 chữ số thập phân ("12.345000" — không bao giờ khớp nhánh nhóm-nghìn
 * của `toInt` → lỗi số, fail-closed; repr "12.345" từng thành 12345 câm).
 * shortcut: số > 2^53 trong ô XLSX mất chính xác (openpyxl giữ int lớn) — chỉ lệch chữ ô số rất dài,
 * cột số vẫn bị trần 25 chữ số/`cap` chặn như Python; nâng khi gặp file như vậy.
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

/** Python 3.12 `Path(p).suffix.lower()` (tên kết thúc '.' hoặc chỉ có '.' đầu → ''). */
export function suffixOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : '';
}

/** Python `bytes.isspace()` (chỉ khoảng trắng ASCII) — rỗng → false. */
export const bytesIsSpace = (b: Uint8Array): boolean =>
  b.length > 0 && b.every((x) => x === 0x20 || (x >= 0x09 && x <= 0x0d));

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

/**
 * Dòng thô XLSX (sheet đầu, tối đa MAX_COLS+1 cột). Vùng dữ liệu vượt trần → chặn TRƯỚC khi duyệt.
 * KHÁC Python (đã liệt kê trong test): openpyxl read-only đọc `<dimension>` khai trong file rồi bỏ nó
 * khi duyệt; exceljs bỏ qua `<dimension>` và đo vùng dữ liệu THẬT — dimension khai thiếu không bao
 * giờ cắt câm dòng cuối, ô lạc vượt trần luôn báo "vùng dữ liệu sheet …" (Python: "file > N dòng" /
 * "dòng i: có ô ngoài N cột"). Cả hai: 1 lỗi, 0 dòng nạp. shortcut: thông điệp lỗi đọc XLSX mang tên
 * lỗi của exceljs/JS (Python: tên lỗi zip/xml của openpyxl).
 * shortcut: `wb.xlsx.load` KHÔNG lười (Python openpyxl read_only dừng ở dòng 100001) — dựng cả workbook
 * trong RAM (~4 KB/dòng đo được) TRƯỚC khi kiểm trần; XLSX hàng triệu dòng dưới 50 MB làm V8 hết bộ
 * nhớ (không exit 1 sạch; chưa connect nên 0 ghi DB). Đổi sang `ExcelJS.stream.xlsx.WorkbookReader`
 * cần `table()` thành async iterator (production/inventory-csv dùng chung) — làm khi có file thật lớn.
 */
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
  if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) {
    throw new TableError(
      `vùng dữ liệu sheet ${ws.rowCount} dòng × ${ws.columnCount} cột vượt trần ${MAX_ROWS} × ${MAX_COLS} — xóa dòng/cột thừa (ô định dạng xa phía dưới/bên phải) hoặc xuất CSV`,
    );
  }
  const last = ws.rowCount;
  return (function* () {
    for (let r = 1; r <= last; r++) {
      const cells: unknown[] = [];
      ws.findRow(r)?.eachCell({ includeEmpty: false }, (cell, col) => {
        if (col > MAX_COLS + 1) return;
        while (cells.length < col - 1) cells.push(null);
        // ô bị gộp (không phải ô gốc) → openpyxl read-only trả None
        cells.push(cell.type === ExcelJS.ValueType.Merge ? null : xlsxValue(cell.value));
      });
      yield cells;
    }
  })();
}

/**
 * `_table` → iterator (số dòng file, ô đã `cellOf`, bỏ null cuối) — bỏ dòng trống NGAY, trần
 * MAX_ROWS (đếm cả dòng trống) / MAX_COLS áp trong lúc duyệt. Lỗi đọc → TableError (có thể ném khi
 * duyệt). Không bao giờ giữ cả bảng ô đã chuẩn hóa trong RAM.
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
