"""v3.2-golden-master — `ingest.golden_store` + schema golden.

Phần thuần (validate / read_golden / spec_of / build_discrepancies / CLI
argparse) không cần DB. Phần DB thật chạy trên `DATABASE_URL` (samsam_infra)
trong 1 transaction + schema tạm (docs/schema.sql) và ROLLBACK cuối test —
độc lập dữ liệu public (append-only, không dọn được). Skip khi không có DB.
"""

import copy
import json
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

from ingest import golden_store as gs

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "data" / "golden_skus.json"

RECEIPTS = {"8014/2021/ĐKSP", "2778/2018/ĐKSP", "8560/2019/ĐKSP",
            "5191/2020/ĐKSP", "11129/2021/ĐKSP"}

# Số liệu spec v3.2 ghim THEO TỪNG SKU (chép từ contract, không từ file):
# sku_key -> (số ĐKSP, ngày ĐKSP, Shopee item id, (sàn, thường, KM)).
# So set thì tráo số Savigout <-> Sapentol vẫn pass — phải so theo key.
EXPECTED = {
    "savina-12v": ("8014/2021/ĐKSP", "2021-09-07", "27357883504",
                   (128000, 159000, 132000)),
    "saphraton-combo-2x20v": ("2778/2018/ĐKSP", "2018-05-22", "28003783932",
                              (469000, 698000, 480000)),
    "saphraton-20v": ("2778/2018/ĐKSP", "2018-05-22", "24825885894",
                      (236000, 299000, 250000)),
    "saphraton-40v": ("2778/2018/ĐKSP", "2018-05-22", None,
                      (450000, None, None)),
    "saphraton-80v": ("2778/2018/ĐKSP", "2018-05-22", "29368491427",
                      (1000000, 1490000, 1100000)),
    "savigout-30v": ("8560/2019/ĐKSP", "2019-07-02", "24325987926",
                     (295000, 439000, 350000)),
    "sapentol-30v": ("5191/2020/ĐKSP", "2020-06-10", "27257950771",
                     (280000, 417000, 330000)),
    "da-an-sam-30v": ("11129/2021/ĐKSP", "2021-12-29", "26857946153",
                      (340000, 506000, 399000)),
    "mat-ong-sam-120ml-1hu": (None, None, "54916394790",
                              (500000, 745000, 550000)),
    "mat-ong-sam-120ml-2hu": (None, None, "54916394790",
                              (900000, 1340000, 950000)),
    "mat-ong-sam-300ml": (None, None, "29007947088",
                          (2000000, 2980000, 2100000)),
    "ruou-sam-chai-thuy-tinh-500ml": (None, None, "27325048614",
                                      (500000, 745000, 550000)),
    "ruou-sam-binh-su-do-500ml": (None, None, "26975028961",
                                  (None, None, None)),
}


def _doc() -> dict:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def _sku(key, prices, **kw) -> dict:
    return {"sku_key": key, "name": key, "category": "tpbvsk",
            "prices": {"shopee": prices}, **kw}


# ---------- file golden + validator ----------

def test_real_golden_file_valid_and_counts():
    doc = _doc()
    assert gs.validate(doc) == []
    skus = {s["sku_key"]: s for s in doc["skus"]}
    assert len(skus) == 13
    n_prices = sum(len(kp) for s in doc["skus"]
                   for kp in s["prices"].values())
    assert n_prices == 34
    assert sum(len(s["product_ids"]) for s in doc["skus"]) == 15
    alcohol = [s for s in doc["skus"] if "ruou" in s["sku_key"]]
    assert len(alcohol) == 2 and all(s["category"] == "alcohol"
                                     for s in alcohol)
    honey = [s for s in doc["skus"] if s["sku_key"].startswith("mat-ong")]
    assert len(honey) == 3
    assert all(s["category"] == "food" and s["self_declaration_ok"] is None
               for s in honey)
    tpbvsk = [s for s in doc["skus"] if s["category"] == "tpbvsk"]
    assert len(tpbvsk) == 8
    assert all(s["xnqc_status"] == "none" for s in tpbvsk)
    assert {s["receipt_no"] for s in tpbvsk} == RECEIPTS
    # Biên đúng 149%: 745000/500000, 1490000/1000000, 2980000/2000000.
    assert skus["saphraton-80v"]["prices"]["shopee"] == {
        "floor": 1000000, "list": 1490000, "promo": 1100000}
    assert skus["saphraton-40v"]["prices"] == {"shopee": {"floor": 450000}}
    assert skus["ruou-sam-binh-su-do-500ml"]["prices"] == {}
    # Mọi giá nạp chờ duyệt — file không được tự ghi người duyệt.
    assert "approved_by" not in GOLDEN.read_text(encoding="utf-8")


