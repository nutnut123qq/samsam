import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AI_GATEWAY, PG_POOL } from '../../db/db.module.js';
import { RagModule } from './rag.module.js';
import { RagService } from './rag.service.js';

// DI NestJS: @Inject tường minh (vitest/tsx không phát emitDecoratorMetadata).
const pool = { query: async () => ({ rows: [] }) };
const ai = {
  chat: async () => ({ text: '', model: 'm', provider: 'ollama', tokensIn: 0, tokensOut: 0 }),
  embed: async () => ({ embeddings: [[1]], model: 'm', provider: 'ollama', tokensIn: 0 }),
};

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useValue: pool },
    { provide: AI_GATEWAY, useValue: ai },
  ],
  exports: [PG_POOL, AI_GATEWAY],
})
class FakeDbModule {}

describe('RagModule', () => {
  it('RagService nhận PG_POOL + AI_GATEWAY', async () => {
    const mod = await Test.createTestingModule({ imports: [FakeDbModule, RagModule] }).compile();
    const s = mod.get(RagService);
    expect(await s.retrieveByVector([1])).toEqual([]);
    expect(await s.answer('Saphraton giá bao nhiêu?')).toEqual({
      answer: 'Chưa đủ dữ liệu để trả lời.',
      sources: [],
    });
  });
});
