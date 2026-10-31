import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown, Optional } from '@nestjs/common';
import { AiWorkerBlocked, AiWorkerError, sttProvider, transcribe } from '@samsam/core/ai/ai-worker';
import type { FetchLike } from '@samsam/core/ai/providers';
import { connectDatabaseUrl, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { isPlainObject, pyInt } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { checkGenerate, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, cpLen, pySplit, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import type pg from 'pg';
import { addLog, type DbLease, fold, type Io, normalizeActivity, STD_IO } from './garden.js';
import {
  inRepo,
  limits,
  MissingDep,
  pyOsName,
  Rejected,
  record,
  store,
  stripImage,
  stripVideo,
} from './garden-media.js';

// Port `connectors/zalo_garden.py` (v12.4 VT — nhật ký vườn qua Zalo OA, HĐ PL01 mục 7):
//  - Chỉ NHÂN VIÊN VƯỜN: allowlist `data/garden_staff.json` (user_hash = sha256(user_id)[:16] +
//    ma_nv); thiếu/hỏng/một dòng sai dạng → KHÔNG ai là nhân viên (tin đi chatbot khách như cũ).
//  - Tin nhân viên KHÔNG vào chatbot khách / convlog / history (adapter zalo định tuyến).
//  - Chữ "<mã khoảnh> <hoạt động> <chi tiết>" → `plot_logs` (source zalo:garden, author zalo:<ma_nv>,
//    hash chain do trigger DB); chi tiết qua maskPii, cắt 1000 ký tự; thiếu mã / khoảnh lạ → hướng
//    dẫn, KHÔNG ghi. Ảnh/video → gỡ EXIF/GPS → kho GARDEN_MEDIA_DIR ngoài repo + `garden_media`
//    (khoảnh từ chú thích hoặc tin chữ trong 2 giờ). Ghi âm → magic bytes → kho `audio/` +
//    `garden_voice_drafts` chờ NGƯỜI chép lời. Webhook không bao giờ gọi STT.
//  - Cổng triển khai: chữ/ghi âm = farming-01, ảnh/video = farming-04; `tat` → không ghi gì.
//  - Trả lời xác nhận là text viết tay (không LLM); log chỉ `uh=`.
// KHÁC Python có chủ đích: allowlist UTF-16 (Python json.loads(bytes) nhận) bị coi là hỏng (chặt
// hơn); STT chạy ở AI worker nội bộ (core `ai/ai-worker`) — registry không cắm thêm provider được.

export const STAFF_FILE = dataPath('garden_staff.json');
export const SOURCE = 'zalo:garden';
export const MAX_DETAIL = 1000;
export const MAX_MEDIA = 25 * 1024 * 1024;
export const MAX_ATTACH = 5;
export const LAST_PLOT_TTL_MS = 2 * 3600 * 1000;
// GIẢ ĐỊNH — host CDN Zalo trong payload ảnh/ghi âm; host lạ → không tải (chặn SSRF).
export const MEDIA_HOSTS = ['zdn.vn', 'zadn.vn', 'zalo.me', 'zaloapp.com'];
const MEDIA_TYPES = { image: ['image'], video: ['video'], audio: ['audio', 'voice'] } as const;
type Kind = keyof typeof MEDIA_TYPES;
const HASH_RE = /^[0-9a-f]{16}$/;
const PLOT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
// 'co' không dấu: có / cỏ / cơ — không đoán là 'làm cỏ'.
const AMBIGUOUS = new Set(['co']);
// Dạng CÓ dấu được nhận (vocab + bản có dấu của alias `garden`).
const ACCENTED = new Set([
  'trồng',
  'tưới',
  'bón',
  'làm cỏ',
  'kiểm tra sâu bệnh',
  'phun thuốc sinh học',
  'thu hoạch',
  'ghi nhận',
  'tưới nước',
  'tưới phun sương',
  'bón phân',
  'kiểm tra',
  'sâu bệnh',
  'phun thuốc',
  'trồng mới',
  'khác',
]);

export const HELP =
  'Cú pháp nhật ký vườn: <mã khoảnh> <hoạt động> <chi tiết>, vd: KV-A01 tưới 30 phút. ' +
  'Hoạt động: trồng, tưới, bón, làm cỏ, kiểm tra sâu bệnh, phun thuốc sinh học, thu hoạch, ' +
  'ghi nhận. Ảnh: ghi mã khoảnh ở chú thích, hoặc gửi trong 2 giờ sau tin chữ của khoảnh đó.';
export const DB_DOWN = 'Hệ thống chưa ghi được (lỗi kết nối) — vui lòng gửi lại sau ít phút.';
export const ERROR = 'Hệ thống gặp lỗi, chưa ghi được — vui lòng gửi lại sau ít phút.';
export const NO_STORE = 'Kho ảnh vườn chưa được cấu hình — tệp CHƯA lưu, vui lòng báo quản trị.';
export const NEED_PLOT =
  'Ảnh/video CHƯA lưu: chưa biết khoảnh. Ghi mã khoảnh ở chú thích hoặc gửi tin chữ có mã ' +
  'khoảnh trước (vd: KV-A01 kiểm tra sâu bệnh) rồi gửi ảnh/video trong 2 giờ.';
export const NO_FILE = 'Không đọc được tệp đính kèm — vui lòng gửi lại.';
export const FEATURE_OFF =
  'Tính năng này đang TẮT theo sổ triển khai — CHƯA ghi; vui lòng báo quản lý vùng trồng để ghi tay.';
export const FEATURE_LOG = 'farming-01';
export const FEATURE_MEDIA = 'farming-04';
export const UNSUPPORTED = `Nhật ký vườn qua Zalo nhận chữ, ảnh, video và ghi âm (chưa nhận tệp/sticker/vị trí). ${HELP}`;
const NOT_SAVED = 'CHƯA lưu được tệp (tải lỗi hoặc tệp không hợp lệ) — vui lòng gửi lại.';

/** Như `zalo.uhash` — test khóa 2 hàm bằng nhau. */
export function uhash(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16);
}

/** Python `json.loads(bytes)` cho tệp cấu hình người sửa tay: UTF-8 strict, BOM UTF-8 đầu bỏ qua. */
function loadsBytes(raw: Uint8Array): unknown {
  let s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  if (s.startsWith('﻿')) s = s.slice(1);
  return JSON.parse(s);
}

/** Lý do tệp cấu hình hỏng KHÔNG chứa nội dung tệp (V8 `JSON.parse` trích một đoạn tệp vào thông điệp). */
function loadErr(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  if (e instanceof SyntaxError) return 'JSONDecodeError';
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return 'UnicodeDecodeError';
  if (typeof code === 'string') return pyOsName(e);
  return (e as Error).message; // "thiếu mảng 'staff'" / "staff[i] sai dạng"
}

const staffRows = (obj: unknown): unknown[] => {
  const rows = isPlainObject(obj) ? obj.staff : undefined;
  if (!Array.isArray(rows)) throw new Error("thiếu mảng 'staff'");
  return rows;
};
const okCode = (c: unknown): c is string =>
  typeof c === 'string' && pyStrip(c) !== '' && cpLen(pyStrip(c)) <= 32;

/** {user_hash: ma_nv}; nội dung sai dạng → ném Error(lý do) (cả tệp bị bỏ, không nhận nửa vời). */
export function parseStaff(raw: Uint8Array): Map<string, string> {
  const m = new Map<string, string>();
  staffRows(loadsBytes(raw)).forEach((r, i) => {
    const h = isPlainObject(r) ? r.user_hash : undefined;
    const code = isPlainObject(r) ? r.ma_nv : undefined;
    if (!(typeof h === 'string' && HASH_RE.test(h) && okCode(code)))
      throw new Error(`staff[${i}] sai dạng`);
    m.set(h, pyStrip(code));
  });
  return m;
}

/** Đợt hợp đồng C02 — {mã khoảnh: [mã NV]} từ `khoanh` (tùy chọn) của từng dòng staff. Tệp thiếu →
 * rỗng; hỏng / một dòng sai dạng → rỗng + cảnh báo (khoảnh "chưa có người phụ trách" → leo thang GĐ). */
export function plotOwners(
  path: string = STAFF_FILE,
  log: (s: string) => void = console.log,
): Map<string, string[]> {
  const name = basename(path);
  let obj: unknown;
  try {
    obj = loadsBytes(readFileSync(path));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return new Map();
    log(`[warn] garden: ${name} hỏng (${loadErr(e)}) — không khoảnh nào có người phụ trách`);
    return new Map();
  }
  const out = new Map<string, string[]>();
  try {
    staffRows(obj).forEach((r, i) => {
      const code = isPlainObject(r) ? r.ma_nv : undefined;
      const ks = isPlainObject(r) ? (Object.hasOwn(r, 'khoanh') ? r.khoanh : []) : undefined;
      if (
        !(
          okCode(code) &&
          Array.isArray(ks) &&
          ks.every((k) => typeof k === 'string' && PLOT_RE.test(k))
        )
      ) {
        throw new Error(`staff[${i}] sai dạng`);
      }
      for (const k of ks as string[]) out.set(k, [...(out.get(k) ?? []), pyStrip(code)]);
    });
  } catch (e) {
    log(`[warn] garden: ${name} (${(e as Error).message}) — không khoảnh nào có người phụ trách`);
    return new Map();
  }
  return new Map([...out].map(([k, v]) => [k, pySorted(new Set(v))]));
}

/** [hoạt động chuẩn, phần còn lại]. Khớp dài nhất ≤ 4 từ đầu; chữ CÓ dấu phải khớp đúng dấu. */
function matchActivity(words: string[]): [string, string[]] {
  for (let n = Math.min(4, words.length); n > 0; n--) {
    const cand = words.slice(0, n).join(' ').normalize('NFC').toLowerCase();
    const f = fold(cand);
    if (AMBIGUOUS.has(f) || (cand !== f && !ACCENTED.has(cand))) continue;
    const [act, known] = normalizeActivity(cand);
    if (known) return [act, words.slice(n)];
  }
  return ['ghi nhận', words];
}

/** '<mã khoảnh> <hoạt động> <chi tiết>' → [mã, hoạt động, chi tiết | null]; thiếu từ / mã sai → null. */
export function parseText(text: string | null | undefined): [string, string, string | null] | null {
  const words = pySplit(text ?? '');
  if (words.length < 2 || !PLOT_RE.test(words[0] as string)) return null;
  const [act, rest] = matchActivity(words.slice(1));
  return [words[0] as string, act, rest.join(' ') || null];
}

/** Kho `GARDEN_MEDIA_DIR` (tuyệt đối) — thiếu hoặc nằm trong repo → null. */
export function storeDir(env: Env, log: (s: string) => void = console.log): string | null {
  const d = pyStrip(env.GARDEN_MEDIA_DIR ?? '');
  if (!d) return null;
  if (inRepo(d)) {
    log('[warn] garden: GARDEN_MEDIA_DIR nằm trong repo — không lưu');
    return null;
  }
  return resolve(d);
}

/** GET tệp từ CDN Zalo → bytes. Từ chối (Rejected, không in URL): không https / host ngoài
 * MEDIA_HOSTS / HTTP ≠ 200 (kể cả redirect — không theo) / rỗng / > maxBytes / lỗi mạng. */
export async function fetchMedia(
  url: string,
  maxBytes: number = MAX_MEDIA,
  f: FetchLike = fetch,
  idleMs = 15_000,
): Promise<Buffer> {
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    u = null;
  }
  const host = (u?.hostname ?? '').toLowerCase();
  if (u?.protocol !== 'https:' || !MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
    throw new Rejected('URL tệp không thuộc CDN Zalo');
  const netErr = (e: unknown) => {
    const c = (e as { cause?: { code?: unknown; name?: unknown } }).cause;
    const n =
      typeof c?.code === 'string'
        ? c.code
        : typeof c?.name === 'string'
          ? c.name
          : (e as Error).name;
    return new Rejected(`tải tệp lỗi ${n}`);
  };
  // httpx `timeout=15` là hạn TỪNG lần chờ (kết nối/đầu phản hồi, mỗi lần đọc thân) — không phải hạn
  // tổng: video lớn tải chậm mà vẫn chảy đều thì nhận như Python.
  const ac = new AbortController();
  const idle = <T>(p: Promise<T>): Promise<T> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => {
      t = setTimeout(() => {
        const e = Object.assign(new Error('timeout'), { name: 'ReadTimeout' });
        ac.abort(e);
        rej(e);
      }, idleMs);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(t));
  };
  let res: Response;
  try {
    res = await idle(f(url, { redirect: 'manual', signal: ac.signal }));
  } catch (e) {
    throw netErr(e);
  }
  const reader = res.body?.getReader();
  const stop = () => reader?.cancel().catch(() => {});
  if (res.status !== 200) {
    await stop();
    throw new Rejected(`tải tệp HTTP ${res.status}`);
  }
  const cl = res.headers.get('content-length') ?? '';
  if (/^\d+$/.test(cl) && Number(cl) > maxBytes) {
    await stop();
    throw new Rejected('tệp quá lớn');
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>> | undefined;
    try {
      chunk = reader && (await idle(reader.read()));
    } catch (e) {
      void stop();
      throw netErr(e);
    }
    if (!chunk || chunk.done) break;
    n += chunk.value.length;
    if (n > maxBytes) {
      await stop();
      throw new Rejected('tệp quá lớn');
    }
    parts.push(chunk.value);
  }
  if (!n) throw new Rejected('tệp rỗng');
  return Buffer.concat(parts);
}