def test_golden_file_pinned_per_sku():
    got = {}
    for s in _doc()["skus"]:
        assert set(s["prices"]) <= {"shopee"}, s["sku_key"]
        sp = s["prices"].get("shopee", {})
        got[s["sku_key"]] = (s["receipt_no"], s["receipt_date"],
                             s["shopee_item_id"],
                             tuple(sp.get(k) for k in ("floor", "list",
                                                       "promo")))
    assert got == EXPECTED


def test_golden_file_no_banned_words():
    text = GOLDEN.read_text(encoding="utf-8").lower()
    words = [w.strip().lower() for w in (ROOT / "data" / "banned_words.txt")
             .read_text(encoding="utf-8").splitlines()
             if w.strip() and not w.startswith("#")]
    assert words
    hits = [w for w in words if w in text]
    assert hits == []


def test_validator_three_planted_violations():
    doc = {"skus": [
        _sku("r1-x", {"floor": 100000, "list": 150000}),      # list=1.5*floor
        _sku("r2-x", {"list": 200000, "promo": 100000}),      # giảm 50%
        _sku("r3-x", {"floor": 100000, "list": 120000, "promo": 90000}),
        _sku("only-floor", {"floor": 450000}),                # như 40v
        {"sku_key": "no-price", "name": "x", "category": "alcohol",
         "prices": {}},                                       # bình sứ đỏ
    ]}
    errs = gs.validate(doc)
    assert len(errs) == 3, errs
    codes = [re.search(r" (R[123]):", e).group(1) for e in errs]
    assert sorted(codes) == ["R1", "R2", "R3"]
    assert any(e.startswith("r1-x/") and "R1" in e for e in errs)
    assert any(e.startswith("r2-x/") and "R2" in e for e in errs)
    assert any(e.startswith("r3-x/") and "R3" in e for e in errs)


def test_validator_integer_boundaries():
    ok = {"skus": [_sku("a", {"floor": 500000, "list": 745000}),  # đúng 149%
                   _sku("b", {"list": 745000, "promo": 379950})]}  # đúng 49%
    assert gs.validate(ok) == []
    over = {"skus": [_sku("a", {"floor": 500000, "list": 745001})]}
    assert [e for e in gs.validate(over) if "R1" in e]
    over2 = {"skus": [_sku("a", {"list": 745000, "promo": 379949})]}
    assert [e for e in gs.validate(over2) if "R2" in e]
    r3 = {"skus": [_sku("a", {"list": 100000, "promo": 100001})]}
    assert [e for e in gs.validate(r3) if "R3" in e]


@pytest.mark.parametrize("doc, needle", [
    ([], "root"),
    ({}, "skus"),
    ({"skus": []}, "skus"),
    ({"skus": [_sku("Bad Key", {})]}, "slug"),
    ({"skus": [_sku("a", {}), _sku("a", {})]}, "trùng"),
    ({"skus": [_sku("a", {}, product_ids=["p1"]),
               _sku("b", {}, product_ids=["p1"])]}, "đã map"),
    ({"skus": [_sku("a", {}, category="drug")]}, "category"),
    ({"skus": [_sku("a", {}, xnqc_status="yes")]}, "xnqc"),
    ({"skus": [_sku("a", {}, self_declaration_ok="yes")]}, "self_decl"),
    ({"skus": [_sku("a", {}, receipt_date="22/05/2018")]}, "ISO"),
    ({"skus": [_sku("a", {}, allowed_channels=["lazada"])]}, "allowed"),
    ({"skus": [_sku("a", {"list": 1.5})]}, "nguyên"),
    ({"skus": [_sku("a", {"list": True})]}, "nguyên"),
    ({"skus": [_sku("a", {"list": -1})]}, "nguyên"),
    ({"skus": [_sku("a", {"msrp": 1})]}, "loại giá"),
    ({"skus": [{**_sku("a", {}), "prices": {"lazada": {"list": 1}}}]},
     "kênh"),
    ({"skus": [{"sku_key": "a", "category": "food"}]}, "name"),
])
def test_validator_schema_errors(doc, needle):
    errs = gs.validate(doc)
    assert errs and any(needle in e for e in errs), errs


