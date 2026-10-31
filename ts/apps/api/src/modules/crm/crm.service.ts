import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { loadConfig } from '@samsam/core/ops/director';
import { businessDeadline } from '@samsam/core/ops/period';
import { cpLen, isPlainObject, isPrintable, JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { callHuman } from '@samsam/core/security/auth';
import {
  KEY_ENV,
  loadVaultKey,
  normalizePhone,
  phoneLookup,
  seal,
  unseal,
  VaultKeyError,
  type VaultKeys,
} from '@samsam/core/security/fernet';
import { PII_RE, scrubUser } from '@samsam/core/security/pii';
import { pyRepr, pyReprValue, pyStrip, pyTruthy, search } from '@samsam/core/security/py';
import { provinceOf } from '../channels/b2b-form.service.js';
import { STAFF_RE, section } from '../sales_director/sales-watch.js';

// Port `ingest/crm.py` (KD-A2, WP07 v5.2) — CRM lead & đại lý theo vùng: kho liên hệ (contact
// vault) + đồng ý theo mục đích + gán đại lý theo tỉnh.
//  - PII khách CHỈ nằm trong `contacts`, mã hóa Fernet ở TẦNG ỨNG DỤNG (khóa env CONTACT_VAULT_KEY —
//    core/security/fernet, khớp byte với Python); tra trùng `phone_hmac` = HMAC(khóa lookup HKDF).
//    Thiếu/sai khóa → VaultKeyError TRƯỚC khi chạm DB. Bảng khác chỉ giữ `contact_id`.
//  - Đồng ý (`consents`) append-only theo mục đích cskh|marketing|dai_ly|b2b; `canContact` mặc định
//    false — chỉ true khi dòng MỚI NHẤT (theo id) của (contact, mục đích, đại lý) là granted;
//    `dai_ly` phải ĐÍCH DANH đại lý.
//  - Agent KHÔNG tự liên hệ khách/đại lý: module không gọi mạng/LLM. `handoff` chỉ TRẢ payload cho
//    NGƯỜI tự chuyển. Mọi ghi đi qua function SECURITY DEFINER `crm_*_human` (danh tính theo login
//    Postgres — `human_actor`; log `agent_action_log` cùng giao dịch trong function, detail không
//    PII/HMAC/ciphertext). Thông báo lỗi không echo PII.
//  - Tỉnh/thành: 34 đơn vị sau sáp nhập 2025 (GIẢ ĐỊNH — data/vn_provinces_2025.json); vùng + đại lý
//    MẪU ở data/dealer_regions.json.

export {
  KEY_ENV,
  loadVaultKey,
  phoneLookup,
  provinceOf,
  seal,
  unseal,
  VaultKeyError,
  type VaultKeys,
};
export const PROVINCES_FILE = dataPath('vn_provinces_2025.json');
export const REGIONS_FILE = dataPath('dealer_regions.json');
export const PURPOSES = ['cskh', 'marketing', 'dai_ly', 'b2b'];
export const CONSENT_SOURCES = ['form_giay', 'zalo', 'web', 'dien_thoai', 'email', 'truc_tiep'];
export const LEAD_FLOW = ['new', 'contacted', 'qualified', 'won'];
export const LEAD_STATES = [...LEAD_FLOW, 'lost'];
export const TERMINAL = ['won', 'lost'];
export const DEALER_STATUSES = ['active', 'paused', 'ended'];
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol']; // khớp sku_master.category
export const CONTACT_KEYS = ['phone', 'name', 'email', 'address', 'province', 'source'];
export const MAX_BY_LEN = 100;
export const MAX_FIELD: Record<string, number> = { name: 200, email: 254, address: 500 };
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_EVIDENCE = 200;
export const MAX_POLICY = 50;
export const DEALER_CODE_RE = /^[A-Z0-9_-]{2,20}$/;
export const REGION_CODE_RE = /^[A-Z0-9_]{2,30}$/;
export const SOURCE_RE = /^[a-z0-9_.:-]{1,50}$/;

type Id = bigint | number | string;
const purposeErr = () => new RangeError(`purpose phải là ${PURPOSES.join('|')}`);

/** SĐT → `0xxxxxxxxx`; sai → RangeError (Python ValueError) KHÔNG kèm giá trị đầu vào. */
export function normPhone(raw: unknown): string {
  try {
    return normalizePhone(raw);
  } catch {
    throw new RangeError('SĐT không hợp lệ');
  }
}

export function checkBy(by: unknown): string {
  const b = typeof by === 'string' ? pyStrip(by) : '';
  if (!b || cpLen(b) > MAX_BY_LEN || !isPrintable(b)) {
    throw new RangeError(`--by phải là tên người 1..${MAX_BY_LEN} ký tự in được`);
  }
  return b;
}

/** Ghi qua function `crm_*_human`: từ chối nghiệp vụ → HumanError, DB từ chối danh tính →
 * HumanDenied (+ `authz_denied`) — đều là RangeError (Python ValueError). */
function fn(
  db: Db,
  sql: string,
  args: unknown[],
  by: unknown,
  block: string | null,
  action: string,
  oid: unknown,
) {
  return callHuman(db, sql, args, { by, block, action, objectType: 'crm', objectId: oid });
}

const isIntId = (v: unknown) =>
  typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));

