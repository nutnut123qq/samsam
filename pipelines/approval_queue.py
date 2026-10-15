"""v4.0 W40.3 — hàng duyệt dùng chung (`approval_queue`) cho MỌI loại
object trừ `content_draft` (giữ đường `pipelines.store` v3.4).

Contract:
  - DB là nguồn sự thật: mọi chuyển trạng thái đi qua function SECURITY
    DEFINER trong `docs/schema.sql` — `enqueue_item`, `decide_item`,
    `auto_approve_item`, `override_qa`, `expire_overdue`. Module này KHÔNG
    UPDATE bảng trực tiếp; role `agent_writer` không gọi được `decide_item`/
    `override_qa` (agent không tự duyệt được).
  - `enqueue` TỰ chạy `pipelines.guardrail.check(payload)` — không nhận
    guardrail từ caller (agent không giả `ok:true` được). `created_by`/
    `payload` rỗng → `ValueError` trước khi chạm DB.
  - `decide` approve: đọc payload TỪ DB, chạy LẠI guardrail — không ok →
    (False, msg) KHÔNG gọi function. Lỗi function (`psycopg.Error`) →
    (False, thông điệp tiếng Việt của function), không raise.
  - Hai lớp duyệt: per_item (người, `decide`) và auto_policy (`auto_approve`
    — chỉ khi có luật bật + đã ký cho đúng loại, risk low, QA pass; mặc
    định KHÔNG có luật nào → fail-closed). Quá SLA → `expire_overdue` đánh
    expired, không bao giờ tự duyệt. QA FAIL muốn trình vẫn phải
    `override` (lý do ≥10 ký tự, người ≠ người tạo) rồi người khác `decide`.
  - Ghi trên conn chia sẻ: `conn.transaction()` + `conn.commit()` tường
    minh (gotcha savepoint v2.1).
  - v13.3 cưỡng chế giai đoạn (`pipelines.rollout.mode`, HĐ 6.7) — mục
    gắn tính năng qua `output_sources` (khối + loại [+ created_by]):
    `enqueue` của tính năng `tat` → RolloutBlocked (ValueError); `decide`
    approve mục của tính năng `tat` → (False, lý do); `verify` (cổng DÙNG
    của mọi --verify-send/--export/áp dụng) → False + lý do ở stderr khi
    `chay_thu`/`tat`/không thuộc danh mục, `co_nguoi_duyet` chỉ mục NGƯỜI
    duyệt từng mục.
  - Giới hạn pilot: `--by` free-text (SSO thật = external-dep).

Chạy:
  python -m pipelines.approval_queue --pending [--block K]
  python -m pipelines.approval_queue --approve ID --by "Tên" [--note ".."]
  python -m pipelines.approval_queue --reject  ID --by "Tên" [--note ".."]
  python -m pipelines.approval_queue --override-qa ID --by "Tên" --reason ".."
  python -m pipelines.approval_queue --expire
Exit: 0 ok · 1 quyết định bị từ chối · 2 tham số sai / DB down.
"""

import argparse
import sys
from contextlib import suppress

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect
from pipelines.guardrail import check as guardrail_check
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DECISIONS = ("approved", "rejected")
PREVIEW = 200
COLS = ("id", "object_type", "object_id", "block", "title", "preview",
        "risk", "qa_status", "guardrail_ok", "created_by", "created_at",
        "due_at", "status")


def enqueue(conn, *, object_type: str, object_id: str, block: str,
            title: str, payload: str, risk: str, created_by: str,
            sla_hours: int, qa_status: str = "none") -> int:
    """Đẩy 1 mục vào hàng → id. Guardrail do module tự tính."""
    by = (created_by or "").strip()
    if not by:
        raise ValueError("enqueue: thiếu created_by (người/agent tạo)")
    if not (payload or "").strip():
        raise ValueError("enqueue: payload rỗng")
    # v13.3 (HĐ 6.7): tính năng TẮT không sinh đầu ra (RolloutBlocked là
    # ValueError — caller đã xử lý như tham số sai). Chạy thử vẫn ghi.
    _rollout().check_generate(conn, _feature_of((block, object_type, by)),
                              f"hàng duyệt {block}/{object_type}")
    g = guardrail_check(payload)
    with conn.transaction():
        row = conn.execute(
            "select enqueue_item(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (object_type, str(object_id), block, title or "", payload, risk,
             Jsonb(g), qa_status, by, sla_hours)).fetchone()
    conn.commit()
    return row[0]


def _call(conn, sql: str, params: tuple, label: str):
    """Gọi function quyết định trong savepoint + commit → (True, kết quả) |
    (False, thông điệp lỗi của function)."""
    try:
        with conn.transaction():
            row = conn.execute(sql, params).fetchone()
        conn.commit()
    except psycopg.Error as e:
        return False, f"{label}: {_db_msg(e)}"
    return True, (row[0] if row else None)


def _id(item_id):
    try:
        return int(item_id)
    except (TypeError, ValueError):
        return None


