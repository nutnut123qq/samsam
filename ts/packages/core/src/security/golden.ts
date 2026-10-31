import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

// Tiện ích cho test golden của security/ (fixture sinh bằng hàm Python thật — xem __fixtures__).

/** Đầu vào lớn được lưu gzip+base64 (`{"gz": ...}`). */
export function decodeArg(a: unknown): unknown {
  if (a && typeof a === 'object' && !Array.isArray(a) && 'gz' in a) {
    return gunzipSync(Buffer.from(String((a as { gz: string }).gz), 'base64')).toString('utf8');
  }
  return a;
}

/** Python `json.dumps(o, ensure_ascii=False, sort_keys=True)` (dấu phân cách ', ' và ': '). */
export function pyDumps(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pyDumps((v as Record<string, unknown>)[k])}`).join(', ')}}`;
  }
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}

/** Đầu ra lớn được lưu dạng `{"sha": sha256(pyDumps(out))}`. */
export function sameAsGolden(got: unknown, want: unknown): boolean {
  if (want && typeof want === 'object' && !Array.isArray(want) && 'sha' in want) {
    const sha = createHash('sha256').update(pyDumps(got), 'utf8').digest('hex');
    return sha === (want as { sha: string }).sha;
  }
  return pyDumps(got) === pyDumps(want);
}
