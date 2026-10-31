import type { AiGateway } from '@samsam/core/ai/gateway';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cpSlice } from '@samsam/core/ops/py';
import { readinessFromDb } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, cliEntry, sayBlocked } from '@samsam/core/rollout/rollout';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { DbLease } from '../channels/channels.command.js';
import { contentCfg } from '../content/content.js';
import { type Io, STD_IO } from '../content/mkt-calendar.js';
import * as ims from './image-studio.js';
import * as vs from './video-studio.js';

// Lệnh CLI thay `python -m pipelines.image_studio` và `python -m pipelines.video_studio` — cùng cờ,
// exit code, thông điệp chính. `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ
// nối. Exit 0 không có `failed`; 1 có `failed`; 2 tham số sai / provider (IMAGE_PROVIDER, TTS) chưa
// cắm / thiếu ffmpeg / DB không kết nối / tính năng TẮT — kiểm TRƯỚC mọi lời gọi provider/LLM.
// Khác Python CÓ CHỦ ĐÍCH (chặt hơn = fail-closed): ảnh kiểm cổng triển khai marketing-02.1 ngay sau
// khi kết nối DB (Python chỉ chặn ở `save_draft` — sau khi đã gọi provider nền, tốn phí AI).

const NO_DB = 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

type Common = {
  sku?: string[];
  channel?: string[];
  format?: string[];
  by?: string;
};
export type ImageOpts = Common & { headline?: string; scene?: string };
export type VideoOpts = Common & { brief?: string };

export type CliDeps = {
  io?: Io;
  env?: Env;
  /** Python `store._conn_or_none()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng/gateway trên kết nối của lệnh (mặc định `wireCore`) → gateway. */
  wire?: (db: Db) => Pick<AiGateway, 'chat'>;
  /** Test thay (Python monkeypatch `store.readiness_from_db`). */
  readiness?: (db: Db) => Promise<Map<string, string> | null>;
  /** Test thay (Python monkeypatch `compose`/`save_image`, `make_video`/`save_video`). */
  compose?: typeof ims.compose;
  saveImage?: typeof ims.saveImage;
  makeVideo?: typeof vs.makeVideo;
  saveVideo?: typeof vs.saveVideo;
  findFfmpeg?: (env: Env) => string | null;
};

const choices = (xs: readonly string[]) => xs.map((x) => pyRepr(x)).join(', ');

/** Kiểm tham số chung kiểu argparse → thông điệp lỗi | null. */
function usageCheck(
  o: Common,
  head: { name: string; value: string | undefined },
  chans: readonly string[] | null,
  fmts: readonly string[] | null,
): string | null {
  for (const ch of o.channel ?? []) {
    if (chans && !chans.includes(ch)) {
      return `argument --channel: invalid choice: ${pyRepr(ch)} (choose from ${choices(chans)})`;
    }
  }
  for (const f of o.format ?? []) {
    if (fmts && !fmts.includes(f)) {
      return `argument --format: invalid choice: ${pyRepr(f)} (choose from ${choices(fmts)})`;
    }
  }
  if (head.value === undefined) return `the following arguments are required: --${head.name}`;
  return null;
}

/** `--sku all` = mọi SKU golden (giữ thứ tự, bỏ trùng ở vòng lặp). */
function expandSkus(skus: string[], io: Io): string[] | null {
  if (!skus.includes('all')) return skus;
  const [g, err] = contentCfg();
  if (g === null) {
    io.err(`[error] ${err}`);
    return null;
  }
  return [...skus.filter((s) => s !== 'all'), ...g.golden.keys()];
}

const counts = (items: ims.Item[]) => {
  const n = (k: string) => items.filter((it) => it.status === k).length;
  return {
    created: n('created'),
    skipped: n('skipped'),
    refused: n('refused'),
    failed: n('failed'),
  };
};

/** Lỗi ghi file của compose/make (Python OSError) → dòng `failed`. */
function fileFail(e: unknown): ims.Item | null {
  return ims.isFsError(e)
    ? { status: 'failed', reason: `lỗi ghi file (${ims.fsErrName(e)})` }
    : null;
}