def decide(conn, item_id, decider: str, decision: str,
           note: str | None = None) -> tuple[bool, str | None]:
    """Người quyết từng mục (per_item) → (True, None) | (False, msg)."""
    if decision not in DECISIONS:
        return False, f"quyết định '{decision}' không hợp lệ — approved|rejected"
    if not (decider or "").strip():
        return False, "thiếu tên người duyệt (--by)"
    qid = _id(item_id)
    if qid is None:
        return False, f"id '{item_id}' không hợp lệ"
    if decision == "approved":
        try:
            # Savepoint: role không đọc được payload (agent_writer — chỉ
            # có cột metadata) → lỗi không làm hỏng tx của conn chia sẻ.
            with conn.transaction():
                row = conn.execute("select payload from approval_queue"
                                   " where id = %s", (qid,)).fetchone()
                meta = _meta(conn, qid)
        except psycopg.Error as e:
            return False, f"mục #{qid}: {_db_msg(e)}"
        if row is None:
            return False, f"không tìm thấy mục #{qid} trong hàng duyệt"
        # v13.3 (HĐ 6.7): tính năng TẮT → mục chờ của nó không duyệt được.
        if meta is not None:
            why = _rollout().decide_reason(conn, _feature_of(meta[:3]),
                                           f"mục #{qid}")
            if why:
                return False, why
        # Snapshot guardrail lúc enqueue có thể cũ/giả — kiểm lại payload.
        recheck = guardrail_check(row[0] or "")
        if not recheck.get("ok"):
            return False, (f"mục #{qid} vi phạm guardrail khi kiểm lại "
                           f"({len(recheck.get('violations', []))} vi phạm)"
                           f" — phải reject hoặc viết lại")
    ok, res = _call(conn, "select decide_item(%s, %s, %s, %s)",
                    (qid, decider.strip(), decision, note or None),
                    f"mục #{qid}")
    return (True, None) if ok else (False, res)


def override(conn, item_id, by: str, reason: str) -> tuple[bool, str | None]:
    """Ép trình bản QA FAIL (ghi decisions override_qa) — KHÔNG duyệt."""
    qid = _id(item_id)
    if qid is None:
        return False, f"id '{item_id}' không hợp lệ"
    # Đếm ký tự không phải khoảng trắng — lý do toàn \n/\t không phải lý do.
    if len("".join((reason or "").split())) < 10:
        return False, (f"mục #{qid}: lý do override_qa phải ≥ 10 ký tự "
                       "(không tính khoảng trắng)")
    ok, res = _call(conn, "select override_qa(%s, %s, %s)",
                    (qid, (by or "").strip(), reason), f"mục #{qid}")
    return (True, None) if ok else (False, res)


def auto_approve(conn, item_id) -> tuple[bool, str | None]:
    """Lane auto_policy — fail-closed khi không có luật đã ký."""
    qid = _id(item_id)
    if qid is None:
        return False, f"id '{item_id}' không hợp lệ"
    ok, res = _call(conn, "select auto_approve_item(%s)", (qid,),
                    f"mục #{qid}")
    return (True, None) if ok else (False, res)


def expire_overdue(conn, by: str = "system:sla") -> int:
    """Mục pending quá SLA → expired (không bao giờ approved) → số mục."""
    with conn.transaction():
        n = conn.execute("select expire_overdue(%s)", (by,)).fetchone()[0]
    conn.commit()
    return n


def pending(conn, block: str | None = None) -> list[dict]:
    """Mục đang chờ (cũ nhất trước) — payload chỉ cắt PREVIEW ký tự."""
    sql = ("select id, object_type, object_id, block, title,"
           " left(payload, %s), risk, qa_status,"
           " coalesce(guardrail->>'ok', '') = 'true', created_by,"
           " created_at, due_at, status from approval_queue"
           " where status = 'pending'")
    params: list = [PREVIEW]
    if block:
        sql += " and block = %s"
        params.append(block)
    rows = conn.execute(sql + " order by due_at, id", params).fetchall()
    return [dict(zip(COLS, r)) for r in rows]


def verify(conn, item_id, text: str) -> bool:
    """Bản sắp phát hành có đúng bản đã duyệt của object mục này? Lỗi/không
    thấy → False (fail-closed)."""
    qid = _id(item_id)
    if qid is None:
        return False
    try:
        row = conn.execute("select object_type, object_id from approval_queue"
                           " where id = %s", (qid,)).fetchone()
        if row is None:
            return False
        # v13.3 (HĐ 6.7): verify là cổng DÙNG chung (--verify-send/--export/
        # áp dụng) — chạy thử/tắt không lọt, có người duyệt chỉ mục người
        # duyệt từng mục (không auto_policy/agent).
        meta = _meta(conn, qid)
        why = None if meta is None else use_reason(conn, meta)
        if why:
            print(f"[rollout] TỪ CHỐI DÙNG mục #{qid}: {why}",
                  file=sys.stderr)
            return False
        res = conn.execute("select verify_publish(%s, %s, %s)",
                           (row[0], row[1], text)).fetchone()
    except psycopg.Error:
        return False
    return bool(res and res[0] is True)


