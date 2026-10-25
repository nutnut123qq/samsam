"""v15 fix P10.2 — người ĐƯỢC PHÉP phải HOÀN THÀNH được nghiệp vụ.

Lỗi (evidence/v15_resume_p11_authz_probes.log, probe
`P10_authorized_da_pmo_cli`): login KHÔNG owner `in role app_human`, có
`human_logins` + users file `db_login` + approvers khối ceo hợp lệ chạy
`da_pmo --set-status` → exit 2 `permission denied for table
project_milestones` — đã qua cổng ủy quyền nhưng không ghi được. Cùng lớp
(CLI người ghi bảng trực tiếp mà app_human không có quyền ghi):
`da_pmo --apply-due`, `da_b2b --handover`, `ra_kenh --mark-removed`,
`anchor --submit --by <người>`; `kd_quote --outcome/--verify-send --by` ghi
được nhưng bằng INSERT cột trực tiếp → SQL thẳng ghi tên người khác.

Probe (login Postgres THẬT tạm, không superuser/owner, schema tạm ĐÃ COMMIT;
CLI chạy bằng SUBPROCESS như `python -m`): đúng người → exit 0 + DB đổi đúng;
chạy lại → DB không đổi (no-op/idempotent); agent:/system:, sai khối, `--by`
giả (login người khác), thiếu ủy quyền (approvers rỗng / login chưa ánh xạ
`human_logins` / khối không thuộc login) → chặn, 0 thay đổi nghiệp vụ; SQL
trực tiếp không vượt (UPDATE/INSERT bảng bị từ chối, gọi function `--by` giả
/ khối sai / bất biến sai → lỗi, 0 ghi); loader/agent không gọi được
function người. Người/khối/login là dữ liệu GIẢ của test. Neo blockchain:
provider GIẢ trong tiến trình con (không mở mạng). Skip khi không có
DATABASE_URL."""

import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import InsufficientPrivilege
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")

# người GIẢ của test (không phải người thật)
P_CEO = "TGĐ Giả Lập P102"            # khối ceo + farming
P_LEGAL = "Pháp Chế Giả Lập P102"     # khối legal_hr
P_SALES = "Bán Hàng Giả Lập P102"     # khối sales
P_NOMAP = "Chưa Ánh Xạ P102"          # có users file + approvers, KHÔNG human_logins
P_NOBLK = "Sai Khối Giả P102"         # approvers ceo/farming, human_logins chỉ sales
P_LNB = "Pháp Chế Sai Khối P102"      # approvers legal_hr, human_logins chỉ sales
APPROVER = "Người Duyệt Giả P102"     # owner quyết mục hàng duyệt (decide_item)
IMPORTER = "Nhập Liệu Giả P102"

LAUNCHER = '''import os, runpy, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from pipelines import auth
auth.DIRECTORS_DIR = Path(sys.argv[2])
mod = sys.argv[3]
if mod == "pipelines.anchor":
    # provider GIẢ: không mở mạng; ghi lại mỗi lần "gửi" để kiểm không gửi
    # trước khi DB xác nhận danh tính.
    from pipelines import anchor
    anchor.load_config = lambda *a, **k: {
        "provider": "opentimestamps",
        "calendars": ["https://cal.p102.invalid"], "timeout_s": 1}
    _orig = anchor.submit

    def _post(url, body, timeout):
        with open(os.environ["P102_POST_LOG"], "a", encoding="utf-8") as f:
            f.write(body.hex() + "\\n")
        return bytes.fromhex("f01011111111111111111111111111111111080083dfe30d2ef90c8e191868747470733a2f2f63616c2e703130322e696e76616c6964")  # OTS hợp lệ (r13)

    def _submit(conn, ref, cfg, by=anchor.CREATED_BY, post=None):
        return _orig(conn, ref, cfg, by=by, post=_post)
    anchor.submit = _submit
    sys.exit(anchor.main(sys.argv[4:]))
sys.argv = [mod] + sys.argv[4:]
runpy.run_module(mod, run_name="__main__", alter_sys=True)
'''

FN_SIGS = (
    "milestone_set_status_human(text, text, text, text)",
    "milestone_apply_due_human(bigint, text)",
    "org_handover_human(bigint, text, text)",
    "org_batch_rows_human(bigint, text)",
    "channel_post_mark_removed_human(text, timestamp with time zone, text)",
    "anchor_receipt_human(bigint, text, text, bytea, text, text)",
    "b2b_quote_event_human(bigint, text, text, text)",
)


