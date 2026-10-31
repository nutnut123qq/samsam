import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cpSlice } from '@samsam/core/ops/py';
import { isDict, parsePyJson } from '@samsam/core/ops/py-json';
import { SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { checkPublish, type ReadinessMap } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { cpLen, pyStr, pyStrip, re, S } from '@samsam/core/security/py';
import * as ims from '../image_video/image-studio.js';
import type { Raw } from '../image_video/raster.js';
import * as vs from '../image_video/video-studio.js';
import {
  feedback,
  loadTemplate,
  publishTexts,
  refusedGuardrail,
  specLike,
  system,
} from '../kd_listing_live/content-lite.js';
import { cleanText, type Dict, type Refusal, sha256 } from './shared.js';

// v10.1 MKT-12 (marketing-07.2) — gói video YouTube dài NHÁP + Shorts (`agents/mkt_youtube.py`).
// Từ chối TRƯỚC LLM (brief rỗng/dài, nhắc rượu, từ cấm kịch bản/sức khỏe/guardrail). LLM trả JSON →
// câu chạm số/giá, từ cấm kịch bản, rượu → BỎ; CODE dựng tất định chương/SRT/mô tả (+ khuyến cáo khi
// TPBVSK, nhãn AI + QC); `privacyStatus` là HẰNG "private". Toàn văn qua `check_publish` → 1 lượt sửa
// có feedback → còn vi phạm → `kich_ban`. KHÔNG có đường đăng YouTube (tài khoản kênh + API =
// external-dep). `renderShorts` TÁI DÙNG video_studio (B-roll có license, nhãn AI/QC trên MỌI khung,
// 15–45 giây, không track âm thanh, kiểm nhãn trên 3 khung trích) → `<out>/<sha256>.mp4` + sidecar +
// 1 dòng `agent_action_log` `youtube_short_render`; KHÔNG ghi `video_assets`.

export const TEMPLATE = 'youtube_long';
export const AGENT = 'mkt_youtube';
export const CHANNEL = 'youtube';
export const CONTENT_TYPE = 'video';
export const CREATED_BY = 'agent:mkt12';
export const PRIVACY = 'private';
export const FEATURE = 'marketing-07.2';
export const MAX_BRIEF = 500;
export const MAX_TEXT = 600;
export const TOTAL_S: [number, number] = [300, 900];
export const SEG_S: [number, number] = [10, 600];
export const MIN_SEGMENTS = 3;
export const MAX_SEGMENTS = 12;
export const MAX_SHORTS = 3;
export const MAX_SHORT_SEGS = 3;
export const SHORT_S: [number, number] = [15, 45];
export const SIDECAR_SCHEMA = 'youtube_short@1';
export const FMT = '9:16';
const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
const SENT_RE = re(`(?<=[.!?…])[${S}]+`);

const pad2 = (n: number) => String(n).padStart(2, '0');

export function tsChapter(s: number): string {
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const [m, sec] = [Math.floor(rem / 60), rem % 60];
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

export function tsSrt(s: number): string {
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  return `${pad2(h)}:${pad2(Math.floor(rem / 60))}:${pad2(rem % 60)},000`;
}

const isPyInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** JSON LLM (có thể bọc ```json) → object đúng mẫu | null. Số thực (`90.0`) ≠ số nguyên như Python. */
export function parse(text: unknown): Dict | null {
  if (typeof text !== 'string') return null;
  const s = pyStrip(text);
  const m = FENCE_RE.exec(s);
  let obj: unknown;
  try {
    obj = parsePyJson(m ? (m[1] as string) : s);
  } catch {
    return null;
  }
  if (!isDict(obj)) return null;
  const segs = obj.segments;
  if (
    !Array.isArray(segs) ||
    !segs.every(
      (x) =>
        isDict(x) &&
        typeof x.title === 'string' &&
        typeof x.text === 'string' &&
        isPyInt(x.duration_s),
    )
  ) {
    return null;
  }
  if (typeof obj.title !== 'string' || typeof obj.description !== 'string') return null;
  return obj;
}

type Dropped = { text: string; ly_do: string };

/** Giữ câu sạch của 1 đoạn LLM; câu số/giá, từ cấm kịch bản, rượu → BỎ (ghi `dropped`). */
function filter(s: unknown, bannedTerms: string[], dropped: Dropped[]): string {
  const kept: string[] = [];
  for (const sent of cpSlice(cleanText(s), 0, MAX_TEXT).split(SENT_RE)) {
    const t = pyStrip(sent);
    if (!t) continue;
    const why = specLike(t)
      ? 'so_lieu'
      : vs.banned(t, bannedTerms).length
        ? 'tu_cam_kich_ban'
        : isAlcohol(t)
          ? 'ruou'
          : null;
    if (why === null) kept.push(t);
    else dropped.push({ text: t, ly_do: why });
  }
  return kept.join(' ');
}

/** Từ chối TRƯỚC LLM → {code, reason} | null. */
export function pre(brief: unknown): Refusal | null {
  const s = cleanText(brief);
  if (!s || cpLen(s) > MAX_BRIEF) {
    return { code: 'brief_cam', reason: `brief rỗng hoặc dài hơn ${MAX_BRIEF} ký tự` };
  }
  if (isAlcohol(s)) {
    return {
      code: 'ruou',
      reason: 'brief nhắc rượu — cấm quảng cáo/khuyến mại rượu (Luật 44/2019)',
    };
  }
  return vs.checkBrief(s);
}

export type Segment = {
  i: number;
  title: string;
  text: string;
  visual: string;
  start_s: number;
  duration_s: number;
};
export type Short = { title: string; segments: number[] };
export type Built = {
  title: string;
  segments: Segment[];
  dropped: Dropped[];
  refused: Refusal | null;
  chapters?: string[];
  srt?: string;
  shorts?: Short[];
  description?: string;
  canon?: string;
};

/** JSON LLM → gói (THUẦN, tất định). */
export function build(obj: Dict, bannedTerms: string[]): Built {
  const [canon, ai, ad] = publishTexts();
  const dropped: Dropped[] = [];
  const segs: Segment[] = [];
  let t0 = 0;
  (obj.segments as Dict[]).slice(0, MAX_SEGMENTS).forEach((x, i) => {
    const ttl = cpSlice(filter(x.title, bannedTerms, dropped), 0, 60) || `Phần ${i + 1}`;
    const text = filter(x.text, bannedTerms, dropped);
    const visual = filter(x.visual || '', bannedTerms, dropped);
    segs.push({ i, title: ttl, text, visual, start_s: t0, duration_s: x.duration_s as number });
    t0 += x.duration_s as number;
  });
  const out: Built = {
    title: cpSlice(filter(obj.title, bannedTerms, dropped), 0, 100),
    segments: segs,
    dropped,
    refused: null,
  };
  if (
    segs.length < MIN_SEGMENTS ||
    segs.some((s) => s.duration_s < SEG_S[0] || s.duration_s > SEG_S[1])
  ) {
    out.refused = {
      code: 'kich_ban',
      reason: `cần ≥ ${MIN_SEGMENTS} phần, mỗi phần ${SEG_S[0]}–${SEG_S[1]} giây`,
    };
    return out;
  }
  if (t0 < TOTAL_S[0] || t0 > TOTAL_S[1]) {
    out.refused = {
      code: 'thoi_luong',
      reason: `tổng ${t0} giây ngoài [${TOTAL_S[0]}, ${TOTAL_S[1]}]`,
    };
    return out;
  }
  if (!out.title) {
    out.refused = { code: 'kich_ban', reason: 'tiêu đề bị bỏ hết' };
    return out;
  }
  const chapters = segs.map((s) => `${tsChapter(s.start_s)} ${s.title}`);
  const srt: string[] = [];
  segs.forEach((s, k) => {
    srt.push(
      String(k + 1),
      `${tsSrt(s.start_s)} --> ${tsSrt(s.start_s + s.duration_s)}`,
      s.text || s.title,
      '',
    );
  });
  const shorts: Short[] = [];
  const raw = Array.isArray(obj.shorts) ? obj.shorts.slice(0, MAX_SHORTS) : [];
  for (const sh of raw) {
    const idx = isDict(sh) ? sh.segments : null;
    if (
      !Array.isArray(idx) ||
      idx.length < 1 ||
      idx.length > MAX_SHORT_SEGS ||
      !idx.every((j) => isPyInt(j) && j >= 0 && j < segs.length) ||
      new Set(idx).size !== idx.length
    ) {
      continue;
    }
    const ttl = cpSlice(filter((sh as Dict).title || '', bannedTerms, dropped), 0, 60);
    if (ttl) shorts.push({ title: ttl, segments: [...(idx as number[])] });
  }
  const desc = [filter(obj.description, bannedTerms, dropped), '', 'Chương:', ...chapters, ''];
  return {
    ...out,
    chapters,
    srt: srt.join('\n'),
    shorts,
    description: [...desc, ...ai.slice(0, 1), ...ad.slice(0, 1)].join('\n'),
    canon,
  };
}

export type Meta = { privacyStatus: string; containsSyntheticMedia: boolean };
export type Package = {
  ok: boolean;
  refused: Refusal | null;
  error: string | null;
  title: string;
  description: string;
  chapters: string[];
  segments: Segment[];
  srt: string;
  shorts: Short[];
  dropped: Dropped[];
  guardrail: Dict | null;
  meta: Meta;
  text: string;
  llm_calls: number;
  prompt_version: string | null;
  prompt_sha256: string | null;
};

/** Toàn văn bản nháp (đúng chữ guardrail chấm + lưu content_drafts). */
export function packageText(pkg: Omit<Package, 'text'> | Package): string {
  const L = [`Tiêu đề: ${pkg.title}`, '', 'Mô tả:', pkg.description, '', 'Kịch bản theo chương:'];
  for (const s of pkg.segments) L.push(`[${tsChapter(s.start_s)}] ${s.title}`, s.text);
  if (pkg.shorts.length) {
    L.push(
      '',
      'Shorts (bản xem trước dựng từ B-roll):',
      ...pkg.shorts.map((sh) => `- ${sh.title}`),
    );
  }
  L.push(
    '',
    `Chế độ hiển thị khi đưa lên kênh: ${pkg.meta.privacyStatus} (người phụ trách kênh đổi sau khi duyệt)`,
    '',
    'Phụ đề SRT:',
    pkg.srt,
  );
  return L.join('\n');
}

/** sha256 `json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
export const msgsSha = (messages: ChatMessage[]): string =>
  sha256(JSON.stringify(messages.map((m) => ({ content: m.content, role: m.role }))));

export async function writePackage(
  brief: unknown,
  o: { ai: Pick<AiGateway, 'chat'>; readiness?: ReadinessMap | null },
): Promise<Package> {
  const out: Package = {
    ok: false,
    refused: null,
    error: null,
    title: '',
    description: '',
    chapters: [],
    segments: [],
    srt: '',
    shorts: [],
    dropped: [],
    guardrail: null,
    meta: { privacyStatus: PRIVACY, containsSyntheticMedia: true },
    text: '',
    llm_calls: 0,
    prompt_version: null,
    prompt_sha256: null,
  };
  const refuse = (code: string, reason: string, g: Dict | null, kw: Partial<Package> = {}) => {
    const ref = { code, reason };
    return { ...out, ...kw, refused: ref, guardrail: g ?? (refusedGuardrail(ref) as Dict) };
  };
  const r0 = pre(brief);
  if (r0) return refuse(r0.code, r0.reason, null);
  const [vcfg, verr] = vs.loadConfig();
  if (vcfg === null) return refuse('config', verr, null);
  let tmpl: string;
  let ver: string;
  try {
    [tmpl, ver] = loadTemplate(TEMPLATE);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return refuse('config', e.message, null);
  }
  const fmt = tmpl.replaceAll('{brief}', cleanText(brief));
  let messages: ChatMessage[] = [
    { role: 'system', content: system(fmt, false) },
    { role: 'user', content: 'Trả về DUY NHẤT JSON đúng mẫu.' },
  ];
  for (const calls of [1, 2]) {
    const sha = msgsSha(messages);
    let raw: string;
    try {
      const r = await o.ai.chat(AGENT, messages, {
        feature: FEATURE,
        temperature: 0.4,
        maxTokens: 2500,
      });
      raw = r.text;
    } catch (e) {
      // gateway fail-closed (kể cả GatewayBlocked: TẮT/kill/trần) — không sinh gì
      const err = e as Error;
      return {
        ...out,
        llm_calls: calls,
        error: `llm: ${err?.name ?? 'Error'}: ${cpSlice(pyStr(err?.message ?? e), 0, 160)}`,
      };
    }
    const state: Partial<Package> = { llm_calls: calls, prompt_version: ver, prompt_sha256: sha };
    const obj = parse(raw);
    if (obj === null) return refuse('kich_ban', 'LLM trả sai mẫu JSON', null, state);
    const b = build(obj, vcfg.script_banned);
    const canon = b.canon ?? '';
    delete b.canon;
    if (b.refused) {
      const { refused, ...rest } = b;
      return refuse(refused.code, refused.reason, null, {
        ...state,
        ...(rest as Partial<Package>),
      });
    }
    const { refused: _r, ...pkg0 } = b;
    const pkg = { ...pkg0, meta: out.meta } as Omit<Package, 'text'> & Partial<Package>;
    const ctx = {
      channel: CHANNEL,
      contentType: CONTENT_TYPE,
      isAi: true,
      readiness: o.readiness ?? null,
    };
    let text = packageText(pkg as Package);
    let g = checkPublish(text, ctx) as Dict;
    if (canon && ((g.violations ?? []) as Dict[]).some((v) => v.code === 'thieu_khuyen_cao')) {
      pkg.description = `${pkg.description}\n${canon}.`;
      text = packageText(pkg as Package);
      g = checkPublish(text, ctx) as Dict;
    }
    Object.assign(state, pkg, { text });
    if (g.ok === true) return { ...out, ...state, ok: true, guardrail: g };
    if (calls === 2) {
      return refuse('kich_ban', 'gói video vi phạm guardrail sau 1 lượt sửa', g, state);
    }
    messages = [
      ...messages,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `${feedback(g)} Không viết số/giá. Trả lại DUY NHẤT JSON đúng mẫu.`,
      },
    ];
  }
  throw new Error('unreachable');
}

export async function savePackage(db: Db, pkg: Package, brief: string): Promise<string | null> {
  return saveDraft(db, {
    brief: cleanText(brief),
    channel: CHANNEL,
    text: pkg.text,
    guardrail: pkg.guardrail,
    source: SOURCE_CLI,
    createdBy: CREATED_BY,
    contentType: CONTENT_TYPE,
    isAi: true,
    promptVersion: pkg.prompt_version,
    promptSha256: pkg.prompt_sha256,
  });
}

// ------------------------------------------------------------ Shorts

export type ShortCheck = { t_ms: number; label_ratio: number };
export type ShortResult = {
  ok: boolean;
  title: string;
  refused?: string;
  error?: string;
  path?: string;
  sidecar?: string;
  sha256?: string;
  checks?: ShortCheck[];
};

const LOG_SQL =
  'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)';

/** `_render_one`: 1 Short 9:16 từ B-roll (xoay vòng), tiêu đề phần + nhãn AI/QC trên MỌI khung. */
async function renderOne(
  ff: string,
  sh: Short,
  pkg: Package,
  brolls: vs.Broll[],
  odir: string,
  vcfg: vs.VideoCfg,
  labels: string[],
  env: Env,
): Promise<ShortResult> {
  const icfg = vcfg.img;
  const rgb = icfg.label.text_rgb;
  const [W, H] = icfg.formats.get(FMT) as [number, number];
  const lbox = ims.px((icfg.layout.get(FMT) as { label_box: ims.Box }).label_box, [W, H]);
  const texts = sh.segments.map((j) => (pkg.segments[j] as Segment).title);
  const n = texts.length;
  const sceneS = Math.max(vcfg.scene_s, Math.ceil(SHORT_S[0] / n));
  const totalS = sceneS * n;
  if (totalS < SHORT_S[0] || totalS > SHORT_S[1]) {
    return { ok: false, refused: 'thoi_luong', title: sh.title };
  }
  const td = mkdtempSync(join(odir, '.tmp-'));
  const used: { file: string; file_sha256: string; license: string }[] = [];
  const checks: ShortCheck[] = [];
  let sha: string;
  let mp4: string;
  try {
    const seq = join(td, 'seq');
    mkdirSync(seq);
    const frames: Raw[] = [];
    for (const [i, text] of texts.entries()) {
      const b = brolls[i % brolls.length] as vs.Broll;
      const r = await vs.brollFrame(b, text, FMT, icfg, labels, env);
      if (r[0] === null) return { ok: false, refused: r[1], title: sh.title };
      const [data, img, bsha] = r;
      if (!vs.labelDrawn(img, lbox, rgb)) return { ok: false, refused: 'nhan_ai', title: sh.title };
      writeFileSync(join(seq, `${String(i).padStart(3, '0')}.png`), data);
      frames.push(img);
      used.push({ file: b.file, file_sha256: bsha, license: b.license });
    }
    const tmp = join(td, 'out.mp4');
    try {
      await vs.vhooks.encode(ff, seq, tmp, sceneS, totalS, vcfg.fps);
      const info = await vs.probeInfo(ff, tmp);
      const got = vs.durationMs(info);
      if (got === null || Math.abs(got - totalS * 1000) > 100 || /Stream #\S+: Audio:/.test(info)) {
        throw new vs.RuntimeErr('mp4 sai thời lượng / có track âm thanh');
      }
      for (const t of [500, totalS * 500, totalS * 1000 - 500]) {
        const ref = frames[Math.min(Math.floor(t / (sceneS * 1000)), n - 1)] as Raw;
        const frame = await vs.vhooks.extractFrame(ff, tmp, t);
        const ratio = vs.labelVisible(frame, ref, lbox, rgb, vcfg.extract_tol);
        checks.push({ t_ms: t, label_ratio: Math.round(ratio * 1e4) / 1e4 });
      }
    } catch (e) {
      if (!(e instanceof vs.RuntimeErr)) throw e;
      return { ok: false, error: cpSlice(e.message, 0, 200), title: sh.title };
    }
    if (checks.some((c) => c.label_ratio < vcfg.extract_min_ratio)) {
      return { ok: false, refused: 'nhan_ai', title: sh.title, checks };
    }
    sha = sha256(readFileSync(tmp));
    mp4 = join(odir, `${sha}.mp4`);
    let same = false;
    try {
      same = sha256(readFileSync(mp4)) === sha;
    } catch {
      same = false;
    }
    if (!same) renameSync(tmp, mp4);
  } finally {
    rmSync(td, { recursive: true, force: true, maxRetries: 3 });
  }
  const meta = {
    schema: SIDECAR_SCHEMA,
    file: basename(mp4),
    asset_sha256: sha,
    size: [W, H],
    duration_ms: totalS * 1000,
    labels,
    title: sh.title,
    segments: sh.segments,
    broll: used,
    extract_check: checks,
    tts: null,
    music: null,
    privacyStatus: PRIVACY,
    created_at: ims.isoNow(),
  };
  const side = join(odir, `${sha}.json`);
  if (ims.sameSidecar(side, meta) === null) {
    ims.writeAtomic(side, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  }
  return { ok: true, path: mp4, sidecar: side, sha256: sha, title: sh.title, checks };
}

/** `render_shorts`: dựng xem trước từng Short → [{ok, path, sha256, …} | {ok false, refused:
 * config|broll_thieu|ffmpeg_thieu|thoi_luong|nhan_ai|…} | {ok false, error}]. Có `db` → mỗi Short đạt
 * 1 dòng `agent_action_log` `youtube_short_render` (cùng giao dịch). */
export async function renderShorts(
  pkg: Package,
  o: {
    brollDir?: string;
    outDir?: string;
    db?: Db | null;
    draftId?: string | null;
    env?: Env;
  } = {},
): Promise<ShortResult[]> {
  if (!pkg.ok || !pkg.shorts.length) return [];
  const env = o.env ?? process.env;
  const fail = (refused: string): ShortResult[] =>
    pkg.shorts.map((sh) => ({ ok: false, refused, title: sh.title }));
  const [vcfg] = vs.loadConfig();
  if (vcfg === null) return fail('config');
  const [, ai, ad] = publishTexts();
  const [brolls] = await vs.brolls(o.brollDir || env.BROLL_DIR || vs.paths.broll, vcfg.img);
  if (!brolls.length) return fail('broll_thieu');
  const ff = vs.vhooks.findFfmpeg(env);
  if (ff === null) return fail('ffmpeg_thieu');
  if (!(ai.length && ad.length)) return fail('config');
  const odir = o.outDir || env.VIDEO_OUT_DIR || vs.paths.out;
  mkdirSync(odir, { recursive: true });
  const labels = [ai[0] as string, ad[0] as string];
  const res: ShortResult[] = [];
  for (const sh of pkg.shorts)
    res.push(await renderOne(ff, sh, pkg, brolls, odir, vcfg, labels, env));
  const ok = res.filter((r) => r.ok);
  if (o.db && ok.length) {
    const did = o.draftId ?? null;
    await withTx(o.db, async (c) => {
      for (const r of ok) {
        await c.query(LOG_SQL, [
          CREATED_BY,
          'youtube_short_render',
          'content_draft',
          did,
          JSON.stringify({ sha256: r.sha256, draft_id: did === null ? null : Number(did) }),
        ]);
      }
    });
  }
  return res;
}
