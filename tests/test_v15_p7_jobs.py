# ruff: noqa: F811 — fixture pytest nhập từ file test khác (live/zfiles)
"""v15.1 (p7) — lịch job còn thiếu + ngân sách 30 giây Messenger.

P7.1 6 job + timer cho các bước v14.4/v14.5 chưa có lịch (`sales_director
     --run`, `kd_quote --followups`, `kd_orders --watch`, `kd_price
     --dealer-watch`, `agents.ceo_promo`, `intel_weekly --suggest-keywords`);
     drift jobs.json ↔ timer systemd ↔ cờ CLI; khóa chống chạy chồng.
P7.2 `muc_dich` job `red_alert_sweep` không còn nhận việc leo thang 2 giờ
     (việc đó ở `red_alert_escalate`).
P7.3 6 job chạy QUA WRAPPER bằng login `svc_job` THẬT (không owner, chế độ
     thực) trong schema tạm: mỗi job sinh đúng 1 loại mục hàng duyệt, sổ
     `job_runs` ok, log ghi `db_role` = login svc_job.
P7.4 Messenger `send_text` dùng phần còn lại của hạn chót TỔNG 30 giây (như
     Zalo v14.6): đồng hồ giả + transport giả, không sleep.

DB: schema tạm + login thật (fixture `live` của test_v14_p2_service_auth,
dọn cuối module). Skip khi không có DATABASE_URL (gate đòi 0 skipped).
"""

import json
import os
import re
import subprocess
import sys
import time
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from psycopg import conninfo

from api import rag
from connectors import channels, messenger, zalo
from pipelines import approval_queue as aq
from pipelines import director, job_runs
from scripts import health_bulletin as hb
from tests.test_v13_c07_ops import _log, zfiles  # noqa: F401
from tests.test_v14_p2_service_auth import live  # noqa: F401

ROOT = Path(__file__).resolve().parent.parent
SYSTEMD = ROOT / "deploy" / "onprem" / "systemd"
VN = timezone(timedelta(hours=7))

# job mới → (argv bước, module/script nguồn, loại mục hàng duyệt, created_by)
NEW = {
    "sales_sla": (["-m", "agents.sales_director", "--run"],
                  "agents/sales_director.py", "lead_followup",
                  "agent:sales_director"),
    "b2b_followups": (["-m", "agents.kd_quote", "--followups"],
                      "agents/kd_quote.py", "b2b_followup", None),
    "order_watch": (["-m", "agents.kd_orders", "--watch"],
                    "agents/kd_orders.py", "order_anomaly",
                    "agent:kd_orders"),
    "dealer_price_watch": (["-m", "agents.kd_price", "--dealer-watch"],
                           "agents/kd_price.py", "dealer_price_alert", None),
    "ceo_promo": (["-m", "agents.ceo_promo"], "agents/ceo_promo.py",
                  "promo_deviation", "agent:ceo_audit"),
    "intel_keywords": (["scripts/intel_weekly.py", "--suggest-keywords"],
                       "scripts/intel_weekly.py", "keyword_suggest",
                       "agent:intel_keywords"),
}


# ================================================================ P7.1 / P7.2

def _timer(name):
    return (SYSTEMD / f"samsam-job-{name}.timer").read_text(encoding="utf-8")


def test_p7_1_new_jobs_steps_service_and_assumed_schedule():
    jobs = job_runs.load_jobs()
    raw = json.loads((ROOT / "deploy" / "onprem" / "jobs.json")
                     .read_text(encoding="utf-8"))["jobs"]
    for name, (steps, _src, _ot, _by) in NEW.items():
        assert jobs[name]["steps"] == [steps], name
        # chạy bằng login dịch vụ job (không backup/không quản trị)
        assert job_runs.JOB_SERVICE.get(name, "job") == "job", name
        assert "GIẢ ĐỊNH" in raw[name]["muc_dich"], name
        assert "GIẢ ĐỊNH" in _timer(name), name
    cal = {n: jobs[n]["on_calendar"] for n in NEW}
    # SLA A 2 giờ / B 4 giờ: quét ≤ 30 phút/lần, hạn sức khỏe 1 giờ
    assert cal["sales_sla"] == "*-*-* *:10/30:00"
    assert jobs["sales_sla"]["max_gap_hours"] == 1
    for n in ("b2b_followups", "order_watch", "dealer_price_watch",
              "ceo_promo"):
        assert re.fullmatch(r"\*-\*-\* \d\d:\d\d:00", cal[n]), n   # hằng ngày
        assert jobs[n]["max_gap_hours"] == 26, n
    assert cal["intel_keywords"].startswith("Mon ")               # hằng tuần
    assert cal["intel_keywords"] > jobs["intel"]["on_calendar"].replace(
        "*-*-*", "Mon *-*-*")                      # sau job intel sáng thứ Hai
    assert jobs["intel_keywords"]["max_gap_hours"] == 192
    # bản tin sức khỏe theo dõi 6 job mới theo đúng hạn
    exp = hb.expected_jobs()
    for n in NEW:
        assert exp[f"job:{n}"] == jobs[n]["max_gap_hours"], n


