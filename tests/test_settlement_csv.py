"""v9.0 W90.1–W90.3 — schema kế toán + ACC-Recon (`ingest.settlement_csv`).

Phần thuần (read_settlement / reconcile_row / argparse) không cần DB. Phần
DB chạy trên `DATABASE_URL` trong 1 transaction + schema tạm (docs/
schema.sql ×2) → ROLLBACK cuối test (mẫu `tests/test_market_csv.py`).
Fixture `tests/fixtures/finance/*_MAU.csv` là dữ liệu TỔNG HỢP: mã đơn
`FAKESET*`, tên/SĐT/địa chỉ người mua GIẢ — khai báo ở `PII` để quét rò rỉ.
"""

import os
import re
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import CheckViolation, UniqueViolation
from psycopg.types.json import Jsonb

from ingest import golden_store as gs
from ingest import market_csv as mc
from ingest import settlement_csv as sc

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "finance"
SETTLE = FIX / "settlement_shopee_MAU.csv"
ORDERS = FIX / "order_shopee_MAU.csv"
# Chuỗi PII GIẢ / mã đơn gốc trong fixture — không được lọt ra rows/stdout.
PII = ("nguoimuagia", "NGUOI NHAN GIA", "DUONG GIA LAP", "GHI CHU GIA",
       "VDGIA", "FAKESET", "090000000")
PII_RE = "|".join(re.escape(p) for p in PII)
EXPECT = {"khop": 9, "lech": 3, "thieu_chung_tu": 2, "hoan": 2}


def _map():
    m, why = sc.load_mapping()
    assert why is None, why
    return m


def _fees():
    f, why = sc.load_fees()
    assert why is None, why
    return f


def _copy(tmp_path, name, transform) -> Path:
    p = tmp_path / name
    p.write_bytes(transform(SETTLE.read_bytes().decode("utf-8"))
                  .encode("utf-8"))
    return p


# ---------- cấu hình ----------

def test_configs_marked_assumed():
    raw_map = (ROOT / "data" / "settlement_map.json").read_text(
        encoding="utf-8")
    raw_fees = (ROOT / "data" / "settlement_fees.json").read_text(
        encoding="utf-8")
    assert "TÊN CỘT GIẢ ĐỊNH" in raw_map and "chưa xác minh" in raw_map
    assert "BIỂU PHÍ GIẢ ĐỊNH" in raw_fees
    m = _map()
    for ch in sc.CHANNELS:
        spec = m[ch]
        heads = [*spec["required"].values(), *spec["optional"].values(),
                 *spec["drop"]]
        assert len(heads) == len(set(heads)), ch
        assert len(spec["drop"]) >= 4, ch      # cột người mua bị bỏ
    f = _fees()
    assert f["shopee"]["fixed_fee_pct"] == Decimal("0.04")


@pytest.mark.parametrize("mut,needle", [
    ({"fixed_fee_pct": 0.6}, "ngoài 0..0.5"),
    ({"payment_fee_pct": "0.05"}, "phải là số"),
    ({"service_fee_pct": True}, "phải là số"),
    ({"tolerance_vnd": 100001}, "tolerance_vnd"),
    ({"tolerance_vnd": 1.5}, "tolerance_vnd"),
])
def test_bad_fees_rejected(tmp_path, mut, needle):
    import json
    raw = json.loads((ROOT / "data" / "settlement_fees.json").read_text(
        encoding="utf-8"))
    raw["shopee"].update(mut)
    p = tmp_path / "fees.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    f, why = sc.load_fees(p)
    assert f is None and needle in why


# ---------- parse thuần ----------

def test_fixture_parses_16_rows_only_standard_keys():
    rows, errs, sha = sc.read_settlement(SETTLE, "shopee", _map())
    assert errs == [] and len(rows) == 16
    assert re.fullmatch(r"[0-9a-f]{64}", sha)
    allowed = (set(sc.FIELDS) - {"order_id"}) | {"row_no", "order_id_hash"}
    for r in rows:
        assert set(r) == allowed
        assert not re.search(PII_RE, repr(r))
    r1 = rows[0]
    # fees_negative: "-12.720" trên file → khoản trừ dương
    assert (r1["order_amount"], r1["fixed_fee"], r1["payout"]) == (
        318000, 12720, 279840)
    assert r1["settled_on"].isoformat() == "2026-10-02"     # DD/MM/YYYY
    assert rows[1]["settled_on"].isoformat() == "2026-10-03"  # ISO
    assert rows[1]["shipping_fee"] == 15000
    assert [r["row_no"] for r in rows] == list(range(2, 18))


