"""v7.3 W73.1/W73.2 — engine kịch bản mùa thuần + CLI.

Test thuần: start truyền tham số cố định, không đọc đồng hồ, không ngủ.
"""

import copy
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from ingest import golden_store
from pipelines import scenario as sc

ROOT = Path(__file__).resolve().parent.parent
D = dt.date
GOLDEN = json.loads(
    (ROOT / "data" / "golden_skus.json").read_text(encoding="utf-8"))["skus"]
SKUS = {s["sku_key"]: s for s in GOLDEN}
ALCOHOL = [s for s in GOLDEN if s["category"] == "alcohol"]
RAW = json.loads(sc.ASSUMPTIONS_FILE.read_text(encoding="utf-8"))


def _a(**over):
    doc = copy.deepcopy(RAW)
    doc.update(over)
    return doc


# ---------- ngày Tết / tuần ----------

def test_tet_2027_date_and_week():
    assert sc.tet_date(2027) == D(2027, 2, 6)
    assert sc.week_start(sc.tet_date(2027)) == D(2027, 2, 1)
    assert sc.tet_date(2026) == D(2026, 2, 17)
    assert sc.tet_date(2028) == D(2028, 1, 26)
    with pytest.raises(sc.ScenarioError):
        sc.tet_date(2030)
    for bad in (True, 2027.0, [2027], "2027", 10 ** 400):
        with pytest.raises(sc.ScenarioError):
            sc.tet_date(bad)


def test_week_start_monday():
    assert sc.week_start(D(2026, 10, 12)) == D(2026, 10, 12)   # thứ Hai
    assert sc.week_start(D(2026, 10, 18)) == D(2026, 10, 12)   # Chủ nhật
    assert sc.week_start(dt.datetime(2026, 10, 14, 9, tzinfo=dt.UTC)) == D(2026, 10, 12)


def test_tet_week_in_projection():
    a = sc.load_assumptions()
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2027, 1, 25), 3, a)
    by_week = {r["week_start"]: r for r in rows}
    assert list(by_week) == [D(2027, 1, 25), D(2027, 2, 1), D(2027, 2, 8)]
    assert "tet_2027" in by_week[D(2027, 2, 1)]["events"]


def test_11_11_and_12_12_weeks():
    a = sc.load_assumptions()
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 13, a)
    by_week = {r["week_start"]: r["events"] for r in rows}
    assert "11.11" in by_week[D(2026, 11, 9)]
    assert "12.12" in by_week[D(2026, 12, 7)]
    assert by_week[D(2026, 10, 12)] == []


def test_start_normalized_to_monday():
    a = sc.load_assumptions()
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 15), 2, a)
    assert [r["week_start"] for r in rows] == [D(2026, 10, 12), D(2026, 10, 19)]


# ---------- property: luôn là khoảng ----------

def _allowed(s, ch):
    if ch == sc.OFFLINE:
        return True
    return s["category"] != "alcohol" and ch in s["allowed_channels"]


def test_property_all_skus_all_channels_ranges():
    a = sc.load_assumptions()
    n = 0
    for s in GOLDEN:
        for ch in sc.ALL_CHANNELS:
            rows = sc.project(s, ch, D(2026, 10, 12), 26, a)
            assert len(rows) == 26
            for r in rows:
                assert set(sc.LEVELS) <= set(r)
                assert all(isinstance(r[lv], int) for lv in sc.LEVELS)
                assert 0 <= r["low"] <= r["base"] <= r["high"], (s, ch, r)
                if not _allowed(s, ch):
                    assert (r["low"], r["base"], r["high"]) == (0, 0, 0)
                    assert r["note"]
                elif RAW["baseline_units_per_week"][s["sku_key"]][ch] > 0:
                    # trend low < high -> khoảng KHÔNG sập thành 1 điểm,
                    # kể cả baseline nhỏ (2-3 đơn vị/tuần).
                    assert r["low"] < r["high"], (s, ch, r)
            n += 1
    assert n == len(GOLDEN) * len(sc.ALL_CHANNELS)


