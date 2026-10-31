import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, extname, join } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { ChatMessage } from '@samsam/core/ai/providers';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cpLen, cpSlice, isPlainObject, readJson } from '@samsam/core/ops/py';
import { SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import { check, type ReadinessMap } from '@samsam/core/security/guardrail';
import { checkPublishLlm } from '@samsam/core/security/guardrail-llm';
import {
  casefold,
  pyRepr,
  pyReprValue,
  pyStr,
  pyStrip,
  re,
  S,
  sub,
  W,
} from '@samsam/core/security/py';
import {
  type AiDeps,
  contentCfg,
  feedback,
  type Guardrail,
  loadTemplate,
  publishTexts,
  type Refusal,
  refusedGuardrail,
  specLike,
  system,
  withRequired,
} from '../content/content.js';
import * as ims from './image-studio.js';
import type { Raw } from './raster.js';
import * as raster from './raster.js';
import { clean, codes, termHits, uniq } from './terms.js';

// Port `pipelines/video_studio.py` — MKT-04 "Agent Video ngắn" (v6.3, WP08, tính năng
// marketing-02.2): video dọc NHÁP từ packshot thật.
// - Video dựng TẤT ĐỊNH từ khung PNG: khung packshot (và khung kết = tên SKU golden, do CODE) =
//   `compose` của image_studio (packshot thật dán sau cùng, nhãn AI, phụ đề ở ô headline); đọc BYTES
//   khung 1 lần và kiểm lại `verifyPackshot` TRƯỚC khi ghép — lệch 1 pixel → `packshot_lech`, 0 mp4/
//   sidecar/DB. Khung B-roll = ảnh tĩnh công ty cấp trong BROLL_DIR, CHỈ khi có license trong
//   `licenses.json`, dựng lại RGB từ pixel (mất EXIF/GPS/ICC) + cùng lớp chữ với ảnh. Clip video làm
//   B-roll chưa hỗ trợ (bỏ qua).
// - Kịch bản LUÔN do LLM (AI Gateway, agent `mkt_video`, trần tháng) → video LUÔN là nội dung AI:
//   nhãn AI + nhãn QC vẽ trên MỌI khung và có trong caption. Sau mã hóa trích 3 khung (đầu/giữa/cuối)
//   kiểm nhãn còn hiện — thiếu → `nhan_ai`, xóa mp4.
// - Câu chạm số/giá/quy cách bị BỎ; câu có từ cấm kịch bản hoặc caption vi phạm `checkPublishLlm` →
//   1 lượt sửa có feedback → còn vi phạm → `kich_ban`.
// - Từ chối TRƯỚC LLM (0 lời gọi, 0 file, 0 DB): config | precheck ảnh (ruou, maket_xnqc, sku_la) |
//   kenh_la | format_la | readiness | brief_cam | tts | packshot_thieu. Sau LLM: kich_ban →
//   ffmpeg_thieu (kịch bản vẫn trả trong `script`) → mã từ chối của compose → packshot_lech → nhan_ai.
// - mp4 không track âm thanh khi TTS `none`, không metadata (`-map_metadata -1`, bitexact). ffmpeg gọi
//   KHÔNG shell (spawn, shell=false), input chỉ PNG local.
// - Chỉ là NHÁP: `saveVideo` ghi `content_drafts` (content_type 'video', pending) + `video_assets`.
//   Không có đường duyệt/đăng, không gọi mạng ngoài AI Gateway.
// TTS: env TTS_PROVIDER đọc LÚC GỌI, mặc định `none` (không tiếng). Provider thật = external-dep,
// KHÔNG có tham số âm thanh/ảnh mẫu (không nhân bản giọng/hình người thật).
// ffmpeg: env FFMPEG_BIN → PATH. shortcut: Python còn thử gói `imageio-ffmpeg` — TS không có; trên
// server đặt FFMPEG_BIN hoặc cài ffmpeg vào PATH.

export const CONTENT_TYPE = 'video';
export const AGENT = 'mkt_video';
export const FEATURE = 'marketing-02.2';
export const DEFAULT_BY = 'agent:mkt04';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const TEMPLATE = 'video_script';
export const SIDECAR_SCHEMA = 'video_asset@1';
export const SAMPLE_LICENSE = 'MẪU — tự sinh, không phải tư liệu thật';
export const MAX_BRIEF = 500;
export const FFMPEG_TIMEOUT_S = 300;
export const BROLL_EXT = ['.png', '.jpg', '.jpeg'];
export const CHANNEL_NAME: Record<string, string> = {
  tiktok: 'TikTok',
  facebook: 'Facebook Reels',
};
export const VISUALS = ['packshot', 'broll'];
/** Tên → TTS. `none` = không tiếng. Provider thật = external-dep (chưa cắm). */
export const TTS_PROVIDERS: Record<string, null> = { none: null };

/** Chỉ test đổi (Python monkeypatch `CONFIG`). */
export const paths = {
  config: dataPath('video_studio.json'),
  broll: dataPath('broll'),
  out: dataPath('video_assets'),
};

/** Python RuntimeError (ffmpeg lỗi/timeout, mp4 sai). */
export class RuntimeErr extends Error {
  override name = 'RuntimeError';
}

// ===================================================================== config

export type VideoCfg = {
  channels: string[];
  formats: string[];
  scene_s: number;
  min_scenes: number;
  max_scenes: number;
  duration_s: [number, number];
  fps: number;
  max_chars: number;
  script_banned: string[];
  voices: string[];
  extract_tol: number;
  extract_min_ratio: number;
  img: ims.ImageCfg;
};

function intIn(v: unknown, lo: number, hi: number): number {
  if (!(typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi)) {
    throw new ims.PyErr('ValueError', `giá trị ${pyReprValue(v)} ngoài ${lo}..${hi}`);
  }
  return v;
}

/** `video_studio.load_config`: data/video_studio.json + data/image_studio.json (cỡ/layout khung,
 * nhãn) đã kiểm → [cfg, null] | [null, lý do]. Kiểm thời lượng: scene_s × (min_scenes+1) ≥
 * duration_s[0] và scene_s × (max_scenes+1) ≤ duration_s[1] (mỗi cảnh 1 khung + 1 khung kết). */
export function loadConfig(path: string = paths.config): [VideoCfg, null] | [null, string] {
  const [icfg, err] = ims.loadConfig();
  if (icfg === null) return [null, err];
  try {
    const doc = readJson(path);
    const dur = ims.key(doc, 'duration_s');
    if (!Array.isArray(dur)) throw new ims.PyErr('TypeError', 'cannot unpack non-iterable object');
    if (dur.length < 2) {
      throw new ims.PyErr(
        'ValueError',
        `not enough values to unpack (expected 2, got ${dur.length})`,
      );
    }
    if (dur.length > 2) throw new ims.PyErr('ValueError', 'too many values to unpack (expected 2)');
    const [lo, hi] = dur as [unknown, unknown];
    const cfg: VideoCfg = {
      channels: ims.list(ims.key(doc, 'channels')).map(pyStr),
      formats: ims.list(ims.key(doc, 'formats')).map(pyStr),
      scene_s: intIn(ims.key(doc, 'scene_s'), 1, 60),
      min_scenes: intIn(ims.key(doc, 'min_scenes'), 1, 100),
      max_scenes: intIn(ims.key(doc, 'max_scenes'), 1, 100),
      duration_s: [intIn(lo, 1, 600), intIn(hi, 1, 600)],
      fps: intIn(ims.key(doc, 'fps'), 1, 60),
      max_chars: intIn(ims.key(ims.key(doc, 'subtitle'), 'max_chars'), 1, icfg.headline.max_chars),
      script_banned: ims
        .list(ims.key(doc, 'script_banned'))
        .map(pyStr)
        .filter((x) => pyStrip(x)),
      voices: ims.list(ims.key(ims.key(doc, 'tts'), 'voices')).map(pyStr),
      extract_tol: intIn(ims.key(doc, 'extract_tol'), 0, 255),
      extract_min_ratio: ims.toFloat(ims.key(doc, 'extract_min_ratio')),
      img: icfg,
    };
    const bad = cfg.formats.filter((f) => !icfg.formats.has(f));
    if (bad.length) {
      throw new ims.PyErr('ValueError', `format ${pyStr(bad)} không có trong image_studio.json`);
    }
    if (!cfg.channels.length || !cfg.formats.length || !cfg.script_banned.length) {
      throw new ims.PyErr('ValueError', 'thiếu kênh/format/từ cấm kịch bản');
    }
    if (cfg.min_scenes > cfg.max_scenes)
      throw new ims.PyErr('ValueError', 'min_scenes > max_scenes');
    if (!(cfg.extract_min_ratio > 0 && cfg.extract_min_ratio <= 1)) {
      throw new ims.PyErr('ValueError', 'extract_min_ratio phải trong (0, 1]');
    }
    const s = cfg.scene_s;
    const [l, h] = cfg.duration_s;
    if (s * (cfg.min_scenes + 1) < l || s * (cfg.max_scenes + 1) > h) {
      throw new ims.PyErr('ValueError', `scene_s × (số cảnh + 1) phải nằm trong [${l}, ${h}] giây`);
    }
    return [cfg, null];
  } catch (e) {
    return [null, `video_studio.json không dùng được (${ims.pyErrText(e, path)})`];
  }
}

// ===================================================================== precheck

/** `precheck_video`: từ chối rẻ (0 LLM, 0 file). Tái dùng `precheckImage` (rượu theo category
 * TRƯỚC readiness; MỌI SKU TPBVSK → maket_xnqc), rồi kênh / format của video (TRƯỚC readiness). */
export function precheckVideo(
  sku: unknown,
  channel: unknown,
  fmt: unknown,
  readiness: unknown = null,
): Refusal | null {
  const [cfg, err] = loadConfig();
  if (cfg === null) return { code: 'config', reason: err };
  const ref = ims.precheckImage(sku, channel, fmt, readiness);
  if (ref && ref.code !== 'readiness' && ref.code !== 'format_la') return ref;
  if (typeof channel !== 'string' || !cfg.channels.includes(channel)) {
    return {
      code: 'kenh_la',
      reason: `kênh ${pyRepr(cpSlice(pyStr(channel), 0, 40))} không hỗ trợ cho video (${cfg.channels.join(', ')})`,
    };
  }
  if (typeof fmt !== 'string' || !cfg.formats.includes(fmt)) {
    return {
      code: 'format_la',
      reason: `format ${pyRepr(cpSlice(pyStr(fmt), 0, 20))} không hỗ trợ cho video (${cfg.formats.join(', ')})`,
    };
  }
  return ref;
}

const PUNCT_RE = re(`[^${W}${S}]+`);

/** `_banned`: từ cấm khớp (chuẩn hóa như guardrail) — kiểm cả bản thay dấu câu bằng khoảng trắng
 * ("chuyên-gia", "bác.sĩ"). */
export function banned(text: string, terms: readonly string[]): string[] {
  const hits: string[] = [];
  for (const t of uniq([text, sub(PUNCT_RE, ' ', text)])) hits.push(...termHits(t, terms));
  return uniq(hits);
}

/** `check_brief`: brief do người nhập → {code: brief_cam, reason} | null. Chặn: rỗng / dài >
 * MAX_BRIEF / từ cấm kịch bản / nhắc sức khỏe-bệnh / `guardrail.check` không ok. Kiểm trên
 * `clean(brief)` = chuỗi vào prompt. */
export function checkBrief(brief: unknown): Refusal | null {
  const [cfg, err] = loadConfig();
  if (cfg === null) return { code: 'config', reason: err };
  const s = clean(brief);
  if (!s) return { code: 'brief_cam', reason: 'brief rỗng' };
  if (cpLen(s) > MAX_BRIEF)
    return { code: 'brief_cam', reason: `brief dài hơn ${MAX_BRIEF} ký tự` };
  const hits = banned(s, cfg.script_banned);
  if (hits.length) {
    return {
      code: 'brief_cam',
      reason: `brief có từ cấm (${hits.join(', ')}) — video không dùng người/y tế/chuyên gia, trước-sau, cam kết`,
    };
  }
  if (isHealthQuestion(s)) {
    return {
      code: 'brief_cam',
      reason: 'brief nhắc sức khỏe/bệnh — video không gợi công dụng chữa bệnh',
    };
  }
  const g = check(s);
  if (g.ok !== true) return { code: 'brief_cam', reason: `brief vi phạm guardrail (${codes(g)})` };
  return null;
}

export const ttsName = (env: Env = process.env): string =>
  pyStrip(env.TTS_PROVIDER ?? '') || 'none';

/** `_pre`: thứ tự từ chối trước LLM: config | precheck | brief | tts. */
function pre(
  sku: unknown,
  channel: unknown,
  fmt: unknown,
  brief: unknown,
  readiness: unknown,
  env: Env,
): Refusal | null {
  const [, err] = loadConfig();
  if (err !== null) return { code: 'config', reason: err };
  const ref = precheckVideo(sku, channel, fmt, readiness) ?? checkBrief(brief);
  if (ref) return ref;
  const name = ttsName(env);
  if (!Object.hasOwn(TTS_PROVIDERS, name)) {
    return {
      code: 'tts',
      reason: `chưa cắm TTS ${pyRepr(cpSlice(name, 0, 40))} — TTS tiếng Việt có phí là external-dep; hỗ trợ: ${Object.keys(TTS_PROVIDERS).sort().join(', ')}`,
    };
  }
  return null;
}

// ===================================================================== kịch bản

export type Scene = { text: string; visual: string };
const FENCE_RE = re(`^\`\`\`(?:json)?[${S}]*([\\s\\S]*?)[${S}]*\`\`\`$`);

/** `_parse_scenes`: JSON chặt {"scenes": [{"text": str, "visual": packshot|broll}]} (bỏ 1 lớp
 * code-fence). Sai shape → null. */
export function parseScenes(text: unknown): Scene[] | null {
  if (typeof text !== 'string') return null;
  let s = pyStrip(text);
  const m = FENCE_RE.exec(s);
  if (m) s = m[1] as string;
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  const sc = isPlainObject(obj) ? obj.scenes : null;
  if (
    !(
      Array.isArray(sc) &&
      sc.length &&
      sc.every(
        (x) =>
          isPlainObject(x) && typeof x.text === 'string' && VISUALS.includes(x.visual as string),
      )
    )
  ) {
    return null;
  }
  return (sc as Scene[]).map((x) => ({ text: x.text, visual: x.visual }));
}

export type Dropped = { text: string; ly_do: string };

/** `_filter`: giữ câu sạch; bỏ rỗng, câu chạm số/giá (`so_lieu`), câu dài (`dai`), cảnh vượt
 * max_scenes (`thua`). */
export function filterScenes(
  scenes: Scene[],
  cfg: { max_chars: number; max_scenes: number },
): [Scene[], Dropped[]] {
  const kept: Scene[] = [];
  const dropped: Dropped[] = [];
  for (const sc of scenes) {
    const t = clean(sc.text);
    if (!t) continue;
    if (specLike(t)) dropped.push({ text: t, ly_do: 'so_lieu' });
    else if (cpLen(t) > cfg.max_chars) dropped.push({ text: t, ly_do: 'dai' });
    else if (kept.length >= cfg.max_scenes) dropped.push({ text: t, ly_do: 'thua' });
    else kept.push({ text: t, visual: sc.visual });
  }
  return [kept, dropped];
}

const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Python `json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(',')}]`;
  if (isPlainObject(v)) {
    const ks = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${ks.map((k) => `${JSON.stringify(k)}:${pyJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** `_msgs_sha`: sha256 của messages (JSON sắp khóa, gọn). */
export const msgsSha = (messages: unknown): string => sha256(Buffer.from(pyJson(messages), 'utf8'));

export type ScriptResult = {
  ok: boolean;
  refused: Refusal | null;
  error: string | null;
  scenes: Scene[];
  dropped: Dropped[];
  caption: string;
  guardrail: Guardrail | null;
  model: string | null;
  prompt_version: string | null;
  template_sha256: string | null;
  prompt_sha256: string | null;
  llm_calls: number;
};

const errType = (e: unknown): string =>
  e instanceof Error ? (e.name === 'Error' ? e.constructor.name : e.name) : 'Exception';

export type VideoDeps = { ai: AiDeps['ai']; env?: Env };

/** `write_script`: kịch bản qua AI Gateway (agent `mkt_video`) → lọc → guardrail. Từ chối trước LLM
 * = 0 lời gọi. Vi phạm (từ cấm kịch bản trên MỌI câu LLM trả, kể cả câu bị bỏ; caption không qua
 * `checkPublishLlm`) → 1 lượt sửa có feedback → còn vi phạm → `kich_ban`. JSON sai shape / còn <
 * min_scenes cảnh → `kich_ban` (không sửa). Lỗi gateway (kill/trần/nhà cung cấp) → `error`. */
export async function writeScript(
  sku: unknown,
  channel: unknown,
  brief: unknown,
  o: { fmt?: string; readiness?: unknown },
  d: VideoDeps,
): Promise<ScriptResult> {
  const env = d.env ?? process.env;
  const fmt = o.fmt ?? '9:16';
  const readiness = o.readiness ?? null;
  const out: ScriptResult = {
    ok: false,
    refused: null,
    error: null,
    scenes: [],
    dropped: [],
    caption: '',
    guardrail: null,
    model: null,
    prompt_version: null,
    template_sha256: null,
    prompt_sha256: null,
    llm_calls: 0,
  };
  const refuse = (
    code: string,
    reason: string,
    g: Guardrail | null = null,
    kw: Partial<ScriptResult> = {},
  ) => {
    const ref = { code, reason };
    return { ...out, ...kw, refused: ref, guardrail: g ?? refusedGuardrail(ref) };
  };
  const ref = pre(sku, channel, fmt, brief, readiness, env);
  if (ref) return refuse(ref.code, ref.reason);
  const [cfg] = loadConfig() as [VideoCfg, null];
  let tmpl: string;
  let ver: string;
  let tsha: string;
  try {
    [tmpl, ver, tsha] = loadTemplate(TEMPLATE);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return refuse('config', e.message);
  }
  const [gcfg, gerr] = contentCfg();
  if (gcfg === null) return refuse('config', gerr);
  const s = sku as string;
  const ch = channel as string;
  const name = pyStr(gcfg.golden.get(s)?.name);
  // {brief} thay CUỐI — chữ trong brief không bị thay tiếp.
  const b = clean(brief);
  const fmtText = tmpl
    .replaceAll('{channel}', () => CHANNEL_NAME[ch] ?? ch)
    .replaceAll('{sku_name}', () => name)
    .replaceAll('{brief}', () => b);
  let messages: ChatMessage[] = [
    { role: 'system', content: system(fmtText, false) },
    { role: 'user', content: `SẢN PHẨM: ${name} (mã ${s}). Trả về DUY NHẤT JSON đúng mẫu.` },
  ];
  const rmap = readiness as ReadinessMap | null;
  const ctx = { channel: ch, contentType: CONTENT_TYPE, sku: s, readiness: rmap };
  const meta: Partial<ScriptResult> = { prompt_version: ver, template_sha256: tsha };
  for (const calls of [1, 2]) {
    // bản nháp + 1 lượt sửa có feedback
    meta.prompt_sha256 = msgsSha(messages);
    let text: string;
    let model: unknown;
    try {
      const resp = await d.ai.chat(AGENT, messages, {
        feature: FEATURE,
        temperature: 0.3,
        maxTokens: 700,
      });
      text = resp.text;
      model = resp.model;
    } catch (e) {
      const msg = cpSlice(e instanceof Error ? e.message : String(e), 0, 160);
      return { ...out, ...meta, llm_calls: calls, error: `llm: ${errType(e)}: ${msg}` };
    }
    meta.model = cpSlice(
      typeof model === 'string' && pyStrip(model) ? model : env.OR_CHAT_MODEL || DEFAULT_MODEL,
      0,
      100,
    );
    const scenes = parseScenes(text);
    if (scenes === null) {
      return refuse('kich_ban', 'LLM trả sai mẫu JSON {"scenes": [{"text", "visual"}]}', null, {
        ...meta,
        llm_calls: calls,
      });
    }
    const [kept, dropped] = filterScenes(scenes, cfg);
    const caption = withRequired(kept.map((x) => x.text).join('\n'), ctx);
    const hits = uniq(scenes.flatMap((x) => banned(clean(x.text), cfg.script_banned)));
    const g = (await checkPublishLlm(
      caption,
      { ...ctx, isAi: true },
      { gateway: d.ai, env },
    )) as Guardrail;
    const state: Partial<ScriptResult> = {
      ...meta,
      llm_calls: calls,
      scenes: kept,
      dropped,
      caption,
    };
    if (!hits.length && g.ok === true) {
      if (kept.length < cfg.min_scenes) {
        // guardrail = bản từ chối (không trả g ok cho kết quả bị loại)
        return refuse(
          'kich_ban',
          `sau lọc còn ${kept.length} cảnh < ${cfg.min_scenes} (câu số/giá/dài bị bỏ)`,
          null,
          state,
        );
      }
      return { ...out, ...state, ok: true, guardrail: g };
    }
    const why: string[] = [];
    if (hits.length) why.push(`từ cấm kịch bản (${hits.join(', ')})`);
    if (g.ok !== true) why.push(`guardrail (${codes(g)})`);
    if (calls === 2) {
      return refuse('kich_ban', `kịch bản vi phạm sau 1 lượt sửa: ${why.join('; ')}`, g, state);
    }
    const fb = {
      violations: [
        ...hits.map((h) => ({ code: 'tu_cam_kich_ban', span: h })),
        ...(Array.isArray(g.violations) ? g.violations : []),
      ],
    };
    messages = [
      ...messages,
      { role: 'assistant', content: pyStr(text) },
      {
        role: 'user',
        content: `${feedback(fb)} Không nhắc bác sĩ/chuyên gia/cơ sở y tế. Trả lại DUY NHẤT JSON đúng mẫu.`,
      },
    ];
  }
  throw new Error('unreachable');
}

// ===================================================================== ffmpeg

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `find_ffmpeg`: env FFMPEG_BIN (file có thật) → PATH → null. */
export function findFfmpeg(env: Env = process.env): string | null {
  const p = pyStrip(env.FFMPEG_BIN ?? '');
  if (p && isFile(p)) return p;
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const c = join(dir, `ffmpeg${ext.toLowerCase()}`);
      if (isFile(c)) return c;
    }
  }
  return null;
}

type Done = { code: number | null; stdout: Buffer; stderr: Buffer };

/** `_run`: ffmpeg KHÔNG shell, không stdin; lỗi khởi chạy/timeout → RuntimeError. */
export function runFf(cmd: string[]): Promise<Done> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd[0] as string, cmd.slice(1), {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new RuntimeErr(`ffmpeg không chạy được (${errType(e)})`));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new RuntimeErr('ffmpeg không chạy được (TimeoutExpired)'));
    }, FFMPEG_TIMEOUT_S * 1000);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RuntimeErr(`ffmpeg không chạy được (${errType(e)})`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/** `_encode`: chuỗi PNG → mp4 H.264, không âm thanh, không metadata, bitexact. */
async function encode(
  ff: string,
  seq: string,
  out: string,
  sceneS: number,
  totalS: number,
  fps: number,
): Promise<void> {
  const r = await runFf([
    ff,
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2',
    '-framerate',
    `1/${sceneS}`,
    '-i',
    join(seq, '%03d.png'),
    '-t',
    String(totalS),
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'stillimage',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-an',
    '-movflags',
    '+faststart',
    out,
  ]);
  if (r.code !== 0 || !isFile(out)) {
    throw new RuntimeErr(
      `ffmpeg mã hóa lỗi (rc=${r.code}): ${r.stderr.toString('utf8').slice(-200)}`,
    );
  }
}

/** `_probe`: stderr của `ffmpeg -i` (thông tin luồng). */
export async function probeInfo(ff: string, path: string): Promise<string> {
  return (await runFf([ff, '-nostdin', '-hide_banner', '-i', path])).stderr.toString('utf8');
}

const DUR_RE = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/;

/** `_duration_ms`: thời lượng từ thông tin luồng (ms) | null. */
export function durationMs(info: string): number | null {
  const m = DUR_RE.exec(info);
  if (!m) return null;
  return ims.pyRound((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** `_extract_frame`: khung tại t_ms trích từ mp4 (PNG qua pipe) → ảnh RGB. */
async function extractFrame(ff: string, path: string, tMs: number): Promise<Raw> {
  const r = await runFf([
    ff,
    '-nostdin',
    '-loglevel',
    'error',
    '-ss',
    (tMs / 1000).toFixed(3),
    '-i',
    path,
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-c:v',
    'png',
    'pipe:1',
  ]);
  if (r.code !== 0 || !r.stdout.length) throw new RuntimeErr(`ffmpeg trích khung ${tMs} ms lỗi`);
  return raster.decode(r.stdout, 3);
}

/** `label_visible`: tỉ lệ (pixel gần màu chữ nhãn — mọi kênh |Δ| ≤ tol — trong `box` của `frame`) /
 * (số đó trên `ref`). ref 0 pixel / khác cỡ / input hỏng → 0. Thuần. Mã hóa yuv420p làm mềm viền chữ
 * nên so có dung sai. */
export function labelVisible(
  frame: unknown,
  ref: unknown,
  box: readonly number[],
  rgb: readonly number[],
  tol = 40,
): number {
  if (!raster.isRaw(frame) || !raster.isRaw(ref)) return 0;
  if (frame.width !== ref.width || frame.height !== ref.height) return 0;
  const n = raster.nearCount(ref, box, rgb, tol);
  return n ? raster.nearCount(frame, box, rgb, tol) / n : 0;
}

/** `_label_drawn`: khung có chữ nhãn THẬT — pixel ĐÚNG màu label.text_rgb trong label_box ≥ 0.05%. */
export function labelDrawn(img: Raw, box: readonly number[], rgb: readonly number[]): boolean {
  return ims.colorCount(img, box, rgb) >= 0.0005 * (box[2] as number) * (box[3] as number);
}

// ===================================================================== B-roll

function licenses(bdir: string): Record<string, unknown> {
  try {
    const d = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(bdir, 'licenses.json'))),
    );
    return isPlainObject(d) ? d : {};
  } catch {
    return {};
  }
}

export type Broll = { path: string; file: string; license: string };

/** `_brolls`: B-roll hợp lệ (sắp theo tên) + danh sách bị bỏ {file, ly_do}. Chỉ ảnh .png/.jpg/.jpeg
 * có license chuỗi khác rỗng trong licenses.json, kiểm byte + pixel từ HEADER (chưa giải). */
export async function brolls(
  bdir: string,
  icfg: ims.ImageCfg,
): Promise<[Broll[], { file: string; ly_do: string }[]]> {
  let names: string[];
  try {
    if (!statSync(bdir).isDirectory()) return [[], []];
    names = readdirSync(bdir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [[], []];
  }
  const lic = licenses(bdir);
  const ok: Broll[] = [];
  const skipped: { file: string; ly_do: string }[] = [];
  for (const name of names) {
    const p = join(bdir, name);
    if (name === 'licenses.json' || !isFile(p)) continue;
    if (!BROLL_EXT.includes(casefold(extname(name)))) {
      skipped.push({ file: name, ly_do: 'dinh_dang' });
      continue;
    }
    const l = Object.hasOwn(lic, name) ? lic[name] : undefined;
    if (!(typeof l === 'string' && pyStrip(l))) {
      skipped.push({ file: name, ly_do: 'license' });
      continue;
    }
    try {
      if (statSync(p).size > icfg.max_bytes) throw new Error('bytes');
      const h = await raster.probe(readFileSync(p));
      if (!['PNG', 'JPEG'].includes(h.format) || h.width * h.height > icfg.max_pixels) {
        throw new Error('pixels');
      }
    } catch (e) {
      if (e instanceof raster.RasterUnavailable) throw e;
      skipped.push({ file: name, ly_do: 'anh_loi' });
      continue;
    }
    ok.push({ path: p, file: name, license: pyStrip(l) });
  }
  return [ok, skipped];
}

/** `_broll_frame` → [png, ảnh RGB, sha file] | [null, code, reason]. Ảnh B-roll cắt phủ về cỡ
 * format, DỰNG LẠI từ pixel (không EXIF/GPS/ICC) + lớp chữ (phụ đề ô headline + nhãn) như ảnh. */
export async function brollFrame(
  b: Broll,
  text: string,
  fmt: string,
  icfg: ims.ImageCfg,
  labels: string[],
  env: Env = process.env,
): Promise<[Buffer, Raw, string] | [null, string, string]> {
  const font = ims.fontsFor([text, ...labels].join('\n'), env);
  if (font === null) return [null, 'font', 'không font nào phủ đủ glyph phụ đề/nhãn'];
  const laid = await ims.layoutText(font, icfg, fmt, text, labels);
  if (Array.isArray(laid)) return [null, laid[0], laid[1]];
  const [W, H] = icfg.formats.get(fmt) as [number, number];
  let raw: Buffer;
  let src: Raw;
  try {
    raw = readFileSync(b.path);
    if (raw.length > icfg.max_bytes) throw Object.assign(new Error('bytes'), { py: 'ValueError' });
    let h: Awaited<ReturnType<typeof raster.probe>>;
    try {
      h = await raster.probe(raw);
    } catch (e) {
      if (e instanceof raster.RasterUnavailable) throw e;
      throw Object.assign(new Error('x'), { py: 'UnidentifiedImageError' });
    }
    if (h.width * h.height > icfg.max_pixels)
      throw Object.assign(new Error('pixels'), { py: 'ValueError' });
    src = await raster.decode(raw, 3, icfg.max_pixels);
  } catch (e) {
    if (e instanceof raster.RasterUnavailable) throw e;
    const n = (e as { py?: string }).py ?? 'OSError';
    return [null, 'broll_loi', `B-roll ${b.file} không đọc được (${n})`];
  }
  const bg = await raster.coverFit(src, W, H);
  const canvas = raster.compositeOver(bg, laid.overlay);
  const png = await raster.encodePng(canvas);
  return [png, canvas, sha256(raw)];
}

/** Tô đa giác (tâm pixel, chẵn-lẻ) — chỉ cho ảnh MẪU. */
function fillPolygon(img: Raw, pts: [number, number][], color: number[]): void {
  for (let y = 0; y < img.height; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i] as [number, number];
      const [x2, y2] = pts[(i + 1) % pts.length] as [number, number];
      if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy))
        xs.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k] as number) - 0.5));
      const z = Math.min(img.width - 1, Math.floor((xs[k + 1] as number) - 0.5));
      for (let x = a; x <= z; x++) img.data.set(color, (y * img.width + x) * img.channels);
    }
  }
}

/** `make_sample_broll`: B-roll MẪU (núi xanh + chữ "MẪU B-roll") cho test/eval — KHÔNG phải tư liệu
 * thật. Đuôi .jpg/.jpeg → JPEG (exifGps nhúng EXIF GPS + máy ảnh để test output không mang vị trí),
 * khác → PNG. `license` khác null → ghi/gộp vào `<thư mục>/licenses.json`. */
export async function makeSampleBroll(
  path: string,
  o: { exifGps?: boolean; license?: string | null; env?: Env } = {},
): Promise<string> {
  const W = 1280;
  const H = 960;
  const img = raster.newRaw(W, H, 3, [150, 190, 220]);
  fillPolygon(
    img,
    [
      [0, H],
      [Math.floor((W * 2) / 5), Math.floor(H / 3)],
      [Math.floor((W * 4) / 5), H],
    ],
    [40, 110, 60],
  );
  fillPolygon(
    img,
    [
      [Math.floor(W / 3), H],
      [Math.floor((W * 3) / 4), Math.floor(H / 2)],
      [W, Math.floor((H * 3) / 4)],
      [W, H],
    ],
    [70, 140, 80],
  );
  const font = ims.fontsFor('MẪU B-roll', o.env);
  if (font) {
    const m = await raster.renderText(font, 'MẪU B-roll', Math.floor(H / 10), 0, 'left');
    const rgba = raster.toChannels(img, 4);
    raster.drawMask(
      rgba,
      m,
      Math.floor((W - m.width) / 2),
      Math.floor((H - m.height) / 2),
      [200, 20, 20, 255],
    );
    img.data.set(raster.toChannels(rgba, 3).data);
  }
  mkdirSync(join(path, '..'), { recursive: true });
  const jpeg = ['.jpg', '.jpeg'].includes(casefold(extname(path)));
  let p = (await raster.sharp())(img.data, { raw: { width: W, height: H, channels: 3 } });
  if (o.exifGps) {
    p = p.withExif({
      IFD0: { Make: 'MAU-Camera', Model: 'MAU-Model' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '15/1 30/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '108/1 0/1 0/1',
      },
    });
  }
  writeFileSync(path, await (jpeg ? p.jpeg() : p.png()).toBuffer());
  const license = o.license === undefined ? SAMPLE_LICENSE : o.license;
  if (license !== null) {
    const dir = join(path, '..');
    const lic = licenses(dir);
    lic[basename(path)] = license;
    writeFileSync(join(dir, 'licenses.json'), Buffer.from(JSON.stringify(lic, null, 2), 'utf8'));
  }
  return path;
}

// ===================================================================== make_video

/** Điểm thay của test (Python monkeypatch `ims.compose` / `_encode` / `_extract_frame` / `find_ffmpeg`). */
export const vhooks = {
  compose: ims.compose,
  encode,
  extractFrame,
  findFfmpeg,
};

export type VideoMeta = Record<string, unknown> & {
  file: string;
  duration_ms: number;
  labels: string[];
  tts: { provider: string; voice: null };
};

export type VideoResult = {
  ok: boolean;
  refused: Refusal | null;
  error: string | null;
  path: string | null;
  sidecar: string | null;
  sha256: string | null;
  sku: string | null;
  channel: string | null;
  format: string | null;
  packshot_sha256: string | null;
  script: ScriptResult | null;
  draft_text: string;
  guardrail: Guardrail | null;
  meta: VideoMeta | null;
};

export type VideoOpts = {
  fmt?: string;
  readiness?: unknown;
  packshotDir?: string;
  brollDir?: string;
  outDir?: string;
};

/** `make_video`: dựng 1 video nháp. Từ chối → ok false + `refused`, 0 file; lỗi LLM/ffmpeg →
 * `error`. Thành công → `<out>/<sha256>.mp4` + sidecar `.json` (mp4 cùng tên giữ khi bytes đúng sha;
 * sidecar giữ khi trùng mọi field trừ created_at); `draft_text` = caption + dòng tên file. */
export async function makeVideo(
  sku: unknown,
  channel: unknown,
  brief: unknown,
  o: VideoOpts,
  d: VideoDeps,
): Promise<VideoResult> {
  const env = d.env ?? process.env;
  const fmt = o.fmt ?? '9:16';
  const readiness = o.readiness ?? null;
  const out: VideoResult = {
    ok: false,
    refused: null,
    error: null,
    path: null,
    sidecar: null,
    sha256: null,
    sku: null,
    channel: null,
    format: null,
    packshot_sha256: null,
    script: null,
    draft_text: '',
    guardrail: null,
    meta: null,
  };
  const refuse = (code: string, reason: string, kw: Partial<VideoResult> = {}) => {
    const ref = { code, reason };
    return { ...out, ...kw, refused: ref, guardrail: refusedGuardrail(ref) };
  };
  const ref = pre(sku, channel, fmt, brief, readiness, env);
  if (ref) return refuse(ref.code, ref.reason);
  const [cfg] = loadConfig() as [VideoCfg, null];
  const icfg = cfg.img;
  const s = sku as string;
  const ch = channel as string;
  const pdir = o.packshotDir || env.PACKSHOT_DIR || ims.paths.packshots;
  if (!(ims.SKU_FILE_RE.test(s) && isFile(join(pdir, `${s}.png`)))) {
    return refuse(
      'packshot_thieu',
      `thiếu packshot ${s}.png trong PACKSHOT_DIR — công ty cấp ảnh sản phẩm thật`,
    );
  }
  // TS-only (Python luôn có Pillow): thiếu `sharp` → từ chối config TRƯỚC LLM (không đốt LLM, không
  // ném ở đường B-roll/khung — sharp nạp được một lần thì các bước sau dùng chung).
  try {
    await raster.sharp();
  } catch (e) {
    if (e instanceof raster.RasterUnavailable) return refuse('config', e.message);
    throw e;
  }
  const script = await writeScript(s, ch, brief, { fmt, readiness }, d);
  if (script.error) return { ...out, error: script.error, script };
  if (!script.ok) return { ...out, refused: script.refused, script, guardrail: script.guardrail };
  const ff = vhooks.findFfmpeg(env);
  if (ff === null) {
    return refuse(
      'ffmpeg_thieu',
      'không tìm thấy ffmpeg (FFMPEG_BIN / PATH) — external-dep; kịch bản vẫn có trong `script`',
      { script },
    );
  }
  const [, ai, ad] = publishTexts();
  if (!(ai.length && ad.length)) {
    return refuse('config', 'guardrail_rules.json thiếu labels.ai/ad', { script });
  }
  const labels = [ai[0] as string, ad[0] as string];
  const rgb = icfg.label.text_rgb;
  const [W, H] = icfg.formats.get(fmt) as [number, number];
  const lbox = ims.px((icfg.layout.get(fmt) as { label_box: ims.Box }).label_box, [W, H]);
  const golden = pyStr(contentCfg()[0]?.golden.get(s)?.name);
  const [okBrolls, brollSkipped] = await brolls(o.brollDir || env.BROLL_DIR || paths.broll, icfg);
  const odir = o.outDir || env.VIDEO_OUT_DIR || paths.out;
  mkdirSync(odir, { recursive: true });
  const items: [string, string][] = [
    ...script.scenes.map((x): [string, string] => [x.text, x.visual]),
    [golden, 'end_card'],
  ];
  const S = cfg.scene_s;
  const totalMs = S * items.length * 1000;
  const td = mkdtempSync(join(odir, '.tmp-'));
  let sha = '';
  let mp4 = '';
  let data = Buffer.alloc(0);
  const checks: { t_ms: number; label_ratio: number }[] = [];
  const scenes: Record<string, unknown>[] = [];
  let psha: string | null = null;
  try {
    const seq = join(td, 'seq');
    mkdirSync(seq);
    const frames: Raw[] = [];
    let k = 0;
    for (const [i, [text, vis]] of items.entries()) {
      const sc: Record<string, unknown> = {
        i,
        source: vis,
        subtitle: text,
        start_ms: i * S * 1000,
        dur_ms: S * 1000,
        frame_sha256: null,
        packshot: null,
        broll: null,
        background: null,
      };
      let frame: Buffer;
      let img: Raw;
      if (vis === 'broll' && okBrolls.length) {
        const b = okBrolls[k % okBrolls.length] as Broll;
        k += 1;
        const r = await brollFrame(b, text, fmt, icfg, labels, env);
        if (r[0] === null) return refuse(r[1], r[2], { script });
        [frame, img] = r;
        sc.broll = { file_sha256: r[2], file: b.file, license: b.license };
        sc.background = { provider: 'broll', model: null };
      } else {
        if (vis === 'broll') sc.source = 'packshot'; // không B-roll hợp lệ
        const res = await vhooks.compose(
          s,
          ch,
          text,
          { fmt, readiness, packshotDir: pdir, outDir: join(td, 'compose') },
          { ai: d.ai, env },
        );
        if (!res.ok) {
          const rf = res.refused as Refusal;
          return refuse(rf.code, rf.reason, { script });
        }
        // Đọc BYTES khung đúng 1 lần — kiểm và ghép cùng bytes này.
        frame = readFileSync(res.path as string);
        img = await raster.decode(frame, 3);
        if (!raster.verifyPackshot(img, res.fitted, res.packshot_xy)) {
          return refuse(
            'packshot_lech',
            `khung cảnh ${i} có vùng packshot lệch pixel so với packshot gốc — loại video (không lớp nào được sửa nhãn sản phẩm)`,
            { script },
          );
        }
        const rm = res.meta as ims.ImageMeta;
        if (JSON.stringify(rm.labels) !== JSON.stringify(labels)) {
          return refuse('nhan_ai', `khung cảnh ${i} có nhãn lệch ${pyStr(labels)}`, { script });
        }
        psha = res.packshot_sha256;
        sc.packshot = rm.packshot;
        sc.background = { provider: rm.background.provider, model: rm.background.model };
      }
      if (!labelDrawn(img, lbox, rgb)) {
        return refuse('nhan_ai', `khung cảnh ${i} không có chữ nhãn AI trong label_box`, {
          script,
        });
      }
      sc.frame_sha256 = sha256(frame);
      writeFileSync(join(seq, `${String(i).padStart(3, '0')}.png`), frame);
      frames.push(img);
      scenes.push(sc);
    }
    const tmp = join(td, 'out.mp4');
    try {
      await vhooks.encode(ff, seq, tmp, S, Math.floor(totalMs / 1000), cfg.fps);
      const info = await probeInfo(ff, tmp);
      const got = durationMs(info);
      if (got === null || Math.abs(got - totalMs) > 100 || /Stream #\S+: Audio:/.test(info)) {
        throw new RuntimeErr('mp4 sai thời lượng / có track âm thanh');
      }
      // đầu / giữa cảnh giữa / cuối (không trích đúng ranh giới cảnh)
      const mid = Math.floor(items.length / 2) * S * 1000 + S * 500;
      for (const t of [500, mid, totalMs - 500]) {
        const refImg = frames[Math.min(Math.floor(t / (S * 1000)), frames.length - 1)] as Raw;
        const ratio = labelVisible(
          await vhooks.extractFrame(ff, tmp, t),
          refImg,
          lbox,
          rgb,
          cfg.extract_tol,
        );
        checks.push({ t_ms: t, label_ratio: Math.round(ratio * 1e4) / 1e4 });
      }
    } catch (e) {
      if (!(e instanceof RuntimeErr)) throw e;
      return { ...out, error: cpSlice(e.message, 0, 300), script };
    }
    const low = checks.filter((c) => c.label_ratio < cfg.extract_min_ratio);
    if (low.length) {
      return refuse('nhan_ai', `nhãn AI không còn hiện trên khung trích từ mp4: ${pyStr(low)}`, {
        script,
      });
    }
    data = readFileSync(tmp);
    sha = sha256(data);
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
  const side = join(odir, `${sha}.json`);
  let meta: VideoMeta = {
    schema: SIDECAR_SCHEMA,
    file: basename(mp4),
    asset_sha256: sha,
    size: [W, H],
    bytes: data.length,
    fps: cfg.fps,
    duration_ms: totalMs,
    labels,
    label_box: [...lbox],
    script: {
      model: script.model,
      prompt_version: script.prompt_version,
      template_sha256: script.template_sha256,
      lines: script.scenes.map((x) => x.text),
    },
    scenes,
    broll_skipped: brollSkipped,
    tts: { provider: ttsName(env), voice: null },
    music: null,
    extract_check: checks,
    created_at: ims.isoNow(),
    guardrail_ok: true,
  };
  const kept = ims.sameSidecar(side, meta);
  if (kept !== null) meta = kept as VideoMeta;
  else ims.writeAtomic(side, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  return {
    ...out,
    ok: true,
    path: mp4,
    sidecar: side,
    sha256: sha,
    sku: s,
    channel: ch,
    format: fmt,
    packshot_sha256: psha,
    script,
    draft_text: `${script.caption}\n\nTệp video: ${basename(mp4)}`,
    guardrail: script.guardrail,
    meta,
  };
}

// ===================================================================== lưu DB

const ASSET_SQL =
  'insert into video_assets (file_sha256, file_name, sku, channel, format, duration_ms, label_text, script_model, script_prompt_sha256, script_prompt_version, tts_provider, packshot_sha256, draft_id, meta, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id';

/** `save_video`: lưu video nháp (`res` = makeVideo ok=true, khác → RangeError). Danh tính asset =
 * (file_sha256, sku, channel, format): đã có → skipped. Chưa có → `saveDraft` (content_type 'video',
 * pending, text = draft_text có tên file sha) rồi INSERT `video_assets`. Unique lúc INSERT → skipped
 * + `orphan_draft_id` (nháp mồ côi để NGƯỜI reject). */
export async function saveVideo(
  db: Db,
  res: unknown,
  o: { by: string; source?: string },
): Promise<ims.SaveResult> {
  const r = res as Partial<VideoResult> | null;
  if (
    !(
      r &&
      typeof r === 'object' &&
      r.ok === true &&
      isPlainObject(r.meta) &&
      r.sha256 &&
      isPlainObject(r.script)
    )
  ) {
    throw new RangeError('save_video: chỉ lưu kết quả make_video ok=True');
  }
  const who = pyStrip(o.by ?? '');
  if (!who) throw new RangeError('save_video: thiếu by (người/agent tạo)');
  for (const k of ['channel', 'sku', 'format', 'packshot_sha256'] as const) {
    if (!(typeof r[k] === 'string' && r[k])) throw new RangeError(`save_video: thiếu ${k}`);
  }
  const [ch, sku, fmt] = [r.channel as string, r.sku as string, r.format as string];
  const m = r.meta as VideoMeta;
  const sha = r.sha256 as string;
  const sc = r.script as ScriptResult;
  const { rows } = await db.query<{ draft_id: string }>(
    'select draft_id from video_assets where file_sha256 = $1 and sku = $2 and channel = $3 and format = $4',
    [sha, sku, ch, fmt],
  );
  if (rows.length) return { status: 'skipped', draft_id: String(rows[0]?.draft_id) };
  const did = await saveDraft(db, {
    brief: `video ${sku} ${ch} ${fmt}`,
    channel: ch,
    text: r.draft_text ?? '',
    guardrail: r.guardrail,
    source: o.source ?? SOURCE_CLI,
    createdBy: who,
    contentType: CONTENT_TYPE,
    sku,
    isAi: true,
    promptVersion: sc.prompt_version,
    promptSha256: sc.prompt_sha256,
  });
  try {
    const a = await db.query<{ id: string }>(ASSET_SQL, [
      sha,
      m.file,
      sku,
      ch,
      fmt,
      m.duration_ms,
      m.labels.join('\n'),
      sc.model,
      sc.prompt_sha256,
      sc.prompt_version,
      m.tts.provider,
      r.packshot_sha256,
      did,
      JSON.stringify(m),
      who,
    ]);
    return { status: 'created', draft_id: String(did), asset_id: String(a.rows[0]?.id) };
  } catch (e) {
    if ((e as { code?: string })?.code === '23505')
      return { status: 'skipped', orphan_draft_id: did };
    throw e;
  }
}
