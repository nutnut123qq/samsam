import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { dataPath } from '@samsam/core/paths';
import { opsRollout, settings } from '@samsam/core/rollout/rollout';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Fetcher } from '../intel_crawl/intel.js';
import { Clock, mockTransport } from '../intel_crawl/intel.testing.js';
import V from './__fixtures__/vt_thoitiet.golden.json' with { type: 'json' };
import * as vt from './vt-thoitiet.js';

// Dịch tests/test_vt_thoitiet.py + test_contract_finalize/c11 (phần thuần/CLI không DB). `--fetch` chạy
// qua collector intel THẬT (`intel_crawl`) với transport + đồng hồ giả (0 request mạng).

const TMP = mkdtempSync(join(tmpdir(), 'vt-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const files = V.files as Record<string, string | null>;
function put(name: string): string {
  const p = join(TMP, name);
  const b = files[name];
  if (b !== null && b !== undefined) writeFileSync(p, Buffer.from(b, 'base64'));
  return p;
}
const CFG = vt.loadConfig();
const TH = CFG.thresholds;
const CODES = new Set(CFG.areas.map((a) => a.code));
const NOW = new Date(V.digest.now);
const DOSE_RE = /\d+\s*(ml|lít|l|g|gam|kg|cc|ppm)\b|\/ha\b/i;
const BANNED = readFileSync(dataPath('banned_words.txt'), 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter((w) => w && !w.startsWith('#'));
type PyErr = { err: string; msg: string };
/** weather_config.json của repo với `fetch` ghi đè (như `_cfg_file` của test Python). */
function cfgFile(fetch: Record<string, unknown>): string {
  const doc = JSON.parse(readFileSync(vt.CONFIG_FILE, 'utf8'));
  Object.assign(doc.fetch, fetch);
  const p = join(TMP, `w-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

describe('loadConfig (golden)', () => {
  // KHÁC Python có chủ đích: NaN bị JSON.parse từ chối (Python nhận rồi chặn ở thresholds) — cùng fail.
  const JS_JSON: Record<string, string> = { nan: 'w_nan.json hỏng: JSONDecodeError' };
  for (const [k, want] of Object.entries(V.config)) {
    it(k, () => {
      const p = k === 'repo' ? undefined : put(`w_${k}.json`);
      if ('err' in want) {
        expect(() => vt.loadConfig(p)).toThrow(vt.ConfigError);
        expect(() => vt.loadConfig(p)).toThrow(JS_JSON[k] ?? (want as PyErr).msg);
      } else {
        const c = vt.loadConfig(p);
        if ('urls' in want) expect(c.areas.map((a) => vt.forecastUrl(c, a))).toEqual(want.urls);
      }
    });
  }
  it('cấu hình repo là GIẢ ĐỊNH, fetch tắt, tọa độ làm tròn 0,1°', () => {
    const raw = JSON.parse(readFileSync(vt.CONFIG_FILE, 'utf8'));
    expect(raw._doc).toContain('GIẢ ĐỊNH');
    expect(raw._doc).toContain('GĐ vùng trồng');
    expect(CFG.fetch.enabled).toBe(false);
    expect(TH).toEqual({ rain_mm_day: 50, tmin_c: 5 });
    expect([CFG.fetch.days, CFG.flag_days]).toEqual([7, 7]);
  });
  it('internalHost (golden, chống SSRF)', () => {
    for (const [h, want] of V.internal_host)
      expect(vt.internalHost(h as string), h as string).toBe(want);
  });
  it('SSRF: host lấy bằng parser WHATWG của chính client TS (\\n, \\t, \\@)', () => {
    const BS = '\\';
    const q = '/v1?lat={lat}&lon={lon}&d={days}';
    // [mẫu, Python nhận?] — chạy agents.vt_thoitiet.load_config thật 30/10/2026.
    const CASES: Record<string, [string, boolean]> = {
      nl: [`https://127.0.0\n.1${q}`, false],
      tab: [`https://127.0.0\t.1${q}`, false],
      v6: [`https://[::1]${q}`, false],
      ok: [`https://api.open-meteo.com${q}`, true],
      bs_at: [`https://127.0.0.1${BS}@api.open-meteo.com${q}`, true],
      hex: [`https://0x7f.1${q}`, true],
      short: [`https://127.1${q}`, true],
      pct: [`https://127.0.0.%31${q}`, true],
      bad_v4: [`https://999.1.1.1${q}`, true],
    };
    // KHÁC Python có chủ đích (TS chặt hơn): urlsplit của Python thấy host công khai/không phải IP,
    // nhưng client TS (WHATWG — intel Fetcher) đi tới 127.0.0.1 (bad_v4: URL hỏng → lỗi cấu hình).
    const TS_STRICTER = ['bs_at', 'hex', 'short', 'pct', 'bad_v4'];
    for (const [k, [tpl, pyOk]] of Object.entries(CASES)) {
      const p = cfgFile({ url_template: tpl });
      if (pyOk && !TS_STRICTER.includes(k)) expect(() => vt.loadConfig(p), k).not.toThrow();
      else expect(() => vt.loadConfig(p), k).toThrow(vt.ConfigError);
    }
    for (const k of ['nl', 'tab', 'bs_at', 'hex', 'short', 'pct'])
      expect(() => vt.loadConfig(cfgFile({ url_template: CASES[k]?.[0] })), k).toThrow('SSRF');
  });
});

