"""WS2 — hàng duyệt + lịch đăng nội dung (`content_drafts`).

Contract:
  - Bảng `content_drafts` tạo bởi `docs/schema.sql` — chạy
    `python scripts/apply_schema.py`. Draft là tài sản NGƯỜI tạo →
    update theo id, KHÔNG delete-by-source (precedent leads v1.9).
  - Status one-way `pending -> approved|rejected`: mọi chuyển khác
    (sai id, đã duyệt/từ chối trước đó) → `set_status` trả
    (False, warn) KHÔNG raise — UI/CLI hiện warn thân thiện.
  - approve CHỈ khi `guardrail->>'ok' = true` (double-gate SOW):
    bài vi phạm phải reject/regen — không có duyệt-kèm-ghi-nhận.
    Check ở Python (warn rõ) VÀ trong WHERE của UPDATE (atomic,
    chống race 2 người duyệt cùng lúc).
  - `schedule` chỉ trên draft approved + date không quá khứ.
  - Mọi ghi-tác-vụ: `conn.transaction()` + `conn.commit()` TƯỜNG
    MINH — trên conn chia sẻ đã-trong-tx (UI SELECT trước) block
    transaction() chỉ là savepoint, thiếu commit() → INSERT/UPDATE
    rollback ngầm (bug v2.1).
  - Lịch đăng là KẾ HOẠCH cho người đăng tay — hệ thống KHÔNG tự
    đăng/tự chuyển status (human-gate C2.4).
  - DB down: `connect()` (ingest.lead_store, connect_timeout=3) →
    None; đọc (`--pending`/`--calendar`) → "chưa nạp" exit 0
    (precedent report); ghi (`--approve`/`--reject`/`--schedule`)
    → exit 2 (precedent garden). UI `st.info`.

Chạy:
  python -m pipelines.store --pending
  python -m pipelines.store --approve ID --by "Tên" [--note "..."]
  python -m pipelines.store --reject  ID --by "Tên" [--note "..."]
  python -m pipelines.store --schedule ID YYYY-MM-DD
  python -m pipelines.store --calendar [--days 14]
"""

import argparse
import sys
from contextlib import contextmanager, suppress
from datetime import date, datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

CHANNELS = ("facebook", "tiktok", "blog", "zalo")
STATUSES = ("pending", "approved", "rejected")
SOURCE_STUDIO = "manual:studio"
SOURCE_CLI = "cli"
DEFAULT_LIMIT = 50
DEFAULT_DAYS = 14

COLS = ("id", "created_at", "brief", "channel", "text", "guardrail",
        "status", "reviewer", "reviewed_at", "review_note",
        "scheduled_date", "source")

_INSERT_SQL = (
    "insert into content_drafts (brief, channel, text, guardrail, source) "
    "values (%s, %s, %s, %s, %s) returning id")

_SELECT_SQL = f"select {', '.join(COLS)} from content_drafts"


def save_draft(conn, brief: str, channel: str, text: str,
               guardrail: dict, source: str = SOURCE_STUDIO):
    """INSERT 1 draft → id. `guardrail` = snapshot kết quả
    `pipelines.guardrail.check()` lúc sinh (jsonb). Channel lạ vẫn
    ghi nguyên văn (draft của người — DB không chặn vocab, queue
    hiển thị đúng thứ đã lưu). commit() tường minh — xem docstring
    module."""
    with conn.transaction():
        row = conn.execute(
            _INSERT_SQL,
            ((brief or "").strip(), (channel or "").strip(), text or "",
             Jsonb(guardrail or {}), source)).fetchone()
    conn.commit()
    return row[0] if row else None


def _rows(cur) -> list[dict]:
    return [dict(zip(COLS, r)) for r in cur.fetchall()]


def list_drafts(conn, status: str | None = None,
                limit: int = DEFAULT_LIMIT) -> list[dict]:
    """→ list dict theo COLS, mới nhất trước. `status` None → tất cả;
    status lạ → truyền thẳng vào WHERE (DB trả rỗng, không raise)."""
    if status is None:
        cur = conn.execute(
            _SELECT_SQL + " order by created_at desc, id desc limit %s",
            (limit,))
    else:
        cur = conn.execute(
            _SELECT_SQL + " where status = %s "
            "order by created_at desc, id desc limit %s",
            (status, limit))
    return _rows(cur)


def _get(conn, draft_id) -> dict | None:
    """→ row dict | None khi không tìm thấy / id không phải số."""
    try:
        row = conn.execute(
            _SELECT_SQL + " where id = %s", (draft_id,)).fetchone()
    except psycopg.Error:
        return None
    return dict(zip(COLS, row)) if row else None


