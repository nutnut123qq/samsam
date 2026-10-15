"""v9.1 W91.1 + W91.2 — schema FP&A (`cogs_versions` append-only + function
`approve_cogs` SECURITY DEFINER, `opex_entries`) và FP-COGS-PnL
(`agents.fp_pnl`): giá vốn người lập ≠ người duyệt + P&L SKU × kênh × tháng.

Phần thuần không cần DB. Phần DB chạy trên `DATABASE_URL` trong 1
transaction + schema tạm (docs/schema.sql ×2) → ROLLBACK cuối test (mẫu
`tests/test_settlement_csv.py`). Giá vốn trong test là MẪU — không phải giá
vốn thật (external-dep). Fixture `tests/fixtures/finance/*_MAU.csv` là dữ
liệu TỔNG HỢP: mã đơn `FAKESET*`, PII người mua GIẢ.
"""

import json
import os
import random
import re
import uuid
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import CheckViolation, InsufficientPrivilege, RaiseException

from agents import fp_pnl as fp
from ingest import golden_store as gs
from ingest import market_csv as mc
from ingest import settlement_csv as sc

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "finance"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
OCT = date(2026, 10, 1)
# Chuỗi không được lọt ra stdout/báo cáo: mã đơn gốc, PII GIẢ, tên người.
LEAK = ("FAKESET", "nguoimuagia", "NGUOI NHAN GIA", "DUONG GIA LAP",
        "GHI CHU GIA", "VDGIA", "090000000", "lap A", "duyet B")
# Giá vốn MẪU (không phải số thật) cho các SKU trong fixture đơn sàn.
COST = {"savina-12v": 50000, "saphraton-20v": 90000, "savigout-30v": 130000,
        "mat-ong-sam-120ml-1hu": 70000, "mat-ong-sam-300ml": 180000,
        "sapentol-30v": 110000}


def _v(id_, sku, cost, day, by="duyet B"):
    return {"id": id_, "sku_key": sku, "cost_vnd": cost, "valid_from": day,
            "approved_by": by}


# ---------- hàm thuần ----------

def test_cogs_at_effective_dates():
    a = _v(1, "X", 100, date(2026, 11, 1))
    b = _v(2, "X", 120, date(2026, 11, 15))
    vs = [a, b, _v(3, "Y", 999, date(2026, 1, 1))]
    assert fp.cogs_at(vs, "X", date(2026, 11, 10)) == 100
    assert fp.cogs_at(vs, "X", date(2026, 11, 14)) == 100
    assert fp.cogs_at(vs, "X", date(2026, 11, 15)) == 120
    assert fp.cogs_at(vs, "X", date(2026, 11, 20)) == 120
    assert fp.cogs_at(vs, "X", date(2026, 10, 31)) is None
    # B chưa duyệt (approved_by None / chuỗi trắng) → vẫn dùng A
    for pending in (None, "  "):
        vs2 = [a, {**b, "approved_by": pending}]
        assert fp.cogs_at(vs2, "X", date(2026, 11, 20)) == 100
    # hòa valid_from → id lớn nhất
    vs3 = [a, _v(9, "X", 105, date(2026, 11, 1)), _v(4, "X", 101,
                                                    date(2026, 11, 1))]
    assert fp.cogs_at(vs3, "X", date(2026, 11, 2)) == 105
    assert fp.cogs_at([], "X", date(2026, 11, 2)) is None


def test_allocate_exact_sum():
    assert fp.allocate(100, [1, 1, 1]) == [33, 33, 34]
    assert fp.allocate(0, [5, 7]) == [0, 0]
    assert fp.allocate(10, [0, 0]) == [5, 5]             # toàn 0 → chia đều
    assert fp.allocate(-7, [1, 1]) == [-4, -3]           # -3.5 → -4, dư dồn cuối
    assert fp.allocate(5, [1]) == [5]
    assert fp.allocate(0, []) == []
    with pytest.raises(ValueError):
        fp.allocate(3, [])
    rnd = random.Random(20261012)
    for _ in range(200):
        n = rnd.randint(1, 6)
        ws = [rnd.choice([0, rnd.randint(1, 10**7)]) for _ in range(n)]
        total = rnd.randint(-10**9, 10**9)
        out = fp.allocate(total, ws)
        assert len(out) == n and sum(out) == total, (total, ws, out)


