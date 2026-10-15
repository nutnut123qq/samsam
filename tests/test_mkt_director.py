"""v6.0 W60.4–W60.6 — MKT-00 GĐ Marketing: brief vào hàng duyệt (không tự
duyệt), cân tải duyệt (không tự dời), bản tin tuần.

DB thật: schema tạm + docs/schema.sql + docs/roles.sql, ROLLBACK cuối test
(precedent `tests/test_director_framework.py`). Skip khi không có DB —
gate yêu cầu 0 skipped. Không wall-clock, không sleep.
"""

import copy
import inspect
import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import mkt_director as md
from pipelines import director
from pipelines import mkt_calendar as mc
from pipelines.guardrail import check as guardrail_check
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
AW = "agent_writer"
NOW = datetime(2026, 10, 26, 0, 0, tzinfo=VN_TZ)


def _real_plan(start=date(2026, 10, 12), weeks=26):
    cal, golden, sla = mc.load_inputs()
    return mc.build(cal, golden, start, weeks, sla)


# ---------- W60.4 brief ----------

def test_brief_config_not_low_risk():
    spec = director.load_config("marketing")["object_types"]["campaign_brief"]
    assert spec["risk"] != "low" and spec["sla_hours"] == 48
    cfg = director.load_config("marketing")
    assert cfg["approvers"] == [] and cfg["digest_recipients"] == []


def test_brief_text_passes_guardrail():
    plan = _real_plan()
    assert plan["campaigns"]
    for c in plan["campaigns"]:
        text = md.brief_text(c, plan["status"])
        g = guardrail_check(text)
        assert g["ok"] is True, (c["id"], g["violations"])
        assert "ruou-sam-" not in text
        assert "GIẢ ĐỊNH" in text and "marketing_calendar.json" in text
        assert md.brief_text(c, plan["status"]) == text      # tất định
    qb = next(c for c in plan["campaigns"] if c["id"] == "c-tet-2027-qua-bieu")
    assert "1 SKU chỉ bán offline" in md.brief_text(qb)


def test_brief_module_never_decides():
    src = (ROOT / "agents" / "mkt_director.py").read_text(encoding="utf-8")
    import re
    assert not re.search(r"decide\(|auto_approve|override\(|approve_draft|"
                         r"set_status|schedule\(|save_draft|record_publish",
                         src)


class _Res:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class _FakeConn:
    def __init__(self, existing=()):
        self.existing = set(existing)
        self.sql = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        return _Res((1,) if params and params[1] in self.existing else None)


def test_brief_horizon_filter_fake_conn(monkeypatch):
    calls = []

    def fake_submit(conn, block, ot, oid, title, payload, created_by,
                    cfg=None):
        calls.append((block, ot, oid, created_by))
        return 100 + len(calls)

    monkeypatch.setattr(md.director, "submit", fake_submit)
    plan = _real_plan()
    res = md.enqueue_briefs(_FakeConn(), plan, NOW, 14)
    # 26/10 + 14 ngày = 09/11: c-1111 brief 04/11 → có; c-2011 brief 11/11
    # ngoài horizon; c-2010 đã đăng 17/10.
    assert [x["id"] for x in res["enqueued"]] == ["c-1111-2026"]
    assert calls == [("marketing", "campaign_brief", "c-1111-2026",
                      "agent:MKT-00")]
    calls.clear()
    res = md.enqueue_briefs(_FakeConn({"c-1111-2026"}), plan, NOW, 14)
    assert res["enqueued"] == [] and calls == []
    assert res["skipped"][0]["id"] == "c-1111-2026"
    late = datetime(2026, 11, 11, 9, 0, tzinfo=VN_TZ)       # = mốc đăng
    res = md.enqueue_briefs(_FakeConn(), plan, late, 14)
    assert "c-1111-2026" not in [x["id"] for x in res["enqueued"]]
    with pytest.raises(ValueError):
        md.enqueue_briefs(_FakeConn(), plan,
                          datetime(2026, 10, 26), 14)  # noqa: DTZ001


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
        schema = f"t_w60_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def close(self):
        pass


