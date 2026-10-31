import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import { loadData } from '@samsam/core/config';
import type { Env } from '@samsam/core/env';
import { cpSlice } from '@samsam/core/ops/py';
import { check } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { casefold, pyStrip, stripAccents } from '@samsam/core/security/py';
import { FALLBACK, HANDOFF_TEXT } from './zalo.constants.js';
import type { AnswerResult, ChatChannels, ChatRag, GardenIntake, ReplyMeta } from './zalo.deps.js';
import type { FetchFn } from './zalo.sender.js';
import { ZaloService } from './zalo.service.js';

// Bản GIẢ của lớp kênh (connectors/channels.py) khi KHÔNG có muối CHANNEL_HASH_SALT — đúng nhánh
// Python test_zalo dùng (`_isolated_files` xóa muối): user_hash None → không chạm DB (đồng ý
// "unknown", handoff/consent/gợi ý → None). Luật trước LLM + format_reply theo channels.py.

const CHANNELS = ['zalo', 'messenger', 'shopee', 'tiktok'];
const SAN = ['shopee', 'tiktok'];
type Cfg = { templates: Record<string, string>; require_consent_for_llm: boolean };

export type FakeChannels = ChatChannels & {
  mode: string;
  check: (t: string) => { ok?: unknown };
  calls: { fn: string; args: unknown[] }[];
};

export function fakeChannels(over: Partial<FakeChannels> = {}): FakeChannels {
  const cfg = loadData('channels.json') as Cfg;
  const ch: FakeChannels = {
    mode: 'van_hanh',
    check: (t) => check(t),
    calls: [],
    template: (key) => {
      const t = cfg.templates[key];
      if (t === undefined) throw new Error(`KeyError: ${key}`);
      return t;
    },
    normalize(channel, _userId, text) {
      if (!CHANNELS.includes(channel)) throw new RangeError(`kênh '${channel}' không hỗ trợ`);
      const t = cpSlice(pyStrip(String(text).normalize('NFC')), 0, 4000);
      return { channel, user_hash: null, text: t, ts: '2026-10-29T00:00:00Z' };
    },
    preRoute(inb) {
      const san = SAN.includes(inb.channel);
      const words = stripAccents(casefold(String(inb.text)))
        .replace(/[^\p{L}\p{N}\s]|_/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
      if (!san && words.join(' ') === 'dong y') {
        return { kind: 'consent_granted', text: ch.template('consent_ack'), handoff: null };
      }
      if (isAlcohol(inb.text)) {
        return {
          kind: 'alcohol',
          text: ch.template(san ? 'alcohol_san' : 'alcohol'),
          handoff: 'alcohol',
        };
      }
      if (isHealthQuestion(inb.text)) {
        return {
          kind: 'health',
          text: ch.template(san ? 'health_san' : 'health'),
          handoff: 'health',
        };
      }
      return null;
    },
    consentGate: () => {
      // không muối → trạng thái 'unknown'; cờ require_consent_for_llm bật = chặn (fail-closed)
      if (cfg.require_consent_for_llm) {
        return { prefix: ch.template('consent_prompt'), block: true, prompted: false };
      }
      return { prefix: '', block: false, prompted: false };
    },
    chatbotMode: () => ch.mode,
    formatReply(_channel: string, res: AnswerResult): [string, ReplyMeta] {
      const raw = res.answer;
      const sources = res.sources ?? [];
      const ok = Boolean(ch.check(raw).ok);
      const meta: ReplyMeta = { guardrail_ok: ok, handoff: null, blocked: [] };
      const hand = res.handoff;
      if (hand === 'alcohol' || hand === 'health') {
        meta.handoff = hand;
        return [ch.template(hand), meta];
      }
      if (!ok) return [FALLBACK, { ...meta, handoff: 'guardrail', blocked: ['guardrail'] }];
      if (raw.includes(RAG_NO_DATA)) return [HANDOFF_TEXT, { ...meta, handoff: 'no_data' }];
      return [sources.length ? `${raw}\nNguồn: ${sources[0]}` : raw, meta];
    },
    recordHandoff: (...args) => {
      ch.calls.push({ fn: 'recordHandoff', args });
      return null;
    },
    recordConsent: (...args) => {
      ch.calls.push({ fn: 'recordConsent', args });
      return null;
    },
    recordSuggestion: (...args) => {
      ch.calls.push({ fn: 'recordSuggestion', args });
      return null;
    },
    ...over,
  };
  return ch;
}

export const RAG_NO_DATA = 'Chưa đủ dữ liệu để trả lời.';

export type FakeRag = ChatRag & { calls: [string, unknown][] };
export function fakeRag(
  answer: ChatRag['answer'] = (q) => ({ answer: `trả lời: ${q}`, sources: [] }),
): FakeRag {
  const r: FakeRag = {
    NO_DATA: RAG_NO_DATA,
    CHAT_BUDGET_S: 30,
    SEND_RESERVE_S: 5,
    calls: [],
    answer: (q, o) => {
      r.calls.push([q, o.history ?? null]);
      return answer(q, o);
    },
  };
  return r;
}

export type Rig = {
  svc: ZaloService;
  ch: FakeChannels;
  rag: FakeRag;
  dir: string;
  sent: [string, string][];
  logs: () => Record<string, unknown>[];
};

/** Service cô lập: SEEN_DB/CONV_LOG/TOKEN_STORE trong thư mục tạm, DEPLOY=1, transport giả. */
export function rig(
  o: {
    env?: Env;
    channels?: Partial<FakeChannels>;
    answer?: ChatRag['answer'];
    garden?: GardenIntake;
    fetch?: FetchFn;
    fakeSend?: boolean;
  } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'zalo-'));
  const ch = fakeChannels(o.channels);
  const rag = fakeRag(o.answer);
  const svc = new ZaloService(null, ch, rag, o.garden, {
    env: { DEPLOY: '1', ...o.env },
    seenDb: join(dir, 'zalo_seen.db'),
    convLog: join(dir, 'conversations.jsonl'),
    tokenStore: join(dir, 'zalo_tokens.json'),
    fetch: o.fetch ?? (() => Promise.reject(new Error('không được gọi mạng'))),
  });
  const sent: [string, string][] = [];
  if (o.fakeSend !== false) {
    svc.sendText = (u, t) => {
      sent.push([u, t]);
      return true;
    };
  }
  const logs = () => {
    try {
      return readFileSync(join(dir, 'conversations.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { svc, ch, rag, dir, sent, logs };
}

/** Response giả cho fetch (status + body JSON). */
export function resp(status: number, body: unknown = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}
