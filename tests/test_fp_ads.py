"""v9.1 W91.3 — FP-AdsBudget (`agents.fp_ads`): đề xuất ngân sách ads theo
biên gộp + readiness → 1 mục ĐỀ XUẤT `budget_change` trong hàng duyệt.

Thuần: thứ tự ưu tiên mã, ngưỡng đọc từ cfg, biên đúng bằng ngưỡng. DB
thật: schema tạm + rollback (fixture `db` của tests/test_fp_pnl.py), view
`sku_readiness` thật — chỉnh `sku_master` trong schema tạm cho case
QC_DAY_DU / TP_THUONG.
"""

import json
import re
from decimal import Decimal
from pathlib import Path

import pytest

from agents import fp_ads as fa
from agents import fp_pnl as fp
from pipelines import approval_queue as aq
from tests.test_fp_pnl import (
    OCT,
    _TxConn,
    add_costs,
    fpa_conn,
    load_fixtures,
)

ROOT = Path(__file__).resolve().parent.parent
CFG = {"min_gross_margin_pct": Decimal("0.3"),
       "budget_share_of_margin": Decimal("0.2"), "channels": ["shopee"]}
ALCOHOL = ("ruou-sam-chai-thuy-tinh-500ml", "ruou-sam-binh-su-do-500ml")
BAN = re.compile(r"rượu|ruou|alcohol", re.IGNORECASE)


@pytest.fixture
def db():
    yield from fpa_conn()


def _cell(sku, bien, lai=1_000_000, ch="shopee"):
    return {"sku_key": sku, "channel": ch, "lai_gop": lai,
            "bien_gop_pct": None if bien is None else Decimal(str(bien)),
            "nhan": None}


def _one(props, sku, ch="shopee"):
    (p,) = [p for p in props if p["sku_key"] == sku and p["channel"] == ch]
    return p["code"], p["budget_vnd"]


def test_config_assumed_and_validated(tmp_path):
    raw = (ROOT / "data" / "fpa_config.json").read_text(encoding="utf-8")
    assert "GIẢ ĐỊNH" in raw and json.loads(raw)["confirmed_by"] is None
    cfg, why = fa.load_cfg()
    assert why is None and cfg["min_gross_margin_pct"] == Decimal("0.3")
    for mut, needle in (({"min_gross_margin_pct": 1.5}, "ngoài 0..1"),
                        ({"budget_share_of_margin": "0.2"}, "phải là số"),
                        ({"channels": ["shopee", "lazada"]}, "ads.channels"),
                        ({"channels": []}, "ads.channels")):
        doc = json.loads(raw)
        doc["ads"].update(mut)
        p = tmp_path / "c.json"
        p.write_text(json.dumps(doc), encoding="utf-8")
        cfg, why = fa.load_cfg(p)
        assert cfg is None and needle in why, (mut, why)
    p.write_text("{", encoding="utf-8")
    assert fa.load_cfg(p)[0] is None
    p.write_text("{}", encoding="utf-8")
    assert "thiếu mục 'ads'" in fa.load_cfg(p)[1]