/** Đuôi ghi âm theo MAGIC BYTES (không tin đuôi URL) → aac|m4a|mp3|amr|wav|ogg; khác → Rejected. */
export function audioKind(d: Buffer): string {
  const a = (x: number, y: number) => d.toString('latin1', x, y);
  if (a(0, 5) === '#!AMR') return 'amr';
  if (a(0, 4) === 'RIFF' && a(8, 12) === 'WAVE') return 'wav';
  if (a(0, 4) === 'OggS') return 'ogg';
  if (a(0, 3) === 'ID3') return 'mp3';
  if (d.length >= 12 && a(4, 8) === 'ftyp') return 'm4a';
  if (d.length >= 2 && d[0] === 0xff) {
    const b = d[1] as number;
    if ((b & 0xf6) === 0xf0) return 'aac'; // ADTS: sync 12 bit + layer 00
    if ((b & 0xe0) === 0xe0 && b & 0x06) return 'mp3'; // MPEG audio layer I-III
  }
  throw new Rejected('tệp ghi âm không đúng định dạng (magic bytes)');
}

async function findPlot(db: Db, raw: string): Promise<string | null> {
  if (!PLOT_RE.test(raw)) return null;
  const r = await db.query<{ id: string }>(
    'select id from plots where upper(id) = upper($1) order by id limit 1',
    [raw],
  );
  return r.rows[0]?.id ?? null;
}

