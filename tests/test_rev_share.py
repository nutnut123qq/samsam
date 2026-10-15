"""v12.5 B5 — `agents.rev_share`: doanh thu thuần trực tuyến + biên bản đối
soát quý, bảng `revenue_quarters` append-only, role `ben_a_reader`.

Phần thuần không cần DB. Phần DB: schema tạm + `docs/schema.sql` ×2 +
`docs/roles.sql` ×2 → ROLLBACK (`tests.test_ceo_audit.ceo_db`). Dữ liệu giả.
"""

import json
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from psycopg.errors import (
    CheckViolation,
    InsufficientPrivilege,
    RaiseException,
)

from agents import rev_share as rs
from pipelines.period import VN_TZ
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
FEES = list(rs.FEE_COLS)
HASH_RE = re.compile(r"\b[0-9a-f]{16}\b")


@pytest.fixture
def db():
    yield from ceo_db()


def _row(ch="shopee", amount=1000, status="done", refund=0, payout=None,
         fname="f.csv", **fees):
    r = {"channel": ch, "file_name": fname, "order_amount": amount,
         "refund": refund, "status": status,
         **{c: fees.get(c, 0) for c in rs.FEE_COLS}}
    r["payout"] = (amount - sum(fees.values()) - refund
                   if payout is None else payout)
    return r


def _cfg(tmp_path, monkeypatch, **over):
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(over)
    p = tmp_path / "rev_share.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(rs, "CONFIG_FILE", p)
    return p


# ------------------------------------------------------------------ cấu hình

def test_default_config_all_unset():
    cfg = rs.load_config()
    assert cfg["start"] is None and cfg["rate"] is None
    assert cfg["channels"] == ["shopee", "tiktok"]
    assert cfg["fee_cols"] == FEES
    assert [t["muc"] for t in cfg["tiers"]] == [1, 2, 3]
    assert all(t["tu_vnd"] is None and t["ty_le"] is None
               for t in cfg["tiers"])
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    assert "GIẢ ĐỊNH" in raw["_doc"] and "chờ" in raw["_doc"]


@pytest.mark.parametrize("over", [
    {"ty_le_phi_van_hanh": 1.5}, {"ty_le_phi_van_hanh": -0.1},
    {"ty_le_phi_van_hanh": True}, {"ty_le_phi_van_hanh": "5%"},
    {"ngay_bat_dau_van_hanh": "2026-13-01"},
    {"ngay_bat_dau_van_hanh": "20260101"},
    {"ngay_bat_dau_van_hanh": 20260101},
    {"kenh_truc_tuyen": []}, {"kenh_truc_tuyen": ["website"]},
    {"kenh_truc_tuyen": ["shopee", "shopee"]}, {"kenh_truc_tuyen": "shopee"},
    {"phi_san_cot": []}, {"phi_san_cot": ["refund"]},
    {"phi_san_cot": ["fixed_fee", "fixed_fee"]},
    {"muc_thuong": None}, {"muc_thuong": [{"tu_vnd": 1}]},
    {"muc_thuong": [{"muc": 1, "tu_vnd": -1}]},
    {"muc_thuong": [{"muc": 1, "tu_vnd": 1.5}]},
    {"muc_thuong": [{"muc": 1, "ty_le": 2}]},
    {"muc_thuong": [{"muc": 1}, {"muc": 1}]},
])
def test_config_invalid(tmp_path, over):
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(over)
    p = tmp_path / "c.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(rs.ConfigError):
        rs.load_config(p)


def test_config_missing_or_broken(tmp_path):
    with pytest.raises(rs.ConfigError):
        rs.load_config(tmp_path / "khong_co.json")
    p = tmp_path / "c.json"
    p.write_text("{hỏng", encoding="utf-8")
    with pytest.raises(rs.ConfigError):
        rs.load_config(p)
    p.write_text("[]", encoding="utf-8")
    with pytest.raises(rs.ConfigError):
        rs.load_config(p)


