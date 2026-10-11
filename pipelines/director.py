"""v4.0 W40.6 — mẫu agent giám đốc khối (WP03): gom việc của agent nhân
viên vào hàng duyệt chung → bản tin markdown cho GĐ khối.

Contract:
  - Cấu hình `data/directors/<block>.json` cho 11 khối (`BLOCKS` — key của
    kế hoạch final_plans): `name`, `director_agent`, `approver_roles` (⊂
    `pipelines.auth.ROLES`), `approvers` + `digest_recipients` (rỗng =
    người thật chưa cấp, external-dep), `object_types` {loại: {sla_hours
    1..720, risk low|medium|high}} (cấm `content_draft`), `due_soon_hours`.
    Lỗi cấu trúc → `DirectorConfigError`.
  - `submit`: SLA + risk lấy từ CẤU HÌNH (agent nhân viên không tự đặt) →
    `approval_queue.enqueue` (guardrail do module đó tự tính). Loại việc
    ngoài cấu hình → `ValueError` trước khi chạm DB.
  - `run`: `expire_overdue` → thử `auto_approve` mục pending risk low + QA
    pass (không có luật = bình thường, bỏ qua — fail-closed ở DB) → đọc
    hàng của khối → `digest` (hàm THUẦN) → ghi `data/reports/director-
    <block>-<YYYY-MM-DD>.md` (atomic, gitignored). KHÔNG tự gửi.
  - Ngày "hôm nay" theo giờ VN (`pipelines.period.period_bounds('day')`).

Chạy:
  python -m pipelines.director --block sales
  python -m pipelines.director --all [--dry-run]   # dry-run: chỉ kiểm cấu hình, không DB
Exit: 0 ok · 1 cấu hình lỗi · 2 DB down / tham số sai.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines.auth import ROLES
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DIRECTORS_DIR = ROOT / "data" / "directors"
BLOCKS = ("ceo", "sales", "marketing", "intel", "finance", "production",
          "farming", "projects", "legal_hr", "mechanical", "data_platform")
RISKS = ("low", "medium", "high")
_TYPE_RE = re.compile(r"[a-z][a-z0-9_]{1,39}")
_ITEM_SQL = (
    "select id, object_type, object_id, title, risk, qa_status, status,"
    " created_by, created_at, due_at, decided_by, decided_at, lane"
    " from approval_queue where block = %s"
    " and (status = 'pending' or decided_at >= %s or created_at >= %s)"
    " order by id")
_ITEM_COLS = ("id", "object_type", "object_id", "title", "risk", "qa_status",
              "status", "created_by", "created_at", "due_at", "decided_by",
              "decided_at", "lane")
_OVERRIDE_SQL = (
    "select d.queue_id, d.decided_by, d.created_at from decisions d"
    " join approval_queue a on a.id = d.queue_id"
    " where a.block = %s and d.kind = 'override_qa'"
    " and d.created_at >= %s and d.created_at < %s order by d.id")


class DirectorConfigError(Exception):
    """Cấu hình khối thiếu/hỏng/sai luật."""


def _int_in(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def validate(cfg, block: str) -> dict:
    if not isinstance(cfg, dict):
        raise DirectorConfigError(f"{block}: cấu hình không phải object JSON")
    if cfg.get("block") != block:
        raise DirectorConfigError(f"{block}: 'block' = {cfg.get('block')!r}"
                                  " lệch tên file")
    for k in ("name", "director_agent"):
        if not isinstance(cfg.get(k), str) or not cfg[k].strip():
            raise DirectorConfigError(f"{block}: thiếu '{k}'")
    roles = cfg.get("approver_roles")
    if not isinstance(roles, list) or not roles:
        raise DirectorConfigError(f"{block}: 'approver_roles' rỗng")
    stray = [r for r in roles if r not in ROLES]
    if stray:
        raise DirectorConfigError(f"{block}: vai trò lạ {stray} — phải thuộc"
                                  f" {ROLES}")
    for k in ("approvers", "digest_recipients"):
        v = cfg.get(k)
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise DirectorConfigError(f"{block}: '{k}' phải là list chuỗi")
    types = cfg.get("object_types")
    if not isinstance(types, dict) or not types:
        raise DirectorConfigError(f"{block}: 'object_types' rỗng")
    for t, spec in types.items():
        if t == "content_draft" or not _TYPE_RE.fullmatch(t):
            raise DirectorConfigError(f"{block}: loại việc '{t}' không hợp lệ"
                                      " (content_draft đi pipelines.store)")
        if not isinstance(spec, dict) or not _int_in(spec.get("sla_hours"),
                                                     1, 720):
            raise DirectorConfigError(f"{block}/{t}: sla_hours phải 1..720")
        if spec.get("risk") not in RISKS:
            raise DirectorConfigError(f"{block}/{t}: risk phải {RISKS}")
    if not _int_in(cfg.get("due_soon_hours"), 1, 720):
        raise DirectorConfigError(f"{block}: due_soon_hours phải 1..720")
    return cfg


def load_config(block: str, base_dir: Path | None = None) -> dict:
    p = (base_dir or DIRECTORS_DIR) / f"{block}.json"
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError as e:
        raise DirectorConfigError(f"không có file {p.name}") from e
    except (OSError, ValueError) as e:
        raise DirectorConfigError(f"{p.name} hỏng: {type(e).__name__}") \
            from e
    return validate(cfg, block)


def load_all(base_dir: Path | None = None) -> dict[str, dict]:
    return {b: load_config(b, base_dir) for b in BLOCKS}


def submit(conn, block: str, object_type: str, object_id: str, title: str,
           payload: str, created_by: str, qa_status: str = "none",
           cfg: dict | None = None) -> int:
    """Agent nhân viên đẩy việc → id hàng duyệt. SLA/risk từ cấu hình."""
    cfg = cfg if cfg is not None else load_config(block)
    spec = cfg["object_types"].get(object_type)
    if spec is None:
        raise ValueError(f"khối {block} không nhận loại việc '{object_type}'"
                         f" — có: {sorted(cfg['object_types'])}")
    return aq.enqueue(conn, object_type=object_type, object_id=object_id,
                      block=block, title=title, payload=payload,
                      risk=spec["risk"], created_by=created_by,
                      sla_hours=spec["sla_hours"], qa_status=qa_status)


def _in(ts, start, end) -> bool:
    return ts is not None and start <= ts < end


def _fmt_vn(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m %H:%M") if ts else "—"


def _line(d: dict) -> str:
    return (f"#{d['id']} `{d['object_type']}` "
            f"{_oneline(_mask_pii(d.get('title') or ''), 70)}")


def digest(cfg: dict, items: list[dict], now: datetime,
           overrides: list[dict] = ()) -> str:
    """Bản tin markdown (thuần). `items` = dòng hàng duyệt của khối,
    `overrides` = override_qa (queue_id, decided_by, created_at)."""
    start, end = period_bounds("day", now)
    day = start.date()
    soon = now + timedelta(hours=cfg["due_soon_hours"])
    pend = [d for d in items if d["status"] == "pending"]
    new_today = [d for d in items if _in(d.get("created_at"), start, end)]
    done = {s: [d for d in items if d["status"] == s
                and _in(d.get("decided_at"), start, end)]
            for s in ("approved", "rejected", "expired")}
    due_soon = [d for d in pend if d.get("due_at") and now < d["due_at"]
                <= soon]
    ovr = [o for o in overrides if _in(o.get("created_at"), start, end)]
    L = [f"# Bản tin GĐ {cfg['name']} — {day:%d/%m/%Y}", "",
         f"Agent: {cfg['director_agent']} · khối `{cfg['block']}` · giờ VN",
         "", "## Số liệu trong ngày", "",
         "| Chỉ số | Số |", "|---|---|",
         f"| Mới vào hàng | {len(new_today)} |",
         f"| Đang chờ duyệt (tồn) | {len(pend)} |",
         f"| Đã duyệt | {len(done['approved'])} |",
         f"| Từ chối | {len(done['rejected'])} |",
         f"| Hết hạn SLA (expired) | {len(done['expired'])} |", "",
         f"## Sắp quá hạn (≤ {cfg['due_soon_hours']} giờ)", ""]
    L += ([f"- {_line(d)} — hạn {_fmt_vn(d['due_at'])}" for d in due_soon]
          or ["- (không có)"])
    L += ["", "## Hết hạn hôm nay (không ai duyệt — KHÔNG tự duyệt)", ""]
    L += ([f"- {_line(d)} — hạn {_fmt_vn(d.get('due_at'))}"
           for d in done["expired"]] or ["- (không có)"])
    L += ["", "## Override QA hôm nay (ép trình bản QA FAIL)", ""]
    L += ([f"- mục #{o['queue_id']} — bởi {o['decided_by']} lúc "
           f"{_fmt_vn(o['created_at'])}" for o in ovr] or ["- (không có)"])
    L += ["", "## Người duyệt", "",
          f"- Vai trò duyệt: {', '.join(cfg['approver_roles'])}"]
    if not cfg["approvers"]:
        L.append("- Người duyệt chưa cấu hình (external-dep)")
    if not cfg["digest_recipients"]:
        L.append("- Người nhận bản tin chưa cấu hình (external-dep)")
    L += ["", "---", ("*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi "
                      "chuyển tay cho GĐ khối.*"), ""]
    return "\n".join(L)


def run(conn, block: str, now: datetime | None = None,
        cfg: dict | None = None, out_dir: Path = REPORTS_DIR):
    """expire → auto_approve (nếu có luật) → digest → file. → (path, text)."""
    cfg = cfg if cfg is not None else load_config(block)
    now = now or datetime.now(VN_TZ)
    aq.expire_overdue(conn)
    cand = conn.execute(
        "select id from approval_queue where block = %s and status ="
        " 'pending' and risk = 'low' and qa_status = 'pass' order by id",
        (block,)).fetchall()
    for (qid,) in cand:
        aq.auto_approve(conn, qid)   # không luật → (False, msg): bỏ qua
    start, end = period_bounds("day", now)
    items = [dict(zip(_ITEM_COLS, r)) for r in conn.execute(
        _ITEM_SQL, (block, start, start)).fetchall()]
    overrides = [dict(zip(("queue_id", "decided_by", "created_at"), r))
                 for r in conn.execute(_OVERRIDE_SQL,
                                       (block, start, end)).fetchall()]
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    text = digest(cfg, items, now, overrides)
    path = write_report(text, out_dir,
                        f"director-{block}-{start.date():%Y-%m-%d}.md")
    return path, text


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.director",
        description="Agent GĐ khối — bản tin hàng duyệt (BẢN NHÁP, không "
                    "tự gửi)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--block", choices=BLOCKS)
    g.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ kiểm cấu hình, không DB")
    args = ap.parse_args(argv)
    blocks = BLOCKS if args.all else (args.block,)
    try:
        cfgs = {b: load_config(b) for b in blocks}
    except DirectorConfigError as e:
        print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
        return 1
    if args.dry_run:
        for b, c in cfgs.items():
            appr = "chưa cấu hình (external-dep)" if not c["approvers"] \
                else f"{len(c['approvers'])} người"
            print(f"[ok] {b} — {c['name']} · {len(c['object_types'])} loại "
                  f"việc · vai trò duyệt {','.join(c['approver_roles'])} · "
                  f"người duyệt {appr}")
        print(f"[done] {len(cfgs)} khối hợp lệ (dry-run, không DB)")
        return 0
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        for b, c in cfgs.items():
            path, _ = run(conn, b, cfg=c)
            print(f"[done] {b} → {path}")
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("pipelines.director") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
