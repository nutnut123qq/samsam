"""v8.1 W81.1–W81.2 — sổ quyết định TGĐ `decision_log` (append-only, NGƯỜI
ghi `--by`) + `agents.ceo_decisions` (đề xuất chỉ đọc, ghi/theo dõi, liên
kết mốc trễ phòng Dự án).

Schema: DB thật (schema tạm + `docs/schema.sql` + `docs/roles.sql` ×2 →
ROLLBACK), case lỗi trong savepoint. CLI: `connect` monkeypatch → conn của
tx fixture (`TxConn`); case agent/usage kiểm `connect` 0 lần gọi. Tên người
trong test là giả lập — `decision_log` ship RỖNG (quyết định thật của TGĐ là
external-dep).
"""

import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from psycopg.errors import (
    CheckViolation,
    InsufficientPrivilege,
    RaiseException,
    UniqueViolation,
)

from agents import ceo_decisions as cd
from agents import da_pmo
from pipelines import approval_queue as aq
from pipelines import director
from pipelines.period import VN_TZ
from scripts import dpia_draft
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def db():
    yield from ceo_db()


SRC = (ROOT / "agents" / "ceo_decisions.py").read_text(encoding="utf-8")
TGD, THU_KY = "TGĐ Giả Lập", "Thư Ký Giả Lập"
INS = ("insert into decision_log (entry_kind, parent_id, decided_on, topic,"
       " decision, decided_by, basis_kind, basis_id, due_date, follow_status,"
       " note, recorded_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
       " %s, %s) returning id")


def _row(**kw) -> tuple:
    r = {"entry_kind": "quyet_dinh", "parent_id": None,
         "decided_on": date(2026, 10, 1), "topic": "Chủ đề",
         "decision": "Đồng ý", "decided_by": TGD,
         "basis_kind": "approval_queue", "basis_id": 42, "due_date": None,
         "follow_status": "mo", "note": None, "recorded_by": THU_KY} | kw
    return tuple(r.values())


def _bad(db, exc, sql, params=None, role=None) -> str:
    with pytest.raises(exc) as e, db.transaction():
        if role:
            db.execute(f"set local role {role}")
        db.execute(sql, params)
    return str(e.value)


def _n(db) -> int:
    return db.execute("select count(*) from decision_log").fetchone()[0]


# ---------------------------------------------------------------- W81.1
def test_schema_append_only_and_checks(db):
    did = db.execute(INS, _row()).fetchone()[0]
    now = db.execute("select now()").fetchone()[0]
    # recorded_at/db_role client gửi bị ghi đè bởi trigger
    rid = db.execute(
        "insert into decision_log (entry_kind, decided_on, topic, decision,"
        " decided_by, basis_kind, note, recorded_by, recorded_at, db_role)"
        " values ('quyet_dinh', '2026-10-01', 'x', 'y', %s, 'van_ban',"
        " 'Biên bản họp số 12', %s, '2000-01-01', 'gia_mao') returning id",
        (TGD, THU_KY)).fetchone()[0]
    ts, role = db.execute("select recorded_at, db_role from decision_log"
                          " where id = %s", (rid,)).fetchone()
    assert ts == now and role != "gia_mao"
    for sql in (f"update decision_log set topic = 'z' where id = {did}",
                f"delete from decision_log where id = {did}",
                "truncate decision_log"):
        assert "append-only" in _bad(db, RaiseException, sql)
    _bad(db, CheckViolation, INS, _row(decided_by="agent:ceo", basis_id=1))
    _bad(db, CheckViolation, INS, _row(recorded_by="  System: x",
                                       basis_id=2))
    _bad(db, CheckViolation, INS, _row(topic=None, basis_id=3))
    _bad(db, CheckViolation, INS, _row(basis_kind=None, basis_id=None))
    upd = {"decided_on": None, "topic": None, "decision": None,
           "decided_by": None, "basis_kind": None, "basis_id": None}
    # trigger BEFORE INSERT chạy trước CHECK → không parent = RaiseException
    assert "phải trỏ parent_id" in _bad(db, RaiseException, INS,
                                        _row(entry_kind="cap_nhat", **upd))
    cid = db.execute(INS, _row(entry_kind="cap_nhat", parent_id=did,
                               follow_status="dang_lam", **upd)).fetchone()[0]
    assert "phải trỏ parent_id" in _bad(
        db, RaiseException, INS,
        _row(entry_kind="cap_nhat", parent_id=cid, **upd))
    _bad(db, CheckViolation, INS, _row(entry_kind="cap_nhat", parent_id=did,
                                       follow_status="xong", **upd))
    db.execute(INS, _row(entry_kind="cap_nhat", parent_id=did,
                         follow_status="xong", note="Biên bản nghiệm thu",
                         **upd))
    _bad(db, CheckViolation, INS, _row(due_date=date(2026, 9, 30),
                                       basis_id=4))
    _bad(db, CheckViolation, INS, _row(basis_kind="van_ban", basis_id=None,
                                       note="ngắn"))
    _bad(db, CheckViolation, INS, _row(basis_kind="decisions",
                                       basis_id=None))
    _bad(db, UniqueViolation, INS, _row())          # cùng approval_queue:42
    db.execute(INS, _row(basis_kind="approvals"))   # khác loại căn cứ: được
    _bad(db, InsufficientPrivilege, INS, _row(basis_id=5),
         role="agent_writer")
    _bad(db, InsufficientPrivilege, "select count(*) from decision_log",
         role="app_human")


