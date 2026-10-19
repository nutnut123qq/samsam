"""v15 fix P8.7c — bằng chứng nguồn FILE tin cậy trong DB (backup).

Lỗi (sau vá P8.7/P8.7b): đầu ra nguồn file `backup_runs.jsonl` của
data_platform-07.2 (nhật ký trên máy ứng dụng, DB không đọc được) KHÔNG có
bằng chứng trong DB → người được ủy quyền không liệt kê/duyệt được backup
hợp lệ (`output_review_human` từ chối mọi khóa `bk:`), và cổng PL02 DB bỏ qua
ngưỡng số lượng của tính năng có nguồn file (tin bằng chứng Python). Vá: sổ
APPEND-ONLY `file_output_evidence` trong DB, ghi CHỈ qua function SECURITY
DEFINER `file_output_evidence_backup` do CHÍNH tiến trình backup (login
`svc_backup` — đường dịch vụ; hoặc owner dev) gọi ngay khi backup thành công
(DB tự tính khóa `bk:<sha bản dump>` + sha phiên bản = sha256 bản ghi); người
(app_human)/agent/loader/BKS không tạo được bằng chứng — kể cả login người lỡ
được cấp vào svc_backup. Bộ đếm `count_spec` của 07.2 đọc sổ này (không đọc
file, không tin key/sha caller) → liệt kê/duyệt/cổng PL02 cùng một bộ đếm.

Probe (login Postgres THẬT tạm, không superuser/owner; CLI SUBPROCESS chế độ
thực; backup thật bằng `pg_dump` qua job `backup` dưới login svc_backup,
BACKUP_DIR tạm ngoài repo, DB test):
  1. backup hợp lệ → bằng chứng vào sổ; người khối data_platform `--outputs`
     thấy khóa + sha, `--review-output` exit 0, +1 dòng `output_reviews` đúng
     người của login.
  2. app_human / agent_writer / svc_loader / bks_reader (và login người kiêm
     svc_backup) gọi function / INSERT sổ → bị từ chối, 0 dòng mới; svc_backup
     gửi bản ghi hỏng (fail, tên lạ, sha lạ, không JSON) → từ chối.
  3. khóa giả / sai sha / mẫu / phiên bản cũ / sai tính năng → CLI và SQL
     trực tiếp `output_review_human` chặn, 0 dòng `output_reviews`/log.
  4. sai khối / `--by` giả / login chưa ánh xạ → chặn.
  5. cổng PL02: bộ đếm DB khớp Python (parity), mẫu không đếm; chưa đủ đầu
     ra / chưa duyệt → không nâng; duyệt đủ đúng phiên bản → nâng được.
Người/khối là dữ liệu GIẢ của test."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import InsufficientPrivilege
from psycopg.types.json import Jsonb

from pipelines import rollout as ro
from pipelines.period import VN_TZ
from tests.test_v15_p10_human_authz import LAUNCHER, _cli, _conn, _q

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SINCE = datetime.now(VN_TZ) - timedelta(days=25)
FID = "data_platform-07.2"             # backup hằng ngày (nguồn file)
OTHER = "data_platform-07.3"           # cùng khối, nguồn khác (eval_runs)
P_DP = "Dữ Liệu Giả Lập"               # khối data_platform
P_CEO = "Điều Hành Giả Lập"            # khối ceo (sai khối)
FN = "file_output_evidence_backup"
DEAD = "postgresql://u@10.255.255.1:5432/x"
JUNK = "e" * 64


def _login_dsn(base, user, pw, schema):
    d = conninfo.conninfo_to_dict(base)
    d.update(user=user, password=pw, options=f"-c search_path={schema}")
    return conninfo.make_conninfo(**d)


@pytest.fixture(scope="module")
def p87c(tmp_path_factory):
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_v15p87c_{tag}"
    kinds = {"dp": "app_human", "ceo": "app_human", "unmapped": "app_human",
             "dpbk": "app_human, svc_backup", "agent": "agent_writer",
             "loader": "svc_loader", "bks": "bks_reader",
             "backup": "svc_backup"}
    logins = {k: (f"t_p87c_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    tmp = tmp_path_factory.mktemp("p87c")
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
            for k, person, blocks in (("dp", P_DP, ["data_platform"]),
                                      ("dpbk", P_DP, ["data_platform"]),
                                      ("ceo", P_CEO, ["ceo"])):
                admin.execute("insert into human_logins (db_login, person,"
                              " blocks, granted_by) values (%s, %s, %s,"
                              " 'test-p87c')", (name[k], person, blocks))
        d = tmp / "directors"
        shutil.copytree(ROOT / "data" / "directors", d)
        for blk, who in (("data_platform", P_DP), ("ceo", P_CEO)):
            p = d / f"{blk}.json"
            c = json.loads(p.read_text(encoding="utf-8"))
            c["approvers"] = [who]
            p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        users = tmp / "users.json"
        users.write_text(json.dumps({
            P_DP.casefold(): {"role": "ha_tang", "db_login": name["dp"]},
            P_CEO.casefold(): {"role": "tgd", "db_login": name["ceo"]},
        }, ensure_ascii=False), encoding="utf-8")
        launcher = tmp / "launch_p87c.py"
        launcher.write_text(LAUNCHER, encoding="utf-8")
        dsn = {k: _login_dsn(base, n, p, schema)
               for k, (n, p) in logins.items()}
        live = {"admin": admin, "schema": schema, "dsn": dsn, "name": name,
                "dirs": d, "users": users, "launcher": launcher, "tmp": tmp}
        cat = {f["id"]: f for f in ro.load_features()}
        with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
            ro.seed(c, [cat[FID], cat[OTHER]], "test-p87c", now=SINCE)
        live["feat"] = cat[FID]
        yield live
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for n, _ in logins.values():
            admin.execute(f"drop role if exists {n}")
        admin.close()


def _owner_dsn(live):
    return conninfo.make_conninfo(os.environ["DATABASE_URL"],
                                  options=f"-c search_path={live['schema']}")


def _env(live, extra):
    e = {k: v for k, v in os.environ.items()
         if not k.endswith("DATABASE_URL") and not k.startswith("BACKUP_")
         and k not in ("AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE",
                       "APPROVAL_ENFORCE", "PG_BIN", "JOB_LOCK_DIR")}
    e.update(DATABASE_URL=DEAD, APPROVAL_ENFORCE="1", BACKUP_KEEP="7",
             BACKUP_OFFSITE="", BACKUP_PASSPHRASE_FILE="", PG_BIN="",
             JOB_DATABASE_URL="", PYTHONIOENCODING="utf-8")
    e.update(extra)
    return e


def _run(argv, env):
    p = subprocess.run([sys.executable, *argv], cwd=ROOT, env=env,
                       capture_output=True, timeout=600, encoding="utf-8",
                       errors="replace", check=False)
    return p.returncode, p.stdout + p.stderr


def _last(path):
    lines = [x for x in path.read_bytes().split(b"\n") if x.strip()]
    return json.loads(lines[-1].decode("utf-8"))


def _rec(sha, ts="2026-10-17T01:30:00+07:00", **kw):
    r = {"ts": ts, "status": "ok", "file": "samsam_20261017_013000_vn.dump",
         "size_bytes": 1234, "sha256": sha, "offsite": None, "error": None,
         "retention_error": None}
    r.update(kw)
    return r


def _text(r):
    return json.dumps(r, sort_keys=True, ensure_ascii=False)


def _ev(live, r, sample=False, who="backup"):
    """Ghi bằng chứng bằng login `who` (đường dịch vụ) → id."""
    with _conn(live, who) as c:
        return c.execute(f"select {FN}(%s, %s)",
                         (r if isinstance(r, str) else _text(r), sample)
                         ).fetchone()[0]


def _n_ev(live):
    return _q(live, "select count(*) from file_output_evidence")[0][0]


def _reviews(live, key=None):
    if key is None:
        return _q(live, "select count(*) from output_reviews")[0][0]
    return _q(live, "select reviewed_by, db_role, content_sha256, decision"
              " from output_reviews where output_key = %s order by id",
              (key,))


def _n_log(live):
    return _q(live, "select count(*) from agent_action_log where action ="
              " 'output_review'")[0][0]


def _call(live, fid, key, sha, by=P_DP, who="dp"):
    try:
        with _conn(live, who) as c:
            return True, c.execute(
                "select output_review_human(%s, %s, %s, 'approved', %s,"
                " null)", (fid, key, sha, by)).fetchone()[0]
    except psycopg.Error as e:
        return False, str(e)


def _review_cli(live, fid, key, sha, by=P_DP, who="dp"):
    return _cli(live, who, "pipelines.rollout", "--review-output", fid,
                "--key", key, "--sha", sha, "--decision", "approved",
                "--by", by)


def _blocked(live, fid, key, sha, by=P_DP, who="dp", cli=True):
    n, lg = _reviews(live), _n_log(live)
    if cli:
        rc, out = _review_cli(live, fid, key, sha, by, who)
        assert rc != 0, f"CLI duyệt được {fid} {key}: {out}"
    ok, msg = _call(live, fid, key, sha, by, who)
    assert not ok, f"SQL ghi duyệt {fid} {key} (id {msg})"
    assert (_reviews(live), _n_log(live)) == (n, lg)
    return msg


# ===================================================== 1. backup hợp lệ


def test_p87c_valid_backup_listed_and_reviewed(p87c, tmp_path):
    bdir = tmp_path / "bk"
    rc, out = _run(["-m", "pipelines.job_runs", "--run", "backup"], _env(
        p87c, {"BACKUP_DATABASE_URL": p87c["dsn"]["backup"],
               "BACKUP_DIR": str(bdir), "JOB_LOCK_DIR": str(tmp_path)}))
    assert rc == 0, out
    rec = _last(bdir / "backup_runs.jsonl")
    assert rec["status"] == "ok", rec
    key, sha = f"bk:{rec['sha256']}", ro._rec_sha(rec)
    # người khối data_platform (login app_human, không owner) liệt kê được
    rc, out = _cli(p87c, "dp", "pipelines.rollout", "--outputs", FID)
    assert rc == 0, out
    line = next((x for x in out.splitlines() if x.startswith(key)), None)
    assert line is not None and f"sha={sha}" in line, out
    assert "CHƯA DUYỆT" in line
    n = _reviews(p87c)
    rc, out = _review_cli(p87c, FID, key, sha)
    assert rc == 0, out
    assert _reviews(p87c) == n + 1
    assert _reviews(p87c, key) == [(P_DP, p87c["name"]["dp"], sha,
                                    "approved")]
    # bằng chứng do chính login dịch vụ backup ghi, không mẫu
    assert _q(p87c, "select content_sha256, is_sample, captured_by from"
              " file_output_evidence where output_key = %s", (key,)) == [
        (sha, False, p87c["name"]["backup"])]
    rc, out = _cli(p87c, "dp", "pipelines.rollout", "--outputs", FID)
    line = next((x for x in out.splitlines() if x.startswith(key)), "")
    assert rc == 0 and f"sha={sha}" in line and "approved bởi" in line, out


# ====================================== 2. ai không phải dịch vụ backup


@pytest.mark.parametrize("who", ["dp", "ceo", "unmapped", "dpbk", "agent",
                                 "loader", "bks"])
def test_p87c_non_service_cannot_create_evidence(p87c, who):
    n = _n_ev(p87c)
    r = _rec("1" * 64)
    with _conn(p87c, who) as c, pytest.raises(InsufficientPrivilege):
        c.execute(f"select {FN}(%s, false)", (_text(r),))
    with _conn(p87c, who) as c, pytest.raises(InsufficientPrivilege):
        c.execute("insert into file_output_evidence (nguon, output_key,"
                  " content_sha256, ban_ghi, run_ts) values ('backup_runs',"
                  " %s, %s, %s, now())", ("bk:" + "1" * 64, JUNK, _text(r)))
    assert _n_ev(p87c) == n


def test_p87c_human_login_backup_tool_records_nothing(p87c, tmp_path):
    """Login người lỡ được cấp vào svc_backup chạy CHÍNH công cụ backup →
    dump xong nhưng DB từ chối bằng chứng (exit 4, không dòng sổ)."""
    bdir = tmp_path / "bk"
    n = _n_ev(p87c)
    rc, out = _run(["scripts/db_backup.py"], _env(
        p87c, {"DATABASE_URL": p87c["dsn"]["dpbk"], "BACKUP_DIR": str(bdir)}))
    assert rc == 4, out
    assert _last(bdir / "backup_runs.jsonl")["status"] == "ok"
    assert _n_ev(p87c) == n


@pytest.mark.parametrize("bad", [
    _text(_rec("2" * 64, status="fail")),
    _text(_rec("2" * 64, file="../samsam_20261017_013000_vn.dump")),
    _text(_rec("2" * 64, file="samsam_20261017_013000_vn.dump.partial")),
    _text(_rec("zz")),
    _text(_rec("2" * 64, ts="2026-10-17T01:30:00")),
    "không phải json", "[1, 2]"],
    ids=["fail", "path", "partial", "sha", "ts-naive", "not-json", "array"])
def test_p87c_service_bad_record_refused(p87c, bad):
    n = _n_ev(p87c)
    with pytest.raises(psycopg.Error):
        _ev(p87c, bad)
    assert _n_ev(p87c) == n


# ================================ 3. khóa giả / sai sha / mẫu / cũ / sai TN


def test_p87c_fake_wrong_sample_old_blocked(p87c):
    k1 = "3" * 64
    r1 = _rec(k1)
    _ev(p87c, r1)
    key1, sha1 = f"bk:{k1}", ro._rec_sha(r1)
    _blocked(p87c, FID, f"bk:{'f' * 64}", JUNK)                 # khóa giả
    _blocked(p87c, FID, f"bk:{'f' * 64}", sha1)
    _blocked(p87c, FID, key1, JUNK)                             # sai sha
    _blocked(p87c, OTHER, key1, sha1)                           # sai TN
    _blocked(p87c, FID, f"cv:zalo/{k1}", sha1)                  # sai nguồn
    # mẫu: dịch vụ ghi kèm is_sample → không liệt kê, không duyệt
    rs = _rec("4" * 64)
    _ev(p87c, rs, sample=True)
    rc, out = _cli(p87c, "dp", "pipelines.rollout", "--outputs", FID)
    assert rc == 0 and "4" * 64 not in out, out
    _blocked(p87c, FID, f"bk:{'4' * 64}", ro._rec_sha(rs))
    # phiên bản cũ: cùng khóa có bản ghi mới hơn → chỉ bản mới duyệt được
    k2 = "5" * 64
    old, new = _rec(k2), _rec(k2, retention_error="local x: bị khóa")
    _ev(p87c, old)
    _ev(p87c, new)
    rc, out = _cli(p87c, "dp", "pipelines.rollout", "--outputs", FID)
    assert rc == 0 and f"sha={ro._rec_sha(new)}" in out, out
    assert f"sha={ro._rec_sha(old)}" not in out
    _blocked(p87c, FID, f"bk:{k2}", ro._rec_sha(old))
    assert _call(p87c, FID, f"bk:{k2}", ro._rec_sha(new))[0]
    assert _call(p87c, FID, key1, sha1)[0]


# ============================================= 4. danh tính / khối


def test_p87c_identity_blocks(p87c):
    k = "6" * 64
    r = _rec(k)
    _ev(p87c, r)
    key, sha = f"bk:{k}", ro._rec_sha(r)
    _blocked(p87c, FID, key, sha, by=P_CEO, who="ceo")          # sai khối
    _blocked(p87c, FID, key, sha, by=P_CEO, who="dp")           # --by giả
    _blocked(p87c, FID, key, sha, by=P_DP, who="unmapped")      # chưa ánh xạ
    _blocked(p87c, FID, key, sha, by="agent:backup", who="dp")  # agent
    assert _reviews(p87c, key) == []


# ====================================================== 5. cổng PL02


def _promote(live, frm, to, ev):
    try:
        with _conn(live, "dp") as c:
            return True, c.execute(
                "select rollout_transition_human(%s, 'promote', %s, %s, %s,"
                " null, null, %s, now())", (FID, frm, to, P_DP, Jsonb(ev))
            ).fetchone()[0]
    except psycopg.Error as e:
        return False, str(e)


def _parity(live):
    with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
        m, counted, unc = ro.output_rows(c, live["feat"], SINCE,
                                         datetime.now(VN_TZ))
    assert counted and not unc, unc
    py = {k: (o["sha"], o["human"], o["needs_review"] and o["review"] is None)
          for k, o in m.items()}
    db = {k: (s, h, u) for k, s, h, u in _q(
        live, "with o as (select x.k, (array_agg(x.sha order by x.i) filter"
        " (where x.sha is not null))[1] s from feature_rollout r,"
        " rollout_db_outputs(r.count_spec, r.stage_since, now()) x where"
        " r.feature_id = %s group by x.k) select o.k, o.s, f.human, f.unrev"
        " from o join feature_rollout r on r.feature_id = %s,"
        " rollout_db_facts(r.feature_id, r.count_spec, r.stage_since, now())"
        " f where f.k = o.k", (FID, FID))}
    assert py == db
    return py


def test_p87c_pl02_gate_counts_db_evidence(p87c):
    py = _parity(p87c)
    assert py, "bộ đếm không thấy đầu ra backup nào"
    assert not any(k.endswith("4" * 64) for k in py)            # mẫu
    # khai khống ≥ 50 đầu ra: DB đếm lại từ sổ bằng chứng → chặn
    ok, msg = _promote(p87c, "chay_thu", "co_nguoi_duyet",
                       {"outputs": 999, "out_days": 9})
    assert not ok and "DB đếm lại" in msg, msg
    _q(p87c, "update feature_rollout set stage = 'co_nguoi_duyet' where"
       " feature_id = %s", (FID,))
    k = "7" * 64
    r = _rec(k)
    _ev(p87c, r)                              # đầu ra mới chưa duyệt
    py = _parity(p87c)
    assert py[f"bk:{k}"][2] is True
    ok, msg = _promote(p87c, "co_nguoi_duyet", "van_hanh",
                       {"human": 1, "unapproved": 0, "unreviewed": 0})
    assert not ok and "chưa duyệt" in msg, msg
    for key, (sha, _, unrev) in py.items():
        if unrev:
            assert _call(p87c, FID, key, sha)[0], key
    assert not any(u for _, _, u in _parity(p87c).values())
    ok, to = _promote(p87c, "co_nguoi_duyet", "van_hanh",
                      {"human": 1, "unapproved": 0, "unreviewed": 0})
    assert ok and to == "van_hanh", to
