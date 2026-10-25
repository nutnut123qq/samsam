"""r13 ceo-90 / N22 — gói kiểm CHỈ ĐỌC sự cố 20/10/2026 (`docs/handover/su-co-db-samsam.md` mục 5, bước 2–5) giữa HAI bản sao
cô lập do DBA Bên B dựng: bản khôi phục từ backup TRƯỚC sự cố và bản dump hiện tại.

  INCIDENT_BASELINE_URL=<DSN bản trước> INCIDENT_NOW_URL=<DSN bản hiện tại> \
      python scripts/incident_compare.py [--out FILE.md]

- DSN CHỈ qua biến môi trường (không argv/log); mỗi DSN phải có dbname tường minh, KHÁC `samsam` (không bao giờ chạy trên DB
  thật) → sai = exit 2, 0 kết nối. Phiên `default_transaction_read_only`, không sửa gì.
- So (chỉ SỐ ĐẾM/TÊN, không chép dữ liệu dòng): mỗi bảng public `count(*)`, `max(id)`, `max(<cột thời gian>)`; số dòng có thời
  điểm trong khung sự cố [2026-10-20 03:03:38, 03:28:30] UTC ở các bảng mục 5.2; `verify_action_log()` (số vấn đề chuỗi hash);
  quyền bảng/cột/hàm + thuộc tính/thành viên role; cột schema (thay `pg_dump --schema-only` — không cần công cụ ngoài).
- Thiếu một trong hai DSN → in UNVERIFIED (không kết luận "không mất dữ liệu" từ trạng thái hiện tại), exit 2.
Exit: 0 hai bản khớp · 1 có khác biệt (DBA Bên B quyết; script không sửa/xóa) · 2 thiếu đầu vào / bị từ chối / lỗi kết nối.
"""
import argparse
import os
import sys
from pathlib import Path

import psycopg
from psycopg import conninfo, sql

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

WINDOW = ("2026-10-20 03:03:38+00", "2026-10-20 03:28:30+00")
WINDOW_TABLES = ("job_runs", "red_alerts", "red_alert_deliveries", "red_alert_acks", "agent_action_log",
                 "approval_queue", "intel_items", "channel_posts", "llm_usage", "san_suggestions", "chat_kpi_live",
                 "file_output_evidence")
TIME_COLS = ("ts", "created_at", "started_at", "sent_at", "acked_at", "at", "fetched_at")


class Refused(ValueError):
    """Đầu vào không an toàn — không kết nối."""


def check_dsn(dsn: str, name: str) -> str:
    try:
        d = conninfo.conninfo_to_dict(dsn)
    except psycopg.ProgrammingError:
        raise Refused(f"{name}: DSN không đọc được") from None
    db = (d.get("dbname") or "").strip()
    if not db:
        raise Refused(f"{name}: thiếu dbname tường minh")
    if db.casefold() == "samsam":
        raise Refused(f"{name}: trỏ DB `samsam` thật — chỉ chạy trên BẢN SAO cô lập")
    return db


def snapshot(conn) -> dict:
    """Số đếm/tên từ 1 bản — không lấy dữ liệu dòng."""
    q = conn.execute
    tables = [r[0] for r in q("select table_name from information_schema.tables where table_schema = 'public'"
                              " and table_type = 'BASE TABLE' order by 1")]
    cols = {}
    for t, c, typ, null in q("select table_name, column_name, data_type, is_nullable from"
                             " information_schema.columns where table_schema = 'public'"):
        cols.setdefault(t, {})[c] = (typ, null)
    stats, window = {}, {}
    for t in tables:
        tc = next((c for c in TIME_COLS if c in cols.get(t, {})), None)
        int_id = cols[t].get("id", ("",))[0] in ("integer", "bigint", "smallint")   # uuid không có max()
        parts = [sql.SQL("count(*)"),
                 sql.SQL("max({})::text").format(sql.Identifier("id")) if int_id else sql.SQL("null"),
                 sql.SQL("max({})::text").format(sql.Identifier(tc)) if tc else sql.SQL("null")]
        stats[t] = tuple(q(sql.SQL("select {} from {}").format(sql.SQL(", ").join(parts),
                                                              sql.Identifier(t))).fetchone())
        if t in WINDOW_TABLES and tc:
            window[t] = q(sql.SQL("select count(*) from {} where {} between %s and %s").format(
                sql.Identifier(t), sql.Identifier(tc)), WINDOW).fetchone()[0]
    chain = None
    if q("select 1 from pg_proc where proname = 'verify_action_log'").fetchone():
        chain = q("select count(*) from verify_action_log()").fetchone()[0]
    grants = {("bang",) + r for r in q(
        "select grantee, table_name, privilege_type from information_schema.role_table_grants"
        " where table_schema = 'public'")}
    grants |= {("cot",) + r for r in q(
        "select grantee, table_name, column_name, privilege_type from information_schema.column_privileges"
        " where table_schema = 'public'")}
    grants |= {("ham",) + r for r in q(
        "select grantee, routine_name, privilege_type from information_schema.routine_privileges"
        " where routine_schema = 'public'")}
    roles = {r[0]: r[1:] for r in q(
        "select rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls, rolinherit"
        " from pg_roles where rolname !~ '^pg_'")}
    members = set(q("select r.rolname, m.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid"
                    " join pg_roles m on m.oid = a.member where r.rolname !~ '^pg_'").fetchall())
    conn.rollback()
    return {"tables": tables, "cols": cols, "stats": stats, "window": window, "chain": chain,
            "grants": grants, "roles": roles, "members": members}


