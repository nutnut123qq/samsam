import type { Db } from '@samsam/core/ops/deps';
import { vnFormat } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { maskPii } from '@samsam/core/security/pii';
import { dec, isFiniteDec, toBigInt } from '../ceo_report/dec.js';
import { monthBounds, vnd } from '../fin_ar_pnl/fin-common.js';
import { compute as pnlCompute } from '../fin_ar_pnl/fp-pnl.js';
import { PyRandom } from '../intel_alert/py-random.js';
import { clean } from '../intel_import/table.js';
import { safe } from '../ra_kenh/ra-kenh.js';
import {
  CHANNELS,
  COLS,
  type Fees,
  type MoneyRow,
  ORDER_SQL,
  overlaps,
  reconcileRow,
} from '../settlement/settlement-csv.js';
import { rows } from './bks-audit.js';

// Port `agents/bks_recon.py` (v10.0 W100.5, WP16 — ceo-04.6) — đối soát ĐỘC LẬP của BKS: doanh thu
// quyết toán ↔ đơn sàn ↔ P&L ↔ số cockpit báo TGĐ. Tài chính giữ nghiệp vụ hằng ngày
// (`settlement_csv` ghi `recon_results`); BKS HẬU KIỂM — KHÔNG tin `recon_results`:
//  - `collect` 4 nguồn theo kênh: Q = khoản quyết toán (`v_settlement_khoan`, bản xuất lại nguyên văn
//    tính 1 lần) trong tháng; Đ = Σ giá × SL của snapshot `order` MỚI NHẤT chứa mã (CÙNG
//    `settlement_csv.ORDER_SQL`); P = `fp_pnl.compute`; C = `channel_snapshots` `sales.settlement_vnd`
//    kỳ tháng (ưu tiên `manual_export`).
//  - `diffs` THUẦN: thiếu 1 phía → `thieu_nguon` (KHÔNG coi = 0); |Δ| ≤ dung sai kênh → khớp.
//  - `recheckRows` THUẦN: tính lại TỪNG dòng (mẫu) bằng `reconcileRow` rồi so nhãn đã lưu.
//  - `pickSample` THUẦN: ≤ 200 dòng → kiểm 100%; > 200 → `random.Random(seed).sample` (Python MT19937,
//    tất định: cùng seed + cùng tập → cùng mẫu như bản Python).
// CHỈ ĐỌC ngoài `insert into audit_runs` (`--record`). Báo cáo/stdout KHÔNG chép mã đơn,
// `order_id_hash`, tên/SĐT người mua — trỏ dòng bằng file + số dòng. Không LLM, không mạng.
// Tiền = bigint (Python int chính xác).

export const RUN_BY = 'agent:bks_recon';
export const KIND = 'recon';
export const SAMPLE_LIMIT = 200;
export const METRIC = 'sales.settlement_vnd';
// kênh đối soát → kênh cockpit (data/metrics.json)
export const COCKPIT_CHANNEL: Record<string, string> = { shopee: 'shopee', tiktok: 'tiktok_shop' };
export const PAIRS: readonly (readonly [
  string,
  readonly [string, string],
  readonly [string, string],
])[] = [
  ['pnl_lech_quyet_toan', ['Q', 'payout'], ['P', 'thuc_nhan']],
  ['cockpit_lech_quyet_toan', ['Q', 'payout'], ['C', 'value']],
  ['don_lech_quyet_toan', ['Q', 'order_amount'], ['D', 'value']],
];
export const SRC_NAME: Record<string, string> = {
  Q: 'quyết toán (settlement_rows)',
  D: 'đơn sàn (market_rows, snapshot order mới nhất)',
  P: 'P&L (agents.fp_pnl.compute)',
  C: 'cockpit TGĐ (channel_snapshots sales.settlement_vnd)',
};
export const ROW_CODES = [
  'nhan_lech',
  'chua_doi_soat',
  'quyet_toan_lech',
  'quyet_toan_khong_don',
  'don_chua_quyet_toan',
  'quyet_toan_chong_ky',
];
export const CODES = [...PAIRS.map(([c]) => c), 'thieu_nguon', ...ROW_CODES];
export const MAX_LINES = 200;
export const ROW_SQL = `select id, file_name, row_no, channel, order_id_hash, ${COLS.map((c) => `${c}_vnd`).join(', ')} from v_settlement_khoan where settled_on >= %s and settled_on < %s order by id`;
export const CS_SQL =
  "select id, channel, value, source, source_ref from channel_snapshots where metric_id = %s and period_kind = 'month' and period_start = %s order by id";
