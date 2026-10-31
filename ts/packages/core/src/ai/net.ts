import { pyStrip } from '../env.js';

// Ollama / AI worker CHỈ ở mạng nội bộ (`ai_private`, docs/rewrite/KE_HOACH.md mục 2): URL trỏ ra
// máy công cộng = dữ liệu rời server Sâm Sâm → từ chối trước khi gửi (fail-closed).

const PRIVATE_V4 = [
  [0x7f000000, 8], // 127/8
  [0x0a000000, 8], // 10/8
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
] as const;

function privateV4(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const n = m.slice(1).reduce((a, x) => a * 256 + Number(x), 0);
  return PRIVATE_V4.some(([net, bits]) => n >>> (32 - bits) === net >>> (32 - bits));
}

/** Máy nội bộ: localhost, tên 1 nhãn (tên dịch vụ compose), *.internal/*.local, IP riêng. */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v4 = privateV4(h);
  if (v4 !== null) return v4;
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h); // ::1, fc00::/7
  if (h === 'localhost' || /\.(localhost|internal|local)$/.test(h)) return true;
  return h !== '' && !h.includes('.');
}

/** URL dịch vụ nội bộ từ biến môi trường → {url} | {error} (thông điệp không chứa giá trị biến). */
export function internalUrl(
  raw: string | undefined,
  name: string,
): { url: string; error: null } | { url: null; error: string } {
  const s = pyStrip(raw ?? '');
  if (!s) return { url: null, error: `thiếu ${name}` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { url: null, error: `${name} không phải URL hợp lệ` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { url: null, error: `${name} phải là http(s)` };
  if (u.username || u.password) return { url: null, error: `${name} không được chứa tài khoản` };
  if (!isInternalHost(u.hostname)) {
    return {
      url: null,
      error: `${name} phải trỏ máy nội bộ (mạng ai_private) — không gửi dữ liệu ra ngoài`,
    };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, error: null };
}
