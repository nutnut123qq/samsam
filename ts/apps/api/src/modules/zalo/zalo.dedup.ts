import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, FOLLOW_TTL_S, SEEN_TTL_S } from './zalo.constants.js';

// Dedup event Zalo (D3.5/V7.3/V8.2): Zalo retry khi webhook timeout → cùng event chỉ xử lý 1 lần.
// Cùng file sqlite + bảng `seen(event_id, ts)` với Python (data/zalo_seen.db) — sống qua restart;
// ts = epoch (wall clock) vì xuyên tiến trình. Key `follow:*` giữ 7 ngày, key khác 1 giờ.
// node:sqlite là API đồng bộ → mỗi lời gọi nguyên tử trong vòng lặp sự kiện (thay `_seen_lock`).

export class SeenDb {
  private db: DatabaseSync | null = null; // lazy — không tạo file khi khởi tạo

  constructor(readonly path: string) {}

  private conn(): DatabaseSync {
    if (this.db === null) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      // Python sqlite3.connect mặc định timeout 5 giây: messenger/zalo (2 tiến trình) cùng ghi file
      // này → chờ khóa thay vì ném 'database is locked' ngay (node:sqlite mặc định 0). Chờ đồng bộ
      // chặn vòng lặp sự kiện — khóa thật chỉ giữ vài ms (DELETE + INSERT).
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('CREATE TABLE IF NOT EXISTS seen(event_id TEXT PRIMARY KEY, ts REAL)');
    }
    return this.db;
  }

  /** true nếu event đã xử lý (0 dòng chèn mới). */
  dedup(eventId: string): boolean {
    const now = clock.wall();
    const c = this.conn();
    c.prepare(
      "DELETE FROM seen WHERE ts < CASE WHEN event_id LIKE 'follow:%' THEN ? ELSE ? END",
    ).run(now - FOLLOW_TTL_S, now - SEEN_TTL_S);
    const r = c.prepare('INSERT OR IGNORE INTO seen(event_id, ts) VALUES(?, ?)').run(eventId, now);
    return Number(r.changes) === 0;
  }

  /** Test: lùi ts của một key (giả lập thời gian trôi). */
  age(eventId: string, seconds: number): void {
    this.conn().prepare('UPDATE seen SET ts = ts - ? WHERE event_id = ?').run(seconds, eventId);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
