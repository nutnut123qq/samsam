"""v13.7 (C07, F06) — vận hành an toàn theo PL02 mục 2–3.

Tái hiện phát hiện F06 (findings.json): (1) tuyến cảnh báo đỏ trống/không
gửi thật mà vẫn báo "đã định tuyến"; (2) chatbot không có hạn chót TỔNG 30
giây cho chuỗi chờ lock/rewrite/embed/chat/send; (3) không có sổ sự cố đo 15
phút/3 giờ/3 ngày làm việc/7 ngày; (4) lịch job chưa có bằng chứng scheduler
(khóa chống chạy chồng + job_runs); (5) KPI tháng mất đầu tháng khi convlog
xoay vòng 30 ngày; (6) bằng chứng "đã gửi trước ngày 05" không do người gửi
xác nhận. Mọi test FAIL trên code trước v13.7 (module/hàm chưa có hoặc hành
vi cũ). Không gọi mạng: SMTP/LLM/gửi tin đều giả, chờ theo sự kiện.
"""

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from api import rag
from connectors import channels, zalo
from pipelines import auth, job_runs
from pipelines import red_alert as ra
from pipelines.period import VN_TZ
from scripts import health_bulletin as hb
from scripts import ops_monthly as om
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
RCP = {"name": "Phap Che Gia Lap", "role": "phap_che",
       "channel": "email:pc@vi-du.test"}
SHIFT = {"start": "00:00", "end": "23:59", "workdays": [0, 1, 2, 3, 4],
         "holidays": []}


def _vn(*a) -> datetime:
    return datetime(*a, tzinfo=VN_TZ)


def _oi():
    from pipelines import ops_incidents  # module mới v13.7
    return ops_incidents


@pytest.fixture
def db():
    yield from ceo_db()


@pytest.fixture(autouse=True)
def _no_job_runs_db(monkeypatch):
    rec = []
    monkeypatch.setattr(job_runs, "_record", lambda *a: rec.append(a))
    return rec


# ============================================================ cảnh báo đỏ
class _Fake:
    def __init__(self):
        self.calls, self.commits = [], 0

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self

    def fetchone(self):
        return (7,)

    def transaction(self):
        from contextlib import nullcontext
        return nullcontext()

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


def test_routed_but_not_sent_is_not_notified(capsys):
    """F06: người nhận hợp lệ nhưng kênh chưa cấu hình → KHÔNG "đã thông
    báo" (code cũ trả True + "→ 1 người nhận")."""
    conn = _Fake()
    ok, msg = ra.raise_alert(conn, "agent:x", "Lô lỗi",
                             routing={"recipients": [RCP]}, sender=None)
    assert ok is False and ra.NOT_SENT in msg
    rows = [p for s, p in conn.calls if "red_alert_deliveries" in s]
    err = "kênh gửi chưa cấu hình (RED_ALERT_NOTIFY=email + SMTP_HOST)"
    assert rows == [(7, RCP["name"], "phap_che", "email", False, err)]
    assert "CHƯA thông báo" in capsys.readouterr().err


def test_delivery_rows_never_store_address_and_send_failure_counted():
    conn = _Fake()

    def boom(to, subj, body):
        raise OSError("smtp down pc@vi-du.test")
    ok, _ = ra.raise_alert(conn, "agent:x", "Gọi 0912 345 678 lô lỗi",
                           routing={"recipients": [RCP]}, sender=boom)
    assert ok is False
    params = [p for s, p in conn.calls if "red_alert_deliveries" in s]
    assert params[0][4] is False and params[0][5] == "gửi lỗi: OSError"
    assert "pc@vi-du.test" not in json.dumps(conn.calls, default=str)


