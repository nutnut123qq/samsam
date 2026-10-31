import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, win32 } from 'node:path';
import { verify as aqVerify } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { queueSample, REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { readinessFromDb } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import {
  check,
  checkPublish,
  readiness as goldenReadiness,
  type ReadinessMap,
  readinessKey,
} from '@samsam/core/security/guardrail';
import { cpLen, pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  CONTENT_OK,
  type Draft,
  KIT_TYPES,
  loadDrafts,
  MAX_DRAFTS,
} from '../kd_orders_care/shared.js';
import { type Dict, missingClauses, readContractFile, sha256 } from './shared.js';

// v6.4 MKT-06 (marketing-04.1) — kit KOC/affiliate từ nội dung ĐÃ DUYỆT (`agents/mkt_koc.py`).
// Tất định (template), KHÔNG LLM, KHÔNG mạng. Agent KHÔNG gửi kit, KHÔNG liên hệ KOC, KHÔNG tạo link
// affiliate thật. Output: 1 mục NHÁP `marketing/koc_brief` (`koc-<code>-<sha12>`); khi đã duyệt,
// `--release` ghi `data/reports/koc-kit-<code>-<qid>.md` để người phụ trách gửi TAY.
// KOC = danh sách MẪU `data/koc_sample.json` (không PII); mỗi KOC trỏ 1 file hợp đồng NHÁP mẫu —
// `missing_clauses(text, "koc")` phải rỗng (kiểm từ khóa ≠ đã ký/đã rà luật sư).

export const KOC_FILE = dataPath('koc_sample.json');
export const CODES = [
  'KIT_OFFLINE_ONLY',
  'KIT_LISTING_ONLY',
  'KIT_CAM',
  'KIT_CREATIVE_UNAPPROVED',
  'KIT_CONTRACT',
  'KIT_GUARDRAIL',
];
export const RELEASE_CODES = ['KIT_NOT_APPROVED', 'KIT_CONTRACT_CHANGED'];
export const KOC_KEYS = ['code', 'platform', 'niche', 'contract_file', 'contract_status'];
export const PLATFORMS = ['tiktok', 'facebook'];
export { KIT_TYPES, MAX_DRAFTS };
export const FEATURE = 'marketing-04.1';
const CODE_RE = /^KOC-MAU-\d{2}$/;
const OID_RE = /^koc-(KOC-MAU-\d{2})-[0-9a-f]{12}$/;
const FILE_LINE = /^- File hợp đồng: `([^`\n]+)`$/m;
const SHA_LINE = /^- contract_sha256: `([0-9a-f]{64})`$/m;
const AD_LABEL = '#quangcao';
const DONT_SAY = [
  '- Mọi công dụng ngoài đúng các câu đã duyệt ở trên — không tự thêm, không nói quá, không kể trải nghiệm sức khỏe cá nhân.',
  '- Không so sánh sản phẩm với dược phẩm, không nói sản phẩm thay thế việc khám bác sĩ.',
  '- Không dùng các từ/cụm trong danh sách từ cấm của Sâm Sâm (Pháp chế giữ danh sách, KOC nhận bản riêng kèm hợp đồng).',
  '- Không nhắc tới đồ uống thuộc nhóm cấm quảng cáo của công ty; không nêu địa danh vùng trồng/chỉ dẫn địa lý khi Pháp chế chưa xác nhận.',
  '- Không đưa số điện thoại, link mua hàng thật hay mã khuyến mãi tự đặt.',
];
const tuple = (xs: string[]) => `(${xs.map(pyRepr).join(', ')})`;

export type Koc = {
  code: string;
  platform: string;
  niche: string;
  contract_file: string;
  contract_status: string;
};

/** koc_sample.json thiếu/hỏng/sai mẫu (Python ValueError). */
export class KocConfigError extends RangeError {}

/** Fail-closed: file thiếu/hỏng, `{}`/chỉ `_doc`, key lạ, code sai mẫu, trùng code → KocConfigError. */
export function loadKocs(path: string = KOC_FILE): Koc[] {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    if (e.pyType === 'FileNotFoundError') throw new KocConfigError(`không có file ${name}`);
    throw new KocConfigError(`${name} hỏng (${e.pyType})`);
  }
  const keys = isPlainObject(raw) ? Object.keys(raw) : null;
  if (!keys || keys.length !== 2 || !keys.includes('_doc') || !keys.includes('kocs')) {
    throw new KocConfigError(`${name}: gốc phải có đúng '_doc' + 'kocs'`);
  }
  const kocs = (raw as Dict).kocs;
  if (!Array.isArray(kocs) || !kocs.length) throw new KocConfigError(`${name}: 'kocs' rỗng`);
  const seen = new Set<string>();
  kocs.forEach((k, i) => {
    const ks = isPlainObject(k) ? Object.keys(k) : null;
    if (!ks || ks.length !== KOC_KEYS.length || !KOC_KEYS.every((x) => ks.includes(x))) {
      throw new KocConfigError(`kocs[${i}]: cần đúng key ${tuple(KOC_KEYS)}`);
    }
    const o = k as Dict;
    if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) {
      throw new KocConfigError(`kocs[${i}].code phải KOC-MAU-<2 số>`);
    }
    if (seen.has(o.code)) throw new KocConfigError(`kocs[${i}].code trùng`);
    seen.add(o.code);
    if (!PLATFORMS.includes(o.platform as string)) {
      throw new KocConfigError(`kocs[${i}].platform phải ${tuple(PLATFORMS)}`);
    }
    const n = typeof o.niche === 'string' ? cpLen(pyStrip(o.niche)) : 0;
    if (n < 1 || n > 60) throw new KocConfigError(`kocs[${i}].niche phải 1..60 ký tự`);
    // r20: luật Windows cho MỌI OS — ổ đĩa/UNC/gốc `/`·`\` hay `..` (cả hai dấu tách) đều từ chối.
    const cf = o.contract_file;
    if (
      typeof cf !== 'string' ||
      !pyStrip(cf) ||
      /^[a-z]:/i.test(cf) ||
      win32.isAbsolute(cf) ||
      cf.split(/[\\/]/).includes('..')
    ) {
      throw new KocConfigError(`kocs[${i}].contract_file phải đường dẫn tương đối trong repo`);
    }
    if (o.contract_status !== 'NHAP_MAU') {
      throw new KocConfigError(
        `kocs[${i}].contract_status phải NHAP_MAU (hợp đồng ký thật = external-dep)`,
      );
    }
  });
  return kocs as Koc[];
}

export type Contract = [string | null, string | null, string | null];

/** → [text, sha256 text utf-8, lỗi]. File ngoài repo/thiếu/hỏng → lỗi. */
export function loadContract(rel: string, root: string = REPO_ROOT): Contract {
  let p: string;
  try {
    const base = realpathSync(root);
    p = resolve(base, rel);
    try {
      p = realpathSync(p); // symlink trỏ ra ngoài repo cũng bị bắt
    } catch {
      // chưa tồn tại → để readContractFile báo "file không tồn tại"
    }
    const r = relative(base, p);
    if (r.startsWith('..') || isAbsolute(r)) throw new RangeError('ngoài repo');
  } catch {
    return [null, null, 'file hợp đồng nằm ngoài repo'];
  }
  try {
    const text = readContractFile(p);
    return [text, sha256(text), null];
  } catch (e) {
    const why = e instanceof RangeError ? e.message : (e as Error).name;
    return [null, null, `file hợp đồng không dùng được (${why})`];
  }
}

function codes(g: { violations?: unknown }): string {
  const vs = Array.isArray(g.violations) ? (g.violations as unknown[]) : [];
  const cs = [
    ...new Set(vs.filter(isPlainObject).map((v) => (v.code === undefined ? null : v.code))),
  ];
  cs.sort();
  return `[${cs.map((c) => (typeof c === 'string' ? pyRepr(c) : pyStr(c))).join(', ')}]`;
}

function draftWhy(d: unknown, sku: string): string | null {
  if (!isPlainObject(d) || d.id === null || d.id === undefined) return 'draft không tồn tại';
  const i = pyStr(d.id);
  if (d.status !== 'approved') return `draft #${i} chưa duyệt (trạng thái ${pyStr(d.status)})`;
  if (d.sku !== sku) return `draft #${i} gắn SKU khác SKU kit`;
  if (!KIT_TYPES.includes(d.content_type as string)) {
    return `draft #${i} loại ${pyStr(d.content_type)} — cần ${tuple(KIT_TYPES)}`;
  }
  if (d.verified !== true) return `draft #${i} không khớp bản đã duyệt (verify_publish)`;
  return null;
}

