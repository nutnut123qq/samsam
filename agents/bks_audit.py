"""v10.0 W100.2–W100.4 (WP16) — Audit inside-out của Ban kiểm soát (BKS).

Câu hỏi: dữ liệu kiểm soát BÊN TRONG hệ thống có còn nguyên vẹn và nhất quán
không? (outside-in P1 — bài/listing đang chạy — là `agents.ceo_audit`.)

  - `check_chains(conn, prev_heads)` — chạy `verify_action_log()` +
    `verify_plot_logs()` (mỗi cái trong savepoint; lỗi DB → `khong_kiem_duoc`,
    KHÔNG coi là nguyên vẹn); problem `row_hash`/`prev_hash`/`unchained` →
    `chuoi_bi_sua`. NEO ĐUÔI: `heads` {bảng: {max_id, row_hash, n}}
    (plot_logs: chỉ dòng đã chain) ghi vào `audit_runs.params.heads` khi
    `--record`; lần sau so dòng `id = max_id` cũ còn đúng `row_hash` và số
    dòng không giảm — lệch → `mat_duoi_chuoi` (bù giới hạn "xóa dòng CUỐI"
    của chuỗi thuần trong khoảng giữa 2 lần audit). Lần đầu → ghi chú, không
    phát hiện. GIỚI HẠN: superuser xóa cả `audit_runs` thì neo nội bộ mất —
    neo object-lock ngoài + bộ kiểm chứng độc lập = external-dep.
  - `check_approvals(conn)` — TÍNH LẠI, không tin cột status: (a) draft
    approved mà `verify_publish` false; (b) mục hàng duyệt approved mà
    sha256(payload) ≠ `content_sha256` hoặc KHÔNG có dòng `approvals` của
    CHÍNH mục đó (cùng object, approved, cùng sha, `approved_at <=
    decided_at` — function ghi cả hai trong 1 tx) →
    `noi_dung_lech_ban_duyet`. Không so với quyết định MỚI NHẤT của
    object: nộp lại cùng object rồi từ chối/duyệt bản khác là luồng bình
    thường, không được báo oan mục cũ; (c) dòng `approvals` không có dòng
    log của function duyệt (`APPROVAL_ACTIONS` — liệt kê từ mọi `insert
    into approvals` trong docs/schema.sql) cùng `approval_id`, cùng
    object_id, actor = approved_by, cùng `db_role` (session_user) và
    `ts = approved_at` (cùng tx) → `duyet_ngoai_function` — agent_writer tự
    ghi được log nhưng trigger ép db_role = 'agent_writer', ts = now() của
    tx nó; (d) người duyệt = người tạo
    (draft, mục hàng duyệt, giá vốn) → `tu_duyet`; (e) mục QA FAIL approved
    không có `decisions` override_qa → `qa_fail_khong_override`.
  - `check_overrides(conn, start, end)` — MỌI override_qa trong kỳ (đầu vào
    gói HĐTV) + bất thường: `override_tu_trinh` (người override = người tạo
    mục), `tu_ep_tu_duyet` (= người duyệt mục), `override_don_dap` (1 người >
    `max_per_person` lần/kỳ); `decision_log` căn cứ `approval_queue:ID` mà
    mục chưa approved|rejected → `can_cu_sai`.
  - `check_privileges(conn)` — catalog `has_*_privilege`: agent_writer/
    app_human/bks_reader có UPDATE/DELETE/TRUNCATE bảng append-only hoặc
    INSERT `approvals`; bks_reader có bất kỳ quyền ghi nào ngoài INSERT
    `audit_runs` / `report_outputs` (v15.4: sổ đầu ra báo cáo BKS) hoặc
    EXECUTE function ghi → `quyen_vuot`. Quyền kế thừa từ
    role khác cùng danh sách chỉ báo ở role gốc. Function ghi lấy từ
    CATALOG (mọi SECURITY DEFINER trong schema trừ `READ_FUNCS`) — không
    danh sách cứng (thêm function mới không lọt). v14.2: theo dõi thêm
    `ben_a_reader` (+ SELECT ngoài số tổng hợp `BEN_A_READS` = vượt) và 4
    login dịch vụ `svc_*` (svc_backup chỉ đọc); mọi role (trừ backup) đọc
    `contacts`/`consents` = vượt; `settlement_rows`/`order_history` vào
    danh sách append-only. v15 fix P8.7c: svc_backup được EXECUTE ĐÚNG
    `file_output_evidence_backup` (bằng chứng đầu ra backup —
    `ROLE_FUNCS`); sổ `file_output_evidence` append-only, INSERT trực tiếp
    của role theo dõi = vượt (chỉ ghi qua function).
CHỈ ĐỌC mọi bảng nghiệp vụ; đường ghi DUY NHẤT `insert into audit_runs`
(`--record`). Báo cáo chỉ `#id`/bảng/khối — không text/payload; tên người +
lý do override qua `_mask_pii` + `_oneline`. Không LLM, không mạng.

Chạy: python -m agents.bks_audit --report [--month YYYY-MM] [--now ISO]
      [--out-dir DIR] [--record | --dry-run]
Exit: 0 ok (có phát hiện vẫn 0 — audit là báo, không chặn) · 2 tham số sai /
kỳ chưa đóng / DB down / lỗi DB.
"""

