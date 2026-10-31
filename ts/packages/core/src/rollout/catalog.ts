import { basename } from 'node:path';
import { pyStrip } from '../env.js';
import { BLOCKS } from '../ops/director.js';
import { addDays, parseShift, type Shift, vnDate, weekday } from '../ops/period.js';
import {
  cpLen,
  foldPrefix,
  isPlainObject,
  isPrintable,
  JsonFileError,
  readJson,
} from '../ops/py.js';
import { oneline } from '../ops/store.js';
import { dataPath } from '../paths.js';
import { maskPii } from '../security/pii.js';
import { pyRepr, pyTruthy } from '../security/py.js';
import { type Feature, FILES, pyDumps, pySorted, type Source, TABLES } from './counters.js';

// Port phần THUẦN của `pipelines/rollout.py` (v12.1 B1 … đợt DOCX): danh mục yêu cầu HĐ
// `data/contract_features.json` (kiểm schema, fail-closed), lịch ngày làm việc, cổng PL02 mục 1
// (`evaluate`), `--by` người thật. Bộ đếm đầu ra ở `counters.ts`; cưỡng chế + DB ở `rollout.ts`.

export const STAGES = ['chay_thu', 'co_nguoi_duyet', 'van_hanh', 'tat'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<string, string> = {
  chay_thu: 'chạy thử',
  co_nguoi_duyet: 'có người duyệt',
  van_hanh: 'vận hành',
  tat: 'tắt',
};
export const CODE_STATES = ['co_code', 'mot_phan', 'thieu', 'lam_rieng', 'ngoai_code'];
export const CODED = ['co_code', 'mot_phan']; // có module trong repo
export const ACCEPTANCE = ['chua_nghiem_thu', 'da_nghiem_thu'];
// chỉ tinh_nang_ai tính vào 89
export const PHAM_VI = ['tinh_nang_ai', 'nen_tang_tmdt', 'truy_xuat_blockchain', 'nghia_vu_hd'];
export const PHASES = ['P1', 'P2'];
export const HD_TOTAL = 89; // HĐ: 89 tính năng / 9 phòng ban
export const SRC_KINDS = ['table', 'report', 'file'];
export const SRC_KEYS = new Set([
  ...SRC_KINDS,
  'block',
  'object_type',
  'created_by',
  'content_type',
  'source_agent',
  'rules_any',
  'kind',
  'source',
  'purpose',
  'granted',
  'action',
]);
export const TRIAL_DAYS = 5; // PL02 mục 1a
export const TRIAL_OUTPUTS = 50;
export const REVIEW_DAYS = 10; // PL02 mục 1b
export const MAX_BY = 100;
export const MAX_NOTE = 300;
export const ID_RE = /^([a-z_]+)-([0-9]{2})(?:\.([0-9]{1,2}))?$/;

// PL02 mục 2 — danh sách lỗi nghiêm trọng.
export const SEVERE: Record<string, string> = {
  tu_cam: 'Từ cấm trong đầu ra',
  ruou_cong_khai: 'Rượu xuất hiện trong nội dung công khai',
  tpbvsk_chua_xnqc: 'TPBVSK chưa có giấy XNQC ở quảng cáo/KOC/livestream',
  thieu_khuyen_cao: 'Thiếu câu khuyến cáo',
  thieu_nhan_ai: 'Nội dung AI thiếu nhãn',
  lo_pii: 'Lộ dữ liệu cá nhân',
  so_lieu_khong_nguon: 'Số liệu không có nguồn',
};

/** (đường dẫn repo, chuỗi phải có | null) — thiếu file/chuỗi → "chưa có bằng chứng". */
export type Evidence = readonly (readonly [string, string | null])[];
/** PL02 mục 2 — tiêu chí kỹ thuật: (chỉ tiêu, yêu cầu, lệnh, bằng chứng). Dòng đầu tính từ DB. */
export const CRITERIA: readonly (readonly [string, string, string | null, Evidence])[] = [
  ['Lỗi nghiêm trọng trong giai đoạn chạy có người duyệt', '0 lỗi', null, []],
  [
    'Nội dung đăng tải đã qua kiểm duyệt tự động và người duyệt',
    '100%',
    'python -m agents.bks_audit --report --month YYYY-MM · python -m pipelines.store --verify-log',
    [
      ['agents/bks_audit.py', null],
      ['pipelines/store.py', 'verify_log'],
    ],
  ],
  [
    'Lời gọi AI đi qua cổng an toàn (che dữ liệu cá nhân)',
    '100%',
    'python -m pytest tests/test_llm_gateway.py -k no_openai_constructor_outside_gateway',
    [['tests/test_llm_gateway.py', 'def test_no_openai_constructor_outside_gateway']],
  ],
  [
    'Backup dữ liệu thành công',
    '100% số ngày',
    'python scripts/db_backup.py (ghi job_runs) · python scripts/ops_monthly.py --month YYYY-MM',
    [
      ['scripts/db_backup.py', null],
      ['scripts/ops_monthly.py', null],
    ],
  ],
  [
    'Diễn tập khôi phục dữ liệu',
    '30/11/2026, 18/12/2026, sau đó mỗi quý',
    'python scripts/db_restore_drill.py · python scripts/dr_drill.py',
    [
      ['scripts/db_restore_drill.py', null],
      ['scripts/dr_drill.py', null],
    ],
  ],
  [
    'Phát hiện sự cố hệ thống',
    'Trong vòng 15 phút',
    'deploy/docker-compose.monitoring.yml (Uptime Kuma) · python scripts/health_bulletin.py',
    [
      ['deploy/docker-compose.monitoring.yml', null],
      ['scripts/health_bulletin.py', null],
    ],
  ],
  // Đợt an toàn A06: sổ sự cố vận hành (append-only) — mục 3b đọc thật từ DB; thiếu sự kiện ≠ đạt.
  [
    'Phản hồi lỗi nghiêm trọng',
    'Trong vòng 03 giờ',
    'python -m pipelines.ops_incidents --list --month YYYY-MM',
    [['pipelines/ops_incidents.py', null]],
  ],
  [
    'Phản hồi lỗi thường',
    'Trong vòng 03 ngày làm việc',
    'python -m pipelines.ops_incidents --list --month YYYY-MM',
    [['pipelines/ops_incidents.py', null]],
  ],
  [
    'Sửa lỗi phát sinh',
    'Trong vòng 07 ngày',
    'python -m pipelines.ops_incidents --list --month YYYY-MM',
    [['pipelines/ops_incidents.py', null]],
  ],
  [
    'Phản hồi tự động của chatbot',
    'Trong vòng 30 giây',
    'convlog `reply_ms` · python scripts/ops_monthly.py --month YYYY-MM',
    [
      ['connectors/zalo.py', 'reply_ms'],
      ['scripts/ops_monthly.py', null],
    ],
  ],
  ['Hạ tầng', 'Theo PL01 mục 8', 'deploy/onprem/README.md', [['deploy/onprem/README.md', null]]],
];

/** Bị từ chối (exit 1) — chưa đủ cổng, không có trong sổ/danh mục. */
export class RolloutError extends Error {}

// ------------------------------------------------------------ Python repr / json.dumps

export const tup = (xs: readonly string[]): string => `(${xs.map(pyRepr).join(', ')})`;
export const lst = (xs: readonly string[]): string => `[${xs.map(pyRepr).join(', ')}]`;
// ------------------------------------------------------------ cấu hình

const nonblank = (v: unknown): v is string => typeof v === 'string' && pyStrip(v) !== '';

function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.every(nonblank)) {
    throw new RangeError(`${where}: phải là list chuỗi không rỗng`);
  }
  if (new Set(v).size !== v.length) throw new RangeError(`${where}: có phần tử trùng`);
  return v;
}

