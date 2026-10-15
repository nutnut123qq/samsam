"""v6.5 W65.5 — `agents.seo_san` (MKT-11): gợi ý từ khóa tiêu đề listing sàn
→ nháp listing `pending`. `suggest` THUẦN (0 DB/mạng/LLM); `run` trên DB
thật schema tạm + ROLLBACK (precedent tests/test_listing.py), `_TxConn`.
Query Trends trong fixture là dữ liệu MẪU bịa.
"""

import copy
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import seo_san as ss
from agents import seo_web
from ingest import golden_store as gs
from pipelines import content, guardrail, kb_filter, llm_gateway

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json").read_bytes()
                    .decode("utf-8"))
VN = timezone(timedelta(hours=7))
RULES = seo_web.load_rules()
LR, _ = content._listing_rules()
RUOU = "ruou-sam-chai-thuy-tinh-500ml"


@pytest.fixture(autouse=True)
def _no_llm(monkeypatch):
    monkeypatch.setattr(llm_gateway, "chat",
                        lambda *a, **k: pytest.fail("seo_san không gọi LLM"))
    monkeypatch.setattr(content, "chat",
                        lambda *a, **k: pytest.fail("seo_san không gọi LLM"))


def _r(query, value="50", section="top", seed="nhân sâm", flags=None):
    return {"seed": seed, "section": section, "query": query, "value": value,
            "flags": flags or []}


REL = [
    _r("quà biếu sức khỏe", "60", seed="quà biếu"),
    _r("nhân sâm tươi", "100"),
    _r("hồng sâm cao cấp", "+250%", "rising", seed="hồng sâm"),
    _r("hộp quà sâm", "Breakout", "rising", seed="quà biếu"),
    _r("nhân sâm hàn quốc", "100"),               # hòa value → theo query
    _r("rượu nhân sâm", "90"),
    _r("trà sâm buổi tối", "+900%", "rising", flags=["ruou"]),
    _r("sâm ngọc linh", "100", seed="sâm ngọc linh"),
    _r("sâm chữa ung thư", "+100%", "rising"),
    _r("đồ ăn healthy", "100", seed="đồ ăn healthy giới trẻ"),
]


def _sg(sku="saphraton-20v", ch="shopee", title="Saphraton 20 viên",
        rel=REL, readiness=None):
    return ss.suggest(sku, ch, title, rel, rules=RULES, listing_rules=LR,
                      readiness=readiness)


def test_alcohol_sku_refused_zero_keywords():
    for ch in ("shopee", "tiktok"):
        s = _sg(RUOU, ch, "Rượu sâm 500ml")
        assert s["refused"]["code"] == "ruou"
        assert s["keywords"] == [] and s["title"] is None
        assert s["text"] is None


def test_alcohol_queries_rejected_for_every_sku():
    for sku in ("saphraton-20v", "savina-12v", "sapentol-30v"):
        s = _sg(sku)
        assert s["refused"] is None and s["failed"] is None, sku
        rej = {r["query"]: r["codes"] for r in s["rejected"]}
        assert rej["rượu nhân sâm"] == ["ruou"]
        assert rej["trà sâm buổi tối"] == ["ruou"]      # cờ ruou từ import
        low = s["text"].casefold()
        assert "rượu" not in low and "trà sâm buổi tối" not in low
        assert not kb_filter.is_alcohol(s["title"])
        assert not any(kb_filter.is_alcohol(k) for k in s["keywords"])


def test_ngoc_linh_and_banned_rejected_with_code():
    s = _sg()
    rej = {r["query"]: r["codes"] for r in s["rejected"]}
    assert "ngoc_linh_chua_xac_nhan" in rej["sâm ngọc linh"]
    assert "tu_cam" in rej["sâm chữa ung thư"]
    for q in ("sâm ngọc linh", "sâm chữa ung thư"):
        assert q not in s["keywords"] and q not in s["title"].casefold()


def test_seed_filter_order_and_title_limit():
    s = _sg()
    # top value giảm dần (hòa → query NFC casefold), rồi rising Breakout > %
    assert s["added"] == ["nhân sâm hàn quốc", "nhân sâm tươi",
                          "quà biếu sức khỏe", "hộp quà sâm",
                          "hồng sâm cao cấp"][:len(s["added"])]
    assert "đồ ăn healthy" not in s["keywords"]      # seed không thuộc luật
    assert s["keywords"][0] == "Sâm Sâm"              # brand_keywords
    assert len(s["keywords"]) <= LR["channels"]["shopee"]["keywords_max"]
    assert len(s["title"]) <= LR["channels"]["shopee"]["title_max"]
    assert s["title"].startswith("Saphraton 20 viên | ")
    assert s["title_reason"] == "tiêu đề hiện tại trên sàn"
    # tất định: chạy 2 lần y hệt; đảo thứ tự related cũng y hệt
    assert _sg() == s
    assert _sg(rel=list(reversed(REL))) == s


