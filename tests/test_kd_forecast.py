"""v5.4 KD-A10 dự báo mùa — đi qua engine kịch bản chung (`scenario.
project`), luôn khoảng thấp–cơ sở–cao, đối chiếu tồn THIẾU/RỦI RO/THỪA,
chưa có số tồn ≠ 0. Hàm thuần + CLI (DB host chết → vẫn in, exit 1)."""

import datetime as dt
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from agents import kd_forecast as kf
from ingest import golden_store
from ingest.inventory_csv import STALE_NOTE
from pipelines import scenario

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "kd_forecast.py").read_text(encoding="utf-8")
START = dt.date(2026, 10, 12)
RUOU = "ruou-sam-chai-thuy-tinh-500ml"
SAPH = "saphraton-20v"
CELL = re.compile(r"^(\d+)–(\d+)–(\d+)$")


@pytest.fixture(scope="module")
def skus():
    doc, why = golden_store.read_golden(scenario.GOLDEN_FILE)
    assert why is None
    return [s for s in doc["skus"] if isinstance(s, dict)]


@pytest.fixture(scope="module")
def assumptions():
    return scenario.load_assumptions()


def _st(qty, stale=(), sample=False):
    return {"qty": qty, "kho": {}, "stale": list(stale), "sample": sample}


def test_source_uses_shared_engine_only():
    assert re.search(r"from pipelines import [\w, ]*\bscenario\b", SRC)
    assert "scenario.project(" in SRC
    assert not re.search(r"baseline|trend|coef|\* *1\.[0-9]", SRC)
    assert not re.search(r"smtplib|import httpx|import requests|"
                         r"urllib\.request|\.post\(|llm_gateway|openai",
                         SRC)


def test_project_called_per_sku_channel(monkeypatch, skus, assumptions):
    calls = []
    orig = scenario.project

    def spy(*a, **kw):
        calls.append((a[0]["sku_key"], a[1]))
        return orig(*a, **kw)
    monkeypatch.setattr(scenario, "project", spy)
    rows = kf.forecast(skus, {}, START, 13, assumptions)
    assert len(calls) == len(skus) * len(scenario.ALL_CHANNELS)
    assert len(set(calls)) == len(calls) and len(rows) == len(skus)


def test_ranges_monotone_and_sums(skus, assumptions):
    for r in kf.forecast(skus, {}, START, 13, assumptions):
        for d in [*r["channels"].values(), r["sums"]]:
            assert d["low"] <= d["base"] <= d["high"]
        for lv in scenario.LEVELS:
            assert r["sums"][lv] == sum(c[lv] for c in r["channels"].values())


def test_render_every_cell_is_range(skus, assumptions):
    rows = kf.forecast(skus, {}, START, 13, assumptions)
    text = kf.render(rows, START, 13)
    table = [ln for ln in text.splitlines()
             if ln.startswith("| ") and not ln.startswith("| SKU")]
    assert len(table) == len(skus)
    for ln in table:
        cells = [c.strip() for c in ln.strip("|").split("|")][1:]
        assert len(cells) == len(scenario.ALL_CHANNELS) + 1
        for c in cells:
            m = CELL.fullmatch(c)
            assert m, c
            lo, ba, hi = map(int, m.groups())
            assert lo <= ba <= hi
    assert "KHÔNG phải doanh số cam kết" in text


def test_alcohol_online_zero_with_engine_note(skus, assumptions):
    ruou = [s for s in skus if s["sku_key"] == RUOU]
    [r] = kf.forecast(ruou, {}, START, 13, assumptions)
    assert r["channels"]["shopee"] == {"low": 0, "base": 0, "high": 0}
    assert r["notes"]["shopee"] == scenario.NOTE_ALCOHOL
    assert r["channels"]["offline"]["high"] > 0
    text = kf.render([r], START, 13)
    assert f"| {RUOU} | 0–0–0 |" in text
    assert f"{RUOU} × shopee: {scenario.NOTE_ALCOHOL}" in text


