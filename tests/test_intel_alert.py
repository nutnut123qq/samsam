"""v7.1 W71.1/W71.2/W71.6 — Red Alert intel (`pipelines.intel_alert`).

DB THẬT (`DATABASE_URL`) trong schema tạm + docs/schema.sql ×2 +
docs/roles.sql ×2 → ROLLBACK cuối test (mẫu `tests/test_director_framework.
py`). Thời gian: `now` tham số tính từ `ts` do DB đóng dấu — không assert
wall-clock, không sleep. Người nhận/người xác nhận trong test là tên GIẢ
LẬP, không phải người thật.
"""

import ast
import json
import os
import re
import uuid
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import InsufficientPrivilege, RaiseException, UniqueViolation
from psycopg.types.json import Jsonb

from pipelines import intel_alert as ia
from pipelines import red_alert

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC = (ROOT / "pipelines" / "intel_alert.py").read_text(encoding="utf-8")
AW, AH = "agent_writer", "app_human"
GOOD_RCP = {"name": "Nguoi Nhan Gia Lap (test)", "role": "phap_che",
            "channel": "email"}
RECALL = "Thu hồi lô sâm Sâm Sâm nghi giả mạo"


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
        schema = f"t_w71_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _item(db, title, topics=("sam",), snippet="", flags=(), source="fx71-a"):
    return db.execute(
        "insert into intel_items (url, domain, source, tier, title, snippet,"
        " content_sha256, topics, flags) values (%s, 'bao.example.vn', %s,"
        " 'A', %s, %s, %s, %s, %s) returning id",
        (f"https://bao.example.vn/{uuid.uuid4().hex}", source, title,
         snippet, uuid.uuid4().hex, list(topics), list(flags))).fetchone()[0]


def _one(db, sql, params=None):
    return db.execute(sql, params).fetchone()[0]


def _now(db):
    return _one(db, "select now()")


def _alerts(db, where="true", params=None):
    return db.execute(
        "select id, title, detail, recipients, route_error from red_alerts"
        f" where source_agent = 'intel_red_alert' and {where} order by id",
        params).fetchall()


# ---------------------------------------------------------------- luật


def test_real_rules_file_is_assumption():
    r = ia.load_rules()
    assert r["status"] == "gia_dinh" and r["lookback_hours"] == 48
    assert set(r["groups"]) == set(ia.GROUPS)
    raw = json.loads(ia.RULES_FILE.read_text(encoding="utf-8"))
    assert "GIẢ ĐỊNH" in raw["_doc"] and "Pháp chế" in raw["_doc"]
    assert ia.ESCALATE_AFTER == timedelta(hours=2)


def _rules_doc(**over):
    doc = json.loads(ia.RULES_FILE.read_text(encoding="utf-8"))
    doc.update(over)
    return doc


def _groups(**over):
    g = dict(_rules_doc()["groups"])
    g.update(over)
    return g


BAD_RULES = [
    None,                                            # file thiếu
    b"",                                             # rỗng
    b"{groups: [",                                   # JSON hỏng
    b"\xff\xfe{}",                                   # UTF-8 lỗi
    b"{}",
    json.dumps({"_doc": "chỉ ghi chú"}).encode(),
    b"[]",
    json.dumps(_rules_doc(groups={k: v for k, v in _groups().items()
                                  if k != "penalty"})).encode(),
    json.dumps(_rules_doc(groups=_groups(brand=[]))).encode(),
    json.dumps(_rules_doc(groups=_groups(negative=["  "]))).encode(),
    json.dumps(_rules_doc(groups=_groups(regulation="nghị định"))).encode(),
    json.dumps(_rules_doc(lookback_hours=0)).encode(),
    json.dumps(_rules_doc(lookback_hours=721)).encode(),
    json.dumps(_rules_doc(lookback_hours=True)).encode(),
    json.dumps(_rules_doc(lookback_hours="48")).encode(),
    # v10.2 PC-A8: legal_sources BẮT BUỘC (fail-closed)
    json.dumps({k: v for k, v in _rules_doc().items()
                if k != "legal_sources"}).encode(),
    json.dumps(_rules_doc(legal_sources=[])).encode(),
    json.dumps(_rules_doc(legal_sources=[""])).encode(),
    json.dumps(_rules_doc(legal_sources="x")).encode(),
    json.dumps(_rules_doc(legal_sources=["Bad Id"])).encode(),
    json.dumps(_rules_doc(legal_sources=[1])).encode(),
]