import argparse
import hashlib
import re
import sys
from collections import Counter
from contextlib import suppress
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from agents.fp_pnl import parse_month
from agents.ra_kenh import parse_now, safe
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines.cockpit import _closed, last_closed_ref
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

RUN_BY = "agent:bks_audit"
KIND = "inside_out"
# (bảng, function kiểm, điều kiện dòng đã chain)
CHAINS = (("agent_action_log", "verify_action_log", ""),
          ("plot_logs", "verify_plot_logs", " where row_hash is not null"))
# Action log do function SECURITY DEFINER ghi cùng `insert into approvals`
# (grep docs/schema.sql): approve/reject_draft, decide_item,
# auto_approve_item, decide_allocation_run, record_lot_intake, sign_qr_lot,
# approve_cogs.
APPROVAL_ACTIONS = ("draft_approve", "draft_reject", "queue_approve",
                    "queue_reject", "queue_auto_approve", "alloc_approve",
                    "alloc_reject", "lot_intake", "qr_lot_sign",
                    "cogs_approve")
APPEND_ONLY = ("approvals", "agent_action_log", "decisions", "decision_log",
               "audit_runs", "plot_logs", "settlement_rows", "order_history",
               # v14.3: sổ đầu ra báo cáo + gợi ý chat sàn / lần dùng.
               "report_outputs", "san_suggestions", "san_suggestion_uses",
               # v15.2 (P8.7): sổ người duyệt từng đầu ra.
               "output_reviews",
               # v15 fix P8.7c: bằng chứng đầu ra nguồn file (chỉ function).
               "file_output_evidence")
# Sổ chỉ ghi qua function SECURITY DEFINER — INSERT trực tiếp = vượt.
FUNC_ONLY_INSERT = ("approvals", "file_output_evidence")
# v14.2: + Bên A (chỉ đọc số tổng hợp) + 4 login dịch vụ (docs/roles.sql).
WATCH_ROLES = ("agent_writer", "app_human", "bks_reader", "ben_a_reader",
               "svc_webhook", "svc_job", "svc_loader", "svc_backup")
# Role CHỈ ĐỌC: bất kỳ quyền ghi nào = vượt.
READ_ONLY_ROLES = ("ben_a_reader", "svc_backup")
# Bên A chỉ đọc đúng các bảng/view số tổng hợp (khối v12.5 B5) — SELECT bảng
# khác (đơn, quyết toán gốc, khách hàng...) = vượt.
BEN_A_READS = ("revenue_quarters", "v_ben_a_settlement_daily",
               "v_ben_a_orders_daily")
