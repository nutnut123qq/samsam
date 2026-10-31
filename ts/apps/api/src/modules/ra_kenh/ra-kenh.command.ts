import { createPool, databaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { cliGate, HumanDenied } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, pyRepr, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import * as pt from './partner.js';
import * as rk from './ra-kenh.js';

// Lệnh CLI thay `python -m agents.ra_kenh` — cùng cờ, exit code, thông điệp chính. `raKenhMain(opts,
// deps)` trả exit code (test gọi thẳng); lớp Command chỉ nối. Tham số sai → `ra_kenh: error: …`
// exit 2 TRƯỚC mọi kết nối DB (Python argparse). Exit 0 ok (có vi phạm vẫn 0 — rà là báo, không
// chặn) · 1 file không hợp lệ / mark-removed không có đợt mở / bị từ chối quyền · 2 usage / cấu hình
// hỏng / DB không truy cập được / cổng triển khai TẮT. `--now` CHỈ cho `--report`/`--dry-run` (ghi
// dùng giờ thật — chống lùi `closed_at` làm giả "đúng hạn").

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };

export type RaKenhOpts = {
  file?: string;
  partnerFile?: string;
  markRemoved?: string;
  report?: boolean;
  scanAuto?: boolean;
  by?: string;
  now?: string;
  days?: string;
  dryRun?: boolean;
};

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db | null) => unknown;
  /** Giờ thật (Python `_now`, test thay). */
  clock?: () => Date;
  outDir?: string;
  /** Nguồn web tự thu (Python test monkeypatch `web_rows`). */
  webRows?: (now: Date) => [rk.Row[], string[]];
  configPath?: string;
  policyPath?: string;
  kocFile?: string;
};

/** Python `lead_store.connect()`: `DATABASE_URL` → kết nối | null (thiếu DSN / host chết). */
export async function connectDatabaseUrl(env: Env = process.env): Promise<DbLease | null> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

const errLine = (e: unknown): string =>
  cpHead(rk.safe(maskPii(String((e as Error)?.message ?? e))), 200);

/** Lỗi bắt như Python `(psycopg.Error, ValueError)` → `Tên: thông điệp` | null. RolloutBlocked
 * (cũng là RangeError) phải bắt TRƯỚC. */
function caught(e: unknown): string | null {
  if (isDbError(e)) return `${pgErrName(e)}: ${cpHead(rk.safe(maskPii(dbMsg(e))), 200)}`;
  if (e instanceof RangeError) return `ValueError: ${errLine(e)}`;
  return null;
}

function printPlan(io: Io, rows: rk.Row[], scans: rk.Scan[]): void {
  rows.forEach((r, i) => {
    const s = scans[i] as rk.Scan;
    const url = maskPii(rk.safe(r.url));
    if (!s.severity) {
      io.out(`[sạch] dòng ${r.line ?? 'None'} ${url}`);
      return;
    }
    const kind =
      s.kind === 'hosting' ? 'hosting_fix (data_platform)' : 'channel_takedown (legal_hr)';
    const alert = s.severity === 'S1' ? ' + red_alert' : '';
    io.out(
      `[${s.severity}] dòng ${r.line ?? 'None'} ${url} — ${s.codes.join(', ')} → ticket ${kind}${alert}`,
    );
    io.out(`    trích: ${s.excerpt}`);
  });
}

async function open(d: CliDeps, io: Io): Promise<DbLease | null> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) io.out('[err] DB không truy cập được');
  else (d.wire ?? ((db: Db | null) => wireCore(db)))(lease.db);
  return lease;
}

