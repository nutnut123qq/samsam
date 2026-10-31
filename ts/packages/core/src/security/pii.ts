import { statSync } from 'node:fs';
import { readJsonFile } from '../config.js';
import { dataPath } from '../paths.js';
import {
  back,
  cpAt,
  D,
  findall,
  finditer,
  fwd,
  isAlnum,
  isDigit,
  isUpper,
  LETTER,
  matchAt,
  pyStrip,
  re,
  search,
  stripCombining,
  sub,
  W,
} from './py.js';

// Port `pipelines/pii.py` — che PII (SĐT VN / email / tên / địa chỉ) trong free text: convlog kênh
// chat + AI Gateway (mọi payload gửi ra nhà cung cấp phải qua đây). Lịch sử vá D5.3..v15 giữ ở bản
// Python; ở đây chỉ ghi LUẬT. Mọi quét tuyến tính (AGENTS.md Gotcha: biên số, bridging, quadratic).

// SĐT VN hoặc email. Alt 1: "0" + ≥9 số, sep LẶP được nhưng CÙNG 1 ký tự (sep trộn " - " không nối
// 2 số → khoảng giá "50.000.000 - 100.000.000" không bị ăn); `(?<!\d)` chặn giá "10.050.000.000";
// `{9,}` greedy che hết run dài. Alt 2: "+84"/"84" + ≥8 số, cùng luật sep. Alt 3: email bound
// cứng 256/253 (không backtrack bậc 2) + lookbehind (local quá dài fail hẳn → `maskEmailOversize`).
export const PII_RE = re(
  `(?<!${D})0(?:(?:([ .\\-])\\1*)?${D}){9,}` +
    `|(?<![${D}+])(?:\\+84|84)(?:(?:([ .\\-])\\2*)?${D}){8,}` +
    `|(?<![${W}.+\\-])[${W}.+\\-]{1,256}@[${W}\\-]{1,253}(?:\\.[${W}\\-]{1,253})+`,
);

const MASK = '***';
const blobSep = (s: string): string => s.replace(/[().\- ]/g, ' ');
const stripSp = (s: string): string => s.replace(/^ +| +$/g, '');
const SEP_CHARS = ' .-';
const RUN_CHARS = '+ .-';

/** Che SĐT/email (gồm SĐT dạng ngoặc nhờ `flattenParen`) trước khi ghi log / gửi AI. */
export function maskPii(text: string): string {
  return maskEmailOversize(sub(PII_RE, MASK, flattenParen(text)[0]));
}

/**
 * Bóc ngoặc/nối blob của `maskPii` → [text phẳng cho PII_RE, cạn_ngân_sách]. Group ngoặc toàn-digit
 * là "mỏ neo": chỉ nối (bridge) khi tổng digit của blob ≥ 10; ngoặc bọc non-digit giữ nguyên (")"
 * chặn bridging). 1 lượt trái→phải O(n) với ngân sách `4n+64`; cạn ngân sách → đuôi còn '(' thành
 * '***' (hướng không-rò) và cạn = true (guardrail fail-closed). Chạy trên mảng code point (chỉ số
 * và ngân sách khớp Python).
 */
export function flattenParen(text: string): [string, boolean] {
  const t = Array.from(text);
  const n = t.length;
  const out: string[] = [];
  let budget = 4 * n + 64;
  let i = 0;
  const digitOrRun = (c: string) => isDigit(c) || RUN_CHARS.includes(c);
  while (i < n && budget > 0) {
    if (t[i] !== '(') {
      out.push(t[i]);
      i++;
      continue;
    }
    const [end, scanned] = parenGroupEnd(t, i);
    budget -= Math.max(scanned - i, 1);
    if (end < 0) {
      out.push('(');
      i++;
      continue;
    }
    const i0 = i;
    let j = i0;
    while (j > 0 && digitOrRun(t[j - 1])) j--;
    const left = t.slice(j, i0).some(isDigit) ? j : i0;
    const parts: [number, number, boolean][] = [[i0, end, true]];
    i = end;
    while (i < n && budget > 0) {
      let k = i;
      while (k < n && SEP_CHARS.includes(t[k])) k++;
      if (k >= n) break;
      if (t[k] === '(') {
        const [end2, scanned2] = parenGroupEnd(t, k);
        budget -= Math.max(scanned2 - k, 1);
        if (end2 < 0 || budget <= 0) break;
        parts.push([k, end2, true]);
        i = end2;
      } else if (isDigit(t[k]) || t[k] === '+') {
        let m = k + 1;
        while (m < n && digitOrRun(t[m])) m++;
        while (m > k && !(isDigit(t[m - 1]) || t[m - 1] === '+')) m--;
        budget -= m - k;
        parts.push([k, m, false]);
        i = m;
      } else {
        break;
      }
    }
    let digits = t.slice(left, i0).filter(isDigit).length;
    for (const [a, b] of parts) digits += t.slice(a, b).filter(isDigit).length;
    if (digits >= 10) {
      out.splice(out.length - (i0 - left));
      const chunks: string[] = [];
      if (left < i0) chunks.push(stripSp(blobSep(t.slice(left, i0).join(''))));
      for (const [a, b] of parts) chunks.push(stripSp(blobSep(t.slice(a, b).join(''))));
      out.push(' ', chunks.join(' '));
      if (parts[parts.length - 1][2]) out.push(' ');
    } else {
      out.push(' ');
      i = i0;
      for (const [a, b, g] of parts) {
        if (!g) break;
        out.push(
          t
            .slice(a + 1, b - 1)
            .join('')
            .replace(/[()]/g, ' '),
          ' ',
        );
        i = b;
      }
    }
  }
  let cut = false;
  if (i < n) {
    const tail = t.slice(i).join('');
    cut = tail.includes('(');
    out.push(cut ? MASK : tail);
  }
  return [out.join(''), cut];
}

