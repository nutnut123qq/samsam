"""WS2 — hàng duyệt + lịch đăng nội dung (`content_drafts`).

Contract:
  - Bảng `content_drafts` tạo bởi `docs/schema.sql` — chạy
    `python scripts/apply_schema.py`. Draft là tài sản NGƯỜI tạo →
    update theo id, KHÔNG delete-by-source (precedent leads v1.9).
  - Status one-way `pending -> approved|rejected`: mọi chuyển khác
    (sai id, đã duyệt/từ chối trước đó) → `set_status` trả
    (False, warn) KHÔNG raise — UI/CLI hiện warn thân thiện.
  - v3.4: function DB là NGUỒN SỰ THẬT cho mọi chuyển trạng thái —
    `approve_draft` / `reject_draft` / `schedule_draft` (SECURITY
    DEFINER, docs/schema.sql). Module này KHÔNG chạy UPDATE lên bảng draft
    trực tiếp; role `agent_writer` (agent) không có quyền UPDATE nên
    không tự duyệt được, role `app_human` (người) chỉ đi qua function.
  - approve CHỈ khi guardrail ok (double-gate SOW): bài vi phạm phải
    reject/regen — không có duyệt-kèm-ghi-nhận. Python chạy LẠI
    `pipelines.guardrail.check(text từ DB)` trước khi gọi function
    (snapshot jsonb do agent ghi có thể giả `ok:true`); function kiểm
    lại snapshot + `created_by` có + người duyệt ≠ người tạo (atomic,
    `for update` — race 2 người duyệt thì người sau thua).
  - Mỗi quyết định ghi `approvals` kèm sha256 text lúc duyệt;
    `verify_publish(conn, id, text)` so bản phát hành với bản đã duyệt.
  - `save_draft` bắt buộc `created_by` + ghi 1 dòng `agent_action_log`
    (`draft_create`) cùng transaction. `--verify-log` kiểm hash chain.
  - `schedule` chỉ trên draft approved + ngày ≥ hôm nay giờ VN + text
    còn khớp sha bản đã duyệt; bắt buộc người xếp lịch (`--by`).
  - Giới hạn (pilot): `--by`/`reviewer` vẫn là free-text — DB tin
    người giữ DSN `app_human`; gắn login DB riêng từng người là
    someday. Gọi thẳng `approve_draft` bằng DSN `app_human` (bỏ qua
    module này) thì chỉ còn kiểm snapshot guardrail, không re-check.
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
  python -m pipelines.store --schedule ID YYYY-MM-DD --by "Tên"
  python -m pipelines.store --calendar [--days 14]
  python -m pipelines.store --verify-log
"""

import argparse
import hashlib
import sys
from contextlib import contextmanager, suppress
from datetime import date, datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect
from pipelines.guardrail import check as guardrail_check

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
OBJECT_TYPE = "content_draft"
# Việt Nam không có DST — offset cố định, không cần tzdata.
VN_TZ = timezone(timedelta(hours=7))

COLS = ("id", "created_at", "brief", "channel", "text", "guardrail",
        "status", "reviewer", "reviewed_at", "review_note",
        "scheduled_date", "source", "created_by")

_INSERT_SQL = (
    "insert into content_drafts (brief, channel, text, guardrail, source, "
    "created_by) values (%s, %s, %s, %s, %s, %s) returning id")

_LOG_SQL = (
    "insert into agent_action_log (actor, action, object_type, object_id, "
    "detail) values (%s, %s, %s, %s, %s)")


