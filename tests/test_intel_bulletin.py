"""v7.1 W71.4/W71.5/W71.6 — `scripts/intel_bulletin.py` (Summarizer &
Bulletin + gợi ý chủ đề) trên DB THẬT (schema tạm + ROLLBACK). Gateway LLM
là bản GIẢ (monkeypatch) — không gọi mạng. `now` tham số, không wall-clock.
"""

import importlib.util
import json
import os
import re
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from pipelines import approval_queue as aq
from pipelines import director, llm_gateway
from pipelines import intel_alert as ia
from pipelines.period import VN_TZ
from tests.test_intel_alert import isolation_problems

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "intel_bulletin", ROOT / "scripts" / "intel_bulletin.py")
ib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ib)

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC_B = (ROOT / "scripts" / "intel_bulletin.py").read_text(encoding="utf-8")
SRC_A = (ROOT / "pipelines" / "intel_alert.py").read_text(encoding="utf-8")
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=VN_TZ)
DAY = "2026-10-12"
T_SAM = "Giá sâm Ngọc Linh tăng mạnh cuối năm"
T_TP = "Thị trường thực phẩm bảo vệ sức khỏe tăng trưởng"
T_QC = "Quảng cáo KOL bị siết"
LONG = ("Trích dẫn dài xem https://bao.example.vn/xyz " + "chữ " * 80)[:300]


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
        schema = f"t_w71b_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
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


def _item(db, title, topics, fetched="2026-10-12T08:00:00+07:00",
          snippet="", source="fx71-a"):
    url = f"https://bao.example.vn/{uuid.uuid4().hex}"
    db.execute(
        "insert into intel_items (url, domain, source, tier, title, snippet,"
        " published_at, fetched_at, content_sha256, topics) values (%s,"
        " 'bao.example.vn', %s, 'A', %s, %s, %s, %s, %s, %s)",
        (url, source, title, snippet, fetched, fetched, uuid.uuid4().hex,
         list(topics)))
    return url


def _count(db, table, where="true"):
    return db.execute(f"select count(*) from {table} where {where}"
                      ).fetchone()[0]


@pytest.fixture
def env(db, monkeypatch, tmp_path):
    """connect → conn fixture; bản tin ra tmp; gateway đếm lời gọi."""
    calls = []
    monkeypatch.setattr(ib, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(ib, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(llm_gateway, "chat",
                        lambda *a, **kw: calls.append((a, kw)) or None)
    return types.SimpleNamespace(db=db, calls=calls, tmp=tmp_path,
                                 mp=monkeypatch)


def _run(argv, now=NOW):
    try:
        return ib.main(argv, now=now)
    except SystemExit as e:
        return e.code


def _report(env, period="day", start=DAY):
    return (env.tmp / "reports" / f"intel-bulletin-{period}-{start}.md"
            ).read_text(encoding="utf-8")


def _llm_on(env):
    cfg = json.loads(ib.SOURCES_FILE.read_text(encoding="utf-8"))
    cfg["llm"]["enabled"] = True
    p = env.tmp / "src.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    env.mp.setattr(ib, "SOURCES_FILE", p)


def _resp(text):
    msg = types.SimpleNamespace(content=text)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])


# ---------------------------------------------------------------- W71.4


def test_llm_off_zero_gateway_calls(env, capsys):
    url = _item(env.db, T_SAM, ["sam"])
    assert _run(["--period", "day", "--date", DAY, "--llm"]) == 0
    out = capsys.readouterr().out
    assert env.calls == [] and "[warn] LLM tắt" in out
    assert "llm_guardrail_fail=0" in out
    md = _report(env)
    for i, t in enumerate(ib.TOPICS, 1):
        assert f"### {i}. {ib.TOPIC_LABELS[t]}" in md
    assert T_SAM in md and url in md and ib.QUOTE_HEAD in md
    assert "## Cảnh báo đỏ đang mở" in md
    assert "## Nguồn lỗi / robots chặn" in md and "BẢN NHÁP" in md
    assert "Tóm tắt (AI" not in md


