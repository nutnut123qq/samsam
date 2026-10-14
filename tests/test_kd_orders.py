"""v10.1 W101.1–W101.2 — KD-A6 `agents.kd_orders`: đơn sàn → `orders` lõi
(idempotent, 0 PII) + file đối soát doanh thu thực nhận.

DB thật: 1 transaction + schema tạm (docs/schema.sql ×2 + roles.sql ×2) →
ROLLBACK cuối test; code gọi `conn.commit()` → bọc `_TxConn` (commit chỉ
ghi nhận). Đơn/quyết toán là fixture MẪU tự chèn (mã đơn giả "MAU...").
"""

import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import acc_invoice as ai
from agents import kd_orders as ko
from ingest import core_store
from ingest.settlement_csv import order_hash
from pipelines.pii import _PII_RE

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
CANCEL = {"shopee": ["Đã hủy"], "tiktok": ["Cancelled", "Canceled"]}
HONEY, SAPH = "mat-ong-sam-300ml", "saphraton-20v"


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
        schema = f"t_w101o_{uuid.uuid4().hex[:12]}"
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


def _snap(db, channel, rows, ts=None, sha=None):
    """Chèn 1 snapshot order + dòng (dict code, status, title, qty, price,
    sku?) → snapshot id. Mã đơn → hash như market_csv."""
    sid = db.execute(
        "insert into market_snapshots (channel, export_kind, file_name,"
        " file_sha256, row_count, imported_at) values (%s, 'order', 'mau.csv',"
        " %s, %s, coalesce(%s, now())) returning id",
        (channel, sha or uuid.uuid4().hex, len(rows), ts)).fetchone()[0]
    for n, r in enumerate(rows, 2):
        db.execute(
            "insert into market_rows (snapshot_id, row_no, channel,"
            " export_kind, title, price_vnd, status, qty, order_id_hash,"
            " sku_key, raw) values (%s, %s, %s, 'order', %s, %s, %s, %s, %s,"
            " %s, '{}')",
            (sid, n, channel, r["title"], r["price"], r["status"], r["qty"],
             order_hash(channel, r["code"]) if r.get("code") else None,
             r.get("sku")))
    return sid


SHOPEE = [
    {"code": "MAU001", "status": "Hoàn thành", "title": "Mật ong", "qty": 2,
     "price": 150000, "sku": HONEY},
    {"code": "MAU001", "status": "Hoàn thành", "title": "Saphraton",
     "qty": 1, "price": 320000, "sku": SAPH},
    {"code": "MAU002", "status": "Đang giao", "title": "Mật ong", "qty": 1,
     "price": 150000, "sku": HONEY},
    {"code": None, "status": "Hoàn thành", "title": "dòng lỗi", "qty": 1,
     "price": 1},
]
TIKTOK = [{"code": "MAUT01", "status": "Completed", "title": "Honey",
           "qty": 3, "price": 140000, "sku": None}]


def _orders(db):
    return {r[0]: r[1:] for r in db.execute(
        "select id, ts, channel, product_id, qty, total_vnd, status, note,"
        " source from orders order by id")}


# ---------------------------------------------------------------- thuần

def test_build_orders_groups_and_cancel():
    rows = [{"channel": "shopee", "order_id_hash": "a" * 16,
             "status": "Hoàn thành", "qty": 2, "price_vnd": 100,
             "sku_key": "b-sku"},
            {"channel": "shopee", "order_id_hash": "a" * 16,
             "status": "Hoàn thành", "qty": 1, "price_vnd": 50,
             "sku_key": "a-sku"},
            {"channel": "shopee", "order_id_hash": "b" * 16,
             "status": "Đã hủy", "qty": 1, "price_vnd": 70, "sku_key": None},
            {"channel": "shopee", "order_id_hash": None, "status": "x",
             "qty": 1, "price_vnd": 1, "sku_key": None},
            {"channel": "shopee", "order_id_hash": "c" * 16,
             "status": "=cmd\x1b[31m" + "z" * 80, "qty": None,
             "price_vnd": None, "sku_key": None}]
    got = {o["id"]: o for o in ko.build_orders(rows, CANCEL)}
    assert set(got) == {f"shopee:{c * 16}" for c in "abc"}
    a = got["shopee:" + "a" * 16]
    assert (a["qty"], a["total_vnd"], a["note"], a["source"],
            a["product_id"]) == (3, 250, "a-sku,b-sku", "market:shopee", None)
    assert got["shopee:" + "b" * 16]["status"] == "cancelled"
    c = got["shopee:" + "c" * 16]
    assert len(c["status"]) <= 40 and "\x1b" not in c["status"]
    assert (c["qty"], c["total_vnd"], c["note"]) == (0, 0, None)