# ---------- đọc file: mọi biến thể "không có dữ liệu" ----------

BAD_FILES = {
    "empty.json": "",
    "blank.json": "  \n",
    "broken.json": '{"skus": [',
    "obj.json": "{}",
    "doc_only.json": '{"_doc": "chỉ comment"}',
    "skus_empty.json": '{"_doc": "x", "skus": []}',
}


def test_read_golden_rejects_every_empty_variant(tmp_path):
    assert gs.read_golden(tmp_path / "missing.json")[0] is None
    for name, body in BAD_FILES.items():
        p = tmp_path / name
        p.write_text(body, encoding="utf-8")
        doc, why = gs.read_golden(p)
        assert doc is None and why, name
    (tmp_path / "latin.json").write_bytes(b'{"skus": ["\xff"]}')
    assert gs.read_golden(tmp_path / "latin.json")[0] is None
    doc, why = gs.read_golden(GOLDEN)
    assert why is None and len(doc["skus"]) == 13


def _no_connect(monkeypatch):
    def boom(_dsn):
        raise AssertionError("không được connect")
    monkeypatch.setattr(gs, "_connect", boom)


def test_main_bad_files_exit1_without_connect(tmp_path, monkeypatch,
                                              capsys):
    _no_connect(monkeypatch)
    paths = [tmp_path / "missing.json"]
    for name, body in BAD_FILES.items():
        (tmp_path / name).write_text(body, encoding="utf-8")
        paths.append(tmp_path / name)
    for p in paths:
        assert gs.main(["--file", str(p)]) == 1, p
    assert capsys.readouterr().out.count("[warn]") == len(paths)
    # File parse được nhưng sai rule → in lỗi, exit 1, vẫn không connect.
    bad = _doc()
    bad["skus"][0]["prices"]["shopee"]["list"] = 999999
    p = tmp_path / "rule.json"
    p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    assert gs.main(["--file", str(p)]) == 1
    assert "R1" in capsys.readouterr().out


# ---------- CLI argparse (exit 2 trước connect) ----------

@pytest.mark.parametrize("argv", [
    ["--approve-price", "1"],
    ["--approve-price", "1", "--by", "   "],
    ["--approve-price", "1", "--by", "x" * 101],
    ["--approve-price", "1", "--by", "a\nb"],
    ["--approve-price", "1", "--by", "A", "--report"],
    ["--report", "--file", "data/golden_skus.json"],
    ["--approve-price", "1", "--by", "A", "--file", "x.json"],
    ["--by", "A"],
    ["--approve-price", "abc", "--by", "A"],
])
def test_cli_usage_errors_exit2_before_connect(argv, monkeypatch):
    _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as ei:
        gs.main(argv)
    assert ei.value.code == 2


class _FakeConn:
    """Conn giả: mọi select trả 0 dòng (id không tồn tại)."""

    def __init__(self):
        self.committed = False
        self.sql = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        return self

    def fetchone(self):
        return None

    def commit(self):
        self.committed = True

    def rollback(self):
        pass

    def close(self):
        pass


def test_cli_approve_unknown_id_exit1_no_write(monkeypatch, capsys):
    fake = _FakeConn()
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(gs, "_connect", lambda _dsn: fake)
    assert gs.main(["--approve-price", "424242", "--by", "Nguyễn A"]) == 1
    assert not fake.committed
    assert not any(s.lstrip().lower().startswith("update")
                   for s in fake.sql)
    assert "không có dòng giá" in capsys.readouterr().out


def test_module_never_writes_products():
    src = (ROOT / "ingest" / "golden_store.py").read_text(encoding="utf-8")
    assert not re.search(r"(update|insert into|delete from) +products",
                         src, re.IGNORECASE)


# ---------- quy cách + phiếu lệch (thuần) ----------

def test_spec_of():
    assert gs.spec_of("SAVINA TUÝP 12 VIÊN") == "12 viên"
    assert gs.spec_of("Saphraton 20V") == "20 viên"
    assert gs.spec_of("Saphraton") is None
    assert gs.spec_of("SAVINA TUBE OF 12 TABLETS") is None
    assert gs.spec_of("120ml x 2 hũ") == "120 ml"
    assert gs.spec_of("30 viên (hộp 3 vỉ x 10 viên)") == "30 viên"
    assert gs.spec_of("Hộp 3 vỉ") is None
    assert gs.spec_of(None) is None


