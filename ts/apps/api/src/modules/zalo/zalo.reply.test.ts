import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  ERROR_FALLBACK,
  FALLBACK,
  HANDOFF_TEXT,
  HOLD_TEXT,
  NO_HANDOFF_TEXT,
  NO_HANDOFF_TEXTS,
  NON_TEXT_TEXT,
  OAUTH_URL,
  SEND_TIMEOUT_S,
  SEND_URL,
  WELCOME_TEXT,
} from './zalo.constants.js';
import { DeadlineExceeded, type GardenIntake } from './zalo.deps.js';
import type { FetchFn } from './zalo.sender.js';
import { ZaloService } from './zalo.service.js';
import { RAG_NO_DATA, resp, rig } from './zalo.test-helpers.js';
import { uhash } from './zalo.util.js';

// Dịch tests/test_zalo.py (pipeline trả lời + định tuyến event) + test_rollout_enforce.py (biên
// chatbot), test_v13_c07_ops.py / test_v14_p6_ops.py (30 giây), test_r12_dot2.py /
// test_r12fix_d2_l3.py (r12 L3 — chỉ hứa khi đã ghi handoff), test_v15_fix_p81.py (provenance),
// test_v13_c01 / test_llm_gateway (gateway chặn → chuyển người).

const PROMISE = ['nhân viên sẽ', 'sẽ phản hồi', 'liên hệ lại'];
const promised = (t: string) => PROMISE.some((p) => t.toLowerCase().includes(p));
const okAnswer = (q: string) => ({ answer: `trả lời: ${q}`, sources: [] as string[] });
const priced = () => ({ answer: 'Saphraton: 1.000.000 đ', sources: ['http://x'] });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const realMono = clock.mono;

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  clock.mono = realMono;
  vi.restoreAllMocks();
});

