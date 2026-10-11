"""v9.5 W95.4 — CK-A2 CMMS nhẹ `agents.cmms`: nhắc đến hạn (today tham số,
không wall-clock), downtime, hồ sơ thiếu, CLI validate trước connect, việc
lớn/GMP bắt buộc người duyệt. DB thật chạy trong schema TẠM + rollback
(như test_golden_store) — không đụng dữ liệu public. Máy MẪU `SS-EQ-99xx`."""
import os
import re
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from agents import cmms

ROOT = Path(__file__).resolve().parent.parent
T = date(2026, 12, 20)


def _m(code="SS-EQ-9901", **kw):
    base = {"code": code, "name": "MẪU", "location": "xưởng", "maker": "MẪU",
            "year": 2020, "thuoc_dien_kiem_dinh": False, "han_kiem_dinh": None,
            "la_phuong_tien_do": False, "han_hieu_chuan": None,
            "ho_so_gmp": False, "active": True}
    return {**base, **kw}


def _p(pid=1, code="SS-EQ-9901", every=30, start=T, last=None, **kw):
    return {"id": pid, "machine_code": code, "task": "MẪU", "interval_days": every,
            "major": False, "start_on": start, "last_done_on": last,
            "active": True, **kw}


# --- due_items (hàm thuần) ----------------------------------------------------
def test_due_overdue_and_horizon_boundaries():
    plans = [_p(1, every=10, last=T - timedelta(days=11)),  # hạn hôm qua
             _p(2, every=10, last=T - timedelta(days=3)),   # hạn T+7
             _p(3, every=10, last=T - timedelta(days=2)),   # hạn T+8
             _p(4, every=10, last=T - timedelta(days=10))]  # hạn hôm nay
    got = {r["plan_id"]: r["status"] for r in cmms.due_items(plans, [_m()], T)}
    assert got == {1: "overdue", 2: "due", 4: "due"}


def test_due_plan_without_last_done_uses_start_on():
    plans = [_p(1, every=30, start=T - timedelta(days=30), last=None)]
    (r,) = cmms.due_items(plans, [_m()], T)
    assert r["due_on"] == T and r["status"] == "due" and r["days_left"] == 0


@pytest.mark.parametrize("delta,expect", [(25, True), (10, True), (30, True),
                                          (31, False), (-1, True)])
def test_cert_deadlines_30_days(delta, expect):
    m = _m(thuoc_dien_kiem_dinh=True, han_kiem_dinh=T + timedelta(days=delta),
           la_phuong_tien_do=True, han_hieu_chuan=T + timedelta(days=delta))
    kinds = {r["kind"]: r for r in cmms.due_items([], [m], T)}
    assert ("kiem_dinh" in kinds) is expect and ("hieu_chuan" in kinds) is expect
    if delta < 0:
        assert kinds["kiem_dinh"]["status"] == "overdue"


def test_kiem_dinh_25_and_hieu_chuan_10_both_remind():
    m = _m(han_kiem_dinh=T + timedelta(days=25), han_hieu_chuan=T + timedelta(days=10))
    got = [(r["kind"], r["days_left"]) for r in cmms.due_items([], [m], T)]
    assert got == [("hieu_chuan", 10), ("kiem_dinh", 25)]


def test_inactive_machine_or_plan_not_reminded():
    m_off = _m("SS-EQ-9902", active=False, han_kiem_dinh=T)
    plans = [_p(1, code="SS-EQ-9902", every=1, last=T - timedelta(days=5)),
             _p(2, every=1, last=T - timedelta(days=5), active=False)]
    assert cmms.due_items(plans, [_m(), m_off], T) == []


def test_downtime_and_incomplete():
    s = datetime(2026, 12, 20, 9, 0, tzinfo=cmms.VN)
    assert cmms.downtime_minutes(s, s.replace(hour=10, minute=15)) == 75
    with pytest.raises(ValueError):
        cmms.downtime_minutes(s, s - timedelta(minutes=1))
    ms = [_m(f"SS-EQ-99{i:02d}") for i in range(12)]
    ms[5]["maker"] = None
    assert cmms.incomplete(ms) == [{"code": "SS-EQ-9905", "missing": ["maker"]}]
    flagged = _m(thuoc_dien_kiem_dinh=True, la_phuong_tien_do=True)
    assert cmms.incomplete([flagged])[0]["missing"] == ["han_kiem_dinh",
                                                          "han_hieu_chuan"]


# --- CLI validate trước connect --------------------------------------------
@pytest.fixture
def no_connect(monkeypatch):
    def boom():
        raise AssertionError("connect không được gọi")
    monkeypatch.setattr(cmms, "connect", boom)


