import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { serviceDsn } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import {
  loadUsers,
  normName,
  type PersonSession,
  PersonSessionError,
} from '@samsam/core/security/auth';
import { casefold } from '@samsam/core/security/py';
import type pg from 'pg';

// Bước "Mở quyền quyết định" của web (Python `streamlit_app._person_conn`, đợt an toàn S04 — HĐ 6.7,
// 7.2): quyết định (duyệt/từ chối/xếp lịch/hàng duyệt chung) và nhật ký vườn ghi bằng LOGIN Postgres
// RIÊNG của người đang đăng nhập (Postgres xác thực mật khẩu của chính họ; DB đối chiếu
// `human_logins`). Login UI dùng chung (`svc_ui`) KHÔNG BAO GIỜ dùng để quyết định. Mật khẩu không
// lưu: chỉ giữ kết nối đã xác thực, gắn với (người đăng nhập Keycloak, mã phiên ngẫu nhiên trong
// cookie httpOnly của trình duyệt) — như phiên Streamlit giữ conn trong session_state.
// KHÁC Python có chủ đích (chặt hơn): chế độ dev cũng phải mở phiên người (Python dev ghi bằng conn
// UI); phiên rảnh quá IDLE_MS bị đóng; mỗi người tối đa 1 phiên (mở mới → đóng phiên cũ).

export const PERSON_CONNECT = Symbol('PERSON_CONNECT');
export const PERSON_ENV = Symbol('PERSON_ENV');
export type PersonConnectFn = (dsn: string, login: unknown, pw: unknown) => Promise<PersonSession>;

// shortcut: phiên rảnh 30 phút rồi đóng — nâng thành cấu hình khi Bên B có chính sách phiên.
export const IDLE_MS = 30 * 60_000;

type Entry = { owner: string; person: string; client: pg.Client; last: number; dead: boolean };

/** Python: người chưa có login Postgres riêng → không mở được quyền quyết định. */
export const noDbLogin = (ident: string): string =>
  `\`${ident}\` chưa có login Postgres riêng (users file \`db_login\`) — chế độ thực không ` +
  'ghi quyết định bằng login UI dùng chung. Quản trị cấp login + `human_logins` theo văn ' +
  'bản ủy quyền của Bên B (runbook 9.7).';

/** Lỗi mở phiên — thông điệp nghiệp vụ cho người dùng (không mật khẩu/DSN). */
export class PersonOpenError extends Error {
  override name = 'PersonOpenError';
}

@Injectable()
export class PersonSessions implements OnApplicationShutdown {
  private readonly byHandle = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    @Inject(PERSON_CONNECT) private readonly connect: PersonConnectFn,
    @Inject(PERSON_ENV) private readonly env: Env,
  ) {
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }

  /** login Postgres riêng của người (users file `db_login`) | null. */
  dbLogin(ident: string): string | null {
    return loadUsers(undefined, this.env).get(casefold(ident))?.db_login ?? null;
  }

  /** Mở phiên người cho `ident` → mã phiên. Lỗi → PersonOpenError (thông điệp như Python). */
  async open(
    ident: string,
    password: unknown,
  ): Promise<{ handle: string; person: string; blocks: string[] }> {
    const dbl = this.dbLogin(ident);
    if (!dbl) throw new PersonOpenError(noDbLogin(ident));
    let s: PersonSession;
    try {
      s = await this.connect(serviceDsn('ui', this.env).dsn ?? '', dbl, password);
    } catch (e) {
      if (e instanceof PersonSessionError) throw new PersonOpenError(e.message);
      throw e;
    }
    if (normName(s.person) !== normName(ident)) {
      await s.client.end().catch(() => {});
      throw new PersonOpenError(
        `login \`${dbl}\` thuộc người khác \`${ident}\` — không mở quyền quyết định`,
      );
    }
    for (const [h, e] of this.byHandle) if (e.owner === ident) await this.drop(h);
    const handle = randomBytes(32).toString('base64url');
    const entry: Entry = {
      owner: ident,
      person: s.person,
      client: s.client,
      last: Date.now(),
      dead: false,
    };
    s.client.on('end', () => {
      entry.dead = true;
    });
    this.byHandle.set(handle, entry);
    return { handle, person: s.person, blocks: s.blocks };
  }

  /** Kết nối người của phiên `handle` nếu đúng chủ + còn sống + chưa quá hạn rảnh | null. */
  async get(handle: unknown, ident: string): Promise<pg.Client | null> {
    if (typeof handle !== 'string' || !handle) return null;
    const e = this.byHandle.get(handle);
    if (!e || e.owner !== ident) return null;
    if (e.dead || Date.now() - e.last > IDLE_MS) {
      await this.drop(handle);
      return null;
    }
    e.last = Date.now();
    return e.client;
  }

  /** Phiên còn sống mới nhất của người (không cần mã phiên) — CHỈ cho `PERSON_DB` của Content Studio
   * ("Lưu vào hàng duyệt" — nháp, không phải quyết định; hook nhóm content chỉ nhận danh tính).
   * Quyết định (duyệt/từ chối/xếp lịch/nhật ký vườn) luôn đòi mã phiên qua `get`. */
  async forUser(ident: string): Promise<pg.Client | null> {
    for (const [h, e] of [...this.byHandle].reverse()) {
      if (e.owner === ident) return this.get(h, ident);
    }
    return null;
  }

  async close(handle: unknown, ident: string): Promise<void> {
    if (typeof handle === 'string' && this.byHandle.get(handle)?.owner === ident) {
      await this.drop(handle);
    }
  }

  private async drop(handle: string): Promise<void> {
    const e = this.byHandle.get(handle);
    this.byHandle.delete(handle);
    await e?.client.end().catch(() => {});
  }

  /** Đóng phiên chết/quá hạn rảnh — không để kết nối người treo vô hạn trong tiến trình chạy lâu. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [h, e] of [...this.byHandle]) {
      if (e.dead || now - e.last > IDLE_MS) await this.drop(h);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const h of [...this.byHandle.keys()]) await this.drop(h);
  }
}
