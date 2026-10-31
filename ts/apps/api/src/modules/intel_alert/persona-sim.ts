import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type AiGateway, GatewayError } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { casefold, stripAccents } from '@samsam/core/ai/text';
import { createPool, databaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { cpLen, cpSlice, isPlainObject } from '@samsam/core/ops/py';
import { cpCmp, PyFloat, pyFloatStr, pyLoads } from '@samsam/core/ops/py-json';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { checkGenerate, quickMode, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { isAlcohol, KbFilterError } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import { pyRepr, pyStr, pyStrip, re, W } from '@samsam/core/security/py';
import { readGolden } from '../garden_director/scenario.js';
import { type DbLease, type Io, pyFixed1, pyPct0, pyRound1, STD_IO } from './io.js';
import { PyRandom } from './py-random.js';

// Port `scripts/persona_sim.py` (v7.3, WP09 — gộp MKT-08): nghiên cứu giả lập persona.
// Persona TỔNG HỢP (data/personas.json, không dữ liệu khách thật) chấm 0..10 các phương án truyền
// thông (data/sim_config.json), ma trận ≥3 model × ≥3 prompt × ≥5 lần lặp qua AI Gateway (agent
// `persona_sim`, kill-switch + trần + che PII ở gateway). Đúng 1 phương án ĐỐI CHỨNG cố tình yếu:
// không xếp nó thấp nhất ở ≥80% lời gọi hợp lệ → kết quả gắn cờ "KHÔNG DÙNG ĐƯỢC".
// Kết quả = KHOẢNG p10/p50/p90 — KHÔNG phải dự báo doanh số. Không đặt hàng/đổi giá/đăng bài.
// Thứ tự fail-closed: 1. đọc + `validateInputs` (lỗi → exit 1, 0 AI, 0 connect); 2. CỔNG DPIA: không
// `--dry-run` và `dpia_signed !== true` ở CẢ file `--config` LẪN file CHUẨN data/sim_config.json →
// exit 2; lượt thật cần ≥3 nhà cung cấp khác nhau (exit 2, 0 lời gọi); tính năng intel-05.1 TẮT →
// exit 2; 3. `runMatrix` — mỗi phản hồi qua guardrail; GatewayError → exit 1, 0 dòng ghi;
// 4. báo cáo qua guardrail → ghi `sim_runs` 1 giao dịch → in. `--dry-run` = gateway GIẢ tất định.

export const AGENT_ID = 'persona_sim';
export const FEATURE = 'intel-05.1';
export const CONFIG_FILE = dataPath('sim_config.json');
export const PERSONAS_FILE = dataPath('personas.json');
export const GOLDEN_FILE = dataPath('golden_skus.json');
export const MIN_REPEATS = 5;
export const MIN_MODELS = 3;
export const MIN_PROMPTS = 3;
export const MIN_PROVIDERS = 3; // r13: lượt thật — số nhà cung cấp (tiền tố provider/model) khác nhau
export const N_PERSONAS: readonly [number, number] = [6, 10];
export const CONTROL_LAST_MIN = 0.8;
export const MAX_RESP_CHARS = 20000; // phản hồi dài hơn = parse lỗi (điểm null)
export const OPTION_KINDS = ['product', 'brand_theme'] as const;
export const PERSONA_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'age_min',
  'age_max',
  'region',
  'sku_group',
  'youth',
  'traits',
  'source',
]);
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY = /^[a-z_][a-z0-9_]{0,40}$/;
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;
// So trên text đã bỏ dấu + casefold, biên từ hai phía (\w Unicode như Python).
const YOUTH_RE = re(
  `(?<![${W}])(?:gen ?z|gioi tre|hoc sinh|sinh vien|tuoi teen|teen|thanh thieu nien|tuoi hoc tro)(?![${W}])`,
);
export const INT4_MAX = 2 ** 31 - 1;
export const SIM_COLS = [
  'run_id',
  'dry_run',
  'run_date',
  'persona_set',
  'persona_set_hash',
  'model',
  'provider',
  'model_version',
  'prompt_id',
  'prompt_hash',
  'sample_idx',
  'temperature',
  'seed',
  'seed_supported',
  'option_id',
  'is_control',
  'score',
  'parse_ok',
  'guardrail_ok',
] as const;
export const NOT_FORECAST =
  'KHÔNG phải dự báo doanh số — chỉ dùng để loại bớt phương án yếu trước khi thử với khách thật.';