def _row(id_=1, h="h1", amount=300, payout=250, day=date(2026, 10, 5),
         refund=0, label="khop", ch="shopee"):
    r = {"id": id_, "channel": ch, "order_id_hash": h,
         "order_amount_vnd": amount, "refund_vnd": refund,
         "payout_vnd": payout, "settled_on": day, "label": label}
    for f in fp._DEDUCT:
        r[f] = 0
    r["fixed_fee_vnd"] = amount - payout - refund
    return r


def _line(h, sku, qty, price, row_no=2, ch="shopee"):
    return {"channel": ch, "order_id_hash": h, "row_no": row_no,
            "sku_key": sku, "qty": qty, "price_vnd": price}


def test_pnl_missing_cogs_is_none_not_zero():
    rows = [_row(1, "h1", 300, 250), _row(2, "h2", 200, 180)]
    lines = [_line("h1", "A", 1, 100, 2), _line("h1", "B", 2, 100, 3),
             _line("h2", "B", 1, 200, 2)]
    vs = [_v(1, "A", 40, OCT)]
    res = fp.pnl(rows, lines, vs, OCT)
    cells = {c["sku_key"]: c for c in res["cells"]}
    a, b = cells["A"], cells["B"]
    assert (a["doanh_thu"], a["thuc_nhan"], a["gia_von"]) == (100, 83, 40)
    assert a["lai_gop"] == 43 and str(a["bien_gop_pct"]) == "43.0"
    # B thiếu giá vốn duyệt → None (không phải 0) + nhãn
    assert b["gia_von"] is None and b["lai_gop"] is None
    assert b["bien_gop_pct"] is None and b["nhan"] == fp.NO_COGS
    assert b["thuc_nhan"] == 250 - 83 + 180 and b["doanh_thu"] == 400
    assert res["loai"] == ["B"] and res["tong_lai_gop"] == 43
    assert res["tong_thuc_nhan"] == 430 == sum(c["thuc_nhan"]
                                               for c in res["cells"])
    text = fp.render(res)
    assert "1 SKU bị loại vì chưa có giá vốn duyệt: `B`" in text
    assert fp.DRAFT_HEAD in text
    # cùng ô thêm giá vốn → hết bị loại
    res2 = fp.pnl(rows, lines, vs + [_v(2, "B", 50, OCT)], OCT)
    assert res2["loai"] == [] and "0 SKU bị loại" in fp.render(res2)


def test_pnl_unknown_sku_missing_date_other_month():
    rows = [_row(1, "h1", 300, 250), _row(2, "nope", 100, 90),
            _row(3, "h3", 100, 90), _row(4, "h1", 1, 1, day=None),
            _row(5, "h1", 1, 1, day=date(2026, 11, 1))]
    lines = [_line("h1", "A", 1, 300), _line("h3", None, 1, 100)]
    res = fp.pnl(rows, lines, [_v(1, "A", 10, OCT)], OCT)
    cells = {c["sku_key"]: c for c in res["cells"]}
    unk = cells[fp.UNKNOWN_SKU]
    assert unk["thuc_nhan"] == 180 and unk["gia_von"] is None
    assert unk["doanh_thu"] is None and unk["nhan"] is None
    assert res["thieu_chung_tu"] == 1 and res["thieu_ngay"] == 1
    assert res["n_rows"] == 3 and res["tong_thuc_nhan"] == 430
    assert fp.UNKNOWN_SKU not in res["loai"]


def test_pnl_refund_row_still_costs_qty():
    rows = [_row(1, "h1", 300, 0, refund=300, label="hoan")]
    res = fp.pnl(rows, [_line("h1", "A", 3, 100)], [_v(1, "A", 10, OCT)], OCT)
    (c,) = res["cells"]
    assert c["hoan"] == 300 and c["gia_von"] == 30 and c["lai_gop"] == -30
    assert res["hoan"] == 1
    assert "GIẢ ĐỊNH thận trọng" in fp.render(res)


