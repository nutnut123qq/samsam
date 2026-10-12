"""v5.3 W53.3/W53.6 — KD-A4 `agents/kd_listing.py` (đồng bộ catalog/listing).

Phần thuần (parse nháp, chuẩn hóa tiêu đề, `diff_catalog`, payload) không
DB. Phần DB: 1 transaction trên `DATABASE_URL`, schema tạm + docs/schema.sql
+ docs/roles.sql → ROLLBACK cuối test (precedent
`tests/test_sales_director.py::db`); code gọi `conn.commit()` → bọc
`TxConn` (commit chỉ ghi nhận). Dữ liệu golden/listing/nháp là GIẢ LẬP
(SKU `sam-*`/`ruou-x` chỉ có trong schema tạm). Không assert wall-clock.
`kd_db`/`seed`/`TxConn` dùng lại ở `tests/test_kd_price.py`.
"""

import os
import re
import subprocess
import sys
import time
import typing
import uuid
from datetime import date
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

from agents import kd_listing as kl
from ingest import market_csv as mc
from pipelines import approval_queue as aq
from pipelines import director, guardrail

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
CFG = director.load_config("sales")
MAPPING, _ = mc.load_mapping()
TODAY = date(2026, 10, 12)
AH = "app_human"


# ---------------------------------------------------------------- DB fixture

def kd_db():
    """Generator schema tạm (dùng lại ở test_kd_price — precedent da_db)."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w53_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


@pytest.fixture
def db():
    yield from kd_db()


class TxConn:
    """commit/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

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


def one(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]


# SKU giả lập: (key, category, xnqc, self_decl, allowed)
SKUS = [("sam-a", "tpbvsk", "approved", None, ["shopee", "tiktok"]),
        ("sam-b", "food", "none", True, ["shopee"]),
        ("sam-c", "tpbvsk", "none", None, ["shopee"]),
        ("sam-e", "tpbvsk", "approved", None, ["shopee"]),
        ("sam-f", "tpbvsk", "approved", None, ["tiktok"]),
        ("sam-g", "food", "none", True, ["shopee"]),
        ("ruou-x", "alcohol", "none", None, ["shopee"])]
# (sku, kênh, kind, giá, duyệt?)
PRICES = [("sam-a", "shopee", "list", 200000, True),
          ("sam-a", "shopee", "floor", 150000, True),
          ("sam-a", "tiktok", "list", 200000, True),
          ("sam-a", "tiktok", "floor", 150000, True),
          ("sam-b", "shopee", "list", 100000, True),
          ("sam-b", "shopee", "floor", 80000, True),
          ("sam-c", "shopee", "list", 300000, True),
          ("sam-c", "shopee", "floor", 250000, False),
          ("sam-g", "shopee", "list", 200000, True),
          ("sam-g", "shopee", "floor", 100000, True),
          ("ruou-x", "shopee", "list", 500000, True),
          ("ruou-x", "shopee", "floor", 400000, True)]
RUOU_TITLE = "Rượu sâm X chai 500ml (GIẢ LẬP)"
# (item_id, sku_key, title, price, status, sale_price)
LISTING = [("1001", "sam-a", "  sâm a   HỘP 30 viên ", 210000, "Đang hoạt động",
            140000),
           ("1002", "sam-b", "Mật ong B khuyến mãi", 90000, "Đang hoạt động",
            None),
           ("1003", "sam-c", "Sâm C", 315001, "Đang hoạt động", None),
           ("1004", "ruou-x", RUOU_TITLE, 500000, "Đang hoạt động", None),
           ("1005", "sam-e", "Sâm E", 100000, "Đã ẩn", None),
           ("1006", "sam-f", "Sâm F", 100000, None, None),
           ("1007", None, "Hàng lạ", 5000, "Đang hoạt động", None),
           ("1008", "sam-g", "Sâm G", 200000, "Đang hoạt động", 110000)]