def test_llm_on_guardrail_drops_dirty(env, capsys):
    _llm_on(env)
    _item(env.db, T_SAM, ["sam"], snippet=LONG)
    _item(env.db, T_TP, ["tpbvsk"])
    _item(env.db, T_QC, ["quang_cao"])
    replies = iter(["Thị trường sâm sôi động dịp cuối năm.",
                    "Sản phẩm này chữa mất ngủ hiệu quả.",
                    "Tóm tắt: &#99;hữa bệnh nhanh."])
    sent = []

    def fake(agent, msgs, **kw):
        sent.append((agent, msgs, kw))
        return _resp(next(replies))
    env.mp.setattr(llm_gateway, "chat", fake)
    assert _run(["--period", "day", "--date", DAY, "--llm"]) == 0
    out = capsys.readouterr().out
    assert "llm_guardrail_fail=2" in out and "llm_summaries=1" in out
    md = _report(env)
    assert "Thị trường sâm sôi động dịp cuối năm." in md
    assert "chữa" not in md and "&#99;" not in md
    assert md.count(ib.DROPPED) == 2
    assert [s[0] for s in sent] == ["intel"] * 3
    for _, msgs, kw in sent:
        assert kw.get("max_tokens")
        body = msgs[-1]["content"]
        assert "http" not in body and "www." not in body
        segs = [ln[2:] for ln in body.splitlines() if ln.startswith("- ")]
        assert segs and all(len(s) <= ib.SEG_MAX for s in segs)


def test_llm_gateway_error_falls_back(env, capsys):
    _llm_on(env)
    _item(env.db, T_SAM, ["sam"])
    _item(env.db, T_TP, ["tpbvsk"])
    n = []

    def boom(*a, **kw):
        n.append(1)
        raise llm_gateway.GatewayBlocked("cap")
    env.mp.setattr(llm_gateway, "chat", boom)
    assert _run(["--period", "day", "--date", DAY, "--llm"]) == 0
    assert n == [1]                         # tắt phần còn lại của lượt
    assert "LLM tắt phần còn lại" in capsys.readouterr().out
    md = _report(env)
    assert T_SAM in md and T_TP in md and "Tóm tắt (AI" not in md


def test_week_period_vn_boundary(env):
    _item(env.db, "Tin sâm tuần trước", ["sam"],
          fetched="2026-10-11T23:30:00+07:00")
    _item(env.db, "Tin sâm tuần này", ["sam"],
          fetched="2026-10-12T00:10:00+07:00")
    assert _run(["--period", "week", "--date", DAY]) == 0
    md = _report(env, "week", "2026-10-12")
    assert "Tin sâm tuần này" in md and "Tin sâm tuần trước" not in md
    assert "12/10/2026–18/10/2026" in md
    assert _run(["--period", "week", "--date", "2026-10-11"]) == 0
    md = _report(env, "week", "2026-10-05")
    assert "Tin sâm tuần trước" in md and "Tin sâm tuần này" not in md


def test_source_health_and_open_alerts(env):
    env.db.execute(
        "insert into job_runs (job, started_at, finished_at, ok, detail)"
        " values ('crawler.intel', %s, %s, false, %s)",
        (NOW - timedelta(hours=2), NOW - timedelta(hours=2),
         "fail=fx-src robots_deny=1 blocked=0"))
    _item(env.db, "Thu hồi lô sâm Sâm Sâm nghi giả mạo", ["sam"])
    ia.scan(_TxConn(env.db), NOW)
    aid = env.db.execute("select id from red_alerts").fetchone()[0]
    assert _run(["--period", "day", "--date", DAY]) == 0
    md = _report(env)
    sec = md.split("## Nguồn lỗi / robots chặn")[1]
    assert "fx-src" in sec and "lỗi 1" in sec and "robots_deny=1" in sec
    alerts = md.split("## Cảnh báo đỏ đang mở")[1].split("## Tin theo")[0]
    assert f"#{aid}" in alerts and "CHƯA AI NHẬN" in alerts