def compare(a: dict, b: dict) -> list[str]:
    """Khác biệt giữa bản TRƯỚC (a) và bản HIỆN TẠI (b) → dòng mô tả (tên/số, không dữ liệu)."""
    out = []
    for t in sorted(set(a["tables"]) ^ set(b["tables"])):
        out.append(f"bảng {t}: chỉ có ở bản {'trước' if t in a['tables'] else 'hiện tại'}")
    for t in sorted(set(a["tables"]) & set(b["tables"])):
        if a["stats"][t] != b["stats"][t]:
            out.append(f"bảng {t}: (count, max id, max thời điểm) trước {a['stats'][t]} · hiện tại {b['stats'][t]}")
        if a["cols"].get(t) != b["cols"].get(t):
            out.append(f"bảng {t}: cột/kiểu khác nhau")
    for t, n in sorted(b["window"].items()):
        if n:
            out.append(f"bảng {t}: {n} dòng có thời điểm trong khung sự cố ở bản hiện tại")
    if a["chain"] != b["chain"]:
        out.append(f"verify_action_log: vấn đề chuỗi trước {a['chain']} · hiện tại {b['chain']}")
    elif b["chain"]:
        out.append(f"verify_action_log: {b['chain']} vấn đề chuỗi ở cả hai bản")
    for g in sorted(a["grants"] ^ b["grants"]):
        out.append(f"quyền {'/'.join(map(str, g))}: chỉ có ở bản {'trước' if g in a['grants'] else 'hiện tại'}")
    for r in sorted(set(a["roles"]) | set(b["roles"])):
        if a["roles"].get(r) != b["roles"].get(r):
            out.append(f"role {r}: thuộc tính khác (trước {a['roles'].get(r)} · hiện tại {b['roles'].get(r)})")
    for m in sorted(a["members"] ^ b["members"]):
        out.append(f"thành viên {m[1]} ∈ {m[0]}: chỉ có ở bản {'trước' if m in a['members'] else 'hiện tại'}")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/incident_compare.py", description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    envs = {"trước": os.environ.get("INCIDENT_BASELINE_URL", "").strip(),
            "hiện tại": os.environ.get("INCIDENT_NOW_URL", "").strip()}
    if not all(envs.values()):
        print("[UNVERIFIED] thiếu INCIDENT_BASELINE_URL (bản khôi phục từ backup TRƯỚC sự cố) và/hoặc INCIDENT_NOW_URL"
              " — không kết luận được 'không mất/không lạ dữ liệu' (su-co-db-samsam.md mục 4–5)", file=sys.stderr)
        return 2
    try:
        names = {k: check_dsn(v, k) for k, v in envs.items()}
    except Refused as e:
        print(f"[từ chối] {e} — 0 kết nối", file=sys.stderr)
        return 2
    if names["trước"] == names["hiện tại"] and envs["trước"] == envs["hiện tại"]:
        print("[từ chối] hai DSN giống hệt — cần 2 bản sao khác nhau", file=sys.stderr)
        return 2
    snaps = {}
    for k, dsn in envs.items():
        try:
            with psycopg.connect(dsn, connect_timeout=10, options="-c default_transaction_read_only=on") as c:
                snaps[k] = snapshot(c)
        except psycopg.Error as e:
            print(f"[err] bản {k} ({names[k]}): {type(e).__name__} — không kết luận", file=sys.stderr)
            return 2
    diff = compare(snaps["trước"], snaps["hiện tại"])
    lines = ["# So sánh bản sao sự cố 20/10/2026 (chỉ đọc, chỉ số đếm/tên)", "",
             f"- Bản trước: `{names['trước']}` · bản hiện tại: `{names['hiện tại']}`",
             f"- Khung sự cố: {WINDOW[0]} → {WINDOW[1]}", f"- Số bảng: {len(snaps['hiện tại']['tables'])}",
             f"- Khác biệt: {len(diff)}", ""] + [f"- {d}" for d in diff] + [
             "", "Kết luận/xử lý: DBA Bên B quyết (script không sửa/xóa).", ""]
    text = "\n".join(lines)
    if a.out:
        a.out.write_text(text, encoding="utf-8")
    print(text)
    return 1 if diff else 0


if __name__ == "__main__":
    raise SystemExit(main())
