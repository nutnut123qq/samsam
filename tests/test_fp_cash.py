"""v9.1 W91.5 — FP-Cash (`agents.fp_cash`): dòng tiền 13 tuần × thấp/cơ
sở/cao dựng trên `pipelines.scenario.project()` (không engine thứ 2).

Thuần: giả định + cấu hình fixture trong test (KHÔNG phải số thật). DB thật:
schema tạm + rollback (fixture `db` của tests/test_fp_pnl.py) cho tỷ lệ thực
nhận đo từ settlement. Nhánh DB chết: subprocess với `DATABASE_URL` trỏ host
chết (gotcha v2.0/v1.9 — không `env -u`).
"""

import json
import os
import re
import subprocess
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from agents import fp_cash as fc
from agents import fp_pnl as fp
from ingest.settlement_csv import round_half_up
from pipelines import scenario
from tests.test_fp_pnl import FIX, _load_settlement, fpa_conn

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def db():
    yield from fpa_conn()


START = date(2026, 10, 12)          # thứ Hai
LV = ("low", "base", "high")


def _cfg(tmp_path, **over):
    raw = json.loads((ROOT / "data" / "fpa_config.json").read_text(
        encoding="utf-8"))
    cash = raw["cash"]
    cash.update({"fixed_outflows": [], "one_off": [], "min_balance_vnd": 0,
                 "opening_balance_vnd": None})
    cash.update(over)
    p = tmp_path / "fpa.json"
    p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    cfg, why = fc.load_cfg(p)
    assert why is None, why
    return cfg


def _a(base, events=()):
    return scenario.validate_assumptions({
        "status": "GIẢ ĐỊNH TEST", "trend": {"low": 0.8, "base": 1.0,
                                             "high": 1.2},
        "baseline_units_per_week": base, "events": list(events)})


SKUS = {"a-sku": {"sku_key": "a-sku", "category": "tpbvsk",
                  "allowed_channels": ["shopee"]},
        "b-sku": {"sku_key": "b-sku", "category": "food",
                  "allowed_channels": ["shopee"]},
        "ruou-x": {"sku_key": "ruou-x", "category": "alcohol",
                   "allowed_channels": ["shopee"]},
        "no-price": {"sku_key": "no-price", "category": "food",
                     "allowed_channels": ["shopee"]}}
PRICES = {("a-sku", "shopee"): 100_000, ("a-sku", "offline"): 70_000,
          ("b-sku", "shopee"): 50_000, ("ruou-x", "shopee"): 500_000,
          ("ruou-x", "offline"): 350_000}
BASE = {"a-sku": {"shopee": 10, "offline": 5}, "b-sku": {"shopee": 4},
        "ruou-x": {"shopee": 3, "offline": 2}, "no-price": {"shopee": 1},
        "ngoai-golden": {"offline": 2}}


def _run(cfg, base=BASE, opening=None, prices=PRICES):
    return fc.forecast(SKUS, _a(base), prices, fc.net_ratios({}, cfg), cfg,
                       START, opening)


def test_static_no_second_engine():
    src = (ROOT / "agents" / "fp_cash.py").read_text(encoding="utf-8")
    assert re.search(r"from pipelines(\.| import )scenario|scenario\.project",
                     src)
    assert not re.search(r"trend|math\.floor|math\.ceil|events", src)
    assert not re.search(r"smtplib|httpx|requests|urllib|llm_gateway|openai",
                         src)


def test_13_weeks_always_ranges(tmp_path):
    cfg = _cfg(tmp_path, fixed_outflows=[{"name": "luong", "amount_vnd":
                                          3_000_000, "every_weeks": 4,
                                          "first_week": 1}])
    out = _run(cfg)
    assert len(out["weeks"]) == 13 and out["start"] == START
    for i, w in enumerate(out["weeks"]):
        assert w["week_start"] == START + timedelta(weeks=i)
        for k in ("in", "close"):
            assert set(w[k]) == set(LV)
            assert w[k]["low"] <= w[k]["base"] <= w[k]["high"], (i, k)
        assert w["out"] == (3_000_000 if i in (1, 5, 9) else 0)
    assert out["weeks"][0]["in"]["low"] < out["weeks"][0]["in"]["high"]


def test_project_called_once_per_priced_pair(tmp_path, monkeypatch):
    calls = []
    real = scenario.project

    def spy(*a, **kw):
        calls.append((a[0]["sku_key"], a[1]))
        return real(*a, **kw)

    monkeypatch.setattr(scenario, "project", spy)
    out = _run(_cfg(tmp_path))
    assert sorted(calls) == [("a-sku", "offline"), ("a-sku", "shopee"),
                             ("b-sku", "shopee"), ("ruou-x", "offline"),
                             ("ruou-x", "shopee")]
    assert out["pairs"] == 5
    assert out["thieu_gia"] == [("no-price", "shopee")]
    assert out["thieu_sku"] == [("ngoai-golden", "offline")]
    assert "Thiếu giá — loại khỏi dự báo: `no-price` × shopee" in \
        fc.render(out)


