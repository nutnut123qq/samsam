"""v4.4 W44.1 — scripts/review_load.py (PC-A0): tải hàng duyệt so với quota.

Unit thuần (load_quota/cap_for/CLI exit 2 trước connect) + DB THẬT (schema
tạm + `set local search_path` + docs/schema.sql + ROLLBACK — mẫu fixture
`db` của test_auth_approval). Skip khi không có DB — gate yêu cầu 0 skipped.
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import review_load

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
QUOTA = review_load.load_quota(ROOT / "data" / "review_quota.json")
UTC = timezone.utc
SHA = "a" * 64


def _write(tmp_path, obj, name="q.json"):
    p = tmp_path / name
    p.write_bytes(obj if isinstance(obj, bytes)
                  else json.dumps(obj).encode("utf-8"))
    return p


def _phases(*ph):
    return {"status": "de_xuat", "phases": list(ph), "absent_days": []}


# ---------------------------------------------------------------- load_quota
@pytest.mark.parametrize("bad", [
    b"{not json",
    b"\xff\xfe",
    json.dumps([]).encode(),
    json.dumps({"phases": []}).encode(),
    json.dumps(_phases({"from": "2026-13-01", "to": None,
                        "daily_cap": 5})).encode(),
    json.dumps(_phases({"from": "2026/10/01", "to": None,
                        "daily_cap": 5})).encode(),
    json.dumps(_phases({"from": "2026-10-01", "to": None,
                        "daily_cap": -1})).encode(),
    json.dumps(_phases({"from": "2026-10-01", "to": None,
                        "daily_cap": "25"})).encode(),
    json.dumps(_phases({"from": "2026-10-01", "to": None,
                        "daily_cap": True})).encode(),
    json.dumps(_phases({"from": "2026-10-01", "to": "2026-10-20",
                        "daily_cap": 5},
                       {"from": "2026-10-20", "to": None,
                        "daily_cap": 6})).encode(),
    json.dumps(_phases({"from": "2026-10-01", "to": None, "daily_cap": 5},
                       {"from": "2026-12-01", "to": None,
                        "daily_cap": 6})).encode(),
    json.dumps(_phases({"from": "2026-10-10", "to": "2026-10-01",
                        "daily_cap": 5})).encode(),
    json.dumps({**_phases({"from": "2026-10-01", "to": None,
                           "daily_cap": 5}),
                "absent_days": ["hôm nay"]}).encode(),
], ids=["json-hong", "khong-utf8", "khong-object", "phases-rong",
        "ngay-sai", "ngay-sai-dinh-dang", "cap-am", "cap-str", "cap-bool",
        "chong-bien", "chong-mo", "to-truoc-from", "absent-sai"])
def test_load_quota_rejects(tmp_path, bad):
    with pytest.raises(ValueError):
        review_load.load_quota(_write(tmp_path, bad))


def test_load_quota_missing_file(tmp_path):
    with pytest.raises(ValueError):
        review_load.load_quota(tmp_path / "khong-co.json")


def test_repo_quota_is_proposal():
    assert QUOTA["status"] == "de_xuat"
    assert [p[2] for p in QUOTA["phases"]] == [25, 35, 55]


# ---------------------------------------------------------------- cap_for
@pytest.mark.parametrize("day,cap", [
    (date(2026, 10, 31), 25), (date(2026, 11, 1), 35),
    (date(2026, 11, 15), 35), (date(2026, 11, 16), 55),
    (date(2027, 6, 1), 55), (date(2026, 9, 30), None)])
def test_cap_for_boundaries(day, cap):
    assert review_load.cap_for(day, QUOTA) == cap


def test_cap_for_absent_is_zero(tmp_path):
    raw = json.loads((ROOT / "data" / "review_quota.json").read_text("utf-8"))
    raw["absent_days"] = ["2026-10-12"]
    q = review_load.load_quota(_write(tmp_path, raw))
    assert review_load.cap_for(date(2026, 10, 12), q) == 0
    assert review_load.cap_for(date(2026, 10, 13), q) == 25


# ---------------------------------------------------------------- CLI exit 2
def _no_connect(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("không được connect DB khi tham số sai")
    monkeypatch.setattr(review_load.lead_store, "connect", boom)


@pytest.mark.parametrize("argv", [
    ["--today", "2026-13-01"], ["--today", "12/10/2026"], ["--days", "0"],
    ["--days", "367"], ["--today", "2026-09-01"]])
def test_cli_usage_exit2_before_connect(monkeypatch, capsys, argv):
    _no_connect(monkeypatch)
    assert review_load.main(argv) == 2
    assert "[err]" in capsys.readouterr().err


def test_cli_bad_quota_exit2(monkeypatch, tmp_path, capsys):
    _no_connect(monkeypatch)
    p = _write(tmp_path, b"{")
    assert review_load.main(["--quota", str(p), "--today",
                             "2026-10-12"]) == 2


def test_cli_db_none_exit1(monkeypatch, capsys):
    monkeypatch.setattr(review_load.lead_store, "connect", lambda: None)
    assert review_load.main(["--today", "2026-10-12"]) == 1
    assert "DB không truy cập được" in capsys.readouterr().err


def test_cli_missing_table_exit1(monkeypatch, capsys):
    class C:
        closed = False

        def execute(self, *a, **k):
            raise psycopg.errors.UndefinedTable("relation does not exist")

        def close(self):
            C.closed = True
    monkeypatch.setattr(review_load.lead_store, "connect", lambda: C())
    assert review_load.main(["--today", "2026-10-12"]) == 1
    assert C.closed


# ---------------------------------------------------------------- render thuần
def _stats(queue_total=0, tp=None, inflow=None, days=7):
    return {"today": date(2026, 10, 12), "days": days,
            "start": date(2026, 10, 6),
            "queue": {"vao_hang": queue_total, "tra_tac_gia": 0,
                      "khong_ro": 0},
            "queue_total": queue_total, "oldest_age_days": None,
            "inflow": inflow or {}, "throughput": tp or {}}


def test_render_absent_and_inflow(tmp_path):
    raw = json.loads((ROOT / "data" / "review_quota.json").read_text("utf-8"))
    raw["absent_days"] = ["2026-10-12"]
    raw["status"] = "chot"
    q = review_load.load_quota(_write(tmp_path, raw))
    out = review_load.render(_stats(3), q, date(2026, 10, 12))
    assert "người duyệt vắng" in out and "không ai được duyệt thay" in out
    assert "ĐỀ XUẤT" not in out
    out = review_load.render(
        _stats(0, inflow={date(2026, 10, 12): 26 * 7}), QUOTA,
        date(2026, 10, 12))
    assert "nháp vào nhanh hơn trần" in out and "không hạ chuẩn" in out
    out = review_load.render(_stats(25), QUOTA, date(2026, 10, 12))
    assert "QUÁ TẢI" not in out and "Không có cảnh báo tải." in out


# ---------------------------------------------------------------- fake-conn RO
class _Rec:
    def __init__(self):
        self.sql = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        rows = []
        if "content_drafts where status" in sql:
            rows = [("vao_hang", 2, date(2026, 10, 10))]

        class R:
            def fetchall(self_inner):
                return rows
        return R()


def test_collect_read_only_fake_conn():
    c = _Rec()
    s = review_load.collect(c, date(2026, 10, 12), 7)
    assert len(c.sql) == 3
    for q in c.sql:
        assert q.lstrip().lower().startswith(("select", "with")), q
        for w in ("insert", "update ", "delete", "drop", "alter",
                  "truncate", "set_status"):
            assert w not in q.lower(), (w, q)
    assert s["queue_total"] == 2 and s["oldest_age_days"] == 2


# ---------------------------------------------------------------- DB thật
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
        # Session TZ của DB dev là Asia/Bangkok (+7 = VN) -> `::date` không
        # có `at time zone` vẫn ra ngày VN, test biên ngày pass ảo. Ép UTC
        # (server prod/cloud thường UTC) để chỉ code đổi giờ VN mới đúng.
        conn.execute("set local timezone = 'UTC'")
        schema = f"t_rload_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _draft(conn, ok, status="pending", created=None):
    g = {"violations": [], "matched_claims": []}
    if ok is not None:
        g["ok"] = ok
    conn.execute(
        "insert into content_drafts (created_at, brief, channel, text,"
        " guardrail, status, source) values (%s, 'BRIEF_BI_MAT', 'facebook',"
        " 'TEXT_BI_MAT', %s, %s, 'cli')",
        (created or datetime(2026, 10, 12, 2, 0, tzinfo=UTC), Jsonb(g),
         status))


def _appr(conn, who, at, decision="approved"):
    conn.execute(
        "insert into approvals (object_type, object_id, content_sha256,"
        " decision, approved_by, approved_at) values"
        " ('content_draft', '1', %s, %s, %s, %s)", (SHA, decision, who, at))


def _seed(conn):
    for i in range(26):
        # 1 mục cũ: 17:30 UTC 07/10 = 00:30 VN 08/10 -> tuổi 4 + inflow ngày
        # 08 CHỈ đúng khi tính ngày VN (ngày UTC = 07 -> tuổi 5, inflow 07) —
        # chặn mutation bỏ `at time zone` khỏi SQL_QUEUE/SQL_INFLOW.
        _draft(conn, True, created=datetime(2026, 10, 7, 17, 30, tzinfo=UTC)
               if i == 0 else None)
    # Biên đầu cửa sổ inflow (start = 06/10 VN); status approved -> không
    # vào hàng chờ. 16:30 UTC 05/10 = 23:30 VN 05/10 (NGOÀI cửa sổ);
    # 17:30 UTC 05/10 = 00:30 VN 06/10 (ngày đầu cửa sổ).
    _draft(conn, True, status="approved",
           created=datetime(2026, 10, 5, 16, 30, tzinfo=UTC))
    _draft(conn, True, status="approved",
           created=datetime(2026, 10, 5, 17, 30, tzinfo=UTC))
    for _ in range(3):
        _draft(conn, False)
    _draft(conn, None)
    for st in ("approved", "approved", "rejected", "rejected"):
        _draft(conn, True, status=st)
    d11 = datetime(2026, 10, 11, 3, 0, tzinfo=UTC)
    for i in range(24):
        _appr(conn, "REVIEWER_A", d11, "rejected" if i % 5 == 0 else "approved")
    _appr(conn, "  REVIEWER_A ", d11)           # btrim gộp cùng người
    # 16:30 UTC 11/10 = 23:30 VN 11/10 -> tính ngày 11.
    _appr(conn, "REVIEWER_A", datetime(2026, 10, 11, 16, 30, tzinfo=UTC))
    # 17:30 UTC 11/10 = 00:30 VN 12/10 -> tính ngày 12.
    _appr(conn, "REVIEWER_A", datetime(2026, 10, 11, 17, 30, tzinfo=UTC))
    for _ in range(5):
        _appr(conn, "REVIEWER_B", datetime(2026, 10, 10, 4, 0, tzinfo=UTC))
    _appr(conn, "REVIEWER_B", datetime(2026, 10, 1, 4, 0, tzinfo=UTC))


def _counts(conn):
    return tuple(conn.execute(f"select count(*) from {t}").fetchone()[0]
                 for t in ("content_drafts", "approvals"))


def test_collect_and_render_fixture(db):
    _seed(db)
    before = _counts(db)
    today = date(2026, 10, 12)
    s = review_load.collect(db, today, 7)
    assert _counts(db) == before
    assert s["queue"] == {"vao_hang": 26, "tra_tac_gia": 3, "khong_ro": 1}
    assert s["queue_total"] == 27
    assert s["oldest_age_days"] == 4
    assert s["start"] == date(2026, 10, 6)
    # Ngày 05 (23:30 VN) ngoài cửa sổ; 06 (00:30 VN) trong — theo giờ VN.
    assert s["inflow"] == {date(2026, 10, 6): 1, date(2026, 10, 8): 1,
                           date(2026, 10, 12): 33}
    assert s["throughput"] == {
        date(2026, 10, 10): {"REVIEWER_B": 5},
        date(2026, 10, 11): {"REVIEWER_A": 26},
        date(2026, 10, 12): {"REVIEWER_A": 1}}
    out = review_load.render(s, QUOTA, today)
    assert "QUÁ TẢI: hàng chờ 27 mục > trần 25/ngày — cần ≥ 2 ngày" in out
    assert ("QUÁ TẢI: REVIEWER_A 26 quyết định ngày 2026-10-11 > trần 25"
            in out) and "rủi ro duyệt vội" in out
    assert "REVIEWER_B 5 quyết định" not in out
    assert "nháp vào nhanh hơn trần" not in out      # TB 35/7 < 25
    assert "Quota ĐỀ XUẤT, chưa TGĐ chốt" in out
    assert "trả tác giả 3" in out and "KHÔNG RÕ 1" in out
    assert "BI_MAT" not in out                         # không in text/brief


def test_cli_against_fixture(db, monkeypatch, capsys):
    _seed(db)

    class _NoClose:
        def __init__(self, c):
            self.c = c

        def execute(self, *a, **k):
            return self.c.execute(*a, **k)

        def close(self):
            pass
    monkeypatch.setattr(review_load.lead_store, "connect",
                        lambda: _NoClose(db))
    assert review_load.main(["--today", "2026-10-12", "--days", "7"]) == 0
    out = capsys.readouterr().out
    assert "cần ≥ 2 ngày" in out and "REVIEWER_A 26" in out


def test_cli_db_down_exit1_fast():
    """Host chết thật (gotcha v2.0 — không `env -u`): exit 1, không treo."""
    env = dict(os.environ,
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x",
               PYTHONIOENCODING="utf-8")
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "review_load.py"),
         "--today", "2026-10-12"], env=env, capture_output=True,
        timeout=60, cwd=ROOT, check=False)
    assert r.returncode == 1, r.stderr
    assert "DB không truy cập được" in r.stderr.decode("utf-8")


def test_vn_day_boundary_constant():
    # 16:30Z = 23:30 VN cùng ngày; 17:30Z = 00:30 VN ngày sau.
    vn = timezone(timedelta(hours=7))
    assert datetime(2026, 10, 11, 16, 30, tzinfo=UTC).astimezone(vn).day == 11
    assert datetime(2026, 10, 11, 17, 30, tzinfo=UTC).astimezone(vn).day == 12


def test_reviewer_name_control_chars_sanitized():
    """OWASP A09: tên người duyệt chứa ANSI/xuống dòng không chèn được dòng
    giả vào báo cáo; 2 tên trùng sau khi thay -> cộng dồn."""
    esc = chr(27)
    rows = [(date(2026, 10, 11), f"{esc}[31mA", 20),
            (date(2026, 10, 11), f"{chr(10)}[31mA", 7)]

    class C:
        def execute(self, sql, params=None):
            class R:
                def fetchall(self_inner):
                    return rows if "from approvals" in sql else []
            return R()
    s = review_load.collect(C(), date(2026, 10, 12), 7)
    assert s["throughput"] == {date(2026, 10, 11): {"?[31mA": 27}}
    out = review_load.render(s, QUOTA, date(2026, 10, 12))
    assert esc not in out and "QUÁ TẢI: ?[31mA 27" in out
