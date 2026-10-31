import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  cpSlice,
  isInt,
  isPlainObject,
  JsonFileError,
  pyInt,
  readJson,
  squash,
} from '@samsam/core/ops/py';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError, withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { checkGenerate, isHuman as roIsHuman, useReason } from '@samsam/core/rollout/rollout';
import { callHuman, cliGate, isHuman } from '@samsam/core/security/auth';
import { pyStrip } from '@samsam/core/security/py';
import { cpCmp, type DbLease, type Io, STD_IO } from './qr-trace.js';

// Port `pipelines/anchor.py` (v13.8 C09 — neo mã xác thực chuỗi truy xuất, PL01 mục 4b, tính năng
// `farming-06`): gom → gốc Merkle → `anchor_batches` → provider cắm được.
//  - Lá (`collect`, tất định, sắp theo khóa) — CHỈ bản ghi đã bất biến, KHÔNG PII/tọa độ:
//      plot_logs_head:<id>  đầu chuỗi `plot_logs` (id, row_hash) tại `as_of`
//      qr_sig:<id>          chữ ký hồ sơ lô (lô, vai, sha bản chụp + lời văn, thời điểm) — KHÔNG tên
//      qr_issue:<mã>        phát hành mã QR · qr_revoke:<mã> thu hồi mã
//    Lô `source='sample'` bị bỏ (không neo dữ liệu mẫu).
//  - Lá = sha256(0x00 ‖ JSON chuẩn); nút = sha256(0x01 ‖ trái ‖ phải), lẻ thì đẩy nút cuối lên. Bản kê
//    = JSON chuẩn {v, as_of_us, leaves, merkle_root}; digest gửi ra ngoài = sha256(bản kê) — 32 byte
//    DUY NHẤT rời hệ thống.
//  - build: chuỗi hỏng → từ chối; 0 lá → từ chối; gốc trùng lần gom mới nhất → không tạo dòng mới;
//    tính năng `tat` → không gom.
//  - submit: provider `none` → AnchorBlocked (exit 2, KHÔNG ghi gì — "chưa neo"; chọn chuỗi/phí là
//    quyết định hai bên). `opentimestamps` → kiểm bản kê dựng lại khớp sha, rollout biên DÙNG, POST
//    digest tới calendar đầu tiên nhận → biên nhận .ots `da_gui`; mọi calendar lỗi → 1 dòng `loi`.
//    HTTP qua `post` truyền vào (test KHÔNG mở mạng): chỉ https, không redirect, trần byte, timeout.
//  - verify: đối chiếu NỘI BỘ (không phải bằng chứng bên thứ ba). export → bản kê + .ots.
// Thời điểm giữ ĐỦ micro giây (Date của JS chỉ tới mili giây): mốc gom là {ts: text của timestamptz,
// us: bigint}, cột thời gian đọc bằng `extract(epoch …) * 1e6`.

export const CONFIG_FILE = dataPath('anchor_config.json');
export const PROVIDERS = ['none', 'opentimestamps'] as const;
export const FEATURE = 'farming-06';
export const BLOCK = 'farming';
export const CREATED_BY = 'agent:anchor';
export const OTS_MAGIC = Buffer.concat([
  Buffer.from('\x00OpenTimestamps\x00\x00Proof\x00', 'latin1'),
  Buffer.from('bf89e2e884e89294', 'hex'),
]);
/** phiên bản 1 + phép băm SHA256 */
export const OTS_HEAD = Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08])]);
export const MAX_RESP = 8192;
export const LAG = '5 minutes';
export const ATT_PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex');
export const ATT_BITCOIN = Buffer.from('0588960d73d71901', 'hex');
const OP_BIN = new Set([0xf0, 0xf1]); // append, prepend
const OP_HASH: Record<number, string> = { 8: 'sha256', 2: 'sha1' };
export const MAX_OPS = 512;
const PROG = 'python -m pipelines.anchor';

/** Từ chối nghiệp vụ / cấu hình — fail-closed (Python AnchorError(ValueError)). */
export class AnchorError extends RangeError {
  override name = 'AnchorError';
}
/** Provider chưa chọn (`none`) — chưa neo, external-dep. */
export class AnchorBlocked extends AnchorError {
  override name = 'AnchorBlocked';
}
/** Biên nhận .ots sai định dạng / không khớp digest. */
export class OtsError extends RangeError {
  override name = 'OtsError';
}
/** Python ValueError (thông điệp + tên lớp ghi vào lỗi calendar). */
export class PyValueError extends RangeError {
  override name = 'ValueError';
}
/** Python urllib.error.URLError / HTTPError (lỗi mạng, redirect, mã HTTP lỗi). */
export class UrlError extends Error {
  override name = 'URLError';
}
export class HttpError extends UrlError {
  override name = 'HTTPError';
  constructor(readonly status: number) {
    super(`HTTP Error ${status}`);
  }
}

// ------------------------------------------------------------ cấu hình

export type AnchorConfig = {
  provider: (typeof PROVIDERS)[number];
  calendars: string[];
  timeout_s: number;
};

const pyTuple = `(${PROVIDERS.map((p) => `'${p}'`).join(', ')})`;

