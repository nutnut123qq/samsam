import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { loadConfig } from '@samsam/core/ops/director';
import { wireCore } from '@samsam/core/ops/wire';
import { settings } from '@samsam/core/rollout/counters';
import { cliEntry } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RagService } from '../rag/rag.service.js';
import G from './__fixtures__/sx_label.golden.json' with { type: 'json' };
import * as di from './doc-intake.js';
import { cap, makePdf } from './sx-docs.testing.js';
import * as sx from './sx-label.js';
import * as st from './sx-tracuu.js';

// Phần DB của tests/test_sx_label.py, test_doc_intake.py (reprocess G3), test_v15_p10_human_authz.py
// (doc verify qua login người), test_sx_tracuu.py (cách ly collection trên vector thật). DB RIÊNG từ
// mẫu `samsam_ts_tpl` (đã nạp golden_store → sku_master có SKU thật), dựng lại MỖI ca, xóa khi xong.
// Người trong test là tên GIẢ LẬP. KHÔNG BAO GIỜ DB `samsam`.

const GOOD = (G.cases.find((c) => c.name === 'good') as { text: string }).text;
const RUOU_KEY = 'ruou-sam-chai-thuy-tinh-500ml';
const PID = process.pid;
const P_LEGAL = 'Pháp Chế Giả Lập';
const P_SALES = 'Bán Hàng Giả Lập';
const DOC_SHA = 'd'.repeat(64);

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('sx_docs (DB)', () => {
  const NAME = testDbName('sx_docs');
  let dsn: string;
  let pool: pg.Pool;
  let tmp: string;
  const saved = { ...di.PROVIDERS };
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const lease = () => async () => ({ db: pool, release: async () => {} });

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sxdocs-db-'));
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
  });
  afterEach(() => {
    for (const k of Object.keys(di.PROVIDERS)) if (!(k in saved)) delete di.PROVIDERS[k];
    Object.assign(di.PROVIDERS, saved);
  });
  afterAll(async () => {
    settings.forceMode = null;
    await pool?.end();
    await dropDb(NAME);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ============================================================ sx_label
  describe('sx-label', () => {
    const label = (text: string) => {
      const p = join(tmp, `${randomBytes(4).toString('hex')}.txt`);
      writeFileSync(p, text);
      return p;
    };
    const run = async (o: sx.SxLabelOpts) => {
      const t = cap();
      const rc = await cliEntry(sx.sxLabelMain)(o, {
        io: t.io,
        env: { NODE_ENV: 'test' },
        connect: lease(),
        wire: () => {},
        now: () => new Date('2026-10-12T03:00:00Z'),
      });
      return { rc, ...t };
    };
    const queue = () =>
      q(
        'select object_type, object_id, block, risk, title, payload, status from approval_queue order by id',
      );
    beforeEach(async () => {
      for (const [i, [title, sku]] of [
        ['Saphraton 30 viên', 'saphraton-20v'],
        ['Khác 12 viên', 'savina-12v'],
      ].entries()) {
        const sid = (
          await q(
            "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', 'l.csv', $1, 1, now() + make_interval(secs => $2)) returning id",
            [randomBytes(16).toString('hex'), i],
          )
        )[0].id;
        await q(
          "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, raw) values ($1, 2, 'shopee', 'listing', $2, $3, $4, '{}')",
          [sid, String(100 + i), sku, title],
        );
      }
      await q(
        "insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, source) values ('SAP-260901', 'saphraton-20v', '2026-09-01', '2028-09-01', 5, 'sample')",
      );
    });
    const passLot = () =>
      q(
        "update production_lots set intake_status = 'passed', checked_by = 'QA test', checked_at = now()",
      );

    it('dry-run: đọc listing MỚI NHẤT + hồ sơ lô, không ghi gì, không in nguyên văn nhãn', async () => {
      const r = await run({ sku: 'saphraton-20v', text: label(GOOD) });
      expect(r.rc, r.all()).toBe(0);
      const out = r.out.join('\n');
      // snapshot shopee mới nhất chỉ có dòng savina → không lệch listing; lô pending → lo_chua_kiem
      expect(out).toContain('[lo_chua_kiem]');
      expect(out).not.toContain('listing_quy_cach_lech');
      expect(out).toContain('[dry]');
      expect(out).not.toContain('không phải là thuốc');
      expect(await queue()).toEqual([]);
    });

    it('--submit: 1 mục mỗi ĐỢT (chạy lại skip; nhãn khác = đợt mới); risk theo cấu hình khối', async () => {
      await passLot();
      const p = label(GOOD.replace('20 viên', '30 viên'));
      expect((await run({ sku: 'saphraton-20v', text: p, submit: true })).rc).toBe(0);
      let qq = await queue();
      expect(qq).toHaveLength(1);
      const cfg = loadConfig('production');
      expect([qq[0].object_type, qq[0].block, qq[0].status]).toEqual([
        'label_check',
        'production',
        'pending',
      ]);
      expect(qq[0].risk).toBe(cfg.object_types.label_check.risk);
      expect(qq[0].object_id.startsWith('sxlabel:saphraton-20v:')).toBe(true);
      expect(qq[0].payload).toContain('quy cách');
      expect(guardrailCheck(qq[0].payload).ok).toBe(true);
      const again = await run({ sku: 'saphraton-20v', text: p, submit: true });
      expect(again.rc).toBe(0);
      expect(again.out.join('\n')).toContain('[skip]');
      expect(await queue()).toHaveLength(1);
      writeFileSync(p, GOOD.replace('20 viên', '40 viên'));
      expect((await run({ sku: 'saphraton-20v', text: p, submit: true })).rc).toBe(0);
      qq = await queue();
      expect(qq).toHaveLength(2);
    });

    it('nhãn sạch + --submit → không đẩy gì', async () => {
      await passLot();
      const r = await run({ sku: 'saphraton-20v', text: label(GOOD), submit: true });
      expect(r.out.join('\n')).toContain('[ok]');
      expect(await queue()).toEqual([]);
    });

    it('SKU rượu: hàng duyệt chỉ mã tra cứu H-…, người chạy thấy ánh xạ', async () => {
      const r = await run({ sku: RUOU_KEY, text: label('Nhãn chai 500ml\n'), submit: true });
      expect(r.rc, r.all()).toBe(0);
      const ref = sx.skuRef((await sx.goldenSku(pool, RUOU_KEY)) as sx.Sku);
      expect(r.out.join('\n')).toContain(`${RUOU_KEY} → mã tra cứu ${ref}`);
      const qq = await queue();
      expect(qq).toHaveLength(1);
      for (const s of [qq[0].object_id, qq[0].title, qq[0].payload]) {
        expect(s).not.toContain(RUOU_KEY);
        expect(s).toContain(ref);
      }
      expect(guardrailCheck(qq[0].payload).ok).toBe(true);
    });

    it('SKU không có trong golden → exit 1, không ghi', async () => {
      expect((await run({ sku: 'khong-co', text: label(GOOD) })).rc).toBe(1);
      expect(await queue()).toEqual([]);
    });

    it('listing lệch quy cách lấy từ snapshot MỚI NHẤT kênh khác', async () => {
      const sid = (
        await q(
          "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('tiktok', 'listing', 't.csv', $1, 1, now() + interval '1 minute') returning id",
          [randomBytes(16).toString('hex')],
        )
      )[0].id;
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, raw) values ($1, 2, 'tiktok', 'listing', 'T1', 'saphraton-20v', 'Saphraton 40 viên', '{}')",
        [sid],
      );
      const r = await run({ sku: 'saphraton-20v', text: label(GOOD) });
      expect(r.out.join('\n')).toContain(
        '[listing_quy_cach_lech] listing tiktok mã T1 ghi 40 viên',
      );
    });

    it('cổng triển khai TẮT ở biên sinh (enqueue) → [rollout] exit 2, không ghi hàng duyệt', async () => {
      settings.forceMode = 'tat';
      const r = await run({
        sku: 'saphraton-20v',
        text: label(GOOD.replace('20 viên', '30 viên')),
        submit: true,
      });
      expect(r.rc).toBe(2);
      expect(r.out.join('\n')).toContain('[rollout]');
      expect(await queue()).toEqual([]);
    });
  });

  // ============================================================ doc_intake
  describe('doc-intake', () => {
    it('G3 reprocess: cho_ocr → pending_review, quét PII, field nháp, chạy lại không nhân đôi, bản gốc sửa → lỗi', async () => {
      const intake = join(tmp, `in-${randomBytes(3).toString('hex')}`);
      const orig = join(tmp, `orig-${randomBytes(3).toString('hex')}`);
      for (const [rel, data] of [
        ['giay_tiep_nhan/scan.pdf', makePdf(null)],
        ['nhan/b.png', Buffer.from('\x89PNG\r\n\x1a\nother', 'latin1')],
      ] as const) {
        mkdirSync(dirname(join(intake, rel)), { recursive: true });
        writeFileSync(join(intake, rel), data);
      }
      const log: string[] = [];
      const c0 = await di.intake(intake, orig, pool, 'none', { log: (s) => log.push(s) });
      expect(c0.cho_ocr).toBe(2);
      await expect(di.reprocessPending(pool, orig, 'none')).rejects.toThrow('BLOCKED');
      di.PROVIDERS.fake_us = [async () => 'x', false];
      await expect(di.reprocessPending(pool, orig, 'fake_us')).rejects.toThrow('nước ngoài');
      const calls: string[] = [];
      di.PROVIDERS.fake_vn = [
        async (p) => {
          calls.push(p);
          return readFileSync(p).subarray(0, 4).toString('latin1') === '%PDF'
            ? 'So 77/2025/ĐKSP ngày 2 tháng 1 năm 2025 LH 0912345678'
            : '';
        },
        true,
      ];
      const opts = { log: (s: string) => log.push(s) };
      expect(await di.reprocessPending(pool, orig, 'fake_vn', opts)).toEqual({
        done: 1,
        still: 1,
        error: 0,
      });
      const st0 = Object.fromEntries(
        (await q('select status, count(*)::int as n from documents group by 1')).map((r) => [
          r.status,
          r.n,
        ]),
      );
      expect(st0).toEqual({ pending_review: 1, cho_ocr: 1 });
      const row = (
        await q(
          "select sha256, text_source, pii_flag from documents where status = 'pending_review'",
        )
      )[0];
      expect([row.text_source, row.pii_flag]).toEqual(['ocr', true]);
      expect(
        (
          await q('select bool_or(verified) as v from document_fields where sha256 = $1', [
            row.sha256,
          ])
        )[0].v,
      ).toBe(false);
      const out = log.join('\n');
      expect(out).not.toContain('0912345678');
      expect(out).not.toContain('77/2025');
      calls.length = 0;
      expect(await di.reprocessPending(pool, orig, 'fake_vn', opts)).toEqual({
        done: 0,
        still: 1,
        error: 0,
      });
      expect(calls).toHaveLength(1);
      expect(
        (
          await q('select count(*)::int as n from document_fields where sha256 = $1', [row.sha256])
        )[0].n,
      ).toBe(2);
      const left = (await q("select sha256 from documents where status = 'cho_ocr'"))[0];
      writeFileSync(join(orig, left.sha256), 'tampered');
      expect((await di.reprocessPending(pool, orig, 'fake_vn', opts)).error).toBe(1);
      expect(
        (await q('select status from documents where sha256 = $1', [left.sha256]))[0].status,
      ).toBe('cho_ocr');
    });

    describe('--verify qua login người (app_human + human_logins)', () => {
      const tag = `${PID}_${randomBytes(3).toString('hex')}`;
      const L = {
        legal: [`t_sxd_legal_${tag}`, randomBytes(12).toString('hex'), P_LEGAL, '{legal_hr}'],
        sales: [`t_sxd_sales_${tag}`, randomBytes(12).toString('hex'), P_SALES, '{sales}'],
      } as const;
      const asUrl = (k: keyof typeof L) => {
        const u = new URL(dsn);
        u.username = L[k][0];
        u.password = L[k][1];
        return u.toString();
      };
      beforeAll(async () => {
        for (const [login, pw] of Object.values(L)) {
          await adminQuery(`drop role if exists ${login}`);
          await adminQuery(
            `create role ${login} login password '${pw}' nosuperuser nocreatedb nocreaterole in role app_human`,
          );
        }
      });
      afterAll(async () => {
        for (const [login] of Object.values(L)) await adminQuery(`drop role if exists ${login}`);
      });
      beforeEach(async () => {
        for (const [login, , person, blocks] of Object.values(L)) {
          await q(
            "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, $3, 'test-ts')",
            [login, person, blocks],
          );
        }
        await q(
          "insert into documents (sha256, filename, doc_type, text_source, status) values ($1, 'scan_p10.pdf', 'giay_tiep_nhan', 'pdf_text', 'pending_review')",
          [DOC_SHA],
        );
        await q(
          "insert into document_fields (sha256, field, value) values ($1, 'so_giay', '1/2026/P10')",
          [DOC_SHA],
        );
      });
      const verify = async (
        k: keyof typeof L | 'owner',
        by: string,
        env: Record<string, string> = {},
      ) => {
        const t = cap();
        const rc = await di.docIntakeMain(
          { verify: DOC_SHA, by },
          {
            io: t.io,
            env: { NODE_ENV: 'test', DATABASE_URL: k === 'owner' ? dsn : asUrl(k), ...env },
            ...(k === 'owner' ? { connect: lease() } : {}),
          },
        );
        return { rc, ...t };
      };
      const denied = async () =>
        Number(
          (
            await q(
              "select count(*) as n from agent_action_log where action = 'authz_denied' and object_type = 'document'",
            )
          )[0].n,
        );

      it('người khối khác / --by khác người của login → DB từ chối (không đổi gì); Pháp chế đúng login → verified', async () => {
        // chế độ dev: cliGate chỉ cảnh báo — DB (`doc_review_human` + `human_actor`) vẫn cưỡng chế
        const r1 = await verify('sales', P_SALES);
        expect(r1.rc, r1.all()).toBe(1);
        expect(r1.out.join('\n')).toContain('DB từ chối');
        const r2 = await verify('legal', 'Người Khác Giả');
        expect(r2.rc, r2.all()).toBe(1);
        expect(r2.out.join('\n')).toContain('DB từ chối');
        expect(
          (await q('select status from documents where sha256 = $1', [DOC_SHA]))[0].status,
        ).toBe('pending_review');
        const r3 = await verify('legal', P_LEGAL);
        expect(r3.rc, r3.all()).toBe(0);
        expect(
          await q('select status, verified_by from documents where sha256 = $1', [DOC_SHA]),
        ).toEqual([{ status: 'verified', verified_by: P_LEGAL }]);
        expect(
          await q('select verified from document_fields where sha256 = $1', [DOC_SHA]),
        ).toEqual([{ verified: true }]);
      });

      it('chế độ thực, approvers khối legal_hr rỗng → cliGate chặn TRƯỚC function + authz_denied', async () => {
        const d0 = await denied();
        const r = await verify('owner', P_LEGAL, { APPROVAL_ENFORCE: '1' });
        expect(r.rc).toBe(1);
        expect(r.out.join('\n')).toContain('ủy quyền');
        expect(await denied()).toBe(d0 + 1);
        expect(
          (await q('select status from documents where sha256 = $1', [DOC_SHA]))[0].status,
        ).toBe('pending_review');
      });
    });
  });

  // ============================================================ sx_tracuu (vector thật)
  describe('sx-tracuu cách ly collection', () => {
    const vec = (...head: number[]) =>
      `[${[...head, ...Array(1024 - head.length).fill(0)].join(',')}]`;
    const Q = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const DOI = '10.1234/sam.2026.001';
    const ins = (
      coll: string,
      doc: string,
      i: number,
      content: string,
      v: string,
      title: string,
      ref: string,
    ) =>
      q(
        "insert into chunks_internal (collection, doc_id, chunk_index, title, source_ref, content, embedding_v2, doc_sha256, approved_by) values ($1, $2, $3, $4, $5, $6, $7::vector, $8, 'GD SX GIA LAP (test)')",
        [coll, doc, i, title, ref, content, v, '0'.repeat(64)],
      );
    const ai = {
      embed: async () => ({
        embeddings: [Q],
        model: 'm',
        provider: 'ollama' as const,
        tokensIn: 0,
      }),
      chat: async () => {
        throw new Error('không gọi chat');
      },
    };
    beforeEach(async () => {
      await ins(
        'internal:sx',
        'sx-saponin-a',
        0,
        `# Saponin (MẪU)\nDOI: ${DOI}\n\nHàm lượng saponin đo bằng HPLC.`,
        vec(1),
        'Saponin (MẪU)',
        'saponin_a.md',
      );
      await ins(
        'internal:sx',
        'sx-saponin-a',
        1,
        'Kết quả dưới tán rừng cao hơn.',
        vec(0.9, 0.1),
        'Saponin (MẪU)',
        'saponin_a.md',
      );
      await ins(
        'internal:sx',
        'sx-saponin-b',
        0,
        'Ghi chép nhiệt độ sấy (MẪU, chưa có DOI).',
        vec(0.95, 0, 0.05),
        'Nhiệt độ sấy (MẪU)',
        'say_cu_mau.md',
      );
      await ins(
        'internal:mkt',
        'mkt-ke-hoach',
        0,
        'Kế hoạch marketing nội bộ MẪU.',
        vec(1),
        'KH MKT',
        'mkt.md',
      );
      // cùng tên tệp nạp vào phòng khác → cùng doc_id: cite KHÔNG lấy chéo collection
      await ins(
        'internal:mkt',
        'sx-saponin-b',
        0,
        'DOI: 10.9999/mkt-leak\nTài liệu MKT trùng tên (MẪU).',
        vec(0, 0, 0, 1),
        'x',
        'say_cu_mau.md',
      );
      await q(
        "insert into chunks (doc_id, chunk_index, source_url, title, lang, content, embedding_v2) values ('pub-gioi-thieu', 0, 'https://samsam.example.vn/gioi-thieu', 'Giới thiệu', 'vi', 'Giới thiệu công ty Sâm Sâm (MẪU công khai).', $1::vector)",
        [vec(0.6, 0.8)],
      );
    });

    it('ask chỉ đọc internal:sx; cite từ chunk 0 cùng collection; RAG công khai không thấy tài liệu nội bộ', async () => {
      const r = await st.ask(
        'hàm lượng saponin dưới tán rừng',
        { k: 5 },
        { ai: ai as never, db: pool, env: { NODE_ENV: 'test' } },
      );
      expect(r.mode).toBe('extract');
      const ids = r.sources.map((s) => s.doc_id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((i) => i.startsWith('sx-saponin-'))).toBe(true);
      const cites = Object.fromEntries(r.sources.map((s) => [s.doc_id, s.cite]));
      expect(cites['sx-saponin-a']).toBe(`DOI: ${DOI}`);
      expect(cites['sx-saponin-b']).toContain('chưa có DOI/URL');
      expect(JSON.stringify(cites)).not.toContain('mkt-leak');
      const pub = await new RagService(pool, ai as never).retrieveByVector(Q);
      expect(pub.map((h) => h.doc_id)).toEqual(['pub-gioi-thieu']);
    });
  });
});
