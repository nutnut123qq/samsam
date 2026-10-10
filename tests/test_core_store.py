"""v1.8-core-db (W1.x) — transforms thuần của `ingest.core_store` + guard
schema drift + sample files hợp lệ. Không cần DB thật: `apply_rows` chạy
trên fake conn ghi SQL để chứng minh delete-by-source trước insert và
không đụng bảng `chunks`."""

import json
import re
from pathlib import Path

from ingest import core_store as cs

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

PROD = {"id": "nv-saphraton-48", "name": "SAPHRATON", "price_vnd": 1000000,
        "description": "...", "url": "http://x/vi/shops/saphraton-48.html",
        "images": ["http://x/a.png", "http://x/b.png"]}


def test_iter_jsonl_skips_doc_and_blank(tmp_path):
    p = tmp_path / "f.jsonl"
    p.write_text('{"_doc": "comment"}\n{"id": "a"}\n\n{"id": "b"}\n',
                 encoding="utf-8")
    assert [r["id"] for r in cs.iter_jsonl(p)] == ["a", "b"]


def test_product_row_maps_fields_and_lang():
    row = cs.product_row(PROD)
    assert row["id"] == "nv-saphraton-48" and row["price_vnd"] == 1000000
    assert row["lang"] == "vi" and row["source"] == "products.jsonl"
    en = cs.product_row({**PROD, "id": "wc-1",
                         "url": "http://x/en/product/a/"})
    assert en["lang"] == "en"
    # Giá null giữ null — RAG không được bịa giá (invariant repo).
    no_price = cs.product_row({**PROD, "price_vnd": None})
    assert no_price["price_vnd"] is None


def test_image_asset_rows_and_article_row():
    imgs = cs.image_asset_rows(PROD)
    assert [a["id"] for a in imgs] == ["nv-saphraton-48#img0",
                                     "nv-saphraton-48#img1"]
    assert all(a["kind"] == "image" and a["product_id"] == PROD["id"]
               for a in imgs)
    art = cs.article_asset_row(
        {"id": "nv-x", "title": "Bài", "url": "http://x/a"}, "news.jsonl")
    assert art["kind"] == "article" and art["source"] == "news.jsonl"
    assert cs.image_asset_rows({**PROD, "images": None}) == []


def test_claim_rows_approved_and_empty():
    seg = {"saphraton-48": "nv-saphraton-48"}
    entry = {"approved_claims": ["hỗ trợ bồi bổ", "giảm mệt mỏi"],
             "source": "http://samsam.net.vn/vi/shops/saphraton-48.html — "
                       "CÔNG DỤNG trên trang SP"}
    rows = cs.claim_rows("saphraton", entry, seg)
    assert len(rows) == 2
    assert all(r["sku_key"] == "saphraton"
               and r["product_id"] == "nv-saphraton-48" for r in rows)
    assert rows[0]["source_ref"] == entry["source"]

    # SKU chưa có công bố → 1 row claim=None + note, vẫn audit được.
    empty = cs.claim_rows("ruou-sam-no5", {"approved_claims": [],
                                         "source": "Chưa có công bố"}, seg)
    assert len(empty) == 1 and empty[0]["claim"] is None
    assert "Chưa có công bố" in empty[0]["note"]

    # URL không khớp product nào (vd trỏ bài news) → product_id None.
    miss = cs.claim_rows("savitim", {"approved_claims": ["x"],
                                   "source": "http://x/vi/news/abc-1.html"},
                         seg)
    assert miss[0]["product_id"] is None


def test_url_segment():
    assert cs.url_segment("http://x/a/b/c-12.html") == "c-12"
    assert cs.url_segment("http://x/a/b/") == "b"


def test_collect_rows_real_data():
    """collect_rows trên data/ thật: đủ domain, counts theo gate board."""
    domains = {t: (s, r) for t, s, r in cs.collect_rows(DATA)}
    assert set(domains) == set(cs.DOMAIN_ORDER)
    # Count gắn data crawl hiện tại: products `>=` vì crawl có thể thêm
    # record (gate board ghi số tại thời điểm viết); còn lại `==` vì
    # sample/whitelist là repo-controlled.
    assert len(domains["products"][1]) >= 27
    skus = {r["sku_key"] for r in domains["claims_approved"][1]}
    assert len(skus) == 10
    assert len(domains["assets"][1]) >= 140
    assert len(domains["plots"][1]) == 3
    assert len(domains["plot_logs"][1]) >= 5
    assert len(domains["orders"][1]) >= 5


def test_collect_rows_missing_file_skips_domain(tmp_path):
    """MAJOR cold-check v1.8: file nguồn thiếu → domain KHÔNG được trả.
    Nếu vẫn append source cố định + rows=[] thì apply_rows chạy
    `delete where source=...` rồi insert 0 → xoá trắng bảng đang có
    (claims_approved là nguồn sự thật guardrail — rủi ro cao)."""
    tables = {t for t, _, _ in cs.collect_rows(tmp_path)}
    assert not tables  # thư mục trống → không domain nào


