import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import golden from './__fixtures__/zalo.golden.json' with { type: 'json' };
import { clock } from './zalo.constants.js';
import { ConvLog, convSettings, provenance, purgeConvlog, unanswered } from './zalo.convlog.js';
import { SeenDb } from './zalo.dedup.js';
import { senderConfig, ZaloSender } from './zalo.sender.js';
import { wiringError, ZaloService } from './zalo.service.js';
import { rig } from './zalo.test-helpers.js';
import { uhash, uiHash, verifySignature } from './zalo.util.js';

// Dịch tests/test_zalo.py (phần thuần + file) — golden từ hàm Python thật (__fixtures__).

const realMono = clock.mono;
const realWall = clock.wall;
afterEach(() => {
  clock.mono = realMono;
  clock.wall = realWall;
  convSettings.convSample = false;
});

describe('golden Python', () => {
  it('uhash = sha256(user_id)[:16]', () => {
    for (const [u, h] of golden.uhash) expect(uhash(u as string), u as string).toBe(h);
  });

  // Chặt hơn Python có chủ đích (fail-closed: từ chối chữ ký) — JSON.parse không có NaN, số lớn
  // > 2^53 mất chính xác, float `1e3` thành 1000 (Python str = "1000.0").
  const TS_STRICTER = new Set(['nan_ts', 'bigint_ts', 'ts_float_int_valued']);
  it('verify_signature', () => {
    for (const c of golden.verify) {
      const got = verifySignature(Buffer.from(c.raw_hex, 'hex'), c.header, c.secret);
      expect(got, c.name).toBe(TS_STRICTER.has(c.name) ? false : c.ok);
    }
  });

  it('_startup_error: ma trận DEPLOY × secret × token × store', () => {
    const dir = rig().dir;
    const store = join(dir, 'tok.json');
    for (const s of golden.startup) {
      if (s.store === null) writeFileSync(store, '{}');
      else if (s.store === 'corrupt') writeFileSync(store, '{nope');
      else writeFileSync(store, JSON.stringify(s.store));
      const env: Record<string, string> = {
        ZALO_OA_SECRET: s.oa,
        ZALO_ACCESS_TOKEN: s.access,
        ZALO_REFRESH_TOKEN: s.rtok,
        ZALO_APP_ID: s.app_id,
        ZALO_APP_SECRET: s.app_secret,
      };
      if (s.deploy !== null) env.DEPLOY = s.deploy;
      const svc = new ZaloService(null, undefined, undefined, undefined, {
        env,
        tokenStore: store,
      });
      expect(svc.startupError(), JSON.stringify(s)).toBe(s.err);
    }
  });

  // TS chặt hơn (Python không có trạng thái này — channels/rag luôn import được): DEPLOY bật mà
  // lớp kênh/RAG chưa nối = lỗi tích hợp → mọi khách chỉ nhận hotline → từ chối serve.
  it('configProblem = startupError ?? chưa nối lớp kênh/RAG (chỉ khi DEPLOY bật)', () => {
    const env = { ZALO_OA_SECRET: 's', ZALO_ACCESS_TOKEN: 't' };
    const mk = (e: Record<string, string>, wired: boolean) => {
      const r = rig();
      return new ZaloService(null, wired ? r.ch : undefined, wired ? r.rag : undefined, undefined, {
        env: e,
        tokenStore: join(r.dir, 'tok.json'),
      });
    };
    expect(mk(env, false).configProblem()).toBeNull(); // dev: vẫn serve, khách nhận hotline
    expect(mk({ ...env, DEPLOY: '1' }, false).configProblem()).toContain(
      '[fatal] zalo: DEPLOY bật nhưng chưa nối lớp kênh/RAG',
    );
    expect(mk({ ...env, DEPLOY: '1' }, true).configProblem()).toBeNull();
    expect(mk({ DEPLOY: '1' }, true).configProblem()).toContain('thiếu ZALO_OA_SECRET');
    const r = rig();
    expect(wiringError({ DEPLOY: '1' }, { channels: r.ch }), 'thiếu RAG vẫn là chưa nối').toContain(
      'chưa nối',
    );
  });

  // TS_STRICTER (review cuối): Python chỉ đòi ZALO_OA_SECRET khi DEPLOY bật — chế độ thực DEPLOY tắt
  // (compose mặc định) thì verify bỏ qua, nhận event không ký. TS từ chối serve.
  it('chế độ thực thiếu ZALO_OA_SECRET → từ chối serve dù DEPLOY tắt; dev / có secret → null', () => {
    const mk = (env: Record<string, string>) =>
      new ZaloService(null, undefined, undefined, undefined, {
        env,
        tokenStore: join(rig().dir, 'tok.json'),
      });
    for (const env of [
      { APPROVAL_ENFORCE: '1' } as Record<string, string>,
      { AUTH_MODE: 'local' },
      { AUTH_MODE: 'proxy' },
      { NODE_ENV: 'production', DEPLOY: '0' },
    ]) {
      expect(mk(env).startupError(), JSON.stringify(env)).toBe(
        '[fatal] zalo: chế độ thực nhưng thiếu ZALO_OA_SECRET — webhook không verify signature được, từ chối serve',
      );
    }
    expect(mk({ NODE_ENV: 'test' }).startupError()).toBeNull();
    expect(mk({ APPROVAL_ENFORCE: '1', ZALO_OA_SECRET: 's' }).startupError()).toBeNull();
    expect(mk({ DEPLOY: '1' }).startupError()).toContain('DEPLOY bật nhưng thiếu ZALO_OA_SECRET');
  });

  it('_current_expires_at + _token_expiring_soon', () => {
    const dir = rig().dir;
    const store = join(dir, 'tok.json');
    const sender = new ZaloSender(senderConfig({}, store));
    clock.wall = () => golden.expires_now;
    for (const e of golden.expires) {
      writeFileSync(store, JSON.stringify(e.v === null ? {} : { expires_at: e.v }));
      const exp = sender.currentExpiresAt();
      const want =
        e.exp === 'inf' ? Number.POSITIVE_INFINITY : e.exp === 'nan' ? Number.NaN : e.exp;
      expect(exp, JSON.stringify(e.v)).toBe(want);
      expect(sender.tokenExpiringSoon(), JSON.stringify(e.v)).toBe(e.soon);
    }
  });

  it('_purge_convlog: giữ đúng byte dòng chứng minh được tuổi', () => {
    const p = join(rig().dir, 'c.jsonl');
    writeFileSync(p, Buffer.from(golden.purge.in_hex, 'hex'));
    purgeConvlog(p, golden.purge.now);
    expect(readFileSync(p).toString('hex')).toBe(golden.purge.out_hex);
    writeFileSync(p, Buffer.alloc(0));
    purgeConvlog(p, golden.purge.now);
    expect(readFileSync(p).toString('hex')).toBe(golden.purge_empty_hex);
    writeFileSync(p, Buffer.from(`\n\n${JSON.stringify({ question: 'x' })}\n`));
    purgeConvlog(p, golden.purge.now);
    expect(readFileSync(p).toString('hex')).toBe(golden.purge_all_drop_hex);
  });

  it('unanswered(): .1 trước, chỉ answered === false, dòng hỏng bỏ qua', () => {
    const p = join(rig().dir, 'c.jsonl');
    writeFileSync(`${p}.1`, Buffer.from(golden.unanswered.bak_hex, 'hex'));
    writeFileSync(p, Buffer.from(golden.unanswered.main_hex, 'hex'));
    expect(unanswered(p)).toEqual(golden.unanswered.out);
  });
});

