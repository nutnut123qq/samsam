"""v4.3 W43.1 + W43.2 — schema `xnqc_dossiers`/`channel_posts` (CHECK chặn
`da_cap` thiếu người/số giấy/scan) + sổ hồ sơ XNQC `agents/xnqc.py`.

Phần THUẦN: `reminders` biên hạn đợt 2 / sắp hết hạn, `golden_target` 5
nhánh, CLI usage exit 2 TRƯỚC connect. Phần DB THẬT: schema tạm + rollback
(precedent `tests/test_director_framework.py`), golden nạp bằng
`ingest.golden_store.load`. NGƯỜI trong test là tên giả lập, không phải
Pháp chế thật; hồ sơ/số giấy/scan là dữ liệu test (hồ sơ thật = external-dep).
"""

import hashlib
import os
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import CheckViolation, ForeignKeyViolation

from agents import ra_kenh, xnqc
from agents.ra_kenh import load_config
from ingest import golden_store
from pipelines import approval_queue as aq
from pipelines import guardrail
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
CFG = load_config()
TP = ["savina-12v", "savigout-30v"]
SHA = {k: hashlib.sha256(k.encode()).hexdigest()
       for k in ("verified", "pending_review", "rejected", "cho_ocr")}
GOLDEN_SHA = hashlib.sha256(golden_store.GOLDEN_FILE.read_bytes()).hexdigest()


def _d(sku, status, het=None, i=1, cap=date(2026, 9, 1)):
    return {"id": i, "sku_key": sku, "status": status, "ngay_cap": cap,
            "ngay_het_han": het, "updated_by": "Phap Che Gia Lap"}


# ---------------------------------------------------------------- THUẦN
@pytest.mark.parametrize("today,prefix,n", [
    (date(2026, 11, 15), "CHƯA NỘP", 15), (date(2026, 11, 16), "SẮP HẠN", 14),
    (date(2026, 11, 30), "SẮP HẠN", 0), (date(2026, 12, 1), "QUÁ HẠN", 1)])
def test_reminders_dot2_boundaries(today, prefix, n):
    ms = xnqc.reminders([], TP, CFG, today)
    assert len(ms) == 2
    for m in ms:
        assert m.startswith(prefix), m
        assert (f"còn {n} ngày" in m) if prefix != "QUÁ HẠN" else \
            (f"đã qua {n} ngày" in m)
        assert "30/11/2026" in m


def test_reminders_expiry_and_back_to_unfiled():
    rows = [_d("savigout-30v", "da_cap", date(2026, 12, 10), 7)]
    ms = xnqc.reminders(rows, TP, CFG, date(2026, 11, 12))
    assert any(m.startswith("SẮP HẾT HẠN") and "#7" in m and "còn 28 ngày"
               in m for m in ms), ms
    assert not any(m.startswith(("CHƯA NỘP", "SẮP HẠN", "QUÁ HẠN"))
                   and "savigout-30v" in m for m in ms), ms
    ms = xnqc.reminders(rows, TP, CFG, date(2026, 12, 11))
    assert any(m.startswith("ĐÃ QUÁ HẠN — Pháp chế chuyển het_han")
               and "#7" in m for m in ms), ms
    assert any(m.startswith("QUÁ HẠN đợt 2 — savigout-30v") for m in ms), ms
    # đang nộp / bổ sung → không nhắc chưa nộp
    assert xnqc.reminders([_d("savina-12v", "bo_sung"),
                           _d("savigout-30v", "da_nop")], TP, CFG,
                          date(2026, 11, 16)) == []