/** Thêm liên hệ vào vault → [contact_id, mới?]. Trùng SĐT (HMAC) → id cũ + false, KHÔNG ghi đè PII
 * cũ. `leadId` → gắn lead (không có / đã gắn contact khác → lỗi, rollback cả contact). */
export async function addContact(
  db: Db,
  rec: unknown,
  keys: VaultKeys,
  by: unknown,
  leadId: Id | null = null,
): Promise<[bigint, boolean]> {
  const who = checkBy(by);
  if (!isPlainObject(rec)) throw new TypeError('JSON liên hệ phải là object');
  if (Object.keys(rec).some((k) => !CONTACT_KEYS.includes(k))) {
    throw new RangeError(`JSON liên hệ có key không hỗ trợ (chỉ nhận ${CONTACT_KEYS.join('/')})`);
  }
  const phone = normPhone(rec.phone);
  for (const [k, cap] of Object.entries(MAX_FIELD)) {
    const v = rec[k];
    if (v !== null && v !== undefined && (typeof v !== 'string' || cpLen(v) > cap)) {
      throw new RangeError(`field '${k}' phải là chuỗi ≤ ${cap} ký tự`);
    }
  }
  let province: string | null = null;
  if (rec.province !== null && rec.province !== undefined && rec.province !== '') {
    province = typeof rec.province === 'string' ? provinceOf(rec.province) : null;
    if (province === null) {
      throw new RangeError('tỉnh/thành không nhận ra (34 tỉnh sau sáp nhập hoặc tên cũ)');
    }
  }
  const source = pyTruthy(rec.source) ? rec.source : 'manual';
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    throw new RangeError('source phải khớp [a-z0-9_.:-]{1,50}');
  }
  if (leadId !== null && !isIntId(leadId)) throw new RangeError('lead_id phải là số nguyên');
  const f = keys.fernet;
  const { rows } = await fn(
    db,
    'select * from crm_add_contact_human($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      phoneLookup(phone, keys.lookupKey),
      seal(f, phone),
      seal(f, rec.name),
      seal(f, rec.email),
      seal(f, rec.address),
      province,
      source,
      leadId === null ? null : String(leadId),
      who,
    ],
    who,
    null,
    'add_contact',
    'contact',
  );
  const r = rows[0] as { contact_id: string; is_new: boolean };
  return [BigInt(r.contact_id), r.is_new];
}

// ---------------------------------------------------------------- đồng ý

/** Ghi 1 dòng đồng ý/rút đồng ý (append-only) → id. Kiểm TRƯỚC khi ghi; vi phạm → lỗi, 0 dòng. */
export async function recordConsent(
  db: Db,
  contactId: Id,
  purpose: string,
  granted: boolean,
  source: string,
  by: unknown,
  evidenceRef: string | null = null,
  policyVersion: string | null = null,
  dealerCode: string | null = null,
): Promise<bigint> {
  const who = checkBy(by);
  if (!PURPOSES.includes(purpose)) throw purposeErr();
  if (!CONSENT_SOURCES.includes(source)) {
    throw new RangeError(`source phải là ${CONSENT_SOURCES.join('|')}`);
  }
  if (typeof granted !== 'boolean') throw new TypeError('granted phải là True/False');
  if (purpose === 'dai_ly' && !dealerCode) {
    throw new RangeError('đồng ý dai_ly phải ghi ĐÍCH DANH đại lý (--dealer)');
  }
  if (purpose !== 'dai_ly' && dealerCode) {
    throw new RangeError('--dealer chỉ dùng với mục đích dai_ly');
  }
  const ev = pyStrip(evidenceRef ?? '') || null;
  const pv = pyStrip(policyVersion ?? '') || null;
  if (ev !== null && (cpLen(ev) > MAX_EVIDENCE || !isPrintable(ev) || search(PII_RE, ev))) {
    throw new RangeError(
      `evidence_ref phải là MÃ biên bản/scan ≤ ${MAX_EVIDENCE} ký tự, không chứa SĐT/email`,
    );
  }
  if (pv !== null && (cpLen(pv) > MAX_POLICY || !isPrintable(pv))) {
    throw new RangeError(`policy_version ≤ ${MAX_POLICY} ký tự in được`);
  }
  if (granted && (ev === null || pv === null)) {
    throw new RangeError('ghi đồng ý cần --evidence và --policy-version');
  }
  const { rows } = await fn(
    db,
    'select crm_record_consent_human($1, $2, $3, $4, $5, $6, $7, $8) as id',
    [String(contactId), purpose, granted, dealerCode || null, source, ev, pv, who],
    who,
    'sales',
    'consent',
    contactId,
  );
  return BigInt(rows[0]?.id as string);
}