def set_status(conn, draft_id, status: str, reviewer: str,
               note: str | None = None) -> tuple[bool, str | None]:
    """pending -> approved|rejected → (True, None) | (False, warn).

    Warn không raise: id không tồn tại / id không phải số / draft
    không còn pending / approve khi guardrail chưa ok / thiếu tên
    người duyệt (bắt buộc cho audit) / status đích lạ. UPDATE có
    `where status='pending'` (+ `guardrail->>'ok'='true'` khi
    approve) — race 2 người duyệt cùng lúc thì người sau thua."""
    status = (status or "").strip()
    if status not in ("approved", "rejected"):
        return False, (f"status đích '{status}' không hợp lệ — chỉ "
                       f"approved|rejected (one-way từ pending)")
    if not (reviewer or "").strip():
        return False, "thiếu tên người duyệt (--by) — bắt buộc cho audit"
    try:
        did = int(draft_id)
    except (TypeError, ValueError):
        return False, f"id '{draft_id}' không hợp lệ"
    cur = _get(conn, did)
    if cur is None:
        return False, f"không tìm thấy draft #{did}"
    if cur["status"] != "pending":
        return False, (f"draft #{did} đã ở trạng thái "
                       f"'{cur['status']}' — chỉ duyệt từ pending")
    g = cur["guardrail"]
    g_ok = isinstance(g, dict) and g.get("ok") is True
    if status == "approved" and not g_ok:
        return False, (f"draft #{did} vi phạm guardrail (ok != true) "
                       f"— phải reject hoặc viết lại; không có "
                       f"duyệt-kèm-ghi-nhận")
    # Guardrail-check LẶP LẠI trong WHERE (atomic): lỡ guardrail jsonb
    # bị sửa giữa lúc đọc và ghi thì approve vẫn không lọt.
    sql = ("update content_drafts set status = %s, reviewer = %s, "
           "review_note = %s, reviewed_at = now() "
           "where id = %s and status = 'pending'")
    if status == "approved":
        sql += " and guardrail->>'ok' = 'true'"
    sql += " returning id"
    try:
        with conn.transaction():
            row = conn.execute(
                sql, (status, reviewer.strip(), (note or None), did)
            ).fetchone()
        conn.commit()
    except psycopg.Error as e:
        return False, f"lỗi DB khi cập nhật draft #{did}: {e}"
    if not row:
        return False, (f"draft #{did} vừa đổi trạng thái — tải lại "
                       f"danh sách rồi thử lại")
    return True, None


def _coerce_date(v) -> date | None:
    """date / 'YYYY-MM-DD' → date | None (datetime lấy phần ngày)."""
    if isinstance(v, date):
        return v if type(v) is date else v.date()
    if isinstance(v, str):
        try:
            return date.fromisoformat(v.strip())
        except ValueError:
            return None
    return None


def schedule(conn, draft_id, day, today: date | None = None
             ) -> tuple[bool, str | None]:
    """Xếp lịch đăng → (True, None) | (False, warn). Chỉ draft
    approved; `day` (date/ISO-str) không được quá khứ. `today`
    inject được cho test."""
    d = _coerce_date(day)
    if d is None:
        return False, (f"ngày '{day}' không hợp lệ — định dạng "
                       f"YYYY-MM-DD")
    today = today or datetime.now(timezone.utc).date()
    if d < today:
        return False, (f"ngày {d:%Y-%m-%d} đã qua — chỉ xếp lịch "
                       f"từ hôm nay trở đi")
    try:
        did = int(draft_id)
    except (TypeError, ValueError):
        return False, f"id '{draft_id}' không hợp lệ"
    cur = _get(conn, did)
    if cur is None:
        return False, f"không tìm thấy draft #{did}"
    if cur["status"] != "approved":
        return False, (f"draft #{did} đang '{cur['status']}' — chỉ "
                       f"xếp lịch bài đã approved")
    try:
        with conn.transaction():
            row = conn.execute(
                "update content_drafts set scheduled_date = %s "
                "where id = %s and status = 'approved' returning id",
                (d, did)).fetchone()
        conn.commit()
    except psycopg.Error as e:
        return False, f"lỗi DB khi xếp lịch draft #{did}: {e}"
    if not row:
        return False, f"draft #{did} vừa đổi trạng thái — thử lại"
    return True, None


def calendar(conn, days: int = DEFAULT_DAYS,
             today: date | None = None) -> dict:
    """Lịch đăng `days` ngày tới → {"today", "days", "scheduled",
    "unscheduled"}: `scheduled` = approved có scheduled_date trong
    [today, today+days] theo ngày tăng; `unscheduled` = approved chưa
    có ngày (mới nhất trước)."""
    today = today or datetime.now(timezone.utc).date()
    horizon = today + timedelta(days=days)
    scheduled = _rows(conn.execute(
        _SELECT_SQL + " where status = 'approved' "
        "and scheduled_date >= %s and scheduled_date <= %s "
        "order by scheduled_date, id", (today, horizon)))
    unscheduled = _rows(conn.execute(
        _SELECT_SQL + " where status = 'approved' "
        "and scheduled_date is null "
        "order by created_at desc, id desc"))
    return {"today": today, "days": days,
            "scheduled": scheduled, "unscheduled": unscheduled}