def test_collect_rows_empty_file_skips_domain(tmp_path):
    """MAJOR cold-check v1.8 đợt 2: file TỒN TẠI nhưng 0 record → cũng
    skip domain (coi như thiếu). Nếu vẫn append rows=[] thì apply_rows
    chạy `delete where source=...` rồi insert 0 → xoá trắng bảng; file
    bị cắt cụt/crawl lỗi sẽ quét sạch `claims_approved` (nguồn sự thật
    guardrail). `_doc` không tính record."""
    (tmp_path / "products.jsonl").write_text("", encoding="utf-8")
    (tmp_path / "claims_whitelist.json").write_text("{}",
                                                  encoding="utf-8")
    (tmp_path / "sample_plots.jsonl").write_text(
        '{"_doc": "chỉ comment"}\n', encoding="utf-8")
    tables = {t for t, _, _ in cs.collect_rows(tmp_path)}
    assert not tables


def test_collect_rows_partial_files(tmp_path):
    """Có products.jsonl mà thiếu whitelist/sample → chỉ products+assets
    được trả; domain thiếu-file vắng khỏi kết quả."""
    (tmp_path / "products.jsonl").write_text(
        json.dumps({"id": "p1", "name": "X", "price_vnd": 1,
                    "url": "http://x/a.html", "images": ["http://x/i.png"]})
        + "\n", encoding="utf-8")
    tables = {t for t, _, _ in cs.collect_rows(tmp_path)}
    assert tables == {"products", "assets"}
    assert "claims_approved" not in tables


def test_apply_rows_no_domains_no_ops():
    """collect_rows trả rỗng (thiếu mọi file) → apply không chạy
    statement nào, đặc biệt không delete."""
    conn = _FakeConn()
    cs.apply_rows(conn, [])
    assert conn.ops == []


def test_sample_files_have_required_fields():
    for fname, keys in (
            ("sample_plots.jsonl", {"id", "location", "tree_count"}),
            ("sample_plot_logs.jsonl", {"plot_id", "ts", "activity"}),
            ("sample_orders.jsonl", {"id", "ts", "channel"})):
        recs = list(cs.iter_jsonl(DATA / fname))
        assert recs, f"{fname} rỗng"
        for r in recs:
            assert keys <= r.keys(), f"{fname} thiếu field {keys - r.keys()}"
    # plot_logs.plot_id phải trỏ plots đang có trong file mẫu (FK).
    plot_ids = {r["id"] for r in cs.iter_jsonl(DATA / "sample_plots.jsonl")}
    for r in cs.iter_jsonl(DATA / "sample_plot_logs.jsonl"):
        assert r["plot_id"] in plot_ids


class _FakeCur:
    def __init__(self, ops):
        self._ops = ops

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def executemany(self, sql, rows):
        self._ops.append(("insert", sql, len(list(rows))))


class _FakeConn:
    """Ghi mọi statement để assert thứ tự delete→insert + không đụng
    `chunks`."""

    def __init__(self):
        self.ops = []

    def execute(self, sql, params=None):
        self.ops.append(("exec", sql))

    def cursor(self):
        return _FakeCur(self.ops)


def test_apply_rows_delete_by_source_then_insert():
    conn = _FakeConn()
    domains = [("products", "products.jsonl",
                [dict.fromkeys(cs.COLS["products"], "x")]),
               ("claims_approved", "claims_whitelist.json",
                [dict.fromkeys(cs.COLS["claims_approved"], "x")]),
               ("plots", "sample:plots.jsonl",
                [dict.fromkeys(cs.COLS["plots"], "x")]),
               ("plot_logs", "sample:plot_logs.jsonl",
                [dict.fromkeys(cs.COLS["plot_logs"], "x")]),
               ("orders", "sample:orders.jsonl",
                [dict.fromkeys(cs.COLS["orders"], "x")]),
               ("assets", "multi",
                [dict.fromkeys(cs.COLS["assets"], "x")])]
    cs.apply_rows(conn, domains)

    ops = conn.ops
    # Pha 1: đúng 6 delete, con trước cha sau (assets/orders/plot_logs/
    # claims trước, products sau cùng trong delete để FK không cắt link).
    deletes = [sql for k, sql in ops[:6] if k == "exec"]
    assert len(deletes) == 6
    assert deletes[-1].startswith("delete from products")
    assert deletes[0].startswith("delete from assets")
    assert all("where source" in d for d in deletes)
    # Pha 2: insert theo DOMAIN_ORDER, products trước claims (FK).
    inserts = [sql for k, sql, _ in ops[6:] if k == "insert"]
    assert len(inserts) == 6
    assert inserts[0].startswith("insert into products")
    assert inserts[1].startswith("insert into claims_approved")
    # Tuyệt đối không đụng bảng chunks của RAG.
    assert all("chunks" not in sql for _, sql, *_ in ops)


def test_schema_sql_has_six_core_tables():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    for t in cs.DOMAIN_ORDER:
        assert re.search(rf"create table if not exists {t}\b", sql), t
    assert re.search(r"create table if not exists chunks\b", sql)