def test_title_max_every_case_shopee_and_tiktok():
    many = [_r(f"nhân sâm tươi loại {i:02d} chọn lọc kỹ càng", str(100 - i))
            for i in range(30)]
    rmap = {("savina-12v", "tiktok"): "MO_TA", ("savina-12v", "shopee"):
            "MO_TA"}
    for ch, title in (("shopee", None), ("shopee", "x" * 121),
                      ("tiktok", None), ("tiktok", "Savina" + " y" * 200),
                      ("shopee", "Savina tuýp")):
        s = _sg("savina-12v", ch, title, many, readiness=rmap)
        lim = LR["channels"][ch]
        assert s["refused"] is None and s["failed"] is None, (ch, s)
        assert len(s["title"]) <= lim["title_max"], (ch, len(s["title"]))
        assert len(s["keywords"]) <= lim["keywords_max"]
        if not title or len(title) > lim["title_max"]:
            assert s["base_title"] == "Savina tuýp 12 viên ngậm"
            assert "golden" in s["title_reason"]
    long_t = _sg("savina-12v", "tiktok", None, many, readiness=rmap)
    assert len(long_t["title"]) > LR["channels"]["shopee"]["title_max"]


def test_keyword_already_in_title_not_repeated():
    s = _sg(title="Saphraton 20 viên nhân sâm tươi")
    assert "nhân sâm tươi" in s["already"]
    assert s["title"].casefold().count("nhân sâm tươi") == 1
    assert "nhân sâm tươi" not in s["keywords"]


def test_full_text_passes_check_publish():
    s = _sg()
    res = guardrail.check_publish(s["text"], channel="shopee",
                                  content_type="listing",
                                  sku="saphraton-20v", is_ai=True)
    assert res["ok"] is True and s["guardrail"]["ok"] is True


def test_current_title_violating_fails_without_write():
    s = _sg(title="Saphraton chữa tiểu đường")
    assert s["failed"] and "tu_cam" in s["failed"]["codes"]


def test_readiness_and_unknown_refused():
    assert _sg("savina-12v", "tiktok")["refused"]["code"] == "readiness"
    assert _sg("khong-co", "shopee")["refused"]["code"] == "sku_la"
    assert _sg("savina-12v", "lazada")["refused"]["code"] == "kenh_la"


def test_no_write_or_llm_path_in_module():
    src = (ROOT / "agents" / "seo_san.py").read_text(encoding="utf-8")
    for bad in ("llm_gateway", "openai", ".post(", ".put(", "import httpx",
                "import requests"):
        assert bad not in src, bad


def test_cli_requires_run_exit2(monkeypatch):
    monkeypatch.setattr(ss, "connect", lambda: pytest.fail("không connect"))
    with pytest.raises(SystemExit) as e:
        ss.main([])
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        ss.main(["--run", "--channel", "lazada"])
    assert e.value.code == 2


