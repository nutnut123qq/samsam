import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { DIRECTORS_DIR, DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { vnFormat } from '@samsam/core/ops/period';
import { isPlainObject, pyInt } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { REPO_ROOT } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { cliGate } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { DbLease } from '../channels/channels.command.js';
import { STAFF_RE, section } from '../sales_director/sales-watch.js';
import * as crm from './crm.service.js';
import { type Io, leadStoreJob, STD_IO } from './lead-store.js';

// Lệnh CLI thay `python -m ingest.crm` (cùng cờ, exit code, thông điệp chính) và
// `python -m ingest.lead_store`. `crmMain(opts, deps)` trả exit code (test gọi thẳng); lớp Command
// chỉ nối. Kiểm tham số ở đây (lỗi ném trong hàm parse của nest-commander thoát 0): tham số sai →
// `crm: error: …` exit 2 TRƯỚC mọi kết nối DB (Python argparse). Thiếu/sai khóa vault, JSON liên hệ
// hỏng, file vùng hỏng → exit 2 trước connect, không ghi gì. PII chỉ vào qua stdin `-` hoặc file
// NGOÀI repo (không qua argv); thông báo lỗi không echo PII.
// Quyết định cho phép dùng/chuyển PII (đồng ý, gán/chuyển đại lý, sổ đại lý, người phụ trách) =
// người được Bên B ủy quyền khối sales (`cliGate`); nhập liên hệ / đổi trạng thái lead = nhập liệu
// (danh tính do function DB `human_actor` kiểm).

export type CrmOpts = {
  addContact?: string;
  lead?: string;
  consent?: string;
  purpose?: string;
  grant?: boolean;
  withdraw?: boolean;
  source?: string;
  evidence?: string;
  policyVersion?: string;
  dealer?: string;
  assign?: string;
  province?: string;
  owner?: string;
  staff?: string;
  status?: string[];
  report?: boolean;
  handoff?: string;
  loadDealers?: string | boolean;
  by?: string;
};

export type CrmDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** stdin cho `--add-contact -` (đọc tối đa n byte). */
  stdin?: (max: number) => Promise<Buffer>;
  regionsFile?: string;
  watchFile?: string;
  directorsDir?: string;
};

// v14.2: thao tác CLI → hành động `cliGate` (khối sales).
export const GATED_OPS: Record<string, string> = {
  consent: 'consent',
  assign: 'assign',
  handoff: 'handoff',
  'load-dealers': 'load_dealers',
  owner: 'assign',
};
const OPS = [
  'add-contact',
  'consent',
  'assign',
  'status',
  'report',
  'handoff',
  'load-dealers',
  'owner',
] as const;
const NO_DB =
  '[err] DB không truy cập được — kiểm DATABASE_URL / chạy `python scripts/apply_schema.py`';

async function readStdin(max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    n += (c as Buffer).length;
    if (n >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, max);
}

