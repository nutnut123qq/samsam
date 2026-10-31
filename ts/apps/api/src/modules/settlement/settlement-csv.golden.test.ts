import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type ChannelFees,
  type Dec,
  decCmp,
  decFrom,
  loadFees,
  loadMapping,
  lockBuckets,
  lockKey,
  type MoneyRow,
  mapHeader,
  orderHash,
  readSettlement,
  reconcileRow,
  roundHalfUp,
  toDate,
  toSigned,
} from './settlement-csv.js';

// Golden sinh bằng chạy `ingest/settlement_csv.py` THẬT (script ngoài repo, xem BAN_GIAO/CONVENTIONS):
// TS phải ra y hệt. Khác biệt CÓ CHỦ ĐÍCH liệt kê ở TS_DIFF.
type J = Record<string, unknown>;
const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/settlement-csv.golden.json', import.meta.url), 'utf8'),
) as J;
const TMP = mkdtempSync(join(tmpdir(), 'settle-csv-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Khác biệt có chủ đích: lỗi đọc XLSX mang tên lỗi của exceljs (Python: tên lỗi zip/xml của openpyxl)
// — cùng tiền tố, cùng fail-closed (0 dòng).
const TS_DIFF = new Set(['bad.xlsx']);

/** Giá trị Python đã chuyển JSON (`{"$dec": "0.04"}` → Dec). */
function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const o = v as J;
    if (typeof o.$dec === 'string') return decFrom(o.$dec);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
  }
  return v;
}

const decEq = (a: Dec, b: Dec) => decCmp(a, b) === 0;

describe('settlement-csv golden', () => {
  it('toSigned', () => {
    for (const [s, want] of G.to_signed as [string | null, number | null][]) {
      expect(toSigned(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('toDate', () => {
    for (const [s, want] of G.to_date as [string | null, string | null][]) {
      expect(toDate(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('orderHash', () => {
    for (const [c, o, want] of G.order_hash as string[][]) {
      expect(orderHash(c as string, o as string)).toBe(want);
    }
  });

  it('mapHeader', () => {
    for (const [h, r, o, d, ctx, want] of G.map_header as [
      (string | null)[],
      Record<string, string>,
      Record<string, string>,
      string[],
      string,
      [Record<string, number>, string[]],
    ][]) {
      expect(mapHeader(h, r, o, d, ctx), JSON.stringify(h)).toEqual(want);
    }
  });

  it('readSettlement — file thật/biến thể (CSV + XLSX)', async () => {
    const maps: Record<string, unknown> = { base: loadMapping()[0], txn: G.map_txn };
    for (const c of G.read_settlement as J[]) {
      const p = join(TMP, c.name as string);
      writeFileSync(p, Buffer.from(c.b64 as string, 'base64'));
      const [rows, errs, sha] = await readSettlement(p, c.channel as string, maps[c.map as string]);
      expect(sha, c.name as string).toBe(c.sha);
      expect(rows, c.name as string).toEqual(c.rows);
      if (TS_DIFF.has(c.name as string)) {
        expect(errs.length).toBe((c.errs as string[]).length);
        expect(errs[0]).toMatch(/^không đọc được XLSX: /);
      } else expect(errs, c.name as string).toEqual(c.errs);
    }
  });

  it('readSettlement — mapping thiếu kênh', async () => {
    const fx = join(TMP, 'fixture.csv');
    const maps = [{}, { shopee: {} }, { shopee: { required: [] } }, null];
    const want = G.read_settlement_badmap as unknown[][];
    for (let i = 0; i < maps.length; i++) {
      expect(await readSettlement(fx, 'shopee', maps[i])).toEqual(want[i]);
    }
  });

  it('loadMapping', () => {
    for (const [b64, [m, why]] of G.load_mapping as [string, [unknown, string | null]][]) {
      const p = join(TMP, 'settlement_map.json');
      writeFileSync(p, Buffer.from(b64, 'base64'));
      expect(loadMapping(p), b64.slice(0, 40)).toEqual([m, why]);
    }
  });

  it('loadFees (pct = Decimal giữ đúng giá trị)', () => {
    for (const [b64, [f, why]] of G.load_fees as [string, [J | null, string | null]][]) {
      const p = join(TMP, 'settlement_fees.json');
      writeFileSync(p, Buffer.from(b64, 'base64'));
      const [got, gwhy] = loadFees(p);
      expect(gwhy).toBe(why);
      if (f === null) {
        expect(got).toBeNull();
        continue;
      }
      const want = revive(f) as Record<string, ChannelFees>;
      for (const ch of Object.keys(want)) {
        const a = got?.[ch] as ChannelFees;
        const b = want[ch] as ChannelFees;
        expect(a.tolerance_vnd).toBe(b.tolerance_vnd);
        for (const k of ['fixed_fee_pct', 'payment_fee_pct', 'service_fee_pct'] as const) {
          expect(decEq(a[k], b[k]), `${ch}.${k}`).toBe(true);
        }
      }
    }
  });

  it('reconcileRow (ROUND_HALF_UP, biên tolerance, ưu tiên nhãn)', () => {
    for (const [row, amt, fees, want] of G.reconcile_row as [
      MoneyRow,
      number | null,
      J,
      [string, J[], number],
    ][]) {
      const [label, reasons, expected] = reconcileRow(row, amt, revive(fees) as ChannelFees);
      expect(label).toBe(want[0]);
      expect(expected).toBe(BigInt(want[2]));
      expect(
        reasons.map((r) => ({
          code: r.code,
          expected: Number(r.expected),
          actual: Number(r.actual),
        })),
      ).toEqual(want[1]);
    }
  });

  it('roundHalfUp', () => {
    for (const [s, want] of G.round_half_up as [string, number][]) {
      const d = decFrom(s) as Dec;
      expect(roundHalfUp(d.n, 10n ** BigInt(d.k)), s).toBe(BigInt(want));
    }
  });

  it('lockKey + ngăn khóa (cùng khóa advisory với Python — loại trừ chéo CSV ↔ API)', () => {
    for (const [c, b, want] of G.lock_key as [string, number, string][]) {
      expect(lockKey(c, b)).toBe(BigInt(want));
    }
    const lb = G.lock_buckets as { hashes: string[]; buckets: number[] };
    expect(lockBuckets(lb.hashes)).toEqual(lb.buckets);
  });
});
