"""v15.5 p11 — `ingest.core_store` nạp lại `products` GIỮ liên kết đơn thật.

P11.1: nạp lại (1 lần + lặp) không làm `orders.product_id` của đơn THẬT
       thành null, không sinh `order_history`, id/created_at sản phẩm giữ.
P11.2: sản phẩm đổi / biến mất / id thuộc nguồn khác → đánh dấu
       (`retired_at`, `product_sync_log`) + báo, không xóa liên kết.
P11.3: nguồn thiếu / rỗng / `{}` / hỏng / trùng id → exit 1, không kết nối
       DB, FK chịu tác động (orders/claims/assets) giữ nguyên.

DB thật: 1 transaction + schema tạm (schema.sql ×2 + roles.sql ×2) →
ROLLBACK cuối test. Dữ liệu là fixture MẪU tự chèn (mã đơn giả "MAU...").
"""

import json
import os
import uuid
from pathlib import Path

import psycopg
import pytest

from ingest import core_store as cs

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC = "products.jsonl"


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
        schema = f"t_v15p11_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _prod(pid, name, price=100000, url=None, images=()):
    return {"id": pid, "name": name, "price_vnd": price,
            "description": f"mô tả {name}",
            "url": url or f"http://x/vi/shops/{pid}.html",
            "images": list(images)}


P1 = _prod("nv-p1", "Sâm mẫu 1", images=["http://x/1.png"])
P2 = _prod("nv-p2", "Sâm mẫu 2")
WL = {"sku-p1": {"approved_claims": ["hỗ trợ bồi bổ"],
                 "source": "http://x/vi/shops/nv-p1.html — trang SP"}}


def _write(d: Path, prods, wl=WL):
    d.mkdir(parents=True, exist_ok=True)
    (d / "products.jsonl").write_text(
        "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in prods),
        encoding="utf-8")
    (d / "claims_whitelist.json").write_text(
        json.dumps(wl, ensure_ascii=False), encoding="utf-8")
    return d


def _load(db, d: Path):
    return cs.apply_rows(db, cs.collect_rows(d))


def _real_order(db, oid="shopee:MAU001", pid="nv-p1"):
    db.execute("insert into orders (id, ts, channel, product_id, qty,"
               " total_vnd, status, source) values (%s, now(), 'shopee',"
               " %s, 1, 100000, 'done', 'market:shopee')", (oid, pid))


def _pid_of(db, oid="shopee:MAU001"):
    return db.execute("select product_id from orders where id = %s",
                      (oid,)).fetchone()[0]


def _hist(db):
    return db.execute("select count(*) from order_history").fetchone()[0]


def _log(db, kind=None):
    sql = "select kind, product_id, detail from product_sync_log"
    if kind:
        return db.execute(sql + " where kind = %s order by id",
                          (kind,)).fetchall()
    return db.execute(sql + " order by id").fetchall()


# ---------------- P11.1 ----------------

def test_p11_1_reload_keeps_real_order_link_and_history(db, tmp_path):
    d = _write(tmp_path / "data", [P1, P2])
    _load(db, d)
    _real_order(db)
    created = db.execute("select created_at from products where id ="
                         " 'nv-p1'").fetchone()[0]
    for _ in range(3):                       # nạp lại 1 lần + lặp lại
        _load(db, d)
        assert _pid_of(db) == "nv-p1"
        assert _hist(db) == 0
    row = db.execute("select created_at, retired_at, source from products"
                     " where id = 'nv-p1'").fetchone()
    assert row == (created, None, SRC)
    # Nạp lại y nguyên → không sự kiện nào, claim + asset vẫn link.
    assert _log(db) == []
    assert db.execute("select product_id from claims_approved"
                      " where sku_key = 'sku-p1'").fetchone() == ("nv-p1",)
    assert db.execute("select product_id from assets where id ="
                      " 'nv-p1#img0'").fetchone() == ("nv-p1",)


def test_p11_1_manual_children_keep_link(db, tmp_path):
    """Row nhập tay (claim/asset 'manual') trỏ sản phẩm do loader quản —
    edge cũ 'mất link sau mỗi reload' không còn."""
    d = _write(tmp_path / "data", [P1, P2])
    _load(db, d)
    db.execute("insert into claims_approved (sku_key, product_id, claim,"
               " source) values ('sku-tay', 'nv-p2', 'claim tay', 'manual')")
    db.execute("insert into assets (id, kind, product_id, source) values"
               " ('tay-1', 'image', 'nv-p2', 'manual')")
    _load(db, d)
    assert db.execute("select product_id from claims_approved where"
                      " source = 'manual'").fetchone() == ("nv-p2",)
    assert db.execute("select product_id from assets where id ="
                      " 'tay-1'").fetchone() == ("nv-p2",)


# ---------------- P11.2 ----------------