/** (câu khuyến cáo, nhãn AI đầu) = `guardrail._load_rules` canonical/labels_ai[0] (KHÔNG strip). */
function ruleTexts(): [string, string] | null {
  try {
    const doc = readJson(dataPath('guardrail_rules.json')) as Dict;
    const canon = pyStr((doc.disclaimer as Dict).canonical);
    const ai = (doc.labels as Dict).ai as unknown[];
    return [canon, pyStr(ai[0])];
  } catch {
    return null;
  }
}

/** → [kit markdown, is_ai]. Tất định theo input. */
export function renderKit(
  koc: Koc,
  sku: string,
  channel: string,
  drafts: Draft[],
  category: unknown,
  contractSha: string,
): [string, boolean] {
  const isAi = drafts.some((d) => d.is_ai !== false);
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const g = isPlainObject(d.guardrail) ? d.guardrail : {};
    const mc = Array.isArray(g.matched_claims) ? g.matched_claims : [];
    for (const m of mc) {
      const c = isPlainObject(m) ? m.claim : null;
      if (typeof c === 'string' && pyStrip(c) && !seen.has(c)) {
        seen.add(c);
        claims.push(c);
      }
    }
  }
  const rt = ruleTexts();
  const code = koc.code;
  const L = [
    `# Kit KOC ${code} — \`${sku}\` × ${channel} (NHÁP — chỉ phát hành bản đã duyệt)`,
    '',
    `KOC MẪU ${code} (${koc.platform}, ${pyStrip(koc.niche)}). Hệ thống KHÔNG gửi kit, KHÔNG liên hệ KOC — người phụ trách gửi tay sau khi GĐ Marketing duyệt.`,
    '',
    '## Brief (nguyên văn nội dung đã duyệt)',
    '',
  ];
  for (const d of drafts) {
    L.push(`### Bài #${pyStr(d.id)}`, '', pyStrip(typeof d.text === 'string' ? d.text : ''), '');
  }
  L.push('## Điểm được nói', '');
  L.push(
    ...(claims.length
      ? claims.map((c) => `- ${c}`)
      : [
          '- Chỉ nội dung trong brief ở trên — sản phẩm không có câu công dụng nào được duyệt để nhắc thêm.',
        ]),
  );
  L.push('', '## Điểm KHÔNG được nói', '', ...DONT_SAY, '');
  if (category === 'tpbvsk') {
    L.push('## Câu khuyến cáo bắt buộc (đọc/ghi nguyên văn)', '', rt ? rt[0] : 'None', '');
  }
  L.push('## Nhãn bắt buộc khi đăng', '', `- ${AD_LABEL}`);
  if (isAi) L.push(`- ${rt ? rt[1] : ''}`);
  L.push(
    '',
    '## Link/mã affiliate (placeholder — chưa phải link thật)',
    '',
    '- Link: {{LINK_AFFILIATE}}',
    `- Mã: AFF-${code}-${sku}-PLACEHOLDER`,
    '',
    '## Hợp đồng tham chiếu (NHÁP mẫu — chưa ký)',
    '',
    `- File hợp đồng: \`${koc.contract_file}\``,
    `- contract_sha256: \`${contractSha}\``,
    '- contract_check: đủ điều khoản theo kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư.',
    '',
  );
  return [L.join('\n'), isAi];
}

