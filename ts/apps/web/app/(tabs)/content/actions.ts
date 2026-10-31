'use server';

import type { ApiResult } from '../../../lib/api';
import { apiAction } from '../../../lib/session';

export type DraftView = {
  text: string;
  lines: [string, string][];
  token: string | null;
  fields?: Record<string, unknown> | null;
  meta?: { refused?: { code?: string; reason?: string } | null } | null;
};
export type SaveReply = {
  ids: string[];
  saved: string[];
  dups: number;
  errs: number;
  blocked: string | null;
};

// Sinh nhiều kênh có thể gọi LLM nhiều lượt (Ollama nội bộ, 1 request song song) → hạn dài hơn.
const GEN_TIMEOUT_MS = 600_000;

export async function generate(input: {
  listing: boolean;
  brief: string;
  channels: string[];
  sku: string | null;
  contentType: string;
}): Promise<ApiResult<{ results: Record<string, DraftView> }>> {
  return input.listing
    ? apiAction('/content/listing', {
        method: 'POST',
        body: { sku: input.sku, channels: input.channels },
        timeoutMs: GEN_TIMEOUT_MS,
      })
    : apiAction('/content/draft', {
        method: 'POST',
        body: {
          brief: input.brief,
          channels: input.channels,
          sku: input.sku,
          contentType: input.contentType,
        },
        timeoutMs: GEN_TIMEOUT_MS,
      });
}

export async function saveDrafts(tokens: string[]): Promise<ApiResult<SaveReply>> {
  return apiAction('/content/save', { method: 'POST', body: { tokens } });
}

export async function checkText(input: {
  text: string;
  channel: string;
  contentType: string;
  isAi: boolean;
}): Promise<ApiResult<{ lines: [string, string][] }>> {
  return apiAction('/content/check', { method: 'POST', body: input });
}