# Bảng PII (ciphertext + đồng ý) — chỉ owner/CLI người + backup đọc.
PII_TABLES = ("contacts", "consents")
# Function SECURITY DEFINER bks_reader ĐƯỢC chạy (chỉ đọc); mọi SECDEF
# khác trong schema chạy được → quyen_vuot (function INVOKER chạy bằng
# quyền của chính role — đã kiểm qua quyền bảng).
READ_FUNCS = ("verify_action_log", "verify_plot_logs", "verify_publish")
# v15 fix P8.7c: function ghi DUY NHẤT role chỉ đọc được chạy — dịch vụ backup
# ghi bằng chứng đầu ra (DB tự tính khóa/sha, từ chối login người/agent).
ROLE_FUNCS = {"svc_backup": ("file_output_evidence_backup",)}
CODES = ("chuoi_bi_sua", "mat_duoi_chuoi", "khong_kiem_duoc",
         "noi_dung_lech_ban_duyet", "duyet_ngoai_function", "tu_duyet",
         "qa_fail_khong_override", "override_tu_trinh", "tu_ep_tu_duyet",
         "override_don_dap", "can_cu_sai", "quyen_vuot")
FIRST_RUN = "chưa có neo trước — lần audit đầu (đuôi chuỗi chưa đối chiếu)"
LIMIT_NOTE = ("Neo đuôi chuỗi chỉ là neo NỘI BỘ (`audit_runs.params.heads`): "
              "superuser xóa cả sổ `audit_runs` thì neo mất — neo object-"
              "lock ngoài + bộ kiểm chứng độc lập trong tài khoản cloud do "
              "HĐTV đứng tên là external-dep.")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_NORM = "lower(btrim(regexp_replace({}, '\\s+', ' ', 'g')))"


def _norm(s) -> str:
    return " ".join(str(s or "").split()).lower()


def _why(e: Exception) -> str:
    msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
    return _oneline(_mask_pii(safe(f"{type(e).__name__}: {msg}")), 120)


def _rows(conn, sql: str, params=()) -> list[tuple]:
    """Đọc trong savepoint — lỗi (thiếu quyền/bảng) không làm hỏng tx."""
    with conn.transaction():
        return conn.execute(sql, params).fetchall()


# ------------------------------------------------------------- W100.2 chuỗi