describe('readCsv (golden) — có lỗi → 0 xử lý, lỗi không in giá trị', () => {
  for (const [k, want] of Object.entries(V.csv)) {
    it(k, () => {
      let p: string;
      if (k === 'size') {
        p = join(TMP, 'c_big.csv');
        writeFileSync(p, Buffer.alloc(vt.CSV_MAX + 1, '#'));
      } else if (k === 'missing') p = join(TMP, 'khong-co.csv');
      else p = put(`c_${k}.csv`);
      const [rows, errs] = vt.readCsv(p, CODES);
      expect({ rows, errs }).toEqual(want);
      for (const v of ['abc', '1001', '15/10']) expect(errs.some((e) => e.includes(v))).toBe(false);
    });
  }
});

describe('parseOpenMeteo + evaluate (golden)', () => {
  for (const [k, want] of Object.entries(V.open_meteo)) {
    it(k, () => {
      const body = Buffer.from(want.in, 'base64');
      if ('err' in want) {
        expect(() => vt.parseOpenMeteo(body, 'vung-a')).toThrow(vt.SourceError);
        expect(() => vt.parseOpenMeteo(body, 'vung-a')).toThrow(want.msg as string);
      } else expect(vt.parseOpenMeteo(body, 'vung-a')).toEqual(want.rows);
    });
  }
  it('replay 90 ngày × 2 vùng = bộ đếm ĐỘC LẬP; biên đúng ngưỡng không cảnh báo', () => {
    const rows = V.evaluate.rows as vt.WeatherRow[];
    const alerts = vt.evaluate([...rows].reverse(), V.evaluate.th);
    expect(alerts).toEqual(V.evaluate.out);
    const want = new Set(
      rows.filter((r) => r.rain_mm > 50 || r.tmin_c < 5).map((r) => `${r.area}|${r.day}`),
    );
    expect(new Set(alerts.map((a) => `${a.area}|${a.day}`))).toEqual(want);
    expect(alerts.filter((a) => a.kinds.includes('mua_lon')).length).toBe(
      rows.filter((r) => r.rain_mm > 50).length,
    );
    expect(alerts.filter((a) => a.kinds.includes('ret')).length).toBe(
      rows.filter((r) => r.tmin_c < 5).length,
    );
  });
  it('fmt1/md/dedupe cờ (golden)', () => {
    for (const [x, want] of V.fmt) expect(vt.fmt1(x as number)).toBe(want);
    for (const [s, want] of V.md) expect(vt.md(s)).toBe(want);
  });
});

