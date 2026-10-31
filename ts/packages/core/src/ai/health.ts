import { casefold, isCombining, stripAccents } from './text.js';
import { IGN_CLASS } from './unicode-tables.js';

// Port `pipelines/llm_gateway.is_health_question` (W31.5 → v15 P9.1) — bộ lọc câu hỏi sức khỏe:
// khách hỏi bệnh/thuốc/triệu chứng → KHÔNG để AI trả lời (TPBVSK không được tư vấn điều trị),
// chuyển người. Lệch về phía chuyển người là an toàn. Giữ nguyên danh sách + luật của Python
// (golden `__fixtures__/health.golden.json` sinh từ hàm Python thật).

const HEALTH_VI = [
  'bệnh',
  'thuốc',
  'triệu chứng',
  'chữa',
  'điều trị',
  'trị bệnh',
  'gout',
  'gút',
  'ung thư',
  'khối u',
  'tiểu đường',
  'đái tháo đường',
  'huyết áp',
  'tim mạch',
  'bệnh tim',
  'đột quỵ',
  'mỡ máu',
  'thận',
  // "ho"/"gan" trần trùng chữ không dấu ("Ho Chi Minh", "gan" = gần) → chỉ giữ dạng cụm.
  'men gan',
  'bệnh gan',
  'xơ gan',
  'gan nhiễm mỡ',
  'dạ dày',
  'viêm',
  'đau',
  'sốt',
  'bị ho',
  'ho khan',
  'ho có đờm',
  'ho ra máu',
  'mất ngủ',
  'suy nhược',
  'đường huyết',
  'mang thai',
  'có thai',
  'bầu',
  'cho con bú',
  'tác dụng phụ',
  'chống chỉ định',
  'liều',
  'kê đơn',
  'bác sĩ',
  'hóa trị',
  'xạ trị',
  'savigout',
  // Đợt hoàn thiện 22/10: triệu chứng/thể trạng + thuốc đang dùng (vẫn là DANH SÁCH TỪ).
  'mệt mỏi',
  'dị ứng',
  'kháng sinh',
  'thuốc tây',
  'đang uống thuốc',
  'paracetamol',
  'panadol',
  'efferalgan',
  'aspirin',
  'ibuprofen',
  'metformin',
  'insulin',
  'warfarin',
  'corticoid',
];
const HEALTH_ASCII = [
  'benh',
  'thuoc',
  'trieu chung',
  'chua benh',
  'dieu tri',
  'tri benh',
  'gout',
  'gut',
  'ung thu',
  'khoi u',
  'tieu duong',
  'dai thao duong',
  'huyet ap',
  'tim mach',
  'dot quy',
  'mo mau',
  'men gan',
  'suy than',
  'da day',
  'viem',
  'dau dau',
  'dau bung',
  'mat ngu',
  'suy nhuoc',
  'mang thai',
  'co thai',
  'mang bau',
  'co bau',
  'cho con bu',
  'tac dung phu',
  'chong chi dinh',
  'ke don',
  'bac si',
  'hoa tri',
  'xa tri',
  'savigout',
  // v13: bản không dấu dạng CỤM (âm tiết đơn "sot"/"dau"/"than" trùng "sót", "đâu", "than").
  'gan nhiem mo',
  'xo gan',
  'benh gan',
  'benh tim',
  'benh than',
  'soi than',
  'duong huyet',
  'dau lung',
  'dau khop',
  'dau nguc',
  'dau rang',
  'dau hong',
  'bi sot',
  'sot cao',
  'bi dau',
  'bi ho',
  'ho khan',
  'ho ra mau',
  'u buou',
  'tai bien',
  'met moi',
  'di ung',
  'khang sinh',
  'thuoc tay',
  'paracetamol',
  'panadol',
  'efferalgan',
  'aspirin',
  'ibuprofen',
  'metformin',
  'insulin',
  'warfarin',
  'corticoid',
];
// Cụm không dấu chưa có dạng có dấu trong HEALTH_VI (nhận câu gõ dấu một phần, vd "đau dau").
const HEALTH_ASCII_ACCENT: Record<string, string> = {
  'chua benh': 'chữa bệnh',
  'suy than': 'suy thận',
  'dau dau': 'đau đầu',
  'dau bung': 'đau bụng',
  'mang bau': 'mang bầu',
  'co bau': 'có bầu',
  gut: 'gút',
  'soi than': 'sỏi thận',
  'dau lung': 'đau lưng',
  'dau khop': 'đau khớp',
  'dau nguc': 'đau ngực',
  'dau rang': 'đau răng',
  'dau hong': 'đau họng',
  'bi sot': 'bị sốt',
  'sot cao': 'sốt cao',
  'bi dau': 'bị đau',
  'bi ho': 'bị ho',
  'u buou': 'u bướu',
  'tai bien': 'tai biến',
};