export const LIMITS =
  'Giới hạn: persona tổng hợp + mô hình ngôn ngữ (dữ liệu huấn luyện thiên lệch WEIRD) không đại diện người tiêu dùng Việt Nam thật.';
export const UNUSABLE = 'KHÔNG DÙNG ĐƯỢC';

type Obj = Record<string, unknown>;

/** Python `isinstance(v, int) and not isinstance(v, bool)` trên kết quả `pyLoads`. */
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Python `_is_num`: int, hoặc float hữu hạn. */
function isNum(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return v instanceof PyFloat && Number.isFinite(v.v);
}
const num = (v: unknown): number => (v instanceof PyFloat ? v.v : (v as number));

function sha12(data: Uint8Array): string {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const lf = Buffer.from(b.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  return createHash('sha256').update(lf).digest('hex').slice(0, 12);
}

/** 12 hex sha256 text prompt, CRLF→LF. */
export function promptHash(text: string): string {
  return sha12(Buffer.from(text, 'utf8'));
}

/** Tham chiếu trong thông báo lỗi: chỉ index + id dạng slug — KHÔNG in giá trị ô (id lạ có thể
 * chứa PII). */
function ref(kind: string, i: number, obj: unknown): string {
  const oid = isPlainObject(obj) ? obj.id : undefined;
  return typeof oid === 'string' && SLUG.test(oid) ? `${kind}[${i}:${oid}]` : `${kind}[${i}]`;
}

function hasPii(v: unknown): boolean {
  if (typeof v === 'string') return maskPii(v) !== v;
  if (Array.isArray(v)) return v.some(hasPii);
  return false;
}

const normText = (s: string): string => stripAccents(casefold(s));
const tup = (xs: readonly string[]): string => `(${xs.map(pyRepr).join(', ')})`;
const lst = (xs: readonly string[]): string => `[${xs.map(pyRepr).join(', ')}]`;

// ---------- kiểm đầu vào (thuần, trước mọi AI/DB) ----------

function checkCfg(cfg: Obj, errs: string[]): void {
  const r = cfg.repeats;
  if (!isInt(r) || r < MIN_REPEATS) errs.push(`sim_config.repeats: phải là int >= ${MIN_REPEATS}`);
  const models = cfg.models;
  if (!Array.isArray(models) || models.length < MIN_MODELS) {
    errs.push(`sim_config.models: cần >= ${MIN_MODELS} model`);
  } else {
    const seen = new Set<string>();
    models.forEach((m, i) => {
      const rf = `models[${i}]`;
      if (!isPlainObject(m) || typeof m.id !== 'string' || !MODEL.test(m.id) || seen.has(m.id)) {
        errs.push(`${rf}.id: thiếu/sai dạng provider/model/trùng`);
        return;
      }
      seen.add(m.id);
      if (typeof m.seed_supported !== 'boolean') errs.push(`${rf}.seed_supported: phải là bool`);
    });
  }
  const prompts = cfg.prompts;
  if (!Array.isArray(prompts) || prompts.length < MIN_PROMPTS) {
    errs.push(`sim_config.prompts: cần >= ${MIN_PROMPTS} prompt`);
  } else {
    const seen = new Set<string>();
    prompts.forEach((p, i) => {
      const rf = ref('prompts', i, p);
      if (!isPlainObject(p) || typeof p.id !== 'string' || !SLUG.test(p.id) || seen.has(p.id)) {
        errs.push(`${rf}.id: thiếu/sai dạng/trùng`);
        return;
      }
      seen.add(p.id);
      const t = p.text;
      if (typeof t !== 'string' || !t.includes('{personas}') || !t.includes('{options}')) {
        errs.push(`${rf}.text: phải có {personas} và {options}`);
      } else if (hasPii(t)) errs.push(`${rf}.text: chứa dạng PII (SĐT/email)`);
    });
  }
  const t = cfg.temperature;
  if (!isNum(t) || !(num(t) >= 0 && num(t) <= 2)) {
    errs.push('sim_config.temperature: phải là số trong 0..2');
  }
  const s = cfg.base_seed;
  if (!isInt(s) || s < 0 || (isInt(r) && s + r > INT4_MAX)) {
    errs.push('sim_config.base_seed: phải là int >= 0 (vừa cột int)');
  }
}

function checkPersonas(doc: unknown, errs: string[]): unknown[] {
  if (!isPlainObject(doc)) {
    errs.push('personas: root phải là object');
    return [];
  }
  if (doc.synthetic !== true) errs.push('personas.synthetic: phải là true (chỉ persona tổng hợp)');
  if (typeof doc.set_id !== 'string' || !SLUG.test(doc.set_id)) {
    errs.push('personas.set_id: thiếu/sai dạng');
  }
  const ps = doc.personas;
  if (!Array.isArray(ps) || !(N_PERSONAS[0] <= ps.length && ps.length <= N_PERSONAS[1])) {
    errs.push(`personas.personas: cần ${N_PERSONAS[0]}..${N_PERSONAS[1]} persona`);
    return Array.isArray(ps) ? ps : [];
  }
  const seen = new Set<string>();
  ps.forEach((p, i) => {
    const rf = ref('personas', i, p);
    if (!isPlainObject(p)) {
      errs.push(`${rf}: phải là object`);
      return;
    }
    const extra = Object.keys(p).filter((k) => !PERSONA_KEYS.has(k));
    if (extra.length) {
      const names = extra.map((k) => (KEY.test(k) ? k : '<key lạ>')).sort(cpCmp);
      errs.push(`${rf}: key ngoài allowlist ${lst(names)}`);
    }
    if (typeof p.id !== 'string' || !SLUG.test(p.id) || seen.has(p.id)) {
      errs.push(`${rf}.id: thiếu/sai dạng/trùng`);
    } else seen.add(p.id);
    if (typeof p.source !== 'string' || !pyStrip(p.source)) {
      errs.push(`${rf}.source: thiếu nguồn giả định`);
    }
    const amin = p.age_min;
    const amax = p.age_max;
    if (!isInt(amin) || !isInt(amax) || amax < amin) {
      errs.push(`${rf}.age_min/age_max: phải là int, min <= max`);
    } else if (amin < 18) errs.push(`${rf}.age_min: persona phải >= 18 tuổi`);
    if (typeof p.youth !== 'boolean') errs.push(`${rf}.youth: phải là bool`);
    if (
      Object.hasOwn(p, 'traits') &&
      !(Array.isArray(p.traits) && p.traits.every((x) => typeof x === 'string'))
    ) {
      errs.push(`${rf}.traits: phải là list chuỗi`);
    }
    for (const [k, v] of Object.entries(p)) {
      if (hasPii(v)) {
        errs.push(`${rf}.${PERSONA_KEYS.has(k) ? k : '<key lạ>'}: chứa dạng PII (SĐT/email)`);
      }
    }
  });
  return ps;
}

function minorOrYouth(ps: unknown[]): boolean {
  return ps.some(
    (p) =>
      isPlainObject(p) && (p.youth !== false || !isInt(p.age_min) || (p.age_min as number) < 18),
  );
}

function checkOptions(cfg: Obj, ps: unknown[], golden: unknown, errs: string[]): void {
  const opts = cfg.options;
  if (!Array.isArray(opts)) {
    errs.push('sim_config.options: phải là list');
    return;
  }
  const g = isPlainObject(golden) ? golden.skus : null;
  const skus = new Map<unknown, Obj>();
  for (const s of Array.isArray(g) ? g : []) if (isPlainObject(s)) skus.set(s.sku_key, s);
  const controls = opts.filter((o) => isPlainObject(o) && o.control === true);
  if (controls.length !== 1) {
    errs.push(`sim_config.options: cần đúng 1 đối chứng (control), có ${controls.length}`);
  }
  if (opts.length - controls.length < 2) errs.push('sim_config.options: cần >= 2 phương án thường');
  const seen = new Set<string>();
  const youthPanel = minorOrYouth(ps);
  opts.forEach((o, i) => {
    const rf = ref('options', i, o);
    if (!isPlainObject(o)) {
      errs.push(`${rf}: phải là object`);
      return;
    }
    if (typeof o.id !== 'string' || !SLUG.test(o.id) || seen.has(o.id)) {
      errs.push(`${rf}.id: thiếu/sai dạng/trùng`);
    } else seen.add(o.id);
    if (Object.hasOwn(o, 'control') && typeof o.control !== 'boolean') {
      errs.push(`${rf}.control: phải là bool`);
    }
    if (!(OPTION_KINDS as readonly unknown[]).includes(o.kind)) {
      errs.push(`${rf}.kind: phải thuộc ${tup(OPTION_KINDS)}`);
    }
    let keys: unknown = Object.hasOwn(o, 'sku_keys') ? o.sku_keys : [];
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && skus.has(k))) {
      errs.push(`${rf}.sku_keys: phải là list sku_key có trong golden`);
      keys = [];
    }
    const ks = keys as string[];
    const text = o.text;
    if (typeof text !== 'string' || !pyStrip(text)) {
      errs.push(`${rf}.text: thiếu`);
      return;
    }
    if (hasPii(text)) errs.push(`${rf}.text: chứa dạng PII (SĐT/email)`);
    if (!guardrailCheck(text).ok) errs.push(`${rf}.text: không qua guardrail (từ cấm/claim)`);
    let alcohol: boolean;
    try {
      alcohol = isAlcohol(text);
    } catch (e) {
      if (!(e instanceof KbFilterError)) throw e;
      errs.push(`${rf}: bộ lọc rượu lỗi — fail-closed`);
      alcohol = true;
    }
    alcohol = alcohol || ks.some((k) => skus.get(k)?.category === 'alcohol');
    if (alcohol && youthPanel) {
      errs.push(
        `${rf}: phương án rượu không được chạy với persona < 18 tuổi hoặc nhóm trẻ (youth)`,
      );
    }
    if (alcohol && YOUTH_RE.test(normText(text))) {
      errs.push(`${rf}.text: phương án rượu nhắm giới trẻ`);
    }
    if (
      o.kind !== 'brand_theme' &&
      ks.some((k) => {
        const s = skus.get(k);
        return s?.category === 'tpbvsk' && s?.xnqc_status !== 'approved';
      })
    ) {
      errs.push(`${rf}: SKU TPBVSK chưa có XNQC chỉ được làm brand_theme`);
    }
  });
}