def test_schema_block_no_alter_drop():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("v8.1 Sổ quyết định TGĐ"):]
    assert not re.search(r"alter table|drop table", block, re.IGNORECASE)
    assert "append_only_guard()" in block


# ---------------------------------------------------------------- thuần
def test_current_status_and_chains():
    rows = [{"id": 1, "entry_kind": "quyet_dinh", "parent_id": None,
             "follow_status": "mo"},
            {"id": 3, "entry_kind": "cap_nhat", "parent_id": 1,
             "follow_status": "xong"},
            {"id": 2, "entry_kind": "cap_nhat", "parent_id": 1,
             "follow_status": "dang_lam"},
            {"id": 4, "entry_kind": "quyet_dinh", "parent_id": None,
             "follow_status": "mo"}]
    assert cd.current_status(rows[:3]) == "xong"
    assert cd.current_status([]) is None
    assert [(c["id"], c["status"]) for c in cd.chains(rows)] == \
        [(1, "xong"), (4, "mo")]


def test_overdue_vn_day_boundary():
    now = datetime(2026, 10, 19, 17, 30, tzinfo=timezone.utc)
    assert now.date() == date(2026, 10, 19)          # UTC còn 19/10
    today = now.astimezone(VN_TZ).date()
    assert today == date(2026, 10, 20)               # giờ VN đã 20/10
    y, t = date(2026, 10, 19), date(2026, 10, 20)
    ds = [{"id": 1, "due_date": y, "status": "dang_lam"},
          {"id": 2, "due_date": y, "status": "xong"},
          {"id": 3, "due_date": t, "status": "mo"},
          {"id": 4, "due_date": None, "status": "mo"},
          {"id": 5, "due_date": y, "status": "huy"}]
    assert [d["id"] for d in cd.overdue(ds, today)] == [1]


MS = [{"code": "XNQC-NOP", "title": "Nộp hồ sơ XNQC đợt 2", "wp": "WP05",
       "owner_role": "phap_che", "due_date": date(2026, 10, 15),
       "gate": "biên nhận", "evidence": None, "status": "dang_lam"},
      {"code": "A-XONG", "title": "Việc xong", "wp": None,
       "owner_role": "ha_tang", "due_date": date(2026, 10, 1),
       "gate": "g", "evidence": "link", "status": "xong"},
      {"code": "B-DUNG", "title": "Việc tạm dừng", "wp": None,
       "owner_role": "du_an", "due_date": date(2026, 10, 2),
       "gate": "g", "evidence": None, "status": "tam_dung"},
      {"code": "C-SAU", "title": "Việc sau", "wp": None,
       "owner_role": "du_an", "due_date": date(2026, 10, 30),
       "gate": "g", "evidence": None, "status": "chua_bat_dau"},
      {"code": "D-HOMNAY", "title": "Hạn hôm nay", "wp": None,
       "owner_role": "du_an", "due_date": date(2026, 10, 20),
       "gate": "g", "evidence": None, "status": "dang_lam"}]


def test_late_milestones_parity_with_da_pmo_board():
    today = date(2026, 10, 20)
    board = da_pmo.render_board(MS, today)
    part = board.split("## Mốc trễ")[1].split("## Nhắc hạn")[0]
    want = set(re.findall(r"\*\*TRỄ\*\* (\S+) —", part))
    got = cd.late_milestones(MS, today)
    assert {r["code"] for r in got} == want == {"XNQC-NOP", "B-DUNG"}
    sec = "\n".join(cd.render_section({"decisions": [], "milestones": MS},
                                      today))
    assert ("- **TRỄ** XNQC-NOP — hạn 15/10/2026 (trễ 5 ngày, owner "
            "phap_che, dang_lam)") in sec
    assert "A-XONG" not in sec and "D-HOMNAY" not in sec


