"""Đợt an toàn + nghiệm thu A01 — `pipelines.acceptance` (ma trận 96 mục).

Hành vi: không mục nào READY_FOR_TRIAL khi thiếu điều kiện áp dụng (môi trường
Bên B, lịch nghỉ, người nhận cảnh báo, người duyệt khối, login người, mã đủ,
nguồn đếm không trùng, blocker, DPIA); đủ điều kiện mới READY; đếm theo mẫu số
96 = 89 AI + 7; không tính "đã nghiệm thu" từ test dev."""

import json
import shutil
import uuid
from pathlib import Path

import pytest

from pipelines import acceptance as acc

ROOT = Path(__file__).resolve().parent.parent


def test_repo_state_nothing_ready_nothing_accepted():
    rs = acc.rows()
    s = acc.summary(rs)
    assert (s["mau_so"], s["tinh_nang_ai"], s["hang_muc_khac"]) == (96, 89, 7)
    assert s["ready_for_trial"] == 0 and s["da_nghiem_thu"] == 0
    assert s["du_ho_so"] == 0
    env = acc.env_state()
    assert all(env.values())          # E1–E3 đều thiếu ở repo hiện tại
    for r in rs:
        assert r["status"] == acc.NOT_READY and r["thieu"]
        assert r["tieu_chi"] and r["buoc_ke"].startswith("Chuẩn bị: ")
    ids = [r["id"] for r in rs]
    assert len(ids) == len(set(ids)) == 96


def _feat(**kw):
    f = {"id": "sales-99", "phong_ban": "sales", "pham_vi": "tinh_nang_ai",
         "giai_doan": "P1", "ten": "thử", "nguon": "PL01", "dau_ra": "nháp",
         "nguoi_duyet": "Giám đốc bán hàng", "modules": ["agents/x.py"],
         "output_sources": [{"table": "approval_queue", "block": "sales",
                             "object_type": "t99"}],
         "code_status": "co_code", "acceptance_status": "chua_nghiem_thu",
         "blocker": "", "bang_chung": ["tests/test_x.py"]}
    f.update(kw)
    return f


@pytest.fixture
def data(tmp_path):
    d = tmp_path / "data"
    shutil.copytree(ROOT / "data" / "directors", d / "directors")
    c = json.loads((d / "directors" / "sales.json").read_text(
        encoding="utf-8"))
    c["approvers"] = ["Người Duyệt Giả"]
    (d / "directors" / "sales.json").write_text(
        json.dumps(c, ensure_ascii=False), encoding="utf-8")
    return d


OK_ENV = {"E1": None, "E2": None, "E3": None}
CONN = object()      # "đã đọc DB" — person_logins/ledger được thay ở fixture


@pytest.fixture
def logged(monkeypatch):
    """Người duyệt khối sales có login hợp lệ đúng khối (đã kiểm DB)."""
    monkeypatch.setattr(acc, "env_state", lambda data=None: OK_ENV)
    monkeypatch.setattr(acc, "person_logins", lambda conn: [
        {"person": "Người Duyệt Giả", "blocks": ["sales"], "valid": True,
         "last_login": "2026-10-22T09:00:00+07:00"}])
    monkeypatch.setattr(acc, "ledger", lambda conn: {})


def test_ready_only_when_every_condition_holds(data, logged):
    base = _feat()
    # vá controller 22/10: không đọc DB = CHƯA KIỂM login → không bao giờ READY
    r0 = acc.rows([base], data=data)[0]
    assert r0["status"] == acc.NOT_READY
    assert r0["thieu"] == [("CHƯA KIỂM login người duyệt (không đọc DB — chạy"
                            " `--db` trên server Bên B)")]
    rs = acc.rows([base], data=data, conn=CONN)
    assert rs[0]["status"] == acc.READY and rs[0]["thieu"] == []
    assert rs[0]["buoc_ke"].startswith("Bắt đầu chạy thử nội bộ")
    for bad, why in (
            ({"code_status": "mot_phan"}, "mã chưa đủ"),
            ({"output_sources": []}, "không có nguồn đếm"),
            ({"blocker": "chờ file thật"}, "blocker danh mục"),
            ({"phong_ban": "finance"}, "khối finance chưa có người"),
            ({"modules": ["scripts/persona_sim.py"]}, "DPIA chưa ký")):
        r = acc.rows([_feat(**bad)], data=data, conn=CONN)[0]
        assert r["status"] == acc.NOT_READY, bad
        assert any(why in m for m in r["thieu"]), (bad, r["thieu"])


def test_env_condition_missing_blocks_everything(data, logged, monkeypatch):
    monkeypatch.setattr(acc, "env_state", lambda data=None: {
        **OK_ENV, "E1": "server Bên B chưa bàn giao"})
    r = acc.rows([_feat()], data=data, conn=CONN)[0]
    assert r["status"] == acc.NOT_READY
    assert r["thieu"] == ["server Bên B chưa bàn giao"]


def test_shared_output_source_not_double_counted(data, logged):
    a = _feat(id="sales-97", output_sources=[{"report": "kd-bao-cao-"}])
    b = _feat(id="sales-98", output_sources=[{"report": "kd-bao-cao-tuan-"}])
    c = _feat(id="sales-96", output_sources=[{"report": "kd-khac-"}])
    rs = {r["id"]: r for r in acc.rows([a, b, c], data=data, conn=CONN)}
    for fid, other in (("sales-97", "sales-98"), ("sales-98", "sales-97")):
        assert rs[fid]["status"] == acc.NOT_READY
        assert any(other in m for m in rs[fid]["thieu"])
    assert rs["sales-96"]["status"] == acc.READY


