import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { CommandFactory, CommandRunnerService } from 'nest-commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalQueueCommand,
  JobRunsCommand,
  LoaderGateCommand,
  ReportCommand,
  RolloutCommand,
  StoreCommand,
} from './cli/core.commands.js';
import { CliModule, cliExitOverride } from './cli.module.js';
import { loadWorkerJobs } from './jobs.js';
import { ChannelsCommand } from './modules/channels/channels.command.js';
import { MarketApiCommand } from './modules/market/market.command.js';
import { MessengerWebhookCommand } from './modules/messenger_fanpage/messenger.command.js';
import { ZaloWebhookCommand } from './modules/zalo/zalo.command.js';
import { webhookDeps } from './wiring.js';

// Lệnh CLI của 34 nhóm + core (red-alert, rollout, approval-queue, director, store, acceptance,
// loader-gate, job-runs, report) + mẫu db-ping — tên = thay `python -m …` tương ứng.
const COMMANDS = [
  'report',
  'job-runs',
  'loader-gate',
  'acceptance',
  'store',
  'director',
  'approval-queue',
  'rollout',
  'acc-ar',
  'acc-invoice',
  'anchor',
  'b2b-form',
  'bks-audit',
  'bks-recon',
  'break-glass',
  'ceo-audit',
  'ceo-decisions',
  'ceo-promo',
  'ceo-report',
  'ceo-risk',
  'channels',
  'cockpit',
  'combo-price',
  'content',
  'contract-check',
  'core-store',
  'crawler-collect',
  'crawler-intel',
  'crm',
  'da-b2b',
  'da-pmo',
  'db-backup',
  'db-ping',
  'dealer-price',
  'doc-intake',
  'dr-drill',
  'embed-store',
  'fin-director',
  'fp-ads',
  'fp-cash',
  'fp-opscost',
  'fp-pnl',
  'garden',
  'garden-director',
  'garden-media',
  'garden-media-mkt',
  'golden-store',
  'hdtv-report',
  'health-bulletin',
  'image-studio',
  'intel-alert',
  'intel-bulletin',
  'intel-import',
  'intel-weekly',
  'inventory-csv',
  'kb-gaps',
  'kb-internal',
  'kd-affiliate',
  'kd-care',
  'kd-catalog',
  'kd-forecast',
  'kd-listing',
  'kd-live',
  'kd-orders',
  'kd-price',
  'kd-quote',
  'lead-store',
  'legal-updates',
  'listing-export',
  'market-api',
  'market-csv',
  'messenger-webhook',
  'mkt-ads',
  'mkt-calendar',
  'mkt-director',
  'mkt-koc',
  'mkt-ugc',
  'mkt-youtube',
  'onprem-preflight',
  'ops-incidents',
  'ops-monthly',
  'pc-hr',
  'persona-sim',
  'product-dossiers',
  'production',
  'qr-trace',
  'ra-kenh',
  'red-alert',
  'retention-purge',
  'rev-share',
  'review-load',
  'sales-director',
  'scenario',
  'seo-san',
  'seo-web',
  'settlement-csv',
  'social-vendor',
  'sx-label',
  'sx-tracuu',
  'video-studio',
  'vt-thoitiet',
  'vt-thuhoach',
  'webhook-probe',
  'xnqc',
  'zalo-garden',
  'zalo-preflight',
  'zalo-webhook',
];

const CORE = [
  'rollout',
  'approval-queue',
  'director',
  'store',
  'acceptance',
  'loader-gate',
  'job-runs',
  'report',
];

let app: INestApplicationContext;
let root: Command;
beforeAll(async () => {
  app = await CommandFactory.createWithoutRunning(CliModule, { logger: false });
  root = (app.get(CommandRunnerService) as unknown as { commander: Command }).commander;
});
afterAll(async () => {
  await app?.close();
});

