"""v9.2 — `pipelines.production` (Sản xuất P1: SX-A3 phân bổ, SX-A4 BOM,
SX-A5 lô + kiểm nhập, SX-A0 bản tin).

Hàm thuần nhận ngày/giờ làm tham số — test không đọc đồng hồ, không ngủ.
Phần DB thật: schema tạm (docs/schema.sql) trong 1 transaction, ROLLBACK
cuối test; mọi approve/intake thành công CHỈ chạy ở đây (không đánh dấu
người thật đã duyệt trên DB nào khác). Skip khi không có DATABASE_URL.
"""

import copy
import datetime as dt
import hashlib
import json
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

from ingest import inventory_csv as ic
from pipelines import production as prod
from pipelines import scenario

ROOT = Path(__file__).resolve().parent.parent
TODAY = dt.date(2026, 10, 12)
TZ = dt.timezone(dt.timedelta(hours=7))
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json")
                    .read_text(encoding="utf-8"))
SAMPLE_BOM = ROOT / "data" / "sample_bom.json"
SAMPLE_LOTS = ROOT / "data" / "sample_lots.json"
SAMPLE_INV = ROOT / "data" / "sample_inventory.csv"
CHANS = scenario.ALL_CHANNELS
ALCOHOL = ("ruou-sam-chai-thuy-tinh-500ml", "ruou-sam-binh-su-do-500ml")


def _golden(doc=None) -> dict:
    return {s["sku_key"]: s for s in (doc or GOLDEN)["skus"]}


def _write(tmp_path, name, obj) -> Path:
    p = tmp_path / name
    p.write_bytes((obj if isinstance(obj, str)
                   else json.dumps(obj, ensure_ascii=False)).encode("utf-8"))
    return p


def _dem(**base) -> dict:
    """demand tay: kênh -> base; low = base//2, high = base*2."""
    return {c: {"low": base.get(c, 0) // 2, "base": base.get(c, 0),
                "high": base.get(c, 0) * 2, "note": None} for c in CHANS}


# ---------- config ----------

CFG = {"status": "GIẢ ĐỊNH", "cutoffs": [
    {"id": "a", "date": "2026-10-25", "covers_until": "2026-11-15"}],
    "sla_hours": 48, "remind_hours": 24, "near_expiry_days": 90}


def test_config_repo_file():
    cfg = prod.load_config()
    assert "GIẢ ĐỊNH" in cfg["status"]
    dates = {c["date"].isoformat() for c in cfg["cutoffs"]}
    assert dates == {"2026-10-25", "2026-11-01", "2026-11-15", "2026-12-10"}
    assert (cfg["sla_hours"], cfg["remind_hours"]) == (48, 24)
    assert cfg["near_expiry_days"] == 90


def _cfg_variant(kind):
    c = copy.deepcopy(CFG)
    if kind == "dup_id":
        c["cutoffs"].append(dict(c["cutoffs"][0]))
    elif kind == "until_le_date":
        c["cutoffs"][0]["covers_until"] = "2026-10-25"
    elif kind == "remind_ge_sla":
        c["remind_hours"] = 48
    elif kind == "bool_sla":
        c["sla_hours"] = True
    elif kind == "bad_date":
        c["cutoffs"][0]["date"] = "25/10/2026"
    elif kind == "no_status":
        del c["status"]
    elif kind == "near_missing":
        del c["near_expiry_days"]
    elif kind == "near_zero":
        c["near_expiry_days"] = 0
    elif kind == "near_bool":
        c["near_expiry_days"] = True
    elif kind == "near_str":
        c["near_expiry_days"] = "90"
    elif kind == "near_huge":
        c["near_expiry_days"] = prod.MAX_NEAR_DAYS + 1
    return json.dumps(c)


@pytest.mark.parametrize("kind", ["missing", "empty", "broken", "obj_empty",
                                  "only_doc", "dup_id", "until_le_date",
                                  "remind_ge_sla", "bool_sla", "bad_date",
                                  "no_status", "nan", "near_missing",
                                  "near_zero", "near_bool", "near_str",
                                  "near_huge"])
def test_config_variants_rejected(tmp_path, kind):
    text = {"empty": "  \n", "broken": "{\"status\": ", "obj_empty": "{}",
            "only_doc": "{\"_doc\": \"x\"}",
            "nan": json.dumps(CFG).replace("48", "NaN")}.get(kind)
    if kind == "missing":
        p = tmp_path / "nope.json"
    else:
        p = _write(tmp_path, "c.json", text or _cfg_variant(kind))
    with pytest.raises(prod.ProductionError):
        prod.load_config(p)


def test_config_valid_variant(tmp_path):
    cfg = prod.load_config(_write(tmp_path, "c.json", json.dumps(CFG)))
    assert cfg["cutoffs"][0]["covers_until"] == dt.date(2026, 11, 15)


# ---------- SX-A3: demand_for dùng scenario.project (không engine 2) ----------

def test_alloc_no_second_engine_grep():
    src = (ROOT / "pipelines" / "production.py").read_text(encoding="utf-8")
    assert re.search(r"from pipelines import scenario|from pipelines\.scenario "
                     r"import|import pipelines\.scenario", src)
    assert not re.search(r"scenario_assumptions|baseline|trend|"
                         r"lunar_new_year", src)


def test_demand_calls_project_once_per_channel(monkeypatch):
    calls = []

    def spy(sku, channel, start, weeks, assumptions):
        calls.append((sku["sku_key"], channel, start, weeks))
        k = CHANS.index(channel) + 1
        return [{"week_start": start, "events": [], "low": k, "base": 2 * k,
                 "high": 3 * k, "note": None} for _ in range(weeks)]

    monkeypatch.setattr(scenario, "project", spy)
    sku = _golden()["saphraton-20v"]
    d = prod.demand_for(sku, TODAY, dt.date(2026, 11, 15), {"x": 1})
    assert sorted(c for _, c, _, _ in calls) == sorted(CHANS)
    assert len(calls) == len(CHANS)
    weeks = calls[0][3]
    assert weeks == 5      # tuần 12/10 .. tuần chứa 15/11 (thứ Hai 9/11)
    for c in CHANS:
        k = CHANS.index(c) + 1
        assert (d[c]["low"], d[c]["base"], d[c]["high"]) == (
            k * weeks, 2 * k * weeks, 3 * k * weeks)


def test_demand_real_engine_alcohol_online_zero():
    a = scenario.load_assumptions()
    for key in ALCOHOL:
        d = prod.demand_for(_golden()[key], TODAY, dt.date(2026, 11, 15), a)
        assert all(d[c]["high"] == 0 for c in CHANS if c != "offline")
        assert d["offline"]["base"] > 0


