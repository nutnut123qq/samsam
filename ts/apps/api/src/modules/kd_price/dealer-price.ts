import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Db } from '@samsam/core/ops/deps';
import { isPrintable } from '@samsam/core/ops/py';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { pyOsName } from '@samsam/core/ops/py-json';
import { withTx } from '@samsam/core/ops/tx';
import { PII_RE } from '@samsam/core/security/pii';
import { casefold, cpLen, isSpace, pyStrip, search } from '@samsam/core/security/py';
import { type Day, pyDate, toInt } from './deps.js';
import { hostname, urlSplit } from './kd-price.js';

// Port `ingest/dealer_price.py` (v14.4 sales-06.1, PL01 "Phát hiện lệch giá, đại lý phá giá") — nạp
// file giá ĐẠI LÝ quan sát tay → `dealer_price_obs` (append-only). Nguồn giá đại lý TỰ ĐỘNG chưa có
// (blocker, Bên B cấp) → NGƯỜI quan sát ghi CSV `kenh,ma_dai_ly,sku_key,gia_vnd,ngay,url_nguon`.
// Kiểm TOÀN file TRƯỚC khi connect; lỗi chỉ nêu số dòng + tên cột, KHÔNG in giá trị ô. Không PII (mã
// đại lý, không tên người), không request mạng, không đổi giá.

export const COLS = ['kenh', 'ma_dai_ly', 'sku_key', 'gia_vnd', 'ngay', 'url_nguon'];
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_URL = 500;
export const MAX_PRINT_ERRS = 30;
const DEALER_RE = /^[A-Z0-9_-]{2,20}$/;
const SKU_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DealerRow = {
  row_no: number;
  channel: string;
  dealer_code: string;
  sku_key: string;
  price_vnd: number;
  observed_on: Day;
  source_url: string;
};

/** https, có host, ≤ 500 ký tự, không khoảng trắng/ký tự điều khiển, không SĐT/email. */
export function urlOk(url: string): boolean {
  const sp = urlSplit(url);
  if (sp === null || sp[0] !== 'https' || !hostname(sp[1])) return false;
  return (
    cpLen(url) <= MAX_URL &&
    ![...url].some((c) => isSpace(c) || !isPrintable(c)) &&
    search(PII_RE, url) === null
  );
}

/** THUẦN (không DB) → [rows, errs, sha256]. errs ≠ [] → rows = []. */
export function readDealerFile(
  path: string,
  channels: readonly string[],
  maxRows: number,
  today: Day,
): [DealerRow[], string[], string | null] {
  let data: Buffer;
  try {
    if (statSync(path).size > MAX_BYTES) return [[], [`file > ${MAX_BYTES / 2 ** 20}MB`], null];
    data = readFileSync(path);
  } catch (e) {
    return [[], [`không đọc được file: ${pyOsName(e)}`], null];
  }
  const sha = createHash('sha256').update(data).digest('hex');
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const bad = utf8ErrorStart(bom ? data.subarray(3) : data);
  if (bad >= 0) return [[], [`file không phải UTF-8 (byte ${bad})`], sha];
  const text = new TextDecoder('utf-8').decode(data); // bỏ BOM = utf-8-sig
  const table: [number, string[]][] = [];
  try {
    let i = 0;
    for (const r of new CsvReader(text)) {
      i++;
      if (!r.some((c) => pyStrip(c))) continue;
      if (table.length > maxRows) return [[], [`file > ${maxRows} dòng — tách file`], sha];
      table.push([i, r]);
    }
  } catch (e) {
    if (e instanceof CsvError) return [[], ['CSV hỏng (ngoặc kép/ký tự lạ)'], sha];
    throw e;
  }
  if (!table.length) return [[], ['file rỗng'], sha];
  const [[, header], ...body] = table as [[number, string[]], ...[number, string[]][]];
  const hdr = header.map((h) => pyStrip(h ?? ''));
  if (JSON.stringify([...hdr].sort()) !== JSON.stringify([...COLS].sort())) {
    return [[], [`header phải đúng các cột: ${COLS.join(', ')} (không thiếu/thừa/trùng)`], sha];
  }
  const col = new Map(hdr.map((h, j) => [h, j]));
  if (!body.length) return [[], ['file chỉ có header, không có dòng dữ liệu'], sha];
  const rows: DealerRow[] = [];
  const keys = new Map<string, number>();
  const errs: string[] = [];
  for (const [no, cells] of body) {
    if (cells.slice(hdr.length).some((c) => pyStrip(c))) {
      errs.push(`dòng ${no}: thừa ô ngoài header`);
      continue;
    }
    const v: Record<string, string | null> = {};
    for (const [k, j] of col) v[k] = (j < cells.length ? pyStrip(cells[j] as string) : '') || null;
    const bad: string[] = [];
    if (!channels.includes(v.kenh as string)) bad.push('kenh');
    if (!(v.ma_dai_ly && DEALER_RE.test(v.ma_dai_ly))) bad.push('ma_dai_ly');
    if (!(v.sku_key && SKU_RE.test(v.sku_key) && cpLen(v.sku_key) <= 64)) bad.push('sku_key');
    const price = toInt(v.gia_vnd, 10 ** 12);
    if (!price) bad.push('gia_vnd (số nguyên > 0)');
    const day = pyDate(v.ngay);
    if (day === null || day > today) bad.push('ngay (YYYY-MM-DD, không ở tương lai)');
    const url = v.url_nguon ?? '';
    if (!urlOk(url)) bad.push('url_nguon (https://, ≤ 500 ký tự, không SĐT/email)');
    if (bad.length) {
      errs.push(`dòng ${no}: cột ${bad.join(', ')} không hợp lệ`);
      continue;
    }
    const k = [v.kenh, v.ma_dai_ly, v.sku_key, day].join('\0');
    const prev = keys.get(k);
    if (prev !== undefined) {
      errs.push(`dòng ${no}: trùng (kênh, đại lý, SKU, ngày) với dòng ${prev}`);
      continue;
    }
    keys.set(k, no);
    rows.push({
      row_no: no,
      channel: v.kenh as string,
      dealer_code: v.ma_dai_ly as string,
      sku_key: v.sku_key as string,
      price_vnd: price as number,
      observed_on: day as Day,
      source_url: url,
    });
  }
  return errs.length ? [[], errs, sha] : [rows, [], sha];
}