const W = '[\\p{L}\\p{N}_]'; // Python `\w` (str): chữ + số Unicode + '_'
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kwRe = (words: string[]) =>
  new RegExp(`(?<!${W})(?:${words.map(escapeRe).join('|')})(?!${W})`, 'u');
const HEALTH_VI_RE = kwRe(HEALTH_VI);

const SYL_RE = /[\p{L}\p{N}]+/gu; // Python `[^\W_]+`
const IGN_RE = new RegExp(`[${IGN_CLASS}]+`, 'u');

const split = (s: string) => s.split(' ').filter(Boolean);

/** Python `_marks`: (dấu kết hợp đã sắp, có "đ") → khóa so sánh. */
function marksList(syl: string): string[] {
  return Array.from(syl.normalize('NFD'))
    .filter(isCombining)
    .sort((a, b) => (a.codePointAt(0) as number) - (b.codePointAt(0) as number));
}
function marks(syl: string): string {
  return `${marksList(syl).join('')}|${syl.includes('đ') ? 1 : 0}`;
}

/** Bộ dấu của `orig` là TẬP CON bộ dấu của `acc` ("đuong" ⊂ "đường"); dấu sai → false. */
function marksSub(orig: string, acc: string): boolean {
  const rest = marksList(acc);
  for (const c of marksList(orig)) {
    const i = rest.indexOf(c);
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return acc.includes('đ') || !orig.includes('đ');
}

function sylOk(orig: string, acc: string | null, bare: boolean, partial = false): boolean {
  if (stripAccents(orig) === orig) return bare || acc === orig;
  if (acc === null) return false;
  return marks(orig) === marks(acc) || (partial && marksSub(orig, acc));
}

type Rule = { key: string[]; acc: string[] | null; bare: boolean };

/** [(âm tiết bỏ dấu, âm tiết có dấu|null, cho phép viết trần)] — thứ tự như dict Python. */
function healthRules(): Rule[] {
  const vi = new Map<string, string[]>();
  for (const p of HEALTH_VI) {
    const k = split(stripAccents(p)).join(' ');
    if (!vi.has(k)) vi.set(k, split(p));
  }
  const rules = new Map<string, { acc: string[] | null; bare: boolean }>();
  for (const [k, acc] of vi) rules.set(k, { acc, bare: false });
  for (const p of HEALTH_ASCII) {
    const k = split(p).join(' ');
    const a = vi.get(k) ?? HEALTH_ASCII_ACCENT[p] ?? null;
    rules.set(k, { acc: typeof a === 'string' ? split(a) : a, bare: true });
  }
  return [...rules].map(([k, v]) => ({ key: k.split(' '), ...v }));
}

const HEALTH_RULES = healthRules();
const HEALTH_BY_FIRST = new Map<string, Rule[]>();
for (const r of HEALTH_RULES) {
  const l = HEALTH_BY_FIRST.get(r.key[0]) ?? [];
  l.push(r);
  HEALTH_BY_FIRST.set(r.key[0], l);
}
// Cụm dính liền: bản bỏ dấu → [bản có dấu|null, bare] (mục sau ghi đè như dict comprehension).
const HEALTH_JOINED = new Map<string, [string | null, boolean]>();
for (const r of HEALTH_RULES) {
  if (r.key.length > 1) HEALTH_JOINED.set(r.key.join(''), [r.acc ? r.acc.join('') : null, r.bare]);
}

// v14.1 (p1): bệnh/triệu chứng ĐƠN ÂM TIẾT chỉ bắt theo NGỮ CẢNH "bị|mắc|chữa" đứng ngay trước
// (âm tiết trần trùng từ thường: "gan" = gần, "tim" = tìm, "than" = than phiền) — luật ở Python.
const CTX_TRIG: Record<string, string> = { bi: 'bị', mac: 'mắc', chua: 'chữa' };
const CTX_DIS = new Map<string, string>();
for (const v of [
  'sốt',
  'đau',
  'ho',
  'thận',
  'gan',
  'tim',
  'phổi',
  'khớp',
  'cảm',
  'cúm',
  'gút',
  'gout',
  'sỏi',
  'trĩ',
  'hen',
  'suyễn',
  'ngứa',
  'u',
  'lao',
  'nám',
  'mụn',
  'zona',
  'lậu',
  'giang mai',
]) {
  CTX_DIS.set(stripAccents(v), v);
}
const CTX_BARE: Record<string, Set<string>> = {
  bi: new Set([
    'sot',
    'dau',
    'ho',
    'than',
    'gan',
    'tim',
    'khop',
    'cum',
    'gut',
    'gout',
    'ngua',
    'suyen',
    'zona',
  ]),
  mac: new Set(['sot', 'ho', 'gan', 'cum', 'gut', 'gout', 'suyen', 'lao', 'zona']),
  chua: new Set(['sot', 'gan', 'cum', 'gut', 'gout', 'suyen']),
};
const CTX_NEXT_STOP: Record<string, string[]> = {
  than: ['phien', 'van', 'tho', 'thoai'],
  ho: ['tro', 'so', 'hang', 'ten', 'lam', 'khau', 'chieu', 'gia', 'kinh', 'lua', 'goi'],
  tim: ['thay', 'kiem', 'hieu', 'ra', 'duoc', 'cach', 'toi'],
  gan: ['day', 'nhu', 'ket', 'gui', 'het'],
  cam: ['on', 'dong', 'xuc', 'nhan', 'thay', 'giac', 'hung', 'tinh'],
  lao: ['dong', 'xuong', 'vao', 'toi', 'ra'],
  u: ['am', 'me'],
};

// v15 (P9.1): ký tự VÔ HÌNH là RANH GIỚI MỀM — vừa có thể là khoảng trắng ("bị|gan"), vừa có
// thể là chỗ chèn trong từ ("g|an" → "gan"); "âm tiết ảo" = 1..n mảnh nối qua ranh giới mềm.
type Atom = [orig: string, plain: string, softLink: boolean];

/** NFKC + casefold, bỏ ký tự vô hình → [text, vị trí ranh giới mềm]. */
function clean(text: string): [string, number[]] {
  const t = casefold(text.normalize('NFKC'));
  const parts = t.split(IGN_RE);
  if (parts.length === 1) return [t, []];
  let out = '';
  const soft: number[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (out) soft.push(out.length);
    out += p;
  }
  return [out, soft];
}

function atomsOf(t: string, soft: number[]): Atom[] {
  const atoms: Atom[] = [];
  let k = 0;
  for (const m of t.matchAll(SYL_RE)) {
    const s = m.index as number;
    const e = s + m[0].length;
    while (k < soft.length && soft[k] <= s) k++;
    let prev = s;
    let link = false;
    while (k < soft.length && soft[k] < e) {
      const o = t.slice(prev, soft[k]);
      atoms.push([o, stripAccents(o), link]);
      prev = soft[k];
      link = true;
      k++;
    }
    const o = t.slice(prev, e);
    atoms.push([o, stripAccents(o), link]);
  }
  return atoms;
}

const prefixes = (words: Iterable<string>) => {
  const out = new Set<string>();
  for (const w of words) for (let i = 1; i <= w.length; i++) out.add(w.slice(0, i));
  return out;
};

/** Âm tiết ảo bắt đầu ở mảnh i: [gốc, bỏ dấu, mảnh kế]; dừng khi bản bỏ dấu không còn trong `pre`. */
function virt(atoms: Atom[], i: number, pre: Set<string>): [string, string, number][] {
  const out: [string, string, number][] = [];
  let o = '';
  let p = '';
  let j = i;
  while (j < atoms.length && (j === i || atoms[j][2])) {
    o += atoms[j][0];
    p += atoms[j][1];
    j++;
    if (!pre.has(p)) break;
    out.push([o, p, j]);
  }
  return out;
}

const TRIG_PRE = prefixes(Object.keys(CTX_TRIG));
const DIS_PRE = prefixes([...CTX_DIS.keys()].flatMap((k) => k.split(' ')));
const DIS2_FIRST = new Set(
  [...CTX_DIS.keys()].filter((k) => k.includes(' ')).map((k) => k.split(' ')[0]),
);
const STOP_PRE = Object.fromEntries(
  Object.entries(CTX_NEXT_STOP).map(([d, v]) => [d, prefixes(v)]),
);

function ctxDisOk(
  parts: string[],
  dis: string,
  d: string,
  trigPlain: string,
  trigBare: boolean,
): boolean {
  const accs = dis.split(' ');
  for (let x = 0; x < Math.min(parts.length, accs.length); x++) {
    const o2 = parts[x];
    const acc = accs[x];
    let ok: boolean;
    if (stripAccents(o2) !== o2) ok = marksSub(o2, acc);
    else if (stripAccents(acc) === acc) ok = !trigBare || CTX_BARE[trigPlain].has(d);
    else ok = CTX_BARE[trigPlain].has(d);
    if (!ok) return false;
  }
  return true;
}

function healthCtx(atoms: Atom[], i: number): boolean {
  for (const [o, p, j] of virt(atoms, i, TRIG_PRE)) {
    const trig = CTX_TRIG[p];
    if (trig === undefined) continue;
    const trigBare = stripAccents(o) === o;
    if (!trigBare && marks(o) !== marks(trig)) continue;
    for (const [o1, d, k] of virt(atoms, j, DIS_PRE)) {
      const cands: [string[], string, number][] = [];
      if (DIS2_FIRST.has(d)) {
        for (const [o2, d2, m] of virt(atoms, k, DIS_PRE)) {
          const dis2 = CTX_DIS.get(`${d} ${d2}`);
          if (dis2) cands.push([[o1, o2], dis2, m]);
        }
      }
      const one = CTX_DIS.get(d);
      if (one !== undefined) cands.push([[o1], one, k]);
      for (const [parts, dis, nxt] of cands) {
        const stop = CTX_NEXT_STOP[d];
        if (stop && virt(atoms, nxt, STOP_PRE[d]).some(([, sp]) => stop.includes(sp))) continue;
        if (ctxDisOk(parts, dis, d, p, trigBare)) return true;
      }
    }
  }
  return false;
}

const RULE_PRE = prefixes([...HEALTH_RULES.map((r) => r.key[0]), ...HEALTH_JOINED.keys()]);
const PART_PRE = new Map<string, Set<string>>();
for (const r of HEALTH_RULES) for (const w of r.key) PART_PRE.set(w, prefixes([w]));

/** Âm tiết 2..n của luật khớp liên tiếp từ mảnh j. */
function ruleRest(atoms: Atom[], j0: number, r: Rule): boolean {
  let j = j0;
  for (let x = 1; x < r.key.length; x++) {
    const hit = virt(atoms, j, PART_PRE.get(r.key[x]) as Set<string>).find(
      ([, p]) => p === r.key[x],
    );
    if (!hit) return false;
    if (!sylOk(hit[0], r.acc ? r.acc[x] : null, r.bare, true)) return false;
    j = hit[2];
  }
  return true;
}

export function isHealthQuestion(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const [t, soft] = clean(text);
  if (HEALTH_VI_RE.test(t)) return true;
  const atoms = atomsOf(t, soft);
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    // Lọc nhanh (tương đương): mảnh đầu phải là tiền tố của một khóa.
    if (TRIG_PRE.has(a[1]) && healthCtx(atoms, i)) return true;
    if (!RULE_PRE.has(a[1])) continue;
    for (const [o, p, j] of virt(atoms, i, RULE_PRE)) {
      const joined = HEALTH_JOINED.get(p);
      if (joined && sylOk(o, joined[0], joined[1], true)) return true;
      for (const r of HEALTH_BY_FIRST.get(p) ?? []) {
        if (sylOk(o, r.acc ? r.acc[0] : null, r.bare, r.key.length > 1) && ruleRest(atoms, j, r)) {
          return true;
        }
      }
    }
  }
  return false;
}