def _rollout():
    from pipelines import rollout  # lười: rollout → director → module này
    return rollout


def _feature_of(meta) -> str | None:
    """(block, object_type, created_by) → id tính năng theo danh mục."""
    block, otype, by = meta
    return _rollout().feature_for(table="approval_queue", block=block,
                                  object_type=otype, created_by=by)


_META_SQL = ("select block, object_type, created_by, status, lane,"
             " decided_by from approval_queue where id = %s")


def _meta(conn, qid):
    """Metadata cho cổng giai đoạn — CHỈ đọc khi cưỡng chế cần DB
    (`quick_mode()` không phải 'van_hanh'); cưỡng chế tắt / test ép vận
    hành → None (không thêm truy vấn). Mục không có → ('', '', '', None,
    None, None) để vẫn fail-closed."""
    if _rollout().quick_mode() == "van_hanh":
        return None
    r = conn.execute(_META_SQL, (qid,)).fetchone()
    return tuple(r) if r else ("", "", "", None, None, None)


def use_reason(conn, meta) -> str | None:
    """meta = (block, object_type, created_by, status, lane, decided_by) →
    lý do chặn dùng | None."""
    ro = _rollout()
    human = (meta[3] == "approved" and meta[4] == "per_item"
             and ro.is_human(meta[5]))
    return ro.use_reason(conn, _feature_of(meta[:3]),
                         f"mục {meta[0]}/{meta[1]}", human)


def _print_item(d: dict) -> None:
    g = "PASS" if d["guardrail_ok"] else "VI PHẠM"
    due = d["due_at"].strftime("%m-%d %H:%M") if d.get("due_at") else ""
    print(f"  #{d['id']} [{d['block']}/{d['object_type']}] "
          f"{_oneline(_mask_pii(d['title'] or ''))} — rủi ro {d['risk']}, "
          f"QA {d['qa_status']}, guardrail {g}, tạo bởi "
          f"{d['created_by']}, hạn {due}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.approval_queue",
        description="Hàng duyệt dùng chung — NGƯỜI duyệt từng mục; quá SLA "
                    "→ expired, không tự duyệt")
    ap.add_argument("--pending", action="store_true",
                    help="liệt kê mục đang chờ")
    ap.add_argument("--block", help="lọc theo khối (với --pending)")
    ap.add_argument("--approve", type=int, metavar="ID")
    ap.add_argument("--reject", type=int, metavar="ID")
    ap.add_argument("--override-qa", type=int, metavar="ID",
                    help="ép trình mục QA FAIL (cần --reason, vẫn phải "
                         "người khác --approve)")
    ap.add_argument("--expire", action="store_true",
                    help="đánh expired mọi mục quá SLA")
    ap.add_argument("--by", help="tên người quyết (free-text — SSO là "
                                 "external-dep)")
    ap.add_argument("--note", default=None)
    ap.add_argument("--reason", default=None,
                    help="lý do override QA (≥ 10 ký tự)")
    args = ap.parse_args(argv)

    n_ops = (sum(v is not None for v in (args.approve, args.reject,
                                          args.override_qa))
             + args.pending + args.expire)
    if n_ops == 0:
        ap.error("cần 1 thao tác: --pending | --approve | --reject | "
                 "--override-qa | --expire")
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần — tách lệnh")
    by = (args.by or "").strip()
    if (args.approve is not None or args.reject is not None
            or args.override_qa is not None) and not by:
        ap.error("--approve/--reject/--override-qa cần --by <tên người>")
    if args.override_qa is not None and not (args.reason or "").strip():
        ap.error("--override-qa cần --reason <lý do>")

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.pending:
            rows = pending(conn, args.block)
            if not rows:
                print("[pending] hàng duyệt chung trống")
            else:
                print(f"[pending] {len(rows)} mục chờ duyệt:")
                for d in rows:
                    _print_item(d)
            return 0
        if args.expire:
            n = expire_overdue(conn, by or "system:sla")
            print(f"[done] {n} mục quá SLA → expired (không tự duyệt)")
            return 0
        if args.override_qa is not None:
            ok, msg = override(conn, args.override_qa, by, args.reason)
            if not ok:
                print(f"[warn] {msg}", file=sys.stderr)
                return 1
            print(f"[done] mục #{args.override_qa}: ghi override_qa (người: "
                  f"{by}) — vẫn cần người khác --approve")
            return 0
        qid = args.approve if args.approve is not None else args.reject
        dec = "approved" if args.approve is not None else "rejected"
        ok, msg = decide(conn, qid, by, dec, args.note)
        if not ok:
            print(f"[warn] {msg}", file=sys.stderr)
            return 1
        print(f"[done] mục #{qid} → {dec} (người duyệt: {by})")
        return 0
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
