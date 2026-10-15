"""v8.1 W81.4 — `agents.ceo_audit`: audit outside-in P1 (nghiệm thu WP10
"Audit outside-in phát hiện đúng bài lệch bản approved trên fixture").

Đường THẬT trên DB (schema tạm + `docs/schema.sql` + `docs/roles.sql` ×2 →
ROLLBACK): draft tạo bằng `store.save_draft` + duyệt `store.set_status`
(người khác người tạo); bài nạp bằng `ra_kenh.ingest` từ `posts_MAU.csv`
(bản tmp thay `__DRAFT_Pn__` bằng id thật); listing sinh bằng
`content.listing(llm=False)` + duyệt; file sàn nạp bằng
`market_csv.read_export` + `load`. Kỳ vọng viết sẵn trong
`tests/fixtures/ceo_audit/README.md`. Tên người là giả lập.
"""

import csv
import io
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from agents import ceo_audit as au
from agents import ra_kenh
from ingest import golden_store as gs
from ingest import market_csv as mc
from pipelines import content, guardrail, store
from pipelines.period import VN_TZ
from scripts import dpia_draft

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "ceo_audit"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
T0 = datetime(2026, 10, 12, 9, 0, tzinfo=VN_TZ)
FB = "https://www.facebook.com/samsam/posts/"
P = {n: f"{FB}p{n}" for n in (1, 2, 4, 5, 6)} | {3: f"{FB}p3?ref=0905123456"}
CREATOR, REVIEWER = "agent:mkt-test", "Phap Che Gia Lap"
MXH = "Quản lý MXH (test)"
L_ITEM = {1: "24325987926", 2: "27357883504", 3: "24825885894",
          4: "99900000002"}
# Viết sẵn (không tính lại bằng chính module): đúng 6 phát hiện.
EXPECT = {("facebook", "lech_ban_duyet", P[2]),
          ("facebook", "thieu_ban_duyet", P[3]),
          ("facebook", "thieu_ban_duyet", P[5]),
          ("shopee", "lech_ban_duyet", L_ITEM[2]),
          ("shopee", "thieu_ban_duyet", L_ITEM[3]),
          ("shopee", "khong_xac_dinh_sku", L_ITEM[4])}
WATCH = ("channel_posts", "market_rows", "approval_queue", "approvals",
         "red_alerts", "content_drafts")


class TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture;
    `log` ghi mọi SQL (chứng minh chỉ SELECT)."""

    def __init__(self, conn, log=None):
        self.conn = conn
        self.log = log

    def execute(self, sql, *a, **kw):
        if self.log is not None:
            self.log.append(str(sql))
        return self.conn.execute(sql, *a, **kw)

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


def ceo_db():
    """Generator conn trên schema tạm (schema.sql ×2 + roles.sql ×2) —
    ROLLBACK cuối; dùng lại ở test_ceo_risk/test_ceo_decisions. Skip khi
    không có DB (gate đòi 0 skipped)."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        # roles.sql đụng role toàn cluster — nhiều worktree chạy song song.
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w81a_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


@pytest.fixture
def db():
    yield from ceo_db()


def counts(db) -> tuple:
    return tuple(db.execute(f"select count(*) from {t}").fetchone()[0]
                 for t in WATCH)


def _post_texts() -> dict:
    raw = (FIX / "posts_MAU.csv").read_bytes().decode("utf-8")
    return {r["url"]: r["text"] for r in csv.DictReader(io.StringIO(raw))}


def _listing_titles() -> list[str]:
    raw = (FIX / "listing_shopee_MAU.csv").read_bytes().decode("utf-8")
    return [r["Tên sản phẩm"] for r in csv.DictReader(io.StringIO(raw))]


def _approved(tx, text, channel="facebook", **kw) -> int:
    did = store.save_draft(tx, "brief test", channel, text,
                           kw.pop("g", None) or guardrail.check(text),
                           created_by=CREATOR, **kw)
    assert store.set_status(tx, did, "approved", REVIEWER) == (True, None)
    return did


