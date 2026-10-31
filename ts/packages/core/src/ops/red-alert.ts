import { basename } from 'node:path';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { approvalEnforced, type Env, pyStrip } from '../env.js';
import { dataPath } from '../paths.js';
import { type Db, dep } from './deps.js';
import { jobRun } from './job-runs.js';
import { parseDay, VN_OFFSET_MS, vnDate, vnFormat, weekday } from './period.js';
import {
  cpLen,
  cpSlice,
  foldPrefix,
  isInt,
  isPlainObject,
  isPrintable,
  type JsonFileError,
  pyInt,
  readJson,
  squash,
} from './py.js';
import { pyFloatStr, pyRound } from './py-json.js';
import { pyStr } from './store.js';
import { dbMsg, isDbError, withTx } from './tx.js';

// Port `pipelines/red_alert.py` (v4.0 W40.4 → v15 P12.3) — cảnh báo đỏ tới người nhận ĐỘC LẬP.
// - `red_alerts` append-only. Người nhận đọc từ `data/red_alert_routing.json`: role CHỈ allowlist
//   INDEPENDENT_ROLES (phap_che, bks) trừ excluded_roles (luôn gồm tgd, ha_tang — người có thể dập
//   cảnh báo); `raiseAlert` lọc LẠI cả routing truyền tay. Không có người nhận hợp lệ → VẪN ghi
//   (route_error), trả false — fail-closed, không gửi nhầm TGĐ/hạ tầng.
// - GỬI THẬT qua SMTP (nodemailer, STARTTLS bắt buộc + kiểm chứng chỉ/hostname): RED_ALERT_NOTIFY=email
//   + SMTP_HOST [SMTP_PORT 587, SMTP_USER/SMTP_PASSWORD, SMTP_FROM]; kênh `email:<địa chỉ>` |
//   `email:$TEN_BIEN`. Mỗi lần gửi 1 dòng `red_alert_deliveries` (không lưu địa chỉ). true CHỈ khi ≥1
//   người nhận ĐÃ GỬI ĐƯỢC.
// - `deliverPending` gửi lại cảnh báo 48 giờ chưa gửi được/chưa xác nhận (trần MAX_ATTEMPTS/người).
// - `ack` cho MỌI cảnh báo gốc: người thật; chế độ thực chỉ người nhận độc lập (auth.cliGate).
// - `escalate`: gốc quá 2 giờ ĐỒNG HỒ chưa xác nhận → đúng 1 bản leo thang (unique index chung),
//   trần 50/lần; TỒN (quá hạn trước mốc bật) theo `backlog.chinh_sach` (null = KHÔNG tự leo thang);
//   cấp 2 / người trực ngoài giờ CHỈ khi routing cấu hình (không tự chọn người).

export const ROUTING = dataPath('red_alert_routing.json');
export const ALWAYS_EXCLUDED = ['tgd', 'ha_tang'];
// Thêm vai trò = sửa code + Pháp chế xác nhận (external-dep), không qua file.
export const INDEPENDENT_ROLES = ['phap_che', 'bks'];
export const MISSING = 'thiếu người nhận độc lập (external-dep)';
export const NOT_SENT = 'chưa gửi được tới người nhận nào';
export const NOTIFY_TIMEOUT_MS = 10_000;
export const DELIVER_WINDOW_MS = 48 * 3600_000;
export const MAX_ATTEMPTS = 5;
const BY_MAX = 100;
const NOTE_MAX = 500;
const BIGINT_MAX = 2n ** 63n - 1n;
// PL02 mục 3: 02 giờ ĐỒNG HỒ, hằng code (cấu hình không nới được).
export const ESCALATE_AFTER_MS = 2 * 3600_000;
export const ESC_LABEL = 'CHƯA XÁC NHẬN';
export const ESC_PREFIX = `[LEO THANG — ${ESC_LABEL}] `;
export const ESC_MAX_PER_RUN = 50;
export const START_ACTION = 'red_alert_escalation_start';
export const BACKLOG_POLICIES: Record<string, string> = {
  leo_thang_dan: 'leo thang dần tồn (cũ trước, chung trần 50/lần)',
  khong_leo_thang: 'không leo thang tồn (vẫn ở --open)',
};
export const BACKLOG_UNSET =
  'chính sách xử lý tồn CHƯA QUYẾT (Bên B — routing `backlog.chinh_sach`) → tồn KHÔNG tự leo thang';
export const CAP2_LABEL = 'CẤP 2 — CHƯA XÁC NHẬN';
export const CAP2_PREFIX = `[LEO THANG ${CAP2_LABEL}] `;
export const CAP2_SUFFIX = ':cap2';
export const CAP2_MAX_MIN = 7 * 24 * 60;
export const CAP2_UNSET =
  'leo thang cấp 2 CHƯA CẤU HÌNH (Bên B chỉ định người cấp 2 + số phút — routing `cap2`) → không leo thang cấp 2';
export const OFF_UNSET =
  'người trực ngoài giờ CHƯA CẤU HÌNH (Bên B — routing `ngoai_gio`) → ngoài giờ chỉ gửi người nhận cấp 1';

export type Recipient = { name: string; role: string; channel: string };
export type Routing = Record<string, unknown>;
export type Sender = (to: string, subject: string, body: string) => Promise<void>;
export type Backlog = { policy: string | null; by: string | null; ref: string | null };
export type Cap2 = { afterMin: number; recipients: Recipient[] };
export type OffHours = {
  thu: Set<number>;
  tu: number; // phút trong ngày
  den: number;
  ngay_nghi: Set<string>;
  recipients: Recipient[];
};
export type Tiers = {
  backlog: Backlog;
  cap2: Cap2 | null;
  ngoai_gio: OffHours | null;
  problems: string[];
};

function norm(v: unknown): string {
  return typeof v === 'string' ? pyStrip(v).toLowerCase() : '';
}