def _valid_heads(raw) -> dict | None:
    """params.heads đã lưu → {bảng: {max_id, row_hash, n}} hợp lệ (bỏ mục
    hỏng); không phải dict → None."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for table, _fn, _w in CHAINS:
        h = raw.get(table)
        if not isinstance(h, dict):
            continue
        mx, rh, n = h.get("max_id"), h.get("row_hash"), h.get("n")
        if (isinstance(n, int) and not isinstance(n, bool) and n >= 0
                and (mx is None or (isinstance(mx, int)
                                    and not isinstance(mx, bool)))
                and (rh is None or (isinstance(rh, str)
                                    and _HEX64.fullmatch(rh)))):
            out[table] = {"max_id": mx, "row_hash": rh, "n": n}
    return out


def latest_heads(conn) -> dict | None:
    """Neo của lần audit inside-out MỚI NHẤT; chưa có → None."""
    rows = _rows(conn, "select params -> 'heads' from audit_runs where kind ="
                       " %s order by id desc limit 1", (KIND,))
    return _valid_heads(rows[0][0]) if rows else None


def check_chains(conn, prev_heads: dict | None) -> tuple[dict, list[dict]]:
    """→ (heads, findings). Mỗi bảng: verify + đọc head trong savepoint
    riêng; lỗi → `khong_kiem_duoc` (không bao giờ "nguyên vẹn" khi không
    kiểm được)."""
    heads: dict = {}
    findings: list[dict] = []
    for table, fn, where in CHAINS:
        try:
            probs = _rows(conn, f"select id, problem from {fn}() order by id")
        except psycopg.Error as e:
            findings.append({"code": "khong_kiem_duoc", "table": table,
                             "detail": f"{fn}(): {_why(e)}"})
        else:
            findings += [{"code": "chuoi_bi_sua", "table": table, "id": i,
                          "problem": p} for i, p in probs]
        try:
            n, mx = _rows(conn, f"select count(*), max(id) from {table}"
                                f"{where}")[0]
            rh = None
            if mx is not None:
                rh = _rows(conn, f"select row_hash from {table} where id ="
                                 " %s", (mx,))[0][0]
            heads[table] = {"max_id": mx, "row_hash": rh, "n": n}
            prev = (prev_heads or {}).get(table)
            if prev is None or prev["max_id"] is None:
                continue
            cur = _rows(conn, f"select row_hash from {table} where id = %s",
                        (prev["max_id"],))
        except psycopg.Error as e:
            findings.append({"code": "khong_kiem_duoc", "table": table,
                             "detail": f"đầu chuỗi: {_why(e)}"})
            continue
        problems = []
        if not cur:
            problems.append("dong_neo_mat")
        elif cur[0][0] != prev["row_hash"]:
            problems.append("row_hash_khac")
        if n < prev["n"]:
            problems.append("so_dong_giam")
        if problems:
            findings.append({"code": "mat_duoi_chuoi", "table": table,
                             "id": prev["max_id"],
                             "problem": ",".join(problems)})
    return heads, findings


# ---------------------------------------------------------- W100.3 duyệt

_SQL_A = (
    "select id from content_drafts where status = 'approved' and not"
    " coalesce(verify_publish('content_draft', id::text, text), false)"
    " order by id")
_SQL_B = (
    "select q.id, q.object_type, q.block from approval_queue q where"
    " q.status = 'approved' and (encode(sha256(convert_to(q.payload,"
    " 'UTF8')), 'hex') is distinct from q.content_sha256 or not exists"
    " (select 1 from approvals a where a.object_type = q.object_type and"
    " a.object_id = q.object_id and a.decision = 'approved' and"
    " a.content_sha256 = q.content_sha256 and a.approved_at <="
    " q.decided_at)) order by q.id")
_SQL_C = (
    "select a.id, a.object_type from approvals a where not exists (select 1"
    " from agent_action_log l where l.action = any(%s) and"
    " l.detail ->> 'approval_id' = a.id::text and l.object_id ="
    " a.object_id and l.actor = a.approved_by and l.db_role = a.db_role"
    " and l.ts = a.approved_at) order by a.id")
_SQL_D = (
    "select 'content_drafts', d.id, null::text from approvals a join"
    " content_drafts d on a.object_type = 'content_draft' and a.object_id ="
    " d.id::text where a.decision = 'approved' and "
    + _NORM.format("a.approved_by") + " = " + _NORM.format("d.created_by")
    + " union all select 'approval_queue', q.id, q.block from approval_queue"
    " q where q.status = 'approved' and " + _NORM.format("q.decided_by")
    + " = " + _NORM.format("q.created_by")
    + " union all select 'cogs_versions', c.id, null from cogs_versions c"
    " where c.approved_by is not null and " + _NORM.format("c.approved_by")
    + " = " + _NORM.format("c.created_by") + " order by 1, 2")
_SQL_E = (
    "select q.id, q.object_type, q.block from approval_queue q where"
    " q.status = 'approved' and q.qa_status = 'fail' and not exists (select"
    " 1 from decisions d where d.queue_id = q.id and d.kind = 'override_qa')"
    " order by q.id")


def check_approvals(conn) -> list[dict]:
    """5 phép kiểm, mỗi phép trong savepoint (lỗi → `khong_kiem_duoc`)."""
    out: list[dict] = []
    checks = (
        ("content_drafts", _SQL_A, (), lambda r: {
            "code": "noi_dung_lech_ban_duyet", "table": "content_drafts",
            "id": r[0]}),
        ("approval_queue", _SQL_B, (), lambda r: {
            "code": "noi_dung_lech_ban_duyet", "table": "approval_queue",
            "id": r[0], "object_type": r[1], "block": r[2]}),
        ("approvals", _SQL_C, (list(APPROVAL_ACTIONS),), lambda r: {
            "code": "duyet_ngoai_function", "table": "approvals", "id": r[0],
            "object_type": r[1]}),
        ("tu_duyet", _SQL_D, (), lambda r: {
            "code": "tu_duyet", "table": r[0], "id": r[1], "block": r[2]}),
        ("approval_queue", _SQL_E, (), lambda r: {
            "code": "qa_fail_khong_override", "table": "approval_queue",
            "id": r[0], "object_type": r[1], "block": r[2]}),
    )
    for what, sql, params, mk in checks:
        try:
            out += [mk(r) for r in _rows(conn, sql, params)]
        except psycopg.Error as e:
            out.append({"code": "khong_kiem_duoc", "table": what,
                        "detail": _why(e)})
    return out


# ------------------------------------------------ W100.4 override + quyền

_OVR_SQL = (
    "select d.id, d.queue_id, q.block, q.object_type, d.created_at,"
    " d.decided_by, d.reason, q.created_by, q.decided_by, q.status from"
    " decisions d join approval_queue q on q.id = d.queue_id where d.kind ="
    " 'override_qa' and d.created_at >= %s and d.created_at < %s order by"
    " d.id")
_BASIS_SQL = (
    "select l.id, l.basis_id from decision_log l left join approval_queue q"
    " on q.id = l.basis_id where l.entry_kind = 'quyet_dinh' and"
    " l.basis_kind = 'approval_queue' and (q.id is null or q.status not in"
    " ('approved', 'rejected')) order by l.id")


def check_overrides(conn, start, end, max_per_person: int = 3) -> dict:
    """→ {"overrides": [...mọi override_qa trong kỳ], "findings": [...]}."""
    cols = ("id", "queue_id", "block", "object_type", "created_at", "by",
            "reason", "q_created_by", "q_decided_by", "q_status")
    findings: list[dict] = []
    try:
        ovr = [dict(zip(cols, r)) for r in _rows(conn, _OVR_SQL,
                                                 (start, end))]
    except psycopg.Error as e:
        ovr = None
        findings.append({"code": "khong_kiem_duoc", "table": "decisions",
                         "detail": _why(e)})
    for o in ovr or ():
        if _norm(o["by"]) == _norm(o["q_created_by"]):
            findings.append({"code": "override_tu_trinh", "table":
                             "decisions", "id": o["id"],
                             "queue_id": o["queue_id"], "block": o["block"]})
        if (o["q_status"] == "approved"
                and _norm(o["by"]) == _norm(o["q_decided_by"])):
            findings.append({"code": "tu_ep_tu_duyet", "table": "decisions",
                             "id": o["id"], "queue_id": o["queue_id"],
                             "block": o["block"]})
    per = Counter(_norm(o["by"]) for o in ovr or ())
    for who, n in sorted(per.items()):
        if n > max_per_person:
            ids = [o["id"] for o in ovr if _norm(o["by"]) == who]
            findings.append({"code": "override_don_dap", "table": "decisions",
                             "id": ids[0], "ids": ids, "n": n})
    try:
        findings += [{"code": "can_cu_sai", "table": "decision_log",
                      "id": i, "queue_id": b}
                     for i, b in _rows(conn, _BASIS_SQL)]
    except psycopg.Error as e:
        findings.append({"code": "khong_kiem_duoc", "table": "decision_log",
                         "detail": _why(e)})
    return {"overrides": ovr or [], "findings": findings}


_PRIV_SQL = (
    "select c.relname, p.priv from pg_class c cross join unnest(array["
    "'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv) where"
    " c.relnamespace = current_schema()::regnamespace and c.relkind in"
    " ('r', 'p') and case when p.priv in ('INSERT', 'UPDATE') then"
    " has_any_column_privilege(%s, c.oid, p.priv) else"
    " has_table_privilege(%s, c.oid, p.priv) end order by 1, 2")
_FUNC_SQL = (
    "select p.oid::regprocedure::text from pg_proc p where p.pronamespace ="
    " current_schema()::regnamespace and p.prosecdef and p.proname <> all(%s)"
    " and has_function_privilege(%s, p.oid, 'EXECUTE') order by 1")
_MEMBER_SQL = (
    "select a.rolname, b.rolname from pg_roles a join pg_roles b on a.oid"
    " <> b.oid where a.rolname = any(%s) and b.rolname = any(%s) and"
    " pg_has_role(a.oid, b.oid, 'USAGE')")


_SEL_SQL = (
    "select c.relname from pg_class c where c.relnamespace ="
    " current_schema()::regnamespace and c.relkind in ('r', 'p', 'v', 'm')"
    " and (has_table_privilege(%s, c.oid, 'SELECT') or"
    " has_any_column_privilege(%s, c.oid, 'SELECT')) order by 1")


def _excess(role: str, table: str, priv: str) -> bool:
    if role == "bks_reader":
        # v15.4 (P10.3): + INSERT sổ đầu ra báo cáo BKS (append-only).
        return not ((table, priv) in (("audit_runs", "INSERT"),
                                      ("report_outputs", "INSERT")))
    if role in READ_ONLY_ROLES:
        return True
    if (role, table, priv) == ("svc_loader", "plot_logs", "DELETE"):
        # Nạp lại nhật ký MẪU chưa chain (core_store); trigger
        # `plot_logs_guard` chặn xóa dòng đã chain kể cả owner.
        return False
    return ((table in APPEND_ONLY and priv != "INSERT")
            or (table in FUNC_ONLY_INSERT and priv == "INSERT"))


def _excess_read(role: str, table: str) -> bool:
    """v14.2: SELECT vượt — Bên A ngoài số tổng hợp; mọi role (trừ backup)
    đọc bảng PII."""
    if role == "ben_a_reader":
        return table not in BEN_A_READS
    return role != "svc_backup" and table in PII_TABLES


def check_privileges(conn) -> list[dict]:
    """Quyền vượt của 3 role DB (catalog — không cần quyền đặc biệt)."""
    try:
        roles = [r[0] for r in _rows(
            conn, "select rolname from pg_roles where rolname = any(%s)"
                  " order by 1", (list(WATCH_ROLES),))]
        member = set(_rows(conn, _MEMBER_SQL, (roles, roles)))
        raw = set()
        for role in roles:
            raw |= {(role, t, p) for t, p in _rows(conn, _PRIV_SQL,
                                                   (role, role))
                    if _excess(role, t, p)}
            raw |= {(role, t, "SELECT") for (t,) in _rows(conn, _SEL_SQL,
                                                           (role, role))
                    if _excess_read(role, t)}
            if role == "bks_reader" or role in READ_ONLY_ROLES:
                raw |= {(role, f"function {f}", "EXECUTE") for (f,) in _rows(
                    conn, _FUNC_SQL,
                    ([*READ_FUNCS, *ROLE_FUNCS.get(role, ())], role))}
    except psycopg.Error as e:
        return [{"code": "khong_kiem_duoc", "table": "pg_catalog",
                 "detail": _why(e)}]
    out = []
    for role, t, p in sorted(raw):
        via = [m for (r, m) in member if r == role and (m, t, p) in raw]
        if via:          # kế thừa — báo ở role gốc
            continue
        out.append({"code": "quyen_vuot", "role": role, "table": t,
                    "priv": p})
    return out


# ------------------------------------------------------------ chạy + báo cáo

def run(conn, start, end) -> dict:
    prev = latest_heads(conn)
    heads, chain_f = check_chains(conn, prev)
    ovr = check_overrides(conn, start, end)
    findings = (chain_f + check_approvals(conn) + ovr["findings"]
                + check_privileges(conn))
    return {"prev_heads": prev, "heads": heads, "findings": findings,
            "overrides": ovr["overrides"]}


def by_code(findings: list[dict]) -> dict:
    c = Counter(f["code"] for f in findings)
    return {k: c.get(k, 0) for k in CODES}


def _vn(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y") if ts else "—"


_MD = str.maketrans({"`": "'", "|": "/", "[": "(", "]": ")", "<": "‹",
                     ">": "›", "*": "·", "_": " "})


def _person(s, n: int = 60) -> str:
    """Chuỗi do NGƯỜI nhập (tên, lý do) vào báo cáo markdown: che PII, 1
    dòng, bỏ ký tự markdown/HTML (không tạo link/ảnh/bảng — OWASP A03)."""
    return _oneline(_mask_pii(safe(s)), n).translate(_MD)


def override_line(o: dict) -> str:
    """1 dòng override_qa: #id, #mục, khối, ngày VN, người + lý do đã che."""
    return (f"- #{o['id']} · mục #{o['queue_id']} · khối {o['block']} · "
            f"{_vn(o['created_at'])} · người quyết: {_person(o['by'])} · lý "
            f"do: {_person(o['reason'], 160)}")