def test_p11_2_changed_product_updates_in_place_and_logs(db, tmp_path):
    d = _write(tmp_path / "data", [P1, P2])
    _load(db, d)
    _real_order(db)
    _write(d, [{**P1, "name": "Sâm mẫu 1 (mới)", "price_vnd": 120000}, P2])
    counts = _load(db, d)
    assert _pid_of(db) == "nv-p1" and _hist(db) == 0
    assert db.execute("select name, price_vnd from products where id ="
                      " 'nv-p1'").fetchone() == ("Sâm mẫu 1 (mới)", 120000)
    ev = _log(db, "changed")
    assert len(ev) == 1 and ev[0][1] == "nv-p1"
    assert ev[0][2] == {"name": {"cu": "Sâm mẫu 1", "moi": "Sâm mẫu 1 (mới)"},
                        "price_vnd": {"cu": 100000, "moi": 120000}}
    assert [e[0] for e in counts["product_events"]] == ["changed"]
    _load(db, d)                                # lặp: không sự kiện mới
    assert len(_log(db)) == 1


def test_p11_2_vanished_product_retired_not_deleted(db, tmp_path):
    d = _write(tmp_path / "data", [P1, P2])
    _load(db, d)
    _real_order(db)
    db.execute("insert into assets (id, kind, product_id, source) values"
               " ('tay-1', 'image', 'nv-p1', 'manual')")
    # P1 biến mất; id mới cùng TÊN xuất hiện (đổi mã?) — chỉ là ứng viên,
    # KHÔNG tự chuyển liên kết đơn/claim.
    p1b = {**P1, "id": "wc-p1-moi", "url": "http://x/en/product/sam-1/",
           "images": []}
    _write(d, [P2, p1b])
    counts = _load(db, d)
    assert _pid_of(db) == "nv-p1" and _hist(db) == 0
    assert db.execute("select retired_at is not null from products"
                      " where id = 'nv-p1'").fetchone() == (True,)
    assert db.execute("select product_id from assets where id ="
                      " 'tay-1'").fetchone() == ("nv-p1",)
    # claim trỏ trang của P1 (đã retired) vẫn link về id cũ.
    assert db.execute("select product_id from claims_approved where"
                      " sku_key = 'sku-p1'").fetchone() == ("nv-p1",)
    ev = _log(db, "retired")
    assert ev == [("retired", "nv-p1", {"don_that": 1,
                                        "ung_vien_thay_the": ["wc-p1-moi"]})]
    assert ("retired", "nv-p1") in [(k, p) for k, p, _ in
                                     counts["product_events"]]
    _load(db, d)                                # lặp: không retired lần 2
    assert len(_log(db, "retired")) == 1
    # golden chỉ thấy sản phẩm còn niêm yết.
    from ingest import golden_store
    golden_store.apply_discrepancies(db)
    assert not db.execute("select 1 from golden_discrepancies where"
                          " product_id = 'nv-p1'").fetchall()
    # xuất hiện lại → bỏ retired_at + 'reactivated'
    _write(d, [P1, P2, p1b])
    _load(db, d)
    assert db.execute("select retired_at from products where id ="
                      " 'nv-p1'").fetchone() == (None,)
    assert [p for _, p, _ in _log(db, "reactivated")] == ["nv-p1"]
    assert _pid_of(db) == "nv-p1" and _hist(db) == 0


def test_p11_2_id_owned_by_other_source_not_overwritten(db, tmp_path):
    db.execute("insert into products (id, name, price_vnd, source) values"
               " ('nv-p2', 'SP nhập tay', 5, 'manual')")
    _real_order(db, pid="nv-p2")
    d = _write(tmp_path / "data", [P1, P2])
    for _ in range(2):
        _load(db, d)                            # code cũ: UniqueViolation
    assert db.execute("select name, price_vnd, source, retired_at from"
                      " products where id = 'nv-p2'").fetchone() == \
        ("SP nhập tay", 5, "manual", None)
    assert _pid_of(db) == "nv-p2" and _hist(db) == 0
    ev = _log(db, "ambiguous")                  # ghi 1 lần dù nạp 2 lần
    assert ev == [("ambiguous", "nv-p2", {"ly_do": "id_thuoc_nguon_khac",
                                          "nguon_hien_tai": "manual"})]


def test_p11_2_sync_log_append_only(db, tmp_path):
    d = _write(tmp_path / "data", [P1])
    _load(db, d)
    _write(d, [P2])
    _load(db, d)
    assert _log(db, "retired")
    for sql in ("delete from product_sync_log",
                "update product_sync_log set kind = 'changed'",
                "truncate product_sync_log"):
        with pytest.raises(psycopg.Error) as ei, db.transaction():
            db.execute(sql)
        assert "append-only" in str(ei.value)


# ---------------- P11.3 ----------------