/** t[i] === '('. → [end, scanned]: end = sau ')' khớp nếu group cân bằng, toàn digit/space/+/ngoặc
 * với ≥1 digit (ASCII); ngược lại -1. scanned = vị trí quét tới (caller trừ ngân sách). */
function parenGroupEnd(t: string[], i: number): [number, number] {
  let depth = 1;
  let hasDigit = false;
  let j = i + 1;
  for (; j < t.length; j++) {
    const c = t[j];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [hasDigit ? j + 1 : -1, j];
    } else if (c >= '0' && c <= '9' && c.length === 1) hasDigit = true;
    else if (c !== ' ' && c !== '+') return [-1, j];
  }
  return [-1, j];
}

const localCh = (c: string) => isAlnum(c) || '_.+-'.includes(c);
const labelCh = (c: string) => isAlnum(c) || '_-'.includes(c);

/** Sau PII_RE: email quá bound regex (local > 256, label > 253 — RFC-invalid) còn '@' sót → che cả
 * run khi trông email-like (left ≥ 1 VÀ right có '.label'). '@' không email-like giữ nguyên. O(n). */
function maskEmailOversize(text: string): string {
  if (!text.includes('@')) return text;
  const t = Array.from(text);
  const n = t.length;
  const out: string[] = [];
  let i = 0;
  for (;;) {
    let at = -1;
    for (let k = i; k < n; k++) {
      if (t[k] === '@') {
        at = k;
        break;
      }
    }
    if (at < 0) {
      out.push(t.slice(i).join(''));
      break;
    }
    let ls = at;
    while (ls > i && localCh(t[ls - 1])) ls--;
    let hasDot = false;
    let over = at - ls > 256;
    let r = at + 1;
    while (r < n && labelCh(t[r])) {
      let le = r;
      while (le < n && labelCh(t[le])) le++;
      over = over || le - r > 253;
      r = le;
      if (r + 1 < n && t[r] === '.' && labelCh(t[r + 1])) {
        hasDot = true;
        r++;
      } else break;
    }
    if (ls < at && hasDot && over) {
      out.push(t.slice(i, ls).join(''), MASK);
      i = r;
    } else {
      out.push(t.slice(i, at + 1).join(''));
      i = at + 1;
    }
  }
  return out.join('');
}

// --- v13.1 (F02): tên + địa chỉ tự do --------------------------------------------------------
// `maskIdentity` (gateway, MỌI message): tên sau mẫu XƯNG DANH + địa chỉ có SỐ NHÀ; địa chỉ công
// khai của công ty (`allowAddr`) giữ nguyên. `scrubUser` (text KHÁCH gõ): thêm danh xưng + tên Viết
// Hoa + từ điển tên, rồi `identityResidual` → còn dấu hiệu PII → KHÔNG gọi AI, chuyển người.
// Cụm khớp trên bản bỏ dấu + chữ thường GIỮ ĐỘ DÀI (`foldKeep`); Viết Hoa xét trên text gốc. Sau
// cue chỉ đi tới ≤6 từ; KHÔNG để 2 lượng từ khoảng trắng kề nhau (O(n\u00b2) trên chuỗi trắng dài).