export type KitResult = {
  code: string | null;
  reason: string;
  kit?: string;
  sha12?: string;
  contract_sha?: string;
};

/** THUẦN → {code | null, reason, kit, sha12, contract_sha}. golden = {sku: {category}}, readiness =
 * map view (null → soi golden file). Chặn theo cùng ánh xạ MKT-05: rượu (xét TRƯỚC readiness) →
 * listing_only → ngoài CONTENT_OK → draft chưa duyệt/lệch → hợp đồng → guardrail đăng bài + hàng duyệt. */
export function buildKit(
  koc: Koc,
  sku: string,
  channel: string,
  drafts: Draft[],
  golden: Map<string, { category: unknown }>,
  o: {
    readiness?: ReadinessMap | null;
    contractText: string | null;
    contractSha?: string | null;
    contractErr?: string | null;
  },
): KitResult {
  const g = golden.get(sku);
  const cat = isPlainObject(g) ? (g.category ?? null) : null;
  if (cat === 'alcohol') {
    return {
      code: 'KIT_OFFLINE_ONLY',
      reason: 'SKU nhóm offline_only (đồ uống có cồn) — không có kit KOC',
    };
  }
  const rd = o.readiness ?? null;
  const lvl = rd !== null ? rd.get(readinessKey(sku, channel)) : goldenReadiness(sku, channel);
  if (lvl === 'MO_TA') {
    return {
      code: 'KIT_LISTING_ONLY',
      reason: `${sku} × ${channel}: listing_only (TPBVSK chưa XNQC)`,
    };
  }
  if (lvl === undefined || !CONTENT_OK.includes(lvl) || cat === null) {
    return { code: 'KIT_CAM', reason: `${sku} × ${channel}: readiness ${lvl || 'không có'}` };
  }
  if (!drafts.length || drafts.length > MAX_DRAFTS) {
    return { code: 'KIT_CREATIVE_UNAPPROVED', reason: `cần 1..${MAX_DRAFTS} draft đã duyệt` };
  }
  for (const d of drafts) {
    const why = draftWhy(d, sku);
    if (why) return { code: 'KIT_CREATIVE_UNAPPROVED', reason: why };
  }
  if (o.contractText === null) {
    return { code: 'KIT_CONTRACT', reason: o.contractErr || 'không đọc được hợp đồng' };
  }
  const miss = missingClauses(o.contractText, 'koc');
  if (miss.length) {
    return { code: 'KIT_CONTRACT', reason: `hợp đồng thiếu điều khoản: ${miss.join(', ')}` };
  }
  const csha = o.contractSha || sha256(o.contractText);
  const [kit, isAi] = renderKit(koc, sku, channel, drafts, cat, csha);
  const pub = checkPublish(kit, {
    channel,
    contentType: 'koc',
    sku,
    isAi,
    isSponsored: true,
    readiness: rd,
  });
  if (pub.ok !== true) {
    return { code: 'KIT_GUARDRAIL', reason: `kit không qua guardrail đăng bài ${codes(pub)}` };
  }
  const base = check(kit);
  if (base.ok !== true) {
    return { code: 'KIT_GUARDRAIL', reason: `kit không qua guardrail hàng duyệt ${codes(base)}` };
  }
  return {
    code: null,
    reason: 'đạt',
    kit,
    sha12: sha256(kit).slice(0, 12),
    contract_sha: csha,
  };
}

