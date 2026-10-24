"""r12 đợt 4 — hồi quy G1-L5, G1-L6, D4, D2 (phần không cần DB).

Probe DB thật: `evidence/itacc_r12/harness/probe_dot4.py.txt`.
"""
from datetime import date

import psycopg
import pytest

from pipelines import guardrail as g

AI = "Nội dung có sử dụng AI."


# ------------------------------------------------------------ G1-L5

def test_ceo_decisions_list_prints_waiting(capsys):
    from agents import ceo_decisions as cd
    data = {"decisions": [], "milestones": [
        {"code": "M1", "title": "Ký nghiệm thu", "due_date": date(2026, 11, 1),
         "status": "chua_bat_dau", "owner_role": "tgd",
         "sign_required": True}],
        "waiting_queue": [(7, "weekly_report", "Báo cáo tuần", None)],
        "waiting_rev": []}
    cd._print_list(data, date(2026, 10, 24))
    out = capsys.readouterr().out
    assert "Chờ quyết định" in out and "#7 weekly_report" in out
    assert "Chờ ký" in out and "M1" in out


# ------------------------------------------------------------ G1-L6

def test_combo_missing_approved_price_is_thieu_du_lieu():
    from agents import combo_price as cp
    cfg = {"pcts": [10], "step": 1000, "channels": ["shopee"]}
    prices = {("a", "shopee"): {"list": {"price": 100, "approved": False,
                                         "id": 1}}}
    r = cp.evaluate([("a", 1)], prices, {("a", "shopee")}, [], {}, cfg,
                    "shopee", date(2026, 10, 24))
    assert r["status"] == "thieu_du_lieu"
    r = cp.evaluate([("a", 1)], prices, set(), [], {}, cfg, "shopee",
                    date(2026, 10, 24))
    assert r["status"] == "nhom_han_che"


def test_combo_allowed_set_reads_readiness_not_promotable():
    from agents import combo_price as cp
    seen = []

    class _C:
        def execute(self, sql, *a):
            seen.append(sql)
            return [("a", "shopee")]
    assert cp.allowed_set(_C()) == {("a", "shopee")}
    assert "sku_readiness" in seen[0] and "v_promotable" not in seen[0]


# ------------------------------------------------------------ D4

def test_xnqc_draft_resubmit_skips(monkeypatch, capsys):
    from agents import xnqc

    def dup(*a, **k):
        raise psycopg.errors.UniqueViolation("trùng")
    monkeypatch.setattr(xnqc.director, "submit", dup)

    class _C:
        def rollback(self):
            pass

        commit = rollback

        def execute(self, *a):
            return type("R", (), {"fetchone": lambda s: (41,)})()
    _p, qid = xnqc.draft(_C(), "savina-12v", "maket", "maket fb", None,
                         submit=True)
    assert qid == 41 and "[skip]" in capsys.readouterr().out


# ------------------------------------------------------------ D2

@pytest.mark.parametrize("t", ["Gọi 0900000123 để đặt quà.",
                               "Liên hệ +84 912 345 678.",
                               "Email ban.thu@example.com."])
@pytest.mark.parametrize("ch", ["facebook", "shopee", "zalo", "web"])
def test_publish_blocks_personal_contact(t, ch):
    r = g.check_publish(f"{t} {AI}", channel=ch)
    assert r["ok"] is False
    assert "pii_ca_nhan" in {v["code"] for v in r["violations"]}


@pytest.mark.parametrize("t", ["Hotline 1800577732.",
                               "Showroom 0235 3699 899, vnsamsam@gmail.com.",
                               "Giá 1.500.000 đ từ 23/10/2026, hộp 10 củ.",
                               "Tổng 10.050.000.000 đ."])
def test_publish_keeps_company_contact_price_date(t):
    r = g.check_publish(f"{t} {AI}", channel="facebook")
    assert r["ok"] is True, r["violations"]


def test_chat_check_unchanged_for_phone():
    assert g.check("gọi 0900000123")["ok"] is True
