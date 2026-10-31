import { requireTab } from '../../../lib/session';
import { Notice } from '../../_ui/notice';
import { ChatClient } from './chat-client';

const TAB = 'Chat Sâm Sâm';

export default async function ChatPage() {
  const g = await requireTab(TAB, '/chat');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Hỏi đáp trên knowledge base public của Sâm Sâm — câu trả lời luôn kèm nguồn; thiếu dữ liệu
        bot sẽ nói thẳng.
      </p>
      <ChatClient />
    </>
  );
}
