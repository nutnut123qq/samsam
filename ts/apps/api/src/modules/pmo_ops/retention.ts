import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PyFloat, parsePyJson } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyStr, pyTruthy } from '@samsam/core/security/py';
import { decodeJsonBytes, PyFileError, pyOsName } from './py.js';

// Phần `scripts/retention_purge.py` mà bản tin sức khỏe dùng (`load_config` + `status_lines`, KHÔNG
// xóa gì, không DB). shortcut: bản riêng của nhóm pmo_ops (retention_purge chưa port) — khi nhóm
// ops_scripts port job xóa thì dùng chung bản của họ.

export const RETENTION_FILE = dataPath('retention.json');
export const KINDS = ['thu_muc', 'garden_media', 'garden_voice', 'khong_luu_ban_sao'];

export class RetentionError extends Error {
  override name = 'RetentionError';
}

export type RetentionItem = Record<string, unknown> & {
  id: string;
  ttl_days: number | null;
  kho: Record<string, unknown>;
};

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);

/** → danh sách mục đã kiểm. Hỏng → RetentionError. */
export function loadConfig(path: string = RETENTION_FILE): RetentionItem[] {
  let obj: unknown;
  try {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (e) {
      throw new PyFileError(pyOsName(e));
    }
    try {
      obj = parsePyJson(decodeJsonBytes(raw));
    } catch (e) {
      if (e instanceof PyFileError) throw e;
      throw new PyFileError('JSONDecodeError');
    }
  } catch (e) {
    throw new RetentionError(`không đọc được ${basename(path)} (${(e as PyFileError).pyType})`);
  }
  const items = isDict(obj) ? obj.muc : null;
  if (!Array.isArray(items) || !items.length) throw new RetentionError("thiếu mảng 'muc'");
  const seen = new Set<string>();
  items.forEach((it, i) => {
    if (!isDict(it)) throw new RetentionError(`muc[${i}] sai dạng`);
    const { id: iid, ttl_days: ttl, kho } = it;
    if (typeof iid !== 'string' || !iid || seen.has(iid)) {
      throw new RetentionError(`muc[${i}] id rỗng/trùng`);
    }
    seen.add(iid);
    // bool là int trong Python — True không được thành 1 ngày; 1.0 (float) cũng sai.
    if (
      ttl !== null &&
      ttl !== undefined &&
      !(typeof ttl === 'number' && Number.isInteger(ttl) && ttl >= 1)
    ) {
      throw new RetentionError(`${iid}: ttl_days phải null hoặc số nguyên ≥ 1`);
    }
    if (!isDict(kho) || !KINDS.includes(kho.loai as string)) {
      throw new RetentionError(
        `${iid}: kho.loai phải thuộc (${KINDS.map((k) => `'${k}'`).join(', ')})`,
      );
    }
    if (kho.loai !== 'khong_luu_ban_sao' && !pyTruthy(kho.env)) {
      throw new RetentionError(`${iid}: thiếu kho.env`);
    }
    if (kho.loai === 'thu_muc' && !(Array.isArray(kho.duoi) && kho.duoi.length)) {
      throw new RetentionError(`${iid}: thiếu kho.duoi`);
    }
  });
  return items as RetentionItem[];
}

/** Dòng tình trạng cho bản tin sức khỏe (không DB). */
export function statusLines(items: readonly RetentionItem[]): string[] {
  return items.map((it) => {
    const name = `\`${it.id}\` (${Object.hasOwn(it, 'ten') ? pyStr(it.ten) : ''})`;
    const ttl = it.ttl_days ?? null;
    if (ttl === null) {
      const owner = pyTruthy(it.owner) ? pyStr(it.owner) : 'chưa rõ';
      return `- CẢNH BÁO ${name}: CHƯA CHỐT hạn lưu — job không xóa gì; người chốt: ${owner} (điền số ngày trong \`data/retention.json\`)`;
    }
    if (it.kho.loai === 'khong_luu_ban_sao') {
      return `- ${name}: hạn ${ttl} ngày — hệ thống không giữ bản sao file, không có gì để xóa`;
    }
    return `- ${name}: giữ ${ttl} ngày — job \`python scripts/retention_purge.py\``;
  });
}
