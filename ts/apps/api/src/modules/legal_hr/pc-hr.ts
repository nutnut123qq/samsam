import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BLOCKS } from '@samsam/core/ops/director';
import { addDays, parseShift, type Shift, weekday } from '@samsam/core/ops/period';
import {
  cpCmp,
  isDict,
  isPyInt,
  PyFloat,
  parsePyJson,
  pyFloatStr,
  pyOsName,
} from '@samsam/core/ops/py-json';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, pyRepr, pyStr, pyStrip, stripCombining } from '@samsam/core/security/py';
import { mapHeader, nextRow, openTable, readTable, toDate } from '../fin_ar_pnl/fin-common.js';
import { clean, suffixOf, TableError } from '../intel_import/table.js';

// v12.2 PC-HR — port phần thuần của `agents/pc_hr.py` (PL01 HĐ hợp tác TEDO–Sâm Sâm, phòng "Pháp chế
// – nhân sự": mô tả công việc, sàng lọc hồ sơ, chấm công). Khối `legal_hr`, người duyệt Chuyên viên
// pháp chế. Tất định, KHÔNG LLM, KHÔNG mạng. Agent CHỈ ĐỀ XUẤT → hàng duyệt chung (`hr_jd` /
// `hr_screening` / `hr_attendance`, risk medium): KHÔNG đăng tuyển, KHÔNG liên hệ/loại ứng viên,
// KHÔNG tính lương, KHÔNG đề xuất kỷ luật.
//
// Sàng lọc: mã ứng viên = 12 ký tự đầu sha256 NỘI DUNG file (trùng nội dung = 1 hồ sơ); hàng duyệt
// KHÔNG có tên/SĐT/email/tên file. Chấm tất định theo từ khóa không dấu, từ trọn vẹn; KHÔNG tự loại
// ai. Cấu hình có tiêu chí phân biệt đối xử → từ chối. Chấm công: kiểm TOÀN file trước (lỗi → 0
// dòng), lỗi chỉ nêu số dòng + tên field, KHÔNG giá trị ô.
//
// Ngày = chuỗi 'YYYY-MM-DD' (như `ops/period`); tháng = ngày 1 của tháng. Khóa dict giữ snake_case
// như Python.

export const JD_FILE = dataPath('hr', 'jd_templates.json');
export const RULES_FILE = dataPath('hr', 'attendance_rules.json');
export const BLOCK = 'legal_hr';
export const CREATED_BY = 'agent:pc_hr';
export const CV_SUFFIXES = ['.txt', '.md'];
export const ATT_FIELDS = ['ma_nv', 'ngay', 'gio_vao', 'gio_ra'] as const;
export const MAX_GRACE = 120;
/** Trần đọc hồ sơ (Python `MAX_CV_FILES`/`MAX_CV_BYTES` — test được đổi như monkeypatch). */
export const limits = { maxCvFiles: 500, maxCvBytes: 1024 * 1024 };

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MA_NV_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/;
// Python `\d` (Unicode): `int()` nhận chữ số Unicode → giờ "1٣:00" = 13:00 như Python.
const TIME_RE = /^([01]?\p{Nd}|2[0-3]):([0-5]\p{Nd})(?::[0-5]\p{Nd})?$/u;
const ND = /^\p{Nd}$/u;
// Tiêu chí phân biệt đối xử (Bộ luật Lao động) — dạng không dấu. Cụm nhiều từ / từ hiếm khớp ở bất
// kỳ đâu trong từ khóa; 'nam'/'nu' chỉ khớp NGUYÊN từ khóa ('quảng nam' hợp lệ).
const BIAS_ANY = [
  'gioi tinh',
  'nam gioi',
  'nu gioi',
  'hon nhan',
  'ket hon',
  'doc than',
  'ton giao',
  'dan toc',
  'mang thai',
  'que quan',
  'ngoai hinh',
  'chieu cao',
  'can nang',
];
const BIAS_EXACT = ['nam', 'nu'];
// 'tuoi' không dấu trùng 'tưới'/'tươi' → chỉ bắt 'tuổi' có dấu, hoặc 'tuoi' không dấu đứng trước
// số/khoảng (review v12: 'tưới tiêu' bị chặn oan). Chạy trên `norm()` (chỉ [a-z0-9 ]).
const AGE_RE = /\btuoi\s*(?:\d|tu\b|duoi\b|tren\b|khong\s+qua\b)/;
export const NOTE_SCREEN =
  'Agent KHÔNG loại ai — danh sách chỉ xếp hạng theo từ khóa; CV diễn đạt khác từ khóa có thể bị chấm thấp. Người duyệt đọc hồ sơ gốc và quyết.';
