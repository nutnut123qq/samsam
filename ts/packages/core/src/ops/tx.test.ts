import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { isDbError } from './tx.js';

// Pool/client đã đóng phải tính là lỗi DB (Python psycopg OperationalError) → caller fail-closed.
describe('isDbError', () => {
  it('pool đã end() và client đã đóng là lỗi DB; lỗi lập trình thì không', async () => {
    const pool = new pg.Pool({ connectionString: 'postgresql://u@127.0.0.1:9/t_dead' });
    await pool.end();
    const e = await pool.query('select 1').catch((x: unknown) => x);
    expect(isDbError(e)).toBe(true);
    const c = new pg.Client({ connectionString: 'postgresql://u@127.0.0.1:9/t_dead' });
    await c.end().catch(() => {});
    const e2 = await c.query('select 1').catch((x: unknown) => x);
    expect(isDbError(e2)).toBe(true);
    expect(isDbError(new TypeError('x is undefined'))).toBe(false);
  });
});
