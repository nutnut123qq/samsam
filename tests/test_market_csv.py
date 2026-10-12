"""v3.3-connector-csv — `ingest.market_csv` (connector sàn P1, chỉ đọc).

Phần thuần (read_export / map_sku / find_alerts / argparse) không cần DB.
Phần DB thật chạy trên `DATABASE_URL` (samsam_infra) trong 1 transaction +
schema tạm (docs/schema.sql) + golden nạp từ data/golden_skus.json, ROLLBACK
cuối test (mẫu `tests/test_golden_store.py`). Fixture CSV là dữ liệu TỔNG
HỢP (tên/SĐT/địa chỉ giả rõ ràng), không phải file thật của khách.
"""

import json
import os
import re
import unicodedata
import uuid
from pathlib import Path

import psycopg
import pytest

from ingest import golden_store as gs
from ingest import market_csv as mc

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "market"
LISTING = FIX / "fixture_shopee_listing.csv"
LISTING_FIXED = FIX / "fixture_shopee_listing_fixed.csv"
ADS = FIX / "fixture_shopee_ads.csv"
ORDER = FIX / "fixture_shopee_order.csv"
MISSING = FIX / "fixture_shopee_listing_missing_col.csv"

# Chuỗi PII GIẢ trong fixture order — không được lọt vào rows/DB/stdout.
PII = ("NGUOI MUA GIA", "NGUOI NHAN GIA", "nguoimuagia", "0900000000",
       "0900000001", "DUONG GIA LAP", "GHI CHU GIA", "FAKEORDER")
PII_RE = "NGUOI (MUA|NHAN) GIA|nguoimuagia|090000000|DUONG GIA LAP|" \
         "GHI CHU GIA|FAKEORDER"


def _map() -> dict:
    m, why = mc.load_mapping()
    assert why is None
    return m


def _read(path, kind="listing", channel="shopee"):
    return mc.read_export(path, channel, kind, _map())


def _write(tmp_path, name, text, encoding="utf-8") -> Path:
    p = tmp_path / name
    p.write_bytes(text.encode(encoding))
    return p


LISTING_HDR = "Mã sản phẩm,Tên sản phẩm,SKU phân loại,Giá,Kho hàng,Trạng thái"


# ---------- mapping ----------

def test_mapping_doc_and_sanity():
    m = _map()
    assert "chưa xác minh với file thật" in m["_doc"]
    for ch in mc.CHANNELS:
        for kind in mc.KINDS:
            spec = m[ch][kind]
            fields = set(spec["required"]) | set(spec.get("optional", {}))
            assert fields <= set(mc.FIELDS), (ch, kind)
            assert not set(spec["required"]) & set(spec.get("optional", {}))
            heads = (list(spec["required"].values())
                     + list(spec.get("optional", {}).values())
                     + spec.get("drop", []))
            # 1 header chỉ thuộc 1 nhóm — drop không được trùng allowlist.
            assert len(heads) == len(set(heads)), (ch, kind)
        order = m[ch]["order"]
        assert "order_id" in order["required"] and order["cancel_status"]
        assert len(order["drop"]) >= 5
        assert m[ch]["listing"]["inactive_status"]


# ---------- parser thuần ----------

def test_parse_fixtures_counts():
    for path, kind, n in ((LISTING, "listing", 5), (LISTING_FIXED,
                          "listing", 5), (ADS, "ads", 3), (ORDER, "order", 4)):
        rows, errs, sha = _read(path, kind)
        assert errs == [] and len(rows) == n, path.name
        assert re.fullmatch(r"[0-9a-f]{64}", sha)
    rows, _, _ = _read(LISTING)
    by_item = {r["item_id"]: r for r in rows}
    assert by_item["24325987926"]["price"] == 482900          # "482.900"
    assert by_item["27325048614"]["price"] == 745000          # "745.000 ₫"
    assert by_item["54916394790"]["price"] == 745000          # "745,000"
    assert by_item["54916394790"]["seller_sku"] == "mat-ong-sam-120ml-1hu"
    assert by_item["27357883504"]["seller_sku"] is None
    assert [r["row_no"] for r in rows] == [2, 3, 4, 5, 6]
    for r in rows:
        assert set(r) == {"row_no", *mc.FIELDS} - {"order_id"}