def test_render_is_pure_and_capped():
    start = datetime(2026, 10, 12, tzinfo=VN_TZ)
    rows = [{"title": f"Tin {i}", "source": "fx", "url": f"u{i}",
             "published_at": None,
             "fetched_at": datetime(2026, 10, 12, 1, tzinfo=timezone.utc)}
            for i in range(25)]
    data = {"n_items": 25, "groups": {"sam": rows}, "alerts": [],
            "jobs": {"runs": 0, "failed": 0, "last_detail": None,
                     "fail_ids": []},
            "sources": {"ab": 8, "not_approved": 8, "errors": 0},
            "suggested": []}
    a = ib.render(data, start, start + timedelta(days=1), {"sam": None})
    assert a == ib.render(data, start, start + timedelta(days=1),
                          {"sam": None})
    assert "(+5 tin nữa)" in a and "Tin 19" in a and "Tin 20" not in a
    assert ib.DROPPED in a and "12/10/2026" in a and "8/8" in a


def test_render_escapes_markdown_from_feed():
    """OWASP (injection): tiêu đề RSS/tóm tắt LLM không thành ảnh/link tự tải
    khi mở bản tin; URL không phải http(s) không thành autolink."""
    start = datetime(2026, 10, 12, tzinfo=VN_TZ)
    evil = "Tin ![x](https://evil.example/t.png) <img src=x> `code`"
    rows = [{"title": evil, "source": "fx[1]", "published_at": None,
             "url": "javascript:alert(1)", "fetched_at": start},
            {"title": "ok", "source": "fx", "published_at": None,
             "url": "https://bao.example.vn/a", "fetched_at": start}]
    data = {"n_items": 2, "groups": {"sam": rows}, "alerts": [],
            "jobs": {"runs": 0, "failed": 0, "last_detail": None,
                     "fail_ids": []},
            "sources": {"ab": 0, "not_approved": 0, "errors": 0},
            "suggested": []}
    md = ib.render(data, start, start + timedelta(days=1),
                   {"sam": "Tóm tắt ![y](https://evil.example/u.png)"})
    for pat in (r"(?<!\\)!(?<!\\)\[", r"(?<!\\)<img", r"(?<!\\)\]\(https"):
        assert not re.search(pat, md), pat         # chỉ còn bản đã escape
    assert r"\!\[x\]" in md and r"\<img src=x\>" in md
    assert "<https://bao.example.vn/a>" in md and "<javascript" not in md