def test_smtp_sender_env_gate_and_starttls(monkeypatch):
    assert ra.smtp_sender({}) is None
    assert ra.smtp_sender({"SMTP_HOST": "h"}) is None       # chưa bật kênh
    assert ra.smtp_sender({"RED_ALERT_NOTIFY": "email"}) is None
    seen = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            seen.update(host=host, port=port, timeout=timeout)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def starttls(self, context):
            seen["tls"] = context is not None

        def login(self, u, p):
            seen["login"] = u

        def send_message(self, msg):
            seen["to"], seen["subject"] = msg["To"], msg["Subject"]
    monkeypatch.setattr(ra.smtplib, "SMTP", FakeSMTP)
    send = ra.smtp_sender({"RED_ALERT_NOTIFY": "email", "SMTP_HOST": "smtp.x",
                           "SMTP_USER": "bot@x", "SMTP_PASSWORD": "p"})
    send("pc@vi-du.test", "s", "b")
    assert seen == {"host": "smtp.x", "port": 587, "timeout": 10,
                    "tls": True, "login": "bot@x", "to": "pc@vi-du.test",
                    "subject": "s"}


@pytest.mark.parametrize("channel,env,want", [
    ("email:pc@vi-du.test", {}, "pc@vi-du.test"),
    ("email:$RA_PC", {"RA_PC": "pc@vi-du.test"}, "pc@vi-du.test"),
    ("email:$RA_PC", {}, None),
    ("email", {}, None),
    ("zalo:123", {}, None),
    ("email:a@b@c", {}, None),
    ("email:a b@c", {}, None),
    ("email:a@b.vn,x@y.vn", {}, None),          # chèn thêm người nhận
    ("email:a@b.vn\r\nBcc: x@y", {}, None),     # chèn header
])
def test_resolve_address(channel, env, want):
    assert ra.resolve_address(channel, env) == want


def test_ack_generic_for_every_alert_source(db):
    """F06: `--ack` chung mọi cảnh báo đỏ (code cũ chỉ intel)."""
    tx = TxConn(db)
    ok, _ = ra.raise_alert(tx, "agents.sales_director", "SLA trễ",
                           routing={"recipients": []})
    aid = db.execute("select max(id) from red_alerts").fetchone()[0]
    esc = db.execute(
        "insert into red_alerts (source_agent, title, detail) values ('x',"
        " 't', %s::jsonb) returning id",
        (json.dumps({"escalation_of": aid}),)).fetchone()[0]
    for by in ("agent:bot", "system:cron", "  "):
        assert ra.ack(tx, aid, by)[0] is False
    assert ra.ack(tx, esc, "Người A")[0] is False          # bản leo thang
    assert ra.ack(tx, 10 ** 15, "Người A") == (
        False, f"không tìm thấy cảnh báo #{10 ** 15}")
    ok, msg = ra.ack(tx, aid, "Người A", note="gọi 0912 345 678")
    assert ok, msg
    assert ra.ack(tx, aid, "Người B")[1].endswith("đã được xác nhận trước đó")
    row = db.execute("select acked_by, note from red_alert_acks where"
                     " alert_id = %s", (aid,)).fetchone()
    assert row[0] == "Người A" and "0912" not in row[1]
    assert [d["id"] for d in ra.open_alerts(tx, datetime.now(timezone.utc))
            ] == []


def test_ack_enforced_mode_only_independent_recipients(db, monkeypatch):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    tx = TxConn(db)
    ra.raise_alert(tx, "agent:x", "Lô lỗi", routing={"recipients": []})
    aid = db.execute("select max(id) from red_alerts").fetchone()[0]
    routing = {"recipients": [RCP, {**RCP, "name": "TGD", "role": "tgd"}]}
    ok, msg = ra.ack(tx, aid, "TGD", routing=routing)
    assert ok is False and "chế độ thực" in msg
    assert ra.ack(tx, aid, "phap che gia lap", routing=routing)[0] is True