function checkSources(fid: string, srcs: unknown): Source[] {
  // loader chỉ ném RangeError (Python ValueError — fail-closed)
  if (!Array.isArray(srcs)) throw new RangeError(`${fid}.output_sources: phải là list`);
  srcs.forEach((d, j) => {
    const w = `${fid}.output_sources[${j}]`;
    if (
      !isPlainObject(d) ||
      Object.keys(d).some((k) => !SRC_KEYS.has(k)) ||
      SRC_KINDS.filter((k) => k in d).length !== 1
    ) {
      throw new RangeError(
        `${w}: phải là object có đúng 1 trong ${tup(SRC_KINDS)}, key ⊂ ${lst(pySorted(SRC_KEYS))}`,
      );
    }
    for (const [k, v] of Object.entries(d)) {
      if (k === 'rules_any') strList(v, `${w}.rules_any`);
      else if (!nonblank(v)) throw new RangeError(`${w}.${k}: chuỗi rỗng`);
    }
    const need =
      d.table === 'approval_queue'
        ? ['block', 'object_type']
        : d.table === 'content_drafts'
          ? ['created_by', 'content_type']
          : [];
    if (need.some((k) => !(k in d))) {
      throw new RangeError(`${w}: bảng ${d.table} cần ${tup(need)}`);
    }
    const files = Object.keys(FILES);
    if ('file' in d && (Object.keys(d).length !== 1 || !files.includes(d.file as string))) {
      throw new RangeError(
        `${w}: nguồn file chỉ nhận ${lst(pySorted(files))} (không khóa lọc) — file khác chưa có bộ đếm`,
      );
    }
    const table = d.table as string;
    const filters = Object.hasOwn(TABLES, table)
      ? Object.keys(TABLES[table]?.filters ?? {})
      : undefined;
    if (filters !== undefined) {
      // v14.3: khóa lọc phải có bộ lọc thật (bỏ qua câm = đếm chéo tính năng khác)
      const bad = Object.keys(d).filter((k) => k !== 'table' && !filters.includes(k));
      if (bad.length) {
        throw new RangeError(
          `${w}: bảng ${table} không lọc được theo ${lst(pySorted(bad))} — có ${lst(pySorted(filters))}`,
        );
      }
    }
  });
  return srcs as Source[];
}

