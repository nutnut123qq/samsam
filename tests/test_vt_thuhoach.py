"""v11.0 W110.2 — VT dự báo thu hoạch & sẵn hàng theo lô (`agents.vt_thuhoach`).

Thuần: luôn khoảng thấp–cơ sở–cao, metadata model/seed/ngày + sha giả định,
byte-identical, nhu cầu = phép cộng độc lập `scenario.project`. DB THẬT trong
schema tạm (schema.sql + roles.sql) → ROLLBACK cuối test.
"""

import copy
import datetime as dt
import json
import re
from pathlib import Path

import pytest

from agents import vt_thuhoach as vt
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import guardrail, scenario
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "vt_thuhoach.py").read_text(encoding="utf-8")
GOLDEN, _ = read_golden(GOLDEN_FILE)
SKUS = GOLDEN["skus"]
HA = vt.load_assumptions()
SA = scenario.load_assumptions()
NOW = dt.datetime(2026, 10, 14, 12, tzinfo=vt.TZ_VN)
TODAY = NOW.date()
HONEY = "mat-ong-sam-120ml-1hu"
PLOTS = [
    {"id": "KV-1", "tree_count": 3000, "planted_year": 2021,
     "status": "active", "source": "manual"},
    {"id": "KV-2", "tree_count": None, "planted_year": 2020,
     "status": "active", "source": "manual"},
    {"id": "KV-3", "tree_count": 1000, "planted_year": 2019,
     "status": "active", "source": "sample:sample_plots.jsonl"},
    {"id": "KV-4", "tree_count": 500, "planted_year": 2015,
     "status": "inactive", "source": "manual"},
    {"id": "KV-5", "tree_count": 800, "planted_year": None,
     "status": "active", "source": "manual"},
]
LOGS = [{"plot_id": "KV-3", "ts": dt.datetime(2026, 9, 1, 3,
                                              tzinfo=dt.timezone.utc),
         "activity": "thu hoạch", "source": "sample:sample_plot_logs.jsonl"}]


def _lot(code, qty, exp, status="passed", sku=HONEY, src="manual"):
    return {"lot_code": code, "sku_key": sku, "mfg_date": dt.date(2026, 1, 1),
            "exp_date": exp, "qty": qty, "intake_status": status,
            "source": src}


LOTS = [_lot("L-A", 40, dt.date(2026, 11, 1)),
        _lot("L-B", 500, dt.date(2027, 6, 1)),
        _lot("L-P", 999, dt.date(2027, 6, 1), status="pending"),
        _lot("L-E", 777, dt.date(2026, 10, 1)),
        _lot("L-F", 555, dt.date(2027, 6, 1), status="failed"),
        _lot("L-R", 50, dt.date(2027, 6, 1),
             sku="ruou-sam-chai-thuy-tinh-500ml")]


@pytest.fixture
def db():
    yield from da_db()


def _meta(**over):
    return {"as_of": "2026-10-14", "generated": "2026-10-14",
            "harvest_sha256": HA["sha256"], "scenario_sha256": "0" * 64,
            "n_plots": 5, "n_logs": 1, "n_lots": 6, "weeks": 13,
            "start": "2026-10-12", "status": "GIẢ ĐỊNH", **over}


def _all():
    h = vt.forecast_harvest(PLOTS, LOGS, HA, now=NOW)
    a = vt.availability(LOTS, SKUS, SA, now=NOW, weeks=13)
    return h, a, vt.render(h, a, _meta())


# ---------------------------------------------------------------- thuần