def test_render_section_counts_and_caps():
    today = date(2026, 10, 20)
    rec = datetime(2026, 10, 18, 9, tzinfo=VN_TZ)
    old = datetime(2026, 10, 1, 9, tzinfo=VN_TZ)
    dec = [{"id": i, "topic": f"Chủ đề {i}", "decided_by": TGD,
            "due_date": date(2026, 10, 10), "status": "dang_lam",
            "recorded_at": rec if i % 2 else old} for i in range(1, 8)]
    dec.append({"id": 9, "topic": "Đã xong", "decided_by": TGD,
                "due_date": date(2026, 10, 10), "status": "xong",
                "recorded_at": rec})
    ms = [dict(MS[0], code=f"M{i}") for i in range(7)]
    sec = cd.render_section({"decisions": dec, "milestones": ms}, today)
    text = "\n".join(sec)
    assert sec[0] == "## Tiến độ & Sổ quyết định"
    assert ("Quyết định đang theo dõi (mở/đang làm): 7 · quá hạn thực hiện:"
            " 7 · ghi trong 7 ngày: 5") in text
    shown = [ln for ln in sec if ln.startswith("- #")]
    assert [ln.split()[1] for ln in shown] == ["#7", "#6", "#5", "#4", "#3"]
    assert "- …và 2 quyết định khác" in text
    assert "- …và 2 mốc khác" in text
    assert "trễ 10 ngày" in text and "hạn 10/10/2026" in text
    empty = "\n".join(cd.render_section({"decisions": [], "milestones": []},
                                        today))
    assert empty.count("- (không có)") == 2


# ---------------------------------------------------------------- CLI âm
def _no_connect():
    raise AssertionError("connect không được gọi")


REC = ["--record", "--topic", "Chủ đề", "--decision", "Đồng ý",
       "--basis", "approval_queue:1"]


@pytest.mark.parametrize("argv", [
    REC + ["--by", "agent:ceo"], REC + ["--by", " SYSTEM:cron"],
    REC + ["--by", THU_KY, "--decided-by", "agent:x"], REC + ["--by", ""],
    REC + ["--by", "Thư\x1bký"], REC,
    ["--follow", "1", "--status", "dang_lam", "--by", "agent:ceo"],
    ["--follow", "1", "--status", "xong", "--by", THU_KY],
    ["--propose", "--list"], [], ["--record", "--list"],
    REC + ["--by", THU_KY, "--date", "2026-13-01"],
    REC + ["--by", THU_KY, "--due", "30/10/2026"],
    REC[:-1] + ["approvals:abc", "--by", THU_KY],
    ["--record", "--topic", "x", "--decision", "y", "--by", THU_KY,
     "--note", "ngắn", "--decided-by", TGD],
    ["--record", "--topic", "x", "--decision", "y", "--by", THU_KY,
     "--note", "Biên bản họp số 12"],
    ["--record", "--topic", "x" * 201, "--decision", "y", "--by", THU_KY],
    REC + ["--by", THU_KY, "--now", "2026-10-12T09:00"],
    ["--list", "--topic", "x"], ["--list", "--days", "5"],
    ["--propose", "--days", "0"], ["--list", "--now", "12/10/2026"],
    ["--follow", "1", "--by", THU_KY],
], ids=lambda a: " ".join(a)[:60])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(cd, "connect", _no_connect)
    with pytest.raises(SystemExit) as e:
        cd.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(cd, "connect", lambda: None)
    assert cd.main(["--list"]) == 2
    assert "không kết nối" in capsys.readouterr().err


def test_cli_dead_host_subprocess():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "agents.ceo_decisions",
                        "--propose"], cwd=ROOT, env=env, capture_output=True,
                       timeout=60, encoding="utf-8", errors="replace",
                       check=False)
    assert r.returncode == 2 and "không kết nối" in r.stderr


def test_grep_only_insert_decision_log_no_egress():
    hits = re.findall(r"(insert into \w+|update |delete from)", SRC)
    assert hits and set(hits) == {"insert into decision_log"}
    assert not re.search(
        r"import (httpx|requests|socket|smtplib|openai)|from (httpx|requests"
        r"|smtplib|urllib\.request|http\.client|openai)|urllib\.request|"
        r"email\.mime|webbrowser|llm_gateway", SRC)
    assert "agents/ceo_decisions.py" not in dpia_draft.egress_modules(ROOT)


