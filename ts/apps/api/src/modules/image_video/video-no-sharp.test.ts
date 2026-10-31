import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readinessKey } from '@samsam/core/security/guardrail';
import { afterAll, expect, it, vi } from 'vitest';
import * as vs from './video-studio.js';

// Review (khác biệt TS-only): thiếu gói `sharp` → make_video phải TỪ CHỐI `config` TRƯỚC lời gọi LLM
// viết kịch bản (không đốt LLM), không ném lỗi ở đường B-roll. Giả lập thiếu gói thật bằng vi.mock —
// tệp riêng vì mock áp cả tệp.
vi.mock('sharp', () => {
  throw new Error('Cannot find package sharp');
});

const HONEY = 'mat-ong-sam-300ml';
const TMP = mkdtempSync(join(tmpdir(), 'video-no-sharp-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

it('thiếu sharp → refused config, 0 lời gọi LLM, 0 tệp (kể cả có B-roll có license)', async () => {
  const pk = join(TMP, 'pk');
  const br = join(TMP, 'br');
  const out = join(TMP, 'out');
  mkdirSync(pk);
  mkdirSync(br);
  writeFileSync(join(pk, `${HONEY}.png`), 'x'); // chỉ để qua kiểm "có packshot"
  writeFileSync(join(br, 'a.png'), 'x');
  writeFileSync(join(br, 'licenses.json'), JSON.stringify({ 'a.png': 'CC0' }));
  let calls = 0;
  const ai = {
    chat: async () => {
      calls++;
      return {
        text: JSON.stringify({
          scenes: [
            { text: 'Quà tặng từ núi rừng Quảng Nam', visual: 'broll' },
            { text: 'Mật ong vàng óng từ vùng trồng sâm', visual: 'broll' },
            { text: 'Gói trọn tấm lòng gửi người thân', visual: 'packshot' },
            { text: 'Đặc sản quê hương trong từng giọt', visual: 'broll' },
            { text: 'Món quà tử tế cho dịp sum vầy', visual: 'packshot' },
          ],
        }),
        model: 'fake/test-llm',
        provider: 'ollama' as const,
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  };
  const r = await vs.makeVideo(
    HONEY,
    'tiktok',
    'Quà tặng từ núi rừng Quảng Nam',
    {
      fmt: '9:16',
      readiness: new Map([[readinessKey(HONEY, 'tiktok'), 'TP_THUONG']]),
      packshotDir: pk,
      brollDir: br,
      outDir: out,
    },
    // FFMPEG_BIN = tệp có thật bất kỳ: qua kiểm "có ffmpeg" (không chạy tới bước dựng)
    { ai: ai as never, env: { FFMPEG_BIN: process.execPath } },
  );
  expect(r.ok).toBe(false);
  expect(r.refused?.code).toBe('config');
  expect(r.refused?.reason).toMatch(/sharp/);
  expect(calls).toBe(0);
  expect(r.path).toBeNull();
  let left: string[] = [];
  try {
    left = readdirSync(out);
  } catch {}
  expect(left).toEqual([]);
});