def test_db_login_check_real_db(data, monkeypatch):
    """DB test thật (schema tạm, ROLLBACK): CHÍNH người duyệt đã cấu hình phải
    có ánh xạ active đúng khối tới role đăng nhập được thuộc app_human."""
    from tests.test_ceo_audit import ceo_db
    monkeypatch.setattr(acc, "env_state", lambda data=None: OK_ENV)
    gen = ceo_db()
    db = next(gen)
    try:
        tag = uuid.uuid4().hex[:8]
        ok, other, nolog = (f"t_mx_{k}_{tag}" for k in ("ok", "ot", "nl"))
        db.execute(f"create role {ok} login in role app_human")  # rollback cuối
        db.execute(f"create role {other} login in role app_human")
        db.execute(f"create role {nolog} nologin in role app_human")

        def maps(*rows):
            db.execute("delete from human_logins")
            for login, person, blocks, active in rows:
                db.execute("insert into human_logins (db_login, person, blocks,"
                           " active, granted_by) values (%s,%s,%s,%s,'t')",
                           (login, person, blocks, active))
            return acc.rows([_feat()], data=data, conn=db)[0]

        for rows in ((), ((other, "Người Khác", ["sales"], True),),
                     ((ok, "Người Duyệt Giả", ["finance"], True),),
                     ((ok, "Người Duyệt Giả", ["sales"], False),),
                     ((nolog, "Người Duyệt Giả", ["sales"], True),)):
            r = maps(*rows)
            assert r["status"] == acc.NOT_READY, rows
            assert any("chưa có login hợp lệ" in m for m in r["thieu"]), rows
        # vòng r8: cấu hình đúng nhưng CHƯA có bằng chứng đăng nhập thật
        r = maps((ok, "người  duyệt giả", ["sales"], True))   # khớp chuẩn hóa
        assert r["status"] == acc.NOT_READY
        assert any("bằng chứng đăng nhập thật" in m for m in r["thieu"]), r
        # vòng r9: login này từng ánh xạ NGƯỜI KHÁC đăng nhập; login khác của
        # chính người duyệt đăng nhập — không cái nào tính thay
        db.execute("insert into human_login_checks (db_login, person) values"
                   " (%s, 'Người Cũ Của Login'), (%s, 'Người Duyệt Giả')",
                   (ok, other))
        r = acc.rows([_feat()], data=data, conn=db)[0]
        assert r["status"] == acc.NOT_READY, r
        assert any("bằng chứng đăng nhập thật" in m and "Người Duyệt Giả" in m
                   for m in r["thieu"]), r
        db.execute("insert into human_login_checks (db_login, person) values"
                   " (%s, 'Người Duyệt Giả')", (ok,))
        r = acc.rows([_feat()], data=data, conn=db)[0]
        assert r["status"] == acc.READY and r["thieu"] == [], r
        for stmt, undo in (("valid until '2000-01-01'", "valid until 'infinity'"),
                           ("connection limit 0", "connection limit -1")):
            db.execute(f"alter role {ok} {stmt}")      # login không dùng được
            r = acc.rows([_feat()], data=data, conn=db)[0]
            assert r["status"] == acc.NOT_READY, stmt
            db.execute(f"alter role {ok} {undo}")
        db.execute("alter table human_logins rename to human_logins_x")
        r = acc.rows([_feat()], data=data, conn=db)[0]
        assert r["status"] == acc.NOT_READY
        assert any("không kiểm được" in m for m in r["thieu"])
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


def test_matrix_markdown_has_all_rows_and_criteria(tmp_path):
    out = tmp_path / "m.md"
    assert acc.main(["--matrix", "--out", str(out)]) == 0
    md = out.read_text(encoding="utf-8")
    body = [ln for ln in md.splitlines() if ln.startswith("| ") and
            not ln.startswith("| ID ")]
    assert len(body) == 96
    assert "**0/96**" in md and "Chạy thử nội bộ trên server Bên B" in md


def test_dossier_incident_log_from_db():
    from datetime import datetime, timedelta, timezone

    from pipelines import rollout as ro
    from tests.test_ceo_audit import ceo_db
    gen = ceo_db()
    db = next(gen)
    try:
        t0 = datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc)
        iid = db.execute(
            "insert into ops_incidents (title, severity, source, ben_trach_nhiem,"
            " detected_at, created_by) values ('Webhook ngừng', 'nghiem_trong',"
            " 'probe', 'ben_a', %s, 'Người Trực Giả') returning id",
            (t0,)).fetchone()[0]
        db.execute("insert into ops_incident_events (incident_id, kind, at,"
                   " by_name) values (%s, 'responded', %s, 'Người Trực Giả'),"
                   " (%s, 'fixed', %s, 'Người Trực Giả')",
                   (iid, t0 + timedelta(hours=1), iid, t0 + timedelta(days=2)))
        inc = ro.incident_rows(db)
        assert [(i["severity"], i["responded"], i["fixed"]) for i in inc] == [
            ("nghiem_trong", t0 + timedelta(hours=1), t0 + timedelta(days=2))]
        md = ro.render_dossier("P1", [], [], 0, t0, incidents=inc,
                               versions={"commit": "abc"},
                               exceptions=["E1: thiếu"])
        sec = md.split("## 3b.", 1)[1].split("## 4.", 1)[0]
        assert "Webhook ngừng" in sec and "02/11/2026 09:00" in sec
        assert "- commit: `abc`" in md and "- E1: thiếu" in md
        db.execute("alter table ops_incidents rename to ops_incidents_x")
        assert ro.incident_rows(db) is None
    finally:
        try:
            next(gen)
        except StopIteration:
            pass