const NW_B = `(?<![${W}])`; // (?<!\w)
const NW_A = `(?![${W}])`; // (?!\w)
const WORD_RE = re(`${LETTER}+`);
const NUM = `${D}{1,5}[a-z]?(?:[ \\t]*[/\\-][ \\t]*${D}{1,5}[a-z]?){0,3}`;
const NAME_STRONG_RE = re(
  `${NW_B}(?:(?:ho[ \\t]+(?:va[ \\t]+)?)?ten[ \\t]+(?:cua[ \\t]+)?` +
    '(?:toi|em|minh|to|chau|con|anh|chi|nguoi[ \\t]+nhan)(?:[ \\t]+la)?' +
    '|(?:toi|em|minh|to|chau|con)[ \\t]+ten(?:[ \\t]+la)?' +
    '|ho[ \\t]+(?:va[ \\t]+)?ten(?:[ \\t]+la)?' +
    `|nguoi[ \\t]+nhan(?:[ \\t]+la)?)${NW_A}[ \\t]*[:\\-]?[ \\t]*`,
);
const NAME_WEAK_RE = re(
  `${NW_B}(?:toi|em|minh|to|day)[ \\t]+la[ \\t]+(?:(?:anh|chi|co|chu|bac|ong|ba|em)[ \\t]+)?`,
);
// Danh xưng (xét trên text GỐC chữ thường — "có"/"cô", "bà"/"ba" bỏ dấu trùng nhau).
const HONORIFIC_RE = re(
  `${NW_B}(?:anh|chị|cô|chú|bác|ông|bà|em|bạn|cháu|cậu|dì|mợ|thím|bé|cụ)[ \\t]+(?=${LETTER})`,
);
const STREET = '(?:duong|d\\.|pho|ngo|ngach|hem|kiet)';
const ADDR_NUM_FIRST_RE = re(
  `(?<![${W}/])(?:(?:so[ \\t]+nha|nha[ \\t]+so|so|sn)[ \\t]*(?:[:.][ \\t]*)?)?` +
    `${NUM}(?:[ \\t]*,[ \\t]*|[ \\t]+)${STREET}${NW_A}`,
);
const ADDR_PREFIXED_RE = re(
  `(?<![${W}/])(?:so[ \\t]+nha|nha[ \\t]+so|sn|so)[ \\t]*(?:[:.][ \\t]*)?` +
    `${NUM}(?:[ \\t]*,[ \\t]*|[ \\t]+)(?:thon|xom|ap|to|khom|khu[ \\t]+pho|kp|xa|` +
    `phuong|p\\.|quan|q\\.|huyen|thi[ \\t]+tran|tt)${NW_A}`,
);
const ADDR_KEY_FIRST_RE = re(
  `${NW_B}(?:so[ \\t]+nha|nha[ \\t]+so|sn|ngo|ngach|hem|kiet)[ \\t]*(?:[:.][ \\t]*)?${NUM}(?![${W}/])`,
);
const ADDR_NUM_RE = re(`(?<![${W}/])${NUM}(?![${W}/])`);
const ADDR_CUE_RE = re(
  `${NW_B}(?:dia[ \\t]+chi|d/c|dc|giao|gui|ship|nha|o|tai|den|toi|ve|so)${NW_A}`,
);

const set = (words: string): ReadonlySet<string> => new Set(words.split(' '));
// Từ dừng khi đi tiếp sau cue tên/địa chỉ (bản bỏ dấu).
const STOP = set(
  'la o nha sdt so dien thoai muon can dat mua hoi giao gui ship va sinh ' +
    'nam day gi nao ai sao dang de nhe a ah khong ko k co duoc se oi ne ' +
    'nhu cua tai den toi ve cho voi shop ben em anh chi minh phuong xa quan ' +
    'huyen tinh tp thanh mat bao lau roi chua nhan email zalo',
);
const COARSE = set('quan q phuong p huyen tinh tp xa thi');
const UNITS = set(
  'hop hu chai goi vien lo cai sp san pham ngay gio tuan thang nam tieng ' +
    'phut km kg g gr ml l v k tr trieu nghin ngan d dong lan nguoi suat bo ' +
    'cap set combo phan tram duoc khong ko k nhe nha a roi chua mat bao ' +
    'truoc sau',
);
const QUESTION = set('gi nao ai sao la');
const CLAUSE_END_RE = re('[.?!;\\n]');
// Chữ Viết Hoa sau danh xưng nhưng là tên SP/thương hiệu, không phải tên người.
const NOT_NAME = set(
  'sam saphraton sapentol savigout savina savitim samsam tet shop shopee ' +
    'tiktok zalo facebook messenger cod',
);
const RESIDUAL_ADDR_CUE_RE = re(
  `${NW_B}(?:dia[ \\t]+chi|d/c|so[ \\t]+nha|nha[ \\t]+so|` +
    'nha[ \\t]+(?:toi|em|minh|anh|chi|con|chau)[ \\t]+o|' +
    `(?:giao|gui|ship|chuyen)(?:[ \\t]+hang)?[ \\t]+(?:den|toi|ve|cho|vao|o))${NW_A}`,
);