@pytest.mark.parametrize("argv", [
    ["--date", "2026-13-01"], ["--period", "month"], ["--date", "12/10/2026"],
    ["--period", "week", "--date", "9999-12-31"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(ib, "connect", lambda: calls.append(1))
    assert _run(argv) == 2 and calls == []


def test_cli_db_down_exit1(monkeypatch, capsys):
    monkeypatch.setattr(ib, "connect", lambda: None)
    assert _run(["--period", "day"]) == 1
    assert "không kết nối được" in capsys.readouterr().out


# ---------------------------------------------------------------- W71.5


def _golden_terms():
    g = json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8"))
    return [t for s in g["skus"] for t in (s["name"], s["sku_key"])]


def _topic_rows(db):
    return db.execute(
        "select id, block, status, risk, guardrail->>'ok', payload, title,"
        " created_by from approval_queue where object_type = 'intel_topic'"
        " order by id").fetchall()


def test_suggest_goes_to_queue_not_auto_approved(env, tmp_path):
    titles = ["Giá sâm Ngọc Linh tăng mạnh", "Sâm Hàn Quốc giảm giá",
              "TPBVSK tăng trưởng", "Thực phẩm chức năng nhập khẩu",
              "Giới trẻ chuộng trà sữa"]
    for t, tp in zip(titles, ["sam", "sam", "tpbvsk", "tpbvsk", "gioi_tre"]):
        _item(env.db, t, [tp])
    assert _run(["--period", "day", "--date", DAY, "--suggest"]) == 0
    rows = _topic_rows(env.db)
    assert len(rows) == 2
    golden = [g.lower() for g in _golden_terms()]
    for qid, block, status, risk, g_ok, payload, title, by in rows:
        assert (block, status, risk, g_ok) == ("intel", "pending", "medium",
                                               "true")
        assert by == "agent:intel_bulletin"
        low = payload.lower()
        assert "http" not in low and not any(t.lower() in low for t in titles)
        assert not any(g in low for g in golden)
    md = _report(env)
    for qid, *_ in rows:
        assert f"#{qid} `intel_topic`" in md
    assert md.count("chờ Quản lý MXH duyệt") >= 2
    assert _run(["--period", "day", "--date", DAY, "--suggest"]) == 0
    assert len(_topic_rows(env.db)) == 2                     # không trùng
    tx = _TxConn(env.db)
    ok, msg = aq.auto_approve(tx, rows[0][0])
    assert ok is False and msg
    assert env.db.execute("select status from approval_queue where id = %s",
                          (rows[0][0],)).fetchone()[0] == "pending"
    # Bản tin GĐ khối lúc còn 1 giờ tới hạn SLA 48h: mục nằm ở "sắp quá hạn".
    due = env.db.execute("select min(due_at) from approval_queue where"
                         " object_type = 'intel_topic'").fetchone()[0]
    _, text = director.run(tx, "intel", due - timedelta(hours=1),
                           out_dir=tmp_path / "dir")
    assert text.count("`intel_topic`") == 2 and "Vai trò duyệt: mxh" in text
    assert "| Đang chờ duyệt (tồn) | 2 |" in text
    assert {r[2] for r in _topic_rows(env.db)} == {"pending"}


def test_suggest_guardrail_fail_skipped(env, capsys):
    env.mp.setattr(ib, "ANGLES", {t: "sản phẩm chữa bệnh" for t in ib.TOPICS})
    for t in ("Giá sâm tăng", "Sâm Hàn Quốc giảm giá"):
        _item(env.db, t, ["sam"])
    assert _run(["--period", "day", "--date", DAY, "--suggest"]) == 0
    assert _topic_rows(env.db) == []
    assert "vi phạm guardrail" in capsys.readouterr().out


def test_director_intel_config():
    cfg = director.load_config("intel")
    assert cfg["approver_roles"] == ["mxh"]
    assert cfg["approvers"] == [] and cfg["digest_recipients"] == []
    assert cfg["object_types"]["intel_topic"] == {"sla_hours": 48,
                                                  "risk": "medium"}
    assert {"intel_bulletin", "competitor_report"} <= set(cfg["object_types"])


# ---------------------------------------------------------------- W71.6


def test_no_path_to_content_drafts_grep_ast():
    for src in (SRC_B, SRC_A):
        assert isolation_problems(src) == []
    assert re.findall(r"(?:insert into|update|delete from) +([a-z_]+)",
                      SRC_B, re.IGNORECASE) == []
    assert "director.submit" in SRC_B          # ghi duy nhất qua hàng duyệt


def test_isolation_db_counts_full_flow(env, capsys):
    _llm_on(env)
    db = env.db
    # fetched_at = now() của DB: `--run` dùng giờ thật (lookback 48h).
    now = db.execute("select now()").fetchone()[0]
    _item(db, "Thu hồi lô sâm Sâm Sâm nghi giả mạo", ["sam"], fetched=now)
    _item(db, "Giá sâm Ngọc Linh tăng", ["sam"], fetched=now)
    _item(db, T_TP, ["tpbvsk"], fetched=now)
    before = {t: _count(db, t) for t in ("content_drafts", "intel_items",
                                         "approval_queue")}
    env.mp.setattr(llm_gateway, "chat",
                   lambda *a, **kw: _resp("Thị trường sâm sôi động."))
    env.mp.setattr(ia, "connect", lambda: _TxConn(db))
    env.mp.setattr(ia, "job_run", lambda n: _null_job())
    assert ia.main(["--run"]) == 1          # thiếu người nhận → fail-closed
    assert _run(["--period", "day", "--llm", "--suggest"], now=now) == 0
    assert _count(db, "content_drafts") == before["content_drafts"]
    assert _count(db, "intel_items") == before["intel_items"]
    assert _count(db, "approval_queue") == before["approval_queue"] + 1
    assert _count(db, "approval_queue", "object_type <> 'intel_topic'") == 0
    assert _count(db, "red_alerts") == 1


class _null_job:
    def __enter__(self):
        return {"ok": True, "detail": None}

    def __exit__(self, *a):
        return False


# ---------------------------------------------------------------- v10.2 PC-A8

_LEGAL_LINE = re.compile(r"^> - .+ · \d{4}-\d{2}-\d{2}(?: \(ngày thu\))? · "
                         r"<https?://\S+>$")


def _legal_rows():
    pub = datetime(2026, 10, 11, 20, 0, tzinfo=timezone.utc)   # 12/10 VN
    got = datetime(2026, 10, 12, 1, 0, tzinfo=timezone.utc)
    return [{"title": "Nghị định sửa đổi quy định thực phẩm chức năng",
             "source": "chinhphu-van-ban", "published_at": pub,
             "fetched_at": got, "url": "https://vanban.example.gov.vn/nd-1"},
            {"title": "Dự thảo thông tư về quảng cáo",
             "source": "boyte-van-ban", "published_at": None,
             "fetched_at": got, "url": "https://moh.example.gov.vn/tt-2"}]


def test_render_phap_ly_every_line_has_url_and_date():
    assert "phap_ly" in ib.TOPICS and ib.TOPIC_LABELS["phap_ly"] == \
        "Văn bản pháp luật"
    start = datetime(2026, 10, 12, tzinfo=VN_TZ)
    data = {"n_items": 2, "groups": {"phap_ly": _legal_rows()}, "alerts": [],
            "jobs": {"runs": 0, "failed": 0, "last_detail": None,
                     "fail_ids": []},
            "sources": {"ab": 3, "not_approved": 3, "errors": 0},
            "suggested": []}
    md = ib.render(data, start, start + timedelta(days=1))
    sec = md.split("Văn bản pháp luật — 2 tin")[1].split("## ")[0]
    lines = [ln for ln in sec.splitlines() if ln.startswith("> - ")]
    assert len(lines) == 2
    assert all(_LEGAL_LINE.match(ln) for ln in lines), lines
    assert "· 2026-10-12 ·" in lines[0]            # published_at giờ VN
    assert "2026-10-12 (ngày thu)" in lines[1]     # thiếu published_at
    assert ib.LEGAL_FOOTER in sec and "Pháp chế quyết" in sec
    # Chủ đề cũ vẫn giữ định dạng ngày dd/mm/YYYY (không đổi output cũ).
    data["groups"] = {"sam": [dict(_legal_rows()[0], title="Giá sâm")]}
    md2 = ib.render(data, start, start + timedelta(days=1))
    assert "· 12/10/2026 ·" in md2 and ib.LEGAL_FOOTER not in md2


def test_suggest_and_llm_skip_phap_ly(env, capsys):
    _llm_on(env)
    for t in ("Nghị định mới về thực phẩm chức năng",
              "Dự thảo thông tư quảng cáo thực phẩm",
              "Văn bản hợp nhất luật an toàn thực phẩm"):
        _item(env.db, t, ["phap_ly"], source="chinhphu-van-ban")
    sent = []
    env.mp.setattr(llm_gateway, "chat",
                   lambda *a, **kw: sent.append(a) or _resp("tóm tắt"))
    subs = []
    real = director.submit
    env.mp.setattr(director, "submit",
                   lambda *a, **kw: subs.append(a) or real(*a, **kw))
    assert _run(["--period", "day", "--date", DAY, "--llm", "--suggest"]) == 0
    assert subs == [] and _topic_rows(env.db) == []      # 0 gợi ý phap_ly
    assert sent == []                                   # 0 tóm tắt LLM
    md = _report(env)
    sec = md.split("Văn bản pháp luật — 3 tin")[1].split("## ")[0]
    lines = [ln for ln in sec.splitlines() if ln.startswith("> - ")]
    assert len(lines) == 3 and all(_LEGAL_LINE.match(ln) for ln in lines)
    assert "Tóm tắt (AI" not in sec
