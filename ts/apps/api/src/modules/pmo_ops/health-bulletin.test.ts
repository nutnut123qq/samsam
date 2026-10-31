import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEND_SQL, WARN_RATIO } from '@samsam/core/ai/gateway';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/counters';
import { maskPii } from '@samsam/core/security/pii';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as hb from './health-bulletin.js';

// Dịch tests/test_health_bulletin.py + phần bản tin của test_v13_c07_ops.py: ngưỡng chi phí, drift-guard
// mốc tháng với gateway, job trễ (gồm job lịch on-prem), render 6 mục, thiếu bảng chỉ hỏng mục đó, DB
// chết vẫn ra bản tin exit 0, `--date` sai exit 2 không ghi file, KHÔNG mở mạng khi thiếu `--notify`/cấu
// hình, Telegram 1 lời gọi không in token, email qua SMTP STARTTLS của core, gửi lỗi vẫn exit 0.
// KHÁC Python có chủ đích: data_platform-07.1 TẮT → `[rollout]` exit 2 TRƯỚC đọc DB/in/ghi.

const CAPS = { default: 5.0, chatbot: 20.0, smoke: 0.0 };
const label = (rows: hb.CostRow[], a: string) => rows.find((r) => r[0] === a)?.[4];

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'health-'));
  installFakeDeps({ maskPii });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetOpsDeps();
  settings.forceMode = null;
});