/** Hàm thuần. [] = hợp lệ. Lỗi chỉ nêu index/id/tên field — KHÔNG giá trị ô. */
export function validateInputs(cfg: unknown, personasDoc: unknown, golden: unknown): string[] {
  if (!isPlainObject(cfg)) return ['sim_config: root phải là object'];
  const errs: string[] = [];
  checkCfg(cfg, errs);
  const ps = checkPersonas(personasDoc, errs);
  checkOptions(cfg, ps, golden, errs);
  return errs;
}

// ---------- ma trận ----------

/** Python `d[k]` — thiếu khóa → KeyError (như Python, không đoán). */
function key(d: Obj, k: string): unknown {
  if (!Object.hasOwn(d, k)) throw new Error(`KeyError: ${pyRepr(k)}`);
  return d[k];
}

export function render(
  promptText: string,
  personas: readonly Obj[],
  options: readonly Obj[],
): string {
  const plines = personas
    .map(
      (p) =>
        `- ${pyStr(key(p, 'id'))}: ${pyStr(key(p, 'label'))}; ${pyStr(key(p, 'age_min'))}–${pyStr(key(p, 'age_max'))} tuổi; ` +
        `${pyStr(key(p, 'region'))}; nhóm hàng ${pyStr(key(p, 'sku_group'))}; ` +
        ((p.traits as string[] | undefined) || []).join('; '),
    )
    .join('\n');
  const olines = options
    .map((o) => `- ${pyStr(key(o, 'id'))}: ${pyStr(key(o, 'text'))}`)
    .join('\n');
  return promptText.replaceAll('{personas}', () => plines).replaceAll('{options}', () => olines);
}