def test_p7_1_drift_jobs_timers_and_cli_flags():
    """Mọi job ↔ đúng 1 timer (OnCalendar/Unit/Persistent khớp, không timer
    mồ côi); cờ của từng bước có thật trong argparse của module nguồn."""
    jobs = job_runs.load_jobs()
    timers = {p.name for p in SYSTEMD.glob("samsam-job-*.timer")}
    assert timers == {f"samsam-job-{n}.timer" for n in jobs}
    for n, j in jobs.items():
        lines = _timer(n).splitlines()
        assert [ln for ln in lines if ln.startswith("OnCalendar=")] == [
            f"OnCalendar={j['on_calendar']}"], n
        assert [ln for ln in lines if ln.startswith("Unit=")] == [
            f"Unit=samsam-job@{n}.service"], n
        assert "Persistent=true" in lines, n
    for name, (steps, src, _ot, _by) in NEW.items():
        code = (ROOT / src).read_text(encoding="utf-8")
        for flag in (a for a in steps if a.startswith("--")):
            assert re.search(rf"add_argument\(\s*\"{flag}\"", code), \
                (name, flag)


def test_p7_1_lock_blocks_overlap_per_job(tmp_path, monkeypatch):
    """Lần trước còn giữ khóa → lần sau exit 75, 0 bước; khóa theo TÊN job
    (job khác vẫn chạy); khóa nhả → chạy lại được."""
    rec = []
    monkeypatch.setattr(job_runs, "_record", lambda *a: rec.append(a))
    monkeypatch.delenv("JOB_DATABASE_URL", raising=False)
    for k in ("APPROVAL_ENFORCE", "AUTH_MODE", "DEPLOY"):
        monkeypatch.delenv(k, raising=False)
    jobs = job_runs.load_jobs()
    ran = []

    def runner(argv, cwd, timeout):
        ran.append(argv[1:])
        return types.SimpleNamespace(returncode=0)
    for name in NEW:
        ran.clear()
        with job_runs._file_lock(tmp_path / f"{name}.lock") as got:
            assert got
            assert job_runs.run_scheduled(name, jobs=jobs, lock_dir=tmp_path,
                                          runner=runner) == \
                job_runs.EXIT_LOCKED
            assert ran == []
            job, _s, _f, ok, detail = rec[-1]
            assert (job, ok) == (f"job:{name}", False)
            assert "chạy chồng" in detail
            other = next(n for n in NEW if n != name)
            assert job_runs.run_scheduled(other, jobs=jobs, lock_dir=tmp_path,
                                          runner=runner) == 0
            assert ran == [NEW[other][0]]
        ran.clear()
        assert job_runs.run_scheduled(name, jobs=jobs, lock_dir=tmp_path,
                                      runner=runner) == 0
        assert ran == [NEW[name][0]] and rec[-1][3] is True


def test_p7_2_red_alert_sweep_purpose_points_to_escalate_job():
    raw = json.loads((ROOT / "deploy" / "onprem" / "jobs.json")
                     .read_text(encoding="utf-8"))["jobs"]
    sweep = raw["red_alert_sweep"]["muc_dich"]
    # không còn tự nhận "leo thang 2 giờ" là việc của job này
    assert not re.search(r"\+\s*leo thang 2 giờ", sweep), sweep
    assert "red_alert_escalate" in sweep
    assert raw["red_alert_escalate"]["steps"] == [
        ["-m", "pipelines.red_alert", "--escalate"]]
    readme = (ROOT / "deploy" / "onprem" / "README.md").read_text(
        encoding="utf-8")
    row = next(ln for ln in readme.splitlines()
               if ln.startswith("| `red_alert_sweep` |"))
    assert "+ leo thang 2 giờ" not in row and "red_alert_escalate" in row
    for n in NEW:
        assert f"| `{n}` |" in readme, n


# ================================================================ P7.3 E2E

def _admin_tx(live):
    a = live["admin"]
    tx = a.transaction()
    tx.__enter__()
    a.execute(f"set local search_path to {live['schema']}, pg_temp")
    return a, tx