def test_lag_shifts_units_into_later_weeks(tmp_path, monkeypatch):
    """Sự kiện ×3 ở tuần START−2 → đơn vị KHÁC nhau theo tuần, nên tiền tuần
    0 chỉ khớp khi engine được gọi với start − lag (bỏ lag → tiền tuần 0 =
    đơn vị tuần START, không có sự kiện → lệch)."""
    cfg = _cfg(tmp_path, payout_lag_weeks={"shopee": 2, "offline": 0,
                                           "tiktok": 2})
    base = {"b-sku": {"shopee": 4}}
    lag_wk = START - timedelta(weeks=2)
    a = _a(base, [{"id": "sale-test", "date": lag_wk.isoformat(),
                   "window": [{"offset": 0, "low": 3, "base": 3,
                               "high": 3}]}])
    starts = []
    real = scenario.project

    def spy(*args, **kw):
        starts.append(args[2])
        return real(*args, **kw)

    monkeypatch.setattr(scenario, "project", spy)
    out = fc.forecast(SKUS, a, PRICES, fc.net_ratios({}, cfg), cfg, START,
                      None)
    assert starts == [lag_wk]
    shifted = real(SKUS["b-sku"], "shopee", lag_wk, 13, a)
    unshifted = real(SKUS["b-sku"], "shopee", START, 13, a)
    assert shifted[0]["events"] == ["sale-test"]
    assert unshifted[0]["events"] == []
    ratio = cfg["net_ratio_default"]["shopee"]

    def money(u, lv):
        return round_half_up(Decimal(u[lv]) * 50_000 * ratio)

    for lv in LV:
        assert shifted[0][lv] != unshifted[0][lv]          # đơn vị khác
        assert money(shifted[0], lv) != money(unshifted[0], lv)
        for i in (0, 2, 5, 12):
            assert out["weeks"][i]["in"][lv] == money(shifted[i], lv), (i, lv)
        # tuần 0 (tiền của tuần có sự kiện) > tuần 2 (tiền của tuần START)
        assert out["weeks"][0]["in"][lv] > out["weeks"][2]["in"][lv]


def test_alcohol_online_zero_from_engine(tmp_path):
    out = _run(_cfg(tmp_path), {"ruou-x": {"shopee": 3}})
    assert out["pairs"] == 1
    assert all(w["in"][lv] == 0 for w in out["weeks"] for lv in LV)


def test_one_off_makes_low_negative_only_those_weeks(tmp_path):
    cfg = _cfg(tmp_path, payout_lag_weeks={"shopee": 0, "offline": 0,
                                           "tiktok": 0},
               net_ratio_default={"shopee": 0.85, "offline": 1.0,
                                  "tiktok": 0.85},
               one_off=[{"name": "nhap-hang", "amount_vnd": 500_000_000,
                         "week_start": "2026-11-18"}])     # thứ Tư tuần 5
    out = _run(cfg, {"a-sku": {"shopee": 1000}})
    w5 = START + timedelta(weeks=5)
    assert [w["out"] for w in out["weeks"]][5] == 500_000_000
    assert out["weeks"][0]["in"] == {"low": 68_000_000, "base": 85_000_000,
                                     "high": 102_000_000}
    lows = [w["close"]["low"] for w in out["weeks"]]
    assert lows[5] == 6 * 68_000_000 - 500_000_000 < 0
    assert out["warn_weeks"] == [w5, w5 + timedelta(weeks=1)]
    assert all(w["close"]["high"] >= 0 for w in out["weeks"])
    text = fc.render(out)
    assert "tuần âm ở kịch bản thấp" in text
    assert f"{w5:%d/%m}, {w5 + timedelta(weeks=1):%d/%m}" in text
    # số dư đầu kỳ thật (nếu có) cộng vào → hết âm
    out = _run(cfg, {"a-sku": {"shopee": 1000}}, opening=100_000_000)
    assert out["warn_weeks"] == [] and fc.NO_OPENING not in out["notes"]


def test_opening_none_noted_and_unverified_sources(tmp_path):
    out = _run(_cfg(tmp_path))
    assert fc.NO_OPENING in out["notes"]
    text = fc.render(out)
    assert "chưa có số dư đầu kỳ thật" in text and "chưa xác minh" in text
    assert "GIẢ ĐỊNH TEST" in text
    data = json.loads(fc.to_json(out))
    assert len(data["weeks"]) == 13 and data["start"] == "2026-10-12"


