import { cookies } from 'next/headers';
import { PERSON_COOKIE, withPerson } from '../../../lib/person';
import { api, requireTab } from '../../../lib/session';
import { ActionForm } from '../../_ui/action-form';
import { GuardrailLines, Notice } from '../../_ui/notice';
import { decideDraft, decideQueue, lock, scheduleDraft, unlock } from './actions';

// Tab "Duyệt & Lịch" (Streamlit, WS2 + v13.5 F08 + đợt an toàn S04): hàng duyệt content (draft AI đã
// qua guardrail lúc sinh, NGƯỜI duyệt từng bài — Duyệt chỉ khi guardrail PASS), lịch đăng 14 ngày,
// hàng duyệt chung 9 khối (khối người được ủy quyền). Hệ thống KHÔNG tự đăng (C2.4). Nút khóa + lý do
// do API tính (cùng hàm API dùng để chặn yêu cầu giả). Nội dung hiển thị dạng chữ THÔ (không
// markdown): người duyệt thấy đúng chuỗi được ký sha256 (WYSIWYS).

const TAB = 'Duyệt & Lịch';

type Gate = { ok: boolean; why: string | null };
type Now = { ok: boolean; codes: string[] };
type DraftV = {
  id: string;
  label: string;
  text: string;
  guardrail: [string, string][];
  guardrailNow: Now;
  createdBy: string;
  approve: Gate;
  reject: Gate;
};
type QueueV = {
  id: string;
  label: string;
  text: string;
  meta: string;
  guardrailNow: Now;
  approve: Gate;
  reject: Gate;
};
type View = {
  ident: string;
  role: string;
  enforced: boolean;
  devWarning: string | null;
  person: { unlocked: boolean; dbLogin: string | null; problem: string | null };
  drafts: DraftV[];
  calendar: {
    canSchedule: boolean;
    info: string | null;
    today: string;
    unscheduled: { id: string; label: string }[];
    scheduled: { date: string; channel: string; draft: string; brief: string; reviewer: string }[];
  };
  queue: { blocks: string[]; info: string | null; items: QueueV[] };
};

export default async function ReviewPage() {
  const g = await requireTab(TAB, '/review');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const r = await api<View>('/approval', {
    fetchImpl: withPerson((await cookies()).get(PERSON_COOKIE)?.value),
  });
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Hàng duyệt nội dung (WS2) — draft AI đã qua guardrail lúc sinh chờ NGƯỜI duyệt từng bài; bài
        approved xếp vào lịch đăng. Approve chỉ khi guardrail PASS (double-gate SOW — không có
        duyệt-kèm-ghi-nhận). Hệ thống KHÔNG tự đăng — lịch là kế hoạch cho người đăng tay (C2.4).
      </p>
      {!r.ok ? <Notice level="info">{r.message}</Notice> : <Body v={r.data} />}
    </>
  );
}

