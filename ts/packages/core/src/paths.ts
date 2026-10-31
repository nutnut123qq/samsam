import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ts/packages/core/src → gốc repo (data/, docs/, scripts/ dùng chung với bản Python).
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const DOCS_DIR = join(REPO_ROOT, 'docs');

/** Đường dẫn trong gốc repo; từ chối tuyệt đối / thoát ra ngoài (`..`). */
export function repoPath(...parts: string[]): string {
  return inside(REPO_ROOT, parts);
}

/** Đường dẫn trong `data/` (cấu hình nghiệp vụ dùng chung với Python). */
export function dataPath(...parts: string[]): string {
  return inside(DATA_DIR, parts);
}

function inside(base: string, parts: string[]): string {
  const p = resolve(base, ...parts);
  const rel = relative(base, p);
  if (parts.some((s) => isAbsolute(s)) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`đường dẫn ngoài ${base}: ${parts.join('/')}`);
  }
  return p;
}