def seed(conn, *, alcohol_alert=True, mismatch_alert=True):
    """Golden + snapshot listing shopee + nháp đã duyệt + cảnh báo v3.3."""
    for k, cat, x, sd, allowed in SKUS:
        conn.execute(
            "insert into sku_master (sku_key, name, category, xnqc_status,"
            " self_declaration_ok, allowed_channels, source) values"
            " (%s, %s, %s, %s, %s, %s, 'manual')",
            (k, f"Tên {k}", cat, x, sd, allowed))
    for k, ch, kind, p, ok in PRICES:
        pid = one(conn, "insert into price_list (sku_key, channel, kind,"
                  " price_vnd, valid_from) values (%s, %s, %s, %s,"
                  " '2026-01-01') returning id", (k, ch, kind, p))
        if ok:
            conn.execute("update price_list set approved_by = 'GĐ (test)',"
                         " approved_at = now() where id = %s", (pid,))
    sid = one(conn, "insert into market_snapshots (channel, export_kind,"
              " file_name, file_sha256, row_count) values ('shopee',"
              " 'listing', 'l.csv', %s, %s) returning id",
              (uuid.uuid4().hex, len(LISTING)))
    for n, (iid, sku, title, price, st, sale) in enumerate(LISTING, 2):
        raw = {"item_id": iid, "price": price, "sale_price": sale}
        conn.execute(
            "insert into market_rows (snapshot_id, row_no, channel,"
            " export_kind, item_id, sku_key, title, price_vnd, status, raw)"
            " values (%s, %s, 'shopee', 'listing', %s, %s, %s, %s, %s, %s)",
            (sid, n, iid, sku, title, price, st, Jsonb(raw)))
    for i, (sku, text) in enumerate([
            ("sam-a", ("Sâm A hộp 30 viên\n\nThông tin sản phẩm:\n"
                       "Giá: 200.000 đ\nHạn sử dụng: Xem trên bao bì")),
            ("sam-b", "Mật ong B\nGiá: 90.000 đ")]):
        conn.execute(
            "insert into content_drafts (brief, channel, text, guardrail,"
            " status, reviewer, reviewed_at, source, content_type, sku,"
            " prompt_version) values ('listing', 'shopee', %s, '{}',"
            " 'approved', 'Pháp chế (test)', now(), 'cli', 'listing', %s,"
            " %s)", (text, sku, f"v{i}"))
    ids = {}
    if alcohol_alert:
        ids["alcohol"] = one(
            conn, "insert into market_alerts (kind, severity, channel,"
            " export_kind, item_id, sku_key, detail) values"
            " ('alcohol_listed', 'S1', 'shopee', 'listing', '1004',"
            " 'ruou-x', '{}') returning id")
    if mismatch_alert:
        ids["mismatch"] = one(
            conn, "insert into market_alerts (kind, severity, channel,"
            " export_kind, item_id, sku_key, detail) values"
            " ('price_mismatch', 'S2', 'shopee', 'listing', '1003',"
            " 'sam-c', '{}') returning id")
    return ids


class FakeRun:
    calls: typing.ClassVar[list] = []

    def __init__(self, name):
        FakeRun.calls.append(name)
        self.d = {"ok": True}

    def __enter__(self):
        return self.d

    def __exit__(self, *a):
        return False


@pytest.fixture
def cli(monkeypatch):
    """connect đếm lời gọi (None = DB down) + job_run giả (KHÔNG ghi
    job_runs DB thật)."""
    FakeRun.calls = []
    calls = {"connect": 0}

    def no_db():
        calls["connect"] += 1

    monkeypatch.setattr(kl, "connect", no_db)
    monkeypatch.setattr(kl, "job_run", FakeRun)
    return calls


# ---------------------------------------------------------------- thuần

def test_parse_draft_and_norm_title():
    assert kl.parse_draft("Tên A\nQuy cách: x\nGiá: 1.290.000 đ\n") == (
        "Tên A", 1290000)
    assert kl.parse_draft("Tên B\r\nGiá: Liên hệ") == ("Tên B", None)
    assert kl.parse_draft("Tên C") == ("Tên C", None)
    assert kl.parse_draft(None) == (None, None)
    a = "Sa\u0302m A  hộp\t30 viên"            # NFD + khoảng trắng lạ
    assert kl.norm_title(a) == kl.norm_title("SÂM A HỘP 30 VIÊN")
    assert kl.norm_title("Sâm A") != kl.norm_title("Sâm B")


def test_ref_code_blocks_free_text():
    assert kl.ref_code("27357883504") == "27357883504"
    assert kl.ref_code("Rượu sâm") == "(mã lạ)"
    assert kl.ref_code("a" * 41) == "(mã lạ)"
    assert kl.ref_code(None) == "(mã lạ)"