/** `python -m pipelines.image_studio` — ẢNH NHÁP MKT-03 vào hàng duyệt (pending), agent KHÔNG đăng. */
export async function imageStudioMain(o: ImageOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const PROG = 'python -m pipelines.image_studio';
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  const [cfg, err] = ims.loadConfig();
  const bad = usageCheck(
    o,
    { name: 'headline', value: o.headline },
    cfg ? cfg.channels : null,
    cfg ? [...cfg.formats.keys()] : null,
  );
  if (bad) return usage(bad);
  if (cfg === null) {
    io.err(`[error] ${err}`);
    return 2;
  }
  if (!o.sku?.length || !o.channel?.length) return usage('cần ít nhất 1 --sku và 1 --channel');
  const by = o.by ?? ims.DEFAULT_BY;
  if (!pyStrip(by)) return usage('--by không được rỗng');
  const name = ims.providerName(null, env);
  if (!Object.hasOwn(ims.PROVIDERS, name)) {
    io.err(
      `[error] IMAGE_PROVIDER=${pyRepr(cpSlice(name, 0, 40))} chưa cắm — API sinh ảnh là external-dep; hỗ trợ: ${Object.keys(ims.PROVIDERS).sort().join(', ')}`,
    );
    return 2;
  }
  if (name === 'none' && pyStrip(o.scene ?? '')) {
    // v13.4: yêu cầu nền AI (--scene) mà chưa có provider → KHÔNG âm thầm bỏ scene ra nền gradient.
    io.err(
      '[blocked] --scene cần nền AI nhưng IMAGE_PROVIDER chưa cấu hình (none = nền gradient tất định) — BLOCKED: API sinh ảnh (vendor + hợp đồng/DPA + key + trần chi phí agent `image` trong data/llm_gateway.json), cắm vào pipelines.image_studio.PROVIDERS; bỏ --scene để ra nháp nền gradient',
    );
    return 2;
  }
  const skus = expandSkus(o.sku, io);
  if (skus === null) return 2;
  const fmts = o.format?.length ? o.format : ['1:1'];
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err(`[error] ${NO_DB} — không ghi được nháp`); // ghi-tác-vụ: DB chết → exit 2, 0 provider
    return 2;
  }
  const items: ims.Item[] = [];
  try {
    const ai = (d.wire ?? wireCore)(lease.db);
    const why = await blocked(lease.db, 'ảnh nháp', ims.FEATURE);
    if (why) return sayBlocked(why, io.out);
    const readiness = await (d.readiness ?? readinessFromDb)(lease.db);
    const compose = d.compose ?? ims.compose;
    const save = d.saveImage ?? ims.saveImage;
    for (const sku of new Set(skus)) {
      for (const ch of new Set(o.channel)) {
        for (const fmt of new Set(fmts)) {
          let it: ims.Item;
          try {
            const res = await compose(
              sku,
              ch,
              o.headline,
              { fmt, scene: o.scene ?? null, readiness },
              { ai, env },
            );
            if (!res.ok) {
              it = { status: 'refused', ...(res.refused as { code: string; reason: string }) };
            } else {
              const file = (res.path as string).split(/[\\/]/).pop() as string;
              try {
                it = { ...(await save(lease.db, res, { by: pyStrip(by) })), file } as ims.Item;
              } catch (e) {
                if (!isDbError(e)) throw e;
                it = { status: 'failed', reason: `lỗi DB: ${dbMsg(e)}` };
              }
            }
          } catch (e) {
            const f = fileFail(e);
            if (!f) throw e;
            it = f;
          }
          items.push(it);
          io.out(ims.line(`${sku} × ${ch} × ${fmt}: `, it));
        }
      }
    }
  } finally {
    await lease.release().catch(() => {});
  }
  const n = counts(items);
  io.out(
    `[done] ${items.length} ảnh — created ${n.created}, skipped ${n.skipped}, refused ${n.refused}, failed ${n.failed} (nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải ảnh lên kênh tay; agent không đăng)`,
  );
  return n.failed ? 1 : 0;
}