def test_build_discrepancies_all_kinds_no_choice():
    skus = [
        {"sku_key": "a", "name": "A", "category": "tpbvsk",
         "pack_spec": "20 viên", "shopee_item_id": "1",
         "allowed_channels": ["shopee"]},
        {"sku_key": "w", "name": "W", "category": "alcohol",
         "pack_spec": "500ml", "shopee_item_id": "9",
         "allowed_channels": ["shopee"]},
    ]
    prices = {"a": {"shopee": {"floor": 100, "list": 140, "promo": 120}}}
    maps = {"p1": "a"}
    products = [{"id": "p1", "name": "A 30V", "price_vnd": 100},
                {"id": "p2", "name": "Củ sâm", "price_vnd": None}]
    out = gs.build_discrepancies(skus, prices, maps, products)
    kinds = sorted((t["kind"], t["sku_key"], t["product_id"]) for t in out)
    assert kinds == [
        ("alcohol_online_listing", "w", None),
        ("missing_price", "w", None),
        ("price_mismatch", "a", "p1"),
        ("product_unmapped", None, "p2"),
        ("sku_no_product", "w", None),
        ("spec_mismatch", "a", "p1"),
    ]
    pm = next(t for t in out if t["kind"] == "price_mismatch")
    assert pm["detail"]["web"]["price_vnd"] == 100
    assert pm["detail"]["golden"] == prices["a"]
    blob = json.dumps(out).lower()
    assert "chosen" not in blob and "suggest" not in blob
    # Giá web khớp giá list → không lập phiếu giá.
    same = [{"id": "p1", "name": "A", "price_vnd": 140}]
    assert not [t for t in gs.build_discrepancies(skus, prices, maps, same)
                if t["kind"] == "price_mismatch"]


# ---------- DB thật (schema tạm, rollback) ----------
#
# Mỗi test chạy trong 1 transaction trên `DATABASE_URL` (samsam_infra):
# `create schema` tạm + `set local search_path` + chạy docs/schema.sql 2 lần
# vào đó (DDL Postgres có transaction) → bảng golden SẠCH, độc lập với dữ
# liệu public (giá người thật đã duyệt, giá đổi hợp lệ...) — trigger chặn
# DELETE nên public không dọn được, test không được phụ thuộc trạng thái đó.
# ROLLBACK cuối test bỏ cả schema tạm.

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
TODAY = "(now() at time zone 'Asia/Ho_Chi_Minh')::date"


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
        schema = f"t_golden_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)   # idempotent ×2 trên schema đã có
        assert conn.execute(
            "select current_schema(), to_regclass(%s) is not null",
            (f"{schema}.price_list",)).fetchone() == (schema, True)
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _price_id(conn, sku, kind="list", channel="shopee"):
    return conn.execute(
        "select id from price_list where sku_key = %s and channel = %s and"
        " kind = %s and valid_to is null", (sku, channel, kind)
    ).fetchone()[0]


def _raises(conn, sql, params=None):
    # Savepoint riêng: lỗi trigger abort tx — rollback về savepoint rồi
    # pytest.raises mới bắt.
    with pytest.raises(psycopg.errors.RaiseException), conn.transaction():
        conn.execute(sql, params)


# Đổi cột "bất biến" KÈM 1 chuyển trạng thái hợp lệ — nếu trigger mất check
# tuple bất biến thì các câu này lọt qua nhánh (a)/(b). Đổi riêng 1 cột thì
# luôn rơi xuống raise cuối → test pass rỗng (cold-check v3.2).
IMMUTABLE_SETS = [
    "price_vnd = 2000", "kind = 'promo'", "channel = 'web'",
    "program_id = 'km1'", "valid_from = valid_from - 1",
    "created_at = created_at - interval '1 day'",
    "sku_key = 'zz-test-sku2'", "id = default",
]


