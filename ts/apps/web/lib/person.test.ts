import { describe, expect, it } from 'vitest';
import type { ApiResult } from './api';
import { field, type Outcome, outcomeNotes } from './outcome';
import { idOk, PERSON_HEADER, personCookie, withPerson } from './person';

// Logic web tab Báo cáo / Nhật ký vườn / Duyệt & Lịch: gắn mã phiên người vào header (giữ header
// Authorization của lib/api), cookie phiên httpOnly + strict, mã đối tượng chỉ chữ số trong đường
// dẫn REST, kết quả thao tác → thông báo theo thứ tự Streamlit (cảnh báo trước).

describe('withPerson', () => {
  it('thêm x-person-session, giữ header sẵn có; không có mã → fetch nguyên bản', async () => {
    const seen: Headers[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}');
    }) as typeof fetch;
    await withPerson('h1', f)('http://api/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    expect([
      seen[0]?.get(PERSON_HEADER),
      seen[0]?.get('authorization'),
      seen[0]?.get('content-type'),
    ]).toEqual(['h1', 'Bearer t', 'application/json']);
    expect(withPerson(null, f)).toBe(f);
    expect(withPerson('', f)).toBe(f);
  });
});

describe('personCookie / idOk', () => {
  it('cookie httpOnly, strict, 30 phút; secure khi production', () => {
    expect(personCookie({ NODE_ENV: 'production' })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 1800,
    });
    expect(personCookie({}).secure).toBe(false);
  });

  it('id chỉ chữ số (không chèn đường dẫn)', () => {
    expect(['1', '123456789012345678'].map(idOk)).toEqual([true, true]);
    expect(['', '1/../x', '1?x', '-1', '1234567890123456789', 5, null].map(idOk)).toEqual(
      Array(7).fill(false),
    );
  });
});

describe('outcomeNotes / field', () => {
  const ok = (data: Outcome): ApiResult<Outcome> => ({ ok: true, data });
  it('cảnh báo trước, rồi thành công/thất bại; lỗi HTTP → error', () => {
    expect(outcomeNotes(ok({ ok: true, message: 'Mục #1 → approved' }))).toEqual([
      ['success', 'Mục #1 → approved'],
    ]);
    expect(
      outcomeNotes(
        ok({ ok: false, message: 'Không ghi được — xem cảnh báo.', warnings: ['a', 'b'] }),
        'error',
      ),
    ).toEqual([
      ['warning', 'a'],
      ['warning', 'b'],
      ['error', 'Không ghi được — xem cảnh báo.'],
    ]);
    expect(outcomeNotes(ok({ ok: false, message: 'chưa mở' }))).toEqual([['warning', 'chưa mở']]);
    expect(outcomeNotes({ ok: false, status: 403, message: 'Guardrail vi phạm' })).toEqual([
      ['error', 'Guardrail vi phạm'],
    ]);
  });

  it('field: thiếu/tệp → chuỗi rỗng', () => {
    const f = new FormData();
    f.set('a', 'x');
    f.set('file', new Blob(['1']));
    expect([field(f, 'a'), field(f, 'file'), field(f, 'none')]).toEqual(['x', '', '']);
  });
});
