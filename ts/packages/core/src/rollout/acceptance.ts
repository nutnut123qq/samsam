import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pyStrip } from '../env.js';
import type { Db } from '../ops/deps.js';
import { isPlainObject, parseJsonBytes } from '../ops/py.js';
import { loadRouting } from '../ops/red-alert.js';
import { pyStr } from '../ops/store.js';
import { isDbError } from '../ops/tx.js';
import { dataPath } from '../paths.js';
import { normName } from '../security/auth.js';
import { pyTruthy } from '../security/py.js';
import { pgErrName, pyDumps, rowsOf, sp } from './counters.js';

// Port `pipelines/acceptance.py` (đợt an toàn + nghiệm thu A01/A02) — ma trận nghiệm thu 96 mục
// (89 tính năng AI + 7 hạng mục khác). Đọc danh mục (KHÔNG đổi) + cấu hình + (tùy chọn) DB; không
// ghi gì. READY_FOR_TRIAL chỉ khi ĐỦ mọi điều kiện áp dụng: E1 hạ tầng Bên B xác nhận, E2 lịch
// nghỉ chốt, E3 người nhận cảnh báo đỏ độc lập; B1 khối có người ủy quyền, B2 MỌI người duyệt có
// login hợp lệ đúng khối (không đọc DB = CHƯA KIỂM, lỗi DB = không kiểm được → đều KHÔNG READY),
// B3 bằng chứng đăng nhập thật của ĐÚNG người; I1 co_code, I2 nguồn đếm không trùng, I3 không
// blocker, I4 điều kiện riêng (persona giả lập cần DPIA ký). Không suy "đạt" từ test dev.

export const DATA = dataPath();
export const CATALOG = dataPath('contract_features.json');
export const READY = 'READY_FOR_TRIAL';
export const NOT_READY = 'CHUA_SAN_SANG';

type Raw = Record<string, unknown>;

function json(path: string): unknown {
  try {
    return parseJsonBytes(readFileSync(path));
  } catch {
    return null;
  }
}
const obj = (v: unknown): Raw => (isPlainObject(v) ? v : {});

/** Danh mục hỏng (Python `SystemExit("[lỗi] ...")` → exit 1). */
export class CatalogBroken extends Error {}

export function catalog(path: string = CATALOG): Raw[] {
  const doc = json(path);
  if (!isPlainObject(doc) || !Array.isArray(doc.features)) {
    throw new CatalogBroken(`[lỗi] danh mục ${basename(path)} hỏng`);
  }
  return doc.features as Raw[];
}

/** Điều kiện môi trường chung → {mã: lý do thiếu | null}. */
export function envState(data: string = DATA): Record<string, string | null> {
  const ts = obj(json(join(data, 'tai_san_hop_tac.json')));
  const cal = obj(json(join(data, 'rollout_config.json')));
  const routing = loadRouting(join(data, 'red_alert_routing.json'));
  return {
    E1:
      ts.trang_thai === 'da_xac_nhan'
        ? null
        : 'hạ tầng/tài sản Bên B chưa xác nhận (server, backup offsite, giám sát ngoài máy, quyền quản trị — tai_san_hop_tac.json)',
    E2: pyTruthy(cal.holidays)
      ? null
      : 'lịch nghỉ lễ/Tết chưa chốt (rollout_config.json holidays rỗng)',
    E3:
      routing.recipients.length && !routing.problems.length
        ? null
        : 'người nhận cảnh báo đỏ độc lập chưa đủ (red_alert_routing.json)',
  };
}

// Python `auth._norm_name` — bản duy nhất ở security/auth.
export { normName };

export type Login = { person: string; blocks: string[]; valid: boolean; last_login: unknown };

/** B1 người được ủy quyền; B2 LUÔN kiểm: `logins` null = chưa kiểm (không đọc DB), string = không
 * kiểm được (lỗi DB), list = ánh xạ đã đọc — MỌI người duyệt đã cấu hình phải có ánh xạ hợp lệ
 * đúng khối (người khác cùng khối không tính thay). */
