import { basename } from 'node:path';
import { dataPath } from '../paths.js';
import { type Db, dep } from './deps.js';
import { cpLen, isPlainObject, type JsonFileError, readJson, squash } from './py.js';

// Port `pipelines/loader_gate.py` (v15 P12.1) — chính sách cổng tắt cho LOADER nạp file (HĐ 6.7,
// PL02 mục 1). `data/loader_gate.json` đọc mỗi lần chạy; mỗi loader khai `features` + `chinh_sach`:
//   null             CHƯA CẤU HÌNH — tính năng nào đang TẮT → CHẶN (fail-closed); không tắt → nạp.
//   "chan_khi_tat"   có tính năng tắt → chặn.
//   "nap_ca_khi_tat" vẫn nạp khi tính năng tắt (dữ liệu nguồn dùng chung).
// Đặt khác null phải kèm `chot_boi` (NGƯỜI) + `can_cu`. File thiếu/hỏng/thiếu loader/lạ/mã lạ → MỌI
// loader bị chặn. Giai đoạn đọc qua `rollout.mode` (nguồn duy nhất); không có DB → CHẶN.

export const CONFIG = dataPath('loader_gate.json');
export const LOADERS = [
  'market_csv',
  'golden_store',
  'embed_store',
  'kb_internal',
  'doc_intake',
  'agent_eval',
  'lead_store',
  'dealer_price',
] as const;
export type LoaderName = (typeof LOADERS)[number];
export const POLICIES: Record<string, string> = {
  chan_khi_tat: 'tính năng tắt → không nạp',
  nap_ca_khi_tat: 'vẫn nạp khi tính năng tắt (dữ liệu nguồn dùng chung)',
};
export const UNSET = 'chính sách CHƯA CẤU HÌNH (chờ chủ khối/hai bên chọn — data/loader_gate.json)';
const MAX_TEXT = 200;

export class LoaderGateError extends Error {}

export type LoaderEntry = {
  features: string[];
  policy: string | null;
  chot_boi: string | null;
  can_cu: string | null;
};

function text(v: unknown): string {
  return typeof v === 'string' ? squash(v) : '';
}

function pySorted(xs: Iterable<string>): string {
  return `[${[...xs]
    .sort()
    .map((x) => `'${x}'`)
    .join(', ')}]`;
}

/** → {loader: entry}. Mọi lỗi → LoaderGateError. `catalogIds` thiếu → danh mục của rollout. */
export function loadConfig(
  path: string = CONFIG,
  catalogIds?: ReadonlySet<string>,
): Record<LoaderName, LoaderEntry> {
  const name = basename(path);
  let doc: unknown;
  try {
    doc = readJson(path);
  } catch (e) {
    const t = (e as JsonFileError).pyType;
    throw new LoaderGateError(
      t === 'FileNotFoundError' ? `không có file ${name}` : `${name} hỏng: ${t}`,
    );
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.loaders)) {
    throw new LoaderGateError(`${name}: thiếu object 'loaders'`);
  }
  const raw = doc.loaders;
  const keys = new Set(Object.keys(raw));
  const miss = LOADERS.filter((l) => !keys.has(l));
  const extra = [...keys].filter((k) => !(LOADERS as readonly string[]).includes(k));
  if (miss.length || extra.length) {
    throw new LoaderGateError(`${name}: loader thiếu ${pySorted(miss)} / lạ ${pySorted(extra)}`);
  }
  let ids = catalogIds;
  if (ids === undefined) {
    const cat = dep('rollout').catalog();
    if (cat === null) throw new LoaderGateError('danh mục contract_features.json hỏng');
    ids = new Set(cat.map((f) => f.id));
  }
  const isHuman = dep('auth').isHuman;
  const out = {} as Record<LoaderName, LoaderEntry>;
  for (const ln of LOADERS) {
    const e = raw[ln];
    if (!isPlainObject(e)) throw new LoaderGateError(`${ln}: không phải object`);
    const feats = e.features;
    if (
      !Array.isArray(feats) ||
      feats.length === 0 ||
      !feats.every((f) => typeof f === 'string' && ids.has(f))
    ) {
      throw new LoaderGateError(`${ln}: 'features' phải là list mã có trong danh mục, không rỗng`);
    }
    const pol = e.chinh_sach ?? null;
    if (pol !== null && !(typeof pol === 'string' && pol in POLICIES)) {
      const shown = cpSliceText(typeof pol === 'string' ? pol : JSON.stringify(pol));
      throw new LoaderGateError(
        `${ln}: chinh_sach '${shown}' không hợp lệ (null | ${Object.keys(POLICIES).join(' | ')})`,
      );
    }
    const by = text(e.chot_boi);
    const ref = text(e.can_cu);
    if (
      pol !== null &&
      !(isHuman(by) && cpLen(by) <= 100 && ref !== '' && cpLen(ref) <= MAX_TEXT)
    ) {
      throw new LoaderGateError(
        `${ln}: chinh_sach đã đặt nhưng thiếu chot_boi (người thật) / can_cu`,
      );
    }
    out[ln] = {
      features: [...new Set(feats as string[])],
      policy: pol as string | null,
      chot_boi: by || null,
      can_cu: ref || null,
    };
  }
  return out;
}