/** Lọc recipients theo allowlist trừ `excluded` (+ luôn loại TGĐ/hạ tầng) → [hợp lệ, problems]. */
export function validRecipients(raw: unknown, excluded: unknown): [Recipient[], string[]] {
  const excl = new Set([
    ...(Array.isArray(excluded) ? excluded : []).map(norm),
    ...ALWAYS_EXCLUDED,
  ]);
  const out: Recipient[] = [];
  const problems: string[] = [];
  (Array.isArray(raw) ? raw : []).forEach((r, i) => {
    if (!isPlainObject(r)) {
      problems.push(`recipients[${i}] không phải object`);
      return;
    }
    const name = typeof r.name === 'string' ? pyStrip(r.name) : '';
    const channel = typeof r.channel === 'string' ? pyStrip(r.channel) : '';
    const role = norm(r.role);
    if (!name || !channel || !role) {
      problems.push(`recipients[${i}] thiếu name/role/channel`);
      return;
    }
    if (excl.has(role) || !INDEPENDENT_ROLES.includes(role)) {
      problems.push(
        `recipients[${i}] role '${role}' bị loại (chỉ nhận ${INDEPENDENT_ROLES.join(', ')} — độc lập với người có thể dập cảnh báo)`,
      );
      return;
    }
    out.push({ name, role, channel });
  });
  return [out, problems];
}

function human(v: unknown): string {
  const s = typeof v === 'string' ? squash(v) : '';
  const f = foldPrefix(s);
  const ok =
    s !== '' &&
    cpLen(s) <= BY_MAX &&
    isPrintable(s) &&
    !f.startsWith('agent:') &&
    !f.startsWith('system:');
  return ok ? s : '';
}

/** Chính sách tồn → [{policy, by, ref}, problems]; thiếu/lỗi → policy null (không tự gửi tồn). */
export function backlogCfg(raw: unknown): [Backlog, string[]] {
  const none: Backlog = { policy: null, by: null, ref: null };
  if (raw === null || raw === undefined) return [none, []];
  if (!isPlainObject(raw)) return [none, ['backlog không phải object — coi như chưa quyết']];
  const pol = raw.chinh_sach ?? null;
  if (pol === null) return [none, []];
  if (typeof pol !== 'string' || !(pol in BACKLOG_POLICIES)) {
    return [
      none,
      [
        `backlog.chinh_sach '${cpSlice(pyStr(pol), 0, 40)}' không hợp lệ (${Object.keys(BACKLOG_POLICIES).join(' | ')}) — coi như chưa quyết`,
      ],
    ];
  }
  const by = human(raw.quyet_boi);
  const ref = human(raw.can_cu);
  if (!by || !ref) {
    return [
      none,
      [
        'backlog.chinh_sach đã đặt nhưng thiếu quyet_boi (người thật) / can_cu — coi như chưa quyết',
      ],
    ];
  }
  return [{ policy: pol, by, ref }, []];
}

