"""Đợt hợp đồng C09 — intel-05 phương án nháp giá combo
(agents/combo_price.py). Thuần + DB thật (schema tạm, ROLLBACK)."""

from datetime import date
from decimal import Decimal

import pytest

from agents import combo_price as cp
from tests.test_ceo_audit import TxConn, ceo_db

TODAY = date(2026, 10, 20)
CFG = {"pcts": [5, 10, 40], "step": 1000, "channels": ["shopee"],
       "status": "GIẢ ĐỊNH", "chot_boi": None}


def _p(lst, floor, approved=True):
    g = {"list": {"price": lst, "id": 1, "approved": approved}}
    if floor is not None:
        g["floor"] = {"price": floor, "id": 2, "approved": True}
    return g


PRICES = {("a", "shopee"): _p(100000, 80000), ("b", "shopee"): _p(50000,
                                                                     40000)}
PROM = {("a", "shopee"), ("b", "shopee")}
COGS = [{"id": 1, "sku_key": "a", "cost_vnd": 70000,
         "valid_from": date(2026, 1, 1), "approved_by": "GĐ TC"},
        {"id": 2, "sku_key": "b", "cost_vnd": 30000,
         "valid_from": date(2026, 1, 1), "approved_by": "GĐ TC"}]
NET = {"shopee": Decimal("0.85")}
ITEMS = [("a", 1), ("b", 2)]           # list 200.000, floor 160.000, vốn 130.000


def test_full_data_options():
    r = cp.evaluate(ITEMS, PRICES, PROM, COGS, NET, CFG, "shopee", TODAY)
    assert (r["base"], r["floor"], r["cost"]) == (200000, 160000, 130000)
    st = {o["pct"]: (o["price"], o["status"]) for o in r["options"]}
    assert st[5] == (190000, "dat")            # 161500 − 130000 > 0
    assert st[10] == (180000, "dat")
    assert st[40] == (120000, "duoi_san")


def test_loss_unknown_missing_restricted():
    cogs_hi = [dict(c, cost_vnd=c["cost_vnd"] * 2) for c in COGS]
    r = cp.evaluate(ITEMS, PRICES, PROM, cogs_hi, NET, CFG, "shopee", TODAY)
    assert {o["status"] for o in r["options"][:2]} == {"lo"}
    r = cp.evaluate(ITEMS, PRICES, PROM, [], NET, CFG, "shopee", TODAY)
    assert {o["status"] for o in r["options"][:2]} == {"khong_tinh_duoc"}
    r = cp.evaluate(ITEMS, {**PRICES, ("b", "shopee"): _p(50000, 40000,
                                                          approved=False)},
                    PROM, COGS, NET, CFG, "shopee", TODAY)
    assert r["status"] == "thieu_du_lieu" and "b" in r["why"]
    r = cp.evaluate(ITEMS, PRICES, {("a", "shopee")}, COGS, NET, CFG,
                    "shopee", TODAY)
    assert r["status"] == "nhom_han_che"


def test_cfg_validation(tmp_path):
    p = tmp_path / "c.json"
    p.write_text('{"muc_giam_pct": [], "lam_tron_vnd": 1000,'
                 ' "channels": ["shopee"]}', encoding="utf-8")
    with pytest.raises(ValueError):
        cp.load_cfg(p)
    assert cp.load_cfg()["pcts"]


@pytest.fixture
def db():
    yield from ceo_db()


def test_db_submit_idempotent_and_rollout(db, monkeypatch):
    from pipelines import rollout
    db.execute("insert into bom_combos (combo_key, name, channels, source)"
               " values ('CB1', 'Hộp quà', '{shopee}', 'sample')")
    db.execute("insert into bom_items (combo_key, sku_key, qty) values"
               " ('CB1', 'a', 1), ('CB1', 'b', 2)")
    monkeypatch.setattr("agents.kd_listing.golden_prices",
                        lambda conn, today: PRICES)
    monkeypatch.setattr("agents.combo_price.fetch_versions", lambda c: COGS)
    monkeypatch.setattr("agents.combo_price.allowed_set",
                        lambda conn: PROM)
    c = TxConn(db)
    recs = cp.propose(c, TODAY, CFG, NET)
    assert [r["status"] for r in recs] == ["de_xuat"]
    assert cp.submit(c, recs) == 1 and cp.submit(c, recs) == 0
    row = db.execute("select block, object_type, created_by, is_sample,"
                     " status from approval_queue").fetchone()
    assert row == ("intel", "combo_price_option", "agent:combo_price", True,
                   "pending")
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)
    with pytest.raises(rollout.RolloutBlocked):
        cp.submit(c, recs)