@pytest.mark.parametrize("content", BAD_RULES)
def test_load_rules_fail_closed(tmp_path, content):
    p = tmp_path / "rules.json"
    if content is not None:
        p.write_bytes(content)
    with pytest.raises(ia.IntelAlertConfigError):
        ia.load_rules(p)


POSITIVE = [
    (RECALL, (), ("sam",), (), "brand_negative"),
    ("thu hoi lo sam Sam Sam", (), ("sam",), (), "brand_negative"),
    ("Cảnh báo hàng giả mạo sâm Ngọc Linh bán trên mạng", (), ("sam",), (),
     "brand_negative"),
    ("Ngộ độc sau khi dùng sản phẩm Sâm Sâm không rõ nguồn gốc", (),
     ("sam",), (), "brand_negative"),
    ("Dự thảo nghị định về quảng cáo thực phẩm bảo vệ sức khỏe", (),
     ("tpbvsk", "quang_cao"), (), "regulation"),
    ("Quy định mới về kinh doanh rượu từ năm sau", (), ("sam",), ("ruou",),
     "regulation"),
    ("Trimico bị phạt vì quảng cáo sai sự thật", (), ("doi_thu",), (),
     "competitor_penalty"),
    ("Cơ sở KGC bị đình chỉ hoạt động", (), ("doi_thu",), (),
     "competitor_penalty"),
    # nghiệm thu MINOR: tên vùng/thương hiệu chen giữa 'sâm' và 'giả', 'nhái'
    ("Cảnh báo sâm Ngọc Linh giả bán tràn lan", (), ("sam",), (),
     "brand_negative"),
    ("Phát hiện sâm Ngọc Linh giả trên mạng", (), ("sam",), (),
     "brand_negative"),
    ("Hàng nhái thương hiệu Sâm Sâm", (), ("sam",), (), "brand_negative"),
    ("Đường dây làm giả sâm Ngọc Linh bị triệt phá", (), ("sam",), (),
     "brand_negative"),
    # v10.2 PC-A8: nguồn văn bản pháp luật (legal_sources) + chủ đề tpbvsk
    ("Thông tư hướng dẫn ghi nhãn thực phẩm chức năng", (),
     ("phap_ly", "tpbvsk"), (), "legal_doc", "cuc-attp-van-ban"),
    # đợt hợp đồng (PL01 Tình báo "sâm giả, mạo danh Ngọc Linh"): không cần
    # nhắc tên Sâm Sâm/brand
    ("Sâm giả tràn lan chợ Tết", (), ("sam",), (), "counterfeit"),
    ("Cảnh báo sâm trôi nổi gắn mác Ngọc Linh", (), ("sam",), (),
     "counterfeit"),
    ("Mạo danh sâm Ngọc Linh để bán hàng online", (), ("sam",), (),
     "counterfeit"),
    ("Sâm Sâm bị mạo danh trên mạng xã hội", (), ("sam",), (),
     "brand_negative"),
]
NEUTRAL = [
    ("Sâm Sâm ra mắt hộp quà Tết", ("sam",), ()),
    ("Doanh nghiệp thu hồi vốn đầu tư sau 3 năm", ("gioi_tre",), ()),
    ("Săm lốp xe bị thu hồi vì lỗi kỹ thuật", ("gioi_tre",), ()),
    ("Samsung bị phạt tại châu Âu", ("gioi_tre",), ()),
    ("Thực phẩm bảo vệ sức khỏe được ưa chuộng dịp cuối năm",
     ("tpbvsk",), ()),
    ("Trimico khai trương cửa hàng mới ở Đà Nẵng", ("doi_thu",), ()),
    ("Người trẻ chuộng trà sữa ít đường", ("gioi_tre",), ()),
    # luật regulation cần chủ đề tpbvsk|quang_cao hoặc cờ ruou — từ khóa
    # regulation đứng một mình KHÔNG báo đỏ (khóa điều kiện chống báo nhầm)
    ("Nghị định mới về thuế xăng dầu", ("gioi_tre",), ()),
    ("Dự thảo thông tư về giao thông", ("sam",), ()),
    ("Sâm Ngọc Linh giá bao nhiêu một ký", ("sam",), ()),
]