def test_demand_too_many_weeks_or_reversed():
    a = scenario.load_assumptions()
    sku = _golden()["savina-12v"]
    with pytest.raises(prod.ProductionError):
        prod.demand_for(sku, TODAY, dt.date(2030, 1, 1), a)
    with pytest.raises(prod.ProductionError):
        prod.demand_for(sku, TODAY, dt.date(2026, 9, 1), a)


def test_alloc_alcohol_zero_online_even_with_fake_demand(monkeypatch):
    def fake(sku, channel, start, weeks, assumptions):
        return [{"week_start": start, "events": [], "low": 5, "base": 10,
                 "high": 20, "note": None}] * weeks

    monkeypatch.setattr(scenario, "project", fake)
    for key in ALCOHOL:
        d = prod.demand_for(_golden()[key], TODAY, dt.date(2026, 11, 15), {})
        assert d["shopee"]["base"] > 0          # demand giả > 0 cho shopee
        a = prod.allocate(100, d, "alcohol")
        for c in CHANS:
            if c == "offline":
                assert a["proposed"][c] > 0
            else:
                assert a["proposed"][c] == 0 and a["demand"][c]["base"] == 0
                assert "rượu" in a["notes"][c]


def test_alloc_plan_rows_alcohol_zero_online_real_category(monkeypatch):
    """Chốt chặn rượu thứ 2 trên ĐƯỜNG THẬT plan_rows → allocate(category
    golden): demand online giả > 0 vẫn đề xuất 0 + ghi chú rượu."""
    def fake(sku, channel, start, weeks, assumptions):
        return [{"week_start": start, "events": [], "low": 5, "base": 10,
                 "high": 20, "note": None}] * weeks

    monkeypatch.setattr(scenario, "project", fake)
    g = _golden()
    skus = [g[k] for k in ALCOHOL]
    assert {s["category"] for s in skus} == {"alcohol"}
    demands = {k: prod.demand_for(g[k], TODAY, dt.date(2026, 11, 15), {})
               for k in ALCOHOL}
    assert all(demands[k]["shopee"]["base"] > 0 for k in ALCOHOL)
    stock = {k: {"qty": 1000, "kho": {}, "stale": [], "sample": False}
             for k in ALCOHOL}
    rows = prod.plan_rows(skus, stock, demands)
    assert len(rows) == len(ALCOHOL) * len(CHANS)
    for r in rows:
        if r["channel"] == "offline":
            assert r["proposed_qty"] > 0
        else:
            assert r["proposed_qty"] == 0 and r["demand_base"] == 0, r
            assert "rượu" in r["note"]


def test_alloc_stock_zero():
    a = prod.allocate(0, _dem(shopee=4, offline=2), "tpbvsk")
    assert set(a["proposed"].values()) == {0}
    assert a["flag_level"] == "low" and "THẤP" in a["flag"]


def test_alloc_stock_below_base_largest_remainder_tie_order():
    a = prod.allocate(7, _dem(shopee=3, tiktok=3, offline=3), "tpbvsk")
    assert sum(a["proposed"].values()) == 7
    assert (a["proposed"]["shopee"], a["proposed"]["tiktok"],
            a["proposed"]["offline"]) == (3, 2, 2)
    assert a["unallocated"] == 0
    b = prod.allocate(10, _dem(shopee=9, offline=3), "food")
    assert sum(b["proposed"].values()) == 10
    assert (b["proposed"]["shopee"], b["proposed"]["offline"]) == (8, 2)


def test_alloc_stock_above_base_spare_not_pushed():
    a = prod.allocate(100, _dem(shopee=30, offline=20), "tpbvsk")
    assert a["proposed"]["shopee"] == 30 and a["proposed"]["offline"] == 20
    assert a["unallocated"] == 50 and a["flag_level"] is None
    assert all(a["proposed"][c] == 0 for c in CHANS
               if c not in ("shopee", "offline"))


def test_alloc_stock_none_not_shortage():
    a = prod.allocate(None, _dem(shopee=30), "tpbvsk")
    assert set(a["proposed"].values()) == {0}
    assert a["flag_level"] is None and a["flag"] == prod.NOTE_NO_STOCK
    assert a["unallocated"] is None


def test_alloc_shortage_levels():
    sums = {"low": 10, "base": 20, "high": 30}
    assert prod.shortage(5, sums)[0] == "low"
    lvl, text = prod.shortage(15, sums)
    assert lvl == "base" and "THIẾU (cơ sở) 5" in text
    assert prod.shortage(25, sums)[0] == "high"
    assert prod.shortage(30, sums) == (None, None)
    assert prod.shortage(None, sums) == (None, None)


def test_alloc_rejects_bad_stock():
    for bad in (-1, True, 1.5):
        with pytest.raises(prod.ProductionError):
            prod.allocate(bad, _dem(shopee=1), "tpbvsk")


def test_alloc_tests_do_not_read_clock():
    src = Path(__file__).read_text(encoding="utf-8")
    bad = ["time." + "sleep", "datetime." + "now", "date." + "today"]
    assert not any(b in src for b in bad)


# ---------- SX-A4 BOM ----------

def _combo(key, chans, *items, name=None):
    return {"combo_key": key, "name": name or f"Combo {key}",
            "channels": list(chans),
            "items": [{"sku_key": s, "qty": 1} for s in items]}


def test_bom_sample_file_valid():
    doc = json.loads(SAMPLE_BOM.read_text(encoding="utf-8"))
    assert "MẪU" in doc["status"] and "MẪU" in doc["_doc"]
    assert prod.check_bom(doc["combos"], _golden()) == []
    chans = [c["channels"] for c in doc["combos"]]
    assert ["shopee"] in chans and ["offline"] in chans


def test_bom_sku_not_allowed_on_combo_channel():
    g = _golden()
    errs = prod.check_bom([_combo("c1", ["shopee"], "saphraton-20v",
                                  "saphraton-40v")], g)
    assert errs == [("combo c1 kênh shopee: SKU saphraton-40v không có "
                     "shopee trong allowed_channels")]
    errs = prod.check_bom([_combo("c2", ["tiktok"], "saphraton-20v")], g)
    assert len(errs) == 1 and "saphraton-20v" in errs[0] and "tiktok" in errs[0]


def test_bom_alcohol_online_error_despite_golden_shopee():
    g = _golden()
    assert "shopee" in g["ruou-sam-chai-thuy-tinh-500ml"]["allowed_channels"]
    errs = prod.check_bom([_combo("r1", ["shopee"],
                                  "ruou-sam-chai-thuy-tinh-500ml")], g)
    assert any("combo có rượu chỉ được kênh offline" in e for e in errs)
    assert prod.check_bom([_combo("r2", ["offline"],
                                  "ruou-sam-chai-thuy-tinh-500ml",
                                  "saphraton-40v")], g) == []


