"""v9.2 — `ingest.inventory_csv` (nạp tồn thành phẩm, SX-A3 đầu vào).

Phần thuần (`read_inventory`) không cần DB; ngày "hôm nay" truyền làm
tham số. Phần DB thật chạy trên `DATABASE_URL` trong 1 transaction + schema
tạm (docs/schema.sql) và ROLLBACK cuối test. Skip khi không có DB.
"""

import datetime as dt
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

from ingest import inventory_csv as ic

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "data" / "sample_inventory.csv"
TODAY = dt.date(2026, 10, 12)
HDR = "sku_key,kho,qty,captured_at\n"
OK_ROW = "savina-12v,kho-mau-da-nang,10,2026-10-09\n"


@pytest.fixture(scope="module")
def golden():
    g, why = ic.golden_map()
    assert why is None
    return g


def _write(tmp_path, name, text) -> Path:
    p = tmp_path / name
    p.write_bytes(text.encode("utf-8"))
    return p


# ---------- hàm thuần ----------

def test_sample_file_valid(golden):
    rows, errs, sha = ic.read_inventory(SAMPLE, golden, TODAY)
    assert errs == [] and len(rows) >= 13
    assert re.fullmatch(r"[0-9a-f]{64}", sha)
    khos = {r["kho"] for r in rows}
    assert len(khos) >= 2 and all(k.startswith("kho-mau-") for k in khos)
    skus = {r["sku_key"] for r in rows}
    # đủ golden trừ >= 1 SKU (thử nhánh "chưa có số tồn")
    assert skus < set(golden) and len(set(golden) - skus) >= 1
    assert [r["row_no"] for r in rows][:2] == [2, 3]
    assert all(isinstance(r["captured_at"], dt.date) for r in rows)


BAD_CASES = {
    "empty": ("x.csv", ""),
    "header_only": ("x.csv", HDR),
    "unknown_col": ("x.csv", "sku_key,kho,qty,captured_at,ghi_chu\n"
                    + OK_ROW.strip() + ",abc\n"),
    "missing_qty": ("x.csv", ("sku_key,kho,captured_at\n"
                             "savina-12v,kho-mau-da-nang,2026-10-09\n")),
    "dup_header": ("x.csv", "sku_key,kho,qty,qty,captured_at\n"),
    "sku_unknown": ("x.csv", HDR + "khong-co-sku,kho-mau-da-nang,1,"
                    "2026-10-09\n"),
    "kho_pii": ("x.csv", HDR + "savina-12v,Kho Anh Nam 0905123456,1,"
                "2026-10-09\n"),
    "qty_neg": ("x.csv", HDR + "savina-12v,kho-a,-3,2026-10-09\n"),
    "qty_float": ("x.csv", HDR + "savina-12v,kho-a,1.5,2026-10-09\n"),
    "qty_abc": ("x.csv", HDR + "savina-12v,kho-a,abc,2026-10-09\n"),
    "qty_blank": ("x.csv", HDR + "savina-12v,kho-a,,2026-10-09\n"),
    "future": ("x.csv", HDR + "savina-12v,kho-a,1,2026-10-13\n"),
    "date_compact": ("x.csv", HDR + "savina-12v,kho-a,1,20261009\n"),
    "dup_key": ("x.csv", HDR + OK_ROW + OK_ROW),
    "txt": ("x.txt", HDR + OK_ROW),
    "not_utf8": ("x.csv", None),
}


@pytest.mark.parametrize("case", sorted(BAD_CASES))
def test_bad_variants_rejected(tmp_path, golden, case):
    name, text = BAD_CASES[case]
    p = tmp_path / name
    if text is None:
        p.write_bytes((HDR + "savina-12v,kho-\xe0,1,2026-10-09\n")
                      .encode("cp1258"))
    else:
        p.write_bytes(text.encode("utf-8"))
    rows, errs, _ = ic.read_inventory(p, golden, TODAY)
    assert rows == [] and errs, case
    assert not any("0905123456" in e for e in errs)