def test_config_set_values(tmp_path):
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(ngay_bat_dau_van_hanh="2026-02-15", ty_le_phi_van_hanh=0.05,
               phi_san_cot=["service_fee", "fixed_fee"],
               muc_thuong=[{"muc": 2, "tu_vnd": 9, "ty_le": 0.1},
                           {"muc": 1, "tu_vnd": 1, "ty_le": None}])
    p = tmp_path / "c.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    cfg = rs.load_config(p)
    assert cfg["start"] == date(2026, 2, 15)
    assert cfg["rate"] == Decimal("0.05")
    assert cfg["fee_cols"] == ["fixed_fee", "service_fee"]   # thứ tự cột
    assert [t["muc"] for t in cfg["tiers"]] == [1, 2]


# ------------------------------------------------------------------ kỳ

def test_quarter_range():
    assert rs.quarter_range("2026-Q3", NOW) == (date(2026, 7, 1),
                                                date(2026, 10, 1))
    assert rs.quarter_range("2025-Q4", NOW) == (date(2025, 10, 1),
                                                date(2026, 1, 1))
    for bad in ("2026-Q5", "2026-Q0", "2026Q3", "2026-09", "", None):
        with pytest.raises(ValueError, match="YYYY-Qn"):
            rs.quarter_range(bad, NOW)
    with pytest.raises(ValueError, match="chưa đóng"):           # đang chạy
        rs.quarter_range("2026-Q4", NOW)
    # biên: 00:00 VN ngày đầu quý sau = đã đóng; 1 giây trước = chưa
    edge = datetime(2026, 10, 1, 0, 0, tzinfo=VN_TZ)
    assert rs.quarter_range("2026-Q3", edge)[1] == date(2026, 10, 1)
    with pytest.raises(ValueError, match="chưa đóng"):
        rs.quarter_range("2026-Q3", edge - timedelta(seconds=1))


def test_quarter_range_clipped_by_start():
    assert rs.quarter_range("2026-Q3", NOW, date(2026, 8, 20)) == (
        date(2026, 8, 20), date(2026, 10, 1))
    assert rs.quarter_range("2026-Q3", NOW, date(2026, 1, 1))[0] == date(
        2026, 7, 1)
    with pytest.raises(ValueError, match="trước ngày bắt đầu"):
        rs.quarter_range("2026-Q3", NOW, date(2026, 10, 1))


def test_year_range():
    assert rs.year_range(date(2025, 3, 1), 1, NOW) == (date(2025, 3, 1),
                                                      date(2026, 3, 1))
    with pytest.raises(ValueError, match="chưa đóng"):
        rs.year_range(date(2025, 3, 1), 2, NOW)
    # 29/02 → 01/03 năm thường
    late = datetime(2031, 1, 1, tzinfo=VN_TZ)
    assert rs.year_range(date(2028, 2, 29), 1, late) == (date(2028, 2, 29),
                                                        date(2029, 3, 1))
    for bad in (0, -1, rs.MAX_YEAR + 1, True, "1"):
        with pytest.raises(ValueError, match="--year"):
            rs.year_range(date(2025, 1, 1), bad, NOW)


# ------------------------------------------------------------------ thuần

def test_channel_figures_formula_and_cancel_not_double():
    rows = [_row(amount=1000, fixed_fee=40, voucher_seller=10),
            _row(amount=500, fixed_fee=20, refund=100),
            _row(amount=200, fixed_fee=5, refund=200, status="cancelled")]
    f = rs.channel_figures(rows, FEES)
    assert (f["gross"], f["fee"], f["cancel"], f["refund"]) == (
        1700, 75, 200, 100)
    assert f["net"] == 1700 - 75 - 200 - 100 == f["payout"]
    assert (f["n"], f["n_cancelled"], f["n_unknown"]) == (3, 1, 0)
    # cột không thuộc phi_san_cot không trừ vào phí sàn
    assert rs.channel_figures(rows, ["fixed_fee"])["fee"] == 65


def test_channel_figures_unknown_status_no_guess():
    f = rs.channel_figures([_row(amount=1000), _row(status=None)], FEES)
    assert f["n_unknown"] == 1 and f["cancel"] is None and f["net"] is None
    assert f["gross"] == 2000                     # gộp vẫn có nguồn


def test_summarize_missing_channel_blocks_total():
    s = rs.summarize([_row(amount=1000)], ["shopee", "tiktok"], FEES)
    assert s["channels"]["tiktok"] is None
    assert s["channels"]["shopee"]["net"] == 1000
    assert all(v is None for v in s["total"].values())
    assert any(n.startswith("tiktok: chưa có dữ liệu") for n in s["notes"])
    one = rs.summarize([_row(amount=1000)], ["shopee"], FEES)
    assert one["total"]["net"] == 1000 and one["notes"] == []