export const GARDEN_DB = Symbol('GARDEN_DB');
export const GARDEN_OPTIONS = Symbol('GARDEN_OPTIONS');
export type GardenOptions = {
  staffFile?: string;
  env?: Env;
  fetch?: FetchLike;
  /** Giờ tường (ts nhật ký, ngày chụp). */
  now?: () => Date;
  /** Đồng hồ đơn điệu (ms) cho hạn 2 giờ của khoảnh vừa ghi. */
  mono?: () => number;
  log?: (s: string) => void;
};
type Send = (userId: string, text: string) => unknown;

/** Intake nhật ký vườn cho adapter Zalo (`GardenIntake` của module zalo: provider ZALO_GARDEN).
 * DB: pool GARDEN_DB (bước tích hợp: pool login webhook) hoặc tự mở `servicePool('webhook')` khi
 * cần; không kết nối được → DB_DOWN (như Python `_connect()` → None). */
@Injectable()
export class GardenZaloService implements OnApplicationShutdown {
  private staffCache: [string | null, Map<string, string>] = [null, new Map()];
  /** user_hash → [mã khoảnh, mono lúc ghi] — ảnh/ghi âm sau tin chữ. */
  readonly lastPlot = new Map<string, [string, number]>();
  private ownPool: pg.Pool | null = null;
  private readonly staffFile: string;
  private readonly env: Env;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly mono: () => number;
  private readonly log: (s: string) => void;