def test_cli_usage_exit_2_before_connect(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(ko, "connect", lambda: calls.append(1))
    for argv in (["--sync", "--report"], ["--sync", "--recon"], [],
                 ["--recon", "--since", "2026-10-31", "--until",
                  "2026-10-01"],
                 ["--recon", "--since", "31/10/2026", "--until",
                  "2026-11-01"],
                 ["--recon", "--since", "2026-10-01"],
                 ["--dry-run", "--recon", "--since", "2026-10-01",
                  "--until", "2026-10-02"]):
        with pytest.raises(SystemExit) as e:
            ko.main(argv)
        assert e.value.code == 2, argv
    assert calls == []
    capsys.readouterr()


def test_module_no_llm_no_network():
    src = (ROOT / "agents" / "kd_orders.py").read_text(encoding="utf-8")
    assert not re.search(r"llm_gateway|openai|guardrail_llm|requests|httpx"
                         r"|urllib|smtplib", src)


# ---------------------------------------------------------------- DB

def test_db_sync_parity_idempotent_cancel_manual(db, capsys):
    tx = _TxConn(db)
    t0 = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)
    s1 = _snap(db, "shopee", SHOPEE, ts=t0)
    _snap(db, "tiktok", TIKTOK, ts=t0 + timedelta(minutes=5))
    # (a) parity với acc_invoice.fetch_orders trên cùng snapshot
    res = ko.sync(tx)
    assert res == {"inserted": 3, "updated": 0, "unchanged": 0,
                   "protected": 0, "skipped": 1, "snapshots": 2}
    assert tx.committed == 1
    ref = ai.fetch_orders(db, date(2026, 10, 2))
    got = _orders(db)
    assert len(got) == len(ref) == 3
    assert sum(v[4] for v in got.values()) == \
        sum(o["amount_vnd"] for o in ref) == 2 * 150000 + 320000 + 150000 \
        + 3 * 140000
    h1 = order_hash("shopee", "MAU001")
    o1 = got[f"shopee:{h1}"]
    assert (o1[2], o1[3], o1[4], o1[6], o1[7]) == (
        None, 3, 620000, f"{HONEY},{SAPH}", "market:shopee")
    assert o1[0] == t0
    # (b) chạy lại → 0 insert/update, count/sum không đổi
    before = db.execute("select count(*), sum(total_vnd) from orders"
                        ).fetchone()
    res2 = ko.sync(tx)
    assert (res2["inserted"], res2["updated"], res2["unchanged"]) == (0, 0, 3)
    assert db.execute("select count(*), sum(total_vnd) from orders"
                      ).fetchone() == before
    # snapshot sau đổi trạng thái sang hủy → updated=1, ts giữ nguyên
    t1 = t0 + timedelta(days=2)
    rows = [dict(r) for r in SHOPEE[:3]]
    rows[0]["status"] = rows[1]["status"] = "Đã hủy"
    _snap(db, "shopee", rows, ts=t1)
    res3 = ko.sync(tx)
    assert (res3["inserted"], res3["updated"], res3["unchanged"]) == (0, 1, 2)
    o1b = _orders(db)[f"shopee:{h1}"]
    assert o1b[5] == "cancelled" and o1b[0] == t0
    # --snapshot chỉ snapshot đầu → trạng thái quay lại (snapshot chỉ định
    # thắng), dry-run không ghi
    dry = ko.sync(tx, [s1], dry_run=True)
    assert dry["updated"] == 1
    assert _orders(db)[f"shopee:{h1}"][5] == "cancelled"
    # (c) row manual cùng id KHÔNG bị đè
    h2 = order_hash("shopee", "MAU002")
    db.execute("update orders set source = 'manual', status = 'tay',"
               " total_vnd = 1 where id = %s", (f"shopee:{h2}",))
    res4 = ko.sync(tx)
    assert res4["protected"] == 1 and res4["updated"] == 0
    assert _orders(db)[f"shopee:{h2}"][4:6] == (1, "tay")
    # core_store.apply_rows domain orders (source sample) không xóa market:%
    db.execute("insert into products (id, name, source) values"
               " ('p-mau', 'SP mẫu', 'sample')")
    core_store.apply_rows(db, [("orders", "sample", [{
        "id": "mau-o1", "ts": t0, "channel": "web", "product_id": "p-mau",
        "qty": 1, "total_vnd": 10, "status": "new", "note": None,
        "source": "sample"}])])
    assert db.execute("select count(*) from orders where source like"
                      " 'market:%'").fetchone()[0] == 2
    # (d) 0 cột PII + 0 giá trị text khớp _PII_RE
    cols = [r[0] for r in db.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = 'orders'")]
    assert cols and not [c for c in cols if re.search(
        r"name|phone|sdt|address|dia_chi|buyer|email", c)]
    for row in db.execute("select id, channel, status, note, source from"
                          " orders where source like 'market:%'"):
        for v in row:
            assert v is None or not _PII_RE.search(v), v
    # (e) print/log không chứa hash đủ 16 ký tự
    out = capsys.readouterr().out
    assert h1 not in out and h2 not in out


def test_db_cli_sync_job_run_and_no_full_hash(db, monkeypatch, capsys):
    tx = _TxConn(db)
    _snap(db, "shopee", SHOPEE)
    monkeypatch.setattr(ko, "connect", lambda: tx)
    jobs = []
    monkeypatch.setattr("pipelines.job_runs._record",
                        lambda job, s, e, ok, d: jobs.append((job, ok)))
    assert ko.main(["--sync", "--dry-run"]) == 0
    assert db.execute("select count(*) from orders").fetchone()[0] == 0
    assert ko.main(["--sync"]) == 0
    assert db.execute("select count(*) from orders").fetchone()[0] == 2
    assert jobs == [("agents.kd_orders", True)]
    out = capsys.readouterr().out
    for c in ("MAU001", "MAU002"):
        assert order_hash("shopee", c) not in out and c not in out


def _settle(db, channel, code, amount, fees=(0, 0, 0), payout=0,
            settled_on=date(2026, 10, 5), label="khop", imported_at=None):
    sid = db.execute(
        "insert into settlement_rows (file_sha256, file_name, channel,"
        " row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd,"
        " payment_fee_vnd, service_fee_vnd, shipping_fee_vnd, payout_vnd,"
        " settled_on, imported_at) values (%s, 'qt.csv', %s, 2, %s, %s, %s,"
        " %s, %s, 1000, %s, %s, coalesce(%s, now())) returning id",
        (uuid.uuid4().hex + uuid.uuid4().hex, channel,
         order_hash(channel, code), amount, *fees, payout, settled_on,
         imported_at)).fetchone()[0]
    if label:
        db.execute("insert into recon_results (settlement_row_id, label,"
                   " reasons, expected_payout_vnd) values (%s, %s, %s::jsonb,"
                   " 0)",
                   (sid, label, '[]' if label == "khop"
                    else '[{"code": "thuc_nhan"}]'))
    return sid


def test_db_recon_csv_labels_fees_deterministic(db, tmp_path, monkeypatch):
    tx = _TxConn(db)
    t0 = datetime(2026, 10, 2, 3, 0, tzinfo=timezone.utc)
    rows = [{"code": c, "status": "Hoàn thành", "title": "x", "qty": 1,
             "price": 100000, "sku": HONEY} for c in ("MAUK1", "MAUL1",
                                                      "MAUC1")]
    _snap(db, "shopee", rows, ts=t0)
    ko.sync(tx)
    old = datetime(2026, 10, 3, tzinfo=timezone.utc)
    _settle(db, "shopee", "MAUK1", 100000, (500, 300, 200), 98000,
            label="lech", imported_at=old)            # bản cũ bị thay
    _settle(db, "shopee", "MAUK1", 100000, (1000, 2000, 3000), 93000)
    _settle(db, "shopee", "MAUL1", 100000, (1000, 2000, 3000), 90000,
            label="lech")
    _settle(db, "shopee", "MAUX9", 50000, (100, 200, 300), 48000,
            label="thieu_chung_tu")                    # không có đơn
    _settle(db, "shopee", "MAUX8", 50000, settled_on=date(2026, 11, 20),
            label="thieu_chung_tu")                    # ngoài kỳ
    got = ko.recon_rows(db, date(2026, 10, 1), date(2026, 10, 31))
    assert len(got) == 4
    by = {r["order_ref"]: r for r in got}
    k1 = order_hash("shopee", "MAUK1")[:8]
    assert by[k1]["label"] == "khop" and by[k1]["platform_fee_vnd"] == 6000
    assert by[k1]["payout_vnd"] == 93000 and by[k1]["total_vnd"] == 100000
    assert by[order_hash("shopee", "MAUL1")[:8]]["label"] == "lech"
    c1 = by[order_hash("shopee", "MAUC1")[:8]]
    assert c1["label"] == "chua_quyet_toan" and c1["payout_vnd"] is None
    x9 = by[order_hash("shopee", "MAUX9")[:8]]
    assert x9["label"] == "thieu_don" and x9["platform_fee_vnd"] == 600
    assert {r["label"] for r in got} == {"khop", "lech", "chua_quyet_toan",
                                         "thieu_don"}
    # kỳ không chứa ts đơn → chỉ còn thieu_don trong kỳ settled_on
    assert ko.recon_rows(db, date(2026, 10, 3), date(2026, 10, 31)) == \
        [x9]
    p1 = ko.write_csv(got, tmp_path, date(2026, 10, 1), date(2026, 10, 31))
    b1 = p1.read_bytes()
    assert p1.name == "doi-soat-2026-10-01-2026-10-31.csv"
    p2 = ko.write_csv(ko.recon_rows(db, date(2026, 10, 1),
                                    date(2026, 10, 31)),
                      tmp_path, date(2026, 10, 1), date(2026, 10, 31))
    assert p2.read_bytes() == b1                       # tất định
    text = b1.decode("utf-8-sig")
    assert "\r" not in text and b1.startswith(b"\xef\xbb\xbf")
    lines = text.rstrip("\n").split("\n")
    assert lines[0].split(",") == list(ko.CSV_FIELDS)
    assert len(lines) == 1 + 4 + 1                     # 4 dòng + TONG
    tong = lines[-1].split(",")
    assert tong[:2] == ["shopee", "TONG"]
    assert int(tong[ko.CSV_FIELDS.index("platform_fee_vnd")]) == \
        6000 + 6000 + 600
    for c in ("MAUK1", "MAUL1", "MAUC1", "MAUX9"):
        assert order_hash("shopee", c) not in text
    assert not re.search(r"name|phone|sdt|address|dia_chi|buyer|email",
                         lines[0])
    # CLI --recon ghi file vào --out-dir
    monkeypatch.setattr(ko, "connect", lambda: tx)
    out = tmp_path / "cli"
    assert ko.main(["--recon", "--since", "2026-10-01", "--until",
                    "2026-10-31", "--out-dir", str(out)]) == 0
    assert (out / p1.name).read_bytes() == b1


def test_csv_formula_injection_guard():
    rows = [{"channel": "shopee", "order_ref": "abcd1234",
             "status": "=HYPERLINK(1)", "total_vnd": -5,
             **{k: None for k in ko.MONEY_FIELDS[1:]},
             "label": "chua_quyet_toan"}]
    text = ko.render_csv(rows).decode("utf-8-sig")
    assert "'=HYPERLINK" in text and ",-5," in text


def test_db_cancelled_market_order_not_revenue(db, tmp_path):
    """Nghiệm thu v10.1 MINOR: đơn sàn `cancelled` (total_vnd vẫn = Σ giá×SL)
    KHÔNG được cộng vào Đơn hàng/Doanh thu của báo cáo định kỳ."""
    from agents import report as rep
    tx = _TxConn(db)
    t0 = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)
    since, until = t0 - timedelta(days=1), t0 + timedelta(days=7)
    _snap(db, "shopee", SHOPEE[:3], ts=t0)
    ko.sync(tx)
    s = rep.collect_db(db, since, until)["sales"]
    assert (s["count"], s["revenue"]) == (2, 620000 + 150000)
    # đơn thứ 3: chỉ có trạng thái hủy → không đổi số
    _snap(db, "shopee", [{"code": "MAU009", "status": "Đã hủy",
                          "title": "Mật ong", "qty": 5, "price": 150000,
                          "sku": HONEY}], ts=t0 + timedelta(hours=1))
    assert ko.sync(tx)["inserted"] == 1
    s2 = rep.collect_db(db, since, until)["sales"]
    assert (s2["count"], s2["revenue"]) == (s["count"], s["revenue"])
    assert s2["by_status"]["cancelled"] == 1
    assert all(n == 2 for ch, n, _rev in s2["by_channel"] if ch == "shopee")
    assert sum(r for _n, _q, r in s2["top"]) == s["revenue"]
    # đơn đã tính rồi chuyển sang hủy → rời khỏi doanh thu
    rows = [dict(r) for r in SHOPEE[:2]]
    rows[0]["status"] = rows[1]["status"] = "Đã hủy"
    _snap(db, "shopee", rows, ts=t0 + timedelta(hours=2))
    ko.sync(tx)
    d3 = rep.collect_db(db, since, until)
    s3 = d3["sales"]
    assert (s3["count"], s3["revenue"]) == (1, 150000)
    md = rep.render({"period": {"days": 8, "since": since, "until": until},
                     "generated_at": until, "db": d3, "marketing": None,
                     "chat": rep.collect_chat(tmp_path, since, until)})
    assert "không tính vào Đơn hàng/Doanh thu" in md
    assert "ngày nạp file" in md