/** `python -m pipelines.video_studio` — VIDEO NHÁP MKT-04 vào hàng duyệt (pending), agent KHÔNG đăng. */
export async function videoStudioMain(o: VideoOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const PROG = 'python -m pipelines.video_studio';
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  const [cfg, err] = vs.loadConfig();
  const bad = usageCheck(
    o,
    { name: 'brief', value: o.brief },
    cfg ? cfg.channels : null,
    cfg ? cfg.formats : null,
  );
  if (bad) return usage(bad);
  if (cfg === null) {
    io.err(`[error] ${err}`);
    return 2;
  }
  if (!o.sku?.length || !o.channel?.length) return usage('cần ít nhất 1 --sku và 1 --channel');
  const by = o.by ?? vs.DEFAULT_BY;
  if (!pyStrip(by)) return usage('--by không được rỗng');
  // Kiểm TRƯỚC mọi lời gọi LLM: không render được thì không đốt LLM.
  const tts = vs.ttsName(env);
  if (!Object.hasOwn(vs.TTS_PROVIDERS, tts)) {
    io.err(
      `[error] TTS_PROVIDER=${pyRepr(cpSlice(tts, 0, 40))} chưa cắm — TTS có phí là external-dep; hỗ trợ: ${Object.keys(vs.TTS_PROVIDERS).sort().join(', ')}`,
    );
    return 2;
  }
  const prov = ims.providerName(null, env);
  if (!Object.hasOwn(ims.PROVIDERS, prov)) {
    io.err(
      `[error] IMAGE_PROVIDER=${pyRepr(cpSlice(prov, 0, 40))} chưa cắm — external-dep; hỗ trợ: ${Object.keys(ims.PROVIDERS).sort().join(', ')}`,
    );
    return 2;
  }
  if ((d.findFfmpeg ?? vs.findFfmpeg)(env) === null) {
    io.err(
      '[error] không tìm thấy ffmpeg (FFMPEG_BIN / PATH) — external-dep, không dựng được video',
    );
    return 2;
  }
  const skus = expandSkus(o.sku, io);
  if (skus === null) return 2;
  const fmts = o.format?.length ? o.format : ['9:16'];
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err(`[error] ${NO_DB} — không ghi được nháp`); // ghi-tác-vụ: DB chết → exit 2, 0 LLM
    return 2;
  }
  const items: ims.Item[] = [];
  try {
    const ai = (d.wire ?? wireCore)(lease.db);
    // r12 D1: tính năng TẮT → chặn TRƯỚC mọi lời gọi AI/dựng file.
    const why = await blocked(lease.db, 'video nháp', vs.FEATURE);
    if (why) return sayBlocked(why, io.out);
    const readiness = await (d.readiness ?? readinessFromDb)(lease.db);
    const make = d.makeVideo ?? vs.makeVideo;
    const save = d.saveVideo ?? vs.saveVideo;
    for (const sku of new Set(skus)) {
      for (const ch of new Set(o.channel)) {
        for (const fmt of new Set(fmts)) {
          let it: ims.Item;
          try {
            const res = await make(sku, ch, o.brief, { fmt, readiness }, { ai, env });
            if (res.error) it = { status: 'failed', reason: res.error };
            else if (!res.ok)
              it = { status: 'refused', ...(res.refused as { code: string; reason: string }) };
            else {
              const file = (res.path as string).split(/[\\/]/).pop() as string;
              try {
                it = { ...(await save(lease.db, res, { by: pyStrip(by) })), file } as ims.Item;
              } catch (e) {
                if (!isDbError(e)) throw e;
                it = { status: 'failed', reason: `lỗi DB: ${dbMsg(e)}` };
              }
            }
          } catch (e) {
            const f = fileFail(e);
            if (!f) throw e;
            it = f;
          }
          items.push(it);
          io.out(ims.line(`${sku} × ${ch} × ${fmt}: `, it));
        }
      }
    }
  } finally {
    await lease.release().catch(() => {});
  }
  const n = counts(items);
  io.out(
    `[done] ${items.length} video — created ${n.created}, skipped ${n.skipped}, refused ${n.refused}, failed ${n.failed} (nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải video lên kênh tay; agent không đăng)`,
  );
  return n.failed ? 1 : 0;
}

const collect = (v: string, prev: string[] | undefined) => [...(prev ?? []), v];

@Command({
  name: 'image-studio',
  description:
    "Sinh ẢNH NHÁP MKT-03 (packshot thật ghép lên nền, nhãn 'Nội dung có sử dụng AI') vào hàng duyệt (pending) — agent KHÔNG đăng",
})
export class ImageStudioCommand extends CommandRunner {
  async run(_args: string[], opts: ImageOpts): Promise<void> {
    process.exitCode = await cliEntry(imageStudioMain)(opts);
  }
  @Option({ flags: '--sku <sku>', description: "sku_key golden, lặp được; 'all' = mọi SKU golden" })
  parseSku(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--channel <ch>', description: 'kênh, lặp được' })
  parseChannel(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--format <f>', description: 'format ảnh, lặp được (mặc định 1:1)' })
  parseFormat(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--headline <text>', description: 'chữ chính trên ảnh' })
  parseHeadline(v: string): string {
    return v;
  }
  @Option({
    flags: '--scene <text>',
    description: 'mô tả bối cảnh nền (chỉ dùng khi có provider AI)',
  })
  parseScene(v: string): string {
    return v;
  }
  @Option({
    flags: '--by <name>',
    description: `người/agent tạo nháp (mặc định ${ims.DEFAULT_BY})`,
  })
  parseBy(v: string): string {
    return v;
  }
}

@Command({
  name: 'video-studio',
  description:
    "Dựng VIDEO NHÁP MKT-04 (khung packshot thật + phụ đề kịch bản AI, nhãn 'Nội dung có sử dụng AI' mọi khung) vào hàng duyệt (pending) — agent KHÔNG đăng",
})
export class VideoStudioCommand extends CommandRunner {
  async run(_args: string[], opts: VideoOpts): Promise<void> {
    process.exitCode = await cliEntry(videoStudioMain)(opts);
  }
  @Option({ flags: '--sku <sku>', description: "sku_key golden, lặp được; 'all' = mọi SKU golden" })
  parseSku(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--channel <ch>', description: 'kênh, lặp được' })
  parseChannel(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--format <f>', description: 'format video, lặp được (mặc định 9:16)' })
  parseFormat(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--brief <text>', description: 'brief video' })
  parseBrief(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>', description: `người/agent tạo nháp (mặc định ${vs.DEFAULT_BY})` })
  parseBy(v: string): string {
    return v;
  }
}
