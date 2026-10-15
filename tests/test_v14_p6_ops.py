# ruff: noqa: F811 — fixture pytest nhập từ file test khác (db/run/live/zfiles)
"""v14.6 (p6) — vận hành còn sót (gate C11 + review v13 NIT).

1. Hạn 30 giây TỔNG phủ cả phần GỬI của Zalo: refresh token (trước: timeout
   cố định 15 giây sau tới 25 giây trả lời), chờ refresh đang chạy ở luồng
   khác (trước: chờ không hạn) và nhánh giữ câu trả lời ghi DB TRƯỚC khi gửi.
   Test theo sự kiện / thời gian còn lại — không assert wall-clock.
2. Leo thang 2 giờ ĐỒNG HỒ cho MỌI cảnh báo đỏ (trước: chỉ intel), 1 lần /
   cảnh báo gốc, unique index chung, job 15 phút mọi ngày.
3. `jobs.json` + timer: `anchor --build`, `legal_updates --submit`,
   `red_alert --escalate`.
4. `ops_monthly` in 4 cột kiểm kê tài sản.
5. Nhãn "Ảnh/video" bản tin vùng trồng; `qr_trace link` từ chối sha video;
   `_doc` routing cảnh báo đỏ không còn ghi "KHÔNG gửi thật".

DB thật: schema tạm + rollback (fixture `db` của tests/test_qr_trace.py);
login dịch vụ thật (fixture `live` của tests/test_v14_p2_service_auth.py).
"""

import json
import threading
import time
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from psycopg.errors import CheckViolation, UniqueViolation
from psycopg.types.json import Jsonb

from api import rag
from connectors import channels, zalo
from pipelines import intel_alert as ia
from pipelines import job_runs
from pipelines import red_alert as ra
from scripts import ops_monthly as om
from tests.test_qr_trace import (  # noqa: F401 — fixture db/proxy/run
    H1,
    LOT,
    TxConn,
    _harvest,
    _mk_lot,
    _plot,
    db,
    proxy,
    run,
)
from tests.test_v13_c07_ops import SHIFT, _log, _vn, zfiles  # noqa: F401
from tests.test_v14_p2_service_auth import _run, live  # noqa: F401
from tests.test_zalo import _Resp

ROOT = Path(__file__).resolve().parent.parent
ANSWER = {"answer": "Giá 1.000.000 đ", "sources": ["https://x"]}


# ============================================================ 1. Zalo 30 giây
@pytest.fixture
def ztok(zfiles, monkeypatch, tmp_path):
    """Token store/throttle cô lập + bộ refresh đủ credential."""
    monkeypatch.setattr(zalo, "TOKEN_STORE", tmp_path / "zalo_tokens.json")
    monkeypatch.setattr(zalo, "_last_refresh", float("-inf"))
    monkeypatch.setattr(zalo, "_last_refresh_ok", float("-inf"))
    monkeypatch.setattr(zalo, "_mem_tokens", {})
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    monkeypatch.setattr("api.rag.answer", lambda q: dict(ANSWER))
    calls = []

    def fake_post(url, **kw):
        calls.append((url, kw.get("timeout")))
        if url == zalo.OAUTH_URL:
            return _Resp(200, {"access_token": "new-tok",
                               "refresh_token": "new-rtok",
                               "expires_in": "3600"})
        return _Resp(200, {"error": 0})
    monkeypatch.setattr(httpx, "post", fake_post)
    return zfiles + (calls,)


def test_refresh_skipped_when_budget_left_too_small(ztok, monkeypatch):
    """Probe: câu trả lời xong ở giây 27 mà phải refresh token → code cũ gọi
    oauth với timeout 15 giây (tổng tới 47 giây). Nay: không đủ ngân sách →
    không refresh, tin không tới khách → chuyển người lý do `deadline`."""
    tmp_path, handoffs, calls = ztok
    monkeypatch.setattr(rag, "SEND_RESERVE_S", 1.0)   # trả lời được tới 29s
    r = zalo._reply("u1", "Saphraton giá bao nhiêu?", "m1",
                    t_recv=time.monotonic() - 27)
    assert [u for u, _ in calls] == []                 # không oauth, không gửi
    assert r["sent"] is False
    assert handoffs == ["deadline"]
    rec = _log(tmp_path)[-1]
    assert rec["error"] == "deadline:lam_moi_token"
    assert rec["answered"] is False and rec["sent"] is False
    assert zalo._SEND_DEADLINE.get() is None           # không rò sang lượt sau