describe('dedup (sqlite, sống qua restart)', () => {
  it('D3.5: restart vẫn nhớ; dữ liệu nằm trong file', () => {
    const path = join(rig().dir, 'seen.db');
    const a = new SeenDb(path);
    expect(a.dedup('x')).toBe(false);
    a.close(); // giả lập restart
    const b = new SeenDb(path);
    expect(b.dedup('x')).toBe(true);
    b.close();
  });

  it('V7.3/V8.2: key follow: sống 7 ngày, key msg 1 giờ; namespace không trộn', () => {
    const s = new SeenDb(join(rig().dir, 'seen.db'));
    expect(s.dedup('follow:u1')).toBe(false);
    expect(s.dedup('follow:u1')).toBe(true);
    s.age('follow:u1', 3700);
    expect(s.dedup('follow:u1')).toBe(true); // >1h <7d
    s.age('follow:u1', 8 * 86400);
    expect(s.dedup('follow:u1')).toBe(false); // quá 7d → re-engagement
    for (const k of ['u1:m1', 'u1:follow', 'u1:x:follow']) {
      expect(s.dedup(k)).toBe(false);
      s.age(k, 3700);
      expect(s.dedup(k), k).toBe(false); // TTL 1h, không hưởng nhầm 7d
    }
    s.close();
  });
});

