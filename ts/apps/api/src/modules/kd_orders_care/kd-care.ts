import { readFileSync } from 'node:fs';
import { verify as aqVerify } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, loadConfig, submit } from '@samsam/core/ops/director';
import { addDays, vnDate, vnFormat, vnMidnight } from '@samsam/core/ops/period';
import { foldPrefix, isPlainObject, isPrintable, pyInt, readJson } from '@samsam/core/ops/py';
import { isDict, isPyInt, PyFloat, parsePyJson, pyOsName } from '@samsam/core/ops/py-json';
import { readinessFromDb } from '@samsam/core/ops/store';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { checkPublish, type ReadinessMap } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { PII_RE } from '@samsam/core/security/pii';
import { cpLen, pyRepr, pyStr, pyStrip, search } from '@samsam/core/security/py';
import { isoDay } from '../kd_quote/py.js';
import { canContact, cpCmp } from './shared.js';

// Port `agents/kd_care.py` (v10.1 KD-A7, WP16) — chăm sóc lại + xin đánh giá: lập NHÁP tin CHỈ cho
// khách có đồng ý ĐÚNG mục đích → hàng duyệt khối `sales`. KHÔNG gửi, KHÔNG LLM, KHÔNG gọi mạng;
// NGƯỜI gửi tay qua Zalo OA/ZNS sau khi GĐ bán hàng duyệt (external-dep).
// Nguồn: `care_purchases` (lần mua KÊNH SỞ HỮU do NGƯỜI ghi — khách sàn bị chặn ở DB), đồng ý qua
// `canContact` (mặc định false), view `v_promotable` (kênh `channel`), `approval_queue` (đếm trần).
// Luật `data/care_rules.json` (GIẢ ĐỊNH chờ GĐ KD/Pháp chế): rebuy CHỈ lần mua MỚI NHẤT mỗi (khách,
// SKU) trong cửa sổ ngày, đồng ý `marketing`, SKU ∈ v_promotable (rượu/TPBVSK chưa XNQC/giá chưa
// duyệt → BỎ), trần tin/khách/tháng theo THÁNG GỬI; review trong cửa sổ ngày giao, đồng ý `cskh`;
// mỗi lần mua 1 lần. Tin = template CỐ ĐỊNH + tên golden; TPBVSK → CODE nối câu khuyến cáo; qua
// `checkPublish` (guardrail TRƯỚC khi vào hàng). Payload KHÔNG SĐT/tên/email/địa chỉ.

export const RULES_FILE = dataPath('care_rules.json');
export const BLOCK = 'sales';
export const AGENT = 'agent:kd_a7';
export const JOB = 'agents.kd_care';
export const FEATURE = 'sales-07.2';
export const OWN_CHANNELS = ['web', 'zalo', 'b2b', 'showroom'];
export type Kind = 'rebuy' | 'review';
export const TYPES: Record<Kind, string> = { rebuy: 'care_rebuy', review: 'care_review' };
export const PURPOSE: Record<Kind, string> = { rebuy: 'marketing', review: 'cskh' };
const CTYPE: Record<Kind, string> = { rebuy: 'post_sale', review: 'post' };
export const MAX_INPUT_BYTES = 4096;
export const MAX_BY = 100;
const REF_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
// Python `^contact_id: ([0-9]{1,18})$` MULTILINE: chỉ LF là xuống dòng (cờ `m` của JS nhận cả CR, LS, PS).
const CONTACT_LINE_RE = /(?:^|(?<=\n))contact_id: ([0-9]{1,18})(?=\n|$)/;
const DAY_MS = 86_400_000;

/** data/care_rules.json không dùng được (Python `CareRulesError(ValueError)`). */
export class CareRulesError extends RangeError {
  override name = 'CareRulesError';
}

export type Rules = {
  channel: string;
  /** [bắt đầu, kết thúc) phút trong ngày giờ VN. */
  window: [number, number];
  rebuy_after_days: number;
  rebuy_window_days: number;
  review_after_days: number;
  review_window_days: number;
  max_marketing_per_month: number;
  templates: Record<Kind, string>;
};

/** Lỗi tra khóa kiểu Python (KeyError/TypeError/IndexError) — thông điệp như `str(e)`. */
class PyLookup extends Error {
  constructor(
    readonly pyType: string,
    msg: string,
  ) {
    super(msg);
  }
}

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof PyFloat) return 'float';
  return typeof v === 'number' ? 'int' : typeof v;
}

