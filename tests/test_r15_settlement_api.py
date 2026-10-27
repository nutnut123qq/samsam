"""r15 — data_platform-06 quyết toán qua API sàn (`ingest.settlement_api` qua
`python -m ingest.market_api --kind settlement`) + farming-01 hạn STT bọc nạp model.

Server giả 127.0.0.1 (đếm request) — không gọi sàn thật. Bảng ánh xạ fixture là
GIẢ, chỉ kiểm cơ chế (không xác nhận cách hạch toán). DB: fixture `db` của
`tests/test_settlement_csv.py` (schema tạm, ROLLBACK cuối test).
"""

import hashlib
import json
import threading

import numpy as np
import pytest
from psycopg.errors import CheckViolation

from connectors import zalo_garden as zg
from ingest import market_api as ma
from ingest import settlement_api as sa
from ingest import settlement_csv as sc
from tests import test_market_api as tma
from tests import test_settlement_csv as tsc

db = tsc.db
servers = tma.servers
CREDS = tma.CREDS
WIN = ["--from", "2026-10-01", "--to", "2026-10-07"]

SP_MAP = {"trang_thai": "da_chot", "duyet_boi": "Kế toán trưởng (GIẢ — test)",
          "can_cu": "FIXTURE test — không phải bảng thật", "ngay_chot": "2026-10-25",
          "tien_te_shop": "VND",
          "thanh_phan": {"escrow_amount": {"cot": "payout", "dau": 1},
                         "order_original_price": {"cot": "order_amount", "dau": 1},
                         "commission_fee": {"cot": "fixed_fee", "dau": 1},
                         "buyer_paid_shipping_fee": {"cot": "shipping_fee", "dau": -1},
                         "actual_shipping_fee": {"cot": "shipping_fee", "dau": 1},
                         "buyer_total_amount": {"bo_qua": True},
                         "items[]": {"bo_qua": True}}}
TT_MAP = {**{k: SP_MAP[k] for k in ("trang_thai", "duyet_boi", "can_cu", "ngay_chot")},
          "thanh_phan": {"settlement_amount": {"cot": "payout", "dau": 1},
                         "revenue_breakdown.subtotal_before_discount_amount": {"cot": "order_amount", "dau": 1},
                         "fee_tax_breakdown.fee.platform_commission_amount": {"cot": "fixed_fee", "dau": -1}},
          "loai_giao_dich": {"ORDER": {"ma_don": "order_id", "txn_type": None},
                             "PLATFORM_PENALTY": {"ma_don": "adjustment_order_id", "txn_type": None},
                             "SHIPPING_FEE_ADJUSTMENT": {"bo_qua": True}}}