class _Tx:
    """conn admin trong 1 transaction đang mở: commit/close no-op."""

    def __init__(self, c):
        self.c = c

    def execute(self, *a, **k):
        return self.c.execute(*a, **k)

    def cursor(self, *a, **k):
        return self.c.cursor(*a, **k)

    def transaction(self):
        return self.c.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    @property
    def info(self):
        return self.c.info


def _seed(live, now):
    """Dữ liệu tối thiểu để MỖI job có đúng việc làm (giờ theo `now` thật —
    job tự đọc đồng hồ VN của nó)."""
    a, tx = _admin_tx(live)
    try:
        today = now.date()
        # sales-04.1: lead mới chưa gán người, quá 4 giờ làm việc
        a.execute("insert into leads (dedup_key, ts, channel, user_hash,"
                  " question, intent, status, source) values (%s, %s,"
                  " 'zalo', 'uh-p7', 'giá hộp quà', 'price', 'new',"
                  " 'conversations.jsonl')",
                  (f"p7:{uuid.uuid4().hex}", now - timedelta(days=5)))
        # sales-05: báo giá B2B ĐÃ duyệt 10 ngày trước, chưa có kết quả
        qid = director.submit(_Tx(a), "sales", "b2b_quote",
                              "BG-20261001-7-abcdef12", "Báo giá p7",
                              "# Báo giá p7\n\nTổng 1.000.000đ.\n",
                              "agent:kd_quote")
        a.execute("set local role app_human")
        ok, msg = aq.decide(_Tx(a), qid, "Lan", "approved")
        a.execute("reset role")
        assert ok, msg
        a.execute("set local session_replication_role = replica")
        a.execute("update approval_queue set decided_at = %s where id = %s",
                  (now - timedelta(days=10), qid))
        # sales-06.1 + ceo-04.1: golden + giá đã duyệt (dựng thẳng trạng
        # thái, bỏ trigger append-only — mẫu test_v14_p4/p5)
        a.execute("insert into sku_master (sku_key, name, category, source)"
                  " values ('p7-sam', 'Sâm p7', 'food', 'manual')")
        a.execute("insert into dealers (code, name, region, source) values"
                  " ('DL-P7', 'Đại lý p7', 'MIEN_TRUNG', 'manual')")
        a.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
                  " valid_from, approved_by) values ('p7-sam', 'shopee',"
                  " 'floor', 1000000, '2026-01-01', 'Lan'), ('p7-sam',"
                  " 'shopee', 'list', 1200000, '2026-01-01', 'Lan')")
        a.execute("set local session_replication_role = origin")
        a.execute("insert into dealer_price_obs (file_sha256, row_no,"
                  " channel, dealer_code, sku_key, price_vnd, observed_on,"
                  " source_url, created_by) values (%s, 2, 'shopee', 'DL-P7',"
                  " 'p7-sam', 900000, %s, 'https://shopee.vn/dl/p7', 'Lan')",
                  ("ab" * 32, today - timedelta(days=1)))
        sid = a.execute("insert into market_snapshots (channel, export_kind,"
                        " file_name, file_sha256, row_count, imported_at)"
                        " values ('shopee', 'listing', 'p7.csv', %s, 1, %s)"
                        " returning id", ("cd" * 32, now)).fetchone()[0]
        a.execute("insert into market_rows (snapshot_id, row_no, channel,"
                  " export_kind, item_id, seller_sku, sku_key, title,"
                  " price_vnd, raw) values (%s, 2, 'shopee', 'listing',"
                  " '992', 'SS-2', 'p7-sam', 'Tiêu đề', 1200000, %s)",
                  (sid, json.dumps({"sale_price": "800000"})))
        # sales-06.2: tuần ĐÃ đóng gần nhất hủy 4/20 = 20% > 15%
        d = today - timedelta(days=today.weekday() + 7)       # thứ Hai trước
        ts0 = datetime(d.year, d.month, d.day, 10, tzinfo=VN)
        for i in range(20):
            a.execute("insert into orders (id, ts, channel, qty, total_vnd,"
                      " status, source) values (%s, %s, 'shopee', 1, 100000,"
                      " %s, 'market:shopee')",
                      (f"shopee:p7{i:02d}{uuid.uuid4().hex[:8]}",
                       ts0 + timedelta(hours=i),
                       "cancelled" if i < 4 else "Đã giao"))
        # intel-04.2: file Trends related mới nhất
        iid = a.execute("insert into intel_imports (kind, file_name,"
                        " file_sha256, row_count) values ('trend_related',"
                        " 'related.csv', %s, 1) returning id",
                        ("ef" * 32,)).fetchone()[0]
        a.execute("insert into trends_related (import_id, seed, section,"
                  " query, value) values (%s, 'sâm ngọc linh', 'rising',"
                  " 'hộp quà sâm biếu tết', '+250%%')", (iid,))
    except BaseException:
        tx.__exit__(*sys.exc_info())
        raise
    tx.__exit__(None, None, None)