export const NOTE_ATT =
  'Agent chỉ tổng hợp theo mã NV — KHÔNG tính lương, KHÔNG đề xuất kỷ luật; người duyệt đối chiếu đơn từ/phép trước khi dùng số.';

/** Cấu hình JD / luật ca thiếu, hỏng hoặc sai luật. */
export class HrConfigError extends Error {
  override name = 'HrConfigError';
}

// ---------------------------------------------------------------- tiện ích (thuần)

/** Không dấu, chữ thường, chỉ [a-z0-9] cách nhau 1 dấu cách. */
export function norm(s: unknown): string {
  const t = stripCombining(pyStr(s).toLowerCase().normalize('NFD').replaceAll('đ', 'd'));
  return (t.match(/[a-z0-9]+/g) ?? []).join(' ');
}

export const hasKw = (textNorm: string, kwNorm: string): boolean =>
  ` ${textNorm} `.includes(` ${kwNorm} `);

export function sha12(data: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex')
    .slice(0, 12);
}

/** Python `json.loads(p.read_bytes().decode("utf-8"))` → giá trị (số thực = PyFloat) | HrConfigError. */
function readJson(path: string): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new HrConfigError(`không đọc được ${basename(path)}: ${pyOsName(e)}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new HrConfigError(`không đọc được ${basename(path)}: UnicodeDecodeError`);
  }
  try {
    return parsePyJson(text);
  } catch {
    throw new HrConfigError(`không đọc được ${basename(path)}: JSONDecodeError`);
  }
}

function strs(v: unknown, name: string, minN = 0): string[] {
  if (
    !Array.isArray(v) ||
    v.length < minN ||
    !v.every((x) => typeof x === 'string' && pyStrip(x) !== '')
  ) {
    throw new HrConfigError(`${name}: phải là list ≥${minN} chuỗi không rỗng`);
  }
  return v as string[];
}

/** Có dấu tiếng Việt (tưới/tươi có dấu → không phải 'tuoi' gõ thiếu dấu). */
function hasAccent(s: string): boolean {
  const d = s.normalize('NFD');
  return /[đĐ]/.test(d) || stripCombining(d) !== d;
}

/** Tiêu chí phân biệt đối xử (giới tính/tuổi/hôn nhân/tôn giáo/dân tộc/quê quán/ngoại hình…). */
export function bias(s: string): boolean {
  const n = norm(s);
  if (casefold(s.normalize('NFC')).includes('tuổi')) return true;
  if (!s.includes('tuổi') && AGE_RE.test(n) && !hasAccent(s)) return true;
  return BIAS_EXACT.includes(n) || BIAS_ANY.some((b) => hasKw(n, b));
}

export type Crit = { id: string; mo_ta: string; kw: string[]; diem?: number };
export type Position = {
  key: string;
  raw: Record<string, unknown>;
  must: Crit[];
  pref: (Crit & { diem: number })[];
};

const BIAS_MSG =
  'tiêu chí phân biệt đối xử (giới tính/tuổi/hôn nhân/tôn giáo/dân tộc/quê quán/ngoại hình) — không được dùng để sàng lọc';

function crit(c: unknown, where: string, withScore: boolean): Crit {
  if (!isDict(c)) throw new HrConfigError(`${where}: phải là object`);
  const cid = c.id;
  if (!(typeof cid === 'string' && KEY_RE.test(cid))) {
    throw new HrConfigError(`${where}.id: cần mã ^[a-z][a-z0-9_]{1,39}$`);
  }
  const moTa = c.mo_ta;
  if (!(typeof moTa === 'string' && pyStrip(moTa)))
    throw new HrConfigError(`${where}.mo_ta: trống`);
  const kws = strs(c.tu_khoa, `${where}.tu_khoa`, 1);
  const norms = kws.map(norm);
  if (!norms.every(Boolean)) {
    throw new HrConfigError(`${where}.tu_khoa: có từ khóa không chứa chữ/số`);
  }
  if (bias(moTa) || kws.some(bias)) throw new HrConfigError(`${where}: ${BIAS_MSG}`);
  const out: Crit = { id: cid, mo_ta: pyStrip(moTa), kw: norms };
  if (withScore) {
    const d = c.diem;
    if (!(isPyInt(d) && d >= 1 && d <= 5)) throw new HrConfigError(`${where}.diem: phải int 1..5`);
    out.diem = d;
  }
  return out;
}

/** Python `get(k, default)`: khóa có mặt (kể cả null) → giá trị của nó. */
const getOr = (o: Record<string, unknown>, k: string, dflt: unknown): unknown =>
  Object.hasOwn(o, k) ? o[k] : dflt;

const tupleRepr = (xs: readonly string[]): string => `(${xs.map(pyRepr).join(', ')})`;
const listRepr = (xs: readonly string[]): string => `[${xs.map(pyRepr).join(', ')}]`;

export function validatePosition(key: string, p: unknown): Position {
  const where = `positions.${key}`;
  if (!KEY_RE.test(key)) throw new HrConfigError(`${where}: mã vị trí sai dạng`);
  if (!isDict(p)) throw new HrConfigError(`${where}: phải là object`);
  for (const f of ['ten', 'muc_dich']) {
    const v = p[f];
    if (!(typeof v === 'string' && pyStrip(v))) throw new HrConfigError(`${where}.${f}: trống`);
  }
  if (!(BLOCKS as readonly unknown[]).includes(p.phong_ban)) {
    throw new HrConfigError(`${where}.phong_ban: phải thuộc ${tupleRepr(BLOCKS)}`);
  }
  strs(p.nhiem_vu, `${where}.nhiem_vu`, 1);
  strs(getOr(p, 'quyen_loi', []), `${where}.quyen_loi`);
  const bb = p.bat_buoc;
  const ut = getOr(p, 'uu_tien', []);
  if (!Array.isArray(bb) || !bb.length)
    throw new HrConfigError(`${where}.bat_buoc: cần ≥1 tiêu chí`);
  if (!Array.isArray(ut)) throw new HrConfigError(`${where}.uu_tien: phải là list`);
  const must = bb.map((c, i) => crit(c, `${where}.bat_buoc[${i}]`, false));
  const pref = ut.map((c, i) => crit(c, `${where}.uu_tien[${i}]`, true)) as Position['pref'];
  const ids = [...must, ...pref].map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new HrConfigError(`${where}: id tiêu chí trùng`);
  return { key, raw: p, must, pref };
}

/** → vị trí đã kiểm. Kiểm MỌI vị trí trong file (1 vị trí hỏng = file hỏng, không dùng nửa vời).
 * Vị trí không có → HrConfigError. shortcut: thứ tự kiểm theo `Object.entries` (khóa dạng số đứng
 * trước — Python theo thứ tự file); chỉ đổi lỗi NÀO được báo khi file có ≥2 lỗi. */
export function loadPosition(key: string, path: string = JD_FILE): Position {
  const raw = readJson(path);
  const pos = isDict(raw) ? raw.positions : undefined;
  if (!isDict(pos) || !Object.keys(pos).length) {
    throw new HrConfigError("jd_templates: thiếu 'positions' (object ≥1 vị trí)");
  }
  const checked = new Map<string, Position>();
  for (const [k, v] of Object.entries(pos)) checked.set(k, validatePosition(k, v));
  const hit = checked.get(key);
  if (hit === undefined) {
    throw new HrConfigError(
      `không có vị trí '${clean(key, 40)}' — có: ${listRepr([...checked.keys()].sort(cpCmp))}`,
    );
  }
  return hit;
}

/** Python `json.dumps(v, ensure_ascii=False, sort_keys=True)` (dấu phân cách ', ' và ': '). */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  const o = v as Record<string, unknown>;
  const ks = Object.keys(o).sort(cpCmp);
  return `{${ks.map((k) => `${JSON.stringify(k)}: ${pyDumps(o[k])}`).join(', ')}}`;
}

export const positionSha = (pos: Position): string => sha12(pyDumps(pos.raw));

// ---------------------------------------------------------------- 1) mô tả công việc

export function renderJd(pos: Position): string {
  const p = pos.raw as Record<string, unknown> & {
    ten: string;
    phong_ban: string;
    muc_dich: string;
    nhiem_vu: string[];
  };
  const L = [
    `# Mô tả công việc — ${p.ten} (NHÁP chờ duyệt)`,
    '',
    `- Mã vị trí: \`${pos.key}\` · phòng ban: \`${p.phong_ban}\``,
    '- Nguồn: `data/hr/jd_templates.json` (BẢN DEV SOẠN — chờ Chuyên viên pháp chế–nhân sự + TGĐ chốt)',
    '',
    '## Mục đích',
    '',
    pyStrip(p.muc_dich),
    '',
    '## Nhiệm vụ',
    '',
  ];
  L.push(...p.nhiem_vu.map((x) => `- ${pyStrip(x)}`));
  L.push('', '## Yêu cầu bắt buộc', '');
  L.push(...pos.must.map((c) => `- ${c.mo_ta}`));
  if (pos.pref.length) {
    L.push('', '## Ưu tiên', '');
    L.push(...pos.pref.map((c) => `- ${c.mo_ta}`));
  }
  const ql = p.quyen_loi;
  if (Array.isArray(ql) && ql.length) {
    L.push('', '## Quyền lợi', '');
    L.push(...(ql as string[]).map((x) => `- ${pyStrip(x)}`));
  }
  L.push(
    '',
    'Agent chỉ soạn nháp — người duyệt sửa/duyệt trước khi đăng tuyển; hệ thống không đăng tự động.',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------- 2) sàng lọc hồ sơ