def test_db_price_list_append_only_trigger(db):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('zz-test-sku', 'test', 'food', 'test'),"
               " ('zz-test-sku2', 'test2', 'food', 'test')")
    ins = ("insert into price_list (sku_key, channel, kind, price_vnd,"
           f" valid_from) values ('zz-test-sku', 'shopee', %s, 1000, {TODAY})"
           " returning id")
    pid = db.execute(ins, ("list",)).fetchone()[0]
    pid2 = db.execute(ins, ("floor",)).fetchone()[0]
    where = (pid,)
    _raises(db, "update price_list set price_vnd = 2000 where id = %s",
            where)
    _raises(db, "update price_list set approved_by = '  ' where id = %s",
            where)
    _raises(db, "update price_list set approved_at = now() where id = %s",
            where)
    _raises(db, "delete from price_list where id = %s", where)
    _raises(db, "truncate price_list")
    _raises(db, "update price_list set valid_to = valid_from - 1"
                " where id = %s", (pid2,))
    for col in IMMUTABLE_SETS:
        _raises(db, f"update price_list set {col}, approved_by = 'X',"
                    " approved_at = now() where id = %s", where)
        _raises(db, f"update price_list set {col}, valid_to = valid_from"
                    " where id = %s", where)
    # Duyệt + đóng cùng lúc → không phải chuyển trạng thái nào.
    _raises(db, "update price_list set valid_to = valid_from,"
                " approved_by = 'X', approved_at = now() where id = %s",
            where)
    # (a) duyệt null -> 'A' OK; 'A' -> 'B' / bỏ duyệt bị chặn.
    with db.transaction():
        db.execute("update price_list set approved_by = 'A',"
                   " approved_at = now() where id = %s", where)
    _raises(db, "update price_list set approved_by = 'B' where id = %s",
            where)
    _raises(db, "update price_list set approved_by = null,"
                " approved_at = null where id = %s", where)
    # Đóng dòng đã duyệt nhưng đổi luôn người duyệt / thời điểm duyệt.
    _raises(db, "update price_list set approved_by = 'B',"
                " valid_to = valid_from where id = %s", where)
    _raises(db, "update price_list set approved_at = approved_at +"
                " interval '1 hour', valid_to = valid_from where id = %s",
            where)
    # (b) đóng null -> ngày OK; đóng lần 2 bị chặn.
    with db.transaction():
        db.execute("update price_list set valid_to = valid_from"
                   " where id = %s", where)
    _raises(db, "update price_list set valid_to = valid_from + 1"
                " where id = %s", where)
    # Dòng đã đóng không được duyệt nữa.
    with db.transaction():
        db.execute("update price_list set valid_to = valid_from"
                   " where id = %s", (pid2,))
    _raises(db, "update price_list set approved_by = 'A' where id = %s",
            (pid2,))
    assert db.execute("select approved_by, valid_to is not null from"
                      " price_list where id = %s", where).fetchone() \
        == ("A", True)


@pytest.mark.parametrize("col, val", [
    ("approved_by", "'GĐ'"),
    ("approved_by", "'  '"),
    ("approved_at", "now()"),
    ("valid_to", TODAY),
])
def test_db_price_list_insert_must_be_open_unapproved(db, col, val):
    """INSERT sẵn-duyệt / sẵn-đóng vượt cổng người → trigger chặn; duyệt
    chỉ đi qua UPDATE (a) đã kiểm."""
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('zz-test-sku', 'test', 'food', 'test')")
    _raises(db, "insert into price_list (sku_key, channel, kind, price_vnd,"
                f" valid_from, {col}) values ('zz-test-sku', 'web', 'list',"
                f" 1000, {TODAY}, {val})")
    assert db.execute("select count(*) from price_list").fetchone()[0] == 0
    db.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
               f" valid_from) values ('zz-test-sku', 'web', 'list', 1000,"
               f" {TODAY})")
    assert db.execute("select count(*) from price_list").fetchone()[0] == 1


def _golden_counts(conn):
    return tuple(conn.execute(sql).fetchone()[0] for sql in (
        "select count(*) from sku_master where source = 'golden_skus.json'",
        "select count(*) from sku_map where source = 'golden_skus.json'",
        ("select count(*) from price_list p join sku_master m"
         " using (sku_key) where m.source = 'golden_skus.json'"),
    ))