def test_order_hash_parity_with_market_csv():
    rows, _, _ = sc.read_settlement(SETTLE, "shopee", _map())
    orows, errs, _ = mc.read_export(ORDERS, "shopee", "order",
                                    mc.load_mapping()[0])
    assert errs == []
    first = {r["order_id_hash"] for r in rows if r["row_no"] == 2}
    assert first & {r["order_id_hash"] for r in orows}
    assert sc.order_hash("shopee", "FAKESET0001") in first
    # cùng công thức market_csv: sha256("kênh:mã")[:16]
    import hashlib
    assert sc.order_hash("tiktok", "X1") == hashlib.sha256(
        b"tiktok:X1").hexdigest()[:16]


def test_to_signed_and_date():
    assert sc._to_signed("-1.234.000") == -1234000
    assert sc._to_signed("1,490,000") == 1490000
    assert sc._to_signed("482.900 ₫") == 482900
    for bad in ("12,5", "--5", "-", "1.234,50", "abc", "1e5"):
        assert sc._to_signed(bad) is None, bad
    assert sc._to_signed("9" * 30) is None
    assert sc._to_date("05/10/2026").isoformat() == "2026-10-05"
    assert sc._to_date("2026-10-05 00:00:00").isoformat() == "2026-10-05"
    for bad in ("2026-13-01", "31/02/2026", "10-05-2026", "hôm qua"):
        assert sc._to_date(bad) is None, bad