function emptyObj(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function falsy(v: unknown): boolean {
  // Python `not rc` cho giá trị JSON.
  return (
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    emptyObj(v)
  );
}

/** Cấp 2 → [{afterMin, recipients} | null, problems]. */
export function cap2Cfg(raw: unknown, excluded: unknown): [Cap2 | null, string[]] {
  if (raw === null || raw === undefined || emptyObj(raw)) return [null, []];
  if (!isPlainObject(raw)) return [null, ['cap2 không phải object — chưa cấu hình']];
  const m = raw.sau_phut ?? null;
  const rc = raw.recipients;
  if (m === null && falsy(rc)) return [null, []];
  const probs: string[] = [];
  if (!isInt(m) || !(m >= 1 && m <= CAP2_MAX_MIN)) {
    probs.push(`cap2.sau_phut cần số nguyên 1..${CAP2_MAX_MIN}`);
  }
  const [valid, p2] = validRecipients(rc, excluded);
  probs.push(...p2.map((x) => `cap2.${x}`));
  if (!valid.length) probs.push('cap2 không có người nhận hợp lệ');
  if (probs.length) return [null, probs.map((x) => `${x} — không leo thang cấp 2`)];
  return [{ afterMin: m as number, recipients: valid }, []];
}

/** Python `_hhmm`: 'HH:MM' (mỗi phần đúng 2 ký tự, `int()` được, giờ hợp lệ) → phút | null. */
function hhmm(v: unknown): number | null {
  const parts = pyStr(v).split(':');
  if (parts.length !== 2) return null;
  const [h, mi] = parts as [string, string];
  if (cpLen(h) !== 2 || cpLen(mi) !== 2) return null;
  const pi = (s: string) => (/^[ +-]?\d+ ?$/.test(s) ? Number(s.trim()) : null);
  const hh = pi(h);
  const mm = pi(mi);
  if (hh === null || mm === null || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Ngoài giờ → [{thu, tu, den, ngay_nghi, recipients} | null, problems]. */
export function offHoursCfg(raw: unknown, excluded: unknown): [OffHours | null, string[]] {
  if (raw === null || raw === undefined || emptyObj(raw)) return [null, []];
  if (!isPlainObject(raw)) return [null, ['ngoai_gio không phải object — chưa cấu hình']];
  let g = raw.gio_lam_viec ?? null;
  const rc = raw.nguoi_truc;
  if (g === null && falsy(rc)) return [null, []];
  const probs: string[] = [];
  g = isPlainObject(g) ? g : {};
  const gg = g as Record<string, unknown>;
  const thu = gg.thu;
  const tu = hhmm(gg.tu);
  const den = hhmm(gg.den);
  if (!Array.isArray(thu) || thu.length === 0 || !thu.every((x) => isInt(x) && x >= 0 && x <= 6)) {
    probs.push('ngoai_gio.gio_lam_viec.thu cần list 0..6 (0 = thứ Hai)');
  }
  if (tu === null || den === null || !(tu < den)) {
    probs.push("ngoai_gio.gio_lam_viec.tu/den cần 'HH:MM', tu < den");
  }
  const nghi = new Set<string>();
  const rawNghi = gg.ngay_nghi;
  const list: unknown[] = falsy(rawNghi)
    ? []
    : Array.isArray(rawNghi)
      ? rawNghi
      : typeof rawNghi === 'string'
        ? Array.from(rawNghi)
        : isPlainObject(rawNghi)
          ? Object.keys(rawNghi)
          : [rawNghi];
  for (const x of list) {
    // KHÁC Python có chủ đích: chỉ nhận 'YYYY-MM-DD' (fromisoformat còn nhận 20261012/2026-W42-1) —
    // ngày lạ = cấu hình dở → coi như chưa cấu hình (chặt hơn).
    if (typeof x === 'string' && parseDay(x) !== null) nghi.add(x);
    else
      probs.push(
        `ngoai_gio.gio_lam_viec.ngay_nghi '${cpSlice(pyStr(x), 0, 12)}' không phải YYYY-MM-DD`,
      );
  }
  const [valid, p2] = validRecipients(rc, excluded);
  probs.push(...p2.map((x) => `ngoai_gio.nguoi_truc: ${x}`));
  if (!valid.length) probs.push('ngoai_gio không có người trực hợp lệ');
  if (probs.length) return [null, probs.map((x) => `${x} — không gửi người trực`)];
  return [
    {
      thu: new Set(thu as number[]),
      tu: tu as number,
      den: den as number,
      ngay_nghi: nghi,
      recipients: valid,
    },
    [],
  ];
}

/** THUẦN: `now` ngoài giờ làm việc theo giờ VN? */
export function isOffHours(cfg: OffHours, now: Date): boolean {
  const d = vnDate(now);
  const msOfDay = (now.getTime() + VN_OFFSET_MS) % 86_400_000;
  return (
    !cfg.thu.has(weekday(d)) ||
    cfg.ngay_nghi.has(d) ||
    !(cfg.tu * 60_000 <= msOfDay && msOfDay < cfg.den * 60_000)
  );
}

/** Cấu hình tồn/cấp 2/ngoài giờ đã kiểm (cả routing truyền tay). */
export function tiers(routing: unknown): Tiers {
  const r = isPlainObject(routing) ? routing : {};
  const ex = r.excluded_roles || [];
  const [b, p1] = backlogCfg(r.backlog);
  const [c2, p2] = cap2Cfg(r.cap2, ex);
  const [og, p3] = offHoursCfg(r.ngoai_gio, ex);
  return { backlog: b, cap2: c2, ngoai_gio: og, problems: [...p1, ...p2, ...p3] };
}

const people = (rs: Recipient[]) => rs.map((r) => `${r.name} (${r.role})`).join(', ');

export function tierLines(t: Tiers): string[] {
  const b = t.backlog;
  const out = [
    b.policy === null
      ? `[tồn] ${BACKLOG_UNSET}`
      : `[tồn] ${b.policy} (${BACKLOG_POLICIES[b.policy]}) — quyết bởi ${b.by}, căn cứ ${b.ref}`,
  ];
  const c2 = t.cap2;
  out.push(
    c2 === null
      ? `[cấp 2] ${CAP2_UNSET}`
      : `[cấp 2] sau ${c2.afterMin} phút kể từ leo thang cấp 1 → ${people(c2.recipients)}`,
  );
  const og = t.ngoai_gio;
  out.push(
    og === null
      ? `[ngoài giờ] ${OFF_UNSET}`
      : `[ngoài giờ] giờ làm việc thứ [${[...og.thu].sort((a, b) => a - b).join(', ')}] ${fmtMin(og.tu)}–${fmtMin(og.den)} (giờ VN), ngoài giờ gửi thêm: ${people(og.recipients)}`,
  );
  return out;
}

export type LoadedRouting = {
  recipients: Recipient[];
  excluded_roles: string[];
  backlog: unknown;
  cap2: unknown;
  ngoai_gio: unknown;
  problems: string[];
};

/** Không ném: file hỏng → recipients [] + problems. */
export function loadRouting(path: string = ROUTING): LoadedRouting {
  const name = basename(path);
  const problems: string[] = [];
  let cfg: unknown = {};
  try {
    cfg = readJson(path);
  } catch (e) {
    const t = (e as JsonFileError).pyType;
    problems.push(t === 'FileNotFoundError' ? `không có file ${name}` : `${name} hỏng: ${t}`);
  }
  if (!isPlainObject(cfg)) {
    problems.push(`${name} không phải object JSON`);
    cfg = {};
  }
  const c = cfg as Record<string, unknown>;
  const rawEx = Array.isArray(c.excluded_roles) ? c.excluded_roles : [];
  const excluded = [...new Set([...rawEx.map(norm).filter(Boolean), ...ALWAYS_EXCLUDED])].sort();
  const [recipients, probs] = validRecipients(c.recipients, excluded);
  const out = {
    recipients,
    excluded_roles: excluded,
    backlog: c.backlog ?? null,
    cap2: c.cap2 ?? null,
    ngoai_gio: c.ngoai_gio ?? null,
  };
  return { ...out, problems: [...problems, ...probs, ...tiers(out).problems] };
}

/** Mask PII trong mọi chuỗi của detail (giữ cấu trúc JSON). */
function mask(o: unknown): unknown {
  const m = dep('maskPii');
  if (typeof o === 'string') return m(o);
  if (Array.isArray(o)) return o.map(mask);
  if (isPlainObject(o)) return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, mask(v)]));
  return o;
}

export function channelKind(channel: string | null | undefined): string {
  return pyStrip((channel || '').split(':', 1)[0] ?? '').toLowerCase();
}

/** `email:<địa chỉ>` | `email:$TEN_BIEN` → địa chỉ; khác → null. Không in/ghi địa chỉ. */
export function resolveAddress(channel: string, env: Env = process.env): string | null {
  if (channelKind(channel) !== 'email' || !(channel || '').includes(':')) return null;
  let v = pyStrip(channel.slice(channel.indexOf(':') + 1));
  if (v.startsWith('$')) v = pyStrip(env[v.slice(1)] || '');
  const ok =
    v.split('@').length === 2 &&
    cpLen(v) <= 254 &&
    isPrintable(v) &&
    !Array.from(v).some((c) => /\s/u.test(c) || ',;<>"'.includes(c));
  return ok ? v : null;
}