def test_db_load_idempotent_and_keeps_manual(db):
    doc = _doc()
    gs.load(db, doc)
    first = _golden_counts(db)
    assert first == (13, 15, 34)
    st = gs.load(db, doc)
    assert (st["sku_changed"], st["map_changed"], st["price_inserted"],
            st["price_closed"], st["price_same"]) == (0, 0, 0, 0, 34)
    assert _golden_counts(db) == first
    assert db.execute("select max(version) from sku_master where source ="
                      " 'golden_skus.json'").fetchone()[0] == 1
    # Row manual không bị đè.
    db.execute("update sku_master set source = 'manual', name = 'Tay sửa'"
               " where sku_key = 'savina-12v'")
    db.execute("update sku_map set source = 'manual', sku_key ="
               " 'saphraton-20v' where product_id = 'wc-2298'")
    st = gs.load(db, doc)
    assert st["sku_changed"] == 0 and st["map_changed"] == 0
    assert db.execute("select name, source from sku_master where sku_key ="
                      " 'savina-12v'").fetchone() == ("Tay sửa", "manual")
    assert db.execute("select sku_key from sku_map where product_id ="
                      " 'wc-2298'").fetchone()[0] == "saphraton-20v"
    # SKU vắng khỏi file → giữ nguyên (không xóa).
    small = {"skus": [s for s in doc["skus"]
                      if s["sku_key"] == "sapentol-30v"]}
    gs.load(db, small)
    assert db.execute("select count(*) from sku_master where sku_key ="
                      " 'da-an-sam-30v'").fetchone()[0] == 1


def test_db_price_change_closes_old_row(db):
    doc = _doc()
    gs.load(db, doc)
    before = db.execute("select count(*) from price_list").fetchone()[0]
    old_id = _price_id(db, "savina-12v")
    changed = copy.deepcopy(doc)
    sav = next(s for s in changed["skus"] if s["sku_key"] == "savina-12v")
    sav["prices"]["shopee"]["list"] = 158000
    assert gs.validate(changed) == []
    st = gs.load(db, changed)
    assert (st["price_inserted"], st["price_closed"]) == (1, 1)
    assert db.execute("select count(*) from price_list").fetchone()[0] \
        == before + 1
    assert db.execute(f"select valid_to = {TODAY}, price_vnd from"
                      " price_list where id = %s", (old_id,)).fetchone() \
        == (True, 159000)
    new_id = _price_id(db, "savina-12v")
    assert new_id != old_id
    assert db.execute("select price_vnd, approved_by from price_list"
                      " where id = %s", (new_id,)).fetchone() == (158000,
                                                                   None)
    assert db.execute("select version from sku_master where sku_key ="
                      " 'savina-12v'").fetchone()[0] == 1   # giá ≠ master
    ok, msg = gs.approve_price(db, old_id, "A")
    assert not ok and "đã đóng" in msg


def test_db_sku_map_remap_clears_approval(db):
    doc = _doc()
    gs.load(db, doc)
    db.execute("update sku_map set approved_by = 'Sản xuất', note ="
               " 'ghi tay' where product_id = 'wc-2298'")
    # Cùng sku_key (note đổi → upsert chạy) → giữ duyệt của Sản xuất.
    assert gs.load(db, doc)["map_changed"] == 1
    assert db.execute("select sku_key, approved_by from sku_map where"
                      " product_id = 'wc-2298'").fetchone() \
        == ("savina-12v", "Sản xuất")
    # Map sang SKU khác → duyệt cũ hết giá trị.
    remap = copy.deepcopy(doc)
    for s in remap["skus"]:
        if s["sku_key"] == "savina-12v":
            s["product_ids"].remove("wc-2298")
        elif s["sku_key"] == "saphraton-20v":
            s["product_ids"].append("wc-2298")
    assert gs.validate(remap) == []
    assert gs.load(db, remap)["map_changed"] == 1
    assert db.execute("select sku_key, approved_by from sku_map where"
                      " product_id = 'wc-2298'").fetchone() \
        == ("saphraton-20v", None)


def test_db_discrepancies_and_resolved_kept(db):
    db.execute("insert into products (id, name, price_vnd, source) values"
               " ('wc-2298', 'SAVINA TUÝP 12 VIÊN', 128000, 'test')"
               " on conflict (id) do nothing")
    gs.load(db, _doc())
    c1 = gs.apply_discrepancies(db)
    n1 = db.execute("select count(*) from golden_discrepancies").fetchone()
    c2 = gs.apply_discrepancies(db)
    assert c1 == c2
    assert db.execute("select count(*) from golden_discrepancies"
                      ).fetchone() == n1
    web = db.execute("select price_vnd from products where id = 'wc-2298'"
                     ).fetchone()[0]
    detail = db.execute(
        "select detail from golden_discrepancies where kind ="
        " 'price_mismatch' and sku_key = 'savina-12v' and product_id ="
        " 'wc-2298'").fetchone()[0]
    assert detail["web"]["price_vnd"] == web == 128000
    assert detail["golden"]["shopee"] == {"floor": 128000, "list": 159000,
                                          "promo": 132000}
    missing = {r[0] for r in db.execute(
        "select sku_key from golden_discrepancies where kind ="
        " 'missing_price'")}
    assert {"saphraton-40v", "ruou-sam-binh-su-do-500ml"} <= missing
    assert db.execute("select count(*) from golden_discrepancies where kind"
                      " = 'alcohol_online_listing'").fetchone()[0] >= 1
    # Người đánh dấu resolved → nạp lại KHÔNG mở lại.
    db.execute("update golden_discrepancies set status = 'resolved',"
               " resolved_by = 'Pháp chế' where kind = 'missing_price' and"
               " sku_key = 'saphraton-40v'")
    gs.load(db, _doc())
    gs.apply_discrepancies(db)
    assert db.execute(
        "select status, resolved_by from golden_discrepancies where kind ="
        " 'missing_price' and sku_key = 'saphraton-40v'").fetchone() \
        == ("resolved", "Pháp chế")