/** KHÁC Python: timeout `15.0` (float JSON) được nhận như 15 (JSON.parse không phân biệt) — vô hại. */
export function loadConfig(path: string = CONFIG_FILE): AnchorConfig {
  const name = basename(path);
  let cfg: unknown;
  try {
    cfg = readJson(path);
  } catch (e) {
    if (e instanceof JsonFileError) throw new AnchorError(`${name}: không đọc được (${e.pyType})`);
    throw e;
  }
  const prov = isPlainObject(cfg) ? cfg.provider : null;
  if (!(PROVIDERS as readonly unknown[]).includes(prov)) {
    throw new AnchorError(`${name}: provider phải thuộc ${pyTuple}`);
  }
  const out: AnchorConfig = {
    provider: prov as AnchorConfig['provider'],
    calendars: [],
    timeout_s: 15,
  };
  if (prov === 'opentimestamps') {
    const ots = (cfg as Record<string, unknown>).opentimestamps;
    const cals = isPlainObject(ots) ? ots.calendars : null;
    const t = isPlainObject(ots) ? (Object.hasOwn(ots, 'timeout_s') ? ots.timeout_s : 15) : null;
    if (
      !Array.isArray(cals) ||
      !cals.length ||
      !cals.every(
        (c) =>
          typeof c === 'string' &&
          c.startsWith('https://') &&
          ![...'?#@ '].some((x) => c.includes(x)),
      )
    ) {
      throw new AnchorError(
        `${name}: opentimestamps.calendars cần list URL https:// không query/userinfo`,
      );
    }
    if (!isInt(t) || t < 1 || t > 60) {
      throw new AnchorError(`${name}: opentimestamps.timeout_s 1..60`);
    }
    out.calendars = (cals as string[]).map((c) => c.replace(/\/+$/, ''));
    out.timeout_s = t;
  }
  return out;
}

// ------------------------------------------------------------ thuần

/** Python `bytes.fromhex` (cho phép khoảng trắng ASCII giữa các cặp). Sai → RangeError (ValueError). */
export function fromHex(s: string): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (/[ \t\n\v\f\r]/.test(s[i] as string)) {
      i++;
      continue;
    }
    const pair = s.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      const at = /^[0-9a-fA-F]/.test(pair) ? i + 1 : i;
      throw new PyValueError(`non-hexadecimal number found in fromhex() arg at position ${at}`);
    }
    out.push(Number.parseInt(pair, 16));
    i += 2;
  }
  return Buffer.from(out);
}

function jsonStr(s: string): string {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) o += '\\"';
    else if (c === 0x5c) o += '\\\\';
    else if (c === 0x0a) o += '\\n';
    else if (c === 0x0d) o += '\\r';
    else if (c === 0x09) o += '\\t';
    else if (c === 0x08) o += '\\b';
    else if (c === 0x0c) o += '\\f';
    else if (c < 0x20 || c > 0x7e) o += `\\u${c.toString(16).padStart(4, '0')}`;
    else o += s[i];
  }
  return `${o}"`;
}

/** Python `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)` cho giá trị JSON
 * (số nguyên: number an toàn hoặc bigint). shortcut: số thực in theo JS (chưa gặp trong lá/bản kê). */
export function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v))
      throw new PyValueError('Out of range float values are not JSON compliant');
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (typeof v === 'string') return jsonStr(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort(cpCmp);
    return `{${keys.map((k) => `${jsonStr(k)}:${canon(v[k])}`).join(',')}}`;
  }
  throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
}

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function leafHash(data: Record<string, unknown>): string {
  return sha256(Buffer.from([0x00]), Buffer.from(canon(data), 'latin1')).toString('hex');
}

export function merkleRoot(hashes: string[]): string {
  let level = hashes.map(fromHex);
  if (!level.length) throw new AnchorError('không có lá nào để tính gốc Merkle');
  while (level.length > 1) {
    const nxt: Buffer[] = [];
    for (let i = 0; i < level.length - 1; i += 2) {
      nxt.push(sha256(Buffer.from([0x01]), level[i] as Buffer, level[i + 1] as Buffer));
    }
    if (level.length % 2) nxt.push(level[level.length - 1] as Buffer);
    level = nxt;
  }
  return (level[0] as Buffer).toString('hex');
}

export type Leaf = { k: string; d: Record<string, unknown>; h: string };

export function manifest(asOfUs: bigint | number, leaves: unknown, root: string): Buffer {
  return Buffer.from(canon({ v: 1, as_of_us: asOfUs, leaves, merkle_root: root }), 'latin1');
}

/** Tệp .ots (DetachedTimestampFile) cho digest SHA256 = header + phản hồi calendar. */
export function otsFile(digest: Uint8Array, resp: Uint8Array): Buffer {
  return Buffer.concat([OTS_HEAD, digest, resp]);
}

// ------------------------------------------------------- định dạng .ots (r13)
// Sau OTS_HEAD + digest là CÂY timestamp: mỗi nút = dãy mục, mục không phải cuối có tiền tố 0xff;
// mục = attestation (0x00 ‖ tag 8 byte ‖ varbytes payload) hoặc phép (tag 1 byte [‖ varbytes đối số]
// ‖ nút con). varuint = LEB128. Pending: payload = varbytes(URI calendar); Bitcoin: payload =
// varuint(chiều cao khối). KHÔNG kiểm khối Bitcoin ở đây (bên thứ ba).

export function varuint(buf: Uint8Array, i: number): [bigint, number] {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= buf.length || shift > 63n) throw new OtsError('varuint cụt/quá dài');
    const b = buf[i] as number;
    i++;
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [v, i];
    shift += 7n;
  }
}

export function putVaruint(v: number | bigint): Buffer {
  let x = BigInt(v);
  const out: number[] = [];
  for (;;) {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    out.push(b | (x ? 0x80 : 0));
    if (!x) return Buffer.from(out);
  }
}

export function varbytes(buf: Buffer, i: number, cap = 4096): [Buffer, number] {
  const [n, j] = varuint(buf, i);
  if (n > BigInt(cap) || BigInt(j) + n > BigInt(buf.length)) {
    throw new OtsError('varbytes cụt/quá cỡ');
  }
  return [buf.subarray(j, j + Number(n)), j + Number(n)];
}

function applyOp(op: number, arg: Buffer | null, msg: Buffer): Buffer {
  if (op === 0xf0) return Buffer.concat([msg, arg as Buffer]);
  if (op === 0xf1) return Buffer.concat([arg as Buffer, msg]);
  return createHash(OP_HASH[op] as string)
    .update(msg)
    .digest();
}

export type OtsNode = {
  msg: Buffer;
  atts: [Buffer, Buffer][];
  ops: [number, Buffer | null, OtsNode][];
};

