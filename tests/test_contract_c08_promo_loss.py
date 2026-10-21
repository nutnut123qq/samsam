"""Đợt hợp đồng C08 — finance-04.2 chặn khuyến mãi lỗ (agents.kd_price):
KM nội bộ đã duyệt được kiểm cả khi không có CSV; thiếu giá vốn = không tính
được; KM lỗ/không tính được → mục khối finance (GĐ tài chính) + chống trùng.
DB thật (schema tạm + roles ×2, ROLLBACK)."""

from datetime import date

import pytest

from agents import kd_price as kp
from tests.test_ceo_audit import TxConn, ceo_db

TODAY = date(2026, 10, 20)


@pytest.fixture
def db():
    yield from ceo_db()


def _seed(db):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('c8-a', 'A', 'food', 'manual'), ('c8-b', 'B',"
               " 'food', 'manual')")
    db.execute("set local session_replication_role = replica")   # giá giả
    rows = [("c8-a", "promo", 50000, "P-A", "2026-10-15", None, "GĐ BH"),
            ("c8-b", "promo", 60000, None, "2026-10-01", None, "GĐ BH"),
            ("c8-b", "promo", 10000, "P-CHUA", "2026-10-01", None, None),
            ("c8-b", "promo", 10000, "P-HET", "2026-09-01", "2026-10-10",
             "GĐ BH")]
    for sku, kind, pr, pid, vf, vt, by in rows:
        db.execute("insert into price_list (sku_key, channel, kind,"
                   " price_vnd, program_id, valid_from, valid_to,"
                   " approved_by) values (%s, 'shopee', %s, %s, %s, %s, %s,"
                   " %s)", (sku, kind, pr, pid, vf, vt, by))
    db.execute("set local session_replication_role = origin")


def test_internal_promos_only_approved_and_live(db):
    _seed(db)
    rows = kp.internal_promos(db, TODAY, 45)
    got = sorted((r["sku_key"], r["program_id"], r["price"]) for r in rows)
    assert got[0] == ("c8-a", "P-A", 50000)
    assert got[1][0] == "c8-b" and got[1][1].startswith("PL-")
    assert len(got) == 2                  # chưa duyệt / hết hạn bị bỏ
    csv_row = {**rows[0], "price": 1, "source": "csv"}
    merged = kp.merge_plan([csv_row], rows)
    assert [r["source"] for r in merged if r["program_id"] == "P-A"] == ["csv"]


def _f(kind, oid):
    return {"kind": kind, "severity": kp.SEVERITY[kind], "channel": "shopee",
            "item_id": None, "seller_sku": None, "sku_key": "c8-a",
            "object_id": oid, "program_ids": ["P-A"], "cam": False,
            "label": "đang chạy", "evidence": {
                "program_ids": ["P-A"], "list": 100000, "floor": 40000,
                "after": 50000, "has_cogs": False, "has_net_ratio": True}}


def test_finance_items_and_dedup(db):
    fs = [_f("promo_margin_unknown", "a5:x:1"), _f("promo_over_cap",
                                                    "a5:x:2")]
    items = kp.finance_items(fs)
    assert [i["object_id"] for i in items] == ["fin:a5:x:1"]
    c = TxConn(db)
    assert kp.enqueue_finance(c, fs) == 1
    assert kp.enqueue_finance(c, fs) == 0             # không đẩy lặp
    row = db.execute("select block, object_type, created_by, status from"
                     " approval_queue").fetchone()
    assert row == ("finance", "promo_loss", "agent:kd_price", "pending")


def test_missing_cogs_is_unknown_not_silent():
    gp = {("c8-a", "shopee"): {"list": {"price": 100000, "id": 1,
                                        "approved": True},
                               "floor": {"price": 40000, "id": 2,
                                         "approved": True}}}
    watch = {"channels": ["shopee"], "max_discount_pct": {"shopee": 60},
             "max_stacked_promos": 3, "lookahead_days": 45}
    row = {"row_no": None, "program_id": "P-A", "channel": "shopee",
           "sku_key": "c8-a", "kind": "giam_gia", "start": TODAY,
           "end": TODAY, "pct": None, "price": 50000, "event": None,
           "event_date": None}
    fs = kp.check_promos([row], gp, {("c8-a", "shopee"): "TP_THUONG"},
                         {("c8-a", "shopee")}, [], {"shopee": "0.85"},
                         watch, TODAY)
    assert [f["kind"] for f in fs] == ["promo_margin_unknown"]
    from decimal import Decimal
    cogs = [{"id": 1, "sku_key": "c8-a", "cost_vnd": 60000,
             "valid_from": date(2026, 1, 1), "approved_by": "GĐ TC"}]
    fs = kp.check_promos([row], gp, {("c8-a", "shopee"): "TP_THUONG"},
                         {("c8-a", "shopee")}, cogs,
                         {"shopee": Decimal("0.85")}, watch, TODAY)
    assert [f["kind"] for f in fs] == ["promo_negative_margin"]