def test_bom_rule_from_data_not_hardcoded():
    doc = copy.deepcopy(GOLDEN)
    for s in doc["skus"]:
        if s["sku_key"] == "saphraton-20v":
            s["allowed_channels"] = ["shopee", "tiktok"]
    combos = [_combo("c2", ["tiktok"], "saphraton-20v")]
    assert prod.check_bom(combos, _golden()) != []
    assert prod.check_bom(combos, _golden(doc)) == []


@pytest.mark.parametrize("kind", ["banned_name", "qty0", "qty_bool", "sku",
                                  "channel", "no_items", "dup_key",
                                  "dup_sku", "bad_key", "extra_key"])
def test_bom_variants_rejected(kind):
    c = _combo("c1", ["offline"], "savina-12v")
    combos = [c]
    if kind == "banned_name":
        c["name"] = "Hộp quà chữa bệnh"
    elif kind == "qty0":
        c["items"][0]["qty"] = 0
    elif kind == "qty_bool":
        c["items"][0]["qty"] = True
    elif kind == "sku":
        c["items"][0]["sku_key"] = "khong-co"
    elif kind == "channel":
        c["channels"] = ["lazada"]
    elif kind == "no_items":
        c["items"] = []
    elif kind == "dup_key":
        combos = [c, copy.deepcopy(c)]
    elif kind == "dup_sku":
        c["items"].append({"sku_key": "savina-12v", "qty": 2})
    elif kind == "bad_key":
        c["combo_key"] = "Combo 1"
    elif kind == "extra_key":
        c["phone"] = "0905123456"
    errs = prod.check_bom(combos, _golden())
    assert errs, kind
    assert not any("0905123456" in e for e in errs)


def test_bom_buildable():
    items = [{"sku_key": "a", "qty": 1}, {"sku_key": "b", "qty": 1}]
    assert prod.buildable(items, {"a": 200, "b": 50}) == (50, [])
    assert prod.buildable([{"sku_key": "a", "qty": 3}], {"a": 10}) == (3, [])
    assert prod.buildable(items, {"a": 200}) == (0, ["b"])


# ---------- SX-A5 lô ----------

def _lot(**kw):
    lot = {"lot_code": "L-001", "sku_key": "savina-12v",
           "mfg_date": "2026-09-01", "exp_date": "2028-09-01", "qty": 10}
    lot.update(kw)
    return lot


def test_lot_sample_file_valid():
    doc = json.loads(SAMPLE_LOTS.read_text(encoding="utf-8"))
    assert "MẪU" in doc["status"] and "MẪU" in doc["_doc"]
    assert prod.validate_lots(doc["lots"], _golden(), TODAY) == []
    assert len(doc["lots"]) >= 3
    assert all(lot["lot_code"].startswith("MAU-") for lot in doc["lots"])
    assert any(lot["sku_key"] in ALCOHOL for lot in doc["lots"])


@pytest.mark.parametrize("lot", [
    _lot(exp_date="2026-08-31"), _lot(exp_date="2026-09-01"),
    _lot(mfg_date="2026-10-13", exp_date="2027-10-13"),
    _lot(lot_code="l-001"), _lot(lot_code="L 001"), _lot(phone="0905"),
    _lot(qty=0), _lot(qty=True), _lot(sku_key="khong-co"),
    _lot(sku_key=["saphraton-20v"]), _lot(sku_key={"a": 1}),
    _lot(mfg_date="01/09/2026"), _lot(note=123)])
def test_lot_variants_rejected(lot):
    assert prod.validate_lots([lot], _golden(), TODAY)


def test_lot_duplicate_code_rejected():
    errs = prod.validate_lots([_lot(), _lot()], _golden(), TODAY)
    assert errs == ["lô L-001: lot_code trùng"]


def test_qr_payload():
    lot = {**_lot(), "intake_status": "pending", "checked_by": "QA"}
    assert prod.qr_payload(lot) is None
    lot["intake_status"] = "passed"
    assert prod.qr_payload(lot) == {"lot_code": "L-001",
                                    "sku_key": "savina-12v",
                                    "exp_date": "2028-09-01"}


# ---------- SX-A0 bản tin (thuần) ----------

HEADINGS = ("## Thiếu hàng theo mốc chốt", "## Lô chờ kiểm nhập",
            "## BOM lỗi", "## Mục chờ duyệt & SLA")
CREATED = dt.datetime(2026, 10, 12, 9, 0, tzinfo=TZ)


def _bdata():
    return {"date": TODAY, "missing_tables": [], "sample": True,
            "shortages": [{"cutoff_id": "chot_11_11",
                           "cutoff_date": dt.date(2026, 10, 25),
                           "run_id": "abcdef012345", "status": "pending",
                           "sku_key": "saphraton-20v", "stock_total": 70,
                           "low": 83, "base": 111, "high": 145,
                           "flag": "THIẾU CẢ KỊCH BẢN THẤP"}],
            "no_stock": ["mat-ong-sam-300ml"],
            "lots_pending": [{"lot_code": "L-1", "sku_key": "savina-12v",
                              "mfg_date": dt.date(2026, 9, 1),
                              "exp_date": dt.date(2028, 9, 1), "qty": 5,
                              "created_at": CREATED}],
            "bom_errors": [("combo c1 kênh shopee: SKU x không có shopee"
                            " trong allowed_channels")],
            "pending": [{"kind": "phân bổ", "id": "abcdef012345",
                         "created_at": CREATED},
                        {"kind": "lô", "id": "L-1", "created_at": CREATED},
                        {"kind": "lô", "id": "L-2", "created_at": CREATED}]}


def test_bulletin_deterministic_and_headings():
    cfg = prod.load_config()
    now = CREATED + dt.timedelta(hours=3)
    a = prod.render_bulletin(_bdata(), now, cfg)
    assert a == prod.render_bulletin(_bdata(), now, cfg)
    pos = [a.index(h) for h in HEADINGS]
    assert pos == sorted(pos)
    assert "[MẪU]" in a and "KHÔNG phải doanh số cam kết" in a
    assert "GIẢ ĐỊNH" in a and "còn 13 ngày" in a
    assert "saphraton-20v" in a.split(HEADINGS[0])[1].split(HEADINGS[1])[0]
    assert "mat-ong-sam-300ml" in a
    assert "SKU x" in a.split(HEADINGS[2])[1]


def test_bulletin_sla_thresholds():
    cfg = prod.load_config()
    tail = HEADINGS[3]

    def sla(now):
        return prod.render_bulletin(_bdata(), now, cfg).split(tail)[1]

    s = sla(CREATED + dt.timedelta(hours=23, minutes=59))
    assert "NHẮC" not in s and "QUÁ SLA" not in s and s.count("trong hạn") == 3
    s = sla(CREATED + dt.timedelta(days=1))
    assert s.count("NHẮC") == 3 and "QUÁ SLA" not in s
    s = sla(CREATED + dt.timedelta(days=2, minutes=1))
    assert s.count("QUÁ SLA 48h — đề xuất chuyển TGĐ") == 3
    assert "NHẮC" not in s