def test_unit_prices_from_golden(tmp_path):
    cfg = _cfg(tmp_path, unit_price_vnd={"savina-12v": {"offline": 99_000}})
    doc = json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8"))
    pr = fc.unit_prices(doc["skus"], cfg)
    assert pr[("savina-12v", "shopee")] == 159_000
    assert pr[("savina-12v", "offline")] == 99_000           # ghi đè
    assert pr[("saphraton-20v", "offline")] == round_half_up(
        Decimal(299_000) * cfg["offline_price_ratio"])
    assert ("saphraton-40v", "offline") not in pr            # không có list


@pytest.mark.parametrize("over,needle", [
    ({"weeks": 0}, "cash.weeks"),
    ({"payout_lag_weeks": {"shopee": 9}}, "payout_lag_weeks"),
    ({"payout_lag_weeks": {"lazada": 1}}, "payout_lag_weeks"),
    ({"net_ratio_default": {"shopee": 1.2}}, "ngoài 0..1"),
    ({"one_off": [{"name": "x1", "amount_vnd": 5, "week_start":
                   "2026-02-30"}]}, "week_start"),
    ({"fixed_outflows": [{"name": "Lương", "amount_vnd": 5, "every_weeks": 4,
                          "first_week": 0}]}, "fixed_outflows"),
    ({"opening_balance_vnd": "100"}, "opening_balance_vnd"),
])
def test_cfg_validation(tmp_path, over, needle):
    raw = json.loads((ROOT / "data" / "fpa_config.json").read_text(
        encoding="utf-8"))
    raw["cash"].update(over)
    p = tmp_path / "c.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    cfg, why = fc.load_cfg(p)
    assert cfg is None and needle in why


@pytest.mark.parametrize("argv", [
    ["--forecast", "--start", "2026-02-30"], ["--forecast", "--opening",
                                               "abc"], []])
def test_cli_usage_exit2(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(fc, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        fc.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_bad_cfg_exit1_before_connect(monkeypatch, tmp_path, capsys):
    calls = []
    monkeypatch.setattr(fc, "connect", lambda: calls.append(1))
    bad = tmp_path / "c.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", bad)
    assert fc.main(["--forecast"]) == 1
    assert "không connect" in capsys.readouterr().out and calls == []


def test_cli_db_down_json(monkeypatch, capsys):
    monkeypatch.setattr(fc, "connect", lambda: None)
    assert fc.main(["--forecast", "--start", "2026-10-12", "--json"]) == 0
    cap = capsys.readouterr()
    assert "[warn]" in cap.err and len(json.loads(cap.out)["weeks"]) == 13


def test_cli_dead_host_subprocess_exit0():
    env = {**os.environ, "DATABASE_URL": "postgresql://u@10.255.255.1:5432/x",
           "PYTHONIOENCODING": "utf-8"}
    r = subprocess.run([sys.executable, "-m", "agents.fp_cash", "--forecast",
                        "--start", "2026-10-12"], cwd=ROOT, env=env,
                       capture_output=True, timeout=120, encoding="utf-8",
                       errors="replace", check=False)
    assert r.returncode == 0, r.stderr
    assert "[warn]" in r.stderr and "chưa xác minh" in r.stdout
    assert "Traceback" not in r.stderr


def test_db_net_ratio_measured_from_settlement(db, monkeypatch, tmp_path):
    for f in ("settlement_shopee_MAU.csv", "settlement_shopee_multi_MAU.csv"):
        _load_settlement(db, monkeypatch, FIX / f)
    pay, order, n = db.execute(
        "select sum(payout_vnd), sum(order_amount_vnd), count(*) from"
        " settlement_rows where channel = 'shopee'").fetchone()
    m = fc.measure(db, START)
    assert m == {"shopee": (pay, order, n)} and n == 17
    cfg = _cfg(tmp_path)
    nr = fc.net_ratios(m, cfg)
    assert nr["shopee"]["ratio"] == Decimal(pay) / Decimal(order)
    assert nr["shopee"]["note"].startswith("đo từ settlement 17 dòng")
    assert "chưa xác minh" in nr["offline"]["note"]
    # trước kỳ đo (8 tuần) không có dòng → mặc định
    assert fc.measure(db, date(2026, 10, 1)) == {}
    out = fc.forecast(SKUS, _a(BASE), PRICES, nr, cfg, START, None)
    assert any("đo từ settlement 17 dòng" in x for x in out["notes"])