def test_missing_file(tmp_path, golden):
    rows, errs, sha = ic.read_inventory(tmp_path / "nope.csv", golden, TODAY)
    assert rows == [] and errs and sha is None


def test_mixed_good_and_bad_rows_load_nothing(tmp_path, golden):
    p = _write(tmp_path, "x.csv", HDR + OK_ROW + "savina-12v,kho-b,x,"
               "2026-10-09\n")
    rows, errs, _ = ic.read_inventory(p, golden, TODAY)
    assert rows == [] and len(errs) == 1 and "dòng 3" in errs[0]


def test_main_bad_file_exit1_no_connect(tmp_path, monkeypatch, capsys):
    calls = []

    def boom(*a, **kw):
        calls.append(1)
        raise AssertionError("không được connect")

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(psycopg, "connect", boom)
    for text in ("", HDR, HDR + "savina-12v,Kho Anh Nam 0905123456,1,"
                 "2026-10-09\n", HDR + "savina-12v,kho-a,1,2099-01-01\n"):
        p = _write(tmp_path, "bad.csv", text)
        assert ic.main(["--file", str(p)]) == 1
    assert ic.main(["--file", str(tmp_path / "missing.csv")]) == 1
    assert calls == []
    out = capsys.readouterr().out
    assert "không connect, không nạp gì" in out and "0905123456" not in out


def test_no_update_delete_inventory_in_code():
    pat = re.compile(r"update inventory_snapshots|delete from "
                     r"inventory_snapshots", re.IGNORECASE)
    for d in ("ingest", "pipelines", "scripts"):
        for p in (ROOT / d).rglob("*.py"):
            assert not pat.search(p.read_text(encoding="utf-8")), p


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
        schema = f"t_inv_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.inventory_snapshots",)).fetchone()[0]
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _run(db, monkeypatch, *argv):
    proxy = TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(ic, "_connect", lambda _dsn: proxy)
    return ic.main(list(argv)), proxy.committed


def _count(db):
    return db.execute("select count(*) from inventory_snapshots").fetchone()[0]


def test_db_load_idempotent(db, monkeypatch, capsys):
    assert _run(db, monkeypatch, "--file", str(SAMPLE), "--source",
                "sample") == (0, 1)
    n = _count(db)
    assert n >= 13
    assert "[MẪU]" in capsys.readouterr().out
    assert _run(db, monkeypatch, "--file", str(SAMPLE), "--source",
                "sample") == (0, 0)
    assert "[skip]" in capsys.readouterr().out
    assert _count(db) == n
    assert db.execute("select count(distinct source) from inventory_snapshots"
                      ).fetchone()[0] == 1


def test_current_stock_latest_per_kho(db, golden, tmp_path):
    f1 = _write(tmp_path, "a.csv", HDR + "savina-12v,kho-a,10,2026-10-01\n"
                "savina-12v,kho-b,5,2026-10-01\n"
                "saphraton-40v,kho-a,3,2026-10-01\n")
    f2 = _write(tmp_path, "b.csv", HDR + "savina-12v,kho-a,7,2026-10-08\n")
    for f in (f1, f2):
        rows, errs, sha = ic.read_inventory(f, golden, TODAY)
        assert errs == []
        ic.load(db, rows, "manual_export", f.name, sha)
    st = ic.current_stock(db)
    assert st["savina-12v"]["qty"] == 12   # 7 (kho-a mới nhất) + 5 (kho-b)
    assert st["savina-12v"]["kho"]["kho-a"] == {
        "qty": 7, "captured_at": "2026-10-08", "stale": False}
    assert st["savina-12v"]["sample"] is False
    # kho-b chỉ có snapshot 10-01 (mới nhất của CHÍNH kho-b) → không stale
    assert st["savina-12v"]["stale"] == []
    # file kho-a 10-08 bỏ sót saphraton-40v → giữ 3 (không đoán 0) + stale
    assert st["saphraton-40v"]["qty"] == 3
    assert st["saphraton-40v"]["stale"] == ["kho-a"]
    assert "saphraton-20v" not in st      # chưa có số tồn ≠ 0
