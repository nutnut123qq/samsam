"""v12.6 B6 — `scripts/ops_monthly.py`: báo cáo vận hành tháng gửi Bên B
(PL02 mục 3 + mục 2 + PL04 mục 3).

Thuần: tháng/cấu hình tài sản/KPI/p95/backup/diễn tập/convlog/render trên
facts viết tay. DB thật (schema tạm + rollback, `ceo_db`): `collect_db` chỉ
SELECT, đếm đúng theo mốc giờ, bảng thiếu → "chưa có dữ liệu".
"""

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipelines.period import VN_TZ
from scripts import ops_monthly as om
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
SHIFT = {"start": "08:00", "end": "18:00", "workdays": [0, 1, 2, 3, 4],
         "holidays": []}


def _vn(*a) -> datetime:
    return datetime(*a, tzinfo=VN_TZ)


def _assets():
    return om.load_assets()


# ------------------------------------------------------------------ tháng
def test_month_bounds_ok_and_in_progress():
    s, e = om.month_bounds("2026-10", _vn(2026, 10, 15, 9))
    assert (s, e) == (_vn(2026, 10, 1), _vn(2026, 11, 1))
    s, e = om.month_bounds("2026-12", _vn(2027, 1, 2))
    assert e == _vn(2027, 1, 1)


@pytest.mark.parametrize("bad", ["2026-13", "2026-1", "26-10", "abc", "",
                                 " 2026-10x", None, "2026-00"])
def test_month_bounds_rejects_format(bad):
    with pytest.raises(om.UsageError):
        om.month_bounds(bad, _vn(2026, 10, 15))


def test_month_bounds_rejects_future():
    with pytest.raises(om.UsageError, match="chưa bắt đầu"):
        om.month_bounds("2026-11", _vn(2026, 10, 31, 23, 59))


# ------------------------------------------------------------------ tài sản
def test_load_assets_real_file():
    a = _assets()
    assert len(a["items"]) == 5 and isinstance(a["cap_nhat"], date)
    names = [i["hang_muc"] for i in a["items"]]
    assert "Mã nguồn Dự án" in names and "Tài khoản quản trị cao nhất" in names
    assert "Dữ liệu khách hàng" in a["excluded"]


_GOOD = {"cap_nhat": "2026-10-15",
         "hang_muc": [{"hang_muc": "A", "mo_ta": "B", "noi_luu": "C",
                       "ben_quan_ly": "D"}]}


@pytest.mark.parametrize("doc", [
    {}, {"_doc": "x"}, [], "x",
    dict(_GOOD, cap_nhat="15/10/2026"), dict(_GOOD, cap_nhat=None),
    dict(_GOOD, hang_muc=[]), dict(_GOOD, hang_muc="x"),
    dict(_GOOD, hang_muc=[{"hang_muc": "A", "mo_ta": "B", "noi_luu": "C"}]),
    dict(_GOOD, hang_muc=[{"hang_muc": " ", "mo_ta": "B", "noi_luu": "C",
                           "ben_quan_ly": "D"}]),
    dict(_GOOD, khong_thuoc_tai_san_hop_tac="x"),
    dict(_GOOD, khong_thuoc_tai_san_hop_tac=["", "y"]),
])
def test_load_assets_rejects(tmp_path, doc):
    p = tmp_path / "a.json"
    p.write_bytes(json.dumps(doc).encode("utf-8"))
    with pytest.raises(om.UsageError):
        om.load_assets(p)


def test_load_assets_missing_and_broken(tmp_path):
    with pytest.raises(om.UsageError, match="không có"):
        om.load_assets(tmp_path / "none.json")
    p = tmp_path / "b.json"
    p.write_bytes(b"{not json")
    with pytest.raises(om.UsageError, match="hỏng"):
        om.load_assets(p)
    p.write_bytes(json.dumps(_GOOD).encode("utf-8"))
    assert om.load_assets(p)["excluded"] == []