def _pure_inputs():
    skus = {k: {"category": c} for k, c, *_ in SKUS}
    rd = {("sam-a", "shopee"): "QC_DAY_DU", ("sam-b", "shopee"): "TP_THUONG",
          ("sam-c", "shopee"): "MO_TA", ("sam-e", "shopee"): "QC_DAY_DU",
          ("sam-f", "shopee"): "CAM", ("sam-g", "shopee"): "TP_THUONG",
          ("ruou-x", "shopee"): "CAM", ("sam-a", "tiktok"): "QC_DAY_DU"}
    rows = [{"channel": "shopee", "item_id": i, "seller_sku": None,
             "sku_key": s, "title": t, "price_vnd": p, "status": st,
             "sale_price": sp} for i, s, t, p, st, sp in LISTING
            if st != "Đã ẩn"]
    drafts = {("sam-a", "shopee"): {"id": 1, "title": "Sâm A hộp 30 viên",
                                    "price": 200000},
              ("sam-b", "shopee"): {"id": 2, "title": "Mật ong B",
                                    "price": 90000}}
    prices = {(k, ch): p for k, ch, kind, p, _ in PRICES if kind == "list"}
    return rows, drafts, skus, rd, prices


def test_diff_catalog_all_six_kinds_and_negatives():
    rows, drafts, skus, rd, prices = _pure_inputs()
    res = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    got = sorted((f["kind"], f.get("item_id") or f["sku_key"])
                 for f in res["findings"])
    assert got == sorted([
        ("unready_listed", "1004"), ("unready_listed", "1006"),
        ("price_drift", "1001"),            # 210000 ≠ bản duyệt 200000
        ("title_drift", "1002"),            # khác chữ thật
        ("draft_stale", "sam-b"),           # bản duyệt 90000 ≠ golden 100000
        ("no_approved_draft", "1003"), ("no_approved_draft", "1008"),
        ("missing_listing", "sam-e")])      # 1005 'Đã ẩn' → không đang bán
    # sam-a: tiêu đề chỉ khác hoa/thường/khoảng trắng → KHÔNG title_drift.
    assert not [f for f in res["findings"]
                if f["kind"] == "title_drift" and f["item_id"] == "1001"]
    # tiktok chưa có snapshot → 0 missing_listing kênh tiktok.
    assert res["no_snapshot"] == ["tiktok"]
    assert not [f for f in res["findings"] if f["channel"] == "tiktok"]
    assert res["unmapped"] == 1
    sev = [f["severity"] for f in res["findings"]]
    assert sev == sorted(sev) and sev.count("S1") == 2
    # Tất định: chạy lại cùng input → cùng object_id.
    again = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    assert [f["object_id"] for f in again["findings"]] == [
        f["object_id"] for f in res["findings"]]


def test_payload_templates_guardrail_ok_and_no_alcohol_sku():
    rows, drafts, skus, rd, prices = _pure_inputs()
    res = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    items = kl.to_items(res["findings"], CFG)
    assert len(items) == len(res["findings"])
    for it in items:
        assert guardrail.check(it["payload"])["ok"] is True, it
        assert re.fullmatch(r"a4:[a-z_]+:shopee:[A-Za-z0-9_.()-]+:[0-9a-f]{12}"
                            r"|a4:[a-z_]+:shopee:\(mã lạ\):[0-9a-f]{12}",
                            it["object_id"]), it["object_id"]
    s1 = [it for it in items if it["object_type"] == "market_alert_s1"]
    assert len(s1) == 2
    for it in s1:
        text = it["title"] + it["payload"]
        assert "ruou" not in text and "Rượu" not in text and "rượu" not in \
            text and "sam-f" not in text and RUOU_TITLE not in text
    for it in items:      # không chép tiêu đề listing vào payload
        for _, _, title, *_ in LISTING:
            assert title.strip() not in it["payload"]
    assert {it["object_type"] for it in items} == {"market_alert_s1",
                                                   "listing_sync"}


def test_evidence_change_is_new_episode():
    rows, drafts, skus, rd, prices = _pure_inputs()
    a = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    rows[0] = dict(rows[0], price_vnd=220000)
    b = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    pa = [f["object_id"] for f in a["findings"] if f["kind"] == "price_drift"]
    pb = [f["object_id"] for f in b["findings"] if f["kind"] == "price_drift"]
    assert pa and pb and pa != pb
    ua = {f["object_id"] for f in a["findings"]
          if f["kind"] == "unready_listed"}
    ub = {f["object_id"] for f in b["findings"]
          if f["kind"] == "unready_listed"}
    assert ua == ub


