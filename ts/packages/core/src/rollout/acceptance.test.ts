import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataPath } from '../paths.js';
import G from './__fixtures__/acceptance.golden.json' with { type: 'json' };
import {
  acceptanceCli,
  blockState,
  buildRows,
  catalog,
  criteria,
  envState,
  evaluate,
  type Login,
  NOT_READY,
  READY,
  renderMd,
  rows,
  sourceOverlaps,
  summary,
} from './acceptance.js';

// Golden sinh bằng `pipelines/acceptance.py` thật (script scratchpad gen_golden.py).

const TMP = mkdtempSync(join(tmpdir(), 'accept-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
type Raw = Record<string, unknown>;

describe('acceptance golden (Python)', () => {
  it('envState / sourceOverlaps / rows / summary / renderMd trên repo', async () => {
    expect(envState()).toEqual(G.env_state);
    expect(sourceOverlaps(catalog())).toEqual(G.source_overlaps);
    const rs = await rows();
    expect(JSON.parse(JSON.stringify(rs))).toEqual(G.rows);
    expect(summary(rs)).toEqual(G.summary);
    expect(renderMd(rs, 'không đọc DB')).toBe(G.render_md);
  });

  it('blockState: chưa kiểm / không kiểm được / thiếu login / chưa đăng nhập thật', () => {
    const d = join(TMP, 'bs');
    mkdirSync(join(d, 'directors'), { recursive: true });
    for (const [blk, appr] of Object.entries(G.block_state_data)) {
      writeFileSync(join(d, 'directors', `${blk}.json`), JSON.stringify({ approvers: appr }));
    }
    for (const [blk, lg, want] of G.block_state as [string, Login[] | string | null, unknown][]) {
      expect(blockState(blk, d, lg), `${blk} ${JSON.stringify(lg)}`).toEqual(want);
    }
  });

  it('evaluate / criteria / sourceOverlaps ca biên', () => {
    const d = join(TMP, 'ev');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'sim_config.json'), '{"dpia_signed": "true"}');
    const ok = { E1: null, E2: null, E3: null };
    for (const [f, want] of G.evaluate as [Raw, unknown][]) {
      const ov: Record<string, string[]> =
        f.blocker === null ? { 'sales-99': ['x', 'b', 'x'] } : {};
      expect(evaluate(f, ok, { B1: null, B2: null }, ov, d), JSON.stringify(f)).toEqual(want);
    }
    for (const [f, want] of G.criteria as [Raw, string][]) expect(criteria(f)).toBe(want);
    const [fs, want] = G.source_overlaps_cases as [Raw[], unknown];
    expect(sourceOverlaps(fs)).toEqual(want);
  });
});

// Dịch tests/test_acceptance_matrix.py (phần không DB).
function feat(kw: Raw = {}): Raw {
  return {
    id: 'sales-99',
    phong_ban: 'sales',
    pham_vi: 'tinh_nang_ai',
    giai_doan: 'P1',
    ten: 'thử',
    nguon: 'PL01',
    dau_ra: 'nháp',
    nguoi_duyet: 'Giám đốc bán hàng',
    modules: ['agents/x.py'],
    output_sources: [{ table: 'approval_queue', block: 'sales', object_type: 't99' }],
    code_status: 'co_code',
    acceptance_status: 'chua_nghiem_thu',
    blocker: '',
    bang_chung: ['tests/test_x.py'],
    ...kw,
  };
}