/** true CHỈ khi dòng mới nhất (theo id) của (contact, mục đích, đại lý) là granted. Chưa có dòng /
 * dai_ly không đích danh → false. DB lỗi → ném (caller quyết, không nuốt). */
export async function canContact(
  db: Db,
  contactId: Id,
  purpose: string,
  dealerCode: string | null = null,
): Promise<boolean> {
  if (!PURPOSES.includes(purpose)) throw purposeErr();
  if (purpose === 'dai_ly' && !dealerCode) return false;
  const { rows } = await db.query(
    "select granted from v_consent_current where contact_id = $1 and purpose = $2 and coalesce(recipient_dealer, '') = $3",
    [String(contactId), purpose, dealerCode || ''],
  );
  return rows[0]?.granted === true;
}

// ---------------------------------------------------------------- tỉnh / vùng / đại lý

/** 34 tỉnh/thành mới (data/vn_provinces_2025.json). */
export function provinces(): string[] {
  const p = (readJson(PROVINCES_FILE) as { provinces?: unknown }).provinces;
  if (!Array.isArray(p) || p.length !== 34 || new Set(p).size !== 34) {
    throw new RangeError(`${basename(PROVINCES_FILE)}: provinces phải đúng 34 tên duy nhất`);
  }
  return p as string[];
}

export type Dealer = Record<string, unknown>;
export type Regions = {
  regions: Record<string, string[]>;
  dealers: Dealer[];
  province_region: Record<string, string>;
};

/** Đọc + kiểm bảng vùng/đại lý. Lỗi → RangeError/TypeError nêu field. */
export function loadRegions(path: string = REGIONS_FILE): Regions {
  let doc: unknown;
  try {
    doc = readJson(path);
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    throw new RangeError(`${basename(path)}: không đọc được (${e.pyType})`);
  }
  const valid = new Set(provinces());
  const regions = isPlainObject(doc) ? doc.regions : null;
  const dealers = isPlainObject(doc) ? doc.dealers : null;
  if (!isPlainObject(regions) || !Object.keys(regions).length) {
    throw new RangeError('regions: phải là object không rỗng');
  }
  if (!Array.isArray(dealers)) throw new TypeError('dealers: phải là list');
  const owner: Record<string, string> = {};
  for (const [code, provs] of Object.entries(regions)) {
    if (!REGION_CODE_RE.test(code)) throw new RangeError(`regions.${code}: mã vùng sai mẫu`);
    if (!Array.isArray(provs)) throw new TypeError(`regions.${code}: phải là list tỉnh`);
    for (const p of provs) {
      if (typeof p !== 'string' || !valid.has(p)) {
        throw new RangeError(`regions.${code}: tỉnh ngoài 34 (${pyReprValue(p)})`);
      }
      if (Object.hasOwn(owner, p)) {
        throw new RangeError(`regions.${code}: tỉnh ${p} đã thuộc vùng ${owner[p]}`);
      }
      owner[p] = code;
    }
  }
  const missing = [...valid].filter((p) => !Object.hasOwn(owner, p)).sort(cpCmp);
  if (missing.length) {
    throw new RangeError(`regions: tỉnh không thuộc vùng nào [${missing.map(pyRepr).join(', ')}]`);
  }
  const seen = new Set<string>();
  dealers.forEach((d, i) => {
    if (!isPlainObject(d)) throw new TypeError(`dealers[${i}]: phải là object`);
    const code = d.code;
    if (typeof code !== 'string' || !DEALER_CODE_RE.test(code)) {
      throw new RangeError(`dealers[${i}].code: sai mẫu [A-Z0-9_-]{2,20}`);
    }
    if (seen.has(code)) throw new RangeError(`dealers[${i}].code: trùng ${code}`);
    seen.add(code);
    if (typeof d.name !== 'string' || !pyStrip(d.name)) {
      throw new RangeError(`dealers[${i}].name: thiếu`);
    }
    if (typeof d.region !== 'string' || !Object.hasOwn(regions, d.region)) {
      throw new RangeError(`dealers[${i}].region: vùng lạ`);
    }
    const st = Object.hasOwn(d, 'status') ? d.status : 'active';
    if (typeof st !== 'string' || !DEALER_STATUSES.includes(st)) {
      throw new RangeError(`dealers[${i}].status: phải là ${DEALER_STATUSES.join('|')}`);
    }
    const c = Object.hasOwn(d, 'commission_default') ? d.commission_default : 0;
    if (typeof c !== 'number' || !(c >= 0 && c <= 100)) {
      throw new RangeError(`dealers[${i}].commission_default: 0..100`);
    }
  });
  return {
    regions: regions as Record<string, string[]>,
    dealers: dealers as Dealer[],
    province_region: owner,
  };
}

