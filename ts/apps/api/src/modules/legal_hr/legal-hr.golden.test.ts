import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig as loadPhapChe } from '../ra_kenh/ra-kenh.js';
import { contractCheckMain, missingClauses, readContract } from './contract-check.js';
import * as h from './pc-hr.js';
import * as x from './xnqc.js';

// Golden sinh bằng chạy hàm Python THẬT (scratchpad legal_hr/gen_golden.py, DSN chết) trên đầu vào cố
// định: agents/pc_hr.py (norm/has_kw/_bias/_minutes/_month_end/load_position + render_jd, read_cvs/
// rank/render_screening, load_rules, read_attendance, summarize/render_attendance), agents/xnqc.py
// (reminders/golden_target/_date/draft_payload/draft(submit=False)/load_draft_config/tpbvsk_skus) và
// scripts/contract_check.py (missing_clauses trên mẫu thật + biến thể + ca biên Unicode, _read, main).

type G = Record<string, unknown>;
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as G;
const PC = load('pc_hr.golden.json');
const XN = load('xnqc.golden.json');
const CC = load('contract_check.golden.json');
const TMP = mkdtempSync(join(tmpdir(), 'legal-hr-golden-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
const tmpFile = (name: string, data: Buffer | string): string => {
  const d = join(TMP, `f${seq++}`);
  mkdirSync(d);
  const p = join(d, name);
  writeFileSync(p, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return p;
};
const b64 = (s: string) => Buffer.from(s, 'base64');
const res = (fn: () => unknown) => {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
};
const posOut = (p: h.Position) => ({
  key: p.key,
  must: p.must.map((c) => ({ id: c.id, mo_ta: c.mo_ta, kw: c.kw })),
  pref: p.pref.map((c) => ({ id: c.id, mo_ta: c.mo_ta, kw: c.kw, diem: c.diem })),
  sha: h.positionSha(p),
});

// ================================================================ pc_hr
describe('pc_hr golden', () => {
  it('norm / has_kw / sha12 / _bias / _minutes / _month_end', () => {
    for (const [s, out] of PC.norm as [string, string][]) expect(h.norm(s), s).toBe(out);
    for (const [t, k, out] of PC.has_kw as [string, string, boolean][]) {
      expect(h.hasKw(t, k), `${t}|${k}`).toBe(out);
    }
    for (const [s, out] of PC.sha12 as [string, string][]) expect(h.sha12(s)).toBe(out);
    for (const [s, out] of PC.bias as [string, boolean][]) expect(h.bias(s), s).toBe(out);
    for (const [s, out] of PC.minutes as [string | null, number | null][]) {
      expect(h.minutes(s), String(s)).toBe(out);
    }
    for (const [m, out] of PC.month_end as [string, string][]) expect(h.monthEnd(m)).toBe(out);
  });

  it('vị trí trong repo: tiêu chí + sha + nháp JD khớp Python', () => {
    const want = PC.positions as Record<string, G>;
    expect(Object.keys(want).length).toBeGreaterThan(0);
    for (const [key, w] of Object.entries(want)) {
      const p = h.loadPosition(key);
      const { jd, ...rest } = w;
      expect(posOut(p)).toEqual(rest);
      expect(h.renderJd(p)).toBe(jd);
    }
  });

  it('load_position: cấu hình hỏng / tiêu chí phân biệt đối xử → cùng thông điệp', () => {
    for (const c of PC.load_position as G[]) {
      const path = tmpFile('jd.json', c.text as string);
      const r = res(() => h.loadPosition(c.key as string, path));
      if (c.error !== undefined) expect(r, c.name as string).toEqual({ error: c.error });
      else {
        const p = r.ok as h.Position;
        expect(posOut(p), c.name as string).toEqual(c.ok);
        expect(h.renderJd(p)).toBe(c.jd);
      }
    }
  });

  const inbox = () => {
    const s = PC.screening as G;
    const d = join(TMP, `inbox${seq++}`);
    mkdirSync(d);
    for (const [n, b] of s.files as [string, string][]) writeFileSync(join(d, n), b64(b));
    for (const sub of s.subdirs as string[]) mkdirSync(join(d, sub));
    return d;
  };
  const readOut = (r: [h.Cand[], number, string | null]) => ({
    cands: r[0],
    skipped: r[1],
    err: r[2],
  });

  it('read_cvs + rank + render_screening (mã sha nội dung, không tự loại, không PII)', () => {
    const s = PC.screening as G;
    const [cands, skipped, err] = h.readCvs(inbox());
    expect(readOut([cands, skipped, err])).toEqual(s.read);
    for (const [key, w] of Object.entries(s.ranked as Record<string, G>)) {
      const pos = h.loadPosition(key);
      const ranked = h.rank(pos, cands);
      expect(ranked, key).toEqual(w.ranked);
      expect(h.renderScreening(pos, ranked, skipped)).toBe(w.text);
    }
  });

  it('read_cvs: trần số file / trần byte (băm luồng) như Python', () => {
    const s = PC.screening as G;
    const old = { ...h.limits };
    try {
      h.limits.maxCvFiles = 3;
      expect(readOut(h.readCvs(inbox()))).toEqual(s.limit_files);
      h.limits.maxCvFiles = old.maxCvFiles;
      h.limits.maxCvBytes = 40;
      expect(readOut(h.readCvs(inbox()))).toEqual(s.limit_bytes);
    } finally {
      Object.assign(h.limits, old);
    }
  });

  it('load_rules: luật ca hỏng → cùng thông điệp', () => {
    for (const c of PC.rules as G[]) {
      const r = res(() => h.loadRules(tmpFile('r.json', c.text as string)));
      if (c.error !== undefined) expect(r, c.name as string).toEqual({ error: c.error });
      else {
        const v = r.ok as h.Rules;
        expect(
          {
            start_min: v.shift.startMin,
            end_min: v.shift.endMin,
            workdays: [...v.shift.workdays].sort(),
            holidays: [...v.shift.holidays].sort(),
            grace_late_min: v.grace_late_min,
            grace_early_min: v.grace_early_min,
          },
          c.name as string,
        ).toEqual(c.ok);
      }
    }
  });

  it('read_attendance: kiểm TOÀN file (lỗi → 0 dòng), lỗi không chứa giá trị ô', async () => {
    for (const c of PC.attendance as G[]) {
      const name = c.suffix !== undefined ? `x${c.suffix}` : 'cc.csv';
      const path = tmpFile(name, b64(c.b64 as string));
      const [rows, errs, sha] = await h.readAttendance(path, c.month as string, c.today as string);
      expect({ rows, errs, sha }, c.name as string).toEqual({
        rows: c.rows,
        errs: c.errs,
        sha: c.sha,
      });
      for (const e of errs) expect(e).not.toMatch(/0901234567|Nguyen|Tràn/);
    }
  });

  it('summarize + render_attendance: trễ/sớm/thiếu/vắng/ngoài lịch, kỳ đóng/mở, lễ', async () => {
    const base = h.loadRules();
    const good = (PC.attendance as G[]).find((c) => c.name === 'good') as G;
    for (const c of PC.summarize as G[]) {
      const month = (c.month as string | undefined) ?? '2026-10-01';
      const src = (c.b64 as string | undefined) ?? (good.b64 as string);
      const [rows, , sha] = await h.readAttendance(
        tmpFile('cc.csv', b64(src)),
        month,
        '2026-11-05',
      );
      const grace = c.grace as [number, number] | undefined;
      const rules: h.Rules = {
        shift: { ...base.shift, holidays: new Set(c.holidays as string[]) },
        grace_late_min: grace ? grace[0] : base.grace_late_min,
        grace_early_min: grace ? grace[1] : base.grace_early_min,
      };
      const stats = h.summarize(rows, month, rules, c.until as string);
      expect(Object.fromEntries(stats), c.until as string).toEqual(c.stats);
      expect(h.renderAttendance(month, stats, rules, c.until as string, sha as string)).toBe(
        c.text,
      );
    }
  });
});

// ================================================================ xnqc
describe('xnqc golden', () => {
  const CFG = loadPhapChe();

  it('reminders: biên hạn đợt 2 + giấy sắp/đã hết hạn', () => {
    for (const c of XN.reminders as G[]) {
      expect(
        x.reminders(c.rows as x.Dossier[], ['savina-12v', 'savigout-30v'], CFG, c.today as string),
        c.today as string,
      ).toEqual(c.out);
    }
  });

  it('golden_target 5 nhánh + giấy chưa tới ngày cấp không tính', () => {
    for (const c of XN.golden_target as G[]) {
      expect(x.goldenTarget(c.rows as x.Dossier[], c.today as string)).toBe(c.out);
    }
  });

  it('_date: ngày ISO / sai → cùng thông điệp', () => {
    for (const [v, ok, err] of XN.dates as [unknown, string | null, string | null][]) {
      const r = res(() => x.xDate(v, '--ngay-nop'));
      expect(r, String(v)).toEqual(err === null ? { ok } : { error: err });
    }
  });

  it('draft_payload + draft (không submit) + guardrail maket', async () => {
    for (const c of XN.draft_payload as G[]) {
      expect(
        x.draftPayload(
          c.sku as G,
          c.loai as string,
          c.ten as string,
          c.claims as unknown[],
          c.cfg as G,
          c.maket as string | null,
        ),
      ).toBe(c.out);
    }
    for (const c of XN.draft as G[]) {
      const sku = c.sku as string;
      if (c.error !== undefined) {
        await expect(x.draft(null, sku, 'maket', 'x', null, false)).rejects.toThrow(
          c.error as string,
        );
        continue;
      }
      const [payload, qid] = await x.draft(
        null,
        sku,
        'maket',
        'maket fb',
        c.maket as string | null,
        false,
      );
      expect(qid).toBeNull();
      expect(payload).toBe(c.payload);
    }
  });

  it('load_draft_config + tpbvsk_skus', () => {
    for (const c of XN.load_draft_config as G[]) {
      const r = res(() => x.loadDraftConfig(tmpFile('xnqc_draft.json', c.text as string)));
      if (c.error === null) expect(r.ok, c.name as string).toBeDefined();
      else expect(r, c.name as string).toEqual({ error: c.error });
    }
    expect(x.tpbvskSkus()).toEqual(XN.tpbvsk);
  });
});

// ================================================================ contract_check
describe('contract_check golden', () => {
  it('missing_clauses: mẫu thật, bỏ từng điều khoản, bỏ dấu, CRLF, "cấm"≠"cảm", AI≠"ai", \\b Unicode', () => {
    const cases = CC.missing as [string, string, string[]][];
    expect(cases.length).toBeGreaterThan(80);
    for (const [kind, text, miss] of cases) {
      expect(missingClauses(text, kind), `${kind}: ${text.slice(0, 60)}`).toEqual(miss);
    }
  });

  it('_read: đuôi / rỗng / chỉ khoảng trắng / không UTF-8 / > 1MB → cùng thông điệp', () => {
    for (const c of CC.reads as G[]) {
      const data =
        c.b64 !== null
          ? b64(c.b64 as string)
          : Buffer.alloc(c.size as number, (c.fill as string).charCodeAt(0));
      const r = res(() => readContract(tmpFile(c.name as string, data)));
      if (c.error === null) expect([...(r.ok as string)].length, c.name as string).toBe(c.ok);
      else expect(r, c.name as string).toEqual({ error: c.error });
    }
  });

  it('main: stdout/stderr/exit khớp Python (không echo nội dung file)', async () => {
    for (const c of CC.main as G[]) {
      const out: string[] = [];
      const err: string[] = [];
      const rc = await contractCheckMain(
        { kind: c.kind as string, file: tmpFile('hd.txt', b64(c.b64 as string)) },
        { io: { out: (s) => out.push(`${s}\n`), err: (s) => err.push(`${s}\n`) } },
      );
      expect({ rc, out: out.join(''), err: err.join('') }).toEqual({
        rc: c.rc,
        out: c.out,
        err: c.err,
      });
    }
  });
});