def _latest(db, url) -> tuple:
    return db.execute("select codes, severity, close_reason from"
                      " channel_posts where url = %s order by id desc limit 1",
                      (url,)).fetchone()


def seed(db, tmp_path) -> dict:
    """Dựng fixture P1–P6 + L1–L4 bằng đường THẬT. → id draft + tiêu đề."""
    gs.load(db, json.loads((ROOT / "data" / "golden_skus.json")
                           .read_text(encoding="utf-8")))
    tx = TxConn(db)
    texts = _post_texts()
    d1 = _approved(tx, texts[P[1]])
    approved2 = texts[P[2]].replace("quý khách!", "quý khách.")
    assert approved2 != texts[P[2]] and len(approved2) == len(texts[P[2]])
    d2 = _approved(tx, approved2)
    d5 = _approved(tx, texts[P[5]])
    raw = (FIX / "posts_MAU.csv").read_bytes().decode("utf-8")
    for k, did in (("P1", d1), ("P2", d2), ("P5", d5)):
        raw = raw.replace(f"__DRAFT_{k}__", str(did))
    assert "__DRAFT_" not in raw
    path = tmp_path / "posts.csv"
    path.write_bytes(raw.encode("utf-8"))
    cfg = ra_kenh.load_config()
    st = ra_kenh.ingest(tx, ra_kenh.read_export(path, cfg), cfg, by=MXH,
                        now=T0)
    assert st["new"] == 6
    assert _latest(db, P[1])[:2] == ([], None)
    assert _latest(db, P[2])[0] == ["lech_ban_duyet"]
    assert _latest(db, P[5])[:2] == ([], None)        # sạch LÚC NẠP
    # Thu hồi bản duyệt P5 SAU khi nạp (dòng approvals rejected mới nhất,
    # cùng sha) — `codes` đã lưu vẫn [] → audit phải tính lại.
    db.execute("insert into approvals (object_type, object_id,"
               " content_sha256, decision, approved_by, note) values"
               " ('content_draft', %s, %s, 'rejected', %s, %s)",
               (str(d5), store.content_sha256(texts[P[5]]), REVIEWER,
                "thu hồi bản duyệt (test)"))
    assert ra_kenh.mark_removed(tx, P[6], MXH, T0 + timedelta(hours=1))[0]
    first = {}
    for sku in ("savigout-30v", "savina-12v"):
        r = content.listing(sku, "shopee", llm=False)
        assert r["ok"], r
        m = r["meta"]
        did = store.save_draft(
            tx, f"listing {sku} shopee", "shopee", r["text"], r["guardrail"],
            store.SOURCE_CLI, created_by=CREATOR, content_type="listing",
            sku=sku, is_ai=True, prompt_version=m["prompt_version"],
            prompt_sha256=m["prompt_sha256"])
        assert store.set_status(tx, did, "approved", REVIEWER) == (True, None)
        first[sku] = r["text"].splitlines()[0]
    titles = _listing_titles()
    # drift-guard: L1 = dòng đầu listing đã duyệt; L2 cố tình khác
    assert titles[0] == first["savigout-30v"]
    assert au.norm_title(titles[1]) != au.norm_title(first["savina-12v"])
    mapping, err = mc.load_mapping()
    assert err is None
    rows, errs, sha = mc.read_export(FIX / "listing_shopee_MAU.csv", "shopee",
                                     "listing", mapping)
    assert errs == [] and len(rows) == 4
    mc.load(db, rows, "shopee", "listing", "listing_shopee_MAU.csv", sha)
    return {"drafts": (d1, d2, d5), "texts": texts, "titles": titles}


def _found(data) -> set:
    return {(f["channel"], f["code"], f["ref"]) for f in au.findings(
        data["items"])}