def test_bulletin_empty_and_missing_tables():
    cfg = prod.load_config()
    empty = {"missing_tables": [], "shortages": [], "no_stock": [],
             "lots_pending": [], "bom_errors": [], "pending": [],
             "sample": False, "date": TODAY}
    out = prod.render_bulletin(empty, CREATED, cfg)
    # v12.3: thêm mục "Hàng cận hạn (FEFO)" → 5 mục rỗng
    assert out.count("không có") == 5 and "[MẪU]" not in out
    out = prod.render_bulletin({**empty, "missing_tables":
                                list(prod.ALLOC_TABLES)}, CREATED, cfg)
    assert out.count("chưa có bảng — chạy apply_schema") == 5


def test_bulletin_strips_control_chars_and_clamps_age():
    cfg = prod.load_config()
    data = _bdata()
    data["lots_pending"][0]["lot_code"] = "L-1\x1b[2J"
    data["pending"] = [{"kind": "lô", "id": "L-1\x1b[2J",
                        "created_at": CREATED + dt.timedelta(hours=2)}]
    out = prod.render_bulletin(data, CREATED, cfg)
    assert "\x1b" not in out and "chờ 0h" in out
    errs = prod.check_bom([{**_combo("c1", ["offline"], "savina-12v"),
                            "x\x1b[31m": 1}], _golden())
    assert errs and not any("\x1b" in e for e in errs)


def test_bulletin_db_down_exit1(monkeypatch, capsys):
    def boom(_dsn):
        raise psycopg.OperationalError("host chết")

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", boom)
    assert prod.main(["bulletin", "--date", "2026-10-12"]) == 1
    out = capsys.readouterr()
    assert "[err]" in out.out and "Traceback" not in out.out + out.err


def test_bulletin_no_llm_grep():
    for f in ("pipelines/production.py", "ingest/inventory_csv.py"):
        src = (ROOT / f).read_text(encoding="utf-8")
        assert "llm_gateway" not in src and "openai" not in src


# ---------- CLI usage (không DB) ----------

@pytest.mark.parametrize("argv", [
    ["approve", "--run", "abcdef012345"],
    ["approve", "--run", "abcdef012345", "--by", "   "],
    ["reject", "--run", "abcdef012345", "--by", "x" * 101],
    ["approve", "--run", "nothex", "--by", "A"],
    ["intake", "--lot", "MAU-SAP20-260901", "--result", "passed"],
    ["intake", "--lot", "MAU-SAP20-260901", "--result", "passed", "--by",
     "   "],
    ["intake", "--lot", "MAU-SAP20-260901", "--result", "ok", "--by", "A"],
    ["bom"], ["bom", "--load", "x.json", "--check"],
    ["bom", "--check", "--source", "sample"], []])
def test_intake_alloc_usage_exit2(argv, monkeypatch):
    monkeypatch.setattr(prod, "_connect", lambda _d: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        prod.main(argv)
    assert e.value.code == 2


def test_bom_lot_bad_file_exit1_no_connect(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", lambda _d: calls.append(1))
    bad_bom = _write(tmp_path, "b.json", {"_doc": "x", "combos": [
        _combo("r1", ["shopee"], "ruou-sam-chai-thuy-tinh-500ml")]})
    bad_lots = _write(tmp_path, "l.json", {"lots": [
        _lot(exp_date="2026-08-01")]})
    # sku_key không hashable (list/dict) → [err], KHÔNG TypeError traceback
    list_sku = _write(tmp_path, "ls.json", {"lots": [
        _lot(sku_key=["saphraton-20v"]), _lot(lot_code="L-002",
                                              sku_key={"a": 1})]})
    for argv in (["bom", "--load", str(bad_bom)],
                 ["bom", "--load", str(tmp_path / "missing.json")],
                 ["bom", "--load", str(_write(tmp_path, "e.json", "{}"))],
                 ["lots", "--load", str(bad_lots)],
                 ["lots", "--load", str(list_sku)],
                 ["lots", "--load", str(_write(tmp_path, "d.json",
                                               {"_doc": "x"}))]):
        assert prod.main(argv) == 1, argv
    assert calls == []
    assert "không connect" in capsys.readouterr().out


# ---------- DB thật (schema tạm, rollback) ----------

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")


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
        schema = f"t_prod_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.production_lots",)).fetchone()[0]
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self, *a, **kw):
        return self.conn.transaction(*a, **kw)    # conn fixture đang trong
        # tx → savepoint; lỗi RAISE không làm hỏng tx của test

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture
def run(db, monkeypatch):
    proxy = TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(ic, "_connect", lambda _dsn: proxy)
    return lambda *argv: prod.main(list(argv))


def _one(db, sql, params=None):
    return db.execute(sql, params).fetchone()[0]


def _inv(db):
    rows, errs, sha = ic.read_inventory(SAMPLE_INV, _golden(), TODAY)
    assert errs == []
    ic.load(db, rows, "sample", SAMPLE_INV.name, sha)


def _inv_state(db):
    return db.execute("select count(*), sum(qty), max(id) from "
                      "inventory_snapshots").fetchone()


ALLOC = ("allocate", "--cutoff", "chot_11_11", "--start", "2026-10-12")