/** Python `Path.resolve()` (theo symlink khi đường tồn tại). */
function realOrResolve(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Thư mục NẰM TRONG repo (kể cả chính gốc repo) — CV có PII, repo public → từ chối. */
export function insideRepo(d: string, root: string = REPO_ROOT): boolean {
  const rel = relative(realOrResolve(root), realOrResolve(d));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export type Cand = { ma: string; files: string[]; text: string | null; why: string | null };

/** Băm luồng (không nạp cả file) → 12 ký tự đầu sha256. */
function sha12File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex').slice(0, 12);
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** → [hồ sơ, số file bỏ qua, lỗi | null]. Hồ sơ = {ma, files, text | null, why}; trùng nội dung gộp
 * 1 mã. Lỗi ≠ null → hồ sơ = []. Không đệ quy, bỏ symlink. */
export function readCvs(d: string): [Cand[], number, string | null] {
  let names: string[];
  try {
    if (!statSync(d).isDirectory()) return [[], 0, 'thư mục hồ sơ không tồn tại'];
    names = readdirSync(d).sort(cpCmp);
  } catch {
    return [[], 0, 'thư mục hồ sơ không tồn tại'];
  }
  const picked: string[] = [];
  let skipped = 0;
  for (const name of names) {
    const p = join(d, name);
    if (isLink(p) || !isFile(p) || !CV_SUFFIXES.includes(suffixOf(name))) {
      skipped += 1;
      continue;
    }
    picked.push(p);
    if (picked.length > limits.maxCvFiles) {
      return [[], skipped, `quá ${limits.maxCvFiles} hồ sơ .txt/.md — tách đợt sàng lọc`];
    }
  }
  const byMa = new Map<string, Cand>();
  for (const p of picked) {
    const name = basename(p);
    let text: string | null = null;
    let why: string | null = null;
    let data: Buffer = Buffer.alloc(0);
    let ma: string;
    try {
      if (statSync(p).size > limits.maxCvBytes) {
        ma = sha12File(p);
        why = `file > ${Math.floor(limits.maxCvBytes / 1024)}KB`;
      } else {
        data = readFileSync(p);
        ma = sha12(data);
      }
    } catch (e) {
      // không đọc được nội dung → mã theo tên file (chỉ nằm trong mã băm)
      ma = sha12(Buffer.concat([Buffer.from('\0unreadable\0'), Buffer.from(name, 'utf8')]));
      why = `không đọc được (${pyOsName(e)})`;
    }
    if (why === null) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data); // utf-8-sig: bỏ 1 BOM đầu
      } catch {
        why = 'không phải UTF-8';
      }
      if (text !== null && !pyStrip(text)) {
        text = null;
        why = 'file rỗng';
      }
    }
    const prev = byMa.get(ma);
    if (prev) {
      prev.files.push(name);
      continue;
    }
    byMa.set(ma, { ma, files: [name], text, why });
  }
  return [[...byMa.values()], skipped, null];
}

