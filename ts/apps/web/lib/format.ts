// Định dạng hiển thị dùng chung các trang (port phần render của app/streamlit_app.py).

/** Python `ts.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")`; không đọc được → ''. */
export function fmtUtcMinute(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** So chuỗi theo code point (Python `sorted`; JS sort mặc định theo UTF-16). */
export function cpCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** Python `"; ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "—"`. */
export function countsSummary(counts: Record<string, number> | null | undefined): string {
  const keys = Object.keys(counts ?? {}).sort(cpCompare);
  return keys.map((k) => `${k}=${(counts as Record<string, number>)[k]}`).join('; ') || '—';
}

/** Link nguồn chỉ khi là URL http(s) tuyệt đối — `javascript:`/`data:`/đường dẫn lạ hiện chữ thường. */
export function safeHref(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Mã phiên chat cho `user_hash` kênh UI (Python `uuid4().hex[:8]` mỗi session). */
export function newChatSession(
  rand: (n: Uint8Array) => Uint8Array = (n) => crypto.getRandomValues(n),
): string {
  return Array.from(rand(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
}
