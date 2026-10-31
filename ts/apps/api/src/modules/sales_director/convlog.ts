import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pyStrip } from '@samsam/core/security/py';

// Phần `ingest/lead_store.py` mà sales_director dùng (đọc convlog `data/conversations.jsonl`):
// `CONV_FILES`, `channel_of`, `dedup_key`, `_parse_ts`, `conv_kind`, `iter_convlog(live_only)`.
// shortcut: bản riêng của nhóm sales_director (lead_store chưa port — rag/kb-gaps cũng có bản
// riêng), khi nhóm lead_store port xong thì import dùng chung.
// File user-influenced → đọc BYTES + split `\n` tường minh (không splitlines — U+2028 cắt đôi
// record), decode thay byte lỗi, không ném.

export const CONV_FILES = ['conversations.jsonl', 'conversations.jsonl.1'];
export const CHAT_CHANNELS = ['zalo', 'messenger'];
// docx P1 (PL02 mục 3): cờ mẫu trên dòng convlog.
export const SAMPLE_FLAGS = ['is_sample', 'dry_run', 'replay', 'mock', 'test'];

export type Rec = Record<string, unknown>;
export type ConvStats = Record<string, number>;

/** v5.1: key `channel` zalo/messenger → dùng nguyên; còn lại suy từ msg_id (streamlit ghi ""). */
export function channelOf(rec: Rec): string {
  if (typeof rec.channel === 'string' && CHAT_CHANNELS.includes(rec.channel)) return rec.channel;
  const m = rec.msg_id;
  return typeof m === 'string' && pyStrip(m) ? 'zalo' : 'streamlit';
}

export function dedupKey(rec: Rec): string {
  const m = rec.msg_id;
  if (typeof m === 'string' && pyStrip(m)) return `convlog:${pyStrip(m)}`;
  const raw = [rec.ts, rec.user_hash, rec.question]
    .map((p) => (typeof p === 'string' ? p : ''))
    .join('|');
  return `convlog:${createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

// `datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ")`: mẫu `_strptime` của Python 3.12 (IGNORECASE,
// `\d` Unicode — int() nhận chữ số Unicode), rồi datetime() kiểm ngày có thật / giây ≤ 59.
const D = '\\p{Nd}';
const TS_RE = new RegExp(
  `^(${D}${D}${D}${D})-(1[0-2]|0[1-9]|[1-9])-(3[0-1]|[1-2]${D}|0[1-9]|[1-9]| [1-9])[Tt]` +
    `(2[0-3]|[0-1]${D}|${D}):([0-5]${D}|${D}):(6[0-1]|[0-5]${D}|${D})[Zz]$`,
  'u',
);
const ND = /\p{Nd}/u;

/** Giá trị của chữ số Unicode (Nd): mỗi dải Nd liên tiếp bắt đầu bằng chữ số 0. */
function digitVal(c: string): number {
  let cp = c.codePointAt(0) ?? 0;
  const self = cp;
  while (ND.test(String.fromCodePoint(cp - 1))) cp--;
  return (self - cp) % 10;
}

const toInt = (s: string) => Array.from(s).reduce((n, c) => n * 10 + digitVal(c), 0);

/** ISO 'YYYY-MM-DDTHH:MM:SSZ' → Date | null khi sai format / không phải chuỗi. */
export function parseTs(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const m = TS_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => toInt(pyStrip(x)));
  if (y < 1 || s > 59) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  t.setUTCHours(h, mi, s, 0);
  return t;
}

const notSet = (v: unknown) => v === undefined || v === null || v === false || v === 0;

/** 'live' (câu thật qua transport kênh thật) | 'thu_nghiem' (mẫu/mock/replay/demo) |
 * 'thieu_provenance' (dòng cũ trước v15 fix P8.1 — KHÔNG suy ngược). */
export function convKind(rec: Rec): string {
  if (!Object.hasOwn(rec, 'provenance')) return 'thieu_provenance';
  // Python `rec.get(k) not in (None, False)`: 0 == False nên 0/0.0 cũng là "không đặt".
  if (rec.provenance !== 'live' || SAMPLE_FLAGS.some((k) => !notSet(rec[k]))) return 'thu_nghiem';
  return 'live';
}

const ASCII_WS = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g; // bytes.strip()

/** Record dict từ convlog. Skip + đếm: file không đọc được (`io_error`), dòng JSON hỏng / không
 * phải object (`corrupt`), `_doc`; `liveOnly` → chỉ dòng 'live' (còn lại đếm theo loại).
 * shortcut: JSON.parse từ chối `NaN`/`Infinity` (Python nhận) → dòng đó tính `corrupt`; writer
 * convlog không ghi số thực nên chưa gặp — nâng khi có field số. */
export function iterConvlog(path: string, stats: ConvStats, liveOnly = false): Rec[] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    stats.io_error = (stats.io_error ?? 0) + 1;
    return [];
  }
  const dec = new TextDecoder('utf-8', { ignoreBOM: true }); // giữ BOM như Python decode()
  const out: Rec[] = [];
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0x0a, start);
    if (end < 0) end = raw.length;
    const line = dec.decode(raw.subarray(start, end)).replace(ASCII_WS, '');
    start = end + 1;
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      stats.corrupt = (stats.corrupt ?? 0) + 1;
      continue;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      stats.corrupt = (stats.corrupt ?? 0) + 1;
      continue;
    }
    if (Object.hasOwn(rec, '_doc')) {
      stats.doc = (stats.doc ?? 0) + 1;
      continue;
    }
    if (liveOnly) {
      const k = convKind(rec as Rec);
      if (k !== 'live') {
        stats[k] = (stats[k] ?? 0) + 1;
        continue;
      }
    }
    out.push(rec as Rec);
  }
  return out;
}
