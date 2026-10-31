import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import {
  check,
  checkPublish,
  type ReadinessMap,
  readinessKey,
} from '@samsam/core/security/guardrail';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as ims from '../image_video/image-studio.js';
import * as raster from '../image_video/raster.js';
import * as vs from '../image_video/video-studio.js';
import { loadConfig as videoConfig } from '../image_video/video-studio.js';
import { pyDumps } from '../kd_price/deps.js';
import G from './__fixtures__/mkt_youtube.golden.json' with { type: 'json' };
import { mktYoutubeMain } from './mkt-koc-ugc-seo.command.js';
import * as my from './mkt-youtube.js';

// Dịch phần THUẦN + CLI không DB của tests/test_mkt_youtube.py (LLM = nhà cung cấp GIẢ đếm lời gọi —
// 0 mạng). Kết quả so khớp golden sinh từ `write_package` Python thật với cùng LLM giả. Shorts
// (`render_shorts`): từ chối broll_thieu/ffmpeg_thieu, dựng khung B-roll có nhãn TRƯỚC mã hóa
// (ffmpeg giả qua `vhooks`); mp4 thật + log DB ở *.db.test.ts (cần ffmpeg).

const RULES = JSON.parse(readFileSync(repoPath('data/guardrail_rules.json'), 'utf8'));
const AI = RULES.labels.ai[0];
const AD = RULES.labels.ad[0];
const rdOf = (p: unknown): ReadinessMap | null =>
  p === null
    ? null
    : new Map((p as [string, string, string][]).map(([a, b, v]) => [readinessKey(a, b), v]));

type Call = { agent: string; sha: string; n: number; last: string; kw: Record<string, unknown> };
function fakeAi(queue: unknown[]) {
  const calls: Call[] = [];
  return {
    calls,
    ai: {
      chat: async (agent: string, messages: ChatMessage[], o: Record<string, unknown>) => {
        calls.push({
          agent,
          sha: my.msgsSha(messages),
          n: messages.length,
          last: messages[messages.length - 1]?.content as string,
          kw: { feature: o.feature, max_tokens: o.maxTokens, temperature: o.temperature },
        });
        const q = queue[Math.min(calls.length, queue.length) - 1];
        // = `json.dumps(q, ensure_ascii=False)` của LLM giả bên Python (separators mặc định)
        const text = typeof q === 'string' ? q : pyDumps(q);
        return { text, model: 'fake/llm', provider: 'ollama' as const, tokensIn: 0, tokensOut: 0 };
      },
    },
  };
}

afterEach(() => {
  settings.forceMode = null;
});

