import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings as fbSettings } from '../messenger_fanpage/fanpage.js';
import G from './__fixtures__/ra_kenh.golden.json' with { type: 'json' };
import * as pt from './partner.js';
import { type CliDeps, raKenhMain } from './ra-kenh.command.js';
import * as rk from './ra-kenh.js';
import * as xq from './xnqc-read.js';

// Dịch phần THUẦN của tests/test_ra_kenh.py, test_contract_c12_channel_scan.py (web_rows),
// test_r16_fanpage.py (fanpage_rows, dry-run), test_r17/r18/r19 (cổng TẮT, nguồn hỏng, ngày hỏng),
// test_v14_p5_mkt_ceo_intel.py + test_v15_p12_policies.py (đối tác THUẦN). Kết quả mẫu = chạy hàm
// Python THẬT (`__fixtures__/ra_kenh.golden.json`, script sinh ở scratchpad); TS phải khớp y hệt.
// Mạng: server giả 127.0.0.1 ĐẾM request — không gọi Graph thật. Không DB (connect giả ném lỗi).

const CFG = rk.loadConfig();
const tmp = mkdtempSync(join(tmpdir(), 'ra-kenh-'));
let seq = 0;
const freshDir = () => {
  const d = join(tmp, String(seq++));
  mkdirSync(d);
  return d;
};
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type GRow = Record<string, unknown>;
const toRow = (r: GRow): rk.Row =>
  ({
    line: null,
    sha: '',
    ...r,
    draft_id: r.draft_id === null || r.draft_id === undefined ? null : String(r.draft_id),
  }) as rk.Row;

const noConnect = async (): Promise<null> => {
  throw new Error('không được connect DB');
};
const cap = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const deps = (c: ReturnType<typeof cap>, extra: Partial<CliDeps> = {}): CliDeps => ({
  io: c.io,
  connect: noConnect,
  wire: () => undefined,
  env: {},
  ...extra,
});

beforeEach(() => {
  settings.forceMode = 'van_hanh';
});
afterEach(() => {
  settings.forceMode = null;
});

describe('golden Python — luật chung', () => {
  it('by_error / safe / page_safe', () => {
    for (const [b, want] of G.by_error) expect([b, rk.byError(b)]).toEqual([b, want]);
    for (const [s, want] of G.safe) expect(rk.safe(s)).toBe(want);
    for (const [s, want] of G.page_safe) expect(rk.pageSafe(s as string)).toBe(want);
  });

  it('parse_now: thiếu múi giờ = giờ VN; sai → lỗi', () => {
    for (const [s, want] of G.parse_now as [string, string | null][]) {
      if (want === null) expect(() => rk.parseNow(s), s).toThrow(RangeError);
      else expect(rk.parseNow(s).getTime(), s).toBe(Date.parse(want));
    }
  });

  it('load_config fail-closed', () => {
    expect(CFG).toEqual(G.config);
    for (const [name, c] of Object.entries(G.config_cases) as [
      string,
      { content: string | null; ok?: unknown; err?: string },
    ][]) {
      const p = join(freshDir(), `${name}.json`);
      if (c.content !== null) writeFileSync(p, Buffer.from(c.content, 'utf8'));
      if (c.ok) expect(rk.loadConfig(p), name).toEqual(c.ok);
      else {
        expect(() => rk.loadConfig(p), name).toThrow(RangeError);
        // thông điệp chính giống Python (trừ chi tiết lỗi giải mã của fromisoformat)
        if (!c.err?.startsWith('Invalid isoformat')) {
          expect(() => rk.loadConfig(p), name).toThrow(c.err as string);
        }
      }
    }
  });

  it('hours: làm tròn .1f như Python (nửa về chẵn)', () => {
    for (const [s, want] of G.hours as [number, string][]) {
      expect(`${rk.fixed1(Math.abs(s) / 3600)} giờ`, String(s)).toBe(want);
    }
  });
});