/** Đọc tối đa `max` byte (không đọc hết file lớn / thiết bị vô tận). */
function readHead(path: string, max: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    let n = 0;
    while (n < max) {
      const k = readSync(fd, buf, n, max - n, null);
      if (k === 0) break;
      n += k;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** `-` = stdin; PATH phải nằm NGOÀI repo (không để file PII trong git). Lỗi không echo nội dung. */
async function readContactJson(src: string, d: CrmDeps): Promise<Record<string, unknown>> {
  const max = crm.MAX_INPUT_BYTES + 1;
  let data: Buffer;
  if (src === '-') data = await (d.stdin ?? readStdin)(max);
  else {
    const rel = relative(real(REPO_ROOT), real(src));
    if (rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..')) {
      throw new RangeError(
        'file liên hệ phải nằm NGOÀI repo (không lưu PII trong git) — dùng stdin `-`',
      );
    }
    try {
      data = readHead(src, max);
    } catch (e) {
      throw new RangeError(`không đọc được file (${pyOsName(e)})`);
    }
  }
  if (data.length > crm.MAX_INPUT_BYTES) throw new RangeError('JSON liên hệ quá lớn');
  let rec: unknown;
  try {
    rec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); // utf-8-sig: bỏ BOM
  } catch {
    throw new RangeError('JSON liên hệ không hợp lệ');
  }
  if (!isPlainObject(rec)) throw new TypeError('JSON liên hệ phải là object');
  return rec;
}

/** Python `_db_msg`: lỗi DB không kèm DETAIL (DETAIL có thể chứa giá trị), đã che PII. */
const dbErrMsg = (e: unknown) =>
  maskPii(cpHead(`${pgErrName(e)}: ${(e as Error).message ?? ''}`, 300));

/** `python -m ingest.crm`. Exit: 0 ok · 1 DB/từ chối/lỗi nghiệp vụ · 2 tham số sai, khóa vault,
 * dữ liệu vào/cấu hình hỏng (trước connect, không ghi gì). */
export async function crmMain(o: CrmOpts, d: CrmDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`crm: error: ${msg}`);
    return 2;
  };
  // --- argparse: kiểu/lựa chọn
  const ints: Record<string, bigint | undefined> = {};
  for (const [k, flag] of [
    ['lead', '--lead'],
    ['consent', '--consent'],
    ['assign', '--assign'],
    ['owner', '--owner'],
    ['handoff', '--handoff'],
  ] as const) {
    const v = o[k];
    if (v === undefined) continue;
    const n = pyInt(v);
    if (n === null) return usage(`argument ${flag}: invalid int value: '${v}'`);
    ints[k] = n;
  }
  const choice = (flag: string, v: string | undefined, xs: string[]) =>
    v !== undefined && !xs.includes(v)
      ? usage(
          `argument ${flag}: invalid choice: '${v}' (choose from ${xs.map((x) => `'${x}'`).join(', ')})`,
        )
      : 0;
  if (choice('--purpose', o.purpose, crm.PURPOSES)) return 2;
  if (choice('--source', o.source, crm.CONSENT_SOURCES)) return 2;
  if (o.grant && o.withdraw) return usage('argument --withdraw: not allowed with argument --grant');
  if (o.status !== undefined && o.status.length !== 2) {
    return usage('argument --status: expected 2 arguments');
  }
  // --- đúng 1 thao tác + cờ đi kèm
  const has: Record<(typeof OPS)[number], boolean> = {
    'add-contact': o.addContact !== undefined,
    consent: ints.consent !== undefined,
    assign: ints.assign !== undefined,
    status: o.status !== undefined,
    report: Boolean(o.report),
    handoff: ints.handoff !== undefined,
    'load-dealers': o.loadDealers !== undefined && o.loadDealers !== false,
    owner: ints.owner !== undefined,
  };
  const chosen = OPS.filter((k) => has[k]);
  if (chosen.length !== 1) return usage(`cần đúng 1 thao tác: --${OPS.join(' | --')}`);
  const op = chosen[0] as (typeof OPS)[number];
  if (ints.lead !== undefined && op !== 'add-contact') {
    return usage('--lead chỉ dùng với --add-contact');
  }
  if (
    op !== 'consent' &&
    (o.purpose || o.grant || o.withdraw || o.source || o.evidence || o.policyVersion)
  ) {
    return usage(
      '--purpose/--grant/--withdraw/--source/--evidence/--policy-version chỉ dùng với --consent',
    );
  }
  if ((o.staff !== undefined) !== (op === 'owner')) {
    return usage('--owner LEAD cần --staff MA_NV (và --staff chỉ đi với --owner)');
  }
  if (o.province !== undefined && op !== 'assign') {
    return usage('--province chỉ dùng với --assign');
  }
  if (o.dealer !== undefined && !['consent', 'assign', 'handoff'].includes(op)) {
    return usage('--dealer chỉ dùng với --consent/--assign/--handoff');
  }
  if (o.dealer !== undefined && !crm.DEALER_CODE_RE.test(o.dealer)) {
    return usage('--dealer sai mẫu mã đại lý [A-Z0-9_-]{2,20}');
  }
  let by: string | null = null;
  if (op === 'report') {
    if (o.by !== undefined) return usage('--report chỉ đọc — không dùng --by');
  } else {
    try {
      by = crm.checkBy(o.by);
    } catch (e) {
      return usage((e as Error).message);
    }
  }
  if (op === 'consent') {
    if (!o.purpose || !o.source || !(o.grant || o.withdraw)) {
      return usage('--consent cần --purpose, --source và --grant|--withdraw');
    }
    if (o.purpose === 'dai_ly' && !o.dealer) {
      return usage('--purpose dai_ly cần --dealer (đồng ý ĐÍCH DANH)');
    }
    if (o.purpose !== 'dai_ly' && o.dealer) return usage('--dealer chỉ dùng với --purpose dai_ly');
    if (o.grant && !(o.evidence && o.policyVersion)) {
      return usage('--grant cần --evidence và --policy-version');
    }
  }
  if ((op === 'assign' || op === 'handoff') && !o.dealer) return usage(`--${op} cần --dealer`);
  let statusLead: bigint | null = null;
  if (op === 'status') {
    const [leadS, state] = o.status as [string, string];
    if (!/^[0-9]{1,18}$/.test(leadS) || !crm.LEAD_STATES.includes(state)) {
      return usage(`--status LEAD STATE — LEAD số, STATE ${crm.LEAD_STATES.join('|')}`);
    }
    statusLead = BigInt(leadS);
  }

  // --- kiểm dữ liệu vào TRƯỚC khi connect (fail-closed, không ghi gì)
  let keys: crm.VaultKeys | null = null;
  let rec: Record<string, unknown> | null = null;
  let regions: crm.Regions | null = null;
  let owner: { watch: crm.LeadOwnerCfg; shift: unknown } | null = null;
  try {
    if (op === 'add-contact' || op === 'handoff') keys = crm.loadVaultKey(env);
    if (op === 'add-contact') {
      rec = await readContactJson(o.addContact as string, d);
      crm.normPhone(rec.phone);
    }
    if (op === 'assign' || op === 'report' || op === 'load-dealers') {
      const file =
        op === 'load-dealers' && typeof o.loadDealers === 'string'
          ? o.loadDealers
          : (d.regionsFile ?? crm.REGIONS_FILE);
      regions = crm.loadRegions(file);
    }
    if (op === 'owner') {
      try {
        owner = {
          watch: section('lead_owner', d.watchFile) as unknown as crm.LeadOwnerCfg,
          shift: loadConfig('sales', d.directorsDir ?? DIRECTORS_DIR).business_hours,
        };
      } catch (e) {
        if (!(e instanceof DirectorConfigError)) throw e;
        throw new RangeError(`cấu hình khối sales lỗi: ${e.message}`);
      }
      if (!STAFF_RE.test(o.staff as string)) {
        throw new RangeError('--staff phải là MÃ nhân viên [A-Z0-9_-]{2,20} (không ghi tên)');
      }
      if (!owner.watch.staff_codes.length) {
        io.out(
          '[warn] chưa có danh sách mã nhân viên kinh doanh (lead_owner.staff_codes rỗng — Bên B cấp) — chỉ kiểm mẫu mã',
        );
      }
    }
  } catch (e) {
    if (e instanceof crm.VaultKeyError) {
      io.out(`[err] ${e.message}`);
      return 2;
    }
    if (e instanceof RangeError || e instanceof TypeError) {
      io.out(`[err] ${e.message} — không ghi gì.`);
      return 2;
    }
    throw e;
  }

  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.out(NO_DB);
    return 1;
  }
  const db = lease.db;
  try {
    const gated = GATED_OPS[op];
    if (gated) {
      const oid = op === 'load-dealers' ? 'dealers' : String(ints[op]);
      const why = await cliGate(db, by, 'sales', gated, 'crm', oid, { env, warn: io.err });
      if (why) {
        io.out(`[err] ${why} — không ghi.`);
        return 1;
      }
    }
    if (op === 'add-contact') {
      const [cid, isNew] = await crm.addContact(
        db,
        rec,
        keys as crm.VaultKeys,
        by,
        ints.lead ?? null,
      );
      io.out(
        `[ok] contact #${cid} (${isNew ? 'mới' : 'đã có'})` +
          (ints.lead ? ` — gắn lead #${ints.lead}` : ''),
      );
    } else if (op === 'consent') {
      const cid = await crm.recordConsent(
        db,
        ints.consent as bigint,
        o.purpose as string,
        Boolean(o.grant),
        o.source as string,
        by,
        o.evidence ?? null,
        o.policyVersion ?? null,
        o.dealer ?? null,
      );
      io.out(
        `[ok] consent #${cid}: contact #${ints.consent} ${o.purpose}` +
          (o.dealer ? `/${o.dealer}` : '') +
          (o.grant ? ' ĐỒNG Ý' : ' RÚT'),
      );
    } else if (op === 'load-dealers') {
      const res = await crm.loadDealers(db, regions as crm.Regions, by);
      io.out(`[ok] đại lý: mới=${res.new} cập nhật=${res.updated} giữ nguyên=${res.kept}`);
    } else if (op === 'assign') {
      const prov = await crm.assignLead(
        db,
        ints.assign as bigint,
        o.dealer as string,
        by,
        o.province ?? null,
        regions,
      );
      io.out(`[ok] lead #${ints.assign} → ${o.dealer} (${prov})`);
    } else if (op === 'owner') {
      const o2 = owner as { watch: crm.LeadOwnerCfg; shift: unknown };
      const due = await crm.assignOwner(db, ints.owner as bigint, o.staff, by, o2);
      io.out(
        `[ok] lead #${ints.owner} → người phụ trách ${o.staff}, hạn xử lý ${vnFormat(due, '%d/%m/%Y %H:%M')} (giờ VN)`,
      );
    } else if (op === 'status') {
      const state = (o.status as string[])[1] as string;
      const old = await crm.setLeadStatus(db, statusLead as bigint, state, by);
      io.out(`[ok] lead #${statusLead}: ${old} → ${state}`);
    } else if (op === 'report') {
      io.out(await crm.report(db, regions));
    } else {
      const payload = await crm.handoffPayload(
        db,
        ints.handoff as bigint,
        o.dealer as string,
        keys as crm.VaultKeys,
        by,
      );
      io.out('[ok] payload cho NGƯỜI chuyển tới đại lý (hệ thống không gửi):');
      io.out(JSON.stringify(payload, null, 2));
    }
    return 0;
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError || e instanceof crm.VaultKeyError) {
      io.out(`[err] ${e.message} — không ghi.`);
      return 1;
    }
    if (!isDbError(e)) throw e;
    const code = (e as { code?: string }).code;
    if (code === '42P01' || code === '42703') {
      io.out('[err] DB không truy cập được / thiếu bảng — chạy `python scripts/apply_schema.py`');
    } else io.out(`[err] lỗi DB — ${dbErrMsg(e)}`);
    return 1;
  } finally {
    await lease.release();
  }
}