/** → hàm gửi | null khi chưa cấu hình. Chỉ mở mạng lúc gọi hàm trả về. */
export function smtpSender(env: Env = process.env): Sender | null {
  if (
    pyStrip(env.RED_ALERT_NOTIFY || '').toLowerCase() !== 'email' ||
    !pyStrip(env.SMTP_HOST || '')
  ) {
    return null;
  }
  const host = pyStrip(env.SMTP_HOST as string);
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port)) throw new RangeError(`SMTP_PORT '${env.SMTP_PORT}' không hợp lệ`);
  const user = env.SMTP_USER || '';
  const from = env.SMTP_FROM || user || 'red-alert@localhost';
  return async (to, subject, body) => {
    // STARTTLS BẮT BUỘC + kiểm chứng chỉ + hostname (starttls trần = MITM).
    const t = nodemailer.createTransport({
      host,
      port,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true, servername: host, minVersion: 'TLSv1.2' },
      auth: user ? { user, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: NOTIFY_TIMEOUT_MS,
      greetingTimeout: NOTIFY_TIMEOUT_MS,
      socketTimeout: NOTIFY_TIMEOUT_MS,
    });
    try {
      await t.sendMail({ from, to, subject, text: body });
    } finally {
      t.close();
    }
  };
}

export function message(aid: number | string, title: string): [string, string] {
  const t = squash(title);
  const subject = cpSlice(`[BÁO ĐỘNG ĐỎ #${aid}] ${t}`, 0, 200);
  const body =
    `Cảnh báo đỏ #${aid}: ${t}\n\n` +
    'Yêu cầu xác nhận trong 02 giờ, kể cả cuối tuần và Tết (PL02 mục 3). Xác nhận trên máy chủ:\n' +
    `  python -m pipelines.red_alert --ack ${aid} --by "<tên>"\n` +
    'Chi tiết xem bảng red_alerts (thư không chứa dữ liệu khách).';
  return [subject, body];
}

/**
 * Gửi 1 cảnh báo tới từng người nhận, ghi `red_alert_deliveries` 1 dòng/người (lỗi chỉ ghi TÊN loại
 * lỗi, không địa chỉ) → số người đã gửi được. `sender` undefined = cấu hình SMTP từ env.
 */
export async function deliver(
  db: Db,
  alertId: number,
  title: string,
  recipients: Recipient[],
  sender?: Sender | null,
  env: Env = process.env,
): Promise<number> {
  const send = sender === undefined ? smtpSender(env) : sender;
  const [subject, body] = message(alertId, dep('maskPii')(title || ''));
  const rows: unknown[][] = [];
  let nOk = 0;
  for (const r of recipients) {
    const kind = channelKind(r.channel);
    const addr = resolveAddress(r.channel, env);
    let err: string | null = null;
    if (kind !== 'email') err = `kênh '${cpSlice(kind, 0, 20)}' chưa hỗ trợ — chỉ email (SMTP)`;
    else if (send === null) err = 'kênh gửi chưa cấu hình (RED_ALERT_NOTIFY=email + SMTP_HOST)';
    else if (addr === null) err = 'địa chỉ người nhận chưa cấu hình (email:<địa chỉ>|$BIEN)';
    else {
      try {
        await send(addr, subject, body);
      } catch (e) {
        err = `gửi lỗi: ${(e as Error)?.name ?? 'Error'}`;
      }
    }
    if (err === null) nOk++;
    rows.push([alertId, r.name, r.role, cpSlice(kind, 0, 20) || '?', err === null, err]);
  }
  try {
    await withTx(db, async (c) => {
      for (const row of rows) {
        await c.query(
          'insert into red_alert_deliveries (alert_id, recipient, role, channel, ok, error) values ($1, $2, $3, $4, $5, $6)',
          row,
        );
      }
    });
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(
      `[RED-ALERT][warn] không ghi được nhật ký gửi cảnh báo #${alertId} (${(e as Error).name})`,
    );
  }
  return nOk;
}

/** Ghi 1 cảnh báo đỏ rồi gửi ngay → [đã gửi tới ≥1 người?, thông điệp]. */
export async function raiseAlert(
  db: Db,
  sourceAgent: string,
  title: string,
  detail: unknown = null,
  routing: unknown = null,
  sender?: Sender | null,
  env: Env = process.env,
): Promise<[boolean, string]> {
  const agent = pyStrip(sourceAgent || '');
  if (!agent) throw new RangeError('raise_alert: thiếu source_agent');
  const t = dep('maskPii')(pyStrip(title || ''));
  if (!t) throw new RangeError('raise_alert: thiếu title');
  let r = routing === null || routing === undefined ? loadRouting() : routing;
  if (!isPlainObject(r)) r = {};
  const rr = r as Record<string, unknown>;
  // Lọc LẠI cả routing truyền tay — không tin caller.
  const [valid] = validRecipients(rr.recipients, rr.excluded_roles || []);
  const names = valid.map((x) => x.name);
  const routeError = names.length ? null : MISSING;
  const d = detail && !falsy(detail) ? detail : {};
  const aid = await withTx(db, async (c) => {
    const ins = await c.query<{ id: string }>(
      'insert into red_alerts (source_agent, title, detail, recipients, route_error) values ($1, $2, $3, $4, $5) returning id',
      [agent, t, JSON.stringify(mask(d)), names, routeError],
    );
    const id = Number(ins.rows[0]!.id); // shortcut: id identity < 2^53, đủ cho red_alerts
    await c.query(
      'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)',
      [
        agent,
        'red_alert_raise',
        'red_alert',
        String(id),
        JSON.stringify({ alert_id: id, routed: names.length > 0, n_recipients: names.length }),
      ],
    );
    return id;
  });
  if (!names.length) {
    const msg = `cảnh báo đỏ #${aid} đã ghi nhưng ${MISSING} — chưa ai nhận`;
    console.error(`[RED-ALERT][warn] ${msg}`);
    return [false, msg];
  }
  const nOk = await deliver(db, aid, t, valid, sender, env);
  if (!nOk) {
    const msg = `cảnh báo đỏ #${aid} đã ghi, ${NOT_SENT} (${names.length} người nhận) — CHƯA thông báo; \`--deliver\` sẽ gửi lại`;
    console.error(`[RED-ALERT][warn] ${msg}`);
    return [false, msg];
  }
  return [true, `cảnh báo đỏ #${aid} → đã gửi ${nOk}/${names.length} người nhận`];
}