export type Score = { must_ok: string[]; must_miss: string[]; pref_ok: string[]; diem: number };
export type Ranked = Cand & Partial<Score>;

export function score(pos: Position, text: string): Score {
  const t = norm(text);
  const hit = pos.must.filter((c) => c.kw.some((k) => hasKw(t, k)));
  const pref = pos.pref.filter((c) => c.kw.some((k) => hasKw(t, k)));
  return {
    must_ok: hit.map((c) => c.id),
    must_miss: pos.must.filter((c) => !hit.includes(c)).map((c) => c.id),
    pref_ok: pref.map((c) => c.id),
    diem: pref.reduce((n, c) => n + c.diem, 0),
  };
}

/** Hồ sơ đọc được xếp (bắt buộc đạt ↓, điểm ↓, mã); không đọc được cuối (theo mã). Không bỏ hồ sơ nào. */
export function rank(pos: Position, cands: Cand[]): Ranked[] {
  const ok = cands
    .filter((c) => c.text !== null)
    .map((c) => ({ ...c, ...score(pos, c.text as string) }))
    .sort((a, b) => b.must_ok.length - a.must_ok.length || b.diem - a.diem || cpCmp(a.ma, b.ma));
  const bad = cands.filter((c) => c.text === null).sort((a, b) => cpCmp(a.ma, b.ma));
  return [...ok, ...bad];
}