def test_refresh_timeout_bounded_by_remaining_budget(ztok):
    """Còn ~10 giây khi gửi → refresh timeout ≤ còn lại − 5 giây gửi (code cũ:
    15 giây cố định); gửi được → không chuyển người."""
    tmp_path, handoffs, calls = ztok
    r = zalo._reply("u2", "Saphraton giá bao nhiêu?", "m2",
                    t_recv=time.monotonic() - 20)
    assert [u for u, _ in calls] == [zalo.OAUTH_URL, zalo.SEND_URL]
    t_oauth = calls[0][1]
    assert 3.0 < t_oauth <= 5.0, t_oauth
    assert calls[1][1] == zalo.SEND_TIMEOUT_S
    assert r["sent"] is True and handoffs == []
    assert "error" not in _log(tmp_path)[-1]


def test_wait_for_inflight_refresh_is_bounded(ztok, monkeypatch, tmp_path):
    """Luồng khác đang refresh (giữ _token_lock) → lượt này chờ tối đa phần
    ngân sách còn lại rồi gửi bằng token hiện có (code cũ chờ tới khi luồng
    kia nhả — tới 15 giây — vượt 30 giây). Theo sự kiện, không sleep."""
    _tp, handoffs, calls = ztok
    (tmp_path / "zalo_tokens.json").write_text(json.dumps(
        {"access_token": "tok", "refresh_token": "rtok",
         "expires_at": time.time() + 10}), encoding="utf-8")  # sắp hết hạn
    monkeypatch.setattr(zalo, "_last_refresh", time.monotonic())  # vừa thử
    held, release = threading.Event(), threading.Event()

    def holder():
        with zalo._token_lock:
            held.set()
            release.wait(30)
    th_hold = threading.Thread(target=holder, daemon=True)
    th_hold.start()
    assert held.wait(5)
    out = {}
    th = threading.Thread(target=lambda: out.update(r=zalo._reply(
        "u3", "Saphraton giá bao nhiêu?", "m3",
        t_recv=time.monotonic() - 22)))       # còn ~8s → chờ tối đa ~3s
    th.start()
    th.join(10)
    alive = th.is_alive()
    release.set()
    th.join(10)
    th_hold.join(10)
    assert not alive, "chờ refresh của luồng khác không giới hạn"
    assert out["r"]["sent"] is True and handoffs == []
    assert [u for u, _ in calls] == [zalo.SEND_URL]   # gửi bằng token còn hạn


def test_held_reply_sends_before_suggestion_db_write(zfiles, monkeypatch):
    """Chatbot chạy thử: khách nhận HOLD_TEXT TRƯỚC khi ghi gợi ý vào DB
    (code cũ ghi DB trước — DB chậm ăn vào 30 giây của khách)."""
    tmp_path, handoffs = zfiles
    order = []
    monkeypatch.setattr("api.rag.answer", lambda q: dict(ANSWER))
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "chay_thu")
    monkeypatch.setattr(channels, "record_suggestion",
                        lambda *a, **k: order.append("db") or 41)
    r = zalo._reply("u4", "Saphraton giá bao nhiêu?", "m4",
                    send=lambda u, t: order.append("send") or True)
    assert order == ["send", "db"]
    assert r["text"] == zalo.HOLD_TEXT and r["rollout"] == "chay_thu"
    rec = _log(tmp_path)[-1]
    assert rec["suggestion_id"] == 41 and "error" not in rec
    assert handoffs == ["rollout"]


def test_no_deadline_outside_reply_keeps_old_refresh(ztok):
    """CLI/preflight gọi send_text ngoài lượt trả lời → refresh như cũ (15s)."""
    _tp, _h, calls = ztok
    assert zalo.send_text("u5", "x") is True
    assert calls[0] == (zalo.OAUTH_URL, zalo.REFRESH_TIMEOUT_S)


# ============================================================ 2. leo thang 2h
def _root(tx, db, src, title="Sự cố", detail=None):
    ra.raise_alert(tx, src, title, detail=detail, routing={"recipients": []})
    aid = db.execute("select max(id) from red_alerts").fetchone()[0]
    ts = db.execute("select ts from red_alerts where id = %s",
                    (aid,)).fetchone()[0]
    return aid, ts