def test_render_report_deterministic_no_alcohol_sku():
    rows, drafts, skus, rd, prices = _pure_inputs()
    res = kl.diff_catalog(rows, drafts, skus, rd, prices, {"shopee"})
    res["findings"][0]["dup_alert"] = 77
    t = kl.render_report(res, TODAY, {"new": 1, "seen": 2, "dup": 1})
    assert t == kl.render_report(res, TODAY, {"new": 1, "seen": 2, "dup": 1})
    assert t.index("## S1") < t.index("## S2")
    assert "(đã có cảnh báo sàn #77)" in t
    assert "chưa có file listing tiktok" in t
    assert "ruou" not in t and RUOU_TITLE not in t


# ---------------------------------------------------------------- W53.6 guard

WRITE_RE = re.compile(r"insert into|update |delete from|truncate|alter table"
                      r"|decide\(|auto_approve|override\(|approve_price"
                      r"|approve_cogs", re.IGNORECASE)
EGRESS_RE = re.compile(r"import (httpx|requests|socket|smtplib)|from (httpx|"
                       r"requests|smtplib|urllib\.request|http\.client)|"
                       r"llm_gateway|pipelines\.content|pipelines import "
                       r"content")


@pytest.mark.parametrize("mod", ["kd_listing.py", "kd_price.py"])
def test_no_write_sql_no_egress(mod):
    src = (ROOT / "agents" / mod).read_text(encoding="utf-8")
    assert not WRITE_RE.search(src), WRITE_RE.search(src)
    assert not EGRESS_RE.search(src)


# ---------------------------------------------------------------- DB

def test_running_listings_and_drafts_from_db(db):
    seed(db)
    rows, chans = kl.running_listings(db, MAPPING)
    assert chans == {"shopee"}
    assert {r["item_id"] for r in rows} == {"1001", "1002", "1003", "1004",
                                            "1006", "1007", "1008"}
    by = {r["item_id"]: r for r in rows}
    assert by["1001"]["sale_price"] == 140000 and by["1002"]["sale_price"] \
        is None
    d = kl.approved_drafts(db)
    assert d[("sam-a", "shopee")]["price"] == 200000
    assert d[("sam-b", "shopee")]["title"] == "Mật ong B"
    # Snapshot mới hơn thay snapshot cũ (chỉ dòng của bản mới nhất).
    sid = one(db, "insert into market_snapshots (channel, export_kind,"
              " file_name, file_sha256, row_count, imported_at) values"
              " ('shopee', 'listing', 'l2.csv', 'x2', 1, now() +"
              " interval '1 minute') returning id")
    db.execute("insert into market_rows (snapshot_id, row_no, channel,"
               " export_kind, item_id, sku_key, title, price_vnd, status,"
               " raw) values (%s, 2, 'shopee', 'listing', '2001', 'sam-a',"
               " 'x', 1, 'Đang hoạt động', '{}')", (sid,))
    rows, _ = kl.running_listings(db, MAPPING)
    assert [r["item_id"] for r in rows] == ["2001"]


def _queue(db):
    return db.execute(
        "select object_type, object_id, block, status, risk, decided_by,"
        " guardrail->>'ok', payload from approval_queue"
        " where object_id like 'a4:%' order by id").fetchall()