BAD_PRODUCTS = {
    "missing": None,
    "empty": "",
    "doc_only": '{"_doc": "chỉ comment"}\n',
    "brace": "{}\n",
    "corrupt": '{"id": "nv-p1", "name": "cắt cụt',
    "not_object": "[1, 2]\n",
    "no_name": '{"id": "nv-p1"}\n',
    "dup_id": (json.dumps(P1) + "\n" + json.dumps({**P1, "name": "khác"})
               + "\n"),
}


def _bad_dir(tmp_path, case):
    d = _write(tmp_path / "bad", [P1, P2])
    body = BAD_PRODUCTS[case]
    if body is None:
        (d / "products.jsonl").unlink()
    else:
        (d / "products.jsonl").write_text(body, encoding="utf-8")
    return d


def _run_main(monkeypatch, d):
    """main() với DATA_DIR giả; kết nối DB = lỗi test (phải không gọi)."""
    from pipelines import auth
    calls = []

    def _no_connect(*a, **kw):
        calls.append(1)
        raise AssertionError("không được kết nối DB khi nguồn hỏng")

    monkeypatch.setattr(auth, "bind_service", lambda *a, **kw: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:9/x")
    monkeypatch.setattr(cs, "DATA_DIR", d)
    monkeypatch.setattr(cs.psycopg, "connect", _no_connect)
    rc = cs.main()
    return rc, calls


OTHER_CORRUPT = [
    ("claims_whitelist.json", "{hỏng"),
    ("claims_whitelist.json", "[1]"),
    ("sample_orders.jsonl", "{}\n"),
    ("sample_plots.jsonl", '{"id": "KV"\n'),
    ("news.jsonl", "{}\n"),
]


def _rejected(d):
    """Tên lỗi collect_rows ném (None = nhận file). Không tham chiếu
    `cs.SourceError` trực tiếp để code cũ fail đúng chỗ (nhận / lỗi thô)."""
    try:
        cs.collect_rows(d)
    except Exception as e:  # noqa: BLE001
        return type(e).__name__
    return None


@pytest.mark.parametrize("case", sorted(BAD_PRODUCTS))
def test_p11_3_bad_products_source_raises(tmp_path, case):
    """collect_rows (trước mọi kết nối DB) từ chối nguồn products hỏng —
    code cũ: thiếu/rỗng → bỏ domain products nhưng vẫn trả claims (link
    null), `{}`/JSON hỏng → KeyError/JSONDecodeError thô."""
    assert _rejected(_bad_dir(tmp_path, case)) == "SourceError"


@pytest.mark.parametrize("fname,body", OTHER_CORRUPT)
def test_p11_3_other_corrupt_source_raises(tmp_path, fname, body):
    d = _write(tmp_path / "bad", [P1, P2])
    (d / fname).write_text(body, encoding="utf-8")
    assert _rejected(d) == "SourceError"


@pytest.mark.parametrize("case", sorted(BAD_PRODUCTS)
                         + [f"other{i}" for i in range(len(OTHER_CORRUPT))])
def test_p11_3_main_exit_1_no_db(monkeypatch, tmp_path, case, capsys):
    if case.startswith("other"):
        fname, body = OTHER_CORRUPT[int(case[5:])]
        d = _write(tmp_path / "bad", [P1, P2])
        (d / fname).write_text(body, encoding="utf-8")
    else:
        d = _bad_dir(tmp_path, case)
    rc, calls = _run_main(monkeypatch, d)
    assert rc == 1 and calls == []
    assert "[err] file nguồn hỏng" in capsys.readouterr().out


def test_p11_3_bad_source_keeps_fk_links(db, tmp_path, monkeypatch):
    """Sau lần nạp tốt: nguồn hỏng → không ghi gì; orders/claims/assets
    (FK tới products) giữ nguyên từng giá trị. Đường loader = collect_rows
    → (chỉ khi hợp lệ) apply_rows; code cũ thiếu products vẫn nạp claims
    với product_id null."""
    good = _write(tmp_path / "data", [P1, P2])
    _load(db, good)
    _real_order(db)

    def snap():
        return [db.execute(q).fetchall() for q in (
            "select id, product_id from orders order by id",
            "select sku_key, product_id from claims_approved order by 1",
            "select id, product_id from assets order by id",
            "select id, name from products order by id")]

    before = snap()
    assert before[1] == [("sku-p1", "nv-p1")]
    for case in sorted(BAD_PRODUCTS):
        d = _bad_dir(tmp_path / case, case)
        try:
            domains = cs.collect_rows(d)
        except (ValueError, KeyError):  # SourceError; code cũ: lỗi thô
            domains = None
        if domains:
            cs.apply_rows(db, domains)
        assert snap() == before, case
    assert _hist(db) == 0 and _log(db) == []
