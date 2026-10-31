import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import {
  activeWindows,
  type BgRecord,
  type Calendar,
  FreezeConfigError,
  isFrozen,
  loadBreakGlass,
  loadCalendar,
} from '@samsam/core/ops/freeze';
import { vnFormat } from '@samsam/core/ops/period';
import { isPrintable, pyInt } from '@samsam/core/ops/py';
import { pyDumps } from '@samsam/core/rollout/counters';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, cpLen, pyStr } from '@samsam/core/security/py';
import { fmtG, insideRepo, privateUmask, pyResolve, vnIso, vnNow } from './common.js';

// Port `scripts/break_glass.py` (v3.10) — mở cửa sổ ngoại lệ CÓ HẠN trong đóng băng 21/12–10/02.
// Đúng 1 thao tác mỗi lần: `--open --reason --by [--hours 1..4]` · `--status` · `--close --reason
// --by`. Bắt buộc lý do (≥10 ký tự, che SĐT/email trước khi ghi) + người chịu trách nhiệm, tối đa
// `break_glass_max_hours` (`data/freeze_calendar.json`), tự hết hạn. Log `BREAK_GLASS_LOG` (BẮT BUỘC,
// NGOÀI repo) append-only: chỉ thêm dòng JSON, không sửa/xóa dòng cũ. `break_glass_holders` rỗng =
// công ty chưa cấp (external-dep) → vẫn mở nhưng cảnh báo + `holder_verified=false`; có danh sách mà
// `--by` không thuộc → từ chối. Exit: 0 OK; 1 lịch đóng băng lỗi; 2 usage.

export const MIN_REASON = 10;
export const MAX_BY = 80;
export const DEFAULT_HOURS = 2;
const HOUR_MS = 3600_000;

class Usage extends Error {
  override name = 'Usage';
}

const fmt = (d: Date) => vnFormat(d, '%H:%M %d/%m/%Y');

export function logPath(env: Env): string {
  const raw = pyStrip(env.BREAK_GLASS_LOG ?? '');
  if (!raw) throw new Usage('thiếu BREAK_GLASS_LOG (đường dẫn file log NGOÀI repo)');
  if (insideRepo(raw)) throw new Usage('BREAK_GLASS_LOG nằm trong repo — phải đặt NGOÀI repo');
  return pyResolve(raw);
}

/** [by, lý do đã che PII] | Usage. */
export function whoWhy(by: unknown, reason: unknown): [string, string] {
  const b = pyStrip(typeof by === 'string' ? by : '');
  if (!b || cpLen(b) > MAX_BY || !isPrintable(b)) {
    throw new Usage(`--by bắt buộc, 1..${MAX_BY} ký tự in được`);
  }
  const r = pyStrip(typeof reason === 'string' ? reason : '');
  if (cpLen(r) < MIN_REASON) throw new Usage(`--reason bắt buộc, ≥ ${MIN_REASON} ký tự`);
  return [b, maskPii(r)];
}