describe('CliModule', () => {
  it('đăng ký đủ lệnh, không trùng tên', () => {
    const names = root.commands.map((c) => c.name());
    expect(names.length).toBe(new Set(names).size);
    expect([...names].sort()).toEqual([...COMMANDS].sort());
  });

  it('nối chéo nhóm: RAG → channels, webhook deps → zalo/messenger, quyết toán → market-api', () => {
    const get = <T>(cls: new (...a: never[]) => T) => app.get(cls, { strict: false }) as T;
    const deps = (o: object, k: string) => (o as Record<string, unknown>)[k];
    expect(typeof deps(get(ChannelsCommand), 'answer')).toBe('function');
    expect(deps(get(ZaloWebhookCommand), 'makeDeps')).toBe(webhookDeps);
    expect(deps(get(MessengerWebhookCommand), 'makeDeps')).toBe(webhookDeps);
    expect(deps(get(MarketApiCommand), 'settlement')).toMatchObject({
      precheck: expect.any(Function),
      run: expect.any(Function),
    });
  });

  it('webhookDeps (pool null = dev): đủ lớp kênh/RAG/vườn, RAG giữ hằng 30 giây của Python', () => {
    const d = webhookDeps(null, {} as never);
    expect(d.rag?.CHAT_BUDGET_S).toBe(30);
    expect(d.rag?.SEND_RESERVE_S).toBe(5);
    expect(typeof d.channels?.consentGate).toBe('function');
    expect(typeof d.garden?.handle).toBe('function');
  });

  it('lệnh con: cờ lạ / thiếu cờ bắt buộc đi qua errorHandler (exit 2), không exit 1 mặc định', async () => {
    const codes: string[] = [];
    cliExitOverride(root, (e) => {
      codes.push((e as { code?: string }).code ?? '');
      throw e; // dừng commander (handler thật gọi process.exit)
    });
    const silent = { writeErr: () => {}, writeOut: () => {} };
    for (const c of root.commands) c.configureOutput(silent);
    for (const argv of [['bks-audit', '--report', '--bogus'], ['db-ping']]) {
      await expect(root.parseAsync(argv, { from: 'user' })).rejects.toThrow();
    }
    expect(codes).toEqual(['commander.unknownOption', 'commander.missingMandatoryOptionValue']);
    // Lệnh core mới: cờ lạ → exit 2; cờ có giá trị mà thiếu giá trị → exit 2 (argparse).
    codes.length = 0;
    for (const c of CORE) {
      await expect(root.parseAsync([c, '--bogus'], { from: 'user' }), c).rejects.toThrow();
    }
    await expect(root.parseAsync(['rollout', '--promote'], { from: 'user' })).rejects.toThrow();
    expect(codes).toEqual([
      ...CORE.map(() => 'commander.unknownOption'),
      'commander.optionMissingArgument',
    ]);
  });
});

describe('lệnh core: kiểm tham số trước khi chạm DB (exit như argparse)', () => {
  const rc = async (fn: () => Promise<void>) => {
    process.exitCode = undefined;
    await fn();
    const c = process.exitCode;
    process.exitCode = undefined;
    return c;
  };
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(String(s)));
    vi.spyOn(console, 'error').mockImplementation((s: string) => void logs.push(String(s)));
  });
  afterEach(() => vi.restoreAllMocks());

  it('sai/thiếu thao tác → 2', async () => {
    expect(await rc(() => new RolloutCommand().run([], {}))).toBe(2);
    expect(await rc(() => new ApprovalQueueCommand().run([], {}))).toBe(2);
    expect(await rc(() => new LoaderGateCommand().run([], {}))).toBe(2);
    expect(await rc(() => new JobRunsCommand().run([], {}))).toBe(2);
    expect(await rc(() => new JobRunsCommand().run([], { run: 'a', list: true }))).toBe(2);
    expect(await rc(() => new StoreCommand().run([], { approve: 'x' }))).toBe(2);
    expect(await rc(() => new StoreCommand().run([], { schedule: ['1'] }))).toBe(2);
    expect(await rc(() => new ReportCommand().run([], { days: '0' }))).toBe(2);
    expect(await rc(() => new ReportCommand().run([], { until: '2026-13-01' }))).toBe(2);
    expect(logs.some((l) => l.includes('--until sai định dạng YYYY-MM-DD'))).toBe(true);
  });

  it('job-runs --list = lịch worker; --run tên lạ → [err] lịch job, exit 2', async () => {
    expect(await rc(() => new JobRunsCommand().run([], { list: true }))).toBe(0);
    expect(logs.length).toBe(Object.keys(loadWorkerJobs()).length);
    expect(logs.some((l) => l.startsWith('red_alert_escalate: '))).toBe(true);
    logs.length = 0;
    expect(await rc(() => new JobRunsCommand().run([], { run: 'khong_co' }))).toBe(2);
    expect(logs).toEqual(["[err] lịch job: không có job 'khong_co' trong lịch"]);
  });

  it('rollout --catalog chạy không cần DB', async () => {
    expect(await rc(() => new RolloutCommand().run([], { catalog: true }))).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
  });
});