# ------------------------------------------------------------------ KPI CSKH
def test_kpi_cskh_bot_and_handoff_business_hours():
    fri = _vn(2026, 10, 16, 17, 30)          # thứ Sáu 17:30 → hạn T2 09:30
    now = _vn(2026, 10, 31)
    qs = [(_vn(2026, 10, 14, 9), True, "cskh:aaaa"),
          (fri, False, "cskh:g1"),
          (_vn(2026, 10, 14, 9), False, "cskh:g2"),
          (_vn(2026, 10, 14, 9), False, "cskh:g3")]
    dec = [("cskh:g1", "approved", _vn(2026, 10, 19, 9, 29)),     # đạt
           ("cskh:g2", "rejected", _vn(2026, 10, 14, 11, 1)),     # trễ 1'
           ("cskh:g3", "approved", _vn(2026, 10, 14, 8, 59))]     # trước câu hỏi
    k = om.kpi_cskh(qs, dec, SHIFT, now)
    assert k == {"ok": 2, "late": 2, "pending": 0, "bot": 1, "handoff": 3}


def test_kpi_cskh_episode_suffix_and_pending_and_exact_deadline():
    q = _vn(2026, 10, 14, 9)
    dec = [("cskh:g1:20261014T030000Z", "approved", _vn(2026, 10, 14, 11))]
    k = om.kpi_cskh([(q, False, "cskh:g1")], dec, SHIFT, _vn(2026, 10, 31))
    assert k["ok"] == 1                       # đúng mốc 2 giờ = đạt
    k = om.kpi_cskh([(q, False, "cskh:g9")], [], SHIFT, _vn(2026, 10, 14, 10))
    assert k["pending"] == 1 and k["late"] == 0
    # khóa không phải cskh: (khách thiếu user_hash) → so nguyên chuỗi
    dec = [("convlog:m1", "approved", _vn(2026, 10, 14, 9, 5))]
    k = om.kpi_cskh([(q, False, "convlog:m1"), (q, False, "convlog:m10")],
                    dec, SHIFT, _vn(2026, 10, 31))
    assert (k["ok"], k["late"]) == (1, 1)


# ------------------------------------------------------------------ KPI khác
def test_kpi_alerts_edges():
    t = _vn(2026, 10, 10, 22)                # tối thứ Bảy — giờ đồng hồ
    now = _vn(2026, 10, 11, 1)
    rows = [(1, t, t + timedelta(hours=2)),               # đúng 2h = đạt
            (2, t, t + timedelta(hours=2, seconds=1)),    # trễ
            (3, t - timedelta(hours=5), None),            # chưa xác nhận
            (4, now - timedelta(minutes=30), None)]       # chưa tới hạn
    k = om.kpi_alerts(rows, now)
    assert (k["ok"], k["late"], k["pending"], k["unacked"]) == (1, 2, 1, [3])


def test_kpi_takedown_edges():
    f = _vn(2026, 10, 10, 8)
    due = f + timedelta(hours=24)
    now = _vn(2026, 10, 20)
    rows = [("u1", f, due, due, "da_go"),                        # đạt (đúng hạn)
            ("u2", f, due, due + timedelta(minutes=1), "da_sua"),  # trễ
            ("u3", f, due, f + timedelta(hours=1), "thay_ban_moi"),  # chưa xong
            ("u4", f, due, None, None),                          # quá hạn còn mở
            ("u5", now - timedelta(hours=1), now + timedelta(hours=23), None,
             None)]                                              # chưa tới hạn
    assert om.kpi_takedown(rows, now) == {"ok": 1, "late": 3, "pending": 1}


def test_p95():
    assert om.p95([]) is None
    assert om.p95([7]) == 7
    assert om.p95(list(range(1, 21))) == 19
    assert om.p95(list(range(100, 0, -1))) == 95


def _run(ts, status="ok", offsite="dir"):
    return {"ts": ts, "status": status, "offsite": offsite}


def test_backup_days_closed_month():
    s, e = _vn(2026, 11, 1), _vn(2026, 12, 1)
    runs = [_run(_vn(2026, 11, d, 1, 30)) for d in range(1, 31) if d != 7]
    runs[0]["offsite"] = None
    runs.append(_run(_vn(2026, 11, 7, 1, 30), "offsite_fail"))
    runs.append(_run(_vn(2026, 10, 31, 23, 0)))          # ngoài tháng
    b = om.backup_days(runs, s, e, _vn(2026, 12, 2))
    assert (b["days"], b["ok"], b["offsite"]) == (30, 29, 28)
    assert b["missing"] == [date(2026, 11, 7)]


