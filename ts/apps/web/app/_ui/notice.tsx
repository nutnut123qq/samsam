import type { ReactNode } from 'react';

// Khối hiển thị dùng chung (thay st.success/error/warning/info/caption/metric). Mọi chữ render dạng
// TEXT (React tự escape, không markdown) — nội dung AI/agent không chèn được link/ảnh tracker.

export type Level = 'success' | 'error' | 'warning' | 'info';

export function Notice({ level, children }: { level: Level; children: ReactNode }) {
  return (
    <div className={`notice ${level}`} role={level === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Dòng guardrail đã định dạng ở API (`store.guardrail_lines`): [level, text]. */
export function GuardrailLines({ lines }: { lines: [string, string][] }) {
  return (
    <>
      {lines.map(([level, text], i) =>
        level === 'info' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách tĩnh, không sắp xếp lại
          <p key={i} className="caption">
            {text}
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách tĩnh, không sắp xếp lại
          <Notice key={i} level={level as Level}>
            {text}
          </Notice>
        ),
      )}
    </>
  );
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <span className="caption">{label}</span>
      <b>{value}</b>
    </div>
  );
}
