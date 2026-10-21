"""Đợt hợp đồng C10 — production-01 tiến độ sản xuất trong bản tin
(production_plans + production_plan_lots, pipelines.production). DB thật
(schema tạm + roles ×2, ROLLBACK)."""

import datetime as dt

import psycopg
import pytest

from pipelines import production as prod
from tests.test_ceo_audit import ceo_db

DAY = dt.date(2026, 10, 20)
NOW = dt.datetime(2026, 10, 20, 9, tzinfo=dt.timezone.utc)


@pytest.fixture
def db():
    yield from ceo_db()


def _lot(db, code, sku, qty, st="pending", src="manual"):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values (%s, 'SKU giả', 'food', 'manual') on conflict do"
               " nothing", (sku,))
    db.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
               " exp_date, qty, intake_status, checked_by, checked_at,"
               " source) values (%s, %s, '2026-10-01', '2027-10-01', %s, %s,"
               " %s, %s, %s)", (code, sku, qty, st,
                                None if st == "pending" else "QA",
                                None if st == "pending" else NOW, src))


def _plan(db, code, sku, qty, start, due, sample=False, by="GĐ SX"):
    db.execute("select production_plan_add_human(%s, %s, %s, %s, %s, null,"
               " %s, %s)", (code, sku, qty, start, due, sample, by))


def _link(db, plan, lot, by="GĐ SX"):
    db.execute("select production_plan_link_human(%s, %s, %s)",
               (plan, lot, by))


def _section(db):
    txt = prod.render_bulletin(prod.collect(db, None), NOW,
                               prod.load_config())
    return txt.split("## Tiến độ sản xuất")[1].split("\n## ")[0]


def test_no_plan_is_missing_data(db):
    _lot(db, "L1", "s1", 10, "passed")
    assert "THIẾU DỮ LIỆU — chưa có kế hoạch" in _section(db)


def test_progress_states(db):
    _lot(db, "A1", "s1", 30, "passed")
    _lot(db, "A2", "s1", 20, "pending")
    _lot(db, "A3", "s1", 5, "failed")
    _lot(db, "B1", "s2", 100, "passed")
    _plan(db, "KH-A", "s1", 100, DAY - dt.timedelta(days=10),
          DAY - dt.timedelta(days=2))
    _plan(db, "KH-B", "s2", 100, DAY - dt.timedelta(days=5),
          DAY + dt.timedelta(days=5))
    _plan(db, "KH-C", "s1", 50, DAY + dt.timedelta(days=3),
          DAY + dt.timedelta(days=20))
    _plan(db, "KH-OLD", "s2", 1, DAY - dt.timedelta(days=90),
          DAY - dt.timedelta(days=60))
    for p, lot in (("KH-A", "A1"), ("KH-A", "A2"), ("KH-A", "A3"),
                   ("KH-B", "B1")):
        _link(db, p, lot)
    sec = _section(db)
    assert ("KH-A · s1 · kế hoạch 100 (2026-10-10→2026-10-18) · đạt 30 (30%)"
            " · chờ kiểm 20 · không đạt 5 · CHẬM — quá hạn 2 ngày") in sec
    assert "KH-B · s2 · kế hoạch 100" in sec and "đạt 100 (100%)" in sec
    assert "· XONG" in sec
    assert "KH-C" in sec and "chưa tới khung" in sec
    assert "KH-OLD" in sec              # chưa xong → vẫn hiện CHẬM


def test_finished_long_ago_hidden(db):
    _lot(db, "F1", "s2", 1, "passed")
    _plan(db, "KH-DONE", "s2", 1, DAY - dt.timedelta(days=90),
          DAY - dt.timedelta(days=60))
    _link(db, "KH-DONE", "F1")
    assert "KH-DONE" not in _section(db)


def test_link_rules_and_append_only(db):
    _lot(db, "X1", "s1", 5)
    _lot(db, "Y1", "s9", 5)
    _plan(db, "KH-X", "s1", 10, DAY, DAY)
    with pytest.raises(psycopg.Error, match="khác SKU"), db.transaction():
        _link(db, "KH-X", "Y1")
    with pytest.raises(psycopg.Error, match="không tồn tại"), \
            db.transaction():
        _link(db, "KH-X", "KHONG")
    _link(db, "KH-X", "X1")
    with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
        _link(db, "KH-X", "X1")
    with pytest.raises(psycopg.Error), db.transaction():
        _plan(db, "KH-Z", "s1", 10, DAY, DAY, by="agent:sx")
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("update production_plans set qty_plan = 1")
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("delete from production_plan_lots")


def test_sample_marked(db):
    _lot(db, "S1", "s1", 5, "passed", src="sample")
    _plan(db, "KH-S", "s1", 5, DAY, DAY)
    _link(db, "KH-S", "S1")
    data = prod.collect(db, None)
    assert data["sample"] is True
    assert "[MẪU]" in _section(db)