def _ticket(conn, kind, sku):
    return conn.execute(
        "select status, resolved_by, source from golden_discrepancies where"
        " kind = %s and sku_key = %s", (kind, sku)).fetchone()


def test_db_stale_ticket_deleted_only_if_pending_loader(db):
    gs.load(db, _doc())
    gs.apply_discrepancies(db)
    assert _ticket(db, "missing_price", "saphraton-40v")[0] == "pending"
    assert _ticket(db, "missing_price", "ruou-sam-binh-su-do-500ml")[0] \
        == "pending"
    db.execute("update golden_discrepancies set status = 'resolved',"
               " resolved_by = 'Pháp chế' where kind = 'missing_price' and"
               " sku_key = 'ruou-sam-binh-su-do-500ml'")
    db.execute("insert into golden_discrepancies (kind, sku_key, detail,"
               " source) values ('missing_price', 'zz-manual', '{}',"
               " 'manual')")
    # Điều kiện hết đúng: đủ giá shopee (dòng mới, chờ duyệt) cho 2 SKU.
    for sku, prices in (("saphraton-40v", {"list": 600000, "promo": 500000}),
                        ("ruou-sam-binh-su-do-500ml",
                         {"floor": 500000, "list": 700000,
                          "promo": 600000})):
        for kind, price in prices.items():
            db.execute("insert into price_list (sku_key, channel, kind,"
                       f" price_vnd, valid_from) values (%s, 'shopee', %s,"
                       f" %s, {TODAY})", (sku, kind, price))
    gs.apply_discrepancies(db)
    # pending của loader hết điều kiện → xóa.
    assert _ticket(db, "missing_price", "saphraton-40v") is None
    # resolved của người + phiếu manual → giữ nguyên.
    assert _ticket(db, "missing_price", "ruou-sam-binh-su-do-500ml") \
        == ("resolved", "Pháp chế", "golden_store")
    assert _ticket(db, "missing_price", "zz-manual") \
        == ("pending", None, "manual")


def _promotable(conn):
    return conn.execute("select sku_key, channel, readiness from"
                        " v_promotable order by 1, 2").fetchall()


def _readiness(conn, sku):
    return dict(conn.execute("select channel, readiness from sku_readiness"
                             " where sku_key = %s", (sku,)).fetchall())


def test_db_promotable_requires_human_approval_and_readiness(db):
    gs.load(db, _doc())
    assert _promotable(db) == []
    # Mật ong: giá duyệt nhưng tự công bố chưa xác minh → CAM.
    ok, msg = gs.approve_price(db, _price_id(db, "mat-ong-sam-120ml-1hu"),
                               "Người duyệt test")
    assert ok, msg
    assert _readiness(db, "mat-ong-sam-120ml-1hu")["shopee"] == "CAM"
    assert _promotable(db) == []
    db.execute("update sku_master set self_declaration_ok = true where"
               " sku_key = 'mat-ong-sam-120ml-1hu'")
    assert _promotable(db) == [("mat-ong-sam-120ml-1hu", "shopee",
                                "TP_THUONG")]
    # Duyệt lại cùng dòng → từ chối.
    ok, msg = gs.approve_price(db, _price_id(db, "mat-ong-sam-120ml-1hu"),
                               "B")
    assert not ok and "đã được duyệt" in msg
    # TPBVSK chưa XNQC → MO_TA, không promotable; kênh ngoài allowed → CAM.
    assert gs.approve_price(db, _price_id(db, "savina-12v"), "A")[0]
    r = _readiness(db, "savina-12v")
    assert r["shopee"] == "MO_TA" and r["tiktok"] == "CAM"
    assert "savina-12v" not in {p[0] for p in _promotable(db)}
    db.execute("update sku_master set xnqc_status = 'approved' where"
               " sku_key = 'savina-12v'")
    assert _readiness(db, "savina-12v")["shopee"] == "QC_DAY_DU"
    assert ("savina-12v", "shopee", "QC_DAY_DU") in _promotable(db)
    # Rượu: mọi kênh được phép + giá duyệt → vẫn CAM mọi kênh.
    db.execute("update sku_master set allowed_channels = %s where"
               " sku_key = 'ruou-sam-chai-thuy-tinh-500ml'",
               (list(gs.CHANNELS),))
    assert gs.approve_price(
        db, _price_id(db, "ruou-sam-chai-thuy-tinh-500ml"), "A")[0]
    r = _readiness(db, "ruou-sam-chai-thuy-tinh-500ml")
    assert set(r) == set(gs.CHANNELS) and set(r.values()) == {"CAM"}
    assert not [p for p in _promotable(db) if p[0].startswith("ruou")]
    ok, msg = gs.approve_price(db, -1, "A")
    assert not ok and "không có dòng giá" in msg


