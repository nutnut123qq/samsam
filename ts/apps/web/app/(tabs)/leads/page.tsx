import { countsSummary, fmtUtcMinute } from '../../../lib/format';
import { api, requireTab } from '../../../lib/session';
import { Metric, Notice } from '../../_ui/notice';

const TAB = 'Leads';
type Counts = Record<string, number>;
type LeadsReply = {
  conv: { total: number; answered: number; rate: string; by_channel: Counts };
  leads: {
    total: number;
    new_7d: number;
    by_channel: Counts;
    by_intent: Counts;
    by_status: Counts;
    recent: {
      ts: string;
      channel: string;
      intent: string;
      question: string;
      user_hash: string;
      status: string;
    }[];
  } | null;
};

// Dashboard WS2 (Streamlit tab "Leads"): số liệu kênh chat từ convlog + bảng `leads`. Read-only.
export default async function LeadsPage() {
  const g = await requireTab(TAB, '/leads');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const r = await api<LeadsReply>('/leads');
  if (!r.ok) return <Notice level="error">{r.message}</Notice>;
  const { conv, leads } = r.data;
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Dashboard WS2: số liệu kênh chat + lead gom từ convlog (câu hỏi có ý định
        mua/giá/địa-điểm/đại-lý → bảng `leads`). Read-only ở pilot — cập nhật `status` qua DB.
      </p>
      <h4>Kênh chat (convlog)</h4>
      <div className="metrics">
        <Metric label="Tin nhắn" value={conv.total} />
        <Metric label="Đã trả lời" value={conv.rate} />
        <Metric
          label="Zalo / Streamlit"
          value={`${conv.by_channel.zalo ?? 0} / ${conv.by_channel.streamlit ?? 0}`}
        />
      </div>
      <hr />
      <h4>Leads (bảng `leads`)</h4>
      {leads === null ? (
        <Notice level="info">
          Chưa có dữ liệu leads — chạy `python scripts/apply_schema.py` rồi `python -m
          ingest.lead_store`.
        </Notice>
      ) : (
        <>
          <div className="metrics">
            <Metric label="Tổng leads" value={leads.total} />
            <Metric label="Mới 7 ngày" value={leads.new_7d} />
          </div>
          <p className="caption">Theo kênh: {countsSummary(leads.by_channel)}</p>
          <p className="caption">Theo intent: {countsSummary(leads.by_intent)}</p>
          <p className="caption">Theo trạng thái: {countsSummary(leads.by_status)}</p>
          {!leads.recent.length ? (
            <Notice level="info">Bảng leads trống — chạy `python -m ingest.lead_store`.</Notice>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Thời gian (UTC)</th>
                  <th>Kênh</th>
                  <th>Intent</th>
                  <th>Câu hỏi</th>
                  <th>user_hash</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {leads.recent.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: bảng chỉ đọc theo thứ tự API trả
                  <tr key={i}>
                    <td>{fmtUtcMinute(e.ts)}</td>
                    <td>{e.channel}</td>
                    <td>{e.intent}</td>
                    <td>{e.question}</td>
                    <td>
                      <code>{e.user_hash}</code>
                    </td>
                    <td>{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