/** JSON {option_id: 0..10} đủ mọi id → dict; sai → null. */
export function parseScores(text: unknown, ids: readonly string[]): Record<string, number> | null {
  if (typeof text !== 'string') return null;
  if (cpLen(text) > MAX_RESP_CHARS) return null;
  // indexOf/lastIndexOf O(n) — không regex `\{.*\}` (bậc hai khi nhiều '{').
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  let d: unknown;
  try {
    d = pyLoads(text.slice(i, j + 1)); // NaN/Infinity → lỗi như parse_constant của Python
  } catch {
    return null;
  }
  if (!isPlainObject(d)) return null;
  const out: Record<string, number> = {};
  for (const oid of ids) {
    const v = Object.hasOwn(d, oid) ? d[oid] : undefined;
    if (!isNum(v) || !(num(v) >= 0 && num(v) <= 10)) return null;
    out[oid] = num(v);
  }
  return out;
}

export type ChatFn = (
  model: string,
  messages: ChatMessage[],
  temperature: number,
  seed: number,
) => Promise<[unknown, string | null]> | [unknown, string | null];

/** Lời gọi THẬT — chỉ qua AI Gateway (kill/trần/che PII), truyền `seed` như Python. */
export function gatewayChat(ai: Pick<AiGateway, 'chat'>): ChatFn {
  return async (model, messages, temperature, seed) => {
    const r = await ai.chat(AGENT_ID, messages, { feature: FEATURE, model, temperature, seed });
    const text = typeof r?.text === 'string' ? r.text : '';
    return [text, r?.model || model];
  };
}