def test_alcohol_zero_online_positive_offline():
    a = sc.load_assumptions()
    assert len(ALCOHOL) == 2
    for s in ALCOHOL:
        # golden vẫn ghi allowed_channels ["shopee"] — engine bỏ qua.
        for ch in golden_store.CHANNELS:
            for r in sc.project(s, ch, D(2026, 10, 12), 26, a):
                assert (r["low"], r["base"], r["high"]) == (0, 0, 0)
                assert r["note"] == sc.NOTE_ALCOHOL
        off = sc.project(s, sc.OFFLINE, D(2026, 10, 12), 26, a)
        assert all(r["low"] > 0 and r["note"] is None for r in off)


def test_alcohol_zero_online_even_with_baseline():
    # Có ai nhỡ thêm baseline online cho rượu thì vẫn 0 (luật trước tra cứu).
    doc = _a()
    doc["baseline_units_per_week"]["ruou-sam-binh-su-do-500ml"]["shopee"] = 50
    rows = sc.project(SKUS["ruou-sam-binh-su-do-500ml"], "shopee",
                      D(2026, 10, 12), 4, doc)
    assert all(r["base"] == 0 for r in rows)


def test_channel_outside_allowed_is_zero_with_note():
    a = sc.load_assumptions()
    assert SKUS["saphraton-40v"]["allowed_channels"] == []
    rows = sc.project(SKUS["saphraton-40v"], "shopee", D(2026, 10, 12), 4, a)
    assert all((r["low"], r["base"], r["high"]) == (0, 0, 0) for r in rows)
    assert all(r["note"] == sc.NOTE_NOT_ALLOWED for r in rows)
    rows = sc.project(SKUS["saphraton-20v"], "tiktok", D(2026, 10, 12), 2, a)
    assert all(r["base"] == 0 and r["note"] for r in rows)
    off = sc.project(SKUS["saphraton-40v"], sc.OFFLINE, D(2026, 10, 12), 2, a)
    assert all(r["base"] > 0 for r in off)


def test_forged_validated_marker_still_validated():
    doc = _a(_validated=True)
    doc["trend"]["low"] = 9
    with pytest.raises(sc.ScenarioError):
        sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 2, doc)


def test_missing_baseline_is_error_not_zero():
    doc = _a()
    del doc["baseline_units_per_week"]["saphraton-20v"]["shopee"]
    with pytest.raises(sc.ScenarioError, match="thiếu baseline"):
        sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 2, doc)


def test_bad_params():
    a = sc.load_assumptions()
    s = SKUS["saphraton-20v"]
    for ch in ("lazada", "", None):
        with pytest.raises(sc.ScenarioError):
            sc.project(s, ch, D(2026, 10, 12), 2, a)
    for w in (0, 105, -1, True, "13", 2.0):
        with pytest.raises(sc.ScenarioError):
            sc.project(s, "shopee", D(2026, 10, 12), w, a)
    with pytest.raises(sc.ScenarioError):
        sc.project(s, "shopee", "2026-10-12", 2, a)
    with pytest.raises(sc.ScenarioError):
        sc.project({}, "shopee", D(2026, 10, 12), 2, a)
    # start sát biên `date` -> ScenarioError, không OverflowError lọt ra
    for st in (D(9999, 12, 31), D(1, 1, 1), D(1999, 12, 31),
               dt.datetime(9999, 12, 31, 23, 0, tzinfo=dt.UTC),
               D(2101, 1, 3)):
        with pytest.raises(sc.ScenarioError, match="start"):
            sc.project(s, "shopee", st, 2, a)
    # biên trong khung vẫn chạy đủ MAX_WEEKS
    rows = sc.project(s, "shopee", sc.DATE_MAX, sc.MAX_WEEKS, a)
    assert len(rows) == sc.MAX_WEEKS
    assert len(sc.project(s, "shopee", sc.DATE_MIN, 1, a)) == 1


