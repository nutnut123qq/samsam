"""v8.3 DA-01 — sổ mốc tiến độ triển khai + bảng tuần (PMO).

v12.0: phòng Dự án đã gỡ (ngoài phạm vi HĐ TEDO–Sâm Sâm) — module này GIỮ
và chuyển sang khối **ceo**, thuộc tính năng "Theo dõi tiến độ, sổ quyết
định" (cùng `agents/ceo_decisions.py` đọc `project_milestones`).

Contract:
  - `data/projects/milestones.json` (BẢN DEV SOẠN, chờ TGĐ chốt) →
    bảng `project_milestones`. `--seed` chỉ thêm mốc chưa có (`on conflict
    (code) do nothing`) — sửa tay trên DB KHÔNG bị đè.
  - `--set-status` đổi trạng thái; `xong` bắt buộc `--evidence` (DB cũng
    CHECK). `--board`: `render_board(rows, today)` THUẦN — mốc quá hạn chưa
    xong tô **TRỄ** + mục "Mốc trễ"; nhắc T-7/T-2 đúng ngày; hạn dd/mm/yyyy.
    `--submit` đẩy bảng vào hàng duyệt khối ceo (`weekly_board`).
    `--submit` chạy `guardrail.check` TRƯỚC — trượt (vd gate/evidence có
    chữ nhóm rượu/từ cấm) → exit 1, KHÔNG đẩy (mục trượt không duyệt được).
  - Đổi hạn KHÔNG sửa thẳng DB: `--propose-due` đẩy mục `milestone_change`
    (payload tất định code/old_due/new_due/by; `created_by` = NGƯỜI đề
    xuất → người đó không tự duyệt được, DB `decide_item` chặn);
    `--apply-due` chỉ cập nhật khi mục approved VÀ payload dựng lại khớp
    sha256 bản duyệt VÀ hạn hiện tại == old_due; chạy lại = no-op.
  - v13.8 C10 (PL01 mục 7): mốc HĐ chưa tính được ngày (`moc_chua_co_ngay`
    — phụ thuộc ngày ký chưa chốt / HĐ để trống) KHÔNG seed (due_date bắt
    buộc), `--board` liệt kê riêng mục "Mốc chưa có ngày" kèm blocker — không
    tự điền ngày. `--seed` báo [lệch] mốc đã có trên DB mà title/hạn/gate
    khác file (DB giữ nguyên; hạn đổi qua `--propose-due`).
  - Không mạng, không LLM. Ngày "hôm nay" theo giờ VN.

Chạy:
  python -m agents.da_pmo --seed [--dry-run]
  python -m agents.da_pmo --set-status CODE --status S --by NAME [--evidence REF]
  python -m agents.da_pmo --board [--date YYYY-MM-DD] [--out-dir DIR] [--submit]
  python -m agents.da_pmo --propose-due CODE --due YYYY-MM-DD --by NAME
  python -m agents.da_pmo --apply-due QUEUE_ID --by NAME
Exit: 0 ok · 1 bị từ chối (thiếu evidence / chưa duyệt / lệch / stale) ·
2 tham số sai / DB down / lỗi DB.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import auth, director, guardrail
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MILESTONES_FILE = ROOT / "data" / "projects" / "milestones.json"
SOURCE = "data/projects/milestones.json"
STATUSES = ("chua_bat_dau", "dang_lam", "xong", "tam_dung")
CODE_RE = re.compile(r"[A-Z][A-Z0-9_.-]{1,31}")
BLOCK = "ceo"
LEGACY_BLOCK = "projects"   # khối cũ trước v12.0 (đã gỡ)
CREATED_BY = "agent:da_pmo"
COLS = ("code", "title", "wp", "owner_role", "due_date", "gate", "evidence",
        "status")
_PAYLOAD_RE = re.compile(
    r"# Đề xuất đổi hạn mốc (?P<c>\S+)\n\ncode: (?P=c)\nold_due: "
    r"(?P<old>\d{4}-\d{2}-\d{2})\nnew_due: (?P<new>\d{4}-\d{2}-\d{2})\n"
    r"by: (?P<by>[^\n]+)\n\nĐổi hạn chỉ có hiệu lực sau khi người duyệt "
    r"\(agent không tự đổi\)\.\n")


def load_milestones(path: Path = MILESTONES_FILE) -> list[dict]:
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        items = doc["milestones"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    out, seen = [], set()
    for i, m in enumerate(items if isinstance(items, list) else []):
        if not isinstance(m, dict) or not CODE_RE.fullmatch(
                str(m.get("code", ""))) or m["code"] in seen:
            raise ValueError(f"milestones[{i}].code: thiếu/sai/trùng")
        for k in ("title", "owner_role", "gate", "due_date"):
            if not isinstance(m.get(k), str) or not m[k].strip():
                raise ValueError(f"{m['code']}.{k}: thiếu")
        try:
            due = date.fromisoformat(m["due_date"])
        except ValueError:
            raise ValueError(f"{m['code']}.due_date: cần YYYY-MM-DD") \
                from None
        seen.add(m["code"])
        out.append({**m, "due_date": due})
    if not out:
        raise ValueError(f"{Path(path).name}: 0 mốc")
    return out


UNDATED_KEYS = ("title", "owner_role", "han_theo_hd", "blocker")


def load_undated(path: Path | None = None) -> list[dict]:
    """Mốc HĐ chưa có ngày (`moc_chua_co_ngay`, tùy chọn). Sai dạng / trùng
    mã với mốc có ngày → ValueError (bảng tuần không âm thầm bỏ mốc)."""
    path = Path(path or MILESTONES_FILE)
    try:
        doc = json.loads(path.read_bytes().decode("utf-8"))
        items = doc.get("moc_chua_co_ngay", [])
    except (OSError, UnicodeDecodeError, ValueError, AttributeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    dated = {m.get("code") for m in doc.get("milestones") or ()
             if isinstance(m, dict)}
    if not isinstance(items, list):      # loader chỉ ném ValueError
        raise ValueError("moc_chua_co_ngay: phải là list")  # noqa: TRY004
    out, seen = [], set()
    for i, m in enumerate(items):
        code = m.get("code") if isinstance(m, dict) else None
        if not CODE_RE.fullmatch(str(code or "")) or code in seen \
                or code in dated:
            raise ValueError(f"moc_chua_co_ngay[{i}].code: thiếu/sai/trùng")
        for k in UNDATED_KEYS:
            if not isinstance(m.get(k), str) or not m[k].strip():
                raise ValueError(f"{code}.{k}: thiếu")
        seen.add(code)
        out.append(m)
    return out


def seed(conn, items: list[dict], dry_run: bool = False) -> dict:
    st = {"inserted": 0, "existing": 0, "drift": []}
    for m in items:
        old = conn.execute("select title, due_date, gate from"
                           " project_milestones where code = %s",
                           (m["code"],)).fetchone()
        if old is not None and tuple(old) != (m["title"], m["due_date"],
                                              m["gate"]):
            st["drift"].append(m["code"])
        if dry_run:
            st["existing" if old else "inserted"] += 1
            continue
        cur = conn.execute(
            "insert into project_milestones (code, title, wp, owner_role,"
            " due_date, gate, source, updated_by) values (%s, %s, %s, %s,"
            " %s, %s, %s, 'seed') on conflict (code) do nothing",
            (m["code"], m["title"], m.get("wp"), m["owner_role"],
             m["due_date"], m["gate"], SOURCE))
        st["inserted" if cur.rowcount == 1 else "existing"] += 1
    conn.commit()
    return st


def _d(x: date) -> str:
    return x.strftime("%d/%m/%Y")


def _md(s, n: int = 120) -> str:
    return _oneline(_mask_pii(str(s or "")), n).replace("|", "\\|") or "—"


def week_id(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def render_board(rows: list[dict], today: date, undated=()) -> str:
    """Bảng tuần markdown (thuần). `undated` = mốc HĐ chưa có ngày."""
    rows = sorted(rows, key=lambda r: (r["due_date"], r["code"]))
    late = [r for r in rows if r["due_date"] < today and r["status"] != "xong"]
    late_codes = {r["code"] for r in late}
    L = [(f"# Bảng tiến độ triển khai — tuần {week_id(today)} "
          f"(ngày {_d(today)})"), "",
         "| Mã | Việc | Owner | Hạn | Gate | Evidence | Trạng thái |",
         "|---|---|---|---|---|---|---|"]
    for r in rows:
        st = r["status"]
        if r["code"] in late_codes:
            st = f"**TRỄ** ({st})"
        L.append(f"| {r['code']} | {_md(r['title'])} | {_md(r['owner_role'])}"
                 f" | {_d(r['due_date'])} | {_md(r['gate'], 160)} | "
                 f"{_md(r.get('evidence')) if r.get('evidence') else 'chưa có'}"
                 f" | {st} |")
    L += ["", "## Mốc trễ", ""]
    L += [f"- **TRỄ** {r['code']} — hạn {_d(r['due_date'])} (trễ "
          f"{(today - r['due_date']).days} ngày, {r['status']})"
          for r in late] or ["- (không có)"]
    L += ["", "## Nhắc hạn hôm nay", ""]
    rem = []
    for r in rows:
        left = (r["due_date"] - today).days
        if r["status"] != "xong" and left in (7, 2):
            rem.append(f"- T-{left}: {r['code']} — hạn {_d(r['due_date'])}")
    L += rem or ["- (không có)"]
    if undated:
        L += ["", "## Mốc chưa có ngày (chờ ngày ký / hai bên chốt)", "",
              "| Mã | Việc | Owner | Hạn theo HĐ | Blocker |",
              "|---|---|---|---|---|"]
        L += [f"| {u['code']} | {_md(u['title'])} | {_md(u['owner_role'])} |"
              f" {_md(u['han_theo_hd'])} | {_md(u['blocker'], 160)} |"
              for u in undated]
    L += ["", "---", ("*BẢN NHÁP — agent không tự gửi; TGĐ chốt "
                      "trạng thái/hạn (đổi hạn qua hàng duyệt).*"), ""]
    return "\n".join(L)


def change_payload(code: str, old_due: date, new_due: date, by: str) -> str:
    return (f"# Đề xuất đổi hạn mốc {code}\n\ncode: {code}\n"
            f"old_due: {old_due.isoformat()}\nnew_due: {new_due.isoformat()}"
            f"\nby: {by}\n\nĐổi hạn chỉ có hiệu lực sau khi người duyệt "
            "(agent không tự đổi).\n")


def apply_due(conn, qid: int, by: str) -> tuple[bool, str]:
    """Áp hạn của mục `milestone_change` ĐÃ duyệt → (ok, thông điệp).

    v15 fix P10.2: kiểm đọc ở đây (thông điệp rõ + cổng rollout biên dùng
    `aq.verify`), GHI qua function `milestone_apply_due_human` (SECURITY
    DEFINER — login người `app_human` không có UPDATE bảng; DB tự kiểm lại
    mục đã duyệt, sha bản duyệt, hạn cũ; danh tính theo login). DB từ chối
    danh tính → `auth.HumanDenied` (caller in [từ chối])."""
    row = conn.execute("select block, object_type, status, payload,"
                       " object_id from approval_queue where id = %s",
                       (qid,)).fetchone()
    # v12.0: đề xuất đổi hạn nộp trước v12.0 nằm ở khối `projects` (đã gỡ)
    # — vẫn áp dụng được sau khi người duyệt, không kẹt vĩnh viễn.
    if row is None or row[0] not in (BLOCK, LEGACY_BLOCK)             or row[1] != "milestone_change":
        return False, f"mục #{qid} không phải `milestone_change` khối ceo"
    if row[2] != "approved":
        return False, f"mục #{qid} đang '{row[2]}' — chỉ áp dụng khi đã duyệt"
    m = _PAYLOAD_RE.fullmatch(row[3] or "")
    if m is None:
        return False, f"mục #{qid}: payload sai định dạng — không áp dụng"
    try:
        old, new = date.fromisoformat(m["old"]), date.fromisoformat(m["new"])
    except ValueError:
        return False, f"mục #{qid}: ngày trong payload sai lịch"
    code = m["c"]
    rebuilt = change_payload(code, old, new, m["by"])
    if row[4] != f"milestone:{code}" or not aq.verify(conn, qid, rebuilt):
        conn.commit()
        return False, f"mục #{qid}: LỆCH bản duyệt (sha256) — không áp dụng"
    try:
        with conn.transaction():
            res = auth.call_human(
                conn, "select milestone_apply_due_human(%s, %s)", (qid, by),
                by=by, block=None, action="apply_due",
                object_type="approval_queue", object_id=qid).fetchone()[0]
    except auth.HumanDenied:
        conn.rollback()
        raise
    except ValueError as e:              # DB từ chối nghiệp vụ (stale...)
        conn.rollback()
        return False, str(e)
    conn.commit()
    if res == "noop":
        return True, f"{code}: hạn đã là {_d(new)} — không đổi (no-op)"
    return True, f"{code}: hạn {_d(old)} → {_d(new)} (mục #{qid})"


def _date_arg(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from None


def _board(conn, a) -> int:
    today = a.date or datetime.now(VN_TZ).date()
    rows = [dict(zip(COLS, r)) for r in conn.execute(
        f"select {', '.join(COLS)} from project_milestones order by"
        " due_date, code").fetchall()]
    conn.commit()
    try:
        undated = load_undated()
    except ValueError as e:
        print(f"[error] {e} — không dựng bảng thiếu mốc", file=sys.stderr)
        return 1
    text = render_board(rows, today, undated)
    # P8.4: sổ mốc dự án (người ghi) — không có đường mẫu.
    path = write_report(text, a.out_dir,
                        f"da-pmo-board-{today:%Y-%m-%d}.md", sample=False)
    print(f"[done] {len(rows)} mốc → {path}")
    if a.submit:
        # Mục trượt guardrail không duyệt được (decide kiểm lại) — chặn sớm.
        g = guardrail.check(text)
        if g.get("ok") is not True:
            hits = sorted({f'{v.get("code")} "{_oneline(v.get("span"), 40)}"'
                           for v in g.get("violations") or ()})
            print(f"[warn] bảng trượt guardrail ({', '.join(hits)}) — mục sẽ"
                  " KHÔNG duyệt được; sửa title/gate/evidence mốc rồi chạy lại"
                  " — KHÔNG đẩy", file=sys.stderr)
            return 1
        try:
            qid = director.submit(conn, BLOCK, "weekly_board",
                                  object_id=f"board:{week_id(today)}",
                                  title=f"Bảng tiến độ triển khai {week_id(today)}",
                                  payload=text, created_by=CREATED_BY)
        except psycopg.errors.UniqueViolation:
            print(f"[warn] bảng {week_id(today)} đã có mục đang chờ duyệt",
                  file=sys.stderr)
            return 1
        print(f"[done] đã đẩy mục #{qid} (PENDING) — TGĐ duyệt")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_pmo",
        description="DA-01 sổ mốc + bảng tuần tiến độ (khối ceo, không tự gửi)")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--set-status", metavar="CODE")
    ap.add_argument("--status", choices=STATUSES)
    ap.add_argument("--evidence")
    ap.add_argument("--board", action="store_true")
    ap.add_argument("--date", type=_date_arg)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--propose-due", metavar="CODE")
    ap.add_argument("--due", type=_date_arg)
    ap.add_argument("--apply-due", type=int, metavar="QUEUE_ID")
    ap.add_argument("--by")
    a = ap.parse_args(argv)
    n_ops = (a.seed + a.board + (a.set_status is not None)
             + (a.propose_due is not None) + (a.apply_due is not None))
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --seed | --set-status | --board | "
                 "--propose-due | --apply-due")
    by = (a.by or "").strip()
    if (a.set_status or a.propose_due or a.apply_due is not None) and not by:
        ap.error("--set-status/--propose-due/--apply-due cần --by <tên>")
    if (a.set_status is None) != (a.status is None):
        ap.error("--set-status cần --status (và --status chỉ đi với "
                 "--set-status)")
    if a.evidence and a.set_status is None:
        ap.error("--evidence chỉ dùng với --set-status")
    if a.propose_due is not None and a.due is None:
        ap.error("--propose-due cần --due YYYY-MM-DD")
    if (a.dry_run and not a.seed) or (a.submit and not a.board):
        ap.error("--dry-run chỉ với --seed; --submit chỉ với --board")
    if a.status == "xong" and not (a.evidence or "").strip():
        print("[warn] status 'xong' cần --evidence (link/biên bản) — không "
              "ghi", file=sys.stderr)
        return 1
    items = None
    if a.seed:
        try:
            items = load_milestones()
        except ValueError as e:
            print(f"[error] {e}", file=sys.stderr)
            return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.seed:
            st = seed(conn, items, a.dry_run)
            print(f"[done] {'would_insert' if a.dry_run else 'inserted'}="
                  f"{st['inserted']} existing={st['existing']}"
                  + (" (dry-run, không ghi)" if a.dry_run else ""))
            for code in st["drift"]:
                print(f"[lệch] {code}: DB giữ bản cũ (title/hạn/gate khác "
                      "file) — TGĐ sửa tay; hạn đổi qua --propose-due",
                      file=sys.stderr)
            return 0
        if a.board:
            with job_run("agents.da_pmo") as jr:
                rc = _board(conn, a)
                jr["ok"] = rc == 0
            return rc
        if a.set_status is not None:
            # v15.4 (P10.2): đổi trạng thái mốc (kể cả `xong` = nghiệm thu mốc,
            # căn cứ báo cáo HĐTV) = QUYẾT ĐỊNH của người được Bên B ủy quyền
            # khối ceo (auth.cli_gate).
            why = auth.cli_gate(conn, by, BLOCK, "set_status",
                                "project_milestone", a.set_status)
            if why:
                conn.rollback()
                print(f"[từ chối] {why} — không ghi", file=sys.stderr)
                return 1
            ev = _mask_pii(a.evidence.strip())[:500] if a.evidence else None
            # v15 fix P10.2: ghi qua function SECURITY DEFINER (login người
            # app_human không có UPDATE bảng mốc; DB kiểm lại danh tính theo
            # login + khối ceo + tồn tại + `xong` cần evidence; trùng = no-op).
            try:
                with conn.transaction():
                    res = auth.call_human(
                        conn, "select milestone_set_status_human(%s, %s, %s,"
                        " %s)", (a.set_status, a.status, ev, by), by=by,
                        block=BLOCK, action="set_status",
                        object_type="project_milestone",
                        object_id=a.set_status).fetchone()[0]
            except auth.HumanDenied as e:
                conn.rollback()
                print(f"[từ chối] {e} — không ghi", file=sys.stderr)
                return 1
            except ValueError as e:
                conn.rollback()
                print(f"[warn] {_oneline(str(e), 200)} — không ghi",
                      file=sys.stderr)
                return 1
            conn.commit()
            if res == "noop":
                print(f"[done] {a.set_status} đã ở {a.status} — không đổi"
                      " (no-op)")
                return 0
            print(f"[done] {a.set_status} → {a.status}")
            return 0
        if a.propose_due is not None:
            row = conn.execute("select due_date from project_milestones where"
                               " code = %s", (a.propose_due,)).fetchone()
            if row is None:
                print(f"[warn] không có mốc {_oneline(a.propose_due, 40)}",
                      file=sys.stderr)
                return 1
            if row[0] == a.due:
                print("[warn] hạn mới trùng hạn hiện tại — không đề xuất",
                      file=sys.stderr)
                return 1
            who = _oneline(_mask_pii(by), 100)
            try:
                # created_by = người đề xuất (không phải agent) — decide_item
                # chặn người duyệt trùng người tạo → không tự duyệt hạn mình.
                qid = director.submit(
                    conn, BLOCK, "milestone_change",
                    object_id=f"milestone:{a.propose_due}",
                    title=f"Đổi hạn {a.propose_due}: {_d(row[0])} → "
                    f"{_d(a.due)}", payload=change_payload(
                        a.propose_due, row[0], a.due, who),
                    created_by=who)
            except psycopg.errors.UniqueViolation:
                print(f"[warn] mốc {a.propose_due} đã có đề xuất đang chờ",
                      file=sys.stderr)
                return 1
            print(f"[done] đề xuất mục #{qid} (PENDING) — hạn CHƯA đổi")
            return 0
        # v15.4 (P10.2): áp hạn = THỰC THI mục đã duyệt (quyết định nằm ở
        # decide_item); chỉ kiểm danh tính người chạy (auth.cli_identity).
        why = auth.cli_identity(conn, by, "approval_queue", a.apply_due,
                                action="apply_due")
        if why:
            conn.rollback()
            print(f"[từ chối] {why} — không ghi", file=sys.stderr)
            return 1
        try:
            ok, msg = apply_due(conn, a.apply_due, by)
        except auth.HumanDenied as e:
            print(f"[từ chối] {e} — không ghi", file=sys.stderr)
            return 1
        print(f"[{'done' if ok else 'warn'}] {msg}",
              file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 1
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