describe('health_bulletin — thuần', () => {
  it.each([
    [0.79, 'OK'],
    [0.8, 'CẢNH BÁO'],
    [0.99, 'CẢNH BÁO'],
    [1.0, 'ĐÃ CHẶN (gateway)'],
    [1.5, 'ĐÃ CHẶN (gateway)'],
  ])('ngưỡng chi phí %s → %s', (ratio, want) => {
    expect(label(hb.costRows({ chatbot: ratio * 20 }, CAPS), 'chatbot')).toBe(want);
  });

  it('trần mặc định + cap 0 (không chia 0) + agent có trần chưa dùng vẫn hiện, không gồm default', () => {
    const rows = hb.costRows({ newagent: 4.0, smoke: 0.3 }, CAPS);
    const a = rows.find((r) => r[0] === 'newagent');
    expect(a?.[2]).toBe(5.0);
    expect(a?.[4]).toBe('CẢNH BÁO');
    expect(Math.round(a?.[3] as number)).toBe(80);
    const s = rows.find((r) => r[0] === 'smoke');
    expect(s?.[3]).toBeNull();
    expect(s?.[4]).toMatch(/^ĐÃ CHẶN/);
    expect(label(rows, 'chatbot')).toBe('OK');
    expect(rows.every((r) => r[0] !== 'default')).toBe(true);
  });

  it('drift-guard: cùng mốc tháng giờ VN + cùng WARN_RATIO với gateway', () => {
    expect(SPEND_SQL).toContain(hb.MONTH_START_SQL);
    expect(hb.WARN_RATIO).toBe(WARN_RATIO);
  });

  it('job trễ + job lịch on-prem được canh', () => {
    const late = Object.fromEntries(
      hb
        .lateJobs({ 'ingest.lead_store': 30.0, 'agents.report': 100.0 })
        .map(([j, h, l]) => [j, [h, l]]),
    );
    expect(late).toEqual({ 'ingest.lead_store': [30.0, 24] });
    expect(new Set(hb.lateJobs({}).map(([j]) => j))).toEqual(
      new Set(Object.keys(hb.EXPECTED_JOBS)),
    );
    const exp = hb.expectedJobs();
    expect(exp['job:red_alert_sweep']).toBe(2);
    expect(exp['job:backup']).toBe(26);
    const l = new Set(hb.lateJobs({ 'job:backup': 1.0 }, exp).map(([j]) => j));
    expect(l.has('job:backup')).toBe(false);
    expect(l.has('job:ops_monthly')).toBe(true);
  });

  it('render: thứ tự mục, che PII/secret, không vỡ bảng, giờ VN', () => {
    const ts = new Date('2026-10-10T01:00:00Z');
    const md = hb.render(
      {
        db_ok: true,
        jobs: {
          counts: [
            ['agents.report', 1, 0],
            ['ingest.lead_store', 0, 1],
          ],
          failed: [
            [
              'ingest.lead_store',
              ts,
              'OperationalError: gọi 0905123456 | x\ny postgresql://u:pw9@h/x',
            ],
          ],
          last_ok_hours: { 'agents.report': 2.0 },
          expected: hb.EXPECTED_JOBS,
        },
        spend: { chatbot: 16.0, content: 1.0 },
        llm_errors: [['chatbot', 3]],
        pending: 7,
      },
      '2026-10-11',
      { caps: CAPS, retention: [] },
    );
    const pos = [hb.H_DB, hb.H_JOBS, hb.H_COST, hb.H_ERR, hb.H_QUEUE, hb.H_RETENTION].map((h) =>
      md.indexOf(h),
    );
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(md).toContain('KHÔNG CHẠY/TRỄ `ingest.lead_store` — chưa có lần OK nào');
    expect(md).not.toContain('0905123456');
    expect(md).not.toContain('pw9');
    expect(md).toContain('x y <secret>');
    expect(md).toContain('08:00');
    expect(md).toContain('| chatbot | 16.0000 | 20.00 | 80% | CẢNH BÁO |');
    for (const t of ['job_runs', 'llm_usage', 'content_drafts']) expect(md).toContain(`\`${t}\``);
  });

  it('collect: thiếu bảng chỉ hỏng mục đó (mỗi câu tự giao dịch)', async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes('from job_runs')) {
          // lỗi Postgres thật (pg.DatabaseError) — UndefinedTable
          throw Object.assign(
            new pg.DatabaseError('relation "job_runs" does not exist', 0, 'error'),
            {
              code: '42P01',
            },
          );
        }
        if (sql.includes('sum(cost_usd)')) {
          expect(sql).toContain(hb.MONTH_START_SQL);
          return { rows: [{ agent_id: 'chatbot', c: '1.5' }] };
        }
        if (sql.includes('from llm_usage')) return { rows: [{ agent_id: 'content', n: '2' }] };
        if (sql.includes('from content_drafts')) return { rows: [{ n: '4' }] };
        throw new Error(sql);
      },
    };
    const d = await hb.collect(db as never, hb.EXPECTED_JOBS);
    expect(d).toEqual({
      db_ok: true,
      jobs: hb.MISSING,
      spend: { chatbot: 1.5 },
      llm_errors: [['content', 2]],
      pending: 4,
    });
  });

  it('gather: thiếu DATABASE_URL / host chết → db_ok false, chỉ tên lỗi (không lộ DSN)', async () => {
    expect(await hb.gather({})).toEqual({ db_ok: false, db_error: 'thiếu DATABASE_URL' });
    const d = await hb.gather({
      DATABASE_URL: 'postgresql://u:pw9@127.0.0.1:9/x_dead',
      NODE_ENV: 'test',
    });
    expect(d.db_ok).toBe(false);
    expect(d.db_error).toBe('OperationalError');
  });
});