def test_pnl_channel_filter_counts_match_channel():
    """Lọc kênh: số đếm (dòng/thiếu chứng từ/hoàn/thiếu ngày) cùng phạm vi
    với tổng tiền — không lấy số của kênh khác."""
    rows = [_row(1, "h1", 300, 250), _row(2, "nope", 100, 90),
            _row(3, "h1", 300, 0, refund=300, label="hoan"),
            _row(4, "h1", 1, 1, day=None)]
    lines = [_line("h1", "A", 1, 300)]
    full = fp.pnl(rows, lines, [_v(1, "A", 10, OCT)], OCT)
    assert (full["n_rows"], full["thieu_chung_tu"], full["hoan"],
            full["thieu_ngay"]) == (3, 1, 1, 1)
    tk = fp.pnl(rows, lines, [_v(1, "A", 10, OCT)], OCT, "tiktok")
    assert (tk["n_rows"], tk["thieu_chung_tu"], tk["hoan"], tk["thieu_ngay"],
            tk["tong_thuc_nhan"], tk["cells"]) == (0, 0, 0, 0, 0, [])
    text = fp.render(tk)
    assert "Tổng thực nhận: 0đ (0 dòng quyết toán trong tháng)" in text
    assert f"(vào ô {fp.UNKNOWN_SKU}): 0; dòng hoàn: 0" in text
    assert "Lọc kênh: tiktok." in text and "khớp tổng thực nhận" not in text
    sh = fp.pnl(rows, lines, [_v(1, "A", 10, OCT)], OCT, "shopee")
    assert {k: v for k, v in sh.items() if k != "channel"} == \
        {k: v for k, v in full.items() if k != "channel"}


def test_parse_month():
    assert fp.parse_month("2026-10") == OCT
    for bad in ("2026-13", "2026-1", "26-10", "2026-10\n", None, 202610):
        assert fp.parse_month(bad) is None, bad


# ---------- CLI không DB ----------

def _no_connect(monkeypatch):
    calls = []
    monkeypatch.setattr(fp, "connect", lambda: calls.append(1))
    return calls