/** Python `c[k]` trên giá trị JSON. */
function idx(c: unknown, k: string | number): unknown {
  if (Array.isArray(c) || typeof c === 'string') {
    const xs = Array.isArray(c) ? c : Array.from(c);
    const what = Array.isArray(c) ? 'list' : 'string';
    if (typeof k !== 'number') {
      throw new PyLookup(
        'TypeError',
        Array.isArray(c)
          ? 'list indices must be integers or slices, not str'
          : "string indices must be integers, not 'str'",
      );
    }
    if (k >= xs.length) throw new PyLookup('IndexError', `${what} index out of range`);
    return xs[k];
  }
  if (isDict(c)) {
    if (typeof k === 'number' || !Object.hasOwn(c, k)) {
      throw new PyLookup('KeyError', typeof k === 'number' ? String(k) : pyRepr(k));
    }
    return c[k];
  }
  throw new PyLookup('TypeError', `'${typeName(c)}' object is not subscriptable`);
}

function int(v: unknown, lo: number, hi: number, name: string): number {
  if (!(isPyInt(v) && lo <= v && v <= hi)) {
    throw new CareRulesError(`${name} phải số nguyên ${lo}..${hi}`);
  }
  return v;
}

function hhmm(v: unknown, name: string): number {
  const m = typeof v === 'string' ? HHMM_RE.exec(v) : null;
  if (!m) throw new CareRulesError(`${name} phải HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Luật đã validate. Lỗi → CareRulesError (fail-closed, không chạy). */
export function loadRules(path: string = RULES_FILE): Rules {
  let doc: unknown;
  try {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (e) {
      throw new PyLookup(pyOsName(e), '');
    }
    let text: string;
    try {
      // `.decode("utf-8")` KHÔNG bỏ BOM → json.loads lỗi (JSONDecodeError) như Python.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      throw new PyLookup('UnicodeDecodeError', '');
    }
    try {
      doc = parsePyJson(text);
    } catch {
      throw new PyLookup('JSONDecodeError', '');
    }
  } catch (e) {
    throw new CareRulesError(`care_rules.json không đọc được (${(e as PyLookup).pyType})`);
  }
  if (!isDict(doc)) throw new CareRulesError('care_rules.json không phải object');
  let rules: Rules;
  let w: unknown;
  try {
    w = idx(doc, 'window');
    const start = hhmm(idx(w, 0), 'window[0]');
    const end = hhmm(idx(w, 1), 'window[1]');
    const tm = idx(doc, 'templates');
    rules = {
      channel: idx(doc, 'channel') as string,
      window: [start, end],
      rebuy_after_days: int(idx(doc, 'rebuy_after_days'), 1, 3650, 'rebuy_after_days'),
      rebuy_window_days: int(idx(doc, 'rebuy_window_days'), 0, 3650, 'rebuy_window_days'),
      review_after_days: int(idx(doc, 'review_after_days'), 0, 365, 'review_after_days'),
      review_window_days: int(idx(doc, 'review_window_days'), 0, 365, 'review_window_days'),
      max_marketing_per_month: int(
        idx(doc, 'max_marketing_per_month'),
        0,
        31,
        'max_marketing_per_month',
      ),
      templates: { rebuy: idx(tm, 'rebuy') as string, review: idx(tm, 'review') as string },
    };
  } catch (e) {
    if (!(e instanceof PyLookup)) throw e;
    throw new CareRulesError(`care_rules.json thiếu/sai khóa (${e.pyType}: ${e.message})`);
  }
  if ((w as unknown[]).length !== 2 || !(rules.window[0] < rules.window[1])) {
    throw new CareRulesError('window phải [bắt đầu, kết thúc) với bắt đầu < kết thúc');
  }
  if (typeof rules.channel !== 'string' || !OWN_CHANNELS.includes(rules.channel)) {
    throw new CareRulesError(`channel phải thuộc (${OWN_CHANNELS.map(pyRepr).join(', ')})`);
  }
  for (const [k, t] of Object.entries(rules.templates)) {
    if (!(typeof t === 'string' && t.split('{ten_sp}').length === 2 && cpLen(t) <= 1000)) {
      throw new CareRulesError(`templates.${k} phải chuỗi có đúng 1 chỗ {ten_sp}`);
    }
  }
  return rules;
}

// ------------------------------------------------------------ thời gian (giờ VN)
const vnMs = (d: Date): number => (((d.getTime() + 7 * 3_600_000) % DAY_MS) + DAY_MS) % DAY_MS;

export function inWindow(now: Date, window: [number, number]): boolean {
  const t = vnMs(now);
  return window[0] * 60_000 <= t && t < window[1] * 60_000;
}

/** now trong khung → now; trước khung → mốc mở khung cùng ngày; sau khung → mốc mở khung hôm sau. */
export function guiLuc(now: Date, window: [number, number]): Date {
  if (inWindow(now, window)) return now;
  const today = vnDate(now);
  const day = vnMs(now) < window[0] * 60_000 ? today : addDays(today, 1);
  return new Date(vnMidnight(day).getTime() + window[0] * 60_000);
}

export const monthKey = (d: Date): string => vnFormat(d, '%Y-%m');

// ------------------------------------------------------------ chọn (THUẦN)
/** Câu khuyến cáo TPBVSK chuẩn (guardrail_rules.json); lỗi → ''. */
export function canon(): string {
  try {
    const doc = readJson(dataPath('guardrail_rules.json'));
    const d = isPlainObject(doc) ? doc.disclaimer : undefined;
    if (!isPlainObject(d) || !Object.hasOwn(d, 'canonical')) return '';
    return pyStrip(pyStr(d.canonical));
  } catch {
    return '';
  }
}

export type Purchase = {
  id: number;
  contact_id: number;
  channel: string | null;
  sku_key: string;
  name: string;
  category: string | null;
  purchased_on: string;
  delivered_on: string | null;
};

/** Tin = template cố định + tên golden; TPBVSK → nối câu khuyến cáo. */
export function renderText(
  kind: Kind,
  p: Pick<Purchase, 'name' | 'category'>,
  rules: Rules,
): string {
  let text = rules.templates[kind].replaceAll('{ten_sp}', () => p.name);
  if (p.category === 'tpbvsk') {
    const c = canon();
    if (c) text += `\n${c}.`;
  }
  return text;
}

export function payloadOf(text: string, contactId: number, kind: Kind, sendAt: Date): string {
  return (
    `${text}\n---\ncontact_id: ${contactId}\nmuc_dich: ${PURPOSE[kind]}\n` +
    `gui_luc: ${vnFormat(sendAt, '%Y-%m-%d %H:%M')} (giờ VN)\n` +
    "Hệ thống KHÔNG tự gửi — người gửi tay phần tin phía trên dòng '---' qua Zalo OA sau khi duyệt và chạy --verify-send."
  );
}

export type CareData = {
  purchases: Purchase[];
  /** khóa `${contact_id}:${mục đích}`. */
  consent: Map<string, boolean>;
  promotable: Set<string>;
  month_counts: Map<number, number>;
  seen_rebuy: Set<number>;
  seen_review: Set<number>;
};
export type CareItem = {
  kind: Kind;
  object_type: string;
  object_id: string;
  purchase_id: number;
  contact_id: number;
  sku_key: string;
  gui_luc: Date;
  title: string;
  payload: string;
};
export type Skipped = { purchase_id: number; contact_id: number; kind: Kind; ly_do: string };
export type Selection = { items: CareItem[]; skipped: Skipped[] };

/** THUẦN, tất định → nháp đạt luật + lần mua bị bỏ (lý do). */
export function selectItems(
  data: CareData,
  now: Date,
  rules: Rules,
  readiness: ReadinessMap | null = null,
): Selection {
  const today = vnDate(now);
  const sendAt = guiLuc(now, rules.window);
  // Trần theo THÁNG GỬI (22:30 ngày 31 → gửi 08:00 ngày 1 tháng sau → tính vào tháng sau).
  const mk = monthKey(sendAt);
  const rbHi = addDays(today, -rules.rebuy_after_days);
  const rbLo = addDays(rbHi, -rules.rebuy_window_days);
  const rvHi = addDays(today, -rules.review_after_days);
  const rvLo = addDays(rvHi, -rules.review_window_days);
  const purchases = [...data.purchases].sort(
    (a, b) => cpCmp(a.purchased_on, b.purchased_on) || a.id - b.id,
  );
  // lần mua MỚI NHẤT mỗi (khách, SKU) — lần cũ hơn đã được mua lại
  const latest = new Map(purchases.map((p) => [`${p.contact_id}\u0000${p.sku_key}`, p.id]));
  const counts = new Map(data.month_counts);
  const items: CareItem[] = [];
  const skipped: Skipped[] = [];
  const skip = (p: Purchase, kind: Kind, why: string) =>
    skipped.push({ purchase_id: p.id, contact_id: p.contact_id, kind, ly_do: why });
  const push = (p: Purchase, kind: Kind, oid: string): boolean => {
    const text = renderText(kind, p, rules);
    const g = checkPublish(text, {
      channel: rules.channel,
      contentType: CTYPE[kind],
      sku: p.sku_key,
      isAi: false,
      readiness,
    });
    if (g.ok !== true) {
      skip(p, kind, 'guardrail');
      return false;
    }
    items.push({
      kind,
      object_type: TYPES[kind],
      object_id: oid,
      purchase_id: p.id,
      contact_id: p.contact_id,
      sku_key: p.sku_key,
      gui_luc: sendAt,
      title: `${kind === 'rebuy' ? 'Nhắc mua lại' : 'Xin đánh giá'} — khách #${p.contact_id}, lần mua #${p.id}`,
      payload: payloadOf(text, p.contact_id, kind, sendAt),
    });
    return true;
  };
  for (const p of purchases) {
    if (!OWN_CHANNELS.includes(p.channel as string)) {
      skip(p, 'rebuy', 'kenh_san'); // chặn cả ở DB — phòng thủ kép
      continue;
    }
    const cid = p.contact_id;
    // --- nhắc mua lại
    if (
      rbLo <= p.purchased_on &&
      p.purchased_on <= rbHi &&
      latest.get(`${cid}\u0000${p.sku_key}`) === p.id &&
      !data.seen_rebuy.has(p.id)
    ) {
      const alcohol = p.category === 'alcohol' || isAlcohol(p.name || '');
      if (!data.consent.get(`${cid}:marketing`)) skip(p, 'rebuy', 'consent');
      else if (alcohol) skip(p, 'rebuy', 'ruou');
      else if (!data.promotable.has(p.sku_key)) skip(p, 'rebuy', 'khong_promotable');
      else if ((counts.get(cid) ?? 0) >= rules.max_marketing_per_month)
        skip(p, 'rebuy', 'tran_thang');
      else if (push(p, 'rebuy', `${cid}:${mk}:p${p.id}`))
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
    // --- xin đánh giá
    const d = p.delivered_on;
    if (d !== null && rvLo <= d && d <= rvHi && !data.seen_review.has(p.id)) {
      if (!data.consent.get(`${cid}:cskh`)) skip(p, 'review', 'consent');
      else push(p, 'review', `review:${p.id}`);
    }
  }
  return { items, skipped };
}