def _q(live, sql, args=()):
    a, tx = _admin_tx(live)
    try:
        return a.execute(sql, args or None).fetchall()
    finally:
        tx.__exit__(None, None, None)


def _dead_dsn(live):
    d = conninfo.conninfo_to_dict(live["dsn"]["admin"])
    d.update(user=f"p7_khong_ton_tai_{uuid.uuid4().hex[:6]}",
             password=uuid.uuid4().hex)
    return conninfo.make_conninfo(**d)


def _env(live, tmp_path):
    e = dict(os.environ, PYTHONIOENCODING="utf-8", OPENROUTER_API_KEY="",
             RED_ALERT_NOTIFY="", SMTP_HOST="",
             # DSN ban đầu = login KHÔNG TỒN TẠI: wrapper phải tự chuyển
             # sang login svc_job (JOB_DATABASE_URL) cho mọi bước con — bước
             # nào còn dùng DSN cũ sẽ lỗi kết nối
             DATABASE_URL=_dead_dsn(live),
             JOB_DATABASE_URL=live["dsn"]["svc_job"],
             APPROVAL_ENFORCE="1", JOB_LOCK_DIR=str(tmp_path / "locks"))
    for k in ("AUTH_MODE", "DEPLOY", "LOADER_DATABASE_URL",
              "WEBHOOK_DATABASE_URL", "BACKUP_DATABASE_URL"):
        e.pop(k, None)
    return e


def _wrapper(name, env):
    r = subprocess.run([sys.executable, "-m", "pipelines.job_runs", "--run",
                        name], cwd=ROOT, env=env, capture_output=True,
                       timeout=300, encoding="utf-8", errors="replace",
                       check=False)
    return r.returncode, r.stdout + r.stderr


def test_p7_3_six_jobs_run_under_real_svc_job_login(live, tmp_path):
    now = datetime.now(VN)
    _seed(live, now)
    env = _env(live, tmp_path)
    login = live["name"]["svc_job"]
    for name, (_steps, _src, otype, by) in NEW.items():
        rc, out = _wrapper(name, env)
        assert rc == 0, (name, out)
        for bad in ("InsufficientPrivilege", "permission denied",
                    "Traceback"):
            assert bad not in out, (name, out)
        rows = _q(live, "select id, block, created_by from approval_queue"
                  " where object_type = %s", (otype,))
        assert len(rows) == 1, (name, rows, out)
        if by:
            assert rows[0][2] == by, (name, rows)
        # DATABASE_URL ban đầu là login KHÔNG TỒN TẠI → mục được ghi chứng tỏ
        # bước con chạy bằng JOB_DATABASE_URL (login svc_job)
        assert login in env["JOB_DATABASE_URL"]
        jr = _q(live, "select ok, detail from job_runs where job = %s"
                " order by id", (f"job:{name}",))
        assert jr == [(True, None)], (name, jr)
    # chạy lại: idempotent theo đợt — không nhân bản mục nào
    for name, (_s, _src, otype, _by) in NEW.items():
        rc, out = _wrapper(name, env)
        assert rc == 0, (name, out)
        n = _q(live, "select count(*) from approval_queue where object_type"
               " = %s", (otype,))[0][0]
        assert n == 1, (name, n)


def test_p7_3_wrapper_refuses_owner_login_and_overlap(live, tmp_path):
    env = _env(live, tmp_path)
    # JOB_DATABASE_URL = quản trị/owner → chế độ thực từ chối, 0 bước
    rc, out = _wrapper("ceo_promo", dict(env,
                                         JOB_DATABASE_URL=live["dsn"]["admin"]))
    assert rc == job_runs.EXIT_SERVICE, out
    # tiến trình khác đang giữ khóa job → exit 75, sổ ghi "chạy chồng"
    lock = tmp_path / "locks" / "order_watch.lock"
    with job_runs._file_lock(lock) as got:
        assert got
        rc, out = _wrapper("order_watch", env)
    assert rc == job_runs.EXIT_LOCKED, out
    rows = _q(live, "select ok, detail from job_runs where job ="
              " 'job:order_watch' order by id desc limit 1")
    assert rows[0][0] is False and "chạy chồng" in rows[0][1]