def test_alloc_db_idempotent_approve_logs(db, run, capsys):
    _inv(db)
    inv0 = _inv_state(db)
    assert run(*ALLOC) == 0
    out = capsys.readouterr().out
    for s in ("[MẪU]", "KHÔNG phải doanh số cam kết",
              "không đề xuất sản xuất mới", "GIẢ ĐỊNH", "THIẾU"):
        assert s in out, s
    n = _one(db, "select count(*) from allocation_proposals")
    assert n == len(GOLDEN["skus"]) * len(CHANS)
    rid = _one(db, "select min(run_id) from allocation_proposals")
    assert _one(db, "select count(distinct run_id) from allocation_proposals"
                ) == 1
    assert run(*ALLOC) == 0
    assert "[skip] run đã có" in capsys.readouterr().out
    assert _one(db, "select count(*) from allocation_proposals") == n
    assert _one(db, "select count(*) from allocation_proposals where status"
                " <> 'pending'") == 0
    # rượu × online = 0, × offline > 0 (có tồn)
    for key in ALCOHOL:
        rows = dict(db.execute(
            "select channel, proposed_qty from allocation_proposals where"
            " sku_key = %s", (key,)).fetchall())
        assert all(rows[c] == 0 for c in CHANS if c != "offline")
        assert rows["offline"] > 0
    # SKU không có dòng tồn: stock_total null, đề xuất 0
    assert db.execute(
        "select bool_and(stock_total is null), sum(proposed_qty) from"
        " allocation_proposals where sku_key = 'mat-ong-sam-300ml'"
    ).fetchone() == (True, 0)

    for argv in (("approve", "--run", rid), ("approve", "--run", rid,
                                              "--by", " ")):
        with pytest.raises(SystemExit) as e:
            run(*argv)
        assert e.value.code == 2
    assert _one(db, "select count(*) from allocation_proposals where status"
                " <> 'pending'") == 0
    assert run("approve", "--run", rid, "--by", "GĐ SX test") == 0
    assert _one(db, "select count(*) from allocation_proposals where"
                " run_id = %s and status = 'approved' and decided_by ="
                " 'GĐ SX test'", (rid,)) == n
    assert db.execute("select object_type, object_id, decision, approved_by"
                      " from approvals").fetchall() == [
        ("allocation_run", rid, "approved", "GĐ SX test")]
    assert db.execute("select action, object_id from agent_action_log"
                      ).fetchall() == [("alloc_approve", rid)]
    assert db.execute("select * from verify_action_log()").fetchall() == []
    # content_sha256 tính trong DB = sha256 JSON [[sku, kênh, qty]] đã sort
    got = sorted(list(r) for r in db.execute(
        "select sku_key, channel, proposed_qty from allocation_proposals"
        " where run_id = %s", (rid,)))
    assert _one(db, "select content_sha256 from approvals") == hashlib.sha256(
        json.dumps(got).encode("utf-8")).hexdigest()
    assert _inv_state(db) == inv0
    # run đã duyệt / run không tồn tại → exit 1, không ghi thêm
    assert run("reject", "--run", rid, "--by", "B") == 1
    assert run("approve", "--run", "000000000000", "--by", "B") == 1
    assert _one(db, "select count(*) from approvals") == 1


def test_alloc_db_reject_and_new_stock_new_run(db, run, tmp_path):
    _inv(db)
    assert run(*ALLOC) == 0
    rid = _one(db, "select min(run_id) from allocation_proposals")
    # tồn đổi → run_id mới
    f = tmp_path / "x.csv"
    f.write_bytes(b"sku_key,kho,qty,captured_at\n"
                  b"savina-12v,kho-mau-da-nang,1,2026-10-10\n")
    rows, errs, sha = ic.read_inventory(f, _golden(), TODAY)
    assert errs == []
    ic.load(db, rows, "manual_export", f.name, sha)
    assert run(*ALLOC) == 0
    assert _one(db, "select count(distinct run_id) from allocation_proposals"
                ) == 2
    assert run("reject", "--run", rid, "--by", "GĐ SX test", "--note",
               "chờ số kho thật") == 0
    assert db.execute("select decision, note from approvals").fetchall() == [
        ("rejected", "chờ số kho thật")]
    assert db.execute("select action from agent_action_log").fetchall() == [
        ("alloc_reject",)]


def test_alloc_db_constraints(db):
    def bad(sql):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute(sql)

    bad("insert into allocation_proposals (run_id, cutoff_id, cutoff_date,"
        " start_week, sku_key, channel, demand_low, demand_base, demand_high,"
        " proposed_qty, status) values ('r', 'c', '2026-10-25', '2026-10-12',"
        " 's', 'shopee', 0, 0, 0, 0, 'approved')")
    bad("insert into allocation_proposals (run_id, cutoff_id, cutoff_date,"
        " start_week, sku_key, channel, demand_low, demand_base, demand_high,"
        " proposed_qty, decided_by) values ('r', 'c', '2026-10-25',"
        " '2026-10-12', 's', 'shopee', 0, 0, 0, 0, 'X')")


def test_bom_db_load_idempotent_and_check(db, run, capsys, tmp_path,
                                          monkeypatch):
    _inv(db)
    counts = ("select (select count(*) from bom_combos),"
              " (select count(*) from bom_items)")
    assert run("bom", "--load", str(SAMPLE_BOM), "--source", "sample") == 0
    c1 = db.execute(counts).fetchone()
    assert c1[0] >= 2
    assert run("bom", "--load", str(SAMPLE_BOM), "--source", "sample") == 0
    assert db.execute(counts).fetchone() == c1
    capsys.readouterr()
    assert run("bom", "--check") == 0
    out = capsys.readouterr().out
    assert "[MẪU]" in out and prod.BUILDABLE_NOTE in out
    # combo shopee: saphraton-20v 70, mat-ong-120ml-1hu 150 → 70
    assert "combo-saphraton-mat-ong-shopee [shopee]: 70" in out
    # golden đổi (bỏ shopee khỏi SKU thành phần) → check báo lỗi
    doc = copy.deepcopy(GOLDEN)
    for s in doc["skus"]:
        if s["sku_key"] == "saphraton-20v":
            s["allowed_channels"] = []
    monkeypatch.setattr(prod, "GOLDEN_FILE", _write(tmp_path, "g.json", doc))
    assert run("bom", "--check") == 1
    out = capsys.readouterr().out
    assert "kênh shopee: SKU saphraton-20v" in out


def test_bom_db_bad_file_zero_rows(db, run, tmp_path):
    bad = _write(tmp_path, "b.json", {"combos": [
        _combo("r1", ["shopee"], "ruou-sam-chai-thuy-tinh-500ml")]})
    assert run("bom", "--load", str(bad)) == 1
    assert _one(db, "select count(*) from bom_combos") == 0


def test_bom_db_manual_not_overwritten_by_sample(db, run, tmp_path):
    doc = json.loads(SAMPLE_BOM.read_text(encoding="utf-8"))
    doc["combos"][0]["name"] = "Combo tay"
    assert run("bom", "--load", str(_write(tmp_path, "m.json", doc))) == 0
    assert run("bom", "--load", str(SAMPLE_BOM), "--source", "sample") == 0
    assert _one(db, "select name from bom_combos where combo_key = %s",
                (doc["combos"][0]["combo_key"],)) == "Combo tay"


def test_lot_db_check_constraints(db):
    def bad(sql):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute(sql)

    ins = ("insert into production_lots (lot_code, sku_key, mfg_date,"
           " exp_date, qty, source, intake_status, checked_by) values ")
    bad(ins + "('L-1', 's', '2026-09-01', '2026-08-01', 1, 'manual',"
        " 'pending', null)")
    bad(ins + "('L-1', 's', '2026-09-01', '2026-09-01', 1, 'manual',"
        " 'pending', null)")
    bad(ins + "('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual',"
        " 'passed', null)")
    bad(ins + "('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual',"
        " 'pending', 'QA')")
    bad(ins + "('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual',"
        " 'passed', '  ')")