def test_summarize_unknown_status_total_none():
    s = rs.summarize([_row(amount=1000, status=None)], ["shopee"], FEES)
    assert s["total"]["net"] is None and s["total"]["gross"] == 1000
    assert "kd_orders --sync" in s["notes"][0]


def test_summarize_refund_over_gross_flagged():
    s = rs.summarize([_row(amount=100, refund=300)], ["shopee"], FEES)
    assert s["total"]["net"] == -200
    assert any("Hoàn" in n and "> Gộp" in n for n in s["notes"])
    assert any("Thuần âm" in n for n in s["notes"])
    assert rs.ops_fee(-200, Decimal("0.05"), date(2026, 1, 1)) == (
        None, "doanh thu thuần âm — 2 bên giải trình (Điều 7.5)")


def test_ops_fee_branches():
    st = date(2026, 1, 1)
    assert rs.ops_fee(1000, None, st)[1] == "chưa chốt tỷ lệ phí vận hành"
    assert rs.ops_fee(1000, Decimal("0.05"), None)[1].startswith(
        "chưa chốt ngày bắt đầu")
    assert rs.ops_fee(None, Decimal("0.05"), st)[1] == (
        "doanh thu thuần chưa có dữ liệu")
    assert rs.ops_fee(0, Decimal("0.05"), st) == (0, None)
    assert rs.ops_fee(10, Decimal("0.05"), st) == (1, None)     # 0.5 → 1
    assert rs.ops_fee(9, Decimal("0.05"), st) == (0, None)      # 0.45 → 0
    assert rs.ops_fee(1_545_000, Decimal("0.05"), st) == (77_250, None)


def test_tier_rows():
    tiers = [{"muc": 1, "tu_vnd": 1000, "ty_le": Decimal("0.1")},
             {"muc": 2, "tu_vnd": 5000, "ty_le": None},
             {"muc": 3, "tu_vnd": None, "ty_le": Decimal("0.2")}]
    r = rs.tier_rows(3005, tiers)
    assert [x["trang_thai"] for x in r] == ["đạt", "chưa đạt",
                                            "chưa chốt ngưỡng"]
    assert (r[0]["vuot"], r[0]["thuong"]) == (2005, 201)        # 200.5 → 201
    assert r[1]["vuot"] is None and r[2]["dat"] is None
    r2 = rs.tier_rows(6000, tiers[1:2])
    assert r2[0]["vuot"] == 1000 and r2[0]["thuong"] is None   # tỷ lệ null
    assert rs.tier_rows(None, tiers[:1])[0]["trang_thai"] == "chưa có dữ liệu"
    assert rs.tier_rows(1000, tiers[:1])[0]["dat"] is True       # biên =


# ------------------------------------------------------------------ DB

_INS = (
    "insert into settlement_rows (file_sha256, file_name, channel, row_no,"
    " order_id_hash, order_amount_vnd, fixed_fee_vnd, payment_fee_vnd,"
    " service_fee_vnd, voucher_seller_vnd, refund_vnd, payout_vnd,"
    " settled_on) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
    " %s)")
FILE = "quyet_toan_0901234567.csv"      # tên file có SĐT giả → phải che


def _seed(db):
    """Quý 2026-Q3: shopee thuần 1.275.000 (1 đơn hủy), tiktok 270.000."""
    n = 0

    def s(ch, h, amount, fixed=0, pay=0, svc=0, vou=0, refund=0, payout=0,
          day=None, status=None):
        nonlocal n
        n += 1
        db.execute(_INS, ("a" * 64 if ch == "shopee" else "b" * 64, FILE,
                          ch, n + 1, h, amount, fixed, pay, svc, vou, refund,
                          payout, day))
        if status:
            db.execute(
                "insert into orders (id, ts, channel, total_vnd, status,"
                " source) values (%s, now(), %s, %s, %s, %s)",
                (f"{ch}:{h}", ch, amount, status, f"market:{ch}"))

    s("shopee", "1" * 16, 1_000_000, 40_000, 30_000, 20_000, 10_000,
      payout=900_000, day=date(2026, 7, 1), status="Hoàn thành")
    s("shopee", "2" * 16, 500_000, 20_000, refund=100_000, payout=380_000,
      day=date(2026, 9, 30), status="Hoàn thành")
    s("shopee", "3" * 16, 200_000, 5_000, refund=200_000, payout=-5_000,
      day=date(2026, 8, 1), status="cancelled")
    s("shopee", "4" * 16, 999, payout=999, day=date(2026, 10, 1),
      status="x")                                         # ngoài kỳ (sau)
    s("shopee", "5" * 16, 777, payout=777, day=date(2026, 6, 30),
      status="x")                                         # ngoài kỳ (trước)
    s("shopee", "6" * 16, 555, payout=555, day=None, status="x")  # không ngày
    s("tiktok", "7" * 16, 300_000, svc=30_000, payout=270_000,
      day=date(2026, 8, 10), status="Completed")