const PENDING_SQL =
  'select r.id, r.title from red_alerts r where r.ts >= $1' +
  ' and not exists (select 1 from red_alert_deliveries d where d.alert_id = r.id and d.ok)' +
  ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id) order by r.id';

export type DeliverStats = { pending: number; sent: number[]; failed: number[]; capped: number[] };

/** Gửi lại cảnh báo 48 giờ chưa gửi được + chưa xác nhận, tới người nhận HIỆN HÀNH. */
export async function deliverPending(
  db: Db,
  now: Date,
  routing: unknown = null,
  sender?: Sender | null,
  env: Env = process.env,
): Promise<DeliverStats> {
  const r = (routing ?? loadRouting()) as Record<string, unknown>;
  const [valid] = validRecipients(r.recipients, r.excluded_roles || []);
  const { rows } = await db.query(PENDING_SQL, [new Date(now.getTime() - DELIVER_WINDOW_MS)]);
  const st: DeliverStats = { pending: rows.length, sent: [], failed: [], capped: [] };
  if (!valid.length) {
    st.failed = rows.map((x) => Number(x.id));
    return st;
  }
  const cap = MAX_ATTEMPTS * valid.length;
  for (const row of rows) {
    const aid = Number(row.id);
    const n = Number(
      (
        await db.query('select count(*)::int as n from red_alert_deliveries where alert_id = $1', [
          aid,
        ])
      ).rows[0].n,
    );
    if (n >= cap) {
      st.capped.push(aid);
      continue;
    }
    const ok = await deliver(db, aid, row.title, valid, sender, env);
    (ok ? st.sent : st.failed).push(aid);
  }
  return st;
}

// Cảnh báo GỐC tới hạn cấp 1, chưa xác nhận, chưa leo thang. `edge` = mốc bật − 2 giờ: luồng thường
// `ts >= edge`, TỒN `ts < edge` (truy vấn tách → tồn bị giữ không chiếm chỗ trần; keyset `id > after`).
const DUE_BASE =
  " from red_alerts r where not (r.detail ? 'escalation_of') and r.ts <= $1" +
  ' and ($2::text is null or r.source_agent = $2)' +
  ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)' +
  " and not exists (select 1 from red_alerts e where e.detail ? 'escalation_of' and e.detail->>'escalation_of' = r.id::text)";
const DUE_COLS = "select r.id, r.source_agent, r.title, r.detail->>'url' as url";
const DUE_SQL = `${DUE_COLS}${DUE_BASE} and r.ts >= $3 order by r.id limit $4`;
const BACKLOG_SQL = `${DUE_COLS}${DUE_BASE} and r.ts < $3 and r.id > $4 order by r.id limit $5`;
const BACKLOG_N_SQL = `select count(*)::int as n${DUE_BASE} and r.ts < $3`;
const CAP2_SQL =
  "select r.id, r.source_agent, r.title, r.detail->>'url' as url from red_alerts r where not (r.detail ? 'escalation_of')" +
  ' and ($1::text is null or r.source_agent = $1)' +
  ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)' +
  " and exists (select 1 from red_alerts e where e.detail ? 'escalation_of' and e.detail->>'escalation_of' = r.id::text and e.ts <= $2)" +
  " and not exists (select 1 from red_alerts e2 where e2.detail ? 'escalation_of' and e2.detail->>'escalation_of' = r.id::text || $3)" +
  ' order by r.id limit $4';
const START_SQL = 'select min(ts) as ts from agent_action_log where action = $1';

/** Mốc bật leo thang (giờ DB) — ghi 1 lần khi `create` và chưa có. Lỗi DB nổi lên (fail-closed). */
export async function escalationStart(
  db: Db,
  { create }: { create: boolean },
): Promise<Date | null> {
  const ts = (await db.query(START_SQL, [START_ACTION])).rows[0]?.ts ?? null;
  if (ts !== null || !create) return ts;
  await db.query(
    'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)',
    [
      'system:red_alert',
      START_ACTION,
      'red_alert',
      'escalation',
      JSON.stringify({
        escalate_after_h: ESCALATE_AFTER_MS / 3600_000,
        max_per_run: ESC_MAX_PER_RUN,
      }),
    ],
  );
  return (await db.query(START_SQL, [START_ACTION])).rows[0]?.ts ?? null;
}

function merge(...groups: Recipient[][]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const g of groups) {
    for (const r of g) {
      const k = `${foldPrefix(r.name)}\u0000${r.channel}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out;
}

export type EscalateStats = {
  escalated: number;
  dup: number;
  unrouted: number;
  ids: number[];
  cap2_escalated: number;
  cap2_ids: number[];
  off_hours: boolean;
  start: Date | null;
  dry_run: boolean;
  after: number;
  backlog: {
    policy: string | null;
    total: number;
    escalated: number[];
    held: number;
    page: number[];
    next_after: number | null;
  };
  problems: string[];
};
type DueRow = { id: string; source_agent: string; title: string; url: string | null };

async function raiseEsc(
  db: Db,
  st: EscalateStats,
  row: DueRow,
  detail: Record<string, unknown>,
  prefix: string,
  recipients: Recipient[],
  routing: Record<string, unknown>,
  sender: Sender | null | undefined,
  idsKey: 'ids' | 'cap2_ids',
  env: Env,
): Promise<void> {
  const aid = Number(row.id);
  if (row.url) detail.url = row.url;
  const t = cpSlice(squash(String(row.title ?? '')), 0, 200);
  let routed: boolean;
  try {
    [routed] = await raiseAlert(
      db,
      row.source_agent,
      `${prefix}#${aid} ${t}`,
      detail,
      { recipients, excluded_roles: routing.excluded_roles || [] },
      sender,
      env,
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      st.dup++;
      return;
    }
    throw e;
  }
  if (idsKey === 'ids') st.escalated++;
  else st.cap2_escalated++;
  if (!routed) st.unrouted++;
  st[idsKey].push(aid);
}