/** Hoa hồng % (chuỗi Decimal) cho 1 dòng bán qua đại lý. Rượu kênh online luôn 0; nhóm lạ/null → 0
 * (fail-closed); đại lý không active → 0. */
export function commissionRate(dealer: Dealer, category: unknown, online: boolean): string {
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return '0';
  if (category === 'alcohol' && online) return '0';
  if ((Object.hasOwn(dealer, 'status') ? dealer.status : 'active') !== 'active') return '0';
  const v = dealer.commission_default;
  // numeric từ pg là chuỗi = Decimal của Python: Decimal('0.00') là falsy → `or 0` → '0'.
  if (!pyTruthy(v) || (typeof v === 'string' && Number(v) === 0)) return '0';
  return String(v);
}

/** Upsert `dealers` theo code từ file vùng (nguồn 'dealer_regions.json'); dòng 'manual' KHÔNG bị đè. */
export async function loadDealers(
  db: Db,
  regions: Regions,
  by: unknown,
): Promise<{ new: number; updated: number; kept: number }> {
  const who = checkBy(by);
  const rows = regions.dealers.map((d) => ({
    code: d.code,
    name: pyStrip(d.name as string),
    region: d.region,
    status: Object.hasOwn(d, 'status') ? d.status : 'active',
    commission_default: Object.hasOwn(d, 'commission_default') ? d.commission_default : 0,
  }));
  const { rows: r } = await fn(
    db,
    'select crm_load_dealers_human($1::jsonb, $2) as res',
    [JSON.stringify(rows), who],
    who,
    'sales',
    'load_dealers',
    'dealers',
  );
  const res = r[0]?.res as Record<string, number>;
  return { new: Number(res.new), updated: Number(res.updated), kept: Number(res.kept) };
}

// ---------------------------------------------------------------- leads

/** Gán lead cho đại lý phụ trách vùng → tên tỉnh. Tỉnh = `province` (nhận tên cũ) hoặc suy từ câu
 * hỏi; không xác định / đại lý không active / vùng không phủ tỉnh / lead đã gán đại lý khác → lỗi. */