def _run(db, monkeypatch, tmp_path, *argv, log=None):
    monkeypatch.setattr(rs, "connect", lambda: TxConn(db, log))
    return rs.main([*argv, "--out-dir", str(tmp_path)], now=NOW)


def test_fetch_and_summarize_db(db):
    _seed(db)
    rows, undated = rs.fetch(TxConn(db), date(2026, 7, 1), date(2026, 10, 1),
                             ["shopee", "tiktok"])
    assert len(rows) == 4 and undated == {"shopee": 1}
    s = rs.summarize(rows, ["shopee", "tiktok"], FEES)
    sh, tk = s["channels"]["shopee"], s["channels"]["tiktok"]
    assert (sh["gross"], sh["fee"], sh["cancel"], sh["refund"], sh["net"]) \
        == (1_700_000, 125_000, 200_000, 100_000, 1_275_000)
    assert sh["payout"] == 1_275_000
    assert (tk["net"], s["total"]["net"]) == (270_000, 1_545_000)
    # đơn có ở orders nhưng source không phải market:% → không tính trạng thái
    db.execute("update orders set source = 'manual' where id = %s",
               ("shopee:" + "3" * 16,))
    rows, _ = rs.fetch(TxConn(db), date(2026, 7, 1), date(2026, 10, 1),
                       ["shopee"])
    assert rs.summarize(rows, ["shopee"], FEES)["total"]["net"] is None


def test_main_quarter_record(db, monkeypatch, tmp_path):
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2026-01-01",
         ty_le_phi_van_hanh=0.05)
    _seed(db)
    log = []
    assert _run(db, monkeypatch, tmp_path, "--quarter", "2026-Q3",
                "--record", log=log) == 0
    text = (tmp_path / "doi-soat-2026-Q3.md").read_text(encoding="utf-8")
    assert "quý 2026-Q3" in text and "BẢN ĐỀ XUẤT" in text
    assert "1.545.000đ" in text and "1.275.000đ" in text
    assert "| Tỷ lệ phí vận hành | 5% |" in text
    assert "77.250đ" in text
    assert "Điều 7.6" in text and "| (ký, ghi rõ họ tên) |" in text
    assert "shopee: 1 dòng quyết toán không có ngày" in text
    assert "website: chưa có nguồn" in text
    assert not HASH_RE.search(text) and "0901234567" not in text
    row = db.execute(
        "select quarter, period_start, period_end, gross_vnd,"
        " platform_fee_vnd, cancel_vnd, refund_vnd, net_vnd, payout_vnd,"
        " fee_rate, ops_fee_vnd, recorded_by, detail from revenue_quarters"
    ).fetchall()
    assert len(row) == 1
    r = row[0]
    assert r[:12] == ("2026-Q3", date(2026, 7, 1), date(2026, 10, 1),
                      2_000_000, 155_000, 200_000, 100_000, 1_545_000,
                      1_545_000, Decimal("0.05"), 77_250, "agent:rev_share")
    assert not HASH_RE.search(json.dumps(r[12]))
    assert r[12]["channels"]["tiktok"]["net"] == 270_000
    # CHỈ SELECT + 1 insert revenue_quarters
    writes = [q for q in log if not q.lstrip().lower().startswith("select")]
    assert len(writes) == 1 and "insert into revenue_quarters" in writes[0]
    # ghi lại → dòng mới, dòng cũ giữ nguyên
    assert _run(db, monkeypatch, tmp_path, "--quarter", "2026-Q3",
                "--record") == 0
    assert db.execute("select count(*) from revenue_quarters"
                      ).fetchone()[0] == 2