describe('acceptance — READY chỉ khi đủ mọi điều kiện', () => {
  const data = join(TMP, 'data');
  cpSync(dataPath('directors'), join(data, 'directors'), { recursive: true });
  const c = JSON.parse(readFileSync(join(data, 'directors', 'sales.json'), 'utf8'));
  c.approvers = ['Người Duyệt Giả'];
  writeFileSync(join(data, 'directors', 'sales.json'), JSON.stringify(c));
  const OK = { E1: null, E2: null, E3: null };
  const LOGGED: Login[] = [
    { person: 'Người Duyệt Giả', blocks: ['sales'], valid: true, last_login: '2026-10-22T09:00' },
  ];

  it('repo hiện tại: 0 READY, 0 nghiệm thu, 96 mục', async () => {
    const rs = await rows();
    const s = summary(rs);
    expect([s.mau_so, s.tinh_nang_ai, s.hang_muc_khac]).toEqual([96, 89, 7]);
    expect([s.ready_for_trial, s.da_nghiem_thu, s.du_ho_so]).toEqual([0, 0, 0]);
    expect(Object.values(envState()).every(Boolean)).toBe(true);
    for (const r of rs) {
      expect(r.status).toBe(NOT_READY);
      expect(r.buoc_ke.startsWith('Chuẩn bị: ')).toBe(true);
    }
  });

  it('không đọc DB = CHƯA KIỂM login → không bao giờ READY; đủ → READY; thiếu 1 → không', () => {
    const r0 = buildRows([feat()], data, OK, null, {})[0];
    expect(r0?.status).toBe(NOT_READY);
    expect(r0?.thieu).toEqual([
      'CHƯA KIỂM login người duyệt (không đọc DB — chạy `--db` trên server Bên B)',
    ]);
    const r = buildRows([feat()], data, OK, LOGGED, {})[0];
    expect([r?.status, r?.thieu]).toEqual([READY, []]);
    expect(r?.buoc_ke.startsWith('Bắt đầu chạy thử nội bộ')).toBe(true);
    for (const [bad, why] of [
      [{ code_status: 'mot_phan' }, 'mã chưa đủ'],
      [{ output_sources: [] }, 'không có nguồn đếm'],
      [{ blocker: 'chờ file thật' }, 'blocker danh mục'],
      [{ phong_ban: 'finance' }, 'khối finance chưa có người'],
      [{ modules: ['scripts/persona_sim.py'] }, 'DPIA chưa ký'],
    ] as [Raw, string][]) {
      const x = buildRows([feat(bad)], data, OK, LOGGED, {})[0];
      expect(x?.status, JSON.stringify(bad)).toBe(NOT_READY);
      expect(x?.thieu.some((m) => m.includes(why))).toBe(true);
    }
    const e1 = buildRows(
      [feat()],
      data,
      { ...OK, E1: 'server Bên B chưa bàn giao' },
      LOGGED,
      {},
    )[0];
    expect(e1?.thieu).toEqual(['server Bên B chưa bàn giao']);
    const b2 = buildRows([feat()], data, OK, 'UndefinedTable', {})[0];
    expect(b2?.thieu).toEqual(['không kiểm được login người duyệt (UndefinedTable)']);
  });

  it('nguồn đếm dùng chung (tiền tố báo cáo lồng nhau) → cả hai không READY', () => {
    const a = feat({ id: 'sales-97', output_sources: [{ report: 'kd-bao-cao-' }] });
    const b = feat({ id: 'sales-98', output_sources: [{ report: 'kd-bao-cao-tuan-' }] });
    const c3 = feat({ id: 'sales-96', output_sources: [{ report: 'kd-khac-' }] });
    const rs = Object.fromEntries(
      buildRows([a, b, c3], data, OK, LOGGED, {}).map((r) => [r.id, r]),
    );
    expect(rs['sales-97']?.thieu.some((m) => m.includes('sales-98'))).toBe(true);
    expect(rs['sales-98']?.thieu.some((m) => m.includes('sales-97'))).toBe(true);
    expect(rs['sales-96']?.status).toBe(READY);
  });

  it('CLI --matrix --out: 96 dòng, **0/96**; --summary JSON; không thao tác → 2', async () => {
    const out = join(TMP, 'm.md');
    const logs: string[] = [];
    const open = async () => null;
    expect(await acceptanceCli({ matrix: true, out }, open, (s) => logs.push(s))).toBe(0);
    const md = readFileSync(out, 'utf8');
    const body = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ID '));
    expect(body.length).toBe(96);
    expect(md).toContain('**0/96**');
    expect(md).not.toContain('\r\n');
    expect(await acceptanceCli({ summary: true }, open, (s) => logs.push(s))).toBe(0);
    expect(logs.at(-1)).toBe(
      JSON.stringify(summary(await rows()))
        .replaceAll(',"', ', "')
        .replaceAll('":', '": '),
    );
    expect(
      await acceptanceCli(
        {},
        open,
        () => {},
        () => {},
      ),
    ).toBe(2);
    expect(
      await acceptanceCli(
        { summary: true, db: true },
        open,
        () => {},
        () => {},
      ),
    ).toBe(2);
  });
});