# ------------------------------------------------------------ DB thật

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
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w65s_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        gs.load(conn, copy.deepcopy(GOLDEN))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn
        self.committed = 0
        self.inserts = 0

    def execute(self, sql, *a, **kw):
        if str(sql).lstrip().lower().startswith("insert"):
            self.inserts += 1
        return self.conn.execute(sql, *a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def close(self):
        pass


def _seed_market(db):
    for i, (ch, title, ts) in enumerate((
            ("shopee", "Saphraton 20 viên cũ", "2026-10-01T01:00:00+00:00"),
            ("shopee", "Saphraton 20 viên hộp giấy",
             "2026-10-05T01:00:00+00:00"))):
        sid = db.execute(
            "insert into market_snapshots (channel, export_kind, file_name,"
            " file_sha256, row_count, imported_at) values (%s, 'listing',"
            " %s, %s, 2, %s) returning id",
            (ch, f"listing_{i}.csv", f"{i:064d}", ts)).fetchone()[0]
        for row_no, sku, t in ((3, "saphraton-20v", title),
                               (2, "saphraton-20v", title + " (dòng 2)"),
                               (4, RUOU, "Rượu sâm")):
            db.execute(
                "insert into market_rows (snapshot_id, row_no, channel,"
                " export_kind, sku_key, title, raw) values (%s, %s, %s,"
                " 'listing', %s, %s, '{}')", (sid, row_no, ch, sku, t))
    for i, rows in enumerate((
            [("nhân sâm", "top", "nhân sâm cũ", "100", [])],
            [("nhân sâm", "top", "nhân sâm tươi", "100", []),
             ("nhân sâm", "top", "rượu nhân sâm", "90", ["ruou"]),
             ("quà biếu", "rising", "hộp quà sâm", "Breakout", [])])):
        iid = db.execute(
            "insert into intel_imports (kind, file_name, file_sha256,"
            " row_count) values ('trend_related', %s, %s, %s) returning id",
            (f"related_{i}.csv", f"{i + 7:064d}", len(rows))).fetchone()[0]
        for seed, sec, q, v, f in rows:
            db.execute("insert into trends_related (import_id, seed, section,"
                       " query, value, flags) values (%s, %s, %s, %s, %s, %s)",
                       (iid, seed, sec, q, v, f))


def test_db_run_creates_pending_then_skipped(db, tmp_path):
    _seed_market(db)
    tc = _TxConn(db)
    assert ss.current_title(tc, "saphraton-20v", "shopee") == \
        "Saphraton 20 viên hộp giấy (dòng 2)"        # snapshot mới, row_no nhỏ
    rel = ss.load_related(tc)
    assert {r["query"] for r in rel} == {"nhân sâm tươi", "rượu nhân sâm",
                                         "hộp quà sâm"}   # import mới nhất
    items = ss.run(tc, ["saphraton-20v", RUOU], ["shopee"], dry_run=False,
                   rules=RULES)
    st = {(i["sku"], i["status"]) for i in items}
    assert st == {("saphraton-20v", "created"), (RUOU, "refused")}
    row = db.execute(
        "select status, content_type, created_by, sku, channel,"
        " prompt_version, prompt_sha256, guardrail->>'ok', text"
        " from content_drafts").fetchall()
    assert len(row) == 1
    status, ctype, by, sku, ch, pv, sha, ok, text = row[0]
    assert (status, ctype, by, sku, ch, pv, ok) == (
        "pending", "listing", "agent:MKT-11", "saphraton-20v", "shopee",
        "seo-san-v1", "true")
    assert sha == ss.rules_sha256() and len(sha) == 64
    assert "nhân sâm tươi" in text and "rượu" not in text.casefold()
    assert db.execute("select count(*) from content_drafts where sku = %s",
                      (RUOU,)).fetchone()[0] == 0
    # chạy lại → skipped, 0 dòng mới
    again = ss.run(tc, ["saphraton-20v"], ["shopee"], dry_run=False,
                   rules=RULES)
    assert [i["status"] for i in again] == ["skipped"]
    assert db.execute("select count(*) from content_drafts").fetchone()[0] \
        == 1


def test_db_dry_run_zero_insert(db):
    _seed_market(db)
    tc = _TxConn(db)
    items = ss.run(tc, ["saphraton-20v", RUOU], ["shopee", "tiktok"],
                   dry_run=True, rules=RULES)
    assert tc.inserts == 0
    assert db.execute("select count(*) from content_drafts").fetchone()[0] \
        == 0
    assert {i["status"] for i in items} <= {"dry_run", "refused"}
    assert ("saphraton-20v", "shopee", "dry_run") in {
        (i["sku"], i["channel"], i["status"]) for i in items}
    text = ss.render("2026-10-12", items, True)
    assert "--dry-run" in text and "rượu nhân sâm" not in text


def test_cli_dry_run_report_vn_day(db, tmp_path, monkeypatch, capsys):
    _seed_market(db)
    monkeypatch.setattr(ss, "connect", lambda: _TxConn(db))
    late = datetime(2026, 10, 12, 18, 0, tzinfo=timezone.utc)   # 13/10 VN
    rc = ss.main(["--run", "--dry-run", "--sku", "saphraton-20v",
                  "--channel", "shopee", "--out-dir", str(tmp_path)],
                 now=late)
    assert rc == 0
    assert (tmp_path / "seo-san-2026-10-13.md").exists()
    assert "dry_run=1" in capsys.readouterr().out
    assert db.execute("select count(*) from content_drafts").fetchone()[0] \
        == 0