def test_stock_warnings(skus, assumptions):
    one = [s for s in skus if s["sku_key"] == SAPH]
    [base] = kf.forecast(one, {}, START, 13, assumptions)
    high = base["sums"]["high"]
    [low] = kf.forecast(one, {SAPH: _st(5)}, START, 13, assumptions)
    assert low["level"] == "low"
    assert "THIẾU CẢ KỊCH BẢN THẤP" in kf.render([low], START, 13)
    [ex] = kf.forecast(one, {SAPH: _st(high + 7)}, START, 13, assumptions)
    t = kf.render([ex], START, 13)
    assert ex["excess"] == 7 and "THỪA: dư 7 so với kịch bản cao" in t
    assert "THIẾU" not in t
    [risk] = kf.forecast(one, {SAPH: _st(high - 1)}, START, 13, assumptions)
    assert "RỦI RO" in kf.render([risk], START, 13)
    [ok] = kf.forecast(one, {SAPH: _st(high)}, START, 13, assumptions)
    t = kf.render([ok], START, 13)
    assert "THỪA" not in t and "THIẾU" not in t and "RỦI RO" not in t


def test_no_stock_is_not_zero(skus, assumptions):
    one = [s for s in skus if s["sku_key"] == SAPH]
    [r] = kf.forecast(one, {"khac": _st(1)}, START, 13, assumptions)
    t = kf.render([r], START, 13)
    assert r["stock"] is None and "chưa có số tồn" in t
    assert "THIẾU" not in t and "THỪA" not in t
    [n] = kf.forecast(one, None, START, 13, assumptions)
    assert "không đối chiếu được tồn" in kf.render([n], START, 13)


def test_stale_and_sample_labels(skus, assumptions):
    one = [s for s in skus if s["sku_key"] == SAPH]
    [r] = kf.forecast(one, {SAPH: _st(10_000, stale=["KHO-A"], sample=True)},
                      START, 13, assumptions)
    t = kf.render([r], START, 13)
    assert STALE_NOTE in t and "KHO-A" in t and "(MẪU)" in t


def test_missing_assumption_raises(skus):
    bad = {"_doc": "x", "status": "GIẢ ĐỊNH", "trend": {"low": 1, "base": 1,
           "high": 1}, "baseline": {}, "events": []}
    one = [s for s in skus if s["sku_key"] == SAPH]
    with pytest.raises(scenario.ScenarioError):
        kf.forecast(one, {}, START, 4, bad)


@pytest.mark.parametrize("w", ["0", "105", "x"])
def test_cli_weeks_out_of_range_exit2(monkeypatch, w):
    calls = []
    monkeypatch.setattr(kf, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        kf.main(["--weeks", w])
    assert e.value.code == 2 and calls == []


def test_cli_unknown_sku_exit1(monkeypatch):
    monkeypatch.setattr(kf, "connect", lambda: None)
    assert kf.main(["--sku", "khong-co"]) == 1


def test_cli_db_none_prints_forecast_exit1(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(kf, "connect", lambda: None)
    monkeypatch.setattr(kf, "REPORTS_DIR", tmp_path)
    assert kf.main(["--start", "2026-10-14", "--weeks", "4", "--sku", SAPH,
                    "--write"]) == 1
    cap = capsys.readouterr()
    assert "[warn] không đối chiếu được tồn" in cap.err
    assert f"| {SAPH} |" in cap.out and "2026-10-12" in cap.out
    f = tmp_path / "kd-forecast-2026-10-12.md"
    assert "không đối chiếu được tồn" in f.read_bytes().decode("utf-8")


def test_cli_with_stock_exit0(monkeypatch, capsys):
    class Conn:
        def close(self):
            pass
    monkeypatch.setattr(kf, "connect", Conn)
    monkeypatch.setattr(kf, "current_stock", lambda c: {SAPH: _st(3)})
    assert kf.main(["--weeks", "4", "--sku", SAPH]) == 0
    assert "THIẾU CẢ KỊCH BẢN THẤP" in capsys.readouterr().out


def test_cli_dead_db_host_no_hang():
    """DB host chết thật (connect_timeout) → vẫn in dự báo + warn, exit 1."""
    env = {**os.environ, "DATABASE_URL":
           "postgresql://u@10.255.255.1:5432/x", "PYTHONIOENCODING": "utf-8"}
    p = subprocess.run([sys.executable, "-m", "agents.kd_forecast",
                        "--weeks", "2", "--sku", SAPH], cwd=ROOT, env=env,
                       capture_output=True, timeout=120, check=False)
    out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
    assert p.returncode == 1, err
    assert "không đối chiếu được tồn" in err and f"| {SAPH} |" in out