def test_renamed_required_header_errors(tmp_path):
    p = _copy(tmp_path, "s.csv", lambda t: t.replace("Phí cố định",
                                                      "Fixed fee", 1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == []
    joined = " | ".join(errs)
    assert "thiếu cột bắt buộc" in joined and "'Phí cố định'" in joined
    assert "cột lạ 'Fixed fee'" in joined


def test_bad_money_cell_names_row_and_field_not_value(tmp_path):
    # ô có dấu nháy để "12,5" là 1 ô (phần thập phân → lỗi, không đoán)
    p = _copy(tmp_path, "s2.csv", lambda t: t.replace(",-12.720,",
                                                       ',"12,5",', 1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == [] and len(errs) == 1
    assert errs[0].startswith("dòng 2: field 'fixed_fee'")
    assert "12,5" not in errs[0]


def test_negative_refund_and_amount_rejected(tmp_path):
    # refund dương trên file (fees_negative) → âm sau chuẩn hóa → lỗi
    p = _copy(tmp_path, "r.csv", lambda t: t.replace(",-299.000,0,",
                                                      ",299.000,0,", 1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == [] and any("'refund' âm" in e for e in errs), errs
    p = _copy(tmp_path, "a.csv", lambda t: t.replace(",318.000,", ",-318.000,",
                                                      1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == [] and any("'order_amount' âm" in e for e in errs)


def test_duplicate_order_and_bad_date(tmp_path):
    p = _copy(tmp_path, "d.csv", lambda t: t.replace("FAKESET0002",
                                                      "FAKESET0001", 1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == [] and errs == [
        "dòng 3: mã đơn trùng dòng 2 (GIẢ ĐỊNH 1 dòng/đơn)"]
    p = _copy(tmp_path, "t.csv", lambda t: t.replace("02/10/2026",
                                                      "32/10/2026", 1))
    rows, errs, _ = sc.read_settlement(p, "shopee", _map())
    assert rows == [] and "dòng 2: field 'settled_on'" in errs[0]
    assert "32/10" not in errs[0]


def test_empty_header_only_suffix(tmp_path):
    hdr = SETTLE.read_bytes().split(b"\n")[0] + b"\n"
    for name, data, needle in (
            ("e.csv", b"", "file rỗng"), ("w.csv", b" \r\n", "file rỗng"),
            ("h.csv", hdr, "chỉ có header"), ("x.txt", hdr, "đuôi '.txt'")):
        p = tmp_path / name
        p.write_bytes(data)
        rows, errs, _ = sc.read_settlement(p, "shopee", _map())
        assert rows == [] and needle in errs[0], name
    rows, errs, _ = sc.read_settlement(SETTLE, "tiktok", _map())
    assert rows == [] and "không khớp header quyết toán tiktok" in errs[0]


# ---------- reconcile_row thuần ----------

FEES0 = {"fixed_fee_pct": Decimal("0.04"), "payment_fee_pct":
         Decimal("0.05"), "service_fee_pct": Decimal("0.03"),
         "tolerance_vnd": 0}


def _row(amount=100000, **over):
    r = {"order_amount": amount, "fixed_fee": 4000, "payment_fee": 5000,
         "service_fee": 3000, "shipping_fee": 0, "voucher_seller": 0,
         "affiliate": 0, "refund": 0}
    r.update(over)
    if "payout" not in over:
        r["payout"] = amount - sum(r[f] for f in sc.DEDUCT)
    return r


def _codes(reasons):
    return [x["code"] for x in reasons]


def test_reconcile_row_labels():
    assert sc.reconcile_row(_row(), 100000, FEES0) == ("khop", [], 88000)
    lb, rs, exp = sc.reconcile_row(_row(payout=87000), 100000, FEES0)
    assert (lb, _codes(rs), exp) == ("lech", ["thuc_nhan"], 88000)
    assert rs[0] == {"code": "thuc_nhan", "expected": 88000, "actual": 87000}
    lb, rs, _ = sc.reconcile_row(_row(fixed_fee=6000), 100000, FEES0)
    assert (lb, _codes(rs)) == ("lech", ["phi_co_dinh"])
    # ngưỡng đọc từ config: pct 6% → cùng dòng thành khớp
    assert sc.reconcile_row(_row(fixed_fee=6000), 100000,
                            {**FEES0, "fixed_fee_pct": Decimal("0.06")}
                            )[0] == "khop"
    lb, rs, _ = sc.reconcile_row(_row(), 120000, FEES0)
    assert (lb, rs) == ("lech", [{"code": "gia_tri_don", "expected": 120000,
                                  "actual": 100000}])
    assert sc.reconcile_row(_row(), None, FEES0)[0] == "thieu_chung_tu"
    lb, rs, exp = sc.reconcile_row(_row(refund=50000, fixed_fee=0), 100000,
                                   FEES0)
    assert lb == "hoan" and "phi_co_dinh" in _codes(rs)
    assert exp == 100000 - 0 - 5000 - 3000 - 50000
    # thiếu chứng từ thắng hoàn
    assert sc.reconcile_row(_row(refund=1), None, FEES0)[0] == \
        "thieu_chung_tu"


def test_reconcile_tolerance_boundary_and_half_up():
    f = {**FEES0, "tolerance_vnd": 100}
    assert sc.reconcile_row(_row(payout=88100), 100000, f)[0] == "khop"
    assert sc.reconcile_row(_row(payout=88101), 100000, f)[1][0]["code"] \
        == "thuc_nhan"
    assert sc.reconcile_row(_row(payout=87900), 100000, f)[0] == "khop"
    assert sc.reconcile_row(_row(payout=87899), 100000, f)[0] == "lech"
    # 12.5 → 13 (ROUND_HALF_UP, không banker's 12)
    assert sc.round_half_up(Decimal(250) * Decimal("0.05")) == 13
    r = _row(amount=250, fixed_fee=10, payment_fee=13, service_fee=8)
    assert sc.reconcile_row(r, 250, FEES0) == ("khop", [], 250 - 31)


def test_fixture_distribution_pure():
    rows, _, _ = sc.read_settlement(SETTLE, "shopee", _map())
    orows, _, _ = mc.read_export(ORDERS, "shopee", "order",
                                 mc.load_mapping()[0])
    tot: dict = {}
    for r in orows:
        tot[r["order_id_hash"]] = tot.get(r["order_id_hash"], 0) + \
            r["price"] * r["qty"]
    got: dict = {}
    for r in rows:
        lb, _rs, _e = sc.reconcile_row(r, tot.get(r["order_id_hash"]),
                                       _fees()["shopee"])
        got[lb] = got.get(lb, 0) + 1
    assert got == EXPECT


# ---------- CLI không DB ----------

def _no_connect(monkeypatch):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(sc, "_connect", lambda dsn: calls.append(dsn))
    return calls


def test_cli_bad_file_exit1_zero_connect(tmp_path, monkeypatch, capsys):
    calls = _no_connect(monkeypatch)
    p = _copy(tmp_path, "s.csv", lambda t: t.replace("Phí cố định",
                                                      "Fixed fee", 1))
    assert sc.main(["--file", str(p), "--channel", "shopee"]) == 1
    out = capsys.readouterr().out
    assert "thiếu cột bắt buộc" in out and "cột lạ" in out
    assert "không connect, không nạp gì" in out
    p = _copy(tmp_path, "d.csv", lambda t: t.replace("FAKESET0002",
                                                      "FAKESET0001", 1))
    assert sc.main(["--file", str(p), "--channel", "shopee"]) == 1
    out = capsys.readouterr().out
    assert not re.search(PII_RE, out)
    assert calls == []


def test_cli_bad_fees_exit1_before_connect(tmp_path, monkeypatch, capsys):
    calls = _no_connect(monkeypatch)
    bad = tmp_path / "fees.json"
    bad.write_text("{", encoding="utf-8")
    real = sc.load_fees
    monkeypatch.setattr(sc, "load_fees", lambda: real(bad))
    assert sc.main(["--reconcile"]) == 1
    assert sc.main(["--file", str(SETTLE), "--channel", "shopee"]) == 1
    assert "không đọc được fees.json" in capsys.readouterr().out
    assert calls == []


@pytest.mark.parametrize("argv", [
    ["--file", "x.csv", "--channel", "shopee", "--report"],
    ["--reconcile", "--report"],
    ["--file", "x.csv"],
    ["--report", "--channel", "shopee"],
    [],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        sc.main(argv)
    assert e.value.code == 2 and calls == []


# ---------- DB thật (schema tạm, rollback) ----------

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


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
        schema = f"t_w90s_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)          # idempotent ×2
        for t in ("settlement_rows", "recon_results", "invoice_lines",
                  "dealer_ar"):
            assert conn.execute("select to_regclass(%s) is not null",
                                (f"{schema}.{t}",)).fetchone()[0], t
        gs.load(conn, __import__("json").loads(
            (ROOT / "data" / "golden_skus.json").read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _bad(db, sql, params=None, exc=CheckViolation):
    with pytest.raises(exc), db.transaction():
        db.execute(sql, params)


H64, H16 = "a" * 64, "b" * 16


def _srow(db, row_no=2):
    return db.execute(
        "insert into settlement_rows (file_sha256, file_name, channel,"
        " row_no, order_id_hash, order_amount_vnd, payout_vnd) values"
        " (%s, 'f.csv', 'shopee', %s, %s, 100, 90) returning id",
        (H64, row_no, H16)).fetchone()[0]


def test_schema_checks(db):
    sid = _srow(db)
    ins = ("insert into recon_results (settlement_row_id, label, reasons,"
           " expected_payout_vnd) values (%s, %s, %s, 0)")
    _bad(db, ins, (sid, "khac", Jsonb([])))
    _bad(db, ins, (sid, "khop", Jsonb([{"code": "thuc_nhan"}])))
    _bad(db, ins, (sid, "lech", Jsonb([])))
    db.execute(ins, (sid, "hoan", Jsonb([])))
    _bad(db, ins, (sid, "khop", Jsonb([])), UniqueViolation)
    _bad(db, "insert into settlement_rows (file_sha256, file_name, channel,"
             " row_no, order_id_hash, order_amount_vnd, refund_vnd,"
             " payout_vnd) values (%s, 'f', 'shopee', 3, %s, 1, -1, 0)",
         (H64, H16))
    ar = ("insert into dealer_ar (file_sha256, file_name, row_no,"
          " dealer_code, dealer_type, kind, doc_date, due_date, amount_vnd)"
          " values (%s, 'f', 2, %s, 'doanh_nghiep', %s, '2026-10-01', %s,"
          " %s)")
    _bad(db, ar, (H64, "DL-01", "thanh_toan", None, 5))
    _bad(db, ar, (H64, "DL-01", "phat_sinh", None, -5))
    _bad(db, ar, (H64, "DL 01", "phat_sinh", None, 5))
    _bad(db, ar, (H64, "DL-01", "phat_sinh", "2026-09-30", 5))
    _bad(db, ar, (H64, "DL-01", "dieu_chinh", None, 0))
    db.execute(ar, (H64, "DL-01", "thanh_toan", None, -5))
    inv = ("insert into invoice_lines (batch_key, batch_date, channel,"
           " order_id_hash, kind, amount_vnd, ref_batch_key) values"
           " ('2026-10-12-abcdef012345', '2026-10-12', 'shopee', %s, %s, 1,"
           " %s)")
    _bad(db, inv, (H16, "dieu_chinh", None))
    _bad(db, inv, (H16, "thuong", "2026-10-11-abcdef012345"))
    _bad(db, inv.replace("2026-10-12-abcdef012345", "LO-1"),
         (H16, "thuong", None))
    db.execute(inv, (H16, "dieu_chinh", "2026-10-11-abcdef012345"))


def _run(db, monkeypatch, *argv):
    proxy = _TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(sc, "_connect", lambda _dsn: proxy)
    return sc.main(list(argv)), proxy.committed


def _load_orders(db, monkeypatch, path=ORDERS):
    proxy = _TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(mc, "_connect", lambda _dsn: proxy)
    assert mc.main(["--file", str(path), "--channel", "shopee", "--kind",
                    "order"]) == 0


def _labels(db):
    return dict(db.execute("select label, count(*) from recon_results"
                           " group by 1").fetchall())


def _orphans(db):
    return db.execute(
        "select count(*) from settlement_rows s left join recon_results r"
        " on r.settlement_row_id = s.id where r.id is null").fetchone()[0]


def test_db_load_reconcile_idempotent_report(db, monkeypatch, capsys):
    _load_orders(db, monkeypatch)
    assert _run(db, monkeypatch, "--file", str(SETTLE), "--channel",
                "shopee") == (0, 1)
    assert db.execute("select count(*) from settlement_rows").fetchone()[0] \
        == 16
    assert db.execute("select count(*) from recon_results").fetchone()[0] \
        == 16
    assert _orphans(db) == 0
    assert _labels(db) == EXPECT
    lech = {r[0] for r in db.execute(
        "select reasons->0->>'code' from recon_results where label ="
        " 'lech'")}
    assert lech == {"thuc_nhan", "phi_co_dinh", "gia_tri_don"}
    hoan = db.execute("select s.refund_vnd from settlement_rows s join"
                      " recon_results r on r.settlement_row_id = s.id where"
                      " r.label = 'hoan' order by s.row_no").fetchall()
    assert [h[0] for h in hoan] == [299000, 100000]
    # nạp lại → skip, không đổi
    assert _run(db, monkeypatch, "--file", str(SETTLE), "--channel",
                "shopee") == (0, 0)
    assert "[skip]" in capsys.readouterr().out
    assert db.execute("select count(*) from settlement_rows").fetchone()[0] \
        == 16
    assert _run(db, monkeypatch, "--report") == (0, 0)
    out = capsys.readouterr().out
    assert "khop=9, lech=3, thieu_chung_tu=2, hoan=2" in out
    assert "settlement_shopee_MAU.csv dòng 11: thuc_nhan chênh -5.000đ" \
        in out
    # dòng tổng: payout file = Σ cột "Tổng tiền đã thanh toán" (6.910.920);
    # tính lại lệch đúng 1 dòng -5.000; affiliate 24.500 + 43.900
    assert ("thực nhận theo file 6.910.920đ; tính lại 6.915.920đ; chênh "
            "-5.000đ; affiliate sàn khấu trừ 68.400đ; đơn ở ≥2 file quyết "
            "toán: 0") in out
    hashes = [r[0] for r in db.execute(
        "select order_id_hash from settlement_rows")]
    assert not any(h in out for h in hashes)
    assert not re.search(PII_RE, out)
    # không ghi bảng nào ngoài settlement_rows/recon_results
    for t in ("invoice_lines", "dealer_ar", "approval_queue",
              "market_alerts"):
        assert db.execute(f"select count(*) from {t}").fetchone()[0] == 0


def test_db_report_order_in_two_settlement_files(db, monkeypatch, tmp_path,
                                                 capsys):
    """File quyết toán thứ 2 giữ đúng 1 đơn chung (FAKESET0001), 15 đơn kia
    đổi mã → report đếm 1 đơn ở ≥2 file; tổng cộng dồn cả 2 file."""
    _load_orders(db, monkeypatch)
    p = _copy(tmp_path, "settlement_lan2.csv", lambda t: "\n".join(
        ln if ln.startswith(("FAKESET0001", "Mã đơn")) or not ln
        else ln.replace("FAKESET00", "FAKESEZ00", 1)
        for ln in t.split("\n")))
    for f in (SETTLE, p):
        assert _run(db, monkeypatch, "--file", str(f), "--channel",
                    "shopee") == (0, 1)
    capsys.readouterr()
    assert _run(db, monkeypatch, "--report") == (0, 0)
    out = capsys.readouterr().out
    assert "shopee: 32 dòng" in out
    # file 2: 15 dòng thiếu chứng từ (expected vẫn tính từ file) → tổng ×2
    assert ("thực nhận theo file 13.821.840đ; tính lại 13.831.840đ; chênh "
            "-10.000đ; affiliate sàn khấu trừ 136.800đ; đơn ở ≥2 file quyết "
            "toán: 1") in out
    assert not re.search(PII_RE, out)


def test_db_settlement_before_orders_then_reconcile(db, monkeypatch):
    assert _run(db, monkeypatch, "--file", str(SETTLE), "--channel",
                "shopee") == (0, 1)
    assert _labels(db) == {"thieu_chung_tu": 16}
    _load_orders(db, monkeypatch)
    assert _run(db, monkeypatch, "--reconcile") == (0, 1)
    assert _labels(db) == EXPECT
    assert db.execute("select count(*) from recon_results").fetchone()[0] \
        == 16


def test_db_latest_order_snapshot_wins(db, monkeypatch, tmp_path):
    _load_orders(db, monkeypatch)
    assert _run(db, monkeypatch, "--file", str(SETTLE), "--channel",
                "shopee") == (0, 1)
    # snapshot đơn mới: FAKESET0001 đổi giá 159.000 → 160.000 (×2)
    p = tmp_path / "order2.csv"
    txt = ORDERS.read_bytes().decode("utf-8")
    line = next(ln for ln in txt.split("\n") if ln.startswith("FAKESET0001"))
    p.write_bytes(txt.replace(line, line.replace(",159000,", ",160000,"))
                  .encode("utf-8"))
    _load_orders(db, monkeypatch, p)
    assert _run(db, monkeypatch, "--reconcile") == (0, 1)
    row = db.execute(
        "select r.label, r.order_amount_vnd, r.reasons from recon_results r"
        " join settlement_rows s on s.id = r.settlement_row_id where"
        " s.row_no = 2").fetchone()
    assert row[0] == "lech" and row[1] == 320000
    assert row[2] == [{"code": "gia_tri_don", "expected": 320000,
                       "actual": 318000}]


def test_db_reconcile_empty_ok(db, monkeypatch, capsys):
    assert _run(db, monkeypatch, "--reconcile") == (0, 1)
    assert "khop=0, lech=0, thieu_chung_tu=0, hoan=0" in \
        capsys.readouterr().out
    assert _run(db, monkeypatch, "--report") == (0, 0)
    assert "shopee: chưa có file quyết toán" in capsys.readouterr().out
