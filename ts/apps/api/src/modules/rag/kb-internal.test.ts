import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import gold from './__fixtures__/kb_internal.golden.json' with { type: 'json' };
import { chunkText } from './embed-store.js';
import { docSha, isConfidentialLine, MAX_BYTES, parseKbArgs, slug } from './kb-internal.js';
import { kbInternalMain } from './rag.command.js';

// Dịch từ tests/test_kb_internal.py + test_v14_p2_service_auth.py (agent không duyệt) — validate HẾT
// trước connect/embed (exit 2). Golden sinh từ ingest/kb_internal.py THẬT. Phần DB ở rag.db.test.ts.
// `--approved-by` chỉ dùng giá trị mẫu (agent không tự điền tên người thật).

const SAMPLE = repoPath('tests', 'fixtures', 'kb_noi_bo_MAU.md');
const BY = 'MAU-test';
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-kb-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Chạy main với env/pool giả: mọi kết nối/embed = lỗi test. */
async function mainNoConnect(o: Record<string, string | undefined>) {
  const out: string[] = [];
  const boom = async (): Promise<never> => {
    throw new Error('không được connect/embed khi validate lỗi');
  };
  const code = await kbInternalMain(o, {
    env: {},
    servicePool: boom,
    log: (s) => out.push(s),
    err: (s) => out.push(s),
  });
  return { code, out };
}

const fromArgv = (argv: string[]) => {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].slice(2).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    o[k] = argv[i + 1];
  }
  return o;
};

describe('kb-internal golden', () => {
  it.each(gold.slug)('slug %#', (c) => expect(slug(c.in)).toBe(c.out));
  it.each(gold.confidential)('isConfidentialLine %#', (c) => {
    expect(isConfidentialLine(c.in)).toBe(c.out);
  });
  it('doc_sha256 khớp Python', () => {
    const [model, coll, docId, title, ref, text] = gold.sha[0].in;
    expect(docSha(model, coll, docId, title, ref, chunkText(text))).toBe(gold.sha[0].out);
  });
  it('số chunk tài liệu mẫu', () => {
    expect(chunkText(readFileSync(SAMPLE, 'utf8')).length).toBe(gold.sample_chunks);
  });
  it.each(Object.entries(gold.parse_args))('parseKbArgs %s', (_k, c) => {
    // golden ghi đường tuyệt đối của máy sinh golden (Windows) → trỏ về tệp mẫu của checkout này
    const r = parseKbArgs(
      fromArgv(c.argv.map((a) => (a.endsWith('kb_noi_bo_MAU.md') ? SAMPLE : a))),
    );
    if ('err' in c) expect(r).toEqual({ error: c.err });
    else
      expect(r).toMatchObject({
        approvedBy: c.ok?.approved_by,
        docId: c.ok?.doc_id,
        collection: c.ok?.collection,
      });
  });
});