def test_brief_db_idempotent_pending_not_auto(db, tmp_path):
    plan = _real_plan()
    cfg = director.load_config("marketing")
    tx = _TxConn(db)
    db.execute(f"set local role {AW}")
    first = md.enqueue_briefs(tx, plan, NOW, 14, cfg=cfg)
    assert [x["id"] for x in first["enqueued"]] == ["c-1111-2026"]
    count = "select count(*) from approval_queue where object_type =" \
        " 'campaign_brief'"
    n1 = db.execute(count).fetchone()[0]
    again = md.enqueue_briefs(tx, plan, NOW, 14, cfg=cfg)
    assert again["enqueued"] == [] and len(again["skipped"]) == 1
    assert db.execute(count).fetchone()[0] == n1 == 1
    db.execute("reset role")
    rows = db.execute(
        "select status, lane, decided_by, created_by, due_at - created_at,"
        " risk, block, object_id, (guardrail->>'ok') from approval_queue"
        " where object_type = 'campaign_brief'").fetchall()
    for st, lane, by, cb, gap, risk, block, oid, gok in rows:
        assert (st, lane, by, cb) == ("pending", None, None, "agent:MKT-00")
        assert gap == timedelta(hours=48) and risk == "medium"
        assert block == "marketing" and oid == "c-1111-2026"
        assert gok == "true"
    db.execute(f"set local role {AW}")
    path, _ = director.run(tx, "marketing", cfg=cfg, out_dir=tmp_path)
    db.execute("reset role")
    assert path.parent == tmp_path
    assert db.execute(
        "select array_agg(distinct status) from approval_queue where"
        " object_type = 'campaign_brief'").fetchone()[0] == ["pending"]
    assert db.execute("select count(*) from approvals").fetchone()[0] == 0


@pytest.mark.parametrize("decision", ["approved", "rejected"])
def test_brief_db_decided_not_requeued(db, decision):
    """Brief đã được GĐ quyết (approved/rejected) → lần chạy `--briefs`
    sau KHÔNG đẩy lại. Index pending_uq chỉ chặn pending — chốt ở đây
    là `_EXISTING_SQL`. Quyết định đặt bằng owner trong test (mô phỏng
    người duyệt, không phải code agent)."""
    plan = _real_plan()
    cfg = director.load_config("marketing")
    tx = _TxConn(db)
    db.execute(f"set local role {AW}")
    first = md.enqueue_briefs(tx, plan, NOW, 14, cfg=cfg)
    db.execute("reset role")
    assert [x["id"] for x in first["enqueued"]] == ["c-1111-2026"]
    db.execute(
        "update approval_queue set status = %s, lane = 'per_item',"
        " decided_by = 'test:gd_marketing' where object_type ="
        " 'campaign_brief' and object_id = 'c-1111-2026'", (decision,))
    count = "select count(*) from approval_queue where object_type =" \
        " 'campaign_brief'"
    assert db.execute(count).fetchone()[0] == 1
    db.execute(f"set local role {AW}")
    again = md.enqueue_briefs(tx, plan, NOW, 14, cfg=cfg)
    db.execute("reset role")
    assert again["enqueued"] == []
    assert [x["id"] for x in again["skipped"]] == ["c-1111-2026"]
    assert again["skipped"][0]["reason"] == "đã có trong hàng"
    assert db.execute(count).fetchone()[0] == 1
    assert db.execute(
        "select status from approval_queue where object_type ="
        " 'campaign_brief'").fetchone()[0] == decision