def _mini(events, trend=None):
    return {"status": "GIẢ ĐỊNH test",
            "trend": trend or {"low": 1, "base": 1, "high": 1},
            "baseline_units_per_week": {"saphraton-20v": {"shopee": 10}},
            "events": events}


def test_overlapping_events_take_max_not_product():
    ev = [{"id": "a", "date": "2026-11-11", "window": [
              {"offset": 0, "low": 1.5, "base": 2.0, "high": 3.0}]},
          {"id": "b", "date": "2026-11-12", "window": [
              {"offset": 0, "low": 1.2, "base": 2.5, "high": 2.6}]}]
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 11, 9), 1,
                      _mini(ev))
    r = rows[0]
    assert r["events"] == ["a", "b"]
    assert (r["low"], r["base"], r["high"]) == (15, 25, 30)   # max, không nhân


def test_rounding_asymmetric_monotone():
    # thấp = floor, cơ sở = nửa-lên, cao = ceil.
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 1,
                      _mini([], {"low": 0.25, "base": 0.35, "high": 0.45}))
    assert (rows[0]["low"], rows[0]["base"], rows[0]["high"]) == (2, 4, 5)
    # nhiễu float: 25*0.28 = 7.000000000000001 (ceil lên 8 sai),
    # 25*1.16 = 28.999999999999996 (floor xuống 28 sai) -> round 6 số lẻ.
    for t, want in ((0.28, 7), (1.16, 29)):
        doc = _mini([], {"low": t, "base": t, "high": t})
        doc["baseline_units_per_week"]["saphraton-20v"]["shopee"] = 25
        r = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 1,
                       doc)[0]
        assert (r["low"], r["base"], r["high"]) == (want, want, want), t


def test_small_baseline_range_not_collapsed():
    # baseline 3/tuần × trend 0.85/1.0/1.15 từng ra 3|3|3 (floor(x+0.5)).
    a = sc.load_assumptions()
    r = sc.project(SKUS["saphraton-80v"], "shopee", D(2026, 10, 12), 1, a)[0]
    assert (r["low"], r["base"], r["high"]) == (2, 3, 4)
    r = sc.project(SKUS["da-an-sam-30v"], sc.OFFLINE, D(2026, 10, 12), 1, a)[0]
    assert (r["low"], r["base"], r["high"]) == (1, 2, 3)


def test_marketplace_events_skip_offline():
    """11.11/12.12 = ngày sale sàn: kênh offline (đại lý) tuần đó = baseline
    × trend, không có id sự kiện; Tết vẫn áp offline."""
    a = sc.load_assumptions()
    for ev in RAW["events"]:
        if ev["id"] in ("11.11", "12.12"):
            assert sorted(ev["channels"]) == sorted(golden_store.CHANNELS)
        else:
            assert "channels" not in ev
    s = SKUS["saphraton-40v"]
    b = RAW["baseline_units_per_week"]["saphraton-40v"][sc.OFFLINE]
    plain = sc.project(s, sc.OFFLINE, D(2026, 10, 12), 1, a)[0]
    for wk in (D(2026, 11, 9), D(2026, 12, 7)):
        r = sc.project(s, sc.OFFLINE, wk, 1, a)[0]
        assert r["events"] == []
        assert (r["low"], r["base"], r["high"]) == (
            plain["low"], plain["base"], plain["high"])
    assert plain["base"] == b
    on = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 11, 9), 1, a)[0]
    assert on["events"] == ["11.11"] and on["base"] > 12
    tet = sc.project(s, sc.OFFLINE, D(2027, 1, 18), 1, a)[0]
    assert tet["events"] == ["tet_2027"] and tet["base"] > b