# ---------------------------------------------------------------- DB E2E
def _ceo_item(tx, oid, decision=None):
    qid = director.submit(tx, "ceo", "decision_record", oid,
                          f"Quyết định {oid}", f"Nội dung {oid}",
                          "agent:ceo_report")
    if decision:
        assert aq.decide(tx, qid, TGD, decision) == (True, None)
    return qid


@pytest.fixture
def ceo(db, monkeypatch):
    tx = TxConn(db)
    q1 = _ceo_item(tx, "qd-1", "approved")
    q2 = _ceo_item(tx, "qd-2", "rejected")
    q3 = _ceo_item(tx, "qd-3")
    dbnow = db.execute("select now()").fetchone()[0]
    now = dbnow.astimezone(VN_TZ) + timedelta(minutes=1)
    monkeypatch.setattr(cd, "connect", lambda: tx)
    monkeypatch.setattr(cd, "_now", lambda: now)
    return {"tx": tx, "q": (q1, q2, q3), "now": now,
            "today": now.date()}


def test_propose_record_follow_e2e(db, ceo, capsys):
    q1, q2, q3 = ceo["q"]
    today = ceo["today"]
    due = (today + timedelta(days=18)).isoformat()
    assert cd.main(["--record", "--basis", f"approval_queue:{q1}",
                    "--topic", "Duyệt báo cáo tuần", "--decision",
                    "Đồng ý phương án", "--by", THU_KY, "--due", due]) == 0
    row = db.execute("select decided_by, decided_on, recorded_by,"
                     " follow_status, basis_kind, basis_id from decision_log"
                     ).fetchone()
    assert row == (TGD, today, THU_KY, "mo", "approval_queue", q1)
    capsys.readouterr()
    n0 = _n(db)
    iso = ceo["now"].isoformat()
    assert cd.main(["--propose", "--now", iso]) == 0
    out = capsys.readouterr().out
    assert _n(db) == n0
    assert f"approval_queue #{q2} " in out
    assert f"#{q1} " not in out and f"#{q3} " not in out
    assert "[đề xuất] 1 mục" in out
    assert [p["id"] for p in cd.propose(ceo["tx"], ceo["now"], 30)] == [q2]
    # ngoài cửa sổ --days: không đề xuất
    assert cd.propose(ceo["tx"], ceo["now"] + timedelta(days=31), 30) == []
    # trùng căn cứ → 1
    assert cd.main(["--record", "--basis", f"approval_queue:{q1}",
                    "--topic", "Lần hai", "--decision", "x", "--by",
                    THU_KY]) == 1
    assert "đã ghi (#" in capsys.readouterr().err and _n(db) == n0
    # căn cứ pending / không tồn tại → 1
    for b in (f"approval_queue:{q3}", "approval_queue:999999",
              "approvals:999999", "decisions:999999"):
        assert cd.main(["--record", "--basis", b, "--topic", "x",
                        "--decision", "y", "--by", THU_KY]) == 1, b
    # --decided-by khác người đã duyệt → 1
    assert cd.main(["--record", "--basis", f"approval_queue:{q2}",
                    "--topic", "x", "--decision", "y", "--by", THU_KY,
                    "--decided-by", "Người Khác"]) == 1
    # topic có từ cấm → 1, 0 dòng
    assert cd.main(["--record", "--basis", f"approval_queue:{q2}",
                    "--topic", "Sâm chữa bệnh", "--decision", "y", "--by",
                    THU_KY]) == 1
    assert "guardrail" in capsys.readouterr().err and _n(db) == n0
    # ngày tương lai → 1; hạn trước ngày quyết → 1
    tomorrow = (today + timedelta(days=1)).isoformat()
    assert cd.main(["--record", "--basis", f"approval_queue:{q2}",
                    "--topic", "x", "--decision", "y", "--by", THU_KY,
                    "--date", tomorrow]) == 1
    assert cd.main(["--record", "--basis", f"approval_queue:{q2}",
                    "--topic", "x", "--decision", "y", "--by", THU_KY,
                    "--due", (today - timedelta(days=1)).isoformat()]) == 1
    assert _n(db) == n0
    # SĐT trong topic → lưu bản đã che; --decided-by cùng người (khác hoa
    # thường/khoảng trắng) được
    assert cd.main(["--record", "--basis", f"approval_queue:{q2}",
                    "--topic", "Họp với đối tác 0905 123 456", "--decision",
                    "Từ chối", "--by", THU_KY, "--decided-by",
                    "  tgđ giả lập "]) == 0
    topic = db.execute("select topic from decision_log order by id desc"
                       " limit 1").fetchone()[0]
    assert "0905" not in topic and "123 456" not in topic and "***" in topic
    did = db.execute("select id from decision_log where basis_id = %s",
                     (q1,)).fetchone()[0]
    # follow: dang_lam → xong (note) → đã đóng
    assert cd.main(["--follow", str(did), "--status", "dang_lam", "--by",
                    THU_KY]) == 0
    assert cd.main(["--follow", str(did), "--status", "xong", "--by", THU_KY,
                    "--note", "Biên bản nghiệm thu số 7"]) == 0
    assert cd.main(["--follow", str(did), "--status", "huy", "--by",
                    THU_KY]) == 1
    assert "đã đóng (xong)" in capsys.readouterr().err
    assert cd.main(["--follow", "999999", "--status", "huy", "--by",
                    THU_KY]) == 1
    rows = [dict(zip(cd.COLS, r)) for r in db.execute(
        f"select {', '.join(cd.COLS)} from decision_log order by id")]
    st = {c["id"]: c["status"] for c in cd.chains(rows)}
    assert st[did] == "xong"
    # van_ban: cần decided-by + note ≥ 10
    assert cd.main(["--record", "--topic", "Chọn nhà cung cấp hộp quà",
                    "--decision", "Chọn phương án B", "--by", THU_KY,
                    "--decided-by", TGD, "--note",
                    "Biên bản họp HĐTV số 05/2026", "--date",
                    today.isoformat()]) == 0