/** Nút timestamp tại `msg` → [nút, chỉ số kế]. Phép lạ/cụt/quá nhiều → OtsError. */
export function parseTree(
  buf: Buffer,
  i: number,
  msg: Buffer,
  budget: [number],
): [OtsNode, number] {
  const node: OtsNode = { msg, atts: [], ops: [] };
  for (;;) {
    if (i >= buf.length) throw new OtsError('cây timestamp cụt');
    const more = buf[i] === 0xff;
    if (more) i++;
    if (i >= buf.length) throw new OtsError('cây timestamp cụt');
    const tag = buf[i] as number;
    i++;
    budget[0] -= 1;
    if (budget[0] < 0) throw new OtsError('quá nhiều phép');
    if (tag === 0x00) {
      if (i + 8 > buf.length) throw new OtsError('attestation cụt');
      const atag = buf.subarray(i, i + 8);
      const [payload, j] = varbytes(buf, i + 8);
      i = j;
      node.atts.push([atag, payload]);
    } else if (OP_BIN.has(tag) || tag in OP_HASH) {
      let arg: Buffer | null = null;
      if (OP_BIN.has(tag)) [arg, i] = varbytes(buf, i);
      const [child, j] = parseTree(buf, i, applyOp(tag, arg, msg), budget);
      i = j;
      node.ops.push([tag, arg, child]);
    } else {
      throw new OtsError(`phép 0x${tag.toString(16).padStart(2, '0')} không hỗ trợ`);
    }
    if (!more) return [node, i];
  }
}

export function writeTree(node: OtsNode): Buffer {
  const items: Buffer[] = [
    ...node.atts.map(([t, p]) => Buffer.concat([Buffer.from([0x00]), t, putVaruint(p.length), p])),
    ...node.ops.map(([op, a, c]) =>
      Buffer.concat([
        Buffer.from([op]),
        a !== null ? Buffer.concat([putVaruint(a.length), a]) : Buffer.alloc(0),
        writeTree(c),
      ]),
    ),
  ];
  if (!items.length) throw new OtsError('nút rỗng');
  return Buffer.concat([
    ...items.slice(0, -1).flatMap((x) => [Buffer.from([0xff]), x]),
    items[items.length - 1] as Buffer,
  ]);
}

export type AttKind = 'pending' | 'bitcoin' | 'khac';

/** [(pending|bitcoin|khac, commitment, payload)] trong cả cây. */
export function attestations(node: OtsNode): [AttKind, Buffer, Buffer][] {
  const kind = (t: Buffer): AttKind =>
    t.equals(ATT_PENDING) ? 'pending' : t.equals(ATT_BITCOIN) ? 'bitcoin' : 'khac';
  const out: [AttKind, Buffer, Buffer][] = node.atts.map(([t, p]) => [kind(t), node.msg, p]);
  for (const [, , c] of node.ops) out.push(...attestations(c));
  return out;
}

/** Biên nhận .ots đã lưu → cây (gốc tại digest). Sai đầu tệp / digest khác bản kê / byte thừa /
 * không có attestation → OtsError. */
export function parseReceipt(receipt: Buffer, digestHex: string): OtsNode {
  const digest = fromHex(digestHex);
  const head = Buffer.concat([OTS_HEAD, digest]);
  if (receipt.length < head.length || !receipt.subarray(0, head.length).equals(head)) {
    throw new OtsError('đầu biên nhận không mang đúng digest bản kê');
  }
  const [tree, i] = parseTree(receipt, head.length, digest, [MAX_OPS]);
  if (i !== receipt.length) throw new OtsError('byte thừa sau cây timestamp');
  if (!attestations(tree).length) throw new OtsError('biên nhận không có attestation nào');
  return tree;
}

/** Gắn cây con `sub` (gốc tại `commitment`) vào nút pending tương ứng; bỏ attestation pending ở nút
 * đó. true = đã gắn. */
export function graft(node: OtsNode, commitment: Buffer, sub: OtsNode): boolean {
  if (node.msg.equals(commitment) && node.atts.some(([t]) => t.equals(ATT_PENDING))) {
    node.atts = [...node.atts.filter(([t]) => !t.equals(ATT_PENDING)), ...sub.atts];
    node.ops.push(...sub.ops);
    return true;
  }
  return node.ops.some(([, , c]) => graft(c, commitment, sub));
}

// ------------------------------------------------------------ HTTP (chỉ https, không redirect)

export type Post = (url: string, body: Buffer, timeoutS: number) => Promise<Buffer>;
export type Get = (url: string, timeoutS: number) => Promise<Buffer | null>;
type FetchFn = typeof fetch;

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'samsam-anchor/1' };

function netError(e: unknown): Error {
  const name = (e as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    const t = new Error('timed out');
    t.name = 'TimeoutError';
    return t;
  }
  return new UrlError(String((e as Error)?.message ?? e));
}

/** Đọc thân tối đa MAX_RESP + 1 byte (không tải hết phản hồi lớn). */
async function readCapped(res: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (n <= MAX_RESP) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      n += value.length;
    }
  } catch (e) {
    throw netError(e);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESP + 1);
}

async function send(
  url: string,
  init: RequestInit,
  timeoutS: number,
  fetchImpl: FetchFn,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      headers: HEADERS,
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
  } catch (e) {
    throw netError(e);
  }
}

export async function httpPost(
  url: string,
  body: Buffer,
  timeoutS: number,
  fetchImpl: FetchFn = fetch,
): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new PyValueError('chỉ https');
  const r = await send(url, { method: 'POST', body: new Uint8Array(body) }, timeoutS, fetchImpl);
  if (REDIRECT.has(r.status)) throw new UrlError('redirect bị chặn');
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status);
  if (r.status !== 200) throw new PyValueError(`HTTP ${r.status}`);
  const data = await readCapped(r);
  if (!data.length || data.length > MAX_RESP) throw new PyValueError('phản hồi rỗng/quá cỡ');
  return data;
}