describe('conversation log', () => {
  it('purge fail → vẫn ghi, retry throttle PURGE_RETRY_S; thành công → khóa daily', async () => {
    const { dir } = rig();
    const log = new ConvLog(join(dir, 'c.jsonl'), () => null);
    const calls: string[] = [];
    log.purge = (p) => {
      calls.push(p);
      throw new Error('locked');
    };
    await log.log({ ts: 't1', question: 'a' });
    expect(log.lastPurge).toBe(Number.NEGATIVE_INFINITY);
    expect(log.lastPurgeAttempt).toBeGreaterThan(Number.NEGATIVE_INFINITY);
    await log.log({ ts: 't2', question: 'b' });
    expect(calls.length).toBe(1);
    log.lastPurgeAttempt = clock.mono() - 3601;
    await log.log({ ts: 't3', question: 'c' });
    expect(calls.length).toBe(2);
    const ok: string[] = [];
    log.purge = (p) => {
      ok.push(p);
    };
    log.lastPurgeAttempt = clock.mono() - 3601;
    await log.log({ ts: 't4', question: 'd' });
    expect(ok.length).toBe(1);
    expect(log.lastPurge).toBeGreaterThan(Number.NEGATIVE_INFINITY);
    await log.log({ ts: 't5', question: 'e' });
    expect(ok.length).toBe(1);
    const qs = readFileSync(log.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).question);
    expect(qs).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('rotate khi vượt cap; purge .1 lỗi vẫn append', async () => {
    const { dir } = rig();
    const log = new ConvLog(join(dir, 'c.jsonl'), () => null);
    log.maxBytes = 10;
    log.lastPurge = clock.mono();
    log.purge = () => {
      throw new Error('locked');
    };
    await log.log({ ts: 't1', question: 'a' });
    await log.log({ ts: 't2', question: 'b' });
    expect(readFileSync(`${log.path}.1`, 'utf8')).toContain('"a"');
    expect(readFileSync(log.path, 'utf8').split('\n').filter(Boolean).length).toBe(1);
  });

  it('daily purge xóa dòng quá hạn của file đang ghi', async () => {
    const { dir } = rig();
    const p = join(dir, 'c.jsonl');
    const old = `${new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 19)}Z`;
    writeFileSync(p, `${JSON.stringify({ ts: old, question: 'cũ' })}\n`);
    await new ConvLog(p, () => null).log({ ts: 'x', question: 'mới' });
    expect(
      readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).question),
    ).toEqual(['mới']);
  });

  it('D5.11: chạy chung API cũng purge convlog lúc boot (onModuleInit); lỗi chỉ warn', () => {
    const r = rig();
    const p = join(r.dir, 'conversations.jsonl');
    const old = `${new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 19)}Z`;
    const fresh = `${new Date().toISOString().slice(0, 19)}Z`;
    writeFileSync(p, `${JSON.stringify({ ts: old, q: 'cũ' })}\n${JSON.stringify({ ts: fresh })}\n`);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    r.svc.onModuleInit();
    expect(readFileSync(p, 'utf8')).toBe(`${JSON.stringify({ ts: fresh })}\n`);
    expect(Math.abs(r.svc.convlog.lastPurge - clock.mono())).toBeLessThan(5);
    const r2 = rig();
    r2.svc.convlog.purge = () => {
      throw new Error('EBUSY');
    };
    r2.svc.onModuleInit();
    expect(out.mock.calls.flat().join('\n')).toContain('[warn] zalo: purge convlog lúc boot lỗi');
    expect(r2.svc.convlog.lastPurge).toBe(Number.NEGATIVE_INFINITY); // lần ghi sau thử lại
  });

  it('V7.2: mốc purge là monotonic; mốc "tương lai" vẫn chặn daily gate', async () => {
    const log = new ConvLog(join(rig().dir, 'c.jsonl'), () => null);
    await log.log({ ts: 't', question: 'q' });
    expect(Math.abs(log.lastPurge - clock.mono())).toBeLessThan(5);
    log.lastPurge = clock.mono() + 99999;
    const calls: string[] = [];
    log.purge = (p) => {
      calls.push(p);
    };
    await log.log({ ts: 't2', question: 'q2' });
    expect(calls).toEqual([]);
  });

  it('v15 P8.1: thiếu provenance / ép mẫu → "sample", không bao giờ tự thành live', async () => {
    const { dir } = rig();
    const log = new ConvLog(join(dir, 'c.jsonl'), () => null);
    await log.log({ msg_id: 'a' });
    await log.log({ msg_id: 'b', provenance: 'live' });
    await log.log({ msg_id: 'c', provenance: 'LIVE' });
    convSettings.convSample = true;
    await log.log({ msg_id: 'd', provenance: 'live' });
    const rows = readFileSync(log.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.provenance, r.is_sample ?? null])).toEqual([
      ['sample', true],
      ['live', null],
      ['sample', true],
      ['sample', true],
    ]);
    expect(provenance(() => true)).toEqual({ provenance: 'sample', is_sample: true });
  });

  it('bằng chứng DB chỉ cho dòng live đủ điều kiện; DB down/từ chối chỉ warn', async () => {
    const q: unknown[][] = [];
    let fail = false;
    const pool = {
      query: async (...a: unknown[]) => {
        q.push(a);
        if (fail) throw Object.assign(new Error('deny'), { code: '42501' });
        return { rows: [] };
      },
    };
    const { dir } = rig();
    const log = new ConvLog(join(dir, 'c.jsonl'), () => pool as never);
    const base = {
      ts: '2026-10-16T03:00:00Z',
      user_hash: 'u'.repeat(16),
      question: 'Hỏi giá sâm',
      answer: 'Giá 1.000.000đ',
      channel: 'messenger',
      answered: true,
      sent: true,
      guardrail_ok: true,
    };
    await log.log({ ...base, msg_id: 'm_live-1', provenance: 'live' });
    await log.log({ ...base, msg_id: 'm_mau-1' }); // thiếu provenance → mẫu
    await log.log({ ...base, msg_id: 'm_fail-1', sent: false, provenance: 'live' });
    expect(q.length).toBe(1);
    const rec = JSON.parse((q[0] as [string, string[]])[1][0] as string);
    expect(rec).toEqual({
      channel: 'messenger',
      msg_id: 'm_live-1',
      ts: base.ts,
      answered: true,
      sent: true,
      guardrail_ok: true,
      provenance: 'live',
    });
    fail = true;
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    await log.log({ ...base, msg_id: 'm_live-2', provenance: 'live' });
    expect(warn.mock.calls.flat().join('\n')).toContain('bị từ chối (InsufficientPrivilege)');
    warn.mockRestore();
    expect(readFileSync(log.path, 'utf8').split('\n').filter(Boolean).length).toBe(4);
  });
});

describe('ui hash', () => {
  it('D6.10: 2 session khác hash; cùng session ổn định', () => {
    const s1: Record<string, unknown> = {};
    const s2: Record<string, unknown> = {};
    const h1 = uiHash(s1);
    expect(h1).not.toBe(uiHash(s2));
    expect(uiHash(s1)).toBe(h1);
    expect(h1).toHaveLength(16);
    expect(h1).not.toBe(uhash('streamlit'));
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