function status(hd: number, n: number): string {
  if (n === hd) return 'khớp số lượng — nội dung chờ hai bên chốt';
  return `chưa xác định — chờ hai bên chốt (đề xuất ${n}/${hd})`;
}

type Tally = { hd: number; de_xuat: number; trang_thai: string };

/** Số mục `tinh_nang_ai` đề xuất ↔ số HĐ theo khối/giai đoạn/tổng. Khớp số lượng KHÔNG có nghĩa đã chốt. */
export function summary(
  feats: Record<string, unknown>[],
  counts: Record<string, number>,
  phases: Record<string, number>,
): Record<string, Tally | Record<string, number>> {
  const ai = feats.filter((f) => f.pham_vi === 'tinh_nang_ai');
  const out: Record<string, Tally | Record<string, number>> = {};
  const rows: [string, number, number][] = [
    ...BLOCKS.map((b): [string, number, number] => [
      b,
      counts[b] as number,
      ai.filter((f) => f.phong_ban === b).length,
    ]),
    ...PHASES.map((p): [string, number, number] => [
      p,
      phases[p] as number,
      ai.filter((f) => f.giai_doan === p).length,
    ]),
    ['tong', Object.values(counts).reduce((a, b) => a + b, 0), ai.length],
  ];
  for (const [key, hd, n] of rows) out[key] = { hd, de_xuat: n, trang_thai: status(hd, n) };
  out.ngoai_89 = Object.fromEntries(
    PHAM_VI.slice(1).map((p) => [p, feats.filter((f) => f.pham_vi === p).length]),
  );
  return out;
}

