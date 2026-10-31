import type http from 'node:http';
import { Inject, Optional } from '@nestjs/common';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { isPrintable, pyInt } from '@samsam/core/ops/py';
import { isDbError } from '@samsam/core/ops/tx';
import { loadVaultKey, VaultKeyError } from '@samsam/core/security/fernet';
import { cpHead, cpLen, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import {
  DEFAULT_PORT,
  dbCombos,
  enabled,
  MAX_FORM_BYTES,
  makeServer,
  options,
  PATH,
  readGolden,
  renderPage,
  type ServerOpts,
} from './b2b-form.service.js';
import {
  type AnswerFn,
  evalReal,
  type Io,
  MAX_BY_LEN,
  MAX_STDIN,
  markSent,
  SAN_CHANNELS,
  suggest,
} from './channels.service.js';

/** Token answer() của module RAG (Python `api.rag.answer`) — bước tích hợp cung cấp; thiếu → gợi ý
 * sàn dùng câu chuyển nhân viên, `--eval-real` exit 1 (external-dep). */
export const RAG_ANSWER = Symbol('RAG_ANSWER');

export type DbLease = { db: Db; release: () => Promise<void> };

const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

async function readStdin(max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    n += (c as Buffer).length;
    if (n >= max * 4) break; // UTF-8 ≤ 4 byte/ký tự: đủ `max` ký tự
  }
  return cpHead(new TextDecoder('utf-8').decode(Buffer.concat(chunks)), max);
}

export type ChannelsOpts = {
  suggest?: string;
  markSent?: string;
  by?: string;
  evalReal?: boolean;
  limit?: string;
};
export type ChannelsDeps = {
  answer: AnswerFn | null;
  connect?: () => Promise<DbLease | null>;
  stdin?: () => Promise<string>;
  respondFn?: Parameters<typeof suggest>[4]['respondFn'];
  env?: Env;
  io?: Io;
};

/** `python -m connectors.channels` — gợi ý chat sàn (MXH DÁN TAY, không gọi API sàn) / đánh dấu đã
 * gửi / eval A1 thật nhỏ. Exit: 0 ok · 1 eval FAIL/thiếu answer(), --mark-sent bị từ chối · 2 tham số
 * sai/stdin rỗng/tính năng tắt/DB down (--mark-sent). */
export async function channelsMain(o: ChannelsOpts, d: ChannelsDeps): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`channels: error: ${msg}`);
    return 2;
  };
  if (o.suggest !== undefined && !SAN_CHANNELS.includes(o.suggest)) {
    return usage(
      `argument --suggest: invalid choice: '${o.suggest}' (choose from 'shopee', 'tiktok')`,
    );
  }
  const sid = o.markSent === undefined ? undefined : pyInt(o.markSent);
  if (sid === null) return usage(`argument --mark-sent: invalid int value: '${o.markSent}'`);
  const limit = o.limit === undefined ? 8n : pyInt(o.limit);
  if (limit === null) return usage(`argument --limit: invalid int value: '${o.limit}'`);
  const nOps =
    Number(o.suggest !== undefined) + Number(Boolean(o.evalReal)) + Number(sid !== undefined);
  if (nOps !== 1)
    return usage('cần đúng 1 thao tác: --suggest KÊNH | --mark-sent ID | --eval-real');
  const connect = d.connect ?? (() => connectDatabaseUrl(d.env));
  const withDb = async (fn: (db: Db | null) => Promise<number>) => {
    const lease = await connect();
    try {
      return await fn(lease?.db ?? null);
    } finally {
      await lease?.release();
    }
  };
  if (o.evalReal) {
    if (limit < 1n || limit > 50n) return usage('--limit phải 1..50');
    return withDb((db) =>
      evalReal(db, Number(limit), { answer: d.answer, respondFn: d.respondFn, env: d.env, io }),
    );
  }
  const by = pyStrip(o.by ?? '');
  if (!by || cpLen(by) > MAX_BY_LEN || !isPrintable(by)) {
    return usage(`--suggest/--mark-sent cần --by <tên MXH> (1..${MAX_BY_LEN} ký tự in được)`);
  }
  if (sid !== undefined) {
    if (sid < 1n) return usage('--mark-sent cần ID dương');
    return withDb((db) => markSent(db, sid, by, io));
  }
  const text = await (d.stdin ?? (() => readStdin(MAX_STDIN)))();
  if (!pyStrip(text)) return usage('STDIN rỗng — dán tin buyer qua STDIN (không qua argv)');
  return withDb((db) =>
    suggest(db, o.suggest as string, text, by, {
      answer: d.answer,
      respondFn: d.respondFn,
      env: d.env,
      io,
    }),
  );
}

// Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0, `choices` bị parse đè.
@Command({
  name: 'channels',
  description:
    'Lớp kênh CSKH — gợi ý trả lời chat sàn (MXH DÁN TAY, không gọi API sàn) / eval A1 thật nhỏ',
})
export class ChannelsCommand extends CommandRunner {
  constructor(@Optional() @Inject(RAG_ANSWER) private readonly answer: AnswerFn | null = null) {
    super();
  }

  async run(_args: string[], opts: ChannelsOpts): Promise<void> {
    process.exitCode = await channelsMain(opts, { answer: this.answer ?? null });
  }

  @Option({
    flags: '--suggest <channel>',
    description: 'đọc tin buyer từ STDIN, in câu gợi ý (shopee|tiktok)',
  })
  parseSuggest(v: string): string {
    return v;
  }

  @Option({ flags: '--mark-sent <id>', description: 'NGƯỜI MXH xác nhận đã dán gửi gợi ý #ID' })
  parseMarkSent(v: string): string {
    return v;
  }

  @Option({
    flags: '--by <name>',
    description: 'tên người MXH (bắt buộc với --suggest/--mark-sent)',
  })
  parseBy(v: string): string {
    return v;
  }

  @Option({ flags: '--eval-real', description: 'chạy ca kd_a1 với answer() THẬT' })
  parseEvalReal(): boolean {
    return true;
  }

  @Option({ flags: '--limit <n>', description: 'số ca --eval-real (1..50, mặc định 8)' })
  parseLimit(v: string): string {
    return v;
  }
}

// ---------------------------------------------------------------- form B2B

export type B2bDeps = {
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  makeServer?: (o: ServerOpts) => http.Server;
  io?: Io;
  /** Dừng server (test); mặc định SIGINT/SIGTERM. */
  stop?: Promise<void>;
};

/** `python -m connectors.b2b_form` — mặc định TẮT; mọi lỗi cấu hình → exit 2 TRƯỚC khi bind. */
export async function b2bFormMain(d: B2bDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  if (!enabled(env)) {
    io.err(
      '[fatal] form B2B mặc định TẮT — đặt B2B_FORM_ENABLED=1 trong env tiến trình (chỉ sau khi DPIA luồng form được ký)',
    );
    return 2;
  }
  let keys: ReturnType<typeof loadVaultKey>;
  try {
    keys = loadVaultKey(env);
  } catch (e) {
    if (!(e instanceof VaultKeyError)) throw e;
    io.err(`[fatal] ${e.message}`);
    return 2;
  }
  const host = pyStrip(env.B2B_FORM_HOST || '127.0.0.1');
  const rawPort = pyStrip(env.B2B_FORM_PORT || String(DEFAULT_PORT));
  if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    io.err('[fatal] B2B_FORM_PORT phải 1..65535');
    return 2;
  }
  const [golden, why] = readGolden();
  if (golden === null) {
    io.err(`[fatal] ${why}`);
    return 2;
  }
  // Python dùng `lead_store.connect()` (DATABASE_URL): ghi contacts/consents qua function `*_human`
  // — login svc_webhook KHÔNG có quyền bảng PII (docs/roles.sql) nên không dùng servicePool('webhook').
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[fatal] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  let combos: Record<string, unknown>[];
  try {
    combos = await dbCombos(lease.db);
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err('[fatal] không đọc được bom_combos');
    await lease.release().catch(() => {});
    return 2;
  }
  const opts = options(golden, combos);
  const srv = (d.makeServer ?? makeServer)({
    page: renderPage(opts),
    allowed: opts.map(([k]) => k),
    keys,
    connect: async () => ({ db: lease.db, release: async () => {} }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(Number(rawPort), host, () => resolve());
    });
    io.out(
      `[b2b_form] nghe ${host}:${rawPort}${PATH} · ${opts.length} sản phẩm · tối đa ${MAX_FORM_BYTES} byte · rate-limit 5/IP/giờ, 60/giờ`,
    );
    await (d.stop ??
      new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await lease.release().catch(() => {});
  }
  return 0;
}

@Command({
  name: 'b2b-form',
  description: 'Form B2B yêu cầu báo giá quà Tết — mặc định TẮT (B2B_FORM_ENABLED=1)',
})
export class B2bFormCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await b2bFormMain();
  }
}
