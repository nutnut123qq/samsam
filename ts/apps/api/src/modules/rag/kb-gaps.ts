import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import { pyInt } from '@samsam/core/ops/py';
import { DATA_DIR } from '@samsam/core/paths';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, pySplit, S } from '@samsam/core/security/py';
import { splitLines } from './embed-store.js';
import { cpCompare } from './rag.service.js';

// Port `scripts/kb_gaps.py` — báo cáo câu NO_DATA lặp lại để bổ sung KB (0 LLM — cụm bằng luật):
// đọc convlog `data/conversations.jsonl` (+`.1`) BYTES + split `\n`, lấy record `answered` đúng
// bool false ("false" chuỗi / thiếu key không đếm). Khóa cụm = câu (đã mask) NFC + casefold + gộp
// khoảng trắng + bỏ dấu câu cuối. Mỗi cụm: số lần, số user_hash khác nhau, ts gần nhất, loại
// "sức khỏe"/"rượu" → KHÔNG bổ sung KB (chuyển người / luật QC rượu). Câu hiển thị qua che PII lần
// nữa (entry cũ trước khi mask) + escape `|` / HTML.

export const CONV_FILES = ['conversations.jsonl', 'conversations.jsonl.1'];
const TRAIL_RE = new RegExp(`[${S}?!.,;:…]+$`, 'u');
const ASCII_WS = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g;

export function clusterKey(q: string): string {
  return pySplit(casefold(q.normalize('NFC')))
    .join(' ')
    .replace(TRAIL_RE, '');
}

type Rec = Record<string, unknown>;

/** `ingest.lead_store.iter_convlog` (không live_only): skip + đếm dòng hỏng / không phải object /
 * `_doc`; không ném. shortcut: bản riêng của nhóm rag, port lead_store xong thì dùng chung. */
export function iterConvlog(path: string, stats: { corrupt: number; doc: number }): Rec[] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return [];
  }
  const out: Rec[] = [];
  const dec = new TextDecoder('utf-8', { ignoreBOM: true });
  for (const l of splitLines(raw)) {
    const line = dec.decode(l).replace(ASCII_WS, '');
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      stats.corrupt++;
      continue;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      stats.corrupt++;
      continue;
    }
    if (Object.hasOwn(rec, '_doc')) {
      stats.doc++;
      continue;
    }
    out.push(rec as Rec);
  }
  return out;
}

export type Group = {
  question: string;
  count: number;
  users: number;
  last_ts: string;
  kind: string;
};

/** → cụm NO_DATA, sắp theo số lần giảm dần. */
export function collect(dataDir: string = DATA_DIR): Group[] {
  const stats = { corrupt: 0, doc: 0 };
  const groups = new Map<
    string,
    { question: string; count: number; users: Set<string>; last_ts: string }
  >();
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    for (const rec of iterConvlog(path, stats)) {
      const q = rec.question;
      if (rec.answered !== false || typeof q !== 'string') continue;
      const shown = pySplit(maskPii(q)).join(' ');
      const key = clusterKey(shown);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { question: shown, count: 0, users: new Set(), last_ts: '' };
        groups.set(key, g);
      }
      g.count++;
      if (typeof rec.user_hash === 'string') g.users.add(rec.user_hash);
      if (typeof rec.ts === 'string' && cpCompare(rec.ts, g.last_ts) > 0) g.last_ts = rec.ts;
    }
  }
  const out = [...groups.values()].map((g) => ({
    question: g.question,
    count: g.count,
    users: g.users.size,
    last_ts: g.last_ts,
    kind: isHealthQuestion(g.question) ? 'sức khỏe' : isAlcohol(g.question) ? 'rượu' : '',
  }));
  return out.sort(
    (a, b) => b.count - a.count || b.users - a.users || cpCompare(a.question, b.question),
  );
}

/** Câu do khách gõ: escape để không vỡ bảng/không thành HTML khi render. */
export function cell(s: string): string {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function render(groups: Group[], minCount: number): string {
  const rows = groups.filter((g) => g.count >= minCount);
  const lines = [
    `# Câu NO_DATA lặp lại (>= ${minCount} lần) — ${rows.length} câu`,
    '',
    'Loại `sức khỏe`/`rượu`: KHÔNG bổ sung KB (chuyển người / luật QC rượu).',
    '',
  ];
  if (rows.length) {
    lines.push(
      '| # | Câu hỏi (đã mask) | Số lần | Số người | Gần nhất | Loại |',
      '|---|---|---|---|---|---|',
    );
    rows.forEach((g, i) => {
      lines.push(
        `| ${i + 1} | ${cell(g.question)} | ${g.count} | ${g.users} | ${cell(g.last_ts)} | ${g.kind} |`,
      );
    });
  } else {
    lines.push('0 câu.');
  }
  return `${lines.join('\n')}\n`;
}

/** CLI `kb-gaps [--min 2] [--out file.md]` (ghi atomic) → exit code. */
export function kbGapsMain(
  o: { min?: string; out?: string },
  d: { dataDir?: string; print?: (s: string) => void; err?: (s: string) => void } = {},
): number {
  const print = d.print ?? ((s: string) => process.stdout.write(s));
  const err = d.err ?? ((s: string) => console.error(s));
  let minCount = 2;
  if (o.min !== undefined) {
    const v = pyInt(o.min);
    if (v === null) {
      err(`[err] argument --min: invalid int value: '${o.min}'`);
      return 2;
    }
    if (v < 1n) {
      err('[err] --min phải >= 1');
      return 2;
    }
    minCount = Number(v);
  }
  const text = render(collect(d.dataDir), minCount);
  if (o.out) {
    const tmp = `${o.out}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, o.out);
    print(`[kb-gaps] đã ghi ${basename(o.out)}\n`);
  } else {
    print(text);
  }
  return 0;
}