# ---------------------------------------------------------------- DB thật
def test_wp10_acceptance_outside_in_fixture(db, tmp_path):
    seed(db, tmp_path)
    before = counts(db)
    log: list = []
    data = au.collect(TxConn(db, log))
    assert counts(db) == before and log
    assert all(re.match(r"\s*select\b", s, re.IGNORECASE) for s in log), log
    assert _found(data) == EXPECT
    comp = {c["channel"]: c for c in au.compliance(
        data["items"], snapshots=data["snapshots"])}
    assert (comp["facebook"]["n"], comp["facebook"]["khop"],
            comp["facebook"]["rate"]) == (4, 1, "25%")
    assert (comp["shopee"]["n"], comp["shopee"]["khop"],
            comp["shopee"]["rate"]) == (4, 1, "25%")
    assert comp["shopee"]["note"] is None
    assert comp["tiktok"]["n"] == 0 and comp["tiktok"]["rate"] == "—"
    assert comp["tiktok"]["note"] == au.NO_DATA
    assert [r["ref"] for r in data["removed"]] == [P[6]]
    assert [r["ref"] for r in data["before"]] == [P[4]]
    # P5: codes lưu lúc nạp vẫn sạch — audit KHÔNG tin, tính lại ra thiếu
    assert _latest(db, P[5])[:2] == ([], None)


def test_collect_inside_read_only_transaction(db, tmp_path):
    seed(db, tmp_path)
    with db.transaction():
        db.execute("set local transaction_read_only = on")
        data = au.collect(TxConn(db))
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction), \
                db.transaction():
            db.execute("insert into decision_log (entry_kind, decided_on,"
                       " topic, decision, decided_by, basis_kind, note,"
                       " recorded_by) values ('quyet_dinh', '2026-10-01',"
                       " 'x', 'y', 'A', 'van_ban', 'văn bản test dài', 'B')")
        raise psycopg.Rollback()
    assert _found(data) == EXPECT


def test_report_cli_masks_and_no_post_text(db, tmp_path, monkeypatch,
                                           capsys):
    info = seed(db, tmp_path)
    before = counts(db)
    monkeypatch.setattr(au, "connect", lambda: TxConn(db))
    out = tmp_path / "reports"
    assert au.main(["--report", "--now", "2026-10-12T10:00", "--out-dir",
                    str(out)]) == 0
    assert counts(db) == before
    page = (out / "ceo-audit-2026-10-12.md").read_bytes().decode("utf-8")
    sec = "\n".join(au.section(TxConn(db), T0))
    for text in (page, sec):
        for t in info["texts"].values():
            assert t not in text
            assert t[:40] not in text
        for t in info["titles"]:
            assert t not in text
        assert "0905123456" not in text
    assert "posts/p3?ref=***" in page
    # section trang TGĐ/bản tin: CHỈ #id nội bộ, không URL/item_id
    assert "facebook.com" not in sec and "posts/p" not in sec
    assert not any(v in sec for v in L_ITEM.values())
    assert re.search(r"— post #\d+$", sec, re.MULTILINE)
    # report: đủ 6 phát hiện; section: ≤ 5 + "…và 1"
    assert sum(1 for ln in page.splitlines()
               if re.match(r"- \[(facebook|shopee)\] ", ln)) == 6
    assert sum(1 for ln in sec.splitlines()
               if re.match(r"- \[(facebook|shopee)\] ", ln)) == 5
    assert "…và 1 (xem ceo-audit-2026-10-12.md)" in sec
    assert "| facebook | 4 | 1 | 25% |" in page
    assert "| shopee | 4 | 1 | 25% |" in page
    assert "| tiktok | 0 | 0 | — |" in page and au.NO_DATA in page
    assert "GIỚI HẠN P1" in page and "mô tả" in page
    assert guardrail.check(page)["ok"] is True
    assert "6 phát hiện" in capsys.readouterr().out