def _finding_line(f: dict) -> str:
    parts = [f"[{f['code']}]"]
    if "role" in f:
        parts.append(f"role {f['role']} có {f['priv']} trên {f['table']}")
    else:
        parts.append(f"{f.get('table', '?')}")
        if f.get("id") is not None:
            parts.append(f"#{f['id']}")
    for k in ("object_type", "block"):
        if f.get(k):
            parts.append(f"{k} {safe(f[k])}")
    if f.get("queue_id") is not None:
        parts.append(f"mục #{f['queue_id']}")
    if f.get("problem"):
        parts.append(f"— {f['problem']}")
    if f.get("ids"):
        parts.append(f"— {f['n']} lần (#" + ", #".join(
            str(i) for i in f["ids"]) + ")")
    if f.get("detail"):
        parts.append(f"— {f['detail']}")
    return "- " + " ".join(parts)


def render(data: dict, label: str, now: datetime) -> str:
    counts = by_code(data["findings"])
    vn = now.astimezone(VN_TZ)
    L = [f"# Audit inside-out BKS — kỳ {label}", "",
         (f"Sinh lúc {vn:%d/%m/%Y %H:%M} giờ VN bởi `{RUN_BY}` (sổ lần chạy "
          "MÁY — KHÔNG phải chữ ký Ban kiểm soát). Chỉ đọc: hệ thống không "
          "sửa/xóa/duyệt gì."), "",
         "## Tổng theo mã", "", "| Mã | Số phát hiện |", "|---|---|"]
    L += [f"| {c} | {n} |" for c, n in counts.items()]
    L += ["", f"Tổng: {sum(counts.values())} phát hiện.", "",
          "## Chuỗi hash + neo đuôi", ""]
    for table, _fn, _w in CHAINS:
        h = data["heads"].get(table)
        if h is None:
            L.append(f"- {table}: không đọc được đầu chuỗi")
            continue
        if h["max_id"] is None:
            L.append(f"- {table}: 0 dòng đã chain (chuỗi rỗng)")
            continue
        L.append(f"- {table}: {h['n']} dòng đã chain · đầu #{h['max_id']}"
                 f" · băm đầu {(h['row_hash'] or '—')[:12]}")
    if data["prev_heads"] is None:
        L.append(f"- {FIRST_RUN}")
    else:
        L.append("- Đối chiếu neo của lần audit inside-out ghi sổ gần nhất "
                 "(`audit_runs`).")
    L += ["", "## Chi tiết phát hiện", ""]
    L += [_finding_line(f) for f in data["findings"]] or [
        "- (không có phát hiện)"]
    L += ["", "## Ép trình QA (override_qa) trong kỳ", ""]
    L += [override_line(o) for o in data["overrides"]] or [
        "- (không có override_qa trong kỳ)"]
    L += ["", "## Giới hạn", "", f"- {LIMIT_NOTE}",
          ("- Audit tính lại tại lúc chạy từ DB; nội dung bài/payload KHÔNG "
           "chép ra báo cáo (chỉ #id, bảng, khối)."), "", "---",
          "*BẢN NHÁP — chờ BKS ký (external-dep); hệ thống không tự gửi.*",
          ""]
    return "\n".join(L)