describe('kb-internal validate trước connect/embed (exit 2)', () => {
  it('tài liệu mẫu đánh dấu MẪU', () => {
    const first = readFileSync(SAMPLE, 'utf8').split('\n')[0];
    expect(first.startsWith('MẪU') && first.includes('KHÔNG phải tài liệu thật')).toBe(true);
  });

  it.each([
    [{ collection: 'internal:kd' }],
    [{ collection: 'internal:kd', approvedBy: '' }],
    [{ collection: 'internal:kd', approvedBy: '   ' }],
    [{ collection: 'public', approvedBy: BY }],
    [{ collection: 'internal:', approvedBy: BY }],
    [{ collection: 'internal:KD', approvedBy: BY }],
    [{ collection: 'internal:kd;x', approvedBy: BY }],
    [{ collection: 'internal:kd', approvedBy: BY, docId: '../x' }],
    [{ collection: 'internal:kd', approvedBy: 'agent:kb' }],
    [{ collection: 'internal:kd', approvedBy: 'system:cron' }],
  ])('tham số sai %j', async (o) => {
    const { code } = await mainNoConnect({ file: SAMPLE, ...o });
    expect(code).toBe(2);
  });

  // tên file → nội dung (null = không tạo file; '' = chính thư mục tạm)
  const bad: Record<string, [string, string | Buffer | null]> = {
    missing: ['nope.md', null],
    zero: ['zero.md', ''],
    blank: ['blank.md', ' \n\t\r\n'],
    suffix: ['doc.pdf', 'MAU'],
    nonutf8: ['latin.txt', Buffer.from('MAU \xff\xfe s\xe2m', 'latin1')],
    big: ['big.md', 'a'.repeat(MAX_BYTES + 1)],
    dir: ['', null],
  };
  const badFile = (k: string) => {
    const [name, body] = bad[k];
    const f = join(dir, name);
    if (body !== null) writeFileSync(f, body);
    return f;
  };
  it.each(Object.keys(bad))('file %s', async (k) => {
    const { code } = await mainNoConnect({
      file: badFile(k),
      collection: 'internal:kd',
      approvedBy: BY,
    });
    expect(code).toBe(2);
  });

  it.each([
    'confidential: true\n',
    'Confidential: TRUE\n',
    '   confidential :   true  \r\n',
    '\uFEFFconfidential: true\n',
    `${'MẪU\n'.repeat(19)}confidential: true\n`, // dòng 20 vẫn quét
    'confidential: true # mật\n',
    'confidential: "true"\n',
    'confidential: yes\n',
    '"confidential": true,\n',
    '- confidential: true\n',
    '**confidential: true**\n',
    '**confidential**: true\n',
    'confidential=true\n',
    'confidential:\n', // giá trị rỗng → chặn
    'confidential: mật\n', // giá trị lạ → chặn
    'confidential: false\rjunk\n', // Python `.` ăn cả \r → giá trị lạ → chặn
  ])('tài liệu MẬT %j → exit 2, 0 embed', async (head) => {
    const f = join(dir, 'ban_ve_MAU.md');
    writeFileSync(f, `${head}MẪU tủ điện 3 pha\n`);
    const { code, out } = await mainNoConnect({
      file: f,
      collection: 'internal:san_xuat',
      approvedBy: BY,
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('confidential');
  });

  it('dòng 21 trở đi không quét', () => {
    const f = join(dir, 'x_MAU.md');
    writeFileSync(f, `${'MẪU\n'.repeat(20)}confidential: true\n`);
    expect(parseKbArgs({ file: f, collection: 'internal:kd', approvedBy: BY })).not.toHaveProperty(
      'error',
    );
  });

  it.each([
    'confidential: false\n',
    'Confidential: FALSE # tài liệu thường\n',
    'confidential: "false"\n',
    '- confidential: no\n',
    'confidential = 0\n',
    'confidential: không\n',
    'Confidentiality: thấp\n',
    'Tài liệu này không confidential.\n',
  ])('không mật %j → qua validate', (head) => {
    const f = join(dir, 'thuong_MAU.md');
    writeFileSync(f, `MẪU\n${head}nội dung thường\n`);
    const r = parseKbArgs({ file: f, collection: 'internal:san_xuat', approvedBy: BY });
    expect(r).toMatchObject({ collection: 'internal:san_xuat' });
    expect((r as { text: string }).text).toContain('nội dung thường');
  });

  it('doc-id mặc định = slug tên file; title/source_ref theo tên file', () => {
    const f = join(dir, 'quy-trinh-dong-goi-mau.md');
    copyFileSync(SAMPLE, f);
    expect(
      parseKbArgs({ file: f, collection: 'internal:san_xuat', approvedBy: ` ${BY} ` }),
    ).toMatchObject({
      docId: 'quy-trinh-dong-goi-mau',
      title: 'quy-trinh-dong-goi-mau',
      sourceRef: 'quy-trinh-dong-goi-mau.md',
      approvedBy: BY,
    });
  });
});