async function scanAutoMain(dryRun: boolean, d: CliDeps, io: Io): Promise<number> {
  let cfg: rk.PhapCheCfg;
  try {
    cfg = rk.loadConfig(d.configPath);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.out(`[err] cấu hình phap_che.json: ${e.message}`);
    return 2;
  }
  const now = (d.clock ?? (() => new Date()))();
  let [rows, notes] = (d.webRows ?? ((n: Date) => rk.webRows(n)))(now);
  const lease = dryRun ? null : await open(d, io);
  if (!dryRun && lease === null) return 2;
  const db = lease?.db ?? null;
  let st: rk.Stats;
  let fb: rk.Row[];
  let fbRc: number | null;
  try {
    // r18: TẮT → chặn cả --dry-run (in kế hoạch cũng là đầu ra), 0 request.
    const why = await blocked(db, 'rà kênh tự thu', rk.FEATURE);
    if (why) return sayBlocked(why, io.out);
    let fbNotes: string[];
    [fb, fbNotes, fbRc] = await rk.fanpageRows(db, { env: d.env });
    notes = [...notes, ...fbNotes];
    if (db !== null) rows = [...rows, ...(await rk.listingRows(db))];
    rows = [...rows, ...fb];
    for (const n of notes) io.out(`[note] ${n}`);
    if (dryRun) {
      const scans = rows.map((r) => rk.scanRow(r, cfg));
      io.out(`[dry-run] ${rows.length} bài web/Fanpage (listing cần DB) — KHÔNG ghi`);
      io.out(
        '[note] dry-run không ghi DB, chỉ đọc sổ triển khai: không kế thừa snapshot người, không kiểm bản duyệt — mức S2 thieu_ban_duyet dưới đây có thể khác lượt thật',
      );
      printPlan(io, rows, scans);
      return fbRc || 0;
    }
    st = await rk.ingest(db as Db, rows, cfg, { by: rk.AUTO_BY, now, auto: true });
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
    const m = caught(e);
    if (m === null) throw e;
    io.out(`[err] ${m}`);
    return 2;
  } finally {
    await lease?.release();
  }
  io.out(
    `[scan-auto] ${st.rows} mục: mới ${st.new}, trùng ${st.skip}, S1 ${st.S1}, S2 ${st.S2}, đóng ${st.closed}, ticket ${st.tickets} — Fanpage: ${fb.length} bài`,
  );
  return Math.max(fbRc || 0, notes.some((n) => n.includes('cũ')) ? 1 : 0);
}

async function partnerMain(o: RaKenhOpts, d: CliDeps, io: Io): Promise<number> {
  let rows: pt.PartnerRow[];
  try {
    rows = pt.readPartnerExport(o.partnerFile as string);
  } catch (e) {
    if (e instanceof rk.ExportError) {
      io.out(`[err] file bài đối tác không hợp lệ — 0 dòng nạp (${e.message}):`);
      for (const m of e.errors.slice(0, 20)) io.out(`  - ${m}`);
      return 1;
    }
    if (!(e instanceof RangeError)) throw e;
    io.out(`[err] cấu hình guardrail: ${e.message}`);
    return 2;
  }
  if (o.dryRun) {
    const why = await blocked(null, 'rà bài đối tác (dry-run)', pt.PARTNER_FEATURE);
    if (why) return sayBlocked(why, io.out);
    io.out(
      `[dry-run] ${rows.length} bài đối tác — KHÔNG ghi DB (chỉ đọc sổ triển khai); chưa đối chiếu sổ đối tác/bộ tài liệu đã duyệt — cần lượt thật`,
    );
    for (const r of rows) {
      const v = pt.partnerScan(r, null);
      const codes = v.codes.filter((c) => c !== pt.THIEU_KIT);
      io.out(
        `[${codes.length ? 'vi phạm' : 'guardrail sạch'}] dòng ${r.line} ${r.partner} ${r.channel} ${r.host} — ${codes.join(', ') || '—'}`,
      );
    }
    return 0;
  }
  const lease = await open(d, io);
  if (lease === null) return 2;
  let st: pt.PartnerStats;
  try {
    st = await pt.ingestPartner(lease.db, rows, {
      by: o.by as string,
      now: (d.clock ?? (() => new Date()))(),
      policyPath: d.policyPath,
      kocFile: d.kocFile,
    });
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      io.out(`[rollout] ${e.message}`);
      return 2;
    }
    if (isDbError(e)) {
      io.out(`[err] ${caught(e)}`);
      return 2;
    }
    if (!(e instanceof RangeError)) throw e;
    io.out(`[err] ${errLine(e)}`);
    if (e instanceof pt.UnknownPartner && e.warn) io.out(`[warn] ${e.warn}`);
    return 1;
  } finally {
    await lease.release();
  }
  if (st.policy_warn) io.out(`[warn] ${st.policy_warn}`);
  if (st.unknown.length) {
    io.out(
      `[warn] ${st.unknown.length} mã đối tác chưa đăng ký — ghi vi phạm ${pt.UNKNOWN_PARTNER} (chính sách ghi_vi_pham)`,
    );
  }
  io.out(
    `[ok] ${st.rows} bài đối tác — mới ${st.new}, bỏ qua ${st.skip} (trùng lần rà trước) — S1 ${st.S1}, S2 ${st.S2}, sạch ${st.clean} — mục hàng duyệt mới ${st.tickets}`,
  );
  for (const it of st.items) {
    if (it.severity) {
      io.out(
        `[${it.severity}] dòng ${it.line} ${it.partner} ${it.channel} ${it.host} url#${it.url_sha.slice(0, 12)} — ${it.codes.join(', ')} — mục #${it.queue_id}`,
      );
    }
  }
  return 0;
}