function cpSliceText(s: string): string {
  return Array.from(squash(s)).slice(0, 40).join('');
}

/** THUẦN: [được nạp?, diễn giải]. `stages` = {mã: giai đoạn}. */
export function decide(policy: string | null, stages: Record<string, string>): [boolean, string] {
  const off = Object.keys(stages)
    .filter((f) => stages[f] === 'tat')
    .sort();
  const st = Object.keys(stages)
    .sort()
    .map((f) => `${f} ${stages[f]}`)
    .join(', ');
  const head = policy === null ? UNSET : `chính sách ${policy} (${POLICIES[policy]})`;
  if (!off.length) return [true, `${head} — tính năng: ${st} → nạp`];
  if (policy === 'nap_ca_khi_tat') {
    return [true, `${head} — tính năng TẮT: ${off.join(', ')} → vẫn nạp theo chính sách`];
  }
  return [false, `${head} — tính năng TẮT: ${off.join(', ')} → KHÔNG nạp (HĐ 6.7)`];
}

/** {mã: giai đoạn} qua `rollout.mode`; cần DB mà không có → null. */
export async function stagesFor(
  db: Db | null,
  feats: string[],
): Promise<Record<string, string> | null> {
  const ro = dep('rollout');
  if (ro.quickMode() === null && db === null) return null;
  const out: Record<string, string> = {};
  for (const f of feats) out[f] = await ro.mode(db, f);
  return out;
}

/**
 * Biên NẠP của loader → lý do chặn | null (được nạp). In 1 dòng `[loader-gate]`. Chỉ đọc. `db` = Pool
 * của loader (svc_loader có SELECT `feature_rollout`); null (không kết nối được) → chặn.
 */
export async function check(
  name: string,
  db: Db | null,
  path: string = CONFIG,
  log: (s: string) => void = console.log,
): Promise<string | null> {
  if (!(LOADERS as readonly string[]).includes(name)) throw new RangeError(`loader lạ: ${name}`);
  let ent: LoaderEntry;
  try {
    ent = loadConfig(path)[name as LoaderName];
  } catch (e) {
    if (!(e instanceof LoaderGateError)) throw e;
    return `cấu hình cổng loader hỏng: ${e.message} — không nạp (fail-closed)`;
  }
  const stages = await stagesFor(db, ent.features);
  if (stages === null) {
    return `loader ${name}: không kết nối được DB để đọc giai đoạn tính năng ${ent.features.join(', ')} — không nạp`;
  }
  const [ok, why] = decide(ent.policy, stages);
  log(`[loader-gate] ${name}: ${why}`);
  return ok ? null : `loader ${name}: ${why}`;
}

/** CLI `--status` → [dòng in, exit code] (1 khi cấu hình hỏng). */
export async function status(db: Db | null, path: string = CONFIG): Promise<[string[], number]> {
  let cfg: Record<LoaderName, LoaderEntry>;
  try {
    cfg = loadConfig(path);
  } catch (e) {
    if (!(e instanceof LoaderGateError)) throw e;
    return [[`[err] cấu hình cổng loader hỏng: ${e.message} — mọi loader bị chặn`], 1];
  }
  const out: string[] = [];
  for (const name of LOADERS) {
    const ent = cfg[name];
    const stages = await stagesFor(db, ent.features);
    if (stages === null) {
      out.push(`[${name}] ${ent.policy ?? UNSET} — DB không kết nối được: loader sẽ bị chặn`);
      continue;
    }
    const [ok, why] = decide(ent.policy, stages);
    const who = ent.policy ? ` (chốt bởi ${ent.chot_boi}, căn cứ ${ent.can_cu})` : '';
    out.push(`[${name}] ${ok ? 'nạp' : 'CHẶN'} — ${why}${who}`);
  }
  const n = LOADERS.filter((x) => cfg[x].policy === null).length;
  out.push(`[done] ${LOADERS.length} loader, ${n} chưa cấu hình chính sách`);
  return [out, 0];
}