def test_propose_priority_codes():
    rd = {("ruou-x", "shopee"): "CAM", ("tp-mota", "shopee"): "MO_TA",
          ("tp-qc", "shopee"): "QC_DAY_DU", ("food-ok", "shopee"):
          "TP_THUONG", ("food-cam", "shopee"): "CAM",
          ("thieu", "shopee"): "QC_DAY_DU", ("thieu-gv", "shopee"):
          "QC_DAY_DU", ("bang", "shopee"): "QC_DAY_DU",
          ("duoi", "shopee"): "TP_THUONG"}
    cells = [_cell("ruou-x", 90), _cell("tp-mota", 80), _cell("tp-qc", 50),
             _cell("food-ok", 45), _cell("food-cam", 60),
             _cell("thieu-gv", None, None), _cell("bang", 30.0, 500_000),
             _cell("duoi", 29.9), _cell("la", 70)]
    props = fa.propose(cells, rd, CFG)
    assert _one(props, "ruou-x") == ("CHAN_CAM", 0)
    assert _one(props, "tp-mota") == ("CHAN_XNQC", 0)
    assert _one(props, "tp-qc") == ("DE_XUAT", 200_000)
    assert _one(props, "food-ok") == ("DE_XUAT", 200_000)
    assert _one(props, "food-cam") == ("CHAN_CAM", 0)
    assert _one(props, "thieu") == ("CHO_DU_LIEU", 0)        # không có ô
    assert _one(props, "thieu-gv") == ("CHO_DU_LIEU", 0)     # biên None
    assert _one(props, "bang") == ("DE_XUAT", 100_000)       # = ngưỡng
    assert _one(props, "duoi") == ("DUOI_NGUONG", 0)         # -0,1 điểm
    assert _one(props, "la") == ("CHAN_CAM", 0)              # lạ: fail-closed
    assert len(props) == len({(p["sku_key"], p["channel"]) for p in props})
    # ô "(chưa rõ SKU)" không bao giờ thành đề xuất
    props = fa.propose([_cell(fp.UNKNOWN_SKU, 90)], {}, CFG)
    assert props == []


def test_threshold_read_from_cfg_and_negative_margin():
    rd = {("a", "shopee"): "QC_DAY_DU"}
    assert _one(fa.propose([_cell("a", 25)], rd, CFG), "a")[0] == \
        "DUOI_NGUONG"
    lo = {**CFG, "min_gross_margin_pct": Decimal("0.2")}
    assert _one(fa.propose([_cell("a", 25)], rd, lo), "a") == ("DE_XUAT",
                                                               200_000)
    zero = {**CFG, "min_gross_margin_pct": Decimal(0)}
    assert _one(fa.propose([_cell("a", 0, 0)], rd, zero), "a") == (
        "AM_BIEN", 0)
    assert _one(fa.propose([_cell("a", -5, -10)], rd, CFG), "a")[0] == \
        "DUOI_NGUONG"
    # hệ số đọc từ cfg + ROUND_HALF_UP
    half = {**CFG, "budget_share_of_margin": Decimal("0.5")}
    assert _one(fa.propose([_cell("a", 50, 3)], rd, half), "a") == (
        "DE_XUAT", 2)


def test_payload_hides_cam_names_and_states_no_spend():
    rd = {(ALCOHOL[0], "shopee"): "CAM", ("savina-12v", "shopee"):
          "QC_DAY_DU"}
    props = fa.propose([_cell(ALCOHOL[0], 90), _cell("savina-12v", 50)], rd,
                       CFG)
    text = fa.render_payload(OCT, props, CFG)
    assert not BAN.search(text)
    assert "1 cặp SKU × kênh (1 SKU) readiness CAM" in text
    assert "agent không chi tiền" in text and "`savina-12v`" in text
    from pipelines.guardrail import check
    assert check(text)["ok"] is True


def test_module_has_no_network_or_spend_calls():
    src = (ROOT / "agents" / "fp_ads.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|httpx|requests|urllib|llm_gateway|openai",
                         src)


@pytest.mark.parametrize("argv", [["--propose"], ["--propose", "--month",
                                                  "2026-13"], []])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(fa, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        fa.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_bad_cfg_exit1_before_connect(monkeypatch, tmp_path, capsys):
    calls = []
    monkeypatch.setattr(fa, "connect", lambda: calls.append(1))
    bad = tmp_path / "c.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", bad)
    assert fa.main(["--propose", "--month", "2026-10"]) == 1
    assert "không connect" in capsys.readouterr().out and calls == []


# ---------- DB thật ----------

def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(fa, "connect", lambda: _TxConn(db))
    return fa.main(list(argv))


def _items(db):
    return db.execute(
        "select id, object_type, block, risk, status, guardrail->>'ok',"
        " payload, created_by from approval_queue order by id").fetchall()