@pytest.mark.parametrize("case", POSITIVE)
def test_match_positive(case):
    title, snip, topics, flags, rule, *src = case
    got = ia.match({"title": title, "snippet": " ".join(snip),
                    "topics": list(topics), "flags": list(flags),
                    "source": src[0] if src else "fx71-a"},
                   ia.load_rules())
    assert rule in got, got


@pytest.mark.parametrize("title,topics,flags", NEUTRAL)
def test_match_neutral(title, topics, flags):
    assert ia.match({"title": title, "snippet": "", "topics": list(topics),
                     "flags": list(flags)}, ia.load_rules()) == []


def test_match_rules_cover_all_four():
    # tên giữ để lịch sử test ổn định; đợt hợp đồng thêm luật counterfeit -> 5
    assert {p[4] for p in POSITIVE} == set(ia.RULES)
    assert len(ia.RULES) == 5
    assert len(POSITIVE) >= 6 and len(NEUTRAL) >= 6


# ---------------------------------------------------------------- DB: schema


def test_schema_acks_unique_append_only_and_roles(db):
    aid = _one(db, "insert into red_alerts (source_agent, title) values"
                   " ('intel_red_alert', 'đỏ') returning id")
    # Owner ghi acked_at lùi giờ → trigger ép now().
    db.execute("insert into red_alert_acks (alert_id, acked_by, acked_at)"
               " values (%s, 'Hoa', '2000-01-01')", (aid,))
    assert _one(db, "select acked_at = now() from red_alert_acks"
                    " where alert_id = %s", (aid,)) is True
    with pytest.raises(UniqueViolation), db.transaction():
        db.execute("insert into red_alert_acks (alert_id, acked_by) values"
                   " (%s, 'Mai')", (aid,))
    for sql in ("update red_alert_acks set acked_by = 'X'",
                "delete from red_alert_acks", "truncate red_alert_acks"):
        with pytest.raises(RaiseException), db.transaction():
            db.execute(sql)
    aid2 = _one(db, "insert into red_alerts (source_agent, title) values"
                    " ('intel_red_alert', 'đỏ 2') returning id")
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute(f"set local role {AH}")
        db.execute("insert into red_alert_acks (alert_id, acked_by,"
                   " acked_at) values (%s, 'Hoa', now())", (aid2,))
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute(f"set local role {AW}")
        db.execute("insert into red_alert_acks (alert_id, acked_by)"
                   " values (%s, 'agent:intel')", (aid2,))
    with db.transaction():
        db.execute(f"set local role {AH}")
        db.execute("insert into red_alert_acks (alert_id, acked_by, note)"
                   " values (%s, 'Hoa', 'đã gọi Pháp chế')", (aid2,))
        assert _one(db, "select acked_at is not null from red_alert_acks"
                        " where alert_id = %s", (aid2,)) is True
        db.execute("reset role")
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute(f"set local role {AH}")
        db.execute("update red_alert_acks set note = 'x'")


def test_schema_red_alerts_dedup_index(db):
    ins = ("insert into red_alerts (source_agent, title, detail) values"
           " (%s, 'đỏ', %s)")
    db.execute(ins, ("intel_red_alert", Jsonb({"intel_item_id": 7})))
    with pytest.raises(UniqueViolation), db.transaction():
        db.execute(ins, ("intel_red_alert", Jsonb({"intel_item_id": 7})))
    db.execute(ins, ("agent:khac", Jsonb({"intel_item_id": 7})))  # khác nguồn
    db.execute(ins, ("intel_red_alert", Jsonb({"escalation_of": 1})))
    with pytest.raises(UniqueViolation), db.transaction():
        db.execute(ins, ("intel_red_alert", Jsonb({"escalation_of": 1})))


# ---------------------------------------------------------------- DB: luồng