describe('golden Python — read_export (kiểm toàn file, không chép giá trị ô)', () => {
  for (const [name, c] of Object.entries(G.read_export) as [
    string,
    { name: string; b64: string; rows?: GRow[]; errors?: string[] },
  ][]) {
    it(name, () => {
      const p = join(freshDir(), c.name);
      writeFileSync(p, Buffer.from(c.b64, 'base64'));
      if (c.rows) expect(rk.readExport(p, CFG)).toEqual(c.rows);
      else {
        let err: unknown;
        try {
          rk.readExport(p, CFG);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(rk.ExportError);
        expect((err as rk.ExportError).errors).toEqual(c.errors);
      }
    });
  }
});

describe('golden Python — scan_row / excerpt', () => {
  it('scan_row: luật hosting/thiếu bản duyệt/S1/che PII', () => {
    for (const c of G.scan_row as {
      row: GRow;
      codes: string[];
      severity: string | null;
      kind: string;
      excerpt: string;
      marker: boolean;
    }[]) {
      const s = rk.scanRow(toRow(c.row), CFG);
      expect(
        { codes: s.codes, severity: s.severity, kind: s.kind, excerpt: s.excerpt },
        String(c.row.text).slice(0, 40),
      ).toEqual({ codes: c.codes, severity: c.severity, kind: c.kind, excerpt: c.excerpt });
      expect(Boolean(s.guardrail.hosting_marker)).toBe(c.marker);
    }
  });

  it('excerpt: SĐT vắt mép cửa sổ không lộ chữ số', () => {
    for (const [text, sev, ex] of G.excerpt as [string, string, string][]) {
      const s = rk.scanRow(
        toRow({
          url: 'https://samsam.net.vn/x',
          channel: 'web',
          content_type: 'post',
          posted_on: '2021-01-11',
          sku: null,
          is_ai: false,
          is_sponsored: false,
          text,
        }),
        CFG,
      );
      expect([s.severity, s.excerpt]).toEqual([sev, ex]);
      expect(/\d/.test(s.excerpt)).toBe(false);
      expect(s.excerpt).toContain('chữa');
    }
  });
});

describe('golden Python — nguồn tự thu (web/Fanpage)', () => {
  for (const [name, c] of Object.entries(G.web_rows) as [
    string,
    { files: Record<string, { text: string; age: number }>; rows: GRow[]; notes: string[] },
  ][]) {
    it(`web_rows ${name}`, () => {
      const now = new Date();
      const d = freshDir();
      for (const [f, { text, age }] of Object.entries(c.files)) {
        const p = join(d, `${f}.jsonl`);
        writeFileSync(p, Buffer.from(text, 'utf8'));
        const t = Date.now() / 1000 - age * 86400;
        utimesSync(p, t, t);
      }
      const [rows, notes] = rk.webRows(now, d);
      expect(rows).toEqual(c.rows);
      expect(notes).toEqual(c.notes);
      expect(notes.some((n) => n.includes('cũ'))).toBe(name === 'c12');
    });
  }

  it('r19: JSON lồng sâu không làm chết lượt', () => {
    const d = freshDir();
    const deep = 50_000;
    writeFileSync(
      join(d, 'articles.jsonl'),
      `${JSON.stringify({ title: 'T', body: 'x', url: 'https://samsam.net.vn/a' })}\n${'{"a":'.repeat(deep)}1${'}'.repeat(deep)}\n`,
    );
    const [rows, notes] = rk.webRows(new Date(), d);
    // V8 giải được (dict không url → bỏ lặng) hoặc lỗi (→ "dòng 2 hỏng") — cả hai hợp lệ.
    expect(rows.map((r) => r.url)).toEqual(['https://samsam.net.vn/a']);
    expect(notes.filter((n) => n.startsWith('web/articles') && !n.includes('dòng 2 hỏng'))).toEqual(
      [],
    );
  });

  it('web_date / fb_date', () => {
    for (const [s, want] of G.web_date as [string, string | null][])
      expect(rk.webDate(s), s).toBe(want);
    // TS_STRICTER: Python `astimezone` tràn năm 9999 ném OverflowError (crash lượt) — TS trả null.
    for (const [v, want] of G.fb_date as [unknown, string | null][]) {
      const w = want === 'EXC:OverflowError' ? null : want;
      expect(rk.fbDate(v), String(v)).toBe(w);
    }
  });
});

// ------------------------------------------------------------------ Fanpage (server giả)
const TOKEN = 'FBTOKEN_SECRET_r16xyz';
const PAGE = '1234567890';
const BAD = 'Sâm Sâm chữa khỏi bệnh tiểu đường cho người bị tiểu đường.';
const OK = 'Sâm Sâm ra mắt hộp quà Tết mới.';
const FB = `https://www.facebook.com/${PAGE}/posts/`;
type Srv = { url: string; requests: string[]; close: () => Promise<void> };
const servers: Srv[] = [];
async function server(handler: () => [number, unknown]): Promise<Srv> {
  const requests: string[] = [];
  const s = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const [status, body] = handler();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const srv = {
    url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
  servers.push(srv);
  return srv;
}
afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});
const fbPost = (
  i: number,
  text: string | null = OK,
  link?: string,
  ct: unknown = '2026-10-20T03:00:00+0000',
) => ({
  id: `${PAGE}_${i}`,
  message: text,
  created_time: ct,
  permalink_url: link ?? `${FB}${i}`,
});
const fbEnv = (s: Srv) => ({
  FANPAGE_PAGE_ID: PAGE,
  FANPAGE_READ_TOKEN: TOKEN,
  FANPAGE_API_BASE: s.url,
});