def test_bulletin_queue_items_agent_role(db):
    """Bản tin đọc hàng duyệt bằng cột metadata — chạy được dưới
    agent_writer (không quyền payload)."""
    plan = _real_plan()
    tx = _TxConn(db)
    db.execute(f"set local role {AW}")
    md.enqueue_briefs(tx, plan, NOW, 14)
    items = md._queue_items(tx)
    db.execute("reset role")
    assert [(d["object_type"], d["object_id"], d["status"]) for d in items
            ] == [("campaign_brief", "c-1111-2026", "pending")]
    late = datetime(2026, 11, 5, 0, 0, tzinfo=VN_TZ)
    fc = md.forecast_load(plan, md.load_quota(md.DEFAULT_QUOTA), 3,
                          late.date(), 14)
    sec2 = md.bulletin(plan, fc, items, late).split("## 2.")[1]         .split("## 3.")[0]
    assert "c-1111-2026: đã qua mốc brief" not in sec2


def _no_db(*a, **kw):
    pytest.fail("không được connect DB")


def test_brief_cli_dry_run_no_db(monkeypatch, capsys):
    monkeypatch.setattr(md, "connect", _no_db)
    assert md.main(["--briefs", "--today", "2026-10-26", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "c-1111-2026" in out and "không connect DB" in out


def test_brief_cli_db_down_exit_2(monkeypatch, capsys):
    monkeypatch.setattr(md, "connect", lambda: None)
    assert md.main(["--briefs", "--today", "2026-10-26"]) == 2
    assert capsys.readouterr().err.startswith("[err]")


def test_brief_cli_broken_calendar_exit_1(monkeypatch, tmp_path):
    p = tmp_path / "cal.json"
    p.write_bytes(b"{}")
    monkeypatch.setattr(mc, "CALENDAR_FILE", p)
    monkeypatch.setattr(md, "connect", _no_db)
    assert md.main(["--briefs", "--dry-run"]) == 1


# ---------- W60.5 cân tải ----------

def _quota(tmp_path, phases=None, absent=()):
    p = tmp_path / "quota.json"
    p.write_text(json.dumps({
        "status": "de_xuat",
        "phases": phases or [{"from": "2026-10-01", "to": None,
                              "daily_cap": 2}],
        "absent_days": list(absent)}), encoding="utf-8")
    return md.load_quota(p)


def _camp(cid, approve, draft, n_cells=1):
    return {"id": cid, "event": "11.11", "pillar": "p",
            "publish_day": date(2026, 11, 11),
            "milestones": {"brief": draft - timedelta(days=2), "draft": draft,
                           "approve": approve,
                           "publish": datetime(2026, 11, 11, 9,
                                               tzinfo=VN_TZ)},
            "cells": [{"channel": "shopee", "format": "listing",
                       "skus": ["x"], "note": ""}] * n_cells,
            "blocked": [], "dropped": []}


def _fx_plan(n=3, approve=None):
    approve = approve or datetime(2026, 11, 10, 9, tzinfo=VN_TZ)
    draft = datetime(2026, 11, 6, 17, tzinfo=VN_TZ)
    return {"status": "GIẢ ĐỊNH", "campaigns": [
        _camp(f"c-{i}", approve, draft) for i in range(n)],
        "reminders": [], "non_working_days": []}


def test_load_over_quota_warns_and_suggests_no_mutation(tmp_path):
    plan = _fx_plan(3)
    before = copy.deepcopy(plan)
    fc = md.forecast_load(plan, _quota(tmp_path), 5, date(2026, 11, 2), 14)
    assert plan == before                          # không tự dời
    assert "VƯỢT QUOTA phap_che 2026-11-10: 3 mục > trần 2" in fc["warnings"]
    assert any("ĐỀ XUẤT" in s and "2026-11-09" in s
               for s in fc["suggestions"])
    day = next(r for r in fc["days"] if r["day"] == date(2026, 11, 10))
    assert (day["phap_che"], day["cap_phap_che"]) == (3, 2)
    assert next(r for r in fc["days"] if r["day"] == date(2026, 11, 6)
                )["gd_marketing"] == 3


def test_load_gd_cap_and_no_free_day(tmp_path):
    plan = _fx_plan(4)
    fc = md.forecast_load(plan, _quota(tmp_path, phases=[
        {"from": "2026-10-01", "to": None, "daily_cap": 0}]), 2,
        date(2026, 11, 6), 7)
    assert any(w.startswith("VƯỢT QUOTA gd_marketing 2026-11-06")
               for w in fc["warnings"])
    assert any("giảm số ô" in s for s in fc["suggestions"])


def test_load_absent_and_uncovered_days(tmp_path):
    plan = _fx_plan(1)
    fc = md.forecast_load(plan, _quota(tmp_path, absent=["2026-11-10"]), 5,
                          date(2026, 11, 2), 14)
    assert "VƯỢT QUOTA phap_che 2026-11-10: 1 mục > trần 0" in fc["warnings"]
    fc = md.forecast_load(plan, _quota(tmp_path, phases=[
        {"from": "2026-12-01", "to": None, "daily_cap": 9}]), 5,
        date(2026, 11, 2), 14)
    assert any("không có quota" in w.lower() and "2026-11-10" in w
               for w in fc["warnings"])


def test_load_under_cap_no_warning(tmp_path):
    fc = md.forecast_load(_fx_plan(2), _quota(tmp_path), 5,
                          date(2026, 11, 2), 14)
    assert fc["warnings"] == [] and fc["suggestions"] == []


def test_load_counts_cells_and_vn_day(tmp_path):
    golden = copy.deepcopy(mc.load_inputs()[1])
    by = {s["sku_key"]: s for s in golden["skus"]}
    by["saphraton-20v"].update(xnqc_status="approved",
                               allowed_channels=["shopee", "tiktok"])
    cal = json.loads(mc.CALENDAR_FILE.read_text(encoding="utf-8"))
    cal["campaigns"] = [{"id": "c-fx", "event": "11.11",
                         "publish_offset_days": 0,
                         "channels": ["shopee", "tiktok"],
                         "formats": ["listing", "ads"],
                         "skus": ["saphraton-20v"], "pillar": "fx"}]
    plan = mc.build(mc.validate(cal), golden, date(2026, 11, 2), 2, 48)
    assert len(plan["campaigns"][0]["cells"]) == 4
    fc = md.forecast_load(plan, _quota(tmp_path), 5, date(2026, 11, 2), 14)
    day = next(r for r in fc["days"] if r["day"] == date(2026, 11, 10))
    assert day["phap_che"] == 4
    utc = datetime(2026, 11, 9, 23, 30, tzinfo=timezone.utc)   # 10/11 VN
    fc = md.forecast_load(_fx_plan(1, approve=utc), _quota(tmp_path), 5,
                          date(2026, 11, 2), 14)
    got = {r["day"]: r["phap_che"] for r in fc["days"]}
    assert got[date(2026, 11, 10)] == 1 and got[date(2026, 11, 9)] == 0


def test_load_cli_bad_quota_exit_2_before_calendar(monkeypatch, tmp_path):
    bad = tmp_path / "q.json"
    bad.write_bytes(b"{}")
    monkeypatch.setattr(md, "connect", _no_db)

    def no_cal(*a, **kw):
        pytest.fail("không được đọc lịch khi quota hỏng")

    monkeypatch.setattr(mc, "load_inputs", no_cal)
    assert md.main(["--load", "--quota", str(bad)]) == 2
    assert md.main(["--bulletin", "--quota", str(bad)]) == 2


def test_load_cli_real(monkeypatch, capsys):
    monkeypatch.setattr(md, "connect", _no_db)
    assert md.main(["--load", "--today", "2026-11-02", "--days", "14"]) == 0
    out = capsys.readouterr().out
    assert md.NO_AUTO in out and "| T3 10/11 |" in out


def test_load_function_is_pure():
    src = inspect.getsource(md.forecast_load)
    assert "connect" not in src and "execute" not in src


# ---------- W60.6 bản tin ----------

def _bulletin(items, now=NOW, tmp_path=None):
    plan = _real_plan(start=date(2026, 10, 26), weeks=6)
    q = md.load_quota(md.DEFAULT_QUOTA)
    fc = md.forecast_load(plan, q, 3, now.date(), 14)
    return md.bulletin(plan, fc, items, now)


def test_bulletin_db_missing_still_full():
    text = _bulletin(None)
    assert md.DB_MISSING in text
    for h in ("## 1. Chiến dịch 28 ngày tới", "## 2. Việc trễ hạn",
              "## 3. Tải duyệt dự báo", "## 4. SKU bị chặn kênh"):
        assert h in text
    assert "không chi tiền" in text.splitlines()[-1] or \
        "không chi tiền" in text.strip().splitlines()[-1]
    assert "c-1111-2026" in text.split("## 2.")[0]
    head, sec4 = text.split("## 4. SKU bị chặn kênh")
    assert "ruou-sam-" not in head and "ruou-sam-" in sec4
    assert "c-1111-2026" not in sec4


def test_bulletin_overdue_and_missing_brief():
    items = [
        {"id": 7, "object_type": "koc_brief", "object_id": "k1",
         "title": "KOC gọi 0912345678 gấp", "status": "pending",
         "due_at": NOW - timedelta(hours=1)},
        {"id": 8, "object_type": "listing_copy", "object_id": "l1",
         "title": "Listing mới", "status": "pending",
         "due_at": NOW + timedelta(hours=1)},
    ]
    sec2 = _bulletin(items).split("## 2. Việc trễ hạn")[1].split("## 3.")[0]
    assert "#7" in sec2 and "#8" not in sec2
    assert "0912345678" not in sec2
    assert md.DB_MISSING not in sec2
    # c-2010 đã đăng; tại 26/10 chưa chiến dịch nào qua mốc brief
    assert "đã qua mốc brief" not in sec2
    late = datetime(2026, 11, 5, 0, 0, tzinfo=VN_TZ)        # > brief 04/11
    sec2 = _bulletin([], now=late).split("## 2.")[1].split("## 3.")[0]
    assert "c-1111-2026: đã qua mốc brief" in sec2
    has = [{"object_type": "campaign_brief", "object_id": "c-1111-2026",
            "status": "approved"}]
    sec2 = _bulletin(has, now=late).split("## 2.")[1].split("## 3.")[0]
    assert "c-1111-2026" not in sec2


def test_bulletin_cli_db_down_writes_file(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(md, "connect", lambda: None)
    assert md.main(["--bulletin", "--today", "2026-10-14", "--out-dir",
                    str(tmp_path)]) == 0
    p = tmp_path / "mkt-week-2026-10-12.md"
    text = p.read_bytes().decode("utf-8")
    assert md.DB_MISSING in text and md.FOOTER in text
    assert [x.name for x in tmp_path.iterdir()] == [p.name]
    # cùng tuần → cùng tên, ghi đè
    assert md.main(["--bulletin", "--today", "2026-10-16", "--out-dir",
                    str(tmp_path)]) == 0
    assert [x.name for x in tmp_path.iterdir()] == [p.name]


def test_bulletin_cli_db_error_degrades(monkeypatch, tmp_path):
    class Broken:
        def execute(self, *a, **kw):
            raise psycopg.OperationalError("mất kết nối")

        def close(self):
            pass

    monkeypatch.setattr(md, "connect", lambda: Broken())
    assert md.main(["--bulletin", "--today", "2026-10-14", "--out-dir",
                    str(tmp_path)]) == 0
    text = (tmp_path / "mkt-week-2026-10-12.md").read_text(encoding="utf-8")
    assert md.DB_MISSING in text