def test_event_channels_limits_scope():
    ev = [{"id": "x", "date": "2026-11-11", "channels": ["tiktok"],
           "window": [{"offset": 0, "low": 2, "base": 2, "high": 2}]}]
    r = sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 11, 9), 1,
                   _mini(ev))[0]
    assert r["events"] == [] and r["base"] == 10


def test_overflow_in_project_is_scenario_error():
    # số hữu hạn nhưng tích tràn inf (1e300 × 1e300) -> lỗi rõ, không
    # OverflowError ở math.floor.
    doc = _mini([], {"low": 1, "base": 1, "high": 1e300})
    doc["baseline_units_per_week"]["saphraton-20v"]["shopee"] = 1e300
    with pytest.raises(sc.ScenarioError, match="tràn"):
        sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 1, doc)


def test_event_below_one_in_tet_week():
    a = sc.load_assumptions()
    rows = sc.project(SKUS["saphraton-20v"], "shopee", D(2027, 1, 18), 3, a)
    # tuần trước Tết cao, tuần Tết thấp hơn baseline (nghỉ Tết).
    assert rows[0]["base"] > 12 and rows[2]["base"] < 12


# ---------- config hỏng: fail-closed mọi biến thể ----------

@pytest.mark.parametrize("content", [
    None, "", "   \n", "{not json", "{}", '{"_doc": "x"}', "[]", "null",
])
def test_load_assumptions_no_data_variants(tmp_path, content):
    p = tmp_path / "a.json"
    if content is not None:
        p.write_text(content, encoding="utf-8")
    with pytest.raises(sc.ScenarioError):
        sc.load_assumptions(p)


def _bad_variants():
    def event_date_0001_offset_neg(d):
        d["events"][0]["date"] = "0001-01-01"
        d["events"][0]["window"][0]["offset"] = -1

    def event_date_9999_offset_pos(d):
        d["events"][0]["date"] = "9999-12-31"
        d["events"][0]["window"][0]["offset"] = 1

    def event_date_out_of_range(d):
        d["events"][0]["date"] = "2101-01-01"

    def trend_low_gt_base(d):
        d["trend"]["low"] = 1.5

    def window_base_gt_high(d):
        d["events"][0]["window"][0]["base"] = 9

    def negative(d):
        d["baseline_units_per_week"]["saphraton-20v"]["shopee"] = -1

    def bool_number(d):
        d["trend"]["base"] = True

    def nan_number(d):
        d["trend"]["high"] = float("nan")

    def str_number(d):
        d["events"][1]["window"][0]["high"] = "2"

    def both_date_and_lunar(d):
        d["events"][2]["date"] = "2027-02-06"

    def neither_date_nor_lunar(d):
        del d["events"][0]["date"]

    def dup_offset(d):
        d["events"][2]["window"][1]["offset"] = -6

    def lunar_out_of_table(d):
        d["events"][2]["lunar_new_year"] = 2031

    def bad_channel(d):
        d["baseline_units_per_week"]["saphraton-20v"]["lazada"] = 1

    def no_status(d):
        del d["status"]

    def empty_baseline(d):
        d["baseline_units_per_week"] = {}

    def dup_event_id(d):
        d["events"][1]["id"] = "11.11"

    def bool_offset(d):
        d["events"][0]["window"][0]["offset"] = True

    def lunar_list(d):
        d["events"][2]["lunar_new_year"] = [2027]      # unhashable

    def lunar_float(d):
        d["events"][2]["lunar_new_year"] = 2027.0      # hash == 2027

    def huge_int_trend(d):
        d["trend"]["high"] = 10 ** 400

    def huge_int_baseline(d):
        d["baseline_units_per_week"]["saphraton-20v"]["shopee"] = 10 ** 400

    def huge_int_window(d):
        d["events"][0]["window"][0]["high"] = 10 ** 400

    def huge_offset(d):
        d["events"][0]["window"][0]["offset"] = 10 ** 12

    def offset_over_max(d):
        d["events"][0]["window"][0]["offset"] = sc.MAX_WEEKS + 1

    def channels_bad(d):
        d["events"][0]["channels"] = ["lazada"]

    def channels_empty(d):
        d["events"][0]["channels"] = []

    def channels_not_list(d):
        d["events"][0]["channels"] = "shopee"

    def channels_dup(d):
        d["events"][0]["channels"] = ["shopee", "shopee"]

    return [trend_low_gt_base, window_base_gt_high, negative, bool_number,
            nan_number, str_number, both_date_and_lunar,
            neither_date_nor_lunar, dup_offset, lunar_out_of_table,
            bad_channel, no_status, empty_baseline, dup_event_id, bool_offset,
            lunar_list, lunar_float, huge_int_trend, huge_int_baseline,
            huge_int_window, huge_offset, offset_over_max, channels_bad,
            channels_empty, channels_not_list, channels_dup,
            event_date_0001_offset_neg, event_date_9999_offset_pos,
            event_date_out_of_range]


