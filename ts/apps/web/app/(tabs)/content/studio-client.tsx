'use client';

import { useState } from 'react';
import { GuardrailLines, type Level, Notice } from '../../_ui/notice';
import { checkText, type DraftView, generate, saveDrafts } from './actions';

// Tab Content Studio (Streamlit): chọn SKU + loại content; `listing` = khung golden theo kênh sàn.
// Bài hiển thị dạng chữ thô (không render markdown — chữ LLM không chèn được link/ảnh tracker) kèm
// dòng guardrail; bản bị từ chối (rượu/readiness/XNQC) chỉ cảnh báo, không lưu.

export type Options = { contentTypes: string[]; checkTypes: string[]; skus: string[] };

const NO_SKU = '(không gắn SKU)';
const CONTENT_CHANNELS = ['facebook', 'tiktok', 'zalo', 'blog'];
const LISTING_CHANNELS = ['shopee', 'tiktok', 'web'];

function Channels(props: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="row">
      <legend className="caption">Kênh</legend>
      {props.all.map((c) => (
        <label key={c} style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={props.value.includes(c)}
            onChange={(e) =>
              props.onChange(
                e.target.checked ? [...props.value, c] : props.value.filter((x) => x !== c),
              )
            }
          />
          {c}
        </label>
      ))}
    </fieldset>
  );
}