/** Append-only: dòng cuối bị ghi dở (thiếu `\n`) → xuống dòng trước — record mới không dính dòng hỏng. */
export function appendRecord(path: string, rec: Record<string, unknown>): void {
  let lead = '';
  try {
    const size = statSync(path).size;
    if (size) {
      const fd = openSync(path, 'r');
      try {
        const b = Buffer.alloc(1);
        readSync(fd, b, 0, 1, size - 1);
        lead = b[0] === 0x0a ? '' : '\n';
      } finally {
        closeSync(fd);
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  appendFileSync(path, Buffer.from(`${lead}${pyDumps(rec)}\n`, 'utf8'), { mode: 0o600 });
}

function records(path: string): BgRecord[] {
  const bad: number[] = [];
  const recs = loadBreakGlass(path, bad);
  if (bad.length) {
    console.log(`[warn] bỏ qua ${bad.length} dòng log hỏng: dòng ${bad.slice(0, 10).join(', ')}`);
  }
  return recs;
}

/** Python `_printable`: lý do đọc từ log (có thể bị sửa tay) → thay ký tự điều khiển/ANSI trước khi in. */
export function printable(v: unknown): string {
  return [...pyStr(v)].map((c) => (isPrintable(c) ? c : '?')).join('');
}

export type BreakGlassOpts = {
  open?: boolean;
  status?: boolean;
  close?: boolean;
  reason?: string;
  by?: string;
  hours?: string;
};

function doOpen(
  o: BreakGlassOpts,
  path: string,
  cal: Calendar,
  now: Date,
  hours: number | null,
): number {
  const [by, reason] = whoWhy(o.by, o.reason);
  const maxH = cal.break_glass_max_hours;
  const h = hours ?? DEFAULT_HOURS;
  if (!(h >= 1 && h <= maxH)) throw new Usage(`--hours phải trong 1..${fmtG(maxH)}`);
  const holders = new Set(cal.break_glass_holders.map((x) => casefold(pyStrip(x))));
  if (holders.size && !holders.has(casefold(by))) {
    throw new Usage(`'${by}' không thuộc danh sách người giữ quyền break-glass`);
  }
  const verified = holders.size > 0;
  if (!verified) {
    console.log(
      '[CẢNH BÁO] danh sách người giữ quyền break-glass chưa được công ty cấp (external-dep) — ghi holder_verified=false',
    );
  }
  if (!isFrozen(now, cal)) {
    console.log(
      '[warn] hiện KHÔNG trong khung đóng băng — break-glass không cần thiết (vẫn mở theo yêu cầu)',
    );
  }
  const expires = new Date(now.getTime() + h * HOUR_MS);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendRecord(path, {
    action: 'open',
    ts: vnIso(now),
    opened_at: vnIso(now),
    expires_at: vnIso(expires),
    hours: h,
    by,
    reason,
    holder_verified: verified,
  });
  console.log(
    `[CẢNH BÁO] BREAK-GLASS mở tới ${fmt(expires)} bởi ${by} — mọi thay đổi trong đóng băng được cho qua tới khi hết hạn`,
  );
  return 0;
}

function doClose(o: BreakGlassOpts, path: string, cal: Calendar, now: Date): number {
  const [by, reason] = whoWhy(o.by, o.reason);
  const active = activeWindows(records(path), now, cal.break_glass_max_hours);
  if (!active.length) {
    console.log('[info] không có cửa sổ break-glass nào còn hạn — không ghi');
    return 0;
  }
  appendRecord(path, { action: 'close', ts: vnIso(now), by, reason, closed: active.length });
  console.log(`[ok] đã đóng sớm ${active.length} cửa sổ break-glass (${by})`);
  return 0;
}

function doStatus(path: string, cal: Calendar, now: Date): number {
  const active = activeWindows(records(path), now, cal.break_glass_max_hours);
  const state = isFrozen(now, cal) ? 'ĐANG đóng băng' : 'ngoài khung đóng băng';
  console.log(`[status] ${fmt(now)} — ${state}; ${active.length} cửa sổ break-glass còn hạn`);
  for (const w of active) {
    const tag = w.holder_verified ? '' : ' (người CHƯA xác minh)';
    console.log(
      `  - mở ${fmt(w.opened_at)} → hết hạn ${fmt(w.expires_at)} bởi ${w.by}${tag}: ${printable(w.reason)}`,
    );
  }
  return 0;
}

/** Python `main(argv, now)` → exit code. Thứ tự kiểm như Python: cú pháp (đúng 1 thao tác, --hours
 * số nguyên) → BREAK_GLASS_LOG → `--hours` chỉ với `--open` → lịch đóng băng (lỗi → 1) → thao tác. */
export async function breakGlassMain(
  o: BreakGlassOpts,
  now?: Date,
  env: Env = process.env,
  calendarPath?: string,
): Promise<number> {
  return privateUmask(async () => {
    const ops = [o.open, o.status, o.close].filter(Boolean).length;
    if (ops !== 1) {
      console.error('[usage] cần đúng MỘT trong --open / --status / --close');
      return 2;
    }
    let hours: number | null = null;
    if (o.hours !== undefined) {
      const h = pyInt(o.hours);
      if (h === null) {
        console.error(`[usage] --hours: invalid int value: '${o.hours}'`);
        return 2;
      }
      hours = Number(h);
    }
    const t = now ?? vnNow();
    try {
      const path = logPath(env);
      if (!o.open && o.hours !== undefined) throw new Usage('--hours chỉ dùng với --open');
      let cal: Calendar;
      try {
        cal = loadCalendar(calendarPath);
      } catch (e) {
        if (!(e instanceof FreezeConfigError)) throw e;
        console.log(`[err] lịch đóng băng lỗi: ${e.message} — sửa data/freeze_calendar.json trước`);
        return 1;
      }
      if (o.open) return doOpen(o, path, cal, t, hours);
      if (o.close) return doClose(o, path, cal, t);
      return doStatus(path, cal, t);
    } catch (e) {
      if (!(e instanceof Usage)) throw e;
      console.log(`[usage] ${e.message}`);
      return 2;
    }
  });
}