export function renderScreening(pos: Position, ranked: Ranked[], skipped: number): string {
  const p = pos.raw as { ten: string };
  const desc = new Map([...pos.must, ...pos.pref].map((c) => [c.id, c.mo_ta]));
  const nBad = ranked.filter((c) => c.text === null).length;
  const L = [
    `# Sàng lọc hồ sơ — ${p.ten} (NHÁP xếp hạng chờ duyệt)`,
    '',
    `- Vị trí \`${pos.key}\` · tiêu chí mẫu \`${positionSha(pos)}\` (\`data/hr/jd_templates.json\`, BẢN DEV SOẠN)`,
    `- Hồ sơ: ${ranked.length} (đọc được ${ranked.length - nBad}, cần người đọc tay ${nBad}); file khác loại bỏ qua: ${skipped}`,
    '- Mã ứng viên = 12 ký tự đầu sha256 nội dung file — hàng duyệt KHÔNG có tên/SĐT/email/tên file',
    '',
    '| Hạng | Mã ứng viên | Bắt buộc đạt | Điểm ưu tiên | Lý do |',
    '|---|---|---|---|---|',
  ];
  const nMust = pos.must.length;
  ranked.forEach((c, i0) => {
    const i = i0 + 1;
    if (c.text === null) {
      L.push(`| ${i} | \`${c.ma}\` | — | — | cần người đọc tay: ${c.why} |`);
      return;
    }
    const s = c as Cand & Score;
    const why: string[] = [];
    const d = (ids: string[]) => ids.map((x) => desc.get(x)).join('; ');
    if (s.must_ok.length) why.push(`đạt: ${d(s.must_ok)}`);
    if (s.must_miss.length) why.push(`THIẾU: ${d(s.must_miss)}`);
    if (s.pref_ok.length) why.push(`ưu tiên: ${d(s.pref_ok)}`);
    L.push(
      `| ${i} | \`${s.ma}\` | ${s.must_ok.length}/${nMust} | ${s.diem} | ${why.join(' · ')} |`,
    );
  });
  L.push('', `**${NOTE_SCREEN}**`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------- 3) chấm công

export type Rules = { shift: Shift; grace_late_min: number; grace_early_min: number };

export function loadRules(path: string = RULES_FILE): Rules {
  const raw = readJson(path);
  if (!isDict(raw)) throw new HrConfigError('attendance_rules: phải là object');
  let shift: Shift;
  try {
    shift = parseShift(raw.shift);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new HrConfigError(`attendance_rules.shift: ${e.message}`);
  }
  const out = { shift } as Rules;
  for (const f of ['grace_late_min', 'grace_early_min'] as const) {
    const v = raw[f];
    if (!(isPyInt(v) && v >= 0 && v <= MAX_GRACE)) {
      throw new HrConfigError(`attendance_rules.${f}: phải int 0..${MAX_GRACE}`);
    }
    out[f] = v;
  }
  return out;
}

/** Giá trị chữ số Unicode (Nd): mỗi dải Nd liên tiếp bắt đầu bằng chữ số 0 (Python `int()`). */
function digitVal(c: string): number {
  const self = c.codePointAt(0) ?? 0;
  let cp = self;
  while (ND.test(String.fromCodePoint(cp - 1))) cp--;
  return (self - cp) % 10;
}

const toNum = (s: string): number => Array.from(s).reduce((n, c) => n * 10 + digitVal(c), 0);

/** 'HH:MM' (HH:MM:SS của xlsx nhận) → phút trong ngày | null. */
export function minutes(s: string | null | undefined): number | null {
  const m = s === null || s === undefined ? null : TIME_RE.exec(pyStrip(s));
  return m ? toNum(m[1] as string) * 60 + toNum(m[2] as string) : null;
}

/** Ngày cuối tháng của `month` ('YYYY-MM-DD'). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next =
    m === 12
      ? `${String(y + 1).padStart(4, '0')}-01-01`
      : `${month.slice(0, 5)}${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

/** 'YYYY-MM-DD' → strftime tối thiểu (%d %m %Y). */
export const fmtDay = (day: string, f: '%m/%Y' | '%d/%m/%Y' | '%Y-%m'): string => {
  const [y, m, d] = day.split('-') as [string, string, string];
  return f === '%m/%Y' ? `${m}/${y}` : f === '%Y-%m' ? `${y}-${m}` : `${d}/${m}/${y}`;
};

export type AttRow = {
  row_no: number;
  ma_nv: string;
  ngay: string;
  vao: number | null;
  ra: number | null;
};

/** → [dòng, lỗi, sha256 file]. Lỗi ≠ [] → dòng = [] (kiểm toàn file). Lỗi chỉ nêu số dòng + tên
 * field, KHÔNG giá trị ô. */
export async function readAttendance(
  path: string,
  month: string,
  today: string,
): Promise<[AttRow[], string[], string | null]> {
  const [src, sha, err] = readTable(path);
  if (err !== null || src === null) return [[], [err ?? 'file rỗng'], sha];
  const rows: AttRow[] = [];
  let errs: string[] = [];
  const seen = new Map<string, number>();
  const end = monthEnd(month);
  try {
    const it = await openTable(src);
    const first = nextRow(it);
    if (first === null) return [[], ['file rỗng'], sha];
    const want = Object.fromEntries(ATT_FIELDS.map((f) => [f, f]));
    const [colOf, herrs] = mapHeader(first[1], want, {}, [], 'chấm công');
    if (herrs.length) return [[], herrs, sha];
    errs = herrs;
    const width = first[1].length;
    for (let r = nextRow(it); r !== null; r = nextRow(it)) {
      const [rowNo, cells] = r;
      if (cells.slice(width).some((c) => c !== null)) {
        errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
        continue;
      }
      const rec: Record<string, string | null> = {};
      for (const [f, j] of Object.entries(colOf))
        rec[f] = j < cells.length ? (cells[j] ?? null) : null;
      const bad = (f: string, why: string) => errs.push(`dòng ${rowNo}: field '${f}' ${why}`);
      const ma = rec.ma_nv ?? null;
      const n0 = errs.length;
      if (ma === null) bad('ma_nv', 'trống');
      else if (!MA_NV_RE.test(ma) || maskPii(ma) !== ma) {
        bad(
          'ma_nv',
          'phải là mã NV ^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$ (không tên, không SĐT/email)',
        );
      }
      const day = toDate(rec.ngay ?? null);
      if (rec.ngay === null || rec.ngay === undefined) bad('ngay', 'trống');
      else if (day === null) bad('ngay', 'phải YYYY-MM-DD hoặc DD/MM/YYYY');
      else if (!(month <= day && day <= end)) bad('ngay', `ngoài tháng ${fmtDay(month, '%m/%Y')}`);
      else if (day > today) bad('ngay', 'ở tương lai');
      const vao = rec.gio_vao ?? null;
      const ra = rec.gio_ra ?? null;
      const tIn = minutes(vao);
      const tOut = minutes(ra);
      if (vao === null && ra === null) bad('gio_vao/gio_ra', 'trống cả hai');
      if (vao !== null && tIn === null) bad('gio_vao', 'phải HH:MM');
      if (ra !== null && tOut === null) bad('gio_ra', 'phải HH:MM');
      if (tIn !== null && tOut !== null && tOut <= tIn) {
        bad('gio_ra', 'phải sau gio_vao (không hỗ trợ ca qua đêm)');
      }
      if (errs.length > n0) continue;
      const key = `${ma}\u0000${day}`;
      const dup = seen.get(key);
      if (dup !== undefined) {
        errs.push(`dòng ${rowNo}: trùng (ma_nv, ngay) với dòng ${dup}`);
        continue;
      }
      seen.set(key, rowNo);
      rows.push({ row_no: rowNo, ma_nv: ma as string, ngay: day as string, vao: tIn, ra: tOut });
    }
    if (!rows.length && !errs.length) {
      return [[], ['file chỉ có header, không có dòng dữ liệu'], sha];
    }
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
  return [errs.length ? [] : rows, errs, sha];
}

export const isWorkday = (d: string, shift: Shift): boolean =>
  shift.workdays.has(weekday(d)) && !shift.holidays.has(d);

export type Stats = {
  ngay_cong: number;
  di_tre: number;
  phut_tre: number;
  ve_som: number;
  phut_som: number;
  thieu_cham: number;
  vang: number;
  ngoai_lich: number;
};

/** → {mã NV: số liệu}. `until` = ngày cuối được tính vắng (≤ cuối tháng); ngày làm sau `until`
 * không tính vắng. */
export function summarize(
  rows: AttRow[],
  month: string,
  rules: Rules,
  until: string,
): Map<string, Stats> {
  const sh = rules.shift;
  const lateAt = sh.startMin + rules.grace_late_min;
  const earlyAt = sh.endMin - rules.grace_early_min;
  const end = monthEnd(month);
  const last = until < end ? until : end;
  const workdays: string[] = [];
  for (let d = month; d <= last; d = addDays(d, 1)) if (isWorkday(d, sh)) workdays.push(d);
  const out = new Map<string, Stats>();
  const days = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = out.get(r.ma_nv);
    if (!s) {
      s = {
        ngay_cong: 0,
        di_tre: 0,
        phut_tre: 0,
        ve_som: 0,
        phut_som: 0,
        thieu_cham: 0,
        vang: 0,
        ngoai_lich: 0,
      };
      out.set(r.ma_nv, s);
      days.set(r.ma_nv, new Set());
    }
    days.get(r.ma_nv)?.add(r.ngay);
    const work = isWorkday(r.ngay, sh);
    if (!work) s.ngoai_lich += 1;
    if (r.vao !== null && r.ra !== null) s.ngay_cong += 1;
    else s.thieu_cham += 1;
    if (work && r.vao !== null && r.vao > lateAt) {
      s.di_tre += 1;
      s.phut_tre += r.vao - sh.startMin;
    }
    if (work && r.ra !== null && r.ra < earlyAt) {
      s.ve_som += 1;
      s.phut_som += sh.endMin - r.ra;
    }
  }
  for (const [ma, s] of out) {
    const seen = days.get(ma) as Set<string>;
    s.vang = workdays.filter((d) => !seen.has(d)).length;
  }
  return out;
}

const hhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function renderAttendance(
  month: string,
  stats: Map<string, Stats>,
  rules: Rules,
  until: string,
  sha: string,
): string {
  const sh = rules.shift;
  const closed = until >= monthEnd(month);
  const L = [
    `# Tổng hợp chấm công tháng ${fmtDay(month, '%m/%Y')} (NHÁP chờ duyệt)`,
    '',
    `- Ca GIẢ ĐỊNH \`data/hr/attendance_rules.json\`: ${hhmm(sh.startMin)}–${hhmm(sh.endMin)}, du di trễ ${rules.grace_late_min} phút / về sớm ${rules.grace_early_min} phút; lịch nghỉ lễ: ${sh.holidays.size ? `${sh.holidays.size} ngày` : 'CHƯA CÓ (ngày lễ bị tính là ngày làm)'}`,
    `- File chấm công sha256 \`${sha.slice(0, 12)}\` · ${stats.size} mã NV`,
    closed ? '- Kỳ ĐÃ ĐÓNG' : `- Kỳ CHƯA ĐÓNG — vắng chỉ tính tới ${fmtDay(until, '%d/%m/%Y')}`,
    '- NV không có dòng nào trong file KHÔNG xuất hiện ở đây (agent không có danh sách NV)',
    '',
    '| Mã NV | Ngày công | Đi trễ (lần/phút) | Về sớm (lần/phút) | Thiếu chấm | Vắng không chấm | Chấm ngoài lịch |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const ma of [...stats.keys()].sort(cpCmp)) {
    const s = stats.get(ma) as Stats;
    L.push(
      `| \`${ma}\` | ${s.ngay_cong} | ${s.di_tre}/${s.phut_tre} | ${s.ve_som}/${s.phut_som} | ${s.thieu_cham} | ${s.vang} | ${s.ngoai_lich} |`,
    );
  }
  L.push('', `**${NOTE_ATT}**`, '');
  return L.join('\n');
}
