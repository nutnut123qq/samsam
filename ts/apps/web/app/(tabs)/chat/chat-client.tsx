'use client';

import { type FormEvent, useRef, useState } from 'react';
import { newChatSession, safeHref } from '../../../lib/format';
import { Notice } from '../../_ui/notice';
import { sendChat, type Turn } from './actions';

// Tab Chat (Streamlit `st.chat_message`): `messages` chỉ để hiển thị (chữ người dùng thấy), `history`
// là bản RAW API trả về cho lượt sau (semantics zalo — tách render-model khỏi history-model).
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  caption?: string | null;
  sources?: string[];
};

export function ChatClient() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [history, setHistory] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const session = useRef<string | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const question = q;
    if (!question.trim() || busy) return;
    session.current ??= newChatSession();
    setBusy(true);
    setError(null);
    setQ('');
    setMessages((m) => [...m, { role: 'user', content: question }]);
    try {
      const r = await sendChat(question, history, session.current);
      if (r.ok) {
        session.current = r.data.session;
        setHistory(r.data.history);
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: r.data.display,
            caption: r.data.caption,
            sources: r.data.sources,
          },
        ]);
      } else {
        setError(
          r.status === 401 ? 'Phiên đăng nhập hết hạn — tải lại trang để đăng nhập.' : r.message,
        );
      }
    } catch {
      setError('Không gửi được câu hỏi — thử lại.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hội thoại chỉ thêm cuối, không sắp xếp lại
        <div key={i} className={`msg ${m.role}`}>
          <div className="caption">{m.role === 'user' ? 'Bạn' : 'Sâm Sâm'}</div>
          <p className="plain">{m.content}</p>
          {m.caption && <p className="caption">{m.caption}</p>}
          {m.sources && m.sources.length > 0 && (
            <ul>
              {m.sources.map((s) => {
                const href = safeHref(s);
                return (
                  <li key={s}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {s}
                      </a>
                    ) : (
                      s
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {busy && <p className="caption">Đang tra knowledge base...</p>}
      {error && <Notice level="warning">{error}</Notice>}
      <form onSubmit={ask} className="row">
        <label className="field" style={{ flex: 1 }}>
          <span className="caption">Câu hỏi</span>
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Hỏi về Sâm Sâm..."
            rows={2}
            maxLength={2000}
          />
        </label>
        <button type="submit" className="primary" disabled={busy || !q.trim()}>
          Gửi
        </button>
      </form>
    </section>
  );
}