def test_missing_required_column():
    rows, errs, _ = _read(MISSING)
    assert rows == [] and len(errs) == 1
    assert "thiếu cột bắt buộc" in errs[0] and "'Giá'" in errs[0]


def test_unknown_and_duplicate_header(tmp_path):
    p = _write(tmp_path, "x.csv", LISTING_HDR + ",Email người mua\n"
               "1,a,,100,1,Đang hoạt động,a@b.c\n")
    rows, errs, _ = _read(p)
    assert rows == [] and any("cột lạ 'Email người mua'" in e for e in errs)
    assert not any("a@b.c" in e for e in errs)
    p = _write(tmp_path, "d.csv", LISTING_HDR + ",Giá\n"
               "1,a,,100,1,Đang hoạt động,100\n")
    rows, errs, _ = _read(p)
    assert rows == [] and any("header trùng: 'Giá'" in e for e in errs)


def test_empty_header_only_suffix_encoding(tmp_path):
    for name, data in (("e.csv", b""), ("w.csv", b"  \r\n\n"),
                       ("h.csv", (LISTING_HDR + "\n").encode()),
                       ("x.txt", (LISTING_HDR + "\n1,a,,1,1,b\n").encode()),
                       ("b.csv", (LISTING_HDR + "\n1,a,,1,1,").encode()
                        + b"\xff\xfe\n")):
        p = tmp_path / name
        p.write_bytes(data)
        rows, errs, _ = _read(p)
        assert rows == [] and errs, name
    assert "không hỗ trợ" in _read(tmp_path / "x.txt")[1][0]
    assert "không phải UTF-8" in _read(tmp_path / "b.csv")[1][0]
    assert "chỉ có header" in _read(tmp_path / "h.csv")[1][0]
    # BOM utf-8-sig + CRLF + dòng trống cuối file → vẫn đọc đúng.
    p = tmp_path / "bom.csv"
    p.write_bytes(b"\xef\xbb\xbf" + (LISTING_HDR + "\r\n1,a,,100,1,X\r\n\r\n")
                  .encode())
    rows, errs, _ = _read(p)
    assert errs == [] and len(rows) == 1 and rows[0]["item_id"] == "1"


@pytest.mark.parametrize("bad", ["abc", "-5", "12,5", "1.234,50", "1.23.456",
                                 "99999999999999999999", "9" * 5000,
                                 "\u0661\u0662\u0663"])
def test_bad_number_reports_row_not_value(tmp_path, bad):
    p = _write(tmp_path, "p.csv", LISTING_HDR + "\n1,a,,100,1,X\n"
               f'2,b,,"{bad}",1,X\n')
    rows, errs, _ = _read(p)
    assert rows == [] and errs == [
        "dòng 3: field 'price' không phải số nguyên ≥ 0 hợp lệ"]


def test_header_errors_never_echo_pii(tmp_path):
    # File order thiếu dòng header → dòng đầu là DỮ LIỆU người mua: chỉ báo
    # chung, không in ô nào.
    lines = ORDER.read_text(encoding="utf-8").splitlines()[1:]
    p = _write(tmp_path, "nohdr.csv", "\n".join(lines) + "\n")
    rows, errs, _ = _read(p, "order")
    assert rows == [] and len(errs) == 1 and "không khớp header" in errs[0]
    joined = "\n".join(errs)
    for s in PII:
        assert s not in joined, s
    # Header lạ cạnh header đúng: tên cột được nêu nhưng SĐT/email bị che,
    # ký tự điều khiển (escape terminal) bị thay.
    p = _write(tmp_path, "odd.csv", LISTING_HDR + ",Liên hệ 0900000000,"
               "\x1b[31mX\n1,a,,1,1,X,,\n")
    rows, errs, _ = _read(p)
    joined = "\n".join(errs)
    assert rows == [] and "0900000000" not in joined and "\x1b" not in joined
    assert "cột lạ 'Liên hệ ***'" in joined

def test_row_without_item_and_sku(tmp_path):
    p = _write(tmp_path, "n.csv", LISTING_HDR + "\n,a,,100,1,X\n")
    rows, errs, _ = _read(p)
    assert rows == [] and errs == ["dòng 2: thiếu cả item_id lẫn seller_sku"]