// v13 vá review (chỉ text KHÁCH): họ phổ biến + chữ Viết Hoa; họ + đệm văn/thị; địa danh bắt đầu
// bằng họ giữ nguyên; "giao/gửi cho <Tên>"; số + ≥2 chữ Viết Hoa; thôn/xóm/ấp/tổ/bản.
const SURNAMES = set(
  'nguyen tran le pham hoang huynh phan vu vo dang bui do ho ngo duong ' +
    'ly dao doan vuong trinh truong lam to ha cao dinh luu ta quach chau ' +
    'luong hua thai kieu lai tang thach mac giang ton khuc ung nong',
);
const MIDDLE = new Set(['văn', 'thị', 'van', 'thi']);
const NAME_EXCEPT: readonly string[][] = [
  'ha noi',
  'ha tinh',
  'ha giang',
  'ha nam',
  'ha dong',
  'ha long',
  'ha tien',
  'ho chi minh',
  'ho tay',
  'ho guom',
  'ho tram',
  'lam dong',
  'cao bang',
  'cao lanh',
  'cao cap',
  'phan thiet',
  'phan rang',
  'ly son',
  'le hoi',
  'mai chau',
  'thai binh',
  'thai nguyen',
  'do son',
  'dong nai',
  'kieu bao',
  'lai chau',
].map((p) => p.split(' '));
const RECIPIENT_RE = re(`${NW_B}(?:giao|gui|ship|chuyen)(?:[ \\t]+hang)?[ \\t]+cho[ \\t]+`);
const HAMLET_F_RE = re(`${NW_B}(?:thon|xom)[ \\t]+(?=[${W}])`);
const HAMLET_L_RE = re(`${NW_B}(?:ấp|tổ|bản)[ \\t]+(?=${D})`);

// v14.1 (p1): tên KHÔNG theo mẫu — từ điển công khai `data/vn_names.json` + tỉnh/alias
// `vn_provinces_2025.json`. Chỉ text KHÁCH. Che thừa rẻ hơn chuyển người → nghiêng về CHE.
const GIVE_CUE_RE = re(
  `${NW_B}(?:giao|gui|goi|ship|chuyen|tang|cho|nhan)(?:[ \\t]+hang)?(?:[ \\t]+cho)?(?:[ \\t]*:[ \\t]*|[ \\t]+)`,
);
const TEN_CUE_RE = re(`${NW_B}ten(?:[ \\t]+la)?(?:[ \\t]*:)?[ \\t]+`);
const HO_CUE_RE = re(`${NW_B}ho(?:[ \\t]+la)?(?:[ \\t]*:)?[ \\t]+`);
const LOW_RECIPIENT_RE = RECIPIENT_RE;

// Kiểu dấu CŨ/MỚI ("Hoà"/"Hòa") cùng một tên → kiểu mới (dấu ở nguyên âm đầu) cho oa/oe/uy CUỐI
// từ, không sau "q". Độ dài không đổi.
const TONE_MARKS = '\u0301\u0300\u0309\u0303\u0323';
const OLD_TONE_RE = re(`(?<!q)(o(?=[ae])|u(?=y))([aey])([${TONE_MARKS}])${NW_A}`);

function tone(w: string): string {
  const d = w.normalize('NFD');
  const d2 = sub(OLD_TONE_RE, '$1$3$2', d);
  return d2 === d ? w : d2.normalize('NFC');
}

const foldChCache = new Map<string, string>();

function foldCh(c: string): string {
  let r = foldChCache.get(c);
  if (r !== undefined) return r;
  if (c === 'đ' || c === 'Đ') r = 'd';
  else {
    const base = stripCombining(c.normalize('NFD')) || c;
    const b0 = cpAt(base, 0);
    const low = b0.toLowerCase();
    r = [...low].length === 1 ? low : b0;
    // shortcut: kết quả khác độ dài UTF-16 (vd chữ CJK tương thích → BMP) giữ ký tự gốc để
    // offset dùng chung với text gốc; chỉ gặp ở chữ ngoài tiếng Việt.
    if (r.length !== c.length) r = c;
  }
  if (foldChCache.size < 4096) foldChCache.set(c, r);
  return r;
}

/** Bỏ dấu + chữ thường, cùng độ dài UTF-16 với `t` (offset dùng chung với text gốc). */
export function foldKeep(t: string): string {
  let out = '';
  for (const c of t) out += foldCh(c);
  return out;
}

function normAddr(s: string): string {
  return (foldKeep(s).match(/[a-z0-9]+/g) ?? []).join(' ');
}

function foldWords(words: string | readonly string[]): string[] {
  const s = typeof words === 'string' ? words : words.join(' ');
  return findall(WORD_RE, foldKeep(s.normalize('NFC')));
}

type Pair = [ReadonlySet<string>, ReadonlySet<string>]; // (có dấu, bỏ dấu)
type Dict = {
  ho: Pair;
  hoRo: Pair;
  given: Pair;
  notName: Pair;
  places: Map<string, string[][]>;
};

