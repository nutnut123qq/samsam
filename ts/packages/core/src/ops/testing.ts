import { pyStrip } from '../env.js';
import { RolloutBlocked } from '../rollout/rollout.js';
import { type Db, type GuardrailResult, type OpsDeps, resetOpsDeps, setOpsDeps } from './deps.js';
import { foldPrefix } from './py.js';

// Bản GIẢ của hàm nhóm khác cho test ops/ (như Python test monkeypatch rollout/guardrail).
// Guardrail giả: "chữa" = vi phạm. Rollout giả: giai đoạn theo `stages` (mặc định quick 'van_hanh'
// như tests/conftest.py ép `_FORCE_MODE`). Auth giả: đúng nhánh CHẾ ĐỘ DEV của `auth.authorize`.

export const ROLES = ['tgd', 'phap_che', 'gd_ban_hang', 'gd_marketing', 'mxh', 'ha_tang'];
export const DEV_WARNING =
  'CHẾ ĐỘ DEV — người duyệt CHƯA được đối chiếu danh sách ủy quyền (đặt AUTH_MODE=local|proxy hoặc APPROVAL_ENFORCE=1 khi dùng thật)';
const STAGE_LABEL: Record<string, string> = {
  chay_thu: 'chạy thử',
  co_nguoi_duyet: 'có người duyệt',
  van_hanh: 'vận hành',
  tat: 'tắt',
};

export function fakeIsHuman(name: unknown): boolean {
  const s = typeof name === 'string' ? foldPrefix(pyStrip(name)) : '';
  return s !== '' && !['agent:', 'system:', 'auto_policy:'].some((p) => s.startsWith(p));
}

export function fakeGuardrail(text: string): GuardrailResult {
  return text.includes('chữa')
    ? { ok: false, violations: [{ code: 'tu_cam', detail: 'từ cấm', span: 'chữa' }], skus: [] }
    : { ok: true, violations: [], skus: [] };
}

export type FakeState = {
  quick: string | null;
  stages: Record<string, string>;
  /** featureFor: khóa JSON.stringify(attrs đã sắp) | hàm. */
  featureOf: (attrs: Record<string, unknown>) => string | null;
  reportFeature: (name: string) => string | null;
  catalog: { id: string; phong_ban?: string }[] | null;
  recorded: { name: string; text: string; sample: boolean | null; fid: string | null }[];
  denied: unknown[][];
  publishCtx: unknown[];
};

export function installFakeDeps(
  over: Partial<OpsDeps> = {},
  st: Partial<FakeState> = {},
): FakeState {
  const s: FakeState = {
    quick: 'van_hanh',
    stages: {},
    featureOf: () => null,
    reportFeature: () => null,
    catalog: [],
    recorded: [],
    denied: [],
    publishCtx: [],
    ...st,
  };
  const mode = async (_db: Db | null, fid: string | null) =>
    s.quick ?? (fid ? (s.stages[fid] ?? 'chay_thu') : 'chay_thu');
  const why = (fid: string | null, md: string, what: string) =>
    `${what}: tính năng ${fid || '(không thuộc danh mục)'} đang ${STAGE_LABEL[md]} — HĐ 6.7/PL02 mục 1`;
  resetOpsDeps();
  setOpsDeps({
    maskPii: (x) => x,
    guardrailCheck: fakeGuardrail,
    checkPublish: (text, ctx) => {
      s.publishCtx.push(ctx);
      return fakeGuardrail(text);
    },
    checkPublishLlm: (text, ctx) => {
      s.publishCtx.push({ ...ctx, llm: true });
      return fakeGuardrail(text);
    },
    withViolation: (res, code, detail) => {
      const b = (res && typeof res === 'object' ? res : {}) as GuardrailResult;
      const v = Array.isArray(b.violations) ? [...b.violations] : [];
      v.push({ code, detail });
      return { ...b, violations: v, ok: false };
    },
    auth: {
      ROLES,
      DEV_WARNING,
      isHuman: fakeIsHuman,
      authorize: (by, _block, action, o) => {
        const who = typeof by === 'string' ? pyStrip(by) : '';
        if (!who) return { ok: false, why: 'thiếu người quyết định (--by / đăng nhập)' };
        if (!fakeIsHuman(who)) {
          return {
            ok: false,
            why: `'${who}' không phải người — agent/hệ thống KHÔNG được ${action}`,
          };
        }
        if (
          (action === 'approve' || action === 'override_qa') &&
          who.toLowerCase() === pyStrip(o.createdBy ?? '').toLowerCase()
        ) {
          return { ok: false, why: 'người quyết trùng người tạo — cần người khác duyệt' };
        }
        return { ok: true, why: null };
      },
      sessionLogin: () => null,
      denyLog: (...a) => {
        s.denied.push(a.slice(1));
      },
      cliGate: (_db, by) =>
        fakeIsHuman(by) ? null : `'${String(by)}' không phải người — agent/hệ thống KHÔNG được ack`,
    },
    rollout: {
      checkGenerate: async (db, fid, what) => {
        if (fid !== null && (await mode(db, fid)) === 'tat') {
          throw new RolloutBlocked(`${why(fid, 'tat', what)} — không sinh đầu ra`);
        }
      },
      decideReason: async (db, fid, what) =>
        fid !== null && (await mode(db, fid)) === 'tat'
          ? `${why(fid, 'tat', what)} — không duyệt mục của tính năng tắt`
          : null,
      useReason: async (db, fid, what, human) => {
        const md = await mode(db, fid);
        if (md !== 'co_nguoi_duyet' && md !== 'van_hanh') {
          return `${why(fid, md, what)} — đầu ra chỉ ghi nội bộ, không dùng`;
        }
        if (md === 'co_nguoi_duyet' && !human) {
          return `${why(fid, md, what)} — mục chưa được NGƯỜI duyệt từng mục`;
        }
        return null;
      },
      featureFor: (a) => s.featureOf(a),
      quickMode: () => s.quick,
      mode,
      catalog: () => s.catalog,
      isHuman: fakeIsHuman,
      gateReport: async (name, fid) => {
        const f = fid ?? s.reportFeature(name);
        if (f === null) return null;
        const md = await mode(null, f);
        if (md === 'tat')
          throw new RolloutBlocked(`${why(f, 'tat', `báo cáo ${name}`)} — không sinh đầu ra`);
        return md;
      },
      labelReport: (name, text, md, fid) => {
        if (md !== 'chay_thu' || !name.endsWith('.md')) return text;
        return `> **CHẠY THỬ — KHÔNG GỬI.** Tính năng ${fid ?? s.reportFeature(name) ?? '?'}\n\n${text}`;
      },
      recordReport: (name, text, sample, fid) => {
        s.recorded.push({ name, text, sample, fid: fid ?? null });
        return true;
      },
    },
    ...over,
  });
  return s;
}
