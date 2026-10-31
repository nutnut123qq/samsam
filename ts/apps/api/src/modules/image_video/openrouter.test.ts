import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import * as ims from './image-studio.js';
import * as orp from './openrouter.js';
import * as raster from './raster.js';

// Dịch tests/test_r13_batch_a.py (ảnh nền AI OpenRouter: hợp đồng request, chặn 0 request, thử lại 1
// lần) + tests/test_r13_fix4.py (HTTP 200 = đã tính phí: ghi chi phí ĐÚNG 1 lần kể cả ảnh hỏng; 502
// không tính phí; nút tắt tính năng → 0 request). Server GIẢ (fetch giả) — không mạng, không key thật.
// Cổng AI giả thay `gw._gate`/`gw._record` của Python (core TS chưa có cổng ảnh — xem openrouter.ts).

let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}

type Rec = [string, string, number, number, number, boolean, string | null, string];
type State = {
  spend: number | null;
  cap: number;
  kill: Set<string>;
  script: (number | Response)[];
};

function api(over: Partial<orp.OrDeps> = {}) {
  const req: Record<string, unknown>[] = [];
  const rec: Rec[] = [];
  const st: State = { spend: 0, cap: 5, kill: new Set(), script: [] };
  const sleeps: number[] = [];
  const png = async (w: number, h: number) =>
    (await raster.encodePng(raster.newRaw(w, h, 3, [10, 90, 40]))).toString('base64');
  orp.setOpenrouterDeps({
    env: { OPENROUTER_API_KEY: 'khoa-gia', IMAGE_MODEL: 'vendor/model-gia' },
    gate: async (agent, feature) => {
      // như gw._gate: kill tính năng / chi tiêu không đọc được / vượt trần → chặn TRƯỚC request
      if (st.kill.has(feature))
        throw new GatewayBlocked(`tính năng '${feature}' đang bị nút tắt khẩn`);
      if (st.spend === null)
        throw new GatewayBlocked(`agent '${agent}': không đọc được chi tiêu tháng`);
      if (st.spend >= st.cap) throw new GatewayBlocked(`agent '${agent}' vượt trần tháng`);
      return { providerOnly: ['prov-a'], imageCostFallbackUsd: null };
    },
    record: async (...a) => {
      rec.push(a as Rec);
    },
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      req.push(body);
      const step = st.script.length ? st.script.shift() : 200;
      if (step instanceof Response) return step;
      if (step !== 200) return new Response('{}', { status: step });
      const [w, h] = String(body.size).split('x').map(Number) as [number, number];
      return Response.json({
        data: [{ b64_json: await png(w, h), media_type: 'image/png' }],
        usage: { cost: 0.04 },
      });
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
  return { req, rec, st, sleeps };
}

afterEach(() => orp.setOpenrouterDeps());

describe.skipIf(!HAS_SHARP)('openrouter_images (server giả)', () => {
  it('hợp đồng request + ghi chi phí; provider chỉ nhận prompt + size', async () => {
    const { req, rec } = api();
    const [img, meta] = await ims.generateBackground('nền vườn sâm', [64, 48], {
      provider: 'openrouter_images',
    });
    expect([img.width, img.height]).toEqual([64, 48]);
    expect(meta).toEqual({
      provider: 'openrouter_images',
      model: 'vendor/model-gia',
      ai_generated: true,
    });
    expect(req).toEqual([
      {
        model: 'vendor/model-gia',
        prompt: 'nền vườn sâm',
        size: '64x48',
        output_format: 'png',
        n: 1,
        provider: { only: ['prov-a'], allow_fallbacks: false },
      },
    ]);
    expect(rec.map((r) => [r[0], r[4], r[5], r[7]])).toEqual([
      ['image', 0.04, true, 'marketing-02.1'],
    ]);
  });

  it.each(['no_model', 'no_key', 'kill', 'spend_unknown', 'over_cap'])(
    'bị chặn (%s) → ImageProviderError, 0 request',
    async (setup) => {
      const env: Record<string, string> = {
        OPENROUTER_API_KEY: 'khoa-gia',
        IMAGE_MODEL: 'vendor/model-gia',
      };
      if (setup === 'no_model') delete env.IMAGE_MODEL;
      if (setup === 'no_key') delete env.OPENROUTER_API_KEY;
      const { req, st } = api({ env });
      if (setup === 'kill') st.kill.add('marketing-02.1');
      if (setup === 'spend_unknown') st.spend = null;
      if (setup === 'over_cap') st.spend = 99;
      await expect(
        ims.generateBackground('nền', [32, 32], { provider: 'openrouter_images' }),
      ).rejects.toThrow(ims.ImageProviderError);
      expect(req).toEqual([]);
    },
  );

  it('thử lại ĐÚNG 1 lần khi 502/429; 2 lần 429 → lỗi, ghi usage lỗi', async () => {
    const { req, rec, st, sleeps } = api();
    st.script = [502];
    await ims.generateBackground('nền', [32, 32], { provider: 'openrouter_images' });
    expect(req.length).toBe(2);
    expect(rec.map((r) => r[5])).toEqual([true]);
    expect(sleeps).toEqual([2000]);
    req.length = 0;
    rec.length = 0;
    st.script = [429, 429];
    await expect(
      ims.generateBackground('nền', [32, 32], { provider: 'openrouter_images' }),
    ).rejects.toThrow(/429/);
    expect(req.length).toBe(2);
    expect(rec.map((r) => r[5])).toEqual([false]);
  });

  it('retry-after số giây (≤ 10 s) được tôn trọng', async () => {
    const { st, sleeps } = api();
    st.script = [new Response('{}', { status: 503, headers: { 'retry-after': '30' } })];
    await orp.background('nền', [32, 32]);
    expect(sleeps).toEqual([10_000]);
  });

  const FALLBACK = 0.25;
  it.each([
    [{ data: [{ b64_json: '!bad-base64!' }], usage: { cost: 0.4 } }, 0.4],
    [{ data: [], usage: { cost: 0.4 } }, 0.4],
    [{ usage: { cost: 0.4 } }, 0.4],
    [
      {
        data: [{ b64_json: Buffer.from('khong-phai-anh').toString('base64') }],
        usage: { cost: 0.4 },
      },
      0.4,
    ],
    [{ data: [{ b64_json: '!bad-base64!' }] }, FALLBACK],
    [{ data: [{ b64_json: '!bad-base64!' }], usage: { cost: -1 } }, FALLBACK],
    [{ data: [{ b64_json: '!bad-base64!' }], usage: { cost: true, prompt_tokens: 'x' } }, FALLBACK],
    ['<html>khong phai json</html>', FALLBACK],
  ])('HTTP 200 hỏng → lỗi, chi phí ghi ĐÚNG 1 lần (%#)', async (body, cost) => {
    const { req, rec, st } = api();
    st.script = [
      typeof body === 'string'
        ? new Response(body, { status: 200 })
        : Response.json(body, { status: 200 }),
    ];
    await expect(orp.background('nền', [32, 32])).rejects.toThrow(ims.ImageProviderError);
    expect(req.length).toBe(1);
    expect(rec.length).toBe(1);
    const r = rec[0] as Rec;
    expect(r[4]).toBeCloseTo(cost as number);
    expect(r[5]).toBe(false);
    expect(r[6]).toBeTruthy();
  });

  it('ảnh hợp lệ / 502 không tính phí / nút tắt → "cổng", 0 request', async () => {
    const { req, rec, st } = api();
    const [img, meta] = await orp.background('nền', [32, 32]);
    expect(meta).toEqual({ model: 'vendor/model-gia' });
    expect([img.width, img.height]).toEqual([32, 32]);
    expect(rec.map((r) => [r[4], r[5]])).toEqual([[0.04, true]]);
    rec.length = 0;
    st.script = [new Response('{}', { status: 502 }), new Response('{}', { status: 502 })];
    await expect(orp.background('nền', [32, 32])).rejects.toThrow(/502/);
    expect(rec.map((r) => [r[4], r[5]])).toEqual([[0, false]]); // 502 không tính phí (tài liệu)
    rec.length = 0;
    req.length = 0;
    st.kill.add('marketing-02.1');
    await expect(orp.background('nền', [32, 32])).rejects.toThrow(/cổng/);
    expect(req).toEqual([]);
    expect(rec).toEqual([]);
  });

  it('lỗi mạng → ghi usage lỗi + "lỗi kết nối"', async () => {
    const { rec } = api({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(orp.background('nền', [32, 32])).rejects.toThrow(/lỗi kết nối \(TypeError\)/);
    expect(rec.map((r) => [r[5], r[6]])).toEqual([[false, 'http TypeError']]);
  });
});

describe('openrouter_images mặc định (chưa nối cổng ảnh core)', () => {
  it('CHẶN: 0 request, không gọi cloud ngoài chính sách', async () => {
    let called = 0;
    orp.setOpenrouterDeps({
      env: { OPENROUTER_API_KEY: 'k', IMAGE_MODEL: 'm' },
      fetch: (async () => {
        called++;
        return new Response('{}');
      }) as typeof fetch,
    });
    await expect(orp.background('nền', [32, 32])).rejects.toThrow(/cổng chi phí\/tắt chặn/);
    expect(called).toBe(0);
  });

  // Review: nối THIẾU (chỉ cổng hoặc chỉ ghi) không được mở đường cloud không ghi chi phí — Python
  // gắn cứng cả `gw._gate` lẫn `gw._record`. Bị từ chối, giữ deps mặc định → 0 request.
  it.each(['gate', 'record'] as const)(
    'chỉ nối %s → từ chối, vẫn CHẶN, 0 request',
    async (only) => {
      let called = 0;
      const part = {
        env: { OPENROUTER_API_KEY: 'k', IMAGE_MODEL: 'm' },
        fetch: (async () => {
          called++;
          return new Response('{}');
        }) as typeof fetch,
        [only]:
          only === 'gate'
            ? async () => ({ providerOnly: ['prov-a'], imageCostFallbackUsd: null })
            : async () => {},
      };
      expect(() =>
        orp.setOpenrouterDeps(part as unknown as Parameters<typeof orp.setOpenrouterDeps>[0]),
      ).toThrow(/gate VÀ record/);
      await expect(orp.background('nền', [32, 32])).rejects.toThrow(ims.ImageProviderError);
      expect(called).toBe(0);
    },
  );
});