function buildDict(doc: Record<string, string[]>, provinces: Record<string, unknown>): Dict {
  const pair = (key: string): Pair => {
    const acc = new Set(doc[key].map((w) => tone(w.normalize('NFC').toLowerCase())));
    return [acc, new Set([...acc].map(foldKeep))];
  };
  const [gAcc, gFold] = pair('ten');
  const [dAcc, dFold] = pair('dem');
  const provList = provinces.provinces ?? [];
  const aliases = provinces.aliases ?? {};
  if (!Array.isArray(provList) || typeof aliases !== 'object' || aliases === null) {
    throw new TypeError('provinces');
  }
  const places = new Map<string, string[][]>();
  const add = (key: string[]) => {
    const l = places.get(key[0]);
    if (l) l.push(key);
    else places.set(key[0], [key]);
  };
  const aliasKeys = Array.isArray(aliases) ? aliases : Object.keys(aliases);
  for (const p of [...doc.dia_danh, ...provList, ...aliasKeys]) {
    if (typeof p !== 'string' && !(Array.isArray(p) && p.every((x) => typeof x === 'string'))) {
      throw new TypeError('place');
    }
    let key = foldWords(p);
    if (key.length && key[0] === 'tp') key = key.slice(1);
    if (key.length) add(key);
  }
  for (const x of NAME_EXCEPT) add([...x]);
  return {
    ho: pair('ho'),
    hoRo: pair('ho_ro'),
    given: [new Set([...gAcc, ...dAcc]), new Set([...gFold, ...dFold])],
    notName: pair('khong_phai_ten'),
    places,
  };
}

const namesFiles = {
  names: dataPath('vn_names.json'),
  provinces: dataPath('vn_provinces_2025.json'),
};

/** Đọc + kiểm 2 file từ điển; thiếu/hỏng → null (fail-closed). */
function loadNames(): Dict | null {
  try {
    const doc = readJsonFile<Record<string, unknown>>(namesFiles.names);
    const prov = readJsonFile<unknown>(namesFiles.provinces);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    for (const k of ['ho', 'ho_ro', 'dem', 'ten', 'khong_phai_ten', 'dia_danh']) {
      const v = doc[k];
      if (
        !Array.isArray(v) ||
        !v.length ||
        !v.every((w) => typeof w === 'string' && pyStrip(w) !== '')
      ) {
        return null;
      }
    }
    if (!prov || typeof prov !== 'object' || Array.isArray(prov)) return null;
    return buildDict(doc as Record<string, string[]>, prov as Record<string, unknown>);
  } catch {
    return null;
  }
}

// v15 (P9.3): cache theo dấu vết file (đường dẫn + mtime + size của CẢ HAI file), kiểm dấu vết tối
// đa 1 lần / NAMES_CHECK_MS; đổi → đọc lại: hợp lệ → phục hồi, hỏng/thiếu → null (fail-closed:
// `scrubUser` coi mọi câu có chữ là còn dấu hiệu PII). Không kẹt kết quả đầu tiên tới khi restart.
export const NAMES_CHECK_MS = 5_000;
let clock = (): number => performance.now();
const namesState: { sig: string | null; val: Dict | null; at: number | null } = {
  sig: null,
  val: null,
  at: null,
};

function namesSig(): string {
  return JSON.stringify(
    [namesFiles.names, namesFiles.provinces].map((f) => {
      try {
        const st = statSync(f, { bigint: true });
        return [f, String(st.mtimeNs), String(st.size)];
      } catch {
        return [f, null, null];
      }
    }),
  );
}

function names(): Dict | null {
  const st = namesState;
  const now = clock();
  if (st.at !== null && now - st.at < NAMES_CHECK_MS) return st.val;
  const sig = namesSig();
  if (st.at === null || sig !== st.sig) {
    st.val = loadNames();
    // dấu vết lấy LẠI sau khi đọc: file bị ghi giữa chừng → lần kiểm sau đọc lại.
    st.sig = sig === namesSig() ? sig : null;
  }
  st.at = now;
  return st.val;
}

export function namesCacheClear(): void {
  Object.assign(namesState, { sig: null, val: null, at: null });
}

/** Chỉ test: đổi đường dẫn từ điển / đồng hồ (như monkeypatch NAMES_FILE/_clock). */
export function setNamesFiles(p: Partial<typeof namesFiles>): void {
  Object.assign(namesFiles, p);
  namesCacheClear();
}

export function setNamesClock(fn: (() => number) | null): void {
  clock = fn ?? (() => performance.now());
}

/** Từ t[s:e] thuộc `sets`: gõ không dấu → so bản bỏ dấu; có dấu → so đúng dạng có dấu. */
function inSets(t: string, f: string, s: number, e: number, sets: Pair): boolean {
  const w = t.slice(s, e).toLowerCase();
  const fw = f.slice(s, e);
  return w === fw ? sets[1].has(fw) : sets[0].has(tone(w));
}