@pytest.mark.parametrize("argv", [
    ["--due", "--incomplete"],
    [],
    ["--due", "--now", "2026-13-01"],
    ["--due", "--horizon", "-1"],
    ["--add-machine", "--code", "SS-EQ-1", "--name", "x"],
    ["--add-machine", "--code", "ss-eq-01; drop", "--name", "x"],
    ["--add-machine", "--code", "SS-EQ-9901", "--name", "x", "--year", "1800"],
    ["--add-plan", "--code", "SS-EQ-9901", "--task", "x", "--every-days", "0"],
    ["--done", "1", "--on", "2099-01-01", "--by", "NV01"],  # tương lai (hôm nay thật)
    # --now chỉ đi với --due: op ghi kèm --now → exit 2 (chặn đẩy hạn 2099)
    ["--done", "1", "--on", "2099-01-01", "--by", "NV01", "--now", "2099-01-01"],
    ["--done", "1", "--on", "2026-10-01", "--by", "NV01", "--now", "2026-10-12"],
    ["--add-plan", "--code", "SS-EQ-9901", "--task", "x", "--every-days", "30",
     "--now", "2026-11-25"],
    ["--add-machine", "--code", "SS-EQ-9901", "--name", "x", "--now", "2026-12-20"],
    ["--incomplete", "--now", "2026-12-20"],
    ["--done", "1", "--on", "2026-12-01", "--by", "Nguyen Van A"],
    ["--incident", "--code", "SS-EQ-9901", "--start", "2026-12-20T10:00",
     "--end", "2026-12-20T09:00", "--by", "NV01"],
    ["--incident", "--code", "SS-EQ-9901", "--start", "hôm qua", "--by", "NV01"],
])
def test_bad_args_exit2_before_connect(no_connect, argv):
    with pytest.raises(SystemExit) as e:
        cmms.main(argv)
    assert e.value.code == 2


@pytest.fixture
def fixed_today(monkeypatch):
    """Op ghi so với hôm nay THẬT (`today_vn`) — test cố định bằng monkeypatch,
    không qua --now (cold-check v9.5: --now từng mở khóa --on tương lai)."""
    day = {"d": date(2026, 12, 20)}
    monkeypatch.setattr(cmms, "today_vn", lambda: day["d"])
    return day


def test_done_on_future_vs_real_today(no_connect, fixed_today):
    with pytest.raises(SystemExit) as e:
        cmms.main(["--done", "1", "--on", "2026-12-21", "--by", "NV01"])
    assert e.value.code == 2
    a = cmms.parse_args(["--done", "1", "--on", "2026-12-20", "--by", "NV01"])
    assert a.on == a.today == date(2026, 12, 20)


def test_add_machine_cert_flags_without_date():
    class C:
        params = None

        def execute(self, sql, params=()):
            C.params = params

        def commit(self):
            pass
    a = cmms.parse_args(["--add-machine", "--code", "SS-EQ-9901", "--name",
                         "MẪU", "--kiem-dinh", "--phuong-tien-do"])
    cmms.run(a, C())
    assert C.params[5:9] == (True, None, True, None)
    a = cmms.parse_args(["--add-machine", "--code", "SS-EQ-9901", "--name",
                         "MẪU", "--hieu-chuan-han", "2027-01-01"])
    cmms.run(a, C())
    assert C.params[5:9] == (False, None, True, date(2027, 1, 1))


def test_now_str_parsed_and_naive_is_vn():
    a = cmms.parse_args(["--due", "--now", "2026-12-20"])
    assert a.today == date(2026, 12, 20)
    a = cmms.parse_args(["--incident", "--code", "SS-EQ-9901", "--start",
                         "2026-12-20T09:00", "--end", "2026-12-20T10:15",
                         "--by", "NV01"])
    assert a.start.utcoffset() == timedelta(hours=7)


class _FakeConn:
    """Plan #7 major; đếm execute ghi (update/insert)."""

    def __init__(self, major=True, gmp=False):
        self.row, self.writes, self.closed = (major, gmp), [], False

    def execute(self, sql, params=()):
        if re.match(r"\s*(update|insert|delete)", sql, re.IGNORECASE):
            self.writes.append(sql)
        row = self.row
        return type("R", (), {"fetchone": staticmethod(lambda: row),
                              "rowcount": 1})()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed = True


@pytest.mark.parametrize("major,gmp", [(True, False), (False, True)])
def test_done_major_or_gmp_requires_approver(monkeypatch, major, gmp, capsys,
                                            fixed_today):
    fc = _FakeConn(major, gmp)
    monkeypatch.setattr(cmms, "connect", lambda: fc)
    argv = ["--done", "7", "--on", "2026-12-01", "--by", "NV01"]
    assert cmms.main(argv) == 2
    assert fc.writes == [] and fc.closed
    assert "KHÔNG ghi" in capsys.readouterr().out
    assert cmms.main(argv + ["--approved-by", "MAU-ky-su"]) == 0
    assert len(fc.writes) == 1


def test_no_delete_machine_in_module():
    src = (ROOT / "agents" / "cmms.py").read_text(encoding="utf-8")
    assert not re.search(r"delete\s+from\s+machines", src, re.IGNORECASE)


# --- DB thật: schema tạm + rollback -------------------------------------------
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