def _login_dsn(base, user, pw, schema):
    d = conninfo.conninfo_to_dict(base)
    d.update(user=user, password=pw, options=f"-c search_path={schema}")
    return conninfo.make_conninfo(**d)


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_v15f102_{tag}"
    kinds = {"ceo": "app_human", "legal": "app_human", "sales": "app_human",
             "nomap": "app_human", "noblock": "app_human",
             "legalnb": "app_human", "loader": "svc_loader",
             "agent": "agent_writer"}
    logins = {k: (f"t_p102_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    tmp = tmp_path_factory.mktemp("p102cfg")
    try:
        admin.execute("set lock_timeout = '60s'")
        admin.execute(f"create schema {schema}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}, pg_temp")
            admin.execute(SCHEMA_SQL)
            admin.execute(ROLES_SQL)
        for k, (name, pw) in logins.items():
            admin.execute(f"create role {name} login password '{pw}'"
                          f" nosuperuser nocreatedb nocreaterole"
                          f" in role {kinds[k]}")
        name = {k: n for k, (n, _) in logins.items()}
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}")
            for k, person, blocks in (
                    ("ceo", P_CEO, ["ceo", "farming"]),
                    ("legal", P_LEGAL, ["legal_hr"]),
                    ("sales", P_SALES, ["sales"]),
                    ("noblock", P_NOBLK, ["sales"]),
                    ("legalnb", P_LNB, ["sales"])):
                admin.execute("insert into human_logins (db_login, person,"
                              " blocks, granted_by) values (%s, %s, %s,"
                              " 'test-p102')", (name[k], person, blocks))
            # giai đoạn tính năng (biên DÙNG đọc từ DB trong tiến trình con)
            for fid, stage in (("ceo-02.1", "van_hanh"),
                               ("sales-05", "van_hanh"),
                               ("farming-06", "co_nguoi_duyet")):
                admin.execute("insert into feature_rollout (feature_id,"
                              " stage, updated_by) values (%s, %s,"
                              " 'test-p102')", (fid, stage))
        d = tmp / "directors"
        shutil.copytree(ROOT / "data" / "directors", d)
        for blk, who in (("ceo", [P_CEO, P_NOMAP, P_NOBLK]),
                         ("farming", [P_CEO, P_NOMAP, P_NOBLK]),
                         ("legal_hr", [P_LEGAL, P_LNB]),
                         ("sales", [P_SALES])):
            p = d / f"{blk}.json"
            c = json.loads(p.read_text(encoding="utf-8"))
            c["approvers"] = who
            p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        users = tmp / "users.json"
        users.write_text(json.dumps({
            P_CEO.casefold(): {"role": "tgd", "db_login": name["ceo"]},
            P_LEGAL.casefold(): {"role": "phap_che",
                                 "db_login": name["legal"]},
            P_SALES.casefold(): {"role": "gd_ban_hang",
                                 "db_login": name["sales"]},
            P_NOMAP.casefold(): {"role": "tgd", "db_login": name["nomap"]},
            P_NOBLK.casefold(): {"role": "tgd", "db_login": name["noblock"]},
            P_LNB.casefold(): {"role": "phap_che",
                               "db_login": name["legalnb"]},
        }, ensure_ascii=False), encoding="utf-8")
        launcher = tmp / "launch_p102.py"
        launcher.write_text(LAUNCHER, encoding="utf-8")
        dsn = {k: _login_dsn(base, n, p, schema)
               for k, (n, p) in logins.items()}
        yield {"admin": admin, "schema": schema, "dsn": dsn, "name": name,
               "dirs": d, "users": users, "launcher": launcher, "tmp": tmp}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for n, _ in logins.values():
            admin.execute(f"drop role if exists {n}")
        admin.close()


def _q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        cur = a.execute(sql, args or None)
        return cur.fetchall() if cur.description else []


def _denied(live, otype, oid):
    return _q(live, "select count(*) from agent_action_log where action ="
              " 'authz_denied' and object_type = %s and object_id = %s",
              (otype, str(oid)))[0][0]


def _log(live, action, oid=None):
    if oid is None:
        return _q(live, "select actor, db_role from agent_action_log where"
                  " action = %s order by id", (action,))
    return _q(live, "select actor, db_role from agent_action_log where"
              " action = %s and object_id = %s order by id",
              (action, str(oid)))


def _cli(live, who, module, *args, env=None):
    """Chạy CLI bằng SUBPROCESS dưới login `who` (chế độ thực)."""
    e = {k: v for k, v in os.environ.items()
         if not k.endswith("DATABASE_URL") and k not in (
             "AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE", "APPROVAL_ENFORCE")}
    e.update(DATABASE_URL=live["dsn"][who], APPROVAL_ENFORCE="1",
             AUTH_USERS_FILE=str(live["users"]), PYTHONIOENCODING="utf-8",
             P102_POST_LOG=str(live["tmp"] / "anchor_posts.log"),
             **(env or {}))
    p = subprocess.run(
        [sys.executable, str(live["launcher"]), str(ROOT), str(live["dirs"]),
         module, *map(str, args)], cwd=ROOT, env=e, capture_output=True,
        timeout=180, encoding="utf-8", errors="replace", check=False)
    return p.returncode, p.stdout + p.stderr


def _conn(live, who):
    return psycopg.connect(live["dsn"][who], connect_timeout=5)


def _db_raises(live, who, sql, args, frag, exc=InsufficientPrivilege):
    """Gọi thẳng SQL bằng login `who` → lỗi `exc` chứa `frag`, 0 ghi."""
    with _conn(live, who) as c, pytest.raises(exc) as ei:
        c.execute(sql, args)
    assert frag in str(ei.value), str(ei.value)


@contextmanager
def _approvers(live, block, names):
    p = live["dirs"] / f"{block}.json"
    keep = p.read_text(encoding="utf-8")
    c = json.loads(keep)
    c["approvers"] = names
    p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
    try:
        yield
    finally:
        p.write_text(keep, encoding="utf-8")


def _enqueue(live, otype, oid, block, payload, created_by):
    qid = _q(live, "select enqueue_item(%s, %s, %s, %s, %s, 'low',"
             " '{\"ok\": true}'::jsonb, null, %s, 24)",
             (otype, oid, block, f"mục giả p102 {oid}", payload,
              created_by))[0][0]
    return qid


def _decide(live, qid, decision="approved"):
    _q(live, "select decide_item(%s, %s, %s)", (qid, APPROVER, decision))


# ============== probe gọn: ĐÚNG NGƯỜI hoàn thành nghiệp vụ (mỗi đường 1 ca)
# Từng đường độc lập (đối tượng riêng) để trước/sau sửa đọc được kết quả
# của CHÍNH ca đúng người — "không còn thông báo ủy quyền" KHÔNG phải bằng
# chứng: assert exit 0 + DB đổi đúng + chạy lại không đổi DB.

def _ok_set_status(live):
    code = "M-P102K"
    _q(live, "insert into project_milestones (code, title, owner_role,"
       " due_date, gate, source, updated_by) values (%s, 'Mốc P102 ok',"
       " 'tgd', '2026-12-01', 'gate', 'test-p102', 'seed')", (code,))
    argv = ("--set-status", code, "--status", "dang_lam", "--by", P_CEO)
    sql = (("select status, updated_by, updated_at from project_milestones"
            " where code = %s"),
           (code,))
    return "ceo", "agents.da_pmo", argv, sql, [("dang_lam", P_CEO)], 0


def _ok_apply_due(live):
    from agents import da_pmo
    code = "M-P102K2"
    _q(live, "insert into project_milestones (code, title, owner_role,"
       " due_date, gate, source, updated_by) values (%s, 'Mốc P102 ok2',"
       " 'tgd', '2026-12-01', 'gate', 'test-p102', 'seed')", (code,))
    qid = _enqueue(live, "milestone_change", f"milestone:{code}", "ceo",
                   da_pmo.change_payload(code, date(2026, 12, 1),
                                         date(2026, 12, 9), P_SALES), P_SALES)
    _decide(live, qid)
    argv = ("--apply-due", qid, "--by", P_CEO)
    sql = (("select due_date, updated_by, updated_at from project_milestones"
            " where code = %s"),
           (code,))
    return "ceo", "agents.da_pmo", argv, sql, [(date(2026, 12, 9), P_CEO)], 0


def _ok_handover(live):
    qid, ids = _batch(live, 9)
    _decide(live, qid)
    argv = ("--handover", qid, "--by", P_SALES)
    sql = (("select status, handed_at is not null, handed_at from"
            " org_prospects where id = any(%s) order by id"),
           (ids,))
    return "sales", "agents.da_b2b", argv, sql, [("chuyen_sales", True)] * 2, 0


def _ok_mark_removed(live):
    url = "https://www.facebook.com/samsam.gia/posts/p102000000009"
    _q(live, "insert into channel_posts (url, channel, content_type, is_ai,"
       " text, text_sha256, guardrail, codes, severity, first_detected_at,"
       " due_at, imported_by, scanned_at) values (%s, 'facebook', 'bai_viet',"
       " false, 'bài giả p102', %s, '{}'::jsonb, '{tu_cam}', 'S1', now(),"
       " now() + interval '24 hours', 'MXH Giả P102', now())", (url, "b" * 64))
    argv = ("--mark-removed", url, "--by", P_LEGAL)
    sql = (("select close_reason, closed_by, closed_at from channel_posts"
            " where url = %s"),
           (url,))
    # chạy lại: đợt đã đóng → exit 1 "không có đợt vi phạm đang mở", 0 đổi
    return "legal", "agents.ra_kenh", argv, sql, [("da_go", P_LEGAL)], 1


def _ok_anchor(live):
    from pipelines import anchor
    as_of = _q(live, "select date_trunc('second', now()) - interval '2 hour'"
               )[0][0]
    d = {"t": "plot_logs_head", "id": 9, "row_hash": "9" * 64}
    leaves = [{"k": "plot_logs_head:9", "d": d, "h": anchor.leaf_hash(d)}]
    root = anchor.merkle_root([x["h"] for x in leaves])
    sha = hashlib.sha256(anchor.manifest(anchor._us(as_of), leaves,
                                         root)).hexdigest()
    bid = _q(live, "insert into anchor_batches (as_of, leaves, merkle_root,"
             " manifest_sha256, created_by) values (%s, %s, %s, %s,"
             " 'agent:anchor') returning id",
             (as_of, Jsonb(leaves), root, sha))[0][0]
    argv = ("--submit", bid, "--by", P_CEO)
    sql = (("select status, created_by, id from anchor_receipts where"
            " batch_id = %s order by id"),
           (bid,))
    return "ceo", "pipelines.anchor", argv, sql, [("da_gui", P_CEO)], 0


def _ok_outcome(live):
    qid = _enqueue(live, "b2b_quote", "BG-20261018-9-p1020009", "sales",
                   QUOTE_TEXT, "agent:kd_quote")
    _decide(live, qid)
    argv = ("--outcome", qid, "khong_chot", "--by", P_SALES)
    sql = (("select kind, recorded_by, id from b2b_quote_events where"
            " queue_id = %s order by id"),
           (qid,))
    # chạy lại: kết quả đã ghi → exit 1 "đã ghi kết quả", 0 đổi
    return "sales", "agents.kd_quote", argv, sql, [("khong_chot", P_SALES)], 1


def _ok_verify_send(live):
    qid = _enqueue(live, "b2b_quote", "BG-20261018-8-p1020008", "sales",
                   QUOTE_TEXT, "agent:kd_quote")
    _decide(live, qid)
    md = live["tmp"] / "bao-gia-p102-ok.md"
    md.write_text(QUOTE_TEXT, encoding="utf-8", newline="\n")
    argv = ("--verify-send", qid, md, "--by", P_SALES)
    sql = (("select kind, recorded_by, id from b2b_quote_events where"
            " queue_id = %s order by id"),
           (qid,))
    # mốc gửi ghi MỖI lần gửi (thiết kế v14.4) → chạy lại = thêm 1 mốc
    return "sales", "agents.kd_quote", argv, sql, [("da_gui", P_SALES)], None


OK_PATHS = {"da_pmo-set-status": _ok_set_status,
            "da_pmo-apply-due": _ok_apply_due,
            "da_b2b-handover": _ok_handover,
            "ra_kenh-mark-removed": _ok_mark_removed,
            "anchor-submit-by-person": _ok_anchor,
            "kd_quote-outcome": _ok_outcome,
            "kd_quote-verify-send-by": _ok_verify_send}


@pytest.mark.parametrize("path", list(OK_PATHS))
def test_p102_authorized_person_completes(live, path):
    who, mod, argv, (sql, args), want, rerun_rc = OK_PATHS[path](live)
    before = _q(live, sql, args)
    rc, out = _cli(live, who, mod, *argv)
    assert rc == 0, out
    after = _q(live, sql, args)
    assert after != before, out
    assert [tuple(r[:2]) for r in after] == want, (after, out)
    rc, out = _cli(live, who, mod, *argv)
    if rerun_rc is None:                     # mốc gửi: mỗi lần gửi 1 mốc
        assert rc == 0, out
        assert [tuple(r[:2]) for r in _q(live, sql, args)] == want * 2
    else:
        assert rc == rerun_rc, out
        assert _q(live, sql, args) == after, out


# ===================================================== da_pmo --set-status

def test_p102_da_pmo_set_status_authorized_human(live):
    """QUYẾT ĐỊNH khối ceo: người được ủy quyền (login của chính họ) đổi
    trạng thái mốc → exit 0 + DB đổi + log; chạy lại no-op. Trước sửa: exit 2
    `permission denied for table project_milestones`."""
    code = "M-P102S"
    _q(live, "insert into project_milestones (code, title, owner_role,"
       " due_date, gate, source, updated_by) values (%s, 'Mốc giả P102',"
       " 'tgd', '2026-12-01', 'biên bản giả', 'test-p102', 'seed')", (code,))

    def snap():
        return _q(live, "select status, evidence, updated_by, updated_at"
                  " from project_milestones where code = %s", (code,))

    s0 = snap()
    d0 = _denied(live, "project_milestone", code)
    args = ("--set-status", code, "--status", "xong", "--evidence",
            "BB-P102-1")
    for who, by in (("ceo", "agent:p102"), ("ceo", "system:cron"),
                    ("sales", P_SALES),          # sai khối
                    ("sales", P_CEO),            # --by giả (login người khác)
                    ("nomap", P_NOMAP),          # login chưa ánh xạ (DB)
                    ("noblock", P_NOBLK)):       # khối không thuộc login (DB)
        rc, out = _cli(live, who, "agents.da_pmo", *args, "--by", by)
        assert rc == 1, (who, by, out)
        assert snap() == s0, (who, by)
    with _approvers(live, "ceo", []):            # Bên B chưa ủy quyền
        rc, out = _cli(live, "ceo", "agents.da_pmo", *args, "--by", P_CEO)
        assert rc == 1 and "ủy quyền" in out, out
    assert snap() == s0
    assert _denied(live, "project_milestone", code) == d0 + 7
    # đúng người, đúng khối, login của chính họ
    rc, out = _cli(live, "ceo", "agents.da_pmo", *args, "--by", P_CEO)
    assert rc == 0, out
    assert _q(live, "select status, evidence, updated_by from"
              " project_milestones where code = %s", (code,)) == [
        ("xong", "BB-P102-1", P_CEO)]
    assert _log(live, "milestone_status", code) == [
        (P_CEO, live["name"]["ceo"])]
    s1 = snap()
    rc, out = _cli(live, "ceo", "agents.da_pmo", *args, "--by", P_CEO)
    assert rc == 0 and "không đổi" in out, out          # chạy lại = no-op
    assert snap() == s1
    assert len(_log(live, "milestone_status", code)) == 1
    # SQL trực tiếp không vượt
    _db_raises(live, "ceo", "update project_milestones set status ="
               " 'dang_lam'", (), "permission denied")
    sql = "select milestone_set_status_human(%s, 'dang_lam', null, %s)"
    _db_raises(live, "ceo", sql, (code, P_SALES), "không phải người của login")
    _db_raises(live, "ceo", sql, (code, "agent:p102"), "không hợp lệ")
    _db_raises(live, "sales", sql, (code, P_SALES),
               "không được ủy quyền khối")
    _db_raises(live, "nomap", sql, (code, P_NOMAP), "chưa được ánh xạ")
    _db_raises(live, "ceo", "select milestone_set_status_human(%s, 'xong',"
               " ' ', %s)", (code, P_CEO), "evidence",
               exc=psycopg.errors.RaiseException)
    assert snap() == s1


# ===================================================== da_pmo --apply-due

def test_p102_da_pmo_apply_due_authorized_human(live):
    """THỰC THI mục đã duyệt (danh tính): đúng người áp hạn đã duyệt → exit
    0 + hạn đổi; chạy lại no-op; DB tự kiểm mục approved + sha bản duyệt."""
    from agents import da_pmo
    code = "M-P102D"
    _q(live, "insert into project_milestones (code, title, owner_role,"
       " due_date, gate, source, updated_by) values (%s, 'Mốc hạn P102',"
       " 'tgd', '2026-12-01', 'biên bản giả', 'test-p102', 'seed')", (code,))
    payload = da_pmo.change_payload(code, date(2026, 12, 1),
                                    date(2026, 12, 15), P_SALES)
    qid = _enqueue(live, "milestone_change", f"milestone:{code}", "ceo",
                   payload, P_SALES)

    def snap():
        return _q(live, "select due_date, updated_by, updated_at from"
                  " project_milestones where code = %s", (code,))

    s0 = snap()
    rc, out = _cli(live, "ceo", "agents.da_pmo", "--apply-due", qid, "--by",
                   P_CEO)
    assert rc == 1 and snap() == s0, out                # chưa duyệt
    _decide(live, qid)
    d0 = _denied(live, "approval_queue", qid)
    for who, by in (("ceo", "agent:p102"), ("ceo", "system:cron"),
                    ("sales", P_CEO),            # --by giả
                    ("nomap", P_NOMAP)):         # login chưa ánh xạ (DB)
        rc, out = _cli(live, who, "agents.da_pmo", "--apply-due", qid,
                       "--by", by)
        assert rc == 1, (who, by, out)
        assert snap() == s0, (who, by)
    assert _denied(live, "approval_queue", qid) == d0 + 4
    rc, out = _cli(live, "ceo", "agents.da_pmo", "--apply-due", qid, "--by",
                   P_CEO)
    assert rc == 0, out
    assert _q(live, "select due_date, updated_by from project_milestones"
              " where code = %s", (code,)) == [(date(2026, 12, 15), P_CEO)]
    assert _log(live, "milestone_due_apply", code) == [
        (P_CEO, live["name"]["ceo"])]
    s1 = snap()
    rc, out = _cli(live, "ceo", "agents.da_pmo", "--apply-due", qid, "--by",
                   P_CEO)
    assert rc == 0 and "no-op" in out, out
    assert snap() == s1 and len(_log(live, "milestone_due_apply", code)) == 1
    # SQL trực tiếp: không UPDATE bảng; mục chưa duyệt / sai loại bị DB chặn
    _db_raises(live, "ceo", "update project_milestones set due_date ="
               " '2027-01-01'", (), "permission denied")
    sql = "select milestone_apply_due_human(%s, %s)"
    _db_raises(live, "ceo", sql, (qid, P_SALES), "không phải người của login")
    pend = _enqueue(live, "milestone_change", f"milestone:{code}", "ceo",
                    da_pmo.change_payload(code, date(2026, 12, 15),
                                          date(2027, 1, 5), P_SALES), P_SALES)
    _db_raises(live, "ceo", sql, (pend, P_CEO), "chỉ áp dụng khi đã duyệt",
               exc=psycopg.errors.RaiseException)
    other = _enqueue(live, "weekly_board", "board:p102", "ceo", "# bảng",
                     "agent:da_pmo")
    _decide(live, other)
    _db_raises(live, "ceo", sql, (other, P_CEO), "milestone_change",
               exc=psycopg.errors.RaiseException)
    assert snap() == s1


# ===================================================== da_b2b --handover

def _batch(live, n0, status_after="cho_duyet"):
    from agents import da_b2b
    ids = []
    for i in range(2):
        org = f"Công ty Quà Tết Giả P102 {n0}-{i}"
        ids.append(_q(live, "insert into org_prospects (dedup_key, org_name,"
                      " org_type, region, website, source_url, fit_reason,"
                      " source, created_by) values (%s, %s, 'doanh_nghiep',"
                      " 'Đà Nẵng', null, 'https://example.vn/p102', 'quà Tết"
                      " nhân viên', 'manual:p102.csv', %s) returning id",
                      (da_b2b.dedup_key(org, "Đà Nẵng"), org, IMPORTER))[0][0])
    rows = [dict(zip(da_b2b.COLS, r)) for r in _q(
        live, f"select {', '.join(da_b2b.COLS)} from org_prospects where id"
        " = any(%s) order by id", (ids,))]
    qid = _enqueue(live, "org_prospect_batch", f"b2b-batch:p102-{n0}",
                   "sales", da_b2b.render_batch(rows), IMPORTER)
    _q(live, "update org_prospects set status = %s, batch_queue_id = %s"
       " where id = any(%s)", (status_after, qid, ids))
    return qid, ids


def test_p102_da_b2b_handover_authorized_human(live):
    qid, ids = _batch(live, 1)

    def snap(q=qid):
        return _q(live, "select id, status, batch_queue_id, handed_at from"
                  " org_prospects where batch_queue_id = %s or id = any(%s)"
                  " order by id", (q, ids))

    s0 = snap()
    rc, out = _cli(live, "sales", "agents.da_b2b", "--handover", qid, "--by",
                   P_SALES)
    assert rc == 1 and snap() == s0, out                # chưa duyệt
    _decide(live, qid)
    d0 = _denied(live, "approval_queue", qid)
    for who, by in (("sales", "agent:p102"), ("sales", "system:cron"),
                    ("sales", P_CEO), ("nomap", P_NOMAP)):
        rc, out = _cli(live, who, "agents.da_b2b", "--handover", qid, "--by",
                       by)
        assert rc == 1, (who, by, out)
        assert snap() == s0, (who, by)
    assert _denied(live, "approval_queue", qid) == d0 + 4
    rc, out = _cli(live, "sales", "agents.da_b2b", "--handover", qid, "--by",
                   P_SALES)
    assert rc == 0 and "2 tổ chức → chuyen_sales" in out, out
    got = snap()
    assert [r[1] for r in got] == ["chuyen_sales"] * 2
    assert all(r[3] is not None for r in got)
    assert _log(live, "org_batch_handover", qid) == [
        (P_SALES, live["name"]["sales"])]
    rc, out = _cli(live, "sales", "agents.da_b2b", "--handover", qid, "--by",
                   P_SALES)
    assert rc == 0 and snap() == got, out               # chạy lại no-op
    assert len(_log(live, "org_batch_handover", qid)) == 1
    # lô bị từ chối → dòng về 'moi' (đúng người)
    rq, rids = _batch(live, 2)
    _decide(live, rq, "rejected")
    rc, out = _cli(live, "sales", "agents.da_b2b", "--handover", rq, "--by",
                   P_SALES)
    assert rc == 0, out
    assert _q(live, "select status, batch_queue_id from org_prospects where"
              " id = any(%s) order by id", (rids,)) == [("moi", None)] * 2
    # SQL trực tiếp
    _db_raises(live, "sales", "update org_prospects set status ="
               " 'chuyen_sales'", (), "permission denied")
    # app_human KHÔNG đọc thẳng bảng (v8.3) — chỉ dòng của 1 lô qua function
    _db_raises(live, "sales", "select org_name from org_prospects", (),
               "permission denied")
    _db_raises(live, "nomap", "select * from org_batch_rows_human(%s, %s)",
               (qid, P_NOMAP), "chưa được ánh xạ")
    pay = _q(live, "select payload from approval_queue where id = %s",
             (qid,))[0][0]
    sql = "select org_handover_human(%s, %s, %s)"
    _db_raises(live, "sales", sql, (qid, pay, P_CEO),
               "không phải người của login")
    q3, ids3 = _batch(live, 3)
    _decide(live, q3)
    _db_raises(live, "sales", sql, (q3, pay, P_SALES), "LỆCH",
               exc=psycopg.errors.RaiseException)
    assert _q(live, "select count(*) from org_prospects where id = any(%s)"
              " and status = 'cho_duyet'", (ids3,)) == [(2,)]
    assert snap() == got


# ===================================================== ra_kenh --mark-removed

URL_RK = "https://www.facebook.com/samsam.gia/posts/p102000000001"


def test_p102_ra_kenh_mark_removed_authorized_human(live):
    """QUYẾT ĐỊNH khối legal_hr: Pháp chế ghi nhận đã gỡ → đợt vi phạm đóng
    `da_go` + log; chạy lại không đổi gì."""
    oid = hashlib.sha256(URL_RK.encode()).hexdigest()[:12]
    _q(live, "insert into channel_posts (url, channel, content_type, is_ai,"
       " text, text_sha256, guardrail, codes, severity, first_detected_at,"
       " due_at, imported_by, scanned_at) values (%s, 'facebook', 'bai_viet',"
       " false, 'bài giả p102', %s, '{}'::jsonb, '{tu_cam}', 'S1', now(),"
       " now() + interval '24 hours', 'MXH Giả P102', now())",
       (URL_RK, "a" * 64))

    def snap():
        return _q(live, "select id, closed_at, close_reason, closed_by from"
                  " channel_posts where url = %s order by id", (URL_RK,))

    s0 = snap()
    d0 = _denied(live, "channel_post", oid)
    for who, by in (("sales", P_SALES),          # sai khối
                    ("sales", P_LEGAL),          # --by giả
                    ("legalnb", P_LNB),          # khối không thuộc login (DB)
                    ("nomap", P_NOMAP)):         # không thuộc người duyệt
        rc, out = _cli(live, who, "agents.ra_kenh", "--mark-removed", URL_RK,
                       "--by", by)
        assert rc == 1, (who, by, out)
        assert snap() == s0, (who, by)
    for by in ("agent:p102", "system:cron"):     # chặn trước khi kết nối
        rc, out = _cli(live, "legal", "agents.ra_kenh", "--mark-removed",
                       URL_RK, "--by", by)
        assert rc == 2 and snap() == s0, out
    with _approvers(live, "legal_hr", []):
        rc, out = _cli(live, "legal", "agents.ra_kenh", "--mark-removed",
                       URL_RK, "--by", P_LEGAL)
        assert rc == 1 and snap() == s0, out
    assert _denied(live, "channel_post", oid) == d0 + 5
    rc, out = _cli(live, "legal", "agents.ra_kenh", "--mark-removed", URL_RK,
                   "--by", P_LEGAL)
    assert rc == 0 and "đóng 1 dòng" in out, out
    got = snap()
    assert got[0][1] is not None and got[0][2:] == ("da_go", P_LEGAL)
    assert _log(live, "channel_post_removed", got[0][0]) == [
        (P_LEGAL, live["name"]["legal"])]
    rc, out = _cli(live, "legal", "agents.ra_kenh", "--mark-removed", URL_RK,
                   "--by", P_LEGAL)
    assert rc == 1 and "không có đợt" in out, out       # chạy lại: 0 đổi
    assert snap() == got
    assert len(_log(live, "channel_post_removed", got[0][0])) == 1
    _db_raises(live, "legal", "update channel_posts set closed_at = now()",
               (), "permission denied")
    sql = "select channel_post_mark_removed_human(%s, null, %s)"
    _db_raises(live, "legal", sql, (URL_RK, P_SALES),
               "không phải người của login")
    _db_raises(live, "sales", sql, (URL_RK, P_SALES),
               "không được ủy quyền khối")
    assert snap() == got


# ===================================================== anchor --submit --by

def test_p102_anchor_submit_authorized_human(live):
    """QUYẾT ĐỊNH khối farming (giai đoạn có người duyệt): người được ủy
    quyền gửi digest → 1 biên nhận `da_gui`; chạy lại no-op. Danh tính DB
    kiểm TRƯỚC khi gửi ra ngoài; job `agent:anchor` vẫn bị cổng rollout."""
    from pipelines import anchor
    as_of = _q(live, "select date_trunc('second', now()) - interval '1 hour'"
               )[0][0]
    d = {"t": "plot_logs_head", "id": 1, "row_hash": "c" * 64}
    leaves = [{"k": "plot_logs_head:1", "d": d, "h": anchor.leaf_hash(d)}]
    root = anchor.merkle_root([x["h"] for x in leaves])
    sha = hashlib.sha256(anchor.manifest(anchor._us(as_of), leaves,
                                         root)).hexdigest()
    bid = _q(live, "insert into anchor_batches (as_of, leaves, merkle_root,"
             " manifest_sha256, created_by) values (%s, %s, %s, %s,"
             " 'agent:anchor') returning id",
             (as_of, Jsonb(leaves), root, sha))[0][0]
    posts = live["tmp"] / "anchor_posts.log"

    def snap():
        return _q(live, "select id, status, created_by from anchor_receipts"
                  " where batch_id = %s order by id", (bid,))

    p0 = len(posts.read_text(encoding="utf-8").splitlines()) \
        if posts.exists() else 0

    def n_posts():                     # số lần "gửi" ra calendar GIẢ từ đầu ca
        return (len(posts.read_text(encoding="utf-8").splitlines())
                if posts.exists() else 0) - p0

    d0 = _denied(live, "anchor_batch", bid)
    # job (agent:anchor mặc định): giai đoạn có người duyệt → rollout chặn
    rc, out = _cli(live, "ceo", "pipelines.anchor", "--submit", bid)
    assert rc == 1 and snap() == [] and n_posts() == 0, out
    for who, by in (("sales", P_SALES),          # sai khối
                    ("sales", P_CEO),            # --by giả
                    ("nomap", P_NOMAP),          # login chưa ánh xạ (DB)
                    ("noblock", P_NOBLK)):       # khối không thuộc login (DB)
        rc, out = _cli(live, who, "pipelines.anchor", "--submit", bid, "--by",
                       by)
        assert rc == 1, (who, by, out)
        assert snap() == [] and n_posts() == 0, (who, by, out)
    with _approvers(live, "farming", []):
        rc, out = _cli(live, "ceo", "pipelines.anchor", "--submit", bid,
                       "--by", P_CEO)
        assert rc == 1 and snap() == [] and n_posts() == 0, out
    assert _denied(live, "anchor_batch", bid) == d0 + 5
    rc, out = _cli(live, "ceo", "pipelines.anchor", "--submit", bid, "--by",
                   P_CEO)
    assert rc == 0, out
    got = snap()
    assert [(r[1], r[2]) for r in got] == [("da_gui", P_CEO)]
    rec = bytes(_q(live, "select receipt from anchor_receipts where id = %s",
                   (got[0][0],))[0][0])
    assert rec.startswith(anchor.OTS_HEAD + bytes.fromhex(sha))
    assert n_posts() == 1
    assert _log(live, "anchor_submit", bid) == [(P_CEO, live["name"]["ceo"])]
    rc, out = _cli(live, "ceo", "pipelines.anchor", "--submit", bid, "--by",
                   P_CEO)
    assert rc == 0 and snap() == got and n_posts() == 1, out   # no-op
    # SQL trực tiếp
    _db_raises(live, "ceo", "insert into anchor_receipts (batch_id, provider,"
               " status, error, created_by) values (%s, 'opentimestamps',"
               " 'loi', 'x', %s)", (bid, P_CEO), "permission denied")
    sql = ("select anchor_receipt_human(%s, 'da_gui',"
           " 'https://cal.p102.invalid', %s, null, %s)")
    good = anchor.OTS_HEAD + bytes.fromhex(sha) + b"\x00"
    _db_raises(live, "ceo", sql, (bid, good, P_SALES),
               "không phải người của login")
    _db_raises(live, "sales", sql, (bid, good, P_SALES),
               "không được ủy quyền khối")
    bid2 = _q(live, "insert into anchor_batches (as_of, leaves, merkle_root,"
              " manifest_sha256, created_by) values (%s, %s, %s, %s,"
              " 'agent:anchor') returning id",
              (as_of, Jsonb(leaves), root, "e" * 64))[0][0]
    _db_raises(live, "ceo", sql, (bid2, good, P_CEO), "digest",
               exc=psycopg.errors.RaiseException)
    assert _q(live, "select count(*) from anchor_receipts where batch_id ="
              " %s", (bid2,)) == [(0,)]
    assert snap() == got


# ===================================================== kd_quote

QUOTE_TEXT = "# Báo giá giả P102\n\nHộp quà Tết 2 hộp — 1.000.000 đ\n"


def test_p102_kd_quote_verify_send_and_outcome_authorized_human(live):
    """NHẬP LIỆU (danh tính): mốc đã gửi + kết quả do NGƯỜI của chính login
    ghi qua function; INSERT thẳng `b2b_quote_events` (ghi tên người khác)
    bị từ chối. Trước sửa: login người INSERT thẳng được với tên bất kỳ."""
    qid = _enqueue(live, "b2b_quote", "BG-20261018-1-p1020001", "sales",
                   QUOTE_TEXT, "agent:kd_quote")
    _decide(live, qid)
    md = live["tmp"] / "bao-gia-p102.md"
    md.write_text(QUOTE_TEXT, encoding="utf-8", newline="\n")
    bad = live["tmp"] / "bao-gia-p102-sua.md"
    bad.write_text(QUOTE_TEXT + "giảm thêm 50%\n", encoding="utf-8",
                   newline="\n")

    def ev(kind=None):
        return _q(live, "select kind, recorded_by, db_role from"
                  " b2b_quote_events where queue_id = %s"
                  + (" and kind = %s" if kind else "") + " order by id",
                  (qid, kind) if kind else (qid,))

    d0 = _denied(live, "b2b_quote", qid)
    for who, by in (("sales", "agent:p102"), ("sales", P_CEO),
                    ("nomap", P_NOMAP)):
        rc, out = _cli(live, who, "agents.kd_quote", "--verify-send", qid, md,
                       "--by", by)
        assert rc == 1, (who, by, out)
        rc, out = _cli(live, who, "agents.kd_quote", "--outcome", qid, "chot",
                       "--by", by)
        assert rc == 1, (who, by, out)
        assert ev() == [], (who, by, out)
    assert _denied(live, "b2b_quote", qid) == d0 + 6
    rc, out = _cli(live, "sales", "agents.kd_quote", "--verify-send", qid,
                   bad, "--by", P_SALES)
    assert rc == 1 and ev() == [], out                   # file lệch
    rc, out = _cli(live, "sales", "agents.kd_quote", "--verify-send", qid, md,
                   "--by", P_SALES)
    assert rc == 0 and "KHỚP" in out and "không ghi được" not in out, out
    assert ev() == [("da_gui", P_SALES, live["name"]["sales"])]
    rc, out = _cli(live, "sales", "agents.kd_quote", "--outcome", qid, "chot",
                   "--by", P_SALES)
    assert rc == 0, out
    assert ev("chot") == [("chot", P_SALES, live["name"]["sales"])]
    assert _log(live, "b2b_quote_outcome", qid) == [
        (P_SALES, live["name"]["sales"])]
    got = ev()
    for k in ("chot", "huy"):                            # chạy lại: 0 ghi
        rc, out = _cli(live, "sales", "agents.kd_quote", "--outcome", qid, k,
                       "--by", P_SALES)
        assert rc == 1 and "đã ghi kết quả" in out, out
    assert ev() == got
    # SQL trực tiếp: không INSERT thẳng (tên người khác), function kiểm
    q2 = _enqueue(live, "b2b_quote", "BG-20261018-2-p1020002", "sales",
                  QUOTE_TEXT, "agent:kd_quote")
    _decide(live, q2)
    _db_raises(live, "sales", "insert into b2b_quote_events (queue_id,"
               " quote_no, kind, recorded_by) values (%s, 'BG-x', 'da_gui',"
               " %s)", (q2, P_CEO), "permission denied")
    sql = "select b2b_quote_event_human(%s, %s, %s, %s)"
    _db_raises(live, "sales", sql, (q2, "huy", None, P_CEO),
               "không phải người của login")
    _db_raises(live, "nomap", sql, (q2, "huy", None, P_NOMAP),
               "chưa được ánh xạ")
    _db_raises(live, "sales", sql, (q2, "da_gui", QUOTE_TEXT + "x", P_SALES),
               "LỆCH", exc=psycopg.errors.RaiseException)
    q3 = _enqueue(live, "b2b_quote", "BG-20261018-3-p1020003", "sales",
                  QUOTE_TEXT, "agent:kd_quote")       # chưa duyệt
    _db_raises(live, "sales", sql, (q3, "chot", None, P_SALES), "ĐÃ duyệt",
               exc=psycopg.errors.RaiseException)
    assert _q(live, "select count(*) from b2b_quote_events where queue_id ="
              " any(%s)", ([q2, q3],)) == [(0,)]


# ===================================================== loader / agent / khóa

def test_p102_loader_agent_cannot_call_human_functions(live):
    """Loader / agent: không gọi được function người, không ghi thẳng bảng
    nghiệp vụ của các đường P10.2 (không tự duyệt / ghi thay người)."""
    calls = (
        ("select milestone_set_status_human('M-X', 'xong', 'e', %s)",),
        ("select milestone_apply_due_human(1, %s)",),
        ("select org_handover_human(1, 'x', %s)",),
        ("select * from org_batch_rows_human(1, %s)",),
        ("select channel_post_mark_removed_human('u', null, %s)",),
        ("select anchor_receipt_human(1, 'loi', null, null, 'e', %s)",),
        ("select b2b_quote_event_human(1, 'chot', null, %s)",),
    )
    for who in ("loader", "agent"):
        for (sql,) in calls:
            _db_raises(live, who, sql, (P_CEO,), "permission denied")
        for sql in ("update project_milestones set status = 'xong'",
                    "update org_prospects set status = 'chuyen_sales'",
                    "update channel_posts set close_reason = 'da_go'",
                    ("insert into anchor_receipts (batch_id, provider,"
                     " status, error, created_by) values (1,"
                     " 'opentimestamps', 'loi', 'x', 'y')"),
                    ("insert into b2b_quote_events (queue_id, quote_no,"
                     " kind) values (1, 'x', 'da_gui')")):
            _db_raises(live, who, sql, (), "permission denied")


def test_p102_functions_locked_down(live):
    """7 function mới: SECURITY DEFINER, search_path cố định, KHÔNG EXECUTE
    cho PUBLIC/svc_loader/bks_reader/agent_writer; app_human có."""
    rows = _q(live, "select p.oid::regprocedure::text, p.prosecdef,"
              " p.proconfig, has_function_privilege('public', p.oid,"
              " 'EXECUTE'), has_function_privilege('svc_loader', p.oid,"
              " 'EXECUTE'), has_function_privilege('bks_reader', p.oid,"
              " 'EXECUTE'), has_function_privilege('agent_writer', p.oid,"
              " 'EXECUTE'), has_function_privilege('app_human', p.oid,"
              " 'EXECUTE') from pg_proc p where p.pronamespace ="
              " current_schema()::regnamespace and p.proname = any(%s)",
              ([s.split("(")[0] for s in FN_SIGS],))
    assert sorted(r[0].replace(" ", "") for r in rows) == sorted(
        s.replace(" ", "") for s in FN_SIGS), rows
    for sig, secdef, cfg, pub, loader, bks, agent, human in rows:
        assert secdef and cfg and any(c.startswith("search_path=")
                                      for c in cfg), sig
        assert not (pub or loader or bks or agent), sig
        assert human, sig


def test_p102_owner_dev_path_unchanged(live):
    """Login owner (máy dev) vẫn chạy function như cũ: nhận `--by` tự khai
    (human_actor), không thêm quyền gì."""
    _q(live, "insert into project_milestones (code, title, owner_role,"
       " due_date, gate, source, updated_by) values ('M-P102O', 'Mốc owner',"
       " 'tgd', '2026-12-01', 'gate', 'test-p102', 'seed')")
    assert _q(live, "select milestone_set_status_human('M-P102O',"
              " 'dang_lam', null, 'Người Dev')") == [("ok",)]
    assert _q(live, "select status, updated_by from project_milestones where"
              " code = 'M-P102O'") == [("dang_lam", "Người Dev")]