# v14.3: loại lần chạy → tính năng danh mục (cổng giai đoạn HĐ 6.7).
KIND_FEATURE = {"inside_out": "ceo-04.2", "recon": "ceo-04.1",
                "hdtv_pack": "ceo-05"}


def record_run(conn, kind: str, label: str, params: dict, findings: int,
               text: str, run_by: str, sample: bool = False) -> int:
    """Ghi 1 dòng `audit_runs` (sha256 = bản báo cáo đã ghi) + commit
    tường minh (conn có thể đã mở tx bằng SELECT — gotcha v2.1). v14.3:
    tính năng của `kind` TẮT → RolloutBlocked, không ghi; `sample` = báo
    cáo dựng trên số MẪU → cờ provenance `is_sample` (không đếm đầu ra)."""
    from pipelines import rollout  # lười: rollout → director → ...
    rollout.check_generate(conn, KIND_FEATURE.get(kind),
                           f"sổ lần chạy kiểm soát ({kind})")
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    rid = conn.execute(
        "insert into audit_runs (kind, period_label, params, findings,"
        " report_sha256, run_by, is_sample) values (%s, %s, %s, %s, %s, %s,"
        " %s) returning id",
        (kind, label, Jsonb(params), findings, sha, run_by, bool(sample))
    ).fetchone()[0]
    conn.commit()
    return rid