def test_escalate_every_source_once_after_2h_clock(db):
    """Probe: cảnh báo đỏ của sales_director / rà kênh quá 2 giờ chưa xác
    nhận KHÔNG được leo thang (code cũ chỉ intel). Nay: mọi nguồn, đúng 1
    lần / cảnh báo gốc, đồng hồ thuần (không giờ làm việc/ngày nghỉ)."""
    tx = TxConn(db)
    a1, ts = _root(tx, db, "agents.sales_director", "SLA trễ khối KD")
    a2, _ = _root(tx, db, "agents.ra_kenh", "S1 tiktok: bài #9",
                  {"post_id": 9})
    a3, _ = _root(tx, db, "agents.ra_kenh", "S1 shopee: bài #10")
    assert ra.ack(tx, a3, "Người Xác Nhận Giả Lập")[0] is True
    assert ra.escalate(tx, ts + timedelta(hours=1, minutes=59))[
        "escalated"] == 0
    st = ra.escalate(tx, ts + timedelta(hours=2, minutes=1),
                     routing={"recipients": []})
    assert st["ids"] == [a1, a2] and st["unrouted"] == 2
    rows = db.execute(
        "select source_agent, title, detail from red_alerts where detail ?"
        " 'escalation_of' order by id").fetchall()
    assert [(s, d["escalation_of"]) for s, _t, d in rows] == [
        ("agents.sales_director", a1), ("agents.ra_kenh", a2)]
    assert all(t.startswith(ra.ESC_PREFIX) for _s, t, _d in rows)
    assert "post_id" not in rows[1][2]          # tra cứu ra_kenh không lẫn
    again = ra.escalate(tx, ts + timedelta(days=3))
    assert again["escalated"] == 0              # 1 đợt / cảnh báo, không lặp
    assert ra.ESCALATE_AFTER == timedelta(hours=2)
    # bản leo thang không phải cảnh báo gốc (KPI/--open không đếm 2 lần)
    assert [d["id"] for d in ra.open_alerts(tx, ts)] == [a1, a2]


def test_escalation_unique_for_every_source(db):
    ins = ("insert into red_alerts (source_agent, title, detail) values"
           " (%s, 'đỏ', %s)")
    db.execute(ins, ("agents.sales_director", Jsonb({"escalation_of": 5})))
    with pytest.raises(UniqueViolation), db.transaction():
        db.execute(ins, ("agents.ra_kenh", Jsonb({"escalation_of": 5})))


def test_intel_and_generic_escalate_share_one_rule(db):
    tx = TxConn(db)
    aid, ts = _root(tx, db, ia.SOURCE_AGENT, ia.ALERT_PREFIX + "Thu hồi lô",
                    {"intel_item_id": 1, "url": "https://tin.vi-du/1"})
    other, _ = _root(tx, db, "agents.sales_director")
    later = ts + timedelta(hours=2, minutes=1)
    assert ia.escalate(tx, later)["ids"] == [aid]     # intel chỉ lọc intel
    st = ra.escalate(tx, later)
    assert st["ids"] == [other]                       # không leo thang intel 2 lần
    assert ia.escalate(tx, later)["escalated"] == 0
    esc = db.execute("select detail from red_alerts where detail->>"
                     "'escalation_of' = %s", (str(aid),)).fetchone()[0]
    assert esc["url"] == "https://tin.vi-du/1"
    assert [d["escalated"] for d in ia.open_alerts(tx, later)] == [True]


def test_cli_escalate_exit_1_when_not_notified(db, monkeypatch, capsys):
    import ingest.lead_store as ls
    rec = []
    monkeypatch.setattr(job_runs, "_record", lambda *a: rec.append(a))
    monkeypatch.setattr(ls, "connect", lambda: TxConn(db))
    monkeypatch.setattr(ra, "ESCALATE_AFTER", timedelta(0))  # tới hạn ngay
    monkeypatch.setattr(ra, "ROUTING", ROOT / "data" / "red_alert_routing.json")
    _root(TxConn(db), db, "agents.sales_director")
    assert ra.main(["--escalate"]) == 1               # chưa có người nhận
    out = capsys.readouterr().out
    assert "escalated=1" in out and "CHƯA thông báo" in out
    assert rec[-1][0] == "pipelines.red_alert.escalate" and rec[-1][3] is False
    assert ra.main(["--escalate"]) == 0               # đã leo thang → 0 việc


def test_escalate_and_anchor_run_under_job_login(live, tmp_path):
    """Bước lịch mới chạy dưới login svc_job (không owner): không thiếu quyền."""
    for argv in (["-m", "pipelines.red_alert", "--escalate"],
                 ["-m", "pipelines.anchor", "--build"]):
        rc, text = _run(argv, live["dsn"]["svc_job"], tmp_path)
        assert "InsufficientPrivilege" not in text and \
            "permission denied" not in text, (argv, text)
    rc, text = _run(["-m", "pipelines.red_alert", "--escalate"],
                    live["dsn"]["svc_job"], tmp_path)
    assert rc == 0 and "escalated=0" in text, text