const startsWith = (words: readonly string[], x: readonly string[]): boolean =>
  x.length <= words.length && x.every((v, i) => words[i] === v);

/** Cụm bắt đầu tại `s` là địa danh/cụm thường — xét ≤5 từ kế tiếp (bất kể Viết Hoa). */
function isPlace(d: Dict, f: string, s: number): boolean {
  const words = findall(WORD_RE, f, s, fwd(f, s, 60)).slice(0, 5);
  return words.length > 0 && (d.places.get(words[0]) ?? []).some((x) => startsWith(words, x));
}

/** Từ Viết Hoa tại `p` thuộc `first` → kết thúc chuỗi Viết Hoa (≤3 từ) nếu không phải địa danh/
 * tên SP; ngược lại → p. */
function capNameSpan(d: Dict, t: string, f: string, p: number, first: Pair[]): number {
  const w = matchAt(WORD_RE, f, p);
  if (
    !w ||
    !isUpper(cpAt(t, p)) ||
    NOT_NAME.has(w[0]) ||
    !first.some((s) => inSets(t, f, p, p + w[0].length, s))
  ) {
    return p;
  }
  const e = wordsAfter(t, f, p, { capOnly: true, firstFree: true, limit: 3, stop: false });
  return e === p || isPlace(d, f, p) ? p : e;
}

/** ≤3 từ liên tiếp (chỉ cách khoảng trắng) đều là tên/đệm trong từ điển, từ đầu không phải
 * `khong_phai_ten` (khi `checkNot`) → vị trí kết thúc. */
function lowNameEnd(d: Dict, t: string, f: string, p: number, checkNot = true): number {
  let end = p;
  let i = p;
  for (let n = 0; n < 3; n++) {
    let j = i;
    while (j < f.length && (f[j] === ' ' || f[j] === '\t')) j++;
    const w = matchAt(WORD_RE, f, j);
    if (!w || (n && j === i) || !inSets(t, f, j, j + w[0].length, d.given)) break;
    if (n === 0 && checkNot && inSets(t, f, j, j + w[0].length, d.notName)) break;
    end = i = j + w[0].length;
  }
  return isPlace(d, f, p) ? p : end;
}

type Span = [number, number];
const mEnd = (m: RegExpExecArray): number => m.index + m[0].length;

function dictSpans(d: Dict, t: string, f: string): Span[] {
  const spans: Span[] = [];
  for (const m of finditer(GIVE_CUE_RE, f)) {
    const e = capNameSpan(d, t, f, mEnd(m), [d.given, d.ho]);
    if (e > mEnd(m)) spans.push([mEnd(m), e]);
  }
  for (const m of finditer(WORD_RE, f)) {
    const s = m.index;
    const me = mEnd(m);
    if (SURNAMES.has(m[0]) && isUpper(cpAt(t, s))) continue; // luật họ phổ biến đã xử lý
    const nxt = matchAt(WORD_RE, f, me + 1);
    if (!nxt || f[me] !== ' ') continue;
    if (isUpper(cpAt(t, s)) && inSets(t, f, s, me, d.ho)) {
      if (capNameSpan(d, t, f, nxt.index, [d.given]) > nxt.index) {
        const e = wordsAfter(t, f, s, { capOnly: true, limit: 4, stop: false });
        if (!isPlace(d, f, s)) spans.push([s, e]);
      }
    } else if (!isUpper(cpAt(t, s)) && inSets(t, f, s, me, d.hoRo)) {
      const e = lowNameEnd(d, t, f, me, false);
      if (e > me) spans.push([s, e]);
    }
  }
  for (const m of finditer(TEN_CUE_RE, f)) {
    const me = mEnd(m);
    let e = capNameSpan(d, t, f, me, [d.given, d.ho]);
    if (e === me && !isUpper(cpAt(t, me))) e = lowNameEnd(d, t, f, me);
    if (e > me) spans.push([me, e]);
  }
  for (const m of finditer(HO_CUE_RE, f)) {
    const e = capNameSpan(d, t, f, mEnd(m), [d.ho]);
    if (e > mEnd(m)) spans.push([mEnd(m), e]);
  }
  // "tôi là tuấn": tên gõ thường trong từ điển sau tự giới thiệu (Viết Hoa: luật xưng danh yếu);
  // "giao cho hoa": tên gõ thường sau cue người nhận (Viết Hoa: luật người nhận/trao).
  for (const rx of [NAME_WEAK_RE, LOW_RECIPIENT_RE]) {
    for (const m of finditer(rx, f)) {
      const me = mEnd(m);
      if (isUpper(cpAt(t, me))) continue;
      const e = lowNameEnd(d, t, f, me);
      if (e > me) spans.push([me, e]);
    }
  }
  return spans;
}