def test_db_readiness_fail_closed_on_null_channel_element(db):
    """`kênh = any('{web,NULL}')` = NULL với kênh ngoài list — readiness
    phải CAM, không rơi xuống TP_THUONG (row manual/SQL tay không qua
    validate())."""
    db.execute(
        "insert into sku_master (sku_key, name, category,"
        " self_declaration_ok, allowed_channels, source) values"
        " ('zz-food-web', 'x', 'food', true, array['web', null], 'manual'),"
        " ('zz-food-shopee', 'y', 'food', true, array['shopee', null],"
        " 'manual')")
    r = _readiness(db, "zz-food-web")
    assert r.pop("web") == "TP_THUONG" and set(r.values()) == {"CAM"}
    r = _readiness(db, "zz-food-shopee")
    assert r["tiktok"] == "CAM" and r["shopee"] == "TP_THUONG"
    for ch in ("shopee", "tiktok"):
        pid = db.execute(
            "insert into price_list (sku_key, channel, kind, price_vnd,"
            f" valid_from) values ('zz-food-shopee', %s, 'list', 1000,"
            f" {TODAY}) returning id", (ch,)).fetchone()[0]
        assert gs.approve_price(db, pid, "A")[0]
    assert _promotable(db) == [("zz-food-shopee", "shopee", "TP_THUONG")]


# ---------- CLI đường thành công (conn thật trong tx test) ----------

class _TxConn:
    """Bọc conn test: commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại
    trong tx của fixture (rollback cuối test). Bắt lỗi quên commit (gotcha
    savepoint v2.1: in '[done]' nhưng không persist)."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0
        self.rolled_back = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        pass


def _run_main(db, monkeypatch, argv):
    proxy = _TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(gs, "_connect", lambda _dsn: proxy)
    return gs.main(argv), proxy


def test_db_cli_load_approve_report_success(db, monkeypatch, capsys):
    rc, proxy = _run_main(db, monkeypatch, [])
    assert rc == 0 and (proxy.committed, proxy.rolled_back) == (1, 0)
    assert _golden_counts(db) == (13, 15, 34)
    out = capsys.readouterr().out
    assert "price_inserted=34" in out and "sku_master=13" in out

    pid = _price_id(db, "mat-ong-sam-300ml")
    rc, proxy = _run_main(db, monkeypatch,
                          ["--approve-price", str(pid), "--by", "GĐ test"])
    assert rc == 0 and (proxy.committed, proxy.rolled_back) == (1, 0)
    assert db.execute("select approved_by, approved_at is not null from"
                      " price_list where id = %s", (pid,)).fetchone() \
        == ("GĐ test", True)
    assert "[done] đã duyệt" in capsys.readouterr().out

    rc, proxy = _run_main(db, monkeypatch, ["--report"])
    assert rc == 0 and proxy.committed == 0
    out = capsys.readouterr().out
    assert "33 dòng giá chờ" in out
    assert re.search(r"^  #\d+ missing_price sku=saphraton-40v ", out,
                     re.MULTILINE)
    pending_ids = {int(m) for m in re.findall(r"^  id=(\d+) ", out,
                                              re.MULTILINE)}
    assert len(pending_ids) == 33 and pid not in pending_ids