def test_deliver_pending_catches_up_caps_and_skips_acked(db):
    tx = TxConn(db)
    now = datetime.now(timezone.utc)
    ids = []
    for t in ("A", "B", "C"):
        ra.raise_alert(tx, "agent:x", f"Lô {t}", routing={"recipients": []})
        ids.append(db.execute("select max(id) from red_alerts").fetchone()[0])
    ra.ack(tx, ids[2], "Người A")
    # chưa có người nhận → không gửi được gì, đủ để CLI exit 1
    st = ra.deliver_pending(tx, now, routing={"recipients": []}, sender=None)
    assert st["failed"] == ids[:2] and st["sent"] == []
    # gửi lỗi tới khi chạm trần → `capped`
    for _ in range(ra.MAX_ATTEMPTS):
        ra.deliver_pending(tx, now, routing={"recipients": [RCP]},
                           sender=lambda *a: 1 / 0)
    st = ra.deliver_pending(tx, now, routing={"recipients": [RCP]},
                            sender=lambda *a: None)
    assert st["capped"] == ids[:2] and st["sent"] == []
    # cảnh báo mới (đã có người nhận) → gửi được, lần quét sau không gửi lại
    sent = []
    ra.raise_alert(tx, "agent:x", "Lô D", routing={"recipients": []})
    st = ra.deliver_pending(tx, now, routing={"recipients": [RCP]},
                           sender=lambda to, s, b: sent.append(to))
    assert len(st["sent"]) == 1 and sent == ["pc@vi-du.test"]
    st = ra.deliver_pending(tx, now, routing={"recipients": [RCP]},
                            sender=lambda to, s, b: sent.append(to))
    assert st["sent"] == [] and len(sent) == 1


def test_cli_deliver_exit_1_without_recipients(db, monkeypatch, capsys):
    import ingest.lead_store as ls
    monkeypatch.setattr(ls, "connect", lambda: TxConn(db))
    monkeypatch.setattr(ra, "ROUTING", ROOT / "data" / "red_alert_routing.json")
    ra.raise_alert(TxConn(db), "agent:x", "Lô lỗi",
                   routing={"recipients": []})
    assert ra.main(["--deliver"]) == 1
    assert "chưa gửi được" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        ra.main(["--ack", "1"])                                # thiếu --by


def test_ack_2h_includes_weekend_and_tet():
    """PL02 mục 3: 02 giờ ĐỒNG HỒ kể cả T7/CN/Tết (không tính giờ làm việc)."""
    sat = _vn(2026, 10, 17, 23, 0)                 # thứ Bảy
    tet = _vn(2027, 2, 6, 22, 30)                  # ngày Tết
    rows = [(1, sat, sat + timedelta(hours=1, minutes=59)),
            (2, sat, sat + timedelta(hours=2, minutes=1)),
            (3, tet, None)]
    k = om.kpi_alerts(rows, tet + timedelta(hours=2, minutes=1))
    assert (k["ok"], k["late"], k["unacked"]) == (1, 2, [3])


# ============================================================ chatbot 30 giây
class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _hit():
    return [{"title": "Saphraton", "url": "https://x/s", "content": "Giá 1",
             "score": 0.9, "doc_id": "d"}]


def test_rag_budget_passed_to_every_call_then_stops(monkeypatch):
    """Ngân sách TRUYỀN XUỐNG từng lời gọi (timeout client) và bước sau
    không bắt đầu khi đã hết hạn (đồng hồ giả — không wall-clock)."""
    clock = _Clock()
    monkeypatch.setattr(rag, "_clock", clock)
    seen = []

    def chat(agent, msgs, **kw):
        seen.append(("chat", kw.get("timeout")))
        clock.t += 5

        msg = type("M", (), {"content": "câu rewrite"})
        return type("R", (), {"choices": [type("C", (), {"message": msg})]})

    def embed(agent, q, **kw):
        seen.append(("embed", kw.get("timeout")))
        clock.t += 20                               # embed chậm
        return type("E", (), {"data": [type("D", (), {"embedding": [1.0]})]})
    monkeypatch.setattr(rag, "chat", chat)
    monkeypatch.setattr(rag, "embed", embed)
    monkeypatch.setattr(rag, "retrieve_by_vector", lambda *a, **k: _hit())
    hist = [{"role": "user", "content": "giá?"},
            {"role": "assistant", "content": "1"}]
    with pytest.raises(rag.DeadlineExceeded) as ei:
        rag.answer("còn loại khác?", hist, deadline=clock.t + 25)
    assert seen == [("chat", 25.0), ("embed", 20.0)]  # chat trả lời KHÔNG gọi
    assert ei.value.stage == "chat"


