import { ROLE_TABS, TABS, tabsFor } from '@samsam/core/security/auth';
import { describe, expect, it } from 'vitest';
import { homeFor, navFor, safeNext, TAB_ROUTES } from './tabs';

// Điều hướng web = tab của core (`auth.TABS`/`tabsFor`, port `pipelines/auth.py` ROLE_TABS) — web
// chỉ gán đường dẫn; quyền thật do API kiểm.

describe('TAB_ROUTES / navFor / homeFor', () => {
  it('đủ 7 tab đúng thứ tự core, đường dẫn không trùng', () => {
    expect(TAB_ROUTES.map((r) => r.tab)).toEqual([...TABS]);
    expect(new Set(TAB_ROUTES.map((r) => r.href)).size).toBe(TABS.length);
  });

  it('mỗi vai trò: điều hướng = đúng tab được cấp (thứ tự chuẩn); vai trò lạ/null → không tab', () => {
    for (const role of Object.keys(ROLE_TABS)) {
      const tabs = tabsFor(role);
      expect(navFor(tabs).map((r) => r.tab)).toEqual([...tabs]);
    }
    expect(navFor(tabsFor('khach'))).toEqual([]);
    expect(homeFor(tabsFor(null))).toBeNull();
    expect(homeFor(tabsFor('gd_ban_hang'))).toBe('/chat');
    // tab lạ từ API bị bỏ; thứ tự theo bảng, không theo API
    expect(navFor(['Leads', 'Tab lạ', 'Chat Sâm Sâm']).map((r) => r.href)).toEqual([
      '/chat',
      '/leads',
    ]);
  });
});

describe('safeNext', () => {
  it('chỉ đường dẫn nội bộ; chặn open redirect', () => {
    expect(safeNext('/chat')).toBe('/chat');
    expect(safeNext('/leads?x=1')).toBe('/leads?x=1');
    for (const bad of [
      null,
      undefined,
      '',
      'chat',
      'https://evil.vn',
      '//evil.vn',
      '/\\evil.vn',
      '/\tevil',
      '/a\\b',
      '/ /evil',
      '/\u0000x',
      '/x\u007f',
    ]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/');
    }
  });
});