def test_backup_days_in_progress_excludes_today_and_utc_ts():
    s, e = _vn(2026, 10, 1), _vn(2026, 11, 1)
    # 18:30 UTC ngày 2 = 01:30 giờ VN ngày 3
    runs = [_run(datetime(2026, 10, 2, 18, 30, tzinfo=timezone.utc))]
    b = om.backup_days(runs, s, e, _vn(2026, 10, 4, 9))
    assert b["days"] == 3 and b["ok"] == 1
    assert b["missing"] == [date(2026, 10, 1), date(2026, 10, 2)]
    assert om.backup_days([], s, e, _vn(2026, 10, 1, 9))["days"] == 0


def test_drill_status_milestones():
    s, e = _vn(2026, 11, 1), _vn(2026, 12, 1)
    runs = [_run(_vn(2026, 11, 20, 3)), _run(_vn(2026, 11, 27, 3), "mismatch")]
    d = om.drill_status(runs, s, e, _vn(2026, 12, 2))
    assert d["marks"][0] == ("mốc 30/11/2026", "đạt (20/11/2026)")
    assert d["marks"][1] == ("mốc 18/12/2026", "chưa tới hạn")
    assert d["month_runs"] == [(date(2026, 11, 20), "ok"),
                               (date(2026, 11, 27), "mismatch")]
    d = om.drill_status([runs[1]], s, e, _vn(2026, 12, 2))
    assert d["marks"][0][1] == "KHÔNG ĐẠT"
    # mốc chỉ hiện khi còn ≤ 60 ngày tính từ cuối tháng báo cáo
    d = om.drill_status([], _vn(2026, 10, 1), _vn(2026, 11, 1),
                        _vn(2026, 10, 15))
    assert d["marks"] == [("mốc 30/11/2026", "chưa tới hạn"),
                          ("mốc 18/12/2026", "chưa tới hạn")]
    d = om.drill_status([], _vn(2026, 9, 1), _vn(2026, 10, 1),
                        _vn(2026, 9, 15))
    assert d["marks"] == []


def test_drill_status_quarterly_after_last_moc():
    s, e = _vn(2027, 2, 1), _vn(2027, 3, 1)
    old = _run(_vn(2026, 12, 15, 3))
    d = om.drill_status([old], s, e, _vn(2027, 3, 2))
    assert ("mốc 18/12/2026", "đạt (15/12/2026)") in d["marks"]
    assert d["marks"][-1] == ("quý 1/2027", "chưa có lần đạt — hạn cuối quý")
    d = om.drill_status([old, _run(_vn(2027, 1, 10, 3))], s, e,
                        _vn(2027, 3, 2))
    assert d["marks"][-1] == ("quý 1/2027", "đạt (10/01/2027)")
    d = om.drill_status([old], _vn(2027, 3, 1), _vn(2027, 4, 1),
                        _vn(2027, 4, 3))
    assert d["marks"][-1] == ("quý 1/2027", "KHÔNG ĐẠT")
    d = om.drill_status([old], _vn(2027, 12, 1), _vn(2028, 1, 1),
                        _vn(2028, 1, 2))
    assert d["marks"][-1] == ("quý 4/2027", "KHÔNG ĐẠT")


# ------------------------------------------------------------------ file
def _write_jsonl(path: Path, recs) -> None:
    lines = [r if isinstance(r, bytes) else
             json.dumps(r, ensure_ascii=False).encode("utf-8") for r in recs]
    path.write_bytes(b"\n".join(lines) + b"\n")


