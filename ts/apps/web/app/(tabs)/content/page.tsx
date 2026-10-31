import { api, requireTab } from '../../../lib/session';
import { Notice } from '../../_ui/notice';
import { type Options, StudioClient } from './studio-client';

const TAB = 'Content Studio';

export default async function ContentPage() {
  const g = await requireTab(TAB, '/content');
  if ('error' in g) return <Notice level="error">{g.error}</Notice>;
  const opts = await api<Options>('/content/options');
  return (
    <>
      <h1>{TAB}</h1>
      <p className="caption">
        Sinh bài từ brief — mọi text AI đều qua guardrail trước khi hiển thị (banned words + claim
        whitelist TPBVSK).
      </p>
      {opts.ok ? (
        <StudioClient options={opts.data} />
      ) : (
        <Notice level="error">{opts.message}</Notice>
      )}
    </>
  );
}
