import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import { createPool } from '@samsam/core/db';
import { generateFernetKey } from '@samsam/core/fernet';
import { readJson } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { loadVaultKey, unseal, type VaultKeys } from '@samsam/core/security/fernet';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gold from './__fixtures__/b2b_form.golden.json' with { type: 'json' };
import * as bf from './b2b-form.service.js';
import { b2bFormMain } from './channels.command.js';

// Dịch tests/test_b2b_form.py: parseForm THUẦN (golden), RateLimiter đồng hồ tiêm, server cổng 0 —
// request bị từ chối sớm dùng raw socket; DB thật: DB riêng samsam_ts_channels, khóa Fernet sinh
// trong test. Người/SĐT/email là GIẢ LẬP.

const DAY = '2026-10-12';
const H1 = 'mat-ong-sam-120ml-1hu';
const ALLOWED = new Map([
  [H1, 'Mật ong sâm 120ml (1 hũ)'],
  ['mat-ong-sam-300ml', 'Mật ong'],
]);
const PHONE = '0901234567';
const CNAME = 'Nguoi Lien He Mau';
const EMAIL = 'lienhe.mau@example.com';
const BASE: Record<string, string> = {
  org_name: 'Công ty MẪU B2B',
  org_type: 'doanh_nghiep',
  region: 'Đà Nẵng',
  contact_name: CNAME,
  phone: PHONE,
  email: EMAIL,
  sku1: H1,
  qty1: '20',
  need_by: '2026-12-20',
  consent: 'b2b',
  policy_version: bf.POLICY_VERSION,
  website: '',
};
const body = (kw: Record<string, string | null> = {}) => {
  const d = { ...BASE, ...kw };
  return new URLSearchParams(
    Object.entries(d).filter((e): e is [string, string] => e[1] !== null),
  ).toString();
};
const newKeys = (): VaultKeys => loadVaultKey({ CONTACT_VAULT_KEY: generateFernetKey() });

// ------------------------------------------------------------ golden (hàm Python thật)

describe('golden', () => {
  const allowed = new Set(Object.keys(gold.allowed));
  it('parseForm mọi ca', () => {
    for (const [name, c] of Object.entries(gold.parse_form)) {
      const [f, code] = bf.parseForm(Buffer.from(c.body, 'latin1'), allowed, gold.day);
      expect([name, f, code]).toEqual([name, c.form, c.code]);
    }
  });
  it('requestKey / norm / provinceOf', () => {
    for (const [name, [k1, k2]] of Object.entries(gold.request_key) as [string, string[]][]) {
      const body0 =
        name === 'ok-chuan-hoa'
          ? Buffer.from(body({ org_name: 'CÔNG TY  mẫu-b2b' }))
          : Buffer.from(gold.parse_form[name as keyof typeof gold.parse_form].body, 'latin1');
      const [f] = bf.parseForm(body0, allowed, DAY);
      expect([
        name,
        bf.requestKey(f as bf.Form, DAY),
        bf.requestKey(f as bf.Form, '2026-10-13'),
      ]).toEqual([name, k1, k2]);
    }
    expect(
      bf.requestKey(
        {
          org_name: 'Á',
          region: 'Huế',
          items: [
            { key: 'é\u007f', qty: 3 },
            { key: 'a', qty: 1 },
          ],
        },
        DAY,
      ),
    ).toBe(gold.request_key_raw['unicode-key']);
    for (const [s, want] of gold.norm) expect([s, bf.norm(s)]).toEqual([s, want]);
    for (const [t, want] of gold.province_of) expect([t, bf.provinceOf(t)]).toEqual([t, want]);
  });
  it('eligible / options / renderPage (cùng tập catalog)', () => {
    const [golden] = bf.readGolden();
    const combos = (readJson(dataPath('sample_bom.json')) as { combos: unknown }).combos;
    const [items, excluded] = bf.eligible(golden, combos);
    expect({ items, excluded }).toEqual(gold.eligible_real);
    const syn = gold.eligible_synthetic;
    const [si, se] = bf.eligible(syn.golden, syn.combos);
    expect({ items: si, excluded: se }).toEqual({ items: syn.items, excluded: syn.excluded });
    const opts = bf.options(golden, combos);
    expect(opts).toEqual(gold.options_real);
    expect(opts.map(([k]) => k)).toEqual([
      'mat-ong-sam-120ml-1hu',
      'mat-ong-sam-120ml-2hu',
      'mat-ong-sam-300ml',
    ]);
    const tpl = '<select><!--OPTIONS--></select><select><!--OPTIONS--></select>';
    expect(bf.renderPage([...opts, ['x"><b', "<script>alert('1')&</script>"]], tpl)).toBe(
      gold.render_page,
    );
    const real = bf.renderPage(opts);
    expect(createHash('sha256').update(real, 'utf8').digest('hex')).toBe(gold.render_page_real_sha);
    expect(isAlcohol(real)).toBe(false);
    expect(bf.PAGE_OK).toBe(gold.page_ok);
    expect(bf.pageErr('{x}')).toBe(gold.page_err.replace('{msg}', '{x}'));
    expect(Object.fromEntries(Object.entries(bf.MSG).map(([k, v]) => [k, v]))).toEqual(gold.msg);
  });
});