export const UNSETTLED_SQL =
  "with snap as (select distinct on (channel) id, channel from market_snapshots where export_kind = 'order' order by channel, imported_at desc, id desc) select s.id, s.channel, min(m.row_no) from snap s join market_rows m on m.snapshot_id = s.id where m.order_id_hash is not null and not exists (select 1 from settlement_rows r where r.channel = m.channel and r.order_id_hash = m.order_id_hash) group by s.id, s.channel, m.order_id_hash order by 2, 3";

export type QSrc = {
  order_amount: bigint;
  payout: bigint;
  n: number;
  refs: string[];
  row_refs: string[];
};
export type DSrc = { value: bigint; refs: string[] };
export type PSrc = { thuc_nhan: bigint; doanh_thu: bigint; refs: string[] };
export type CSrc = { value: bigint; refs: string[]; sample: boolean };
export type ChanSrc = {
  Q: QSrc | null;
  D: DSrc | null;
  P: PSrc | null;
  C: CSrc | null;
  tol: number;
};
export type Src = { month: string; channels: Record<string, ChanSrc> };
export type Side = { nguon: string; gia_tri: bigint | null };
export type Diff = {
  channel: string;
  month: string;
  a: Side;
  b: Side;
  refs: string[];
  code: string;
  pair?: string;
  missing?: string;
  delta: bigint | null;
};
export type RowFinding = {
  code: string;
  channel: string;
  refs: string[];
  stored?: string;
  recomputed?: string;
  reasons?: string[];
  trung?: number;
  lech?: number;
};
export type CheckRow = MoneyRow & {
  id?: number;
  channel: string;
  order_id_hash: string;
  ref: string;
  stored: { label: string; expected: bigint | null } | null;
};
export type ReconData = {
  src: Src;
  row_findings: RowFinding[];
  n_total: number;
  n_checked: number;
  seed: bigint;
  sample_flag: boolean;
};

/** Tên file trước khi in: bỏ ký tự điều khiển, che PII, cắt 80, bỏ ký tự markdown bảng. */
export const fname = (s: unknown): string =>
  clean(maskPii(safe(s)), 80)
    .replaceAll('`', "'")
    .replaceAll('|', '/');

const money = (v: bigint | null | undefined): string =>
  v === null || v === undefined ? '—' : vnd(v);
const absB = (n: bigint): bigint => (n < 0n ? -n : n);
const oKey = (ch: string, h: string): string => `${ch}\u0000${h}`;

// ------------------------------------------------------------------ thuần

/** Python `random.Random(seed).sample(population, k)` (CPython 3.12). */
export function pySample<T>(rng: PyRandom, population: readonly T[], k: number): T[] {
  const n = population.length;
  if (!(k >= 0 && k <= n)) throw new RangeError('Sample larger than population or is negative');
  const result: T[] = new Array(k);
  let setsize = 21;
  if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
  if (n <= setsize) {
    const pool = [...population];
    for (let i = 0; i < k; i++) {
      const j = rng.randbelow(n - i);
      result[i] = pool[j] as T;
      pool[j] = pool[n - i - 1] as T;
    }
  } else {
    const selected = new Set<number>();
    for (let i = 0; i < k; i++) {
      let j = rng.randbelow(n);
      while (selected.has(j)) j = rng.randbelow(n);
      selected.add(j);
      result[i] = population[j] as T;
    }
  }
  return result;
}

/** ≤ limit → tất cả (sắp xếp); > limit → mẫu `limit` theo seed (tất định như Python). */
export function pickSample(ids: readonly number[], seed: bigint, limit = SAMPLE_LIMIT): number[] {
  const s = [...ids].sort((a, b) => a - b);
  if (s.length <= limit) return s;
  return pySample(new PyRandom(seed), s, limit).sort((a, b) => a - b);
}