describe('mkt_youtube — thuần (golden Python)', () => {
  it('ts_chapter/ts_srt + cấu hình video_studio + từ cấm kịch bản', () => {
    for (const [s, ch, srt] of G.ts)
      expect([my.tsChapter(s as number), my.tsSrt(s as number)]).toEqual([ch, srt]);
    const [cfg, err] = videoConfig();
    expect(err).toBe(G.verr);
    expect(cfg?.script_banned).toEqual(G.script_banned);
  });

  it('kênh youtube = alias web; chế độ hiển thị HẰNG private; không đường đăng', () => {
    const g = checkPublish(`Quà quê. ${AI} ${AD}`, {
      channel: 'youtube',
      contentType: 'video',
      isAi: true,
    });
    expect(g.ok).toBe(true);
    expect((g.violations as { code: string }[]).filter((v) => v.code === 'config')).toEqual([]);
    expect(RULES.channels).not.toContain('youtube');
    const src = readFileSync(new URL('./mkt-youtube.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/googleapis|upload|privacyStatus.*public/);
    expect(my.PRIVACY).toBe('private');
  });

  it.each(G.cases.map((c) => [c.name, c]))('write_package %s', async (_n, c) => {
    const f = fakeAi(c.queue);
    const pkg = await my.writePackage(c.brief, { ai: f.ai, readiness: rdOf(c.readiness) });
    const g = pkg.guardrail as { ok?: unknown; violations?: { code: string }[] } | null;
    const got = {
      ...pkg,
      guardrail: {
        ok: g?.ok ?? null,
        codes: [...new Set((g?.violations ?? []).map((v) => v.code))].sort(),
      },
    };
    expect(got).toEqual(c.out);
    expect(f.calls).toEqual(c.calls);
  });

  it('gói đạt: chương 00:00 tăng dần, SRT 1 cue/phần, nhãn AI + QC trong mô tả, bỏ câu số/giá + từ cấm', async () => {
    const good = G.cases.find((c) => c.name === 'good') as (typeof G.cases)[number];
    const pkg = await my.writePackage(good.brief, { ai: fakeAi(good.queue).ai });
    expect(pkg.ok).toBe(true);
    expect(new Set(pkg.dropped.map((d) => d.ly_do))).toEqual(
      new Set(['so_lieu', 'tu_cam_kich_ban']),
    );
    expect(pkg.text).not.toContain('199');
    expect(pkg.text).not.toContain('Bác sĩ');
    expect(pkg.chapters[0]?.startsWith('00:00 ')).toBe(true);
    expect(pkg.description).toContain(AI);
    expect(pkg.description).toContain(AD);
    expect(pkg.meta.privacyStatus).toBe('private');
    expect(check(pkg.text).ok).toBe(true);
  });

  it('LLM lỗi / gateway chặn → error, không sinh gì', async () => {
    const ai = {
      chat: async () => {
        throw Object.assign(new Error('tính năng TẮT'), { name: 'GatewayBlocked' });
      },
    };
    const pkg = await my.writePackage('Câu chuyện vùng trồng', { ai });
    expect(pkg.ok).toBe(false);
    expect(pkg.error).toBe('llm: GatewayBlocked: tính năng TẮT');
    expect(pkg.llm_calls).toBe(1);
  });
});

describe('mkt_youtube — CLI không DB', () => {
  const BRIEF = 'Câu chuyện vùng trồng sâm và mùa quà Tết';
  const good = (G.cases.find((c) => c.name === 'good') as (typeof G.cases)[number]).queue;
  function cap() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  }
  const noDb = (calls: number[]) => async () => {
    calls.push(1);
    return null;
  };

  it('--dry-run: không connect, in gói; --render + --dry-run → exit 2; brief rượu → [refuse] ruou exit 1', async () => {
    const calls: number[] = [];
    const connect = async () => {
      calls.push(1);
      return null;
    };
    const c = cap();
    const f = fakeAi(good);
    expect(
      await mktYoutubeMain({ brief: BRIEF, dryRun: true }, { io: c.io, connect, ai: f.ai }),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(c.out.join('\n')).toContain('private');
    expect(c.out.at(-1)).toBe('[dry-run] KHÔNG lưu nháp, không dựng Shorts');
    const c2 = cap();
    expect(
      await mktYoutubeMain({ brief: BRIEF, dryRun: true, render: true }, { io: c2.io, connect }),
    ).toBe(2);
    const c3 = cap();
    expect(
      await mktYoutubeMain(
        { brief: 'Rượu sâm', dryRun: true },
        { io: c3.io, connect, ai: fakeAi(good).ai },
      ),
    ).toBe(1);
    expect(c3.out.join('\n')).toContain('[refuse] ruou');
    expect(calls).toEqual([]);
  });

  it('--render mà DB down → exit 2 TRƯỚC lời gọi AI (không dựng gì)', async () => {
    const calls: number[] = [];
    const c = cap();
    const f = fakeAi(good);
    const rc = await mktYoutubeMain(
      { brief: BRIEF, render: true },
      { io: c.io, ai: f.ai, connect: noDb(calls) },
    );
    expect(rc).toBe(2);
    expect(calls).toEqual([1]);
    expect(f.calls).toEqual([]);
  });

  it('marketing-07.2 TẮT → [rollout] exit 2 TRƯỚC lời gọi AI (kể cả --dry-run)', async () => {
    settings.forceMode = 'tat';
    for (const dryRun of [true, false]) {
      const c = cap();
      const f = fakeAi(good);
      const calls: number[] = [];
      const rc = await mktYoutubeMain(
        { brief: BRIEF, dryRun },
        { io: c.io, ai: f.ai, connect: noDb(calls) },
      );
      expect(rc).toBe(2);
      expect(c.out).toHaveLength(1);
      expect(c.out[0]).toMatch(/^\[rollout\] .*marketing-07\.2/);
      expect(f.calls).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it('không --dry-run mà DB down → exit 2, không gọi AI', async () => {
    const c = cap();
    const f = fakeAi(good);
    expect(
      await mktYoutubeMain({ brief: BRIEF }, { io: c.io, ai: f.ai, connect: async () => null }),
    ).toBe(2);
    expect(f.calls).toEqual([]);
  });
});

let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}
const RENDER =
  HAS_SHARP &&
  ims.fontsFor(`${AI} ${AD} MẪU B-roll Sương sớm vùng trồng Đóng gói quà quê`, {}) !== null;

describe('mkt_youtube — render_shorts (không ffmpeg thật)', () => {
  const BRIEF = 'Câu chuyện vùng trồng sâm và mùa quà Tết';
  const good = (G.cases.find((c) => c.name === 'good') as (typeof G.cases)[number]).queue;
  const TMP = mkdtempSync(join(tmpdir(), 'mkt-yt-'));
  let k = 0;
  const fresh = () => join(TMP, `d${++k}`);
  const ls = (d: string): string[] => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  const REAL = { ...vs.vhooks };
  const realDraw = ims.hooks.drawText;
  afterEach(() => {
    Object.assign(vs.vhooks, REAL);
    ims.hooks.drawText = realDraw;
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  const pkgOf = async () => {
    const pkg = await my.writePackage(BRIEF, { ai: fakeAi(good).ai });
    expect(pkg.ok).toBe(true);
    expect(pkg.shorts).toEqual([{ title: 'Sương sớm và hộp quà', segments: [0, 2] }]);
    return pkg;
  };

  it('gói không đạt / không Short → []', async () => {
    const pkg = await pkgOf();
    expect(await my.renderShorts({ ...pkg, ok: false })).toEqual([]);
    expect(await my.renderShorts({ ...pkg, shorts: [] })).toEqual([]);
  });

  it('test_render_refusals_no_broll_no_ffmpeg: thiếu B-roll → broll_thieu; thiếu ffmpeg → ffmpeg_thieu, 0 mp4', async () => {
    const pkg = await pkgOf();
    const out = fresh();
    let r = await my.renderShorts(pkg, { brollDir: fresh(), outDir: out });
    expect(r.map((x) => x.refused)).toEqual(['broll_thieu']);
    expect(ls(out)).toEqual([]);
    if (!HAS_SHARP) return; // B-roll mẫu cần sharp
    const br = fresh();
    mkdirSync(br);
    await vs.makeSampleBroll(join(br, 'a.png'));
    vs.vhooks.findFfmpeg = () => null;
    r = await my.renderShorts(pkg, { brollDir: br, outDir: out });
    expect(r.map((x) => x.refused)).toEqual(['ffmpeg_thieu']);
    expect(ls(out).filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });

  it.skipIf(!RENDER)(
    'dựng khung: 2 phần → 2 PNG có nhãn, encode(8 s/cảnh, tổng 16 s, fps 30); lỗi ffmpeg → error, 0 file',
    async () => {
      const pkg = await pkgOf();
      const br = fresh();
      mkdirSync(br);
      await vs.makeSampleBroll(join(br, 'a.png'));
      const seen: unknown[] = [];
      vs.vhooks.findFfmpeg = () => 'ffmpeg-gia';
      vs.vhooks.encode = async (ff, seq, _out, sceneS, totalS, fps) => {
        seen.push([ff, ls(seq), sceneS, totalS, fps]);
        throw new vs.RuntimeErr('dừng trước mã hóa (test)');
      };
      const out = fresh();
      expect(await my.renderShorts(pkg, { brollDir: br, outDir: out })).toEqual([
        { ok: false, error: 'dừng trước mã hóa (test)', title: 'Sương sớm và hộp quà' },
      ]);
      expect(seen).toEqual([['ffmpeg-gia', ['000.png', '001.png'], 8, 16, 30]]);
      expect(ls(out)).toEqual([]); // thư mục tạm đã dọn
    },
  );

  it.skipIf(!RENDER)('bỏ CHỮ nhãn AI trên khung → nhan_ai TRƯỚC mã hóa, 0 file', async () => {
    const pkg = await pkgOf();
    const br = fresh();
    mkdirSync(br);
    await vs.makeSampleBroll(join(br, 'a.png'));
    ims.hooks.drawText = (o, mask, x, y, rgba, text) => {
      if (text.includes(AI)) return;
      realDraw(o, mask, x, y, rgba, text);
    };
    vs.vhooks.findFfmpeg = () => 'ffmpeg-gia';
    vs.vhooks.encode = async () => {
      throw new Error('không được mã hóa');
    };
    const out = fresh();
    const r = await my.renderShorts(pkg, { brollDir: br, outDir: out });
    expect(r.map((x) => x.refused)).toEqual(['nhan_ai']);
    expect(ls(out)).toEqual([]);
  });
});
