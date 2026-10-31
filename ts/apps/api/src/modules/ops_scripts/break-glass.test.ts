import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, loadBreakGlass } from '@samsam/core/ops/freeze';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { breakGlassMain } from './break-glass.js';

// Dịch tests/test_freeze.py phần break-glass (scripts/break_glass.py): cửa sổ hết hạn đúng biên, trần
// giờ (log sửa tay 48h bị cắt), đóng sớm, append-only, usage exit 2 không ghi, log bắt buộc + NGOÀI
// repo, dòng hỏng bị bỏ, che PII lý do, người giữ quyền, lịch hỏng exit 1, ký tự điều khiển không in.

const T = new Date('2027-01-05T09:00:00+07:00');
const OUT_FREEZE = new Date('2026-11-05T10:00:00+07:00');
const REASON = 'Sự cố webhook Zalo cần đổi cấu hình gấp';
const M = 60_000;
const H = 3600_000;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

const root = mkdtempSync(join(tmpdir(), 'ops-bg-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
let bglog: string;
let env: Record<string, string>;
let log: MockInstance<(...a: unknown[]) => void>;
const out = () => log.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  bglog = join(root, `t${n++}`, 'bg', 'break_glass.jsonl');
  env = { BREAK_GLASS_LOG: bglog };
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const open = (
  now = T,
  hours: string | undefined = '2',
  reason = REASON,
  by = 'Nguyễn Văn A',
  cal?: string,
) => breakGlassMain({ open: true, reason, by, hours }, now, env, cal);
const allowedAt = (now: Date) => check('feature', now, undefined, loadBreakGlass(bglog))[0];
const firstRec = () => JSON.parse(readFileSync(bglog, 'utf8').split('\n')[0] as string);

describe('mở / hết hạn / đóng', () => {
  it('cửa sổ hết hạn đúng biên; người giữ quyền chưa cấp → holder_verified=false', async () => {
    expect(await open()).toBe(0);
    expect(out()).toContain('BREAK-GLASS mở tới 11:00 05/01/2027 bởi Nguyễn Văn A');
    expect(out()).toContain('chưa được công ty cấp (external-dep)');
    const rec = firstRec();
    expect(rec.holder_verified).toBe(false);
    expect(rec.expires_at).toBe('2027-01-05T11:00:00+07:00');
    expect(Object.keys(rec)).toEqual([
      'action',
      'ts',
      'opened_at',
      'expires_at',
      'hours',
      'by',
      'reason',
      'holder_verified',
    ]);
    expect(allowedAt(T)).toBe(true);
    expect(allowedAt(at(T, H))).toBe(true);
    expect(allowedAt(at(T, 2 * H))).toBe(false); // biên
    expect(allowedAt(at(T, -1000))).toBe(false);
  });

  it('freeze.check đọc log từ BREAK_GLASS_LOG', async () => {
    expect(check('feature', at(T, 5 * M), undefined, undefined, env)[0]).toBe(false);
    expect(await open()).toBe(0);
    const [ok, why] = check('feature', at(T, 5 * M), undefined, undefined, env);
    expect(ok).toBe(true);
    expect(why).toContain('BREAK-GLASS');
    expect(why).toContain('Nguyễn Văn A');
  });

  it.for(['5', '0', '-1'])('--hours %s ngoài 1..4 → exit 2, không ghi', async (h) => {
    expect(await open(T, h)).toBe(2);
    expect(existsSync(bglog)).toBe(false);
  });

  it('log sửa tay 48h → bị cắt ở trần 4h', () => {
    mkdirSync(join(bglog, '..'), { recursive: true });
    const rec = {
      action: 'open',
      ts: '2027-01-05T09:00:00+07:00',
      opened_at: '2027-01-05T09:00:00+07:00',
      expires_at: '2027-01-07T09:00:00+07:00',
      hours: 48,
      by: 'X',
      reason: 'sửa tay log',
      holder_verified: false,
    };
    writeFileSync(bglog, `${JSON.stringify(rec)}\n`);
    expect(allowedAt(at(T, 3 * H))).toBe(true);
    expect(allowedAt(at(T, 4 * H))).toBe(false);
    expect(allowedAt(at(T, 5 * H))).toBe(false);
  });

  it('opened_at ở tương lai → chưa hiệu lực', async () => {
    expect(await open(at(T, H))).toBe(0);
    expect(allowedAt(at(T, 30 * M))).toBe(false);
  });

  it('đóng sớm: append-only; mở lại sau khi đóng có hiệu lực', async () => {
    expect(await open()).toBe(0);
    const before = readFileSync(bglog);
    expect(
      await breakGlassMain(
        { close: true, by: 'Nguyễn Văn A', reason: 'Đã xử lý xong sự cố webhook' },
        at(T, 30 * M),
        env,
      ),
    ).toBe(0);
    expect(readFileSync(bglog).subarray(0, before.length).equals(before)).toBe(true);
    expect(allowedAt(at(T, 29 * M))).toBe(true);
    expect(allowedAt(at(T, 31 * M))).toBe(false);
    expect(await open(at(T, H))).toBe(0);
    expect(allowedAt(at(T, H + M))).toBe(true);
  });

  it('đóng khi không có cửa sổ nào → không ghi', async () => {
    expect(await breakGlassMain({ close: true, by: 'A', reason: 'không có gì mở' }, T, env)).toBe(
      0,
    );
    expect(existsSync(bglog)).toBe(false);
    expect(out()).toContain('[info] không có cửa sổ break-glass nào còn hạn');
  });

  it('mở ngoài khung đóng băng → cảnh báo (vẫn mở)', async () => {
    expect(await open(OUT_FREEZE)).toBe(0);
    expect(out()).toContain('KHÔNG trong khung đóng băng');
  });

  it('append-only: 2 lần mở = 2 dòng, dòng cũ giữ nguyên byte', async () => {
    expect(await open()).toBe(0);
    const first = readFileSync(bglog);
    expect(await open(at(T, 5 * M))).toBe(0);
    const after = readFileSync(bglog);
    expect(after.subarray(0, first.length).equals(first)).toBe(true);
    expect(after.toString().split('\n')).toHaveLength(3);
  });
});

describe('usage / log / lịch', () => {
  const cases: Record<string, string | boolean>[] = [
    { open: true, by: 'A' },
    { open: true, by: 'A', reason: '123456789' },
    { open: true, by: 'A', reason: '   123456789   ' },
    { open: true, reason: REASON },
    { open: true, reason: REASON, by: '  ' },
    { open: true, reason: REASON, by: 'x'.repeat(81) },
    { open: true, reason: REASON, by: 'A\x1b[31m' },
    { open: true, status: true, reason: REASON, by: 'A' },
    { open: true, close: true, reason: REASON, by: 'A' },
    {},
    { status: true, hours: '2' },
    { close: true, by: 'A' },
    { open: true, reason: REASON, by: 'A', hours: 'hai' },
  ];
  it.for(cases.map((c, i) => [i, c] as const))(
    'ca %i → exit 2, file không đổi',
    async ([, argv]) => {
      expect(await open()).toBe(0);
      const before = readFileSync(bglog);
      expect(await breakGlassMain(argv, at(T, M), env)).toBe(2);
      expect(readFileSync(bglog).equals(before)).toBe(true);
    },
  );

  it.for(['', 'repo'])(
    'BREAK_GLASS_LOG "%s" → exit 2 (thiếu / trong repo), không tạo file',
    async (where) => {
      const target = join(REPO_ROOT, 'data', 'bg_test_should_not_exist.jsonl');
      const e = { BREAK_GLASS_LOG: where ? target : '' };
      expect(await breakGlassMain({ open: true, reason: REASON, by: 'A' }, T, e)).toBe(2);
      expect(await breakGlassMain({ status: true }, T, e)).toBe(2);
      expect(existsSync(target)).toBe(false);
    },
  );

  it('người giữ quyền có danh sách: --by không thuộc → exit 2; khớp (casefold + strip) → verified', async () => {
    const cal = JSON.parse(readFileSync(dataPath('freeze_calendar.json'), 'utf8'));
    cal.break_glass_holders = ['Tên A'];
    const p = join(root, `cal${n}.json`);
    writeFileSync(p, JSON.stringify(cal));
    expect(await open(T, '2', REASON, 'Tên B', p)).toBe(2);
    expect(existsSync(bglog)).toBe(false);
    expect(await open(T, '2', REASON, '  tên a ', p)).toBe(0);
    const rec = firstRec();
    expect(rec.holder_verified).toBe(true);
    expect(rec.by).toBe('tên a');
  });

  it('lịch đóng băng hỏng → exit 1, không ghi', async () => {
    expect(await open(T, '2', REASON, 'Nguyễn Văn A', join(root, 'missing.json'))).toBe(1);
    expect(existsSync(bglog)).toBe(false);
    expect(out()).toContain('[err] lịch đóng băng lỗi');
  });
});

describe('đọc log + in an toàn', () => {
  it('dòng hỏng bị bỏ (đếm đúng dòng); U+2028 không in thô; append sau dòng ghi dở nằm trên dòng riêng', async () => {
    mkdirSync(join(bglog, '..'), { recursive: true });
    const reason = 'dòng có ký tự lạ';
    const good = {
      action: 'open',
      ts: '2027-01-05T09:00:00+07:00',
      opened_at: '2027-01-05T09:00:00+07:00',
      expires_at: '2027-01-05T10:00:00+07:00',
      hours: 1,
      by: 'B',
      reason,
      holder_verified: false,
    };
    const naive = { ...good, opened_at: '2027-01-05T09:00:00' };
    const { by: _by, ...noBy } = good;
    const body = Buffer.concat([
      Buffer.from('{not json\n'),
      Buffer.from(`${JSON.stringify(good)}\n`),
      Buffer.from(`${JSON.stringify(naive)}\n`),
      Buffer.from(`${JSON.stringify(noBy)}\n`),
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x0a]),
      Buffer.from('{"action": "close", "ts": "2027-01-05T09:1'),
    ]);
    writeFileSync(bglog, body);
    const bad: number[] = [];
    const recs = loadBreakGlass(bglog, bad);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.reason).toBe(reason);
    expect(bad).toEqual([1, 3, 4, 5, 6]);
    expect(allowedAt(at(T, 10 * M))).toBe(true);
    log.mockClear();
    expect(await breakGlassMain({ status: true }, at(T, 10 * M), env)).toBe(0);
    expect(out()).not.toContain(' ');
    expect(out()).toContain('dòng?có ký tự lạ');
    expect(out()).toContain('[warn] bỏ qua 5 dòng log hỏng: dòng 1, 3, 4, 5, 6');
    expect(await open(at(T, 2 * H))).toBe(0);
    expect(readFileSync(bglog).subarray(0, body.length).equals(body)).toBe(true);
    expect(loadBreakGlass(bglog)).toHaveLength(2);
  });

  it('lý do che SĐT trước khi ghi', async () => {
    expect(await open(T, '2', 'Khách 0905 123 456 báo lỗi đơn hàng gấp')).toBe(0);
    const body = readFileSync(bglog, 'utf8');
    expect(body).not.toContain('0905123456');
    expect(body).not.toContain('0905 123 456');
  });

  it('--status liệt kê cửa sổ còn hạn', async () => {
    expect(await open()).toBe(0);
    log.mockClear();
    expect(await breakGlassMain({ status: true }, at(T, 10 * M), env)).toBe(0);
    expect(out()).toContain('ĐANG đóng băng');
    expect(out()).toContain('1 cửa sổ');
    expect(out()).toContain('Nguyễn Văn A');
    expect(out()).toContain('11:00 05/01/2027');
    log.mockClear();
    expect(await breakGlassMain({ status: true }, at(T, 2 * H), env)).toBe(0);
    expect(out()).toContain('0 cửa sổ');
  });

  it('log sửa tay: `by` có ANSI → bỏ record; reason có ký tự điều khiển → in đã thay ?', async () => {
    mkdirSync(join(bglog, '..'), { recursive: true });
    const base = {
      action: 'open',
      ts: '2027-01-05T09:00:00+07:00',
      opened_at: '2027-01-05T09:00:00+07:00',
      expires_at: '2027-01-05T10:00:00+07:00',
      hours: 1,
      holder_verified: false,
    };
    writeFileSync(
      bglog,
      `${JSON.stringify({ ...base, by: 'X\x1b[2J', reason: 'abcdefghijk' })}\n${JSON.stringify({ ...base, by: 'Y', reason: 'lý do\x1b[2Jxoá màn hình' })}\n`,
    );
    expect(loadBreakGlass(bglog).map((r) => r.by)).toEqual(['Y']);
    expect(await breakGlassMain({ status: true }, at(T, M), env)).toBe(0);
    expect(out()).not.toContain('\x1b');
    expect(out()).toContain('lý do?[2Jxoá màn hình');
  });
});