def test_read_convlog(tmp_path):
    # docx P1: chỉ dòng provenance live vào KPI vận hành
    base = {"user_hash": "h1", "question": "q", "provenance": "live"}
    _write_jsonl(tmp_path / "conversations.jsonl", [
        {"_doc": "x"}, b"{corrupt",
        dict(base, ts="2026-10-02T02:00:00Z", msg_id="m1", answered=True,
             reply_ms=1200, latency_ms=800),
        dict(base, ts="2026-10-02T02:00:00Z", msg_id="m1", answered=True,
             reply_ms=1200),                            # trùng msg_id
        dict(base, ts="2026-10-03T02:00:00Z", msg_id="m2", answered=False,
             reply_ms=True),                            # bool không tính
        dict(base, ts="2026-10-03T03:00:00Z", msg_id="m3", answered=None,
             reply_ms=-5),                              # chào hỏi
        dict(base, ts="2026-10-03T04:00:00Z", msg_id="m4", answered=False,
             route="consent_granted", reply_ms=31000),
        dict(base, ts="2026-10-03T04:30:00Z", msg_id="m4b", answered=None,
             latency_ms=45000),                         # chỉ answer() → không tính
        dict(base, ts="2026-10-03T05:00:00Z", msg_id="m5", answered=1),
        dict(base, ts="2026-10-04T05:00:00Z", msg_id="m8", answered=True,
             sent=False),                               # gửi lỗi = chưa xử lý
        dict({"question": "q", "provenance": "live"},
             ts="2026-10-04T06:00:00Z", msg_id="m9",
             answered=False),                           # thiếu user_hash
        dict(base, ts="2026-09-30T16:59:59Z", msg_id="m0", answered=True),
        dict(base, ts="sai", msg_id="m6", answered=True)])
    _write_jsonl(tmp_path / "conversations.jsonl.1", [
        dict(base, ts="2026-09-20T00:00:00Z", msg_id="m7", answered=True)])
    c = om.read_convlog(tmp_path, _vn(2026, 10, 1), _vn(2026, 11, 1))
    assert c["exists"] is True
    assert [(q[1], q[2].startswith("cskh:")) for q in c["questions"]] == \
        [(True, True), (False, True), (False, True), (False, False)]
    assert c["questions"][3][2] == "convlog:m9"
    assert sorted(c["latencies"]) == [1200, 31000]
    assert c["earliest"] == datetime(2026, 9, 20, tzinfo=timezone.utc)
    assert c["stats"]["corrupt"] == 1 and c["stats"]["doc"] == 1
    empty = om.read_convlog(tmp_path / "none", _vn(2026, 10, 1),
                            _vn(2026, 11, 1))
    assert empty["exists"] is False and empty["questions"] == []


def test_read_runs(tmp_path):
    assert om.read_runs(None, "backup_runs.jsonl") is None
    assert om.read_runs(tmp_path, "backup_runs.jsonl") is None
    _write_jsonl(tmp_path / "backup_runs.jsonl", [
        {"_doc": "x"}, b"[1]",
        {"ts": "2026-10-02T01:30:00+07:00", "status": "ok", "offsite": "dir"},
        {"ts": "2026-10-03T01:30:00", "status": "ok"},          # thiếu múi giờ
        {"ts": "hỏng", "status": "ok"}, {"status": "ok"}])
    runs = om.read_runs(tmp_path, "backup_runs.jsonl")
    assert runs == [{"ts": _vn(2026, 10, 2, 1, 30), "status": "ok",
                     "offsite": "dir"}]
    (tmp_path / "dr_runs.jsonl").write_bytes(b"")
    assert om.read_runs(tmp_path, "dr_runs.jsonl") == []


def test_repo_facts():
    f = om.repo_facts()
    assert f["modules"] > 50 and f["tests"] > 50
    assert "runbook-ha-tang.md" in f["handover"]
    assert f["head"] is None or len(f["head"]) == 40
    assert om.repo_facts(Path("Z:/khong_co_repo_nay"))["head"] is None


# ------------------------------------------------------------------ render
def _facts(**kw):
    now = kw.pop("now", _vn(2026, 11, 2, 8))
    f = {"start": _vn(2026, 10, 1), "end": _vn(2026, 11, 1), "now": now,
         "assets": _assets(), "repo": {"head": "a" * 40, "modules": 1,
                                       "tests": 2, "handover": ["x.md"]},
         "conv": {"exists": False, "earliest": None, "questions": [],
                  "latencies": []},
         "shift": SHIFT, "backups": None, "drills": None, "db_ok": True,
         "db": {"alerts": [], "takedown": [],
                "posts": {"scans": 0, "unapproved": 0, "no_paper": 0},
                "cskh": [], "cost": []}}
    f.update(kw)
    return f