def test_db_propose_real_readiness(db, monkeypatch, capsys):
    load_fixtures(db, monkeypatch)
    add_costs(db, monkeypatch)
    # schema tạm: savina-12v có XNQC + mở shopee; mật ong 300ml tự công bố;
    # rượu được ghi nhầm đủ mọi thứ → view vẫn CAM.
    db.execute("update sku_master set xnqc_status = 'approved' where"
               " sku_key = 'savina-12v'")
    db.execute("update sku_master set self_declaration_ok = true where"
               " sku_key = 'mat-ong-sam-300ml'")
    db.execute("update sku_master set allowed_channels = '{shopee}',"
               " xnqc_status = 'approved', self_declaration_ok = true where"
               " category = 'alcohol'")
    res = fp.compute(db, OCT)
    rd = fa.fetch_readiness(db, ["shopee"])
    props = fa.propose(res["cells"], rd, CFG)
    by = {p["sku_key"]: p for p in props}
    assert (by["savina-12v"]["code"], by["savina-12v"]["budget_vnd"]) == (
        "DE_XUAT", round(Decimal(621289) * Decimal("0.2")))
    assert by["mat-ong-sam-300ml"]["code"] == "DE_XUAT"
    assert by["mat-ong-sam-300ml"]["budget_vnd"] > 0
    assert by["mat-ong-sam-120ml-1hu"]["code"] == "CHAN_CAM"   # null
    assert by["saphraton-20v"]["code"] == "CHAN_XNQC"          # none
    for k in ALCOHOL:
        assert by[k]["code"] == "CHAN_CAM"
    cats = dict(db.execute("select sku_key, category from sku_master"))
    assert sum(p["budget_vnd"] for p in props
               if cats.get(p["sku_key"]) == "alcohol"
               or rd.get((p["sku_key"], p["channel"])) == "MO_TA") == 0
    # TPBVSK xnqc pending → MO_TA → 0
    db.execute("update sku_master set xnqc_status = 'pending' where"
               " sku_key = 'savina-12v'")
    rd = fa.fetch_readiness(db, ["shopee"])
    assert _one(fa.propose(res["cells"], rd, CFG), "savina-12v") == (
        "CHAN_XNQC", 0)

    assert _cli(db, monkeypatch, "--propose", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    (item,) = _items(db)
    qid, ot, block, risk, status, gok, payload, by_ = item
    assert (ot, block, risk, status, gok, by_) == (
        "budget_change", "finance", "high", "pending", "true", "agent:fp_ads")
    assert f"#{qid}" in out and not BAN.search(out + payload)
    assert not any(k in payload for k in ALCOHOL)
    assert "`mat-ong-sam-300ml` | shopee" in payload and "DE_XUAT" in payload
    # chạy lại → skip, không nhân đôi
    assert _cli(db, monkeypatch, "--propose", "--month", "2026-10") == 0
    assert "[skip]" in capsys.readouterr().out and len(_items(db)) == 1
    # auto_policy đã ký cho budget_change vẫn không duyệt được (risk high)
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('ads_auto',"
               " 'budget_change', 'low', true, 'Chu Khoi Gia Lap (test)',"
               " now())")
    ok, msg = aq.auto_approve(_TxConn(db), qid)
    assert ok is False and "rủi ro high" in msg
    assert _items(db)[0][4] == "pending"
    # tạo song song (kiểm pending lọt) → unique pending chặn → [skip]
    monkeypatch.setattr(fa, "pending_for_month", lambda *_a: None)
    assert _cli(db, monkeypatch, "--propose", "--month", "2026-10") == 0
    assert "song song" in capsys.readouterr().out and len(_items(db)) == 1
    # tháng khác → mục mới
    assert _cli(db, monkeypatch, "--propose", "--month", "2026-09") == 0
    assert len(_items(db)) == 2