function Body({ v }: { v: View }) {
  return (
    <>
      {v.devWarning && <Notice level="warning">{v.devWarning}</Notice>}
      <PersonBox v={v} />

      <h2>Hàng chờ duyệt ({v.drafts.length})</h2>
      {!v.drafts.length && (
        <Notice level="info">
          Hàng chờ trống — sinh draft ở tab 'Content Studio' rồi bấm 'Lưu vào hàng duyệt'.
        </Notice>
      )}
      {v.drafts.map((d) => (
        <details key={d.id}>
          <summary>{d.label}</summary>
          <pre className="plain">{d.text}</pre>
          <GuardrailLines lines={d.guardrail} />
          <NowCheck now={d.guardrailNow} />
          <p className="plain">{d.createdBy}</p>
          <Decide
            action={decideDraft}
            id={d.id}
            ident={v.ident}
            who="duyệt"
            a={d.approve}
            r={d.reject}
          />
        </details>
      ))}

      <hr />
      <h2>Lịch đăng 14 ngày</h2>
      {v.calendar.info && <Notice level="info">{v.calendar.info}</Notice>}
      {v.calendar.canSchedule && v.calendar.unscheduled.length > 0 && (
        <ActionForm action={scheduleDraft}>
          <div className="row">
            <label>
              Bài đã duyệt chưa xếp lịch
              <select name="id">
                {v.calendar.unscheduled.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ngày đăng
              <input type="date" name="date" defaultValue={v.calendar.today} required />
            </label>
            <button type="submit" className="primary">
              Xếp lịch
            </button>
          </div>
        </ActionForm>
      )}
      {v.calendar.scheduled.length ? (
        <table>
          <thead>
            <tr>
              <th>Ngày</th>
              <th>Kênh</th>
              <th>Draft</th>
              <th>Brief</th>
              <th>Người duyệt</th>
            </tr>
          </thead>
          <tbody>
            {v.calendar.scheduled.map((d) => (
              <tr key={d.draft}>
                <td>{d.date}</td>
                <td>{d.channel}</td>
                <td>{d.draft}</td>
                <td>{d.brief}</td>
                <td>{d.reviewer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Notice level="info">Chưa có bài nào trong lịch 14 ngày tới.</Notice>
      )}

      <hr />
      <h2>Hàng duyệt khối (việc của agent)</h2>
      {v.queue.info && <Notice level="info">{v.queue.info}</Notice>}
      {v.queue.items.map((q) => (
        <details key={q.id}>
          <summary>{q.label}</summary>
          <pre className="plain">{q.text}</pre>
          <p className="plain">{q.meta}</p>
          <NowCheck now={q.guardrailNow} />
          <Decide
            action={decideQueue}
            id={q.id}
            ident={v.ident}
            who="quyết"
            a={q.approve}
            r={q.reject}
          />
        </details>
      ))}
    </>
  );
}

/** "Mở quyền quyết định" bằng login Postgres RIÊNG của người — không bao giờ quyết bằng login UI. */
function PersonBox({ v }: { v: View }) {
  const p = v.person;
  if (p.problem) return <Notice level="error">{p.problem}</Notice>;
  if (p.unlocked) {
    return (
      <ActionForm action={lock}>
        <div className="row">
          <span className="caption">
            Đã mở quyền quyết định bằng login Postgres <code>{p.dbLogin}</code> của bạn.
          </span>
          <button type="submit">Khóa quyền</button>
        </div>
      </ActionForm>
    );
  }
  return (
    <ActionForm action={unlock}>
      <p className="caption">
        Xác thực quyết định bằng login Postgres <code>{p.dbLogin}</code> của bạn — mật khẩu không
        được lưu.
      </p>
      <div className="row">
        <label>
          Mật khẩu Postgres
          <input type="password" name="password" autoComplete="off" required />
        </label>
        <button type="submit" className="primary">
          Mở quyền quyết định
        </button>
      </div>
    </ActionForm>
  );
}

function NowCheck({ now }: { now: Now }) {
  return now.ok ? null : (
    <Notice level="error">
      Guardrail kiểm lại lúc hiển thị: VI PHẠM ({now.codes.join(', ') || '?'})
    </Notice>
  );
}

function Decide(props: {
  action: typeof decideDraft;
  id: string;
  ident: string;
  who: string;
  a: Gate;
  r: Gate;
}) {
  const { a, r } = props;
  return (
    <ActionForm action={props.action}>
      <input type="hidden" name="id" value={props.id} />
      <div className="row">
        <label>
          Người {props.who} (đăng nhập)
          <input value={props.ident} disabled readOnly />
        </label>
        <label>
          Ghi chú (tuỳ chọn)
          <input name="note" maxLength={2000} />
        </label>
        <button
          type="submit"
          name="decision"
          value="approved"
          className="primary"
          disabled={!a.ok}
          title={a.why ?? undefined}
        >
          Duyệt
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={!r.ok}
          title={r.why ?? undefined}
        >
          Từ chối
        </button>
      </div>
      {!a.ok && a.why && <p className="caption">Duyệt bị khóa: {a.why}</p>}
      {!r.ok && r.why && <p className="caption">Từ chối bị khóa: {r.why}</p>}
    </ActionForm>
  );
}
