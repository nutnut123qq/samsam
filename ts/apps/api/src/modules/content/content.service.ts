import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { approvalEnforced, type Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { isPlainObject, readJson } from '@samsam/core/ops/py';
import { readinessFromDb, saveDraft } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { DATA_DIR } from '@samsam/core/paths';
import type { WebIdentity } from '@samsam/core/security/auth';
import { checkPublish, type GuardrailResult } from '@samsam/core/security/guardrail';
import { pyTruthy } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { AI_GATEWAY, PG_POOL } from '../../db/db.module.js';
import {
  type DraftMeta,
  type DraftResult,
  draftMulti,
  type ListingResult,
  listing,
} from './content.js';
import { webIdentity } from './web-auth.js';

// Content Studio (Python tab Streamlit "Content Studio"): sinh nháp đa kênh / listing sàn, kiểm
// nhanh text theo luật đăng bài, "Lưu vào hàng duyệt" (`store.save_draft`).
// Readiness đọc view `sku_readiness` bằng login svc_ui (DB lỗi → null = soi gương golden, fail-closed).
// Quyền: access token Keycloak, vai trò phải có tab "Content Studio" (`auth.tabsFor`); thiếu cấu
// hình OIDC → 401 (fail-closed, như AUTH_MODE trống = chặn).
// Lưu: Streamlit lưu đúng bản trong session phía server; REST không giữ phiên → mỗi nháp sinh ra kèm
// `token` (HMAC khóa của tiến trình) và bước lưu CHỈ nhận token — client không sửa được chữ/meta/
// guardrail (vd `is_ai=false` né nhãn AI); token gắn `sub` người sinh. Chế độ thực ghi bằng login
// Postgres RIÊNG của người (PERSON_DB); dev ghi bằng PG_POOL như `lead_store.connect()`.

export const TAB = 'Content Studio';
/** Phiên quyết định của người (login Postgres riêng — `auth.personConnect`), nối ở bước tích hợp
 * cùng form "Mở quyền quyết định" của tab Duyệt & Lịch; thiếu/null → chế độ thực không lưu. */
export const PERSON_DB = Symbol('PERSON_DB');
export type PersonDb = (who: WebIdentity) => Promise<Db | null> | Db | null;
export const NEED_PERSON =
  "Chế độ thực: mở quyền quyết định bằng login Postgres của bạn ở tab 'Duyệt & Lịch' trước khi lưu.";

// shortcut: khóa ký nháp sinh lúc khởi động (API chạy 1 tiến trình on-prem) — restart = nháp cũ
// phải sinh lại; chạy nhiều bản API thì đổi sang khóa chung từ env.
const KEY = randomBytes(32);

type Sealed = {
  sub: string;
  brief: string;
  channel: string;
  text: string;
  guardrail: unknown;
  meta: Pick<DraftMeta, 'content_type' | 'sku' | 'prompt_version' | 'prompt_sha256'> & {
    is_ai: unknown;
  };
};

const mac = (p: string) => createHmac('sha256', KEY).update(p).digest('base64url');

export function sealDraft(s: Sealed): string {
  const p = Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  return `${p}.${mac(p)}`;
}

/** Token hợp lệ của đúng người (`sub`) → nội dung đã ký | null. */
export function openDraft(token: unknown, sub: string): Sealed | null {
  if (typeof token !== 'string') return null;
  const [p, sig, extra] = token.split('.');
  if (!p || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(p));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const s = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Sealed;
  return s.sub === sub ? s : null;
}

export type Presented<R> = R & { lines: [string, string][]; token: string | null };

/** Kết quả sinh → thêm dòng guardrail cho UI (`store.guardrail_lines`) + token lưu (bản không bị
 * từ chối; bản từ chối không lưu — như Streamlit `continue`). */
export function present<R extends { text: string; guardrail: unknown; meta: DraftMeta }>(
  results: Record<string, R>,
  brief: string,
  sub: string,
  lines: (g: unknown) => [string, string][],
): Record<string, Presented<R>> {
  const out: Record<string, Presented<R>> = {};
  for (const [channel, r] of Object.entries(results)) {
    const m = r.meta ?? ({} as DraftMeta);
    out[channel] = {
      ...r,
      lines: lines(r.guardrail),
      token: m.refused
        ? null
        : sealDraft({
            sub,
            brief,
            channel,
            text: r.text,
            guardrail: r.guardrail,
            meta: {
              content_type: m.content_type || 'post',
              sku: m.sku ?? null,
              is_ai: m.is_ai,
              prompt_version: m.prompt_version ?? null,
              prompt_sha256: m.prompt_sha256 ?? null,
            },
          }),
    };
  }
  return out;
}

export type StudioOptions = { contentTypes: string[]; checkTypes: string[]; skus: string[] };

/** Lựa chọn của Studio như Streamlit: loại content công khai (bỏ image/video — chỉ sinh qua
 * image_studio/video_studio), mọi loại cho ô "Check guardrail", SKU golden. File hỏng → ["post"] /
 * [] (guardrail tự báo "config"). TS chặt hơn: sku_key không phải chuỗi → bỏ cả danh sách. */
export function studioOptions(dataDir: string = DATA_DIR): StudioOptions {
  let contentTypes = ['post'];
  let checkTypes = ['post'];
  try {
    const doc = readJson(join(dataDir, 'guardrail_rules.json'));
    const ct = isPlainObject(doc) ? doc.content_types : null;
    if (isPlainObject(ct) && Object.keys(ct).length) {
      const keys = Object.keys(ct);
      checkTypes = keys;
      const pub = keys.filter((k) => {
        const v = ct[k];
        return isPlainObject(v) && pyTruthy(v.public) && k !== 'image' && k !== 'video';
      });
      contentTypes = pub.length ? pub : ['post'];
    }
  } catch {
    // giữ ["post"]
  }
  let skus: string[] = [];
  try {
    const doc = readJson(join(dataDir, 'golden_skus.json'));
    const list = isPlainObject(doc) && Array.isArray(doc.skus) ? doc.skus : [];
    const keys = list.map((s) => (isPlainObject(s) ? s.sku_key : undefined));
    if (keys.every((k) => typeof k === 'string')) skus = keys as string[];
  } catch {
    // giữ []
  }
  return { contentTypes, checkTypes, skus };
}

export type SaveResult = {
  ids: string[];
  saved: string[];
  dups: number;
  errs: number;
  blocked: string | null;
};

@Injectable()
export class ContentService {
  constructor(
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(PERSON_DB) private readonly personDb: PersonDb | null = null,
  ) {}

  /** `Authorization: Bearer <token>` → danh tính web có tab Content Studio | 401/403. */
  identity(header: unknown, env: Env = process.env): Promise<WebIdentity> {
    return webIdentity(header, TAB, env);
  }

  /** Python `draft()`/`draft_multi()` của Studio: mỗi kênh guardrail độc lập. */
  async drafts(
    brief: string,
    channels: string[],
    sku: string | null,
    contentType: string,
  ): Promise<Record<string, DraftResult>> {
    const readiness = await readinessFromDb(this.pool);
    return draftMulti(brief, channels, { readiness, sku, contentType }, { ai: this.ai });
  }

  /** Python `listing()` theo từng kênh sàn: thông số/giá do code dựng từ golden. */
  async listings(sku: string, channels: string[]): Promise<Record<string, ListingResult>> {
    const readiness = await readinessFromDb(this.pool);
    const out: Record<string, ListingResult> = {};
    for (const ch of new Set(channels))
      out[ch] = await listing(sku, ch, { readiness }, { ai: this.ai });
    return out;
  }

  /** "Check guardrail": text có sẵn theo luật ĐĂNG BÀI, không qua LLM (readiness như bước lưu). */
  async check(
    text: string,
    channel: string,
    contentType: string,
    isAi: boolean,
  ): Promise<GuardrailResult> {
    return checkPublish(text, {
      channel,
      contentType,
      isAi,
      readiness: await readinessFromDb(this.pool),
    });
  }

  /** "Lưu vào hàng duyệt": nháp đã ký → `save_draft` (guardrail tính lại + snapshot lúc sinh, không
   * lỏng hơn). Trùng nháp listing sống → đếm `dups` (coi như đã lưu); lỗi DB khác → `errs` (giữ để
   * thử lại); tính năng tắt → `blocked`, dừng. null = chế độ thực chưa mở phiên người. */
  async save(
    who: WebIdentity,
    drafts: Sealed[],
    env: Env = process.env,
  ): Promise<SaveResult | null> {
    const db = approvalEnforced(env) ? ((await this.personDb?.(who)) ?? null) : this.pool;
    if (db === null) return null;
    const out: SaveResult = { ids: [], saved: [], dups: 0, errs: 0, blocked: null };
    for (const d of drafts) {
      try {
        const id = await saveDraft(db, {
          brief: d.brief,
          channel: d.channel,
          text: d.text,
          guardrail: d.guardrail,
          createdBy: who.username,
          contentType: d.meta.content_type || 'post',
          sku: d.meta.sku,
          isAi: d.meta.is_ai !== false,
          promptVersion: d.meta.prompt_version,
          promptSha256: d.meta.prompt_sha256,
        });
        if (id !== null) out.ids.push(id);
        out.saved.push(d.channel);
      } catch (e) {
        if ((e as { code?: unknown }).code === '23505') {
          out.dups++; // đã có nháp listing sống cùng SKU/kênh/phiên bản prompt
          out.saved.push(d.channel);
        } else if (isDbError(e)) {
          out.errs++;
        } else if (e instanceof RangeError && e.name === 'RolloutBlocked') {
          out.blocked = e.message;
          break;
        } else {
          throw e;
        }
      }
    }
    return out;
  }
}