def test_lot_intake_db_flow(db, run, capsys, tmp_path):
    assert run("lots", "--load", str(SAMPLE_LOTS), "--source", "sample") == 0
    n = _one(db, "select count(*) from production_lots")
    assert n >= 3
    assert run("lots", "--load", str(SAMPLE_LOTS), "--source", "sample") == 0
    assert f"[skip] {n} lô đã có" in capsys.readouterr().out
    doc = json.loads(SAMPLE_LOTS.read_text(encoding="utf-8"))
    lot = doc["lots"][0]["lot_code"]
    old_qty = doc["lots"][0]["qty"]
    doc["lots"][0]["qty"] = old_qty + 999
    assert run("lots", "--load", str(_write(tmp_path, "l.json", doc))) == 0
    assert _one(db, "select qty from production_lots where lot_code = %s",
                (lot,)) == old_qty

    for argv in (("intake", "--lot", lot, "--result", "passed"),
                 ("intake", "--lot", lot, "--result", "passed", "--by",
                  "   ")):
        with pytest.raises(SystemExit) as e:
            run(*argv)
        assert e.value.code == 2
    assert db.execute("select intake_status, checked_by from production_lots"
                      " where lot_code = %s", (lot,)).fetchone() == (
        "pending", None)
    assert run("intake", "--lot", lot, "--result", "passed", "--by",
               "QA test") == 0
    assert db.execute("select intake_status, checked_by from production_lots"
                      " where lot_code = %s", (lot,)).fetchone() == (
        "passed", "QA test")
    assert db.execute("select object_type, object_id, decision from approvals"
                      ).fetchall() == [("lot_intake", lot, "approved")]
    assert db.execute("select action, object_id from agent_action_log"
                      ).fetchall() == [("lot_intake", lot)]
    assert db.execute("select * from verify_action_log()").fetchall() == []
    # kiểm lần 2 cùng lô → exit 1, không thêm approvals
    assert run("intake", "--lot", lot, "--result", "failed", "--by",
               "QA khác") == 1
    assert _one(db, "select count(*) from approvals") == 1
    lot2 = doc["lots"][1]["lot_code"]
    assert run("intake", "--lot", lot2, "--result", "failed", "--by",
               "QA test") == 0
    assert _one(db, "select decision from approvals where object_id = %s",
                (lot2,)) == "rejected"
    assert run("intake", "--lot", "KHONG-CO-LO", "--result", "passed",
               "--by", "QA test") == 1
    # điểm nối QR từ dòng DB
    row = db.execute("select lot_code, sku_key, exp_date, intake_status,"
                     " checked_by from production_lots where lot_code = %s",
                     (lot,)).fetchone()
    payload = prod.qr_payload(dict(zip(("lot_code", "sku_key", "exp_date",
                                        "intake_status", "checked_by"), row)))
    assert set(payload) == {"lot_code", "sku_key", "exp_date"}
    assert "QA test" not in json.dumps(payload)


def test_bulletin_db_no_status_change(db, run, capsys, tmp_path,
                                      monkeypatch):
    _inv(db)
    assert run(*ALLOC) == 0
    assert run("lots", "--load", str(SAMPLE_LOTS), "--source", "sample") == 0
    assert run("bom", "--load", str(SAMPLE_BOM), "--source", "sample") == 0
    lot = _one(db, "select min(lot_code) from production_lots")
    assert run("intake", "--lot", lot, "--result", "passed", "--by",
               "Nguoi Kiem Nhap") == 0
    rid = _one(db, "select min(run_id) from allocation_proposals")
    assert run("approve", "--run", rid, "--by", "Nguoi Duyet SX") == 0
    assert run(*ALLOC[:3], "--start", "2026-10-19") == 0   # run pending mới
    state = ("select (select string_agg(status, ',' order by id) from"
             " allocation_proposals), (select string_agg(intake_status, ','"
             " order by lot_code) from production_lots)")
    before = db.execute(state).fetchone()
    doc = copy.deepcopy(GOLDEN)
    for s in doc["skus"]:
        if s["sku_key"] == "saphraton-20v":
            s["allowed_channels"] = []
    monkeypatch.setattr(prod, "GOLDEN_FILE", _write(tmp_path, "g.json", doc))
    capsys.readouterr()
    assert run("bulletin", "--date", "2026-10-12") == 0
    out = capsys.readouterr().out
    assert db.execute(state).fetchone() == before
    pos = [out.index(h) for h in HEADINGS]
    assert pos == sorted(pos)
    sec = [out[pos[i]:(pos[i + 1] if i < 3 else None)] for i in range(4)]
    assert "[MẪU]" in out and "KHÔNG phải doanh số cam kết" in out
    assert "saphraton-20v" in sec[0] and "chot_11_11" in sec[0]
    # chỉ run MỚI NHẤT mỗi mốc: run cũ (đã duyệt) không lọt vào mục 1
    new_rid = _one(db, "select min(run_id) from allocation_proposals where"
                   " run_id <> %s", (rid,))
    assert f"run {new_rid}" in sec[0] and f"run {rid}" not in sec[0]
    assert sum(" · saphraton-20v:" in ln for ln in sec[0].splitlines()) == 1
    assert "MAU-" in sec[1] and lot not in sec[1]
    assert "SKU saphraton-20v" in sec[2]
    assert "phân bổ" in sec[3] and "lô" in sec[3]
    assert "Nguoi Kiem Nhap" not in out and "Nguoi Duyet SX" not in out
    data = prod.collect(db, _golden())
    assert data["bom_errors"] == []


def test_bom_check_strips_control_chars_from_db(monkeypatch, capsys):
    """bom --check in chuỗi đọc từ DB (combo_key/channels/sku_key không có
    CHECK slug) → mã điều khiển phải bị _clean, không đổ ra terminal."""
    class Fake:
        def rollback(self):
            pass

        def close(self):
            pass

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", lambda _d: Fake())
    monkeypatch.setattr(prod, "db_combos", lambda _c: [{
        "combo_key": "c1\x1b[2J", "name": "Combo",
        "channels": ["offline\x1b]0;x\x07"],
        "items": [{"sku_key": "sku\x1b[2J", "qty": 1}],
        "_source": "manual"}])
    monkeypatch.setattr(ic, "current_stock", lambda _c: {})
    assert prod.main(["bom", "--check"]) == 1
    out = capsys.readouterr().out
    assert "\x1b" not in out and "\x07" not in out
    assert "c1?[2J" in out and "sku?[2J" in out