export function blockState(
  block: string,
  data: string = DATA,
  logins: Login[] | string | null = null,
): Record<string, string | null> {
  const cfg = obj(json(join(data, 'directors', `${block}.json`)));
  const raw = pyTruthy(cfg.approvers) && Array.isArray(cfg.approvers) ? cfg.approvers : [];
  const appr = raw.filter((a) => pyStrip(pyStr(a)) !== '');
  const out: Record<string, string | null> = {
    B1: appr.length ? null : `khối ${block} chưa có người Bên B ủy quyền (approvers rỗng)`,
  };
  if (logins === null) {
    out.B2 = 'CHƯA KIỂM login người duyệt (không đọc DB — chạy `--db` trên server Bên B)';
  } else if (typeof logins === 'string') {
    out.B2 = `không kiểm được login người duyệt (${logins})`;
  } else if (appr.length) {
    const mine = logins.filter((r) => r.valid && r.blocks.includes(block));
    const ok = new Set(mine.map((r) => normName(r.person)));
    const lack = appr.filter((a) => !ok.has(normName(a)));
    out.B2 = lack.length
      ? `khối ${block}: người duyệt chưa có login hợp lệ đúng khối trong human_logins: ${lack.map(pyStr).join(', ')}`
      : null;
    // B3 (vòng r8): bằng chứng ĐĂNG NHẬP THẬT trên login đang dùng được
    const seen = new Set(
      mine
        .filter((r) => r.last_login instanceof Date || pyTruthy(r.last_login))
        .map((r) => normName(r.person)),
    );
    const never = appr.filter((a) => ok.has(normName(a)) && !seen.has(normName(a)));
    out.B3 = never.length
      ? `khối ${block}: chưa có bằng chứng đăng nhập thật (human_login_checks) của: ${never.map(pyStr).join(', ')}`
      : null;
  }
  return out;
}

export function sourceLabel(s: Raw): string {
  if ('report' in s) return `báo cáo \`${pyStr(s.report)}*\``;
  if (s.table === 'approval_queue') {
    return `hàng duyệt \`${pyStr(s.block ?? null)}/${pyStr(s.object_type ?? null)}\``;
  }
  if (s.table === 'content_drafts') {
    const v = pyTruthy(s.content_type) ? s.content_type : (s.created_by ?? null);
    return `nháp \`${pyStr(v)}\``;
  }
  if ('table' in s) return `bảng \`${pyStr(s.table)}\``;
  if ('file' in s) return `tệp \`${pyStr(s.file)}\``;
  return pyDumps(s);
}

const srcsOf = (f: Raw): Raw[] =>
  pyTruthy(f.output_sources) && Array.isArray(f.output_sources) ? (f.output_sources as Raw[]) : [];

/** {id: [id khác dùng cùng nguồn đếm]} — trùng y hệt hoặc tiền tố báo cáo lồng nhau. */
export function sourceOverlaps(feats: Raw[]): Record<string, string[]> {
  const keys = feats.flatMap((f) =>
    srcsOf(f).map((s) => [f.id as string, pyDumps(s, true), s.report] as const),
  );
  const out: Record<string, string[]> = {};
  keys.forEach(([a, ka, ra], i) => {
    for (const [b, kb, rb] of keys.slice(i + 1)) {
      if (a === b) continue;
      const same =
        ka === kb ||
        (typeof ra === 'string' &&
          typeof rb === 'string' &&
          ra !== '' &&
          rb !== '' &&
          (ra.startsWith(rb) || rb.startsWith(ra)));
      if (same) {
        out[a] = [...(out[a] ?? []), b];
        out[b] = [...(out[b] ?? []), a];
      }
    }
  });
  return out;
}