function nameSpans(t: string, f: string): Span[] {
  const spans: Span[] = [];
  const d = names();
  for (const m of finditer(WORD_RE, f)) {
    if (!SURNAMES.has(m[0])) continue;
    const s = m.index;
    const me = mEnd(m);
    // gõ CÓ DẤU thì phải đúng dạng họ có dấu ("Tặng Mẹ": tặng ≠ Tăng); gõ không dấu giữ như v13.
    if (d !== null && t.slice(s, me).toLowerCase() !== m[0] && !inSets(t, f, s, me, d.ho)) {
      continue;
    }
    if (isUpper(cpAt(t, s))) {
      // Trong chuỗi Viết Hoa sau họ, chữ trùng từ dừng vẫn là tên — không áp STOP.
      const e = wordsAfter(t, f, me, { capOnly: true, firstFree: true, limit: 3, stop: false });
      if (e > me) {
        const words = findall(WORD_RE, f, s, e);
        if (NAME_EXCEPT.some((x) => startsWith(words, x))) continue;
        if (d !== null && isPlace(d, f, s)) continue;
        spans.push([s, e]);
        continue;
      }
      // họ Viết Hoa + đệm gõ thường ("Trần thị Bé") → rơi xuống luật họ + văn/thị.
    }
    const nxt = matchAt(WORD_RE, f, me + 1);
    if (nxt && f[me] === ' ' && MIDDLE.has(t.slice(nxt.index, mEnd(nxt)).toLowerCase())) {
      const e = wordsAfter(t, f, mEnd(nxt), { capOnly: false, firstFree: true, limit: 2 });
      if (e > mEnd(nxt)) spans.push([s, e]);
    }
  }
  return spans;
}

function userExtraSpans(t: string, f: string): Span[] {
  const spans = nameSpans(t, f);
  const d = names();
  if (d !== null) spans.push(...dictSpans(d, t, f));
  for (const m of finditer(RECIPIENT_RE, f)) {
    const e = wordsAfter(t, f, mEnd(m), { capOnly: true, firstFree: true });
    if (e > mEnd(m)) spans.push([mEnd(m), e]);
  }
  for (const m of finditer(ADDR_NUM_RE, f)) {
    const e = wordsAfter(t, f, mEnd(m), { capOnly: true, stop: false });
    const words = findall(WORD_RE, f, mEnd(m), e);
    if (words.length >= 2 && !UNITS.has(words[0]) && !NOT_NAME.has(words[0])) {
      spans.push([m.index, e]);
    }
  }
  const lower = t.toLowerCase();
  const low = lower.length === t.length ? lower : '';
  for (const m of [...finditer(HAMLET_F_RE, f), ...finditer(HAMLET_L_RE, low)]) {
    const num = matchAt(ADDR_NUM_RE, f, mEnd(m));
    const start = num ? mEnd(num) : mEnd(m);
    const e = wordsAfter(t, f, start, { capOnly: false, firstFree: !num, limit: 6 });
    if (e > mEnd(m) || num) spans.push([m.index, Math.max(e, start)]);
  }
  return spans;
}

/** Đi tiếp ≤ `limit` từ (chỉ cách khoảng trắng) từ `pos`; dừng ở dấu câu/chữ số/từ dừng. capOnly:
 * chỉ nhận từ Viết Hoa (text gốc). firstFree: từ đầu không xét STOP, chỉ loại từ hỏi. */
function wordsAfter(
  t: string,
  f: string,
  pos: number,
  o: { capOnly: boolean; firstFree?: boolean; limit?: number; stop?: boolean },
): number {
  const limit = o.limit ?? 4;
  const stop = o.stop ?? true;
  let end = pos;
  let i = pos;
  for (let n = 0; n < limit; n++) {
    let j = i;
    while (j < f.length && (f[j] === ' ' || f[j] === '\t')) j++;
    const m = matchAt(WORD_RE, f, j);
    if (!m || (n && j === i)) break;
    const w = m[0];
    if (o.capOnly && !isUpper(cpAt(t, j))) break;
    if (n === 0 && o.firstFree) {
      if (QUESTION.has(w) || (o.capOnly && NOT_NAME.has(w))) break;
    } else if (stop && STOP.has(w)) break;
    end = i = mEnd(m);
  }
  return end;
}

