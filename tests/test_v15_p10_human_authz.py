"""v15.4 (p10, F08) — quyền người: CLI người chạy bằng login NGƯỜI thật.

Hở tái hiện (đọc code thật trên `a05c60f`, mỗi nhóm FAIL trên code cũ):
  P10.1  7 CLI người (golden --approve-price, xnqc, rollout --promote/--severe/
         --disable, crm, doc_intake --verify/--reject, garden_director
         --purge-sample/--adopt-plot, ra_kenh --partner-file) ghi bảng TRỰC
         TIẾP → dưới login `in role app_human` báo `permission denied for
         table ...` (E2E gate v14: `dealers`); DB không đối chiếu `--by` với
         login (ai có quyền ghi bảng là ghi được tên người khác).
  P10.2  `--by` chưa xếp loại (da_pmo --set-status/--apply-due, da_b2b
         --handover, ra_kenh --mark-removed, anchor --submit, kd_quote
         --outcome/--verify-send) nhận tên TỰ KHAI ở chế độ thực — không cổng,
         không `authz_denied`.
  P10.3  báo cáo BKS chạy bằng login `bks_reader`: không đọc được giai đoạn
         tính năng (tắt vẫn sinh) + không ghi được sổ đầu ra (không được đếm).
  P10.4  kiểm lại bằng login thật: loader không tự duyệt, người tạo không tự
         duyệt, log từ chối không commit việc dở của caller.

Tầng: login Postgres THẬT tạm (không superuser, không owner) trong schema tạm
ĐÃ COMMIT; E2E bằng SUBPROCESS (`python <launcher> <module> ...` — launcher chỉ
trỏ thư mục cấu hình khối giả, không đổi logic). Người/khối/login là dữ liệu
GIẢ của test (không phải người thật). Dọn schema + login cuối module. Skip khi
không có DATABASE_URL."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import InsufficientPrivilege

from pipelines import auth
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")

# người GIẢ của test (không phải người thật)
P_SALES = "Bán Hàng Giả Lập"
P_LEGAL = "Pháp Chế Giả Lập"
P_FARM = "Vùng Trồng Giả Lập"     # khối farming + ceo
SKU = "p10-sku-gia"
DOC_SHA = "d" * 64
URL_P10 = "https://www.tiktok.com/@p10.gia/video/7300000000000000010"

LAUNCHER = '''import runpy, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from pipelines import auth
auth.DIRECTORS_DIR = Path(sys.argv[2])
mod = sys.argv[3]
sys.argv = [mod] + sys.argv[4:]
runpy.run_module(mod, run_name="__main__", alter_sys=True)
'''


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
    schema = f"t_v15p10_{tag}"
    kinds = {"sales": "app_human", "legal": "app_human", "farm": "app_human",
             "unmapped": "app_human", "loader": "svc_loader",
             "bks": "bks_reader"}
    logins = {k: (f"t_p10_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    tmp = tmp_path_factory.mktemp("p10cfg")
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
            # bảng ánh xạ có từ v15.4 — thiếu (code cũ) thì test FAIL ở
            # hành vi (quyền/cổng), không ở fixture
            has_map = admin.execute(
                "select to_regclass('human_logins') is not null").fetchone()[0]
            for k, person, blocks in (("sales", P_SALES, ["sales"]),
                                      ("legal", P_LEGAL, ["legal_hr"]),
                                      ("farm", P_FARM, ["farming", "ceo"])):
                if not has_map:
                    break
                admin.execute("insert into human_logins (db_login, person,"
                              " blocks, granted_by) values (%s, %s, %s,"
                              " 'test-p10')", (name[k], person, blocks))
            admin.execute(
                "insert into sku_master (sku_key, name, category, source)"
                " values (%s, 'SKU giả p10', 'food', 'manual')", (SKU,))
        d = tmp / "directors"
        shutil.copytree(ROOT / "data" / "directors", d)
        for blk, who in (("sales", P_SALES), ("legal_hr", P_LEGAL),
                         ("farming", P_FARM), ("ceo", P_FARM)):
            p = d / f"{blk}.json"
            c = json.loads(p.read_text(encoding="utf-8"))
            c["approvers"] = [who]
            p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        users = tmp / "users.json"
        users.write_text(json.dumps({
            P_SALES.casefold(): {"role": "gd_ban_hang",
                                 "db_login": name["sales"]},
            P_LEGAL.casefold(): {"role": "phap_che",
                                 "db_login": name["legal"]},
            P_FARM.casefold(): {"role": "tgd", "db_login": name["farm"]},
        }, ensure_ascii=False), encoding="utf-8")
        launcher = tmp / "launch_p10.py"
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


def _denied(live, otype, oid=None):
    if oid is None:
        return _q(live, "select count(*) from agent_action_log where action"
                  " = 'authz_denied' and object_type = %s", (otype,))[0][0]
    return _q(live, "select count(*) from agent_action_log where action ="
              " 'authz_denied' and object_type = %s and object_id = %s",
              (otype, str(oid)))[0][0]


def _cli(live, who, module, *args, stdin=None, env=None):
    """Chạy CLI bằng SUBPROCESS dưới login `who` (chế độ thực)."""
    e = {k: v for k, v in os.environ.items()
         if not k.endswith("DATABASE_URL") and k not in (
             "AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE", "APPROVAL_ENFORCE")}
    e.update(DATABASE_URL=live["dsn"][who], APPROVAL_ENFORCE="1",
             AUTH_USERS_FILE=str(live["users"]), PYTHONIOENCODING="utf-8",
             **(env or {}))
    p = subprocess.run(
        [sys.executable, str(live["launcher"]), str(ROOT), str(live["dirs"]),
         module, *map(str, args)], cwd=ROOT, env=e, input=stdin,
        capture_output=True, timeout=180, encoding="utf-8",
        errors="replace", check=False)
    return p.returncode, p.stdout + p.stderr


def _conn(live, who):
    return psycopg.connect(live["dsn"][who], connect_timeout=5)


def _db_raises(live, who, sql, args, frag):
    """Gọi thẳng SQL bằng login `who` → InsufficientPrivilege chứa `frag`."""
    with _conn(live, who) as c, pytest.raises(InsufficientPrivilege) as ei:
        c.execute(sql, args)
    assert frag in str(ei.value), str(ei.value)


# ============================================== P10.1 — E2E subprocess login

def test_p10_1_golden_approve_price_human_login(live):
    pid = _q(live, "insert into price_list (sku_key, channel, kind,"
             " price_vnd, valid_from) values (%s, 'shopee', 'list', 150000,"
             " '2026-10-01') returning id", (SKU,))[0][0]
    # sai khối: Pháp chế (legal_hr) duyệt giá → cổng chặn + authz_denied
    before = _denied(live, "price_list", pid)
    rc, out = _cli(live, "legal", "ingest.golden_store", "--approve-price",
                   pid, "--by", P_LEGAL)
    assert rc == 1 and "ủy quyền" in out, out
    # --by giả: người khối sales nhưng chạy bằng login của Pháp chế
    rc, out = _cli(live, "legal", "ingest.golden_store", "--approve-price",
                   pid, "--by", P_SALES)
    assert rc == 1 and "login Postgres" in out, out
    assert _denied(live, "price_list", pid) == before + 2
    # đúng người + đúng khối + login của chính họ → ghi qua function
    rc, out = _cli(live, "sales", "ingest.golden_store", "--approve-price",
                   pid, "--by", P_SALES)
    assert rc == 0, out
    assert _q(live, "select approved_by from price_list where id = %s",
              (pid,)) == [(P_SALES,)]
    assert _q(live, "select actor, db_role from agent_action_log where"
              " action = 'price_approve' and object_id = %s",
              (str(pid),)) == [(P_SALES, live["name"]["sales"])]
    # login người KHÔNG có UPDATE thẳng bảng giá
    _db_raises(live, "sales", "update price_list set approved_by = %s",
               ("x",), "permission denied")


def test_p10_1_xnqc_add_and_set_human_login(live):
    rc, out = _cli(live, "legal", "agents.xnqc", "--add", "--sku", SKU,
                   "--loai", "maket", "--ten", "maket p10", "--by", P_LEGAL)
    assert rc == 0, out
    did = _q(live, "select id, updated_by from xnqc_dossiers where"
             " ten_ho_so = 'maket p10'")
    assert did and did[0][1] == P_LEGAL
    did = did[0][0]
    today = datetime.now(VN_TZ).date().isoformat()
    # sai khối: người sales đổi trạng thái hồ sơ XNQC
    before = _denied(live, "xnqc_dossier", did)
    rc, out = _cli(live, "sales", "agents.xnqc", "--set", did, "--status",
                   "da_nop", "--ngay-nop", today, "--by", P_SALES)
    assert rc == 1 and _denied(live, "xnqc_dossier", did) == before + 1, out
    rc, out = _cli(live, "legal", "agents.xnqc", "--set", did, "--status",
                   "da_nop", "--ngay-nop", today, "--by", P_LEGAL)
    assert rc == 0, out
    assert _q(live, "select status, updated_by from xnqc_dossiers where id ="
              " %s", (did,)) == [("da_nop", P_LEGAL)]


def test_p10_1_rollout_disable_reenable_human_login(live):
    _q(live, "insert into feature_rollout (feature_id, stage, updated_by)"
       " values ('sales-01', 'chay_thu', 'seed-test') on conflict do nothing")
    before = _denied(live, "feature_rollout", "sales-01")
    rc, out = _cli(live, "legal", "pipelines.rollout", "--disable",
                   "sales-01", "--by", P_LEGAL)
    assert rc == 1 and _denied(live, "feature_rollout",
                               "sales-01") == before + 1, out
    rc, out = _cli(live, "sales", "pipelines.rollout", "--disable",
                   "sales-01", "--by", P_SALES, "--note", "tạm dừng p10")
    assert rc == 0, out
    rc, out = _cli(live, "sales", "pipelines.rollout", "--promote",
                   "sales-01", "--by", P_SALES)
    assert rc == 0, out
    assert _q(live, "select stage, updated_by from feature_rollout where"
              " feature_id = 'sales-01'") == [("chay_thu", P_SALES)]
    assert _q(live, "select kind, by_person from feature_rollout_events"
              " where feature_id = 'sales-01' order by id") == [
        ("disable", P_SALES), ("promote", P_SALES)]
    # gọi thẳng function bỏ qua cổng PL02 (vừa về chạy thử): DB tự chặn
    with _conn(live, "sales") as c, pytest.raises(psycopg.Error) as ei:
        c.execute("select rollout_transition_human('sales-01', 'promote',"
                  " 'chay_thu', 'co_nguoi_duyet', %s, null, null, %s, now())",
                  (P_SALES, json.dumps({"outputs": 999, "out_days": 9})))
    assert "chưa đủ số ngày" in str(ei.value)
    _db_raises(live, "sales", "update feature_rollout set stage = 'van_hanh'",
               (), "permission denied")


def test_p10_1_crm_all_ops_human_login(live):
    rc, out = _cli(live, "legal", "ingest.crm", "--load-dealers", "--by",
                   P_LEGAL)
    assert rc == 1 and "ủy quyền" in out, out
    rc, out = _cli(live, "sales", "ingest.crm", "--load-dealers", "--by",
                   P_SALES)
    assert rc == 0 and "mới=" in out, out
    lid = _q(live, "insert into leads (dedup_key, ts, channel, user_hash,"
             " question, intent, source) values ('p10:lead', now(), 'zalo',"
             " 'h', 'đặt 2 hộp giao Đà Nẵng', 'order', 'manual') returning"
             " id")[0][0]
    rc, out = _cli(live, "sales", "ingest.crm", "--assign", lid, "--dealer",
                   "DLM01", "--by", P_SALES)
    assert rc == 0, out
    from cryptography.fernet import Fernet
    venv = {"CONTACT_VAULT_KEY": Fernet.generate_key().decode()}
    rc, out = _cli(live, "sales", "ingest.crm", "--add-contact", "-",
                   "--lead", lid, "--by", P_SALES, env=venv,
                   stdin=json.dumps({"phone": "0905000111",
                                     "name": "Khách Giả P10"}))
    assert rc == 0, out
    cid = _q(live, "select contact_id from leads where id = %s", (lid,))[0][0]
    rc, out = _cli(live, "sales", "ingest.crm", "--consent", cid,
                   "--purpose", "dai_ly", "--dealer", "DLM01", "--grant",
                   "--source", "form_giay", "--evidence", "BB-P10",
                   "--policy-version", "v1", "--by", P_SALES)
    assert rc == 0, out
    rc, out = _cli(live, "sales", "ingest.crm", "--handoff", lid, "--dealer",
                   "DLM01", "--by", P_SALES, env=venv)
    assert rc == 0 and "0905000111" in out, out
    rc, out = _cli(live, "sales", "ingest.crm", "--status", lid, "contacted",
                   "--by", P_SALES)
    assert rc == 0, out
    rc, out = _cli(live, "sales", "ingest.crm", "--owner", lid, "--staff",
                   "NV01", "--by", P_SALES)
    assert rc == 0, out
    rc, out = _cli(live, "sales", "ingest.crm", "--report")
    assert rc == 0 and "Liên hệ trong vault: 1" in out, out
    assert _q(live, "select assigned_by, owner_assigned_by, status from leads"
              " where id = %s", (lid,)) == [(P_SALES, P_SALES, "contacted")]
    assert _q(live, "select created_by from contacts where id = %s",
              (cid,)) == [(P_SALES,)]
    acts = {a for (a,) in _q(live, "select action from agent_action_log"
                                   " where db_role = %s",
                             (live["name"]["sales"],))}
    assert {"crm_dealer_load", "crm_assign", "crm_contact_add", "crm_consent",
            "crm_handoff", "crm_status", "crm_owner"} <= acts
    # nhập liệu bằng login người khác với --by của người khác → DB chặn
    before = _denied(live, "crm", lid)
    rc, out = _cli(live, "legal", "ingest.crm", "--status", lid, "qualified",
                   "--by", P_SALES)
    assert rc == 1 and "không phải người của login" in out, out
    assert _denied(live, "crm", lid) == before + 1
    # login người KHÔNG đọc/ghi thẳng PII, không ghi thẳng sổ đại lý
    _db_raises(live, "sales", "select * from contacts", (),
               "permission denied")
    _db_raises(live, "sales", "insert into dealers (code, name, region,"
               " source) values ('X1', 'x', 'r', 'manual')", (),
               "permission denied")


def test_p10_1_doc_verify_human_login(live):
    _q(live, "insert into documents (sha256, filename, doc_type,"
       " text_source, status) values (%s, 'scan_p10.pdf', 'giay_tiep_nhan',"
       " 'pdf_text', 'pending_review')", (DOC_SHA,))
    _q(live, "insert into document_fields (sha256, field, value) values"
       " (%s, 'so_giay', '1/2026/P10')", (DOC_SHA,))
    rc, out = _cli(live, "sales", "ingest.doc_intake", "--verify", DOC_SHA,
                   "--by", P_SALES)
    assert rc == 1 and "ủy quyền" in out, out
    rc, out = _cli(live, "legal", "ingest.doc_intake", "--verify", DOC_SHA,
                   "--by", P_LEGAL)
    assert rc == 0, out
    assert _q(live, "select status, verified_by from documents where sha256"
              " = %s", (DOC_SHA,)) == [("verified", P_LEGAL)]
    assert _q(live, "select verified from document_fields where sha256 = %s",
              (DOC_SHA,)) == [(True,)]


def test_p10_1_garden_adopt_and_purge_human_login(live):
    _q(live, "insert into plots (id, source) values ('K-P10A', 'sample:p10'),"
       " ('K-P10B', 'sample:p10')")
    rc, out = _cli(live, "sales", "agents.garden_director", "--adopt-plot",
                   "K-P10A", "--by", P_SALES)
    assert rc == 1, out
    rc, out = _cli(live, "farm", "agents.garden_director", "--adopt-plot",
                   "K-P10A", "--by", P_FARM)
    assert rc == 0, out
    assert _q(live, "select source from plots where id = 'K-P10A'") == [
        ("manual:adopted",)]
    rc, out = _cli(live, "farm", "agents.garden_director", "--purge-sample",
                   "--by", P_FARM)
    assert rc == 0, out
    assert _q(live, "select id from plots where source like 'sample:%'") == []
    assert _q(live, "select actor from agent_action_log where action ="
              " 'garden_sample_purge'") == [(P_FARM,)]


def test_p10_1_ra_kenh_partner_file_human_login(live):
    f = live["tmp"] / "doi_tac_p10.csv"
    f.write_bytes(("ma_doi_tac,url,kenh,text,ngay_dang,sku\n"
                   f"KOC-MAU-01,{URL_P10},tiktok,\"Hộp quà Tết biếu gia đình"
                   " #quangcao\",2026-10-13,\n").encode())
    rc, out = _cli(live, "legal", "agents.ra_kenh", "--partner-file", f,
                   "--by", P_SALES)
    assert rc != 0 and "không phải người của login" in out, out
    rc, out = _cli(live, "sales", "agents.ra_kenh", "--partner-file", f,
                   "--by", P_SALES)
    assert rc == 0, out
    assert _q(live, "select scanned_by from partner_post_scans") == [
        (P_SALES,)]
    _db_raises(live, "sales", "insert into partner_post_scans (partner_code,"
               " url_sha256, host, channel, posted_on, text_sha256,"
               " scanned_by) values ('KOC-MAU-01', %s, 'h', 'tiktok',"
               " '2026-10-13', %s, 'x')", ("a" * 64, "b" * 64),
               "permission denied")


def test_p10_1_ra_kenh_forged_by_violation_writes_nothing(live):
    """Review v15 (MINOR): bài VI PHẠM (tạo mục hàng duyệt) + `--by` giả →
    danh tính bị DB chặn TRƯỚC mọi ghi: 0 dòng sổ, 0 mục `approval_queue`
    mới (trước vá: `director.submit` đã commit mục rồi mới kiểm danh tính)."""
    url = "https://www.tiktok.com/@p10.gia/video/7300000000000000011"
    f = live["tmp"] / "doi_tac_p10_vi_pham.csv"
    f.write_bytes(("ma_doi_tac,url,kenh,text,ngay_dang,sku\n"
                   f"KOC-MAU-01,{url},tiktok,\"Sâm chữa khỏi bệnh ung thư"
                   " #quangcao\",2026-10-13,\n").encode())

    def counts():
        return (_q(live, "select count(*) from approval_queue where"
                   " object_type = 'partner_post_review'")[0][0],
                _q(live, "select count(*) from partner_post_scans")[0][0])

    q0, s0 = counts()
    d0 = _denied(live, "partner_post_scan")
    rc, out = _cli(live, "legal", "agents.ra_kenh", "--partner-file", f,
                   "--by", P_SALES)
    assert rc != 0 and "không phải người của login" in out, out
    assert counts() == (q0, s0), out
    assert _denied(live, "partner_post_scan") == d0 + 1
    # đúng người của login: vẫn chạy bình thường (1 mục + 1 dòng sổ)
    rc, out = _cli(live, "sales", "agents.ra_kenh", "--partner-file", f,
                   "--by", P_SALES)
    assert rc == 0, out
    assert counts() == (q0 + 1, s0 + 1), out


# ---------- P10.1 — danh tính ở DB: không tin --by (gọi thẳng function)

FN_CASES = [
    ("approve_price_human", "select approve_price_human(1, %s)"),
    ("xnqc_set_status_human", ("select xnqc_set_status_human(1, 'chuan_bi',"
                               " 'da_nop', %s, null, current_date, null,"
                               " null, null)")),
    ("rollout_transition_human", ("select rollout_transition_human("
                                  "'sales-01', 'disable', 'chay_thu', 'tat',"
                                  " %s, null, null, '{}', now())")),
    ("crm_load_dealers_human", "select crm_load_dealers_human('[]', %s)"),
    ("doc_review_human", (f"select doc_review_human('{DOC_SHA}',"
                          " 'rejected', %s)")),
    ("garden_adopt_plot_human", "select garden_adopt_plot_human('K-X', %s)"),
]


@pytest.mark.parametrize("fn, sql", FN_CASES, ids=[c[0] for c in FN_CASES])
def test_p10_1_db_identity_from_login_not_by(live, fn, sql):
    """Gọi thẳng function bằng psql: agent:/system:, `--by` khác người của
    login, khối ngoài phạm vi, login chưa ánh xạ → 42501."""
    for by in ("agent:p10", "system:cron", " "):
        _db_raises(live, "legal", sql, (by,), "không hợp lệ")
    _db_raises(live, "legal", sql, (P_SALES,), "không phải người của login")
    _db_raises(live, "unmapped", sql, (P_SALES,), "chưa được ánh xạ")
    if fn != "xnqc_set_status_human" and fn != "doc_review_human":
        _db_raises(live, "legal", sql, (P_LEGAL,), "không được ủy quyền khối")


def test_p10_1_functions_locked_down(live):
    """Function ghi: SECURITY DEFINER, search_path cố định, KHÔNG execute
    cho PUBLIC; chỉ app_human (+ owner). bks_reader/svc_* không gọi được."""
    rows = _q(live, "select p.proname, p.prosecdef, p.proconfig,"
              " has_function_privilege('public', p.oid, 'EXECUTE'),"
              " has_function_privilege('svc_loader', p.oid, 'EXECUTE'),"
              " has_function_privilege('bks_reader', p.oid, 'EXECUTE'),"
              " has_function_privilege('agent_writer', p.oid, 'EXECUTE')"
              " from pg_proc p where p.pronamespace = current_schema()"
              "::regnamespace and (p.proname like '%%\\_human' or p.proname in"
              " ('human_actor', 'p10_owner_login', 'p10_now', 'crm_counts'))")
    assert len(rows) >= 19, rows
    for name, secdef, cfg, pub, loader, bks, agent in rows:
        assert secdef and cfg and any(c.startswith("search_path=")
                                      for c in cfg), name
        assert not (pub or loader or bks or agent), name
    _q(live, "select 1")  # admin vẫn dùng được
    _db_raises(live, "sales", "select * from human_logins", (),
               "permission denied")


# ============================================== P10.2 — xếp loại + cổng CLI

@pytest.fixture
def human(live, monkeypatch):
    """CLI trong tiến trình bằng login người, chế độ thực, cấu hình giả."""
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    monkeypatch.setattr(auth, "DIRECTORS_DIR", live["dirs"])
    monkeypatch.setattr(auth, "ENV_FILE", live["tmp"] / "no.env")
    monkeypatch.setenv("AUTH_USERS_FILE", str(live["users"]))
    monkeypatch.setenv("PYTHONIOENCODING", "utf-8")

    def use(who):
        monkeypatch.setenv("DATABASE_URL", live["dsn"][who])
    return use


def _rc(fn, argv):
    try:
        return fn(argv)
    except SystemExit as e:           # argparse chặn trước khi connect
        return e.code


def _decision(i, monkeypatch):
    """(nhãn, main, khối, argv(by), object_type, object_id, số authz_denied
    kỳ vọng cho 5 lần chặn, agent/system có bị CHẶN ở cổng không)."""
    from agents import da_pmo, ra_kenh
    from pipelines import anchor
    monkeypatch.setattr(anchor, "load_config", lambda *a, **k: {
        "provider": "opentimestamps", "calendars": ["https://x.invalid"],
        "timeout_s": 1})               # lần gom #1 không có → không gửi gì
    url_oid = __import__("hashlib").sha256(URL_P10.encode()).hexdigest()[:12]
    return [
        ("da_pmo --set-status", da_pmo.main, "ceo",
         lambda by: ["--set-status", "M-P10", "--status", "xong",
                     "--evidence", "BB-1", "--by", by],
         "project_milestone", "M-P10", 5),
        # agent:/system: bị argparse chặn (by_error) TRƯỚC khi kết nối
        ("ra_kenh --mark-removed", ra_kenh.main, "legal_hr",
         lambda by: ["--mark-removed", URL_P10, "--by", by],
         "channel_post", url_oid, 3),
        # agent:/system: = đường job (không phải duyệt người — rollout đòi
        # vận hành), không qua cổng người
        ("anchor --submit", anchor.main, "farming",
         lambda by: ["--submit", "1", "--by", by], "anchor_batch", "1", 3),
    ][i]


@pytest.mark.parametrize("i", range(3), ids=["da_pmo-set-status",
                                             "ra_kenh-mark-removed",
                                             "anchor-submit"])
def test_p10_2_decisions_gated(live, human, monkeypatch, capsys, i):
    """Quyết định → auth.cli_gate: agent:/system: / sai khối / --by giả
    (login người khác) / thiếu ủy quyền bị chặn + authz_denied; đúng người,
    đúng khối, login của chính họ qua cổng (code cũ: không cổng)."""
    label, fn, block, argv, otype, oid, expect = _decision(i, monkeypatch)
    owner = {"ceo": "farm", "legal_hr": "legal", "farming": "farm"}[block]
    person = {"ceo": P_FARM, "legal_hr": P_LEGAL, "farming": P_FARM}[block]
    before = _denied(live, otype, oid)
    human(owner)
    for by in ("agent:p10", "system:cron"):
        assert _rc(fn, argv(by)) != 0, (label, by)
    human("sales")
    assert _rc(fn, argv(P_SALES)) == 1, label                  # sai khối
    assert _rc(fn, argv(person)) == 1, label                   # --by giả
    human(owner)
    p = live["dirs"] / f"{block}.json"
    keep = p.read_text(encoding="utf-8")
    c = json.loads(keep)
    c["approvers"] = []                                        # chưa ủy quyền
    p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
    try:
        assert _rc(fn, argv(person)) == 1, label
    finally:
        p.write_text(keep, encoding="utf-8")
    assert _denied(live, otype, oid) == before + expect, label
    capsys.readouterr()
    _rc(fn, argv(person))      # qua cổng — lỗi sau đó là nghiệp vụ/quyền ghi
    out = capsys.readouterr()
    text = out.out + out.err
    assert "ủy quyền" not in text and "login Postgres" not in text, text
    assert _denied(live, otype, oid) == before + expect, label


def _entry(i):
    from agents import da_b2b, da_pmo, kd_quote
    f = ROOT / "AGENTS.md"
    return [
        ("da_pmo --apply-due", da_pmo.main,
         lambda by: ["--apply-due", "990001", "--by", by]),
        ("da_b2b --handover", da_b2b.main,
         lambda by: ["--handover", "990001", "--by", by]),
        ("kd_quote --outcome", kd_quote.main,
         lambda by: ["--outcome", "990001", "chot", "--by", by]),
        ("kd_quote --verify-send --by", kd_quote.main,
         lambda by: ["--verify-send", "990001", str(f), "--by", by]),
    ][i]


@pytest.mark.parametrize("i", range(4), ids=["apply-due", "handover",
                                             "outcome", "verify-send"])
def test_p10_2_data_entry_identity(live, human, capsys, i):
    """Nhập liệu / thực thi mục ĐÃ duyệt → auth.cli_identity: agent:/system:
    / --by tên người khác (không khớp login) bị chặn + authz_denied; người
    của chính login qua cổng (lỗi sau đó là nghiệp vụ: mục không tồn tại)."""
    label, fn, argv = _entry(i)
    otype = "b2b_quote" if "kd_quote" in label else "approval_queue"
    human("sales")
    before = _denied(live, otype, "990001")
    for by in ("agent:p10", "system:cron"):
        assert _rc(fn, argv(by)) != 0, (label, by)
    assert _rc(fn, argv(P_LEGAL)) == 1, label             # tên người khác
    assert _denied(live, otype, "990001") == before + 3, label
    capsys.readouterr()
    _rc(fn, argv(P_SALES))
    out = capsys.readouterr()
    assert "từ chối" not in out.out + out.err, (label, out)
    assert _denied(live, otype, "990001") == before + 3, label


def test_p10_2_kd_care_verify_send_has_no_by():
    """kd_care --verify-send: chỉ kiểm (đọc), không ghi, không nhận --by."""
    from agents import kd_care
    assert _rc(kd_care.main, ["--verify-send", "1", "x.txt", "--by",
                              "Lan"]) == 2


def test_p10_2_classification_documented():
    body = (ROOT / "docs" / "handover" / "runbook-ha-tang.md").read_text(
        encoding="utf-8")
    for cmd in ("da_pmo --set-status", "da_pmo --apply-due",
                "da_b2b --handover", "kd_care --verify-send",
                "ra_kenh --mark-removed", "anchor --submit",
                "kd_quote --outcome", "kd_quote --verify-send"):
        assert cmd in body, cmd


# ============================================== P10.3 — bks_reader

def test_p10_3_bks_reader_report_outputs_exact(live, monkeypatch, tmp_path):
    """Login bks_reader: đọc được giai đoạn tính năng + ghi 1 dòng sổ đầu ra
    báo cáo BKS — KHÔNG đọc/sửa/xóa sổ, không đọc sự kiện triển khai, không
    đổi giai đoạn (code cũ: tắt vẫn sinh, báo cáo không được đếm)."""
    from agents import bks_audit
    from agents.report import write_report
    from pipelines import rollout
    for sql in ("select * from report_outputs",
                "update report_outputs set is_sample = true",
                "delete from report_outputs",
                "select * from feature_rollout_events",
                "update feature_rollout set stage = 'tat'"):
        _db_raises(live, "bks", sql, (), "permission denied")
    name = "bks-audit-2026-09.md"
    monkeypatch.setattr(rollout, "_FORCE_MODE", None)
    monkeypatch.setenv("DATABASE_URL", live["dsn"]["bks"])
    fid = rollout.feature_for_report(name)
    assert fid
    _q(live, "insert into feature_rollout (feature_id, stage, updated_by)"
       " values (%s, 'tat', 'seed-test') on conflict (feature_id) do update"
       " set stage = 'tat'", (fid,))
    with pytest.raises(rollout.RolloutBlocked):
        write_report("# BKS p10\n", tmp_path, name)
    _q(live, "update feature_rollout set stage = 'chay_thu' where"
       " feature_id = %s", (fid,))
    assert write_report("# BKS p10\n", tmp_path, name).exists()
    assert _q(live, "select feature_id, db_role from report_outputs where"
              " name = %s", (name,)) == [(fid, live["name"]["bks"])]
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        found = [f for f in bks_audit.check_privileges(a)
                 if f.get("role") == "bks_reader"]
    assert found == [], found


# ============================================== P10.4 — kiểm lại login thật

def test_p10_4_loader_cannot_approve(live):
    pid = _q(live, "insert into price_list (sku_key, channel, kind,"
             " price_vnd, valid_from) values (%s, 'tiktok', 'list', 99000,"
             " '2026-10-01') returning id", (SKU,))[0][0]
    for sql, args in (
            ("select approve_price_human(%s, %s)", (pid, P_SALES)),
            ("update price_list set approved_by = %s where id = %s",
             (P_SALES, pid)),
            ("update sku_map set approved_by = %s", (P_SALES,)),
            ("update golden_discrepancies set status = 'resolved'", ()),
            ("select * from human_logins", ())):
        _db_raises(live, "loader", sql, args or None, "permission denied")
    assert _q(live, "select approved_by from price_list where id = %s",
              (pid,)) == [(None,)]


def test_p10_4_creator_cannot_self_approve(live):
    """Người tạo mục / lập giá vốn bằng login của mình không tự duyệt được
    (DB chặn — gọi thẳng function cũng vậy)."""
    with _conn(live, "sales") as c:
        qid = c.execute(
            "select enqueue_item('b2b_quote', 'p10:q1', 'sales', 'Báo giá"
            " p10', 'nội dung', 'low', '{\"ok\": true}'::jsonb, null, %s,"
            " 24)", (P_SALES,)).fetchone()[0]
        c.commit()
        with pytest.raises(psycopg.Error) as ei:
            c.execute("select decide_item(%s, %s, 'approved')",
                      (qid, P_SALES))
        assert "trùng người tạo" in str(ei.value)
        c.rollback()
        cid = c.execute("insert into cogs_versions (sku_key, cost_vnd,"
                        " valid_from, created_by) values (%s, 50000,"
                        " '2026-10-01', %s) returning id",
                        (SKU, P_SALES)).fetchone()[0]
        c.commit()
        with pytest.raises(psycopg.Error) as ei:
            c.execute("select approve_cogs(%s, %s)", (cid, P_SALES))
        assert "trùng người lập" in str(ei.value)
        c.rollback()
    assert _q(live, "select status from approval_queue where id = %s",
              (qid,)) == [("pending",)]


def test_p10_4_deny_does_not_commit_caller_work(live, monkeypatch):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    with _conn(live, "legal") as c:
        c.execute("insert into content_drafts (brief, channel, text,"
                  " guardrail, source, created_by) values ('p10-dang-do',"
                  " 'facebook', 'x', '{}'::jsonb, 'cli', 'Lan')")
        with pytest.raises(auth.HumanDenied):
            auth.call_human(c, "select approve_price_human(1, %s)",
                            (P_SALES,), by=P_SALES, block="sales",
                            action="approve_price", object_type="p10_probe",
                            object_id="dang-do")
        c.rollback()
    assert _q(live, "select count(*) from content_drafts where brief ="
              " 'p10-dang-do'") == [(0,)]
    assert _denied(live, "p10_probe", "dang-do") == 1
    assert _q(live, "select count(*) from verify_action_log()") == [(0,)]