@pytest.fixture
def amap(tmp_path, monkeypatch):
    def make(shopee=SP_MAP, tiktok=TT_MAP):
        p = tmp_path / "map.json"
        p.write_text(json.dumps({"shopee": shopee, "tiktok": tiktok}, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(sa, "MAP_FILE", p)
        return p
    return make


def _inc(base=200000, **kw):
    d = {"escrow_amount": base - 20000, "order_original_price": base, "commission_fee": 10000,
         "buyer_paid_shipping_fee": 15000, "actual_shipping_fee": 25000, "buyer_total_amount": base + 15000,
         "pri_currency": "VND", "aff_currency": "VND", "items": [{"item_id": 1, "item_name": "SP GIA"}]}
    d.update(kw)
    return d


def _route(orders, per_page=100):
    """orders: [(sn, payout, release, income)]."""
    def route(m, p, q, body):
        if p == ma.SP_ESCROW_LIST:
            pn = int(q["page_no"][0])
            chunk = orders[(pn - 1) * per_page: pn * per_page]
            return tma._sp_ok({"more": pn * per_page < len(orders), "escrow_list": [
                {"order_sn": sn, "payout_amount": pay, "escrow_release_time": rel} for sn, pay, rel, _ in chunk]})
        if p == ma.SP_ESCROW_DETAIL:
            sn = q["order_sn"][0]
            inc = next(i for s, _p, _r, i in orders if s == sn)
            return tma._sp_ok({"order_sn": sn, "buyer_user_name": "nguoimuagia", "order_income": inc})
        return 404, {"error": "error_not_found"}, None
    return route


def _orders(prefix, n):
    return [(f"{prefix}{i}FAKE", 180000, 1759460000, _inc(200000 + i)) for i in range(n)]


# ---------------------------------------------------------------- ánh xạ (thuần)

def test_repo_map_ships_unapproved_with_null_decisions():
    for ch in ("shopee", "tiktok"):
        cfg, why = sa.load_map(ch)
        assert why and any("chua_chot" in w for w in why)
        assert cfg["thanh_phan"] and all(v is None for v in cfg["thanh_phan"].values())
        assert all(v is None for v in cfg["loai_giao_dich"].values())
    raw = json.loads(sa.MAP_FILE.read_text(encoding="utf-8"))
    assert all(raw[ch]["duyet_boi"] is None and raw[ch]["can_cu"] is None for ch in ("shopee", "tiktok"))


@pytest.mark.parametrize("patch,needle", [
    ({"duyet_boi": "agent:fp01"}, "duyet_boi"), ({"duyet_boi": " System:x"}, "duyet_boi"),
    ({"can_cu": ""}, "can_cu"), ({"ngay_chot": "25/10/2026"}, "ngay_chot"),
    ({"thanh_phan": {**SP_MAP["thanh_phan"], "x": None}}, "null"),
    ({"thanh_phan": {"commission_fee": {"cot": "fixed_fee", "dau": 1}}}, "payout"),
])
def test_map_not_usable_reasons(amap, patch, needle):
    amap({**SP_MAP, **patch})
    _, why = sa.load_map("shopee")
    assert any(needle in w for w in why)


@pytest.mark.parametrize("dec", [{"cot": "thue", "dau": 1}, {"cot": "payout", "dau": 2},
                                 {"cot": "payout", "dau": True}, {"bo_qua": "yes"}, "payout", 1])
def test_map_bad_shape_is_maperror(amap, dec):
    amap({**SP_MAP, "thanh_phan": {**SP_MAP["thanh_phan"], "x": dec}})
    with pytest.raises(sa.MapError):
        sa.load_map("shopee")


def test_to_rows_sums_signs_and_blocks_unknown():
    cfg = {"thanh_phan": SP_MAP["thanh_phan"], "loai_giao_dich": {}, "tien_te_shop": "VND"}
    rec = {"order": "X1FAKE", "type": None, "settled_on": None,
           "comps": sa._flatten(_inc(200000), "t")}
    rows, blocked, errs, status = sa.to_rows("shopee", [rec], cfg)
    assert not blocked and not errs and len(rows) == 1
    r = rows[0]
    assert (r["order_amount"], r["fixed_fee"], r["shipping_fee"], r["payout"]) == (200000, 10000, 10000, 180000)
    assert r["row_no"] == 2 and r["order_id_hash"] == sc.order_hash("shopee", "X1FAKE")
    assert status["items[]"] == "bỏ qua" and "pri_currency" not in status   # chuỗi không phải tiền: bỏ
    rec["comps"]["new_fee"] = 5
    rec["comps"]["buyer_total_amount"] = 1
    _, blocked, _, status = sa.to_rows("shopee", [rec], cfg)
    assert blocked == ["thành phần 'new_fee' LẠ"] and status["new_fee"].startswith("LẠ")


def test_to_rows_list_must_be_skipped_and_null_blocks():
    cfg = {"thanh_phan": {**SP_MAP["thanh_phan"], "items[]": {"cot": "refund", "dau": 1},
                          "commission_fee": None}, "loai_giao_dich": {}, "tien_te_shop": "VND"}
    rec = {"order": "X1FAKE", "type": None, "settled_on": None, "comps": sa._flatten(_inc(), "t")}
    _, blocked, _, _ = sa.to_rows("shopee", [rec], cfg)
    assert any("danh sách" in b for b in blocked) and any("commission_fee' chưa chốt" in b for b in blocked)


def test_tiktok_types_and_duplicate_txn_type_blocked():
    cfg = {"thanh_phan": TT_MAP["thanh_phan"], "loai_giao_dich": TT_MAP["loai_giao_dich"]}

    def rec(typ, oid, adj=None):
        return {"order": None, "type": typ, "settled_on": None,
                "ids": {"order_id": oid, "adjustment_order_id": adj, "associated_order_id": None},
                "comps": {"settlement_amount": "1000",
                          "revenue_breakdown.subtotal_before_discount_amount": "1100",
                          "fee_tax_breakdown.fee.platform_commission_amount": "-100"}}
    rows, blocked, errs, _ = sa.to_rows("tiktok", [rec("ORDER", "T1"), rec("SHIPPING_FEE_ADJUSTMENT", None, "T1")], cfg)
    assert len(rows) == 1 and not blocked and not errs
    _, blocked, _, _ = sa.to_rows("tiktok", [rec("ORDER", "T1"), rec("PLATFORM_PENALTY", None, "T1")], cfg)
    assert any("cùng txn_type" in b for b in blocked)             # 2 giao dịch cùng đơn, cùng nhãn null
    _, blocked, _, _ = sa.to_rows("tiktok", [rec("REBATE", "T2")], cfg)
    assert blocked == ["loại giao dịch 'REBATE' LẠ"]
    _, _, errs, _ = sa.to_rows("tiktok", [rec("PLATFORM_PENALTY", None, None)], cfg)
    assert errs and "adjustment_order_id" in errs[0]


@pytest.mark.parametrize("v,ok", [(12000, 12000), (12000.0, 12000), ("-4000", -4000), ("15.00", 15),
                                  ("", None), (12000.5, "err"), ("1e3", "err"), (True, "err"), ("12.5", "err")])
def test_vnd_parse(v, ok):
    if ok == "err":
        with pytest.raises(ma.DataError) as e:
            sa._vnd(v, "commission_fee", "t")
        assert str(v) not in str(e.value) or str(v) in ("", "True")
    else:
        assert sa._vnd(v, "x", "t") == ok


def test_source_kind(monkeypatch):
    monkeypatch.delenv("TIKTOK_API_ENV", raising=False)
    assert sa.source_kind("shopee", "https://partner.shopeemobile.com") == "api_live"
    assert sa.source_kind("shopee", "https://openplatform.sandbox.test-stable.shopee.sg") == "api_sandbox"
    assert sa.source_kind("shopee", "http://127.0.0.1:5000") == "api_local"
    assert sa.source_kind("shopee", "https://evil.example") == "khong_ro"
    assert sa.source_kind("tiktok", "https://open-api.tiktokglobalshop.com") == "khong_ro"
    monkeypatch.setenv("TIKTOK_API_ENV", "live")
    assert sa.source_kind("tiktok", "https://open-api.tiktokglobalshop.com") == "api_live"


@pytest.mark.parametrize("a,b,ok", [("2026-10-01", "2026-10-31", True), ("2026-10-01", "2026-11-01", False),
                                    ("2026-10-05", "2026-10-04", False), ("2026/10/01", "2026-10-02", False)])
def test_parse_window(a, b, ok):
    assert isinstance(sa.parse_window(a, b), tuple) is ok


def test_path_param_checked_before_request(servers):
    s = servers()
    for bad in ("70/../x", "", "7001?x=1"):
        with pytest.raises(ma.DataError):
            ma._request("tiktok", "GET", ma.TT_STATEMENT_TX, {}, creds=CREDS, base=s.url,
                        path_params={"statement_id": bad})
    with pytest.raises(ma.ScopeError):
        ma._request("tiktok", "GET", ma.TT_STATEMENT_TX, {}, creds=CREDS, base=s.url)
    assert s.requests == []


def test_tiktok_get_has_no_body_and_valid_sign(servers):
    s = servers(lambda *a: tma._tt_ok({"statements": []}))
    ma._request("tiktok", "GET", ma.TT_STATEMENTS, {"page_size": 100}, creds=CREDS, base=s.url, timestamp=1700000000)
    r = s.requests[0]
    q = {k: v[0] for k, v in r["query"].items()}
    sign = q.pop("sign")
    assert r["method"] == "GET" and r["body"] == ""
    assert sign == ma.sign_tiktok(CREDS["TIKTOK_APP_SECRET"], ma.TT_STATEMENTS, q, "")


@pytest.mark.parametrize("code,shown", [("income_not_found", "income_not_found"),
                                        ("order_not_found", "order_not_found"), ("error_param", "error_param"),
                                        ("c09222e3fc40ffb25fc947f738b1abf1", "đã ẩn"), ("abc_12", "đã ẩn")])
def test_payment_error_codes_diagnosable(code, shown):
    assert shown in ma._err_code(code, {"K": "SPKEY_SECRET_XYZ"})
    assert "đã ẩn" in ma._err_code("spkey_secret_xyz", {"K": "spkey_secret_xyz"})


# ---------------------------------------------------------------- CLI (server giả, không DB)

def test_unapproved_repo_map_blocks_before_any_request(servers, monkeypatch, capsys):
    s = servers(_route(_orders("A", 2)))
    connects = tma._cli_env(monkeypatch, s.url)
    assert ma.main(["--channel", "shopee", "--kind", "settlement", *WIN]) == 2
    out = capsys.readouterr().out
    assert "[blocked]" in out and "chua_chot" in out and s.requests == [] and connects == []


def test_dry_run_reports_without_db(servers, monkeypatch, capsys, amap):
    amap()
    s = servers(_route(_orders("B", 3), per_page=2))
    connects = tma._cli_env(monkeypatch, s.url)
    monkeypatch.setattr(ma, "job_run", lambda *a: pytest.fail("dry-run không ghi job_runs"))
    assert ma.main(["--channel", "shopee", "--kind", "settlement", *WIN, "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "3 giao dịch → 3 dòng" in out and "nguồn api_local" in out and "escrow_amount: cột payout (+)" in out
    assert connects == [] and "B0FAKE" not in out and "nguoimuagia" not in out
    pages = [r["query"]["page_no"][0] for r in s.requests if r["path"] == ma.SP_ESCROW_LIST]
    assert pages == ["1", "2"]


def test_local_source_cannot_write(servers, monkeypatch, capsys, amap):
    amap()
    s = servers(_route(_orders("C", 1)))
    connects = tma._cli_env(monkeypatch, s.url)
    assert ma.main(["--channel", "shopee", "--kind", "settlement", *WIN]) == 2
    assert "nguồn api_local" in capsys.readouterr().out and s.requests == [] and connects == []


@pytest.mark.parametrize("argv", [["--kind", "settlement"], ["--kind", "settlement", "--from", "2026-10-01"],
                                  ["--kind", "listing", "--dry-run"], ["--kind", "order", *WIN],
                                  ["--kind", "settlement", "--from", "2026-10-01", "--to", "2026-12-01"],
                                  ["--kind", "settlement", *WIN, "--days", "3"]])
def test_settlement_usage_errors(servers, monkeypatch, argv):
    s = servers()
    tma._cli_env(monkeypatch, s.url)
    with pytest.raises(SystemExit) as e:
        ma.main(["--channel", "shopee", *argv])
    assert e.value.code == 2 and s.requests == []


# ---------------------------------------------------------------- DB thật

def _live_cli(db, monkeypatch, s, argv):
    proxy = tsc._TxConn(db)
    tma._cli_env(monkeypatch, s.url)
    monkeypatch.setattr(sa, "source_kind", lambda ch, base: "api_live")   # server giả ⇒ ép nguồn (chỉ test)
    monkeypatch.setattr(sa, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(ma, "job_run", tma._fake_job)
    return ma.main(argv), proxy.committed


def _n(db, sns):
    return db.execute("select count(*) from settlement_rows where order_id_hash = any(%s)",
                      ([sc.order_hash("shopee", x) for x in sns],)).fetchone()[0]


def test_db_write_provenance_replay_and_cross_source(db, servers, monkeypatch, capsys, amap, tmp_path):
    amap()
    od = _orders("D", 2)
    s = servers(_route(od))
    argv = ["--channel", "shopee", "--kind", "settlement", *WIN]
    assert _live_cli(db, monkeypatch, s, argv) == (0, 1)
    rows = db.execute("select source_kind, file_name, row_no, payout_vnd from settlement_rows order by row_no").fetchall()
    assert [r[0] for r in rows] == ["api_live", "api_live"] and rows[0][1].startswith("api-shopee-quyet-toan-")
    assert [r[2] for r in rows] == [2, 3]
    assert db.execute("select count(*) from recon_results").fetchone()[0] == 2
    assert _live_cli(db, monkeypatch, s, argv) == (0, 0)
    assert "[skip]" in capsys.readouterr().out and _n(db, [o[0] for o in od]) == 2
    # CSV cùng đơn → chặn ở loader CSV
    proxy = tsc._TxConn(db)
    monkeypatch.setattr(sc, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(sc, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    f = tmp_path / "q.csv"
    f.write_text("Mã đơn hàng,Giá sản phẩm,Phí cố định,Phí thanh toán,Phí dịch vụ,Tổng tiền đã thanh toán\n"
                 f"{od[0][0]},200000,-10000,0,0,190000\n", encoding="utf-8")
    assert sc.main(["--file", str(f), "--channel", "shopee"]) == 2
    assert "từ API sàn" in capsys.readouterr().out and _n(db, [od[0][0]]) == 1


def test_db_api_blocked_when_csv_exists_and_rollback_on_error(db, servers, monkeypatch, capsys, amap):
    amap()
    od = _orders("E", 2)
    db.execute("insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash,"
               " order_amount_vnd, payout_vnd) values (%s, 'k.csv', 'shopee', 2, %s, 1, 1)",
               (hashlib.sha256(b"r15-e").hexdigest(), sc.order_hash("shopee", od[0][0])))
    s = servers(_route(od))
    assert _live_cli(db, monkeypatch, s, ["--channel", "shopee", "--kind", "settlement", *WIN])[0] == 2
    assert _n(db, [od[1][0]]) == 0
    od2 = _orders("F", 2)
    s2 = servers(_route(od2))

    def boom(*a, **k):
        raise __import__("psycopg").errors.DataException("giả")
    monkeypatch.setattr(sc, "reconcile", boom)
    db.execute("savepoint r15")        # rollback của _TxConn là no-op → savepoint mô phỏng tx thật
    proxy = tsc._TxConn(db)
    proxy.rollback = lambda: db.execute("rollback to savepoint r15")
    tma._cli_env(monkeypatch, s2.url)
    monkeypatch.setattr(sa, "source_kind", lambda ch, base: "api_live")
    monkeypatch.setattr(sa, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(ma, "job_run", tma._fake_job)
    assert ma.main(["--channel", "shopee", "--kind", "settlement", *WIN]) == 1
    assert _n(db, [o[0] for o in od2]) == 0


def test_db_source_kind_constraint(db):
    with pytest.raises(CheckViolation), db.transaction():
        db.execute("insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash,"
                   " order_amount_vnd, payout_vnd, source_kind) values (%s, 'x', 'shopee', 2, %s, 1, 1,"
                   " 'api_sandbox')", ("c" * 64, "d" * 16))
    db.execute("insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash,"
               " order_amount_vnd, payout_vnd) values (%s, 'x', 'shopee', 2, %s, 1, 1)", ("c" * 64, "d" * 16))
    assert db.execute("select source_kind from settlement_rows").fetchone()[0] == "csv"


# ---------------------------------------------------------------- r15-fix1 F2: trường tiền thiếu/null/sai kiểu

FX_TP = {"order_original_price": {"cot": "order_amount", "dau": 1}, "escrow_amount": {"cot": "payout", "dau": 1},
         "commission_fee": {"cot": "fixed_fee", "dau": 1}, "exchange_rate": {"bo_qua": True}}
FX_GOOD = {"order_original_price": 100000, "escrow_amount": 90000, "commission_fee": 10000}
_DROP = object()


def _sp(inc, tp=FX_TP, shop="VND", sn="FX1FAKE"):
    """Đi qua fetch_shopee thật (call giả trong tiến trình) → to_rows."""
    def call(method, path, params, body=None, path_params=None):
        if path == ma.SP_ESCROW_LIST:
            return {"response": {"more": False, "escrow_list": [
                {"order_sn": sn, "payout_amount": 90000, "escrow_release_time": 1759460000}]}}
        return {"response": {"order_sn": sn, "order_income": inc}}
    recs = sa.fetch_shopee(call, sa.date(2026, 10, 1), sa.date(2026, 10, 7))
    return sa.to_rows("shopee", recs, {"thanh_phan": tp, "loai_giao_dich": {}, "tien_te_shop": shop})


@pytest.mark.parametrize("field,val", [
    ("escrow_amount", _DROP), ("escrow_amount", None), ("escrow_amount", "NOT_A_NUMBER"), ("escrow_amount", ""),
    ("escrow_amount", True), ("escrow_amount", 90000.5), ("order_original_price", _DROP),
    ("order_original_price", None), ("commission_fee", _DROP), ("commission_fee", "abc"), ("commission_fee", False)])
def test_fix1_f2_mapped_money_must_be_valid(field, val):
    inc = {k: v for k, v in FX_GOOD.items() if not (k == field and val is _DROP)}
    if val is not _DROP:
        inc[field] = val
    rows, blocked, errs, _ = _sp(inc)
    col = FX_TP[field]["cot"]
    assert errs and any(f"'{field}'" in e and col in e for e in errs) and not blocked
    assert rows and rows[0][col] is None                       # không bao giờ thành 0
    assert sa.check_rows(rows) and all(str(val) not in e for e in errs if val not in (None, "", True, False))


@pytest.mark.parametrize("inc", [{**FX_GOOD, "escrow_amount": 0, "commission_fee": 0, "order_original_price": 0},
                                 {**FX_GOOD, "escrow_amount": "0", "commission_fee": "0"},
                                 {**FX_GOOD, "escrow_amount": 90000.0, "exchange_rate": 0.00004,
                                  "voucher_code": "ABC", "seller_note": None}])
def test_fix1_f2_explicit_zero_and_non_money_fields_ok(inc):
    rows, blocked, errs, status = _sp(inc)
    assert not blocked and not errs and not sa.check_rows(rows)
    assert rows[0]["payout"] == int(float(inc["escrow_amount"]))
    assert "voucher_code" not in status and "seller_note" not in status   # chuỗi/null không ánh xạ ≠ tiền


def test_fix1_f2_khi_vang_bang_0_is_explicit_decision(amap):
    tp = {**FX_TP, "commission_fee": {"cot": "fixed_fee", "dau": 1, "khi_vang": "bang_0"}}
    rows, blocked, errs, status = _sp({k: v for k, v in FX_GOOD.items() if k != "commission_fee"}, tp)
    assert not errs and not blocked and rows[0]["fixed_fee"] == 0 and "vắng = 0" in status["commission_fee"]
    _, _, errs, _ = _sp({**FX_GOOD, "commission_fee": "abc"}, tp)
    assert errs                                                  # sai kiểu vẫn là lỗi dù được phép vắng
    for bad in ({"cot": "payout", "dau": 1, "khi_vang": "bang_0"},
                {"cot": "order_amount", "dau": 1, "khi_vang": "bang_0"},
                {"cot": "fixed_fee", "dau": 1, "khi_vang": "0"}, {"cot": "fixed_fee", "dau": 1, "khi_vang": True}):
        amap({**SP_MAP, "thanh_phan": {**SP_MAP["thanh_phan"], "x": bad}})
        with pytest.raises(sa.MapError):
            sa.load_map("shopee")
    amap({**SP_MAP, "thanh_phan": {**SP_MAP["thanh_phan"],
                                   "x": {"cot": "fixed_fee", "dau": 1, "khi_vang": None}}})
    assert sa.load_map("shopee")[1] == []


def test_fix1_f2_one_bad_order_blocks_whole_batch(monkeypatch, capsys):
    good = [{"order_id_hash": sc.order_hash("shopee", f"G{i}"), "txn_type": None, "row_no": i + 2,
             "settled_on": sa.date(2026, 10, 3), **dict.fromkeys(sc.MONEY, 0), "order_amount": 1, "payout": 1}
            for i in range(3)]
    good[1]["payout"] = None
    monkeypatch.setattr(sa, "_connect", lambda dsn: pytest.fail("không được connect"))
    assert sa._write("shopee", good, "api_live", {}, sa.date(2026, 10, 1), sa.date(2026, 10, 7)) == 1
    assert "dòng 2: cột payout" in capsys.readouterr().out
    for bad in ({"payout": True}, {"payout": 1.0}, {"refund": -1}, {"order_id_hash": "X" * 16},
                {"settled_on": "2026-10-03"}, {"txn_type": ""}):
        assert sa.check_rows([{**good[0], **bad}])
    assert sa.check_rows([good[0]]) == []


TT_FX = {"settlement_amount": "90000", "revenue_breakdown": {"subtotal_before_discount_amount": "100000"},
         "fee_tax_breakdown": {"fee": {"platform_commission_amount": "-10000"}}}


def _tt(body):
    def call(method, path, params, body_=None, path_params=None):
        if path == ma.TT_STATEMENTS:
            return {"data": {"statements": [{"id": "7001", "statement_time": 1759460000, "currency": "VND"}]}}
        return {"data": {"currency": "VND", "transactions": [{"id": "1", "type": "ORDER", "order_id": "T1", **body}]}}
    recs = sa.fetch_tiktok(call, sa.date(2026, 10, 1), sa.date(2026, 10, 7))
    return sa.to_rows("tiktok", recs, {"thanh_phan": TT_MAP["thanh_phan"], "loai_giao_dich": TT_MAP["loai_giao_dich"]})


@pytest.mark.parametrize("patch,ok", [
    ({}, True), ({"settlement_amount": "0"}, True), ({"settlement_amount": ""}, False),
    ({"settlement_amount": None}, False), ({"settlement_amount": _DROP}, False),
    ({"settlement_amount": "abc"}, False), ({"settlement_amount": "1.5"}, False),
    ({"revenue_breakdown": {}}, False), ({"fee_tax_breakdown": {"fee": {"platform_commission_amount": " "}}}, False)])
def test_fix1_f2_tiktok_same_class(patch, ok):
    body = {k: v for k, v in {**TT_FX, **patch}.items() if v is not _DROP}
    rows, blocked, errs, _ = _tt(body)
    assert not blocked
    assert (not errs and not sa.check_rows(rows)) if ok else (errs and sa.check_rows(rows))


# ---------------------------------------------------------------- r15-fix1 F3: đơn vị tiền theo từng trường Shopee

FX_PRI_TP = {"original_price_pri": {"cot": "order_amount", "dau": 1}, "escrow_amount_pri": {"cot": "payout", "dau": 1},
             **{k: {"bo_qua": True} for k in ("order_original_price", "escrow_amount", "commission_fee",
                                               "exchange_rate")}}
FX_PRI = {"original_price_pri": 100000, "escrow_amount_pri": 90000}


@pytest.mark.parametrize("inc,tp,shop,want", [
    ({**FX_GOOD, "pri_currency": "VND", "aff_currency": "VND"}, FX_TP, None, "ok"),
    ({**FX_GOOD, "pri_currency": "USD", "aff_currency": "VND", "exchange_rate": 1}, FX_TP, None, "ok"),
    ({**FX_GOOD, "pri_currency": "USD", "aff_currency": "USD"}, FX_TP, "VND", "err"),
    ({**FX_GOOD, "pri_currency": "VND", "aff_currency": "USD"}, FX_TP, None, "err"),
    ({**FX_GOOD, **FX_PRI, "pri_currency": "VND", "aff_currency": "USD"}, FX_PRI_TP, None, "ok"),
    ({**FX_GOOD, **FX_PRI, "pri_currency": "USD", "aff_currency": "VND"}, FX_PRI_TP, None, "err"),
    (dict(FX_GOOD), FX_TP, None, "blocked"),
    (dict(FX_GOOD), FX_TP, "VND", "ok"),
    ({**FX_GOOD, "pri_currency": "VND"}, FX_TP, "VND", "blocked"),
    ({**FX_GOOD, "pri_currency": None, "aff_currency": None}, FX_TP, None, "blocked"),
    ({**FX_GOOD, "pri_currency": "vnd", "aff_currency": "vnd"}, FX_TP, None, "err"),
])
def test_fix1_f3_currency_per_mapped_field(inc, tp, shop, want):
    rows, blocked, errs, status = _sp(inc, tp, shop)
    assert not any("currency" in k for k in status) and not any("currency" in b for b in blocked)
    if want == "ok":
        assert not blocked and not errs and not sa.check_rows(rows)
    elif want == "err":
        assert errs and any("không phải VND" in e for e in errs) and sa.check_rows(rows)
    else:
        assert blocked and any("đơn vị tiền" in b for b in blocked) and sa.check_rows(rows)
        why = "không có mã" if not any(k in inc for k in sa.SP_CURRENCY) else "thiếu/null mã tiền affiliate"
        assert all(why in b for b in blocked if "đơn vị tiền" in b)


def test_fix1_f3_tien_te_shop_validated(amap):
    assert json.loads(sa.MAP_FILE.read_text(encoding="utf-8"))["shopee"]["tien_te_shop"] is None
    assert sa.load_map("shopee")[0]["tien_te_shop"] is None
    for bad in ("USD", "vnd", 1, ""):
        amap({**SP_MAP, "tien_te_shop": bad})
        with pytest.raises(sa.MapError):
            sa.load_map("shopee")
    amap(tiktok={**TT_MAP, "tien_te_shop": "VND"})
    with pytest.raises(sa.MapError):
        sa.load_map("tiktok")


# ---------------------------------------------------------------- r15-fix1 F1: khóa (kênh, đơn) CSV ↔ API

class _RecConn:
    def __init__(self, iso="read committed", autocommit=False):
        self.sql, self.iso, self.autocommit = [], iso, autocommit

    def execute(self, sql, params=()):
        self.sql.append((sql, params))
        return self

    def fetchone(self):
        return (self.iso,)


def test_fix1_f1_lock_orders_bounded_sorted_and_guarded():
    c = _RecConn()
    hs = {sc.order_hash("tiktok", f"O{i}") for i in range(3000)}
    sc.lock_orders(c, "tiktok", hs)
    keys = [p[0] for s, p in c.sql if "advisory" in s]
    assert len(keys) <= sc.LOCK_BUCKETS and len(keys) == len(set(keys))
    buckets = sorted({int(h, 16) % sc.LOCK_BUCKETS for h in hs})
    assert keys == [sc._lock_key("tiktok", b) for b in buckets]        # thứ tự ngăn tăng dần → không deadlock
    assert sc._lock_key("tiktok", 1) != sc._lock_key("shopee", 1)
    for bad in (_RecConn(iso="repeatable read"), _RecConn(autocommit=True)):
        with pytest.raises(sc.LockError):
            sc.lock_orders(bad, "tiktok", hs)
        assert not any("advisory" in s for s, _ in bad.sql)


def test_db_fix1_same_source_many_transactions_ok(db, monkeypatch, capsys):
    from pipelines import rollout
    monkeypatch.setattr(rollout, "_FORCE_MODE", "van_hanh")
    monkeypatch.setattr(sa, "_connect", lambda _dsn: tsc._TxConn(db))
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    fees = sc.load_fees()[0]
    h = sc.order_hash("tiktok", "SAMEFAKE")

    def row(t, p):
        return {**dict.fromkeys(sc.MONEY, 0), "order_id_hash": h, "order_amount": 100, "payout": p,
                "txn_type": t, "settled_on": sa.date(2026, 10, 3), "row_no": 2}
    W = (sa.date(2026, 10, 1), sa.date(2026, 10, 7))
    assert sa._write("tiktok", [row("ORDER", 90), {**row("PENALTY", -5), "row_no": 3}], "api_live", fees, *W) == 0
    assert sa._write("tiktok", [row("ADJUST", 1)], "api_live", fees, *W) == 0
    assert db.execute("select count(*) from settlement_rows where order_id_hash = %s", (h,)).fetchone()[0] == 3


def test_db_fix1_concurrent_csv_and_api_one_wins(monkeypatch, tmp_path):
    """2 kết nối Postgres THẬT (schema COMMITTED tạm, drop ở finally): CSV main() và API _write() cùng đơn TikTok
    (CSV txn_type null, API 'ORDER' — overlaps không bắt). Sau SELECT thật của cross_source mỗi bên chờ bên kia
    tối đa HOLD giây (timeout = tiếp tục, không ép cả hai vượt khóa); có khóa → bên thứ hai đang chờ khóa
    (pg_locks advisory chưa granted) rồi thấy nguồn khác → [blocked] exit 2, đúng 1 dòng."""
    import concurrent.futures
    import contextlib
    import io
    import os
    import time
    import uuid

    import psycopg

    from pipelines import rollout
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        setup = psycopg.connect(dsn, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    schema = f"t_r15f1_{uuid.uuid4().hex[:12]}"
    conns = []

    def connect(_dsn):
        c = psycopg.connect(dsn, connect_timeout=5)
        c.execute(f"set search_path to {schema}, pg_temp")
        c.execute("set lock_timeout = '30s'")
        c.commit()
        conns.append(c)
        return c
    try:
        setup.execute(f"create schema {schema}")
        with setup.transaction():
            setup.execute(f"set local search_path to {schema}, pg_temp")
            setup.execute(tsc.SCHEMA_SQL)
        monkeypatch.setattr(rollout, "_FORCE_MODE", "van_hanh")
        monkeypatch.setattr(sa, "_connect", connect)
        monkeypatch.setattr(sc, "_connect", connect)
        monkeypatch.setattr(sc, "load_dotenv", lambda *a, **k: None)
        fees = sc.load_fees()[0]
        oid = "RACEFAKE"
        h = sc.order_hash("tiktok", oid)
        f = tmp_path / "race.csv"
        f.write_text("Order/adjustment ID,Total revenue,Platform commission,Transaction fee,Service fee,"
                     f"Total settlement amount,Order settled time\n{oid},100000,-10000,0,0,90000,2026-10-03\n",
                     encoding="utf-8")
        row = {**dict.fromkeys(sc.MONEY, 0), "order_id_hash": h, "order_amount": 100000, "fixed_fee": 10000,
               "payout": 90000, "txn_type": "ORDER", "settled_on": sa.date(2026, 10, 3), "row_no": 2}
        orig, checked, both, start = sc.cross_source, [], threading.Event(), threading.Barrier(2)

        def cross(conn, ch, hs, kind):
            n = orig(conn, ch, hs, kind)
            checked.append((kind, n))
            if len(checked) == 2:
                both.set()
            both.wait(3)
            return n
        monkeypatch.setattr(sc, "cross_source", cross)
        waited = []

        def watch():
            end = time.monotonic() + 15
            while time.monotonic() < end and not waited:
                if setup.execute("select count(*) from pg_locks where locktype = 'advisory' and not granted and"
                                 " database = (select oid from pg_database where datname = current_database())"
                                 ).fetchone()[0]:
                    waited.append(1)
                time.sleep(0.05)

        def go(fn):
            start.wait(20)
            return fn()
        with contextlib.redirect_stdout(io.StringIO()), concurrent.futures.ThreadPoolExecutor(3) as pool:
            w = pool.submit(watch)
            a = pool.submit(go, lambda: sa._write("tiktok", [row], "api_live", fees, sa.date(2026, 10, 1),
                                                  sa.date(2026, 10, 7)))
            b = pool.submit(go, lambda: sc.main(["--file", str(f), "--channel", "tiktok"]))
            codes = sorted([a.result(60), b.result(60)])
            w.result(30)
        n, total = setup.execute(f"select count(*), coalesce(sum(payout_vnd), 0) from {schema}.v_settlement_khoan"
                                 " where order_id_hash = %s", (h,)).fetchone()
        assert codes == [0, 2] and waited and (n, total) == (1, 90000)
        assert sorted(x[1] for x in checked) == [0, 1]                  # bên thứ hai THẤY nguồn kia sau khóa
        assert setup.execute(f"select count(*) from {schema}.settlement_rows").fetchone()[0] == 1
    finally:
        for c in conns:
            c.close()
        setup.execute(f"drop schema if exists {schema} cascade")
        setup.close()


# ---------------------------------------------------------------- farming-01

def test_stt_timeout_covers_model_load(monkeypatch, tmp_path):
    gate = threading.Event()
    monkeypatch.setattr(zg, "_decode_16k", lambda p: np.full(16000, 0.01, dtype=np.float32))

    def hang():
        gate.wait(30)
        raise RuntimeError("không tới")
    monkeypatch.setattr(zg, "_whisper_model", hang)
    monkeypatch.setattr(zg, "STT_TIMEOUT_S", 0.2)
    try:
        with pytest.raises(RuntimeError, match="quá"):
            zg._stt_whisper_local(tmp_path / "a.wav")
    finally:
        gate.set()


def test_stt_model_load_error_message_kept(monkeypatch, tmp_path):
    monkeypatch.setattr(zg, "_decode_16k", lambda p: np.full(16000, 0.01, dtype=np.float32))

    def missing():
        raise RuntimeError("thiếu model Whisper cục bộ (GARDEN_STT_MODEL_DIR phải chứa model.bin) — không tự tải")
    monkeypatch.setattr(zg, "_whisper_model", missing)
    with pytest.raises(RuntimeError, match="thiếu model Whisper"):
        zg._stt_whisper_local(tmp_path / "a.wav")