def test_rag_deadline_from_contextvar_and_client_timeout(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(rag, "_clock", clock)

    def embed(agent, q, **kw):
        from pipelines.llm_gateway import GatewayError
        try:
            raise TimeoutError("read timeout")
        except TimeoutError as e:
            raise GatewayError("LLM provider lỗi") from e
    monkeypatch.setattr(rag, "embed", embed)
    tok = rag.DEADLINE.set(clock.t + 25)
    try:
        with pytest.raises(rag.DeadlineExceeded) as ei:
            rag.answer("Saphraton giá bao nhiêu?")
    finally:
        rag.DEADLINE.reset(tok)
    assert ei.value.stage == "embed"
    # Không hạn chót → hành vi cũ (GatewayError lan ra như trước).
    from pipelines.llm_gateway import GatewayError
    with pytest.raises(GatewayError):
        rag.answer("Saphraton giá bao nhiêu?")


@pytest.fixture
def zfiles(monkeypatch, tmp_path):
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo.zalo_garden, "STAFF_FILE",
                        tmp_path / "garden_staff.json")
    monkeypatch.setattr(zalo.zalo_garden, "_staff", (None, {}))
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    zalo._histories.clear()
    handoffs = []
    monkeypatch.setattr(channels, "record_handoff",
                        lambda inb, reason, msg_id="": handoffs.append(reason))
    yield tmp_path, handoffs
    zalo._histories.clear()


def _log(tmp_path):
    return [json.loads(x) for x in (tmp_path / "conversations.jsonl")
            .read_text(encoding="utf-8").splitlines()]


def test_zalo_slow_answer_handoff_within_budget(zfiles, monkeypatch):
    """Câu trả lời treo (không chịu timeout) → khách nhận HANDOFF trong
    ngân sách, có mục người xử lý; kết quả về muộn bị bỏ (không gửi lần 2,
    không vào history). Chờ theo sự kiện — code cũ treo tới khi nhả."""
    tmp_path, handoffs = zfiles
    release, finished = threading.Event(), threading.Event()
    seen_deadline = []

    def slow(q, history=None):
        seen_deadline.append(rag.DEADLINE.get())
        release.wait(30)
        finished.set()
        return {"answer": "Giá 1.000.000 đ", "sources": ["https://x"]}
    monkeypatch.setattr("api.rag.answer", slow)
    monkeypatch.setattr(rag, "CHAT_BUDGET_S", 0.4)
    monkeypatch.setattr(rag, "SEND_RESERVE_S", 0.1)
    sent, out = [], {}
    th = threading.Thread(target=lambda: out.update(
        r=zalo.handle_text("u1", "Saphraton giá bao nhiêu?", "m1",
                           send=lambda u, t: sent.append(t) or True)))
    th.start()
    th.join(10)
    alive = th.is_alive()
    release.set()
    th.join(10)
    assert not alive, "không có hạn chót — chờ câu trả lời treo"
    assert out["r"]["text"] == zalo.HANDOFF_TEXT
    assert out["r"]["deadline"] == "tra_loi"
    assert handoffs == ["deadline"]
    assert finished.wait(10)
    assert sent == [zalo.HANDOFF_TEXT]                 # kết quả muộn bị bỏ
    assert not zalo._histories.get("u1")              # không vào history
    rec = _log(tmp_path)[-1]
    assert rec["answered"] is False and rec["error"] == "deadline:tra_loi"
    assert seen_deadline[0] is not None                # hạn chót tới answer()


def test_zalo_lock_wait_counts_toward_budget(zfiles, monkeypatch):
    tmp_path, handoffs = zfiles
    monkeypatch.setattr("api.rag.answer",
                        lambda q: pytest.fail("không được gọi answer()"))
    sent = []
    r = zalo._reply("u2", "Saphraton giá bao nhiêu?", "m2",
                    send=lambda u, t: sent.append(t) or True,
                    t_recv=time.monotonic() - 31)     # đã chờ lock 31 giây
    assert r["deadline"] == "cho_lock" and sent == [zalo.HANDOFF_TEXT]
    assert handoffs == ["deadline"]
    assert _log(tmp_path)[-1]["error"] == "deadline:cho_lock"