@Command({
  name: 'crm',
  description:
    'CRM lead & đại lý (contact_vault + đồng ý). Agent không tự liên hệ khách/đại lý — mọi thao tác ghi do NGƯỜI chạy với --by.',
})
export class CrmCommand extends CommandRunner {
  async run(_args: string[], opts: CrmOpts): Promise<void> {
    process.exitCode = await crmMain(opts);
  }
  @Option({
    flags: '--add-contact <src>',
    description:
      "thêm liên hệ từ JSON {phone,name,email,address,province,source}: '-' = stdin, hoặc file NGOÀI repo (cần CONTACT_VAULT_KEY)",
  })
  parseAddContact(v: string): string {
    return v;
  }
  @Option({ flags: '--lead <id>', description: '(với --add-contact) gắn liên hệ vào lead' })
  parseLead(v: string): string {
    return v;
  }
  @Option({ flags: '--consent <contact_id>', description: 'ghi đồng ý/rút đồng ý cho 1 liên hệ' })
  parseConsent(v: string): string {
    return v;
  }
  @Option({ flags: '--purpose <p>', description: crm.PURPOSES.join('|') })
  parsePurpose(v: string): string {
    return v;
  }
  @Option({ flags: '--grant' })
  parseGrant(): boolean {
    return true;
  }
  @Option({ flags: '--withdraw' })
  parseWithdraw(): boolean {
    return true;
  }
  @Option({ flags: '--source <s>', description: crm.CONSENT_SOURCES.join('|') })
  parseSource(v: string): string {
    return v;
  }
  @Option({ flags: '--evidence <ref>', description: 'mã biên bản/scan (bắt buộc khi --grant)' })
  parseEvidence(v: string): string {
    return v;
  }
  @Option({
    flags: '--policy-version <v>',
    description: 'phiên bản nội dung đồng ý (bắt buộc khi --grant)',
  })
  parsePolicyVersion(v: string): string {
    return v;
  }
  @Option({
    flags: '--dealer <code>',
    description: 'mã đại lý (consent dai_ly / --assign / --handoff)',
  })
  parseDealer(v: string): string {
    return v;
  }
  @Option({ flags: '--assign <lead>', description: 'gán lead cho --dealer theo vùng' })
  parseAssign(v: string): string {
    return v;
  }
  @Option({
    flags: '--province <name>',
    description: '(với --assign) tỉnh của lead, nhận cả tên cũ',
  })
  parseProvince(v: string): string {
    return v;
  }
  @Option({
    flags: '--owner <lead>',
    description: 'gán người phụ trách (MÃ nhân viên --staff) + hạn xử lý theo giờ làm việc (v14.4)',
  })
  parseOwner(v: string): string {
    return v;
  }
  @Option({ flags: '--staff <ma_nv>', description: '(với --owner) mã nhân viên, KHÔNG ghi tên' })
  parseStaff(v: string): string {
    return v;
  }
  @Option({
    flags: '--status <lead_state...>',
    description: `LEAD STATE — đổi trạng thái lead (${crm.LEAD_STATES.join('|')})`,
  })
  parseStatus(v: string, prev: string[] = []): string[] {
    return [...prev, v];
  }
  @Option({ flags: '--report', description: 'báo cáo CRM (không PII, không cần khóa)' })
  parseReport(): boolean {
    return true;
  }
  @Option({
    flags: '--handoff <lead>',
    description: 'in payload lead cho --dealer (NGƯỜI tự chuyển; cần CONTACT_VAULT_KEY)',
  })
  parseHandoff(v: string): string {
    return v;
  }
  @Option({
    flags: '--load-dealers [path]',
    description: 'nạp đại lý từ file vùng (mặc định data/dealer_regions.json)',
  })
  parseLoadDealers(v?: string): string | boolean {
    return v ?? true;
  }
  @Option({ flags: '--by <name>', description: 'tên NGƯỜI thực hiện (bắt buộc khi ghi)' })
  parseBy(v: string): string {
    return v;
  }
}

@Command({
  name: 'lead-store',
  description: 'gom lead từ convlog (data/conversations.jsonl) vào bảng leads (insert-only)',
})
export class LeadStoreCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await leadStoreJob();
  }
}