/**
 * Cảnh báo GỐC quá 2 giờ đồng hồ chưa xác nhận → 1 bản leo thang/cảnh báo (mọi nguồn; `source` =
 * chỉ 1 nguồn). `dryRun` → không ghi gì (kể cả mốc), trả danh sách sẽ làm + 1 trang tồn từ `after`.
 */
export async function escalate(
  db: Db,
  now: Date,
  routing: unknown = null,
  sender?: Sender | null,
  opts: { source?: string | null; dryRun?: boolean; after?: number; env?: Env } = {},
): Promise<EscalateStats> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun ?? false;
  let r = routing === null || routing === undefined ? loadRouting() : routing;
  if (!isPlainObject(r)) r = {};
  const rr = r as Record<string, unknown>;
  const tc = tiers(rr);
  const [lvl1] = validRecipients(rr.recipients, rr.excluded_roles || []);
  const start = await escalationStart(db, { create: !dryRun });
  const edge = new Date((start ?? now).getTime() - ESCALATE_AFTER_MS);
  const off = tc.ngoai_gio !== null && isOffHours(tc.ngoai_gio, now);
  const extra = off && tc.ngoai_gio ? tc.ngoai_gio.recipients : [];
  const due = new Date(now.getTime() - ESCALATE_AFTER_MS);
  const src = opts.source ?? null;
  const after = Math.max(Math.trunc(opts.after || 0), 0);
  const rows = (await db.query<DueRow>(DUE_SQL, [due, src, edge, ESC_MAX_PER_RUN])).rows;
  let c2Rows: DueRow[] = [];
  if (tc.cap2 !== null) {
    c2Rows = (
      await db.query<DueRow>(CAP2_SQL, [
        src,
        new Date(now.getTime() - tc.cap2.afterMin * 60_000),
        CAP2_SUFFIX,
        ESC_MAX_PER_RUN,
      ])
    ).rows;
  }
  const nBack = Number((await db.query(BACKLOG_N_SQL, [due, src, edge])).rows[0].n);
  const page = (await db.query<DueRow>(BACKLOG_SQL, [due, src, edge, after, ESC_MAX_PER_RUN + 1]))
    .rows;
  const pol = tc.backlog.policy;
  const st: EscalateStats = {
    escalated: 0,
    dup: 0,
    unrouted: 0,
    ids: [],
    cap2_escalated: 0,
    cap2_ids: [],
    off_hours: off,
    start,
    dry_run: dryRun,
    after,
    backlog: {
      policy: pol,
      total: nBack,
      escalated: [],
      held: nBack,
      page: page.slice(0, ESC_MAX_PER_RUN).map((x) => Number(x.id)),
      next_after: page.length > ESC_MAX_PER_RUN ? Number(page[ESC_MAX_PER_RUN - 1]!.id) : null,
    },
    problems: tc.problems,
  };
  let room = ESC_MAX_PER_RUN;
  const todo = rows.slice(0, room);
  room -= todo.length;
  const c2Todo = c2Rows.slice(0, room);
  room -= c2Todo.length;
  let backTodo: DueRow[] = [];
  if (pol === 'leo_thang_dan' && room > 0) {
    backTodo = (await db.query<DueRow>(BACKLOG_SQL, [due, src, edge, 0, room])).rows;
  }
  if (dryRun) {
    st.ids = todo.map((x) => Number(x.id));
    st.cap2_ids = c2Todo.map((x) => Number(x.id));
    st.backlog.escalated = backTodo.map((x) => Number(x.id));
    st.backlog.held = nBack - backTodo.length;
    return st;
  }
  const offFlag = off ? { ngoai_gio: true } : {};
  for (const row of todo) {
    await raiseEsc(
      db,
      st,
      row,
      { escalation_of: Number(row.id), label: ESC_LABEL, ...offFlag },
      ESC_PREFIX,
      merge(lvl1, extra),
      rr,
      sender,
      'ids',
      env,
    );
  }
  for (const row of c2Todo) {
    await raiseEsc(
      db,
      st,
      row,
      {
        escalation_of: `${row.id}${CAP2_SUFFIX}`,
        escalation_root: Number(row.id),
        level: 2,
        label: CAP2_LABEL,
        ...offFlag,
      },
      CAP2_PREFIX,
      merge((tc.cap2 as Cap2).recipients, extra),
      rr,
      sender,
      'cap2_ids',
      env,
    );
  }
  for (const row of backTodo) {
    const n0 = st.ids.length;
    await raiseEsc(
      db,
      st,
      row,
      {
        escalation_of: Number(row.id),
        label: ESC_LABEL,
        backlog: true,
        backlog_policy: pol,
        backlog_quyet_boi: tc.backlog.by,
        ...offFlag,
      },
      ESC_PREFIX,
      merge(lvl1, extra),
      rr,
      sender,
      'ids',
      env,
    );
    if (st.ids.length > n0) st.backlog.escalated.push(Number(row.id));
  }
  st.backlog.held = nBack - st.backlog.escalated.length;
  return st;
}