/** Tiêu chí kiểm HÀNH VI của mục (PL02 mục 1 + đầu ra cụ thể). */
export function criteria(f: Raw): string {
  const srcs = srcsOf(f).map(sourceLabel).join('; ');
  if (f.pham_vi !== 'tinh_nang_ai') {
    return (
      `Hạng mục (${pyStr(f.pham_vi ?? null)}): ${pyStr(f.dau_ra ?? null)} — nghiệm thu theo hồ sơ hạng mục + biên bản hai bên (PL02 mục 1d–đ); ` +
      (srcs ? `bằng chứng đếm: ${srcs}` : 'không có bộ đếm tự động')
    );
  }
  return (
    `Chạy thử nội bộ trên server Bên B, dữ liệu THẬT (không mẫu): ≥50 đầu ra DISTINCT theo ${srcs || 'nguồn — CHƯA CÓ'}, rải ≥5 ` +
    `ngày làm việc; mỗi đầu ra «${pyStr(f.dau_ra ?? null)}» qua kiểm tự động, chỉ ghi nội bộ (không gửi/đăng). Có người duyệt ≥10 ngày làm ` +
    `việc: ${pyStr(f.nguoi_duyet ?? null)} (Bên B) duyệt TỪNG đầu ra đúng phiên bản trước khi dùng; 0 lỗi nghiêm trọng (lỗi → tắt, về chạy thử).`
  );
}

export function evaluate(
  f: Raw,
  env: Record<string, string | null>,
  blk: Record<string, string | null>,
  overlaps: Record<string, string[]>,
  data: string = DATA,
): [string, string[]] {
  const miss = [...Object.values(env), ...Object.values(blk)].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  if (f.code_status !== 'co_code') miss.unshift(`mã chưa đủ (${pyStr(f.code_status ?? null)})`);
  if (!pyTruthy(f.output_sources)) miss.unshift('không có nguồn đếm đầu ra (output_sources)');
  const ov = Object.hasOwn(overlaps, f.id as string) ? overlaps[f.id as string] : undefined;
  if (ov !== undefined) {
    miss.push(`nguồn đếm dùng chung với ${[...new Set(ov)].sort().join(', ')}`);
  }
  const b = pyStrip(typeof f.blocker === 'string' ? f.blocker : '');
  if (b) miss.push(`blocker danh mục: ${b}`);
  const mods = pyTruthy(f.modules) && Array.isArray(f.modules) ? (f.modules as string[]) : [];
  if (mods.join(' ').includes('persona_sim.py')) {
    const sim = obj(json(join(data, 'sim_config.json')));
    if (sim.dpia_signed !== true) miss.push('DPIA chưa ký (sim_config.json dpia_signed)');
  }
  return [miss.length ? NOT_READY : READY, miss];
}

/** [{person, blocks, valid, last_login}] — valid = ánh xạ active + role dùng được NGAY LÚC KIỂM;
 * last_login = lần đăng nhập thật gần nhất của ĐÚNG login VÀ ĐÚNG người ánh xạ hiện hành. Lỗi
 * DB/quyền → tên lỗi (không bao giờ coi là đạt). */