def test_harvest_always_range_and_rules():
    h = {r["plot_id"]: r for r in vt.forecast_harvest(PLOTS, LOGS, HA,
                                                       now=NOW)}
    assert set(h) == {"KV-1", "KV-2", "KV-3", "KV-5"}      # KV-4 inactive
    r = h["KV-1"]
    assert r["quarter"] == "2026-Q4"
    assert r["low"] <= r["base"] <= r["high"] and r["low"] < r["high"]
    y, s = HA["yield"], HA["survival"]
    assert r["low"] == int(3000 * y["low"] * s["low"] // 1000)
    assert h["KV-2"]["low"] is None and "thiếu dữ liệu" in h["KV-2"][
        "notes"][0] and "tree_count" in h["KV-2"]["notes"][0]
    assert h["KV-5"]["base"] is None and "planted_year" in h["KV-5"][
        "notes"][0]
    assert h["KV-3"]["high"] is None and h["KV-3"]["sample"]
    assert h["KV-3"]["notes"] == ["đã thu hoạch 2026-09-01"]


def test_young_plot_not_forecast_in_horizon():
    young = [{"id": "KV-Y", "tree_count": 100, "planted_year": 2026,
              "status": "active", "source": "manual"}]
    r = vt.forecast_harvest(young, [], HA, now=NOW)[0]
    assert r["low"] is None and "chưa đủ 5 năm" in r["notes"][0]


def test_availability_only_passed_unexpired_and_ranges():
    a = {r["sku_key"]: r for r in vt.availability(LOTS, SKUS, SA, now=NOW)}
    r = a[HONEY]
    assert r["stock"] == 540
    assert [x["lot_code"] for x in r["usable"]] == ["L-A", "L-B"]
    assert r["pending"] == ["L-P"] and r["expired"] == ["L-E"]
    d = r["demand"]
    assert d["low"] <= d["base"] <= d["high"] and d["low"] < d["high"]
    assert a["ruou-sam-chai-thuy-tinh-500ml"]["restricted"]


def test_demand_matches_independent_scenario_sum():
    weeks = 13
    start = scenario.week_start(TODAY)
    sku = next(s for s in SKUS if s["sku_key"] == HONEY)
    exp = {lv: 0 for lv in scenario.LEVELS}
    for ch in scenario.ALL_CHANNELS:
        for row in scenario.project(sku, ch, start, weeks, SA):
            for lv in scenario.LEVELS:
                exp[lv] += row[lv]
    got = next(r for r in vt.availability(LOTS, SKUS, SA, now=NOW,
                                          weeks=weeks) if r["sku_key"] == HONEY)
    assert got["demand"] == exp


def test_stockout_range_and_fefo_near_expiry():
    lots = [_lot("L-1", 100, dt.date(2026, 10, 20)),
            _lot("L-2", 100, dt.date(2027, 6, 1))]
    r = next(x for x in vt.availability(lots, SKUS, SA, now=NOW)
             if x["sku_key"] == HONEY)
    assert r["demand"]["high"] > 200 > r["demand"]["low"] / 2
    so = r["stockout"]
    assert so["earliest"] is not None and so["latest"] is not None
    assert so["earliest"] < so["latest"]          # khoảng, không 1 điểm
    # L-1 hạn 20/10 mà nhu cầu thấp chưa dùng hết 100 trong tuần đầu.
    assert [x["lot_code"] for x in r["near_expiry"]] == ["L-1"]
    big = [_lot("L-9", 10**6, dt.date(2030, 1, 1))]
    r2 = next(x for x in vt.availability(big, SKUS, SA, now=NOW)
              if x["sku_key"] == HONEY)
    assert r2["stockout"] == {"earliest": None, "latest": None}
    assert r2["near_expiry"] == []


def test_fefo_lot_expiring_before_consumed_is_flagged():
    # Lô hạn 1 tuần nữa mà lớn hơn nhu cầu thấp cả kỳ → chắc chắn cận hạn.
    lots = [_lot("L-X", 10**5, TODAY + dt.timedelta(days=7))]
    r = next(x for x in vt.availability(lots, SKUS, SA, now=NOW)
             if x["sku_key"] == HONEY)
    assert [x["lot_code"] for x in r["near_expiry"]] == ["L-X"]


def test_payload_quantity_lines_are_ranges():
    _, _, t = _all()
    qty = [ln for ln in t.splitlines() if " kg" in ln or "đơn vị" in ln]
    assert len(qty) >= 2
    for ln in qty:
        assert re.search(r"\d+–\d+–\d+ (kg|đơn vị)", ln), ln
    assert "KV-2: thiếu dữ liệu (tree_count) — không ước lượng" in t
    assert not re.search(r"KV-2.*\d+–", t)
    assert "KV-3 (MẪU): đã thu hoạch 2026-09-01" in t
    assert "chưa kiểm nhập — không tính sẵn: lô L-P" in t
    assert "hết hạn — không tính: lô L-E" in t
    assert "L-F" not in t and "ruou" not in t
    assert "1 SKU nhóm hạn chế" in t
    assert t.rstrip().endswith(vt.FOOTER)


def test_payload_metadata_and_byte_identical():
    _, _, t1 = _all()
    _, _, t2 = _all()
    assert t1.encode() == t2.encode()
    for k in ("model: vt_thuhoach-rule-v1 + pipelines.scenario.project",
              "seed: 0", "as_of: 2026-10-14", "generated: 2026-10-14"):
        assert k in t1
    assert re.search(r"harvest_assumptions_sha256: [0-9a-f]{64}\n", t1)
    assert re.search(r"scenario_assumptions_sha256: [0-9a-f]{64}\n", t1)
    assert guardrail.check(t1)["ok"] is True


def test_changing_assumption_changes_sha(tmp_path):
    doc = json.loads(vt.HARVEST_FILE.read_bytes())
    doc["yield_g_per_tree"]["high"] += 1
    p = tmp_path / "h.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    assert vt.load_assumptions(p)["sha256"] != HA["sha256"]


@pytest.mark.parametrize("mut", [
    lambda d: d.pop("quarters"), lambda d: d.update(extra=1),
    lambda d: d.update(min_age_years=0), lambda d: d.update(quarters=9),
    lambda d: d.update(version=""),
    lambda d: d["yield_g_per_tree"].update(low=200),
    lambda d: d["survival_rate"].update(high=1.2),
    lambda d: d["survival_rate"].update(low=0),
    lambda d: d["yield_g_per_tree"].update(base="90"),
])
def test_assumptions_fail_closed(tmp_path, mut):
    doc = json.loads(vt.HARVEST_FILE.read_bytes())
    mut(doc)
    p = tmp_path / "h.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(vt.HarvestError):
        vt.load_assumptions(p)


@pytest.mark.parametrize("content", ["", "{}", '{"_doc": "x"}', "{hỏng",
                                     '{"version": NaN}'])
def test_assumptions_empty_variants(tmp_path, content):
    p = tmp_path / "h.json"
    p.write_text(content, encoding="utf-8")
    with pytest.raises(vt.HarvestError):
        vt.load_assumptions(p)


def test_module_no_llm_no_http_no_random():
    assert not re.search(r"llm_gateway|openai|import httpx|import requests|"
                         r"random", SRC)


# ---------------------------------------------------------------- DB


def _use(db, monkeypatch, tmp_path):
    monkeypatch.setattr(vt, "connect", lambda: TxConn(db))
    monkeypatch.setattr(vt, "REPORTS_DIR", tmp_path / "reports")


def _queue(db):
    return db.execute("select block, object_type, status, created_by, risk,"
                      " payload from approval_queue order by id").fetchall()


def _seed(db):
    for p in PLOTS[:3]:
        db.execute("insert into plots (id, tree_count, planted_year, status,"
                   " source) values (%s, %s, %s, %s, %s)",
                   (p["id"], p["tree_count"], p["planted_year"], p["status"],
                    p["source"]))
    db.execute("insert into plot_logs (plot_id, ts, activity, author, source)"
               " values ('KV-1', %s, 'tưới', 'nv01', 'manual:garden')",
               (NOW - dt.timedelta(days=3),))
    db.execute("insert into plot_logs (plot_id, ts, activity, author, source)"
               " values ('KV-3', %s, 'thu hoạch', 'nv01', %s)",
               (LOGS[0]["ts"], LOGS[0]["source"]))
    for lot in LOTS[:4]:
        chk = None if lot["intake_status"] == "pending" else "QC MẪU"
        db.execute(
            "insert into production_lots (lot_code, sku_key, mfg_date,"
            " exp_date, qty, intake_status, checked_by, source) values"
            " (%s, %s, %s, %s, %s, %s, %s, %s)",
            (lot["lot_code"], lot["sku_key"], lot["mfg_date"],
             lot["exp_date"], lot["qty"], lot["intake_status"], chk,
             lot["source"]))


def test_db_submit_pending_then_skipped(db, monkeypatch, tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    _seed(db)
    chained = db.execute("select count(*) from plot_logs where row_hash is"
                         " not null").fetchone()[0]
    assert chained == 1                       # dòng thật vào chuỗi băm
    assert vt.main(["--submit"], now=NOW, generated=NOW.date()) == 0
    q = _queue(db)
    assert len(q) == 1
    assert q[0][:5] == ("farming", "harvest_forecast", "pending", "agent:VT",
                        "medium")
    p = q[0][5]
    assert "KV-1: 2026-Q4 — " in p and "KV-3 (MẪU): đã thu hoạch" in p
    assert "chưa kiểm nhập — không tính sẵn: lô L-P" in p
    assert "dữ liệu dùng: 3 khoảnh · 1 nhật ký thu hoạch · 4 lô" in p
    assert (tmp_path / "reports" / "vt-thu-hoach-2026-10-14.md").read_bytes(
        ).decode() == p
    assert vt.main(["--submit"], now=NOW, generated=NOW.date()) == 0
    assert "skipped" in capsys.readouterr().out
    assert len(_queue(db)) == 1


def test_db_missing_baseline_sku_exit0(db, monkeypatch, tmp_path):
    _use(db, monkeypatch, tmp_path)
    _seed(db)
    doc = json.loads(scenario.ASSUMPTIONS_FILE.read_bytes())
    doc = copy.deepcopy(doc)
    del doc["baseline_units_per_week"][HONEY]
    p = tmp_path / "s.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(vt, "SCEN_FILE", p)
    assert vt.main([], now=NOW, generated=NOW.date()) == 0
    t = (tmp_path / "reports" / "vt-thu-hoach-2026-10-14.md").read_text(
        encoding="utf-8")
    assert "thiếu giả định số bán" in t
    assert _queue(db) == []


def test_db_backdate_generated_is_wall_clock_not_as_of(db, monkeypatch,
                                                     tmp_path):
    """Finding v11.0 MINOR: --date backdate KHONG duoc ghi de `generated`
    (truong audit ngay lap that) — truoc va generated = as_of."""
    _use(db, monkeypatch, tmp_path)
    _seed(db)
    assert vt.main(["--date", "2026-01-01", "--submit"],
                   generated=dt.date(2026, 10, 14)) == 0
    p = _queue(db)[0][5]
    assert "- as_of: 2026-01-01\n" in p and "- generated: 2026-10-14\n" in p


def test_cli_db_down_and_usage(monkeypatch):
    monkeypatch.setattr(vt, "connect", lambda: None)
    assert vt.main([], now=NOW) == 2
    calls = []
    monkeypatch.setattr(vt, "connect", lambda: calls.append(1))
    for argv in (["--weeks", "0"], ["--weeks", "105"], ["--date", "x"]):
        with pytest.raises(SystemExit) as e:
            vt.main(argv)
        assert e.value.code == 2
    assert calls == []


def test_cli_bad_assumptions_exit1_before_connect(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(vt, "connect", lambda: calls.append(1))
    p = tmp_path / "h.json"
    p.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(vt, "HARVEST_FILE", p)
    assert vt.main([], now=NOW) == 1 and calls == []


def test_identifier_newline_cannot_forge_metadata_line():
    lots = [_lot("L-1\n- seed: 42", 10, dt.date(2027, 6, 1))]
    plots = [{**PLOTS[0], "id": "KV-9\n- model: gia"}]
    t = vt.render(vt.forecast_harvest(plots, [], HA, now=NOW),
                  vt.availability(lots, SKUS, SA, now=NOW), _meta())
    assert "\n- seed: 42" not in t and "\n- model: gia" not in t
    assert t.count("\n- seed: ") == 1 and t.count("\n- model: ") == 1