/** GET https, không redirect, trần byte → body | null (404 = chưa có). */
export async function httpGet(
  url: string,
  timeoutS: number,
  fetchImpl: FetchFn = fetch,
): Promise<Buffer | null> {
  if (!url.startsWith('https://')) throw new PyValueError('chỉ https');
  const r = await send(url, { method: 'GET' }, timeoutS, fetchImpl);
  if (REDIRECT.has(r.status)) throw new UrlError('redirect bị chặn');
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new PyValueError(`HTTP ${r.status}`);
  const data = await readCapped(r);
  if (!data.length || data.length > MAX_RESP) throw new PyValueError('phản hồi rỗng/quá cỡ');
  return data;
}

/** Lỗi calendar được ghi nhận (Python bắt OSError/ValueError/URLError/HTTPException); lỗi lập trình
 * (TypeError/ReferenceError/SyntaxError) vẫn nổi lên. */
function calendarErr(e: unknown): e is Error {
  return (
    e instanceof Error &&
    !(e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError)
  );
}

// ------------------------------------------------------------ DB

/** Mốc thời gian đủ micro giây: `ts` = text timestamptz (ép lại `::timestamptz` chính xác), `us` = µs
 * từ epoch (Python `_us`). */
export type AsOf = { ts: string; us: bigint };

const US = (col: string): string => `floor(extract(epoch from ${col}) * 1000000)::bigint::text`;

/** Đồng hồ DB lùi LAG: dòng do tx khác đang mở ghi (giờ = đầu tx của nó) đã commit trước mốc → không
 * bị báo "chèn lùi giờ" giả khi --verify. */
export async function dbNow(db: Db, lag: string = LAG): Promise<AsOf> {
  const r = await db.query<{ ts: string; us: string }>(
    `select t::text as ts, ${US('t')} as us from (select now() - $1::interval as t) x`,
    [lag],
  );
  const row = r.rows[0] as { ts: string; us: string };
  return { ts: row.ts, us: BigInt(row.us) };
}

/** Số nguyên từ DB (text) → number khi an toàn, bigint khi lớn (canon in cùng chữ số như Python). */
const int = (s: string): number | bigint => {
  const b = BigInt(s);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= -BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(b)
    : b;
};

export async function chainProblems(db: Db): Promise<{ id: string; problem: string }[]> {
  return (
    await db.query<{ id: string; problem: string }>(
      'select id::text as id, problem from verify_plot_logs() order by id, problem',
    )
  ).rows;
}

/** Lá tại `asOf` → [{k, d, h}] sắp theo k. */
export async function collect(db: Db, asOf: Pick<AsOf, 'ts'>): Promise<Leaf[]> {
  const items: [string, Record<string, unknown>][] = [];
  const head = (
    await db.query<{ id: string; row_hash: string }>(
      'select id::text as id, row_hash from plot_logs where row_hash is not null and' +
        ' created_at <= $1::timestamptz order by id desc limit 1',
      [asOf.ts],
    )
  ).rows[0];
  if (head) {
    items.push([
      `plot_logs_head:${head.id}`,
      { t: 'plot_logs_head', id: int(head.id), row_hash: head.row_hash },
    ]);
  }
  const sigs = await db.query<{
    id: string;
    lot_code: string;
    role: string;
    snapshot_sha256: string;
    text_sha256: string;
    at_us: string;
  }>(
    `select s.id::text as id, s.lot_code, s.role, s.snapshot_sha256, s.text_sha256, ${US('s.signed_at')}` +
      ' as at_us from qr_signatures s join production_lots l on l.lot_code = s.lot_code where' +
      " l.source <> 'sample' and s.signed_at <= $1::timestamptz order by s.id",
    [asOf.ts],
  );
  for (const s of sigs.rows) {
    items.push([
      `qr_sig:${s.id}`,
      {
        t: 'qr_sig',
        id: int(s.id),
        lot: s.lot_code,
        role: s.role,
        snap: s.snapshot_sha256,
        text: s.text_sha256,
        at_us: int(s.at_us),
      },
    ]);
  }
  const qrs = await db.query<{
    code: string;
    lot_code: string;
    snapshot_sha256: string;
    text_sha256: string;
    at_us: string;
    rev_us: string | null;
    rev_in: boolean;
  }>(
    `select q.code, q.lot_code, q.snapshot_sha256, q.text_sha256, ${US('q.issued_at')} as at_us,` +
      ` ${US('q.revoked_at')} as rev_us, coalesce(q.revoked_at <= $1::timestamptz, false) as rev_in` +
      ' from qr_codes q join production_lots l on l.lot_code = q.lot_code where' +
      " l.source <> 'sample' and q.issued_at <= $1::timestamptz order by q.code",
    [asOf.ts],
  );
  for (const q of qrs.rows) {
    items.push([
      `qr_issue:${q.code}`,
      {
        t: 'qr_issue',
        code: q.code,
        lot: q.lot_code,
        snap: q.snapshot_sha256,
        text: q.text_sha256,
        at_us: int(q.at_us),
      },
    ]);
    if (q.rev_us !== null && q.rev_in) {
      items.push([`qr_revoke:${q.code}`, { t: 'qr_revoke', code: q.code, at_us: int(q.rev_us) }]);
    }
  }
  items.sort((a, b) => cpCmp(a[0], b[0]));
  return items.map(([k, d]) => ({ k, d, h: leafHash(d) }));
}

export type BuildResult = { id: string | null; root: string; n: number; new: boolean };