def test_main_quarter_defaults_unset_and_missing_channel(db, monkeypatch,
                                                         tmp_path):
    db.execute(_INS, ("c" * 64, "f.csv", "shopee", 2, "8" * 16, 1000, 0, 0,
                      0, 0, 0, 1000, date(2026, 8, 1)))
    db.execute("insert into orders (id, ts, channel, total_vnd, status,"
               " source) values (%s, now(), 'shopee', 1000, 'ok',"
               " 'market:shopee')", ("shopee:" + "8" * 16,))
    assert _run(db, monkeypatch, tmp_path, "--quarter", "2026-Q3",
                "--record") == 0
    text = (tmp_path / "doi-soat-2026-Q3.md").read_text(encoding="utf-8")
    assert "| Tỷ lệ phí vận hành | chưa chốt |" in text
    assert "— (chưa chốt tỷ lệ phí vận hành)" in text
    assert "tiktok: chưa có dữ liệu" in text
    assert re.search(r"\| \*\*Tổng\*\* \| chưa có dữ liệu", text)
    r = db.execute("select net_vnd, gross_vnd, fee_rate, ops_fee_vnd from"
                   " revenue_quarters").fetchone()
    assert r == (None, None, None, None)


def test_main_dry_run_no_write(db, monkeypatch, tmp_path, capsys):
    _seed(db)
    log = []
    assert _run(db, monkeypatch, tmp_path, "--quarter", "2026-Q3",
                "--dry-run", log=log) == 0
    assert "Biên bản đối soát" in capsys.readouterr().out
    assert not list(tmp_path.glob("doi-soat-*"))
    assert all(q.lstrip().lower().startswith("select") for q in log)
    assert db.execute("select count(*) from revenue_quarters"
                      ).fetchone()[0] == 0


def test_main_year(db, monkeypatch, tmp_path):
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2025-09-01",
         kenh_truc_tuyen=["shopee", "tiktok"],
         muc_thuong=[{"muc": 1, "tu_vnd": 1_000_000, "ty_le": 0.1},
                     {"muc": 2, "tu_vnd": 2_000_000, "ty_le": None},
                     {"muc": 3, "tu_vnd": None, "ty_le": None}])
    _seed(db)
    assert _run(db, monkeypatch, tmp_path, "--year", "1") == 0
    text = (tmp_path / "doi-soat-nam-1.md").read_text(encoding="utf-8")
    # năm 1 = 2025-09-01 → 2026-08-31: shopee 06/30 + 07/01 + 08/01 (hủy),
    # tiktok 08/10 → 777 + 900.000 − 5.000 + 270.000 = 1.165.777
    assert "năm hợp tác thứ 1" in text
    assert "| 1 | 1.000.000đ | 10% | đạt | 165.777đ | 16.578đ |" in text
    assert "| 2 | 2.000.000đ | chưa chốt | chưa đạt | — | — |" in text
    assert "| 3 | chưa chốt | chưa chốt | chưa chốt ngưỡng | — | — |" in text
    assert db.execute("select count(*) from revenue_quarters"
                      ).fetchone()[0] == 0


def test_main_year_needs_start(monkeypatch):
    monkeypatch.setattr(rs, "connect", lambda: pytest.fail("connect"))
    assert rs.main(["--year", "1"], now=NOW) == 1


def test_main_errors_before_connect(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "connect", lambda: pytest.fail("connect"))
    assert rs.main(["--quarter", "2026-Q4"], now=NOW) == 2       # chưa đóng
    assert rs.main(["--quarter", "2026-9"], now=NOW) == 2
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2026-11-01")
    assert rs.main(["--quarter", "2026-Q3"], now=NOW) == 2       # trước vận hành
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2025-12-01")
    assert rs.main(["--year", "1"], now=NOW) == 2                 # chưa đóng
    _cfg(tmp_path, monkeypatch, ty_le_phi_van_hanh=7)
    assert rs.main(["--quarter", "2026-Q3"], now=NOW) == 1       # cấu hình
    for argv in ([], ["--quarter", "2026-Q3", "--year", "1"],
                 ["--quarter", "2026-Q3", "--record", "--dry-run"],
                 ["--year", "1", "--record"],
                 ["--quarter", "2026-Q3", "--now", "hôm qua"]):
        with pytest.raises(SystemExit) as e:
            rs.main(argv, now=NOW)
        assert e.value.code == 2