describe('thuần', () => {
  it('ORG_TYPES khớp form HTML; form không script/link ngoài; honeypot ẩn', () => {
    const html = readFileSync(bf.FORM_FILE, 'utf8');
    expect(new Set([...html.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]))).toEqual(
      new Set(bf.ORG_TYPES),
    );
    expect(html.split('<!--OPTIONS-->').length - 1).toBe(10);
    expect(html).toContain(`value="${bf.POLICY_VERSION}"`);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toMatch(/(src|href)="(https?:|\/\/)/i);
    expect(html).toContain('name="website"');
    expect(html).toContain('hidden');
  });

  it('requestKey ổn định + chuẩn hóa', () => {
    const allowed = new Set(ALLOWED.keys());
    const [f] = bf.parseForm(Buffer.from(body()), allowed, DAY);
    const k = bf.requestKey(f as bf.Form, DAY);
    expect(k).toMatch(/^b2r:[0-9a-f]{64}$/);
    const [g] = bf.parseForm(Buffer.from(body({ org_name: 'CÔNG TY  mẫu-b2b' })), allowed, DAY);
    expect(bf.requestKey(g as bf.Form, DAY)).toBe(k);
    expect(bf.requestKey(f as bf.Form, '2026-10-13')).not.toBe(k);
  });

  it('RateLimiter đồng hồ giả: 5/IP, trần toàn server, hết cửa sổ, khóa băm', () => {
    let t = 0;
    const rl = new bf.RateLimiter(5, 7, 3600, () => t);
    for (let i = 0; i < 5; i++) expect(rl.allow('1.2.3.4')).toBe(true);
    expect(rl.allow('1.2.3.4')).toBe(false); // lượt 6 cùng IP
    expect(rl.allow('5.6.7.8')).toBe(true);
    expect(rl.allow('9.9.9.9')).toBe(true); // 7 = trần global
    expect(rl.allow('8.8.8.8')).toBe(false);
    t = 3600.5; // hết cửa sổ
    expect(rl.allow('1.2.3.4') && rl.allow('8.8.8.8')).toBe(true);
    expect([...rl.ip.keys()].every((k) => k.length === 16)).toBe(true);
    expect(rl.ip.has('1.2.3.4')).toBe(false);
  });

  it('iphash có muối, không phải sha256 trần', () => {
    const h = bf.iphash('1.2.3.4');
    expect(h).toBe(bf.iphash('1.2.3.4'));
    expect(h).not.toBe(bf.iphash('1.2.3.5'));
    expect(h).not.toBe(createHash('sha256').update('1.2.3.4').digest('hex').slice(0, 16));
    expect(bf.IP_SALT.length).toBe(16);
  });
});

// ------------------------------------------------------------ server

type Srv = {
  srv: http.Server;
  port: number;
  out: string[];
  err: string[];
  calls: bf.Form[];
  close: () => Promise<void>;
};