  constructor(
    @Optional() @Inject(GARDEN_DB) private readonly pool: pg.Pool | null = null,
    @Optional() @Inject(GARDEN_OPTIONS) o: GardenOptions | null = null,
  ) {
    this.staffFile = o?.staffFile ?? STAFF_FILE;
    this.env = o?.env ?? process.env;
    this.fetchFn = o?.fetch ?? fetch;
    this.now = o?.now ?? (() => new Date());
    this.mono = o?.mono ?? (() => performance.now());
    this.log = o?.log ?? ((s) => console.log(s));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.ownPool?.end();
    this.ownPool = null;
  }

  /** {user_hash: ma_nv}, cache theo mtime_ns+size. Thiếu → rỗng; hỏng → rỗng + cảnh báo. */
  private loadStaff(): Map<string, string> {
    let key: string;
    try {
      const st = statSync(this.staffFile, { bigint: true });
      key = `${st.mtimeNs}:${st.size}`;
    } catch {
      this.staffCache = [null, new Map()];
      return this.staffCache[1];
    }
    if (this.staffCache[0] === key) return this.staffCache[1];
    let m: Map<string, string>;
    try {
      m = parseStaff(readFileSync(this.staffFile));
    } catch (e) {
      this.log(
        `[warn] garden: ${basename(this.staffFile)} hỏng (${loadErr(e)}) — không ai được ` +
          'nhận là nhân viên vườn',
      );
      m = new Map();
    }
    this.staffCache = [key, m];
    return m;
  }