export async function assignLead(
  db: Db,
  leadId: Id,
  dealerCode: string,
  by: unknown,
  province: string | null = null,
  regions: Regions | null = null,
): Promise<string> {
  const who = checkBy(by);
  const reg = regions ?? loadRegions();
  return withTx(db, async (c) => {
    const lead = (
      await c.query('select question, dealer_code from leads where id = $1', [String(leadId)])
    ).rows[0];
    if (!lead) throw new RangeError(`không có lead #${leadId}`);
    if (lead.dealer_code !== null && lead.dealer_code !== dealerCode) {
      throw new RangeError(
        `lead #${leadId} đã gán ${lead.dealer_code} — tranh chấp chuyển người duyệt (không gán đè)`,
      );
    }
    let prov: string | null;
    if (province !== null && province !== '') {
      prov = provinceOf(province);
      if (prov === null) {
        throw new RangeError('--province không nhận ra (34 tỉnh sau sáp nhập hoặc tên cũ)');
      }
    } else {
      prov = provinceOf(lead.question || '');
      if (prov === null) throw new RangeError('chưa xác định tỉnh — truyền --province');
    }
    const dealer = (
      await c.query('select region, status from dealers where code = $1', [dealerCode])
    ).rows[0];
    if (!dealer) throw new RangeError(`không có đại lý ${dealerCode}`);
    if (dealer.status !== 'active')
      throw new RangeError(`đại lý ${dealerCode} đang ${dealer.status}`);
    if (reg.province_region[prov] !== dealer.region) {
      throw new RangeError(`đại lý ${dealerCode} (vùng ${dealer.region}) không phụ trách ${prov}`);
    }
    // DB khóa dòng + kiểm lại (gán đại lý khác giữa chừng → từ chối)
    await fn(
      c,
      'select crm_assign_lead_human($1, $2, $3, $4)',
      [String(leadId), dealerCode, prov, who],
      who,
      'sales',
      'assign',
      leadId,
    );
    return prov;
  });
}

/** Đổi trạng thái chỉ tiến: new → contacted → qualified → won; chưa kết thúc → lost. Lùi / đổi từ
 * won|lost → lỗi. Trả trạng thái cũ. */
export async function setLeadStatus(
  db: Db,
  leadId: Id,
  status: string,
  by: unknown,
): Promise<string> {
  const who = checkBy(by);
  if (!LEAD_STATES.includes(status)) {
    throw new RangeError(`trạng thái phải là ${LEAD_STATES.join('|')}`);
  }
  return withTx(db, async (c) => {
    const row = (await c.query('select status from leads where id = $1', [String(leadId)])).rows[0];
    if (!row) throw new RangeError(`không có lead #${leadId}`);
    const old = row.status as string;
    if (TERMINAL.includes(old)) throw new RangeError(`lead #${leadId} đã kết thúc (${old})`);
    if (!LEAD_FLOW.includes(old)) throw new RangeError(`lead #${leadId} trạng thái lạ — sửa tay`);
    if (status !== 'lost' && LEAD_FLOW.indexOf(status) <= LEAD_FLOW.indexOf(old)) {
      throw new RangeError(`không lùi/giữ trạng thái ${old} → ${status}`);
    }
    // DB khóa dòng + kiểm lại luồng (đổi giữa chừng → từ chối)
    const r = await fn(
      c,
      'select crm_set_lead_status_human($1, $2, $3) as old',
      [String(leadId), status, who],
      who,
      null,
      'status',
      leadId,
    );
    return r.rows[0]?.old as string;
  });
}

export type LeadOwnerCfg = { staff_codes: string[]; handle_within_business_hours: number };

/** v14.4 (sales-04.1): gán người phụ trách (MÃ nhân viên, không tên) + hạn xử lý N giờ LÀM VIỆC từ
 * lúc gán → hạn. Lead không có / đã kết thúc / mã sai mẫu / mã ngoài danh sách (khi có) → lỗi. */
export async function assignOwner(
  db: Db,
  leadId: Id,
  staffCode: unknown,
  by: unknown,
  o: { now?: Date; watch?: LeadOwnerCfg; shift?: unknown } = {},
): Promise<Date> {
  const who = checkBy(by);
  if (typeof staffCode !== 'string' || !STAFF_RE.test(staffCode)) {
    throw new RangeError('--staff phải là MÃ nhân viên [A-Z0-9_-]{2,20} (không ghi tên)');
  }
  const watch = o.watch ?? (section('lead_owner') as unknown as LeadOwnerCfg);
  const codes = watch.staff_codes;
  if (codes.length && !codes.includes(staffCode)) {
    throw new RangeError(
      `mã nhân viên ${staffCode} không có trong danh sách lead_owner.staff_codes`,
    );
  }
  const shift = o.shift ?? loadConfig('sales').business_hours;
  if (!isIntId(leadId)) throw new RangeError('lead_id phải là số nguyên');
  return withTx(db, async (c) => {
    const row = (
      await c.query('select status, owner_code from leads where id = $1', [String(leadId)])
    ).rows[0];
    if (!row) throw new RangeError(`không có lead #${leadId}`);
    if (TERMINAL.includes(row.status)) {
      throw new RangeError(`lead #${leadId} đã kết thúc (${row.status})`);
    }
    const now = o.now ?? ((await c.query('select now() as n')).rows[0]?.n as Date);
    const due = businessDeadline(now, watch.handle_within_business_hours, shift);
    await fn(
      c,
      'select crm_assign_owner_human($1, $2, $3, $4, $5)',
      [String(leadId), staffCode, due, now, who],
      who,
      'sales',
      'assign',
      leadId,
    );
    return due;
  });
}