def _row(md: str, label: str) -> str:
    return next(ln for ln in md.splitlines() if ln.startswith(f"| {label}"))


def test_render_no_sources_says_no_data():
    md = om.render(_facts())
    assert "Hạn gửi Bên B: trước ngày 05/11/2026" in md
    assert "THÁNG CHƯA ĐÓNG" not in md
    assert "chưa có dữ liệu (không có convlog)" in _row(md, "Câu hỏi khách")
    for lb in ("Bài đăng chưa được duyệt", "Rượu/TPBVSK"):
        assert "không có lần rà kênh nào" in _row(md, lb)
    assert "— (không có mục tới hạn)" in _row(md, "Báo động đỏ")
    assert "chưa cấu hình `BACKUP_DIR`" in _row(md, "Backup")
    assert "chưa có nhật ký diễn tập" in _row(md, "Diễn tập")
    assert "chưa đo" in _row(md, "Phản hồi tự động")
    assert "0.0000 USD / 0 lời gọi" in _row(md, "Chi phí AI")
    assert "| Mã nguồn Dự án |" in md and "`" + "a" * 40 + "`" in md


def test_render_db_down_and_table_states():
    md = om.render(_facts(db_ok=False, db=None,
                          now=_vn(2026, 10, 20)))
    assert "THÁNG CHƯA ĐÓNG" in md and "DB không truy cập được" in md
    for lb in ("Báo động đỏ", "Lệnh gỡ bài", "Bài đăng chưa", "Chi phí AI"):
        assert "chưa có dữ liệu (DB không truy cập được)" in _row(md, lb)
    md = om.render(_facts(db={"alerts": om.MISSING,
                              "takedown": {"error": "QueryCanceled"},
                              "posts": om.MISSING, "cskh": om.MISSING,
                              "cost": om.MISSING},
                          conv={"exists": True, "earliest": None,
                                "questions": [], "latencies": []}))
    assert "chưa có bảng `red_alerts`" in _row(md, "Báo động đỏ")
    assert "lỗi đọc `channel_posts`: QueryCanceled" in _row(md, "Lệnh gỡ")
    assert "chưa có bảng `approval_queue`" in _row(md, "Câu hỏi khách")
    assert "chưa có bảng `llm_usage`" in _row(md, "Chi phí AI")


def test_render_values_and_verdicts():
    q = _vn(2026, 10, 14, 9)
    conv = {"exists": True, "earliest": _vn(2026, 10, 3),
            "questions": [(q, True, "cskh:a")] * 9 + [(q, False, "cskh:b")],
            "latencies": [1000] * 19 + [40000]}
    t = _vn(2026, 10, 10)
    db = {"alerts": [(1, t, t + timedelta(minutes=5)), (2, t, None)],
          "takedown": [("u", t, t + timedelta(hours=24),
                        t + timedelta(hours=3), "da_go")],
          "posts": {"scans": 4, "unapproved": 0, "no_paper": 2},
          "cskh": [], "cost": [("chat|bot\nx", 3, 1.5, 1)]}
    md = om.render(_facts(conv=conv, db=db, backups=[], drills=[]))
    r = _row(md, "Câu hỏi khách")
    assert "90.0% (9/10)" in r and "| Đạt |" in r          # đúng ngưỡng 90%
    assert "50.0% (1/2)" in _row(md, "Báo động đỏ")
    assert "KHÔNG ĐẠT" in _row(md, "Báo động đỏ") and "#2" in md
    assert "100.0% (1/1)" in _row(md, "Lệnh gỡ bài")
    # v13.7 (flip có chủ đích): 0 URL chỉ "Đạt trong phạm vi đã rà" + số lượt
    # rà — không suy toàn kênh/KOC/ads/livestream sạch.
    r = _row(md, "Bài đăng chưa được duyệt")
    assert f"| {om.SCOPE_OK} |" in r and "phạm vi: 4 lượt rà" in r
    assert "| Đạt |" not in r
    assert "2 URL" in _row(md, "Rượu/TPBVSK") and "KHÔNG ĐẠT" in \
        _row(md, "Rượu/TPBVSK")
    assert "Convlog chỉ còn từ 03/10/2026" in md
    assert "p95 1.0 giây; > 30 giây 1/20 (5.0%)" in _row(md, "Phản hồi")
    assert "1.5000 USD / 3 lời gọi" in _row(md, "Chi phí AI")
    assert "`chat/bot x`" in md and "chat|bot" not in md   # chống vỡ bảng
    assert "0/31 ngày (0.0%)" in _row(md, "Backup")
    assert "mốc 30/11/2026: chưa tới hạn" in _row(md, "Diễn tập")
    assert "https://" not in md                       # không chép URL bài


