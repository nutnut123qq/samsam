"""v8.1 W81.2 (WP10) — Agent Tiến độ & Sổ quyết định của TGĐ.

Contract:
  - Sổ `decision_log` (docs/schema.sql v8.1) APPEND-ONLY: 1 dòng `quyet_dinh`
    = 1 quyết định; theo dõi thực hiện = dòng `cap_nhat` mới (trạng thái hiện
    tại = dòng mới nhất theo id của chuỗi — `current_status`). KHÔNG UPDATE.
  - NGƯỜI ghi (`--record`/`--follow` với `--by` tên người — luật
    `agents.ra_kenh.by_error`: rỗng / ký tự điều khiển / 'agent:'/'system:' /
    > 100 ký tự → exit 2 TRƯỚC khi connect; DB CHECK chặn thêm lớp nữa).
    Agent CHỈ ĐỀ XUẤT (`--propose`, chỉ đọc): mục hàng duyệt khối `ceo` đã
    approved/rejected chưa có trong sổ.
  - v14.3 (HĐ 6.7): `--record`/`--follow` KHÔNG qua cổng giai đoạn
    `rollout` — dòng sổ là quyết định NGƯỜI ghi (CHECK chặn agent/system),
    không phải đầu ra AI; tắt ceo-02.2 không được chặn TGĐ ghi quyết định.
    `--propose` chỉ đọc, không ghi gì.
  - Căn cứ phải TỒN TẠI: `approval_queue:ID` (phải approved|rejected — người
    quyết mặc định = `decided_by` của mục, `--decided-by` khác → từ chối),
    `approvals:ID`, `decisions:ID`, hoặc `van_ban` (văn bản ngoài hệ thống —
    `--note` mô tả ≥ 10 ký tự + `--decided-by` bắt buộc). 1 căn cứ → 1 mục.
  - topic/decision/note qua `guardrail.check` TRƯỚC khi ghi (trang TGĐ chép
    topic — mục trượt guardrail làm hỏng trang) rồi lưu bản `_mask_pii`.
  - `--date` (ngày quyết) không ở tương lai; ghi dùng giờ thật — `--now`
    CHỈ cho `--propose`/`--list` (thao tác đọc).
  - Liên kết tiến độ: `late_milestones` dùng CÙNG luật "TRỄ" của
    `agents.da_pmo.render_board` (`due_date < today and status <> 'xong'`);
    `section(conn, today)` → mục "## Tiến độ & Sổ quyết định" cho trang TGĐ
    (`agents.ceo_report`) + bản tin khối ceo. Không mạng, không LLM.

Chạy:
  python -m agents.ceo_decisions --propose [--days 30] [--now ISO]
  python -m agents.ceo_decisions --record --topic T --decision D --by NGƯỜI_GHI
      [--decided-by NGƯỜI_QUYẾT] [--basis approval_queue:ID|approvals:ID|
      decisions:ID|van_ban] [--note ..] [--date YYYY-MM-DD] [--due YYYY-MM-DD]
  python -m agents.ceo_decisions --follow ID --status dang_lam|xong|huy --by NGƯỜI [--note ..]
  python -m agents.ceo_decisions --list [--now ISO]
Exit: 0 ok · 1 bị từ chối (căn cứ không có/chưa quyết, trùng, guardrail,
ngày tương lai, mục đã đóng) · 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta

import psycopg

from agents.ra_kenh import _iso_date, by_error, page_safe, parse_now, safe
from ingest.lead_store import connect
from pipelines.guardrail import check as guardrail_check
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline, _same_person

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

OPEN = ("mo", "dang_lam")
FOLLOW = ("dang_lam", "xong", "huy")
SYS_BASIS = ("approval_queue", "approvals", "decisions")
MAX_TOPIC, MAX_DECISION, MAX_NOTE = 200, 2000, 500
MIN_VAN_BAN_NOTE = 10
# Chủ đề vào trang TGĐ (markdown): cấm link/HTML/ảnh (OWASP A03 — chèn nội
# dung/tracker), cùng luật nhận xét LLM của `agents.ceo_report`.
_MARKUP_RE = re.compile(r"(?i)https?:|www\.|<[a-z/!]|\]\(|javascript:|`")
SHOW = 5
COLS = ("id", "entry_kind", "parent_id", "decided_on", "topic", "decision",
        "decided_by", "basis_kind", "basis_id", "due_date", "follow_status",
        "note", "recorded_by", "recorded_at")
MS_COLS = ("code", "title", "owner_role", "due_date", "status",
           "sign_required")
# Đợt hợp đồng C05 (PL01 Ban TGĐ "việc nào chờ ký"): 3 nguồn có cấu trúc.
_WAIT_Q_SQL = ("select id, object_type, title, due_at from approval_queue"
               " where block = 'ceo' and status = 'pending'"
               " order by due_at nulls last, id")
_WAIT_REV_SQL = ("select quarter, max(recorded_at) from revenue_quarters"
                 " group by quarter order by quarter")
_BASIS_SQL = {
    "approval_queue": ("select status, decided_by, decided_at from"
                       " approval_queue where id = %s"),
    "approvals": ("select decision, approved_by, approved_at from approvals"
                  " where id = %s"),
    "decisions": ("select kind, decided_by, created_at from decisions"
                  " where id = %s"),
}
_PROPOSE_SQL = (
    "select q.id, q.object_type, q.title, q.status, q.decided_by,"
    " q.decided_at from approval_queue q where q.block = 'ceo'"
    " and q.status in ('approved', 'rejected') and q.decided_at > %s"
    " and q.decided_at <= %s and not exists (select 1 from decision_log d"
    " where d.entry_kind = 'quyet_dinh' and d.basis_kind = 'approval_queue'"
    " and d.basis_id = q.id) order by q.decided_at, q.id")
_INSERT_SQL = (
    "insert into decision_log (entry_kind, parent_id, decided_on, topic,"
    " decision, decided_by, basis_kind, basis_id, due_date, follow_status,"
    " note, recorded_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
    " %s) returning id")


def _now() -> datetime:
    """Giờ thật (test monkeypatch — không wall-clock)."""
    return datetime.now(VN_TZ)


def _vn_date(ts) -> date | None:
    if isinstance(ts, datetime) and ts.utcoffset() is not None:
        return ts.astimezone(VN_TZ).date()
    return None


def _d(x) -> str:
    return x.strftime("%d/%m/%Y") if isinstance(x, date) else "—"


def _txt(s, n: int) -> str:
    """Chuỗi từ DB vào trang/terminal: che PII, bỏ ký tự điều khiển, 1 dòng."""
    return _oneline(safe(_mask_pii(str(s or ""))), n) or "—"


def _pg(s, n: int) -> str:
    return page_safe(_txt(s, n))


# ------------------------------------------------------------------ thuần
def current_status(rows: list[dict]) -> str | None:
    """Chuỗi 1 quyết định (dòng quyet_dinh + cap_nhat) → `follow_status` của
    dòng mới nhất theo id. THUẦN."""
    return max(rows, key=lambda r: r["id"])["follow_status"] if rows else None


def chains(rows: list[dict]) -> list[dict]:
    """Mọi dòng `decision_log` → list dòng `quyet_dinh` (theo id) kèm
    `status` = trạng thái hiện tại của chuỗi. THUẦN."""
    by = {r["id"]: [r] for r in rows if r["entry_kind"] == "quyet_dinh"}
    for r in rows:
        if r["entry_kind"] == "cap_nhat" and r["parent_id"] in by:
            by[r["parent_id"]].append(r)
    return [dict(ch[0], status=current_status(ch))
            for _, ch in sorted(by.items())]


def overdue(decisions: list[dict], today: date) -> list[dict]:
    """Quyết định quá hạn thực hiện: hạn < hôm nay (giờ VN) và trạng thái
    hiện tại còn mở/đang làm. Hạn = hôm nay → CHƯA quá hạn. THUẦN."""
    return [d for d in decisions if d.get("due_date") is not None
            and d["due_date"] < today and d.get("status") in OPEN]


def late_milestones(rows: list[dict], today: date) -> list[dict]:
    """Mốc trễ — CÙNG luật `agents.da_pmo.render_board`: `due_date < today
    and status <> 'xong'`, thứ tự (hạn, mã). THUẦN."""
    return [r for r in sorted(rows, key=lambda r: (r["due_date"], r["code"]))
            if r["due_date"] < today and r["status"] != "xong"]


def wait_lines(data: dict, today: date) -> list[str]:
    """Đợt hợp đồng C05 — việc chờ TGĐ QUYẾT (hàng duyệt khối ceo pending)
    tách với CHỜ KÝ (mốc `sign_required` chưa xong; đối soát quý đã ghi số
    đề xuất — sổ không lưu chữ ký nên luôn là "chưa có bằng chứng ký").
    None = không đọc được (thiếu quyền/bảng) — ghi rõ, không im."""
    L = ["", "### Việc chờ TGĐ quyết định / chờ ký", ""]
    q = data.get("waiting_queue")
    L.append("Chờ quyết định (hàng duyệt khối ceo — nguồn `approval_queue`):")
    if q is None:
        L.append("- (không đọc được — thiếu quyền/bảng)")
    else:
        for i, ot, title, due in q[:SHOW]:
            dd = _vn_date(due)
            late = (f", QUÁ HẠN {(today - dd).days} ngày"
                    if dd and dd < today else "")
            L.append(f"- #{i} {_pg(ot, 40)} · {_pg(title, 80)} — hạn "
                     f"{_d(dd) if dd else '—'}{late}")
        if len(q) > SHOW:
            L.append(f"- …và {len(q) - SHOW} mục khác")
        if not q:
            L.append("- (không có)")
    ms = [r for r in data.get("milestones") or []
          if r.get("sign_required") and r["status"] != "xong"]
    L.append("Chờ ký (mốc cần văn bản ký, chưa xong kèm bằng chứng — nguồn "
             "`project_milestones`):")
    L += [(f"- {_pg(r['code'], 40)} · {_pg(r['title'], 80)} — hạn "
           f"{_d(r['due_date'])}"
           + (f" (TRỄ {(today - r['due_date']).days} ngày)"
              if r["due_date"] < today else "")
           + f", phụ trách {_pg(r.get('owner_role'), 40)}, {r['status']}")
          for r in ms[:SHOW]] or ["- (không có)"]
    rev = data.get("waiting_rev")
    L.append("Chờ ký biên bản đối soát quý (số đề xuất đã ghi; sổ KHÔNG lưu "
             "chữ ký — nguồn `revenue_quarters`):")
    if rev is None:
        L.append("- (không đọc được — thiếu quyền/bảng)")
    else:
        L += [f"- {_pg(qq, 10)} — ghi số {_d(_vn_date(ts))}, chưa có bằng "
              "chứng ký (mẫu PL05 chưa có)" for qq, ts in rev]             or ["- (không có)"]
    return L


def render_section(data: dict, today: date) -> list[str]:
    """data {"decisions": `chains(...)`, "milestones": dòng project_milestones}
    → dòng markdown "## Tiến độ & Sổ quyết định". Mọi số do code đếm."""
    dec = data.get("decisions") or []
    od = overdue(dec, today)
    n_open = sum(1 for d in dec if d.get("status") in OPEN)
    since = today - timedelta(days=7)
    recent = sum(1 for d in dec
                 if (v := _vn_date(d.get("recorded_at"))) is not None
                 and since < v <= today)
    L = ["## Tiến độ & Sổ quyết định", "",
         (f"Quyết định đang theo dõi (mở/đang làm): {n_open} · quá hạn thực "
          f"hiện: {len(od)} · ghi trong 7 ngày: {recent}"), "",
         "### Quyết định quá hạn thực hiện", ""]
    pick = sorted(od, key=lambda d: d["id"], reverse=True)[:SHOW]
    # Chuỗi DB vào trang qua page_safe (_pg): chữ trần gập-dấu thành từ cấm
    # / cắt 80 ký tự làm hở cụm khuyến cáo → cả trang TGĐ trượt guardrail.
    L += [(f"- #{d['id']} {_pg(d.get('topic'), 80)} — người quyết "
           f"{_pg(d.get('decided_by'), 60)} — hạn {_d(d['due_date'])} (trễ "
           f"{(today - d['due_date']).days} ngày, {d['status']})")
          for d in pick] or ["- (không có)"]
    if len(od) > SHOW:
        L.append(f"- …và {len(od) - SHOW} quyết định khác")
    late = late_milestones(data.get("milestones") or [], today)
    L += ["", "### Mốc trễ (sổ mốc tiến độ)", ""]
    L += [(f"- **TRỄ** {_pg(r['code'], 40)} — hạn {_d(r['due_date'])} (trễ "
           f"{(today - r['due_date']).days} ngày, owner "
           f"{_pg(r.get('owner_role'), 40)}, {r['status']})")
          for r in late[:SHOW]] or ["- (không có)"]
    if len(late) > SHOW:
        L.append(f"- …và {len(late) - SHOW} mốc khác")
    if "waiting_queue" in data:            # `read` luôn đặt (C05)
        L += wait_lines(data, today)
    L += ["", ("*Sổ quyết định do NGƯỜI ghi (`python -m agents.ceo_decisions "
               "--record --by`); agent chỉ đề xuất. Mốc trễ từ "
               "`project_milestones` (cùng luật bảng tiến độ DA-01).*")]
    return L


# ------------------------------------------------------------------ DB đọc
def read(conn) -> dict:
    """CHỈ SELECT → {"decisions": chains, "milestones": [...]}."""
    rows = [dict(zip(COLS, r)) for r in conn.execute(
        f"select {', '.join(COLS)} from decision_log order by id").fetchall()]
    ms = [dict(zip(MS_COLS, r)) for r in conn.execute(
        f"select {', '.join(MS_COLS)} from project_milestones"
        " order by due_date, code").fetchall()]
    return {"decisions": chains(rows), "milestones": ms,
            "waiting_queue": _try(conn, _WAIT_Q_SQL),
            "waiting_rev": _try(conn, _WAIT_REV_SQL)}


def _try(conn, sql):
    """Đọc trong savepoint; thiếu quyền/bảng → None (ghi rõ trên trang)."""
    try:
        with conn.transaction():
            return conn.execute(sql).fetchall()
    except psycopg.Error:
        return None


def section(conn, today: date) -> list[str]:
    return render_section(read(conn), today)


def propose(conn, now: datetime, days: int) -> list[dict]:
    """CHỈ SELECT: mục khối ceo đã approved/rejected trong `days` ngày tới
    `now` mà chưa có trong sổ."""
    cols = ("id", "object_type", "title", "status", "decided_by",
            "decided_at")
    return [dict(zip(cols, r)) for r in conn.execute(
        _PROPOSE_SQL, (now - timedelta(days=days), now)).fetchall()]


# ------------------------------------------------------------------ DB ghi
class Rejected(Exception):
    """Bị từ chối nghiệp vụ (exit 1) — không ghi dòng nào."""


def _guard(*parts) -> None:
    for p in parts:
        if not p:
            continue
        g = guardrail_check(p)
        if g.get("ok") is not True:
            kinds = sorted({str(v.get("code") or v.get("type"))
                            for v in g.get("violations") or ()
                            if isinstance(v, dict)}) or ["?"]
            raise Rejected(f"trượt guardrail ({', '.join(kinds)}) — sửa lời "
                           "văn rồi ghi lại (trang TGĐ chép nội dung này)")


def record(conn, *, topic: str, decision: str, by: str, basis_kind: str,
           basis_id: int | None = None, decided_by: str | None = None,
           note: str | None = None, decided_on: date | None = None,
           due: date | None = None, today: date) -> int:
    """Ghi 1 mục `quyet_dinh` → id. Từ chối nghiệp vụ → `Rejected` (0 dòng);
    lỗi DB → psycopg.Error."""
    for who in (by, decided_by):
        if who is not None and (err := by_error(who)):
            raise Rejected(err)
    topic, decision = (topic or "").strip(), (decision or "").strip()
    note = (note or "").strip() or None
    if not 1 <= len(topic) <= MAX_TOPIC:
        raise Rejected(f"--topic cần 1..{MAX_TOPIC} ký tự")
    if not 1 <= len(decision) <= MAX_DECISION:
        raise Rejected(f"--decision cần 1..{MAX_DECISION} ký tự")
    if note is not None and len(note) > MAX_NOTE:
        raise Rejected(f"--note dài quá {MAX_NOTE} ký tự")
    if _MARKUP_RE.search(topic):
        raise Rejected("--topic không được chứa link/HTML/markdown (trang TGĐ"
                       " chép chủ đề)")
    if decided_by is not None and _MARKUP_RE.search(decided_by):
        raise Rejected("--decided-by không được chứa link/HTML/markdown "
                       "(trang TGĐ chép người quyết)")
    _guard(topic, decision, note)
    if basis_kind == "van_ban":
        if basis_id is not None:
            raise Rejected("căn cứ van_ban không kèm id")
        if len(note or "") < MIN_VAN_BAN_NOTE:
            raise Rejected("căn cứ van_ban cần --note mô tả văn bản ≥ "
                           f"{MIN_VAN_BAN_NOTE} ký tự")
        if decided_by is None:
            raise Rejected("căn cứ van_ban cần --decided-by (người quyết)")
        who, when = decided_by, None
    elif basis_kind in SYS_BASIS:
        row = conn.execute(_BASIS_SQL[basis_kind], (basis_id,)).fetchone()
        if row is None:
            raise Rejected(f"không có {basis_kind} #{basis_id}")
        if basis_kind == "approval_queue" and row[0] not in ("approved",
                                                             "rejected"):
            raise Rejected(f"mục approval_queue #{basis_id} đang '{row[0]}' —"
                           " chỉ ghi mục đã quyết (approved/rejected)")
        who, when = row[1], row[2]
        if decided_by is not None and not _same_person(decided_by, who):
            raise Rejected(f"--decided-by khác người đã quyết trên "
                           f"{basis_kind} #{basis_id} ({_txt(who, 60)})")
        if by_error(who):
            raise Rejected(f"{basis_kind} #{basis_id} không có người quyết "
                           "hợp lệ (agent/system) — không phải quyết định của"
                           " người")
        dup = conn.execute(
            "select id from decision_log where entry_kind = 'quyet_dinh' and"
            " basis_kind = %s and basis_id = %s", (basis_kind, basis_id)
        ).fetchone()
        if dup:
            raise Rejected(f"căn cứ {basis_kind}:{basis_id} đã ghi "
                           f"(#{dup[0]})")
    else:
        raise Rejected("căn cứ phải approval_queue:ID|approvals:ID|"
                       "decisions:ID|van_ban")
    on = decided_on or _vn_date(when) or today
    if on > today:
        raise Rejected(f"ngày quyết {on:%d/%m/%Y} ở tương lai")
    if due is not None and due < on:
        raise Rejected(f"hạn {due:%d/%m/%Y} trước ngày quyết {on:%d/%m/%Y}")
    try:
        with conn.transaction():
            rid = conn.execute(_INSERT_SQL, (
                "quyet_dinh", None, on, _mask_pii(topic), _mask_pii(decision),
                who.strip(), basis_kind, basis_id, due, "mo",
                _mask_pii(note) if note else None, by.strip())).fetchone()[0]
    except psycopg.errors.UniqueViolation:
        raise Rejected(f"căn cứ {basis_kind}:{basis_id} đã ghi (ghi song "
                       "song)") from None
    conn.commit()
    return rid


def follow(conn, decision_id: int, status: str, by: str,
           note: str | None = None) -> int:
    """Thêm dòng `cap_nhat` cho mục `quyet_dinh` CHƯA đóng → id dòng mới."""
    if err := by_error(by):
        raise Rejected(err)
    if status not in FOLLOW:
        raise Rejected(f"--status phải thuộc {FOLLOW}")
    note = (note or "").strip() or None
    if status == "xong" and not note:
        raise Rejected("xong cần --note (bằng chứng hoàn thành)")
    if note is not None and len(note) > MAX_NOTE:
        raise Rejected(f"--note dài quá {MAX_NOTE} ký tự")
    _guard(note)
    with conn.transaction():
        root = conn.execute(
            "select entry_kind from decision_log where id = %s for update",
            (decision_id,)).fetchone()
        if root is None or root[0] != "quyet_dinh":
            raise Rejected(f"không có quyết định #{decision_id}")
        chain = [dict(zip(("id", "follow_status"), r)) for r in conn.execute(
            "select id, follow_status from decision_log where id = %s or"
            " parent_id = %s", (decision_id, decision_id)).fetchall()]
        cur = current_status(chain)
        if cur not in OPEN:
            raise Rejected(f"quyết định #{decision_id} đã đóng ({cur}) — "
                           "không cập nhật nữa")
        rid = conn.execute(_INSERT_SQL, (
            "cap_nhat", decision_id, None, None, None, None, None, None,
            None, status, _mask_pii(note) if note else None, by.strip())
        ).fetchone()[0]
    conn.commit()
    return rid


# ------------------------------------------------------------------ CLI
def _date_arg(s: str, what: str) -> date:
    return _iso_date(s, what)


def _basis_arg(s: str) -> tuple[str, int | None]:
    s = (s or "").strip()
    if s == "van_ban":
        return s, None
    kind, sep, rest = s.partition(":")
    if (kind in SYS_BASIS and sep and rest.isascii() and rest.isdigit()
            and len(rest) <= 18 and int(rest) > 0):
        return kind, int(rest)
    raise ValueError("--basis phải approval_queue:ID|approvals:ID|"
                     "decisions:ID|van_ban")


def _print_list(data: dict, today: date) -> None:
    dec = data["decisions"]
    od = {d["id"] for d in overdue(dec, today)}
    print(f"[sổ quyết định] {len(dec)} mục — ngày {_d(today)} (giờ VN)")
    for d in dec:
        basis = d["basis_kind"] + (f":{d['basis_id']}" if d["basis_id"]
                                   else "")
        print(f"- #{d['id']} [{d['status']}{' QUÁ HẠN' if d['id'] in od else ''}]"
              f" {_d(d['decided_on'])} {_txt(d['topic'], 80)} — quyết:"
              f" {_txt(d['decision'], 120)} — người quyết"
              f" {_txt(d['decided_by'], 60)} — căn cứ {basis} — hạn"
              f" {_d(d['due_date'])}")
    late = late_milestones(data["milestones"], today)
    print(f"[mốc trễ] {len(late)}")
    for r in late:
        print(f"- TRỄ {_txt(r['code'], 40)} — hạn {_d(r['due_date'])} (trễ"
              f" {(today - r['due_date']).days} ngày, owner"
              f" {_txt(r['owner_role'], 40)}, {r['status']})")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ceo_decisions",
        description="Sổ quyết định TGĐ (append-only) — NGƯỜI ghi với --by; "
                    "agent chỉ đề xuất (--propose)")
    ap.add_argument("--propose", action="store_true",
                    help="CHỈ ĐỌC: mục khối ceo đã quyết chưa có trong sổ")
    ap.add_argument("--record", action="store_true", help="ghi 1 quyết định")
    ap.add_argument("--follow", type=int, metavar="ID",
                    help="cập nhật trạng thái thực hiện (dòng mới)")
    ap.add_argument("--list", action="store_true", help="in sổ + mốc trễ")
    ap.add_argument("--days", type=int, default=None,
                    help="--propose: số ngày nhìn lại 1..366 (mặc định 30)")
    ap.add_argument("--now", help="ISO CHỈ cho --propose/--list; thiếu múi"
                    " giờ = giờ VN (+07:00)")
    ap.add_argument("--topic")
    ap.add_argument("--decision")
    ap.add_argument("--by", help="tên NGƯỜI ghi (không agent:/system:)")
    ap.add_argument("--decided-by", help="tên NGƯỜI quyết (mặc định lấy từ"
                    " căn cứ)")
    ap.add_argument("--basis", help="approval_queue:ID|approvals:ID|"
                    "decisions:ID|van_ban (mặc định van_ban)")
    ap.add_argument("--note")
    ap.add_argument("--date", help="ngày quyết YYYY-MM-DD (không tương lai)")
    ap.add_argument("--due", help="hạn thực hiện YYYY-MM-DD")
    ap.add_argument("--status", choices=FOLLOW)
    a = ap.parse_args(argv)
    n_ops = a.propose + a.record + (a.follow is not None) + a.list
    if n_ops != 1:
        ap.error("chọn đúng 1 thao tác: --propose | --record | --follow |"
                 " --list")
    if a.now is not None and not (a.propose or a.list):
        ap.error("--now chỉ đi với --propose/--list — thao tác ghi dùng giờ"
                 " thật")
    if a.days is not None and not a.propose:
        ap.error("--days chỉ đi với --propose")
    days = 30 if a.days is None else a.days
    if not 1 <= days <= 366:
        ap.error("--days phải 1..366")
    rec_only = (a.topic, a.decision, a.decided_by, a.basis, a.date, a.due)
    if not a.record and any(v is not None for v in rec_only):
        ap.error("--topic/--decision/--decided-by/--basis/--date/--due chỉ"
                 " đi với --record")
    if (a.status is not None) != (a.follow is not None):
        ap.error("--follow cần --status (và --status chỉ đi với --follow)")
    try:
        now = parse_now(a.now) if a.now else _now()
    except ValueError:
        ap.error("--now sai định dạng ISO")
    today = now.astimezone(VN_TZ).date()
    basis = (None, None)
    on = due = None
    if a.record or a.follow is not None:
        if err := by_error(a.by):
            ap.error(err)
        if a.note is not None and len(a.note.strip()) > MAX_NOTE:
            ap.error(f"--note dài quá {MAX_NOTE} ký tự")
    if a.record:
        if a.decided_by is not None and (err := by_error(a.decided_by)):
            ap.error(f"--decided-by: {err}")
        for v, w, mx in ((a.topic, "--topic", MAX_TOPIC),
                         (a.decision, "--decision", MAX_DECISION)):
            if not (v or "").strip() or len(v.strip()) > mx:
                ap.error(f"{w} cần 1..{mx} ký tự")
        try:
            basis = _basis_arg(a.basis or "van_ban")
            on = _date_arg(a.date, "--date") if a.date else None
            due = _date_arg(a.due, "--due") if a.due else None
        except ValueError as e:
            ap.error(str(e))
        if basis[0] == "van_ban" and (
                a.decided_by is None
                or len((a.note or "").strip()) < MIN_VAN_BAN_NOTE):
            ap.error("căn cứ van_ban cần --decided-by và --note mô tả văn bản"
                     f" ≥ {MIN_VAN_BAN_NOTE} ký tự")
    if a.follow is not None and a.status == "xong" and \
            not (a.note or "").strip():
        ap.error("--status xong cần --note (bằng chứng hoàn thành)")
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.propose:
            items = propose(conn, now, days)
            conn.commit()
            print(f"[đề xuất] {len(items)} mục khối ceo đã quyết trong {days}"
                  " ngày chưa có trong sổ — agent KHÔNG tự ghi; NGƯỜI chạy"
                  " lệnh --record:")
            for it in items:
                print(f"- approval_queue #{it['id']} `{it['object_type']}`"
                      f" {it['status']} — {_txt(it['title'], 80)} — người"
                      f" quyết {_txt(it['decided_by'], 60)} ngày"
                      f" {_d(_vn_date(it['decided_at']))}")
                print(f"    python -m agents.ceo_decisions --record --basis"
                      f" approval_queue:{it['id']} --topic \"...\" --decision"
                      " \"...\" --by \"<tên người ghi>\" [--due YYYY-MM-DD]")
            return 0
        if a.list:
            data = read(conn)
            conn.commit()
            _print_list(data, today)
            return 0
        if a.record:
            rid = record(conn, topic=a.topic, decision=a.decision, by=a.by,
                         basis_kind=basis[0], basis_id=basis[1],
                         decided_by=a.decided_by, note=a.note,
                         decided_on=on, due=due, today=today)
            print(f"[done] ghi quyết định #{rid} (người ghi:"
                  f" {_txt(a.by, 60)})")
            return 0
        rid = follow(conn, a.follow, a.status, a.by, a.note)
        print(f"[done] cập nhật #{rid} → quyết định #{a.follow}: {a.status}")
        return 0
    except Rejected as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[từ chối] {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[error] lỗi DB: {_txt(_db_msg(e), 300)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