  /** Mã nhân viên vườn của user Zalo | null (không phải nhân viên / allowlist thiếu-hỏng). */
  staffCode(userId: string): string | null {
    return userId ? (this.loadStaff().get(uhash(userId)) ?? null) : null;
  }

  recentPlot(uh: string): string | null {
    const hit = this.lastPlot.get(uh);
    return hit && this.mono() - hit[1] <= LAST_PLOT_TTL_MS ? hit[0] : null;
  }

  /** Kết nối riêng cho 1 tin (Python `_connect()`) | null khi không tới được DB. */
  private async lease(): Promise<pg.PoolClient | null> {
    let pool = this.pool;
    if (!pool) {
      try {
        this.ownPool ??= await servicePool('webhook', this.env);
      } catch (e) {
        this.log(`[warn] garden: không mở được DB webhook (${(e as Error).name})`);
        return null;
      }
      pool = this.ownPool;
    }
    try {
      return await pool.connect();
    } catch {
      return null;
    }
  }

  /** Tính năng `tat` (rollout, HĐ 6.7) → true: không ghi gì. Chạy thử vẫn ghi (nhật ký nội bộ). */
  private async off(db: Db, fid: string, uh: string): Promise<boolean> {
    try {
      await checkGenerate(db, fid, 'nhật ký vườn qua Zalo');
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      this.log(`[blocked] garden: ${e.message} (uh=${uh})`);
      return true;
    }
    return false;
  }

  private async onText(uh: string, code: string, text: string): Promise<string> {
    const parsed = parseText(text);
    if (parsed === null) return HELP;
    const [rawPlot, act, detail] = parsed;
    const c = await this.lease();
    if (c === null) return DB_DOWN;
    let plot: string | null;
    let lid: bigint | null;
    let warns: string[];
    try {
      if (await this.off(c, FEATURE_LOG, uh)) return FEATURE_OFF;
      plot = await findPlot(c, rawPlot);
      if (plot === null) return `Không tìm thấy khoảnh '${rawPlot}' — CHƯA ghi. ${HELP}`;
      const det = detail ? cpHead(maskPii(detail), MAX_DETAIL) : null;
      [lid, warns] = await addLog(c, plot, this.now(), act, det, `zalo:${code}`, SOURCE);
    } finally {
      c.release();
    }
    if (lid === null) return `CHƯA ghi: ${warns[0] ?? 'lỗi không rõ'}.`;
    this.lastPlot.set(uh, [plot, this.mono()]);
    let out = `Đã ghi nhật ký #${lid}: ${plot} — ${act}.`;
    if (warns.some((w) => w.includes('dấu hiệu')))
      out += ' Có dấu hiệu cần chú ý — GĐ vùng trồng sẽ thấy trong bản tin.';
    return out;
  }