def test_render_cskh_below_target_and_shift_error():
    q = _vn(2026, 10, 14, 9)
    conv = {"exists": True, "earliest": None,
            "questions": [(q, True, "a")] * 8 + [(q, False, "b")] * 2,
            "latencies": []}
    assert "KHÔNG ĐẠT" in _row(om.render(_facts(conv=conv)), "Câu hỏi")
    md = om.render(_facts(conv=conv, shift=None, shift_error="ConfigError"))
    assert "ca làm việc lỗi: ConfigError" in _row(md, "Câu hỏi")


# ------------------------------------------------------------------ main
def test_main_usage_errors_write_nothing(tmp_path, monkeypatch, capsys):
    now = _vn(2026, 10, 15)
    assert om.main(["--month", "2026-13", "--out-dir", str(tmp_path)],
                   now=now) == 2
    assert om.main(["--month", "2026-11", "--out-dir", str(tmp_path)],
                   now=now) == 2
    bad = tmp_path / "a.json"
    bad.write_bytes(b"{}")
    monkeypatch.setattr(om, "ASSETS", bad)
    assert om.main(["--month", "2026-10", "--out-dir", str(tmp_path)],
                   now=now) == 2
    assert list(tmp_path.glob("van-hanh-*")) == []
    assert capsys.readouterr().out.count("[usage]") == 3


def test_main_db_down_still_writes_and_exit_1(tmp_path, monkeypatch):
    monkeypatch.setattr(om, "connect", lambda: None)
    monkeypatch.delenv("BACKUP_DIR", raising=False)
    rc = om.main(["--month", "2026-10", "--out-dir", str(tmp_path)],
                 now=_vn(2026, 11, 2), data_dir=tmp_path)
    assert rc == 1
    md = (tmp_path / "van-hanh-2026-10.md").read_bytes().decode("utf-8")
    assert "DB không truy cập được" in md and "\r\n" not in md


def test_main_reads_backup_dir_env(tmp_path, monkeypatch):
    bdir = tmp_path / "bk"
    bdir.mkdir()
    _write_jsonl(bdir / "backup_runs.jsonl", [
        {"ts": f"2026-10-{d:02d}T01:30:00+07:00", "status": "ok",
         "offsite": "dir"} for d in range(1, 32)])
    _write_jsonl(bdir / "drill_runs.jsonl", [
        {"ts": "2026-10-11T03:00:00+07:00", "status": "ok"}])
    monkeypatch.setenv("BACKUP_DIR", str(bdir))
    monkeypatch.setattr(om, "connect", lambda: None)
    om.main(["--month", "2026-10", "--out-dir", str(tmp_path)],
            now=_vn(2026, 11, 2), data_dir=tmp_path)
    md = (tmp_path / "van-hanh-2026-10.md").read_bytes().decode("utf-8")
    assert "31/31 ngày (100.0%); có bản sao ngoài 31 ngày" in md
    assert "Diễn tập 11/10/2026: ok." in md


# ------------------------------------------------------------------ DB thật
@pytest.fixture
def db():
    yield from ceo_db()