async function start(o: Partial<bf.ServerOpts> = {}): Promise<Srv> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: bf.Form[] = [];
  const srv = bf.makeServer({
    page: bf.renderPage([...ALLOWED]),
    allowed: ALLOWED.keys(),
    keys: null,
    connect: async () => null,
    today: () => DAY,
    log: { out: (s) => out.push(s), err: (s) => err.push(s) },
    ...o,
    intake:
      o.intake &&
      (async (...a) => {
        calls.push(a[1]);
        return (o.intake as bf.IntakeFn)(...a);
      }),
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    srv,
    port,
    out,
    err,
    calls,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

const stubDb = { db: {} as never, release: async () => {} };
let s: Srv | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

async function req(method: string, path = '/b2b', b?: string, ctype = bf.FORM_CT) {
  const res = await fetch(`http://127.0.0.1:${s?.port}${path}`, {
    method,
    body: b,
    headers: b === undefined ? {} : { 'Content-Type': ctype },
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/** Gửi byte thô, đọc tới hết header phản hồi (hoặc server đóng). */
function raw(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sk = net.connect(s?.port as number, '127.0.0.1');
    let buf = '';
    sk.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sk.destroy();
        resolve(buf);
      }
    });
    sk.on('close', () => resolve(buf));
    sk.on('error', reject);
    sk.write(data, 'latin1');
  });
}
const status = (resp: string) => Number(resp.split(' ', 2)[1]);

/** POST bị từ chối TRƯỚC khi đọc body: CHỈ gửi header. */
const early = (path = '/b2b', ctype = bf.FORM_CT) =>
  raw(
    `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: ${ctype}\r\nContent-Length: ${Buffer.byteLength(body())}\r\n\r\n`,
  ).then(status);

const okIntake: bf.IntakeFn = async () => [41n, true];