// ---------------------------------------------------------------- DB

export type SubmitResult = KitResult & {
  qid: bigint | null;
  skipped: boolean;
  object_id?: string;
};

export async function submitKit(
  db: Db,
  koc: Koc,
  sku: string,
  channel: string,
  ids: bigint[],
  o: { by: string; dcfg?: DirectorConfig; dryRun?: boolean; root?: string },
): Promise<SubmitResult> {
  const { rows } = await db.query('select sku_key, category from sku_master');
  const golden = new Map(rows.map((r) => [String(r.sku_key), { category: r.category }]));
  const rmap = await readinessFromDb(db);
  const drafts = await loadDrafts(db, ids);
  const [text, csha, err] = loadContract(koc.contract_file, o.root);
  const res = buildKit(koc, sku, channel, drafts, golden, {
    readiness: rmap ?? new Map(),
    contractText: text,
    contractSha: csha,
    contractErr: err,
  });
  if (res.code || o.dryRun) return { ...res, qid: null, skipped: false };
  const oid = `koc-${koc.code}-${res.sha12}`;
  const ex = await db.query(
    "select exists(select 1 from approval_queue where object_type = 'koc_brief' and object_id = $1) as e",
    [oid],
  );
  if (ex.rows[0]?.e) return { ...res, qid: null, skipped: true, object_id: oid };
  try {
    const qid = await submit(db, {
      block: 'marketing',
      objectType: 'koc_brief',
      objectId: oid,
      title: `Kit KOC ${koc.code} — ${sku} × ${channel}`,
      payload: res.kit as string,
      createdBy: o.by,
      ...(o.dcfg ? { cfg: o.dcfg } : {}),
    });
    return { ...res, qid, skipped: false, object_id: oid };
  } catch (e) {
    // chạy đồng thời: unique (object_type, object_id) → skip như Python UniqueViolation
    if (isDbError(e) && (e as { code?: string }).code === '23505') {
      return { ...res, qid: null, skipped: true, object_id: oid };
    }
    throw e;
  }
}