/** NGƯỜI xác nhận MỌI cảnh báo đỏ gốc → [ok, thông điệp]. Không ném với đầu vào lỗi. */
export async function ack(
  db: Db,
  alertId: unknown,
  by: unknown,
  note: unknown = null,
  opts: { routing?: unknown; env?: Env } = {},
): Promise<[boolean, string]> {
  const env = opts.env ?? process.env;
  const auth = dep('auth');
  const who = dep('maskPii')(cpSlice(squash(pyStr(by || '')), 0, BY_MAX + 1));
  if (!who) return [false, 'thiếu tên người xác nhận (--by)'];
  if (cpLen(who) > BY_MAX) return [false, `tên người xác nhận dài quá ${BY_MAX} ký tự`];
  if (!auth.isHuman(who))
    return [false, 'người xác nhận phải là người thật (không agent:/system:)'];
  let allow: string[] | null = null;
  if (approvalEnforced(env)) {
    const r = (opts.routing ?? loadRouting()) as Record<string, unknown>;
    allow = validRecipients(r.recipients, r.excluded_roles || [])[0].map((x) => x.name);
  }
  const parsed = pyInt(alertId);
  const aid = parsed ?? 0n;
  if (!(aid >= 1n && aid <= BIGINT_MAX)) {
    return [false, `id '${cpSlice(squash(pyStr(alertId)), 0, 40)}' không hợp lệ`];
  }
  // Chế độ thực — chỉ người nhận độc lập, `--by` khớp login Postgres đang dùng; bị chặn → log.
  const why = await auth.cliGate(db, who, null, 'ack', 'red_alert', String(aid), {
    allow,
    allowSrc: 'người nhận độc lập trong data/red_alert_routing.json',
    env,
  });
  if (why) return [false, `chế độ thực: ${why}`];
  // Cắt TRƯỚC regex mask (chống DoS), cắt lại sau mask.
  const n = note
    ? cpSlice(dep('maskPii')(cpSlice(pyStrip(pyStr(note)), 0, NOTE_MAX * 2)), 0, NOTE_MAX) || null
    : null;
  const { rows } = await db.query('select detail from red_alerts where id = $1', [String(aid)]);
  if (!rows[0]) return [false, `không tìm thấy cảnh báo #${aid}`];
  const detail = isPlainObject(rows[0].detail) ? rows[0].detail : {};
  if ('escalation_of' in detail) {
    const root = 'escalation_root' in detail ? detail.escalation_root : detail.escalation_of;
    return [false, `#${aid} là bản leo thang — xác nhận id gốc #${pyStr(root)}`];
  }
  try {
    await db.query('insert into red_alert_acks (alert_id, acked_by, note) values ($1, $2, $3)', [
      String(aid),
      who,
      n,
    ]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return [false, `cảnh báo #${aid} đã được xác nhận trước đó`];
    }
    if (!isDbError(e)) throw e;
    return [false, `cảnh báo #${aid}: ${e instanceof pg.DatabaseError ? dbMsg(e) : e.name}`];
  }
  return [true, `đã xác nhận cảnh báo #${aid} (người: ${who})`];
}

const OPEN_SQL =
  'select r.id, r.ts, r.source_agent, r.title, r.route_error,' +
  ' exists (select 1 from red_alert_deliveries d where d.alert_id = r.id and d.ok) as delivered' +
  " from red_alerts r where not (r.detail ? 'escalation_of')" +
  ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id) order by r.ts, r.id';

export type OpenAlert = {
  id: number;
  ts: Date;
  source: string;
  title: string;
  route_error: string | null;
  delivered: boolean;
  age_h: number;
};

/** Cảnh báo GỐC (mọi nguồn) chưa xác nhận, cũ nhất trước. */
export async function openAlerts(db: Db, now: Date): Promise<OpenAlert[]> {
  const { rows } = await db.query(OPEN_SQL);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts,
    source: r.source_agent,
    title: r.title,
    route_error: r.route_error,
    delivered: Boolean(r.delivered),
    age_h: pyRound((now.getTime() - r.ts.getTime()) / 3_600_000, 1), // Python round(x, 1)
  }));
}

/** `--check-routing` → [dòng in, exit] (0 khi ≥1 người nhận GỬI ĐƯỢC). */
export function checkRouting(env: Env = process.env, path: string = ROUTING): [string[], number] {
  const r = loadRouting(path);
  const out = r.problems.map((p) => `[warn] ${p}`);
  out.push(...tierLines(tiers(r)));
  if (!r.recipients.length) {
    out.push(
      `[FAIL] ${MISSING} — cảnh báo đỏ vẫn được ghi bảng red_alerts nhưng chưa có ai nhận; Pháp chế xác nhận người nhận rồi điền data/red_alert_routing.json`,
    );
    return [out, 1];
  }
  out.push(
    `[ok] ${r.recipients.length} người nhận độc lập: ${r.recipients.map((x) => `${x.name} (${x.role}/${channelKind(x.channel)})`).join(', ')}`,
  );
  const ready = r.recipients.filter((x) => resolveAddress(x.channel, env) !== null);
  if (smtpSender(env) === null || !ready.length) {
    out.push(
      '[FAIL] chưa có kênh gửi: cần RED_ALERT_NOTIFY=email + SMTP_HOST và người nhận kênh email:<địa chỉ>|$BIEN — cảnh báo chỉ nằm trong DB, CHƯA thông báo ai',
    );
    return [out, 1];
  }
  out.push(`[ok] ${ready.length} người nhận có kênh email gửi được`);
  return [out, 0];
}

function tierWarnings(st: EscalateStats, routingLines: boolean): string[] {
  const out = st.problems.map((p) => `[warn] ${p}`);
  const b = st.backlog;
  if (b.total && b.policy === null) {
    out.push(
      `[warn] ${b.total} cảnh báo TỒN (quá hạn trước mốc bật leo thang) — ${BACKLOG_UNSET}; xem: --escalate --dry-run`,
    );
  } else if (b.total && b.policy === 'khong_leo_thang') {
    out.push(
      `[info] ${b.total} cảnh báo tồn không leo thang theo chính sách khong_leo_thang (vẫn ở --open)`,
    );
  }
  if (routingLines) {
    for (const line of tierLines(tiers(loadRouting())).slice(1)) {
      if (line.includes('CHƯA CẤU HÌNH')) out.push(line);
    }
  }
  return out;
}

const pyList = (xs: number[]) => `[${xs.join(', ')}]`;

