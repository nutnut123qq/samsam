import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isPlainObject } from '@samsam/core/ops/py';
import { convRow, pgErrName } from '@samsam/core/rollout/counters';
import { scrubUser } from '@samsam/core/security/pii';
import type { Pool } from 'pg';
import { CONV_LOG_MAX, clock, PURGE_RETRY_S, RETAIN_DAYS } from './zalo.constants.js';

// Port phần conversation log của connectors/zalo.py (D3.3/D5.4/D5.11/D6.2/D6.9/V3.3/V4.1,
// v15 fix P8.1, docx P0). File data/conversations.jsonl: 1 dòng JSON/lượt, chỉ user_hash (không
// user_id), câu khách + câu bot qua `scrubUser`; rotate sang `.1` khi vượt 5MB; dòng không chứng
// minh được tuổi ≤ 30 ngày bị bỏ khi purge. Ghi file đồng bộ = nguyên tử trong vòng lặp sự kiện
// (thay `_log_lock` của Python).

export type Entry = Record<string, unknown>;

// v15 fix P8.1 — provenance đặt TỪ NƠI GHI: "live" chỉ khi gửi bằng transport kênh THẬT đã đăng ký
// (so ĐÚNG đối tượng hàm; wrapper/lambda/thay thế không lọt); `settings.convSample` (script mock/
// replay đặt) ép mọi dòng thành mẫu.
export const convSettings = { convSample: false };
const LIVE = new Set<unknown>();

/** Đăng ký hàm gửi ra kênh THẬT (true chỉ khi API nhận) — Messenger cũng dùng. */
export function liveTransport<F>(fn: F): F {
  LIVE.add(fn);
  return fn;
}

export function provenance(send: unknown): Entry {
  if (!convSettings.convSample && LIVE.has(send)) return { provenance: 'live' };
  return { provenance: 'sample', is_sample: true };
}

/** Câu khách/câu bot ghi convlog qua CÙNG bộ che `scrubUser` (SĐT/email + tên/địa chỉ). */
export function logQuestion(q: unknown): unknown {
  return typeof q === 'string' ? scrubUser(q)[0] : q;
}

export const tsNow = (): string => fmtTs(clock.wall());
function fmtTs(epochS: number): string {
  return `${new Date(Math.floor(epochS) * 1000).toISOString().slice(0, 19)}Z`;
}

// time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ") — mẫu `_strptime` của Python (IGNORECASE, %m/%d/%H/%M/%S
// nhận 1 chữ số, %d nhận " 5", %S tới 61) + kiểm ngày theo tháng. shortcut: chỉ chữ số ASCII
// (Python `\d` nhận cả chữ số Unicode) — ts lạ bị bỏ = chặt hơn, không giữ thừa PII.
const TS_RE =
  /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])t(2[0-3]|[01]\d|\d):([0-5]\d|\d):(6[01]|[0-5]\d|\d)z$/i;

function strptimeOk(ts: unknown): ts is string {
  if (typeof ts !== 'string') return false;
  const m = TS_RE.exec(ts);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1) return false;
  const dim = new Date(Date.UTC(2000, mo, 0)).getUTCDate(); // số ngày tháng mo (năm nhuận 2000)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return d <= (mo === 2 && !leap ? 28 : dim);
}

const REPLACE = new TextDecoder('utf-8', { ignoreBOM: true });

/** Python `bytes.split(b"\n")` bỏ phần rỗng. */
function lines(raw: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i <= raw.length) {
    let j = raw.indexOf(0x0a, i);
    if (j === -1) j = raw.length;
    if (j > i) out.push(raw.subarray(i, j));
    i = j + 1;
  }
  return out;
}

function parseLine(line: Buffer): unknown {
  try {
    return JSON.parse(REPLACE.decode(line));
  } catch {
    return undefined;
  }
}

/**
 * Viết lại `path` bỏ dòng không chứng minh được tuổi: parse lỗi / thiếu ts / ts sai format /
 * quá RETAIN_DAYS / tương lai xa hơn +1 ngày (slack lệch giờ). Đọc/ghi bytes (byte lỗi, U+2028
 * không cắt đôi record); ghi tmp + rename (crash giữa chừng không mất file).
 */
export function purgeConvlog(path: string, nowS: number = clock.wall()): void {
  if (!existsSync(path)) return;
  const cutoff = fmtTs(nowS - RETAIN_DAYS * 86400);
  const horizon = fmtTs(nowS + 86400);
  const kept: Buffer[] = [];
  for (const line of lines(readFileSync(path))) {
    const obj = parseLine(line);
    const ts = isPlainObject(obj) ? obj.ts : undefined;
    if (!strptimeOk(ts)) continue; // corrupt/thiếu ts/sai format → bỏ
    if (ts < cutoff || ts > horizon) continue; // quá hạn / tương lai xa → bỏ
    kept.push(line);
  }
  const tmp = join(dirname(path), `${basename(path)}.tmp`);
  const nl = Buffer.from('\n');
  writeFileSync(
    tmp,
    kept.length ? Buffer.concat([...kept.flatMap((k) => [k, nl])]) : Buffer.alloc(0),
  );
  renameSync(tmp, path);
}