/** Gateway GIẢ cho --dry-run: tất định theo (model, seed, prompt), đối chứng điểm thấp. Không gọi AI.
 * Y HỆT Python (MT19937 + round half-even) — golden. */
export function fakeChat(options: readonly Obj[]): ChatFn {
  const ids = options.map((o) => o.id as string);
  const ctrl = new Set(options.filter((o) => o.control === true).map((o) => o.id as string));
  return (model, messages, _temperature, seed) => {
    const last = messages[messages.length - 1]?.content;
    const h = sha12(Buffer.from(String(last), 'utf8'));
    const rnd = new PyRandom(`${model}|${seed}|${h}`);
    const parts = ids.map((i) => {
      const v = pyRound1(ctrl.has(i) ? rnd.uniform(0.5, 3.0) : rnd.uniform(4.0, 9.5));
      return `${JSON.stringify(i)}: ${pyFloatStr(v)}`;
    });
    return [`{${parts.join(', ')}}`, `${model}@dry-run`];
  };
}

export type SimRow = {
  run_id: string;
  dry_run: boolean;
  run_date: string;
  persona_set: string;
  persona_set_hash: string;
  model: string;
  provider: string;
  model_version: string;
  prompt_id: string;
  prompt_hash: string;
  sample_idx: number;
  temperature: number;
  seed: number;
  seed_supported: boolean;
  option_id: string;
  is_control: boolean;
  score: number | null;
  parse_ok: boolean;
  guardrail_ok: boolean;
};