def _fmt_guardrail(d: dict) -> str:
    g = d.get("guardrail")
    if isinstance(g, dict) and g.get("ok") is True:
        return "PASS"
    n = len(g.get("violations", [])) if isinstance(g, dict) else 0
    return f"VI PHẠM ({n})" if n else "VI PHẠM"


def _oneline(s: str, n: int = 60) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _print_draft_line(d: dict) -> None:
    ts = d.get("created_at")
    ts_s = ts.strftime("%m-%d %H:%M") if hasattr(ts, "strftime") else ""
    print(f"  #{d['id']} [{d['channel']}] {_oneline(d['brief'])} "
          f"— guardrail {_fmt_guardrail(d)} {ts_s}")


@contextmanager
def _conn_or_none():
    """Yield (conn, err|None); đóng conn an toàn sau dùng."""
    conn = connect()
    try:
        yield conn, (None if conn is not None
                     else "không kết nối được Postgres (DATABASE_URL "
                          "thiếu hoặc host chết)")
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.store",
        description="Hàng duyệt + lịch đăng content drafts — NGƯỜI "
                    "duyệt từng bài, hệ thống KHÔNG tự đăng (C2.4)")
    ap.add_argument("--pending", action="store_true",
                    help="liệt kê draft đang chờ duyệt")
    ap.add_argument("--approve", type=int, metavar="ID",
                    help="duyệt draft (chỉ khi guardrail ok)")
    ap.add_argument("--reject", type=int, metavar="ID",
                    help="từ chối draft")
    ap.add_argument("--by", dest="reviewer",
                    help="tên người duyệt — bắt buộc với "
                         "--approve/--reject")
    ap.add_argument("--note", default=None, help="ghi chú duyệt")
    ap.add_argument("--schedule", nargs=2,
                    metavar=("ID", "YYYY-MM-DD"),
                    help="xếp lịch đăng cho draft approved")
    ap.add_argument("--calendar", action="store_true",
                    help="xem lịch đăng sắp tới")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"số ngày lịch (mặc định {DEFAULT_DAYS})")
    args = ap.parse_args(argv)

    n_ops = (sum(w is not None
                 for w in (args.approve, args.reject, args.schedule))
             + args.pending + args.calendar)
    if n_ops == 0:
        ap.error("cần 1 thao tác: --pending | --calendar | "
                 "--approve | --reject | --schedule")
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần — tách lệnh")
    if (args.approve is not None or args.reject is not None) \
            and not (args.reviewer or "").strip():
        ap.error("--approve/--reject cần --by <tên người duyệt>")

    with _conn_or_none() as (conn, err):
        # ---- ĐỌC: DB down → "chưa nạp" exit 0 (precedent report) ----
        if args.pending:
            if conn is None:
                print(f"[warn] chưa nạp — {err}")
                return 0
            rows = list_drafts(conn, status="pending")
            if not rows:
                print("[pending] hàng chờ trống — sinh draft ở Studio "
                      "rồi 'Lưu vào hàng duyệt'")
            else:
                print(f"[pending] {len(rows)} draft chờ duyệt:")
                for d in rows:
                    _print_draft_line(d)
            return 0
        if args.calendar:
            if conn is None:
                print(f"[warn] chưa nạp — {err}")
                return 0
            cal = calendar(conn, days=args.days)
            horizon = cal["today"] + timedelta(days=cal["days"])
            print(f"[calendar] {cal['today']:%Y-%m-%d} → "
                  f"{horizon:%Y-%m-%d}:")
            if not cal["scheduled"]:
                print("  (trống — chưa có bài nào trong lịch)")
            for d in cal["scheduled"]:
                print(f"  {d['scheduled_date']}  #{d['id']} "
                      f"[{d['channel']}] {_oneline(d['brief'])}")
            if cal["unscheduled"]:
                print(f"[unscheduled] {len(cal['unscheduled'])} draft "
                      f"đã duyệt chưa xếp lịch:")
                for d in cal["unscheduled"]:
                    _print_draft_line(d)
            return 0

        # ---- GHI: DB down → exit 2 (precedent garden) ----
        if conn is None:
            print(f"[error] {err} — không ghi được", file=sys.stderr)
            return 2
        if args.approve is not None or args.reject is not None:
            did = (args.approve if args.approve is not None
                   else args.reject)
            st = ("approved" if args.approve is not None
                  else "rejected")
            ok, warn = set_status(conn, did, st, args.reviewer,
                                  args.note)
            if not ok:
                print(f"[warn] {warn}", file=sys.stderr)
                return 2
            print(f"[done] draft #{did} → {st} "
                  f"(người duyệt: {args.reviewer.strip()})")
            return 0
        # --schedule ID YYYY-MM-DD
        did, day_s = args.schedule
        ok, warn = schedule(conn, did, day_s)
        if not ok:
            print(f"[warn] {warn}", file=sys.stderr)
            return 2
        print(f"[done] draft #{did} xếp lịch {day_s} — người đăng "
              f"tay (hệ thống không tự đăng)")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