/** Queue câu chưa trả lời (D6.2): `.1` (cũ hơn) rồi file chính, mọi dòng `answered === false`. */
export function unanswered(convLog: string): Entry[] {
  const out: Entry[] = [];
  for (const p of [`${convLog}.1`, convLog]) {
    if (!existsSync(p)) continue;
    for (const line of lines(readFileSync(p))) {
      const e = parseLine(line);
      if (isPlainObject(e) && e.answered === false) out.push(e);
    }
  }
  return out;
}

const EVIDENCE_KEYS = ['channel', 'msg_id', 'ts', 'answered', 'sent', 'guardrail_ok', 'provenance'];

export class ConvLog {
  /** Lần purge THÀNH CÔNG gần nhất / lần attempt gần nhất — monotonic, -Inf = chưa từng. */
  lastPurge = Number.NEGATIVE_INFINITY;
  lastPurgeAttempt = Number.NEGATIVE_INFINITY;
  maxBytes = CONV_LOG_MAX;
  purge: (path: string) => void = (p) => purgeConvlog(p);

  constructor(
    readonly path: string,
    private readonly pool: () => Pool | null,
  ) {}

  /** Retention theo tuổi mỗi lần boot (D5.11); lỗi chỉ warn — lần ghi sau thử lại. Thành công
   * → đánh dấu lastPurge (lần ghi đầu sau boot không purge lại O(file)). */
  bootPurge(): void {
    try {
      this.purge(this.path);
      this.lastPurge = clock.mono();
    } catch (e) {
      console.log(`[warn] zalo: purge convlog lúc boot lỗi ${(e as Error).name}`);
    }
  }

  /**
   * Ghi 1 dòng; purge file chính tối đa 1 lần/ngày (fail → retry sau PURGE_RETRY_S, chỉ warn);
   * vượt cap → rotate sang `.1` rồi purge `.1`. Sau khi ghi → bằng chứng DB (DB lỗi chỉ warn).
   */
  async log(entry: Entry): Promise<void> {
    // Dòng thiếu provenance (caller quên) hoặc đang ép mẫu → mẫu; KHÔNG bao giờ tự thành "live".
    let e = entry;
    if (convSettings.convSample || !['live', 'demo'].includes(e.provenance as string)) {
      e = { ...e, ...provenance(null) };
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const line = `${JSON.stringify(e)}\n`;
    const now = clock.mono();
    if (now - this.lastPurge > 86400 && now - this.lastPurgeAttempt >= PURGE_RETRY_S) {
      this.lastPurgeAttempt = now;
      try {
        this.purge(this.path);
        this.lastPurge = now;
      } catch (err) {
        console.log(`[warn] zalo: purge convlog lỗi ${(err as Error).name}`);
      }
    }
    if (existsSync(this.path) && statSync(this.path).size > this.maxBytes) {
      const bak = `${this.path}.1`;
      if (existsSync(bak)) unlinkSync(bak);
      renameSync(this.path, bak);
      try {
        this.purge(bak);
      } catch (err) {
        console.log(`[warn] zalo: purge convlog backup lỗi ${(err as Error).name}`);
      }
    }
    appendFileSync(this.path, line, 'utf8');
    await this.recordEvidence(e);
  }

  /**
   * docx P0 (PL02 mục 1a): câu bot ĐÃ gửi khách thật (đúng điều kiện bộ đếm `convRow`) → bằng
   * chứng DB `file_output_evidence_chat` (login svc_webhook; DB tự kiểm + chỉ lưu khóa/cờ).
   * Gọi SAU khi đã gửi + ghi convlog: DB down/từ chối chỉ warn — khách không câm.
   */
  async recordEvidence(entry: Entry): Promise<void> {
    const got = convRow(entry);
    if (!Array.isArray(got) || got[0] === 'legacy') return;
    const rec = JSON.stringify(Object.fromEntries(EVIDENCE_KEYS.map((k) => [k, entry[k] ?? null])));
    const pool = this.pool();
    if (pool === null) {
      console.log('[warn] zalo: không ghi được bằng chứng đầu ra (DB down)');
      return;
    }
    try {
      await pool.query('select file_output_evidence_chat($1)', [rec]);
    } catch (err) {
      console.log(`[warn] zalo: bằng chứng đầu ra bị từ chối (${pgErrName(err)})`);
    }
  }
}