export function StudioClient({ options }: { options: Options }) {
  const types = options.contentTypes;
  const [sku, setSku] = useState(NO_SKU);
  const [ctype, setCtype] = useState(types.includes('post') ? 'post' : types[0]);
  const [brief, setBrief] = useState('');
  const [chContent, setChContent] = useState(['facebook']);
  const [chListing, setChListing] = useState(['shopee']);
  const [drafts, setDrafts] = useState<Record<string, DraftView> | null>(null);
  const [notes, setNotes] = useState<[Level, string][]>([]);
  const [busy, setBusy] = useState(false);

  const isListing = ctype === 'listing';
  const skuV = sku === NO_SKU ? null : sku;
  const channels = isListing ? chListing : chContent;
  const canGen = channels.length > 0 && (isListing ? skuV !== null : brief.trim() !== '');
  const tokens = Object.values(drafts ?? {}).flatMap((d) => (d.token ? [d.token] : []));

  async function onGenerate() {
    setBusy(true);
    setNotes([]);
    try {
      const r = await generate({
        listing: isListing,
        brief,
        channels,
        sku: skuV,
        contentType: ctype,
      });
      if (r.ok) setDrafts(r.data.results);
      else setNotes([['error', r.message]]);
    } catch {
      setNotes([['error', 'Không sinh được bài — thử lại.']]);
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setNotes([]);
    try {
      const r = await saveDrafts(tokens);
      if (!r.ok) {
        setNotes([['warning', r.message]]);
        return;
      }
      const { ids, saved, dups, errs, blocked } = r.data;
      // Bỏ kênh đã lưu khỏi màn hình — bấm lại không nhân đôi nháp (kênh lỗi giữ để thử lại).
      setDrafts((d) =>
        d ? Object.fromEntries(Object.entries(d).filter(([ch]) => !saved.includes(ch))) : d,
      );
      const out: [Level, string][] = [];
      if (ids.length) {
        out.push([
          'success',
          `Đã lưu ${ids.length} draft vào hàng duyệt (id: ${ids.map((i) => `#${i}`).join(', ')}) — qua tab 'Duyệt & Lịch' để duyệt từng bài.`,
        ]);
      }
      if (dups) {
        out.push([
          'info',
          `${dups} listing đã có nháp chờ duyệt cùng SKU/kênh/phiên bản prompt — không tạo thêm.`,
        ]);
      }
      if (errs) out.push(['warning', `${errs} draft lỗi ghi DB — thử lại.`]);
      if (blocked) out.push(['warning', blocked]);
      setNotes(out);
    } catch {
      setNotes([['warning', 'Không lưu được — thử lại.']]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="row">
        <label>
          SKU
          <select value={sku} onChange={(e) => setSku(e.target.value)}>
            {[NO_SKU, ...options.skus].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Loại content
          <select value={ctype} onChange={(e) => setCtype(e.target.value)}>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      {isListing ? (
        <>
          <p className="caption">
            Listing: tên/quy cách/số ĐKSP/giá lấy từ golden — LLM chỉ viết phần chữ (bị lọc chữ số)
            khi SKU đủ mức; rượu và SKU chưa đủ readiness kênh bị từ chối. Nháp tải lên sàn TAY sau
            khi duyệt.
          </p>
          <Channels all={LISTING_CHANNELS} value={chListing} onChange={setChListing} />
        </>
      ) : (
        <>
          <label className="field">
            Brief
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="VD: Viết bài FB giới thiệu Sapentol cho người tiểu đường, nhấn công dụng đã công bố..."
            />
          </label>
          <Channels all={CONTENT_CHANNELS} value={chContent} onChange={setChContent} />
        </>
      )}
      <button type="button" className="primary" disabled={busy || !canGen} onClick={onGenerate}>
        Sinh bài
      </button>
      {busy && <p className="caption">Đang viết + kiểm guardrail từng kênh...</p>}

      {drafts &&
        Object.entries(drafts).map(([ch, d]) => (
          <article key={ch}>
            <h4>Draft — {ch}</h4>
            {d.meta?.refused ? (
              <Notice level="warning">
                Từ chối ({d.meta.refused.code}): {d.meta.refused.reason}
              </Notice>
            ) : (
              <>
                <pre className="plain">{d.text}</pre>
                <GuardrailLines lines={d.lines} />
                {d.fields && (
                  <table>
                    <tbody>
                      {Object.entries(d.fields)
                        .filter(([, v]) => v !== null && v !== undefined)
                        .map(([k, v]) => (
                          <tr key={k}>
                            <th>{k}</th>
                            <td>{String(v)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </article>
        ))}
      {drafts && (
        <p>
          <button type="button" disabled={busy || !tokens.length} onClick={onSave}>
            Lưu vào hàng duyệt
          </button>
        </p>
      )}
      {notes.map(([level, text]) => (
        <Notice key={text} level={level}>
          {text}
        </Notice>
      ))}

      <hr />
      <QuickCheck checkTypes={options.checkTypes} />
    </section>
  );
}

/** "Kiểm tra nhanh một đoạn text có sẵn theo luật ĐĂNG BÀI (không qua LLM)". */
function QuickCheck({ checkTypes }: { checkTypes: string[] }) {
  const [raw, setRaw] = useState('');
  const [channel, setChannel] = useState('facebook');
  const [ctype, setCtype] = useState(checkTypes.includes('post') ? 'post' : checkTypes[0]);
  const [isAi, setIsAi] = useState(true);
  const [lines, setLines] = useState<[string, string][] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onCheck() {
    if (!raw.trim()) return;
    setErr(null);
    try {
      const r = await checkText({ text: raw, channel, contentType: ctype, isAi });
      if (r.ok) setLines(r.data.lines);
      else setErr(r.message);
    } catch {
      setErr('Không kiểm được — thử lại.');
    }
  }

  return (
    <section>
      <p className="caption">
        Kiểm tra nhanh một đoạn text có sẵn theo luật ĐĂNG BÀI (không qua LLM):
      </p>
      <textarea
        aria-label="Text cần check"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={3}
        maxLength={20000}
        placeholder="Dán text vào đây — VD: Saphraton chữa khỏi tiểu đường"
      />
      <div className="row">
        <label>
          Kênh
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CONTENT_CHANNELS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Loại nội dung
          <select value={ctype} onChange={(e) => setCtype(e.target.value)}>
            {checkTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label style={{ flexDirection: 'row' }}>
          <input type="checkbox" checked={isAi} onChange={(e) => setIsAi(e.target.checked)} />
          Nội dung AI
        </label>
        <button type="button" onClick={onCheck}>
          Check guardrail
        </button>
      </div>
      {err && <Notice level="warning">{err}</Notice>}
      {lines && <GuardrailLines lines={lines} />}
    </section>
  );
}