describe('digest (golden) — không tọa độ/liều lượng/từ cấm', () => {
  const d = V.digest;
  const pba = new Map(Object.entries(d.plots_by_area));
  const alerts = d.alerts as vt.Alert[];
  const flags = d.flags as vt.PestFlag[];
  const areas = d.areas as vt.Area[];
  it('khớp Python y hệt', () => {
    expect(
      vt.buildDigest(alerts, flags, pba, NOW, {
        areas,
        thresholds: TH,
        unassigned: ['KV-Z09', '<img src=x>'],
      }),
    ).toBe(d.out.full);
    expect(
      vt.buildDigest(alerts, [], pba, NOW, {
        areas,
        thresholds: TH,
        missing: ['vung-a'],
        logsLoaded: false,
      }),
    ).toBe(d.out.missing);
    expect(vt.buildDigest([], [], new Map(), NOW)).toBe(d.out.bare);
    expect(
      vt.buildDigest([], [], new Map([['vung-z', []]]), NOW, {
        thresholds: { rain_mm_day: 50.25, tmin_c: -0.05 },
      }),
    ).toBe(d.out.noplots);
    expect(vt.buildPestDigest(flags, NOW)).toBe(d.out.pest);
    expect(vt.buildPestDigest([], new Date('2026-10-13T17:00:00Z'))).toBe(d.out.pest_empty);
  });
  it('riêng tư + không chẩn đoán/liều lượng', () => {
    const md = d.out.full;
    for (const a of CFG.areas) for (const v of [a.lat, a.lon]) expect(md).not.toContain(vt.fmt1(v));
    for (const w of ['latitude', 'longitude', 'location', 'area_m2', 'tọa độ'])
      expect(md.toLowerCase()).not.toContain(w);
    expect(DOSE_RE.test(md)).toBe(false);
    const low = md.toLowerCase();
    expect(
      BANNED.filter((w) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}_])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
          'u',
        ).test(low),
      ),
    ).toEqual([]);
  });
  it('mã khoảnh từ DB được escape markdown/HTML', () => {
    const md = vt.buildDigest(
      [],
      [{ plot: '![x](https://e.x/t.png)', day: '2026-10-12', flag: 'rệp' }],
      new Map(),
      NOW,
      {
        unassigned: ['<img src=x>'],
      },
    );
    expect(/(?<!\\)(?:!\[|<img|<b>|\]\()/.test(md)).toBe(false);
    expect(md).toContain('\\!\\[x\\]');
    expect(md).toContain('\\<img');
  });
  it('regex liều lượng bắt được bản đột biến', () => {
    expect(
      DOSE_RE.test('phun 20 ml/bình') && DOSE_RE.test('50 g/ha') && DOSE_RE.test('bón 2 kg'),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ fetch qua Fetcher giả

const FORECAST = Buffer.from(V.open_meteo.ok.in, 'base64');

describe('fetchForecast (collector giả)', () => {
  it('mỗi vùng 1 GET; 5xx/chặn → chưa có dự báo; JSON hỏng → cảnh báo', async () => {
    const urls: string[] = [];
    const f: vt.Fetcher = {
      fetch: async (url) => {
        urls.push(url);
        if (url.includes('latitude=15.1')) return { status: 200, body: FORECAST };
        return { status: 503, body: Buffer.from('') };
      },
    };
    const [rows, missing] = await vt.fetchForecast(CFG, f, () => {});
    expect(urls.length).toBe(2);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      expect(q.get('latitude')).toMatch(/^-?\d+(\.\d)?$/);
      expect(q.get('longitude')).toMatch(/^-?\d+(\.\d)?$/);
    }
    expect(rows.map((r) => r.day)).toEqual(['2026-10-15', '2026-10-16']);
    expect(missing).toEqual(['vung-b']);
    const logs: string[] = [];
    const bad: vt.Fetcher = { fetch: async () => ({ status: 200, body: Buffer.from('{x') }) };
    expect((await vt.fetchForecast(CFG, bad, (s) => logs.push(s)))[1]).toEqual([
      'vung-a',
      'vung-b',
    ]);
    expect(logs.join('\n')).toContain('chưa có dự báo');
  });
  it('chặn domain → null; hết ngân sách → mọi vùng còn lại missing', async () => {
    const blocked: vt.Fetcher = {
      fetch: async () => {
        throw new vt.BlockedDomain('x');
      },
    };
    expect(await vt.fetchForecast(CFG, blocked, () => {})).toEqual([[], ['vung-a', 'vung-b']]);
    const logs: string[] = [];
    let n = 0;
    const budget: vt.Fetcher = {
      fetch: async () => {
        if (n++ >= 1) throw new vt.BudgetExhausted('x');
        return null;
      },
    };
    expect(await vt.fetchForecast(CFG, budget, (s) => logs.push(s))).toEqual([
      [],
      ['vung-a', 'vung-b'],
    ]);
    expect(logs.join('\n')).toContain('hết ngân sách');
  });
  it('collector intel THẬT (transport giả): host bị chặn → chưa có dự báo; hết ngân sách → vùng còn lại', async () => {
    const logs: string[] = [];
    const mk = (budget: number, routes: Parameters<typeof mockTransport>[0]) => {
      const clk = new Clock();
      const transport = mockTransport(routes);
      const f = new Fetcher({
        budget,
        transport,
        sleep: clk.sleep,
        clock: clk.clock,
        log: (s) => logs.push(s),
      });
      return { f, transport };
    };
    const shop = vt.loadConfig(
      cfgFile({ url_template: 'https://shopee.vn/api?lat={lat}&lon={lon}&d={days}' }),
    );
    const b = mk(20, {});
    expect(await vt.fetchForecast(shop, b.f, (s) => logs.push(s))).toEqual([
      [],
      ['vung-a', 'vung-b'],
    ]);
    expect(b.transport.reqs).toEqual([]);
    expect(logs.filter((l) => l.startsWith('[blocked] ')).length).toBe(2);
    const e = mk(2, {
      'api.open-meteo.com/robots.txt': [200, {}, 'User-agent: *\nAllow: /\n'],
      'api.open-meteo.com/v1/forecast': [503, {}, ''],
    });
    expect(await vt.fetchForecast(CFG, e.f, (s) => logs.push(s))).toEqual([
      [],
      ['vung-a', 'vung-b'],
    ]);
    expect(e.transport.reqs.length).toBe(2);
    expect(logs.join('\n')).toContain('hết ngân sách');
  });
});

// ------------------------------------------------------------------ CLI (không DB)

function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) } };
}
const noConnect = async () => {
  throw new Error('connect() không được gọi');
};
const csv = (lines: string[]) => {
  const p = join(TMP, `w${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(p, `${[vt.CSV_HEADER.join(','), ...lines].join('\n')}\n`);
  return p;
};

describe('vtThoitietMain CLI', () => {
  beforeAll(() => installFakeDeps());
  afterAll(() => resetOpsDeps());
  it.each<[vt.VtOpts]>([
    [{ digest: true, fromCsv: 'x.csv', fetch: true }],
    [{ digest: true }],
    [{ fromCsv: 'x.csv' }],
    [{ digest: true, fetch: true, maxRequests: '0' }],
    [{ digest: true, fetch: true, maxRequests: '61' }],
    [{ digest: true, fetch: true, maxRequests: 'x' }],
    [{ digest: true, fromCsv: 'x.csv', date: '14/10/2026' }],
    [{ digest: true, fromCsv: 'x.csv', date: '9999-12-31' }],
    [{ pests: true, fromCsv: 'x.csv' }],
  ])('usage %j → exit 2 trước connect', async (o) => {
    const t = cap();
    expect(await vt.vtThoitietMain(o, { connect: noConnect, io: t.io, now: NOW })).toBe(2);
  });

  it('CSV lỗi → exit 1, không connect', async () => {
    const t = cap();
    const p = csv(['vung-a,2026-10-15,abc,10,20']);
    expect(
      await vt.vtThoitietMain(
        { digest: true, fromCsv: p },
        { connect: noConnect, io: t.io, now: NOW },
      ),
    ).toBe(1);
    expect(t.o.out.join('\n')).toContain('không xử lý');
  });

  // Dịch test_fetch_* của tests/test_vt_thoitiet.py: collector intel THẬT, transport/đồng hồ giả (0 mạng).
  const H = 'api.open-meteo.com';
  const ROBOTS_OK: [number, Record<string, string>, string] = [
    200,
    {},
    'User-agent: *\nAllow: /\n',
  ];
  async function fetchCli(
    routes: Parameters<typeof mockTransport>[0],
    over: Record<string, unknown> = {},
    o: vt.VtOpts = { digest: true, fetch: true },
  ) {
    const t = cap();
    const transport = mockTransport(routes);
    const clk = new Clock();
    const rd = mkdtempSync(join(TMP, 'r-'));
    const rc = await vt.vtThoitietMain(o, {
      connect: async () => null,
      io: t.io,
      now: NOW,
      configFile: cfgFile({ enabled: true, ...over }),
      reportsDir: rd,
      fetchOpts: { transport, sleep: clk.sleep, clock: clk.clock },
    });
    const out = t.o.out.join('\n');
    const md = () => readFileSync(join(rd, 'vt-canh-bao-2026-10-14.md'), 'utf8');
    return { rc, out, reqs: transport.reqs, md };
  }

  it('--fetch chưa bật (cấu hình repo) → exit 2, 0 request, không connect (job vt_weather BLOCKED)', async () => {
    const t = cap();
    const transport = mockTransport({});
    const rc = await vt.vtThoitietMain(
      { digest: true, fetch: true, submit: true },
      { connect: noConnect, io: t.io, now: NOW, fetchOpts: { transport } },
    );
    expect(rc).toBe(2);
    expect(transport.reqs).toEqual([]);
    expect(t.o.out.join('\n')).toContain('--fetch chưa bật');
  });

  it('fetch: robots TRƯỚC, tọa độ làm tròn, nhịp ≥1 s/host', async () => {
    const r = await fetchCli({
      [`${H}/robots.txt`]: ROBOTS_OK,
      [`${H}/v1/forecast`]: [200, {}, FORECAST],
    });
    expect(r.rc, r.out).toBe(0);
    expect(r.reqs.map((u) => u.pathname)).toEqual(['/robots.txt', '/v1/forecast', '/v1/forecast']);
    const reqs = r.out
      .split('\n')
      .filter((l) => l.startsWith('[req] '))
      .map((l) => JSON.parse(l.slice(6)));
    expect(reqs.length).toBe(3);
    for (const q of reqs.slice(1)) {
      const sp = new URL(q.url).searchParams;
      for (const k of ['latitude', 'longitude']) expect(sp.get(k)).toMatch(/^-?\d+(\.\d)?$/);
      expect(q.gap_s).toBeGreaterThanOrEqual(1.0);
    }
    expect(r.md()).toContain('mưa 80.5 mm');
    expect(r.md()).toContain('chưa nạp nhật ký');
    expect(r.out).toContain('[warn] chưa nạp nhật ký');
  });

  it('fetch: robots cấm → 0 GET dự báo, mọi vùng chưa có dự báo', async () => {
    const r = await fetchCli({
      [`${H}/robots.txt`]: [200, {}, 'User-agent: *\nDisallow: /v1/\n'],
      [`${H}/v1/forecast`]: [200, {}, FORECAST],
    });
    expect(r.rc).toBe(0);
    expect(r.reqs.map((u) => u.pathname)).toEqual(['/robots.txt']);
    expect(r.out.split('[robots-deny] ').length - 1).toBe(2);
    expect(r.md().split('chưa có dự báo').length - 1).toBe(2);
  });

  it.each([
    'https://shopee.vn/api?lat={lat}&lon={lon}&d={days}',
    'https://www.facebook.com/x?lat={lat}&lon={lon}&d={days}',
    'https://www.linkedin.com/x?lat={lat}&lon={lon}&d={days}',
  ])('fetch: host sàn/MXH %s → [blocked], 0 request, exit 0', async (tpl) => {
    const r = await fetchCli({}, { url_template: tpl });
    expect(r.rc).toBe(0);
    expect(r.reqs).toEqual([]);
    expect(r.out.split('[blocked] ').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('fetch: hết ngân sách + 5xx → vùng chưa có dự báo', async () => {
    const r = await fetchCli(
      { [`${H}/robots.txt`]: ROBOTS_OK, [`${H}/v1/forecast`]: [503, {}, ''] },
      {},
      { digest: true, fetch: true, maxRequests: '2' },
    );
    expect(r.rc).toBe(0);
    expect(r.reqs.length).toBe(2);
    expect(r.md().split('chưa có dự báo').length - 1).toBe(2);
    expect(r.out).toContain('hết ngân sách');
  });

  it('fetch: danh sách chặn tầng C không đọc được → exit 1, 0 request', async () => {
    const t = cap();
    const transport = mockTransport({});
    const rc = await vt.vtThoitietMain(
      { digest: true, fetch: true },
      {
        connect: noConnect,
        io: t.io,
        now: NOW,
        configFile: cfgFile({ enabled: true }),
        sourcesFile: join(TMP, 'khong-co-nguon.json'),
        fetchOpts: { transport },
      },
    );
    expect(rc).toBe(1);
    expect(transport.reqs).toEqual([]);
    expect(t.o.out.join('\n')).toContain('không đọc được danh sách chặn tầng C');
  });

  it('DB down: digest thời tiết vẫn ghi, --submit bỏ qua', async () => {
    const t = cap();
    const rd = mkdtempSync(join(TMP, 'r-'));
    const p = csv(['vung-a,2026-10-15,120,10,20']);
    expect(
      await vt.vtThoitietMain(
        { digest: true, fromCsv: p, submit: true },
        { connect: async () => null, io: t.io, now: NOW, reportsDir: rd },
      ),
    ).toBe(0);
    const out = t.o.out.join('\n');
    expect(out).toContain('[warn] chưa nạp nhật ký');
    expect(out).toContain('--submit bỏ qua');
    expect(readdirSync(rd)).toEqual(['vt-canh-bao-2026-10-14.md']);
  });

  it('--pests DB down → exit 2 (không coi là "không có cờ")', async () => {
    const t = cap();
    expect(
      await vt.vtThoitietMain(
        { pests: true, submit: true },
        { connect: async () => null, io: t.io, now: NOW },
      ),
    ).toBe(2);
    expect(t.o.out.join('\n')).toContain('không đọc được nhật ký');
  });

  it('--pests --submit khi farming-05.4 TẮT → [err] … (RolloutBlocked) exit 1 như Python', async () => {
    const db = {
      query: async () => ({
        rows: [
          { plot_id: 'KV-P1', ts: new Date('2026-10-13T02:00:00Z'), detail: 'phát hiện sâu bệnh' },
        ],
      }),
    } as unknown as Db;
    setOpsDeps({ rollout: opsRollout });
    settings.forceMode = 'tat';
    try {
      const t = cap();
      expect(
        await vt.vtThoitietMain(
          { pests: true, submit: true, date: '2026-10-14' },
          { connect: async () => ({ db, release: async () => {} }), io: t.io },
        ),
      ).toBe(1);
      expect(t.o.out.join('\n')).toContain('[err] không đẩy được hàng duyệt (RolloutBlocked)');
    } finally {
      settings.forceMode = null;
      installFakeDeps();
    }
  });

  it('cấu hình hỏng → [err] exit 1', async () => {
    const t = cap();
    expect(
      await vt.vtThoitietMain(
        { pests: true },
        { connect: noConnect, io: t.io, configFile: join(TMP, 'khong.json') },
      ),
    ).toBe(1);
    expect(t.o.out.join('\n')).toContain('[err] weather_config.json: không có file');
  });
});