def month_bounds(month_arg: str | None, now: datetime):
    """--month (hoặc tháng vừa đóng) → (nhãn, start, end); sai/chưa đóng →
    ValueError."""
    if month_arg is None:
        m = last_closed_ref("month", now).replace(day=1)
    else:
        m = parse_month(month_arg)
        if m is None:
            raise ValueError("--month phải dạng YYYY-MM")
    start, end = _closed("month", m, now)
    return f"{m:%Y-%m}", start, end


def main(argv=None, now=None) -> int:
    from pipelines.rollout import RolloutBlocked  # lười: tránh vòng import
    ap = argparse.ArgumentParser(
        prog="python -m agents.bks_audit",
        description="Audit inside-out BKS (CHỈ ĐỌC; ghi duy nhất audit_runs "
                    "khi --record)")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--month", help="YYYY-MM (mặc định tháng vừa đóng)")
    ap.add_argument("--now", help="ISO; thiếu múi giờ = giờ VN")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--record", action="store_true",
                    help="ghi 1 dòng audit_runs (neo đuôi chuỗi)")
    ap.add_argument("--dry-run", action="store_true",
                    help="in báo cáo ra stdout, không ghi file/DB")
    a = ap.parse_args(argv)
    if a.record and a.dry_run:
        ap.error("--record và --dry-run loại trừ nhau")
    if not a.report:
        ap.error("cần --report")
    try:
        now = parse_now(a.now) if a.now else (now or datetime.now(VN_TZ))
    except ValueError:
        ap.error("--now sai định dạng ISO")
    try:
        label, start, end = month_bounds(a.month, now)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if not a.record:
            conn.read_only = True     # DB từ chối mọi lệnh ghi
        data = run(conn, start, end)
        text = render(data, label, now)
        n = len(data["findings"])
        if a.dry_run:
            print(text)
            return 0
        # P8.4: kiểm toán trên DB thật (chuỗi hash/duyệt/quyền) — không có
        # đường dữ liệu mẫu; cùng cờ với `record_run` (mặc định False).
        path = write_report(text, a.out_dir, f"bks-audit-{label}.md",
                            sample=False)
        rid = None
        if a.record:
            rid = record_run(conn, KIND, label,
                             {"heads": data["heads"],
                              "by_code": by_code(data["findings"])},
                             n, text, RUN_BY)
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_why(e)}", file=sys.stderr)
        return 2
    except RolloutBlocked as e:      # HĐ 6.7
        print(f"[blocked] {e}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.rollback()
        with suppress(Exception):
            conn.close()
    print(f"[done] {path} — kỳ {label}, {n} phát hiện"
          + (f" · audit_runs #{rid}" if rid else " · không ghi sổ"))
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.bks_audit") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
