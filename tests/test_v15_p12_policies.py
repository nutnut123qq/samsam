# ruff: noqa: F811 — fixture pytest nhập từ file test khác (db)
"""v15 P12 — cơ chế cho các quyết định "chưa giao — chờ quyết" (bảng A2).

Mọi mã: xây CƠ CHẾ + mặc định CHƯA CẤU HÌNH/CHƯA DUYỆT rõ ràng và CHẶN hành
động tương ứng — không tự chọn chính sách thay người quyết.

P12.1 loader nạp file: chính sách cổng tắt theo loader (`data/loader_gate.
      json`); chưa cấu hình + tính năng tắt → không nạp (8 loader).
P12.2 `red_alert --escalate` lần đầu: cảnh báo TỒN không tự leo thang khi
      chưa có quyết định; xem trước/phân trang; trần 50; idempotent.
P12.3 leo thang cấp 2 / người trực ngoài giờ theo cấu hình; chưa cấu hình →
      báo rõ, không tự chọn người.
P12.4 từ khóa thương hiệu/xuất xứ đối thủ: danh sách chưa duyệt → "chờ
      quyết", không tự cho qua.
P12.5 mã đối tác lạ: `tu_choi_file` / `ghi_vi_pham`; chưa chọn → từ chối cả
      file + thông báo rõ.

DB thật: schema tạm + rollback (fixture `db` của test_v14_p5).
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from agents import ra_kenh
from pipelines import auth, guardrail, loader_gate, rollout
from pipelines import red_alert as ra
from tests.test_v14_p5_mkt_ceo_intel import (  # noqa: F401 — fixture db
    INTEL,
    NOW,
    OK_TEXT,
    URL1,
    URL2,
    _prow,
    _queue,
    _TxConn,
    db,
    iw,
)

ROOT = Path(__file__).resolve().parent.parent
VN = timezone(timedelta(hours=7))


class Reached(Exception):
    """Loader đã đi QUA cổng (tới bước kết nối/ghi đầu tiên)."""


def _boom(*a, **k):
    raise Reached()


# ============================================================ P12.1 loader
def _gate_cfg(tmp_path, **pol):
    """Bản sao cấu hình repo, đổi chính sách vài loader."""
    d = json.loads((ROOT / "data" / "loader_gate.json").read_text("utf-8"))
    for name, p in pol.items():
        d["loaders"][name].update(
            {"chinh_sach": p, "chot_boi": "Chủ Khối Giả Lập",
             "can_cu": "Biên bản giả lập số 1"} if p else {"chinh_sach": p})
    f = tmp_path / "loader_gate.json"
    f.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return f


def test_p12_1_repo_config_all_unset_and_matches_catalog():
    """Mặc định repo = CHƯA CẤU HÌNH cho cả 8 loader (không ai chọn thay);
    `features` khớp `modules` của danh mục (drift-guard)."""
    cfg = loader_gate.load_config()
    assert set(cfg) == set(loader_gate.LOADERS)
    assert all(c["policy"] is None and c["chot_boi"] is None
               for c in cfg.values())
    feats = rollout.load_features()
    for name, c in cfg.items():
        mod = loader_gate.MODULES[name]
        assert (ROOT / mod).is_file()
        owners = {f["id"] for f in feats if mod in f["modules"]}
        assert set(c["features"]) == owners, name


@pytest.mark.parametrize("stages, pol, ok", [
    ({"a-01": "chay_thu", "b-02": "van_hanh"}, None, True),
    ({"a-01": "tat", "b-02": "van_hanh"}, None, False),
    ({"a-01": "tat"}, "chan_khi_tat", False),
    ({"a-01": "van_hanh"}, "chan_khi_tat", True),
    ({"a-01": "tat"}, "nap_ca_khi_tat", True),
])
def test_p12_1_decide(stages, pol, ok):
    got, why = loader_gate.decide(pol, stages)
    assert got is ok
    if pol is None:
        assert "CHƯA CẤU HÌNH" in why
    if not ok:
        assert "KHÔNG nạp" in why


@pytest.mark.parametrize("mutate, frag", [
    (None, "không có file"),
    ("{", "hỏng"),
    ("{}", "thiếu object"),
    ({"drop": "lead_store"}, "loader thiếu"),
    ({"add": "la_loader"}, "lạ"),
    ({"set": ("market_csv", "features", [])}, "features"),
    ({"set": ("market_csv", "features", ["khong-99"])}, "features"),
    ({"set": ("market_csv", "chinh_sach", "tu_do")}, "không hợp lệ"),
    ({"set": ("market_csv", "chinh_sach", "nap_ca_khi_tat")}, "chot_boi"),
    ({"set2": ("market_csv", "agent:ai", "x")}, "chot_boi"),
])
def test_p12_1_bad_config_blocks_every_loader(tmp_path, mutate, frag):
    f = tmp_path / "loader_gate.json"
    d = json.loads((ROOT / "data" / "loader_gate.json").read_text("utf-8"))
    if isinstance(mutate, str):
        f.write_text(mutate, encoding="utf-8")
    elif mutate is not None:
        if "drop" in mutate:
            d["loaders"].pop(mutate["drop"])
        if "add" in mutate:
            d["loaders"][mutate["add"]] = d["loaders"]["market_csv"]
        if "set" in mutate:
            n, k, v = mutate["set"]
            d["loaders"][n][k] = v
        if "set2" in mutate:
            n, by, ref = mutate["set2"]
            d["loaders"][n].update({"chinh_sach": "chan_khi_tat",
                                    "chot_boi": by, "can_cu": ref})
        f.write_text(json.dumps(d), encoding="utf-8")
    for name in loader_gate.LOADERS:
        why = loader_gate.check(name, path=f)
        assert why and "hỏng" in why and frag in why, (name, why)


def _enter(monkeypatch, tmp_path, name):
    """Chạy main() của loader tới bước kết nối/ghi đầu tiên (→ Reached)."""
    monkeypatch.setattr(auth, "bind_service", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:1/x")
    if name == "market_csv":
        from ingest import market_csv as m
        monkeypatch.setattr(m, "load_mapping", lambda: ({}, None))
        monkeypatch.setattr(m, "read_export", lambda *a: ([], [], "a" * 64))
        monkeypatch.setattr(m, "_connect", _boom)
        return lambda: m.main(["--file", "x.csv", "--channel", "shopee",
                               "--kind", "listing"])
    if name == "golden_store":
        from ingest import golden_store as m
        monkeypatch.setattr(m, "read_golden", lambda p: ({}, None))
        monkeypatch.setattr(m, "validate", lambda d: [])
        monkeypatch.setattr(m, "_connect", _boom)
        return lambda: m.main([])
    if name == "embed_store":
        from ingest import embed_store as m
        monkeypatch.setattr(m, "load_env", _boom)
        return m.main
    if name == "kb_internal":
        from ingest import kb_internal as m
        f = tmp_path / "quy-trinh.md"
        f.write_text("# Quy trình nội bộ\n\nNội dung.\n", encoding="utf-8")

        class _C:
            def close(self):
                pass
        monkeypatch.setattr(m, "connect", lambda: _C())
        monkeypatch.setattr(m, "ingest_doc", _boom)     # bước GHI đầu tiên
        monkeypatch.setattr(auth, "cli_gate", lambda *a, **k: None)
        return lambda: m.main(["--file", str(f), "--collection",
                               "internal:sx", "--approved-by",
                               "Trưởng Phòng Giả Lập"])
    if name == "doc_intake":
        from ingest import doc_intake as m

        class _C:
            def close(self):
                pass
        monkeypatch.setattr(m.lead_store, "connect", lambda: _C())
        monkeypatch.setattr(m, "intake", _boom)
        monkeypatch.setenv("OCR_PROVIDER", "none")
        return lambda: m.main([])
    if name == "agent_eval":
        from scripts import agent_eval as m

        class _C:
            def close(self):
                pass
        monkeypatch.setattr(m, "load_suite", lambda a: {
            "status": "active", "runner": "guardrail", "prompt_files": []})
        monkeypatch.setattr(m, "agent_model_of", lambda s: "m")
        monkeypatch.setattr(m, "judge_preflight", lambda s, mo: None)
        monkeypatch.setattr(m, "_git_head", lambda: "a" * 40)
        monkeypatch.setattr(m, "_git_dirty", lambda i: False)
        monkeypatch.setattr(m, "_connect", lambda: _C())
        monkeypatch.setattr(m, "preflight_db", _boom)
        return lambda: m.run_agent("guardrail")
    if name == "lead_store":
        from ingest import lead_store as m
        monkeypatch.setattr(m, "harvest", _boom)
        return m.main
    if name == "dealer_price":
        from ingest import dealer_price as m
        monkeypatch.setattr(m, "read_dealer_file",
                            lambda *a: ([], [], "b" * 64))
        monkeypatch.setattr(m, "connect", _boom)
        return lambda: m.main(["--file", "x.csv", "--by", "Người Quan Sát"])
    raise AssertionError(name)


@pytest.mark.parametrize("name", loader_gate.LOADERS)
def test_p12_1_each_loader_unset_policy_off_feature_blocks(
        name, monkeypatch, tmp_path, capsys):
    """Probe: tính năng TẮT + chính sách CHƯA CẤU HÌNH → code cũ vẫn kết
    nối/ghi (loader không qua cổng). Nay: exit 2, không chạm DB, lý do rõ."""
    run = _enter(monkeypatch, tmp_path, name)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    assert run() == 2
    out = capsys.readouterr().out
    assert "CHƯA CẤU HÌNH" in out and "KHÔNG nạp" in out, out


@pytest.mark.parametrize("name", loader_gate.LOADERS)
def test_p12_1_each_loader_policies(name, monkeypatch, tmp_path, capsys):
    """2 chế độ đã chọn: chan_khi_tat chặn; nap_ca_khi_tat vẫn nạp khi tắt;
    tính năng KHÔNG tắt + chưa cấu hình → nạp (in rõ chưa cấu hình)."""
    run = _enter(monkeypatch, tmp_path, name)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    monkeypatch.setattr(loader_gate, "CONFIG",
                        _gate_cfg(tmp_path, **{name: "chan_khi_tat"}))
    assert run() == 2
    monkeypatch.setattr(loader_gate, "CONFIG",
                        _gate_cfg(tmp_path, **{name: "nap_ca_khi_tat"}))
    with pytest.raises(Reached):
        run()
    assert "vẫn nạp theo chính sách" in capsys.readouterr().out
    monkeypatch.setattr(loader_gate, "CONFIG", _gate_cfg(tmp_path))
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")
    with pytest.raises(Reached):
        run()
    assert "CHƯA CẤU HÌNH" in capsys.readouterr().out


def test_p12_1_reads_stage_from_db(db, monkeypatch):
    """Giai đoạn đọc thật từ `feature_rollout` qua `rollout.mode`; không mở
    được DB → chặn (không đoán)."""
    monkeypatch.setattr(rollout, "_FORCE_MODE", None)
    monkeypatch.setattr(rollout, "enforce_enabled", lambda *a: True)
    tx = _TxConn(db)
    db.execute("insert into feature_rollout (feature_id, stage,"
               " updated_by) values ('sales-06.1', 'tat', 'x')")
    why = loader_gate.check("dealer_price", tx)
    assert why and "sales-06.1" in why
    db.execute("update feature_rollout set stage = 'van_hanh'")
    assert loader_gate.check("dealer_price", tx) is None
    import ingest.lead_store as ls
    monkeypatch.setattr(ls, "connect", lambda *a: None)
    why = loader_gate.check("dealer_price")
    assert why and "không kết nối được DB" in why


def test_p12_1_status_cli(capsys, monkeypatch):
    import ingest.lead_store as ls
    monkeypatch.setattr(ls, "connect", lambda *a: None)
    assert loader_gate.main(["--status"]) == 0
    out = capsys.readouterr().out
    assert "8 loader, 8 chưa cấu hình" in out


# ============================================================ P12.2 tồn
def _alerts(db, n, ts, src="agents.sales_director"):
    """Cảnh báo gốc có giờ cố định (tắt trigger đóng dấu giờ trong tx test
    — rollback cuối test)."""
    db.execute("alter table red_alerts disable trigger red_alerts_stamp_ins")
    ids = [db.execute(
        "insert into red_alerts (ts, source_agent, title, detail, recipients,"
        " db_role) values (%s, %s, %s, '{}', '{}', session_user)"
        " returning id", (ts, src, f"Sự cố {i}")).fetchone()[0]
        for i in range(n)]
    db.execute("alter table red_alerts enable trigger red_alerts_stamp_ins")
    return ids


def _t0(db):
    return db.execute("select now()").fetchone()[0]


def _escalated(db, suffix=""):
    return [r[0] for r in db.execute(
        "select (detail->>'escalation_of') from red_alerts where detail ?"
        " 'escalation_of' and (detail->>'escalation_of') like %s order by id",
        (f"%{suffix}",)).fetchall()]


NOBODY = {"recipients": []}
POL_LEO = {"recipients": [], "backlog": {
    "chinh_sach": "leo_thang_dan", "quyet_boi": "Người Bên B Giả Lập",
    "can_cu": "Biên bản giả lập"}}


def test_p12_2_first_run_holds_backlog_and_keeps_new_alerts(db):
    """Probe: 120 cảnh báo cũ chưa xác nhận + 3 cảnh báo mới → code cũ leo
    thang 50 cảnh báo CŨ NHẤT (tự gửi tồn) và bỏ đói 3 cảnh báo mới (ngoài
    trang 50). Nay: tồn giữ nguyên chờ Bên B, 3 cảnh báo mới leo thang."""
    tx = _TxConn(db)
    t0 = _t0(db)
    back = _alerts(db, 120, t0 - timedelta(hours=3))
    new = _alerts(db, 3, t0 - timedelta(hours=1))
    now = t0 + timedelta(hours=1, minutes=1)
    st = ra.escalate(tx, now, routing=NOBODY)
    assert st["ids"] == new
    assert st["backlog"]["total"] == 120 and st["backlog"]["held"] == 120
    assert st["backlog"]["escalated"] == [] and st["backlog"]["policy"] is None
    assert set(_escalated(db)) == {str(i) for i in new}
    again = ra.escalate(tx, now + timedelta(days=2), routing=NOBODY)
    assert again["escalated"] == 0 and again["backlog"]["held"] == 120
    assert len(_escalated(db)) == 3                      # idempotent
    n = db.execute("select count(*) from agent_action_log where action = %s",
                   (ra.START_ACTION,)).fetchone()[0]
    assert n == 1 and back                               # mốc ghi 1 lần


def test_p12_2_dry_run_writes_nothing_and_pages_cover_all(db):
    tx = _TxConn(db)
    t0 = _t0(db)
    back = _alerts(db, 120, t0 - timedelta(hours=3))
    count = ("select (select count(*) from red_alerts),"
             " (select count(*) from agent_action_log)")
    before = db.execute(count).fetchone()
    now = t0 + timedelta(minutes=1)
    seen, after = [], 0
    for _ in range(5):
        st = ra.escalate(tx, now, routing=POL_LEO, dry_run=True, after=after)
        assert st["start"] is None                       # chưa bật lần nào
        seen += st["backlog"]["page"]
        if st["backlog"]["next_after"] is None:
            break
        after = st["backlog"]["next_after"]
    assert seen == back                                 # đủ, không trùng
    assert st["backlog"]["escalated"] == back[:50]      # lần tới: cũ trước
    assert db.execute(count).fetchone() == before       # không ghi gì


def test_p12_2_policy_leo_thang_dan_pages_50_per_run(db):
    tx = _TxConn(db)
    t0 = _t0(db)
    back = _alerts(db, 120, t0 - timedelta(hours=3))
    new = _alerts(db, 3, t0 - timedelta(hours=1))
    now = t0 + timedelta(hours=1, minutes=1)
    got = []
    for want_new, want_back in ((3, 47), (0, 50), (0, 23), (0, 0)):
        st = ra.escalate(tx, now, routing=POL_LEO)
        assert len(st["ids"]) == want_new + want_back <= ra.ESC_MAX_PER_RUN
        assert len(st["backlog"]["escalated"]) == want_back
        got += st["backlog"]["escalated"]
    assert got == back                                  # cũ trước, đủ, 1 lần
    rows = db.execute("select detail from red_alerts where detail ->>"
                      " 'backlog' = 'true'").fetchall()
    assert len(rows) == 120
    assert rows[0][0]["backlog_quyet_boi"] == "Người Bên B Giả Lập"
    assert new


@pytest.mark.parametrize("backlog, frag", [
    ({"chinh_sach": "khong_leo_thang", "quyet_boi": "Người B",
      "can_cu": "BB 1"}, None),
    ({"chinh_sach": "leo_thang_dan"}, "thiếu quyet_boi"),
    ({"chinh_sach": "leo_thang_dan", "quyet_boi": "agent:x",
      "can_cu": "BB"}, "thiếu quyet_boi"),
    ({"chinh_sach": "gui_het"}, "không hợp lệ"),
])
def test_p12_2_other_policies_never_send_backlog(db, backlog, frag):
    tx = _TxConn(db)
    t0 = _t0(db)
    _alerts(db, 5, t0 - timedelta(hours=3))
    st = ra.escalate(tx, t0 + timedelta(minutes=1),
                     routing={"recipients": [], "backlog": backlog})
    assert st["backlog"]["escalated"] == [] and st["backlog"]["held"] == 5
    assert _escalated(db) == []
    if frag:
        assert any(frag in p for p in st["problems"])


def test_p12_2_cli_dry_run_and_usage(db, monkeypatch, capsys):
    import ingest.lead_store as ls
    monkeypatch.setattr(ls, "connect", lambda: _TxConn(db))
    t0 = _t0(db)
    _alerts(db, 2, t0 - timedelta(hours=3))
    assert ra.main(["--escalate", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "KHÔNG ghi/gửi gì" in out and "tồn: tổng 2" in out
    assert "CHƯA QUYẾT" in out
    assert _escalated(db) == []
    for argv in (["--escalate", "--after", "5"], ["--open", "--dry-run"]):
        with pytest.raises(SystemExit) as e:
            ra.main(argv)
        assert e.value.code == 2


# ============================================================ P12.3 cấp 2
BKS = {"name": "BKS Giả Lập", "role": "bks", "channel": "email:$BKS_MAIL"}
PC = {"name": "Pháp Chế Giả Lập", "role": "phap_che",
      "channel": "email:$PC_MAIL"}
TRUC = {"name": "Người Trực Giả Lập", "role": "bks",
        "channel": "email:$TRUC_MAIL"}
GIO = {"thu": [0, 1, 2, 3, 4], "tu": "08:00", "den": "17:30",
       "ngay_nghi": ["2026-12-31"]}


def test_p12_3_unconfigured_reports_and_never_picks_people(db, capsys):
    tx = _TxConn(db)
    t0 = _t0(db)
    _alerts(db, 1, t0 - timedelta(hours=1))
    for h in (1.1, 30):
        st = ra.escalate(tx, t0 + timedelta(hours=h),
                         routing={"recipients": [PC]}, sender=lambda *a: 0)
        assert st["cap2_ids"] == [] and st["off_hours"] is False
    assert _escalated(db, ":cap2") == []
    t = ra.tiers(ra.load_routing())
    assert t["cap2"] is None and t["ngoai_gio"] is None
    lines = "\n".join(ra.tier_lines(t))
    assert "cấp 2 CHƯA CẤU HÌNH" in lines and "trực ngoài giờ CHƯA CẤU HÌNH"\
        in lines and "CHƯA QUYẾT" in lines
    assert ra._check_routing() == 1
    assert "CHƯA CẤU HÌNH" in capsys.readouterr().out


def test_p12_3_cap2_after_configured_minutes_once(db, monkeypatch):
    monkeypatch.setenv("PC_MAIL", "pc@example.test")
    monkeypatch.setenv("BKS_MAIL", "bks@example.test")
    sent = []

    def send(to, subj, body):
        sent.append((to, subj))
    tx = _TxConn(db)
    t0 = _t0(db)
    a1, a2 = _alerts(db, 2, t0 - timedelta(hours=1))
    routing = {"recipients": [PC], "cap2": {"sau_phut": 30,
                                            "recipients": [BKS]}}
    now = t0 + timedelta(hours=1, minutes=1)
    assert ra.escalate(tx, now, routing=routing, sender=send)["ids"] == [a1, a2]
    assert ra.ack(tx, a2, "Pháp Chế Giả Lập")[0] is True
    # bản cấp 1 ghi lúc t0 (giờ DB) → cấp 2 khi now ≥ t0 + 30 phút
    st = ra.escalate(tx, t0 + timedelta(minutes=29), routing=routing,
                     sender=send)
    assert st["cap2_ids"] == []
    sent.clear()
    st = ra.escalate(tx, t0 + timedelta(minutes=31), routing=routing,
                     sender=send)
    assert st["cap2_ids"] == [a1]                      # a2 đã xác nhận
    assert [to for to, _ in sent] == ["bks@example.test"]
    row = db.execute("select title, detail, recipients from red_alerts where"
                     " detail->>'escalation_of' = %s", (f"{a1}:cap2",)
                     ).fetchone()
    assert row[0].startswith(ra.CAP2_PREFIX) and row[2] == ["BKS Giả Lập"]
    assert row[1]["escalation_root"] == a1 and row[1]["level"] == 2
    again = ra.escalate(tx, t0 + timedelta(days=1), routing=routing,
                        sender=send)
    assert again["cap2_ids"] == [] and len(_escalated(db, ":cap2")) == 1
    cap2_id = db.execute("select id from red_alerts where detail->>"
                         "'escalation_of' = %s", (f"{a1}:cap2",)).fetchone()[0]
    ok, msg = ra.ack(tx, cap2_id, "Pháp Chế Giả Lập")
    assert ok is False and f"#{a1}" in msg and ":cap2" not in msg


@pytest.mark.parametrize("cap2, frag", [
    ({"sau_phut": 30, "recipients": [{**BKS, "role": "tgd"}]},
     "không có người nhận hợp lệ"),
    ({"sau_phut": 0, "recipients": [BKS]}, "sau_phut"),
    ({"sau_phut": None, "recipients": [BKS]}, "sau_phut"),
    ({"sau_phut": 30, "recipients": []}, "không có người nhận hợp lệ"),
])
def test_p12_3_partial_cap2_is_problem_not_guess(cap2, frag):
    c, probs = ra.cap2_cfg(cap2, ())
    assert c is None and any(frag in p for p in probs)


@pytest.mark.parametrize("when, off", [
    (datetime(2026, 10, 16, 10, 0, tzinfo=VN), False),    # thứ Sáu 10:00
    (datetime(2026, 10, 16, 17, 30, tzinfo=VN), True),    # hết giờ
    (datetime(2026, 10, 16, 7, 59, tzinfo=VN), True),
    (datetime(2026, 10, 17, 10, 0, tzinfo=VN), True),     # thứ Bảy
    (datetime(2026, 12, 31, 10, 0, tzinfo=VN), True),     # ngày nghỉ
    (datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc), False),  # 10:00 VN
])
def test_p12_3_off_hours_rule(when, off):
    c, probs = ra.off_hours_cfg({"gio_lam_viec": GIO, "nguoi_truc": [TRUC]},
                                ())
    assert probs == [] and ra.is_off_hours(c, when) is off


def test_p12_3_off_hours_adds_duty_person(db, monkeypatch):
    for k in ("PC_MAIL", "TRUC_MAIL"):
        monkeypatch.setenv(k, f"{k.lower()}@example.test")
    sent = []
    tx = _TxConn(db)
    t0 = _t0(db)
    routing = {"recipients": [PC], "ngoai_gio": {"gio_lam_viec": GIO,
                                                 "nguoi_truc": [TRUC]}}
    sat = (t0 + timedelta(days=8)).astimezone(VN)
    sat = sat + timedelta(days=(5 - sat.weekday()) % 7)
    sat = sat.replace(hour=10, minute=0)                  # thứ Bảy 10:00
    a = _alerts(db, 1, t0 - timedelta(hours=1))
    st = ra.escalate(tx, sat, routing=routing,
                     sender=lambda to, s, b: sent.append(to))
    assert st["ids"] == a and st["off_hours"] is True
    assert sorted(sent) == ["pc_mail@example.test", "truc_mail@example.test"]
    rec = db.execute("select recipients, detail from red_alerts where"
                     " detail->>'escalation_of' = %s", (str(a[0]),)).fetchone()
    assert rec[0] == ["Pháp Chế Giả Lập", "Người Trực Giả Lập"]
    assert rec[1]["ngoai_gio"] is True
    # trong giờ → chỉ người nhận cấp 1
    b = _alerts(db, 1, t0 - timedelta(hours=1))
    fri = sat - timedelta(days=1)
    sent.clear()
    ra.escalate(tx, fri, routing=routing,
                sender=lambda to, s, b_: sent.append(to))
    assert sent == ["pc_mail@example.test"] and b


# ============================================================ P12.4 đối thủ
def _comp(tmp_path, **kw):
    d = json.loads((ROOT / "data" / "keyword_competitors.json")
                   .read_text("utf-8"))
    d.update(kw)
    f = tmp_path / "kc.json"
    f.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return iw.load_competitors(f)


def _trends_comp(db, name="related_2.csv"):
    import uuid
    iid = db.execute("insert into intel_imports (kind, file_name,"
                     " file_sha256, row_count) values ('trend_related', %s,"
                     " %s, 4) returning id",
                     (name, uuid.uuid4().hex * 2)).fetchone()[0]
    for seed, sec, q, v in (
            ("nhân sâm", "rising", "hộp quà sâm biếu tết", "+250%"),
            ("nhân sâm", "top", "nhân sâm hàn quốc", "100"),
            ("nhân sâm", "top", "nhan sam han quoc 6 nam", "90"),
            ("hồng sâm kgc", "rising", "hồng sâm KGC chính hãng", "+80%")):
        db.execute("insert into trends_related (import_id, seed, section,"
                   " query, value) values (%s, %s, %s, %s, %s)",
                   (iid, seed, sec, q, v))
    return iid


def test_p12_4_repo_list_unapproved():
    c = iw.load_competitors()
    assert c["approved"] is False and c["action"] is None and c["by"] is None
    assert iw.competitor_hit("Nhân Sâm Hàn Quốc", c) == "han quoc"
    assert iw.competitor_hit("hồng sâm", c) is None
    assert iw.competitor_hit("mỹ phẩm sâm", c) is None    # theo từ, không chuỗi con


def test_p12_4_unapproved_list_keeps_competitor_keywords_pending(db):
    """Probe: code cũ coi 'nhân sâm hàn quốc' là AN TOÀN, đưa vào danh sách
    đề xuất. Nay: danh sách chưa duyệt → nhóm CHỜ QUYẾT, không tự cho qua."""
    iid = _trends_comp(db)
    r = iw.suggest_keywords(_TxConn(db), iid, INTEL)
    safe = [s[3] for s in r["res"]["safe"]]
    assert safe == ["hộp quà sâm biếu tết"]
    assert [q for _i, q, _t in r["res"]["cho_quyet"]] == [
        "nhân sâm hàn quốc", "nhan sam han quoc 6 nam",
        "hồng sâm KGC chính hãng"]
    payload = _queue(db, "keyword_suggest")[0][4]
    head, _, pend = payload.partition("CHỜ QUYẾT")
    assert "hàn quốc" not in head and "KGC" not in head
    assert "(gốc: nhân sâm)" in head            # gốc không phải đối thủ: giữ
    assert "nhân sâm hàn quốc" in pend and "CHƯA được Pháp chế" in pend
    assert guardrail.check(payload)["ok"] is True
    assert _queue(db, "keyword_suggest")[0][2] == f"kw:{iid}"


def test_p12_4_approved_policies(db, tmp_path, monkeypatch):
    iid = _trends_comp(db)
    ok = {"trang_thai": "da_duyet", "duyet_boi": "Pháp Chế Giả Lập",
          "can_cu": "Biên bản giả lập"}
    loai = _comp(tmp_path, **ok, xu_ly="loai")
    res = iw.keyword_suggestions(_TxConn(db), iid, loai)
    assert res["cho_quyet"] == [] and len(res["excluded"]) == 3
    assert all("doi_thu" in why for _i, why in res["excluded"])
    hold = _comp(tmp_path, **ok, xu_ly="cho_nguoi_quyet")
    res = iw.keyword_suggestions(_TxConn(db), iid, hold)
    assert len(res["cho_quyet"]) == 3 and res["excluded"] == []
    # danh sách đã duyệt → đợt mới tách khỏi đợt chưa duyệt
    monkeypatch.setattr(iw, "load_competitors", lambda *a: loai)
    r = iw.suggest_keywords(_TxConn(db), iid, INTEL)
    assert r["object_id"] == f"kw:{iid}:dt-{loai['sha'][:8]}"
    assert "thương hiệu/xuất xứ đối thủ 3" in r["payload"]


@pytest.mark.parametrize("body", [
    None, "{", "[]", {"trang_thai": "chua_duyet", "danh_sach": []},
    {"trang_thai": "da_duyet", "danh_sach": ["korea"], "xu_ly": "loai",
     "can_cu": "x"},
    {"trang_thai": "da_duyet", "danh_sach": ["korea"], "xu_ly": "loai",
     "duyet_boi": "agent:intel", "can_cu": "x"},
    {"trang_thai": "da_duyet", "danh_sach": ["korea"], "xu_ly": "cho_qua",
     "duyet_boi": "Người", "can_cu": "x"},
    {"trang_thai": "tu_duyet", "danh_sach": ["korea"]},
])
def test_p12_4_bad_list_fail_closed(tmp_path, body):
    f = tmp_path / "kc.json"
    if body is not None:
        f.write_text(body if isinstance(body, str) else json.dumps(body),
                     encoding="utf-8")
    with pytest.raises(iw.KeywordConfigError):
        iw.load_competitors(f)


# ============================================================ P12.5 đối tác
def _ppol(tmp_path, pol, by="GĐ Marketing Giả Lập", ref="QĐ giả lập 1"):
    f = tmp_path / "partner_policy.json"
    f.write_text(json.dumps({"ma_doi_tac_la": {
        "chinh_sach": pol, "chon_boi": by, "can_cu": ref}},
        ensure_ascii=False), encoding="utf-8")
    return f


def _mixed(tmp_path):
    return _prow(tmp_path, (f"KOC-MAU-02,{URL1},tiktok,\"{OK_TEXT}\","
                            "2026-10-13,\n"
                            f"KOL-NGOAI-99,{URL2},tiktok,\"{OK_TEXT}\","
                            "2026-10-13,\n"), "mixed.csv")


def test_p12_5_unset_policy_rejects_whole_file_with_clear_notice(db, tmp_path):
    """Chưa chọn → giữ hành vi an toàn (cả file lỗi, 0 dòng) + thông báo rõ
    chưa chọn chính sách (code cũ: lỗi không nói gì về chính sách)."""
    pol, warn = ra_kenh.unknown_partner_policy()
    assert pol == "tu_choi_file" and "CHƯA CHỌN" in warn
    with pytest.raises(ra_kenh.UnknownPartner) as e:
        ra_kenh.ingest_partner(_TxConn(db), _mixed(tmp_path), by="Lan MXH",
                               now=NOW)
    assert "CHƯA CHỌN" in e.value.warn and "tu_choi_file" in str(e.value)
    assert db.execute("select count(*) from partner_post_scans"
                      ).fetchone()[0] == 0


@pytest.mark.parametrize("pol, by, ref", [
    ("ghi_het", "GĐ", "x"), ("ghi_vi_pham", "agent:mkt", "x"),
    ("ghi_vi_pham", "", "x"), ("ghi_vi_pham", "GĐ", ""),
])
def test_p12_5_bad_choice_falls_back_safe(tmp_path, pol, by, ref):
    got, warn = ra_kenh.unknown_partner_policy(_ppol(tmp_path, pol, by, ref))
    assert got == "tu_choi_file" and "mặc định an toàn" in warn
    assert ra_kenh.unknown_partner_policy(tmp_path / "khong.json")[0] == \
        "tu_choi_file"


def test_p12_5_explicit_tu_choi_file(db, tmp_path):
    f = _ppol(tmp_path, "tu_choi_file")
    with pytest.raises(ra_kenh.UnknownPartner) as e:
        ra_kenh.ingest_partner(_TxConn(db), _mixed(tmp_path), by="Lan MXH",
                               now=NOW, policy_path=f)
    assert e.value.warn is None
    assert db.execute("select count(*) from partner_post_scans"
                      ).fetchone()[0] == 0


def test_p12_5_ghi_vi_pham_records_violation(db, tmp_path):
    f = _ppol(tmp_path, "ghi_vi_pham")
    tx = _TxConn(db)
    st = ra_kenh.ingest_partner(tx, _mixed(tmp_path), by="Lan MXH", now=NOW,
                                policy_path=f)
    assert st["unknown"] == ["KOL-NGOAI-99"] and st["policy_warn"] is None
    assert (st["new"], st["S2"], st["tickets"]) == (2, 2, 2)
    rows = db.execute("select partner_code, codes, severity, is_sample,"
                      " queue_id from partner_post_scans order by id"
                      ).fetchall()
    unk = next(r for r in rows if r[0] == "KOL-NGOAI-99")
    assert ra_kenh.UNKNOWN_PARTNER in unk[1] and unk[2] == "S2"
    assert unk[3] is False and unk[4] is not None
    q = {r[2]: r for r in _queue(db, "partner_post_review")}
    payload = next(r[4] for oid, r in q.items() if "KOL-NGOAI-99" in oid)
    assert ra_kenh.UNKNOWN_PARTNER in payload
    # nạp lại y hệt → idempotent
    st2 = ra_kenh.ingest_partner(tx, _mixed(tmp_path), by="Lan MXH", now=NOW,
                                 policy_path=f)
    assert (st2["new"], st2["skip"], st2["tickets"]) == (0, 2, 0)


def test_p12_5_cli_prints_policy_notice(db, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(ra_kenh, "connect", lambda: _TxConn(db))
    p = tmp_path / "f.csv"
    p.write_bytes(("ma_doi_tac,url,kenh,text,ngay_dang,sku\n"
                   f"KOL-NGOAI-99,{URL2},tiktok,abc,2026-10-13,\n")
                  .encode())
    assert ra_kenh.main(["--partner-file", str(p), "--by", "Lan MXH"]) == 1
    out = capsys.readouterr().out
    assert "tu_choi_file" in out and "CHƯA CHỌN" in out