/** id nhóm cũ (v12) → các mục đã tách (theo `nhom_goc`). */
export function splitMap(feats: Feature[]): Record<string, string[]> {
  const m: Record<string, string[]> = {};
  for (const f of feats) {
    if (f.nhom_goc) {
      m[f.nhom_goc] ??= [];
      m[f.nhom_goc]?.push(f.id);
    }
  }
  return m;
}

function checkItem(i: number, f: unknown): string {
  const fid = isPlainObject(f) ? f.id : undefined;
  const m = typeof fid === 'string' ? ID_RE.exec(fid) : null;
  if (!m || !isPlainObject(f) || typeof fid !== 'string') {
    throw new RangeError(`features[${i}].id: thiếu/sai`);
  }
  if (!(BLOCKS as readonly unknown[]).includes(f.phong_ban) || m[1] !== f.phong_ban) {
    throw new RangeError(`${fid}.phong_ban: phải ∈ ${tup(BLOCKS)} và khớp tiền tố id`);
  }
  const base = `${m[1]}-${m[2]}`;
  const badGoc = m[3] ? f.nhom_goc !== base : 'nhom_goc' in f;
  if (badGoc) {
    throw new RangeError(
      `${fid}.nhom_goc: mục tách '<nhóm>.<n>' phải có nhom_goc = id nhóm; mục nguyên nhóm không có`,
    );
  }
  if (!PHAM_VI.includes(f.pham_vi as string)) {
    throw new RangeError(`${fid}.pham_vi: phải ∈ ${tup(PHAM_VI)}`);
  }
  for (const k of ['ten', 'nguon', 'nguoi_duyet', 'owner', 'dau_ra']) {
    if (!nonblank(f[k])) throw new RangeError(`${fid}.${k}: thiếu`);
  }
  if (!PHASES.includes(f.giai_doan as string)) {
    throw new RangeError(`${fid}.giai_doan: phải ∈ ${tup(PHASES)}`);
  }
  const code = f.code_status as string;
  if (!CODE_STATES.includes(code)) {
    throw new RangeError(`${fid}.code_status: phải ∈ ${tup(CODE_STATES)}`);
  }
  if (!ACCEPTANCE.includes(f.acceptance_status as string)) {
    throw new RangeError(`${fid}.acceptance_status: phải ∈ ${tup(ACCEPTANCE)}`);
  }
  if (f.acceptance_status === 'da_nghiem_thu' && !nonblank(f.bien_ban)) {
    throw new RangeError(`${fid}.bien_ban: da_nghiem_thu cần số biên bản đã ký`);
  }
  for (const k of ['modules', 'agent_ids', 'phu_thuoc', 'bang_chung']) {
    const v = f[k];
    if (pyTruthy(v) || !Array.isArray(v)) strList(v, `${fid}.${k}`);
  }
  const modules = f.modules as string[];
  if (CODED.includes(code) && !modules.length) {
    throw new RangeError(`${fid}.modules: ${code} phải có ≥1 module`);
  }
  if (
    (code === 'lam_rieng' || code === 'ngoai_code') &&
    (modules.length || (f.agent_ids as string[]).length)
  ) {
    throw new RangeError(`${fid}.modules: ${code} không có module/agent_ids trong repo`);
  }
  const srcs = checkSources(fid, f.output_sources);
  if (CODED.includes(code) && !srcs.length && !nonblank(f.output_sources_note)) {
    throw new RangeError(`${fid}.output_sources_note: output_sources rỗng phải nêu lý do`);
  }
  const b = f.blocker ?? null;
  if (!(b === null || nonblank(b)) || (code !== 'co_code' && b === null)) {
    throw new RangeError(
      `${fid}.blocker: null hoặc chuỗi; code_status ${code} phải có blocker cụ thể`,
    );
  }
  return fid;
}

