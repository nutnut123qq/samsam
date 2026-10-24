"""r12 đợt 3 — hồi quy L2, L1, F031-6, G1-L3, G1-L4 (phần không cần DB).

Probe DB thật: `evidence/itacc_r12/harness/probe_dot3.py.txt`.
"""
from datetime import date

import pytest

from agents import kd_catalog as kc
from agents import kd_quote as kq
from agents.report import write_report
from pipelines import rollout

GOLD = {"skus": [
    {"sku_key": "a", "name": "A", "category": "food", "pack_spec": "1",
     "prices": {"shopee": {"list": 1000, "floor": 800}}},
    {"sku_key": "b", "name": "B", "category": "food", "pack_spec": "1",
     "prices": {"shopee": {"list": 2000, "floor": 1500}}},
]}


# ------------------------------------------------------------ L2

def test_approved_golden_keeps_only_approved_db_prices():
    prices = {("a", "shopee"): {"list": {"price": 1234, "approved": True,
                                         "id": 1},
                                "floor": {"price": 900, "approved": False,
                                          "id": 2}},
              ("b", "shopee"): {"list": {"price": 9, "approved": False,
                                         "id": 3}}}
    g = kq.gidx(kq.approved_golden(GOLD, prices))
    assert g["a"]["prices"] == {"shopee": {"list": 1234}}   # floor chưa duyệt
    assert g["b"]["prices"] == {}                            # không JSON
    assert kq._sum_price([("b", 1)], g, "shopee", "list") is None


def test_catalog_excludes_cam_readiness():
    ready = {("a", "shopee"): "TP_THUONG", ("a", "web"): "TP_THUONG",
             ("b", "shopee"): "CAM", ("b", "web"): "TP_THUONG"}
    items, excl = kc.eligible(GOLD, [], ready, ("shopee", "web"))
    assert [i["key"] for i in items] == ["a"]
    assert {"key": "b", "code": "readiness_cam"} in excl
    # thiếu khóa trong map DB = CAM (fail-closed)
    items, _ = kc.eligible(GOLD, [], {}, ("shopee",))
    assert items == []


# ------------------------------------------------------------ F031-6

def test_overdue_section_has_0_30_and_rows_add_up():
    from agents import acc_ar as ar
    es = [{"dealer_code": "D1", "dealer_type": "doanh_nghiep",
           "kind": "phat_sinh", "doc_date": date(2026, 10, 1),
           "due_date": date(2026, 10, 10), "amount_vnd": 1_000_000,
           "row_no": 1},
          {"dealer_code": "D1", "dealer_type": "doanh_nghiep",
           "kind": "phat_sinh", "doc_date": date(2026, 10, 20),
           "due_date": None, "amount_vnd": 5_000_000, "row_no": 2}]
    rows = ar.aging(es, date(2026, 10, 23), 30)
    L = ar.overdue_section(rows, date(2026, 10, 23))
    head = next(x for x in L if x.startswith("| Đại lý"))
    assert "| 0-30 |" in head
    row = next(x for x in L if x.startswith("| `D1`"))
    cells = [c.strip() for c in row.strip("|").split("|")]
    num = [int(c.replace(".", "").replace("đ", "")) for c in cells[1:]]
    assert num[0] == 1_000_000 and sum(num[1:]) == num[0]   # khoản chưa hạn
    #                                                          không vào cột


# ------------------------------------------------------------ G1-L4

def test_write_report_explicit_feature_label_and_gate(monkeypatch, tmp_path):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")
    p = write_report("# X\n", tmp_path, "ceo-2026-W42.md", sample=False,
                     feature="ceo-01")
    first = p.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith("> **CHẠY THỬ") and "ceo-01" in first
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        write_report("# Y\n", tmp_path, "hdtv-2026-09.md", sample=False,
                     feature="ceo-05")
    assert not (tmp_path / "hdtv-2026-09.md").exists()
    # không truyền feature + tiền tố ngoài danh mục → hành vi cũ (không chặn)
    write_report("# Z\n", tmp_path, "khac-1.md", sample=False)


# ------------------------------------------------------------ L1

def test_sales_042_counter_excludes_handoff_without_consent():
    spec = rollout._TABLES["agent_action_log"]
    assert "pii_included" in spec["where"]
    sql, _ = rollout._table_sql({"table": "agent_action_log",
                                 "action": "crm_handoff"}, None, None)
    assert "pii_included' = 'true'" in sql


# ------------------------------------------------------------ G1-L3

def test_opscost_summary_marks_sources(monkeypatch):
    from agents import fp_opscost as fo
    monkeypatch.setattr(fo, "fetch_opex", lambda c, m: [
        {"id": 1, "category": "cloud", "amount_vnd": 0, "service": "x"}])
    monkeypatch.setattr(fo, "fetch_ai_usd", lambda c, m: {})
    monkeypatch.setattr(fo, "fetch_items", lambda c: [])
    cfg = {"usd_vnd": 25000, "threshold_x_vnd": 10**9,
           "budget_vnd": {"cloud": 1, "ads": 1}, "warn_pct": 80,
           "stop_pct": 100}
    s = fo.summary(None, date(2026, 9, 1), cfg, {})
    assert s["co_nguon"] == {"cloud", "tong"}     # ads/ai: 0 dòng ≠ 0đ