# ---------------------------------------------------------------- thuần
def test_rate_and_compliance_pure():
    assert au.rate(0, 0) == "—" and au.rate(1, 4) == "25%"
    assert au.rate(1, 3) == "33,3%" and au.rate(4, 4) == "100%"
    items = [{"channel": "facebook", "code": "khop", "kind": "post",
              "ref": "u1"},
             {"channel": "facebook", "code": "thieu_ban_duyet",
              "kind": "post", "ref": "u2"}]
    comp = {c["channel"]: c for c in au.compliance(items)}
    assert set(comp) == {"facebook", "shopee", "tiktok"}
    assert comp["facebook"]["rate"] == "50%"
    assert comp["shopee"]["rate"] == "—" and comp["shopee"]["n"] == 0
    assert comp["shopee"]["note"] == au.NO_DATA
    comp = {c["channel"]: c for c in au.compliance(
        items + [{"channel": "tiktok", "code": "khop", "kind": "post",
                  "ref": "u3"}])}
    assert comp["tiktok"]["note"] == f"listing: {au.NO_DATA}"
    assert au.norm_title(" Savigout  30\tVIÊN ") == au.norm_title(
        "savigout 30 viên")


@pytest.mark.parametrize("argv", [
    [], ["--now", "2026-10-12"], ["--report", "--now", "12/10/2026"],
    ["--report", "--bogus"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(au, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        au.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, tmp_path):
    monkeypatch.setattr(au, "connect", lambda: None)
    assert au.main(["--report", "--out-dir", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []


def test_cli_dead_host_subprocess():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "agents.ceo_audit", "--report",
                        "--out-dir", str(ROOT / "data" / "reports")],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2 and "không kết nối" in r.stderr


def test_grep_read_only_no_egress():
    src = (ROOT / "agents" / "ceo_audit.py").read_text(encoding="utf-8")
    assert not re.search(r"insert into|update |delete from|raise_alert|"
                         r"submit\(|mark_removed|ingest\(", src)
    assert not re.search(
        r"import (httpx|requests|socket|smtplib|openai)|from (httpx|requests"
        r"|smtplib|urllib\.request|http\.client|openai)|urllib\.request|"
        r"email\.mime|webbrowser|llm_gateway", src)
    assert "agents/ceo_audit.py" not in dpia_draft.egress_modules(ROOT)


def test_ref_rendered_inline_code_no_markdown_link():
    items = [{"channel": "facebook", "code": "thieu_ban_duyet",
              "kind": "post",
              "ref": "https://facebook.com/x/[a](javascript:1)`b`?p=0905123456"}]
    sec = "\n".join(au.render_section({"items": items, "removed": [],
                                       "before": [], "snapshots": {},
                                       "price_alerts_open": 0},
                                      full_ref=True))
    line = next(ln for ln in sec.splitlines() if ln.startswith("- [facebook]"))
    assert line.endswith("`https://facebook.com/x/[a](javascript:1)'b'?p=***`")
    assert line.count("`") == 2


def test_section_ids_only_bare_ascii_slug_passes_guardrail():
    """Cold-check MAJOR: slug URL 'chua'/'thuoc' + seller_sku trần — gập dấu
    thành từ cấm. Section (mặc định) chỉ #id → sạch guardrail; full_ref
    (file report) giữ URL và CHÍNH NÓ trượt (lý do không chép vào trang)."""
    url = "https://samsamngoclinh.com/sam-ngoc-linh-chua-qua-che-bien"
    items = [{"channel": "web", "code": "thieu_ban_duyet", "kind": "post",
              "ref": url, "post_id": 41},
             {"channel": "shopee", "code": "lech_ban_duyet",
              "kind": "listing", "ref": "123 · sam-thuoc-bo", "sku": "x",
              "row_id": 7}]
    data = {"items": items, "removed": [], "before": [], "snapshots": {},
            "price_alerts_open": 0}
    sec = "\n".join(au.render_section(data))
    assert "- [web] thieu_ban_duyet — post #41" in sec
    assert "- [shopee] lech_ban_duyet — listing market_rows #7" in sec
    assert "chua" not in sec and "thuoc" not in sec
    assert guardrail.check(sec)["ok"] is True
    full = "\n".join(au.render_section(data, full_ref=True))
    assert url in full and guardrail.check(full)["ok"] is False
