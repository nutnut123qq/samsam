import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import A from './__fixtures__/anchor.golden.json' with { type: 'json' };
import * as an from './anchor.js';

// Dịch phần thuần + CLI-không-DB của tests/test_v13_c09_anchor_legal.py, test_r13_batch_b.py,
// test_r13_fix4.py (cổng upgrade trên conn giả). Golden = hàm Python THẬT (pipelines/anchor.py).
// Mạng: KHÔNG request thật — `fetch`/`post`/`get` giả.

const TMP = mkdtempSync(join(tmpdir(), 'anchor-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const sha = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();

function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) } };
}

describe('anchor — thuần (golden Python)', () => {
  it('canon/leaf_hash: JSON chuẩn sort_keys + ensure_ascii, lá tách miền 0x00', () => {
    for (const c of A.canon as { obj: unknown; canon: string; leaf?: string }[]) {
      expect(an.canon(c.obj)).toBe(c.canon);
      if (c.leaf) expect(an.leafHash(c.obj as Record<string, unknown>)).toBe(c.leaf);
    }
    const d = { t: 'x', b: 2, a: 'ạ' };
    expect(an.leafHash(d)).toBe(an.leafHash(Object.fromEntries(Object.entries(d).reverse())));
    expect(an.leafHash(d)).not.toBe(sha(Buffer.from(an.canon(d))).toString('hex'));
    expect(/^[\x20-\x7e]*$/.test(an.canon(d))).toBe(true);
    expect(an.canon({ n: 2n ** 63n })).toBe('{"n":9223372036854775808}');
  });

  it('merkle_root: lẻ đẩy nút cuối lên, thứ tự có nghĩa, rỗng → AnchorError', () => {
    for (const c of A.merkle as { hashes: string[]; out?: string; error?: string }[]) {
      if (c.error) expect(() => an.merkleRoot(c.hashes)).toThrow(c.error);
      else expect(an.merkleRoot(c.hashes)).toBe(c.out);
    }
    const [a, b, c] = ['a', 'b', 'c'].map((x) => sha(Buffer.from(x)).toString('hex')) as [
      string,
      string,
      string,
    ];
    const h = (...xs: string[]) =>
      sha(Buffer.concat([Buffer.from([1]), ...xs.map(hex)])).toString('hex');
    expect(an.merkleRoot([a])).toBe(a);
    expect(an.merkleRoot([a, b])).toBe(h(a, b));
    expect(an.merkleRoot([a, b, c])).toBe(h(h(a, b), c));
    expect(an.merkleRoot([a, b])).not.toBe(an.merkleRoot([b, a]));
    expect(() => an.merkleRoot([])).toThrow(an.AnchorError);
    expect(() => an.merkleRoot(['zz'])).toThrow(RangeError);
  });

  it('manifest + sha', () => {
    const m = A.manifest;
    const leaves = m.leaves as an.Leaf[];
    for (const x of leaves) expect(an.leafHash(x.d)).toBe(x.h);
    expect(an.merkleRoot(leaves.map((x) => x.h))).toBe(m.root);
    const body = an.manifest(BigInt(m.as_of_us), leaves, m.root);
    expect(body.toString('latin1')).toBe(m.manifest);
    expect(sha(body).toString('hex')).toBe(m.sha);
  });

  it('tệp .ots: magic + v1 + sha256 + digest + phản hồi', () => {
    const dg = sha(Buffer.from('m'));
    const f = an.otsFile(dg, Buffer.from([0xf0, 0x00]));
    expect(f.subarray(0, 23).toString('latin1')).toBe('\x00OpenTimestamps\x00\x00Proof\x00');
    expect([...f.subarray(an.OTS_MAGIC.length, an.OTS_MAGIC.length + 2)]).toEqual([1, 8]);
    expect(f.subarray(an.OTS_HEAD.length, an.OTS_HEAD.length + 32).equals(dg)).toBe(true);
    expect([...f.subarray(-2)]).toEqual([0xf0, 0x00]);
    expect(an.OTS_HEAD.toString('hex')).toBe(A.ots_head);
  });

  it('varuint LEB128: khứ hồi + giới hạn (BigInt)', () => {
    for (const [v, h] of A.varuint as [string, string][]) {
      expect(an.putVaruint(BigInt(v)).toString('hex')).toBe(h);
      expect(an.varuint(hex(h), 0)).toEqual([BigInt(v), hex(h).length]);
    }
    for (const [h, v, i, err] of A.varuint_bad as [
      string,
      string | null,
      number | null,
      string | null,
    ][]) {
      if (err) expect(() => an.varuint(hex(h), 0), h).toThrow(err);
      else expect(an.varuint(hex(h), 0)).toEqual([BigInt(v as string), i]);
    }
    expect(() => an.varuint(Buffer.from([0x80, 0x80]), 0)).toThrow(an.OtsError);
  });

  it('parse_receipt: cây hợp lệ/hỏng, attestation, ghi lại khứ hồi (golden)', () => {
    const dg = hex(A.receipt_digest);
    for (const c of A.receipts as {
      name: string;
      resp: string;
      atts?: [string, string, string][];
      rewrite?: string;
      error?: string;
    }[]) {
      const rec = an.otsFile(dg, hex(c.resp));
      if (c.error) {
        expect(() => an.parseReceipt(rec, A.receipt_digest), c.name).toThrow(c.error);
        expect(() => an.parseReceipt(rec, A.receipt_digest), c.name).toThrow(an.OtsError);
        continue;
      }
      const tree = an.parseReceipt(rec, A.receipt_digest);
      expect(
        an.attestations(tree).map(([k, cm, p]) => [k, cm.toString('hex'), p.toString('hex')]),
        c.name,
      ).toEqual(c.atts);
      expect(an.otsFile(dg, an.writeTree(tree)).toString('hex'), c.name).toBe(c.rewrite);
    }
    const other = sha(Buffer.from('other')).toString('hex');
    const resp = hex((A.receipts as { name: string; resp: string }[])[0]?.resp as string);
    expect(() => an.parseReceipt(an.otsFile(dg, resp), other)).toThrow(A.wrong_digest as string);
  });

  it('graft: thay pending bằng nhánh Bitcoin; commitment lạ → không gắn', () => {
    const g = A.graft;
    const dg = hex(g.digest);
    const tree = an.parseReceipt(an.otsFile(dg, hex(g.resp)), g.digest);
    const [sub] = an.parseTree(hex(g.sub), 0, hex(g.commitment), [64]);
    expect(an.graft(tree, hex(g.commitment), sub)).toBe(g.grafted);
    expect(an.attestations(tree).map(([k]) => k)).toEqual(g.kinds);
    expect(an.otsFile(dg, an.writeTree(tree)).toString('hex')).toBe(g.after);
    expect(an.parseReceipt(hex(g.after), g.digest)).toBeTruthy();
    const tree2 = an.parseReceipt(an.otsFile(dg, hex(g.resp)), g.digest);
    expect(an.graft(tree2, Buffer.alloc(32), sub)).toBe(A.graft_miss);
  });

  it('load_config: biến thể (golden, tệp a.json)', () => {
    const dir = mkdtempSync(join(TMP, 'cfg-'));
    for (const c of A.config as {
      name: string;
      doc?: unknown;
      raw_b64?: string;
      repo?: boolean;
      out?: unknown;
      error?: string;
    }[]) {
      const p = join(dir, 'a.json');
      rmSync(p, { force: true });
      if (c.raw_b64) writeFileSync(p, Buffer.from(c.raw_b64, 'base64'));
      else if (c.doc !== null && c.doc !== undefined) writeFileSync(p, JSON.stringify(c.doc));
      const path = c.repo ? undefined : p;
      if (c.error) expect(() => an.loadConfig(path), c.name).toThrow(c.error);
      else expect(an.loadConfig(path), c.name).toEqual(c.out);
    }
  });

  it('cấu hình repo: provider none, chưa chốt (quyết định hai bên)', () => {
    const cfg = an.loadConfig();
    expect(cfg.provider).toBe('none');
    expect(cfg.calendars).toEqual([]);
    const raw = JSON.parse(readFileSync(dataPath('anchor_config.json'), 'utf8'));
    expect(raw._doc.toLowerCase()).toContain('hai bên');
    expect(raw.status).toContain('CHƯA CHỐT');
  });
});

