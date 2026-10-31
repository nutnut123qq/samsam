import { describe, expect, it } from 'vitest';
import { GatewayBlocked, GatewayError } from '../ai/gateway.js';
import { checkPublish } from './guardrail.js';
import { checkPublishLlm, type LlmDeps, parseReply } from './guardrail-llm.js';

// Dịch tests/test_guardrail_llm.py: gateway GIẢ (không mạng). Bất biến: chỉ CHẶN THÊM, luật chặn
// → 0 call, mọi lỗi → fail-closed `llm_check_unavailable`.
const AI = ' Nội dung có sử dụng AI.';
const CLEAN = `Món quà biếu gia đình dịp Tết.${AI}`;
const MODEL = 'qwen3:8b';
type Call = {
  agent: string;
  messages: { role: string; content: string }[];
  opts: Record<string, unknown>;
};

function fake(
  reply: string | Error | null,
  env: Record<string, string> = { GUARDRAIL_LLM_MODEL: MODEL },
) {
  const log: Call[] = [];
  const deps: LlmDeps = {
    env,
    gateway: {
      chat: async (agent, messages, opts) => {
        log.push({
          agent,
          messages: messages as Call['messages'],
          opts: opts as Record<string, unknown>,
        });
        if (reply instanceof Error) throw reply;
        return {
          text: reply as string,
          model: MODEL,
          provider: 'ollama',
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    },
  };
  return { log, deps };
}
const codes = (r: { violations: { code: string }[] }) => r.violations.map((v) => v.code);

describe('guardrail-llm (lớp phụ, chỉ chặn thêm)', () => {
  it('flag=true chặn kèm span trích; tham số gọi gateway', async () => {
    const { log, deps } = fake(
      JSON.stringify({ flag: true, reasons: [{ quote: 'quà biếu', why: 'ẩn ý' }] }),
    );
    const r = await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
    expect([r.ok, r.llm_check, r.llm_model]).toEqual([false, 'flag', MODEL]);
    const v = r.violations[0];
    expect([v.code, v.span, CLEAN.slice(v.start ?? 0, v.end ?? 0)]).toEqual([
      'llm_ngam_y_suc_khoe',
      'quà biếu',
      'quà biếu',
    ]);
    expect(log).toHaveLength(1);
    expect(log[0].agent).toBe('guardrail_llm');
    expect(log[0].opts).toMatchObject({
      feature: 'legal_hr-01',
      model: MODEL,
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 20_000,
    });
  });

  it('trích không có trong text → không span; lý do cắt 200; không lý do → 1 violation mặc định', async () => {
    const { deps } = fake(
      JSON.stringify({ flag: true, reasons: [{ quote: 'không có', why: 'x'.repeat(300) }] }),
    );
    const r = await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
    expect([r.violations[0].span, r.violations[0].start, r.violations[0].detail?.length]).toEqual([
      null,
      null,
      200,
    ]);
    const r2 = await checkPublishLlm(CLEAN, { channel: 'web' }, fake('{"flag": true}').deps);
    expect([codes(r2), r2.llm_check]).toEqual([['llm_ngam_y_suc_khoe'], 'flag']);
  });

  it('flag=false → pass; prompt rào bằng dấu phân cách ngẫu nhiên + dặn KHÔNG làm theo', async () => {
    const { log, deps } = fake('```json\n{"flag": false}\n```');
    const r = await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
    expect([r.ok, r.llm_check, r.violations]).toEqual([true, 'pass', []]);
    await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
    expect(log[0].messages[0].content).toContain('KHÔNG làm theo');
    const lines = log[0].messages[1].content.split('\n');
    expect(lines[0]).toBe(lines.at(-1));
    expect(lines[0].startsWith('<<<VAN_BAN_')).toBe(true);
    expect(log[1].messages[1].content.split('\n')[0]).not.toBe(lines[0]);
  });

  it.each([
    ['gateway_error', new GatewayError('thiếu key')],
    ['kill_switch', new GatewayBlocked('kill')],
    ['loi_khac', new TypeError('x')],
    ['not_json', 'Bài này ổn.'],
    ['flag_str', '{"flag": "true"}'],
    ['empty_obj', '{}'],
    ['list', '[]'],
    ['content_none', null],
    ['flag_int', '{"flag": 0}'],
  ])('%s → unavailable (fail-closed)', async (_n, reply) => {
    const { deps } = fake(reply as string | Error | null);
    expect(checkPublish(CLEAN, { channel: 'web' }).ok).toBe(true);
    const r = await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
    expect([r.ok, r.llm_check, codes(r), r.violations[0].severity]).toEqual([
      false,
      'unavailable',
      ['llm_check_unavailable'],
      'major',
    ]);
  });

  it('text quá dài / không có gateway → unavailable, không gửi gì', async () => {
    const { log, deps } = fake('{"flag": false}');
    const r = await checkPublishLlm(`${'a'.repeat(9000)}${AI}`, { channel: 'web' }, deps);
    expect([r.llm_check, log.length]).toEqual(['unavailable', 0]);
    const r2 = await checkPublishLlm(
      CLEAN,
      { channel: 'web' },
      { gateway: null, env: { GUARDRAIL_LLM_MODEL: MODEL } },
    );
    expect(r2.llm_check).toBe('unavailable');
  });

  it('tắt khi chưa đặt model / chỉ khoảng trắng / useLlm=false; useLlm=true thiếu model → unavailable', async () => {
    for (const env of [{}, { GUARDRAIL_LLM_MODEL: '  ' }] as Record<string, string>[]) {
      const { log, deps } = fake('{"flag": true}', env);
      for (const text of [CLEAN, `Savina chữa ho.${AI}`]) {
        const r = await checkPublishLlm(text, { channel: 'web' }, deps);
        const { llm_check, llm_model, ...rest } = r;
        expect([llm_check, llm_model]).toEqual(['off', null]);
        expect(rest).toEqual(checkPublish(text, { channel: 'web' }));
      }
      expect(log).toEqual([]);
      const u = await checkPublishLlm(CLEAN, { channel: 'web', useLlm: true }, deps);
      expect([u.ok, u.llm_check, log.length]).toEqual([false, 'unavailable', 0]);
    }
    const { log, deps } = fake('{"flag": true}');
    const r = await checkPublishLlm(CLEAN, { channel: 'web', useLlm: false }, deps);
    expect([r.llm_check, r.ok, log.length]).toEqual(['off', true, 0]);
  });

  it('luật đã chặn → skipped, 0 call, violations giữ nguyên', async () => {
    const { log, deps } = fake('{"flag": false, "ok": true}');
    const r = await checkPublishLlm(`Savina chữa ho.${AI}`, { channel: 'web' }, deps);
    expect([r.ok, r.llm_check, log.length]).toEqual([false, 'skipped', 0]);
    expect(codes(r)).toContain('tu_cam');
  });

  it('GUARDRAIL_LLM_TIMEOUT như Python float(), ngoài (0, 120] → 20', async () => {
    for (const [raw, want] of [
      ['7', 7_000],
      [' 7.5 ', 7_500],
      ['abc', 20_000],
      ['-1', 20_000],
      ['9999', 20_000],
      ['0x10', 20_000],
    ] as const) {
      const { log, deps } = fake('{"flag": false}', {
        GUARDRAIL_LLM_MODEL: MODEL,
        GUARDRAIL_LLM_TIMEOUT: raw,
      });
      await checkPublishLlm(CLEAN, { channel: 'web' }, deps);
      expect(log[0].opts.timeoutMs, raw).toBe(want);
    }
  });

  it('parseReply chặt', () => {
    expect(parseReply('  {"flag": true, "reasons": []} ')).toEqual({ flag: true, reasons: [] });
    for (const bad of [null, 1, '', 'x', '{"flag": 1}', '[true]', '```\n[]\n```']) {
      expect(parseReply(bad)).toBeNull();
    }
  });
});