def test_golden_target_branches():
    t = date(2026, 11, 1)
    assert xnqc.golden_target([_d("s", "da_cap", date(2027, 1, 1))], t) \
        == "approved"
    assert xnqc.golden_target([_d("s", "da_cap", None)], t) == "approved"
    assert xnqc.golden_target([_d("s", "da_cap", date(2026, 10, 1)),
                               _d("s", "da_nop")], t) == "pending"
    assert xnqc.golden_target([_d("s", "bo_sung")], t) == "pending"
    assert xnqc.golden_target([_d("s", "chuan_bi"), _d("s", "het_han")],
                              t) == "none"
    assert xnqc.golden_target([], t) == "none"
    # giấy chưa tới ngày cấp (ghi thẳng DB / --today lùi) KHÔNG phải approved
    assert xnqc.golden_target([_d("s", "da_cap", cap=t)], t) == "approved"
    assert xnqc.golden_target([_d("s", "da_cap", cap=date(2026, 11, 2))],
                              t) == "none"
    assert xnqc.golden_target([_d("s", "da_cap", cap=date(2029, 12, 31)),
                               _d("s", "da_nop")], t) == "pending"


def _no_connect(*a, **k):
    raise AssertionError("không được connect DB")


@pytest.mark.parametrize("argv", [
    ["--set", "1", "--status", "da_cap", "--by", "agent:x"],
    ["--set", "1", "--status", "da_cap", "--by", "  System: y"],
    ["--set", "1", "--status", "da_nop", "--by", "   "],
    ["--set", "1", "--status", "da_nop", "--by", "Ten\x1bNguoi"],
    ["--set", "1", "--status", "da_cap", "--by", "A", "--ngay-cap",
     "2026-13-01"],
    ["--add", "--list"],
    ["--remind", "--today", "16/11/2026"],
    [],
    # --today CHỈ cho --remind/--sync-golden: đẩy "hôm nay" tới trước = ghi
    # ngày cấp/nộp tương lai lọt chặn → golden 'approved' cho giấy chưa cấp
    ["--set", "1", "--status", "da_nop", "--by", "A", "--ngay-nop",
     "2026-10-01", "--today", "2030-01-01"],
    ["--set", "1", "--status", "da_cap", "--by", "A", "--so-giay", "1",
     "--ngay-cap", "2029-12-31", "--doc-sha", "a" * 64, "--today",
     "2030-01-01"],
    ["--add", "--sku", "savigout-30v", "--loai", "maket", "--ten", "m",
     "--by", "A", "--today", "2030-01-01"],
    ["--list", "--today", "2030-01-01"],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(xnqc, "connect", _no_connect)
    with pytest.raises(SystemExit) as e:
        xnqc.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2_no_hang():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "agents.xnqc", "--list"],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2 and "DB không truy cập được" in r.stdout


def test_cli_help_exit0():
    r = subprocess.run([sys.executable, "-m", "agents.xnqc", "--help"],
                       cwd=ROOT, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 0 and "--sync-golden" in r.stdout


# ---------------------------------------------------------------- DB THẬT
class _TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


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
        conn.execute("set local timezone = 'UTC'")
        schema = f"t_w43x_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        doc, err = golden_store.read_golden(golden_store.GOLDEN_FILE)
        assert err is None
        golden_store.load(conn, doc)
        for st, sha in SHA.items():
            conn.execute("insert into documents (sha256, filename, doc_type,"
                         " text_source, status) values (%s, %s,"
                         " 'giay_tiep_nhan', 'pdf_text', %s)",
                         (sha, f"scan-{st}.pdf", st))
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _skus(db):
    return db.execute("select * from sku_master order by sku_key").fetchall()


def _ins(db, **kw):
    row = {"sku_key": "savigout-30v", "loai_ho_so": "maket",
           "ten_ho_so": "maket test", "status": "da_cap", "so_giay": "01/2026",
           "ngay_nop": date(2026, 10, 1), "ngay_cap": date(2026, 10, 10),
           "ngay_het_han": None, "document_sha256": SHA["verified"],
           "updated_by": "Phap Che Gia Lap"} | kw
    cols = ", ".join(row)
    with db.transaction():
        db.execute(f"insert into xnqc_dossiers ({cols}) values"
                   f" ({', '.join(['%s'] * len(row))})", tuple(row.values()))


@pytest.mark.parametrize("kw", [
    {"so_giay": None}, {"so_giay": "  "}, {"ngay_cap": None},
    {"document_sha256": None}, {"updated_by": "agent:x"},
    {"updated_by": "  System: y"}, {"ngay_het_han": date(2026, 10, 10)},
    {"status": "da_nop", "ngay_nop": None}])
def test_schema_checks_block_direct_insert(db, kw):
    with pytest.raises(CheckViolation):
        _ins(db, **kw)


def test_schema_fk_and_valid_row(db):
    with pytest.raises(ForeignKeyViolation):
        _ins(db, sku_key="khong-co-sku")
    with pytest.raises(ForeignKeyViolation):
        _ins(db, document_sha256="f" * 64)
    _ins(db)       # hợp lệ (người + số giấy + scan)
    assert db.execute("select count(*) from xnqc_dossiers").fetchone()[0] == 1


def _log_rows(db, action="xnqc_status"):
    return db.execute("select actor, detail from agent_action_log where"
                      " action = %s order by id", (action,)).fetchall()


def test_db_full_flow_and_golden_untouched(db):
    tx = _TxConn(db)
    before = _skus(db)
    T = date(2026, 11, 20)
    did = xnqc.add(tx, "savigout-30v", "maket", "maket fanpage", "Phap Che A")
    with pytest.raises(ValueError):
        xnqc.add(tx, "khong-co", "maket", "x", "Phap Che A")
    with pytest.raises(ValueError):
        xnqc.add(tx, "savigout-30v", "maket", "x", "agent:a1")

    def st(s, **kw):
        return xnqc.set_status(tx, did, s, kw.pop("by", "Phap Che A"),
                               today=T, **kw)

    def cur():
        return db.execute("select status from xnqc_dossiers where id = %s",
                          (did,)).fetchone()[0]

    # chuyển sai → không ghi
    assert st("da_cap", so_giay="1", ngay_cap="2026-11-01",
              doc_sha=SHA["verified"])[0] is False and cur() == "chuan_bi"
    assert st("da_nop")[0] is False                   # thiếu ngày nộp
    assert st("da_nop", ngay_nop="2026-12-01")[0] is False  # tương lai
    assert st("da_nop", ngay_nop="2026-11-02")[0]
    assert cur() == "da_nop"
    assert st("bo_sung")[0] and cur() == "bo_sung"
    assert st("da_nop", ngay_nop="2026-11-10")[0] and cur() == "da_nop"
    base = {"so_giay": "123/2026/XNQC", "ngay_cap": "2026-11-15"}
    rejects = [
        dict(base, doc_sha=SHA["verified"], by=""),
        dict(base, doc_sha=SHA["verified"], by="agent:phap_che_a1"),
        {"ngay_cap": "2026-11-15", "doc_sha": SHA["verified"]},
        dict(base),
        dict(base, doc_sha=SHA["pending_review"]),
        dict(base, doc_sha=SHA["rejected"]),
        dict(base, doc_sha=SHA["cho_ocr"]),
        dict(base, doc_sha="e" * 64),
        dict(base, doc_sha=SHA["verified"], ngay_cap="2026-11-21"),
        dict(base, doc_sha=SHA["verified"], ngay_het_han="2026-11-15"),
    ]
    for kw in rejects:
        ok, msg = st("da_cap", **kw)
        assert ok is False and msg, kw
        assert cur() == "da_nop", kw
    ok, msg = st("da_cap", doc_sha=SHA["verified"],
                 ngay_het_han="2026-12-10", **base)
    assert ok, msg
    assert cur() == "da_cap"
    assert st("da_nop", ngay_nop="2026-11-02")[0] is False   # da_cap → da_nop
    items = db.execute(
        "select id, object_id, block, due_at - created_at, payload, status"
        " from approval_queue where object_type = 'golden_xnqc_sync'"
        " and object_id = 'savigout-30v:approved'").fetchall()
    assert len(items) == 1
    qid, _, block, sla, payload, status = items[0]
    assert block == "legal_hr" and sla == timedelta(hours=72)
    assert status == "pending"
    assert guardrail.check(payload)["ok"] is True
    assert "none→approved" in payload and "Phap Che A" in payload
    assert xnqc.sync_golden(tx, T) == []       # idempotent
    assert aq.decide(tx, qid, "Phap Che B", "approved") == (True, None)
    assert st("het_han")[0] and cur() == "het_han"
    for s in ("chuan_bi", "da_nop", "bo_sung", "da_cap", "het_han"):
        assert st(s, ngay_nop="2026-11-02")[0] is False
    assert cur() == "het_han"
    logs = _log_rows(db)
    steps = [(d["from"], d["to"]) for _, d in logs]
    assert steps == [("chuan_bi", "da_nop"), ("da_nop", "bo_sung"),
                     ("bo_sung", "da_nop"), ("da_nop", "da_cap"),
                     ("da_cap", "het_han")]
    assert all(a == "Phap Che A" and set(d) == {"id", "from", "to"}
               for a, d in logs)
    assert len(_log_rows(db, "xnqc_add")) == 1
    assert db.execute("select * from verify_action_log()").fetchall() == []
    # golden: file + sku_master KHÔNG đổi (agent chỉ đề xuất)
    assert _skus(db) == before
    assert hashlib.sha256(golden_store.GOLDEN_FILE.read_bytes()).hexdigest() \
        == GOLDEN_SHA


def _sync_items(db):
    return db.execute("select id, object_id, status, payload from"
                      " approval_queue where object_type = 'golden_xnqc_sync'"
                      " order by id").fetchall()


def test_sync_golden_supersedes_stale_and_waits_for_edit(db, monkeypatch,
                                                         capsys):
    """Đề xuất cũ trái đích không được nằm cạnh đề xuất mới mà không cảnh
    báo (duyệt nhầm mục '→approved' sau het_han = guardrail cho quảng cáo
    TPBVSK không XNQC); mục đã duyệt chờ người sửa golden không bị đề
    xuất lại. Agent KHÔNG tự quyết mục nào."""
    tx = _TxConn(db)
    T = date(2026, 11, 20)
    by = "Phap Che A"
    d1 = xnqc.add(tx, "savigout-30v", "maket", "maket fanpage", by)
    assert xnqc.set_status(tx, d1, "da_nop", by, ngay_nop="2026-11-02",
                           today=T)[0]
    assert xnqc.set_status(tx, d1, "da_cap", by, so_giay="1/2026",
                           ngay_cap="2026-11-15", doc_sha=SHA["verified"],
                           today=T)[0]
    (a, oa, *_), (b, ob, _, pb) = _sync_items(db)
    assert (oa, ob) == ("savigout-30v:pending", "savigout-30v:approved")
    assert f"THAY THẾ mục #{a} — chỉ duyệt mục mới nhất" in pb
    assert guardrail.check(pb)["ok"] is True
    assert any(m.startswith(f"mục #{a} savigout-30v→pending LỖI THỜI")
               for m in xnqc.sync_notes(tx, T))
    # het_han trong cửa sổ 72h: đích none = golden → mục GIỮ NGUYÊN thay
    # cả 2 mục cũ (trước: không gì, '→approved' vẫn chờ duyệt)
    assert xnqc.set_status(tx, d1, "het_han", by, today=T)[0]
    c, oc, sc, pc = _sync_items(db)[-1]
    assert (oc, sc) == ("savigout-30v:none", "pending")
    assert "GIỮ NGUYÊN" in pc and f"THAY THẾ mục #{a}, #{b}" in pc
    assert guardrail.check(pc)["ok"] is True
    assert xnqc.sync_golden(tx, T) == []
    notes = xnqc.sync_notes(tx, T)
    assert sum("LỖI THỜI" in m for m in notes) == 2, notes
    # hồ sơ 2 nộp → đích pending; mục ':pending' cũ (#a) còn pending (unique
    # index) → mục mới '@<id thay>' vẫn là mới nhất
    d2 = xnqc.add(tx, "savigout-30v", "maket", "maket web", by)
    assert xnqc.set_status(tx, d2, "da_nop", by, ngay_nop="2026-11-18",
                           today=T)[0]
    _, oe, se, pe = _sync_items(db)[-1]
    assert (oe, se) == (f"savigout-30v:pending@{c}", "pending")
    assert f"THAY THẾ mục #{b}, #{c}" in pe
    assert xnqc.sync_golden(tx, T) == []
    # đã duyệt mà golden chưa sửa → KHÔNG đề xuất lại, nhắc chờ người sửa
    d3 = xnqc.add(tx, "savina-12v", "maket", "maket web", by)
    assert xnqc.set_status(tx, d3, "da_nop", by, ngay_nop="2026-11-02",
                           today=T)[0]
    f, of, *_ = _sync_items(db)[-1]
    assert of == "savina-12v:pending"
    assert aq.decide(tx, f, "Phap Che B", "approved") == (True, None)
    n = len(_sync_items(db))
    assert xnqc.sync_golden(tx, T) == [] and len(_sync_items(db)) == n
    wait = f"mục #{f} savina-12v→pending đã duyệt — chờ người sửa golden"
    assert any(m.startswith(wait) for m in xnqc.sync_notes(tx, T))
    monkeypatch.setattr(xnqc, "connect", lambda: tx)
    capsys.readouterr()
    assert xnqc.main(["--sync-golden", "--today", "2026-11-20"]) == 0
    out = capsys.readouterr().out
    assert wait in out and "LỖI THỜI" in out and len(_sync_items(db)) == n
    # báo cáo Pháp chế §1 cũng liệt kê
    now = datetime(2026, 11, 20, 9, 0, tzinfo=VN_TZ)
    text = ra_kenh.render_report(ra_kenh.collect_report(tx, now, 7), now)
    sec1 = text.split("## 2.")[0]
    assert wait in sec1 and f"mục #{b} savigout-30v→approved LỖI THỜI" in sec1
    # golden file + sku_master không đổi
    assert hashlib.sha256(golden_store.GOLDEN_FILE.read_bytes()).hexdigest() \
        == GOLDEN_SHA


def test_cli_db_list_remind_sync(db, monkeypatch, capsys):
    monkeypatch.setattr(xnqc, "connect", lambda: _TxConn(db))
    assert xnqc.main(["--add", "--sku", "savina-12v", "--loai", "maket",
                      "--ten", "maket web", "--by", "Phap Che A"]) == 0
    assert xnqc.main(["--add", "--sku", "khong-co", "--loai", "maket",
                      "--ten", "x", "--by", "Phap Che A"]) == 1
    did = db.execute("select max(id) from xnqc_dossiers").fetchone()[0]
    assert xnqc.main(["--set", str(did), "--status", "da_cap", "--by",
                      "Phap Che A", "--so-giay", "1", "--ngay-cap",
                      "2026-11-01", "--doc-sha", SHA["verified"]]) == 1
    capsys.readouterr()
    assert xnqc.main(["--remind", "--today", "2026-11-16"]) == 0
    out = capsys.readouterr().out
    assert out.count("SẮP HẠN") == 8 and "còn 14 ngày" in out
    assert xnqc.main(["--list"]) == 0
    assert "savina-12v maket [chuan_bi]" in capsys.readouterr().out
    assert xnqc.main(["--sync-golden", "--today", "2026-11-16"]) == 0
    assert "không có" in capsys.readouterr().out