/** Ghi quan sát (1 giao dịch) → {inserted, skipped_file}. File đã nạp (sha256) → skip; mã đại lý/SKU
 * không có trong sổ → RangeError nêu số dòng, KHÔNG ghi dòng nào. `--by` phải là NGƯỜI. */
export async function loadDealerObs(
  db: Db,
  rows: DealerRow[],
  sha: string,
  by: unknown,
  source = 'manual_export',
): Promise<{ inserted: number; skipped_file: boolean }> {
  const who = typeof by === 'string' ? pyStrip(by) : '';
  const f = casefold(who);
  if (
    !who ||
    cpLen(who) > 100 ||
    !isPrintable(who) ||
    f.startsWith('agent:') ||
    f.startsWith('system:')
  ) {
    throw new RangeError('--by phải là tên NGƯỜI quan sát/nhập file');
  }
  if (source !== 'manual_export' && source !== 'sample')
    throw new RangeError('source phải là manual_export|sample');
  if (
    (await db.query('select 1 from dealer_price_obs where file_sha256 = $1 limit 1', [sha])).rows
      .length
  ) {
    return { inserted: 0, skipped_file: true };
  }
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const dealers = new Set(
    (
      await db.query('select code from dealers where code = any($1::text[])', [
        uniq(rows.map((r) => r.dealer_code)),
      ])
    ).rows.map((r) => r.code as string),
  );
  const skus = new Set(
    (
      await db.query('select sku_key from sku_master where sku_key = any($1::text[])', [
        uniq(rows.map((r) => r.sku_key)),
      ])
    ).rows.map((r) => r.sku_key as string),
  );
  const bad = rows
    .filter((r) => !dealers.has(r.dealer_code) || !skus.has(r.sku_key))
    .map(
      (r) =>
        `dòng ${r.row_no}: ${[
          ['ma_dai_ly không có trong sổ đại lý', dealers.has(r.dealer_code)],
          ['sku_key không có trong golden', skus.has(r.sku_key)],
        ]
          .filter(([, ok]) => !ok)
          .map(([n]) => n)
          .join(', ')}`,
    );
  if (bad.length) {
    throw new RangeError(
      bad.slice(0, MAX_PRINT_ERRS).join('; ') +
        (bad.length > MAX_PRINT_ERRS ? ` … (+${bad.length - MAX_PRINT_ERRS})` : ''),
    );
  }
  const n = await withTx(db, async (c) => {
    let k = 0;
    for (const r of rows) {
      const res = await c.query(
        'insert into dealer_price_obs (file_sha256, row_no, channel, dealer_code, sku_key, price_vnd, observed_on, source_url, source, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (file_sha256, row_no) do nothing',
        [
          sha,
          r.row_no,
          r.channel,
          r.dealer_code,
          r.sku_key,
          r.price_vnd,
          r.observed_on,
          r.source_url,
          source,
          who,
        ],
      );
      k += res.rowCount ?? 0;
    }
    return k;
  });
  return { inserted: n, skipped_file: false };
}
