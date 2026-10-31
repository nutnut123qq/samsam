import { cookies } from 'next/headers';
import Link from 'next/link';
import { PERSON_COOKIE, withPerson } from '../../../lib/person';
import { api, requireTab } from '../../../lib/session';
import { ActionForm } from '../../_ui/action-form';
import { Notice } from '../../_ui/notice';
import { addGardenLog } from './actions';

// Tab "Nhật ký vườn" (Streamlit, WS3): nhân viên ghi hoạt động theo khoảnh; hệ thống chuẩn hóa +
// cảnh báo bất thường. Nhật ký do NGƯỜI nhập — không tự sinh. Ghi bằng login Postgres riêng của
// người (mở ở tab Duyệt & Lịch); chi tiết hiển thị đã che SĐT/email (API).

const TAB = 'Nhật ký vườn';

type Garden = {
  ident: string;
  unlocked: boolean;
  plots: { id: string; label: string }[];
  activities: string[];
  today: string;
  anomalies: string[];
  recent: {
    ts: string;
    plot: string;
    activity: string;
    detail: string;
    author: string;
    source: string;
  }[];
};

export default async function GardenPage() {
  const g = await requireTab(TAB, '/garden');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const r = await api<Garden>('/garden', {
    fetchImpl: withPerson((await cookies()).get(PERSON_COOKIE)?.value),
  });
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Agent nhật ký vùng trồng (WS3) — nhân viên ghi hoạt động theo khoảnh; hệ thống chuẩn hóa +
        cảnh báo bất thường (khoảnh lâu chưa ghi, nhật ký có dấu hiệu sâu bệnh). Nhật ký do NGƯỜI
        nhập — hệ thống không tự sinh.
      </p>
      {!r.ok ? <Notice level="info">{r.message}</Notice> : <Body d={r.data} />}
    </>
  );
}

function Body({ d }: { d: Garden }) {
  return (
    <>
      <h2>Ghi nhật ký</h2>
      <ActionForm action={addGardenLog}>
        <div className="row">
          {d.plots.length > 0 && (
            <label>
              Khoảnh
              <select name="plot">
                {d.plots.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Hoạt động
            <select name="activity">
              {d.activities.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hoạt động khác (tự ghi — khi chọn "khác…")
            <input name="activityFree" maxLength={200} />
          </label>
          <label>
            Ngày
            <input type="date" name="date" defaultValue={d.today} required />
          </label>
        </div>
        <label className="field">
          Chi tiết
          <textarea name="detail" rows={3} maxLength={2000} />
        </label>
        <p className="caption">
          Người ghi: <b>{d.ident}</b> (theo login Postgres riêng — mở quyền ở tab{' '}
          <Link href="/review">Duyệt &amp; Lịch</Link>).
        </p>
        {!d.unlocked && (
          <Notice level="warning">
            Chưa mở quyền bằng login Postgres riêng — mở ở tab Duyệt &amp; Lịch trước khi ghi.
          </Notice>
        )}
        <button type="submit" className="primary">
          Ghi nhật ký
        </button>
      </ActionForm>

      <h2>Cần chú ý</h2>
      {d.anomalies.length ? (
        d.anomalies.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 2 bất thường có thể cùng chữ
          <Notice key={i} level="warning">
            {a}
          </Notice>
        ))
      ) : (
        <Notice level="info">
          Không có bất thường — mọi khoảnh active đều có nhật ký gần đây.
        </Notice>
      )}

      <h2>Nhật ký gần nhất</h2>
      {d.recent.length ? (
        <table>
          <thead>
            <tr>
              <th>Thời gian (UTC)</th>
              <th>Khoảnh</th>
              <th>Hoạt động</th>
              <th>Chi tiết</th>
              <th>Người ghi</th>
              <th>Nguồn</th>
            </tr>
          </thead>
          <tbody>
            {d.recent.map((x, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bảng chỉ đọc, thứ tự cố định theo API
              <tr key={i}>
                <td>{x.ts}</td>
                <td>{x.plot}</td>
                <td>{x.activity}</td>
                <td>{x.detail}</td>
                <td>{x.author}</td>
                <td>{x.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Notice level="info">Chưa có nhật ký nào.</Notice>
      )}
    </>
  );
}