describe('server (intake giả)', () => {
  it('GET /b2b: trang không rượu, đã thay OPTIONS, header an toàn; đường khác 404', async () => {
    s = await start({ intake: okIntake, connect: async () => stubDb });
    const r = await req('GET');
    expect(r.status).toBe(200);
    expect(r.body).toContain('value="mat-ong-sam-120ml-1hu"');
    expect(isAlcohol(r.body) || r.body.toLowerCase().includes('rượu')).toBe(false);
    expect(r.body).not.toContain('<!--OPTIONS-->');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await req('GET', '/khac')).status).toBe(404);
  });

  it('POST > 8 KB → 413 KHÔNG đọc body; chunked / thiếu Content-Length → 411', async () => {
    s = await start({ intake: okIntake, connect: async () => stubDb });
    let resp = await raw(
      'POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 9002\r\n\r\n',
    );
    expect(status(resp)).toBe(413);
    resp = await raw(
      'POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n',
    );
    expect(status(resp)).toBe(411);
    resp = await raw(
      'POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n',
    );
    expect(status(resp)).toBe(411);
    expect(s.calls).toEqual([]);
  });

  it('Content-Type sai → 415; 5 lượt OK rồi 429 (trước khi đọc body)', async () => {
    s = await start({ intake: okIntake, connect: async () => stubDb });
    expect(await early('/b2b', 'text/plain')).toBe(415);
    expect(s.calls).toEqual([]);
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', '/b2b', body());
      expect([i, r.status, r.body === bf.PAGE_OK, r.body.includes('YC-')]).toEqual([
        i,
        200,
        true,
        false,
      ]);
    }
    expect(await early()).toBe(429);
    expect(s.calls.length).toBe(5);
    expect(s.out.filter((l) => /^\[b2b_form\] 200 ip=[0-9a-f]{8} yc=41$/.test(l)).length).toBe(5);
  });

  it('đầu vào sai → 400 trang chung (không echo input); đường khác → 404', async () => {
    s = await start({ intake: okIntake, connect: async () => stubDb });
    const r = await req('POST', '/b2b', body({ org_name: 'Công ty <b>BIMAT</b>', phone: '12' }));
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('BIMAT');
    expect(s.calls).toEqual([]);
    expect(await early('/khac')).toBe(404);
  });

  it('honeypot → 200 trang chung, 0 intake', async () => {
    s = await start({ intake: okIntake, connect: async () => stubDb });
    const r = await req('POST', '/b2b', body({ website: 'x' }));
    expect([r.status, r.body]).toEqual([200, bf.PAGE_OK]);
    expect(s.calls).toEqual([]);
  });

  it('DB down → 503, không intake; lỗi DB/vault trong intake → 503; RangeError → 400', async () => {
    const never = vi.fn();
    s = await start({ intake: never as never, connect: async () => null });
    expect((await req('POST', '/b2b', body())).status).toBe(503);
    expect(never).not.toHaveBeenCalled();
    await s.close();
    s = await start({
      intake: async () => {
        throw Object.assign(new pg.DatabaseError('down', 0, 'error'), { code: '57P01' });
      },
      connect: async () => stubDb,
    });
    expect((await req('POST', '/b2b', body())).status).toBe(503);
    await s.close();
    s = await start({
      intake: async () => {
        throw new RangeError('người thực hiện không hợp lệ');
      },
      connect: async () => stubDb,
    });
    expect((await req('POST', '/b2b', body())).status).toBe(400);
  });

  it('lỗi bất ngờ trong intake → đóng kết nối, log chỉ hash IP + tên lớp lỗi', async () => {
    class RuntimeError extends Error {}
    s = await start({
      intake: async () => {
        throw new RuntimeError('bất ngờ 0901234567');
      },
      connect: async () => stubDb,
    });
    await expect(req('POST', '/b2b', body())).rejects.toThrow();
    await vi.waitFor(() => expect(s?.err.length).toBeGreaterThan(0));
    const e = s.err.join('\n');
    expect(e).toMatch(/\[b2b_form\] lỗi kết nối ip=[0-9a-f]{8} RuntimeError/);
    expect(e).not.toMatch(/127\.0\.0\.1|0901234567|Traceback|at /);
  });

  it('client RST giữa body → log không IP thô, không intake', async () => {
    const never = vi.fn();
    s = await start({ intake: never as never, connect: async () => stubDb });
    const sk = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((r) => sk.once('connect', () => r()));
    sk.write(
      'POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 500\r\n\r\norg_name=abc',
    );
    await new Promise((r) => setTimeout(r, 50)); // để server nhận header trước khi RST
    sk.resetAndDestroy();
    await vi.waitFor(() => expect(s?.err.length).toBeGreaterThan(0));
    const e = s.err.join('\n');
    expect(e).toMatch(/\[b2b_form\] lỗi kết nối ip=[0-9a-f]{8} Connection\w*Error/);
    expect(e).not.toContain('127.0.0.1');
    expect(never).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ main

describe('b2bFormMain', () => {
  const run = (env: Record<string, string>, extra: Parameters<typeof b2bFormMain>[0] = {}) => {
    const err: string[] = [];
    const bind = vi.fn();
    const connect = vi.fn(async () => null);
    return b2bFormMain({
      env,
      makeServer: bind as never,
      connect,
      io: { out: () => {}, err: (x) => err.push(x) },
      ...extra,
    }).then((rc) => ({ rc, err: err.join('\n'), bind, connect }));
  };
  const KEY = generateFernetKey();

  it('mặc định TẮT → exit 2, không bind', async () => {
    let r = await run({});
    expect(r.rc).toBe(2);
    expect(r.err).toContain('mặc định TẮT');
    expect(r.bind).not.toHaveBeenCalled();
    r = await run({ B2B_FORM_ENABLED: '0' });
    expect(r.rc).toBe(2);
  });

  it('thiếu khóa vault → exit 2 trước connect/bind', async () => {
    const r = await run({ B2B_FORM_ENABLED: '1' });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('CONTACT_VAULT_KEY');
    expect(r.connect).not.toHaveBeenCalled();
    expect(r.bind).not.toHaveBeenCalled();
  });

  it('cổng sai → exit 2; DB down → exit 2; không bind', async () => {
    let r = await run({ B2B_FORM_ENABLED: 'yes', CONTACT_VAULT_KEY: KEY, B2B_FORM_PORT: '99999' });
    expect([r.rc, r.connect.mock.calls.length, r.bind.mock.calls.length]).toEqual([2, 0, 0]);
    r = await run({ B2B_FORM_ENABLED: 'true', CONTACT_VAULT_KEY: KEY });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('không kết nối được Postgres');
    expect(r.bind).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ DB thật

const DB_NAME = 'samsam_ts_channels';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('DB thật', () => {
  let pool: pg.Pool;
  let keys: VaultKeys;
  const lease = () => async () => ({ db: pool, release: async () => {} });
  beforeEach(async () => {
    await dropDb(DB_NAME);
    pool = createPool(await createDbFromTemplate(DB_NAME));
    keys = newKeys();
  });
  afterEach(async () => {
    await pool?.end();
    await dropDb(DB_NAME);
  });
  const counts = async () => {
    const o: Record<string, number> = {};
    for (const t of ['contacts', 'consents', 'b2b_requests']) {
      o[t] = Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n);
    }
    return o;
  };
  const contact = async () => {
    const [cid] = await bf.addContact(
      pool,
      { phone: PHONE, name: CNAME, source: 'test' },
      keys,
      'test',
    );
    const con = await bf.recordConsent(pool, cid, 'b2b', true, 'web', 'test', 'B2BF-test', 'v0');
    return [cid, con] as const;
  };
  const canContact = async (cid: bigint) =>
    (
      await pool.query(
        "select granted from v_consent_current where contact_id = $1 and purpose = 'b2b' and coalesce(recipient_dealer, '') = ''",
        [String(cid)],
      )
    ).rows[0]?.granted === true;
  const INS =
    'insert into b2b_requests (request_key, org_name, org_type, region, items, contact_id, consent_id, source)' +
    " values ($1, $2, $3, $4, $5::jsonb, $6, $7, 'test') returning id";

  it('schema b2b_requests (CHECK, insert-only, không cột PII) + consent mục đích b2b', async () => {
    const [cid, con] = await contact();
    const ok = [
      `b2r:${'a'.repeat(64)}`,
      'Công ty MẪU',
      'doanh_nghiep',
      'Đà Nẵng',
      '[{"key": "x", "qty": 1}]',
      String(cid),
      String(con),
    ];
    const rid = (await pool.query(INS, ok)).rows[0].id;
    const elevn = `[${Array(11).fill('{"key": "x", "qty": 1}').join(',')}]`;
    for (const bad of [
      ['b2r:xyz', ...ok.slice(1)],
      [`b2r:${'b'.repeat(64)}`, 'Công ty', 'ca_nhan', ...ok.slice(3)],
      [`b2r:${'c'.repeat(64)}`, ...ok.slice(1, 4), '{}', ...ok.slice(5)],
      [`b2r:${'d'.repeat(64)}`, ...ok.slice(1, 4), elevn, ...ok.slice(5)],
      [`b2r:${'e'.repeat(64)}`, ...ok.slice(1, 4), '[]', ...ok.slice(5)],
      [`b2r:${'f'.repeat(64)}`, ' Q ', ...ok.slice(2)],
      [`b2r:${'1'.repeat(64)}`, ...ok.slice(1, 5), '999999999', String(con)],
      ok, // trùng request_key
    ]) {
      await expect(pool.query(INS, bad)).rejects.toThrow();
    }
    await expect(
      pool.query("update b2b_requests set org_name = 'X' where id = $1", [rid]),
    ).rejects.toThrow();
    await expect(pool.query('delete from b2b_requests where id = $1', [rid])).rejects.toThrow();
    await expect(pool.query('truncate b2b_requests')).rejects.toThrow();
    await expect(
      pool.query(
        "insert into consents (contact_id, purpose, granted, source, recorded_by) values ($1, 'xyz', false, 'web', 't')",
        [String(cid)],
      ),
    ).rejects.toThrow();
    await pool.query(
      "insert into consents (contact_id, purpose, granted, source, recorded_by) values ($1, 'b2b', false, 'web', 't')",
      [String(cid)],
    );
    const defn = (
      await pool.query(
        "select pg_get_constraintdef(c.oid) as d from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace where c.conname = 'consents_purpose_check' and n.nspname = current_schema()",
      )
    ).rows[0].d;
    expect(defn).toContain("'b2b'");
    expect(defn).toContain("'dai_ly'");
    const cols = (
      await pool.query(
        "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'b2b_requests'",
      )
    ).rows.map((r) => r.column_name as string);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => /phone|email|name_|contact_name|address/.test(c))).toEqual([]);
  });

  it('intake qua server: vault + consent b2b, không PII ngoài ciphertext, gửi lại = 0 ghi', async () => {
    s = await start({ keys, connect: lease() });
    const r = await req('POST', '/b2b', body());
    expect([r.status, r.body]).toEqual([200, bf.PAGE_OK]);
    const n = await counts();
    expect(n).toEqual({ contacts: 1, consents: 1, b2b_requests: 1 });
    const r2 = await req('POST', '/b2b', body()); // gửi lại y hệt → 0 dòng mới, cùng mã
    expect([r2.status, r2.body]).toEqual([200, r.body]);
    expect(await counts()).toEqual(n);
    expect((await req('POST', '/b2b', body({ website: 'x', org_name: 'Khác' }))).status).toBe(200);
    expect((await counts()).b2b_requests).toBe(1);
    const c = (await pool.query('select phone_enc, name_enc, email_enc, source from contacts'))
      .rows[0];
    expect(c.phone_enc.startsWith('gAAAAA')).toBe(true);
    expect(c.source).toBe('b2b_form');
    expect([
      unseal(keys.fernet, c.phone_enc),
      unseal(keys.fernet, c.email_enc),
      unseal(keys.fernet, c.name_enc),
    ]).toEqual([PHONE, EMAIL, CNAME]);
    const cs = (
      await pool.query(
        'select purpose, granted, source, policy_version, evidence_ref from consents',
      )
    ).rows[0];
    expect([cs.purpose, cs.granted, cs.source, cs.policy_version]).toEqual([
      'b2b',
      true,
      'web',
      bf.POLICY_VERSION,
    ]);
    expect(cs.evidence_ref.startsWith('B2BF-')).toBe(true);
    expect(cs.evidence_ref.slice(5)).not.toMatch(/\d{3}/);
    let blob = '';
    for (const t of ['contacts', 'consents', 'b2b_requests', 'agent_action_log']) {
      blob += JSON.stringify((await pool.query(`select * from ${t}`)).rows);
    }
    for (const x of [PHONE, CNAME, EMAIL, 'lienhe.mau']) expect(blob).not.toContain(x);
    const logs = [...s.out, ...s.err].join('\n');
    for (const x of [PHONE, CNAME, EMAIL, '127.0.0.1']) expect(logs).not.toContain(x);
    const ycs = s.out
      .map((l) => /^\[b2b_form\] 200 ip=[0-9a-f]{8} yc=(\d+)$/.exec(l)?.[1])
      .filter(Boolean);
    expect(ycs.length).toBe(2);
    expect(ycs[0]).toBe(ycs[1]);
    const rq = (
      await pool.query(
        'select org_name, region, items, need_by::text as need_by, contact_id is not null as has_c from b2b_requests',
      )
    ).rows[0];
    expect(rq).toEqual({
      org_name: 'Công ty MẪU B2B',
      region: 'Đà Nẵng',
      items: [{ key: H1, qty: 20 }],
      need_by: '2026-12-20',
      has_c: true,
    });
  });

  it('lỗi insert (CHECK DB) → rollback cả contact + consent', async () => {
    const [f] = bf.parseForm(Buffer.from(body()), new Set(ALLOWED.keys()), DAY);
    const form = { ...(f as bf.Form), org_type: 'ca_nhan' }; // vượt parseForm → CHECK DB chặn
    await expect(bf.intake(pool, form, keys, DAY)).rejects.toBeInstanceOf(pg.DatabaseError);
    expect(await counts()).toEqual({ contacts: 0, consents: 0, b2b_requests: 0 });
  });

  it('SĐT của contact đã RÚT đồng ý b2b → không lật lại, 0 ghi, body y hệt POST hợp lệ', async () => {
    const [cid] = await contact();
    await bf.recordConsent(pool, cid, 'b2b', false, 'web', 'test');
    expect(await canContact(cid)).toBe(false);
    const before = await counts();
    s = await start({ keys, connect: lease() });
    const r = await req('POST', '/b2b', body());
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('YC-');
    expect(await canContact(cid)).toBe(false);
    expect(await counts()).toEqual(before);
    expect(s.out.some((l) => /^\[b2b_form\] 200 ip=[0-9a-f]{8} yc=-$/.test(l))).toBe(true);
    const ok = await req('POST', '/b2b', body({ phone: '0912000111', org_name: 'Cty Khac' }));
    expect([ok.status, ok.body]).toEqual([200, r.body]);
    expect(ok.body).toBe(bf.PAGE_OK);
    expect((await counts()).b2b_requests).toBe(before.b2b_requests + 1); // thật sự đã nhận
    const logs = [...s.out, ...s.err].join('\n');
    for (const x of [PHONE, CNAME, EMAIL, '127.0.0.1']) expect(logs).not.toContain(x);
  });

  it('contact đã có + b2b granted → yêu cầu vẫn nhận', async () => {
    const [cid] = await contact();
    const [f] = bf.parseForm(Buffer.from(body()), new Set(ALLOWED.keys()), DAY);
    const [rid, isNew] = await bf.intake(pool, f as bf.Form, keys, DAY);
    expect(isNew).toBe(true);
    expect(rid).not.toBeNull();
    expect(await canContact(cid)).toBe(true);
    const row = (
      await pool.query('select contact_id from b2b_requests where id = $1', [String(rid)])
    ).rows[0];
    expect(BigInt(row.contact_id)).toBe(cid);
  });
});