/** rows: dòng quyết toán (field chuẩn) + ref + nhãn đã lưu | null; orders: {kênh+hash: Σ đơn}. */
export function recheckRows(
  rs: readonly CheckRow[],
  orders: ReadonlyMap<string, bigint>,
  fees: Fees,
): RowFinding[] {
  const out: RowFinding[] = [];
  for (const r of rs) {
    const amt = orders.get(oKey(r.channel, r.order_id_hash)) ?? null;
    const [label, reasons, expected] = reconcileRow(r, amt, fees[r.channel] as Fees[string]);
    const base = { channel: r.channel, refs: [r.ref] };
    const st = r.stored;
    if (st === null) out.push({ ...base, code: 'chua_doi_soat', recomputed: label });
    else if (st.label !== label || st.expected === null || BigInt(st.expected) !== expected) {
      out.push({ ...base, code: 'nhan_lech', stored: st.label, recomputed: label });
    }
    if (label === 'lech') {
      out.push({ ...base, code: 'quyet_toan_lech', reasons: reasons.map((x) => x.code) });
    } else if (label === 'thieu_chung_tu') out.push({ ...base, code: 'quyet_toan_khong_don' });
  }
  return out;
}

const field = (o: unknown, f: string): bigint => (o as Record<string, bigint>)[f] as bigint;

/** Khác biệt 4 nguồn (THUẦN). Thiếu cả 2 phía → bỏ; thiếu 1 phía → `thieu_nguon` (không coi = 0). */
export function diffs(src: Src): Diff[] {
  const out: Diff[] = [];
  const chans = Object.entries(src.channels).sort((x, y) => cpCmp(x[0], y[0]));
  for (const [ch, s] of chans) {
    for (const [code, [ka, fa], [kb, fb]] of PAIRS) {
      const a = (s as Record<string, unknown>)[ka] ?? null;
      const b = (s as Record<string, unknown>)[kb] ?? null;
      if (a === null && b === null) continue;
      const refsA =
        a === null
          ? []
          : ((a as Record<string, string[]>)[
              code !== 'don_lech_quyet_toan' ? 'refs' : 'row_refs'
            ] ?? []);
      const refsB = b === null ? [] : ((b as Record<string, string[]>).refs ?? []);
      const base = {
        channel: ch,
        month: src.month,
        a: { nguon: SRC_NAME[ka] as string, gia_tri: a === null ? null : field(a, fa) },
        b: { nguon: SRC_NAME[kb] as string, gia_tri: b === null ? null : field(b, fb) },
        refs: [...refsA, ...refsB],
      };
      if (a === null || b === null) {
        out.push({
          ...base,
          code: 'thieu_nguon',
          pair: code,
          missing: SRC_NAME[a === null ? ka : kb] as string,
          delta: null,
        });
        continue;
      }
      const d = field(a, fa) - field(b, fb);
      if (absB(d) > BigInt(s.tol)) out.push({ ...base, code, delta: d });
    }
  }
  return out;
}

// ------------------------------------------------------------------ đọc DB

/** {kênh đối soát: {value, refs, sample}} — manual_export > api; NaN/vô cực bị bỏ. */
async function cockpit(db: Db, month: string): Promise<Record<string, CSrc>> {
  const by = new Map<string, { id: string; value: string; source: string; ref: string }>();
  for (const [sid, ch, val, src, ref] of await rows(db, CS_SQL, [METRIC, month])) {
    const c = String(ch);
    if (by.get(c)?.source === 'manual_export') continue;
    by.set(c, {
      id: String(sid),
      value: String(val),
      source: String(src),
      ref: ref ? String(ref) : '',
    });
  }
  const out: Record<string, CSrc> = {};
  for (const [ours, theirs] of Object.entries(COCKPIT_CHANNEL)) {
    const c = by.get(theirs);
    if (c === undefined) continue;
    const v = dec(c.value);
    if (!isFiniteDec(v)) continue;
    out[ours] = {
      value: toBigInt(v),
      refs: [`channel_snapshots#${c.id}`],
      sample: c.ref.startsWith('sample:'),
    };
  }
  return out;
}

type SRow = { id: number; file_name: string | null; row_no: number; channel: string } & Record<
  string,
  unknown
> &
  MoneyRow & { order_id_hash: string };