def test_zalo_fast_answer_unchanged(zfiles, monkeypatch):
    tmp_path, handoffs = zfiles
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "Giá 1.000.000 đ",
                                   "sources": ["https://x"]})
    sent = []
    r = zalo.handle_text("u3", "Saphraton giá bao nhiêu?", "m3",
                         send=lambda u, t: sent.append(t) or True)
    assert r["sent"] and "deadline" not in r and handoffs == []
    assert _log(tmp_path)[-1]["answered"] is True


def test_send_timeouts_fit_budget():
    src = (ROOT / "connectors" / "zalo.py").read_text(encoding="utf-8")
    msrc = (ROOT / "connectors" / "messenger.py").read_text(encoding="utf-8")
    assert zalo.SEND_TIMEOUT_S <= rag.SEND_RESERVE_S
    assert "timeout=SEND_TIMEOUT_S" in src
    assert "timeout=zalo.SEND_TIMEOUT_S" in msrc
    assert rag.CHAT_BUDGET_S == 30.0
    assert "deadline" in channels.HANDOFF_REASONS


# ============================================================ sổ sự cố
def test_incident_sla_rules_pure():
    oi = _oi()
    det = _vn(2026, 10, 16, 16, 0)                  # thứ Sáu
    incs = [
        (1, "t", "nghiem_trong", "kuma", "ben_a", det - timedelta(minutes=14),
         det),
        (2, "t", "nghiem_trong", "kuma", "ben_a", det - timedelta(minutes=16),
         det),
        (3, "t", "thuong", "khach", "ben_b", None, det),
        (4, "t", "thuong", "khach", "ben_b", None, det),
        (5, "t", "nghiem_trong", "agent", "ben_a", None, det),
    ]
    ev = [(1, "responded", det + timedelta(hours=2, minutes=59)),
          (1, "fixed", det + timedelta(days=7)),
          (2, "responded", det + timedelta(hours=3, minutes=1)),
          (2, "fixed", det + timedelta(days=7, minutes=1)),
          (3, "responded", _vn(2026, 10, 21, 17)),   # T2,T3,T4 = 3 ngày LV
          (4, "responded", _vn(2026, 10, 22, 9)),    # ngày LV thứ 4
          # xử lý khách xong KHÔNG thay phản hồi kỹ thuật
          (5, "customer_resolved", det + timedelta(minutes=30))]
    now = det + timedelta(days=10)
    r = {x["id"]: x for x in oi.evaluate(incs, ev, SHIFT, now)}
    assert [r[i]["detect"] for i in (1, 2, 3)] == ["ok", "late", "unmeasured"]
    assert [r[i]["respond"] for i in (1, 2, 3, 4, 5)] == [
        "ok", "late", "ok", "late", "late"]
    assert [r[i]["fix"] for i in (1, 2, 5)] == ["ok", "late", "late"]
    assert r[5]["customer_resolved_at"] is not None
    early = {x["id"]: x for x in oi.evaluate(incs[4:], [], SHIFT,
                                              det + timedelta(hours=1))}
    assert early[5]["respond"] == "pending" and early[5]["fix"] == "pending"
    assert oi.summarize(list(r.values()), "respond", "thuong") == {
        "ok": 1, "late": 1, "pending": 0, "unmeasured": 0}