def test_scan_escalate_gate_missing_recipients(db, capsys):
    tx = _TxConn(db)
    iid = _item(db, RECALL)
    _item(db, "Sâm Sâm ra mắt hộp quà Tết")          # trung tính
    now = _now(db)
    s = ia.scan(tx, now)                              # routing thật = []
    assert s["alerts"] == 1 and s["unrouted"] == 1 and s["scanned"] == 2
    rows = _alerts(db)
    assert len(rows) == 1
    aid, title, detail, rcp, err = rows[0]
    assert detail["intel_item_id"] == iid and detail["rules"] == [
        "brand_negative"]
    assert title.startswith(ia.ALERT_PREFIX) and RECALL in title
    assert rcp == [] and err == red_alert.MISSING
    assert "[RED-ALERT][warn]" in capsys.readouterr().err
    assert s["ids"] == [aid]
    assert ia.scan(tx, now)["alerts"] == 0             # chạy lại: 0 dòng mới
    ts = _one(db, "select ts from red_alerts where id = %s", (aid,))
    assert ia.escalate(tx, ts + timedelta(hours=1, minutes=30))[
        "escalated"] == 0
    e = ia.escalate(tx, ts + timedelta(hours=2, minutes=1))
    assert e["escalated"] == 1 and e["ids"] == [aid]
    esc = _alerts(db, "detail ? 'escalation_of'")
    assert len(esc) == 1
    assert esc[0][2]["escalation_of"] == aid
    assert "CHƯA XÁC NHẬN" in esc[0][1] and esc[0][4] == red_alert.MISSING
    assert ia.escalate(tx, ts + timedelta(hours=5))["escalated"] == 0
    assert ia.scan(tx, now)["alerts"] == 0   # bản leo thang không bị quét lại
    op = ia.open_alerts(tx, ts + timedelta(hours=3))
    assert [(d["id"], d["escalated"], d["age_h"]) for d in op] == [
        (aid, True, 3.0)]
    # Agent action log có dòng red_alert_raise (2: gốc + leo thang).
    assert _one(db, "select count(*) from agent_action_log where action ="
                    " 'red_alert_raise'") == 2


def test_ack_blocks_escalation(db):
    tx = _TxConn(db)
    _item(db, RECALL)
    ia.scan(tx, _now(db))
    aid, *_ = _alerts(db)[0]
    ts = _one(db, "select ts from red_alerts where id = %s", (aid,))
    ok, msg = ia.ack(tx, aid, "  Nguoi Xac Nhan Gia Lap  ", "đã báo Pháp chế")
    assert ok is True and f"#{aid}" in msg
    assert db.execute("select acked_by, note from red_alert_acks").fetchall(
    ) == [("Nguoi Xac Nhan Gia Lap", "đã báo Pháp chế")]
    assert ia.escalate(tx, ts + timedelta(hours=3))["escalated"] == 0
    assert ia.open_alerts(tx, ts + timedelta(hours=3)) == []
    ok, msg = ia.ack(tx, aid, "Mai")
    assert ok is False and "đã được xác nhận" in msg


def test_ack_rejects_bad_input(db):
    tx = _TxConn(db)
    _item(db, RECALL)
    ia.scan(tx, _now(db))
    aid, *_ = _alerts(db)[0]
    ts = _one(db, "select ts from red_alerts where id = %s", (aid,))
    ia.escalate(tx, ts + timedelta(hours=2, minutes=1))
    esc_id = _alerts(db, "detail ? 'escalation_of'")[0][0]
    other = _one(db, "insert into red_alerts (source_agent, title) values"
                     " ('agent:khac', 'đỏ') returning id")
    cases = [((aid, ""), "thiếu tên"), ((aid, "   "), "thiếu tên"),
             ((aid, "x" * 101), "dài quá"), (("abc", "Hoa"), "không hợp lệ"),
             ((10 ** 9, "Hoa"), "không tìm thấy"),
             ((2 ** 63, "Hoa"), "không hợp lệ"), ((-1, "Hoa"), "không hợp lệ"),
             ((0, "Hoa"), "không hợp lệ"),
             ((esc_id, "Hoa"), f"xác nhận id gốc #{aid}"),
             ((other, "Hoa"), "không thuộc")]
    for (i, by), want in cases:
        ok, msg = ia.ack(tx, i, by)
        assert ok is False and want in msg, (i, by, msg)
    assert _one(db, "select count(*) from red_alert_acks") == 0