# ============================================================ 3. lịch job
def test_jobs_schedule_escalate_anchor_legal():
    jobs = job_runs.load_jobs()
    want = {"red_alert_escalate": [["-m", "pipelines.red_alert",
                                    "--escalate"]],
            "anchor_build": [["-m", "pipelines.anchor", "--build"]],
            "legal_updates": [["-m", "pipelines.legal_updates", "--submit"]]}
    for name, steps in want.items():
        assert jobs[name]["steps"] == steps, name
        t = (ROOT / "deploy" / "onprem" / "systemd"
             / f"samsam-job-{name}.timer").read_text(encoding="utf-8")
        assert f"OnCalendar={jobs[name]['on_calendar']}\n" in t
    # leo thang: mọi ngày (không giới hạn thứ), ≤ 15 phút/lần
    assert jobs["red_alert_escalate"]["on_calendar"] == "*-*-* *:00/15:00"
    assert jobs["red_alert_escalate"]["max_gap_hours"] == 1
    assert jobs["legal_updates"]["on_calendar"] > jobs["intel"]["on_calendar"]
    assert job_runs.JOB_SERVICE.get("red_alert_escalate", "job") == "job"


# ============================================================ 4. tài sản
def _facts(assets):
    return {"start": _vn(2026, 10, 1), "end": _vn(2026, 11, 1),
            "now": _vn(2026, 11, 2), "assets": assets,
            "repo": {"head": None, "modules": 1, "tests": 1, "handover": []},
            "conv": {"exists": False, "earliest": None, "questions": [],
                     "latencies": []},
            "shift": SHIFT, "backups": None, "drills": None, "db_ok": False}


def test_ops_monthly_prints_four_inventory_columns(tmp_path):
    md = om.render(_facts(om.load_assets()))
    assert ("| Vị trí | Phiên bản | Chủ quản | Quyền truy cập |" in md)
    raw = json.loads((ROOT / "data" / "tai_san_hop_tac.json").read_text(
        encoding="utf-8"))
    row = next(ln for ln in md.splitlines()
               if ln.startswith("| Mã nguồn Dự án |"))
    assert row.count("|") == 9
    src = raw["hang_muc"][0]
    assert om._cell(src["chu_quan"]) in row
    assert om._cell(src["quyen_truy_cap"]) in row
    assert "Người giữ quyền cao nhất: Bên B" in md
    assert "trạng thái kiểm kê: cho_xac_nhan" in md
    # file tối thiểu (không 4 cột) → "chưa xác nhận", không suy đoán
    p = tmp_path / "a.json"
    p.write_text(json.dumps({"cap_nhat": "2026-10-15", "hang_muc": [
        {"hang_muc": "A", "mo_ta": "B", "noi_luu": "C", "ben_quan_ly": "D",
         "vi_tri": "  ", "phien_ban": 3}]}), encoding="utf-8")
    md = om.render(_facts(om.load_assets(p)))
    row = next(ln for ln in md.splitlines() if ln.startswith("| A |"))
    assert row.count(om.UNCONFIRMED) == 4
    assert "Người giữ quyền cao nhất: chưa xác nhận" in md


# ============================================================ 5. nhãn/QR/_doc
def test_garden_bulletin_label_photo_video():
    src = (ROOT / "agents" / "garden_director.py").read_text(encoding="utf-8")
    assert "## 6. Ảnh/video vườn mới" in src
    assert "| Khoảnh | Ảnh/video |" in src and "Không có ảnh/video mới." in src
    assert "Ảnh vườn mới" not in src


def test_qr_link_rejects_video_sha(db, proxy, run, capsys):
    """Probe: sha của video vườn (garden_media mp4) được ánh xạ vào lô, chỉ
    bị từ chối lúc `site` — sau khi 3 người đã ký. Nay: từ chối ngay ở
    `link` (CLI) và ở DB (trigger) — không ghi."""
    _plot(db)
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    vid = "ab" * 32
    db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
               " taken_on, author) values (%s, 'mp4', 10, 'KV-T01',"
               " '2026-09-01', 'Người Quay Giả Lập')", (vid,))
    assert run("link", "--lot", LOT, "--log", str(lid), "--media", vid,
               "--by", "GĐ SX fixture") == 1
    assert "video" in capsys.readouterr().out
    assert db.execute("select count(*) from lot_origins").fetchone()[0] == 0
    with pytest.raises(CheckViolation, match="video"), db.transaction():
        db.execute("select link_lot_origin(%s, %s, %s, 'A')",
                   (LOT, lid, [vid]))
    assert run("link", "--lot", LOT, "--log", str(lid), "--by",
               "GĐ SX fixture") == 0                   # không media → nhận


def test_routing_doc_not_stale():
    doc = json.loads((ROOT / "data" / "red_alert_routing.json").read_text(
        encoding="utf-8"))["_doc"]
    assert "KHÔNG gửi thật" not in doc
    assert "SMTP" in doc and "RED_ALERT_NOTIFY=email" in doc
    assert "--escalate" in doc
    assert ra.load_routing()["recipients"] == []        # vẫn rỗng, không bịa