def test_cli_run_enqueue_idempotent_dup_alert_skipped(db, cli, monkeypatch,
                                                      capsys, tmp_path):
    ids = seed(db)
    monkeypatch.setattr(kl, "connect", lambda: TxConn(db))
    assert kl.main(["--run"]) == 0 and FakeRun.calls == [kl.JOB]
    q = _queue(db)
    # 8 phát hiện − 1 trùng alcohol_listed đang mở = 7 mục.
    assert len(q) == 7
    for ot, oid, block, st, risk, by, gok, payload in q:
        assert (block, st, risk, by, gok) == ("sales", "pending", "high",
                                              None, "true"), oid
        assert ot in ("listing_sync", "market_alert_s1")
        assert "ruou" not in payload and RUOU_TITLE not in payload
    assert not [r for r in q if ":1004:" in r[1]]
    assert len([r for r in q if r[0] == "market_alert_s1"]) == 1   # sam-f
    # Lần 2: 0 mục mới — kể cả mục đã bị từ chối (mọi status).
    with_role = q[0][1]
    qid = one(db, "select id from approval_queue where object_id = %s",
              (with_role,))
    db.execute(f"set local role {AH}")
    ok, _ = aq.decide(TxConn(db), qid, "GĐ bán hàng (test)", "rejected")
    db.execute("reset role")
    assert ok is True
    capsys.readouterr()
    assert kl.main(["--run"]) == 0
    assert "[run] đẩy 0 mục mới" in capsys.readouterr().out
    assert len(_queue(db)) == 7
    # Báo cáo: phát hiện trùng vẫn có, kèm số cảnh báo sàn.
    assert kl.main(["--report", "--out-dir", str(tmp_path)]) == 0
    [rep] = list(tmp_path.glob("catalog-sync-*.md"))
    text = rep.read_text(encoding="utf-8")
    assert f"(đã có cảnh báo sàn #{ids['alcohol']})" in text
    assert "ruou" not in text and RUOU_TITLE not in text


def test_dry_run_writes_nothing(db, cli, monkeypatch, capsys):
    seed(db)
    monkeypatch.setattr(kl, "connect", lambda: TxConn(db))
    tables = ("approval_queue", "agent_action_log", "market_alerts",
              "price_list", "sku_master", "job_runs")
    before = {t: one(db, f"select count(*) from {t}") for t in tables}
    assert kl.main(["--run", "--dry-run"]) == 0
    assert {t: one(db, f"select count(*) from {t}") for t in tables} == before
    assert FakeRun.calls == []
    out = capsys.readouterr().out
    assert "[dry-run] sẽ đẩy 7 mục mới" in out and "trùng cảnh báo sàn 1" in \
        out
    assert "ruou" not in out and RUOU_TITLE not in out


def test_agent_writer_cannot_write_golden(db):
    seed(db)
    pid = one(db, "select id from price_list order by id limit 1")
    for sql, params in (
            ("update price_list set approved_by = 'x' where id = %s", (pid,)),
            (("insert into price_list (sku_key, channel, kind, price_vnd,"
              " valid_from) values ('sam-a', 'web', 'list', 1,"
              " '2026-01-01')"), None),
            ("update sku_master set name = 'x' where sku_key = 'sam-a'",
             None)):
        with pytest.raises(psycopg.errors.InsufficientPrivilege) as e, \
                db.transaction():
            db.execute("set local role agent_writer")
            db.execute(sql, params)
        db.execute("reset role")
        # Bị chặn ở BẢNG (không phải thiếu quyền schema — pass ảo).
        assert re.search(r"table (price_list|sku_master)", str(e.value)), \
            str(e.value)


# ---------------------------------------------------------------- CLI

@pytest.mark.parametrize("argv", [
    [], ["--run", "--report"], ["--dry-run"], ["--report", "--dry-run"],
    ["--run", "--as-of", "2026-10-12"]])
def test_cli_usage_exit2_before_connect(cli, argv):
    with pytest.raises(SystemExit) as e:
        kl.main(argv)
    assert e.value.code == 2 and cli["connect"] == 0 and FakeRun.calls == []


def test_cli_bad_config_exit1_before_connect(cli, monkeypatch, tmp_path):
    monkeypatch.setattr(kl, "load_mapping",
                        lambda: (None, "mapping hỏng (test)"))
    assert kl.main(["--run", "--dry-run"]) == 1 and cli["connect"] == 0
    monkeypatch.setattr(kl, "load_mapping", lambda: (MAPPING, None))
    (tmp_path / "sales.json").write_bytes(b"{broken")
    monkeypatch.setattr(director, "DIRECTORS_DIR", tmp_path)
    assert kl.main(["--report"]) == 1 and cli["connect"] == 0


def test_cli_db_down_exit2_no_hang():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    t0 = time.monotonic()
    r = subprocess.run([sys.executable, "-m", "agents.kd_listing", "--run",
                        "--dry-run"], cwd=ROOT, env=env, capture_output=True,
                       timeout=120, encoding="utf-8", errors="replace",
                       check=False)
    assert r.returncode == 2 and "[error]" in r.stderr, r.stderr
    assert time.monotonic() - t0 < 60     # connect_timeout + khởi động


def test_cli_help_exit0():
    with pytest.raises(SystemExit) as e:
        kl.main(["--help"])
    assert e.value.code == 0
