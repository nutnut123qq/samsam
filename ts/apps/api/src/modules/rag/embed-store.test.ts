import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import gold from './__fixtures__/embed_store.golden.json' with { type: 'json' };
import {
  buildDocs,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  chunkText,
  docText,
  EMBED_BATCH,
  langOf,
  readSource,
  SourceError,
} from './embed-store.js';

// Dịch từ tests/test_embed_store.py (phần thuần: read_source/build_docs) — golden sinh từ
// ingest/embed_store.py THẬT với model 'bge-m3'. Phần DB (incremental/delete-trắng/0 ghi) ở
// rag.db.test.ts.

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-es-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeRecs = (d: string, files: Record<string, unknown[]>) => {
  for (const [fn, recs] of Object.entries(files)) {
    writeFileSync(join(d, fn), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
};

describe('embed-store golden', () => {
  it('hằng số', () => {
    expect([CHUNK_SIZE, CHUNK_OVERLAP, EMBED_BATCH]).toEqual([
      gold.consts.CHUNK_SIZE,
      gold.consts.CHUNK_OVERLAP,
      gold.consts.EMBED_BATCH,
    ]);
  });

  it.each(gold.chunks)('chunkText %#', (c) => {
    expect(chunkText(c.in[0] as string, c.in[1] as number, c.in[2] as number)).toEqual(c.out);
  });

  it.each(gold.doc_text)('docText %#', (c) => {
    expect(docText(c.in as Record<string, unknown>)).toBe(c.out);
  });

  it.each(gold.lang_of)('langOf %#', (c) => {
    expect(langOf(c.in)).toBe(c.out);
  });

  it.each(Object.entries(gold.read_source))('readSource %s', (_k, c) => {
    const p = join(dir, 'x.jsonl');
    if (c.raw !== null) writeFileSync(p, Buffer.from(c.raw, 'hex'));
    if ('err' in c) expect(() => readSource(p)).toThrow(new SourceError(c.err as string));
    else expect(readSource(p)).toEqual(c.ok);
  });

  it.each(Object.entries(gold.build_docs))('buildDocs %s', (_k, c) => {
    writeRecs(dir, c.files as Record<string, unknown[]>);
    const logs: string[] = [];
    const run = () => buildDocs(dir, 'bge-m3', (s) => logs.push(s));
    if ('err' in c) {
      expect(run).toThrow(new SourceError(c.err as string));
      return;
    }
    const r = run();
    expect(Object.fromEntries(r.docs)).toEqual(c.docs);
    expect([...r.trusted].sort()).toEqual(c.trusted);
    expect(r.stats).toEqual(c.stats);
    expect(logs.map((l) => `${l}\n`).join('')).toBe(c.log);
  });
});

// Khác Python có chủ đích (TS chặt hơn = fail-closed): field sai kiểu → SourceError TRƯỚC embed/ghi
// DB. Python: url số → TypeError ở lang_of; title/name số/list, price chuỗi → crash muộn (format/DB).
const TS_STRICTER: [string, Record<string, unknown>][] = [
  ['url số', { id: 'a', title: 't', url: 5 }],
  ['title số', { id: 'a', title: 5, url: 'u' }],
  ['title list', { id: 'a', title: ['x'], url: 'u' }],
  ['name null', { id: 'p', name: null, url: 'u' }],
  ['price chuỗi', { id: 'p', name: 'X', price_vnd: '1000', url: 'u' }],
  ['price thập phân', { id: 'p', name: 'X', price_vnd: 1.5, url: 'u' }],
];
describe('embed-store TS chặt hơn', () => {
  it.each(TS_STRICTER)('%s → SourceError', (_n, rec) => {
    writeRecs(dir, { 'news.jsonl': [rec] });
    expect(() => buildDocs(dir, 'bge-m3', () => {})).toThrow(SourceError);
  });
});