def _seed(db, start):
    for t, trg in (("red_alerts", "red_alerts_stamp_ins"),
                   ("red_alert_acks", "red_alert_acks_stamp_ins"),
                   ("approval_queue", "approval_queue_guard_row")):
        db.execute(f"alter table {t} disable trigger {trg}")
    a = start + timedelta(days=3)
    ids = [db.execute(
        "insert into red_alerts (ts, source_agent, title, detail) values"
        " (%s, 'x', 't', %s::jsonb) returning id", (ts, det)).fetchone()[0]
        for ts, det in ((a, "{}"), (a, "{}"), (a, '{"escalation_of": 1}'),
                        (start - timedelta(hours=1), "{}"))]
    db.execute("insert into red_alert_acks (alert_id, acked_by, acked_at)"
               " values (%s, 'Người A', %s)", (ids[0], a + timedelta(hours=1)))
    for url, first, closed, reason, codes, sev in (
            ("https://x/1", a, a + timedelta(hours=2), "da_go",
             ["thieu_ban_duyet"], "S2"),
            ("https://x/2", a, None, None, ["ruou_cam_quang_cao"], "S1"),
            ("https://x/3", start - timedelta(days=2), None, None,
             ["sku_chua_xnqc"], "S1")):
        db.execute(
            "insert into channel_posts (url, channel, content_type, is_ai,"
            " text, text_sha256, guardrail, codes, severity,"
            " first_detected_at, due_at, imported_by, scanned_at, closed_at,"
            " close_reason) values (%s, 'web', 'post', true, 'bài', %s, '{}',"
            " %s, %s, %s, %s, 'Người B', %s, %s, %s)",
            (url, "0" * 64, codes, sev, first, first + timedelta(hours=24),
             first, closed, reason))
    for oid, st, dec in (("cskh:g1", "approved", a),
                         ("cskh:g2", "expired", a),
                         ("cskh:g3", "pending", None),
                         ("cskh:g4", "rejected", start - timedelta(days=1))):
        db.execute(
            "insert into approval_queue (object_type, object_id, block, title,"
            " payload, content_sha256, risk, guardrail, created_by, due_at,"
            " status, decided_by, decided_at) values ('cskh_handoff', %s,"
            " 'sales', 't', 'p', %s, 'medium', '{}', 'agent:x', %s, %s, %s,"
            " %s)", (oid, "0" * 64, a, st, "Người C" if dec else None, dec))
    for ts, agent, cost, ok in ((a, "chatbot", 0.25, True),
                                (a, "chatbot", 0.5, False),
                                (a, "content", 1.0, True),
                                (start - timedelta(seconds=1), "chatbot",
                                 9.0, True)):
        db.execute("insert into llm_usage (ts, agent_id, model, cost_usd, ok)"
                   " values (%s, %s, 'm', %s, %s)", (ts, agent, cost, ok))
    return ids


def test_collect_db_counts_and_select_only(db):
    start, end = _vn(2026, 10, 1), _vn(2026, 11, 1)
    ids = _seed(db, start)
    log = []
    out = om.collect_db(TxConn(db, log), start, end)
    assert [r[0] for r in out["alerts"]] == ids[:2]       # bỏ leo thang/ngoài kỳ
    k = om.kpi_alerts(out["alerts"], _vn(2026, 11, 2))
    assert (k["ok"], k["late"], k["unacked"]) == (1, 1, [ids[1]])
    assert om.kpi_takedown(out["takedown"], _vn(2026, 11, 2)) == \
        {"ok": 1, "late": 1, "pending": 0}
    assert out["posts"] == {"scans": 2, "unapproved": 1, "no_paper": 1}
    assert sorted(o for o, _, _ in out["cskh"]) == ["cskh:g1"]
    assert [(a, n, float(c), e) for a, n, c, e in out["cost"]] == \
        [("content", 1, 1.0, 0), ("chatbot", 2, 0.75, 1)]  # chi phí giảm dần
    assert log and all(s.lstrip().lower().startswith("select") for s in log)


def test_collect_db_missing_tables(db):
    db.execute(f"create schema t_b6_{uuid.uuid4().hex[:8]}")
    sch = db.execute("select nspname from pg_namespace where nspname like"
                     " 't_b6_%' order by oid desc limit 1").fetchone()[0]
    db.execute(f"set local search_path to {sch}, pg_temp")
    out = om.collect_db(TxConn(db), _vn(2026, 10, 1), _vn(2026, 11, 1))
    assert all(v == om.MISSING for v in out.values())
    assert db.execute("select 1").fetchone() == (1,)      # conn vẫn dùng được