/** Gom 1 lần → {id, root, n, new}. Tính năng `tat` → RolloutBlocked (KHÔNG gom). */
export async function build(db: Db, now: AsOf, dryRun = false): Promise<BuildResult> {
  await checkGenerate(db, FEATURE, 'gom neo blockchain');
  const bad = await chainProblems(db);
  const b0 = bad[0];
  if (b0) {
    throw new AnchorError(
      `chuỗi plot_logs có ${bad.length} vấn đề (dòng đầu #${b0.id} ${b0.problem}) — không neo chuỗi hỏng`,
    );
  }
  const leaves = await collect(db, now);
  if (!leaves.length) throw new AnchorError('chưa có nhật ký đã chain / hồ sơ lô nào để neo');
  const root = merkleRoot(leaves.map((x) => x.h));
  const last = (
    await db.query<{ id: string; merkle_root: string }>(
      'select id::text as id, merkle_root from anchor_batches order by id desc limit 1',
    )
  ).rows[0];
  if (last && last.merkle_root === root) {
    return { id: last.id, root, n: leaves.length, new: false };
  }
  if (dryRun) return { id: null, root, n: leaves.length, new: true };
  const sha = sha256(manifest(now.us, leaves, root)).toString('hex');
  const r = await db.query<{ id: string }>(
    'insert into anchor_batches (as_of, leaves, merkle_root, manifest_sha256, created_by)' +
      ' values ($1::timestamptz, $2::jsonb, $3, $4, $5) returning id::text as id',
    [now.ts, canon(leaves), root, sha, CREATED_BY],
  );
  return { id: (r.rows[0] as { id: string }).id, root, n: leaves.length, new: true };
}

export type BatchRow = {
  id: string;
  as_of: string;
  as_of_us: bigint;
  leaves: Leaf[];
  merkle_root: string;
  manifest_sha256: string;
};

const BATCH_COLS =
  `select id::text as id, as_of::text as as_of, ${US('as_of')} as as_of_us, leaves, merkle_root,` +
  ' manifest_sha256 from anchor_batches';

export async function batch(db: Db, ref: unknown): Promise<BatchRow> {
  let rows: Record<string, unknown>[];
  if (ref === 'latest') {
    rows = (await db.query(`${BATCH_COLS} order by id desc limit 1`)).rows;
  } else {
    const bid = pyInt(ref);
    if (bid === null) throw new AnchorError(`mã lần gom '${oneline(ref, 30)}' sai`);
    rows = (await db.query(`${BATCH_COLS} where id = $1::numeric`, [bid.toString()])).rows;
  }
  const row = rows[0];
  if (!row) throw new AnchorError(`không có lần gom '${oneline(ref, 30)}'`);
  return { ...(row as BatchRow), as_of_us: BigInt(row.as_of_us as string) };
}

const manifestOf = (row: BatchRow): Buffer => manifest(row.as_of_us, row.leaves, row.merkle_root);

/** Function `*_human` (danh tính theo LOGIN — `human_actor`): 42501 → HumanDenied + authz_denied. */
async function humanCall(
  db: Db,
  sql: string,
  args: unknown[],
  by: string,
  bid: string,
): Promise<unknown> {
  const r = await callHuman(db, sql, args, {
    by,
    block: BLOCK,
    action: 'approve',
    objectType: 'anchor_batch',
    objectId: bid,
  });
  const row = r.rows[0] as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : null;
}

/** 1 dòng `anchor_receipts`. Người → function `anchor_receipt_human` (SECURITY DEFINER — DB kiểm danh
 * tính + khối farming + giai đoạn + digest). Job (`agent:anchor`, login dịch vụ) ghi thẳng. */
async function receipt(
  db: Db,
  bid: string,
  status: 'da_gui' | 'loi',
  cal: string | null,
  rec: Buffer | null,
  error: string | null,
  by: string,
  human: boolean,
): Promise<void> {
  if (human) {
    await humanCall(
      db,
      'select anchor_receipt_human($1, $2, $3, $4, $5, $6)',
      [bid, status, cal, rec, error, by],
      by,
      bid,
    );
    return;
  }
  if (status === 'da_gui') {
    await db.query(
      'insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)' +
        " values ($1, 'opentimestamps', 'da_gui', $2, $3, $4)",
      [bid, cal, rec, by],
    );
  } else {
    await db.query(
      'insert into anchor_receipts (batch_id, provider, status, error, created_by)' +
        " values ($1, 'opentimestamps', 'loi', $2, $3)",
      [bid, error, by],
    );
  }
}

const noScheme = (u: string): string => (u.startsWith('https://') ? u.slice(8) : u);

export type SubmitResult = {
  id: string;
  status: 'da_gui' | 'loi';
  calendar: string | null;
  new: boolean;
  errors?: string[];
};

/** Gửi digest lần gom ra provider → {id, status, calendar, new[, errors]}. */
export async function submit(
  db: Db,
  ref: unknown,
  cfg: AnchorConfig,
  by: string = CREATED_BY,
  post: Post = httpPost,
): Promise<SubmitResult> {
  if (cfg.provider === 'none') {
    throw new AnchorBlocked(
      "provider 'none' — CHƯA NEO (chọn chuỗi/provider/phí là quyết định hai bên, PL01 mục 4b)",
    );
  }
  const row = await batch(db, ref);
  const bid = row.id;
  const digest = sha256(manifestOf(row));
  if (digest.toString('hex') !== row.manifest_sha256) {
    throw new AnchorError(`lần gom #${bid}: bản kê dựng lại LỆCH sha đã lưu — không gửi`);
  }
  const human = roIsHuman(by);
  const why = await useReason(db, FEATURE, `neo lần gom #${bid}`, human);
  if (why) throw new AnchorError(why);
  const done = (
    await db.query<{ calendar: string }>(
      "select calendar from anchor_receipts where batch_id = $1 and status = 'da_gui' order by id" +
        ' limit 1',
      [bid],
    )
  ).rows[0];
  if (done) return { id: bid, status: 'da_gui', calendar: done.calendar, new: false };
  if (human) {
    // v15 fix P10.2: danh tính theo LOGIN (human_logins + khối farming) kiểm ở DB TRƯỚC khi gửi
    // digest ra ngoài — login chưa ánh xạ / khối sai không phát sinh lần gửi nào (HumanDenied).
    await humanCall(db, 'select human_actor($1, $2)', [by, BLOCK], by, bid);
  }
  const errs: string[] = [];
  for (const cal of cfg.calendars) {
    let resp: Buffer;
    try {
      resp = await post(`${cal}/digest`, digest, cfg.timeout_s);
      parseReceipt(otsFile(digest, resp), digest.toString('hex')); // r13: kiểm cây
    } catch (e) {
      if (!calendarErr(e)) throw e;
      errs.push(`${noScheme(cal)}: ${e.name}`);
      continue;
    }
    await receipt(db, bid, 'da_gui', cal, otsFile(digest, resp), null, by, human);
    return { id: bid, status: 'da_gui', calendar: cal, new: true };
  }
  await receipt(db, bid, 'loi', null, null, cpSlice(errs.join('; '), 0, 300), by, human);
  return { id: bid, status: 'loi', calendar: null, new: true, errors: errs };
}