describe('anchor — HTTP (fetch giả, không mạng)', () => {
  const fake =
    (status: number, body: Uint8Array | null = Buffer.from('ok')) =>
    async (_u: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(body, { status });
    };

  it('chỉ https', async () => {
    await expect(an.httpPost('http://a.test/digest', Buffer.alloc(32), 1)).rejects.toThrow('https');
    await expect(an.httpGet('http://a.test/x', 1)).rejects.toThrow('https');
  });

  it('POST: 200 → thân; redirect → URLError; 201 → ValueError; 500 → HTTPError; rỗng/quá cỡ', async () => {
    const u = 'https://a.test/digest';
    expect((await an.httpPost(u, Buffer.alloc(32), 1, fake(200) as typeof fetch)).toString()).toBe(
      'ok',
    );
    await expect(an.httpPost(u, Buffer.alloc(32), 1, fake(302) as typeof fetch)).rejects.toThrow(
      'redirect bị chặn',
    );
    await expect(
      an.httpPost(u, Buffer.alloc(32), 1, fake(201) as typeof fetch),
    ).rejects.toMatchObject({ name: 'ValueError' });
    await expect(
      an.httpPost(u, Buffer.alloc(32), 1, fake(500) as typeof fetch),
    ).rejects.toMatchObject({ name: 'HTTPError' });
    await expect(
      an.httpPost(u, Buffer.alloc(32), 1, fake(200, Buffer.alloc(0)) as typeof fetch),
    ).rejects.toThrow('phản hồi rỗng/quá cỡ');
    await expect(
      an.httpPost(u, Buffer.alloc(32), 1, fake(200, Buffer.alloc(an.MAX_RESP + 1)) as typeof fetch),
    ).rejects.toThrow('phản hồi rỗng/quá cỡ');
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(an.httpPost(u, Buffer.alloc(32), 1, boom)).rejects.toMatchObject({
      name: 'URLError',
    });
  });

  it('GET: 404 → null (chưa có); 500 → ValueError', async () => {
    expect(await an.httpGet('https://a.test/t', 1, fake(404) as typeof fetch)).toBeNull();
    await expect(an.httpGet('https://a.test/t', 1, fake(500) as typeof fetch)).rejects.toThrow(
      'HTTP 500',
    );
    expect((await an.httpGet('https://a.test/t', 1, fake(200) as typeof fetch))?.toString()).toBe(
      'ok',
    );
  });
});