def test_incident_log_db_append_only_and_validation(db):
    oi = _oi()
    tx = TxConn(db)
    now = datetime.now(VN_TZ)
    det = now - timedelta(hours=5)
    iid = oi.open_incident(tx, title="Chatbot lộ SĐT 0912 345 678",
                           severity="nghiem_trong", source="kuma",
                           ben="ben_a", detected_at=det.isoformat(),
                           occurred_at=(det - timedelta(minutes=10))
                           .isoformat(), by="Người Trực", now=now)
    assert "0912" not in db.execute("select title from ops_incidents where"
                                    " id = %s", (iid,)).fetchone()[0]
    for kw in ({"by": "agent:bot"}, {"at": (det - timedelta(minutes=1))
                                     .isoformat()},
               {"at": (now + timedelta(hours=1)).isoformat()}):
        args = {"by": "Người Trực", **kw}
        with pytest.raises(oi.IncidentError):
            oi.add_event(tx, iid, "responded", now=now, **args)
    with pytest.raises(oi.IncidentError):
        oi.add_event(tx, iid, "da_xong", by="Người Trực", now=now)
    oi.add_event(tx, iid, "responded", by="Người Trực",
                 at=(det + timedelta(hours=1)).isoformat(), now=now)
    oi.add_event(tx, iid, "customer_resolved", by="CSKH", now=now)
    with pytest.raises(oi.IncidentError):
        oi.open_incident(tx, title="x", severity="nhe", source="s",
                         ben="ben_a", detected_at=det, by="Người", now=now)
    for sql in ("update ops_incidents set severity = 'thuong'",
                "delete from ops_incident_events"):
        with pytest.raises(psycopg.Error), db.transaction():
            db.execute(sql)
    # báo cáo tháng đọc sổ → bảng PL02 mục 2
    start, end = om.month_bounds(f"{det:%Y-%m}", now)
    out = om.collect_db(TxConn(db), start, end)
    rows, notes = om.incident_rows(out["incidents"], SHIFT, now)
    by = {r[0]: r[2] for r in rows}
    assert by["Phát hiện sự cố hệ thống"].startswith("100.0% (1/1)")
    assert by["Phản hồi lỗi nghiêm trọng"].startswith("100.0% (1/1)")
    assert "— (0/0)" in by["Phản hồi lỗi thường"]
    assert "chưa tới hạn 1" in by["Sửa lỗi phát sinh"]
    assert "xử lý khách/đối tác xong 1" in notes[0]


def test_incident_rows_empty_book_not_claimed_clean():
    rows, _ = om.incident_rows({"incidents": [], "events": []}, SHIFT,
                               _vn(2026, 11, 2))
    assert all("không phải bằng chứng" in r[2] for r in rows)
    rows, _ = om.incident_rows(om.MISSING, SHIFT, _vn(2026, 11, 2))
    assert all(om.NO_DATA in r[2] for r in rows)


# ============================================================ KPI bền
def _jsonl(path, recs):
    path.write_bytes(b"".join(json.dumps(r, ensure_ascii=False)
                              .encode("utf-8") + b"\n" for r in recs))


def test_kpi_snapshot_survives_convlog_rotation(db, tmp_path):
    base = {"user_hash": "h" * 16, "question": "Anh Nguyễn Văn Mẫu 0912345678"}
    early = [dict(base, ts="2026-10-01T01:00:00Z", msg_id="m1", answered=True,
                  reply_ms=1200, channel="zalo"),
             dict(base, ts="2026-10-01T02:00:00Z", msg_id="m2",
                  answered=False, reply_ms=31000, channel="zalo")]
    late = [dict(base, ts="2026-10-31T03:00:00Z", msg_id="m3", answered=True,
                 reply_ms=900, channel="messenger")]
    _jsonl(tmp_path / "conversations.jsonl", early + late)
    tx = TxConn(db)
    assert om.snapshot(tx, tmp_path) == (3, 3)
    assert om.snapshot(tx, tmp_path) == (3, 0)              # chạy lại
    dump = json.dumps(db.execute("select * from chat_kpi_facts")
                      .fetchall(), default=str)
    assert "Mẫu" not in dump and "0912" not in dump and "h" * 16 not in dump
    assert '"m1"' not in dump
    # convlog xoay vòng: chỉ còn tin cuối tháng
    _jsonl(tmp_path / "conversations.jsonl", late)
    start, end = om.month_bounds("2026-10", _vn(2026, 11, 3))
    conv = om.read_convlog(tmp_path, start, end)
    assert len(conv["questions"]) == 1
    merged = om.merge_chat(conv, om.collect_db(tx, start, end)["chat_facts"])
    assert len(merged["questions"]) == 3 and sorted(merged["latencies"]) == [
        900, 1200, 31000]
    assert merged["earliest"] <= start + timedelta(hours=9)