/** Đối chiếu NỘI BỘ → [id, [vấn đề]]; rỗng = khớp. */
export async function verify(db: Db, ref: unknown): Promise<[string, string[]]> {
  const row = await batch(db, ref);
  const out: string[] = [];
  const leaves = row.leaves;
  if (merkleRoot(leaves.map((x) => x.h)) !== row.merkle_root) {
    out.push('gốc Merkle tính lại từ lá đã lưu KHÁC gốc đã lưu');
  }
  if (leaves.some((x) => leafHash(x.d) !== x.h))
    out.push('lá đã lưu có hash không khớp dữ liệu lá');
  if (sha256(manifestOf(row)).toString('hex') !== row.manifest_sha256) {
    out.push('sha256 bản kê KHÁC manifest_sha256 đã lưu');
  }
  const now = new Map((await collect(db, { ts: row.as_of })).map((x) => [x.k, x.h]));
  const old = new Map(leaves.map((x) => [x.k, x.h]));
  const sorted = (xs: Iterable<string>): string[] => [...xs].sort(cpCmp);
  for (const k of sorted([...old.keys()].filter((k) => !now.has(k)))) {
    out.push(`lá ${k}: không còn trong DB`);
  }
  for (const k of sorted([...old.keys()].filter((k) => now.has(k)))) {
    if (old.get(k) !== now.get(k)) out.push(`lá ${k}: dữ liệu DB đã đổi sau khi gom`);
  }
  for (const k of sorted([...now.keys()].filter((k) => !old.has(k)))) {
    out.push(
      `lá ${k}: bản ghi có thời điểm trước mốc gom nhưng không có trong lần gom (chèn lùi giờ?)`,
    );
  }
  const bad = await chainProblems(db);
  if (bad.length) out.push(`chuỗi plot_logs có ${bad.length} vấn đề`);
  const recs = await db.query<{ id: string; receipt: Buffer | null }>(
    'select id::text as id, receipt from anchor_receipts where batch_id = $1 and' +
      " status in ('da_gui', 'da_nang_cap') order by id",
    [row.id],
  );
  for (const r of recs.rows) {
    try {
      // r13: phân tích cả cây .ots, không chỉ so tiền tố
      parseReceipt(r.receipt ?? Buffer.alloc(0), row.manifest_sha256);
    } catch (e) {
      if (!(e instanceof OtsError)) throw e;
      out.push(`biên nhận #${r.id} hỏng: ${e.message}`);
    }
  }
  return [row.id, out];
}

/** Số dòng `da_nang_cap` của lần gom — lịch sử trước r14 có thể > 1. */
async function nUpgraded(db: Db, bid: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from anchor_receipts where batch_id = $1 and status = 'da_nang_cap'",
    [bid],
  );
  return Number(r.rows[0]?.n ?? 1);
}

export type UpgradeResult = {
  id: string;
  status: 'da_nang_cap' | 'cho' | 'chua_gui';
  new?: boolean;
  so_dong_nang_cap?: number;
  heights?: bigint[];
  errors?: string[];
};

/** r13: hỏi calendar attestation hoàn tất cho biên nhận mới nhất (GET <calendar>/timestamp/<hex>, chỉ
 * calendar có trong cấu hình). Có attestation Bitcoin → dòng `da_nang_cap` mang .ots đã ghép
 * (append-only). Vẫn KHÔNG phải xác minh bên thứ ba. */
