// Python `csv` (dialect excel, không strict) + vị trí lỗi UTF-8 — dùng chung mọi module đọc CSV.

/** Vị trí byte lỗi đầu tiên khi giải UTF-8 (Python `UnicodeDecodeError.start`) | -1 nếu hợp lệ. */
export function utf8ErrorStart(b: Uint8Array): number {
  let i = 0;
  while (i < b.length) {
    const c = b[i] as number;
    if (c < 0x80) {
      i++;
      continue;
    }
    let n: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) n = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      n = 2;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 3;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    } else return i;
    for (let k = 1; k <= n; k++) {
      const x = b[i + k];
      if (x === undefined || x < (k === 1 ? lo : 0x80) || x > (k === 1 ? hi : 0xbf)) return i;
    }
    i += n + 1;
  }
  return -1;
}

export class CsvError extends Error {
  override name = 'Error'; // Python `csv.Error` → type(e).__name__ == "Error"
}

const FIELD_LIMIT = 131072; // csv.field_size_limit() mặc định

/** Python `csv.reader(io.StringIO(text, newline=""))` dialect excel, không strict — kèm `lineNum`
 * (= `reader.line_num`: số dòng vật lý đã đọc) và trần `field_size_limit` (vượt → CsvError). */
export class CsvReader implements Iterable<string[]> {
  lineNum = 0;
  constructor(
    private readonly text: string,
    private readonly fieldLimit = FIELD_LIMIT,
  ) {}

  *[Symbol.iterator](): Iterator<string[]> {
    const lines = this.text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
    let li = 0;
    while (li < lines.length) {
      const rec: string[] = [];
      let f: string[] = [];
      let state: 'rec' | 'field' | 'in' | 'q' | 'qq' | 'crnl' = 'rec';
      const save = () => {
        rec.push(f.join(''));
        f = [];
      };
      const add = (c: string) => {
        if (f.length >= this.fieldLimit)
          throw new CsvError(`field larger than field limit (${this.fieldLimit})`);
        f.push(c);
      };
      const end = (c: string) => {
        save();
        state = c === '' ? 'rec' : 'crnl';
      };
      do {
        if (li >= lines.length) {
          // EOF giữa ô trong ngoặc kép: không strict → lưu ô, trả bản ghi.
          if (f.length || state === 'q') save();
          break;
        }
        this.lineNum++;
        for (const c of [...(lines[li++] as string), '']) {
          const nl = c === '\n' || c === '\r';
          if (state === 'rec') {
            if (c === '') continue;
            if (nl) {
              state = 'crnl';
              continue;
            }
            state = 'field';
          }
          if (state === 'field') {
            if (nl || c === '') end(c);
            else if (c === '"') state = 'q';
            else if (c === ',') save();
            else {
              add(c);
              state = 'in';
            }
          } else if (state === 'in') {
            if (nl || c === '') end(c);
            else if (c === ',') {
              save();
              state = 'field';
            } else add(c);
          } else if (state === 'q') {
            if (c === '"') state = 'qq';
            else if (c !== '') add(c);
          } else if (state === 'qq') {
            if (c === '"') {
              add(c);
              state = 'q';
            } else if (c === ',') {
              save();
              state = 'field';
            } else if (nl || c === '') end(c);
            else {
              add(c);
              state = 'in';
            }
          } else if (c === '') state = 'rec'; // crnl: chỉ còn \r/\n tới hết dòng
        }
      } while (state !== 'rec');
      yield rec;
    }
  }
}

/** Python `csv.reader(io.StringIO(text, newline=""))` → mọi bản ghi (dòng trống → []). KHÔNG có trần
 * `field_size_limit` (Python ném csv.Error) — caller tự giới hạn kích thước file/ô. */
export const csvRows = (text: string): string[][] => [...new CsvReader(text, Infinity)];
