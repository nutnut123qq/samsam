import { describe, expect, it } from 'vitest';
import { countsSummary, fmtUtcMinute, newChatSession, safeHref } from './format';

// Định dạng hiển thị (port phần render Streamlit). Giá trị Python tham chiếu:
// `datetime(2026,10,20,10,4,59,tzinfo=+07:00).astimezone(utc).strftime("%Y-%m-%d %H:%M")` = "2026-10-20 03:04";
// `sorted({"zalo":3,"Zalo":1,"ánh":2,"b":0}.items())` → Zalo, b, zalo, ánh (code point).

describe('fmtUtcMinute', () => {
  it('ISO (mọi múi) → UTC "YYYY-MM-DD HH:MM"; không đọc được → ""', () => {
    expect(fmtUtcMinute('2026-10-20T10:04:59+07:00')).toBe('2026-10-20 03:04');
    expect(fmtUtcMinute('2026-10-20T03:04:59.000Z')).toBe('2026-10-20 03:04');
    for (const bad of ['', 'x', null, 5, undefined]) expect(fmtUtcMinute(bad)).toBe('');
  });
});

describe('countsSummary', () => {
  it('k=v nối "; " theo code point (Python sorted); rỗng → "—"', () => {
    expect(countsSummary({ zalo: 3, Zalo: 1, ánh: 2, b: 0 })).toBe('Zalo=1; b=0; zalo=3; ánh=2');
    // U+1F600 (cặp thay thế) sau U+FF5E theo code point (UTF-16 thì ngược lại)
    expect(countsSummary({ '\u{1F600}': 1, '～': 2 })).toBe('～=2; \u{1F600}=1');
    expect(countsSummary({})).toBe('—');
    expect(countsSummary(null)).toBe('—');
  });
});

describe('safeHref', () => {
  it('chỉ http(s) tuyệt đối thành link; javascript:/data:/tương đối → null (hiện chữ)', () => {
    expect(safeHref('https://samsam.net.vn/a?b=1')).toBe('https://samsam.net.vn/a?b=1');
    expect(safeHref('http://samsamngoclinh.com')).toBe('http://samsamngoclinh.com/');
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,x',
      '/tuong-doi',
      'samsam.net.vn',
      'ftp://x',
      '',
      null,
      42,
    ]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});

describe('newChatSession', () => {
  it('8 ký tự hex (như uuid4().hex[:8])', () => {
    expect(newChatSession(() => new Uint8Array([0x0a, 0x1b, 0x2c, 0x3d]))).toBe('0a1b2c3d');
    expect(newChatSession()).toMatch(/^[0-9a-f]{8}$/);
  });
});