  private sttNote(uh: string): void {
    const [name, err] = sttProvider(this.env);
    if (err && name !== 'none') {
      this.log(
        `[warn] garden: GARDEN_STT_PROVIDER đặt nhưng chưa tích hợp provider — KHÔNG gửi audio, ` +
          `giữ chờ chép lời (uh=${uh})`,
      );
    }
  }

  private async onMedia(
    uh: string,
    code: string,
    msg: Record<string, unknown>,
    kind: Kind,
  ): Promise<string> {
    const raw = msg.attachments;
    const atts = (Array.isArray(raw) ? raw : []).filter(
      (a): a is Record<string, unknown> =>
        isPlainObject(a) && (MEDIA_TYPES[kind] as readonly unknown[]).includes(a.type),
    );
    const urls: string[] = [];
    for (const a of atts.slice(0, MAX_ATTACH)) {
      const p = a.payload;
      // Python `(a.get("payload") or {}).get("url")`: payload thật mà không phải dict → AttributeError.
      if (pyTruthy(p) && !isPlainObject(p)) throw new TypeError('payload không phải object');
      const u = isPlainObject(p) ? p.url : undefined;
      if (typeof u === 'string' && u) urls.push(u);
    }
    if (!urls.length) return NO_FILE;
    const sdir = storeDir(this.env, this.log);
    if (sdir === null) return NO_STORE;
    const c = await this.lease();
    if (c === null) return DB_DOWN;
    let ok = 0;
    let plot: string | null;
    try {
      if (await this.off(c, kind === 'audio' ? FEATURE_LOG : FEATURE_MEDIA, uh)) return FEATURE_OFF;
      const words = pySplit(pyTruthy(msg.text) ? pyStr(msg.text) : '');
      plot = (words.length ? await findPlot(c, words[0] as string) : null) ?? this.recentPlot(uh);
      if (kind !== 'audio' && plot === null) return NEED_PLOT;
      for (const url of urls) {
        try {
          if (kind !== 'audio') {
            // video: nhánh riêng (magic MP4/MOV + remux ffmpeg), KHÔNG bao giờ qua bộ giải mã ảnh.
            const [clean, ext, info] =
              kind === 'video'
                ? await stripVideo(await fetchMedia(url, limits.maxVideoBytes, this.fetchFn), {
                    tmpDir: join(sdir, '.tmp'),
                    env: this.env,
                  })
                : await stripImage(await fetchMedia(url, MAX_MEDIA, this.fetchFn));
            const [sha] = store(clean, ext, sdir);
            await record(
              c,
              sha,
              ext,
              clean.length,
              info,
              plot as string,
              vnDate(this.now()),
              `zalo:${code}`,
              SOURCE,
            );
          } else {
            const data = await fetchMedia(url, MAX_MEDIA, this.fetchFn);
            const ext = audioKind(data);
            const [sha] = store(data, ext, join(sdir, 'audio'));
            this.sttNote(uh);
            await c.query(
              'insert into garden_voice_drafts (sha256, ext, bytes, staff_code, plot_id, source) ' +
                'values ($1, $2, $3, $4, $5, $6) on conflict (sha256) do nothing',
              [sha, ext, data.length, code, plot, SOURCE],
            );
          }
          ok += 1;
        } catch (e) {
          if (!(e instanceof Rejected || e instanceof MissingDep)) throw e;
          this.log(`[warn] garden: bỏ tệp — ${e.message} (uh=${uh})`);
        }
      }
    } finally {
      c.release();
    }
    if (!ok) return NOT_SAVED;
    if (kind !== 'audio') {
      return `Đã lưu ${ok}/${urls.length} ${kind === 'image' ? 'ảnh' : 'video'} cho khoảnh ${plot} (đã xóa vị trí GPS).`;
    }
    return `Đã nhận ${ok} ghi âm${plot ? ` (khoảnh ${plot})` : ''} — chờ người chép lời rồi mới thành nhật ký chính thức.`;
  }