@pytest.mark.parametrize("mutate", _bad_variants(), ids=lambda f: f.__name__)
def test_invalid_assumptions_rejected(tmp_path, mutate):
    doc = _a()
    mutate(doc)
    with pytest.raises(sc.ScenarioError):
        sc.validate_assumptions(doc)
    # project() trên doc thô cũng validate — không trả số câm.
    with pytest.raises(sc.ScenarioError):
        sc.project(SKUS["saphraton-20v"], "shopee", D(2026, 10, 12), 2, doc)
    p = tmp_path / "a.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(sc.ScenarioError):
        sc.load_assumptions(p)


def test_nan_literal_in_file_rejected(tmp_path):
    p = tmp_path / "a.json"
    p.write_text(sc.ASSUMPTIONS_FILE.read_text(encoding="utf-8").replace(
        '"high": 1.15', '"high": NaN'), encoding="utf-8")
    with pytest.raises(sc.ScenarioError):
        sc.load_assumptions(p)


def test_repo_assumptions_status_is_placeholder():
    assert "GIẢ ĐỊNH" in RAW["status"]
    assert "GIẢ ĐỊNH" in RAW["_doc"]
    assert "fixture" in RAW["_doc"].lower()
    assert sc.load_assumptions()["status"] == RAW["status"]


def test_module_is_pure():
    src = (ROOT / "pipelines" / "scenario.py").read_text(encoding="utf-8")
    assert not re.search(r"^(import|from) (psycopg|openai|httpx|requests)",
                         src, re.MULTILINE)
    assert "llm_gateway" not in src
    me = Path(__file__).read_text(encoding="utf-8")
    for bad in ("time." + "sleep", "datetime." + "now", "date." + "today"):
        assert bad not in me
    # đọc đồng hồ chỉ trong main()
    body = src[:src.index("def main(")]
    assert ".now(" not in body and "today(" not in body


# ---------- CLI ----------

_DATA_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \|", re.MULTILINE)


def test_cli_table_13_weeks(capsys):
    rc = sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                  "--weeks", "13", "--start", "2026-10-12"])
    out = capsys.readouterr().out
    assert rc == 0
    assert len(_DATA_LINE.findall(out)) == 13
    assert "GIẢ ĐỊNH" in out and "KHÔNG phải doanh số cam kết" in out


def test_cli_json(capsys):
    rc = sc.main(["--sku", "ruou-sam-chai-thuy-tinh-500ml", "--channel",
                  "shopee", "--weeks", "13", "--start", "2026-10-12", "--json"])
    cap = capsys.readouterr()
    rows = json.loads(cap.out)
    assert rc == 0 and len(rows) == 13
    assert all({"low", "base", "high", "week_start", "events", "note"} <= set(r)
               for r in rows)
    assert all(r["low"] == r["base"] == r["high"] == 0 for r in rows)
    assert "GIẢ ĐỊNH" in cap.err