describe('health_bulletin — main + gửi', () => {
  type Call = [string, string, Record<string, unknown>];
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
  };
  const down = async () => ({ db_ok: false, db_error: 'OperationalError' }) as hb.Data;
  const base = (calls: Call[], env: Record<string, string> = {}) => ({
    env,
    gather: down,
    caps: () => CAPS,
    retention: () => ['- r'],
    now: () => new Date('2026-10-11T01:00:00Z'),
    fetch: (async (url: string, init: { body: string }) => {
      calls.push(['fetch', url, { body: init.body }]);
      return { ok: true, status: 200 };
    }) as hb.FetchLike,
    smtp: (e: Record<string, string | undefined>) => {
      calls.push(['smtp', '', { ...e }]);
      return async (to: string, subject: string, body: string) => {
        calls.push(['send', to, { subject, body }]);
      };
    },
  });

  it('DB chết → vẫn ghi bản tin đủ 6 mục, exit 0, không mạng', async () => {
    const calls: Call[] = [];
    const s = io();
    expect(
      await hb.healthMain({ outDir: tmp, date: '2026-10-11' }, { ...base(calls), io: s.io }),
    ).toBe(0);
    const md = readFileSync(join(tmp, 'health-2026-10-11.md'), 'utf8');
    expect(md).toContain('DB không truy cập được');
    expect(md).toContain('OperationalError');
    for (const h of [hb.H_DB, hb.H_JOBS, hb.H_COST, hb.H_ERR, hb.H_QUEUE, hb.H_RETENTION]) {
      expect(md).toContain(h);
    }
    expect(s.out.join('\n')).toContain('DB không truy cập được');
    expect(calls).toEqual([]);
  });

  it('--date sai → exit 2, không ghi file, không đọc DB', async () => {
    const s = io();
    let read = false;
    const rc = await hb.healthMain(
      { outDir: tmp, date: '../../x' },
      {
        io: s.io,
        gather: async () => {
          read = true;
          return down();
        },
      },
    );
    expect(rc).toBe(2);
    expect(read).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('không --notify → KHÔNG mạng dù đã cấu hình kênh', async () => {
    const calls: Call[] = [];
    const s = io();
    const env = {
      HEALTH_NOTIFY: 'telegram',
      TELEGRAM_BOT_TOKEN: '123:SECRETTOKEN',
      TELEGRAM_CHAT_ID: '42',
    };
    expect(await hb.healthMain({ outDir: tmp }, { ...base(calls, env), io: s.io })).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out.at(-1)).toBe('[notify] bỏ qua (chưa cấu hình — cần --notify)');
  });

  it('--notify chưa cấu hình kênh → bỏ qua, không mạng', async () => {
    const calls: Call[] = [];
    const s = io();
    expect(await hb.healthMain({ outDir: tmp, notify: true }, { ...base(calls), io: s.io })).toBe(
      0,
    );
    expect(calls).toEqual([]);
    expect(s.out.at(-1)).toBe('[notify] bỏ qua (chưa cấu hình)');
  });

  it('Telegram: đúng 1 lời gọi, gửi bản ĐÃ ghi (≤ 4000 ký tự), không in token/URL bot', async () => {
    const calls: Call[] = [];
    const s = io();
    const env = {
      HEALTH_NOTIFY: 'telegram',
      TELEGRAM_BOT_TOKEN: '123:SECRETTOKEN',
      TELEGRAM_CHAT_ID: '42',
    };
    expect(
      await hb.healthMain(
        { outDir: tmp, date: '2026-10-11', notify: true },
        { ...base(calls, env), io: s.io },
      ),
    ).toBe(0);
    expect(calls.length).toBe(1);
    const [kind, url, init] = calls[0] as Call;
    expect(kind).toBe('fetch');
    expect(url).toContain('SECRETTOKEN');
    const sent = new URLSearchParams(init.body as string).get('text');
    const md = readFileSync(join(tmp, 'health-2026-10-11.md'), 'utf8');
    expect(sent).toBe(md.slice(0, hb.TELEGRAM_MAX));
    const out = s.out.join('\n');
    expect(out).not.toContain('SECRETTOKEN');
    expect(out).not.toContain('api.telegram.org');
    expect(s.out.at(-1)).toBe('[notify] đã gửi qua telegram');
  });

  it('email: SMTP của core (STARTTLS bắt buộc), From = SMTP_USER, gửi đúng bản tin', async () => {
    const calls: Call[] = [];
    const env = {
      HEALTH_NOTIFY: 'email',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'bot@example.test',
      SMTP_PASSWORD: 'pw-secret',
      HEALTH_MAIL_TO: 'ops@example.test',
    };
    const logs: string[] = [];
    expect(await hb.notify('bản tin', { ...base(calls, env), log: (x) => logs.push(x) })).toBe(
      'sent',
    );
    expect(calls.map((c) => c[0])).toEqual(['smtp', 'send']);
    expect(calls[0]?.[2]).toMatchObject({
      RED_ALERT_NOTIFY: 'email',
      SMTP_FROM: 'bot@example.test',
    });
    expect(calls[1]).toEqual([
      'send',
      'ops@example.test',
      { subject: '[Sâm Sâm AI] Bản tin sức khỏe hệ thống', body: 'bản tin' },
    ]);
    expect(logs.join('\n')).not.toContain('pw-secret');
  });

  it('gửi lỗi → [notify] gửi lỗi (tên lỗi), exit 0, không lộ token', async () => {
    const s = io();
    const env = {
      HEALTH_NOTIFY: 'telegram',
      TELEGRAM_BOT_TOKEN: '123:SECRETTOKEN',
      TELEGRAM_CHAT_ID: '42',
    };
    const rc = await hb.healthMain(
      { outDir: tmp, notify: true },
      {
        ...base([], env),
        io: s.io,
        fetch: async () => {
          throw Object.assign(new Error('network down api.telegram.org/bot123:SECRETTOKEN'), {
            name: 'TypeError',
          });
        },
      },
    );
    expect(rc).toBe(0);
    const out = s.out.join('\n');
    expect(out).toContain('[notify] gửi lỗi (TypeError)');
    expect(out).not.toContain('SECRETTOKEN');
  });

  it('chạy thử: file mang nhãn CHẠY THỬ, gửi ĐÚNG bản có nhãn; sổ đầu ra sample=false', async () => {
    const fake = installFakeDeps(
      { maskPii },
      { quick: 'chay_thu', reportFeature: () => 'data_platform-07.1' },
    );
    const calls: Call[] = [];
    const env = { HEALTH_NOTIFY: 'telegram', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
    const s = io();
    expect(
      await hb.healthMain(
        { outDir: tmp, date: '2026-10-19', notify: true },
        { ...base(calls, env), io: s.io },
      ),
    ).toBe(0);
    const md = readFileSync(join(tmp, 'health-2026-10-19.md'), 'utf8');
    expect(md.startsWith('> **CHẠY THỬ — KHÔNG GỬI.**')).toBe(true);
    expect(new URLSearchParams(calls[0]?.[2].body as string).get('text')).toBe(md);
    expect(fake.recorded.map((r) => [r.name, r.sample])).toEqual([['health-2026-10-19.md', false]]);
  });

  it('data_platform-07.1 TẮT → [rollout] exit 2 TRƯỚC đọc DB/in/ghi/gửi (TS chặt hơn Python)', async () => {
    settings.forceMode = 'tat';
    const calls: Call[] = [];
    const s = io();
    let read = false;
    const rc = await hb.healthMain(
      { outDir: tmp, date: '2026-10-11', notify: true },
      {
        ...base(calls, {
          HEALTH_NOTIFY: 'telegram',
          TELEGRAM_BOT_TOKEN: 't',
          TELEGRAM_CHAT_ID: '1',
        }),
        io: s.io,
        gather: async () => {
          read = true;
          return down();
        },
      },
    );
    expect(rc).toBe(2);
    expect(s.out).toEqual([
      expect.stringMatching(
        /^\[rollout\] báo cáo health-2026-10-11\.md: tính năng data_platform-07\.1 đang tắt.* — không gửi$/,
      ),
    ]);
    expect(read).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(tmp, 'health-2026-10-11.md'))).toBe(false);
  });
});