# ================================================================ P7.4

class _Clock:
    """Đồng hồ monotonic giả cho `zalo` (module `time` thật cho phần còn
    lại) — tất định, không sleep."""

    def __init__(self, t=1000.0):
        self.t = t

    def install(self, monkeypatch):
        fake = types.SimpleNamespace(**{k: getattr(time, k) for k in dir(time)
                                        if not k.startswith("_")})
        fake.monotonic = lambda: self.t
        monkeypatch.setattr(zalo, "time", fake)
        return self


@pytest.fixture
def msend(monkeypatch):
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setenv("MESSENGER_PAGE_TOKEN", "PAGE-TOKEN-TEST")
    calls = []

    class R:
        status_code = 200

    def fake_post(url, **kw):
        calls.append(kw.get("timeout"))
        return R()
    monkeypatch.setattr(messenger.httpx, "post", fake_post)
    return calls


def _with_deadline(dl, fn):
    tok, late = zalo._SEND_DEADLINE.set(dl), zalo._SEND_LATE.set(None)
    try:
        return fn(), zalo._SEND_LATE.get()
    finally:
        zalo._SEND_LATE.reset(late)
        zalo._SEND_DEADLINE.reset(tok)


def test_p7_4_send_timeout_is_remaining_budget(msend, monkeypatch):
    clk = _Clock().install(monkeypatch)
    ok, late = _with_deadline(clk.t + 3.0,
                              lambda: messenger.send_text("messenger:42", "x"))
    assert ok is True and late is None
    assert msend == [3.0]                       # code cũ: 5 giây cố định
    msend.clear()
    ok, _ = _with_deadline(clk.t + 12.0,
                           lambda: messenger.send_text("messenger:42", "x"))
    assert ok is True and msend == [zalo.SEND_TIMEOUT_S]    # trần 5 giây
    msend.clear()
    # không có hạn chót (tin không phải chữ / gọi trực tiếp) → như cũ
    assert messenger.send_text("messenger:42", "x") is True
    assert msend == [zalo.SEND_TIMEOUT_S]


@pytest.mark.parametrize("left", [0.5, 0.0, -2.0])
def test_p7_4_budget_exhausted_no_call(msend, monkeypatch, capsys, left):
    clk = _Clock().install(monkeypatch)
    ok, late = _with_deadline(clk.t + left,
                              lambda: messenger.send_text("messenger:42", "x"))
    assert ok is False and late == "gui"
    assert msend == []                          # 0 lời gọi Graph API
    out = capsys.readouterr().out
    assert "[deadline] messenger" in out and "42" not in out.replace(
        zalo._uhash("messenger:42"), "")


def test_p7_4_reply_turn_late_send_hands_off(zfiles, msend, monkeypatch):
    """E2E `_reply` kênh messenger: trả lời xong sát hạn (còn 0,5 giây) →
    KHÔNG gọi Graph API với 5 giây cố định (tổng vượt 30 giây) mà chuyển
    người lý do `deadline`, convlog `deadline:gui`."""
    tmp_path, handoffs = zfiles
    clk = _Clock().install(monkeypatch)
    monkeypatch.setattr(rag, "SEND_RESERVE_S", 0.2)
    monkeypatch.setattr("api.rag.answer",
                        lambda q, history=None: {
                            "answer": "Giá 1.000.000 đ",
                            "sources": ["https://x"]})
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "van_hanh")
    monkeypatch.setattr(channels, "consent_gate",
                        lambda inb: channels.Gate("", False, False))
    r = zalo._reply("messenger:1234567890123456", "Saphraton giá bao nhiêu?",
                    "mid.p7", channel="messenger", send=messenger.send_text,
                    t_recv=clk.t - 29.5)
    assert msend == []
    assert r["sent"] is False and handoffs == ["deadline"]
    rec = _log(tmp_path)[-1]
    assert rec["channel"] == "messenger" and rec["error"] == "deadline:gui"
    assert rec["sent"] is False and rec["answered"] is False
    assert zalo._SEND_DEADLINE.get() is None    # không rò sang lượt sau
    # còn đủ ngân sách (8 giây) → gửi, timeout = min(5, còn lại)
    handoffs.clear()
    r = zalo._reply("messenger:1234567890123456", "Saphraton giá bao nhiêu?",
                    "mid.p7b", channel="messenger", send=messenger.send_text,
                    t_recv=clk.t - 22)
    assert r["sent"] is True and handoffs == [] and msend == [5.0]
    assert "error" not in _log(tmp_path)[-1]