function spansIdentity(t: string, f: string, user: boolean): Span[] {
  const spans: Span[] = [];
  for (const m of finditer(NAME_STRONG_RE, f)) {
    const e = wordsAfter(t, f, mEnd(m), { capOnly: false, firstFree: true });
    if (e > mEnd(m)) spans.push([mEnd(m), e]);
  }
  for (const m of finditer(NAME_WEAK_RE, f)) {
    const e = wordsAfter(t, f, mEnd(m), { capOnly: true, firstFree: true });
    if (e > mEnd(m)) spans.push([mEnd(m), e]);
  }
  if (user) {
    const lower = t.toLowerCase();
    const low = lower.length === t.length ? lower : f;
    for (const m of finditer(HONORIFIC_RE, low)) {
      const e = wordsAfter(t, f, mEnd(m), { capOnly: true, firstFree: true });
      if (e > mEnd(m)) spans.push([mEnd(m), e]);
    }
    spans.push(...userExtraSpans(t, f));
  }
  for (const rx of [ADDR_NUM_FIRST_RE, ADDR_PREFIXED_RE, ADDR_KEY_FIRST_RE]) {
    for (const m of finditer(rx, f)) {
      spans.push([m.index, wordsAfter(t, f, mEnd(m), { capOnly: false, limit: 6 })]);
    }
  }
  for (const m of finditer(ADDR_NUM_RE, f)) {
    if (!search(ADDR_CUE_RE, f, back(f, m.index, 30), m.index)) continue;
    const e = wordsAfter(t, f, mEnd(m), { capOnly: true });
    // ≥2 chữ Viết Hoa ("425 Phan Bội Châu") — 1 chữ dễ là "2 Hộp".
    if (findall(WORD_RE, f, mEnd(m), e).length >= 2) spans.push([m.index, e]);
  }
  return spans;
}

/** Gộp span chồng/kề thành 1 '***'; span chứa địa chỉ được phép (đã chuẩn hóa) giữ nguyên. */
function apply(t: string, spans: Span[], allow: readonly string[]): string {
  const merged: Span[] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const out: string[] = [];
  let cur = 0;
  for (const [s, e] of merged) {
    if (allow.length && allow.some((a) => a && normAddr(t.slice(s, e)).includes(a))) continue;
    out.push(t.slice(cur, s), MASK);
    cur = e;
  }
  out.push(t.slice(cur));
  return out.join('');
}

/** Che tên theo mẫu xưng danh + địa chỉ có số nhà. `allowAddr`: địa chỉ công khai — span chứa nó
 * thì giữ. Không phải chuỗi / rỗng → trả nguyên. */
export function maskIdentity(text: string, allowAddr?: Iterable<unknown>): string;
export function maskIdentity(text: unknown, allowAddr?: Iterable<unknown>): unknown;
export function maskIdentity(text: unknown, allowAddr: Iterable<unknown> = []): unknown {
  if (typeof text !== 'string' || !text) return text;
  const t = text.normalize('NFC');
  const allow = [...allowAddr].filter((a): a is string => typeof a === 'string').map(normAddr);
  return apply(t, spansIdentity(t, foldKeep(t), false), allow);
}

/** true = còn dấu hiệu PII chưa che chắc: (1) xưng danh mà từ kế chưa thành '***'; (2) từ gợi ý
 * địa chỉ + trong cùng vế có số chưa che (không sau phường/quận…), theo sau là từ không phải đơn vị. */
export function identityResidual(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  const f = foldKeep(text.normalize('NFC'));
  for (const m of finditer(NAME_STRONG_RE, f)) {
    const w = matchAt(WORD_RE, f, mEnd(m));
    if (w && !QUESTION.has(w[0])) return true;
  }
  for (const m of finditer(RESIDUAL_ADDR_CUE_RE, f)) {
    const me = mEnd(m);
    const stop = search(CLAUSE_END_RE, f, me, fwd(f, me, 120));
    const end = stop ? stop.index : fwd(f, me, 120);
    for (const n of finditer(ADDR_NUM_RE, f, me, end)) {
      const prev = findall(WORD_RE, f, Math.max(me, back(f, n.index, 12)), n.index);
      if (prev.length && COARSE.has(prev[prev.length - 1])) continue;
      let k = mEnd(n);
      while (k < end && (f[k] === ' ' || f[k] === '\t' || f[k] === ',')) k++;
      const nxt = matchAt(WORD_RE, f, k, end);
      if (nxt && !UNITS.has(nxt[0])) return true;
    }
  }
  return false;
}

/** Text khách gõ → [đã che SĐT/email/tên/địa chỉ, còn_dấu_hiệu]. còn_dấu_hiệu → caller KHÔNG gửi
 * AI ngoài (chuyển người). Từ điển tên thiếu/hỏng → true với mọi câu có chữ (fail-closed). */
export function scrubUser(text: string): [string, boolean];
export function scrubUser(text: unknown): [unknown, boolean];
export function scrubUser(text: unknown): [unknown, boolean] {
  if (typeof text !== 'string') return [text, false];
  let t = text.normalize('NFC');
  t = apply(t, spansIdentity(t, foldKeep(t), true), []);
  t = maskPii(t);
  if (names() === null && search(WORD_RE, t)) return [t, true];
  return [t, identityResidual(t)];
}
