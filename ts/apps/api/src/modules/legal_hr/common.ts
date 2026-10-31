import type { Db } from '@samsam/core/ops/deps';

// Dùng chung cho 3 lệnh CLI của nhóm legal_hr (pc-hr, xnqc, contract-check). Kết nối DATABASE_URL =
// core `connectDatabaseUrl` (Python `ingest.lead_store.connect`).

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };

/** Lỗi unique (psycopg `UniqueViolation`). */
export const isUnique = (e: unknown): boolean => (e as { code?: string }).code === '23505';