def test_cli_snapshot_db_down_exit_1(monkeypatch, tmp_path):
    monkeypatch.setattr(om, "connect", lambda: None)
    assert om.main(["--snapshot"], data_dir=tmp_path) == 1


# ============================================================ gửi trước ngày 05
def test_mark_sent_only_by_sender_with_file(db, tmp_path, capsys):
    now = _vn(2026, 11, 3, 9)
    f = tmp_path / "van-hanh-2026-10.md"
    f.write_text("báo cáo", encoding="utf-8")
    tx = TxConn(db)
    for argv in (["--mark-sent", "2026-10", "--file", str(f), "--by",
                  "agent:ops"],
                 ["--mark-sent", "2026-10", "--file", str(tmp_path / "x.md"),
                  "--by", "Người Gửi"],
                 ["--mark-sent", "2026-11", "--file", str(f), "--by",
                  "Người Gửi"]):                           # tháng chưa đóng
        assert om.main(argv, now=now, conn=tx) == 2
    assert om.main(["--mark-sent", "2026-10", "--file", str(f), "--by",
                    "Người Gửi"], now=now, conn=tx) == 0
    start, end = om.month_bounds("2026-11", now)
    sent = om.collect_db(tx, start, end)["report_sent"]
    assert sent[1] == "Người Gửi" and len(sent[2]) == 64
    row = om._sent_row(sent, start)
    assert row[0] == "Báo cáo vận hành tháng 10/2026 gửi Bên B"
    assert om._sent_row((_vn(2026, 11, 4, 23, 59), "A", "a" * 64), start)[3] \
        == "Đạt"
    assert om._sent_row((_vn(2026, 11, 5, 0, 0), "A", "a" * 64), start)[3] \
        == "KHÔNG ĐẠT"
    none = om._sent_row((), start)          # không có dòng xác nhận
    assert none[3] == "—" and "chưa có xác nhận" in none[2]
    nov = om.collect_db(tx, *om.month_bounds("2026-10", now))["report_sent"]
    assert nov == ()                         # tháng 9 chưa ai xác nhận gửi


def test_month_prev_for_day1_job(tmp_path, monkeypatch):
    monkeypatch.setattr(om, "connect", lambda: None)
    rc = om.main(["--month", "prev", "--out-dir", str(tmp_path)],
                 now=_vn(2026, 11, 1, 8), data_dir=tmp_path)
    assert rc == 1 and (tmp_path / "van-hanh-2026-10.md").exists()


def test_render_ads_koc_scope_always_stated():
    md = om.render({"start": _vn(2026, 10, 1), "end": _vn(2026, 11, 1),
                    "now": _vn(2026, 11, 2), "assets": om.load_assets(),
                    "repo": {"head": None, "modules": 1, "tests": 1,
                             "handover": []},
                    "conv": {"exists": False, "earliest": None,
                             "questions": [], "latencies": []},
                    "shift": SHIFT, "backups": None, "drills": None,
                    "db_ok": False})
    assert "KOC/livestream" in md and "KHÔNG được coi là đạt" in md


# ============================================================ lịch job
def test_schedule_file_and_systemd_units_match():
    jobs = job_runs.load_jobs()
    want = {"intel", "red_alert_sweep", "ceo_weekly", "invoice_batch",
            "content_daily", "backup", "restore_drill", "dr_drill",
            "kpi_snapshot", "health_bulletin", "ops_monthly"}
    assert want <= set(jobs)
    cal = {n: j["on_calendar"] for n, j in jobs.items()}
    assert cal["red_alert_sweep"] == "*-*-* *:05:00"          # 60 phút
    assert cal["ceo_weekly"].startswith("Mon ")
    assert cal["ops_monthly"].startswith("*-*-01 ")
    assert re.fullmatch(r"\*-\*-\* 0[67]:\d\d:00", cal["intel"])
    assert jobs["ops_monthly"]["steps"] == [["scripts/ops_monthly.py",
                                             "--month", "prev"]]
    d = ROOT / "deploy" / "onprem" / "systemd"
    svc = (d / "samsam-job@.service").read_text(encoding="utf-8")
    assert "ExecStart=<duong_dan_python> -m pipelines.job_runs --run %i" \
        in svc and "User=root" not in svc
    timers = {p.name for p in d.glob("samsam-job-*.timer")}
    assert timers == {f"samsam-job-{n}.timer" for n in jobs}
    for n, j in jobs.items():
        t = (d / f"samsam-job-{n}.timer").read_text(encoding="utf-8")
        assert f"OnCalendar={j['on_calendar']}\n" in t
        assert f"Unit=samsam-job@{n}.service\n" in t


