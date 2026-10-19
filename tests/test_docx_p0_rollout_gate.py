"""Đợt DOCX P0 — cổng nâng giai đoạn PL02 mục 1 chạy được bằng login NGƯỜI
thật, và DB không tin số đầu ra caller tự khai.

Lỗi trước sửa (nền 667f763):
  (a) `rollout --promote` dưới login `in role app_human` (không owner) đếm
      đầu ra bằng bộ đếm Python → login người không SELECT được bảng nguồn
      → "không đếm được" → CLI chặn TRƯỚC khi tới function DB (function DB
      có bộ đếm `count_spec` riêng) — người được ủy quyền không nâng được
      tính năng đủ điều kiện;
  (b) `rollout_transition_human`: tính năng có nguồn `file` (sales-01 —
      convlog chatbot) → ngưỡng ≥50 đầu ra / ≥5 ngày lấy từ `p_evidence`
      do CALLER truyền → gọi thẳng SQL khai `{"outputs": 60, "out_days": 6}`
      là vượt cổng chạy thử.

Sau sửa: CLI dùng số DB đếm lại (`rollout_recount_human`) khi login không
đọc được nguồn; DB bỏ mọi ngưỡng dựa số caller khai, nguồn file KHÔNG có
bằng chứng DB → không nâng; câu bot đã gửi khách thật (sales-01) có bằng
chứng DB `file_output_evidence` nguồn `conversations` CHỈ login dịch vụ
webhook (`svc_webhook`, không thuộc role người/agent khác) ghi được.

Probe: schema tạm ĐÃ COMMIT trên DB test, login Postgres THẬT tạm (không
owner/superuser), CLI chạy SUBPROCESS chế độ thực (`APPROVAL_ENFORCE=1`),
không ép giai đoạn/dev. Người/khối/login là dữ liệu GIẢ của test. Skip khi
không có DATABASE_URL."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, time, timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo

from pipelines import rollout as ro
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")

P_SALES = "Bán Hàng Giả Lập P0"
P_LEGAL = "Pháp Chế Giả Lập P0"
NOW = datetime.now(VN_TZ)
SINCE = NOW - timedelta(days=21)

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


def _workdays(n):
    """n ngày làm việc (T2–T6) gần nhất TRƯỚC hôm nay (giờ VN), sau SINCE."""
    out, d = [], NOW.date() - timedelta(days=1)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    assert out[-1] > SINCE.date()
    return out


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
    schema = f"t_docxp0_{tag}"
    kinds = {"sales": ["app_human"], "legal": ["app_human"],
             "webhook": ["svc_webhook"],
             "dual": ["svc_webhook", "app_human"],
             "agent": ["agent_writer"], "loader": ["svc_loader"]}
    logins = {k: (f"t_p0_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    tmp = tmp_path_factory.mktemp("docxp0")
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
                          f" in role {', '.join(kinds[k])}")
        name = {k: n for k, (n, _) in logins.items()}
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}")
            for k, person, blocks in (("sales", P_SALES, ["sales"]),
                                      ("legal", P_LEGAL, ["legal_hr"])):
                admin.execute("insert into human_logins (db_login, person,"
                              " blocks, granted_by) values (%s, %s, %s,"
                              " 'test-docx-p0')", (name[k], person, blocks))
        d = tmp / "directors"
        shutil.copytree(ROOT / "data" / "directors", d)
        for blk, who in (("sales", P_SALES), ("legal_hr", P_LEGAL)):
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
        }, ensure_ascii=False), encoding="utf-8")
        launcher = tmp / "launch_p0.py"
        launcher.write_text(LAUNCHER, encoding="utf-8")
        dsn = {k: _login_dsn(base, n, p, schema)
               for k, (n, p) in logins.items()}
        owner = conninfo.make_conninfo(base,
                                       options=f"-c search_path={schema}")
        cat = {f["id"]: f for f in ro.load_features()}
        with psycopg.connect(owner, connect_timeout=5) as c:
            ro.seed(c, [cat[i] for i in (
                "sales-01", "sales-02", "sales-03", "sales-04.1", "sales-04.2",
                "sales-05", "sales-06.1",
                "sales-06.2", "sales-07.2", "sales-07.3")], "test-docx-p0",
                now=SINCE)
        yield {"admin": admin, "schema": schema, "dsn": dsn, "name": name,
               "dirs": d, "users": users, "launcher": launcher,
               "owner": owner}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for n, _ in logins.values():
            admin.execute(f"drop role if exists {n}")
        admin.close()


def _q(live, sql, args=(), replica=False):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        if replica:     # dữ liệu mồi có mốc QUÁ KHỨ (bỏ trigger ép now())
            a.execute("set local session_replication_role = replica")
        cur = a.execute(sql, args or None)
        return cur.fetchall() if cur.description else []


def _cli(live, who, *args):
    e = {k: v for k, v in os.environ.items()
         if not k.endswith("DATABASE_URL") and k not in (
             "AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE", "APPROVAL_ENFORCE")}
    e.update(DATABASE_URL=live["dsn"][who], APPROVAL_ENFORCE="1",
             AUTH_USERS_FILE=str(live["users"]), PYTHONIOENCODING="utf-8",
             OPENROUTER_API_KEY="")
    p = subprocess.run(
        [sys.executable, str(live["launcher"]), str(ROOT), str(live["dirs"]),
         "pipelines.rollout", *map(str, args)], cwd=ROOT, env=e,
        capture_output=True, timeout=180, encoding="utf-8", errors="replace",
        check=False)
    return p.returncode, p.stdout + p.stderr


def _aq(live, otype, n, days, *, created_by, sample=False, tag="x"):
    """n mục hàng duyệt THẬT (guardrail đạt) rải trên `days` ngày làm việc."""
    for i in range(n):
        d = days[i % len(days)]
        ts = datetime.combine(d, time(9, i % 50), VN_TZ)
        _q(live, "insert into approval_queue (object_type, object_id, block,"
           " title, payload, content_sha256, risk, guardrail, created_by,"
           " created_at, due_at, is_sample) values (%s, %s, 'sales', %s,"
           " 'p', %s, 'low', '{\"ok\": true}', %s, %s, %s, %s)",
           (otype, f"p0-{tag}-{i}", f"mục {tag} {i}", "a" * 64, created_by,
            ts, ts + timedelta(days=3), sample), replica=True)


def _stage(live, fid):
    return _q(live, "select stage from feature_rollout where feature_id ="
              " %s", (fid,))[0][0]


def _direct(live, who, fid, frm, to, ev):
    with psycopg.connect(live["dsn"][who], connect_timeout=5) as c:
        return c.execute(
            "select rollout_transition_human(%s, 'promote', %s, %s, %s, null,"
            " null, %s, now())", (fid, frm, to, P_SALES, json.dumps(ev))
        ).fetchone()[0]


# ---------------------------------------------------------- (a) CLI người

def test_p0a_human_cli_promotes_when_db_count_passes(live):
    _aq(live, "order_anomaly", 50, _workdays(6),
        created_by="agent:kd_orders", tag="ok")
    rc, out = _cli(live, "sales", "--promote", "sales-06.2", "--by", P_SALES)
    assert rc == 0, out
    assert _stage(live, "sales-06.2") == "co_nguoi_duyet"
    ev = _q(live, "select by_person, evidence->'db_recount' from"
            " feature_rollout_events where feature_id = 'sales-06.2' and"
            " kind = 'promote'")
    assert len(ev) == 1 and ev[0][0] == P_SALES
    assert ev[0][1]["outputs"] == 50 and ev[0][1]["out_days"] == 6, ev
    # lần nâng tiếp ngay sau đó: giai đoạn mới chưa đủ ngày → chặn, 0 đổi
    rc, out = _cli(live, "sales", "--promote", "sales-06.2", "--by", P_SALES)
    assert rc == 1 and "ngày" in out, out
    assert _stage(live, "sales-06.2") == "co_nguoi_duyet"


def test_p0a_human_cli_promotes_unreadable_source(live):
    """Nguồn login người KHÔNG có SELECT (`consents` — 16 tính năng co_code
    có nguồn kiểu này): trước sửa CLI báo "không đếm được" dù DB đếm đủ."""
    cid = _q(live, "insert into contacts (phone_hmac, phone_enc, source, created_by) values"
             " (%s, 'gAAAAAp0', 'manual', 'test-p0') returning id", ("c" * 64,))[0][0]
    _q(live, "insert into dealers (code, name, region, source) values"
       " ('DL-P0', 'Đại lý giả p0', 'mien_trung', 'manual')")
    for i, d in enumerate(_workdays(5) * 10):
        _q(live, "insert into consents (contact_id, purpose, granted,"
           " recipient_dealer, source, evidence_ref, policy_version,"
           " recorded_by, ts) values (%s, 'dai_ly', true, 'DL-P0', 'web', %s,"
           " 'v1', %s, %s)", (cid, f"BB-P0-{i}", P_SALES,
                              datetime.combine(d, time(8, i), VN_TZ)),
           replica=True)
    # docx P2: đồng ý mục đích khác / rút đồng ý KHÔNG là đầu ra sales-04.2
    _q(live, "insert into consents (contact_id, purpose, granted, source,"
       " recorded_by) values (%s, 'cskh', false, 'web', %s)", (cid, P_SALES))
    with psycopg.connect(live["dsn"]["sales"], connect_timeout=5) as c, \
            pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("select count(*) from consents")
    rc, out = _cli(live, "sales", "--promote", "sales-04.2", "--by", P_SALES)
    assert rc == 0, out
    assert _stage(live, "sales-04.2") == "co_nguoi_duyet"


@pytest.mark.parametrize("fid,setup,frag", [
    ("sales-07.2", lambda lv: _aq(lv, "care_review", 49, _workdays(6),
                                  created_by="agent:kd_care", tag="49"),
     "49/50"),
    ("sales-05", lambda lv: _aq(lv, "b2b_quote", 60, _workdays(4),
                                created_by="agent:kd_quote", tag="d4"),
     "4/5"),
    ("sales-06.1", lambda lv: (
        _aq(lv, "price_change", 40, _workdays(6),
            created_by="agent:kd_price", tag="real"),
        _aq(lv, "price_change", 20, _workdays(6),
            created_by="agent:kd_price", sample=True, tag="mau")),
     "40/50"),
])
def test_p0a_human_cli_blocked_with_db_reason(live, fid, setup, frag):
    setup(live)
    rc, out = _cli(live, "sales", "--promote", fid, "--by", P_SALES)
    assert rc == 1 and frag in out, out
    assert _stage(live, fid) == "chay_thu"


def test_p0a_blocked_wrong_block_forged_by_severe_and_no_counter(live):
    _aq(live, "listing_sync", 50, _workdays(6), created_by="agent:kd_listing",
        tag="sev")
    before = _q(live, "select count(*) from agent_action_log where action ="
                " 'authz_denied'")[0][0]
    rc, out = _cli(live, "legal", "--promote", "sales-03", "--by", P_LEGAL)
    assert rc == 1, out                              # sai khối
    rc, out = _cli(live, "sales", "--promote", "sales-03", "--by", P_LEGAL)
    assert rc == 1, out                              # --by giả
    assert _q(live, "select count(*) from agent_action_log where action ="
              " 'authz_denied'")[0][0] == before + 2
    _q(live, "insert into feature_rollout_events (ts, feature_id, kind,"
       " from_stage, to_stage, severe_code, by_person) values (%s,"
       " 'sales-03', 'severe', 'chay_thu', 'chay_thu', 'tu_cam', %s)",
       (NOW - timedelta(days=1), P_SALES))
    rc, out = _cli(live, "sales", "--promote", "sales-03", "--by", P_SALES)
    assert rc == 1 and "nghiêm trọng" in out, out
    assert _stage(live, "sales-03") == "chay_thu"
    # đủ đầu ra theo Python nhưng sổ chưa có bộ đếm DB → DB từ chối
    _aq(live, "lead_followup", 50, _workdays(6),
        created_by="agent:sales_director", tag="nospec")
    _q(live, "update feature_rollout set count_spec = null where feature_id"
       " = 'sales-04.1'")
    rc, out = _cli(live, "sales", "--promote", "sales-04.1", "--by", P_SALES)
    assert rc == 1 and "seed" in out, out
    assert _stage(live, "sales-04.1") == "chay_thu"


def test_p0a_report_review_then_promote_to_operation(live):
    """co_nguoi_duyet → van_hanh: báo cáo chưa duyệt → chặn; NGƯỜI duyệt đúng
    phiên bản bằng CLI login thật → nâng được."""
    _q(live, "update feature_rollout set stage = 'co_nguoi_duyet',"
       " stage_since = %s where feature_id = 'sales-07.3'",
       (NOW - timedelta(days=30),))
    sha = "f" * 64
    _q(live, "insert into report_outputs (feature_id, name, sha256,"
       " created_at) values ('sales-07.3', 'kd-forecast-p0.md', %s, %s)",
       (sha, NOW - timedelta(days=3)), replica=True)
    rc, out = _cli(live, "sales", "--promote", "sales-07.3", "--by", P_SALES)
    assert rc == 1 and "chưa" in out and "duyệt" in out, out
    rc, out = _cli(live, "sales", "--review-output", "sales-07.3", "--key",
                   "rp:kd-forecast-p0.md", "--sha", sha, "--decision",
                   "approved", "--by", P_SALES)
    assert rc == 0, out
    rc, out = _cli(live, "sales", "--promote", "sales-07.3", "--by", P_SALES)
    assert rc == 0, out
    assert _stage(live, "sales-07.3") == "van_hanh"


def test_p0a_direct_sql_inflated_evidence_blocked(live):
    with pytest.raises(psycopg.Error) as ei:
        _direct(live, "sales", "sales-07.2", "chay_thu", "co_nguoi_duyet",
                {"outputs": 999, "out_days": 99, "human": 9})
    assert "DB đếm lại" in str(ei.value), str(ei.value)
    assert _stage(live, "sales-07.2") == "chay_thu"


# ------------------------------------------- (b) sales-01 — nguồn convlog

def _conv(mid, **kw):
    r = {"ts": "2026-10-15T02:00:00Z", "msg_id": mid, "channel": "zalo",
         "answered": True, "sent": True, "guardrail_ok": True,
         "provenance": "live"}
    r.update(kw)
    return json.dumps(r, ensure_ascii=False)


def _record(live, who, rec):
    with psycopg.connect(live["dsn"][who], connect_timeout=5) as c:
        return c.execute("select file_output_evidence_chat(%s)",
                         (rec,)).fetchone()[0]


def test_p0b_sales01_forged_evidence_direct_sql_blocked(live):
    """Trước sửa: không có bằng chứng DB nào, khai số → DB cho nâng."""
    with pytest.raises(psycopg.Error):
        _direct(live, "sales", "sales-01", "chay_thu", "co_nguoi_duyet",
                {"outputs": 60, "out_days": 6})
    assert _stage(live, "sales-01") == "chay_thu"


@pytest.mark.parametrize("who", ["sales", "agent", "loader", "dual"])
def test_p0b_only_webhook_login_records_chat_evidence(live, who):
    with pytest.raises(psycopg.Error) as ei:
        _record(live, who, _conv(f"m-deny-{who}"))
    m = str(ei.value)
    assert ("permission denied" in m or "svc_webhook" in m
            or "không tự tạo bằng chứng" in m), m
    assert _q(live, "select count(*) from file_output_evidence where"
              " output_key = %s", (f"cv:zalo/m-deny-{who}",))[0][0] == 0


@pytest.mark.parametrize("rec", [
    _conv("m-s1", provenance="sample", is_sample=True),
    _conv("m-s2", is_sample=True),
    _conv("m-s3", provenance="demo"),
    _conv("m-s4", sent=False),
    _conv("m-s5", guardrail_ok=False),
    _conv("m-s6", answered=False),
    _conv("m-s7", channel="streamlit"),
    _conv(""),
    _conv("m-s8", ts="2026-10-15 02:00"),
    json.dumps({k: v for k, v in json.loads(_conv("m-s9")).items()
                if k != "provenance"}),
    "khong phai json",
])
def test_p0b_webhook_rejects_non_output_records(live, rec):
    with pytest.raises(psycopg.Error):
        _record(live, "webhook", rec)


def test_p0b_sales01_promotes_only_on_db_chat_evidence(live):
    ids = {_record(live, "webhook", _conv(f"m-{i}")) for i in range(50)}
    assert len(ids) == 50
    assert _record(live, "webhook", _conv("m-0")) in ids     # idempotent
    for i, d in enumerate(_workdays(5) * 10):                # mốc mồi quá khứ
        _q(live, "update file_output_evidence set captured_at = %s where"
           " output_key = %s", (datetime.combine(d, time(10), VN_TZ),
                                f"cv:zalo/m-{i}"), replica=True)
    _q(live, "update feature_rollout set count_spec = null where feature_id"
       " = 'sales-01'")
    with psycopg.connect(live["owner"], connect_timeout=5) as c:   # đồng bộ
        ro.seed(c, [f for f in ro.load_features() if f["id"] == "sales-01"],
                "test-docx-p0")
    spec = _q(live, "select count_spec from feature_rollout where feature_id"
              " = 'sales-01'")[0][0]
    assert spec["file"] == 0 and spec["sql"], spec
    rc, out = _cli(live, "sales", "--promote", "sales-01", "--by", P_SALES)
    assert rc == 0, out
    assert _stage(live, "sales-01") == "co_nguoi_duyet"
    ev = _q(live, "select evidence->'db_recount' from feature_rollout_events"
            " where feature_id = 'sales-01' and kind = 'promote'")[0][0]
    assert ev["outputs"] == 50 and ev["out_days"] == 5, ev


def test_p0b_zalo_convlog_writes_db_evidence_only_for_live(live, tmp_path,
                                                          monkeypatch):
    """Đường ghi THẬT `zalo._log_conversation` dưới login webhook: dòng live
    đủ điều kiện → 1 bằng chứng DB (chỉ khóa/cờ, không câu khách/câu bot);
    dòng mẫu / gửi lỗi → 0; DB từ chối/down → chỉ warn, convlog vẫn ghi."""
    from connectors import channels, zalo
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(channels, "_connect", lambda: psycopg.connect(
        live["dsn"]["webhook"], connect_timeout=5))
    base = {"ts": "2026-10-16T03:00:00Z", "user_hash": "u" * 16,
            "question": "Hỏi giá sâm", "answer": "Giá 1.000.000đ",
            "channel": "messenger", "answered": True, "sent": True,
            "guardrail_ok": True}
    zalo._log_conversation({**base, "msg_id": "m_live-1",
                            "provenance": "live"})
    zalo._log_conversation({**base, "msg_id": "m_mau-1"})       # thiếu → mẫu
    zalo._log_conversation({**base, "msg_id": "m_fail-1", "sent": False,
                            "provenance": "live"})
    rows = _q(live, "select output_key, ban_ghi from file_output_evidence"
              " where nguon = 'conversations' and output_key like"
              " 'cv:messenger/%'")
    assert [r[0] for r in rows] == ["cv:messenger/m_live-1"], rows
    assert "Hỏi" not in rows[0][1] and "Giá" not in rows[0][1] \
        and "user_hash" not in rows[0][1]
    monkeypatch.setattr(channels, "_connect", lambda: None)      # DB down
    zalo._log_conversation({**base, "msg_id": "m_live-2",
                            "provenance": "live"})
    lines = (tmp_path / "conversations.jsonl").read_text(
        encoding="utf-8").splitlines()
    assert len(lines) == 4