export async function upgrade(
  db: Db,
  ref: unknown,
  cfg: AnchorConfig,
  get: Get = httpGet,
  by: string = CREATED_BY,
): Promise<UpgradeResult> {
  const row = await batch(db, ref);
  const bid = row.id;
  const sha = row.manifest_sha256;
  // r13-fix4 F4: hỏi calendar = DÙNG ra ngoài → cùng cổng triển khai TRƯỚC mọi HTTP/INSERT.
  // r14 C2: `co_nguoi_duyet` chỉ NGƯỜI (job agent vẫn chặn); danh tính + khối kiểm ở DB TRƯỚC HTTP.
  const human = roIsHuman(by);
  const why = await useReason(db, FEATURE, `nâng cấp biên nhận lần gom #${bid}`, human);
  if (why) throw new AnchorError(why);
  if (human) await humanCall(db, 'select human_actor($1, $2)', [by, BLOCK], by, bid);
  const rec = (
    await db.query<{ status: string; calendar: string; receipt: Buffer }>(
      'select status, calendar, receipt from anchor_receipts where batch_id = $1 and' +
        " status in ('da_gui', 'da_nang_cap') order by id desc limit 1",
      [bid],
    )
  ).rows[0];
  if (!rec) return { id: bid, status: 'chua_gui' };
  const cal = rec.calendar;
  const tree = parseReceipt(Buffer.from(rec.receipt), sha);
  if (rec.status === 'da_nang_cap' || attestations(tree).some(([k]) => k === 'bitcoin')) {
    return {
      id: bid,
      status: 'da_nang_cap',
      new: false,
      so_dong_nang_cap: await nUpgraded(db, bid),
    };
  }
  const allowed = new Set(cfg.calendars);
  let got = 0;
  const errs: string[] = [];
  for (const [kind, commitment, payload] of attestations(tree)) {
    if (kind !== 'pending') continue;
    const uri = new TextDecoder('utf-8').decode(varbytes(payload, 0, 1000)[0]);
    if (!allowed.has(uri)) {
      errs.push('calendar ngoài cấu hình — không hỏi');
      continue;
    }
    let body: Buffer | null;
    try {
      body = await get(`${uri}/timestamp/${commitment.toString('hex')}`, cfg.timeout_s);
    } catch (e) {
      if (!calendarErr(e)) throw e;
      errs.push(`${noScheme(uri)}: ${e.name}`);
      continue;
    }
    if (body === null) continue;
    const [sub, i] = parseTree(body, 0, commitment, [MAX_OPS]);
    if (i !== body.length) throw new OtsError('phản hồi calendar có byte thừa');
    if (attestations(sub).some(([k]) => k === 'bitcoin'))
      got += graft(tree, commitment, sub) ? 1 : 0;
  }
  if (!got) return { id: bid, status: 'cho', errors: errs };
  const fresh = Buffer.concat([OTS_HEAD, fromHex(sha), writeTree(tree)]);
  parseReceipt(fresh, sha); // tự kiểm trước khi ghi
  // r14-fix2 F2: ghi dưới khóa advisory theo lần gom (cùng khóa trigger), kiểm lại "đã có" DƯỚI
  // khóa — 2 caller đua chỉ 1 dòng. Khóa chỉ giữ trong giao dịch ghi ngắn, KHÔNG lúc hỏi calendar.
  let created: boolean;
  if (human) {
    // login người không có INSERT bảng — chỉ qua function kiểm quyền
    created = Boolean(
      await humanCall(
        db,
        'select created from anchor_upgrade_human($1, $2, $3, $4)',
        [bid, cal, fresh, by],
        by,
        bid,
      ),
    );
  } else {
    created = await withTx(db, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `anchor_receipts_upgrade:${bid}`,
      ]);
      const have = await c.query(
        "select status from anchor_receipts where batch_id = $1 and status = 'da_nang_cap' limit 1",
        [bid],
      );
      if (have.rows.length) return false;
      await c.query(
        'insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)' +
          " values ($1, 'opentimestamps', 'da_nang_cap', $2, $3, $4)",
        [bid, cal, fresh, by],
      );
      return true;
    });
  }
  const heights = attestations(tree)
    .filter(([k]) => k === 'bitcoin')
    .map(([, , p]) => varuint(p, 0)[0])
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: UpgradeResult = { id: bid, status: 'da_nang_cap', new: created, heights };
  if (!created) out.so_dong_nang_cap = await nUpgraded(db, bid);
  return out;
}

export async function receiptState(db: Db, bid: string): Promise<string> {
  const r = (
    await db.query<{ status: string; calendar: string | null }>(
      'select status, calendar from anchor_receipts where batch_id = $1 order by' +
        " (status = 'da_nang_cap') desc, (status = 'da_gui') desc, id desc limit 1",
      [bid],
    )
  ).rows[0];
  if (!r) return 'chưa neo';
  if (r.status === 'loi') return 'chưa neo (lần gửi gần nhất lỗi — chạy lại --submit)';
  if (r.status === 'da_nang_cap') {
    return (
      `calendar ${noScheme(r.calendar ?? 'None')} đã trả attestation Bitcoin — CHƯA xác minh` +
      ' bên thứ ba (ots verify với header khối Bitcoin)'
    );
  }
  return (
    `đã gửi calendar ${noScheme(r.calendar ?? 'None')} — chờ xác nhận Bitcoin (--upgrade; bên thứ` +
    ' ba: ots verify)'
  );
}

export async function exportBatch(db: Db, ref: unknown, outDir: string): Promise<string[]> {
  const row = await batch(db, ref);
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, `anchor-${row.id}.json`);
  writeFileSync(p, manifestOf(row));
  const files = [p];
  const rec = (
    await db.query<{ receipt: Buffer }>(
      'select receipt from anchor_receipts where batch_id = $1 and status in' +
        " ('da_gui', 'da_nang_cap') order by (status = 'da_nang_cap') desc, id desc limit 1",
      [row.id],
    )
  ).rows[0];
  if (rec) {
    const q = join(outDir, `anchor-${row.id}.json.ots`);
    writeFileSync(q, rec.receipt);
    files.push(q);
  }
  return files;
}

// ------------------------------------------------------------ CLI

export type AnchorOpts = {
  build?: boolean;
  dryRun?: boolean;
  submit?: string;
  verify?: string;
  export?: string;
  out?: string;
  status?: boolean;
  upgrade?: string;
  by?: string;
};

export type AnchorDeps = {
  io?: Io;
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  configFile?: string;
  post?: Post;
  get?: Get;
  /** Lùi mốc gom (mặc định LAG 5 phút) — chỉ test đặt khác. */
  lag?: string;
};