def test_routing_valid_and_excluded(db):
    tx = _TxConn(db)
    _item(db, RECALL)
    _item(db, "Cảnh báo hàng giả mạo sâm Ngọc Linh bán trên mạng")
    now = _now(db)
    # v13.7 (flip có chủ đích): `unrouted` = CHƯA thông báo được — routing
    # hợp lệ nhưng chưa gửi được (kênh "email" thiếu địa chỉ/SMTP) vẫn đếm.
    sent = []
    rcp = {**GOOD_RCP, "channel": "email:pc@vi-du.test"}
    s = ia.scan(tx, now, routing={"recipients": [rcp]},
                sender=lambda to, subj, body: sent.append(to))
    assert s["alerts"] == 2 and s["unrouted"] == 0
    assert sent == ["pc@vi-du.test"] * 2
    assert {(tuple(r[3]), r[4]) for r in _alerts(db)} == {
        ((GOOD_RCP["name"],), None)}
    # tgd/ha_tang trong routing truyền tay vẫn bị lọc (fail-closed v4.0).
    _item(db, "Ngộ độc sau khi dùng sản phẩm Sâm Sâm không rõ nguồn gốc")
    bad = {"excluded_roles": [], "recipients": [
        {**GOOD_RCP, "role": "tgd"}, {**GOOD_RCP, "role": "ha_tang"}]}
    s = ia.scan(tx, now, routing=bad, sender=lambda *a: sent.append(a))
    assert s["alerts"] == 1 and s["unrouted"] == 1 and len(sent) == 2
    assert _alerts(db)[-1][3:] == ([], red_alert.MISSING)


def test_scan_lookback_and_race_dup(db, monkeypatch):
    tx = _TxConn(db)
    old = _item(db, RECALL)
    db.execute("update intel_items set fetched_at = now() - interval"
               " '49 hours' where id = %s", (old,))
    assert ia.scan(tx, _now(db))["alerts"] == 0      # ngoài lookback 48h
    _item(db, "Cảnh báo hàng giả mạo sâm Ngọc Linh bán trên mạng")
    real = red_alert.raise_alert

    def race(conn, *a, **kw):   # tiến trình khác chèn trước 1 nhịp
        real(conn, *a, **kw)
        return real(conn, *a, **kw)
    monkeypatch.setattr(red_alert, "raise_alert", race)
    s = ia.scan(tx, _now(db))
    assert s["dup"] == 1 and s["alerts"] == 0
    assert len(_alerts(db)) == 1


# ---------------------------------------------------------------- CLI


@contextmanager
def _fake_job(name, seen):
    run = {"ok": True, "detail": None}
    yield run
    seen.append((name, run["ok"], run["detail"]))


def _cli(monkeypatch, conn):
    calls, seen = [], []

    def fake_connect():
        calls.append(1)
        return conn
    monkeypatch.setattr(ia, "connect", fake_connect)
    monkeypatch.setattr(ia, "job_run", lambda n: _fake_job(n, seen))
    return calls, seen


def _rc(argv):
    try:
        return ia.main(argv)
    except SystemExit as e:
        return e.code