/** `python -m agents.ra_kenh` — PC-A4 rà bài đang đăng trên kênh sở hữu → ticket gỡ/sửa 24h;
 * `--partner-file` (marketing-04.2) rà bài KOC/đại lý. Agent KHÔNG gỡ/sửa bài. */
export async function raKenhMain(o: RaKenhOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`ra_kenh: error: ${msg}`);
    return 2;
  };
  let days = 7;
  if (o.days !== undefined) {
    const t = pyStrip(o.days);
    if (!/^[+-]?[0-9]+$/.test(t))
      return usage(`argument --days: invalid int value: ${pyRepr(o.days)}`);
    days = Number(t);
  }
  const nOps = [
    o.file !== undefined,
    o.markRemoved !== undefined,
    Boolean(o.report),
    o.partnerFile !== undefined,
    Boolean(o.scanAuto),
  ].filter(Boolean).length;
  if (nOps !== 1) {
    return usage(
      'chọn đúng 1 thao tác: --file | --partner-file | --mark-removed | --report | --scan-auto',
    );
  }
  if (o.scanAuto) {
    if (o.by !== undefined || o.now !== undefined) {
      return usage('--scan-auto không nhận --by/--now (người nạp = agent, giờ thật)');
    }
    return scanAutoMain(Boolean(o.dryRun), d, io);
  }
  if (o.dryRun && o.file === undefined && o.partnerFile === undefined) {
    return usage('--dry-run chỉ đi với --file/--partner-file');
  }
  if (o.partnerFile !== undefined && o.now !== undefined) {
    return usage('--now không đi với --partner-file (ghi dùng giờ thật)');
  }
  if (o.now !== undefined && !(o.report || o.dryRun)) {
    // lùi giờ ghi → closed_at trước hạn = "đúng hạn" giả trong báo cáo
    return usage('--now chỉ đi với --report/--dry-run — thao tác ghi dùng giờ thật');
  }
  let now: Date;
  try {
    now = o.now ? rk.parseNow(o.now) : (d.clock ?? (() => new Date()))();
  } catch {
    return usage('--now sai định dạng ISO');
  }
  if (!(days >= 1 && days <= 366)) return usage('--days phải 1..366');
  if (!o.report) {
    const err = rk.byError(o.by);
    if (err) return usage(err);
  }
  if (o.partnerFile !== undefined) return partnerMain(o, d, io);
  let cfg: rk.PhapCheCfg;
  try {
    cfg = rk.loadConfig(d.configPath);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.out(`[err] cấu hình phap_che.json: ${e.message}`);
    return 2;
  }
  let rows: rk.Row[] = [];
  if (o.file !== undefined) {
    try {
      rows = rk.readExport(o.file, cfg);
    } catch (e) {
      if (e instanceof rk.ExportError) {
        io.out(`[err] file xuất tay không hợp lệ — 0 dòng nạp (${e.message}):`);
        for (const m of e.errors.slice(0, 20)) io.out(`  - ${m}`);
        return 1;
      }
      if (!(e instanceof RangeError)) throw e;
      io.out(`[err] cấu hình guardrail: ${e.message}`);
      return 2;
    }
    const scans = rows.map((r) => rk.scanRow(r, cfg));
    if (scans.some((s) => s.codes.includes('config'))) {
      io.out('[err] guardrail cấu hình hỏng — không rà (fail-closed)');
      return 2;
    }
    if (o.dryRun) {
      const why = await blocked(null, 'rà kênh (dry-run)', rk.FEATURE);
      if (why) return sayBlocked(why, io.out);
      io.out(
        `[dry-run] ${rows.length} bài — KHÔNG ghi DB (chỉ đọc sổ triển khai); chưa kiểm lệch bản duyệt — cần lượt thật`,
      );
      printPlan(io, rows, scans);
      return 0;
    }
  }
  const lease = await open(d, io);
  if (lease === null) return 2;
  const db = lease.db;
  let st: rk.Stats;
  try {
    if (o.markRemoved !== undefined) {
      // v15.4 (P10.2): ghi nhận đã gỡ = đóng đợt vi phạm (dừng theo dõi SLA gỡ bài) = QUYẾT ĐỊNH
      // của Pháp chế được Bên B ủy quyền (khối legal_hr). object_id = sha256 URL (không lưu URL).
      const why = await cliGate(
        db,
        o.by,
        'legal_hr',
        'close_violation',
        'channel_post',
        rk.urlSha12(o.markRemoved),
        { env: d.env },
      );
      if (why) {
        io.out(`[err] ${why} — không ghi`);
        return 1;
      }
      let res: [boolean, string];
      try {
        res = await rk.markRemoved(db, o.markRemoved, o.by as string, now, d.env);
      } catch (e) {
        if (!(e instanceof HumanDenied)) throw e;
        io.out(`[err] ${e.message} — không ghi`);
        return 1;
      }
      io.out((res[0] ? '[ok] ' : '[err] ') + res[1]);
      return res[0] ? 0 : 1;
    }
    if (o.report) {
      const stats = await rk.collectReport(db, now, days, { config: d.configPath });
      const text = rk.renderReport(stats, now);
      // P8.4: tổng hợp vi phạm kênh từ bài đã đăng (không đường mẫu trong báo cáo tuần).
      const path = await writeReport(text, d.outDir ?? REPORTS_DIR, rk.reportName(now), false);
      io.out(text);
      io.out(`[ok] đã ghi data/reports/${path.replace(/^.*[\\/]/, '')}`);
      return 0;
    }
    st = await rk.ingest(db, rows, cfg, { by: o.by as string, now });
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
    const m = caught(e);
    if (m === null) throw e;
    io.out(`[err] ${m}`);
    return 2;
  } finally {
    await lease.release();
  }
  io.out(
    `[ok] ${st.rows} dòng — mới ${st.new}, bỏ qua ${st.skip} (trùng bản mới nhất) — S1 ${st.S1}, S2 ${st.S2}, đã sạch ${st.closed} — ticket mới ${st.tickets}, red_alert mới ${st.alerts}`,
  );
  for (const it of st.items) {
    const url = maskPii(rk.safe(it.url));
    if (it.severity) {
      io.out(
        `[${it.severity}] #${it.id} ${it.channel} ${url} — ${it.codes.join(', ')} — hạn ${rk.vn(it.due_at)}`,
      );
      io.out(`    trích: ${it.excerpt}`);
    } else if (it.closed) {
      io.out(`[sạch] #${it.id} ${url} — đóng da_sua`);
    }
  }
  return 0;
}