/** CHỈ SELECT → {src, row_findings, n_total, n_checked, seed, sample_flag}. `month` = 'YYYY-MM-01'. */
export async function collect(db: Db, month: string, seed: bigint, fees: Fees): Promise<ReconData> {
  const [start, end] = monthBounds(month);
  const label = month.slice(0, 7);
  const srows: SRow[] = (await rows(db, ROW_SQL, [start, end])).map((r) => {
    const o: Record<string, unknown> = {
      id: Number(r[0]),
      file_name: r[1] === null ? null : String(r[1]),
      row_no: Number(r[2]),
      channel: String(r[3]),
      order_id_hash: String(r[4]),
    };
    COLS.forEach((c, i) => {
      o[c] = BigInt(r[5 + i] as string);
    });
    return o as SRow;
  });
  const hashes = [...new Set(srows.map((r) => r.order_id_hash))].sort(cpCmp);
  const orders = new Map<string, bigint>();
  if (hashes.length) {
    const { rows: or } = await db.query(ORDER_SQL, [hashes]);
    for (const o of or as { channel: string; order_id_hash: string; total: string }[]) {
      orders.set(oKey(o.channel, o.order_id_hash), toBigInt(dec(String(o.total))));
    }
  }
  const ck = await cockpit(db, month);
  const sampleFlag =
    srows.some((r) => (r.file_name ?? '').includes('_MAU')) ||
    Object.values(ck).some((c) => c.sample);
  const channels: Record<string, ChanSrc> = {};
  for (const ch of CHANNELS) {
    const mine = srows.filter((r) => r.channel === ch);
    let q: QSrc | null = null;
    let d: DSrc | null = null;
    let p: PSrc | null = null;
    if (mine.length) {
      const files = new Map<string, number>();
      for (const r of mine)
        files.set(String(r.file_name), (files.get(String(r.file_name)) ?? 0) + 1);
      q = {
        order_amount: mine.reduce((a, r) => a + (r.order_amount as bigint), 0n),
        payout: mine.reduce((a, r) => a + (r.payout as bigint), 0n),
        n: mine.length,
        refs: [...files.entries()]
          .sort((x, y) => cpCmp(x[0], y[0]))
          .map(([f, n]) => `${fname(f)} (${n} dòng)`),
        row_refs: mine
          .filter((r) => orders.get(oKey(ch, r.order_id_hash)) !== r.order_amount)
          .map((r) => `${fname(r.file_name)} dòng ${r.row_no}`),
      };
      const found = mine
        .map((r) => orders.get(oKey(ch, r.order_id_hash)))
        .filter((x): x is bigint => x !== undefined);
      if (found.length) d = { value: found.reduce((a, x) => a + x, 0n), refs: [] };
      const pn = await pnlCompute(db, month, ch);
      if (pn.n_rows) {
        p = {
          thuc_nhan: pn.cells.reduce((a, c) => a + BigInt(c.thuc_nhan), 0n),
          doanh_thu: pn.cells.reduce((a, c) => a + BigInt(c.doanh_thu ?? 0), 0n),
          refs: [`pnl:${label}/${ch}`],
        };
      }
    }
    channels[ch] = {
      Q: q,
      D: d,
      P: p,
      C: ck[ch] ?? null,
      tol: (fees[ch] as Fees[string]).tolerance_vnd,
    };
  }
  // Lấy mẫu dòng để tính lại (≤200 → 100%).
  const picked = new Set(
    pickSample(
      srows.map((r) => r.id),
      seed,
    ),
  );
  const stored = new Map<number, { label: string; expected: bigint | null }>();
  if (picked.size) {
    for (const [sid, lb, ex] of await rows(
      db,
      'select settlement_row_id, label, expected_payout_vnd from recon_results where settlement_row_id = any(%s)',
      [[...picked].sort((a, b) => a - b)],
    )) {
      stored.set(Number(sid), {
        label: String(lb),
        expected: ex === null ? null : BigInt(ex as string),
      });
    }
  }
  const check: CheckRow[] = srows
    .filter((r) => picked.has(r.id))
    .map((r) => ({
      ...r,
      ref: `${fname(r.file_name)} dòng ${r.row_no}`,
      stored: stored.get(r.id) ?? null,
    }));
  const rowF = recheckRows(check, orders, fees);
  for (const [sid, ch, rn] of await rows(db, UNSETTLED_SQL)) {
    rowF.push({
      code: 'don_chua_quyet_toan',
      channel: String(ch),
      refs: [`market_snapshots#${sid} dòng ${rn}`],
    });
  }
  const ov = await overlaps(db, CHANNELS, start, end);
  for (const [ch, o] of Object.entries(ov).sort((x, y) => cpCmp(x[0], y[0]))) {
    rowF.push({
      code: 'quyet_toan_chong_ky',
      channel: ch,
      refs: o.files.map(fname),
      trung: o.trung,
      lech: o.lech,
    });
  }
  return {
    src: { month: label, channels },
    row_findings: rowF,
    n_total: srows.length,
    n_checked: picked.size,
    seed,
    sample_flag: sampleFlag,
  };
}

// ------------------------------------------------------------------ báo cáo