def test_order_drops_pii_and_hashes_order_id():
    rows, errs, _ = _read(ORDER, "order")
    assert errs == []
    dumped = json.dumps(rows, ensure_ascii=False)
    for s in PII:
        assert s not in dumped, s
    hashes = [r["order_id_hash"] for r in rows]
    assert all(re.fullmatch(r"[0-9a-f]{16}", h) for h in hashes)
    assert hashes[0] == hashes[1] != hashes[2]       # 2 dòng cùng 1 đơn
    assert all("order_id" not in r for r in rows)
    assert {r["status"] for r in rows} == {"Hoàn thành", "Đã hủy",
                                           "Đang giao"}


def test_xlsx_same_rows_as_csv(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    import csv
    for path, kind in ((LISTING, "listing"), (ADS, "ads"), (ORDER, "order")):
        wb = openpyxl.Workbook()
        ws = wb.active
        text = path.read_text(encoding="utf-8-sig")
        for r in csv.reader(text.splitlines()):
            # ô toàn chữ số → số thật (như Excel), còn lại giữ chuỗi
            ws.append([int(c) if c.isdigit() else (c or None) for c in r])
        x = tmp_path / (path.stem + ".xlsx")
        wb.save(x)
        a, ea, _ = _read(path, kind)
        b, eb, _ = _read(x, kind)
        assert ea == eb == [] and a == b, path.name


def _xlsx(tmp_path, name, rows) -> Path:
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    p = tmp_path / name
    wb.save(p)
    return p


ADS_HDR = ["Mã sản phẩm", "Tên quảng cáo", "Chi phí"]


def test_xlsx_float_cells_never_scaled(tmp_path):
    # float nguyên (Excel lưu số dạng double) → số đúng
    p = _xlsx(tmp_path, "ok.xlsx", [LISTING_HDR.split(","),
                                    [1, "a", None, 482900.0, 1.0, "X"]])
    rows, errs, _ = _read(p)
    assert errs == [] and rows[0]["price"] == 482900 and rows[0]["stock"] == 1
    # float có phần lẻ: repr(12.345)="12.345" từng khớp nhóm-nghìn → 12345
    # (×1000 câm). Phải là lỗi nêu số dòng, 0 dòng nạp.
    for bad in (12.345, 1.234, 250.125, 482.9):
        p = _xlsx(tmp_path, "p.xlsx", [LISTING_HDR.split(","),
                                       [1, "a", None, 100, 1, "X"],
                                       [2, "b", None, bad, 1, "X"]])
        rows, errs, _ = _read(p)
        assert rows == [] and errs == [
            "dòng 3: field 'price' không phải số nguyên ≥ 0 hợp lệ"], bad
    p = _xlsx(tmp_path, "ads.xlsx", [ADS_HDR, ["24825885894", "QC", 250.125]])
    rows, errs, _ = _read(p, "ads")
    assert rows == [] and errs == [
        "dòng 2: field 'ads_spend' không phải số nguyên ≥ 0 hợp lệ"]


def test_xlsx_inflated_used_range_rejected_before_iterating(tmp_path):
    # 1 ô lạc xa phía dưới / bên phải → dimension phóng đại; read-only
    # openpyxl sẽ đệm hàng trăm nghìn dòng rỗng nếu duyệt → chặn trước.
    openpyxl = pytest.importorskip("openpyxl")
    for r, c in ((mc.MAX_ROWS + 5, 1), (3, mc.MAX_COLS + 50)):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(LISTING_HDR.split(","))
        ws.append([1, "a", None, 100, 1, "X"])
        ws.cell(row=r, column=c, value="x")
        p = tmp_path / f"far_{r}_{c}.xlsx"
        wb.save(p)
        assert p.stat().st_size < 20_000
        rows, errs, _ = _read(p)
        assert rows == [] and len(errs) == 1 and "vượt trần" in errs[0], (r, c)


def _patch_dimension(p: Path, ref: str) -> None:
    """Ghi đè <dimension ref=...> trong sheet1.xml (giả lập generator
    khai used-range SAI)."""
    import zipfile
    src = p.read_bytes()
    out = p.with_suffix(".tmp")
    with zipfile.ZipFile(p) as zin, zipfile.ZipFile(out, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "xl/worksheets/sheet1.xml":
                data, n = re.subn(rb'<dimension ref="[^"]*"',
                                  b'<dimension ref="' + ref.encode() + b'"',
                                  data)
                assert n == 1
            zout.writestr(info, data)
    os.replace(out, p)
    assert p.read_bytes() != src


def test_xlsx_understated_dimension_reads_all_rows(tmp_path):
    # dimension khai A1:F2 nhưng có 3 dòng dữ liệu — dòng cuối là rượu
    # đang hoạt động; read-only openpyxl từng dừng ở max_row → mất dòng
    # rượu câm (errs=[]) → không phát S1 alcohol_listed.
    rows3 = [LISTING_HDR.split(","),
             ["24325987926", "a", None, 482900, 1, "Đang hoạt động"],
             ["54916394790", "b", None, 745000, 1, "Đang hoạt động"],
             ["27325048614", "Rượu sâm (FIXTURE)", None, 745000, 1,
              "Đang hoạt động"]]
    p = _xlsx(tmp_path, "dim.xlsx", rows3)
    _patch_dimension(p, "A1:F2")
    rows, errs, _ = _read(p)
    assert errs == [] and [r["item_id"] for r in rows] == [
        "24325987926", "54916394790", "27325048614"]
    assert [r["row_no"] for r in rows] == [2, 3, 4]
    # dimension khai thiếu KHÔNG mở lỗ vượt trần: ô lạc xa phía dưới vẫn
    # bị trần MAX_ROWS bắt trong lúc duyệt; ô ở cột MAX_COLS+1 cũng vậy.
    for r, c, err in ((mc.MAX_ROWS + 5, 1,
                       f"file > {mc.MAX_ROWS} dòng — tách file"),
                      (3, mc.MAX_COLS + 1,
                       f"dòng 3: có ô ngoài {mc.MAX_COLS} cột")):
        openpyxl = pytest.importorskip("openpyxl")
        wb = openpyxl.Workbook()
        ws = wb.active
        for row in rows3:
            ws.append(row)
        ws.cell(row=r, column=c, value="x")
        p = tmp_path / f"dimfar_{r}_{c}.xlsx"
        wb.save(p)
        _patch_dimension(p, "A1:F2")
        rows, errs, _ = _read(p)
        assert rows == [] and errs == [err], (r, c)


def test_csv_row_and_col_caps_while_streaming(tmp_path):
    data_row = "1,a,,100,1,X\n"
    # toàn dòng trống vượt trần dòng (đếm cả dòng trống) → lỗi, không nạp
    p = _write(tmp_path, "blank.csv", LISTING_HDR + "\n" + "\n" * mc.MAX_ROWS
               + data_row)
    rows, errs, _ = _read(p)
    assert rows == [] and errs == [f"file > {mc.MAX_ROWS} dòng — tách file"]
    # đúng trần → vẫn đọc được (trần không cắt file hợp lệ)
    p = _write(tmp_path, "edge.csv", LISTING_HDR + "\n" + "\n"
               * (mc.MAX_ROWS - 2) + data_row)
    rows, errs, _ = _read(p)
    assert errs == [] and rows[0]["row_no"] == mc.MAX_ROWS
    # ô có dữ liệu ngoài MAX_COLS → lỗi; ô RỖNG thừa cuối dòng → bỏ qua
    p = _write(tmp_path, "wide.csv", LISTING_HDR + "\n" + data_row.strip()
               + "," * mc.MAX_COLS + "z\n")
    rows, errs, _ = _read(p)
    assert rows == [] and errs == [f"dòng 2: có ô ngoài {mc.MAX_COLS} cột"]
    p = _write(tmp_path, "wide_empty.csv", LISTING_HDR + "\n"
               + data_row.strip() + "," * (mc.MAX_COLS * 2) + "\n")
    rows, errs, _ = _read(p)
    assert errs == [] and len(rows) == 1


def test_xlsx_corrupt_is_error(tmp_path):
    p = _write(tmp_path, "bad.xlsx", "không phải zip")
    rows, errs, _ = _read(p)
    assert rows == [] and errs and "XLSX" in errs[0]


def test_tiktok_listing_parse(tmp_path):
    spec = _map()["tiktok"]["listing"]
    hdr = [spec["required"][f] for f in ("item_id", "title", "price",
                                         "status")] + [spec["optional"]
                                                       ["seller_sku"]]
    p = _write(tmp_path, "t.csv", ",".join(hdr) + "\n1729,Savina,159000,"
               "Live,savina-12v\n")
    rows, errs, _ = _read(p, channel="tiktok")
    assert errs == [] and rows[0]["seller_sku"] == "savina-12v"
    assert rows[0]["price"] == 159000


# ---------- ánh xạ + đối chiếu thuần ----------

SKUS = {
    "savina-12v": {"category": "tpbvsk", "xnqc_status": "none",
                   "shopee_item_id": "27357883504"},
    "mat-ong-sam-120ml-1hu": {"category": "food", "xnqc_status": "none",
                              "shopee_item_id": "54916394790"},
    "mat-ong-sam-120ml-2hu": {"category": "food", "xnqc_status": "none",
                              "shopee_item_id": "54916394790"},
    "ruou-x": {"category": "alcohol", "xnqc_status": "none",
               "shopee_item_id": "27325048614"},
}


def test_map_sku_rules():
    assert mc.map_sku({"seller_sku": "savina-12v", "item_id": "x"},
                      "shopee", SKUS) == ("savina-12v", [])
    assert mc.map_sku({"item_id": "27357883504"}, "shopee", SKUS) \
        == ("savina-12v", [])
    # item chung 2 biến thể → không tự chọn
    assert mc.map_sku({"item_id": "54916394790"}, "shopee", SKUS) == (
        None, ["mat-ong-sam-120ml-1hu", "mat-ong-sam-120ml-2hu"])
    # TikTok không map qua shopee_item_id
    assert mc.map_sku({"item_id": "27357883504"}, "tiktok", SKUS) \
        == (None, [])


def test_find_alerts_alcohol_status_fail_closed():
    base = {"row_no": 2, "item_id": "27325048614", "seller_sku": None,
            "title": "r", "price": 1}
    for st, hit in ((None, True), ("Đang hoạt động", True), ("lạ", True),
                    ("Đã ẩn", False),
                    (unicodedata.normalize("NFD", "Đã ẩn"), False)):
        got = mc.find_alerts([{**base, "status": st}], "shopee", "listing",
                             SKUS, {}, ["Đã ẩn"])
        assert (("alcohol_listed", "27325048614", "") in got) is hit, st
    assert mc.find_alerts([{**base, "status": None}], "shopee", "order",
                          SKUS, {}, []) == {}


# ---------- CLI không DB ----------

def _no_connect(monkeypatch):
    calls = []

    def boom(dsn):
        calls.append(dsn)
        raise AssertionError("connect không được gọi")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(mc, "_connect", boom)
    return calls


@pytest.mark.parametrize("argv", [
    [],
    ["--file", "x.csv", "--channel", "lazada", "--kind", "listing"],
    ["--file", "x.csv", "--channel", "shopee", "--kind", "promo"],
    ["--file", "x.csv", "--channel", "shopee"],
    ["--file", "x.csv", "--kind", "ads"],
    ["--file", "x.csv", "--channel", "shopee", "--kind", "ads", "--report"],
    ["--report", "--channel", "shopee"],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        mc.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_schema_errors_exit1_before_connect(monkeypatch, tmp_path,
                                                capsys):
    calls = _no_connect(monkeypatch)
    unknown = _write(tmp_path, "u.csv", LISTING_HDR + ",Số điện thoại\n"
                     "1,a,,1,1,X,0900000000\n")
    empty = _write(tmp_path, "e.csv", "")
    for p in (MISSING, unknown, empty):
        rc = mc.main(["--file", str(p), "--channel", "shopee", "--kind",
                      "listing"])
        assert rc == 1
    assert calls == []
    out = capsys.readouterr().out
    assert "không connect, không nạp gì" in out and "0900000000" not in out


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
        schema = f"t_market_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.market_alerts",)).fetchone()[0]
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


def _run(db, monkeypatch, path, kind, channel="shopee"):
    proxy = _TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(mc, "_connect", lambda _dsn: proxy)
    rc = mc.main(["--file", str(path), "--channel", channel, "--kind", kind])
    return rc, proxy.committed


def _counts(db):
    return tuple(db.execute(f"select count(*) from {t}").fetchone()[0]
                 for t in ("market_snapshots", "market_rows",
                           "market_alerts"))


def _golden_state(db):
    return db.execute(
        "select count(*), max(id), count(*) filter (where approved_by is not"
        " null), sum(price_vnd) from price_list").fetchone() + db.execute(
        "select count(*) from sku_master").fetchone()


def _open(db):
    return {r[0]: r[1:] for r in db.execute(
        "select kind, severity, sku_key, item_id, detail from market_alerts"
        " where status = 'open'")}


def test_db_load_idempotent_and_no_pii(db, monkeypatch, capsys):
    assert _run(db, monkeypatch, LISTING, "listing") == (0, 1)
    c1 = _counts(db)
    assert c1[:2] == (1, 5)
    assert _run(db, monkeypatch, LISTING, "listing") == (0, 0)
    assert "[skip] file đã nạp" in capsys.readouterr().out
    assert _counts(db) == c1
    # nạp nhầm kênh/loại → header không khớp mapping → exit 1, 0 ghi
    assert _run(db, monkeypatch, LISTING, "ads", "tiktok") == (1, 0)
    assert _counts(db) == c1
    assert _run(db, monkeypatch, ORDER, "order") == (0, 1)
    sid = db.execute("select id from market_snapshots where export_kind ="
                     " 'order'").fetchone()[0]
    assert db.execute(
        "select count(*), count(order_id_hash) from market_rows where"
        " snapshot_id = %s", (sid,)).fetchone() == (4, 4)
    assert db.execute(
        "select count(*) from market_rows where raw::text ~* %s"
        " or title ~* %s", (PII_RE, PII_RE)).fetchone()[0] == 0
    out = capsys.readouterr().out
    assert not re.search(PII_RE, out)
    # map golden lúc nạp: savina qua item_id, mật ong qua seller_sku
    assert dict(db.execute(
        "select item_id, sku_key from market_rows r join market_snapshots s"
        " on s.id = r.snapshot_id where s.export_kind = 'listing'")) == {
        "27357883504": "savina-12v", "24325987926": "savigout-30v",
        "27325048614": "ruou-sam-chai-thuy-tinh-500ml", "99900000001": None,
        "54916394790": "mat-ong-sam-120ml-1hu"}


def test_db_four_alerts_open_close_reopen(db, monkeypatch, tmp_path):
    before = _golden_state(db)
    assert before[2] == 0 and before[4] == 13
    for path, kind in ((LISTING, "listing"), (ADS, "ads"), (ORDER, "order")):
        assert _run(db, monkeypatch, path, kind) == (0, 1)
    alerts = _open(db)
    assert set(alerts) == {"alcohol_listed", "price_mismatch",
                           "tpbvsk_ads_no_xnqc", "item_unmapped"}
    assert db.execute("select count(*) from market_alerts").fetchone()[0] == 4
    assert alerts["alcohol_listed"][:2] == ("S1",
                                            "ruou-sam-chai-thuy-tinh-500ml")
    pm = alerts["price_mismatch"]
    assert pm[:3] == ("S2", "savigout-30v", "24325987926")
    assert (pm[3]["price_san"], pm[3]["price_golden"],
            pm[3]["golden_approved"], pm[3]["approved_by"]) == (
        482900, 439000, False, None)
    assert "CHƯA duyệt" in pm[3]["golden_note"]
    assert not any("de_xuat" in k or "suggest" in k for k in pm[3])
    assert alerts["tpbvsk_ads_no_xnqc"][:2] == ("S1", "saphraton-20v")
    assert alerts["tpbvsk_ads_no_xnqc"][3]["ads_spend_vnd"] == 250000
    assert alerts["item_unmapped"][:3] == ("S2", None, "99900000001")

    # nạp lại cả 3 → skip, vẫn 4, không nhân đôi
    c = _counts(db)
    for path, kind in ((LISTING, "listing"), (ADS, "ads"), (ORDER, "order")):
        assert _run(db, monkeypatch, path, kind) == (0, 0)
    assert _counts(db) == c and len(_open(db)) == 4

    # export kế tiếp đã sửa → đóng đúng 2
    assert _run(db, monkeypatch, LISTING_FIXED, "listing") == (0, 1)
    closed = dict(db.execute(
        "select kind, closed_at is not null from market_alerts"
        " where status = 'closed'"))
    assert closed == {"alcohol_listed": True, "price_mismatch": True}
    assert set(_open(db)) == {"tpbvsk_ads_no_xnqc", "item_unmapped"}

    # file lỗi giá xuất hiện lại (bytes khác) → mở lại, không thêm dòng
    again = tmp_path / "listing_again.csv"
    again.write_bytes(LISTING.read_bytes() + b"\n")
    assert _run(db, monkeypatch, again, "listing") == (0, 1)
    assert len(_open(db)) == 4
    assert db.execute("select count(*), count(closed_at) from"
                      " market_alerts").fetchone() == (4, 0)
    assert _golden_state(db) == before


def _alert_state(db, channel):
    return {k: (s, n) for k, s, n in db.execute(
        "select kind, status, closed_at is null from market_alerts"
        " where channel = %s", (channel,))}


def test_db_partial_listing_keeps_absent_alerts_open(db, monkeypatch,
                                                     tmp_path, capsys):
    # Xuất listing 1 phần (lọc danh mục / 1 trang) không có dòng rượu →
    # vắng ≠ đã sửa: S1 alcohol_listed (và các cảnh báo vắng khác) GIỮ open.
    assert _run(db, monkeypatch, LISTING, "listing") == (0, 1)
    before = _alert_state(db, "shopee")
    assert set(before) == {"alcohol_listed", "price_mismatch",
                           "item_unmapped"}
    capsys.readouterr()
    savina = LISTING.read_text(encoding="utf-8").splitlines()[:2]
    p = _write(tmp_path, "partial.csv", "\n".join(savina) + "\n")
    assert _run(db, monkeypatch, p, "listing") == (0, 1)
    assert _alert_state(db, "shopee") == before
    assert all(v == ("open", True) for v in before.values())
    out = capsys.readouterr().out
    assert "[warn] 3 cảnh báo shopee/listing không thấy item trong file" \
        in out and "closed=0" in out
    # item CÓ MẶT + hết lỗi → đóng đúng cái đó; vắng vẫn giữ
    fixed = LISTING_FIXED.read_text(encoding="utf-8").splitlines()
    p = _write(tmp_path, "partial2.csv", "\n".join([fixed[0], fixed[3]])
               + "\n")                                      # rượu "Đã ẩn"
    assert _run(db, monkeypatch, p, "listing") == (0, 1)
    st = _alert_state(db, "shopee")
    assert st["alcohol_listed"] == ("closed", False)
    assert st["price_mismatch"] == st["item_unmapped"] == ("open", True)


def test_db_other_channel_never_closes_alerts(db, monkeypatch, tmp_path):
    # Nạp TikTok (cùng item_id với cảnh báo Shopee) không được đóng cảnh báo
    # Shopee — đóng theo (channel, export_kind) cả 2 nửa.
    for path, kind in ((LISTING, "listing"), (ADS, "ads")):
        assert _run(db, monkeypatch, path, kind) == (0, 1)
    shopee = _alert_state(db, "shopee")
    assert len(shopee) == 4
    m = _map()["tiktok"]
    lst = m["listing"]["required"]
    p = _write(tmp_path, "tt_listing.csv", ",".join(
        [lst["item_id"], lst["title"], lst["price"], lst["status"]])
        + "\n27325048614,X,1,Live\n24325987926,Y,1,Live\n"
        "99900000001,Z,1,Live\n")
    assert _run(db, monkeypatch, p, "listing", "tiktok") == (0, 1)
    ads = m["ads"]["required"]
    p = _write(tmp_path, "tt_ads.csv", ",".join(
        [ads["item_id"], ads["title"], ads["ads_spend"]])
        + "\n24825885894,QC,0\n")
    assert _run(db, monkeypatch, p, "ads", "tiktok") == (0, 1)
    assert _alert_state(db, "shopee") == shopee
    assert all(v == ("open", True) for v in shopee.values())


def test_db_shared_item_without_sku_unmapped(db, monkeypatch, tmp_path):
    p = _write(tmp_path, "honey.csv", LISTING_HDR + "\n54916394790,Mật ong,"
               ",745000,1,Đang hoạt động\n")
    assert _run(db, monkeypatch, p, "listing") == (0, 1)
    alerts = _open(db)
    assert set(alerts) == {"item_unmapped"}
    assert alerts["item_unmapped"][3]["candidates"] == [
        "mat-ong-sam-120ml-1hu", "mat-ong-sam-120ml-2hu"]


def test_db_report(db, monkeypatch, capsys):
    _run(db, monkeypatch, LISTING, "listing")
    capsys.readouterr()
    proxy = _TxConn(db)
    monkeypatch.setattr(mc, "_connect", lambda _dsn: proxy)
    assert mc.main(["--report"]) == 0
    out = capsys.readouterr().out
    assert "shopee: không đủ dữ liệu quảng cáo" in out
    _run(db, monkeypatch, ADS, "ads")
    _run(db, monkeypatch, ORDER, "order")
    capsys.readouterr()
    assert mc.main(["--report"]) == 0 and proxy.committed == 0
    out = capsys.readouterr().out
    lines = [ln for ln in out.splitlines() if re.match(r"  \[S[12]\]", ln)]
    assert len(lines) == 4
    sev = [ln[3:5] for ln in lines]
    assert sev == sorted(sev) and sev.count("S1") == 2
    assert "không đủ dữ liệu quảng cáo" not in out
    assert "hủy=1 đơn" in out
    assert not re.search(PII_RE, out)
    hashes = [r[0] for r in db.execute(
        "select order_id_hash from market_rows where order_id_hash is not"
        " null")]
    assert hashes and not any(h in out for h in hashes)


# ---------- v5.3 W53.2: field tùy chọn sale_price (giá sau KM) ----------

LISTING_KM = FIX / "fixture_shopee_listing_km.csv"
KM_HDR = ("Mã sản phẩm,Tên sản phẩm,SKU phân loại,Giá,Giá khuyến mãi,"
          "Kho hàng,Trạng thái")


def test_sale_price_optional_absent_is_none():
    """File cũ KHÔNG có cột KM: cùng số dòng, sale_price None, cảnh báo y
    như trước (find_alerts không đổi ngữ nghĩa theo `price`)."""
    m = _map()
    assert m["shopee"]["listing"]["optional"]["sale_price"] == \
        "Giá khuyến mãi"
    assert m["tiktok"]["listing"]["optional"]["sale_price"] == "Sale Price"
    rows, errs, _ = _read(LISTING)
    assert errs == [] and len(rows) == 5
    assert all(r["sale_price"] is None for r in rows)
    skus = {"savigout-30v": {"category": "tpbvsk", "xnqc_status": "none",
                             "shopee_item_id": "24325987926"}}
    prices = {"savigout-30v": (439000, 1, None)}
    got = mc.find_alerts(rows, "shopee", "listing", skus, prices, [])
    assert {k[0] for k in got} == {"price_mismatch", "item_unmapped"}


def test_sale_price_parsed_vnd():
    rows, errs, _ = _read(LISTING_KM)
    assert errs == [] and len(rows) == 3
    by = {r["item_id"]: r for r in rows}
    assert by["29007947088"]["sale_price"] == 1290000      # "1.290.000"
    assert by["29007947088"]["price"] == 2980000
    assert by["27357883504"]["sale_price"] == 120000
    assert by["24325987926"]["sale_price"] is None          # ô trống


def test_sale_price_bad_number_reports_row_not_value(tmp_path):
    p = _write(tmp_path, "km.csv", KM_HDR + "\n1,a,,100,\"12,5\",1,X\n")
    rows, errs, _ = _read(p)
    assert rows == [] and errs == [
        "dòng 2: field 'sale_price' không phải số nguyên ≥ 0 hợp lệ"]
    assert "12,5" not in " ".join(errs)


def test_db_sale_price_in_raw(db, monkeypatch):
    assert _run(db, monkeypatch, LISTING_KM, "listing") == (0, 1)
    got = dict(db.execute(
        "select item_id, raw->>'sale_price' from market_rows"))
    assert got == {"27357883504": "120000", "29007947088": "1290000",
                   "24325987926": None}
    # Cột riêng không đổi — chỉ nằm trong raw.
    assert db.execute("select count(*) from information_schema.columns"
                      " where column_name = 'sale_price'").fetchone()[0] == 0