@pytest.mark.parametrize("bad", [
    {"jobs": {"x": {"on_calendar": "daily", "max_gap_hours": 1,
                    "steps": [["-m", "khong.co.module"]]}}},
    {"jobs": {"x": {"on_calendar": "daily", "max_gap_hours": 1,
                    "steps": [["../evil.py"]]}}},
    {"jobs": {"x": {"on_calendar": "daily", "max_gap_hours": 0,
                    "steps": [["scripts/db_backup.py"]]}}},
    {"jobs": {"X Y": {"on_calendar": "daily", "max_gap_hours": 1,
                      "steps": [["scripts/db_backup.py"]]}}},
    {"jobs": {}}, {},
])
def test_load_jobs_rejects(tmp_path, bad):
    p = tmp_path / "jobs.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(job_runs.JobConfigError):
        job_runs.load_jobs(p)


def test_wrapper_lock_blocks_overlap(tmp_path, _no_job_runs_db):
    jobs = {"x": {"on_calendar": "daily", "max_gap_hours": 1,
                  "steps": [["-m", "pipelines.period"]]}}
    calls = []
    with job_runs._file_lock(tmp_path / "x.lock") as got:
        assert got
        rc = job_runs.run_scheduled("x", jobs=jobs, lock_dir=tmp_path,
                                    runner=lambda *a, **k: calls.append(a))
    assert rc == job_runs.EXIT_LOCKED and calls == []
    job, _s, _f, ok, detail = _no_job_runs_db[-1]
    assert job == "job:x" and ok is False and "chạy chồng" in detail
    # khóa đã nhả → chạy được
    res = iter([0])
    rc = job_runs.run_scheduled(
        "x", jobs=jobs, lock_dir=tmp_path,
        runner=lambda *a, **k: type("R", (), {"returncode": next(res)}))
    assert rc == 0 and _no_job_runs_db[-1][3] is True


def test_wrapper_runs_all_steps_and_reports_first_failure(tmp_path,
                                                          _no_job_runs_db):
    jobs = {"x": {"on_calendar": "daily", "max_gap_hours": 1,
                  "steps": [["-m", "a"], ["-m", "b"], ["-m", "c"]]}}
    rcs, seen = iter([0, 3, 4]), []

    def runner(argv, cwd, timeout):
        seen.append(argv[1:])
        return type("R", (), {"returncode": next(rcs)})
    assert job_runs.run_scheduled("x", jobs=jobs, lock_dir=tmp_path,
                                  runner=runner) == 3
    assert seen == [["-m", "a"], ["-m", "b"], ["-m", "c"]]
    assert _no_job_runs_db[-1][3] is False
    assert _no_job_runs_db[-1][4] == "bước 2 exit 3; bước 3 exit 4"


def test_health_bulletin_watches_scheduled_jobs():
    exp = hb.expected_jobs()
    assert exp["job:red_alert_sweep"] == 2 and exp["job:backup"] == 26
    late = {j for j, _h, _l in hb.late_jobs({"job:backup": 1.0}, exp)}
    assert "job:backup" not in late and "job:ops_monthly" in late


def test_gitignore_job_locks():
    assert "data/job_locks/" in (ROOT / ".gitignore").read_text(
        encoding="utf-8")


def test_cli_module_help_runs():
    """`python -m pipelines.job_runs --list` đọc lịch thật, không DB."""
    import subprocess
    import sys
    r = subprocess.run([sys.executable, "-m", "pipelines.job_runs", "--list"],
                       cwd=ROOT, capture_output=True, timeout=60,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 0 and "red_alert_sweep" in r.stdout