describe('pipeline trả lời', () => {
  it('câu trả lời kèm nguồn; guardrail trên câu GỐC, slug "chua-" trong URL không flag oan', async () => {
    const r = rig({
      answer: () => ({
        answer: 'Saphraton: 1.000.000 đ',
        sources: ['http://samsam.net.vn/vi/news/bai-chua-benh-1.html'],
      }),
    });
    const out = await r.svc.handleText('u1', 'giá?');
    expect(r.sent[0]?.[1]).toBe(
      'Saphraton: 1.000.000 đ\nNguồn: http://samsam.net.vn/vi/news/bai-chua-benh-1.html',
    );
    expect(out.sent).toBe(true);
  });

  it('guardrail flag → FALLBACK; raw vi phạm giữ ở flagged_text; không vào history', async () => {
    const r = rig({ answer: () => ({ answer: 'chữa khỏi ung thư', sources: [] }) });
    await r.svc.handleText('u4', 'x', 'm-flag');
    expect(r.sent[0]?.[1]).toBe(FALLBACK);
    const rec = r.logs()[0];
    expect(rec?.answer).toBe(FALLBACK);
    expect(rec?.flagged_text).toBe('chữa khỏi ung thư');
    expect(rec?.guardrail_ok).toBe(false);
    expect(r.svc.histories.get('u4')).toEqual([]);
  });

  it('mọi câu gửi đi qua check() đúng 1 lần trên câu gốc', async () => {
    const seen: string[] = [];
    const r = rig({ answer: () => ({ answer: 'ok', sources: [] }) });
    r.ch.check = (t) => {
      seen.push(t);
      return { ok: true };
    };
    await r.svc.handleText('u', 'x');
    expect(seen).toEqual(['ok']);
  });

  it('D3.3: convlog đủ schema, không raw user_id', async () => {
    const r = rig({ answer: () => ({ answer: 'Giá 1.000.000 đ', sources: ['http://x'] }) });
    r.ch.check = () => ({ ok: true });
    await r.svc.handleText('u1', 'Saphraton giá bao nhiêu', 'm-log');
    const rec = r.logs()[0] as Record<string, unknown>;
    expect(rec).toMatchObject({
      msg_id: 'm-log',
      user_hash: uhash('u1'),
      question: 'Saphraton giá bao nhiêu',
      answer: 'Giá 1.000.000 đ\nNguồn: http://x',
      sources: ['http://x'],
      guardrail_ok: true,
      answered: true,
      channel: 'zalo',
      provenance: 'sample', // transport giả — không phải đầu ra thật
      is_sample: true,
    });
    expect(Number.isInteger(rec.latency_ms) && Number.isInteger(rec.reply_ms)).toBe(true);
    expect(String(rec.ts)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(JSON.stringify(rec)).not.toContain('"u1"');
    expect(rec).not.toHaveProperty('route');
  });

  it('D5.3/v14.1: câu khách che SĐT/email (+ tên/địa chỉ) trước khi ghi đĩa', async () => {
    const r = rig({ answer: () => ({ answer: 'ok', sources: [] }) });
    await r.svc.handleText('u5', 'gọi 0901234567 hoặc a@b.com giúp tôi', 'm-pii');
    await r.svc.handleText('u7', 'gọi 0901 234 567 hoặc 0901-234-567, giá 1.500.000?', 'm-pii2');
    const [a, b] = r.logs();
    expect(a?.question).toBe('gọi *** hoặc *** giúp tôi');
    expect(b?.question).toBe('gọi *** hoặc ***, giá 1.500.000?');
  });

  it('NO_DATA + ghi được handoff → HANDOFF_TEXT; lượt vẫn vào history; answered:false', async () => {
    const r = rig({ answer: () => ({ answer: RAG_NO_DATA, sources: [] }) });
    r.ch.recordHandoff = () => 77;
    const out = await r.svc.handleText('u10', 'Saphraton có bán ở Mỹ không?', 'm-nd');
    expect(out.text).toBe(HANDOFF_TEXT);
    expect(r.sent[0]?.[1]).toContain('1800577732');
    const rec = r.logs()[0];
    expect(rec?.answered).toBe(false);
    expect(rec?.answer).toBe(HANDOFF_TEXT);
    await r.svc.handleText('u10', 'vậy còn loại khác?');
    expect(r.rag.calls[1]?.[1]).toEqual([
      { role: 'user', content: 'Saphraton có bán ở Mỹ không?' },
      { role: 'assistant', content: RAG_NO_DATA },
    ]);
  });

  it('r12 L3: NO_DATA mà KHÔNG ghi được handoff → câu hotline không hứa', async () => {
    const r = rig({ answer: () => ({ answer: RAG_NO_DATA, sources: [] }) });
    const out = await r.svc.handleText('u1', 'Hũ 300ml giá bao nhiêu?');
    expect(out.text).toBe(NO_HANDOFF_TEXT);
    expect(promised(out.text)).toBe(false);
    expect(r.ch.calls.map((c) => c.fn)).toEqual(['recordHandoff']); // ghi TRƯỚC khi gửi, đúng 1 lần
  });

  it('D4.1: multi-turn — lượt 2 thấy lượt 1; lượt bị flag không vào history', async () => {
    const r = rig({ answer: okAnswer });
    const guard = [true, false, true];
    r.ch.check = () => ({ ok: guard.shift() });
    for (const q of ['câu 1', 'câu 2 bị flag', 'câu 3']) await r.svc.handleText('u1', q);
    expect(r.rag.calls[0]?.[1]).toBe(null);
    expect(r.rag.calls[2]?.[1]).toEqual([
      { role: 'user', content: 'câu 1' },
      { role: 'assistant', content: 'trả lời: câu 1' },
    ]);
  });

  it('history: tối đa 4 cặp; LRU evict user ít hoạt động nhất', async () => {
    const r = rig({ answer: () => ({ answer: 'a', sources: [] }) });
    r.ch.check = () => ({ ok: true });
    r.svc.histMaxUsers = 3;
    for (const u of ['u1', 'u2', 'u3']) await r.svc.handleText(u, 'q');
    await r.svc.handleText('u1', 'q2');
    await r.svc.handleText('u4', 'q');
    expect([...r.svc.histories.keys()].sort()).toEqual(['u1', 'u3', 'u4']);
    expect(r.svc.histories.get('u1')).toHaveLength(4);
    for (let i = 0; i < 6; i++) await r.svc.handleText('u1', `x${i}`);
    expect(r.svc.histories.get('u1')).toHaveLength(8);
  });

  it('D5.5: 2 tin cùng user xử lý tuần tự (lượt sau thấy lượt trước)', async () => {
    const r = rig({
      answer: async () => {
        await tick(100);
        return { answer: 'a', sources: [] };
      },
    });
    r.ch.check = () => ({ ok: true });
    await Promise.all([r.svc.handleText('u1', 'câu 1'), r.svc.handleText('u1', 'câu 2')]);
    expect(r.rag.calls[0]?.[1]).toBe(null);
    expect(r.rag.calls[1]?.[1]).toEqual([
      { role: 'user', content: 'câu 1' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('D4.4: gửi lỗi → sent:false nhưng answered:true', async () => {
    const r = rig({ answer: () => ({ answer: 'ok', sources: [] }) });
    r.svc.sendText = () => false;
    await r.svc.handleText('u2', 'câu hỏi', 'm-sendfail');
    expect(r.logs()[0]).toMatchObject({ sent: false, answered: true });
  });

  it('D4.4: answer() crash → ERROR_FALLBACK, 1 dòng log có error, guardrail_ok null', async () => {
    const r = rig({
      answer: () => {
        throw new TypeError('DB chết');
      },
    });
    const out = await r.svc.handleText('u3', 'câu hỏi?', 'm-crash');
    expect(r.sent.map((s) => s[1])).toEqual([ERROR_FALLBACK]);
    expect(out.text).toBe(ERROR_FALLBACK);
    const recs = r.logs();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      sent: true,
      answer: '',
      answered: false,
      guardrail_ok: null,
      question: 'câu hỏi?',
    });
    expect(String(recs[0]?.error)).toContain('TypeError');
    expect(Number.isInteger(recs[0]?.reply_ms)).toBe(true);
  });

  it('kênh lạ → ERROR_FALLBACK, 0 lời gọi answer, không crash', async () => {
    const r = rig();
    const out = await r.svc.handleText('u3', 'x', '', { channel: 'sms' });
    expect(out.text).toBe(ERROR_FALLBACK);
    expect(r.rag.calls).toEqual([]);
  });

  it('lớp kênh/RAG CHƯA nối → khách nhận hotline (fail-closed), không ném', async () => {
    const svc = new ZaloService(null, undefined, undefined, undefined, {
      env: {},
      convLog: `${rig().dir}/c.jsonl`,
    });
    const sent: string[] = [];
    svc.sendText = (_u, t) => {
      sent.push(t);
      return true;
    };
    expect((await svc.handleText('u1', 'giá?')).text).toBe(ERROR_FALLBACK);
    expect(sent).toEqual([ERROR_FALLBACK]);
  });

  it.each([
    ['Rượu sâm giá bao nhiêu?', 'alcohol'],
    ['ruou sam co ban ko', 'alcohol'],
    ['Rượu sâm chữa tiểu đường không?', 'alcohol'],
    ['Dạ An Sâm uống thay thuốc ngủ được không, tôi mất ngủ 2 năm', 'health'],
    ['Saphraton chữa được ung thư không?', 'health'],
  ])('v5.1: %s → template %s, 0 lời gọi answer, history không đổi', async (q, key) => {
    const r = rig({ answer: priced });
    r.ch.recordHandoff = () => 77;
    await r.svc.handleText('u1', 'Saphraton giá?');
    const before = [...(r.svc.histories.get('u1') ?? [])];
    const out = await r.svc.handleText('u1', q, 'm-r');
    expect(r.rag.calls).toHaveLength(1);
    expect(r.sent.at(-1)?.[1]).toBe(r.ch.template(key));
    expect(out.text).toBe(r.ch.template(key));
    expect(r.svc.histories.get('u1')).toEqual(before);
    const rec = r.logs().at(-1);
    expect(rec).toMatchObject({ route: key, answered: false, guardrail_ok: null, channel: 'zalo' });
    expect(rec?.answer).toBe(r.ch.template(key));
    expect(rec?.reply_ms as number).toBeGreaterThanOrEqual(rec?.latency_ms as number);
  });

  it('r12 L3: template rượu/sức khỏe mà KHÔNG ghi được handoff → câu hotline không hứa', async () => {
    const r = rig({ answer: priced });
    const a = await r.svc.handleText('u1', 'Uống sâm có chữa tiểu đường không?');
    expect(a.text).toBe(NO_HANDOFF_TEXTS.health);
    const b = await r.svc.handleText('u1', 'Rượu sâm giá bao nhiêu?');
    expect(b.text).toBe(NO_HANDOFF_TEXTS.alcohol);
    expect(promised(a.text) || promised(b.text)).toBe(false);
  });

  it('câu thường: đúng 1 lời gọi, text byte-y-hệt; convlog che SĐT; reader cũ vẫn đọc', async () => {
    const r = rig({ answer: priced });
    const out = await r.svc.handleText('u2', 'gọi 0901234567 giúp, Saphraton giá?', 'm-n');
    expect(r.rag.calls).toHaveLength(1);
    expect(r.sent.map((s) => s[1])).toEqual(['Saphraton: 1.000.000 đ\nNguồn: http://x']);
    expect(out.text).toBe('Saphraton: 1.000.000 đ\nNguồn: http://x');
    expect(r.logs()[0]?.question).toBe('gọi *** giúp, Saphraton giá?');
    expect(r.svc.unanswered()).toEqual([]);
  });

  it('Messenger dùng chung pipeline qua send/channel — không gửi qua Zalo', async () => {
    const r = rig({ answer: priced });
    r.svc.sendText = () => {
      throw new Error('không được gửi qua Zalo');
    };
    const got: [string, string][] = [];
    const out = await r.svc.handleText('messenger:123', 'Saphraton giá?', 'mid.1', {
      channel: 'messenger',
      send: (u, t) => {
        got.push([u, t]);
        return true;
      },
    });
    expect(got).toEqual([['messenger:123', 'Saphraton: 1.000.000 đ\nNguồn: http://x']]);
    expect(out.sent).toBe(true);
    const rec = r.logs()[0];
    expect(rec?.channel).toBe('messenger');
    expect(String(rec?.user_hash)).not.toContain('123');
  });

  it('gateway chặn (kill-switch/trần) → chuyển người, không "hệ thống lỗi"', async () => {
    const r = rig({
      answer: () => {
        throw new GatewayBlocked('kill-switch');
      },
    });
    r.ch.recordHandoff = () => 5;
    const a = await r.svc.handleText('u1', 'Sâm Sâm có showroom ở đâu?');
    expect(a.text).toBe(HANDOFF_TEXT);
    r.ch.recordHandoff = () => null;
    const b = await r.svc.handleText('u2', 'Sâm Sâm có showroom ở đâu?');
    expect(b.text).toBe(NO_HANDOFF_TEXT); // L3: không ghi được → không hứa
  });

  it('rút đồng ý ghi lỗi → câu "chưa ghi nhận", không cam kết đã ngừng', async () => {
    const r = rig();
    r.ch.preRoute = () => ({
      kind: 'consent_withdrawn',
      text: r.ch.template('consent_withdrawn_ack'),
      handoff: null,
    });
    r.svc.histories.set('u1', [{ role: 'user', content: 'x' }]);
    const out = await r.svc.handleText('u1', 'không đồng ý nữa');
    expect(out.text).toBe(r.ch.template('consent_withdrawn_fail'));
    expect(r.svc.histories.has('u1')).toBe(false);
    expect(r.logs()[0]?.route).toBe('consent_withdrawn_fail');
  });

  it('chặn LLM khi cần đồng ý → chỉ câu chào; prompted ghi SAU khi gửi được', async () => {
    const r = rig({ answer: priced });
    r.ch.consentGate = () => ({ prefix: 'CHÀO', block: true, prompted: true });
    await r.svc.handleText('u1', 'giá?', 'm1');
    expect(r.rag.calls).toEqual([]);
    expect(r.sent.map((s) => s[1])).toEqual(['CHÀO']);
    expect(r.ch.calls.map((c) => [c.fn, c.args[1]])).toEqual([['recordConsent', 'prompted']]);
    r.ch.calls.length = 0;
    r.svc.sendText = () => false;
    await r.svc.handleText('u1', 'giá?', 'm2');
    expect(r.ch.calls).toEqual([]); // gửi lỗi → KHÔNG ghi "đã báo"
  });
});

describe('cổng triển khai chatbot (HĐ 6.7)', () => {
  it.each(['chay_thu', 'co_nguoi_duyet'])(
    '%s → khách nhận HOLD_TEXT, câu bot thành gợi ý',
    async (md) => {
      const order: string[] = [];
      const r = rig({
        answer: () => ({
          answer: 'Sâm Ngọc Linh hộp 10 củ giá 1.500.000 đ.',
          sources: ['https://samsamngoclinh.com/san-pham'],
        }),
      });
      r.ch.mode = md;
      r.ch.recordHandoff = (_i, reason) => {
        order.push(`handoff:${reason}`);
        return 11;
      };
      r.ch.recordSuggestion = (_i, text) => {
        order.push(`sugg:${text}`);
        return 7;
      };
      r.svc.sendText = (_u, t) => {
        order.push(`send:${t}`);
        return true;
      };
      const out = await r.svc.handleText('u1', 'giá hộp 10 củ?', 'm1');
      expect(out).toMatchObject({ text: HOLD_TEXT, rollout: md });
      expect(order).toEqual([
        'handoff:rollout',
        `send:${HOLD_TEXT}`, // v14.6: GỬI trước, gợi ý ghi DB SAU
        'sugg:Sâm Ngọc Linh hộp 10 củ giá 1.500.000 đ.\nNguồn: https://samsamngoclinh.com/san-pham',
      ]);
      expect(r.logs().at(-1)).toMatchObject({ rollout: md, answered: false, suggestion_id: 7 });
      expect(r.svc.histories.get('u1') ?? []).toEqual([]); // bot chưa trả lời khách
    },
  );

  it('tắt → 0 lời gọi AI, không gợi ý, khách vẫn có HOLD_TEXT + handoff', async () => {
    const r = rig({ answer: priced });
    r.ch.mode = 'tat';
    r.ch.recordHandoff = () => 11;
    await r.svc.handleText('u1', 'giá?', 'm1');
    expect(r.rag.calls).toEqual([]);
    expect(r.ch.calls.filter((c) => c.fn === 'recordSuggestion')).toEqual([]);
    expect(r.sent.map((s) => s[1])).toEqual([HOLD_TEXT]);
  });

  it('chạy thử + câu lớp 2 sức khỏe → template cố định, không gợi ý', async () => {
    const r = rig({ answer: () => ({ answer: 'x', sources: [], handoff: 'health' }) });
    r.ch.mode = 'chay_thu';
    r.ch.recordHandoff = () => 11;
    await r.svc.handleText('u1', 'câu lớp 2', 'm1');
    expect(r.sent.map((s) => s[1])).toEqual([r.ch.template('health')]);
    expect(r.ch.calls.filter((c) => c.fn === 'recordSuggestion')).toEqual([]);
  });

  it.each(['tat', 'chay_thu'])('%s mà không ghi được handoff → không hứa', async (md) => {
    const r = rig({ answer: priced });
    r.ch.mode = md;
    const out = await r.svc.handleText('u1', 'Hũ 300ml còn hàng không?');
    expect(promised(out.text)).toBe(false);
    expect(out.text).toContain('1800577732');
  });
});

describe('hạn chót 30 giây', () => {
  it('v13.7: câu trả lời treo → NO_HANDOFF_TEXT trong hạn; kết quả muộn bị bỏ', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deadlines: unknown[] = [];
    const r = rig({
      answer: async (_q, o) => {
        deadlines.push(o.deadline);
        await gate;
        return { answer: 'Giá 1.000.000 đ', sources: ['https://x'] };
      },
    });
    r.rag.CHAT_BUDGET_S = 0.4;
    r.rag.SEND_RESERVE_S = 0.1;
    const handoffs: string[] = [];
    r.ch.recordHandoff = (_i, reason) => {
      handoffs.push(reason);
      return 13;
    };
    const out = await r.svc.handleText('u1', 'Saphraton giá bao nhiêu?', 'm1');
    release();
    await tick();
    expect(out).toMatchObject({ text: NO_HANDOFF_TEXT, deadline: 'tra_loi' });
    expect(handoffs).toEqual(['deadline']);
    expect(r.sent.map((s) => s[1])).toEqual([NO_HANDOFF_TEXT]);
    expect(r.svc.histories.get('u1') ?? []).toEqual([]);
    expect(r.logs().at(-1)).toMatchObject({ answered: false, error: 'deadline:tra_loi' });
    expect(deadlines[0]).toEqual(expect.any(Number));
  });

  it('chờ lock 31 giây → cho_lock, 0 lời gọi answer; gửi TRƯỚC rồi mới ghi handoff', async () => {
    const order: string[] = [];
    const r = rig();
    r.ch.recordHandoff = () => {
      order.push('db');
      return 1;
    };
    r.svc.sendText = () => {
      order.push('send');
      return true;
    };
    const out = await r.svc.reply('u2', 'Saphraton giá bao nhiêu?', 'm2', {
      tRecv: clock.mono() - 31,
    });
    expect(out).toMatchObject({ deadline: 'cho_lock', text: NO_HANDOFF_TEXT });
    expect(r.rag.calls).toEqual([]);
    expect(order).toEqual(['send', 'db']);
    expect(r.logs().at(-1)?.error).toBe('deadline:cho_lock');
  });

  it('RAG ném DeadlineExceeded(bước) → cũng chuyển người lý do deadline', async () => {
    const r = rig({
      answer: () => {
        throw new DeadlineExceeded('embed');
      },
    });
    const handoffs: string[] = [];
    r.ch.recordHandoff = (_i, reason) => {
      handoffs.push(reason);
      return 1;
    };
    const out = await r.svc.handleText('u1', 'x', 'm', { channel: 'messenger', send: () => true });
    expect(out).toMatchObject({ deadline: 'embed', text: NO_HANDOFF_TEXT });
    expect(handoffs).toEqual(['deadline']);
  });

  it('trả lời nhanh: không deadline, không handoff', async () => {
    const r = rig({ answer: () => ({ answer: 'Giá 1.000.000 đ', sources: ['https://x'] }) });
    const out = await r.svc.handleText('u3', 'Saphraton giá bao nhiêu?', 'm3');
    expect(out.sent).toBe(true);
    expect(out).not.toHaveProperty('deadline');
    expect(r.ch.calls).toEqual([]);
    expect(r.logs().at(-1)?.answered).toBe(true);
  });

  const tokenRig = (over: Partial<Parameters<typeof rig>[0]> = {}) => {
    const calls: [string, number | undefined][] = [];
    const fetch: FetchFn = async (url, init) => {
      const u = new URL(String(url));
      calls.push([`${u.origin}${u.pathname}`, init.timeoutS]);
      if (`${u.origin}${u.pathname}` === OAUTH_URL) {
        return resp(200, {
          access_token: 'new-tok',
          refresh_token: 'new-rtok',
          expires_in: '3600',
        });
      }
      return resp(200, { error: 0 });
    };
    const r = rig({
      env: { ZALO_REFRESH_TOKEN: 'rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      answer: () => ({ answer: 'Giá 1.000.000 đ', sources: ['https://x'] }),
      fetch,
      fakeSend: false,
      ...over,
    });
    const handoffs: string[] = [];
    r.ch.recordHandoff = (_i, reason) => {
      handoffs.push(reason);
      return 13;
    };
    return { ...r, calls, handoffs };
  };

  it('v14.6: trả lời xong giây 27 mà cần refresh → không đủ ngân sách, không gọi gì, chuyển người', async () => {
    const t = tokenRig();
    t.rag.SEND_RESERVE_S = 1;
    const out = await t.svc.reply('u1', 'Saphraton giá bao nhiêu?', 'm1', {
      tRecv: clock.mono() - 27,
    });
    expect(t.calls).toEqual([]);
    expect(out.sent).toBe(false);
    expect(t.handoffs).toEqual(['deadline']);
    expect(t.logs().at(-1)).toMatchObject({
      error: 'deadline:lam_moi_token',
      answered: false,
      sent: false,
    });
  });

  it('còn ~10 giây → refresh timeout ≤ còn lại − 5 giây gửi; gửi được → không chuyển người', async () => {
    const t = tokenRig();
    const out = await t.svc.reply('u2', 'Saphraton giá bao nhiêu?', 'm2', {
      tRecv: clock.mono() - 20,
    });
    expect(t.calls.map((c) => c[0])).toEqual([OAUTH_URL, SEND_URL]);
    const tOauth = t.calls[0]?.[1] as number;
    expect(tOauth).toBeGreaterThan(3);
    expect(tOauth).toBeLessThanOrEqual(5);
    expect(t.calls[1]?.[1]).toBe(SEND_TIMEOUT_S);
    expect(out.sent).toBe(true);
    expect(t.handoffs).toEqual([]);
    expect(t.logs().at(-1)).not.toHaveProperty('error');
  });

  it('chờ refresh của lượt khác có giới hạn → gửi bằng token còn hạn', async () => {
    const t = tokenRig();
    t.svc.sender.writeStore({
      access_token: 'tok',
      refresh_token: 'rtok',
      expires_at: Date.now() / 1000 + 10,
    });
    t.svc.sender.lastRefresh = clock.mono(); // vừa thử
    let release!: () => void;
    const held = t.svc.sender.tokenLock.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const t0 = performance.now();
    const out = await t.svc.reply('u3', 'Saphraton giá bao nhiêu?', 'm3', {
      tRecv: clock.mono() - 22,
    });
    expect(performance.now() - t0).toBeLessThan(8000); // còn ~8s → chờ tối đa ~3s
    release();
    await held;
    expect(out.sent).toBe(true);
    expect(t.handoffs).toEqual([]);
    expect(t.calls.map((c) => c[0])).toEqual([SEND_URL]);
  });

  it('v12.4: reply_ms gồm cả chờ lock user + gửi (≥ latency_ms + 250)', async () => {
    const r = rig({ answer: () => ({ answer: 'Giá 1.000.000 đ', sources: ['http://x'] }) });
    r.svc.sendText = async () => {
      await tick(100);
      return true;
    };
    let release!: () => void;
    const hold = r.svc.withUserLock(
      'u1',
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const p = r.svc.handleText('u1', 'giá?', 'r1');
    await tick(300);
    release();
    await hold;
    await p;
    const rec = r.logs()[0] as Record<string, number>;
    expect(rec.reply_ms).toBeGreaterThanOrEqual(300);
    expect(rec.reply_ms).toBeGreaterThanOrEqual(rec.latency_ms + 250);
  });
});

describe('ảnh/follow/vườn + định tuyến event', () => {
  const ev = (o: Record<string, unknown> = {}) => ({
    app_id: 'app123',
    sender: { id: 'u1' },
    recipient: { id: 'oa1' },
    event_name: 'user_send_text',
    message: { msg_id: 'm1', text: 'Saphraton giá bao nhiêu' },
    timestamp: '1700000000000',
    ...o,
  });

  it('text → handleText; retry cùng msg_id chỉ xử lý 1 lần', async () => {
    const r = rig();
    const got: unknown[][] = [];
    r.svc.handleText = async (...a: unknown[]) => {
      got.push(a);
      return { sent: true, text: '' };
    };
    r.svc.dispatch(ev({ message: { msg_id: 'dup1', text: '  Saphraton giá bao nhiêu  ' } }));
    r.svc.dispatch(ev({ message: { msg_id: 'dup1', text: 'Saphraton giá bao nhiêu' } }));
    await tick();
    expect(got).toEqual([['u1', 'Saphraton giá bao nhiêu', 'dup1']]);
  });

  it('V1.4: ảnh → NON_TEXT_TEXT + convlog answered:false; dedup', async () => {
    const r = rig();
    for (let i = 0; i < 2; i++)
      r.svc.dispatch(ev({ event_name: 'user_send_image', message: { msg_id: 'img1' } }));
    await tick(100);
    expect(r.sent).toEqual([['u1', NON_TEXT_TEXT]]);
    expect(r.logs()).toHaveLength(1);
    expect(r.logs()[0]).toMatchObject({
      question: '[non-text:user_send_image]',
      answer: NON_TEXT_TEXT,
      answered: false,
      guardrail_ok: null,
      sent: true,
      msg_id: 'img1',
    });
  });

  it('V2.4: ảnh đến khi text đang trả lời → chờ lock, gửi đúng thứ tự', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let entered!: () => void;
    const inAnswer = new Promise<void>((res) => {
      entered = res;
    });
    const r = rig({
      answer: async () => {
        entered();
        await gate;
        return { answer: 'a', sources: [] };
      },
    });
    r.ch.check = () => ({ ok: true });
    const p1 = r.svc.handleText('u1', 'q');
    await inAnswer;
    const p2 = r.svc.handleNonText('u1', 'user_send_image');
    await tick(100);
    expect(r.sent).toEqual([]);
    release();
    await Promise.all([p1, p2]);
    expect(r.sent.map((s) => s[1])).toEqual(['a', NON_TEXT_TEXT]);
  });

  it('V2.5/V3.2: follow → WELCOME 1 lần/user (ts khác vẫn dedup); user khác có welcome riêng', async () => {
    const r = rig();
    const f = (uid: string, ts: string) => {
      const e: Record<string, unknown> = ev({
        event_name: 'follow',
        follower: { id: uid },
        timestamp: ts,
      });
      delete e.message;
      return e;
    };
    r.svc.dispatch(f('u-fol', '1700000000000'));
    r.svc.dispatch(f('u-fol', '1700000001000'));
    await tick(100);
    expect(r.sent).toEqual([['u-fol', WELCOME_TEXT]]);
    expect(r.logs()[0]).toMatchObject({
      question: '[event:follow]',
      answer: WELCOME_TEXT,
      answered: null,
      guardrail_ok: null,
      sent: true,
      user_hash: uhash('u-fol'),
    });
    r.svc.dispatch(f('u-fol2', '1700000002000'));
    await tick(100);
    expect(r.sent.map((s) => s[0])).toEqual(['u-fol', 'u-fol2']);
  });

  it('follow thiếu follower → sender.id; không id nào → bỏ', async () => {
    const r = rig();
    r.svc.dispatch(ev({ event_name: 'follow', sender: { id: 'u-sender' } }));
    r.svc.dispatch(ev({ event_name: 'follow', sender: {} }));
    await tick(100);
    expect(r.sent.map((s) => s[0])).toEqual(['u-sender']);
  });

  it('V8.2: msg_id "follow" sau follow vẫn tới handleText (không bị nuốt)', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.svc.handleText = async (...a: unknown[]) => {
      got.push(a);
      return { sent: true, text: '' };
    };
    r.svc.dispatch(ev({ event_name: 'follow', follower: { id: 'u1' } }));
    r.svc.dispatch(ev({ message: { msg_id: 'follow', text: 'hi' } }));
    await tick(100);
    expect(got).toHaveLength(1);
  });

  it('event khác (unfollow, ...) / thân lạ → bỏ hoàn toàn, không convlog', async () => {
    const r = rig();
    const calls: unknown[] = [];
    r.svc.handleText = async (...a: unknown[]) => {
      calls.push(a);
      return { sent: true, text: '' };
    };
    for (const e of [
      ev({ event_name: 'unfollow' }),
      ev({ event_name: 'user_gets_feedback' }),
      [1, 2],
      ev({ event_name: 5 }),
      ev({ sender: 'x' }),
      ev({ message: { msg_id: 'm', text: 42 } }),
      ev({ sender: {} }),
      ev({ message: { msg_id: 'm2', text: '   ' } }),
    ]) {
      r.svc.dispatch(e);
    }
    await tick(100);
    expect(calls).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.logs()).toEqual([]);
  });

  it('v12.4: nhân viên vườn → intake vườn (mọi loại tin), KHÔNG chatbot/convlog; dedup giữ', async () => {
    for (const event of [
      'user_send_text',
      'user_send_image',
      'user_send_audio',
      'user_send_sticker',
    ]) {
      const got: unknown[] = [];
      const garden: GardenIntake = {
        staffCode: (u) => (u === 'u1' ? 'VT01' : null),
        handle: (u, e, _m, mid, send) => {
          got.push([u, e, mid]);
          void send(u, 'đã ghi');
          return { sent: true };
        },
      };
      const r = rig({ garden });
      r.svc.handleText = async () => {
        got.push('WRONG-text');
        return { sent: true, text: '' };
      };
      for (let i = 0; i < 2; i++) {
        r.svc.dispatch(ev({ event_name: event, message: { msg_id: 'g1', text: 'KV-A01 tưới' } }));
      }
      await tick(60);
      expect(got, event).toEqual([['u1', event, 'g1']]);
      expect(r.sent).toEqual([['u1', 'đã ghi']]); // gửi qua sendText của zalo
      expect(r.logs()).toEqual([]);
      expect(r.svc.histories.size).toBe(0);
    }
  });

  it('zalo_seen.db đang bị tiến trình khác (messenger) giữ khóa ghi → chờ tới khi nhả, không bỏ tin', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.svc.handleText = async (...a: unknown[]) => {
      got.push(a);
      return { sent: true, text: '' };
    };
    r.svc.dedup('warm:1'); // tạo file + bảng
    // Worker = kết nối khác giữ BEGIN IMMEDIATE 300 ms (vòng lặp sự kiện riêng nhả được khóa).
    // busy_timeout như Python sqlite3 (5 giây): COMMIT cần EXCLUSIVE, lúc SeenDb thử lại có thể đang giữ
    // SHARED trong chớp mắt — node:sqlite mặc định 0 → 'database is locked' không bắt trong Worker.
    const w = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData);
       db.exec('PRAGMA busy_timeout = 5000');
       db.exec('BEGIN IMMEDIATE');
       db.prepare('INSERT OR IGNORE INTO seen VALUES (?, ?)').run('msgr:x', 1);
       parentPort.postMessage('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`,
      { eval: true, workerData: join(r.dir, 'zalo_seen.db') },
    );
    const exited = new Promise((res) => w.once('exit', res));
    await new Promise((res) => w.once('message', res));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.svc.dispatch(ev({ message: { msg_id: 'busy1', text: 'giá?' } }));
    await tick();
    await exited;
    r.svc.seen.close();
    expect(got).toEqual([['u1', 'giá?', 'busy1']]);
    expect(log.mock.calls.flat().join('\n')).not.toContain('bỏ event không hợp lệ');
    expect(err).not.toHaveBeenCalled();
  });

  it('dedup lỗi (sqlite hỏng/khóa quá 5 giây) → log [error] dedup, không báo nhầm "event không hợp lệ"', async () => {
    const r = rig();
    r.svc.dedup = () => {
      throw new Error('database is locked');
    };
    r.svc.handleText = async () => {
      throw new Error('không được gọi');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.svc.dispatch(ev());
    await tick();
    expect(err.mock.calls.flat().join('\n')).toContain(
      '[error] zalo: dedup lỗi (Error: database is locked)',
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('bỏ event không hợp lệ');
  });

  it('msg_id kiểu số → vẫn trả lời (Python f"{uid}:{mid}"); dedup theo chuỗi', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.svc.handleText = async (...a: unknown[]) => {
      got.push(a);
      return { sent: true, text: '' };
    };
    r.svc.dispatch(ev({ message: { msg_id: 123, text: 'hi' } }));
    r.svc.dispatch(ev({ message: { msg_id: 123, text: 'hi' } }));
    r.svc.dispatch(ev({ message: { msg_id: 0, text: 'ts' } })); // falsy → '' → khóa theo timestamp
    await tick();
    expect(got).toEqual([
      ['u1', 'hi', '123'],
      ['u1', 'ts', ''],
    ]);
  });

  it('allowlist vườn hỏng/chưa nối → không ai là nhân viên, tin đi chatbot', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.svc.handleText = async (u: string) => {
      got.push(u);
      return { sent: true, text: '' };
    };
    r.svc.dispatch(ev({ message: { msg_id: 'g2', text: 'xin chào' } }));
    await tick();
    expect(got).toEqual(['u1']);
  });
});

describe('provenance (v15 fix P8.1)', () => {
  it('transport giả → sample; transport THẬT (chỉ lớp HTTP giả) → live', async () => {
    const r = rig({
      env: { ZALO_ACCESS_TOKEN: 'tok' },
      answer: () => ({ answer: 'giá 1.000.000 đ', sources: [] }),
      fetch: async () => resp(200, { error: 0 }),
      fakeSend: false,
    });
    await r.svc.handleText('u-replay', 'giá sâm?', 'rp-1', { send: () => true });
    await r.svc.handleText('u-live', 'giá sâm?', 'live-1');
    const [a, b] = r.logs();
    expect([a?.provenance, a?.is_sample]).toEqual(['sample', true]);
    expect([b?.provenance, b?.sent, b?.answered, b?.guardrail_ok]).toEqual([
      'live',
      true,
      true,
      true,
    ]);
    expect(b).not.toHaveProperty('is_sample');
  });
});

void log;