class _NoClose:
    def __init__(self, c):
        self._c = c

    def __getattr__(self, n):
        return getattr(self._c, n)

    def commit(self):
        pass  # giữ trong tx test — rollback cuối test bỏ hết

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_cmms_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)  # idempotent ×2
        yield conn
    finally:
        conn.rollback()
        conn.close()


def test_db_full_cycle(db, monkeypatch, capsys, fixed_today):
    monkeypatch.setattr(cmms, "connect", lambda: _NoClose(db))
    assert cmms.main(["--add-machine", "--code", "SS-EQ-9901", "--name",
                      "Máy co màng MẪU", "--location", "xưởng MẪU", "--maker",
                      "MẪU", "--year", "2019", "--kiem-dinh-han", "2027-01-10"]) == 0
    assert cmms.main(["--add-machine", "--code", "SS-EQ-9902", "--name",
                      "Máy thiếu hồ sơ MẪU"]) == 0
    # thuộc diện kiểm định/phương tiện đo nhưng CHƯA biết hạn → báo thiếu hạn
    assert cmms.main(["--add-machine", "--code", "SS-EQ-9904", "--name",
                      "Cân MẪU", "--location", "xưởng MẪU", "--maker", "MẪU",
                      "--year", "2021", "--kiem-dinh", "--phuong-tien-do"]) == 0
    fixed_today["d"] = date(2026, 11, 25)
    assert cmms.main(["--add-plan", "--code", "SS-EQ-9901", "--task",
                      "kiểm tra dây đai MẪU", "--every-days", "30"]) == 0
    fixed_today["d"] = date(2026, 12, 20)
    pid = db.execute("select id from maintenance_plans where machine_code ="
                     " 'SS-EQ-9901'").fetchone()[0]
    assert cmms.main(["--incident", "--code", "SS-EQ-9901", "--start",
                      "2026-12-20T09:00", "--end", "2026-12-20T10:15", "--by",
                      "NV01", "--desc", "gọi 0901234567 báo kẹt màng MẪU"]) == 0
    assert cmms.main(["--incident", "--code", "SS-EQ-9901", "--start",
                      "2026-12-20T11:00", "--by", "NV01"]) == 0
    capsys.readouterr()
    assert cmms.main(["--due", "--now", "2026-12-20"]) == 0
    out = capsys.readouterr().out
    assert f"plan #{pid}" in out and "hạn 2026-12-25" in out
    assert "kiem_dinh" in out and "hạn 2027-01-10" in out
    assert "0901234567" not in out and "kẹt màng" not in out
    assert cmms.main(["--incomplete"]) == 0
    out = capsys.readouterr().out
    assert "SS-EQ-9902: thiếu maker, year, location" in out
    assert "SS-EQ-9904: thiếu han_kiem_dinh, han_hieu_chuan" in out
    rows = db.execute("select downtime_phut, part, root_cause from downtime_log"
                      " where machine_code = 'SS-EQ-9901'").fetchall()
    assert rows == [(75, None, "chờ xác nhận")]
    desc = db.execute("select description from incidents where downtime_phut"
                      " = 75").fetchone()[0]
    assert "0901234567" not in desc
    assert db.execute("select count(*) from incidents where ended_at is null"
                      " and downtime_phut is null").fetchone()[0] == 1
    assert cmms.main(["--done", str(pid), "--on", "2026-12-20", "--by",
                      "NV02"]) == 0
    assert db.execute("select last_done_on, last_done_by from maintenance_plans"
                      " where id = %s", (pid,)).fetchone() == (date(2026, 12, 20),
                                                              "NV02")
    assert cmms.main(["--retire", "SS-EQ-9901"]) == 0
    capsys.readouterr()
    assert cmms.main(["--due", "--now", "2026-12-20"]) == 0
    assert "0 việc" in capsys.readouterr().out


def test_db_reported_by_check_and_code_check(db):
    db.execute("insert into machines (code, name) values ('SS-EQ-9903', 'MẪU')")
    # savepoint trong raises: lỗi rollback savepoint, tx ngoài còn dùng được
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("insert into incidents (machine_code, started_at,"
                   " reported_by) values ('SS-EQ-9903', now(), 'Nguyen A')")
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("insert into machines (code, name) values ('EQ-1', 'x')")
    assert db.execute("select count(*) from machines").fetchone()[0] == 1


def test_incident_part_and_desc_masked():
    class C:
        def __init__(self):
            self.params = None

        def execute(self, sql, params=()):
            self.params = params
            return type("R", (), {"fetchone": staticmethod(lambda: (1,))})()

        def commit(self):
            pass
    c = C()
    s = datetime(2026, 12, 20, 9, 0, tzinfo=cmms.VN)
    cmms.add_incident(c, code="SS-EQ-9901", start=s, end=None, by="NV01",
                      part="dao cắt gọi 0901234567", desc="mail a.b@x.vn MẪU")
    assert "0901234567" not in c.params[4] and "a.b@x.vn" not in c.params[5]
    assert c.params[3] is None  # sự cố mở: downtime NULL
