import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import stt from './__fixtures__/stt.golden.json' with { type: 'json' };
import {
  AiWorkerBlocked,
  AiWorkerError,
  AiWorkerRejected,
  ocrViaWorker,
  pyRepr,
  STT_HELP,
  sttProvider,
  transcribe,
  workerReady,
} from './ai-worker.js';

// Golden: `connectors/zalo_garden.stt_provider` / `STT_HELP` / `repr()` của Python thật.
// Worker GIẢ: server HTTP trên 127.0.0.1 trả đúng giao thức của ai_worker/server.py.

let server: Server;
let base = '';
let hits: { path: string; bytes: number }[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{"ok": true, "text": "NHÁP"}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
    });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', bytes: n });
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = [];
  reply = { status: 200, body: '{"ok": true, "text": "NHÁP"}' };
});

const env = (over: Record<string, string> = {}) => ({
  GARDEN_STT_PROVIDER: 'whisper_local',
  AI_WORKER_URL: base,
  ...over,
});

describe('stt_provider = Python', () => {
  it('STT_HELP + mọi tên none/lạ', () => {
    expect(STT_HELP).toBe(stt.help);
    for (const [name, want] of stt.cases as [string, [string, string | null]][]) {
      expect(sttProvider({ GARDEN_STT_PROVIDER: name }), JSON.stringify(name)).toEqual(want);
    }
  });
  it('repr() Python', () => {
    for (const [s, want] of stt.repr) expect(pyRepr(s), JSON.stringify(s)).toBe(want);
  });
  it('whisper_local cần AI_WORKER_URL nội bộ', () => {
    expect(sttProvider(env())).toEqual(['whisper_local', null]);
    expect(sttProvider(env({ AI_WORKER_URL: '' }))[1]).toMatch(
      /^whisper_local cần AI worker nội bộ \(thiếu AI_WORKER_URL\)/,
    );
    expect(sttProvider(env({ AI_WORKER_URL: 'http://stt.example.com' }))[1]).toMatch(/máy nội bộ/);
  });
});

describe('giao thức AI worker', () => {
  const audio = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52]);

  it('chép lời / OCR ok → text', async () => {
    expect(await transcribe(audio, env())).toBe('NHÁP');
    expect(await ocrViaWorker(audio, env())).toBe('NHÁP');
    expect(hits).toEqual([
      { path: '/stt', bytes: 5 },
      { path: '/ocr', bytes: 5 },
    ]);
  });

  it('provider none / tên lạ → AiWorkerBlocked, KHÔNG gửi audio', async () => {
    await expect(transcribe(audio, env({ GARDEN_STT_PROVIDER: '' }))).rejects.toThrow(
      AiWorkerBlocked,
    );
    await expect(transcribe(audio, env({ GARDEN_STT_PROVIDER: 'google' }))).rejects.toThrow(
      /chưa tích hợp/,
    );
    await expect(
      ocrViaWorker(audio, env({ AI_WORKER_URL: 'https://ocr.example.com' })),
    ).rejects.toThrow(AiWorkerBlocked);
    expect(hits).toEqual([]);
  });

  it('503 blocked → AiWorkerBlocked; ok=false → AiWorkerRejected; lạ → AiWorkerError', async () => {
    reply = { status: 503, body: '{"ok": false, "blocked": true, "error": "thiếu model"}' };
    await expect(transcribe(audio, env())).rejects.toThrow(AiWorkerBlocked);
    reply = { status: 200, body: '{"ok": false, "error": "STT whisper_local: ghi âm rỗng"}' };
    await expect(transcribe(audio, env())).rejects.toThrow(
      new AiWorkerRejected('STT whisper_local: ghi âm rỗng'),
    );
    reply = {
      status: 400,
      body: '{"ok": false, "error": "tệp ghi âm không đúng định dạng (magic bytes)"}',
    };
    await expect(transcribe(audio, env())).rejects.toThrow(AiWorkerRejected);
    for (const r of [
      { status: 200, body: '{"ok": true, "text": 5}' },
      { status: 200, body: 'không phải json' },
      { status: 403, body: '{"ok": false, "error": "x"}' },
      { status: 500, body: '' },
    ]) {
      reply = r;
      const p = ocrViaWorker(audio, env());
      await expect(p).rejects.toThrow(AiWorkerError);
      await expect(p).rejects.not.toThrow(AiWorkerRejected);
    }
  });

  it('worker tắt → AiWorkerError (không treo)', async () => {
    await expect(ocrViaWorker(audio, env({ AI_WORKER_URL: 'http://127.0.0.1:9' }))).rejects.toThrow(
      /không phản hồi/,
    );
  });

  it('/readyz', async () => {
    reply = { status: 200, body: '{"ocr": null, "stt": "thiếu model"}' };
    expect(await workerReady(env())).toEqual({ ocr: null, stt: 'thiếu model' });
    expect(hits[0].path).toBe('/readyz');
  });
});
