import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ZodType } from 'zod';
import { dataPath } from './paths.js';

/** Cấu hình thiếu/hỏng/sai schema — caller phải chặn (fail-closed), không đoán mặc định. */
export class ConfigError extends Error {}

type Entry = { mtimeMs: number; size: number; value: unknown };
const cache = new Map<string, Entry>();

/**
 * Đọc JSON như Python `json.loads(p.read_bytes().decode("utf-8"))`: UTF-8 strict, BOM = hỏng.
 * Cache theo (mtime, size) — người vận hành sửa file thì lần đọc sau thấy bản mới (Python đọc lại mỗi lần).
 * `schema` (zod) sai → ConfigError. Giá trị trả về bị đóng băng: caller không sửa được bản cache.
 */
export function readJsonFile<T = unknown>(file: string, schema?: ZodType<T>): T {
  const name = basename(file);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    throw new ConfigError(`không có file ${name}`);
  }
  const hit = cache.get(file);
  let value: unknown;
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    value = hit.value;
  } else {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readFileSync(file),
      );
      value = deepFreeze(JSON.parse(text));
    } catch (e) {
      cache.delete(file);
      throw new ConfigError(`${name} hỏng: ${(e as Error).name}`);
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  }
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ConfigError(`${name} sai cấu trúc: ${r.error.issues[0]?.message ?? 'không rõ'}`);
  }
  return r.data;
}

/** `data/<rel>` của repo (vd `loadData('directors/sales.json')`). */
export function loadData<T = unknown>(rel: string, schema?: ZodType<T>): T {
  return readJsonFile(dataPath(rel), schema);
}

export function clearConfigCache(): void {
  cache.clear();
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