export async function personLogins(db: Db): Promise<Login[] | string> {
  let rs: unknown[][];
  try {
    rs = await sp(db, () =>
      rowsOf(
        db,
        "select h.person, h.blocks, coalesce(h.active and r.rolcanlogin and not r.rolsuper and pg_has_role(r.oid, 'app_human', 'MEMBER')" +
          ' and (r.rolvaliduntil is null or r.rolvaliduntil > now()) and r.rolconnlimit <> 0 and' +
          " has_database_privilege(r.oid, current_database(), 'CONNECT'), false), (select max(c.checked_at) from human_login_checks c" +
          ' where c.db_login = h.db_login and p10_norm(c.person) = p10_norm(h.person)) from human_logins h left join' +
          ' pg_roles r on r.rolname = h.db_login',
        [],
      ),
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    return pgErrName(e);
  }
  return rs.map(([p, b, v, ts]) => ({
    person: p as string,
    blocks: Array.isArray(b) ? (b as string[]) : [],
    valid: v === true,
    last_login: ts,
  }));
}

export async function ledger(db: Db): Promise<Record<string, [string, Date]>> {
  try {
    const rs = await sp(db, () =>
      rowsOf(db, 'select feature_id, stage, stage_since from feature_rollout', []),
    );
    return Object.fromEntries(rs.map((r) => [r[0] as string, [r[1] as string, r[2] as Date]]));
  } catch (e) {
    if (!isDbError(e)) throw e;
    return {};
  }
}

export type MatrixRow = {
  id: string;
  phong_ban: unknown;
  pham_vi: unknown;
  giai_doan: unknown;
  ten: unknown;
  nguon: unknown;
  dau_ra: unknown;
  nguon_dem: string[];
  nguoi_duyet: unknown;
  bang_chung_code: string[];
  so_rollout: string | null;
  acceptance_status: unknown;
  status: string;
  thieu: string[];
  buoc_ke: string;
  tieu_chi: string;
};

/** Ma trận từ dữ liệu đã đọc (thuần). */
export function buildRows(
  feats: Raw[],
  data: string,
  env: Record<string, string | null>,
  logins: Login[] | string | null,
  led: Record<string, [string, Date]>,
): MatrixRow[] {
  const ov = sourceOverlaps(feats);
  return feats.map((f) => {
    const [status, miss] = evaluate(
      f,
      env,
      blockState(f.phong_ban as string, data, logins),
      ov,
      data,
    );
    const st = Object.hasOwn(led, f.id as string) ? led[f.id as string] : undefined;
    const nxt =
      status === READY
        ? 'Bắt đầu chạy thử nội bộ (PL02 1a) trên server Bên B — người chịu trách nhiệm ghi ngày bắt đầu thật'
        : `Chuẩn bị: ${miss[0]}`;
    return {
      id: f.id as string,
      phong_ban: f.phong_ban,
      pham_vi: f.pham_vi,
      giai_doan: f.giai_doan,
      ten: f.ten,
      nguon: f.nguon ?? null,
      dau_ra: f.dau_ra ?? null,
      nguon_dem: srcsOf(f).map(sourceLabel),
      nguoi_duyet: f.nguoi_duyet ?? null,
      bang_chung_code:
        pyTruthy(f.bang_chung) && Array.isArray(f.bang_chung) ? (f.bang_chung as string[]) : [],
      so_rollout: st ? st[0] : null,
      acceptance_status: f.acceptance_status ?? null,
      status,
      thieu: miss,
      buoc_ke: nxt,
      tieu_chi: criteria(f),
    };
  });
}

/** Python `rows(feats, data, conn)`: `db` null = không đọc DB (B2 CHƯA KIỂM → không READY). */
export async function rows(
  feats: Raw[] | null = null,
  data: string = DATA,
  db: Db | null = null,
): Promise<MatrixRow[]> {
  const fs = feats ?? catalog();
  const env = envState(data);
  const logins = db !== null ? await personLogins(db) : null;
  const led = db !== null ? await ledger(db) : {};
  return buildRows(fs, data, env, logins, led);
}

export function summary(rs: MatrixRow[]): Record<string, number> {
  const n = (p: (r: MatrixRow) => boolean) => rs.filter(p).length;
  return {
    mau_so: rs.length,
    tinh_nang_ai: n((r) => r.pham_vi === 'tinh_nang_ai'),
    hang_muc_khac: n((r) => r.pham_vi !== 'tinh_nang_ai'),
    ready_for_trial: n((r) => r.status === READY),
    chay_thu: n((r) => r.so_rollout === 'chay_thu'),
    co_nguoi_duyet: n((r) => r.so_rollout === 'co_nguoi_duyet'),
    van_hanh: n((r) => r.so_rollout === 'van_hanh'),
    du_ho_so: 0, // hồ sơ đủ = bằng chứng chạy thử + duyệt THẬT
    da_nghiem_thu: n((r) => r.acceptance_status === 'da_nghiem_thu'),
  };
}

const esc = (t: unknown): string =>
  (pyTruthy(t) ? pyStr(t) : '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderMd(rs: MatrixRow[], source: string, data: string = DATA): string {
  const s = summary(rs);
  const env = envState(data);
  const ledNote = rs.some((r) => r.so_rollout)
    ? 'DB đã đọc'
    : 'không đọc/không có trên server Bên B';
  const lines = [
    '# Ma trận nghiệm thu — 96 mục theo dõi (sinh tự động, không sửa tay)',
    '',
    `Sinh bằng \`python -m pipelines.acceptance --matrix --out docs/handover/ma-tran-nghiem-thu.md\` từ \`data/contract_features.json\` + cấu hình sẵn có (${source}). Danh mục KHÔNG đổi; READY_FOR_TRIAL chỉ khi đủ mọi điều kiện (đầu \`pipelines/acceptance.py\`).`,
    '',
    `Mẫu số ${s.mau_so} mục = ${s.tinh_nang_ai} tính năng AI + ${s.hang_muc_khac} hạng mục khác. Sẵn sàng chạy thử: **${s.ready_for_trial}/${s.mau_so}** · đang chạy thử: ${s.chay_thu} · có người duyệt: ${s.co_nguoi_duyet} · vận hành: ${s.van_hanh} · đủ hồ sơ: ${s.du_ho_so} · đã nghiệm thu: **${s.da_nghiem_thu}/${s.mau_so}** (sổ rollout: ${ledNote}).`,
    '',
    '## Điều kiện môi trường chung',
    '',
    ...Object.entries(env).map(([k, v]) => `- ${k}: ${v === null ? 'ĐẠT' : `THIẾU — ${v}`}`),
    '',
    '## Từng mục',
    '',
    '| ID | Căn cứ DOCX | GĐ | Đầu ra | Nguồn đếm / provenance | Người duyệt | Môi trường | Bằng chứng (code / tích hợp / triển khai / chạy thử) | Trạng thái | Thiếu gì | Bước được phép kế | Tiêu chí kiểm hành vi |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rs) {
    let ev = r.bang_chung_code.length
      ? `test: ${r.bang_chung_code.map((b) => basename(b)).join(', ')}`
      : 'test: —';
    ev += ` / tích hợp: chưa / triển khai: chưa / chạy thử: ${r.so_rollout || 'chưa'}`;
    lines.push(
      `| ${r.id} | ${esc(r.nguon)} | ${pyStr(r.giai_doan)} | ${esc(r.dau_ra)} | ${esc(r.nguon_dem.join('; ') || '—')} | ${esc(r.nguoi_duyet)} | server Bên B: chưa bàn giao | ${esc(ev)} | ${r.status} | ${esc(r.thieu.join('; '))} | ${esc(r.buoc_ke)} | ${esc(r.tieu_chi)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export type AcceptanceCliOpts = { matrix?: boolean; summary?: boolean; out?: string; db?: boolean };

/** `python -m pipelines.acceptance` → exit code. `open` mở kết nối CHỈ ĐỌC khi `--db`. */
export async function acceptanceCli(
  o: AcceptanceCliOpts,
  open: () => Promise<{ db: Db; release: () => Promise<void> } | null>,
  log: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): Promise<number> {
  if (Number(Boolean(o.matrix)) + Number(Boolean(o.summary)) !== 1) {
    err('[err] cần đúng 1 thao tác: --matrix | --summary');
    return 2;
  }
  let lease: { db: Db; release: () => Promise<void> } | null = null;
  if (o.db) {
    lease = await open();
    if (lease === null) {
      err('[lỗi] không kết nối được Postgres');
      return 2;
    }
  }
  let rs: MatrixRow[];
  try {
    rs = await rows(null, DATA, lease ? lease.db : null);
  } catch (e) {
    if (!(e instanceof CatalogBroken)) throw e;
    err(e.message);
    return 1;
  } finally {
    await lease?.release();
  }
  if (o.summary) {
    log(pyDumps(summary(rs)));
    return 0;
  }
  const md = renderMd(rs, o.db ? 'có đọc DB' : 'không đọc DB');
  if (o.out) {
    writeFileSync(o.out, Buffer.from(md, 'utf8'));
    log(`[done] ${o.out} — ${rs.length} mục`);
  } else process.stdout.write(md);
  return 0;
}