function diffLine(f: Diff): string {
  const head =
    f.code === 'thieu_nguon'
      ? `[thieu_nguon] kênh ${f.channel} tháng ${f.month} — cặp ${f.pair} thiếu nguồn: ${f.missing}`
      : `[${f.code}] kênh ${f.channel} tháng ${f.month} — ${f.a.nguon} ${money(f.a.gia_tri)} ↔ ${f.b.nguon} ${money(f.b.gia_tri)} · Δ ${money(f.delta)}`;
  const refs = f.refs.slice(0, MAX_LINES).join('; ') || '—';
  return `- ${head} · nguồn: ${refs}`;
}

function rowLine(f: RowFinding): string {
  let extra = '';
  if (f.code === 'nhan_lech') extra = ` — nhãn đã lưu ${f.stored} ≠ tính lại ${f.recomputed}`;
  else if (f.code === 'chua_doi_soat') extra = ` — tính lại: ${f.recomputed}`;
  else if (f.code === 'quyet_toan_chong_ky') {
    extra = ` — khoản xuất lại ở ≥2 file: trùng nguyên văn ${f.trung} (Q tính 1 lần), lệch số ${f.lech} (giữ cả hai, chờ người đối soát)`;
  } else if (f.reasons?.length) extra = ` — lý do: ${f.reasons.join(', ')}`;
  return `- [${f.code}] kênh ${f.channel}: ${f.refs.join('; ')}${extra}`;
}

export function findingsOf(data: Pick<ReconData, 'src' | 'row_findings'>): (Diff | RowFinding)[] {
  return [...diffs(data.src), ...data.row_findings];
}

export function render(data: ReconData, now: Date): string {
  const src = data.src;
  const cnt = new Map<string, number>();
  for (const f of findingsOf(data)) cnt.set(f.code, (cnt.get(f.code) ?? 0) + 1);
  const mau = data.sample_flag ? ' (MẪU)' : '';
  const L = [
    `# Đối soát độc lập BKS — tháng ${src.month}${mau}`,
    '',
    `Sinh lúc ${vnFormat(now, '%d/%m/%Y %H:%M')} giờ VN bởi \`${RUN_BY}\` (sổ lần chạy MÁY — KHÔNG phải chữ ký BKS). Chỉ đọc; không bút toán, không sửa đối soát của Tài chính.`,
    '',
  ];
  if (data.sample_flag) {
    L.push('*(MẪU) — có nguồn là file/fixture MẪU, không phải số vận hành thật.*', '');
  }
  L.push(
    '## Bốn nguồn theo kênh',
    '',
    '| Kênh | Quyết toán: giá trị đơn | Quyết toán: thực nhận | Số dòng | Đơn sàn | P&L thực nhận | Cockpit TGĐ |',
    '|---|---|---|---|---|---|---|',
  );
  for (const [ch, s] of Object.entries(src.channels).sort((x, y) => cpCmp(x[0], y[0]))) {
    L.push(
      `| ${ch} | ${money(s.Q?.order_amount)} | ${money(s.Q?.payout)} | ${s.Q?.n ?? 0} | ${money(s.D?.value)} | ${money(s.P?.thuc_nhan)} | ${money(s.C?.value)} |`,
    );
  }
  L.push('', '## Tổng theo mã', '', '| Mã | Số |', '|---|---|');
  for (const c of CODES) L.push(`| ${c} | ${cnt.get(c) ?? 0} |`);
  L.push('', '## Khác biệt 4 nguồn', '');
  const ds = diffs(src);
  L.push(...(ds.length ? ds.map(diffLine) : ['- (khớp trong dung sai)']));
  L.push(
    '',
    '## Tính lại từng dòng + đơn chưa quyết toán',
    '',
    `Lấy mẫu: seed ${data.seed} · ${data.n_checked}/${data.n_total} dòng quyết toán trong tháng được tính lại (${data.n_checked === data.n_total ? '100%' : 'mẫu'}; ngưỡng kiểm 100% = ${SAMPLE_LIMIT} dòng).`,
    '',
  );
  const rf = data.row_findings;
  L.push(...(rf.length ? rf.slice(0, MAX_LINES).map(rowLine) : ['- (không có)']));
  if (rf.length > MAX_LINES) L.push(`- …còn ${rf.length - MAX_LINES} dòng`);
  L.push(
    '',
    '---',
    '*BẢN NHÁP — chờ BKS ký (external-dep). Số liệu thật Seller Center/kế toán là external-dep.*',
    '',
  );
  return L.join('\n');
}
