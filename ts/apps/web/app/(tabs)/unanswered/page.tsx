import { api, requireTab } from '../../../lib/session';
import { Notice } from '../../_ui/notice';

const TAB = 'Chưa trả lời';
type Row = { ts: string; question: string; user_hash: string };

// Câu khách hỏi mà bot chưa trả lời được (convlog `answered:false`) — API đã che PII câu hỏi.
export default async function UnansweredPage() {
  const g = await requireTab(TAB, '/unanswered');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const r = await api<{ rows: Row[] }>('/chat/unanswered');
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Câu khách hỏi mà bot chưa trả lời được (convlog `answered:false`) — nhân viên follow-up /
        input cho vòng bổ sung knowledge base. Mới nhất lên đầu.
      </p>
      {!r.ok ? (
        <Notice level="error">{r.message}</Notice>
      ) : !r.data.rows.length ? (
        <Notice level="info">Chưa có câu nào chờ — mọi câu hỏi đều đã được trả lời.</Notice>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Thời gian (UTC)</th>
              <th>Câu hỏi</th>
              <th>user_hash</th>
            </tr>
          </thead>
          <tbody>
            {r.data.rows.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bảng chỉ đọc theo thứ tự API trả
              <tr key={i}>
                <td>{e.ts}</td>
                <td>{e.question}</td>
                <td>
                  <code>{e.user_hash}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