describe('anchor — CLI không DB', () => {
  const noConnect = async () => {
    throw new Error('không được connect DB');
  };

  it.each<[an.AnchorOpts]>([
    [{}],
    [{ build: true, status: true }],
    [{ export: '1' }],
    [{ verify: '1', submit: '1' }],
    [{ build: true, by: '   ' }],
    [{ submit: '' }],
  ])('usage %j → exit 2, không connect', async (o) => {
    const c = cap();
    expect(await an.anchorMain(o, { io: c.io, connect: noConnect })).toBe(2);
    expect(c.o.err.join('\n')).toContain('error:');
  });

  it('--submit/--upgrade với provider none → exit 2 TRƯỚC connect ("CHƯA NEO", "hai bên")', async () => {
    for (const o of [{ submit: 'latest' }, { upgrade: '7' }]) {
      const c = cap();
      expect(await an.anchorMain(o, { io: c.io, connect: noConnect })).toBe(2);
      const err = c.o.err.join('\n');
      expect(err).toContain('CHƯA NEO');
      expect(err).toContain('hai bên');
    }
  });

  it('cấu hình hỏng → [err] exit 2; DB không tới được → exit 2', async () => {
    const c = cap();
    const p = join(TMP, 'bad.json');
    writeFileSync(p, '{"provider": "bitcoin"}');
    expect(
      await an.anchorMain({ status: true }, { io: c.io, configFile: p, connect: noConnect }),
    ).toBe(2);
    expect(c.o.err.join('\n')).toContain('provider phải thuộc');
    const c2 = cap();
    expect(await an.anchorMain({ status: true }, { io: c2.io, connect: async () => null })).toBe(2);
    expect(c2.o.err).toEqual(['[err] DB không kết nối được']);
  });
});