/** Báo cáo CRM CHỈ SELECT, KHÔNG giải mã: liên hệ, đồng ý hiện hành, lead theo tỉnh/đại lý/trạng
 * thái, lead chưa gán + đại lý gợi ý. KHÔNG in question/user_hash/PII/HMAC/ciphertext. */
export async function report(db: Db, regions: Regions | null = null): Promise<string> {
  const reg = regions ?? loadRegions();
  const out = ['# CRM — lead & đại lý (không chứa PII)'];
  // v15.4: đếm qua function (login người không đọc contacts/consents)
  const cons = new Map<string, [string, string]>();
  for (const r of (await db.query('select * from crm_counts()')).rows) {
    cons.set(r.purpose, [String(r.n_granted), String(r.n_withdrawn)]);
  }
  out.push(`Liên hệ trong vault: ${cons.get('*')?.[0] ?? 0}`);
  out.push('Đồng ý hiện hành (mục đích: đồng ý / đã rút):');
  for (const p of PURPOSES) {
    const [g, w] = cons.get(p) ?? ['0', '0'];
    out.push(`  ${p}: ${g} / ${w}`);
  }
  for (const [title, col] of [
    ['tỉnh', "coalesce(province, 'chưa xác định')"],
    ['đại lý', "coalesce(dealer_code, 'chưa gán')"],
    ['trạng thái', 'status'],
  ]) {
    out.push(`Lead theo ${title}:`);
    const rows = (
      await db.query({
        text: `select ${col}, count(*) from leads group by 1 order by 2 desc, 1`,
        rowMode: 'array',
      })
    ).rows;
    out.push(...(rows.length ? rows.map(([k, n]) => `  ${k}: ${n}`) : ['  (chưa có lead)']));
  }
  const active = (
    await db.query("select code, region from dealers where status = 'active' order by code")
  ).rows as { code: string; region: string }[];
  // ngày theo TimeZone của phiên DB — như psycopg trả datetime theo phiên rồi `%Y-%m-%d`
  const pending = (
    await db.query(
      "select id, to_char(ts, 'YYYY-MM-DD') as day, intent, province, question from leads where dealer_code is null and status not in ('won','lost') order by ts limit 50",
    )
  ).rows;
  out.push(`Lead CHƯA gán (${pending.length} — tối đa 50):`);
  for (const r of pending) {
    const prov = r.province || provinceOf(r.question || '');
    const region = prov ? reg.province_region[prov] : undefined;
    const sug = active.filter((a) => region && a.region === region).map((a) => a.code);
    out.push(
      `  #${r.id} ${r.day} ${r.intent} — tỉnh: ${prov || 'chưa xác định'} — gợi ý: ${sug.join(', ') || '-'}`,
    );
  }
  return out.join('\n');
}

/** Payload cho NGƯỜI chuyển lead tới đại lý (hệ thống không gửi). Luôn có lead_id/province/intent/
 * question (đã che). PII giải mã CHỈ khi function DB xác nhận đồng ý dai_ly ĐÍCH DANH đại lý này
 * còn hiệu lực — ngược lại các khóa PII không có mặt. */
export async function handoffPayload(
  db: Db,
  leadId: Id,
  dealerCode: string,
  keys: VaultKeys,
  by: unknown,
): Promise<Record<string, unknown>> {
  const { rows } = await fn(
    db,
    'select * from crm_handoff_human($1, $2, $3)',
    [String(leadId), dealerCode, by],
    by,
    'sales',
    'handoff',
    leadId,
  );
  const r = rows[0] as Record<string, string | boolean | null>;
  const payload: Record<string, unknown> = {
    lead_id: Number(leadId),
    dealer: dealerCode,
    province: r.province,
    intent: r.intent,
    // gate v14 (F02): scrubUser che cả tên/địa chỉ — lead cũ chỉ đã qua che SĐT/email.
    question: scrubUser((r.question as string) || '')[0],
  };
  if (r.pii_included) {
    for (const k of ['phone', 'name', 'email', 'address']) {
      const v = unseal(keys.fernet, r[`${k}_enc`] as string | null);
      if (v !== null) payload[k] = v;
    }
  }
  return payload;
}