def test_decisions_only_via_security_definer_functions(db):
    src = (ROOT / "pipelines" / "production.py").read_text(encoding="utf-8")
    assert not re.search(r"insert\s+into\s+approvals", src, re.IGNORECASE)
    schema = _one(db, "select current_schema()")
    fns = ("decide_allocation_run", "record_lot_intake")
    rows = db.execute(
        "select proname, prosecdef, proconfig from pg_proc where"
        " pronamespace = %s::regnamespace and proname = any(%s)",
        (schema, list(fns))).fetchall()
    assert {r[0] for r in rows} == set(fns)
    for name, secdef, cfg in rows:
        assert secdef is True, name
        assert [c for c in (cfg or []) if c.startswith("search_path=")] == [
            f"search_path={schema}, pg_temp"], (name, cfg)
    db.execute(ROLES_SQL)
    q = "select has_function_privilege(%s, %s, 'execute')"
    for fn in ("decide_allocation_run(text,text,text,text)",
               "record_lot_intake(text,text,text,text)"):
        assert _one(db, q, ("app_human", fn)) is True, fn
        assert _one(db, q, ("agent_writer", fn)) is False, fn
        assert _one(db, q, ("public", fn)) is False, fn
    for role in ("app_human", "agent_writer"):
        assert _one(db, "select has_table_privilege(%s, 'approvals',"
                    " 'insert')", (role,)) is False, role
    # function tự kiểm: người rỗng / kết quả lạ / lô, run không có → RAISE
    for sql in ("select record_lot_intake('L-001', 'passed', '  ')",
                "select record_lot_intake('L-001', 'ok', 'QA')",
                "select record_lot_intake('KHONG-CO', 'passed', 'QA')",
                "select * from decide_allocation_run('abc', 'approved', ' ')",
                "select * from decide_allocation_run('abc', 'x', 'GĐ')",
                "select * from decide_allocation_run('abc', 'approved', 'GĐ')"):
        with pytest.raises(psycopg.errors.RaiseException), db.transaction():
            db.execute(sql)
    assert _one(db, "select count(*) from approvals") == 0


def test_stale_stock_warned_in_allocate_and_bulletin(db, run, capsys,
                                                     tmp_path):
    """File kho mới BỎ SÓT SKU (vd hết hàng mà không ghi qty 0) → số cũ
    vẫn giữ (không đoán = 0) nhưng allocate + bản tin phải cảnh báo."""
    _inv(db)                       # mẫu 2026-10-09, 2 kho
    f = tmp_path / "k.csv"
    f.write_bytes(b"sku_key,kho,qty,captured_at\n"
                  b"savina-12v,kho-mau-da-nang,5,2026-10-10\n")
    rows, errs, sha = ic.read_inventory(f, _golden(), TODAY)
    assert errs == []
    ic.load(db, rows, "manual_export", f.name, sha)
    st = ic.current_stock(db)
    assert st["saphraton-20v"]["stale"] == ["kho-mau-da-nang"]
    assert st["saphraton-20v"]["qty"] == 70       # giữ số cũ, không = 0
    assert st["saphraton-20v"]["kho"]["kho-mau-quang-nam"]["stale"] is False
    assert st["savina-12v"]["stale"] == []
    assert st["saphraton-40v"]["stale"] == []     # chỉ ở kho-mau-quang-nam
    capsys.readouterr()
    assert run(*ALLOC) == 0
    out = capsys.readouterr().out
    assert ic.STALE_NOTE in out
    assert "- saphraton-20v @ kho-mau-da-nang" in out
    assert "- savina-12v @" not in out
    assert _one(db, "select bool_and(note like %s) from allocation_proposals"
                " where sku_key = 'saphraton-20v'",
                (f"%{ic.STALE_NOTE}%",)) is True
    assert run("bulletin", "--date", "2026-10-12") == 0
    out = capsys.readouterr().out
    sec0 = out.split(HEADINGS[0])[1].split(HEADINGS[1])[0]
    assert ic.STALE_NOTE in sec0 and "saphraton-20v@kho-mau-da-nang" in sec0
    assert "savina-12v@" not in sec0


def _inv_csv(*rows) -> bytes:
    return chr(10).join(("sku_key,kho,qty,captured_at",) + rows
                        + ("",)).encode()


def test_stale_stock_same_day_correction_file(db, run, capsys, tmp_path):
    """Biến thể F2 cùng ngày: file đính chính CÙNG captured_at của cùng kho
    bỏ SKU → SKU đó vẫn giữ số file trước (không đoán 0) nhưng phải stale
    (so theo FILE mới nhất của kho, không chỉ ngày mới nhất)."""
    _inv(db)                       # mẫu 2026-10-09, 2 kho
    f1 = tmp_path / "p1.csv"
    f1.write_bytes(_inv_csv(
        "savina-12v,kho-mau-da-nang,5,2026-10-10",
        "saphraton-20v,kho-mau-da-nang,9,2026-10-10"))
    f2 = tmp_path / "p2.csv"
    f2.write_bytes(_inv_csv(
        "savina-12v,kho-mau-da-nang,4,2026-10-10"))
    for f in (f1, f2):
        rows, errs, sha = ic.read_inventory(f, _golden(), TODAY)
        assert errs == []
        ic.load(db, rows, "manual_export", f.name, sha)
    st = ic.current_stock(db)
    k = st["saphraton-20v"]["kho"]["kho-mau-da-nang"]
    assert k == {"qty": 9, "captured_at": "2026-10-10", "stale": True}
    assert st["saphraton-20v"]["stale"] == ["kho-mau-da-nang"]
    assert st["savina-12v"]["kho"]["kho-mau-da-nang"] == {
        "qty": 4, "captured_at": "2026-10-10", "stale": False}
    assert st["savina-12v"]["stale"] == []
    assert st["saphraton-40v"]["stale"] == []     # chỉ ở kho-mau-quang-nam
    capsys.readouterr()
    assert run(*ALLOC) == 0
    out = capsys.readouterr().out
    assert ic.STALE_NOTE in out
    assert "- saphraton-20v @ kho-mau-da-nang" in out
    assert "- savina-12v @" not in out
    assert run("bulletin", "--date", "2026-10-12") == 0
    out = capsys.readouterr().out
    sec0 = out.split(HEADINGS[0])[1].split(HEADINGS[1])[0]
    assert ic.STALE_NOTE in sec0 and "saphraton-20v@kho-mau-da-nang" in sec0
    assert "savina-12v@" not in sec0
    # file mới nhất cùng ngày liệt kê đủ lại → hết stale (không dính vĩnh viễn)
    f3 = tmp_path / "p3.csv"
    f3.write_bytes(_inv_csv(
        "savina-12v,kho-mau-da-nang,4,2026-10-10",
        "saphraton-20v,kho-mau-da-nang,0,2026-10-10"))
    rows, errs, sha = ic.read_inventory(f3, _golden(), TODAY)
    assert errs == []
    ic.load(db, rows, "manual_export", f3.name, sha)
    st = ic.current_stock(db)
    assert st["saphraton-20v"]["stale"] == []
    assert st["saphraton-20v"]["kho"]["kho-mau-da-nang"]["qty"] == 0


