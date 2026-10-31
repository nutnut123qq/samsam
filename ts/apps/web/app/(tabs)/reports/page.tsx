import { api, requireTab } from '../../../lib/session';
import { ActionForm } from '../../_ui/action-form';
import { Notice } from '../../_ui/notice';
import { generateReport } from './actions';

// Tab "Báo cáo" (Streamlit): agent báo cáo định kỳ (WS3) — sinh/xem file markdown `data/reports/`.
// Báo cáo là BẢN NHÁP cho người duyệt + gửi lãnh đạo; hệ thống KHÔNG tự gửi (C2.4).
// shortcut: hiển thị markdown dạng chữ thô (không render — chưa có gói markdown trong web); thêm
// trình render an toàn (không HTML thô) khi Bên B cần bảng đẹp.

const TAB = 'Báo cáo';
const DAYS = [7, 14, 30];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string | string[] }>;
}) {
  const g = await requireTab(TAB, '/reports');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const list = await api<{ files: string[] }>('/reports');
  const want = (await searchParams).file;
  const files = list.ok ? list.data.files : [];
  // Chỉ tên có trong danh sách API (không đường dẫn tự do); mặc định mới nhất.
  const pick = typeof want === 'string' && files.includes(want) ? want : files[0];
  const one = pick
    ? await api<{ name: string; text: string }>(`/reports/${encodeURIComponent(pick)}`)
    : null;
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Agent báo cáo định kỳ (WS3) — tổng hợp bán hàng + leads + kênh chat + nhật ký vườn ra file
        markdown trong `data/reports/`. Báo cáo là BẢN NHÁP: duyệt + gửi lãnh đạo do NGƯỜI — hệ
        thống KHÔNG tự gửi (C2.4). Chạy định kỳ ngoài UI: `python -m agents.report`.
      </p>
      <ActionForm action={generateReport}>
        <div className="row">
          <label>
            Kỳ báo cáo
            <select name="days" defaultValue="7">
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} ngày gần nhất
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary">
            Sinh báo cáo
          </button>
        </div>
      </ActionForm>
      <hr />
      {!list.ok ? (
        <Notice level="error">{list.message}</Notice>
      ) : !files.length ? (
        <Notice level="info">
          Chưa có báo cáo nào — bấm 'Sinh báo cáo' hoặc chạy `python -m agents.report`.
        </Notice>
      ) : (
        <>
          <form method="get" className="row">
            <label>
              Báo cáo đã sinh (mới nhất trước)
              <select name="file" defaultValue={pick}>
                {files.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Xem</button>
          </form>
          {one && !one.ok && <Notice level="error">{one.message}</Notice>}
          {one?.ok && <pre className="plain">{one.data.text}</pre>}
        </>
      )}
    </>
  );
}