// ------------------------------------------------------------ đọc DB
// shortcut: id/contact_id (bigint identity) đổi sang number — an toàn tới 2^53, nâng khi id vượt.
/** CHỈ SELECT. Đồng ý đọc qua `canContact` (mặc định false). */
export async function loadData(db: Db, now: Date, rules: Rules): Promise<CareData> {
  const { rows } = await db.query(
    'select p.id::text as id, p.contact_id::text as contact_id, p.channel, p.sku_key, m.name, m.category,' +
      ' p.purchased_on::text as purchased_on, p.delivered_on::text as delivered_on from care_purchases p' +
      ' join sku_master m on m.sku_key = p.sku_key order by p.id',
  );
  const purchases: Purchase[] = rows.map((r) => ({
    ...r,
    id: Number(r.id),
    contact_id: Number(r.contact_id),
  }));
  const consent = new Map<string, boolean>();
  for (const cid of [...new Set(purchases.map((p) => p.contact_id))].sort((a, b) => a - b)) {
    for (const purpose of ['marketing', 'cskh']) {
      consent.set(`${cid}:${purpose}`, await canContact(db, cid, purpose));
    }
  }
  const promotable = new Set(
    (
      await db.query('select sku_key from v_promotable where channel = $1', [rules.channel])
    ).rows.map((r) => String(r.sku_key)),
  );
  const counts = new Map<number, number>();
  const mk = monthKey(guiLuc(now, rules.window));
  for (const r of (
    await db.query(
      "select object_id from approval_queue where object_type = 'care_rebuy' and status in ('pending', 'approved') and object_id like $1",
      [`%:${mk}:%`],
    )
  ).rows) {
    const c = pyInt(String(r.object_id).split(':')[0]);
    if (c !== null) counts.set(Number(c), (counts.get(Number(c)) ?? 0) + 1);
  }
  const seenRebuy = new Set<number>();
  const seenReview = new Set<number>();
  for (const r of (
    await db.query(
      "select object_type, object_id from approval_queue where object_type in ('care_rebuy', 'care_review')",
    )
  ).rows) {
    const oid = String(r.object_id);
    const tail = oid.slice(oid.lastIndexOf(':') + 1);
    if (r.object_type === 'care_rebuy' && tail.startsWith('p')) {
      const n = pyInt(tail.slice(1));
      if (n !== null) seenRebuy.add(Number(n));
    } else if (r.object_type === 'care_review' && oid.startsWith('review:')) {
      const n = pyInt(tail);
      if (n !== null) seenReview.add(Number(n));
    }
  }
  return {
    purchases,
    consent,
    promotable,
    month_counts: counts,
    seen_rebuy: seenRebuy,
    seen_review: seenReview,
  };
}