/** Python `ingest.lead_store.connect()`: `DATABASE_URL` → kết nối | null (thiếu DSN / host chết). */
export async function connectDatabaseUrl(env: Env): Promise<DbLease | null> {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) return null;
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(dsn, {}, env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

/** `python -m pipelines.anchor` → exit: 0 ok · 1 từ chối (chuỗi hỏng / 0 lá / lệch / gửi lỗi /
 * rollout) · 2 tham số sai / cấu hình lỗi / DB down / provider `none` (external-dep: chưa neo). */
export async function anchorMain(o: AnchorOpts, d: AnchorDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string): number => {
    io.err(
      `usage: ${PROG} [--build] [--dry-run] [--submit ID|latest] [--verify ID|latest] [--export ID|latest] [--out OUT] [--status] [--upgrade ID|latest] [--by BY]`,
    );
    io.err(`${PROG}: error: ${m}`);
    return 2;
  };
  const ops = [o.build, o.submit, o.verify, o.export, o.status, o.upgrade];
  if (ops.filter(Boolean).length !== 1) {
    return usage('chọn đúng 1 trong --build/--submit/--verify/--export/--status/--upgrade');
  }
  if (o.export && o.out === undefined) return usage('--export cần --out DIR');
  const by = cpSlice(squash(o.by ?? CREATED_BY), 0, 100);
  if (!by) return usage('--by rỗng');
  let cfg: AnchorConfig;
  try {
    cfg = loadConfig(d.configFile);
  } catch (e) {
    if (!(e instanceof AnchorError)) throw e;
    io.err(`[err] ${e.message}`);
    return 2;
  }
  if ((o.submit || o.upgrade) && cfg.provider === 'none') {
    io.err(
      "[external-dep] provider 'none' — CHƯA NEO: chọn chuỗi/provider/phí là quyết định hai bên (data/anchor_config.json).",
    );
    return 2;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[err] DB không kết nối được');
    return 2;
  }
  const db = lease.db;
  try {
    const now = await dbNow(db, d.lag ?? LAG);
    if (o.build) {
      const r = await build(db, now, Boolean(o.dryRun));
      const tag = o.dryRun ? 'dry-run' : r.new ? 'mới' : 'không đổi';
      io.out(`[ok] lần gom #${r.id ?? 'None'} (${tag}): ${r.n} lá, gốc ${r.root}`);
      if (cfg.provider === 'none') {
        io.out(
          "[external-dep] provider 'none' — lần gom CHƯA NEO ra blockchain (chỉ đối chiếu nội bộ).",
        );
      }
    } else if (o.submit) {
      // v15.4 (P10.2): `--by <người>` mở biên dùng ở giai đoạn "có người duyệt" = QUYẾT ĐỊNH của
      // người được Bên B ủy quyền khối farming (cliGate). `--by` mặc định `agent:anchor` (job).
      if (isHuman(by)) {
        const why = await cliGate(db, by, BLOCK, 'approve', 'anchor_batch', o.submit, {
          env,
          warn: io.err,
        });
        if (why) {
          io.err(`[từ chối] ${why}`);
          return 1;
        }
      }
      const r = await submit(db, o.submit, cfg, by, d.post);
      if (r.status === 'loi') {
        io.err(`[err] lần gom #${r.id}: mọi calendar lỗi — ${(r.errors ?? []).join('; ')}`);
        return 1;
      }
      io.out(`[ok] lần gom #${r.id}: ${await receiptState(db, r.id)}`);
    } else if (o.upgrade) {
      // r14 C2: như --submit — `--by <người>` = QUYẾT ĐỊNH khối farming trước khi hỏi calendar.
      if (isHuman(by)) {
        const why = await cliGate(db, by, BLOCK, 'approve', 'anchor_batch', o.upgrade, {
          env,
          warn: io.err,
        });
        if (why) {
          io.err(`[từ chối] ${why}`);
          return 1;
        }
      }
      const r = await upgrade(db, o.upgrade, cfg, d.get, by);
      if (r.status === 'chua_gui') {
        io.err(`[err] lần gom #${r.id}: chưa có biên nhận đã gửi`);
        return 1;
      }
      if (r.status === 'cho') {
        const errs = r.errors ?? [];
        io.out(
          `[cho] lần gom #${r.id}: calendar chưa có attestation Bitcoin${errs.length ? ` — ${errs.join('; ')}` : ''}`,
        );
        return 0;
      }
      const n = r.so_dong_nang_cap ?? 1;
      io.out(
        `[ok] lần gom #${r.id}: ${await receiptState(db, r.id)}` +
          (r.heights?.length ? ` · khối [${r.heights.join(', ')}]` : '') +
          (n > 1 ? ` · ${n} biên nhận da_nang_cap (lịch sử)` : ''),
      );
    } else if (o.verify) {
      const [bid, probs] = await verify(db, o.verify);
      for (const p of probs) io.out(`[lệch] #${bid} ${p}`);
      io.out(
        `[${probs.length ? 'err' : 'ok'}] lần gom #${bid}: ` +
          `${probs.length ? `${probs.length} vấn đề` : 'khớp DB'} — ${await receiptState(db, bid)}`,
      );
      return probs.length ? 1 : 0;
    } else if (o.export) {
      for (const p of await exportBatch(db, o.export, o.out as string)) io.out(`[ok] ${p}`);
      io.out(
        'Bên thứ ba: `ots upgrade <file>.json.ots` rồi `ots verify <file>.json.ots` (cần tệp .json cạnh .ots).',
      );
    } else {
      // shortcut: giờ in theo UTC tường minh (Python in giờ phiên DB kèm hậu tố Z — khớp khi DB ở UTC).
      const rows = (
        await db.query<{ id: string; at: string; n: string; merkle_root: string }>(
          "select id::text as id, to_char(as_of at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at," +
            ' jsonb_array_length(leaves)::text as n, merkle_root from anchor_batches' +
            ' order by id desc limit 20',
        )
      ).rows;
      io.out(`provider: ${cfg.provider}`);
      for (const r of rows) {
        io.out(
          `  #${r.id} ${r.at}Z ${r.n} lá ${r.merkle_root.slice(0, 16)}… — ${await receiptState(db, r.id)}`,
        );
      }
      if (!rows.length) io.out('  (chưa có lần gom nào)');
    }
    return 0;
  } catch (e) {
    if (e instanceof AnchorBlocked) {
      io.err(`[external-dep] ${e.message}`);
      return 2;
    }
    if (e instanceof RangeError) {
      // AnchorError + RolloutBlocked + OtsError + HumanDenied (Python ValueError)
      io.err(`[err] ${e.message}`);
      return 1;
    }
    if (isDbError(e)) {
      io.err(`[err] DB: ${oneline(dbMsg(e), 200)}`);
      return 2;
    }
    throw e;
  } finally {
    await lease.release();
  }
}