def test_list_overdue_and_section(db, ceo, capsys):
    q1 = ceo["q"][0]
    today = ceo["today"]
    assert cd.main(["--record", "--basis", f"approval_queue:{q1}",
                    "--topic", "Triển khai quầy Tết", "--decision",
                    "Đồng ý", "--by", THU_KY, "--due",
                    today.isoformat()]) == 0
    db.execute("insert into project_milestones (code, title, owner_role,"
               " due_date, gate, status, source) values ('XNQC-NOP', 'Nộp"
               " hồ sơ', 'phap_che', %s, 'biên nhận', 'dang_lam', 'test')",
               (today - timedelta(days=5),))
    capsys.readouterr()
    nxt = (ceo["now"] + timedelta(days=1)).isoformat()
    assert cd.main(["--list", "--now", nxt]) == 0
    out = capsys.readouterr().out
    assert "QUÁ HẠN" in out and "TRỄ XNQC-NOP" in out and "trễ 6 ngày" in out
    assert cd.main(["--list", "--now", ceo["now"].isoformat()]) == 0
    assert "QUÁ HẠN" not in capsys.readouterr().out     # hạn = hôm nay
    sec = "\n".join(cd.section(ceo["tx"], today + timedelta(days=1)))
    assert "quá hạn thực hiện: 1" in sec and "Triển khai quầy Tết" in sec
    assert f"người quyết {TGD}" in sec
    assert "**TRỄ** XNQC-NOP" in sec and "owner phap_che" in sec


def test_decisions_expired_basis_rejected(db, ceo):
    """`decisions` kind expired (system:sla) không phải quyết định của
    người → từ chối ghi."""
    q3 = ceo["q"][2]
    did = db.execute("insert into decisions (kind, queue_id, decided_by,"
                     " reason) values ('expired', %s, 'system:sla',"
                     " 'hết hạn SLA không ai duyệt') returning id",
                     (q3,)).fetchone()[0]
    assert cd.main(["--record", "--basis", f"decisions:{did}", "--topic",
                    "x", "--decision", "y", "--by", THU_KY]) == 1
    assert _n(db) == 0


@pytest.mark.parametrize("topic", [
    "Xem https://evil.example/x", "Bấm [đây](javascript:alert)",
    "<img src=x onerror=alert(1)>", "Chủ đề `code`"])
def test_topic_markup_rejected(db, ceo, topic):
    """Chủ đề vào trang TGĐ (markdown) — cấm link/HTML (OWASP A03)."""
    assert cd.main(["--record", "--basis", f"approval_queue:{ceo['q'][1]}",
                    "--topic", topic, "--decision", "y", "--by",
                    THU_KY]) == 1
    assert _n(db) == 0


def test_decided_by_markup_rejected(db, ceo):
    """`--decided-by` (van_ban, chữ tự do) cũng vào trang TGĐ — cấm link."""
    assert cd.main(["--record", "--topic", "Chủ đề", "--decision", "y",
                    "--by", THU_KY, "--decided-by",
                    "[TGĐ](https://evil.example)", "--note",
                    "Biên bản họp HĐTV số 01"]) == 1
    assert _n(db) == 0