def content_sha256(text: str) -> str:
    """sha256 hex byte-exact UTF-8, không normalize — khớp PG
    `encode(sha256(convert_to(t, 'UTF8')), 'hex')`."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _db_msg(e: Exception) -> str:
    """Thông điệp lỗi function DB (raise tiếng Việt) — không kèm
    context/SQL."""
    diag = getattr(e, "diag", None)
    return (getattr(diag, "message_primary", None) or str(e)).strip()

_SELECT_SQL = f"select {', '.join(COLS)} from content_drafts"


def save_draft(conn, brief: str, channel: str, text: str,
               guardrail: dict, source: str = SOURCE_STUDIO, *,
               created_by: str | None = None):
    """INSERT 1 draft → id. `guardrail` = snapshot kết quả
    `pipelines.guardrail.check()` lúc sinh (jsonb). Channel lạ vẫn
    ghi nguyên văn (draft của người — DB không chặn vocab, queue
    hiển thị đúng thứ đã lưu). `created_by` BẮT BUỘC (rỗng →
    ValueError trước khi chạm DB) — không có người tạo thì không kiểm
    được "người duyệt ≠ người tạo". Ghi kèm 1 dòng log `draft_create`
    cùng transaction. commit() tường minh — xem docstring module."""
    by = (created_by or "").strip()
    if not by:
        raise ValueError("save_draft: thiếu created_by (người/agent tạo)")
    text = text or ""
    with conn.transaction():
        row = conn.execute(
            _INSERT_SQL,
            ((brief or "").strip(), (channel or "").strip(), text,
             Jsonb(guardrail or {}), source, by)).fetchone()
        did = row[0] if row else None
        if did is not None:
            conn.execute(_LOG_SQL, (
                by, "draft_create", OBJECT_TYPE, str(did),
                Jsonb({"channel": (channel or "").strip(),
                       "source": source,
                       "content_sha256": content_sha256(text)})))
    conn.commit()
    return did


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


def _same_person(a, b) -> bool:
    """So khớp người như function DB: lower(btrim(.))."""
    return (a or "").strip().lower() == (b or "").strip().lower()


def set_status(conn, draft_id, status: str, reviewer: str,
               note: str | None = None) -> tuple[bool, str | None]:
    """pending -> approved|rejected → (True, None) | (False, warn).

    Warn không raise: id không tồn tại / id không phải số / draft
    không còn pending / approve khi guardrail chưa ok (snapshot HOẶC
    chạy lại check() trên text từ DB) / thiếu người tạo / người duyệt
    = người tạo / thiếu tên người duyệt / status đích lạ / function DB
    từ chối (thông điệp của function). Chuyển trạng thái CHỈ qua
    `approve_draft` / `reject_draft` (DB là nguồn sự thật; pre-check
    Python chỉ để warn thân thiện)."""
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
    if status == "approved":
        g = cur["guardrail"]
        if not (isinstance(g, dict) and g.get("ok") is True):
            return False, (f"draft #{did} vi phạm guardrail (ok != true) "
                           f"— phải reject hoặc viết lại; không có "
                           f"duyệt-kèm-ghi-nhận")
        # Snapshot jsonb do agent ghi — có thể giả ok:true. Chạy LẠI
        # guardrail trên text thật trong DB trước khi gọi function.
        recheck = guardrail_check(cur["text"] or "")
        if not recheck.get("ok"):
            return False, (f"draft #{did} vi phạm guardrail khi kiểm lại "
                           f"text ({len(recheck.get('violations', []))} "
                           f"vi phạm) — snapshot lúc lưu không khớp; "
                           f"phải reject hoặc viết lại")
        if not (cur.get("created_by") or "").strip():
            return False, (f"draft #{did} không có người tạo (draft trước "
                           f"v3.4) — không duyệt được, reject rồi tạo lại")
        if _same_person(cur.get("created_by"), reviewer):
            return False, (f"bạn là người tạo draft #{did} — cần người "
                           f"khác duyệt")
        sql = "select approve_draft(%s, %s, %s)"
    else:
        sql = "select reject_draft(%s, %s, %s)"
    try:
        with conn.transaction():
            conn.execute(sql, (did, reviewer.strip(), (note or None)))
        conn.commit()
    except psycopg.Error as e:
        return False, f"draft #{did}: {_db_msg(e)}"
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


def _vn_today() -> date:
    return datetime.now(VN_TZ).date()


def schedule(conn, draft_id, day, by: str | None = None,
             today: date | None = None) -> tuple[bool, str | None]:
    """Xếp lịch đăng → (True, None) | (False, warn). Chỉ draft
    approved; `day` (date/ISO-str) không được quá khứ (giờ VN — function
    DB kiểm lại); `by` = người xếp lịch, bắt buộc. Đi qua
    `schedule_draft` (kiểm thêm text còn khớp sha bản đã duyệt).
    `today` inject được cho test."""
    if not (by or "").strip():
        return False, "thiếu tên người xếp lịch (--by) — bắt buộc cho audit"
    d = _coerce_date(day)
    if d is None:
        return False, (f"ngày '{day}' không hợp lệ — định dạng "
                       f"YYYY-MM-DD")
    today = today or _vn_today()
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
            conn.execute("select schedule_draft(%s, %s, %s)",
                         (did, d, by.strip()))
        conn.commit()
    except psycopg.Error as e:
        return False, f"draft #{did}: {_db_msg(e)}"
    return True, None


def verify_publish(conn, draft_id, text: str) -> bool:
    """Bản sắp đăng có đúng bản đã duyệt? → True chỉ khi quyết định mới
    nhất của draft là approved VÀ sha256(text) khớp. Lỗi DB/id xấu →
    False (fail-closed)."""
    try:
        did = int(draft_id)
        row = conn.execute("select verify_publish(%s, %s, %s)",
                           (OBJECT_TYPE, str(did), text)).fetchone()
    except (TypeError, ValueError, psycopg.Error):
        return False
    return bool(row and row[0] is True)


def verify_log(conn) -> tuple[int, list[tuple]]:
    """Kiểm hash chain `agent_action_log` → (số dòng, [(id, problem)]).
    List rỗng = nguyên vẹn (trừ xóa dòng CUỐI — cần neo ngoài)."""
    n = conn.execute("select count(*) from agent_action_log").fetchone()[0]
    probs = [tuple(r) for r in conn.execute(
        "select id, problem from verify_action_log()").fetchall()]
    return n, probs


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
                    help="tên người duyệt/xếp lịch — bắt buộc với "
                         "--approve/--reject/--schedule (free-text: DB "
                         "tin người giữ DSN app_human)")
    ap.add_argument("--note", default=None, help="ghi chú duyệt")
    ap.add_argument("--schedule", nargs=2,
                    metavar=("ID", "YYYY-MM-DD"),
                    help="xếp lịch đăng cho draft approved")
    ap.add_argument("--calendar", action="store_true",
                    help="xem lịch đăng sắp tới")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"số ngày lịch (mặc định {DEFAULT_DAYS})")
    ap.add_argument("--verify-log", action="store_true",
                    help="kiểm hash chain agent_action_log (exit 1 nếu "
                         "phát hiện sửa/xóa)")
    args = ap.parse_args(argv)

    n_ops = (sum(w is not None
                 for w in (args.approve, args.reject, args.schedule))
             + args.pending + args.calendar + args.verify_log)
    if n_ops == 0:
        ap.error("cần 1 thao tác: --pending | --calendar | "
                 "--approve | --reject | --schedule | --verify-log")
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần — tách lệnh")
    if (args.approve is not None or args.reject is not None) \
            and not (args.reviewer or "").strip():
        ap.error("--approve/--reject cần --by <tên người duyệt>")
    if args.schedule is not None and not (args.reviewer or "").strip():
        ap.error("--schedule cần --by <tên người xếp lịch>")

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

        if args.verify_log:
            # Kiểm toàn vẹn: DB down → exit 2 (không kết luận được).
            if conn is None:
                print(f"[error] {err} — không kiểm được", file=sys.stderr)
                return 2
            try:
                n, probs = verify_log(conn)
            except psycopg.Error as e:
                print(f"[error] lỗi DB khi kiểm log: {_db_msg(e)}",
                      file=sys.stderr)
                return 2
            if not probs:
                print(f"[ok] chuỗi nguyên vẹn ({n} dòng)")
                return 0
            print(f"[FAIL] hash chain agent_action_log hỏng — "
                  f"{len(probs)} vấn đề / {n} dòng:")
            for lid, prob in probs:
                print(f"  id={lid} problem={prob}")
            return 1

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
        ok, warn = schedule(conn, did, day_s, args.reviewer)
        if not ok:
            print(f"[warn] {warn}", file=sys.stderr)
            return 2
        print(f"[done] draft #{did} xếp lịch {day_s} (người xếp: "
              f"{args.reviewer.strip()}) — người đăng tay (hệ thống "
              f"không tự đăng)")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
