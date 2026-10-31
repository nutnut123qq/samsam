import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  channelFigures,
  type FeeCol,
  type Figures,
  fname,
  loadConfig,
  opsFee,
  pct,
  quarterRange,
  type RevCfg,
  type RevRow,
  renderQuarter,
  renderYear,
  summarize,
  type Tier,
  tierRows,
  yearRange,
} from './rev-share.js';
import { type Dec, decFrom, decStr, type Overlap, vnd } from './settlement-csv.js';

// Golden sinh bằng chạy `agents/rev_share.py` THẬT (cấu hình biến thể, kỳ quý/năm, số liệu, bản biên bản
// quý/năm đầy đủ). TS phải ra y hệt — kể cả từng ký tự của biên bản.
type J = Record<string, unknown>;
const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/rev-share.golden.json', import.meta.url), 'utf8'),
) as J;
const TMP = mkdtempSync(join(tmpdir(), 'rev-share-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const NOW = new Date(G.now as string);

const dec = (v: unknown): Dec | null =>
  v === null ? null : (decFrom((v as { $dec: string }).$dec) as Dec);
const decJ = (d: Dec | null) => (d === null ? null : { $dec: decStr(d) });

/** Dòng golden (số Python) → RevRow (bigint). */
function revRow(o: J): RevRow {
  const r: J = { channel: o.channel, file_name: o.file_name, status: o.status ?? null };
  for (const k of [
    'order_amount',
    'refund',
    'payout',
    'fixed_fee',
    'payment_fee',
    'service_fee',
    'shipping_fee',
    'voucher_seller',
    'affiliate',
  ]) {
    r[k] = BigInt(o[k] as number);
  }
  return r as RevRow;
}

const num = (v: bigint | null) => (v === null ? null : Number(v));
const figJ = (f: Figures | null) =>
  f === null
    ? null
    : {
        ...f,
        gross: num(f.gross),
        fee: num(f.fee),
        cancel: num(f.cancel),
        refund: num(f.refund),
        net: num(f.net),
        payout: num(f.payout),
      };

function cfgOf(over: J): RevCfg {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as J;
  const p = join(TMP, 'rev_share.json');
  writeFileSync(p, JSON.stringify({ ...raw, ...over }));
  return loadConfig(p);
}

describe('rev-share golden', () => {
  it('loadConfig (biến thể hợp lệ/hỏng → ConfigError cùng thông điệp)', () => {
    for (const c of G.load_config as J[]) {
      const p = join(TMP, 'rev_share.json');
      writeFileSync(p, Buffer.from(c.b64 as string, 'base64'));
      const res = c.res as J;
      const tag = Buffer.from(c.b64 as string, 'base64')
        .toString()
        .slice(-160);
      if ('ok' in res) {
        const want = res.ok as J;
        const got = loadConfig(p);
        expect(
          {
            ...got,
            rate: decJ(got.rate),
            tiers: got.tiers.map((t) => ({ ...t, ty_le: decJ(t.ty_le) })),
          },
          tag,
        ).toEqual({
          ...want,
          rate: decJ(dec(want.rate)),
          tiers: (want.tiers as J[]).map((t) => ({ ...t, ty_le: decJ(dec(t.ty_le)) })),
        });
      } else {
        expect(() => loadConfig(p), tag).toThrow(res.msg as string);
      }
    }
  });

  it('quarterRange / yearRange (đóng kỳ theo 00:00 giờ VN, cắt theo ngày vận hành, 29/02)', () => {
    for (const [label, now, start, res] of G.quarter_range as [
      unknown,
      string,
      string | null,
      J,
    ][]) {
      const tag = `${JSON.stringify(label)} ${now} ${start}`;
      if ('ok' in res) expect(quarterRange(label, new Date(now), start), tag).toEqual(res.ok);
      else expect(() => quarterRange(label, new Date(now), start), tag).toThrow(res.msg as string);
    }
    for (const [start, n, now, res] of G.year_range as [string, unknown, string, J][]) {
      const tag = `${start} ${JSON.stringify(n)} ${now}`;
      if ('ok' in res) expect(yearRange(start, n, new Date(now)), tag).toEqual(res.ok);
      else expect(() => yearRange(start, n, new Date(now)), tag).toThrow(res.msg as string);
    }
  });

  it('channelFigures + fname (che PII/ký tự điều khiển trong tên file)', () => {
    for (const [rows, fc, want] of G.channel_figures as [J[], FeeCol[], J][]) {
      expect(figJ(channelFigures(rows.map(revRow), fc))).toEqual(want);
    }
    for (const [s, want] of G.fname as [unknown, string][]) expect(fname(s)).toBe(want);
  });

  it('summarize (thiếu kênh → tổng chưa có dữ liệu, BẤT THƯỜNG chồng kỳ/hoàn > gộp/thuần âm)', () => {
    for (const [rows, chs, fc, ov, want] of G.summarize as [
      J[],
      string[],
      FeeCol[],
      Record<string, Overlap> | null,
      J,
    ][]) {
      const s = summarize(rows.map(revRow), chs, fc, ov);
      expect({
        channels: Object.fromEntries(Object.entries(s.channels).map(([k, f]) => [k, figJ(f)])),
        total: Object.fromEntries(Object.entries(s.total).map(([k, v]) => [k, num(v)])),
        notes: s.notes,
        anomaly: s.anomaly,
      }).toEqual(want);
    }
  });

  it('opsFee / tierRows / pct / vnd', () => {
    for (const [n, rate, start, anomaly, want] of G.ops_fee as [
      number | null,
      unknown,
      string | null,
      boolean,
      [number | null, string | null],
    ][]) {
      const [fee, why] = opsFee(n === null ? null : BigInt(n), dec(rate), start, anomaly);
      expect([num(fee), why]).toEqual(want);
    }
    for (const [n, tiers, anomaly, want] of G.tier_rows as [number | null, J[], boolean, J[]][]) {
      const ts = tiers.map((t) => ({ ...t, ty_le: dec(t.ty_le) }) as Tier);
      const got = tierRows(n === null ? null : BigInt(n), ts, anomaly).map((r) => ({
        ...r,
        ty_le: decJ(r.ty_le),
        vuot: num(r.vuot),
        thuong: num(r.thuong),
      }));
      expect(got).toEqual(want.map((r) => ({ ...r, ty_le: decJ(dec(r.ty_le)) })));
    }
    for (const [rate, want] of G.pct as [unknown, string][]) expect(pct(dec(rate))).toBe(want);
    for (const [n, want] of G.vnd as [number, string][]) {
      // số > 2^53 trong golden JSON mất chữ số khi JSON.parse — chỉ so số an toàn
      if (Number.isSafeInteger(n)) expect(vnd(BigInt(n))).toBe(want);
    }
    expect(vnd(999_999_999_999_999_999n)).toBe('999.999.999.999.999.999đ');
  });

  it('renderQuarter / renderYear — biên bản y hệt từng ký tự', () => {
    const over = G.cfg_over as Record<string, J>;
    const which = G.render_cfgs as Record<string, string>;
    for (const r of G.render as J[]) {
      const cfg = cfgOf(over[which[r.name as string] as string] as J);
      const s = summarize(
        (r.rows as J[]).map(revRow),
        cfg.channels,
        cfg.fee_cols,
        r.ov as Record<string, Overlap> | null,
      );
      const undated = r.undated as Record<string, number>;
      let text: string;
      if (r.kind === 'q') {
        const [fee, why] = opsFee(s.total.net, cfg.rate, cfg.start, s.anomaly);
        text = renderQuarter('2026-Q3', '2026-07-01', '2026-10-01', s, undated, cfg, fee, why, NOW);
      } else {
        text = renderYear(1, '2025-09-01', '2026-09-01', s, undated, cfg, NOW);
      }
      expect(text, r.name as string).toBe(r.text);
    }
  });
});