function previewLines(st: EscalateStats): string[] {
  const b = st.backlog;
  const mark = st.start
    ? `mốc bật leo thang ${vnFormat(st.start, '%Y-%m-%d %H:%M')} +07`
    : 'CHƯA bật leo thang lần nào — nếu bật bây giờ, mọi cảnh báo đang quá hạn là TỒN';
  const out = [
    `[dry-run] KHÔNG ghi/gửi gì — ${mark}`,
    `[dry-run] luồng thường: sẽ leo thang ${st.ids.length} — ${pyList(st.ids)}${st.off_hours ? ' (ngoài giờ: gửi thêm người trực)' : ''}`,
    `[dry-run] cấp 2: ${st.cap2_ids.length} — ${pyList(st.cap2_ids)}`,
    `[dry-run] tồn: tổng ${b.total}, chính sách ${b.policy || 'CHƯA QUYẾT'} — lần chạy tới leo thang ${b.escalated.length}: ${pyList(b.escalated)}`,
    `[dry-run] trang tồn (id > ${st.after}): ${pyList(b.page)}`,
  ];
  if (b.next_after !== null)
    out.push(`[dry-run] trang sau: --escalate --dry-run --after ${b.next_after}`);
  out.push(...tierWarnings(st, false), ...tierLines(tiers(loadRouting())));
  return out;
}

export type RedAlertCliOpts = {
  checkRouting?: boolean;
  deliver?: boolean;
  escalate?: boolean;
  ack?: string;
  open?: boolean;
  by?: string;
  note?: string;
  dryRun?: boolean;
  after?: number;
};

/** `python -m pipelines.red_alert` (tham số đã tách) → exit code. */
export async function redAlertCli(
  o: RedAlertCliOpts,
  open: () => Promise<Db | null>,
  env: Env = process.env,
): Promise<number> {
  const usage = (m: string) => {
    console.error(`[err] ${m}`);
    return 2;
  };
  const n = [o.checkRouting, o.deliver, o.escalate, o.ack !== undefined, o.open].filter(
    Boolean,
  ).length;
  if (n !== 1) {
    return usage('cần đúng 1 thao tác: --check-routing | --deliver | --escalate | --ack | --open');
  }
  const after = o.after ?? 0;
  if (!Number.isInteger(after)) return usage('--after phải là số nguyên');
  if ((o.dryRun || after) && !o.escalate) return usage('--dry-run/--after chỉ đi với --escalate');
  if (after && !o.dryRun) return usage('--after chỉ đi với --escalate --dry-run');
  if (after < 0) return usage('--after phải ≥ 0');
  if (o.ack !== undefined && pyInt(o.ack) === null) return usage('--ack cần số nguyên ID');
  if (o.ack !== undefined && !pyStrip(o.by ?? '')) return usage('--ack cần --by <tên người>');
  if (o.ack === undefined && (o.by !== undefined || o.note !== undefined)) {
    return usage('--by/--note chỉ dùng với --ack');
  }
  if (o.checkRouting) {
    const [lines, rc] = checkRouting(env);
    for (const l of lines) console.log(l);
    return rc;
  }
  const db = await open();
  if (db === null) {
    console.log('[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 1;
  }
  const now = new Date();
  try {
    if (o.ack !== undefined) {
      const [ok, msg] = await ack(db, o.ack, o.by, o.note ?? null, { env });
      console.log(`[${ok ? 'done' : 'warn'}] ${msg}`);
      return ok ? 0 : 1;
    }
    if (o.open) {
      const rows = await openAlerts(db, now);
      console.log(`[open] ${rows.length} cảnh báo đỏ gốc chưa xác nhận`);
      const m = dep('maskPii');
      for (const d of rows) {
        const sent = d.delivered ? 'đã gửi' : 'CHƯA GỬI ĐƯỢC';
        console.log(
          `  #${d.id} ${pyFloatStr(d.age_h)}h [${d.source}] ${sent} — ${cpSlice(m(d.title || ''), 0, 120)}`,
        );
      }
      return 0;
    }
    if (o.escalate && o.dryRun) {
      const st = await escalate(db, now, null, undefined, { dryRun: true, after, env });
      for (const l of previewLines(st)) console.log(l);
      return 0;
    }
    if (o.escalate) {
      let st: EscalateStats | undefined;
      let detail = '';
      await jobRun(
        'pipelines.red_alert.escalate',
        async (jr) => {
          st = await escalate(db, now, null, undefined, { env });
          const b = st.backlog;
          detail =
            `escalated=${st.escalated} dup=${st.dup} unrouted=${st.unrouted} cap2=${st.cap2_escalated}` +
            ` backlog=${b.total} backlog_escalated=${b.escalated.length} backlog_held=${b.held}`;
          jr.detail = detail;
          jr.ok = !st.unrouted;
        },
        env,
      );
      const s = st as EscalateStats;
      console.log(`[done] ${detail} escalated_of=${pyList(s.ids)} cap2_of=${pyList(s.cap2_ids)}`);
      for (const l of tierWarnings(s, true)) console.log(l);
      if (s.unrouted) {
        console.log(
          `[RED-ALERT][FAIL] ${s.unrouted} bản leo thang CHƯA thông báo được (${MISSING} hoặc ${NOT_SENT})`,
        );
        return 1;
      }
      return 0;
    }
    let st: DeliverStats | undefined;
    let detail = '';
    await jobRun(
      'pipelines.red_alert.deliver',
      async (jr) => {
        st = await deliverPending(db, now, null, undefined, env);
        detail = `pending=${st.pending} sent=${st.sent.length} failed=${st.failed.length} capped=${st.capped.length}`;
        jr.detail = detail;
        jr.ok = !(st.failed.length + st.capped.length);
      },
      env,
    );
    console.log(`[done] ${detail}`);
    const s = st as DeliverStats;
    const undone = [...s.failed, ...s.capped];
    if (undone.length) {
      console.log(
        `[RED-ALERT][FAIL] ${undone.length} cảnh báo ${NOT_SENT}: #${undone.join(', #')}`,
      );
      return 1;
    }
    return 0;
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.log(`[err] lỗi DB: ${e.name}`);
    return 1;
  } finally {
    if (db instanceof pg.Pool) await db.end().catch(() => {});
  }
}