def test_cli_errors(capsys, monkeypatch, tmp_path):
    assert sc.main(["--sku", "khong-co", "--channel", "shopee"]) == 1
    assert "[err]" in capsys.readouterr().err
    with pytest.raises(SystemExit) as e:
        sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                 "--weeks", "abc"])
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        sc.main(["--channel", "shopee"])
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                 "--start", "12/10/2026"])
    assert e.value.code == 2
    # ngày hợp lệ ISO nhưng sát biên `date` -> exit 2 usage, không traceback
    for bad_start in ("9999-12-20", "0001-01-01", "1999-12-31", "2101-01-01"):
        with pytest.raises(SystemExit) as e:
            sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                     "--weeks", "13", "--start", bad_start])
        assert e.value.code == 2
        assert "2000-01-01..2100-12-31" in capsys.readouterr().err
    with pytest.raises(SystemExit) as e:
        sc.main(["--sku", "saphraton-20v", "--channel", "lazada"])
    assert e.value.code == 2
    capsys.readouterr()
    # config giả định hỏng -> exit 1, không traceback
    bad = tmp_path / "a.json"
    bad.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sc, "ASSUMPTIONS_FILE", bad)
    assert sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                    "--start", "2026-10-12"]) == 1
    assert "[err]" in capsys.readouterr().err
    # golden hỏng -> exit 1
    monkeypatch.setattr(sc, "GOLDEN_FILE", tmp_path / "missing.json")
    assert sc.main(["--sku", "saphraton-20v", "--channel", "shopee"]) == 1


def test_cli_missing_baseline_exit_1(monkeypatch, tmp_path, capsys):
    doc = _a()
    del doc["baseline_units_per_week"]["saphraton-20v"]["offline"]
    p = tmp_path / "a.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(sc, "ASSUMPTIONS_FILE", p)
    assert sc.main(["--sku", "saphraton-20v", "--channel", "offline",
                    "--start", "2026-10-12"]) == 1
    assert "thiếu baseline" in capsys.readouterr().err


def _cli_lunar_list(d):
    d["events"][2]["lunar_new_year"] = [2027]


def _cli_huge_int(d):
    d["trend"]["high"] = 10 ** 400


def _cli_huge_offset(d):
    d["events"][0]["window"][0]["offset"] = 10 ** 12


def _cli_overflow_product(d):
    d["trend"]["high"] = 1e300
    d["baseline_units_per_week"]["saphraton-20v"]["shopee"] = 1e300


@pytest.mark.parametrize("mutate", [_cli_lunar_list, _cli_huge_int,
                                    _cli_huge_offset, _cli_overflow_product],
                         ids=lambda f: f.__name__)
def test_cli_broken_config_variants_exit_1(monkeypatch, tmp_path, capsys,
                                           mutate):
    """Biến thể từng lọt TypeError/OverflowError -> traceback; phải [err]
    exit 1 (W73.2)."""
    doc = _a()
    mutate(doc)
    p = tmp_path / "a.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(sc, "ASSUMPTIONS_FILE", p)
    assert sc.main(["--sku", "saphraton-20v", "--channel", "shopee",
                    "--start", "2026-10-12"]) == 1
    assert "[err]" in capsys.readouterr().err


def test_cli_subprocess_default_console():
    # Không ép PYTHONIOENCODING — console mặc định không UnicodeEncodeError.
    r = subprocess.run(
        [sys.executable, "-m", "pipelines.scenario", "--sku",
         "ruou-sam-chai-thuy-tinh-500ml", "--channel", "shopee", "--weeks",
         "2", "--start", "2026-10-12"],
        cwd=ROOT, capture_output=True, timeout=60, check=False)
    assert r.returncode == 0, r.stderr[-500:]
    out = r.stdout.decode("utf-8")
    assert "rượu: chỉ kênh offline" in out