/** Python `json.dumps(v, sort_keys=True, ensure_ascii=False)` (số thực kiểu Python). */
function dumpsSorted(v: unknown): string {
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (Array.isArray(v)) return `[${v.map(dumpsSorted).join(', ')}]`;
  if (isPlainObject(v)) {
    const ks = Object.keys(v).sort(cpCmp);
    return `{${ks.map((k) => `${JSON.stringify(k)}: ${dumpsSorted(v[k])}`).join(', ')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

/** → [rows, n_calls]. Đúng 1 `chatFn` / (model, prompt, lần lặp); persona panel chấm TẤT CẢ phương
 * án (thứ tự xáo theo seed — `random.Random(seed).shuffle` như Python). */
export async function runMatrix(
  cfg: Obj,
  personas: Obj,
  options: readonly Obj[],
  chatFn: ChatFn,
  runDate: string,
  o: { runId?: string; personaSetHash?: string; dryRun?: boolean } = {},
): Promise<[SimRow[], number]> {
  const runId =
    o.runId || `${runDate.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const psetHash = o.personaSetHash || sha12(Buffer.from(dumpsSorted(personas), 'utf8'));
  const panel = personas.personas as Obj[];
  const ids = options.map((x) => x.id as string);
  const temp = num(cfg.temperature);
  const rows: SimRow[] = [];
  let nCalls = 0;
  for (const m of cfg.models as Obj[]) {
    const mid = m.id as string;
    const provider = mid.split('/')[0] as string;
    for (const p of cfg.prompts as Obj[]) {
      const phash = promptHash(p.text as string);
      for (let i = 0; i < (cfg.repeats as number); i++) {
        const seed = (cfg.base_seed as number) + i;
        const order = [...options];
        new PyRandom(seed).shuffle(order);
        const msgs: ChatMessage[] = [
          { role: 'user', content: render(p.text as string, panel, order) },
        ];
        const [raw, version] = await chatFn(mid, msgs, temp, seed);
        nCalls++;
        const text = typeof raw === 'string' ? raw : '';
        const gOk = Boolean(guardrailCheck(cpSlice(text, 0, MAX_RESP_CHARS)).ok);
        const scores = parseScores(text, ids);
        for (const op of options) {
          const oid = op.id as string;
          rows.push({
            run_id: runId,
            dry_run: Boolean(o.dryRun),
            run_date: runDate,
            persona_set: personas.set_id as string,
            persona_set_hash: psetHash,
            model: mid,
            provider,
            model_version: version || mid,
            prompt_id: p.id as string,
            prompt_hash: phash,
            sample_idx: i,
            temperature: temp,
            seed,
            seed_supported: m.seed_supported as boolean,
            option_id: oid,
            is_control: op.control === true,
            score: scores !== null && gOk ? (scores[oid] as number) : null,
            parse_ok: scores !== null,
            guardrail_ok: gOk,
          });
        }
      }
    }
  }
  return [rows, nCalls];
}

// ---------- tổng hợp + báo cáo ----------

/** `statistics.quantiles(data, n=10, method="inclusive")`. */
export function quantiles10(data: readonly number[]): number[] {
  const d = [...data].sort((a, b) => a - b);
  const n = 10;
  const m = d.length - 1;
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    const j = Math.floor((i * m) / n);
    const delta = (i * m) % n;
    out.push(((d[j] as number) * (n - delta) + (d[j + 1] as number) * delta) / n);
  }
  return out;
}

export type OptStat = {
  is_control: boolean;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  n_valid: number;
  spread: number | null;
};
export type Summary = {
  options: Map<string, OptStat>;
  n_calls: number;
  n_valid_calls: number;
  control_last: number;
  control_last_rate: number;
  usable: boolean;
  flag: string | null;
};
type ScoreRow = Pick<
  SimRow,
  'model' | 'prompt_id' | 'sample_idx' | 'option_id' | 'is_control' | 'score'
>;

export function summarize(rows: readonly ScoreRow[]): Summary {
  const calls = new Map<string, ScoreRow[]>();
  for (const r of rows) {
    const k = `${r.model}\u0000${r.prompt_id}\u0000${r.sample_idx}`;
    if (!calls.has(k)) calls.set(k, []);
    (calls.get(k) as ScoreRow[]).push(r);
  }
  const valid = [...calls.values()].filter((rs) => rs.every((r) => r.score !== null));
  const opts = new Map<string, { is_control: boolean; scores: number[] }>();
  for (const r of rows) {
    if (!opts.has(r.option_id)) opts.set(r.option_id, { is_control: r.is_control, scores: [] });
  }
  for (const rs of valid) {
    for (const r of rs) opts.get(r.option_id)?.scores.push(Number(r.score));
  }
  const out = new Map<string, OptStat>();
  for (const [oid, o] of opts) {
    const s = o.scores;
    let p10: number | null = null;
    let p50: number | null = null;
    let p90: number | null = null;
    if (s.length >= 2) {
      const q = quantiles10(s);
      [p10, p50, p90] = [q[0] as number, q[4] as number, q[8] as number];
    } else if (s.length) {
      p10 = p50 = p90 = s[0] as number;
    }
    out.set(oid, {
      is_control: o.is_control,
      p10,
      p50,
      p90,
      n_valid: s.length,
      spread: p10 === null ? null : (p90 as number) - p10,
    });
  }
  let last = 0;
  for (const rs of valid) {
    const ctrl = rs.filter((r) => r.is_control).map((r) => r.score as number);
    const others = rs.filter((r) => !r.is_control).map((r) => r.score as number);
    if (ctrl.length === 1 && others.length && (ctrl[0] as number) < Math.min(...others)) last++;
  }
  const rate = valid.length ? last / valid.length : 0.0;
  const usable = valid.length > 0 && rate >= CONTROL_LAST_MIN && 2 * valid.length >= calls.size;
  return {
    options: out,
    n_calls: calls.size,
    n_valid_calls: valid.length,
    control_last: last,
    control_last_rate: rate,
    usable,
    flag: usable ? null : UNUSABLE,
  };
}

const f1 = (v: number | null): string => (v === null ? '-' : pyFixed1(v));

export function report(
  s: Summary,
  o: { runId: string; personaSet: string; personaSetHash: string; dryRun: boolean },
): string {
  const lines: string[] = [];
  if (o.dryRun) lines.push('[DRY-RUN — số giả, gateway giả, không gọi LLM]');
  lines.push(
    `Nghiên cứu giả lập persona — run ${o.runId} · persona_set ${o.personaSet} (${o.personaSetHash}) · ${s.n_calls} lời gọi, ${s.n_valid_calls} hợp lệ`,
    NOT_FORECAST,
    LIMITS,
    '',
    'phương án | khoảng p10–p90 | p50 | độ phân tán | n hợp lệ',
  );
  const entries = [...s.options.entries()].sort(
    (a, b) => Number(a[1].is_control) - Number(b[1].is_control) || cpCmp(a[0], b[0]),
  );
  for (const [oid, op] of entries) {
    const tag = op.is_control ? ' (đối chứng yếu)' : '';
    const rng = op.p10 === null ? 'không đủ dữ liệu' : `${f1(op.p10)} – ${f1(op.p90)}`;
    lines.push(`${oid}${tag} | ${rng} | ${f1(op.p50)} | ${f1(op.spread)} | ${op.n_valid}`);
  }
  lines.push(
    `Đối chứng yếu thấp nhất ở ${s.control_last}/${s.n_valid_calls} lời gọi hợp lệ (${pyPct0(s.control_last_rate)}, ngưỡng ${pyPct0(CONTROL_LAST_MIN)}).`,
  );
  if (s.flag) {
    lines.push(
      `[${s.flag}] mô hình không tách được đối chứng yếu hoặc quá ít lời gọi hợp lệ — không dùng kết quả này để chọn phương án.`,
    );
  }
  lines.push('Cần Quản lý MXH duyệt báo cáo trước khi dùng.');
  return lines.join('\n');
}

// ---------- DB ----------

/** Ghi `sim_runs` trong 1 giao dịch. intel-05.1 TẮT → RolloutBlocked (HĐ 6.7), không ghi. */
export async function writeRows(db: Db, rows: readonly SimRow[]): Promise<number> {
  await checkGenerate(db, FEATURE, 'lượt giả lập persona');
  if (!rows.length) return 0;
  const width = SIM_COLS.length;
  await withTx(db, async (c) => {
    for (let at = 0; at < rows.length; at += 1000) {
      const chunk = rows.slice(at, at + 1000);
      const ph = chunk
        .map((_, r) => `(${SIM_COLS.map((_c, k) => `$${r * width + k + 1}`).join(', ')})`)
        .join(', ');
      const params = chunk.flatMap((row) => SIM_COLS.map((col) => row[col]));
      await c.query(`insert into sim_runs (${SIM_COLS.join(', ')}) values ${ph}`, params);
    }
  });
  return rows.length;
}

// ---------- CLI ----------

/** Python `_read_json`: → [doc, null] | [null, lý do]. */
export function readJsonDoc(path: string): [unknown, string | null] {
  const name = basename(path);
  let text: string;
  try {
    // utf-8-sig: TextDecoder mặc định bỏ BOM
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (e) {
    const code = (e as { code?: string }).code;
    const t =
      code === 'ENOENT'
        ? 'FileNotFoundError'
        : code === 'EISDIR'
          ? 'IsADirectoryError'
          : code === 'EACCES' || code === 'EPERM'
            ? 'PermissionError'
            : code
              ? 'OSError'
              : 'UnicodeDecodeError';
    return [null, `không đọc được ${name} (${t})`];
  }
  if (!pyStrip(text)) return [null, `${name} rỗng`];
  try {
    return [pyLoads(text), null];
  } catch {
    return [null, `${name} JSON hỏng`];
  }
}

export type PersonaSimOpts = { dryRun?: boolean; config?: string; personas?: string };
export type PersonaSimDeps = {
  io?: Io;
  env?: Env;
  /** Python `_connect()`: ném khi thiếu DATABASE_URL / không tới được. */
  connect?: () => Promise<DbLease>;
  /** Nối core trên kết nối → AiGateway (mặc định `wireCore`). */
  wire?: (db: Db | null) => unknown;
  /** Lời gọi THẬT thay gateway (test). */
  chat?: ChatFn;
  clock?: () => Date;
  /** File CHUẨN của cổng DPIA (mặc định data/sim_config.json). */
  canonicalConfig?: string;
  goldenFile?: string;
};

async function defaultConnect(env: Env): Promise<DbLease> {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    const e = new Error('thiếu DATABASE_URL');
    e.name = 'RuntimeError';
    throw e;
  }
  const pool = createPool(databaseUrl(env), {}, env);
  try {
    await pool.query('select 1');
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return { db: pool, release: () => pool.end() };
}

/** `python scripts/persona_sim.py` → exit code. Exit: 0 OK; 1 lỗi dữ liệu/gateway/DB; 2 DPIA chưa
 * ký, chưa đủ nhà cung cấp, tính năng tắt. */
export async function personaSimMain(o: PersonaSimOpts, d: PersonaSimDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const err = (m: string) => {
    io.err(`[err] ${m}`);
    return 1;
  };
  const cfgPath = o.config ?? CONFIG_FILE;
  const persPath = o.personas ?? PERSONAS_FILE;
  const [cfg0, why1] = readJsonDoc(cfgPath);
  if (why1 !== null) return err(why1);
  const [pdoc0, why2] = readJsonDoc(persPath);
  if (why2 !== null) return err(why2);
  const [golden, why3] = readGolden(d.goldenFile ?? GOLDEN_FILE);
  if (golden === null) return err(`golden: ${why3}`);
  const errs = validateInputs(cfg0, pdoc0, golden);
  if (errs.length) {
    for (const e of errs) io.err(`[err] ${e}`);
    return 1;
  }
  const cfg = cfg0 as Obj;
  const pdoc = pdoc0 as Obj;
  const [canon] = readJsonDoc(d.canonicalConfig ?? CONFIG_FILE);
  const signed = cfg.dpia_signed === true && isPlainObject(canon) && canon.dpia_signed === true;
  if (!o.dryRun && !signed) {
    io.err(
      '[refuse] DPIA chưa ký (sim_config.json dpia_signed khác true) — persona_sim chỉ chạy --dry-run (số giả). Chỉ NGƯỜI thật đổi dpia_signed sau khi Pháp chế + TGĐ ký DPIA/TIA.',
    );
    return 2;
  }
  const vendors = [
    ...new Set((cfg.models as Obj[]).map((m) => (m.id as string).split('/')[0] as string)),
  ].sort(cpCmp);
  if (!o.dryRun && vendors.length < MIN_PROVIDERS) {
    // r13: lượt THẬT cần ≥3 NHÀ CUNG CẤP khác nhau — chặn TRƯỚC mọi lời gọi.
    io.err(
      `[refuse] lượt thật cần >= ${MIN_PROVIDERS} nhà cung cấp khác nhau trong sim_config.models (hiện: ${vendors.join(', ')}) — 0 lời gọi LLM`,
    );
    return 2;
  }
  // intel-05.1 TẮT → không gọi gateway, không ghi. DB down → mode fail-closed = chạy thử: vẫn chạy.
  let lease: DbLease | null = null;
  let connErr: unknown = null;
  const q = quickMode();
  let off: string | null = q !== null && q === 'tat' ? 'tính năng tắt' : null;
  try {
    lease = await (d.connect ?? (() => defaultConnect(env)))();
  } catch (e) {
    connErr = e;
  }
  try {
    if (q === null && lease !== null) {
      try {
        await checkGenerate(lease.db, FEATURE, 'lượt giả lập persona');
      } catch (e) {
        if (!(e instanceof RolloutBlocked)) throw e;
        off = e.message;
      }
    }
    if (off) {
      io.err(`[blocked] ${off}`);
      return 2;
    }
    const runDate = vnDate((d.clock ?? (() => new Date()))());
    const runId = `${o.dryRun ? 'dry' : 'run'}-${runDate.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const psetHash = sha12(readFileSync(persPath));
    let chat: ChatFn;
    if (o.dryRun) chat = fakeChat(cfg.options as Obj[]);
    else if (d.chat) chat = d.chat;
    else {
      const gw = (d.wire ?? ((x: Db | null) => wireCore(x)))(lease?.db ?? null);
      chat = gatewayChat(gw as AiGateway);
    }
    let rows: SimRow[];
    let nCalls: number;
    try {
      [rows, nCalls] = await runMatrix(cfg, pdoc, cfg.options as Obj[], chat, runDate, {
        runId,
        personaSetHash: psetHash,
        dryRun: Boolean(o.dryRun),
      });
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      return err(
        `dừng (${e.name}: ${cpSlice(maskPii(String(e.message)), 0, 200)}) — 0 dòng ghi sim_runs`,
      );
    }
    const summary = summarize(rows);
    const text = report(summary, {
      runId,
      personaSet: pdoc.set_id as string,
      personaSetHash: psetHash,
      dryRun: Boolean(o.dryRun),
    });
    if (!guardrailCheck(text).ok) return err('báo cáo không qua guardrail — không ghi, không in');
    try {
      if (lease === null) throw connErr ?? new Error('không kết nối được');
      await writeRows(lease.db, rows);
    } catch (e) {
      // Python bắt (psycopg.Error, RuntimeError, ValueError) — RolloutBlocked là ValueError
      const name =
        e instanceof RolloutBlocked
          ? 'RolloutBlocked'
          : isDbError(e)
            ? (e as { code?: string }).code === '23505'
              ? 'UniqueViolation'
              : (e as { code?: string }).code === '23514'
                ? 'CheckViolation'
                : pgErrName(e)
            : ((e as Error)?.name ?? 'Error');
      return err(`ghi sim_runs lỗi (${name}) — không in báo cáo (kết quả phải truy vết được)`);
    }
    io.out(text);
    io.out(`[ok] ${rows.length} dòng sim_runs (${nCalls} lời gọi) run_id=${runId}`);
    return 0;
  } finally {
    await lease?.release().catch(() => {});
  }
}