export type ReleaseResult = { code: string | null; reason: string; path?: string };

/** → {code | null, reason, path}. Không gửi — chỉ ghi file. Mục `koc_brief` approved + `verify` khớp
 * payload + sha hợp đồng hiện tại == sha trong kit + đủ điều khoản. */
export async function release(
  db: Db,
  qid: bigint,
  o: { outDir?: string; root?: string } = {},
): Promise<ReleaseResult> {
  const { rows } = await db.query(
    'select block, object_type, object_id, payload, status from approval_queue where id = $1',
    [String(qid)],
  );
  const row = rows[0];
  if (!row || row.block !== 'marketing' || row.object_type !== 'koc_brief') {
    return { code: 'KIT_NOT_APPROVED', reason: `mục #${qid} không phải kit KOC` };
  }
  const oid = String(row.object_id ?? '');
  const payload = String(row.payload);
  const ok = row.status === 'approved' && (await aqVerify(db, qid, payload));
  const m = OID_RE.exec(oid);
  if (!ok || m === null) {
    return {
      code: 'KIT_NOT_APPROVED',
      reason: `mục #${qid} trạng thái ${pyStr(row.status)} / không khớp bản đã duyệt`,
    };
  }
  const fm = FILE_LINE.exec(payload);
  const sm = SHA_LINE.exec(payload);
  if (fm === null || sm === null) {
    return { code: 'KIT_CONTRACT_CHANGED', reason: 'kit không ghi hợp đồng tham chiếu' };
  }
  const [text, csha, err] = loadContract(fm[1] as string, o.root);
  if (text === null) return { code: 'KIT_CONTRACT_CHANGED', reason: err as string };
  if (csha !== sm[1]) {
    return {
      code: 'KIT_CONTRACT_CHANGED',
      reason: 'hợp đồng đã sửa sau khi kit được lập — lập kit lại',
    };
  }
  const miss = missingClauses(text, 'koc');
  if (miss.length) {
    return {
      code: 'KIT_CONTRACT_CHANGED',
      reason: `hợp đồng thiếu điều khoản: ${miss.join(', ')}`,
    };
  }
  // P8.4: sổ KOC hiện là MẪU (`KOC-MAU-xx`) → luôn mẫu; ngoài ra theo cờ mục hàng duyệt.
  const sample = /KOC-MAU-\d{2}/.test(oid) || (await queueSample(db, qid));
  const path = await writeReport(
    payload,
    o.outDir ?? REPORTS_DIR,
    `koc-kit-${m[1]}-${qid}.md`,
    sample,
  );
  return { code: null, reason: 'đạt', path };
}

/** `_ids`: "1,2" → [1n, 2n] (1..MAX_DRAFTS, ASCII, không trùng, > 0) | null. */
export function parseIds(s: string | undefined): bigint[] | null {
  const parts = (s ?? '').split(',').map(pyStrip);
  if (!parts.length || !parts.every((p) => /^[0-9]+$/.test(p))) return null;
  const ids = parts.map((p) => BigInt(p));
  const ok = ids.length >= 1 && ids.length <= MAX_DRAFTS && new Set(ids).size === ids.length;
  return ok && ids.every((i) => i > 0n) ? ids : null;
}