export async function plan(db: Db, now: Date, rules?: Rules): Promise<Selection> {
  const r = rules ?? loadRules();
  return selectItems(await loadData(db, now, r), now, r, await readinessFromDb(db));
}

/** plan → `director.submit` từng mục (dry-run: không ghi). */
export async function run(
  db: Db,
  now: Date,
  dryRun = false,
  rules?: Rules,
  cfg?: DirectorConfig,
): Promise<Selection & { new: number }> {
  const res = await plan(db, now, rules);
  let n = 0;
  if (!dryRun) {
    const c = cfg ?? loadConfig(BLOCK);
    for (const it of res.items) {
      try {
        await submit(db, {
          block: BLOCK,
          objectType: it.object_type,
          objectId: it.object_id,
          title: it.title,
          payload: it.payload,
          createdBy: AGENT,
          cfg: c,
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') continue; // cùng mục vừa được đẩy song song
        throw e;
      }
      n++;
    }
  }
  return { new: n, ...res };
}

/** Kiểm NGAY TRƯỚC KHI NGƯỜI gửi → [ok, lý do]: khong_tim_thay | loai_la | chua_duyet | sha |
 * consent | khung_gio | thang_khac | ok. */
export async function verifySend(
  db: Db,
  itemId: unknown,
  text: string,
  now: Date,
  rules?: Rules,
): Promise<[boolean, string]> {
  const r = rules ?? loadRules();
  const qid = pyInt(itemId);
  if (qid === null) return [false, 'khong_tim_thay'];
  let row: Record<string, unknown> | undefined;
  try {
    row = (
      await db.query('select object_type, status, object_id from approval_queue where id = $1', [
        String(qid),
      ])
    ).rows[0];
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, 'khong_tim_thay'];
  }
  if (row === undefined) return [false, 'khong_tim_thay'];
  const kind = (Object.keys(TYPES) as Kind[]).find((k) => TYPES[k] === row.object_type);
  if (kind === undefined) return [false, 'loai_la'];
  if (row.status !== 'approved') return [false, 'chua_duyet'];
  if (!(await aqVerify(db, qid, text))) return [false, 'sha'];
  const m = CONTACT_LINE_RE.exec(text);
  if (m === null || !(await canContact(db, m[1] as string, PURPOSE[kind]))) {
    return [false, 'consent'];
  }
  if (!inWindow(now, r.window)) return [false, 'khung_gio'];
  // Trần tháng tính theo tháng gửi trong object_id → gửi trễ sang tháng khác: chặn, --run lập lại.
  if (kind === 'rebuy' && String(row.object_id).split(':')[1] !== monthKey(now)) {
    return [false, 'thang_khac'];
  }
  return [true, 'ok'];
}

// ------------------------------------------------------------ ghi lần mua (NGƯỜI ghi)
const BY_ERR = "--by phải là tên NGƯỜI ghi (≤ 100 ký tự, không 'agent:'/'system:')";

/** Tên NGƯỜI ghi. KHÁC Python có chủ đích: so tiền tố agent:/system: sau NFKC (chặt hơn). */
export function checkBy(by: unknown): string {
  const s = pyStrip(typeof by === 'string' ? by : '');
  const f = foldPrefix(s);
  if (
    !s ||
    cpLen(s) > MAX_BY ||
    !isPrintable(s) ||
    f.startsWith('agent:') ||
    f.startsWith('system:')
  ) {
    throw new RangeError(BY_ERR);
  }
  return s;
}

const REC_KEYS = ['contact_id', 'channel', 'sku_key', 'purchased_on', 'delivered_on', 'order_ref'];

function dateOf(v: unknown, name: string, required = true): string | null {
  if ((v === null || v === undefined) && !required) return null;
  const d = isoDay(v);
  if (d === null) throw new RangeError(`${name} phải YYYY-MM-DD`);
  return d;
}

export type CareRecord = {
  by: string;
  contact_id: number;
  channel: string;
  sku_key: string;
  purchased_on: string;
  delivered_on: string | null;
  order_ref: string | null;
};

/** Kiểm TRƯỚC khi ghi; không nhận trường PII (chỉ contact_id). Lỗi: TypeError / RangeError. */
export function validateRecord(rec: unknown, by: unknown): CareRecord {
  const who = checkBy(by);
  if (!isDict(rec)) throw new TypeError('input phải là object JSON');
  const extra = Object.keys(rec).filter((k) => !REC_KEYS.includes(k));
  if (extra.length) {
    // Không echo tên trường: key do người nhập có thể chính là SĐT/tên (rà OWASP A09 v10.1).
    throw new RangeError(
      `có ${extra.length} trường không nhận — chỉ ghi contact_id, channel, sku_key, purchased_on, delivered_on, order_ref (PII nằm trong vault contacts)`,
    );
  }
  const cid = rec.contact_id;
  // isSafeInteger: JSON số > 2^53 bị JS làm tròn → từ chối (chặt hơn Python, fail-closed).
  if (!(isPyInt(cid) && Number.isSafeInteger(cid) && cid > 0)) {
    throw new RangeError('contact_id phải số nguyên dương');
  }
  const ch = rec.channel;
  if (typeof ch !== 'string' || !OWN_CHANNELS.includes(ch)) {
    throw new RangeError(
      `channel phải ${OWN_CHANNELS.join('|')} — khách sàn chăm sóc bằng công cụ của sàn`,
    );
  }
  const sku = rec.sku_key;
  if (!(typeof sku === 'string' && REF_RE.test(sku))) throw new RangeError('sku_key không hợp lệ');
  const bought = dateOf(rec.purchased_on, 'purchased_on') as string;
  const got = dateOf(rec.delivered_on, 'delivered_on', false);
  const ref = rec.order_ref ?? null;
  if (ref !== null && !(typeof ref === 'string' && REF_RE.test(ref) && !search(PII_RE, ref))) {
    throw new RangeError(
      'order_ref phải MÃ nội bộ [A-Za-z0-9_.:-] ≤ 40 ký tự, không phải SĐT/email',
    );
  }
  return {
    by: who,
    contact_id: cid,
    channel: ch,
    sku_key: sku,
    purchased_on: bought,
    delivered_on: got,
    order_ref: ref as string | null,
  };
}

/** Ghi 1 lần mua (NGƯỜI ghi) → id. Log `agent_action_log` không PII. */
export async function record(db: Db, rec: unknown, by: unknown): Promise<bigint> {
  const r = validateRecord(rec, by);
  return withTx(db, async (c) => {
    const { rows } = await c.query(
      'insert into care_purchases (contact_id, channel, order_ref, sku_key, purchased_on, delivered_on, recorded_by) values ($1, $2, $3, $4, $5, $6, $7) returning id::text as id',
      [r.contact_id, r.channel, r.order_ref, r.sku_key, r.purchased_on, r.delivered_on, r.by],
    );
    const pid = String(rows[0]?.id);
    await c.query(
      'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)',
      [
        r.by,
        'care_purchase_record',
        'care_purchase',
        pid,
        JSON.stringify({ contact_id: r.contact_id, channel: r.channel, sku_key: r.sku_key }),
      ],
    );
    return BigInt(pid);
  });
}
