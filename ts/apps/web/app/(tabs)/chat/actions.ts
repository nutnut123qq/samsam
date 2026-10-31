'use server';

import type { ApiResult } from '../../../lib/api';
import { apiAction } from '../../../lib/session';

export type Turn = { role: 'user' | 'assistant'; content: string };
export type ChatReply = {
  display: string;
  caption: string | null;
  sources: string[];
  history: Turn[];
  session: string;
};

// Lượt chat: API kiểm vai trò + guardrail TRƯỚC khi trả `display` (vi phạm → câu xin lỗi).
export async function sendChat(
  question: string,
  history: Turn[],
  session: string,
): Promise<ApiResult<ChatReply>> {
  return apiAction<ChatReply>('/chat', { method: 'POST', body: { question, history, session } });
}