  /** Tin của nhân viên vườn → intake + trả lời xác nhận qua `send`. Mọi lỗi bắt ở đây (ranh giới
   * xử lý nền) — nhân viên luôn nhận phản hồi. */
  async handle(
    userId: string,
    event: string,
    msg: unknown,
    _msgId: string,
    send: Send,
  ): Promise<{ sent: unknown; text: string }> {
    const uh = uhash(userId);
    const code = this.staffCode(userId);
    const m = isPlainObject(msg) ? msg : {};
    let reply: string;
    try {
      if (code === null)
        reply = ERROR; // bị gỡ khỏi allowlist giữa chừng
      else if (event === 'user_send_text')
        reply = await this.onText(uh, code, pyTruthy(m.text) ? pyStr(m.text) : '');
      else if (event === 'user_send_image') reply = await this.onMedia(uh, code, m, 'image');
      else if (event === 'user_send_video') reply = await this.onMedia(uh, code, m, 'video');
      else if (event === 'user_send_audio' || event === 'user_send_voice')
        reply = await this.onMedia(uh, code, m, 'audio');
      else reply = UNSUPPORTED;
    } catch (e) {
      this.log(`[warn] garden: lỗi ${(e as Error)?.name ?? typeof e} (uh=${uh})`);
      reply = ERROR;
    }
    const sent = await send(userId, reply);
    this.log(`[garden] zalo: ${cpHead(event, 40)} -> ${sent ? 'sent' : 'send-fail'} (uh=${uh})`);
    return { sent, text: reply };
  }
}

// ------------------------------------------------------------ CLI `python -m connectors.zalo_garden`

export type ZaloGardenOpts = {
  hash?: boolean;
  pending?: boolean;
  done?: string;
  log?: string;
  by?: string;
  transcribe?: string;
};
export type ZaloGardenDeps = {
  connect?: () => Promise<DbLease | null>;
  io?: Io;
  env?: Env;
  stdin?: () => Promise<string>;
  fetch?: FetchLike;
};

/** Chép lời 1 nháp ghi âm đang chờ qua STT TẠI CHỖ (AI worker) → in NHÁP đã che PII. Không ghi nhật
 * ký / không đóng nháp — người làm. */
async function transcribeDraft(
  db: Db,
  id: bigint,
  name: string,
  d: ZaloGardenDeps,
  io: Io,
): Promise<number> {
  const env = d.env ?? process.env;
  const r = await db.query<{ sha256: string; ext: string }>(
    "select sha256, ext from garden_voice_drafts where id = $1 and status = 'cho_chep_loi'",
    [String(id)],
  );
  const row = r.rows[0];
  if (!row) {
    io.err(`[err] không có nháp #${id} đang chờ chép lời`);
    return 1;
  }
  const sdir = storeDir(env, io.out);
  if (sdir === null) {
    io.err('[err] thiếu GARDEN_MEDIA_DIR (kho ngoài repo)');
    return 2;
  }
  const { sha256: sha, ext } = row;
  let data: Buffer;
  try {
    data = readFileSync(join(sdir, 'audio', sha.slice(0, 2), `${sha}.${ext}`));
  } catch (e) {
    io.err(`[err] thiếu file ghi âm ${sha.slice(0, 12)} (${pyOsName(e)})`);
    return 1;
  }
  if (createHash('sha256').update(data).digest('hex') !== sha) {
    io.err(`[err] file ghi âm ${sha.slice(0, 12)} lệch sha256`);
    return 1;
  }
  let text: string;
  try {
    text = pyStrip((await transcribe(data, env, d.fetch ?? fetch)).normalize('NFC'));
  } catch (e) {
    if (e instanceof AiWorkerBlocked) {
      io.err(`[blocked] ${e.message}`);
      return 2;
    }
    if (e instanceof AiWorkerError) io.err(`[err] STT ${name}: ${cpHead(maskPii(e.message), 200)}`);
    else io.err(`[err] STT ${name} lỗi (${(e as Error)?.name})`);
    return 1;
  }
  if (!text) {
    io.err(`[err] STT ${name} không ra chữ — người nghe ghi tay`);
    return 1;
  }
  io.out(
    `[nhap] #${id} (${name}) — NHÁP, người nghe đối chiếu rồi ghi nhật ký + --done:\n` +
      cpHead(maskPii(text), MAX_DETAIL),
  );
  return 0;
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    if ((c as Buffer).includes(0x0a) || Buffer.concat(chunks).length > 65_536) break;
  }
  return Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
}