def test_bulletin_render_stale_stock():
    cfg = prod.load_config()
    empty = {"missing_tables": [], "shortages": [], "no_stock": [],
             "lots_pending": [], "bom_errors": [], "pending": [],
             "sample": False, "date": TODAY,
             "stale_stock": [("savina-12v", "kho-a\x1b[2J")]}
    out = prod.render_bulletin(empty, CREATED, cfg)
    sec0 = out.split(HEADINGS[0])[1].split(HEADINGS[1])[0]
    assert ic.STALE_NOTE in sec0 and "không có" not in sec0
    assert "\x1b" not in out


# ---------- v12.3 hàng cận hạn (FEFO) ----------

NEAR = "## Hàng cận hạn (FEFO)"


def _near(code, sku, exp, qty=10, stock=5):
    return {"lot_code": code, "sku_key": sku, "exp_date": exp, "qty": qty,
            "stock": stock}


def test_bulletin_near_expiry_fefo_window_and_labels():
    cfg = prod.load_config()
    d = TODAY
    data = {"missing_tables": [], "shortages": [], "no_stock": [],
            "lots_pending": [], "bom_errors": [], "pending": [],
            "sample": False, "date": d, "near_expiry": [
                _near("L-B", "savina-12v", d + dt.timedelta(days=90)),
                _near("L-OUT", "savina-12v", d + dt.timedelta(days=91)),
                _near("L-OLD\x1b[2J", "saphraton-20v",
                      d - dt.timedelta(days=2), stock=None),
                _near("L-A", "savina-12v", d + dt.timedelta(days=90)),
                _near("L-TODAY", "savina-12v", d, stock=7)]}
    out = prod.render_bulletin(data, CREATED, cfg)
    sec = out.split(NEAR)[1]
    assert out.index(NEAR) > out.index(HEADINGS[3])     # mục cuối
    lines = [ln for ln in sec.splitlines() if ln.startswith("- ")]
    # FEFO: HSD tăng dần, hòa → mã lô; biên đúng 90 ngày vào, 91 ngày ra
    assert [ln.split(" · ")[0] for ln in lines] == [
        "- L-OLD?[2J", "- L-TODAY", "- L-A", "- L-B"]
    assert "ĐÃ QUÁ HẠN 2 ngày" in lines[0] and "chưa có số tồn" in lines[0]
    assert "còn 0 ngày" in lines[1] and "tồn SKU 7" in lines[1]
    assert "còn 90 ngày" in lines[2] and "L-OUT" not in out
    assert "\x1b" not in out and "không có" not in sec
    assert out == prod.render_bulletin(data, CREATED, cfg)   # tất định


def test_bulletin_near_expiry_empty_missing_and_old_data_shape():
    cfg = prod.load_config()
    base = {"missing_tables": [], "shortages": [], "no_stock": [],
            "lots_pending": [], "bom_errors": [], "pending": [],
            "sample": False, "date": TODAY}
    sec = prod.render_bulletin(base, CREATED, cfg).split(NEAR)[1]
    assert "không có" in sec          # data cũ không có key near_expiry
    out = prod.render_bulletin({**base, "missing_tables": ["production_lots"]},
                               CREATED, cfg)
    assert "chưa có bảng" in out.split(NEAR)[1]
    small = {**cfg, "near_expiry_days": 1}
    out = prod.render_bulletin({**base, "near_expiry": [
        _near("L-2", "savina-12v", TODAY + dt.timedelta(days=2))]},
        CREATED, small)
    assert "L-2" not in out and "HSD ≤ 1 ngày" in out


def test_bulletin_near_expiry_db(db, run, capsys, tmp_path):
    """Chỉ lô passed, HSD trong cửa sổ, SKU còn tồn (tồn 0 → bỏ; chưa có
    số tồn → vẫn liệt kê); bulletin chỉ đọc."""
    f = tmp_path / "inv.csv"
    f.write_bytes(_inv_csv("savina-12v,kho-a,4,2026-10-10",
                           "saphraton-20v,kho-a,0,2026-10-10"))
    rows, errs, sha = ic.read_inventory(f, _golden(), TODAY)
    assert errs == []
    ic.load(db, rows, "manual_export", f.name, sha)
    stock = ic.current_stock(db)
    has, zero_sku = ["savina-12v"], "saphraton-20v"
    nostock = next(k for k in _golden() if k not in stock)
    soon = TODAY + dt.timedelta(days=30)
    lots = [("NE-OK-1", has[0], soon, "passed"),
            ("NE-ZERO-1", zero_sku, soon, "passed"),
            ("NE-NOSTK-1", nostock, soon, "passed"),
            ("NE-PEND-1", has[0], soon, "pending"),
            ("NE-FAIL-1", has[0], soon, "failed"),
            ("NE-FAR-1", has[0], TODAY + dt.timedelta(days=400), "passed"),
            ("NE-OLD-1", has[0], TODAY - dt.timedelta(days=1), "passed"),
            ("NE-ANCIENT-1", has[0], TODAY - dt.timedelta(days=400),
             "passed")]
    for code, sku, exp, st in lots:
        db.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
                   " exp_date, qty, intake_status, checked_by, checked_at,"
                   " source) values (%s, %s, %s, %s, 3, %s, %s, %s,"
                   " 'sample')",
                   (code, sku, TODAY - dt.timedelta(days=700), exp, st,
                    None if st == "pending" else "QA test",
                    None if st == "pending" else CREATED))
    data = prod.collect(db, _golden(), None,
                        TODAY + dt.timedelta(days=90),
                        TODAY - dt.timedelta(days=90))
    got = {r["lot_code"]: r["stock"] for r in data["near_expiry"]}
    assert set(got) == {"NE-OK-1", "NE-NOSTK-1", "NE-OLD-1"}
    assert got["NE-NOSTK-1"] is None and got["NE-OK-1"] == stock[has[0]]["qty"]
    assert prod.collect(db, _golden())["near_expiry"] == []   # không cửa sổ
    before = _one(db, "select string_agg(lot_code || intake_status, ','"
                  " order by lot_code) from production_lots")
    capsys.readouterr()
    assert run("bulletin", "--date", TODAY.isoformat()) == 0
    out = capsys.readouterr().out
    sec = out.split(NEAR)[1]
    assert [ln.split(" · ")[0] for ln in sec.splitlines()
            if ln.startswith("- ")] == ["- NE-OLD-1", "- NE-NOSTK-1",
                                        "- NE-OK-1"]
    assert "QA test" not in out
    assert _one(db, "select string_agg(lot_code || intake_status, ','"
                " order by lot_code) from production_lots") == before