@pytest.mark.parametrize("argv", [
    [], ["--run", "--open"], ["--run", "--ack", "1", "--by", "Hoa"],
    ["--ack", "1"], ["--ack", "x", "--by", "Hoa"], ["--run", "--by", "Hoa"],
    ["--open", "--note", "x"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls, _ = _cli(monkeypatch, None)
    assert _rc(argv) == 2 and calls == []


def test_cli_bad_rules_exit1_before_connect(monkeypatch, tmp_path, capsys):
    calls, _ = _cli(monkeypatch, None)
    p = tmp_path / "r.json"
    p.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(ia, "RULES_FILE", p)
    assert ia.main(["--run"]) == 1 and calls == []
    assert "luật cảnh báo hỏng" in capsys.readouterr().out


def test_cli_db_down_exit1(monkeypatch, capsys):
    calls, _ = _cli(monkeypatch, None)
    assert ia.main(["--open"]) == 1 and calls == [1]
    assert "không kết nối được" in capsys.readouterr().out


def test_cli_run_missing_recipients_exit1_then_ack(db, monkeypatch, capsys):
    _item(db, RECALL)
    _, seen = _cli(monkeypatch, _TxConn(db))
    assert ia.main(["--run"]) == 1
    out = capsys.readouterr().out
    assert "[RED-ALERT][warn]" in out and "alerts=1" in out
    assert "GIẢ ĐỊNH" in out
    assert seen == [("pipelines.intel_alert", False, seen[0][2])]
    assert "alerts=1" in seen[0][2] and "unrouted=1" in seen[0][2]
    assert ia.main(["--run"]) == 0                   # không có gì mới
    assert ia.main(["--open"]) == 0
    aid = _alerts(db)[0][0]
    assert f"#{aid}" in capsys.readouterr().out
    assert ia.main(["--ack", str(aid), "--by", "Nguoi Gia Lap"]) == 0
    assert ia.main(["--ack", str(aid), "--by", "Nguoi Gia Lap"]) == 1
    assert ia.main(["--open"]) == 0
    assert "không có cảnh báo" in capsys.readouterr().out


def test_cli_missing_table_exit1(db, monkeypatch, capsys):
    db.execute("drop table red_alert_acks")
    _cli(monkeypatch, _TxConn(db))
    assert ia.main(["--open"]) == 1
    assert "apply_schema" in capsys.readouterr().out


# ---------------------------------------------------------------- cách ly


_FORBIDDEN = re.compile(r"content_drafts|pipelines\.store|pipelines\.content"
                        r"|save_draft|connectors\.|smtplib|httpx")
_WRITE_RE = re.compile(r"(?:insert into|update|delete from) +([a-z_]+)",
                       re.IGNORECASE)


def isolation_problems(src: str) -> list[str]:
    """Dùng chung với test_intel_bulletin — rỗng = cách ly đạt."""
    probs = [f"cấm: {m}" for m in _FORBIDDEN.findall(src)]
    probs += [f"ghi bảng lạ: {t}" for t in _WRITE_RE.findall(src)
              if t != "red_alert_acks"]
    mods = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            mods |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            mods.add(node.module)
            mods |= {f"{node.module}.{a.name}" for a in node.names}
    probs += [f"import cấm: {m}" for m in sorted(
        mods & {"pipelines.store", "pipelines.content", "connectors.zalo"})]
    return probs


def test_module_no_network_no_send():
    assert not re.search(r"httpx|smtplib|requests|connectors|openai", SRC)
    assert isolation_problems(SRC) == []
    # v13.7: ghi xác nhận chuyển sang đường CHUNG `red_alert.ack` (mọi cảnh
    # báo đỏ) — module intel không còn câu INSERT nào; gửi SMTP chỉ nằm ở
    # pipelines.red_alert (người nhận độc lập), không ở đây.
    assert _WRITE_RE.findall(SRC) == []
    assert "red_alert.ack(" in SRC
    assert "Fetcher" not in SRC


def test_isolation_grep_catches_mutant():
    mutant = SRC + '\n_X = "insert into content_drafts (text) values (1)"\n'
    probs = isolation_problems(mutant)
    assert any("content_drafts" in p for p in probs)
    assert isolation_problems(SRC + "\nimport pipelines.store\n")


def test_neutral_regulation_cases_hit_regulation_group():
    """Ca trung tính 'nghị định/thông tư' phải THỰC SỰ chạm nhóm regulation —
    nếu không, test_match_neutral không khóa được điều kiện chủ đề (mutant
    `if "regulation" in hit:` vẫn xanh)."""
    from crawler.intel import classify
    groups = ia.load_rules()["groups"]
    regs = [t for t, _, _ in NEUTRAL
            if "regulation" in classify(t, "", groups)[0]]
    assert len(regs) >= 2, regs


def test_sop_alert_run_scheduled_24_7():
    """Leo thang 2h chỉ chạy trong `--run` — SOP phải lịch `intel_alert --run`
    24/7, không gói vào khung crawl 07–22h (cảnh báo sau ~20:00 trễ tới
    sáng hôm sau, vỡ WP09)."""
    sop = (ROOT / "docs" / "handover" / "sop.md").read_text(encoding="utf-8")
    sop = " ".join(sop.split())
    assert "`pipelines.intel_alert --run` mỗi 30 phút SUỐT 24/7" in sop
    assert "rồi `pipelines.intel_alert --run` mỗi 60 phút" not in sop