/** 2 nguồn bảng cùng bảng mà mọi key chung bằng nhau (key thiếu = mọi giá trị; rules_any giao
 * nhau) → 1 dòng thuộc được cả 2 = đếm chéo. */
function overlap(a: Source, b: Source): boolean {
  if (a.table !== b.table) return false;
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (k === 'rules_any') {
      const s = new Set(a[k] as string[]);
      if (!(b[k] as string[]).some((x) => s.has(x))) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

// Python bắt (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError) → "không đọc được (<loại>)".
function readDoc(path: string): unknown {
  try {
    return readJson(path);
  } catch (e) {
    if (e instanceof JsonFileError) {
      throw new RangeError(`${basename(path)}: không đọc được (${e.pyType})`);
    }
    throw e;
  }
}

function field(doc: unknown, path: string, key: string): unknown {
  // Python `doc[key]`: không phải dict → TypeError; thiếu → KeyError.
  if (!isPlainObject(doc)) throw new RangeError(`${basename(path)}: không đọc được (TypeError)`);
  if (!(key in doc)) throw new RangeError(`${basename(path)}: không đọc được (KeyError)`);
  return doc[key];
}

/** Đọc + kiểm danh mục → list dòng. Sai → RangeError (Python ValueError — fail-closed).
 * shortcut: số `9.0` trong JSON thành 9 (JS không phân biệt int/float) — Python từ chối; giá trị
 * như nhau nên không nới cổng, đổi khi cần kiểm kiểu số tuyệt đối. */
export function loadFeatures(path: string = dataPath('contract_features.json')): Feature[] {
  const doc = readDoc(path);
  const items = field(doc, path, 'features');
  const counts = field(doc, path, 'so_tinh_nang_hd');
  const phases = field(doc, path, 'so_giai_doan_hd');
  const tong = field(doc, path, 'tong_hop');
  const gone = (doc as Record<string, unknown>).da_thay_the ?? [];
  const intOk = (n: unknown, min: number) =>
    typeof n === 'number' && Number.isInteger(n) && n >= min;
  const sum = (o: Record<string, unknown>) =>
    Object.values(o).reduce<number>((a, b) => a + (b as number), 0);
  const sameKeys = (o: Record<string, unknown>, ks: readonly string[]) =>
    Object.keys(o).length === ks.length && ks.every((k) => k in o);
  if (
    !isPlainObject(counts) ||
    !sameKeys(counts, BLOCKS) ||
    Object.values(counts).some((n) => !intOk(n, 1)) ||
    sum(counts) !== HD_TOTAL
  ) {
    throw new RangeError(
      `so_tinh_nang_hd: phải đủ ${BLOCKS.length} phòng ban, số nguyên ≥1, tổng ${HD_TOTAL}`,
    );
  }
  if (
    !isPlainObject(phases) ||
    !sameKeys(phases, PHASES) ||
    Object.values(phases).some((n) => !intOk(n, 0)) ||
    sum(phases) !== HD_TOTAL
  ) {
    throw new RangeError(`so_giai_doan_hd: phải có ${tup(PHASES)}, tổng ${HD_TOTAL}`);
  }
  if (!Array.isArray(items) || !items.length) throw new RangeError('features: rỗng');
  const out: Feature[] = [];
  const seen = new Set<string>();
  const aidOf = new Map<string, string>();
  const srcOf = new Map<string, string>();
  const tables: [string, Source][] = [];
  items.forEach((f, i) => {
    const fid = checkItem(i, f);
    if (seen.has(fid)) throw new RangeError(`features[${i}].id: trùng ${fid}`);
    const ff = f as Feature;
    for (const a of ff.agent_ids) {
      if (!aidOf.has(a)) aidOf.set(a, fid);
      if (aidOf.get(a) !== fid) {
        throw new RangeError(`${fid}.agent_ids: '${a}' đã thuộc ${aidOf.get(a)} — không đếm chéo`);
      }
    }
    for (const d of ff.output_sources) {
      const k = pyDumps(d, true);
      if (!srcOf.has(k)) srcOf.set(k, fid);
      if (srcOf.get(k) !== fid) {
        throw new RangeError(
          `${fid}.output_sources: ${k} đã thuộc ${srcOf.get(k)} — không đếm chéo`,
        );
      }
      for (const [ofid, o] of tables) {
        // v13.3: phạm vi lọc giao nhau
        if (ofid !== fid && overlap(d, o)) {
          throw new RangeError(
            `${fid}.output_sources: ${k} giao phạm vi với nguồn của ${ofid} — không đếm chéo`,
          );
        }
      }
      if ('table' in d) tables.push([fid, d]);
    }
    seen.add(fid);
    out.push(ff);
  });
  const want = summary(out, counts as Record<string, number>, phases as Record<string, number>);
  if (pyDumps(tong, true) !== pyDumps(want, true)) {
    throw new RangeError('tong_hop: lệch số mục thực của features — chạy lại summary()');
  }
  checkSuperseded(gone, out);
  return out;
}

/** Sổ `da_thay_the` = [{id, thay_bang: [id mới], ly_do}] — id cũ KHÔNG còn trong features; mỗi id
 * trong `thay_the` của mục mới phải có trong sổ và ngược lại (truy vết 2 chiều). */
function checkSuperseded(gone: unknown, feats: Feature[]): void {
  const ids = new Set(feats.map((f) => f.id));
  if (!Array.isArray(gone)) throw new RangeError('da_thay_the: phải là list');
  const reg = new Map<string, Set<unknown>>();
  gone.forEach((g, i) => {
    const oid = isPlainObject(g) ? g.id : undefined;
    if (typeof oid !== 'string' || !ID_RE.test(oid) || !isPlainObject(g)) {
      throw new RangeError(`da_thay_the[${i}].id: thiếu/sai`);
    }
    if (ids.has(oid) || reg.has(oid)) {
      throw new RangeError(`da_thay_the[${i}].id: ${oid} còn trong features hoặc trùng`);
    }
    const nw = g.thay_bang;
    if (!Array.isArray(nw) || !nw.length || !nw.every((x) => ids.has(x as string))) {
      throw new RangeError(`da_thay_the[${i}].thay_bang: id mới phải có trong features`);
    }
    if (!nonblank(g.ly_do)) throw new RangeError(`da_thay_the[${i}].ly_do: thiếu`);
    reg.set(oid, new Set(nw));
  });
  for (const f of feats) {
    const old = f.thay_the ?? [];
    if (!Array.isArray(old)) throw new RangeError(`${f.id}.thay_the: phải là list`);
    for (const o of old) {
      if (!reg.get(o)?.has(f.id)) {
        throw new RangeError(
          `${f.id}.thay_the: '${o}' không có trong da_thay_the với thay_bang chứa mục này`,
        );
      }
    }
  }
  for (const [o, nw] of reg) {
    for (const n of nw) {
      const f = feats.find((x) => x.id === n);
      if (!(f?.thay_the ?? []).includes(o)) {
        throw new RangeError(`da_thay_the: ${o} → ${n} nhưng ${n}.thay_the thiếu id cũ`);
      }
    }
  }
}

/** Lịch ngày làm việc → shift chuẩn hóa của `period` (giờ ca không dùng — đếm theo NGÀY). */
export function loadShift(path: string = dataPath('rollout_config.json')): Shift {
  const cfg = readDoc(path);
  const wd = field(cfg, path, 'workdays');
  const c = cfg as Record<string, unknown>;
  const hol = 'holidays' in c ? c.holidays : [];
  return parseShift({ start: '00:00', end: '23:59', workdays: wd, holidays: hol });
}

// ------------------------------------------------------------ thuần

/** Số ngày làm việc d với ngày_VN(since) < d ≤ ngày_VN(now). */
export function businessDays(since: Date, now: Date, shift: unknown): number {
  if (!(since instanceof Date) || !(now instanceof Date)) {
    throw new TypeError('since/now phải là datetime có múi giờ');
  }
  const s = parseShift(shift);
  const b = vnDate(now);
  let n = 0;
  for (let d = addDays(vnDate(since), 1); d <= b; d = addDays(d, 1)) {
    if (s.workdays.has(weekday(d)) && !s.holidays.has(d)) n++;
  }
  return n;
}

export function checkBy(by: unknown): string {
  const s = typeof by === 'string' ? pyStrip(by) : '';
  const p = foldPrefix(s);
  if (
    !s ||
    cpLen(s) > MAX_BY ||
    !isPrintable(s) ||
    p.startsWith('agent:') ||
    p.startsWith('system:')
  ) {
    throw new RangeError(
      `--by phải là tên NGƯỜI thật (1..${MAX_BY} ký tự, không 'agent:'/'system:')`,
    );
  }
  return s;
}

export function cleanNote(note: unknown): string | null {
  if (note === null || note === undefined || !pyStrip(String(note))) return null;
  return oneline(maskPii(String(note)), MAX_NOTE);
}

export const NO_COUNT =
  'không đếm được đầu ra — output_sources không có nguồn đếm được (chỉ có file nhật ký / bảng chưa có bộ đếm / không đọc được)';

/**
 * Cổng PL02 mục 1 → [giai đoạn đích, lý do chưa đạt]. Rỗng = đạt. `outDays` = số ngày làm việc
 * khác nhau có đầu ra; `human` = đầu ra NGƯỜI duyệt từng mục; `unapproved` = duyệt/dùng thiếu
 * người; `unreviewed` (v15.2 P8.7) = đầu ra báo cáo/bảng/file chưa có NGƯỜI duyệt đúng sha. Mặc
 * định 0 → fail-closed.
 */
export function evaluate(
  stage: string,
  days: number,
  outputs: number | null,
  severe: number,
  outDays = 0,
  human = 0,
  unapproved = 0,
  unreviewed = 0,
): [string | null, string[]] {
  const why: string[] = [];
  if (stage === 'chay_thu') {
    if (days < TRIAL_DAYS) why.push(`mới ${days}/${TRIAL_DAYS} ngày làm việc chạy thử`);
    if (outputs === null) why.push(NO_COUNT);
    else {
      if (outputs < TRIAL_OUTPUTS) why.push(`mới ${outputs}/${TRIAL_OUTPUTS} đầu ra`);
      if (outDays < TRIAL_DAYS) {
        why.push(`đầu ra mới rải trên ${outDays}/${TRIAL_DAYS} ngày làm việc`);
      }
    }
    return ['co_nguoi_duyet', why];
  }
  if (stage === 'co_nguoi_duyet') {
    if (days < REVIEW_DAYS) why.push(`mới ${days}/${REVIEW_DAYS} ngày làm việc có người duyệt`);
    if (outputs === null) why.push(NO_COUNT);
    else if (!outputs) why.push('chưa có đầu ra nào trong giai đoạn có người duyệt');
    else if (human < 1) {
      why.push(
        'chưa có đầu ra nào được NGƯỜI duyệt từng mục (không tính agent:/system:/auto_policy)',
      );
    }
    if (unapproved) {
      why.push(`${unapproved} đầu ra được duyệt/dùng không có người duyệt từng mục`);
    }
    if (unreviewed) {
      why.push(
        `${unreviewed} đầu ra báo cáo/bảng/file chưa có NGƯỜI duyệt từng mục trên đúng phiên bản nội dung (sinh ra ≠ đã duyệt — \`--review-output\`)`,
      );
    }
    if (severe) why.push(`${severe} lỗi nghiêm trọng trong giai đoạn`);
    return ['van_hanh', why];
  }
  if (stage === 'tat') return ['chay_thu', []];
  return [null, ['đã vận hành — không còn bước nâng']];
}