@Command({
  name: 'ra-kenh',
  description:
    'PC-A4 rà bài đang đăng trên kênh sở hữu (file xuất tay) → ticket gỡ/sửa 24h. Agent KHÔNG gỡ/sửa bài.',
})
export class RaKenhCommand extends CommandRunner {
  async run(_a: string[], o: RaKenhOpts): Promise<void> {
    process.exitCode = await raKenhMain(o);
  }
  @Option({
    flags: '--file <csv>',
    description:
      'CSV xuất tay (url,kenh,is_ai,text[,loai_noi_dung,ngay_dang,draft_id,sku,is_sponsored])',
  })
  parseFile(v: string): string {
    return v;
  }
  @Option({
    flags: '--partner-file <csv>',
    description:
      'v14.5 bài KOC/đại lý ĐÃ đăng (ma_doi_tac,url,kenh,text,ngay_dang[,sku]) → guardrail + bộ tài liệu chuẩn đã duyệt → hàng duyệt GĐ marketing',
  })
  parsePartnerFile(v: string): string {
    return v;
  }
  @Option({
    flags: '--mark-removed <url>',
    description: 'NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt (da_go)',
  })
  parseMarkRemoved(v: string): string {
    return v;
  }
  @Option({ flags: '--report', description: 'báo cáo Pháp chế tuần → data/reports/' })
  parseReport(): boolean {
    return true;
  }
  @Option({
    flags: '--scan-auto',
    description:
      'C12: quét nguồn TỰ THU (web từ crawl công khai, listing từ snapshot sàn, Fanpage) → ticket 24h (job)',
  })
  parseScanAuto(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>', description: 'tên NGƯỜI thực hiện (không agent:/system:)' })
  parseBy(v: string): string {
    return v;
  }
  @Option({
    flags: '--now <iso>',
    description:
      'thời điểm ISO CHỈ cho --report/--dry-run (thao tác ghi dùng giờ thật); thiếu múi giờ = giờ VN (+07:00); mặc định bây giờ',
  })
  parseNow(v: string): string {
    return v;
  }
  @Option({ flags: '--days <n>', description: 'kỳ báo cáo 1..366 (mặc định 7)' })
  parseDays(v: string): string {
    return v;
  }
  @Option({
    flags: '--dry-run',
    description: 'chỉ đọc file + rà, KHÔNG ghi DB (chỉ đọc sổ triển khai: tính năng TẮT → exit 2)',
  })
  parseDryRun(): boolean {
    return true;
  }
}