/** exit: 0 ok · 1 nháp/nhật ký không có, STT lỗi · 2 sai tham số / STT chưa cấu hình (TRƯỚC khi
 * connect/đọc audio) / DB down. */
export async function zaloGardenMain(o: ZaloGardenOpts, d: ZaloGardenDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`zalo_garden: error: ${m}`);
    return 2;
  };
  const ints: Record<string, bigint | undefined> = {};
  for (const k of ['done', 'log', 'transcribe'] as const) {
    if (o[k] === undefined) continue;
    const v = pyInt(o[k]);
    if (v === null) return usage(`argument --${k}: invalid int value: '${o[k]}'`);
    ints[k] = v;
  }
  const nOps =
    Number(Boolean(o.hash)) +
    Number(Boolean(o.pending)) +
    Number(ints.done !== undefined) +
    Number(ints.transcribe !== undefined);
  if (nOps !== 1) return usage('chọn đúng 1 trong --hash / --pending / --done / --transcribe');
  if (o.hash) {
    const uid = pyStrip(await (d.stdin ?? readStdinLine)());
    if (!uid) return usage('STDIN rỗng — cần user_id Zalo');
    io.out(uhash(uid));
    return 0;
  }
  if (ints.done !== undefined && (ints.log === undefined || !pyStrip(o.by ?? '')))
    return usage('--done cần --log và --by');
  let stt = 'none';
  if (ints.transcribe !== undefined) {
    const [name, err] = sttProvider(env);
    if (err) {
      // kiểm TRƯỚC khi connect/đọc audio — không gửi gì
      io.err(`[blocked] ${err}`);
      return 2;
    }
    stt = name;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[err] không kết nối được Postgres');
    return 2;
  }
  const { db } = lease;
  try {
    if (o.pending) {
      const r = await db.query<{
        id: string;
        at: string;
        staff_code: string;
        plot_id: string | null;
        sha256: string;
        ext: string;
      }>(
        "select id::text, to_char(received_at, 'YYYY-MM-DD HH24:MI') as at, staff_code, plot_id," +
          " sha256, ext from garden_voice_drafts where status = 'cho_chep_loi' order by id",
      );
      for (const x of r.rows)
        io.out(
          `#${x.id} ${x.at} UTC ${x.staff_code} ${x.plot_id || '-'} ${x.sha256.slice(0, 12)}.${x.ext}`,
        );
      io.out(`[pending] ${r.rows.length} ghi âm chờ chép lời`);
      if (r.rows.length && sttProvider(env)[1]) {
        io.out(
          '[blocked] STT chưa cấu hình — người nghe ghi âm rồi ghi nhật ký tay; vendor STT: ' +
            'BLOCKED (xem --transcribe)',
        );
      }
      return 0;
    }
    if (ints.transcribe !== undefined)
      return await transcribeDraft(db, ints.transcribe, stt, d, io);
    let rows: unknown[];
    try {
      rows = (
        await db.query(
          "update garden_voice_drafts set status = 'da_chep_loi', plot_log_id = $1, closed_by = $2," +
            " closed_at = now() where id = $3 and status = 'cho_chep_loi' returning id",
          [String(ints.log), pyStrip(o.by as string), String(ints.done)],
        )
      ).rows;
    } catch (e) {
      if ((e as { code?: string }).code !== '23503') throw e;
      io.err(`[err] nhật ký #${ints.log} không tồn tại`);
      return 1;
    }
    if (!rows.length) {
      io.err(`[err] không có nháp #${ints.done} đang chờ chép lời`);
      return 1;
    }
    io.out(`[done] nháp #${ints.done} → nhật ký #${ints.log}`);
    return 0;
  } finally {
    await lease.release();
  }
}