@pytest.mark.parametrize("argv", [
    ["--pnl", "--month", "2026-13"],
    ["--pnl"],
    ["--pnl", "--cogs-list"],
    ["--cogs-add", "--sku", "savina-12v", "--cost", "0", "--from",
     "2026-10-01", "--by", "lap A"],
    ["--cogs-add", "--sku", "savina-12v", "--cost", "-5", "--from",
     "2026-10-01", "--by", "lap A"],
    ["--cogs-add", "--sku", "savina-12v", "--cost", "50000", "--from",
     "2026-02-30", "--by", "lap A"],
    ["--cogs-add", "--sku", "Savina 12v", "--cost", "50000", "--from",
     "2026-10-01", "--by", "lap A"],
    ["--cogs-add", "--sku", "savina-12v", "--cost", "50000", "--from",
     "2026-10-01", "--by", "  "],
    ["--cogs-approve", "1"],
    ["--cogs-list", "--month", "2026-10"],
    [],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        fp.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(fp, "connect", lambda: None)
    assert fp.main(["--cogs-list"]) == 2
    assert "không kết nối được Postgres" in capsys.readouterr().err


# ---------- DB thật (schema tạm, rollback) ----------

@pytest.fixture
def db():
    yield from fpa_conn()


def fpa_conn():
    """Generator conn trên schema tạm (schema.sql ×2 + golden thật) —
    ROLLBACK cuối. Dùng chung cho fixture `db` của các test FP&A v9.1."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        # 60s (không 10s): roles.sql đụng role toàn cluster — nhiều worktree
        # chạy song song (flake LockNotAvailable v10.0, precedent test_ceo_audit).
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w91p_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)          # idempotent ×2
        for t in ("cogs_versions", "opex_entries"):
            assert conn.execute("select to_regclass(%s) is not null",
                                (f"{schema}.{t}",)).fetchone()[0], t
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _raises(db, sql, params=None, exc=RaiseException, role=None):
    with pytest.raises(exc) as e, db.transaction():
        if role:
            db.execute(f"set local role {role}")
        db.execute(sql, params)
    return str(e.value)


@contextmanager
def _as(db, role):
    with db.transaction():
        db.execute(f"set local role {role}")
        yield
        db.execute("reset role")


def _add(db, sku="savina-12v", cost=50000, day="2026-10-01", by="nguyen a"):
    return db.execute(
        "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
        " created_by) values (%s, %s, %s, %s) returning id",
        (sku, cost, day, by)).fetchone()[0]


def test_schema_no_alter_drop_table():
    added = SCHEMA_SQL.split("v9.1 FP&A (WP12")[1]
    assert not re.search(r"^\s*(alter|drop)\s+table", added,
                         re.IGNORECASE | re.MULTILINE)


def test_cogs_versions_append_only(db):
    cid = _add(db)
    assert "INSERT phải là dòng chưa duyệt" in _raises(
        db, "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
            " created_by, approved_by, approved_at) values ('savina-12v',"
            " 1, '2026-10-01', 'x', 'y', now())")
    _raises(db, "update cogs_versions set cost_vnd = 1 where id = %s", (cid,))
    _raises(db, "update cogs_versions set approved_by = 'y', approved_at ="
                " now(), note = 'đổi' where id = %s", (cid,))
    _raises(db, "update cogs_versions set approved_by = '  ', approved_at ="
                " now() where id = %s", (cid,))
    _raises(db, "delete from cogs_versions where id = %s", (cid,))
    _raises(db, "truncate cogs_versions")
    _raises(db, "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
                " created_by) values ('savina-12v', 0, '2026-10-01', 'x')",
            exc=CheckViolation)
    _raises(db, "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
                " created_by) values ('savina-12v', 1, '2026-10-01', ' ')",
            exc=CheckViolation)
    _raises(db, "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
                " created_by) values ('khong-co', 1, '2026-10-01', 'x')",
            exc=psycopg.errors.ForeignKeyViolation)
    assert db.execute("select count(*) from cogs_versions").fetchone()[0] == 1


def test_approve_cogs_same_person_rejected_other_ok(db):
    cid = _add(db, by="nguyen a")
    msg = _raises(db, "select approve_cogs(%s, %s)", (cid, "NguYen A "))
    assert "trùng người lập" in msg
    assert db.execute("select approved_by from cogs_versions where id = %s",
                      (cid,)).fetchone()[0] is None
    # khoảng trắng khác kiểu (tab / nhiều dấu cách) vẫn là cùng người lập
    for same in ("Nguyen\ta", "nguyen   A", "\nnguyen a\r\n"):
        assert "trùng người lập" in _raises(
            db, "select approve_cogs(%s, %s)", (cid, same))
    assert "thiếu tên người duyệt" in _raises(
        db, "select approve_cogs(%s, %s)", (cid, " \t "))
    assert "không tìm thấy" in _raises(db, "select approve_cogs(%s, %s)",
                                       (cid + 999, "Tran B"))
    aid = db.execute("select approve_cogs(%s, %s, %s)",
                     (cid, " Tran B ", "MẪU test")).fetchone()[0]
    row = db.execute("select approved_by, approved_at is not null from"
                     " cogs_versions where id = %s", (cid,)).fetchone()
    assert row == ("Tran B", True)
    appr = db.execute("select id, object_type, object_id, decision,"
                      " approved_by, content_sha256 from approvals").fetchall()
    import hashlib
    sha = hashlib.sha256(b"savina-12v|50000|2026-10-01").hexdigest()
    assert appr == [(aid, "cogs_version", str(cid), "approved", "Tran B",
                     sha)]
    log = db.execute("select action, object_type, object_id from"
                     " agent_action_log").fetchall()
    assert log == [("cogs_approve", "cogs_version", str(cid))]
    assert db.execute("select count(*) from verify_action_log()"
                      ).fetchone()[0] == 0
    assert "đã được duyệt" in _raises(db, "select approve_cogs(%s, %s)",
                                      (cid, "Le C"))
    assert db.execute("select count(*) from approvals").fetchone()[0] == 1


def test_roles_agent_writer_cannot_approve_or_insert(db):
    db.execute(ROLES_SQL)
    db.execute(ROLES_SQL)                 # idempotent ×2
    cid = _add(db, by="nguyen a")
    _raises(db, "select approve_cogs(%s, %s)", (cid, "Tran B"),
            exc=InsufficientPrivilege, role="agent_writer")
    _raises(db, "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
                " created_by) values ('savina-12v', 1, '2026-10-01', 'x')",
            exc=InsufficientPrivilege, role="agent_writer")
    _raises(db, "insert into opex_entries (file_sha256, file_name, row_no,"
                " month, category, service, amount_vnd) values (%s, 'f', 2,"
                " '2026-10-01', 'cloud', 'x1', 1)", ("a" * 64,),
            exc=InsufficientPrivilege, role="app_human")
    # app_human: người lập thêm dòng + người khác duyệt qua function
    with _as(db, "app_human"):
        nid = db.execute("insert into cogs_versions (sku_key, cost_vnd,"
                         " valid_from, created_by) values ('savina-12v', 2,"
                         " '2026-10-02', 'lap A') returning id").fetchone()[0]
        db.execute("select approve_cogs(%s, %s)", (nid, "duyet B"))
    _raises(db, "update cogs_versions set approved_by = 'x', approved_at ="
                " now() where id = %s", (cid,),
            exc=InsufficientPrivilege, role="app_human")


def test_opex_entries_checks(db):
    ins = ("insert into opex_entries (file_sha256, file_name, row_no, month,"
           " category, service, amount_vnd) values (%s, 'f.csv', %s, %s, %s,"
           " %s, %s)")
    h = "b" * 64
    _raises(db, ins, (h, 2, "2026-10-15", "cloud", "aws", 1),
            exc=CheckViolation)
    _raises(db, ins, (h, 2, "2026-10-01", "cloud", "aws", 0),
            exc=CheckViolation)
    _raises(db, ins, (h, 2, "2026-10-01", "cloud", "my service", 1),
            exc=CheckViolation)
    _raises(db, ins, (h, 2, "2026-10-01", "luong", "aws", 1),
            exc=CheckViolation)
    _raises(db, ins, (h, 1, "2026-10-01", "cloud", "aws", 1),
            exc=CheckViolation)
    _raises(db, ins, ("XYZ", 2, "2026-10-01", "cloud", "aws", 1),
            exc=CheckViolation)
    db.execute(ins, (h, 2, "2026-10-01", "cloud", "aws", 1))
    _raises(db, ins, (h, 2, "2026-10-01", "saas", "x2", 1),
            exc=psycopg.errors.UniqueViolation)


def _load_market(db, monkeypatch, path):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(mc, "_connect", lambda _dsn: _TxConn(db))
    assert mc.main(["--file", str(path), "--channel", "shopee", "--kind",
                    "order"]) == 0


def _load_settlement(db, monkeypatch, path):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(sc, "_connect", lambda _dsn: _TxConn(db))
    assert sc.main(["--file", str(path), "--channel", "shopee"]) == 0


def load_fixtures(db, monkeypatch):
    """Đơn sàn + quyết toán MẪU (dùng lại ở test_fp_ads/test_fin_director)."""
    for f in ("order_shopee_MAU.csv", "order_shopee_multi_MAU.csv"):
        _load_market(db, monkeypatch, FIX / f)
    for f in ("settlement_shopee_MAU.csv", "settlement_shopee_multi_MAU.csv"):
        _load_settlement(db, monkeypatch, FIX / f)


def cli(db, monkeypatch, *argv):
    monkeypatch.setattr(fp, "connect", lambda: _TxConn(db))
    return fp.main(list(argv))


def add_costs(db, monkeypatch, skus=tuple(COST), by="lap A",
              approver="duyet B"):
    """Giá vốn MẪU qua CLI: người lập `by`, người duyệt `approver`."""
    for sku in skus:
        assert cli(db, monkeypatch, "--cogs-add", "--sku", sku, "--cost",
                   str(COST[sku]), "--from", "2026-10-01", "--by", by) == 0
        cid = db.execute("select max(id) from cogs_versions").fetchone()[0]
        assert cli(db, monkeypatch, "--cogs-approve", str(cid), "--by",
                   approver) == 0


def test_db_pnl_flow(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(fp, "REPORTS_DIR", tmp_path)
    load_fixtures(db, monkeypatch)
    add_costs(db, monkeypatch, [k for k in COST if k != "savigout-30v"])
    # savigout: người duyệt = người lập (khác hoa thường/khoảng trắng)
    assert cli(db, monkeypatch, "--cogs-add", "--sku", "savigout-30v",
               "--cost", "130.000", "--from", "2026-10-01", "--by",
               "lap A") == 0
    gid = db.execute("select max(id) from cogs_versions").fetchone()[0]
    capsys.readouterr()
    assert cli(db, monkeypatch, "--cogs-approve", str(gid), "--by",
               "  LAP a ") == 1
    out = capsys.readouterr()
    assert "trùng người lập" in out.out and "Traceback" not in out.err
    assert cli(db, monkeypatch, "--cogs-add", "--sku", "khong-co-sku",
               "--cost", "1", "--from", "2026-10-01", "--by", "lap A") == 1
    assert cli(db, monkeypatch, "--cogs-list") == 0
    lst = capsys.readouterr().out
    assert "savina-12v: 50.000đ" in lst and f"[chờ duyệt] #{gid}" in lst

    assert cli(db, monkeypatch, "--pnl", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    report = (tmp_path / "pnl-2026-10.md").read_text(encoding="utf-8")
    assert report.startswith("# P&L") and fp.DRAFT_HEAD in report
    total = db.execute(
        "select sum(payout_vnd) from settlement_rows where settled_on >="
        " '2026-10-01' and settled_on < '2026-11-01'").fetchone()[0]
    res = fp.compute(db, OCT)
    assert sum(c["thuc_nhan"] for c in res["cells"]) == total == 7562080
    assert res["loai"] == ["savigout-30v"]
    assert "1 SKU bị loại vì chưa có giá vốn duyệt: `savigout-30v`" in report
    cells = {c["sku_key"]: c for c in res["cells"]}
    assert cells["savigout-30v"]["gia_von"] is None
    assert cells["savina-12v"]["gia_von"] == 7 * 50000
    assert cells["savina-12v"]["lai_gop"] == 971289 - 350000
    assert res["tong_lai_gop"] == 4368080 - (1391380 - 520000)
    # đơn 2 dòng: tổng phân bổ 2 ô == số trên dòng quyết toán
    h = sc.order_hash("shopee", "FAKESET0201")
    rows = [r for r in fp.fetch_rows(db, OCT) if r["order_id_hash"] == h]
    lines = fp.fetch_lines(db, [h])
    assert len(rows) == 1 and {ln["sku_key"] for ln in lines} == {
        "savina-12v", "saphraton-20v"}
    one = fp.pnl(rows, lines, fp.fetch_versions(db), OCT)
    assert len(one["cells"]) == 2
    for k, v in (("doanh_thu", 757000), ("thuc_nhan", 651160),
                 ("khau_tru_san", 30280 + 37850 + 22710 + 15000)):
        assert sum(c[k] for c in one["cells"]) == v, k
    # Σ trọng số dòng đơn == recon_results.order_amount_vnd (cùng snapshot)
    all_rows = fp.fetch_rows(db, OCT)
    w: dict = {}
    for ln in fp.fetch_lines(db, [r["order_id_hash"] for r in all_rows]):
        w[ln["order_id_hash"]] = w.get(ln["order_id_hash"], 0) + \
            ln["qty"] * ln["price_vnd"]
    recon = dict(db.execute(
        "select s.order_id_hash, r.order_amount_vnd from settlement_rows s"
        " join recon_results r on r.settlement_row_id = s.id").fetchall())
    assert w and all(w[k] == recon[k] for k in w)
    assert {k for k, v in recon.items() if v is None} == set(recon) - set(w)
    # không rò mã đơn/hash/PII/tên người lập-duyệt
    hashes = [r[0] for r in db.execute(
        "select order_id_hash from settlement_rows")]
    for text in (out, report):
        assert not any(x in text for x in hashes)
        assert not any(x in text for x in LEAK), [x for x in LEAK
                                                  if x in text]
    # lọc kênh: file RIÊNG, không đè bản toàn kênh; số đếm theo đúng kênh
    full = tmp_path / "pnl-2026-10.md"
    before = full.read_bytes()
    assert res["thieu_chung_tu"] >= 1      # shopee có dòng thiếu chứng từ
    assert cli(db, monkeypatch, "--pnl", "--month", "2026-10", "--channel",
               "tiktok") == 0
    out = capsys.readouterr().out
    assert full.read_bytes() == before
    tk = (tmp_path / "pnl-2026-10-tiktok.md").read_text(encoding="utf-8")
    for text in (out, tk):
        assert "không có dòng quyết toán trong tháng" in text
        assert "Tổng thực nhận: 0đ (0 dòng quyết toán trong tháng)" in text
        assert f"(vào ô {fp.UNKNOWN_SKU}): 0; dòng hoàn: 0" in text
    assert "pnl-2026-10-tiktok.md" in out
    assert cli(db, monkeypatch, "--pnl", "--month", "2026-10", "--channel",
               "shopee") == 0
    capsys.readouterr()
    assert full.read_bytes() == before
    sh = (tmp_path / "pnl-2026-10-shopee.md").read_text(encoding="utf-8")
    assert (f"(vào ô {fp.UNKNOWN_SKU}): {res['thieu_chung_tu']}; dòng hoàn:"
            f" {res['hoan']}") in sh
    assert f"({res['n_rows']} dòng quyết toán trong tháng)" in sh


def test_db_lines_take_newest_order_snapshot_only(db, monkeypatch, tmp_path):
    """Seller Center xuất chồng: cùng đơn FAKESET0201 có trong 2 file đơn —
    file MỚI hơn sửa saphraton 2 → 1. Dòng đơn của P&L chỉ lấy snapshot MỚI
    NHẤT (quy tắc `_ORDER_SQL`): bỏ CTE `latest` → qty cộng 2 lần; đảo thứ tự
    snapshot → lấy bản cũ. Cả hai đều lệch giá vốn + Σ trọng số ≠ recon."""
    for f in ("order_shopee_MAU.csv", "order_shopee_multi_MAU.csv"):
        _load_market(db, monkeypatch, FIX / f)
    newer = tmp_path / "order_shopee_multi_moi_MAU.csv"
    raw = (FIX / "order_shopee_multi_MAU.csv").read_bytes()
    old_cell = b",saphraton-20v,2,299000,"
    assert raw.count(old_cell) == 1
    newer.write_bytes(raw.replace(old_cell, b",saphraton-20v,1,299000,"))
    _load_market(db, monkeypatch, newer)
    _load_settlement(db, monkeypatch, FIX / "settlement_shopee_multi_MAU.csv")
    add_costs(db, monkeypatch, ["savina-12v", "saphraton-20v"])
    h = sc.order_hash("shopee", "FAKESET0201")
    snaps = db.execute("select count(distinct snapshot_id) from market_rows"
                       " where order_id_hash = %s", (h,)).fetchone()[0]
    assert snaps == 2                       # đơn nằm trong 2 snapshot
    lines = fp.fetch_lines(db, [h])
    assert sorted((ln["sku_key"], ln["qty"], ln["price_vnd"])
                  for ln in lines) == [("saphraton-20v", 1, 299000),
                                       ("savina-12v", 1, 159000)]
    recon = db.execute(
        "select r.order_amount_vnd from settlement_rows s join recon_results"
        " r on r.settlement_row_id = s.id where s.order_id_hash = %s",
        (h,)).fetchone()[0]
    assert sum(ln["qty"] * ln["price_vnd"] for ln in lines) == recon == 458000
    rows = [r for r in fp.fetch_rows(db, OCT) if r["order_id_hash"] == h]
    res = fp.pnl(rows, lines, fp.fetch_versions(db), OCT)
    cells = {c["sku_key"]: c for c in res["cells"]}
    assert cells["saphraton-20v"]["gia_von"] == 1 * COST["saphraton-20v"]
    assert cells["savina-12v"]["gia_von"] == 1 * COST["savina-12v"]
    split = fp.allocate(651160, [159000, 299000])
    assert [cells["savina-12v"]["thuc_nhan"],
            cells["saphraton-20v"]["thuc_nhan"]] == split


def test_db_pnl_empty_cogs_lists_all_skus(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(fp, "REPORTS_DIR", tmp_path)
    load_fixtures(db, monkeypatch)
    assert cli(db, monkeypatch, "--pnl", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert f"{len(COST)} SKU bị loại vì {fp.NO_COGS}" in out
    assert "Tổng lãi gộp (chỉ ô có giá vốn duyệt): 0đ" in out
    assert out.count(fp.NO_COGS) >= len(COST) + 1
    res = fp.compute(db, OCT)
    assert all(c["gia_von"] is None for c in res["cells"])


def test_db_error_exit1_no_traceback(db, monkeypatch, capsys):
    db.execute("drop table recon_results")
    assert cli(db, monkeypatch, "--pnl", "--month", "2026-10") == 1
    cap = capsys.readouterr()
    assert "[error]" in cap.err and "Traceback" not in cap.err + cap.out