def test_main_db_down(monkeypatch, tmp_path):
    monkeypatch.setattr(rs, "connect", lambda: None)
    assert rs.main(["--quarter", "2026-Q3", "--out-dir", str(tmp_path)],
                   now=NOW) == 2
    assert not list(tmp_path.iterdir())


def test_revenue_quarters_append_only(db):
    rid = db.execute(
        "insert into revenue_quarters (quarter, period_start, period_end,"
        " report_sha256, recorded_by) values ('2026-Q3', '2026-07-01',"
        " '2026-10-01', %s, 'agent:rev_share') returning id", ("a" * 64,)
    ).fetchone()[0]
    for sql in ("update revenue_quarters set net_vnd = 1",
                "delete from revenue_quarters",
                "truncate revenue_quarters"):
        with pytest.raises(RaiseException), db.transaction():
            db.execute(sql)
    assert db.execute("select id from revenue_quarters").fetchone() == (rid,)
    for bad in ("('2026-Q5', '2026-07-01', '2026-10-01', %s, 'x', null)",
                "('2026-Q3', '2026-10-01', '2026-07-01', %s, 'x', null)",
                "('2026-Q3', '2026-07-01', '2026-10-01', %s, ' ', null)",
                "('2026-Q3', '2026-07-01', '2026-10-01', %s, 'x', 5)"):
        with pytest.raises(CheckViolation), db.transaction():
            db.execute("insert into revenue_quarters (quarter, period_start,"
                       " period_end, report_sha256, recorded_by, ops_fee_vnd)"
                       " values " + bad, ("a" * 64,))


def _denied(db, sql):
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute("set local role ben_a_reader")
        db.execute(sql)


def test_ben_a_reader_role(db):
    _seed(db)
    assert db.execute("select rolcanlogin from pg_roles where rolname ="
                      " 'ben_a_reader'").fetchone() == (False,)
    with db.transaction(force_rollback=True):
        db.execute("set local role ben_a_reader")
        got = db.execute(
            "select channel, sum(order_amount_vnd), sum(payout_vnd) from"
            " v_ben_a_settlement_daily where settled_on >= '2026-07-01' and"
            " settled_on < '2026-10-01' group by 1 order by 1").fetchall()
        assert got == [("shopee", 1_700_000, 1_275_000),
                       ("tiktok", 300_000, 270_000)]
        st = dict(db.execute("select status, sum(n_orders) from"
                             " v_ben_a_orders_daily group by 1").fetchall())
        assert st["cancelled"] == 1
        db.execute("select count(*) from revenue_quarters").fetchone()
    for t in ("settlement_rows", "orders", "market_rows", "contacts",
              "leads", "recon_results"):
        _denied(db, f"select count(*) from {t}")
    _denied(db, "insert into revenue_quarters (quarter, period_start,"
                " period_end, report_sha256, recorded_by) values ('2026-Q3',"
                " '2026-07-01', '2026-10-01', repeat('a', 64), 'x')")
    for role in ("agent_writer", "app_human", "bks_reader"):
        for priv in ("INSERT", "UPDATE", "DELETE"):
            assert db.execute("select has_table_privilege(%s,"
                              " 'revenue_quarters', %s)", (role, priv)
                              ).fetchone()[0] is False


def test_views_no_order_hash_column():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("===== v12.5 B5"):]
    for v in ("v_ben_a_settlement_daily", "v_ben_a_orders_daily"):
        body = block[block.index(f"view {v}"):].split(";", 1)[0]
        assert "order_id_hash" not in body and "o.id" not in body, v


def test_roles_sql_block_narrow():
    roles = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
    block = roles[roles.index("===== v12.5 B5"):]
    grants = re.findall(r"(?is)^grant\b.*?;", block, re.MULTILINE)
    assert len(grants) == 1
    assert re.fullmatch(
        r"(?s)grant select on revenue_quarters, v_ben_a_settlement_daily,"
        r"\s+v_ben_a_orders_daily to ben_a_reader;", grants[0])
    assert "create role ben_a_reader nologin" in block