describe('fanpage_rows (r16/r18)', () => {
  beforeEach(() => {
    fbSettings.sleep = async () => {};
  });

  it('ánh xạ bài Page → dòng facebook; bỏ bài không chữ/permalink hỏng; trùng bỏ qua', async () => {
    const s = await server(() => [
      200,
      {
        data: [
          fbPost(1, BAD, undefined, '2026-10-20T20:00:00+0000'),
          fbPost(2, OK, undefined, 1760000000),
          fbPost(3, OK, undefined, 'hôm qua'),
          fbPost(4, '   '),
          fbPost(5, OK, 'http://www.facebook.com/x'),
          { ...fbPost(6), message: null },
          fbPost(1, BAD, undefined, '2026-10-20T20:00:00+0000'),
        ],
      },
    ]);
    const [rows, notes, rc] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect(rc).toBeNull();
    expect(rows.map((r) => r.url)).toEqual([1, 2, 3].map((i) => `${FB}${i}`));
    expect(rows.map((r) => r.posted_on)).toEqual(['2026-10-21', '2025-10-09', null]);
    expect(new Set(rows.map((r) => `${r.channel}|${r.content_type}|${r.is_ai}`))).toEqual(
      new Set(['facebook|post|false']),
    );
    expect(notes).toEqual([
      `fanpage: bỏ 3 bài không có chữ, dài quá ${rk.MAX_TEXT} ký tự, chữ có ký tự không lưu được (NUL/surrogate) hoặc permalink không hợp lệ`,
    ]);
    expect(rk.scanRow(rows[0] as rk.Row, CFG).severity).toBe('S1');
  });

  it('chưa cấu hình → ghi chú, rc null; cấu hình dở → rc 2, không lộ token', async () => {
    let [rows, notes, rc] = await rk.fanpageRows(null, { env: {} });
    expect([rows, rc]).toEqual([[], null]);
    expect(notes[0]).toContain('chưa cấu hình');
    [rows, notes, rc] = await rk.fanpageRows(null, { env: { FANPAGE_READ_TOKEN: TOKEN } });
    expect([rows, rc]).toEqual([[], 2]);
    expect(notes[0]).not.toContain(TOKEN);
  });

  it('tính năng TẮT → 0 request, rc 2', async () => {
    const s = await server(() => [200, { data: [] }]);
    settings.forceMode = 'tat';
    const [rows, notes, rc] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect([rows, rc]).toEqual([[], 2]);
    expect(notes[0]).toContain('legal_hr-04');
    expect(s.requests).toEqual([]);
  });

  it('lỗi nguồn (token) → rc 1, không lộ token', async () => {
    const s = await server(() => [400, { error: { code: 190 } }]);
    const [rows, notes, rc] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect([rows, rc]).toEqual([[], 1]);
    expect(notes[0]).toContain('mã 190');
    expect(notes[0]).not.toContain(TOKEN);
  });

  it('r18: bỏ bài có NUL/surrogate/permalink hỏng, bài khác vẫn nạp', async () => {
    const posts = [
      fbPost(1, BAD),
      fbPost(2, 'Sâm Sâm\x00 chữa khỏi bệnh'),
      fbPost(3, `Sâm Sâm ${String.fromCharCode(0xd800)} ra mắt`),
      fbPost(4, OK, `${FB}4\x00`),
      fbPost(5, OK, `${FB}5\n`),
      fbPost(6, OK, `${FB}${String.fromCharCode(0xdc80)}6`),
    ];
    const s = await server(() => [200, { data: posts }]);
    const [rows, notes, rc] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect(rc).toBeNull();
    expect(rows.map((r) => r.url)).toEqual([`${FB}1`]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('bỏ 5 bài');
    expect(notes[0]).toContain('NUL');
  });

  it('chữ giữ như CSV (không strip); > MAX_TEXT bị bỏ', async () => {
    const text = `${OK}\n#samsam\n`;
    const s = await server(() => [
      200,
      { data: [fbPost(83, text), fbPost(84, 'x'.repeat(rk.MAX_TEXT + 1))] },
    ]);
    const [rows, notes] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect(rows.map((r) => [r.url, r.text, r.text_is_post])).toEqual([[`${FB}83`, text, true]]);
    expect(notes.some((n) => n.includes('bỏ 1 bài'))).toBe(true);
  });
});

// ------------------------------------------------------------------ CLI (không DB)
const FIX = repoPath('tests/fixtures/ra_kenh');
const U = {
  1: 'https://samsamngoclinh.com/',
  2: 'http://samsam.net.vn/',
  3: 'https://samsamngoclinh.com/product/savigout/',
  4: 'http://samsam.net.vn/vi/news/cam-nang-suc-khoe/savigout-xua-tan-noi-lo-benh-gout-10.html',
  5: 'https://samsam.net.vn/',
};
const SECRET = 'GIATRIDACTRUNG';

describe('CLI ra-kenh (không DB)', () => {
  it('file hỏng → exit 1 "0 dòng nạp", không in giá trị ô, không connect', async () => {
    const bad = [
      'xlsx',
      'not_utf8',
      'dup_header',
      'no_text',
      'stray_col',
      'bad_kenh',
      'host_web',
      'is_ai_yes',
      'draft_abc',
      'bad_date',
      'dup_url',
      'url_ctrl',
      'url_ipv6',
      'text_long',
      'internal_note',
      'text_nul',
      'draft_overflow',
      'draft_5000_digits',
      'url_long',
      'url_long_bytes',
    ];
    const ex = G.read_export as Record<string, { name: string; b64: string }>;
    for (const k of bad) {
      const c = ex[k] as { name: string; b64: string };
      const p = join(freshDir(), c.name);
      writeFileSync(p, Buffer.from(c.b64, 'base64'));
      const io = cap();
      expect(await raKenhMain({ file: p, by: 'test' }, deps(io)), k).toBe(1);
      const all = [...io.out, ...io.err].join('\n');
      expect(all, k).toContain('0 dòng nạp');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(SECRET.toLowerCase());
    }
  });

  it('dry-run fixture F1–F5: kế hoạch đúng mức, không connect', async () => {
    const io = cap();
    expect(
      await raKenhMain({ file: join(FIX, 'f1_f5.csv'), by: 'test', dryRun: true }, deps(io)),
    ).toBe(0);
    const out = io.out.join('\n');
    expect(out).toContain('chưa kiểm lệch bản duyệt');
    const lines = io.out.filter((l) => l.startsWith('[')).slice(1);
    const sev = Object.fromEntries(lines.map((l) => [l.split(' ')[3], l.split(']')[0]?.slice(1)]));
    expect(sev).toEqual({ [U[1]]: 'S1', [U[2]]: 'S2', [U[3]]: 'S1', [U[4]]: 'S1', [U[5]]: 'S2' });
    const line = (u: string) => lines.find((l) => l.split(' ')[3] === u) as string;
    expect(line(U[5])).toContain('— trang_mac_dinh_hosting → ticket hosting_fix');
    expect(line(U[4])).not.toContain('thieu_ban_duyet');
    expect(line(U[4])).toContain('tu_cam');
    expect(line(U[2])).toContain('ngoc_linh_chua_xac_nhan, thieu_ban_duyet →');
    expect(line(U[2])).not.toContain('red_alert');
  });

  it('usage → exit 2 TRƯỚC connect', async () => {
    const cases: Parameters<typeof raKenhMain>[0][] = [
      {},
      { report: true, file: 'x.csv', by: 'A' },
      { report: true, days: '0' },
      { report: true, days: '367' },
      { report: true, days: 'x' },
      { report: true, now: '12/10/2026' },
      { report: true, dryRun: true },
      { file: 'x.csv', by: 'agent:x' },
      { markRemoved: 'u' },
      { markRemoved: 'u', by: 'system: y' },
      { file: 'x.csv', by: 'A', now: '2026-10-12T09:00' },
      { markRemoved: 'u', by: 'A', now: '2026-10-12T09:00' },
      { scanAuto: true, by: 'Người' },
      { scanAuto: true, now: '2026-10-12T09:00' },
      { partnerFile: 'x.csv', by: 'Lan', now: '2026-10-14T09:00' },
      { partnerFile: 'x.csv', report: true },
      { partnerFile: 'x.csv', by: 'agent:x' },
    ];
    for (const o of cases) {
      const io = cap();
      expect(await raKenhMain(o, deps(io)), JSON.stringify(o)).toBe(2);
      expect(io.err.join('\n')).toContain('ra_kenh: error:');
    }
  });

  it('DB down → exit 2 "DB không truy cập được"', async () => {
    const io = cap();
    expect(await raKenhMain({ report: true }, deps(io, { connect: async () => null }))).toBe(2);
    expect(io.out.join('\n')).toContain('DB không truy cập được');
  });

  it('r18: --file/--partner-file --dry-run khi TẮT → exit 2, không in kế hoạch', async () => {
    settings.forceMode = 'tat';
    const p = join(freshDir(), 'x.csv');
    writeFileSync(
      p,
      `url,kenh,is_ai,ngay_dang,draft_id,text\nhttps://samsam.net.vn/vi/news/r18-f.html,web,0,2021-01-11,,${BAD}\n`,
    );
    let io = cap();
    expect(await raKenhMain({ file: p, by: 'Quản lý MXH', dryRun: true }, deps(io))).toBe(2);
    let out = io.out.join('\n');
    expect(out).toContain('[rollout]');
    expect(out).toContain('legal_hr-04');
    expect(out).not.toContain('[dry-run]');
    expect(out).not.toContain('trích:');
    const f = join(freshDir(), 'doi_tac.csv');
    writeFileSync(
      f,
      'ma_doi_tac,url,kenh,text,ngay_dang,sku\nKOC-MAU-01,https://www.tiktok.com/@chi.lan.review/video/1,tiktok,"Sâm này chữa ung thư, uống là khỏi bệnh #quangcao",2026-10-13,\n',
    );
    io = cap();
    expect(await raKenhMain({ partnerFile: f, by: 'Lan', dryRun: true }, deps(io))).toBe(2);
    out = io.out.join('\n');
    expect(out).toContain('marketing-04.2');
    expect(out).not.toContain('tu_cam');
    expect(out).not.toContain('[dry-run]');
    for (const stage of ['chay_thu', 'van_hanh']) {
      settings.forceMode = stage;
      io = cap();
      expect(await raKenhMain({ file: p, by: 'Quản lý MXH', dryRun: true }, deps(io))).toBe(0);
      expect(io.out.join('\n')).toContain('[dry-run]');
    }
  });

  it('--partner-file --dry-run: guardrail theo kênh, không lộ handle/đoạn vi phạm', async () => {
    const f = join(freshDir(), 'doi_tac.csv');
    writeFileSync(
      f,
      'ma_doi_tac,url,kenh,text,ngay_dang,sku\nKOC-MAU-01,https://www.tiktok.com/@chi.lan.review/video/7300000000000000001,tiktok,"Sâm này chữa ung thư, uống là khỏi bệnh #quangcao",2026-10-13,\n',
    );
    const io = cap();
    expect(await raKenhMain({ partnerFile: f, by: 'Lan', dryRun: true }, deps(io))).toBe(0);
    const out = io.out.join('\n');
    expect(out).toContain('tu_cam');
    expect(out).not.toContain('chi.lan');
    expect(out).not.toContain('ung thư');
  });

  it('--scan-auto --dry-run: kế hoạch Fanpage, nguồn lỗi → exit 1, không lộ token', async () => {
    fbSettings.sleep = async () => {};
    const s = await server(() => [200, { data: [fbPost(1, BAD)] }]);
    let io = cap();
    const base = { webRows: () => [[], []] as [rk.Row[], string[]] };
    expect(
      await raKenhMain({ scanAuto: true, dryRun: true }, deps(io, { ...base, env: fbEnv(s) })),
    ).toBe(0);
    const out = io.out.join('\n');
    expect(out).toContain('1 bài web/Fanpage');
    expect(out).toContain('[S1] dòng None '); // bài Fanpage không có số dòng — Python in `None`
    expect(out).toContain('không kế thừa snapshot người');
    expect(out).not.toContain(TOKEN);
    const s2 = await server(() => [500, 'x']);
    io = cap();
    expect(
      await raKenhMain({ scanAuto: true, dryRun: true }, deps(io, { ...base, env: fbEnv(s2) })),
    ).toBe(1);
    expect(io.out.join('\n')).not.toContain(TOKEN);
  });

  it('r18: --scan-auto --dry-run khi TẮT → exit 2, không kế hoạch, 0 request Fanpage', async () => {
    settings.forceMode = 'tat';
    const row = toRow({
      line: 1,
      url: 'https://samsam.net.vn/x.html',
      channel: 'web',
      content_type: 'post',
      posted_on: null,
      is_ai: false,
      is_sponsored: false,
      sku: null,
      draft_id: null,
      text: BAD,
      sha: 'x',
    });
    const s = await server(() => [200, { data: [fbPost(1, BAD)] }]);
    for (const env of [{}, fbEnv(s)]) {
      const io = cap();
      expect(
        await raKenhMain(
          { scanAuto: true, dryRun: true },
          deps(io, { env, webRows: () => [[row], []] }),
        ),
      ).toBe(2);
      const out = io.out.join('\n');
      expect(out).toContain('[rollout]');
      expect(out).toContain('legal_hr-04');
      expect(out).not.toContain('[dry-run]');
      expect(out).not.toContain('[S1]');
    }
    expect(s.requests).toEqual([]);
  });
});

// ------------------------------------------------------------------ báo cáo + xnqc (thuần)
const asDates = (s: GRow): rk.ReportStats => {
  const d = (v: unknown) => (typeof v === 'string' ? new Date(v) : v);
  const st = s as unknown as rk.ReportStats & GRow;
  return {
    ...st,
    now: d(st.now) as Date,
    open: (st.open as unknown as GRow[]).map((o) => ({
      ...o,
      first_detected_at: d(o.first_detected_at),
      due_at: d(o.due_at),
    })) as rk.OpenRow[],
    closed: (st.closed as unknown as GRow[]).map((o) => ({
      ...o,
      closed_at: d(o.closed_at),
      due_at: d(o.due_at),
    })) as rk.ReportStats['closed'],
    detected: (st.detected as unknown as GRow[]).map((o) => ({
      ...o,
      first_detected_at: d(o.first_detected_at),
    })) as rk.ReportStats['detected'],
  };
};

describe('golden Python — báo cáo Pháp chế tuần', () => {
  it('render_report khớp y hệt (không chép đoạn vi phạm, che PII URL)', () => {
    for (const r of [G.render, G.render_empty]) {
      const st = asDates(r.stats as unknown as GRow);
      expect(rk.renderReport(st, st.now)).toBe(r.text);
    }
    expect(G.render.text).not.toContain('0912345678');
  });

  it('xnqc reminders / golden_target / tpbvsk', () => {
    expect(xq.tpbvskSkus()).toEqual(G.tpbvsk);
    const x = G.xnqc_reminders;
    for (const [today, want] of Object.entries(x.out)) {
      expect(
        xq.reminders(
          x.rows as unknown as xq.Dossier[],
          [...G.tpbvsk, 'foo'],
          x.cfg as never,
          today,
        ),
      ).toEqual(want);
    }
    for (const [rows, today, want] of G.golden_target as [xq.Dossier[], string, string][]) {
      expect(xq.goldenTarget(rows, today)).toBe(want);
    }
  });
});

// ------------------------------------------------------------------ đối tác (thuần)
describe('golden Python — đối tác marketing-04.2', () => {
  for (const [name, c] of Object.entries(G.read_partner) as [
    string,
    { text: string; rows?: GRow[]; errors?: string[] },
  ][]) {
    it(`read_partner_export ${name}`, () => {
      const p = join(freshDir(), 'doi_tac.csv');
      writeFileSync(p, Buffer.from(c.text, 'utf8'));
      if (c.rows) expect(pt.readPartnerExport(p)).toEqual(c.rows);
      else {
        let err: unknown;
        try {
          pt.readPartnerExport(p);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(rk.ExportError);
        const errors = (err as rk.ExportError).errors;
        expect(errors).toEqual(c.errors);
        expect(errors.join('\n')).not.toContain('Chị Lan');
        expect(errors.join('\n')).not.toContain('chi.lan');
      }
    });
  }

  it('site / partner_verdict / partner_scan / kit_claims', () => {
    for (const [h, want] of G.site) expect(pt.site(h as string)).toBe(want);
    for (const c of G.partner_verdict as {
      g: GRow;
      kit: { skus: string[]; claims: string[] | null; refs: string[] } | null;
      sku: string | null;
      out: unknown;
    }[]) {
      const kit = c.kit && {
        skus: new Set(c.kit.skus),
        claims: c.kit.claims && new Set(c.kit.claims),
        refs: c.kit.refs,
      };
      expect(pt.partnerVerdict(c.g, kit, c.sku)).toEqual(c.out);
    }
    for (const c of G.partner_scan as {
      row: { text: string; channel: string; sku: string | null };
      out: unknown;
    }[]) {
      expect(pt.partnerScan(c.row, null)).toEqual(c.out);
    }
    const kc = [
      ...pt.kitClaims(
        '# Kit\n\n## Brief\n\nx\n\n## Điểm được nói\n\n- Chỉ nội dung  \n-  hai \n- \n## Nhãn\n\n- #quangcao\n## Điểm được nói  \n- ba\r\n',
      ),
    ].sort();
    expect(kc).toEqual(G.kit_claims);
  });

  it('unknown_partner_policy: CHƯA CHỌN / hỏng / thiếu người chọn → tu_choi_file + cảnh báo', () => {
    for (const [name, c] of Object.entries(G.policy) as [
      string,
      { content: string | null; out: [string, string | null] },
    ][]) {
      if (c.content === 'REPO') {
        expect(pt.unknownPartnerPolicy(), name).toEqual(c.out);
        continue;
      }
      const p = join(freshDir(), 'partner_policy.json');
      if (c.content !== null) writeFileSync(p, c.content);
      expect(pt.unknownPartnerPolicy(p), name).toEqual(c.out);
    }
  });
});

describe('ranh giới (grep như test_grep_no_egress_no_direct_writes)', () => {
  it('không egress ngoài Fanpage chỉ đọc, không ghi thẳng bảng duyệt/golden', () => {
    for (const f of ['ra-kenh.ts', 'partner.ts', 'xnqc-read.ts', 'ra-kenh.command.ts']) {
      const src = readFileSync(join(import.meta.dirname, f), 'utf8');
      for (const w of ['wp-json', 'fetch(', 'graph.facebook', 'node:http', 'node:https']) {
        expect(src.includes(w), `${f} ${w}`).toBe(false);
      }
      expect(
        /(insert\s+into|update|delete\s+from)\s+(sku_master|price_list|content_drafts|approvals|approval_queue|red_alerts)\b/i.test(
          src,
        ),
        f,
      ).toBe(false);
      expect(/(writeFile|appendFile)[^\n]*golden/i.test(src), f).toBe(false);
    }
  });
});
